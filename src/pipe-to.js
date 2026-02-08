/**
 * Spec-compliant pipeTo implementation.
 *
 * Preserves error identity by using reader.read()/writer.write() directly
 * instead of delegating to native pipeTo (which wraps errors through
 * the Node↔WHATWG conversion layer).
 *
 * Follows the WHATWG ReadableStreamPipeTo algorithm:
 * https://streams.spec.whatwg.org/#readable-stream-pipe-to
 */

import { kNodeReadable, kWritableState, noop, RESOLVED_UNDEFINED } from './utils.js';

/**
 * Wait for all promises in a set to settle, resolving to undefined (not an array).
 * Unlike Promise.all(), this avoids creating an intermediate array result that would
 * trigger observable thenable resolution on Object.prototype.then monkey-patching.
 */
function _waitForAll(promiseSet) {
  let p = RESOLVED_UNDEFINED;
  for (const w of promiseSet) {
    p = p
      .then(
        () => w,
        () => w,
      )
      .then(noop, noop);
  }
  return p;
}

export function specPipeTo(source, dest, options = {}) {
  // Options are pre-evaluated by caller (pipeTo/pipeThrough) in spec order
  const preventClose = !!options.preventClose;
  const preventAbort = !!options.preventAbort;
  const preventCancel = !!options.preventCancel;
  const signal = options.signal;
  const reader = source.getReader();
  const writer = dest.getWriter();

  let shuttingDown = false;
  let currentWrite = RESOLVED_UNDEFINED;
  const pendingWrites = new Set();

  // Track dest state for WritableStreamDefaultWriterCloseWithErrorPropagation
  let destClosed = false;
  let destErrored = false;
  let destStoredError;
  let sourceClosed = false;

  return new Promise((resolve, reject) => {
    // --- Abort signal handling ---
    let abortAlgorithm;
    if (signal) {
      abortAlgorithm = () => {
        const error = signal.reason;
        const actions = [];
        if (!preventAbort)
          actions.push(() => {
            // Abort on already-errored writable resolves (spec: no-op)
            const state = dest[kWritableState];
            if (state === 'closed' || state === 'errored') return RESOLVED_UNDEFINED;
            return writer.abort(error);
          });
        if (!preventCancel)
          actions.push(() => {
            // Cancel on already-errored/closed readable resolves to avoid
            // the automatic rejection overriding the abort signal error.
            if (source._errored || source._closed) return RESOLVED_UNDEFINED;
            return reader.cancel(error);
          });
        shutdownWithAction(() => Promise.all(actions.map((a) => a())), true, error);
      };

      if (signal.aborted) {
        abortAlgorithm();
        return;
      }
      signal.addEventListener('abort', abortAlgorithm);
    }

    // --- Track dest state ---
    writer.closed.then(
      () => {
        destClosed = true;
      },
      (err) => {
        destErrored = true;
        destStoredError = err;
      },
    );

    // --- Source close/error handler ---
    // NOTE: Don't trigger shutdown on source close here. The reader.closed
    // promise can resolve (via Node.js 'end'/'close' events) before the pump
    // has drained all buffered data from the underlying Node.js readable.
    // Instead, just set the flag and kick the pump. The pump will read done
    // and trigger shutdown after draining all buffered chunks.
    reader.closed.then(
      () => {
        // Source closed — let the pump drain remaining data and handle shutdown
        sourceClosed = true;
        if (!shuttingDown) pipeLoop();
      },
      (storedError) => {
        // Source errored — immediate shutdown is correct (no data to drain)
        if (shuttingDown) return;
        if (!preventAbort) {
          shutdownWithAction(() => writer.abort(storedError), true, storedError);
        } else {
          shutdown(true, storedError);
        }
      },
    );

    // --- Dest close/error handler ---
    writer.closed.then(
      () => {
        // Dest closed unexpectedly (if we didn't close it, shuttingDown would be false)
        if (shuttingDown) return;
        const destClosedError = new TypeError(
          'the destination writable stream closed before all data could be piped to it',
        );
        if (!preventCancel) {
          shutdownWithAction(() => reader.cancel(destClosedError), true, destClosedError);
        } else {
          shutdown(true, destClosedError);
        }
      },
      (storedError) => {
        // Dest errored
        if (shuttingDown) return;
        // Per spec: don't cancel source if it's already closed/closing
        const nodeReadable = source[kNodeReadable];
        const srcAlreadyClosed =
          sourceClosed ||
          source._closed ||
          (nodeReadable && (nodeReadable.readableEnded || nodeReadable._readableState?.ended));
        if (!preventCancel && !srcAlreadyClosed) {
          shutdownWithAction(() => reader.cancel(storedError), true, storedError);
        } else {
          shutdown(true, storedError);
        }
      },
    );

    // Check if reader supports sync reads (FastReadableStreamDefaultReader)
    const hasSyncRead = typeof reader._readSync === 'function';

    // --- Pump loop ---
    pipeLoop();

    function pipeLoop() {
      if (shuttingDown) return;

      if (writer.desiredSize > 0) {
        pumpRead();
      } else {
        writer.ready.then(() => {
          if (!shuttingDown) pumpRead();
        }, noop);
      }
    }

    function pumpRead() {
      if (shuttingDown) return;

      // Sync fast path: read directly from Node buffer via reader._readSync
      // (saves 2 promises per chunk: the read result Promise + the .then Promise).
      // Must yield to microtask queue after each read for close/error handler interleaving.
      if (hasSyncRead) {
        const syncResult = reader._readSync();
        if (syncResult !== null) {
          if (syncResult.done) {
            sourceClosed = true;
            // Pump is responsible for triggering close-shutdown (not reader.closed)
            // to ensure all buffered data is drained before closing.
            if (!shuttingDown) {
              if (!preventClose) {
                shutdownWithAction(() => {
                  if (destErrored) return Promise.reject(destStoredError);
                  if (destClosed) return RESOLVED_UNDEFINED;
                  return writer.close().catch((e) => {
                    if (e instanceof TypeError) return;
                    throw e;
                  });
                });
              } else {
                shutdown();
              }
            }
            return;
          }
          currentWrite = writer.write(syncResult.value);
          pendingWrites.add(currentWrite);
          const w = currentWrite;
          currentWrite.then(
            () => pendingWrites.delete(w),
            () => pendingWrites.delete(w),
          );
          queueMicrotask(pipeLoop);
          return;
        }
      }

      // Async fallback
      reader.read().then(({ value, done }) => {
        if (shuttingDown) return;
        if (done) {
          sourceClosed = true;
          // Pump is responsible for triggering close-shutdown (not reader.closed)
          if (!shuttingDown) {
            if (!preventClose) {
              shutdownWithAction(() => {
                if (destErrored) return Promise.reject(destStoredError);
                if (destClosed) return RESOLVED_UNDEFINED;
                return writer.close().catch((e) => {
                  if (e instanceof TypeError) return;
                  throw e;
                });
              });
            } else {
              shutdown();
            }
          }
          return;
        }
        currentWrite = writer.write(value);
        pendingWrites.add(currentWrite);
        const w = currentWrite;
        currentWrite.then(
          () => pendingWrites.delete(w),
          () => pendingWrites.delete(w),
        );
        pipeLoop();
      }, noop);
    }

    // --- Shutdown with action (spec: shutdownWithAction) ---
    function shutdownWithAction(action, isError = false, originalError) {
      if (shuttingDown) return;
      shuttingDown = true;

      const doAction = () => {
        let p;
        try {
          p = action();
        } catch (e) {
          finalize(true, e);
          return;
        }
        Promise.resolve(p).then(
          () => finalize(isError, originalError),
          (newError) => finalize(true, newError),
        );
      };

      // Wait for all in-flight writes to complete before running action
      const allWrites = pendingWrites.size > 0 ? _waitForAll(pendingWrites) : currentWrite;
      allWrites.then(doAction, doAction);
    }

    // --- Shutdown without action ---
    function shutdown(isError = false, error) {
      if (shuttingDown) return;
      shuttingDown = true;
      const allWrites = pendingWrites.size > 0 ? _waitForAll(pendingWrites) : currentWrite;
      allWrites.then(
        () => finalize(isError, error),
        () => finalize(isError, error),
      );
    }

    // --- Finalize: release locks, settle promise ---
    function finalize(isError, error) {
      writer.releaseLock();
      reader.releaseLock();
      if (signal && abortAlgorithm) {
        signal.removeEventListener('abort', abortAlgorithm);
      }
      if (isError) reject(error);
      else resolve(undefined);
    }
  });
}
