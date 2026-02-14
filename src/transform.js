/**
 * FastTransformStream — WHATWG TransformStream API backed by Node.js Transform.
 *
 * The .readable and .writable getters return shell FastReadableStream/FastWritableStream
 * instances that share the same underlying Node Transform (Transform extends Duplex).
 */

import { Transform } from 'node:stream';
import { FastTransformStreamDefaultController } from './controller.js';
import { NativeTransformStream } from './natives.js';
import { _initNativeReadableShell, FastReadableStream } from './readable.js';
import {
  isThenable,
  kLock,
  kMaterialized,
  kNativeOnly,
  kNodeReadable,
  kNodeTransform,
  kNodeWritable,
  kSkipDestroy,
  kStoredError,
  kUpstream,
  kWritableState,
  noop,
  resolveHWM,
  _stats,
} from './utils.js';
import {
  _advanceQueueIfNeeded,
  _initNativeWritableShell,
  _controllerError as _writableControllerError,
  FastWritableStream,
  kCloseRequest,
  kInFlightCloseRequest,
  kInFlightWriteRequest,
  kPendingAbortRequest,
  kStarted,
  kWriteRequests,
} from './writable.js';

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
  // But DON'T clear if we're inside an active transform callback —
  // the callback will fire and should handle the write rejection.
  if (writable._isTransformShell && writable[kInFlightWriteRequest] && !transformSelf._inTransformCallback) {
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
    if (
      (writableStrategy && typeof writableStrategy.size === 'function') ||
      (readableStrategy && typeof readableStrategy.size === 'function')
    ) {
      _stats.nativeOnlyTransform++;
      const native = new NativeTransformStream(transformer, writableStrategy, readableStrategy);
      this[kNodeTransform] = null;
      this.#readable = _initNativeReadableShell(Object.create(FastReadableStream.prototype), native.readable);
      this.#writable = _initNativeWritableShell(Object.create(FastWritableStream.prototype), native.writable);
      return;
    }

    const readableHWM = resolveHWM(readableStrategy, 0);
    const writableHWM = resolveHWM(writableStrategy);
    let controller;
    let startPromise = null;
    const self = this;

    const nodeTransform = new Transform({
      objectMode: true,
      readableHighWaterMark: readableHWM,
      writableHighWaterMark: writableHWM,
      transform(chunk, encoding, callback) {
        const doTransform = () => {
          if (!transform) {
            callback(null, chunk);
            return;
          }
          try {
            const result = Reflect.apply(transform, transformer, [chunk, controller]);
            if (isThenable(result)) {
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
            if (isThenable(result)) {
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
            if (isThenable(result)) {
              result.then(
                () => callback(err),
                () => callback(err),
              );
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
    nodeTransform.on('error', noop);

    controller = new FastTransformStreamDefaultController(nodeTransform);
    controller._setTransformStream(this);

    _stats.transformCreated++;
    this[kNodeTransform] = nodeTransform;

    this._transformerCancel = cancel || null;
    this._transformer = transformer;
    this._cancelCalled = false;
    this._cancelPromise = null;
    this._flushStarted = false;
    this._inTransformCallback = false;
    this._controller = controller;

    // Method for controller.terminate() and controller.error() to error the writable side
    this._errorWritable = (reason) => _errorTransformWritable(this, reason);

    // Track start completion for writable shell's kStarted
    this._startCompleted = false;

    const onStartCompleted = () => {
      startPromise = null;
      self._startCompleted = true;
      // Per spec: after start, update backpressure based on readable desiredSize.
      // If readable has room (desiredSize > 0), clear backpressure to allow writes.
      // Do this BEFORE advancing the queue so write processing sees correct backpressure.
      if (self._controller) {
        self._controller._updateBackpressure();
      }
      // If writable shell was already created, set kStarted and advance queue
      if (self.#writable && !self.#writable[kStarted]) {
        self.#writable[kStarted] = true;
        _advanceQueueIfNeeded(self.#writable);
      }
    };

    if (start) {
      const startResult = Reflect.apply(start, transformer, [controller]);
      if (isThenable(startResult)) {
        startPromise = startResult;
        startResult.then(
          () => {
            queueMicrotask(onStartCompleted);
          },
          (err) => {
            const e = err || new Error('start() failed');
            // Error both sides per spec
            if (self._controller) {
              try {
                self._controller.error(e);
              } catch {}
            }
            if (!nodeTransform.destroyed) nodeTransform.destroy(e);
            queueMicrotask(onStartCompleted);
          },
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
      // Property order must match FastReadableStream constructor for monomorphic hidden class
      this.#readable[kNodeReadable] = transform;
      this.#readable[kLock] = null;
      this.#readable[kMaterialized] = null;
      this.#readable[kUpstream] = null;
      this.#readable[kNativeOnly] = false;
      this.#readable._closed = false;
      this.#readable._errored = false;
      // _cancel and _storedError set below; _onPull set below
      this.#readable._cancel = null; // replaced below
      this.#readable._storedError = undefined;

      // Wire pull notification: clears transform backpressure when reader demands data
      const transformSelf = this;
      this.#readable._onPull = () => {
        if (transformSelf._controller) {
          transformSelf._controller._updateBackpressure();
        }
      };

      // Wire cancel: readable.cancel() → transformer.cancel() + error writable
      this.#readable._cancel = (reason) => {
        // Mark controller as errored (prevents enqueue after cancel)
        if (transformSelf._controller && transformSelf._controller._markErrored) {
          transformSelf._controller._markErrored();
        }

        // If flush is already in progress, skip cancel and don't error writable.
        // Return a special signal to _cancelInternal to NOT destroy the node stream.
        if (transformSelf._flushStarted) {
          return kSkipDestroy;
        }

        // Capture writable error state BEFORE cancel handler runs
        const errorBefore = transformSelf.writable[kStoredError];

        let cancelResult;
        if (cancelFn && !transformSelf._cancelCalled) {
          transformSelf._cancelCalled = true;
          try {
            cancelResult = Reflect.apply(cancelFn, transformerObj, [reason]);
          } catch (e) {
            // Sync throw: error writable immediately
            _errorTransformWritable(transformSelf, e);
            return Promise.reject(e);
          }
        }

        // Capture writable error state AFTER cancel handler ran.
        // Only if the cancel handler CAUSED a new error (e.g., by calling
        // writable.abort()), should we propagate it.
        const errorAfterCancel = transformSelf.writable[kStoredError];
        const cancelCausedError = errorAfterCancel !== errorBefore;

        // Per spec (TransformStreamDefaultSourceCancelAlgorithm step 7):
        // After cancel resolves, if writable is errored due to the cancel handler,
        // throw the writable's stored error.
        const checkWritableError = () => {
          const writable = transformSelf.writable;
          const writableState = writable[kWritableState];
          if (
            cancelCausedError &&
            (writableState === 'errored' || writableState === 'erroring') &&
            writable[kStoredError] !== undefined
          ) {
            throw writable[kStoredError];
          }
          // Error writable with cancel reason if not already errored
          _errorTransformWritable(transformSelf, reason);
        };

        let cancelPromise;
        if (isThenable(cancelResult)) {
          cancelPromise = cancelResult.then(checkWritableError, (e) => {
            _errorTransformWritable(transformSelf, e);
            throw e;
          });
        } else {
          // Sync cancel: defer writable error check to next microtask
          cancelPromise = Promise.resolve().then(checkWritableError);
        }
        transformSelf._cancelPromise = cancelPromise;
        return cancelPromise;
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
      // Store original _transform and install stable dispatch wrapper (avoids per-write monkey-patching)
      this.#writable._origTransform = nodeTransform._transform;
      this.#writable._transformWriteCallback = null;
      const writableShell = this.#writable;
      nodeTransform._transform = function (c, enc, cb) {
        if (writableShell._transformWriteCallback) {
          writableShell._transformWriteCallback(null, null, cb);
        } else {
          writableShell._origTransform.call(this, c, enc, cb);
        }
      };
      this.#writable._transformReadable = () => this.readable;
      this.#writable._transformStream = this;
      this.#writable._transformBackpressure = true;
      this.#writable._transformBackpressureResolve = null;

      // Wire transformer.cancel as the abort handler for the writable side
      const transformSelf = this;
      if (this._transformerCancel) {
        const cancelFn = this._transformerCancel;
        const transformerObj = this._transformer;
        this.#writable._sinkAbort = (reason) => {
          if (transformSelf._cancelCalled) {
            // Cancel already running from readable.cancel() — throw stored error so abort rejects
            const storedError = transformSelf.writable[kStoredError];
            if (storedError !== undefined) throw storedError;
            return undefined;
          }
          transformSelf._cancelCalled = true;
          // Per spec: also error the readable side
          const readable = transformSelf.readable;
          const readableErrorBefore = readable._storedError;
          try {
            const result = Reflect.apply(cancelFn, transformerObj, [reason]);
            // Normal path: error readable with abort reason
            if (readable && readable._errored !== true) {
              const ctrl = transformSelf._controller;
              if (ctrl)
                try {
                  ctrl.error(reason);
                } catch {}
            }
            // For async cancel: after it resolves, check if cancel called controller.error()
            if (isThenable(result)) {
              return result.then(() => {
                if (readable._errored && readable._storedError !== readableErrorBefore) {
                  throw readable._storedError;
                }
              });
            }
            return result;
          } catch (e) {
            // Cancel threw: error readable with THROWN error
            if (readable && readable._errored !== true) {
              const ctrl = transformSelf._controller;
              if (ctrl)
                try {
                  ctrl.error(e);
                } catch {}
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
