import { connection } from "next/server";
import BenchPage from "../bench-shared";

export const dynamic = "force-dynamic";
export const maxDuration = 122;

// Patching handled by instrumentation.ts (detects bench-fast dir)

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ n?: string; rows?: string }>;
}) {
  await connection();
  return <BenchPage searchParams={searchParams} />;
}
