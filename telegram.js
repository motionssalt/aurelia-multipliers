/* =====================================================================
   MOTIONSALT — Telegram Bot API client
   ─────────────────────────────────────────────────────────────────────
   Outbound only (the inbound webhook lives in worker/index.js).
   All messages are sent to TELEGRAM_CHAT_ID (whitelist enforced).

   Public surface:
     send(text, opts?)                  → sendMessage with HTML parse
     sendPhoto(buffer, caption?)        → sendPhoto (multipart)
     answerCallback(callback_id, text?) → answerCallbackQuery
     editMessage(chat_id, msg_id, text, kb?) → editMessageText
     buildKeyboard(rows)                → inline keyboard helper

     formatBadge(mode)                  → '🟡 DEMO' | '🔴 REAL'
     templates.* — message template helpers

   v3.1 (notification overhaul):
     • _api now retries ONCE on transient failure (network error, 5xx,
       or 429). Permanent 4xx is logged loudly and NOT retried — those
       would just fail the same way.
     • New template:  tradePlaced  — fires the moment a buy is accepted.
     • Enriched templates: cycleResult (now shows duration, balance,
       running session P/L, optional cyclesToSettle for cross-cycle
       contracts), cycleSummary (now shows running session P/L).

   v3.2 (Part 2c — multiplier cycle tick notification):
     • New template:  multiplierTickSummary — fires once per cycle tick
       of the AURELIA-Multipliers fork, including ticks where the AI
       decided to hold. Renders the AI decision (hold/open/close/revise/
       multi/skip), each executed branch, the post-action sibling list,
       and the aggregate exposure / floating P/L for the symbol.
     • No rate-limit changes needed: at a 5-minute cycle cadence this is
       <1 msg per chat per second by ~300× and well below Telegram's
       global 30 msg/s limit. The existing single-retry-with-retry_after
       logic in _api() is already sufficient.
   ===================================================================== */

const Logger = require('./logger');

const TG_TOKEN   = () => process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT_ID = () => process.env.TELEGRAM_CHAT_ID;

async function _fetch() {
    if (typeof fetch === 'function') return fetch;
    const mod = await import('node-fetch');
    return mod.default;
}

function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* ─────────────────────────────────────────────────────────────────
   _api — POST a Telegram Bot API method with one retry on transient
   failure. We treat the following as transient:
     • thrown fetch error (network blip / DNS hiccup)
     • HTTP 5xx
     • HTTP 429 (rate limited) — honour retry_after if Telegram sends one
   Permanent 4xx errors are logged once and NOT retried.
   ───────────────────────────────────────────────────────────────── */
async function _api(method, payload) {
    const token = TG_TOKEN();
    if (!token) { Logger.warn('TELEGRAM_BOT_TOKEN not set — skipping'); return null; }
    const f = await _fetch();
    const url = `https://api.telegram.org/bot${token}/${method}`;

    async function attempt() {
        let res;
        try {
            res = await f(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
        } catch (e) {
            // Network / DNS / TLS error — surface as transient.
            return { transient: true, error: e.message, json: null, status: 0 };
        }
        const json = await res.json().catch(() => ({}));
        const transient = (res.status >= 500 && res.status < 600) || res.status === 429;
        return { transient, error: null, json, status: res.status };
    }

    let r = await attempt();
    if ((r.transient || (r.json && !r.json.ok)) && (r.transient)) {
        // Honour Telegram's retry_after if present (in seconds).
        let waitMs = 1500;
        if (r.json && r.json.parameters && Number.isFinite(r.json.parameters.retry_after)) {
            waitMs = Math.min(8000, r.json.parameters.retry_after * 1000 + 200);
        }
        Logger.warn(`Telegram ${method} transient failure — retrying once`, {
            status: r.status, error: r.error,
            retry_after_ms: waitMs,
        });
        await _sleep(waitMs);
        r = await attempt();
    }

    if (r.error) {
        Logger.warn(`Telegram ${method} network error (after retry)`, { error: r.error });
        return null;
    }
    if (r.json && !r.json.ok) {
        Logger.warn(`Telegram ${method} failed`, {
            status: r.status,
            description: r.json.description,
            error_code: r.json.error_code,
        });
    }
    return r.json;
}

/* ─────────────────────────────────────────────────────────────────
   send / edit / answer
   ───────────────────────────────────────────────────────────────── */
async function send(text, opts = {}) {
    const chatId = opts.chat_id || TG_CHAT_ID();
    if (!chatId) { Logger.warn('TELEGRAM_CHAT_ID not set — skipping'); return null; }
    const payload = {
        chat_id: chatId,
        text:    String(text),
        parse_mode: 'HTML',
        disable_web_page_preview: true,
    };
    if (opts.reply_markup) payload.reply_markup = opts.reply_markup;
    return _api('sendMessage', payload);
}

async function editMessage(chatId, messageId, text, replyMarkup) {
    return _api('editMessageText', {
        chat_id:    chatId,
        message_id: messageId,
        text:       String(text),
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: replyMarkup,
    });
}

async function answerCallback(callbackId, text) {
    return _api('answerCallbackQuery', {
        callback_query_id: callbackId,
        text: text || '',
        show_alert: false,
    });
}

/* ─────────────────────────────────────────────────────────────────
   sendPhoto — multipart upload of a Buffer
   ───────────────────────────────────────────────────────────────── */
async function sendPhoto(buffer, caption) {
    const token = TG_TOKEN();
    const chatId = TG_CHAT_ID();
    if (!token || !chatId) return null;
    const f = await _fetch();
    // node-fetch v3 / global fetch both support FormData + Blob via undici
    const fd = new FormData();
    fd.append('chat_id', chatId);
    if (caption) {
        fd.append('caption', caption);
        fd.append('parse_mode', 'HTML');
    }
    fd.append('photo', new Blob([buffer], { type: 'image/png' }), 'chart.png');
    const url = `https://api.telegram.org/bot${token}/sendPhoto`;
    try {
        const res = await f(url, { method: 'POST', body: fd });
        const json = await res.json().catch(() => ({}));
        if (!json.ok) Logger.warn('Telegram sendPhoto failed', { json });
        return json;
    } catch (e) {
        Logger.warn('Telegram sendPhoto threw', { error: e.message });
        return null;
    }
}

/* ─────────────────────────────────────────────────────────────────
   Inline keyboard helper
   ───────────────────────────────────────────────────────────────── */
function buildKeyboard(rows) {
    return {
        inline_keyboard: rows.map(row =>
            row.map(btn => ({
                text: btn.text,
                callback_data: btn.data || btn.callback_data || '',
                ...(btn.url ? { url: btn.url } : {}),
            }))
        )
    };
}

/* ─────────────────────────────────────────────────────────────────
   Formatting helpers
   ───────────────────────────────────────────────────────────────── */
function formatBadge(mode) {
    return (mode === 'real') ? '🔴 REAL' : '🟡 DEMO';
}

function _esc(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function _money(n, cur = 'USD') {
    const sign = n < 0 ? '-' : '';
    const v = Math.abs(Number(n) || 0).toFixed(2);
    return cur === 'USD' ? `${sign}$${v}` : `${sign}${v} ${cur}`;
}

// Human-readable duration label from (duration, unit) — e.g. (1,'m') → '1m'
function _durationLabel(duration, unit) {
    const n = Number(duration);
    const u = String(unit || '').toLowerCase();
    if (!Number.isFinite(n) || n <= 0) return '—';
    if (u === 'm' || u === 'min' || u === 'minutes') return `${n}m`;
    if (u === 's' || u === 'sec' || u === 'seconds') {
        // collapse 60/120/... to "1m"/"2m" for prettier output
        if (n >= 60 && n % 60 === 0) return `${n / 60}m`;
        return `${n}s`;
    }
    if (u === 'h' || u === 'hour' || u === 'hours')   return `${n}h`;
    if (u === 'd' || u === 'day'  || u === 'days')    return `${n}d`;
    if (u === 't' || u === 'tick' || u === 'ticks')   return `${n}t`;
    return `${n}${u || ''}`;
}

function _directionArrow(direction) {
    const d = String(direction || '').toUpperCase();
    if (d === 'CALL' || d === 'CALLE') return '⬆ CALL';
    if (d === 'PUT'  || d === 'PUTE')  return '⬇ PUT';
    return _esc(d || '—');
}

function _sessionLine(session) {
    if (!session || typeof session !== 'object') return null;
    const w = Number(session.wins   || 0);
    const l = Number(session.losses || 0);
    const t = Number(session.trades || (w + l));
    const pnl = Number(session.pnl || 0);
    const sign = pnl >= 0 ? '+' : '';
    if (t === 0 && pnl === 0) return null;
    return `Session : ${w}W/${l}L · ${sign}${_money(pnl)}`;
}

/* ─────────────────────────────────────────────────────────────────
   Helpers added for Part 2c (multiplierTickSummary).
   Kept private to this module so they don't leak into the public
   surface unless explicitly re-exported later.
   ───────────────────────────────────────────────────────────────── */

// Signed money string: '+$1.23' / '-$1.23' / '$0.00'.
function _signedMoney(n, cur = 'USD') {
    const v = Number(n) || 0;
    const sign = v > 0 ? '+' : v < 0 ? '-' : '';
    // _money already prefixes '-' for negatives; strip it so we control sign.
    const abs = _money(Math.abs(v), cur);
    return `${sign}${abs}`;
}

// 'up' / 'down' → 'MULTUP 🟢' / 'MULTDOWN 🔴'. Used by the multiplier
// template; _directionArrow above is for the binary CALL/PUT path.
function _multDirection(direction) {
    const d = String(direction || '').toLowerCase();
    if (d === 'up')   return '🟢 MULTUP';
    if (d === 'down') return '🔴 MULTDOWN';
    return _esc(String(direction || '—').toUpperCase());
}

// TP/SL renderer: number → '$1.23', null → '—', undefined → '—'.
function _limitStr(v) {
    if (v == null) return '—';
    const n = Number(v);
    if (!Number.isFinite(n)) return '—';
    return _money(n);
}

// Confidence renderer: 0..1 → '(NN%)', anything else → ''.
function _confStr(c) {
    if (c == null) return '';
    const n = Number(c);
    if (!Number.isFinite(n)) return '';
    return ` (${Math.round(n * 100)}%)`;
}

// Part 3c helper — render a duration between two ISO timestamps as a
// short human-readable label ('1h 23m', '4m 12s', '37s'). Returns null
// if either input is missing or the delta is non-positive. Used by the
// session summary template; kept module-local so it doesn't pollute the
// public surface (Part 2c's _durationLabel above is for (number,unit)).
function _isoDurationLabel(startIso, endIso) {
    if (!startIso || !endIso) return null;
    const ms = Date.parse(endIso) - Date.parse(startIso);
    if (!Number.isFinite(ms) || ms <= 0) return null;
    const sec = Math.floor(ms / 1000);
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
}

// Map an action verb to a header emoji + label.
function _actionHeader(action) {
    switch (String(action || '').toLowerCase()) {
        case 'hold':   return '⏸️ <b>HOLD</b>';
        case 'skip':   return '⏭️ <b>SKIP</b>';
        case 'open':   return '🆕 <b>OPEN</b>';
        case 'close':  return '🔒 <b>CLOSE</b>';
        case 'revise': return '✏️ <b>REVISE</b>';
        case 'multi':  return '🧩 <b>MULTI</b>';
        default:       return `❓ <b>${_esc(String(action || 'UNKNOWN').toUpperCase())}</b>`;
    }
}

/* ─────────────────────────────────────────────────────────────────
   Message templates
   ───────────────────────────────────────────────────────────────── */
const templates = {

    /* NEW in v3.1 — fires immediately when a buy is accepted by Deriv,
       BEFORE we wait for settlement. Gives the user a same-second
       confirmation that the bot placed a real order. */
    tradePlaced({ symbol, mode, direction, stake, duration, durationUnit,
                  strategy, contractId }) {
        const badge = formatBadge(mode);
        const lines = [
            `🎯 <b>TRADE PLACED</b> — ${_esc(symbol)} ${badge}`,
            `Direction: <b>${_directionArrow(direction)}</b>`,
            `Stake    : ${_money(stake)}`,
            `Duration : <b>${_durationLabel(duration, durationUnit)}</b>`,
            `Strategy : <code>${_esc(strategy)}</code>`,
        ];
        if (contractId) lines.push(`Contract : <code>${_esc(contractId)}</code>`);
        return lines.join('\n');
    },

    /* Enriched in v3.1:
       • Duration line (e.g. "1m" or "1m · 2 cycles")
       • Balance after settle
       • Running session line (W/L · P/L)
     */
    cycleResult({ result, symbol, mode, entry, exit, pnl, strategy,
                  duration, durationUnit, cyclesToSettle,
                  balance, currency, session }) {
        const badge = formatBadge(mode);
        const head  = (result === 'win')
            ? `✅ <b>WIN</b> — ${_esc(symbol)} ${badge}`
            : (result === 'loss')
                ? `❌ <b>LOSS</b> — ${_esc(symbol)} ${badge}`
                : `➖ <b>${_esc(String(result || 'unknown').toUpperCase())}</b> — ${_esc(symbol)} ${badge}`;
        const sign = (pnl >= 0 ? '+' : '');

        const lines = [
            head,
            `Entry   : <code>${_esc(entry)}</code>`,
            `Exit    : <code>${_esc(exit)}</code>`,
        ];

        // Duration line — show whenever we know the duration. If the
        // trade was tracked across multiple cycles, append "· N cycles".
        if (duration != null || cyclesToSettle != null) {
            const dlabel = (duration != null)
                ? _durationLabel(duration, durationUnit) : '—';
            const n = Number(cyclesToSettle);
            const cycSuffix = (Number.isFinite(n) && n > 1)
                ? ` · ${n} cycles` : '';
            lines.push(`Duration: <b>${dlabel}</b>${cycSuffix}`);
        }

        lines.push(`P/L     : <b>${sign}${_money(pnl)}</b>`);
        if (Number.isFinite(Number(balance))) {
            lines.push(`Balance : ${_money(balance, currency || 'USD')}`);
        }
        const sess = _sessionLine(session);
        if (sess) lines.push(sess);
        lines.push(`Strategy: <code>${_esc(strategy)}</code>`);
        return lines.join('\n');
    },

    holdSignal({ symbol, reason }) {
        return `⏸️ <b>HOLD</b> — ${_esc(symbol)}\n${_esc(reason)}`;
    },

    /* Fires when the cycle session is halted because TP / SL / capital
       was reached. Includes the running W/L + P/L so the user gets a
       complete picture in one message. */
    sessionHalted({ kind, reason, mode, session, balance, currency }) {
        const badge = formatBadge(mode);
        let head;
        if (kind === 'take_profit') {
            head = `🎯 <b>TAKE-PROFIT HIT</b> — session halted ${badge}`;
        } else if (kind === 'stop_loss') {
            head = `🚫 <b>STOP-LOSS HIT</b> — session halted ${badge}`;
        } else if (kind === 'capital') {
            head = `💥 <b>CAPITAL EXHAUSTED</b> — session halted ${badge}`;
        } else {
            head = `⏹️ <b>SESSION HALTED</b> ${badge}`;
        }
        const lines = [head];
        if (reason) lines.push(`Reason  : <code>${_esc(reason)}</code>`);
        const sess = _sessionLine(session);
        if (sess) lines.push(sess);
        if (session && Number.isFinite(Number(session.capital_remaining))) {
            lines.push(`Capital : ${_money(session.capital_remaining)}`);
        }
        if (Number.isFinite(Number(balance))) {
            lines.push(`Balance : ${_money(balance, currency || 'USD')}`);
        }
        lines.push('<i>Cycle will not place new trades until the session is restarted.</i>');
        return lines.join('\n');
    },

    /* Part 3c — end-of-session summary (MT5-style).
       Fires ONCE when a cycle session ends (force-close on session TP/SL
       or operator pause once positions are drained). Lists every
       multiplier position opened during the session with entry/exit
       prices, TP/SL at close, stake, P/L and duration, plus a total.

       Input shape:
         {
           startedAt:   ISO string | null,
           endedAt:     ISO string,
           endedReason: 'take_profit' | 'stop_loss' | 'capital'
                      | 'halted' | 'paused' | 'ended' | 'risk_breach',
           haltReason:  string | null,  // raw text if available
           mode:        'demo' | 'real',
           session:     { capital_start, capital_remaining, take_profit,
                          stop_loss, trades, wins, losses, pnl },
           balance:     number,
           currency:    string,
           positions:   trade_history_cycle records belonging to this session
         }
     */
    sessionSummary({ startedAt, endedAt, endedReason, haltReason, mode,
                     session, balance, currency, positions }) {
        const badge = formatBadge(mode);
        const cur   = currency || 'USD';

        // Header by reason.
        let head;
        switch (endedReason) {
            case 'take_profit':
                head = `🎯 <b>SESSION ENDED — TAKE-PROFIT</b> ${badge}`; break;
            case 'stop_loss':
                head = `🚫 <b>SESSION ENDED — STOP-LOSS</b> ${badge}`; break;
            case 'capital':
                head = `💥 <b>SESSION ENDED — CAPITAL EXHAUSTED</b> ${badge}`; break;
            case 'paused':
                head = `⏸️ <b>SESSION ENDED — PAUSED</b> ${badge}`; break;
            case 'risk_breach':
            case 'halted':
                head = `⏹️ <b>SESSION ENDED — HALTED</b> ${badge}`; break;
            default:
                head = `⏹️ <b>SESSION ENDED</b> ${badge}`;
        }

        const lines = [head];
        if (startedAt)  lines.push(`Started : <code>${_esc(startedAt)}</code>`);
        if (endedAt)    lines.push(`Ended   : <code>${_esc(endedAt)}</code>`);
        const sessDur = _isoDurationLabel(startedAt, endedAt);
        if (sessDur)    lines.push(`Duration: <b>${sessDur}</b>`);
        if (haltReason) lines.push(`Reason  : <code>${_esc(haltReason)}</code>`);

        // Sort positions in the order they were opened (by opened_at,
        // falling back to ts). Stable, deterministic output.
        const ordered = (Array.isArray(positions) ? positions.slice() : []).sort((a, b) => {
            const ka = Date.parse(a.opened_at || a.ts || 0) || 0;
            const kb = Date.parse(b.opened_at || b.ts || 0) || 0;
            return ka - kb;
        });

        if (ordered.length > 0) {
            lines.push('');
            lines.push(`<b>Positions (${ordered.length})</b>`);
            // Per-position block. We don't render an HTML table because
            // Telegram strips most table markup — a compact, scannable
            // block per row reads better on mobile and stays inside the
            // 4096-char plain-message cap for typical sessions (~24 rows).
            ordered.forEach((p, i) => {
                const dur = _isoDurationLabel(p.opened_at, p.ts);
                const pnl = Number(p.pnl) || 0;
                const outcomeEmoji = pnl > 0 ? '✅' : pnl < 0 ? '❌' : '➖';
                lines.push('');
                lines.push(
                    `${outcomeEmoji} <b>${i + 1}.</b> <code>${_esc(p.symbol || '—')}</code> `
                    + `${_multDirection(p.direction)} x${_esc(p.multiplier || '—')}`
                );
                lines.push(
                    `   Entry/Exit : <code>${_esc(p.entry != null ? p.entry : '—')}</code> → `
                    + `<code>${_esc(p.exit  != null ? p.exit  : '—')}</code>`
                );
                lines.push(
                    `   TP / SL    : ${_limitStr(p.take_profit)} / ${_limitStr(p.stop_loss)}`
                );
                lines.push(
                    `   Stake / P/L: ${_money(p.stake || 0, cur)} → <b>${_signedMoney(pnl, cur)}</b>`
                    + (dur ? ` · ${dur}` : '')
                );
                if (p.close_reason && p.close_reason !== 'unknown') {
                    lines.push(`   Close      : <code>${_esc(p.close_reason)}</code>`);
                }
            });
        }

        // Totals.
        const totalRealised = ordered.reduce((s, p) => s + (Number(p.pnl) || 0), 0);
        const totalStake    = ordered.reduce((s, p) => s + (Number(p.stake) || 0), 0);
        const wins   = ordered.filter(p => Number(p.pnl) > 0).length;
        const losses = ordered.filter(p => Number(p.pnl) < 0).length;
        const winPct = ordered.length > 0 ? ((wins / ordered.length) * 100).toFixed(1) + '%' : '—';

        lines.push('');
        lines.push('<b>Session totals</b>');
        lines.push(`Positions : ${ordered.length}`);
        lines.push(`W / L     : ${wins} / ${losses}   (${winPct})`);
        lines.push(`Staked    : ${_money(totalStake, cur)}`);
        lines.push(`Realised  : <b>${_signedMoney(totalRealised, cur)}</b>`);

        // If the session counters disagree with the per-position sum
        // (e.g. trades closed before Part 3c shipped, missing the
        // session_started_at tag), surface the session.pnl too so the
        // user has both numbers in front of them. Otherwise it's just
        // visual noise.
        if (session && Number.isFinite(Number(session.pnl))
            && Math.abs(Number(session.pnl) - totalRealised) > 0.005) {
            lines.push(`Session P/L: <b>${_signedMoney(session.pnl, cur)}</b> <i>(counters)</i>`);
        }

        if (session && Number.isFinite(Number(session.capital_start))
            && Number(session.capital_start) > 0) {
            lines.push(
                `Capital   : ${_money(session.capital_remaining || 0, cur)} / `
                + `${_money(session.capital_start, cur)}`
            );
        }
        if (Number.isFinite(Number(balance))) {
            lines.push(`Balance   : ${_money(balance, cur)}`);
        }

        lines.push('');
        lines.push('<i>Run /startcycle to begin a fresh session.</i>');
        return lines.join('\n');
    },

    dailySummary({ date, mode, trades, wins, losses, pnl }) {
        const badge   = formatBadge(mode);
        const winPct  = trades > 0 ? ((wins / trades) * 100).toFixed(1) + '%' : '—';
        const sign    = pnl >= 0 ? '+' : '';
        return [
            `📊 <b>Daily Summary</b> — ${_esc(date)} ${badge}`,
            `Trades  : ${trades}`,
            `Wins    : ${wins}`,
            `Losses  : ${losses}`,
            `Win %   : ${winPct}`,
            `P/L     : ${sign}${_money(pnl)}`,
        ].join('\n');
    },

    heartbeatSilent({ lastSeen }) {
        return [
            '⚠️ <b>MOTIONSALT BOT SILENT</b>',
            'No cycle detected in 15 minutes.',
            `Last seen: <code>${_esc(lastSeen)}</code>`,
            'Check cron-job.org and GitHub Actions.',
        ].join('\n');
    },

    errorAlert({ where, message, cycleTs }) {
        return [
            '🚨 <b>BOT ERROR</b>',
            `[${_esc(where)}] ${_esc(message)}`,
            `Cycle: <code>${_esc(cycleTs)}</code>`,
        ].join('\n');
    },

    /* Enriched in v3.1 — adds the running session line so the user
       sees a meaningful summary even on quiet cycles. */
    cycleSummary({ mode, balance, currency, placed, holds, monitored,
                   session, pending }) {
        const badge = formatBadge(mode);
        const lines = [
            `🟢 <b>Cycle</b> ${badge}`,
            `Balance : ${_money(balance, currency)}`,
            `Placed  : ${placed}    Holds: ${holds}    Live: ${monitored}`,
        ];
        if (Number.isFinite(Number(pending)) && Number(pending) > 0) {
            lines.push(`Pending : ${pending}`);
        }
        const sess = _sessionLine(session);
        if (sess) lines.push(sess);
        return lines.join('\n');
    },

    mainMenu({ mode, balance, currency }) {
        const badge = formatBadge(mode);
        return [
            `⚡ <b>MOTIONSALT BOT</b> ${badge}`,
            `Balance: ${_money(balance, currency)}`,
        ].join('\n');
    },

    statusScreen({ mode, balance, currency, lastCycle, tradesToday, pnlToday,
                   winStreak, enabled }) {
        const badge = formatBadge(mode);
        const sign  = pnlToday >= 0 ? '+' : '';
        return [
            `📊 <b>Status</b> ${badge}`,
            '',
            `Balance     : ${_money(balance, currency)}`,
            `Last cycle  : <code>${_esc(lastCycle || '—')}</code>`,
            `Trades today: ${tradesToday}`,
            `P/L today   : ${sign}${_money(pnlToday)}`,
            `Win streak  : ${winStreak}`,
            `Bot         : ${enabled ? '✅ Active' : '⏸️ Paused'}`,
        ].join('\n');
    },

    /* NEW in v3.2 — AURELIA-Multipliers cycle tick notification (Part 2c).

       Fires on EVERY cycle tick (including holds), once per tick.
       Renders, in order:
         1. Header line: action emoji/label, symbol, mode badge, confidence.
         2. Decision details:
            • hold/skip       → just the rationale.
            • open            → direction, stake, multiplier, TP/SL,
                                  sibling count.
            • close           → contracts closed + per-contract realised P/L.
            • revise          → per-contract TP/SL old→new transitions.
            • multi           → each sub-phase grouped under its own header.
         3. Just-closed siblings (server-side closes detected this tick).
         4. Open siblings AFTER actions — stake / multiplier / direction /
            current floating P/L / live TP/SL for each.
         5. Aggregate exposure for the symbol: count, total stake at risk,
            total floating P/L, plus session realised + halt status.
         6. Rationale (truncated to 280 chars) and decision_id footer.

       Input shape (all fields optional unless noted; missing fields are
       gracefully omitted from the message):
         {
           symbol         : string  (REQUIRED)
           mode           : 'real' | 'demo'
           cycleId        : string
           decision       : { action, decision_id, rationale, confidence,
                              close?, open?, revise?, multi? }  (REQUIRED)
           executed       : { action, details: [...] }
           justClosed     : [ { contract_id, outcome, pnl, reason }, ... ]
           openSiblings   : [ persisted sibling objects, post-action ]
               // shape: { contract_id, stake, multiplier, direction,
               //          entry_spot, take_profit, stop_loss,
               //          floating_pnl, floating_pnl_pct, current_spot,
               //          sibling_index, sibling_count }
           preActionSiblings : [ same shape, pre-action snapshot ]
               // used to compute old→new TP/SL diffs for 'revise' branch.
           exposure       : { positions, total_stake, total_floating_pnl, ... }
           session        : { active, halted, halt_reason, capital_remaining,
                              capital_start, take_profit, stop_loss,
                              pnl, trades, wins, losses }
           riskBreach     : null | string  (halt_reason if aggregate risk fired)
           balance        : number
           currency       : string
         }
     */
    multiplierTickSummary({
        symbol, mode, cycleId,
        decision, executed,
        justClosed = [], openSiblings = [], preActionSiblings = [],
        exposure = {}, session = {},
        riskBreach = null, balance, currency,
    }) {
        const badge  = formatBadge(mode);
        const action = String((decision && decision.action) || 'hold').toLowerCase();
        const conf   = decision && _confStr(decision.confidence);

        const lines = [];
        // ── 1. Header ──────────────────────────────────────────────────
        // For the 'open' action specifically, downgrade the header from
        // the celebratory "🆕 OPEN" to a clearly-failed marker when EVERY
        // attempted sibling errored at Deriv — otherwise we lie to the
        // user about what actually happened on the platform.
        let headerAction = action;
        if (action === 'open') {
            const dets = (executed && Array.isArray(executed.details)) ? executed.details : [];
            const anySuccess = dets.some(d => d && d.contract_id != null && !d.error);
            const anyFailure = dets.some(d => d && d.error);
            if (anyFailure && !anySuccess) headerAction = 'open_failed';
        }
        const headerLabel = headerAction === 'open_failed'
            ? '⚠️ <b>OPEN FAILED</b>'
            : _actionHeader(headerAction);
        lines.push(`${headerLabel} — <b>${_esc(symbol)}</b> ${badge}${conf}`);

        // ── 2. Decision-specific body ──────────────────────────────────
        // Build a lookup of pre-action siblings by contract_id so the
        // 'revise' / 'close' branches can show old→new transitions.
        const preById = new Map();
        for (const s of (preActionSiblings || [])) {
            if (s && s.contract_id != null) preById.set(Number(s.contract_id), s);
        }

        function _renderOpenSpec(spec, execDetails) {
            const subLines = [];
            const sibCount = Math.max(1, Number(spec.siblings) || 1);
            subLines.push(`Direction : ${_multDirection(spec.direction)} ×${Number(spec.multiplier) || '?'}`);
            subLines.push(`Stake     : ${_money(spec.stake)}${sibCount > 1 ? ` × ${sibCount} siblings` : ''}`);
            subLines.push(`TP / SL   : ${_limitStr(spec.take_profit)} / ${_limitStr(spec.stop_loss)}`);

            // Honest execution outcome — was the open ACTUALLY accepted
            // by Deriv? Before this fix the template rendered the spec
            // unconditionally, so a rejected proposal/buy still produced
            // a "🆕 OPEN" message and the user (and the next tick's AI)
            // both believed a position had been opened. We now consult
            // executed.details directly:
            //   { contract_id }            → success per sibling
            //   { error: '<reason>' }      → buy/proposal failed at Deriv
            // Mixed batches are possible (one sibling succeeds, the next
            // fails after capital drained) — list each line individually.
            const dets = Array.isArray(execDetails) ? execDetails : [];
            if (dets.length) {
                const okIds   = dets.filter(d => d && d.contract_id != null && !d.error).map(d => d.contract_id);
                const failed  = dets.filter(d => d && d.error);
                if (okIds.length) {
                    subLines.push(`Opened    : ✅ ${okIds.map(id => `<code>${_esc(id)}</code>`).join(', ')}`);
                }
                if (failed.length) {
                    subLines.push(`⚠️ <b>Trade attempt failed</b> (×${failed.length}):`);
                    for (const f of failed) {
                        subLines.push(`  • <code>${_esc(String(f.error).slice(0, 200))}</code>`);
                    }
                }
                if (!okIds.length && !failed.length) {
                    subLines.push(`⚠️ <i>Trade attempt produced no result — see logs.</i>`);
                }
            }
            return subLines;
        }

        function _renderCloseList(closeArr, execDetails) {
            const subLines = [];
            // Build a P/L lookup keyed by contract_id from execDetails so
            // we can show realised P/L per contract. executeCloseList
            // returns rows shaped { contract_id, closed:true, pnl } or
            // { contract_id, error } or { contract_id, skipped }.
            const byId = new Map();
            for (const d of (execDetails || [])) {
                if (d && d.contract_id != null) byId.set(Number(d.contract_id), d);
            }
            for (const item of (closeArr || [])) {
                const cid = Number(item.contract_id);
                const exec = byId.get(cid);
                const reason = item.reason ? ` · <i>${_esc(item.reason)}</i>` : '';
                if (exec && exec.error) {
                    subLines.push(`• <code>${cid}</code>: ❌ <code>${_esc(exec.error)}</code>${reason}`);
                } else if (exec && exec.skipped) {
                    subLines.push(`• <code>${cid}</code>: ⚠️ ${_esc(exec.skipped)}${reason}`);
                } else if (exec && exec.closed) {
                    subLines.push(`• <code>${cid}</code>: ${_signedMoney(exec.pnl)}${reason}`);
                } else {
                    subLines.push(`• <code>${cid}</code>: requested${reason}`);
                }
            }
            return subLines;
        }

        function _renderReviseList(reviseArr) {
            const subLines = [];
            for (const r of (reviseArr || [])) {
                const cid = Number(r.contract_id);
                const pre = preById.get(cid);
                const oldTP = pre ? pre.take_profit : undefined;
                const oldSL = pre ? pre.stop_loss   : undefined;
                const parts = [];
                if (Object.prototype.hasOwnProperty.call(r, 'take_profit')) {
                    parts.push(`TP ${_limitStr(oldTP)} → ${_limitStr(r.take_profit)}`);
                }
                if (Object.prototype.hasOwnProperty.call(r, 'stop_loss')) {
                    parts.push(`SL ${_limitStr(oldSL)} → ${_limitStr(r.stop_loss)}`);
                }
                subLines.push(`• <code>${cid}</code>: ${parts.join(' · ') || 'no-op'}`);
            }
            return subLines;
        }

        if (action === 'open' && decision.open) {
            lines.push(..._renderOpenSpec(decision.open, executed && executed.details));
        } else if (action === 'close' && Array.isArray(decision.close)) {
            lines.push('Closing   :');
            lines.push(..._renderCloseList(decision.close, executed && executed.details));
        } else if (action === 'revise' && Array.isArray(decision.revise)) {
            lines.push('Revising  :');
            lines.push(..._renderReviseList(decision.revise));
        } else if (action === 'multi' && decision.multi) {
            // Group executed.details by phase so each sub-block shows its own outcome.
            const detailsByPhase = { close: [], revise: [], open: [] };
            for (const d of ((executed && executed.details) || [])) {
                if (d && d.phase && detailsByPhase[d.phase]) detailsByPhase[d.phase].push(d);
            }
            if (Array.isArray(decision.multi.close) && decision.multi.close.length) {
                lines.push('Closing   :');
                lines.push(..._renderCloseList(decision.multi.close, detailsByPhase.close));
            }
            if (Array.isArray(decision.multi.revise) && decision.multi.revise.length) {
                lines.push('Revising  :');
                lines.push(..._renderReviseList(decision.multi.revise));
            }
            if (decision.multi.open) {
                lines.push('Opening   :');
                lines.push(..._renderOpenSpec(decision.multi.open, detailsByPhase.open));
            }
        }
        // 'hold' / 'skip' / unknown → no decision body, just the rationale
        // shown in the footer below.

        // ── 3. Server-side closes detected this tick ───────────────────
        if (Array.isArray(justClosed) && justClosed.length) {
            lines.push('');
            lines.push(`<b>Just closed</b> (×${justClosed.length}):`);
            for (const jc of justClosed) {
                const tag = jc.outcome === 'win'  ? '✅'
                        : jc.outcome === 'loss'   ? '❌'
                        : '➖';
                const reason = jc.reason ? ` · <i>${_esc(jc.reason)}</i>` : '';
                lines.push(`• ${tag} <code>${_esc(jc.contract_id)}</code>: ${_signedMoney(jc.pnl)}${reason}`);
            }
        }

        // ── 4. Open siblings (post-action) ─────────────────────────────
        lines.push('');
        if (!openSiblings || openSiblings.length === 0) {
            lines.push('<b>Open siblings</b>: <i>none</i>');
        } else {
            lines.push(`<b>Open siblings</b> (×${openSiblings.length}):`);
            for (const sib of openSiblings) {
                const cid  = sib.contract_id;
                const dir  = _multDirection(sib.direction);
                const mult = Number(sib.multiplier) > 0 ? `×${Number(sib.multiplier)}` : '×?';
                const stake = _money(sib.stake);
                const fp = _signedMoney(sib.floating_pnl);
                const fpPct = (sib.floating_pnl_pct != null && Number.isFinite(Number(sib.floating_pnl_pct)))
                    ? ` (${Number(sib.floating_pnl_pct) >= 0 ? '+' : ''}${Number(sib.floating_pnl_pct).toFixed(2)}%)`
                    : '';
                lines.push(`• <code>${_esc(cid)}</code> ${dir} ${mult} · ${stake} · P/L <b>${fp}${fpPct}</b>`);
                lines.push(`    TP / SL: ${_limitStr(sib.take_profit)} / ${_limitStr(sib.stop_loss)}`);
            }
        }

        // ── 5. Aggregate exposure + session ───────────────────────────
        // exposure shape comes from State.aggregateSiblingExposure(state, symbol).
        // We tolerate either { total_stake, total_floating_pnl, positions }
        // or derive on the fly from openSiblings if any field is missing
        // (defensive — the State module is part 1 territory, see summary).
        const positions = (exposure && exposure.positions != null)
            ? Number(exposure.positions)
            : openSiblings.length;
        let totalStake = (exposure && exposure.total_stake != null)
            ? Number(exposure.total_stake)
            : openSiblings.reduce((acc, s) => acc + (Number(s.stake) || 0), 0);
        let totalFloating = (exposure && exposure.total_floating_pnl != null)
            ? Number(exposure.total_floating_pnl)
            : openSiblings.reduce((acc, s) => acc + (Number(s.floating_pnl) || 0), 0);
        totalStake = Number(totalStake.toFixed(2));
        totalFloating = Number(totalFloating.toFixed(2));

        lines.push('');
        lines.push(`<b>Exposure</b> (${_esc(symbol)}): ${positions} pos · stake ${_money(totalStake)} · float <b>${_signedMoney(totalFloating)}</b>`);

        if (session && typeof session === 'object') {
            const sessPnl = Number(session.pnl || 0);
            const combined = Number((sessPnl + totalFloating).toFixed(2));
            const sessParts = [];
            sessParts.push(`realised ${_signedMoney(sessPnl)}`);
            sessParts.push(`combined ${_signedMoney(combined)}`);
            if (Number.isFinite(Number(session.capital_remaining))) {
                sessParts.push(`cap left ${_money(session.capital_remaining)}`);
            }
            const w = Number(session.wins || 0), l = Number(session.losses || 0);
            if (w || l) sessParts.push(`${w}W/${l}L`);
            lines.push(`Session  : ${sessParts.join(' · ')}`);
            if (session.halted) {
                lines.push(`⛔ <b>HALTED</b>: <code>${_esc(session.halt_reason || 'unknown')}</code>`);
            }
        }
        if (riskBreach) {
            lines.push(`⚠️ <b>Risk breach this tick</b>: <code>${_esc(riskBreach)}</code> — all siblings force-closed.`);
        }
        if (Number.isFinite(Number(balance))) {
            lines.push(`Balance  : ${_money(balance, currency || 'USD')}`);
        }

        // ── 6. Footer: rationale + decision_id ────────────────────────
        const rationale = decision && decision.rationale ? String(decision.rationale).trim() : '';
        if (rationale) {
            const truncated = rationale.length > 280 ? rationale.slice(0, 277) + '…' : rationale;
            lines.push('');
            lines.push(`<i>${_esc(truncated)}</i>`);
        }
        if (decision && decision.decision_id) {
            lines.push(`<code>id=${_esc(decision.decision_id)}</code>`);
        }

        return lines.join('\n');
    },
};

/* ─────────────────────────────────────────────────────────────────
   Pre-built inline keyboards
   ───────────────────────────────────────────────────────────────── */
const keyboards = {
    mainMenu: () => buildKeyboard([
        [{ text: '📊 Status',  data: 'status'  }, { text: '📈 Chart',    data: 'chart'   }],
        [{ text: '▶️ Trigger', data: 'trigger' }, { text: '⏸️ Pause',    data: 'pause'   }],
        [{ text: '⚙️ Settings',data: 'settings'}, { text: '📋 Logs',     data: 'logs'    }],
    ]),
    statusScreen: () => buildKeyboard([
        [{ text: '🔄 Refresh', data: 'status' }, { text: '🏠 Menu', data: 'menu' }],
    ]),
    settings: () => buildKeyboard([
        [{ text: '🎯 Risk Mode',  data: 'set:risk'    }, { text: '💰 Stake',    data: 'set:stake'   }],
        [{ text: '📊 Strategies', data: 'set:strats'  }, { text: '🚦 Limits',   data: 'set:limits'  }],
        [{ text: '🔄 Account',    data: 'set:account' }, { text: '⬅️ Back',     data: 'menu'        }],
    ]),
    confirm: (yesData, noData) => buildKeyboard([
        [{ text: '✅ Confirm', data: yesData }, { text: '❌ Cancel', data: noData }],
    ]),
};

module.exports = {
    send,
    sendPhoto,
    editMessage,
    answerCallback,
    buildKeyboard,
    formatBadge,
    templates,
    keyboards,
    _api, // exposed for advanced/raw calls
};
