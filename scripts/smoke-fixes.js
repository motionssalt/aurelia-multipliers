/* scripts/smoke-fixes.js
 *
 * Offline verification harness for the four code-side fixes applied in
 * this patch:
 *   Fix 1: per-symbol multiplier lookup table
 *   Fix 2: placeTrade / placeMultiplier now use `underlying_symbol`
 *          under Deriv's unified proposal schema (2025+); the legacy
 *          `symbol` field is rejected as "Properties not allowed".
 *   Fix 3: defensive request guard strips unknown top-level fields
 *   Fix 5: rationale prompt now demands specific indicators
 *
 * Live verification (Fix 1 acceptance against Deriv API + Fix 4) is
 * separate and requires real account credentials.
 */
'use strict';
const assert = require('assert');
const AI = require('../ai-client');
const Deriv = require('../deriv');

let pass = 0, fail = 0;
function check(name, fn) {
    try { fn(); console.log(`  \u2713 ${name}`); pass++; }
    catch (e) { console.log(`  \u2717 ${name} \u2014 ${e.message}`); fail++; }
}

console.log('\n--- Fix 1: per-symbol multiplier lookup ---');
const expected = {
    R_10:    [400, 1000, 2000, 3000, 4000],
    R_25:    [160,  400,  800, 1200, 1600],
    R_50:    [ 80,  200,  400,  600,  800],
    R_75:    [ 50,  100,  200,  300,  500],
    R_100:   [ 40,  100,  200,  300,  400],
    '1HZ10V':  [400, 1000, 2000, 3000, 4000],
    '1HZ25V':  [160,  400,  800, 1200, 1600],
    '1HZ50V':  [ 80,  200,  400,  600,  800],
    '1HZ75V':  [ 50,  100,  200,  300,  500],
    '1HZ100V': [ 40,  100,  200,  300,  400],
    frxEURUSD: [100, 200, 300, 500, 800],
    cryBTCUSD: [100, 200, 300, 500, 800],
};
for (const [sym, want] of Object.entries(expected)) {
    check(`${sym} \u2192 ${want.join(',')}`, () => {
        const got = AI._validMultipliersFor(sym);
        assert.deepStrictEqual(got, want, `got=${JSON.stringify(got)}`);
    });
}
check('unknown symbol \u2192 falls back to category table', () => {
    const r = AI._validMultipliersFor('R_999'); // not in symbol table
    assert.deepStrictEqual(r, AI.MULTIPLIER_RANGE_BY_CATEGORY.synthetic);
});
check('totally unknown symbol \u2192 null', () => {
    const r = AI._validMultipliersFor('XYZNOPE');
    assert.strictEqual(r, null);
});

console.log('\n--- Fix 1: rejects out-of-range multiplier (regression guard) ---');
check('R_10 multiplier=300 (was valid under old synthetic table) is now REJECTED', () => {
    // Old synthetic table accepted 40,100,200,300,400 \u2014 so 300 was a
    // valid pick. Under the new per-symbol table R_10 only accepts
    // 400/1000/2000/3000/4000, so 300 must now fail validation.
    const aiInput = {
        symbol: 'R_10',
        cycle_id: 'smoke-test',
        session: { capital_remaining: 1000 },
        open_siblings: [],
        gates: { can_open_new: true, reason: 'ok' },
    };
    const raw = {
        action: 'open',
        decision_id: 'd1',
        rationale: 'test',
        confidence: 0.9,
        open: { direction: 'up', stake: 1, multiplier: 300,
                take_profit: null, stop_loss: null, siblings: 1 },
    };
    const out = AI.validateMultiplierDecision(raw, aiInput,
        { stake: { absolute_min: 1, absolute_max: 10000 } });
    assert.strictEqual(out.ok, false, 'expected validation failure');
    assert(out.errs.some(e => /multiplier 300 not in/i.test(e)),
        `errs did not mention multiplier rejection: ${JSON.stringify(out.errs)}`);
});
check('R_10 multiplier=1000 (valid under new table) is ACCEPTED', () => {
    const aiInput = {
        symbol: 'R_10',
        cycle_id: 'smoke-test',
        session: { capital_remaining: 1000 },
        open_siblings: [],
        gates: { can_open_new: true, reason: 'ok' },
    };
    const raw = {
        action: 'open',
        decision_id: 'd2',
        rationale: 'RSI 28, lower Bollinger Band, Hammer candle on 5m \u2014 mean revert long',
        confidence: 0.9,
        open: { direction: 'up', stake: 1, multiplier: 1000,
                take_profit: null, stop_loss: null, siblings: 1 },
    };
    const out = AI.validateMultiplierDecision(raw, aiInput,
        { stake: { absolute_min: 1, absolute_max: 10000 } });
    assert.strictEqual(out.ok, true,
        `expected validation pass, got errs=${JSON.stringify(out.errs)}`);
    assert.strictEqual(out.decision.open.multiplier, 1000);
});

console.log('\n--- Fix 2: placeTrade / placeMultiplier use `underlying_symbol` (unified Deriv schema, 2025+) ---');
check('deriv.js no longer SENDS top-level `symbol:` in proposal payloads', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'deriv.js'), 'utf8');
    // Strip out comments before scanning, so the historical-bug notes
    // documenting the fix do not trigger a false positive.
    const codeOnly = src
        .replace(/\/\*[\s\S]*?\*\//g, '')   // block comments
        .replace(/(^|[^:])\/\/.*$/gm, '$1'); // line comments (avoid http://)
    // Look at each block that contains `proposal: 1` (a proposal payload
    // literal) and assert it does NOT also carry a bare `symbol:` or the
    // shorthand `symbol,` key. We scan a small window after each
    // `proposal: 1` so we don't accidentally flag unrelated `symbol`
    // usages elsewhere in deriv.js (Logger metadata, getOpenPositionState
    // return objects, function parameters, etc.).
    const re = /proposal\s*:\s*1[\s\S]{0,800}?\}/g;
    let m;
    while ((m = re.exec(codeOnly)) !== null) {
        const block = m[0];
        const bad = /[{,]\s*symbol\s*[:,]/.test(block);
        assert(!bad,
            'deriv.js still has a proposal payload that includes top-level `symbol`. ' +
            'Deriv\u2019s unified schema rejects it with "Properties not allowed: symbol". ' +
            'Offending block:\n' + block.slice(0, 300));
    }
});
check('deriv.js DOES send `underlying_symbol` (the unified-schema field)', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'deriv.js'), 'utf8');
    const codeOnly = src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
    assert(/underlying_symbol\s*:/.test(codeOnly),
        'deriv.js no longer sends underlying_symbol in any proposal payload');
});

console.log('\n--- Fix 3: defensive request guard ---');
check('guard strips the LEGACY `symbol` field on a proposal request', () => {
    // Under the unified Deriv schema, `symbol` at the top level of a
    // proposal is rejected with "Properties not allowed: symbol". The
    // guard MUST strip it so any stray call-site cannot poison a trade.
    const out = Deriv._guardSensitiveRequest({
        proposal: 1, amount: 1, basis: 'stake', contract_type: 'CALL',
        currency: 'USD', duration: 15, duration_unit: 'm',
        underlying_symbol: 'R_10',  // ← the correct field, must survive
        symbol: 'R_10',             // ← legacy field, must be stripped
    });
    assert(!('symbol' in out), 'legacy `symbol` survived on proposal request');
    assert.strictEqual(out.underlying_symbol, 'R_10');
});
check('guard strips symbol on a buy request', () => {
    const out = Deriv._guardSensitiveRequest({
        buy: 'abc-prop-id', price: 1.0,
        symbol: 'R_10',                     // \u2190 not allowed on buy
    });
    assert(!('symbol' in out));
    assert.strictEqual(out.buy, 'abc-prop-id');
});
check('guard strips symbol on a sell request', () => {
    const out = Deriv._guardSensitiveRequest({ sell: 999, price: 0, symbol: 'R_10' });
    assert(!('symbol' in out));
});
check('guard strips symbol on contract_update', () => {
    const out = Deriv._guardSensitiveRequest({
        contract_update: 1, contract_id: 42,
        limit_order: { take_profit: 5 },
        symbol: 'R_10',
    });
    assert(!('symbol' in out));
});
check('guard strips symbol on proposal_open_contract', () => {
    const out = Deriv._guardSensitiveRequest({
        proposal_open_contract: 1, contract_id: 42, symbol: 'R_10',
    });
    assert(!('symbol' in out));
});
check('guard passes through non-sensitive requests unchanged', () => {
    const original = { ticks_history: 'R_10', end: 'latest', count: 50, style: 'candles' };
    const out = Deriv._guardSensitiveRequest(original);
    assert.deepStrictEqual(out, original);
});
check('guard preserves all legitimate proposal fields', () => {
    const input = {
        proposal: 1, amount: 1, basis: 'stake', contract_type: 'MULTUP',
        currency: 'USD', underlying_symbol: 'R_10', multiplier: 1000,
        limit_order: { take_profit: 2, stop_loss: 5 },
    };
    const out = Deriv._guardSensitiveRequest(input);
    assert.deepStrictEqual(out, input);
});

console.log('\n--- Fix 5: rationale prompt now demands specific indicators ---');
check('prompt contains RATIONALE QUALITY section', () => {
    const prompt = AI._buildMultiplierPrompt(
        { symbol: 'R_10', cycle_id: 'x', session: {}, open_siblings: [], gates: {} },
        { stake: { absolute_min: 1, absolute_max: 10000 } });
    assert(/RATIONALE QUALITY/.test(prompt), 'RATIONALE QUALITY section missing');
    assert(/Bollinger Band/.test(prompt), 'No mention of Bollinger Bands');
    assert(/Morning Star|Bullish Engulfing|Hammer/.test(prompt),
        'Style-reference candle patterns missing');
    assert(/1HZ25V \u2022 CALL \u2022 15 USD \u2022 30m/.test(prompt),
        'Style reference example missing');
    assert(/initiating a new MULTUP trade/.test(prompt),
        'BAD-example block missing (must explicitly warn against generic phrasing)');
});

console.log(`\nResults: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
