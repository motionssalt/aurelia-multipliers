/* =====================================================================
   AURELIA-MULTIPLIERS — Deriv WebSocket + OAuth/OTP authentication
   ─────────────────────────────────────────────────────────────────────
   Forked from AURELIA (binary options). The connection / auth / candle /
   balance plumbing is identical; the binary CALL/PUT path (placeTrade +
   _waitForSettlement) is preserved verbatim below for reference and so
   the existing test scaffolding still works. The new Multiplier API is
   appended at the bottom (search: `MULTIPLIERS — contract engine`).

   Two-phase auth (no naked api_token):

     1) GET  https://api.derivws.com/trading/v1/options/accounts
        Header:  Authorization: Bearer <DERIV_BEARER_TOKEN>
                 Deriv-App-ID:  <DERIV_APP_ID>
        → { data: [{ loginid, currency, account_type, ... }, ...] }

     2) Pick the loginid that matches config.account.mode
        (real → DERIV_REAL_ID, demo → DERIV_DEMO_ID)

     3) POST https://api.derivws.com/trading/v1/options/accounts/{loginid}/otp
        Same headers.
        → { data: { url: "wss://..." } }   ← pre-authenticated WS

     4) Open WebSocket on that URL. NO `authorize` call needed.

   Public surface — connection & shared helpers:
     connect({ bearer, appId, loginid })     → { ws, accountId }
     request(ws, payload, timeoutMs)         → resolves with full reply
     ticksHistory(ws, symbol, gran, count)   → Candle[]
     getBalance(ws)                          → { balance, currency, loginid }
     close(ws)

   Public surface — legacy binary path (UNCHANGED, kept for reference):
     placeTrade(ws, opts)                    → settled-contract object

   Public surface — Multipliers contract engine (NEW in this fork):
     placeMultiplier(ws, opts)               → { proposal, buy }
     closeMultiplier(ws, contractId, opts?)  → sell reply
     reviseMultiplierLimits(ws, contractId, { takeProfit?, stopLoss? })
                                             → contract_update reply
     getOpenPositionState(ws, contractId)    → normalized read-only snapshot
   ===================================================================== */

const WebSocket = require('ws');
const Logger    = require('./logger');

const DEFAULT_TIMEOUT = 15000;

/* ─────────────────────────────────────────────────────────────────
   Forex (frx*) intraday duration floor — verified against Deriv's
   contracts_for response for this account:
     • expiry_type "intraday": min_contract_duration = 15m
     • expiry_type "daily":    min_contract_duration = 1d
   There is no sub-15m option for forex CALL/PUT/CALLE/PUTE. Other
   asset classes (synthetic indices R_*, crypto cry*, etc.) keep
   whatever the strategy asked for — this constraint is forex-only.

   _normaliseForexDuration is the single shared chokepoint. Every
   trade goes through placeTrade() below, so clamping here covers
   all current and future strategies without per-call-site patches.
   ───────────────────────────────────────────────────────────────── */
const FOREX_MIN_INTRADAY_MINUTES = 15;

function _isForexSymbol(symbol) {
    return typeof symbol === 'string' && symbol.startsWith('frx');
}

function _normaliseForexDuration(symbol, duration, durationUnit) {
    if (!_isForexSymbol(symbol)) {
        return { duration, durationUnit, clamped: false };
    }
    // Convert whatever the caller passed into minutes for comparison.
    // Forex on this account supports only m/h/d (intraday >= 15m, or
    // daily). Anything sub-minute (e.g. ticks/seconds) or below 15m
    // gets clamped up to the 15m intraday floor with unit 'm'.
    let minutes;
    switch (durationUnit) {
        case 't': // ticks — not valid for forex, treat as < 15m
            minutes = 0;
            break;
        case 's':
            minutes = duration / 60;
            break;
        case 'm':
            minutes = duration;
            break;
        case 'h':
            minutes = duration * 60;
            break;
        case 'd':
            // Daily contracts are a separate expiry_type with its own
            // valid range — leave untouched.
            return { duration, durationUnit, clamped: false };
        default:
            minutes = duration; // unknown unit, be conservative
    }
    if (minutes < FOREX_MIN_INTRADAY_MINUTES) {
        return {
            duration: FOREX_MIN_INTRADAY_MINUTES,
            durationUnit: 'm',
            clamped: true,
            originalDuration: duration,
            originalUnit: durationUnit,
        };
    }
    return { duration, durationUnit, clamped: false };
}

/* ─────────────────────────────────────────────────────────────────
   REST helpers — list accounts + request OTP-WS URL
   ───────────────────────────────────────────────────────────────── */
async function _getFetch() {
    if (typeof fetch === 'function') return fetch;
    const mod = await import('node-fetch');
    return mod.default;
}

async function listAccounts({ bearer, appId }) {
    if (!bearer) throw new Error('DERIV_BEARER_TOKEN missing');
    if (!appId)  throw new Error('DERIV_APP_ID missing');
    const f = await _getFetch();
    const res = await f('https://api.derivws.com/trading/v1/options/accounts', {
        method: 'GET',
        headers: {
            Authorization:  `Bearer ${bearer}`,
            'Deriv-App-ID': String(appId),
            Accept:         'application/json',
        },
    });
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`list-accounts ${res.status}: ${body.slice(0, 200)}`);
    }
    const json = await res.json();
    return (json && (json.data || json.accounts || [])) || [];
}

async function getOtpUrl({ bearer, appId, loginid }) {
    if (!loginid) throw new Error('account loginid missing');
    const f = await _getFetch();
    const url = `https://api.derivws.com/trading/v1/options/accounts/${encodeURIComponent(loginid)}/otp`;
    const res = await f(url, {
        method: 'POST',
        headers: {
            Authorization:  `Bearer ${bearer}`,
            'Deriv-App-ID': String(appId),
            Accept:         'application/json',
            'Content-Type': 'application/json',
        },
    });
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`otp ${res.status}: ${body.slice(0, 200)}`);
    }
    const json = await res.json();
    const wss  = json && json.data && json.data.url;
    if (!wss) throw new Error('OTP response missing data.url');
    return wss;
}

/* ─────────────────────────────────────────────────────────────────
   WebSocket — open, request/reply, ping/pong watchdog
   ───────────────────────────────────────────────────────────────── */
function _attachHandlers(ws) {
    ws.__reqId = 1;
    ws.__pending = new Map();   // req_id → { resolve, reject, timer }
    ws.__stream  = new Map();   // subscription id → handler

    ws.on('message', (raw) => {
        let data;
        try { data = JSON.parse(raw.toString()); }
        catch (e) { return; }

        // Streamed subscriptions (ticks_history with subscribe=1)
        if (data.subscription && data.subscription.id && ws.__stream.has(data.subscription.id)) {
            try { ws.__stream.get(data.subscription.id)(data); } catch (e) {}
        }

        const id = data.req_id;
        if (id != null && ws.__pending.has(id)) {
            const slot = ws.__pending.get(id);
            ws.__pending.delete(id);
            clearTimeout(slot.timer);
            if (data.error) slot.reject(new Error(`${data.error.code}: ${data.error.message}`));
            else            slot.resolve(data);
        }
    });

    ws.on('close', () => {
        for (const [, slot] of ws.__pending) {
            clearTimeout(slot.timer);
            slot.reject(new Error('WebSocket closed'));
        }
        ws.__pending.clear();
    });

    ws.on('error', (err) => Logger.error('Deriv WS error', { error: err.message }));
}

/* Defensive guard — strip unexpected top-level keys from sensitive
   trade requests before they hit the wire.

   Deriv's WebSocket schemas reject unrecognised top-level fields with
   "Properties not allowed: <field>". The error is rejected synchronously
   by the schema layer, so an otherwise good trade never opens.

   ⚠️ Schema migration (2025+): Deriv unified its proposal endpoint and
   RENAMED `symbol` → `underlying_symbol`. The fields `product_type`,
   `date_start`, and `trading_period_start` were REMOVED. Sending
   `symbol` now yields:
       "InputValidationFailed: Properties not allowed: symbol."
   See:
     • https://developers.deriv.com/schemas/proposal_request.schema.json
     • https://developers.deriv.com/comparison/proposal/
   The allow-lists below reflect the current schema.

   This guard is belt-and-suspenders: any future call site that
   accidentally adds a stray top-level field gets it stripped here,
   with a single warning line so the bug is loud but not fatal. The
   known-allowed sets below cover every top-level field the five
   sensitive endpoints accept in our usage; pass-through is used for
   every other request type. */
const _ALLOWED_TOP_KEYS = {
    // Common control fields Deriv always accepts on any request:
    _common: ['req_id', 'passthrough'],
    // POST /proposal — NEW schema: uses `underlying_symbol` (NOT `symbol`).
    // `product_type`, `date_start`, `trading_period_start` are no longer
    // accepted by the unified endpoint and are deliberately omitted here.
    proposal: [
        'proposal', 'amount', 'basis', 'contract_type', 'currency',
        'duration', 'duration_unit', 'underlying_symbol', 'multiplier',
        'limit_order', 'barrier', 'barrier2', 'date_expiry',
        'cancellation', 'subscribe', 'payout', 'selected_tick',
        'growth_rate', 'payout_per_point',
    ],
    // POST /buy
    buy:                    ['buy', 'price', 'parameters', 'subscribe'],
    // POST /sell
    sell:                   ['sell', 'price'],
    // POST /contract_update
    contract_update:        ['contract_update', 'contract_id', 'limit_order'],
    // POST /proposal_open_contract
    proposal_open_contract: ['proposal_open_contract', 'contract_id', 'subscribe'],
};

function _guardSensitiveRequest(payload) {
    if (!payload || typeof payload !== 'object') return payload;
    // Identify the request type by looking for the matching primary key.
    let kind = null;
    for (const k of ['proposal', 'buy', 'sell', 'contract_update', 'proposal_open_contract']) {
        if (Object.prototype.hasOwnProperty.call(payload, k)) { kind = k; break; }
    }
    if (!kind) return payload; // not a guarded request type — pass through unchanged
    const allowed = new Set([..._ALLOWED_TOP_KEYS._common, ..._ALLOWED_TOP_KEYS[kind]]);
    const cleaned = {};
    const stripped = [];
    for (const key of Object.keys(payload)) {
        if (allowed.has(key)) cleaned[key] = payload[key];
        else stripped.push(key);
    }
    if (stripped.length) {
        Logger.warn(`Deriv request guard: stripped unexpected top-level field(s) on "${kind}" request`, {
            kind,
            stripped,
            hint: 'These would be rejected by Deriv with "Properties not allowed: ...". ' +
                  'Move them under the correct nested object (e.g. limit_order) or remove them.',
        });
    }
    return cleaned;
}

function request(ws, payload, timeoutMs = DEFAULT_TIMEOUT) {
    return new Promise((resolve, reject) => {
        if (ws.readyState !== WebSocket.OPEN) {
            return reject(new Error(`WS not open (state=${ws.readyState})`));
        }
        const id = ws.__reqId++;
        // Strip any unexpected top-level keys from sensitive trade
        // requests before they hit the wire. Non-sensitive requests
        // (ticks_history, balance, contracts_for, ...) pass through
        // unchanged.
        const safePayload = _guardSensitiveRequest(payload);
        const body = Object.assign({}, safePayload, { req_id: id });
        const timer = setTimeout(() => {
            if (ws.__pending.has(id)) {
                ws.__pending.delete(id);
                reject(new Error(`request timeout: ${JSON.stringify(safePayload).slice(0, 80)}`));
            }
        }, timeoutMs);
        ws.__pending.set(id, { resolve, reject, timer });
        try { ws.send(JSON.stringify(body)); }
        catch (e) {
            clearTimeout(timer);
            ws.__pending.delete(id);
            reject(e);
        }
    });
}

function _openWs(url) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url);
        const timer = setTimeout(() => {
            try { ws.terminate(); } catch (e) {}
            reject(new Error('WS open timeout'));
        }, 20000);
        ws.on('open', () => {
            clearTimeout(timer);
            _attachHandlers(ws);
            resolve(ws);
        });
        ws.on('error', (err) => {
            clearTimeout(timer);
            reject(err);
        });
    });
}

/* ─────────────────────────────────────────────────────────────────
   Public connect() — runs the full OAuth + OTP flow
   ───────────────────────────────────────────────────────────────── */
async function connect({ bearer, appId, mode, realId, demoId }) {
    const loginid = (mode === 'real') ? realId : demoId;
    if (!loginid) throw new Error(`account loginid for mode="${mode}" not set`);

    Logger.network(`Deriv: requesting OTP for ${loginid} (${mode})`);
    const url = await getOtpUrl({ bearer, appId, loginid });
    Logger.network('Deriv: opening WebSocket', { url: url.replace(/token=[^&]+/, 'token=***') });

    const ws = await _openWs(url);
    Logger.network('Deriv: WebSocket open');
    return { ws, accountId: loginid };
}

/* ─────────────────────────────────────────────────────────────────
   ensureOpen — re-issue a fresh OTP + WebSocket if the existing
   connection has gone stale (Deriv OTP sessions appear to expire
   quickly, independent of activity — closing the socket out from
   under a long-running tick). Pass the SAME connOpts used for the
   original connect() call. Returns the (possibly new) ws.
   ───────────────────────────────────────────────────────────────── */
async function ensureOpen(ws, connOpts) {
    if (ws && ws.readyState === WebSocket.OPEN) return ws;
    Logger.warn(`Deriv: socket not open (state=${ws ? ws.readyState : 'null'}) — reconnecting`);
    const fresh = await connect(connOpts);
    return fresh.ws;
}

/* ─────────────────────────────────────────────────────────────────
   ticksHistory — fetch OHLC candles (or raw ticks) for a symbol
   ───────────────────────────────────────────────────────────────── */
async function ticksHistory(ws, symbol, granularity, count = 100) {
    const reply = await request(ws, {
        ticks_history: symbol,
        end:           'latest',
        count:         count,
        style:         'candles',
        granularity:   Number(granularity),
        adjust_start_time: 1,
    }, 20000);
    const candles = reply.candles || [];
    return candles.map(c => ({
        epoch: Number(c.epoch),
        open:  Number(c.open),
        high:  Number(c.high),
        low:   Number(c.low),
        close: Number(c.close),
    }));
}

async function rawTicks(ws, symbol, count = 50) {
    const reply = await request(ws, {
        ticks_history: symbol,
        end:           'latest',
        count:         count,
        style:         'ticks',
    }, 15000);
    const history = reply.history || {};
    const prices  = (history.prices || []).map(Number);
    const times   = (history.times  || []).map(Number);
    return { prices, times };
}

/* ─────────────────────────────────────────────────────────────────
   Balance
   ───────────────────────────────────────────────────────────────── */
async function getBalance(ws) {
    const r = await request(ws, { balance: 1 }, 10000);
    const b = r.balance || {};
    return {
        balance:  Number(b.balance) || 0,
        currency: b.currency || 'USD',
        loginid:  b.loginid  || null,
    };
}

/* ─────────────────────────────────────────────────────────────────
   placeTrade — proposal → buy → poll proposal_open_contract until settled
   opts:
     symbol, contractType ('CALL'|'PUT'), stake, duration, durationUnit ('s'|'m')
   ───────────────────────────────────────────────────────────────── */
async function placeTrade(ws, opts, settleOpts) {
    const symbol       = opts.symbol;
    const contractType = String(opts.contractType || '').toUpperCase();
    const stake        = Number(opts.stake);
    const rawDuration     = Number(opts.duration);
    const rawDurationUnit = opts.durationUnit || 'm';
    // Forex (frx*) requires duration >= 15m for intraday CALL/PUT.
    // Clamp here so every trade path (any strategy, any caller) is
    // safe — see _normaliseForexDuration above.
    const _norm = _normaliseForexDuration(symbol, rawDuration, rawDurationUnit);
    const duration     = _norm.duration;
    const durationUnit = _norm.durationUnit;
    if (_norm.clamped) {
        Logger.warn('Forex duration below 15m floor — clamped to 15m', {
            symbol,
            requested: `${_norm.originalDuration}${_norm.originalUnit}`,
            used:      `${duration}${durationUnit}`,
        });
    }
    const settleWaitMs = (settleOpts && Number(settleOpts.settleWaitMs)) || null;
    // v3.1 additive: optional callback fired after the buy is accepted
    // but BEFORE we block on settlement. Used by the runner to push an
    // immediate "trade placed" Telegram ping. Errors thrown by the
    // callback are swallowed — notifications must not break a live trade.
    const onPlaced    = (settleOpts && typeof settleOpts.onPlaced === 'function')
        ? settleOpts.onPlaced : null;

    if (!symbol || !contractType || !Number.isFinite(stake) || stake <= 0) {
        throw new Error('placeTrade: invalid opts');
    }

    // 1) Proposal
    // Deriv's unified proposal schema (2025+) requires `underlying_symbol`.
    // Sending top-level `symbol` is rejected with
    //   "InputValidationFailed: Properties not allowed: symbol."
    // Schema: https://developers.deriv.com/schemas/proposal_request.schema.json
    const propReply = await request(ws, {
        proposal:         1,
        amount:           stake,
        basis:            'stake',
        contract_type:    contractType,
        currency:         'USD',
        duration:         duration,
        duration_unit:    durationUnit,
        underlying_symbol: symbol,
    }, 15000);

    const prop = propReply.proposal;
    if (!prop || !prop.id) throw new Error('proposal: no id returned');
    Logger.trade(`Proposal accepted ${symbol} ${contractType}`,
        { stake, price: prop.ask_price, payout: prop.payout, spot: prop.spot });

    // 2) Buy
    const buyReply = await request(ws, {
        buy:   prop.id,
        price: Number(prop.ask_price),
    }, 15000);
    const buy = buyReply.buy;
    if (!buy || !buy.contract_id) throw new Error('buy: no contract_id');
    Logger.trade(`Trade placed: contract_id=${buy.contract_id}`,
        { transaction_id: buy.transaction_id, longcode: buy.longcode });

    // 2b) Notify caller that the buy is live (BEFORE settlement wait).
    if (onPlaced) {
        try {
            await onPlaced({ proposal: prop, buy });
        } catch (e) {
            Logger.warn('placeTrade onPlaced callback threw', { error: e.message });
        }
    }

    // 3) Wait for settlement (bounded). If the wait elapses before
    //    Deriv reports the contract as sold/won/lost, we return the
    //    best-effort snapshot — the runner will record it as pending
    //    and try again next cycle. This is what makes long-duration
    //    contracts safe in a cron-driven bot.
    const settled = await _waitForSettlement(ws, buy.contract_id,
        duration, durationUnit, settleWaitMs);
    return { proposal: prop, buy, settled };
}

async function _waitForSettlement(ws, contractId, duration, durationUnit, settleWaitMs) {
    const seconds = (durationUnit === 'm') ? duration * 60 : duration;
    // Default: bounded to a sensible duration. If the caller passed
    // settleWaitMs explicitly (the v3 runner does), honour that —
    // it knows whether the cron interval can let a contract span
    // multiple cycles.
    const budgetMs = Number.isFinite(settleWaitMs) && settleWaitMs > 0
        ? settleWaitMs
        : Math.min(55000, Math.max(20000, (seconds + 30) * 1000));
    const deadline = Date.now() + budgetMs;
    let lastSnapshot = null;

    while (Date.now() < deadline) {
        try {
            const r = await request(ws, {
                proposal_open_contract: 1,
                contract_id:            contractId,
            }, 10000);
            const poc = r.proposal_open_contract || {};
            lastSnapshot = poc;
            if (poc.is_sold || poc.status === 'sold' ||
                poc.status === 'won'  || poc.status === 'lost') {
                return poc;
            }
        } catch (e) {
            Logger.warn('proposal_open_contract poll error', { error: e.message });
        }
        await _sleep(1500);
    }
    Logger.warn('Trade settlement timed out — returning best-effort snapshot', {
        contract_id: contractId
    });
    return lastSnapshot || { contract_id: contractId, status: 'timeout' };
}

function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* ─────────────────────────────────────────────────────────────────
   Close
   ───────────────────────────────────────────────────────────────── */
function close(ws) {
    try {
        if (ws && ws.readyState === WebSocket.OPEN) ws.close(1000, 'cycle complete');
    } catch (e) {}
}

/* =====================================================================
   MULTIPLIERS — contract engine
   ─────────────────────────────────────────────────────────────────────
   Verified against Deriv's public WS (wss://ws.derivws.com/websockets/
   v3?app_id=1089) and the JSON schemas under developers.deriv.com/
   schemas/{contract_update,sell,proposal_open_contract}_*.schema.json.
   Key facts confirmed live and pinned into the code below:

   • Contract types are 'MULTUP' / 'MULTDOWN' (uppercase). Verified via
     contracts_for on R_100, 1HZ100V, frxEURUSD, cryBTCUSD.
   • The proposal request uses `underlying_symbol` (NOT `symbol`) under
     the unified Deriv API (2025+). Earlier versions of this code used
     `symbol`; that now returns
        "InputValidationFailed: Properties not allowed: symbol."
     and aborts every open. Required fields are: proposal=1, amount,
     basis='stake', contract_type, currency, underlying_symbol,
     multiplier. limit_order is OPTIONAL.
     Schema: https://developers.deriv.com/schemas/proposal_request.schema.json
   • The integer `multiplier` parameter must be one of the values in
     the contracts_for `multiplier_range`. Verified ranges (USD basic):
        – synthetics  (R_*, 1HZ*V) : [40, 100, 200, 300, 400]
        – forex       (frx*)       : [100, 200, 300, 500, 800]
        – crypto      (cry*)       : [100, 200, 300, 500, 800]
     This file does NOT hardcode those ranges (they're a backend fact
     that can shift) — it just clamps/warns if the caller asks for an
     obviously bad value (<= 0 or non-integer). Range validation
     against `contracts_for` belongs in Part 2's payload builder.
   • limit_order.take_profit / limit_order.stop_loss can be passed at
     proposal/buy time; the proposal reply echoes back the same shape
     with `value` (price level) and `order_amount` ($-amount).
   • Multipliers have expiry_type='no_expiry' and date_expiry far in the
     future (year 2126 sentinel). Stake is fully at risk; positions are
     closed by sell / stop_out / take_profit / stop_loss / cancellation.
   • `sell` request shape: { sell: <contract_id>, price: <num> }.
     `price` is REQUIRED by the schema; pass 0 for 'sell at market'.
     There is NO partial-close parameter. Multipliers cannot be partially
     closed via this endpoint — full close only. (Partial risk reduction
     must instead be done by opening multiple sibling positions up-front
     and closing one of them — which is exactly why Part 1 is building
     sibling-position state shape.)
   • `contract_update` request shape:
        { contract_update: 1, contract_id, limit_order: { take_profit?, stop_loss? } }
     Each of take_profit / stop_loss is INDEPENDENTLY optional inside
     limit_order — supply only the one you want to change, leave the
     other field out and it is preserved. Pass `null` explicitly to
     CANCEL an existing limit. Verified directly from the JSON schema
     (additionalProperties: false; type: ["null", "number"] for each).
   • `proposal_open_contract` for an open multiplier exposes:
        contract_id, contract_type, status, is_sold, is_expired,
        is_valid_to_sell, is_valid_to_cancel, bid_price, buy_price,
        current_spot, current_spot_time, entry_spot, date_start,
        date_expiry, profit (=bid_price-buy_price), profit_percentage,
        commission, longcode,
        limit_order: { stop_loss, stop_out, take_profit } where each
          sub-object is { display_name, display_order_amount,
          order_amount, order_date, value }.
     stop_out is server-set (not user-settable) and reflects the level
     at which the broker auto-closes the position. getOpenPositionState
     surfaces it so Part 2/3 can use it for risk-distance heuristics.
   ===================================================================== */

// Per Deriv's contracts_for, the integer multiplier must come from a
// discrete set per symbol category. We don't hardcode the actual valid
// integers here (verified above but subject to backend change) — we
// just reject obviously invalid input loudly. Range validation against
// the live contracts_for response is Part 2's payload-builder job.
function _validateMultiplierOpts(opts) {
    const errs = [];
    if (!opts || typeof opts !== 'object') {
        errs.push('opts must be an object');
        return errs;
    }
    if (!opts.symbol || typeof opts.symbol !== 'string') {
        errs.push('symbol must be a non-empty string');
    }
    const dir = String(opts.direction || '').toLowerCase();
    if (dir !== 'up' && dir !== 'down') {
        errs.push("direction must be 'up' or 'down'");
    }
    const stake = Number(opts.stake);
    if (!Number.isFinite(stake) || stake <= 0) {
        errs.push('stake must be a positive finite number');
    }
    const mult = Number(opts.multiplier);
    if (!Number.isFinite(mult) || mult <= 0 || !Number.isInteger(mult)) {
        errs.push('multiplier must be a positive integer');
    }
    // takeProfit/stopLoss are optional. If supplied they must be > 0.
    if (opts.takeProfit != null) {
        const tp = Number(opts.takeProfit);
        if (!Number.isFinite(tp) || tp <= 0) errs.push('takeProfit must be > 0 if supplied');
    }
    if (opts.stopLoss != null) {
        const sl = Number(opts.stopLoss);
        if (!Number.isFinite(sl) || sl <= 0) errs.push('stopLoss must be > 0 if supplied');
    }
    return errs;
}

/**
 * placeMultiplier — proposal → buy for a MULTUP/MULTDOWN contract.
 *
 * Unlike binary CALL/PUT, this function returns AS SOON AS THE BUY IS
 * CONFIRMED. There is no settlement polling — Multipliers have no
 * expiry, and the cron tick (Part 2) will inspect each open position
 * fresh on every invocation via getOpenPositionState().
 *
 * @param {WebSocket} ws    Open Deriv WS (already authenticated via OTP)
 * @param {object} opts
 *   @param {string}  opts.symbol       Deriv symbol (e.g. 'R_100', 'frxEURUSD')
 *   @param {string}  opts.direction    'up' (MULTUP) | 'down' (MULTDOWN)
 *   @param {number}  opts.stake        Stake in account currency (USD on this account)
 *   @param {number}  opts.multiplier   Integer multiplier (e.g. 100, 200; per contracts_for)
 *   @param {number} [opts.takeProfit]  Optional $-amount of profit at which the
 *                                      position auto-closes. Omit to set no TP.
 *   @param {number} [opts.stopLoss]    Optional $-amount of loss at which the
 *                                      position auto-closes. Omit to set no SL
 *                                      (stop_out still applies — see notes above).
 *   @param {string} [opts.currency='USD']
 * @returns {{ proposal: object, buy: object }}
 */

/* Parse Deriv's ContractBuyValidationError ceiling message.
   Real shape observed live (cryBTCUSD x200/x300 on a ~$9.9k account):
     "Enter an amount equal to or lower than 19.40."
     "Enter an amount equal to or lower than 8.59."

   ⚠️ CRITICAL DISAMBIGUATION (v4 fix):
   Deriv uses the EXACT same wording for THREE different cap classes:
     • per-contract MAX STAKE        (drives stake clamping)
     • per-contract MAX TAKE PROFIT  (drives limit_order.take_profit clamping)
     • per-contract MAX STOP LOSS    (drives limit_order.stop_loss  clamping)
   The number alone does not tell us which one. Earlier versions of
   this code assumed it was always the stake cap and shrank stake
   (+ proportionally TP/SL) on every match — which is wrong when the
   real offender is just an out-of-range TP/SL. We now disambiguate
   by ALSO reading proposal.validation_params.{take_profit,stop_loss,stake}
   from the proposal response (see Layer 2 clamp below), and treat the
   error text only as a fallback. Returns a positive finite number or null. */
function _extractMaxAmountFromError(message) {
    if (typeof message !== 'string') return null;
    // Tolerant of comma thousands separators (e.g. "1,234.56") and a
    // trailing period from the surrounding sentence. We capture a run
    // of digits/commas optionally followed by a decimal part.
    const m = message.match(/equal\s+to\s+or\s+lower\s+than\s+([0-9][0-9,]*(?:\.[0-9]+)?)/i);
    if (!m) return null;
    const n = Number(String(m[1]).replace(/,/g, ''));
    return Number.isFinite(n) && n > 0 ? n : null;
}

/* Backwards-compat alias — old name retained so the existing
   _handleStakeCapError flow doesn't break. Same semantics as
   _extractMaxAmountFromError; renamed to reflect that the cap may
   refer to stake OR TP OR SL. */
const _extractMaxStakeFromError = _extractMaxAmountFromError;

/* Dual of the above for "equal to or higher than X" — a value too
   SMALL for the contract (multipliers carry per-contract minimum
   stake/TP/SL, distinct from config.stake.absolute_min). Same
   disambiguation caveat as the max-side parser. */
function _extractMinStakeFromError(message) {
    if (typeof message !== 'string') return null;
    const m = message.match(/equal\s+to\s+or\s+(?:higher|greater)\s+than\s+([0-9][0-9,]*(?:\.[0-9]+)?)/i);
    if (!m) return null;
    const n = Number(String(m[1]).replace(/,/g, ''));
    return Number.isFinite(n) && n > 0 ? n : null;
}

/* Classify whether an error message indicates a recoverable cap
   problem (stake OR take_profit OR stop_loss too high) that we can
   address by re-proposing with clamped values. Deriv emits several
   wordings — we accept any with a numeric ceiling. The downstream
   handler disambiguates stake-vs-TP-vs-SL via validation_params. */
function _isStakeCapError(message) {
    if (typeof message !== 'string') return false;
    return /ContractBuyValidationError|InvalidStake|stake|amount|profit|loss/i.test(message)
        && /equal\s+to\s+or\s+lower\s+than\s+[0-9]/i.test(message);
}

/* Parse the validation_params block from a multiplier proposal
   response into a normalised {stake, take_profit, stop_loss} object
   where each sub-field is { min: number|null, max: number|null }.

   Deriv returns these as strings ("0.10", "1000.00"); we Number()
   them once here and tolerate missing sub-fields (not every symbol /
   multiplier combo populates every range). Returns null if the
   validation_params object itself is absent.

   Schema reference:
     https://developers.deriv.com/schemas/proposal_response.schema.json
     → properties.proposal.properties.validation_params */
function _parseValidationParams(prop) {
    const vp = prop && prop.validation_params;
    if (!vp || typeof vp !== 'object') return null;
    const _num = (s) => {
        if (s == null) return null;
        const n = Number(s);
        return Number.isFinite(n) ? n : null;
    };
    const _range = (obj) => {
        if (!obj || typeof obj !== 'object') return null;
        const min = _num(obj.min);
        const max = _num(obj.max);
        if (min == null && max == null) return null;
        return { min, max };
    };
    const out = {
        stake:       _range(vp.stake),
        take_profit: _range(vp.take_profit),
        stop_loss:   _range(vp.stop_loss),
    };
    if (!out.stake && !out.take_profit && !out.stop_loss) return null;
    return out;
}

/* Clamp a number into [min, max], floored to 2 decimals. Returns the
   clamped value. Treats null bounds as unbounded on that side. */
function _clampToRange(value, range) {
    if (!range) return value;
    let v = Number(value);
    if (!Number.isFinite(v)) return value;
    // Safety inset INSIDE the broker range (mirrors the stake-cap fix v3):
    // Deriv's bounds are recomputed every proposal based on spot/vol, so
    // landing EXACTLY on the boundary frequently fails on the next round.
    // Apply a small inset of 2% of the band width (floor 1¢) on both ends.
    const SAFETY_INSET_RATIO = 0.02;
    const SAFETY_INSET_MIN   = 0.01;
    const band = (range.max != null && range.min != null)
        ? Math.max(0, range.max - range.min) : 0;
    const inset = Math.max(SAFETY_INSET_MIN, _floor2(band * SAFETY_INSET_RATIO));
    if (range.min != null) {
        const lo = _floor2(range.min + inset);
        if (v < lo) v = lo;
    }
    if (range.max != null) {
        const hi = _floor2(range.max - inset);
        if (v > hi) v = hi;
    }
    return _floor2(v);
}

/* Apply validation_params to a limit_order. Returns:
     {
       limit_order: <possibly-modified copy>,
       adjustments: { take_profit?: {from,to,reason}, stop_loss?: {from,to,reason} },
       changed: boolean
     }
   Skips fields not present in input limit_order (and fields that are
   `null`, which is the explicit "clear" sentinel for contract_update). */
function _applyTpSlRanges(limit_order, vp) {
    const out = { limit_order, adjustments: {}, changed: false };
    if (!limit_order || !vp) return out;
    const next = { ...limit_order };
    if (limit_order.take_profit != null && vp.take_profit) {
        const before = Number(limit_order.take_profit);
        const after  = _clampToRange(before, vp.take_profit);
        if (Number.isFinite(after) && after > 0 && Math.abs(after - before) > 1e-9) {
            next.take_profit = after;
            out.adjustments.take_profit = {
                from: before, to: after,
                range: { min: vp.take_profit.min, max: vp.take_profit.max },
                reason: 'validation_params.take_profit',
            };
            out.changed = true;
        }
    }
    if (limit_order.stop_loss != null && vp.stop_loss) {
        const before = Number(limit_order.stop_loss);
        const after  = _clampToRange(before, vp.stop_loss);
        if (Number.isFinite(after) && after > 0 && Math.abs(after - before) > 1e-9) {
            next.stop_loss = after;
            out.adjustments.stop_loss = {
                from: before, to: after,
                range: { min: vp.stop_loss.min, max: vp.stop_loss.max },
                reason: 'validation_params.stop_loss',
            };
            out.changed = true;
        }
    }
    out.limit_order = next;
    return out;
}

/* probeMultiplierRanges — send a TP/SL-LESS proposal to discover the
   live validation_params (stake / take_profit / stop_loss ranges) for
   a given {symbol, direction, stake, multiplier}. Used by the runner
   BEFORE asking the AI, so the AI's TP/SL suggestions are already
   inside the live range.

   Returns null on failure; on success returns:
     { ranges: {stake, take_profit, stop_loss}, spot, ask_price, commission }
   The proposal IS NOT bought — we just read the ranges and discard
   the proposal id. Each call is a single round-trip (~50-100ms). */
async function probeMultiplierRanges(ws, { symbol, direction, stake, multiplier, currency }) {
    if (!symbol) throw new Error('probeMultiplierRanges: symbol required');
    const dir = String(direction || '').toLowerCase();
    if (dir !== 'up' && dir !== 'down') {
        throw new Error("probeMultiplierRanges: direction must be 'up' or 'down'");
    }
    const contractType = dir === 'up' ? 'MULTUP' : 'MULTDOWN';
    const s = Number(stake);
    const m = Number(multiplier);
    if (!Number.isFinite(s) || s <= 0) throw new Error('probeMultiplierRanges: invalid stake');
    if (!Number.isFinite(m) || m <= 0 || !Number.isInteger(m)) {
        throw new Error('probeMultiplierRanges: invalid multiplier');
    }
    try {
        const reply = await request(ws, {
            proposal:          1,
            amount:            s,
            basis:             'stake',
            contract_type:     contractType,
            currency:          currency || 'USD',
            underlying_symbol: symbol,
            multiplier:        m,
        }, 15000);
        const prop = reply && reply.proposal;
        if (!prop) return null;
        const vp = _parseValidationParams(prop);
        return {
            ranges:     vp,
            spot:       Number(prop.spot),
            ask_price:  Number(prop.ask_price),
            commission: prop.commission != null ? Number(prop.commission) : null,
        };
    } catch (e) {
        Logger.warn('probeMultiplierRanges failed', {
            symbol, multiplier: m, stake: s, direction: dir,
            error: e && e.message,
        });
        return null;
    }
}

/* Floor a number to 2 decimal places.
   Deriv quotes caps with 2-decimal precision (e.g. "9.70"), but JS
   floating-point can turn `9.70 * 100` into `969.9999…`, which then
   floors to 9.69 — losing a cent against the broker's stated ceiling
   for no good reason. Snap to the nearest 2-decimal grid first; only
   floor if the value is *meaningfully* above the grid point. */
function _floor2(n) {
    const x = Number(n) * 100;
    const rounded = Math.round(x);
    // If the floating-point error is tiny (<1e-6 of a cent), the
    // mathematically-correct value IS the rounded one. Otherwise we
    // genuinely need to truncate downward.
    return (Math.abs(x - rounded) < 1e-6 ? rounded : Math.floor(x)) / 100;
}

/* v5 fix — removed `_scaleLimitOrder` (and the entire stake-auto-scale
   retry loop). v1–v3 of this module incorrectly responded to the
   `"Enter an amount equal to or lower than X"` error by shrinking the
   STAKE and proportionally scaling TP/SL. That was a misdiagnosis —
   Deriv reuses the same error wording for stake / take_profit /
   stop_loss caps, and in the cryBTCUSD ×200/×300 reproduction the cap
   that was being violated was the STOP_LOSS, not the stake. Shrinking
   the stake never made the loop converge because the SL was still
   out of range relative to the new (smaller) stake too — the loop
   exhausted its 10-attempt budget and bubbled up
   "stake auto-scale exhausted after 10 attempts". v5 replaces that
   logic with an authoritative pre-flight probe of
   `validation_params.{stake,take_profit,stop_loss}` plus a clamp of
   the outgoing limit_order BEFORE the buy is even attempted, so the
   broker never has a reason to raise the cap error in the first
   place. See TP_SL_RANGE_FIX_V5.md for the full rationale. */

/* placeMultiplier — proposal → buy for a MULTUP/MULTDOWN contract.

   ──────────────────────────────────────────────────────────────────────
   v5 redesign (the REAL fix for the cryBTCUSD ×200/×300 OPEN FAILED bug)
   ──────────────────────────────────────────────────────────────────────

   The legacy v1–v3 implementation treated the broker error
      "Enter an amount equal to or lower than X"
   as ALWAYS being a stake cap, and shrank the stake (proportionally
   scaling TP/SL) inside a 10-attempt retry loop. That diagnosis was
   incorrect: Deriv uses the IDENTICAL error wording for three caps
   (stake / take_profit / stop_loss) and on cryBTCUSD ×200/×300 the
   actual offender was the STOP_LOSS range. Shrinking the stake
   never resolved the SL-range violation, so the loop chewed through
   its budget and bubbled up:
        "placeMultiplier: stake auto-scale exhausted after 10 attempts"

   v5 removes the loop entirely and replaces it with the authoritative
   pre-flight clamp:

      1.  Build the limit_order from the caller's TP/SL (if any).
      2.  Send a TP/SL-LESS proposal at the actual stake to read the
          live `validation_params.{stake,take_profit,stop_loss}` for
          *this* {symbol, direction, stake, multiplier, spot} tuple.
      3.  If the caller's stake is already above `vp.stake.max`, the
          trade is fundamentally too large — we DO NOT silently shrink
          it (that would spend less of the user's money than they
          sized for and hide a real risk-management issue). We throw
          a clean `StakeAboveMax` error and let the runner surface it.
      4.  Clamp the limit_order's take_profit and stop_loss into the
          live `vp.take_profit` and `vp.stop_loss` ranges (with a
          2 % safety inset inside the band — Deriv recomputes the
          range each tick, so landing on the boundary is fragile).
      5.  Send the REAL proposal (now including the in-range
          limit_order). If Deriv STILL echoes a tighter
          validation_params on this second proposal, re-clamp once
          and send a third proposal. We re-clamp at most twice; if
          the third proposal still rejects we surface the broker
          error verbatim — that means the live range has tightened
          beyond what we can satisfy and the user should resize.
      6.  Buy.

   There is no `_applyClamp`, no `_scaleLimitOrder`, no
   `_handleStakeCapError` legacy fallback, no MAX_ATTEMPTS. The caller's
   stake is RESPECTED; only TP/SL are adjusted. If the buy fails it
   fails with the broker's real reason, not a manufactured
   "auto-scale exhausted" message.
*/
async function placeMultiplier(ws, opts) {
    const errs = _validateMultiplierOpts(opts);
    if (errs.length) throw new Error('placeMultiplier: ' + errs.join('; '));

    const symbol     = opts.symbol;
    const dir        = String(opts.direction).toLowerCase();
    const contractType = dir === 'up' ? 'MULTUP' : 'MULTDOWN';
    const stake      = Number(opts.stake);    // v5: IMMUTABLE — never auto-scaled
    const multiplier = Number(opts.multiplier);
    const currency   = opts.currency || 'USD';

    // Build the initial limit_order. Mutable across the (very short)
    // re-clamp path, but ONLY tp/sl are touched — never the stake.
    let limit_order;
    const requestedTP = opts.takeProfit != null ? Number(opts.takeProfit) : null;
    const requestedSL = opts.stopLoss   != null ? Number(opts.stopLoss)   : null;
    if (requestedTP != null || requestedSL != null) {
        limit_order = {};
        if (requestedTP != null) limit_order.take_profit = requestedTP;
        if (requestedSL != null) limit_order.stop_loss   = requestedSL;
    }

    // Track adjustments so the runner / Telegram can render a soft
    // "TP/SL clamped" subline instead of a silent surprise.
    const tpSlAdjustments = { take_profit: null, stop_loss: null };
    const _recordAdj = (clampResult) => {
        if (!clampResult || !clampResult.changed) return;
        if (clampResult.adjustments.take_profit) {
            tpSlAdjustments.take_profit = clampResult.adjustments.take_profit;
        }
        if (clampResult.adjustments.stop_loss) {
            tpSlAdjustments.stop_loss = clampResult.adjustments.stop_loss;
        }
    };

    /* Helper: build the proposal request from the *current* stake and
       limit_order. Pass `withLimitOrder=false` for the initial probe
       proposal — we want validation_params for the unconstrained
       contract so we can size TP/SL into the live range. */
    const buildProposalReq = (withLimitOrder = true) => {
        const req = {
            proposal:          1,
            amount:            stake,
            basis:             'stake',
            contract_type:     contractType,
            currency,
            underlying_symbol: symbol,
            multiplier,
        };
        if (withLimitOrder && limit_order) req.limit_order = limit_order;
        return req;
    };

    /* ────────────────────────────────────────────────────────────────
       Step 1 — probe proposal: TP/SL-less, just to read the live
       validation_params at our actual stake. This single round-trip
       gives us the AUTHORITATIVE ranges — no guessing, no retrying.
       ──────────────────────────────────────────────────────────────── */
    let probeReply;
    try {
        probeReply = await request(ws, buildProposalReq(false), 15000);
    } catch (e) {
        // The probe proposal carries no limit_order, so any error here
        // is either a stake-out-of-range or a genuine transport/auth
        // failure. Bubble up untouched — there is nothing to clamp.
        throw e;
    }
    const probeProp = probeReply && probeReply.proposal;
    if (!probeProp || !probeProp.id) {
        throw new Error('placeMultiplier probe: no proposal id returned');
    }
    const probeVp = _parseValidationParams(probeProp);

    /* Step 2 — explicit stake-range check. If the caller's stake is
       genuinely outside vp.stake.{min,max}, we surface a clean error
       INSTEAD of silently rewriting the user's stake (which the v1–v3
       loop did and was the root cause of the user's complaint). */
    if (probeVp && probeVp.stake) {
        const { min: sMin, max: sMax } = probeVp.stake;
        if (sMax != null && stake > sMax) {
            throw new Error(
                `placeMultiplier: stake ${stake} above broker max ${sMax} ` +
                `for ${symbol} ×${multiplier} (range $${sMin ?? '?'}–$${sMax}). ` +
                'Resize the trade or pick a lower multiplier.'
            );
        }
        if (sMin != null && stake < sMin) {
            throw new Error(
                `placeMultiplier: stake ${stake} below broker min ${sMin} ` +
                `for ${symbol} ×${multiplier}.`
            );
        }
    }

    /* Step 3 — clamp the OUTGOING limit_order into the live ranges
       BEFORE we send the real proposal. This is the entire fix:
       Deriv will see in-range values and accept the buy without ever
       raising the cap error. */
    if (limit_order && probeVp) {
        const clamp = _applyTpSlRanges(limit_order, probeVp);
        if (clamp.changed) {
            Logger.warn('placeMultiplier: clamping TP/SL into broker ranges (v5 pre-flight)', {
                symbol, multiplier, stake,
                adjustments: clamp.adjustments,
                vp: probeVp,
            });
            limit_order = clamp.limit_order;
            _recordAdj(clamp);
        }
    }

    /* ────────────────────────────────────────────────────────────────
       Step 4 — REAL proposal with the (now in-range) limit_order.
       In the overwhelming majority of cases this is the only proposal
       that matters; the probe + clamp above guarantees the broker's
       validators are satisfied at submission time.

       Edge case: between the probe and the real proposal (~100ms on
       a healthy WS) Deriv may have re-computed the range due to spot
       movement on a volatile symbol. If the new vp shows our clamped
       values now fall outside, we re-clamp once and re-propose. We do
       this at most ONCE — a second tightening within ~200ms means the
       trade is in a regime our chosen TP/SL cannot satisfy at all, and
       we surface the broker error verbatim instead of looping.
       ──────────────────────────────────────────────────────────────── */
    const MAX_RECLAMP = 1; // single re-clamp; no stake auto-scale, ever
    let prop, propReply;
    for (let reclamp = 0; reclamp <= MAX_RECLAMP; reclamp++) {
        try {
            propReply = await request(ws, buildProposalReq(true), 15000);
        } catch (e) {
            // No retry — the broker's reason is the source of truth.
            // (The probe already ruled out stake-range issues, so this
            // is almost certainly a transient WS issue or a true
            // validator failure on an edge symbol.)
            throw e;
        }
        prop = propReply && propReply.proposal;
        if (!prop || !prop.id) {
            throw new Error('placeMultiplier proposal: no id returned');
        }
        const vp = _parseValidationParams(prop);

        // Re-clamp once if the live range has tightened relative to
        // the probe (rare on a calm market, possible on cryBTCUSD).
        if (reclamp < MAX_RECLAMP && limit_order && vp) {
            const clamp = _applyTpSlRanges(limit_order, vp);
            if (clamp.changed) {
                Logger.warn('placeMultiplier: range tightened between probe and proposal — re-clamping', {
                    symbol, multiplier, stake,
                    adjustments: clamp.adjustments,
                });
                limit_order = clamp.limit_order;
                _recordAdj(clamp);
                continue; // re-propose with the tightened values
            }
        }

        Logger.trade(`Multiplier proposal accepted ${symbol} ${contractType} ×${multiplier}`, {
            stake,
            ask_price:         prop.ask_price,
            spot:              prop.spot,
            commission:        prop.commission,
            limit_order:       prop.limit_order,
            validation_params: vp,
            reclamp_iterations: reclamp,
        });
        break;
    }

    /* ────────────────────────────────────────────────────────────────
       Step 5 — BUY at the quoted ask_price. No retry on this step
       either: any error here is either a genuine race (handled by
       higher-level retries in the runner) or a real validation failure
       that the user must see verbatim.
       ──────────────────────────────────────────────────────────────── */
    let buyReply;
    try {
        buyReply = await request(ws, {
            buy:   prop.id,
            price: Number(prop.ask_price),
        }, 15000);
    } catch (e) {
        throw e;
    }

    const buy = buyReply && buyReply.buy;
    if (!buy || buy.contract_id == null) {
        throw new Error('placeMultiplier buy: reply missing contract_id (raw=' +
            JSON.stringify(buyReply).slice(0, 240) + ')');
    }
    const _buyPrice = Number(buy.buy_price);
    if (!Number.isFinite(_buyPrice) || _buyPrice <= 0) {
        throw new Error('placeMultiplier buy: reply has no valid buy_price (got ' +
            JSON.stringify(buy.buy_price) + '), refusing to treat as success');
    }

    const tpAdjusted = tpSlAdjustments.take_profit != null;
    const slAdjusted = tpSlAdjustments.stop_loss   != null;
    const wasClamped = tpAdjusted || slAdjusted;

    Logger.trade(`Multiplier placed: contract_id=${buy.contract_id}`, {
        symbol,
        direction:        dir,
        contract_type:    contractType,
        multiplier,
        stake,
        final_limit_order: limit_order,
        tp_sl_clamped:    wasClamped,
        transaction_id:   buy.transaction_id,
        longcode:         buy.longcode,
    });

    /* v5 metadata — TP/SL clamping only. The legacy
       `_aurelia_stake_clamp` shape is preserved for the runner /
       Telegram template, but `requested_stake === final_stake` is now
       always true (stake is never auto-scaled). The TP/SL fields
       reflect the actual pre-flight clamp. */
    buy._aurelia_stake_clamp = wasClamped
        ? {
            requested_stake:       stake,   // never changed in v5
            final_stake:           stake,
            requested_take_profit: requestedTP,
            requested_stop_loss:   requestedSL,
            final_take_profit:     limit_order && limit_order.take_profit != null ? limit_order.take_profit : null,
            final_stop_loss:       limit_order && limit_order.stop_loss   != null ? limit_order.stop_loss   : null,
            // New in v5 — lets downstream consumers know the adjustment
            // was on TP/SL only (the stake was untouched).
            kind: 'tp_sl_clamp',
            adjustments: {
                take_profit: tpSlAdjustments.take_profit,
                stop_loss:   tpSlAdjustments.stop_loss,
            },
        }
        : null;

    return { proposal: prop, buy };
}

/**
 * closeMultiplier — sell an open Multiplier at market.
 *
 * Deriv's `sell` endpoint requires both `sell` (contract_id) and
 * `price` per the JSON schema. `price: 0` means "sell at market"
 * (Deriv's documented sentinel). There is no partial-close — calling
 * sell always closes the FULL position.
 *
 * @param {WebSocket} ws
 * @param {number} contractId
 * @param {object} [opts]
 *   @param {number} [opts.minPrice]  Minimum acceptable sell price.
 *                                    Defaults to 0 (market). Pass a
 *                                    positive number to act as a slippage
 *                                    floor; the sell will fail if the
 *                                    bid drops below.
 * @returns {object} sell reply body (sold_for, balance_after, ...)
 */
async function closeMultiplier(ws, contractId, opts) {
    const cid = Number(contractId);
    if (!Number.isFinite(cid) || cid <= 0) {
        throw new Error('closeMultiplier: invalid contractId');
    }
    const price = (opts && Number.isFinite(Number(opts.minPrice)))
        ? Number(opts.minPrice)
        : 0;
    Logger.trade(`Closing multiplier contract ${cid}`, { min_price: price });
    const reply = await request(ws, { sell: cid, price }, 15000);
    const sell = reply.sell || {};
    if (!sell.contract_id) {
        // The schema makes sell-reply.sell optional (echo_req/msg_type
        // are the only required top-level fields), so guard explicitly.
        Logger.warn('closeMultiplier: sell reply missing sell.contract_id', { reply });
    } else {
        Logger.trade(`Multiplier closed: contract_id=${cid}`, {
            sold_for:       sell.sold_for,
            balance_after:  sell.balance_after,
            transaction_id: sell.transaction_id,
        });
    }
    return sell;
}

/**
 * reviseMultiplierLimits — adjust TP/SL on an open Multiplier.
 *
 * Verified against contract_update_request.schema.json:
 *   • limit_order.take_profit and limit_order.stop_loss are each
 *     independently optional inside limit_order.
 *   • Pass `null` to CANCEL (remove) an existing TP or SL.
 *   • OMIT a field to leave it unchanged.
 *
 * To preserve that semantic clearly, this function accepts:
 *   • takeProfit / stopLoss === undefined  → field omitted from request
 *   • takeProfit / stopLoss === null       → null sent (cancels limit)
 *   • takeProfit / stopLoss === number     → number sent (sets/replaces)
 *
 * Refusing to send any update at all (both undefined) is a programmer
 * error and throws — Part 2's decision loop should not be calling this
 * with a no-op.
 *
 * @param {WebSocket} ws
 * @param {number} contractId
 * @param {object} changes
 *   @param {number|null|undefined} changes.takeProfit
 *   @param {number|null|undefined} changes.stopLoss
 * @returns {object} contract_update reply body
 */
async function reviseMultiplierLimits(ws, contractId, changes) {
    const cid = Number(contractId);
    if (!Number.isFinite(cid) || cid <= 0) {
        throw new Error('reviseMultiplierLimits: invalid contractId');
    }
    const c = changes || {};
    const hasTP = Object.prototype.hasOwnProperty.call(c, 'takeProfit');
    const hasSL = Object.prototype.hasOwnProperty.call(c, 'stopLoss');
    if (!hasTP && !hasSL) {
        throw new Error('reviseMultiplierLimits: nothing to update (pass takeProfit and/or stopLoss)');
    }
    const limit_order = {};
    if (hasTP) {
        const tp = c.takeProfit;
        if (tp !== null && (!Number.isFinite(Number(tp)) || Number(tp) <= 0)) {
            throw new Error('reviseMultiplierLimits: takeProfit must be null (clear) or a positive number');
        }
        limit_order.take_profit = (tp === null) ? null : Number(tp);
    }
    if (hasSL) {
        const sl = c.stopLoss;
        if (sl !== null && (!Number.isFinite(Number(sl)) || Number(sl) <= 0)) {
            throw new Error('reviseMultiplierLimits: stopLoss must be null (clear) or a positive number');
        }
        limit_order.stop_loss = (sl === null) ? null : Number(sl);
    }

    Logger.trade(`Revising multiplier limits contract_id=${cid}`, { limit_order });
    const reply = await request(ws, {
        contract_update: 1,
        contract_id:     cid,
        limit_order,
    }, 15000);
    const cu = reply.contract_update || {};
    Logger.trade(`Multiplier limits revised contract_id=${cid}`, {
        take_profit: cu.take_profit ? cu.take_profit.order_amount : undefined,
        stop_loss:   cu.stop_loss   ? cu.stop_loss.order_amount   : undefined,
    });
    return cu;
}

/**
 * getOpenPositionState — single-shot, side-effect-free read of an open
 * multiplier's current state. Wraps proposal_open_contract and returns
 * a clean normalized object suitable for handing straight to the AI
 * prompt builder in Part 2.
 *
 * Numeric fields in the raw POC reply are JSON strings (Deriv returns
 * money values as strings to preserve precision) — this function
 * coerces them to Number so callers don't have to.
 *
 * @param {WebSocket} ws
 * @param {number} contractId
 * @returns {object} normalized snapshot. Shape:
 *   {
 *     contract_id, contract_type, symbol, multiplier,
 *     direction: 'up'|'down',
 *     is_open: boolean,    // !is_sold && !is_expired (best-effort)
 *     is_sold: boolean,
 *     is_expired: boolean,
 *     is_valid_to_sell: boolean,
 *     is_valid_to_cancel: boolean,
 *     status,              // 'open'|'sold'|'won'|'lost'|null
 *     buy_price, bid_price, sell_price,
 *     profit, profit_percentage,
 *     current_spot, current_spot_time,
 *     entry_spot, date_start, date_expiry,
 *     take_profit: { amount: number, value: number, order_date: epoch } | null,
 *     stop_loss:   { amount: number, value: number, order_date: epoch } | null,
 *     stop_out:    { amount: number, value: number, order_date: epoch } | null,
 *     longcode,
 *     raw,                 // full poc payload for advanced consumers
 *   }
 */
async function getOpenPositionState(ws, contractId) {
    const cid = Number(contractId);
    if (!Number.isFinite(cid) || cid <= 0) {
        throw new Error('getOpenPositionState: invalid contractId');
    }
    const r = await request(ws, {
        proposal_open_contract: 1,
        contract_id:            cid,
    }, 12000);
    const poc = r.proposal_open_contract || {};
    return _normalizePoc(poc);
}

function _num(v) {
    if (v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

function _normalizeLimitOrderEntry(entry) {
    if (!entry || typeof entry !== 'object') return null;
    return {
        amount:     _num(entry.order_amount),
        value:      _num(entry.value),       // price-level barrier (string in raw)
        order_date: _num(entry.order_date),
    };
}

function _normalizePoc(poc) {
    const lo = poc.limit_order || {};
    const ct = String(poc.contract_type || '').toUpperCase();
    const direction = ct === 'MULTUP'   ? 'up'
                    : ct === 'MULTDOWN' ? 'down'
                    : null;
    const isSold    = !!poc.is_sold;
    const isExpired = !!poc.is_expired;
    return {
        contract_id:        poc.contract_id  != null ? Number(poc.contract_id) : null,
        contract_type:      ct || null,
        symbol:             poc.underlying || poc.symbol || null,
        multiplier:         _num(poc.multiplier),
        direction,
        is_open:            !isSold && !isExpired,
        is_sold:            isSold,
        is_expired:         isExpired,
        is_valid_to_sell:   !!poc.is_valid_to_sell,
        is_valid_to_cancel: !!poc.is_valid_to_cancel,
        status:             poc.status || null,
        buy_price:          _num(poc.buy_price),
        bid_price:          _num(poc.bid_price),
        sell_price:         _num(poc.sell_price),
        profit:             _num(poc.profit),
        profit_percentage:  _num(poc.profit_percentage),
        current_spot:       _num(poc.current_spot),
        current_spot_time:  _num(poc.current_spot_time),
        entry_spot:         _num(poc.entry_spot),
        date_start:         _num(poc.date_start),
        date_expiry:        _num(poc.date_expiry),
        take_profit:        _normalizeLimitOrderEntry(lo.take_profit),
        stop_loss:          _normalizeLimitOrderEntry(lo.stop_loss),
        stop_out:           _normalizeLimitOrderEntry(lo.stop_out),
        longcode:           poc.longcode || null,
        raw:                poc,
    };
}

module.exports = {
    listAccounts,
    getOtpUrl,
    connect,
    ensureOpen,
    request,
    ticksHistory,
    rawTicks,
    getBalance,
    // Legacy binary path (kept intact for reference and migration):
    placeTrade,
    // Multipliers — new in this fork:
    placeMultiplier,
    closeMultiplier,
    reviseMultiplierLimits,
    getOpenPositionState,
    // v4 fix — pre-flight TP/SL range discovery (called by the runner
    // BEFORE asking the AI to size TP/SL):
    probeMultiplierRanges,
    // Internal helpers exported for unit-testability:
    _normalizePoc,
    _validateMultiplierOpts,
    _extractMaxStakeFromError,
    _extractMaxAmountFromError,
    _extractMinStakeFromError,
    _parseValidationParams,
    _applyTpSlRanges,
    _clampToRange,
    _guardSensitiveRequest,
    _ALLOWED_TOP_KEYS,
    close,
};
