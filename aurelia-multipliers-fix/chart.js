/* =====================================================================
   AURELIA — chart.js
   ─────────────────────────────────────────────────────────────────────
   Generates a candlestick chart screenshot using Puppeteer + Chart.js
   (CDN, no TradingView). Returns a PNG Buffer ready for Telegram.

   v2 indicator overlay (binary path, unchanged):
     • EMA 9  + EMA 21 over the candlestick price panel
     • RSI(14) sub-panel
     • MACD(12,26,9) sub-panel (macd line, signal line, histogram bars)

   v3 multiplier overlay (NEW — Part 3a):
     • Same EMA/RSI/MACD overlays
     • Per-sibling TP / SL horizontal lines (solid = TP, dashed = SL)
       drawn via chartjs-plugin-annotation, with each sibling getting
       its own colour from a palette. A small in-panel legend lists
       each sibling's contract id, direction and colour.
     • Vertical "entry" marker at the candle whose epoch is closest to
       the earliest sibling's entry_time (or per-sibling lines when
       multiple positions opened at different times).
     • Time-scale auto-scroll: the x-axis `min`/`max` are passed in by
       the caller (persisted in state across cron invocations) and on
       a freshly-opened position we reserve `RESERVE_AHEAD` candles of
       empty space to the right of the most recent real candle. As the
       window fills up we shift it forward so there is always room
       ahead of the most recent candle — ordinary live-chart behaviour.

   Series are computed in Node using the `technicalindicators` package.
   No new npm dependencies — chartjs-plugin-annotation is loaded via
   CDN <script> tag, matching the existing approach for chart.js,
   chartjs-adapter-date-fns and chartjs-chart-financial.

   Public surface:
     generateChart(ws, symbol, tf, opts?)        → Buffer (PNG)
                                                   [binary path — unchanged]
     renderMultiplierSnapshot({ws, symbol, tf,   → { buffer, nextWindow }
       openSiblings, chartWindow})                 [NEW — multiplier path]
     advanceChartWindow(...)                     → { min, max, justOpened }
                                                   [pure helper — exported
                                                    so smoke test can verify]

   tf values: '1m' | '5m' | '15m' | '30m' | '1h'
   ===================================================================== */

const puppeteer = require('puppeteer');
const { execSync } = require('child_process');
const ti        = require('technicalindicators');
const Deriv     = require('./deriv');
const Logger    = require('./logger');

function ensureChromium() {
    try {
        puppeteer.executablePath();
        return;
    } catch (e) {
        Logger.info('[chart] no cached Chromium found - installing now (first chart request)');
        execSync('npx puppeteer browsers install chrome', { stdio: 'inherit' });
    }
}

/* Map human tf string → Deriv granularity in seconds + candle count */
const TF_MAP = {
    '1m':  { gran: 60,   count: 120 },
    '5m':  { gran: 300,  count: 120 },
    '15m': { gran: 900,  count: 100 },
    '30m': { gran: 1800, count: 100 },
    '1h':  { gran: 3600, count: 80  },
};

/* Multiplier-snapshot rendering knobs.
   - RESERVE_AHEAD: empty candle slots reserved to the right of the
     entry candle on the very first chart render of a position. The
     cron cadence is 5m, so 24 reserved slots ≈ 2 hours of room before
     auto-scroll kicks in.
   - SHIFT_TRIGGER_AHEAD: when the most recent real candle is within
     this many slots of the right edge, advance the window.
   - SHIFT_AMOUNT: how many slots to advance per shift — keep some
     reserve restored without re-jumping the whole window.
*/
const RESERVE_AHEAD       = 24;
const SHIFT_TRIGGER_AHEAD = 6;
const SHIFT_AMOUNT        = 12;

/* Distinct palette for per-sibling TP/SL lines. Up to 4 siblings
   per the prompt; 5+ wraps round (acceptable degraded behaviour). */
const SIBLING_PALETTE = [
    '#26d07c', // green
    '#ff4d6b', // red
    '#6aa9ff', // blue
    '#f5a524', // amber
    '#c084fc', // violet
];

/* ─────────────────────────────────────────────────────────────────
   Indicator series — computed in Node, then serialised into the page.
   ───────────────────────────────────────────────────────────────── */
function _alignSeries(timestamps, values) {
    const pad = timestamps.length - values.length;
    const out = [];
    for (let i = 0; i < timestamps.length; i++) {
        const v = (i < pad) ? null : values[i - pad];
        out.push({ x: timestamps[i], y: (v == null || !Number.isFinite(v)) ? null : Number(v) });
    }
    return out;
}

function computeOverlays(candles) {
    const ts    = candles.map(c => c.epoch * 1000);
    const close = candles.map(c => c.close);

    const ema9  = ti.EMA.calculate({ values: close, period: 9 });
    const ema21 = ti.EMA.calculate({ values: close, period: 21 });

    const rsi14 = ti.RSI.calculate({ values: close, period: 14 });

    const macdArr = ti.MACD.calculate({
        values: close,
        fastPeriod: 12, slowPeriod: 26, signalPeriod: 9,
        SimpleMAOscillator: false, SimpleMASignal: false,
    });
    const macdLine    = macdArr.map(m => (m && Number.isFinite(m.MACD))      ? m.MACD      : null);
    const signalLine  = macdArr.map(m => (m && Number.isFinite(m.signal))    ? m.signal    : null);
    const histogram   = macdArr.map(m => (m && Number.isFinite(m.histogram)) ? m.histogram : null);

    return {
        ema9:      _alignSeries(ts, ema9),
        ema21:     _alignSeries(ts, ema21),
        rsi14:     _alignSeries(ts, rsi14),
        macdLine:  _alignSeries(ts, macdLine),
        signal:    _alignSeries(ts, signalLine),
        histogram: _alignSeries(ts, histogram),
    };
}

/* ─────────────────────────────────────────────────────────────────
   Multiplier-fork helpers — converting $-amount TP/SL into price
   levels and computing per-sibling annotation data.
   ───────────────────────────────────────────────────────────────── */

/*
   Multiplier P/L semantics (Deriv):
     direction='up'   (MULTUP)   : pnl = stake * mult * (P − entry) / entry
     direction='down' (MULTDOWN) : pnl = stake * mult * (entry − P) / entry

   Solving for the price P at which pnl = ±$amount:
     MULTUP   : TP price = entry * (1 + tp/(stake*mult))
                SL price = entry * (1 − sl/(stake*mult))
     MULTDOWN : TP price = entry * (1 − tp/(stake*mult))
                SL price = entry * (1 + sl/(stake*mult))

   If any required field is missing/non-finite, the line is dropped
   (the chart still renders without it).
*/
function _siblingPriceLevels(sib) {
    const entry = Number(sib.entry_spot);
    const stake = Number(sib.stake);
    const mult  = Number(sib.multiplier);
    const dir   = sib.direction === 'down' ? 'down' : 'up';
    if (!Number.isFinite(entry) || !Number.isFinite(stake) || !Number.isFinite(mult)
        || stake <= 0 || mult <= 0 || entry <= 0) {
        return { tpPrice: null, slPrice: null, direction: dir };
    }
    const tpAmt = (sib.take_profit != null) ? Number(sib.take_profit) : null;
    const slAmt = (sib.stop_loss   != null) ? Number(sib.stop_loss)   : null;

    const sign = (dir === 'up') ? 1 : -1;
    const tpPrice = (tpAmt != null && Number.isFinite(tpAmt))
        ? entry * (1 + sign * (tpAmt / (stake * mult)))
        : null;
    const slPrice = (slAmt != null && Number.isFinite(slAmt))
        ? entry * (1 - sign * (slAmt / (stake * mult)))
        : null;
    return { tpPrice, slPrice, direction: dir, entry };
}

function buildSiblingAnnotations(openSiblings) {
    const items = (openSiblings || []).map((sib, i) => {
        const colour  = SIBLING_PALETTE[i % SIBLING_PALETTE.length];
        const levels  = _siblingPriceLevels(sib);
        const entryMs = sib.entry_time ? new Date(sib.entry_time).getTime() : null;
        return {
            contract_id: sib.contract_id,
            direction:   levels.direction,
            colour,
            entryMs:     (Number.isFinite(entryMs) && entryMs > 0) ? entryMs : null,
            entry:       levels.entry,
            tpPrice:     levels.tpPrice,
            slPrice:     levels.slPrice,
        };
    });
    return items;
}

/* ─────────────────────────────────────────────────────────────────
   Auto-scroll window math — pure function, exported for tests.

   Inputs:
     candles      : array sorted ascending by epoch (sec)
     openSiblings : array (may be empty)
     prevWindow   : { min, max } in ms, or null/undefined if no prior
                    window persisted (fresh symbol / no open siblings
                    last tick)
     granSec      : candle granularity (e.g. 300 for 5m)

   Output:
     { min, max, justOpened }
       min, max   : milliseconds — to feed into Chart.js time scale
       justOpened : true if we just reserved fresh empty space on the
                    right (first tick of a position, or shifted window)

   Behaviour:
     - No siblings open AND no prevWindow:
         Pure historical view — span = (count-1) intervals back from
         last candle, no future reserve.
     - Siblings open AND no prevWindow (= just-opened tick):
         Reserve RESERVE_AHEAD candles to the right of the last real
         candle. justOpened=true. This is the prompt's "reserve empty
         space at position entry" requirement.
     - Siblings open AND prevWindow exists:
         Keep prevWindow unless the last real candle is within
         SHIFT_TRIGGER_AHEAD slots of prevWindow.max → then advance
         both min and max by SHIFT_AMOUNT * interval.
     - No siblings open AND prevWindow exists:
         Discard prevWindow and fall back to historical view, so the
         next time we open a position we re-reserve cleanly.
   ───────────────────────────────────────────────────────────────── */
function advanceChartWindow(candles, openSiblings, prevWindow, granSec) {
    if (!candles || !candles.length) return null;
    const intervalMs = granSec * 1000;
    const firstMs    = candles[0].epoch * 1000;
    const lastMs     = candles[candles.length - 1].epoch * 1000;
    const totalSpan  = (candles.length - 1) * intervalMs;
    const hasSiblings = !!(openSiblings && openSiblings.length);

    // Historical-only view: no siblings → no reserved future window.
    if (!hasSiblings) {
        return { min: firstMs, max: lastMs, justOpened: false };
    }

    // Fresh window — "just opened" path. Reserve RESERVE_AHEAD slots
    // to the right of the last real candle.
    if (!prevWindow || !Number.isFinite(prevWindow.min) || !Number.isFinite(prevWindow.max)
        || prevWindow.max <= prevWindow.min) {
        const max = lastMs + RESERVE_AHEAD * intervalMs;
        const min = max - totalSpan;
        return { min, max, justOpened: true };
    }

    // Existing window — auto-scroll if last candle approaches edge.
    let { min, max } = prevWindow;
    const shiftThreshold = max - SHIFT_TRIGGER_AHEAD * intervalMs;
    if (lastMs >= shiftThreshold) {
        const shift = SHIFT_AMOUNT * intervalMs;
        min += shift;
        max += shift;
        return { min, max, justOpened: true };
    }
    return { min, max, justOpened: false };
}

/* ─────────────────────────────────────────────────────────────────
   buildHtml — existing binary-path HTML (UNCHANGED — used by the
   legacy generateChart() path that the binary trade-placement
   notification still calls).
   ───────────────────────────────────────────────────────────────── */
function buildHtml(candles, symbol, tf, overlays) {
    /* Convert candles → chartjs-chart-financial OHLC objects */
    const data = candles.map(c => ({
        x: c.epoch * 1000,
        o: c.open,
        h: c.high,
        l: c.low,
        c: c.close,
    }));

    /* Price range for Y axis padding */
    const highs  = candles.map(c => c.high);
    const lows   = candles.map(c => c.low);
    const yMin   = (Math.min(...lows)  * 0.9995).toFixed(5);
    const yMax   = (Math.max(...highs) * 1.0005).toFixed(5);

    const lastPrice  = candles[candles.length - 1].close.toFixed(5);
    const firstPrice = candles[0].open;
    const change     = candles[candles.length - 1].close - firstPrice;
    const changePct  = ((change / firstPrice) * 100).toFixed(2);
    const changeStr  = `${change >= 0 ? '+' : ''}${change.toFixed(5)} (${changePct}%)`;
    const headerColor = change >= 0 ? '#26d07c' : '#ff4d6b';

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: #0d0d10;
    font-family: 'Segoe UI', system-ui, sans-serif;
    width: 900px;
    height: 760px;
    overflow: hidden;
  }
  #header {
    display: flex;
    align-items: baseline;
    gap: 14px;
    padding: 14px 24px 6px;
  }
  #symbol { font-size: 18px; font-weight: 700; color: #f0f0f5; letter-spacing: 0.5px; }
  #tf-badge {
    font-size: 11px; font-weight: 600; color: #888;
    background: #1a1a22; border-radius: 4px; padding: 2px 7px;
    letter-spacing: 1px; text-transform: uppercase;
  }
  #price  { font-size: 22px; font-weight: 700; color: #f0f0f5; margin-left: auto; }
  #change { font-size: 13px; font-weight: 600; color: ${headerColor}; }
  #watermark {
    position: absolute; bottom: 8px; right: 20px;
    font-size: 11px; color: #2a2a35; font-weight: 700;
    letter-spacing: 2px; text-transform: uppercase;
  }
  .panel { padding: 0 12px; }
  .panel.price { height: 420px; }
  .panel.rsi   { height: 130px; padding-top: 4px; }
  .panel.macd  { height: 150px; padding-top: 4px; padding-bottom: 10px; }
  .panel-label {
    font-size: 10px; color: #888; font-weight: 600;
    letter-spacing: 1px; text-transform: uppercase;
    padding-left: 14px;
  }
  canvas { display: block; }
</style>
</head>
<body>
<div id="header">
  <span id="symbol">${symbol}</span>
  <span id="tf-badge">${tf}</span>
  <span id="price">${lastPrice}</span>
  <span id="change">${changeStr}</span>
</div>

<div class="panel price">
  <canvas id="chartPrice"></canvas>
</div>
<div class="panel-label">RSI (14)</div>
<div class="panel rsi">
  <canvas id="chartRsi"></canvas>
</div>
<div class="panel-label">MACD (12, 26, 9)</div>
<div class="panel macd">
  <canvas id="chartMacd"></canvas>
</div>

<div id="watermark">AURELIA</div>

<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.2/dist/chart.umd.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/chartjs-adapter-date-fns@3.0.0/dist/chartjs-adapter-date-fns.bundle.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/chartjs-chart-financial@0.1.1/dist/chartjs-chart-financial.min.js"></script>
<script>
const data      = ${JSON.stringify(data)};
const ema9      = ${JSON.stringify(overlays.ema9)};
const ema21     = ${JSON.stringify(overlays.ema21)};
const rsi14     = ${JSON.stringify(overlays.rsi14)};
const macdLine  = ${JSON.stringify(overlays.macdLine)};
const signal    = ${JSON.stringify(overlays.signal)};
const histogram = ${JSON.stringify(overlays.histogram)};

function sizeCanvas(id) {
  const el = document.getElementById(id);
  const w  = el.parentElement.clientWidth;
  const h  = el.parentElement.clientHeight;
  el.width = w; el.height = h;
  return el.getContext('2d');
}

const axisGrid   = { color: '#1a1a22', drawBorder: false };
const axisTicks  = { color: '#555', maxTicksLimit: 8, font: { size: 10 } };
const xAxis = {
  type: 'timeseries',
  time: { unit: 'minute' },
  grid: axisGrid,
  ticks: { ...axisTicks, maxTicksLimit: 8 },
  border: { color: '#1a1a22' },
};

/* ── Price panel: candles + EMA9 + EMA21 ───────────────────────── */
new Chart(sizeCanvas('chartPrice'), {
  data: {
    datasets: [
      {
        type: 'candlestick',
        label: '${symbol}',
        data,
        color: { up: '#26d07c', down: '#ff4d6b', unchanged: '#888888' },
        borderColor: { up: '#26d07c', down: '#ff4d6b', unchanged: '#888888' },
      },
      {
        type: 'line', label: 'EMA 9', data: ema9,
        borderColor: '#f5a524', borderWidth: 1.4,
        pointRadius: 0, tension: 0.15, spanGaps: true,
      },
      {
        type: 'line', label: 'EMA 21', data: ema21,
        borderColor: '#6aa9ff', borderWidth: 1.4,
        pointRadius: 0, tension: 0.15, spanGaps: true,
      },
    ],
  },
  options: {
    responsive: false, animation: false,
    plugins: {
      legend: {
        display: true, position: 'top', align: 'start',
        labels: { color: '#888', font: { size: 10 }, boxWidth: 14, padding: 6,
          filter: (it) => it.text !== '${symbol}' },
      },
      tooltip: { enabled: false },
    },
    scales: {
      x: xAxis,
      y: {
        position: 'right',
        min: ${yMin}, max: ${yMax},
        grid: axisGrid,
        ticks: { ...axisTicks, maxTicksLimit: 6, callback: v => v.toFixed(5) },
        border: { color: '#1a1a22' },
      },
    },
  },
});

/* ── RSI panel ─────────────────────────────────────────────────── */
new Chart(sizeCanvas('chartRsi'), {
  type: 'line',
  data: {
    datasets: [{
      label: 'RSI 14', data: rsi14,
      borderColor: '#c084fc', borderWidth: 1.4,
      pointRadius: 0, tension: 0.15, spanGaps: true,
    }],
  },
  options: {
    responsive: false, animation: false,
    plugins: { legend: { display: false }, tooltip: { enabled: false } },
    scales: {
      x: { ...xAxis, ticks: { ...axisTicks, display: false }, grid: axisGrid },
      y: {
        position: 'right', min: 0, max: 100,
        grid: { color: (ctx) => {
          const v = ctx.tick && ctx.tick.value;
          if (v === 30 || v === 70) return '#3a3a4a';
          return '#1a1a22';
        }, drawBorder: false },
        ticks: { ...axisTicks, stepSize: 30, maxTicksLimit: 4 },
        border: { color: '#1a1a22' },
      },
    },
  },
});

/* ── MACD panel (line + signal + histogram bars) ──────────────── */
new Chart(sizeCanvas('chartMacd'), {
  data: {
    datasets: [
      {
        type: 'bar', label: 'Histogram', data: histogram,
        backgroundColor: (ctx) => {
          const v = ctx.raw && ctx.raw.y;
          if (v == null) return 'rgba(0,0,0,0)';
          return v >= 0 ? 'rgba(38,208,124,0.55)' : 'rgba(255,77,107,0.55)';
        },
        borderWidth: 0, barPercentage: 0.9, categoryPercentage: 1.0,
      },
      {
        type: 'line', label: 'MACD', data: macdLine,
        borderColor: '#f0f0f5', borderWidth: 1.3,
        pointRadius: 0, tension: 0.15, spanGaps: true,
      },
      {
        type: 'line', label: 'Signal', data: signal,
        borderColor: '#f5a524', borderWidth: 1.3,
        pointRadius: 0, tension: 0.15, spanGaps: true,
      },
    ],
  },
  options: {
    responsive: false, animation: false,
    plugins: { legend: { display: false }, tooltip: { enabled: false } },
    scales: {
      x: { ...xAxis, type: 'timeseries', offset: false },
      y: {
        position: 'right',
        grid: { color: (ctx) => ctx.tick && ctx.tick.value === 0 ? '#3a3a4a' : '#1a1a22', drawBorder: false },
        ticks: { ...axisTicks, maxTicksLimit: 4 },
        border: { color: '#1a1a22' },
      },
    },
  },
});
</script>
</body>
</html>`;
}

/* ─────────────────────────────────────────────────────────────────
   buildMultiplierHtml — Part 3a's new HTML pipeline.

   Same EMA/RSI/MACD layout as the binary chart, plus:
     • Explicit x-axis min/max (from advanceChartWindow output) so
       there is always reserved space ahead of the last real candle.
     • chartjs-plugin-annotation lines:
        - vertical "entry" line per sibling (or one combined if all
          siblings share an entry_time)
        - horizontal TP line (solid)
        - horizontal SL line (dashed)
     • Sibling legend strip below the price panel listing
       contract_id ↔ colour ↔ direction.
     • Y-axis padded around price extremes AND around TP/SL levels
       (so the lines never fall outside the rendered range).
   ───────────────────────────────────────────────────────────────── */
function buildMultiplierHtml(candles, symbol, tf, overlays, openSiblings, window) {
    const data = candles.map(c => ({
        x: c.epoch * 1000,
        o: c.open,
        h: c.high,
        l: c.low,
        c: c.close,
    }));

    const highs = candles.map(c => c.high);
    const lows  = candles.map(c => c.low);
    const annotItems = buildSiblingAnnotations(openSiblings);

    // Build numeric extremes that include TP/SL price levels so the
    // y-axis range never excludes them.
    const extras = [];
    for (const a of annotItems) {
        if (a.tpPrice != null && Number.isFinite(a.tpPrice)) extras.push(a.tpPrice);
        if (a.slPrice != null && Number.isFinite(a.slPrice)) extras.push(a.slPrice);
        if (a.entry   != null && Number.isFinite(a.entry))   extras.push(a.entry);
    }
    const allHighs = highs.concat(extras);
    const allLows  = lows.concat(extras);
    const yMin = (Math.min(...allLows)  * 0.9995).toFixed(5);
    const yMax = (Math.max(...allHighs) * 1.0005).toFixed(5);

    const lastPrice  = candles[candles.length - 1].close.toFixed(5);
    const firstPrice = candles[0].open;
    const change     = candles[candles.length - 1].close - firstPrice;
    const changePct  = ((change / firstPrice) * 100).toFixed(2);
    const changeStr  = `${change >= 0 ? '+' : ''}${change.toFixed(5)} (${changePct}%)`;
    const headerColor = change >= 0 ? '#26d07c' : '#ff4d6b';

    // Build the annotation map that chartjs-plugin-annotation expects.
    // Keyed by string so labels don't collide.
    const annotations = {};
    annotItems.forEach((a, idx) => {
        // Per-sibling vertical entry line.
        if (a.entryMs != null) {
            annotations[`entry_${idx}`] = {
                type: 'line',
                xMin: a.entryMs,
                xMax: a.entryMs,
                borderColor: a.colour,
                borderWidth: 1.4,
                borderDash: [4, 3],
                label: {
                    display: true,
                    content: `#${a.contract_id}`,
                    position: 'start',
                    color: '#0d0d10',
                    backgroundColor: a.colour,
                    font: { size: 9, weight: '700' },
                    padding: { top: 2, bottom: 2, left: 4, right: 4 },
                    yAdjust: 6 + idx * 14, // stack labels vertically
                },
            };
        }
        // Horizontal TP line (solid).
        if (a.tpPrice != null) {
            annotations[`tp_${idx}`] = {
                type: 'line',
                yMin: a.tpPrice,
                yMax: a.tpPrice,
                borderColor: a.colour,
                borderWidth: 1.6,
                borderDash: [],
                label: {
                    display: true,
                    content: `TP ${a.tpPrice.toFixed(5)}`,
                    position: 'end',
                    color: '#0d0d10',
                    backgroundColor: a.colour,
                    font: { size: 9, weight: '700' },
                    padding: { top: 2, bottom: 2, left: 4, right: 4 },
                    xAdjust: -4,
                },
            };
        }
        // Horizontal SL line (dashed).
        if (a.slPrice != null) {
            annotations[`sl_${idx}`] = {
                type: 'line',
                yMin: a.slPrice,
                yMax: a.slPrice,
                borderColor: a.colour,
                borderWidth: 1.4,
                borderDash: [6, 4],
                label: {
                    display: true,
                    content: `SL ${a.slPrice.toFixed(5)}`,
                    position: 'end',
                    color: a.colour,
                    backgroundColor: 'rgba(13,13,16,0.85)',
                    font: { size: 9, weight: '700' },
                    padding: { top: 2, bottom: 2, left: 4, right: 4 },
                    xAdjust: -4,
                },
            };
        }
    });

    // Legend strip rendered below the price panel — pure HTML, no canvas.
    const legendHtml = annotItems.map(a => {
        const dirLabel = a.direction === 'up' ? 'MULTUP' : 'MULTDOWN';
        const dirArrow = a.direction === 'up' ? '▲' : '▼';
        return `<span class="leg-item">
            <span class="leg-swatch" style="background:${a.colour}"></span>
            <span class="leg-id">#${a.contract_id}</span>
            <span class="leg-dir">${dirArrow} ${dirLabel}</span>
        </span>`;
    }).join('');

    const windowMinJs = JSON.stringify(window && Number.isFinite(window.min) ? window.min : null);
    const windowMaxJs = JSON.stringify(window && Number.isFinite(window.max) ? window.max : null);

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: #0d0d10;
    font-family: 'Segoe UI', system-ui, sans-serif;
    width: 900px;
    height: 800px;
    overflow: hidden;
  }
  #header {
    display: flex; align-items: baseline; gap: 14px;
    padding: 14px 24px 6px;
  }
  #symbol { font-size: 18px; font-weight: 700; color: #f0f0f5; letter-spacing: 0.5px; }
  #tf-badge {
    font-size: 11px; font-weight: 600; color: #888;
    background: #1a1a22; border-radius: 4px; padding: 2px 7px;
    letter-spacing: 1px; text-transform: uppercase;
  }
  #price  { font-size: 22px; font-weight: 700; color: #f0f0f5; margin-left: auto; }
  #change { font-size: 13px; font-weight: 600; color: ${headerColor}; }
  #watermark {
    position: absolute; bottom: 8px; right: 20px;
    font-size: 11px; color: #2a2a35; font-weight: 700;
    letter-spacing: 2px; text-transform: uppercase;
  }
  #sib-legend {
    display: flex; flex-wrap: wrap; gap: 10px 18px;
    padding: 4px 24px 4px;
    font-size: 10px; color: #ccc;
  }
  .leg-item { display: inline-flex; align-items: center; gap: 5px; }
  .leg-swatch {
    display: inline-block; width: 12px; height: 12px;
    border-radius: 2px;
  }
  .leg-id { font-weight: 700; color: #f0f0f5; font-family: ui-monospace, Menlo, monospace; }
  .leg-dir { color: #888; letter-spacing: 0.5px; }
  .panel { padding: 0 12px; }
  .panel.price { height: 420px; }
  .panel.rsi   { height: 120px; padding-top: 4px; }
  .panel.macd  { height: 140px; padding-top: 4px; padding-bottom: 10px; }
  .panel-label {
    font-size: 10px; color: #888; font-weight: 600;
    letter-spacing: 1px; text-transform: uppercase;
    padding-left: 14px;
  }
  canvas { display: block; }
</style>
</head>
<body>
<div id="header">
  <span id="symbol">${symbol}</span>
  <span id="tf-badge">${tf}</span>
  <span id="price">${lastPrice}</span>
  <span id="change">${changeStr}</span>
</div>

<div id="sib-legend">${legendHtml || '<span style="color:#555">no open siblings</span>'}</div>

<div class="panel price">
  <canvas id="chartPrice"></canvas>
</div>
<div class="panel-label">RSI (14)</div>
<div class="panel rsi">
  <canvas id="chartRsi"></canvas>
</div>
<div class="panel-label">MACD (12, 26, 9)</div>
<div class="panel macd">
  <canvas id="chartMacd"></canvas>
</div>

<div id="watermark">AURELIA</div>

<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.2/dist/chart.umd.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/chartjs-adapter-date-fns@3.0.0/dist/chartjs-adapter-date-fns.bundle.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/chartjs-chart-financial@0.1.1/dist/chartjs-chart-financial.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/chartjs-plugin-annotation@3.0.1/dist/chartjs-plugin-annotation.min.js"></script>
<script>
const data      = ${JSON.stringify(data)};
const ema9      = ${JSON.stringify(overlays.ema9)};
const ema21     = ${JSON.stringify(overlays.ema21)};
const rsi14     = ${JSON.stringify(overlays.rsi14)};
const macdLine  = ${JSON.stringify(overlays.macdLine)};
const signal    = ${JSON.stringify(overlays.signal)};
const histogram = ${JSON.stringify(overlays.histogram)};
const annotations = ${JSON.stringify(annotations)};
const xMin = ${windowMinJs};
const xMax = ${windowMaxJs};

function sizeCanvas(id) {
  const el = document.getElementById(id);
  const w  = el.parentElement.clientWidth;
  const h  = el.parentElement.clientHeight;
  el.width = w; el.height = h;
  return el.getContext('2d');
}

const axisGrid   = { color: '#1a1a22', drawBorder: false };
const axisTicks  = { color: '#555', maxTicksLimit: 8, font: { size: 10 } };

// xAxis WITH explicit min/max — Chart.js will reserve the trailing
// empty space we computed in Node, rather than auto-fitting to data.
const xAxis = {
  type: 'timeseries',
  time: { unit: 'minute' },
  grid: axisGrid,
  ticks: { ...axisTicks, maxTicksLimit: 8 },
  border: { color: '#1a1a22' },
  min: xMin == null ? undefined : xMin,
  max: xMax == null ? undefined : xMax,
};
// Sub-panels share the time window but hide their tick labels.
const xAxisSub = { ...xAxis, ticks: { ...axisTicks, display: false } };

/* ── Price panel: candles + EMA9 + EMA21 + annotations ─────────── */
new Chart(sizeCanvas('chartPrice'), {
  data: {
    datasets: [
      {
        type: 'candlestick',
        label: '${symbol}',
        data,
        color: { up: '#26d07c', down: '#ff4d6b', unchanged: '#888888' },
        borderColor: { up: '#26d07c', down: '#ff4d6b', unchanged: '#888888' },
      },
      {
        type: 'line', label: 'EMA 9', data: ema9,
        borderColor: '#f5a524', borderWidth: 1.4,
        pointRadius: 0, tension: 0.15, spanGaps: true,
      },
      {
        type: 'line', label: 'EMA 21', data: ema21,
        borderColor: '#6aa9ff', borderWidth: 1.4,
        pointRadius: 0, tension: 0.15, spanGaps: true,
      },
    ],
  },
  options: {
    responsive: false, animation: false,
    plugins: {
      legend: {
        display: true, position: 'top', align: 'start',
        labels: { color: '#888', font: { size: 10 }, boxWidth: 14, padding: 6,
          filter: (it) => it.text !== '${symbol}' },
      },
      tooltip: { enabled: false },
      annotation: { annotations: annotations },
    },
    scales: {
      x: xAxis,
      y: {
        position: 'right',
        min: ${yMin}, max: ${yMax},
        grid: axisGrid,
        ticks: { ...axisTicks, maxTicksLimit: 6, callback: v => v.toFixed(5) },
        border: { color: '#1a1a22' },
      },
    },
  },
});

/* ── RSI panel ─────────────────────────────────────────────────── */
new Chart(sizeCanvas('chartRsi'), {
  type: 'line',
  data: {
    datasets: [{
      label: 'RSI 14', data: rsi14,
      borderColor: '#c084fc', borderWidth: 1.4,
      pointRadius: 0, tension: 0.15, spanGaps: true,
    }],
  },
  options: {
    responsive: false, animation: false,
    plugins: { legend: { display: false }, tooltip: { enabled: false } },
    scales: {
      x: xAxisSub,
      y: {
        position: 'right', min: 0, max: 100,
        grid: { color: (ctx) => {
          const v = ctx.tick && ctx.tick.value;
          if (v === 30 || v === 70) return '#3a3a4a';
          return '#1a1a22';
        }, drawBorder: false },
        ticks: { ...axisTicks, stepSize: 30, maxTicksLimit: 4 },
        border: { color: '#1a1a22' },
      },
    },
  },
});

/* ── MACD panel ───────────────────────────────────────────────── */
new Chart(sizeCanvas('chartMacd'), {
  data: {
    datasets: [
      {
        type: 'bar', label: 'Histogram', data: histogram,
        backgroundColor: (ctx) => {
          const v = ctx.raw && ctx.raw.y;
          if (v == null) return 'rgba(0,0,0,0)';
          return v >= 0 ? 'rgba(38,208,124,0.55)' : 'rgba(255,77,107,0.55)';
        },
        borderWidth: 0, barPercentage: 0.9, categoryPercentage: 1.0,
      },
      {
        type: 'line', label: 'MACD', data: macdLine,
        borderColor: '#f0f0f5', borderWidth: 1.3,
        pointRadius: 0, tension: 0.15, spanGaps: true,
      },
      {
        type: 'line', label: 'Signal', data: signal,
        borderColor: '#f5a524', borderWidth: 1.3,
        pointRadius: 0, tension: 0.15, spanGaps: true,
      },
    ],
  },
  options: {
    responsive: false, animation: false,
    plugins: { legend: { display: false }, tooltip: { enabled: false } },
    scales: {
      x: { ...xAxisSub, offset: false },
      y: {
        position: 'right',
        grid: { color: (ctx) => ctx.tick && ctx.tick.value === 0 ? '#3a3a4a' : '#1a1a22', drawBorder: false },
        ticks: { ...axisTicks, maxTicksLimit: 4 },
        border: { color: '#1a1a22' },
      },
    },
  },
});
</script>
</body>
</html>`;
}

/* ─────────────────────────────────────────────────────────────────
   Internal: fetch candles with one auto-reconnect retry if the WS
   went stale while the caller was doing slow work (e.g. waiting on a
   reasoning AI provider, or right after a `buy` reply when Deriv has
   closed the OTP session). The chart fetch is purely a READ — there
   is no side-effect risk in retrying on a fresh socket. Returns the
   (possibly new) ws plus the candles, so the caller can rebind ws and
   keep using it for the screenshot lifecycle's remaining calls.

   `connOpts` is OPTIONAL. When absent we behave exactly as before:
   one shot, throw on failure. This keeps every existing call site
   (including smoke tests and the binary path) byte-equivalent.
   ───────────────────────────────────────────────────────────────── */
async function _fetchCandlesResilient(ws, symbol, gran, count, connOpts, label) {
    try {
        const candles = await Deriv.ticksHistory(ws, symbol, gran, count);
        return { ws, candles };
    } catch (e) {
        // Only auto-heal when caller actually supplied connection
        // credentials. The error surface from Deriv.request() on a
        // closed socket is the literal string "WebSocket closed" (see
        // _attachHandlers) plus "WS not open (state=...)" from the
        // synchronous pre-send guard. Match those + the generic close
        // codes so genuine schema / data errors are NOT retried.
        const msg = String(e && e.message || e);
        const isClosed = /WebSocket closed|WS not open|state=(?:2|3)|ECONNRESET|EPIPE|opcode|1006|1001/i.test(msg);
        if (!isClosed || !connOpts) throw e;
        Logger.warn(`[chart${label ? '-' + label : ''}] candle fetch failed on closed WS — reconnecting once`, {
            symbol, error: msg.slice(0, 160),
        });
        const fresh = await Deriv.ensureOpen(ws, connOpts, {
            context:   `chart candle fetch (${label || 'binary'})`,
            timeoutMs: 8000,
        });
        const candles = await Deriv.ticksHistory(fresh, symbol, gran, count);
        return { ws: fresh, candles };
    }
}

/* ─────────────────────────────────────────────────────────────────
   Main exports
   ───────────────────────────────────────────────────────────────── */
async function generateChart(ws, symbol, tf = '1m', opts) {
    const tfCfg    = TF_MAP[tf] || TF_MAP['1m'];
    const connOpts = (opts && opts.connOpts) || null;
    Logger.info(`[chart] fetching ${tfCfg.count} candles for ${symbol} @ ${tf}`);

    const fetched = await _fetchCandlesResilient(ws, symbol, tfCfg.gran, tfCfg.count, connOpts, 'binary');
    ws = fetched.ws;
    const candles = fetched.candles;
    if (!candles || candles.length < 5) {
        throw new Error(`Not enough candle data for ${symbol} (got ${candles ? candles.length : 0})`);
    }

    const overlays = computeOverlays(candles);
    const html = buildHtml(candles, symbol, tf, overlays);

    ensureChromium();

    Logger.info('[chart] launching Puppeteer');
    const browser = await puppeteer.launch({
        headless: 'new',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
        ],
    });

    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 900, height: 760, deviceScaleFactor: 2 });
        await page.setContent(html, { waitUntil: 'networkidle0', timeout: 20000 });

        /* Give Chart.js a tick to finish rendering */
        await page.evaluate(() => new Promise(r => setTimeout(r, 500)));

        const buffer = await page.screenshot({ type: 'png', fullPage: false });
        Logger.info('[chart] screenshot captured');
        return buffer;
    } finally {
        await browser.close();
    }
}

/* ─────────────────────────────────────────────────────────────────
   renderMultiplierSnapshot — Part 3a entrypoint for the multiplier
   cycle's per-tick chart. Stateless across cron invocations: the
   caller hands us the persisted `chartWindow` (or null on fresh
   start) and we return the `nextWindow` that the caller should
   persist for the next tick.
   ───────────────────────────────────────────────────────────────── */
async function renderMultiplierSnapshot(opts) {
    let   ws            = opts && opts.ws;
    const symbol        = opts && opts.symbol;
    const tf            = (opts && opts.tf) || '5m';
    const openSiblings  = (opts && opts.openSiblings) || [];
    const prevWindow    = (opts && opts.chartWindow) || null;
    // `connOpts` is optional. When supplied we can auto-heal a stale
    // socket exactly once before failing — this is the common
    // post-trade case where the AI's slow reasoning closed the OTP
    // socket out from under the cycle (same root cause that `ensureOpen`
    // already addresses on the place-trade path; here we extend the
    // same recovery to the chart-fetch read path so the chart actually
    // makes it to Telegram instead of silently going missing).
    const connOpts     = (opts && opts.connOpts) || null;

    if (!ws || !symbol) {
        throw new Error('renderMultiplierSnapshot: ws and symbol are required');
    }

    const tfCfg = TF_MAP[tf] || TF_MAP['5m'];
    const t0 = Date.now();
    Logger.info(`[chart-mult] fetching ${tfCfg.count} candles for ${symbol} @ ${tf}`, {
        siblings: openSiblings.length,
        prevWindow: prevWindow ? { min: prevWindow.min, max: prevWindow.max } : null,
        recoverable: !!connOpts,
    });

    const fetched = await _fetchCandlesResilient(ws, symbol, tfCfg.gran, tfCfg.count, connOpts, 'mult');
    ws = fetched.ws;
    const candles = fetched.candles;
    if (!candles || candles.length < 5) {
        throw new Error(`Not enough candle data for ${symbol} (got ${candles ? candles.length : 0})`);
    }

    const nextWindow = advanceChartWindow(candles, openSiblings, prevWindow, tfCfg.gran);
    const overlays   = computeOverlays(candles);
    const html       = buildMultiplierHtml(candles, symbol, tf, overlays, openSiblings, nextWindow);

    ensureChromium();

    Logger.info('[chart-mult] launching Puppeteer', {
        window: nextWindow ? { min: nextWindow.min, max: nextWindow.max, justOpened: nextWindow.justOpened } : null,
    });
    const browser = await puppeteer.launch({
        headless: 'new',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
        ],
    });

    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 900, height: 800, deviceScaleFactor: 2 });
        await page.setContent(html, { waitUntil: 'networkidle0', timeout: 20000 });
        await page.evaluate(() => new Promise(r => setTimeout(r, 500)));

        const buffer = await page.screenshot({ type: 'png', fullPage: false });
        const dtMs = Date.now() - t0;
        Logger.info('[chart-mult] screenshot captured', { ms: dtMs, bytes: buffer.length });
        return {
            buffer,
            nextWindow,
            renderMs: dtMs,
            // Surface the (possibly fresh) ws so callers that thread
            // it through a longer chain — runMultiplierCycle, runManual
            // — can rebind their local `ws` after a recovery and avoid
            // re-hitting the same stale-socket failure on the next
            // request in the same cycle.
            ws,
        };
    } finally {
        await browser.close();
    }
}

module.exports = {
    generateChart,
    renderMultiplierSnapshot,
    advanceChartWindow,
    buildSiblingAnnotations,
    _siblingPriceLevels,
    TF_MAP,
    computeOverlays,
    RESERVE_AHEAD,
    SHIFT_TRIGGER_AHEAD,
    SHIFT_AMOUNT,
    SIBLING_PALETTE,
};
