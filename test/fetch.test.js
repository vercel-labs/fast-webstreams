/**
 * Integration tests for fetch() with patched global WebStreams.
 *
 * Verifies that Node.js built-in fetch works correctly when
 * ReadableStream/WritableStream/TransformStream are replaced
 * with fast alternatives. Covers:
 * - Reading fetch response body via .text(), .json(), .arrayBuffer()
 * - Reading fetch body via getReader()
 * - Piping fetch body through TransformStreams
 * - Piping fetch body to WritableStream (with and without signal)
 * - Constructing Response from FastReadableStream
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

describe('fetch integration', () => {
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

  it('resp.body.pipeThrough(TransformStream) works', async () => {
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

  it('resp.body.pipeTo(WritableStream) works', async () => {
    patchGlobalWebStreams();
    const resp = await fetch(baseURL);
    const chunks = [];
    const dest = new WritableStream({
      write(chunk) { chunks.push(Buffer.from(chunk).toString()); },
    });
    await resp.body.pipeTo(dest);
    assert.strictEqual(chunks.join(''), 'Hello from server');
  });

  it('resp.body.pipeTo(WritableStream, { signal }) works', async () => {
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

  it('resp.body through multiple transforms + pipeTo with signal', async () => {
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

  it('fetch with FastReadableStream POST body', async () => {
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

  it('fetch body → pipeThrough chain bridges to Fast (large data)', async () => {
    patchGlobalWebStreams();
    const resp = await fetch(`${baseURL}/large`);
    // Pipe through 3 Fast transforms — bridge should prevent native cascade
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

  it('fetch body → pipeThrough bridge preserves cancel', async () => {
    patchGlobalWebStreams();
    const resp = await fetch(`${baseURL}/large`);
    const piped = resp.body.pipeThrough(new TransformStream({
      transform(chunk, ctrl) { ctrl.enqueue(chunk); },
    }));
    const reader = piped.getReader();
    // Read one chunk then cancel
    const { done } = await reader.read();
    assert.strictEqual(done, false);
    await reader.cancel('test cancel');
    // Should not throw — cancel propagates through bridge to native
  });
});
