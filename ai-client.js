/* =====================================================================
   AURELIA — ai-client.js
   ─────────────────────────────────────────────────────────────────────
   Multi-provider AI decision client with key/provider failover + benching.

   Provider waterfall (v2):
     1. Gemini (multi-key via config.ai.key_registry — original behaviour)
     2. config.ai.providers[] in declared order, where `enabled: true`
        and process.env[key_env] is present.

   Each provider call returns STRICT JSON matching the same decision
   schema. Benching keys is unchanged for Gemini; provider-level
   failures are also benched in state.ai_keys_bench keyed by the
   provider name (e.g. `provider:openai`).

   Public surface:
     askDecision({ payload, config, state })            → { decision, keyUsed }   // binary path
     askMultiplierDecision({ aiInput, config, state })  → { decision, keyUsed }   // multiplier path (Part 2b)
     askPostMortem({ trade, config, state })            → string | null
     validateMultiplierDecision(raw, aiInput, config)   → { ok, decision, errs }  // Part 2b
   ===================================================================== */

'use strict';

const Logger = require('./logger');

const DEFAULT_MODEL = 'gemini-2.5-flash';
const DEFAULT_BENCH_MINUTES = 120;
const DEFAULT_TIMEOUT_MS = 180000; // 3 min per key — Gemini load spikes

async function _fetch() {
    if (typeof fetch === 'function') return fetch;
    const mod = await import('node-fetch');
    return mod.default;
}

/* ─────────────────────────────────────────────────────────────────
   Key selection: order keys by (not-benched first, then bench-expiry asc)
   ───────────────────────────────────────────────────────────────── */
function _orderKeys(registry, benchMap, now) {
    const rows = registry.map(name => {
        const benchUntil = Number((benchMap || {})[name] || 0);
        const benched = benchUntil > now;
        return { name, benchUntil, benched };
    });
    rows.sort((a, b) => {
        if (a.benched !== b.benched) return a.benched ? 1 : -1;
        return a.benchUntil - b.benchUntil;
    });
    return rows;
}

function _stripFences(s) {
    if (typeof s !== 'string') return '';
    let out = s.trim();
    if (out.startsWith('```')) {
        out = out.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
    }
    return out.trim();
}

function _parseJsonStrict(text) {
    const cleaned = _stripFences(text);
    try { return JSON.parse(cleaned); }
    catch (e) { throw new Error(`AI returned non-JSON: ${cleaned.slice(0, 160)}`); }
}

/* ─────────────────────────────────────────────────────────────────
   PROVIDER: Gemini (Google)
   ───────────────────────────────────────────────────────────────── */
function _extractGeminiText(geminiReply) {
    try {
        const cand = (geminiReply.candidates || [])[0];
        const parts = (cand && cand.content && cand.content.parts) || [];
        return parts.map(p => p.text || '').join('').trim();
    } catch (e) { return ''; }
}

async function _callGemini({ keyValue, model, prompt, timeoutMs }) {
    const f = await _fetch();
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(keyValue)}`;
    const body = {
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
            temperature: 0.4,
            responseMimeType: 'application/json',
        },
    };
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs || DEFAULT_TIMEOUT_MS);
    let res;
    try {
        res = await f(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: ctl.signal,
        });
    } finally { clearTimeout(t); }
    if (!res.ok) {
        const txt = await res.text().catch(() => '');
        const err = new Error(`gemini ${res.status}: ${txt.slice(0, 200)}`);
        err.status = res.status;
        throw err;
    }
    const json = await res.json();
    const text = _extractGeminiText(json);
    if (!text) throw new Error('gemini returned empty text');
    return text;
}

/* ─────────────────────────────────────────────────────────────────
   PROVIDER: OpenAI-compatible (OpenAI, Grok/xAI)
   Both use Chat Completions schema. Caller passes the endpoint URL.
   ───────────────────────────────────────────────────────────────── */
async function _callOpenAICompat({ keyValue, model, prompt, endpoint, timeoutMs, providerName }) {
    const f = await _fetch();
    const body = {
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.4,
        response_format: { type: 'json_object' },
    };
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs || DEFAULT_TIMEOUT_MS);
    let res;
    try {
        res = await f(endpoint, {
            method: 'POST',
            headers: {
                'Content-Type':  'application/json',
                'Authorization': `Bearer ${keyValue}`,
            },
            body: JSON.stringify(body),
            signal: ctl.signal,
        });
    } finally { clearTimeout(t); }
    if (!res.ok) {
        const txt = await res.text().catch(() => '');
        const err = new Error(`${providerName} ${res.status}: ${txt.slice(0, 200)}`);
        err.status = res.status;
        throw err;
    }
    const json = await res.json();
    const text = (((json.choices || [])[0] || {}).message || {}).content || '';
    if (!text) throw new Error(`${providerName} returned empty text`);
    return String(text).trim();
}

/* ─────────────────────────────────────────────────────────────────
   PROVIDER: Anthropic Claude (different request/response shape)
   ───────────────────────────────────────────────────────────────── */
async function _callClaude({ keyValue, model, prompt, timeoutMs }) {
    const f = await _fetch();
    const body = {
        model,
        max_tokens: 1024,
        temperature: 0.4,
        messages: [{ role: 'user', content: prompt }],
    };
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs || DEFAULT_TIMEOUT_MS);
    let res;
    try {
        res = await f('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type':      'application/json',
                'x-api-key':         keyValue,
                'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify(body),
            signal: ctl.signal,
        });
    } finally { clearTimeout(t); }
    if (!res.ok) {
        const txt = await res.text().catch(() => '');
        const err = new Error(`claude ${res.status}: ${txt.slice(0, 200)}`);
        err.status = res.status;
        throw err;
    }
    const json = await res.json();
    // Claude returns content as an array of blocks; we want the first text block.
    const text = ((json.content || [])[0] || {}).text || '';
    if (!text) throw new Error('claude returned empty text');
    return String(text).trim();
}

/* ─────────────────────────────────────────────────────────────────
   Generic provider dispatcher \u2014 routes by provider.name.
   Returns the raw text reply (JSON-as-string).
   ───────────────────────────────────────────────────────────────── */
async function _callProvider(provider, { keyValue, prompt, timeoutMs }) {
    const model = provider.model;
    switch ((provider.name || '').toLowerCase()) {
        case 'gemini':
            return _callGemini({ keyValue, model, prompt, timeoutMs });
        case 'openai':
            return _callOpenAICompat({
                keyValue, model, prompt, timeoutMs,
                endpoint: 'https://api.openai.com/v1/chat/completions',
                providerName: 'openai',
            });
        case 'grok':
        case 'xai':
            return _callOpenAICompat({
                keyValue, model, prompt, timeoutMs,
                endpoint: 'https://api.x.ai/v1/chat/completions',
                providerName: 'grok',
            });
        case 'claude':
        case 'anthropic':
            return _callClaude({ keyValue, model, prompt, timeoutMs });
        default:
            throw new Error(`unknown AI provider "${provider.name}"`);
    }
}

/* ─────────────────────────────────────────────────────────────────
   Preflight: for every enabled provider, verify at least one of its
   key_registry env var names resolves to a non-empty value. Logs a
   clear warning per provider that has NONE resolvable, so a future
   name mismatch shows up immediately in logs instead of silently
   degrading to "all providers failed."
   ───────────────────────────────────────────────────────────────── */
function _preflightKeyCheck(config) {
    const providers = (config.ai && Array.isArray(config.ai.providers)) ? config.ai.providers : [];
    for (const p of providers) {
        if (!p || p.enabled === false) continue;
        const name = String(p.name || '').toLowerCase();
        // Gemini is handled separately via config.ai.key_registry
        if (name === 'gemini') continue;
        const registry = Array.isArray(p.key_registry) && p.key_registry.length > 0
            ? p.key_registry
            : (p.key_env ? [p.key_env] : []);
        if (!registry.length) {
            Logger.warn(`Provider "${name}" has no key_registry or key_env configured`);
            continue;
        }
        const anyResolved = registry.some(k => !!process.env[k]);
        if (!anyResolved) {
            Logger.warn(
                `Provider "${name}" key_registry env vars NONE resolvable: ` +
                `${registry.join(', ')} — provider will be skipped until secrets are wired.`
            );
        }
    }
    // Also check Gemini (top-level key_registry)
    const geminiRegistry = (config.ai && config.ai.key_registry) || [];
    if (geminiRegistry.length > 0) {
        const anyGemini = geminiRegistry.some(k => !!process.env[k]);
        if (!anyGemini) {
            Logger.warn(
                `Gemini key_registry env vars NONE resolvable: ` +
                `${geminiRegistry.join(', ')} — Stage 1 will be skipped.`
            );
        }
    }
}

/* ─────────────────────────────────────────────────────────────────
   Public: ask the AI for a structured trading decision.
   Returns { decision, keyUsed }. Mutates state.ai_keys_bench on failures.

   Strategy:
     1. Try every Gemini key in config.ai.key_registry (existing logic).
     2. If all benched/failed, walk config.ai.providers[] (in order),
        skipping disabled ones and ones with no env key.
   ───────────────────────────────────────────────────────────────── */
async function askDecision({ payload, config, state, prompt, schemaHint }) {
    _preflightKeyCheck(config);

    const registry = (config.ai && config.ai.key_registry) || [];
    const benchMin = (config.ai && config.ai.bench_minutes) || DEFAULT_BENCH_MINUTES;
    const timeoutMs = (config.ai && config.ai.timeout_ms) || DEFAULT_TIMEOUT_MS;
    const geminiModel = (config.ai && config.ai.model) || DEFAULT_MODEL;

    state.ai_keys_bench = state.ai_keys_bench || {};
    const now = Date.now();
    const fullPrompt = prompt || _buildDecisionPrompt(payload, schemaHint);

    let lastErr = null;

    // ---- Stage 1: Gemini multi-key (preserves existing behaviour) ----
    if (Array.isArray(registry) && registry.length > 0) {
        const ordered = _orderKeys(registry, state.ai_keys_bench, now);
        for (const row of ordered) {
            const keyValue = process.env[row.name];
            if (!keyValue) {
                Logger.warn(`Gemini key "${row.name}" not present in env — skipping`);
                continue;
            }
            if (row.benched) {
                Logger.warn(`All keys benched; trying least-recently-benched "${row.name}" anyway`);
            }
            try {
                const text = await _callGemini({ keyValue, model: geminiModel, prompt: fullPrompt, timeoutMs });
                const parsed = _parseJsonStrict(text);
                if (state.ai_keys_bench[row.name]) delete state.ai_keys_bench[row.name];
                Logger.info(`AI decision via gemini key "${row.name}"`, {
                    action: parsed.action, symbol: parsed.symbol, conf: parsed.confidence,
                });
                return { decision: parsed, keyUsed: row.name };
            } catch (e) {
                lastErr = e;
                state.ai_keys_bench[row.name] = now + benchMin * 60 * 1000;
                Logger.warn(`Gemini key "${row.name}" failed — benching ${benchMin}m`, { error: e.message });
            }
        }
    }

    // ---- Stage 2: fallback providers from config.ai.providers ----
    // Each provider supports key_registry[] (multi-key rotation, same as Gemini)
    // or a single key_env. key_registry takes precedence when present and non-empty.
    const providers = (config.ai && Array.isArray(config.ai.providers)) ? config.ai.providers : [];
    for (const p of providers) {
        if (!p || p.enabled === false) continue;
        const name = String(p.name || '').toLowerCase();
        // Skip Gemini — stage 1 already covered it.
        if (name === 'gemini') continue;

        const provRegistry = Array.isArray(p.key_registry) && p.key_registry.length > 0
            ? p.key_registry
            : (p.key_env ? [p.key_env] : []);

        if (!provRegistry.length) {
            Logger.warn(`Provider "${name}" has no key_registry or key_env — skipping`);
            continue;
        }

        const ordered = _orderKeys(provRegistry, state.ai_keys_bench, now);
        for (const row of ordered) {
            const keyValue = process.env[row.name];
            if (!keyValue) {
                Logger.warn(`Provider "${name}" key env "${row.name}" not set — skipping`);
                continue;
            }
            if (row.benched) {
                Logger.warn(`Provider "${name}" key "${row.name}" benched; trying anyway as fallback`);
            }
            try {
                const text = await _callProvider(p, { keyValue, prompt: fullPrompt, timeoutMs });
                const parsed = _parseJsonStrict(text);
                if (state.ai_keys_bench[row.name]) delete state.ai_keys_bench[row.name];
                Logger.info(`AI decision via provider "${name}" key "${row.name}"`, {
                    action: parsed.action, symbol: parsed.symbol, conf: parsed.confidence,
                });
                return { decision: parsed, keyUsed: row.name };
            } catch (e) {
                lastErr = e;
                state.ai_keys_bench[row.name] = now + benchMin * 60 * 1000;
                Logger.warn(`Provider "${name}" key "${row.name}" failed — benching ${benchMin}m`, { error: e.message });
            }
        }
    }

    throw new Error(`All AI providers/keys failed; last error: ${lastErr ? lastErr.message : 'unknown'}`);
}

/* ─────────────────────────────────────────────────────────────────
   Post-trade rationale: one-sentence "why did this win/lose".
   Best-effort; on total failure we return null and the caller logs.
   ───────────────────────────────────────────────────────────────── */
async function askPostMortem({ trade, postEntryCandles, config, state }) {
    const registry = (config.ai && config.ai.key_registry) || [];
    const providers = (config.ai && config.ai.providers) || [];
    if (!registry.length && !providers.some(p => p && p.enabled !== false)) return null;

    const prompt = [
        'You are a trading post-mortem assistant. In ONE short sentence (max 30 words),',
        'explain why this trade resulted in the outcome it did, based on the post-entry price action provided.',
        'Return STRICT JSON: {"note": "<one sentence>"}.',
        '',
        'Trade record:',
        JSON.stringify({
            symbol: trade.symbol,
            direction: trade.direction,
            stake: trade.stake,
            entry: trade.entry,
            exit: trade.exit,
            outcome: trade.outcome,
            pnl: trade.pnl,
            rationale_at_entry: trade.rationale,
        }, null, 2),
        '',
        'Post-entry price action (recent closes after entry):',
        JSON.stringify(postEntryCandles || [], null, 2),
    ].join('\n');

    try {
        const { decision } = await askDecision({ payload: null, config, state, prompt });
        if (decision && typeof decision.note === 'string') return decision.note;
        return null;
    } catch (e) {
        Logger.warn('Post-mortem AI call failed', { error: e.message });
        return null;
    }
}

/* ─────────────────────────────────────────────────────────────────
   Decision-prompt builder — used when caller doesn't supply one.
   ───────────────────────────────────────────────────────────────── */
function _buildDecisionPrompt(payload, schemaHint) {
    return [
        'You are AURELIA, an AI trade-decision engine for a Deriv binary-options bot.',
        'You are given a structured market snapshot for multiple symbols across M5/M10/M15,',
        'plus session context. Pick AT MOST ONE best setup, or skip.',
        '',
        'Hard rules you MUST obey:',
        '  • expiry_seconds MUST be >= 900 (15 minutes — Deriv forex intraday floor).',
        '    ANY duration at or above 900 seconds is allowed (e.g. 900, 1200, 1800,',
        '    3600, ... up to 24h). Pick whatever duration best fits the setup —',
        '    there is no implicit preference for the minimum.',
        '  • stake MUST be between meta.stake_floor and meta.stake_ceiling, max 2 decimals.',
        '    stake_ceiling is the ABSOLUTE per-trade cap, NOT the session budget.',
        '    Use small position sizing — never bet a significant fraction of session.capital_remaining on one trade.',
        '  • If nothing looks high-confidence, return {"action":"skip"} — do NOT force a trade.',
        '  • direction is "call" (price up) or "put" (price down).',
        '',
        'Return STRICT JSON only (no markdown fences):',
        schemaHint || _DEFAULT_SCHEMA,
        '',
        'Market + session payload:',
        JSON.stringify(payload, null, 2),
    ].join('\n');
}

const _DEFAULT_SCHEMA = JSON.stringify({
    action: '"trade" | "skip"',
    symbol: 'string (one of the symbols in payload.symbols), required if action=trade',
    direction: '"call" | "put", required if action=trade',
    expiry_seconds: 'integer >= 900 (any value at or above 15m is fine), required if action=trade',
    stake: 'number, required if action=trade',
    confidence: 'number 0.0-1.0',
    rationale: 'short string explaining the setup',
}, null, 2);

/* =====================================================================
   PART 2b — Multiplier decision: prompt + schema + defensive validator
   ─────────────────────────────────────────────────────────────────────
   The binary path above (askDecision / _buildDecisionPrompt / _DEFAULT_SCHEMA)
   stays untouched. The multiplier path is a *separate* prompt + validator
   that the runner calls via askMultiplierDecision().

   Output schema (returned by the AI, then defended by
   validateMultiplierDecision before the runner executes it):

     {
       action: 'hold' | 'skip' | 'close' | 'open' | 'revise' | 'multi',
       decision_id: string,        // opaque short id, propagated into audit trail
       rationale:   string,        // <= 400 chars, free text
       confidence?: number,        // 0..1, optional — used for min_confidence gate

       // Required iff action === 'close'.
       // Each entry MUST reference a contract_id present in aiInput.open_siblings.
       close?: [
         { contract_id: number, reason?: string }
       ],

       // Required iff action === 'open'. Single open spec — the runner
       // already supports the `siblings` fan-out (1..4).
       open?: {
         direction:   'up' | 'down',
         stake:       number,        // USD per sibling (each sibling gets this stake)
         multiplier:  number,        // positive integer
         take_profit: number | null, // $-amount; null = no TP
         stop_loss:   number | null, // $-amount; null = no SL
         siblings:    number         // 1..4 — how many siblings to open with this same shape
       },

       // Required iff action === 'revise'. Each entry must reference an
       // open contract_id. Field presence is meaningful:
       //   - field OMITTED  → leave that limit unchanged
       //   - field === null → CLEAR that limit on the live contract
       //   - field === <num> → set that limit (must be > 0)
       // (Mirrors deriv.reviseMultiplierLimits exactly.)
       revise?: [
         {
           contract_id: number,
           take_profit?: number | null,
           stop_loss?:   number | null
         }
       ],

       // Required iff action === 'multi'. Bundles up to one each of
       // close[] / open / revise[] so the AI can express, in a single
       // tick, e.g. "close sibling X AND open a new one" or "revise sibling
       // Y's TP AND open a new one". Runner dispatches each sub-action in
       // the order close → revise → open (close & revise first so any new
       // open does not collide with about-to-be-closed/revised siblings).
       multi?: {
         close?:  [ { contract_id: number, reason?: string } ],
         revise?: [ { contract_id: number, take_profit?: number|null, stop_loss?: number|null } ],
         open?:   { direction, stake, multiplier, take_profit, stop_loss, siblings }
       }
     }

   Validation rejects ANY malformed response with a hard "hold" fallback:
   wrong types, missing required fields for the chosen action, referencing
   a contract_id that isn't in aiInput.open_siblings, stake outside
   [stake.absolute_min, stake.absolute_max] or > capital_remaining, invalid
   direction, non-integer multiplier, negative TP/SL, etc.
   ===================================================================== */

const MAX_OPEN_SIBLINGS_PER_DECISION = 4;
const MAX_RATIONALE_LEN = 400;

/* ─────────────────────────────────────────────────────────────────
   Per-symbol-category VALID MULTIPLIER SET — verified live against
   Deriv's contracts_for endpoint (see deriv.js header comment block
   under "MULTIPLIERS — contract engine"). Sending a value outside
   this set causes Deriv to reject the proposal with:
     { error: { code: 'ContractBuyValidationError',
                message: 'Multiplier is not in acceptable range. Accepts ...' } }
   That used to silently fail downstream (the runner caught the throw
   but the Telegram template still rendered an "OPEN" message keyed
   off decision.open alone), so we now harden BOTH ends:
     1) the prompt advertises the correct per-category set to the AI;
     2) the validator rejects out-of-range values up front and rewrites
        the decision into a hold-with-explanation, so we never ship an
        unsupportable proposal to Deriv in the first place.
   ───────────────────────────────────────────────────────────────── */
/* Per-symbol multiplier ranges, verified live against Deriv's
   contracts_for endpoint (see scripts/probe-ranges-full.js). The
   prior category-based table was wrong for several synthetics —
   ranges differ symbol-to-symbol even within the "synthetic" family
   (e.g. R_10 accepts up to 4000, R_100 only up to 400), so we MUST
   look up per-symbol or Deriv rejects the buy with
   ContractBuyValidationError before the trade can open.

   The category table is retained as a fallback for symbols we have
   not probed (e.g. a new symbol added to config.json before someone
   re-runs scripts/probe-ranges-full.js). When that fallback fires,
   the AI prompt advertises the conservative intersection so any
   value the AI picks is at least plausible across categories. */
const MULTIPLIER_RANGE_BY_SYMBOL = {
    // --- Synthetics (volatility indices) ---
    R_10:    [400, 1000, 2000, 3000, 4000],
    R_25:    [160,  400,  800, 1200, 1600],
    R_50:    [ 80,  200,  400,  600,  800],
    R_75:    [ 50,  100,  200,  300,  500],
    R_100:   [ 40,  100,  200,  300,  400],
    '1HZ10V':  [400, 1000, 2000, 3000, 4000],
    '1HZ25V':  [160,  400,  800, 1200, 1600],
    '1HZ50V':  [ 80,  200,  400,  600,  800],
    '1HZ75V':  [ 50,  100,  200,  300,  500],
    '1HZ100V': [ 40,  100,  200,  300,  400],
    // --- Forex ---
    frxEURUSD: [100, 200, 300, 500, 800],
    frxGBPUSD: [100, 200, 300, 500, 800],
    frxUSDJPY: [100, 200, 300, 500, 800],
    frxXAUUSD: [100, 200, 300, 500, 800],
    // --- Crypto ---
    cryBTCUSD: [100, 200, 300, 500, 800],
    cryETHUSD: [100, 200, 300, 500, 800],
};

const MULTIPLIER_RANGE_BY_CATEGORY = {
    synthetic: [40, 100, 200, 300, 400],     // R_*, 1HZ*V  (conservative)
    forex:     [100, 200, 300, 500, 800],    // frx*
    crypto:    [100, 200, 300, 500, 800],    // cry*
};

function _categoryFor(symbol) {
    if (typeof symbol !== 'string') return null;
    if (symbol.startsWith('frx')) return 'forex';
    if (symbol.startsWith('cry')) return 'crypto';
    if (symbol.startsWith('R_') || /^1HZ\d+V$/.test(symbol)) return 'synthetic';
    return null;
}

function _validMultipliersFor(symbol) {
    if (typeof symbol === 'string' && MULTIPLIER_RANGE_BY_SYMBOL[symbol]) {
        return MULTIPLIER_RANGE_BY_SYMBOL[symbol];
    }
    const cat = _categoryFor(symbol);
    return cat ? MULTIPLIER_RANGE_BY_CATEGORY[cat] : null;
}

function _isPlainObject(o) {
    return o && typeof o === 'object' && !Array.isArray(o);
}
function _isPositiveFiniteNumber(n) {
    const x = Number(n);
    return Number.isFinite(x) && x > 0;
}

/* v4 fix: render aiInput.tp_sl_ranges as a compact, copy-pasteable
   table the AI can reason about directly. The probe was done at
   `probe_stake` and TP/SL caps scale linearly with stake at fixed
   multiplier, so we show the actual probed range plus the scaling rule.

   If no ranges were probed (e.g. cycle inactive, probe failed), we
   render a clear absence marker so the AI knows it must rely on
   conservative defaults. */
function _renderTpSlRangesForPrompt(aiInput) {
    const tsr = aiInput && aiInput.tp_sl_ranges;
    if (!tsr || !tsr.by_multiplier || !Object.keys(tsr.by_multiplier).length) {
        return '    LIVE TP/SL ranges: (not probed this tick — use conservative defaults: '
             + 'TP ≈ 1–3× stake, SL ≈ 0.5–1× stake, then trust the system to soft-clamp.)';
    }
    const probeStake = Number(tsr.probe_stake) || 0;
    const lines = [
        '    LIVE TP/SL ranges (probed THIS tick at stake=$' + probeStake.toFixed(2) + '):',
    ];
    const mults = Object.keys(tsr.by_multiplier).sort((a, b) => Number(a) - Number(b));
    for (const mKey of mults) {
        const entry = tsr.by_multiplier[mKey];
        const r = entry && entry.ranges;
        if (!r) {
            lines.push('      x' + mKey + ': (no validation_params returned)');
            continue;
        }
        const _fmt = (rg) => {
            if (!rg) return '—';
            const lo = rg.min != null ? '$' + Number(rg.min).toFixed(2) : '—';
            const hi = rg.max != null ? '$' + Number(rg.max).toFixed(2) : '—';
            return lo + '..' + hi;
        };
        lines.push('      x' + mKey + ':  TP ∈ ' + _fmt(r.take_profit)
                 + '   SL ∈ ' + _fmt(r.stop_loss)
                 + '   stake ∈ ' + _fmt(r.stake));
    }
    lines.push('    To scale to YOUR chosen stake: multiply each TP/SL bound by (your_stake / '
             + probeStake.toFixed(2) + ').');
    lines.push('    Example: if x300 SL range is $0.40..$8.59 at probe_stake $1.00, then at YOUR');
    lines.push('    stake of $10.00 the SL range becomes $4.00..$85.90. Pick a value inside.');
    return lines.join('\n');
}
function _isPositiveInteger(n) {
    const x = Number(n);
    return Number.isFinite(x) && x > 0 && Number.isInteger(x);
}

/* ─────────────────────────────────────────────────────────────────
   Internal validators for sub-shapes. Each returns { errs: [] } and
   the normalised value via the `out` accumulator.
   ───────────────────────────────────────────────────────────────── */
function _validateCloseList(list, openContractIds, label) {
    const errs = [];
    if (!Array.isArray(list) || list.length === 0) {
        errs.push(`${label} requires a non-empty array`);
        return { errs, value: null };
    }
    const out = [];
    const seen = new Set();
    for (let i = 0; i < list.length; i++) {
        const item = list[i];
        if (!_isPlainObject(item)) { errs.push(`${label}[${i}] not an object`); continue; }
        const cid = Number(item.contract_id);
        if (!Number.isFinite(cid) || cid <= 0) {
            errs.push(`${label}[${i}].contract_id invalid (${item.contract_id})`);
            continue;
        }
        if (!openContractIds.has(cid)) {
            errs.push(`${label}[${i}].contract_id ${cid} is not in open_siblings`);
            continue;
        }
        if (seen.has(cid)) {
            errs.push(`${label}[${i}].contract_id ${cid} duplicated`);
            continue;
        }
        seen.add(cid);
        const norm = { contract_id: cid };
        if (item.reason != null) norm.reason = String(item.reason).slice(0, 120);
        out.push(norm);
    }
    return { errs, value: out };
}

function _validateReviseList(list, openContractIds, label) {
    const errs = [];
    if (!Array.isArray(list) || list.length === 0) {
        errs.push(`${label} requires a non-empty array`);
        return { errs, value: null };
    }
    const out = [];
    const seen = new Set();
    for (let i = 0; i < list.length; i++) {
        const item = list[i];
        if (!_isPlainObject(item)) { errs.push(`${label}[${i}] not an object`); continue; }
        const cid = Number(item.contract_id);
        if (!Number.isFinite(cid) || cid <= 0) {
            errs.push(`${label}[${i}].contract_id invalid (${item.contract_id})`);
            continue;
        }
        if (!openContractIds.has(cid)) {
            errs.push(`${label}[${i}].contract_id ${cid} is not in open_siblings`);
            continue;
        }
        if (seen.has(cid)) {
            errs.push(`${label}[${i}].contract_id ${cid} duplicated`);
            continue;
        }
        // Presence semantics: hasOwnProperty distinguishes "omit" (leave
        // unchanged) from null (clear) from number (set). Mirror exactly
        // what deriv.reviseMultiplierLimits expects.
        const hasTP = Object.prototype.hasOwnProperty.call(item, 'take_profit');
        const hasSL = Object.prototype.hasOwnProperty.call(item, 'stop_loss');
        if (!hasTP && !hasSL) {
            errs.push(`${label}[${i}] no-op: neither take_profit nor stop_loss given`);
            continue;
        }
        const norm = { contract_id: cid };
        if (hasTP) {
            const v = item.take_profit;
            if (v === null) norm.take_profit = null;
            else if (_isPositiveFiniteNumber(v)) norm.take_profit = Number(v);
            else { errs.push(`${label}[${i}].take_profit must be null or > 0 (got ${v})`); continue; }
        }
        if (hasSL) {
            const v = item.stop_loss;
            if (v === null) norm.stop_loss = null;
            else if (_isPositiveFiniteNumber(v)) norm.stop_loss = Number(v);
            else { errs.push(`${label}[${i}].stop_loss must be null or > 0 (got ${v})`); continue; }
        }
        seen.add(cid);
        out.push(norm);
    }
    return { errs, value: out };
}

function _validateOpenSpec(spec, config, aiInput, label) {
    const errs = [];
    if (!_isPlainObject(spec)) {
        errs.push(`${label} must be an object`);
        return { errs, value: null };
    }
    // Gate first (cheap reject — Part 2a already exposes this signal).
    if (aiInput && aiInput.gates && aiInput.gates.can_open_new === false) {
        errs.push(`${label} blocked: ${aiInput.gates.reason || 'gate closed'}`);
        return { errs, value: null };
    }
    const dir = String(spec.direction || '').toLowerCase();
    if (dir !== 'up' && dir !== 'down') {
        errs.push(`${label}.direction must be 'up' or 'down' (got ${spec.direction})`);
    }
    if (!_isPositiveFiniteNumber(spec.stake)) {
        errs.push(`${label}.stake must be a positive finite number (got ${spec.stake})`);
    } else {
        const stake = Number(spec.stake);
        const min = (config.stake && config.stake.absolute_min) || 0.35;
        const max = (config.stake && config.stake.absolute_max) || 10000;
        if (stake < min) errs.push(`${label}.stake ${stake} < stake.absolute_min ${min}`);
        if (stake > max) errs.push(`${label}.stake ${stake} > stake.absolute_max ${max}`);
        // Capital sanity (advisory cap — Risk.clampStake will also clamp
        // each sibling per-iteration, but rejecting here is more honest).
        const cap = aiInput && aiInput.session && Number(aiInput.session.capital_remaining);
        const siblings = Math.max(1, Math.min(MAX_OPEN_SIBLINGS_PER_DECISION, Number(spec.siblings) || 1));
        if (Number.isFinite(cap) && cap > 0 && stake * siblings > cap) {
            errs.push(`${label}.stake * siblings (${stake}*${siblings}=${stake*siblings}) exceeds session.capital_remaining ${cap}`);
        }
    }
    if (!_isPositiveInteger(spec.multiplier)) {
        errs.push(`${label}.multiplier must be a positive integer (got ${spec.multiplier})`);
    } else {
        // Cross-check against the per-symbol-category set verified live
        // against Deriv's contracts_for. Out-of-range values were the
        // root cause of the silent-failure bug — catch them BEFORE we
        // ship a doomed proposal to Deriv.
        const validSet = _validMultipliersFor(aiInput && aiInput.symbol);
        if (validSet && !validSet.includes(Number(spec.multiplier))) {
            errs.push(`${label}.multiplier ${spec.multiplier} not in Deriv's accepted set for ${aiInput.symbol} (${validSet.join(', ')})`);
        }
    }
    // TP/SL: null/undefined OK (= no limit), otherwise > 0.
    if (spec.take_profit !== undefined && spec.take_profit !== null && !_isPositiveFiniteNumber(spec.take_profit)) {
        errs.push(`${label}.take_profit must be null or > 0 (got ${spec.take_profit})`);
    }
    if (spec.stop_loss !== undefined && spec.stop_loss !== null && !_isPositiveFiniteNumber(spec.stop_loss)) {
        errs.push(`${label}.stop_loss must be null or > 0 (got ${spec.stop_loss})`);
    }

    /* v4 fix: TP/SL range validation against aiInput.tp_sl_ranges.
       The runner probes Deriv's proposal endpoint THIS tick to discover
       the live validation_params (TP/SL min/max) for each accepted
       multiplier on this symbol. The probe is done at a fixed reference
       stake (probe_stake = config.stake.absolute_min); since TP/SL
       ranges scale linearly with stake at fixed multiplier, we rescale
       the probed range to the AI's chosen stake before validating.

       We do NOT hard-reject out-of-range values — instead we SOFT-CLAMP
       (snap to the nearest in-range value) and record a warning. */
    const _tsr = aiInput && aiInput.tp_sl_ranges;
    const _byMult = _tsr && _tsr.by_multiplier && _tsr.by_multiplier[String(spec.multiplier)];
    const _ranges = _byMult && _byMult.ranges;
    let tpFinal = spec.take_profit == null ? null : Number(spec.take_profit);
    let slFinal = spec.stop_loss   == null ? null : Number(spec.stop_loss);
    const tpSlWarnings = [];
    if (_ranges && _tsr.probe_stake > 0 && Number(spec.stake) > 0) {
        // Linear-scale the probed ranges to the AI's chosen stake.
        // (TP/SL caps scale 1:1 with stake at fixed multiplier — verified
        // by inspecting Deriv's validation_params at multiple stakes.)
        const scale = Number(spec.stake) / Number(_tsr.probe_stake);
        const _scaleRange = (r) => r ? {
            min: r.min != null ? r.min * scale : null,
            max: r.max != null ? r.max * scale : null,
        } : null;
        const scaledTP = _scaleRange(_ranges.take_profit);
        const scaledSL = _scaleRange(_ranges.stop_loss);

        if (tpFinal != null && scaledTP) {
            if (scaledTP.min != null && tpFinal < scaledTP.min) {
                tpSlWarnings.push(`${label}.take_profit ${tpFinal} below live min ${scaledTP.min.toFixed(2)} — clamped UP`);
                tpFinal = Number((scaledTP.min * 1.02).toFixed(2));
            } else if (scaledTP.max != null && tpFinal > scaledTP.max) {
                tpSlWarnings.push(`${label}.take_profit ${tpFinal} above live max ${scaledTP.max.toFixed(2)} — clamped DOWN`);
                tpFinal = Number((scaledTP.max * 0.98).toFixed(2));
            }
        }
        if (slFinal != null && scaledSL) {
            if (scaledSL.min != null && slFinal < scaledSL.min) {
                tpSlWarnings.push(`${label}.stop_loss ${slFinal} below live min ${scaledSL.min.toFixed(2)} — clamped UP`);
                slFinal = Number((scaledSL.min * 1.02).toFixed(2));
            } else if (scaledSL.max != null && slFinal > scaledSL.max) {
                tpSlWarnings.push(`${label}.stop_loss ${slFinal} above live max ${scaledSL.max.toFixed(2)} — clamped DOWN`);
                slFinal = Number((scaledSL.max * 0.98).toFixed(2));
            }
        }
    }

    const siblings = Math.max(1, Math.min(MAX_OPEN_SIBLINGS_PER_DECISION, Number(spec.siblings) || 1));
    if (errs.length) return { errs, value: null };
    return {
        errs,
        warnings: tpSlWarnings,                    // v4: TP/SL soft-clamp warnings
        value: {
            direction:   dir,
            stake:       Number(spec.stake),
            multiplier:  Number(spec.multiplier),
            take_profit: tpFinal,
            stop_loss:   slFinal,
            siblings,
        },
    };
}

/* ─────────────────────────────────────────────────────────────────
   Public: validateMultiplierDecision(raw, aiInput, config)

   Returns:
     { ok: true,  decision: <normalised> }
     { ok: false, decision: <hold-fallback>, errs: [reasons] }

   On failure we ALWAYS return a well-formed hold decision so the
   runner can call it the same way regardless. The errs array is for
   logging — Part 2c can also surface them via Telegram.
   ───────────────────────────────────────────────────────────────── */
function validateMultiplierDecision(raw, aiInput, config) {
    const errs = [];
    const cycleId = (aiInput && aiInput.cycle_id) || new Date().toISOString();
    const holdFallback = (rationale) => ({
        action:      'hold',
        decision_id: `invalid-${cycleId}`,
        rationale:   String(rationale || 'AI response failed validation; defaulting to hold.').slice(0, MAX_RATIONALE_LEN),
    });

    if (!_isPlainObject(raw)) {
        errs.push('decision is not an object');
        return { ok: false, decision: holdFallback('non-object AI response'), errs };
    }

    const action = String(raw.action || '').toLowerCase();
    const allowed = ['hold', 'skip', 'close', 'open', 'revise', 'multi'];
    if (!allowed.includes(action)) {
        errs.push(`action '${raw.action}' not in ${allowed.join('|')}`);
        return { ok: false, decision: holdFallback(`unknown action '${raw.action}'`), errs };
    }

    // min_confidence gate (optional — confidence field is itself optional).
    const minConf = (config && config.ai && config.ai.min_confidence) || 0;
    if (action !== 'hold' && action !== 'skip' && raw.confidence != null) {
        const c = Number(raw.confidence);
        if (Number.isFinite(c) && c < minConf) {
            // Treat low-confidence non-hold as a hold (don't reject — the
            // model TRIED, it just isn't sure enough).
            return {
                ok: true,
                decision: {
                    action:      'hold',
                    decision_id: String(raw.decision_id || `low-conf-${cycleId}`).slice(0, 64),
                    rationale:   `Confidence ${c} < min_confidence ${minConf}; AI rationale: ${String(raw.rationale || '').slice(0, 240)}`.slice(0, MAX_RATIONALE_LEN),
                    confidence:  c,
                },
            };
        }
    }

    // Common fields
    const decision_id = String(raw.decision_id || `dec-${cycleId.replace(/[^0-9A-Za-z]/g, '').slice(-12)}`).slice(0, 64);
    const rationale   = String(raw.rationale || '').slice(0, MAX_RATIONALE_LEN);
    // Fix #1: multi-symbol mode — the AI may explicitly return which
    // symbol it wants to trade. Pass it through so the runner can switch.
    const chosenSymbol = (raw.symbol && typeof raw.symbol === 'string') ? raw.symbol : undefined;

    // Build the set of contract_ids the AI is allowed to reference.
    const openContractIds = new Set();
    if (aiInput && Array.isArray(aiInput.open_siblings)) {
        for (const s of aiInput.open_siblings) {
            const cid = Number(s && s.contract_id);
            if (Number.isFinite(cid)) openContractIds.add(cid);
        }
    }

    if (action === 'hold' || action === 'skip') {
        return { ok: true, decision: { action, decision_id, rationale, confidence: _coerceConf(raw.confidence) } };
    }

    if (action === 'close') {
        if (openContractIds.size === 0) {
            errs.push("action 'close' but no open_siblings to close");
            return { ok: false, decision: holdFallback("AI wanted to close but nothing is open"), errs };
        }
        const r = _validateCloseList(raw.close, openContractIds, 'close');
        if (r.errs.length) {
            errs.push(...r.errs);
            return { ok: false, decision: holdFallback('close[] invalid: ' + r.errs.join('; ')), errs };
        }
        return { ok: true, decision: { action, decision_id, rationale, confidence: _coerceConf(raw.confidence), close: r.value, symbol: chosenSymbol } };
    }

    if (action === 'open') {
        const r = _validateOpenSpec(raw.open, config, aiInput, 'open');
        if (r.errs.length) {
            errs.push(...r.errs);
            return { ok: false, decision: holdFallback('open invalid: ' + r.errs.join('; ')), errs };
        }
        return {
            ok: true,
            warnings: r.warnings,                      // v4: TP/SL soft-clamp warnings
            decision: { action, decision_id, rationale, confidence: _coerceConf(raw.confidence), open: r.value, symbol: chosenSymbol },
        };
    }

    if (action === 'revise') {
        if (openContractIds.size === 0) {
            errs.push("action 'revise' but no open_siblings to revise");
            return { ok: false, decision: holdFallback("AI wanted to revise but nothing is open"), errs };
        }
        const r = _validateReviseList(raw.revise, openContractIds, 'revise');
        if (r.errs.length) {
            errs.push(...r.errs);
            return { ok: false, decision: holdFallback('revise[] invalid: ' + r.errs.join('; ')), errs };
        }
        return { ok: true, decision: { action, decision_id, rationale, confidence: _coerceConf(raw.confidence), revise: r.value, symbol: chosenSymbol } };
    }

    // action === 'multi'
    if (!_isPlainObject(raw.multi)) {
        errs.push("action 'multi' requires a 'multi' object");
        return { ok: false, decision: holdFallback("multi object missing"), errs };
    }
    const multi = {};
    const m = raw.multi;
    let anySubAction = false;

    if (m.close !== undefined) {
        anySubAction = true;
        if (openContractIds.size === 0) {
            errs.push("multi.close present but no open_siblings");
        } else {
            const r = _validateCloseList(m.close, openContractIds, 'multi.close');
            if (r.errs.length) errs.push(...r.errs);
            else multi.close = r.value;
        }
    }
    if (m.revise !== undefined) {
        anySubAction = true;
        if (openContractIds.size === 0) {
            errs.push("multi.revise present but no open_siblings");
        } else {
            // Don't allow revising a contract that's also in close[] —
            // it's about to be closed, so revising it is incoherent.
            const closing = new Set((multi.close || []).map(c => c.contract_id));
            const allowed = new Set([...openContractIds].filter(c => !closing.has(c)));
            const r = _validateReviseList(m.revise, allowed, 'multi.revise');
            if (r.errs.length) errs.push(...r.errs);
            else multi.revise = r.value;
        }
    }
    let multiOpenWarnings = [];
    if (m.open !== undefined) {
        anySubAction = true;
        const r = _validateOpenSpec(m.open, config, aiInput, 'multi.open');
        if (r.errs.length) errs.push(...r.errs);
        else {
            multi.open = r.value;
            multiOpenWarnings = r.warnings || [];
        }
    }
    if (!anySubAction) {
        errs.push("multi must contain at least one of close / revise / open");
    }
    if (errs.length) {
        return { ok: false, decision: holdFallback('multi invalid: ' + errs.join('; ')), errs };
    }
    return {
        ok: true,
        warnings: multiOpenWarnings,                   // v4: TP/SL soft-clamp warnings
        decision: { action, decision_id, rationale, confidence: _coerceConf(raw.confidence), multi, symbol: chosenSymbol },
    };
}

function _coerceConf(c) {
    if (c == null) return undefined;
    const n = Number(c);
    if (!Number.isFinite(n)) return undefined;
    if (n < 0) return 0;
    if (n > 1) return 1;
    return n;
}

/* ─────────────────────────────────────────────────────────────────
   Public: askMultiplierDecision({ aiInput, config, state })
     → { decision, keyUsed }

   Reuses askDecision's provider/key waterfall + benching by passing
   in a custom prompt built specifically for the multiplier flow. The
   binary path (askDecision with payload) is untouched.
   ───────────────────────────────────────────────────────────────── */
async function askMultiplierDecision({ aiInput, config, state }) {
    const prompt = _buildMultiplierPrompt(aiInput, config);

    let raw, keyUsed;
    try {
        // askDecision's contract: when `prompt` is provided, it ignores
        // `payload`. The Gemini/OpenAI/Claude clients all enforce strict
        // JSON output via responseMimeType / response_format.
        const r = await askDecision({ payload: null, config, state, prompt });
        raw = r.decision;
        keyUsed = r.keyUsed;
    } catch (e) {
        // Provider waterfall exhausted — fail safe to hold so the runner
        // can keep ticking (poll P/L, enforce session risk) without us.
        Logger.warn('askMultiplierDecision: all providers failed; defaulting to hold', { error: e.message });
        return {
            decision: {
                action:      'hold',
                decision_id: `provider-fail-${aiInput && aiInput.cycle_id}`,
                rationale:   `AI providers exhausted: ${String(e.message || '').slice(0, 240)}`,
            },
            keyUsed: null,
        };
    }

    const v = validateMultiplierDecision(raw, aiInput, config);
    if (!v.ok) {
        Logger.warn('askMultiplierDecision: AI response rejected, falling back to hold', {
            errs:        v.errs,
            keyUsed,
            raw_action:  raw && raw.action,
            raw_keys:    raw && Object.keys(raw),
        });
    } else {
        Logger.info('askMultiplierDecision: validated', {
            action:      v.decision.action,
            decision_id: v.decision.decision_id,
            keyUsed,
            warnings:    v.warnings && v.warnings.length ? v.warnings : undefined,
        });
        if (v.warnings && v.warnings.length) {
            Logger.warn('askMultiplierDecision: TP/SL soft-clamped to live ranges', {
                warnings: v.warnings,
            });
        }
    }
    return { decision: v.decision, keyUsed, warnings: v.warnings || [] };
}

/* ─────────────────────────────────────────────────────────────────
   Multiplier prompt — explains the sibling-position concept and the
   exact JSON schema the AI must emit. Kept verbose on purpose: this
   is the highest-leverage piece of the system to get right.
   ───────────────────────────────────────────────────────────────── */
function _buildMultiplierPrompt(aiInput, config) {
    const stakeMin = (config && config.stake && config.stake.absolute_min) || 0.35;
    const stakeMax = (config && config.stake && config.stake.absolute_max) || 10000;
    const minConf  = (config && config.ai && config.ai.min_confidence) || 0;
    const openCount = (aiInput && Array.isArray(aiInput.open_siblings)) ? aiInput.open_siblings.length : 0;
    const openCidList = (aiInput && Array.isArray(aiInput.open_siblings))
        ? aiInput.open_siblings.map(s => s && s.contract_id).filter(x => Number.isFinite(Number(x)))
        : [];

    return [
        'You are AURELIA-Multipliers, the AI decision engine for a Deriv MULTUP/MULTDOWN bot.',
        '',
        'WHAT MULTIPLIERS ARE',
        '  • A Multiplier position has NO expiry — it stays open across many cron ticks',
        '    (every ~60s) until you (or a TP/SL/stop_out) close it. There is no "wait',
        '    for it to settle". Every tick you decide what to do with what is currently open.',
        '  • You may have 0, 1, or several open positions on the SAME symbol simultaneously.',
        '    These are called SIBLINGS. Each sibling has its OWN stake, multiplier,',
        '    direction, TP/SL, and floating P/L. You can act on any subset of them.',
        '  • TP and stop_loss are $-amounts of profit/loss at which the position auto-closes,',
        '    NOT price levels. Deriv translates them into barrier prices internally.',
        '  • stop_out is the broker-enforced liquidation level — it kicks in when your',
        '    floating loss reaches the stake. You cannot disable it. Watch stop_out_distance_pct.',
        '',
        'WHAT YOU CAN DO ON THIS TICK',
        '  Each tick you choose ONE of these actions:',
        '    1. "hold"   — do nothing. Use when the open siblings are still good and no new',
        '                 setup is strong enough. This is the SAFE default.',
        '    2. "skip"   — equivalent to hold (no side effects). Prefer "hold".',
        '    3. "close"  — sell one or more specific open siblings at market. Identify them',
        '                 by contract_id (not by index — contract_ids are stable).',
        '    4. "open"   — open new MULTUP or MULTDOWN positions on this symbol. You can',
        '                 split one decision into up to ' + MAX_OPEN_SIBLINGS_PER_DECISION + ' siblings (each with the same',
        '                 direction/stake/multiplier/TP/SL). Set siblings=1 for no split.',
        '    5. "revise" — change TP and/or stop_loss on one or more open siblings WITHOUT',
        '                 closing them. Field semantics are precise:',
        '                   • OMIT a field      → leave that limit unchanged',
        '                   • field = null      → CLEAR that limit (no auto-close on TP/SL;',
        '                                          stop_out still applies)',
        '                   • field = number>0  → set that limit to this $-amount',
        '                 You can revise TP/SL EVERY TICK — it costs nothing and is the',
        '                 main way to manage a winning position (trail SL, raise TP).',
        '    6. "multi"  — combine one each of close / revise / open in the same response.',
        '                 Example: close one losing sibling AND open a new one in the',
        '                 opposite direction; or revise the TP on the winning sibling AND',
        '                 close the losing one. Use this when several actions are jointly',
        '                 better than any one alone.',
        '',
        'GATES (the runner enforces these regardless of what you say)',
        '  • can_open_new = ' + String(aiInput && aiInput.gates && aiInput.gates.can_open_new),
        '    Reason if false: ' + String(aiInput && aiInput.gates && aiInput.gates.reason),
        '  • If can_open_new is FALSE, do not return action="open" (and do not put',
        '    an open block inside a multi). "close" and "revise" are still allowed —',
        '    they manage existing exposure and are how you exit a halted session.',
        '',
        'HARD CONSTRAINTS',
        '  • stake (USD per sibling) must satisfy: ' + stakeMin + ' <= stake <= ' + stakeMax + '.',
        '    stake * siblings should also fit within session.capital_remaining = ' +
            String(aiInput && aiInput.session && aiInput.session.capital_remaining) + '.',
        '  • multiplier must be a POSITIVE INTEGER drawn from the EXACT per-symbol set',
        '    below (verified live against Deriv contracts_for; values OUTSIDE this set are',
        '    rejected by Deriv with ContractBuyValidationError and the trade DOES NOT open).',
        '    Ranges differ symbol-to-symbol even within the same category — do NOT assume',
        '    a synthetic-wide or category-wide set:',
        '    Current symbol: ' + String(aiInput && aiInput.symbol) +
            (_validMultipliersFor(aiInput && aiInput.symbol)
                ? ' → valid multipliers: ' + _validMultipliersFor(aiInput && aiInput.symbol).join(', ')
                : ' (no per-symbol range on file — pick a conservative value common across categories: 100, 200, 300)'),
        // Fix #1: multi-symbol candidate guidance
        (aiInput && Array.isArray(aiInput.candidates) && aiInput.candidates.length > 0)
            ? '  • MULTI-SYMBOL MODE: you are being shown ' + aiInput.candidates.length + ' candidate symbols this tick. ' +
              'Each candidate has its own market data in TICK INPUT under `candidates[]`. ' +
              'Compare the setups and pick the ONE with the strongest edge. ' +
              'Return your chosen symbol in the top-level `symbol` field of your JSON response ' +
              '(e.g., "symbol": "cryBTCUSD"). The runner will switch to that symbol for execution. ' +
              'If you choose "hold" or "skip", the symbol field is ignored. ' +
              'Candidate list: ' + aiInput.candidates.map(c => c.symbol || c).join(', ') + '.'
            : '  • SINGLE-SYMBOL MODE: you are trading only ' + String(aiInput && aiInput.symbol) + ' this tick.',
        '  • close[].contract_id and revise[].contract_id MUST be one of the contract_ids',
        '    that appear in payload.open_siblings on THIS tick. Open contract_ids right',
        '    now: ' + (openCidList.length ? openCidList.join(', ') : '(none — only hold/open are meaningful)') + '.',
        '  • direction is "up" (MULTUP) or "down" (MULTDOWN), lowercase.',
        '',
        '  • ⚠️ TAKE PROFIT and STOP LOSS must each fall inside Deriv\'s LIVE',
        '    per-contract range for the chosen {multiplier, stake}. These ranges',
        '    depend on the current spot, volatility, and your account balance, so',
        '    they CHANGE EVERY TICK. We probe them fresh on every tick and pass',
        '    them to you under `tp_sl_ranges` in the input payload. Submitting',
        '    TP/SL outside the live range causes:',
        '       ContractBuyValidationError: Enter an amount equal to or lower than X',
        '    and the trade DOES NOT open. The system will soft-clamp out-of-range',
        '    values to keep your trade alive, but the resulting TP/SL may differ',
        '    significantly from what you asked for — size CORRECTLY from the start.',
        _renderTpSlRangesForPrompt(aiInput),
        '  • confidence (optional) is 0.0..1.0. Decisions below ' + minConf + ' will be',
        '    treated as hold.',
        '',
        'DECISION GUIDANCE',
        '  • Default to "hold" unless you have a clear thesis. Doing nothing is always valid.',
        '  • If a sibling has a large floating gain, prefer revising its TP/SL (trail it)',
        '    over closing it — let winners run.',
        '  • If a sibling has a large floating loss AND your thesis no longer supports the',
        '    direction, close it. Don\'t hope.',
        '  • Watch stop_out_distance_pct on each sibling — if it\'s small (<0.5%), you are',
        '    one move away from forced liquidation; closing or tightening SL is wiser than',
        '    holding.',
        '  • There are currently ' + openCount + ' open sibling(s) on ' +
            String(aiInput && aiInput.symbol) + '. just_closed (this tick): ' +
            (aiInput && aiInput.just_closed ? aiInput.just_closed.length : 0) + '.',
        '',
        'RATIONALE QUALITY (this is enforced — vague rationales waste a decision cycle)',
        '  Your `rationale` MUST cite specific indicator readings and chart features that',
        '  are actually present in TICK INPUT below. Be concrete, not generic.',
        '  REQUIRED:',
        '    • Name each indicator you are reacting to BY NAME (RSI, MACD, Bollinger Bands,',
        '      EMA(20)/EMA(50), Stochastics, ATR, support/resistance level, etc.) — not',
        '      "momentum indicators" or "oscillators".',
        '    • Cite the actual NUMBERS from the input data: current RSI value, MACD',
        '      histogram sign, distance from upper/lower Bollinger Band, current spot vs.',
        '      a named EMA, recent high/low, etc. Do not invent numbers — only use values',
        '      that appear in TICK INPUT.',
        '    • If you are citing a candlestick / chart pattern, name it specifically',
        '      (e.g. "Bullish Engulfing", "Morning Star", "Hammer", "Double Top") rather',
        '      than "bullish signal".',
        '    • State a clear causal chain: indicator state → pattern/context → conclusion.',
        '  Still keep it to 2-3 sentences. Concrete, not longer.',
        '',
        '  STYLE REFERENCE (illustrative only — the symbol, direction, and numbers below',
        '  are NOT literal targets, just an example of the quality bar):',
        '    "1HZ25V • CALL • 15 USD • 30m',
        '     Why: Strong bearish trend exhausted, with price at lower Bollinger Band and',
        '     oversold RSI/Stochastics across all timeframes. Multiple bullish reversal',
        '     candle patterns (Morning Star, Bullish Engulfing, Hammer) indicate a high',
        '     probability of a bullish bounce."',
        '  What makes the example good: it names which Bollinger Band, which oscillators,',
        '  cites specific candle patterns by name, and chains them into a conclusion —',
        '  all in two sentences.',
        '',
        '  BAD examples (do NOT emit these — they will be flagged as low quality):',
        '    • "initiating a new MULTUP trade with a moderate stake to establish a market presence"',
        '    • "bullish signals suggest upward movement"',
        '    • "indicators are favourable; opening a position"',
        '',
        '  For "hold" / "skip", still name the specific reason ("RSI 52, no Bollinger Band',
        '  contact, no candle pattern — no edge") rather than "no clear setup".',
        '',
        'RETURN STRICT JSON ONLY (no markdown fences, no commentary). Schema:',
        _MULTIPLIER_SCHEMA_HINT,
        '',
        'TICK INPUT:',
        JSON.stringify(aiInput, null, 2),
    ].join('\n');
}

const _MULTIPLIER_SCHEMA_HINT = JSON.stringify({
    action:      '"hold" | "skip" | "close" | "open" | "revise" | "multi"',
    symbol:      'string (REQUIRED in multi-symbol mode — pick the best candidate from candidates[]; ignored for hold/skip)',
    decision_id: 'string (short opaque id you choose, e.g. "dec-7f02b1")',
    rationale:   '2-3 sentences (<=400 chars). MUST name specific indicators (RSI, MACD, Bollinger Bands, EMA, named candle patterns, S/R levels) and cite actual numbers from TICK INPUT. No invented values. No generic phrases like bullish signals or momentum is favourable.',
    confidence:  'number 0..1 (optional; below min_confidence => treated as hold)',
    close: [
        { contract_id: 'number (must be in open_siblings)', reason: 'optional string' },
    ],
    open: {
        direction:   '"up" | "down"',
        stake:       'number (USD per sibling, within stake.absolute_min/max)',
        multiplier:  'positive integer',
        take_profit: 'number > 0 OR null (null = no TP)',
        stop_loss:   'number > 0 OR null (null = no SL)',
        siblings:    'integer 1..4 (how many to open with this same shape)',
    },
    revise: [
        {
            contract_id: 'number (must be in open_siblings)',
            take_profit: 'OMIT to leave unchanged, null to CLEAR, or number>0 to set',
            stop_loss:   'OMIT to leave unchanged, null to CLEAR, or number>0 to set',
        },
    ],
    multi: {
        close:  '[{contract_id, reason?}]   — same rules as top-level close',
        revise: '[{contract_id, take_profit?, stop_loss?}] — same rules as top-level revise',
        open:   '{direction, stake, multiplier, take_profit, stop_loss, siblings} — same as top-level open',
    },
}, null, 2);

module.exports = {
    askDecision,
    askMultiplierDecision,
    askPostMortem,
    validateMultiplierDecision,
    // Exposed for unit tests / smoke tests:
    _buildMultiplierPrompt,
    MAX_OPEN_SIBLINGS_PER_DECISION,
    MULTIPLIER_RANGE_BY_CATEGORY,
    MULTIPLIER_RANGE_BY_SYMBOL,
    _categoryFor,
    _validMultipliersFor,
};
