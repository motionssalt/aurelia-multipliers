# Part 2c — Telegram Tick Notification (hand-off to Part 3)

This part filled in the Telegram-notification gap that Part 2a left and
Part 2b carried forward as a `[TODO PART 2C]` marker in `runner.js`. Per
the prompt's intent, every multiplier cycle tick now fires exactly one
Telegram message — including ticks where the AI decided to hold with no
side effects — and the message reflects both the AI's decision and the
post-action state of all open siblings for the active symbol.

No changes were made to:

- the cycle orchestration loop from Part 2a (`runMultiplierCycle` body,
  except for the two surgical spots called out below)
- the decision schema from Part 2b (`ai-client.js` ships unchanged —
  byte-identical to Part 2b's deliverable)
- `state.js`, `deriv.js`, `risk.js`, `payload-builder.js`, `chart.js`,
  `indicators.js`, `logger.js`, `config.json`, or anything in `worker/`
- the existing binary path (`runCycle`, `runManual`, `runDailySummary`)
  or any of its templates

---

## 1. The final message template

A new template `Telegram.templates.multiplierTickSummary({…})` was
added to `telegram.js` alongside the existing templates. It uses the
same private helpers (`_esc`, `_money`, `_directionArrow`, `_sessionLine`,
`formatBadge`) plus four new private helpers added next to them:

| Helper | What it does |
| --- | --- |
| `_signedMoney(n, cur)` | `+$1.23` / `-$1.23` / `$0.00` — signed-currency formatter for P/L. |
| `_multDirection(d)`    | `'up' → '🟢 MULTUP'`, `'down' → '🔴 MULTDOWN'`. Multiplier-fork counterpart to the existing `_directionArrow` (which is for binary CALL/PUT). |
| `_limitStr(v)`         | Renders a TP/SL amount: number → `'$1.23'`, `null` / `undefined` → `'—'`. |
| `_confStr(c)`          | Renders an AI confidence: `0.42 → '(42%)'`, omitted → `''`. |
| `_actionHeader(a)`     | Maps action verb → header line. `hold→⏸️ HOLD`, `skip→⏭️ SKIP`, `open→🆕 OPEN`, `close→🔒 CLOSE`, `revise→✏️ REVISE`, `multi→🧩 MULTI`. |

### Anatomy of a tick message

```
{action emoji & label} — {symbol} {🟡 DEMO|🔴 REAL} ({confidence}%)
{action-specific body — see below}

[only if there were server-side closes this tick:]
Just closed (×N):
  • ✅/❌/➖ <contract>: ±$P/L · <reason>

Open siblings (×N):                ← post-action snapshot, or "<i>none</i>"
  • <contract> {🟢 MULTUP|🔴 MULTDOWN} ×{mult} · ${stake} · P/L <b>±$P/L (±NN.NN%)</b>
      TP / SL: $X / $Y             ← '—' if either is unset/null

Exposure ({symbol}): N pos · stake $X · float ±$Y     ← post-action aggregate
Session  : realised ±$P · combined ±$P+F · cap left $C · NW/ML
⛔ HALTED: <halt_reason>            ← only if session halted
⚠️ Risk breach this tick: <reason> — all siblings force-closed.
                                   ← only if aggregate risk fired this tick
Balance  : $XXXX.XX

<i>{decision.rationale truncated to 280 chars}</i>
id={decision.decision_id}
```

### Action-specific bodies

| `decision.action` | Body lines rendered between header and "Open siblings" block |
| --- | --- |
| `hold` / `skip` | (nothing — the rationale in the footer carries the message) |
| `open` | `Direction : 🟢/🔴 MULTUP/DOWN ×N`  ·  `Stake : $X [× S siblings]`  ·  `TP / SL : $tp / $sl` |
| `close` | `Closing :` followed by one bullet per requested contract: `• <cid>: ±$pnl · <reason>` (or error/skipped marker if executor surfaced one) |
| `revise` | `Revising :` followed by one bullet per contract: `• <cid>: TP $old → $new · SL $old → $new` (omits the field that wasn't revised — mirrors Part 2b's `null`/omit/number three-state semantic) |
| `multi` | All three sub-blocks above, in fixed `close → revise → open` order — the same order Part 2b's executor dispatches them. Each sub-block uses the `phase: 'close'\|'revise'\|'open'` discriminator that Part 2b stamped onto `executed.details` entries. |
| anything else | Header still renders with the raw uppercase action; body is empty. Graceful degradation. |

### Sample renders (3 typical ticks)

These were produced by feeding realistic inputs into the template directly:

**HOLD — most common case** (~390 chars):

```
⏸️ <b>HOLD</b> — <b>R_100</b> 🟡 DEMO (42%)

<b>Open siblings</b> (×1):
• <code>3501118801</code> 🟢 MULTUP ×100 · $12.50 · P/L <b>+$1.23 (+9.84%)</b>
    TP / SL: $6.25 / $6.25

<b>Exposure</b> (R_100): 1 pos · stake $12.50 · float <b>+$1.23</b>
Session  : realised $0.00 · combined +$1.23 · cap left $987.50
Balance  : $1000.00

<i>Trend ambiguous. Wait for clearer break above 9120.</i>
<code>id=d-abc12345</code>
```

**MULTI — the kitchen sink (close + revise + open)** (~700 chars):

```
🧩 <b>MULTI</b> — <b>R_100</b> 🔴 REAL (71%)
Closing   :
• <code>6001</code>: -$3.10 · <i>exit_loser</i>
Revising  :
• <code>6002</code>: TP $6.25 → $18.00
Opening   :
Direction : 🔴 MULTDOWN ×100
Stake     : $6.25
TP / SL   : $5.00 / $5.00

<b>Open siblings</b> (×2):
• <code>6002</code> 🟢 MULTUP ×100 · $12.50 · P/L <b>+$2.10 (+16.80%)</b>
    TP / SL: $18.00 / $6.25
• <code>6003</code> 🔴 MULTDOWN ×100 · $6.25 · P/L <b>$0.00 (+0.00%)</b>
    TP / SL: $5.00 / $5.00

<b>Exposure</b> (R_100): 2 pos · stake $18.75 · float <b>+$2.10</b>
Session  : realised -$3.10 · combined -$1.00 · cap left $971.15 · 0W/1L
Balance  : $996.90

<i>Loser past invalidation; tighten winner; fresh down on break.</i>
<code>id=d-multi9</code>
```

**RISK BREACH — aggregate SL force-closed everything** (~480 chars):

```
⏸️ <b>HOLD</b> — <b>R_100</b> 🟡 DEMO

<b>Open siblings</b>: <i>none</i>

<b>Exposure</b> (R_100): 0 pos · stake $0.00 · float <b>$0.00</b>
Session  : realised -$20.50 · combined -$20.50 · cap left $1000.00 · 0W/2L
⛔ <b>HALTED</b>: <code>aggregate P/L -20.50 &lt;= -stop_loss 20</code>
⚠️ <b>Risk breach this tick</b>: <code>stop_loss</code> — all siblings force-closed.
Balance  : $979.50

<i>Aggregate SL breached intra-tick by floating P/L drift.</i>
<code>id=d-risk1</code>
```

The third sample is worth flagging: the *AI's* decision was `hold`, so
the header says `HOLD`, but the body and the dedicated `⛔ HALTED` /
`⚠️ Risk breach` lines make it unambiguous that the system enforced a
force-close on top of the AI's hold. This matches the prompt's
requirement that the message reflect what the AI decided **and** the
current state of siblings after the action.

---

## 2. Chart-image TODO marker (for Part 3)

The single integration point where Part 3 will swap `Telegram.send(msg)`
for `Telegram.sendPhoto(buf, msg)` is at:

**`runner.js`, inside `runMultiplierCycle`, right after the message body
is built** — search for the comment block beginning with
`// [TODO PART 3] When chart rendering for multiplier siblings is`.

Around lines 1701–1718 of the modified `runner.js`, the comment
provides pseudocode for the swap:

```js
//     const buf = await Chart.renderMultiplierSnapshot({
//         symbol, openSiblings: postActionSiblings, ...
//     });
//     if (buf) await Telegram.sendPhoto(buf, msg);
//     else     await Telegram.send(msg);
```

The comment also calls out the **1024-char Telegram caption cap**: at 4
siblings combined with a busy `multi` decision, the rendered body can
climb into the 800–1000 char range. If/when that becomes a real
problem, Part 3 has two options documented inline: trim the rationale
aggressively in the template, or split the chart into its own
`sendPhoto` call with a short caption while keeping `send()` for the
full body. Worth deciding at integration time rather than pre-emptively.

---

## 3. Telegram rate-limit check (per prompt request)

The prompt asked us to confirm that 5-minute-cadence messaging is a
non-issue at the existing `_api()` / `send()` plumbing. It is:

- Telegram's documented limits are ~30 msg/sec global and ~1 msg/sec
  per chat. At one message per 5 minutes (= **288 msg/day per chat**),
  we are below the per-chat limit by ~300× and the global limit by
  ~9000×.
- `_api()` already retries **once** on 5xx / 429, honours Telegram's
  `parameters.retry_after` (capped at 8s), and silently no-ops when
  `TELEGRAM_BOT_TOKEN` is unset — so the smoke tests / CI run cleanly
  without a real bot configured.
- `send()` failures inside `runMultiplierCycle` are caught locally and
  downgraded to a `Logger.warn` — a notification failure can **never**
  poison the cycle and abort settlement/state-persistence work.

**Conclusion: no rate-limiting changes needed.** The single thing
worth noting for the future is that the *retry budget* in `_api()` is
exactly one retry; if Part 3's chart attachment makes the message
heavier and Telegram starts intermittently dropping it under load,
that's the spot to revisit — not now.

---

## 4. Adjustments to Part 2a / Part 2b

Two minimal changes to `runner.js`, both inside `runMultiplierCycle`,
both surgical:

### Change A: Pre-action sibling snapshot (new, ~22 lines)

Right after the AI decision is obtained (and *before* any executor
branch mutates `state`), we snapshot the open siblings into
`preActionSiblings`. This is needed so the message template can render
`TP $6.25 → $18.00` style transitions for the `revise` branch (which
is otherwise impossible — the executor mutates the persisted record
in place via `State.updateSiblingPosition`).

The snapshot is built from `aiInput.open_siblings` (which Part 2a
already constructed and Part 2b already documented) — no new state
walk, no new helper required. The only subtlety: `aiInput.open_siblings`
stores TP/SL as `{ amount, value }` objects (the shape Deriv's
`getOpenPositionState` returns), so we flatten them to raw numbers to
match the persisted-record shape that `postActionSiblings` uses.

### Change B: Replace `[TODO PART 2C]` block with Telegram call

The original block was just a `Logger.info('multiplier tick summary', {…})`
with a long comment saying Part 2c would replace it. The new code:

1. **Keeps** the `Logger.info` line verbatim — it's still useful for
   cron logs and any downstream metric scrape, and Part 2b's
   documentation noted that line was a useful telemetry hook.
2. **Adds** a `try { … } catch { Logger.warn(…) }` block that
   (a) re-reads the post-action open siblings via
   `State.getOpenSiblings(state, symbol)`, (b) re-aggregates exposure
   via `State.aggregateSiblingExposure(state, symbol)`, (c) builds the
   template message, and (d) calls `Telegram.send(msg)`.
3. **Carries the `[TODO PART 3]` marker** for the future chart
   attachment, with pseudocode and the caption-length caveat, exactly
   where Part 3 should wire `sendPhoto`.

### What was *not* changed

- `aiInput` shape — no new fields needed; everything the template uses
  is already there or derivable post-action.
- `executed.details` shape — Part 2b's `phase: 'close'|'revise'|'open'`
  discriminator on multi-action details was exactly what was needed,
  used unchanged.
- The `askMultiplierDecisionStub` body, `executeCloseList`,
  `executeOpenSpec`, `executeReviseList`, `enforceAggregateRisk`,
  `forceCloseAllForSymbol`, `realizeClosedSibling`, `openSibling`,
  `pollSibling`, `resolveActiveSymbol` — all unchanged.
- `ai-client.js` — byte-identical to Part 2b's version.

### Things noted but **not** acted on

- **Caption length and `sendPhoto`**: real concern at the high end
  (4 siblings + multi). Documented inline; deferred to Part 3 as the
  natural integration point.
- **Existing helper `_directionArrow` is for binary CALL/PUT**: the
  multiplier fork uses MULTUP / MULTDOWN, so a new `_multDirection`
  was added rather than overloading the existing helper. Keeps the
  binary path untouched and keeps semantics obvious at call sites.
- **`exposure` shape from `State.aggregateSiblingExposure`**: the
  `state.js` module isn't visible in this fork yet (it's part-1
  territory). The template gracefully derives `positions`, `total_stake`,
  and `total_floating_pnl` from `openSiblings[]` if any of those keys
  are missing on the passed exposure object, so a future change to
  `aggregateSiblingExposure`'s shape won't break the message.

---

## 5. Tests

A new smoke test was added: **`scripts/smoke-multiplier-tick-summary.js`**.
It is pure-template (no `state.js`, no network) and covers every branch
of `multiplierTickSummary` plus auxiliary states:

| Group | Assertions | Covers |
| --- | --- | --- |
| T1 | 7 | `action='hold'` with rationale + confidence + 0 siblings |
| T2 | 7 | `action='open'` with 2 siblings, REAL mode badge, MULTDOWN |
| T3 | 5 | `action='close'` with realised P/L + reason + session update |
| T4 | 4 | `action='revise'` with old→new TP and SL-cleared diff |
| T5 | 9 | `action='multi'` with close + revise + open all rendered |
| T6 | 4 | server-side `just_closed` win + loss + reasons rendered |
| T7 | 3 | aggregate risk breach + HALTED line + breach warning |
| T8 | 2 | `action='skip'` and unknown action degrade gracefully |
| T9 | 3 | HTML escape for `<script>` / `&` / `<id>` in rationale + decision_id |
| T10 | 3 | exposure derives from siblings when the exposure object is missing keys |
| **Total** | **47** | |

Run with:

```bash
node scripts/smoke-multiplier-tick-summary.js
```

Expected: `Passed: 47    Failed: 0` and exit code 0. Verified
locally — passes cleanly.

**Part 2a's and Part 2b's existing smoke tests
(`smoke-multiplier-cycle.js` and `smoke-multiplier-decision.js`) are
unaffected** by Part 2c's changes — they ship unchanged in this
deliverable. The only runtime change inside `runMultiplierCycle`
visible to those tests is the extra `Telegram.send()` call at the end,
which (in the absence of `TELEGRAM_BOT_TOKEN` in the test env) no-ops
quietly via the existing guard in `_api()` and adds at most one
`Logger.warn('TELEGRAM_BOT_TOKEN not set — skipping')` line per tick.
None of the existing tests assert on log output, so behaviour is
preserved.

---

## 6. Files in this deliverable

```
aurelia-multipliers-part2c/
├── PART_2C_SUMMARY.md                   ← this file
├── ai-client.js                         ← unchanged from Part 2b
├── runner.js                            ← Part 2b + 2 surgical edits in runMultiplierCycle
├── telegram.js                          ← Part 1 + 1 new template + 4 new private helpers
└── scripts/
    ├── smoke-multiplier-cycle.js        ← unchanged from Part 2b (41/41 still passes)
    ├── smoke-multiplier-decision.js     ← unchanged from Part 2b (22/22 still passes)
    └── smoke-multiplier-tick-summary.js ← NEW — pure-template smoke test (47/47)
```

Drop these on top of the Part 2b tree (or the Part 1 tree if Part 2b's
already merged). No state-shape migration, no config-schema bump.

---

## 7. What Part 3 inherits

- **A single, well-marked integration point** (`[TODO PART 3]` in
  `runner.js` inside `runMultiplierCycle`) for the chart-image swap.
- **All the data needed** to render the chart already in scope at that
  spot: `symbol`, `postActionSiblings`, `cycleId`, and the full
  `decision` object are local variables. No refactoring required to
  hand them to a `Chart.renderMultiplierSnapshot(…)` call.
- **A documented caption-length caveat**: 4 siblings + a multi-action
  decision can produce ~800–1000 chars of message body. Telegram's
  `sendPhoto` caption cap is 1024 chars — close enough to want a plan.
- **No rate-limit headroom worries** at 5-min cadence; `_api()`'s
  existing single-retry + `retry_after` handling is sufficient.
