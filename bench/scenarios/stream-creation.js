/**
 * Stream creation scenario: measures pure construction overhead with no data transfer.
 * Next.js SSR creates hundreds of short-lived streams per request.
 * `totalBytes / chunkSize` = number of streams to create per iteration.
 */

import { FastReadableStream, FastWritableStream, FastTransformStream } from '../../src/index.js';

export default {
  name: 'stream-creation',
  description: 'Pure construction overhead (no data transfer), simulates SSR stream churn',
  variants: [
    {
      name: 'web-readable',
      fn: async ({ chunkSize, totalBytes }) => {
        const count = Math.floor(totalBytes / chunkSize);
        for (let i = 0; i < count; i++) {
          new ReadableStream({ pull() {} });
        }
        return { bytesProcessed: count * chunkSize };
      },
    },
    {
      name: 'fast-readable',
      fn: async ({ chunkSize, totalBytes }) => {
        const count = Math.floor(totalBytes / chunkSize);
        for (let i = 0; i < count; i++) {
          new FastReadableStream({ pull() {} });
        }
        return { bytesProcessed: count * chunkSize };
      },
    },
    {
      name: 'web-writable',
      fn: async ({ chunkSize, totalBytes }) => {
        const count = Math.floor(totalBytes / chunkSize);
        for (let i = 0; i < count; i++) {
          new WritableStream({ write() {} });
        }
        return { bytesProcessed: count * chunkSize };
      },
    },
    {
      name: 'fast-writable',
      fn: async ({ chunkSize, totalBytes }) => {
        const count = Math.floor(totalBytes / chunkSize);
        for (let i = 0; i < count; i++) {
          new FastWritableStream({ write() {} });
        }
        return { bytesProcessed: count * chunkSize };
      },
    },
    {
      name: 'web-transform',
      fn: async ({ chunkSize, totalBytes }) => {
        const count = Math.floor(totalBytes / chunkSize);
        for (let i = 0; i < count; i++) {
          new TransformStream({});
        }
        return { bytesProcessed: count * chunkSize };
      },
    },
    {
      name: 'fast-transform',
      fn: async ({ chunkSize, totalBytes }) => {
        const count = Math.floor(totalBytes / chunkSize);
        for (let i = 0; i < count; i++) {
          new FastTransformStream({});
        }
        return { bytesProcessed: count * chunkSize };
      },
    },
    {
      name: 'web-byte-readable',
      fn: async ({ chunkSize, totalBytes }) => {
        const count = Math.floor(totalBytes / chunkSize);
        for (let i = 0; i < count; i++) {
          new ReadableStream({ type: 'bytes', start() {} });
        }
        return { bytesProcessed: count * chunkSize };
      },
    },
    {
      name: 'fast-byte-readable',
      fn: async ({ chunkSize, totalBytes }) => {
        const count = Math.floor(totalBytes / chunkSize);
        for (let i = 0; i < count; i++) {
          new FastReadableStream({ type: 'bytes', start() {} });
        }
        return { bytesProcessed: count * chunkSize };
      },
    },
    {
      name: 'fast-pipeThrough-setup',
      fn: async ({ chunkSize, totalBytes }) => {
        const count = Math.floor(totalBytes / chunkSize);
        for (let i = 0; i < count; i++) {
          let ctrl;
          const readable = new FastReadableStream({
            start(c) { ctrl = c; },
          });
          const transform = new FastTransformStream({});
          const result = readable.pipeThrough(transform);
          ctrl.close();
          // Drain to completion
          const reader = result.getReader();
          while (true) {
            const { done } = await reader.read();
            if (done) break;
          }
        }
        return { bytesProcessed: count * chunkSize };
      },
    },
  ],
};
