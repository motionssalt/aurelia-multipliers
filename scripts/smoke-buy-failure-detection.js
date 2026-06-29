/**
 * Smoke: end-to-end check of the buy-failure-detection bugfix.
 *
 * Three layers being asserted:
 *
 *   1. Validator (`validateMultiplierDecision`) refuses to ship a
 *      proposal with a multiplier value that Deriv would reject for
 *      the active symbol's category. Specifically: cryBTCUSD with
 *      multiplier=50 should NOT be allowed through.
 *
 *   2. Telegram template (`multiplierTickSummary`) renders a clearly
 *      FAILED header + per-sibling error lines when executed.details
 *      shows every attempted sibling errored. The pre-fix template
 *      would silently print "🆕 OPEN" with the (rejected) spec.
 *
 *   3. Validator still accepts a valid multiplier in the per-category
 *      set, and the template still renders a clean success message
 *      with the resulting contract_id(s).
 */
const assert  = require('assert');
const AIClient = require('../ai-client');
const TG       = require('../telegram');

let passed = 0, failed = 0;
function check(name, fn) {
    try { fn(); console.log(' OK  ', name); passed++; }
    catch (e) { console.log(' FAIL', name, '\n   ', e.message); failed++; }
}

/* -- 1. Validator-side: cryBTCUSD + multiplier=50 must be rejected -- */
check('validator rejects multiplier=50 on cryBTCUSD (out of Deriv set)', () => {
    const aiInput = {
        symbol: 'cryBTCUSD',
        cycle_id: 'test',
        open_siblings: [],
        gates: { can_open_new: true, reason: null },
        session: { capital_remaining: 1000 },
    };
    const config = {
        stake: { absolute_min: 1, absolute_max: 10000 },
        ai:    { min_confidence: 0 },
    };
    const raw = {
        action:      'open',
        decision_id: 'd1',
        rationale:   't',
        open: {
            direction:  'up',
            stake:      5,
            multiplier: 50,        // invalid for cry*
            take_profit: 10,
            stop_loss:   5,
            siblings:    1,
        },
    };
    const r = AIClient.validateMultiplierDecision(raw, aiInput, config);
    assert.strictEqual(r.ok, false, 'expected ok=false for invalid mult');
    assert.strictEqual(r.decision.action, 'hold', 'expected hold-fallback');
    assert.ok(r.errs.some(e => /not in Deriv's accepted set/.test(e)),
        'expected error mentioning Deriv accepted set, got ' + JSON.stringify(r.errs));
});

check('validator rejects multiplier=75 on cryBTCUSD', () => {
    const aiInput = {
        symbol: 'cryBTCUSD',
        cycle_id: 'test',
        open_siblings: [],
        gates: { can_open_new: true, reason: null },
        session: { capital_remaining: 1000 },
    };
    const config = {
        stake: { absolute_min: 1, absolute_max: 10000 },
        ai:    { min_confidence: 0 },
    };
    const r = AIClient.validateMultiplierDecision({
        action: 'open', decision_id: 'd', rationale: 't',
        open: { direction:'down', stake:5, multiplier:75, take_profit:5, stop_loss:5, siblings:1 },
    }, aiInput, config);
    assert.strictEqual(r.ok, false);
});

check('validator ACCEPTS multiplier=100 on cryBTCUSD (in Deriv set)', () => {
    const aiInput = {
        symbol: 'cryBTCUSD',
        cycle_id: 'test',
        open_siblings: [],
        gates: { can_open_new: true, reason: null },
        session: { capital_remaining: 1000 },
    };
    const config = {
        stake: { absolute_min: 1, absolute_max: 10000 },
        ai:    { min_confidence: 0 },
    };
    const r = AIClient.validateMultiplierDecision({
        action: 'open', decision_id: 'd', rationale: 't',
        open: { direction:'up', stake:5, multiplier:100, take_profit:5, stop_loss:5, siblings:1 },
    }, aiInput, config);
    assert.strictEqual(r.ok, true, 'expected ok=true: errs=' + JSON.stringify(r.errs));
    assert.strictEqual(r.decision.action, 'open');
});

check('validator rejects multiplier=400 on cryBTCUSD (400 is synthetic-only)', () => {
    const aiInput = {
        symbol: 'cryBTCUSD',
        cycle_id: 'test',
        open_siblings: [],
        gates: { can_open_new: true, reason: null },
        session: { capital_remaining: 1000 },
    };
    const config = {
        stake: { absolute_min: 1, absolute_max: 10000 },
        ai:    { min_confidence: 0 },
    };
    const r = AIClient.validateMultiplierDecision({
        action: 'open', decision_id: 'd', rationale: 't',
        open: { direction:'up', stake:5, multiplier:400, take_profit:5, stop_loss:5, siblings:1 },
    }, aiInput, config);
    assert.strictEqual(r.ok, false, 'expected reject: 400 is not in crypto set [100,200,300,500,800]');
});

check('validator ACCEPTS multiplier=40 on R_100 (synthetic-only value)', () => {
    const aiInput = {
        symbol: 'R_100',
        cycle_id: 'test',
        open_siblings: [],
        gates: { can_open_new: true, reason: null },
        session: { capital_remaining: 1000 },
    };
    const config = {
        stake: { absolute_min: 1, absolute_max: 10000 },
        ai:    { min_confidence: 0 },
    };
    const r = AIClient.validateMultiplierDecision({
        action: 'open', decision_id: 'd', rationale: 't',
        open: { direction:'up', stake:5, multiplier:40, take_profit:5, stop_loss:5, siblings:1 },
    }, aiInput, config);
    assert.strictEqual(r.ok, true, 'errs=' + JSON.stringify(r.errs));
});

/* -- 2. Telegram template surfaces failure honestly -- */
check('multiplierTickSummary shows OPEN FAILED + reason when buy was rejected', () => {
    const msg = TG.templates.multiplierTickSummary({
        symbol: 'cryBTCUSD',
        mode:   'demo',
        cycleId:'c1',
        decision: {
            action: 'open',
            decision_id: 'd-bad',
            rationale: 'AI tried a bad multiplier',
            open: { direction: 'up', stake: 5, multiplier: 50, take_profit: 10, stop_loss: 5, siblings: 1 },
        },
        executed: {
            action: 'open',
            details: [{
                error: 'ContractBuyValidationError: Multiplier is not in acceptable range. Accepts 100,200,300,500,800.',
            }],
        },
        justClosed: [],
        openSiblings: [],
        preActionSiblings: [],
        exposure: {},
        session: { active: true, pnl: 0, capital_remaining: 1000 },
        balance: 1000, currency: 'USD',
    });
    assert.ok(/OPEN FAILED/.test(msg), 'header should say OPEN FAILED, got:\n' + msg);
    assert.ok(/Trade attempt failed/.test(msg), 'body should mention failure');
    assert.ok(/Multiplier is not in acceptable range/.test(msg), 'should surface Deriv error text');
    assert.ok(!/\ud83c\udd95 <b>OPEN<\/b>/.test(msg), 'must NOT show celebratory 🆕 OPEN');
});

check('multiplierTickSummary shows OPEN + contract_id when buy succeeded', () => {
    const msg = TG.templates.multiplierTickSummary({
        symbol: 'cryBTCUSD',
        mode:   'demo',
        cycleId:'c1',
        decision: {
            action: 'open',
            decision_id: 'd-good',
            rationale: 'thesis x',
            open: { direction: 'up', stake: 5, multiplier: 100, take_profit: 10, stop_loss: 5, siblings: 1 },
        },
        executed: {
            action: 'open',
            details: [{ contract_id: 'C12345' }],
        },
        justClosed: [],
        openSiblings: [{
            contract_id: 'C12345', direction: 'up', multiplier: 100,
            stake: 5, floating_pnl: 0, take_profit: 10, stop_loss: 5,
        }],
        preActionSiblings: [],
        exposure: { positions: 1, total_stake: 5, total_floating_pnl: 0 },
        session: { active: true, pnl: 0, capital_remaining: 995 },
        balance: 995, currency: 'USD',
    });
    assert.ok(/\ud83c\udd95.*OPEN/.test(msg), 'should show 🆕 OPEN');
    assert.ok(/Opened.*C12345/.test(msg), 'should list opened contract_id');
    assert.ok(!/OPEN FAILED/.test(msg), 'must not say OPEN FAILED');
    assert.ok(!/Trade attempt failed/.test(msg), 'must not say attempt failed');
});

check('multiplierTickSummary shows MIXED outcome when some siblings opened and others failed', () => {
    const msg = TG.templates.multiplierTickSummary({
        symbol: 'cryBTCUSD',
        mode:   'demo',
        cycleId:'c1',
        decision: {
            action: 'open',
            decision_id: 'd-mix',
            rationale: 'tried 3, last one ran out of capital',
            open: { direction: 'up', stake: 5, multiplier: 100, take_profit: 10, stop_loss: 5, siblings: 3 },
        },
        executed: {
            action: 'open',
            details: [
                { contract_id: 'C1' },
                { contract_id: 'C2' },
                { error: 'stake clamped to zero — capital exhausted' },
            ],
        },
        justClosed: [],
        openSiblings: [],
        preActionSiblings: [],
        exposure: {},
        session: { active: true, pnl: 0, capital_remaining: 0 },
        balance: 990, currency: 'USD',
    });
    // Header still positive (some succeeded), but body lists the failure
    assert.ok(/\ud83c\udd95.*OPEN/.test(msg), 'header should remain OPEN (had partial success)');
    assert.ok(/Opened.*C1.*C2/.test(msg), 'should list both contract_ids');
    assert.ok(/Trade attempt failed/.test(msg), 'should also list the failed attempt');
    assert.ok(/capital exhausted/.test(msg), 'should surface the failure reason');
});

console.log(`\n========================\n  ${passed} passed, ${failed} failed\n========================`);
process.exit(failed ? 1 : 0);
