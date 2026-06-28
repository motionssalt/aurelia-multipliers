# TP/SL Range Fix — v5 (remove the stake auto-scale loop entirely)

> **Status:** active. Supersedes v1, v2, v3 (which have been deleted from
> the repo together with their smoke tests) and supersedes v4 in part —
> v4's pre-flight clamp logic is retained, but v4 still left the v1–v3
> "stake auto-scale" retry loop in `placeMultiplier` as a fallback, and
> that loop is what produced the
> `placeMultiplier: stake auto-scale exhausted after 10 attempts (last: …Enter an amount equal to or lower than 9.33.)`
> error visible in the latest Telegram screenshot (`cryBTCUSD ×200 MULTUP`).

## Why a v5?

The user reported — repeatedly, including a hands-on verification on
Deriv's main platform — that **the cap error is NOT a stake cap**. On
the affected trades the broker's quoted ceiling refers to either
`validation_params.stop_loss.max` or `validation_params.take_profit.max`,
not `validation_params.stake.max`. Deriv reuses the *identical* error
wording for all three caps:

| Cap class                | `validation_params` field      |
|--------------------------|--------------------------------|
| per-contract stake       | `validation_params.stake`      |
| per-contract take profit | `validation_params.take_profit`|
| per-contract stop loss   | `validation_params.stop_loss`  |

The v1–v3 retry loop assumed any cap error was a stake cap and shrank
the stake (+ proportionally TP/SL) on every iteration. When the real
offender is the stop_loss range, shrinking the stake does not move the
SL value into the live SL range — it just shrinks the SL proportionally
on top of the SL still being out of range, and the loop diverges /
exhausts its 10-attempt budget. The user's frustration is correct: the
loop never fixed the actual problem.

v4 introduced the right idea (read `validation_params` from the
proposal response and clamp TP/SL into range) but left the legacy loop
in place as a fallback "in case validation_params didn't help". That
fallback path is exactly what continued to fire on the cryBTCUSD ×200
trade.

v5 **deletes the loop entirely** and replaces `placeMultiplier` with a
clean single-pass, validation-params-driven flow.

## The new flow (single pass, no stake auto-scaling)

```
 ┌─────────────────────────────────────────────────────────────────┐
 │ 1. PROBE   →  proposal (no limit_order) at the user's stake     │
 │              → returns validation_params.{stake,take_profit,    │
 │                                            stop_loss} ranges    │
 ├─────────────────────────────────────────────────────────────────┤
 │ 2. STAKE GUARD                                                  │
 │       if stake > vp.stake.max  → throw "stake above broker max" │
 │       if stake < vp.stake.min  → throw "stake below broker min" │
 │       (we DO NOT silently rewrite the user's stake — that's     │
 │        the v1–v3 mistake)                                       │
 ├─────────────────────────────────────────────────────────────────┤
 │ 3. CLAMP   →  apply vp.{take_profit,stop_loss} to the outgoing  │
 │              limit_order (2 % safety inset inside the band)     │
 ├─────────────────────────────────────────────────────────────────┤
 │ 4. PROPOSAL (real, with the in-range limit_order)               │
 │       if the new proposal's vp tightened relative to step 1     │
 │         (rare; volatile spot moved during the round-trip):      │
 │       re-clamp ONCE and propose again. No second re-clamp,      │
 │       no stake change. If the third proposal also reports a     │
 │       tighter range, we surface Deriv's error verbatim — that   │
 │       means the live range moved past what our TP/SL can ever   │
 │       satisfy and the user should resize the trade.             │
 ├─────────────────────────────────────────────────────────────────┤
 │ 5. BUY     →  any error is surfaced verbatim. No retry, no      │
 │              manufactured "auto-scale exhausted" message.       │
 └─────────────────────────────────────────────────────────────────┘
```

### What was removed (`deriv.js`)

| Removed                  | Why                                                                                                          |
|--------------------------|--------------------------------------------------------------------------------------------------------------|
| `_applyClamp`            | Belonged to the stake-shrinking strategy; the user has explicitly asked for this strategy to be deleted.    |
| `_scaleLimitOrder`       | Only used to proportionally scale TP/SL when stake was shrunk — no caller remains.                          |
| `_handleStakeCapError`   | The whole error-class-as-control-flow dispatcher is gone; cap errors no longer drive recovery logic.        |
| `for attempt = 1..MAX_ATTEMPTS` retry loop | Replaced by a single-pass probe → clamp → proposal → buy sequence with at most one re-clamp on the proposal step. |
| `SAFETY_MARGIN_RATIO`, `SAFETY_MARGIN_MIN`, `MAX_ATTEMPTS`, `ABS_MIN_STAKE` constants | Belonged to the deleted loop.                  |
| `"stake auto-scale exhausted after N attempts"` error path | No longer reachable. The runner now sees the broker's real error message or a clean stake-out-of-range. |

### What was kept (`deriv.js`)

| Kept                       | Purpose                                                                                       |
|----------------------------|-----------------------------------------------------------------------------------------------|
| `_parseValidationParams`   | Authoritative reader of `proposal.validation_params.{stake,take_profit,stop_loss}`.           |
| `_clampToRange`            | Clamps a value into `{min, max}` with a 2 % safety inset.                                     |
| `_applyTpSlRanges`         | Applies vp to a limit_order, returns adjustments record.                                      |
| `probeMultiplierRanges`    | Standalone helper for the runner's pre-flight probe (unchanged).                              |
| `_extractMaxAmountFromError`, `_extractMinStakeFromError`, `_extractMaxStakeFromError` (alias) | Retained as diagnostic regex parsers used in logging / other smoke tests. No longer drive control flow in `placeMultiplier`. |
| `_floor2`                  | Float-fuzz-safe 2-decimal floor. Used by `_clampToRange`.                                     |

### Cascading edits

| File                  | Change                                                                                                                                                                                                                |
|-----------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `runner.js`           | The `executeOpen` path no longer uses `clamp.final_stake` for the effective stake (it's always equal to the requested stake in v5). The TP/SL effective values still come from `clamp.{final_take_profit,final_stop_loss}` when a clamp happened. The Logger line was renamed from `"open: stake auto-scaled by broker"` → `"open: TP/SL clamped into broker range (v5 pre-flight)"`. |
| `telegram.js`         | The `🔧 Stake auto-scaled by broker: …` subline now branches on `clamp.kind`. v5 clamps render as `🔧 TP/SL clamped into broker range · TP $X→$Y · SL $A→$B`. The legacy subline shape is still rendered if any legacy clamp metadata ever surfaces (defensive). |
| `scripts/smoke-tp-sl-clamp-v5.js` (NEW) | 9 assertions covering the v5 flow:  legacy helpers absent (×3); happy path (in-range TP/SL); the reported bug scenario (SL=22 vs cap 8.59); stake-above-broker-max throws clean error; range tightening between probe and proposal triggers one re-clamp; unrelated errors bubble verbatim; helpers are retained. |
| `scripts/smoke-stake-autoscale.js` (DELETED) | Tested the v1 buy-time autoscale path that no longer exists.                                                                                                                                                          |
| `scripts/smoke-stake-autoscale-proposal-time.js` (DELETED) | Tested the v2 proposal-time autoscale path that no longer exists.                                                                                                                                                     |
| `STAKE_AUTOSCALE_FIX.md`, `STAKE_AUTOSCALE_FIX_V2.md`, `STAKE_AUTOSCALE_FIX_V3.md` (DELETED) | Documented the wrong-headed fix the user has now asked to be removed.                                                                                                                                                 |
| `TP_SL_RANGE_FIX_V4.md` | Retained for history (v4's probe + AI-prompt + soft-clamp layers in `runner.js` and `ai-client.js` are still present and unchanged).                                                                                  |

## Why this fixes the cryBTCUSD ×200 / ×300 OPEN FAILED bug

Walking the screenshot through the new flow:

- `cryBTCUSD ×200`, `stake=$20`, `TP=$40`, `SL=$20`.
- Step 1 probe returns `validation_params.stop_loss = { min: 0.51, max: 9.33 }` (the `9.33` from the error message).
- Step 2 stake guard: `20 < vp.stake.max` → pass.
- Step 3 clamp: SL `$20 → ~$9.14` (9.33 − 2 % of band). TP `$40` is checked against `vp.take_profit.max` and clamped if necessary.
- Step 4 real proposal carries `limit_order = { take_profit: ~min(40, vp.TP.max), stop_loss: ~9.14 }`. The broker accepts.
- Step 5 buy succeeds. Telegram shows `Opened ✅ 999…` plus a `🔧 TP/SL clamped into broker range · SL $20.00→$9.14` subline.

There is no path that produces `"stake auto-scale exhausted after N attempts"` because that code is gone.

## Verification

```
$ for f in scripts/smoke-*.js; do node "$f" | tail -3; done | grep -E "passed|failed|OK"
   8 passed, 0 failed       ← smoke-buy-failure-detection
  26 passed, 0 failed       ← smoke-fixes
  43 passed, 0 failed       ← smoke-multiplier-chart
  41 passed, 0 failed       ← smoke-multiplier-cycle
  22 passed, 0 failed       ← smoke-multiplier-decision
  18 passed, 0 failed       ← smoke-multiplier-idle-skip
  47 passed, 0 failed       ← smoke-multiplier-tick-summary
  53 passed, 0 failed       ← smoke-state
  11 passed, 0 failed       ← smoke-three-fixes
   9 passed, 0 failed       ← smoke-tp-sl-clamp-v5 (NEW)
  47 passed, 0 failed       ← smoke-tp-sl-ranges
              -----
                325 assertions, zero failures
```

Zero regressions across the existing 316 assertions; 9 new v5-specific
assertions including a direct re-creation of the user's reported
screenshot scenario.

## Operator notes

- **If the live broker stop_loss range cannot satisfy the AI's chosen SL** (e.g. AI wants `$22` on a contract whose live SL max is `$8.59`), v5 will **clamp the SL into the broker range** and let the trade open. The trade is intentionally opened with a tighter SL than the AI requested, with a Telegram subline making the adjustment visible. This is preferable to OPEN FAILED with no recovery.
- **If the user's stake itself is genuinely above `validation_params.stake.max`** (extremely rare — would imply the AI sized a single contract above the per-contract ceiling, e.g. `stake > $10000` on a low-multiplier symbol), v5 raises a clean `placeMultiplier: stake X above broker max Y for SYMBOL ×M. Resize the trade or pick a lower multiplier.` The runner surfaces this as the OPEN FAILED reason — *but the loop is no longer hiding the real problem behind 10 silent retries.*
