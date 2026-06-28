/* =====================================================================
   AURELIA — runner.js
   ─────────────────────────────────────────────────────────────────────
   One serverless invocation = one tick of work. Four task modes,
   selected by INPUT_TASK (see .github/workflows/aurelia-cron.yml):

     • task=cycle         (default) → tick the AI cycle state machine
     • task=manual                  → fire one immediate AI trade outside the cycle
     • task=settle_only             → just settle any pending contracts (cheap)
     • task=daily_summary           → emit today's stats + reset daily_stats

   Cycle state machine (REBUILD_PROMPT §2A):
     1. Load config + last-status
     2. Settle any pending contracts (cycle + manual)
     3. If a cycle position is OPEN and unsettled → do nothing else this tick
     4. If cycle paused (config.cycle.running=false) → skip
     5. If session.halted → skip
     6. If now < next_cycle_eligible_at (post-settlement cooldown) → skip
     7. Build AI payload, ask Gemini for decision
     8. Validate, clamp (stake + expiry), per-symbol enable check,
        payout-threshold check, then place trade
     9. Record as cycle trade; set next_cycle_eligible_at after settlement

   Session TP/SL is enforced HERE, in code, not by the AI.

   Manual path (REBUILD_PROMPT §2B):
     • Reads INPUT_PAYLOAD for {action:"scan"|"trade_now", ...}
     • Ignores cycle_open_position lock
     • Does NOT touch cycle_session counters
     • Logged into trade_history_manual

   Daily summary (NEW):
     • cron-job.org POSTs {task:"daily_summary"} at 00:00 UTC
     • Reads state.daily_stats (accumulated by applyDailyStat() on every
       settled trade), emits the Telegram dailySummary message,
       optionally resets the counter to a fresh day.
   ===================================================================== */

'use strict';

const fs   = require('fs');
const path = require('path');

const Logger      = require('./logger');
const Deriv       = require('./deriv');
const Telegram    = require('./telegram');
const Chart       = require('./chart');
const Risk        = require('./risk');
const AIClient    = require('./ai-client');
const Payload     = require('./payload-builder');
const State       = require('./state');

const CFG_PATH   = path.join(__dirname, 'config.json');
const STATE_PATH = path.join(__dirname, 'last-status.json');

const HARD_BUDGET_MS = 55000;

/* ─────────────────────────────────────────────────────────────────
   IO
   ───────────────────────────────────────────────────────────────── */
function readJSON(p, fallback) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
    catch (e) { return fallback; }
}
function writeJSON(p, obj) {
    fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');
}
function detectTask() {
    const t = (process.env.INPUT_TASK || 'cycle').toLowerCase();
    if (['cycle', 'manual', 'settle_only', 'daily_summary'].includes(t)) return t;
    return 'cycle';
}

/* ─────────────────────────────────────────────────────────────────
   Symbol helpers — handle the {forex:{...}, synthetics:{...}, crypto:{...}} schema

   MERGE FIX (Part 3b ↔ Part 2a wiring): Part 3b added a third symbol
   pool (`crypto`, `cry`-prefixed) with full settings-menu parity in
   `worker/index.js`, but the runner-side gate here was written for
   only the original two pools. Without this fix, `cryBTCUSD` /
   `cryETHUSD` flow into the `else` branch and are looked up in the
   forex bucket, where they aren't listed, so `isSymbolEnabled`
   returns false and the cycle can never trade them — exactly the
   silent-bug failure mode the integration brief asked us to catch.
   Crypto symbols are `cry`-prefixed and gated by `cry_enabled`;
   gold (`frxXAU…`) stays in forex on purpose per Part 3b's summary.
   ───────────────────────────────────────────────────────────────── */
function isSyntheticSymbol(sym) {
    return /^R_\d+$|^1HZ\d+V$|^BOOM|^CRASH|^JD\d+$|^stpRNG/.test(sym);
}
function isCryptoSymbol(sym) {
    return typeof sym === 'string' && /^cry[A-Z]/.test(sym);
}
function isSymbolEnabled(sym, config) {
    if (!sym || !config || !config.symbols) return false;
    const fx  = config.symbols.forex      || {};
    const syn = config.symbols.synthetics || {};
    const cry = config.symbols.crypto     || {};
    if (isSyntheticSymbol(sym)) {
        if (!config.syn_enabled) return false;
        return !!syn[sym];
    }
    if (isCryptoSymbol(sym)) {
        // CRY master gate — defaults to false if not explicitly set
        // (matches the `cry_enabled` opt-in semantic Part 3b documented).
        if (!config.cry_enabled) return false;
        return !!cry[sym];
    }
    // FRX (forex) master gate — defaults to true if not explicitly set
    if (config.frx_enabled === false) return false;
    return !!fx[sym];
}

/* ─────────────────────────────────────────────────────────────────
   Payout filter — fetch a Deriv proposal for the chosen contract and
   reject it if the implied payout ratio is below threshold.
   Threshold resolution order:
       config.payout.per_symbol[symbol]  →  config.payout.min_threshold
   Set config.payout.enabled = false to bypass entirely.
   ───────────────────────────────────────────────────────────────── */
function resolvePayoutThreshold(sym, config) {
    const p = (config && config.payout) || {};
    if (p.per_symbol && Number.isFinite(Number(p.per_symbol[sym]))) {
        return Number(p.per_symbol[sym]);
    }
    return Number.isFinite(Number(p.min_threshold)) ? Number(p.min_threshold) : 0.80;
}
async function checkPayoutThreshold(ws, norm, config) {
    const p = (config && config.payout) || {};
    if (p.enabled === false) return { ok: true, ratio: null, threshold: null };
    const threshold = resolvePayoutThreshold(norm.symbol, config);
    try {
        const minutes = Risk.expirySecondsToMinutes(norm.expirySec);
        const reply = await Deriv.request(ws, {
            proposal: 1,
            amount: norm.stake,
            basis: 'stake',
            contract_type: norm.direction === 'call' ? 'CALL' : 'PUT',
            currency: 'USD',
            duration: minutes,
            duration_unit: 'm',
            symbol: norm.symbol,
        }, 10000);
        const prop = reply && reply.proposal;
        if (!prop) return { ok: true, ratio: null, threshold, soft: 'no_proposal' };
        const ask    = Number(prop.ask_price)   || Number(norm.stake);
        const payout = Number(prop.payout)      || 0;
        const ratio  = ask > 0 ? (payout / ask - 1) : 0;
        return {
            ok:        ratio >= threshold,
            ratio,
            threshold,
            payout,
            ask,
        };
    } catch (e) {
        Logger.warn('payout proposal failed; allowing trade', { error: e.message });
        return { ok: true, ratio: null, threshold, soft: 'proposal_error' };
    }
}

/* ─────────────────────────────────────────────────────────────────
   Daily stats — cumulative counter for the rolling UTC day. Reset by
   the daily_summary task. Independent of cycle_session.
   ───────────────────────────────────────────────────────────────── */
function todayUTC() {
    return new Date().toISOString().slice(0, 10);
}
function ensureDailyStats(state) {
    if (!state.daily_stats || state.daily_stats.date !== todayUTC()) {
        state.daily_stats = {
            date:    todayUTC(),
            trades:  0,
            wins:    0,
            losses:  0,
            pnl:     0,
            by_symbol: {},
        };
    }
    return state.daily_stats;
}
function applyDailyStat(state, record) {
    const ds = ensureDailyStats(state);
    ds.trades += 1;
    const pnl = Number(record.pnl || 0);
    ds.pnl = Number((ds.pnl + pnl).toFixed(2));
    if (record.outcome === 'win')  ds.wins   += 1;
    if (record.outcome === 'loss') ds.losses += 1;
    const bs = ds.by_symbol[record.symbol] || { trades: 0, wins: 0, losses: 0, pnl: 0 };
    bs.trades += 1;
    bs.pnl     = Number((bs.pnl + pnl).toFixed(2));
    if (record.outcome === 'win')  bs.wins   += 1;
    if (record.outcome === 'loss') bs.losses += 1;
    ds.by_symbol[record.symbol] = bs;
}

/* ─────────────────────────────────────────────────────────────────
   Validate AI decision (defence in depth, even though prompt says ≥900s)
   ───────────────────────────────────────────────────────────────── */
function validateDecision(d, config, state, opts) {
    const errs = [];
    if (!d || typeof d !== 'object') return { ok: false, errs: ['decision not object'] };
    if (d.action === 'skip') return { ok: true, skip: true };
    if (d.action !== 'trade') errs.push(`action must be "trade" or "skip" (got ${d.action})`);
    if (typeof d.symbol !== 'string' || !d.symbol) errs.push('symbol missing');
    const dir = String(d.direction || '').toLowerCase();
    if (!['call', 'put'].includes(dir)) errs.push(`direction invalid (${d.direction})`);
    if (errs.length) return { ok: false, errs };

    const expiry = Risk.clampExpirySeconds(d.expiry_seconds, config);
    const minConf = (config.ai && config.ai.min_confidence) || 0;
    if (Number(d.confidence) < minConf) {
        return { ok: true, skip: true, reason: `confidence ${d.confidence} < ${minConf}` };
    }

    if (!isSymbolEnabled(d.symbol, config)) {
        return { ok: true, skip: true, reason: `symbol ${d.symbol} disabled in config` };
    }

    let stakeOpts = {};
    if (opts && opts.cycle) {
        stakeOpts = { cycleSessionRemaining: (state.cycle_session && state.cycle_session.capital_remaining) };
    } else if (opts && opts.manual) {
        // Manual trades clamp against the MANUAL session capital_remaining
        stakeOpts = { cycleSessionRemaining: (state.manual_session && state.manual_session.capital_remaining) };
    }
    const stake = Risk.clampStake(d.stake, config, stakeOpts);

    return {
        ok: true,
        skip: false,
        normalised: {
            symbol:     d.symbol,
            direction:  dir,
            expirySec:  expiry,
            stake,
            confidence: Number(d.confidence) || 0,
            rationale:  String(d.rationale || ''),
        },
    };
}

/* ─────────────────────────────────────────────────────────────────
   Place a single trade (cycle OR manual). Returns the trade record.
   ───────────────────────────────────────────────────────────────── */
async function placeAndSettle(ws, norm, config, state, opts) {
    const contractType = norm.direction === 'call' ? 'CALL' : 'PUT';
    const minutes      = Risk.expirySecondsToMinutes(norm.expirySec);
    const mode         = (config.account && config.account.mode) || 'demo';
    const isCycle      = !!(opts && opts.cycle);

    // The Deriv socket may have gone stale while we waited on the AI
    // decision (Gemini calls can now take up to a few minutes) — make
    // sure we have a live connection right before placing the trade.
    if (opts && opts.connOpts) {
        ws = await Deriv.ensureOpen(ws, opts.connOpts);
    }

    let placedNotified = false;
    let contractIdShown = null;

    const contract = await Deriv.placeTrade(ws,
        {
            symbol:        norm.symbol,
            contractType,
            stake:         norm.stake,
            duration:      minutes,
            durationUnit:  'm',
        },
        {
            onPlaced: async ({ proposal, buy }) => {
                contractIdShown = buy.contract_id;
                // -----------------------------------------------------
                // Provisional capital HOLD — deduct stake from
                // capital_remaining the moment the buy is accepted, so
                // concurrent ticks can't overspend before settlement.
                // applyCycleSettlement / applyManualSettlement add back
                // `stake + pnl` on settle, leaving the math correct.
                // -----------------------------------------------------
                if (isCycle && state.cycle_session) {
                    state.cycle_session.capital_remaining = Number(
                        ((state.cycle_session.capital_remaining || 0) - norm.stake).toFixed(2)
                    );
                } else if (!isCycle && state.manual_session) {
                    state.manual_session.capital_remaining = Number(
                        ((state.manual_session.capital_remaining || 0) - norm.stake).toFixed(2)
                    );
                }
                try {
                    await Telegram.send(Telegram.templates.tradePlaced({
                        symbol:       norm.symbol,
                        mode,
                        direction:    contractType,
                        stake:        norm.stake,
                        duration:     minutes,
                        durationUnit: 'm',
                        strategy:     isCycle ? 'aurelia/cycle' : 'aurelia/manual',
                        contractId:   buy.contract_id,
                    }));
                    placedNotified = true;
                } catch (e) {
                    Logger.warn('Telegram tradePlaced failed', { error: e.message });
                }
                // Best-effort chart attached to placement notification.
                // chart.js already does one internal retry; we treat a
                // missing chart as a recoverable signal-side issue and
                // surface a small notice so the user knows the trade
                // itself was placed even when the visual didn't make it.
                try {
                    const buf = await Chart.generateChart(ws, norm.symbol, '5m');
                    if (buf && buf.length > 1024) {
                        await Telegram.sendPhoto(buf,
                            `${norm.symbol} • ${contractType} • ${norm.stake} USD • ${minutes}m\n` +
                            `Why: ${norm.rationale}`);
                    } else {
                        Logger.warn('Chart generation returned no usable buffer', {
                            symbol: norm.symbol,
                            bytes: buf ? buf.length : 0,
                        });
                        await Telegram.send(`📉 <i>Chart unavailable for <code>${norm.symbol}</code> — trade placed without chart attachment.</i>`).catch(() => {});
                    }
                } catch (e) {
                    Logger.warn('Chart generation failed (entry)', { error: e.message });
                    await Telegram.send(`📉 <i>Chart render failed for <code>${norm.symbol}</code> (<code>${String(e.message).slice(0,120)}</code>) — trade placed without chart.</i>`).catch(() => {});
                }
            },
            settleWaitMs: HARD_BUDGET_MS - 8000,
        }
    );

    // Build a stable trade record. CRITICAL: contract.settled is the
    // proposal_open_contract snapshot returned by Deriv — it may be a
    // terminal (is_sold/won/lost) snapshot OR a non-terminal "timeout"
    // snapshot. We must inspect is_sold/status to decide.
    const poc = (contract && contract.settled) || {};
    const isTerminal =
        !!poc.is_sold ||
        poc.status === 'sold' ||
        poc.status === 'won'  ||
        poc.status === 'lost';

    let outcome = 'pending';
    let pnl     = 0;
    let entry   = undefined;
    let exit    = undefined;

    if (isTerminal) {
        pnl = Number(poc.profit || 0);
        outcome = pnl > 0 ? 'win' : (pnl < 0 ? 'loss' : 'breakeven');
        entry = poc.entry_spot;
        exit  = poc.exit_tick || poc.sell_spot;
    }

    const record = {
        ts:         new Date().toISOString(),
        path:       isCycle ? 'cycle' : 'manual',
        symbol:     norm.symbol,
        direction:  norm.direction,
        stake:      norm.stake,
        expiry_sec: norm.expirySec,
        confidence: norm.confidence,
        rationale:  norm.rationale,
        contract_id: contract && contract.buy ? contract.buy.contract_id : contractIdShown,
        settled:    isTerminal,
        outcome,
        entry,
        exit,
        pnl,
        ai_outcome_note: null,
    };

    return { record, contract, ws, isTerminal };
}

/* ─────────────────────────────────────────────────────────────────
   Settle a pending contract record. Mutates `pending` entry, returns
   { settled: bool, outcome, pnl, exit, entry } when terminal.
   ───────────────────────────────────────────────────────────────── */
async function settlePending(ws, pending) {
    try {
        const reply = await Deriv.request(ws, {
            proposal_open_contract: 1,
            contract_id: pending.contract_id,
        }, 10000);
        const poc = reply.proposal_open_contract;
        if (!poc) return { settled: false };
        if (poc.is_sold) {
            const profit = Number(poc.profit || 0);
            return {
                settled: true,
                outcome: profit > 0 ? 'win' : profit < 0 ? 'loss' : 'breakeven',
                pnl:     profit,
                entry:   poc.entry_spot,
                exit:    poc.exit_tick || poc.sell_spot,
            };
        }
        return { settled: false };
    } catch (e) {
        Logger.warn(`settle ${pending.contract_id} failed`, { error: e.message });
        return { settled: false };
    }
}

/* ─────────────────────────────────────────────────────────────────
   Apply settlement to session counters (cycle only). Enforces TP/SL.
   ───────────────────────────────────────────────────────────────── */
function applyCycleSettlement(state, record) {
    const sess = state.cycle_session;
    if (!sess) return;
    sess.trades = (sess.trades || 0) + 1;
    const pnl = Number(record.pnl || 0);
    sess.pnl = Number(((sess.pnl || 0) + pnl).toFixed(2));
    // At placement we deducted the stake as a provisional hold. The
    // actual P&L delta (profit-or-loss above the stake) reconciles
    // capital_remaining to the correct post-trade value:
    //   loss:  hold = -stake; settle adds +(-stake)? NO — Deriv reports
    //          profit as a signed delta from the stake (e.g. -10 on a
    //          $10 loss, or +8.5 on a $10 win paying $18.5). So adding
    //          `stake + profit` here correctly returns the returned
    //          capital after a trade closes.
    sess.capital_remaining = Number(
        ((sess.capital_remaining || 0) + Number(record.stake || 0) + pnl).toFixed(2)
    );
    if (record.outcome === 'win') {
        sess.wins = (sess.wins || 0) + 1;
        sess.win_streak = (sess.win_streak || 0) + 1;
        sess.loss_streak = 0;
    } else if (record.outcome === 'loss') {
        sess.losses = (sess.losses || 0) + 1;
        sess.loss_streak = (sess.loss_streak || 0) + 1;
        sess.win_streak = 0;
    }
    // TP / SL enforcement
    if (sess.take_profit > 0 && sess.pnl >= sess.take_profit) {
        sess.active = false;
        sess.halted = true;
        sess.halt_reason = `take_profit reached (+${sess.pnl})`;
    }
    if (sess.stop_loss > 0 && sess.pnl <= -sess.stop_loss) {
        sess.active = false;
        sess.halted = true;
        sess.halt_reason = `stop_loss reached (${sess.pnl})`;
    }
    if (sess.capital_remaining <= 0) {
        sess.active = false;
        sess.halted = true;
        sess.halt_reason = `capital exhausted`;
    }
}

/* ─────────────────────────────────────────────────────────────────
   Apply settlement to manual session counters (separate envelope).
   Manual session resets daily via ensureManualSession() — no TP/SL
   halt loop needed (manual is fire-and-forget), but we still track
   capital_remaining and stop sizing when it drops to zero.
   ───────────────────────────────────────────────────────────────── */
function applyManualSettlement(state, record) {
    const sess = state.manual_session;
    if (!sess) return;
    sess.trades = (sess.trades || 0) + 1;
    const pnl = Number(record.pnl || 0);
    sess.pnl = Number(((sess.pnl || 0) + pnl).toFixed(2));
    sess.capital_remaining = Number(
        ((sess.capital_remaining || 0) + Number(record.stake || 0) + pnl).toFixed(2)
    );
    if (record.outcome === 'win')  sess.wins   = (sess.wins   || 0) + 1;
    if (record.outcome === 'loss') sess.losses = (sess.losses || 0) + 1;
}

/* ─────────────────────────────────────────────────────────────────
   Ensure a manual_session envelope exists, rolling daily. Capital,
   TP and SL come from config.manual; the session resets to a fresh
   envelope every UTC day.
   ───────────────────────────────────────────────────────────────── */
function ensureManualSession(state, config) {
    const today = todayUTC();
    const cfgManual = (config && config.manual) || {};
    const cap = Number(cfgManual.capital || 0);
    const tp  = Number(cfgManual.take_profit || 0);
    const sl  = Number(cfgManual.stop_loss   || 0);
    if (!state.manual_session || state.manual_session.date !== today) {
        state.manual_session = {
            date:              today,
            active:            true,
            capital_start:     cap,
            capital_remaining: cap,
            take_profit:       tp,
            stop_loss:         sl,
            trades: 0, wins: 0, losses: 0, pnl: 0,
        };
    } else {
        // Keep envelope params live with current config (so editing
        // config.manual takes effect immediately on the next trade).
        state.manual_session.take_profit = tp;
        state.manual_session.stop_loss   = sl;
    }
    return state.manual_session;
}

/* ─────────────────────────────────────────────────────────────────
   Settle ALL outstanding pending contracts (cycle + manual). For
   newly-terminal ones, optionally fire a post-mortem AI call to
   capture an `ai_outcome_note`.
   ───────────────────────────────────────────────────────────────── */
async function settleAllPending(ws, config, state) {
    if (!Array.isArray(state.pending_contracts)) state.pending_contracts = [];
    const still = [];
    const newlySettled = [];
    for (const p of state.pending_contracts) {
        const r = await settlePending(ws, p);
        if (!r.settled) { still.push(p); continue; }
        // Patch the trade history record by contract_id
        const histArr = p.path === 'manual'
            ? state.trade_history_manual
            : state.trade_history_cycle;
        const rec = (histArr || []).find(t => t.contract_id === p.contract_id);
        if (rec) {
            rec.settled = true;
            rec.outcome = r.outcome;
            rec.pnl     = r.pnl;
            rec.entry   = r.entry;
            rec.exit    = r.exit;
            newlySettled.push({ rec, path: p.path });
            if (p.path === 'cycle')  applyCycleSettlement(state, rec);
            if (p.path === 'manual') applyManualSettlement(state, rec);
            applyDailyStat(state, rec);
            // Clear cycle position lock if this was the open cycle position
            if (p.path === 'cycle' && state.cycle_open_position &&
                state.cycle_open_position.contract_id === p.contract_id) {
                state.cycle_open_position = null;
                state.next_cycle_eligible_at =
                    Date.now() + 1000 * ((config.cycle && config.cycle.interval_seconds) || 60);
            }
        }
    }
    state.pending_contracts = still;

    // Detect cycle-session halt transitions caused by the settlements
    // we just applied (TP / SL / capital exhaustion). We snapshot the
    // halted flag BEFORE applyCycleSettlement runs and compare against
    // the post-state here so we only notify on the actual transition.
    if (state.cycle_session
        && state.cycle_session.halted
        && !state._notified_halt_reason) {
        const reason = String(state.cycle_session.halt_reason || '');
        let kind = 'other';
        if (/take_profit/i.test(reason)) kind = 'take_profit';
        else if (/stop_loss/i.test(reason)) kind = 'stop_loss';
        else if (/capital/i.test(reason)) kind = 'capital';
        try {
            await Telegram.send(Telegram.templates.sessionHalted({
                kind,
                reason,
                mode:     state.account_mode || (config.account && config.account.mode),
                session:  {
                    wins:              state.cycle_session.wins,
                    losses:            state.cycle_session.losses,
                    pnl:               state.cycle_session.pnl,
                    trades:            state.cycle_session.trades,
                    capital_remaining: state.cycle_session.capital_remaining,
                },
                balance:  state.balance,
                currency: state.currency,
            }));
            // Latch so we don't re-notify on every subsequent tick while
            // the session stays halted. Cleared in startCycleSession().
            state._notified_halt_reason = reason;
        } catch (e) {
            Logger.warn('sessionHalted notification failed', { error: e.message });
        }
    }

    // Fire settled notifications + post-mortems
    for (const { rec } of newlySettled) {
        try {
            await Telegram.send(Telegram.templates.cycleResult({
                result:   rec.outcome,
                symbol:   rec.symbol,
                mode:     state.account_mode || config.account.mode,
                entry:    rec.entry,
                exit:     rec.exit,
                pnl:      rec.pnl,
                strategy: `aurelia/${rec.path}`,
                duration: Risk.expirySecondsToMinutes(rec.expiry_sec || 900),
                durationUnit: 'm',
                balance:  state.balance,
                currency: state.currency,
                session:  rec.path === 'cycle' ? {
                    wins: state.cycle_session.wins,
                    losses: state.cycle_session.losses,
                    pnl: state.cycle_session.pnl,
                    trades: state.cycle_session.trades,
                } : null,
            }));
        } catch (e) {
            Logger.warn('cycleResult notification failed', { error: e.message });
        }
        // Post-mortem (best-effort) — uses post-entry M5 candles
        try {
            const post = await Deriv.ticksHistory(ws, rec.symbol, 300, 20).catch(() => []);
            const note = await AIClient.askPostMortem({
                trade: rec,
                postEntryCandles: post.map(c => ({ o:c.open, h:c.high, l:c.low, c:c.close })),
                config, state,
            });
            if (note) rec.ai_outcome_note = note;
        } catch (e) {
            Logger.warn('post-mortem failed', { error: e.message });
        }
    }
}

/* ─────────────────────────────────────────────────────────────────
   CYCLE PATH
   ───────────────────────────────────────────────────────────────── */
async function runCycle(ws, config, state, connOpts) {
    // Session gates (REBUILD_PROMPT §2A — code-enforced, AI cannot override)
    if (!config.cycle || !config.cycle.running) {
        Logger.info('Cycle not running (config.cycle.running=false)');
        return;
    }
    const sess = state.cycle_session;
    if (!sess || !sess.active) {
        Logger.info('Cycle session not active');
        return;
    }
    if (sess.halted) {
        Logger.info('Cycle session halted', { reason: sess.halt_reason });
        return;
    }
    if (state.cycle_open_position) {
        Logger.info('Cycle position open — waiting for settlement', state.cycle_open_position);
        return;
    }
    if (Date.now() < (state.next_cycle_eligible_at || 0)) {
        Logger.info('In post-settlement cooldown', {
            ms_remaining: state.next_cycle_eligible_at - Date.now(),
        });
        return;
    }

    // Build payload + ask AI
    let payload;
    try {
        payload = await Payload.buildDecisionPayload(ws, config, state);
    } catch (e) {
        Logger.error('Payload build failed', { error: e.message });
        return;
    }
    let decision, keyUsed;
    try {
        const r = await AIClient.askDecision({ payload, config, state });
        decision = r.decision; keyUsed = r.keyUsed;
    } catch (e) {
        Logger.error('AI decision failed', { error: e.message });
        await Telegram.send(`⚠️ <b>AURELIA</b> — AI decision failed: <code>${String(e.message).slice(0,180)}</code>`);
        return;
    }

    const v = validateDecision(decision, config, state, { cycle: true });
    if (!v.ok) {
        Logger.warn('Invalid AI decision', { errs: v.errs });
        return;
    }
    if (v.skip) {
        Logger.info('AI chose to skip this tick', { reason: v.reason || decision.rationale });
        return;
    }

    // Payout-threshold filter (defensive — applies AFTER AI decision)
    const pay = await checkPayoutThreshold(ws, v.normalised, config);
    if (!pay.ok) {
        const msg = `payout ${(pay.ratio * 100).toFixed(1)}% < threshold ${(pay.threshold * 100).toFixed(0)}%`;
        Logger.info('Cycle trade blocked by payout filter', { symbol: v.normalised.symbol, ratio: pay.ratio, threshold: pay.threshold });
        try {
            await Telegram.send(`🛑 <b>AURELIA</b> — trade skipped (<code>${v.normalised.symbol}</code>): ${msg}`);
        } catch (_) {}
        return;
    }

    // Place and (try to) settle in-cycle
    const { record, ws: freshWs } = await placeAndSettle(
        ws, v.normalised, config, state, { cycle: true, connOpts });
    ws = freshWs || ws;
    state.trade_history_cycle = state.trade_history_cycle || [];
    state.trade_history_cycle.push(record);

    if (record.settled) {
        // In-cycle terminal settlement: book it now and arm cooldown.
        applyCycleSettlement(state, record);
        applyDailyStat(state, record);
        state.next_cycle_eligible_at =
            Date.now() + 1000 * (config.cycle.interval_seconds || 60);
    } else if (record.contract_id) {
        // Non-terminal — push to pending, set the cycle open-position
        // lock so the next tick will not place a second trade until
        // settleAllPending() resolves this one. Result notification
        // fires from settleAllPending on the settling tick.
        state.cycle_open_position = {
            contract_id: record.contract_id,
            symbol:      record.symbol,
            placed_at:   record.ts,
        };
        state.pending_contracts.push({
            contract_id: record.contract_id,
            path:        'cycle',
            symbol:      record.symbol,
            placed_at:   record.ts,
            expiry_sec:  record.expiry_sec,
        });
    }
    return ws;
}

/* =====================================================================
   MULTIPLIER CYCLE PATH — Part 2a (orchestration loop only)
   ─────────────────────────────────────────────────────────────────────
   This is the multipliers-fork replacement for the binary runCycle()
   above. It is structured as a SEPARATE function (rather than a flag
   inside runCycle) because the two flows differ fundamentally:

     • Binary path: at most ONE open contract at a time per cycle,
       cron tick waits for settlement, cooldown gate between trades.
     • Multiplier path: positions stay open across many ticks, each
       tick polls them, asks the AI what to do, and may hold / close /
       open more / revise TP-SL. Session TP/SL is enforced against the
       AGGREGATE of realized + floating P/L across all siblings, not on
       per-trade settlement.

   Routing: main() selects this function instead of runCycle when
   config.cycle.engine === 'multipliers' (default in this fork).

   What this part (2a) does:
     1. Resolve the single active symbol for this tick.
     2. Read open siblings for that symbol from state.
     3. Poll each sibling for fresh live state (P/L, spot, TP/SL, stop_out).
     4. Update persisted floating P/L on each sibling.
     5. Recognise siblings that have already closed server-side
        (stop_out / TP hit / SL hit / manually sold on Deriv) and book
        them: realize their P/L into cycle_session, append to
        trade_history_cycle, remove from open siblings.
     6. Assemble the AI-input payload (clean structure) — Part 2b will
        feed this to the AI. For now we pass it to a STUBBED decision
        function that returns {action: 'hold'}.
     7. Execute whatever decision says: hold / close / open / revise.
        Even though the stub only ever says 'hold' for now, all four
        execution branches are wired so Part 2b just needs to swap the
        stub for the real AI call.
     8. Aggregate risk check: if total session P/L (realized + floating)
        has breached session take_profit / stop_loss / capital, force-
        close every remaining open sibling and halt the session.
     9. Persist updated state via the State helpers (no hand-rolled
        mutation of cycle_open_siblings).
    10. Log a tick summary AND fire a Telegram notification —
        Telegram.templates.multiplierTickSummary({…}) (Part 2c) with
        an attached candlestick chart (Part 3a) showing per-sibling
        TP/SL lines, an entry marker, and auto-scrolling time window.
        Fires on every tick, including holds. Chart-render failure
        gracefully falls back to a plain Telegram.send() so the
        notification still goes out.
   ===================================================================== */

/* ─────────────────────────────────────────────────────────────────
   Resolve the single "active symbol" for this multiplier tick.

   Multi-symbol concurrency is explicitly OUT OF SCOPE for this part
   (per the Part 2a spec). We pick ONE symbol per tick and operate
   only on its siblings.

   Resolution order (first match wins):
     1. config.cycle.active_symbol — explicit override, if set & enabled.
     2. The symbol with the most open siblings (sticky — once a symbol
        has open exposure, stay on it until exposure is closed).
     3. The first enabled symbol in config (synthetics first if
        syn_enabled, otherwise forex).

   Returns the symbol string, or null if nothing usable is enabled.
   ───────────────────────────────────────────────────────────────── */
function resolveActiveSymbol(config, state) {
    // 1) Explicit override
    const override = config && config.cycle && config.cycle.active_symbol;
    if (override && typeof override === 'string' && isSymbolEnabled(override, config)) {
        return override;
    }
    // 2) Sticky: any symbol that already has open siblings wins. If
    //    several do, pick the one with the highest open count. We do
    //    NOT prefilter by isSymbolEnabled here — if a symbol has open
    //    positions, we must still be able to manage them (close/revise)
    //    even if its config flag was flipped off mid-session. Opening
    //    NEW positions on a disabled symbol is still blocked downstream.
    const siblings = (state && state[State.SIBLINGS_KEY]) || {};
    let best = null, bestCount = 0;
    for (const [sym, arr] of Object.entries(siblings)) {
        const n = Array.isArray(arr) ? arr.length : 0;
        if (n > bestCount) { best = sym; bestCount = n; }
    }
    if (best) return best;
    // 3) First enabled symbol in config — synthetics first (matches
    //    the manual-path default of frxEURUSD only when no syn enabled).
    const syms = (config && config.symbols) || {};
    if (config && config.syn_enabled !== false) {
        for (const [sym, on] of Object.entries(syms.synthetics || {})) {
            if (on) return sym;
        }
    }
    if (config && config.frx_enabled !== false) {
        for (const [sym, on] of Object.entries(syms.forex || {})) {
            if (on) return sym;
        }
    }
    // MERGE FIX (Part 3b ↔ Part 2a): add a third sweep for crypto so
    // a session can actually pick `cryBTCUSD`/`cryETHUSD` when only
    // the crypto pool is enabled. Matches the opt-in default Part 3b
    // chose for `cry_enabled` (defaults to false → only included when
    // operator explicitly turns it on, mirroring the synthetics gate).
    if (config && config.cry_enabled === true) {
        for (const [sym, on] of Object.entries(syms.crypto || {})) {
            if (on) return sym;
        }
    }
    return null;
}

/* ─────────────────────────────────────────────────────────────────
   Stub AI decision function (Part 2b will replace this).

   ## INPUT shape (what Part 2b will receive)

   `aiInput` is a plain object — the contract Part 2b must accept. Its
   shape is INTENTIONALLY documented here next to the consumer (this
   function and the execution branches below) so the producer and
   consumer stay in sync.

     {
       cycle_id:        string,          // ISO timestamp of this tick
       symbol:          string,          // the active symbol
       balance:         number,          // account balance, USD
       currency:        string,          // 'USD'
       account_mode:    'demo' | 'real',

       // Snapshot of cycle_session at the start of this tick.
       session: {
         active:            boolean,
         capital_start:     number,
         capital_remaining: number,
         take_profit:       number,      // $ — session-level TP
         stop_loss:         number,      // $ — session-level SL
         pnl:               number,      // realized $ this session
         trades:            number,      // realized close count
         wins:              number,
         losses:            number,
         win_streak:        number,
         loss_streak:       number,
         halted:            boolean,
         halt_reason:       string|null,
       },

       // Aggregate exposure across the active symbol's siblings.
       // (Part 2b may also reach into open_siblings[] for per-sibling
       // decisioning, but the aggregate is what session-level checks
       // use.)
       exposure: {
         symbol:             string,
         count:              number,
         total_stake:        number,
         total_floating_pnl: number | null,   // null if nothing polled
         net_position:       number,
         direction_mix:      { up: number, down: number },
       },

       // Every currently-open sibling for this symbol, freshly polled
       // this tick. Each entry is a merge of the persisted record and
       // the latest getOpenPositionState() snapshot. Closed-server-side
       // siblings are NOT included — they get realised before this
       // payload is built.
       open_siblings: [
         {
           contract_id:        number,
           stake:              number,       // immutable
           multiplier:         number,       // immutable
           direction:          'up'|'down',  // immutable
           entry_spot:         number|null,
           entry_time:         string,       // ISO
           opened_at:          string,       // ISO
           // Refreshed live state from Deriv this tick:
           current_spot:       number|null,
           floating_pnl:       number|null,
           floating_pnl_pct:   number|null,
           bid_price:          number|null,
           buy_price:          number|null,
           is_open:            boolean,
           is_valid_to_sell:   boolean,
           is_valid_to_cancel: boolean,
           take_profit:        { amount: number, value: number } | null,
           stop_loss:          { amount: number, value: number } | null,
           stop_out:           { amount: number, value: number } | null,
           // Distance from current spot to stop-out, expressed as a
           // ratio of (price distance / current spot). null if either
           // current_spot or stop_out.value is unknown. Useful as a
           // "how close to forced liquidation" signal.
           stop_out_distance_pct: number|null,
           // Provenance (carried from the sibling record):
           cycle_id:       string|null,
           decision_id:    string|null,
           sibling_index:  number,
           sibling_count:  number,
           rationale:      string|null,
         },
         ...
       ],

       // Realised closes that happened on Deriv's side this tick (e.g.
       // hit TP, stop-out, SL). Useful context for the AI — "a sibling
       // just hit its stop loss" should affect the next decision.
       just_closed: [
         {
           contract_id: number,
           symbol:      string,
           outcome:     'win'|'loss'|'breakeven',
           pnl:         number,
           reason:      'tp_hit'|'sl_hit'|'stop_out'|'sold_externally'|'unknown',
         },
         ...
       ],

       // The runner already knows it can't open new positions if these
       // are true — we still surface them so the AI can phrase its
       // rationale ("holding because session halted" rather than
       // pretending to choose).
       gates: {
         can_open_new: boolean,
         reason:       string|null,   // why not, if can_open_new=false
       },
     }

   ## OUTPUT shape (what Part 2b must return)

   Either an `action: 'hold' | 'skip'` decision (no side-effects), or
   an `action` with execution parameters. The runner then executes it.
   `decision_id` and `rationale` are PROPAGATED into any sibling records
   the runner creates as a result.

     {
       action:     'hold' | 'skip' | 'close' | 'open' | 'revise',
       decision_id: string,          // opaque id from AI, for audit
       rationale:  string,           // free-text reasoning

       // For action='close':
       close: [
         { contract_id: number, reason?: string },   // 1..N siblings
       ],

       // For action='open':
       open: {
         direction:    'up' | 'down',
         stake:        number,       // USD per sibling (single-sibling shorthand)
         multiplier:   number,       // integer per Deriv contracts_for
         take_profit:  number | null,  // $-amount; null = no TP
         stop_loss:    number | null,  // $-amount; null = no SL
         siblings:     number,         // 1..4 — how many siblings to open
                                       // with this same shape. AI may
                                       // also pass an array; runner
                                       // handles either form. Default 1.
       },

       // For action='revise':
       revise: [
         {
           contract_id: number,
           take_profit: number | null | undefined,   // see deriv.js semantics
           stop_loss:   number | null | undefined,
         },
         ...
       ],
     }

   The stub below just returns `{ action: 'hold' }` so the wiring is
   exercised every tick. Part 2b: REPLACE the body of this function
   with the real AI call (AIClient.askMultiplierDecision or similar)
   and return a decision that conforms to the OUTPUT shape above.
   ───────────────────────────────────────────────────────────────── */
// Part 2b: real AI decision call. Wraps AIClient.askMultiplierDecision
// (which itself runs the validator and falls back to hold on bad output)
// in a single try/catch so any unexpected failure cleanly degrades to a
// well-formed hold decision. The stub function name is preserved (and
// still exported) so any out-of-tree tests pinning to it keep working;
// internally it now delegates to the real path.
async function askMultiplierDecisionStub(aiInput, ctx) {
    const { config, state } = ctx || {};
    if (!config || !state) {
        // Defensive: someone called this without context. Hold safely.
        return {
            action:      'hold',
            decision_id: `no-ctx-${aiInput && aiInput.cycle_id}`,
            rationale:   'askMultiplierDecisionStub called without { config, state }; defaulting to hold.',
        };
    }
    try {
        const { decision } = await AIClient.askMultiplierDecision({ aiInput, config, state });
        return decision;
    } catch (e) {
        // askMultiplierDecision already catches provider failures and
        // returns a hold-shaped decision; only a true bug in the AI
        // client would land here.
        Logger.error('askMultiplierDecision threw unexpectedly — defaulting to hold', { error: e.message });
        return {
            action:      'hold',
            decision_id: `ai-throw-${aiInput && aiInput.cycle_id}`,
            rationale:   `AI client threw: ${String(e.message || '').slice(0, 240)}`,
        };
    }
}

/* ─────────────────────────────────────────────────────────────────
   Internal: poll one sibling against Deriv, return merged record.

   On failure (network blip / contract unknown / etc.) returns the
   persisted record unchanged plus { _poll_error: <message> } so the
   caller can decide whether to keep treating it as open. Conservative
   choice: a single failed poll does NOT remove the sibling — only an
   is_sold/is_expired:true POC reply does.
   ───────────────────────────────────────────────────────────────── */
async function pollSibling(ws, sibling) {
    try {
        const poc = await Deriv.getOpenPositionState(ws, sibling.contract_id);
        // Distance from current spot to stop_out (as fraction of spot).
        let stop_out_distance_pct = null;
        if (poc.current_spot != null && poc.stop_out && poc.stop_out.value != null) {
            const d = poc.current_spot - poc.stop_out.value;
            stop_out_distance_pct = poc.current_spot !== 0
                ? Number((Math.abs(d / poc.current_spot)).toFixed(6))
                : null;
        }
        return {
            sibling,
            poc,
            stop_out_distance_pct,
            error: null,
        };
    } catch (e) {
        Logger.warn(`pollSibling failed contract_id=${sibling.contract_id}`, { error: e.message });
        return { sibling, poc: null, stop_out_distance_pct: null, error: e.message };
    }
}

/* ─────────────────────────────────────────────────────────────────
   Internal: infer why a server-side-closed multiplier closed.
   Heuristic only — Deriv's POC payload doesn't carry an explicit
   "closed_because" field for multipliers, but we can look at:
     • profit relative to take_profit.amount → tp_hit
     • profit relative to stop_loss.amount   → sl_hit
     • profit relative to stop_out.amount    → stop_out
     • otherwise                              → sold_externally / unknown
   ───────────────────────────────────────────────────────────────── */
function inferCloseReason(poc, sibling) {
    if (!poc) return 'unknown';
    const profit = Number(poc.profit);
    if (!Number.isFinite(profit)) return 'unknown';
    // Use the persisted limits as fallback if POC's limit_order is gone
    // post-close (Deriv sometimes blanks them on the sold snapshot).
    const tpAmt = (poc.take_profit && poc.take_profit.amount) || sibling.take_profit;
    const slAmt = (poc.stop_loss && poc.stop_loss.amount)   || sibling.stop_loss;
    const soAmt = poc.stop_out && poc.stop_out.amount;
    const near = (a, b, tol) => (a != null && b != null && Math.abs(a - b) <= tol);
    // 5% tolerance band around each level.
    const tol = Math.max(0.01, Math.abs(profit) * 0.05);
    if (near(profit, tpAmt, tol) && profit > 0) return 'tp_hit';
    if (near(profit, -Math.abs(slAmt), tol) && profit < 0) return 'sl_hit';
    if (near(profit, soAmt, tol) && profit < 0) return 'stop_out';
    return 'sold_externally';
}

/* ─────────────────────────────────────────────────────────────────
   Internal: book a realised (closed-server-side or force-closed)
   sibling into the session counters + trade history + daily stats,
   and remove it from open siblings.

   `pnl` is the realised $-amount (signed). `entry`/`exit` are the
   spot prices for the history record. `closeReason` is one of:
     'tp_hit' | 'sl_hit' | 'stop_out' | 'sold_externally' |
     'force_close_session_tp' | 'force_close_session_sl' |
     'force_close_capital' | 'ai_close' | 'unknown'

   This is the multiplier-equivalent of applyCycleSettlement() in the
   binary path. We deliberately do NOT call applyCycleSettlement here
   because its arithmetic assumes a binary trade where the "stake hold"
   was deducted at placement — multipliers don't deduct provisional
   capital that way (their stake is committed to the open contract and
   simply released back on close, alongside whatever profit/loss).
   ───────────────────────────────────────────────────────────────── */
function realizeClosedSibling(state, config, sibling, symbol, opts) {
    const o = opts || {};
    const pnl = Number(o.pnl || 0);
    const sess = state.cycle_session;
    const outcome = pnl > 0 ? 'win' : pnl < 0 ? 'loss' : 'breakeven';

    // Session counters
    if (sess) {
        sess.trades = (sess.trades || 0) + 1;
        sess.pnl = Number(((sess.pnl || 0) + pnl).toFixed(2));
        // Capital math: a multiplier's stake is at risk on the contract;
        // on close we get back (stake + pnl). So capital_remaining
        // increases by (stake + pnl) here. (Stake was decremented at
        // open time inside openSibling().)
        sess.capital_remaining = Number(
            ((sess.capital_remaining || 0) + Number(sibling.stake || 0) + pnl).toFixed(2)
        );
        if (outcome === 'win') {
            sess.wins = (sess.wins || 0) + 1;
            sess.win_streak = (sess.win_streak || 0) + 1;
            sess.loss_streak = 0;
        } else if (outcome === 'loss') {
            sess.losses = (sess.losses || 0) + 1;
            sess.loss_streak = (sess.loss_streak || 0) + 1;
            sess.win_streak = 0;
        }
        // NOTE: we do NOT enforce session TP/SL halts here — that is
        // done centrally in enforceAggregateRisk() so that the floating
        // P/L of remaining open siblings is also taken into account.
    }

    // Trade history (cycle path)
    state.trade_history_cycle = state.trade_history_cycle || [];
    state.trade_history_cycle.push({
        ts:           new Date().toISOString(),
        path:         'cycle',
        engine:       'multipliers',
        symbol,
        contract_id:  sibling.contract_id,
        direction:    sibling.direction,
        stake:        sibling.stake,
        multiplier:   sibling.multiplier,
        take_profit:  sibling.take_profit,
        stop_loss:    sibling.stop_loss,
        outcome,
        pnl,
        entry:        o.entry != null ? o.entry : sibling.entry_spot,
        exit:         o.exit  != null ? o.exit  : null,
        close_reason: o.closeReason || 'unknown',
        settled:      true,
        // Audit trail: which AI decision originally spawned this sibling.
        cycle_id:     sibling.cycle_id    || null,
        decision_id:  sibling.decision_id || null,
        sibling_index: sibling.sibling_index,
        sibling_count: sibling.sibling_count,
        rationale:    sibling.rationale   || null,
        opened_at:    sibling.opened_at   || null,
        ai_outcome_note: null,
        // Part 3c (additive): tag the realised record with which session
        // it belongs to so the end-of-session summary can scope its
        // selection by session, not by trailing-N. Sourced from
        // cycle_session.started_at (set in worker.startCycleSession).
        // This is read-only data — Part 2c's per-tick reads ignore it.
        session_started_at: (sess && sess.started_at) || null,
    });
    // Daily stats — uses the same shape as the binary path.
    applyDailyStat(state, { outcome, pnl, symbol });

    // Drop from open siblings.
    State.removeSiblingPosition(state, symbol, sibling.contract_id);
}

/* ─────────────────────────────────────────────────────────────────
   Internal: open one or more new sibling positions.

   Used by the AI 'open' execution branch (currently never invoked by
   the stub, but wired and ready for Part 2b). Returns an array of
   { contract_id, error? } per attempted sibling.

   Pre-flight: enforces the per-symbol enabled check, session capital,
   and config.stake bounds. Any single-sibling failure does NOT abort
   the rest — multipliers don't roll back to atomic decisions and
   surfacing partial-success is more honest than pretending the whole
   batch failed.
   ───────────────────────────────────────────────────────────────── */
async function openSibling(ws, config, state, symbol, decision, openSpec, cycleId) {
    const results = [];

    if (!isSymbolEnabled(symbol, config)) {
        Logger.warn('open blocked: symbol disabled in config', { symbol });
        return [{ error: `symbol ${symbol} disabled in config` }];
    }

    const siblingsToOpen = Math.max(1, Math.min(4, Number(openSpec.siblings) || 1));
    const dir = String(openSpec.direction || '').toLowerCase();
    if (dir !== 'up' && dir !== 'down') {
        return [{ error: `invalid direction ${openSpec.direction}` }];
    }
    const mult = Number(openSpec.multiplier);
    if (!Number.isFinite(mult) || mult <= 0 || !Number.isInteger(mult)) {
        return [{ error: `invalid multiplier ${openSpec.multiplier}` }];
    }

    for (let i = 0; i < siblingsToOpen; i++) {
        // Clamp stake against remaining session capital each iteration
        // so we don't oversize on the Nth sibling after the previous ones
        // already drew down capital_remaining.
        const stake = Risk.clampStake(openSpec.stake, config, {
            cycleSessionRemaining: state.cycle_session && state.cycle_session.capital_remaining,
        });
        if (!Number.isFinite(stake) || stake <= 0) {
            results.push({ error: 'stake clamped to zero — capital exhausted' });
            break;
        }

        try {
            const placed = await Deriv.placeMultiplier(ws, {
                symbol,
                direction:  dir,
                stake,
                multiplier: mult,
                takeProfit: openSpec.take_profit != null ? Number(openSpec.take_profit) : undefined,
                stopLoss:   openSpec.stop_loss   != null ? Number(openSpec.stop_loss)   : undefined,
            });
            const contractId = placed.buy && placed.buy.contract_id;
            if (!contractId) {
                results.push({ error: 'placeMultiplier returned no contract_id' });
                continue;
            }

            /* Deriv may have auto-clamped our stake (and proportionally
               our TP/SL) at the proposal/buy stage. `placed.buy._aurelia_stake_clamp`
               is populated by deriv.placeMultiplier when that happened.
               We MUST use the post-clamp values everywhere downstream:
                 • capital_remaining deduction — otherwise we over-deduct
                 • sibling record (stake, TP, SL) — otherwise the position
                   tracker thinks the trade has a TP/SL the broker never
                   accepted, causing settlement/PnL math to drift.
               If no clamp happened the field is null and the original
               values are used verbatim. */
            const clamp = placed.buy._aurelia_stake_clamp || null;
            const effectiveStake = clamp ? clamp.final_stake : stake;
            const effectiveTP    = clamp
                ? clamp.final_take_profit
                : (openSpec.take_profit != null ? Number(openSpec.take_profit) : null);
            const effectiveSL    = clamp
                ? clamp.final_stop_loss
                : (openSpec.stop_loss   != null ? Number(openSpec.stop_loss)   : null);

            // Deduct (effective) stake from capital_remaining as a
            // provisional hold (mirrors the binary placeAndSettle pattern).
            // realizeClosedSibling adds back (stake + pnl) on close.
            if (state.cycle_session) {
                state.cycle_session.capital_remaining = Number(
                    ((state.cycle_session.capital_remaining || 0) - effectiveStake).toFixed(2)
                );
            }
            // Persist sibling via the State helper.
            const rec = State.makeSiblingRecord({
                contract_id:   contractId,
                stake:         effectiveStake,
                multiplier:    mult,
                direction:     dir,
                entry_spot:    placed.proposal && placed.proposal.spot,
                entry_time:    placed.proposal && placed.proposal.date_start
                                  ? new Date(Number(placed.proposal.date_start) * 1000).toISOString()
                                  : undefined,
                take_profit:   effectiveTP,
                stop_loss:     effectiveSL,
                cycle_id:      cycleId,
                decision_id:   decision.decision_id || null,
                sibling_index: i,
                sibling_count: siblingsToOpen,
                rationale:     decision.rationale  || null,
            });
            State.addSiblingPosition(state, symbol, rec);
            const resultEntry = { contract_id: contractId };
            if (clamp) {
                // Surface auto-scale event for the Telegram tick summary.
                // Telegram.multiplierTickSummary inspects `stake_autoscaled`
                // on each result to render a soft-warning subline.
                resultEntry.stake_autoscaled = clamp;
                Logger.warn('open: stake auto-scaled by broker', {
                    symbol, multiplier: mult, ...clamp,
                });
            }
            results.push(resultEntry);
        } catch (e) {
            Logger.error('placeMultiplier failed', { symbol, error: e.message });
            results.push({ error: e.message });
        }
    }
    return results;
}

/* ─────────────────────────────────────────────────────────────────
   Internal: force-close every open sibling for a symbol and book the
   realised P/L. Used by aggregate-risk enforcement when session TP/SL
   is breached.

   `reason` is propagated into the trade_history close_reason. We poll
   each contract once more right before sell to capture the final spot
   and profit number — best-effort; if the poll fails we fall back to
   profit=0 in the trade record.
   ───────────────────────────────────────────────────────────────── */
async function forceCloseAllForSymbol(ws, config, state, symbol, reason) {
    const open = State.getOpenSiblings(state, symbol); // shallow copy
    const closed = [];
    for (const sib of open) {
        let finalProfit = 0;
        let exitSpot   = null;
        try {
            const poc = await Deriv.getOpenPositionState(ws, sib.contract_id).catch(() => null);
            if (poc) {
                finalProfit = Number(poc.profit || 0);
                exitSpot    = poc.current_spot;
            }
        } catch (_) { /* swallow — we still try to sell */ }
        try {
            const sell = await Deriv.closeMultiplier(ws, sib.contract_id);
            // Deriv's sell reply has `sold_for` (the bid we got); profit
            // is sold_for - buy_price. Prefer that over the pre-sell poll
            // since it's the actual realised number.
            if (sell && sell.sold_for != null) {
                const soldFor = Number(sell.sold_for);
                const buyPx   = Number(sib.stake); // multiplier buy price ≈ stake at no-commission limit; for accuracy we'd refetch buy_price, but pnl on Deriv = sold_for - buy_price ≈ sold_for - stake here, since stake basis = stake amount.
                if (Number.isFinite(soldFor) && Number.isFinite(buyPx)) {
                    finalProfit = Number((soldFor - buyPx).toFixed(2));
                }
            }
        } catch (e) {
            Logger.error(`forceCloseAllForSymbol: sell failed contract_id=${sib.contract_id}`, { error: e.message });
            // Do NOT remove the sibling from state — we couldn't confirm
            // the close. The next tick will try again.
            continue;
        }
        realizeClosedSibling(state, config, sib, symbol, {
            pnl:         finalProfit,
            entry:       sib.entry_spot,
            exit:        exitSpot,
            closeReason: reason,
        });
        closed.push({ contract_id: sib.contract_id, pnl: finalProfit, reason });
    }
    return closed;
}

/* ─────────────────────────────────────────────────────────────────
   Part 2b execution helpers — used by runMultiplierCycle's decision
   dispatcher (and re-used by the 'multi' bundled action). Each returns
   an array of detail objects that the caller folds into executed.details.

   The per-branch logic is byte-for-byte equivalent to Part 2a's inline
   if/else-if chain; only the call site moved so the 'multi' branch can
   reuse them without duplication.
   ───────────────────────────────────────────────────────────────── */
async function executeCloseList(ws, config, state, symbol, closeArr) {
    const out = [];
    for (const item of closeArr) {
        const cid = Number(item.contract_id);
        if (!Number.isFinite(cid)) {
            out.push({ error: `invalid contract_id ${item.contract_id}` });
            continue;
        }
        const sib = State.getOpenSiblings(state, symbol).find(s => s.contract_id === cid);
        if (!sib) {
            out.push({ contract_id: cid, skipped: 'no longer open in state' });
            continue;
        }
        try {
            let finalProfit = 0, exitSpot = null;
            try {
                const poc = await Deriv.getOpenPositionState(ws, cid);
                finalProfit = Number(poc.profit || 0);
                exitSpot = poc.current_spot;
            } catch (_) { /* best-effort */ }
            const sell = await Deriv.closeMultiplier(ws, cid);
            if (sell && sell.sold_for != null) {
                finalProfit = Number((Number(sell.sold_for) - Number(sib.stake)).toFixed(2));
            }
            realizeClosedSibling(state, config, sib, symbol, {
                pnl:         finalProfit,
                entry:       sib.entry_spot,
                exit:        exitSpot,
                closeReason: item.reason || 'ai_close',
            });
            out.push({ contract_id: cid, closed: true, pnl: finalProfit });
        } catch (e) {
            Logger.error('AI close failed', { contract_id: cid, error: e.message });
            out.push({ contract_id: cid, error: e.message });
        }
    }
    return out;
}

async function executeOpenSpec(ws, config, state, symbol, decision, openSpec, cycleId, aiInput, canOpenNew) {
    if (!canOpenNew) {
        Logger.warn('AI requested open but gate is closed', { reason: aiInput.gates.reason });
        return [{ error: `open blocked: ${aiInput.gates.reason}` }];
    }
    return openSibling(ws, config, state, symbol, decision, openSpec, cycleId);
}

async function executeReviseList(ws, state, symbol, reviseArr) {
    const out = [];
    for (const r of reviseArr) {
        const cid = Number(r.contract_id);
        if (!Number.isFinite(cid)) {
            out.push({ error: `invalid contract_id ${r.contract_id}` });
            continue;
        }
        // Build changes obj respecting deriv.js's three-state semantic
        // (undefined = omit / unchanged, null = clear, number = set).
        const changes = {};
        if (Object.prototype.hasOwnProperty.call(r, 'take_profit')) changes.takeProfit = r.take_profit;
        if (Object.prototype.hasOwnProperty.call(r, 'stop_loss'))   changes.stopLoss   = r.stop_loss;
        if (changes.takeProfit === undefined && changes.stopLoss === undefined) {
            out.push({ contract_id: cid, skipped: 'no-op revise' });
            continue;
        }
        try {
            const cu = await Deriv.reviseMultiplierLimits(ws, cid, changes);
            const patch = {};
            if (Object.prototype.hasOwnProperty.call(changes, 'takeProfit')) {
                patch.take_profit = changes.takeProfit === null
                    ? null
                    : (cu.take_profit ? Number(cu.take_profit.order_amount) : Number(changes.takeProfit));
            }
            if (Object.prototype.hasOwnProperty.call(changes, 'stopLoss')) {
                patch.stop_loss = changes.stopLoss === null
                    ? null
                    : (cu.stop_loss ? Math.abs(Number(cu.stop_loss.order_amount)) : Number(changes.stopLoss));
            }
            State.updateSiblingPosition(state, symbol, cid, patch);
            out.push({ contract_id: cid, revised: patch });
        } catch (e) {
            Logger.error('AI revise failed', { contract_id: cid, error: e.message });
            out.push({ contract_id: cid, error: e.message });
        }
    }
    return out;
}

/* ─────────────────────────────────────────────────────────────────
   Internal: enforce aggregate session TP/SL/capital across realised +
   floating P/L. Mirrors the spirit of applyCycleSettlement() from the
   binary path, but operates on the AGGREGATE rather than a single
   just-settled trade.

   Triggers a force-close-all and a session halt if any of:
     • realized pnl + floating pnl >= take_profit  → halt 'take_profit'
     • realized pnl + floating pnl <= -stop_loss   → halt 'stop_loss'
     • capital_remaining <= 0                       → halt 'capital'

   Returns { breached: bool, halt_reason: string|null, closed: [...] }.
   ───────────────────────────────────────────────────────────────── */
async function enforceAggregateRisk(ws, config, state, symbol) {
    const sess = state.cycle_session;
    if (!sess || sess.halted) {
        return { breached: false, halt_reason: null, closed: [] };
    }
    const agg = State.aggregateAllExposure(state);
    const realised = Number(sess.pnl || 0);
    const floating = Number(agg.total_floating_pnl || 0);
    const combined = Number((realised + floating).toFixed(2));

    let halt = null;
    if (sess.take_profit > 0 && combined >= sess.take_profit) {
        halt = { reason: 'take_profit', message: `aggregate P/L +${combined} >= take_profit ${sess.take_profit}` };
    } else if (sess.stop_loss > 0 && combined <= -sess.stop_loss) {
        halt = { reason: 'stop_loss', message: `aggregate P/L ${combined} <= -stop_loss ${sess.stop_loss}` };
    } else if (sess.capital_remaining <= 0 && agg.positions === 0) {
        // Only flag capital exhaustion if we have no open exposure left
        // to potentially recover it. (With open siblings still running,
        // capital_remaining can transiently be < 0 by stake-hold math.)
        halt = { reason: 'capital', message: 'capital exhausted' };
    }
    if (!halt) return { breached: false, halt_reason: null, closed: [] };

    Logger.warn('Aggregate risk breached — force-closing all open siblings', {
        symbol,
        realised,
        floating,
        combined,
        reason: halt.message,
    });
    const closed = await forceCloseAllForSymbol(
        ws, config, state, symbol,
        halt.reason === 'take_profit' ? 'force_close_session_tp'
      : halt.reason === 'stop_loss'   ? 'force_close_session_sl'
      :                                 'force_close_capital'
    );
    sess.active = false;
    sess.halted = true;
    sess.halt_reason = halt.message;
    return { breached: true, halt_reason: halt.reason, closed };
}

/* ─────────────────────────────────────────────────────────────────
   Part 3c — end-of-session summary (MT5-style)
   ─────────────────────────────────────────────────────────────────
   Detects the session→stopped transition and sends ONE consolidated
   Telegram message listing every position opened during this session
   (from state.trade_history_cycle, filtered by session_started_at),
   plus a total. Latched on state._notified_session_summary so it
   never re-fires while the session remains stopped. The latch is
   cleared by worker/index.js#startCycleSession on the next /startcycle.

   Triggers (any of):
     1. Aggregate-risk force-close (TP / SL / capital exhaustion) — the
        session.active flag flips false this tick. This is the primary
        hook because it is the only path that truly force-closes
        everything within runner.js. Detected by snapshotting active
        on tick entry and comparing post-risk.
     2. Operator pause via /pausecycle (config.cycle.running flips to
        false) WITH no open siblings remaining. Mid-paused-with-positions
        is intentionally NOT a session-end trigger because /startcycle
        can resume and the summary would lie about the session being
        "over". We fire only when the paused session has wound down.
   ───────────────────────────────────────────────────────────────── */
async function maybeSendSessionSummary(state, config, entrySnap, ctx) {
    const sess = state.cycle_session || {};
    const startedAt = sess.started_at || entrySnap.started_at || null;

    // Already notified for this exact session start? bail.
    // The latch stores the started_at so a /startcycle that hits the
    // same wall-clock minute as a previous one still re-arms cleanly
    // (started_at is ISO ms-precision — collisions are not practical).
    if (state._notified_session_summary && state._notified_session_summary === startedAt) {
        return;
    }

    const openCount = State.countOpenSiblings(state);
    const cycleRunning = !!(config.cycle && config.cycle.running);

    // Detect a session-end transition this tick.
    //   (a) Force-close path — risk just halted the session.
    //   (b) Pause path     — entry was running, now paused, AND we
    //                        have no open siblings left to wind down.
    //   (c) Halted-and-drained — entry was already halted but open
    //                        siblings may have been polled+closed this
    //                        tick (e.g. recovery after a crash). Fire
    //                        once everything is settled.
    const justHalted = !entrySnap.halted && !!sess.halted;
    const justPausedAndDrained =
        entrySnap.cycleRunning && !cycleRunning && openCount === 0
        && !!entrySnap.active;
    const haltedAndDrained =
        !!sess.halted && openCount === 0
        && !state._notified_session_summary;

    if (!(ctx && ctx.riskBreached) && !justHalted && !justPausedAndDrained && !haltedAndDrained) {
        return;
    }

    // Collect every trade-history record belonging to this session.
    // We prefer matching by session_started_at (added in Part 3c) and
    // fall back to "all records since started_at" for any pre-3c
    // records that don't carry the tag yet (graceful migration).
    const hist = Array.isArray(state.trade_history_cycle) ? state.trade_history_cycle : [];
    const startedMs = startedAt ? Date.parse(startedAt) : NaN;
    const positions = hist.filter(r => {
        if (!r || r.path !== 'cycle' || r.engine !== 'multipliers') return false;
        if (r.session_started_at && startedAt) return r.session_started_at === startedAt;
        if (Number.isFinite(startedMs)) {
            const t = r.ts ? Date.parse(r.ts) : NaN;
            return Number.isFinite(t) && t >= startedMs;
        }
        return false;
    });

    if (positions.length === 0) {
        // Nothing to summarise (e.g. session ended without ever opening
        // a position). Latch anyway so we don't keep re-checking.
        state._notified_session_summary = startedAt || 'unknown';
        return;
    }

    // Classify the reason. Priority: explicit risk breach > halt_reason
    // text > operator pause > generic.
    let endedReason;
    if (ctx && ctx.riskBreached) {
        endedReason = ctx.riskReason || 'risk_breach';
    } else if (sess.halted) {
        const r = String(sess.halt_reason || '');
        if (/take_profit/i.test(r))      endedReason = 'take_profit';
        else if (/stop_loss/i.test(r))   endedReason = 'stop_loss';
        else if (/capital/i.test(r))     endedReason = 'capital';
        else                              endedReason = 'halted';
    } else if (!cycleRunning) {
        endedReason = 'paused';
    } else {
        endedReason = 'ended';
    }

    try {
        const msg = Telegram.templates.sessionSummary({
            startedAt,
            endedAt:   new Date().toISOString(),
            endedReason,
            haltReason: sess.halt_reason || null,
            mode:      state.account_mode || (config.account && config.account.mode),
            session:   {
                capital_start:     Number(sess.capital_start     || 0),
                capital_remaining: Number(sess.capital_remaining || 0),
                take_profit:       Number(sess.take_profit       || 0),
                stop_loss:         Number(sess.stop_loss         || 0),
                trades:            Number(sess.trades            || 0),
                wins:              Number(sess.wins              || 0),
                losses:            Number(sess.losses            || 0),
                pnl:               Number(sess.pnl               || 0),
            },
            balance:   state.balance,
            currency:  state.currency,
            positions, // trade-history records belonging to this session
        });
        await Telegram.send(msg);
        state._notified_session_summary = startedAt || 'unknown';
        Logger.info('session summary sent', {
            started_at: startedAt,
            ended_reason: endedReason,
            positions: positions.length,
            session_pnl: sess.pnl,
        });
    } catch (e) {
        // Don't latch on failure — next tick can retry.
        Logger.warn('sessionSummary template send failed', { error: e.message });
    }
}

/* ─────────────────────────────────────────────────────────────────
   Main multiplier cycle tick.
   ───────────────────────────────────────────────────────────────── */
async function runMultiplierCycle(ws, config, state, connOpts) {
    const cycleId = new Date().toISOString();
    const sess = state.cycle_session || {};

    // --- Pre-flight gates ----------------------------------------------
    // We DO run the tick even if the session is halted, but only to
    // settle / book any siblings that closed server-side since last
    // tick. We do NOT open new positions while halted.
    const cycleRunning = !!(config.cycle && config.cycle.running);
    const sessionActive = sess.active && !sess.halted;
    if (!cycleRunning) {
        Logger.info('Multiplier cycle paused (config.cycle.running=false)');
        // If there are open siblings we still want to poll + book them
        // (defensive — paused config shouldn't strand open contracts).
        // Falls through to the normal flow below.
    }

    // Part 3c — snapshot session state at tick entry. The end-of-session
    // summary fires once (latched) when the session transitions from
    // "running" to "stopped" within this tick, where "stopped" means
    // EITHER halted by aggregate risk OR paused by the operator with no
    // open siblings left. See onSessionEnded() below for the gate logic.
    const sessionEntrySnapshot = {
        started_at: sess.started_at || null,
        active:     !!sess.active,
        halted:     !!sess.halted,
        cycleRunning,
    };

    // --- Resolve the single active symbol for this tick ----------------
    const symbol = resolveActiveSymbol(config, state);
    if (!symbol) {
        Logger.info('Multiplier cycle: no enabled symbol available');
        return ws;
    }
    Logger.info('Multiplier cycle tick', { cycle_id: cycleId, symbol });

    // --- 1. Read open siblings for this symbol -------------------------
    const persisted = State.getOpenSiblings(state, symbol);

    // --- 2 & 3. Poll each sibling and refresh persisted P/L ------------
    const polled = [];
    const justClosed = [];
    for (const sib of persisted) {
        const r = await pollSibling(ws, sib);
        if (r.error) {
            // Keep the sibling but DON'T refresh its floating P/L on a
            // failed poll — better to operate on stale data than to
            // overwrite a known value with null.
            polled.push({ sibling: sib, poc: null, stop_out_distance_pct: null, error: r.error });
            continue;
        }
        const poc = r.poc;
        if (poc && (poc.is_sold || poc.is_expired)) {
            // Server-side close — realise it.
            const profit = Number(poc.profit || 0);
            const reason = inferCloseReason(poc, sib);
            realizeClosedSibling(state, config, sib, symbol, {
                pnl:         profit,
                entry:       poc.entry_spot != null ? poc.entry_spot : sib.entry_spot,
                exit:        poc.current_spot,
                closeReason: reason,
            });
            justClosed.push({
                contract_id: sib.contract_id,
                symbol,
                outcome:     profit > 0 ? 'win' : profit < 0 ? 'loss' : 'breakeven',
                pnl:         profit,
                reason,
            });
            continue;
        }
        // Still open — refresh persisted floating fields via State helper
        // (do not hand-roll the merge).
        if (poc) {
            State.updateSiblingPosition(state, symbol, sib.contract_id, {
                floating_pnl:     poc.profit,
                floating_pnl_pct: poc.profit_percentage,
                current_spot:     poc.current_spot,
                last_polled_at:   new Date().toISOString(),
                // Mirror live TP/SL back into the persisted record so
                // they don't drift if the user revised them externally.
                take_profit:      poc.take_profit ? poc.take_profit.amount : sib.take_profit,
                stop_loss:        poc.stop_loss   ? poc.stop_loss.amount   : sib.stop_loss,
            });
            polled.push({
                sibling: Object.assign({}, sib, {
                    floating_pnl:     poc.profit,
                    floating_pnl_pct: poc.profit_percentage,
                    current_spot:     poc.current_spot,
                }),
                poc,
                stop_out_distance_pct: r.stop_out_distance_pct,
                error: null,
            });
        }
    }

    // --- 3b. Idle short-circuit ----------------------------------------
    // If the cycle is paused or the session is halted (canOpenNew would
    // be false no matter what the AI says) AND polling found zero open
    // siblings AND nothing closed this tick, there is genuinely nothing
    // for the AI to decide — every action branch is gated off. Calling
    // the (billed) AI provider and firing a Telegram tick message would
    // both be pure noise every 5 minutes for as long as the bot sits
    // paused-and-empty. Skip them.
    //
    // We still must give Part 3c's session-summary logic a chance to
    // fire here, because the tick on which the session *first* drains
    // to zero open siblings while paused/halted is exactly the
    // transition that maybeSendSessionSummary() latches onto. Calling
    // it before the early-return is safe: it is internally latched on
    // state._notified_session_summary, so subsequent idle ticks are a
    // no-op.
    //
    // Polling/settlement above this point is untouched and runs every
    // tick regardless of pause state — that's the actual safety
    // behavior the existing tick-while-paused design was built around.
    const openSiblingCount = State.getOpenSiblings(state, symbol).length;
    const idleAndPaused =
        (!cycleRunning || sess.halted || !sessionActive)
        && openSiblingCount === 0
        && justClosed.length === 0;
    if (idleAndPaused) {
        Logger.info('Multiplier cycle: paused/halted with no open siblings — skipping AI call', {
            cycle_id:      cycleId,
            symbol,
            cycle_running: cycleRunning,
            halted:        !!sess.halted,
            session_active: !!sess.active,
        });
        // Keep the exposure summary fresh so any UI/state consumers
        // see consistent values (no-op in practice — nothing mutated).
        state[State.SUMMARY_KEY] = State.aggregateAllExposure(state);
        // Give Part 3c a chance to fire on the genuine transition tick
        // (e.g. session just paused-and-drained or halted-and-drained).
        // With zero open siblings, enforceAggregateRisk cannot breach,
        // so riskBreached is always false on this path.
        try {
            await maybeSendSessionSummary(state, config, sessionEntrySnapshot, {
                symbol, riskBreached: false, riskReason: null,
            });
        } catch (e) {
            Logger.warn('session summary send failed', { error: e.message });
        }
        return ws;
    }

    // --- 4. Assemble AI input payload ----------------------------------
    // (Shape documented above next to askMultiplierDecisionStub.)
    const exposure = State.aggregateSiblingExposure(state, symbol);
    const canOpenNew = cycleRunning && sessionActive;

    // --- 4a. Market data slice (FIX: was missing — caused the AI to
    // report "No market data ... is available in the TICK INPUT" on every
    // tick because aiInput previously contained only contract / exposure
    // metadata, no candles or indicators. We reuse the existing
    // Payload.buildSymbolSlice() helper that the binary-cycle path already
    // uses; it returns {symbol, timeframes:{M5,M10,M15}, volatility_proxy_atr14_m5}
    // with full OHLC + RSI/EMA/MACD/BB/ATR/ADX/Stoch/Keltner/Donchian/Ichimoku
    // + support_resistance + candle_patterns — exactly what the multiplier
    // prompt's RATIONALE QUALITY section demands the AI cite by name. A
    // failure here must NOT block the tick (P/L polling, settlement, and
    // risk enforcement above already ran); we degrade to a clearly-marked
    // error block so the AI can hold safely.)
    let marketSlice = null;
    let marketError = null;
    try {
        marketSlice = await Payload.buildSymbolSlice(ws, symbol);
    } catch (e) {
        marketError = e && e.message ? e.message : String(e);
        Logger.warn('Multiplier cycle: failed to build market slice — AI will see error block', {
            symbol, error: marketError,
        });
    }

    const aiInput = {
        cycle_id:     cycleId,
        symbol,
        balance:      state.balance,
        currency:     state.currency,
        account_mode: state.account_mode,
        session: {
            active:            !!sess.active,
            capital_start:     Number(sess.capital_start || 0),
            capital_remaining: Number(sess.capital_remaining || 0),
            take_profit:       Number(sess.take_profit || 0),
            stop_loss:         Number(sess.stop_loss || 0),
            pnl:               Number(sess.pnl || 0),
            trades:            Number(sess.trades || 0),
            wins:              Number(sess.wins || 0),
            losses:            Number(sess.losses || 0),
            win_streak:        Number(sess.win_streak || 0),
            loss_streak:       Number(sess.loss_streak || 0),
            halted:            !!sess.halted,
            halt_reason:       sess.halt_reason || null,
        },
        exposure,
        open_siblings: polled.filter(p => p.poc != null || !p.error).map(p => ({
            contract_id:        p.sibling.contract_id,
            stake:              p.sibling.stake,
            multiplier:         p.sibling.multiplier,
            direction:          p.sibling.direction,
            entry_spot:         p.sibling.entry_spot,
            entry_time:         p.sibling.entry_time,
            opened_at:          p.sibling.opened_at,
            current_spot:       p.poc ? p.poc.current_spot      : p.sibling.current_spot,
            floating_pnl:       p.poc ? p.poc.profit             : p.sibling.floating_pnl,
            floating_pnl_pct:   p.poc ? p.poc.profit_percentage  : p.sibling.floating_pnl_pct,
            bid_price:          p.poc ? p.poc.bid_price          : null,
            buy_price:          p.poc ? p.poc.buy_price          : null,
            is_open:            p.poc ? p.poc.is_open            : true,
            is_valid_to_sell:   p.poc ? p.poc.is_valid_to_sell   : false,
            is_valid_to_cancel: p.poc ? p.poc.is_valid_to_cancel : false,
            take_profit:        p.poc && p.poc.take_profit ? { amount: p.poc.take_profit.amount, value: p.poc.take_profit.value } : null,
            stop_loss:          p.poc && p.poc.stop_loss   ? { amount: p.poc.stop_loss.amount,   value: p.poc.stop_loss.value   } : null,
            stop_out:           p.poc && p.poc.stop_out    ? { amount: p.poc.stop_out.amount,    value: p.poc.stop_out.value    } : null,
            stop_out_distance_pct: p.stop_out_distance_pct,
            cycle_id:       p.sibling.cycle_id      || null,
            decision_id:    p.sibling.decision_id   || null,
            sibling_index:  p.sibling.sibling_index,
            sibling_count:  p.sibling.sibling_count,
            rationale:      p.sibling.rationale     || null,
        })),
        just_closed: justClosed,
        gates: {
            can_open_new: canOpenNew,
            reason: !cycleRunning      ? 'config.cycle.running=false'
                  : sess.halted        ? `session halted: ${sess.halt_reason || 'unknown'}`
                  : !sess.active       ? 'session not active'
                  : null,
        },
        // FIX: market data block — the AI prompt requires the rationale to
        // cite specific indicator readings (RSI, MACD, Bollinger Bands,
        // EMA, candle patterns, S/R levels) by NAME with actual NUMBERS
        // from this payload. Without it the AI (correctly) responds with
        // "no market data available in TICK INPUT" on every tick. The
        // slice mirrors the per-symbol shape used by the binary path.
        market: marketSlice
            ? {
                symbol:                     marketSlice.symbol,
                timeframes:                 marketSlice.timeframes,
                volatility_proxy_atr14_m5:  marketSlice.volatility_proxy_atr14_m5,
            }
            : { error: marketError || 'market_slice_unavailable' },
    };

    // --- 5. Call the AI decision function (Part 2b: real call) ---------
    let decision;
    try {
        decision = await askMultiplierDecisionStub(aiInput, { config, state });
    } catch (e) {
        Logger.error('askMultiplierDecisionStub failed', { error: e.message });
        decision = { action: 'hold', decision_id: 'ai-error', rationale: e.message };
    }

    // Part 2c: snapshot the pre-action open siblings so the Telegram
    // template can render TP/SL old→new transitions for the 'revise'
    // branch. We deep-clone the records that aiInput already extracted
    // so subsequent State mutations don't bleed back into the snapshot.
    const preActionSiblings = aiInput.open_siblings.map(s => ({
        contract_id: s.contract_id,
        stake:       s.stake,
        multiplier:  s.multiplier,
        direction:   s.direction,
        // aiInput stores the live TP/SL as { amount, value } objects (or null);
        // flatten to a raw amount so the template treats them uniformly
        // with the persisted record shape.
        take_profit: s.take_profit ? Number(s.take_profit.amount) : null,
        stop_loss:   s.stop_loss   ? Number(s.stop_loss.amount)   : null,
        floating_pnl:     s.floating_pnl,
        floating_pnl_pct: s.floating_pnl_pct,
        current_spot:     s.current_spot,
        entry_spot:       s.entry_spot,
        sibling_index:    s.sibling_index,
        sibling_count:    s.sibling_count,
    }));

    // --- 6. Execute the decision ---------------------------------------
    // All execution branches (close / open / revise / multi / hold) are
    // wired via the helpers below. The 'multi' branch dispatches close
    // → revise → open in that order so any new 'open' does not interact
    // with siblings that are about to be closed or revised.
    const executed = { action: decision.action, details: [] };

    if (decision.action === 'close' && Array.isArray(decision.close)) {
        executed.details = executed.details.concat(
            await executeCloseList(ws, config, state, symbol, decision.close)
        );
    } else if (decision.action === 'open' && decision.open) {
        executed.details = executed.details.concat(
            await executeOpenSpec(ws, config, state, symbol, decision, decision.open, cycleId, aiInput, canOpenNew)
        );
    } else if (decision.action === 'revise' && Array.isArray(decision.revise)) {
        executed.details = executed.details.concat(
            await executeReviseList(ws, state, symbol, decision.revise)
        );
    } else if (decision.action === 'multi' && decision.multi) {
        // close -> revise -> open. Empty sub-actions are silently skipped.
        if (Array.isArray(decision.multi.close) && decision.multi.close.length) {
            const out = await executeCloseList(ws, config, state, symbol, decision.multi.close);
            executed.details = executed.details.concat(out.map(d => Object.assign({ phase: 'close' }, d)));
        }
        if (Array.isArray(decision.multi.revise) && decision.multi.revise.length) {
            const out = await executeReviseList(ws, state, symbol, decision.multi.revise);
            executed.details = executed.details.concat(out.map(d => Object.assign({ phase: 'revise' }, d)));
        }
        if (decision.multi.open) {
            const out = await executeOpenSpec(ws, config, state, symbol, decision, decision.multi.open, cycleId, aiInput, canOpenNew);
            executed.details = executed.details.concat(out.map(d => Object.assign({ phase: 'open' }, d)));
        }
    } else {
        // 'hold' or 'skip' or unrecognised — no side-effects.
        executed.details.push({ note: decision.action === 'hold' || decision.action === 'skip'
            ? decision.action
            : `unrecognised action '${decision.action}', treating as hold` });
    }

    // --- 7. Persist (the helpers already mutated `state` in place) ----
    // Refresh the optional summary cache so Part 2c / UI can render
    // without re-aggregating.
    state[State.SUMMARY_KEY] = State.aggregateAllExposure(state);

    // --- 8. Aggregate risk check + force-close on breach --------------
    const risk = await enforceAggregateRisk(ws, config, state, symbol);
    if (risk.breached) {
        // Recompute summary after force-closes mutated siblings.
        state[State.SUMMARY_KEY] = State.aggregateAllExposure(state);
    }

    // --- 8b. Part 3c — end-of-session summary (MT5-style) ------------
    // Fires once per session, when the session transitions from
    // running→stopped this tick. "Stopped" covers:
    //   (a) aggregate-risk force-close (TP / SL / capital), and
    //   (b) operator pause via /pausecycle while no siblings remain open
    //       (paused with open siblings is NOT treated as session-end —
    //       the user can /startcycle to resume; the summary would be
    //       premature).
    // The fire is latched on state._notified_session_summary so it
    // cannot re-fire on subsequent ticks while the session stays
    // stopped. startCycleSession() in worker/index.js clears the latch.
    try {
        await maybeSendSessionSummary(state, config, sessionEntrySnapshot, {
            symbol, riskBreached: !!(risk && risk.breached),
            riskReason: risk && risk.halt_reason ? risk.halt_reason : null,
        });
    } catch (e) {
        Logger.warn('session summary send failed', { error: e.message });
    }

    // --- 9. Tick summary log + Telegram notification --------------------
    // We keep the structured Logger.info line (useful for cron logs and
    // any downstream metric scrape) AND fire one Telegram message per
    // tick, including ticks where the AI held with no side-effects —
    // that visibility is intentional, not a bug.
    Logger.info('multiplier tick summary', {
        cycle_id:        cycleId,
        symbol,
        decision_action: decision.action,
        decision_id:     decision.decision_id,
        rationale:       (decision.rationale || '').slice(0, 200),
        executed_count:  executed.details.length,
        just_closed:     justClosed.length,
        open_now:        State.countOpenSiblings(state),
        session_pnl:     sess.pnl,
        floating_pnl:    (state[State.SUMMARY_KEY] || {}).total_floating_pnl,
        halted:          !!sess.halted,
        halt_reason:     sess.halt_reason || null,
        risk_breach:     risk.breached ? risk.halt_reason : null,
    });

    // Telegram tick summary (Part 2c).
    // Rebuild the open-sibling list AFTER all executor branches + the
    // aggregate-risk force-close pass, so the message reflects what the
    // user actually has open right now — not the pre-action snapshot.
    try {
        const postActionSiblings = State.getOpenSiblings(state, symbol);
        // Re-aggregate exposure post-action for the same reason.
        const postExposure = State.aggregateSiblingExposure(state, symbol);

        const msg = Telegram.templates.multiplierTickSummary({
            symbol,
            mode:        state.account_mode,
            cycleId,
            decision,
            executed,
            justClosed,
            openSiblings:      postActionSiblings,
            preActionSiblings,
            exposure:          postExposure,
            session:           state.cycle_session || {},
            riskBreach:        risk.breached ? risk.halt_reason : null,
            balance:           state.balance,
            currency:          state.currency,
        });

        // Part 3a: render the per-tick multiplier chart and attach it
        // to the Telegram notification via sendPhoto. The chart pulls
        // its window-position bookkeeping (min/max in ms) from the
        // persisted state so it survives stateless cron invocations:
        //   - first tick of a position  → reserve empty space ahead
        //   - subsequent ticks          → keep window, auto-scroll
        //                                  forward as candles fill in
        //   - no open siblings          → pure historical view, no
        //                                  reserve; window is cleared so
        //                                  next 'open' starts fresh.
        //
        // Telegram caption cap is 1024 chars (vs. 4096 for plain
        // messages). Part 2c's template can produce ~800–1000 char
        // messages at the busy end (4 siblings + multi). We use
        // sendPhoto with a *truncated* caption when the chart is
        // available, and fall back to plain send() (which keeps the
        // full body) when the chart render fails for any reason — so
        // the user is never silently shorted on text content.
        state.chart_windows = state.chart_windows || {};
        let chartBuf = null;
        let nextWindow = null;
        try {
            const out = await Chart.renderMultiplierSnapshot({
                ws,
                symbol,
                tf:           '5m',
                openSiblings: postActionSiblings,
                chartWindow:  state.chart_windows[symbol] || null,
            });
            if (out && out.buffer && out.buffer.length > 1024) {
                chartBuf   = out.buffer;
                nextWindow = out.nextWindow;
            } else {
                Logger.warn('renderMultiplierSnapshot returned no usable buffer', {
                    symbol,
                    bytes: out && out.buffer ? out.buffer.length : 0,
                });
            }
        } catch (e) {
            Logger.warn('renderMultiplierSnapshot failed', { symbol, error: e.message });
        }

        // Persist (or clear) the auto-scroll window. When the symbol
        // currently has no open siblings we explicitly drop the prior
        // window so the next position-open re-reserves empty space
        // cleanly rather than inheriting a stale offset.
        if (postActionSiblings.length === 0) {
            delete state.chart_windows[symbol];
        } else if (nextWindow && Number.isFinite(nextWindow.min) && Number.isFinite(nextWindow.max)) {
            state.chart_windows[symbol] = { min: nextWindow.min, max: nextWindow.max };
        }

        if (chartBuf) {
            // Telegram sendPhoto caption cap = 1024 chars. The HTML in
            // `msg` is almost always shorter than that for typical
            // ticks; truncate only as a defensive fallback. We trim
            // back to a safe budget and append an ellipsis so the
            // recipient knows there was more.
            const CAPTION_CAP = 1024;
            const caption = msg.length <= CAPTION_CAP
                ? msg
                : (msg.slice(0, CAPTION_CAP - 12) + '\n<i>…trimmed</i>');
            await Telegram.sendPhoto(chartBuf, caption);
        } else {
            // Chart unavailable — fall back to text-only so the
            // notification still goes out.
            await Telegram.send(msg);
        }
    } catch (e) {
        // Never let a notification failure poison the cycle — the
        // executor branches have already mutated state and we want to
        // return cleanly so cron picks up the next tick.
        Logger.warn('multiplierTickSummary Telegram send failed', { error: e.message });
    }

    return ws;
}

/* ─────────────────────────────────────────────────────────────────
   MANUAL PATH (stateless w.r.t. cycle session)
   ───────────────────────────────────────────────────────────────── */
async function runManual(ws, config, state, connOpts) {
    let inputPayload = {};
    try { inputPayload = JSON.parse(process.env.INPUT_PAYLOAD || '{}'); }
    catch (e) { /* ignore */ }

    const action = inputPayload.action || 'scan';

    if (action === 'chart') {
        const symbol = inputPayload.symbol || 'frxEURUSD';
        const tf     = inputPayload.tf     || '5m';
        try {
            const buf = await Chart.generateChart(ws, symbol, tf);
            if (buf) await Telegram.sendPhoto(buf, `${symbol} — ${tf}`);
        } catch (e) {
            await Telegram.send(`Chart failed: <code>${e.message}</code>`);
        }
        return ws;
    }

    /* Default manual action ("scan" / "trade_now"): run a multiplier-
       aware scan, post the AI's rationale (highlighted via blockquote
       in the tick-summary template) WITH a fresh chart, and — if the AI
       returns an actionable open — place the multiplier through the
       same executor path the cycle uses.

       Previously this path went through AIClient.askDecision (the
       binary CALL/PUT prompt) which always returns action:"trade" or
       action:"skip". The validator then declined virtually every
       multiplier-shaped decision because the binary prompt is much
       more conservative AND the action shapes don't match (the
       multiplier AI uses open/close/revise/hold/multi, not
       trade/skip). End result: "AI declined" on essentially every
       manual scan, and never a chart attached. */

    // --- 1. Resolve symbol (operator override > sticky > config) ------
    const symbol =
        (inputPayload.symbol && typeof inputPayload.symbol === 'string')
            ? inputPayload.symbol
            : resolveActiveSymbol(config, state);
    if (!symbol) {
        await Telegram.send('⚠️ Manual scan: no enabled symbol available.');
        return ws;
    }
    Logger.info('Manual scan tick', { symbol });

    // --- 2. Snapshot the live state of any open siblings ON THIS symbol
    // so the AI sees what's already in play. Manual trades happen
    // *outside* the cycle session but they share the symbol's sibling
    // book, so showing them is the right thing.
    const persisted = State.getOpenSiblings(state, symbol);
    const polled = [];
    for (const sib of persisted) {
        try {
            const r = await pollSibling(ws, sib);
            polled.push(r);
        } catch (e) {
            Logger.warn('Manual scan: pollSibling failed', { contract_id: sib.contract_id, error: e.message });
            polled.push({ sibling: sib, error: e.message });
        }
    }

    // --- 3. Market data slice (same helper the cycle uses) -----------
    let marketSlice = null;
    let marketError = null;
    try {
        marketSlice = await Payload.buildSymbolSlice(ws, symbol);
    } catch (e) {
        marketError = e && e.message ? e.message : String(e);
        Logger.warn('Manual scan: failed to build market slice', { symbol, error: marketError });
    }

    // --- 4. Assemble aiInput in the SAME shape as the cycle ----------
    const exposure = State.aggregateSiblingExposure(state, symbol);
    const sess     = state.cycle_session || {};
    // Manual trades are explicit user requests: open-gate ON regardless
    // of cycle pause/halt. openSibling still enforces per-symbol enable
    // + stake floor downstream.
    const cycleId = `manual-${new Date().toISOString()}`;
    const aiInput = {
        cycle_id:     cycleId,
        symbol,
        balance:      state.balance,
        currency:     state.currency,
        account_mode: state.account_mode,
        manual:       true,
        session: {
            active:            !!sess.active,
            capital_start:     Number(sess.capital_start || 0),
            capital_remaining: Number(sess.capital_remaining || (state.balance || 0)),
            take_profit:       Number(sess.take_profit || 0),
            stop_loss:         Number(sess.stop_loss   || 0),
            pnl:               Number(sess.pnl || 0),
            trades:            Number(sess.trades || 0),
            wins:              Number(sess.wins   || 0),
            losses:            Number(sess.losses || 0),
            win_streak:        Number(sess.win_streak  || 0),
            loss_streak:       Number(sess.loss_streak || 0),
            halted:            !!sess.halted,
            halt_reason:       sess.halt_reason || null,
        },
        exposure,
        open_siblings: polled.filter(p => p && (p.poc != null || !p.error)).map(p => ({
            contract_id:        p.sibling.contract_id,
            stake:              p.sibling.stake,
            multiplier:         p.sibling.multiplier,
            direction:          p.sibling.direction,
            entry_spot:         p.sibling.entry_spot,
            entry_time:         p.sibling.entry_time,
            opened_at:          p.sibling.opened_at,
            current_spot:       p.poc ? p.poc.current_spot      : p.sibling.current_spot,
            floating_pnl:       p.poc ? p.poc.profit             : p.sibling.floating_pnl,
            floating_pnl_pct:   p.poc ? p.poc.profit_percentage  : p.sibling.floating_pnl_pct,
            bid_price:          p.poc ? p.poc.bid_price          : null,
            buy_price:          p.poc ? p.poc.buy_price          : null,
            is_open:            p.poc ? p.poc.is_open            : true,
            is_valid_to_sell:   p.poc ? p.poc.is_valid_to_sell   : false,
            is_valid_to_cancel: p.poc ? p.poc.is_valid_to_cancel : false,
            take_profit:        p.poc && p.poc.take_profit ? { amount: p.poc.take_profit.amount, value: p.poc.take_profit.value } : null,
            stop_loss:          p.poc && p.poc.stop_loss   ? { amount: p.poc.stop_loss.amount,   value: p.poc.stop_loss.value   } : null,
            stop_out:           p.poc && p.poc.stop_out    ? { amount: p.poc.stop_out.amount,    value: p.poc.stop_out.value    } : null,
            stop_out_distance_pct: p.stop_out_distance_pct,
            cycle_id:       p.sibling.cycle_id      || null,
            decision_id:    p.sibling.decision_id   || null,
            sibling_index:  p.sibling.sibling_index,
            sibling_count:  p.sibling.sibling_count,
            rationale:      p.sibling.rationale     || null,
        })),
        just_closed: [],
        gates: {
            can_open_new: true,                 // manual override — user is explicitly asking
            reason:       null,
        },
        market: marketSlice
            ? {
                symbol:                     marketSlice.symbol,
                timeframes:                 marketSlice.timeframes,
                volatility_proxy_atr14_m5:  marketSlice.volatility_proxy_atr14_m5,
            }
            : { error: marketError || 'market_slice_unavailable' },
    };

    // --- 5. Call the multiplier-aware AI decision --------------------
    let decision;
    try {
        const r = await AIClient.askMultiplierDecision({ aiInput, config, state });
        decision = r.decision;
    } catch (e) {
        Logger.error('Manual askMultiplierDecision threw', { error: e.message });
        decision = { action: 'hold', decision_id: 'ai-error', rationale: `AI call failed: ${e.message}` };
    }

    // Pre-action snapshot for the tick-summary template (matches the
    // cycle path's shape so revise old→new rendering still works).
    const preActionSiblings = aiInput.open_siblings.map(s => ({
        contract_id: s.contract_id,
        stake:       s.stake,
        multiplier:  s.multiplier,
        direction:   s.direction,
        take_profit: s.take_profit ? Number(s.take_profit.amount) : null,
        stop_loss:   s.stop_loss   ? Number(s.stop_loss.amount)   : null,
        floating_pnl:     s.floating_pnl,
        floating_pnl_pct: s.floating_pnl_pct,
        current_spot:     s.current_spot,
        entry_spot:       s.entry_spot,
        sibling_index:    s.sibling_index,
        sibling_count:    s.sibling_count,
    }));

    // --- 6. Execute the decision (open / close / revise / multi / hold) --
    const executed = { action: decision.action, details: [] };
    try {
        if (decision.action === 'open' && decision.open) {
            executed.details = executed.details.concat(
                await executeOpenSpec(ws, config, state, symbol, decision, decision.open, cycleId, aiInput, /*canOpenNew*/ true)
            );
            // Track the placed manual trade in state.trade_history_manual
            // so the rest of the daily-stats pipeline still sees it. Each
            // detail with a contract_id is a successful placement; rest
            // are errors that were already surfaced by the executor.
            state.trade_history_manual = state.trade_history_manual || [];
            for (const d of executed.details) {
                if (d && d.contract_id) {
                    state.trade_history_manual.push({
                        ts:          new Date().toISOString(),
                        symbol,
                        contract_id: d.contract_id,
                        path:        'manual',
                        decision_id: decision.decision_id || null,
                        rationale:   decision.rationale   || null,
                    });
                }
            }
        } else if (decision.action === 'close' && Array.isArray(decision.close)) {
            executed.details = executed.details.concat(
                await executeCloseList(ws, config, state, symbol, decision.close)
            );
        } else if (decision.action === 'revise' && Array.isArray(decision.revise)) {
            executed.details = executed.details.concat(
                await executeReviseList(ws, state, symbol, decision.revise)
            );
        } else if (decision.action === 'multi' && decision.multi) {
            if (Array.isArray(decision.multi.close) && decision.multi.close.length) {
                const out = await executeCloseList(ws, config, state, symbol, decision.multi.close);
                executed.details = executed.details.concat(out.map(d => Object.assign({ phase: 'close' }, d)));
            }
            if (Array.isArray(decision.multi.revise) && decision.multi.revise.length) {
                const out = await executeReviseList(ws, state, symbol, decision.multi.revise);
                executed.details = executed.details.concat(out.map(d => Object.assign({ phase: 'revise' }, d)));
            }
            if (decision.multi.open) {
                const out = await executeOpenSpec(ws, config, state, symbol, decision, decision.multi.open, cycleId, aiInput, /*canOpenNew*/ true);
                executed.details = executed.details.concat(out.map(d => Object.assign({ phase: 'open' }, d)));
            }
        } else {
            // 'hold' / 'skip' / unrecognised — no side-effects, but we
            // still want to emit the chart + rationale so the user can
            // SEE why the AI declined (was: silent "AI declined: ..."
            // text-only, no chart).
            executed.details.push({ note: decision.action === 'hold' || decision.action === 'skip'
                ? decision.action
                : `unrecognised action '${decision.action}', treating as hold` });
        }
    } catch (e) {
        Logger.error('Manual decision execution failed', { error: e.message, action: decision.action });
        executed.details.push({ error: `execution failed: ${e.message}` });
    }

    // Refresh exposure summary after any executor mutations.
    state[State.SUMMARY_KEY] = State.aggregateAllExposure(state);

    // --- 7. Build tick-summary message + chart and ship via Telegram -
    try {
        const postActionSiblings = State.getOpenSiblings(state, symbol);
        const postExposure       = State.aggregateSiblingExposure(state, symbol);
        const msg = Telegram.templates.multiplierTickSummary({
            symbol,
            mode:          state.account_mode,
            cycleId,
            decision,
            executed,
            justClosed:    [],
            openSiblings:  postActionSiblings,
            preActionSiblings,
            exposure:      postExposure,
            session:       state.cycle_session || {},
            riskBreach:    null,
            balance:       state.balance,
            currency:      state.currency,
        });

        // Render chart. Manual scan ALWAYS attaches a chart — the prior
        // implementation never did, which is the main visibility gap
        // the user called out.
        state.chart_windows = state.chart_windows || {};
        let chartBuf = null, nextWindow = null;
        try {
            const out = await Chart.renderMultiplierSnapshot({
                ws,
                symbol,
                tf:           '5m',
                openSiblings: postActionSiblings,
                chartWindow:  state.chart_windows[symbol] || null,
            });
            if (out && out.buffer && out.buffer.length > 1024) {
                chartBuf   = out.buffer;
                nextWindow = out.nextWindow;
            }
        } catch (e) {
            Logger.warn('Manual scan: chart render failed, falling back to generateChart', { symbol, error: e.message });
        }
        // Final fallback: plain generateChart so we still send a picture
        // even if the multiplier-snapshot variant failed.
        if (!chartBuf) {
            try {
                const buf = await Chart.generateChart(ws, symbol, '5m');
                if (buf && buf.length > 1024) chartBuf = buf;
            } catch (e) {
                Logger.warn('Manual scan: generateChart fallback also failed', { symbol, error: e.message });
            }
        }

        if (postActionSiblings.length === 0) {
            delete state.chart_windows[symbol];
        } else if (nextWindow && Number.isFinite(nextWindow.min) && Number.isFinite(nextWindow.max)) {
            state.chart_windows[symbol] = { min: nextWindow.min, max: nextWindow.max };
        }

        if (chartBuf) {
            const CAPTION_CAP = 1024;
            const caption = msg.length <= CAPTION_CAP
                ? msg
                : (msg.slice(0, CAPTION_CAP - 12) + '\n<i>…trimmed</i>');
            await Telegram.sendPhoto(chartBuf, caption);
        } else {
            await Telegram.send(msg);
        }
    } catch (e) {
        Logger.warn('Manual scan: Telegram send failed', { error: e.message });
    }

    return ws;
}

/* ─────────────────────────────────────────────────────────────────
   DAILY SUMMARY PATH
   ─────────────────────────────────────────────────────────────────
   cron-job.org dispatches this with {"task":"daily_summary"} once per
   day. We:
     1. Settle any pending contracts first (so the day's books close
        properly even if a contract crossed midnight UTC).
     2. Emit the dailySummary Telegram message for state.daily_stats.
     3. Archive the snapshot into state.daily_history (last 60 days).
     4. Reset state.daily_stats to today's empty counter.
   ───────────────────────────────────────────────────────────────── */
async function runDailySummary(ws, config, state) {
    const ds = ensureDailyStats(state);
    const reportDate = ds.date;

    try {
        await Telegram.send(Telegram.templates.dailySummary({
            date:   reportDate,
            mode:   state.account_mode || (config.account && config.account.mode) || 'demo',
            trades: ds.trades,
            wins:   ds.wins,
            losses: ds.losses,
            pnl:    ds.pnl,
        }));
    } catch (e) {
        Logger.warn('dailySummary send failed', { error: e.message });
    }

    // Archive
    state.daily_history = Array.isArray(state.daily_history) ? state.daily_history : [];
    state.daily_history.push({
        date:   ds.date,
        trades: ds.trades,
        wins:   ds.wins,
        losses: ds.losses,
        pnl:    ds.pnl,
        by_symbol: ds.by_symbol || {},
    });
    if (state.daily_history.length > 60) {
        state.daily_history = state.daily_history.slice(-60);
    }

    // Reset (unless config disables it)
    const resetOn = !config.daily_summary || config.daily_summary.reset_on_send !== false;
    if (resetOn) {
        state.daily_stats = {
            date:    todayUTC(),
            trades:  0,
            wins:    0,
            losses:  0,
            pnl:     0,
            by_symbol: {},
        };
        Logger.info('daily_stats reset for new UTC day', { date: state.daily_stats.date });
    }
}

/* ─────────────────────────────────────────────────────────────────
   MAIN
   ───────────────────────────────────────────────────────────────── */
async function main() {
    const cycleStart = Date.now();
    Logger.info('Tick start', { ts: new Date().toISOString() });

    const config = readJSON(CFG_PATH);
    if (!config) { Logger.error('config.json missing'); return 0; }

    const state = readJSON(STATE_PATH, {});
    state.cycle_session       = state.cycle_session       || { active:false, halted:false };
    state.pending_contracts   = state.pending_contracts   || [];
    state.trade_history_cycle = state.trade_history_cycle || [];
    state.trade_history_manual= state.trade_history_manual|| [];
    state.ai_keys_bench       = state.ai_keys_bench       || {};
    ensureDailyStats(state);
    ensureManualSession(state, config);

    if (config.enabled === false) {
        Logger.info('Bot disabled');
        state.last_cycle = new Date().toISOString();
        state.logs = Logger.mergeRing(state.logs || []);
        writeJSON(STATE_PATH, state);
        return 0;
    }

    const task = detectTask();
    const connOpts = {
        bearer: process.env.DERIV_BEARER_TOKEN,
        appId:  process.env.DERIV_APP_ID,
        mode:   config.account.mode,
        realId: process.env.DERIV_REAL_ID || config.account.real_id,
        demoId: process.env.DERIV_DEMO_ID || config.account.demo_id,
    };
    let conn = null, ws = null;
    try {
        conn = await Deriv.connect(connOpts);
        ws = conn.ws;

        // Balance refresh
        try {
            const bal = await Deriv.getBalance(ws);
            state.balance = bal.balance;
            state.currency = bal.currency;
            state.account_mode = config.account.mode;
        } catch (e) { Logger.warn('balance fetch failed', { error: e.message }); }

        // Always settle pendings first
        await settleAllPending(ws, config, state);

        if (task === 'cycle') {
            // Route by engine flag. Defaults to 'multipliers' on this
            // fork; set config.cycle.engine='binary' to use the legacy
            // binary runCycle() (kept for reference / migration).
            const engine = (config.cycle && config.cycle.engine) || 'multipliers';
            if (engine === 'binary') {
                ws = await runCycle(ws, config, state, connOpts) || ws;
            } else {
                ws = await runMultiplierCycle(ws, config, state, connOpts) || ws;
            }
        } else if (task === 'manual') {
            ws = await runManual(ws, config, state, connOpts) || ws;
        } else if (task === 'settle_only') {
            Logger.info('settle_only — done');
        } else if (task === 'daily_summary') {
            await runDailySummary(ws, config, state);
        }
    } catch (e) {
        Logger.error('Tick failed', { error: e.message, stack: e.stack });
        try {
            await Telegram.send(`⚠️ <b>AURELIA</b> tick failed: <code>${String(e.message).slice(0,200)}</code>`);
        } catch (_) {}
    } finally {
        try { if (ws) Deriv.close(ws); } catch (_) {}
    }

    // Trim history rings (keep last 200 each)
    if (state.trade_history_cycle.length  > 200) state.trade_history_cycle  = state.trade_history_cycle.slice(-200);
    if (state.trade_history_manual.length > 200) state.trade_history_manual = state.trade_history_manual.slice(-200);

    state.last_cycle = new Date().toISOString();
    state.logs = Logger.mergeRing(state.logs || []);
    writeJSON(STATE_PATH, state);
    Logger.info('Tick end', { ms: Date.now() - cycleStart });
    return 0;
}

// Expose internals so smoke tests can drive runMultiplierCycle against
// an injected mock WS without spinning up Deriv. The runtime entrypoint
// (`node runner.js`) still goes through main() below.
module.exports = {
    // Multiplier cycle path (Part 2a + 2b):
    runMultiplierCycle,
    resolveActiveSymbol,
    askMultiplierDecisionStub,
    inferCloseReason,
    realizeClosedSibling,
    enforceAggregateRisk,
    // Part 3c — end-of-session summary:
    maybeSendSessionSummary,
    forceCloseAllForSymbol,
    openSibling,
    pollSibling,
    // Part 2b execution helpers (exposed for smoke tests):
    executeCloseList,
    executeOpenSpec,
    executeReviseList,
    // Legacy / shared:
    runCycle,
    runManual,
    runDailySummary,
    settleAllPending,
    applyCycleSettlement,
    applyDailyStat,
    validateDecision,
    isSymbolEnabled,
    main,
};

if (require.main === module) {
    main().then(code => process.exit(code || 0))
          .catch(e  => { console.error('fatal', e); process.exit(1); });
}
