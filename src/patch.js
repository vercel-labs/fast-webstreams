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

// Save original Symbol.hasInstance descriptors for unpatch
const _origHasInstanceRS = Object.getOwnPropertyDescriptor(NativeReadableStream, Symbol.hasInstance);
const _origHasInstanceWS = Object.getOwnPropertyDescriptor(NativeWritableStream, Symbol.hasInstance);
const _origHasInstanceTS = Object.getOwnPropertyDescriptor(NativeTransformStream, Symbol.hasInstance);

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
    // Must return genuine native stream — undici uses C++ internal slots for body I/O.
    // Object.create(native) gives us native internal slots + Fast prototype methods.
    const native = new NativeReadableStream(underlyingSource, strategy);
    const shell = Object.create(native);
    _initNativeReadableShell(shell, native);
    shell.getReader = function(opts) { return FastReadableStream.prototype.getReader.call(this, opts); };
    // Delegate to native when counterpart isn't Fast — this shell has native
    // internal slots (via Object.create) so native pipeThrough/pipeTo work.
    // Fast's specPipeTo doesn't stream correctly with native writable targets.
    shell.pipeTo = function(dest, opts) {
      if (!isFastWritable(dest)) return NativeReadableStream.prototype.pipeTo.call(this, dest, opts);
      return FastReadableStream.prototype.pipeTo.call(this, dest, opts);
    };
    shell.pipeThrough = function(t, opts) {
      if (!isFastTransform(t)) return NativeReadableStream.prototype.pipeThrough.call(this, t, opts);
      return FastReadableStream.prototype.pipeThrough.call(this, t, opts);
    };
    shell.tee = function() { return FastReadableStream.prototype.tee.call(this); };
    shell.cancel = function(r) { return FastReadableStream.prototype.cancel.call(this, r); };
    shell._cancelInternal = FastReadableStream.prototype._cancelInternal;
    shell.values = function(opts) { return FastReadableStream.prototype.values.call(this, opts); };
    shell[Symbol.asyncIterator] = FastReadableStream.prototype[Symbol.asyncIterator];
    const lockedDesc = Object.getOwnPropertyDescriptor(FastReadableStream.prototype, 'locked');
    if (lockedDesc) {
      Object.defineProperty(shell, 'locked', {
        get() { return lockedDesc.get.call(this); },
        configurable: true,
      });
    }
    return shell;
  }
  return new FastReadableStream(underlyingSource, strategy);
}
_PatchedReadableStream.prototype = FastReadableStream.prototype;
_PatchedReadableStream.from = FastReadableStream.from;

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
