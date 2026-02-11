import { existsSync } from "node:fs";
import { join } from "node:path";

export async function register() {
  // Check common locations for the bench-fast route directory.
  // On Vercel, split functions only contain their own route files,
  // so bench-fast existing means this IS the fast function.
  const cwd = process.cwd();
  const candidates = [join(cwd, ".next/server/app/bench-fast")];

  if (candidates.some((p) => existsSync(p))) {
    const { patchGlobalWebStreams } = await import(
      "experimental-fast-webstreams"
    );
    // skipTransform: Next.js chains 5-8 TransformStreams per SSR request
    // (buffered, metadata, flight injection, etc.) — native C++ handles
    // these faster than Node.js Transform wrapping.
    patchGlobalWebStreams({ skipTransform: true });
    console.log("[fast-webstreams] patched globals (skipTransform)");
  } else {
    console.log("[fast-webstreams] not patched (bench-fast not found)");
  }
}
