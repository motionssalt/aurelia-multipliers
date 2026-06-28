#!/usr/bin/env node
/* =====================================================================
   Smoke test for state.js + deriv.js (Part 1)
   ─────────────────────────────────────────────────────────────────────
   Runs offline. Verifies:
     1. deriv.js parses and exports the new multiplier surface.
     2. state.js helpers behave correctly across the typical flows that
        Part 2's cycle loop will use:
          - empty state → add → read → aggregate
          - upsert (re-add by same contract_id) does not duplicate
          - update floating P/L → aggregate reflects it
          - remove → empty → aggregate is zero
          - all-symbols rollup combines per-symbol counts
          - pruneEmptySymbols clears empty arrays
     3. The Deriv contract_update_request "null clears, omit preserves"
        semantic is exercised end-to-end through reviseMultiplierLimits'
        argument handling (without actually hitting the WS).

   Run with:   node scripts/smoke-state.js
   Exit 0 = all green, exit 1 = any assertion failed.
   ===================================================================== */

const assert = require('assert');
const path = require('path');

const Deriv  = require(path.join('..', 'deriv.js'));
const State  = require(path.join('..', 'state.js'));

let pass = 0, fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass++; console.log(' OK   ' + name); }
    else      { fail++; console.error(' FAIL ' + name + (detail ? '  ' + JSON.stringify(detail) : '')); }
}

// ---- 1. deriv.js public surface --------------------------------------
ok('deriv.placeMultiplier exported',         typeof Deriv.placeMultiplier === 'function');
ok('deriv.closeMultiplier exported',         typeof Deriv.closeMultiplier === 'function');
ok('deriv.reviseMultiplierLimits exported',  typeof Deriv.reviseMultiplierLimits === 'function');
ok('deriv.getOpenPositionState exported',    typeof Deriv.getOpenPositionState === 'function');
ok('deriv.placeTrade (legacy) still exported', typeof Deriv.placeTrade === 'function');
ok('deriv._normalizePoc exported',           typeof Deriv._normalizePoc === 'function');
ok('deriv._validateMultiplierOpts exported', typeof Deriv._validateMultiplierOpts === 'function');

// ---- 2. validateMultiplierOpts edge cases ----------------------------
ok('validate: empty opts → errs',
    Deriv._validateMultiplierOpts({}).length > 0);
ok('validate: missing direction',
    Deriv._validateMultiplierOpts({ symbol: 'R_100', stake: 10, multiplier: 100 }).some(e => /direction/.test(e)));
ok('validate: non-integer multiplier',
    Deriv._validateMultiplierOpts({ symbol: 'R_100', direction: 'up', stake: 10, multiplier: 99.5 }).some(e => /multiplier/.test(e)));
ok('validate: negative stake',
    Deriv._validateMultiplierOpts({ symbol: 'R_100', direction: 'up', stake: -1, multiplier: 100 }).some(e => /stake/.test(e)));
ok('validate: happy path returns []',
    Deriv._validateMultiplierOpts({ symbol: 'R_100', direction: 'up', stake: 10, multiplier: 100 }).length === 0);
ok('validate: happy path with TP/SL',
    Deriv._validateMultiplierOpts({ symbol: 'R_100', direction: 'down', stake: 10, multiplier: 200, takeProfit: 5, stopLoss: 5 }).length === 0);
ok('validate: TP <= 0 caught',
    Deriv._validateMultiplierOpts({ symbol: 'R_100', direction: 'up', stake: 10, multiplier: 100, takeProfit: 0 }).some(e => /takeProfit/.test(e)));

// ---- 3. _normalizePoc on a synthetic raw POC payload -----------------
// Shape mirrors what proposal_open_contract returns for an open MULTUP;
// values are stringly-typed by Deriv (the schema says so), so we feed
// strings and expect numbers back.
const rawPoc = {
    contract_id:        3501118801,
    contract_type:      'MULTUP',
    underlying:         'R_100',
    multiplier:         100,
    status:             'open',
    is_sold:            0,
    is_expired:         0,
    is_valid_to_sell:   1,
    is_valid_to_cancel: 0,
    buy_price:          '10.00',
    bid_price:          '10.42',
    current_spot:       '268.65',
    current_spot_time:  1782680100,
    entry_spot:         '268.42',
    date_start:         1782680000,
    date_expiry:        4936291199,
    profit:             '0.42',
    profit_percentage:  4.2,
    commission:         '0.36',
    longcode:           'If you select "Up", your total profit/loss…',
    limit_order: {
        take_profit: { display_name: 'Take profit', display_order_amount: '6.25', order_amount: 6.25, order_date: 1782680001, value: '270.20' },
        stop_loss:   { display_name: 'Stop loss',   display_order_amount: '-6.25', order_amount: -6.25, order_date: 1782680001, value: '266.64' },
        stop_out:    { display_name: 'Stop out',    display_order_amount: '-10.00', order_amount: -10, order_date: 1782680000, value: '265.78' },
    },
};
const norm = Deriv._normalizePoc(rawPoc);
ok('normalize: direction inferred from MULTUP',  norm.direction === 'up');
ok('normalize: is_open computed',                norm.is_open === true);
ok('normalize: bid_price coerced to number',     typeof norm.bid_price === 'number' && Math.abs(norm.bid_price - 10.42) < 1e-9);
ok('normalize: profit coerced to number',        typeof norm.profit === 'number' && Math.abs(norm.profit - 0.42) < 1e-9);
ok('normalize: take_profit shape',
    norm.take_profit && norm.take_profit.amount === 6.25 && norm.take_profit.value === 270.20);
ok('normalize: stop_out surfaced',
    norm.stop_out && norm.stop_out.amount === -10 && norm.stop_out.value === 265.78);
ok('normalize: raw preserved',                   norm.raw === rawPoc);

// MULTDOWN direction
const norm2 = Deriv._normalizePoc(Object.assign({}, rawPoc, { contract_type: 'MULTDOWN' }));
ok('normalize: MULTDOWN → down',                 norm2.direction === 'down');

// Sold contract
const norm3 = Deriv._normalizePoc(Object.assign({}, rawPoc, { is_sold: 1, status: 'sold' }));
ok('normalize: sold → is_open=false',            norm3.is_open === false && norm3.is_sold === true);

// ---- 4. state.js sibling helpers -------------------------------------
const state = {}; // start from blank

const rec1 = State.makeSiblingRecord({
    contract_id: 100001, stake: 12.5, multiplier: 100, direction: 'up',
    entry_spot: 268.42, take_profit: 6.25, stop_loss: 6.25,
    cycle_id: 'c-1', decision_id: 'd-1', sibling_index: 0, sibling_count: 2,
    rationale: 'oversold bounce',
});
const rec2 = State.makeSiblingRecord({
    contract_id: 100002, stake: 12.5, multiplier: 100, direction: 'up',
    entry_spot: 268.42, take_profit: 12.50, stop_loss: 6.25,
    cycle_id: 'c-1', decision_id: 'd-1', sibling_index: 1, sibling_count: 2,
});
const rec3 = State.makeSiblingRecord({
    contract_id: 200001, stake: 8, multiplier: 200, direction: 'down',
    cycle_id: 'c-2', decision_id: 'd-2',
});

State.addSiblingPosition(state, 'R_100', rec1);
State.addSiblingPosition(state, 'R_100', rec2);
State.addSiblingPosition(state, 'frxEURUSD', rec3);

ok('state: container created under SIBLINGS_KEY',
    typeof state[State.SIBLINGS_KEY] === 'object');
ok('state: R_100 has 2 siblings',                State.getOpenSiblings(state, 'R_100').length === 2);
ok('state: frxEURUSD has 1 sibling',             State.getOpenSiblings(state, 'frxEURUSD').length === 1);
ok('state: countOpenSiblings = 3',               State.countOpenSiblings(state) === 3);

// Upsert (re-add same contract_id) must not duplicate
State.addSiblingPosition(state, 'R_100', Object.assign({}, rec1, { rationale: 'updated reason' }));
ok('state: upsert by contract_id does not duplicate',
    State.getOpenSiblings(state, 'R_100').length === 2);
const upserted = State.getOpenSiblings(state, 'R_100').find(p => p.contract_id === 100001);
ok('state: upsert merges fields',                upserted.rationale === 'updated reason');

// Update floating P/L on rec1
const patched = State.updateSiblingPosition(state, 'R_100', 100001, {
    floating_pnl: 1.20, floating_pnl_pct: 9.6, current_spot: 268.99,
    last_polled_at: '2026-06-28T08:35:00.000Z',
});
ok('state: updateSiblingPosition returns patched record',
    patched && patched.floating_pnl === 1.20);

// Aggregation \u2014 only one of the two R_100 siblings has floating_pnl set
const aggR = State.aggregateSiblingExposure(state, 'R_100');
ok('state: aggregate R_100 count=2',             aggR.count === 2);
ok('state: aggregate R_100 total_stake=25',      aggR.total_stake === 25.00);
ok('state: aggregate R_100 floating_pnl=1.20 (only observed siblings)',
    aggR.total_floating_pnl === 1.20);
ok('state: aggregate direction mix up=2 down=0', aggR.direction_mix.up === 2 && aggR.direction_mix.down === 0);

// frxEURUSD has no floating_pnl observed yet \u2014 expect null
const aggF = State.aggregateSiblingExposure(state, 'frxEURUSD');
ok('state: aggregate frxEURUSD floating_pnl null when never polled',
    aggF.total_floating_pnl === null);

// All-symbols rollup
const aggAll = State.aggregateAllExposure(state);
ok('state: rollup symbols=2',                    aggAll.symbols === 2);
ok('state: rollup positions=3',                  aggAll.positions === 3);
ok('state: rollup total_stake=33',               aggAll.total_stake === 33.00);
ok('state: rollup floating_pnl partial-observed = 1.20',
    aggAll.total_floating_pnl === 1.20);

// getAllOpenSiblings flattening
const flat = State.getAllOpenSiblings(state);
ok('state: getAllOpenSiblings flattens to 3 records', flat.length === 3);
ok('state: flattened records carry symbol',      flat.every(r => typeof r.symbol === 'string'));

// Remove
ok('state: removeSiblingPosition true on hit',
    State.removeSiblingPosition(state, 'R_100', 100002) === true);
ok('state: removeSiblingPosition false on miss',
    State.removeSiblingPosition(state, 'R_100', 999999) === false);
ok('state: remove updates count',                State.countOpenSiblings(state) === 2);

// Remove last frx sibling, then prune
State.removeSiblingPosition(state, 'frxEURUSD', 200001);
ok('state: frxEURUSD now empty array',
    State.getOpenSiblings(state, 'frxEURUSD').length === 0);
const pruned = State.pruneEmptySymbols(state);
ok('state: pruneEmptySymbols removes frxEURUSD',  pruned.includes('frxEURUSD'));
ok('state: frxEURUSD key absent after prune',
    state[State.SIBLINGS_KEY].frxEURUSD === undefined);

// ---- 5. reviseMultiplierLimits argument validation -------------------
// We don't have a live WS — but the function should refuse a no-op
// before sending anything, and accept null-for-clear semantics. We
// detect "would have sent" by replacing request via the exports doesn't
// work cleanly (request is closed over), so just test argument
// rejection paths.
async function rejects(promise, pattern) {
    try { await promise; return false; }
    catch (e) { return pattern.test(e.message); }
}
(async () => {
    ok('revise: rejects no-op (both undefined)',
        await rejects(Deriv.reviseMultiplierLimits({ readyState: 1 }, 1, {}), /nothing to update/));
    ok('revise: rejects bad contract_id',
        await rejects(Deriv.reviseMultiplierLimits({ readyState: 1 }, 0, { takeProfit: 5 }), /invalid contractId/));
    ok('revise: rejects non-positive takeProfit (non-null)',
        await rejects(Deriv.reviseMultiplierLimits({ readyState: 1 }, 1, { takeProfit: 0 }), /takeProfit must be null/));
    ok('revise: rejects non-positive stopLoss (non-null)',
        await rejects(Deriv.reviseMultiplierLimits({ readyState: 1 }, 1, { stopLoss: -1 }), /stopLoss must be null/));

    // closeMultiplier validation
    ok('close: rejects bad contractId',
        await rejects(Deriv.closeMultiplier({ readyState: 1 }, 'abc'), /invalid contractId/));

    // placeMultiplier validation (won't reach WS \u2014 validation throws first)
    ok('place: rejects bad opts',
        await rejects(Deriv.placeMultiplier({ readyState: 1 }, { symbol: 'R_100' }), /placeMultiplier:/));

    // ---- summary ------------------------------------------------------
    console.log('');
    console.log('================================');
    console.log(` ${pass} passed, ${fail} failed`);
    console.log('================================');
    process.exit(fail === 0 ? 0 : 1);
})();
