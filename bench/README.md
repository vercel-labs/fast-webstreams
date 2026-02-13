# Benchmark Suite

Compares Node.js streams, native WebStreams, and fast-webstreams across real-world patterns.

## Usage

```bash
# Full suite (~12 min)
npm run bench

# Quick directional check (~4 min)
npm run bench:quick

# Single scenario
npm run bench -- --scenario=passthrough

# Single chunk size
npm run bench -- --chunk-size=16384

# Custom parameters
node --expose-gc bench/run.js --iterations=5 --warmup=2 --hwm=32768
```

## CLI Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--scenario=NAME` | all | Run only this scenario |
| `--chunk-size=BYTES` | all | Run only this chunk size |
| `--iterations=N` | 10 | Measurement iterations |
| `--warmup=N` | 3 | Warmup iterations (discarded) |
| `--hwm=BYTES` | 16384 | highWaterMark for queuing strategies |
| `--total-bytes=BYTES` | 100MB | Total data per iteration |
| `--json-only` | off | Skip console output, write JSON only |
| `--no-markdown` | off | Skip markdown report |

## npm Scripts

| Script | Description |
|--------|-------------|
| `bench` | Full suite with default parameters |
| `bench:quick` | 3 iterations, 1 warmup — fast directional checks |
| `bench:passthrough` | Passthrough scenario only |

## Scenarios

| Scenario | Variants | Description |
|----------|----------|-------------|
| `passthrough` | 15 | Pure overhead: pipe, pipeline, pipeTo, read/write loops (default + byte) |
| `transform-cpu` | 3 | CPU-bound transform (uppercase) measuring transform callback cost |
| `compression` | 3 | CompressionStream/DecompressionStream round-trip |
| `chunk-accumulation` | 3 | Small chunks accumulated into larger buffers |
| `backpressure` | 3 | 1ms async delay in sink measuring backpressure propagation |
| `fetch-bridge` | 7 | Fetch body (byte stream) through 3 transforms — bridge vs pipeline |
| `byte-stream` | 4 | React Flight pattern: start(c)+enqueue all, then drain via reader/Response |
| `multi-transform` | 6 | Transform chain depth: 3x and 8x identity transforms |
| `response-body` | 4 | `new Response(stream).text()` and forwarding through transforms |

## Default Parameters

- **Chunk sizes**: 1KB, 16KB, 64KB, 1MB — covers per-chunk overhead through throughput-limited
- **Iterations**: 10 (gives reliable Welch's t-tests at p<0.05 with streaming's low variance)
- **Warmup**: 3 (sufficient for V8 TurboFan compilation; was 5, no measurable difference at 3)
- **totalBytes**: 100MB default; reduced for memory-heavy (byte-stream: 50MB), slow (backpressure/compression: 10MB), or GC-sensitive (response-body: 20MB) scenarios

Per-scenario chunk filters skip combinations that don't add signal (e.g., 64B byte streams, 1MB response text).

## Interpreting Results

- **Throughput (MB/s)**: Higher is better. Median of N iterations.
- **stddev**: Low (<5%) means the measurement is stable.
- **Significance**: Compare web vs fast variants at same chunk size. >10% difference is meaningful; <5% is noise.

## Tips

- Use `bench:quick` for directional checks during development
- Use full `bench` for PR validation
- `--expose-gc` enables GC tracking; benchmarks work without it but warn
- Results are written to `bench/results/` as JSON and markdown
