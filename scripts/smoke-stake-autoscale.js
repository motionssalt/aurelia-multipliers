/**
 * Smoke: stake auto-scale on ContractBuyValidationError.
 *
 * Reproduces the failure from the Telegram screenshot:
 *
 *   ⚠️ OPEN FAILED — cryBTCUSD DEMO
 *   Direction : MULTUP ×200
 *   Stake     : $10.00
 *   TP / SL   : $21.00 / $21.00
 *   • ContractBuyValidationError:
 *     Enter an amount equal to or lower than 9.70.
 *
 * Before the fix:
 *   • Deriv proposal at $10 returned no `validation_params.max_stake`
 *     hint, so the pre-emptive clamp didn't fire.
 *   • Buy at $10 was rejected.
 *   • The legacy single-retry path re-proposed at $9.70 but kept
 *     TP/SL at $21 (>2x stake) which Deriv's limit_order validator
 *     also rejects → second error surfaced → OPEN FAILED.
 *
 * After the fix:
 *   • The retry LOOP (up to 5 attempts) re-proposes at $9.70 AND
 *     proportionally scales TP/SL by 0.97 → $20.37 each.
 *   • Buy succeeds → contract_id returned with
 *     buy._aurelia_stake_clamp populated → runner records the
 *     effective stake/TP/SL → Telegram shows a soft "Stake auto-scaled
 *     by broker" subline instead of OPEN FAILED.
 */
'use strict';

const assert = require('assert');
const path   = require('path');

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

/* ─── Mock the deriv.js WebSocket request() flow ────────────────────── */
const Deriv = require(path.join('..', 'deriv.js'));

/* Test 1: regex parser handles real Deriv error wrapping. */
check('extractMaxStakeFromError parses "Enter an amount equal to or lower than 9.70."', () => {
    // Use the same internal classifier via a trivial fake (we just need
    // the regex to work end-to-end). _extractMaxStakeFromError is module-local,
    // so we exercise it through placeMultiplier's behaviour via mockWs below.
    // For a unit-style check we just sanity-test the wording.
    const RE = /equal\s+to\s+or\s+lower\s+than\s+([0-9][0-9,]*(?:\.[0-9]+)?)/i;
    const m1 = 'ContractBuyValidationError: Enter an amount equal to or lower than 9.70.'.match(RE);
    assert.ok(m1, 'must match real Deriv wording');
    assert.strictEqual(Number(m1[1]), 9.70);

    const m2 = 'Some other text. Enter an amount equal to or lower than 1,234.56. Trailing.'.match(RE);
    assert.ok(m2, 'must tolerate comma thousands separators');
    assert.strictEqual(Number(m2[1].replace(/,/g, '')), 1234.56);
});

/* Test 2: Full mock of the retry loop.

   We build a minimal fake WebSocket whose .send() inspects the outgoing
   payload and invokes the message handler with a synthetic Deriv reply.
   This exercises the real `request()` function inside deriv.js end-to-end. */

function makeMockWs(scenario) {
    // scenario is an array of { match: (payload)=>bool, reply: (req_id)=>object }
    // We mirror the internal state that deriv.js._attachHandlers sets up
    // so the real `request()` plumbing (req_id pairing, pending map, error
    // promotion) drives the test end-to-end.
    const msgHandlers = [];
    const ws = {
        readyState: 1,
        OPEN: 1,
        __reqId: 1,
        __pending: new Map(),
        __stream:  new Map(),
        _calls: [],
        send(json) {
            const payload = JSON.parse(json);
            ws._calls.push(payload);
            const step = scenario.shift();
            if (!step) throw new Error(`mockWs: unexpected request ${JSON.stringify(payload)}`);
            if (!step.match(payload)) {
                throw new Error(`mockWs: payload mismatch.\n  expected: ${step.label}\n  got: ${JSON.stringify(payload)}`);
            }
            // Reply on next tick to mimic async WS. The real
            // message handler installed via ws.on('message', ...) in
            // _attachHandlers pairs req_id back to the pending promise.
            setImmediate(() => {
                const raw = JSON.stringify(step.reply(payload.req_id));
                for (const h of msgHandlers) h(Buffer.from(raw));
            });
        },
        on(event, cb) {
            if (event === 'message') msgHandlers.push(cb);
            // ignore close/error/open in this mock
        },
        off() {}, once() {},
    };
    // Install the same message router deriv.js's _attachHandlers builds:
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

check('placeMultiplier retries with clamped stake AND scaled TP/SL on cap error', async () => {
    // Scenario mimics the exact screenshot:
    //   1. proposal #1 at stake=10 (TP=21, SL=21)            → reply with id, NO validation_params hint
    //   2. buy proposal #1                                   → error "Enter an amount equal to or lower than 9.70"
    //   3. proposal #2 at stake=9.70 (TP scaled, SL scaled)  → reply with id
    //   4. buy proposal #2                                   → success with contract_id

    const scenario = [
        {
            label: 'proposal #1 stake=10',
            match: (p) => p.proposal === 1 && p.amount === 10 && p.limit_order
                       && p.limit_order.take_profit === 21 && p.limit_order.stop_loss === 21
                       && p.multiplier === 200 && p.contract_type === 'MULTUP'
                       && p.underlying_symbol === 'cryBTCUSD',
            reply: (req_id) => ({
                req_id, msg_type: 'proposal',
                proposal: {
                    id: 'prop-1', ask_price: 10, spot: 60230,
                    commission: 0.10,
                    limit_order: { take_profit: { order_amount: 21 }, stop_loss: { order_amount: 21 } },
                    // NO validation_params.max_stake (matches real cryBTCUSD behaviour)
                },
            }),
        },
        {
            label: 'buy #1 → error',
            match: (p) => p.buy === 'prop-1',
            reply: (req_id) => ({
                req_id, msg_type: 'buy',
                error: {
                    code: 'ContractBuyValidationError',
                    message: 'Enter an amount equal to or lower than 9.70.',
                },
            }),
        },
        {
            label: 'proposal #2 stake=9.70 with proportionally scaled TP/SL',
            match: (p) => {
                if (p.proposal !== 1) return false;
                if (p.amount !== 9.70) return false;
                // ratio = 9.70 / 10 = 0.97 → TP/SL should be floor2(21*0.97)=20.37
                if (!p.limit_order) return false;
                if (p.limit_order.take_profit !== 20.37) return false;
                if (p.limit_order.stop_loss   !== 20.37) return false;
                return true;
            },
            reply: (req_id) => ({
                req_id, msg_type: 'proposal',
                proposal: {
                    id: 'prop-2', ask_price: 9.70, spot: 60230,
                    commission: 0.10,
                    limit_order: { take_profit: { order_amount: 20.37 }, stop_loss: { order_amount: 20.37 } },
                },
            }),
        },
        {
            label: 'buy #2 → success',
            match: (p) => p.buy === 'prop-2',
            reply: (req_id) => ({
                req_id, msg_type: 'buy',
                buy: {
                    contract_id: 999111222,
                    buy_price: 9.70,
                    transaction_id: 777,
                    longcode: 'cryBTCUSD MULTUP x200 (auto-scaled smoke)',
                },
            }),
        },
    ];

    const ws = makeMockWs(scenario);
    const out = await Deriv.placeMultiplier(ws, {
        symbol:     'cryBTCUSD',
        direction:  'up',
        stake:      10,
        multiplier: 200,
        takeProfit: 21,
        stopLoss:   21,
    });

    assert.ok(out && out.buy, 'must return buy reply');
    assert.strictEqual(out.buy.contract_id, 999111222, 'contract_id mismatch');
    const clamp = out.buy._aurelia_stake_clamp;
    assert.ok(clamp, '_aurelia_stake_clamp metadata must be present when clamped');
    assert.strictEqual(clamp.requested_stake, 10);
    assert.strictEqual(clamp.final_stake,     9.70);
    assert.strictEqual(clamp.requested_take_profit, 21);
    assert.strictEqual(clamp.final_take_profit,     20.37);
    assert.strictEqual(clamp.requested_stop_loss,   21);
    assert.strictEqual(clamp.final_stop_loss,       20.37);
    assert.strictEqual(scenario.length, 0, 'all scenario steps must be consumed');
});

check('placeMultiplier still bubbles UP truly fatal errors (unrelated to stake cap)', async () => {
    // First proposal succeeds, but buy fails with a non-stake error.
    // The new loop should NOT mask this — it should rethrow as-is.
    const scenario = [
        {
            label: 'proposal #1',
            match: (p) => p.proposal === 1,
            reply: (req_id) => ({
                req_id, msg_type: 'proposal',
                proposal: { id: 'prop-1', ask_price: 10, spot: 60000, commission: 0.1 },
            }),
        },
        {
            label: 'buy #1 → unrelated error',
            match: (p) => p.buy === 'prop-1',
            reply: (req_id) => ({
                req_id, msg_type: 'buy',
                error: {
                    code: 'AuthorizationRequired',
                    message: 'Please log in.',
                },
            }),
        },
    ];
    const ws = makeMockWs(scenario);
    let threw = null;
    try {
        await Deriv.placeMultiplier(ws, {
            symbol: 'cryBTCUSD', direction: 'up', stake: 10, multiplier: 200,
        });
    } catch (e) {
        threw = e;
    }
    assert.ok(threw, 'must throw on non-recoverable error');
    assert.ok(/AuthorizationRequired|log in/i.test(threw.message),
        'must preserve original error message, got: ' + threw.message);
});

check('placeMultiplier respects ABS_MIN_STAKE — below 0.35 cap', async () => {
    // Deriv tells us the cap is 0.10 (below ABS_MIN_STAKE). We must NOT
    // clamp the user's money down to a value the config considers
    // sub-minimum — instead we surface a clean explanatory error.
    const scenario = [
        {
            label: 'proposal #1',
            match: (p) => p.proposal === 1,
            reply: (req_id) => ({
                req_id, msg_type: 'proposal',
                proposal: { id: 'prop-1', ask_price: 10, spot: 60000, commission: 0.1 },
            }),
        },
        {
            label: 'buy #1 → cap below ABS_MIN',
            match: (p) => p.buy === 'prop-1',
            reply: (req_id) => ({
                req_id, msg_type: 'buy',
                error: {
                    code: 'ContractBuyValidationError',
                    message: 'Enter an amount equal to or lower than 0.10.',
                },
            }),
        },
    ];
    const ws = makeMockWs(scenario);
    let threw = null;
    try {
        await Deriv.placeMultiplier(ws, {
            symbol: 'cryBTCUSD', direction: 'up', stake: 10, multiplier: 200,
        });
    } catch (e) { threw = e; }
    assert.ok(threw, 'must throw rather than place sub-minimum trade');
    assert.ok(/cannot satisfy stake cap|below absolute min/i.test(threw.message),
        'must explain the sub-minimum refusal, got: ' + threw.message);
});

/* Test 4: telegram template renders the auto-scale subline. */
check('Telegram multiplierTickSummary renders "Stake auto-scaled" subline (no OPEN FAILED)', () => {
    const TG = require(path.join('..', 'telegram.js'));
    const tick = TG.templates && TG.templates.multiplierTickSummary;
    assert.ok(typeof tick === 'function', 'templates.multiplierTickSummary export missing');
    const msg = tick({
        mode: 'demo',
        symbol: 'cryBTCUSD',
        decision: {
            action: 'open', confidence: 0.65, rationale: 'test',
            open: { direction: 'up', stake: 10, multiplier: 200, take_profit: 21, stop_loss: 21, siblings: 1 },
        },
        preActionSiblings: [],
        executed: {
            action: 'open',
            details: [
                {
                    contract_id: 999111222,
                    stake_autoscaled: {
                        requested_stake: 10,   final_stake: 9.70,
                        requested_take_profit: 21, final_take_profit: 20.37,
                        requested_stop_loss:   21, final_stop_loss:   20.37,
                    },
                },
            ],
        },
        exposure: { open_count: 1, total_stake: 9.70, floating_pnl: 0 },
        session:  { capital_remaining: 1000, realised_pnl: 0 },
        balance:  9933.27, currency: 'USD',
    });
    assert.ok(typeof msg === 'string' && msg.length, 'must return non-empty string');
    assert.ok(!/OPEN FAILED/.test(msg),
        'must NOT render OPEN FAILED when the trade succeeded post-autoscale; got:\n' + msg);
    assert.ok(/Stake auto-scaled by broker/i.test(msg),
        'must include auto-scale subline; got:\n' + msg);
    assert.ok(/\$10\.00.*\$9\.70/.test(msg),
        'must show the from→to stake transition; got:\n' + msg);
    assert.ok(/TP\s*\$21\.00.*\$20\.37/.test(msg),
        'must show TP transition; got:\n' + msg);
    assert.ok(/Opened\s*:\s*✅/.test(msg),
        'must still show the Opened ✅ line; got:\n' + msg);
});

runAll();
