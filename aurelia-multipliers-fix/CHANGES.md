# AURELIA-MULTIPLIERS — WS-stale-after-AI-think fix

## Repo
`motionssalt/aurelia-multipliers` @ commit `056f529` (main)

## The bug
When a slow AI provider (Gemini long-think / OpenRouter reasoning
models like NVIDIA Nemotron) takes long enough to return a decision,
the Deriv OTP-backed WebSocket reaches `readyState=2/3` before the
runner can use it. This caused two visible failures the user reported:

1. The trade fails to place (sometimes) — `WS not open (state=...)`
   raised synchronously inside `Deriv.request()` before `buy` /
   `sell` / `contract_update` ever hits the wire.
2. The chart doesn't load up after the trade has been placed — the
   chart fetch (`Deriv.ticksHistory(ws, ...)`) hits the same stale
   socket and `renderMultiplierSnapshot` throws, so the per-tick
   Telegram message arrives without its candle screenshot.

The codebase already had `Deriv.ensureOpen()` and was wiring it into
the OPEN side (`placeAndSettle` for binary, `openSibling` for
multiplier). It was NOT wired into:

* `executeCloseList` — `sell` calls
* `executeReviseList` — `contract_update` calls
* the post-trade chart-render step (cycle path **and** manual path)
* the post-buy chart attached to the binary trade-placement
  notification

## Fix
Two files modified. No new files, no new dependencies, no API
breakage — every new parameter is optional and prior call sites
(including all `scripts/smoke-*.js`) work unchanged.

### `runner.js`

| Rule | Implementation |
| --- | --- |
| Auto-heal the WS right before every multiplier `sell` | `executeCloseList(ws, …, connOpts)` calls `Deriv.ensureOpen(ws, connOpts, { context: 'sell (close)', timeoutMs: 8000 })` immediately before `closeMultiplier`. `connOpts` is optional → smoke tests unaffected. |
| Auto-heal the WS right before every multiplier `contract_update` | `executeReviseList(ws, …, decisionId, connOpts)` calls `Deriv.ensureOpen(ws, connOpts, { context: 'contract_update (revise)', timeoutMs: 8000 })` immediately before `reviseMultiplierLimits`. |
| Thread `connOpts` through the cycle dispatcher | `runMultiplierCycle`'s decision branches (`close` / `revise` / `multi.close` / `multi.revise`) now pass `connOpts` into the helpers. Same thread added to the manual path inside `runManual`. |
| Auto-heal the WS right before the cycle's per-tick chart | Before `Chart.renderMultiplierSnapshot(...)` in `runMultiplierCycle`, call `Deriv.ensureOpen` so the candle fetch sees an OPEN socket. Rebind local `ws` from the chart layer's returned `ws` so any follow-up call on the same tick reuses the healed socket. |
| Auto-heal the WS right before the manual path's chart | Same recovery applied around the `renderMultiplierSnapshot` + `generateChart` fallback in `runManual`. `generateChart` fallback now also receives `connOpts`. |
| Auto-heal the WS right before the binary path's post-buy chart | In `placeAndSettle.onPlaced`, `Chart.generateChart` is now called with `{ connOpts: opts && opts.connOpts }` so the chart fetch can self-heal one more time after `buy` succeeded. |

### `chart.js`

| Rule | Implementation |
| --- | --- |
| Candle fetch must survive a single closed-WS race | New private helper `_fetchCandlesResilient(ws, …, connOpts, label)` wraps `Deriv.ticksHistory`. On a closed-socket error (regex matches "WebSocket closed", "WS not open", "state=2/3", ECONNRESET, EPIPE, opcode, 1006, 1001) it calls `Deriv.ensureOpen` once and retries. With no `connOpts` it behaves exactly as before — one shot, throw on failure. |
| `generateChart` accepts `opts.connOpts` (optional) | New 4th argument `opts` (object). Pulls `connOpts` from it and uses the resilient fetcher. Signature is backwards compatible — existing 3-arg calls keep working. |
| `renderMultiplierSnapshot` accepts `opts.connOpts` (optional) | Same recovery applied to the multiplier candle fetch. |
| Surface the (possibly fresh) `ws` back to callers | `renderMultiplierSnapshot` return value now includes the post-recovery `ws` so the runner can rebind its local socket on the same tick and avoid hitting the same stale-socket failure on the next request. |

## Outcome
Whenever the AI's reasoning time closes the socket out from under us,
the runner now silently re-issues a fresh OTP + WS exactly once, both
before placing the trade AND before rendering the chart. The user
sees the Telegram trade-placed message AND the chart for the tick,
which is what the bug report asked for.

## Smoke verification
All multiplier smoke tests that exercise the changed code paths still
pass:

```
smoke-multiplier-cycle    41 / 41
smoke-multiplier-decision 22 / 22
smoke-multiplier-chart    43 / 43
smoke-multiplier-idle-skip 18 / 18
smoke-tp-sl-revise-clamp  10 / 10
smoke-revision-history    ALL CHECKS PASSED
```

The one pre-existing failure in `smoke-three-fixes` ("long rationale
gets truncated AND wrapped in blockquote") reproduces on the
unmodified `main` branch and is unrelated to the WS fix.

## Files changed
```
chart.js   |  +66  -3
runner.js  | +101  -15
```
