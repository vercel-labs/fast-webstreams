/**
 * Fetch-bridge scenario: simulates the Next.js pattern of
 * fetch response body → pipeThrough(transform chain) → pipeTo(sink).
 *
 * Fetch response bodies are byte streams (type: 'bytes'), which create
 * kNativeOnly shells in FastReadableStream. This benchmark measures:
 *
 *   1. native: full native WebStreams (baseline)
 *   2. fast-bridge: byte stream bridges to Fast, downstream uses pipeline
 *   3. fast-no-bridge: all-Fast (non-byte source), full pipeline fast path
 *
 * The bridge approach trades 1 Promise per chunk at the bridge boundary
 * for zero-promise Node.js pipeline on all downstream transforms.
 */

import { FastReadableStream, FastWritableStream, FastTransformStream } from '../../src/index.js';
import { _initNativeReadableShell } from '../../src/readable.js';

const { ReadableStream: NativeReadableStream, WritableStream: NativeWritableStream, TransformStream: NativeTransformStream } = globalThis;

function makeChunk(size) {
  return Buffer.alloc(size, 0x41);
}

/**
 * Create a native byte stream (type: 'bytes') — simulates what undici/fetch creates.
 * Note: byte streams transfer buffer ownership, so we must create new buffers each time.
 */
function createByteReadable(chunk, totalBytes) {
  let remaining = totalBytes;
  return new NativeReadableStream({
    type: 'bytes',
    pull(controller) {
      if (remaining <= 0) {
        controller.close();
        return;
      }
      const size = Math.min(chunk.length, remaining);
      remaining -= size;
      // Byte stream transfers ownership — must allocate new buffer each time
      const buf = new Uint8Array(size);
      buf.set(size === chunk.length ? chunk : chunk.subarray(0, size));
      controller.enqueue(buf);
    },
  });
}

/**
 * Create a FastReadableStream byte stream shell — simulates fetch body after patching.
 */
function createFastByteReadable(chunk, totalBytes) {
  let remaining = totalBytes;
  return new FastReadableStream({
    type: 'bytes',
    pull(controller) {
      if (remaining <= 0) {
        controller.close();
        return;
      }
      const size = Math.min(chunk.length, remaining);
      remaining -= size;
      const buf = new Uint8Array(size);
      buf.set(size === chunk.length ? chunk : chunk.subarray(0, size));
      controller.enqueue(buf);
    },
  });
}

/**
 * Create a non-byte FastReadableStream — full fast path (no bridge needed).
 */
function createFastReadable(chunk, totalBytes, chunkSize) {
  const countHWM = Math.max(1, Math.ceil(16384 / chunkSize));
  let remaining = totalBytes;
  return new FastReadableStream(
    {
      pull(controller) {
        if (remaining <= 0) {
          controller.close();
          return;
        }
        const size = Math.min(chunk.length, remaining);
        const buf = size === chunk.length ? chunk : chunk.subarray(0, size);
        remaining -= size;
        controller.enqueue(buf);
      },
    },
    { highWaterMark: countHWM }
  );
}

/**
 * Wrap a native ReadableStream in a kNativeOnly FastReadableStream shell.
 * Simulates what happens when undici/fetch creates a native stream and user
 * code treats it as a FastReadableStream (e.g., after patchGlobalWebStreams).
 * pipeThrough on this shell triggers _bridgeNativeToFast().
 */
function createNativeOnlyShell(chunk, totalBytes) {
  const native = createByteReadable(chunk, totalBytes);
  const shell = Object.create(FastReadableStream.prototype);
  _initNativeReadableShell(shell, native);
  return shell;
}

const NUM_TRANSFORMS = 3;

export default {
  name: 'fetch-bridge',
  description: 'Fetch body (byte stream) → pipeThrough(3 transforms) → pipeTo(sink)',
  variants: [
    {
      name: 'native-pipeThrough',
      fn: async ({ chunkSize, totalBytes, highWaterMark }) => {
        const chunk = makeChunk(chunkSize);
        let stream = createByteReadable(chunk, totalBytes);
        for (let i = 0; i < NUM_TRANSFORMS; i++) {
          stream = stream.pipeThrough(new NativeTransformStream(
            {},
            new ByteLengthQueuingStrategy({ highWaterMark }),
            new ByteLengthQueuingStrategy({ highWaterMark }),
          ));
        }
        let bytesWritten = 0;
        const writable = new NativeWritableStream(
          { write(c) { bytesWritten += c.length; } },
          new ByteLengthQueuingStrategy({ highWaterMark }),
        );
        await stream.pipeTo(writable);
        return { bytesProcessed: bytesWritten };
      },
    },
    {
      name: 'fast-bridge-pipeThrough',
      fn: async ({ chunkSize, totalBytes, highWaterMark }) => {
        const chunk = makeChunk(chunkSize);
        const countHWM = Math.max(1, Math.ceil(highWaterMark / chunkSize));
        // Byte stream (kNativeOnly) — bridge kicks in at first pipeThrough
        let stream = createFastByteReadable(chunk, totalBytes);
        for (let i = 0; i < NUM_TRANSFORMS; i++) {
          stream = stream.pipeThrough(new FastTransformStream(
            {},
            { highWaterMark: countHWM },
            { highWaterMark: countHWM },
          ));
        }
        let bytesWritten = 0;
        const writable = new FastWritableStream(
          { write(c) { bytesWritten += c.length; } },
          { highWaterMark: countHWM },
        );
        await stream.pipeTo(writable);
        return { bytesProcessed: bytesWritten };
      },
    },
    {
      name: 'fast-no-bridge-pipeThrough',
      fn: async ({ chunkSize, totalBytes, highWaterMark }) => {
        const chunk = makeChunk(chunkSize);
        const countHWM = Math.max(1, Math.ceil(highWaterMark / chunkSize));
        // Non-byte source — full fast pipeline path (no bridge overhead)
        let stream = createFastReadable(chunk, totalBytes, chunkSize);
        for (let i = 0; i < NUM_TRANSFORMS; i++) {
          stream = stream.pipeThrough(new FastTransformStream(
            {},
            { highWaterMark: countHWM },
            { highWaterMark: countHWM },
          ));
        }
        let bytesWritten = 0;
        const writable = new FastWritableStream(
          { write(c) { bytesWritten += c.length; } },
          { highWaterMark: countHWM },
        );
        await stream.pipeTo(writable);
        return { bytesProcessed: bytesWritten };
      },
    },
    {
      name: 'fast-bridge-pipeTo-signal',
      fn: async ({ chunkSize, totalBytes, highWaterMark }) => {
        const chunk = makeChunk(chunkSize);
        const countHWM = Math.max(1, Math.ceil(highWaterMark / chunkSize));
        // Byte stream + signal → Tier 0.5 (specPipeTo per hop)
        let stream = createFastByteReadable(chunk, totalBytes);
        for (let i = 0; i < NUM_TRANSFORMS; i++) {
          stream = stream.pipeThrough(new FastTransformStream(
            {},
            { highWaterMark: countHWM },
            { highWaterMark: countHWM },
          ));
        }
        let bytesWritten = 0;
        const writable = new FastWritableStream(
          { write(c) { bytesWritten += c.length; } },
          { highWaterMark: countHWM },
        );
        const ac = new AbortController();
        await stream.pipeTo(writable, { signal: ac.signal });
        return { bytesProcessed: bytesWritten };
      },
    },
    {
      name: 'native-pipeTo-signal',
      fn: async ({ chunkSize, totalBytes, highWaterMark }) => {
        const chunk = makeChunk(chunkSize);
        let stream = createByteReadable(chunk, totalBytes);
        for (let i = 0; i < NUM_TRANSFORMS; i++) {
          stream = stream.pipeThrough(new NativeTransformStream(
            {},
            new ByteLengthQueuingStrategy({ highWaterMark }),
            new ByteLengthQueuingStrategy({ highWaterMark }),
          ));
        }
        let bytesWritten = 0;
        const writable = new NativeWritableStream(
          { write(c) { bytesWritten += c.length; } },
          new ByteLengthQueuingStrategy({ highWaterMark }),
        );
        const ac = new AbortController();
        await stream.pipeTo(writable, { signal: ac.signal });
        return { bytesProcessed: bytesWritten };
      },
    },
    {
      name: 'fast-native-bridge',
      fn: async ({ chunkSize, totalBytes, highWaterMark }) => {
        const chunk = makeChunk(chunkSize);
        const countHWM = Math.max(1, Math.ceil(highWaterMark / chunkSize));
        // Native source wrapped as kNativeOnly shell — triggers _bridgeNativeToFast
        // at first pipeThrough, then downstream uses Node.js pipeline (Tier 0)
        let stream = createNativeOnlyShell(chunk, totalBytes);
        for (let i = 0; i < NUM_TRANSFORMS; i++) {
          stream = stream.pipeThrough(new FastTransformStream(
            {},
            { highWaterMark: countHWM },
            { highWaterMark: countHWM },
          ));
        }
        let bytesWritten = 0;
        const writable = new FastWritableStream(
          { write(c) { bytesWritten += c.length; } },
          { highWaterMark: countHWM },
        );
        await stream.pipeTo(writable);
        return { bytesProcessed: bytesWritten };
      },
    },
    {
      name: 'fast-native-bridge-signal',
      fn: async ({ chunkSize, totalBytes, highWaterMark }) => {
        const chunk = makeChunk(chunkSize);
        const countHWM = Math.max(1, Math.ceil(highWaterMark / chunkSize));
        // Native source wrapped as kNativeOnly shell + signal — triggers bridge,
        // then Tier 0.5 (specPipeTo per hop with batch write optimization)
        let stream = createNativeOnlyShell(chunk, totalBytes);
        for (let i = 0; i < NUM_TRANSFORMS; i++) {
          stream = stream.pipeThrough(new FastTransformStream(
            {},
            { highWaterMark: countHWM },
            { highWaterMark: countHWM },
          ));
        }
        let bytesWritten = 0;
        const writable = new FastWritableStream(
          { write(c) { bytesWritten += c.length; } },
          { highWaterMark: countHWM },
        );
        const ac = new AbortController();
        await stream.pipeTo(writable, { signal: ac.signal });
        return { bytesProcessed: bytesWritten };
      },
    },
  ],
};
