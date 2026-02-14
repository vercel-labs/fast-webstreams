/**
 * Tee scenario: measures stream.tee() + branch consumption.
 * Used for logging/observability alongside processing.
 */

import { FastReadableStream } from '../../src/index.js';

function makeChunk(size) {
  return Buffer.alloc(size, 0x41);
}

async function drainReader(reader) {
  let bytesRead = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    bytesRead += value.length;
  }
  return bytesRead;
}

export default {
  name: 'tee',
  description: 'stream.tee() + concurrent/sequential branch consumption',
  variants: [
    {
      name: 'web-tee-read',
      fn: async ({ chunkSize, totalBytes, highWaterMark }) => {
        const chunk = makeChunk(chunkSize);
        let remaining = totalBytes;
        const readable = new ReadableStream(
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

        const [branch1, branch2] = readable.tee();
        const reader1 = branch1.getReader();
        const reader2 = branch2.getReader();
        const [bytes1, bytes2] = await Promise.all([
          drainReader(reader1),
          drainReader(reader2),
        ]);

        return { bytesProcessed: bytes1 + bytes2 };
      },
    },
    {
      name: 'fast-tee-read',
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

        const [branch1, branch2] = readable.tee();
        const reader1 = branch1.getReader();
        const reader2 = branch2.getReader();
        const [bytes1, bytes2] = await Promise.all([
          drainReader(reader1),
          drainReader(reader2),
        ]);

        return { bytesProcessed: bytes1 + bytes2 };
      },
    },
    {
      name: 'web-tee-sequential',
      fn: async ({ chunkSize, totalBytes, highWaterMark }) => {
        const chunk = makeChunk(chunkSize);
        let remaining = totalBytes;
        const readable = new ReadableStream(
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

        const [branch1, branch2] = readable.tee();
        const bytes1 = await drainReader(branch1.getReader());
        const bytes2 = await drainReader(branch2.getReader());

        return { bytesProcessed: bytes1 + bytes2 };
      },
    },
    {
      name: 'fast-tee-sequential',
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

        const [branch1, branch2] = readable.tee();
        const bytes1 = await drainReader(branch1.getReader());
        const bytes2 = await drainReader(branch2.getReader());

        return { bytesProcessed: bytes1 + bytes2 };
      },
    },
    {
      name: 'fast-byte-tee-read',
      fn: async ({ chunkSize, totalBytes }) => {
        const chunk = makeChunk(chunkSize);
        let remaining = totalBytes;
        const readable = new FastReadableStream({
          type: 'bytes',
          pull(controller) {
            if (remaining <= 0) {
              controller.close();
              return;
            }
            const size = Math.min(chunk.length, remaining);
            remaining -= size;
            const buf = new Uint8Array(size);
            buf.set(size === chunk.length ? chunk : chunk.subarray(0, size));
            controller.enqueue(buf);
          },
        });

        const [branch1, branch2] = readable.tee();
        const reader1 = branch1.getReader();
        const reader2 = branch2.getReader();
        const [bytes1, bytes2] = await Promise.all([
          drainReader(reader1),
          drainReader(reader2),
        ]);

        return { bytesProcessed: bytes1 + bytes2 };
      },
    },
    {
      name: 'fast-byte-tee-enqueue',
      fn: async ({ chunkSize, totalBytes }) => {
        const chunk = makeChunk(chunkSize);
        let ctrl;
        const readable = new FastReadableStream({
          type: 'bytes',
          start(c) { ctrl = c; },
        });

        const [branch1, branch2] = readable.tee();
        const reader1 = branch1.getReader();
        const reader2 = branch2.getReader();

        // Enqueue all data (start+enqueue pattern — uses JS readLoop tee)
        let remaining = totalBytes;
        while (remaining > 0) {
          const size = Math.min(chunk.length, remaining);
          remaining -= size;
          const buf = new Uint8Array(size);
          buf.set(size === chunk.length ? chunk : chunk.subarray(0, size));
          ctrl.enqueue(buf);
        }
        ctrl.close();

        const [bytes1, bytes2] = await Promise.all([
          drainReader(reader1),
          drainReader(reader2),
        ]);

        return { bytesProcessed: bytes1 + bytes2 };
      },
    },
    {
      name: 'web-byte-tee-read',
      fn: async ({ chunkSize, totalBytes }) => {
        const chunk = makeChunk(chunkSize);
        let remaining = totalBytes;
        const readable = new ReadableStream({
          type: 'bytes',
          pull(controller) {
            if (remaining <= 0) {
              controller.close();
              return;
            }
            const size = Math.min(chunk.length, remaining);
            remaining -= size;
            const buf = new Uint8Array(size);
            buf.set(size === chunk.length ? chunk : chunk.subarray(0, size));
            controller.enqueue(buf);
          },
        });

        const [branch1, branch2] = readable.tee();
        const reader1 = branch1.getReader();
        const reader2 = branch2.getReader();
        const [bytes1, bytes2] = await Promise.all([
          drainReader(reader1),
          drainReader(reader2),
        ]);

        return { bytesProcessed: bytes1 + bytes2 };
      },
    },
  ],
};
