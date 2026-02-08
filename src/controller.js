/**
 * Controller adapters that bridge WHATWG controller API to Node stream internals.
 */

import { kLock } from './utils.js';

// Sentinel for wrapping falsy error values that Node.js would lose
const kWrappedError = Symbol('kWrappedError');

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
 */
export class FastReadableStreamDefaultController {
  #nodeReadable;
  #closed = false;
  #errored = false;
  #originalHWM;
  _stream = null; // Set by the stream constructor

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
    this.#nodeReadable.push(chunk);
  }

  close() {
    if (this.#errored) {
      throw new TypeError('Cannot close an errored stream');
    }
    if (this.#closed || (this._stream && this._stream._closed)) {
      throw new TypeError('Cannot close an already closed stream');
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
    return this.#originalHWM - r.readableLength;
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
  #nodeWritable;
  #abortController;
  #controllerErrorFn;
  #stream;

  constructor(nodeWritable, stream, controllerErrorFn, brand) {
    if (brand !== kControllerBrand) {
      throw new TypeError('Illegal constructor');
    }
    this.#nodeWritable = nodeWritable;
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
