# Part 2b — AI Decision Schema (hand-off to Part 2c)

This part replaced Part 2a's hardcoded `{action:'hold'}` stub with a real
AI call (`AIClient.askMultiplierDecision`) and an explicit, fully-validated
decision schema. The cycle orchestration loop (`runMultiplierCycle`) itself
is unchanged in spirit — only the decision call site is now real, plus a
single new execution branch (`'multi'`) so the AI can express combinations
of actions in one tick (which the original part-2b prompt asked for).

---

## 1. The final decision schema

What the AI returns each tick (and what `validateMultiplierDecision`
guarantees to the runner before it acts on it):

```jsonc
{
  // ─── Required for every response ───────────────────────────────────
  "action":      "hold" | "skip" | "close" | "open" | "revise" | "multi",
  "decision_id": "string",      // opaque short id, propagated into siblings + history
  "rationale":   "string",      // <= 400 chars, free text

  // ─── Optional on every response ────────────────────────────────────
  "confidence":  0.0..1.0,      // omit, or 0..1. If present AND below
                                // config.ai.min_confidence, the decision
                                // is COERCED to action='hold' with a
                                // rationale noting the conf was too low.

  // ─── Required iff action === "close" ───────────────────────────────
  // Each entry must reference a contract_id present in
  // aiInput.open_siblings on THIS tick (not a stale one).
  "close": [
    { "contract_id": 3501118801, "reason": "thesis_flipped" }   // reason optional, <=120 chars
  ],

  // ─── Required iff action === "open" ────────────────────────────────
  // ONE open spec; fan-out into multiple siblings via "siblings".
  "open": {
    "direction":   "up" | "down",            // lowercase, MULTUP/MULTDOWN
    "stake":       12.50,                    // USD per sibling, within
                                             // config.stake.[absolute_min, absolute_max].
                                             // stake * siblings is also checked
                                             // against session.capital_remaining.
    "multiplier":  100,                      // positive integer
    "take_profit": 6.25,                     // number > 0  OR  null  (null = no TP)
    "stop_loss":   6.25,                     // number > 0  OR  null  (null = no SL)
    "siblings":    1                         // integer 1..4 (validator clamps;
                                             // also exported as MAX_OPEN_SIBLINGS_PER_DECISION)
  },

  // ─── Required iff action === "revise" ──────────────────────────────
  // Each entry must reference a contract_id in aiInput.open_siblings.
  // FIELD PRESENCE IS MEANINGFUL — mirrors deriv.reviseMultiplierLimits:
  //    field OMITTED        → leave that limit unchanged
  //    field === null       → CLEAR that limit on the live contract
  //    field === number > 0 → set that limit to this $-amount
  // An entry that omits BOTH take_profit and stop_loss is rejected
  // (no-op revise).
  "revise": [
    { "contract_id": 3501118801, "take_profit": 12.50, "stop_loss": null },
    { "contract_id": 3501118905, "take_profit": null }
  ],

  // ─── Required iff action === "multi" ───────────────────────────────
  // Bundle ONE EACH of close[] / revise[] / open in the same response.
  // The runner dispatches in this fixed order:  close → revise → open
  // (so a new open does not collide with about-to-be-closed siblings).
  // A multi must contain at least one of the three sub-actions; an
  // entry cannot appear in BOTH multi.close[] and multi.revise[].
  "multi": {
    "close":  [ { "contract_id": 3501118801, "reason": "exit_loser" } ],
    "revise": [ { "contract_id": 3501118905, "take_profit": 18.00 } ],
    "open":   {
      "direction": "down", "stake": 6.25, "multiplier": 100,
      "take_profit": 5, "stop_loss": 5, "siblings": 1
    }
  }
}
```

### Field types/ranges in one table (for Part 2c message templates)

| Field path                        | Type            | Required when            | Notes for Telegram rendering                                    |
| --------------------------------- | --------------- | ------------------------ | --------------------------------------------------------------- |
| `action`                          | enum string     | always                   | Pick one of 6 icons / labels.                                   |
| `decision_id`                     | string ≤64      | always                   | Useful for audit links / inline cross-references.               |
| `rationale`                       | string ≤400     | always                   | Safe to surface verbatim in `<i>…</i>`.                         |
| `confidence`                      | 0..1            | optional                 | Render as `(NN%)` — absent means "AI didn't say".               |
| `close[].contract_id`             | positive int    | iff `action='close'`     | Already present as text in tradePlaced template.                |
| `close[].reason`                  | string ≤120     | optional                 | If absent runner uses `'ai_close'`.                             |
| `open.direction`                  | `'up'\|'down'`  | iff `action='open'`      | Map to MULTUP/MULTDOWN + 🟢/🔴 in the UI.                       |
| `open.stake`                      | number          | iff `action='open'`      | USD per sibling.                                                |
| `open.multiplier`                 | positive int    | iff `action='open'`      | `x100`, `x200`, …                                               |
| `open.take_profit`                | number\|null    | iff `action='open'`      | null = "no TP" (stop_out still applies).                        |
| `open.stop_loss`                  | number\|null    | iff `action='open'`      | null = "no SL".                                                 |
| `open.siblings`                   | 1..4 int        | iff `action='open'`      | Always render the count even if 1.                              |
| `revise[].contract_id`            | positive int    | iff `action='revise'`    | Must currently be open.                                         |
| `revise[].take_profit`            | number\|null    | optional per entry       | OMIT/null/number — see semantics above.                         |
| `revise[].stop_loss`              | number\|null    | optional per entry       | Same three-state semantic.                                      |
| `multi.{close,revise,open}`       | same as above   | iff `action='multi'`     | At least one must be present.                                   |

### Runtime exports (for Part 2c)

`ai-client.js` exports:
- `askMultiplierDecision({ aiInput, config, state }) → { decision, keyUsed }`
- `validateMultiplierDecision(raw, aiInput, config) → { ok, decision, errs? }`
- `_buildMultiplierPrompt(aiInput, config)` (exposed for tests; the prompt
  string Part 2c may also want to surface in `/debug` for inspection)
- `MAX_OPEN_SIBLINGS_PER_DECISION = 4`

`runner.js` additionally exports the new execution helpers
(`executeCloseList`, `executeOpenSpec`, `executeReviseList`) for Part 2c
or future smoke tests that want to drive the branches directly.

---

## 2. Verified vs. inferred about Part 1 / 2a

### Verified (read directly out of the code, not just docs)

| Claim | Where it's verified |
| --- | --- |
| `aiInput` shape Part 2a hands to the decision function | `runner.js:1392-1448` — exact field-by-field match with the docstring above the stub. |
| Executor's expectations of the decision shape (close/open/revise) | `runner.js:1467-1557` — including the `hasOwnProperty` checks on `take_profit`/`stop_loss` for the three-state revise semantic. |
| `reviseMultiplierLimits` API: omit / null / number = unchanged / clear / set | `deriv.js:677-740`. The schema mirrors this exactly so the runner's `hasOwnProperty` passthrough at `runner.js:1521-1523` (now in `executeReviseList`) works without re-interpretation. |
| `placeMultiplier` accepts `takeProfit`/`stopLoss` as either omitted (no limit) or positive numbers (`null` not accepted for "no limit" at open time) | `deriv.js:566-631` + `_validateMultiplierOpts` at `deriv.js:511`. Schema enforces this: `open.take_profit/stop_loss` may be `null` (interpreted by the runner as "don't pass the limit_order field"), or a positive number. |
| `Risk.clampStake` clamps against `config.stake.[absolute_min, absolute_max]` and `cycleSessionRemaining` | `risk.js:1-50`. Validator surfaces a hard reject when the AI's own stake is outside the absolute bounds (before clamping), and also rejects `stake * siblings > capital_remaining`. The runner still clamps per-sibling inside `openSibling` as defence-in-depth. |
| `gates.can_open_new` and `gates.reason` are pre-computed by Part 2a | `runner.js:1441-1447`. Validator uses `gates.can_open_new===false` to reject `open` (and `multi.open`) up front. |
| `open_siblings[].contract_id` is the canonical Deriv contract id and is stable | `runner.js:1415` + `STATE_SHAPE.md` "Primary key. Idempotency anchor". Validator builds the allow-set from these. |
| Multi-key Gemini failover behaviour, prompt path | `ai-client.js:226-312`. New `askMultiplierDecision` just supplies a custom `prompt`; the entire provider waterfall + bench logic is reused unchanged. |
| Existing binary path (`askDecision` + `_buildDecisionPrompt` + `_DEFAULT_SCHEMA`) unchanged | All edits in `ai-client.js` happen below the original `module.exports`; the binary call from `runner.js` line 631/1688 still resolves to the same function. |

### Inferred / judgment calls

| Topic | Choice | Why |
| --- | --- | --- |
| Whether the schema's `revise[].take_profit`/`stop_loss` should match `null = clear` from `reviseMultiplierLimits`, or `null = "no limit at open"` from `placeMultiplier` | Match `reviseMultiplierLimits` (null = clear) | The schema and the actual API behavior must agree. `revise` mirrors `reviseMultiplierLimits` exactly; `open.take_profit/stop_loss = null` means "don't set a limit when opening" (which the runner already does via `opts.take_profit != null` checks at `runner.js:1148-1149`). Documented in the schema description above. |
| AI returning multiple actions in one response | Added a new top-level `action='multi'` with a `multi: {close?, revise?, open?}` bundle | The prompt explicitly asked for combinations ("close one sibling while opening a new one, or revise TP/SL while holding everything else"). Part 2a's executor was a strict if/else-if chain — fitting combinations in without re-architecting required either (a) loose top-level union (fragile) or (b) an explicit `multi` action. Chose (b) for the same reason the prompt told us to design things explicitly. Dispatch order is fixed (close → revise → open) so it's deterministic. |
| Should `multi` allow revising a contract that's also being closed | No, rejected | Conservative choice per the prompt: the same contract appearing in both lists is incoherent. Validator surfaces an error and falls back to hold. |
| Max siblings per `open` decision | 4 (`MAX_OPEN_SIBLINGS_PER_DECISION`) | Matches Part 2a's `Math.max(1, Math.min(4, …))` clamp in `openSibling()` at `runner.js:1120`. Exposed as a named export so Part 2c's prompt-tweak Telegram menu (if ever added) can read it. |
| Confidence below `min_confidence` on a non-hold action | Coerced to `hold` (not rejected) | The AI tried; it just isn't sure. A hold is honest about that. Matches the binary path's behaviour in `validateDecision` at `runner.js:191-193`. |
| Behaviour when all AI providers fail | Return a well-formed `action='hold'` decision (with a `provider-fail-*` decision_id) instead of throwing | The cycle tick still needs to run (it polls open positions and enforces aggregate risk). A throw would skip those steps. The runner's existing try/catch around the stub call also catches this as a final safety net. |
| Schema field naming | Snake_case throughout (`take_profit`, `stop_loss`, `contract_id`) | Matches the rest of `last-status.json` and the `aiInput` field names — minimises translation effort in prompt + runner. |

### Adjustments to Part 2a

Two minimal, surgical changes — both inside `runMultiplierCycle` and the
stub function, and both isolated so Part 2a's tests still pass:

1. **`askMultiplierDecisionStub` body replaced** (kept the function name +
   exported binding so any out-of-tree tests don't break). It now delegates
   to `AIClient.askMultiplierDecision`, which itself runs the validator and
   degrades to `hold` on any failure.

2. **Execution dispatcher refactored** (`runner.js` around line 1465-1505).
   The old inline `if (close) ... else if (open) ... else if (revise) ...`
   chain is now three named helpers (`executeCloseList`, `executeOpenSpec`,
   `executeReviseList`) — byte-equivalent behaviour for the existing
   actions, plus a new branch for `action='multi'` that reuses those
   helpers in close→revise→open order.

That's the entire surface-area change to Part 2a. No state-shape changes,
no orchestration-flow changes, no changes to `enforceAggregateRisk` /
`forceCloseAllForSymbol` / `realizeClosedSibling` / `openSibling` /
`pollSibling` / `resolveActiveSymbol`. Part 2a's full smoke test
(`smoke-multiplier-cycle.js`) — 41 assertions covering T1–T9 including the
close/open-gated/revise branches and aggregate-risk force-close — still
passes unchanged.

### Tests

- `scripts/smoke-multiplier-cycle.js` — Part 2a's existing suite. **41/41 OK.**
- `scripts/smoke-multiplier-decision.js` — new in Part 2b. **22/22 OK.**
  Covers all 13 validator branches (including multi-bundling and
  `null/omit/number` revise semantics) plus 3 end-to-end runs through
  `runMultiplierCycle` with a mocked `askMultiplierDecision`.

Run both:

```bash
node scripts/smoke-multiplier-cycle.js && node scripts/smoke-multiplier-decision.js
```

---

## 3. What Part 2c can rely on

- Every `decision` object that flows out of `askMultiplierDecisionStub`
  is **already validated**: its shape, its types, and its contract-id
  references are all guaranteed before any side-effect-causing branch
  in the runner sees it. Part 2c does not need to re-validate.
- `executed.details` in the tick-summary log (see the `Logger.info`
  call at the end of `runMultiplierCycle`) is the right place to source
  Telegram message bodies. For `action='multi'`, entries carry an
  extra `phase: 'close' | 'revise' | 'open'` discriminator.
- The full decision object (including `rationale`, `confidence`,
  `decision_id`) is available in the runner's local `decision`
  variable at the point where `[TODO PART 2C]` marks the spot for the
  Telegram call. The fields above are exactly the ones to drop into
  `Telegram.templates.multiplierTickSummary({...})`.
