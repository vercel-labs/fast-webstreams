/**
 * FastReadableStreamDefaultReader
 * Bridges reader.read() to Node Readable consumption with sync fast path (Tier 1).
 */

import { kNodeReadable, kState, kLock } from './utils.js';
import { kWrappedError } from './controller.js';

function unwrapError(err) {
  if (err && typeof err === 'object' && kWrappedError in err) {
    return err[kWrappedError];
  }
  return err;
}

export class FastReadableStreamDefaultReader {
  #stream;
  #nodeReadable;
  #closedPromise;
  #closedResolve;
  #closedReject;
  #closedSettled = false;
  #released = false;
  #pendingReads = []; // Track pending reads for releaseLock

  constructor(stream) {
    if (stream[kLock]) {
      throw new TypeError('ReadableStream is already locked');
    }
    this.#stream = stream;
    this.#nodeReadable = stream[kNodeReadable];
    stream[kLock] = this;

    this.#closedPromise = new Promise((resolve, reject) => {
      this.#closedResolve = resolve;
      this.#closedReject = reject;
    });

    const nodeReadable = this.#nodeReadable;

    // Check if already done
    if (nodeReadable.destroyed) {
      if (nodeReadable.errored) {
        this.#settleClose(false, unwrapError(nodeReadable.errored));
      } else {
        this.#settleClose(true);
      }
    } else if (nodeReadable.readableEnded) {
      this.#settleClose(true);
    } else {
      // Listen for close events
      const onEnd = () => {
        cleanup();
        this.#settleClose(true);
      };
      const onError = (err) => {
        cleanup();
        this.#settleClose(false, unwrapError(err));
      };
      const onClose = () => {
        cleanup();
        if (nodeReadable.errored) {
          this.#settleClose(false, unwrapError(nodeReadable.errored));
        } else {
          this.#settleClose(true);
        }
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

  #settleClose(success, err) {
    if (this.#closedSettled || this.#released) return;
    this.#closedSettled = true;
    if (success) {
      this.#closedResolve(undefined);
    } else {
      this.#closedReject(err);
    }
  }

  read() {
    if (this.#released) {
      return Promise.reject(new TypeError('Reader has been released'));
    }

    const nodeReadable = this.#nodeReadable;

    // Check if the stream has errored
    if (nodeReadable.errored) {
      return Promise.reject(unwrapError(nodeReadable.errored));
    }

    // Check if destroyed (closed)
    if (nodeReadable.destroyed) {
      return Promise.resolve({ value: undefined, done: true });
    }

    // Tier 1: sync fast path — data already in buffer
    const chunk = nodeReadable.read();
    if (chunk !== null) {
      return Promise.resolve({ value: chunk, done: false });
    }

    // Check if ended
    if (nodeReadable.readableEnded) {
      return Promise.resolve({ value: undefined, done: true });
    }

    // Data not available yet — wait for 'readable', 'end', or 'close'
    return new Promise((resolve, reject) => {
      // Track this pending read for releaseLock
      const entry = { reject: null, cleanup: null };
      this.#pendingReads.push(entry);

      const onReadable = () => {
        cleanup();
        const data = nodeReadable.read();
        if (data !== null) {
          removePending();
          resolve({ value: data, done: false });
        } else if (nodeReadable.readableEnded || nodeReadable.destroyed) {
          removePending();
          resolve({ value: undefined, done: true });
        } else {
          // Re-listen
          nodeReadable.once('readable', onReadable);
          nodeReadable.once('end', onEnd);
          nodeReadable.once('error', onError);
          nodeReadable.once('close', onClose);
        }
      };
      const onEnd = () => {
        cleanup();
        removePending();
        resolve({ value: undefined, done: true });
      };
      const onError = (err) => {
        cleanup();
        removePending();
        reject(unwrapError(err));
      };
      const onClose = () => {
        cleanup();
        removePending();
        if (nodeReadable.errored) {
          reject(unwrapError(nodeReadable.errored));
        } else {
          resolve({ value: undefined, done: true });
        }
      };
      const cleanup = () => {
        nodeReadable.removeListener('readable', onReadable);
        nodeReadable.removeListener('end', onEnd);
        nodeReadable.removeListener('error', onError);
        nodeReadable.removeListener('close', onClose);
      };
      const removePending = () => {
        const idx = this.#pendingReads.indexOf(entry);
        if (idx !== -1) this.#pendingReads.splice(idx, 1);
      };

      entry.reject = reject;
      entry.cleanup = cleanup;

      nodeReadable.once('readable', onReadable);
      nodeReadable.once('end', onEnd);
      nodeReadable.once('error', onError);
      nodeReadable.once('close', onClose);
    });
  }

  cancel(reason) {
    if (this.#released) {
      return Promise.reject(new TypeError('Reader has been released'));
    }
    // Call the stream's internal cancel (bypasses lock check, calls underlyingSource.cancel)
    return this.#stream._cancelInternal(reason);
  }

  releaseLock() {
    if (!this.#stream) return;
    if (!this.#released) {
      this.#released = true;

      // Reject all pending read requests
      const releasedError = new TypeError('Reader was released');
      for (const entry of this.#pendingReads) {
        if (entry.cleanup) entry.cleanup();
        if (entry.reject) entry.reject(releasedError);
      }
      this.#pendingReads = [];

      // Per spec: if closed was NOT settled, reject the existing promise.
      // Then ALWAYS replace with a new rejected promise (new identity).
      if (!this.#closedSettled) {
        this.#closedReject(new TypeError('Reader was released'));
        this.#closedPromise.catch(() => {});
        this.#closedSettled = true;
      }
      // Replace with a new promise for post-release access
      this.#closedPromise = Promise.reject(new TypeError('Reader was released'));
      this.#closedPromise.catch(() => {});

      this.#stream[kLock] = null;
    }
  }

  get closed() {
    return this.#closedPromise;
  }

  /**
   * Called synchronously by the stream when controller.close()/error() is invoked.
   * Ensures the closed promise settles BEFORE any subsequent releaseLock() call.
   */
  _settleClosedSync(success, err) {
    this.#settleClose(success, err);
  }
}
