/**
 * Controller adapters that bridge WHATWG controller API to Node stream internals.
 */

/**
 * ReadableStreamDefaultController adapter.
 * Wraps a Node.js Readable so that WHATWG underlyingSource callbacks
 * can use the familiar controller.enqueue/close/error API.
 */
// Sentinel for wrapping falsy error values that Node.js would lose
const kWrappedError = Symbol('kWrappedError');

export class FastReadableStreamDefaultController {
  #nodeReadable;
  #closed = false;
  #errored = false;
  #originalHWM;

  constructor(nodeReadable, originalHWM) {
    this.#nodeReadable = nodeReadable;
    // Fix 8: Track original HWM for Infinity handling
    this.#originalHWM = originalHWM !== undefined ? originalHWM : nodeReadable.readableHighWaterMark;
  }

  enqueue(chunk) {
    if (this.#errored) {
      throw new TypeError('Cannot enqueue to an errored stream');
    }
    if (this.#closed) {
      throw new TypeError('Cannot enqueue to a closed stream');
    }
    this.#nodeReadable.push(chunk);
  }

  close() {
    if (this.#errored) {
      throw new TypeError('Cannot close an errored stream');
    }
    if (this.#closed) {
      throw new TypeError('Cannot close an already closed stream');
    }
    this.#closed = true;
    const r = this.#nodeReadable;
    r.push(null);
    if (r.readableLength === 0) {
      r.resume();
    }
  }

  error(e) {
    if (this.#errored) return;
    this.#errored = true;
    // Node.js treats destroy(undefined/null/falsy) as destroy() (no error),
    // so wrap falsy values in an object that preserves the original
    if (e == null || e === false || e === 0 || e === '') {
      const wrapped = new Error('wrapped');
      wrapped[kWrappedError] = e;
      this.#nodeReadable.destroy(wrapped);
    } else {
      this.#nodeReadable.destroy(e);
    }
  }

  get desiredSize() {
    if (this.#errored) return null;
    if (this.#closed) return 0;
    const r = this.#nodeReadable;
    if (this.#originalHWM === Infinity) {
      return Infinity;
    }
    return this.#originalHWM - r.readableLength;
  }
}

export { kWrappedError };

/**
 * TransformStreamDefaultController adapter.
 * Wraps a Node.js Transform so that WHATWG transformer callbacks
 * can use controller.enqueue/error/terminate.
 */
export class FastTransformStreamDefaultController {
  #nodeTransform;
  #terminated = false;

  constructor(nodeTransform) {
    this.#nodeTransform = nodeTransform;
  }

  enqueue(chunk) {
    if (this.#terminated) {
      throw new TypeError('Cannot enqueue after terminate');
    }
    this.#nodeTransform.push(chunk);
  }

  error(e) {
    this.#terminated = true;
    this.#nodeTransform.destroy(e);
  }

  terminate() {
    if (this.#terminated) return;
    this.#terminated = true;
    this.#nodeTransform.push(null);
  }

  get desiredSize() {
    const t = this.#nodeTransform;
    if (this.#terminated) return 0;
    return t.readableHighWaterMark - t.readableLength;
  }
}

/**
 * WritableStreamDefaultController adapter.
 * Minimal controller passed to underlyingSink.start().
 */
export class FastWritableStreamDefaultController {
  #nodeWritable;
  #abortController;

  constructor(nodeWritable) {
    this.#nodeWritable = nodeWritable;
    this.#abortController = new AbortController();

    // When the Node writable is destroyed (abort), signal the AbortController
    nodeWritable.on('close', () => {
      if (nodeWritable.errored && !this.#abortController.signal.aborted) {
        this.#abortController.abort(nodeWritable.errored);
      }
    });
  }

  error(e) {
    this.#nodeWritable.destroy(e);
  }

  get signal() {
    return this.#abortController.signal;
  }
}
