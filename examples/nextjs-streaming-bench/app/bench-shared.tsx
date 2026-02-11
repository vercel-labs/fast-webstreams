import { Suspense } from "react";

async function DataSection({
  id,
  rowCount,
  delayMs,
}: {
  id: number;
  rowCount: number;
  delayMs: number;
}) {
  // Real setTimeout to force React to flush separate streaming chunks.
  // Stagger by id so components resolve at different ticks — without this
  // React batches everything into one chunk and stream overhead disappears.
  await new Promise((r) => setTimeout(r, delayMs));

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
  const rowCount = Math.min(parseInt(params.rows || "20"), 100);
  // How many distinct resolution times (spreads components across ticks)
  const groups = Math.min(parseInt(params.groups || "50"), count);
  // Base delay per group in ms
  const delay = Math.max(parseInt(params.delay || "1"), 1);

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 p-8 max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold mb-1">Streaming Benchmark</h1>
      <p className="text-zinc-500 text-sm mb-6">
        {count} Suspense boundaries x {rowCount} rows | {groups} groups x{" "}
        {delay}ms delay
      </p>
      {Array.from({ length: count }, (_, i) => (
        <Suspense
          key={i}
          fallback={<div className="mb-2 h-4 bg-zinc-900 rounded" />}
        >
          <DataSection
            id={i}
            rowCount={rowCount}
            delayMs={(i % groups) * delay + 1}
          />
        </Suspense>
      ))}
    </div>
  );
}
