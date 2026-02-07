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
import {
  FastWritableStream,
  kWritableState, kStoredError, kPendingAbortRequest,
  kInFlightWriteRequest, kInFlightCloseRequest,
  kWriteRequests, kCloseRequest, kStarted,
  _controllerError as _writableControllerError,
  _advanceQueueIfNeeded,
} from './writable.js';
import { kWrappedError } from './controller.js';

function _unwrapError(err) {
  if (err && typeof err === 'object' && kWrappedError in err) {
    return err[kWrappedError];
  }
  return err;
}

/**
 * Error the transform's writable side via the proper state machine.
 * Uses _writableControllerError which transitions through erroring → errored,
 * properly handling in-flight writes and pending aborts.
 */
function _errorTransformWritable(transformSelf, reason) {
  const writable = transformSelf.writable;

  // For transform shells: clear in-flight write that may never complete
  // (Node transform callbacks don't fire after destroy).
  // Must clear BEFORE _controllerError so _finishErroring can run.
  if (writable._isTransformShell && writable[kInFlightWriteRequest]) {
    const req = writable[kInFlightWriteRequest];
    writable[kInFlightWriteRequest] = null;
    req.reject(reason);
  }

  _writableControllerError(writable, reason);
}

export class FastTransformStream {
  #readable = null;
  #writable = null;

  constructor(transformer = {}, writableStrategy, readableStrategy) {
    if (transformer === null) {
      transformer = {};
    }

    const transform = transformer.transform;
    const flush = transformer.flush;
    const start = transformer.start;
    const cancel = transformer.cancel;
    const readableType = transformer.readableType;
    const writableType = transformer.writableType;

    if (readableType !== undefined) {
      throw new RangeError(`Invalid readableType: ${readableType}`);
    }
    if (writableType !== undefined) {
      throw new RangeError(`Invalid writableType: ${writableType}`);
    }

    if (transform !== undefined && typeof transform !== 'function') {
      throw new TypeError('transform must be a function');
    }
    if (flush !== undefined && typeof flush !== 'function') {
      throw new TypeError('flush must be a function');
    }
    if (start !== undefined && typeof start !== 'function') {
      throw new TypeError('start must be a function');
    }

    // If either strategy has a custom size(), delegate to native
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
    const self = this;

    const nodeTransform = new Transform({
      objectMode: true,
      readableHighWaterMark: readableHWM === Infinity ? 0x7FFFFFFF : readableHWM,
      writableHighWaterMark: writableHWM === Infinity ? 0x7FFFFFFF : writableHWM,
      transform(chunk, encoding, callback) {
        const doTransform = () => {
          if (!transform) {
            callback(null, chunk);
            return;
          }
          try {
            const result = Reflect.apply(transform, transformer, [chunk, controller]);
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
          startPromise.then(doTransform, callback);
        } else {
          doTransform();
        }
      },
      flush(callback) {
        // If cancel was already called (from readable.cancel()), skip flush
        if (self._cancelCalled) {
          callback();
          return;
        }
        self._flushStarted = true;
        const doFlush = () => {
          if (!flush) {
            callback();
            return;
          }
          try {
            const result = Reflect.apply(flush, transformer, [controller]);
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
      destroy(err, callback) {
        // Only call cancel from destroy if there's no pending abort that will
        // handle it via sinkAbort (which needs to catch thrown errors).
        const writable = self.writable;
        const hasPendingAbort = writable && writable[kPendingAbortRequest];
        if (err && cancel && typeof cancel === 'function' && !self._cancelCalled && !hasPendingAbort) {
          self._cancelCalled = true;
          try {
            const result = Reflect.apply(cancel, transformer, [err]);
            if (result && typeof result.then === 'function') {
              result.then(() => callback(err), () => callback(err));
              return;
            }
          } catch {
            // ignore errors from cancel in destroy
          }
        }
        callback(err);
      },
    });

    // Prevent unhandled 'error' events from crashing
    nodeTransform.on('error', () => {});

    controller = new FastTransformStreamDefaultController(nodeTransform);
    controller._setTransformStream(this);

    this[kNodeTransform] = nodeTransform;

    this._transformerCancel = cancel || null;
    this._transformer = transformer;
    this._cancelCalled = false;
    this._flushStarted = false;
    this._controller = controller;

    // Method for controller.terminate() and controller.error() to error the writable side
    this._errorWritable = (reason) => _errorTransformWritable(this, reason);

    // Track start completion for writable shell's kStarted
    this._startCompleted = false;

    const onStartCompleted = () => {
      self._startCompleted = true;
      // If writable shell was already created, set kStarted and advance queue
      if (self.#writable && !self.#writable[kStarted]) {
        self.#writable[kStarted] = true;
        _advanceQueueIfNeeded(self.#writable);
      }
    };

    if (start) {
      const startResult = Reflect.apply(start, transformer, [controller]);
      if (startResult && typeof startResult.then === 'function') {
        startPromise = startResult;
        startResult.then(
          () => { queueMicrotask(onStartCompleted); },
          (err) => {
            const e = err || new Error('start() failed');
            // Error both sides per spec
            if (self._controller) {
              try { self._controller.error(e); } catch {}
            }
            if (!nodeTransform.destroyed) nodeTransform.destroy(e);
            queueMicrotask(onStartCompleted);
          }
        );
      } else {
        // Sync start — defer completion via microtask (per spec)
        queueMicrotask(onStartCompleted);
      }
    } else {
      queueMicrotask(onStartCompleted);
    }
  }

  get readable() {
    if (!this.#readable) {
      const transform = this[kNodeTransform];
      const cancelFn = this._transformerCancel;
      const transformerObj = this._transformer;

      this.#readable = Object.create(FastReadableStream.prototype);
      this.#readable[kNodeReadable] = transform;
      this.#readable[kLock] = null;
      this.#readable[kState] = 'idle';
      this.#readable[kMaterialized] = null;
      this.#readable[kUpstream] = null;
      this.#readable[kNativeOnly] = false;

      // Wire cancel: readable.cancel() → transformer.cancel() + error writable
      const transformSelf = this;
      this.#readable._cancel = (reason) => {
        // Mark controller as errored (prevents enqueue after cancel)
        if (transformSelf._controller && transformSelf._controller._markErrored) {
          transformSelf._controller._markErrored();
        }

        // If flush is already in progress, skip cancel and don't error writable.
        // Return a special signal to _cancelInternal to NOT destroy the node stream.
        if (transformSelf._flushStarted) {
          return 'SKIP_DESTROY';
        }

        let cancelResult;
        if (cancelFn && !transformSelf._cancelCalled) {
          transformSelf._cancelCalled = true;
          try {
            cancelResult = Reflect.apply(cancelFn, transformerObj, [reason]);
          } catch (e) {
            // Error the writable side with the thrown error
            _errorTransformWritable(transformSelf, e);
            return Promise.reject(e);
          }
        }
        // Defer erroring the writable side to allow controller.error() to fire first
        // (per spec: error() after cancel should take priority if called synchronously)
        queueMicrotask(() => _errorTransformWritable(transformSelf, reason));
        if (cancelResult && typeof cancelResult.then === 'function') {
          return cancelResult;
        }
        return undefined;
      };
    }
    return this.#readable;
  }

  get writable() {
    if (!this.#writable) {
      const nodeTransform = this[kNodeTransform];
      this.#writable = Object.create(FastWritableStream.prototype);
      this.#writable[kNodeWritable] = nodeTransform;
      this.#writable[kLock] = null;
      this.#writable[kState] = 'idle';
      this.#writable[kMaterialized] = null;
      this.#writable[kNativeOnly] = false;

      // Initialize state machine fields for the writable shell
      this.#writable[kWritableState] = 'writable';
      this.#writable[kStoredError] = undefined;
      this.#writable[kPendingAbortRequest] = null;
      this.#writable[kInFlightWriteRequest] = null;
      this.#writable[kInFlightCloseRequest] = null;
      this.#writable[kWriteRequests] = [];
      this.#writable[kCloseRequest] = null;
      // Per spec: kStarted reflects start completion. If start already completed, set true.
      this.#writable[kStarted] = this._startCompleted;
      this.#writable._startPromise = null;
      this.#writable._hwm = nodeTransform.writableHighWaterMark;
      this.#writable._sinkWrite = null;
      this.#writable._sinkClose = null;
      this.#writable._controller = null;
      this.#writable._isTransformShell = true;
      this.#writable._transformReadable = () => this.readable;

      // Wire transformer.cancel as the abort handler for the writable side
      const transformSelf = this;
      if (this._transformerCancel) {
        const cancelFn = this._transformerCancel;
        const transformerObj = this._transformer;
        this.#writable._sinkAbort = (reason) => {
          if (transformSelf._cancelCalled) return undefined;
          transformSelf._cancelCalled = true;
          // Per spec: also error the readable side
          const readable = transformSelf.readable;
          try {
            const result = Reflect.apply(cancelFn, transformerObj, [reason]);
            // Normal path: error readable with abort reason
            if (readable && readable._errored !== true) {
              const ctrl = transformSelf._controller;
              if (ctrl) try { ctrl.error(reason); } catch {}
            }
            return result;
          } catch (e) {
            // Cancel threw: error readable with THROWN error
            if (readable && readable._errored !== true) {
              const ctrl = transformSelf._controller;
              if (ctrl) try { ctrl.error(e); } catch {}
            }
            throw e; // Propagate to abort rejection
          }
        };
        this.#writable._underlyingSink = transformerObj;
      } else {
        this.#writable._sinkAbort = null;
        this.#writable._underlyingSink = {};
      }
    }
    return this.#writable;
  }
}
