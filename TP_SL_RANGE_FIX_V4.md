# TP/SL Range Fix — v4 (the REAL fix for the cryBTCUSD x300 OPEN FAILED bug)

## Why a v4?

v3 assumed every `"Enter an amount equal to or lower than X"` error was a **stake** cap and
shrank the stake (with TP/SL scaled proportionally). The user opened the same contract
on Deriv's main platform and confirmed: **the stake was fine. The 8.59 was the live
STOP LOSS cap.**

Deriv uses the *exact same wording* for three different cap classes:

| Cap class            | Source field in `proposal.validation_params` |
|----------------------|----------------------------------------------|
| per-contract stake   | `validation_params.stake.{min, max}`         |
| per-contract take profit | `validation_params.take_profit.{min, max}` |
| per-contract stop loss   | `validation_params.stop_loss.{min, max}`   |

These ranges are **dynamically computed** by Deriv each tick from
`stake × multiplier × spot × balance`, so a fixed config value can fall outside
the range on a volatile candle and trigger `ContractBuyValidationError`.

Reference: [Deriv proposal response schema](https://developers.deriv.com/schemas/proposal_response.schema.json)
→ `proposal.validation_params`.

## The fix — four cooperating layers

### Layer 1 — `deriv.js`: parse + clamp from proposal
- New `_parseValidationParams(prop)` extracts the three `{min, max}` ranges as numbers.
- New `_clampToRange(value, range)` clamps with a 2 %-of-band safety inset
  (so we don't land *exactly* on the boundary that may shift on the next proposal).
- New `_applyTpSlRanges(limit_order, vp)` clamps `take_profit` and `stop_loss`
  in the outgoing `limit_order`, returns an audit record of what was changed.
- `placeMultiplier` now calls these on **every proposal** (section 1b) and
  re-proposes when an adjustment was made — so the broker sees the in-range
  values before the buy.
- The error handler `_handleStakeCapError` now first tries to attribute the cap
  to TP/SL via `validation_params` before falling back to the legacy stake-cap
  interpretation.
- The cap-error parser is renamed `_extractMaxAmountFromError`
  (alias `_extractMaxStakeFromError` retained for back-compat).

### Layer 2 — `deriv.js`: pre-flight probe helper
- New `probeMultiplierRanges(ws, opts)` sends a TP/SL-less proposal to discover
  the live `validation_params` for `{symbol, direction, stake, multiplier}` —
  *without* buying the contract. Used by the runner to populate the AI's
  context BEFORE the AI is asked.

### Layer 3 — `runner.js`: probe + inject into `aiInput`
- New `_probeTpSlRanges(ws, config, state, symbol)` calls
  `probeMultiplierRanges` for every valid multiplier on the active symbol at
  `config.stake.absolute_min` as the reference stake.
- Both the cycle path and the manual path inject the result as
  `aiInput.tp_sl_ranges` with this shape:

  ```jsonc
  {
    "probe_stake": 1.00,
    "by_multiplier": {
      "100": { "ranges": {"stake":{...}, "take_profit":{...}, "stop_loss":{...}},
               "spot": 67234.5, "ask_price": 1.00, "commission": 0.00 },
      "200": { ... },
      "300": { ... }
    }
  }
  ```

- The probe is **best-effort**: if it fails (WS hiccup, symbol temporarily
  unavailable) the AI sees `tp_sl_ranges: null` and falls back to conservative
  defaults. The tick is never blocked by a probe failure.

### Layer 4 — `ai-client.js`: prompt + soft-clamp
- New `_renderTpSlRangesForPrompt(aiInput)` formats the probed ranges as a
  compact table the AI can read directly. Inserted into the multiplier prompt
  with a clear explanation that TP/SL caps scale linearly with stake.
- `_validateOpenSpec` now rescales the probed range to the AI's chosen stake
  (`scale = open.stake / probe_stake`) and **soft-clamps** out-of-range
  TP/SL values (rather than hard-rejecting them — which would cascade into
  silent holds every tick). Warnings are surfaced to the runner via the
  validator return shape, then logged.

## Verification

47 new unit tests in `scripts/smoke-tp-sl-ranges.js`:

```
--- T1: _parseValidationParams ---            8 cases
--- T2: _clampToRange ---                     5 cases
--- T3: _applyTpSlRanges ---                 13 cases
--- T4: _extractMaxAmountFromError ---        3 cases
--- T5: ai-client soft-clamp ---             11 cases
--- T6: prompt rendering ---                  7 cases
========================
  47 passed, 0 failed
========================
```

Including a direct re-creation of the user's reported scenario (T3.1–T3.6):
TP=23, SL=22, broker SL max = 8.59 → SL clamped to ≈8.43 (2 % safety inset
inside the band), TP=23 left alone (it's inside the $50 TP cap).

All existing smoke tests (12 suites, 200+ cases) still pass.

## Expected behaviour now

When the same `cryBTCUSD x300` trade is attempted:
- **Layer 3** probe runs → AI prompt includes
  `LIVE TP/SL ranges (probed THIS tick at stake=$1.00): x300: TP ∈ $0.10..$50.00   SL ∈ $0.51..$8.59`
- **Layer 4** validates AI output: if AI's stake=$10 the SL cap is rescaled
  to $85.90 → an SL of $22 is now obviously in-range. If AI mistakenly
  picks SL=$200, soft-clamp kicks in with a warning.
- **Layer 1** in-flight verification: even if the probe drifted, `placeMultiplier`'s
  clamp catches a final out-of-range SL before the doomed buy is sent.
- Result: the trade opens successfully at a safe SL value, with a soft-warning
  in the Telegram tick summary showing the auto-correction (if any).
