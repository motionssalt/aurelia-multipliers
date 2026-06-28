/* =====================================================================
   MOTIONSALT — structured logger
   ─────────────────────────────────────────────────────────────────────
   Levels: info | signal | trade | warn | error | debug | network
   Buffers entries in memory and exposes flush() so runner.js can write
   them into last-status.json (ring-buffered to 200 entries).
   ===================================================================== */

const RING_MAX = 200;

const _buffer = [];

function _push(level, msg, meta) {
    const entry = {
        ts:   new Date().toISOString(),
        level,
        msg:  String(msg),
        meta: (meta && typeof meta === 'object') ? meta : {}
    };
    _buffer.push(entry);
    // Mirror to stdout for GitHub Actions log visibility
    const stamp = `[${entry.ts}] [${level.toUpperCase().padEnd(7)}]`;
    if (level === 'error') {
        console.error(stamp, msg, meta || '');
    } else if (level === 'warn') {
        console.warn(stamp, msg, meta || '');
    } else {
        console.log(stamp, msg, meta || '');
    }
    return entry;
}

const Logger = {
    info:    (msg, meta) => _push('info',    msg, meta),
    signal:  (msg, meta) => _push('signal',  msg, meta),
    trade:   (msg, meta) => _push('trade',   msg, meta),
    warn:    (msg, meta) => _push('warn',    msg, meta),
    error:   (msg, meta) => _push('error',   msg, meta),
    debug:   (msg, meta) => _push('debug',   msg, meta),
    network: (msg, meta) => _push('network', msg, meta),

    /** Return a structured-logger function bound to a context tag. */
    bind(tag) {
        return (level, msg, meta) =>
            _push(level, `[${tag}] ${msg}`, meta);
    },

    /** Drain this cycle's logs (oldest first). Does NOT clear buffer. */
    snapshot() { return _buffer.slice(); },

    /** Clear the in-memory buffer (call once per cycle, after snapshot). */
    clear() { _buffer.length = 0; },

    /**
     * Merge new logs into an existing ring buffer (from last-status.json)
     * and trim to RING_MAX entries (oldest dropped).
     */
    mergeRing(existing) {
        const prior = Array.isArray(existing) ? existing : [];
        const merged = prior.concat(_buffer);
        if (merged.length <= RING_MAX) return merged;
        return merged.slice(merged.length - RING_MAX);
    },

    RING_MAX
};

module.exports = Logger;
