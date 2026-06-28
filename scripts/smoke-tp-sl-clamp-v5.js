#!/usr/bin/env node
/* smoke-tp-sl-clamp-v5.js
 *
 * Asserts the v5 redesign of deriv.placeMultiplier:
 *   • The legacy stake auto-scale retry loop is GONE — there is no
 *     `_applyClamp`, `_scaleLimitOrder`, `_handleStakeCapError`, and
 *     no "stake auto-scale exhausted after N attempts" error path.
 *   • A pre-flight TP/SL-less probe reads validation_params at the
 *     caller's actual stake, and the limit_order's take_profit /
 *     stop_loss are clamped INTO those ranges before the real proposal
 *     is sent — so Deriv never raises the cap error in the first place.
 *   • The caller's stake is NEVER auto-scaled. If the stake is outside
 *     the broker's vp.stake.{min,max} we throw a clean StakeAboveMax /
 *     StakeBelowMin error and surface it verbatim.
 *   • The returned buy._aurelia_stake_clamp metadata has the v5 shape
 *     (kind: 'tp_sl_clamp', requested_stake === final_stake).
 *
 * Mocks Deriv's WebSocket round-trip so the test runs offline.
 */
'use strict';
const assert = require('assert');
const Deriv  = require('../deriv.js');

let failed = 0;
let passed = 0;
async function t(name, fn) {
    try { await fn(); console.log(' OK   ' + name); passed++; }
    catch (e) {
        console.log(' FAIL ' + name + ' — ' + (e && e.message));
        if (process.env.SMOKE_VERBOSE) console.error(e && e.stack);
        failed++;
    }
}

/* --- A tiny mock WebSocket -------------------------------------------- */
/* Implements the same surface that deriv.request() uses:
   - readyState === 1 (OPEN, matches WebSocket.OPEN from the `ws` lib)
   - on('message', fn) / on('close', fn) / on('error', fn)
   - send(stringified-json)
   We pre-seed __reqId / __pending so request() bypasses _attachHandlers
   and we don't need to open a real socket. */
function makeMockWs(scriptedResponses) {
    /* scriptedResponses is an array of {match, reply} objects.
       Each outgoing request is matched against the next entry's `match`
       predicate and the entry's `reply` is delivered. Throws on overrun. */
    const sentLog = [];
    let cursor = 0;
    const messageHandlers = [];
    const ws = {
        readyState: 1,
        on(evt, fn) {
            if (evt === 'message') messageHandlers.push(fn);
            // other events (close/error) — ignored for these tests
        },
        send(json) {
            const req = JSON.parse(json);
            sentLog.push(req);
            const entry = scriptedResponses[cursor++];
            if (!entry) {
                // Make this asynchronous so the awaiting request() rejects
                // cleanly rather than this throw propagating into send().
                setImmediate(() => {
                    const errReply = { error: { code: 'MockOverrun', message: 'mock ws: ran out of scripted replies at request ' + JSON.stringify(req) }, req_id: req.req_id };
                    for (const fn of messageHandlers) fn(JSON.stringify(errReply));
                });
                return;
            }
            if (entry.match && !entry.match(req)) {
                setImmediate(() => {
                    const errReply = { error: { code: 'MockMismatch', message: 'mock ws: request did not match entry ' + cursor + ': ' + JSON.stringify(req) }, req_id: req.req_id };
                    for (const fn of messageHandlers) fn(JSON.stringify(errReply));
                });
                return;
            }
            const reply = typeof entry.reply === 'function' ? entry.reply(req) : entry.reply;
            setImmediate(() => {
                const echoed = { ...reply, req_id: req.req_id };
                // deriv.request() handler does JSON.parse(raw.toString()) — we
                // pass a string here so .toString() is a no-op.
                for (const fn of messageHandlers) fn(JSON.stringify(echoed));
            });
        },
        sentLog,
    };
    // Pre-attach the standard handlers that _attachHandlers would set up.
    ws.__reqId   = 1;
    ws.__pending = new Map();
    ws.__stream  = new Map();
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

(async () => {
    /* --- v5.0 sanity: legacy retry helpers are GONE --------------------- */
    await t('v5.0a legacy `_applyClamp` is not exported (loop removed)', () => {
        assert.strictEqual(Deriv._applyClamp, undefined);
    });
    await t('v5.0b legacy `_scaleLimitOrder` is not exported (loop removed)', () => {
        assert.strictEqual(Deriv._scaleLimitOrder, undefined);
    });
    await t('v5.0c legacy `_handleStakeCapError` is not exported (loop removed)', () => {
        assert.strictEqual(Deriv._handleStakeCapError, undefined);
    });

    /* --- v5.1 — happy path: TP/SL already in-range, no clamping ---------- */
    await t('v5.1 happy path: in-range TP/SL → no clamp, no retry, success', async () => {
        const VP = { stake: { min: '1.00', max: '2000.00' },
                     take_profit: { min: '0.10', max: '50.00' },
                     stop_loss:   { min: '0.51', max: '8.59' } };
        const ws = makeMockWs([
            { match: r => r.proposal === 1 && r.amount === 10 && !r.limit_order,
              reply: { proposal: { id: 'probe-1', ask_price: 10, spot: 60000, commission: 0.05, validation_params: VP } } },
            { match: r => r.proposal === 1 && r.amount === 10 && r.limit_order,
              reply: { proposal: { id: 'real-1', ask_price: 10, spot: 60000, commission: 0.05,
                                   validation_params: VP, limit_order: { take_profit: 20, stop_loss: 5 } } } },
            { match: r => r.buy === 'real-1',
              reply: { buy: { contract_id: 999111, buy_price: 10, transaction_id: 7, longcode: 'mock' } } },
        ]);

        const out = await Deriv.placeMultiplier(ws, {
            symbol: 'cryBTCUSD', direction: 'up', stake: 10, multiplier: 200,
            takeProfit: 20, stopLoss: 5,
        });

        assert.strictEqual(out.buy.contract_id, 999111);
        assert.strictEqual(out.buy._aurelia_stake_clamp, null, 'no clamp metadata when nothing was adjusted');
        assert.strictEqual(ws.sentLog.length, 3, 'exactly 3 requests: probe + proposal + buy (no retries)');
    });

    /* --- v5.2 — the reported bug scenario: SL out of range → clamped pre-flight */
    await t('v5.2 the cryBTCUSD x300 scenario: SL=22 with cap 8.59 → clamped, no error', async () => {
        const VP_TIGHT = { stake: { min: '1.00', max: '2000.00' },
                           take_profit: { min: '0.10', max: '50.00' },
                           stop_loss:   { min: '0.51', max: '8.59' } };
        const ws = makeMockWs([
            { match: r => r.proposal === 1 && !r.limit_order,
              reply: { proposal: { id: 'probe-2', ask_price: 10, spot: 60000, commission: 0.05, validation_params: VP_TIGHT } } },
            { match: r => r.proposal === 1 && r.limit_order && r.limit_order.stop_loss < 8.59 && r.limit_order.stop_loss > 0,
              reply: { proposal: { id: 'real-2', ask_price: 10, spot: 60000, commission: 0.05,
                                   validation_params: VP_TIGHT, limit_order: { take_profit: 23, stop_loss: 8.43 } } } },
            { match: r => r.buy === 'real-2',
              reply: { buy: { contract_id: 999222, buy_price: 10, transaction_id: 8, longcode: 'mock' } } },
        ]);

        const out = await Deriv.placeMultiplier(ws, {
            symbol: 'cryBTCUSD', direction: 'down', stake: 10, multiplier: 300,
            takeProfit: 23, stopLoss: 22,
        });

        assert.strictEqual(out.buy.contract_id, 999222, 'trade opens successfully');
        const clamp = out.buy._aurelia_stake_clamp;
        assert.ok(clamp, 'clamp metadata present');
        assert.strictEqual(clamp.kind, 'tp_sl_clamp', 'v5 metadata shape');
        assert.strictEqual(clamp.requested_stake, 10);
        assert.strictEqual(clamp.final_stake, 10,         'STAKE IS UNCHANGED in v5');
        assert.strictEqual(clamp.requested_stop_loss, 22, 'requested SL preserved for audit');
        assert.ok(clamp.final_stop_loss < 8.59,           'final SL inside broker range');
        assert.ok(clamp.final_stop_loss > 0,              'final SL positive');
        assert.strictEqual(ws.sentLog.length, 3, 'exactly 3 requests: probe + proposal + buy (no retry loop)');
    });

    /* --- v5.3 — stake itself above vp.stake.max → clean error, NO scaling */
    await t('v5.3 stake above broker max → throws StakeAboveMax (NO silent rescale)', async () => {
        const ws = makeMockWs([
            { match: r => r.proposal === 1 && !r.limit_order,
              reply: { proposal: { id: 'probe-3', ask_price: 5000, spot: 60000, commission: 0,
                                   validation_params: { stake: { min: '1.00', max: '100.00' },
                                                        take_profit: { min: '0.10', max: '500.00' },
                                                        stop_loss:   { min: '0.51', max: '50.00' } } } } },
        ]);

        let threw = null;
        try {
            await Deriv.placeMultiplier(ws, {
                symbol: 'R_100', direction: 'up', stake: 5000, multiplier: 100,
                takeProfit: 50, stopLoss: 25,
            });
        } catch (e) { threw = e; }

        assert.ok(threw, 'must throw');
        assert.ok(/above broker max/.test(threw.message), 'message must say "above broker max", not "auto-scale exhausted"');
        assert.ok(!/auto-scale exhausted/.test(threw.message), 'must NOT use the legacy v1-v3 message');
        assert.strictEqual(ws.sentLog.length, 1, 'probe only — no rescale attempts, no real proposal');
    });

    /* --- v5.4 — range tightened between probe and proposal → re-clamp once */
    await t('v5.4 range tightens between probe and proposal → single re-clamp, then success', async () => {
        const VP_PROBE  = { stake: { min: '1.00', max: '2000.00' },
                            take_profit: { min: '0.10', max: '50.00' },
                            stop_loss:   { min: '0.51', max: '10.00' } };
        const VP_TIGHT  = { stake: { min: '1.00', max: '2000.00' },
                            take_profit: { min: '0.10', max: '50.00' },
                            stop_loss:   { min: '0.51', max: '5.00' } }; // tightened from 10 → 5

        const ws = makeMockWs([
            { match: r => r.proposal === 1 && !r.limit_order,
              reply: { proposal: { id: 'probe-4', validation_params: VP_PROBE, ask_price: 10, spot: 60000 } } },
            { match: r => r.proposal === 1 && r.limit_order,
              reply: { proposal: { id: 'real-4a', validation_params: VP_TIGHT, ask_price: 10, spot: 60000,
                                   limit_order: { stop_loss: 8 } } } },
            { match: r => r.proposal === 1 && r.limit_order && r.limit_order.stop_loss < 5,
              reply: { proposal: { id: 'real-4b', validation_params: VP_TIGHT, ask_price: 10, spot: 60000,
                                   limit_order: { stop_loss: 4.9 } } } },
            { match: r => r.buy === 'real-4b',
              reply: { buy: { contract_id: 999444, buy_price: 10, transaction_id: 9, longcode: 'mock' } } },
        ]);

        const out = await Deriv.placeMultiplier(ws, {
            symbol: 'cryBTCUSD', direction: 'up', stake: 10, multiplier: 200,
            stopLoss: 9,
        });
        assert.strictEqual(out.buy.contract_id, 999444);
        assert.strictEqual(ws.sentLog.length, 4, 'probe + proposal-1 + proposal-2 + buy (one re-clamp)');
    });

    /* --- v5.5 — transport / unknown error bubbles up untouched -------- */
    await t('v5.5 non-cap error bubbles up untouched (no silent rewrite)', async () => {
        const ws = makeMockWs([
            { match: () => true,
              reply: { error: { code: 'AuthorizationRequired', message: 'Please log in.' } } },
        ]);
        let threw = null;
        try {
            await Deriv.placeMultiplier(ws, {
                symbol: 'R_100', direction: 'up', stake: 10, multiplier: 100,
            });
        } catch (e) { threw = e; }
        assert.ok(threw, 'must throw');
        assert.ok(/AuthorizationRequired|Please log in/.test(threw.message), 'message preserved verbatim');
    });

    /* --- v5.6 — _parseValidationParams / _applyTpSlRanges still work --- */
    await t('v5.6 _parseValidationParams / _clampToRange / _applyTpSlRanges retained', () => {
        const vp = Deriv._parseValidationParams({
            validation_params: {
                stake:       { min: '1.00', max: '100.00' },
                take_profit: { min: '0.10', max: '50.00' },
                stop_loss:   { min: '0.51', max: '8.59' },
            },
        });
        assert.ok(vp, 'parsed');
        assert.strictEqual(vp.stop_loss.max, 8.59);
        const r = Deriv._applyTpSlRanges({ take_profit: 23, stop_loss: 22 }, vp);
        assert.strictEqual(r.changed, true);
        assert.ok(r.limit_order.take_profit <= 50.00);
        assert.ok(r.limit_order.stop_loss   <= 8.59);
        assert.ok(r.limit_order.stop_loss    > 0);
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
})();
