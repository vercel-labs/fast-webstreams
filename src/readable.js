/**
 * FastReadableStream — WHATWG ReadableStream API backed by Node.js Readable.
 *
 * Tier 0: pipeTo/pipeThrough between Fast streams → pipeline() internally
 * Tier 1: getReader().read() → sync read from Node buffer
 * Tier 2: tee(), native interop → Readable.toWeb() delegation
 */

import { pipeline, Readable } from 'node:stream';
import { FastReadableStreamBYOBReader } from './byob-reader.js';
import { FastReadableStreamDefaultController } from './controller.js';
import { materializeReadable, materializeWritable } from './materialize.js';
import { NativeReadableStream, NativeWritableStream } from './natives.js';
import { specPipeTo } from './pipe-to.js';
import { FastReadableStreamDefaultReader } from './reader.js';
import {
  isFastReadable,
  isFastTransform,
  isFastWritable,
  isThenable,
  kLock,
  kMaterialized,
  kNativeOnly,
  kNodeReadable,
  kNodeWritable,
  kSkipDestroy,
  kUpstream,
  kWritableState,
  noop,
  RESOLVED_UNDEFINED,
} from './utils.js';

// ReadableStreamAsyncIteratorPrototype — shared by all async iterators
// Per spec: extends AsyncIteratorPrototype, has next() and return() methods on the prototype
const kIterReader = Symbol('kIterReader');
const kIterDone = Symbol('kIterDone');
const kIterPreventCancel = Symbol('kIterPreventCancel');
const kIterOngoing = Symbol('kIterOngoing');

let _readableStreamAsyncIteratorPrototype = null;
function _getAsyncIteratorPrototype() {
  if (!_readableStreamAsyncIteratorPrototype) {
    const asyncIterProto = Object.getPrototypeOf(Object.getPrototypeOf(async function* () {}.prototype));
    _readableStreamAsyncIteratorPrototype = Object.create(asyncIterProto);

    // Helper: chain operation behind ongoing promise
    function chainOperation(iter, op) {
      const ongoing = iter[kIterOngoing];
      iter[kIterOngoing] = ongoing ? ongoing.then(op, op) : op();
      return iter[kIterOngoing];
    }

    // Define methods with correct name, length, and enumerable properties
    async function next() {
      return chainOperation(this, async () => {
        if (this[kIterDone]) return { value: undefined, done: true };
        try {
          const result = await this[kIterReader].read();
          if (result.done) {
            this[kIterDone] = true;
            this[kIterReader].releaseLock();
          }
          return result;
        } catch (e) {
          this[kIterDone] = true;
          this[kIterReader].releaseLock();
          throw e;
        }
      });
    }

    // return needs length = 1, so we use an explicit parameter
    const returnFn = async function (value) {
      return chainOperation(this, async () => {
        if (!this[kIterDone]) {
          this[kIterDone] = true;
          if (!this[kIterPreventCancel]) {
            const cancelResult = this[kIterReader].cancel(value);
            this[kIterReader].releaseLock();
            await cancelResult;
          } else {
            this[kIterReader].releaseLock();
          }
        }
        return { value, done: true };
      });
    };
    Object.defineProperty(returnFn, 'name', { value: 'return' });

    Object.defineProperty(_readableStreamAsyncIteratorPrototype, 'next', {
      value: next,
      writable: true,
      configurable: true,
      enumerable: true,
    });
    Object.defineProperty(_readableStreamAsyncIteratorPrototype, 'return', {
      value: returnFn,
      writable: true,
      configurable: true,
      enumerable: true,
    });
  }
  return _readableStreamAsyncIteratorPrototype;
}

// Brand checks: accept both Fast and native streams
function _isReadableStream(obj) {
  if (obj == null) return false;
  if (typeof obj !== 'object' && typeof obj !== 'function') return false;
  return isFastReadable(obj) || obj instanceof NativeReadableStream;
}

function _isWritableStream(obj) {
  if (obj == null) return false;
  if (typeof obj !== 'object' && typeof obj !== 'function') return false;
  return isFastWritable(obj) || obj instanceof NativeWritableStream;
}

/**
 * Collect the full pipeline chain by walking upstream links.
 * Returns an array of Node.js streams: [source, ...transforms, dest]
 */
function collectPipelineChain(readable, destination) {
  const chain = [];

  // Walk upstream from this readable (build forward, reverse once — O(n) vs O(n²))
  let current = readable;
  while (current) {
    chain.push(current[kNodeReadable]);
    current = current[kUpstream];
  }
  chain.reverse();

  // Add destination
  chain.push(destination[kNodeWritable]);

  return chain;
}

/**
 * Tier 0 fast path: pipe Fast→Fast via Node.js pipeline().
 * Walks upstream links and builds a single pipeline() call.
 */
function fastPipelineTo(source, dest) {
  const chain = collectPipelineChain(source, dest);
  return new Promise((resolve, reject) => {
    pipeline(...chain, (err) => {
      // Sync closed state after pipeline completes
      if (!err) {
        source._closed = true;
        if (kWritableState in dest) {
          dest[kWritableState] = 'closed';
        }
      }
      if (err) reject(err);
      else resolve(undefined);
    });
  });
}

/**
 * Initialize a native-only readable shell (delegates everything to native ReadableStream).
 */
export function _initNativeReadableShell(target, nativeStream) {
  // Property order must match FastReadableStream constructor for monomorphic hidden class
  target[kNodeReadable] = null;
  target[kLock] = null;
  target[kMaterialized] = nativeStream;
  target[kUpstream] = null;
  target[kNativeOnly] = true;
  target._closed = false;
  target._errored = false;
  target._cancel = null;
  target._storedError = undefined;
  target._onPull = null;
  return target;
}

export class FastReadableStream {
  /**
   * Static from() — delegates to native ReadableStream.from()
   * Wraps result in a FastReadableStream shell so .constructor checks pass
   */
  static from(asyncIterable) {
    const native = NativeReadableStream.from(asyncIterable);
    return _initNativeReadableShell(Object.create(FastReadableStream.prototype), native);
  }

  constructor(underlyingSource, strategy) {
    // Per WebIDL: undefined → empty dictionary; null and non-objects → TypeError
    if (underlyingSource === undefined) {
      underlyingSource = {};
    } else if (
      underlyingSource === null ||
      (typeof underlyingSource !== 'object' && typeof underlyingSource !== 'function')
    ) {
      throw new TypeError('underlyingSource must be an object');
    }

    // Access strategy FIRST (IDL layer) before underlying source (method body per spec)
    let strategySize, strategyHWM;
    if (strategy != null && typeof strategy === 'object') {
      strategySize = strategy.size;
      strategyHWM = strategy.highWaterMark;
    }

    // Validate strategy.size
    if (strategySize !== undefined && typeof strategySize !== 'function') {
      throw new TypeError('size must be a function');
    }

    // NOW access underlying source properties (method body per spec)
    const typeRaw = underlyingSource.type;
    const type = typeRaw === undefined ? undefined : String(typeRaw);
    const pull = underlyingSource.pull;
    const start = underlyingSource.start;
    const cancel = underlyingSource.cancel;

    // Validate type
    if (type === 'bytes') {
      _initNativeReadableShell(this, new NativeReadableStream(underlyingSource, strategy));
      return;
    }
    if (type !== undefined) {
      throw new TypeError(`Invalid type: ${type}`);
    }

    // Validate callbacks
    if (cancel !== undefined && typeof cancel !== 'function') {
      throw new TypeError('cancel must be a function');
    }
    if (pull !== undefined && typeof pull !== 'function') {
      throw new TypeError('pull must be a function');
    }
    if (start !== undefined && typeof start !== 'function') {
      throw new TypeError('start must be a function');
    }

    // If strategy has a custom size(), delegate to native
    if (typeof strategySize === 'function') {
      _initNativeReadableShell(this, new NativeReadableStream(underlyingSource, strategy));
      return;
    }

    // Validate and resolve strategy highWaterMark
    const hwm =
      strategyHWM !== undefined
        ? (() => {
            const h = Number(strategyHWM);
            if (Number.isNaN(h) || h < 0) throw new RangeError('Invalid highWaterMark');
            return h;
          })()
        : 1;

    let controller;
    let pullCallback = null;
    let startCompleted = false;

    const nodeReadable = new Readable({
      objectMode: true,
      highWaterMark: hwm === Infinity ? 0x7fffffff : hwm,
      read() {
        // Per spec: pull must not be called until start completes
        if (!startCompleted) {
          // Reset Node's internal reading flag so read(0) works later
          nodeReadable._readableState.reading = false;
          return;
        }
        if (pull) {
          if (pullCallback) return;

          try {
            const result = pull.call(underlyingSource, controller);
            if (isThenable(result)) {
              pullCallback = result;
              result.then(
                () => {
                  pullCallback = null;
                  // Reset reading flag so read(0) re-triggers _read()
                  nodeReadable._readableState.reading = false;
                  if (!nodeReadable.destroyed) nodeReadable.read(0);
                },
                (err) => {
                  pullCallback = null;
                  if (!nodeReadable.destroyed) controller.error(err);
                },
              );
            }
            // For sync pull: don't touch reading flag.
            // Node's internal maybeReadMore handles re-triggering after push.
          } catch (e) {
            if (!nodeReadable.destroyed) controller.error(e);
          }
        }
      },
    });

    // Prevent unhandled 'error' events from crashing
    nodeReadable.on('error', noop);

    controller = new FastReadableStreamDefaultController(nodeReadable, hwm);
    controller._stream = this;

    this[kNodeReadable] = nodeReadable;
    this[kLock] = null;
    this[kMaterialized] = null;
    this[kUpstream] = null;
    this[kNativeOnly] = false;
    this._closed = false;
    this._errored = false;
    this._cancel = cancel;
    this._storedError = undefined;
    this._onPull = null;

    if (start) {
      const startResult = start.call(underlyingSource, controller);
      if (isThenable(startResult)) {
        startResult.then(
          () => {
            startCompleted = true;
            if (pull && !nodeReadable.destroyed && hwm > 0) {
              nodeReadable.read(0);
            }
          },
          (err) => {
            controller.error(err);
          },
        );
      } else {
        // Sync start — per spec, start "completes" via microtask
        queueMicrotask(() => {
          startCompleted = true;
          if (pull && !nodeReadable.destroyed && hwm > 0) {
            nodeReadable.read(0);
          }
        });
      }
    } else {
      // No start — per spec, start completes via resolved promise's .then()
      queueMicrotask(() => {
        startCompleted = true;
        if (pull && !nodeReadable.destroyed && hwm > 0) {
          nodeReadable.read(0);
        }
      });
    }
  }

  /**
   * pipeTo(destination, options) — returns Promise<void>
   *
   * Three-tier routing:
   *   Tier 0: kNativeOnly → delegate to native pipeTo (C++ speed)
   *   Tier 1: Fast→Fast, no options → Node.js pipeline() (zero-promise fast path)
   *   Tier 2: Mixed/options → specPipeTo (full WHATWG compliance)
   */
  pipeTo(destination, options) {
    try {
      // Brand check: must have internal state (not just Object.create(prototype))
      if (!(kNodeReadable in this) && !(kMaterialized in this)) {
        throw new TypeError('pipeTo called on non-ReadableStream');
      }
      // Validate destination
      if (!_isWritableStream(destination)) {
        throw new TypeError('pipeTo destination must be a WritableStream');
      }

      // Access option getters in spec order (alphabetical per Web IDL)
      let preventAbort = false,
        preventCancel = false,
        preventClose = false,
        signal;
      if (options !== undefined && options !== null) {
        if (typeof options !== 'object' && typeof options !== 'function') {
          throw new TypeError('options must be an object');
        }
        preventAbort = !!options.preventAbort;
        preventCancel = !!options.preventCancel;
        preventClose = !!options.preventClose;
        signal = options.signal;
      }

      if (signal !== undefined) {
        try {
          if (signal === null || typeof signal !== 'object' || typeof signal.aborted !== 'boolean') {
            throw new TypeError('options.signal must be an AbortSignal');
          }
        } catch {
          throw new TypeError('options.signal must be an AbortSignal');
        }
      }

      // Tier 0: kNativeOnly source → delegate to native pipeTo (C++ speed)
      if (this[kNativeOnly]) {
        const nativeSrc = materializeReadable(this);
        const nativeDst = isFastWritable(destination) ? materializeWritable(destination) : destination;
        return nativeSrc.pipeTo(nativeDst, { preventAbort, preventCancel, preventClose, signal });
      }

      if (this[kLock]) {
        return Promise.reject(new TypeError('ReadableStream is locked'));
      }
      if (destination.locked) {
        return Promise.reject(new TypeError('WritableStream is locked'));
      }

      // Tier 1: pipeThrough chain with upstream links → pipeline()
      // Only when kUpstream is set (from pipeThrough Tier 1 linking).
      const isDefaultOpts = !preventAbort && !preventCancel && !preventClose && !signal;
      if (
        isDefaultOpts &&
        this[kUpstream] &&
        isFastWritable(destination) &&
        !destination[kNativeOnly] &&
        destination[kNodeWritable]
      ) {
        return fastPipelineTo(this, destination);
      }

      // Tier 2: Spec-compliant
      return specPipeTo(this, destination, { preventAbort, preventCancel, preventClose, signal });
    } catch (e) {
      return Promise.reject(e);
    }
  }

  /**
   * pipeThrough(transform, options) — returns ReadableStream
   *
   * Three-tier routing:
   *   Tier 0: kNativeOnly → delegate to native pipeThrough, wrap result
   *   Tier 1: FastTransform, default options → upstream linking (deferred pipe)
   *   Tier 2: Mixed/options → specPipeTo (full WHATWG compliance)
   */
  pipeThrough(transform, options) {
    if (
      transform === null ||
      transform === undefined ||
      (typeof transform !== 'object' && typeof transform !== 'function')
    ) {
      throw new TypeError('transform must be an object');
    }

    // Per spec: access readable BEFORE writable
    const readable = transform.readable;
    if (!_isReadableStream(readable)) {
      throw new TypeError('transform.readable must be a ReadableStream');
    }

    const writable = transform.writable;
    if (!_isWritableStream(writable)) {
      throw new TypeError('transform.writable must be a WritableStream');
    }

    if (this[kLock]) {
      throw new TypeError('ReadableStream is locked');
    }

    if (writable.locked) {
      throw new TypeError('WritableStream is locked');
    }

    // Eagerly access option getters per Web IDL (alphabetical order)
    let preventAbort = false,
      preventCancel = false,
      preventClose = false,
      signal;
    if (options !== undefined && options !== null && (typeof options === 'object' || typeof options === 'function')) {
      preventAbort = !!options.preventAbort;
      preventCancel = !!options.preventCancel;
      preventClose = !!options.preventClose;
      signal = options.signal;
    }

    if (signal !== undefined) {
      try {
        if (signal === null || typeof signal !== 'object' || typeof signal.aborted !== 'boolean') {
          throw new TypeError('options.signal must be an AbortSignal');
        }
      } catch {
        throw new TypeError('options.signal must be an AbortSignal');
      }
    }

    // Tier 0: kNativeOnly source → delegate to native pipeThrough
    if (this[kNativeOnly]) {
      const nativeSrc = materializeReadable(this);
      const nativeDst = isFastWritable(writable) ? materializeWritable(writable) : writable;
      const nativeRd = isFastReadable(readable) ? materializeReadable(readable) : readable;
      nativeSrc.pipeThrough(
        { writable: nativeDst, readable: nativeRd },
        { preventAbort, preventCancel, preventClose, signal },
      );
      // Return the original readable (Fast shell or native) — the pipe is running
      return readable;
    }

    // Tier 1: FastTransform, default options → upstream linking (deferred pipe)
    const isDefaultOpts = !preventAbort && !preventCancel && !preventClose && !signal;
    if (isDefaultOpts && isFastTransform(transform)) {
      readable[kUpstream] = this;
      return readable;
    }

    // Tier 2: Spec-compliant — use internal pipeTo (not this.pipeTo) per spec
    const pipePromise = specPipeTo(this, writable, {
      preventAbort,
      preventCancel,
      preventClose,
      signal,
    });
    // Mark as handled (spec: set [[PromiseIsHandled]] to true)
    pipePromise.catch(noop);

    return readable;
  }

  /**
   * getReader(options) — returns a reader
   *
   * Tier 1: Default reader (sync fast path)
   * Tier 2: BYOB mode → delegate to native
   */
  getReader(options) {
    if (options !== undefined && options !== null && typeof options !== 'object') {
      throw new TypeError('options must be an object');
    }
    const mode = options ? (options.mode === undefined ? undefined : String(options.mode)) : undefined;
    if (mode === 'byob') {
      // Tier 2: BYOB requires native byte stream support
      // Use FastReadableStreamBYOBReader so constructor checks work with FastReadableStream
      return new FastReadableStreamBYOBReader(this);
    }
    if (mode !== undefined) {
      throw new TypeError(`Invalid mode: ${mode}`);
    }

    // For native-only streams (byte, custom size), delegate reader too
    if (this[kNativeOnly]) {
      return materializeReadable(this).getReader();
    }

    return new FastReadableStreamDefaultReader(this);
  }

  /**
   * tee() — Pure JS implementation of ReadableStreamDefaultTee
   * Preserves error identity and cancel reason aggregation.
   */
  tee() {
    if (this[kLock]) {
      throw new TypeError('ReadableStream is locked');
    }

    // For native-only streams, delegate
    if (this[kNativeOnly]) {
      const [b1, b2] = materializeReadable(this).tee();
      return [
        _initNativeReadableShell(Object.create(FastReadableStream.prototype), b1),
        _initNativeReadableShell(Object.create(FastReadableStream.prototype), b2),
      ];
    }

    const reader = this.getReader();
    let canceled1 = false;
    let canceled2 = false;
    let reason1, reason2;
    let branch1Controller, branch2Controller;
    let cancelResolve;
    const cancelPromise = new Promise((resolve) => {
      cancelResolve = resolve;
    });

    function cancel1Algorithm(reason) {
      canceled1 = true;
      reason1 = reason;
      if (canceled2) {
        const compositeReason = [reason1, reason2];
        const cancelResult = reader.cancel(compositeReason);
        cancelResolve(cancelResult);
      }
      return cancelPromise;
    }

    function cancel2Algorithm(reason) {
      canceled2 = true;
      reason2 = reason;
      if (canceled1) {
        const compositeReason = [reason1, reason2];
        const cancelResult = reader.cancel(compositeReason);
        cancelResolve(cancelResult);
      }
      return cancelPromise;
    }

    const branch1 = new FastReadableStream(
      {
        start(c) {
          branch1Controller = c;
        },
        pull() {
          return readLoop();
        },
        cancel(reason) {
          return cancel1Algorithm(reason);
        },
      },
      { highWaterMark: 0 },
    );

    const branch2 = new FastReadableStream(
      {
        start(c) {
          branch2Controller = c;
        },
        pull() {
          return readLoop();
        },
        cancel(reason) {
          return cancel2Algorithm(reason);
        },
      },
      { highWaterMark: 0 },
    );

    let reading = false;
    function readLoop() {
      if (reading) return RESOLVED_UNDEFINED;
      reading = true;
      return reader.read().then(
        ({ value, done }) => {
          reading = false;
          if (done) {
            try {
              if (!canceled1 && branch1Controller) branch1Controller.close();
            } catch {}
            try {
              if (!canceled2 && branch2Controller) branch2Controller.close();
            } catch {}
            // Resolve any pending cancel promise (source is done)
            cancelResolve(undefined);
            return;
          }
          try {
            if (!canceled1 && branch1Controller) branch1Controller.enqueue(value);
          } catch {}
          try {
            if (!canceled2 && branch2Controller) branch2Controller.enqueue(value);
          } catch {}
        },
        (r) => {
          reading = false;
          try {
            if (!canceled1 && branch1Controller) branch1Controller.error(r);
          } catch {}
          try {
            if (!canceled2 && branch2Controller) branch2Controller.error(r);
          } catch {}
          // Resolve any pending cancel promise (source errored)
          cancelResolve(undefined);
        },
      );
    }

    // Propagate source close/errors to both branches
    reader.closed.then(
      () => {
        // Source closed — close both branches
        try {
          if (!canceled1 && branch1Controller) branch1Controller.close();
        } catch {}
        try {
          if (!canceled2 && branch2Controller) branch2Controller.close();
        } catch {}
        cancelResolve(undefined);
      },
      (r) => {
        // Source errored — error both branches
        try {
          if (!canceled1 && branch1Controller) branch1Controller.error(r);
        } catch {}
        try {
          if (!canceled2 && branch2Controller) branch2Controller.error(r);
        } catch {}
        cancelResolve(undefined);
      },
    );

    return [branch1, branch2];
  }

  /**
   * Internal cancel — bypasses lock check (called by reader.cancel())
   */
  _cancelInternal(reason) {
    // For native-only streams, delegate
    if (this[kNativeOnly]) {
      return materializeReadable(this).cancel(reason);
    }

    // Per spec: if errored, reject immediately
    if (this._errored) {
      return Promise.reject(this._storedError);
    }
    // Per spec: if already closed, resolve immediately
    if (this._closed) {
      return Promise.resolve(undefined);
    }

    // Per spec: set state to "closed" synchronously BEFORE calling cancel
    this._closed = true;

    // Per spec: resolve reader's closedPromise synchronously
    const reader = this[kLock];
    if (reader && reader._resolveClosedFromCancel) {
      reader._resolveClosedFromCancel();
    }

    // Call underlyingSource.cancel and return its result
    let cancelResult;
    try {
      cancelResult = this._cancel ? this._cancel(reason) : undefined;
    } catch (e) {
      if (this[kNodeReadable] && !this[kNodeReadable].destroyed) {
        this[kNodeReadable].destroy(null);
      }
      return Promise.reject(e);
    }
    // Skip destroy if cancel handler signals not to (e.g., transform during flush)
    if (cancelResult !== kSkipDestroy) {
      if (this[kNodeReadable] && !this[kNodeReadable].destroyed) {
        this[kNodeReadable].destroy(null);
      }
    }
    const resolvedResult = cancelResult === kSkipDestroy ? undefined : cancelResult;
    return Promise.resolve(resolvedResult).then(() => undefined);
  }

  /**
   * cancel(reason) — public API, checks lock
   */
  cancel(reason) {
    if (this[kLock]) {
      return Promise.reject(new TypeError('ReadableStream is locked'));
    }
    return this._cancelInternal(reason);
  }

  get locked() {
    if (this[kNativeOnly] && this[kMaterialized]) return this[kMaterialized].locked;
    return this[kLock] !== null;
  }

  // Async iteration support — uses our reader for proper cancel wiring
  values(options) {
    const preventCancel = !!(options && options.preventCancel);
    const reader = this.getReader();

    const iterator = Object.create(_getAsyncIteratorPrototype());
    iterator[kIterReader] = reader;
    iterator[kIterDone] = false;
    iterator[kIterPreventCancel] = preventCancel;
    iterator[kIterOngoing] = null;

    return iterator;
  }

  [Symbol.asyncIterator](options) {
    return this.values(options);
  }
}
