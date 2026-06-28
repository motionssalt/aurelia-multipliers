# AURELIA-Multipliers — Merge Notes (Parts 1 → 3c)

Integration of 7 isolated-session deliverables (Part 1, 2a, 2b, 2c, 3a, 3b, 3c)
into one working repo. Each part was reviewed against the others' code (not
just summaries) before constructing this merged tree.

---

## 1. Lineage determined by diff (not by part-number ordering)

Despite the brief warning that parts might be isolated, diffing the actual
file contents proved every later part **did** build on the prior part's
real output. The chain is fully linear:

```
       p1
        │
        ▼
       p2a       ← (Part 2a: full repo snapshot; only runner.js + config.json changed vs p1)
        │
        ▼
       p2b       ← (Part 2b: partial; only ai-client.js + runner.js)
        │
        ▼
       p2c       ← (Part 2c: partial; ai-client.js byte-identical to p2b, runner.js+telegram.js extended)
        │
        ▼
       p3a       ← (Part 3a: partial; chart.js + runner.js. Built on p2c — has multiplierTickSummary refs.)
        │
        ▼
       p3b       ← (Part 3b: partial; config.json + worker/index.js only. Built on p2a's config.json. Worker base is p1==p2a.)
        │
        ▼
       p3c       ← (Part 3c: partial; runner.js + telegram.js + worker/index.js. runner.js built on p3a; worker on p3b.)
```

Evidence (markers grepped, byte-level):

| Marker                          | p1 | p2a | p2b | p2c | p3a | p3b | p3c |
|---------------------------------|----|-----|-----|-----|-----|-----|-----|
| `askMultiplierDecision` (real)  |  ✗ |  ✗  |  ✓  |  ✓  |  ✓  |  —  |  ✓  |
| `'multi'` action branch         |  ✗ |  ✗  |  ✓  |  ✓  |  ✓  |  —  |  ✓  |
| `multiplierTickSummary`         |  ✗ |  ✗  |  ✗  |  ✓  |  ✓  |  —  |  ✓  |
| `TODO PART 3` marker            |  ✗ |  ✗  |  ✗  |  ✓  |  ✗  |  —  |  ✗  | (Part 3a replaced it)
| `renderMultiplierSnapshot`      |  ✗ |  ✗  |  ✗  |  ✓ (TODO ref only) |  ✓  |  —  |  ✓  |
| `chart_windows`                 |  ✗ |  ✗  |  ✗  |  ✗  |  ✓  |  —  |  ✓  |
| `maybeSendSessionSummary`       |  ✗ |  ✗  |  ✗  |  ✗  |  ✗  |  —  |  ✓  |
| `session_started_at`            |  ✗ |  ✗  |  ✗  |  ✗  |  ✗  |  —  |  ✓  |
| `cry_enabled` / `POOL_CODES`    | ✗  |  ✗  |  —  |  —  |  —  |  ✓  |  ✓  | (`—` = file not in zip)
| `_notified_session_summary` in worker | ✗ | ✗ |  —  |  —  |  —  |  ✗  |  ✓  |

So per-file "latest" is unambiguous, with no contradiction to resolve.

---

## 2. Per-file selection in the merged tree

| File                  | Source kept     | Reason |
|-----------------------|-----------------|--------|
| `runner.js`           | **p3c**         | terminal node of the runner.js chain; contains p2a + p2b multi-action exec + p2c tick notify + p3a chart wiring + p3c session-summary hook + trade-history `session_started_at`. |
| `ai-client.js`        | **p2c** (= p2b) | p2c re-shipped p2b byte-identical; no later part touched it. |
| `telegram.js`         | **p3c**         | p3c added `sessionSummary` template on top of p2c's `multiplierTickSummary` + 4 helpers. |
| `chart.js`            | **p3a**         | only part to extend it (multiplier snapshot, palette, TP/SL annotations, auto-scroll window). |
| `config.json`         | **p3b**         | p3b is the only part after p2a that touched it (crypto pool + cry_enabled + gold). |
| `worker/index.js`     | **p3c**         | p3c built on p3b (Part 3b's POOL_CODES refactor + crypto menu) and added one line clearing `_notified_session_summary` latch in `startCycleSession`. |
| `deriv.js`            | p1 / p2a        | unchanged across all parts (verified md5). |
| `state.js`            | p1 / p2a        | unchanged. |
| `risk.js`             | p1 / p2a        | unchanged. |
| `indicators.js`       | p1 / p2a        | unchanged. |
| `logger.js`           | p1 / p2a        | unchanged. |
| `payload-builder.js`  | p1 / p2a        | unchanged. |
| `STATE_SHAPE.md`      | p1 / p2a        | unchanged. The `chart_windows` and `session_started_at` additions are documented inline in `runner.js` and the part summaries; STATE_SHAPE.md was not updated by any part — flagged below as **HUMAN REVIEW**. |

### scripts/ — union of latest

| Script                              | Source |
|-------------------------------------|--------|
| `smoke-state.js`                    | p1 / p2a |
| `smoke-multiplier-cycle.js`         | p2c (latest version, identical to p2b's) |
| `smoke-multiplier-decision.js`      | p2c (= p2b's) |
| `smoke-multiplier-tick-summary.js`  | p2c (new) |
| `smoke-multiplier-chart.js`         | p3a (new) |
| `smoke-pool-menu.js`                | p3b (new) |
| `smoke-session-summary.js`          | p3c (new) |

### docs/ — every part's hand-off summary preserved

`docs/PART_2B_SUMMARY.md`, `PART_2C_SUMMARY.md`, `PART_3A_SUMMARY.md`,
`PART_3B_SUMMARY.md`, `PART_3C_SUMMARY.md`.

---

## 3. Cross-part wiring verified (step-5 checklist from brief)

| # | Wiring                                                                                                          | Verified in merged `runner.js` |
|---|-----------------------------------------------------------------------------------------------------------------|--------------------------------|
| 1 | Part 2b's decision actually called from Part 2a's orchestration loop (not still stub) | `askMultiplierDecisionStub()` at line 957 delegates to `AIClient.askMultiplierDecision`; called from `runMultiplierCycle` at line 1726. No `{action:'hold'}` literal stub left. |
| 2 | Part 2c notification fires using Part 2b decision output, where Part 2a expected it                          | `Telegram.templates.multiplierTickSummary({...})` at line 1856, fed with `decision`, `executed.details`, `preActionSiblings`, `postActionSiblings`. |
| 3 | Part 3a chart invoked and image actually attached via `sendPhoto()` at Part 2c's TODO marker                  | `Chart.renderMultiplierSnapshot(...)` at line 1894 → `Telegram.sendPhoto(chartBuf, caption)` at line 1934, with `Telegram.send(msg)` fallback at line 1938. **Zero `TODO PART 3` markers remain.** |
| 4 | Part 3b symbol categories actually reachable by the cycle's symbol-selector                                   | **FIX REQUIRED — see §4.** Without the fix, Part 3b's crypto pool would have been a dead toggle. |
| 5 | Part 3c session-summary reads the same `trade_history_cycle` shape Part 2c writes                              | `realizeClosedSibling()` at line 1093 writes `session_started_at: (sess && sess.started_at) || null`; `maybeSendSessionSummary()` at line 1450 reads it (with a `record.ts >= session.started_at` fallback for older records). |

---

## 4. Merge-time fix: Part 3b ↔ Part 2a wiring gap

**The one real bug surfaced by the merge.** Faithfully consolidating the
7 zips — without this fix — would have shipped a bot where:

- `worker/index.js` has full crypto settings parity (menu, toggle, slash
  command, master gate `cry_enabled`, per-symbol pool `symbols.crypto`).
- `config.json` ships with `cryBTCUSD: true, cryETHUSD: true` in the
  crypto pool.
- ...but `runner.js#isSymbolEnabled()` (line 80) and
  `runner.js#resolveActiveSymbol()` (line 758) only understood the
  original `forex` and `synthetics` pools. Any `cry`-prefixed symbol
  would fall through to the `forex` branch (because `isSyntheticSymbol`
  returns false for `cry*`), be looked up in `config.symbols.forex` (not
  there), and `isSymbolEnabled` would return `false`. The cycle would
  silently never trade crypto, even with the operator toggling it on
  in Telegram.

Part 3b's own summary actually confessed this risk:

> *"`runner.js`'s `isSymbolEnabled()` treats any non-synthetic symbol as
> forex (via `isSyntheticSymbol(sym) → false → fallback to fx[sym]`)..."*

…and Part 3b dodged the issue **only for gold** by routing `frx`-prefixed
metals into the existing forex pool. `cry*` had no such dodge.

**Fix applied (in `runner.js`):**

1. Added `isCryptoSymbol(sym)` helper: `/^cry[A-Z]/.test(sym)`.
2. Extended `isSymbolEnabled` with a crypto branch gated by
   `config.cry_enabled` against `config.symbols.crypto[sym]`.
   Default semantic for `cry_enabled` is **opt-in (false)** — matches
   exactly what Part 3b's summary documented for the worker side.
3. Extended `resolveActiveSymbol` with a third pool sweep over
   `config.symbols.crypto` when `config.cry_enabled === true`.

Both edits are localized, byte-minimal, and preserve all prior behaviour
(forex / synthetics / gold-via-forex unchanged). Sanity tested with a
6-case script (T1–T6 below) before deletion of the scratch script.

```
T1 isSymbolEnabled cryBTCUSD (enabled,listed):    true   ← was: false (bug)
T2 isSymbolEnabled cryETHUSD (enabled,unlisted):  false
T3 isSymbolEnabled cryBTCUSD (gate off):          false
T4 resolveActiveSymbol crypto-only:               cryBTCUSD   ← was: null (bug)
T5 (regression) resolveActiveSymbol forex-only:   frxEURUSD
T6 isSymbolEnabled frxXAUUSD forex pool:          true        (gold unaffected)
```

The fix is the only behaviour-changing line of code added during the
merge. Everything else was straight copy from the source-of-truth zip
for each file.

---

## 5. Sanity checks

### `node --check`

All `.js` files parse cleanly:

```
final/runner.js                          OK
final/ai-client.js                       OK
final/telegram.js                        OK
final/chart.js                           OK
final/worker/index.js                    OK
final/deriv.js                           OK
final/state.js                           OK
final/risk.js                            OK
final/indicators.js                      OK
final/logger.js                          OK
final/payload-builder.js                 OK
final/scripts/*.js                       OK (all 7)
```

### Smoke tests (after `npm install ws technicalindicators node-fetch`)

All 7 pass — both the original suites carried forward from earlier parts
and the new ones each later part added:

```
smoke-state.js                  53 passed, 0 failed
smoke-multiplier-cycle.js       41 passed, 0 failed   ← Part 2a
smoke-multiplier-decision.js    22 passed, 0 failed   ← Part 2b
smoke-multiplier-tick-summary   47 passed, 0 failed   ← Part 2c
smoke-multiplier-chart.js       43 passed, 0 failed   ← Part 3a
smoke-pool-menu.js              ALL OK                ← Part 3b
smoke-session-summary.js        🟢 Part 3c smoke OK   ← Part 3c
```

`puppeteer` was intentionally skipped during smoke installs (heavy, not
needed — Part 3a's smoke is pure-logic, Puppeteer rendering is exercised
live by the runner at deploy time and falls back to text-only on error).

### Duplicate / dead code

- `runner.js`, `ai-client.js`, `telegram.js`, `worker/index.js`: zero
  duplicate top-level `function` / `const` declarations.
- `chart.js`: a handful of duplicate `const` / `function sizeCanvas`
  matches at column 0 — **not real duplicates**. They live inside two
  separate browser-side `<script>` strings interpolated into the two
  HTML templates (`buildHtml` for the binary path, `buildMultiplierHtml`
  for multipliers). Each template runs in its own Puppeteer page; the
  same identifier in two different pages is correct and intentional
  (Part 3a's summary documented this: *"each owns its own HTML/CSS
  template so changes to one cannot regress the other"*).
- No leftover `TODO PART 2C` or `TODO PART 3` markers.
- No `{action:'hold'}` literal stub. The function `askMultiplierDecisionStub`
  still exists by that name (Part 2b kept the export to preserve
  backwards-compat for any out-of-tree caller) but its body delegates
  fully to `AIClient.askMultiplierDecision`.

### Naming/shape mismatches

None found. Each part's summary documented the exact exports it relied
on, and grepping confirms all consumer-side calls resolve to defined
producer-side functions:

- `AIClient.askMultiplierDecision` ✓ (exported at `ai-client.js:959`,
  called at `runner.js:968` and `:1726` via the stub wrapper)
- `Telegram.templates.multiplierTickSummary` ✓ (defined in
  `telegram.js`, called at `runner.js:1856`)
- `Telegram.templates.sessionSummary` ✓ (defined at p3c addition in
  `telegram.js`, called at `runner.js:1526`)
- `Chart.renderMultiplierSnapshot` ✓ (defined in `chart.js`, called at
  `runner.js:1894`)
- `State.getOpenSiblings`, `Deriv.getOpenPositionState` ✓ (already
  Part 1's contract — every later part calls these by their original names)
- `runner.maybeSendSessionSummary` ✓ (defined at `runner.js:1450`,
  exported at `:2190`, called from inside the same file)
- Worker's `_notified_session_summary` latch ✓ — clear-on-start in
  worker matches the read-and-set inside `maybeSendSessionSummary`.

---

## 6. Items that still need human review before live trading

These are NOT bugs introduced by the merge; they are pre-existing items
that warrant attention before connecting real money.

1. **`STATE_SHAPE.md` is out of date.** It describes the Part 1 shape
   only. Two additive fields have been introduced since:
     - `chart_windows[symbol] = { min, max }` (Part 3a)
     - `_notified_session_summary` (Part 3c latch)
     - `trade_history_cycle[*].session_started_at` (Part 3c)
     - `trade_history_cycle[*].ai_outcome_note` (already implicitly there)
   Both are fully additive (no breakage), but the canonical doc should
   be brought in line.

2. **Telegram caption-cap policy is conservative.** Per Part 3a, the
   tick body can hit ~800–1000 chars on a busy `multi` decision with 4
   siblings; the merged code trims to 1024 minus an ellipsis marker.
   Part 2c flagged a possible future split (`sendPhoto` with short
   caption + separate `send` for full body); Part 3a chose not to
   implement it. **Worth verifying with one real busy tick** that
   nothing important gets trimmed.

3. **No `state.js` smoke for the Part 3c additive field.** The
   `session_started_at` field is added by the runner inline (no
   `State.*` helper); pre-existing `smoke-state.js` therefore doesn't
   exercise it. The new `smoke-session-summary.js` does cover the
   full read/write loop functionally.

4. **`config.json` ships `cry_enabled: false`.** Per Part 3b's opt-in
   convention this is correct, but it means the merge fix (§4) is
   logically reachable only after the operator turns the gate on via
   `/cry on` or the settings menu. Worth a manual "flip gate, restart
   cycle, confirm `cryBTCUSD` is the chosen `active_symbol`" test
   before relying on it in production.

5. **Puppeteer rendering of `buildMultiplierHtml` was not live-exercised
   in this merge.** The pure-logic smoke covers all the math
   (`_siblingPriceLevels`, `advanceChartWindow`, palette assignment),
   but the actual headless-Chromium → PNG path needs a one-tick deploy
   verification. The runner gracefully falls back to text-only on any
   chart failure, so this is non-fatal — just verify it once.

6. **AI-provider keys not configured here.** Standard for any
   pre-deploy state; flagged only for completeness.

---

## 7. Nothing genuinely contradictory was found

The brief asked us to flag any two parts' changes to the same file that
are genuinely incompatible. None were found:

- `runner.js`: linear chain, each part's edits strictly additive over
  the prior.
- `worker/index.js`: Part 3b refactor (POOL_CODES, ensureSymbolPools)
  + Part 3c additive line (`_notified_session_summary` clear in
  `startCycleSession`) sit in different functions; no overlap.
- `telegram.js`: Part 2c added `multiplierTickSummary` + helpers;
  Part 3c added `sessionSummary` + one extra helper. Both touch the
  templates object but at different keys, no collision.
- `config.json`: only Part 2a and Part 3b touched it; Part 3b's
  changes are pure additions on top of Part 2a's.

The only thing that **looked** like it could conflict — a new symbol
category in Part 3b vs. the Part 2a cycle's symbol selector — turned
out to be a wiring gap (one side aware of crypto, the other side not),
not a contradiction. Fixed in §4.
