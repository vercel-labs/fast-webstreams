/**
 * Tests for specPipeTo handling of TransformStream flush() chunks.
 *
 * Regression tests for a bug where specPipeTo dropped chunks enqueued
 * during a TransformStream's flush() callback. The reader.closed promise
 * resolved (via Node.js 'end'/'close' events) before the pump loop had
 * drained all buffered data, causing premature shutdown.
 *
 * These tests all use pipeTo with options (signal, preventClose, etc.)
 * to force the specPipeTo code path instead of the Tier 0 fast pipeline.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { patchGlobalWebStreams, unpatchGlobalWebStreams } from '../src/patch.js';

const encoder = new TextEncoder();

describe('specPipeTo: flush chunks are not dropped', () => {
  afterEach(() => unpatchGlobalWebStreams());

  it('pipeTo with signal preserves all flush chunks (3 chunks)', async () => {
    patchGlobalWebStreams();

    const t = new TransformStream({
      transform(chunk, ctrl) { ctrl.enqueue(chunk); },
      flush(ctrl) {
        ctrl.enqueue(encoder.encode('F1'));
        ctrl.enqueue(encoder.encode('F2'));
        ctrl.enqueue(encoder.encode('F3'));
      },
    });

    const source = new ReadableStream({
      start(c) {
        c.enqueue(encoder.encode('SHELL'));
        setTimeout(() => c.close(), 10);
      },
    });

    const hopPromise = source.pipeTo(t.writable);
    const chunks = [];
    const dest = new WritableStream({
      write(c) { chunks.push(Buffer.from(c).toString()); },
    });
    const ac = new AbortController();
    const mainPromise = t.readable.pipeTo(dest, { signal: ac.signal });

    await Promise.all([hopPromise, mainPromise]);
    assert.deepStrictEqual(chunks, ['SHELL', 'F1', 'F2', 'F3']);
  });

  it('pipeTo with signal preserves flush chunks (1 chunk)', async () => {
    patchGlobalWebStreams();

    const t = new TransformStream({
      transform(chunk, ctrl) { ctrl.enqueue(chunk); },
      flush(ctrl) {
        ctrl.enqueue(encoder.encode('FLUSH'));
      },
    });

    const source = new ReadableStream({
      start(c) {
        c.enqueue(encoder.encode('DATA'));
        setTimeout(() => c.close(), 10);
      },
    });

    const hopPromise = source.pipeTo(t.writable);
    const chunks = [];
    const dest = new WritableStream({
      write(c) { chunks.push(Buffer.from(c).toString()); },
    });
    const ac = new AbortController();
    const mainPromise = t.readable.pipeTo(dest, { signal: ac.signal });

    await Promise.all([hopPromise, mainPromise]);
    assert.deepStrictEqual(chunks, ['DATA', 'FLUSH']);
  });

  it('pipeTo with preventClose preserves flush chunks', async () => {
    patchGlobalWebStreams();

    const t = new TransformStream({
      transform(chunk, ctrl) { ctrl.enqueue(chunk); },
      flush(ctrl) {
        ctrl.enqueue(encoder.encode('F1'));
        ctrl.enqueue(encoder.encode('F2'));
      },
    });

    const source = new ReadableStream({
      start(c) {
        c.enqueue(encoder.encode('BODY'));
        setTimeout(() => c.close(), 10);
      },
    });

    const hopPromise = source.pipeTo(t.writable);
    const chunks = [];
    const dest = new WritableStream({
      write(c) { chunks.push(Buffer.from(c).toString()); },
      close() { chunks.push('DEST_CLOSED'); },
    });
    const mainPromise = t.readable.pipeTo(dest, { preventClose: true });

    await Promise.all([hopPromise, mainPromise]);
    // preventClose: dest should NOT be closed, but all chunks should arrive
    assert.deepStrictEqual(chunks, ['BODY', 'F1', 'F2']);
  });

  it('manual concurrent piping preserves flush chunks', async () => {
    patchGlobalWebStreams();

    const t = new TransformStream({
      transform(chunk, ctrl) { ctrl.enqueue(chunk); },
      flush(ctrl) {
        ctrl.enqueue(encoder.encode('F1'));
        ctrl.enqueue(encoder.encode('F2'));
        ctrl.enqueue(encoder.encode('F3'));
      },
    });

    const source = new ReadableStream({
      start(c) {
        c.enqueue(encoder.encode('SHELL'));
        setTimeout(() => c.close(), 10);
      },
    });

    // Standard TransformStream usage: pipe writable + readable concurrently
    const hopPromise = source.pipeTo(t.writable);
    const chunks = [];
    const dest = new WritableStream({
      write(c) { chunks.push(Buffer.from(c).toString()); },
    });
    const mainPromise = t.readable.pipeTo(dest);

    await Promise.all([hopPromise, mainPromise]);
    assert.deepStrictEqual(chunks, ['SHELL', 'F1', 'F2', 'F3']);
  });

  it('pipeThrough + pipeTo with signal preserves flush chunks', async () => {
    patchGlobalWebStreams();

    const source = new ReadableStream({
      start(c) {
        c.enqueue(encoder.encode('DATA'));
        setTimeout(() => c.close(), 10);
      },
    });

    const piped = source.pipeThrough(new TransformStream({
      transform(chunk, ctrl) { ctrl.enqueue(chunk); },
      flush(ctrl) {
        ctrl.enqueue(encoder.encode('F1'));
        ctrl.enqueue(encoder.encode('F2'));
        ctrl.enqueue(encoder.encode('F3'));
      },
    }));

    const chunks = [];
    const dest = new WritableStream({
      write(c) { chunks.push(Buffer.from(c).toString()); },
    });
    const ac = new AbortController();
    await piped.pipeTo(dest, { signal: ac.signal });

    assert.deepStrictEqual(chunks, ['DATA', 'F1', 'F2', 'F3']);
  });

  it('async flush with delayed enqueues preserves all chunks', async () => {
    patchGlobalWebStreams();

    const t = new TransformStream({
      transform(chunk, ctrl) { ctrl.enqueue(chunk); },
      async flush(ctrl) {
        ctrl.enqueue(encoder.encode('F1'));
        await new Promise((r) => setTimeout(r, 5));
        ctrl.enqueue(encoder.encode('F2'));
        await new Promise((r) => setTimeout(r, 5));
        ctrl.enqueue(encoder.encode('F3'));
      },
    });

    const source = new ReadableStream({
      start(c) {
        c.enqueue(encoder.encode('SHELL'));
        setTimeout(() => c.close(), 10);
      },
    });

    const hopPromise = source.pipeTo(t.writable);
    const chunks = [];
    const dest = new WritableStream({
      write(c) { chunks.push(Buffer.from(c).toString()); },
    });
    const ac = new AbortController();
    const mainPromise = t.readable.pipeTo(dest, { signal: ac.signal });

    await Promise.all([hopPromise, mainPromise]);
    assert.deepStrictEqual(chunks, ['SHELL', 'F1', 'F2', 'F3']);
  });

  it('multiple transforms with flush chunks and signal', async () => {
    patchGlobalWebStreams();

    // Simulates Next.js pattern: source → transform1 (adds suffix) → transform2 (adds flight data) → dest
    const source = new ReadableStream({
      start(c) {
        c.enqueue(encoder.encode('HTML'));
        setTimeout(() => c.close(), 10);
      },
    });

    const transform1 = new TransformStream({
      transform(chunk, ctrl) { ctrl.enqueue(chunk); },
      flush(ctrl) {
        ctrl.enqueue(encoder.encode('SUFFIX'));
      },
    });

    const transform2 = new TransformStream({
      transform(chunk, ctrl) { ctrl.enqueue(chunk); },
      flush(ctrl) {
        ctrl.enqueue(encoder.encode('FLIGHT1'));
        ctrl.enqueue(encoder.encode('FLIGHT2'));
      },
    });

    let piped = source.pipeThrough(transform1);
    piped = piped.pipeThrough(transform2);

    const chunks = [];
    const dest = new WritableStream({
      write(c) { chunks.push(Buffer.from(c).toString()); },
    });
    const ac = new AbortController();
    await piped.pipeTo(dest, { signal: ac.signal });

    assert.deepStrictEqual(chunks, ['HTML', 'SUFFIX', 'FLIGHT1', 'FLIGHT2']);
  });
});
