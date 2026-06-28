# Stake Auto-Scale Fix

## Problem (from Telegram screenshot)

```
⚠️ OPEN FAILED — cryBTCUSD 🟡 DEMO (65%)
Direction : 🟢 MULTUP ×200
Stake     : $10.00
TP / SL   : $21.00 / $21.00
⚠️ Trade attempt failed (×1):
  • ContractBuyValidationError:
    Enter an amount equal to or lower than 9.70.
```

Deriv refused the buy because the per-contract ceiling for
`{cryBTCUSD, x200, balance≈$9.9k}` was `$9.70`, not the `$10.00` the AI
sized to. The trade simply died — no position opened, no recovery.

## Root cause

`deriv.js → placeMultiplier()` had a **single-shot** retry path that:

1. Parsed `"equal to or lower than 9.70"` from the error ✓
2. Re-proposed at `$9.70` ✓
3. **But kept TP/SL at `$21`** — and Deriv's `limit_order.max_take_profit`
   scales with stake. A `$21` TP that is fine for `$10` stake gets
   rejected at `$9.70`, so the retry failed too and bubbled up as
   `OPEN FAILED`.

There were also two secondary defects:

- The retry was hard-coded to **exactly one attempt**, so any second cap
  encountered (e.g. proposal volunteering a tighter `validation_params.max_stake`
  on re-propose) would also fail.
- `Math.floor(9.70 * 100) / 100` returns `9.69` due to JS float fuzz
  (`9.70 * 100 → 969.999…`), silently shaving 1¢ off the broker's
  stated ceiling for no reason.

## Fix

### 1. `deriv.js` — robust auto-scale loop

Replaced the single try/catch with a **5-attempt retry loop** that:

- Re-proposes at the clamped stake.
- **Proportionally scales `take_profit` and `stop_loss`** by the same
  ratio (`new_stake / old_stake`) so they never independently violate
  Deriv's `limit_order` validator.
- Also honors `proposal.validation_params.max_stake` pre-emptively
  (existing behavior, preserved).
- Refuses to clamp below `config.stake.absolute_min` (0.35 USD) — surfaces
  a clean explanatory error in that pathological case instead of placing
  a sub-minimum trade.
- Bubbles up non-stake-cap errors untouched (auth, network, etc.).

Helpers added: `_isStakeCapError`, `_floor2` (float-fuzz-safe),
`_scaleLimitOrder`.

### 2. `deriv.js` — return clamping metadata

`placeMultiplier()` now attaches `buy._aurelia_stake_clamp` whenever a
clamp happened:

```js
{
  requested_stake: 10,   final_stake: 9.70,
  requested_take_profit: 21, final_take_profit: 20.37,
  requested_stop_loss:   21, final_stop_loss:   20.37,
}
```

### 3. `runner.js` — use effective values downstream

The runner's `executeOpen` now reads `buy._aurelia_stake_clamp` and uses
the **effective** stake/TP/SL for:

- `capital_remaining` deduction (otherwise we'd over-deduct).
- The persisted `SiblingRecord` (otherwise the position tracker
  expects a TP/SL the broker never accepted, drifting settlement math).

It also pushes `{ stake_autoscaled: clamp }` onto the result row so the
Telegram template can render a soft-warning subline.

### 4. `telegram.js` — render auto-scale subline

When `executed.details[i].stake_autoscaled` is present alongside a
`contract_id`, the tick summary now shows:

```
Opened    : ✅ 999111222
🔧 Stake auto-scaled by broker: $10.00 → $9.70 · TP $21.00→$20.37 · SL $21.00→$20.37
```

instead of `⚠️ OPEN FAILED`. The header label correctly stays as
🆕 OPEN (only flips to OPEN FAILED when *every* sibling errored).

## Verification

New end-to-end smoke test mocks the exact ws traffic from the
screenshot and asserts the recovery path:

```
$ node scripts/smoke-stake-autoscale.js
 OK   extractMaxStakeFromError parses "Enter an amount equal to or lower than 9.70."
 OK   placeMultiplier retries with clamped stake AND scaled TP/SL on cap error
 OK   placeMultiplier still bubbles UP truly fatal errors (unrelated to stake cap)
 OK   placeMultiplier respects ABS_MIN_STAKE — below 0.35 cap
 OK   Telegram multiplierTickSummary renders "Stake auto-scaled" subline (no OPEN FAILED)
5 passed, 0 failed
```

All 11 pre-existing smoke suites still pass (zero regressions).

## Files changed

| File                                  | Δ                                           |
|---------------------------------------|---------------------------------------------|
| `deriv.js`                            | retry loop, TP/SL scaling, float-fuzz fix   |
| `runner.js`                           | use effective stake/TP/SL, push autoscale   |
| `telegram.js`                         | render `🔧 Stake auto-scaled` subline      |
| `scripts/smoke-stake-autoscale.js`    | NEW — 5 end-to-end checks                   |
| `STAKE_AUTOSCALE_FIX.md`              | NEW — this doc                              |
