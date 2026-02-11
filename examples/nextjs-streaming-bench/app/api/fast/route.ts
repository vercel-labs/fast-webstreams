import {
  FastReadableStream,
  FastTransformStream,
  FastWritableStream,
} from "experimental-fast-webstreams";
import { runBenchmark } from "../../lib/bench";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const scenario = url.searchParams.get("scenario") || "read-loop";
  const chunks = Math.min(parseInt(url.searchParams.get("chunks") || "5000"), 100000);
  const size = Math.min(parseInt(url.searchParams.get("size") || "64"), 1048576);
  const iterations = Math.min(parseInt(url.searchParams.get("iterations") || "10"), 50);
  const warmup = Math.min(parseInt(url.searchParams.get("warmup") || "3"), 10);

  const result = await runBenchmark(
    { scenario, chunks, size, iterations, warmup },
    FastReadableStream,
    FastTransformStream,
    FastWritableStream
  );

  return Response.json(result, {
    headers: { "Cache-Control": "no-store" },
  });
}
