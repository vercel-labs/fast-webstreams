// Symbols for internal state (non-enumerable, unforgeable)
export const kNodeReadable = Symbol('kNodeReadable');
export const kNodeWritable = Symbol('kNodeWritable');
export const kNodeTransform = Symbol('kNodeTransform');
export const kLock = Symbol('kLock');
export const kMaterialized = Symbol('kMaterialized');
export const kUpstream = Symbol('kUpstream');
export const kNativeOnly = Symbol('kNativeOnly');

// Writable state symbols (shared to avoid circular deps)
export const kWritableState = Symbol('kWritableState');
export const kStoredError = Symbol('kStoredError');

// Sentinel for cancel handlers to signal "don't destroy the node stream"
export const kSkipDestroy = Symbol('kSkipDestroy');

// Shared helpers
export const noop = () => {};
export const isThenable = (v) => v instanceof Promise || (v != null && typeof v.then === 'function');
export const RESOLVED_UNDEFINED = Promise.resolve(undefined);

// Instance checks (typeof guard: `in` throws on primitives)
export const isFastReadable = (s) => s != null && typeof s === 'object' && kNodeReadable in s;
export const isFastWritable = (s) => s != null && typeof s === 'object' && kNodeWritable in s;
export const isFastTransform = (s) => s != null && typeof s === 'object' && kNodeTransform in s;

// Extract highWaterMark from a strategy, converting via ToNumber per spec.
// WHATWG default is CountQueuingStrategy with highWaterMark = 1.
export function resolveHWM(strategy, defaultHWM = 1) {
  if (!strategy) return defaultHWM;
  if (!('highWaterMark' in strategy)) return defaultHWM;
  const h = Number(strategy.highWaterMark);
  if (Number.isNaN(h) || h < 0) {
    throw new RangeError('Invalid highWaterMark');
  }
  return h;
}

/**
 * LiteReadable — minimal duck-type of Node.js Readable for byte streams.
 * Avoids the ~6µs overhead of new Readable() for short-lived streams.
 * Supports: push, read, destroy, resume, readableLength, readableEnded,
 * readableHighWaterMark, destroyed, errored, on/once/removeListener/emit.
 * Lazy-promotes to a real Node.js Readable when pipeline/pipe is needed.
 */
export class LiteReadable {
  constructor(hwm) {
    this._buffer = [];
    this._bufferHead = 0;
    this._ended = false;
    this._destroyed = false;
    this._errored = null;
    this._hwm = hwm;
    this._listeners = null; // lazy: { readable: [], end: [], error: [], close: [] }
    this._readableState = { reading: false, ended: false };
    this._onRead = null; // _read callback (pull)
    this._autoPullPending = false;
    this._isAutoPull = false;
    this._dataCallback = null; // Direct callback for reader fast path (bypasses listeners)
    this._readQueue = null; // FIFO queue for multiple concurrent reads
  }

  get readableHighWaterMark() { return this._hwm; }
  get readableLength() { return this._buffer.length - this._bufferHead; }
  get readableEnded() { return this._ended && this._buffer.length === this._bufferHead; }
  get destroyed() { return this._destroyed; }
  get errored() { return this._errored; }

  push(chunk) {
    if (chunk === null) {
      this._readableState.ended = true;
      if (this._buffer.length === this._bufferHead) {
        this._ended = true;
        if (this._dataCallback) { const cb = this._dataCallback; this._dataCallback = null; cb('end'); }
        else this._emit('end');
      } else {
        if (this._dataCallback) { const cb = this._dataCallback; this._dataCallback = null; cb('data'); }
        else this._emit('readable');
      }
      return;
    }
    this._buffer.push(chunk);
    // A2: Skip notification during sync pull when no async reader is waiting.
    // reader.read() fast path reads the buffer immediately after _onRead() returns.
    if (this._readableState.reading && !this._dataCallback) return;
    if (this._dataCallback) { const cb = this._dataCallback; this._dataCallback = null; cb('data'); }
    else this._emit('readable');
  }

  read(n) {
    if (n === 0) {
      // Trigger _read (pull) if nothing is buffered and not ended/destroyed
      if (this._buffer.length === this._bufferHead && this._onRead && !this._readableState.reading &&
          !this._readableState.ended && !this._destroyed) {
        this._readableState.reading = true;
        this._onRead();
        // Reset after sync return (async pull resets in its .then() handler).
        // The pullCallback check in the _onRead wrapper prevents double-calling
        // regardless of this flag, so resetting here is always safe.
        this._readableState.reading = false;
      }
      return null;
    }
    if (this._buffer.length > this._bufferHead) {
      const chunk = this._buffer[this._bufferHead];
      this._buffer[this._bufferHead] = undefined; // GC
      this._bufferHead++;
      // Compact when head is past 512 and more than half consumed
      if (this._bufferHead > 512 && this._bufferHead > (this._buffer.length >>> 1)) {
        this._buffer = this._buffer.slice(this._bufferHead);
        this._bufferHead = 0;
      }
      // If buffer drained and ended, mark ended
      if (this._buffer.length === this._bufferHead && this._readableState.ended) {
        this._ended = true;
      }
      // Auto-pull after consumption: if buffer drained and pull is set,
      // schedule read(0) to trigger demand (mirrors Node.js maybeReadMore).
      // Guard with _autoPullPending to prevent infinite microtask loops
      // (read(0) → pull → enqueue → readable → read → consumption → auto-pull → repeat).
      if (this._buffer.length === this._bufferHead && this._onRead && !this._destroyed && !this._autoPullPending && this._hwm > 0) {
        this._autoPullPending = true;
        queueMicrotask(() => {
          this._autoPullPending = false;
          if (!this._destroyed && !this._readableState.reading && this._onRead &&
              this._buffer.length === this._bufferHead) {
            this._isAutoPull = true;
            this.read(0);
            this._isAutoPull = false;
          }
        });
      }
      return chunk;
    }
    return null;
  }

  destroy(err) {
    if (this._destroyed) return;
    this._destroyed = true;
    if (err) {
      this._errored = err;
      if (this._dataCallback) { const cb = this._dataCallback; this._dataCallback = null; cb('error', err); }
      else this._emit('error', err);
    } else {
      if (this._dataCallback) { const cb = this._dataCallback; this._dataCallback = null; cb('close'); }
      else this._emit('close');
    }
  }

  resume() { /* no-op — no flowing mode */ }

  // Multi-listener EventEmitter interface
  on(event, fn) {
    this._addListener(event, fn, false);
    return this;
  }

  once(event, fn) {
    this._addListener(event, fn, true);
    return this;
  }

  removeListener(event, fn) {
    if (!this._listeners) return this;
    const arr = this._listeners[event];
    if (!arr) return this;
    for (let i = arr.length - 1; i >= 0; i--) {
      if (arr[i].fn === fn) {
        arr.splice(i, 1);
        break;
      }
    }
    return this;
  }

  emit() { return false; }

  _addListener(event, fn, once) {
    if (!this._listeners) this._listeners = { readable: [], end: [], error: [], close: [] };
    const arr = this._listeners[event];
    if (arr) arr.push({ fn, once });
  }

  _emit(event, arg) {
    if (!this._listeners) return;
    const arr = this._listeners[event];
    if (!arr || arr.length === 0) return;
    // Fast path: single non-once listener — no snapshot needed
    if (arr.length === 1 && !arr[0].once) {
      arr[0].fn(arg);
      return;
    }
    // Snapshot: iterate a copy so once-removal doesn't skip entries
    const snapshot = arr.slice();
    // Remove once entries first
    for (let i = arr.length - 1; i >= 0; i--) {
      if (arr[i].once) arr.splice(i, 1);
    }
    for (let i = 0; i < snapshot.length; i++) {
      snapshot[i].fn(arg);
    }
  }
}

// Debug stats — lightweight counters for tracing which code paths fire.
// Enable with: globalThis.__FAST_WEBSTREAMS_DEBUG = true
// Read with:   import { _debugStats } from 'experimental-fast-webstreams/utils'
export const _stats = {
  readableCreated: 0,
  writableCreated: 0,
  transformCreated: 0,
  nativeOnlyReadable: 0,
  nativeOnlyWritable: 0,
  nativeOnlyTransform: 0,
  tier0_pipeline: 0,
  tier05_upstream: 0,
  tier1_getReader: 0,
  tier2_specPipeTo: 0,
  tier2_materializeReadable: 0,
  tier2_materializeWritable: 0,
  bridge: 0,
};

export function _debugStats() {
  return { ...(_stats) };
}

export function _resetStats() {
  for (const key of Object.keys(_stats)) _stats[key] = 0;
}
