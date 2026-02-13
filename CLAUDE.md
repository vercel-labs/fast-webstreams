# fast-webstreams

WHATWG ReadableStream/WritableStream/TransformStream backed by Node.js streams for zero-promise piping.

## Testing

### All tests (run before committing)

```bash
npm test
```

This runs `node --test test/*.test.js` (custom tests) then `node test/run-wpt.js --mode=fast` (WPT spec compliance).

### WPT (Web Platform Tests) — spec compliance

```bash
npm run test:wpt                  # Fast mode
npm run test:wpt:native           # Native baseline

# Filter to a specific test area
node test/run-wpt.js --mode=fast --filter=piping
node test/run-wpt.js --mode=fast --filter=readable-byte-streams
node test/run-wpt.js --mode=fast --filter=transform-streams

# Single file (pass mode as positional arg, NOT --mode=)
node test/run-wpt-file.js fast vendor/wpt/streams/piping/close-propagation-forward.any.js
node test/run-wpt-file.js native vendor/wpt/streams/piping/close-propagation-forward.any.js
```

Baseline: **1100/1116 fast, 1099/1116 native**. Any change must maintain 1100 fast.

### Custom tests only

```bash
npm run test:unit
```

## Benchmarking

Always use `--expose-gc` for accurate memory/GC tracking.

### Quick iteration (single scenario + chunk size)

```bash
# Response body (bridge, byte stream pipeline) — most actively optimized
node --expose-gc bench/run.js --scenario=response-body --chunk-size=1024 --iterations=7 --warmup=3 --no-markdown

# Passthrough (pipeTo vs pipeThrough, read/write loops)
node --expose-gc bench/run.js --scenario=passthrough --chunk-size=1024 --iterations=7 --warmup=3 --no-markdown
```

### Key scenarios

| Scenario | What it measures | Key variants to watch |
|----------|-----------------|----------------------|
| `passthrough` | Pure streaming overhead | `fast-pipeTo`, `fast-pipeThrough`, `fast-read-loop` |
| `response-body` | Response.text(), forwarding, fetch bridge | `fast-response-forward`, `fast-bridge-transform`, `fast-fetch-transform` |
| `byte-stream` | Byte stream read loops | `fast-byte-read-loop` |
| `transform-cpu` | Transform with CPU work | `fast-transform-cpu` |
| `multi-transform` | Chained transforms | `fast-multi-*` |
| `backpressure` | Slow consumer pressure | `fast-backpressure` |
| `fetch-bridge` | Native-to-Fast bridge | `fast-fetch-bridge` |

### All scenarios (full suite, takes a few minutes)

```bash
npm run bench
# or quick: npm run bench:quick
```

### Comparing before/after

Results are saved to `bench/results/` as JSON. To compare, run the benchmark before and after your change at the same chunk size, and compare the `fast-*` variant throughput relative to the `web-*` baseline (not absolute numbers, which vary with system load).

### Current performance targets (1KB chunks)

| Variant | Throughput | vs Native |
|---------|-----------|-----------|
| `fast-pipeThrough` | ~5000-6700 MB/s | ~10x faster |
| `fast-read-loop` | ~8000-11000 MB/s | ~3x faster |
| `fast-pipeTo` | ~1700-2400 MB/s | ~2x faster |
| `fast-response-forward` | ~1100-1250 MB/s | ~3x faster |
| `fast-bridge-forward` | ~700 MB/s | ~1.8x faster |
| `fast-write-loop` | ~3800-5300 MB/s | ~2.5x faster |

## Architecture

Three-tier routing (source: `src/readable.js`):

- **Tier 0**: `pipeThrough` + `pipeTo` between Fast streams → Node.js `pipeline()`, zero promises per chunk
- **Tier 1**: `getReader().read()` → sync read from Node buffer via `Promise.resolve()`
- **Tier 2**: `tee()`, native interop, mixed streams → `specPipeTo` or `Readable.toWeb()`/`Writable.toWeb()`

### Key constraints

- `pipeline()` cannot be used for standalone `pipeTo` — breaks WHATWG error/close/cancel propagation semantics (72 WPT failures)
- Byte streams use `LiteReadable` (lightweight buffer) for construction speed; wrapped in Node Readable at pipeline time via `_wrapLiteForPipeline()`
- `Reflect.apply` is required for user callbacks — WPT monkey-patches `Function.prototype.call`
- `Promise.resolve(obj)` always triggers thenable check — cannot be avoided at JS level
