/**
 * Smoke: stake auto-scale when Deriv rejects AT PROPOSAL TIME.
 *
 * Reproduces the recurring failure from last-status.json:
 *
 *   [13:15:27.466Z] AI decision via gemini key "GEMINI_KEY_2"  { action: open, conf: 0.7 }
 *   [13:15:27.467Z] askMultiplierDecision: validated
 *   [13:15:27.605Z] placeMultiplier failed
 *       { symbol: "cryBTCUSD",
 *         error: "ContractBuyValidationError: Enter an amount equal to or lower than 9.70." }
 *
 * Notice: only ~140 ms between AI-decision and failure, with NO
 * "auto-scaling stake" warning in between. This is the smoking gun —
 * the auto-scale loop never fired its retry. Reason: Deriv raised
 * the ContractBuyValidationError on the FIRST proposal request
 * (one round-trip), not on the buy request that follows it.
 *
 * The original autoscale fix wrapped only the buy step in try/catch,
 * so a proposal-time rejection bubbled straight up to the runner as
 * OPEN FAILED, bypassing the retry loop. This test pins the contract
 * that the FIXED loop must also recover from proposal-time cap errors.
 */
'use strict';

const assert = require('assert');
const path   = require('path');
const Deriv  = require(path.join('..', 'deriv.js'));

let pass = 0, fail = 0;
const tests = [];
function check(name, fn) { tests.push({ name, fn }); }

async function runAll() {
    for (const t of tests) {
        try {
            await t.fn();
            console.log(' OK  ', t.name);
            pass++;
        } catch (e) {
            console.log(' FAIL', t.name, '\n   ', e.stack || e.message);
            fail++;
        }
    }
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
}

/* Reuse the mock-ws factory shape from smoke-stake-autoscale.js.
   Each scenario step is { label, match, reply }. */
function makeMockWs(scenario) {
    const msgHandlers = [];
    const ws = {
        readyState: 1, OPEN: 1, __reqId: 1,
        __pending: new Map(), __stream: new Map(),
        _calls: [],
        send(json) {
            const payload = JSON.parse(json);
            ws._calls.push(payload);
            const step = scenario.shift();
            if (!step) throw new Error(`mockWs: unexpected request ${JSON.stringify(payload)}`);
            if (!step.match(payload)) {
                throw new Error(`mockWs: payload mismatch.\n  expected: ${step.label}\n  got: ${JSON.stringify(payload)}`);
            }
            setImmediate(() => {
                const raw = JSON.stringify(step.reply(payload.req_id));
                for (const h of msgHandlers) h(Buffer.from(raw));
            });
        },
        on(event, cb) { if (event === 'message') msgHandlers.push(cb); },
        off() {}, once() {},
    };
    ws.on('message', (raw) => {
        let data;
        try { data = JSON.parse(raw.toString()); } catch (e) { return; }
        const id = data.req_id;
        if (id != null && ws.__pending.has(id)) {
            const slot = ws.__pending.get(id);
            ws.__pending.delete(id);
            clearTimeout(slot.timer);
            if (data.error) slot.reject(new Error(`${data.error.code}: ${data.error.message}`));
            else            slot.resolve(data);
        }
    });
    return ws;
}

/* ───────── Test 1: proposal-time ContractBuyValidationError recovers ─────────
   The exact failure pattern from last-status.json. */
check('PROPOSAL-TIME ContractBuyValidationError triggers auto-scale (the prod bug)', async () => {
    const scenario = [
        {
            label: 'proposal #1 stake=10 → REJECTED at proposal time',
            match: (p) => p.proposal === 1 && p.amount === 10
                       && p.contract_type === 'MULTUP' && p.multiplier === 200
                       && p.underlying_symbol === 'cryBTCUSD',
            reply: (req_id) => ({
                req_id, msg_type: 'proposal',
                // Deriv returns the cap error on the PROPOSAL response
                // (not the buy response). This is what the original
                // autoscale fix did NOT handle.
                error: {
                    code: 'ContractBuyValidationError',
                    message: 'Enter an amount equal to or lower than 9.70.',
                },
            }),
        },
        {
            // With the 5% safety margin: 9.70 - max(0.05, 9.70*0.05=0.485) = 9.70 - 0.48 = 9.22
            label: 'proposal #2 stake=9.22 (cap 9.70 minus 5% safety margin)',
            match: (p) => p.proposal === 1 && p.amount === 9.22
                       && p.limit_order && typeof p.limit_order.take_profit === 'number'
                       && typeof p.limit_order.stop_loss === 'number',
            reply: (req_id) => ({
                req_id, msg_type: 'proposal',
                proposal: {
                    id: 'prop-2', ask_price: 9.22, spot: 60230, commission: 0.10,
                },
            }),
        },
        {
            label: 'buy prop-2 → success',
            match: (p) => p.buy === 'prop-2' && p.price === 9.22,
            reply: (req_id) => ({
                req_id, msg_type: 'buy',
                buy: {
                    contract_id: 999111333,
                    buy_price:   9.22,
                    transaction_id: 778,
                    longcode: 'cryBTCUSD MULTUP x200 (proposal-time autoscale recovery)',
                },
            }),
        },
    ];
    const ws = makeMockWs(scenario);
    const out = await Deriv.placeMultiplier(ws, {
        symbol: 'cryBTCUSD',
        direction: 'up',
        stake: 10,
        multiplier: 200,
        takeProfit: 21,
        stopLoss:   21,
    });
    assert.strictEqual(out.buy.contract_id, 999111333,
        'buy must succeed after proposal-time clamp');
    assert.ok(out.buy._aurelia_stake_clamp,
        '_aurelia_stake_clamp metadata must be attached for runner/Telegram');
    assert.strictEqual(out.buy._aurelia_stake_clamp.requested_stake, 10);
    assert.strictEqual(out.buy._aurelia_stake_clamp.final_stake, 9.22);
});

/* ───────── Test 2: proposal-time error with $14.55 ceiling (the SECOND prod failure) ───── */
check('proposal-time cap $14.55 (the 2nd recurring failure) recovers cleanly', async () => {
    const scenario = [
        {
            label: 'proposal stake=20 → REJECTED "<=14.55"',
            match: (p) => p.proposal === 1 && p.amount === 20,
            reply: (req_id) => ({
                req_id, msg_type: 'proposal',
                error: {
                    code: 'ContractBuyValidationError',
                    message: 'Enter an amount equal to or lower than 14.55.',
                },
            }),
        },
        {
            // 14.55 - max(0.05, 14.55*0.05=0.7275 → 0.72) = 14.55 - 0.72 = 13.83
            label: 'proposal #2 stake=13.83 (cap 14.55 minus 5% safety margin)',
            match: (p) => p.proposal === 1 && p.amount === 13.83,
            reply: (req_id) => ({
                req_id, msg_type: 'proposal',
                proposal: { id: 'prop-A', ask_price: 13.83, spot: 60000, commission: 0.15 },
            }),
        },
        {
            label: 'buy prop-A → success',
            match: (p) => p.buy === 'prop-A',
            reply: (req_id) => ({
                req_id, msg_type: 'buy',
                buy: { contract_id: 999111444, buy_price: 13.83,
                       transaction_id: 779, longcode: '...' },
            }),
        },
    ];
    const ws = makeMockWs(scenario);
    const out = await Deriv.placeMultiplier(ws, {
        symbol: 'cryBTCUSD', direction: 'up',
        stake: 20, multiplier: 200,
    });
    assert.strictEqual(out.buy.contract_id, 999111444);
    assert.strictEqual(out.buy._aurelia_stake_clamp.final_stake, 13.83);
});

/* ───────── Test 3: oscillating cap (proposal-then-buy-then-tighter-cap) ─────────
   Defensive: even if Deriv quotes a tighter cap on each round-trip,
   the 5-attempt loop must converge. This pins behaviour against an
   adversarial broker that drips the cap one cent at a time. */
check('multi-round tightening cap converges within MAX_ATTEMPTS', async () => {
    const scenario = [
        // round 1: proposal accepted, buy rejected with cap 9.70
        { label: 'p1 stake=10', match: (p) => p.proposal === 1 && p.amount === 10,
          reply: (req_id) => ({ req_id, msg_type: 'proposal',
              proposal: { id: 'p1', ask_price: 10, spot: 60000, commission: 0.1 } }) },
        { label: 'buy p1 reject 9.70', match: (p) => p.buy === 'p1',
          reply: (req_id) => ({ req_id, msg_type: 'buy',
              error: { code: 'ContractBuyValidationError',
                       message: 'Enter an amount equal to or lower than 9.70.' } }) },
        // round 2: clamp 9.70-margin = 9.22 → rejected with tighter cap 9.10
        { label: 'p2 stake=9.22', match: (p) => p.proposal === 1 && p.amount === 9.22,
          reply: (req_id) => ({ req_id, msg_type: 'proposal',
              error: { code: 'ContractBuyValidationError',
                       message: 'Enter an amount equal to or lower than 9.10.' } }) },
        // round 3: clamp 9.10-margin (0.45) = 8.65 → accepted, buy succeeds
        { label: 'p3 stake=8.65', match: (p) => p.proposal === 1 && p.amount === 8.65,
          reply: (req_id) => ({ req_id, msg_type: 'proposal',
              proposal: { id: 'p3', ask_price: 8.65, spot: 60000, commission: 0.1 } }) },
        { label: 'buy p3 success', match: (p) => p.buy === 'p3',
          reply: (req_id) => ({ req_id, msg_type: 'buy',
              buy: { contract_id: 999111555, buy_price: 8.65,
                     transaction_id: 780, longcode: '...' } }) },
    ];
    const ws = makeMockWs(scenario);
    const out = await Deriv.placeMultiplier(ws, {
        symbol: 'cryBTCUSD', direction: 'up', stake: 10, multiplier: 200,
    });
    assert.strictEqual(out.buy.contract_id, 999111555);
    assert.strictEqual(out.buy._aurelia_stake_clamp.final_stake, 8.65);
});

/* ───────── Test 4: pathological "cap == stake" — shave-a-tick recovery ─────────
   The user emphasised: "when it checks and it is not correct, it adjusts
   it so it will not give an error". The fix must make forward progress
   even when Deriv quotes a ceiling EQUAL to the stake we sent (observed
   rarely in production due to server-side rounding edge cases). */
check('cap equal to stake → loop shaves below safety margin to make progress', async () => {
    const scenario = [
        { label: 'p1 stake=9.70', match: (p) => p.proposal === 1 && p.amount === 9.70,
          reply: (req_id) => ({ req_id, msg_type: 'proposal',
              // Broker quotes "<= 9.70" but we already sent 9.70
              error: { code: 'ContractBuyValidationError',
                       message: 'Enter an amount equal to or lower than 9.70.' } }) },
        // After safety-margin clamp: 9.70 - 0.48 = 9.22
        { label: 'p2 stake=9.22', match: (p) => p.proposal === 1 && p.amount === 9.22,
          reply: (req_id) => ({ req_id, msg_type: 'proposal',
              proposal: { id: 'p2', ask_price: 9.22, spot: 60000, commission: 0.1 } }) },
        { label: 'buy p2 success', match: (p) => p.buy === 'p2',
          reply: (req_id) => ({ req_id, msg_type: 'buy',
              buy: { contract_id: 999111666, buy_price: 9.22,
                     transaction_id: 781, longcode: '...' } }) },
    ];
    const ws = makeMockWs(scenario);
    const out = await Deriv.placeMultiplier(ws, {
        symbol: 'cryBTCUSD', direction: 'up', stake: 9.70, multiplier: 200,
    });
    assert.strictEqual(out.buy.contract_id, 999111666,
        'must recover via safety-margin clamp when broker quotes cap == stake');
    assert.strictEqual(out.buy._aurelia_stake_clamp.final_stake, 9.22);
});

runAll();
