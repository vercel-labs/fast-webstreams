/**
 * Global patcher: replaces the built-in ReadableStream, WritableStream,
 * and TransformStream with fast alternatives.
 *
 * IMPORTANT: The native constructors are captured by src/natives.js at import
 * time, BEFORE this module can overwrite globalThis. Our internal code imports
 * from natives.js, so it continues to use the real originals.
 *
 * Usage:
 *   import { patchGlobalWebStreams, unpatchGlobalWebStreams } from 'experimental-fast-webstreams/patch';
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

/**
 * Replace the global stream constructors with fast alternatives.
 * Safe to call multiple times — subsequent calls are no-ops.
 */
export function patchGlobalWebStreams() {
  globalThis.ReadableStream = FastReadableStream;
  globalThis.WritableStream = FastWritableStream;
  globalThis.TransformStream = FastTransformStream;
  globalThis.ByteLengthQueuingStrategy = NativeByteLengthQueuingStrategy;
  globalThis.CountQueuingStrategy = NativeCountQueuingStrategy;
}

/**
 * Restore the original native stream constructors.
 */
export function unpatchGlobalWebStreams() {
  globalThis.ReadableStream = NativeReadableStream;
  globalThis.WritableStream = NativeWritableStream;
  globalThis.TransformStream = NativeTransformStream;
  globalThis.ByteLengthQueuingStrategy = NativeByteLengthQueuingStrategy;
  globalThis.CountQueuingStrategy = NativeCountQueuingStrategy;
}
