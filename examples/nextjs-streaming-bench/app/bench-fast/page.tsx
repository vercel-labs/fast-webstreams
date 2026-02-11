import { patchGlobalWebStreams } from "experimental-fast-webstreams";
import { connection } from "next/server";
import BenchPage from "../bench-shared";

export const dynamic = "force-dynamic";
export const maxDuration = 122;

patchGlobalWebStreams();

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ n?: string; rows?: string }>;
}) {
  await connection();
  return <BenchPage searchParams={searchParams} />;
}
