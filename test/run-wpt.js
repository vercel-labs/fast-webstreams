#!/usr/bin/env node

/**
 * WPT (Web Platform Tests) runner for WHATWG Streams.
 * Runs each test file in its own subprocess for isolation and reliable timeouts.
 *
 * Usage:
 *   node test/run-wpt.js --mode=native                              # Baseline
 *   node test/run-wpt.js --mode=fast                                # Our impl
 *   node test/run-wpt.js --mode=fast --filter=readable-streams      # Subset
 *   node test/run-wpt.js --mode=native --filter=piping/pipe-through # Specific
 */

import { execFile } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { resolve, relative, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WPT_ROOT = resolve(__dirname, '..', 'vendor', 'wpt', 'streams');
const RUNNER = resolve(__dirname, 'run-wpt-file.js');

const FILE_TIMEOUT = 30000; // 30s per file subprocess (some files have 60+ tests)

const SKIP_FILES = new Set([
  'idlharness.any.js',
  'transferable/transform-stream-members.any.js',
  'readable-streams/owning-type-video-frame.any.js',
  'readable-streams/owning-type-message-port.any.js',
  'readable-byte-streams/patched-global.any.js',
  'readable-streams/patched-global.any.js',
  'transform-streams/patched-global.any.js',
  'readable-streams/garbage-collection.any.js',
  'readable-streams/crashtests/garbage-collection.any.js',
  'writable-streams/garbage-collection.any.js',
  'writable-streams/crashtests/garbage-collection.any.js',
  'readable-byte-streams/construct-byob-request.any.js',
]);

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { mode: 'native', filter: null, verbose: false, concurrency: 4 };
  for (const arg of args) {
    const match = arg.match(/^--([a-z-]+)(?:=(.+))?$/);
    if (!match) { console.error(`Unknown argument: ${arg}`); process.exit(1); }
    const [, key, value] = match;
    switch (key) {
      case 'mode': opts.mode = value; break;
      case 'filter': opts.filter = value; break;
      case 'verbose': opts.verbose = true; break;
      case 'concurrency': opts.concurrency = parseInt(value, 10); break;
      default: console.error(`Unknown flag: --${key}`); process.exit(1);
    }
  }
  return opts;
}

function findTestFiles(dir) {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) results.push(...findTestFiles(fullPath));
    else if (entry.name.endsWith('.any.js')) results.push(fullPath);
  }
  return results.sort();
}

function runFileInSubprocess(mode, testFile) {
  return new Promise((resolve) => {
    const child = execFile('node', [RUNNER, mode, testFile], {
      timeout: FILE_TIMEOUT,
      maxBuffer: 1024 * 1024,
    }, (err, stdout) => {
      const rel = relative(WPT_ROOT, testFile);
      if (err) {
        resolve({ file: rel, passed: 0, failed: 1, total: 1, errors: [err.killed ? 'Process killed (timeout)' : err.message] });
        return;
      }
      try {
        const result = JSON.parse(stdout.trim().split('\n').pop());
        resolve(result);
      } catch {
        resolve({ file: rel, passed: 0, failed: 1, total: 1, errors: ['Failed to parse output'] });
      }
    });
  });
}

async function main() {
  const opts = parseArgs();

  let testFiles = findTestFiles(WPT_ROOT);

  if (opts.filter) {
    testFiles = testFiles.filter((f) => relative(WPT_ROOT, f).includes(opts.filter));
  }

  testFiles = testFiles.filter((f) => {
    const rel = relative(WPT_ROOT, f);
    return !SKIP_FILES.has(rel) && ![...SKIP_FILES].some(skip => rel.endsWith(skip));
  });

  console.log(`WPT Streams Test Runner`);
  console.log(`  Mode: ${opts.mode}`);
  console.log(`  Test files: ${testFiles.length}`);
  console.log(`  Concurrency: ${opts.concurrency}`);
  if (opts.filter) console.log(`  Filter: ${opts.filter}`);
  console.log('');

  let totalPassed = 0;
  let totalFailed = 0;
  let totalTests = 0;
  let filesWithFailures = 0;

  // Run files with limited concurrency
  let idx = 0;
  const results = [];

  async function worker() {
    while (idx < testFiles.length) {
      const i = idx++;
      const result = await runFileInSubprocess(opts.mode, testFiles[i]);
      results[i] = result;
    }
  }

  const workers = [];
  for (let w = 0; w < opts.concurrency; w++) workers.push(worker());
  await Promise.all(workers);

  // Print results in order
  for (const result of results) {
    totalPassed += result.passed;
    totalFailed += result.failed;
    totalTests += result.total;

    const status = result.failed === 0 ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
    console.log(`${status} ${result.file} (${result.passed}/${result.total})`);

    if (result.failed > 0) {
      filesWithFailures++;
      if (opts.verbose) {
        for (const err of result.errors) console.log(`    ${err}`);
      } else if (result.errors.length > 0) {
        for (const err of result.errors.slice(0, 2)) console.log(`    ${err}`);
        if (result.errors.length > 2) console.log(`    ... and ${result.errors.length - 2} more`);
      }
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log(`Results (${opts.mode} mode):`);
  console.log(`  Total tests: ${totalTests}`);
  console.log(`  Passed: \x1b[32m${totalPassed}\x1b[0m`);
  console.log(`  Failed: \x1b[31m${totalFailed}\x1b[0m`);
  console.log(`  Pass rate: ${totalTests > 0 ? ((totalPassed / totalTests) * 100).toFixed(1) : 0}%`);
  console.log(`  Files with failures: ${filesWithFailures}/${testFiles.length}`);

  if (opts.mode === 'native' && totalFailed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('WPT runner failed:', err);
  process.exit(1);
});
