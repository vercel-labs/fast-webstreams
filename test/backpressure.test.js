/**
 * Backpressure tests for fast-webstreams.
 *
 * Verifies that backpressure signals propagate correctly across all tiers:
 *  - Writer ready/desiredSize (Tier 1)
 *  - specPipeTo pipeLoop pausing (Tier 2)
 *  - Transform writable-side backpressure flag (Transform)
 *  - Pipeline backpressure (Tier 0)
 *  - Data integrity under backpressure (no drops, no duplicates)
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  FastReadableStream,
  FastWritableStream,
  FastTransformStream,
} from '../src/index.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Collect all chunks from a readable via reader.read() loop. */
async function collectReader(readable) {
  const reader = readable.getReader();
  const chunks = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return chunks;
}

/** Create a readable that enqueues N numbered items via pull(). */
function numberedSource(n) {
  let i = 0;
  return new FastReadableStream({
    pull(c) {
      if (i >= n) { c.close(); return; }
      c.enqueue(i++);
    },
  });
}

/** Create a readable that enqueues N items synchronously in start(). */
function eagerSource(n) {
  return new FastReadableStream({
    start(c) {
      for (let i = 0; i < n; i++) c.enqueue(i);
      c.close();
    },
  });
}

/**
 * Create a writable that records chunks and delays each write.
 * Returns { writable, chunks }.
 */
function slowWritable(delayMs, hwm = 1) {
  const chunks = [];
  const writable = new FastWritableStream({
    write(chunk) {
      return new Promise((r) => setTimeout(() => { chunks.push(chunk); r(); }, delayMs));
    },
  }, { highWaterMark: hwm });
  return { writable, chunks };
}

/** Flush microtask queue — returns after N microtick rounds. */
function tick(n = 1) {
  let p = Promise.resolve();
  for (let i = 0; i < n; i++) p = p.then(() => {});
  return p;
}

// ─── Writer desiredSize & ready ──────────────────────────────────────────────

describe('backpressure: writer desiredSize and ready', () => {
  it('desiredSize starts at hwm for an idle stream', () => {
    const ws = new FastWritableStream({ write() {} }, { highWaterMark: 4 });
    const writer = ws.getWriter();
    assert.strictEqual(writer.desiredSize, 4);
    writer.releaseLock();
  });

  it('desiredSize is 0 after close', async () => {
    const ws = new FastWritableStream({ write() {} });
    const writer = ws.getWriter();
    await writer.close();
    assert.strictEqual(writer.desiredSize, 0);
  });

  it('desiredSize is null when errored', async () => {
    const ws = new FastWritableStream({ write() {} });
    const writer = ws.getWriter();
    await writer.abort('fail');
    assert.strictEqual(writer.desiredSize, null);
  });

  it('ready resolves immediately when desiredSize > 0', async () => {
    const ws = new FastWritableStream({ write() {} }, { highWaterMark: 2 });
    const writer = ws.getWriter();
    // ready should resolve quickly
    await writer.ready;
    assert.strictEqual(writer.desiredSize, 2);
    writer.releaseLock();
  });

  it('ready becomes pending when in-flight write fills the buffer', async () => {
    let resolveWrite;
    const ws = new FastWritableStream({
      write() { return new Promise((r) => { resolveWrite = r; }); },
    }, { highWaterMark: 1 });
    const writer = ws.getWriter();
    await writer.ready;

    // Start a write — goes in-flight, desiredSize drops to 0
    const w = writer.write('x');
    await tick(3);
    assert.strictEqual(writer.desiredSize, 0);

    // ready should be pending (desiredSize = 0)
    let readySettled = false;
    writer.ready.then(() => { readySettled = true; });
    await tick(3);
    assert.strictEqual(readySettled, false, 'ready should be pending while write is in-flight');

    // Complete the write — ready should resolve
    resolveWrite();
    await w;
    await writer.ready;
    assert.strictEqual(writer.desiredSize, 1);
    writer.releaseLock();
  });
});

// ─── pipeTo backpressure ─────────────────────────────────────────────────────

describe('backpressure: pipeTo pauses source when dest is slow', () => {
  it('fast source, slow dest: all data arrives without loss', async () => {
    const N = 20;
    const source = eagerSource(N);
    const { writable, chunks } = slowWritable(5);

    await source.pipeTo(writable);

    assert.strictEqual(chunks.length, N);
    for (let i = 0; i < N; i++) {
      assert.strictEqual(chunks[i], i);
    }
  });

  it('pull-source faster than sink: no data dropped', async () => {
    const N = 50;
    const source = numberedSource(N);
    const { writable, chunks } = slowWritable(2);

    await source.pipeTo(writable);

    assert.strictEqual(chunks.length, N);
    for (let i = 0; i < N; i++) {
      assert.strictEqual(chunks[i], i);
    }
  });

  it('hwm=1 limits how far ahead source runs', async () => {
    let enqueued = 0;
    let maxDelta = 0;
    let writesDone = 0;

    const source = new FastReadableStream({
      pull(c) {
        if (enqueued >= 10) { c.close(); return; }
        enqueued++;
        const delta = enqueued - writesDone;
        if (delta > maxDelta) maxDelta = delta;
        c.enqueue(enqueued);
      },
    });

    const writable = new FastWritableStream({
      write() {
        return new Promise((r) => setTimeout(() => { writesDone++; r(); }, 5));
      },
    }, { highWaterMark: 1 });

    await source.pipeTo(writable);

    // Source shouldn't race far ahead with hwm=1
    assert.ok(maxDelta <= 6,
      `source ran ${maxDelta} items ahead of sink (expected ≤ 6 with hwm=1)`);
    assert.strictEqual(writesDone, 10);
  });

  it('higher hwm allows more buffering before backpressure', async () => {
    let enqueued = 0;
    let maxDelta = 0;
    let writesDone = 0;

    const source = new FastReadableStream({
      pull(c) {
        if (enqueued >= 30) { c.close(); return; }
        enqueued++;
        const delta = enqueued - writesDone;
        if (delta > maxDelta) maxDelta = delta;
        c.enqueue(enqueued);
      },
    });

    const writable = new FastWritableStream({
      write() {
        return new Promise((r) => setTimeout(() => { writesDone++; r(); }, 3));
      },
    }, { highWaterMark: 10 });

    await source.pipeTo(writable);
    assert.strictEqual(writesDone, 30);
    assert.ok(maxDelta > 1,
      `higher hwm should allow more buffering, got maxDelta=${maxDelta}`);
  });
});

// ─── Transform backpressure ──────────────────────────────────────────────────

describe('backpressure: transform streams', () => {
  it('transform with flush emits data correctly', async () => {
    const ts = new FastTransformStream({
      transform(chunk, ctrl) { ctrl.enqueue(`t:${chunk}`); },
      flush(ctrl) {
        ctrl.enqueue('flush1');
        ctrl.enqueue('flush2');
      },
    });

    const source = eagerSource(3);
    const piped = source.pipeThrough(ts);
    const chunks = await collectReader(piped);

    assert.deepStrictEqual(chunks, ['t:0', 't:1', 't:2', 'flush1', 'flush2']);
  });

  it('chained transforms propagate backpressure end-to-end', async () => {
    const source = numberedSource(20);

    let stream = source;
    for (let i = 0; i < 3; i++) {
      stream = stream.pipeThrough(new FastTransformStream({
        transform(chunk, ctrl) { ctrl.enqueue(chunk + 100 * (i + 1)); },
      }));
    }

    const { writable, chunks } = slowWritable(3);
    await stream.pipeTo(writable);

    assert.strictEqual(chunks.length, 20);
    // Ordering preserved under backpressure
    for (let j = 1; j < chunks.length; j++) {
      assert.ok(chunks[j] > chunks[j - 1], `out of order at index ${j}: ${chunks[j - 1]} >= ${chunks[j]}`);
    }
  });

  it('transform that expands chunks (1→3) preserves all output under backpressure', async () => {
    const ts = new FastTransformStream({
      transform(chunk, ctrl) {
        ctrl.enqueue(`${chunk}-a`);
        ctrl.enqueue(`${chunk}-b`);
        ctrl.enqueue(`${chunk}-c`);
      },
    });

    const source = eagerSource(5);
    const piped = source.pipeThrough(ts);
    const { writable, chunks } = slowWritable(2);
    await piped.pipeTo(writable);

    assert.strictEqual(chunks.length, 15);
    assert.strictEqual(chunks[0], '0-a');
    assert.strictEqual(chunks[14], '4-c');
  });

  it('async transform respects backpressure', async () => {
    const ts = new FastTransformStream({
      async transform(chunk, ctrl) {
        await new Promise((r) => setTimeout(r, 2));
        ctrl.enqueue(chunk);
      },
    });

    const source = numberedSource(10);
    const piped = source.pipeThrough(ts);
    const chunks = await collectReader(piped);

    assert.strictEqual(chunks.length, 10);
    for (let i = 0; i < 10; i++) {
      assert.strictEqual(chunks[i], i);
    }
  });

  it('transform with slow consumer does not drop chunks', async () => {
    const ts = new FastTransformStream({
      transform(chunk, ctrl) { ctrl.enqueue(chunk * 10); },
    });

    const source = numberedSource(30);
    const piped = source.pipeThrough(ts);
    const { writable, chunks } = slowWritable(3);
    await piped.pipeTo(writable);

    assert.strictEqual(chunks.length, 30);
    for (let i = 0; i < 30; i++) {
      assert.strictEqual(chunks[i], i * 10);
    }
  });
});

// ─── Pipeline backpressure (Tier 0) ─────────────────────────────────────────

describe('backpressure: pipeline (Tier 0)', () => {
  it('single-stage pipeline preserves all data with slow sink', async () => {
    const N = 30;
    const source = numberedSource(N);
    const ts = new FastTransformStream({
      transform(chunk, ctrl) { ctrl.enqueue(chunk); },
    });
    const piped = source.pipeThrough(ts);
    const { writable, chunks } = slowWritable(3);
    await piped.pipeTo(writable);

    assert.strictEqual(chunks.length, N);
    for (let i = 0; i < N; i++) {
      assert.strictEqual(chunks[i], i);
    }
  });

  it('multi-stage pipeline preserves ordering under backpressure', async () => {
    const N = 15;
    const source = numberedSource(N);

    let stream = source;
    for (let i = 0; i < 4; i++) {
      stream = stream.pipeThrough(new FastTransformStream({
        transform(chunk, ctrl) { ctrl.enqueue(chunk); },
      }));
    }

    const { writable, chunks } = slowWritable(4);
    await stream.pipeTo(writable);

    assert.strictEqual(chunks.length, N);
    for (let i = 0; i < N; i++) {
      assert.strictEqual(chunks[i], i);
    }
  });

  it('pipeline with data-producing flush preserves flush output', async () => {
    const source = eagerSource(3);
    const ts = new FastTransformStream({
      transform(chunk, ctrl) { ctrl.enqueue(`d:${chunk}`); },
      flush(ctrl) { ctrl.enqueue('END'); },
    });
    const piped = source.pipeThrough(ts);
    const { writable, chunks } = slowWritable(3);
    await piped.pipeTo(writable);

    assert.deepStrictEqual(chunks, ['d:0', 'd:1', 'd:2', 'END']);
  });

  it('pipeline without slow sink completes quickly', async () => {
    const N = 100;
    const source = numberedSource(N);
    const ts = new FastTransformStream({
      transform(chunk, ctrl) { ctrl.enqueue(chunk); },
    });
    const piped = source.pipeThrough(ts);
    const chunks = [];
    const writable = new FastWritableStream({
      write(chunk) { chunks.push(chunk); },
    });
    await piped.pipeTo(writable);
    assert.strictEqual(chunks.length, N);
  });
});

// ─── Reader/writer interaction ───────────────────────────────────────────────

describe('backpressure: reader-writer interaction', () => {
  it('slow reader does not cause data loss from fast source', async () => {
    const N = 20;
    const source = eagerSource(N);
    const reader = source.getReader();

    const chunks = [];
    for (let i = 0; i < N; i++) {
      if (i % 5 === 0) await new Promise((r) => setTimeout(r, 5));
      const { value, done } = await reader.read();
      assert.strictEqual(done, false);
      chunks.push(value);
    }
    const { done } = await reader.read();
    assert.strictEqual(done, true);
    assert.strictEqual(chunks.length, N);
    for (let i = 0; i < N; i++) {
      assert.strictEqual(chunks[i], i);
    }
  });

  it('pull-based source is called exactly as needed with hwm=1', async () => {
    let pullCount = 0;
    const source = new FastReadableStream({
      pull(c) {
        pullCount++;
        if (pullCount > 5) { c.close(); return; }
        c.enqueue(pullCount);
      },
    }, { highWaterMark: 1 });

    const reader = source.getReader();
    const chunks = [];
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    assert.deepStrictEqual(chunks, [1, 2, 3, 4, 5]);
    assert.strictEqual(pullCount, 6); // 5 data + 1 close
  });

  it('writer writes serialize in FIFO order', async () => {
    const order = [];
    const ws = new FastWritableStream({
      write(chunk) {
        return new Promise((r) => setTimeout(() => { order.push(chunk); r(); }, 5));
      },
    }, { highWaterMark: 1 });
    const writer = ws.getWriter();
    await writer.ready;

    // Queue 3 writes that resolve with 5ms delays
    await Promise.all([
      writer.write('a'),
      writer.write('b'),
      writer.write('c'),
    ]);

    assert.deepStrictEqual(order, ['a', 'b', 'c']);
    writer.releaseLock();
  });
});

// ─── High water mark configurations ─────────────────────────────────────────

describe('backpressure: highWaterMark configurations', () => {
  it('hwm=0 means desiredSize starts at 0', () => {
    const ws = new FastWritableStream({ write() {} }, { highWaterMark: 0 });
    const writer = ws.getWriter();
    assert.strictEqual(writer.desiredSize, 0);
    writer.releaseLock();
  });

  it('hwm=Infinity means desiredSize is always Infinity', async () => {
    const ws = new FastWritableStream({
      write() { return new Promise((r) => setTimeout(r, 1)); },
    }, { highWaterMark: Infinity });
    const writer = ws.getWriter();
    await writer.ready;

    assert.strictEqual(writer.desiredSize, Infinity);
    const writes = [];
    for (let i = 0; i < 10; i++) {
      writes.push(writer.write(i));
    }
    // desiredSize stays Infinity regardless of queue depth
    assert.strictEqual(writer.desiredSize, Infinity);
    await Promise.all(writes);
    writer.releaseLock();
  });

  it('readable hwm controls pull-ahead buffering', async () => {
    let pullCount = 0;
    const source = new FastReadableStream({
      pull(c) {
        pullCount++;
        if (pullCount > 100) { c.close(); return; }
        c.enqueue(pullCount);
      },
    }, { highWaterMark: 5 });

    // Let the source buffer up
    await new Promise((r) => setTimeout(r, 30));

    // pull should have been called enough to fill up to hwm
    assert.ok(pullCount >= 5, `expected at least 5 pulls, got ${pullCount}`);
    assert.ok(pullCount <= 12, `expected at most ~12 pulls, got ${pullCount}`);

    const reader = source.getReader();
    const chunks = [];
    for (let i = 0; i < pullCount && i < 100; i++) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    assert.ok(chunks.length >= 5);
    reader.releaseLock();
  });

  it('writable with hwm=5 allows 5 queued writes before backpressure', async () => {
    const ws = new FastWritableStream({
      write() { return new Promise((r) => setTimeout(r, 50)); },
    }, { highWaterMark: 5 });
    const writer = ws.getWriter();
    await writer.ready;
    assert.strictEqual(writer.desiredSize, 5);
    writer.releaseLock();
  });
});

// ─── Data integrity under backpressure ───────────────────────────────────────

describe('backpressure: data integrity', () => {
  it('100 items through slow writable: no data lost', async () => {
    const N = 100;
    const source = eagerSource(N);
    const { writable, chunks } = slowWritable(1);
    await source.pipeTo(writable);

    assert.strictEqual(chunks.length, N);
    for (let i = 0; i < N; i++) {
      assert.strictEqual(chunks[i], i);
    }
  });

  it('50 items through 3-stage transform chain + slow writable: no data lost', async () => {
    const N = 50;
    const source = eagerSource(N);

    let stream = source;
    for (let i = 0; i < 3; i++) {
      stream = stream.pipeThrough(new FastTransformStream({
        transform(chunk, ctrl) { ctrl.enqueue(chunk); },
      }));
    }

    const { writable, chunks } = slowWritable(1);
    await stream.pipeTo(writable);

    assert.strictEqual(chunks.length, N);
    for (let i = 0; i < N; i++) {
      assert.strictEqual(chunks[i], i);
    }
  });

  it('alternating fast and slow writes preserve ordering', async () => {
    const source = numberedSource(20);
    const chunks = [];
    let writeIndex = 0;

    const writable = new FastWritableStream({
      write(chunk) {
      const idx = writeIndex++;
        if (idx % 2 === 1) {
          return new Promise((r) => setTimeout(() => { chunks.push(chunk); r(); }, 5));
        }
        chunks.push(chunk);
      },
    });

    await source.pipeTo(writable);
    assert.strictEqual(chunks.length, 20);
    for (let i = 0; i < 20; i++) {
      assert.strictEqual(chunks[i], i);
    }
  });

  it('mixed sync and async transforms preserve data', async () => {
    const source = numberedSource(15);

    // Sync transform
    const t1 = new FastTransformStream({
      transform(chunk, ctrl) { ctrl.enqueue(chunk + 1000); },
    });
    // Async transform
    const t2 = new FastTransformStream({
      async transform(chunk, ctrl) {
        await new Promise((r) => queueMicrotask(r));
        ctrl.enqueue(chunk + 100);
      },
    });
    // Sync transform
    const t3 = new FastTransformStream({
      transform(chunk, ctrl) { ctrl.enqueue(chunk + 10); },
    });

    const piped = source.pipeThrough(t1).pipeThrough(t2).pipeThrough(t3);
    const chunks = [];
    const dest = new FastWritableStream({ write(chunk) { chunks.push(chunk); } });
    await piped.pipeTo(dest);

    assert.strictEqual(chunks.length, 15);
    for (let i = 0; i < 15; i++) {
      assert.strictEqual(chunks[i], i + 1110);
    }
  });

  it('concurrent pipe chains do not interfere', async () => {
    const run = async (offset) => {
      const source = numberedSource(20);
      const ts = new FastTransformStream({
        transform(chunk, ctrl) { ctrl.enqueue(chunk + offset); },
      });
      const piped = source.pipeThrough(ts);
      const { writable, chunks } = slowWritable(2);
      await piped.pipeTo(writable);
      return chunks;
    };

    const [r1, r2, r3] = await Promise.all([run(0), run(1000), run(2000)]);

    for (let i = 0; i < 20; i++) {
      assert.strictEqual(r1[i], i);
      assert.strictEqual(r2[i], i + 1000);
      assert.strictEqual(r3[i], i + 2000);
    }
  });
});

// ─── Abort / cancel under backpressure ───────────────────────────────────────

describe('backpressure: abort and cancel', () => {
  it('abort signal stops pipeTo even when dest has backpressure', async () => {
    const source = numberedSource(1000);
    const { writable, chunks } = slowWritable(10);
    const ac = new AbortController();

    setTimeout(() => ac.abort(), 50);

    await assert.rejects(
      source.pipeTo(writable, { signal: ac.signal }),
      (err) => err.name === 'AbortError',
    );

    assert.ok(chunks.length > 0, 'should have written some chunks');
    assert.ok(chunks.length < 1000, 'should have stopped before finishing');
    for (let i = 1; i < chunks.length; i++) {
      assert.strictEqual(chunks[i], chunks[i - 1] + 1, `ordering broken at ${i}`);
    }
  });

  it('reader.cancel() during backpressured transform does not hang', async () => {
    const ts = new FastTransformStream({
      async transform(chunk, ctrl) {
        await new Promise((r) => setTimeout(r, 5));
        ctrl.enqueue(chunk);
      },
    });

    const source = numberedSource(100);
    const piped = source.pipeThrough(ts);
    const reader = piped.getReader();

    const { value: v1 } = await reader.read();
    assert.strictEqual(v1, 0);
    const { value: v2 } = await reader.read();
    assert.strictEqual(v2, 1);

    await reader.cancel('done early');
  });

  it('abort during pipeThrough chain stops all stages', async () => {
    const source = numberedSource(1000);
    let stream = source;
    for (let i = 0; i < 2; i++) {
      stream = stream.pipeThrough(new FastTransformStream({
        transform(chunk, ctrl) { ctrl.enqueue(chunk); },
      }));
    }

    const { writable, chunks } = slowWritable(5);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 30);

    await assert.rejects(
      stream.pipeTo(writable, { signal: ac.signal }),
      (err) => err.name === 'AbortError',
    );

    assert.ok(chunks.length < 1000, 'pipeline should have stopped');
  });
});

// ─── specPipeTo backpressure (Tier 2) ────────────────────────────────────────

describe('backpressure: specPipeTo (Tier 2 path)', () => {
  it('preventClose pipeTo still delivers all data under backpressure', async () => {
    const N = 15;
    const source = numberedSource(N);
    const { writable, chunks } = slowWritable(3);
    await source.pipeTo(writable, { preventClose: true });

    assert.strictEqual(chunks.length, N);
    for (let i = 0; i < N; i++) {
      assert.strictEqual(chunks[i], i);
    }
  });

  it('preventAbort pipeTo delivers data under backpressure', async () => {
    const N = 10;
    const source = numberedSource(N);
    const { writable, chunks } = slowWritable(3);
    await source.pipeTo(writable, { preventAbort: true });

    assert.strictEqual(chunks.length, N);
    for (let i = 0; i < N; i++) {
      assert.strictEqual(chunks[i], i);
    }
  });

  it('preventCancel pipeTo delivers data under backpressure', async () => {
    const N = 10;
    const source = numberedSource(N);
    const { writable, chunks } = slowWritable(3);
    await source.pipeTo(writable, { preventCancel: true });

    assert.strictEqual(chunks.length, N);
    for (let i = 0; i < N; i++) {
      assert.strictEqual(chunks[i], i);
    }
  });
});
