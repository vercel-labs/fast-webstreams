/**
 * Byte stream scenario: React Flight start+enqueue pattern.
 * All chunks pre-enqueued synchronously via saved controller, then drained.
 * This is the most important Next.js pattern — measures start+enqueue overhead.
 */

import { FastReadableStream } from '../../src/index.js';

function makeChunk(size) {
  return Buffer.alloc(size, 0x41);
}

export default {
  name: 'byte-stream',
  description: 'React Flight pattern: start(c) + sync enqueue all, then drain',
  variants: [
    {
      name: 'web-start-enqueue',
      fn: async ({ chunkSize, totalBytes }) => {
        const data = makeChunk(chunkSize);
        const numChunks = totalBytes / chunkSize;
        let ctrl;
        const readable = new ReadableStream({
          type: 'bytes',
          start(c) { ctrl = c; },
        });

        // Pre-enqueue all chunks synchronously
        for (let i = 0; i < numChunks; i++) {
          ctrl.enqueue(new Uint8Array(data));
        }
        ctrl.close();

        // Drain via reader loop
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
      name: 'fast-start-enqueue',
      fn: async ({ chunkSize, totalBytes }) => {
        const data = makeChunk(chunkSize);
        const numChunks = totalBytes / chunkSize;
        let ctrl;
        const readable = new FastReadableStream({
          type: 'bytes',
          start(c) { ctrl = c; },
        });

        for (let i = 0; i < numChunks; i++) {
          ctrl.enqueue(new Uint8Array(data));
        }
        ctrl.close();

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
      name: 'web-start-enqueue-response',
      fn: async ({ chunkSize, totalBytes }) => {
        const data = makeChunk(chunkSize);
        const numChunks = totalBytes / chunkSize;
        let ctrl;
        const readable = new ReadableStream({
          type: 'bytes',
          start(c) { ctrl = c; },
        });

        for (let i = 0; i < numChunks; i++) {
          ctrl.enqueue(new Uint8Array(data));
        }
        ctrl.close();

        const text = await new Response(readable).text();
        return { bytesProcessed: text.length };
      },
    },
    {
      name: 'fast-start-enqueue-response',
      fn: async ({ chunkSize, totalBytes }) => {
        const data = makeChunk(chunkSize);
        const numChunks = totalBytes / chunkSize;
        let ctrl;
        const readable = new FastReadableStream({
          type: 'bytes',
          start(c) { ctrl = c; },
        });

        for (let i = 0; i < numChunks; i++) {
          ctrl.enqueue(new Uint8Array(data));
        }
        ctrl.close();

        const text = await new Response(readable).text();
        return { bytesProcessed: text.length };
      },
    },
  ],
};
