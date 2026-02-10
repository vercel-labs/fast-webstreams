/**
 * FastReadableStreamBYOBReader — wraps native ReadableStreamBYOBReader
 * to accept FastReadableStream instances (materializes to native first).
 */

import { materializeReadable, materializeReadableAsBytes } from './materialize.js';
import { NativeReadableStream } from './natives.js';
import { isFastReadable, kLock, kNativeOnly } from './utils.js';

// Get the native BYOB reader constructor
const NativeBYOBReader = new NativeReadableStream({ type: 'bytes' }).getReader({ mode: 'byob' }).constructor;

/**
 * BYOB reader that accepts both native ReadableStream and FastReadableStream.
 * For FastReadableStream, materializes to native before constructing.
 * For fast byte streams, materializes as a native byte stream (not default-type).
 */
export class FastReadableStreamBYOBReader extends NativeBYOBReader {
  constructor(stream) {
    if (isFastReadable(stream)) {
      if (stream._isByteStream && !stream[kNativeOnly]) {
        // Check lock on the fast stream (native stream is freshly created, always unlocked)
        if (stream[kLock]) {
          throw new TypeError('Cannot construct a ReadableStreamBYOBReader for a locked ReadableStream');
        }
        super(materializeReadableAsBytes(stream));
      } else {
        super(materializeReadable(stream));
      }
    } else {
      super(stream);
    }
  }
}
