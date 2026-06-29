#!/usr/bin/env node
/* smoke-initial-determination-scan.js
 *
 * Regression for: "AI doesn't scan all the enabled symbols during initial
 * determination, it only scans the first one."
 *
 * Root cause: in multi-candidate mode the per-candidate market data
 * (timeframes, indicators, S/R, candle patterns) was attached to
 * aiInput.candidates[] correctly, but the prompt body kept anchoring
 * on the single top-level aiInput.symbol / aiInput.market pair. The
 * AI therefore wrote rationales citing only the first enabled symbol
 * and never compared the others.
 *
 * Fix: _buildMultiplierPrompt now emits a CANDIDATE SCAN block listing
 * the headline M5 indicators for EVERY candidate side-by-side, and the
 * multi-symbol-mode instruction explicitly tells the AI that the
 * top-level symbol/market block is a fallback with no preference.
 *
 * Coverage:
 *   D1. _renderCandidateSnapshot returns null in single-symbol mode.
 *   D2. _renderCandidateSnapshot lists ALL candidate symbols.
 *   D3. _renderCandidateSnapshot cites M5 RSI / MACD / BB / EMA / ATR
 *       numbers for each candidate (not just the first).
 *   D4. _renderCandidateSnapshot handles a failed-fetch candidate gracefully.
 *   D5. _buildMultiplierPrompt embeds the CANDIDATE SCAN block.
 *   D6. _buildMultiplierPrompt in multi mode lists valid multipliers for
 *       every candidate, not only the first.
 *   D7. _buildMultiplierPrompt in multi mode tells the AI the top-level
 *       symbol/market is a fallback (no preference).
 *   D8. _buildMultiplierPrompt in single-symbol mode is UNCHANGED in
 *       the structurally important ways (still names the current symbol).
 */
'use strict';

const AI = require('../ai-client.js');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass++; console.log(' OK   ' + name); }
    else { fail++; console.error(' FAIL ' + name + (detail ? '  ' + JSON.stringify(detail).slice(0, 300) : '')); }
}

function makeCandidate(sym, overrides) {
    const base = {
        symbol: sym,
        timeframes: {
            M5: {
                granularity_seconds: 300,
                candles: [
                    { o: 1.0820, h: 1.0825, l: 1.0818, c: 1.0822 },
                    { o: 1.0822, h: 1.0828, l: 1.0820, c: 1.0826 },
                ],
                indicators: {
                    rsi_14: 47.06,
                    macd: { histogram: -0.000022, signal: 0.00001, macd: -0.00001 },
                    bollinger: { upper: 1.0830, middle: 1.0822, lower: 1.0814, percent_b: 0.45 },
                    ema_20: 1.0821,
                    ema_50: 1.0824,
                    atr_14: 0.00038,
                    stochastic: { k: 25.39, d: 30.1 },
                },
                support_resistance: { support: [1.0815], resistance: [1.0830] },
                candle_patterns: [],
            },
            M10: { granularity_seconds: 600, candles: [], indicators: {} },
            M15: { granularity_seconds: 900, candles: [], indicators: {} },
        },
        volatility_proxy_atr14_m5: 0.00038,
    };
    return Object.assign(base, overrides || {});
}

function makeAiInputBase(extras) {
    return Object.assign({
        cycle_id: '2026-06-29T00:00:00.000Z',
        symbol: 'frxEURUSD',
        balance: 1000,
        currency: 'USD',
        account_mode: 'demo',
        session: {
            active: true, halted: false,
            capital_start: 1000, capital_remaining: 1000,
            take_profit: 20, stop_loss: 20,
            pnl: 0, trades: 0, wins: 0, losses: 0,
            win_streak: 0, loss_streak: 0,
            halt_reason: null,
        },
        exposure: { symbol: 'frxEURUSD', count: 0 },
        open_siblings: [],
        just_closed: [],
        gates: { can_open_new: true, reason: null },
        market: { symbol: 'frxEURUSD', timeframes: {} },
        tp_sl_ranges: null,
    }, extras || {});
}

const config = {
    stake: { absolute_min: 1, absolute_max: 1000 },
    ai: { min_confidence: 0.5 },
};

// ---- D1: single-symbol mode returns null ---------------------------
{
    const snap = AI._renderCandidateSnapshot(makeAiInputBase());
    ok('D1: single-symbol mode → snapshot is null', snap === null, { snap });
}

// ---- D2 + D3: multi-symbol snapshot lists all candidates with indicators
{
    const eth = makeCandidate('cryETHUSD', {
        timeframes: {
            M5: {
                candles: [{ o: 3400, h: 3420, l: 3395, c: 3415 }],
                indicators: {
                    rsi_14: 72.4,
                    macd: { histogram: 12.4 },
                    bollinger: { percent_b: 0.78 },
                    ema_20: 3410, ema_50: 3380,
                    atr_14: 18.5,
                    stochastic: { k: 81.2 },
                },
            },
        },
    });
    const btc = makeCandidate('cryBTCUSD', {
        timeframes: {
            M5: {
                candles: [{ o: 68000, h: 68300, l: 67950, c: 68241.5 }],
                indicators: {
                    rsi_14: 63.2,
                    macd: { histogram: 185.3 },
                    bollinger: { percent_b: 0.62 },
                    ema_20: 68100, ema_50: 67800,
                    atr_14: 185.30,
                    stochastic: { k: 68.5 },
                },
            },
        },
    });
    const input = makeAiInputBase({ candidates: [makeCandidate('frxEURUSD'), btc, eth] });
    const snap = AI._renderCandidateSnapshot(input);

    ok('D2: snapshot string is produced', typeof snap === 'string' && snap.length > 0);
    ok('D2: snapshot mentions frxEURUSD', snap.includes('frxEURUSD'));
    ok('D2: snapshot mentions cryBTCUSD', snap.includes('cryBTCUSD'));
    ok('D2: snapshot mentions cryETHUSD', snap.includes('cryETHUSD'));

    // D3: each candidate's headline indicator numbers must appear.
    ok('D3: frxEURUSD RSI 47.1 present',  snap.includes('47.1'));
    ok('D3: cryBTCUSD RSI 63.2 present',  snap.includes('63.2'));
    ok('D3: cryETHUSD RSI 72.4 present',  snap.includes('72.4'));
    ok('D3: distinct EMA20-vs-50 readings (below + above)',
        snap.includes('EMA20-vs-50=below') && snap.includes('EMA20-vs-50=above'));
    ok('D3: snapshot includes the "evaluate every row" instruction',
        snap.includes('evaluate every row'));
    ok('D3: snapshot warns against first-symbol default',
        /do\s+NOT\s+default\s+to\s+the\s+first\s+symbol/i.test(snap));
}

// ---- D4: failed-fetch candidate handled gracefully -----------------
{
    const broken = { symbol: 'cryBROKEN', error: 'timeout' };
    const good = makeCandidate('cryBTCUSD');
    const input = makeAiInputBase({ candidates: [good, broken] });
    const snap = AI._renderCandidateSnapshot(input);
    ok('D4: broken candidate still rendered',     snap.includes('cryBROKEN'));
    ok('D4: error reason surfaced in snapshot',   snap.includes('timeout'));
    ok('D4: good candidate still rendered alongside', snap.includes('cryBTCUSD'));
}

// ---- D5: full prompt embeds the CANDIDATE SCAN block ---------------
{
    const input = makeAiInputBase({
        candidates: [makeCandidate('frxEURUSD'), makeCandidate('cryBTCUSD')],
    });
    const prompt = AI._buildMultiplierPrompt(input, config);
    ok('D5: prompt contains CANDIDATE SCAN header', prompt.includes('CANDIDATE SCAN'));
    ok('D5: prompt contains snapshot row for frxEURUSD',
        /•\s+frxEURUSD\s+spot=/.test(prompt));
    ok('D5: prompt contains snapshot row for cryBTCUSD',
        /•\s+cryBTCUSD\s+spot=/.test(prompt));
}

// ---- D6: per-candidate valid multipliers in multi mode -------------
{
    const input = makeAiInputBase({
        candidates: [makeCandidate('frxEURUSD'), makeCandidate('cryBTCUSD'), makeCandidate('cryETHUSD')],
    });
    const prompt = AI._buildMultiplierPrompt(input, config);
    // Every candidate symbol should appear in the multiplier-set block,
    // not just the first one. Look for "- <sym>" bullet form.
    ok('D6: multipliers block lists frxEURUSD', /-\s+frxEURUSD/.test(prompt));
    ok('D6: multipliers block lists cryBTCUSD', /-\s+cryBTCUSD/.test(prompt));
    ok('D6: multipliers block lists cryETHUSD', /-\s+cryETHUSD/.test(prompt));
    ok('D6: NOT using single-symbol "Current symbol:" phrasing',
        !prompt.includes('Current symbol: frxEURUSD'));
}

// ---- D7: multi mode strongly warns about top-level fallback --------
{
    const input = makeAiInputBase({
        candidates: [makeCandidate('frxEURUSD'), makeCandidate('cryBTCUSD')],
    });
    const prompt = AI._buildMultiplierPrompt(input, config);
    ok('D7: prompt declares MULTI-SYMBOL MODE',
        prompt.includes('MULTI-SYMBOL MODE'));
    ok('D7: prompt says MUST evaluate ALL candidates',
        /MUST evaluate ALL of them/.test(prompt));
    ok('D7: prompt flags aiInput.symbol / market as fallback only',
        /runner-side fallback/.test(prompt) && /carry NO[\s\u00a0]+preference/.test(prompt));
    ok('D7: prompt requires rationale to cite chosen-symbol numbers',
        /rationale MUST cite indicator numbers from the[\s\S]{0,30}CHOSEN symbol/.test(prompt));
    ok('D7: prompt asks AI to note why OTHER candidates were rejected',
        /why the other candidates were rejected/i.test(prompt));
}

// ---- D8: single-symbol mode prompt still correct -------------------
{
    const input = makeAiInputBase(); // no candidates
    const prompt = AI._buildMultiplierPrompt(input, config);
    ok('D8: single-symbol prompt names the active symbol',
        prompt.includes('Current symbol: frxEURUSD'));
    ok('D8: single-symbol prompt says SINGLE-SYMBOL MODE',
        prompt.includes('SINGLE-SYMBOL MODE'));
    ok('D8: single-symbol prompt does NOT contain CANDIDATE SCAN header',
        !prompt.includes('CANDIDATE SCAN'));
    ok('D8: single-symbol prompt does NOT contain MULTI-SYMBOL MODE',
        !prompt.includes('MULTI-SYMBOL MODE'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
