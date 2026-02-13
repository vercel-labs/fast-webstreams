/**
 * Controller adapters that bridge WHATWG controller API to Node stream internals.
 */

import { kLock } from './utils.js';

// Sentinel for wrapping falsy error values that Node.js would lose
const kWrappedError = Symbol('kWrappedError');

// Symbol for byte queue dequeue method (avoids polluting getOwnPropertyNames)
export const kDequeueBytes = Symbol('kDequeueBytes');

// Symbols for BYOB-specific methods (avoids polluting getOwnPropertyNames on prototype)
export const kAddPendingPullInto = Symbol('addPendingPullInto');
export const kHasPendingPullInto = Symbol('hasPendingPullInto');
export const kGetByobRequest = Symbol('getByobRequest');
export const kReleasePullIntoReads = Symbol('releasePullIntoReads');
export const kCancelPendingPullIntos = Symbol('cancelPendingPullIntos');
export const kWirePullIntoRead = Symbol('wirePullIntoRead');
export const kTrySyncFillPullInto = Symbol('trySyncFillPullInto');
export const kEnqueueRemainder = Symbol('enqueueRemainder');
export const kGetNodeReadable = Symbol('getNodeReadable');

// Shared unwrap helper — used by reader.js, writable.js
export function unwrapError(err) {
  if (err && typeof err === 'object' && kWrappedError in err) {
    return err[kWrappedError];
  }
  return err;
}

/**
 * Shared helper: error the readable side of a transform stream.
 * Sets stored error, marks errored, settles reader's closed and pending reads.
 */
export function _errorReadableSide(readable, error) {
  if (!readable || readable._errored) return;
  readable._storedError = error;
  readable._errored = true;
  const reader = readable[kLock];
  if (reader) {
    if (reader._settleClosedFromError) reader._settleClosedFromError(error);
    if (reader._errorReadRequests) reader._errorReadRequests(error);
  }
}

// Brand token for internal-only construction
const kControllerBrand = Symbol('kControllerBrand');

/**
 * ReadableStreamDefaultController adapter.
 *
 * For byte streams (type: 'bytes'), also manages pull-into descriptors
 * to support BYOB reads without native delegation.
 */
export class FastReadableStreamDefaultController {
  #nodeReadable;
  #closed = false;
  #errored = false;
  #originalHWM;
  #byteQueueSize = 0;
  _stream = null; // Set by the stream constructor

  // Pull-into state for BYOB reads (byte streams only, lazily allocated)
  #pendingPullIntos = null;
  #byobRequest = null;

  constructor(nodeReadable, originalHWM) {
    this.#nodeReadable = nodeReadable;
    this.#originalHWM = originalHWM !== undefined ? originalHWM : nodeReadable.readableHighWaterMark;
  }

  enqueue(chunk) {
    if (this.#errored) {
      throw new TypeError('Cannot enqueue to an errored stream');
    }
    if (this.#closed || (this._stream && this._stream._closed)) {
      throw new TypeError('Cannot enqueue to a closed stream');
    }
    // Byte streams: validate and convert per spec
    if (this._stream && this._stream._isByteStream) {
      if (ArrayBuffer.isView(chunk)) {
        // Check for detached buffer
        if (chunk.buffer.detached) {
          throw new TypeError('Cannot enqueue a chunk with a detached buffer');
        }
        // Check for SharedArrayBuffer or non-transferable buffer (e.g., WebAssembly.Memory)
        if (chunk.buffer instanceof SharedArrayBuffer) {
          throw new TypeError('Cannot enqueue a chunk backed by a SharedArrayBuffer');
        }
        // Check for zero-length chunk
        if (chunk.byteLength === 0) {
          throw new TypeError('Cannot enqueue a zero-length chunk');
        }
        // Per spec: TransferArrayBuffer — detaches caller's buffer, gives us ownership.
        // Non-transferable buffers (e.g., WebAssembly.Memory) throw TypeError.
        // Capture offset/length before transfer (transfer zeroes the original view).
        const savedOffset = chunk.byteOffset;
        const savedLength = chunk.byteLength;
        let transferred;
        try { transferred = chunk.buffer.transfer(); }
        catch { throw new TypeError('Cannot enqueue a chunk with a non-transferable buffer'); }
        chunk = new Uint8Array(transferred, savedOffset, savedLength);
      } else if (chunk instanceof ArrayBuffer) {
        if (chunk.detached) {
          throw new TypeError('Cannot enqueue a chunk with a detached buffer');
        }
        if (chunk.byteLength === 0) {
          throw new TypeError('Cannot enqueue a zero-length chunk');
        }
        try { chunk = chunk.transfer(); }
        catch { throw new TypeError('Cannot enqueue a chunk with a non-transferable buffer'); }
      }

      // BYOB fill path: if there are pending pull-into descriptors
      if (this.#pendingPullIntos && this.#pendingPullIntos.length > 0) {
        const firstD = this.#pendingPullIntos[0];
        if (firstD._resolve === null) {
          // Per spec step 7: released reader's pull-into (readerType "none").
          // Commit partially filled buffer to queue, then proceed.
          if (firstD.bytesFilled > 0) {
            // Per spec: create a new buffer with just the filled bytes
            // (not a view of the original pull-into buffer)
            const committed = new Uint8Array(firstD.bytesFilled);
            committed.set(new Uint8Array(firstD.buffer, firstD.byteOffset, firstD.bytesFilled));
            this.#byteQueueSize += committed.byteLength;
            this.#nodeReadable.push(committed);
          }
          this.#pendingPullIntos.shift();
          this.#byobRequest = null;
          // Check if there are more descriptors to fill
          if (this.#pendingPullIntos.length > 0) {
            this.#fillPendingPullIntosFromEnqueue(chunk);
            return;
          }
          // Fall through to normal enqueue below
        } else {
          // Active reader's pull-into — fill it from enqueue
          this.#fillPendingPullIntosFromEnqueue(chunk);
          return;
        }
      }
    }
    // Track byte queue size for byte stream desiredSize
    if (this._stream && this._stream._isByteStream && chunk != null) {
      this.#byteQueueSize += chunk.byteLength || 0;
    }
    this.#nodeReadable.push(chunk);
  }

  /**
   * Fill pending pull-into descriptors from an enqueued chunk.
   * Per spec: ReadableByteStreamControllerEnqueue fills pull-intos first,
   * then pushes remainder to byte queue.
   */
  #fillPendingPullIntosFromEnqueue(chunk) {
    const pullIntos = this.#pendingPullIntos;
    const d = pullIntos[0];

    // Invalidate cached byobRequest (view is changing) — transfer buffer
    if (this.#byobRequest) {
      this.#byobRequest.view = null;
      this.#byobRequest._responded = true;
    }
    // Transfer the descriptor's buffer so old views become detached
    const newBuffer = d.buffer.transfer();
    d.buffer = newBuffer;
    this.#byobRequest = null;

    // Copy bytes from chunk into the descriptor's buffer
    const src = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    const remaining = d.byteLength - d.bytesFilled;
    const toCopy = Math.min(src.byteLength, remaining);
    const dst = new Uint8Array(d.buffer, d.byteOffset + d.bytesFilled, toCopy);
    dst.set(src.subarray(0, toCopy));
    d.bytesFilled += toCopy;

    const leftover = src.byteLength - toCopy;

    // Check if the descriptor is complete (aligned and meets minimum)
    if (d.bytesFilled % d.elementSize === 0 && d.bytesFilled >= d.minimumFill) {
      // Complete — fulfill or commit
      this.#commitPullIntoDescriptor(d);
      pullIntos.shift();

      // Push leftover to byte queue (for subsequent reads)
      if (leftover > 0) {
        const rest = new Uint8Array(src.buffer, src.byteOffset + toCopy, leftover);
        this.#byteQueueSize += rest.byteLength;
        this.#nodeReadable.push(rest);
      }

      // After committing, try to fill remaining descriptors from queue
      this.#processRemainingPullIntos();
    } else {
      // Not complete — chunk fully consumed but descriptor not filled
      if (leftover > 0) {
        const rest = new Uint8Array(src.buffer, src.byteOffset + toCopy, leftover);
        this.#byteQueueSize += rest.byteLength;
        this.#nodeReadable.push(rest);
      }
      // Schedule re-pull for partial fill (double-deferred: first microtask waits
      // for pullLock to clear, second microtask triggers the actual re-pull)
      if (d._resolve) {
        const controller = this;
        queueMicrotask(() => {
          queueMicrotask(() => {
            if (d._resolve === null) return;
            if (controller.#closed || controller.#errored) return;
            const stream = controller._stream;
            if (!stream || !stream._pullFn) return;
            const nr = controller.#nodeReadable;
            if (nr && !nr.destroyed && nr._onRead && !nr._readableState.ended) {
              if (stream._pullLock) return;
              nr._readableState.reading = false;
              nr.read(0);
            }
          });
        });
      }
    }
  }

  /**
   * Commit a completed pull-into descriptor — fulfill its read promise
   * or push to byte queue if no active reader.
   */
  #commitPullIntoDescriptor(d) {
    if (d._resolve) {
      const filledView = new d.viewConstructor(d.buffer, d.byteOffset,
        d.bytesFilled / d.elementSize);
      d._resolve({ value: filledView, done: false });
      d._resolve = null;
      d._reject = null;
    } else {
      // No active reader (released) — push committed data to byte queue
      // Per spec: committed for readerType "none" creates Uint8Array and enqueues
      const committedChunk = new Uint8Array(d.buffer, d.byteOffset, d.bytesFilled);
      this.#byteQueueSize += committedChunk.byteLength;
      this.#nodeReadable.push(committedChunk);
    }
  }

  /**
   * After committing/shifting the first descriptor, try to fill remaining
   * descriptors from the byte queue (LiteReadable buffer).
   * Per spec: ReadableByteStreamControllerProcessPullIntoDescriptorsUsingQueue
   */
  #processRemainingPullIntos() {
    while (this.#pendingPullIntos && this.#pendingPullIntos.length > 0) {
      const d = this.#pendingPullIntos[0];
      if (this[kTrySyncFillPullInto](d)) {
        this.#commitPullIntoDescriptor(d);
        this.#pendingPullIntos.shift();
        this.#byobRequest = null;
      } else {
        break;
      }
    }
  }

  /**
   * Commit a pull-into descriptor with done:true (closed stream).
   * Per spec: ReadableByteStreamControllerCommitPullIntoDescriptor with done=true
   */
  #commitPullIntoDescriptorDone(d) {
    if (d._resolve) {
      // Create a zero-length (or filled-length) view for the done result
      const filledView = new d.viewConstructor(d.buffer, d.byteOffset,
        d.bytesFilled / d.elementSize);
      d._resolve({ value: filledView, done: true });
      d._resolve = null;
      d._reject = null;
    }
    // If no resolve (released reader), just discard
  }

  /**
   * Process remaining pull-intos after close+respond — fulfill all with done:true.
   */
  #processRemainingPullIntosClosed() {
    while (this.#pendingPullIntos && this.#pendingPullIntos.length > 0) {
      const d = this.#pendingPullIntos[0];
      this.#commitPullIntoDescriptorDone(d);
      this.#pendingPullIntos.shift();
      this.#byobRequest = null;
    }
  }

  // Called by reader when consuming a chunk (decrements byte queue tracking)
  // Keyed by Symbol to avoid appearing in getOwnPropertyNames (WPT checks prototype shape)
  [kDequeueBytes](chunk) {
    if (chunk != null) {
      this.#byteQueueSize -= chunk.byteLength || 0;
      if (this.#byteQueueSize < 0) this.#byteQueueSize = 0;
    }
  }

  close() {
    if (this.#errored) {
      throw new TypeError('Cannot close an errored stream');
    }
    if (this.#closed || (this._stream && this._stream._closed)) {
      throw new TypeError('Cannot close an already closed stream');
    }

    // Byte stream BYOB: alignment check on close
    if (this.#pendingPullIntos && this.#pendingPullIntos.length > 0) {
      const d = this.#pendingPullIntos[0];
      if (d.bytesFilled > 0 && d.bytesFilled % d.elementSize !== 0) {
        const e = new TypeError('Insufficient bytes to fill elements in the given buffer');
        this.error(e);
        throw e;
      }
      // Per spec: don't immediately fulfill pending pull-intos on close.
      // They are fulfilled when respond(0) is called on the closed stream.
      // But if there's no pull and no pending byobRequest (just queued data
      // with a waiting read), we should resolve pending descriptors with done:true.
    }

    this.#closed = true;
    const r = this.#nodeReadable;
    r.push(null);
    if (r.readableLength === 0) {
      r.resume();
    }
    // Track close state on the stream. Only set _closed if no buffered data
    // (per spec: state transitions to "closed" only when queue is empty).
    // When data is buffered, _closed is set later when 'end' fires.
    if (this._stream) {
      if (r.readableLength === 0) {
        this._stream._closed = true;
        // Synchronously resolve reader.closed (don't wait for Node 'end' event)
        const reader = this._stream[kLock];
        if (reader && reader._resolveClosedFromCancel) {
          reader._resolveClosedFromCancel();
        }
      }
    }
  }

  error(e) {
    if (this.#errored) return;
    // Per spec: error is no-op if stream is already closed
    if (this.#closed || (this._stream && this._stream._closed)) return;
    this.#errored = true;
    if (e == null || e === false || e === 0 || e === '') {
      const wrapped = new Error('wrapped');
      wrapped[kWrappedError] = e;
      this.#nodeReadable.destroy(wrapped);
    } else {
      this.#nodeReadable.destroy(e);
    }
    // Reject pending BYOB reads
    if (this.#pendingPullIntos) {
      for (const d of this.#pendingPullIntos) {
        if (d._reject) {
          d._reject(e);
          d._resolve = null;
          d._reject = null;
        }
      }
      this.#pendingPullIntos = null;
      this.#byobRequest = null;
    }
    // Track error state on the stream for releaseLock to use
    if (this._stream) {
      this._stream._storedError = e;
      this._stream._errored = true;
      // Per spec: synchronously settle closed FIRST, then reject pending reads
      const reader = this._stream[kLock];
      if (reader) {
        if (reader._settleClosedFromError) reader._settleClosedFromError(e);
        if (reader._errorReadRequests) reader._errorReadRequests(e);
      }
    }
  }

  get desiredSize() {
    if (this.#errored) return null;
    if (this.#closed) return 0;
    const r = this.#nodeReadable;
    if (this.#originalHWM === Infinity) {
      return Infinity;
    }
    // Byte streams: use byte queue size instead of item count
    if (this._stream && this._stream._isByteStream) {
      return this.#originalHWM - this.#byteQueueSize;
    }
    // Account for pending reads: in WHATWG spec, pending reads consume enqueued
    // chunks directly (no queuing). Our Node readable buffers chunks first,
    // so subtract pending reads from queue length for accurate desiredSize.
    const queueSize = r.readableLength;
    const reader = this._stream?.[kLock];
    const pendingReads = reader?._pendingReadCount?.() ?? 0;
    return this.#originalHWM - Math.max(0, queueSize - pendingReads);
  }

  // --- BYOB pull-into management (byte streams only) ---

  /**
   * Add a pull-into descriptor (called by BYOB reader's read(view)).
   */
  [kAddPendingPullInto](descriptor) {
    if (!this.#pendingPullIntos) this.#pendingPullIntos = [];
    // Only invalidate byobRequest if this is the first descriptor.
    // Per spec: subsequent descriptors go to end of queue and don't
    // affect the first byobRequest (which survives releaseLock).
    if (this.#pendingPullIntos.length === 0) {
      this.#byobRequest = null;
    }
    this.#pendingPullIntos.push(descriptor);
  }

  /**
   * Check if there are pending pull-into descriptors with active resolve callbacks.
   */
  [kHasPendingPullInto]() {
    if (!this.#pendingPullIntos || this.#pendingPullIntos.length === 0) return false;
    // Only return true if at least one descriptor has an active resolve
    return this.#pendingPullIntos.some(d => d._resolve !== null);
  }

  /**
   * Get the byobRequest for the first pending pull-into.
   * Returns the same object on repeated calls until invalidated.
   */
  [kGetByobRequest]() {
    if (!this.#pendingPullIntos || this.#pendingPullIntos.length === 0) return null;
    if (this.#byobRequest) return this.#byobRequest;

    const d = this.#pendingPullIntos[0];
    const view = new Uint8Array(d.buffer, d.byteOffset + d.bytesFilled,
      d.byteLength - d.bytesFilled);

    const controller = this;
    const req = Object.create(null);

    // view as data property
    req.view = view;

    req.respond = function respond(bytesWritten) {
      // Double-respond prevention
      if (req._responded) throw new TypeError('byobRequest already responded');
      // Respond after cancel/error check
      if (controller._stream && controller._stream._errored) {
        throw new TypeError('Cannot respond on an errored stream');
      }
      if (controller._stream && controller._stream._closed && !controller.#closed) {
        throw new TypeError('Cannot respond on a canceled stream');
      }

      bytesWritten = Number(bytesWritten);
      if (Number.isNaN(bytesWritten) || bytesWritten < 0) {
        throw new TypeError('bytesWritten must be non-negative');
      }
      // Per spec: respond(0) on non-closed stream should throw
      if (bytesWritten === 0 && !controller.#closed) {
        throw new TypeError('bytesWritten must be positive when stream is readable');
      }
      if (d.bytesFilled + bytesWritten > d.byteLength) {
        throw new RangeError('bytesWritten out of range');
      }
      d.bytesFilled += bytesWritten;

      // Transfer buffer per spec: old view's buffer becomes detached
      const newBuffer = d.buffer.transfer();
      d.buffer = newBuffer;

      // Invalidate old request
      req._responded = true;
      req.view = null;
      controller.#byobRequest = null;

      if (controller.#closed) {
        controller.#commitPullIntoDescriptorDone(d);
        controller.#pendingPullIntos.shift();
        controller.#processRemainingPullIntosClosed();
      } else {
        // Handle element-size remainder per spec
        const remainderSize = d.bytesFilled % d.elementSize;
        if (remainderSize > 0 && d.bytesFilled >= d.elementSize) {
          // Enqueue remainder to byte queue, then commit aligned portion
          const remainder = new Uint8Array(d.buffer.slice(
            d.byteOffset + d.bytesFilled - remainderSize, d.byteOffset + d.bytesFilled));
          controller.#byteQueueSize += remainder.byteLength;
          controller.#nodeReadable.push(remainder);
          d.bytesFilled -= remainderSize;
        }
        if (d.bytesFilled >= d.minimumFill && d.bytesFilled % d.elementSize === 0) {
          controller.#commitPullIntoDescriptor(d);
          controller.#pendingPullIntos.shift();
          controller.#processRemainingPullIntos();
          // After commit, trigger pull for remaining pending descriptors
          if (controller.#pendingPullIntos && controller.#pendingPullIntos.length > 0 &&
              controller.#pendingPullIntos[0]._resolve) {
            queueMicrotask(() => {
              queueMicrotask(() => {
                const next = controller.#pendingPullIntos?.[0];
                if (!next || next._resolve === null) return;
                if (controller.#closed || controller.#errored) return;
                const stream = controller._stream;
                if (!stream || !stream._pullFn) return;
                const nr = controller.#nodeReadable;
                if (nr && !nr.destroyed && nr._onRead && !nr._readableState.ended) {
                  if (stream._pullLock) return;
                  nr._readableState.reading = false;
                  nr.read(0);
                }
              });
            });
          }
        } else if (d._resolve) {
          // Partial respond with pending descriptor: double-deferred re-pull
          // (first microtask waits for sync pullLock to clear, second triggers pull)
          queueMicrotask(() => {
            queueMicrotask(() => {
              if (d._resolve === null) return;
              if (controller.#closed || controller.#errored) return;
              const stream = controller._stream;
              if (!stream || !stream._pullFn) return;
              const nr = controller.#nodeReadable;
              if (nr && !nr.destroyed && nr._onRead && !nr._readableState.ended) {
                if (stream._pullLock) return;
                nr._readableState.reading = false;
                nr.read(0);
              }
            });
          });
        }
      }
    };

    req.respondWithNewView = function respondWithNewView(newView) {
      // Double-respond prevention
      if (req._responded) throw new TypeError('byobRequest already responded');
      // Respond after cancel/error check
      if (controller._stream && controller._stream._errored) {
        throw new TypeError('Cannot respond on an errored stream');
      }
      if (controller._stream && controller._stream._closed && !controller.#closed) {
        throw new TypeError('Cannot respond on a canceled stream');
      }

      if (!ArrayBuffer.isView(newView)) {
        throw new TypeError('view must be a TypedArray or DataView');
      }
      if (newView.buffer instanceof SharedArrayBuffer) {
        throw new TypeError('view must not reference a SharedArrayBuffer');
      }
      // Save dimensions before potential transfer
      const newViewByteOffset = newView.byteOffset;
      const bytesWritten = newView.byteLength;
      // Per spec: respondWithNewView(zero-length) on non-closed stream should throw
      if (bytesWritten === 0 && !controller.#closed) {
        throw new TypeError('bytesWritten must be positive when stream is readable');
      }

      // Per spec: transfer the buffer (non-transferable throws)
      let newBuffer;
      try { newBuffer = newView.buffer.transfer(); } catch {
        throw new TypeError('Cannot respondWithNewView with a non-transferable buffer');
      }
      d.buffer = newBuffer;
      d.byteOffset = newViewByteOffset;
      d.bytesFilled = bytesWritten;

      // Invalidate old request
      req._responded = true;
      req.view = null;
      controller.#byobRequest = null;

      if (controller.#closed) {
        controller.#commitPullIntoDescriptorDone(d);
        controller.#pendingPullIntos.shift();
        controller.#processRemainingPullIntosClosed();
      } else if (d.bytesFilled % d.elementSize === 0 && d.bytesFilled >= d.minimumFill) {
        controller.#commitPullIntoDescriptor(d);
        controller.#pendingPullIntos.shift();
        controller.#processRemainingPullIntos();
      }
    };

    this.#byobRequest = req;
    return req;
  }

  /**
   * Invalidate pending pull-into read promises (called by BYOB reader releaseLock).
   * The descriptors STAY on the controller (per spec: pull-into survives releaseLock).
   * Only the resolve/reject callbacks are cleared.
   */
  [kReleasePullIntoReads]() {
    if (!this.#pendingPullIntos) return;
    for (const d of this.#pendingPullIntos) {
      d._resolve = null;
      d._reject = null;
    }
    // Don't clear byobRequest — it survives releaseLock per spec
  }

  /**
   * Fulfill all pending BYOB reads with {done: true, value: undefined}.
   * Called when the stream is canceled with pending BYOB reads.
   */
  [kCancelPendingPullIntos]() {
    if (!this.#pendingPullIntos) return;
    for (const d of this.#pendingPullIntos) {
      if (d._resolve) {
        d._resolve({ value: undefined, done: true });
        d._resolve = null;
        d._reject = null;
      }
    }
    this.#pendingPullIntos = null;
    this.#byobRequest = null;
  }

  /**
   * Wire a new read promise to the first pending pull-into descriptor
   * (called by a second reader after first was released).
   * For BYOB readers: wires with the original viewConstructor.
   * For default readers: just return false (default reader reads from queue).
   */
  [kWirePullIntoRead](resolve, reject) {
    if (!this.#pendingPullIntos || this.#pendingPullIntos.length === 0) return false;
    const d = this.#pendingPullIntos[0];
    if (d._resolve) return false; // Already wired
    d._resolve = resolve;
    d._reject = reject;
    return true;
  }

  /**
   * Try to fill a pull-into descriptor synchronously from LiteReadable buffer.
   * Returns true if the descriptor was filled enough (meets minimum + alignment).
   */
  [kTrySyncFillPullInto](d) {
    const nr = this.#nodeReadable;
    const buf = nr._buffer;
    let head = nr._bufferHead;
    if (!buf || buf.length === head) return false;

    // Fill as much as possible from the buffer (up to byteLength, not just minimumFill)
    while (buf.length > head && d.bytesFilled < d.byteLength) {
      const chunk = buf[head];
      const chunkBytes = chunk.byteLength;
      const need = d.byteLength - d.bytesFilled;
      const toCopy = Math.min(chunkBytes, need);

      const src = new Uint8Array(chunk.buffer, chunk.byteOffset, toCopy);
      const dst = new Uint8Array(d.buffer, d.byteOffset + d.bytesFilled, toCopy);
      dst.set(src);
      d.bytesFilled += toCopy;

      // Dequeue bytes
      this.#byteQueueSize -= toCopy;
      if (this.#byteQueueSize < 0) this.#byteQueueSize = 0;

      if (toCopy === chunkBytes) {
        buf[head] = undefined; // GC
        head++;
      } else {
        // Partial consumption — replace with remainder
        buf[head] = new Uint8Array(chunk.buffer, chunk.byteOffset + toCopy, chunkBytes - toCopy);
      }
    }

    // Update head on LiteReadable
    nr._bufferHead = head;

    // Update LiteReadable ended state
    if (buf.length === head && nr._readableState && nr._readableState.ended) {
      nr._ended = true;
    }

    return d.bytesFilled % d.elementSize === 0 && d.bytesFilled >= d.minimumFill;
  }

  /**
   * Enqueue remainder bytes back into the byte queue (after element alignment).
   */
  [kEnqueueRemainder](chunk) {
    this.#byteQueueSize += chunk.byteLength;
    this.#nodeReadable.push(chunk);
  }

  /**
   * Get the node readable (for BYOB reader to check state).
   */
  [kGetNodeReadable]() {
    return this.#nodeReadable;
  }
}

export { kWrappedError, kControllerBrand };

/**
 * TransformStreamDefaultController adapter.
 */
export class FastTransformStreamDefaultController {
  #nodeTransform;
  #terminated = false;
  #errored = false;
  #enqueueBlocked = false;
  #transformStream = null;

  constructor(nodeTransform) {
    this.#nodeTransform = nodeTransform;
  }

  // Called by FastTransformStream to wire up the reference
  _setTransformStream(ts) {
    this.#transformStream = ts;
  }

  enqueue(chunk) {
    if (this.#terminated || this.#errored || this.#enqueueBlocked) {
      throw new TypeError('Cannot enqueue to an errored stream');
    }
    this.#nodeTransform.push(chunk);
    // Update transform backpressure after enqueue
    this._updateBackpressure();
  }

  /**
   * Update backpressure flag on the writable shell based on readable desiredSize.
   * Per spec: TransformStreamSetBackpressure
   */
  _updateBackpressure() {
    if (!this.#transformStream) return;
    const writable = this.#transformStream.writable;
    if (!writable || !writable._isTransformShell) return;
    const t = this.#nodeTransform;
    const desiredSize = t.readableHighWaterMark - t.readableLength;

    // Fast path: if desiredSize > 0, backpressure is definitely false
    // (pending reads can only increase effective size). Skip optional chaining.
    if (desiredSize > 0) {
      if (writable._transformBackpressure) {
        writable._transformBackpressure = false;
        if (writable._transformBackpressureResolve) {
          writable._transformBackpressureResolve();
        }
      }
      return;
    }

    // Only compute pendingReads when desiredSize <= 0
    const reader = this.#transformStream.readable?.[kLock];
    const pendingReads = reader?._pendingReadCount?.() ?? 0;
    const effectiveDesiredSize = desiredSize + pendingReads;
    const backpressure = effectiveDesiredSize <= 0;
    if (writable._transformBackpressure !== backpressure) {
      writable._transformBackpressure = backpressure;
      if (!backpressure && writable._transformBackpressureResolve) {
        writable._transformBackpressureResolve();
      }
    }
  }

  error(e) {
    if (this.#errored) return;
    // Per spec: error is no-op if readable is "closed" (fully closed, no queued data).
    // But if terminated with queued data (closeRequested but state="readable"), error should work.
    if (this.#terminated && this.#nodeTransform.readableLength === 0) return;
    this.#terminated = true;
    this.#errored = true;
    // Error the readable side directly (set stored error + reject reader)
    if (this.#transformStream) {
      _errorReadableSide(this.#transformStream.readable, e);
    }
    if (!this.#nodeTransform.destroyed) {
      this.#nodeTransform.destroy(e);
    }
    // Also error the writable side
    if (this.#transformStream && this.#transformStream._errorWritable) {
      this.#transformStream._errorWritable(e);
    }
  }

  terminate() {
    if (this.#terminated) return;
    this.#terminated = true;
    this.#nodeTransform.push(null);
    // Per spec: terminate also errors the writable side,
    // UNLESS we're inside flush (writable is already closing)
    if (this.#transformStream && this.#transformStream._flushStarted) {
      return; // During flush, terminate only closes readable (writable close proceeds)
    }
    const terminateError = new TypeError('TransformStream terminated');
    if (this.#transformStream && this.#transformStream._errorWritable) {
      this.#transformStream._errorWritable(terminateError);
    }
  }

  // Mark as enqueue-blocked (called by readable cancel to prevent subsequent enqueue)
  // Does NOT set #errored — error() should still work after cancel
  _markErrored() {
    this.#enqueueBlocked = true;
  }

  get desiredSize() {
    const t = this.#nodeTransform;
    if (this.#terminated) return 0;
    const queueSize = t.readableLength;
    // Fast path: empty queue means effectiveQueueSize = 0 (max(0, 0-N) = 0)
    if (queueSize === 0) return t.readableHighWaterMark;
    // Only compute pendingReads when queue has items
    const reader = this.#transformStream?.readable?.[kLock];
    const pendingReads = reader?._pendingReadCount?.() ?? 0;
    return t.readableHighWaterMark - Math.max(0, queueSize - pendingReads);
  }
}

/**
 * WritableStreamDefaultController adapter.
 * Receives a controllerError callback at construction to avoid circular imports.
 */
export class FastWritableStreamDefaultController {
  #abortController;
  #controllerErrorFn;
  #stream;

  constructor(nodeWritable, stream, controllerErrorFn, brand) {
    if (brand !== kControllerBrand) {
      throw new TypeError('Illegal constructor');
    }
    this.#stream = stream;
    this.#controllerErrorFn = controllerErrorFn;
    this.#abortController = null; // Lazy — most streams are never aborted
  }

  error(e) {
    if (this.#controllerErrorFn) {
      this.#controllerErrorFn(this.#stream, e);
    }
  }

  _abortSignal(reason) {
    if (!this.#abortController) this.#abortController = new AbortController();
    if (!this.#abortController.signal.aborted) {
      this.#abortController.abort(reason);
    }
  }

  get signal() {
    if (!this.#abortController) this.#abortController = new AbortController();
    return this.#abortController.signal;
  }
}
