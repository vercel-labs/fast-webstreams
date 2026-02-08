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

/**
 * Create a Fast ReadableStream with CountQueuingStrategy.
 */
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
        const countHWM = Math.max(1, Math.ceil(highWaterMark / chunkSize));
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
          { highWaterMark: countHWM }
        );
        let bytesWritten = 0;
        const writable = new FastWritableStream(
          {
            write(c) {
              bytesWritten += c.length;
            },
          },
          { highWaterMark: countHWM }
        );

        await readable.pipeTo(writable);

        return { bytesProcessed: bytesWritten };
      },
    },
    {
      name: 'fast-pipeThrough',
      fn: async ({ chunkSize, totalBytes, highWaterMark }) => {
        const chunk = makeChunk(chunkSize);
        const countHWM = Math.max(1, Math.ceil(highWaterMark / chunkSize));
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
          { highWaterMark: countHWM }
        );
        const transform = new FastTransformStream(
          {},
          { highWaterMark: countHWM },
          { highWaterMark: countHWM }
        );
        let bytesWritten = 0;
        const writable = new FastWritableStream(
          {
            write(c) {
              bytesWritten += c.length;
            },
          },
          { highWaterMark: countHWM }
        );

        await readable.pipeThrough(transform).pipeTo(writable);

        return { bytesProcessed: bytesWritten };
      },
    },
    {
      name: 'node-read-loop',
      fn: async ({ chunkSize, totalBytes }) => {
        const chunk = makeChunk(chunkSize);
        const readable = createNodeReadable(chunk, totalBytes);
        let bytesRead = 0;

        await new Promise((resolve, reject) => {
          readable.on('data', (c) => {
            bytesRead += c.length;
          });
          readable.on('end', resolve);
          readable.on('error', reject);
        });

        return { bytesProcessed: bytesRead };
      },
    },
    {
      name: 'node-write-loop',
      fn: async ({ chunkSize, totalBytes }) => {
        const chunk = makeChunk(chunkSize);
        const writable = createNodeWritable();
        let remaining = totalBytes;
        let bytesWritten = 0;

        await new Promise((resolve, reject) => {
          writable.on('error', reject);
          function write() {
            let ok = true;
            while (remaining > 0 && ok) {
              const size = Math.min(chunk.length, remaining);
              const buf = size === chunk.length ? chunk : chunk.subarray(0, size);
              remaining -= size;
              bytesWritten += size;
              if (remaining <= 0) {
                writable.end(buf, resolve);
              } else {
                ok = writable.write(buf);
              }
            }
            if (remaining > 0) {
              writable.once('drain', write);
            }
          }
          write();
        });

        return { bytesProcessed: bytesWritten };
      },
    },
    {
      name: 'web-read-loop',
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
      name: 'fast-read-loop',
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
      name: 'web-write-loop',
      fn: async ({ chunkSize, totalBytes, highWaterMark }) => {
        const chunk = makeChunk(chunkSize);
        let bytesWritten = 0;
        const writable = createWebWritable(highWaterMark);
        const writer = writable.getWriter();
        let remaining = totalBytes;

        while (remaining > 0) {
          const size = Math.min(chunk.length, remaining);
          const buf = size === chunk.length ? chunk : chunk.subarray(0, size);
          remaining -= size;
          await writer.write(buf);
          bytesWritten += size;
        }
        await writer.close();

        return { bytesProcessed: bytesWritten };
      },
    },
    {
      name: 'fast-write-loop',
      fn: async ({ chunkSize, totalBytes, highWaterMark }) => {
        const chunk = makeChunk(chunkSize);
        const countHWM = Math.max(1, Math.ceil(highWaterMark / chunkSize));
        let bytesWritten = 0;
        const writable = new FastWritableStream(
          {
            write(c) {
              bytesWritten += c.length;
            },
          },
          { highWaterMark: countHWM }
        );
        const writer = writable.getWriter();
        let remaining = totalBytes;

        while (remaining > 0) {
          const size = Math.min(chunk.length, remaining);
          const buf = size === chunk.length ? chunk : chunk.subarray(0, size);
          remaining -= size;
          await writer.write(buf);
        }
        await writer.close();

        return { bytesProcessed: bytesWritten };
      },
    },
  ],
};
