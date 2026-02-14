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

Results are saved to `bench-results/` as readable JSON. Filenames are `$ISO-datetime-$scenario.json` (e.g. `2026-02-14T03:22:23.240Z-passthrough.json` or `2026-02-14T04:01:22.406Z-all.json`).

**Always use `--description` to document what is being tested.** This is stored in the JSON and makes it possible to understand results later.

To compare before/after a change:

```bash
# 1. Run benchmark BEFORE your change
node --expose-gc bench/run.js --scenario=passthrough --chunk-size=1024 --iterations=7 --warmup=3 --no-markdown \
  --description="baseline before optimizing byte tee"

# 2. Make your change

# 3. Run benchmark AFTER your change (same flags)
node --expose-gc bench/run.js --scenario=passthrough --chunk-size=1024 --iterations=7 --warmup=3 --no-markdown \
  --description="after byte tee JS readLoop optimization"

# 4. Compare the two most recent JSON files in bench-results/
#    Look at throughputMBs for fast-* variants relative to web-* baselines.
#    Absolute numbers vary with system load — compare ratios, not absolutes.
```

Each JSON file contains `timestamp`, `description`, `git` (`sha`, `dirty`), `nodeVersion`, `platform`, and a `results` array. Each result has `scenario`, `chunkSize`, and `variants` with `name`, `throughputMBs`, `timeMs`, `stddev`, `p95`, `gcCount`, `gcPauseMs`, `heapDeltaMB`.

### Performance invariant

**No regressions vs native**: every `fast-*` variant must be ≥1.0x throughput vs its `web-*` counterpart. If a benchmark shows fast < web, either fix the regression or fall back to native for that code path.

### Current performance targets (1KB chunks)

| Variant | Throughput | vs Native |
|---------|-----------|-----------|
| `fast-pipeThrough` | ~7,000 MB/s | ~11x faster |
| `fast-read-loop` | ~12,000 MB/s | ~3.8x faster |
| `fast-pipeTo` | ~2,500 MB/s | ~1.9x faster |
| `fast-write-loop` | ~5,400 MB/s | ~2.3x faster |
| `fast-for-await` | ~3,900 MB/s | ~1.4x faster |
| `fast-response-forward` | ~700-1,200 MB/s | ~1.8x faster |
| `fast-byte-tee-enqueue` | ~1,200 MB/s | ~1.6x faster |
| `fast-start-enqueue` | ~1,600 MB/s | ~14.7x faster |
| `fast-tee-read` | ~1,400 MB/s | ~1.1x faster |
| `fast-byte-read-loop` | ~1,400 MB/s | ~1.0x (matches native) |
| `fast-byte-for-await` | ~1,300 MB/s | ~1.0x (matches native) |

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
