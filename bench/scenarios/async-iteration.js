/**
 * Async iteration scenario: measures `for await...of` vs reader.read() loop.
 * This is the dominant consumption pattern in Next.js route handlers and
 * modern Node.js backends.
 */

import { FastReadableStream } from '../../src/index.js';

function makeChunk(size) {
  return Buffer.alloc(size, 0x41);
}

function createWebReadable(chunk, totalBytes, highWaterMark) {
  let remaining = totalBytes;
  return new ReadableStream(
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
    new ByteLengthQueuingStrategy({ highWaterMark })
  );
}

function createFastReadable(chunk, totalBytes, highWaterMark, chunkSize) {
  const countHWM = Math.max(1, Math.ceil(highWaterMark / chunkSize));
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

export default {
  name: 'async-iteration',
  description: 'for-await-of vs reader.read() loop (Next.js route handler pattern)',
  variants: [
    {
      name: 'web-reader-loop',
      fn: async ({ chunkSize, totalBytes, highWaterMark }) => {
        const chunk = makeChunk(chunkSize);
        const readable = createWebReadable(chunk, totalBytes, highWaterMark);
        const reader = readable.getReader();
        let bytesRead = 0;

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          bytesRead += value.length;
        }

        return { bytesProcessed: bytesRead };
      },
    },
    {
      name: 'web-for-await',
      fn: async ({ chunkSize, totalBytes, highWaterMark }) => {
        const chunk = makeChunk(chunkSize);
        const readable = createWebReadable(chunk, totalBytes, highWaterMark);
        let bytesRead = 0;

        for await (const value of readable) {
          bytesRead += value.length;
        }

        return { bytesProcessed: bytesRead };
      },
    },
    {
      name: 'fast-reader-loop',
      fn: async ({ chunkSize, totalBytes, highWaterMark }) => {
        const chunk = makeChunk(chunkSize);
        const readable = createFastReadable(chunk, totalBytes, highWaterMark, chunkSize);
        const reader = readable.getReader();
        let bytesRead = 0;

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          bytesRead += value.length;
        }

        return { bytesProcessed: bytesRead };
      },
    },
    {
      name: 'fast-for-await',
      fn: async ({ chunkSize, totalBytes, highWaterMark }) => {
        const chunk = makeChunk(chunkSize);
        const readable = createFastReadable(chunk, totalBytes, highWaterMark, chunkSize);
        let bytesRead = 0;

        for await (const value of readable) {
          bytesRead += value.length;
        }

        return { bytesProcessed: bytesRead };
      },
    },
    {
      name: 'fast-byte-for-await',
      fn: async ({ chunkSize, totalBytes }) => {
        const chunk = makeChunk(chunkSize);
        let remaining = totalBytes;
        const readable = new FastReadableStream({
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
        let bytesRead = 0;

        for await (const value of readable) {
          bytesRead += value.length;
        }

        return { bytesProcessed: bytesRead };
      },
    },
    {
      name: 'web-byte-for-await',
      fn: async ({ chunkSize, totalBytes }) => {
        const chunk = makeChunk(chunkSize);
        let remaining = totalBytes;
        const readable = new ReadableStream({
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
        let bytesRead = 0;

        for await (const value of readable) {
          bytesRead += value.length;
        }

        return { bytesProcessed: bytesRead };
      },
    },
  ],
};
