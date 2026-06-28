/* =====================================================================
   AURELIA — Cloudflare Worker (Telegram webhook → GitHub Actions)
   ─────────────────────────────────────────────────────────────────────
   The control plane. Receives Telegram updates, mutates config.json
   in the repo, and dispatches workflow runs. No external npm
   dependencies — paste directly into the Cloudflare dashboard editor.

   Features (v2):
     • Full Settings panel (Cycle, Symbols, Account, AI, Payout,
       Daily Summary, Stake) — keyboard-driven, no slash commands needed
     • Symbol add / delete / enable / disable, split into Forex and
       Synthetic pools (synthetics gated by config.syn_enabled)
     • Global + per-symbol payout-threshold settings
     • Daily summary controls + "run now" trigger
     • Heartbeat alert: warns in TG when no tick observed for 15 min
     • Cron-job.org compatible: this worker NEVER touches GH cron;
       it only edits config.json and dispatches the workflow on-demand

   Environment variables (set in Cloudflare Worker settings):
     TELEGRAM_BOT_TOKEN   — from BotFather
     TELEGRAM_CHAT_ID     — owner's chat id (whitelist)
     GITHUB_PAT           — PAT with `repo` scope
     GITHUB_OWNER         — repo owner
     GITHUB_REPO          — repo name
     GITHUB_WORKFLOW      — workflow filename, e.g. "aurelia-cron.yml"
     GITHUB_REF           — e.g. "main"

   Gemini API keys are managed manually as GitHub Actions secrets
   (e.g. from Termux: `gh secret set GEMINI_KEY_FOO --repo OWNER/REPO`),
   then added to config.json's `ai.key_registry` array directly.
   ===================================================================== */

const GH_API = 'https://api.github.com';

/* ─────────────────────────────────────────────────────────────────
   SYMBOL CATALOGS — fixed lists selectable from the Add picker.
   Each catalog mirrors Deriv's `active_symbols` (verified live via
   wss://ws.derivws.com/websockets/v3 — see Part 3b notes).

   Notes on the forex pool:
     • Gold / silver / platinum / palladium use the `frx` prefix on
       Deriv (e.g. frxXAUUSD). Deriv classifies them under the
       `commodities` market, but their symbol namespace and the
       runner's `isSyntheticSymbol → fallback to forex` check both
       mean they belong functionally to the forex pool. We therefore
       keep them here rather than creating a separate commodities
       category (which would silently break runner gating).
     • Stock indices (OTC_SPC, OTC_NDX, etc.) DO NOT support the
       Multiplier contract — verified via `contracts_for` — so they
       are intentionally excluded from this multipliers-engine fork.
   ───────────────────────────────────────────────────────────────── */
const SYMBOL_CATALOG_FOREX = [
    // Major / minor / cross pairs
    'frxEURUSD','frxGBPUSD','frxUSDJPY','frxAUDUSD','frxUSDCAD','frxUSDCHF',
    'frxNZDUSD','frxEURJPY','frxEURGBP','frxGBPJPY','frxAUDJPY','frxEURAUD',
    'frxEURCAD','frxEURCHF','frxAUDNZD','frxAUDCAD','frxAUDCHF','frxCADJPY',
    'frxCHFJPY','frxGBPAUD','frxGBPCAD','frxGBPCHF','frxNZDJPY',
    // Metals (commodities market on Deriv but frx-prefixed — share forex
    // gating + same weekly market hours). Verified via active_symbols.
    'frxXAUUSD','frxXAGUSD','frxXPTUSD','frxXPDUSD',
];
const SYMBOL_CATALOG_SYN = [
    'R_10','R_25','R_50','R_75','R_100',
    '1HZ10V','1HZ25V','1HZ50V','1HZ75V','1HZ100V',
];
// Crypto — verified live: Deriv currently offers only BTC/USD and ETH/USD
// under the `cry` prefix (cryptocurrency / non_stable_coin). 24/7 market.
const SYMBOL_CATALOG_CRYPTO = [
    'cryBTCUSD','cryETHUSD',
];

/* ─────────────────────────────────────────────────────────────────
   POOL_CODES — single source of truth for the short codes used in
   callback_data (e.g. `sym:add:fx`, `sym:rm:syn`, `sym:add:cry`).
   Replaces the old `pool === 'forex' ? 'fx' : 'syn'` ternaries that
   were scattered across this file (broke as soon as a 3rd pool
   appeared). Use poolToCode() / codeToPool() in all new code.
   ───────────────────────────────────────────────────────────────── */
const POOL_CODES = {
    forex:      'fx',
    synthetics: 'syn',
    crypto:     'cry',
};
const CODE_TO_POOL = Object.fromEntries(
    Object.entries(POOL_CODES).map(([pool, code]) => [code, pool])
);
const POOL_CATALOGS = {
    forex:      SYMBOL_CATALOG_FOREX,
    synthetics: SYMBOL_CATALOG_SYN,
    crypto:     SYMBOL_CATALOG_CRYPTO,
};
// Pretty labels for the menu (singular noun used in Add/Remove titles).
const POOL_LABELS = {
    forex:      'Forex',
    synthetics: 'Synthetic',
    crypto:     'Crypto',
};
function poolToCode(pool) { return POOL_CODES[pool] || null; }
function codeToPool(code) { return CODE_TO_POOL[code] || null; }
// Crypto trades 24/7 (verified — exchange_is_open=1 even on weekends);
// forex/metals follow weekly market hours; synthetics are also 24/7
// (Deriv's synthetic indices run continuously). Used by the menu to
// surface the master-gate semantics correctly per pool.
function isPool24x7(pool) {
    return pool === 'crypto' || pool === 'synthetics';
}

const CHART_TFS = ['1m','5m','15m','30m','1h'];

/* ─────────────────────────────────────────────────────────────────
   Worker entry
   ───────────────────────────────────────────────────────────────── */
export default {
    async fetch(request, env) {
        if (request.method !== 'POST') {
            return new Response('aurelia webhook ok', { status: 200 });
        }
        let update;
        try { update = await request.json(); }
        catch { return new Response('bad json', { status: 400 }); }
        try { await handleUpdate(update, env); }
        catch (e) {
            console.error('handler error', e);
            try {
                const chatId = extractChatId(update);
                if (chatId && String(chatId) === String(env.TELEGRAM_CHAT_ID)) {
                    await tgSend(env, `🚨 <b>Worker error</b>\n<code>${escapeHtml(e.message)}</code>`);
                }
            } catch (_) {}
        }
        return new Response('ok', { status: 200 });
    },
};

/* ─────────────────────────────────────────────────────────────────
   Whitelist + dispatch
   ───────────────────────────────────────────────────────────────── */
function extractChatId(update) {
    if (update.message)         return update.message.chat && update.message.chat.id;
    if (update.callback_query)  return update.callback_query.message
                                    && update.callback_query.message.chat
                                    && update.callback_query.message.chat.id;
    if (update.edited_message)  return update.edited_message.chat && update.edited_message.chat.id;
    return null;
}

async function handleUpdate(update, env) {
    const chatId = extractChatId(update);
    if (!chatId || String(chatId) !== String(env.TELEGRAM_CHAT_ID)) return;

    // Heartbeat check (best-effort)
    await maybeAlertSilent(env);

    if (update.callback_query) return handleCallback(update.callback_query, env);
    if (update.message)        return handleMessage(update.message, env);
}

async function handleMessage(msg, env) {
    const text = String(msg.text || '').trim();
    if (!text) return;
    if (text.startsWith('/')) {
        const [cmd, ...rest] = text.split(/\s+/);
        return handleCommand(cmd.toLowerCase(), rest, env, msg);
    }
    const cfg = await ghReadJSON(env, 'config.json');
    const st  = await ghReadJSON(env, 'last-status.json').catch(() => ({}));
    return tgSend(env, renderMenu(cfg, st), { reply_markup: KB.mainMenu() });
}

/* ─────────────────────────────────────────────────────────────────
   Slash command handler
   ───────────────────────────────────────────────────────────────── */
async function handleCommand(cmd, args, env) {
    switch (cmd) {
        case '/start':
        case '/menu': {
            const cfg = await ghReadJSON(env, 'config.json');
            const st  = await ghReadJSON(env, 'last-status.json').catch(() => ({}));
            return tgSend(env, renderMenu(cfg, st), { reply_markup: KB.mainMenu() });
        }
        case '/status': {
            const cfg = await ghReadJSON(env, 'config.json');
            const st  = await ghReadJSON(env, 'last-status.json').catch(() => ({}));
            return tgSend(env, renderStatus(cfg, st), { reply_markup: KB.statusScreen() });
        }
        case '/scan':
            return dispatchManual(env, { action: 'trade_now' }, 'Manual scan triggered.');

        case '/syn': {
            const v = (args[0] || '').toLowerCase();
            const cfg = await ghReadJSON(env, 'config.json');
            if (v === 'on')  cfg.syn_enabled = true;
            else if (v === 'off') cfg.syn_enabled = false;
            else return tgSend(env, 'Usage: /syn on|off');
            await ghWriteJSON(env, 'config.json', cfg, `bot: SYN ${v}`);
            return tgSend(env, `Synthetics ${v === 'on' ? '✅ ON' : '⛔ OFF'}.`);
        }
        case '/cry':
        case '/crypto': {
            const v = (args[0] || '').toLowerCase();
            const cfg = await ghReadJSON(env, 'config.json');
            if (v === 'on')  cfg.cry_enabled = true;
            else if (v === 'off') cfg.cry_enabled = false;
            else return tgSend(env, 'Usage: /cry on|off');
            await ghWriteJSON(env, 'config.json', cfg, `bot: CRY ${v}`);
            return tgSend(env, `Crypto ${v === 'on' ? '✅ ON' : '⛔ OFF'}.`);
        }

        case '/startcycle': {
            const cfg = await ghReadJSON(env, 'config.json');
            const st  = await ghReadJSON(env, 'last-status.json').catch(() => ({}));
            await startCycleSession(env, cfg, st);
            await dispatchWorkflow(env, { task: 'cycle' });
            return tgSend(env, `▶️ Cycle started — capital $${cfg.cycle.session.capital}, TP $${cfg.cycle.session.take_profit}, SL $${cfg.cycle.session.stop_loss}.`);
        }
        case '/pausecycle': {
            const cfg = await ghReadJSON(env, 'config.json');
            cfg.cycle.running = false;
            await ghWriteJSON(env, 'config.json', cfg, 'bot: pause cycle');
            return tgSend(env, '⏸️ Cycle paused.');
        }

        case '/setcapital':
        case '/settp':
        case '/setsl':
        case '/setinterval': {
            const v = Number(args[0]);
            if (!Number.isFinite(v) || v < 0) return tgSend(env, `Usage: ${cmd} <number>`);
            const cfg = await ghReadJSON(env, 'config.json');
            if (cmd === '/setcapital') cfg.cycle.session.capital     = v;
            if (cmd === '/settp')      cfg.cycle.session.take_profit = v;
            if (cmd === '/setsl')      cfg.cycle.session.stop_loss   = v;
            if (cmd === '/setinterval')cfg.cycle.interval_seconds    = Math.max(10, Math.floor(v));
            await ghWriteJSON(env, 'config.json', cfg, `bot: ${cmd} ${v}`);
            return tgSend(env, `✅ ${cmd} = ${v}`);
        }

        case '/setpayout': {
            // /setpayout 0.85               → global threshold
            // /setpayout frxEURUSD 0.82     → per-symbol override
            // /setpayout clear frxEURUSD    → remove override
            const cfg = await ghReadJSON(env, 'config.json');
            cfg.payout = cfg.payout || { enabled: true, min_threshold: 0.80, per_symbol: {} };
            cfg.payout.per_symbol = cfg.payout.per_symbol || {};
            if (args[0] === 'clear' && args[1]) {
                delete cfg.payout.per_symbol[args[1]];
                await ghWriteJSON(env, 'config.json', cfg, `bot: clear payout override ${args[1]}`);
                return tgSend(env, `✅ Cleared payout override for <code>${escapeHtml(args[1])}</code>.`);
            }
            if (args.length === 1) {
                const v = Number(args[0]);
                if (!Number.isFinite(v) || v < 0 || v > 5) return tgSend(env, 'Usage: <code>/setpayout 0.85</code> (0–5 ratio)');
                cfg.payout.min_threshold = v;
                await ghWriteJSON(env, 'config.json', cfg, `bot: set payout threshold ${v}`);
                return tgSend(env, `✅ Global payout threshold = <b>${(v*100).toFixed(0)}%</b>`);
            }
            if (args.length === 2) {
                const sym = args[0]; const v = Number(args[1]);
                if (!Number.isFinite(v) || v < 0 || v > 5) return tgSend(env, 'Usage: <code>/setpayout SYM 0.85</code>');
                cfg.payout.per_symbol[sym] = v;
                await ghWriteJSON(env, 'config.json', cfg, `bot: set payout override ${sym}=${v}`);
                return tgSend(env, `✅ Payout override <code>${escapeHtml(sym)}</code> = <b>${(v*100).toFixed(0)}%</b>`);
            }
            return tgSend(env, 'Usage:\n<code>/setpayout 0.85</code>\n<code>/setpayout frxEURUSD 0.82</code>\n<code>/setpayout clear frxEURUSD</code>');
        }

        case '/summary':
        case '/dailysummary':
            await dispatchWorkflow(env, { task: 'daily_summary' });
            return tgSend(env, '📊 Daily summary queued.');

        case '/logs': {
            const st = await ghReadJSON(env, 'last-status.json').catch(() => ({}));
            return tgSend(env, renderLogs(st, 1, 'all'), { reply_markup: KB.logs(1, 'all') });
        }

        case '/chart': {
            const symbol = (args[0] || 'frxEURUSD').trim();
            const tf     = (args[1] || '5m').trim();
            return dispatchManual(env, { action: 'chart', symbol, tf }, `📈 Chart ${symbol} ${tf} queued.`);
        }

        case '/mode': {
            const v = (args[0] || '').toLowerCase();
            if (!['demo','real'].includes(v)) return tgSend(env, 'Usage: /mode demo|real');
            if (v === 'real') {
                return tgSend(env, '⚠️ <b>Switch to REAL account?</b>\nReal money will be traded.',
                    { reply_markup: KB.confirm('do:mode:real', 'set:account') });
            }
            const cfg = await ghReadJSON(env, 'config.json');
            cfg.account.mode = 'demo';
            await ghWriteJSON(env, 'config.json', cfg, 'bot: account demo');
            return tgSend(env, '🟡 Switched to <b>DEMO</b>.');
        }

        case '/settings':
        case '/setup': {
            const cfg = await ghReadJSON(env, 'config.json');
            return tgSend(env, renderSettingsHome(cfg), { reply_markup: KB.settings(cfg) });
        }

        default:
            return tgSend(env, helpText());
    }
}

function helpText() {
    return [
        '<b>AURELIA — commands</b>',
        '/menu  /status  /settings  /logs',
        '/scan — fire one manual AI trade',
        '/chart SYM TF  (e.g. /chart frxEURUSD 5m)',
        '',
        '<b>Cycle</b>',
        '/startcycle  /pausecycle',
        '/setcapital N  /settp N  /setsl N  /setinterval N',
        '',
        '<b>Payout filter</b>',
        '/setpayout 0.85          — global threshold',
        '/setpayout frxEURUSD 0.82 — per-symbol override',
        '/setpayout clear frxEURUSD',
        '',
        '<b>Other</b>',
        '/syn on|off  /mode demo|real  /summary',
    ].join('\n');
}

/* ─────────────────────────────────────────────────────────────────
   Inline callback handler
   ───────────────────────────────────────────────────────────────── */
async function handleCallback(cb, env) {
    const data = cb.data || '';
    await tgAnswerCallback(env, cb.id);
    const cfg = await ghReadJSON(env, 'config.json');
    const st  = await ghReadJSON(env, 'last-status.json').catch(() => ({}));

    /* ── Navigation ───────────────────────────────────────────── */
    if (data === 'menu')         return tgEdit(env, cb, renderMenu(cfg, st),       KB.mainMenu());
    if (data === 'status')       return tgEdit(env, cb, renderStatus(cfg, st),     KB.statusScreen());
    if (data === 'help')         return tgEdit(env, cb, helpText(),                KB.mainMenu());

    /* ── Settings home + sub-screens ──────────────────────────── */
    if (data === 'set:open' || data === 'settings')
        return tgEdit(env, cb, renderSettingsHome(cfg), KB.settings(cfg));
    if (data === 'set:cycle')
        return tgEdit(env, cb, renderCycle(cfg),        KB.cycleSettings(cfg));
    if (data === 'set:symbols')
        return tgEdit(env, cb, renderSymbolsHome(cfg),  KB.symbolsHome(cfg));
    if (data === 'set:symbols:fx')
        return tgEdit(env, cb, renderSymbolsPoolHeader(cfg, 'forex'),      KB.symbolsList(cfg, 'forex'));
    if (data === 'set:symbols:syn')
        return tgEdit(env, cb, renderSymbolsPoolHeader(cfg, 'synthetics'), KB.symbolsList(cfg, 'synthetics'));
    if (data === 'set:symbols:cry')
        return tgEdit(env, cb, renderSymbolsPoolHeader(cfg, 'crypto'),     KB.symbolsList(cfg, 'crypto'));
    if (data === 'set:account')
        return tgEdit(env, cb, renderAccount(cfg),      KB.account(cfg));
    if (data === 'set:ai')
        return tgEdit(env, cb, renderAi(cfg),           KB.aiSettings(cfg));
    if (data === 'set:ai:providers')
        return tgEdit(env, cb, renderAiProviders(cfg),  KB.aiProviders(cfg));
    if (data === 'set:payout')
        return tgEdit(env, cb, renderPayout(cfg),       KB.payoutSettings(cfg));
    if (data === 'set:daily')
        return tgEdit(env, cb, renderDaily(cfg, st),    KB.dailySettings(cfg));
    if (data === 'set:stake')
        return tgEdit(env, cb, renderStake(cfg),        KB.stakeSettings(cfg));

    /* ── Cycle actions ───────────────────────────────────────── */
    if (data === 'scan_now') {
        await dispatchManual(env, { action: 'trade_now' });
        return tgEdit(env, cb, '🤖 Manual AI scan queued — watch the chat.', KB.mainMenu());
    }
    if (data === 'cycle_start') {
        await startCycleSession(env, cfg, st);
        await dispatchWorkflow(env, { task: 'cycle' });
        return tgEdit(env, cb, '▶️ Cycle started.', KB.mainMenu());
    }
    if (data === 'cycle_pause') {
        cfg.cycle.running = false;
        await ghWriteJSON(env, 'config.json', cfg, 'bot: pause cycle');
        return tgEdit(env, cb, '⏸️ Cycle paused.', KB.mainMenu());
    }
    if (data === 'syn_toggle') {
        cfg.syn_enabled = !cfg.syn_enabled;
        await ghWriteJSON(env, 'config.json', cfg, `bot: SYN ${cfg.syn_enabled}`);
        return tgEdit(env, cb, `Synthetics: <b>${cfg.syn_enabled ? 'ON' : 'OFF'}</b>`, KB.mainMenu());
    }
    if (data === 'frx_toggle') {
        // FRX master gate — mirrors syn_enabled. Default treats undefined
        // as ON (backward compat with old configs).
        cfg.frx_enabled = !(cfg.frx_enabled !== false);
        await ghWriteJSON(env, 'config.json', cfg, `bot: FRX ${cfg.frx_enabled}`);
        return tgEdit(env, cb, renderSymbolsHome(cfg), KB.symbolsHome(cfg));
    }
    if (data === 'cry_toggle') {
        // CRY master gate — mirrors frx/syn. Default OFF (undefined → false)
        // so existing configs without the field stay disabled until the
        // operator opts in. Crypto markets are 24/7, no weekend gating.
        cfg.cry_enabled = !cfg.cry_enabled;
        await ghWriteJSON(env, 'config.json', cfg, `bot: CRY ${cfg.cry_enabled}`);
        return tgEdit(env, cb, renderSymbolsHome(cfg), KB.symbolsHome(cfg));
    }
    if (data === 'mode_toggle') {
        // Defensive — go through the confirm flow if switching to real
        if (cfg.account.mode !== 'real') {
            return tgEdit(env, cb, '⚠️ <b>Switch to REAL account?</b>\nReal money will be traded.',
                KB.confirm('do:mode:real', 'menu'));
        }
        cfg.account.mode = 'demo';
        await ghWriteJSON(env, 'config.json', cfg, 'bot: mode demo');
        return tgEdit(env, cb, '🟡 Switched to <b>DEMO</b>.', KB.mainMenu());
    }

    /* ── Adjust numeric cycle params via +/- buttons ─────────── */
    if (data.startsWith('cyc:')) {
        // cyc:<field>:<delta>  → field ∈ cap/tp/sl/iv
        const [, field, deltaStr] = data.split(':');
        const delta = Number(deltaStr);
        const newCfg = await ghReadJSON(env, 'config.json');
        if (field === 'cap') newCfg.cycle.session.capital     = Math.max(0, Number(newCfg.cycle.session.capital) + delta);
        if (field === 'tp')  newCfg.cycle.session.take_profit = Math.max(0, Number(newCfg.cycle.session.take_profit) + delta);
        if (field === 'sl')  newCfg.cycle.session.stop_loss   = Math.max(0, Number(newCfg.cycle.session.stop_loss) + delta);
        if (field === 'iv')  newCfg.cycle.interval_seconds    = Math.max(10, Math.floor(Number(newCfg.cycle.interval_seconds) + delta));
        await ghWriteJSON(env, 'config.json', newCfg, `bot: cycle ${field} ${delta>=0?'+':''}${delta}`);
        return tgEdit(env, cb, renderCycle(newCfg), KB.cycleSettings(newCfg));
    }

    /* ── Adjust AI params via +/- buttons ────────────────────── */
    if (data.startsWith('ai:')) {
        const parts = data.split(':');
        const field = parts[1];
        const newCfg = await ghReadJSON(env, 'config.json');
        newCfg.ai = newCfg.ai || {};

        // ai:prov:<name>  — toggle a provider's enabled flag
        if (field === 'prov') {
            const provName = parts.slice(2).join(':');
            newCfg.ai.providers = Array.isArray(newCfg.ai.providers) ? newCfg.ai.providers : [];
            const p = newCfg.ai.providers.find(x => x && x.name === provName);
            if (p) {
                p.enabled = !p.enabled;
                await ghWriteJSON(env, 'config.json', newCfg, `bot: ai provider ${provName} enabled=${p.enabled}`);
            }
            return tgEdit(env, cb, renderAiProviders(newCfg), KB.aiProviders(newCfg));
        }

        const delta = Number(parts[2]);
        if (field === 'conf') newCfg.ai.min_confidence = Math.max(0, Math.min(1, Number(((newCfg.ai.min_confidence||0) + delta).toFixed(2))));
        if (field === 'hist') newCfg.ai.max_history_entries = Math.max(1, Math.floor((newCfg.ai.max_history_entries||0) + delta));
        if (field === 'bench')newCfg.ai.bench_minutes = Math.max(1, Math.floor((newCfg.ai.bench_minutes||0) + delta));
        await ghWriteJSON(env, 'config.json', newCfg, `bot: ai ${field} ${delta>=0?'+':''}${delta}`);
        return tgEdit(env, cb, renderAi(newCfg), KB.aiSettings(newCfg));
    }

    /* ── Payout settings ─────────────────────────────────────── */
    if (data.startsWith('pay:')) {
        const newCfg = await ghReadJSON(env, 'config.json');
        newCfg.payout = newCfg.payout || { enabled: true, min_threshold: 0.80, per_symbol: {} };
        const parts = data.split(':');
        const action = parts[1];
        if (action === 'tog') {
            newCfg.payout.enabled = !newCfg.payout.enabled;
            await ghWriteJSON(env, 'config.json', newCfg, `bot: payout.enabled=${newCfg.payout.enabled}`);
            return tgEdit(env, cb, renderPayout(newCfg), KB.payoutSettings(newCfg));
        }
        if (action === 'adj') {
            const delta = Number(parts[2]);
            const cur = Number(newCfg.payout.min_threshold || 0.80);
            newCfg.payout.min_threshold = Math.max(0, Math.min(5, Number((cur + delta).toFixed(2))));
            await ghWriteJSON(env, 'config.json', newCfg, `bot: payout.min_threshold ${newCfg.payout.min_threshold}`);
            return tgEdit(env, cb, renderPayout(newCfg), KB.payoutSettings(newCfg));
        }
        if (action === 'overrides') {
            return tgEdit(env, cb, renderPayoutOverrides(newCfg), KB.payoutOverrides(newCfg));
        }
        if (action === 'clear') {
            const sym = parts.slice(2).join(':');
            if (newCfg.payout.per_symbol) delete newCfg.payout.per_symbol[sym];
            await ghWriteJSON(env, 'config.json', newCfg, `bot: clear payout override ${sym}`);
            return tgEdit(env, cb, renderPayoutOverrides(newCfg), KB.payoutOverrides(newCfg));
        }
    }

    /* ── Daily summary ───────────────────────────────────────── */
    if (data === 'daily:tog') {
        cfg.daily_summary = cfg.daily_summary || {};
        cfg.daily_summary.enabled = !cfg.daily_summary.enabled;
        await ghWriteJSON(env, 'config.json', cfg, `bot: daily_summary.enabled=${cfg.daily_summary.enabled}`);
        return tgEdit(env, cb, renderDaily(cfg, st), KB.dailySettings(cfg));
    }
    if (data === 'daily:reset_tog') {
        cfg.daily_summary = cfg.daily_summary || {};
        cfg.daily_summary.reset_on_send = !cfg.daily_summary.reset_on_send;
        await ghWriteJSON(env, 'config.json', cfg, `bot: daily_summary.reset_on_send=${cfg.daily_summary.reset_on_send}`);
        return tgEdit(env, cb, renderDaily(cfg, st), KB.dailySettings(cfg));
    }
    if (data === 'daily:run') {
        await dispatchWorkflow(env, { task: 'daily_summary' });
        return tgEdit(env, cb, '📊 Daily summary queued.', KB.dailySettings(cfg));
    }

    /* ── Stake bounds ────────────────────────────────────────── */
    if (data.startsWith('stk:')) {
        const [, field, deltaStr] = data.split(':');
        const delta = Number(deltaStr);
        const newCfg = await ghReadJSON(env, 'config.json');
        newCfg.stake = newCfg.stake || {};
        if (field === 'min') newCfg.stake.absolute_min = Math.max(0.01, Number(((newCfg.stake.absolute_min||0) + delta).toFixed(2)));
        if (field === 'max') newCfg.stake.absolute_max = Math.max(1, Math.floor((newCfg.stake.absolute_max||0) + delta));
        await ghWriteJSON(env, 'config.json', newCfg, `bot: stake ${field} ${delta}`);
        return tgEdit(env, cb, renderStake(newCfg), KB.stakeSettings(newCfg));
    }

    /* ── Symbols (pool-aware: forex / synthetics / crypto) ────── */
    // Helper: ensure cfg.symbols and the per-pool buckets exist before
    // mutating them. Centralised here so adding a 4th pool is a one-line
    // change rather than 4 separate sites to update.
    const ensureSymbolPools = (c) => {
        c.symbols = c.symbols || {};
        for (const p of Object.keys(POOL_CODES)) {
            c.symbols[p] = c.symbols[p] || {};
        }
        return c;
    };

    // Toggle one symbol on/off within its pool
    // Format: symtog:<pool>:<sym>
    if (data.startsWith('symtog:')) {
        const [, pool, ...symParts] = data.split(':');
        const sym = symParts.join(':');
        if (!POOL_CODES[pool]) {
            return tgEdit(env, cb, `⚠️ Unknown pool <code>${escapeHtml(pool)}</code>.`,
                KB.symbolsHome(cfg));
        }
        const newCfg = ensureSymbolPools(await ghReadJSON(env, 'config.json'));
        if (!Object.prototype.hasOwnProperty.call(newCfg.symbols[pool], sym)) {
            return tgEdit(env, cb, `⚠️ <code>${escapeHtml(sym)}</code> not in ${pool}.`,
                KB.symbolsList(newCfg, pool));
        }
        newCfg.symbols[pool][sym] = !newCfg.symbols[pool][sym];
        await ghWriteJSON(env, 'config.json', newCfg,
            `bot: ${newCfg.symbols[pool][sym] ? 'enable' : 'disable'} ${sym}`);
        return tgEdit(env, cb, renderSymbolsPoolHeader(newCfg, pool),
            KB.symbolsList(newCfg, pool));
    }

    // Open Add picker for a given pool — accepts any registered pool code
    if (data.startsWith('sym:add:')) {
        const code = data.slice('sym:add:'.length);
        const pool = codeToPool(code);
        if (!pool) {
            return tgEdit(env, cb, `⚠️ Unknown pool code <code>${escapeHtml(code)}</code>.`,
                KB.symbolsHome(cfg));
        }
        return tgEdit(env, cb,
            `➕ <b>Add ${POOL_LABELS[pool]} symbol</b>`,
            KB.symbolsAdd(cfg, pool));
    }
    // Add a symbol from the catalog
    if (data.startsWith('symadd:')) {
        const [, pool, ...symParts] = data.split(':');
        const sym = symParts.join(':');
        const catalog = POOL_CATALOGS[pool];
        if (!catalog) {
            return tgEdit(env, cb, `⚠️ Unknown pool <code>${escapeHtml(pool)}</code>.`,
                KB.symbolsHome(cfg));
        }
        if (!catalog.includes(sym)) {
            return tgEdit(env, cb, '⚠️ Unknown symbol.', KB.symbolsList(cfg, pool));
        }
        const newCfg = ensureSymbolPools(await ghReadJSON(env, 'config.json'));
        if (Object.prototype.hasOwnProperty.call(newCfg.symbols[pool], sym)) {
            return tgEdit(env, cb,
                `ℹ️ <code>${escapeHtml(sym)}</code> already in config.`,
                KB.symbolsList(newCfg, pool));
        }
        newCfg.symbols[pool][sym] = true;
        await ghWriteJSON(env, 'config.json', newCfg, `bot: add symbol ${sym}`);
        return tgEdit(env, cb,
            `✅ Added <code>${escapeHtml(sym)}</code> (enabled).`,
            KB.symbolsList(newCfg, pool));
    }
    // Open Remove picker for a pool — accepts any registered pool code
    if (data.startsWith('sym:rm:')) {
        const code = data.slice('sym:rm:'.length);
        const pool = codeToPool(code);
        if (!pool) {
            return tgEdit(env, cb, `⚠️ Unknown pool code <code>${escapeHtml(code)}</code>.`,
                KB.symbolsHome(cfg));
        }
        return tgEdit(env, cb,
            `🗑 <b>Remove ${POOL_LABELS[pool]} symbol</b>`,
            KB.symbolsRemove(cfg, pool));
    }
    // Confirm removal
    if (data.startsWith('symrm:ask:')) {
        const [, , pool, ...symParts] = data.split(':');
        const sym = symParts.join(':');
        return tgEdit(env, cb,
            `🗑 <b>Remove <code>${escapeHtml(sym)}</code>?</b>\nThis deletes the key from config (not just disables).`,
            KB.confirm(`symrm:do:${pool}:${sym}`, 'set:symbols'));
    }
    if (data.startsWith('symrm:do:')) {
        const [, , pool, ...symParts] = data.split(':');
        const sym = symParts.join(':');
        const newCfg = ensureSymbolPools(await ghReadJSON(env, 'config.json'));
        if (newCfg.symbols[pool] && Object.prototype.hasOwnProperty.call(newCfg.symbols[pool], sym)) {
            delete newCfg.symbols[pool][sym];
            await ghWriteJSON(env, 'config.json', newCfg, `bot: remove symbol ${sym}`);
        }
        return tgEdit(env, cb,
            `🗑 Removed <code>${escapeHtml(sym)}</code>.`,
            KB.symbolsList(newCfg, pool));
    }

    /* ── Account switch confirmations ─────────────────────────── */
    if (data === 'acct:real') {
        return tgEdit(env, cb,
            '⚠️ <b>Switch to REAL account?</b>\nReal money will be traded.',
            KB.confirm('do:mode:real', 'set:account'));
    }
    if (data === 'acct:demo') {
        cfg.account.mode = 'demo';
        await ghWriteJSON(env, 'config.json', cfg, 'bot: account demo');
        return tgEdit(env, cb, '🟡 Switched to <b>DEMO</b>.', KB.account(cfg));
    }
    if (data === 'do:mode:real') {
        cfg.account.mode = 'real';
        await ghWriteJSON(env, 'config.json', cfg, 'bot: account real');
        return tgEdit(env, cb, '🔴 Switched to <b>REAL</b>.', KB.account(cfg));
    }

    /* ── Chart picker ────────────────────────────────────────── */
    if (data === 'chart')
        return tgEdit(env, cb, '📈 <b>Chart — pick symbol</b>', KB.chartSymbol(cfg));
    if (data.startsWith('chart:sym:')) {
        const sym = data.slice('chart:sym:'.length);
        return tgEdit(env, cb,
            `📈 <b>${escapeHtml(sym)}</b> — pick timeframe`,
            KB.chartTf(sym));
    }
    if (data.startsWith('chart:go:')) {
        const parts = data.split(':');
        const tf  = parts[parts.length - 1];
        const sym = parts.slice(2, parts.length - 1).join(':');
        await dispatchManual(env, { action: 'chart', symbol: sym, tf },
            `📈 Chart for <code>${escapeHtml(sym)}</code> ${tf} queued.`);
        return tgEdit(env, cb,
            `📈 Chart for <b>${escapeHtml(sym)}</b> <code>${tf}</code> queued.`,
            KB.mainMenu());
    }

    /* ── Logs ────────────────────────────────────────────────── */
    if (data.startsWith('logs:')) {
        const [, page, filter] = data.split(':');
        return tgEdit(env, cb,
            renderLogs(st, Number(page) || 1, filter || 'all'),
            KB.logs(Number(page) || 1, filter || 'all'));
    }

    return tgEdit(env, cb, renderMenu(cfg, st), KB.mainMenu());
}

/* ─────────────────────────────────────────────────────────────────
   Helpers — cycle session reset (shared by /startcycle + cycle_start)
   ───────────────────────────────────────────────────────────────── */
async function startCycleSession(env, cfg, st) {
    const cap = Number(cfg.cycle.session.capital);
    cfg.cycle.running = true;
    st = st || {};
    st.cycle_session = {
        active: true, started_at: new Date().toISOString(),
        capital_start: cap, capital_remaining: cap,
        take_profit: Number(cfg.cycle.session.take_profit) || 0,
        stop_loss:   Number(cfg.cycle.session.stop_loss) || 0,
        trades: 0, wins: 0, losses: 0, pnl: 0,
        win_streak: 0, loss_streak: 0,
        halted: false, halt_reason: null,
    };
    st.cycle_open_position = null;
    st.next_cycle_eligible_at = 0;
    // Clear the SL/TP-halt notification latch (set in runner.js when
    // a halt fires) so a fresh session can emit its own halt alert.
    st._notified_halt_reason = null;
    // Part 3c — clear the end-of-session summary latch so the next
    // session's summary can fire when it ends. Runner stores the
    // session's started_at here once the summary has been sent.
    st._notified_session_summary = null;
    await ghWriteJSON(env, 'config.json',      cfg, 'bot: start cycle');
    await ghWriteJSON(env, 'last-status.json', st,  'bot: open cycle session');
}

/* ─────────────────────────────────────────────────────────────────
   Heartbeat — warn if no tick observed in 15 min and bot enabled
   ───────────────────────────────────────────────────────────────── */
async function maybeAlertSilent(env) {
    try {
        const cfg   = await ghReadJSON(env, 'config.json');
        const state = await ghReadJSON(env, 'last-status.json');
        if (!cfg || cfg.enabled === false || !state || !state.last_cycle) return;
        const ageMs = Date.now() - new Date(state.last_cycle).getTime();
        if (ageMs < 15 * 60 * 1000) return;
        // Throttle: only alert once per 15-min window via marker file
        let marker = null;
        try { marker = await ghReadFileText(env, '.heartbeat-alert'); } catch (_) {}
        const lastWarn = marker ? Number(marker.trim()) : 0;
        if (Date.now() - lastWarn < 15 * 60 * 1000) return;
        await ghPutFile(env, '.heartbeat-alert', String(Date.now()), 'bot: heartbeat alert');
        await tgSend(env,
            `⚠️ <b>AURELIA — BOT SILENT</b>\nNo tick detected in 15 minutes.\n` +
            `Last seen: <code>${escapeHtml(state.last_cycle)}</code>\n` +
            `Check cron-job.org and the GitHub Actions tab.`);
    } catch (e) {
        console.warn('heartbeat check failed', e.message);
    }
}

/* ─────────────────────────────────────────────────────────────────
   GitHub Contents API helpers
   ───────────────────────────────────────────────────────────────── */
function ghHeaders(env) {
    return {
        Authorization: `Bearer ${env.GITHUB_PAT}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'aurelia-worker',
    };
}
async function ghReadFile(env, path) {
    const url = `${GH_API}/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${encodeURIComponent(path)}?ref=${env.GITHUB_REF || 'main'}`;
    const r = await fetch(url, { headers: ghHeaders(env) });
    if (!r.ok) throw new Error(`ghReadFile ${path}: ${r.status}`);
    const j = await r.json();
    return { content: atob(j.content.replace(/\n/g, '')), sha: j.sha };
}
async function ghReadFileText(env, path) {
    const { content } = await ghReadFile(env, path);
    return content;
}
async function ghReadJSON(env, path) {
    const { content } = await ghReadFile(env, path);
    return JSON.parse(content);
}
async function ghPutFile(env, path, content, message) {
    let sha = undefined;
    try { sha = (await ghReadFile(env, path)).sha; } catch (_) {}
    const url = `${GH_API}/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${encodeURIComponent(path)}`;
    const body = {
        message: message || `bot: update ${path}`,
        content: btoa(unescape(encodeURIComponent(content))),
        branch:  env.GITHUB_REF || 'main',
        sha,
    };
    const r = await fetch(url, {
        method: 'PUT',
        headers: { ...ghHeaders(env), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`ghPutFile ${path}: ${r.status} ${(await r.text()).slice(0,200)}`);
}
async function ghWriteJSON(env, path, obj, message) {
    return ghPutFile(env, path, JSON.stringify(obj, null, 2) + '\n', message);
}

/* ─────────────────────────────────────────────────────────────────
   workflow_dispatch
   ───────────────────────────────────────────────────────────────── */
async function dispatchWorkflow(env, inputs = {}) {
    const wf = env.GITHUB_WORKFLOW || 'aurelia-cron.yml';
    const url = `${GH_API}/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/actions/workflows/${encodeURIComponent(wf)}/dispatches`;
    const r = await fetch(url, {
        method: 'POST',
        headers: { ...ghHeaders(env), 'Content-Type': 'application/json' },
        body: JSON.stringify({ ref: env.GITHUB_REF || 'main', inputs }),
    });
    if (!r.ok) throw new Error(`dispatch ${wf}: ${r.status}`);
}
async function dispatchManual(env, payload, replyText) {
    try {
        await dispatchWorkflow(env, { task: 'manual', payload: JSON.stringify(payload) });
        if (replyText) await tgSend(env, replyText);
    } catch (e) {
        await tgSend(env, `❌ dispatch failed: <code>${escapeHtml(e.message)}</code>`);
    }
}

/* ─────────────────────────────────────────────────────────────────
   Telegram
   ───────────────────────────────────────────────────────────────── */
async function tgApi(env, method, payload) {
    const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
    return r.json().catch(() => ({}));
}
async function tgSend(env, text, opts = {}) {
    return tgApi(env, 'sendMessage', {
        chat_id: env.TELEGRAM_CHAT_ID, text, parse_mode: 'HTML',
        disable_web_page_preview: true, reply_markup: opts.reply_markup,
    });
}
async function tgEdit(env, cb, text, replyMarkup) {
    return tgApi(env, 'editMessageText', {
        chat_id: cb.message.chat.id, message_id: cb.message.message_id,
        text, parse_mode: 'HTML', disable_web_page_preview: true,
        reply_markup: replyMarkup,
    });
}
async function tgAnswerCallback(env, id, text) {
    return tgApi(env, 'answerCallbackQuery', { callback_query_id: id, text: text || '' });
}

/* ─────────────────────────────────────────────────────────────────
   Render helpers
   ───────────────────────────────────────────────────────────────── */
function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function fmt2(n) { return (Number(n) || 0).toFixed(2); }
function pct(n)  { return ((Number(n) || 0) * 100).toFixed(0) + '%'; }
function badge(cfg) {
    return (cfg && cfg.account && cfg.account.mode === 'real') ? '🔴 REAL' : '🟡 DEMO';
}
function countEnabled(map) {
    if (!map) return [0, 0];
    const keys = Object.keys(map);
    return [keys.filter(k => map[k]).length, keys.length];
}

function renderMenu(cfg, st) {
    const cycle = cfg && cfg.cycle && cfg.cycle.running;
    const [fxOn,  fxTot]  = countEnabled(cfg && cfg.symbols && cfg.symbols.forex);
    const [synOn, synTot] = countEnabled(cfg && cfg.symbols && cfg.symbols.synthetics);
    const [cryOn, cryTot] = countEnabled(cfg && cfg.symbols && cfg.symbols.crypto);
    return [
        `⚡ <b>AURELIA</b> ${badge(cfg)}`,
        `Balance: <b>$${fmt2(st && st.balance)}</b>`,
        `Cycle: ${cycle ? '▶️ running' : '⏸️ paused'}   SYN: ${cfg && cfg.syn_enabled ? '✅' : '⛔'}   CRY: ${cfg && cfg.cry_enabled ? '✅' : '⛔'}`,
        `Symbols: FX ${fxOn}/${fxTot}  •  SYN ${synOn}/${synTot}  •  CRY ${cryOn}/${cryTot}`,
    ].join('\n');
}

function renderStatus(cfg, st) {
    if (!st) return `${badge(cfg)} (no state)`;
    const s = (st.cycle_session) || {};
    const sign = (s.pnl || 0) >= 0 ? '+' : '';
    const ds = st.daily_stats || {};
    const dsSign = (ds.pnl || 0) >= 0 ? '+' : '';
    return [
        `📊 <b>Status</b> ${badge(cfg)}`,
        '',
        `Balance         : <b>$${fmt2(st.balance)}</b>`,
        `Last tick       : <code>${escapeHtml(st.last_cycle || '—')}</code>`,
        '',
        `<b>Cycle session</b>`,
        `Active          : ${s.active ? '✅' : '⛔'}${s.halted ? ' (halted: ' + escapeHtml(s.halt_reason || '') + ')' : ''}`,
        `Capital left    : $${fmt2(s.capital_remaining)} / $${fmt2(s.capital_start)}`,
        `P/L             : ${sign}$${fmt2(s.pnl || 0)}`,
        `Trades / W / L  : ${s.trades || 0} / ${s.wins || 0} / ${s.losses || 0}`,
        `Streak (W/L)    : ${s.win_streak || 0} / ${s.loss_streak || 0}`,
        `TP / SL         : $${fmt2(s.take_profit)} / $${fmt2(s.stop_loss)}`,
        `Open position   : ${st.cycle_open_position ? escapeHtml(st.cycle_open_position.symbol + ' #' + st.cycle_open_position.contract_id) : '—'}`,
        '',
        `<b>Today (${escapeHtml(ds.date || '—')})</b>`,
        `Trades / W / L  : ${ds.trades || 0} / ${ds.wins || 0} / ${ds.losses || 0}`,
        `P/L             : ${dsSign}$${fmt2(ds.pnl || 0)}`,
    ].join('\n');
}

function renderSettingsHome(cfg) {
    return [
        `⚙️ <b>Settings</b> ${badge(cfg)}`,
        '',
        `Pick a section below. Most numeric values are tunable inline with +/- buttons.`,
    ].join('\n');
}

function renderCycle(cfg) {
    const c = cfg.cycle || {}; const s = c.session || {};
    return [
        `🌀 <b>Cycle settings</b>`,
        '',
        `Running         : ${c.running ? '▶️ yes' : '⏸️ no'}`,
        `Interval        : <b>${c.interval_seconds || 0}s</b>`,
        `Capital         : <b>$${fmt2(s.capital)}</b>`,
        `Take profit     : <b>$${fmt2(s.take_profit)}</b>`,
        `Stop loss       : <b>$${fmt2(s.stop_loss)}</b>`,
    ].join('\n');
}

function renderSymbolsHome(cfg) {
    const [fxOn,  fxTot]  = countEnabled(cfg.symbols && cfg.symbols.forex);
    const [synOn, synTot] = countEnabled(cfg.symbols && cfg.symbols.synthetics);
    const [cryOn, cryTot] = countEnabled(cfg.symbols && cfg.symbols.crypto);
    const frxOn = cfg.frx_enabled !== false;
    const cryGate = !!cfg.cry_enabled;
    return [
        `📡 <b>Symbols</b>`, '',
        `Forex      : ${fxOn} / ${fxTot} enabled   (weekly hours, closed weekends)`,
        `Synthetic  : ${synOn} / ${synTot} enabled   (24/7)`,
        `Crypto     : ${cryOn} / ${cryTot} enabled   (24/7)`,
        '',
        `FRX gate   : ${frxOn ? '✅ ON' : '⛔ OFF'} (master switch — overrides individual forex toggles)`,
        `SYN gate   : ${cfg.syn_enabled ? '✅ ON' : '⛔ OFF'} (master switch — overrides individual synth toggles)`,
        `CRY gate   : ${cryGate ? '✅ ON' : '⛔ OFF'} (master switch — overrides individual crypto toggles)`,
        '',
        `<i>Note: forex also covers metals (XAU/XAG/XPT/XPD) — they share the frx namespace and weekly market hours.</i>`,
    ].join('\n');
}

/* Per-pool header shown above the symbol list. Replaces the inline
   ternary that used to live in the route handlers. */
function renderSymbolsPoolHeader(cfg, pool) {
    const label = POOL_LABELS[pool] || pool;
    let gate;
    if (pool === 'forex')           gate = (cfg.frx_enabled !== false);
    else if (pool === 'synthetics') gate = !!cfg.syn_enabled;
    else if (pool === 'crypto')     gate = !!cfg.cry_enabled;
    else                            gate = true;
    const hoursNote = isPool24x7(pool) ? '24/7' : 'weekly hours (closed weekends)';
    const icon = pool === 'forex' ? '📡' : pool === 'crypto' ? '₿' : '🎲';
    return `${icon} <b>${label} symbols</b>\n` +
        `Master gate: ${gate ? '✅ ON' : '⛔ OFF'}   •   Hours: ${hoursNote}`;
}

function renderAccount(cfg) {
    const m  = cfg && cfg.account && cfg.account.mode;
    const id = (m === 'real') ? cfg.account.real_id : cfg.account.demo_id;
    return [
        `🔄 <b>Account</b>`, '',
        `${badge(cfg)} Currently: <b>${m ? m.toUpperCase() : '—'}</b>`,
        `Login id: <code>${escapeHtml(id || '—')}</code>`,
    ].join('\n');
}

/* Count how many API keys each provider has registered. Gemini is
   the legacy/top-level case (config.ai.key_registry). Every other
   provider stores its keys under provider.key_registry[] (multi-key
   rotation, same shape as Gemini) or as a single provider.key_env. */
function _providerKeyCount(provider) {
    if (!provider) return 0;
    if (Array.isArray(provider.key_registry) && provider.key_registry.length > 0) {
        return provider.key_registry.length;
    }
    // Single-env-var providers count as 1 "key slot" when key_env is set.
    if (provider.key_env) return 1;
    return 0;
}

function renderAi(cfg) {
    const a = cfg.ai || {};
    const providers = Array.isArray(a.providers) ? a.providers : [];
    const provOn = providers.filter(p => p && p.enabled !== false).length;

    const geminiKeys = (a.key_registry || []).length;

    // Per-provider key inventory — was previously only shown for Gemini.
    // Format example:
    //   gemini   : 4 keys  ✅
    //   openai   : 1 key   ✅  (env: OPENAI_API_KEY)
    //   grok     : 0 keys  ⛔
    //   claude   : 0 keys  ⛔
    const keyLines = [];
    // Gemini gets a synthetic top-level line so it appears alongside
    // the others rather than being a separate stat above.
    keyLines.push(
        `  • <b>gemini</b>  : ${geminiKeys} key${geminiKeys === 1 ? '' : 's'}  ✅  ` +
        `<i>(GEMINI_KEY_* secrets)</i>`
    );
    for (const p of providers) {
        if (!p || !p.name) continue;
        const n      = _providerKeyCount(p);
        const flag   = (p.enabled === false) ? '⛔' : (n > 0 ? '✅' : '⚠️');
        const envHint = p.key_env
            ? `<i>(env: <code>${escapeHtml(p.key_env)}</code>)</i>`
            : (Array.isArray(p.key_registry) && p.key_registry.length
                ? `<i>(registry: ${p.key_registry.length} secret${p.key_registry.length === 1 ? '' : 's'})</i>`
                : `<i>(no key configured)</i>`);
        keyLines.push(
            `  • <b>${escapeHtml(p.name)}</b>  : ${n} key${n === 1 ? '' : 's'}  ${flag}  ${envHint}`
        );
    }

    return [
        `🧠 <b>AI settings</b>`,
        '',
        `Default model    : <code>${escapeHtml(a.model || '—')}</code>`,
        `Min confidence   : <b>${pct(a.min_confidence)}</b>`,
        `History entries  : <b>${a.max_history_entries || 0}</b>`,
        `Bench minutes    : <b>${a.bench_minutes || 0}</b>`,
        `Providers        : <b>${provOn}</b> / ${providers.length} enabled (fallback waterfall)`,
        '',
        '🔑 <b>API keys</b>',
        keyLines.join('\n'),
        '',
        '<i>Keys are GitHub Actions secrets. Edit <code>ai.key_registry</code> for Gemini multi-key, or each provider\'s <code>key_registry[]</code> / <code>key_env</code> in <code>config.ai.providers</code>. Tap Providers to enable OpenAI / Grok / Claude fallback.</i>',
    ].join('\n');
}

function renderAiProviders(cfg) {
    const providers = (cfg.ai && Array.isArray(cfg.ai.providers)) ? cfg.ai.providers : [];
    const lines = providers.map(p => {
        const flag    = p.enabled === false ? '⛔' : '✅';
        const keys    = _providerKeyCount(p);
        const keyInfo = (Array.isArray(p.key_registry) && p.key_registry.length > 0)
            ? `keys: <b>${p.key_registry.length}</b> (registry)`
            : (p.key_env
                ? `key env: <code>${escapeHtml(p.key_env)}</code>`
                : `<i>no key configured</i>`);
        const warn = (keys === 0 && p.enabled !== false) ? '  ⚠️' : '';
        return [
            `${flag}  <b>${escapeHtml(p.name)}</b> — <code>${escapeHtml(p.model || '')}</code>${warn}`,
            `      ↳ ${keyInfo}`,
        ].join('\n');
    });
    return [
        `🧠 <b>AI Providers</b> (fallback waterfall)`,
        '',
        lines.length ? lines.join('\n') : '<i>(none configured — add entries to <code>config.ai.providers</code>)</i>',
        '',
        '<i>Tap a provider to toggle. When all Gemini keys are benched/failed, AURELIA waterfalls through enabled providers in the order shown. Each provider can use either a single <code>key_env</code> secret or a multi-key <code>key_registry[]</code> array (same rotation as Gemini). ⚠️ marks an enabled provider with no key configured — it will be skipped.</i>',
    ].join('\n');
}

function renderPayout(cfg) {
    const p = cfg.payout || {};
    const overrides = p.per_symbol || {};
    const overrideCount = Object.keys(overrides).length;
    return [
        `💸 <b>Payout filter</b>`,
        '',
        `Enabled          : ${p.enabled === false ? '⛔ OFF' : '✅ ON'}`,
        `Global threshold : <b>${pct(p.min_threshold || 0.80)}</b>`,
        `Per-symbol overrides: <b>${overrideCount}</b>`,
        '',
        '<i>Trades whose Deriv-quoted payout ratio is below the active threshold for the symbol are skipped (with a Telegram notice). This runs AFTER the AI decision as a defensive filter.</i>',
    ].join('\n');
}

function renderPayoutOverrides(cfg) {
    const p = cfg.payout || {}; const o = p.per_symbol || {};
    const lines = Object.entries(o).map(([sym, v]) => `  <code>${escapeHtml(sym)}</code> → <b>${pct(v)}</b>`);
    return [
        `💸 <b>Payout overrides</b>`,
        '',
        lines.length ? lines.join('\n') : '<i>(none — tap symbols below to remove, or use <code>/setpayout SYM 0.82</code> to add)</i>',
        '',
        `Global default: <b>${pct(p.min_threshold || 0.80)}</b>`,
    ].join('\n');
}

function renderDaily(cfg, st) {
    const d  = cfg.daily_summary || {};
    const ds = (st && st.daily_stats) || {};
    return [
        `📊 <b>Daily summary</b>`,
        '',
        `Auto-send        : ${d.enabled === false ? '⛔ OFF' : '✅ ON'}`,
        `Reset on send    : ${d.reset_on_send === false ? '⛔ NO' : '✅ YES'}`,
        '',
        `Today (${escapeHtml(ds.date || '—')})`,
        `  Trades  : ${ds.trades || 0}`,
        `  W / L   : ${ds.wins || 0} / ${ds.losses || 0}`,
        `  P/L     : ${(ds.pnl || 0) >= 0 ? '+' : ''}$${fmt2(ds.pnl || 0)}`,
        '',
        '<i>Schedule the daily run via cron-job.org → POST <code>{"task":"daily_summary"}</code> at 00:00 UTC (see SETUP.md §9).</i>',
    ].join('\n');
}

function renderStake(cfg) {
    const s = cfg.stake || {};
    return [
        `💰 <b>Stake bounds</b>`,
        '',
        `Min              : <b>$${fmt2(s.absolute_min)}</b>`,
        `Max              : <b>$${fmt2(s.absolute_max)}</b>`,
        '',
        `<i>The AI sizes the stake; these are pure sanity clamps applied in <code>risk.js</code>.</i>`,
    ].join('\n');
}

function renderLogs(st, page = 1, filter = 'all') {
    if (!st || !Array.isArray(st.logs)) return '📋 No logs.';
    const pageSize = 10;
    let logs = st.logs.slice().reverse();
    if (filter === 'trades') logs = logs.filter(l => l.level === 'trade');
    if (filter === 'errors') logs = logs.filter(l => l.level === 'error' || l.level === 'warn');
    const totalPages = Math.max(1, Math.ceil(logs.length / pageSize));
    page = Math.min(Math.max(1, page), totalPages);
    const slice = logs.slice((page - 1) * pageSize, page * pageSize);
    const lines = slice.map(l => {
        const t = (l.ts || '').slice(11, 16);
        const lvl = (l.level || '').padEnd(7);
        return `${t} ${lvl} ${escapeHtml(l.msg).slice(0, 80)}`;
    });
    return [
        `📋 <b>Logs — ${filter} (Page ${page}/${totalPages})</b>`, '',
        '<code>' + (lines.join('\n') || '(empty)') + '</code>',
    ].join('\n');
}

/* ─────────────────────────────────────────────────────────────────
   Inline keyboards
   ───────────────────────────────────────────────────────────────── */
function kb(rows) {
    return { inline_keyboard: rows.map(r => r.map(b => ({ text: b.text, callback_data: b.data }))) };
}

const KB = {
    mainMenu: () => kb([
        [{ text: '📊 Status',     data: 'status' },      { text: '🤖 Scan Now',    data: 'scan_now' }],
        [{ text: '▶️ Start Cycle', data: 'cycle_start' }, { text: '⏸️ Pause Cycle', data: 'cycle_pause' }],
        [{ text: '⚙️ Settings',   data: 'set:open' },    { text: '📈 Chart',       data: 'chart' }],
        [{ text: '🎛️ SYN',        data: 'syn_toggle' },  { text: '🔄 Mode',        data: 'mode_toggle' }],
        [{ text: '📋 Logs',        data: 'logs:1:all' },  { text: '❓ Help',         data: 'help' }],
    ]),
    statusScreen: () => kb([
        [{ text: '🔄 Refresh', data: 'status' }, { text: '🏠 Menu', data: 'menu' }],
    ]),

    /* Settings home */
    settings: (cfg) => kb([
        [{ text: '🌀 Cycle',         data: 'set:cycle' },   { text: '📡 Symbols',     data: 'set:symbols' }],
        [{ text: '🔄 Account',       data: 'set:account' }, { text: '🧠 AI',          data: 'set:ai' }],
        [{ text: '💸 Payout filter', data: 'set:payout' },  { text: '📊 Daily',       data: 'set:daily' }],
        [{ text: '💰 Stake bounds',  data: 'set:stake' }],
        [{ text: '⬅️ Menu',          data: 'menu' }],
    ]),

    /* Cycle adjuster */
    cycleSettings: (cfg) => kb([
        [{ text: '— Capital',       data: 'cyc:cap:-10' },
         { text: `$${fmt2(cfg.cycle.session.capital)}`, data: 'set:cycle' },
         { text: '+ Capital',       data: 'cyc:cap:10'  }],
        [{ text: '— TP $',          data: 'cyc:tp:-1' },
         { text: `$${fmt2(cfg.cycle.session.take_profit)}`, data: 'set:cycle' },
         { text: '+ TP $',          data: 'cyc:tp:1' }],
        [{ text: '— SL $',          data: 'cyc:sl:-1' },
         { text: `$${fmt2(cfg.cycle.session.stop_loss)}`, data: 'set:cycle' },
         { text: '+ SL $',          data: 'cyc:sl:1' }],
        [{ text: '— Interval',      data: 'cyc:iv:-15' },
         { text: `${cfg.cycle.interval_seconds || 0}s`, data: 'set:cycle' },
         { text: '+ Interval',      data: 'cyc:iv:15' }],
        [{ text: '▶️ Start',         data: 'cycle_start' },
         { text: '⏸️ Pause',         data: 'cycle_pause' }],
        [{ text: '⬅️ Settings',     data: 'set:open' }],
    ]),

    /* AI adjuster */
    aiSettings: (cfg) => {
        const a = cfg.ai || {};
        return kb([
            [{ text: '— Confidence', data: 'ai:conf:-0.05' },
             { text: pct(a.min_confidence), data: 'set:ai' },
             { text: '+ Confidence', data: 'ai:conf:0.05' }],
            [{ text: '— History',    data: 'ai:hist:-1' },
             { text: `${a.max_history_entries || 0}`, data: 'set:ai' },
             { text: '+ History',    data: 'ai:hist:1' }],
            [{ text: '— Bench (min)',data: 'ai:bench:-15' },
             { text: `${a.bench_minutes || 0}m`, data: 'set:ai' },
             { text: '+ Bench (min)',data: 'ai:bench:15' }],
            [{ text: '🔌 Providers', data: 'set:ai:providers' }],
            [{ text: '⬅️ Settings',  data: 'set:open' }],
        ]);
    },

    /* AI providers — toggle each provider's enabled flag */
    aiProviders: (cfg) => {
        const providers = (cfg.ai && Array.isArray(cfg.ai.providers)) ? cfg.ai.providers : [];
        const rows = providers.map(p => [{
            text: `${p.enabled === false ? '⛔' : '✅'} ${p.name}`,
            data: `ai:prov:${p.name}`,
        }]);
        if (rows.length === 0) {
            rows.push([{ text: '(no providers configured)', data: 'set:ai' }]);
        }
        rows.push([{ text: '⬅️ AI', data: 'set:ai' }]);
        return kb(rows);
    },

    /* Payout adjuster */
    payoutSettings: (cfg) => {
        const p = cfg.payout || {};
        return kb([
            [{ text: p.enabled === false ? '⛔ OFF (tap to enable)' : '✅ ON (tap to disable)', data: 'pay:tog' }],
            [{ text: '— Threshold',  data: 'pay:adj:-0.05' },
             { text: pct(p.min_threshold || 0.80), data: 'set:payout' },
             { text: '+ Threshold',  data: 'pay:adj:0.05' }],
            [{ text: '— 1%',         data: 'pay:adj:-0.01' },
             { text: '+ 1%',         data: 'pay:adj:0.01' }],
            [{ text: '🎯 Per-symbol overrides', data: 'pay:overrides' }],
            [{ text: '⬅️ Settings',  data: 'set:open' }],
        ]);
    },

    /* Payout overrides — list current ones with clear-button each */
    payoutOverrides: (cfg) => {
        const overrides = (cfg.payout && cfg.payout.per_symbol) || {};
        const rows = [];
        const entries = Object.entries(overrides);
        for (let i = 0; i < entries.length; i += 2) {
            const row = entries.slice(i, i + 2).map(([sym, v]) => ({
                text: `🗑 ${sym} (${pct(v)})`,
                data: `pay:clear:${sym}`,
            }));
            rows.push(row);
        }
        if (entries.length === 0) {
            rows.push([{ text: '(no overrides yet)', data: 'set:payout' }]);
        }
        rows.push([{ text: '⬅️ Payout', data: 'set:payout' }]);
        return kb(rows);
    },

    /* Daily summary controls */
    dailySettings: (cfg) => {
        const d = cfg.daily_summary || {};
        return kb([
            [{ text: d.enabled === false ? '⛔ Auto-send OFF' : '✅ Auto-send ON', data: 'daily:tog' }],
            [{ text: d.reset_on_send === false ? '⛔ Reset OFF' : '✅ Reset on send', data: 'daily:reset_tog' }],
            [{ text: '▶️ Run summary now', data: 'daily:run' }],
            [{ text: '⬅️ Settings',  data: 'set:open' }],
        ]);
    },

    /* Stake bounds */
    stakeSettings: (cfg) => {
        const s = cfg.stake || {};
        return kb([
            [{ text: '— Min',  data: 'stk:min:-0.05' },
             { text: `$${fmt2(s.absolute_min)}`, data: 'set:stake' },
             { text: '+ Min',  data: 'stk:min:0.05' }],
            [{ text: '— Max',  data: 'stk:max:-100' },
             { text: `$${fmt2(s.absolute_max)}`, data: 'set:stake' },
             { text: '+ Max',  data: 'stk:max:100' }],
            [{ text: '⬅️ Settings',  data: 'set:open' }],
        ]);
    },

    /* Account */
    account: (cfg) => {
        const m = cfg && cfg.account && cfg.account.mode;
        const other = m === 'real' ? 'demo' : 'real';
        return kb([
            [{ text: `Switch to ${other === 'real' ? '🔴 REAL' : '🟡 DEMO'}`,
               data: `acct:${other}` }],
            [{ text: '⬅️ Settings', data: 'set:open' }],
        ]);
    },

    /* Symbols home (pool picker) */
    symbolsHome: (cfg) => kb([
        [{ text: '💱 Forex',         data: 'set:symbols:fx'  },
         { text: '🎲 Synthetic',     data: 'set:symbols:syn' }],
        [{ text: '₿ Crypto',          data: 'set:symbols:cry' }],
        [{ text: (cfg.frx_enabled !== false) ? '⛔ Disable FRX gate' : '✅ Enable FRX gate', data: 'frx_toggle' },
         { text: cfg.syn_enabled ? '⛔ Disable SYN gate' : '✅ Enable SYN gate', data: 'syn_toggle' }],
        [{ text: cfg.cry_enabled ? '⛔ Disable CRY gate' : '✅ Enable CRY gate', data: 'cry_toggle' }],
        [{ text: '⬅️ Settings', data: 'set:open' }],
    ]),

    /* List symbols of one pool with toggle + add/remove footer */
    symbolsList: (cfg, pool) => {
        const code = poolToCode(pool) || 'fx';
        const back = `set:symbols:${code}`;
        const map = (cfg.symbols && cfg.symbols[pool]) || {};
        const ids = Object.keys(map).sort();
        const rows = [];
        for (let i = 0; i < ids.length; i += 2) {
            const row = ids.slice(i, i + 2).map(sym => ({
                text: `${map[sym] ? '✅' : '❌'} ${sym}`,
                data: `symtog:${pool}:${sym}`,
            }));
            rows.push(row);
        }
        if (ids.length === 0) rows.push([{ text: '(no symbols — tap Add)', data: `sym:add:${code}` }]);
        rows.push([
            { text: '➕ Add',    data: `sym:add:${code}` },
            { text: '🗑 Remove', data: `sym:rm:${code}` },
        ]);
        rows.push([{ text: '⬅️ Symbols', data: 'set:symbols' }]);
        return kb(rows);
    },

    /* Picker: catalog symbols NOT yet in config */
    symbolsAdd: (cfg, pool) => {
        const code = poolToCode(pool) || 'fx';
        const back = `set:symbols:${code}`;
        const have = (cfg.symbols && cfg.symbols[pool]) || {};
        const catalog = POOL_CATALOGS[pool] || [];
        const available = catalog.filter(s => !Object.prototype.hasOwnProperty.call(have, s));
        const rows = [];
        for (let i = 0; i < available.length; i += 2) {
            const row = available.slice(i, i + 2).map(sym => ({
                text: `➕ ${sym}`, data: `symadd:${pool}:${sym}`,
            }));
            rows.push(row);
        }
        if (available.length === 0) rows.push([{ text: '(catalog exhausted)', data: back }]);
        rows.push([{ text: '⬅️ Back', data: back }]);
        return kb(rows);
    },

    /* Picker: symbols currently in config — tap to confirm-remove */
    symbolsRemove: (cfg, pool) => {
        const code = poolToCode(pool) || 'fx';
        const back = `set:symbols:${code}`;
        const have = (cfg.symbols && cfg.symbols[pool]) || {};
        const ids = Object.keys(have);
        const rows = [];
        for (let i = 0; i < ids.length; i += 2) {
            const row = ids.slice(i, i + 2).map(sym => ({
                text: `🗑 ${sym}`, data: `symrm:ask:${pool}:${sym}`,
            }));
            rows.push(row);
        }
        if (ids.length === 0) rows.push([{ text: '(nothing to remove)', data: back }]);
        rows.push([{ text: '⬅️ Back', data: back }]);
        return kb(rows);
    },

    /* Confirm yes/no */
    confirm: (yes, no) => kb([
        [{ text: '✅ Confirm', data: yes }, { text: '❌ Cancel', data: no }],
    ]),

    /* Logs */
    logs: (page = 1, filter = 'all') => kb([
        [{ text: 'All',    data: `logs:1:all` },
         { text: 'Trades', data: `logs:1:trades` },
         { text: 'Errors', data: `logs:1:errors` }],
        [{ text: '◀️ Prev', data: `logs:${Math.max(1, page-1)}:${filter}` },
         { text: `Page ${page}`, data: `logs:${page}:${filter}` },
         { text: '▶️ Next', data: `logs:${page+1}:${filter}` }],
        [{ text: '🏠 Menu', data: 'menu' }],
    ]),

    /* Chart pickers — built from currently-enabled symbols, falls back
       to small static set when config is empty. */
    chartSymbol: (cfg) => {
        const all = [];
        const fx  = (cfg && cfg.symbols && cfg.symbols.forex)      || {};
        const syn = (cfg && cfg.symbols && cfg.symbols.synthetics) || {};
        const cry = (cfg && cfg.symbols && cfg.symbols.crypto)     || {};
        // FRX defaults to on when unset (legacy configs); SYN/CRY default off.
        if (cfg && cfg.frx_enabled !== false) Object.keys(fx).forEach(s => fx[s] && all.push(s));
        if (cfg && cfg.syn_enabled)           Object.keys(syn).forEach(s => syn[s] && all.push(s));
        if (cfg && cfg.cry_enabled)           Object.keys(cry).forEach(s => cry[s] && all.push(s));
        const pool = all.length ? all : ['frxEURUSD','frxGBPUSD','frxUSDJPY'];
        const rows = [];
        for (let i = 0; i < pool.length; i += 2) {
            const row = pool.slice(i, i + 2).map(s => ({ text: s, data: `chart:sym:${s}` }));
            rows.push(row);
        }
        rows.push([{ text: '⬅️ Menu', data: 'menu' }]);
        return kb(rows);
    },
    chartTf: (sym) => kb([
        ...((() => {
            const out = [];
            for (let i = 0; i < CHART_TFS.length; i += 3) {
                out.push(CHART_TFS.slice(i, i + 3).map(tf => ({
                    text: tf, data: `chart:go:${sym}:${tf}`,
                })));
            }
            return out;
        })()),
        [{ text: '⬅️ Symbols', data: 'chart' }],
    ]),
};
