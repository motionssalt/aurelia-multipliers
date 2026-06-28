/**
 * Verifies — against Deriv's REAL public WebSocket API — what multiplier
 * values cryBTCUSD actually accepts. This is the parameter-validation
 * half of the bugfix; no authentication required (contracts_for is a
 * public unauthenticated call).
 *
 * For the auth-protected proposal+buy half we additionally try a
 * proposal call WITHOUT a token — which Deriv answers with an
 * AuthorizationRequired error (proving the reject-path works) — and
 * also a proposal call with an out-of-range multiplier, which Deriv
 * answers with the actual error code/message we need to identify.
 */
const WebSocket = require('ws');

function open(url) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url);
        ws.on('open', () => resolve(ws));
        ws.on('error', reject);
    });
}

function req(ws, payload, id) {
    return new Promise((resolve, reject) => {
        const body = Object.assign({}, payload, { req_id: id });
        const t = setTimeout(() => reject(new Error('timeout')), 15000);
        const handler = (raw) => {
            let d; try { d = JSON.parse(raw.toString()); } catch (e) { return; }
            if (d.req_id !== id) return;
            ws.off('message', handler);
            clearTimeout(t);
            resolve(d);
        };
        ws.on('message', handler);
        ws.send(JSON.stringify(body));
    });
}

(async () => {
    const ws = await open('wss://ws.derivws.com/websockets/v3?app_id=1089');
    console.log('connected to public WS');

    // 1) contracts_for cryBTCUSD — what multipliers are actually valid?
    const cf = await req(ws, {
        contracts_for: 'cryBTCUSD',
        currency:      'USD',
        product_type:  'basic',
    }, 1);
    if (cf.error) { console.log('contracts_for ERROR:', cf.error); }
    else {
        const mults = (cf.contracts_for && cf.contracts_for.available || [])
            .filter(c => c.contract_type === 'MULTUP' || c.contract_type === 'MULTDOWN');
        const set = new Set();
        for (const c of mults) {
            const r = c.multiplier_range || c.multiplier || [];
            (Array.isArray(r) ? r : []).forEach(v => set.add(v));
        }
        console.log('cryBTCUSD accepted multipliers (live contracts_for):',
            [...set].sort((a,b) => a - b));
        // sample first MULTUP entry for shape
        const sample = mults.find(c => c.contract_type === 'MULTUP');
        if (sample) {
            console.log('Sample MULTUP entry keys:', Object.keys(sample).slice(0, 25));
            console.log('  multiplier_range:', sample.multiplier_range);
            console.log('  min_stake:', sample.min_stake, 'max_stake:', sample.max_stake);
        }
    }

    // 2) Attempt proposal with an INVALID multiplier the AI prompt currently
    //    suggests as "typical" (e.g. 50, 75) — capture Deriv's exact error.
    for (const m of [50, 75, 25, 100]) {
        const p = await req(ws, {
            proposal:      1,
            amount:        5,
            basis:         'stake',
            contract_type: 'MULTUP',
            currency:      'USD',
            symbol:        'cryBTCUSD',
            multiplier:    m,
        }, 100 + m);
        if (p.error) {
            console.log(`proposal mult=${m} ERROR  -> code=${p.error.code} msg=${p.error.message}`);
        } else if (p.proposal) {
            console.log(`proposal mult=${m} OK     -> id=${p.proposal.id} ask=${p.proposal.ask_price} spot=${p.proposal.spot}`);
        } else {
            console.log(`proposal mult=${m} ??     -> ${JSON.stringify(p).slice(0, 200)}`);
        }
    }

    ws.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
