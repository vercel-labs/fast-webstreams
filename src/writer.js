/**
 * FastWritableStreamDefaultWriter
 * Bridges writer.write() to the writable state machine.
 */

import { kNodeWritable, kLock } from './utils.js';
import {
  kWritableState, kStoredError, kPendingAbortRequest,
  kInFlightWriteRequest, kWriteRequests, kCloseRequest, kInFlightCloseRequest,
  _abortInternal, _writeInternal, _closeFromWriter, _getDesiredSize,
} from './writable.js';

export class FastWritableStreamDefaultWriter {
  #stream;
  #nodeWritable;
  #closedPromise;
  #closedResolve;
  #closedReject;
  #closedSettled = false;
  #readyPromise;
  #readyResolve;
  #readyReject;
  #readySettled = false;
  #released = false;

  constructor(stream) {
    if (stream[kLock]) {
      throw new TypeError('WritableStream is already locked');
    }
    this.#stream = stream;
    this.#nodeWritable = stream[kNodeWritable];
    stream[kLock] = this;

    // Set up closed promise
    this.#closedPromise = new Promise((resolve, reject) => {
      this.#closedResolve = resolve;
      this.#closedReject = reject;
    });

    const state = stream[kWritableState];

    if (state === 'writable') {
      // Check if there's backpressure or close pending
      if (!_defaultWriterReadyPromiseIsSettled(stream)) {
        // Pending ready (backpressure or not started)
        this.#readyPromise = new Promise((resolve, reject) => {
          this.#readyResolve = resolve;
          this.#readyReject = reject;
        });
        this.#readySettled = false;
      } else {
        this.#readyPromise = Promise.resolve(undefined);
        this.#readySettled = true;
        this.#readyResolve = null;
        this.#readyReject = null;
      }
    } else if (state === 'erroring') {
      this.#readyPromise = Promise.reject(stream[kStoredError]);
      this.#readyPromise.catch(() => {});
      this.#readySettled = true;
      this.#readyResolve = null;
      this.#readyReject = null;
    } else if (state === 'closed') {
      this.#readyPromise = Promise.resolve(undefined);
      this.#readySettled = true;
      this.#readyResolve = null;
      this.#readyReject = null;
      this.#closedResolve(undefined);
      this.#closedSettled = true;
    } else if (state === 'errored') {
      const storedError = stream[kStoredError];
      this.#readyPromise = Promise.reject(storedError);
      this.#readyPromise.catch(() => {});
      this.#readySettled = true;
      this.#readyResolve = null;
      this.#readyReject = null;
      this.#closedReject(storedError);
      this.#closedPromise.catch(() => {});
      this.#closedSettled = true;
    }

    // If start is pending, ready should wait for it
    if (stream._startPromise && state === 'writable' && !this.#readySettled) {
      // Already have a pending ready promise, good
    } else if (stream._startPromise && state === 'writable' && this.#readySettled) {
      // Need to convert to pending
      this.#readyPromise = new Promise((resolve, reject) => {
        this.#readyResolve = resolve;
        this.#readyReject = reject;
      });
      this.#readySettled = false;
    }
  }

  write(chunk) {
    if (this.#released) {
      return Promise.reject(new TypeError('Writer has been released'));
    }
    return _writeInternal(this.#stream, chunk);
  }

  close() {
    if (this.#released) {
      return Promise.reject(new TypeError('Writer has been released'));
    }
    const stream = this.#stream;
    return _closeFromWriter(stream);
  }

  abort(reason) {
    if (this.#released) {
      return Promise.reject(new TypeError('Writer has been released'));
    }
    return _abortInternal(this.#stream, reason);
  }

  releaseLock() {
    if (!this.#stream) return;
    if (!this.#released) {
      this.#released = true;
      const stream = this.#stream;

      if (!this.#closedSettled) {
        const typeError = new TypeError('Writer was released');

        // Reject ready FIRST (so ready handlers fire before closed handlers)
        if (!this.#readySettled) {
          this.#readyReject(typeError);
          this.#readyPromise.catch(() => {});
          this.#readySettled = true;
        } else {
          this.#readyPromise = Promise.reject(typeError);
          this.#readyPromise.catch(() => {});
        }

        // Then reject closed
        this.#closedReject(typeError);
        this.#closedPromise.catch(() => {});
        this.#closedSettled = true;
      } else {
        const typeError = new TypeError('Writer was released');
        this.#readyPromise = Promise.reject(typeError);
        this.#readyPromise.catch(() => {});
        this.#closedPromise = Promise.reject(typeError);
        this.#closedPromise.catch(() => {});
      }

      stream[kLock] = null;
    }
  }

  get closed() {
    return this.#closedPromise;
  }

  get ready() {
    return this.#readyPromise;
  }

  get desiredSize() {
    if (this.#released) {
      throw new TypeError('Cannot get desiredSize of a released writer');
    }
    return _getDesiredSize(this.#stream);
  }

  // --- Internal methods called by the stream state machine ---

  /**
   * Reject the ready promise if it's pending (called on transition to erroring).
   */
  _rejectReadyIfPending(reason) {
    if (!this.#readySettled && this.#readyReject) {
      this.#readyReject(reason);
      this.#readyPromise.catch(() => {});
      this.#readySettled = true;
      this.#readyResolve = null;
      this.#readyReject = null;
    } else if (this.#readySettled) {
      // Replace with a new rejected promise
      this.#readyPromise = Promise.reject(reason);
      this.#readyPromise.catch(() => {});
    }
  }

  /**
   * Resolve the ready promise (called when close is requested or backpressure relieved).
   */
  _resolveReady() {
    if (!this.#readySettled && this.#readyResolve) {
      this.#readyResolve(undefined);
      this.#readySettled = true;
      this.#readyResolve = null;
      this.#readyReject = null;
    }
  }

  /**
   * Reject the closed promise (called when stream transitions to errored).
   */
  _rejectClosed(error) {
    if (this.#released) return;
    if (!this.#closedSettled) {
      this.#closedReject(error);
      this.#closedPromise.catch(() => {});
      this.#closedSettled = true;
    }
  }

  /**
   * Reject the ready promise unconditionally (e.g., on close error).
   */
  _rejectReady(error) {
    if (this.#released) return;
    if (!this.#readySettled && this.#readyReject) {
      this.#readyReject(error);
      this.#readyPromise.catch(() => {});
      this.#readySettled = true;
      this.#readyResolve = null;
      this.#readyReject = null;
    } else {
      this.#readyPromise = Promise.reject(error);
      this.#readyPromise.catch(() => {});
      this.#readySettled = true;
    }
  }

  /**
   * Resolve the closed promise (called when stream transitions to closed).
   */
  _resolveClosed() {
    if (this.#released) return;
    if (!this.#closedSettled) {
      this.#closedResolve(undefined);
      this.#closedSettled = true;
    }
  }

  /**
   * Update the ready promise based on backpressure.
   * If there's backpressure, ready should be pending. Otherwise resolved.
   */
  _updateReadyForBackpressure(stream) {
    if (this.#released) return;
    const desiredSize = _getDesiredSize(stream);
    if (desiredSize !== null && desiredSize <= 0) {
      // Backpressure — make ready pending if currently settled
      if (this.#readySettled) {
        this.#readyPromise = new Promise((resolve, reject) => {
          this.#readyResolve = resolve;
          this.#readyReject = reject;
        });
        this.#readySettled = false;
      }
    } else {
      // No backpressure — resolve ready if pending
      if (!this.#readySettled && this.#readyResolve) {
        this.#readyResolve(undefined);
        this.#readySettled = true;
        this.#readyResolve = null;
        this.#readyReject = null;
      } else if (!this.#readySettled) {
        this.#readyPromise = Promise.resolve(undefined);
        this.#readySettled = true;
      }
    }
  }

  /**
   * Set ready to a new pending promise (backpressure from Node write returning false).
   */
  _setReadyPending(stream) {
    if (this.#released) return;
    if (this.#readySettled) {
      this.#readyPromise = new Promise((resolve, reject) => {
        this.#readyResolve = resolve;
        this.#readyReject = reject;
      });
      this.#readySettled = false;

      // Listen for drain to resolve it
      const nodeWritable = stream[kNodeWritable];
      nodeWritable.once('drain', () => {
        if (!this.#released && !this.#readySettled) {
          this.#readyResolve(undefined);
          this.#readySettled = true;
          this.#readyResolve = null;
          this.#readyReject = null;
        }
      });
    }
  }
}

/**
 * Check if the writer's ready promise should be initially settled.
 * Ready should be pending if the stream hasn't started or if there's backpressure.
 */
function _defaultWriterReadyPromiseIsSettled(stream) {
  // If start is pending, ready should be pending
  if (stream._startPromise) return false;
  // If desiredSize <= 0, there's backpressure
  const desiredSize = _getDesiredSize(stream);
  return desiredSize !== null && desiredSize > 0;
}
