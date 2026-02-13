export type BenchConfig = {
  scenario: string;
  chunks: number;
  size: number;
  iterations: number;
  warmup: number;
};

export type IterationResult = {
  elapsed: number;
  bytes: number;
  throughput: number;
};

export type BenchStats = {
  median: number;
  min: number;
  max: number;
  mean: number;
  p95: number;
};

export type BenchResult = {
  scenario: string;
  config: { chunks: number; size: number; iterations: number; warmup: number };
  stats: {
    elapsed: BenchStats;
    throughput: Omit<BenchStats, "p95">;
  };
  results: IterationResult[];
};

function sorted(arr: number[]): number[] {
  return [...arr].sort((a, b) => a - b);
}

function median(vals: number[]): number {
  const s = sorted(vals);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function mean(vals: number[]): number {
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function percentile(vals: number[], p: number): number {
  const s = sorted(vals);
  const idx = Math.ceil(s.length * p) - 1;
  return s[Math.max(0, idx)];
}

async function runIteration(
  config: BenchConfig,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  RS: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TS: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  WS: any
): Promise<IterationResult> {
  const data = new Uint8Array(config.size).fill(0x41);
  let bytes = 0;

  function makeSource() {
    let i = 0;
    return new RS({
      pull(controller: ReadableStreamDefaultController) {
        if (i >= config.chunks) {
          controller.close();
          return;
        }
        controller.enqueue(data);
        i++;
      },
    });
  }

  async function consumeReader(stream: ReadableStream<Uint8Array>) {
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) bytes += value.byteLength;
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function makeTransform() {
    // Explicit JS callback — without this, native gets a C++ optimized
    // identity transform while Fast goes through Node.js Transform machinery.
    return new TS({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      transform(chunk: any, controller: any) {
        controller.enqueue(chunk);
      },
    });
  }

  let start = performance.now();

  switch (config.scenario) {
    case "read-loop": {
      await consumeReader(makeSource());
      break;
    }
    case "pipe-through": {
      await consumeReader(makeSource().pipeThrough(makeTransform()));
      break;
    }
    case "multi-transform": {
      await consumeReader(
        makeSource()
          .pipeThrough(makeTransform())
          .pipeThrough(makeTransform())
          .pipeThrough(makeTransform())
      );
      break;
    }
    case "pipe-to": {
      const source = makeSource();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sink = new WS({ write(chunk: any) { bytes += chunk.byteLength; } });
      await source.pipeTo(sink);
      break;
    }
    case "byte-stream": {
      // React Flight pattern: save controller in start(), enqueue externally
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let ctrl: any;
      const stream = new RS({
        type: "bytes",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        start(controller: any) {
          ctrl = controller;
        },
      });
      // Enqueue all chunks, then close
      for (let j = 0; j < config.chunks; j++) {
        ctrl.enqueue(new Uint8Array(data));
      }
      ctrl.close();
      // Drain
      await consumeReader(stream);
      break;
    }
    case "nextjs-ssr": {
      // Real Next.js pattern: React Fizz byte stream (type:'bytes', pull,
      // HWM:0) → 8 transform chain → pipeTo writable sink.
      let n = 0;
      const source = new RS(
        {
          type: "bytes",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          pull(controller: any) {
            if (n >= config.chunks) {
              controller.close();
              return;
            }
            controller.enqueue(new Uint8Array(data));
            n++;
          },
        },
        { highWaterMark: 0 }
      );
      // Chain 8 transforms (Next.js: buffered, metadata, flight, head, etc.)
      let stream = source;
      for (let t = 0; t < 8; t++) {
        stream = stream.pipeThrough(makeTransform());
      }
      // Consume via pipeTo (simulates HTTP response writer)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sink = new WS({ write(chunk: any) { bytes += chunk.byteLength; } });
      await stream.pipeTo(sink);
      break;
    }
    // --- Fetch scenarios: real fetch() against /api/data endpoint ---

    // --- Fetch scenarios ---
    // Use Response + stream to test the same codepath as fetch().text()
    // without local-fetch shortcuts. The Response body goes through
    // the same WebStreams pipeline as a real fetch response.

    case "fetch-text": {
      // Pattern: await response.text()
      // Tests: ReadableStream → TextDecoder → string concatenation
      const body = makeSource();
      const response = new Response(body);
      const text = await response.text();
      bytes = text.length;
      break;
    }
    case "fetch-stream": {
      // Pattern: response.body.getReader() read loop
      const body = makeSource();
      const response = new Response(body);
      await consumeReader(response.body!);
      break;
    }
    case "fetch-transform": {
      // Pattern: response.body.pipeThrough(transform) → read
      const body = makeSource();
      const response = new Response(body);
      const ft = new TS({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        transform(chunk: any, controller: any) { controller.enqueue(chunk); },
      });
      await consumeReader(response.body!.pipeThrough(ft));
      break;
    }
    case "fetch-forward": {
      // Pattern: response.body → 3 transforms → pipeTo sink
      const body = makeSource();
      const response = new Response(body);
      let stream: ReadableStream = response.body!;
      for (let t = 0; t < 3; t++) {
        stream = stream.pipeThrough(new TS({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          transform(chunk: any, controller: any) { controller.enqueue(chunk); },
        }));
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sink = new WS({ write(chunk: any) { bytes += chunk.byteLength; } });
      await stream.pipeTo(sink);
      break;
    }
    default:
      await consumeReader(makeSource());
  }

  const elapsed = performance.now() - start;
  return { elapsed, bytes, throughput: bytes / (elapsed / 1000) };
}

export async function runBenchmark(
  config: BenchConfig,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  RS: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TS: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  WS: any
): Promise<BenchResult> {
  const results: IterationResult[] = [];
  const total = config.warmup + config.iterations;

  for (let i = 0; i < total; i++) {
    const r = await runIteration(config, RS, TS, WS);
    if (i >= config.warmup) {
      results.push(r);
    }
  }

  const elapsedVals = results.map((r) => r.elapsed);
  const throughputVals = results.map((r) => r.throughput);

  return {
    scenario: config.scenario,
    config: {
      chunks: config.chunks,
      size: config.size,
      iterations: config.iterations,
      warmup: config.warmup,
    },
    stats: {
      elapsed: {
        median: median(elapsedVals),
        min: Math.min(...elapsedVals),
        max: Math.max(...elapsedVals),
        mean: mean(elapsedVals),
        p95: percentile(elapsedVals, 0.95),
      },
      throughput: {
        median: median(throughputVals),
        min: Math.min(...throughputVals),
        max: Math.max(...throughputVals),
        mean: mean(throughputVals),
      },
    },
    results,
  };
}
