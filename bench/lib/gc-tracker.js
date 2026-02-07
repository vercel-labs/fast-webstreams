/**
 * GC observation via PerformanceObserver and memory snapshot utilities.
 */

import { PerformanceObserver } from 'node:perf_hooks';

export class GCTracker {
  #entries = [];
  #observer = null;

  start() {
    this.#entries = [];
    this.#observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        this.#entries.push({
          kind: entry.detail?.kind ?? entry.flags,
          duration: entry.duration,
        });
      }
    });
    try {
      this.#observer.observe({ entryTypes: ['gc'] });
    } catch {
      // GC observation requires --expose-gc; silently degrade
      this.#observer = null;
    }
  }

  stop() {
    if (this.#observer) {
      this.#observer.disconnect();
      this.#observer = null;
    }
  }

  /**
   * Returns summary of GC activity since start().
   */
  summarize() {
    let count = 0;
    let totalPauseMs = 0;
    let majorCount = 0;
    let minorCount = 0;

    for (const e of this.#entries) {
      count++;
      totalPauseMs += e.duration;
      // GC kind flags: 1=minor/scavenge, 2=major/mark-sweep, 4=incremental, 8=weak
      if (e.kind === 2 || e.kind === 6) {
        majorCount++;
      } else {
        minorCount++;
      }
    }

    return { count, totalPauseMs, majorCount, minorCount };
  }

  reset() {
    this.#entries = [];
  }
}

/**
 * Take a memory snapshot using process.memoryUsage().
 */
export function memorySnapshot() {
  const mem = process.memoryUsage();
  return {
    rss: mem.rss,
    heapUsed: mem.heapUsed,
    heapTotal: mem.heapTotal,
    external: mem.external,
    arrayBuffers: mem.arrayBuffers,
  };
}

/**
 * Compute deltas between two memory snapshots.
 */
export function memoryDelta(before, after) {
  return {
    rssDelta: after.rss - before.rss,
    heapUsedDelta: after.heapUsed - before.heapUsed,
    heapTotalDelta: after.heapTotal - before.heapTotal,
    externalDelta: after.external - before.external,
    arrayBuffersDelta: after.arrayBuffers - before.arrayBuffers,
  };
}

/**
 * Force a full GC if --expose-gc was used. Returns true if GC was triggered.
 */
export function forceGC() {
  if (typeof globalThis.gc === 'function') {
    globalThis.gc();
    return true;
  }
  return false;
}
