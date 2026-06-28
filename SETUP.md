# AURELIA — Setup

A from-scratch deployment guide. If you already have `motionsalt-headless`
running, the GitHub PAT, Deriv tokens, Telegram bot, and **cron-job.org
account carry over unchanged** — you just need to add the Gemini step
and point cron-job.org at the AURELIA workflow URL.

---

## 0. Prerequisites

- A Deriv account (demo + real loginids).
- A Telegram bot from `@BotFather`, and your personal chat id.
- A Google AI Studio account with at least one Gemini API key.
- A GitHub account; create a **NEW empty repo** for AURELIA. Do not
  push into the `motionsalt-headless` repo — the spec is explicit that
  this is a separate bot running side by side.
- A Cloudflare account for the Worker (free tier is fine).
- A free **cron-job.org** account — AURELIA does **not** trust GitHub
  Actions' native `schedule:` block (it routinely jitters 5–30 min and
  silently drops runs at peak load, which is fatal for a 15s cycle).

---

## 1. Create the repo

```bash
git init aurelia
cd aurelia
# copy the contents of this archive into the new repo
git add .
git commit -m "init: AURELIA scaffold"
git remote add origin https://github.com/<you>/aurelia.git
git push -u origin main
```

---

## 2. GitHub Actions secrets

Go to **Settings → Secrets and variables → Actions → New repository secret**
and add:

| Name                 | Value                                              |
|----------------------|----------------------------------------------------|
| `DERIV_BEARER_TOKEN` | Your Deriv OAuth bearer token                      |
| `DERIV_APP_ID`       | Deriv app id (e.g. `1089` for testing)             |
| `DERIV_REAL_ID`      | Your `ROT...` real loginid                         |
| `DERIV_DEMO_ID`      | Your `DOT...` demo loginid                         |
| `TELEGRAM_BOT_TOKEN` | From BotFather                                     |
| `TELEGRAM_CHAT_ID`   | Your numeric chat id                               |
| `PAT_TOKEN`          | A PAT with **`repo`** + **Actions: read & write**  |
| `GEMINI_KEY_PRIMARY` | A real Gemini API key (you can add more later)    |

The PAT scopes specifically:
- **Classic PAT**: `repo` (full) and `workflow`.
- **Fine-grained PAT**: enable **Actions → Read & write**,
  **Contents → Read & write**, and **Metadata → Read** for this repo.

Once `GEMINI_KEY_PRIMARY` is added, also append its name to
`config.ai.key_registry` in `config.json`:

```json
"ai": {
  "key_registry": ["GEMINI_KEY_PRIMARY"]
}
```

(After that, add more keys the same way from Termux — `gh secret set` +
manual edit to `key_registry`. There's intentionally no Telegram command
for this.)

---

## 3. Cloudflare Worker

No npm dependencies — just paste `worker/index.js` directly into the
Cloudflare dashboard's Quick Edit / Worker editor and save.

If you'd rather deploy via wrangler from a dev machine instead:

```bash
cd worker
npx wrangler login
npx wrangler deploy
```

In the Cloudflare dashboard, open the worker → **Settings → Variables**
and add as plain text vars (or use `wrangler secret put`):

| Name                 | Example                                            |
|----------------------|----------------------------------------------------|
| `TELEGRAM_BOT_TOKEN` | …                                                  |
| `TELEGRAM_CHAT_ID`   | …                                                  |
| `GITHUB_PAT`         | Same PAT as above                                  |
| `GITHUB_OWNER`       | e.g. `motionssalt`                                 |
| `GITHUB_REPO`        | `aurelia`                                          |
| `GITHUB_WORKFLOW`    | `aurelia-cron.yml`                                 |
| `GITHUB_REF`         | `main`                                             |

Then point Telegram at the worker URL:

```
https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=<worker_url>
```

You should see `{"ok":true,"result":true,"description":"Webhook was set"}`.

---

## 4. First run

In Telegram, send `/menu`. You should see the AURELIA menu with the 🟡 DEMO
badge. Try:

```
/status         ← state file readable?
/settings       ← settings panel works?
/scan           ← fire one manual AI trade (demo)
```

When you're satisfied, configure the cycle session:

```
/setcapital 100
/settp 20
/setsl 20
/startcycle
```

The bot will run the cycle until TP or SL is hit, then halt itself.
**But it will NOT actually tick until cron-job.org is wired up — step 5.**

---

## 5. Set up cron-job.org (the reliable scheduler)

AURELIA's workflow file deliberately ships **without** a `schedule:`
block — see the long comment in `.github/workflows/aurelia-cron.yml`.
The native GitHub Actions cron jitters 5–30 minutes and silently drops
runs at peak load, which is fatal for a trading bot. We replace it with
cron-job.org.

Create a free account at <https://cron-job.org/> and set up **two**
cronjobs (or three, if you want the extra heartbeat safety net):

### 5a. Main cycle every 5 minutes  ← **REQUIRED**

| Field          | Value                                                                              |
|----------------|------------------------------------------------------------------------------------|
| Title          | `aurelia — cycle 5m`                                                              |
| URL            | `https://api.github.com/repos/<OWNER>/<REPO>/actions/workflows/aurelia-cron.yml/dispatches` |
| Method         | `POST`                                                                            |
| Schedule       | every 5 minutes                                                                    |
| Request body   | `{"ref":"main","inputs":{"task":"cycle"}}`                                       |
| Request headers| `Authorization: Bearer <PAT_TOKEN>`<br>`Accept: application/vnd.github+json`<br>`Content-Type: application/json` |

> Tip: cron-job.org's *Test run* button returns the GitHub response
> body — useful for confirming the PAT scopes are right (`204 No Content`
> means success).

### 5b. Daily summary at 00:00 UTC  ← **REQUIRED**

| Field          | Value                                                                  |
|----------------|------------------------------------------------------------------------|
| Title          | `aurelia — daily summary`                                              |
| URL            | (same as above)                                                        |
| Method         | `POST`                                                                 |
| Schedule       | once daily at `00:00 UTC`                                              |
| Request body   | `{"ref":"main","inputs":{"task":"daily_summary"}}`                    |
| Headers        | (same as above)                                                        |

This emits the **Daily Summary** Telegram card and resets
`state.daily_stats` for the new UTC day (rolling stats are archived in
`state.daily_history`, capped at 60 days). You can also fire one
on-demand from Telegram: `/summary`, `/dailysummary`, or
**Settings → 📊 Daily → ▶️ Run summary now**.

### 5c. (Optional) Settlement heartbeat every 10 minutes

If you want belt-and-braces protection against a hung contract sitting
around when the cycle is paused, add a third cronjob:

| Field          | Value                                                                  |
|----------------|------------------------------------------------------------------------|
| Title          | `aurelia — settle heartbeat`                                           |
| URL            | (same as above)                                                        |
| Method         | `POST`                                                                 |
| Schedule       | every 10 minutes                                                       |
| Request body   | `{"ref":"main","inputs":{"task":"settle_only"}}`                      |
| Headers        | (same as above)                                                        |

This task is cheap (just reads Deriv balance + settles pendings), runs
even when `config.cycle.running=false`, and helps the worker's silent-bot
alert know the system is alive.

---

## 6. Settings panel (Telegram UI)

Tap **⚙️ Settings** from the main menu. Each subsection edits
`config.json` live via the GitHub Contents API — no redeploy required.

| Subsection           | What you tune                                                   |
|----------------------|-----------------------------------------------------------------|
| 🌀 Cycle             | capital / TP / SL / interval (+/- step buttons)                |
| 📡 Symbols           | enable/disable, add/delete per pool (Forex + Synthetics)       |
| 🔄 Account           | demo ↔ real (real requires inline confirmation)                 |
| 🧠 AI                | min_confidence / max_history_entries / bench_minutes           |
| 💸 Payout filter     | global threshold + per-symbol overrides + master ON/OFF        |
| 📊 Daily             | auto-send toggle, reset toggle, "run summary now"              |
| 💰 Stake bounds      | absolute min / absolute max                                    |

Slash-command equivalents are still available for power users:
`/setcapital`, `/settp`, `/setsl`, `/setinterval`, `/setpayout`,
`/syn on|off`, `/mode demo|real`, `/summary`, `/scan`, `/startcycle`,
`/pausecycle`. Run `/help` (or send any unknown command) to see the
full list.

---

## 7. Symbol management

Aurelia ships with **14 forex pairs enabled and all 10 synthetics
disabled** plus a master synthetic gate (`config.syn_enabled = false`).
This combination is intentional — synthetic-index trading is
high-variance and we don't want the AI selecting them by accident.

To manage symbols from Telegram:

1. **⚙️ Settings → 📡 Symbols → 💱 Forex** (or 🎲 Synthetic).
2. Tap a symbol to toggle its enabled flag.
3. Use **➕ Add** to expose more from the built-in catalog
   (worker-side `SYMBOL_CATALOG_FOREX` / `SYMBOL_CATALOG_SYN`).
4. Use **🗑 Remove** to delete a symbol key from config entirely.
5. For synthetics, the SYN master gate must also be ON before any of
   them actually fire — the runner enforces this in `isSymbolEnabled()`.

Symbol enable state is also enforced **in the runner** as a defence in
depth: even if the AI somehow returns a disabled symbol, the trade is
skipped with a logged reason.

---

## 8. Payout-threshold filter

AURELIA's new defensive filter rejects any AI-approved trade whose
**Deriv-quoted payout ratio** falls below a configurable threshold.
This protects you from the AI happily picking a 65% payout on an
illiquid timeframe.

How it works in `runner.js`:

1. AI returns `{action:"trade", symbol, direction, stake, expiry_seconds, ...}`.
2. Runner validates + clamps stake & expiry.
3. Runner sends a Deriv `proposal` request for that exact contract.
4. Computes `ratio = payout / ask_price - 1`.
5. If `ratio < threshold` (per-symbol override → falls back to global),
   the trade is **skipped** and a 🛑 Telegram notice is sent.

Defaults:
- `payout.enabled = true`
- `payout.min_threshold = 0.80` (80% payout)
- `payout.per_symbol = {}` (empty — global applies)

Edit from Telegram:

```
/setpayout 0.85                 # global default → 85%
/setpayout frxEURUSD 0.82       # override only EURUSD
/setpayout clear frxEURUSD      # remove the override
```

…or via **⚙️ Settings → 💸 Payout filter** for inline +/- adjusters.
The Per-symbol overrides screen shows all current overrides with a 🗑
button on each to clear.

If Deriv's proposal endpoint times out or fails, AURELIA logs a warning
and **allows the trade** (fail-open) — better to take a possibly-bad
payout than to silently never trade.

---

## 9. Daily summary & stat reset

State has two trade-stats blocks now:

- `state.cycle_session` — per-session counters with TP/SL enforcement.
  Reset every `/startcycle` invocation.
- `state.daily_stats`   — calendar-day cumulative counters, updated on
  every settlement (cycle **and** manual). Reset by the
  `daily_summary` task.

When the **daily summary** task runs:

1. Settles any pending contracts first (so books close properly across
   midnight UTC).
2. Sends `Telegram.templates.dailySummary` with today's `{trades, wins,
   losses, pnl, win%}`.
3. Pushes a snapshot into `state.daily_history` (capped at 60 days)
   including `by_symbol` breakdown.
4. Resets `state.daily_stats` to a fresh UTC date counter (skip this by
   setting `daily_summary.reset_on_send = false`).

You can disable auto-send entirely (`daily_summary.enabled = false`) if
you want manual-only reports.

---

## 10. Going live

```
/mode real
/startcycle
```

The badge in every message flips to 🔴 REAL. There is intentionally no
single-click "real mode" — you must type or tap it explicitly, and the
button-driven flow asks for an inline confirmation. The TP/SL session
envelope is enforced in code regardless of mode, and so is the payout
filter.

---

## 11. Troubleshooting

| Symptom                                          | Likely cause                                                                 |
|--------------------------------------------------|------------------------------------------------------------------------------|
| `getWebhookInfo` shows recent errors             | Cloudflare worker rejected the update — open the worker logs in real-time.   |
| `/startcycle` works but no trades fire           | cron-job.org cycle job not enabled, or wrong PAT scopes.                     |
| GitHub returns 404 on dispatch                   | Wrong `GITHUB_OWNER` / `GITHUB_REPO` / `GITHUB_WORKFLOW` env on the worker. |
| `dispatch ... 401`                               | PAT lacks `Actions: write` or `Contents: write`.                             |
| `No Gemini keys registered`                      | Add one as a secret (`gh secret set GEMINI_KEY_FOO`) and append its name to `config.ai.key_registry`. |
| `All keys benched`                               | Inspect `last-status.json → ai_keys_bench`; the runner will still try the least-recently-benched key as a last resort. Add a fresh key from Termux if needed. |
| Cycle stuck at "cooldown"                        | `state.next_cycle_eligible_at` set into the future. Fire `/pausecycle` then `/startcycle` to reset cleanly. |
| Trades skipped with "payout NN% < threshold"     | Lower the threshold (`/setpayout 0.75`) or override that symbol specifically. |
| Daily summary never arrived                      | Confirm cron-job.org daily job is enabled AND `config.daily_summary.enabled` is true. Fire `/summary` to test manually. |
| Telegram shows "AURELIA — BOT SILENT"            | No tick observed in 15 min. cron-job.org probably stopped POSTing — check the *History* tab there. |

---

You're done. Have fun, and trade responsibly.
