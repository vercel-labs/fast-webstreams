/**
 * ReadableStream.from() scenario: measures conversion from generators/arrays to streams.
 * Fast delegates to native ReadableStream.from() and wraps in a kNativeOnly shell,
 * so this tests bridge overhead.
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
  name: 'readable-from',
  description: 'ReadableStream.from() with generators and arrays',
  variants: [
    {
      name: 'web-from-generator',
      fn: async ({ chunkSize, totalBytes }) => {
        const chunk = makeChunk(chunkSize);
        const numChunks = Math.floor(totalBytes / chunkSize);

        async function* generate() {
          for (let i = 0; i < numChunks; i++) {
            yield chunk;
          }
        }

        const readable = ReadableStream.from(generate());
        const reader = readable.getReader();
        return { bytesProcessed: await drainReader(reader) };
      },
    },
    {
      name: 'fast-from-generator',
      fn: async ({ chunkSize, totalBytes }) => {
        const chunk = makeChunk(chunkSize);
        const numChunks = Math.floor(totalBytes / chunkSize);

        async function* generate() {
          for (let i = 0; i < numChunks; i++) {
            yield chunk;
          }
        }

        const readable = FastReadableStream.from(generate());
        const reader = readable.getReader();
        return { bytesProcessed: await drainReader(reader) };
      },
    },
    {
      name: 'web-from-sync-generator',
      fn: async ({ chunkSize, totalBytes }) => {
        const chunk = makeChunk(chunkSize);
        const numChunks = Math.floor(totalBytes / chunkSize);

        function* generate() {
          for (let i = 0; i < numChunks; i++) {
            yield chunk;
          }
        }

        const readable = ReadableStream.from(generate());
        const reader = readable.getReader();
        return { bytesProcessed: await drainReader(reader) };
      },
    },
    {
      name: 'fast-from-sync-generator',
      fn: async ({ chunkSize, totalBytes }) => {
        const chunk = makeChunk(chunkSize);
        const numChunks = Math.floor(totalBytes / chunkSize);

        function* generate() {
          for (let i = 0; i < numChunks; i++) {
            yield chunk;
          }
        }

        const readable = FastReadableStream.from(generate());
        const reader = readable.getReader();
        return { bytesProcessed: await drainReader(reader) };
      },
    },
    {
      name: 'web-from-array',
      fn: async ({ chunkSize, totalBytes }) => {
        const chunk = makeChunk(chunkSize);
        const numChunks = Math.floor(totalBytes / chunkSize);
        const arr = new Array(numChunks);
        for (let i = 0; i < numChunks; i++) arr[i] = chunk;

        const readable = ReadableStream.from(arr);
        const reader = readable.getReader();
        return { bytesProcessed: await drainReader(reader) };
      },
    },
    {
      name: 'fast-from-array',
      fn: async ({ chunkSize, totalBytes }) => {
        const chunk = makeChunk(chunkSize);
        const numChunks = Math.floor(totalBytes / chunkSize);
        const arr = new Array(numChunks);
        for (let i = 0; i < numChunks; i++) arr[i] = chunk;

        const readable = FastReadableStream.from(arr);
        const reader = readable.getReader();
        return { bytesProcessed: await drainReader(reader) };
      },
    },
  ],
};
