/* =====================================================================
   AURELIA — risk.js
   ─────────────────────────────────────────────────────────────────────
   Deliberately NOT a stake-computing module. Per REBUILD_PROMPT §5,
   stake sizing is fully AI-determined. This file only provides a SANITY
   CLAMP that the runner applies AFTER the AI returns a stake.

   Clamping rules (hard, non-negotiable):
     • min  : config.stake.absolute_min   (default 1)
     • max  : config.stake.absolute_max   (default 10000)
     • 2 decimal places
     • never exceed remaining session capital (cycle path only)
   Manual trades skip the "remaining session capital" check (they're
   stateless w.r.t. the cycle session) but still get min/max + rounding.

   Expiry clamp:
     • Always >= config.expiry.min_seconds (default 900, i.e. 15 min)
     • Any duration at or above the floor is allowed — there is NO
       intentional upper cap below 24h. A defensive 24h safety
       ceiling exists only to reject obviously malformed values
       (e.g. AI emitting Number.MAX_SAFE_INTEGER).
   ===================================================================== */

'use strict';

function _round2(n) { return Math.round(Number(n) * 100) / 100; }

function clampStake(stakeRaw, config, opts) {
    const min = (config.stake && config.stake.absolute_min) || 1;
    const max = (config.stake && config.stake.absolute_max) || 10000;
    let s = Number(stakeRaw);
    if (!Number.isFinite(s) || s <= 0) s = min;

    if (opts && opts.cycleSessionRemaining != null) {
        const cap = Number(opts.cycleSessionRemaining);
        if (Number.isFinite(cap) && cap > 0) {
            s = Math.min(s, cap);
        }
    }
    s = Math.max(min, Math.min(max, s));
    return _round2(s);
}

// 24h sanity ceiling — Deriv intraday contracts don't run longer
// than a day and we never want a typo / model glitch to lock a trade
// open for weeks. Any value between `floor` and this ceiling is
// passed through untouched.
const EXPIRY_SAFETY_CEILING_SEC = 24 * 60 * 60;

function clampExpirySeconds(expiryRaw, config) {
    const floor = (config.expiry && config.expiry.min_seconds) || 900;
    let e = Math.floor(Number(expiryRaw) || 0);
    if (e < floor) e = floor;
    if (e > EXPIRY_SAFETY_CEILING_SEC) e = EXPIRY_SAFETY_CEILING_SEC;
    return e;
}

function expirySecondsToMinutes(seconds) {
    return Math.max(1, Math.round(seconds / 60));
}

module.exports = {
    clampStake,
    clampExpirySeconds,
    expirySecondsToMinutes,
    EXPIRY_SAFETY_CEILING_SEC,
};
