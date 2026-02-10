/**
 * FastReadableStreamBYOBReader — wraps native ReadableStreamBYOBReader
 * to accept FastReadableStream instances (materializes to native first).
 *
 * For fast byte streams: uses a standalone BYOB reader with pull-into
 * descriptors when there's NO pull callback (React Flight pattern).
 * For byte streams WITH pull: delegates to native via materializeReadableAsBytes.
 */

import { unwrapError, kTrySyncFillPullInto, kEnqueueRemainder, kAddPendingPullInto, kReleasePullIntoReads } from './controller.js';
import { materializeReadable, materializeReadableAsBytes } from './materialize.js';
import { NativeReadableStream } from './natives.js';
import { isFastReadable, kLock, kNativeOnly, kNodeReadable, noop } from './utils.js';

// Get the native BYOB reader constructor
const NativeBYOBReader = new NativeReadableStream({ type: 'bytes' }).getReader({ mode: 'byob' }).constructor;

/**
 * BYOB reader that accepts both native ReadableStream and FastReadableStream.
 * For FastReadableStream byte streams without pull: standalone implementation.
 * For FastReadableStream byte streams with pull: materializes to native.
 * For other streams: delegates to native.
 */
export class FastReadableStreamBYOBReader {
  // Standalone BYOB reader state
  #stream = null;
  #closedPromise = null;
  #closedResolve = null;
  #closedReject = null;
  #closedSettled = false;
  #released = false;
  #pendingReads = [];
  #isStandalone = false;

  // Native delegate
  #nativeReader = null;

  constructor(stream) {
    if (isFastReadable(stream) && stream._isByteStream && !stream[kNativeOnly]) {
      // Fast byte stream (with or without pull): use standalone BYOB reader
      // This avoids native delegation issues (timing, data ownership, error swallowing)
      this.#isStandalone = true;
      if (stream[kLock]) {
        throw new TypeError('Cannot construct a ReadableStreamBYOBReader for a locked ReadableStream');
      }
      this.#stream = stream;
      stream[kLock] = this;

      this.#closedPromise = new Promise((resolve, reject) => {
        this.#closedResolve = resolve;
        this.#closedReject = reject;
      });

      if (stream._errored) {
        this.#settleClose(false, stream._storedError);
      } else if (stream._closed) {
        this.#settleClose(true);
      } else {
        const nodeReadable = stream[kNodeReadable];
        if (nodeReadable.destroyed) {
          if (nodeReadable.errored) {
            this.#settleClose(false, unwrapError(nodeReadable.errored));
          } else {
            this.#settleClose(true);
          }
        } else if (nodeReadable.readableEnded) {
          this.#settleClose(true);
        } else {
          const onEnd = () => { cleanup(); stream._closed = true; this.#settleClose(true); };
          const onError = (err) => {
            cleanup();
            if (stream._errored) this.#settleClose(false, stream._storedError);
            else this.#settleClose(false, unwrapError(err));
          };
          const onClose = () => {
            cleanup();
            if (stream._errored) this.#settleClose(false, stream._storedError);
            else if (nodeReadable.errored) this.#settleClose(false, unwrapError(nodeReadable.errored));
            else { stream._closed = true; this.#settleClose(true); }
          };
          const cleanup = () => {
            nodeReadable.removeListener('end', onEnd);
            nodeReadable.removeListener('error', onError);
            nodeReadable.removeListener('close', onClose);
          };
          nodeReadable.on('end', onEnd);
          nodeReadable.on('error', onError);
          nodeReadable.on('close', onClose);
        }
      }
    } else if (isFastReadable(stream)) {
      this.#nativeReader = new NativeBYOBReader(materializeReadable(stream));
      this.#stream = stream;
    } else {
      this.#nativeReader = new NativeBYOBReader(stream);
      this.#stream = stream;
    }
  }

  #settleClose(success, err) {
    if (this.#closedSettled || this.#released) return;
    this.#closedSettled = true;
    if (success) this.#closedResolve(undefined);
    else { this.#closedReject(err); this.#closedPromise.catch(noop); }
  }

  read(view, options) {
    if (this.#nativeReader) return this.#nativeReader.read(view, options);
    if (this.#released) return Promise.reject(new TypeError('Reader has been released'));

    const stream = this.#stream;

    // Validate view
    if (!ArrayBuffer.isView(view)) {
      return Promise.reject(new TypeError('view must be a TypedArray or DataView'));
    }
    if (view.byteLength === 0) {
      return Promise.reject(new TypeError('view must have non-zero byteLength'));
    }
    if (view.buffer.byteLength === 0) {
      return Promise.reject(new TypeError('view must reference a non-zero-length buffer'));
    }
    if (view.buffer.detached) {
      return Promise.reject(new TypeError('view references a detached ArrayBuffer'));
    }
    const elementSize = view.BYTES_PER_ELEMENT || 1;
    const isDataView = view.constructor === DataView;
    const viewConstructor = isDataView ? DataView : view.constructor;

    // Parse min option
    let minimumFill = elementSize;
    if (options && options.min !== undefined) {
      const min = Number(options.min);
      if (min <= 0 || !Number.isInteger(min)) {
        return Promise.reject(new TypeError('min must be a positive integer'));
      }
      if (min > view.byteLength / elementSize) {
        return Promise.reject(new RangeError('min must not exceed view length'));
      }
      minimumFill = min * elementSize;
    }

    if (stream._errored) return Promise.reject(stream._storedError);

    // Save view dimensions BEFORE transfer (transfer detaches original, zeroing these)
    const viewByteOffset = view.byteOffset;
    const viewByteLength = view.byteLength;

    // Transfer buffer per spec (detaches caller's view)
    // Non-transferable buffers (e.g., WebAssembly.Memory) throw TypeError
    let bufferCopy;
    try {
      bufferCopy = view.buffer.transfer();
    } catch {
      return Promise.reject(new TypeError('Cannot read into a non-transferable buffer'));
    }

    const descriptor = {
      buffer: bufferCopy,
      byteOffset: viewByteOffset,
      byteLength: viewByteLength,
      bytesFilled: 0,
      minimumFill,
      elementSize,
      viewConstructor,
      _resolve: null,
      _reject: null,
    };

    const controller = stream._controller;

    // Try sync fill from LiteReadable buffer
    if (controller[kTrySyncFillPullInto](descriptor)) {
      const filledView = new viewConstructor(descriptor.buffer, descriptor.byteOffset,
        descriptor.bytesFilled / elementSize);
      return Promise.resolve({ value: filledView, done: false });
    }

    // Check if stream closed/ended after sync fill attempt
    const nodeReadable = stream[kNodeReadable];
    const isEnded = stream._closed || nodeReadable.readableEnded ||
      (nodeReadable._ended && nodeReadable._buffer && nodeReadable._buffer.length === 0);

    // Handle partial fill with element-size remainder:
    // If we have enough bytes for at least one element but have a non-aligned remainder,
    // commit the aligned portion and re-enqueue the remainder
    if (descriptor.bytesFilled >= elementSize && descriptor.bytesFilled % elementSize !== 0) {
      const remainderSize = descriptor.bytesFilled % elementSize;
      const alignedFill = descriptor.bytesFilled - remainderSize;

      // On ended streams: if aligned portion doesn't meet minimumFill, error
      if (isEnded && alignedFill < minimumFill) {
        const e = new TypeError('Insufficient bytes to fill elements in the given buffer');
        if (!stream._errored) {
          stream._storedError = e;
          stream._errored = true;
          this.#settleClose(false, e);
          if (nodeReadable && !nodeReadable.destroyed) nodeReadable.destroy(e);
        }
        return Promise.reject(e);
      }

      // Re-enqueue the remainder bytes
      const remainder = new Uint8Array(descriptor.buffer.slice(
        descriptor.byteOffset + descriptor.bytesFilled - remainderSize,
        descriptor.byteOffset + descriptor.bytesFilled));
      controller[kEnqueueRemainder](remainder);
      // Align bytesFilled
      descriptor.bytesFilled = alignedFill;
      const filledView = new viewConstructor(descriptor.buffer, descriptor.byteOffset,
        descriptor.bytesFilled / elementSize);
      return Promise.resolve({ value: filledView, done: false });
    }

    if (isEnded) {
      if (descriptor.bytesFilled === 0) {
        // Per spec: return empty view of the requested type (not undefined)
        const emptyView = new viewConstructor(descriptor.buffer, descriptor.byteOffset, 0);
        return Promise.resolve({ value: emptyView, done: true });
      }
      if (descriptor.bytesFilled % elementSize !== 0) {
        const e = new TypeError('Insufficient bytes to fill elements in the given buffer');
        // Error the stream directly (controller.error may be no-op if controller already closed)
        if (!stream._errored) {
          stream._storedError = e;
          stream._errored = true;
          // Settle reader's closed promise with error
          this.#settleClose(false, e);
          // Destroy the node readable
          const nr = stream[kNodeReadable];
          if (nr && !nr.destroyed) nr.destroy(e);
        }
        return Promise.reject(e);
      }
      const filledView = new viewConstructor(descriptor.buffer, descriptor.byteOffset,
        descriptor.bytesFilled / elementSize);
      return Promise.resolve({ value: filledView, done: true });
    }

    // Not enough data — add descriptor to controller and wait for pull/enqueue
    return new Promise((resolve, reject) => {
      descriptor._resolve = resolve;
      descriptor._reject = reject;
      this.#pendingReads.push(descriptor);
      controller[kAddPendingPullInto](descriptor);

      // Trigger pull synchronously — spec requires pull to fire immediately
      // when a BYOB read is added with empty buffer. The respond() method's
      // re-pull is deferred (queueMicrotask) to prevent recursion.
      if (stream._pullFn && !stream._pullLock) {
        const nr = stream[kNodeReadable];
        if (nr && !nr.destroyed && nr._onRead && !nr._readableState.ended) {
          nr._readableState.reading = false;
          nr.read(0);
        }
      }
    });
  }

  cancel(reason) {
    if (this.#nativeReader) return this.#nativeReader.cancel(reason);
    if (this.#released) return Promise.reject(new TypeError('Reader has been released'));
    return this.#stream._cancelInternal(reason);
  }

  releaseLock() {
    if (this.#nativeReader) {
      this.#nativeReader.releaseLock();
      return;
    }
    if (!this.#stream || this.#released) return;
    this.#released = true;
    const stream = this.#stream;

    // Reject all pending BYOB reads but keep descriptors on controller
    if (this.#pendingReads.length > 0) {
      const releasedError = new TypeError('Reader was released');
      for (const d of this.#pendingReads) {
        if (d._reject) d._reject(releasedError);
      }
      stream._controller[kReleasePullIntoReads]();
      this.#pendingReads = [];
    }

    // Settle closed promise
    if (!this.#closedSettled) {
      const releasedError = new TypeError('Reader was released');
      if (stream._closed) {
        this.#closedResolve(undefined);
        this.#closedSettled = true;
        this.#closedPromise = Promise.reject(releasedError);
        this.#closedPromise.catch(noop);
      } else if (stream._errored) {
        this.#closedReject(stream._storedError);
        this.#closedPromise.catch(noop);
        this.#closedSettled = true;
        this.#closedPromise = Promise.reject(releasedError);
        this.#closedPromise.catch(noop);
      } else {
        this.#closedReject(releasedError);
        this.#closedPromise.catch(noop);
        this.#closedSettled = true;
      }
    } else {
      const releasedError = new TypeError('Reader was released');
      this.#closedPromise = Promise.reject(releasedError);
      this.#closedPromise.catch(noop);
    }

    stream[kLock] = null;
  }

  _settleClosedFromError(error) {
    if (this.#nativeReader) return;
    if (!this.#closedSettled && !this.#released) {
      this.#closedSettled = true;
      this.#closedReject(error);
      this.#closedPromise.catch(noop);
    }
  }

  _errorReadRequests(error) {
    if (this.#nativeReader) return;
    this.#pendingReads = [];
  }

  _pendingReadCount() {
    return this.#pendingReads.length;
  }

  _resolveClosedFromCancel() {
    if (this.#nativeReader) return;
    if (!this.#closedSettled && !this.#released) {
      this.#closedResolve(undefined);
      this.#closedSettled = true;
    }
  }

  get closed() {
    if (this.#nativeReader) return this.#nativeReader.closed;
    return this.#closedPromise;
  }
}
