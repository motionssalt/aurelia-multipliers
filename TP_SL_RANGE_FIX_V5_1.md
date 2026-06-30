# TP/SL Range Fix — v5.1 (re-enable the auto-adjust after the WS-stale fix)

> **Status:** active. Strictly additive on top of v5.

## The regression

The earlier WS-stale fix (see `CHANGES.md`) wrapped every multiplier
trade call site in the runner with `Deriv.ensureOpen(ws, connOpts, …)`
so a slow / reasoning AI provider could no longer close the OTP socket
out from under us between "AI returned a decision" and "place the
trade".

That fix made the OUTER socket fresh just before `placeMultiplier` /
`reviseMultiplierLimits` was invoked — but each of those functions
runs **multiple WS round-trips internally**:

```
placeMultiplier      :  probe proposal  →  real proposal  →  buy
reviseMultiplierLimits:  POC fetch     →  range probe   →  contract_update
```

Between any two of those round-trips, the OTP session can expire (the
same root cause as the original WS-stale bug — just on a tighter
window). When that happened:

* The probe succeeded and returned `validation_params.{stake,
  take_profit, stop_loss}`.
* `_applyTpSlRanges` computed the correct clamp.
* The next inner `request(ws, …)` call threw `WS not open (state=2/3)`.
* `placeMultiplier` re-threw, the runner logged `placeMultiplier
  failed`, the trade was reported as OPEN FAILED — and the clamped
  TP/SL values **never reached the broker**.

Symptom the user reported: "after fixing the WS-close issue, the
procedure that automatically adjusts TP/SL is no longer working — the
trade still fails."

## The fix

Strictly additive. Make every inner WS round-trip in `placeMultiplier`,
`reviseMultiplierLimits` and `probeMultiplierRanges` self-heal a stale
socket — same `ensureOpen` pattern the runner already uses, just one
layer deeper so it can't be defeated by a mid-sequence OTP expiry.

### `deriv.js`

| Change | Why |
|---|---|
| `placeMultiplier(ws, opts)` now reads `opts.connOpts` and defines an internal `_heal(context)` helper that runs `ensureOpen` whenever `ws.readyState !== OPEN`. | Lets the probe → real proposal → buy sequence survive a stale OTP socket mid-flight. |
| `_heal('placeMultiplier probe (TP/SL range)')` runs before the probe `request`. | Recovers if the socket died between the runner's pre-call `ensureOpen` and the very first proposal. |
| `_heal('placeMultiplier proposal (with clamped TP/SL)')` runs before the real proposal `request` (inside the re-clamp loop). | **This is the exact window the user's bug reproduced in.** With the heal here, the clamp computed off the probe's `validation_params` actually reaches the broker. |
| `_heal('placeMultiplier buy')` runs before the buy `request`. | Same risk window between proposal accept and buy. |
| `reviseMultiplierLimits(ws, contractId, changes, currency='USD', connOpts=null)` — new 5th arg `connOpts`. Internal `_heal` invoked before the POC fetch, before the range probe, and before the `contract_update`. | Same multi-round-trip recovery as `placeMultiplier`. Without this, a stale OTP after the POC fetch silently disabled the TP/SL clamp on revise too (`probeMultiplierRanges` swallows the error and returns `null`). |
| `probeMultiplierRanges(ws, { …, connOpts })` — accepts `connOpts`, self-heals before its single `request`. | Lets the runner's pre-AI `_probeTpSlRanges` loop survive a stale socket so the AI is given real range data instead of a `null` fallback. |

All three heal-helpers short-circuit when `connOpts` is not supplied,
so every existing smoke test and any legacy caller is unaffected.

### `runner.js`

| Change | Why |
|---|---|
| `openSibling` passes `connOpts` into `Deriv.placeMultiplier(ws, { …, connOpts })`. | Wires the heal hook into the place path. |
| `executeReviseList` passes `connOpts` as the 5th arg to `Deriv.reviseMultiplierLimits(ws, cid, changes, currency, connOpts)`. | Wires the heal hook into the revise path. |
| `_probeTpSlRanges(ws, config, state, symbol, connOpts)` — new 5th arg, forwarded into each `Deriv.probeMultiplierRanges(…)` call. Callers in `runMultiplierCycle` and `runManual` updated to pass `connOpts`. | Wires the heal hook into the pre-AI range probe so the AI never silently loses its TP/SL constraint to a stale socket. |

### Tests

| File | Change |
|---|---|
| `scripts/smoke-tp-sl-clamp-v5_1.js` (NEW) | 7 assertions covering: opts/connOpts signatures on all three functions, the `_heal` short-circuit guard, `ensureOpen` no-op on an already-OPEN socket, and the same bug-scenario clamp (`SL=22 vs cap=9.33`) still produces an in-range outgoing value. |
| All existing smoke tests | Unchanged and still pass — v5.1 is additive (no behaviour change when `connOpts` is absent). |

## Verification

```
$ node scripts/smoke-tp-sl-clamp-v5.js          → 9 passed, 0 failed
$ node scripts/smoke-tp-sl-clamp-v5_1.js        → 7 passed, 0 failed   (NEW)
$ node scripts/smoke-tp-sl-revise-clamp.js      → 10 passed, 0 failed
$ node scripts/smoke-tp-sl-ranges.js            → 47 passed, 0 failed
$ node scripts/smoke-multiplier-cycle.js        → 41 passed, 0 failed
$ node scripts/smoke-multiplier-decision.js     → 22 passed, 0 failed
$ node scripts/smoke-multiplier-chart.js        → 43 passed, 0 failed
$ node scripts/smoke-multiplier-idle-skip.js    → 18 passed, 0 failed
$ node scripts/smoke-multiplier-tick-summary.js → 47 passed, 0 failed
$ node scripts/smoke-buy-failure-detection.js   →  8 passed, 0 failed
$ node scripts/smoke-fixes.js                   → 26 passed, 0 failed
$ node scripts/smoke-state.js                   → 53 passed, 0 failed
$ node scripts/smoke-revision-history.js        → ALL CHECKS PASSED
```

The pre-existing `smoke-three-fixes` failure (long rationale truncation
test) reproduces on unmodified `main` and is unrelated.

## Files changed

```
deriv.js                              (in-place edits, additive)
runner.js                             (in-place edits, additive)
scripts/smoke-tp-sl-clamp-v5_1.js     (new)
TP_SL_RANGE_FIX_V5_1.md               (new — this file)
```
