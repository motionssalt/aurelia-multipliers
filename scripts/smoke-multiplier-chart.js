#!/usr/bin/env node
/* =====================================================================
   Smoke test for Part 3a — multiplier chart pure-logic helpers.
   ─────────────────────────────────────────────────────────────────────
   Tests the bits of chart.js that don't require Puppeteer / network:

     • _siblingPriceLevels  : $-amount TP/SL → price-level conversion
                              for both MULTUP and MULTDOWN.
     • buildSiblingAnnotations : per-sibling colour + entry/tp/sl payload.
     • advanceChartWindow   : window persistence + auto-scroll math
                              (fresh open, mid-position, no siblings,
                              near-edge shift trigger).

   Puppeteer-side rendering is excluded by design — it's exercised in
   live cron and adds 200MB of Chromium download to CI for marginal
   value over the pure logic checks here.

   Run with:   node scripts/smoke-multiplier-chart.js
   Exit 0 = all green, exit 1 = any assertion failed.
   ===================================================================== */

'use strict';

const path = require('path');
const Chart = require(path.join('..', 'chart.js'));

let pass = 0, fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass++; console.log(' OK   ' + name); }
    else      { fail++; console.error(' FAIL ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail) : '')); }
}
function near(a, b, tol) { return Math.abs(a - b) <= (tol == null ? 1e-6 : tol); }

// ---- candle helper ---------------------------------------------------
// 120 5-minute candles, last one at t0; epoch is in seconds.
function fakeCandles(count, lastEpochSec, granSec) {
    const out = [];
    for (let i = 0; i < count; i++) {
        const e = lastEpochSec - (count - 1 - i) * granSec;
        const base = 1000 + i * 0.1;
        out.push({ epoch: e, open: base, high: base + 0.5, low: base - 0.5, close: base + 0.1 });
    }
    return out;
}

// =====================================================================
// T1 — _siblingPriceLevels: MULTUP
// =====================================================================
{
    // stake=10, mult=100, entry=1000, tp=$5, sl=$5
    //   TP price = 1000 * (1 + 5/(10*100)) = 1000 * 1.005 = 1005
    //   SL price = 1000 * (1 - 5/(10*100)) = 1000 * 0.995 =  995
    const sib = { direction: 'up', entry_spot: 1000, stake: 10, multiplier: 100,
                  take_profit: 5, stop_loss: 5 };
    const lv = Chart._siblingPriceLevels(sib);
    ok('T1.1 MULTUP TP price',   near(lv.tpPrice, 1005));
    ok('T1.2 MULTUP SL price',   near(lv.slPrice,  995));
    ok('T1.3 direction propagated', lv.direction === 'up');
    ok('T1.4 entry propagated',     near(lv.entry, 1000));
}

// =====================================================================
// T2 — _siblingPriceLevels: MULTDOWN — TP/SL signs flip
// =====================================================================
{
    // stake=10, mult=100, entry=1000, tp=$5, sl=$5, direction='down'
    //   TP price (price falls = profit) = 1000 * (1 - 0.005) = 995
    //   SL price (price rises = loss)   = 1000 * (1 + 0.005) = 1005
    const sib = { direction: 'down', entry_spot: 1000, stake: 10, multiplier: 100,
                  take_profit: 5, stop_loss: 5 };
    const lv = Chart._siblingPriceLevels(sib);
    ok('T2.1 MULTDOWN TP price', near(lv.tpPrice,  995));
    ok('T2.2 MULTDOWN SL price', near(lv.slPrice, 1005));
    ok('T2.3 direction down',    lv.direction === 'down');
}

// =====================================================================
// T3 — _siblingPriceLevels: null TP and/or SL are tolerated
// =====================================================================
{
    const sib = { direction: 'up', entry_spot: 1000, stake: 10, multiplier: 100,
                  take_profit: null, stop_loss: 5 };
    const lv = Chart._siblingPriceLevels(sib);
    ok('T3.1 null TP → tpPrice null', lv.tpPrice === null);
    ok('T3.2 SL still computed',      near(lv.slPrice, 995));

    const sib2 = { direction: 'down', entry_spot: 1000, stake: 10, multiplier: 100,
                   take_profit: 5, stop_loss: null };
    const lv2 = Chart._siblingPriceLevels(sib2);
    ok('T3.3 null SL → slPrice null', lv2.slPrice === null);
    ok('T3.4 TP still computed',      near(lv2.tpPrice, 995));
}

// =====================================================================
// T4 — _siblingPriceLevels: malformed sibling drops gracefully
// =====================================================================
{
    const lv = Chart._siblingPriceLevels({ direction: 'up' /* everything else missing */ });
    ok('T4.1 missing entry → tpPrice null', lv.tpPrice === null);
    ok('T4.2 missing entry → slPrice null', lv.slPrice === null);

    const lvNeg = Chart._siblingPriceLevels({
        direction: 'up', entry_spot: 0, stake: 10, multiplier: 100,
        take_profit: 5, stop_loss: 5,
    });
    ok('T4.3 zero entry → tpPrice null', lvNeg.tpPrice === null);
}

// =====================================================================
// T5 — buildSiblingAnnotations: palette + entry ms parse
// =====================================================================
{
    const sibs = [
        { contract_id: 1001, direction: 'up',   entry_spot: 1000, stake: 10, multiplier: 100,
          take_profit: 5, stop_loss: 5, entry_time: '2025-06-28T12:00:00Z' },
        { contract_id: 1002, direction: 'down', entry_spot: 1000, stake: 10, multiplier: 100,
          take_profit: 5, stop_loss: 5, entry_time: '2025-06-28T12:05:00Z' },
    ];
    const anns = Chart.buildSiblingAnnotations(sibs);
    ok('T5.1 two annotations',        anns.length === 2);
    ok('T5.2 distinct colours',       anns[0].colour !== anns[1].colour);
    ok('T5.3 first colour from palette', Chart.SIBLING_PALETTE.indexOf(anns[0].colour) === 0);
    ok('T5.4 entry ms parsed (#1)',   anns[0].entryMs === Date.parse('2025-06-28T12:00:00Z'));
    ok('T5.5 entry ms parsed (#2)',   anns[1].entryMs === Date.parse('2025-06-28T12:05:00Z'));
    ok('T5.6 contract_id propagated', anns[0].contract_id === 1001 && anns[1].contract_id === 1002);
    ok('T5.7 direction propagated',   anns[1].direction === 'down');
}

// =====================================================================
// T6 — buildSiblingAnnotations: missing entry_time gives null entryMs
// =====================================================================
{
    const anns = Chart.buildSiblingAnnotations([
        { contract_id: 1, direction: 'up', entry_spot: 1000, stake: 10, multiplier: 100,
          take_profit: 5, stop_loss: 5 /* no entry_time */ },
    ]);
    ok('T6.1 missing entry_time → entryMs null', anns[0].entryMs === null);
    ok('T6.2 TP/SL prices still computed',
       near(anns[0].tpPrice, 1005) && near(anns[0].slPrice, 995));
}

// =====================================================================
// T7 — advanceChartWindow: no siblings → historical-only view
// =====================================================================
{
    const gran = 300;
    const lastSec = Math.floor(Date.parse('2025-06-28T12:00:00Z') / 1000);
    const candles = fakeCandles(120, lastSec, gran);
    const win = Chart.advanceChartWindow(candles, [], null, gran);
    ok('T7.1 no siblings → max = last candle ms', win.max === lastSec * 1000);
    ok('T7.2 no siblings → min = first candle ms',
       win.min === candles[0].epoch * 1000);
    ok('T7.3 justOpened false', win.justOpened === false);
}

// =====================================================================
// T8 — advanceChartWindow: siblings open + no prior window
//                          → reserve RESERVE_AHEAD slots to the right
// =====================================================================
{
    const gran = 300;
    const lastSec = Math.floor(Date.parse('2025-06-28T12:00:00Z') / 1000);
    const candles = fakeCandles(120, lastSec, gran);
    const sibs = [{ contract_id: 1, direction: 'up', entry_spot: 1000,
                    stake: 10, multiplier: 100, take_profit: 5, stop_loss: 5 }];
    const win = Chart.advanceChartWindow(candles, sibs, null, gran);
    const lastMs = lastSec * 1000;
    const intervalMs = gran * 1000;
    const expectedMax = lastMs + Chart.RESERVE_AHEAD * intervalMs;
    ok('T8.1 reserves RESERVE_AHEAD ahead', win.max === expectedMax);
    ok('T8.2 total span preserved',
       (win.max - win.min) === (candles.length - 1) * intervalMs);
    ok('T8.3 justOpened true', win.justOpened === true);
    ok('T8.4 max strictly after last candle', win.max > lastMs);
}

// =====================================================================
// T9 — advanceChartWindow: existing window, candle nowhere near edge
//                          → return prevWindow unchanged
// =====================================================================
{
    const gran = 300;
    const intervalMs = gran * 1000;
    const lastSec = Math.floor(Date.parse('2025-06-28T12:00:00Z') / 1000);
    const candles = fakeCandles(120, lastSec, gran);
    const lastMs = lastSec * 1000;
    // Plenty of headroom: max is 20 slots past last candle.
    const prevWindow = { min: lastMs - 100 * intervalMs, max: lastMs + 20 * intervalMs };
    const sibs = [{ contract_id: 1, direction: 'up', entry_spot: 1000,
                    stake: 10, multiplier: 100, take_profit: 5, stop_loss: 5 }];
    const win = Chart.advanceChartWindow(candles, sibs, prevWindow, gran);
    ok('T9.1 window preserved (min)', win.min === prevWindow.min);
    ok('T9.2 window preserved (max)', win.max === prevWindow.max);
    ok('T9.3 justOpened false',       win.justOpened === false);
}

// =====================================================================
// T10 — advanceChartWindow: candle near right edge → shift forward
// =====================================================================
{
    const gran = 300;
    const intervalMs = gran * 1000;
    const lastSec = Math.floor(Date.parse('2025-06-28T12:00:00Z') / 1000);
    const candles = fakeCandles(120, lastSec, gran);
    const lastMs = lastSec * 1000;
    // Trigger threshold = max - SHIFT_TRIGGER_AHEAD*interval.
    // Place max only 3 slots past last candle (< trigger of 6).
    const prevWindow = { min: lastMs - 100 * intervalMs, max: lastMs + 3 * intervalMs };
    const sibs = [{ contract_id: 1, direction: 'up', entry_spot: 1000,
                    stake: 10, multiplier: 100, take_profit: 5, stop_loss: 5 }];
    const win = Chart.advanceChartWindow(candles, sibs, prevWindow, gran);
    const shiftMs = Chart.SHIFT_AMOUNT * intervalMs;
    ok('T10.1 window shifted forward (min)', win.min === prevWindow.min + shiftMs);
    ok('T10.2 window shifted forward (max)', win.max === prevWindow.max + shiftMs);
    ok('T10.3 justOpened true on shift',     win.justOpened === true);
    ok('T10.4 last candle now well inside',  win.max - lastMs >= (Chart.SHIFT_AMOUNT - 6) * intervalMs);
}

// =====================================================================
// T11 — advanceChartWindow: siblings disappeared → fall back to
//                            historical view (prior window discarded)
// =====================================================================
{
    const gran = 300;
    const lastSec = Math.floor(Date.parse('2025-06-28T12:00:00Z') / 1000);
    const candles = fakeCandles(120, lastSec, gran);
    const lastMs = lastSec * 1000;
    const prevWindow = { min: lastMs - 100 * 300 * 1000, max: lastMs + 50 * 300 * 1000 };
    const win = Chart.advanceChartWindow(candles, [], prevWindow, gran);
    ok('T11.1 no siblings → ignore prevWindow, use historical max',
       win.max === lastMs);
    ok('T11.2 no siblings → ignore prevWindow, use historical min',
       win.min === candles[0].epoch * 1000);
}

// =====================================================================
// T12 — advanceChartWindow: empty candles is graceful
// =====================================================================
{
    ok('T12.1 empty candles → null', Chart.advanceChartWindow([], [], null, 300) === null);
    ok('T12.2 null candles  → null', Chart.advanceChartWindow(null, [], null, 300) === null);
}

// =====================================================================
// T13 — advanceChartWindow: malformed prevWindow is treated as fresh
// =====================================================================
{
    const gran = 300;
    const lastSec = Math.floor(Date.parse('2025-06-28T12:00:00Z') / 1000);
    const candles = fakeCandles(120, lastSec, gran);
    const sibs = [{ contract_id: 1, direction: 'up', entry_spot: 1000,
                    stake: 10, multiplier: 100, take_profit: 5, stop_loss: 5 }];
    // max <= min → not a valid window; should re-reserve.
    const win = Chart.advanceChartWindow(candles, sibs, { min: 100, max: 50 }, gran);
    ok('T13.1 malformed prev → re-reserved', win.justOpened === true);
    // NaN max → also treated as fresh.
    const win2 = Chart.advanceChartWindow(candles, sibs, { min: NaN, max: NaN }, gran);
    ok('T13.2 NaN prev → re-reserved', win2.justOpened === true);
}

// ----- summary --------------------------------------------------------
console.log('');
console.log(`Passed: ${pass}    Failed: ${fail}`);
process.exit(fail === 0 ? 0 : 1);
