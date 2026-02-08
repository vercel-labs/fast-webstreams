# fast-webstreams

WHATWG WebStreams API (`ReadableStream`, `WritableStream`, `TransformStream`) backed by Node.js native streams for dramatically better performance.

Node.js ships a pure-JavaScript implementation of the WHATWG Streams spec. Every `reader.read()` allocates promises, every `pipeTo()` builds a chain of microtasks, and every chunk traverses a full JavaScript-level queue. `fast-webstreams` replaces this machinery with Node.js native streams (`Readable`, `Writable`, `Transform`) under the hood, while exposing the same WHATWG API surface.

## Benchmarks

Throughput at 1KB chunks, 100MB total (Node.js v22, Apple Silicon). This measures pure streaming infrastructure cost -- no transformation, no I/O, no CPU work -- so the differences are entirely due to how each implementation moves chunks through its internal machinery.

| | Node.js streams | fast-webstreams | Native WebStreams |
|---|---|---|---|
| **read loop** | 26,391 MB/s | **14,577 MB/s** | 3,289 MB/s |
| **write loop** | 26,713 MB/s | **5,608 MB/s** | 2,391 MB/s |
| **transform (pipeThrough)** | 8,387 MB/s | **7,093 MB/s** | 618 MB/s |
| **pipeTo** | 15,175 MB/s | **2,664 MB/s** | 1,398 MB/s |

- **read loop is 4.4x faster than native WebStreams** -- synchronous reads from the Node.js buffer return `Promise.resolve()` with no event loop round-trip
- **write loop is 2.3x faster than native WebStreams** -- direct sink calls bypass Node.js Writable, replacing the `process.nextTick()` deferral with a single microtask
- **transform is 11x faster than native WebStreams** -- the Tier 0 pipeline path uses Node.js `pipeline()` internally with zero Promise allocations, reaching 85% of raw Node.js transform pipeline throughput
- **pipeTo is 1.9x faster than native WebStreams** -- benefits from both the fast read path and the direct sink write path

When your transform does real work (CPU, I/O), the streaming overhead becomes negligible and all implementations converge. These benchmarks intentionally measure the worst case: tiny chunks, no-op transforms, pure overhead.

## Installation

```js
import {
  FastReadableStream,
  FastWritableStream,
  FastTransformStream,
} from 'fast-webstreams';
```

These are drop-in replacements for the global `ReadableStream`, `WritableStream`, and `TransformStream`.

## Quick Example

```js
import {
  FastReadableStream,
  FastWritableStream,
  FastTransformStream,
} from 'fast-webstreams';

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

The result: `reader.read()` loops run approximately 3x faster than native WebStreams, and `pipeThrough` chains operate within 10% of raw Node.js stream performance at 1KB+ chunk sizes.

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

- **Byte streams** (`type: 'bytes'`) -- delegated to native `ReadableStream`
- **Custom queuing strategies** (`ByteLengthQueuingStrategy` with `size()`) -- delegated to native
- **`tee()`** -- implemented in pure JS using readers and controllers for correct cancel semantics
- **Mixed piping** (Fast stream to native WebStream or vice versa) -- uses `specPipeTo` for full WHATWG compliance

```js
// These automatically use Tier 2:
new FastReadableStream({ type: 'bytes', ... });             // byte stream -> native
new FastReadableStream(source, { size: (chunk) => ... });   // custom size -> native
stream.tee();                                                // pure JS tee implementation
```

## Fast Path vs Compat Mode

Not every usage of `fast-webstreams` takes the fast path. Certain API patterns trigger **compat mode**, which delegates to Node.js native WebStreams internally. Compat mode still provides full WHATWG spec compliance, but without the performance benefits of the Node.js stream backing.

The rule of thumb: if you stick to `FastReadableStream`, `FastWritableStream`, and `FastTransformStream` with default queuing strategies, you get the fast path. Custom `size()` functions, byte streams, and `tee()` trigger compat mode.

### Fast Path Examples

These patterns use the fast internal implementation (Node.js `Readable`, `Writable`, `Transform` under the hood):

**1. Pull-based ReadableStream with reader.read() loop (Tier 1 -- sync fast path)**

```js
import { FastReadableStream } from 'fast-webstreams';

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

`reader.read()` performs a synchronous `nodeReadable.read()` from the Node.js internal buffer. When data is already buffered, it returns `Promise.resolve({ value, done })` with no event loop round-trip. This path is approximately 3x faster than native `ReadableStream`.

**2. pipeThrough with FastTransformStream (Tier 0 -- Node.js pipeline)**

```js
import {
  FastReadableStream,
  FastWritableStream,
  FastTransformStream,
} from 'fast-webstreams';

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

When all streams in a `pipeThrough` / `pipeTo` chain are Fast streams with default options, `fast-webstreams` builds a single `pipeline()` call across the entire chain. Data flows through Node.js C++ internals with zero Promise allocations. This is approximately 11x faster than native `pipeThrough` at 1KB chunk sizes.

**3. WritableStream with simple write sink (Tier 1 -- direct dispatch)**

```js
import { FastWritableStream } from 'fast-webstreams';

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

### Compat Mode Examples

These patterns fall back to native WebStreams. They are fully WHATWG-compliant but do not benefit from the Node.js stream fast path.

**1. ReadableStream with custom size() in QueuingStrategy**

```js
import { FastReadableStream } from 'fast-webstreams';

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
import { FastTransformStream } from 'fast-webstreams';

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
import { FastReadableStream } from 'fast-webstreams';

const stream = new FastReadableStream({
  start(controller) {
    controller.enqueue('data');
    controller.close();
  },
});

const [branch1, branch2] = stream.tee(); // <-- compat mode (pure JS tee)
```

`tee()` is implemented in pure JavaScript using readers and controllers to maintain correct cancel semantics. It acquires a reader lock on the source and creates two new `FastReadableStream` instances that replay chunks to both branches. This is not backed by Node.js `pipeline()` and does not benefit from the Tier 0 or Tier 1 fast paths.

**4. Byte streams (type: 'bytes')**

```js
import { FastReadableStream } from 'fast-webstreams';

// Byte stream type delegates entirely to native ReadableStream
const stream = new FastReadableStream({
  type: 'bytes', // <-- compat mode
  pull(controller) {
    controller.enqueue(new Uint8Array([1, 2, 3]));
  },
});
```

Byte streams (`type: 'bytes'`) require BYOB reader support and typed array view management that maps directly to the native implementation. The stream is fully delegated to the built-in `ReadableStream`.

### How to Tell Which Mode You Are In

If you want to check programmatically whether a stream took the fast path or was delegated to native:

```js
import { FastReadableStream } from 'fast-webstreams';

const stream = new FastReadableStream(source, strategy);

// Internal check (not part of the public API):
// stream[Symbol.for('kNativeOnly')] is not exposed, but the behavior
// is deterministic based on constructor arguments:
//
// Fast path:  no size(), no type: 'bytes'
// Compat mode: size() present, or type: 'bytes'
```

In practice, you do not need to check at runtime. The routing is fully deterministic based on the arguments passed to the constructor. If you avoid custom `size()` functions and byte stream types, you are on the fast path.

## Key Design Decisions

### objectMode: true

All internal Node.js streams use `objectMode: true`. WHATWG streams accept any JavaScript value (not just Buffers), so object mode is required for spec compliance.

### Default HWM of 1

The WHATWG spec defaults to `CountQueuingStrategy` with `highWaterMark: 1` (one item), not Node.js's default of `16384` bytes. `fast-webstreams` respects this, configuring Node.js streams with `highWaterMark: 1` unless the user provides a different strategy.

### Shell Objects for Transform

`FastTransformStream.readable` and `FastTransformStream.writable` return lightweight shell objects created via `Object.create(FastReadableStream.prototype)` rather than full constructor calls. Both shells share the same underlying `Node Transform` (which extends `Duplex`). This avoids double-buffering and constructor overhead while maintaining proper prototype chains for `instanceof` checks.

### Reader Event Listeners

The reader registers `end`, `error`, and `close` lifecycle listeners at construction time for `closedPromise` settlement (self-cleaning on first fire). Per-read dispatch uses `once()` listeners for `readable`, `end`, `error`, and `close` events, cleaned up when the read resolves or via `_errorReadRequests` on stream error.

### Reflect.apply for User Callbacks

All user-provided callbacks (`pull`, `write`, `transform`, `flush`, `cancel`, `abort`) are invoked via `Reflect.apply(fn, thisArg, args)` rather than `fn.call(thisArg, ...args)`. This is required because WPT tests monkey-patch `Function.prototype.call` to verify that implementations do not use `.call()`.

### Spec-Compliant pipeTo

The `specPipeTo` implementation follows the WHATWG `ReadableStreamPipeTo` algorithm directly: it acquires a reader and writer, pumps chunks in a loop, and handles error propagation, cancellation, and abort signal semantics. The Tier 0 pipeline fast path is only used for `pipeThrough` chains (where upstream links are set), never for standalone `pipeTo`, because Node.js `pipeline()` does not match WHATWG error propagation semantics.

## WPT Compliance

`fast-webstreams` is tested against the Web Platform Tests (WPT) streams test suite:

| Implementation | Pass Rate | Tests |
|---|---|---|
| Native (Node.js) | 98.2% | 1096/1116 |
| fast-webstreams | 97.6% | 1089/1116 |

The 27 remaining failures (9 fast-only) are in edge cases:

- **2 tests**: `then`-interception -- `Promise.resolve(obj)` always triggers a thenable check on `obj`, which is unfixable in pure JavaScript.
- **3 tests**: Cancel timing -- microtask ordering differences between the spec's pure-Promise model and Node.js event-driven completion.
- **2 tests**: Piping timing -- subtle microtask ordering in error propagation paths.
- **1 test**: `tee()` edge case.
- **1 test**: Flow control timing.

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
- `type: 'bytes'` -- delegates to native ReadableStream (Tier 2)

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
  byob-reader.js      FastReadableStreamBYOBReader (native delegation)
  writer.js           FastWritableStreamDefaultWriter
  controller.js       WHATWG controller adapters (Readable, Writable, Transform)
  pipe-to.js          Spec-compliant pipeTo implementation
  materialize.js      Tier 2: Readable.toWeb() / Writable.toWeb() delegation
  utils.js            Symbols, type checks, shared constants

test/
  run-wpt.js          WPT test runner (subprocess-based, concurrency=4)
  run-wpt-file.js     Single-file WPT runner
  wpt-harness.js      testharness.js polyfill for VM context

bench/
  run.js              Benchmark entry point
  scenarios/          passthrough, transform-cpu, compression, backpressure, chunk-accumulation
  results/            Timestamped JSON + Markdown reports

vendor/wpt/streams/   Web Platform Test files
```

## License

ISC
