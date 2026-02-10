/**
 * WPT testharness.js polyfill for Node.js
 *
 * Provides all globals that WPT tests expect:
 * - test(), promise_test(), async_test()
 * - assert_equals, assert_true, assert_false, assert_throws_js, etc.
 * - self, step_timeout, delay, flushAsyncEvents
 */

/**
 * Create a harness environment with the given stream globals.
 * Returns an object of globals to inject into a VM context.
 */
export function createHarnessGlobals(streamGlobals) {
  const tests = [];
  let currentTestIndex = 0;

  // ---- Assertion helpers ----

  function formatMsg(msg) {
    return msg ? `: ${msg}` : '';
  }

  function assert_equals(a, b, msg) {
    if (!Object.is(a, b)) {
      throw new Error(`assert_equals: expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}${formatMsg(msg)}`);
    }
  }

  function assert_not_equals(a, b, msg) {
    if (Object.is(a, b)) {
      throw new Error(`assert_not_equals: values are equal${formatMsg(msg)}`);
    }
  }

  function assert_true(val, msg) {
    if (val !== true) {
      throw new Error(`assert_true: got ${JSON.stringify(val)}${formatMsg(msg)}`);
    }
  }

  function assert_false(val, msg) {
    if (val !== false) {
      throw new Error(`assert_false: got ${JSON.stringify(val)}${formatMsg(msg)}`);
    }
  }

  function assert_array_equals(a, b, msg) {
    if (!Array.isArray(a) && !ArrayBuffer.isView(a)) {
      throw new Error(`assert_array_equals: first argument is not array-like${formatMsg(msg)}`);
    }
    if (a.length !== b.length) {
      throw new Error(`assert_array_equals: lengths differ (${a.length} vs ${b.length})${formatMsg(msg)}`);
    }
    for (let i = 0; i < a.length; i++) {
      if (!Object.is(a[i], b[i])) {
        throw new Error(`assert_array_equals: mismatch at index ${i}${formatMsg(msg)}`);
      }
    }
  }

  function assert_object_equals(a, b, msg) {
    // Shallow property check
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) {
      throw new Error(`assert_object_equals: key count differs${formatMsg(msg)}`);
    }
    for (const key of keysA) {
      if (!Object.is(a[key], b[key])) {
        throw new Error(`assert_object_equals: mismatch at key "${key}": ${JSON.stringify(a[key])} vs ${JSON.stringify(b[key])}${formatMsg(msg)}`);
      }
    }
  }

  function assert_throws_js(Type, fn, msg) {
    let threw = false;
    try {
      fn();
    } catch (e) {
      threw = true;
      // Use constructor.name instead of instanceof to handle cross-realm errors
      // (V8 creates separate built-in error constructors per VM context)
      if (e?.constructor?.name !== Type.name) {
        throw new Error(`assert_throws_js: expected ${Type.name} but got ${e?.constructor?.name}: ${e?.message}${formatMsg(msg)}`);
      }
    }
    if (!threw) {
      throw new Error(`assert_throws_js: function did not throw${formatMsg(msg)}`);
    }
  }

  function assert_throws_exactly(val, fn, msg) {
    let threw = false;
    try {
      fn();
    } catch (e) {
      threw = true;
      if (e !== val) {
        throw new Error(`assert_throws_exactly: thrown value does not match${formatMsg(msg)}`);
      }
    }
    if (!threw) {
      throw new Error(`assert_throws_exactly: function did not throw${formatMsg(msg)}`);
    }
  }

  function assert_unreached(msg) {
    throw new Error(`assert_unreached: ${msg || 'should not have been reached'}`);
  }

  function assert_class_string(obj, expected, msg) {
    const actual = Object.prototype.toString.call(obj);
    const expectedStr = `[object ${expected}]`;
    if (actual !== expectedStr) {
      throw new Error(`assert_class_string: expected ${expectedStr} but got ${actual}${formatMsg(msg)}`);
    }
  }

  function assert_typeof(val, type, msg) {
    if (typeof val !== type) {
      throw new Error(`assert_typeof: expected ${type} but got ${typeof val}${formatMsg(msg)}`);
    }
  }

  function assert_in_array(val, arr, msg) {
    if (!arr.includes(val)) {
      throw new Error(`assert_in_array: ${JSON.stringify(val)} not in array${formatMsg(msg)}`);
    }
  }

  function assert_regexp_match(val, re, msg) {
    if (!re.test(val)) {
      throw new Error(`assert_regexp_match: ${JSON.stringify(val)} does not match ${re}${formatMsg(msg)}`);
    }
  }

  function assert_less_than(a, b, msg) {
    if (!(a < b)) {
      throw new Error(`assert_less_than: ${a} is not less than ${b}${formatMsg(msg)}`);
    }
  }

  function assert_greater_than(a, b, msg) {
    if (!(a > b)) {
      throw new Error(`assert_greater_than: ${a} is not greater than ${b}${formatMsg(msg)}`);
    }
  }

  function assert_less_than_equal(a, b, msg) {
    if (!(a <= b)) {
      throw new Error(`assert_less_than_equal: ${a} is not <= ${b}${formatMsg(msg)}`);
    }
  }

  function assert_greater_than_equal(a, b, msg) {
    if (!(a >= b)) {
      throw new Error(`assert_greater_than_equal: ${a} is not >= ${b}${formatMsg(msg)}`);
    }
  }

  async function promise_rejects_js(t, Type, promise, msg) {
    try {
      await promise;
      throw new Error(`promise_rejects_js: promise did not reject${formatMsg(msg)}`);
    } catch (e) {
      if (e instanceof Error && e.message.startsWith('promise_rejects_js:')) throw e;
      // Use constructor.name instead of instanceof to handle cross-realm errors
      if (e?.constructor?.name !== Type.name) {
        throw new Error(`promise_rejects_js: expected ${Type.name} but got ${e?.constructor?.name}: ${e?.message}${formatMsg(msg)}`);
      }
    }
  }

  async function promise_rejects_dom(t, name, promise, msg) {
    try {
      await promise;
      throw new Error(`promise_rejects_dom: promise did not reject${formatMsg(msg)}`);
    } catch (e) {
      if (e instanceof Error && e.message.startsWith('promise_rejects_dom:')) throw e;
      if (!(e instanceof DOMException)) {
        throw new Error(`promise_rejects_dom: expected DOMException but got ${e?.constructor?.name}: ${e?.message}${formatMsg(msg)}`);
      }
      if (e.name !== name) {
        throw new Error(`promise_rejects_dom: expected DOMException with name "${name}" but got "${e.name}"${formatMsg(msg)}`);
      }
    }
  }

  async function promise_rejects_exactly(t, val, promise, msg) {
    try {
      await promise;
      throw new Error(`promise_rejects_exactly: promise did not reject${formatMsg(msg)}`);
    } catch (e) {
      if (e instanceof Error && e.message.startsWith('promise_rejects_exactly:')) throw e;
      if (e !== val) {
        throw new Error(`promise_rejects_exactly: rejection value does not match expected${formatMsg(msg)}`);
      }
    }
  }

  // ---- Test registration ----

  function test(fn, description) {
    tests.push({
      type: 'sync',
      fn,
      description: description || '(unnamed test)',
    });
  }

  function promise_test(fn, description) {
    tests.push({
      type: 'promise',
      fn,
      description: description || '(unnamed promise_test)',
    });
  }

  function async_test(description) {
    let resolveDone, rejectDone;
    const donePromise = new Promise((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });

    const t = {
      step(fn) {
        try {
          fn();
        } catch (e) {
          rejectDone(e);
        }
      },
      step_func(fn) {
        return (...args) => {
          try {
            return fn(...args);
          } catch (e) {
            rejectDone(e);
          }
        };
      },
      step_func_done(fn) {
        return (...args) => {
          try {
            if (fn) fn(...args);
            resolveDone();
          } catch (e) {
            rejectDone(e);
          }
        };
      },
      unreached_func(msg) {
        return () => rejectDone(new Error(`unreached: ${msg}`));
      },
      done() {
        resolveDone();
      },
      step_timeout(fn, ms) {
        return setTimeout(() => {
          try {
            fn();
          } catch (e) {
            rejectDone(e);
          }
        }, ms);
      },
    };

    tests.push({
      type: 'async',
      t,
      donePromise,
      description: description || '(unnamed async_test)',
    });

    return t;
  }

  // Test object helper for promise_test
  function makeTestObject(description) {
    return {
      step_func(fn) {
        return fn;
      },
      step_func_done(fn) {
        return fn;
      },
      unreached_func(msg) {
        return () => { throw new Error(`unreached: ${msg}`); };
      },
      step_timeout: setTimeout,
    };
  }

  // ---- Environment globals ----
  const step_timeout = (fn, ms) => setTimeout(fn, ms);

  const globals = {
    // Stream classes (swappable)
    ReadableStream: streamGlobals.ReadableStream,
    WritableStream: streamGlobals.WritableStream,
    TransformStream: streamGlobals.TransformStream,
    ByteLengthQueuingStrategy: globalThis.ByteLengthQueuingStrategy,
    CountQueuingStrategy: globalThis.CountQueuingStrategy,

    // testharness.js API
    test,
    promise_test,
    async_test,

    // Assertions
    assert_equals,
    assert_not_equals,
    assert_true,
    assert_false,
    assert_array_equals,
    assert_object_equals,
    assert_throws_js,
    assert_throws_exactly,
    assert_unreached,
    assert_class_string,
    assert_typeof,
    assert_in_array,
    assert_regexp_match,
    assert_less_than,
    assert_greater_than,
    assert_less_than_equal,
    assert_greater_than_equal,
    promise_rejects_js,
    promise_rejects_dom,
    promise_rejects_exactly,

    // Environment
    step_timeout,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    queueMicrotask: globalThis.queueMicrotask,
    Promise,
    Error,
    TypeError,
    RangeError,
    Uint8Array,
    Uint16Array,
    Int8Array,
    Int32Array,
    Float32Array,
    Float64Array,
    ArrayBuffer,
    SharedArrayBuffer: globalThis.SharedArrayBuffer,
    DataView,
    Map,
    Set,
    WeakRef: globalThis.WeakRef,
    structuredClone: globalThis.structuredClone,
    console,
    Object,
    Symbol,
    JSON,
    Number,
    String,
    Array,
    Math,
    BigInt,
    Proxy,
    Reflect,
    Date,
    RegExp,
    undefined,
    NaN,
    Infinity,
    isNaN,
    isFinite,
    parseInt,
    parseFloat,
    encodeURIComponent,
    decodeURIComponent,
    gc: globalThis.gc,
    Boolean,
    Function,
    WeakMap,
    BigUint64Array: globalThis.BigUint64Array,
    BigInt64Array: globalThis.BigInt64Array,
    ReadableStreamBYOBReader: streamGlobals.ReadableStreamBYOBReader || globalThis.ReadableStreamBYOBReader,
    ReadableByteStreamController: globalThis.ReadableByteStreamController,
    ReadableStreamDefaultController: globalThis.ReadableStreamDefaultController,
    ReadableStreamDefaultReader: streamGlobals.ReadableStreamDefaultReader || globalThis.ReadableStreamDefaultReader,
    WritableStreamDefaultWriter: streamGlobals.WritableStreamDefaultWriter || globalThis.WritableStreamDefaultWriter,
    WritableStreamDefaultController: globalThis.WritableStreamDefaultController,
    TransformStreamDefaultController: globalThis.TransformStreamDefaultController,
    AbortController: globalThis.AbortController,
    AbortSignal: globalThis.AbortSignal,
    DOMException: globalThis.DOMException,
    TextEncoder: globalThis.TextEncoder,
    TextDecoder: globalThis.TextDecoder,
    MessageChannel: globalThis.MessageChannel,
    atob: globalThis.atob,
    btoa: globalThis.btoa,
  };

  // self reference will be set to the context itself
  globals.self = globals;

  return { globals, tests };
}
