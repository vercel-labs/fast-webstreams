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

import { isThenable, kLock, kNodeReadable, kStoredError, kWritableState, noop, RESOLVED_UNDEFINED, _stats } from './utils.js';
import { kInFlightWriteRequest, kWriteRequests, kStarted, kCloseRequest, kInFlightCloseRequest, _advanceQueueIfNeeded, _getDesiredSize } from './writable.js';
import { READ_DONE } from './reader.js';

/**
 * Wait for a write promise to settle, resolving to undefined regardless of outcome.
 */
function _waitForWrite(writePromise) {
  return writePromise.then(noop, noop);
}

export function specPipeTo(source, dest, options = {}) {
  _stats.tier2_specPipeTo++;
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

    // Check if dest supports direct sink writes (Fast writable, not transform shell)
    const hasBatchWrite = !!(dest._sinkWrite && !dest._isTransformShell);

    // Cache sink references for batch path
    const sinkWrite = hasBatchWrite ? dest._sinkWrite : null;
    const sink = hasBatchWrite ? dest._underlyingSink : null;
    const ctrl = hasBatchWrite ? dest._controller : null;

    // Synchronous pre-check: if source is already errored, transition dest to
    // "erroring" immediately. This must happen BEFORE the dest constructor's
    // start-completion microtask fires, so that _advanceQueueIfNeeded sees
    // "erroring" (calls _finishErroring → sink.abort) instead of processing
    // a pending close request (which would call sink.close instead of sink.abort).
    // The reader.closed rejection handler will fire later and handle shutdown.
    if (source._errored && !preventAbort) {
      const destState = dest[kWritableState];
      if (destState !== 'closed' && destState !== 'errored') {
        dest._abortInternal(source._storedError);
      }
    }

    // --- Pump loop ---
    pipeLoop();

    // Re-enter pump after backpressure or batch completion.
    // For batch-eligible dests, bypass writer.desiredSize getter (avoids
    // released-check + brand-check + _getDesiredSize indirection per call).
    function pipeLoop() {
      if (shuttingDown) return;

      if (hasBatchWrite) {
        const ds = _getDesiredSize(dest);
        if (ds !== null && ds > 0) {
          pumpRead();
        } else {
          writer.ready.then(() => {
            if (!shuttingDown) pumpRead();
          }, noop);
        }
      } else if (writer.desiredSize > 0) {
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

    // Batch-aware re-entry: after clearing the sentinel, check desiredSize
    // directly and call pumpRead() without going through pipeLoop overhead.
    function batchReenter() {
      if (shuttingDown) return;
      const ds = _getDesiredSize(dest);
      if (ds !== null && ds > 0) {
        pumpRead();
      } else {
        writer.ready.then(() => {
          if (!shuttingDown) pumpRead();
        }, noop);
      }
    }

    function pumpRead() {
      if (shuttingDown) return;

      // Sync fast path: batch-read directly from Node buffer via reader._readSync.
      // Drains all available buffered chunks in one go before yielding to the
      // microtask queue, amortizing the yield cost across multiple chunks.
      if (hasSyncRead) {

        // Batch write path: when both reader and writer are Fast, bypass writer.write()
        // and call the sink directly. Uses _readSyncRaw() to avoid {value, done}
        // object allocation per chunk. Reduces N promises to 1 per batch.
        if (hasBatchWrite &&
            dest[kStarted] &&
            dest[kWritableState] === 'writable' &&
            !dest[kInFlightWriteRequest] &&
            dest[kWriteRequests].length === 0 &&
            !dest[kCloseRequest]) {

          let chunk = reader._readSyncRaw();
          if (chunk !== null) {
            // Set sentinel to block concurrent writes from _advanceQueueIfNeeded
            dest[kInFlightWriteRequest] = true;

            let batchCount = 0;
            const hwm = dest._hwm;

            while (chunk !== null) {
              if (chunk === READ_DONE) {
                dest[kInFlightWriteRequest] = null;
                pumpClose();
                return;
              }

              try {
                const result = Reflect.apply(sinkWrite, sink, [chunk, ctrl]);
                if (isThenable(result)) {
                  // Async write — wait for it, then re-enter directly
                  currentWrite = result.then(
                    () => {
                      dest[kInFlightWriteRequest] = null;
                      const w = dest[kWritableState];
                      if (w === 'erroring' || w === 'errored') return;
                      const writer_ = dest[kLock];
                      if (writer_ && w === 'writable') {
                        writer_._updateReadyForBackpressure(dest);
                      }
                      _advanceQueueIfNeeded(dest);
                      batchReenter();
                    },
                    (err) => {
                      dest[kInFlightWriteRequest] = null;
                      ctrl.error(err);
                    },
                  );
                  return;
                }
              } catch (err) {
                dest[kInFlightWriteRequest] = null;
                ctrl.error(err);
                return;
              }

              batchCount++;
              if (shuttingDown) {
                dest[kInFlightWriteRequest] = null;
                return;
              }

              // Check writable state (may have changed via abort signal, etc.)
              if (dest[kWritableState] !== 'writable') {
                dest[kInFlightWriteRequest] = null;
                return;
              }

              // Backpressure: stop batch after hwm chunks
              if (batchCount >= hwm) {
                break;
              }

              chunk = reader._readSyncRaw();
            }

            // End of batch (all sync). Clear sentinel and re-enter via microtask.
            // The microtask deferral allows events (abort signal, errors) to fire between batches.
            currentWrite = new Promise((resolve) => {
              queueMicrotask(() => {
                dest[kInFlightWriteRequest] = null;
                if (dest[kWritableState] === 'writable') {
                  const writer_ = dest[kLock];
                  if (writer_) {
                    writer_._updateReadyForBackpressure(dest);
                  }
                  _advanceQueueIfNeeded(dest);
                }
                resolve();
                batchReenter();
              });
            });
            return;
          }
          // _readSyncRaw returned null on first call — no sync data, fall through
        }

        // Non-batch sync path: use writer.write() per chunk (transform shells, etc.)
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
