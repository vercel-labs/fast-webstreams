# WPT Fix Strategy

## Current State
- Original baseline: 487/1019 (47.8%)
- After first round of fixes: ~779/1082 (72%)
- **Current: 905/1082 (83.6%)**
- Target: 95%+ (968/1019)

## What's Been Done (Round 1)
1. **Byte streams**: Delegate to native, don't lock via Readable.fromWeb()
2. **pipeTo**: Always materialize and delegate to native pipeTo for spec compliance
3. **ReadableStream.from()**: Delegate to native, wrap result in Fast shell
4. **Constructor validation**: Eagerly access getters, validate types/callbacks, RangeError for invalid types
5. **Strategy size()**: Delegate entire stream to native when custom size() present
6. **reader.closed identity**: New rejected promise on releaseLock()
7. **Transform cancel/abort**: Wire destroy handler to transformer.cancel()
8. **desiredSize**: Track original HWM for Infinity, fix closed/errored states
9. **Async start ordering**: Chain writes/close behind start() promise in writer
10. **Cancel semantics**: Call underlyingSource.cancel(reason) and return result
11. **Misc**: Pull re-trigger after resolve, close-after-error throws, this binding for callbacks, error wrapping for falsy values, AbortController signal on writable controller

## What's Been Done (Round 2 — 779→883 = +104 tests)
12. **Spec-compliant pipeTo**: Own implementation preserving error identity via reader/writer (not native delegation)
13. **pipeThrough validation**: Correct getter order (readable→writable→locked→options), brand checks, internal pipeTo
14. **tee() wrapping**: Wrap native tee branches in Fast shells for constructor identity
15. **pipeTo option getters**: Evaluated in alphabetical order (preventAbort→preventCancel→preventClose→signal)
16. **reader.cancel()**: Now calls stream._cancelInternal() which calls underlyingSource.cancel()
17. **writer.abort()**: Propagates underlyingSink.abort() rejection via destroy handler callback mechanism
18. **Writable destroy**: Only calls abort during explicit _abortInternal, not on write/close failures
19. **Constructor strategy order**: Strategy converted at IDL layer before underlying sink/source
20. **Size validation**: TypeError for non-function strategy.size
21. **Type validation**: TypeError (not RangeError) for invalid stream types
22. **HWM 0 pull**: Don't auto-pull when highWaterMark is 0
23. **Transform cancel**: Wire readable._cancel → transformer.cancel() with double-call prevention
24. **Reader releaseLock**: Reject pending read requests on release
25. **Constructor garbage**: Throw TypeError for non-object underlying source
26. **HWM ToNumber conversion**: resolveHWM converts via Number(), validates with RangeError
27. **WritableStream close on errored**: TypeError for close() on errored/destroyed streams
28. **controller.signal**: Only abort on explicit _abortInternal, not on write/close failures
29. **Transform start error**: Preserve original rejection error identity

## Remaining Failure Areas (177 failures)

### Piping (~20 failures across 7 files) — MOSTLY FIXED
**Root cause**: Materialization wraps errors — native pipeTo sees wrapped errors instead of originals. Tests use `promise_rejects_exactly()` which checks object identity.

**Fix strategy**: Don't delegate pipeTo to native. Implement our own spec-compliant pipeTo that:
- Reads from the readable and writes to the writable directly
- Preserves error identity through cancel/abort/close propagation
- Supports preventClose/preventAbort/preventCancel options
- Handles AbortSignal

This is the single biggest win (~93 tests). The implementation is ~150 lines following the spec algorithm.

### pipeThrough brand checks (~19 failures)
**Fix**: Reorder getter evaluation (readable before writable), validate types before materializing, throw TypeError for invalid readable/writable.

### Transform streams (~32 failures)
- **backpressure/cancel/terminate**: Close propagation through transform doesn't work when readable side is canceled. Need to wire readable cancel → writable abort on the underlying Node Transform.
- **errors**: Error propagation timing between writable/readable sides of transform.

**Fix strategy**: For complex transform operations (cancel, terminate, error), materialize to native TransformStream.

### Writable aborting (~46 failures)
- **abort() promise semantics**: abort() should reject with sink's abort error, not resolve
- **ready promise**: Should reject on abort, and change identity
- **signal support**: controller.signal needs full AbortController wiring (partially done)
- **start ordering**: abort during start should wait for start

**Fix strategy**: Implement spec-compliant abort that properly rejects/resolves promises and handles the start-pending state.

### Readable streams (~53 failures)
- **tee** (15): tee() returns native streams but tests check constructor identity. Wrap in Fast shells.
- **default-reader** (12): 5 are from native ReadableStreamDefaultReader not accepting Fast streams (fixed by exporting our reader). Others are closed promise semantics.
- **async-iterator** (11): Cancel-on-break/throw needs wiring through materialize.
- **general** (7): desiredSize tracking, constructor arg conversion order.
- **templated** (8): Various constructor/reader edge cases.

### Writable close/write/start (~27 failures)
- **close**: Error during close should reject close promise with the error, abort should interact correctly
- **write**: desiredSize tracking during writes, ready promise semantics
- **start**: Rejected start should prevent writes/closes, desiredSize=0 during start

## Implementation Priority

1. **Implement spec-compliant pipeTo** (+~80 tests) — biggest single win
2. **Fix pipeThrough validation order** (+~10 tests)
3. **Fix tee() to wrap results in Fast shells** (+~10 tests)
4. **Implement proper abort semantics** (+~20 tests)
5. **Fix transform cancel/close propagation** (+~15 tests)
6. **Fix writable start rejection handling** (+~10 tests)
7. **Fix desiredSize tracking in writer** (+~8 tests)
8. **Fix constructor argument conversion order** (+~3 tests)

## Key Architectural Insight

The main remaining failures fall into two categories:

1. **Error identity loss through materialization** — When we call `Readable.toWeb()` then native `pipeTo()`, errors get wrapped by the Node↔WHATWG conversion layer. Fix: implement pipeTo ourselves instead of delegating.

2. **Promise state machine mismatches** — WHATWG has very specific rules about when ready/closed promises change identity, reject, or resolve. Node streams don't have equivalent concepts. Fix: track promise states explicitly rather than deriving from Node stream state.
