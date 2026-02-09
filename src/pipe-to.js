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

import { kNodeReadable, kStoredError, kWritableState, noop, RESOLVED_UNDEFINED } from './utils.js';

/**
 * Wait for a write promise to settle, resolving to undefined regardless of outcome.
 */
function _waitForWrite(writePromise) {
  return writePromise.then(noop, noop);
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

  // Track dest state for WritableStreamDefaultWriterCloseWithErrorPropagation
  let destClosed = false;
  let destErrored = false;
  let destStoredError;
  let sourceClosed = false;
  const destWasErroredAtStart = dest[kWritableState] === 'errored';

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
    // NOTE: reader.closed can resolve (via Node.js 'end'/'close' events)
    // before the pump loop has drained all buffered data from the Node.js
    // readable (e.g., TransformStream flush() chunks). Check readableLength
    // to decide: if data remains, kick the pump to drain it first; if not,
    // shutdown immediately (preserves microtask ordering for abort signal
    // tests and avoids deadlock when dest has HWM=0).
    reader.closed.then(
      () => {
        sourceClosed = true;
        if (shuttingDown) return;
        // Check if there's buffered data that the pump needs to drain first
        const nodeReadable = source[kNodeReadable];
        if (nodeReadable && nodeReadable.readableLength > 0) {
          pipeLoop();
          return;
        }
        // No buffered data — shutdown immediately
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
      },
      (storedError) => {
        // Source errored — immediate shutdown is correct (no data to drain)
        if (shuttingDown) return;
        if (!preventAbort) {
          // Check if dest errored during setup — dest error takes precedence
          const destNowErrored = dest[kWritableState] === 'errored';
          if (!destWasErroredAtStart && destNowErrored) {
            shutdown(true, dest[kStoredError]);
            return;
          }
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

    // Close-shutdown helper (called when pump reads done)
    function pumpClose() {
      sourceClosed = true;
      if (shuttingDown) return;
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

    function pumpRead() {
      if (shuttingDown) return;

      // Sync fast path: batch-read directly from Node buffer via reader._readSync.
      // Drains all available buffered chunks in one go before yielding to the
      // microtask queue, amortizing the yield cost across multiple chunks.
      if (hasSyncRead) {
        let didSync = false;
        let syncResult = reader._readSync();
        while (syncResult !== null) {
          if (syncResult.done) {
            pumpClose();
            return;
          }
          didSync = true;
          currentWrite = writer.write(syncResult.value);
          if (shuttingDown) return;
          // Check backpressure before reading more
          if (writer.desiredSize <= 0) {
            queueMicrotask(pipeLoop);
            return;
          }
          syncResult = reader._readSync();
        }
        // _readSync returned null — no more buffered data.
        if (didSync) {
          // We processed at least one chunk. Yield to allow events to fire,
          // then re-enter pipeLoop which will try sync again or fall to async.
          queueMicrotask(pipeLoop);
          return;
        }
        // No sync data available at all — fall through to async read below.
      }

      // Async fallback: wait for data via 'readable' event
      reader.read().then(({ value, done }) => {
        if (shuttingDown) return;
        if (done) {
          pumpClose();
          return;
        }
        currentWrite = writer.write(value);
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

      // Wait for the last in-flight write to settle before running action
      _waitForWrite(currentWrite).then(doAction, doAction);
    }

    // --- Shutdown without action ---
    function shutdown(isError = false, error) {
      if (shuttingDown) return;
      shuttingDown = true;
      _waitForWrite(currentWrite).then(
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
