/* =====================================================================
   AURELIA-MULTIPLIERS — sibling-position state helpers
   ─────────────────────────────────────────────────────────────────────
   Pure (no I/O, no side-effects on anything other than the `state`
   argument the caller passes in) helpers for the new persisted state
   shape introduced in Part 1.

   Why this exists
   ───────────────
   The original AURELIA bot keeps one open contract at a time per cycle:
       state.cycle_open_position = { contract_id, symbol, placed_at }
   That is enough for fixed-expiry binary trades where every decision
   resolves in a single short window.

   Multipliers do not resolve on their own \u2014 they sit open until they
   are sold, hit TP/SL, or hit stop_out. The Part-2 cron tick will ask
   the AI, on every 5-minute invocation, to hold / close / revise risk
   on each currently-open position. The AI is also allowed to split one
   decision into multiple sibling positions on the same symbol (e.g.
   four $12.50 positions instead of one $50 position) so it can later
   partially de-risk by closing one of them \u2014 see the deriv.js header:
   Deriv's `sell` endpoint does not support partial close.

   Therefore the new state shape stores, per symbol, an ARRAY of open
   sibling positions \u2014 not a single object. This file owns the helpers
   that mutate that array, so Part 2's runner doesn't reach into the
   raw structure.

   The full state shape is documented in STATE_SHAPE.md \u2014 Part 2/3
   sessions read THAT file, not this one.

   Conventions used in this file
   ─────────────────────────────
   * `state` is the in-memory parse of last-status.json. Mutated in
     place (consistent with the existing runner.js style).
   * `symbol` keys are Deriv symbol strings (e.g. 'R_100', 'frxEURUSD').
   * Every helper is defensive: missing top-level keys are auto-created
     so a fresh `last-status.json` (or one that predates this fork) just
     works without a migration step.
   * Nothing here calls Logger \u2014 these are pure data helpers. The
     runner is responsible for logging higher-level events. Keeping
     this module log-free also makes it trivial to unit-test.
   ===================================================================== */

const SIBLINGS_KEY = 'cycle_open_siblings';
const SUMMARY_KEY  = 'cycle_open_siblings_summary'; // optional convenience cache

/* ─────────────────────────────────────────────────────────────────
   Internal: ensure the sibling container exists on `state` and
   return the per-symbol array (creating it if absent).
   ───────────────────────────────────────────────────────────────── */
function _ensureSymbolArray(state, symbol) {
    if (!state || typeof state !== 'object') {
        throw new Error('state must be an object');
    }
    if (!symbol || typeof symbol !== 'string') {
        throw new Error('symbol must be a non-empty string');
    }
    if (!state[SIBLINGS_KEY] || typeof state[SIBLINGS_KEY] !== 'object') {
        state[SIBLINGS_KEY] = {};
    }
    if (!Array.isArray(state[SIBLINGS_KEY][symbol])) {
        state[SIBLINGS_KEY][symbol] = [];
    }
    return state[SIBLINGS_KEY][symbol];
}

/**
 * addSiblingPosition — append a new open sibling position record.
 *
 * Idempotent on contract_id: if a sibling with the same contract_id
 * already exists for this symbol, it is replaced (not duplicated).
 * Idempotency matters because the cron retry / settle_only flow may
 * re-run a cycle without the previous tick having persisted state.
 *
 * The shape of `position` is the authoritative sibling record format
 * (see STATE_SHAPE.md). Only `contract_id` is strictly required here;
 * the rest is preserved verbatim so future fields can be added without
 * editing this file.
 *
 * @param {object} state
 * @param {string} symbol
 * @param {object} position  Must contain at least { contract_id }
 * @returns {object[]}       Updated array of siblings for the symbol
 */
function addSiblingPosition(state, symbol, position) {
    if (!position || typeof position !== 'object') {
        throw new Error('addSiblingPosition: position must be an object');
    }
    const cid = position.contract_id;
    if (cid == null) {
        throw new Error('addSiblingPosition: position.contract_id is required');
    }
    const arr = _ensureSymbolArray(state, symbol);
    const idx = arr.findIndex(p => p && p.contract_id === cid);
    if (idx >= 0) {
        // Replace in place — preserve insertion order for stable display.
        arr[idx] = Object.assign({}, arr[idx], position);
    } else {
        arr.push(position);
    }
    return arr;
}

/**
 * removeSiblingPosition — drop a sibling by contract_id.
 *
 * Returns true if a sibling was removed, false if not found. Does NOT
 * throw on "not found" — Part 2's settle / close flow may re-run the
 * removal as part of a retry path, and a missing contract just means
 * the previous tick already cleaned up.
 *
 * If the symbol's array becomes empty as a result, the empty array is
 * left in place (NOT deleted). Keeping it around makes the JSON file
 * easier to read after a busy session and is cheap; the aggregation
 * helpers all treat empty arrays as "no exposure".
 *
 * @param {object} state
 * @param {string} symbol
 * @param {number|string} contractId
 * @returns {boolean}
 */
function removeSiblingPosition(state, symbol, contractId) {
    if (!state || !state[SIBLINGS_KEY]) return false;
    const arr = state[SIBLINGS_KEY][symbol];
    if (!Array.isArray(arr) || arr.length === 0) return false;
    const idx = arr.findIndex(p => p && p.contract_id === contractId);
    if (idx < 0) return false;
    arr.splice(idx, 1);
    return true;
}

/**
 * updateSiblingPosition — patch a sibling record in place (e.g. after a
 * successful contract_update to record the new TP/SL, or after a poll
 * to refresh floating P/L).
 *
 * Returns the patched sibling record, or null if the sibling wasn't
 * found. Like removeSiblingPosition, this is non-throwing on missing
 * contract — caller can decide whether the absence is an error.
 *
 * @param {object} state
 * @param {string} symbol
 * @param {number|string} contractId
 * @param {object} patch     Partial sibling fields to merge in
 * @returns {object|null}    Patched sibling record (mutated in place)
 */
function updateSiblingPosition(state, symbol, contractId, patch) {
    if (!patch || typeof patch !== 'object') {
        throw new Error('updateSiblingPosition: patch must be an object');
    }
    if (!state || !state[SIBLINGS_KEY]) return null;
    const arr = state[SIBLINGS_KEY][symbol];
    if (!Array.isArray(arr)) return null;
    const sib = arr.find(p => p && p.contract_id === contractId);
    if (!sib) return null;
    Object.assign(sib, patch);
    return sib;
}

/**
 * getOpenSiblings — return the current array of siblings for a symbol.
 *
 * Returns a SHALLOW COPY so callers can iterate / map without worrying
 * about concurrent mutation by other helpers. If the symbol has never
 * had siblings, returns []. Never returns undefined / null.
 *
 * @param {object} state
 * @param {string} symbol
 * @returns {object[]}
 */
function getOpenSiblings(state, symbol) {
    if (!state || !state[SIBLINGS_KEY]) return [];
    const arr = state[SIBLINGS_KEY][symbol];
    return Array.isArray(arr) ? arr.slice() : [];
}

/**
 * getAllOpenSiblings — flatten every symbol's siblings into a single
 * array of { symbol, ...sibling } records. Useful for Part 2's tick
 * loop which iterates ALL open positions on every invocation.
 *
 * @param {object} state
 * @returns {object[]}  Each item: { symbol, contract_id, ... }
 */
function getAllOpenSiblings(state) {
    if (!state || !state[SIBLINGS_KEY]) return [];
    const out = [];
    for (const [symbol, arr] of Object.entries(state[SIBLINGS_KEY])) {
        if (!Array.isArray(arr)) continue;
        for (const sib of arr) {
            if (sib && typeof sib === 'object') {
                out.push(Object.assign({ symbol }, sib));
            }
        }
    }
    return out;
}

/**
 * aggregateSiblingExposure — per-symbol risk roll-up.
 *
 * Sums the static stake-at-risk (from the persisted `stake` field on
 * each sibling) plus the most recently observed floating P/L (from the
 * `floating_pnl` field that Part 2 will refresh on every tick via
 * getOpenPositionState).
 *
 * If no siblings have a `floating_pnl` recorded yet (i.e. the position
 * was just opened this tick), floating_pnl_total is null (NOT 0) so
 * downstream code can distinguish "haven't polled yet" from "polled
 * and P/L is exactly $0".
 *
 * @param {object} state
 * @param {string} symbol
 * @returns {{
 *   symbol: string,
 *   count: number,
 *   total_stake: number,
 *   total_floating_pnl: number | null,
 *   net_position: number,            // total_stake + (floating_pnl || 0)
 *   direction_mix: { up: number, down: number },  // counts per direction
 * }}
 */
function aggregateSiblingExposure(state, symbol) {
    const arr = (state && state[SIBLINGS_KEY] && state[SIBLINGS_KEY][symbol]) || [];
    let totalStake = 0;
    let pnlSum = 0;
    let pnlCount = 0;
    const directionMix = { up: 0, down: 0 };
    for (const sib of arr) {
        if (!sib || typeof sib !== 'object') continue;
        const stake = Number(sib.stake);
        if (Number.isFinite(stake)) totalStake += stake;
        // Important: Number(null) === 0 (Number.isFinite(0) is true), so
        // null-check first — otherwise an unpolled sibling would be
        // counted as observed-with-zero-P/L and we'd lose the ability to
        // distinguish "never polled" from "polled and exactly flat".
        if (sib.floating_pnl != null) {
            const pnl = Number(sib.floating_pnl);
            if (Number.isFinite(pnl)) {
                pnlSum += pnl;
                pnlCount += 1;
            }
        }
        const dir = String(sib.direction || '').toLowerCase();
        if (dir === 'up')   directionMix.up   += 1;
        if (dir === 'down') directionMix.down += 1;
    }
    const total_floating_pnl = pnlCount > 0 ? Number(pnlSum.toFixed(2)) : null;
    return {
        symbol,
        count: arr.length,
        total_stake: Number(totalStake.toFixed(2)),
        total_floating_pnl,
        net_position: Number((totalStake + (total_floating_pnl || 0)).toFixed(2)),
        direction_mix: directionMix,
    };
}

/**
 * aggregateAllExposure — same as aggregateSiblingExposure but
 * collapsed across every symbol. Useful for the cycle-session level
 * "am I over the global stop-loss?" check Part 3 will own.
 *
 * @param {object} state
 * @returns {{
 *   symbols: number,
 *   positions: number,
 *   total_stake: number,
 *   total_floating_pnl: number | null,
 *   per_symbol: object[],   // array of aggregateSiblingExposure rows
 * }}
 */
function aggregateAllExposure(state) {
    const container = (state && state[SIBLINGS_KEY]) || {};
    const perSymbol = [];
    let totalStake = 0;
    let pnlSum = 0;
    let pnlObserved = false;
    let positions = 0;
    for (const symbol of Object.keys(container)) {
        const agg = aggregateSiblingExposure(state, symbol);
        if (agg.count === 0) continue;
        perSymbol.push(agg);
        totalStake += agg.total_stake;
        positions  += agg.count;
        if (agg.total_floating_pnl != null) {
            pnlSum += agg.total_floating_pnl;
            pnlObserved = true;
        }
    }
    return {
        symbols:           perSymbol.length,
        positions,
        total_stake:        Number(totalStake.toFixed(2)),
        total_floating_pnl: pnlObserved ? Number(pnlSum.toFixed(2)) : null,
        per_symbol:         perSymbol,
    };
}

/**
 * makeSiblingRecord — convenience constructor that builds a sibling
 * record in the canonical shape from the typical inputs Part 2 will
 * have on hand right after a successful placeMultiplier() call.
 *
 * Part 2 is free to bypass this and shape its own object \u2014 the field
 * names defined here ARE the contract though, so prefer using this
 * factory.
 *
 * @param {object} args
 *   @param {number|string} args.contract_id      Required
 *   @param {number}        args.stake            Required
 *   @param {number}        args.multiplier       Required
 *   @param {'up'|'down'}   args.direction        Required
 *   @param {string|number} [args.entry_spot]
 *   @param {string|number} [args.entry_time]      ISO string OR epoch
 *   @param {number|null}   [args.take_profit]     $-amount; null = none
 *   @param {number|null}   [args.stop_loss]       $-amount; null = none
 *   @param {string}        [args.cycle_id]       Reference to AI decision
 *   @param {string}        [args.decision_id]    Reference to AI decision
 *   @param {number}        [args.sibling_index]  0,1,2,... within the
 *                                                 parent decision
 *   @param {number}        [args.sibling_count]  Total siblings in this
 *                                                 decision
 *   @param {string}        [args.rationale]      AI's reason for opening
 * @returns {object}  Canonical sibling record
 */
function makeSiblingRecord(args) {
    if (!args || typeof args !== 'object') {
        throw new Error('makeSiblingRecord: args required');
    }
    if (args.contract_id == null) throw new Error('makeSiblingRecord: contract_id required');
    if (!Number.isFinite(Number(args.stake))) throw new Error('makeSiblingRecord: stake required');
    if (!Number.isFinite(Number(args.multiplier))) throw new Error('makeSiblingRecord: multiplier required');
    const dir = String(args.direction || '').toLowerCase();
    if (dir !== 'up' && dir !== 'down') {
        throw new Error('makeSiblingRecord: direction must be up|down');
    }
    return {
        contract_id:    args.contract_id,
        stake:          Number(args.stake),
        multiplier:     Number(args.multiplier),
        direction:      dir,
        entry_spot:     args.entry_spot != null ? Number(args.entry_spot) : null,
        entry_time:     args.entry_time != null ? args.entry_time : new Date().toISOString(),
        take_profit:    args.take_profit != null ? Number(args.take_profit) : null,
        stop_loss:      args.stop_loss   != null ? Number(args.stop_loss)   : null,
        // Floating P/L is refreshed each cycle tick by Part 2:
        floating_pnl:        null,
        floating_pnl_pct:    null,
        current_spot:        null,
        last_polled_at:      null,
        // Provenance — links this sibling back to the AI decision that
        // spawned it (for Part 3's session summary):
        cycle_id:       args.cycle_id      || null,
        decision_id:    args.decision_id   || null,
        sibling_index:  Number.isFinite(Number(args.sibling_index)) ? Number(args.sibling_index) : 0,
        sibling_count:  Number.isFinite(Number(args.sibling_count)) ? Number(args.sibling_count) : 1,
        rationale:      args.rationale     || null,
        opened_at:      new Date().toISOString(),
        // Audit trail of every TP/SL revise attempt on this sibling.
        // Bounded to the most recent MAX_REVISION_HISTORY entries (oldest
        // dropped) so the JSON state file does not grow unbounded for
        // long-lived siblings. Surfaced to the AI prompt on every tick so
        // the AI can avoid retrying an identical revision that has
        // already failed/reverted on this contract.
        revision_history: [],
    };
}

/* Cap revision_history at this many entries per sibling. Older attempts
   are dropped FIFO. Large enough to cover a full session of TP/SL
   tweaks (one per tick worst case ~60/h) without bloating state. */
const MAX_REVISION_HISTORY = 20;

/**
 * appendRevisionAttempt — record a TP/SL revise attempt against a
 * specific sibling, regardless of outcome. The whole point of keeping
 * this log is so a future AI tick can see "this exact revision was
 * already tried and failed/reverted" and avoid repeating the same
 * mistake.
 *
 * Outcomes:
 *   'ok'       — the broker accepted the requested values verbatim.
 *   'clamped'  — the broker accepted, but values were clamped to fit
 *                the live per-contract TP/SL range. The AI should NOT
 *                re-submit the same out-of-range values next tick.
 *   'reverted' — (reserved) the revise call "succeeded" but the
 *                broker later snapped TP/SL back to a different value
 *                on a subsequent poll. Detected by deriv.js / runner.
 *   'failed'   — the revise call threw or was rejected (error string).
 *
 * The entry shape is intentionally compact — it is rendered inline
 * in the AI prompt, where token budget matters.
 *
 * @param {object}  state
 * @param {string}  symbol
 * @param {number}  contractId
 * @param {object}  attempt
 * @param {string}  attempt.outcome      'ok'|'clamped'|'reverted'|'failed'
 * @param {object}  attempt.requested    {take_profit?, stop_loss?}
 * @param {object} [attempt.applied]     {take_profit?, stop_loss?} — actual values after broker reply
 * @param {string} [attempt.error]       Error message when outcome === 'failed'
 * @param {object} [attempt.clamp_adjustments] Optional clamp detail from deriv.js
 * @param {string} [attempt.decision_id] The AI decision that produced this attempt
 * @returns {object|null} The appended log entry, or null if the sibling was not found.
 */
function appendRevisionAttempt(state, symbol, contractId, attempt) {
    if (!attempt || typeof attempt !== 'object') {
        throw new Error('appendRevisionAttempt: attempt must be an object');
    }
    if (!state || !state[SIBLINGS_KEY]) return null;
    const arr = state[SIBLINGS_KEY][symbol];
    if (!Array.isArray(arr)) return null;
    const sib = arr.find(p => p && p.contract_id === contractId);
    if (!sib) return null;

    const outcome = String(attempt.outcome || '').toLowerCase();
    const allowed = ['ok', 'clamped', 'reverted', 'failed'];
    if (!allowed.includes(outcome)) {
        throw new Error('appendRevisionAttempt: outcome must be one of ' + allowed.join('|'));
    }

    const entry = {
        ts:          new Date().toISOString(),
        outcome,
        requested:   attempt.requested || {},
    };
    if (attempt.applied !== undefined)            entry.applied            = attempt.applied;
    if (attempt.error)                            entry.error              = String(attempt.error);
    if (attempt.clamp_adjustments)                entry.clamp_adjustments  = attempt.clamp_adjustments;
    if (attempt.decision_id)                      entry.decision_id        = String(attempt.decision_id);

    if (!Array.isArray(sib.revision_history)) sib.revision_history = [];
    sib.revision_history.push(entry);
    // FIFO bound — drop oldest entries past the cap.
    if (sib.revision_history.length > MAX_REVISION_HISTORY) {
        sib.revision_history.splice(0, sib.revision_history.length - MAX_REVISION_HISTORY);
    }
    return entry;
}

/**
 * countOpenSiblings — total number of open siblings across all symbols.
 * Cheap shorthand used by Part 2's tick-loop entry check.
 *
 * @param {object} state
 * @returns {number}
 */
function countOpenSiblings(state) {
    if (!state || !state[SIBLINGS_KEY]) return 0;
    let n = 0;
    for (const arr of Object.values(state[SIBLINGS_KEY])) {
        if (Array.isArray(arr)) n += arr.length;
    }
    return n;
}

/**
 * pruneEmptySymbols — drop symbol keys whose sibling array is empty.
 * Useful before persisting state to keep last-status.json tidy after
 * a busy session. Optional \u2014 not called automatically because some
 * Part 3 dashboards may want to see "this symbol has been touched
 * this session even though it's currently flat".
 *
 * @param {object} state
 * @returns {string[]}  list of removed symbol keys
 */
function pruneEmptySymbols(state) {
    if (!state || !state[SIBLINGS_KEY]) return [];
    const removed = [];
    for (const sym of Object.keys(state[SIBLINGS_KEY])) {
        const arr = state[SIBLINGS_KEY][sym];
        if (!Array.isArray(arr) || arr.length === 0) {
            delete state[SIBLINGS_KEY][sym];
            removed.push(sym);
        }
    }
    return removed;
}

module.exports = {
    // The key under which sibling positions live in last-status.json.
    // Exported so Part 2/3 can reference it symbolically rather than
    // hardcoding the string.
    SIBLINGS_KEY,
    SUMMARY_KEY,
    MAX_REVISION_HISTORY,
    // Mutators:
    addSiblingPosition,
    removeSiblingPosition,
    updateSiblingPosition,
    appendRevisionAttempt,
    pruneEmptySymbols,
    // Readers:
    getOpenSiblings,
    getAllOpenSiblings,
    aggregateSiblingExposure,
    aggregateAllExposure,
    countOpenSiblings,
    // Factory:
    makeSiblingRecord,
};
