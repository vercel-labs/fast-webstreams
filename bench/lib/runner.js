/**
 * Core benchmark engine: warmup, iteration, timing, metric collection.
 */

import { GCTracker, memorySnapshot, memoryDelta, forceGC } from './gc-tracker.js';
import { summarize } from './stats.js';

/**
 * Run a single benchmark variant.
 *
 * @param {object} opts
 * @param {string} opts.name - Variant name (e.g. "node-pipe")
 * @param {function} opts.fn - Async function that runs the streaming workload.
 *   Receives { chunkSize, totalBytes, highWaterMark } and must return { bytesProcessed }.
 * @param {number} opts.chunkSize
 * @param {number} opts.totalBytes
 * @param {number} opts.highWaterMark
 * @param {number} opts.warmup - Number of warmup iterations (discarded)
 * @param {number} opts.iterations - Number of measured iterations
 * @returns {object} Results with raw measurements and summary statistics
 */
export async function runVariant({
  name,
  fn,
  chunkSize,
  totalBytes,
  highWaterMark,
  warmup,
  iterations,
}) {
  const gcTracker = new GCTracker();
  const params = { chunkSize, totalBytes, highWaterMark };

  // Warmup phase — discard results
  for (let i = 0; i < warmup; i++) {
    forceGC();
    await fn(params);
  }

  // Measurement phase
  const timesMs = [];
  const throughputsMBs = [];
  const memDeltas = [];
  const gcSummaries = [];
  let expectedBytes = null;

  for (let i = 0; i < iterations; i++) {
    forceGC();

    const memBefore = memorySnapshot();
    gcTracker.start();

    const startNs = process.hrtime.bigint();
    const result = await fn(params);
    const endNs = process.hrtime.bigint();

    gcTracker.stop();
    const memAfter = memorySnapshot();

    const elapsedMs = Number(endNs - startNs) / 1e6;
    const elapsedS = elapsedMs / 1000;
    const bytesProcessed = result.bytesProcessed;

    // Assert correctness: bytes must be > 0 and consistent across iterations
    if (bytesProcessed <= 0) {
      throw new Error(`${name}: bytesProcessed is ${bytesProcessed} (must be > 0)`);
    }
    if (expectedBytes === null) {
      expectedBytes = bytesProcessed;
    } else if (bytesProcessed !== expectedBytes) {
      throw new Error(
        `${name}: bytesProcessed (${bytesProcessed}) differs from first iteration (${expectedBytes})`
      );
    }

    const throughput = (bytesProcessed / (1024 * 1024)) / elapsedS;

    timesMs.push(elapsedMs);
    throughputsMBs.push(throughput);
    memDeltas.push(memoryDelta(memBefore, memAfter));
    gcSummaries.push(gcTracker.summarize());
    gcTracker.reset();
  }

  return {
    name,
    chunkSize,
    totalBytes,
    highWaterMark,
    iterations,
    raw: {
      timesMs,
      throughputsMBs,
      memDeltas,
      gcSummaries,
    },
    stats: {
      timeMs: summarize(timesMs),
      throughputMBs: summarize(throughputsMBs),
      memory: {
        rssDelta: summarize(memDeltas.map((d) => d.rssDelta)),
        heapUsedDelta: summarize(memDeltas.map((d) => d.heapUsedDelta)),
      },
      gc: {
        count: summarize(gcSummaries.map((g) => g.count)),
        totalPauseMs: summarize(gcSummaries.map((g) => g.totalPauseMs)),
        majorCount: summarize(gcSummaries.map((g) => g.majorCount)),
        minorCount: summarize(gcSummaries.map((g) => g.minorCount)),
      },
    },
  };
}

/**
 * Run all variants for a scenario at a given chunk size.
 *
 * @param {object} scenario - Scenario object with { name, variants }
 * @param {object} opts - { chunkSize, totalBytes, highWaterMark, warmup, iterations }
 * @returns {object[]} Array of variant results
 */
export async function runScenario(scenario, opts) {
  const results = [];

  for (const variant of scenario.variants) {
    // Check if this variant should be skipped for this chunk size
    if (variant.skipIf && variant.skipIf(opts)) {
      continue;
    }

    process.stdout.write(`    ${variant.name} ... `);
    const result = await runVariant({
      name: variant.name,
      fn: variant.fn,
      ...opts,
    });
    const median = result.stats.throughputMBs.median;
    process.stdout.write(`${median.toFixed(1)} MB/s\n`);
    results.push(result);
  }

  return results;
}
