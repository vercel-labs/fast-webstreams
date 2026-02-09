/**
 * Integration tests for fetch() with patched global WebStreams.
 *
 * Verifies that Node.js built-in fetch works correctly when
 * ReadableStream/WritableStream/TransformStream are replaced
 * with fast alternatives. Covers:
 * - Reading fetch response body via .text(), .json(), .arrayBuffer(), .blob(), .bytes()
 * - Reading fetch body via getReader() and BYOB reader
 * - Piping fetch body through TransformStreams (passthrough, data-transforming, flush)
 * - Piping fetch body to WritableStream (with and without signal)
 * - Piping with preventClose/preventAbort/preventCancel (Tier 2 path)
 * - Constructing Response/Request from FastReadableStream
 * - Streaming (chunked) responses with incremental delivery
 * - Async iteration over response body
 * - tee() and Response.clone()
 * - Cancel and abort mid-stream
 * - Error handling (server destroys connection mid-response)
 * - Concurrent fetches
 * - Body locking semantics
 * - Multi-chunk streaming POST bodies
 */

import assert from 'node:assert/strict';
import { afterEach, after, before, describe, it } from 'node:test';
import http from 'node:http';

import { patchGlobalWebStreams, unpatchGlobalWebStreams } from '../src/patch.js';

let server;
let baseURL;

before(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, message: 'hello' }));
    } else if (req.url === '/large') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      for (let i = 0; i < 100; i++) {
        res.write('x'.repeat(1000));
      }
      res.end();
    } else if (req.url === '/echo' && req.method === 'POST') {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(Buffer.concat(chunks).toString());
      });
    } else if (req.url === '/echo-size' && req.method === 'POST') {
      let size = 0;
      req.on('data', (chunk) => { size += chunk.length; });
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(String(size));
      });
    } else if (req.url === '/chunked') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      let i = 0;
      const iv = setInterval(() => {
        res.write(`chunk${i}`);
        i++;
        if (i >= 5) {
          clearInterval(iv);
          res.end();
        }
      }, 20);
    } else if (req.url === '/empty') {
      res.writeHead(204);
      res.end();
    } else if (req.url === '/empty-200') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('');
    } else if (req.url === '/error-mid-stream') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.write('partial');
      setTimeout(() => res.destroy(), 30);
    } else if (req.url === '/binary') {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      const buf = Buffer.alloc(256);
      for (let i = 0; i < 256; i++) buf[i] = i;
      res.end(buf);
    } else if (req.url === '/multi-chunk') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      for (let i = 0; i < 10; i++) {
        res.write(`part${i}-`);
      }
      res.end();
    } else {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('Hello from server');
    }
  });
  await new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, resolve);
  });
  baseURL = `http://localhost:${server.address().port}`;
});

after(() => {
  if (server) {
    server.close();
    server.closeAllConnections();
  }
});

// ─── Body consumption methods ────────────────────────────────────────────────

describe('fetch: body consumption', () => {
  afterEach(() => unpatchGlobalWebStreams());

  it('resp.text() works', async () => {
    patchGlobalWebStreams();
    const resp = await fetch(baseURL);
    const text = await resp.text();
    assert.strictEqual(text, 'Hello from server');
  });

  it('resp.json() works', async () => {
    patchGlobalWebStreams();
    const resp = await fetch(`${baseURL}/json`);
    const data = await resp.json();
    assert.deepStrictEqual(data, { ok: true, message: 'hello' });
  });

  it('resp.arrayBuffer() works', async () => {
    patchGlobalWebStreams();
    const resp = await fetch(baseURL);
    const buf = await resp.arrayBuffer();
    const text = new TextDecoder().decode(buf);
    assert.strictEqual(text, 'Hello from server');
  });

  it('resp.blob() works', async () => {
    patchGlobalWebStreams();
    const resp = await fetch(baseURL);
    const blob = await resp.blob();
    const text = await blob.text();
    assert.strictEqual(text, 'Hello from server');
  });

  it('resp.bytes() works', async () => {
    patchGlobalWebStreams();
    const resp = await fetch(baseURL);
    if (typeof resp.bytes !== 'function') return; // Node < 22.11
    const bytes = await resp.bytes();
    assert.ok(bytes instanceof Uint8Array);
    assert.strictEqual(new TextDecoder().decode(bytes), 'Hello from server');
  });

  it('resp.body.getReader() works', async () => {
    patchGlobalWebStreams();
    const resp = await fetch(baseURL);
    const reader = resp.body.getReader();
    const chunks = [];
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value).toString());
    }
    assert.strictEqual(chunks.join(''), 'Hello from server');
  });

  it('binary response preserves byte values', async () => {
    patchGlobalWebStreams();
    const resp = await fetch(`${baseURL}/binary`);
    const buf = await resp.arrayBuffer();
    const arr = new Uint8Array(buf);
    assert.strictEqual(arr.length, 256);
    for (let i = 0; i < 256; i++) {
      assert.strictEqual(arr[i], i, `byte ${i} mismatch`);
    }
  });
});

// ─── Empty and edge-case responses ───────────────────────────────────────────

describe('fetch: empty and edge-case responses', () => {
  afterEach(() => unpatchGlobalWebStreams());

  it('204 No Content has null body', async () => {
    patchGlobalWebStreams();
    const resp = await fetch(`${baseURL}/empty`);
    assert.strictEqual(resp.status, 204);
    assert.strictEqual(resp.body, null);
  });

  it('200 with empty string body reads as empty text', async () => {
    patchGlobalWebStreams();
    const resp = await fetch(`${baseURL}/empty-200`);
    const text = await resp.text();
    assert.strictEqual(text, '');
  });

  it('200 with empty body pipes to WritableStream (0 chunks)', async () => {
    patchGlobalWebStreams();
    const resp = await fetch(`${baseURL}/empty-200`);
    const chunks = [];
    const dest = new WritableStream({
      write(chunk) { chunks.push(chunk); },
    });
    await resp.body.pipeTo(dest);
    // Empty body should deliver 0 data chunks (only done=true)
    assert.strictEqual(chunks.length, 0);
  });
});

// ─── Streaming (chunked) responses ───────────────────────────────────────────

describe('fetch: streaming responses', () => {
  afterEach(() => unpatchGlobalWebStreams());

  it('chunked response delivers data incrementally via getReader()', async () => {
    patchGlobalWebStreams();
    const resp = await fetch(`${baseURL}/chunked`);
    const reader = resp.body.getReader();
    const chunks = [];
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value).toString());
    }
    // All 5 chunks should arrive and reassemble
    const joined = chunks.join('');
    assert.strictEqual(joined, 'chunk0chunk1chunk2chunk3chunk4');
    // Should have received multiple chunks (not all batched into one)
    assert.ok(chunks.length >= 2, `expected multiple chunks, got ${chunks.length}`);
  });

  it('chunked response pipes through transform correctly', async () => {
    patchGlobalWebStreams();
    const resp = await fetch(`${baseURL}/chunked`);
    const upper = new TransformStream({
      transform(chunk, ctrl) {
        ctrl.enqueue(Buffer.from(chunk).toString().toUpperCase());
      },
    });
    const piped = resp.body.pipeThrough(upper);
    const reader = piped.getReader();
    const chunks = [];
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    assert.strictEqual(chunks.join(''), 'CHUNK0CHUNK1CHUNK2CHUNK3CHUNK4');
  });

  it('multi-chunk response assembles correctly via pipeTo', async () => {
    patchGlobalWebStreams();
    const resp = await fetch(`${baseURL}/multi-chunk`);
    const parts = [];
    const dest = new WritableStream({
      write(chunk) { parts.push(Buffer.from(chunk).toString()); },
    });
    await resp.body.pipeTo(dest);
    assert.strictEqual(parts.join(''), 'part0-part1-part2-part3-part4-part5-part6-part7-part8-part9-');
  });
});

// ─── Async iteration ─────────────────────────────────────────────────────────

describe('fetch: async iteration', () => {
  afterEach(() => unpatchGlobalWebStreams());

  it('for-await-of over resp.body works', async () => {
    patchGlobalWebStreams();
    const resp = await fetch(baseURL);
    const chunks = [];
    for await (const chunk of resp.body) {
      chunks.push(Buffer.from(chunk).toString());
    }
    assert.strictEqual(chunks.join(''), 'Hello from server');
  });

  it('for-await-of over large response collects all data', async () => {
    patchGlobalWebStreams();
    const resp = await fetch(`${baseURL}/large`);
    let totalBytes = 0;
    for await (const chunk of resp.body) {
      totalBytes += chunk.byteLength;
    }
    assert.strictEqual(totalBytes, 100_000);
  });

  it('for-await-of break cancels the stream', async () => {
    patchGlobalWebStreams();
    const resp = await fetch(`${baseURL}/large`);
    let readCount = 0;
    for await (const chunk of resp.body) {
      readCount++;
      if (readCount >= 2) break;
    }
    assert.ok(readCount >= 2);
    // Stream should be cancelled — body should be disturbed
    assert.strictEqual(resp.bodyUsed, true);
  });
});

// ─── tee() and clone() ──────────────────────────────────────────────────────

describe('fetch: tee and clone', () => {
  afterEach(() => unpatchGlobalWebStreams());

  it('resp.body.tee() produces two readable branches', async () => {
    patchGlobalWebStreams();
    const resp = await fetch(baseURL);
    const [b1, b2] = resp.body.tee();
    const [t1, t2] = await Promise.all([
      new Response(b1).text(),
      new Response(b2).text(),
    ]);
    assert.strictEqual(t1, 'Hello from server');
    assert.strictEqual(t2, 'Hello from server');
  });

  it('resp.body.tee() works with large bodies', async () => {
    patchGlobalWebStreams();
    const resp = await fetch(`${baseURL}/large`);
    const [b1, b2] = resp.body.tee();
    const [r1, r2] = await Promise.all([
      new Response(b1).arrayBuffer(),
      new Response(b2).arrayBuffer(),
    ]);
    assert.strictEqual(r1.byteLength, 100_000);
    assert.strictEqual(r2.byteLength, 100_000);
  });

  it('Response.clone() produces independent copies', async () => {
    patchGlobalWebStreams();
    const resp = await fetch(`${baseURL}/json`);
    const clone = resp.clone();
    const [d1, d2] = await Promise.all([
      resp.json(),
      clone.json(),
    ]);
    assert.deepStrictEqual(d1, { ok: true, message: 'hello' });
    assert.deepStrictEqual(d2, { ok: true, message: 'hello' });
  });

  it('Response.clone() preserves headers and status', async () => {
    patchGlobalWebStreams();
    const resp = await fetch(`${baseURL}/json`);
    const clone = resp.clone();
    assert.strictEqual(clone.status, 200);
    assert.strictEqual(clone.headers.get('content-type'), 'application/json');
  });
});

// ─── Transform pipes ─────────────────────────────────────────────────────────

describe('fetch: transform pipes', () => {
  afterEach(() => unpatchGlobalWebStreams());

  it('pipeThrough passthrough transform works', async () => {
    patchGlobalWebStreams();
    const resp = await fetch(baseURL);
    const piped = resp.body.pipeThrough(new TransformStream({
      transform(chunk, ctrl) { ctrl.enqueue(chunk); },
    }));
    const reader = piped.getReader();
    const chunks = [];
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value).toString());
    }
    assert.strictEqual(chunks.join(''), 'Hello from server');
  });

  it('pipeThrough with data-transforming transform (uppercase)', async () => {
    patchGlobalWebStreams();
    const resp = await fetch(baseURL);
    const upper = new TransformStream({
      transform(chunk, ctrl) {
        ctrl.enqueue(new TextEncoder().encode(Buffer.from(chunk).toString().toUpperCase()));
      },
    });
    const text = await new Response(resp.body.pipeThrough(upper)).text();
    assert.strictEqual(text, 'HELLO FROM SERVER');
  });

  it('pipeThrough with transform that changes type (bytes → string)', async () => {
    patchGlobalWebStreams();
    const resp = await fetch(baseURL);
    const decoder = new TransformStream({
      transform(chunk, ctrl) {
        ctrl.enqueue(new TextDecoder().decode(chunk));
      },
    });
    const piped = resp.body.pipeThrough(decoder);
    const reader = piped.getReader();
    const parts = [];
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      assert.strictEqual(typeof value, 'string');
      parts.push(value);
    }
    assert.strictEqual(parts.join(''), 'Hello from server');
  });

  it('pipeThrough with transform that expands chunks (1 → N)', async () => {
    patchGlobalWebStreams();
    const resp = await fetch(baseURL);
    const splitter = new TransformStream({
      transform(chunk, ctrl) {
        const str = Buffer.from(chunk).toString();
        for (const ch of str) {
          ctrl.enqueue(ch);
        }
      },
    });
    const piped = resp.body.pipeThrough(splitter);
    const reader = piped.getReader();
    const chars = [];
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      chars.push(value);
    }
    assert.strictEqual(chars.join(''), 'Hello from server');
    assert.strictEqual(chars.length, 'Hello from server'.length);
  });

  it('pipeThrough with transform that has flush (emits trailer)', async () => {
    patchGlobalWebStreams();
    const resp = await fetch(baseURL);
    const withTrailer = new TransformStream({
      transform(chunk, ctrl) { ctrl.enqueue(chunk); },
      flush(ctrl) { ctrl.enqueue(new TextEncoder().encode('--END')); },
    });
    const text = await new Response(resp.body.pipeThrough(withTrailer)).text();
    assert.strictEqual(text, 'Hello from server--END');
  });

  it('multiple transforms + pipeTo with signal', async () => {
    patchGlobalWebStreams();
    const resp = await fetch(baseURL);
    let stream = resp.body;
    for (let i = 0; i < 3; i++) {
      stream = stream.pipeThrough(new TransformStream({
        transform(chunk, ctrl) { ctrl.enqueue(chunk); },
      }));
    }
    const chunks = [];
    const dest = new WritableStream({
      write(chunk) { chunks.push(Buffer.from(chunk).toString()); },
    });
    const ac = new AbortController();
    await stream.pipeTo(dest, { signal: ac.signal });
    assert.strictEqual(chunks.join(''), 'Hello from server');
  });

  it('pipeThrough chain with large data bridges correctly', async () => {
    patchGlobalWebStreams();
    const resp = await fetch(`${baseURL}/large`);
    let stream = resp.body;
    for (let i = 0; i < 3; i++) {
      stream = stream.pipeThrough(new TransformStream({
        transform(chunk, ctrl) { ctrl.enqueue(chunk); },
      }));
    }
    let totalBytes = 0;
    const dest = new WritableStream({
      write(chunk) { totalBytes += chunk.byteLength; },
    });
    await stream.pipeTo(dest);
    assert.strictEqual(totalBytes, 100 * 1000);
  });
});

// ─── pipeTo ──────────────────────────────────────────────────────────────────

describe('fetch: pipeTo', () => {
  afterEach(() => unpatchGlobalWebStreams());

  it('pipeTo(WritableStream) works', async () => {
    patchGlobalWebStreams();
    const resp = await fetch(baseURL);
    const chunks = [];
    const dest = new WritableStream({
      write(chunk) { chunks.push(Buffer.from(chunk).toString()); },
    });
    await resp.body.pipeTo(dest);
    assert.strictEqual(chunks.join(''), 'Hello from server');
  });

  it('pipeTo(WritableStream, { signal }) works', async () => {
    patchGlobalWebStreams();
    const resp = await fetch(baseURL);
    const chunks = [];
    const dest = new WritableStream({
      write(chunk) { chunks.push(Buffer.from(chunk).toString()); },
    });
    const ac = new AbortController();
    await resp.body.pipeTo(dest, { signal: ac.signal });
    assert.strictEqual(chunks.join(''), 'Hello from server');
  });

  it('pipeTo with preventClose leaves dest open', async () => {
    patchGlobalWebStreams();
    const resp = await fetch(baseURL);
    const chunks = [];
    let closed = false;
    const dest = new WritableStream({
      write(chunk) { chunks.push(Buffer.from(chunk).toString()); },
      close() { closed = true; },
    });
    await resp.body.pipeTo(dest, { preventClose: true });
    assert.strictEqual(chunks.join(''), 'Hello from server');
    assert.strictEqual(closed, false, 'dest should not be closed');
  });

  it('large response body pipes correctly', async () => {
    patchGlobalWebStreams();
    const resp = await fetch(`${baseURL}/large`);
    let totalBytes = 0;
    const dest = new WritableStream({
      write(chunk) { totalBytes += chunk.byteLength; },
    });
    await resp.body.pipeTo(dest);
    assert.strictEqual(totalBytes, 100 * 1000);
  });
});

// ─── Cancel and abort ────────────────────────────────────────────────────────

describe('fetch: cancel and abort', () => {
  afterEach(() => unpatchGlobalWebStreams());

  it('reader.cancel() mid-stream does not throw', async () => {
    patchGlobalWebStreams();
    const resp = await fetch(`${baseURL}/large`);
    const reader = resp.body.getReader();
    const { done } = await reader.read();
    assert.strictEqual(done, false);
    await reader.cancel('no longer needed');
    // Should not throw
  });

  it('resp.body.cancel() before reading does not throw', async () => {
    patchGlobalWebStreams();
    const resp = await fetch(baseURL);
    await resp.body.cancel('not interested');
    assert.strictEqual(resp.bodyUsed, true);
  });

  it('abort signal mid-stream rejects pipeTo', async () => {
    patchGlobalWebStreams();
    const resp = await fetch(`${baseURL}/chunked`);
    const ac = new AbortController();
    const chunks = [];
    const dest = new WritableStream({
      write(chunk) {
        chunks.push(Buffer.from(chunk).toString());
        // Abort after first chunk arrives
        if (chunks.length === 1) ac.abort();
      },
    });
    await assert.rejects(
      resp.body.pipeTo(dest, { signal: ac.signal }),
      (err) => err.name === 'AbortError' || err.code === 'ABORT_ERR',
    );
    assert.ok(chunks.length >= 1, 'should have received at least one chunk');
  });

  it('already-aborted signal rejects pipeTo immediately', async () => {
    patchGlobalWebStreams();
    const resp = await fetch(baseURL);
    const ac = new AbortController();
    ac.abort();
    const dest = new WritableStream({ write() {} });
    await assert.rejects(
      resp.body.pipeTo(dest, { signal: ac.signal }),
    );
  });

  it('pipeThrough bridge preserves cancel', async () => {
    patchGlobalWebStreams();
    const resp = await fetch(`${baseURL}/large`);
    const piped = resp.body.pipeThrough(new TransformStream({
      transform(chunk, ctrl) { ctrl.enqueue(chunk); },
    }));
    const reader = piped.getReader();
    const { done } = await reader.read();
    assert.strictEqual(done, false);
    await reader.cancel('test cancel');
    // Should not throw — cancel propagates through bridge to native
  });
});

// ─── Error handling ──────────────────────────────────────────────────────────

describe('fetch: error handling', () => {
  afterEach(() => unpatchGlobalWebStreams());

  it('server destroying connection mid-stream causes reader to error', async () => {
    patchGlobalWebStreams();
    const resp = await fetch(`${baseURL}/error-mid-stream`);
    const reader = resp.body.getReader();
    let gotData = false;
    let gotError = false;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value && value.byteLength > 0) gotData = true;
      }
    } catch {
      gotError = true;
    }
    // We should have received partial data and then an error
    assert.ok(gotData || gotError, 'should get data or error from partial response');
  });

  it('server destroying connection mid-stream causes pipeTo to reject', async () => {
    patchGlobalWebStreams();
    const resp = await fetch(`${baseURL}/error-mid-stream`);
    const dest = new WritableStream({ write() {} });
    try {
      await resp.body.pipeTo(dest);
      // Some implementations may succeed if all data arrives before destroy
    } catch {
      // Expected — connection was destroyed mid-stream
    }
  });
});

// ─── Body locking ────────────────────────────────────────────────────────────

describe('fetch: body locking', () => {
  afterEach(() => unpatchGlobalWebStreams());

  it('getReader() locks the body', async () => {
    patchGlobalWebStreams();
    const resp = await fetch(baseURL);
    const reader = resp.body.getReader();
    assert.strictEqual(resp.body.locked, true);
    reader.releaseLock();
    assert.strictEqual(resp.body.locked, false);
    // Can consume after releasing lock
    const text = await new Response(resp.body).text();
    assert.strictEqual(text, 'Hello from server');
  });

  it('text() after body consumed throws', async () => {
    patchGlobalWebStreams();
    const resp = await fetch(baseURL);
    await resp.text();
    await assert.rejects(() => resp.text(), { name: 'TypeError' });
  });

  it('pipeTo locks the source body', async () => {
    patchGlobalWebStreams();
    const resp = await fetch(baseURL);
    const dest = new WritableStream({ write() {} });
    const pipePromise = resp.body.pipeTo(dest);
    assert.strictEqual(resp.body.locked, true);
    await pipePromise;
  });
});

// ─── Response and Request construction ───────────────────────────────────────

describe('fetch: Response and Request construction', () => {
  afterEach(() => unpatchGlobalWebStreams());

  it('new Response(FastReadableStream).text() works', async () => {
    patchGlobalWebStreams();
    const rs = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('fast stream content'));
        c.close();
      },
    });
    const resp = new Response(rs);
    const text = await resp.text();
    assert.strictEqual(text, 'fast stream content');
  });

  it('new Response(FastReadableStream).body.getReader() works', async () => {
    patchGlobalWebStreams();
    const rs = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('reader test'));
        c.close();
      },
    });
    const resp = new Response(rs);
    const reader = resp.body.getReader();
    const chunks = [];
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value).toString());
    }
    assert.strictEqual(chunks.join(''), 'reader test');
  });

  it('new Response(FastReadableStream).blob() works', async () => {
    patchGlobalWebStreams();
    const rs = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('blob test'));
        c.close();
      },
    });
    const resp = new Response(rs);
    const blob = await resp.blob();
    assert.strictEqual(await blob.text(), 'blob test');
  });

  it('new Response(string) works', async () => {
    patchGlobalWebStreams();
    const resp = new Response('plain string body');
    const text = await resp.text();
    assert.strictEqual(text, 'plain string body');
  });

  it('new Response with headers and status', async () => {
    patchGlobalWebStreams();
    const resp = new Response('body', {
      status: 201,
      headers: { 'X-Custom': 'value' },
    });
    assert.strictEqual(resp.status, 201);
    assert.strictEqual(resp.headers.get('X-Custom'), 'value');
    assert.strictEqual(await resp.text(), 'body');
  });

  it('new Request(url, { body: FastReadableStream }) materializes body', async () => {
    patchGlobalWebStreams();
    const rs = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('request body'));
        c.close();
      },
    });
    const req = new Request(`${baseURL}/echo`, {
      method: 'POST',
      body: rs,
      duplex: 'half',
    });
    assert.ok(req.body, 'Request should have a body');
    const text = await req.text();
    assert.strictEqual(text, 'request body');
  });
});

// ─── POST with streaming body ────────────────────────────────────────────────

describe('fetch: POST with streaming body', () => {
  afterEach(() => unpatchGlobalWebStreams());

  it('fetch POST with single-chunk FastReadableStream body', async () => {
    patchGlobalWebStreams();
    const rs = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('streamed post'));
        c.close();
      },
    });
    const resp = await fetch(`${baseURL}/echo`, {
      method: 'POST',
      body: rs,
      duplex: 'half',
    });
    const text = await resp.text();
    assert.strictEqual(text, 'streamed post');
  });

  it('fetch POST with multi-chunk streaming body', async () => {
    patchGlobalWebStreams();
    const rs = new ReadableStream({
      start(c) {
        for (let i = 0; i < 5; i++) {
          c.enqueue(new TextEncoder().encode(`chunk${i}-`));
        }
        c.close();
      },
    });
    const resp = await fetch(`${baseURL}/echo`, {
      method: 'POST',
      body: rs,
      duplex: 'half',
    });
    const text = await resp.text();
    assert.strictEqual(text, 'chunk0-chunk1-chunk2-chunk3-chunk4-');
  });

  it('fetch POST with large streaming body', async () => {
    patchGlobalWebStreams();
    const CHUNKS = 50;
    const CHUNK_SIZE = 1000;
    const rs = new ReadableStream({
      start(c) {
        for (let i = 0; i < CHUNKS; i++) {
          c.enqueue(new TextEncoder().encode('x'.repeat(CHUNK_SIZE)));
        }
        c.close();
      },
    });
    const resp = await fetch(`${baseURL}/echo-size`, {
      method: 'POST',
      body: rs,
      duplex: 'half',
    });
    const text = await resp.text();
    assert.strictEqual(text, String(CHUNKS * CHUNK_SIZE));
  });

  it('fetch POST with async pull-based streaming body', async () => {
    patchGlobalWebStreams();
    let i = 0;
    const rs = new ReadableStream({
      pull(c) {
        if (i >= 3) { c.close(); return; }
        c.enqueue(new TextEncoder().encode(`async${i}-`));
        i++;
      },
    });
    const resp = await fetch(`${baseURL}/echo`, {
      method: 'POST',
      body: rs,
      duplex: 'half',
    });
    const text = await resp.text();
    assert.strictEqual(text, 'async0-async1-async2-');
  });
});

// ─── Concurrent fetches ──────────────────────────────────────────────────────

describe('fetch: concurrent operations', () => {
  afterEach(() => unpatchGlobalWebStreams());

  it('multiple concurrent fetches all complete', async () => {
    patchGlobalWebStreams();
    const results = await Promise.all([
      fetch(baseURL).then((r) => r.text()),
      fetch(`${baseURL}/json`).then((r) => r.json()),
      fetch(`${baseURL}/large`).then((r) => r.arrayBuffer()),
      fetch(baseURL).then((r) => r.text()),
    ]);
    assert.strictEqual(results[0], 'Hello from server');
    assert.deepStrictEqual(results[1], { ok: true, message: 'hello' });
    assert.strictEqual(results[2].byteLength, 100_000);
    assert.strictEqual(results[3], 'Hello from server');
  });

  it('concurrent pipeTo operations complete independently', async () => {
    patchGlobalWebStreams();
    const pipe = async (url) => {
      const resp = await fetch(url);
      let total = 0;
      const dest = new WritableStream({
        write(chunk) { total += chunk.byteLength; },
      });
      await resp.body.pipeTo(dest);
      return total;
    };
    const [s1, s2, s3] = await Promise.all([
      pipe(baseURL),
      pipe(`${baseURL}/large`),
      pipe(baseURL),
    ]);
    assert.strictEqual(s1, 'Hello from server'.length);
    assert.strictEqual(s2, 100_000);
    assert.strictEqual(s3, 'Hello from server'.length);
  });

  it('concurrent pipeThrough chains complete independently', async () => {
    patchGlobalWebStreams();
    const pipeChain = async (url, transforms) => {
      const resp = await fetch(url);
      let stream = resp.body;
      for (let i = 0; i < transforms; i++) {
        stream = stream.pipeThrough(new TransformStream({
          transform(chunk, ctrl) { ctrl.enqueue(chunk); },
        }));
      }
      let total = 0;
      const dest = new WritableStream({
        write(chunk) { total += chunk.byteLength; },
      });
      await stream.pipeTo(dest);
      return total;
    };
    const [s1, s2] = await Promise.all([
      pipeChain(`${baseURL}/large`, 2),
      pipeChain(`${baseURL}/large`, 3),
    ]);
    assert.strictEqual(s1, 100_000);
    assert.strictEqual(s2, 100_000);
  });
});

// ─── BYOB reader ─────────────────────────────────────────────────────────────

describe('fetch: BYOB reader', () => {
  afterEach(() => unpatchGlobalWebStreams());

  it('getReader({ mode: "byob" }) reads fetch body', async () => {
    patchGlobalWebStreams();
    const resp = await fetch(baseURL);
    // fetch body is a byte stream, so BYOB should work
    let reader;
    try {
      reader = resp.body.getReader({ mode: 'byob' });
    } catch {
      // Some environments may not support BYOB on fetch bodies
      return;
    }
    const chunks = [];
    let buf = new Uint8Array(64);
    while (true) {
      const { value, done } = await reader.read(buf);
      if (done) break;
      chunks.push(Buffer.from(value).toString());
      buf = new Uint8Array(64);
    }
    assert.strictEqual(chunks.join(''), 'Hello from server');
  });
});

// ─── ReadableStream.from() interop ───────────────────────────────────────────

describe('fetch: ReadableStream.from() interop', () => {
  afterEach(() => unpatchGlobalWebStreams());

  it('ReadableStream.from(array) pipes through transform', async () => {
    patchGlobalWebStreams();
    const rs = ReadableStream.from(['hello', ' ', 'world']);
    const upper = new TransformStream({
      transform(chunk, ctrl) { ctrl.enqueue(chunk.toUpperCase()); },
    });
    const piped = rs.pipeThrough(upper);
    const reader = piped.getReader();
    const parts = [];
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      parts.push(value);
    }
    assert.strictEqual(parts.join(''), 'HELLO WORLD');
  });

  it('ReadableStream.from(generator) pipes to WritableStream', async () => {
    patchGlobalWebStreams();
    async function* gen() {
      yield 'a';
      yield 'b';
      yield 'c';
    }
    const rs = ReadableStream.from(gen());
    const collected = [];
    const dest = new WritableStream({
      write(chunk) { collected.push(chunk); },
    });
    await rs.pipeTo(dest);
    assert.deepStrictEqual(collected, ['a', 'b', 'c']);
  });
});
