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

  const start = performance.now();

  switch (config.scenario) {
    case "read-loop": {
      await consumeReader(makeSource());
      break;
    }
    case "pipe-through": {
      await consumeReader(makeSource().pipeThrough(new TS()));
      break;
    }
    case "multi-transform": {
      await consumeReader(
        makeSource()
          .pipeThrough(new TS())
          .pipeThrough(new TS())
          .pipeThrough(new TS())
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
      let i = 0;
      const stream = new RS({
        type: "bytes",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        pull(controller: any) {
          if (i >= config.chunks) {
            controller.close();
            return;
          }
          controller.enqueue(new Uint8Array(data));
          i++;
        },
      });
      await consumeReader(stream);
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
