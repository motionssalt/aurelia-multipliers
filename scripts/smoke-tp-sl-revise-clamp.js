#!/usr/bin/env node
/* smoke-tp-sl-revise-clamp.js
 *
 * Issue #4: Revised TP/SL gets silently rejected by Deriv, but the bot
 * reports success. The fix: clamp TP/SL to broker's live range before
 * contract_update, mirroring the pattern used for opens.
 *
 * Coverage:
 *   C1. Revise TP outside live range → clamped, contract_update succeeds
 *       with clamped value; clamp metadata is returned.
 *   C2. Revise inside live range → passes through unchanged.
 *   C3. Revise that still fails after clamping (e.g. contract closed
 *       server-side) is reported as a failure, not a false success.
 *   C4. executeReviseList records actual post-clamp values in state.
 */
'use strict';

const assert = require('assert');
const Deriv  = require('../deriv.js');
const State  = require('../state.js');
const Runner = require('../runner.js');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass++; console.log(' OK   ' + name); }
    else { fail++; console.error(' FAIL ' + name + (detail ? '  ' + JSON.stringify(detail) : '')); }
}

const origProbeMultiplierRanges = Deriv.probeMultiplierRanges;

// Build a WS mock that satisfies Deriv.request() internals.
function makeMockWs(scenario = 'success') {
    const ws = {
        readyState: 1, // OPEN
        __pending: new Map(),
        __reqId: 1,
        send: function(msg) {
            const data = JSON.parse(msg);
            const id = data.req_id;
            setTimeout(() => {
                const entry = ws.__pending.get(id);
                if (!entry) return;
                ws.__pending.delete(id);
                clearTimeout(entry.timer);
                if (data.proposal_open_contract) {
                    entry.resolve({
                        req_id: id,
                        proposal_open_contract: {
                            contract_id: data.contract_id,
                            underlying: 'R_100',
                            contract_type: 'MULTUP',
                            buy_price: '5.00',
                            multiplier: '100',
                        },
                    });
                } else if (data.proposal) {
                    entry.resolve({
                        req_id: id,
                        proposal: {
                            validation_params: {
                                take_profit: { min: '0.50', max: '50.00' },
                                stop_loss:   { min: '0.50', max: '30.00' },
                            },
                            spot: '1000.00',
                            ask_price: '5.00',
                        },
                    });
                } else if (data.contract_update) {
                    if (scenario === 'fail') {
                        entry.reject(new Error('Contract already closed'));
                    } else {
                        entry.resolve({
                            req_id: id,
                            contract_update: {
                                contract_id: data.contract_id,
                                take_profit: data.limit_order.take_profit != null
                                    ? { order_amount: String(data.limit_order.take_profit) } : undefined,
                                stop_loss: data.limit_order.stop_loss != null
                                    ? { order_amount: String(data.limit_order.stop_loss) } : undefined,
                            },
                        });
                    }
                }
            }, 0);
        },
        on: function() {},
        removeAllListeners: function() {},
    };
    return ws;
}

(async () => {
    // C1: TP outside range → clamped.
    {
        Deriv.probeMultiplierRanges = async () => ({
            ranges: {
                take_profit: { min: 0.50, max: 50 },
                stop_loss:   { min: 0.50, max: 30 },
            },
            spot: 1000,
            ask_price: 5,
        });

        const ws = makeMockWs('success');
        const result = await Deriv.reviseMultiplierLimits(ws, 12345, { takeProfit: 200 }, 'USD');

        ok('C1: returned result', !!result);
        ok('C1: tp_sl_clamped is true', result.tp_sl_clamped === true);
        ok('C1: adjustments recorded',
            result.tp_sl_adjustments && result.tp_sl_adjustments.take_profit,
            { adjustments: result.tp_sl_adjustments });
        ok('C1: TP clamped from 200 to <= 50',
            result.tp_sl_adjustments && result.tp_sl_adjustments.take_profit && result.tp_sl_adjustments.take_profit.to <= 50,
            { adj: result.tp_sl_adjustments });
    }

    // C2: TP inside range → passes through unchanged.
    {
        Deriv.probeMultiplierRanges = async () => ({
            ranges: {
                take_profit: { min: 0.50, max: 50 },
                stop_loss:   { min: 0.50, max: 30 },
            },
            spot: 1000,
            ask_price: 5,
        });

        const ws = makeMockWs('success');
        const result = await Deriv.reviseMultiplierLimits(ws, 12345, { takeProfit: 25 }, 'USD');

        ok('C2: tp_sl_clamped is false', result.tp_sl_clamped !== true);
        ok('C2: no adjustments',
            !result.tp_sl_adjustments || !result.tp_sl_adjustments.take_profit);
    }

    // C3: contract_update fails → error thrown.
    {
        Deriv.probeMultiplierRanges = async () => ({
            ranges: {
                take_profit: { min: 0.50, max: 50 },
                stop_loss:   { min: 0.50, max: 30 },
            },
            spot: 1000,
            ask_price: 5,
        });

        const ws = makeMockWs('fail');
        try {
            await Deriv.reviseMultiplierLimits(ws, 12345, { takeProfit: 200 }, 'USD');
            ok('C3: should have thrown', false);
        } catch (e) {
            ok('C3: error thrown', true, { error: e.message });
        }
    }

    // C4: executeReviseList records post-clamp values in state.
    {
        Deriv.probeMultiplierRanges = async () => ({
            ranges: {
                take_profit: { min: 0.50, max: 50 },
                stop_loss:   { min: 0.50, max: 30 },
            },
            spot: 1000,
            ask_price: 5,
        });

        const ws = makeMockWs('success');
        const state = {
            cycle_open_siblings: {
                R_100: [{ contract_id: 12345, take_profit: 10, stop_loss: 5 }],
            },
            currency: 'USD',
        };

        const out = await Runner.executeReviseList(ws, state, 'R_100', [
            { contract_id: 12345, take_profit: 200 },
        ]);

        ok('C4: one result', out.length === 1);
        ok('C4: clamp metadata present', out[0].tp_sl_clamped === true);
        ok('C4: state has clamped value',
            state.cycle_open_siblings.R_100[0].take_profit <= 50 && state.cycle_open_siblings.R_100[0].take_profit !== 200,
            { sibling: state.cycle_open_siblings.R_100[0] });
    }

    // Restore.
    Deriv.probeMultiplierRanges = origProbeMultiplierRanges;

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
})();
