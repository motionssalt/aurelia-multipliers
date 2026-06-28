/* Standalone smoke-test for Part 3b: verifies pool plumbing in
   worker/index.js without invoking Cloudflare/Telegram/GitHub.

   We re-require the file in a stubbed environment, then poke at the
   exported pieces. The worker uses `export default` (ES module), so
   we'll re-evaluate the source in a Function() sandbox to inspect
   the constants and helpers. Keeps zero deps and is conversation-
   scoped (not a real test suite, per Part 3b constraints).
*/

const fs = require('fs');
const path = require('path');

let src = fs.readFileSync(path.join(__dirname, '..', 'worker', 'index.js'), 'utf8');

// Comment out the `export default { ... }` block (and only that block)
// so we can eval the file as a plain script and inspect locals.
// Everything else — including helper functions defined after the
// export — stays intact and reachable.
src = src.replace(/export default \{[\s\S]*?\n\};/, '/* export removed for smoke test */');
const head = src;

// Eval in a sandbox that exposes the locals we want via __probe.
const wrapped = `
${head}
// Expose probes
__probe.POOL_CODES = POOL_CODES;
__probe.CODE_TO_POOL = CODE_TO_POOL;
__probe.POOL_CATALOGS = POOL_CATALOGS;
__probe.POOL_LABELS = POOL_LABELS;
__probe.poolToCode = poolToCode;
__probe.codeToPool = codeToPool;
__probe.isPool24x7 = isPool24x7;
__probe.SYMBOL_CATALOG_FOREX = SYMBOL_CATALOG_FOREX;
__probe.SYMBOL_CATALOG_SYN = SYMBOL_CATALOG_SYN;
__probe.SYMBOL_CATALOG_CRYPTO = SYMBOL_CATALOG_CRYPTO;
__probe.renderSymbolsHome = renderSymbolsHome;
__probe.renderSymbolsPoolHeader = renderSymbolsPoolHeader;
__probe.renderMenu = renderMenu;
__probe.KB = KB;
`;
const __probe = {};
new Function('__probe', wrapped)(__probe);

let ok = true;
function assert(cond, msg) {
    console.log(`  ${cond ? '\x1b[32m✔\x1b[0m' : '\x1b[31m✘\x1b[0m'} ${msg}`);
    if (!cond) ok = false;
}

console.log('\n[1] POOL_CODES bidirectional map');
assert(__probe.POOL_CODES.forex === 'fx',      'forex -> fx');
assert(__probe.POOL_CODES.synthetics === 'syn','synthetics -> syn');
assert(__probe.POOL_CODES.crypto === 'cry',    'crypto -> cry');
assert(__probe.codeToPool('fx') === 'forex',   'fx -> forex');
assert(__probe.codeToPool('syn') === 'synthetics','syn -> synthetics');
assert(__probe.codeToPool('cry') === 'crypto', 'cry -> crypto');
assert(__probe.codeToPool('zzz') === null,     'unknown code -> null');
assert(__probe.poolToCode('nonsense') === null,'unknown pool -> null');

console.log('\n[2] Catalogs include verified Deriv IDs');
assert(__probe.SYMBOL_CATALOG_CRYPTO.length === 2,'crypto catalog has 2 entries');
assert(__probe.SYMBOL_CATALOG_CRYPTO.includes('cryBTCUSD'),'crypto catalog has cryBTCUSD');
assert(__probe.SYMBOL_CATALOG_CRYPTO.includes('cryETHUSD'),'crypto catalog has cryETHUSD');
assert(__probe.SYMBOL_CATALOG_FOREX.includes('frxXAUUSD'),'forex catalog includes XAUUSD (gold)');
assert(__probe.SYMBOL_CATALOG_FOREX.includes('frxXAGUSD'),'forex catalog includes XAGUSD (silver)');
assert(__probe.SYMBOL_CATALOG_FOREX.includes('frxXPTUSD'),'forex catalog includes XPTUSD (platinum)');
assert(__probe.SYMBOL_CATALOG_FOREX.includes('frxXPDUSD'),'forex catalog includes XPDUSD (palladium)');

console.log('\n[3] 24/7 classification matches reality');
assert(__probe.isPool24x7('crypto') === true,    'crypto is 24/7');
assert(__probe.isPool24x7('synthetics') === true,'synthetics are 24/7');
assert(__probe.isPool24x7('forex') === false,    'forex has weekly hours');

console.log('\n[4] KB.symbolsHome renders Crypto button + CRY toggle');
const cfg = {
    symbols: {
        forex: { frxEURUSD: true, frxXAUUSD: true },
        synthetics: { R_100: true },
        crypto: { cryBTCUSD: true, cryETHUSD: false },
    },
    frx_enabled: true, syn_enabled: true, cry_enabled: false,
};
const home = __probe.KB.symbolsHome(cfg);
const homeFlat = JSON.stringify(home);
assert(homeFlat.includes('set:symbols:cry'),'home keyboard has crypto sub-route');
assert(homeFlat.includes('cry_toggle'),     'home keyboard has cry_toggle button');
assert(homeFlat.includes('set:symbols:fx'), 'home keyboard still has forex sub-route');
assert(homeFlat.includes('set:symbols:syn'),'home keyboard still has synthetics sub-route');
assert(homeFlat.includes('Enable CRY gate'),'cry_enabled=false -> shows Enable label');

console.log('\n[5] KB.symbolsList wires per-pool short codes correctly');
for (const pool of ['forex','synthetics','crypto']) {
    const code = __probe.POOL_CODES[pool];
    const ks = JSON.stringify(__probe.KB.symbolsList(cfg, pool));
    assert(ks.includes(`sym:add:${code}`),   `${pool}: Add button uses sym:add:${code}`);
    assert(ks.includes(`sym:rm:${code}`),    `${pool}: Remove button uses sym:rm:${code}`);
    assert(ks.includes(`symtog:${pool}:`),   `${pool}: per-symbol toggle uses symtog:${pool}:<sym>`);
}

console.log('\n[6] KB.symbolsAdd uses correct catalog for each pool');
for (const [pool, catKey] of [['forex','SYMBOL_CATALOG_FOREX'],
                              ['synthetics','SYMBOL_CATALOG_SYN'],
                              ['crypto','SYMBOL_CATALOG_CRYPTO']]) {
    const have = (cfg.symbols && cfg.symbols[pool]) || {};
    const ks = JSON.stringify(__probe.KB.symbolsAdd(cfg, pool));
    // At least one catalog entry NOT in `have` should appear as symadd:<pool>:<sym>
    const catalog = __probe[catKey];
    const expectAvail = catalog.filter(s => !Object.prototype.hasOwnProperty.call(have, s));
    if (expectAvail.length > 0) {
        const sample = expectAvail[0];
        assert(ks.includes(`symadd:${pool}:${sample}`),
            `${pool}: Add picker offers ${sample}`);
    } else {
        assert(ks.includes('catalog exhausted'),
            `${pool}: catalog exhausted shown when nothing left to add`);
    }
}

console.log('\n[7] renderSymbolsHome / renderMenu surface crypto');
const homeTxt = __probe.renderSymbolsHome(cfg);
assert(homeTxt.includes('Crypto'),     'symbols home text mentions Crypto');
assert(homeTxt.includes('24/7'),       'symbols home text mentions 24/7');
assert(homeTxt.includes('CRY gate'),   'symbols home text mentions CRY gate');
assert(homeTxt.includes('weekends'),   'symbols home text mentions weekend closure (forex)');

const menuTxt = __probe.renderMenu(cfg, { balance: 100 });
assert(menuTxt.includes('CRY'),        'main menu summary includes CRY');
assert(/CRY\s+\d+\/\d+/.test(menuTxt), 'main menu shows CRY enabled/total count');

console.log('\n[8] renderSymbolsPoolHeader reflects gate + hours per pool');
const hFx  = __probe.renderSymbolsPoolHeader(cfg, 'forex');
const hSyn = __probe.renderSymbolsPoolHeader(cfg, 'synthetics');
const hCry = __probe.renderSymbolsPoolHeader(cfg, 'crypto');
assert(hFx.includes('weekly hours'), 'forex header notes weekly hours');
assert(hSyn.includes('24/7'),        'synthetics header notes 24/7');
assert(hCry.includes('24/7'),        'crypto header notes 24/7');
assert(hCry.includes('⛔ OFF'),       'crypto header reflects cry_enabled=false');

console.log('\n[9] KB.chartSymbol surfaces enabled crypto symbols when gate ON');
const cfgCryOn = JSON.parse(JSON.stringify(cfg));
cfgCryOn.cry_enabled = true;
const chartKb = JSON.stringify(__probe.KB.chartSymbol(cfgCryOn));
assert(chartKb.includes('cryBTCUSD'),  'chart picker includes cryBTCUSD when cry_enabled and the symbol is on');
assert(!chartKb.includes('cryETHUSD'), 'chart picker excludes disabled cryETHUSD');

console.log('\n' + (ok ? '\x1b[32mALL OK\x1b[0m' : '\x1b[31mFAIL\x1b[0m'));
process.exit(ok ? 0 : 1);
