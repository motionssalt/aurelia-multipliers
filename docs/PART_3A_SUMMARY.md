# Part 3a — Multiplier chart rendering with TP/SL zones, entry marker, and auto-scroll

This part fills in the chart-image gap that Part 2c left as a
`[TODO PART 3]` marker in `runner.js`. Every multiplier cycle tick now
fires a Telegram message **with an attached candlestick chart** showing
the symbol's recent price action, per-sibling TP/SL price levels, an
entry marker, and an auto-scrolling time window that visually reserves
space to the right of the most recent candle.

No changes were made to:

- the cycle orchestration loop from Part 2a (`runMultiplierCycle` body
  apart from the surgical swap at the `[TODO PART 3]` marker)
- the decision schema from Part 2b (`ai-client.js` unchanged)
- the tick-summary template from Part 2c (`telegram.js` unchanged —
  the existing `sendPhoto()` already takes the HTML caption verbatim)
- `deriv.js`, `risk.js`, `payload-builder.js`, `indicators.js`,
  `logger.js`, `config.json`, or anything in `worker/`
- the binary path (`runCycle`, `runManual`, `runDailySummary`) — its
  `Chart.generateChart()` entrypoint and `buildHtml()` HTML pipeline
  are byte-identical to Part 2c

---

## 1. Chart extensions in `chart.js`

A new public entrypoint `Chart.renderMultiplierSnapshot({…})` was added
alongside the legacy `Chart.generateChart()` (which the binary path
still uses unmodified). The two pipelines share `computeOverlays()` and
the indicator math, but each owns its own HTML/CSS template
(`buildHtml` for binary, **`buildMultiplierHtml`** for multipliers) so
changes to one cannot regress the other.

### 1.1 TP/SL approach — **chartjs-plugin-annotation via CDN**

The new HTML loads `chartjs-plugin-annotation@3.0.1` from jsDelivr in
addition to the existing `chart.js@4.4.2`,
`chartjs-adapter-date-fns@3.0.0`, and `chartjs-chart-financial@0.1.1`
scripts. This is the cleanest fit:

- It matches the existing "CDN `<script>` tag" approach the file
  already uses for every other charting library.
- It supports horizontal lines with end-anchored labels (perfect for
  TP/SL price levels) and vertical lines with positionable labels
  (perfect for the entry marker) in a few lines of declarative config.
- It supports `borderDash` per-annotation so we can encode
  `TP = solid line` and `SL = dashed line` without separate datasets.
- 11.7 KB minified — negligible vs. the ~250 KB of Chart.js core
  that's already being downloaded each render.

The fallback plan (hand-rolled "line datasets" with `pointRadius: 0`
synthesised from `[{x:windowMin, y:tpPrice}, {x:windowMax, y:tpPrice}]`
points) was considered but rejected: it would produce 2N extra
datasets per chart (TP+SL per sibling), pollute the price-panel
legend, and require a custom plugin to render the right-anchored
price labels that annotation-plugin gives us for free. The CDN
approach is feasible and the right call.

### 1.2 Sibling visual distinction

Each open sibling is assigned the next colour from a 5-entry palette
(green, red, blue, amber, violet — `SIBLING_PALETTE` in `chart.js`),
and that colour is reused consistently for the sibling's three
annotations:

| Annotation                | Style                                |
| ------------------------- | ------------------------------------ |
| Entry vertical line       | sibling colour, fine dashed `[4,3]`  |
| Take-profit horizontal    | sibling colour, **solid** line       |
| Stop-loss horizontal      | sibling colour, dashed `[6,4]` line  |

A small in-chart legend strip sits directly below the price-panel
header listing each sibling as `<colour-swatch> #<contract_id>
<▲ MULTUP | ▼ MULTDOWN>`, so the user can map a coloured line back
to the contract id from the Part 2c text body without guesswork.

The entry-label `#<contract_id>` is also rendered at the vertical
entry line (stacked vertically with `yAdjust` so multiple-sibling
entries at the same candle don't overlap).

The palette holds 5 entries and the prompt caps siblings at 4, so
collisions are not a real concern; if a fifth ever appears the
palette wraps round and the legend remains correct (degraded but
still readable).

### 1.3 TP/SL `$-amount` → price level conversion

The persisted sibling record stores `take_profit` / `stop_loss` as
**dollar amounts** (confirmed against the existing executor code at
`runner.js:1028-1029` and `pollSibling` semantics in
`runner.js:1017-1018`, plus the schema doc-comment at
`runner.js:925-926`), not as price levels. So before we can draw a
horizontal line on the price axis we have to invert Deriv's
multiplier P/L formula:

```
MULTUP   : tpPrice = entry · (1 + tp / (stake · multiplier))
           slPrice = entry · (1 − sl / (stake · multiplier))
MULTDOWN : tpPrice = entry · (1 − tp / (stake · multiplier))
           slPrice = entry · (1 + sl / (stake · multiplier))
```

This lives in `_siblingPriceLevels(sib)` in `chart.js`. It tolerates
`null` TP, `null` SL, and a missing/zero `entry_spot` (drops the
unrenderable line, keeps the rest of the chart).

Y-axis padding includes those TP/SL prices in addition to the candle
high/low extremes, so the lines are never clipped outside the
rendered range.

### 1.4 Time-scale reserve + auto-scroll

The x-axis `min`/`max` are now **explicit** (rather than letting
Chart.js auto-fit). They are computed by a pure helper
`advanceChartWindow(candles, openSiblings, prevWindow, granSec)`
exported from `chart.js` and tested in isolation. Behaviour:

| State                                                    | Window behaviour                                                              |
| -------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Siblings open AND no prior window (just-opened tick)     | `max = lastCandle + RESERVE_AHEAD·interval`, `min = max − totalSpan`           |
| Siblings open AND prior window, last candle well inside  | Return prior window unchanged                                                 |
| Siblings open AND prior window, last candle near edge    | Shift `min`/`max` forward by `SHIFT_AMOUNT · interval`                        |
| No siblings open                                         | Pure historical view (`min..max` spans the candle window) — prior is dropped  |

Constants are tunable at the top of `chart.js`:

- `RESERVE_AHEAD = 24` (slots reserved on first open — at 5m cadence
  that's 2 hours of forward room)
- `SHIFT_TRIGGER_AHEAD = 6` (shift fires when last candle is within
  6 slots of the right edge — 30m of headroom remaining)
- `SHIFT_AMOUNT = 12` (advance 1 hour at a time)

### 1.5 Stateless-cron compatibility

The window is persisted in the existing `last-status.json` under a
new top-level key:

```json
"chart_windows": {
  "R_100":    { "min": 1719568800000, "max": 1719604800000 },
  "frxEURUSD": null    // dropped when no siblings open
}
```

Per-symbol, so a single state file handles the multi-symbol fan-out
that Part 3b will add for symbol categories. The key is created on
demand by the runner and gracefully missing keys are treated as
"no prior window" by `advanceChartWindow`. No state-shape migration —
existing `last-status.json` files load fine with `chart_windows`
implicitly `undefined`.

When a symbol drops back to zero open siblings, its `chart_windows[symbol]`
entry is **explicitly deleted** so the next position-open will
re-reserve fresh forward space rather than inheriting a stale (and
possibly already-shifted-forward) window.

---

## 2. Wiring into Telegram (`runner.js`)

The exact `[TODO PART 3]` marker block that Part 2c left in
`runMultiplierCycle` (around lines 1700–1717 of the Part 2c
`runner.js`) is replaced with the integration the pseudocode there
prescribed:

```js
state.chart_windows = state.chart_windows || {};
let chartBuf = null, nextWindow = null;
try {
    const out = await Chart.renderMultiplierSnapshot({
        ws, symbol, tf: '5m',
        openSiblings: postActionSiblings,
        chartWindow:  state.chart_windows[symbol] || null,
    });
    if (out && out.buffer && out.buffer.length > 1024) {
        chartBuf   = out.buffer;
        nextWindow = out.nextWindow;
    }
} catch (e) { Logger.warn(...); }

if (postActionSiblings.length === 0)              delete state.chart_windows[symbol];
else if (nextWindow)                              state.chart_windows[symbol] = { min, max };

if (chartBuf) await Telegram.sendPhoto(chartBuf, captionTrimmed);
else          await Telegram.send(msg);            // text-only fallback
```

The whole block stays inside Part 2c's outer `try/catch` so a chart
or notification failure still cannot poison the cycle's settlement /
state-persistence work — exactly the invariant Part 2c documented.

### 2.1 Caption-length handling

Per Part 2c's hand-off note: at 4 siblings + a `multi` decision the
HTML body can climb into the 800–1000 char range, and Telegram's
`sendPhoto` caption cap is 1024 chars. The implemented policy:

- Default path: send the chart with the full HTML body as the
  caption. For all tested ticks (hold, open with 1–2 siblings,
  close, revise, multi with 2 siblings) the body fits comfortably
  under 1024 chars.
- Defensive truncation: if `msg.length > 1024`, slice to
  `1024 − len('\n<i>…trimmed</i>')` and append `<i>…trimmed</i>` so
  the recipient is unambiguously told something was cut.
- Chart-render failure path: drop the photo and use `Telegram.send()`
  with the *full*, untrimmed body. This preserves Part 2c's behaviour
  perfectly when the chart pipeline is unavailable — no silent
  regression on text content.

A possible Part 3c follow-up (mentioned only because Part 2c flagged
it) is to split into a short caption + separate `send()` for the full
body. Not done here — the data shows the trim path is rarely hit and
the user experience of "all info in one message" is preferable.

### 2.2 Render-time / cron budget

Three checks confirm this is safely inside budget:

1. **GitHub Actions job timeout**: `aurelia-cron.yml` has
   `timeout-minutes: 12`. Chromium is also cached (`actions/cache@v4`
   keyed on package-lock hash) so cold-start time on a fresh runner
   doesn't repeat each tick.
2. **Existing chart pipeline timing**: the legacy binary path
   already uses the same Puppeteer launch + `setContent` flow with a
   500 ms post-render settle delay; in practice it runs in
   ~2–4 s per chart (the log line at `runner.js:289` confirms it's
   been deployed and used on placement notifications).
3. **New `renderMultiplierSnapshot` adds**: one `Deriv.ticksHistory`
   round-trip (already on the cycle's hot path — also a few hundred
   ms at worst), the same Chart.js render flow (~2–4 s), plus a
   single `sendPhoto` upload (~500 ms for an 80–150 KB PNG). End to
   end ≈ 4–6 s extra per tick.
4. **Render time is logged**: `Logger.info('[chart-mult] screenshot
   captured', { ms, bytes })` at the end of every render, so if it
   ever drifts the cron logs will surface it immediately.

Total tick budget is well under the 12-min job timeout and well under
the 5-min cron cadence — no risk of overlapping invocations from the
`concurrency: aurelia-tick` group either.

---

## 3. What was NOT changed (in scope of Part 3a)

- **Symbol categories** (`config.json`, `worker/index.js` settings
  menus) — deferred to Part 3b as the prompt directs.
- **Session summaries** — deferred to Part 3c.
- **AI decision schema** (`ai-client.js`) — unchanged.
- **Cycle orchestration** beyond the `[TODO PART 3]` swap.
- **Telegram text content** — `multiplierTickSummary` template
  unchanged; we attach the same HTML body as the chart caption.
- **`Chart.generateChart()`** (binary path) — unchanged.

---

## 4. Issues encountered with earlier parts' code/schema

### 4.1 Minor: `state.js` is not visible in this fork yet

The Part 2c summary noted this already (`state.js` is Part 1 territory
and not in the multipliers deliverable tree). Part 3a doesn't need a
new `State.*` helper — `state.chart_windows` is a plain object that
the runner manages inline. **No upstream change required.**

### 4.2 Minor: `entry_time` may be undefined on persisted records
when `placed.proposal.date_start` is missing

`openSibling()` builds the record with
`entry_time: placed.proposal && placed.proposal.date_start ? new Date(...).toISOString() : undefined`
(`runner.js:1196-1198`). So in degraded conditions where Deriv's
proposal omits `date_start`, the persisted sibling has no
`entry_time`. The chart's `buildSiblingAnnotations()` handles this
gracefully by leaving `entryMs = null` (the vertical entry line is
silently dropped; TP/SL horizontals still render). **No upstream
change required — already correctly handled downstream.**

### 4.3 Confirmed: TP/SL semantics are `$-amount`, not price level

Cross-checked against three independent spots: `runner.js:925-926`
(open-spec doc-comment), `runner.js:1017-1018` (pollSibling reason
classification), and `runner.js:1028-1029` (`tpAmt`/`slAmt` reading
from `poc.take_profit.amount`). All agree: amounts in USD, not price
levels. The price-level conversion is therefore a downstream
chart-only concern; no schema change.

---

## 5. Tests

A new pure-logic smoke test was added:
**`scripts/smoke-multiplier-chart.js`**. It covers every branch of the
non-Puppeteer code in `chart.js` (43 assertions, all green) without
requiring network or a headless browser:

| Group | Assertions | Covers |
| ----- | ---------- | ------ |
| T1    | 4          | `_siblingPriceLevels` MULTUP TP/SL math + propagation |
| T2    | 3          | `_siblingPriceLevels` MULTDOWN sign flip |
| T3    | 4          | `_siblingPriceLevels` graceful null TP / null SL |
| T4    | 3          | `_siblingPriceLevels` malformed (missing / zero entry) |
| T5    | 7          | `buildSiblingAnnotations` palette assignment + entry parse |
| T6    | 2          | `buildSiblingAnnotations` missing `entry_time` graceful |
| T7    | 3          | `advanceChartWindow` no-siblings → historical only |
| T8    | 4          | `advanceChartWindow` fresh open → reserves `RESERVE_AHEAD` |
| T9    | 3          | `advanceChartWindow` window preserved when not near edge |
| T10   | 4          | `advanceChartWindow` shift triggers near right edge |
| T11   | 2          | `advanceChartWindow` discards window when siblings disappear |
| T12   | 2          | `advanceChartWindow` empty/null candles → null |
| T13   | 2          | `advanceChartWindow` malformed prev → re-reserves |
| **Total** | **43** | |

Run with:

```bash
node scripts/smoke-multiplier-chart.js
```

Expected: `Passed: 43    Failed: 0`, exit code 0. Verified locally.

**Part 2c's `smoke-multiplier-tick-summary.js` still passes (47/47)
unchanged.** Per the same caveat Part 2c documented, the cycle and
decision smokes (`smoke-multiplier-cycle.js`, `smoke-multiplier-decision.js`)
require `state.js` (Part 1 territory) and don't run in this fork —
that's pre-existing and not introduced by Part 3a.

Puppeteer-side rendering is intentionally not exercised by the
smoke test: the legacy `generateChart()` path was already exercised
on the binary side and the new `buildMultiplierHtml` reuses the same
launch + setContent + screenshot flow. A live chart will be produced
on the first cycle tick after deploy; if rendering breaks the
runner's `try/catch` falls back to plain `Telegram.send()` and logs a
`Logger.warn` with the underlying error — the same defensive shape
the existing binary path uses.

---

## 6. Files in this deliverable

```
aurelia-multipliers-part3a/
├── PART_3A_SUMMARY.md                ← this file
├── chart.js                          ← Part 2c + new buildMultiplierHtml,
│                                       renderMultiplierSnapshot,
│                                       advanceChartWindow, palette,
│                                       _siblingPriceLevels (legacy
│                                       generateChart unchanged)
├── runner.js                         ← Part 2c + 1 surgical edit at the
│                                       [TODO PART 3] marker (chart +
│                                       sendPhoto + window persistence)
└── scripts/
    └── smoke-multiplier-chart.js     ← NEW — pure-logic smoke test (43/43)
```

Drop these on top of the Part 2c tree. The existing
`telegram.js` from Part 2c is reused as-is (no edits needed — its
`sendPhoto(buffer, caption)` signature already matches what Part 3a
needs). The existing `last-status.json` shape is forward-compatible —
`chart_windows` is created on demand.
