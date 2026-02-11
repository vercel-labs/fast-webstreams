import { patchGlobalWebStreams } from "experimental-fast-webstreams";
import { Suspense } from "react";

export const dynamic = "force-dynamic";
export const maxDuration = 122;

patchGlobalWebStreams();

// Minimal async yield — just enough to trigger Suspense streaming
// without adding timer latency that would dwarf stream overhead.
async function DataSection({ id, rowCount }: { id: number; rowCount: number }) {
  await Promise.resolve();

  const rows = Array.from({ length: rowCount }, (_, j) => {
    const idx = id * rowCount + j;
    return (
      <tr key={j} className="border-b border-zinc-800">
        <td className="py-1 pr-4">{`Item ${idx}`}</td>
        <td className="py-1 pr-4 font-mono">{(idx * 7.13).toFixed(2)}</td>
        <td className="py-1 pr-4">{["active", "pending", "complete"][j % 3]}</td>
        <td className="py-1 pr-4 font-mono text-zinc-500">{`${idx}-${(idx * 31) % 9999}`}</td>
        <td className="py-1 font-mono text-zinc-600">{`row-${idx}-data-placeholder-text`}</td>
      </tr>
    );
  });

  return (
    <section className="mb-2">
      <h3 className="text-xs font-semibold text-zinc-500 mb-1">Section {id}</h3>
      <table className="w-full text-sm">
        <tbody>{rows}</tbody>
      </table>
    </section>
  );
}

export default async function BenchPage({
  searchParams,
}: {
  searchParams: Promise<{ n?: string; rows?: string }>;
}) {
  const { n, rows } = await searchParams;
  const count = Math.min(parseInt(n || "100"), 500);
  const rowCount = Math.min(parseInt(rows || "20"), 100);

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 p-8 max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold mb-1">Streaming Benchmark</h1>
      <p className="text-zinc-500 text-sm mb-6">
        {count} Suspense boundaries x {rowCount} rows each
      </p>
      {Array.from({ length: count }, (_, i) => (
        <Suspense
          key={i}
          fallback={<div className="mb-2 h-4 bg-zinc-900 rounded" />}
        >
          <DataSection id={i} rowCount={rowCount} />
        </Suspense>
      ))}
    </div>
  );
}
