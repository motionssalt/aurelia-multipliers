/* =====================================================================
   smoke-revision-history.js
   ---------------------------------------------------------------------
   Verifies the per-sibling TP/SL revision audit log added to
   aurelia-multipliers:

     1. makeSiblingRecord() initializes revision_history = [].
     2. appendRevisionAttempt() appends entries with all four outcomes
        and FIFO-caps the history at MAX_REVISION_HISTORY.
     3. The history surfaces in the AI prompt via
        _renderRevisionHistoryForPrompt(), and is non-null only when
        at least one sibling has at least one attempt.
     4. The DECISION GUIDANCE block in _buildMultiplierPrompt mentions
        revision_history explicitly (regression guard so future prompt
        edits don't accidentally drop the guidance).

   Run with:  node scripts/smoke-revision-history.js
   Exits 0 on success, 1 on any failure (suitable for CI).
   ===================================================================== */
'use strict';

const assert   = require('assert');
const State    = require('../state');
const AIClient = require('../ai-client');

function header(label) { console.log('\n=== ' + label + ' ==='); }
function ok(label)     { console.log('  \u2713 ' + label); }

let failed = 0;
function check(label, fn) {
    try { fn(); ok(label); }
    catch (e) { failed++; console.error('  \u2717 ' + label + '\n    ' + e.message); }
}

/* -------------------------------------------------------------------
   1. makeSiblingRecord initializes revision_history to []
   ------------------------------------------------------------------- */
header('makeSiblingRecord initializes revision_history');

const rec = State.makeSiblingRecord({
    contract_id: 111,
    stake:       12.5,
    multiplier:  100,
    direction:   'up',
});
check('revision_history present and []', () => {
    assert.ok(Array.isArray(rec.revision_history), 'should be an array');
    assert.strictEqual(rec.revision_history.length, 0, 'should start empty');
});

/* -------------------------------------------------------------------
   2. appendRevisionAttempt with all four outcomes
   ------------------------------------------------------------------- */
header('appendRevisionAttempt records all outcomes');

const state = { currency: 'USD' };
State.addSiblingPosition(state, 'R_100', rec);

const okEntry = State.appendRevisionAttempt(state, 'R_100', 111, {
    outcome:   'ok',
    requested: { take_profit: 6.25 },
    applied:   { take_profit: 6.25 },
});
check('ok-outcome entry shape', () => {
    assert.strictEqual(okEntry.outcome, 'ok');
    assert.deepStrictEqual(okEntry.requested, { take_profit: 6.25 });
    assert.deepStrictEqual(okEntry.applied,   { take_profit: 6.25 });
    assert.ok(typeof okEntry.ts === 'string');
});

State.appendRevisionAttempt(state, 'R_100', 111, {
    outcome:           'clamped',
    requested:         { stop_loss: 1.00 },
    applied:           { stop_loss: 4.00 },
    clamp_adjustments: { stop_loss: { reason: 'below_min', min: 4.00 } },
});
State.appendRevisionAttempt(state, 'R_100', 111, {
    outcome:   'failed',
    requested: { stop_loss: 1.00 },
    error:     'Enter an amount equal to or lower than 8.59.',
});
State.appendRevisionAttempt(state, 'R_100', 111, {
    outcome:   'reverted',
    requested: { stop_loss: 4.00 },
    applied:   { stop_loss: 6.25 },
    error:     'broker-side TP/SL diverged between ticks',
});

check('history now has 4 entries with distinct outcomes', () => {
    const h = state.cycle_open_siblings.R_100[0].revision_history;
    assert.strictEqual(h.length, 4);
    assert.deepStrictEqual(h.map(e => e.outcome), ['ok', 'clamped', 'failed', 'reverted']);
});

check('invalid outcome throws', () => {
    let threw = false;
    try {
        State.appendRevisionAttempt(state, 'R_100', 111, { outcome: 'nope', requested: {} });
    } catch (e) { threw = true; }
    assert.ok(threw, 'expected an error for unknown outcome');
});

check('append on missing sibling returns null (does not throw)', () => {
    const result = State.appendRevisionAttempt(state, 'R_100', 999, {
        outcome: 'ok', requested: { take_profit: 1 },
    });
    assert.strictEqual(result, null);
});

/* -------------------------------------------------------------------
   3. FIFO cap at MAX_REVISION_HISTORY
   ------------------------------------------------------------------- */
header('FIFO cap kicks in past MAX_REVISION_HISTORY');

const CAP = State.MAX_REVISION_HISTORY;
const state2 = {};
const rec2 = State.makeSiblingRecord({
    contract_id: 222, stake: 10, multiplier: 100, direction: 'down',
});
State.addSiblingPosition(state2, 'R_100', rec2);
for (let i = 0; i < CAP + 5; i++) {
    State.appendRevisionAttempt(state2, 'R_100', 222, {
        outcome:   'ok',
        requested: { take_profit: i },
    });
}
check('length is capped at MAX_REVISION_HISTORY', () => {
    const h = state2.cycle_open_siblings.R_100[0].revision_history;
    assert.strictEqual(h.length, CAP);
});
check('oldest entries dropped FIFO (entry 0 is requested.take_profit=5)', () => {
    const h = state2.cycle_open_siblings.R_100[0].revision_history;
    assert.strictEqual(h[0].requested.take_profit, 5,
        'should have dropped attempts 0..4 to leave 5..(CAP+4)');
    assert.strictEqual(h[h.length - 1].requested.take_profit, CAP + 4);
});

/* -------------------------------------------------------------------
   4. _renderRevisionHistoryForPrompt surfaces entries
   ------------------------------------------------------------------- */
header('_renderRevisionHistoryForPrompt renders entries');

const aiInputEmpty = { open_siblings: [] };
check('returns null when no siblings', () => {
    const r = AIClient._renderRevisionHistoryForPrompt(aiInputEmpty);
    assert.strictEqual(r, null);
});

const aiInputNoHist = {
    open_siblings: [
        { contract_id: 1, direction: 'up', multiplier: 100, stake: 10, revision_history: [] },
    ],
};
check('returns null when no sibling has any history', () => {
    const r = AIClient._renderRevisionHistoryForPrompt(aiInputNoHist);
    assert.strictEqual(r, null);
});

const aiInputWithHist = {
    open_siblings: [{
        contract_id: 111,
        direction:   'up',
        multiplier:  100,
        stake:       12.5,
        revision_history: state.cycle_open_siblings.R_100[0].revision_history,
    }],
};
const rendered = AIClient._renderRevisionHistoryForPrompt(aiInputWithHist);
check('rendered prompt block is non-null and mentions all outcomes', () => {
    assert.ok(typeof rendered === 'string' && rendered.length > 0);
    assert.ok(rendered.includes('OK'),       'should include OK');
    assert.ok(rendered.includes('CLAMPED'),  'should include CLAMPED');
    assert.ok(rendered.includes('FAILED'),   'should include FAILED');
    assert.ok(rendered.includes('REVERTED'), 'should include REVERTED');
    assert.ok(rendered.includes('contract_id=111'), 'should include the contract id');
});

/* -------------------------------------------------------------------
   5. _buildMultiplierPrompt embeds the revision-history guidance
   ------------------------------------------------------------------- */
header('_buildMultiplierPrompt embeds revision-history guidance');

const fullAiInput = {
    cycle_id: 'cyc-1',
    symbol:   'R_100',
    balance:  1000,
    currency: 'USD',
    session:  { active: true, capital_remaining: 500, take_profit: 20, stop_loss: 20 },
    gates:    { can_open_new: true, reason: null },
    open_siblings: aiInputWithHist.open_siblings,
    market:   { error: 'test' },
    tp_sl_ranges: null,
};
const prompt = AIClient._buildMultiplierPrompt(fullAiInput, {
    stake: { absolute_min: 1, absolute_max: 1000 },
    ai:    { min_confidence: 0.5 },
});
check('full prompt contains the revision-history block', () => {
    assert.ok(prompt.includes('PRIOR TP/SL REVISION ATTEMPTS'),
        'prompt should include the revision-history section header');
    assert.ok(prompt.includes('REVERTED'),
        'prompt should surface the REVERTED outcome from the test history');
});
check('full prompt contains the new DECISION GUIDANCE bullet', () => {
    assert.ok(prompt.includes('BEFORE emitting a `revise`'),
        'prompt should explicitly tell the AI to check revision_history before revising');
});

/* -------------------------------------------------------------------
   Summary
   ------------------------------------------------------------------- */
console.log('\n=== summary ===');
if (failed === 0) {
    console.log('ALL CHECKS PASSED');
    process.exit(0);
} else {
    console.error(failed + ' check(s) FAILED');
    process.exit(1);
}
