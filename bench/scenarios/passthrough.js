/**
 * Passthrough scenario: measures pure stream overhead with no transformation.
 * Data flows from source -> sink with no processing, isolating the cost of
 * the streaming infrastructure itself.
 */

import { Readable, Writable, PassThrough, pipeline } from 'node:stream';
import { promisify } from 'node:util';
import { FastReadableStream, FastWritableStream, FastTransformStream } from '../../src/index.js';

const pipelineAsync = promisify(pipeline);

function makeChunk(size) {
  return Buffer.alloc(size, 0x41); // 'A'
}

/**
 * Create a Node.js Readable that emits `totalBytes / chunkSize` chunks.
 */
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

/**
 * Create a Node.js Writable that counts bytes written (blackhole sink).
 */
function createNodeWritable() {
  let bytesWritten = 0;
  const writable = new Writable({
    write(chunk, _encoding, cb) {
      bytesWritten += chunk.length;
      cb();
    },
  });
  writable.getBytesWritten = () => bytesWritten;
  return writable;
}

/**
 * Create a WHATWG ReadableStream that emits `totalBytes / chunkSize` chunks.
 * Uses ByteLengthQueuingStrategy for fair HWM comparison.
 */
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

/**
 * Create a WHATWG WritableStream blackhole sink.
 */
function createWebWritable(highWaterMark) {
  let bytesWritten = 0;
  const writable = new WritableStream(
    {
      write(chunk) {
        bytesWritten += chunk.length;
      },
    },
    new ByteLengthQueuingStrategy({ highWaterMark })
  );
  writable.getBytesWritten = () => bytesWritten;
  return writable;
}

export default {
  name: 'passthrough',
  description: 'Pure overhead: no transformation, measures streaming infrastructure cost',
  variants: [
    {
      name: 'node-pipe',
      fn: async ({ chunkSize, totalBytes }) => {
        const chunk = makeChunk(chunkSize);
        const readable = createNodeReadable(chunk, totalBytes);
        const writable = createNodeWritable();

        await new Promise((resolve, reject) => {
          readable.pipe(writable);
          writable.on('finish', resolve);
          writable.on('error', reject);
          readable.on('error', reject);
        });

        return { bytesProcessed: writable.getBytesWritten() };
      },
    },
    {
      name: 'node-pipeline',
      fn: async ({ chunkSize, totalBytes }) => {
        const chunk = makeChunk(chunkSize);
        const readable = createNodeReadable(chunk, totalBytes);
        const writable = createNodeWritable();

        await pipelineAsync(readable, writable);

        return { bytesProcessed: writable.getBytesWritten() };
      },
    },
    {
      name: 'node-transform-pipeline',
      fn: async ({ chunkSize, totalBytes }) => {
        const chunk = makeChunk(chunkSize);
        const readable = createNodeReadable(chunk, totalBytes);
        const passThrough = new PassThrough();
        const writable = createNodeWritable();

        await pipelineAsync(readable, passThrough, writable);

        return { bytesProcessed: writable.getBytesWritten() };
      },
    },
    {
      name: 'web-pipeTo',
      fn: async ({ chunkSize, totalBytes, highWaterMark }) => {
        const chunk = makeChunk(chunkSize);
        const readable = createWebReadable(chunk, totalBytes, highWaterMark);
        const writable = createWebWritable(highWaterMark);

        await readable.pipeTo(writable);

        return { bytesProcessed: writable.getBytesWritten() };
      },
    },
    {
      name: 'web-pipeThrough',
      fn: async ({ chunkSize, totalBytes, highWaterMark }) => {
        const chunk = makeChunk(chunkSize);
        const readable = createWebReadable(chunk, totalBytes, highWaterMark);
        const transform = new TransformStream(
          {},
          new ByteLengthQueuingStrategy({ highWaterMark }),
          new ByteLengthQueuingStrategy({ highWaterMark })
        );
        const writable = createWebWritable(highWaterMark);

        await readable.pipeThrough(transform).pipeTo(writable);

        return { bytesProcessed: writable.getBytesWritten() };
      },
    },
    {
      name: 'fast-pipeTo',
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
            write(c) {
              bytesWritten += c.length;
            },
          },
          new ByteLengthQueuingStrategy({ highWaterMark })
        );

        await readable.pipeTo(writable);

        return { bytesProcessed: bytesWritten };
      },
    },
    {
      name: 'fast-pipeThrough',
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
        const transform = new FastTransformStream(
          {},
          new ByteLengthQueuingStrategy({ highWaterMark }),
          new ByteLengthQueuingStrategy({ highWaterMark })
        );
        let bytesWritten = 0;
        const writable = new FastWritableStream(
          {
            write(c) {
              bytesWritten += c.length;
            },
          },
          new ByteLengthQueuingStrategy({ highWaterMark })
        );

        await readable.pipeThrough(transform).pipeTo(writable);

        return { bytesProcessed: bytesWritten };
      },
    },
  ],
};
