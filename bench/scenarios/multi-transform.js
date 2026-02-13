/**
 * Multi-transform scenario: measures transform chain depth overhead.
 * This is the core Next.js SSR pipeline shape — multiple transforms chained.
 * All transforms have explicit JS identity callback to measure per-hop cost.
 */

import { PassThrough, Readable, Writable, pipeline } from 'node:stream';
import { promisify } from 'node:util';
import { FastReadableStream, FastWritableStream, FastTransformStream } from '../../src/index.js';

const pipelineAsync = promisify(pipeline);

function makeChunk(size) {
  return Buffer.alloc(size, 0x41);
}

function createNodeReadable(chunk, totalBytes) {
  let remaining = totalBytes;
  return new Readable({
    read() {
      if (remaining <= 0) {
        this.push(null);
        return;
      }
      const size = Math.min(chunk.length, remaining);
      const buf = size === chunk.length ? chunk : chunk.subarray(0, size);
      remaining -= size;
      this.push(buf);
    },
  });
}

export default {
  name: 'multi-transform',
  description: 'Transform chain depth: 3x and 8x identity transforms',
  variants: [
    {
      name: 'node-3x-pipeline',
      fn: async ({ chunkSize, totalBytes }) => {
        const chunk = makeChunk(chunkSize);
        const readable = createNodeReadable(chunk, totalBytes);
        const transforms = Array.from({ length: 3 }, () => new PassThrough());
        let bytesWritten = 0;
        const writable = new Writable({
          write(c, _enc, cb) { bytesWritten += c.length; cb(); },
        });

        await pipelineAsync(readable, ...transforms, writable);
        return { bytesProcessed: bytesWritten };
      },
    },
    {
      name: 'web-3x-pipeThrough',
      fn: async ({ chunkSize, totalBytes, highWaterMark }) => {
        const chunk = makeChunk(chunkSize);
        let remaining = totalBytes;
        let stream = new ReadableStream(
          {
            pull(controller) {
              if (remaining <= 0) { controller.close(); return; }
              const size = Math.min(chunk.length, remaining);
              const buf = size === chunk.length ? chunk : chunk.subarray(0, size);
              remaining -= size;
              controller.enqueue(buf);
            },
          },
          new ByteLengthQueuingStrategy({ highWaterMark })
        );

        for (let i = 0; i < 3; i++) {
          stream = stream.pipeThrough(new TransformStream(
            { transform(c, ctrl) { ctrl.enqueue(c); } },
            new ByteLengthQueuingStrategy({ highWaterMark }),
            new ByteLengthQueuingStrategy({ highWaterMark }),
          ));
        }

        let bytesWritten = 0;
        const writable = new WritableStream(
          { write(c) { bytesWritten += c.length; } },
          new ByteLengthQueuingStrategy({ highWaterMark }),
        );
        await stream.pipeTo(writable);
        return { bytesProcessed: bytesWritten };
      },
    },
    {
      name: 'fast-3x-pipeThrough',
      fn: async ({ chunkSize, totalBytes, highWaterMark }) => {
        const chunk = makeChunk(chunkSize);
        const countHWM = Math.max(1, Math.ceil(highWaterMark / chunkSize));
        let remaining = totalBytes;
        let stream = new FastReadableStream(
          {
            pull(controller) {
              if (remaining <= 0) { controller.close(); return; }
              const size = Math.min(chunk.length, remaining);
              const buf = size === chunk.length ? chunk : chunk.subarray(0, size);
              remaining -= size;
              controller.enqueue(buf);
            },
          },
          { highWaterMark: countHWM }
        );

        for (let i = 0; i < 3; i++) {
          stream = stream.pipeThrough(new FastTransformStream(
            { transform(c, ctrl) { ctrl.enqueue(c); } },
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
      name: 'node-8x-pipeline',
      fn: async ({ chunkSize, totalBytes }) => {
        const chunk = makeChunk(chunkSize);
        const readable = createNodeReadable(chunk, totalBytes);
        const transforms = Array.from({ length: 8 }, () => new PassThrough());
        let bytesWritten = 0;
        const writable = new Writable({
          write(c, _enc, cb) { bytesWritten += c.length; cb(); },
        });

        await pipelineAsync(readable, ...transforms, writable);
        return { bytesProcessed: bytesWritten };
      },
    },
    {
      name: 'web-8x-pipeThrough',
      fn: async ({ chunkSize, totalBytes, highWaterMark }) => {
        const chunk = makeChunk(chunkSize);
        let remaining = totalBytes;
        let stream = new ReadableStream(
          {
            pull(controller) {
              if (remaining <= 0) { controller.close(); return; }
              const size = Math.min(chunk.length, remaining);
              const buf = size === chunk.length ? chunk : chunk.subarray(0, size);
              remaining -= size;
              controller.enqueue(buf);
            },
          },
          new ByteLengthQueuingStrategy({ highWaterMark })
        );

        for (let i = 0; i < 8; i++) {
          stream = stream.pipeThrough(new TransformStream(
            { transform(c, ctrl) { ctrl.enqueue(c); } },
            new ByteLengthQueuingStrategy({ highWaterMark }),
            new ByteLengthQueuingStrategy({ highWaterMark }),
          ));
        }

        let bytesWritten = 0;
        const writable = new WritableStream(
          { write(c) { bytesWritten += c.length; } },
          new ByteLengthQueuingStrategy({ highWaterMark }),
        );
        await stream.pipeTo(writable);
        return { bytesProcessed: bytesWritten };
      },
    },
    {
      name: 'fast-8x-pipeThrough',
      fn: async ({ chunkSize, totalBytes, highWaterMark }) => {
        const chunk = makeChunk(chunkSize);
        const countHWM = Math.max(1, Math.ceil(highWaterMark / chunkSize));
        let remaining = totalBytes;
        let stream = new FastReadableStream(
          {
            pull(controller) {
              if (remaining <= 0) { controller.close(); return; }
              const size = Math.min(chunk.length, remaining);
              const buf = size === chunk.length ? chunk : chunk.subarray(0, size);
              remaining -= size;
              controller.enqueue(buf);
            },
          },
          { highWaterMark: countHWM }
        );

        for (let i = 0; i < 8; i++) {
          stream = stream.pipeThrough(new FastTransformStream(
            { transform(c, ctrl) { ctrl.enqueue(c); } },
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
  ],
};
