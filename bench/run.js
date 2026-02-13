#!/usr/bin/env node

/**
 * Benchmark suite entry point.
 *
 * Usage:
 *   node --expose-gc bench/run.js                              # Full suite
 *   node --expose-gc bench/run.js --scenario=passthrough       # One scenario
 *   node --expose-gc bench/run.js --chunk-size=65536           # One chunk size
 *   node --expose-gc bench/run.js --iterations=5 --warmup=2    # Quick run
 *   node --expose-gc bench/run.js --hwm=32768                  # Custom HWM
 *   node --expose-gc bench/run.js --json-only                  # JSON output only
 */

import { runScenario } from './lib/runner.js';
import { printTable, writeJSON, writeMarkdown } from './lib/reporter.js';
import { scenarioMap, scenarioNames } from './scenarios/index.js';
import { forceGC } from './lib/gc-tracker.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(__dirname, 'results');

// Default parameters
const DEFAULTS = {
  chunkSizes: [1024, 16384, 65536, 1048576],
  totalBytes: 100 * 1024 * 1024, // 100MB
  highWaterMark: 16384,           // 16KB
  warmup: 3,
  iterations: 10,
};

// Scenarios with reduced totalBytes
const REDUCED_TOTAL = {
  backpressure: 10 * 1024 * 1024,    // 10MB for backpressure (slow by design)
  compression: 10 * 1024 * 1024,     // 10MB for compression (CompressionStream is slow at small chunks)
  'byte-stream': 50 * 1024 * 1024,   // 50MB for byte-stream (pre-buffered, memory-heavy)
  'response-body': 20 * 1024 * 1024, // 20MB for response-body (avoids string concat GC)
};

// Smart filtering: skip combinations that don't make sense
const CHUNK_FILTERS = {
  'chunk-accumulation': (chunkSize) => chunkSize <= 16384,                       // Skip chunks > 16KB
  backpressure: (chunkSize) => chunkSize >= 1024,                                // Skip chunks < 1KB
  compression: (chunkSize) => chunkSize >= 1024,                                 // Skip chunks < 1KB (CompressionStream degrades non-linearly)
  'multi-transform': (chunkSize) => chunkSize >= 1024,                           // Skip < 1KB (per-chunk overhead dominates)
  'response-body': (chunkSize) => chunkSize <= 65536,                            // ≤64KB (fetch-transform needs small chunks; text concat at 1MB is trivially fast)
  'byte-stream': (chunkSize) => chunkSize >= 1024,                               // Skip < 1KB (pre-buffering tiny Uint8Arrays not representative)
};

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {};

  for (const arg of args) {
    if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    }

    const match = arg.match(/^--([a-z-]+)(?:=(.+))?$/);
    if (!match) {
      console.error(`Unknown argument: ${arg}`);
      process.exit(1);
    }

    const [, key, value] = match;
    switch (key) {
      case 'scenario':
        opts.scenario = value;
        break;
      case 'chunk-size':
        opts.chunkSizes = [parseInt(value, 10)];
        break;
      case 'iterations':
        opts.iterations = parseInt(value, 10);
        break;
      case 'warmup':
        opts.warmup = parseInt(value, 10);
        break;
      case 'hwm':
        opts.highWaterMark = parseInt(value, 10);
        break;
      case 'total-bytes':
        opts.totalBytes = parseInt(value, 10);
        break;
      case 'json-only':
        opts.jsonOnly = true;
        break;
      case 'no-markdown':
        opts.noMarkdown = true;
        break;
      default:
        console.error(`Unknown flag: --${key}`);
        process.exit(1);
    }
  }

  return opts;
}

function printUsage() {
  console.log(`
Benchmark Suite: Node.js Streams vs WebStreams

Usage:
  node --expose-gc bench/run.js [options]

Options:
  --scenario=NAME      Run only this scenario (${scenarioNames.join(', ')})
  --chunk-size=BYTES   Run only this chunk size (default: all)
  --iterations=N       Measurement iterations (default: ${DEFAULTS.iterations})
  --warmup=N           Warmup iterations (default: ${DEFAULTS.warmup})
  --hwm=BYTES          highWaterMark (default: ${DEFAULTS.highWaterMark})
  --total-bytes=BYTES  Total bytes per iteration (default: ${DEFAULTS.totalBytes})
  --json-only          Skip console output, write JSON only
  --no-markdown        Skip markdown output
  --help, -h           Show this help
`);
}

async function main() {
  const opts = parseArgs();
  const chunkSizes = opts.chunkSizes ?? DEFAULTS.chunkSizes;
  const warmup = opts.warmup ?? DEFAULTS.warmup;
  const iterations = opts.iterations ?? DEFAULTS.iterations;
  const highWaterMark = opts.highWaterMark ?? DEFAULTS.highWaterMark;
  const baseTotalBytes = opts.totalBytes ?? DEFAULTS.totalBytes;

  // Determine which scenarios to run
  let scenariosToRun;
  if (opts.scenario) {
    const scenario = scenarioMap.get(opts.scenario);
    if (!scenario) {
      console.error(`Unknown scenario: ${opts.scenario}`);
      console.error(`Available: ${scenarioNames.join(', ')}`);
      process.exit(1);
    }
    scenariosToRun = [scenario];
  } else {
    scenariosToRun = [...scenarioMap.values()];
  }

  // Check for --expose-gc
  if (typeof globalThis.gc !== 'function') {
    console.warn('Warning: --expose-gc not set. GC metrics will be unavailable.');
    console.warn('Run with: node --expose-gc bench/run.js\n');
  }

  console.log('Benchmark Configuration:');
  console.log(`  Scenarios: ${scenariosToRun.map((s) => s.name).join(', ')}`);
  console.log(`  Chunk sizes: ${chunkSizes.map(formatBytes).join(', ')}`);
  console.log(`  Iterations: ${iterations} (warmup: ${warmup})`);
  console.log(`  HWM: ${formatBytes(highWaterMark)}`);
  console.log(`  Total data: ${formatBytes(baseTotalBytes)}`);
  console.log('');

  const allResults = [];

  for (const scenario of scenariosToRun) {
    console.log(`\n[${'='.repeat(60)}]`);
    console.log(`Scenario: ${scenario.name}`);
    console.log(`  ${scenario.description}`);

    // CLI --total-bytes overrides REDUCED_TOTAL; REDUCED_TOTAL overrides DEFAULTS
    const totalBytes = opts.totalBytes != null ? baseTotalBytes : (REDUCED_TOTAL[scenario.name] ?? baseTotalBytes);
    if (totalBytes !== baseTotalBytes) {
      console.log(`  (using reduced total: ${formatBytes(totalBytes)})`);
    }

    const chunkFilter = CHUNK_FILTERS[scenario.name];

    for (const chunkSize of chunkSizes) {
      // Smart filtering
      if (chunkFilter && !chunkFilter(chunkSize)) {
        console.log(`\n  Skipping ${formatBytes(chunkSize)} (filtered for ${scenario.name})`);
        continue;
      }

      // Ensure totalBytes is a multiple of chunkSize
      const adjustedTotal = Math.floor(totalBytes / chunkSize) * chunkSize;
      if (adjustedTotal === 0) {
        console.log(`\n  Skipping ${formatBytes(chunkSize)} (chunk > totalBytes)`);
        continue;
      }

      console.log(`\n  Chunk size: ${formatBytes(chunkSize)} (${(adjustedTotal / chunkSize).toLocaleString()} chunks)`);

      const variantResults = await runScenario(scenario, {
        chunkSize,
        totalBytes: adjustedTotal,
        highWaterMark,
        warmup,
        iterations,
      });

      if (!opts.jsonOnly) {
        printTable(scenario.name, chunkSize, variantResults);
      }

      allResults.push({
        scenario: scenario.name,
        chunkSize,
        variants: variantResults,
      });

      // Breathe between chunk sizes
      forceGC();
    }
  }

  // Write output files
  console.log('\n' + '='.repeat(62));
  const jsonPath = await writeJSON(allResults, RESULTS_DIR);
  console.log(`JSON results: ${jsonPath}`);

  if (!opts.noMarkdown) {
    const mdPath = await writeMarkdown(allResults, RESULTS_DIR);
    console.log(`Markdown report: ${mdPath}`);
  }

  console.log('\nDone.');
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${bytes / (1024 * 1024)}MB`;
  if (bytes >= 1024) return `${bytes / 1024}KB`;
  return `${bytes}B`;
}

main().catch((err) => {
  console.error('\nBenchmark failed:', err);
  process.exit(1);
});
