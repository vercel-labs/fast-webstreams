/**
 * Tests for the global patcher (src/patch.js).
 *
 * Verifies:
 * 1. patchGlobalWebStreams() replaces global stream constructors
 * 2. unpatchGlobalWebStreams() restores native constructors
 * 3. Internal code works correctly after patching
 * 4. The patched globals produce Fast stream instances
 *
 * Every suite calls unpatchGlobalWebStreams() in afterEach so a failing test
 * never leaks patched globals to other test files in the same process.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

// Capture native constructors BEFORE patch runs
const OriginalReadableStream = globalThis.ReadableStream;
const OriginalWritableStream = globalThis.WritableStream;
const OriginalTransformStream = globalThis.TransformStream;

// Import patch/unpatch and Fast classes
import { patchGlobalWebStreams, unpatchGlobalWebStreams } from '../src/patch.js';
import {
  FastReadableStream,
  FastWritableStream,
  FastTransformStream,
} from '../src/index.js';

describe('patch: global replacement', () => {
  afterEach(() => unpatchGlobalWebStreams());

  it('replaces globalThis.ReadableStream with FastReadableStream', () => {
    patchGlobalWebStreams();
    assert.strictEqual(globalThis.ReadableStream, FastReadableStream);
    assert.notStrictEqual(globalThis.ReadableStream, OriginalReadableStream);
  });

  it('replaces globalThis.WritableStream with FastWritableStream', () => {
    patchGlobalWebStreams();
    assert.strictEqual(globalThis.WritableStream, FastWritableStream);
    assert.notStrictEqual(globalThis.WritableStream, OriginalWritableStream);
  });

  it('replaces globalThis.TransformStream with FastTransformStream', () => {
    patchGlobalWebStreams();
    assert.strictEqual(globalThis.TransformStream, FastTransformStream);
    assert.notStrictEqual(globalThis.TransformStream, OriginalTransformStream);
  });

  it('preserves ByteLengthQueuingStrategy and CountQueuingStrategy', () => {
    patchGlobalWebStreams();
    assert.strictEqual(typeof globalThis.ByteLengthQueuingStrategy, 'function');
    assert.strictEqual(typeof globalThis.CountQueuingStrategy, 'function');
  });
});

describe('patch: new globals produce Fast instances', () => {
  afterEach(() => unpatchGlobalWebStreams());

  it('new ReadableStream() produces a FastReadableStream', () => {
    patchGlobalWebStreams();
    const rs = new ReadableStream();
    assert.ok(rs instanceof FastReadableStream,
      'new ReadableStream() should be instanceof FastReadableStream');
  });

  it('new WritableStream() produces a FastWritableStream', () => {
    patchGlobalWebStreams();
    const ws = new WritableStream();
    assert.ok(ws instanceof FastWritableStream,
      'new WritableStream() should be instanceof FastWritableStream');
  });

  it('new TransformStream() produces a FastTransformStream', () => {
    patchGlobalWebStreams();
    const ts = new TransformStream();
    assert.ok(ts instanceof FastTransformStream,
      'new TransformStream() should be instanceof FastTransformStream');
  });
});

describe('patch: internal functionality works after patching', () => {
  afterEach(() => unpatchGlobalWebStreams());

  it('ReadableStream read works', async () => {
    patchGlobalWebStreams();
    const rs = new ReadableStream({
      start(controller) {
        controller.enqueue('hello');
        controller.enqueue('world');
        controller.close();
      },
    });

    const reader = rs.getReader();
    const r1 = await reader.read();
    assert.deepStrictEqual(r1, { value: 'hello', done: false });
    const r2 = await reader.read();
    assert.deepStrictEqual(r2, { value: 'world', done: false });
    const r3 = await reader.read();
    assert.deepStrictEqual(r3, { value: undefined, done: true });
    reader.releaseLock();
  });

  it('WritableStream write works', async () => {
    patchGlobalWebStreams();
    const chunks = [];
    const ws = new WritableStream({
      write(chunk) {
        chunks.push(chunk);
      },
    });

    const writer = ws.getWriter();
    await writer.write('a');
    await writer.write('b');
    await writer.close();
    assert.deepStrictEqual(chunks, ['a', 'b']);
  });

  it('TransformStream transforms data', async () => {
    patchGlobalWebStreams();
    const ts = new TransformStream({
      transform(chunk, controller) {
        controller.enqueue(chunk.toUpperCase());
      },
    });

    const writer = ts.writable.getWriter();
    const reader = ts.readable.getReader();

    writer.write('hello');
    const r1 = await reader.read();
    assert.deepStrictEqual(r1, { value: 'HELLO', done: false });

    writer.close();
    const r2 = await reader.read();
    assert.deepStrictEqual(r2, { value: undefined, done: true });
  });

  it('pipeTo works between patched streams', async () => {
    patchGlobalWebStreams();
    const chunks = [];
    const rs = new ReadableStream({
      start(controller) {
        controller.enqueue(1);
        controller.enqueue(2);
        controller.enqueue(3);
        controller.close();
      },
    });

    const ws = new WritableStream({
      write(chunk) {
        chunks.push(chunk);
      },
    });

    await rs.pipeTo(ws);
    assert.deepStrictEqual(chunks, [1, 2, 3]);
  });

  it('pipeThrough works between patched streams', async () => {
    patchGlobalWebStreams();
    const rs = new ReadableStream({
      start(controller) {
        controller.enqueue('a');
        controller.enqueue('b');
        controller.close();
      },
    });

    const ts = new TransformStream({
      transform(chunk, controller) {
        controller.enqueue(chunk + '!');
      },
    });

    const results = [];
    const ws = new WritableStream({
      write(chunk) {
        results.push(chunk);
      },
    });

    await rs.pipeThrough(ts).pipeTo(ws);
    assert.deepStrictEqual(results, ['a!', 'b!']);
  });

  it('byte stream (native delegation) still works after patching', async () => {
    patchGlobalWebStreams();
    const rs = new ReadableStream({
      type: 'bytes',
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.close();
      },
    });

    const reader = rs.getReader();
    const r1 = await reader.read();
    assert.ok(r1.value instanceof Uint8Array);
    assert.deepStrictEqual([...r1.value], [1, 2, 3]);
    reader.releaseLock();
  });
});

describe('unpatch: restores native constructors', () => {
  afterEach(() => unpatchGlobalWebStreams());

  it('restores globalThis.ReadableStream to native', () => {
    patchGlobalWebStreams();
    unpatchGlobalWebStreams();
    assert.strictEqual(globalThis.ReadableStream, OriginalReadableStream);
    assert.notStrictEqual(globalThis.ReadableStream, FastReadableStream);
  });

  it('restores globalThis.WritableStream to native', () => {
    patchGlobalWebStreams();
    unpatchGlobalWebStreams();
    assert.strictEqual(globalThis.WritableStream, OriginalWritableStream);
    assert.notStrictEqual(globalThis.WritableStream, FastWritableStream);
  });

  it('restores globalThis.TransformStream to native', () => {
    patchGlobalWebStreams();
    unpatchGlobalWebStreams();
    assert.strictEqual(globalThis.TransformStream, OriginalTransformStream);
    assert.notStrictEqual(globalThis.TransformStream, FastTransformStream);
  });

  it('native streams work after unpatch', async () => {
    patchGlobalWebStreams();
    unpatchGlobalWebStreams();
    const rs = new ReadableStream({
      start(controller) {
        controller.enqueue('native');
        controller.close();
      },
    });
    const reader = rs.getReader();
    const r = await reader.read();
    assert.strictEqual(r.value, 'native');
    assert.ok(!(rs instanceof FastReadableStream),
      'should NOT be a FastReadableStream after unpatch');
    reader.releaseLock();
  });

  it('patch can be re-applied after unpatch', () => {
    patchGlobalWebStreams();
    unpatchGlobalWebStreams();
    patchGlobalWebStreams();
    assert.strictEqual(globalThis.ReadableStream, FastReadableStream);
  });
});
