/**
 * Output formatters: console table, JSON file, markdown report.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { compare } from './stats.js';

function getGitInfo() {
  try {
    const sha = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
    const dirty = execSync('git status --porcelain', { encoding: 'utf8' }).trim().length > 0;
    return { sha, dirty };
  } catch {
    return { sha: 'unknown', dirty: false };
  }
}

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
 * Output is human-readable with 2-space indentation.
 * Filename: $ISO-datetime-$scenario.json (e.g. 2026-02-14T03:22:23.240Z-passthrough.json)
 */
export async function writeJSON(results, outputDir, scenario = 'all', description) {
  await mkdir(outputDir, { recursive: true });
  const timestamp = new Date().toISOString();
  const filePath = join(outputDir, `${timestamp}-${scenario}.json`);

  const git = getGitInfo();

  const output = {
    timestamp,
    description: description || null,
    git: { sha: git.sha, dirty: git.dirty },
    nodeVersion: process.version,
    platform: `${process.platform} ${process.arch}`,
    results: results.map((group) => ({
      scenario: group.scenario,
      chunkSize: group.chunkSize,
      variants: group.variants.map((v) => ({
        name: v.name,
        throughputMBs: round(v.stats.throughputMBs.median),
        timeMs: round(v.stats.timeMs.median),
        stddev: round(v.stats.timeMs.stddev),
        p95: round(v.stats.timeMs.p95),
        gcCount: round(v.stats.gc.count.mean),
        gcPauseMs: round(v.stats.gc.totalPauseMs.mean),
        heapDeltaMB: round(v.stats.memory.heapUsedDelta.mean / (1024 * 1024)),
        config: {
          chunkSize: v.chunkSize,
          totalBytes: v.totalBytes,
          highWaterMark: v.highWaterMark,
          iterations: v.iterations,
        },
      })),
    })),
  };

  await writeFile(filePath, JSON.stringify(output, null, 2) + '\n');
  return filePath;
}

function round(n) {
  return Math.round(n * 100) / 100;
}

/**
 * Write results as a markdown report.
 */
export async function writeMarkdown(results, outputDir, scenario = 'all') {
  await mkdir(outputDir, { recursive: true });
  const timestamp = new Date().toISOString();
  const filePath = join(outputDir, `${timestamp}-${scenario}.md`);

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
