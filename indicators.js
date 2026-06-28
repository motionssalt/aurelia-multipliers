/* =====================================================================
   AURELIA — indicators.js
   ─────────────────────────────────────────────────────────────────────
   Indicator catalogue (mirrors motionsalt-headless strategy.js INDICATORS)
   plus tiny adapters that compute "last value" suitable for an AI payload.

   The AI NEVER computes indicators — this module hands it precomputed
   numbers. Callers pass candles[] (chronological, oldest first) and get
   back a compact { rsi, ema_20, ema_50, macd, bb, atr, adx, stoch, ... }
   object that fits in a JSON payload.
   ===================================================================== */

'use strict';

const ti = require('technicalindicators');

function _last(arr) { return arr && arr.length ? arr[arr.length - 1] : null; }
function _num(v) { return (typeof v === 'number' && Number.isFinite(v)) ? Number(v.toFixed(6)) : null; }

function _closes(candles) { return candles.map(c => c.close); }
function _highs(candles)  { return candles.map(c => c.high);  }
function _lows(candles)   { return candles.map(c => c.low);   }

/* ─────────────────────────────────────────────────────────────────
   Per-timeframe indicator pack
   ───────────────────────────────────────────────────────────────── */
function computeIndicatorPack(candles) {
    if (!Array.isArray(candles) || candles.length < 30) {
        return { error: 'insufficient_candles', count: candles ? candles.length : 0 };
    }
    const close = _closes(candles);
    const high  = _highs(candles);
    const low   = _lows(candles);

    const rsi14   = _last(ti.RSI.calculate({ values: close, period: 14 }));
    const ema20   = _last(ti.EMA.calculate({ values: close, period: 20 }));
    const ema50   = _last(ti.EMA.calculate({ values: close, period: 50 }));
    const macdArr = ti.MACD.calculate({
        values: close, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9,
        SimpleMAOscillator: false, SimpleMASignal: false,
    });
    const macd = _last(macdArr) || {};
    const bbArr = ti.BollingerBands.calculate({ values: close, period: 20, stdDev: 2 });
    const bb = _last(bbArr) || {};
    const atrArr = ti.ATR.calculate({ high, low, close, period: 14 });
    const atr = _last(atrArr);
    const adxArr = ti.ADX.calculate({ high, low, close, period: 14 });
    const adx = _last(adxArr) || {};
    const stochArr = ti.Stochastic.calculate({
        high, low, close, period: 14, signalPeriod: 3,
    });
    const stoch = _last(stochArr) || {};
    const kcArr = ti.KeltnerChannels.calculate({
        high, low, close, period: 20, multiplier: 2,
        maType: ti.EMA, useTrueRange: true,
    });
    const kc = _last(kcArr) || {};
    const dcArr = ti.DonchianChannels
        ? ti.DonchianChannels.calculate({ high, low, period: 20 })
        : [];
    const dc = _last(dcArr) || {};
    const ichi = (() => {
        try {
            const arr = ti.IchimokuCloud.calculate({
                high, low, conversionPeriod: 9, basePeriod: 26,
                spanPeriod: 52, displacement: 26,
            });
            return _last(arr) || {};
        } catch (e) { return {}; }
    })();

    return {
        last_close: _num(_last(close)),
        rsi_14:    _num(rsi14),
        ema_20:    _num(ema20),
        ema_50:    _num(ema50),
        macd:      { macd: _num(macd.MACD), signal: _num(macd.signal), hist: _num(macd.histogram) },
        bb:        { lower: _num(bb.lower), middle: _num(bb.middle), upper: _num(bb.upper) },
        atr_14:    _num(atr),
        adx:       { adx: _num(adx.adx), plusDi: _num(adx.pdi), minusDi: _num(adx.mdi) },
        stoch:     { k: _num(stoch.k), d: _num(stoch.d) },
        keltner:   { lower: _num(kc.lower), middle: _num(kc.middle), upper: _num(kc.upper) },
        donchian:  { lower: _num(dc.lower), middle: _num(dc.middle), upper: _num(dc.upper) },
        ichimoku:  {
            conversion: _num(ichi.conversion),
            base:       _num(ichi.base),
            spanA:      _num(ichi.spanA),
            spanB:      _num(ichi.spanB),
        },
    };
}

/* ─────────────────────────────────────────────────────────────────
   Support / resistance (pivot-based, simple)
   ───────────────────────────────────────────────────────────────── */
function computeSupportResistance(candles, lookback = 50) {
    if (!Array.isArray(candles) || candles.length < 10) return { supports: [], resistances: [] };
    const slice = candles.slice(-lookback);
    const supports = [];
    const resistances = [];
    for (let i = 2; i < slice.length - 2; i++) {
        const c = slice[i];
        const l2 = slice[i-2].low, l1 = slice[i-1].low, r1 = slice[i+1].low, r2 = slice[i+2].low;
        const h2 = slice[i-2].high, h1 = slice[i-1].high, rh1 = slice[i+1].high, rh2 = slice[i+2].high;
        if (c.low  < l2 && c.low  < l1 && c.low  < r1 && c.low  < r2)  supports.push(_num(c.low));
        if (c.high > h2 && c.high > h1 && c.high > rh1 && c.high > rh2) resistances.push(_num(c.high));
    }
    return {
        supports:    supports.slice(-3),
        resistances: resistances.slice(-3),
    };
}

/* ─────────────────────────────────────────────────────────────────
   Candlestick patterns (boolean flags on the final 1–3 candles)
   ───────────────────────────────────────────────────────────────── */
function _bodySize(c) { return Math.abs(c.close - c.open); }
function _range(c)    { return c.high - c.low; }
function _upperWick(c){ return c.high - Math.max(c.open, c.close); }
function _lowerWick(c){ return Math.min(c.open, c.close) - c.low; }
function _isBull(c)   { return c.close > c.open; }
function _isBear(c)   { return c.close < c.open; }

function computeCandlePatterns(candles) {
    if (!Array.isArray(candles) || candles.length < 3) return {};
    const n = candles.length;
    const c  = candles[n - 1];
    const c1 = candles[n - 2];
    const c2 = candles[n - 3];

    const r  = _range(c) || 1e-9;
    const body = _bodySize(c);
    const uw = _upperWick(c);
    const lw = _lowerWick(c);

    const doji         = body / r < 0.1;
    const hammer       = lw > 2 * body && uw < body && _isBull(c);
    const shootingStar = uw > 2 * body && lw < body && _isBear(c);
    const bullEngulf   = _isBear(c1) && _isBull(c) && c.close > c1.open && c.open < c1.close;
    const bearEngulf   = _isBull(c1) && _isBear(c) && c.open > c1.close && c.close < c1.open;
    const morningStar  = _isBear(c2) && _bodySize(c1) / (_range(c1) || 1e-9) < 0.3 && _isBull(c) && c.close > (c2.open + c2.close) / 2;
    const eveningStar  = _isBull(c2) && _bodySize(c1) / (_range(c1) || 1e-9) < 0.3 && _isBear(c) && c.close < (c2.open + c2.close) / 2;

    const out = {};
    if (doji)         out.doji = true;
    if (hammer)       out.hammer = true;
    if (shootingStar) out.shooting_star = true;
    if (bullEngulf)   out.bullish_engulfing = true;
    if (bearEngulf)   out.bearish_engulfing = true;
    if (morningStar)  out.morning_star = true;
    if (eveningStar)  out.evening_star = true;
    return out;
}

module.exports = {
    computeIndicatorPack,
    computeSupportResistance,
    computeCandlePatterns,
};
