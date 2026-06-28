#!/usr/bin/env node
/* =====================================================================
   Smoke test for Part 2b — AI decision schema + validator + 'multi'
   dispatch on top of Part 2a's runMultiplierCycle.
   ─────────────────────────────────────────────────────────────────────
   Offline. Stubs deriv.js's network surface (same approach as
   smoke-multiplier-cycle.js) AND monkey-patches AIClient.askDecision so
   we can inject any AI response we want without touching network.

   Coverage:
     V1.  validator: hold passes through.
     V2.  validator: missing action → hold fallback.
     V3.  validator: close[] with contract_id not in open_siblings → reject.
     V4.  validator: close[] with all valid contract_ids → ok.
     V5.  validator: open with stake below absolute_min → reject.
     V6.  validator: open with non-integer multiplier → reject.
     V7.  validator: open when gates.can_open_new=false → reject.
     V8.  validator: revise with null clears, number sets, omit leaves alone.
     V9.  validator: revise referencing non-open contract → reject.
     V10. validator: confidence below min_confidence → coerced to hold.
     V11. validator: action='multi' bundling close + open + revise → ok.
     V12. validator: 'multi' with no sub-actions → reject.
     V13. validator: 'multi' revising a contract that's also being closed → reject.

   End-to-end through runMultiplierCycle (monkeypatched AI):
     E1.  AI returns multi{close: [..], open: {..}} → both branches fire,
          executed.details contains phase:'close' + phase:'open' entries.
     E2.  AI returns malformed JSON-equivalent (wrong types) → runner
          executes a hold, no side effects.
     E3.  AI returns open when can_open_new=false → validator rejects
          → hold fallback → no placeMultiplier call.

   Run with:   node scripts/smoke-multiplier-decision.js
   Exit 0 = all green, exit 1 = any assertion failed.
   ===================================================================== */

'use strict';

const path = require('path');
const Deriv    = require(path.join('..', 'deriv.js'));
const State    = require(path.join('..', 'state.js'));
const Runner   = require(path.join('..', 'runner.js'));
const AIClient = require(path.join('..', 'ai-client.js'));

let pass = 0, fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass++; console.log(' OK   ' + name); }
    else      { fail++; console.error(' FAIL ' + name + (detail ? '  ' + JSON.stringify(detail) : '')); }
}

function freshConfig() {
    return {
        enabled: true,
        account: { mode: 'demo' },
        symbols: { forex: {}, synthetics: { R_100: true } },
        frx_enabled: false,
        syn_enabled: true,
        cycle: {
            running: true, engine: 'multipliers', interval_seconds: 60,
            session: { capital: 1000, take_profit: 20, stop_loss: 20 },
        },
        stake:   { absolute_min: 0.35, absolute_max: 10000 },
        expiry:  { min_seconds: 900 },
        ai:      { min_confidence: 0.55, key_registry: [], providers: [] },
        payout:  { enabled: false },
        manual:  { capital: 200, take_profit: 20, stop_loss: 20 },
    };
}
function freshState() {
    return {
        balance: 1000, currency: 'USD', account_mode: 'demo',
        cycle_session: {
            active: true, halted: false, halt_reason: null,
            capital_start: 1000, capital_remaining: 975,
            take_profit: 20, stop_loss: 20,
            trades: 0, wins: 0, losses: 0, pnl: 0,
            win_streak: 0, loss_streak: 0,
        },
        cycle_open_siblings: {},
        pending_contracts: [],
        trade_history_cycle: [],
        trade_history_manual: [],
        ai_keys_bench: {},
        daily_stats: { date: new Date().toISOString().slice(0,10), trades: 0, wins: 0, losses: 0, pnl: 0, by_symbol: {} },
        logs: [],
    };
}

function sampleAiInput(extra) {
    return Object.assign({
        cycle_id: '2026-06-28T08:00:00.000Z',
        symbol:   'R_100',
        balance:  1000,
        currency: 'USD',
        account_mode: 'demo',
        session: {
            active: true, capital_start: 1000, capital_remaining: 975,
            take_profit: 20, stop_loss: 20, pnl: 0, trades: 0,
            wins: 0, losses: 0, win_streak: 0, loss_streak: 0,
            halted: false, halt_reason: null,
        },
        exposure: { symbol: 'R_100', count: 0, total_stake: 0, total_floating_pnl: null, net_position: 0, direction_mix: { up: 0, down: 0 } },
        open_siblings: [],
        just_closed: [],
        gates: { can_open_new: true, reason: null },
    }, extra || {});
}

function sib(id) {
    return {
        contract_id: id, stake: 10, multiplier: 100, direction: 'up',
        entry_spot: 100, entry_time: '2026-06-28T07:30:00.000Z',
        opened_at:  '2026-06-28T07:30:00.000Z',
        current_spot: 101, floating_pnl: 0.5, floating_pnl_pct: 5,
        bid_price: null, buy_price: 10, is_open: true,
        is_valid_to_sell: true, is_valid_to_cancel: false,
        take_profit: { amount: 5, value: 105 },
        stop_loss:   { amount: 5, value: 95  },
        stop_out:    { amount: 10, value: 90 },
        stop_out_distance_pct: 0.1,
        cycle_id: 'C', decision_id: 'D', sibling_index: 0, sibling_count: 1,
        rationale: 'test',
    };
}

// ────────────────────────── VALIDATOR TESTS ──────────────────────────
{
    const config = freshConfig();

    // V1: hold passes through.
    {
        const v = AIClient.validateMultiplierDecision(
            { action: 'hold', rationale: 'no setup', decision_id: 'd1' },
            sampleAiInput(), config);
        ok('V1: hold passes through', v.ok && v.decision.action === 'hold', v);
    }

    // V2: missing action → hold fallback.
    {
        const v = AIClient.validateMultiplierDecision({ rationale: 'oops' }, sampleAiInput(), config);
        ok('V2: missing/unknown action → hold fallback',
            !v.ok && v.decision.action === 'hold' && v.errs.length > 0, v);
    }

    // V3: close[] with contract_id not in open_siblings.
    {
        const v = AIClient.validateMultiplierDecision(
            { action: 'close', close: [{ contract_id: 999 }], decision_id: 'd3', rationale: 'r' },
            sampleAiInput({ open_siblings: [sib(123)] }), config);
        ok('V3: close[] with unknown contract_id → reject',
            !v.ok && v.decision.action === 'hold' && /not in open_siblings/.test(v.errs.join(';')), v);
    }

    // V4: close[] with valid contract_id.
    {
        const v = AIClient.validateMultiplierDecision(
            { action: 'close', close: [{ contract_id: 123, reason: 'thesis-flip' }], decision_id: 'd4', rationale: 'r' },
            sampleAiInput({ open_siblings: [sib(123), sib(456)] }), config);
        ok('V4: close[] with valid contract_id → ok',
            v.ok && v.decision.action === 'close' &&
            v.decision.close.length === 1 && v.decision.close[0].contract_id === 123 &&
            v.decision.close[0].reason === 'thesis-flip', v);
    }

    // V5: open with stake below absolute_min.
    {
        const v = AIClient.validateMultiplierDecision(
            { action: 'open', decision_id: 'd5', rationale: 'r',
              open: { direction: 'up', stake: 0.10, multiplier: 100, take_profit: 5, stop_loss: 5, siblings: 1 } },
            sampleAiInput(), config);
        ok('V5: open with stake < absolute_min → reject',
            !v.ok && /absolute_min/.test(v.errs.join(';')), v);
    }

    // V6: open with non-integer multiplier.
    {
        const v = AIClient.validateMultiplierDecision(
            { action: 'open', decision_id: 'd6', rationale: 'r',
              open: { direction: 'up', stake: 10, multiplier: 100.5, take_profit: 5, stop_loss: 5, siblings: 1 } },
            sampleAiInput(), config);
        ok('V6: open with non-integer multiplier → reject',
            !v.ok && /multiplier/.test(v.errs.join(';')), v);
    }

    // V7: open when can_open_new=false.
    {
        const v = AIClient.validateMultiplierDecision(
            { action: 'open', decision_id: 'd7', rationale: 'r',
              open: { direction: 'up', stake: 10, multiplier: 100, take_profit: 5, stop_loss: 5, siblings: 1 } },
            sampleAiInput({ gates: { can_open_new: false, reason: 'session halted' } }), config);
        ok('V7: open blocked by can_open_new=false → reject',
            !v.ok && /blocked/.test(v.errs.join(';')), v);
    }

    // V8: revise with null clears, number sets, omit leaves alone.
    {
        const v = AIClient.validateMultiplierDecision(
            { action: 'revise', decision_id: 'd8', rationale: 'r',
              revise: [
                  { contract_id: 123, take_profit: 12, stop_loss: null },   // set TP=12, clear SL
                  { contract_id: 456, take_profit: null }                   // clear TP only; SL omitted
              ] },
            sampleAiInput({ open_siblings: [sib(123), sib(456)] }), config);
        const e0 = v.ok ? v.decision.revise[0] : {};
        const e1 = v.ok ? v.decision.revise[1] : {};
        ok('V8: revise null/number/omit semantics preserved',
            v.ok &&
            e0.take_profit === 12 && e0.stop_loss === null &&
            e1.take_profit === null && !Object.prototype.hasOwnProperty.call(e1, 'stop_loss'),
            { v, e0, e1 });
    }

    // V9: revise referencing non-open contract.
    {
        const v = AIClient.validateMultiplierDecision(
            { action: 'revise', decision_id: 'd9', rationale: 'r',
              revise: [{ contract_id: 999, take_profit: 5 }] },
            sampleAiInput({ open_siblings: [sib(123)] }), config);
        ok('V9: revise unknown contract_id → reject',
            !v.ok && /not in open_siblings/.test(v.errs.join(';')), v);
    }

    // V10: confidence below min_confidence → coerced to hold.
    {
        const v = AIClient.validateMultiplierDecision(
            { action: 'close', confidence: 0.30, decision_id: 'dconf', rationale: 'r',
              close: [{ contract_id: 123 }] },
            sampleAiInput({ open_siblings: [sib(123)] }), config);
        ok('V10: confidence < min_confidence → coerced to hold',
            v.ok && v.decision.action === 'hold' && /Confidence/.test(v.decision.rationale), v);
    }

    // V11: action='multi' bundling close + open + revise.
    {
        const v = AIClient.validateMultiplierDecision(
            {
                action: 'multi', decision_id: 'dmulti', rationale: 'r',
                multi: {
                    close:  [{ contract_id: 123 }],
                    revise: [{ contract_id: 456, take_profit: 8 }],
                    open:   { direction: 'down', stake: 10, multiplier: 100, take_profit: 5, stop_loss: 5, siblings: 2 },
                },
            },
            sampleAiInput({ open_siblings: [sib(123), sib(456)] }), config);
        ok('V11: multi bundling close+revise+open → ok',
            v.ok && v.decision.action === 'multi' &&
            v.decision.multi.close.length === 1 &&
            v.decision.multi.revise.length === 1 &&
            v.decision.multi.open.siblings === 2, v);
    }

    // V12: multi with no sub-actions.
    {
        const v = AIClient.validateMultiplierDecision(
            { action: 'multi', decision_id: 'dm2', rationale: 'r', multi: {} },
            sampleAiInput({ open_siblings: [sib(123)] }), config);
        ok('V12: multi with no sub-actions → reject',
            !v.ok && /at least one of close/.test(v.errs.join(';')), v);
    }

    // V13: multi revising a contract that's also being closed.
    {
        const v = AIClient.validateMultiplierDecision(
            {
                action: 'multi', decision_id: 'dm3', rationale: 'r',
                multi: {
                    close:  [{ contract_id: 123 }],
                    revise: [{ contract_id: 123, take_profit: 8 }],
                },
            },
            sampleAiInput({ open_siblings: [sib(123)] }), config);
        ok('V13: multi revise of about-to-close contract → reject',
            !v.ok && /not in open_siblings/.test(v.errs.join(';')), v);
    }
}

// ──────────────────────── END-TO-END (runner + AI mock) ────────────────────────
//
// We monkeypatch AIClient.askDecision to return whatever raw decision we
// want for the current test. askMultiplierDecision sits on top of it and
// runs the validator + fallbacks.

function installDerivMock() {
    const calls = { getOpenPositionState: [], closeMultiplier: [], placeMultiplier: [], reviseMultiplierLimits: [] };
    const pocBehaviour = new Map();
    const sellBehaviour = new Map();
    const placeBehaviour = { fn: null };
    const reviseBehaviour = { fn: null };

    const origs = {
        getOpenPositionState:   Deriv.getOpenPositionState,
        closeMultiplier:        Deriv.closeMultiplier,
        placeMultiplier:        Deriv.placeMultiplier,
        reviseMultiplierLimits: Deriv.reviseMultiplierLimits,
        ensureOpen:             Deriv.ensureOpen,
    };
    Deriv.ensureOpen = async (ws) => ws || {};
    Deriv.getOpenPositionState = async (ws, cid) => {
        calls.getOpenPositionState.push(cid);
        const b = pocBehaviour.get(cid);
        if (!b) throw new Error('no behaviour for cid=' + cid);
        return typeof b === 'function' ? b() : b;
    };
    Deriv.closeMultiplier = async (ws, cid) => {
        calls.closeMultiplier.push(cid);
        const b = sellBehaviour.get(cid);
        return b || { contract_id: cid, sold_for: 11, balance_after: 1000 };
    };
    Deriv.placeMultiplier = async (ws, opts) => {
        calls.placeMultiplier.push(opts);
        if (placeBehaviour.fn) return placeBehaviour.fn(opts);
        return { proposal: { id: 'p1', spot: 100, date_start: 1700000000 }, buy: { contract_id: 9000 + calls.placeMultiplier.length } };
    };
    Deriv.reviseMultiplierLimits = async (ws, cid, changes) => {
        calls.reviseMultiplierLimits.push({ cid, changes });
        if (reviseBehaviour.fn) return reviseBehaviour.fn(cid, changes);
        const cu = {};
        if (Object.prototype.hasOwnProperty.call(changes, 'takeProfit'))
            cu.take_profit = changes.takeProfit === null ? null : { order_amount: changes.takeProfit };
        if (Object.prototype.hasOwnProperty.call(changes, 'stopLoss'))
            cu.stop_loss   = changes.stopLoss   === null ? null : { order_amount: -Math.abs(changes.stopLoss) };
        return cu;
    };
    function restore() { Object.assign(Deriv, origs); }
    return { calls, pocBehaviour, sellBehaviour, placeBehaviour, reviseBehaviour, restore };
}

// Mock AIClient.askMultiplierDecision directly — this is the function the
// runner imports and calls. We still pass the rawDecision through the real
// validateMultiplierDecision so the runner sees the same shape it would in
// production (i.e. invalid inputs still get coerced to hold).
function installAiMock(rawDecision) {
    const orig = AIClient.askMultiplierDecision;
    AIClient.askMultiplierDecision = async ({ aiInput, config }) => {
        const v = AIClient.validateMultiplierDecision(rawDecision, aiInput, config);
        return { decision: v.decision, keyUsed: 'TEST' };
    };
    return () => { AIClient.askMultiplierDecision = orig; };
}

async function runE2E() {
    // E1: multi{close, open} — both branches fire.
    {
        const mock = installDerivMock();
        const config = freshConfig();
        const state = freshState();
        State.addSiblingPosition(state, 'R_100', State.makeSiblingRecord({
            contract_id: 7001, stake: 10, multiplier: 100, direction: 'up',
            entry_spot: 100, entry_time: '2026-06-28T07:00:00.000Z',
            take_profit: 5, stop_loss: 5,
            cycle_id: 'C', decision_id: 'D', sibling_index: 0, sibling_count: 1,
            rationale: 'seed',
        }));
        mock.pocBehaviour.set(7001, {
            contract_id: 7001, current_spot: 101, profit: 0.5, profit_percentage: 5,
            is_open: true, is_sold: false, is_expired: false,
            is_valid_to_sell: true, is_valid_to_cancel: false,
            bid_price: 10.5, buy_price: 10,
            take_profit: { amount: 5, value: 105 },
            stop_loss:   { amount: 5, value: 95 },
            stop_out:    { amount: 10, value: 90 },
        });
        mock.sellBehaviour.set(7001, { contract_id: 7001, sold_for: 11.5, balance_after: 1011 });

        const uninstall = installAiMock({
            action: 'multi', decision_id: 'e1', rationale: 'rotate',
            confidence: 0.9,
            multi: {
                close: [{ contract_id: 7001, reason: 'thesis_flip' }],
                open:  { direction: 'down', stake: 5, multiplier: 100, take_profit: 3, stop_loss: 3, siblings: 1 },
            },
        });
        try {
            await Runner.runMultiplierCycle({}, config, state, {});
        } finally {
            uninstall();
            mock.restore();
        }
        ok('E1: closeMultiplier called for 7001', mock.calls.closeMultiplier.includes(7001));
        ok('E1: placeMultiplier called once', mock.calls.placeMultiplier.length === 1);
        ok('E1: trade_history_cycle has one closed entry', state.trade_history_cycle.length === 1);
        ok('E1: closed sibling removed from state', !State.getOpenSiblings(state, 'R_100').some(s => s.contract_id === 7001));
        ok('E1: new sibling persisted',  State.getOpenSiblings(state, 'R_100').length === 1);
    }

    // E2: malformed AI response → hold fallback, no side effects.
    {
        const mock = installDerivMock();
        const config = freshConfig();
        const state = freshState();
        State.addSiblingPosition(state, 'R_100', State.makeSiblingRecord({
            contract_id: 7002, stake: 10, multiplier: 100, direction: 'up',
            entry_spot: 100, entry_time: '2026-06-28T07:00:00.000Z',
            take_profit: 5, stop_loss: 5, cycle_id: 'C', decision_id: 'D',
            sibling_index: 0, sibling_count: 1, rationale: 'seed',
        }));
        mock.pocBehaviour.set(7002, {
            contract_id: 7002, current_spot: 100.2, profit: 0.05, profit_percentage: 0.5,
            is_open: true, is_sold: false, is_expired: false,
            is_valid_to_sell: true, is_valid_to_cancel: false,
            bid_price: 10.05, buy_price: 10,
            take_profit: { amount: 5, value: 105 },
            stop_loss:   { amount: 5, value: 95 },
            stop_out:    { amount: 10, value: 90 },
        });
        const uninstall = installAiMock({
            // 'close' but referencing a contract that isn't open → reject
            action: 'close', decision_id: 'e2', rationale: 'r', confidence: 0.9,
            close: [{ contract_id: 999999 }],
        });
        try {
            await Runner.runMultiplierCycle({}, config, state, {});
        } finally { uninstall(); mock.restore(); }
        ok('E2: no closeMultiplier on malformed AI response', mock.calls.closeMultiplier.length === 0);
        ok('E2: no placeMultiplier on malformed AI response', mock.calls.placeMultiplier.length === 0);
        ok('E2: sibling still open after hold fallback',
            State.getOpenSiblings(state, 'R_100').some(s => s.contract_id === 7002));
    }

    // E3: open requested but session halted → validator rejects → no place.
    {
        const mock = installDerivMock();
        const config = freshConfig();
        const state = freshState();
        state.cycle_session.halted = true;
        state.cycle_session.halt_reason = 'take_profit reached';
        state.cycle_session.active = false;
        const uninstall = installAiMock({
            action: 'open', decision_id: 'e3', rationale: 'r', confidence: 0.9,
            open: { direction: 'up', stake: 10, multiplier: 100, take_profit: 5, stop_loss: 5, siblings: 1 },
        });
        try {
            await Runner.runMultiplierCycle({}, config, state, {});
        } finally { uninstall(); mock.restore(); }
        ok('E3: no placeMultiplier when session halted (validator-side)', mock.calls.placeMultiplier.length === 0);
    }
}

(async () => {
    try { await runE2E(); }
    catch (e) { console.error('E2E threw:', e); fail++; }

    console.log('\n================================');
    console.log(` ${pass} passed, ${fail} failed`);
    console.log('================================\n');
    process.exit(fail === 0 ? 0 : 1);
})();
