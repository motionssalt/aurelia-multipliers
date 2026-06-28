/* scripts/smoke-tp-sl-ranges.js — v4 TP/SL range fix
 * ---------------------------------------------------------------
 * Verifies the v4 patch that makes Aurelia respect Deriv's live
 * validation_params.{take_profit, stop_loss, stake} ranges for
 * multiplier contracts, eliminating the
 *    "ContractBuyValidationError: Enter an amount equal to or lower than X"
 * OPEN FAILED class of error.
 *
 * The bug:
 *   User reported $10 stake / $23 TP / $22 SL on cryBTCUSD x300
 *   failing with "Enter an amount equal to or lower than 8.59".
 *   Previous code interpreted this as a stake cap and shrank stake
 *   proportionally — but the user verified on Deriv's main platform
 *   that the stake was fine. The 8.59 was the STOP LOSS max.
 *
 * The fix (three layers):
 *   Layer 1 (deriv.js):   read validation_params.{take_profit,stop_loss}
 *                         from each proposal; clamp limit_order into
 *                         the live ranges BEFORE the buy.
 *   Layer 2 (runner.js):  pre-flight probe (TP/SL-less proposal) per
 *                         multiplier so the AI sees the live ranges
 *                         in aiInput.tp_sl_ranges from the start.
 *   Layer 3 (ai-client.js): validate AI's open.{take_profit,stop_loss}
 *                         against the ranges with linear stake scaling;
 *                         soft-clamp out-of-range values + warn.
 */

'use strict';

const Deriv    = require('../deriv');
const AIClient = require('../ai-client');

let pass = 0, fail = 0;
function assert(cond, msg) {
    if (cond) { console.log(` OK   ${msg}`); pass++; }
    else      { console.log(` FAIL ${msg}`); fail++; }
}
function approx(a, b, eps) { return Math.abs(a - b) < (eps || 0.001); }

// -------- T1: _parseValidationParams ---------------------------------
console.log('\n--- T1: _parseValidationParams ---');
{
    const prop = {
        validation_params: {
            stake:       { min: '1.00', max: '100.00' },
            take_profit: { min: '0.10', max: '50.00'  },
            stop_loss:   { min: '0.51', max: '8.59'   },
        },
    };
    const vp = Deriv._parseValidationParams(prop);
    assert(vp && vp.stake && vp.stake.min === 1 && vp.stake.max === 100,        'T1.1 stake range parsed');
    assert(vp.take_profit.min === 0.10 && vp.take_profit.max === 50,            'T1.2 take_profit range parsed');
    assert(vp.stop_loss.min === 0.51   && vp.stop_loss.max   === 8.59,          'T1.3 stop_loss range parsed (string→Number)');
}
{
    // Absent validation_params block → null
    assert(Deriv._parseValidationParams({}) === null,                            'T1.4 absent vp returns null');
    assert(Deriv._parseValidationParams(null) === null,                          'T1.5 null prop returns null');
}
{
    // Only one sub-field present
    const vp = Deriv._parseValidationParams({
        validation_params: { take_profit: { max: '25.00' } },
    });
    assert(vp && vp.take_profit && vp.take_profit.max === 25 && vp.take_profit.min === null,
           'T1.6 partial validation_params: TP-only with max-only');
    assert(vp.stake === null && vp.stop_loss === null,                            'T1.7 missing sub-fields are null');
}
{
    // All sub-fields absent → null
    const vp = Deriv._parseValidationParams({ validation_params: { unrelated: {} } });
    assert(vp === null,                                                          'T1.8 unrelated vp keys return null');
}

// -------- T2: _clampToRange ------------------------------------------
console.log('\n--- T2: _clampToRange ---');
{
    // value above max → clamped down (with 2% safety inset)
    const r = { min: 0.51, max: 8.59 };
    const clamped = Deriv._clampToRange(22, r);
    // band = 8.08; inset = max(0.01, 0.02*8.08) = 0.16; hi = 8.59 - 0.16 = 8.43
    assert(clamped <= 8.43 && clamped > 8.0,                                     'T2.1 value 22 clamped down below max with inset (got ' + clamped + ')');
}
{
    // value below min → clamped up
    const r = { min: 5.0, max: 100.0 };
    const clamped = Deriv._clampToRange(1, r);
    assert(clamped >= 5.0 && clamped < 7.0,                                      'T2.2 value 1 clamped up to min+inset (got ' + clamped + ')');
}
{
    // value already inside → unchanged (modulo floor2)
    const r = { min: 1.0, max: 100.0 };
    const clamped = Deriv._clampToRange(50.0, r);
    assert(clamped === 50.0,                                                     'T2.3 in-range value passes through');
}
{
    // null range → unchanged
    assert(Deriv._clampToRange(42.5, null) === 42.5,                             'T2.4 null range = no clamp');
}
{
    // one-sided bound
    const clamped = Deriv._clampToRange(0.01, { min: 0.51, max: null });
    assert(clamped >= 0.51,                                                      'T2.5 only-min: low value clamped up');
}

// -------- T3: _applyTpSlRanges ---------------------------------------
console.log('\n--- T3: _applyTpSlRanges ---');
{
    // THE EXACT BUG SCENARIO: TP=23, SL=22 on a contract whose live SL max is 8.59.
    const limit_order = { take_profit: 23, stop_loss: 22 };
    const vp = {
        stake:       { min: 1, max: 100 },
        take_profit: { min: 0.10, max: 50.00 },
        stop_loss:   { min: 0.51, max: 8.59 },
    };
    const out = Deriv._applyTpSlRanges(limit_order, vp);
    assert(out.changed === true,                                                 'T3.1 changed=true when SL out of range');
    assert(out.adjustments.stop_loss && out.adjustments.stop_loss.from === 22,   'T3.2 SL adjustment recorded (from=22)');
    assert(out.limit_order.stop_loss < 8.59,                                     'T3.3 SL clamped below broker max 8.59');
    assert(out.limit_order.stop_loss > 8.0,                                      'T3.4 SL still close to broker max (safety inset, not crushed)');
    // TP=23 is BELOW its max of 50 → no change for TP
    assert(out.limit_order.take_profit === 23,                                   'T3.5 in-range TP untouched');
    assert(!out.adjustments.take_profit,                                         'T3.6 no TP adjustment recorded');
}
{
    // Both TP and SL out → both clamped
    const limit_order = { take_profit: 999, stop_loss: 999 };
    const vp = {
        take_profit: { min: 0.10, max: 50 },
        stop_loss:   { min: 0.51, max: 8.59 },
    };
    const out = Deriv._applyTpSlRanges(limit_order, vp);
    assert(out.changed,                                                          'T3.7 both-out → changed');
    assert(out.limit_order.take_profit < 50 && out.limit_order.stop_loss < 8.59, 'T3.8 both clamped under their max');
    assert(out.adjustments.take_profit && out.adjustments.stop_loss,             'T3.9 both adjustments recorded');
}
{
    // No validation_params → no change
    const limit_order = { take_profit: 23, stop_loss: 22 };
    const out = Deriv._applyTpSlRanges(limit_order, null);
    assert(!out.changed,                                                         'T3.10 no vp = no change');
    assert(out.limit_order === limit_order,                                      'T3.11 no vp = same object');
}
{
    // null TP/SL fields (the "clear" sentinel) → ignored
    const limit_order = { take_profit: null, stop_loss: 22 };
    const vp = { take_profit: { max: 50 }, stop_loss: { max: 8.59 } };
    const out = Deriv._applyTpSlRanges(limit_order, vp);
    assert(out.limit_order.take_profit === null,                                 'T3.12 null TP preserved (clear sentinel)');
    assert(out.limit_order.stop_loss < 8.59,                                     'T3.13 SL clamped while TP=null untouched');
}

// -------- T4: _extractMaxAmountFromError (renamed) -------------------
console.log('\n--- T4: _extractMaxAmountFromError ---');
{
    // The EXACT message from the user's failed run
    const msg = 'ContractBuyValidationError: Enter an amount equal to or lower than 8.59.';
    const n = Deriv._extractMaxAmountFromError(msg);
    assert(n === 8.59,                                                           'T4.1 extracts 8.59 from real error');
}
{
    // Backwards-compat alias
    const msg = 'Enter an amount equal to or lower than 19.40.';
    const n = Deriv._extractMaxStakeFromError(msg);
    assert(n === 19.40,                                                          'T4.2 _extractMaxStakeFromError alias works');
}
{
    // _isStakeCapError must catch profit/loss-flavoured wording too
    assert(Deriv._extractMaxAmountFromError('not a real error') === null,        'T4.3 unrelated msg returns null');
}

// -------- T5: AI validator soft-clamp (linear stake scaling) ---------
console.log('\n--- T5: ai-client soft-clamp ---');
{
    // Probe was at $1; AI picks $10 stake. The live TP cap at $1 is
    // $50, so at $10 the AI may go up to $500.
    const aiInput = {
        symbol:  'cryBTCUSD',
        tp_sl_ranges: {
            probe_stake: 1.0,
            by_multiplier: {
                '300': {
                    ranges: {
                        take_profit: { min: 0.10, max: 50.00 },
                        stop_loss:   { min: 0.51, max: 8.59 },
                    },
                },
            },
        },
    };
    const config = {};
    const raw = {
        action: 'open',
        decision_id: 't5',
        rationale: 'unit test of TP/SL soft-clamp',
        open: {
            direction: 'up',
            stake:       10,
            multiplier:  300,
            // SL=22 → at probe_stake $1 the SL cap is $8.59, scaled to
            // $10 stake = $85.90. So SL=22 is INSIDE the scaled range
            // → should NOT trigger soft-clamp.
            take_profit: 23,
            stop_loss:   22,
            siblings:    1,
        },
    };
    const v = AIClient.validateMultiplierDecision(raw, aiInput, config);
    assert(v.ok,                                                                 'T5.1 valid decision accepted');
    assert(v.decision.open.stop_loss === 22,                                     'T5.2 SL=22 inside scaled range ($85.90) → no clamp');
    assert(v.decision.open.take_profit === 23,                                   'T5.3 TP=23 inside scaled range ($500) → no clamp');
    assert(!v.warnings || v.warnings.length === 0,                               'T5.4 no warnings emitted');
}
{
    // Now AI picks stake=$10 but TP=$9999 (above scaled cap of $500).
    const aiInput = {
        symbol:  'cryBTCUSD',
        tp_sl_ranges: {
            probe_stake: 1.0,
            by_multiplier: {
                '300': {
                    ranges: {
                        take_profit: { min: 0.10, max: 50.00 },
                        stop_loss:   { min: 0.51, max: 8.59 },
                    },
                },
            },
        },
    };
    const raw = {
        action: 'open',
        decision_id: 't5b',
        rationale: 'TP out of scaled range',
        open: { direction: 'up', stake: 10, multiplier: 300, take_profit: 9999, stop_loss: 22, siblings: 1 },
    };
    const v = AIClient.validateMultiplierDecision(raw, aiInput, {});
    assert(v.ok,                                                                 'T5.5 accepted (soft-clamp, not reject)');
    assert(v.decision.open.take_profit < 500,                                    'T5.6 TP clamped below scaled max $500');
    assert(v.warnings && v.warnings.length >= 1,                                 'T5.7 warning emitted for clamped TP');
    assert(v.warnings[0].includes('take_profit'),                                'T5.8 warning mentions take_profit');
}
{
    // No tp_sl_ranges (probe failed) → no clamping, AI's values passed through verbatim.
    const aiInput = { symbol: 'cryBTCUSD', tp_sl_ranges: null };
    const raw = {
        action: 'open',
        decision_id: 't5c',
        rationale: 'probe absent path',
        open: { direction: 'up', stake: 10, multiplier: 300, take_profit: 9999, stop_loss: 22, siblings: 1 },
    };
    const v = AIClient.validateMultiplierDecision(raw, aiInput, {});
    assert(v.ok,                                                                 'T5.9 accepted with null tp_sl_ranges');
    assert(v.decision.open.take_profit === 9999,                                 'T5.10 no probe → TP passed through (broker layer will catch)');
    assert(!v.warnings || v.warnings.length === 0,                               'T5.11 no warnings when probe absent');
}

// -------- T6: Multiplier prompt includes ranges section --------------
console.log('\n--- T6: prompt rendering ---');
{
    const aiInput = {
        symbol:  'cryBTCUSD',
        balance: 100,
        currency:'USD',
        gates: { can_open_new: true, reason: null },
        open_siblings: [],
        just_closed: [],
        session: { active: true, capital_remaining: 100 },
        tp_sl_ranges: {
            probe_stake: 1.0,
            by_multiplier: {
                '300': {
                    ranges: {
                        take_profit: { min: 0.10, max: 50.00 },
                        stop_loss:   { min: 0.51, max: 8.59 },
                        stake:       { min: 1, max: 100 },
                    },
                },
            },
        },
    };
    const prompt = AIClient._buildMultiplierPrompt(aiInput, { ai: { min_confidence: 0 } });
    assert(prompt.includes('LIVE TP/SL ranges'),                                 'T6.1 prompt includes LIVE TP/SL ranges header');
    assert(prompt.includes('$8.59'),                                             'T6.2 prompt shows broker stop_loss max from probe');
    assert(prompt.includes('$50.00'),                                            'T6.3 prompt shows broker take_profit max');
    assert(prompt.includes('multiply each TP/SL bound by'),                      'T6.4 prompt includes scaling rule');
    assert(prompt.includes('ContractBuyValidationError'),                        'T6.5 prompt warns about the exact error wording');
}
{
    // No ranges → graceful fallback message
    const aiInput = {
        symbol:  'cryBTCUSD', balance: 100, currency: 'USD',
        gates: { can_open_new: true }, open_siblings: [], just_closed: [],
        session: { active: true, capital_remaining: 100 },
        tp_sl_ranges: null,
    };
    const prompt = AIClient._buildMultiplierPrompt(aiInput, { ai: { min_confidence: 0 } });
    assert(prompt.includes('not probed this tick'),                              'T6.6 absence rendered as fallback message');
    assert(prompt.includes('conservative defaults'),                             'T6.7 fallback tells AI what to do');
}

console.log('\n========================');
console.log(`  ${pass} passed, ${fail} failed`);
console.log('========================');
if (fail) process.exit(1);
