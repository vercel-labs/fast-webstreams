/**
 * Edge runtime shim: re-exports the native globals as-is.
 *
 * Edge runtimes (Vercel Edge, Cloudflare Workers) already have fast
 * WebStreams implementations and don't support node:stream.
 * This module provides the same API surface so imports resolve
 * without pulling in Node.js-specific modules.
 */

export const FastReadableStream = ReadableStream;
export const FastWritableStream = WritableStream;
export const FastTransformStream = TransformStream;
export const FastReadableStreamDefaultReader = ReadableStreamDefaultReader;
export const FastWritableStreamDefaultWriter = WritableStreamDefaultWriter;

// No BYOB reader export — edge runtimes support it natively via getReader({ mode: 'byob' })
export const FastReadableStreamBYOBReader = ReadableStreamBYOBReader;

/** No-op on edge — streams are already fast. */
export function patchGlobalWebStreams() {}

/** No-op on edge. */
export function unpatchGlobalWebStreams() {}
