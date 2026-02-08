// Symbols for internal state (non-enumerable, unforgeable)
export const kNodeReadable = Symbol('kNodeReadable');
export const kNodeWritable = Symbol('kNodeWritable');
export const kNodeTransform = Symbol('kNodeTransform');
export const kLock = Symbol('kLock');
export const kMaterialized = Symbol('kMaterialized');
export const kUpstream = Symbol('kUpstream');
export const kNativeOnly = Symbol('kNativeOnly');

// Writable state symbols (shared to avoid circular deps)
export const kWritableState = Symbol('kWritableState');
export const kStoredError = Symbol('kStoredError');

// Sentinel for cancel handlers to signal "don't destroy the node stream"
export const kSkipDestroy = Symbol('kSkipDestroy');

// Shared helpers
export const noop = () => {};
export const isThenable = (v) => v instanceof Promise || (v != null && typeof v.then === 'function');
export const RESOLVED_UNDEFINED = Promise.resolve(undefined);

// Instance checks
export const isFastReadable = (s) => s != null && kNodeReadable in s;
export const isFastWritable = (s) => s != null && kNodeWritable in s;
export const isFastTransform = (s) => s != null && kNodeTransform in s;

// Extract highWaterMark from a strategy, converting via ToNumber per spec.
// WHATWG default is CountQueuingStrategy with highWaterMark = 1.
export function resolveHWM(strategy, defaultHWM = 1) {
  if (!strategy) return defaultHWM;
  if (!('highWaterMark' in strategy)) return defaultHWM;
  const h = Number(strategy.highWaterMark);
  if (Number.isNaN(h) || h < 0) {
    throw new RangeError('Invalid highWaterMark');
  }
  return h;
}
