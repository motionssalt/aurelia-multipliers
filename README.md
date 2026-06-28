# AURELIA-MULTIPLIERS

AI-driven Deriv **Multipliers** trading bot. Fork of
[`aurelia`](https://github.com/) (the binary-options original); the AI
brain and the cron / Worker / Telegram plumbing are the same, but the
contract engine trades MULTUP / MULTDOWN positions that stay open
between cron ticks instead of fixed-expiry binaries that settle on
their own.

> **Build status (this repo).**
>
> | Part | Status | Owns |
> |---|---|---|
> | **Part 1 — contract engine + state shape** | ✅ in this commit | `deriv.js` multiplier functions, `state.js` sibling helpers, `STATE_SHAPE.md` |
> | Part 2 — cycle tick re-evaluates each open position | 🔜 next session | Hold / close / revise decision loop, AI prompt, Telegram |
> | Part 3 — session summary + risk-limit enforcement | 🔜 future session | Stop-out-distance reactions, end-of-session report, daily reset |
>
> Modules carried over from upstream unchanged in Part 1:
> `logger.js`, `indicators.js`, `risk.js`, `payload-builder.js`,
> `chart.js`, `runner.js`, `ai-client.js`, `telegram.js`, `config.json`
> (Parts 2/3 will rewrite the cycle path inside `runner.js`).

## Feature status (v2)

| Feature                                  | Status              |
|------------------------------------------|---------------------|
| External cron-job.org scheduling         | ✅                   |
| Symbol add / delete / enable / disable   | ✅ (forex + syn)     |
| Full Settings panel in Telegram          | ✅                   |
| Global symbol payout-threshold filter    | ✅ (+ per-symbol)    |
| Daily summary + stat reset (UTC)         | ✅                   |
| Heartbeat “BOT SILENT” alert             | ✅                   |
| Multi-key Gemini failover + key benching | ✅                   |

---

## How it works

```
┌──────────────────────┐    Telegram     ┌──────────────────────┐
│  You (Telegram chat) │ ◀──────────────▶ │  Cloudflare Worker   │
└──────────────────────┘                  │  (control plane)     │
                                          └──────────┬───────────┘
                                                     │ config.json edits + workflow_dispatch
                                                     ▼
┌──────────────────────┐   POST dispatches    ┌──────────────────────┐
│   cron-job.org        │ ───────────────────▶ │   GitHub Actions     │
│   every 5min: cycle   │                      │   runs runner.js     │
│   daily 00:00 UTC →   │                      │   on every tick      │
│   daily_summary       │                      └──────────┬───────────┘
└──────────────────────┘                                  │
                       ┌──────────────────────────────────┴────────────────────────────┐
                       ▼                                                               ▼
              ┌─────────────────┐                                       ┌────────────────┐
              │ payload-builder │  M5/M10/M15 candles + indicators      │   Gemini API   │
              │ (deterministic) │ ──────────────────────────────────▶   │ (decides only) │
              └─────────────────┘                                       └────────┬───────┘
                                                                                 │ JSON
                                                                                 ▼
                                                              { action, symbol, direction,
                                                                expiry, stake, confidence,
                                                                rationale }
                                                                                 │
                                                                                 ▼
                                                                        ┌────────────────┐
                                                                        │   risk.js +    │
                                                                        │   payout       │
                                                                        │   filter       │
                                                                        └────────┬───────┘
                                                                                 ▼
                                                                        ┌────────────────┐
                                                                        │  Deriv API     │
                                                                        │  places trade  │
                                                                        └────────────────┘
```

The AI **never** sees raw chart images, **never** calls the Deriv API
directly, and **never** enforces session limits. It only consumes a
structured payload and returns a structured decision. Everything else —
indicator computation, expiry clamping (≥ 15 min for forex intraday),
stake clamping, **per-symbol enable check, payout-threshold check**,
TP/SL enforcement, GitHub state persistence — happens in deterministic
code that you can audit line by line.

### Why cron-job.org and not GitHub Actions' built-in `schedule:` ?

GitHub's native cron is **unreliable**: it jitters 5–30 min and silently
drops runs at peak load. That's tolerable for a daily-report bot. It is
**not** tolerable for a 15-second-interval trading cycle. AURELIA's
workflow file ships with the `schedule:` block deliberately removed; an
external **cron-job.org** account fires `POST /dispatches` every 5
minutes for the cycle and once a day for the summary. See `SETUP.md` §5
for the exact request bodies.

---

## Two independent trading paths

| Path        | Trigger                                                              | Position lock | TP/SL session | Recorded in            |
|-------------|----------------------------------------------------------------------|---------------|---------------|------------------------|
| **Cycle**   | Fires `interval_seconds` after the previous cycle trade *settles*    | One open at a time | Yes — `cycle_session.capital/take_profit/stop_loss` | `trade_history_cycle`  |
| **Manual**  | `/scan` or 🤖 button — runs immediately                              | None — can fire while a cycle trade is open | No — stateless w.r.t. cycle | `trade_history_manual` |

A cycle session is defined by **capital / take-profit / stop-loss**, set
in config or via Telegram. The instant `pnl >= take_profit` or
`pnl <= -stop_loss`, the cycle halts. **The AI cannot override this.**

Both paths feed `state.daily_stats` (calendar-day cumulative) so the
daily summary covers the entire day's activity, not just one session.

---

## What the AI gets per call

Per enabled symbol, for each of M5, M10, M15:

- Last ~40 OHLC candles (5+ hours coverage at the timeframe)
- Full indicator pack: RSI, EMA(20/50), MACD, BollingerBands, ATR, ADX,
  Stochastic, Keltner, Donchian, Ichimoku
- Support/resistance pivot levels (last 3 each)
- Candlestick pattern flags (doji, hammer, engulfing, morning/evening star)
- Volatility proxy (M5 ATR14)

Plus session context (capped to last 12 trades by default):

- Running W/L, streaks, P/L, capital remaining
- Distance to TP and to SL
- Each prior trade's rationale **and** the AI's own one-sentence
  retrospective (`ai_outcome_note`) captured at settlement

**No raw tick data is sent.** **No chart images are sent.** The screenshot
attached to Telegram trade notifications is generated *after* the AI's
decision, purely for your audit trail.

---

## Symbol pools (forex / synthetic) + SYN gate

`config.symbols` is split into `forex` and `synthetics`, each a map of
`{symbol: enabledFlag}`. Forex symbols default to enabled; synthetics
default to disabled, gated additionally by `config.syn_enabled` (master
switch). **Both layers must be ON** for a synthetic symbol to actually
trade.

Manage them entirely from Telegram:

- **⚙️ Settings → 📡 Symbols → 💱 Forex** (or **🎲 Synthetic**)
- Tap any symbol → toggles enabled state
- **➕ Add** → picks from the worker-side catalog of available symbols
- **🗑 Remove** → confirms then deletes the key from config entirely
- **🎛 SYN gate** (main menu) → master flip for the synthetic pool

Crypto symbols are intentionally left out of the catalog — add them by
editing `config.symbols.forex` (or extending `SYMBOL_CATALOG_FOREX` in
`worker/index.js`) if you want them back.

The runner enforces `isSymbolEnabled()` on every AI decision as defence
in depth — even if the AI somehow names a disabled symbol, the trade
is skipped with a logged reason.

---

## Payout-threshold filter

A defensive code-level filter that runs **after** the AI returns a trade
decision. The runner fetches a Deriv `proposal` for the exact contract,
computes the implied payout ratio (`payout / ask_price - 1`), and skips
the trade if it falls below the active threshold (per-symbol override
falls back to the global `payout.min_threshold`, default 80%).

Manage from **⚙️ Settings → 💸 Payout filter**, or:

```
/setpayout 0.85                # global default → 85%
/setpayout frxEURUSD 0.82      # override only EURUSD
/setpayout clear frxEURUSD     # remove override
```

Fails open if Deriv's proposal endpoint times out — better to take a
possibly-bad payout than to silently never trade.

---

## Daily summary + stat reset

Two stat blocks live in `last-status.json`:

- `cycle_session` — per-cycle counters, reset every `/startcycle`,
  enforces TP/SL.
- `daily_stats`   — calendar-day cumulative counters, updated on every
  settlement (cycle **and** manual), reset by the `daily_summary` task.

cron-job.org fires `{task:"daily_summary"}` at 00:00 UTC. AURELIA:

1. Settles any pending contracts (so books close cleanly across midnight).
2. Sends the `dailySummary` Telegram card.
3. Archives a snapshot (incl. per-symbol breakdown) into
   `state.daily_history` (capped at 60 days).
4. Resets `state.daily_stats` for the new UTC day (skip with
   `daily_summary.reset_on_send = false`).

Manual trigger: `/summary` from Telegram, or **⚙️ Settings → 📊 Daily
→ ▶️ Run summary now**.

---

## Multi-key Gemini failover

Keys are managed from Termux now, not Telegram — the worker has no npm
dependencies and no GitHub secrets-write code, so it can be pasted
directly into the Cloudflare dashboard editor.

```
# Termux: add a key as a GitHub Actions secret
gh secret set GEMINI_KEY_ALPHA --repo OWNER/REPO

# Then add "GEMINI_KEY_ALPHA" to config.ai.key_registry in config.json
# (edit the file directly, or via the GitHub API/gh CLI)
```

Each key lives as a GitHub Actions secret (never readable back), and its
**name** must appear in `config.ai.key_registry`. On every Gemini call the
runner tries keys in order; a key that errors or hits quota is benched for
2 hours (configurable via `config.ai.bench_minutes`). Bench state lives in
`last-status.json → ai_keys_bench` so it survives between ticks.

---

## Demo first, real on purpose

`config.account.mode = "demo"` by default. Switch to real explicitly via
`/mode real` or the inline button (which always asks for an inline
confirmation). The badge in every Telegram message makes the active
account unmistakable (🟡 DEMO / 🔴 REAL).

---

## Repo layout

```
aurelia/
├── runner.js              # tick state machine (cycle / manual / settle_only / daily_summary)
├── ai-client.js           # Gemini wrapper + multi-key failover + benching
├── payload-builder.js     # builds the per-cycle AI payload
├── indicators.js          # RSI, EMA, MACD, BB, ATR, ADX, S/R, patterns…
├── deriv.js               # Deriv OAuth → OTP → WebSocket (carried from old bot)
├── chart.js               # puppeteer chart screenshots (carried from old bot)
├── telegram.js            # outbound TG client + templates (carried)
├── logger.js              # structured logger + ring buffer (carried)
├── risk.js                # stake/expiry sanity clamp (does NOT compute stake)
├── config.json            # toggles, session params, payout filter, key registry
├── last-status.json       # state file, committed by CI every tick
├── worker/
│   ├── index.js           # Cloudflare Worker — Telegram webhook + Settings UI + GH API
│   ├── package.json
│   └── wrangler.toml
└── .github/workflows/
    └── aurelia-cron.yml   # GH Actions workflow_dispatch only (schedule is external)
```

See [`SETUP.md`](./SETUP.md) for first-time deployment instructions
(including the full cron-job.org wiring in §5).
