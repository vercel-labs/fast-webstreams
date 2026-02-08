/**
 * Tests that reproduce the Next.js SSR streaming pattern.
 *
 * Next.js pipes rendered HTML through multiple pipeThrough transforms
 * (text encoding, RSC flight data inlining, etc.) and calls
 * pipeTo(dest, { signal }) to stream to the HTTP response.
 *
 * These tests verify:
 * 1. pipeThrough chains complete with signal option
 * 2. Large payloads don't hang (backpressure through transform chain)
 * 3. Symbol.hasInstance works (Node internals use instanceof)
 * 4. HTTP response streaming works end-to-end (with proper drain handling)
 * 5. Abort signal tears down the pipeline correctly
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import http from 'node:http';

import { patchGlobalWebStreams, unpatchGlobalWebStreams } from '../src/patch.js';
import { FastReadableStream, FastWritableStream, FastTransformStream } from '../src/index.js';
import {
  NativeReadableStream,
  NativeWritableStream,
  NativeTransformStream,
} from '../src/natives.js';

/**
 * Create a WritableStream that writes to an HTTP response with proper
 * backpressure handling (mirrors Next.js's createWriterFromResponse).
 */
function createResponseWritable(res) {
  let drainResolve = null;
  res.on('drain', () => { if (drainResolve) { drainResolve(); drainResolve = null; } });
  return new WritableStream({
    async write(chunk) {
      const ok = res.write(chunk);
      if (!ok) {
        await new Promise((resolve) => { drainResolve = resolve; });
      }
    },
    close() { res.end(); },
  });
}

describe('Next.js compat: pipeThrough chain + pipeTo with signal', () => {
  afterEach(() => unpatchGlobalWebStreams());

  it('small payload through 6 transforms with signal completes', async () => {
    patchGlobalWebStreams();

    let stream = new ReadableStream({
      start(c) {
        c.enqueue('hello');
        c.close();
      },
    });

    for (let i = 0; i < 6; i++) {
      stream = stream.pipeThrough(new TransformStream({
        transform(chunk, ctrl) { ctrl.enqueue(chunk); },
      }));
    }

    const chunks = [];
    const dest = new WritableStream({
      write(chunk) { chunks.push(chunk); },
    });

    const ac = new AbortController();
    await stream.pipeTo(dest, { signal: ac.signal });
    assert.deepStrictEqual(chunks, ['hello']);
  });

  it('large payload (5MB) through 6 transforms with signal completes', async () => {
    patchGlobalWebStreams();

    const CHUNKS = 200;
    const CHUNK_SIZE = 28000;

    let stream = new ReadableStream({
      start(c) {
        for (let i = 0; i < CHUNKS; i++) {
          c.enqueue('x'.repeat(CHUNK_SIZE));
        }
        c.close();
      },
    });

    for (let i = 0; i < 6; i++) {
      stream = stream.pipeThrough(new TransformStream({
        transform(chunk, ctrl) { ctrl.enqueue(chunk); },
      }));
    }

    let totalBytes = 0;
    const dest = new WritableStream({
      write(chunk) { totalBytes += chunk.length; },
    });

    const ac = new AbortController();
    await stream.pipeTo(dest, { signal: ac.signal });
    assert.strictEqual(totalBytes, CHUNKS * CHUNK_SIZE);
  });

  it('large binary payload through 6 transforms with signal completes', async () => {
    patchGlobalWebStreams();

    const CHUNKS = 200;
    const CHUNK_SIZE = 28000;

    let stream = new ReadableStream({
      start(c) {
        for (let i = 0; i < CHUNKS; i++) {
          c.enqueue(new Uint8Array(CHUNK_SIZE).fill(0x41));
        }
        c.close();
      },
    });

    for (let i = 0; i < 6; i++) {
      stream = stream.pipeThrough(new TransformStream({
        transform(chunk, ctrl) { ctrl.enqueue(chunk); },
      }));
    }

    let totalBytes = 0;
    const dest = new WritableStream({
      write(chunk) { totalBytes += chunk.byteLength; },
    });

    const ac = new AbortController();
    await stream.pipeTo(dest, { signal: ac.signal });
    assert.strictEqual(totalBytes, CHUNKS * CHUNK_SIZE);
  });

  it('pipeThrough chain without signal still uses fast pipeline path', async () => {
    patchGlobalWebStreams();

    let stream = new ReadableStream({
      start(c) {
        c.enqueue('a');
        c.enqueue('b');
        c.close();
      },
    });

    for (let i = 0; i < 3; i++) {
      stream = stream.pipeThrough(new TransformStream({
        transform(chunk, ctrl) { ctrl.enqueue(chunk + i); },
      }));
    }

    const chunks = [];
    const dest = new WritableStream({
      write(chunk) { chunks.push(chunk); },
    });

    // No signal — should use Tier 0 pipeline
    await stream.pipeTo(dest);
    assert.strictEqual(chunks.length, 2);
  });
});

describe('Next.js compat: HTTP response streaming', () => {
  afterEach(() => unpatchGlobalWebStreams());

  it('streams payload to HTTP response via pipeThrough + pipeTo', async (t) => {
    patchGlobalWebStreams();

    const server = http.createServer(async (req, res) => {
      let stream = new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('Hello World'));
          c.close();
        },
      });

      for (let i = 0; i < 6; i++) {
        stream = stream.pipeThrough(new TransformStream({
          transform(chunk, ctrl) { ctrl.enqueue(chunk); },
        }));
      }

      const ac = new AbortController();
      res.on('close', () => { if (!ac.signal.aborted) ac.abort(); });
      const dest = createResponseWritable(res);

      try {
        await stream.pipeTo(dest, { signal: ac.signal });
      } catch (e) {
        if (e.code !== 'ABORT_ERR' && e.name !== 'AbortError') throw e;
      }
    });

    try {
      await new Promise((resolve, reject) => {
        server.on('error', reject);
        server.listen(0, resolve);
      });
    } catch (e) {
      if (e.code === 'EPERM' || e.code === 'EACCES') { t.skip('cannot listen (sandboxed)'); return; }
      throw e;
    }
    const port = server.address().port;

    try {
      const resp = await fetch(`http://localhost:${port}`);
      assert.strictEqual(resp.status, 200);
      const body = await resp.text();
      assert.strictEqual(body, 'Hello World');
    } finally {
      server.close();
      server.closeAllConnections();
    }
  });
});

describe('Next.js compat: abort signal tears down pipeline', () => {
  afterEach(() => unpatchGlobalWebStreams());

  it('aborting signal stops a pipeThrough + pipeTo chain', async () => {
    patchGlobalWebStreams();

    // Use a slow async pull so the stream is still active when abort fires
    let pullCount = 0;
    let stream = new ReadableStream({
      async pull(c) {
        pullCount++;
        if (pullCount > 1000) { c.close(); return; }
        await new Promise((r) => setTimeout(r, 5));
        c.enqueue('chunk' + pullCount);
      },
    });

    stream = stream.pipeThrough(new TransformStream({
      transform(chunk, ctrl) { ctrl.enqueue(chunk); },
    }));

    const chunks = [];
    const dest = new WritableStream({
      write(chunk) { chunks.push(chunk); },
    });

    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);

    await assert.rejects(
      stream.pipeTo(dest, { signal: ac.signal }),
      (err) => err.name === 'AbortError' || err.code === 'ABORT_ERR',
    );

    assert.ok(chunks.length > 0, 'should have written some chunks before abort');
    assert.ok(chunks.length < 1000, 'should have stopped before exhausting source');
  });

  it('already-aborted signal rejects pipeTo immediately', async () => {
    patchGlobalWebStreams();

    const stream = new ReadableStream({ start(c) { c.enqueue('x'); c.close(); } });
    const dest = new WritableStream({ write() {} });

    const ac = new AbortController();
    ac.abort();

    await assert.rejects(
      stream.pipeTo(dest, { signal: ac.signal }),
    );
  });
});

describe('Next.js compat: Symbol.hasInstance after patch', () => {
  afterEach(() => unpatchGlobalWebStreams());

  it('FastReadableStream passes instanceof NativeReadableStream', () => {
    patchGlobalWebStreams();
    const rs = new ReadableStream();
    assert.ok(rs instanceof NativeReadableStream,
      'FastReadableStream should pass instanceof NativeReadableStream');
  });

  it('FastWritableStream passes instanceof NativeWritableStream', () => {
    patchGlobalWebStreams();
    const ws = new WritableStream();
    assert.ok(ws instanceof NativeWritableStream,
      'FastWritableStream should pass instanceof NativeWritableStream');
  });

  it('FastTransformStream passes instanceof NativeTransformStream', () => {
    patchGlobalWebStreams();
    const ts = new TransformStream();
    assert.ok(ts instanceof NativeTransformStream,
      'FastTransformStream should pass instanceof NativeTransformStream');
  });

  it('native instances still pass instanceof after unpatch', () => {
    patchGlobalWebStreams();
    unpatchGlobalWebStreams();
    const rs = new ReadableStream();
    assert.ok(rs instanceof NativeReadableStream);
    assert.ok(!(rs instanceof FastReadableStream),
      'should be native after unpatch');
  });
});
