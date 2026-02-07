/**
 * FastReadableStream — WHATWG ReadableStream API backed by Node.js Readable.
 *
 * Tier 0: pipeTo/pipeThrough between Fast streams → pipeline() internally
 * Tier 1: getReader().read() → sync read from Node buffer
 * Tier 2: tee(), native interop → Readable.toWeb() delegation
 */

import { Readable } from 'node:stream';
import {
  kNodeReadable, kNodeWritable, kState, kLock, kMaterialized, kUpstream,
  isFastReadable, isFastWritable, isFastTransform, resolveHWM, kNativeOnly,
} from './utils.js';
import { FastReadableStreamDefaultController } from './controller.js';
import { FastReadableStreamDefaultReader } from './reader.js';
import { materializeReadable, materializeWritable } from './materialize.js';

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
    // Fix 4: Spec-compliant argument validation
    // Per WebIDL, null and missing arguments become empty dictionaries
    if (underlyingSource === null || underlyingSource === undefined) {
      underlyingSource = {};
    }
    // Non-objects are also treated as empty dictionaries
    if (typeof underlyingSource !== 'object' && typeof underlyingSource !== 'function') {
      underlyingSource = {};
    }

    // Fix 4: Eagerly access getters per spec (throwing getters throw during construction)
    const type = underlyingSource.type;
    const pull = underlyingSource.pull;
    const start = underlyingSource.start;
    const cancel = underlyingSource.cancel;

    // Fix 4: Validate type
    if (type === 'bytes') {
      // Fix 1: Byte streams delegate entirely to native — don't lock via Readable.fromWeb()
      const native = new ReadableStream(underlyingSource, strategy);
      this[kMaterialized] = native;
      this[kNodeReadable] = null; // No Node readable for byte streams
      this[kLock] = null;
      this[kState] = 'idle';
      this[kNativeOnly] = true;
      return;
    }
    if (type !== undefined) {
      throw new RangeError(`Invalid type: ${type}`);
    }

    // Fix 4: Validate callbacks are functions if present
    if (cancel !== undefined && typeof cancel !== 'function') {
      throw new TypeError('cancel must be a function');
    }
    if (pull !== undefined && typeof pull !== 'function') {
      throw new TypeError('pull must be a function');
    }
    if (start !== undefined && typeof start !== 'function') {
      throw new TypeError('start must be a function');
    }

    // Fix 5: If strategy has a custom size() function, delegate to native
    if (strategy && typeof strategy.size === 'function') {
      const native = new ReadableStream(underlyingSource, strategy);
      this[kMaterialized] = native;
      this[kNodeReadable] = null;
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

    this[kNodeReadable] = nodeReadable;
    this[kLock] = null;
    this[kState] = 'idle';
    this[kMaterialized] = null;
    this[kUpstream] = null;
    this[kNativeOnly] = false;

    // Fix 10: Store cancel callback for later use
    this._cancel = cancel;

    if (start) {
      const startResult = start.call(underlyingSource, controller);
      if (startResult && typeof startResult.then === 'function') {
        startResult.then(
          () => {
            if (pull && !nodeReadable.destroyed) {
              nodeReadable.read(0);
            }
          },
          (err) => { if (!nodeReadable.destroyed) nodeReadable.destroy(err); }
        );
      } else if (pull) {
        // Trigger initial pull after sync start (WHATWG spec behavior)
        queueMicrotask(() => {
          if (!nodeReadable.destroyed) nodeReadable.read(0);
        });
      }
    } else if (pull) {
      // No start, trigger pull to fill buffer
      queueMicrotask(() => {
        if (!nodeReadable.destroyed) nodeReadable.read(0);
      });
    }
  }

  /**
   * pipeTo(destination, options) — returns Promise<void>
   *
   * Fix 2: ALWAYS delegate to native for spec compliance.
   * The pipeline() fast path is kept only for explicit benchmark use.
   */
  pipeTo(destination, options = {}) {
    if (this[kLock]) {
      return Promise.reject(new TypeError('ReadableStream is locked'));
    }

    // Fix 2: Always materialize and delegate for spec compliance
    const nativeDest = isFastWritable(destination) ? materializeWritable(destination) : destination;
    return materializeReadable(this).pipeTo(nativeDest, options);
  }

  /**
   * pipeThrough(transform, options) — returns ReadableStream
   *
   * Tier 0: Both sides Fast → record upstream link, return transform.readable
   * Tier 2: Otherwise delegate to native
   */
  pipeThrough(transform, options) {
    if (this[kLock]) {
      throw new TypeError('ReadableStream is locked');
    }

    // Fix 2: For non-Fast transforms, always delegate to native
    if (isFastTransform(transform)) {
      // Tier 0: record the upstream link for lazy pipeline collection
      const readable = transform.readable;
      readable[kUpstream] = this;
      return readable;
    }

    // Tier 2: delegate to native (handles duck-typed transforms)
    const nativeReadable = materializeReadable(this);

    // Per spec, access readable THEN writable from the transform
    const rawReadable = transform.readable;
    const rawWritable = transform.writable;

    // Materialize Fast streams to native for interop
    const writable = isFastWritable(rawWritable)
      ? materializeWritable(rawWritable)
      : rawWritable;
    const readable = isFastReadable(rawReadable)
      ? materializeReadable(rawReadable)
      : rawReadable;

    const nativeTransform = { writable, readable };
    return nativeReadable.pipeThrough(nativeTransform, options);
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
   * tee() — Tier 2: delegate to native
   */
  tee() {
    return materializeReadable(this).tee();
  }

  /**
   * cancel(reason) — Fix 10: properly call underlyingSource.cancel() and return its result
   */
  cancel(reason) {
    if (this[kLock]) {
      return Promise.reject(new TypeError('ReadableStream is locked'));
    }

    // Fix 1/10: For native-only streams, delegate
    if (this[kNativeOnly]) {
      return materializeReadable(this).cancel(reason);
    }

    // Fix 10: Call underlyingSource.cancel and return its result
    let cancelResult;
    try {
      cancelResult = this._cancel ? this._cancel(reason) : undefined;
    } catch (e) {
      this[kNodeReadable].destroy(null);
      return Promise.reject(e);
    }
    this[kNodeReadable].destroy(null);
    return Promise.resolve(cancelResult).then(() => undefined);
  }

  get locked() {
    return this[kLock] !== null;
  }

  // Async iteration support
  values(options) {
    return materializeReadable(this).values(options);
  }

  [Symbol.asyncIterator](options) {
    return this.values(options);
  }

}
