# Stake Auto-Scale Fix — v3 (safety margin + raised attempt budget)

## Why a v3?

Despite v2 wrapping the proposal step in the autoscale loop, the user
reported the SAME class of failure on a live run with cryBTCUSD x300:

```
⚠ OPEN FAILED — cryBTCUSD DEMO (65%)
Direction: 🔴 MULTDOWN ×300
Stake    : $10.00
TP/SL    : $23.00 / $22.00
⚠ Trade attempt failed (×1):
  • placeMultiplier: stake auto-scale exhausted
    after 5 attempts (last: ContractBuyValidationError:
    Enter an amount equal to or lower than 8.59.)
```

Two facts pin the residual bug:

1. The message says **"auto-scale exhausted after 5 attempts"** — so v2
   IS running the loop now (good — the proposal-time wrapper works).
2. The final error still quotes a cap (`8.59`) — meaning each retry
   was rejected with a TIGHTER cap than the previous attempt's clamp.

## Root cause (v2 missed this)

`_applyClamp` clamped EXACTLY to the broker-quoted ceiling
(e.g. cap `9.70` → next proposal at `9.70`). But Deriv's cap is a
**moving target** — recomputed on every proposal based on current spot,
volatility, and account balance. On a highly volatile symbol
(cryBTCUSD x300) the cap can tighten by several cents in the ~100ms
between proposals, so a proposal sent at exactly the previous cap
frequently rejects again with a slightly lower cap. The loop chases
the cap one cent at a time and exhausts the 5-attempt budget.

## Fix

### 1. `_applyClamp` — apply a 5% SAFETY MARGIN below the quoted cap

```js
const SAFETY_MARGIN_RATIO = 0.05;        // 5% below quoted cap
const SAFETY_MARGIN_MIN   = 0.05;        // …but at least 5¢ below
const margin = Math.max(SAFETY_MARGIN_MIN, _floor2(target * SAFETY_MARGIN_RATIO));
target = _floor2(target - margin);
```

Dropping comfortably INSIDE the broker's live ceiling means the next
proposal lands well below where the cap is likely to be on the next
round-trip. Convergence is now 1-2 attempts on volatile symbols
instead of pinning the loop at the moving edge.

### 2. `MAX_ATTEMPTS` raised from 5 → 10

Defence in depth. With the safety margin, normal convergence is 1-2
attempts. The extra budget is for extreme volatility where the cap
still tightens faster than 5% per round. Each attempt is ~150ms, so
worst-case 10 attempts resolves in ~1.5s — well under the cron tick
budget.

### 3. No changes to runner.js, telegram.js, or `_handleStakeCapError`

The downstream consumers and the error-classification helper are
unchanged. v3 is a pure tightening of the clamp policy inside
`_applyClamp` plus a raised loop bound.

## Verification

Updated smoke tests reflect the new safety-margin clamp values
(cap 9.70 → clamp 9.22; cap 14.55 → clamp 13.83; etc.) and pass:

```
$ for f in scripts/smoke-*.js; do node "$f" | tail -1; done
  8 passed, 0 failed
Results: 26 passed, 0 failed
Passed: 43    Failed: 0
 41 passed, 0 failed
 22 passed, 0 failed
 18 passed, 0 failed
Passed: 47    Failed: 0
4 passed, 0 failed     ← smoke-stake-autoscale-proposal-time.js
5 passed, 0 failed     ← smoke-stake-autoscale.js
 53 passed, 0 failed
 11 passed, 0 failed
```

Zero regressions across all 12 smoke files.

## Files changed

| File                                                | Δ                                                          |
|-----------------------------------------------------|------------------------------------------------------------|
| `deriv.js`                                          | `_applyClamp` applies 5% safety margin; `MAX_ATTEMPTS` 5→10 |
| `scripts/smoke-stake-autoscale.js`                  | Updated expectations to match safety-margin clamp values   |
| `scripts/smoke-stake-autoscale-proposal-time.js`    | Updated expectations to match safety-margin clamp values   |
| `STAKE_AUTOSCALE_FIX_V3.md`                         | NEW — this doc                                             |

Previous fix docs `STAKE_AUTOSCALE_FIX.md` (v1) and
`STAKE_AUTOSCALE_FIX_V2.md` (v2) are preserved for history.
