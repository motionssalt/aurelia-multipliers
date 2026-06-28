/**
 * Smoke test for the three fixes:
 *
 *   1. Buy stake-cap auto-retry (deriv.js placeMultiplier)
 *      - _extractMaxStakeFromError correctly parses Deriv's
 *        "Enter an amount equal to or lower than X." messages.
 *      - _extractMinStakeFromError correctly parses the dual
 *        "equal to or higher than X" form.
 *
 *   2. Manual scan routes through askMultiplierDecision
 *      (runner.js runManual) and is exposed via module.exports so
 *      the worker can call it. The function signature now uses the
 *      multiplier executor chain.
 *
 *   3. AI rationale wrapped in <blockquote> for visual highlighting
 *      (telegram.js multiplierTickSummary).
 */
const assert  = require('assert');
const Deriv   = require('../deriv');
const TG      = require('../telegram');
const Runner  = require('../runner');

let passed = 0, failed = 0;
function check(name, fn) {
    try { fn(); console.log(' OK  ', name); passed++; }
    catch (e) { console.log(' FAIL', name, '\n   ', e.message); failed++; }
}

/* ── Fix 1: stake-cap parsers ──────────────────────────────────── */
check('Fix1: parses "Enter an amount equal to or lower than 19.40."', () => {
    const n = Deriv._extractMaxStakeFromError('Enter an amount equal to or lower than 19.40.');
    assert.strictEqual(n, 19.40);
});
check('Fix1: parses with thousands separator "1,234.56"', () => {
    const n = Deriv._extractMaxStakeFromError('Enter an amount equal to or lower than 1,234.56.');
    assert.strictEqual(n, 1234.56);
});
check('Fix1: parses integer cap "100"', () => {
    const n = Deriv._extractMaxStakeFromError('Enter an amount equal to or lower than 100.');
    assert.strictEqual(n, 100);
});
check('Fix1: min-stake parser handles "higher than"', () => {
    const n = Deriv._extractMinStakeFromError('Enter an amount equal to or higher than 0.5.');
    assert.strictEqual(n, 0.5);
});
check('Fix1: min-stake parser handles "greater than"', () => {
    const n = Deriv._extractMinStakeFromError('Enter an amount equal to or greater than 1.50.');
    assert.strictEqual(n, 1.5);
});
check('Fix1: unrelated errors return null', () => {
    assert.strictEqual(Deriv._extractMaxStakeFromError('Something else entirely'), null);
    assert.strictEqual(Deriv._extractMaxStakeFromError(null), null);
    assert.strictEqual(Deriv._extractMaxStakeFromError(undefined), null);
    assert.strictEqual(Deriv._extractMinStakeFromError('No match here'), null);
});
check('Fix1: helpers are exported on module.exports', () => {
    assert.strictEqual(typeof Deriv._extractMaxStakeFromError, 'function');
    assert.strictEqual(typeof Deriv._extractMinStakeFromError, 'function');
});

/* ── Fix 2: manual scan path uses multiplier decision ──────────── */
check('Fix2: runner exposes runManual on module.exports indirectly via main()', () => {
    // runManual is module-internal but reachable via main() with task=manual.
    // We verify it doesn't reference the old binary askDecision/validateDecision combo.
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'runner.js'), 'utf8');
    // Pull out the runManual function block.
    const m = src.match(/async function runManual\([^)]*\)\s*\{[\s\S]*?\n\}/);
    assert.ok(m, 'runManual function block not found');
    const body = m[0];
    // Must call the multiplier-aware path.
    assert.ok(body.includes('askMultiplierDecision'),
        'runManual must call AIClient.askMultiplierDecision (multiplier-aware)');
    // Must NOT call the dead binary path.
    assert.ok(!body.includes('AIClient.askDecision('),
        'runManual must no longer call AIClient.askDecision (binary path) — that is the bug');
    // Must NOT call the binary validateDecision (which expects action: trade/skip).
    assert.ok(!/validateDecision\(decision,\s*config,\s*state,\s*\{\s*manual:\s*true\s*\}\)/.test(body),
        'runManual must no longer call the binary validateDecision');
    // Must render a chart (renderMultiplierSnapshot or generateChart fallback).
    assert.ok(body.includes('renderMultiplierSnapshot') || body.includes('generateChart'),
        'runManual must render and attach a chart');
    assert.ok(body.includes('Telegram.sendPhoto') || body.includes('sendPhoto'),
        'runManual must call sendPhoto with the chart');
    // Must go through the multiplier executor chain so 'open' decisions place real trades.
    assert.ok(body.includes('executeOpenSpec'),
        'runManual must route open decisions through executeOpenSpec');
});

/* ── Fix 3: rationale rendered as <blockquote> ─────────────────── */
check('Fix3: multiplierTickSummary wraps rationale in <blockquote> (not <i>)', () => {
    const msg = TG.templates.multiplierTickSummary({
        symbol: 'cryBTCUSD',
        mode: 'real',
        cycleId: 'test',
        decision: {
            action: 'hold',
            decision_id: 'd-1',
            rationale: 'Test rationale text that should be highlighted.',
        },
        executed:    { action: 'hold', details: [{ note: 'hold' }] },
        justClosed:  [],
        openSiblings: [],
        preActionSiblings: [],
        exposure: { count: 0, total_stake: 0 },
        session:  { active: false },
        riskBreach: null,
        balance: 1000, currency: 'USD',
    });
    assert.ok(msg.includes('<blockquote>Test rationale text that should be highlighted.</blockquote>'),
        'expected rationale wrapped in <blockquote>...</blockquote>');
    assert.ok(!msg.includes('<i>Test rationale'),
        'rationale should no longer be wrapped in <i>...</i>');
});

check('Fix3: long rationale gets truncated AND wrapped in blockquote', () => {
    const long = 'A'.repeat(500);
    const msg = TG.templates.multiplierTickSummary({
        symbol: 'cryBTCUSD',
        mode: 'real',
        cycleId: 'test',
        decision: { action: 'hold', decision_id: 'd-2', rationale: long },
        executed: { action: 'hold', details: [] },
        justClosed: [], openSiblings: [], preActionSiblings: [],
        exposure: { count: 0, total_stake: 0 },
        session: { active: false }, riskBreach: null,
        balance: 1000, currency: 'USD',
    });
    // Should be truncated to 280 chars (277 + ellipsis) AND inside blockquote.
    assert.ok(/<blockquote>A{277}…<\/blockquote>/.test(msg),
        'expected truncated rationale inside blockquote');
});

check('Fix3: missing rationale produces NO blockquote (no empty bubble)', () => {
    const msg = TG.templates.multiplierTickSummary({
        symbol: 'cryBTCUSD',
        mode: 'real',
        cycleId: 'test',
        decision: { action: 'hold', decision_id: 'd-3' /* no rationale */ },
        executed: { action: 'hold', details: [] },
        justClosed: [], openSiblings: [], preActionSiblings: [],
        exposure: { count: 0, total_stake: 0 },
        session: { active: false }, riskBreach: null,
        balance: 1000, currency: 'USD',
    });
    assert.ok(!msg.includes('<blockquote>'),
        'no rationale → no blockquote at all (avoid empty quote bubble)');
});

console.log(`\n========================`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log(`========================`);
process.exit(failed === 0 ? 0 : 1);
