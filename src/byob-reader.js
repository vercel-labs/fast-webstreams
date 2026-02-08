/**
 * FastReadableStreamBYOBReader — wraps native ReadableStreamBYOBReader
 * to accept FastReadableStream instances (materializes to native first).
 */

import { materializeReadable } from './materialize.js';
import { NativeReadableStream } from './natives.js';
import { isFastReadable } from './utils.js';

// Get the native BYOB reader constructor
const NativeBYOBReader = new NativeReadableStream({ type: 'bytes' }).getReader({ mode: 'byob' }).constructor;

/**
 * BYOB reader that accepts both native ReadableStream and FastReadableStream.
 * For FastReadableStream, materializes to native before constructing.
 */
export class FastReadableStreamBYOBReader extends NativeBYOBReader {
  constructor(stream) {
    if (isFastReadable(stream)) {
      super(materializeReadable(stream));
    } else {
      super(stream);
    }
  }
}
