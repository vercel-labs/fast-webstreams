/**
 * FastReadableStream — WHATWG ReadableStream API backed by Node.js Readable.
 *
 * Tier 0:   pipeThrough + pipeTo between Fast streams → Node.js pipeline(), zero promises
 * Tier 0.5: Upstream chain exists but can't use pipeline → retroactive specPipeTo per hop
 * Tier 1:   getReader().read() → sync read from Node buffer via Promise.resolve()
 * Tier 1.5: pipeThrough with non-Fast transform (e.g. CompressionStream) → native pipeThrough
 * Tier 2:   Mixed piping, custom strategies → specPipeTo or Readable.toWeb()/Writable.toWeb()
 *
 * Constructor-level native delegation:
 *   type:'bytes' + pull + no start → delegates to native ReadableStream immediately
 *
 * Tee:
 *   Default-type and byte streams without pull → JS readLoop with _enqueueInternal
 *   Byte streams with pull → native tee via materializeReadableAsBytes
 */

import { pipeline, Readable } from 'node:stream';
import { pipeline as pipelineWithSignal } from 'node:stream/promises';
import { FastReadableStreamBYOBReader } from './byob-reader.js';
import { FastReadableStreamDefaultController, kDequeueBytes, kHasPendingPullInto, kGetByobRequest, kCancelPendingPullIntos, kClosePendingPullIntos, kEnqueueInternal } from './controller.js';
import { materializeReadable, materializeReadableAsBytes, materializeWritable } from './materialize.js';
import { NativeReadableStream, NativeTransformStream, NativeWritableStream } from './natives.js';
import { specPipeTo } from './pipe-to.js';
import { FastReadableStreamDefaultReader, READ_DONE } from './reader.js';
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
  LiteReadable,
  noop,
  RESOLVED_UNDEFINED,
  _stats,
} from './utils.js';

// Shared byobRequest getter descriptor — avoids per-instance closure allocation.
// The getter uses `this` dynamically so it's safe to share across all byte stream controllers.
const _byobRequestDescriptor = {
  get() { return this[kGetByobRequest](); },
  configurable: true,
};

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
      // Sync fast path: skip chainOperation + Promise when data is buffered
      // and no prior async operation is pending.
      // _tryReadSync returns: chunk (any value) | READ_DONE | null (no data)
      if (!this[kIterDone] && !this[kIterOngoing]) {
        const reader = this[kIterReader];
        if (reader._tryReadSync) {
          const chunk = reader._tryReadSync();
          if (chunk !== null) {
            if (chunk === READ_DONE) {
              this[kIterDone] = true;
              reader.releaseLock();
              return { value: undefined, done: true };
            }
            return { value: chunk, done: false };
          }
        }
      }
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

// Brand checks: accept both Fast and native streams.
// Must verify internal state, not just prototype chain, because
// Object.setPrototypeOf(FastReadableStream.prototype, NativeReadableStream.prototype)
// makes Object.create(FastReadableStream.prototype) pass instanceof NativeReadableStream.
const _nativeLockedGetter = Object.getOwnPropertyDescriptor(NativeReadableStream.prototype, 'locked')?.get;
function _isReadableStream(obj) {
  if (obj == null) return false;
  if (typeof obj !== 'object' && typeof obj !== 'function') return false;
  if (isFastReadable(obj)) return true;
  // Check for genuine native ReadableStream (has C++ internal slots)
  if (_nativeLockedGetter) {
    try { _nativeLockedGetter.call(obj); return true; } catch { return false; }
  }
  return obj instanceof NativeReadableStream;
}

function _isWritableStream(obj) {
  if (obj == null) return false;
  if (typeof obj !== 'object' && typeof obj !== 'function') return false;
  return isFastWritable(obj) || obj instanceof NativeWritableStream;
}

/**
 * Bolt Fast prototype methods onto a native stream instance.
 * Used by the constructor (for autoAllocateChunkSize/custom-size byte streams)
 * and by patch.js (for _PatchedReadableStream byte streams with pull).
 *
 * @param {object} target - The native stream to augment
 * @param {boolean} conditionalPipe - If true, pipeTo/pipeThrough fall back to
 *   native when the counterpart is not a Fast stream. Used by patch.js where
 *   the target has native internal slots that native pipeTo/pipeThrough need.
 */
export function _boltFastMethods(target, conditionalPipe) {
  target.getReader = function(opts) { return FastReadableStream.prototype.getReader.call(this, opts); };
  target.tee = function() { return FastReadableStream.prototype.tee.call(this); };
  target.cancel = function(r) { return FastReadableStream.prototype.cancel.call(this, r); };
  target._cancelInternal = FastReadableStream.prototype._cancelInternal;
  target.values = function(opts) { return FastReadableStream.prototype.values.call(this, opts); };
  target[Symbol.asyncIterator] = FastReadableStream.prototype[Symbol.asyncIterator];
  if (conditionalPipe) {
    target.pipeTo = function(dest, opts) {
      if (!isFastWritable(dest)) return NativeReadableStream.prototype.pipeTo.call(this, dest, opts);
      return FastReadableStream.prototype.pipeTo.call(this, dest, opts);
    };
    target.pipeThrough = function(t, opts) {
      if (!isFastTransform(t)) return NativeReadableStream.prototype.pipeThrough.call(this, t, opts);
      return FastReadableStream.prototype.pipeThrough.call(this, t, opts);
    };
  } else {
    target.pipeTo = function(dest, opts) { return FastReadableStream.prototype.pipeTo.call(this, dest, opts); };
    target.pipeThrough = function(t, opts) { return FastReadableStream.prototype.pipeThrough.call(this, t, opts); };
  }
  const lockedDesc = Object.getOwnPropertyDescriptor(FastReadableStream.prototype, 'locked');
  if (lockedDesc) {
    Object.defineProperty(target, 'locked', {
      get() { return lockedDesc.get.call(this); },
      configurable: true,
    });
  }
}

/**
 * Parse and validate pipe options (shared by pipeTo and pipeThrough).
 * Accesses option getters in spec order (alphabetical per Web IDL).
 */
function _parsePipeOptions(options) {
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
  return { preventAbort, preventCancel, preventClose, signal };
}

/**
 * Wrap a LiteReadable in a Node.js Readable so it can participate in pipeline().
 * LiteReadable lacks pipe()/flowing mode that pipeline needs.
 * One-time ~10µs cost, then zero-promise pipeline throughput.
 */
function _wrapLiteForPipeline(lite, stream) {
  // Signal the pull coordinator that demand comes from pipeline, not WHATWG reader.
  // pullFn's desiredSize guard checks this to allow pull without reader demand.
  if (stream) stream._pipelineDemand = true;

  let inDrain = false;

  function drain() {
    if (inDrain) return;
    inDrain = true;
    let chunk;
    while ((chunk = lite.read()) !== null) {
      if (!nr.push(chunk)) {
        // Backpressure: wrapper buffer full. Stop pulling until pipeline consumes.
        if (stream) stream._pipelineDemand = false;
        inDrain = false;
        return;
      }
    }
    if (lite._ended) { inDrain = false; nr.push(null); return; }
    // Trigger pull synchronously to fill buffer.
    // inDrain flag prevents re-entrancy if sync pull enqueues immediately
    // (sync pull → enqueue → push → _dataCallback → drain → blocked by inDrain,
    //  data sits in buffer, picked up by while loop after _onRead returns).
    if (lite._onRead && !lite._readableState.reading && !lite._readableState.ended && !lite._destroyed) {
      lite._readableState.reading = true;
      lite._onRead();
      lite._readableState.reading = false;
    }
    // Drain any data enqueued by sync pull
    while ((chunk = lite.read()) !== null) {
      if (!nr.push(chunk)) {
        if (stream) stream._pipelineDemand = false;
        inDrain = false;
        return;
      }
    }
    if (lite._ended) { inDrain = false; nr.push(null); return; }
    inDrain = false;
    // Async pull: register _dataCallback to be notified when data arrives.
    // _dataCallback is cleared by push(), so we re-register each time.
    if (!lite._dataCallback && !lite._destroyed && !lite._ended) {
      lite._dataCallback = (evt, err) => {
        if (evt === 'error') { nr.destroy(err); return; }
        if (evt === 'end' || evt === 'close') { if (!nr.destroyed) nr.push(null); return; }
        // 'data' — new chunk available
        drain();
      };
    }
  }

  const nr = new Readable({
    objectMode: true,
    highWaterMark: Math.max(lite._hwm, 1),
    read() {
      // Pipeline is ready for more data — restore pull demand
      if (stream) stream._pipelineDemand = true;
      drain();
    },
  });
  lite.on('end', () => { if (!nr.destroyed) nr.push(null); });
  lite.on('error', (err) => nr.destroy(err));
  nr.on('error', noop);
  return nr;
}

/**
 * Direct feed: LiteReadable → nodeTransform.write() without Node Readable wrapper.
 * Eliminates _wrapLiteForPipeline overhead for single-hop pipeThrough chains.
 * Writes chunks directly from LiteReadable buffer to Node Transform.
 */
function _startDirectFeed(lite, nodeTransform, sourceStream) {
  if (sourceStream) sourceStream._pipelineDemand = true;

  let ended = false;
  let inFeed = false;

  function feedLoop() {
    if (inFeed || nodeTransform.destroyed || ended) return;
    inFeed = true;

    // Drain LiteReadable buffer → nodeTransform.write()
    let chunk;
    while ((chunk = lite.read()) !== null) {
      if (nodeTransform.destroyed) { inFeed = false; return; }
      if (!nodeTransform.write(chunk)) {
        // Backpressure from transform
        if (sourceStream) sourceStream._pipelineDemand = false;
        inFeed = false;
        nodeTransform.once('drain', () => {
          if (sourceStream) sourceStream._pipelineDemand = true;
          feedLoop();
        });
        return;
      }
    }

    if (lite._ended) { ended = true; inFeed = false; nodeTransform.end(); return; }

    // Sync pull: call _onRead directly
    if (lite._onRead && !lite._readableState.reading && !lite._readableState.ended && !lite._destroyed) {
      lite._readableState.reading = true;
      lite._onRead();
      lite._readableState.reading = false;
    }

    // Drain data enqueued by sync pull
    while ((chunk = lite.read()) !== null) {
      if (nodeTransform.destroyed) { inFeed = false; return; }
      if (!nodeTransform.write(chunk)) {
        if (sourceStream) sourceStream._pipelineDemand = false;
        inFeed = false;
        nodeTransform.once('drain', () => {
          if (sourceStream) sourceStream._pipelineDemand = true;
          feedLoop();
        });
        return;
      }
    }

    if (lite._ended) { ended = true; inFeed = false; nodeTransform.end(); return; }
    inFeed = false;

    // Async pull: register _dataCallback for notification when data arrives
    if (!lite._dataCallback && !lite._destroyed && !lite._ended) {
      lite._dataCallback = (evt, err) => {
        if (evt === 'error') { if (!nodeTransform.destroyed) nodeTransform.destroy(err); return; }
        if (evt === 'end' || evt === 'close') {
          if (!ended && !nodeTransform.destroyed) { ended = true; nodeTransform.end(); }
          return;
        }
        // 'data' — new chunk available
        feedLoop();
      };
    }
  }

  // Error from transform → destroy source
  nodeTransform.on('error', (err) => {
    if (!lite._destroyed) lite.destroy(err);
  });

  feedLoop();
}

/**
 * Direct feed: native ReadableStream → nodeTransform via Node Readable bridge.
 * Readable.fromWeb() buffers chunks (HWM=64), sync feedLoop drains in batches.
 * Eliminates per-chunk Promise on the write side; batches amortize read Promises.
 */
function _startNativeDirectFeed(nativeSource, nodeTransform) {
  const nodeReadable = Readable.fromWeb(nativeSource, { objectMode: true, highWaterMark: 64 });

  function feedLoop() {
    let chunk;
    while ((chunk = nodeReadable.read()) !== null) {
      if (nodeTransform.destroyed) { nodeReadable.destroy(); return; }
      if (!nodeTransform.write(chunk)) {
        nodeTransform.once('drain', feedLoop);
        return;
      }
    }
    // Buffer empty — wait for more data
    if (!nodeReadable.readableEnded) {
      nodeReadable.once('readable', feedLoop);
    }
  }

  nodeReadable.on('end', () => { if (!nodeTransform.destroyed) nodeTransform.end(); });
  nodeReadable.on('error', (err) => { if (!nodeTransform.destroyed) nodeTransform.destroy(err); });
  nodeTransform.on('error', (err) => { if (!nodeReadable.destroyed) nodeReadable.destroy(err); });

  feedLoop();
}

/**
 * Collect the full pipeline chain by walking upstream links.
 * Returns an array of Node.js streams: [source, ...transforms, dest]
 * Wraps LiteReadable instances in Node Readable for pipeline compatibility.
 */
function collectPipelineChain(readable, destination) {
  const chain = [];

  // Walk upstream from this readable (build forward, reverse once — O(n) vs O(n²))
  let current = readable;
  while (current) {
    const nr = current[kNodeReadable];
    // LiteReadable (byte streams) needs a Node Readable wrapper for pipeline
    chain.push(nr instanceof LiteReadable ? _wrapLiteForPipeline(nr, current) : nr);
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
function fastPipelineTo(source, dest, signal) {
  _stats.tier0_pipeline++;
  const chain = collectPipelineChain(source, dest);
  const onDone = () => {
    source._closed = true;
    if (kWritableState in dest) {
      dest[kWritableState] = 'closed';
    }
  };
  if (signal) {
    return pipelineWithSignal(...chain, { signal }).then(onDone);
  }
  return new Promise((resolve, reject) => {
    pipeline(...chain, (err) => {
      if (!err) {
        onDone();
        resolve(undefined);
      } else {
        reject(err);
      }
    });
  });
}


/**
 * Initialize a native-only readable shell (delegates everything to native ReadableStream).
 */
export function _initNativeReadableShell(target, nativeStream) {
  _stats.nativeOnlyReadable++;
  // V8 hidden class alignment: property order and set must match
  // FastReadableStream constructor exactly. This ensures native-only shells
  // and Fast streams share the same hidden class, keeping inline caches
  // monomorphic in functions that handle both types.
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
  target._isByteStream = false;
  target._controller = null;
  target._byteSource = null;
  target._pullLock = null;
  target._pullAgain = false;
  target._pullFn = null;
  target._pipelineDemand = false;
  target._onChunkRead = null;
  target._byteStreamSyncPull = false;
  target._nativeSource = null;
  target._nativeSourceWritable = null;
  target._upstreamWritable = null;
  return target;
}

/**
 * Bridge a kNativeOnly readable into a proper FastReadableStream.
 * Reads from the native reader and enqueues into a Fast controller.
 * Cost: 1 Promise per chunk (native reader.read()), but enables
 * downstream Fast transforms to use Node.js pipeline (zero promises per chunk).
 */
/** Bridge from an already-materialized native stream (used by deferred pipeTo resolution). */
function _bridgeNativeToFast_fromStream(nativeStream) {
  _stats.bridge++;
  const nativeReader = nativeStream.getReader();
  return new FastReadableStream({
    pull(controller) {
      return nativeReader.read().then(function pump({ value, done }) {
        if (done) { controller.close(); return; }
        controller.enqueue(value);
        if (controller.desiredSize > 0) {
          return nativeReader.read().then(pump);
        }
      });
    },
    cancel(reason) {
      return nativeReader.cancel(reason);
    },
  }, { highWaterMark: 64 });
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
      // Pure-pull byte streams (no start, no custom size, no autoAllocate):
      // Delegate entirely to native. The read loop stays in C++ with zero
      // JS-layer overhead. Avoids creating a LiteReadable + controller that
      // getReader() would immediately discard in favor of a native stream.
      // Streams with start() are excluded because the user saves the controller
      // for external enqueue (React Flight pattern) — these need our fast path.
      if (pull && !start && !strategySize && underlyingSource.autoAllocateChunkSize === undefined) {
        _initNativeReadableShell(this, new NativeReadableStream(underlyingSource, strategy));
        return;
      }

      // Delegate to native only when the pull callback needs a real
      // ReadableByteStreamController (byobRequest/respond/respondWithNewView),
      // or when autoAllocateChunkSize or custom size() is used.
      // Byte streams with start/cancel only use enqueue/close/error on the
      // controller, which our FastReadableStreamDefaultController supports.
      // BYOB/tee fallback uses dual-write materialization (see materialize.js).
      if (typeof strategySize === 'function' || underlyingSource.autoAllocateChunkSize !== undefined) {
        const native = new NativeReadableStream(underlyingSource, strategy);
        const shell = Object.create(native);
        _initNativeReadableShell(shell, native);
        _boltFastMethods(shell, false);
        return shell;
      }
      // Otherwise: use fast Node.js path, mark as byte-capable
      // Fall through to normal constructor below
    }
    if (type !== undefined && type !== 'bytes') {
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
    // Byte streams default to 0 per spec (unlike default-type which defaults to 1)
    const defaultHWM = type === 'bytes' ? 0 : 1;
    const hwm =
      strategyHWM !== undefined
        ? (() => {
            const h = Number(strategyHWM);
            if (Number.isNaN(h) || h < 0) throw new RangeError('Invalid highWaterMark');
            return h;
          })()
        : defaultHWM;

    let controller;
    let startCompleted = false;

    // Byte streams use LiteReadable (lightweight array buffer, ~5µs faster construction).
    // Default-type streams use Node.js Readable (needed for pipeline/pipe compatibility).
    const useLite = type === 'bytes';

    // _pullLock is shared between Node _read and native byte stream pull
    // (from materializeReadableAsBytes). Prevents double-calling user's pull.
    // Exposed on the stream so materializeReadableAsBytes can coordinate.
    const stream = this;

    const pullFn = pull ? () => {
      if (!startCompleted) {
        nodeReadable._readableState.reading = false;
        return;
      }
      if (stream._pullLock) {
        // Async pull in progress (Promise): always wait for it to complete.
        // Per spec ([[pullAgain]]), pull must not be called again until its
        // promise fulfills. Mark _pullAgain so the .then() handler re-pulls.
        if (stream._pullLock !== true) {
          stream._pullAgain = true;
          return;
        }
        // Sync pull lock (true): only block auto-pulls with no HWM headroom.
        // Demand-driven reader.read() bypasses sync lock (pull already completed).
        if (useLite && nodeReadable._isAutoPull && controller.desiredSize !== null && controller.desiredSize <= 0) return;
        if (!useLite) return;
      }
      // Byte streams: only pull when there's demand (desiredSize > 0 or pending reads).
      // _pipelineDemand: pipeline mode — demand comes from Node pipeline, not WHATWG reader.
      // Node Readable HWM provides backpressure; desiredSize guard not needed.
      if (useLite && !stream._pipelineDemand && controller.desiredSize !== null && controller.desiredSize <= 0) {
        const reader = stream[kLock];
        const hasPendingReads = reader && reader._pendingReadCount && reader._pendingReadCount() > 0;
        const hasPendingPullIntos = controller[kHasPendingPullInto] && controller[kHasPendingPullInto]();
        if (!hasPendingReads && !hasPendingPullIntos) {
          nodeReadable._readableState.reading = false;
          return;
        }
      }
      try {
        const result = Reflect.apply(pull, underlyingSource, [controller]);
        if (isThenable(result)) {
          stream._pullLock = result;
          result.then(
            () => {
              stream._pullLock = null;
              // Per spec [[pullAgain]]: only re-pull if something requested
              // a pull while the previous one was in progress (e.g., enqueue
              // triggered maybeReadMore, or reader.read() called read(0)).
              // Without this guard, the .then() → read(0) → pullFn chain
              // creates an infinite microtask loop.
              if (stream._pullAgain) {
                stream._pullAgain = false;
                nodeReadable._readableState.reading = false;
                if (!nodeReadable.destroyed) nodeReadable.read(0);
              }
            },
            (err) => {
              stream._pullLock = null;
              stream._pullAgain = false;
              if (!nodeReadable.destroyed) controller.error(err);
            },
          );
        }
        // Sync pull completed: set pull lock for one microtask.
        // Prevents auto-pull from double-calling pull before the pull's
        // microtask settles. Reader.read()'s direct read(0) bypasses this
        // by resetting _readableState.reading before calling read(0).
        if (useLite && !isThenable(result)) {
          stream._pullLock = true;
          queueMicrotask(() => {
            stream._pullLock = null;
          });
        }
      } catch (e) {
        if (!nodeReadable.destroyed) controller.error(e);
      }
    } : null;

    const nodeReadable = useLite
      ? new LiteReadable(hwm === Infinity ? 0x7fffffff : hwm)
      : new Readable({
          objectMode: true,
          highWaterMark: hwm === Infinity ? 0x7fffffff : hwm,
          read() { if (pullFn) pullFn(); },
        });

    if (useLite) {
      if (pullFn) nodeReadable._onRead = pullFn;
    } else {
      nodeReadable.on('error', noop);
    }

    controller = new FastReadableStreamDefaultController(nodeReadable, hwm);
    controller._stream = this;
    // Byte streams: add byobRequest as own property (not on prototype — that's
    // ReadableStreamDefaultController which doesn't have byobRequest per spec).
    // Delegates to controller[kGetByobRequest]() for pending pull-into descriptors.
    if (type === 'bytes') {
      Object.defineProperty(controller, 'byobRequest', _byobRequestDescriptor);
    }
    this._controller = controller;

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
    this._isByteStream = type === 'bytes';
    this._byteSource = type === 'bytes' ? underlyingSource : null;
    this._pullLock = null;
    this._pullAgain = false;
    this._pullFn = pullFn;
    this._pipelineDemand = false;

    // Pre-bound chunk-read callback for byte streams (consolidates kDequeueBytes + onPull + pull-after-read).
    // For non-byte default-type streams, null → zero overhead on the 3.4x-native fast path.
    if (type === 'bytes') {
      const ctrl = controller;
      const nr = nodeReadable;
      // A1: For HWM=0 byte streams, desiredSize is always ≤0 after kDequeueBytes,
      // so the pull-after-read check never passes. Skip it entirely.
      this._onChunkRead = (pullFn && hwm > 0)
        ? (chunk) => {
            ctrl[kDequeueBytes](chunk);
            const ds = ctrl.desiredSize;
            if (ds !== null && ds > 0 && ds - (chunk.byteLength || 0) <= 0) {
              nr._readableState.reading = false;
              nr.read(0);
            }
          }
        : (chunk) => { ctrl[kDequeueBytes](chunk); };
    } else {
      this._onChunkRead = null;
    }

    // A3: Byte stream HWM=0 sync pull marker — reader.read() skips empty buffer check
    this._byteStreamSyncPull = (type === 'bytes' && !!pullFn && hwm === 0);

    _stats.readableCreated++;

    // For byte streams (hwm=0), pull is demand-driven — triggered by pending reads,
    // not by HWM headroom. Always try read(0) so pull fires if a read is waiting.
    const shouldAutoPull = hwm > 0 || type === 'bytes';

    if (start) {
      const startResult = start.call(underlyingSource, controller);
      if (isThenable(startResult)) {
        startResult.then(
          () => {
            startCompleted = true;
            if (pull && !nodeReadable.destroyed && shouldAutoPull) {
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
          if (pull && !nodeReadable.destroyed && shouldAutoPull) {
            nodeReadable.read(0);
          }
        });
      }
    } else {
      // No start — per spec, start completes via resolved promise's .then()
      queueMicrotask(() => {
        startCompleted = true;
        if (pull && !nodeReadable.destroyed && shouldAutoPull) {
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

      const { preventAbort, preventCancel, preventClose, signal } = _parsePipeOptions(options);

      // Tier 0: kNativeOnly source → delegate to native pipeTo (C++ speed)
      // Use NativeReadableStream.prototype.pipeTo directly to avoid recursion
      // when kMaterialized === this (self-referential native shell from patch.js).
      if (this[kNativeOnly]) {
        const nativeSrc = materializeReadable(this);
        const nativeDst = isFastWritable(destination) ? materializeWritable(destination) : destination;
        return NativeReadableStream.prototype.pipeTo.call(nativeSrc, nativeDst, { preventAbort, preventCancel, preventClose, signal });
      }

      // Per spec: pipeTo returns rejected promise (not throw) for lock checks
      if (this[kLock]) {
        return Promise.reject(new TypeError('ReadableStream is locked'));
      }
      if (destination.locked) {
        return Promise.reject(new TypeError('WritableStream is locked'));
      }

      // Resolve deferred native sources in upstream chain: bridge for pipeTo
      // (enables pipeline chain). Walks all upstream nodes because chained
      // pipeThrough stores _nativeSource on an intermediate readable.
      {
        let _cur = this;
        while (_cur) {
          if (_cur._nativeSource) {
            const bridged = _bridgeNativeToFast_fromStream(_cur._nativeSource);
            bridged[kUpstream] = _cur[kUpstream];
            _cur[kUpstream] = bridged;
            if (!_cur._upstreamWritable) _cur._upstreamWritable = _cur._nativeSourceWritable;
            _cur._nativeSource = null;
            _cur._nativeSourceWritable = null;
          }
          _cur = _cur[kUpstream];
        }
      }

      // Tier 0: pipeThrough chain with upstream links → Node.js pipeline()
      // Supports default options OR signal-only (pipeline supports AbortSignal).
      // preventAbort/preventCancel/preventClose require spec-compliant handling.
      const isPipelineCompatible = !preventAbort && !preventCancel && !preventClose;
      if (
        isPipelineCompatible &&
        this[kUpstream] &&
        isFastWritable(destination) &&
        !destination[kNativeOnly] &&
        destination[kNodeWritable]
      ) {
        // LiteReadable (byte streams) auto-wrapped by collectPipelineChain
        return fastPipelineTo(this, destination, signal);
      }

      // Tier 0.5: upstream chain exists but can't use full pipeline.
      // Start specPipeTo for each upstream hop retroactively.
      if (this[kUpstream]) {
        const hops = [];
        let current = this;
        while (current[kUpstream]) {
          hops.push({ source: current[kUpstream], writable: current._upstreamWritable });
          const next = current[kUpstream];
          current[kUpstream] = null;
          current = next;
        }
        // Start each hop (they are independent: source→t1.writable, t1.readable→t2.writable, ...)
        for (const hop of hops) {
          if (hop.source && hop.writable) {
            specPipeTo(hop.source, hop.writable, {}).catch(noop);
          }
        }
      }

      // Tier 2: Spec-compliant (handles the last hop: this → destination)
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

    // Per spec: pipeThrough throws synchronously (not rejected promise) for lock checks
    if (this[kLock]) {
      throw new TypeError('ReadableStream is locked');
    }

    if (writable.locked) {
      throw new TypeError('WritableStream is locked');
    }

    const { preventAbort, preventCancel, preventClose, signal } = _parsePipeOptions(options);

    // Tier 0: kNativeOnly source → deferred resolution for transform
    if (this[kNativeOnly]) {
      // Store native source for deferred resolution at getReader/pipeTo time.
      // - getReader: native pipeTo into materialized writable (C++ pipe, 0 Promises/chunk)
      // - pipeTo: bridge + upstream linking → pipeline (batched Promises, full chain)
      if (
        isFastWritable(writable) && !writable[kNativeOnly] &&
        isFastReadable(readable) && !readable[kNativeOnly]
      ) {
        readable._nativeSource = materializeReadable(this);
        readable._nativeSourceWritable = writable;
        return readable;
      }
      // Fallback: cascade to native (transform is not fully Fast)
      // Use native prototype method to avoid recursion for self-referential kMaterialized.
      const nativeSrc = materializeReadable(this);
      const nativeDst = isFastWritable(writable) ? materializeWritable(writable) : writable;
      const nativeRd = isFastReadable(readable) ? materializeReadable(readable) : readable;
      NativeReadableStream.prototype.pipeThrough.call(nativeSrc,
        { writable: nativeDst, readable: nativeRd },
        { preventAbort, preventCancel, preventClose, signal },
      );
      // Return the original readable (Fast shell or native) — the pipe is running
      return readable;
    }

    // Tier 1: FastTransform, default options → upstream linking (deferred pipe)
    // Just sets kUpstream. pipeTo resolves the chain:
    //   - Default opts + Fast dest → fastPipelineTo (Tier 0, zero promises)
    //   - Otherwise → retroactive specPipeTo for each hop
    const isDefaultOpts = !preventAbort && !preventCancel && !preventClose && !signal;
    if (isDefaultOpts && isFastTransform(transform)) {
      readable[kUpstream] = this;
      readable._upstreamWritable = writable; // for retroactive specPipeTo
      return readable;
    }

    // Tier 1.5: Non-Fast transform with native readable/writable (e.g. CompressionStream).
    // Materialize the source and use native pipeThrough — keeps entire pipe in C++,
    // avoiding the JS promise chain per chunk from specPipeTo.
    if (!isFastReadable(readable) && !isFastWritable(writable)) {
      const nativeSrc = materializeReadable(this);
      NativeReadableStream.prototype.pipeThrough.call(nativeSrc,
        { writable, readable },
        { preventAbort, preventCancel, preventClose, signal },
      );
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
      // Standalone BYOB reader handles lock check and kLock directly
      return new FastReadableStreamBYOBReader(this);
    }
    if (mode !== undefined) {
      throw new TypeError(`Invalid mode: ${mode}`);
    }

    // For native-only streams (byte, custom size), delegate reader too.
    // Use native prototype method to avoid recursion for self-referential kMaterialized.
    if (this[kNativeOnly]) {
      return NativeReadableStream.prototype.getReader.call(materializeReadable(this), options);
    }

    // Native delegation for pull-only byte streams: create native stream, return native reader.
    // Entire read loop stays in C++ — eliminates Promise/object allocation overhead.
    // Gate: byte stream + pull + no start (controller not saved externally) + no upstream + empty buffer.
    if (this._isByteStream && this._pullFn && !this[kUpstream] && !this._nativeSource &&
        !this._byteSource.start && this[kNodeReadable].readableLength === 0) {
      const us = this._byteSource;
      const userPull = us.pull;
      const userCancel = us.cancel;
      const nativeSource = { type: 'bytes' };
      nativeSource.pull = function(controller) {
        return userPull.call(us, controller);
      };
      if (userCancel) {
        nativeSource.cancel = function(reason) {
          return userCancel.call(us, reason);
        };
      }
      // Disable Fast pull coordinator (prevent auto-pull microtask from firing)
      this[kNodeReadable]._onRead = null;
      this[kLock] = 'native-delegate';
      _stats.tier1_getReader++;
      const hwm = this[kNodeReadable]._hwm;
      return NativeReadableStream.prototype.getReader.call(
        new NativeReadableStream(nativeSource, hwm > 0 ? { highWaterMark: hwm } : undefined)
      );
    }

    // Resolve deferred native sources: use C++ pipeTo for zero-promise first hop.
    // Data flows: native → materializedWritable → Node Transform → reader reads output.
    // Walks all upstream nodes for chained pipeThrough.
    {
      let _cur = this;
      while (_cur) {
        if (_cur._nativeSource) {
          _stats.bridge++;
          const writable = _cur._nativeSourceWritable;

          // Native delegation: single-hop kNativeOnly → FastTransformStream → getReader()
          // Create native TransformStream with same transformer, keep entire pipeline in C++.
          if (_cur === this && !this[kUpstream] && writable?._isTransformShell) {
            const ts = writable._transformStream;
            if (ts?._transformer) {
              const nativeTS = new NativeTransformStream(ts._transformer);
              NativeReadableStream.prototype.pipeTo.call(
                _cur._nativeSource, nativeTS.writable
              ).catch(noop);
              _cur._nativeSource = null;
              _cur._nativeSourceWritable = null;
              this[kLock] = 'native-delegate';
              return NativeReadableStream.prototype.getReader.call(nativeTS.readable);
            }
          }

          const nodeWritable = writable?.[kNodeWritable];
          if (nodeWritable && typeof nodeWritable.write === 'function') {
            // Direct feed: native reader → nodeTransform.write() (skip Writable.toWeb)
            _startNativeDirectFeed(_cur._nativeSource, nodeWritable);
          } else {
            // Fallback: materialize + native pipeTo
            const nativeWritable = materializeWritable(writable);
            NativeReadableStream.prototype.pipeTo.call(
              _cur._nativeSource, nativeWritable,
            ).catch(noop); // errors propagate via Node Transform
          }
          _cur._nativeSource = null;
          _cur._nativeSourceWritable = null;
        }
        _cur = _cur[kUpstream];
      }
    }

    // Resolve upstream chain when getReader() is called on pipeThrough result.
    // Prefer Tier 0 (Node.js pipeline) over specPipeTo — pipeline processes
    // chunks without Promise chains (~3.5µs saved per chunk).
    if (this[kUpstream]) {
      const upstream = this[kUpstream];

      // Native delegation: pull-only byte stream → transform(no start) → getReader()
      // Creates all-C++ pipeline, eliminates JS per-chunk overhead.
      if (!upstream[kUpstream] &&                                    // single hop
          upstream._isByteStream && upstream._pullFn &&              // byte stream with pull
          !upstream._byteSource?.start &&                            // no start (controller not saved)
          upstream[kNodeReadable].readableLength === 0 &&            // empty buffer
          this._upstreamWritable?._isTransformShell) {               // transform writable
        const ts = this._upstreamWritable._transformStream;
        if (ts?._transformer && !ts._transformer.start) {            // transformer without start
          const us = upstream._byteSource;
          const userPull = us.pull;
          const userCancel = us.cancel;
          const nativeSource = { type: 'bytes' };
          nativeSource.pull = function(controller) {
            return userPull.call(us, controller);
          };
          if (userCancel) {
            nativeSource.cancel = function(reason) {
              return userCancel.call(us, reason);
            };
          }
          const hwm = upstream[kNodeReadable]._hwm;
          const nativeRS = new NativeReadableStream(
            nativeSource, hwm > 0 ? { highWaterMark: hwm } : undefined
          );
          const nativeTS = new NativeTransformStream(ts._transformer);
          NativeReadableStream.prototype.pipeTo.call(
            nativeRS, nativeTS.writable
          ).catch(noop);

          upstream[kNodeReadable]._onRead = null;
          upstream[kLock] = 'native-delegate';
          this[kUpstream] = null;
          this._upstreamWritable = null;
          this[kLock] = 'native-delegate';
          _stats.tier1_getReader++;
          return NativeReadableStream.prototype.getReader.call(nativeTS.readable);
        }
      }

      // Single-hop LiteReadable → Transform: direct feed (skip pipeline wrapper)
      // Writes chunks directly from LiteReadable to nodeTransform.write(),
      // eliminating _wrapLiteForPipeline overhead (~4.6x faster).
      if (!upstream[kUpstream] &&
          upstream[kNodeReadable] instanceof LiteReadable &&
          this[kNodeReadable] && typeof this[kNodeReadable].write === 'function') {
        _stats.tier0_pipeline++;
        const lite = upstream[kNodeReadable];
        const nodeTransform = this[kNodeReadable];
        this[kUpstream] = null;
        this._upstreamWritable = null;
        _startDirectFeed(lite, nodeTransform, upstream);
      } else {
        // Multi-hop or non-LiteReadable: full pipeline chain
        // Tier 0 for getReader: build pipeline chain, data flows into last
        // transform's Node buffer. Reader reads from there (Tier 1 sync).
        // LiteReadable (byte streams) auto-wrapped by collectPipelineChain.
        _stats.tier0_pipeline++;
        const chain = [];
        let current = this;
        while (current) {
          const nr = current[kNodeReadable];
          chain.push(nr instanceof LiteReadable ? _wrapLiteForPipeline(nr, current) : nr);
          current = current[kUpstream];
        }
        chain.reverse();
        // Clear all upstream links
        current = this;
        while (current[kUpstream]) {
          const next = current[kUpstream];
          current[kUpstream] = null;
          current._upstreamWritable = null;
          current = next;
        }
        // Start pipeline — data flows source → transforms → last transform's buffer
        pipeline(chain, (err) => {
          if (err) {
            this._errored = true;
            this._storedError = err;
          }
        });
      }
    }

    _stats.tier1_getReader++;
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

    // For native-only streams, or byte streams with pull (which may use
    // byobRequest on the source controller), delegate to native tee.
    // Byte streams without pull (start+enqueue pattern, e.g. React Flight)
    // use the fast JS readLoop below.
    if (this[kNativeOnly] || (this._isByteStream && this._pullFn)) {
      // Use native prototype method to avoid recursion for self-referential kMaterialized.
      const nativeStream = this[kNativeOnly]
        ? materializeReadable(this)
        : materializeReadableAsBytes(this);
      const [b1, b2] = NativeReadableStream.prototype.tee.call(nativeStream);
      return [
        _initNativeReadableShell(Object.create(FastReadableStream.prototype), b1),
        _initNativeReadableShell(Object.create(FastReadableStream.prototype), b2),
      ];
    }

    const isByteTee = this._isByteStream;
    // For byte streams: use FastReadableStreamDefaultReader directly to bypass
    // getReader()'s native delegation (we need _readWithCallbacks on the reader).
    // For default-type: use getReader() to preserve existing behavior.
    const reader = isByteTee ? new FastReadableStreamDefaultReader(this) : this.getReader();
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

    // Branch source config — byte tee creates byte-type branches
    const branchSource = isByteTee
      ? { type: 'bytes' }
      : {};

    const branch1 = new FastReadableStream(
      Object.assign(branchSource, {
        start(c) {
          branch1Controller = c;
        },
        pull() {
          return readLoop();
        },
        cancel(reason) {
          return cancel1Algorithm(reason);
        },
      }),
      { highWaterMark: 0 },
    );

    const branch2 = new FastReadableStream(
      Object.assign(isByteTee ? { type: 'bytes' } : {}, {
        start(c) {
          branch2Controller = c;
        },
        pull() {
          return readLoop();
        },
        cancel(reason) {
          return cancel2Algorithm(reason);
        },
      }),
      { highWaterMark: 0 },
    );

    let reading = false;
    let readAgain = false;
    function readLoop() {
      if (reading) {
        // For byte tee: don't set readAgain — extra source pulls break WPT pull-count tests.
        // For default-type: set readAgain so concurrent drain works.
        if (!isByteTee) readAgain = true;
        // Return undefined (not RESOLVED_UNDEFINED) — RESOLVED_UNDEFINED is a thenable
        // which would cause the branch's pullFn to set pullLock and schedule infinite
        // re-reads via microtasks while reading is still true.
        return;
      }
      reading = true;
      // Use _readWithCallbacks to avoid {value,done} objects in promise resolution.
      // Promise.resolve({value,done}) triggers ECMAScript thenable check on the object,
      // which is observable when Object.prototype.then is patched (WPT then-interception test).
      return reader._readWithCallbacks(
        isByteTee
          ? (value) => {
              // Byte tee: use _enqueueInternal (skips buffer.transfer) and clone for branch2
              if (!canceled1 && !canceled2) {
                try { branch1Controller[kEnqueueInternal](value); } catch {}
                try { branch2Controller[kEnqueueInternal](value.slice(0)); } catch {}
              } else if (!canceled1) {
                try { branch1Controller[kEnqueueInternal](value); } catch {}
              } else if (!canceled2) {
                try { branch2Controller[kEnqueueInternal](value); } catch {}
              }
              reading = false;
            }
          : (value) => {
              const ra = readAgain;
              readAgain = false;
              try {
                if (!canceled1 && branch1Controller) branch1Controller.enqueue(value);
              } catch {}
              try {
                if (!canceled2 && branch2Controller) branch2Controller.enqueue(value);
              } catch {}
              reading = false;
              if (ra) readLoop();
            },
        () => {
          reading = false;
          // For byte tee: close pending BYOB pull-intos before close
          // (close doesn't auto-resolve them; respond(0) path doesn't apply in tee context)
          if (isByteTee) {
            try { if (!canceled1 && branch1Controller) branch1Controller[kClosePendingPullIntos]?.(); } catch {}
            try { if (!canceled2 && branch2Controller) branch2Controller[kClosePendingPullIntos]?.(); } catch {}
          }
          try {
            if (!canceled1 && branch1Controller) branch1Controller.close();
          } catch {}
          try {
            if (!canceled2 && branch2Controller) branch2Controller.close();
          } catch {}
          // Don't resolve cancelPromise when both branches are already canceled —
          // the cancel algorithm handles cancelResolve with the source's cancel result.
          if (!(canceled1 && canceled2)) cancelResolve(undefined);
        },
        (r) => {
          reading = false;
          try {
            if (!canceled1 && branch1Controller) branch1Controller.error(r);
          } catch {}
          try {
            if (!canceled2 && branch2Controller) branch2Controller.error(r);
          } catch {}
          if (!(canceled1 && canceled2)) cancelResolve(undefined);
        },
      );
    }

    // Propagate source close/errors to both branches
    reader.closed.then(
      () => {
        // Source closed — close both branches
        if (isByteTee) {
          try { if (!canceled1 && branch1Controller) branch1Controller[kClosePendingPullIntos]?.(); } catch {}
          try { if (!canceled2 && branch2Controller) branch2Controller[kClosePendingPullIntos]?.(); } catch {}
        }
        try {
          if (!canceled1 && branch1Controller) branch1Controller.close();
        } catch {}
        try {
          if (!canceled2 && branch2Controller) branch2Controller.close();
        } catch {}
        if (!(canceled1 && canceled2)) cancelResolve(undefined);
      },
      (r) => {
        // Source errored — error both branches
        try {
          if (!canceled1 && branch1Controller) branch1Controller.error(r);
        } catch {}
        try {
          if (!canceled2 && branch2Controller) branch2Controller.error(r);
        } catch {}
        if (!(canceled1 && canceled2)) cancelResolve(undefined);
      },
    );

    return [branch1, branch2];
  }

  /**
   * Internal cancel — bypasses lock check (called by reader.cancel())
   */
  _cancelInternal(reason) {
    // For native-only streams, delegate.
    // Use native prototype method to avoid recursion for self-referential kMaterialized.
    if (this[kNativeOnly]) {
      return NativeReadableStream.prototype.cancel.call(materializeReadable(this), reason);
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

    // Fulfill pending BYOB reads with {done: true, value: undefined}
    if (this._controller && this._controller[kCancelPendingPullIntos]) {
      this._controller[kCancelPendingPullIntos]();
    }

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
    if (this[kNativeOnly]) {
      // Self-referential shell (patch.js): native internal slots on `this` — use native getter
      if (this[kMaterialized] === this) return _nativeLockedGetter.call(this);
      // Wrapper shell: delegate to the wrapped native stream
      if (this[kMaterialized]) return this[kMaterialized].locked;
    }
    return this[kLock] !== null;
  }

  // Async iteration support — uses our reader for proper cancel wiring
  values(options) {
    // For kNativeOnly streams, delegate to native values() for C++ iterator speed
    if (this[kNativeOnly]) {
      return NativeReadableStream.prototype.values.call(materializeReadable(this), options);
    }

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

// Place NativeReadableStream.prototype in the prototype chain so that
// Function.prototype[Symbol.hasInstance].call(NativeReadableStream, fastInstance)
// returns true. This satisfies undici's WebIDL brand check on Node 24+
// (webidl.is.ReadableStream) which uses a prototype chain walk that bypasses
// our Symbol.hasInstance override.
Object.setPrototypeOf(FastReadableStream.prototype, NativeReadableStream.prototype);

// Shadow Node.js internal symbols that exist as getters on NativeReadableStream.prototype.
// These access C++ internal slots and would throw on Fast instances. Undici's extractBody
// calls isDisturbed/isErrored which read these symbols.
const _kDisturbed = Symbol.for('nodejs.stream.disturbed');
const _kErrored = Symbol.for('nodejs.stream.errored');
const _kReadable = Symbol.for('nodejs.stream.readable');

Object.defineProperty(FastReadableStream.prototype, _kDisturbed, {
  get() { return this[kLock] !== null; },
  configurable: true,
});
Object.defineProperty(FastReadableStream.prototype, _kErrored, {
  get() { return this._errored ? (this._storedError || true) : false; },
  configurable: true,
});
Object.defineProperty(FastReadableStream.prototype, _kReadable, {
  get() { return (this._closed || this._errored) ? false : true; },
  configurable: true,
});

// Suppress structured clone/transfer symbols inherited from NativeReadableStream.prototype.
// Fast streams don't support structured clone transfer — these inherited getters would
// access C++ internal slots and throw.
for (const sym of Object.getOwnPropertySymbols(NativeReadableStream.prototype)) {
  const desc = sym.description;
  if (desc && (desc.includes('transfer') || desc.includes('deserialize'))) {
    Object.defineProperty(FastReadableStream.prototype, sym, {
      value: undefined, configurable: true, writable: true,
    });
  }
}
