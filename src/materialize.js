/**
 * Tier 2 delegation: convert Fast streams to native WHATWG streams
 * using Node.js built-in Readable.toWeb() / Writable.toWeb().
 */

import { Readable, Writable } from 'node:stream';
import { kNodeReadable, kNodeWritable, kMaterialized } from './utils.js';

export function materializeReadable(fastReadable) {
  if (fastReadable[kMaterialized]) return fastReadable[kMaterialized];

  // kNodeReadable may be null for native-only streams (byte, custom size)
  const nodeReadable = fastReadable[kNodeReadable];
  if (!nodeReadable) {
    throw new Error('Cannot materialize: no Node readable (native-only stream should already have kMaterialized)');
  }

  const native = Readable.toWeb(nodeReadable);
  fastReadable[kMaterialized] = native;
  return native;
}

export function materializeWritable(fastWritable) {
  if (fastWritable[kMaterialized]) return fastWritable[kMaterialized];

  const nodeWritable = fastWritable[kNodeWritable];
  if (!nodeWritable) {
    throw new Error('Cannot materialize: no Node writable');
  }

  const native = Writable.toWeb(nodeWritable);
  fastWritable[kMaterialized] = native;
  return native;
}
