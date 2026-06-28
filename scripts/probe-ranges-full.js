/* scripts/probe-ranges-full.js
 *
 * Live probe of Deriv's `contracts_for` endpoint to discover the
 * MULTUP/MULTDOWN multiplier set actually accepted for each symbol.
 *
 * USAGE
 *   node scripts/probe-ranges-full.js [app_id] [symbol1 symbol2 ...]
 *
 *   app_id defaults to 1089 (Deriv's public demo app_id, no auth needed
 *   for contracts_for).
 *
 *   With no symbol args, probes the synthetic + crypto + a couple of forex
 *   symbols already known to be enabled in config.json.
 *
 * Notes
 *   - This is a READ-ONLY query; no token/auth required.
 *   - `contracts_for` returns an `available[]` array; we filter to entries
 *     with `contract_category === 'multiplier'` and extract their
 *     `multiplier_range` (already an array of integers).
 *   - Output is printed in the exact format expected by ai-client.js's
 *     MULTIPLIER_RANGE_BY_SYMBOL table for easy copy-paste.
 */
'use strict';

const WebSocket = require('ws');

const APP_ID = process.argv[2] && /^\d+$/.test(process.argv[2]) ? process.argv[2] : '1089';
const ENDPOINT = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;

const DEFAULT_SYMBOLS = [
    'R_10','R_25','R_50','R_75','R_100',
    '1HZ10V','1HZ25V','1HZ50V','1HZ75V','1HZ100V',
    'frxEURUSD','frxGBPUSD','frxUSDJPY','frxXAUUSD',
    'cryBTCUSD','cryETHUSD',
];

const SYMBOLS = process.argv.length > 3
    ? process.argv.slice(3)
    : (process.argv.length === 3 && !/^\d+$/.test(process.argv[2])
        ? [process.argv[2]]
        : DEFAULT_SYMBOLS);

function request(ws, payload, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
        const id = ws.__reqId++;
        const timer = setTimeout(() => {
            ws.__pending.delete(id);
            reject(new Error(`request timeout: ${JSON.stringify(payload).slice(0, 60)}`));
        }, timeoutMs);
        ws.__pending.set(id, { resolve, reject, timer });
        ws.send(JSON.stringify(Object.assign({}, payload, { req_id: id })));
    });
}

async function probe(ws, symbol) {
    try {
        const r = await request(ws, {
            contracts_for: symbol,
            currency:      'USD',
            product_type:  'basic',
        });
        const available = (r.contracts_for && r.contracts_for.available) || [];
        const ms = available.filter(c =>
            String(c.contract_category) === 'multiplier' &&
            Array.isArray(c.multiplier_range) &&
            c.multiplier_range.length);

        if (!ms.length) return { symbol, error: 'no multiplier contracts in available[]' };

        // Some symbols return MULTUP and MULTDOWN as separate rows with
        // identical ranges; dedupe to a single sorted-unique array.
        const set = new Set();
        for (const m of ms) {
            for (const n of m.multiplier_range) set.add(Number(n));
        }
        const range = Array.from(set).sort((a, b) => a - b);
        return { symbol, range };
    } catch (e) {
        return { symbol, error: e.message };
    }
}

(async () => {
    const ws = new WebSocket(ENDPOINT);
    ws.__reqId = 1;
    ws.__pending = new Map();

    ws.on('message', (raw) => {
        let data; try { data = JSON.parse(raw.toString()); } catch (e) { return; }
        const id = data.req_id;
        if (id != null && ws.__pending.has(id)) {
            const slot = ws.__pending.get(id);
            ws.__pending.delete(id);
            clearTimeout(slot.timer);
            if (data.error) slot.reject(new Error(`${data.error.code}: ${data.error.message}`));
            else slot.resolve(data);
        }
    });

    await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('open timeout')), 15000);
        ws.on('open', () => { clearTimeout(t); resolve(); });
        ws.on('error', (e) => { clearTimeout(t); reject(e); });
    });

    console.log(`# Probed ${ENDPOINT}`);
    console.log(`# Date: ${new Date().toISOString()}`);
    console.log('# Format: SYMBOL => sorted multiplier_range');
    console.log('');
    for (const sym of SYMBOLS) {
        const r = await probe(ws, sym);
        if (r.error) {
            console.log(`${r.symbol.padEnd(12)} => ERROR: ${r.error}`);
        } else {
            console.log(`${r.symbol.padEnd(12)} => ${r.range.join(', ')}`);
        }
    }
    ws.close();
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
