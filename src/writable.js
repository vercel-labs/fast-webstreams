/**
 * FastWritableStream — WHATWG WritableStream API backed by Node.js Writable.
 */

import { Writable } from 'node:stream';
import {
  kNodeWritable, kState, kLock, kMaterialized, kNativeOnly, resolveHWM,
} from './utils.js';
import { FastWritableStreamDefaultController } from './controller.js';
import { FastWritableStreamDefaultWriter } from './writer.js';
import { materializeWritable } from './materialize.js';

export class FastWritableStream {
  constructor(underlyingSink = {}, strategy) {
    // Fix 4: Validate underlyingSink
    if (underlyingSink === null) {
      underlyingSink = {};
    }

    // Fix 4: Eagerly access getters per spec
    const write = underlyingSink.write;
    const close = underlyingSink.close;
    const abort = underlyingSink.abort;
    const start = underlyingSink.start;
    const type = underlyingSink.type;

    // Fix 4: type must be undefined
    if (type !== undefined) {
      throw new RangeError(`Invalid type: ${type}`);
    }

    // Fix 4: Validate callbacks
    if (write !== undefined && typeof write !== 'function') {
      throw new TypeError('write must be a function');
    }
    if (close !== undefined && typeof close !== 'function') {
      throw new TypeError('close must be a function');
    }
    if (abort !== undefined && typeof abort !== 'function') {
      throw new TypeError('abort must be a function');
    }
    if (start !== undefined && typeof start !== 'function') {
      throw new TypeError('start must be a function');
    }

    // Fix 5: If strategy has a custom size() function, delegate to native
    if (strategy && typeof strategy.size === 'function') {
      const native = new WritableStream(underlyingSink, strategy);
      this[kNodeWritable] = null;
      this[kMaterialized] = native;
      this[kLock] = null;
      this[kState] = 'idle';
      this[kNativeOnly] = true;
      return;
    }

    // Fix 4: Validate strategy highWaterMark
    const hwm = resolveHWM(strategy);
    if (strategy && 'highWaterMark' in strategy) {
      const h = strategy.highWaterMark;
      if (typeof h !== 'number' || Number.isNaN(h) || h < 0) {
        throw new RangeError('Invalid highWaterMark');
      }
    }

    let controller;

    const nodeWritable = new Writable({
      objectMode: true,
      highWaterMark: hwm === Infinity ? 0x7FFFFFFF : hwm,
      write(chunk, encoding, callback) {
        if (!write) {
          callback();
          return;
        }
        const result = write.call(underlyingSink, chunk, controller);
        if (result && typeof result.then === 'function') {
          result.then(() => callback(), callback);
        } else {
          callback();
        }
      },
      final(callback) {
        if (!close) {
          callback();
          return;
        }
        const result = close.call(underlyingSink);
        if (result && typeof result.then === 'function') {
          result.then(() => callback(), callback);
        } else {
          callback();
        }
      },
      destroy(err, callback) {
        if (err && abort) {
          const result = abort.call(underlyingSink, err);
          if (result && typeof result.then === 'function') {
            result.then(() => callback(err), () => callback(err));
            return;
          }
        }
        callback(err);
      },
    });

    // Prevent unhandled 'error' events from crashing
    nodeWritable.on('error', () => {});

    controller = new FastWritableStreamDefaultController(nodeWritable);

    this[kNodeWritable] = nodeWritable;
    this[kLock] = null;
    this[kState] = 'idle';
    this[kMaterialized] = null;
    this[kNativeOnly] = false;

    // Fix 9: Track start promise for write/close ordering (use regular property, not private,
    // because transform shell objects use Object.create() and can't access private fields)
    this._startPromise = null;
    if (start) {
      const startResult = start.call(underlyingSink, controller);
      if (startResult && typeof startResult.then === 'function') {
        this._startPromise = startResult;
        startResult.catch(() => {
          nodeWritable.destroy(new Error('start() failed'));
        });
      }
    }
  }

  getWriter() {
    // Fix 1: For native-only streams, delegate
    if (this[kNativeOnly]) {
      return materializeWritable(this).getWriter();
    }
    return new FastWritableStreamDefaultWriter(this);
  }

  abort(reason) {
    if (this[kLock]) {
      return Promise.reject(new TypeError('WritableStream is locked'));
    }
    // Fix 1: For native-only streams, delegate
    if (this[kNativeOnly]) {
      return materializeWritable(this).abort(reason);
    }
    this[kNodeWritable].destroy(reason instanceof Error ? reason : new Error(reason || 'aborted'));
    return Promise.resolve(undefined);
  }

  close() {
    if (this[kLock]) {
      return Promise.reject(new TypeError('WritableStream is locked'));
    }
    // Fix 1: For native-only streams, delegate
    if (this[kNativeOnly]) {
      return materializeWritable(this).close();
    }
    return new Promise((resolve, reject) => {
      this[kNodeWritable].end((err) => {
        if (err) reject(err);
        else resolve(undefined);
      });
    });
  }

  get locked() {
    return this[kLock] !== null;
  }

}
