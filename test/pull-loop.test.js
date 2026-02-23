/**
 * Tests for async pull microtask loop bug.
 *
 * When a default-type (non-byte) ReadableStream has an async pull function,
 * the .then() handler on the pull promise unconditionally calls
 * nodeReadable.read(0), which triggers _read → pullFn → pull again.
 * This creates a tight microtask loop that starves the event loop.
 *
 * Per the WHATWG spec, pull should only be re-called after resolution if
 * there was explicit demand during the previous pull (tracked via pullAgain).
 * Unconditionally calling read(0) bypasses this demand check.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FastReadableStream } from '../src/index.js';

describe('async pull microtask loop', () => {
  it('async pull that resolves without enqueue should not loop', { timeout: 5000 }, async () => {
    // A pull function that returns a resolved promise but does NOT enqueue
    // anything. Per spec, pull should be called once (initial auto-pull after
    // start), then NOT called again until there is explicit consumer demand
    // (e.g., reader.read() or enqueue triggers desiredSize recalculation).
    //
    // BUG: The .then() handler on the pull promise unconditionally calls
    // read(0), which triggers _read → pullFn → pull again, creating an
    // infinite microtask loop.
    let pullCount = 0;
    const MAX_PULLS = 100; // Safety valve to prevent true infinite hang

    const rs = new FastReadableStream({
      async pull(controller) {
        pullCount++;
        if (pullCount >= MAX_PULLS) {
          // Safety valve: close the stream so microtask chain terminates
          controller.close();
        }
        // Intentionally does NOT enqueue — simulates waiting for external data
      },
    });

    // Wait for macrotask — if microtask loop is spinning, this setTimeout
    // won't fire until the safety valve breaks the chain.
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Correct behavior: pull is called once for the initial auto-pull after
    // start completes. Since nothing was enqueued and no reader.read() was
    // called, pull should NOT be called again.
    //
    // With the bug: pull is called MAX_PULLS times because the .then()
    // handler unconditionally calls read(0) → _read → pullFn → pull → ...
    assert.ok(
      pullCount < 5,
      `Expected pull to be called <5 times (initial auto-pull only), ` +
        `but was called ${pullCount} times — microtask loop detected`
    );
  });

  it('async pull with enqueue and default HWM should not over-pull', { timeout: 5000 }, async () => {
    // With default HWM=1, after enqueuing one chunk the buffer is full
    // (desiredSize=0). Pull should NOT be called again until the consumer
    // reads and frees buffer space.
    let pullCount = 0;
    const MAX_PULLS = 100;

    const rs = new FastReadableStream({
      async pull(controller) {
        pullCount++;
        if (pullCount >= MAX_PULLS) {
          controller.close();
          return;
        }
        controller.enqueue(`chunk-${pullCount}`);
      },
    });

    // Wait for initial auto-pull to complete
    await new Promise((resolve) => setTimeout(resolve, 100));

    // With HWM=1: after enqueuing one chunk, the buffer is full.
    // Node's Readable.read(0) checks state.length < state.highWaterMark
    // (1 < 1 = false) and does NOT call _read. So pull should only be
    // called once for the initial auto-pull.
    //
    // If this assertion fails, the .then() handler is calling read(0)
    // in a way that bypasses Node's flow control.
    assert.ok(
      pullCount < 5,
      `Expected pull to be called <5 times with HWM=1 and buffer full, ` +
        `but was called ${pullCount} times`
    );

    // Verify data is correct when we do read
    const reader = rs.getReader();
    const { value } = await reader.read();
    assert.strictEqual(value, 'chunk-1');
    reader.releaseLock();
  });

  it('async pull with high HWM should not starve the event loop', { timeout: 5000 }, async () => {
    // With a high HWM (Infinity), the buffer never fills, so desiredSize
    // is always > 0. Per spec, pull IS called eagerly (each enqueue triggers
    // pullAgain), but it must not create a tight microtask-only loop that
    // prevents macrotasks from running.
    let pullCount = 0;
    const MAX_PULLS = 1000;

    const rs = new FastReadableStream(
      {
        async pull(controller) {
          pullCount++;
          if (pullCount >= MAX_PULLS) {
            controller.close();
            return;
          }
          controller.enqueue(`chunk-${pullCount}`);
        },
      },
      new CountQueuingStrategy({ highWaterMark: Infinity })
    );

    // Schedule a macrotask check
    let macrotaskRan = false;
    setTimeout(() => {
      macrotaskRan = true;
    }, 0);

    // Wait for a macrotask to confirm event loop is not starved
    await new Promise((resolve) => setTimeout(resolve, 200));

    // The setTimeout(0) callback should have fired. If it didn't, the
    // microtask loop prevented macrotasks from running.
    assert.ok(
      macrotaskRan,
      `setTimeout(0) callback never fired — event loop was starved by microtask loop ` +
        `(pull was called ${pullCount} times)`
    );
  });
});
