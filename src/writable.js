/**
 * FastWritableStream — WHATWG WritableStream API backed by Node.js Writable.
 *
 * Implements the full writable → erroring → errored state machine per spec.
 */

import { Writable } from 'node:stream';
import {
  kNodeWritable, kState, kLock, kMaterialized, kNativeOnly, resolveHWM,
} from './utils.js';
import { FastWritableStreamDefaultController, kWrappedError, kControllerBrand } from './controller.js';
import { FastWritableStreamDefaultWriter } from './writer.js';
import { materializeWritable } from './materialize.js';

/**
 * Internal state symbols for the writable state machine.
 */
export const kWritableState = Symbol('kWritableState');
export const kStoredError = Symbol('kStoredError');
export const kPendingAbortRequest = Symbol('kPendingAbortRequest');
export const kInFlightWriteRequest = Symbol('kInFlightWriteRequest');
export const kInFlightCloseRequest = Symbol('kInFlightCloseRequest');
export const kWriteRequests = Symbol('kWriteRequests');
export const kCloseRequest = Symbol('kCloseRequest');
export const kStarted = Symbol('kStarted');

export class FastWritableStream {
  constructor(underlyingSink = {}, strategy) {
    if (underlyingSink === null) {
      underlyingSink = {};
    }

    // Access strategy FIRST per spec
    let strategySize, strategyHWM;
    if (strategy != null && typeof strategy === 'object') {
      strategySize = strategy.size;
      strategyHWM = strategy.highWaterMark;
    }

    const write = underlyingSink.write;
    const close = underlyingSink.close;
    const abort = underlyingSink.abort;
    const start = underlyingSink.start;
    const type = underlyingSink.type;

    if (type !== undefined) {
      throw new RangeError(`Invalid type: ${type}`);
    }

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

    if (strategySize !== undefined && typeof strategySize !== 'function') {
      throw new TypeError('size must be a function');
    }

    // If strategy has a custom size(), delegate to native
    if (typeof strategySize === 'function') {
      const native = new WritableStream(underlyingSink, strategy);
      this[kNodeWritable] = null;
      this[kMaterialized] = native;
      this[kLock] = null;
      this[kState] = 'idle';
      this[kNativeOnly] = true;
      return;
    }

    let hwm = 1;
    if (strategyHWM !== undefined) {
      hwm = Number(strategyHWM);
      if (Number.isNaN(hwm) || hwm < 0) {
        throw new RangeError('Invalid highWaterMark');
      }
    }

    // --- State machine ---
    this[kWritableState] = 'writable';
    this[kStoredError] = undefined;
    this[kPendingAbortRequest] = null;
    this[kInFlightWriteRequest] = null;
    this[kInFlightCloseRequest] = null;
    this[kWriteRequests] = [];
    this[kCloseRequest] = null;
    this[kStarted] = false;

    const self = this;
    let controller;

    const nodeWritable = new Writable({
      objectMode: true,
      highWaterMark: hwm === Infinity ? 0x7FFFFFFF : hwm,
      write(chunk, encoding, callback) {
        if (!write) {
          callback();
          return;
        }
        try {
          const result = Reflect.apply(write, underlyingSink, [chunk, controller]);
          if (result && typeof result.then === 'function') {
            result.then(() => callback(), callback);
          } else {
            callback();
          }
        } catch (e) {
          callback(e);
        }
      },
      final(callback) {
        if (!close) {
          callback();
          return;
        }
        try {
          const result = Reflect.apply(close, underlyingSink, []);
          if (result && typeof result.then === 'function') {
            result.then(() => callback(), callback);
          } else {
            callback();
          }
        } catch (e) {
          callback(e);
        }
      },
      destroy(err, callback) {
        callback(err);
      },
    });

    // Prevent unhandled 'error' events from crashing
    nodeWritable.on('error', () => {});

    controller = new FastWritableStreamDefaultController(nodeWritable, self, _controllerError, kControllerBrand);

    this[kNodeWritable] = nodeWritable;
    this[kLock] = null;
    this[kState] = 'idle';
    this[kMaterialized] = null;
    this[kNativeOnly] = false;
    this._controller = controller;
    this._underlyingSink = underlyingSink;
    this._sinkAbort = abort || null;
    this._sinkWrite = write || null;
    this._sinkClose = close || null;
    this._hwm = hwm;

    // Start
    let startResult;
    if (start) {
      try {
        startResult = Reflect.apply(start, underlyingSink, [controller]);
      } catch (e) {
        throw e;
      }
    }

    // Per spec: even for sync start, kStarted is set via a microtask
    // (the resolved promise's .then handler). This ensures writes queued
    // synchronously after construction don't dispatch until start "completes".
    const startPromiseResolved = startResult && typeof startResult.then === 'function'
      ? Promise.resolve(startResult)
      : Promise.resolve(undefined);

    this._startPromise = startPromiseResolved;
    startPromiseResolved.then(
      () => {
        self[kStarted] = true;
        self._startPromise = null;
        _advanceQueueIfNeeded(self);
      },
      (err) => {
        self[kStarted] = true;
        self._startPromise = null;
        _dealWithRejection(self, err);
      }
    );
  }

  getWriter() {
    if (this[kNativeOnly]) {
      return materializeWritable(this).getWriter();
    }
    return new FastWritableStreamDefaultWriter(this);
  }

  abort(reason) {
    if (this[kLock]) {
      return Promise.reject(new TypeError('WritableStream is locked'));
    }
    return _abortInternal(this, reason);
  }

  _abortInternal(reason) {
    return _abortInternal(this, reason);
  }

  close() {
    if (this[kLock]) {
      return Promise.reject(new TypeError('WritableStream is locked'));
    }
    if (this[kNativeOnly]) {
      return materializeWritable(this).close();
    }
    if (!_isCloseAllowed(this)) {
      return Promise.reject(new TypeError('Cannot close stream'));
    }
    return _closeInternal(this);
  }

  get locked() {
    return this[kLock] !== null;
  }
}

// --- Internal algorithms ---

function _isCloseAllowed(stream) {
  const state = stream[kWritableState];
  if (state === 'closed' || state === 'errored') return false;
  if (stream[kCloseRequest] || stream[kInFlightCloseRequest]) return false;
  return true;
}

function _closeInternal(stream) {
  return new Promise((resolve, reject) => {
    stream[kCloseRequest] = { resolve, reject };
    // Per spec: only resolve ready if state is 'writable' (not erroring)
    const writer = stream[kLock];
    if (writer && writer._resolveReady && stream[kWritableState] === 'writable') {
      writer._resolveReady();
    }
    _advanceQueueIfNeeded(stream);
  });
}

export function _abortInternal(stream, reason) {
  if (stream[kNativeOnly]) {
    return materializeWritable(stream).abort(reason);
  }

  const state = stream[kWritableState];

  // If already closed or errored, no-op
  if (state === 'closed' || state === 'errored') {
    return Promise.resolve(undefined);
  }

  // Abort the controller's signal synchronously (spec requirement)
  if (stream._controller && stream._controller._abortSignal) {
    stream._controller._abortSignal(reason);
  }

  // If already erroring, store abort without calling sink.abort()
  if (state === 'erroring') {
    if (stream[kPendingAbortRequest]) {
      return stream[kPendingAbortRequest].promise;
    }
    const p = {};
    p.promise = new Promise((resolve, reject) => {
      p.resolve = resolve;
      p.reject = reject;
    });
    p.reason = reason;
    p.wasAlreadyErroring = true;
    stream[kPendingAbortRequest] = p;
    return p.promise;
  }

  // If there's already a pending abort (from writable state), return same promise
  if (stream[kPendingAbortRequest]) {
    return stream[kPendingAbortRequest].promise;
  }

  const p = {};
  p.promise = new Promise((resolve, reject) => {
    p.resolve = resolve;
    p.reject = reject;
  });
  p.reason = reason;
  p.wasAlreadyErroring = false;
  stream[kPendingAbortRequest] = p;

  // Transition to erroring
  _startErroring(stream, reason);

  return p.promise;
}

function _startErroring(stream, reason) {
  const state = stream[kWritableState];
  if (state !== 'writable') return;

  stream[kWritableState] = 'erroring';
  stream[kStoredError] = reason;

  // Reject ready promise for writer
  const writer = stream[kLock];
  if (writer) {
    writer._rejectReadyIfPending(reason);
  }

  // If no in-flight operations and stream is started, finish erroring
  if (!_hasOperationMarkedInFlight(stream) && stream[kStarted]) {
    _finishErroring(stream);
  }
}

function _hasOperationMarkedInFlight(stream) {
  return stream[kInFlightWriteRequest] !== null || stream[kInFlightCloseRequest] !== null;
}

function _finishErroring(stream) {
  stream[kWritableState] = 'errored';
  const storedError = stream[kStoredError];

  // For transform shells, destroy the node stream to propagate error to readable side
  if (stream._isTransformShell && stream[kNodeWritable] && !stream[kNodeWritable].destroyed) {
    stream[kNodeWritable].destroy(storedError instanceof Error ? storedError :
      (storedError != null ? Object.assign(new Error('abort'), { [kWrappedError]: storedError }) : new Error('aborted')));
  }

  // Reject all queued writes
  const writeRequests = stream[kWriteRequests];
  stream[kWriteRequests] = [];
  for (const req of writeRequests) {
    req.reject(storedError);
  }

  const abortRequest = stream[kPendingAbortRequest];
  if (!abortRequest) {
    // No abort — reject close and closed immediately
    _rejectCloseAndClosedPromiseIfNeeded(stream, storedError);
    return;
  }

  stream[kPendingAbortRequest] = null;

  if (abortRequest.wasAlreadyErroring) {
    abortRequest.reject(storedError);
    _rejectCloseAndClosedPromiseIfNeeded(stream, storedError);
    return;
  }

  // Call underlying sink abort
  const sinkAbort = stream._sinkAbort;
  if (!sinkAbort) {
    abortRequest.resolve();
    _rejectCloseAndClosedPromiseIfNeeded(stream, storedError);
    return;
  }

  try {
    const result = Reflect.apply(sinkAbort, stream._underlyingSink, [abortRequest.reason]);
    if (result && typeof result.then === 'function') {
      result.then(
        () => {
          abortRequest.resolve();
          _rejectCloseAndClosedPromiseIfNeeded(stream, storedError);
        },
        (e) => {
          abortRequest.reject(e);
          _rejectCloseAndClosedPromiseIfNeeded(stream, storedError);
        }
      );
    } else {
      abortRequest.resolve();
      _rejectCloseAndClosedPromiseIfNeeded(stream, storedError);
    }
  } catch (e) {
    abortRequest.reject(e);
    _rejectCloseAndClosedPromiseIfNeeded(stream, storedError);
  }
}

/**
 * Per spec: WritableStreamRejectCloseAndClosedPromiseIfNeeded
 * Reject close request and writer.closed AFTER abort handling.
 */
function _rejectCloseAndClosedPromiseIfNeeded(stream, storedError) {
  if (stream[kCloseRequest]) {
    stream[kCloseRequest].reject(storedError);
    stream[kCloseRequest] = null;
  }
  const writer = stream[kLock];
  if (writer) {
    writer._rejectClosed(storedError);
  }
}

function _advanceQueueIfNeeded(stream) {
  if (!stream[kStarted]) return;
  const state = stream[kWritableState];
  if (state === 'errored' || state === 'closed') return;
  if (state === 'erroring') {
    // Per spec: only finish erroring when no in-flight operations
    if (!_hasOperationMarkedInFlight(stream)) {
      _finishErroring(stream);
    }
    return;
  }

  // When start just completed, resolve the writer's ready if no backpressure
  const writer = stream[kLock];
  if (writer) {
    writer._updateReadyForBackpressure(stream);
  }

  // If close request and no writes pending and no in-flight write
  if (stream[kWriteRequests].length === 0 && stream[kCloseRequest] && !stream[kInFlightWriteRequest]) {
    _processClose(stream);
    return;
  }

  // Process next write
  if (stream[kWriteRequests].length > 0 && !stream[kInFlightWriteRequest]) {
    _processWrite(stream);
  }
}

function _processWrite(stream) {
  const writeRequest = stream[kWriteRequests].shift();
  stream[kInFlightWriteRequest] = writeRequest;

  const nodeWritable = stream[kNodeWritable];
  const chunk = writeRequest.chunk;

  // For transform shells, the write callback from Node may not fire reliably
  // due to readable-side backpressure. Use a different approach.
  if (stream._isTransformShell) {
    _processWriteTransform(stream, writeRequest, nodeWritable, chunk);
    return;
  }

  const ok = nodeWritable.write(chunk, (err) => {
    stream[kInFlightWriteRequest] = null;
    if (err) {
      const unwrapped = _unwrapError(err);
      writeRequest.reject(unwrapped);
      _handleWriteError(stream, unwrapped);
    } else {
      writeRequest.resolve(undefined);
      const writer = stream[kLock];
      if (writer && stream[kWritableState] === 'writable') {
        writer._updateReadyForBackpressure(stream);
      }
      _advanceQueueIfNeeded(stream);
    }
  });

  // If Node buffer is full, update ready promise for backpressure
  if (!ok) {
    const writer = stream[kLock];
    if (writer && stream[kWritableState] === 'writable') {
      writer._setReadyPending(stream);
    }
  }
}

/**
 * Write processing for transform shells. Since Node Transform's write() callback
 * can be delayed by readable-side backpressure, we use the internal _write mechanism.
 */
function _processWriteTransform(stream, writeRequest, nodeWritable, chunk) {
  // For transforms, we hook into the Node internal callback mechanism.
  // The transform's _transform function gets called synchronously by write(),
  // and its callback signals completion. We'll intercept via a one-time wrapper.
  const origTransform = nodeWritable._transform;

  nodeWritable._transform = function(c, enc, cb) {
    // Restore original transform
    nodeWritable._transform = origTransform;

    // Call original, preserving the data argument (callback(null, data) === push + callback)
    origTransform.call(this, c, enc, (err, data) => {
      // Pass through to Node's internal callback (including optional data to push)
      cb(err, data);

      // Defer state machine update to match spec timing.
      // In the spec, transform completion fires asynchronously.
      // Without this, desiredSize returns to HWM immediately.
      queueMicrotask(() => {
        stream[kInFlightWriteRequest] = null;
        if (err) {
          const unwrapped = _unwrapError(err);
          writeRequest.reject(unwrapped);
          _handleWriteError(stream, unwrapped);
        } else {
          writeRequest.resolve(undefined);
          const writer = stream[kLock];
          if (writer && stream[kWritableState] === 'writable') {
            writer._updateReadyForBackpressure(stream);
          }
          _advanceQueueIfNeeded(stream);
        }
      });
    });
  };

  nodeWritable.write(chunk);
}

function _handleWriteError(stream, error) {
  const state = stream[kWritableState];
  if (state === 'writable') {
    _startErroring(stream, error);
  } else if (state === 'erroring') {
    _finishErroring(stream);
  }
}

/**
 * Called when a write or close error needs to also reject the ready promise.
 */
function _errorReadyForWriter(stream, error) {
  const writer = stream[kLock];
  if (writer) {
    writer._rejectReady(error);
  }
}

function _processClose(stream) {
  const closeRequest = stream[kCloseRequest];
  stream[kCloseRequest] = null;
  stream[kInFlightCloseRequest] = closeRequest;

  const nodeWritable = stream[kNodeWritable];

  // For transform shells, use 'finish' event since end() callback may not fire
  if (stream._isTransformShell) {
    const onFinish = () => {
      cleanup();
      _handleCloseSuccess(stream, closeRequest);
    };
    const onError = (err) => {
      cleanup();
      stream[kInFlightCloseRequest] = null;
      const unwrapped = _unwrapError(err);
      closeRequest.reject(unwrapped);
      _handleCloseError(stream, unwrapped);
    };
    const cleanup = () => {
      nodeWritable.removeListener('finish', onFinish);
      nodeWritable.removeListener('error', onError);
    };
    nodeWritable.on('finish', onFinish);
    nodeWritable.on('error', onError);
    nodeWritable.end();
    return;
  }

  nodeWritable.end((err) => {
    stream[kInFlightCloseRequest] = null;
    if (err) {
      const unwrapped = _unwrapError(err);
      closeRequest.reject(unwrapped);
      _handleCloseError(stream, unwrapped);
    } else {
      _handleCloseSuccess(stream, closeRequest);
    }
  });
}

function _handleCloseSuccess(stream, closeRequest) {
  stream[kInFlightCloseRequest] = null;
  closeRequest.resolve(undefined);

  const abortRequest = stream[kPendingAbortRequest];
  if (abortRequest) {
    stream[kPendingAbortRequest] = null;
    abortRequest.resolve();
  }

  stream[kWritableState] = 'closed';

  // For transform shells: after close succeeds, the transform's flush has completed
  // and push(null) was called on the readable side. Call resume() to trigger 'end'.
  if (stream._isTransformShell && stream[kNodeWritable]) {
    const nodeTransform = stream[kNodeWritable];
    if (nodeTransform.readableLength === 0 && !nodeTransform.readableEnded) {
      nodeTransform.resume();
    }
  }

  const writer = stream[kLock];
  if (writer) {
    writer._resolveClosed();
  }
}

function _handleCloseError(stream, error) {
  const abortRequest = stream[kPendingAbortRequest];

  if (abortRequest) {
    stream[kPendingAbortRequest] = null;
    abortRequest.reject(error);
  }

  stream[kWritableState] = 'errored';
  stream[kStoredError] = error;

  const writer = stream[kLock];
  if (writer) {
    writer._rejectReady(error);
    // Per spec: when abort is pending, closed rejects with abort reason
    writer._rejectClosed(abortRequest ? abortRequest.reason : error);
  }
}

function _dealWithRejection(stream, error) {
  const state = stream[kWritableState];
  if (state === 'writable') {
    _startErroring(stream, error);
  } else {
    _finishErroring(stream);
  }
}

function _unwrapError(err) {
  if (err && typeof err === 'object' && kWrappedError in err) {
    return err[kWrappedError];
  }
  return err;
}

/**
 * Called by the controller when controller.error() is invoked.
 */
export function _controllerError(stream, error) {
  const state = stream[kWritableState];
  if (state !== 'writable') return;
  _startErroring(stream, error);
}

/**
 * Called by the writer to enqueue a write.
 */
export function _writeInternal(stream, chunk) {
  const state = stream[kWritableState];

  if (state === 'erroring' || state === 'errored') {
    return Promise.reject(stream[kStoredError]);
  }

  if (state === 'closed') {
    return Promise.reject(new TypeError('Cannot write to a closed stream'));
  }

  if (stream[kCloseRequest] || stream[kInFlightCloseRequest]) {
    return Promise.reject(new TypeError('Cannot write to a closing stream'));
  }

  return new Promise((resolve, reject) => {
    stream[kWriteRequests].push({ resolve, reject, chunk });
    const writer = stream[kLock];
    if (writer && stream[kWritableState] === 'writable') {
      writer._updateReadyForBackpressure(stream);
    }
    _advanceQueueIfNeeded(stream);
  });
}

/**
 * Called by the writer to close the stream.
 */
export function _closeFromWriter(stream) {
  const state = stream[kWritableState];

  if (state === 'closed' || state === 'errored') {
    return Promise.reject(new TypeError('Cannot close stream'));
  }

  // Per spec: check close queued/in-flight BEFORE erroring state
  if (stream[kCloseRequest] || stream[kInFlightCloseRequest]) {
    return Promise.reject(new TypeError('Cannot close an already-closing stream'));
  }

  // Per spec: state is 'writable' or 'erroring' — proceed with close.
  // Close will be rejected later by _finishErroring if erroring.
  return _closeInternal(stream);
}

/**
 * Get the desiredSize for the stream.
 */
export function _getDesiredSize(stream) {
  const state = stream[kWritableState];
  if (state === 'errored' || state === 'erroring') return null;
  if (state === 'closed') return 0;
  if (stream._hwm === Infinity) return Infinity;

  // Use state-machine formula for all streams (including transform shells)
  return stream._hwm - stream[kWriteRequests].length - (stream[kInFlightWriteRequest] ? 1 : 0);
}
