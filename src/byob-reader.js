/**
 * FastReadableStreamBYOBReader — wraps native ReadableStreamBYOBReader
 * to accept FastReadableStream instances (materializes to native first).
 */

import { isFastReadable } from './utils.js';
import { materializeReadable } from './materialize.js';

// Get the native BYOB reader constructor
const NativeBYOBReader = new ReadableStream({ type: 'bytes' }).getReader({ mode: 'byob' }).constructor;

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
