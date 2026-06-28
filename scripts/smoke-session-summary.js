#!/usr/bin/env node
/*
 * Part 3c smoke test — session summary template + trigger logic.
 *
 * Verifies:
 *   1. templates.sessionSummary renders the expected sections for a
 *      mixed-outcome session (entry/exit/TP/SL/stake/P/L/duration per
 *      position, plus session totals).
 *   2. maybeSendSessionSummary fires on the force-close path and the
 *      pause-and-drained path, latches via _notified_session_summary,
 *      and does NOT fire on a paused-but-still-open session.
 *
 * This is intentionally tiny — not a full test suite. It exists to
 * catch obvious regressions in the wiring; deeper coverage lives in
 * the integration tests.
 */

const assert   = require('assert');
const path     = require('path');

// Stub Telegram.send/sendPhoto BEFORE requiring runner.js so the runner
// picks up our stubs. (telegram.js is required at the top of runner.js.)
const Telegram = require(path.join(__dirname, '..', 'telegram.js'));
const sent = [];
Telegram.send = async (msg) => { sent.push(msg); return { ok: true }; };
Telegram.sendPhoto = async (buf, caption) => { sent.push(caption); return { ok: true }; };

const Runner   = require(path.join(__dirname, '..', 'runner.js'));

const STARTED_AT = '2026-06-28T08:00:00.000Z';
const OPENED_AT_1 = '2026-06-28T08:01:14.220Z';
const CLOSED_AT_1 = '2026-06-28T08:08:42.105Z';
const OPENED_AT_2 = '2026-06-28T08:01:14.560Z';
const CLOSED_AT_2 = '2026-06-28T08:15:30.000Z';
const OPENED_AT_3 = '2026-06-28T08:20:00.000Z';
const CLOSED_AT_3 = '2026-06-28T08:35:00.000Z';

function makeHistRecord(over) {
    return Object.assign({
        ts: CLOSED_AT_1,
        path: 'cycle',
        engine: 'multipliers',
        symbol: 'R_100',
        contract_id: 12345,
        direction: 'up',
        stake: 12.5,
        multiplier: 100,
        take_profit: 6.25,
        stop_loss: 6.25,
        outcome: 'win',
        pnl: 3.42,
        entry: 268.42,
        exit: 269.10,
        close_reason: 'tp_hit',
        settled: true,
        cycle_id: STARTED_AT,
        decision_id: 'dec-7f02b1',
        sibling_index: 0,
        sibling_count: 2,
        rationale: null,
        opened_at: OPENED_AT_1,
        ai_outcome_note: null,
        session_started_at: STARTED_AT,
    }, over || {});
}

/* ── 1. Template rendering ──────────────────────────────────────── */
function testTemplate() {
    const positions = [
        makeHistRecord({
            contract_id: 11, opened_at: OPENED_AT_1, ts: CLOSED_AT_1,
            pnl: 3.42, outcome: 'win', exit: 269.10, close_reason: 'tp_hit',
        }),
        makeHistRecord({
            contract_id: 22, opened_at: OPENED_AT_2, ts: CLOSED_AT_2,
            direction: 'down', pnl: -2.10, outcome: 'loss',
            entry: 268.42, exit: 268.95, close_reason: 'sl_hit',
        }),
        makeHistRecord({
            contract_id: 33, opened_at: OPENED_AT_3, ts: CLOSED_AT_3,
            symbol: 'frxEURUSD', multiplier: 200, stake: 25,
            take_profit: null, stop_loss: 12.5,
            pnl: 0.00, outcome: 'breakeven',
            entry: 1.0825, exit: 1.0825, close_reason: 'ai_close',
        }),
    ];

    const msg = Telegram.templates.sessionSummary({
        startedAt: STARTED_AT,
        endedAt:   '2026-06-28T08:36:00.000Z',
        endedReason: 'take_profit',
        haltReason: 'aggregate P/L +10.32 >= take_profit 10',
        mode:       'demo',
        session: {
            capital_start: 1000, capital_remaining: 1001.32,
            take_profit: 10, stop_loss: 30,
            trades: 3, wins: 1, losses: 1, pnl: 1.32,
        },
        balance: 9871.32, currency: 'USD',
        positions,
    });

    // Header
    assert(msg.includes('TAKE-PROFIT'), 'expected TP header');
    assert(msg.includes('SESSION ENDED'), 'expected session-ended header');
    // Each position rendered
    assert(msg.includes('R_100'), 'expected R_100 row');
    assert(msg.includes('frxEURUSD'), 'expected frxEURUSD row');
    assert(msg.includes('MULTUP') && msg.includes('MULTDOWN'),
        'expected both directions rendered');
    // Stake / P/L / duration cues
    assert(msg.includes('+$3.42') && msg.includes('-$2.10'),
        'expected signed P/L per position');
    // Duration label format (e.g. '7m 27s')
    assert(/\d+m\s+\d+s/.test(msg) || /\d+h\s+\d+m/.test(msg),
        'expected at least one duration label');
    // Totals
    assert(msg.includes('Positions : 3'), 'expected total position count');
    assert(msg.includes('W / L'), 'expected W/L line');
    assert(/Realised\s*:\s*<b>\+\$1\.32/.test(msg), 'expected realised total');
    // Restart hint
    assert(msg.includes('/startcycle'), 'expected restart hint');

    console.log('✅ template rendering OK');
    console.log('--- sample output ---');
    console.log(msg);
    console.log('--- end sample ---');
}

/* ── 2. Trigger logic via maybeSendSessionSummary ──────────────── */
async function testTriggerForceClose() {
    sent.length = 0;
    const state = {
        cycle_session: {
            active: false,    // post force-close
            halted: true,
            halt_reason: 'aggregate P/L -30.20 <= -stop_loss 30',
            started_at: STARTED_AT,
            capital_start: 1000, capital_remaining: 970,
            take_profit: 10, stop_loss: 30,
            trades: 1, wins: 0, losses: 1, pnl: -30.20,
        },
        cycle_open_siblings: {},  // all force-closed
        trade_history_cycle: [
            makeHistRecord({ pnl: -30.20, outcome: 'loss',
                close_reason: 'force_close_session_sl', exit: 264.10 }),
        ],
        balance: 9870, currency: 'USD', account_mode: 'demo',
    };
    const config = { cycle: { running: true }, account: { mode: 'demo' } };
    const entrySnap = {
        started_at: STARTED_AT,
        active: true, halted: false, cycleRunning: true,
    };
    await Runner.maybeSendSessionSummary(state, config, entrySnap,
        { symbol: 'R_100', riskBreached: true, riskReason: 'stop_loss' });

    assert.strictEqual(sent.length, 1, 'expected exactly one message');
    assert(sent[0].includes('STOP-LOSS'), 'expected SL header on force-close');
    assert.strictEqual(state._notified_session_summary, STARTED_AT,
        'expected latch set to started_at');

    // Re-firing on next tick is suppressed by the latch.
    await Runner.maybeSendSessionSummary(state, config, entrySnap,
        { symbol: 'R_100', riskBreached: true, riskReason: 'stop_loss' });
    assert.strictEqual(sent.length, 1, 'latch should suppress second fire');

    console.log('✅ force-close trigger + latch OK');
}

async function testTriggerPauseAndDrained() {
    sent.length = 0;
    const state = {
        cycle_session: {
            active: true, halted: false, halt_reason: null,
            started_at: STARTED_AT,
            capital_start: 1000, capital_remaining: 1002.0,
            take_profit: 10, stop_loss: 30,
            trades: 2, wins: 1, losses: 0, pnl: 2.0,
        },
        cycle_open_siblings: {},  // drained
        trade_history_cycle: [ makeHistRecord({}) ],
        balance: 9900, currency: 'USD', account_mode: 'demo',
    };
    // Operator just paused — entry showed running=true, post-tick running=false.
    const config = { cycle: { running: false }, account: { mode: 'demo' } };
    const entrySnap = {
        started_at: STARTED_AT, active: true, halted: false, cycleRunning: true,
    };
    await Runner.maybeSendSessionSummary(state, config, entrySnap,
        { symbol: 'R_100', riskBreached: false });

    assert.strictEqual(sent.length, 1, 'expected fire on pause-and-drained');
    assert(sent[0].includes('PAUSED'), 'expected PAUSED header');
    console.log('✅ pause-and-drained trigger OK');
}

async function testNoFireOnPausedWithOpenPositions() {
    sent.length = 0;
    const state = {
        cycle_session: {
            active: true, halted: false, halt_reason: null,
            started_at: STARTED_AT,
            capital_start: 1000, capital_remaining: 987.5,
            take_profit: 10, stop_loss: 30,
            trades: 0, wins: 0, losses: 0, pnl: 0,
        },
        cycle_open_siblings: { R_100: [{ contract_id: 99 }] },  // still open
        trade_history_cycle: [],
        balance: 9900, currency: 'USD', account_mode: 'demo',
    };
    const config = { cycle: { running: false }, account: { mode: 'demo' } };
    const entrySnap = {
        started_at: STARTED_AT, active: true, halted: false, cycleRunning: true,
    };
    await Runner.maybeSendSessionSummary(state, config, entrySnap,
        { symbol: 'R_100', riskBreached: false });

    assert.strictEqual(sent.length, 0,
        'should NOT fire when paused but positions still open');
    console.log('✅ paused-with-open suppression OK');
}

/* ── run ───────────────────────────────────────────────────────── */
(async () => {
    testTemplate();
    await testTriggerForceClose();
    await testTriggerPauseAndDrained();
    await testNoFireOnPausedWithOpenPositions();
    console.log('\n🟢 Part 3c smoke OK');
})().catch((e) => {
    console.error('❌', e);
    process.exit(1);
});
