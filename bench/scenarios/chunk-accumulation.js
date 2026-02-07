/**
 * Chunk accumulation scenario: many small chunks buffered into larger ones.
 * Common in HTTP response assembly, protocol framing, etc.
 * Only meaningful for small chunk sizes (<=16KB).
 */

import { Readable, Writable, Transform, pipeline } from 'node:stream';
import { promisify } from 'node:util';
import { FastReadableStream, FastWritableStream, FastTransformStream } from '../../src/index.js';

const pipelineAsync = promisify(pipeline);

// Target accumulated chunk size
const ACCUMULATE_SIZE = 65536; // 64KB

function makeChunk(size) {
  return Buffer.alloc(size, 0x42); // 'B'
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
 * Node.js Transform that accumulates small chunks into ACCUMULATE_SIZE buffers.
 */
function createNodeAccumulator() {
  let buffer = Buffer.alloc(0);
  return new Transform({
    transform(chunk, _encoding, cb) {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= ACCUMULATE_SIZE) {
        this.push(buffer.subarray(0, ACCUMULATE_SIZE));
        buffer = buffer.subarray(ACCUMULATE_SIZE);
      }
      cb();
    },
    flush(cb) {
      if (buffer.length > 0) {
        this.push(buffer);
      }
      cb();
    },
  });
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

/**
 * WHATWG TransformStream that accumulates small chunks into ACCUMULATE_SIZE buffers.
 */
function createWebAccumulator(highWaterMark) {
  let buffer = new Uint8Array(0);

  return new TransformStream(
    {
      transform(chunk, controller) {
        // Concatenate
        const combined = new Uint8Array(buffer.length + chunk.length);
        combined.set(buffer);
        combined.set(chunk, buffer.length);
        buffer = combined;

        while (buffer.length >= ACCUMULATE_SIZE) {
          controller.enqueue(buffer.slice(0, ACCUMULATE_SIZE));
          buffer = buffer.slice(ACCUMULATE_SIZE);
        }
      },
      flush(controller) {
        if (buffer.length > 0) {
          controller.enqueue(buffer);
        }
      },
    },
    new ByteLengthQueuingStrategy({ highWaterMark }),
    new ByteLengthQueuingStrategy({ highWaterMark })
  );
}

export default {
  name: 'chunk-accumulation',
  description: 'Small chunks accumulated into 64KB buffers (HTTP response assembly pattern)',
  variants: [
    {
      name: 'node-transform-pipeline',
      skipIf: ({ chunkSize }) => chunkSize > 16384,
      fn: async ({ chunkSize, totalBytes }) => {
        const chunk = makeChunk(chunkSize);
        const readable = createNodeReadable(chunk, totalBytes);
        const accumulator = createNodeAccumulator();
        const writable = createNodeWritable();

        await pipelineAsync(readable, accumulator, writable);

        return { bytesProcessed: writable.getBytesWritten() };
      },
    },
    {
      name: 'web-pipeThrough',
      skipIf: ({ chunkSize }) => chunkSize > 16384,
      fn: async ({ chunkSize, totalBytes, highWaterMark }) => {
        const chunk = makeChunk(chunkSize);
        const readable = createWebReadable(chunk, totalBytes, highWaterMark);
        const accumulator = createWebAccumulator(highWaterMark);
        const writable = createWebWritable(highWaterMark);

        await readable.pipeThrough(accumulator).pipeTo(writable);

        return { bytesProcessed: writable.getBytesWritten() };
      },
    },
    {
      name: 'fast-pipeThrough',
      skipIf: ({ chunkSize }) => chunkSize > 16384,
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
        let buffer = Buffer.alloc(0);
        const transform = new FastTransformStream(
          {
            transform(c, controller) {
              buffer = Buffer.concat([buffer, c]);
              while (buffer.length >= ACCUMULATE_SIZE) {
                controller.enqueue(buffer.subarray(0, ACCUMULATE_SIZE));
                buffer = buffer.subarray(ACCUMULATE_SIZE);
              }
            },
            flush(controller) {
              if (buffer.length > 0) {
                controller.enqueue(buffer);
              }
            },
          },
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
