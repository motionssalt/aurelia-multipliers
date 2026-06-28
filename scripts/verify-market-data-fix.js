/* =====================================================================
   Verifies the "AI not getting market data" fix.

   Independent of the multiplier runner (which needs a live Deriv WS),
   this script:
     1. Synthesises a candle stream
     2. Stubs Deriv.ticksHistory so Payload.buildSymbolSlice() returns
        the same shape it returns in production
     3. Builds the aiInput object exactly as runMultiplierCycle now does
        AFTER the fix
     4. Renders the multiplier prompt (the actual string sent to the AI)
     5. Asserts that the rendered TICK INPUT contains the indicator
        readings the AI prompt requires (RSI, MACD, Bollinger Bands,
        EMA, S/R levels, candle data, etc.)

   Run:    node scripts/verify-market-data-fix.js
   ===================================================================== */
'use strict';

const path = require('path');
const Deriv      = require(path.join(__dirname, '..', 'deriv'));
const Payload    = require(path.join(__dirname, '..', 'payload-builder'));
const AIClient   = require(path.join(__dirname, '..', 'ai-client'));

// ── 1. Synthesise a believable candle stream (random walk) ──────────
function makeCandles(n, start = 60000) {
    const out = [];
    let close = start;
    let epoch = Math.floor(Date.now() / 1000) - n * 300;
    for (let i = 0; i < n; i++) {
        const drift = (Math.random() - 0.5) * 60;
        const open = close;
        close = open + drift;
        const high = Math.max(open, close) + Math.random() * 30;
        const low  = Math.min(open, close) - Math.random() * 30;
        out.push({ epoch: epoch + i * 300, open, high, low, close });
    }
    return out;
}

// ── 2. Stub Deriv.ticksHistory so buildSymbolSlice() can run offline ─
Deriv.ticksHistory = async function stubTicksHistory(ws, symbol, granularity, count) {
    return makeCandles(count, symbol === 'cryBTCUSD' ? 60000 : 100);
};

// ── 3. Build aiInput the way the patched runner does ────────────────
async function buildPatchedAiInput(symbol) {
    const marketSlice = await Payload.buildSymbolSlice(/*ws=*/null, symbol);
    return {
        cycle_id: new Date().toISOString(),
        symbol,
        balance: 9933.27,
        currency: 'USD',
        account_mode: 'demo',
        session: {
            active: true, capital_start: 1010, capital_remaining: 1010,
            take_profit: 0, stop_loss: 0, pnl: 0, trades: 0,
            wins: 0, losses: 0, win_streak: 0, loss_streak: 0,
            halted: false, halt_reason: null,
        },
        exposure: { open_count: 0, total_stake: 0, total_floating_pnl: 0 },
        open_siblings: [],
        just_closed: [],
        gates: { can_open_new: true, reason: null },
        market: {
            symbol: marketSlice.symbol,
            timeframes: marketSlice.timeframes,
            volatility_proxy_atr14_m5: marketSlice.volatility_proxy_atr14_m5,
        },
    };
}

// ── 4. Run + assert ─────────────────────────────────────────────────
(async () => {
    const aiInput = await buildPatchedAiInput('cryBTCUSD');
    const prompt  = AIClient._buildMultiplierPrompt(aiInput, {
        stake: { absolute_min: 0.35, absolute_max: 10000 },
        ai:    { min_confidence: 0 },
    });

    const checks = [
        ['Has market block',                 !!aiInput.market],
        ['Has M5 timeframe',                 !!aiInput.market.timeframes.M5],
        ['Has M10 timeframe',                !!aiInput.market.timeframes.M10],
        ['Has M15 timeframe',                !!aiInput.market.timeframes.M15],
        ['M5 has candles array',             Array.isArray(aiInput.market.timeframes.M5.candles)],
        ['M5 has >0 candles',                aiInput.market.timeframes.M5.candles.length > 0],
        ['M5 has indicators',                !!aiInput.market.timeframes.M5.indicators],
        ['M5 has RSI value',                 typeof aiInput.market.timeframes.M5.indicators.rsi_14 === 'number'],
        ['M5 has EMA20 value',               typeof aiInput.market.timeframes.M5.indicators.ema_20 === 'number'],
        ['M5 has EMA50 value',               typeof aiInput.market.timeframes.M5.indicators.ema_50 === 'number'],
        ['M5 has MACD object',               !!aiInput.market.timeframes.M5.indicators.macd],
        ['M5 has Bollinger Bands',           !!aiInput.market.timeframes.M5.indicators.bb],
        ['M5 has ATR',                       typeof aiInput.market.timeframes.M5.indicators.atr_14 === 'number'],
        ['M5 has support/resistance',        !!aiInput.market.timeframes.M5.support_resistance],
        ['M5 has candle_patterns block',     !!aiInput.market.timeframes.M5.candle_patterns],
        ['Volatility proxy populated',       typeof aiInput.market.volatility_proxy_atr14_m5 === 'number'],
        ['Prompt mentions "TICK INPUT"',     prompt.includes('TICK INPUT')],
        ['Prompt embeds RSI value',          /"rsi_14"\s*:\s*[0-9.\-]+/.test(prompt)],
        ['Prompt embeds MACD',               /"macd"\s*:\s*\{[\s\S]*?"signal"/.test(prompt)],
        ['Prompt embeds Bollinger Bands',    /"bb"\s*:\s*\{[\s\S]*?"upper"/.test(prompt)],
        ['Prompt embeds EMA20',              /"ema_20"\s*:\s*[0-9.\-]+/.test(prompt)],
        ['Prompt embeds EMA50',              /"ema_50"\s*:\s*[0-9.\-]+/.test(prompt)],
        ['Prompt embeds Stochastic',         /"stoch"\s*:\s*\{[\s\S]*?"k"/.test(prompt)],
        ['Prompt embeds support_resistance', /"support_resistance"\s*:\s*\{/.test(prompt)],
        ['Prompt embeds candle data',        /"candles"\s*:\s*\[/.test(prompt)],
    ];

    let pass = 0, fail = 0;
    for (const [label, ok] of checks) {
        console.log((ok ? '  ✅ ' : '  ❌ ') + label);
        ok ? pass++ : fail++;
    }
    console.log(`\nResult: ${pass}/${checks.length} checks passed${fail ? ` (${fail} FAILED)` : ''}`);

    // Show a snippet of what the AI will actually see now
    const m5 = aiInput.market.timeframes.M5.indicators;
    console.log('\nSample M5 indicators the AI now sees for cryBTCUSD:');
    console.log('  rsi_14 =', m5.rsi_14);
    console.log('  ema_20 =', m5.ema_20, ' ema_50 =', m5.ema_50);
    console.log('  macd   =', m5.macd);
    console.log('  bb     =', m5.bb);
    console.log('  atr_14 =', m5.atr_14);

    process.exit(fail ? 1 : 0);
})().catch(e => {
    console.error('verify-market-data-fix CRASHED:', e);
    process.exit(2);
});
