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

import { kWritableState, kStoredError } from './utils.js';

export function specPipeTo(source, dest, options = {}) {
  // Options are pre-evaluated by caller (pipeTo/pipeThrough) in spec order
  const preventClose = !!options.preventClose;
  const preventAbort = !!options.preventAbort;
  const preventCancel = !!options.preventCancel;
  const signal = options.signal;
  const reader = source.getReader();
  const writer = dest.getWriter();

  let shuttingDown = false;
  let currentWrite = Promise.resolve();
  const pendingWrites = [];

  // Track dest state for WritableStreamDefaultWriterCloseWithErrorPropagation
  let destClosed = false;
  let destErrored = false;
  let destStoredError;

  return new Promise((resolve, reject) => {
    // --- Abort signal handling ---
    let abortAlgorithm;
    if (signal) {
      abortAlgorithm = () => {
        const error = signal.reason;
        const actions = [];
        if (!preventAbort) actions.push(() => writer.abort(error));
        if (!preventCancel) actions.push(() => reader.cancel(error));
        shutdownWithAction(
          () => Promise.all(actions.map(a => a())),
          true,
          error
        );
      };

      if (signal.aborted) {
        abortAlgorithm();
        return;
      }
      signal.addEventListener('abort', abortAlgorithm);
    }

    // --- Track dest state (registered FIRST to fire before source handlers) ---
    writer.closed.then(
      () => { destClosed = true; },
      (err) => { destErrored = true; destStoredError = err; }
    );

    // --- Source close/error handler ---
    reader.closed.then(
      () => {
        // Source closed
        if (shuttingDown) return;
        if (!preventClose) {
          shutdownWithAction(() => {
            // WritableStreamDefaultWriterCloseWithErrorPropagation
            if (destErrored) return Promise.reject(destStoredError);
            if (destClosed) return Promise.resolve();
            // writer.close() may reject if already closed; treat as success
            return writer.close().catch((e) => {
              if (e instanceof TypeError) return; // Already closed/closing
              throw e;
            });
          });
        } else {
          shutdown();
        }
      },
      (storedError) => {
        // Source errored
        if (shuttingDown) return;
        // Per spec: if dest already errored/erroring, dest error takes precedence
        const destState = dest[kWritableState];
        const destIsErroring = destState === 'erroring' || destState === 'errored';
        if (destIsErroring || destErrored) {
          const destErr = destErrored ? destStoredError : dest[kStoredError];
          if (!preventCancel) {
            shutdownWithAction(() => reader.cancel(destErr), true, destErr);
          } else {
            shutdown(true, destErr);
          }
        } else if (!preventAbort) {
          shutdownWithAction(() => writer.abort(storedError), true, storedError);
        } else {
          shutdown(true, storedError);
        }
      }
    );

    // --- Dest close/error handler ---
    writer.closed.then(
      () => {
        // Dest closed unexpectedly (if we didn't close it, shuttingDown would be false)
        if (shuttingDown) return;
        const destClosedError = new TypeError(
          'the destination writable stream closed before all data could be piped to it'
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
        if (!preventCancel) {
          shutdownWithAction(() => reader.cancel(storedError), true, storedError);
        } else {
          shutdown(true, storedError);
        }
      }
    );

    // --- Pump loop ---
    pipeLoop();

    function pipeLoop() {
      if (shuttingDown) return;

      writer.ready.then(() => {
        if (shuttingDown) return;

        return reader.read().then(
          ({ value, done }) => {
            if (shuttingDown) return;
            if (done) return; // Source close handled by reader.closed

            currentWrite = writer.write(value);
            currentWrite.catch(() => {}); // Error handled by writer.closed
            pendingWrites.push(currentWrite);
            const w = currentWrite;
            currentWrite.then(
              () => { const idx = pendingWrites.indexOf(w); if (idx !== -1) pendingWrites.splice(idx, 1); },
              () => { const idx = pendingWrites.indexOf(w); if (idx !== -1) pendingWrites.splice(idx, 1); }
            );
            // Per spec: don't wait for write to complete. Continue pump loop
            // immediately. Backpressure is handled by writer.ready.
            pipeLoop();
          },
          () => {} // Error handled by reader.closed
        );
      }, () => {}); // Error handled by writer.closed
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
          (newError) => finalize(true, newError)
        );
      };

      // Wait for all in-flight writes to complete before running action
      const allWrites = pendingWrites.length > 0 ? Promise.all(pendingWrites).catch(() => {}) : currentWrite;
      allWrites.then(doAction, doAction);
    }

    // --- Shutdown without action ---
    function shutdown(isError = false, error) {
      if (shuttingDown) return;
      shuttingDown = true;
      const allWrites = pendingWrites.length > 0 ? Promise.all(pendingWrites).catch(() => {}) : currentWrite;
      allWrites.then(
        () => finalize(isError, error),
        () => finalize(isError, error)
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
