import { Suspense } from "react";
import { setImmediate } from "timers";

async function DataSection({
  id,
  rowCount,
  delayMs,
}: {
  id: number;
  rowCount: number;
  delayMs: number;
}) {
  // Force React to flush a separate streaming chunk for this boundary.
  // delay=0: use setImmediate (next I/O tick, ~0.1ms — avoids setTimeout's
  // 1-15ms timer coalescing overhead while still creating a separate flush).
  // delay>0: use setTimeout for explicit ms stagger.
  if (delayMs <= 0) {
    await new Promise<void>((r) => setImmediate(r));
  } else {
    await new Promise((r) => setTimeout(r, delayMs));
  }

  // rows=0: minimal render mode — just a short string, no table.
  // Minimizes React CPU time to isolate streaming overhead.
  if (rowCount <= 0) {
    return <div data-id={id}>s{id}</div>;
  }

  const rows = Array.from({ length: rowCount }, (_, j) => {
    const idx = id * rowCount + j;
    return (
      <tr key={j} className="border-b border-zinc-800">
        <td className="py-1 pr-4">{`Item ${idx}`}</td>
        <td className="py-1 pr-4 font-mono">{(idx * 7.13).toFixed(2)}</td>
        <td className="py-1 pr-4">
          {["active", "pending", "complete"][j % 3]}
        </td>
        <td className="py-1 pr-4 font-mono text-zinc-500">{`${idx}-${
          (idx * 31) % 9999
        }`}</td>
        <td className="py-1 font-mono text-zinc-600">{`row-${idx}-data-placeholder-text`}</td>
      </tr>
    );
  });

  return (
    <section className="mb-2">
      <h3 className="text-xs font-semibold text-zinc-500 mb-1">
        Section {id}
      </h3>
      <table className="w-full text-sm">
        <tbody>{rows}</tbody>
      </table>
    </section>
  );
}

export default async function BenchPage({
  searchParams,
}: {
  searchParams: Promise<{
    n?: string;
    rows?: string;
    delay?: string;
    groups?: string;
  }>;
}) {
  const params = await searchParams;
  const count = Math.min(parseInt(params.n || "200"), 500);
  const rowCount = parseInt(params.rows || "20");
  // How many distinct resolution times (spreads components across ticks)
  const groups = Math.min(parseInt(params.groups || "50"), count);
  // Base delay per group in ms (0 = setImmediate, >0 = setTimeout)
  const delay = parseInt(params.delay || "1");

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 p-8 max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold mb-1">Streaming Benchmark</h1>
      <p className="text-zinc-500 text-sm mb-6">
        {count} Suspense boundaries x {rowCount} rows | {groups} groups x{" "}
        {delay === 0 ? "setImmediate" : `${delay}ms`} delay
      </p>
      {Array.from({ length: count }, (_, i) => (
        <Suspense
          key={i}
          fallback={<div className="mb-2 h-4 bg-zinc-900 rounded" />}
        >
          <DataSection
            id={i}
            rowCount={rowCount}
            delayMs={delay === 0 ? 0 : (i % groups) * delay + 1}
          />
        </Suspense>
      ))}
    </div>
  );
}
