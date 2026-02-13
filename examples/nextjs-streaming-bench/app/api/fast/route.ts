import { patchGlobalWebStreams } from "experimental-fast-webstreams";
import { runBenchmark } from "../../lib/bench";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

// Patch globals and keep them patched — the Symbol.hasInstance overrides
// are required for Tier 0 pipeline to work (instanceof checks in pipe path).
patchGlobalWebStreams();

// The patched constructors are now on globalThis — this is exactly what
// a real app does: patchGlobalWebStreams() in instrumentation, then
// new ReadableStream/TransformStream/WritableStream everywhere.
const PatchedRS = globalThis.ReadableStream;
const PatchedTS = globalThis.TransformStream;
const PatchedWS = globalThis.WritableStream;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const scenario = url.searchParams.get("scenario") || "read-loop";
  const chunks = Math.min(
    parseInt(url.searchParams.get("chunks") || "5000"),
    100000
  );
  const size = Math.min(
    parseInt(url.searchParams.get("size") || "64"),
    1048576
  );
  const iterations = Math.min(
    parseInt(url.searchParams.get("iterations") || "10"),
    50
  );
  const warmup = Math.min(
    parseInt(url.searchParams.get("warmup") || "3"),
    10
  );

  const result = await runBenchmark(
    { scenario, chunks, size, iterations, warmup, _baseUrl: url.origin },
    PatchedRS,
    PatchedTS,
    PatchedWS
  );

  return Response.json(result, {
    headers: { "Cache-Control": "no-store" },
  });
}
