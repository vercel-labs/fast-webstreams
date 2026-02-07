/**
 * Output formatters: console table, JSON file, markdown report.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { compare } from './stats.js';

/**
 * Print results for a single scenario + chunk size to the console as a table.
 */
export function printTable(scenarioName, chunkSize, variantResults) {
  if (variantResults.length === 0) return;

  const header = [
    'Variant',
    'Throughput (MB/s)',
    'Time (ms)',
    'Stddev',
    'p95',
    'GC Count',
    'GC Pause (ms)',
    'Heap Delta (MB)',
  ];

  const rows = variantResults.map((r) => [
    r.name,
    r.stats.throughputMBs.median.toFixed(1),
    r.stats.timeMs.median.toFixed(1),
    r.stats.timeMs.stddev.toFixed(1),
    r.stats.timeMs.p95.toFixed(1),
    r.stats.gc.count.mean.toFixed(1),
    r.stats.gc.totalPauseMs.mean.toFixed(2),
    (r.stats.memory.heapUsedDelta.mean / (1024 * 1024)).toFixed(2),
  ]);

  // Calculate column widths
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i].length))
  );

  const sep = widths.map((w) => '-'.repeat(w)).join(' | ');
  const fmt = (row) => row.map((c, i) => c.padStart(widths[i])).join(' | ');

  const chunkLabel = chunkSize >= 1024 * 1024
    ? `${chunkSize / (1024 * 1024)}MB`
    : chunkSize >= 1024
      ? `${chunkSize / 1024}KB`
      : `${chunkSize}B`;

  console.log(`\n  ${scenarioName} @ ${chunkLabel}`);
  console.log(`  ${fmt(header)}`);
  console.log(`  ${sep}`);
  for (const row of rows) {
    console.log(`  ${fmt(row)}`);
  }

  // Print comparison if we have both node and web variants
  const nodeVariant = variantResults.find((r) => r.name.startsWith('node-'));
  const webVariant = variantResults.find((r) => r.name.startsWith('web-'));
  if (nodeVariant && webVariant) {
    const cmp = compare(
      nodeVariant.raw.throughputsMBs,
      webVariant.raw.throughputsMBs
    );
    // ratio = web/node. If < 1, web is slower (node is faster). If > 1, web is faster.
    const faster = cmp.ratio > 1 ? 'web' : 'node';
    const ratio = cmp.ratio > 1 ? cmp.ratio : (1 / cmp.ratio);
    const sig = cmp.significant ? '' : ' (not significant)';
    console.log(
      `  >> ${faster} is ${ratio.toFixed(2)}x faster [${cmp.ciLow.toFixed(2)}-${cmp.ciHigh.toFixed(2)}]${sig}`
    );
  }
}

/**
 * Write full results as JSON to a file.
 */
export async function writeJSON(results, outputDir) {
  await mkdir(outputDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filePath = join(outputDir, `bench-${timestamp}.json`);

  // Strip raw data for smaller JSON (keep stats)
  const slim = results.map((group) => ({
    scenario: group.scenario,
    chunkSize: group.chunkSize,
    variants: group.variants.map((v) => ({
      name: v.name,
      chunkSize: v.chunkSize,
      totalBytes: v.totalBytes,
      highWaterMark: v.highWaterMark,
      iterations: v.iterations,
      stats: v.stats,
    })),
  }));

  await writeFile(filePath, JSON.stringify(slim, null, 2));
  return filePath;
}

/**
 * Write results as a markdown report.
 */
export async function writeMarkdown(results, outputDir) {
  await mkdir(outputDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filePath = join(outputDir, `bench-${timestamp}.md`);

  const lines = [
    `# Benchmark Results`,
    ``,
    `Date: ${new Date().toISOString()}`,
    `Node.js: ${process.version}`,
    `Platform: ${process.platform} ${process.arch}`,
    ``,
  ];

  for (const group of results) {
    const chunkLabel = formatChunkSize(group.chunkSize);
    lines.push(`## ${group.scenario} @ ${chunkLabel}`);
    lines.push('');
    lines.push(
      '| Variant | Throughput (MB/s) | Time (ms) | Stddev | p95 | GC Count | GC Pause (ms) | Heap Delta (MB) |'
    );
    lines.push(
      '|---|---|---|---|---|---|---|---|'
    );

    for (const v of group.variants) {
      lines.push(
        `| ${v.name} | ${v.stats.throughputMBs.median.toFixed(1)} | ${v.stats.timeMs.median.toFixed(1)} | ${v.stats.timeMs.stddev.toFixed(1)} | ${v.stats.timeMs.p95.toFixed(1)} | ${v.stats.gc.count.mean.toFixed(1)} | ${v.stats.gc.totalPauseMs.mean.toFixed(2)} | ${(v.stats.memory.heapUsedDelta.mean / (1024 * 1024)).toFixed(2)} |`
      );
    }

    // Comparison row
    const nodeVariant = group.variants.find((r) => r.name.startsWith('node-'));
    const webVariant = group.variants.find((r) => r.name.startsWith('web-'));
    if (nodeVariant && webVariant) {
      const cmp = compare(
        nodeVariant.raw.throughputsMBs,
        webVariant.raw.throughputsMBs
      );
      // ratio = web/node. If < 1, web is slower (node is faster). If > 1, web is faster.
      const faster = cmp.ratio > 1 ? 'web' : 'node';
      const ratio = cmp.ratio > 1 ? cmp.ratio : (1 / cmp.ratio);
      const sig = cmp.significant ? '' : ' (not significant)';
      lines.push('');
      lines.push(
        `> ${faster} is **${ratio.toFixed(2)}x** faster [${cmp.ciLow.toFixed(2)}-${cmp.ciHigh.toFixed(2)}]${sig}`
      );
    }

    lines.push('');
  }

  await writeFile(filePath, lines.join('\n'));
  return filePath;
}

function formatChunkSize(size) {
  if (size >= 1024 * 1024) return `${size / (1024 * 1024)}MB`;
  if (size >= 1024) return `${size / 1024}KB`;
  return `${size}B`;
}
