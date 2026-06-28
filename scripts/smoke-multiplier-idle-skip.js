#!/usr/bin/env node
/* =====================================================================
   Smoke test for the idle-paused AI-skip short-circuit in
   runMultiplierCycle() (the fix added in this change).
   ─────────────────────────────────────────────────────────────────────
   Verifies two scenarios:

     A. Idle continuation tick:
        config.cycle.running=false, zero open siblings, nothing closing
        this tick. EXPECTED:
          - AIClient.askMultiplierDecision NOT called
          - askMultiplierDecisionStub NOT called
          - Telegram.send / Telegram.sendPhoto NOT called
          - Logger.info contains the skip-reason line
          - polling step still runs in full (vacuously here, since
            there are no open siblings to poll)

     B. Same paused state, but ONE sibling came back is_sold this tick:
        config.cycle.running=false, one open sibling that polls back as
        is_sold (server-side close). EXPECTED:
          - pollSibling IS called for that sibling
          - realizeClosedSibling fires (sibling removed, session.pnl
            updated)
          - The short-circuit does NOT fire (justClosed.length > 0)
          - AI decision call DOES run for this tick (normal flow)
          - Telegram tick summary fires (we just confirm Telegram.send
            or Telegram.sendPhoto was attempted at least once)

     C. Sanity: cycle running, zero open siblings — short-circuit must
        NOT fire (canOpenNew=true, so the AI must still be consulted).

   Run with:   node scripts/smoke-multiplier-idle-skip.js
   Exit 0 = all green, exit 1 = any assertion failed.
   ===================================================================== */

'use strict';

const path = require('path');

// IMPORTANT: monkeypatch BEFORE requiring runner.js, because runner.js
// captures references to AIClient, Telegram, Deriv, Chart, Logger at
// require-time via top-level `const X = require(...)`. Mutating the
// exported object after require still works for property lookups
// (runner.js does `AIClient.askMultiplierDecision(...)`), so we patch
// the module exports directly.
const Logger    = require(path.join('..', 'logger.js'));
const Deriv     = require(path.join('..', 'deriv.js'));
const Telegram  = require(path.join('..', 'telegram.js'));
const Chart     = require(path.join('..', 'chart.js'));
const AIClient  = require(path.join('..', 'ai-client.js'));
const State     = require(path.join('..', 'state.js'));

const counters = {
    aiClientAsk:        0,
    telegramSend:       0,
    telegramSendPhoto:  0,
    derivPoc:           0,
    derivClose:         0,
    derivPlace:         0,
    chartRender:        0,
    skipLogged:         false,
};
const infoLogLines = [];

// --- Patch AIClient.askMultiplierDecision ----------------------------
AIClient.askMultiplierDecision = async function (/* args */) {
    counters.aiClientAsk++;
    return {
        decision: {
            action: 'hold',
            decision_id: 'spy-hold',
            rationale: 'spy-stub forced hold',
        },
    };
};

// --- Patch Telegram outbound surface ---------------------------------
Telegram.send      = async function (/* text, opts */) { counters.telegramSend++;      return { ok: true }; };
Telegram.sendPhoto = async function (/* buf, caption */) { counters.telegramSendPhoto++; return { ok: true }; };

// --- Patch Chart rendering (avoid Puppeteer launch) ------------------
Chart.renderMultiplierSnapshot = async function () {
    counters.chartRender++;
    return { buffer: null, nextWindow: null };
};

// --- Patch Deriv network surface -------------------------------------
const pocBehaviour = new Map(); // contract_id -> POC reply
Deriv.getOpenPositionState = async function (ws, cid) {
    counters.derivPoc++;
    const b = pocBehaviour.get(Number(cid));
    if (b == null) throw new Error(`mock POC: no behaviour for ${cid}`);
    return b;
};
Deriv.closeMultiplier = async function (ws, cid) {
    counters.derivClose++;
    return { contract_id: cid, sold_for: 0, balance_after: 0, transaction_id: 1 };
};
Deriv.placeMultiplier = async function () {
    counters.derivPlace++;
    return {
        proposal: { id: 'p', ask_price: 1, spot: 250.0, date_start: 0 },
        buy:      { contract_id: 1, transaction_id: 1, longcode: 'mock', buy_price: 1 },
    };
};

// --- Patch Logger.info to capture the skip line ----------------------
const origLoggerInfo = Logger.info;
Logger.info = function (msg, ctx) {
    infoLogLines.push(String(msg));
    if (/paused\/halted with no open siblings — skipping AI call/.test(String(msg))) {
        counters.skipLogged = true;
    }
    // Call through so log output stays readable.
    return origLoggerInfo.call(Logger, msg, ctx);
};

// Now require the runner (after patches are in place).
const Runner = require(path.join('..', 'runner.js'));

// NOTE on spying on askMultiplierDecisionStub:
//   runMultiplierCycle references the module-LOCAL function symbol
//   `askMultiplierDecisionStub`, not the export. Re-assigning
//   `Runner.askMultiplierDecisionStub` therefore doesn't intercept
//   the internal call. The authoritative spy is on
//   AIClient.askMultiplierDecision (patched above), which is what
//   the stub *actually invokes* under the hood. counters.aiClientAsk
//   is the source of truth for "was the (billed) AI call made?".

// --- helpers ---------------------------------------------------------
let pass = 0, fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass++; console.log(' OK   ' + name); }
    else      { fail++; console.error(' FAIL ' + name + (detail ? '  ' + JSON.stringify(detail) : '')); }
}

function resetCounters() {
    counters.aiClientAsk = 0;
    counters.telegramSend = 0;
    counters.telegramSendPhoto = 0;
    counters.derivPoc = 0;
    counters.derivClose = 0;
    counters.derivPlace = 0;
    counters.chartRender = 0;
    counters.skipLogged = false;
    infoLogLines.length = 0;
    pocBehaviour.clear();
}

function freshConfig(overrides) {
    const c = {
        enabled: true,
        account: { mode: 'demo' },
        symbols: { forex: {}, synthetics: { R_100: true } },
        frx_enabled: false,
        syn_enabled: true,
        cycle: { running: true, engine: 'multipliers', interval_seconds: 60,
                 session: { capital: 1000, take_profit: 20, stop_loss: 20 } },
        stake: { absolute_min: 0.35, absolute_max: 10000 },
        expiry: { min_seconds: 900 },
        ai: { min_confidence: 0 },
        payout: { enabled: false },
        manual: { capital: 200, take_profit: 20, stop_loss: 20 },
    };
    if (overrides && overrides.cycleRunning === false) c.cycle.running = false;
    return c;
}
function freshState(overrides) {
    const s = {
        balance: 1000,
        currency: 'USD',
        account_mode: 'demo',
        cycle_session: {
            active: true, halted: false, halt_reason: null,
            started_at: new Date(Date.now() - 60_000).toISOString(),
            capital_start: 1000, capital_remaining: 975,
            take_profit: 20, stop_loss: 20,
            trades: 0, wins: 0, losses: 0, pnl: 0,
            win_streak: 0, loss_streak: 0,
        },
        cycle_open_siblings: {},
        pending_contracts: [],
        trade_history_cycle: [],
        trade_history_manual: [],
        ai_keys_bench: {},
        daily_stats: { date: new Date().toISOString().slice(0,10), trades: 0, wins: 0, losses: 0, pnl: 0, by_symbol: {} },
        logs: [],
        // Pre-latch session summary so the short-circuit's idempotent
        // maybeSendSessionSummary call doesn't try to send anything in
        // scenario A (we're testing the IDLE CONTINUATION case — the
        // session already ended on a prior tick).
        _notified_session_summary: null,
    };
    if (overrides && overrides.alreadyNotified) {
        s._notified_session_summary = s.cycle_session.started_at;
    }
    return s;
}

const fakeWs = { readyState: 1 };

(async () => {
    // ============================================================
    // SCENARIO A: paused, zero open siblings, nothing closing
    //   → must short-circuit. NO AI call. NO Telegram message.
    //   skip-line logged.
    // ============================================================
    {
        resetCounters();
        const config = freshConfig({ cycleRunning: false });
        const state  = freshState({ alreadyNotified: true });
        await Runner.runMultiplierCycle(fakeWs, config, state, {});

        ok('A1: AIClient.askMultiplierDecision NOT called',
           counters.aiClientAsk === 0, { calls: counters.aiClientAsk });
        ok('A3: Telegram.send NOT called',
           counters.telegramSend === 0, { calls: counters.telegramSend });
        ok('A4: Telegram.sendPhoto NOT called',
           counters.telegramSendPhoto === 0, { calls: counters.telegramSendPhoto });
        ok('A5: Chart.renderMultiplierSnapshot NOT called',
           counters.chartRender === 0, { calls: counters.chartRender });
        ok('A6: skip-reason Logger.info line was emitted',
           counters.skipLogged === true);
        ok('A7: no POC polls (no siblings to poll)',
           counters.derivPoc === 0);
        ok('A8: session state untouched (still active, not halted)',
           state.cycle_session.active === true && state.cycle_session.halted === false);
    }

    // ============================================================
    // SCENARIO B: paused, one open sibling, polls back is_sold
    //   → justClosed.length > 0 → must NOT short-circuit.
    //   Polling + realizeClosedSibling must run, AI call MUST run,
    //   Telegram tick notification MUST fire.
    // ============================================================
    {
        resetCounters();
        const config = freshConfig({ cycleRunning: false });
        const state  = freshState({ alreadyNotified: true });
        State.addSiblingPosition(state, 'R_100', State.makeSiblingRecord({
            contract_id: 8001, stake: 10, multiplier: 100, direction: 'up',
            entry_spot: 250.0, take_profit: 5, stop_loss: 5,
        }));
        // Sibling comes back is_sold with -10 profit (stop_out signature).
        pocBehaviour.set(8001, {
            contract_id: 8001, contract_type: 'MULTUP', symbol: 'R_100', multiplier: 100,
            direction: 'up', is_open: false, is_sold: true, is_expired: false,
            is_valid_to_sell: false, is_valid_to_cancel: false, status: 'sold',
            buy_price: 10, bid_price: 0, sell_price: 0,
            profit: -10, profit_percentage: -100,
            current_spot: 240.1, entry_spot: 250.0,
            take_profit: null, stop_loss: null,
            stop_out: { amount: -10, value: 240, order_date: 0 },
            longcode: '', raw: {},
        });

        await Runner.runMultiplierCycle(fakeWs, config, state, {});

        ok('B1: pollSibling was called for the open sibling',
           counters.derivPoc === 1, { calls: counters.derivPoc });
        ok('B2: sibling was realised (removed from open list)',
           State.getOpenSiblings(state, 'R_100').length === 0);
        ok('B3: session.pnl updated to -10',
           state.cycle_session.pnl === -10);
        ok('B4: AIClient.askMultiplierDecision DID run (normal flow)',
           counters.aiClientAsk === 1, { calls: counters.aiClientAsk });
        ok('B6: Telegram tick notification fired (send OR sendPhoto)',
           (counters.telegramSend + counters.telegramSendPhoto) >= 1,
           { send: counters.telegramSend, sendPhoto: counters.telegramSendPhoto });
        ok('B7: skip-reason log was NOT emitted',
           counters.skipLogged === false);
    }

    // ============================================================
    // SCENARIO C: cycle running, zero open siblings, nothing closing
    //   → canOpenNew=true → short-circuit must NOT fire (AI is the
    //   one that decides whether to open). This pins down that the
    //   gate truly fires only on paused/halted.
    // ============================================================
    {
        resetCounters();
        const config = freshConfig();              // running=true
        const state  = freshState();
        await Runner.runMultiplierCycle(fakeWs, config, state, {});

        ok('C1: AIClient.askMultiplierDecision DID run (normal flow)',
           counters.aiClientAsk === 1, { calls: counters.aiClientAsk });
        ok('C2: skip-reason log was NOT emitted',
           counters.skipLogged === false);
    }

    // ============================================================
    // SCENARIO D: halted session (sess.halted=true), zero open
    //   siblings, nothing closing this tick. Same shape as A but
    //   triggered by the halt path rather than the pause path.
    //   Must also short-circuit.
    // ============================================================
    {
        resetCounters();
        const config = freshConfig();                       // running=true
        const state  = freshState({ alreadyNotified: true });
        state.cycle_session.halted = true;
        state.cycle_session.halt_reason = 'previous_tp';
        state.cycle_session.active = false;

        await Runner.runMultiplierCycle(fakeWs, config, state, {});

        ok('D1: AIClient.askMultiplierDecision NOT called when halted+idle',
           counters.aiClientAsk === 0, { calls: counters.aiClientAsk });
        ok('D2: Telegram NOT called when halted+idle',
           counters.telegramSend === 0 && counters.telegramSendPhoto === 0,
           { send: counters.telegramSend, sendPhoto: counters.telegramSendPhoto });
        ok('D3: skip-reason log was emitted',
           counters.skipLogged === true);
    }

    // --- summary -----------------------------------------------------
    console.log('');
    console.log('================================');
    console.log(` ${pass} passed, ${fail} failed`);
    console.log('================================');
    process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('idle-skip smoke crashed:', e); process.exit(1); });
