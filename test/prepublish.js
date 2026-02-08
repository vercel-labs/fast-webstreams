#!/usr/bin/env node

/**
 * Prepublish check: runs patch tests + WPT fast suite and enforces a minimum pass threshold.
 * Exits non-zero if patch tests fail or WPT pass rate drops below the threshold.
 */

import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const WPT_MIN_PASS = 1090; // current known-good: 1090/1116
const WPT_TOTAL = 1116;

let failed = false;

// 1. Unit tests (test/*.test.js)
console.log('=== Unit tests ===');
try {
  execFileSync('node', ['--test', 'test/*.test.js'], { cwd: ROOT, stdio: 'inherit', shell: true });
  console.log('Unit tests: PASS\n');
} catch {
  console.error('Unit tests: FAIL\n');
  failed = true;
}

// 2. WPT fast mode
console.log('=== WPT (fast) ===');
try {
  const out = execFileSync('node', ['test/run-wpt.js', '--mode=fast'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 180_000,
  });
  process.stdout.write(out);

  // Parse pass count from output: "Passed: <ANSI>N<ANSI>"
  const match = out.match(/Passed:\s*(?:\x1b\[\d+m)?(\d+)/);
  const passed = match ? parseInt(match[1], 10) : 0;

  if (passed < WPT_MIN_PASS) {
    console.error(`\nWPT FAIL: ${passed}/${WPT_TOTAL} (minimum: ${WPT_MIN_PASS})`);
    failed = true;
  } else {
    console.log(`\nWPT PASS: ${passed}/${WPT_TOTAL} (threshold: ${WPT_MIN_PASS})`);
  }
} catch (err) {
  console.error('WPT runner failed:', err.message);
  failed = true;
}

if (failed) {
  process.exit(1);
}
