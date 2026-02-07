/**
 * Backpressure scenario: slow consumer with 1ms delay per write.
 * Measures how well each streaming API handles backpressure signaling.
 * Uses reduced total bytes (10MB) since the delay dominates.
 * Skips chunks < 1KB since tiny chunks + delay = unreasonably long runs.
 */

import { Readable, Writable, pipeline } from 'node:stream';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { FastReadableStream, FastWritableStream } from '../../src/index.js';

const pipelineAsync = promisify(pipeline);

const WRITE_DELAY_MS = 1;

function makeChunk(size) {
  return Buffer.alloc(size, 0x43); // 'C'
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

function createSlowNodeWritable() {
  let bytesWritten = 0;
  const writable = new Writable({
    async write(chunk, _encoding, cb) {
      await delay(WRITE_DELAY_MS);
      bytesWritten += chunk.length;
      cb();
    },
  });
  writable.getBytesWritten = () => bytesWritten;
  return writable;
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

function createSlowWebWritable(highWaterMark) {
  let bytesWritten = 0;
  const writable = new WritableStream(
    {
      async write(chunk) {
        await delay(WRITE_DELAY_MS);
        bytesWritten += chunk.length;
      },
    },
    new ByteLengthQueuingStrategy({ highWaterMark })
  );
  writable.getBytesWritten = () => bytesWritten;
  return writable;
}

export default {
  name: 'backpressure',
  description: 'Slow consumer (1ms delay per write): tests backpressure signaling efficiency',
  variants: [
    {
      name: 'node-pipeline',
      skipIf: ({ chunkSize }) => chunkSize < 1024,
      fn: async ({ chunkSize, totalBytes }) => {
        const chunk = makeChunk(chunkSize);
        const readable = createNodeReadable(chunk, totalBytes);
        const writable = createSlowNodeWritable();

        await pipelineAsync(readable, writable);

        return { bytesProcessed: writable.getBytesWritten() };
      },
    },
    {
      name: 'web-pipeTo',
      skipIf: ({ chunkSize }) => chunkSize < 1024,
      fn: async ({ chunkSize, totalBytes, highWaterMark }) => {
        const chunk = makeChunk(chunkSize);
        const readable = createWebReadable(chunk, totalBytes, highWaterMark);
        const writable = createSlowWebWritable(highWaterMark);

        await readable.pipeTo(writable);

        return { bytesProcessed: writable.getBytesWritten() };
      },
    },
    {
      name: 'fast-pipeTo',
      skipIf: ({ chunkSize }) => chunkSize < 1024,
      fn: async ({ chunkSize, totalBytes, highWaterMark }) => {
        const chunk = makeChunk(chunkSize);
        let remaining = totalBytes;
        const readable = new FastReadableStream(
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
        let bytesWritten = 0;
        const writable = new FastWritableStream(
          {
            async write(c) {
              await delay(WRITE_DELAY_MS);
              bytesWritten += c.length;
            },
          },
          new ByteLengthQueuingStrategy({ highWaterMark })
        );

        await readable.pipeTo(writable);

        return { bytesProcessed: bytesWritten };
      },
    },
  ],
};
