/**
 * Controller adapters that bridge WHATWG controller API to Node stream internals.
 */

import { kLock } from './utils.js';

// Sentinel for wrapping falsy error values that Node.js would lose
const kWrappedError = Symbol('kWrappedError');

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
    if (this.#closed) {
      throw new TypeError('Cannot enqueue to a closed stream');
    }
    this.#nodeReadable.push(chunk);
  }

  close() {
    if (this.#errored) {
      throw new TypeError('Cannot close an errored stream');
    }
    if (this.#closed) {
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
      }
    }
  }

  error(e) {
    if (this.#errored) return;
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
  #transformStream = null;

  constructor(nodeTransform) {
    this.#nodeTransform = nodeTransform;
  }

  // Called by FastTransformStream to wire up the reference
  _setTransformStream(ts) {
    this.#transformStream = ts;
  }

  enqueue(chunk) {
    if (this.#terminated || this.#errored) {
      throw new TypeError('Cannot enqueue to an errored stream');
    }
    this.#nodeTransform.push(chunk);
  }

  error(e) {
    if (this.#terminated) return;
    this.#terminated = true;
    this.#errored = true;
    this.#nodeTransform.destroy(e);
    // Also error the writable side
    if (this.#transformStream && this.#transformStream._errorWritable) {
      this.#transformStream._errorWritable(e);
    }
  }

  terminate() {
    if (this.#terminated) return;
    this.#terminated = true;
    this.#nodeTransform.push(null);
    // Per spec: terminate also errors the writable side
    const terminateError = new TypeError('TransformStream terminated');
    if (this.#transformStream && this.#transformStream._errorWritable) {
      this.#transformStream._errorWritable(terminateError);
    }
  }

  // Mark as errored (called by readable cancel to prevent subsequent enqueue)
  _markErrored() {
    this.#errored = true;
    this.#terminated = true;
  }

  get desiredSize() {
    const t = this.#nodeTransform;
    if (this.#terminated) return 0;
    return t.readableHighWaterMark - t.readableLength;
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
    this.#abortController = new AbortController();
  }

  error(e) {
    if (this.#controllerErrorFn) {
      this.#controllerErrorFn(this.#stream, e);
    }
  }

  _abortSignal(reason) {
    if (!this.#abortController.signal.aborted) {
      this.#abortController.abort(reason);
    }
  }

  get signal() {
    return this.#abortController.signal;
  }
}
