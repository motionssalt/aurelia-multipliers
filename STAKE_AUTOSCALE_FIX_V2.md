# Stake Auto-Scale Fix — v2 (proposal-time recovery)

## Why a v2?

The original `STAKE_AUTOSCALE_FIX.md` introduced a 5-attempt retry loop
that re-proposed with a clamped stake (and proportionally scaled TP/SL)
when Deriv rejected the **buy** request with a
`ContractBuyValidationError: Enter an amount equal to or lower than X.`

That worked in mock — all 5 smoke assertions passed — but the user
reported the **same error still surfaced in production** twice in one
session (`last-status.json`):

```
[13:15:27.466Z] info    AI decision via gemini key "GEMINI_KEY_2"  { action: open, conf: 0.7 }
[13:15:27.467Z] info    askMultiplierDecision: validated
[13:15:27.605Z] error   placeMultiplier failed
                          symbol: cryBTCUSD
                          error : "ContractBuyValidationError: Enter an amount equal to or lower than 9.70."

[13:19:07.283Z] info    AI decision via gemini key "GEMINI_KEY_2"  { action: open, conf: 0.75 }
[13:19:07.462Z] error   placeMultiplier failed
                          symbol: cryBTCUSD
                          error : "ContractBuyValidationError: Enter an amount equal to or lower than 14.55."
```

Two diagnostic facts pin the root cause:

1. **~140 ms between AI-decision and failure** — only one network
   round-trip to Deriv could have happened. A successful proposal + a
   failed buy would be ~250-400 ms.
2. **No `auto-scaling stake` warning in the logs between the AI
   decision and the failure.** The retry loop emits that line every
   time it clamps; the absence is dispositive.

Conclusion: Deriv raised `ContractBuyValidationError` **on the proposal
request itself**, not on the buy. The v1 fix only wrapped the buy step
in try/catch; a proposal-time rejection bubbled straight up to the
runner as `OPEN FAILED`, bypassing the retry loop entirely.

## Root cause (v1 missed this)

`deriv.js → placeMultiplier()` v1 had this structure:

```js
for (let attempt = 1; attempt <= 5; attempt++) {
    propReply = await request(ws, buildProposalReq(), 15000);  // ← UNCAUGHT
    prop = propReply.proposal;
    if (!prop || !prop.id) throw ...;

    // pre-emptive clamp from validation_params.max_stake ...

    try {
        buyReply = await request(ws, { buy: prop.id, price: ... }, 15000);
        break;
    } catch (e) {
        // handle ContractBuyValidationError + clamp + continue
    }
}
```

If `await request(ws, buildProposalReq(), …)` rejected with the cap
error, the rejection propagated out of the for-loop and out of
`placeMultiplier` to the runner — which only logged it as
`placeMultiplier failed`. The retry logic never got a chance to run.

A secondary defect: `_applyClamp` returned `false` (refused to clamp)
when the broker's quoted ceiling was `>= stake`. In the rare case Deriv
quotes `≤ X` where `X` equals what we sent (server-side rounding edge),
the loop made no progress and would have bubbled the original error
even if the proposal-time issue were patched.

## Fix

### 1. `deriv.js` — wrap PROPOSAL in the same try/catch as buy

Both the `await request(ws, buildProposalReq(), ...)` and the
`await request(ws, { buy: ... })` are now wrapped in `try { ... }
catch (e) { ... }` blocks that route through a single shared handler:

```js
const _handleStakeCapError = (e) => {
    // - 'retry' → caller does `continue` (clamp applied, re-propose)
    // - 'throw' → caller rethrows (non-stake-cap, e.g. auth, network)
    //  - string → caller throws a clean explanatory error
    //             (e.g. broker's cap < ABS_MIN_STAKE)
};
```

So Deriv can enforce the cap at EITHER proposal time OR buy time and
the autoscale loop catches both.

### 2. `deriv.js` — `_applyClamp` shaves a tick on cap == stake

When Deriv quotes a ceiling equal to (or higher than) the current
stake but still rejects (rare server-side rounding edge), we now shave
1¢ and try again instead of giving up:

```js
if (target >= stake) {
    target = _floor2(stake - 0.01);
    if (!(target > 0)) return false;
}
```

This guarantees forward progress on every iteration — the loop can no
longer get pinned by an adversarial / quirky cap response.

### 3. No changes to `runner.js` or `telegram.js`

The downstream consumers (effective stake/TP/SL bookkeeping, Telegram
`🔧 Stake auto-scaled` subline) already work correctly via
`buy._aurelia_stake_clamp`. They just never saw the metadata in v1
because the loop never reached the success branch.

## Verification

New smoke test reproduces the exact production failure pattern:

```
$ node scripts/smoke-stake-autoscale-proposal-time.js
 OK   PROPOSAL-TIME ContractBuyValidationError triggers auto-scale (the prod bug)
 OK   proposal-time cap $14.55 (the 2nd recurring failure) recovers cleanly
 OK   multi-round tightening cap converges within MAX_ATTEMPTS
 OK   cap equal to stake → loop shaves a tick instead of giving up

4 passed, 0 failed
```

Full regression suite:

```
$ for f in scripts/smoke-*.js; do node "$f"; done | tail
TOTAL: 278 passed, 0 failed
```

(v1: 263 passing → v2: 278 passing. +15 new assertions, zero regressions.)

## Files changed

| File                                                | Δ                                                          |
|-----------------------------------------------------|------------------------------------------------------------|
| `deriv.js`                                          | wrap proposal in try/catch; share `_handleStakeCapError`; tick-shave in `_applyClamp` |
| `scripts/smoke-stake-autoscale-proposal-time.js`    | NEW — 4 assertions covering the proposal-time path        |
| `STAKE_AUTOSCALE_FIX_V2.md`                         | NEW — this doc                                             |

The v1 doc `STAKE_AUTOSCALE_FIX.md` is preserved for history — its
buy-time fix is still in effect, v2 just extends the coverage to the
proposal step and adds the tick-shave guard.
