/**
 * FastWritableStreamDefaultWriter
 * Bridges writer.write() to Node Writable (Tier 1).
 */

import { kNodeWritable, kLock } from './utils.js';
import { kWrappedError } from './controller.js';

function unwrapError(err) {
  if (err && typeof err === 'object' && kWrappedError in err) {
    return err[kWrappedError];
  }
  return err;
}

export class FastWritableStreamDefaultWriter {
  #stream;
  #nodeWritable;
  #closedPromise;
  #closedResolve;
  #closedReject;
  #readyPromise;
  #released = false;
  #startPromise = null;
  #originalHWM;

  constructor(stream) {
    if (stream[kLock]) {
      throw new TypeError('WritableStream is already locked');
    }
    this.#stream = stream;
    this.#nodeWritable = stream[kNodeWritable];
    stream[kLock] = this;

    // Fix 9: Get start promise from stream
    this.#startPromise = stream._startPromise || null;

    // Fix 8: Track original HWM for Infinity handling
    this.#originalHWM = this.#nodeWritable.writableHighWaterMark;

    // Fix 9: If start is pending, ready should wait for it
    if (this.#startPromise) {
      this.#readyPromise = this.#startPromise.then(() => undefined);
    } else {
      this.#readyPromise = Promise.resolve(undefined);
    }

    this.#closedPromise = new Promise((resolve, reject) => {
      this.#closedResolve = resolve;
      this.#closedReject = reject;
    });

    const nodeWritable = this.#nodeWritable;

    const onFinish = () => {
      cleanup();
      if (!this.#released) {
        this.#closedResolve(undefined);
      }
    };
    const onError = (err) => {
      cleanup();
      if (!this.#released) {
        this.#closedReject(unwrapError(err));
      }
    };
    const cleanup = () => {
      nodeWritable.removeListener('finish', onFinish);
      nodeWritable.removeListener('error', onError);
    };

    if (nodeWritable.writableFinished) {
      this.#closedResolve(undefined);
    } else if (nodeWritable.errored) {
      this.#closedReject(unwrapError(nodeWritable.errored));
    } else {
      nodeWritable.on('finish', onFinish);
      nodeWritable.on('error', onError);
    }
  }

  write(chunk) {
    if (this.#released) {
      return Promise.reject(new TypeError('Writer has been released'));
    }

    const nodeWritable = this.#nodeWritable;

    if (nodeWritable.errored) {
      return Promise.reject(unwrapError(nodeWritable.errored));
    }

    if (nodeWritable.writableEnded) {
      return Promise.reject(new TypeError('Cannot write to a closed stream'));
    }

    const doWrite = () => {
      return new Promise((resolve, reject) => {
        if (nodeWritable.errored) {
          reject(unwrapError(nodeWritable.errored));
          return;
        }
        if (nodeWritable.writableEnded) {
          reject(new TypeError('Cannot write to a closed stream'));
          return;
        }
        const ok = nodeWritable.write(chunk, (err) => {
          if (err) reject(unwrapError(err));
          else resolve(undefined);
        });
        if (!ok) {
          this.#readyPromise = new Promise((res) => {
            nodeWritable.once('drain', () => {
              this.#readyPromise = Promise.resolve(undefined);
              res(undefined);
            });
          });
        }
      });
    };

    // Fix 9: Chain writes behind start() promise
    if (this.#startPromise) {
      return this.#startPromise.then(doWrite);
    }

    return doWrite();
  }

  close() {
    if (this.#released) {
      return Promise.reject(new TypeError('Writer has been released'));
    }

    const nodeWritable = this.#nodeWritable;

    if (nodeWritable.writableEnded) {
      return Promise.reject(new TypeError('Stream already closed'));
    }

    const doClose = () => {
      return new Promise((resolve, reject) => {
        if (nodeWritable.writableEnded) {
          reject(new TypeError('Stream already closed'));
          return;
        }
        nodeWritable.end((err) => {
          if (err) reject(err);
          else resolve(undefined);
        });
      });
    };

    // Fix 9: Chain close behind start() promise
    if (this.#startPromise) {
      return this.#startPromise.then(doClose);
    }

    return doClose();
  }

  abort(reason) {
    if (this.#released) {
      return Promise.reject(new TypeError('Writer has been released'));
    }
    this.#nodeWritable.destroy(reason instanceof Error ? reason : new Error(reason || 'aborted'));
    return this.#closedPromise.then(() => undefined, () => undefined);
  }

  releaseLock() {
    if (!this.#stream) return;
    if (!this.#released) {
      this.#released = true;
      if (!this.#nodeWritable.writableFinished && !this.#nodeWritable.errored) {
        this.#closedReject(new TypeError('Writer was released'));
        this.#closedPromise.catch(() => {});
      }
      this.#stream[kLock] = null;
    }
  }

  get closed() {
    return this.#closedPromise;
  }

  get ready() {
    return this.#readyPromise;
  }

  get desiredSize() {
    const w = this.#nodeWritable;
    // Fix 8: desiredSize should return 0 when closed
    if (w.writableEnded) return 0;
    if (w.errored) return null;
    // Fix 8: Return Infinity when original HWM is Infinity
    if (this.#originalHWM === 0x7FFFFFFF && w.writableHighWaterMark === 0x7FFFFFFF) {
      // Check if it was set to MAX because of Infinity
      return Infinity;
    }
    return w.writableHighWaterMark - w.writableLength;
  }
}
