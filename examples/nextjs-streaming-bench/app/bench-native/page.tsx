import { Suspense } from "react";

export const dynamic = "force-dynamic";
export const maxDuration = 123;

async function DataSection({ id }: { id: number }) {
  // Force async boundary — each resolves on a separate tick to create streaming chunks
  await new Promise((r) => setTimeout(r, 0));

  const rows = Array.from({ length: 10 }, (_, j) => ({
    name: `Item ${id * 10 + j}`,
    value: (Math.random() * 1000).toFixed(2),
    status: ["active", "pending", "complete"][j % 3],
    ts: Date.now(),
  }));

  return (
    <section className="mb-4">
      <h2 className="text-lg font-semibold mb-2">Section {id}</h2>
      <table className="w-full text-sm">
        <tbody>
          {rows.map((row, j) => (
            <tr key={j} className="border-b border-zinc-800">
              <td className="py-1 pr-4">{row.name}</td>
              <td className="py-1 pr-4 font-mono">{row.value}</td>
              <td className="py-1 pr-4">{row.status}</td>
              <td className="py-1 font-mono text-zinc-500">{row.ts}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

export default async function BenchPage({
  searchParams,
}: {
  searchParams: Promise<{ n?: string }>;
}) {
  const { n } = await searchParams;
  const count = Math.min(parseInt(n || "50"), 200);

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 p-8 max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold mb-1">Streaming Benchmark Page</h1>
      <p className="text-zinc-500 text-sm mb-6">
        {count} async Suspense boundaries, each rendering a data table
      </p>
      {Array.from({ length: count }, (_, i) => (
        <Suspense
          key={i}
          fallback={
            <div className="mb-4 h-16 bg-zinc-900 rounded animate-pulse" />
          }
        >
          <DataSection id={i} />
        </Suspense>
      ))}
    </div>
  );
}
