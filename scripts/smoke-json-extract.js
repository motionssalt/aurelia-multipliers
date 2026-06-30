/* Smoke test: verify the shared JSON-extraction tolerance ladder in
   ai-client.js handles every observed wire-format case from the AI
   providers, INCLUDING the reasoning-leak failure mode confirmed from
   OpenRouter + NVIDIA Nemotron 3 Ultra production logs.

   Required cases per the original fix spec:
     (a) clean JSON with nothing else                 → parses
     (b) JSON wrapped in markdown code fences         → parses
     (c) JSON preceded by reasoning/preamble text     → parses
     (d) genuinely malformed / missing JSON           → throws clean

   Regression guards (kept from the previous patch):
     (e) nested objects inside the decision must not be truncated
     (f) braces INSIDE string values must not confuse the brace counter
     (g) preamble + fenced JSON + trailing text                 → parses
     (h) reasoning preamble with a TRAILING non-JSON tail       → parses

   New cases added for the OpenRouter / Nemotron 3 Ultra fix:
     (j)  scratchpad prose with the real JSON object at the END of the
          text (the screenshot failure mode)             — strict path
     (k)  scratchpad prose with NO JSON anywhere         — must still throw
     (l)  multiple balanced {...} blocks where the FIRST one is an
          exploratory "thinking" object and the LAST one is the real
          decision — STRICT parser returns the first (today's
          behaviour), LENIENT parser returns the last decision-shaped
          one (the new behaviour)
     (m)  multiple balanced JSON blocks, NONE of which are decision-
          shaped — lenient parser MUST still throw (we never silently
          accept thought-stream JSON as a trade decision)
     (n)  post-mortem shape { note: "..." } still recognised by the
          lenient decision-shape heuristic
     (o)  drift guard: the helpers exported from ai-client.js are the
          SAME functions exercised by this test (so a future edit to
          one is automatically tested by the other)

   The test imports the real helpers from ai-client.js so this file
   cannot drift from the production implementation.
*/
'use strict';

const path = require('path');
const {
    _stripFences,
    _extractBalancedJsonObject,
    _enumerateBalancedJsonObjects,
    _extractLastBalancedJsonObject,
    _looksLikeDecisionJson,
    _parseJsonStrict,
    _parseJsonLenient,
} = require(path.join(__dirname, '..', 'ai-client.js'));

let pass = 0, fail = 0;
function ok(label, actual, expected) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) { console.log(`[PASS] ${label}`); pass++; }
    else         { console.log(`[FAIL] ${label}\n       expected ${e}\n       actual   ${a}`); fail++; }
}
function throws(label, fn, msgPart) {
    try { fn(); console.log(`[FAIL] ${label} — did not throw`); fail++; }
    catch (e) {
        if (!msgPart || (e.message || '').includes(msgPart)) {
            console.log(`[PASS] ${label} — threw: ${e.message}`); pass++;
        } else {
            console.log(`[FAIL] ${label} — wrong error: ${e.message}`); fail++;
        }
    }
}

/* ─────────────────────────────────────────────────────────────────
   Original test suite (must still pass — strict parser unchanged for
   every provider that doesn't set strict_json:false in config.json).
   ───────────────────────────────────────────────────────────────── */

// (a) clean JSON
ok('(a) clean JSON',
    _parseJsonStrict('{"action":"BUY","symbol":"R_100","confidence":0.82}'),
    { action: 'BUY', symbol: 'R_100', confidence: 0.82 });

// (b) fenced JSON — with language tag
ok('(b1) ```json fenced',
    _parseJsonStrict('```json\n{"action":"SELL","tp":1.5}\n```'),
    { action: 'SELL', tp: 1.5 });

// (b) fenced JSON — plain fence
ok('(b2) ``` plain fence',
    _parseJsonStrict('```\n{"action":"HOLD"}\n```'),
    { action: 'HOLD' });

// (c) reasoning preamble + JSON
const reasoningPreamble =
    'The user wants me to act as AURELIA-Multipliers, an AI decision ' +
    'engine for a Deriv MULTUP/MULTDOWN bot. I need to analyze the ' +
    'market data and return a JSON decision.\n\n' +
    'Here is my decision:\n' +
    '{"action":"BUY","symbol":"R_100","multiplier":100,"stake":1,' +
    '"tp":2.5,"sl":1.2,"confidence":0.78,"rationale":"strong uptrend"}';
ok('(c) reasoning preamble + JSON',
    _parseJsonStrict(reasoningPreamble),
    { action: 'BUY', symbol: 'R_100', multiplier: 100, stake: 1,
      tp: 2.5, sl: 1.2, confidence: 0.78, rationale: 'strong uptrend' });

// (d) genuinely malformed
throws('(d1) no JSON anywhere',
    () => _parseJsonStrict('I cannot help with that request.'),
    'AI returned non-JSON');

throws('(d2) unbalanced braces',
    () => _parseJsonStrict('here is the answer: {"action":"BUY"'),
    'AI returned non-JSON');

// (e) nested objects must NOT be truncated by naive }-matching
ok('(e) nested object preserved',
    _parseJsonStrict(
        'Reasoning: market looks good. Final:\n' +
        '{"action":"BUY","contract":{"type":"MULTUP","mult":100},' +
        '"risk":{"tp":2.5,"sl":1.2}}'
    ),
    { action: 'BUY',
      contract: { type: 'MULTUP', mult: 100 },
      risk:     { tp: 2.5, sl: 1.2 } });

// (f) braces inside string values
ok('(f) braces inside strings',
    _parseJsonStrict(
        'Note:\n' +
        '{"rationale":"price broke { resistance } level","action":"SELL"}'
    ),
    { rationale: 'price broke { resistance } level', action: 'SELL' });

// (g) preamble + fenced JSON + trailing text
ok('(g) preamble + fenced + trailing',
    _parseJsonStrict(
        'Thinking through it...\n' +
        '```json\n{"action":"HOLD","confidence":0.55}\n```\n' +
        'Hope that helps!'
    ),
    { action: 'HOLD', confidence: 0.55 });

// (h) preamble + JSON + trailing prose tail (no fence)
ok('(h) preamble + JSON + trailing prose',
    _parseJsonStrict(
        'I will now emit my decision.\n' +
        '{"action":"BUY","symbol":"R_50","tp":1.8}\n' +
        'That is my final answer.'
    ),
    { action: 'BUY', symbol: 'R_50', tp: 1.8 });

// (i) defensive: empty/non-string inputs
throws('(i1) empty string',  () => _parseJsonStrict(''),    'AI returned non-JSON');
throws('(i2) null input',    () => _parseJsonStrict(null),  'AI returned non-JSON');

/* ─────────────────────────────────────────────────────────────────
   NEW cases for the OpenRouter / Nemotron 3 Ultra reasoning-leak fix.
   ───────────────────────────────────────────────────────────────── */

// (j) The actual production failure mode (verbatim shape from the
//     Telegram alert screenshots) — long scratchpad followed by a
//     clean JSON object at the very end. STRICT parser must already
//     handle this via _extractBalancedJsonObject; LENIENT parser must
//     also handle it and pick the same answer.
const nemotronLeak =
    "The user wants me to act as AURELIA-Multipliers, an AI decision\n" +
    "engine for a Deriv MULTUP/MULTDOWN bot. I need to analyze the\n" +
    "market data given in TICK INPUT and return a JSON decision.\n\n" +
    "Let me think about this. The current symbol is R_100. The M5 RSI\n" +
    "is 47, MACD histogram is slightly negative, Bollinger %B is 0.45\n" +
    "(mid-band), EMA20 is below EMA50 — overall there is no strong\n" +
    "directional edge here. The right call is to hold and wait for\n" +
    "a clearer setup. Let me format the response now.\n\n" +
    "Final answer:\n" +
    '{"action":"hold","decision_id":"dec-7f02b1","rationale":' +
    '"R_100 M5 RSI 47 neutral, MACD_hist slightly negative, BB %B 0.45 ' +
    'mid-band, EMA20<EMA50 — no clear edge","confidence":0.5}';
ok('(j-strict) reasoning leak + JSON at end (strict)',
    _parseJsonStrict(nemotronLeak),
    { action: 'hold', decision_id: 'dec-7f02b1',
      rationale: 'R_100 M5 RSI 47 neutral, MACD_hist slightly negative, BB %B 0.45 mid-band, EMA20<EMA50 — no clear edge',
      confidence: 0.5 });
ok('(j-lenient) reasoning leak + JSON at end (lenient)',
    _parseJsonLenient(nemotronLeak),
    { action: 'hold', decision_id: 'dec-7f02b1',
      rationale: 'R_100 M5 RSI 47 neutral, MACD_hist slightly negative, BB %B 0.45 mid-band, EMA20<EMA50 — no clear edge',
      confidence: 0.5 });

// (k) Scratchpad prose with NO JSON anywhere — both parsers MUST
//     throw. This is the case where the model never finishes its
//     reasoning and the request must fall through to the next
//     provider, NOT silently degrade to a bad trade.
const noJsonScratchpad =
    "The user wants me to act as AURELIA-Multipliers. I need to analyze " +
    "the market and return JSON. Let me think... The RSI looks neutral, " +
    "MACD is flat, no clear edge. I am still considering whether to " +
    "hold or skip. Hmm, this is hard. Let me re-read the prompt...";
throws('(k-strict) reasoning leak, NO JSON (strict throws)',
    () => _parseJsonStrict(noJsonScratchpad),
    'AI returned non-JSON');
throws('(k-lenient) reasoning leak, NO JSON (lenient throws)',
    () => _parseJsonLenient(noJsonScratchpad),
    'AI returned non-JSON');

// (l) Multiple balanced JSON blocks: an exploratory thought object
//     FIRST, then the real decision LAST. This is the case where the
//     strict parser (which always returns the FIRST balanced block)
//     would return the wrong thing — the lenient parser must walk to
//     the last decision-shaped block.
const multipleBlocks =
    "Let me draft a possible response:\n" +
    '{"thought":"maybe I should buy R_100 here, RSI is fine"}\n' +
    "Wait, on second thought, the trend is weakening. Let me reconsider.\n" +
    "Final decision:\n" +
    '{"action":"hold","decision_id":"dec-final","rationale":' +
    '"RSI 47 mid, EMA20<EMA50 — no edge","confidence":0.6}';
// Strict parser sees the first balanced block as valid JSON and returns
// it as-is (today's behaviour — we intentionally do NOT change strict).
ok('(l-strict) multi-block: strict returns FIRST',
    _parseJsonStrict(multipleBlocks),
    { thought: 'maybe I should buy R_100 here, RSI is fine' });
// Lenient parser must pick the LAST decision-shaped block.
ok('(l-lenient) multi-block: lenient picks LAST decision-shaped',
    _parseJsonLenient(multipleBlocks),
    { action: 'hold', decision_id: 'dec-final',
      rationale: 'RSI 47 mid, EMA20<EMA50 — no edge',
      confidence: 0.6 });

// (m) Multiple balanced JSON blocks, NONE of which look like a
//     decision (no `action` field, no `note`). Lenient parser MUST
//     still throw — we are NOT in the business of accepting random
//     thought-stream JSON as a trade decision. The waterfall must
//     still fall through.
const multipleNonDecisionBlocks =
    "Let me draft what I'm thinking:\n" +
    '{"thought":"maybe consider R_100"}\n' +
    "And another note:\n" +
    '{"observation":"market is choppy","mood":"unsure"}\n' +
    "I cannot reach a conclusion yet.";
throws('(m) multi-block, none decision-shaped → lenient throws',
    () => _parseJsonLenient(multipleNonDecisionBlocks),
    'AI returned non-JSON');

// (n) Post-mortem shape — { note: "..." } — must still be recognised
//     by the lenient decision-shape heuristic. The askPostMortem flow
//     also routes through this parser.
const postMortemLeak =
    "Thinking about why this trade lost...\n" +
    "The MACD had already rolled over before entry; RSI was overbought.\n" +
    'Final:\n{"note":"MACD bearish cross 5 bars pre-entry; RSI 78 overbought."}';
ok('(n) post-mortem shape recognised by lenient',
    _parseJsonLenient(postMortemLeak),
    { note: 'MACD bearish cross 5 bars pre-entry; RSI 78 overbought.' });

// (o) Drift guard: confirm the helpers we exercised are the real ones
//     from ai-client.js and not local copies.
ok('(o) drift guard: lenient and strict are distinct functions',
    _parseJsonLenient !== _parseJsonStrict,
    true);

// (p) Heuristic spot-checks for _looksLikeDecisionJson.
ok('(p1) BUY → decision-shaped',
    _looksLikeDecisionJson({ action: 'BUY', symbol: 'R_100' }), true);
ok('(p2) hold → decision-shaped',
    _looksLikeDecisionJson({ action: 'hold', decision_id: 'x' }), true);
ok('(p3) multi → decision-shaped',
    _looksLikeDecisionJson({ action: 'multi', multi: { close: [] } }), true);
ok('(p4) action=random → NOT decision-shaped',
    _looksLikeDecisionJson({ action: 'frobnicate' }), false);
ok('(p5) no action, no note → NOT decision-shaped',
    _looksLikeDecisionJson({ thought: 'hmm', confidence: 0.9 }), false);
ok('(p6) note string → decision-shaped (post-mortem)',
    _looksLikeDecisionJson({ note: 'why it lost' }), true);
ok('(p7) array → NOT decision-shaped',
    _looksLikeDecisionJson(['action', 'BUY']), false);
ok('(p8) null → NOT decision-shaped',
    _looksLikeDecisionJson(null), false);

// (q) _enumerateBalancedJsonObjects basic behaviour.
ok('(q1) enumerate empty',
    _enumerateBalancedJsonObjects(''), []);
ok('(q2) enumerate one',
    _enumerateBalancedJsonObjects('pre {"a":1} post'),
    ['{"a":1}']);
ok('(q3) enumerate two',
    _enumerateBalancedJsonObjects('pre {"a":1} mid {"b":2} post'),
    ['{"a":1}', '{"b":2}']);
ok('(q4) enumerate skips unbalanced tail',
    _enumerateBalancedJsonObjects('{"a":1} then {"unfinished":'),
    ['{"a":1}']);
ok('(q5) _extractLastBalancedJsonObject picks last',
    _extractLastBalancedJsonObject('pre {"a":1} mid {"b":2} post'),
    '{"b":2}');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
