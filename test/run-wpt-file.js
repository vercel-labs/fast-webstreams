#!/usr/bin/env node

/**
 * Runs a single WPT test file and outputs JSON results to stdout.
 * Designed to be spawned as a subprocess by run-wpt.js.
 *
 * Usage: node test/run-wpt-file.js <mode> <testFile>
 */

import { createContext, runInContext } from 'node:vm';
import { readFileSync } from 'node:fs';
import { resolve, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHarnessGlobals } from './wpt-harness.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WPT_ROOT = resolve(__dirname, '..', 'vendor', 'wpt', 'streams');

process.on('unhandledRejection', (e) => { console.error('unhandledRejection', e); });
process.on('uncaughtException', (e) => { console.error('uncaughtException', e); });

const TEST_TIMEOUT = 2000;

const mode = process.argv[2];
const testFile = process.argv[3];

async function run() {
  const relPath = relative(WPT_ROOT, testFile);
  const testDir = dirname(testFile);
  const content = readFileSync(testFile, 'utf8');

  // Parse META scripts
  const metaScripts = [];
  for (const line of content.split('\n')) {
    const match = line.match(/^\/\/\s*META:\s*script=(.+)$/);
    if (match) metaScripts.push(resolve(testDir, match[1].trim()));
    if (!line.startsWith('//') && line.trim() !== '' && !line.startsWith("'use strict'")) break;
  }

  // Get stream globals
  let streamGlobals;
  if (mode === 'native') {
    streamGlobals = {
      ReadableStream: globalThis.ReadableStream,
      WritableStream: globalThis.WritableStream,
      TransformStream: globalThis.TransformStream,
    };
  } else {
    const { FastReadableStream, FastWritableStream, FastTransformStream, FastReadableStreamDefaultReader, FastWritableStreamDefaultWriter } = await import('../src/index.js');
    streamGlobals = {
      ReadableStream: FastReadableStream,
      WritableStream: FastWritableStream,
      TransformStream: FastTransformStream,
      ReadableStreamDefaultReader: FastReadableStreamDefaultReader,
      WritableStreamDefaultWriter: FastWritableStreamDefaultWriter,
    };
  }

  const { globals, tests } = createHarnessGlobals(streamGlobals);
  const ctx = createContext(globals);
  ctx.self = ctx;

  // Load META scripts
  for (const script of metaScripts) {
    try {
      runInContext(readFileSync(script, 'utf8'), ctx, { filename: script, timeout: 5000 });
    } catch (err) {
      output({ file: relPath, passed: 0, failed: 1, total: 1, errors: [`META load failed: ${err.message}`] });
      return;
    }
  }

  // Run test file
  try {
    runInContext(content, ctx, { filename: testFile, timeout: 5000 });
  } catch (err) {
    output({ file: relPath, passed: 0, failed: 1, total: 1, errors: [`Execute failed: ${err.message}`] });
    return;
  }

  // Execute collected tests
  let passed = 0;
  let failed = 0;
  const errors = [];

  for (const t of tests) {
    try {
      if (t.type === 'sync') {
        const testObj = {
          step(fn) { fn(); },
          step_func(fn) { return fn; },
          step_func_done(fn) { return fn || (() => {}); },
          unreached_func(msg) { return () => { throw new Error(`unreached: ${msg}`); }; },
          step_timeout: setTimeout,
          add_cleanup() {},
        };
        t.fn(testObj);
        passed++;
      } else if (t.type === 'promise') {
        const cleanups = [];
        const testObj = {
          step(fn) { fn(); },
          step_func(fn) { return fn; },
          step_func_done(fn) { return fn || (() => {}); },
          unreached_func(msg) { return () => { throw new Error(`unreached: ${msg}`); }; },
          step_timeout: setTimeout,
          add_cleanup(fn) { cleanups.push(fn); },
        };
        try {
          await Promise.race([
            Promise.resolve(t.fn(testObj)),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), TEST_TIMEOUT)),
          ]);
        } finally {
          for (const fn of cleanups) { try { fn(); } catch {} }
        }
        passed++;
      } else if (t.type === 'async') {
        await Promise.race([
          t.donePromise,
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), TEST_TIMEOUT)),
        ]);
        passed++;
      }
    } catch (err) {
      failed++;
      errors.push(`${t.description}: ${err?.message ?? String(err)}`);
    }
  }

  output({ file: relPath, passed, failed, total: tests.length, errors });
}

function output(result) {
  process.stdout.write(JSON.stringify(result) + '\n');
}

run().then(() => {
  // Force exit after a short delay to avoid hanging on open handles
  setTimeout(() => process.exit(0), 100);
});
