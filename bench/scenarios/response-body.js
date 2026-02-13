/**
 * Response body scenario: tests `new Response(stream)` integration.
 * Measures Response.text() consumption and response forwarding through transforms.
 */

import { FastReadableStream, FastWritableStream, FastTransformStream } from '../../src/index.js';

function makeChunk(size) {
  return Buffer.alloc(size, 0x41);
}

export default {
  name: 'response-body',
  description: 'Response body: new Response(stream).text() and forwarding through transforms',
  variants: [
    {
      name: 'web-response-text',
      skipIf: ({ chunkSize }) => chunkSize < 1024,
      fn: async ({ chunkSize, totalBytes, highWaterMark }) => {
        const chunk = makeChunk(chunkSize);
        let remaining = totalBytes;
        const readable = new ReadableStream(
          {
            type: 'bytes',
            pull(controller) {
              if (remaining <= 0) { controller.close(); return; }
              const size = Math.min(chunk.length, remaining);
              remaining -= size;
              const buf = new Uint8Array(size);
              buf.set(size === chunk.length ? chunk : chunk.subarray(0, size));
              controller.enqueue(buf);
            },
          },
        );

        const text = await new Response(readable).text();
        return { bytesProcessed: text.length };
      },
    },
    {
      name: 'fast-response-text',
      skipIf: ({ chunkSize }) => chunkSize < 1024,
      fn: async ({ chunkSize, totalBytes }) => {
        const chunk = makeChunk(chunkSize);
        let remaining = totalBytes;
        const readable = new FastReadableStream({
          type: 'bytes',
          pull(controller) {
            if (remaining <= 0) { controller.close(); return; }
            const size = Math.min(chunk.length, remaining);
            remaining -= size;
            const buf = new Uint8Array(size);
            buf.set(size === chunk.length ? chunk : chunk.subarray(0, size));
            controller.enqueue(buf);
          },
        });

        const text = await new Response(readable).text();
        return { bytesProcessed: text.length };
      },
    },
    {
      name: 'web-response-forward',
      skipIf: ({ chunkSize }) => chunkSize < 1024,
      fn: async ({ chunkSize, totalBytes, highWaterMark }) => {
        const chunk = makeChunk(chunkSize);
        let remaining = totalBytes;
        const readable = new ReadableStream(
          {
            type: 'bytes',
            pull(controller) {
              if (remaining <= 0) { controller.close(); return; }
              const size = Math.min(chunk.length, remaining);
              remaining -= size;
              const buf = new Uint8Array(size);
              buf.set(size === chunk.length ? chunk : chunk.subarray(0, size));
              controller.enqueue(buf);
            },
          },
        );

        const response = new Response(readable);
        const transform = new TransformStream(
          { transform(c, ctrl) { ctrl.enqueue(c); } },
          new ByteLengthQueuingStrategy({ highWaterMark }),
          new ByteLengthQueuingStrategy({ highWaterMark }),
        );
        let bytesWritten = 0;
        const writable = new WritableStream(
          { write(c) { bytesWritten += c.length; } },
          new ByteLengthQueuingStrategy({ highWaterMark }),
        );

        await response.body.pipeThrough(transform).pipeTo(writable);
        return { bytesProcessed: bytesWritten };
      },
    },
    {
      name: 'fast-response-forward',
      skipIf: ({ chunkSize }) => chunkSize < 1024,
      fn: async ({ chunkSize, totalBytes, highWaterMark }) => {
        const chunk = makeChunk(chunkSize);
        const countHWM = Math.max(1, Math.ceil(highWaterMark / chunkSize));
        let remaining = totalBytes;
        const readable = new FastReadableStream({
          type: 'bytes',
          pull(controller) {
            if (remaining <= 0) { controller.close(); return; }
            const size = Math.min(chunk.length, remaining);
            remaining -= size;
            const buf = new Uint8Array(size);
            buf.set(size === chunk.length ? chunk : chunk.subarray(0, size));
            controller.enqueue(buf);
          },
        });

        const response = new Response(readable);
        const transform = new FastTransformStream(
          { transform(c, ctrl) { ctrl.enqueue(c); } },
          { highWaterMark: countHWM },
          { highWaterMark: countHWM },
        );
        let bytesWritten = 0;
        const writable = new FastWritableStream(
          { write(c) { bytesWritten += c.length; } },
          { highWaterMark: countHWM },
        );

        await response.body.pipeThrough(transform).pipeTo(writable);
        return { bytesProcessed: bytesWritten };
      },
    },
    {
      name: 'web-fetch-transform',
      fn: async ({ chunkSize, totalBytes }) => {
        // Exact Next.js bench pattern: byte stream (HWM=0) → Response → pipeThrough → reader loop
        const data = makeChunk(chunkSize);
        const numChunks = totalBytes / chunkSize;
        let n = 0;
        const body = new ReadableStream(
          {
            type: 'bytes',
            pull(controller) {
              if (n >= numChunks) { controller.close(); return; }
              controller.enqueue(new Uint8Array(data));
              n++;
            },
          },
          { highWaterMark: 0 },
        );
        const response = new Response(body);
        const transformed = response.body.pipeThrough(new TransformStream({
          transform(chunk, ctrl) { ctrl.enqueue(chunk); },
        }));
        const reader = transformed.getReader();
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
      name: 'fast-fetch-transform',
      fn: async ({ chunkSize, totalBytes }) => {
        // Same pattern with Fast streams
        const data = makeChunk(chunkSize);
        const numChunks = totalBytes / chunkSize;
        let n = 0;
        const body = new FastReadableStream(
          {
            type: 'bytes',
            pull(controller) {
              if (n >= numChunks) { controller.close(); return; }
              controller.enqueue(new Uint8Array(data));
              n++;
            },
          },
        );
        const response = new Response(body);
        const transformed = response.body.pipeThrough(new FastTransformStream({
          transform(chunk, ctrl) { ctrl.enqueue(chunk); },
        }));
        const reader = transformed.getReader();
        let bytesRead = 0;
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          bytesRead += value.length;
        }
        return { bytesProcessed: bytesRead };
      },
    },
  ],
};
