// Streaming data endpoint for fetch benchmarks.
// Returns `chunks` chunks of `size` bytes as a streaming response.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const chunks = Math.min(parseInt(url.searchParams.get("chunks") || "100"), 100000);
  const size = Math.min(parseInt(url.searchParams.get("size") || "1024"), 1048576);

  const data = new Uint8Array(size).fill(0x41);
  let i = 0;

  const stream = new ReadableStream({
    pull(controller) {
      if (i >= chunks) {
        controller.close();
        return;
      }
      controller.enqueue(data);
      i++;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Cache-Control": "no-store",
    },
  });
}
