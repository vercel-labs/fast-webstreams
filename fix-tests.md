# Plan: WPT Compliance Push — 90.4% → 98.2% (Match Native)

## Current State

- **Fast**: 978/1082 (90.4%)
- **Native**: 1096/1116 (98.2%)
- **Gap**: 104 fast-only failures (native fails 20 tests that don't apply to us)
- **Shared failures**: ~8 tests fail in both native and fast (owning-type: 5, queuing-strategies: 2, async-iterator prototype: 1). These are Node.js platform limitations.
- **True target**: ~96 fast-only failures to fix → brings us to ~1074/1082 ≈ 99.3% (matching native's effective pass rate on shared tests)

---

## Test Runner Reference

### Architecture
- `test/run-wpt.js` — orchestrator, spawns one subprocess per `.any.js` file
- `test/run-wpt-file.js` — per-file runner, uses `node:vm` context isolation
  - Per-test timeout: **2 seconds** (TEST_TIMEOUT in run-wpt-file.js:22)
  - Per-file subprocess timeout: **30 seconds** (FILE_TIMEOUT in run-wpt.js:23)
  - Default concurrency: **4** subprocess workers

### Commands

```bash
# Full suite (~31s wall clock, 61 files, 1082 tests)
node test/run-wpt.js --mode=fast

# Full suite with all error messages
node test/run-wpt.js --mode=fast --verbose

# Subset by path substring (--filter does substring match on relative path)
node test/run-wpt.js --mode=fast --filter=writable
node test/run-wpt.js --mode=fast --filter=transform
node test/run-wpt.js --mode=fast --filter=piping
node test/run-wpt.js --mode=fast --filter=readable-streams

# Single test file (~2s, most precise)
node test/run-wpt.js --mode=fast --filter=writable-streams/aborting
node test/run-wpt.js --mode=fast --filter=transform-streams/cancel
node test/run-wpt.js --mode=fast --filter=readable-streams/async-iterator

# Even more specific path
node test/run-wpt.js --mode=fast --filter=piping/close-propagation-forward

# Bump concurrency for faster full runs (limited by 30s timeout files)
node test/run-wpt.js --mode=fast --concurrency=8

# Native baseline (compare against)
node test/run-wpt.js --mode=native --filter=writable-streams/aborting

# Direct single-file invocation (raw JSON output, ~2s)
node test/run-wpt-file.js fast vendor/wpt/streams/writable-streams/aborting.any.js

# Parse single-file JSON for pass/fail + errors
node test/run-wpt-file.js fast vendor/wpt/streams/writable-streams/aborting.any.js 2>&1 \
  | python3 -c "import sys,json; d=json.loads(sys.stdin.read().strip().split('\n')[-1]); \
    print(f'{d[\"passed\"]}/{d[\"total\"]}'); [print(e) for e in d.get('errors',[])]"
```

### Benchmarks (run after each phase to check for regressions)
```bash
node bench/run.js --scenario=passthrough --chunk-size=1024 --iterations=3 --warmup=1
```
Key metrics: `fast-pipeTo` should be ≥1.3x `web-pipeTo`, `fast-pipeThrough` should be ≥8x `web-pipeThrough`.

### Fast Iteration Workflow

**1. Pick a phase and its target test file(s).**

**2. Run the target file in a loop while editing:**
```bash
# Terminal 1: edit src files
# Terminal 2: run specific failing tests on each save
node test/run-wpt.js --mode=fast --filter=transform-streams/cancel --verbose
```
Single-file runs take ~2s. With `--verbose` you see every failing test name + error message.

**3. After fixing a phase, run the broader category to catch regressions:**
```bash
node test/run-wpt.js --mode=fast --filter=transform    # all transform tests (~12 files, ~5s)
node test/run-wpt.js --mode=fast --filter=writable      # all writable tests (~14 files, ~5s)
```

**4. Before declaring a phase complete, run the full suite:**
```bash
node test/run-wpt.js --mode=fast                        # 61 files, ~31s
```

**5. Spot-check benchmarks after any phase touching hot paths (writable.js, pipe-to.js):**
```bash
node bench/run.js --scenario=passthrough --chunk-size=1024 --iterations=3 --warmup=1
```

### Debugging Individual Tests

For a specific test within a file, use a temporary inline script:
```bash
node -e "
const { FastReadableStream: ReadableStream, FastWritableStream: WritableStream, FastTransformStream: TransformStream } = await import('./src/index.js');
// paste test body here, replace promise_test/assert_* with console.log
"
```

### Timeouts

A test reporting `timeout` means it ran for >2s without resolving. Common causes:
- A promise never settles (missing resolve/reject path)
- A Node stream event ('end', 'finish', 'error') never fires
- pipeTo pump loop stalls (write never completes → pipeLoop never continues)

A file reporting `Process killed (timeout)` means the entire subprocess ran for >30s. This means one test within the file is hanging indefinitely and blocking all subsequent tests.

---

## Failure Taxonomy

The 104 fast-only failures cluster into 8 root causes:

| Root Cause | Tests | Files |
|---|---|---|
| A. Transform desiredSize / backpressure | 10 | strategies, backpressure, general, errors |
| B. Transform cancel/error lifecycle | 17 | cancel, errors, terminate, flush |
| C. Tee implementation | 6 | tee (fast-only portion) |
| D. Readable pull() timing | 5 | general |
| E. Writable abort edge cases | 6 | aborting, close, general, constructor |
| F. pipeTo write-completion timing | 14 | abort, close-fwd, error-fwd, error-bwd, multiple, general, flow, pipe-through, then-interception, transform-streams |
| G. Reader/stream error identity | 9 | default-reader, templated, bad-underlying-sources |
| H. Async iterator ordering | 7 | async-iterator |

---

## Phase E: Writable Abort Edge Cases (+5-6 tests) — Low complexity, no dependencies

**Files**: `src/writable.js`, `src/writer.js`

**Test commands**:
```bash
node test/run-wpt.js --mode=fast --filter=writable-streams/aborting --verbose
node test/run-wpt.js --mode=fast --filter=writable-streams/close --verbose
node test/run-wpt.js --mode=fast --filter=writable-streams/constructor --verbose
node test/run-wpt.js --mode=fast --filter=writable-streams/general --verbose
# Regression check:
node test/run-wpt.js --mode=fast --filter=writable
```

**Failing tests → root cause → fix**:

1. `aborting: writer.abort(), controller.error() while there is an in-flight close, and then finish the close`
   - **Cause**: `writer.close()` returns the error from in-flight close instead of TypeError for "already closing". When abort is called during close, the second close attempt should reject with TypeError.
   - **Fix** in `_closeFromWriter`: when `kInFlightCloseRequest` is set and stream is `erroring`, reject with TypeError("Cannot close an already-closing stream").

2. `aborting: writer abort() during sink start() should replace the writer.ready promise synchronously`
   - **Cause**: `abort()` rejects the pending ready promise but doesn't change its identity. The test asserts `writer.ready !== readyBefore`.
   - **Fix** in `_startErroring`: after rejecting ready via `_rejectReadyIfPending(reason)`, call `writer._replaceReady(reason)` which creates a new rejected promise with new identity. Add `_replaceReady(reason)` method to writer that sets `#readyPromise = Promise.reject(reason)`.

3. `aborting: promises returned from other writer methods should be rejected when writer abort() happens during sink start()`
   - **Cause**: Promise settlement ordering. Spec says: write2 (newest queued) rejects before write1, then abort resolves, then close rejects.
   - **Fix**: In `_finishErroring`, the write queue is iterated in order. The spec reverses it. Change `for (const req of writeRequests)` to iterate in reverse.

4. `close: promises must fulfill/reject in the expected order on aborted and errored closure`
   - **Cause**: `writer.closed` rejects with close error instead of abort reason. Per spec, when abort is pending and close fails, `writer.closed` rejects with the abort reason.
   - **Fix** in `_handleCloseError`: when there's a `kPendingAbortRequest`, pass `abortRequest.reason` (not `error`) to `_rejectClosed`.

5. `constructor: WritableStreamDefaultController/Writer constructor should throw`
   - **Cause**: Our constructors don't brand-check their arguments. Calling `new WritableStreamDefaultController()` directly should throw TypeError.
   - **Fix**: Add `if (!(stream instanceof FastWritableStream)) throw new TypeError(...)` in FastWritableStreamDefaultWriter constructor. For FastWritableStreamDefaultController, make it non-constructible from user code (only created internally).

6. `general: methods should not not have .apply() or .call() called`
   - **Cause**: We invoke sink methods via `.call(underlyingSink, ...)` which triggers custom `.call` traps.
   - **Fix**: Change `write.call(underlyingSink, chunk, controller)` → `Reflect.apply(write, underlyingSink, [chunk, controller])` in writable.js Node Writable write/final/destroy callbacks. Same pattern for readable.js and transform.js.

---

## Phase G: Reader/Stream Error Identity (+5-7 tests) — Low complexity, no dependencies

**Files**: `src/reader.js`, `src/readable.js`, `src/controller.js`

**Test commands**:
```bash
node test/run-wpt.js --mode=fast --filter=readable-streams/default-reader --verbose
node test/run-wpt.js --mode=fast --filter=readable-streams/templated --verbose
node test/run-wpt.js --mode=fast --filter=readable-streams/bad-underlying-sources --verbose
# Regression check:
node test/run-wpt.js --mode=fast --filter=readable-streams
```

**Failing tests → root cause → fix**:

1. `default-reader: Getting a second reader after erroring the stream and releasing the reader should succeed`
   - **Cause**: After `controller.error(theError)` + `releaseLock()`, creating a new reader fails because the reader constructor checks `nodeReadable.errored` but gets a wrapped error object (not the original).
   - **Fix**: Use `stream._storedError` (set by controller.error) instead of `nodeReadable.errored` in the reader constructor for the error identity check. When constructing a reader on an errored stream, use `stream._storedError` for both `closed` rejection and `read()` rejection.

2. `default-reader: ReadableStreamDefaultReader: if start rejects with no parameter, it should error the stream with an undefined error`
   - **Cause**: `start()` returns `Promise.reject()` (no arg → `undefined`). Node's `destroy(undefined)` treats this as no-error, so `nodeReadable.errored` is `null`. Reader's `read()` sees no error and resolves with `{done: true}` instead of rejecting.
   - **Fix**: Track `stream._storedError` separately from `nodeReadable.errored`. In `_cancelInternal` / reader.read(), check `stream._storedError` first. When destroying with a falsy error, use the kWrappedError approach or store the error on the stream before destroying.

3. `templated: ReadableStream (empty) reader: releasing the lock should cause closed calls to reject with a TypeError`
   - **Cause**: `assert_equals: expected {} but got {}` — two Promise objects compared with `Object.is()`. The test captures `reader.closed` before and after some action and expects identity. This is a VM context issue: `Promise` in the VM context is the same as the module's `Promise`, so the identity should hold. Investigate: the test may capture `reader.closed` before release, then compare after release. Our `releaseLock` replaces the promise, but the OLD captured reference should be the same object as what was accessed before.
   - **Fix**: The identity check is on the OLD promise (before release). If the reader hasn't yet resolved closed, the captured `reader.closed` should always be the same `#closedPromise`. This should already work. Debug by running the exact test code manually.

4. `templated: ReadableStream reader (closed via cancel after getting reader): releasing the lock should cause closed to reject and change identity`
   - **Cause**: `Reader was released` — test expects the original closed promise to resolve (from cancel), but it's rejected.
   - **Fix**: Same as the `_closed` / `_storedError` tracking above. When `cancel()` succeeds, the stream should be marked as closed. In `releaseLock`, check `stream._closed` and resolve the original closed promise.

5. `templated: cancel() should return a distinct rejected promise each time`
   - **Cause**: On an errored stream, `cancel()` should reject with the stored error. Currently it may resolve because `underlyingSource.cancel()` resolves.
   - **Fix**: In `_cancelInternal`, check if the stream is errored first (`stream._storedError !== undefined` or `nodeReadable.errored`). If so, return `Promise.reject(stream._storedError)`.

6. `bad-underlying-sources: Failed to parse output`
   - **Cause**: The subprocess produces no JSON output. One of the 22 sync tests causes an unhandled exception that aborts the process before output.
   - **Fix**: Investigate which test crashes by running the file with extra error logging. Likely a test that throws in a way that escapes the try/catch (e.g., in a setTimeout callback or a thrown non-Error value).

---

## Phase H: Async Iterator Ordering (+4-6 tests) — Medium complexity, no dependencies

**Files**: `src/readable.js`

**Test commands**:
```bash
node test/run-wpt.js --mode=fast --filter=readable-streams/async-iterator --verbose
```

**Failing tests → root cause → fix**:

1. `return() rejects if the stream has errored`
   - **Cause**: `return()` calls `reader.cancel(value)` which resolves (cancel on an errored stream resolves in our impl). It should reject.
   - **Fix**: After `reader.cancel()`, check if reader was errored. If the stream errored, reject with the stored error. Or: fix `_cancelInternal` to reject on errored streams (Phase G fix #5). This test depends on Phase G.

2. `next() that succeeds; next() that reports an error(); next()/return() [no awaiting]` (3 tests)
   - **Cause**: `assert_equals: expected {} but got {}` — error identity mismatch. After `controller.error(theError)`, the iterator's `next()` should reject with `theError` exactly. But `nodeReadable.errored` may be a wrapped version.
   - **Fix**: Track error in iterator state (`kIterError`). When `next()` catches an error, store it on the iterator. Subsequent `next()` calls return `Promise.reject(kIterError)`.

3. `next() that succeeds; return() [no awaiting]`
   - **Cause**: `assert_equals: expected 2 but got 1` — ordering issue. When `next()` and `return()` are called without awaiting, `return()` cancels the reader which makes `next()` resolve with `{done: true}`. But the result order is wrong.
   - **Fix**: Add a pending-operation queue to the iterator. When `return()` is called, chain it after any pending `next()`. When `next()` is called after `return()`, chain it after the return.

4. `return(); next() [no awaiting]` and `return(); return() [no awaiting]` (3 tests)
   - **Cause**: Ordering — `next()` should resolve AFTER `return()`. Second `return()` should resolve AFTER first.
   - **Fix**: Same pending-operation queue. Track `#ongoingPromise`. Each `next()`/`return()` chains behind it: `this.#ongoingPromise = this.#ongoingPromise.then(() => doOperation())`.

---

## Phase D: Readable Pull Timing (+4-5 tests) — Medium complexity, no dependencies

**Files**: `src/readable.js`

**Test commands**:
```bash
node test/run-wpt.js --mode=fast --filter=readable-streams/general --verbose
```

**Failing tests → root cause → fix**:

1. `should call pull when trying to read from a started, empty stream` (expects pull count = 2)
   - **Cause**: After start, auto-pull fires once. Then `reader.read()` consumes the data. Spec says pull should fire again immediately (desiredSize > 0 after consumption). Node's `_read()` deduplicates.
   - **Fix**: In reader's `read()` method, after consuming a chunk (sync fast path), explicitly trigger `nodeReadable.read(0)` to request another pull. This must happen asynchronously (microtask).

2. `should only call pull once on a non-empty stream read from before start fulfills` (expects 0 pulls during start)
   - **Cause**: Pull fires during start even though it shouldn't. Our deferred-start mechanism may have a timing issue.
   - **Fix**: Ensure pull (`_read()` handler) does nothing until `kStarted` equivalent flag is set. Currently the Node Readable's `_read()` always calls `pull()`. We need to guard it: `if (!streamStarted) return;`.

3. `should not call pull until the previous pull call's promise fulfills` (expects 2 pulls sequentially)
   - **Cause**: Same as #1 — after the first pull resolves, the second pull should fire. Node deduplicates `_read()` calls.
   - **Fix**: After pull promise resolves, explicitly call `nodeReadable.read(0)` to trigger re-read. Already done, but may need to be more aggressive.

4-5. `integration test: adapting a sync/async pull source` (both timeout)
   - **Cause**: Pull-based streams with many items. After initial pulls, the pull loop stalls because Node doesn't re-trigger `_read()`.
   - **Fix**: Same as above — ensure pull re-triggers after each resolution. The integration tests pull 8+ items, so the re-trigger must work reliably across many iterations.

---

## Phase A: Transform desiredSize & Backpressure (+6-8 tests) — Medium complexity, no dependencies

**Files**: `src/writable.js`, `src/transform.js`

**Test commands**:
```bash
node test/run-wpt.js --mode=fast --filter=transform-streams/strategies --verbose
node test/run-wpt.js --mode=fast --filter=transform-streams/backpressure --verbose
node test/run-wpt.js --mode=fast --filter=transform-streams/general --verbose
# Regression check:
node test/run-wpt.js --mode=fast --filter=transform
```

**Failing tests → root cause → fix**:

1. `strategies: default writable strategy should be equivalent to { highWaterMark: 1 }` (desiredSize 1 after write, expected 0)
   - **Cause**: Transform shell's `_getDesiredSize` uses `nodeWritable.writableHighWaterMark - writableLength`. After `_processWriteTransform` dispatches the write, the chunk moves from the writable buffer to the readable buffer synchronously. So `writableLength` drops to 0 immediately, and desiredSize stays at 1.
   - **Fix**: Use the state-machine-based formula (`hwm - queueLength - inFlight`) for transforms too. Remove the `_isTransformShell` branch in `_getDesiredSize`. The in-flight write tracked by `kInFlightWriteRequest` already counts. This means `desiredSize = 1 - 0 - 1 = 0` after write dispatch. ✓

2. `strategies: default readable strategy should be equivalent to { highWaterMark: 0 }` (desiredSize -1, expected 0)
   - **Cause**: After writing one chunk that gets transformed and pushed to the readable side, the **readable** desiredSize should be 0 (HWM=0, 1 item buffered → 0-1 = -1... actually -1 is correct for Node's calculation). The test expects 0 which suggests the spec has different clamping behavior.
   - **Fix**: Check what the test actually asserts. It likely asserts the **readable controller**'s desiredSize, not the writable's. The readable controller's desiredSize after enqueue should be `max(0 - 1, 0)` = 0? No, spec says desiredSize = HWM - queueSize, which is 0 - 1 = -1. But the test expects 0. Need to read the actual test assertion to understand.

3. `backpressure: backpressure allows no transforms with a default identity transform and no reader` (transform called, expected not)
   - **Cause**: With no reader, readable backpressure should prevent the transform from being called. Our `_processWriteTransform` dispatches to Node's write regardless.
   - **Fix**: Before dispatching, check `nodeTransform.readableLength >= nodeTransform.readableHighWaterMark`. If so, don't dispatch yet — keep the write in `kWriteRequests` and listen for the readable side to be drained.

4. `backpressure: writes should resolve as soon as transform completes`
   - **Cause**: Write resolves at the wrong time (before or after expected).
   - **Fix**: Likely falls out of fixing #1 (desiredSize calculation) and #3 (backpressure gating).

5. `general: Identity TransformStream: can read from readable what is put into writable` (desiredSize after read)
   - **Cause**: After writing + reading, desiredSize should recover to 1. With our state machine, the in-flight write was resolved, so `kInFlightWriteRequest` is null and queue is empty → desiredSize = 1. But the test sees 0.
   - **Fix**: Likely falls out of fixing `_getDesiredSize` to use the state-machine formula.

---

## Phase B: Transform Cancel/Error Lifecycle (+10-14 tests) — High complexity, depends on Phase A

**Files**: `src/transform.js`, `src/controller.js`, `src/writable.js`

**Test commands**:
```bash
node test/run-wpt.js --mode=fast --filter=transform-streams/cancel --verbose
node test/run-wpt.js --mode=fast --filter=transform-streams/errors --verbose
node test/run-wpt.js --mode=fast --filter=transform-streams/terminate --verbose
node test/run-wpt.js --mode=fast --filter=transform-streams/flush --verbose
# Regression check:
node test/run-wpt.js --mode=fast --filter=transform
```

**Failing tests → root cause → fix**:

1. **cancel.any.js** (7 failures):
   - `aborting the writable side should reject if transformer.cancel() throws`: Abort calls `transformer.cancel()` via `_sinkAbort`. If it throws, the abort should reject with the thrown error. Currently `_finishErroring` handles this, but the thrown error may not propagate to `reader.closed`. **Fix**: In `_finishErroring`'s abort-threw path, reject `reader.closed` with the thrown error (not stored error) for transforms.
   - `closing the writable side should reject if a parallel transformer.cancel() throws`: Close is in-flight, readable.cancel() calls transformer.cancel() which throws. The throw should reject the close promise. **Fix**: In the readable cancel handler, if cancel throws, destroy the node transform with the thrown error, which will cause the close callback to error.
   - Flush/cancel mutual exclusion (3 tests): **Fix**: Add `_flushStarted` / `_cancelStarted` flags on the TransformStream instance. In `_final()`: if `_cancelStarted`, skip flush, call callback directly. In `_cancel()`: if `_flushStarted`, skip cancel.
   - `writable.abort() should not call cancel() again when already called from readable.cancel()`: Double-cancel prevention. **Fix**: Already have `_cancelCalled` flag. Ensure it's checked in the abort path too.

2. **errors.any.js** (6 failures):
   - `it should be possible to error the readable between close requested and complete`: Write in-flight + controller.error should error both sides. **Fix**: Make `controller.error()` for transforms reject in-flight writes on the writable side immediately.
   - `an exception from transform() should error the stream if terminate has been requested`: Transform throws after terminate. **Fix**: Ensure the transform error propagates even after terminate started.
   - `controller.error() should do nothing the second time it is called`: Second error after first should be no-op but abort should still reject with the first error. **Fix**: Track first error in `_errorTransformWritable`, ignore subsequent calls.
   - `erroring during write with backpressure`: Transform should not be called when there's backpressure. **Fix**: Depends on Phase A fix #3.
   - `a write() that was waiting for backpressure should reject if the writable is aborted`: **Fix**: When writable abort fires, reject queued writes including backpressure-waiting writes.

3. **terminate.any.js** (3 failures):
   - `controller.terminate() should error pipeTo()`: After terminate, pipeTo should error. **Fix**: Ensure terminate errors the writable side, which causes pipeTo's writer.closed handler to fire with error.
   - `controller.error() after controller.terminate() with/without queued chunk`: After terminate, error should reject the abort. **Fix**: After terminate errors the writable, controller.error should propagate to abort rejection. Ensure `_errorTransformWritable` handles the post-terminate state.

4. **flush.any.js** (1 failure):
   - `closing the writable side should call transformer.flush() and a parallel readable.cancel() should not reject`: Flush is in-flight, readable.cancel() should NOT call cancel and should not reject. **Fix**: Depends on flush/cancel mutual exclusion from cancel.any.js fixes above.

---

## Phase F: pipeTo Write-Completion Timing (+8-12 tests) — High complexity, depends on Phase E

**Files**: `src/pipe-to.js`, `src/writable.js`

**Test commands**:
```bash
node test/run-wpt.js --mode=fast --filter=piping --verbose
# Individual files for focused iteration:
node test/run-wpt.js --mode=fast --filter=piping/abort --verbose
node test/run-wpt.js --mode=fast --filter=piping/error-propagation-forward --verbose
node test/run-wpt.js --mode=fast --filter=piping/multiple-propagation --verbose
node test/run-wpt.js --mode=fast --filter=piping/general --verbose
```

**Failing tests → root cause → fix**:

1. `abort.any.js: all pending writes should complete on abort` (3 tests, different reasons)
   - **Cause**: With HWM: Infinity and 2 enqueued chunks, when abort signal fires, both writes should complete before abort action. `currentWrite` in pipeTo tracks only the latest write promise, but with HWM=Infinity the pump loop writes both chunks immediately — they're both in the queue. When abort fires, `shutdownWithAction` waits for `currentWrite` (the last write) but the first write may still be pending.
   - **Fix**: Track an array of all pending writes: `pendingWrites.push(writer.write(value))`. In `shutdownWithAction`, wait for `Promise.all(pendingWrites)` instead of just `currentWrite`.

2. `abort.any.js: abort should do nothing after the readable is closed` and `abort should do nothing after the readable is errored`
   - **Cause**: After readable closes, pipeTo starts shutdown via `reader.closed` handler which sets `shuttingDown = true`. But the abort handler may fire in the same microtask before shutdown completes. When `shuttingDown` is true, the abort handler should be a no-op. The issue is that `shuttingDown` is set synchronously but the shutdown action runs asynchronously.
   - **Fix**: In the abort handler, check `shuttingDown` *before* doing anything. Currently it does — but the abort handler also calls `writer.abort()` which transitions the writable to erroring. This happens before `shuttingDown` is set because the source close handler runs on a microtask. **Fix**: Set `shuttingDown = true` in the reader.closed handler *synchronously* before awaiting the close action.

3. `error-propagation-forward.any.js: shutdown must not occur until the final write completes` (2 tests)
   - **Cause**: Same as abort.any.js — multiple pending writes and `currentWrite` only tracks one.
   - **Fix**: Same as abort fix — track all pending writes.

4. `multiple-propagation.any.js` (4 failures)
   - **Cause**: Complex interactions between errored source + erroring/closing/errored dest. Error identity through pipeTo is wrong.
   - **Fix**: Ensure that when both source errors and dest errors, pipeTo rejects with the correct error per spec (source error takes priority in some cases, dest error in others). Trace each failing test individually.

5. `general.any.js: Process killed (timeout)` — the entire file times out
   - **Cause**: One test hangs the subprocess. Need to identify which one.
   - **Fix**: Add instrumented logging or bisect by commenting out tests. Most likely a pipeTo that never settles because a write never completes.

6. `pipe-through.any.js: invalid values of signal should throw`
   - **Cause**: The test creates an AbortSignal in the VM context and passes it to pipeThrough. Our check `signal instanceof AbortSignal` uses the module-context AbortSignal, not the VM-context one.
   - **Fix**: Check `typeof signal.aborted === 'boolean'` as a duck-type check, or access AbortSignal from the VM context.

7. `then-interception.any.js: piping should not be observable`
   - **Cause**: Our pipeTo uses `.then()` on promises, which can be intercepted by a patched `Promise.prototype.then`. The spec requires that internal promise operations are not observable.
   - **Fix**: This is extremely hard to fix correctly. Requires using internal microtask scheduling instead of `.then()`. Low priority — 1 test.

---

## Phase C: Tee Implementation (+6 fast-only tests) — High complexity, depends on Phase G

**Files**: `src/readable.js` (new tee algorithm)

**Test commands**:
```bash
node test/run-wpt.js --mode=fast --filter=tee --verbose
# This matches 3 files including readable-byte-streams/tee.any.js (all 39 passing) and
# readable-streams/tee.any.js (13/26, 7 shared with native)
```

**Failing tests → root cause → fix**:

Currently tee() materializes to native. Native tee works for basic cases but loses error identity and can't aggregate cancel reasons. 6 tests fail that pass in native:

1. `errors in the source should propagate to both branches` — error identity lost through materialization
2. `canceling both branches should aggregate the cancel reasons into an array` (2 tests) — native tee aggregates but our materialization layer may not pass it through
3. `failing to cancel the original stream should cause cancel() to reject on branches` — cancel rejection identity lost
4. `erroring a teed stream should properly handle canceled branches` — error identity lost
5. `failing to cancel when canceling both branches in sequence with delay` — cancel rejection identity lost

**Fix**: Implement `tee()` in pure JS without materializing:
```js
tee() {
  const reader = this.getReader();
  let canceled1 = false, canceled2 = false;
  let reason1, reason2;
  let reading = false;
  let branch1Buffer = [], branch2Buffer = [];
  // ... create two FastReadableStream shells with pull/cancel handlers
  // pull: read from source reader, push to both branches
  // cancel: track per-branch, aggregate when both cancel
}
```

This is the most complex single phase (~100-150 lines of new code) but it's well-isolated.

---

## Implementation Order

```
Phase E (writable abort)  ─┐
Phase G (reader identity) ─┤─── all independent, can run in parallel
Phase H (async iterator)  ─┤
Phase D (pull timing)     ─┘
                            │
Phase A (transform desiredSize) ── independent
                            │
Phase B (transform cancel)  ── depends on A
Phase F (pipeTo timing)     ── depends on E
Phase C (tee)               ── depends on G
```

## Projected Results

| Phase | Tests Fixed | Cumulative | Rate |
|---|---|---|---|
| Current | — | 978 | 90.4% |
| E: Writable abort edges | +5 | 983 | 90.8% |
| G: Reader error identity | +6 | 989 | 91.4% |
| H: Async iterator ordering | +5 | 994 | 91.9% |
| D: Readable pull timing | +4 | 998 | 92.2% |
| A: Transform desiredSize | +7 | 1005 | 92.9% |
| B: Transform cancel lifecycle | +12 | 1017 | 94.0% |
| F: pipeTo timing | +10 | 1027 | 94.9% |
| C: Tee implementation | +6 | 1033 | 95.5% |

**Conservative estimate: 1027-1033/1082 (94.9-95.5%)**

Remaining ~49-55 failures would be:
- 7 shared with native (tee constructor check, owning-type, queuing-strategies size constructor, async-iterator prototype)
- 5 owning-type (Node.js doesn't support `type: 'owning'`)
- 5-10 deeply-coupled timing issues (then-interception, recursive abort, byte-stream edge cases)
- ~20 diminishing returns (each requiring disproportionate effort)
