/**
 * Capture references to the original native stream constructors BEFORE
 * any monkey-patching can occur. All internal code that needs the real
 * native constructors (for delegation, instanceof checks, etc.) must
 * import from this module instead of using bare globals.
 */

export const NativeReadableStream = globalThis.ReadableStream;
export const NativeWritableStream = globalThis.WritableStream;
export const NativeTransformStream = globalThis.TransformStream;
export const NativeByteLengthQueuingStrategy = globalThis.ByteLengthQueuingStrategy;
export const NativeCountQueuingStrategy = globalThis.CountQueuingStrategy;
