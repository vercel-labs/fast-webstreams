"use client";

import { useState, useCallback, useRef } from "react";

// --- Types ---

type Scenario = "read-loop" | "pipe-through" | "multi-transform" | "pipe-to" | "byte-stream";

type BenchStats = {
  median: number;
  min: number;
  max: number;
  mean: number;
  p95?: number;
};

type BenchResult = {
  scenario: string;
  config: { chunks: number; size: number; iterations: number; warmup: number };
  stats: {
    elapsed: BenchStats;
    throughput: Omit<BenchStats, "p95">;
  };
  results: Array<{ elapsed: number; bytes: number; throughput: number }>;
};

type ScenarioResult = {
  scenario: Scenario;
  native: BenchResult;
  fast: BenchResult;
};

type Config = {
  chunks: number;
  size: number;
  iterations: number;
  warmup: number;
};

// --- Constants ---

const SCENARIOS: { id: Scenario; label: string; desc: string }[] = [
  { id: "read-loop", label: "Read Loop", desc: "reader.read() consumption" },
  { id: "pipe-through", label: "Pipe Through", desc: "1 transform with JS callback" },
  { id: "multi-transform", label: "3x Transform", desc: "3 chained JS transforms" },
  { id: "pipe-to", label: "Pipe To", desc: "pipeTo() a writable sink" },
  { id: "byte-stream", label: "Byte Stream", desc: "type: 'bytes' start+enqueue" },
];

const PRESETS: { name: string; desc: string; config: Partial<Config> }[] = [
  { name: "SSR Chunks", desc: "10K × 100B", config: { chunks: 10000, size: 100 } },
  { name: "API Streaming", desc: "2K × 1KB", config: { chunks: 2000, size: 1024 } },
  { name: "Large Transfer", desc: "200 × 64KB", config: { chunks: 200, size: 65536 } },
];

const DEFAULT_CONFIG: Config = {
  chunks: 5000,
  size: 64,
  iterations: 10,
  warmup: 3,
};

// --- Formatting ---

function formatTime(ms: number): string {
  if (ms < 0.001) return `${(ms * 1_000_000).toFixed(0)} ns`;
  if (ms < 1) return `${(ms * 1000).toFixed(0)} µs`;
  if (ms < 1000) return `${ms.toFixed(1)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatThroughput(bps: number): string {
  return `${formatBytes(bps)}/s`;
}

function speedupColor(s: number): string {
  if (s >= 2) return "bg-emerald-500/20 text-emerald-400";
  if (s >= 1.3) return "bg-emerald-500/10 text-emerald-300";
  if (s >= 1.05) return "bg-yellow-500/15 text-yellow-400";
  return "bg-zinc-700 text-zinc-300";
}

// --- Components ---

function ScenarioCard({ result }: { result: ScenarioResult }) {
  const nativeMs = result.native.stats.elapsed.median;
  const fastMs = result.fast.stats.elapsed.median;
  const speedup = nativeMs / fastMs;
  const maxMs = Math.max(nativeMs, fastMs);

  const scenarioMeta = SCENARIOS.find((s) => s.id === result.scenario);

  return (
    <div className="bg-zinc-900 rounded-xl border border-zinc-800 p-5">
      <div className="flex justify-between items-center mb-4">
        <div>
          <h3 className="font-medium text-zinc-100">
            {scenarioMeta?.label || result.scenario}
          </h3>
          <p className="text-xs text-zinc-500 mt-0.5">{scenarioMeta?.desc}</p>
        </div>
        <span
          className={`px-2.5 py-1 rounded-lg text-sm font-mono font-semibold ${speedupColor(speedup)}`}
        >
          {speedup.toFixed(1)}x
        </span>
      </div>

      <div className="space-y-2">
        <div className="flex items-center gap-3">
          <span className="w-14 text-xs text-zinc-500 text-right">Native</span>
          <div className="flex-1 h-7 bg-zinc-800 rounded-md overflow-hidden">
            <div
              className="h-full bg-amber-500/70 rounded-md transition-all duration-700 ease-out"
              style={{ width: `${(nativeMs / maxMs) * 100}%` }}
            />
          </div>
          <span className="w-20 text-right text-xs font-mono text-zinc-300">
            {formatTime(nativeMs)}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span className="w-14 text-xs text-zinc-500 text-right">Fast</span>
          <div className="flex-1 h-7 bg-zinc-800 rounded-md overflow-hidden">
            <div
              className="h-full bg-emerald-500/70 rounded-md transition-all duration-700 ease-out"
              style={{ width: `${(fastMs / maxMs) * 100}%` }}
            />
          </div>
          <span className="w-20 text-right text-xs font-mono text-zinc-300">
            {formatTime(fastMs)}
          </span>
        </div>
      </div>

      <div className="mt-4 pt-3 border-t border-zinc-800 grid grid-cols-2 gap-x-6 gap-y-1 text-xs">
        <div className="flex justify-between text-zinc-500">
          <span>Throughput</span>
          <span className="font-mono text-amber-400/80">
            {formatThroughput(result.native.stats.throughput.median)}
          </span>
        </div>
        <div className="flex justify-between text-zinc-500">
          <span>Throughput</span>
          <span className="font-mono text-emerald-400/80">
            {formatThroughput(result.fast.stats.throughput.median)}
          </span>
        </div>
        <div className="flex justify-between text-zinc-500">
          <span>p95</span>
          <span className="font-mono text-zinc-400">
            {formatTime(result.native.stats.elapsed.p95 ?? result.native.stats.elapsed.max)}
          </span>
        </div>
        <div className="flex justify-between text-zinc-500">
          <span>p95</span>
          <span className="font-mono text-zinc-400">
            {formatTime(result.fast.stats.elapsed.p95 ?? result.fast.stats.elapsed.max)}
          </span>
        </div>
        <div className="flex justify-between text-zinc-500 col-span-2">
          <span>Data</span>
          <span className="font-mono text-zinc-400">
            {formatBytes(result.native.results[0]?.bytes || 0)}
            {" "}({result.native.config.chunks.toLocaleString()} x {formatBytes(result.native.config.size)})
          </span>
        </div>
      </div>
    </div>
  );
}

export default function BenchmarkPage() {
  const [config, setConfig] = useState<Config>(DEFAULT_CONFIG);
  const [results, setResults] = useState<ScenarioResult[]>([]);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [selectedScenarios, setSelectedScenarios] = useState<Set<Scenario>>(
    new Set(SCENARIOS.map((s) => s.id))
  );

  const toggleScenario = useCallback((id: Scenario) => {
    setSelectedScenarios((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        if (next.size > 1) next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const applyPreset = useCallback((preset: Partial<Config>) => {
    setConfig((prev) => ({ ...prev, ...preset }));
  }, []);

  const fetchBench = useCallback(
    async (variant: "native" | "fast", scenario: string): Promise<BenchResult | null> => {
      try {
        const params = new URLSearchParams({
          scenario,
          chunks: String(config.chunks),
          size: String(config.size),
          iterations: String(config.iterations),
          warmup: String(config.warmup),
        });
        const res = await fetch(`/api/${variant}?${params}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
        return await res.json();
      } catch (err) {
        setError(`Failed: ${variant} ${scenario} - ${err instanceof Error ? err.message : err}`);
        return null;
      }
    },
    [config]
  );

  const runAll = useCallback(async () => {
    setRunning(true);
    setResults([]);
    setError("");

    const scenarios = SCENARIOS.filter((s) => selectedScenarios.has(s.id));
    const total = scenarios.length * 2;
    let step = 0;

    for (const { id, label } of scenarios) {
      step++;
      setProgress(`Running native ${label}... (${step}/${total})`);
      const native = await fetchBench("native", id);

      step++;
      setProgress(`Running fast ${label}... (${step}/${total})`);
      const fast = await fetchBench("fast", id);

      if (native && fast) {
        setResults((prev) => [...prev, { scenario: id, native, fast }]);
      }
    }

    setRunning(false);
    setProgress("");
  }, [fetchBench, selectedScenarios]);

  const avgSpeedup =
    results.length > 0
      ? results.reduce((sum, r) => {
          return sum + r.native.stats.elapsed.median / r.fast.stats.elapsed.median;
        }, 0) / results.length
      : 0;

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <header className="border-b border-zinc-800 px-6 py-6">
        <div className="max-w-5xl mx-auto">
          <h1 className="text-2xl font-semibold tracking-tight">
            fast-webstreams
          </h1>
          <p className="text-zinc-500 text-sm mt-1">
            Server-side streaming performance: native WebStreams vs fast-webstreams
          </p>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-8 space-y-6">
        {/* Configuration */}
        <section className="bg-zinc-900 rounded-xl border border-zinc-800 p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-medium text-zinc-300 uppercase tracking-wider">
              Configuration
            </h2>
            <div className="flex gap-2">
              {PRESETS.map((p) => (
                <button
                  key={p.name}
                  onClick={() => applyPreset(p.config)}
                  className="px-3 py-1 rounded-lg bg-zinc-800 text-xs text-zinc-300 hover:bg-zinc-700 hover:text-zinc-100 transition border border-zinc-700/50"
                >
                  {p.name}{" "}
                  <span className="text-zinc-500">{p.desc}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-5">
            <label className="block">
              <span className="text-xs text-zinc-500 mb-1 block">Chunks</span>
              <input
                type="number"
                value={config.chunks}
                onChange={(e) =>
                  setConfig((c) => ({ ...c, chunks: parseInt(e.target.value) || 1 }))
                }
                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm font-mono text-zinc-100 focus:outline-none focus:border-zinc-500"
              />
            </label>
            <label className="block">
              <span className="text-xs text-zinc-500 mb-1 block">
                Size (bytes)
              </span>
              <input
                type="number"
                value={config.size}
                onChange={(e) =>
                  setConfig((c) => ({ ...c, size: parseInt(e.target.value) || 1 }))
                }
                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm font-mono text-zinc-100 focus:outline-none focus:border-zinc-500"
              />
            </label>
            <label className="block">
              <span className="text-xs text-zinc-500 mb-1 block">
                Iterations
              </span>
              <input
                type="number"
                value={config.iterations}
                onChange={(e) =>
                  setConfig((c) => ({
                    ...c,
                    iterations: parseInt(e.target.value) || 1,
                  }))
                }
                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm font-mono text-zinc-100 focus:outline-none focus:border-zinc-500"
              />
            </label>
            <label className="block">
              <span className="text-xs text-zinc-500 mb-1 block">Warmup</span>
              <input
                type="number"
                value={config.warmup}
                onChange={(e) =>
                  setConfig((c) => ({
                    ...c,
                    warmup: parseInt(e.target.value) || 0,
                  }))
                }
                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm font-mono text-zinc-100 focus:outline-none focus:border-zinc-500"
              />
            </label>
          </div>

          {/* Scenario selection */}
          <div>
            <span className="text-xs text-zinc-500 mb-2 block">Scenarios</span>
            <div className="flex flex-wrap gap-2">
              {SCENARIOS.map((s) => (
                <button
                  key={s.id}
                  onClick={() => toggleScenario(s.id)}
                  className={`px-3 py-1.5 rounded-lg text-sm transition border ${
                    selectedScenarios.has(s.id)
                      ? "bg-zinc-700 border-zinc-600 text-zinc-100"
                      : "bg-zinc-800/50 border-zinc-800 text-zinc-500 hover:text-zinc-400"
                  }`}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>
        </section>

        {/* Actions */}
        <div className="flex items-center gap-4">
          <button
            onClick={runAll}
            disabled={running}
            className={`px-6 py-3 rounded-xl font-medium text-sm transition ${
              running
                ? "bg-zinc-700 text-zinc-400 cursor-wait"
                : "bg-emerald-600 text-white hover:bg-emerald-500 active:bg-emerald-700"
            }`}
          >
            {running ? progress : "Run Benchmark"}
          </button>

          {running && (
            <div className="flex items-center gap-2 text-sm text-zinc-500">
              <svg
                className="animate-spin h-4 w-4 text-emerald-500"
                viewBox="0 0 24 24"
                fill="none"
              >
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                />
              </svg>
              Running...
            </div>
          )}
        </div>

        {error && (
          <div className="bg-red-500/10 border border-red-500/30 rounded-xl px-4 py-3 text-sm text-red-400">
            {error}
          </div>
        )}

        {/* Results */}
        {results.length > 0 && (
          <section className="space-y-6">
            {/* Summary */}
            <div className="bg-zinc-900 rounded-xl border border-zinc-800 p-6 text-center">
              <p className="text-xs text-zinc-500 uppercase tracking-wider">
                Average Speedup
              </p>
              <p className="text-5xl font-bold text-emerald-400 mt-2 font-mono">
                {avgSpeedup.toFixed(1)}x
              </p>
              <p className="text-sm text-zinc-500 mt-1">
                faster with fast-webstreams
              </p>
              <p className="text-xs text-zinc-600 mt-3">
                {config.chunks.toLocaleString()} chunks x{" "}
                {formatBytes(config.size)} ={" "}
                {formatBytes(config.chunks * config.size)} total |{" "}
                {config.iterations} iterations | {config.warmup} warmup
              </p>
            </div>

            {/* Scenario cards */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {results.map((r) => (
                <ScenarioCard key={r.scenario} result={r} />
              ))}
            </div>

            {/* Raw iteration data (collapsed by default) */}
            <details className="bg-zinc-900 rounded-xl border border-zinc-800">
              <summary className="px-5 py-3 text-sm text-zinc-400 cursor-pointer hover:text-zinc-300">
                Raw iteration data
              </summary>
              <div className="px-5 pb-4 overflow-x-auto">
                <table className="w-full text-xs font-mono">
                  <thead>
                    <tr className="text-zinc-500 border-b border-zinc-800">
                      <th className="text-left py-2 pr-4">Scenario</th>
                      <th className="text-left py-2 pr-4">Variant</th>
                      {Array.from(
                        { length: config.iterations },
                        (_, i) => (
                          <th key={i} className="text-right py-2 px-2">
                            #{i + 1}
                          </th>
                        )
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {results.flatMap((r) => [
                      <tr key={`${r.scenario}-native`} className="border-b border-zinc-800/50">
                        <td className="py-1.5 pr-4 text-zinc-400">
                          {SCENARIOS.find((s) => s.id === r.scenario)?.label}
                        </td>
                        <td className="py-1.5 pr-4 text-amber-400/70">
                          native
                        </td>
                        {r.native.results.map((iter, i) => (
                          <td
                            key={i}
                            className="py-1.5 px-2 text-right text-zinc-400"
                          >
                            {formatTime(iter.elapsed)}
                          </td>
                        ))}
                      </tr>,
                      <tr key={`${r.scenario}-fast`} className="border-b border-zinc-800/50">
                        <td className="py-1.5 pr-4"></td>
                        <td className="py-1.5 pr-4 text-emerald-400/70">
                          fast
                        </td>
                        {r.fast.results.map((iter, i) => (
                          <td
                            key={i}
                            className="py-1.5 px-2 text-right text-zinc-400"
                          >
                            {formatTime(iter.elapsed)}
                          </td>
                        ))}
                      </tr>,
                    ])}
                  </tbody>
                </table>
              </div>
            </details>
          </section>
        )}

        {/* Page Streaming Benchmark */}
        <PageStreamingBenchmark />
      </main>

      <footer className="border-t border-zinc-800 px-6 py-4 mt-12">
        <div className="max-w-5xl mx-auto text-xs text-zinc-600">
          API benchmarks run server-side in route handlers. Page benchmarks
          measure real Next.js SSR streaming via client-side fetch.
        </div>
      </footer>
    </div>
  );
}

// --- Page Streaming Benchmark ---

type PageResult = {
  ttfb: number;
  totalTime: number;
  totalBytes: number;
  chunks: number;
};

type PageStats = {
  ttfb: { median: number; min: number; max: number };
  totalTime: { median: number; min: number; max: number };
  totalBytes: number;
  chunks: { median: number; min: number; max: number };
};

function computePageStats(results: PageResult[]): PageStats {
  const sorted = (arr: number[]) => [...arr].sort((a, b) => a - b);
  const med = (arr: number[]) => {
    const s = sorted(arr);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };

  const ttfbs = results.map((r) => r.ttfb);
  const totals = results.map((r) => r.totalTime);
  const chunks = results.map((r) => r.chunks);

  return {
    ttfb: { median: med(ttfbs), min: Math.min(...ttfbs), max: Math.max(...ttfbs) },
    totalTime: { median: med(totals), min: Math.min(...totals), max: Math.max(...totals) },
    totalBytes: results[0]?.totalBytes || 0,
    chunks: { median: med(chunks), min: Math.min(...chunks), max: Math.max(...chunks) },
  };
}

function PageStreamingBenchmark() {
  const [nativeUrl, setNativeUrl] = useState("/bench-native?n=200&rows=20&groups=50&delay=1");
  const [fastUrl, setFastUrl] = useState("/bench-fast?n=200&rows=20&groups=50&delay=1");
  const [iterations, setIterations] = useState(10);
  const [warmup, setWarmup] = useState(2);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState("");
  const [nativeStats, setNativeStats] = useState<PageStats | null>(null);
  const [fastStats, setFastStats] = useState<PageStats | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  async function measurePage(url: string): Promise<PageResult> {
    const start = performance.now();
    const res = await fetch(url, { cache: "no-store" });
    const ttfb = performance.now() - start;

    const reader = res.body!.getReader();
    let totalBytes = 0;
    let chunks = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      chunks++;
    }
    const totalTime = performance.now() - start;
    return { ttfb, totalTime, totalBytes, chunks };
  }

  async function run() {
    setRunning(true);
    setNativeStats(null);
    setFastStats(null);
    abortRef.current = new AbortController();

    const totalRounds = warmup + iterations;

    // Warmup both endpoints
    for (let i = 0; i < warmup; i++) {
      setProgress(`Warming up... (${i + 1}/${warmup})`);
      await measurePage(nativeUrl);
      await measurePage(fastUrl);
    }

    // Interleave: alternate native/fast to eliminate ordering bias
    // (GC pressure, thermal throttling, memory fragmentation)
    const nativeResults: PageResult[] = [];
    const fastResults: PageResult[] = [];
    for (let i = 0; i < iterations; i++) {
      setProgress(`Running ${i + 1}/${iterations}...`);
      // Alternate which goes first each iteration
      if (i % 2 === 0) {
        nativeResults.push(await measurePage(nativeUrl));
        fastResults.push(await measurePage(fastUrl));
      } else {
        fastResults.push(await measurePage(fastUrl));
        nativeResults.push(await measurePage(nativeUrl));
      }
    }

    setNativeStats(computePageStats(nativeResults));
    setFastStats(computePageStats(fastResults));

    setRunning(false);
    setProgress("");
  }

  const speedup =
    nativeStats && fastStats
      ? nativeStats.totalTime.median / fastStats.totalTime.median
      : null;
  const ttfbSpeedup =
    nativeStats && fastStats
      ? nativeStats.ttfb.median / fastStats.ttfb.median
      : null;

  return (
    <section className="mt-10 space-y-6">
      <h2 className="text-lg font-semibold text-zinc-200">
        Page Streaming Benchmark
      </h2>
      <p className="text-xs text-zinc-500">
        Measures real Next.js SSR streaming. Set URLs to your deployed native
        and fast functions, or use local <code>/bench</code> for smoke testing.
      </p>

      <div className="bg-zinc-900 rounded-xl border border-zinc-800 p-6 space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <label className="block">
            <span className="text-xs text-zinc-500 mb-1 block">
              Native URL
            </span>
            <input
              type="text"
              value={nativeUrl}
              onChange={(e) => setNativeUrl(e.target.value)}
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm font-mono text-zinc-100 focus:outline-none focus:border-zinc-500"
            />
          </label>
          <label className="block">
            <span className="text-xs text-zinc-500 mb-1 block">Fast URL</span>
            <input
              type="text"
              value={fastUrl}
              onChange={(e) => setFastUrl(e.target.value)}
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm font-mono text-zinc-100 focus:outline-none focus:border-zinc-500"
            />
          </label>
        </div>
        <div className="flex gap-4 items-end">
          <label className="block">
            <span className="text-xs text-zinc-500 mb-1 block">
              Iterations
            </span>
            <input
              type="number"
              value={iterations}
              onChange={(e) => setIterations(parseInt(e.target.value) || 1)}
              className="w-24 bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm font-mono text-zinc-100 focus:outline-none focus:border-zinc-500"
            />
          </label>
          <label className="block">
            <span className="text-xs text-zinc-500 mb-1 block">Warmup</span>
            <input
              type="number"
              value={warmup}
              onChange={(e) => setWarmup(parseInt(e.target.value) || 0)}
              className="w-24 bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm font-mono text-zinc-100 focus:outline-none focus:border-zinc-500"
            />
          </label>
          <button
            onClick={run}
            disabled={running}
            className={`px-5 py-2 rounded-xl font-medium text-sm transition ${
              running
                ? "bg-zinc-700 text-zinc-400 cursor-wait"
                : "bg-emerald-600 text-white hover:bg-emerald-500"
            }`}
          >
            {running ? progress : "Run Page Benchmark"}
          </button>
        </div>
      </div>

      {nativeStats && fastStats && (
        <div className="bg-zinc-900 rounded-xl border border-zinc-800 p-6">
          <div className="flex items-center justify-between mb-5">
            <h3 className="font-medium text-zinc-100">Results</h3>
            {speedup && (
              <span
                className={`px-2.5 py-1 rounded-lg text-sm font-mono font-semibold ${speedupColor(speedup)}`}
              >
                {speedup.toFixed(1)}x total
              </span>
            )}
          </div>

          {/* Total time bars */}
          <p className="text-xs text-zinc-500 mb-2">Total streaming time</p>
          <div className="space-y-2 mb-5">
            {([
              ["Native", nativeStats.totalTime.median, "bg-amber-500/70"],
              ["Fast", fastStats.totalTime.median, "bg-emerald-500/70"],
            ] as const).map(([label, val, color]) => {
              const max = Math.max(
                nativeStats.totalTime.median,
                fastStats.totalTime.median
              );
              return (
                <div key={label} className="flex items-center gap-3">
                  <span className="w-14 text-xs text-zinc-500 text-right">
                    {label}
                  </span>
                  <div className="flex-1 h-7 bg-zinc-800 rounded-md overflow-hidden">
                    <div
                      className={`h-full ${color} rounded-md transition-all duration-700 ease-out`}
                      style={{ width: `${(val / max) * 100}%` }}
                    />
                  </div>
                  <span className="w-20 text-right text-xs font-mono text-zinc-300">
                    {formatTime(val)}
                  </span>
                </div>
              );
            })}
          </div>

          {/* TTFB bars */}
          <p className="text-xs text-zinc-500 mb-2">
            Time to first byte{" "}
            {ttfbSpeedup && (
              <span className={`ml-1 ${speedupColor(ttfbSpeedup)}`}>
                {ttfbSpeedup.toFixed(1)}x
              </span>
            )}
          </p>
          <div className="space-y-2 mb-5">
            {([
              ["Native", nativeStats.ttfb.median, "bg-amber-500/70"],
              ["Fast", fastStats.ttfb.median, "bg-emerald-500/70"],
            ] as const).map(([label, val, color]) => {
              const max = Math.max(
                nativeStats.ttfb.median,
                fastStats.ttfb.median
              );
              return (
                <div key={label} className="flex items-center gap-3">
                  <span className="w-14 text-xs text-zinc-500 text-right">
                    {label}
                  </span>
                  <div className="flex-1 h-7 bg-zinc-800 rounded-md overflow-hidden">
                    <div
                      className={`h-full ${color} rounded-md transition-all duration-700 ease-out`}
                      style={{ width: `${(val / max) * 100}%` }}
                    />
                  </div>
                  <span className="w-20 text-right text-xs font-mono text-zinc-300">
                    {formatTime(val)}
                  </span>
                </div>
              );
            })}
          </div>

          {/* Stats table */}
          <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs border-t border-zinc-800 pt-3">
            <div className="flex justify-between text-zinc-500">
              <span>Bytes</span>
              <span className="font-mono text-zinc-400">
                {formatBytes(nativeStats.totalBytes)}
              </span>
            </div>
            <div className="flex justify-between text-zinc-500">
              <span>Bytes</span>
              <span className="font-mono text-zinc-400">
                {formatBytes(fastStats.totalBytes)}
              </span>
            </div>
            <div className="flex justify-between text-zinc-500">
              <span>Chunks</span>
              <span className="font-mono text-zinc-400">
                {nativeStats.chunks.median}
              </span>
            </div>
            <div className="flex justify-between text-zinc-500">
              <span>Chunks</span>
              <span className="font-mono text-zinc-400">
                {fastStats.chunks.median}
              </span>
            </div>
            <div className="flex justify-between text-zinc-500">
              <span>Total range</span>
              <span className="font-mono text-zinc-400">
                {formatTime(nativeStats.totalTime.min)}-{formatTime(nativeStats.totalTime.max)}
              </span>
            </div>
            <div className="flex justify-between text-zinc-500">
              <span>Total range</span>
              <span className="font-mono text-zinc-400">
                {formatTime(fastStats.totalTime.min)}-{formatTime(fastStats.totalTime.max)}
              </span>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
