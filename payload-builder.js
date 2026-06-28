/* =====================================================================
   AURELIA — payload-builder.js
   ─────────────────────────────────────────────────────────────────────
   Assembles the JSON payload sent to the AI on every cycle tick.

   Contract (REBUILD_PROMPT §3 & §4):
     Per enabled symbol, per timeframe (M5/M10/M15):
       • recent OHLC (aggregated; NO raw ticks)
       • full indicator pack (RSI/EMA/MACD/BB/ATR/ADX/Stoch/Keltner/Donchian/Ichimoku)
       • support/resistance levels
       • candlestick pattern flags
       • spread/volatility context (atr_14 as volatility proxy)
     Plus session context (summarised, capped):
       • running W/L, streaks, P/L, capital remaining, distance to TP/SL
       • last N trades (capped) with rationale + ai_outcome_note — NOT raw candles

   Lookback: 5 hours per the spec. At M5 that's 60 candles; M10 → 30; M15 → 20.
   We pull a bit more so indicators with longer warmups can settle.
   ===================================================================== */

'use strict';

const Deriv      = require('./deriv');
const Indicators = require('./indicators');
const Logger     = require('./logger');

// Granularity (seconds) per timeframe label.
const TF = {
    M5:  300,
    M10: 600,
    M15: 900,
};

// How many candles to request per TF (≥ 5h coverage, with headroom for
// 50-period EMA / 26-period MACD warmup).
const TF_CANDLE_COUNT = {
    M5:  100,   // 100 × 5m  = ~8.3h
    M10: 60,    // 60  × 10m = 10h
    M15: 60,    // 60  × 15m = 15h
};

/* ─────────────────────────────────────────────────────────────────
   Enumerate the symbol pool: forex always, synthetics if syn_enabled.
   ───────────────────────────────────────────────────────────────── */
function enabledSymbols(config) {
    const out = [];
    const fx = (config.symbols && config.symbols.forex) || {};
    for (const [s, on] of Object.entries(fx)) if (on) out.push(s);
    if (config.syn_enabled) {
        const sy = (config.symbols && config.symbols.synthetics) || {};
        for (const [s, on] of Object.entries(sy)) if (on) out.push(s);
    }
    return out;
}

/* ─────────────────────────────────────────────────────────────────
   Build the full per-symbol slice (all 3 TFs + indicators + S/R + patterns)
   ───────────────────────────────────────────────────────────────── */
async function buildSymbolSlice(ws, symbol) {
    const slice = { symbol, timeframes: {} };
    for (const [label, gran] of Object.entries(TF)) {
        try {
            const candles = await Deriv.ticksHistory(ws, symbol, gran, TF_CANDLE_COUNT[label]);
            // Send only OHLC (no epoch noise) plus computed indicators.
            const compactCandles = candles.slice(-40).map(c => ({
                o: c.open, h: c.high, l: c.low, c: c.close,
            }));
            slice.timeframes[label] = {
                granularity_seconds: gran,
                candles: compactCandles,
                indicators:    Indicators.computeIndicatorPack(candles),
                support_resistance: Indicators.computeSupportResistance(candles, 50),
                candle_patterns:    Indicators.computeCandlePatterns(candles),
            };
        } catch (e) {
            Logger.warn(`Failed to fetch ${symbol} ${label}`, { error: e.message });
            slice.timeframes[label] = { error: e.message };
        }
    }
    // Volatility context: use M5 ATR as a coarse spread/vol proxy.
    const m5 = slice.timeframes.M5;
    slice.volatility_proxy_atr14_m5 =
        (m5 && m5.indicators && m5.indicators.atr_14) || null;
    return slice;
}

/* ─────────────────────────────────────────────────────────────────
   Summarise session for the AI. Caps history.
   ───────────────────────────────────────────────────────────────── */
function buildSessionContext(state, config) {
    const s = state.cycle_session || {};
    const tp = Number(s.take_profit || 0);
    const sl = Number(s.stop_loss   || 0);
    const pnl = Number(s.pnl || 0);
    const cap = Number(s.capital_remaining || 0);

    const maxHist = (config.ai && config.ai.max_history_entries) || 12;
    const hist = (state.trade_history_cycle || []).slice(-maxHist).map(t => ({
        ts: t.ts,
        symbol: t.symbol,
        direction: t.direction,
        stake: t.stake,
        outcome: t.outcome,
        pnl: t.pnl,
        rationale_at_entry: t.rationale,
        ai_outcome_note: t.ai_outcome_note || null,
    }));

    return {
        active:               !!s.active,
        capital_remaining:    cap,
        running_pnl:          pnl,
        wins:                 Number(s.wins || 0),
        losses:               Number(s.losses || 0),
        win_streak:           Number(s.win_streak || 0),
        loss_streak:          Number(s.loss_streak || 0),
        take_profit_target:   tp,
        stop_loss_threshold:  sl,
        distance_to_tp:       (tp > 0) ? Math.max(0, tp - pnl) : null,
        distance_to_sl:       (sl > 0) ? Math.max(0, sl + pnl) : null,
        recent_trades:        hist,
    };
}

/* ─────────────────────────────────────────────────────────────────
   Main: build the full AI payload (one call per cycle).
   ───────────────────────────────────────────────────────────────── */
async function buildDecisionPayload(ws, config, state) {
    const symbols = enabledSymbols(config);
    if (!symbols.length) throw new Error('No enabled symbols to scan');

    const slices = [];
    for (const sym of symbols) {
        slices.push(await buildSymbolSlice(ws, sym));
    }

    // stake_ceiling is the ABSOLUTE per-trade cap, not the session
    // budget. Session capital_remaining is tracked separately in the
    // `session` block so the AI knows the envelope, but must NOT be
    // treated as a single-trade ceiling — that caused stake-sizing
    // bugs where the AI tried to bet the entire remaining envelope
    // on one trade.
    return {
        meta: {
            generated_at: new Date().toISOString(),
            account_mode: state.account_mode || config.account.mode,
            frx_enabled:  config.frx_enabled !== false,
            syn_enabled:  !!config.syn_enabled,
            min_expiry_seconds: (config.expiry && config.expiry.min_seconds) || 900,
            stake_floor:   (config.stake && config.stake.absolute_min) || 0.35,
            stake_ceiling: (config.stake && config.stake.absolute_max) || 10000,
        },
        symbols: slices,
        session: buildSessionContext(state, config),
    };
}

module.exports = {
    TF,
    enabledSymbols,
    buildDecisionPayload,
    buildSymbolSlice,
    buildSessionContext,
};
