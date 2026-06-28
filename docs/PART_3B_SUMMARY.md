# AURELIA-Multipliers — Part 3b Summary

**Scope:** New symbol categories (Crypto, plus gold/metals via existing forex pool)
with full settings-menu parity. Touches **only** `config.json` and `worker/index.js`.

---

## 1. Verified Deriv symbol IDs (live, via `wss://ws.derivws.com/websockets/v3?app_id=1089`, `active_symbols` + `contracts_for`)

### Crypto (new category, full parity)
Deriv's `cryptocurrency` market currently exposes exactly **2** symbols, both
`cry`-prefixed in the `non_stable_coin` submarket:

| Symbol ID    | Display    | Market         | Multiplier support | Hours |
|--------------|------------|----------------|--------------------|-------|
| `cryBTCUSD`  | BTC/USD    | cryptocurrency | ✅ yes              | 24/7  |
| `cryETHUSD`  | ETH/USD    | cryptocurrency | ✅ yes              | 24/7  |

Both confirmed `exchange_is_open=1` on a weekend → genuinely 24/7. Multipliers
verified available via `contracts_for: cryBTCUSD`. These are the only two
entries in `SYMBOL_CATALOG_CRYPTO`.

### Stocks/commodities — finding on gold (XAUUSD)
The user asked specifically for XAUUSD. Live verification:

| Symbol ID    | Display       | Market      | Submarket | Multiplier | Hours    |
|--------------|---------------|-------------|-----------|------------|----------|
| `frxXAUUSD`  | Gold/USD      | commodities | metals    | ✅ yes      | weekly   |
| `frxXAGUSD`  | Silver/USD    | commodities | metals    | ✅ yes      | weekly   |
| `frxXPTUSD`  | Platinum/USD  | commodities | metals    | ✅ yes      | weekly   |
| `frxXPDUSD`  | Palladium/USD | commodities | metals    | ✅ yes      | weekly   |

**Crucially: gold (and all metals) uses the `frx` prefix.** Per the spec's
explicit guidance — "if gold is already `frx`-prefixed and reachable via the
existing forex category, don't create a redundant duplicate entry for it
elsewhere — just make sure it's enabled/available there" — and because
`runner.js`'s `isSymbolEnabled()` treats any non-synthetic symbol as forex
(via `isSyntheticSymbol(sym) → false → fallback to fx[sym]`), creating a
separate `commodities` pool would silently break runner gating for these
symbols. **Therefore: no separate stocks/commodities category was added.**
The 4 metals were added to `SYMBOL_CATALOG_FOREX` (`frxXAUUSD` was also
enabled by default in `config.symbols.forex`, satisfying the user's
explicit XAUUSD ask).

**Stock indices** (`OTC_SPC`, `OTC_NDX`, `OTC_DJI`, `OTC_GDAXI`, `OTC_FTSE`,
`OTC_N225`, `OTC_HSI`, etc. — 12 total) were checked and **deliberately
excluded** because their `contracts_for` response shows
`categories=callput,endsinout,staysinout,touchnotouch` — **no `multiplier`
category**. This bot's engine is `"multipliers"` (per `config.cycle.engine`),
so these symbols are simply not tradeable by it. Conservative exclusion per
spec ("don't include instruments you can't verify are real/tradeable" — they
are real, but not tradeable by this engine).

---

## 2. New config field names

Exactly **one** new top-level field (mirrors the existing `frx_enabled` /
`syn_enabled` naming convention):

- `cry_enabled` (boolean, defaults to `false` if absent — same default
  semantics as `syn_enabled`; existing operators must opt-in)

Plus one new nested pool bucket under `config.symbols`:

- `config.symbols.crypto = { cryBTCUSD: true, cryETHUSD: true }`

And one symbol was enabled inside the existing forex pool:

- `config.symbols.forex.frxXAUUSD = true` (the user's explicit XAU ask)

The other metals (`frxXAGUSD`, `frxXPTUSD`, `frxXPDUSD`) were added to the
**catalog** (available via Add picker) but **not** auto-enabled in config —
the operator can flip them on at will. Conservative default: don't enable
instruments the user didn't explicitly request.

---

## 3. Cross-cutting fix — pool short-code mapping

The old code had `pool === 'forex' ? 'fx' : 'syn'` ternaries in callback-
data construction at multiple sites. Audit before fix turned up **6**
occurrences:

| Line (orig) | Context                                                |
|-------------|--------------------------------------------------------|
| 461         | `sym:add:fx`/`sym:add:syn` route discriminator         |
| 491         | `sym:rm:fx`/`sym:rm:syn` route discriminator           |
| 1147        | `KB.symbolsList` — "(no symbols)" placeholder data     |
| 1149–1150   | `KB.symbolsList` — Add + Remove footer buttons         |
| 1168–1169   | `KB.symbolsAdd` — "catalog exhausted" + Back button    |
| 1184–1185   | `KB.symbolsRemove` — "nothing to remove" + Back button |

Plus 2 string-matching reads at lines 461 and 491:
`data.endsWith('syn') ? 'synthetics' : 'forex'`.

**All 8 occurrences fixed.** Replaced by:

- `POOL_CODES = { forex: 'fx', synthetics: 'syn', crypto: 'cry' }`
- `CODE_TO_POOL` (auto-inverted from `POOL_CODES`)
- `POOL_CATALOGS` (pool → catalog array)
- `POOL_LABELS` (pool → human-readable label)
- `poolToCode(pool)` / `codeToPool(code)` helpers

Plus a small `ensureSymbolPools(cfg)` helper that idempotently creates the
per-pool `cfg.symbols.<pool>` buckets, so symbol-add/symtog/symrm handlers
no longer need to inline `cfg.symbols = cfg.symbols || { forex:{}, synthetics:{} }`
(adding a 4th pool would have required updating 4 sites; now one).

Verified post-fix:

```
$ grep -nE "pool === 'forex'|['\"]fx['\"][[:space:]]*:[[:space:]]*['\"]syn['\"]|data\.endsWith" worker/index.js
75:   Replaces the old `pool === 'forex' ? 'fx' : 'syn'` ternaries that
912:    if (pool === 'forex')           gate = (cfg.frx_enabled !== false);
917:    const icon = pool === 'forex' ? '📡' : pool === 'crypto' ? '₿' : '🎲';
```

The three remaining matches are: (75) the migration comment; (912) a
three-way per-pool gate selector in `renderSymbolsPoolHeader` (legitimately
per-pool, not a 2-way hack); (917) a three-way per-pool icon picker.
**No 2-way `forex`/`fx`-`syn` mapping remains.** `data.endsWith(...)` for
pool decoding: zero matches.

---

## 4. Full settings-menu parity for the new Crypto category

| Component                              | Status |
|----------------------------------------|--------|
| Master-gate config field (`cry_enabled`) | ✅      |
| Toggle handler (`cry_toggle`, mirrors `frx_toggle`/`syn_toggle`) | ✅ |
| `/cry on\|off` slash command (mirrors `/syn`) | ✅ |
| `symbolsHome` pool-picker button (`set:symbols:cry`) | ✅ |
| `SYMBOL_CATALOG_CRYPTO` catalog array  | ✅      |
| Per-symbol toggle buttons (`symtog:crypto:<sym>`) | ✅ |
| Add picker (`sym:add:cry` → `symadd:crypto:<sym>`) | ✅ |
| Remove picker (`sym:rm:cry` → `symrm:ask:crypto:<sym>` → `symrm:do:crypto:<sym>`) | ✅ |
| Chart picker (`KB.chartSymbol`) lists enabled crypto symbols when `cry_enabled` | ✅ |
| `renderMenu` / `renderSymbolsHome` / `renderSymbolsPoolHeader` show crypto counts + gate state + 24/7 hours note | ✅ |

### Session-gating distinction (24/7 vs weekly hours)

Per spec: "crypto trades 24/7, unlike forex which has weekend closures —
verify and implement this distinction rather than reusing forex's gating
logic unchanged."

Findings:

- Live verification on a weekend showed `cryBTCUSD.exchange_is_open=1`
  (open) and `frxXAUUSD.exchange_is_open=0` (closed) — confirms the
  distinction is real.
- The existing worker code doesn't actually implement weekend-closure
  gating directly — it trusts Deriv's `exchange_is_open` (handled in
  `runner.js`, out of scope here). So there was no forex weekend-gating
  logic to copy-paste unchanged for crypto.
- What the worker **does** surface is the master-gate semantics in the
  menu UI. To make the 24/7-vs-weekly distinction visible and unambiguous,
  Part 3b added:
  - `isPool24x7(pool)` helper (returns `true` for crypto + synthetics,
    `false` for forex/metals).
  - `renderSymbolsPoolHeader(cfg, pool)` shows the appropriate
    `Hours: 24/7` or `Hours: weekly hours (closed weekends)` line.
  - `renderSymbolsHome(cfg)` lists each pool's hours convention next to
    its count, plus a footnote explaining that metals share the forex
    weekly-hours convention.

This is the minimal correct treatment given the spec's "configuration/menu
concern only" constraint — no runner-side logic was touched.

---

## 5. Files modified

- `config.json` — added `crypto` pool, added `frxXAUUSD` to forex pool,
  added `cry_enabled: false` top-level field.
- `worker/index.js` — added catalogs, POOL_CODES table, `cry_toggle`
  handler, `/cry` slash command, `set:symbols:cry` route, generalised
  add/remove/toggle handlers, `renderSymbolsPoolHeader` helper,
  crypto-aware `renderMenu` / `renderSymbolsHome` / `KB.symbolsHome` /
  `KB.symbolsList` / `KB.symbolsAdd` / `KB.symbolsRemove` /
  `KB.chartSymbol`.
- `scripts/smoke-pool-menu.js` — non-test-suite smoke script (36
  assertions) that re-loads the worker source and inspects POOL_CODES /
  catalog wiring / keyboard generation without spinning up
  Cloudflare/Telegram/GitHub. Run with `node scripts/smoke-pool-menu.js`
  — all 36 assertions pass.

**Out of scope (intentionally untouched):** `chart.js`, `runner.js` (cycle
logic / `selectSymbol` / `isSymbolEnabled` — the runner-side acceptance of
the new pool is a separate change), `telegram.js`, AI decision schema.
A future part can wire the runner's `isSymbolEnabled` to recognise
`/^cry/` symbols + the `cry_enabled` gate; the worker side is ready.
