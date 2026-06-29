/* =====================================================================
   smoke-close-all.js  —  exercises closeAllPositions() against a mock WS
   ─────────────────────────────────────────────────────────────────────
   Verifies:
     1. closeAllPositions sweeps every symbol with open siblings.
     2. Each sibling is removed from state.cycle_open_siblings after sell.
     3. Realised P/L is summed correctly across symbols.
     4. The kill switch (config.trading_enabled=false) blocks new opens
        in runMultiplierCycle without throwing.

   Run with:  node scripts/smoke-close-all.js
   ===================================================================== */

const path = require('path');
process.chdir(path.join(__dirname, '..'));

const State  = require('../state.js');
const runner = require('../runner.js');

// Stub Telegram + Logger noise (these are global singletons inside the
// module, so we just don't await any external side effects).
process.env.NODE_ENV = 'test';

// Build a fake WS that satisfies Deriv.closeMultiplier + getOpenPositionState.
function makeMockWs(scenarios) {
    // scenarios: { [contract_id]: { sold_for, current_spot, profit } }
    return {
        send: () => {},
        on: () => {},
        // The runner accesses ws via Deriv.* methods; we monkey-patch
        // those below instead of intercepting frames here.
        _scenarios: scenarios,
    };
}

// Monkey-patch Deriv module so we don't open a real connection.
const Deriv = require('../deriv.js');
const origClose   = Deriv.closeMultiplier;
const origPoll    = Deriv.getOpenPositionState;
Deriv.closeMultiplier = async (ws, cid) => {
    const sc = (ws._scenarios && ws._scenarios[cid]) || { sold_for: 10 };
    return {
        contract_id: cid,
        sold_for:    sc.sold_for,
        balance_after: 1000,
        transaction_id: cid * 10,
    };
};
Deriv.getOpenPositionState = async (ws, cid) => {
    const sc = (ws._scenarios && ws._scenarios[cid]) || { current_spot: 1.234, profit: 0 };
    return {
        contract_id:  cid,
        is_open:      true,
        current_spot: sc.current_spot,
        profit:       sc.profit,
    };
};

function assert(cond, msg) {
    if (!cond) {
        console.error('  ✗', msg);
        process.exitCode = 1;
    } else {
        console.log('  ✓', msg);
    }
}

(async () => {
    console.log('\n--- smoke-close-all ---\n');

    /* ── Test 1: sweep two symbols, three siblings total ─────────── */
    console.log('Test 1 — closeAllPositions sweeps every symbol');
    const state1 = {};
    State.addSiblingPosition(state1, 'frxEURUSD', State.makeSiblingRecord({
        contract_id: 101, stake: 50, multiplier: 100, direction: 'up',
    }));
    State.addSiblingPosition(state1, 'frxEURUSD', State.makeSiblingRecord({
        contract_id: 102, stake: 50, multiplier: 100, direction: 'up',
    }));
    State.addSiblingPosition(state1, 'R_100', State.makeSiblingRecord({
        contract_id: 201, stake: 25, multiplier: 50, direction: 'down',
    }));

    const ws1 = makeMockWs({
        101: { sold_for: 55,  profit:  5 },  // +5
        102: { sold_for: 48,  profit: -2 },  // -2
        201: { sold_for: 30,  profit:  5 },  // +5
    });
    const config1 = {
        cycle:   { running: true, session: { capital: 200, take_profit: 0, stop_loss: 0 } },
        account: { mode: 'demo' },
    };
    state1.cycle_session = {
        active: true, halted: false,
        capital_start: 200, capital_remaining: 200,
        take_profit: 0, stop_loss: 0,
        trades: 0, wins: 0, losses: 0, pnl: 0,
    };
    state1.trade_history_cycle = [];

    const result = await runner.closeAllPositions(ws1, config1, state1, 'manual_close_all');

    assert(result.symbols.length === 2, `swept 2 symbols (got ${result.symbols.length})`);
    assert(result.closed.length  === 3, `closed 3 positions (got ${result.closed.length})`);
    assert(result.errors.length  === 0, `no errors (got ${result.errors.length})`);
    assert(State.countOpenSiblings(state1) === 0,
        `state.cycle_open_siblings drained (count=${State.countOpenSiblings(state1)})`);
    const totalPnl = result.closed.reduce((s, c) => s + Number(c.pnl || 0), 0);
    // sold_for - stake:  (55-50)+(48-50)+(30-25) = 5 - 2 + 5 = 8
    assert(Math.abs(totalPnl - 8) < 0.01, `realised P/L sums to +$8 (got ${totalPnl})`);

    /* ── Test 2: kill switch blocks the cycle without crashing ───── */
    console.log('\nTest 2 — kill switch blocks runMultiplierCycle');
    const state2 = { last_cycle: null, cycle_session: { active: false, halted: false }, balance: 1000 };
    const config2 = {
        trading_enabled: false,           // <- kill switch ON
        cycle: { running: true, session: { capital: 100, take_profit: 0, stop_loss: 0 }, interval_seconds: 1 },
        account: { mode: 'demo' },
        symbols: { forex: { frxEURUSD: true } },
    };
    let threw = null;
    try {
        // runMultiplierCycle bails early when (cycle.running && trading_enabled)
        // is false. It should NOT throw.
        const ws2 = makeMockWs({});
        await runner.runMultiplierCycle(ws2, config2, state2, {});
    } catch (e) {
        threw = e;
    }
    assert(!threw, `runMultiplierCycle returns cleanly when kill switch ON (err=${threw && threw.message})`);

    /* ── Test 3: empty state is a no-op ──────────────────────────── */
    console.log('\nTest 3 — closeAllPositions with no open siblings is a no-op');
    const state3 = {};
    const ws3 = makeMockWs({});
    const r3 = await runner.closeAllPositions(ws3, config1, state3, 'manual_close_all');
    assert(r3.symbols.length === 0, 'no symbols swept');
    assert(r3.closed.length  === 0, 'no positions closed');
    assert(r3.errors.length  === 0, 'no errors');

    // Restore Deriv stubs (politeness)
    Deriv.closeMultiplier      = origClose;
    Deriv.getOpenPositionState = origPoll;

    console.log('\n--- smoke-close-all: '
        + (process.exitCode ? 'FAIL ✗' : 'PASS ✓') + ' ---\n');
})().catch(e => {
    console.error('FATAL', e);
    process.exit(1);
});
