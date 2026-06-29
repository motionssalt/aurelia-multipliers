# Global Kill Switch + Close-All Positions

A panic-button layer for AURELIA-MULTIPLIERS. Adds two independent
controls — a global kill switch that blocks every new position
(cycle AND manual), and a one-tap close-all sweep that sells every
open multiplier at market.

## Why two controls?

The existing `config.cycle.running` flag only pauses the auto-cycle.
Manual `/scan` (or the 🤖 button) can still open new positions while
the cycle is paused — by design, since manual was always meant as
"the operator is taking over the wheel." That assumption breaks when
the operator wants the bot to **stop trading entirely** (e.g. broker
issue, breaking news, debugging) without losing exposure on existing
positions.

| Control | What it blocks | What it leaves alone |
|---|---|---|
| `cycle.running = false` (Pause Cycle) | Auto-cycle ticks open new positions | Manual `/scan` can still open. Open positions keep running. |
| `trading_enabled = false` (**NEW** Kill Switch) | Cycle + manual both blocked from opening | Open positions keep running. Polling/settlement still works. |
| **Close All Positions** (NEW) | Sells every open sibling at market right now | (Also flips kill switch ON + pauses cycle, so the bot stays flat.) |

The kill switch is **strictly stronger** than pause: it adds the
"no manual opens" guarantee on top of pause.

## Telegram surface

### Main menu

A new row sits between the cycle controls and the settings row:

```
🛑 Stop Trading        🔻 Close All (3)
```

When trading is already disabled, the left button flips to
`✅ Resume Trading`. The right button always shows the live count of
open siblings — when there are none, it just reads `🔻 Close All`.

### Safety panel (`/risk` or Settings → 🛑 Safety)

```
🛑 Safety / Kill Switch 🟡 DEMO

Trading       : ✅ enabled
Cycle         : ▶️ running
Open positions: 3
Floating P/L  : +$4.20

Per-symbol exposure
  • frxEURUSD ×2   stake $100.00   P/L +$2.10
  • R_100     ×1   stake $25.00    P/L +$2.10

[ 🛑 Stop Trading ]
[ 🔻 Close All Positions ]
[ 📊 Status ]  [ ⬅️ Menu ]
```

### Slash commands

| Command | Effect |
|---|---|
| `/stoptrading` (`/killswitch`) | `trading_enabled=false` + pause cycle. |
| `/resumetrading` | `trading_enabled=true` (cycle stays paused). |
| `/closeall` (`/flatten`) | Confirm → flatten everything + flip kill switch. |
| `/risk` (`/safety`) | Open the Safety panel. |

## What happens on Close-All

1. **Worker (Cloudflare)** receives the inline tap / `/closeall`.
2. Confirmation dialog → operator taps ✅ Confirm.
3. Worker writes `config.json` with `trading_enabled=false` and
   `cycle.running=false` **before** dispatching the workflow. This is
   the belt-and-braces ordering: if the runner takes 30 s to wake up,
   the next scheduled cron tick can't race and reopen anything.
4. Worker dispatches the manual workflow:
   ```json
   { "task": "manual", "payload": "{\"action\":\"close_all\",\"reason\":\"manual_close_all\"}" }
   ```
5. **Runner** wakes up, calls `closeAllPositions()` which iterates
   `state.cycle_open_siblings` and re-uses the existing
   `forceCloseAllForSymbol()` (the same helper aggregate-risk halts
   use). Each sibling is:
   - Polled once via `proposal_open_contract` for the final P/L.
   - Sold via `sell { sell: <cid>, price: 0 }` (sell at market).
   - Removed from state, booked into `trade_history_cycle` /
     `daily_stats` via `realizeClosedSibling()` with
     `close_reason: 'manual_close_all'`.
6. Runner posts a summary to Telegram:
   ```
   🔻 Close-All complete
   Reason: manual_close_all
   Symbols swept: 2
   Positions closed: 3
   Realised P/L: +$8.00
   Per symbol:
     • frxEURUSD: 2 ×  +$3.00
     • R_100    : 1 ×  +$5.00
   ```

## What happens on Stop Trading (without Close-All)

- `config.trading_enabled = false` (committed to repo, survives
  worker restarts).
- `config.cycle.running = false` (so the auto-loop also stops asking
  for new positions).
- **Open positions are left alone.** They will continue to be polled
  by every cron tick — TP/SL/stop-out events still fire, the runner
  still updates floating P/L in state, the runner still books them
  into the trade history when they close server-side. The ONLY thing
  blocked is opening new ones.

This is intentional: the kill switch is "no new orders," not "panic
sell." Use Close-All if you also want to flatten exposure.

## State / config additions

### `config.json`

```jsonc
{
  "enabled": true,
  "trading_enabled": true,   // ← NEW. Undefined defaults to TRUE.
  ...
}
```

Backward compatibility: when the field is absent (older configs), the
runner treats it as ON (no behaviour change vs. pre-killswitch
versions). It is only when explicitly set to `false` that opens are
blocked.

### `last-status.json`

No new fields. The existing `cycle_open_siblings` map is the source
of truth for open exposure — the worker reads it to render the open-
position badge on the main menu and the per-symbol breakdown on the
Safety panel.

## File-by-file changes

| File | What changed |
|---|---|
| `config.json` | Added `"trading_enabled": true`. |
| `runner.js` | Added `closeAllPositions()` helper. Added `close_all` action branch in `runManual()`. Added `trading_enabled` gate in `runMultiplierCycle()` and `runManual()`. Exported `closeAllPositions`. |
| `worker/index.js` | Added `/stoptrading`, `/resumetrading`, `/closeall`, `/risk` commands. Added `safety:*` and `do:close_all` callback handlers. Added `KB.safety`, `KB.killswitchScreen`. Added `countOpenSiblings`, `sumFloatingPnl`, `renderSafety`. Added safety row to `KB.mainMenu` and 🛑 Safety button to `KB.settings`. |
| `scripts/smoke-close-all.js` | New smoke test, 11 assertions. |
| `docs/KILL_SWITCH.md` | This file. |

## Testing

```bash
node scripts/smoke-close-all.js
```

Expected output ends with `--- smoke-close-all: PASS ✓ ---`.

Existing smoke tests are unaffected (53 + 41 + 20 assertions across
`smoke-state.js`, `smoke-multiplier-cycle.js`, `smoke-pause-resume.js`
all still green).

## Deploy

No new secrets, no new GitHub Actions inputs, no new cron-job.org
entries. Steps:

1. **Pull the patch** (or apply the zip).
2. **Push to GitHub.** The Cloudflare worker re-reads `config.json`
   from the repo on every Telegram update, so the new commands /
   buttons go live as soon as `worker/index.js` is redeployed.
3. **Update the worker** in the Cloudflare dashboard (paste the new
   `worker/index.js` into the editor and Save).
4. **Done.** Tap `/menu` in Telegram to see the new 🛑 / 🔻 row.

The runner picks up `trading_enabled` automatically on its next tick —
no workflow file change needed.
