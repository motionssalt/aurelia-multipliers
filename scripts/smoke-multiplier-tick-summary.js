#!/usr/bin/env node
/* =====================================================================
   Smoke test for Part 2c — multiplierTickSummary Telegram template.
   ─────────────────────────────────────────────────────────────────────
   Pure-template test: renders multiplierTickSummary across every
   decision branch the AI can produce (hold, skip, open, close, revise,
   multi, unknown), plus the auxiliary states (just-closed sibling
   detection, aggregate risk breach, session halted, gracefully-missing
   exposure object). No network, no state.js required.

   Assertions check that the rendered HTML contains the right pieces
   per branch — we deliberately do NOT byte-compare against a golden
   snapshot since the wording is human-readable and likely to evolve.

   Run with:   node scripts/smoke-multiplier-tick-summary.js
   Exit 0 = all green, exit 1 = any assertion failed.
   ===================================================================== */

'use strict';

const path = require('path');
const Telegram = require(path.join('..', 'telegram.js'));

let pass = 0, fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass++; console.log(' OK   ' + name); }
    else      { fail++; console.error(' FAIL ' + name + (detail ? '  ' + JSON.stringify(detail) : '')); }
}
function has(msg, substr) { return String(msg).indexOf(substr) !== -1; }

// ---- shared fixtures -------------------------------------------------
const SYMBOL   = 'R_100';
const MODE     = 'demo';
const CURRENCY = 'USD';
const BALANCE  = 1000;

const sessionFresh = {
    active: true, halted: false, halt_reason: null,
    capital_start: 1000, capital_remaining: 950,
    take_profit: 20, stop_loss: 20,
    pnl: 0, trades: 0, wins: 0, losses: 0,
};

function sibling(overrides) {
    return Object.assign({
        contract_id: 3501118801,
        stake: 12.5,
        multiplier: 100,
        direction: 'up',
        entry_spot: 9100.5,
        entry_time: '2025-06-28T12:00:00Z',
        take_profit: 6.25,
        stop_loss: 6.25,
        floating_pnl: 1.23,
        floating_pnl_pct: 9.84,
        current_spot: 9105.7,
        sibling_index: 0,
        sibling_count: 1,
    }, overrides || {});
}

// ---- T1: action='hold', no siblings ---------------------------------
{
    const msg = Telegram.templates.multiplierTickSummary({
        symbol: SYMBOL, mode: MODE,
        decision: { action: 'hold', decision_id: 'dec-hold-1',
                    rationale: 'No setup; trend ambiguous.',
                    confidence: 0.4 },
        executed: { action: 'hold', details: [{ note: 'hold' }] },
        justClosed: [],
        openSiblings: [],
        preActionSiblings: [],
        exposure: { positions: 0, total_stake: 0, total_floating_pnl: 0 },
        session: sessionFresh,
        balance: BALANCE, currency: CURRENCY,
    });
    ok('T1.1 hold header',     has(msg, '⏸️ <b>HOLD</b>'));
    ok('T1.2 hold confidence', has(msg, '(40%)'));
    ok('T1.3 hold rationale',  has(msg, 'No setup'));
    ok('T1.4 hold no-siblings line', has(msg, 'Open siblings</b>: <i>none</i>'));
    ok('T1.5 hold exposure 0', has(msg, '0 pos'));
    ok('T1.6 hold decision_id footer', has(msg, 'dec-hold-1'));
    ok('T1.7 hold symbol shown', has(msg, SYMBOL));
}

// ---- T2: action='open' with 2 siblings ------------------------------
{
    const msg = Telegram.templates.multiplierTickSummary({
        symbol: SYMBOL, mode: 'real',
        decision: { action: 'open', decision_id: 'dec-open-1',
                    rationale: 'Trend continuation.',
                    confidence: 0.82,
                    open: { direction: 'down', stake: 6.25,
                            multiplier: 200, take_profit: 5, stop_loss: 5,
                            siblings: 2 } },
        executed: { action: 'open',
                    details: [{ contract_id: 9001 }, { contract_id: 9002 }] },
        justClosed: [],
        openSiblings: [
            sibling({ contract_id: 9001, direction: 'down', stake: 6.25,
                      multiplier: 200, take_profit: 5, stop_loss: 5,
                      floating_pnl: 0.0, floating_pnl_pct: 0,
                      sibling_index: 0, sibling_count: 2 }),
            sibling({ contract_id: 9002, direction: 'down', stake: 6.25,
                      multiplier: 200, take_profit: 5, stop_loss: 5,
                      floating_pnl: -0.1, floating_pnl_pct: -1.6,
                      sibling_index: 1, sibling_count: 2 }),
        ],
        preActionSiblings: [],
        exposure: { positions: 2, total_stake: 12.50, total_floating_pnl: -0.10 },
        session: sessionFresh,
        balance: BALANCE, currency: CURRENCY,
        riskBreach: null,
    });
    ok('T2.1 open header',      has(msg, '🆕 <b>OPEN</b>'));
    ok('T2.2 open direction',   has(msg, 'MULTDOWN'));
    ok('T2.3 open multiplier',  has(msg, '×200'));
    ok('T2.4 open stake×sibs',  has(msg, '× 2 siblings'));
    ok('T2.5 open TP/SL',       has(msg, '$5.00 / $5.00'));
    ok('T2.6 open shows real badge', has(msg, '🔴 REAL'));
    ok('T2.7 two open siblings rendered',
         has(msg, '9001') && has(msg, '9002'));
}

// ---- T3: action='close' with realised P/L ---------------------------
{
    const msg = Telegram.templates.multiplierTickSummary({
        symbol: SYMBOL, mode: MODE,
        decision: { action: 'close', decision_id: 'dec-close-1',
                    rationale: 'Thesis invalidated; exit.',
                    close: [{ contract_id: 8001, reason: 'thesis_flipped' }] },
        executed: { action: 'close',
                    details: [{ contract_id: 8001, closed: true, pnl: -2.43 }] },
        justClosed: [],
        openSiblings: [],
        preActionSiblings: [sibling({ contract_id: 8001 })],
        exposure: { positions: 0, total_stake: 0, total_floating_pnl: 0 },
        session: Object.assign({}, sessionFresh, { pnl: -2.43, trades: 1, losses: 1 }),
        balance: BALANCE, currency: CURRENCY,
    });
    ok('T3.1 close header',          has(msg, '🔒 <b>CLOSE</b>'));
    ok('T3.2 close contract listed', has(msg, '8001'));
    ok('T3.3 close shows realised P/L', has(msg, '-$2.43'));
    ok('T3.4 close reason shown',    has(msg, 'thesis_flipped'));
    ok('T3.5 close realised in session', has(msg, 'realised -$2.43'));
}

// ---- T4: action='revise' with old→new TP/SL --------------------------
{
    const msg = Telegram.templates.multiplierTickSummary({
        symbol: SYMBOL, mode: MODE,
        decision: { action: 'revise', decision_id: 'dec-rev-1',
                    rationale: 'Tighten TP, drop SL.',
                    revise: [
                        { contract_id: 7001, take_profit: 12.50, stop_loss: null },
                    ] },
        executed: { action: 'revise',
                    details: [{ contract_id: 7001, revised: { take_profit: 12.50, stop_loss: null } }] },
        justClosed: [],
        openSiblings: [
            sibling({ contract_id: 7001, take_profit: 12.50, stop_loss: null,
                      floating_pnl: 0.5 }),
        ],
        preActionSiblings: [
            sibling({ contract_id: 7001, take_profit: 6.25, stop_loss: 6.25 }),
        ],
        exposure: { positions: 1, total_stake: 12.50, total_floating_pnl: 0.5 },
        session: sessionFresh,
        balance: BALANCE, currency: CURRENCY,
    });
    ok('T4.1 revise header',       has(msg, '✏️ <b>REVISE</b>'));
    ok('T4.2 revise TP old→new',   has(msg, '$6.25 → $12.50'));
    ok('T4.3 revise SL cleared',   has(msg, '$6.25 → —'));
    ok('T4.4 revise sibling still open with new TP',
         has(msg, '$12.50 / —'));
}

// ---- T5: action='multi' (close + revise + open) ----------------------
{
    const msg = Telegram.templates.multiplierTickSummary({
        symbol: SYMBOL, mode: MODE,
        decision: { action: 'multi', decision_id: 'dec-multi-1',
                    rationale: 'Rotate exposure: dump loser, tighten winner, fresh down.',
                    confidence: 0.71,
                    multi: {
                        close:  [{ contract_id: 6001, reason: 'exit_loser' }],
                        revise: [{ contract_id: 6002, take_profit: 18.00 }],
                        open:   { direction: 'down', stake: 6.25,
                                  multiplier: 100, take_profit: 5,
                                  stop_loss: 5, siblings: 1 },
                    } },
        executed: { action: 'multi', details: [
            { phase: 'close',  contract_id: 6001, closed: true, pnl: -3.10 },
            { phase: 'revise', contract_id: 6002, revised: { take_profit: 18.00 } },
            { phase: 'open',   contract_id: 6003 },
        ]},
        justClosed: [],
        openSiblings: [
            sibling({ contract_id: 6002, take_profit: 18.00, stop_loss: 6.25,
                      floating_pnl: 2.1 }),
            sibling({ contract_id: 6003, direction: 'down', take_profit: 5, stop_loss: 5,
                      floating_pnl: 0 }),
        ],
        preActionSiblings: [
            sibling({ contract_id: 6001, take_profit: 6.25, stop_loss: 6.25 }),
            sibling({ contract_id: 6002, take_profit: 6.25, stop_loss: 6.25 }),
        ],
        exposure: { positions: 2, total_stake: 18.75, total_floating_pnl: 2.10 },
        session: Object.assign({}, sessionFresh, { pnl: -3.10, trades: 1, losses: 1 }),
        balance: BALANCE, currency: CURRENCY,
    });
    ok('T5.1 multi header',          has(msg, '🧩 <b>MULTI</b>'));
    ok('T5.2 multi confidence',      has(msg, '(71%)'));
    ok('T5.3 multi close block',     has(msg, 'Closing'));
    ok('T5.4 multi close P/L',       has(msg, '-$3.10'));
    ok('T5.5 multi revise block',    has(msg, 'Revising'));
    ok('T5.6 multi revise old→new',  has(msg, '$6.25 → $18.00'));
    ok('T5.7 multi open block',      has(msg, 'Opening'));
    ok('T5.8 multi open direction',  has(msg, 'MULTDOWN'));
    ok('T5.9 multi both new siblings shown',
         has(msg, '6002') && has(msg, '6003'));
}

// ---- T6: just_closed siblings detected server-side ------------------
{
    const msg = Telegram.templates.multiplierTickSummary({
        symbol: SYMBOL, mode: MODE,
        decision: { action: 'hold', decision_id: 'dec-jc-1',
                    rationale: 'Just-closed by stop-out; hold rest.' },
        executed: { action: 'hold', details: [{ note: 'hold' }] },
        justClosed: [
            { contract_id: 5001, outcome: 'win',  pnl:  4.50, reason: 'take_profit_hit' },
            { contract_id: 5002, outcome: 'loss', pnl: -2.10, reason: 'stop_loss_hit'   },
        ],
        openSiblings: [],
        preActionSiblings: [
            sibling({ contract_id: 5001 }), sibling({ contract_id: 5002 }),
        ],
        exposure: { positions: 0, total_stake: 0, total_floating_pnl: 0 },
        session: Object.assign({}, sessionFresh, { pnl: 2.40, trades: 2, wins: 1, losses: 1 }),
        balance: BALANCE, currency: CURRENCY,
    });
    ok('T6.1 just-closed header', has(msg, 'Just closed</b> (×2)'));
    ok('T6.2 just-closed win',    has(msg, '✅') && has(msg, '+$4.50'));
    ok('T6.3 just-closed loss',   has(msg, '❌') && has(msg, '-$2.10'));
    ok('T6.4 just-closed reason', has(msg, 'take_profit_hit'));
}

// ---- T7: aggregate risk breach (force-close all) --------------------
{
    const msg = Telegram.templates.multiplierTickSummary({
        symbol: SYMBOL, mode: MODE,
        decision: { action: 'hold', decision_id: 'dec-risk-1',
                    rationale: 'Held, but aggregate SL breached intra-tick.' },
        executed: { action: 'hold', details: [{ note: 'hold' }] },
        justClosed: [],
        openSiblings: [],   // post force-close: empty
        preActionSiblings: [sibling({ contract_id: 4001 })],
        exposure: { positions: 0, total_stake: 0, total_floating_pnl: 0 },
        session: Object.assign({}, sessionFresh, {
            halted: true, halt_reason: 'aggregate P/L -20.50 <= -stop_loss 20',
            pnl: -20.50, active: false,
        }),
        riskBreach: 'stop_loss',
        balance: BALANCE, currency: CURRENCY,
    });
    ok('T7.1 risk breach badge', has(msg, 'Risk breach this tick'));
    ok('T7.2 risk breach reason', has(msg, 'stop_loss'));
    ok('T7.3 session HALTED line', has(msg, '⛔ <b>HALTED</b>'));
}

// ---- T8: skip / unknown actions degrade gracefully -------------------
{
    const skipMsg = Telegram.templates.multiplierTickSummary({
        symbol: SYMBOL, mode: MODE,
        decision: { action: 'skip', decision_id: 'dec-skip-1',
                    rationale: 'Gate closed: session halted.' },
        executed: { action: 'skip', details: [{ note: 'skip' }] },
        openSiblings: [], session: sessionFresh,
        balance: BALANCE, currency: CURRENCY,
    });
    ok('T8.1 skip header', has(skipMsg, '⏭️ <b>SKIP</b>'));

    const unkMsg = Telegram.templates.multiplierTickSummary({
        symbol: SYMBOL, mode: MODE,
        decision: { action: 'wat', decision_id: 'dec-unknown-1',
                    rationale: 'corrupt schema' },
        executed: { action: 'wat', details: [] },
        openSiblings: [], session: sessionFresh,
        balance: BALANCE, currency: CURRENCY,
    });
    ok('T8.2 unknown action graceful', has(unkMsg, 'WAT'));
}

// ---- T9: HTML escape for nasty rationale ----------------------------
{
    const msg = Telegram.templates.multiplierTickSummary({
        symbol: SYMBOL, mode: MODE,
        decision: { action: 'hold', decision_id: '<id>&"x"',
                    rationale: '<script>alert(1)</script> & <b>x</b>' },
        executed: { action: 'hold', details: [{ note: 'hold' }] },
        openSiblings: [], session: sessionFresh,
        balance: BALANCE, currency: CURRENCY,
    });
    ok('T9.1 script tag escaped', !has(msg, '<script>'));
    ok('T9.2 amp escaped',        has(msg, '&amp;'));
    ok('T9.3 decision_id escaped (no raw <id>)',
         !has(msg, 'id=<id>'));
}

// ---- T10: exposure derives from siblings when missing --------------
{
    const msg = Telegram.templates.multiplierTickSummary({
        symbol: SYMBOL, mode: MODE,
        decision: { action: 'hold', decision_id: 'dec-exp-1',
                    rationale: '' },
        executed: { action: 'hold', details: [{ note: 'hold' }] },
        openSiblings: [
            sibling({ contract_id: 3001, stake: 5.00, floating_pnl: 1.00 }),
            sibling({ contract_id: 3002, stake: 5.00, floating_pnl: -0.50 }),
        ],
        // intentionally omit exposure:
        session: sessionFresh,
        balance: BALANCE, currency: CURRENCY,
    });
    ok('T10.1 derives 2 positions', has(msg, '2 pos'));
    ok('T10.2 derives total stake $10', has(msg, 'stake $10.00'));
    ok('T10.3 derives total float +$0.50', has(msg, 'float <b>+$0.50</b>'));
}

console.log('---');
console.log(`Passed: ${pass}    Failed: ${fail}`);
process.exit(fail ? 1 : 0);
