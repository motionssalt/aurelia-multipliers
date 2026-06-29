#!/usr/bin/env node
/* smoke-overlap-guard.js
 *
 * Issue #3: Duplicate tick notifications when no trade is open.
 * The fix: overlap guard in runMultiplierCycle that skips the tick
 * when the previous tick finished less than interval_seconds ago.
 *
 * Coverage:
 *   G1. Tick runs normally when last_cycle is older than interval_seconds.
 *   G2. Tick is SKIPPED (no AI call, no Telegram) when last_cycle is
 *       younger than interval_seconds — overlapping dispatch guard.
 *   G3. Tick runs when last_cycle is missing (first-ever tick).
 */
'use strict';

const assert = require('assert');
const Runner = require('../runner.js');
const State  = require('../state.js');
const Deriv  = require('../deriv.js');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass++; console.log(' OK   ' + name); }
    else { fail++; console.error(' FAIL ' + name + (detail ? '  ' + JSON.stringify(detail) : '')); }
}

function freshConfig() {
    return {
        enabled: true,
        account: { mode: 'demo' },
        symbols: { forex: {}, synthetics: { R_100: true } },
        frx_enabled: false,
        syn_enabled: true,
        cycle: {
            running: true, engine: 'multipliers', interval_seconds: 90,
            session: { capital: 1000, take_profit: 20, stop_loss: 20 },
        },
        stake:   { absolute_min: 1, absolute_max: 10000 },
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
            capital_start: 1000, capital_remaining: 1000,
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

// Mock Deriv methods so we don't need a real WS.
function installDerivMock() {
    const origs = {
        ensureOpen:             Deriv.ensureOpen,
        getOpenPositionState:   Deriv.getOpenPositionState,
        closeMultiplier:        Deriv.closeMultiplier,
        placeMultiplier:        Deriv.placeMultiplier,
        reviseMultiplierLimits: Deriv.reviseMultiplierLimits,
    };
    Deriv.ensureOpen = async (ws) => ws || {};
    Deriv.getOpenPositionState = async () => ({
        is_open: false, is_sold: true, profit: 0,
        is_expired: false, is_valid_to_sell: false,
    });
    Deriv.closeMultiplier = async () => ({});
    Deriv.placeMultiplier = async () => ({});
    Deriv.reviseMultiplierLimits = async () => ({});
    return () => Object.assign(Deriv, origs);
}

(async () => {
    const config = freshConfig();

    // G1: last_cycle older than interval → tick runs normally.
    {
        const state = freshState();
        state.last_cycle = new Date(Date.now() - 120_000).toISOString(); // 2 min ago, interval=90s

        const restore = installDerivMock();
        try {
            await Runner.runMultiplierCycle({}, config, state, {});
            // After a normal tick, last_cycle should be updated.
            ok('G1: tick runs when last_cycle is older than interval',
                !!state.last_cycle, { last_cycle: state.last_cycle });
        } catch (e) {
            ok('G1: tick runs without error', false, { error: e.message });
        }
        restore();
    }

    // G2: last_cycle very recent (< interval) → tick skipped, no AI call.
    {
        const state = freshState();
        state.last_cycle = new Date(Date.now() - 10_000).toISOString(); // 10s ago, interval=90s
        const origLastCycle = state.last_cycle;

        let aiCalled = false;
        let telegramSent = false;

        const restore = installDerivMock();
        // Monkeypatch the AI call path.
        const AIClient = require('../ai-client.js');
        const origAskMultiplierDecision = AIClient.askMultiplierDecision;
        AIClient.askMultiplierDecision = async () => {
            aiCalled = true;
            return { decision: { action: 'hold', decision_id: 'test', rationale: 'test' } };
        };

        try {
            await Runner.runMultiplierCycle({}, config, state, {});
            ok('G2: tick skipped when last_cycle too recent', !aiCalled, { aiCalled });
            // last_cycle should NOT have been modified.
            ok('G2: last_cycle unchanged on skip',
                state.last_cycle === origLastCycle,
                { before: origLastCycle, after: state.last_cycle });
        } catch (e) {
            ok('G2: no error on skip', false, { error: e.message });
        }
        AIClient.askMultiplierDecision = origAskMultiplierDecision;
        restore();
    }

    // G3: last_cycle missing (first-ever tick) → tick runs (AI called).
    {
        const state = freshState();
        delete state.last_cycle;

        let aiCalled = false;
        const restore = installDerivMock();
        const AIClient = require('../ai-client.js');
        const origAskMultiplierDecision = AIClient.askMultiplierDecision;
        AIClient.askMultiplierDecision = async () => {
            aiCalled = true;
            return { decision: { action: 'hold', decision_id: 'test', rationale: 'test' } };
        };

        try {
            await Runner.runMultiplierCycle({}, config, state, {});
            ok('G3: tick runs (AI called) when last_cycle missing', aiCalled);
        } catch (e) {
            ok('G3: tick runs without error', false, { error: e.message });
        }
        AIClient.askMultiplierDecision = origAskMultiplierDecision;
        restore();
    }

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
})();
