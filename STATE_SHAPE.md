# `last-status.json` — Multipliers state shape (Part 1 contract)

This document is the **authoritative description** of the persisted JSON
shape used by `aurelia-multipliers`. Parts 2 and 3 of the fork are built
in separate sessions and rely on this file rather than on the Part-1
session's reasoning — keep it accurate when you extend the shape.

> **What's new vs. the upstream AURELIA binary bot.** The upstream bot
> tracks a single open contract per cycle in `cycle_open_position`.
> Multipliers stay open indefinitely and the AI may split one decision
> into multiple sibling positions on the same symbol, so we replace
> that scalar with a `cycle_open_siblings` object keyed by symbol, each
> value being an array of sibling records. Everything else in
> `last-status.json` (balance, cycle_session counters, trade history,
> ai_keys_bench, logs ring buffer, daily_stats…) is **carried over
> unchanged** from upstream.

---

## Top-level keys

Only the keys that are **new or changed** for the Multipliers fork are
documented in detail below. All other keys keep their upstream semantics
and shapes.

| Key | Status | Notes |
| --- | --- | --- |
| `cycle_open_position` | **DEPRECATED** | Kept readable for backward compatibility during migration but no Multipliers code path writes to it. Part 2 should leave any existing value untouched on first run and clear it once siblings exist. |
| `cycle_open_siblings` | **NEW (Part 1)** | Object keyed by Deriv symbol → array of sibling-position records. See "Sibling shape" below. |
| `cycle_open_siblings_summary` | **NEW, OPTIONAL** | Reserved for Part 2 to optionally cache the output of `aggregateAllExposure()` after each tick for fast UI/Telegram rendering without re-aggregating. May be absent — never read this without falling back to recomputing. |
| `pending_contracts` | **REPURPOSED** | Upstream used this for binary contracts waiting to settle on a later tick. Multipliers do not settle on their own — Part 2 should treat this array as a list of *commands queued for the next tick* (e.g. `{ action: 'close', contract_id, reason }`) rather than for polled settlement. Keep the same array key; Part 2 decides the exact element shape. |
| `cycle_session` | unchanged | Capital / TP / SL / pnl / halted flag fields are reused as-is. The interpretation of `pnl` shifts from "sum of settled trade outcomes" to "sum of realized P/L from closed multiplier sells" — adjust accumulators in Part 2 but do **not** rename the field. |
| `trade_history_cycle` / `trade_history_manual` | extended | Continue to append one entry per realized (closed) position. Add the multiplier-specific fields documented below. Open positions live in `cycle_open_siblings`, NOT here. |

---

## `cycle_open_siblings` — shape

```jsonc
{
  "cycle_open_siblings": {
    "R_100":     [ /* sibling record */, /* sibling record */, ... ],
    "frxEURUSD": [ /* sibling record */ ]
    // symbols with no open positions either omit the key entirely
    // (preferred after pruneEmptySymbols) or hold an empty array.
  }
}
```

* Keys are Deriv symbol strings exactly as returned by `active_symbols`
  / `contracts_for` (e.g. `R_100`, `1HZ100V`, `frxEURUSD`, `cryBTCUSD`).
* Values are arrays of **sibling records** (one per open contract).
  Order within the array is **insertion order** (most recent at the
  end) — `state.js` helpers preserve it.

### Sibling record

Authoritative shape, produced by `state.makeSiblingRecord()`:

```jsonc
{
  "contract_id":   3439112357,        // integer — Deriv contract id
  "stake":         12.50,             // number  — USD stake at risk
  "multiplier":    100,               // integer — Deriv multiplier (e.g. 40, 100, 200)
  "direction":     "up",              // 'up' (MULTUP) | 'down' (MULTDOWN)
  "entry_spot":    265.99,            // number | null — first valid tick (from proposal)
  "entry_time":    "2026-06-27T03:43:41.670Z",  // ISO string

  // Risk limits the AI / user set at open or via reviseMultiplierLimits.
  // Both are $-amounts (NOT price levels) — Deriv translates them to
  // barrier prices internally. null means "no limit" (stop_out still
  // applies — see deriv.js).
  "take_profit":   5.00,              // number | null
  "stop_loss":     5.00,              // number | null

  // Refreshed by Part 2's tick loop after each getOpenPositionState
  // call. Starts as null on a fresh sibling.
  "floating_pnl":      0.42,          // number | null — $-amount
  "floating_pnl_pct":  3.4,           // number | null — % (Deriv-supplied)
  "current_spot":      266.10,        // number | null
  "last_polled_at":    "2026-06-27T03:48:39.220Z",  // ISO | null

  // Provenance — lets Part 3 reconstruct which AI decision spawned
  // this position when generating the end-of-session summary.
  "cycle_id":      "2026-06-27T03:43:00Z",  // string | null — cron tick id
  "decision_id":   "dec-2c41a3",            // string | null — AI response id
  "sibling_index": 0,                       // 0-based within the decision
  "sibling_count": 4,                       // total siblings in the decision
  "rationale":     "Oversold bounce setup; splitting into 4 to allow staged exits.",
  "opened_at":     "2026-06-27T03:43:41.690Z",  // ISO string

  // Audit trail of every TP/SL revise attempt against this contract,
  // appended to by runner.executeReviseList (ok / clamped / failed)
  // and by the per-tick poll (reverted). FIFO-capped at
  // state.MAX_REVISION_HISTORY entries (default 20). Forwarded into
  // aiInput.open_siblings[].revision_history every tick so the AI
  // can avoid retrying an identical losing revision.
  "revision_history": [
    {
      "ts":          "2026-06-27T03:48:12.330Z",
      "outcome":     "failed",                // 'ok' | 'clamped' | 'reverted' | 'failed'
      "requested":   { "stop_loss": 1.20 },   // what the AI asked for
      "error":       "Enter an amount equal to or lower than 8.59.",
      "decision_id": "dec-9c11b0"
    },
    {
      "ts":          "2026-06-27T03:53:14.880Z",
      "outcome":     "clamped",
      "requested":   { "stop_loss": 1.20 },
      "applied":     { "stop_loss": 4.00 },   // what the broker actually accepted
      "clamp_adjustments": { "stop_loss": { "reason": "below_min", "min": 4.00 } },
      "decision_id": "dec-a7f432"
    }
  ]
}
```

#### Required fields

A sibling record is considered **well-formed** if at minimum it has:

* `contract_id` (number)
* `stake` (positive number)
* `multiplier` (positive integer)
* `direction` (`"up"` | `"down"`)
* `entry_time` (ISO string)

`state.addSiblingPosition()` enforces only `contract_id`; the factory
`state.makeSiblingRecord()` enforces all five.

#### Field semantics

| Field | Set at | Updated when | Notes |
| --- | --- | --- | --- |
| `contract_id` | open | never | Primary key. Idempotency anchor for `addSiblingPosition`. |
| `stake`, `multiplier`, `direction` | open | never | Immutable — Deriv does not allow changing them on an open contract. |
| `entry_spot`, `entry_time` | open | never | Snapshot from the proposal/buy reply. |
| `take_profit`, `stop_loss` | open | after each successful `reviseMultiplierLimits` | Mirror of the limits currently set on the live contract. `null` means "no limit". |
| `floating_pnl`, `floating_pnl_pct`, `current_spot`, `last_polled_at` | first POC poll | every tick that polls this contract | Cached so cycle-aggregate views don't have to re-poll. May lag the live value by up to one tick. |
| `cycle_id`, `decision_id`, `sibling_index`, `sibling_count`, `rationale` | open | never | Audit trail. Used by Part 3's daily/session summary. |
| `opened_at` | open | never | Local timestamp; distinct from `entry_time` which may come from the Deriv reply. |
| `revision_history` | open (`[]`) | after each TP/SL revise attempt AND on detection of broker-side TP/SL drift between ticks | FIFO-capped at `MAX_REVISION_HISTORY` entries. Surfaced to the AI prompt so it does not retry an identical revise that has already failed / been clamped / been reverted. See `state.appendRevisionAttempt()`. |

### Concurrency / consistency rules

* The runner is single-threaded (Node, one cron tick at a time, GitHub
  Actions `concurrency: aurelia-tick` guarantees no overlap), so there
  is no in-process locking concern.
* The whole `last-status.json` file is rewritten atomically at the end
  of each tick by the existing commit step in `.github/workflows/`.
* If `placeMultiplier` succeeds but the runner crashes before
  persisting the sibling record, the next tick will see the position
  via `proposal_open_contract` polling of recent contract IDs but will
  not have provenance fields. Part 2 should fall back to creating a
  best-effort sibling record (with `cycle_id`/`decision_id` set to
  `"recovered"`) in that case.

---

## Helper functions (in `state.js`)

All helpers are pure: they mutate **only** the `state` object passed to
them, and do no I/O or logging.

| Helper | Purpose |
| --- | --- |
| `addSiblingPosition(state, symbol, position)` | Append or upsert by `contract_id`. |
| `removeSiblingPosition(state, symbol, contractId)` | Drop by `contract_id`; returns `true` if removed. |
| `updateSiblingPosition(state, symbol, contractId, patch)` | Merge `patch` into an existing sibling (e.g. refresh floating P/L). |
| `getOpenSiblings(state, symbol)` | Shallow copy of the array for a symbol (always returns `[]`, never `undefined`). |
| `getAllOpenSiblings(state)` | Flat array `[{ symbol, ...sibling }, …]` across every symbol. |
| `aggregateSiblingExposure(state, symbol)` | `{ count, total_stake, total_floating_pnl, net_position, direction_mix }`. |
| `aggregateAllExposure(state)` | Roll-up of the above across every symbol. |
| `countOpenSiblings(state)` | Cheap total count. |
| `pruneEmptySymbols(state)` | Drop empty arrays before persisting. |
| `makeSiblingRecord(args)` | Canonical factory — prefer this over building records by hand. |

`SIBLINGS_KEY` (`"cycle_open_siblings"`) is exported so callers can
reference the top-level key symbolically.

---

## Example populated state

A minimum-viable post-tick state showing one symbol with two siblings,
one of which has been polled at least once and one freshly opened:

```jsonc
{
  "last_cycle": "2026-06-28T08:35:21.110Z",
  "balance": 9870.12,
  "currency": "USD",
  "account_mode": "demo",

  "cycle_session": {
    "active": true,
    "started_at": "2026-06-28T08:30:00.000Z",
    "capital_start": 1000,
    "capital_remaining": 975.00,
    "take_profit": 20,
    "stop_loss":   20,
    "trades": 0,                // realized closes so far this session
    "wins": 0,
    "losses": 0,
    "pnl": 0,
    "win_streak": 0,
    "loss_streak": 0,
    "halted": false,
    "halt_reason": null
  },

  "cycle_open_position": null,  // legacy field — leave null in this fork

  "cycle_open_siblings": {
    "R_100": [
      {
        "contract_id":    3501118801,
        "stake":          12.50,
        "multiplier":     100,
        "direction":      "up",
        "entry_spot":     268.42,
        "entry_time":     "2026-06-28T08:30:14.220Z",
        "take_profit":    6.25,
        "stop_loss":      6.25,
        "floating_pnl":   0.84,
        "floating_pnl_pct": 6.7,
        "current_spot":   268.65,
        "last_polled_at": "2026-06-28T08:35:18.500Z",
        "cycle_id":       "2026-06-28T08:30:00Z",
        "decision_id":    "dec-7f02b1",
        "sibling_index":  0,
        "sibling_count":  2,
        "rationale":      "Oversold bounce on R_100; staking 2x12.50 to allow staged exits.",
        "opened_at":      "2026-06-28T08:30:14.230Z"
      },
      {
        "contract_id":    3501118905,
        "stake":          12.50,
        "multiplier":     100,
        "direction":      "up",
        "entry_spot":     268.42,
        "entry_time":     "2026-06-28T08:30:14.540Z",
        "take_profit":    12.50,
        "stop_loss":      6.25,
        "floating_pnl":   null,
        "floating_pnl_pct": null,
        "current_spot":   null,
        "last_polled_at": null,
        "cycle_id":       "2026-06-28T08:30:00Z",
        "decision_id":    "dec-7f02b1",
        "sibling_index":  1,
        "sibling_count":  2,
        "rationale":      "Oversold bounce on R_100; staking 2x12.50 to allow staged exits.",
        "opened_at":      "2026-06-28T08:30:14.560Z"
      }
    ]
  },

  "cycle_open_siblings_summary": {
    "symbols": 1,
    "positions": 2,
    "total_stake": 25.00,
    "total_floating_pnl": 0.84,    // null if no siblings have been polled
    "per_symbol": [
      {
        "symbol": "R_100",
        "count": 2,
        "total_stake": 25.00,
        "total_floating_pnl": 0.84,
        "net_position": 25.84,
        "direction_mix": { "up": 2, "down": 0 }
      }
    ]
  },

  "pending_contracts": [],            // see "Repurposed" note above
  "trade_history_cycle": [],          // appended on REALIZED closes only
  "trade_history_manual": [],
  "ai_keys_bench": {},
  "logs": []                          // upstream ring buffer, unchanged
}
```

---

## Migration from upstream `last-status.json`

When the bot first runs against a `last-status.json` produced by the
upstream binary bot, none of the new keys exist. The helpers in
`state.js` all auto-create their containers on first write
(`_ensureSymbolArray` guards the top-level `cycle_open_siblings` key)
so **no explicit migration script is required**. The first persisted
write after a successful `placeMultiplier` will add the new keys.

`cycle_open_position` from the upstream shape is left untouched; Part 2
should set it to `null` once it has migrated any in-flight binary
contract out of it (or simply ignore it forever — the multiplier path
does not read it).
