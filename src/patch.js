/**
 * Global patcher: replaces the built-in ReadableStream, WritableStream,
 * and TransformStream with fast alternatives.
 *
 * IMPORTANT: The native constructors are captured by src/natives.js at import
 * time, BEFORE this module can overwrite globalThis. Our internal code imports
 * from natives.js, so it continues to use the real originals.
 *
 * Usage:
 *   import { patchGlobalWebStreams, unpatchGlobalWebStreams } from 'experimental-fast-webstreams';
 *   patchGlobalWebStreams();    // globalThis.ReadableStream is now FastReadableStream, etc.
 *   unpatchGlobalWebStreams();  // restores the original native constructors
 */

import { FastReadableStream, FastTransformStream, FastWritableStream } from './index.js';
import { _initNativeReadableShell } from './readable.js';
import {
  NativeByteLengthQueuingStrategy,
  NativeCountQueuingStrategy,
  NativeReadableStream,
  NativeTransformStream,
  NativeWritableStream,
} from './natives.js';

import { isFastReadable, isFastWritable, isFastTransform } from './utils.js';

// Save original Symbol.hasInstance descriptors for unpatch.
// getOwnPropertyDescriptor returns undefined if there's no OWN hasInstance
// (inherited from Function.prototype). Fall back to the default so native
// objects still pass instanceof checks (needed for Response, fetch, etc.).
const _defaultHasInstance = { value: Function.prototype[Symbol.hasInstance], configurable: true };
const _origHasInstanceRS = Object.getOwnPropertyDescriptor(NativeReadableStream, Symbol.hasInstance) || _defaultHasInstance;
const _origHasInstanceWS = Object.getOwnPropertyDescriptor(NativeWritableStream, Symbol.hasInstance) || _defaultHasInstance;
const _origHasInstanceTS = Object.getOwnPropertyDescriptor(NativeTransformStream, Symbol.hasInstance) || _defaultHasInstance;

/**
 * Replace the global stream constructors with fast alternatives.
 *
 * Also overrides Symbol.hasInstance on the native constructors so that
 * `fastStream instanceof NativeReadableStream` returns true. This is
 * required because Node.js internals (e.g. Readable.fromWeb, HTTP response
 * streaming) hold references to the original native constructors and use
 * instanceof checks.
 */
// Wrapper constructor for globalThis.ReadableStream.
// Byte streams with pull (e.g. undici/fetch) depend on C++ internal slots of
// ReadableByteStreamController. We create a native stream wrapped as a
// kNativeOnly Fast shell so downstream consumers get the fast path.
function _PatchedReadableStream(underlyingSource, strategy) {
  if (
    underlyingSource != null &&
    (typeof underlyingSource === 'object' || typeof underlyingSource === 'function') &&
    underlyingSource.type === 'bytes' &&
    typeof underlyingSource.pull === 'function'
  ) {
    // Return genuine native stream with Fast methods bolted on.
    // Must keep native internal slots so undici WebIDL brand checks pass
    // (new Response(stream) needs webidl.is.ReadableStream to succeed).
    // Object.create(native) does NOT preserve internal slots — they're
    // per-object, not inherited. Instead, add Fast methods directly.
    const native = new NativeReadableStream(underlyingSource, strategy);
    _initNativeReadableShell(native, native);
    native.getReader = function(opts) { return FastReadableStream.prototype.getReader.call(this, opts); };
    // Delegate to native when counterpart isn't Fast — this object has native
    // internal slots so native pipeThrough/pipeTo work correctly.
    native.pipeTo = function(dest, opts) {
      if (!isFastWritable(dest)) return NativeReadableStream.prototype.pipeTo.call(this, dest, opts);
      return FastReadableStream.prototype.pipeTo.call(this, dest, opts);
    };
    native.pipeThrough = function(t, opts) {
      if (!isFastTransform(t)) return NativeReadableStream.prototype.pipeThrough.call(this, t, opts);
      return FastReadableStream.prototype.pipeThrough.call(this, t, opts);
    };
    native.tee = function() { return FastReadableStream.prototype.tee.call(this); };
    native.cancel = function(r) { return FastReadableStream.prototype.cancel.call(this, r); };
    native._cancelInternal = FastReadableStream.prototype._cancelInternal;
    native.values = function(opts) { return FastReadableStream.prototype.values.call(this, opts); };
    native[Symbol.asyncIterator] = FastReadableStream.prototype[Symbol.asyncIterator];
    const lockedDesc = Object.getOwnPropertyDescriptor(FastReadableStream.prototype, 'locked');
    if (lockedDesc) {
      Object.defineProperty(native, 'locked', {
        get() { return lockedDesc.get.call(this); },
        configurable: true,
      });
    }
    return native;
  }
  return new FastReadableStream(underlyingSource, strategy);
}
_PatchedReadableStream.prototype = FastReadableStream.prototype;
_PatchedReadableStream.from = FastReadableStream.from;
// Must accept native ReadableStream instances too (byte streams with pull
// return genuine native objects). Without this, undici's
// `obj instanceof globalThis.ReadableStream` fails for byte streams because
// native prototype chain doesn't include FastReadableStream.prototype.
Object.defineProperty(_PatchedReadableStream, Symbol.hasInstance, {
  value(instance) {
    return instance instanceof FastReadableStream
      || instance instanceof NativeReadableStream
      || isFastReadable(instance);
  },
  configurable: true,
});

export function patchGlobalWebStreams(options) {
  const opts = options || {};
  globalThis.ReadableStream = _PatchedReadableStream;
  if (!opts.skipWritable) {
    globalThis.WritableStream = FastWritableStream;
  }
  if (!opts.skipTransform) {
    globalThis.TransformStream = FastTransformStream;
  }
  globalThis.ByteLengthQueuingStrategy = NativeByteLengthQueuingStrategy;
  globalThis.CountQueuingStrategy = NativeCountQueuingStrategy;

  // Make Fast instances pass instanceof checks against the captured native constructors.
  Object.defineProperty(NativeReadableStream, Symbol.hasInstance, {
    value(instance) {
      if (_origHasInstanceRS) {
        try { if (_origHasInstanceRS.value.call(NativeReadableStream, instance)) return true; } catch {}
      }
      return instance instanceof FastReadableStream || isFastReadable(instance);
    },
    configurable: true,
  });
  if (!opts.skipWritable) {
    Object.defineProperty(NativeWritableStream, Symbol.hasInstance, {
      value(instance) {
        if (_origHasInstanceWS) {
          try { if (_origHasInstanceWS.value.call(NativeWritableStream, instance)) return true; } catch {}
        }
        return instance instanceof FastWritableStream || isFastWritable(instance);
      },
      configurable: true,
    });
  }
  if (!opts.skipTransform) {
    Object.defineProperty(NativeTransformStream, Symbol.hasInstance, {
      value(instance) {
        if (_origHasInstanceTS) {
          try { if (_origHasInstanceTS.value.call(NativeTransformStream, instance)) return true; } catch {}
        }
        return instance instanceof FastTransformStream || isFastTransform(instance);
      },
      configurable: true,
    });
  }
}

/**
 * Restore the original native stream constructors and Symbol.hasInstance.
 */
export function unpatchGlobalWebStreams() {
  globalThis.ReadableStream = NativeReadableStream;
  globalThis.WritableStream = NativeWritableStream;
  globalThis.TransformStream = NativeTransformStream;
  globalThis.ByteLengthQueuingStrategy = NativeByteLengthQueuingStrategy;
  globalThis.CountQueuingStrategy = NativeCountQueuingStrategy;

  // Restore original Symbol.hasInstance
  if (_origHasInstanceRS) {
    Object.defineProperty(NativeReadableStream, Symbol.hasInstance, _origHasInstanceRS);
  } else {
    delete NativeReadableStream[Symbol.hasInstance];
  }
  if (_origHasInstanceWS) {
    Object.defineProperty(NativeWritableStream, Symbol.hasInstance, _origHasInstanceWS);
  } else {
    delete NativeWritableStream[Symbol.hasInstance];
  }
  if (_origHasInstanceTS) {
    Object.defineProperty(NativeTransformStream, Symbol.hasInstance, _origHasInstanceTS);
  } else {
    delete NativeTransformStream[Symbol.hasInstance];
  }
}
