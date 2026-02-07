/**
 * Compression scenario: gzip via node:zlib vs CompressionStream/DecompressionStream.
 * Measures the cost of compression in both streaming APIs.
 */

import { Readable, Writable, pipeline } from 'node:stream';
import { createGzip, createGunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { FastReadableStream, FastWritableStream } from '../../src/index.js';

const pipelineAsync = promisify(pipeline);

function makeChunk(size) {
  // Semi-compressible data: repeating pattern with some variation
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i++) {
    buf[i] = (i % 256) ^ ((i >> 8) & 0xff);
  }
  return buf;
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

export default {
  name: 'compression',
  description: 'Gzip compress+decompress: node:zlib vs CompressionStream/DecompressionStream',
  variants: [
    {
      name: 'node-transform-pipeline',
      fn: async ({ chunkSize, totalBytes }) => {
        const chunk = makeChunk(chunkSize);
        const readable = createNodeReadable(chunk, totalBytes);
        const gzip = createGzip();
        const gunzip = createGunzip();
        const writable = createNodeWritable();

        await pipelineAsync(readable, gzip, gunzip, writable);

        return { bytesProcessed: writable.getBytesWritten() };
      },
    },
    {
      name: 'web-pipeThrough',
      fn: async ({ chunkSize, totalBytes, highWaterMark }) => {
        const chunk = makeChunk(chunkSize);
        const readable = createWebReadable(chunk, totalBytes, highWaterMark);
        const compress = new CompressionStream('gzip');
        const decompress = new DecompressionStream('gzip');
        const writable = createWebWritable(highWaterMark);

        await readable
          .pipeThrough(compress)
          .pipeThrough(decompress)
          .pipeTo(writable);

        return { bytesProcessed: writable.getBytesWritten() };
      },
    },
    {
      name: 'fast-pipeThrough',
      fn: async ({ chunkSize, totalBytes, highWaterMark }) => {
        const chunk = makeChunk(chunkSize);
        let remaining = totalBytes;
        // Tier 2: FastReadableStream pipes through native CompressionStream,
        // which triggers delegation to Readable.toWeb()
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
        const compress = new CompressionStream('gzip');
        const decompress = new DecompressionStream('gzip');
        const writable = createWebWritable(highWaterMark);

        await readable
          .pipeThrough(compress)
          .pipeThrough(decompress)
          .pipeTo(writable);

        return { bytesProcessed: writable.getBytesWritten() };
      },
    },
  ],
};
