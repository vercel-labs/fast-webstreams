# experimental-fast-webstreams

WHATWG WebStreams API (`ReadableStream`, `WritableStream`, `TransformStream`) backed by Node.js native streams for dramatically better performance.

Node.js ships a pure-JavaScript implementation of the WHATWG Streams spec. Every `reader.read()` allocates promises, every `pipeTo()` builds a chain of microtasks, and every chunk traverses a full JavaScript-level queue. `fast-webstreams` replaces this machinery with Node.js native streams (`Readable`, `Writable`, `Transform`) under the hood, while exposing the same WHATWG API surface.

## Benchmarks

Throughput at 1KB chunks, 100MB total (Node.js v22, Apple Silicon). This measures pure streaming infrastructure cost -- no transformation, no I/O, no CPU work -- so the differences are entirely due to how each implementation moves chunks through its internal machinery.

| | Node.js streams | fast-webstreams | Native WebStreams |
|---|---|---|---|
| **read loop** | 18,913 MB/s | **9,874 MB/s** | 2,450 MB/s |
| **write loop** | 18,142 MB/s | **4,245 MB/s** | 1,827 MB/s |
| **transform (pipeThrough)** | 6,108 MB/s | **4,620 MB/s** | 461 MB/s |
| **pipeTo** | 11,149 MB/s | **1,959 MB/s** | 1,007 MB/s |
| **fetch bridge** | -- | **666 MB/s** | 201 MB/s |

- **read loop is 4.0x faster than native WebStreams** -- synchronous reads from the Node.js buffer return `Promise.resolve()` with no event loop round-trip
- **write loop is 2.3x faster than native WebStreams** -- direct sink calls bypass Node.js Writable, replacing the `process.nextTick()` deferral with a single microtask
- **transform is 10.0x faster than native WebStreams** -- the Tier 0 pipeline path uses Node.js `pipeline()` internally with zero Promise allocations, reaching 76% of raw Node.js transform pipeline throughput
- **pipeTo is 1.9x faster than native WebStreams** -- write batching calls the sink directly during the sync read loop, reducing N promises to 1 per batch
- **fetch bridge is 3.3x faster than native WebStreams** -- native byte stream sources (from `fetch()`) are bridged to Fast with batched reads, enabling Node.js pipeline for downstream transforms

When your transform does real work (CPU, I/O), the streaming overhead becomes negligible and all implementations converge. These benchmarks intentionally measure the worst case: tiny chunks, no-op transforms, pure overhead.

## Installation

```bash
npm install experimental-fast-webstreams
```

```js
import {
  FastReadableStream,
  FastWritableStream,
  FastTransformStream,
} from 'experimental-fast-webstreams';
```

These are drop-in replacements for the global `ReadableStream`, `WritableStream`, and `TransformStream`.

### Global Patch

To replace the built-in stream constructors globally:

```js
import { patchGlobalWebStreams, unpatchGlobalWebStreams } from 'experimental-fast-webstreams';

patchGlobalWebStreams();
// globalThis.ReadableStream now produces FastReadableStream instances
// globalThis.WritableStream is now FastWritableStream
// globalThis.TransformStream is now FastTransformStream

unpatchGlobalWebStreams();
// restores the original native constructors
```

Native constructor references are captured at import time, so internal code and `unpatch()` always work correctly.

The global patch is compatible with Node.js `fetch()` -- response bodies from `fetch()` are automatically bridged to use the fast path for downstream `pipeThrough` and `pipeTo` operations.

### TypeScript

Type declarations are included. The exports re-export the standard WHATWG stream types, so existing TypeScript code works without changes.

## Quick Example

```js
import {
  FastReadableStream,
  FastWritableStream,
  FastTransformStream,
} from 'experimental-fast-webstreams';

const readable = new FastReadableStream({
  start(controller) {
    controller.enqueue('hello');
    controller.enqueue('world');
    controller.close();
  },
});

const transform = new FastTransformStream({
  transform(chunk, controller) {
    controller.enqueue(chunk.toUpperCase());
  },
});

const writable = new FastWritableStream({
  write(chunk) {
    console.log(chunk); // "HELLO", "WORLD"
  },
});

await readable.pipeThrough(transform).pipeTo(writable);
```

## Why fast-webstreams Exists

Node.js WebStreams are slow. The built-in implementation is written in pure JavaScript with heavy Promise machinery: every chunk that flows through a `ReadableStream` allocates promises, traverses microtask queues, and bounces through multiple layers of JavaScript-level buffering. For high-throughput scenarios -- HTTP response bodies, file I/O, data pipelines -- this overhead dominates.

`fast-webstreams` solves this by using Node.js native streams (`Readable`, `Writable`, `Transform`) as the actual data transport. These are implemented in C++ within Node.js and have been optimized over a decade. The WHATWG API is a thin adapter layer on top.

The result: `reader.read()` loops run approximately 4x faster than native WebStreams, and `pipeThrough` chains operate within 25% of raw Node.js stream performance at 1KB+ chunk sizes.

## Architecture: Three Tiers

`fast-webstreams` uses a tiered architecture that selects the fastest path for each operation:

### Tier 0: Pipeline (zero promises)

When you `pipeThrough` and `pipeTo` exclusively between Fast streams with default options, the library builds a single `pipeline()` call across the entire chain. Data flows through Node.js C++ internals with zero Promise allocations.

```
FastReadableStream -> FastTransformStream -> FastWritableStream
        |                    |                      |
    Node Readable -----> Node Transform ------> Node Writable
                    (single pipeline() call)
```

The `pipeThrough` call links streams via an internal `kUpstream` reference. When `pipeTo` is finally called, `collectPipelineChain()` walks the upstream links and passes all Node.js streams to a single `pipeline()` invocation.

### Tier 1: Sync Fast Path (reader/writer)

When you call `reader.read()`, the reader does a synchronous `nodeReadable.read()` from the Node.js buffer. If data is already buffered, it returns `Promise.resolve({ value, done: false })` -- no event loop round-trip, no microtask queue.

```js
const reader = stream.getReader();
const { value, done } = await reader.read(); // sync read from Node buffer
```

Similarly, `writer.write()` dispatches directly to `nodeWritable.write()` with a fast path that skips the internal queue when the stream is started and idle.

### Tier 2: Native Interop (full compatibility)

Operations that need full spec compliance or interact with native WebStreams fall back to `Readable.toWeb()` / `Writable.toWeb()` delegation. This tier handles:

- **Custom queuing strategies** (`ByteLengthQueuingStrategy` with `size()`) -- delegated to native
- **`tee()`** -- implemented in pure JS using readers and controllers for correct cancel semantics
- **Mixed piping** (Fast stream to native WebStream or vice versa) -- uses `specPipeTo` for full WHATWG compliance

### Byte Streams (`type: 'bytes'`)

Byte streams use a lightweight `LiteReadable` buffer (faster than Node.js `Readable` for construction and sync reads). Byte streams without a `pull` callback -- the React Flight / Server Components pattern of `start(c) { ctrl = c }` + external `enqueue` -- run entirely on the fast path.

Byte streams with `pull` callbacks (e.g. from `fetch()` response bodies via `patchGlobalWebStreams()`) use a standalone BYOB reader implementation with pull coordination via `LiteReadable`. When a native byte stream (from `fetch()` / undici) flows through `pipeThrough`, the library **bridges** it to a Fast stream by reading from the native reader and enqueuing into a Fast controller. The bridge uses **batched reads** -- within a single pull call, it chains multiple native `reader.read()` calls while HWM headroom exists, eliminating the pull coordinator roundtrip between consecutive chunks. This makes the bridge path 3.3x faster than native WebStreams, while downstream transforms use the zero-promise Node.js pipeline.

## Fast Path vs Compat Mode

Not every usage of `fast-webstreams` takes the fast path. Certain API patterns trigger **compat mode**, which delegates to Node.js native WebStreams internally. Compat mode still provides full WHATWG spec compliance, but without the performance benefits of the Node.js stream backing.

The rule of thumb: if you stick to `FastReadableStream`, `FastWritableStream`, and `FastTransformStream` with default queuing strategies, you get the fast path. Custom `size()` functions trigger compat mode. Byte streams use the fast path when possible.

### Fast Path Examples

These patterns use the fast internal implementation (Node.js `Readable`, `Writable`, `Transform` under the hood):

**1. Pull-based ReadableStream with reader.read() loop (Tier 1 -- sync fast path)**

```js
import { FastReadableStream } from 'experimental-fast-webstreams';

const stream = new FastReadableStream({
  start(controller) {
    controller.enqueue('a');
    controller.enqueue('b');
    controller.close();
  },
});

const reader = stream.getReader();
while (true) {
  const { value, done } = await reader.read(); // sync read from Node buffer
  if (done) break;
  process.stdout.write(value);
}
```

`reader.read()` performs a synchronous `nodeReadable.read()` from the Node.js internal buffer. When data is already buffered, it returns `Promise.resolve({ value, done })` with no event loop round-trip. This path is approximately 4x faster than native `ReadableStream`.

**2. pipeThrough with FastTransformStream (Tier 0 -- Node.js pipeline)**

```js
import {
  FastReadableStream,
  FastWritableStream,
  FastTransformStream,
} from 'experimental-fast-webstreams';

const source = new FastReadableStream({
  pull(controller) {
    controller.enqueue(generateChunk());
  },
});

const transform = new FastTransformStream({
  transform(chunk, controller) {
    controller.enqueue(processChunk(chunk));
  },
});

const sink = new FastWritableStream({
  write(chunk) {
    consume(chunk);
  },
});

await source.pipeThrough(transform).pipeTo(sink);
```

When all streams in a `pipeThrough` / `pipeTo` chain are Fast streams with default options, `fast-webstreams` builds a single `pipeline()` call across the entire chain. Data flows through Node.js C++ internals with zero Promise allocations. This is approximately 10x faster than native `pipeThrough` at 1KB chunk sizes.

**3. WritableStream with simple write sink (Tier 1 -- direct dispatch)**

```js
import { FastWritableStream } from 'experimental-fast-webstreams';

const writable = new FastWritableStream({
  write(chunk) {
    console.log('received:', chunk);
  },
});

const writer = writable.getWriter();
await writer.write('hello');
await writer.write('world');
await writer.close();
```

`writer.write()` dispatches directly to the underlying `nodeWritable.write()` with a fast path that skips the internal queue when the stream is started and idle.

**4. Byte streams with start + external enqueue (fast path)**

```js
import { FastReadableStream } from 'experimental-fast-webstreams';

// React Flight / Server Components pattern
let controller;
const stream = new FastReadableStream({
  type: 'bytes',
  start(c) { controller = c; },
});

// External code enqueues data
controller.enqueue(new Uint8Array([1, 2, 3]));
controller.close();
```

Byte streams that use `start` to capture the controller and enqueue externally run on the fast path using `LiteReadable`, a lightweight array-based buffer that is faster than Node.js `Readable` for construction and sync reads.

### Compat Mode Examples

These patterns fall back to native WebStreams. They are fully WHATWG-compliant but do not benefit from the Node.js stream fast path.

**1. ReadableStream with custom size() in QueuingStrategy**

```js
import { FastReadableStream } from 'experimental-fast-webstreams';

// Custom size() function triggers delegation to native ReadableStream
const stream = new FastReadableStream(
  {
    pull(controller) {
      controller.enqueue(new Uint8Array(1024));
    },
  },
  {
    highWaterMark: 65536,
    size(chunk) {
      return chunk.byteLength; // <-- custom size triggers compat mode
    },
  },
);
```

Any strategy with a `size()` function causes the constructor to create a native `ReadableStream` internally and wrap it in a Fast shell. This is because Node.js streams use a count-based or byte-based HWM, not an arbitrary sizing function.

**2. TransformStream with custom readableStrategy.size**

```js
import { FastTransformStream } from 'experimental-fast-webstreams';

// Custom size on either strategy triggers delegation to native TransformStream
const transform = new FastTransformStream(
  {
    transform(chunk, controller) {
      controller.enqueue(chunk);
    },
  },
  undefined, // writableStrategy (default)
  {
    highWaterMark: 65536,
    size(chunk) {
      return chunk.byteLength; // <-- compat mode
    },
  },
);
```

If either `writableStrategy` or `readableStrategy` has a `size()` function, the entire `TransformStream` delegates to the native implementation. Both the `.readable` and `.writable` sides become native-backed shells.

**3. tee() on any stream**

```js
import { FastReadableStream } from 'experimental-fast-webstreams';

const stream = new FastReadableStream({
  start(controller) {
    controller.enqueue('data');
    controller.close();
  },
});

const [branch1, branch2] = stream.tee(); // pure JS tee
```

`tee()` is implemented in pure JavaScript using readers and controllers to maintain correct cancel semantics. It acquires a reader lock on the source and creates two new `FastReadableStream` instances that replay chunks to both branches.

## Key Design Decisions

### objectMode: true

All internal Node.js streams use `objectMode: true`. WHATWG streams accept any JavaScript value (not just Buffers), so object mode is required for spec compliance.

### Default HWM of 1

The WHATWG spec defaults to `CountQueuingStrategy` with `highWaterMark: 1` (one item), not Node.js's default of `16384` bytes. `fast-webstreams` respects this, configuring Node.js streams with `highWaterMark: 1` unless the user provides a different strategy. Byte streams default to `highWaterMark: 0` per spec.

### Shell Objects for Transform

`FastTransformStream.readable` and `FastTransformStream.writable` return lightweight shell objects created via `Object.create(FastReadableStream.prototype)` rather than full constructor calls. Both shells share the same underlying `Node Transform` (which extends `Duplex`). This avoids double-buffering and constructor overhead while maintaining proper prototype chains for `instanceof` checks.

### LiteReadable for Byte Streams

Byte streams use `LiteReadable`, a lightweight array-based buffer that replaces Node.js `Readable`. It provides the minimal interface needed for our reader fast path (push, read, destroy, event listeners) without the overhead of Node.js `Readable`'s full state machine. Construction is ~5μs faster.

### Reader Event Listeners

The reader registers `end`, `error`, and `close` lifecycle listeners at construction time for `closedPromise` settlement (self-cleaning on first fire). For LiteReadable-backed streams, per-read dispatch uses a direct callback queue (`_dataCallback`) instead of event listeners, avoiding 4 listener registrations per read.

### Reflect.apply for User Callbacks

All user-provided callbacks (`pull`, `write`, `transform`, `flush`, `cancel`, `abort`) are invoked via `Reflect.apply(fn, thisArg, args)` rather than `fn.call(thisArg, ...args)`. This is required because WPT tests monkey-patch `Function.prototype.call` to verify that implementations do not use `.call()`.

### Spec-Compliant pipeTo with Write Batching

The `specPipeTo` implementation follows the WHATWG `ReadableStreamPipeTo` algorithm directly: it acquires a reader and writer, pumps chunks in a loop, and handles error propagation, cancellation, and abort signal semantics. The Tier 0 pipeline fast path is only used for `pipeThrough` chains (where upstream links are set), never for standalone `pipeTo`, because Node.js `pipeline()` does not match WHATWG error propagation semantics.

When both source and destination are Fast streams, `specPipeTo` uses a **write batching** optimization: instead of calling `writer.write()` per chunk (which allocates a Promise, a writeRequest object, and a microtask deferral each), it calls the sink's `write()` function directly via `Reflect.apply` during the sync read loop. For sync sinks, this reduces N promises to 1 per batch (up to HWM chunks). The writable's `kInFlightWriteRequest` sentinel is set during the batch to maintain correct state machine invariants. Error identity is preserved -- thrown errors go through `controller.error()` with the original error object.

## WPT Compliance

`fast-webstreams` is tested against the Web Platform Tests (WPT) streams test suite:

| Implementation | Pass Rate | Tests |
|---|---|---|
| Native (Node.js v22) | 98.5% | 1099/1116 |
| fast-webstreams | 98.6% | 1100/1116 |

The 16 remaining failures break down as follows:

- **8 tests**: `tee()` -- 1 error identity mismatch (non-Error objects through Node.js `destroy()`), 7 tests that monkey-patch the global `ReadableStream` constructor and expect `tee()` to use it (architectural mismatch -- our tee creates branches directly)
- **5 tests**: `owning` type -- Node.js does not implement the `type: 'owning'` spec extension (native also fails all 5)
- **1 test**: async iterator prototype -- cross-realm `===` identity mismatch between host and VM context `AsyncIteratorPrototype` (native also fails)
- **1 test**: BYOB templated -- WPT template expects `{value: undefined}` after cancel, but BYOB spec returns `{value: Uint8Array(0)}` (native also fails)
- **1 test**: byte stream bad-buffers timeout -- test infrastructure limitation with `async_test` + `pull` callbacks (native also times out on 16/24 tests in same file)

### Running WPT Tests

```bash
# Native WebStreams (baseline)
node test/run-wpt.js --mode=native

# fast-webstreams
node test/run-wpt.js --mode=fast
```

## API Reference

### FastReadableStream

```js
new FastReadableStream(underlyingSource?, strategy?)
```

Drop-in replacement for `ReadableStream`. Supports:

- `underlyingSource.start(controller)` -- called on construction
- `underlyingSource.pull(controller)` -- called when internal buffer needs data
- `underlyingSource.cancel(reason)` -- called on cancellation
- `type: 'bytes'` -- uses LiteReadable fast path (start+enqueue pattern) or native bridge (pull pattern)

Methods: `getReader()`, `pipeThrough()`, `pipeTo()`, `tee()`, `cancel()`, `values()`, `[Symbol.asyncIterator]()`

Static: `FastReadableStream.from(asyncIterable)`

### FastWritableStream

```js
new FastWritableStream(underlyingSink?, strategy?)
```

Drop-in replacement for `WritableStream`. Supports:

- `underlyingSink.start(controller)` -- called on construction
- `underlyingSink.write(chunk, controller)` -- called for each chunk
- `underlyingSink.close()` -- called when stream closes
- `underlyingSink.abort(reason)` -- called on abort

Methods: `getWriter()`, `abort()`, `close()`

Full `writable -> erroring -> errored` state machine per spec.

### FastTransformStream

```js
new FastTransformStream(transformer?, writableStrategy?, readableStrategy?)
```

Drop-in replacement for `TransformStream`. Supports:

- `transformer.start(controller)` -- called on construction
- `transformer.transform(chunk, controller)` -- called for each chunk
- `transformer.flush(controller)` -- called when writable side closes
- `transformer.cancel(reason)` -- called when readable side is cancelled

Properties: `.readable` (FastReadableStream), `.writable` (FastWritableStream)

The readable and writable sides are lightweight shell objects that share a single underlying Node.js `Transform` stream.

### Readers and Writers

- `FastReadableStreamDefaultReader` -- returned by `getReader()`
- `FastReadableStreamBYOBReader` -- returned by `getReader({ mode: 'byob' })`
- `FastWritableStreamDefaultWriter` -- returned by `getWriter()`

These follow the standard WHATWG reader/writer APIs (`read()`, `write()`, `close()`, `cancel()`, `abort()`, `releaseLock()`, `closed`, `ready`, `desiredSize`).

## Project Structure

```
src/
  index.js            Public exports
  readable.js         FastReadableStream (3-tier routing, pipeline chain)
  writable.js         FastWritableStream (full state machine)
  transform.js        FastTransformStream (shell objects, backpressure)
  reader.js           FastReadableStreamDefaultReader (sync fast path)
  byob-reader.js      FastReadableStreamBYOBReader
  writer.js           FastWritableStreamDefaultWriter
  controller.js       WHATWG controller adapters (Readable, Writable, Transform)
  pipe-to.js          Spec-compliant pipeTo implementation
  materialize.js      Tier 2: Readable.toWeb() / Writable.toWeb() delegation
  natives.js          Captured native constructors (pre-polyfill)
  patch.js            Global patch/unpatch (with fetch compatibility)
  utils.js            Symbols, type checks, shared constants

types/
  index.d.ts          TypeScript declarations

test/
  run-wpt.js          WPT test runner (subprocess-based, concurrency=4)
  run-wpt-file.js     Single-file WPT runner
  wpt-harness.js      testharness.js polyfill for VM context
  *.test.js           Unit and integration tests

bench/
  run.js              Benchmark entry point
  scenarios/          passthrough, transform-cpu, compression, backpressure, chunk-accumulation, fetch-bridge
  results/            Timestamped JSON + Markdown reports

vendor/wpt/streams/   Web Platform Test files
```

## License

ISC
