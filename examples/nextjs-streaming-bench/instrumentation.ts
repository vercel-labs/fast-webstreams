import { execSync } from "node:child_process";

export async function register() {
  try {
    const found = execSync(
      "find / -maxdepth 6 -type d -name bench-fast 2>/dev/null | head -1",
      { encoding: "utf-8", timeout: 2000 }
    ).trim();

    if (found) {
      const { patchGlobalWebStreams } = await import(
        "experimental-fast-webstreams"
      );
      patchGlobalWebStreams();
      console.log("[fast-webstreams] patched globals (found", found, ")");
    }
  } catch {
    // Not found or timed out — don't patch
  }
}
