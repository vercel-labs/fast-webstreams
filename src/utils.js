// Symbols for internal state (non-enumerable, unforgeable)
export const kNodeReadable  = Symbol('kNodeReadable');
export const kNodeWritable  = Symbol('kNodeWritable');
export const kNodeTransform = Symbol('kNodeTransform');
export const kState         = Symbol('kState');
export const kLock          = Symbol('kLock');
export const kMaterialized  = Symbol('kMaterialized');
export const kUpstream      = Symbol('kUpstream');
export const kNativeOnly    = Symbol('kNativeOnly');

// Instance checks
export const isFastReadable  = (s) => s != null && kNodeReadable in s;
export const isFastWritable  = (s) => s != null && kNodeWritable in s;
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
