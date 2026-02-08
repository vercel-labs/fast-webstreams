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
export function patchGlobalWebStreams() {
  globalThis.ReadableStream = FastReadableStream;
  globalThis.WritableStream = FastWritableStream;
  globalThis.TransformStream = FastTransformStream;
  globalThis.ByteLengthQueuingStrategy = NativeByteLengthQueuingStrategy;
  globalThis.CountQueuingStrategy = NativeCountQueuingStrategy;

  // Make Fast instances pass instanceof checks against the captured native constructors.
  Object.defineProperty(NativeReadableStream, Symbol.hasInstance, {
    value(instance) {
      return instance instanceof FastReadableStream || isFastReadable(instance);
    },
    configurable: true,
  });
  Object.defineProperty(NativeWritableStream, Symbol.hasInstance, {
    value(instance) {
      return instance instanceof FastWritableStream || isFastWritable(instance);
    },
    configurable: true,
  });
  Object.defineProperty(NativeTransformStream, Symbol.hasInstance, {
    value(instance) {
      return instance instanceof FastTransformStream || isFastTransform(instance);
    },
    configurable: true,
  });
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
