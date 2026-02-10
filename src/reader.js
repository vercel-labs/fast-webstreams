/**
 * FastReadableStreamDefaultReader
 * Bridges reader.read() to Node Readable consumption with sync fast path (Tier 1).
 */

import { unwrapError, kDequeueBytes } from './controller.js';
import { kLock, kNodeReadable, noop } from './utils.js';

// Cached done result — avoids allocating { value: undefined, done: true } + Promise per stream end
const DONE_RESULT = { value: undefined, done: true };
const DONE_PROMISE = Promise.resolve(DONE_RESULT);

function _resolveReadResult(value, done) {
  if (done) return DONE_PROMISE;
  return Promise.resolve({ value, done: false });
}

/**
 * Create a shared LiteReadable dispatcher for FIFO read queue.
 * Dispatches push events to the oldest waiting read in the queue.
 */
function _createLiteDispatcher(nodeReadable) {
  const dispatch = (event, arg) => {
    const queue = nodeReadable._readQueue;
    if (!queue || queue.length === 0) return;

    if (event === 'data') {
      // Dispatch to oldest waiting read (FIFO)
      const entry = queue[0];
      const data = nodeReadable.read();
      if (data !== null) {
        queue.shift();
        entry.removePending();
        const stream = entry.stream;
        if (stream._controller && stream._controller[kDequeueBytes]) stream._controller[kDequeueBytes](data);
        if (stream._onPull) stream._onPull();
        entry.resolve({ value: data, done: false });
        // If more data available and more reads waiting, dispatch again
        if (queue.length > 0 && nodeReadable.readableLength > 0) {
          dispatch('data');
        } else if (queue.length > 0) {
          // Re-register for next push
          nodeReadable._dataCallback = dispatch;
        }
      } else if (nodeReadable.readableEnded || nodeReadable.destroyed) {
        queue.shift();
        entry.removePending();
        entry.resolve(DONE_RESULT);
      } else {
        // No data yet — re-register for next push
        nodeReadable._dataCallback = dispatch;
      }
    } else {
      // end/error/close — dispatch to ALL waiting reads
      const entries = queue.splice(0);
      for (const entry of entries) {
        entry.removePending();
        if (event === 'end') {
          entry.resolve(DONE_RESULT);
        } else if (event === 'error') {
          const stream = entry.stream;
          if (stream._errored) entry.reject(stream._storedError);
          else entry.reject(unwrapError(arg));
        } else if (event === 'close') {
          const stream = entry.stream;
          if (stream._errored) entry.reject(stream._storedError);
          else if (nodeReadable.errored) entry.reject(unwrapError(nodeReadable.errored));
          else entry.resolve(DONE_RESULT);
        }
      }
    }
  };
  return dispatch;
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

    // Use stream-level state for initial closed/errored checks (preserves error identity)
    if (stream._errored) {
      this.#settleClose(false, stream._storedError);
    } else if (stream._closed) {
      this.#settleClose(true);
    } else {
      const nodeReadable = this.#nodeReadable;

      // Check Node-level state as fallback
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
          stream._closed = true;
          this.#settleClose(true);
        };
        const onError = (err) => {
          cleanup();
          // Use stream-level error if available (preserves identity)
          if (stream._errored) {
            this.#settleClose(false, stream._storedError);
          } else {
            this.#settleClose(false, unwrapError(err));
          }
        };
        const onClose = () => {
          cleanup();
          if (stream._errored) {
            this.#settleClose(false, stream._storedError);
          } else if (nodeReadable.errored) {
            this.#settleClose(false, unwrapError(nodeReadable.errored));
          } else {
            stream._closed = true;
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
  }

  #settleClose(success, err) {
    if (this.#closedSettled || this.#released) return;
    this.#closedSettled = true;
    if (success) {
      this.#closedResolve(undefined);
    } else {
      this.#closedReject(err);
      this.#closedPromise.catch(noop);
    }
  }

  read() {
    if (this.#released) {
      return Promise.reject(new TypeError('Reader has been released'));
    }

    const stream = this.#stream;
    const nodeReadable = this.#nodeReadable;

    // Check stream-level error first (preserves error identity for falsy errors)
    if (stream._errored) {
      return Promise.reject(stream._storedError);
    }

    // Check if the stream has errored (Node-level fallback)
    if (nodeReadable.errored) {
      return Promise.reject(unwrapError(nodeReadable.errored));
    }

    // Check if destroyed (closed)
    if (nodeReadable.destroyed) {
      return _resolveReadResult(undefined, true);
    }

    // Tier 1: sync fast path — data already in buffer
    const chunk = nodeReadable.read();
    if (chunk !== null) {
      // Track byte dequeue for byte stream desiredSize
      if (stream._controller && stream._controller[kDequeueBytes]) stream._controller[kDequeueBytes](chunk);
      // Notify transform controller that data was consumed (may clear backpressure)
      if (stream._onPull) stream._onPull();
      // Byte stream sync pull-after-read: trigger pull when desiredSize crosses from ≤0 to >0.
      // This fires exactly once — pull refills, making desiredSize ≤0 again (no recursion).
      if (stream._isByteStream && stream._pullFn && !nodeReadable.destroyed && stream._controller) {
        const ds = stream._controller.desiredSize;
        if (ds !== null && ds > 0 && ds - (chunk.byteLength || 0) <= 0) {
          nodeReadable._readableState.reading = false;
          nodeReadable.read(0);
        }
      }
      return _resolveReadResult(chunk, false);
    }

    // Check if ended
    if (nodeReadable.readableEnded) {
      return _resolveReadResult(undefined, true);
    }

    // Data not available yet — wait for data
    return new Promise((resolve, reject) => {
      // Track this pending read for releaseLock
      const entry = { reject: null, cleanup: null };
      this.#pendingReads.push(entry);

      // Notify transform controller that there's a pending read (clears backpressure)
      // Must be called AFTER pushing to pendingReads so _pendingReadCount() is accurate
      if (stream._onPull) stream._onPull();

      const removePending = () => {
        const idx = this.#pendingReads.indexOf(entry);
        if (idx !== -1) this.#pendingReads.splice(idx, 1);
      };

      // LiteReadable fast path: FIFO callback queue instead of 4 listener registrations.
      // Multiple concurrent reads are queued; each push dispatches to the oldest waiting read.
      if (nodeReadable._dataCallback !== undefined) {
        const readQueue = nodeReadable._readQueue || (nodeReadable._readQueue = []);
        const queueEntry = { resolve, reject, entry, stream, removePending };
        readQueue.push(queueEntry);
        entry.reject = reject;
        entry.cleanup = () => {
          const idx = readQueue.indexOf(queueEntry);
          if (idx !== -1) readQueue.splice(idx, 1);
        };
        // Install shared dispatcher if not already installed
        if (!nodeReadable._dataCallback) {
          nodeReadable._dataCallback = _createLiteDispatcher(nodeReadable);
        }
        if (nodeReadable._readableState.reading) nodeReadable._readableState.reading = false;
        nodeReadable.read(0);
        return;
      }

      // Node.js Readable path: use event listeners
      const onReadable = () => {
        cleanup();
        removePending();
        const data = nodeReadable.read();
        if (data !== null) {
          if (stream._controller && stream._controller[kDequeueBytes]) stream._controller[kDequeueBytes](data);
          if (stream._onPull) stream._onPull();
          resolve({ value: data, done: false });
        } else if (nodeReadable.readableEnded || nodeReadable.destroyed) {
          resolve(DONE_RESULT);
        } else {
          // No data yet, re-register
          this.#pendingReads.push(entry);
          nodeReadable.once('readable', onReadable);
          nodeReadable.once('end', onEnd);
          nodeReadable.once('error', onError);
          nodeReadable.once('close', onClose);
        }
      };
      const onEnd = () => { cleanup(); removePending(); resolve(DONE_RESULT); };
      const onError = (err) => {
        cleanup(); removePending();
        if (stream._errored) reject(stream._storedError);
        else reject(unwrapError(err));
      };
      const onClose = () => {
        cleanup(); removePending();
        if (stream._errored) reject(stream._storedError);
        else if (nodeReadable.errored) reject(unwrapError(nodeReadable.errored));
        else resolve(DONE_RESULT);
      };
      const cleanup = () => {
        nodeReadable.removeListener('readable', onReadable);
        nodeReadable.removeListener('end', onEnd);
        nodeReadable.removeListener('error', onError);
        nodeReadable.removeListener('close', onClose);
      };

      entry.reject = reject;
      entry.cleanup = cleanup;

      nodeReadable.once('readable', onReadable);
      nodeReadable.once('end', onEnd);
      nodeReadable.once('error', onError);
      nodeReadable.once('close', onClose);

      // Trigger _read() to request data (pull).
      if (nodeReadable._readableState.reading) {
        nodeReadable._readableState.reading = false;
      }
      nodeReadable.read(0);
    });
  }

  /**
   * Internal sync read — returns { value, done } directly, or null if data isn't
   * available (caller should fall back to async read()). Used by specPipeTo to
   * avoid Promise allocation when data is buffered.
   */
  _readSync() {
    if (this.#released) return null;
    const stream = this.#stream;
    if (stream._errored) return null; // Let async read() handle error rejection
    const nodeReadable = this.#nodeReadable;
    if (nodeReadable.errored || nodeReadable.destroyed) return null;
    const chunk = nodeReadable.read();
    if (chunk !== null) {
      if (stream._controller && stream._controller[kDequeueBytes]) stream._controller[kDequeueBytes](chunk);
      if (stream._onPull) stream._onPull();
      return { value: chunk, done: false };
    }
    if (nodeReadable.readableEnded) return DONE_RESULT;
    return null;
  }

  cancel(reason) {
    if (this.#released) {
      return Promise.reject(new TypeError('Reader has been released'));
    }
    // Call the stream's internal cancel (bypasses lock check, calls underlyingSource.cancel)
    return this.#stream._cancelInternal(reason);
  }

  /**
   * Called by controller.error() to synchronously settle the closedPromise.
   * Must be called BEFORE _errorReadRequests so closed rejects before reads.
   */
  _settleClosedFromError(error) {
    if (!this.#closedSettled && !this.#released) {
      this.#closedSettled = true;
      this.#closedReject(error);
      this.#closedPromise.catch(noop);
    }
  }

  /**
   * Called by controller.error() to synchronously reject all pending read requests.
   * Per spec: ReadableStreamError rejects all read requests before releaseLock.
   */
  _errorReadRequests(error) {
    for (const entry of this.#pendingReads) {
      if (entry.cleanup) entry.cleanup();
      if (entry.reject) entry.reject(error);
    }
    this.#pendingReads = [];
  }

  /**
   * Returns the number of pending read requests. Used by transform controller
   * to compute accurate desiredSize (pending reads consume enqueued chunks).
   */
  _pendingReadCount() {
    return this.#pendingReads.length;
  }

  /**
   * Called by stream._cancelInternal() to resolve closedPromise synchronously.
   * Per spec: cancel sets stream state to "closed" and resolves reader.closedPromise
   * before calling the cancel algorithm.
   */
  _resolveClosedFromCancel() {
    if (!this.#closedSettled && !this.#released) {
      this.#closedResolve(undefined);
      this.#closedSettled = true;
    }
  }

  releaseLock() {
    if (!this.#stream) return;
    if (!this.#released) {
      this.#released = true;
      const stream = this.#stream;

      // Reject all pending read requests
      const releasedError = new TypeError('Reader was released');
      for (const entry of this.#pendingReads) {
        if (entry.cleanup) entry.cleanup();
        if (entry.reject) entry.reject(releasedError);
      }
      this.#pendingReads = [];

      if (!this.#closedSettled) {
        // Per spec: if state is "readable", reject existing promise (preserve identity).
        // If state is "closed" or "errored", the promise should already be settled
        // from events. But if it hasn't settled yet, settle it first.
        if (stream._closed) {
          // Stream closed (e.g., via cancel) — resolve, then replace
          this.#closedResolve(undefined);
          this.#closedSettled = true;
          this.#closedPromise = Promise.reject(releasedError);
          this.#closedPromise.catch(noop);
        } else if (stream._errored) {
          // Stream errored — reject with stored error, then replace
          this.#closedReject(stream._storedError);
          this.#closedPromise.catch(noop);
          this.#closedSettled = true;
          this.#closedPromise = Promise.reject(releasedError);
          this.#closedPromise.catch(noop);
        } else {
          // Stream still readable — reject existing promise, preserve identity
          this.#closedReject(releasedError);
          this.#closedPromise.catch(noop);
          this.#closedSettled = true;
        }
      } else {
        // Already settled — per spec: replace with new rejected promise
        this.#closedPromise = Promise.reject(releasedError);
        this.#closedPromise.catch(noop);
      }

      stream[kLock] = null;
    }
  }

  get closed() {
    return this.#closedPromise;
  }
}
