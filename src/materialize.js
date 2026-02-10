/**
 * Tier 2 delegation: convert Fast streams to native WHATWG streams
 * using Node.js built-in Readable.toWeb() / Writable.toWeb().
 */

import { Readable, Writable } from 'node:stream';
import { NativeReadableStream } from './natives.js';
import { kMaterialized, kNodeReadable, kNodeWritable, _stats } from './utils.js';

export function materializeReadable(fastReadable) {
  if (fastReadable[kMaterialized]) return fastReadable[kMaterialized];
  _stats.tier2_materializeReadable++;

  // kNodeReadable may be null for native-only streams (byte, custom size)
  const nodeReadable = fastReadable[kNodeReadable];
  if (!nodeReadable) {
    throw new Error('Cannot materialize: no Node readable (native-only stream should already have kMaterialized)');
  }

  const native = Readable.toWeb(nodeReadable);
  fastReadable[kMaterialized] = native;
  return native;
}

/**
 * Convert a typed array or DataView to Uint8Array (byte stream spec requirement).
 */
function toUint8Array(chunk) {
  if (chunk instanceof Uint8Array) return chunk;
  if (ArrayBuffer.isView(chunk)) return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
  return chunk;
}

/**
 * Materialize a fast byte stream as a native byte stream (type: 'bytes').
 * Uses dual-write: hooks the fast controller's enqueue/close/error to also
 * operate on the native byte controller. This gives the native stream the
 * same data as the Node readable, enabling BYOB reads, tee, and byobRequest.
 * No pull bridge — data flows via the fast controller hooks.
 */
export function materializeReadableAsBytes(fastReadable) {
  if (fastReadable[kMaterialized]) return fastReadable[kMaterialized];
  _stats.tier2_materializeReadable++;

  const nodeReadable = fastReadable[kNodeReadable];
  if (!nodeReadable) {
    throw new Error('Cannot materialize as bytes: no Node readable');
  }

  const ctrl = fastReadable._controller;
  let nativeCtrl = null;

  const nativeSource = {
    type: 'bytes',
    start(controller) {
      nativeCtrl = controller;
      // If the fast stream is already errored, propagate to native
      if (fastReadable._errored) {
        controller.error(fastReadable._storedError);
        return;
      }
      // Drain any data already buffered in the Node readable
      let chunk;
      while ((chunk = nodeReadable.read()) !== null) {
        controller.enqueue(toUint8Array(chunk));
      }
      // Check if stream already ended (close was called before materialization)
      if (nodeReadable._readableState && nodeReadable._readableState.ended) {
        controller.close();
      }
    },
    cancel(reason) {
      return fastReadable._cancelInternal(reason);
    },
  };

  // Pull handoff: if the fast stream has a pull function, disable LiteReadable's
  // _onRead (demand-driven pull) and add a native pull that calls the user's pull
  // with the fast controller. This ensures a single pull coordinator — native pull
  // drives demand, data flows through dual-write hooks (enqueue → both controllers).
  if (fastReadable._pullFn) {
    // Disable LiteReadable demand-driven pull
    if (nodeReadable._onRead !== undefined) nodeReadable._onRead = null;

    const userSource = fastReadable._byteSource;
    nativeSource.pull = () => {
      // Don't call user's pull if stream is errored or closed
      if (fastReadable._errored || fastReadable._closed) return;
      return Reflect.apply(userSource.pull, userSource, [ctrl]);
    };
  }

  const native = new NativeReadableStream(nativeSource);

  // Hook fast controller to dual-write into the native byte controller.
  // This ensures enqueue/close/error go directly to both the Node readable
  // (for fast default reader) and the native byte stream (for BYOB/tee).
  if (ctrl && nativeCtrl) {
    const proto = Object.getPrototypeOf(ctrl);
    const origEnqueue = proto.enqueue;
    const origClose = proto.close;
    const origError = proto.error;

    ctrl.enqueue = function(chunk) {
      origEnqueue.call(this, chunk);
      try { nativeCtrl.enqueue(toUint8Array(chunk)); } catch {}
    };
    ctrl.close = function() {
      origClose.call(this);
      try { nativeCtrl.close(); } catch {}
    };
    ctrl.error = function(e) {
      origError.call(this, e);
      try { nativeCtrl.error(e); } catch {}
    };

    // Proxy byobRequest from native byte controller (own property, not on prototype)
    // Return null (not undefined) when no BYOB read is pending, per spec
    Object.defineProperty(ctrl, 'byobRequest', {
      get() { return nativeCtrl.byobRequest || null; },
      configurable: true,
    });
  }

  fastReadable[kMaterialized] = native;
  return native;
}

export function materializeWritable(fastWritable) {
  if (fastWritable[kMaterialized]) return fastWritable[kMaterialized];
  _stats.tier2_materializeWritable++;

  const nodeWritable = fastWritable[kNodeWritable];
  if (!nodeWritable) {
    throw new Error('Cannot materialize: no Node writable');
  }

  const native = Writable.toWeb(nodeWritable);
  fastWritable[kMaterialized] = native;
  return native;
}
