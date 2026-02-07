/**
 * Transform-CPU scenario: JSON parse/stringify + SHA-256 hash on each chunk.
 * Measures overhead when transforms do real CPU work per chunk.
 */

import { Readable, Writable, Transform, pipeline } from 'node:stream';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { FastReadableStream, FastWritableStream, FastTransformStream } from '../../src/index.js';

const pipelineAsync = promisify(pipeline);

function makeChunk(size) {
  // Create a JSON-like payload that can be parsed/stringified
  const payload = JSON.stringify({
    data: 'x'.repeat(Math.max(0, size - 32)),
    ts: Date.now(),
  });
  return Buffer.from(payload);
}

/**
 * CPU-intensive transform: parse JSON, add hash, re-stringify.
 */
function cpuTransform(chunk) {
  const parsed = JSON.parse(chunk);
  parsed.hash = createHash('sha256').update(chunk).digest('hex');
  return Buffer.from(JSON.stringify(parsed));
}

function createNodeReadable(chunk, totalBytes) {
  let remaining = totalBytes;
  return new Readable({
    read() {
      if (remaining <= 0) {
        this.push(null);
        return;
      }
      remaining -= chunk.length;
      this.push(chunk);
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

function createNodeTransform() {
  return new Transform({
    transform(chunk, _encoding, cb) {
      try {
        cb(null, cpuTransform(chunk));
      } catch (err) {
        cb(err);
      }
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
        remaining -= chunk.length;
        controller.enqueue(chunk);
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

function createWebTransform(highWaterMark) {
  return new TransformStream(
    {
      transform(chunk, controller) {
        controller.enqueue(cpuTransform(chunk));
      },
    },
    new ByteLengthQueuingStrategy({ highWaterMark }),
    new ByteLengthQueuingStrategy({ highWaterMark })
  );
}

export default {
  name: 'transform-cpu',
  description: 'CPU-bound transform: JSON parse/stringify + SHA-256 hash per chunk',
  variants: [
    {
      name: 'node-transform-pipeline',
      fn: async ({ chunkSize, totalBytes }) => {
        const chunk = makeChunk(chunkSize);
        // Adjust totalBytes to be a multiple of actual chunk size (chunk size may
        // differ from requested chunkSize due to JSON wrapper overhead)
        const numChunks = Math.floor(totalBytes / chunk.length);
        const inputTotal = numChunks * chunk.length;
        const readable = createNodeReadable(chunk, inputTotal);
        const transform = createNodeTransform();
        const writable = createNodeWritable();

        await pipelineAsync(readable, transform, writable);

        // Return input bytes for the assertion (output size differs due to hash)
        return { bytesProcessed: inputTotal };
      },
    },
    {
      name: 'web-pipeThrough',
      fn: async ({ chunkSize, totalBytes, highWaterMark }) => {
        const chunk = makeChunk(chunkSize);
        const numChunks = Math.floor(totalBytes / chunk.length);
        const inputTotal = numChunks * chunk.length;
        const readable = createWebReadable(chunk, inputTotal, highWaterMark);
        const transform = createWebTransform(highWaterMark);
        const writable = createWebWritable(highWaterMark);

        await readable.pipeThrough(transform).pipeTo(writable);

        return { bytesProcessed: inputTotal };
      },
    },
    {
      name: 'fast-pipeThrough',
      fn: async ({ chunkSize, totalBytes, highWaterMark }) => {
        const chunk = makeChunk(chunkSize);
        const numChunks = Math.floor(totalBytes / chunk.length);
        const inputTotal = numChunks * chunk.length;
        let remaining = inputTotal;
        const readable = new FastReadableStream(
          {
            pull(controller) {
              if (remaining <= 0) {
                controller.close();
                return;
              }
              remaining -= chunk.length;
              controller.enqueue(chunk);
            },
          },
          new ByteLengthQueuingStrategy({ highWaterMark })
        );
        const transform = new FastTransformStream(
          {
            transform(c, controller) {
              controller.enqueue(cpuTransform(c));
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

        return { bytesProcessed: inputTotal };
      },
    },
  ],
};
