/**
 * FastTransformStream — WHATWG TransformStream API backed by Node.js Transform.
 *
 * The .readable and .writable getters return shell FastReadableStream/FastWritableStream
 * instances that share the same underlying Node Transform (Transform extends Duplex).
 */

import { Transform } from 'node:stream';
import {
  kNodeReadable, kNodeWritable, kNodeTransform,
  kState, kLock, kMaterialized, kUpstream, kNativeOnly, resolveHWM,
} from './utils.js';
import { FastTransformStreamDefaultController } from './controller.js';
import { FastReadableStream } from './readable.js';
import { FastWritableStream } from './writable.js';

export class FastTransformStream {
  #readable = null;
  #writable = null;

  constructor(transformer = {}, writableStrategy, readableStrategy) {
    // Fix 4: Validate transformer
    if (transformer === null) {
      transformer = {};
    }

    // Fix 4: Eagerly access getters per spec
    const transform = transformer.transform;
    const flush = transformer.flush;
    const start = transformer.start;
    const cancel = transformer.cancel;
    const readableType = transformer.readableType;
    const writableType = transformer.writableType;

    // Fix 4: readableType and writableType must be undefined
    if (readableType !== undefined) {
      throw new RangeError(`Invalid readableType: ${readableType}`);
    }
    if (writableType !== undefined) {
      throw new RangeError(`Invalid writableType: ${writableType}`);
    }

    // Fix 4: Validate callbacks
    if (transform !== undefined && typeof transform !== 'function') {
      throw new TypeError('transform must be a function');
    }
    if (flush !== undefined && typeof flush !== 'function') {
      throw new TypeError('flush must be a function');
    }
    if (start !== undefined && typeof start !== 'function') {
      throw new TypeError('start must be a function');
    }

    // Fix 5: If either strategy has a custom size(), delegate to native
    if ((writableStrategy && typeof writableStrategy.size === 'function') ||
        (readableStrategy && typeof readableStrategy.size === 'function')) {
      const native = new TransformStream(transformer, writableStrategy, readableStrategy);
      this[kNodeTransform] = null;
      this.#readable = Object.create(FastReadableStream.prototype);
      this.#readable[kNodeReadable] = null;
      this.#readable[kLock] = null;
      this.#readable[kState] = 'idle';
      this.#readable[kMaterialized] = native.readable;
      this.#readable[kUpstream] = null;
      this.#readable[kNativeOnly] = true;

      this.#writable = Object.create(FastWritableStream.prototype);
      this.#writable[kNodeWritable] = null;
      this.#writable[kLock] = null;
      this.#writable[kState] = 'idle';
      this.#writable[kMaterialized] = native.writable;
      this.#writable[kNativeOnly] = true;
      return;
    }

    const readableHWM = resolveHWM(readableStrategy, 0);
    const writableHWM = resolveHWM(writableStrategy);
    let controller;
    let startPromise = null;

    const nodeTransform = new Transform({
      objectMode: true,
      readableHighWaterMark: readableHWM === Infinity ? 0x7FFFFFFF : readableHWM,
      writableHighWaterMark: writableHWM === Infinity ? 0x7FFFFFFF : writableHWM,
      transform(chunk, encoding, callback) {
        const doTransform = () => {
          if (!transform) {
            // Identity transform
            callback(null, chunk);
            return;
          }
          try {
            const result = transform.call(transformer, chunk, controller);
            if (result && typeof result.then === 'function') {
              result.then(() => callback(), callback);
            } else {
              callback();
            }
          } catch (e) {
            callback(e);
          }
        };
        // Queue behind start() if pending
        if (startPromise) {
          startPromise.then(doTransform, callback);
        } else {
          doTransform();
        }
      },
      flush(callback) {
        const doFlush = () => {
          if (!flush) {
            callback();
            return;
          }
          try {
            const result = flush.call(transformer, controller);
            if (result && typeof result.then === 'function') {
              result.then(() => callback(), callback);
            } else {
              callback();
            }
          } catch (e) {
            callback(e);
          }
        };
        if (startPromise) {
          startPromise.then(doFlush, callback);
        } else {
          doFlush();
        }
      },
      // Fix 7: Handle destroy to support cancel/abort
      destroy(err, callback) {
        if (err && cancel && typeof cancel === 'function') {
          try {
            const result = cancel.call(transformer, err);
            if (result && typeof result.then === 'function') {
              result.then(() => callback(err), () => callback(err));
              return;
            }
          } catch {
            // ignore errors from cancel
          }
        }
        callback(err);
      },
    });

    // Prevent unhandled 'error' events from crashing
    nodeTransform.on('error', () => {});

    controller = new FastTransformStreamDefaultController(nodeTransform);

    this[kNodeTransform] = nodeTransform;

    if (start) {
      const startResult = start.call(transformer, controller);
      if (startResult && typeof startResult.then === 'function') {
        startPromise = startResult;
        startResult.catch(() => {
          nodeTransform.destroy(new Error('start() failed'));
        });
      }
    }
  }

  get readable() {
    if (!this.#readable) {
      this.#readable = Object.create(FastReadableStream.prototype);
      this.#readable[kNodeReadable] = this[kNodeTransform];
      this.#readable[kLock] = null;
      this.#readable[kState] = 'idle';
      this.#readable[kMaterialized] = null;
      this.#readable[kUpstream] = null;
      this.#readable[kNativeOnly] = false;
    }
    return this.#readable;
  }

  get writable() {
    if (!this.#writable) {
      this.#writable = Object.create(FastWritableStream.prototype);
      this.#writable[kNodeWritable] = this[kNodeTransform];
      this.#writable[kLock] = null;
      this.#writable[kState] = 'idle';
      this.#writable[kMaterialized] = null;
      this.#writable[kNativeOnly] = false;
    }
    return this.#writable;
  }
}
