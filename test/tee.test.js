/**
 * Regression tests for FastReadableStream.tee() concurrent drain.
 *
 * The WHATWG spec requires that both tee branches can be drained concurrently
 * via Promise.all. This was previously broken due to a missing `readAgain` flag
 * in the tee readLoop.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FastReadableStream } from '../src/index.js';

async function drainReader(reader) {
  const chunks = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return chunks;
}

describe('tee() concurrent drain', () => {
  for (const count of [1, 2, 5, 10]) {
    it(`concurrent drain with ${count} chunk(s)`, async () => {
      const readable = new FastReadableStream({
        pull(controller) {
          if (controller._pullCount === undefined) controller._pullCount = 0;
          if (controller._pullCount >= count) {
            controller.close();
            return;
          }
          controller.enqueue(`chunk-${controller._pullCount++}`);
        },
      });

      const [branch1, branch2] = readable.tee();
      const [chunks1, chunks2] = await Promise.all([
        drainReader(branch1.getReader()),
        drainReader(branch2.getReader()),
      ]);

      const expected = Array.from({ length: count }, (_, i) => `chunk-${i}`);
      assert.deepStrictEqual(chunks1, expected);
      assert.deepStrictEqual(chunks2, expected);
    });
  }

  it('concurrent drain with byte stream', async () => {
    let remaining = 5;
    const readable = new FastReadableStream({
      type: 'bytes',
      pull(controller) {
        if (remaining <= 0) {
          controller.close();
          return;
        }
        remaining--;
        controller.enqueue(new Uint8Array([remaining]));
      },
    });

    const [branch1, branch2] = readable.tee();
    const [chunks1, chunks2] = await Promise.all([
      drainReader(branch1.getReader()),
      drainReader(branch2.getReader()),
    ]);

    assert.strictEqual(chunks1.length, 5);
    assert.strictEqual(chunks2.length, 5);
    // Both branches should receive the same data
    for (let i = 0; i < 5; i++) {
      assert.deepStrictEqual(chunks1[i], chunks2[i]);
    }
  });

  it('concurrent drain with start+enqueue pattern', async () => {
    let ctrl;
    const readable = new FastReadableStream({
      start(c) { ctrl = c; },
    });

    // Enqueue data and close before reading
    ctrl.enqueue('a');
    ctrl.enqueue('b');
    ctrl.enqueue('c');
    ctrl.close();

    const [branch1, branch2] = readable.tee();
    const [chunks1, chunks2] = await Promise.all([
      drainReader(branch1.getReader()),
      drainReader(branch2.getReader()),
    ]);

    assert.deepStrictEqual(chunks1, ['a', 'b', 'c']);
    assert.deepStrictEqual(chunks2, ['a', 'b', 'c']);
  });

  it('byte stream start+enqueue tee (JS readLoop path)', async () => {
    let ctrl;
    const readable = new FastReadableStream({
      type: 'bytes',
      start(c) { ctrl = c; },
    });

    ctrl.enqueue(new Uint8Array([1, 2, 3]));
    ctrl.enqueue(new Uint8Array([4, 5]));
    ctrl.close();

    const [branch1, branch2] = readable.tee();
    const [chunks1, chunks2] = await Promise.all([
      drainReader(branch1.getReader()),
      drainReader(branch2.getReader()),
    ]);

    assert.strictEqual(chunks1.length, 2);
    assert.strictEqual(chunks2.length, 2);
    assert.deepStrictEqual(chunks1[0], new Uint8Array([1, 2, 3]));
    assert.deepStrictEqual(chunks2[0], new Uint8Array([1, 2, 3]));
    // Branch2 chunks should be clones (different buffers)
    assert.notStrictEqual(chunks1[0].buffer, chunks2[0].buffer);
  });

  it('byte stream tee with BYOB reader on branch', async () => {
    let ctrl;
    const readable = new FastReadableStream({
      type: 'bytes',
      start(c) { ctrl = c; },
    });

    ctrl.enqueue(new Uint8Array([10, 20, 30]));
    ctrl.close();

    const [branch1, branch2] = readable.tee();
    const byobReader = branch1.getReader({ mode: 'byob' });
    const defaultReader = branch2.getReader();

    const [result1, chunks2] = await Promise.all([
      byobReader.read(new Uint8Array(3)),
      drainReader(defaultReader),
    ]);

    assert.strictEqual(result1.done, false);
    assert.deepStrictEqual(new Uint8Array(result1.value.buffer), new Uint8Array([10, 20, 30]));
    assert.strictEqual(chunks2.length, 1);
    assert.deepStrictEqual(chunks2[0], new Uint8Array([10, 20, 30]));
  });

  it('byte stream tee cancel propagation', async () => {
    let cancelCalled = false;
    let cancelReason;
    const readable = new FastReadableStream({
      type: 'bytes',
      start(c) { c.enqueue(new Uint8Array([1])); },
      cancel(reason) {
        cancelCalled = true;
        cancelReason = reason;
      },
    });

    const [branch1, branch2] = readable.tee();
    // Per spec: branch cancel returns a promise that resolves when BOTH branches cancel.
    // Must cancel both concurrently.
    await Promise.all([
      branch1.cancel('reason1'),
      branch2.cancel('reason2'),
    ]);
    assert.strictEqual(cancelCalled, true, 'source cancel called after both branches cancel');
    assert.deepStrictEqual(cancelReason, ['reason1', 'reason2']);
  });

  it('sequential drain still works', async () => {
    const readable = new FastReadableStream({
      pull(controller) {
        if (controller._pullCount === undefined) controller._pullCount = 0;
        if (controller._pullCount >= 3) {
          controller.close();
          return;
        }
        controller.enqueue(`chunk-${controller._pullCount++}`);
      },
    });

    const [branch1, branch2] = readable.tee();
    const chunks1 = await drainReader(branch1.getReader());
    const chunks2 = await drainReader(branch2.getReader());

    assert.deepStrictEqual(chunks1, ['chunk-0', 'chunk-1', 'chunk-2']);
    assert.deepStrictEqual(chunks2, ['chunk-0', 'chunk-1', 'chunk-2']);
  });
});
