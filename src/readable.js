/**
 * FastReadableStream — WHATWG ReadableStream API backed by Node.js Readable.
 *
 * Tier 0: pipeTo/pipeThrough between Fast streams → pipeline() internally
 * Tier 1: getReader().read() → sync read from Node buffer
 * Tier 2: tee(), native interop → Readable.toWeb() delegation
 */

import { Readable, pipeline } from 'node:stream';
import {
  kNodeReadable, kNodeWritable, kState, kLock, kMaterialized, kUpstream,
  isFastReadable, isFastWritable, isFastTransform, resolveHWM, kNativeOnly,
} from './utils.js';
import { FastReadableStreamDefaultController } from './controller.js';
import { FastReadableStreamDefaultReader } from './reader.js';
import { materializeReadable, materializeWritable } from './materialize.js';
import { specPipeTo } from './pipe-to.js';

// ReadableStreamAsyncIteratorPrototype — shared by all async iterators
// Per spec: extends AsyncIteratorPrototype, has next() and return() methods on the prototype
const kIterReader = Symbol('kIterReader');
const kIterDone = Symbol('kIterDone');
const kIterPreventCancel = Symbol('kIterPreventCancel');

let _readableStreamAsyncIteratorPrototype = null;
function _getAsyncIteratorPrototype() {
  if (!_readableStreamAsyncIteratorPrototype) {
    const asyncIterProto = Object.getPrototypeOf(Object.getPrototypeOf(
      (async function* () {}).prototype
    ));
    _readableStreamAsyncIteratorPrototype = Object.create(asyncIterProto);

    // Define methods with correct name, length, and enumerable properties
    async function next() {
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
    }

    // return needs length = 1, so we use an explicit parameter
    const returnFn = async function(value) {
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
    };
    Object.defineProperty(returnFn, 'name', { value: 'return' });

    Object.defineProperty(_readableStreamAsyncIteratorPrototype, 'next', {
      value: next, writable: true, configurable: true, enumerable: true,
    });
    Object.defineProperty(_readableStreamAsyncIteratorPrototype, 'return', {
      value: returnFn, writable: true, configurable: true, enumerable: true,
    });
  }
  return _readableStreamAsyncIteratorPrototype;
}

// Brand checks: accept both Fast and native streams
function _isReadableStream(obj) {
  if (obj == null) return false;
  if (typeof obj !== 'object' && typeof obj !== 'function') return false;
  return isFastReadable(obj) || obj instanceof ReadableStream;
}

function _isWritableStream(obj) {
  if (obj == null) return false;
  if (typeof obj !== 'object' && typeof obj !== 'function') return false;
  return isFastWritable(obj) || obj instanceof WritableStream;
}

/**
 * Collect the full pipeline chain by walking upstream links.
 * Returns an array of Node.js streams: [source, ...transforms, dest]
 */
function collectPipelineChain(readable, destination) {
  const chain = [];

  // Walk upstream from this readable
  let current = readable;
  while (current) {
    chain.unshift(current[kNodeReadable]);
    current = current[kUpstream];
  }

  // Add destination
  chain.push(destination[kNodeWritable]);

  return chain;
}

/**
 * Tier 1 fast path: pipe Fast→Fast via Node.js pipeline().
 * Walks upstream links and builds a single pipeline() call.
 */
function fastPipelineTo(source, dest) {
  const chain = collectPipelineChain(source, dest);
  return new Promise((resolve, reject) => {
    pipeline(...chain, (err) => {
      if (err) reject(err);
      else resolve(undefined);
    });
  });
}

export class FastReadableStream {
  /**
   * Static from() — delegates to native ReadableStream.from() (Fix 3)
   * Wraps result in a FastReadableStream shell so .constructor checks pass
   */
  static from(asyncIterable) {
    const native = ReadableStream.from(asyncIterable);
    const fast = Object.create(FastReadableStream.prototype);
    fast[kMaterialized] = native;
    fast[kNodeReadable] = null;
    fast[kLock] = null;
    fast[kState] = 'idle';
    fast[kNativeOnly] = true;
    fast[kUpstream] = null;
    return fast;
  }

  constructor(underlyingSource, strategy) {
    // Per WebIDL: undefined → empty dictionary; null and non-objects → TypeError
    if (underlyingSource === undefined) {
      underlyingSource = {};
    } else if (underlyingSource === null || (typeof underlyingSource !== 'object' && typeof underlyingSource !== 'function')) {
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
    const type = underlyingSource.type;
    const pull = underlyingSource.pull;
    const start = underlyingSource.start;
    const cancel = underlyingSource.cancel;

    // Validate type
    if (type === 'bytes') {
      const native = new ReadableStream(underlyingSource, strategy);
      this[kMaterialized] = native;
      this[kNodeReadable] = null;
      this[kLock] = null;
      this[kState] = 'idle';
      this[kNativeOnly] = true;
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
      const native = new ReadableStream(underlyingSource, strategy);
      this[kMaterialized] = native;
      this[kNodeReadable] = null;
      this[kLock] = null;
      this[kState] = 'idle';
      this[kNativeOnly] = true;
      return;
    }

    // Validate and resolve strategy highWaterMark
    const hwm = strategyHWM !== undefined ? (() => {
      const h = Number(strategyHWM);
      if (Number.isNaN(h) || h < 0) throw new RangeError('Invalid highWaterMark');
      return h;
    })() : 1;

    let controller;
    let pullCallback = null;

    const nodeReadable = new Readable({
      objectMode: true,
      highWaterMark: hwm === Infinity ? 0x7FFFFFFF : hwm,
      read() {
        if (pull) {
          if (pullCallback) return;

          try {
            const result = pull.call(underlyingSource, controller);
            if (result && typeof result.then === 'function') {
              pullCallback = result;
              result.then(
                () => {
                  pullCallback = null;
                  if (!nodeReadable.destroyed) nodeReadable.read(0);
                },
                (err) => {
                  pullCallback = null;
                  if (!nodeReadable.destroyed) nodeReadable.destroy(err);
                }
              );
            }
          } catch (e) {
            if (!nodeReadable.destroyed) nodeReadable.destroy(e);
          }
        }
      },
    });

    // Prevent unhandled 'error' events from crashing
    nodeReadable.on('error', () => {});

    // Fix 8: Track original HWM for Infinity handling
    controller = new FastReadableStreamDefaultController(nodeReadable, hwm);
    controller._stream = this;

    this[kNodeReadable] = nodeReadable;
    this[kLock] = null;
    this[kState] = 'idle';
    this[kMaterialized] = null;
    this[kUpstream] = null;
    this[kNativeOnly] = false;
    this._closed = false;

    // Fix 10: Store cancel callback for later use
    this._cancel = cancel;

    this._storedError = undefined;

    if (start) {
      const startResult = start.call(underlyingSource, controller);
      if (startResult && typeof startResult.then === 'function') {
        startResult.then(
          () => {
            // Only auto-pull if desiredSize > 0 (HWM > 0 and buffer empty)
            if (pull && !nodeReadable.destroyed && hwm > 0) {
              nodeReadable.read(0);
            }
          },
          (err) => { if (!nodeReadable.destroyed) nodeReadable.destroy(err); }
        );
      } else if (pull && hwm > 0) {
        // Trigger initial pull after sync start only if HWM > 0
        queueMicrotask(() => {
          if (!nodeReadable.destroyed) nodeReadable.read(0);
        });
      }
    } else if (pull && hwm > 0) {
      // No start, trigger pull to fill buffer only if HWM > 0
      queueMicrotask(() => {
        if (!nodeReadable.destroyed) nodeReadable.read(0);
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
      // Validate destination
      if (!_isWritableStream(destination)) {
        throw new TypeError('pipeTo destination must be a WritableStream');
      }

      // Access option getters in spec order (alphabetical per Web IDL)
      let preventAbort = false, preventCancel = false, preventClose = false, signal;
      if (options !== undefined && options !== null) {
        if (typeof options !== 'object' && typeof options !== 'function') {
          throw new TypeError('options must be an object');
        }
        preventAbort = !!options.preventAbort;
        preventCancel = !!options.preventCancel;
        preventClose = !!options.preventClose;
        signal = options.signal;
      }

      if (signal !== undefined && !(signal instanceof AbortSignal)) {
        throw new TypeError('options.signal must be an AbortSignal');
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
      // For standalone pipeTo, specPipeTo is already 10x faster than native
      // because our reader/writer are sync — the JS pump loop costs nothing.
      const isDefaultOpts = !preventAbort && !preventCancel && !preventClose && !signal;
      if (isDefaultOpts && this[kUpstream] && isFastWritable(destination) &&
          !destination[kNativeOnly] && destination[kNodeWritable]) {
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
    if (transform === null || transform === undefined ||
        (typeof transform !== 'object' && typeof transform !== 'function')) {
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
    let preventAbort = false, preventCancel = false, preventClose = false, signal;
    if (options !== undefined && options !== null &&
        (typeof options === 'object' || typeof options === 'function')) {
      preventAbort = !!options.preventAbort;
      preventCancel = !!options.preventCancel;
      preventClose = !!options.preventClose;
      signal = options.signal;
    }

    if (signal !== undefined && !(signal instanceof AbortSignal)) {
      throw new TypeError('options.signal must be an AbortSignal');
    }

    // Tier 0: kNativeOnly source → delegate to native pipeThrough
    if (this[kNativeOnly]) {
      const nativeSrc = materializeReadable(this);
      const nativeDst = isFastWritable(writable) ? materializeWritable(writable) : writable;
      const nativeRd = isFastReadable(readable) ? materializeReadable(readable) : readable;
      nativeSrc.pipeThrough(
        { writable: nativeDst, readable: nativeRd },
        { preventAbort, preventCancel, preventClose, signal }
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
    pipePromise.catch(() => {});

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
    if (options && options.mode === 'byob') {
      // Tier 2: BYOB requires native byte stream support
      return materializeReadable(this).getReader({ mode: 'byob' });
    }
    if (options && options.mode !== undefined) {
      throw new TypeError(`Invalid mode: ${options.mode}`);
    }

    // Fix 1: For native-only streams (byte, custom size), delegate reader too
    if (this[kNativeOnly]) {
      return materializeReadable(this).getReader();
    }

    return new FastReadableStreamDefaultReader(this);
  }

  /**
   * tee() — Tier 2: delegate to native, wrap results in Fast shells
   */
  tee() {
    const [branch1, branch2] = materializeReadable(this).tee();
    // Wrap native branches in Fast shells so constructor identity checks pass
    const wrap = (native) => {
      const fast = Object.create(FastReadableStream.prototype);
      fast[kMaterialized] = native;
      fast[kNodeReadable] = null;
      fast[kLock] = null;
      fast[kState] = 'idle';
      fast[kNativeOnly] = true;
      fast[kUpstream] = null;
      return fast;
    };
    return [wrap(branch1), wrap(branch2)];
  }

  /**
   * Internal cancel — bypasses lock check (called by reader.cancel())
   */
  _cancelInternal(reason) {
    // For native-only streams, delegate
    if (this[kNativeOnly]) {
      return materializeReadable(this).cancel(reason);
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
    if (this[kNodeReadable] && !this[kNodeReadable].destroyed) {
      this[kNodeReadable].destroy(null);
    }
    return Promise.resolve(cancelResult).then(() => undefined);
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

    return iterator;
  }

  [Symbol.asyncIterator](options) {
    return this.values(options);
  }

}
