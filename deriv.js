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

/* Parse Deriv's ContractBuyValidationError stake-cap message.
   Real shape observed live (cryBTCUSD x200 on a ~$9.9k account):
     "Enter an amount equal to or lower than 19.40."
   The number is the per-trade absolute ceiling Deriv will accept for
   this {symbol, multiplier, balance} tuple. We extract it so the
   caller can re-propose with a clamped stake instead of bubbling up a
   hard failure. Returns a positive finite number or null. */
function _extractMaxStakeFromError(message) {
    if (typeof message !== 'string') return null;
    // Tolerant of comma thousands separators (e.g. "1,234.56") and a
    // trailing period from the surrounding sentence. We capture a run
    // of digits/commas optionally followed by a decimal part.
    const m = message.match(/equal\s+to\s+or\s+lower\s+than\s+([0-9][0-9,]*(?:\.[0-9]+)?)/i);
    if (!m) return null;
    const n = Number(String(m[1]).replace(/,/g, ''));
    return Number.isFinite(n) && n > 0 ? n : null;
}

/* Dual of the above for "equal to or higher than X" — a stake too
   SMALL for the multiplier (multipliers carry a per-contract minimum
   stake, distinct from config.stake.absolute_min). */
function _extractMinStakeFromError(message) {
    if (typeof message !== 'string') return null;
    const m = message.match(/equal\s+to\s+or\s+(?:higher|greater)\s+than\s+([0-9][0-9,]*(?:\.[0-9]+)?)/i);
    if (!m) return null;
    const n = Number(String(m[1]).replace(/,/g, ''));
    return Number.isFinite(n) && n > 0 ? n : null;
}

/* Classify whether an error message indicates a stake-cap problem that
   we can recover from by re-proposing at a lower stake.
   Deriv emits several wordings for this class of error — we accept any
   of them as long as a numeric ceiling can be extracted. The list is
   intentionally permissive: false positives just trigger a harmless
   re-propose loop that will fail again, while false negatives let a
   recoverable error bubble up as OPEN FAILED (the regression we are
   fixing). */
function _isStakeCapError(message) {
    if (typeof message !== 'string') return false;
    return /ContractBuyValidationError|InvalidStake|stake|amount/i.test(message)
        && /equal\s+to\s+or\s+lower\s+than\s+[0-9]/i.test(message);
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

/* Scale TP/SL proportionally when stake is clamped down by Deriv.
   Multiplier TP/SL are absolute USD profit/loss thresholds, NOT
   ratios — but Deriv enforces per-contract max_take_profit /
   max_stop_loss limits that scale with stake. When we shrink the
   stake by ratio R, we shrink the limit_order amounts by the same R
   so they stay inside the new ceiling.

   Returns a new limit_order object or undefined if input was undefined.
   Skips fields that are already null (=cancel sentinel) or undefined. */
function _scaleLimitOrder(limit_order, ratio) {
    if (!limit_order || !(ratio > 0) || ratio >= 1) return limit_order;
    const out = {};
    if (limit_order.take_profit != null) {
        const tp = Number(limit_order.take_profit) * ratio;
        out.take_profit = Math.max(0.01, _floor2(tp));
    }
    if (limit_order.stop_loss != null) {
        const sl = Number(limit_order.stop_loss) * ratio;
        out.stop_loss = Math.max(0.01, _floor2(sl));
    }
    return out;
}

async function placeMultiplier(ws, opts) {
    const errs = _validateMultiplierOpts(opts);
    if (errs.length) throw new Error('placeMultiplier: ' + errs.join('; '));

    const symbol     = opts.symbol;
    const dir        = String(opts.direction).toLowerCase();
    const contractType = dir === 'up' ? 'MULTUP' : 'MULTDOWN';
    const requestedStake = Number(opts.stake);   // original AI/runner stake — used to detect clamping later
    let   stake      = requestedStake;            // mutable: may be clamped down on Deriv-side rejection
    const multiplier = Number(opts.multiplier);
    const currency   = opts.currency || 'USD';

    // Build limit_order only if at least one of TP/SL is supplied.
    // Deriv's proposal accepts a partial limit_order (just TP, just SL,
    // or both) — verified live; the proposal reply only echoes back
    // the fields you set.
    // NB: `limit_order` is now MUTABLE so the auto-scale loop below can
    // shrink TP/SL proportionally when stake is clamped down. Deriv's
    // per-contract max_take_profit / max_stop_loss scale with stake, so
    // a $21 TP that was valid at $10 stake may be rejected at $9.70.
    let limit_order;
    if (opts.takeProfit != null || opts.stopLoss != null) {
        limit_order = {};
        if (opts.takeProfit != null) limit_order.take_profit = Number(opts.takeProfit);
        if (opts.stopLoss   != null) limit_order.stop_loss   = Number(opts.stopLoss);
    }

    /* Build the proposal request from the *current* stake. Re-invoked
       inside the retry loop below so each attempt picks up the latest
       clamped amount (and matching scaled TP/SL). */
    const buildProposalReq = () => {
        const req = {
            proposal:         1,
            amount:           stake,
            basis:            'stake',
            contract_type:    contractType,
            currency,
            underlying_symbol: symbol, // ← Deriv's unified schema uses `underlying_symbol`
                                       //   (the legacy `symbol` field is now rejected).
            multiplier,
        };
        if (limit_order) req.limit_order = limit_order;
        return req;
    };

    const ABS_MIN_STAKE = 0.35; // matches config.stake.absolute_min default

    /* Helper: apply a stake clamp + proportionally scale TP/SL.
       Mutates the outer `stake` and `limit_order`.

       The broker may quote its ceiling AT OR BELOW the current stake.
       We always clamp DOWN to `target` (never up). If `target == stake`
       (the broker quoted exactly what we sent, but still rejected),
       we shave one tick (1¢) to break the impasse — better than
       bubbling up an unrecoverable error to the user.

       Returns true on success, false only when the broker's cap is
       genuinely below our configured ABS_MIN_STAKE (in which case the
       trade cannot be honoured at all and the caller surfaces a clean
       explanatory error). */
    const _applyClamp = (newStakeRaw, reason) => {
        let target = _floor2(newStakeRaw);
        if (!(target > 0)) return false;

        // Broker quoted a ceiling >= current stake but still rejected.
        // Shave one tick so we make forward progress. This handles the
        // pathological case where Deriv returns the SAME number it
        // received (rare but observed) or rounds ambiguously.
        if (target >= stake) {
            target = _floor2(stake - 0.01);
            if (!(target > 0)) return false;
        }

        if (target < ABS_MIN_STAKE) {
            // Broker's cap is below our configured minimum stake. Bumping
            // UP to ABS_MIN_STAKE would still violate the broker's ceiling,
            // so we cannot honour this trade at all.
            return false;
        }
        const ratio = target / stake;
        const prevLO = limit_order ? { ...limit_order } : undefined;
        limit_order = _scaleLimitOrder(limit_order, ratio);
        Logger.warn('placeMultiplier: auto-scaling stake', {
            symbol, multiplier,
            from_stake: stake, to_stake: target,
            ratio: Number(ratio.toFixed(4)),
            from_limit_order: prevLO,
            to_limit_order:   limit_order,
            reason,
        });
        stake = target;
        return true;
    };

    /* ──────────────────────────────────────────────────────────────
       Auto-scale retry loop.
       Each iteration:
         1. Request a fresh proposal (proposal IDs are single-use).
         2. If validation_params.max_stake is present and < stake,
            clamp + restart the loop (re-propose at the new stake).
         3. Attempt buy. On ContractBuyValidationError that advertises
            a per-contract ceiling, clamp + restart.
         4. On any other error, bubble up untouched.
       The loop is bounded — after MAX_ATTEMPTS we give up so a
       pathological backend can't pin us in an infinite loop.
       ────────────────────────────────────────────────────────────── */
    const MAX_ATTEMPTS = 5;
    let propReply, prop, buyReply;
    let lastError = null;

    /* Shared handler for stake-cap errors raised by EITHER the proposal
       step OR the buy step. Deriv has been observed to enforce the
       per-contract stake ceiling at proposal time as well as at buy
       time (depending on symbol / multiplier / liquidity conditions),
       so we cannot assume the error only originates from the buy.

       Returns:
         • 'retry'  → caller should `continue` the outer loop (clamp applied).
         • 'throw'  → caller should rethrow the original error (not recoverable).
         •  string  → caller should throw a new Error with this message
                       (recoverable in principle but the broker's ceiling
                       is below our configured floor — clean explanation). */
    const _handleStakeCapError = (e) => {
        const msg = (e && e.message) ? String(e.message) : '';
        const capped  = _extractMaxStakeFromError(msg);
        const floored = _extractMinStakeFromError(msg);

        if (capped) {
            // Recoverable: Deriv told us the live ceiling. Clamp and
            // re-propose. The new proposal is at the safe stake, and
            // TP/SL are scaled by the same ratio so they don't
            // independently trip limit_order validation.
            // NB: We pass `capped` even if `capped >= stake` — the
            // clamp helper now shaves a tick in that pathological case
            // rather than refusing, so we always make forward progress.
            if (_applyClamp(capped, 'stake cap error')) {
                return 'retry';
            }
            return (
                `placeMultiplier: cannot satisfy stake cap ${capped} (below absolute min ${ABS_MIN_STAKE}) ` +
                `for ${symbol} x${multiplier}`
            );
        }

        if (floored && floored > stake) {
            // Stake was BELOW Deriv's per-contract minimum (rare).
            // We do NOT silently bump UP — that would spend more of
            // the user's money than they sized for. Surface clean.
            return (
                `placeMultiplier: stake ${stake} below Deriv min ${floored} for ${symbol} x${multiplier}`
            );
        }

        return 'throw'; // not a stake-cap error → bubble up untouched
    };

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        // 1) Proposal — wrapped in try/catch because Deriv may enforce
        //    the per-contract stake ceiling AT PROPOSAL TIME on some
        //    symbol/multiplier combinations (e.g. cryBTCUSD x200).
        //    Without this wrapper a proposal-time ContractBuyValidationError
        //    bubbles straight up to the runner as OPEN FAILED, bypassing
        //    the auto-scale loop entirely. This was the original bug.
        try {
            propReply = await request(ws, buildProposalReq(), 15000);
        } catch (e) {
            lastError = e;
            const verdict = _handleStakeCapError(e);
            if (verdict === 'retry') continue;
            if (verdict === 'throw') throw e;
            throw new Error(verdict);
        }
        prop = propReply && propReply.proposal;
        if (!prop || !prop.id) {
            throw new Error(`placeMultiplier proposal (attempt ${attempt}): no id returned`);
        }

        // 1b) Pre-emptive clamp from proposal.validation_params.max_stake.
        //     If Deriv volunteers the ceiling here, clamp and re-propose
        //     BEFORE sending the doomed buy. Best-effort — field is
        //     absent on many symbols.
        const vpMax = prop.validation_params && Number(prop.validation_params.max_stake);
        if (Number.isFinite(vpMax) && vpMax > 0 && stake > vpMax) {
            if (_applyClamp(vpMax, 'proposal.validation_params.max_stake')) {
                continue; // re-propose with new stake + scaled TP/SL
            }
            // _applyClamp refused (e.g. would clamp below ABS_MIN_STAKE) —
            // fall through to buy, Deriv will give us the authoritative error.
        }

        Logger.trade(`Multiplier proposal accepted ${symbol} ${contractType} x${multiplier} (attempt ${attempt})`, {
            stake,
            ask_price:  prop.ask_price,
            spot:       prop.spot,
            commission: prop.commission,
            limit_order: prop.limit_order,
        });

        // 2) Buy at the quoted ask_price.
        try {
            buyReply = await request(ws, {
                buy:   prop.id,
                price: Number(prop.ask_price),
            }, 15000);
            break; // ← success, exit retry loop
        } catch (e) {
            lastError = e;
            const verdict = _handleStakeCapError(e);
            if (verdict === 'retry') continue;
            if (verdict === 'throw') throw e;
            throw new Error(verdict);
        }
    }

    if (!buyReply) {
        // Exhausted MAX_ATTEMPTS without a successful buy. Bubble up
        // the most recent error (or a generic one) so the runner shows
        // a clean OPEN FAILED instead of a silent hang.
        const tail = lastError && lastError.message ? lastError.message : 'unknown error';
        throw new Error(`placeMultiplier: stake auto-scale exhausted after ${MAX_ATTEMPTS} attempts (last: ${tail})`);
    }
    const buy = buyReply.buy;
    // Belt-and-suspenders verification of the buy reply. request() above
    // already converts any explicit data.error into a thrown rejection,
    // but we additionally insist on the buy reply LOOKING like a real
    // accepted contract — a numeric contract_id AND a numeric buy_price.
    // Treating a malformed-but-error-free reply as success was part of
    // the failure-detection gap that hid earlier rejections.
    if (!buy || buy.contract_id == null) {
        throw new Error('placeMultiplier buy: reply missing contract_id (raw=' +
            JSON.stringify(buyReply).slice(0, 240) + ')');
    }
    const _buyPrice = Number(buy.buy_price);
    if (!Number.isFinite(_buyPrice) || _buyPrice <= 0) {
        throw new Error('placeMultiplier buy: reply has no valid buy_price (got ' +
            JSON.stringify(buy.buy_price) + '), refusing to treat as success');
    }
    const wasClamped = requestedStake !== stake;
    Logger.trade(`Multiplier placed: contract_id=${buy.contract_id}`, {
        symbol,
        direction:      dir,
        contract_type:  contractType,
        multiplier,
        stake,                     // reflects the clamped value if a retry happened
        requested_stake: requestedStake,
        clamped:        wasClamped,
        final_limit_order: limit_order,
        transaction_id: buy.transaction_id,
        longcode:       buy.longcode,
    });

    // Expose clamping metadata on the returned `buy` so the runner can
    // surface a soft-warning "stake auto-scaled from $X to $Y" subline
    // in the Telegram tick summary instead of OPEN FAILED.
    buy._aurelia_stake_clamp = wasClamped
        ? {
            requested_stake: requestedStake,
            final_stake:     stake,
            requested_take_profit: opts.takeProfit != null ? Number(opts.takeProfit) : null,
            requested_stop_loss:   opts.stopLoss   != null ? Number(opts.stopLoss)   : null,
            final_take_profit:     limit_order && limit_order.take_profit != null ? limit_order.take_profit : null,
            final_stop_loss:       limit_order && limit_order.stop_loss   != null ? limit_order.stop_loss   : null,
        }
        : null;

    // No settlement polling — Multipliers stay open indefinitely.
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
    // Internal helpers exported for unit-testability:
    _normalizePoc,
    _validateMultiplierOpts,
    _extractMaxStakeFromError,
    _extractMinStakeFromError,
    _guardSensitiveRequest,
    _ALLOWED_TOP_KEYS,
    close,
};
