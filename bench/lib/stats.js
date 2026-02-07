/**
 * Pure math utilities for benchmark statistics.
 * Zero dependencies — all calculations done inline.
 */

export function mean(arr) {
  if (arr.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < arr.length; i++) sum += arr[i];
  return sum / arr.length;
}

export function median(arr) {
  if (arr.length === 0) return 0;
  const sorted = arr.slice().sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length & 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function stddev(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  let sumSq = 0;
  for (let i = 0; i < arr.length; i++) {
    const d = arr[i] - m;
    sumSq += d * d;
  }
  // Bessel's correction (n-1) for sample stddev
  return Math.sqrt(sumSq / (arr.length - 1));
}

export function sem(arr) {
  if (arr.length < 2) return 0;
  return stddev(arr) / Math.sqrt(arr.length);
}

export function min(arr) {
  if (arr.length === 0) return 0;
  let v = arr[0];
  for (let i = 1; i < arr.length; i++) if (arr[i] < v) v = arr[i];
  return v;
}

export function max(arr) {
  if (arr.length === 0) return 0;
  let v = arr[0];
  for (let i = 1; i < arr.length; i++) if (arr[i] > v) v = arr[i];
  return v;
}

export function percentile(arr, p) {
  if (arr.length === 0) return 0;
  const sorted = arr.slice().sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const frac = idx - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

/**
 * Welch's t-test for two independent samples with potentially unequal variances.
 * Returns { t, df, significant } where significant is true at p < 0.05.
 */
export function welchTTest(a, b) {
  const nA = a.length;
  const nB = b.length;
  if (nA < 2 || nB < 2) return { t: 0, df: 0, significant: false };

  const mA = mean(a);
  const mB = mean(b);
  const vA = variance(a);
  const vB = variance(b);
  const sA = vA / nA;
  const sB = vB / nB;

  const denom = Math.sqrt(sA + sB);
  if (denom === 0) return { t: 0, df: nA + nB - 2, significant: false };

  const t = (mA - mB) / denom;

  // Welch–Satterthwaite degrees of freedom
  const num = (sA + sB) ** 2;
  const den = (sA ** 2) / (nA - 1) + (sB ** 2) / (nB - 1);
  const df = den === 0 ? nA + nB - 2 : num / den;

  // Two-tailed critical t-values for p < 0.05 (approximation for df >= 2)
  // Using the approximation: t_crit ≈ 1.96 + 2.4/df for large df
  const tCrit = df >= 120 ? 1.96 : tCriticalApprox(df);

  return { t, df, significant: Math.abs(t) > tCrit };
}

/**
 * Approximate two-tailed t critical value at p=0.05.
 * Uses a rational approximation accurate to ~0.01 for df >= 2.
 */
function tCriticalApprox(df) {
  // Table-based for small df, approximation for larger
  const table = [
    0,       // df=0 (unused)
    12.706,  // df=1
    4.303,   // df=2
    3.182,   // df=3
    2.776,   // df=4
    2.571,   // df=5
    2.447,   // df=6
    2.365,   // df=7
    2.306,   // df=8
    2.262,   // df=9
    2.228,   // df=10
    2.201,   // df=11
    2.179,   // df=12
    2.160,   // df=13
    2.145,   // df=14
    2.131,   // df=15
    2.120,   // df=16
    2.110,   // df=17
    2.101,   // df=18
    2.093,   // df=19
    2.086,   // df=20
    2.080,   // df=21
    2.074,   // df=22
    2.069,   // df=23
    2.064,   // df=24
    2.060,   // df=25
    2.056,   // df=26
    2.052,   // df=27
    2.048,   // df=28
    2.045,   // df=29
    2.042,   // df=30
  ];

  const rounded = Math.round(df);
  if (rounded >= 1 && rounded <= 30) return table[rounded];
  if (rounded <= 40) return 2.021;
  if (rounded <= 60) return 2.000;
  if (rounded <= 120) return 1.980;
  return 1.960;
}

function variance(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  let sumSq = 0;
  for (let i = 0; i < arr.length; i++) {
    const d = arr[i] - m;
    sumSq += d * d;
  }
  return sumSq / (arr.length - 1);
}

/**
 * Compute summary statistics for an array of measurements.
 */
export function summarize(arr) {
  return {
    mean: mean(arr),
    median: median(arr),
    stddev: stddev(arr),
    sem: sem(arr),
    min: min(arr),
    max: max(arr),
    p95: percentile(arr, 95),
    p99: percentile(arr, 99),
    n: arr.length,
  };
}

/**
 * Compare two measurement arrays (a = baseline, b = candidate).
 * Returns ratio (b/a) and whether the difference is significant.
 */
export function compare(a, b) {
  const mA = mean(a);
  const mB = mean(b);
  const ratio = mA === 0 ? 0 : mB / mA;
  const test = welchTTest(a, b);

  // 95% CI for the ratio using delta method approximation
  const seA = sem(a);
  const seB = sem(b);
  const relSE = mA === 0 ? 0 : Math.sqrt((seB / mA) ** 2 + (mB * seA / (mA * mA)) ** 2);
  const ciLow = ratio - 1.96 * relSE;
  const ciHigh = ratio + 1.96 * relSE;

  return {
    ratio,
    ciLow,
    ciHigh,
    significant: test.significant,
    t: test.t,
    df: test.df,
  };
}
