# AURELIA-Multipliers — Part 3c Summary

**Scope.** End-of-session summary (MT5-style). When a cycle session for a
symbol is stopped entirely, fire **one** Telegram message listing every
multiplier position opened during the session (entry, exit, TP/SL at
close, stake, P/L, duration) plus a session-wide total. Text-only
message, separate from the per-tick notifications Part 2c emits.

Touches **only** `runner.js`, `telegram.js`, and `worker/index.js` — no
new modules, no changes to `state.js`, no chart attachment (per spec,
chart is explicitly optional and treated as not-required here).

---

## 1. Trigger points hooked

The summary fires from a single chokepoint —
`runner.maybeSendSessionSummary(state, config, entrySnap, ctx)` —
called once per multiplier tick at the bottom of `runMultiplierCycle()`,
right after `enforceAggregateRisk()`. A pre-tick snapshot of
`{ started_at, active, halted, cycleRunning }` is captured at the top of
the tick so the function can detect the running → stopped *transition*
rather than just a static "is stopped" state.

The function recognises three distinct end-of-session conditions and
fires the summary on any of them:

| # | Path | Detection | Why this is the right hook |
|---|------|-----------|----------------------------|
| 1 | **Aggregate risk force-close** (session TP / SL / capital exhaustion) | `enforceAggregateRisk()` returned `{ breached: true }`, **or** the entry-snapshot showed `halted=false` but post-action `sess.halted=true` | Only path in `runner.js` that actually force-closes every open sibling at once — this is the "session ended" event the spec explicitly calls out. |
| 2 | **Operator pause via `/pausecycle`** with no open siblings left | Entry snapshot had `cycleRunning=true`, post-action `config.cycle.running=false`, AND `countOpenSiblings(state) === 0` | `/pausecycle` is this codebase's equivalent of a `/stop` command (there is no literal `/stop`). Pausing with positions still open is *not* a session-end — `/startcycle` can resume — so the summary is intentionally deferred until the paused session has wound down to zero exposure. |
| 3 | **Halted-and-drained** | `sess.halted=true` AND `countOpenSiblings(state) === 0` AND latch unset | Defensive recovery — covers the case where a previous tick halted but crashed before sending, or a forced halt happened over multiple ticks. Catches stragglers without re-firing because of the latch. |

**Latching.** `state._notified_session_summary` is set to the session's
`started_at` ISO string after a successful send. The function bails
immediately on the next tick if the latch already matches the current
session. The latch is cleared in `worker/index.js#startCycleSession`
right next to the existing `_notified_halt_reason` clear, so the next
`/startcycle` (or `cycle_start` button) re-arms it cleanly. A failed
Telegram send does *not* set the latch — next tick retries.

**Why one chokepoint and not multiple sprinkled hooks.** The original
plan considered also calling the summary directly from
`enforceAggregateRisk`, from the worker's `/pausecycle` handler, and
from any future hard-stop command. That fans out the wiring and makes
the latching brittle (every caller has to remember to check it). A
single end-of-tick reconciliation that re-derives the trigger from the
session-state delta is simpler, idempotent, and naturally handles paths
that bypass the runner entirely (worker writes `config.cycle.running =
false` then the next tick fires the summary — no cross-process call
required).

---

## 2. What was added to the trade-history record shape

Part 2's `realizeClosedSibling()` already records everything needed
per-position — `entry`, `exit`, `take_profit` and `stop_loss` (at close
time, since they're mirrored back to the sibling on each tick),
`stake`, `pnl`, `opened_at`, `ts` (close time, → duration = `ts -
opened_at`), `direction`, `multiplier`, `symbol`, `close_reason`,
`cycle_id`, `decision_id`, `rationale`. None of those needed to change.

**One additive field was added** — `session_started_at` — so the
summary can scope its position list to *this* session rather than a
trailing-N slice of history. This matters because
`trade_history_cycle` is a 200-entry ring buffer shared across
sessions; without the tag, a long session could mix records from a
previous halted session into its summary, or a short session running
after a crowded one could miss its own records.

```js
// runner.js · realizeClosedSibling() trade-history push (excerpt)
state.trade_history_cycle.push({
    // ...existing Part 2 fields unchanged...
    opened_at:    sibling.opened_at   || null,
    ai_outcome_note: null,
    // NEW in Part 3c (additive, optional):
    session_started_at: (sess && sess.started_at) || null,
});
```

**Backward compatibility.** The summary's record selection falls back
to a time-range filter (`record.ts >= session.started_at`) when
`session_started_at` is missing on a record, so pre-3c records from
sessions in flight at upgrade time are still included. Part 2c's
per-tick notification code reads other fields from the same record
shape and is unaffected — additive only, no rename, no removal, no
type change.

---

## 3. Final message template format

New `templates.sessionSummary(...)` in `telegram.js`, alongside the
existing templates (`cycleResult`, `sessionHalted`,
`multiplierTickSummary`, …). Reuses existing helpers: `_esc`, `_money`,
`_signedMoney`, `_limitStr`, `_multDirection`, `formatBadge`. Adds one
module-local helper `_isoDurationLabel(startIso, endIso)` for
ISO-to-ISO duration rendering (e.g. `7m 27s`, `1h 23m`, `2d 4h`) — kept
private so it doesn't collide with Part 2c's `_durationLabel(n, unit)`.

### Input shape

```js
Telegram.templates.sessionSummary({
    startedAt:   "2026-06-28T08:00:00.000Z",
    endedAt:     "2026-06-28T08:36:00.000Z",
    endedReason: "take_profit" | "stop_loss" | "capital"
               | "halted" | "paused" | "risk_breach" | "ended",
    haltReason:  "aggregate P/L +10.32 >= take_profit 10" | null,
    mode:        "demo" | "real",
    session: {
        capital_start, capital_remaining,
        take_profit, stop_loss,
        trades, wins, losses, pnl,
    },
    balance:  9871.32,
    currency: "USD",
    positions: [/* trade_history_cycle records for this session */],
});
```

### Sample output

```
🎯 SESSION ENDED — TAKE-PROFIT 🟡 DEMO
Started : 2026-06-28T08:00:00.000Z
Ended   : 2026-06-28T08:36:00.000Z
Duration: 36m 0s
Reason  : aggregate P/L +10.32 >= take_profit 10

Positions (3)

✅ 1. R_100 🟢 MULTUP x100
   Entry/Exit : 268.42 → 269.1
   TP / SL    : $6.25 / $6.25
   Stake / P/L: $12.50 → +$3.42 · 7m 27s
   Close      : tp_hit

❌ 2. R_100 🔴 MULTDOWN x100
   Entry/Exit : 268.42 → 268.95
   TP / SL    : $6.25 / $6.25
   Stake / P/L: $12.50 → -$2.10 · 14m 15s
   Close      : sl_hit

➖ 3. frxEURUSD 🟢 MULTUP x200
   Entry/Exit : 1.0825 → 1.0825
   TP / SL    : — / $12.50
   Stake / P/L: $25.00 → $0.00 · 15m 0s
   Close      : ai_close

Session totals
Positions : 3
W / L     : 1 / 1   (33.3%)
Staked    : $50.00
Realised  : +$1.32
Capital   : $1001.32 / $1000.00
Balance   : $9871.32

Run /startcycle to begin a fresh session.
```

### Why this layout (and not a real HTML `<table>`)

Telegram strips most table markup and renders fixed-width content
poorly on mobile. Per-position multi-line blocks reads more cleanly,
stays scannable when there are 1–20 positions, and keeps the message
inside the 4096-char plain-message cap. Each row uses exactly the
labels the spec asked for (entry, exit, TP, SL at close, stake, P/L,
duration) plus a close-reason tag when it isn't `unknown`. Direction
and outcome are coloured with the same emoji vocabulary already used
in `multiplierTickSummary` so the visual style stays consistent.

The totals block also surfaces `session.pnl` separately when it
disagrees with the sum-of-positions by more than $0.005 — covers the
edge case where pre-Part-3c records (without `session_started_at`)
exist in history and got filtered out, so both numbers stay visible.

---

## 4. Touched files (full list)

| File | Change |
|------|--------|
| `runner.js` | Added `maybeSendSessionSummary()` (above `runMultiplierCycle`). Added entry-snapshot capture + post-risk call inside `runMultiplierCycle`. Added `session_started_at` to the trade-history record in `realizeClosedSibling`. Exported `maybeSendSessionSummary` for testability. |
| `telegram.js` | Added `templates.sessionSummary(...)`. Added module-local `_isoDurationLabel(startIso, endIso)` helper. |
| `worker/index.js` | One additive line in `startCycleSession`: clears the new `state._notified_session_summary` latch alongside the existing `_notified_halt_reason` clear. |
| `scripts/smoke-session-summary.js` | New tiny smoke covering template rendering + the three trigger paths + latch suppression. |

Nothing else changed. Per-tick notifications (Part 2c), chart rendering
(Part 3a), symbol categories (Part 3b), and the `state.js` persistence
helpers (Parts 1/2) are all untouched.
