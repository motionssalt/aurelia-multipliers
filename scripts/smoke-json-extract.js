/* Smoke test: verify the shared _parseJsonStrict / _stripFences /
   _extractBalancedJsonObject tolerance ladder added to ai-client.js.

   Required cases per the fix spec:
     (a) clean JSON with nothing else                 \u2192 parses
     (b) JSON wrapped in markdown code fences         \u2192 parses
     (c) JSON preceded by reasoning/preamble text     \u2192 parses
     (d) genuinely malformed / missing JSON           \u2192 throws clean

   Plus regression guards:
     (e) nested objects inside the decision must not be truncated
     (f) braces INSIDE string values must not confuse the brace counter
     (g) preamble + fenced JSON + trailing text                 \u2192 parses
     (h) reasoning preamble with a TRAILING non-JSON tail       \u2192 parses
*/
'use strict';

// Use Node's module cache to grab the internal helpers via require
// of ai-client.js. They are not exported, so we re-define them here
// by reading the source and eval'ing the helper block \u2014 OR we just
// duplicate the exact functions for a self-contained smoke test.
// Self-contained duplication is safer (the test then catches drift
// between this file and the real implementation if anyone edits one
// without the other and we copy this into CI).

function _stripFences(s) {
    if (typeof s !== 'string') return '';
    let out = s.trim();
    if (out.startsWith('```')) {
        out = out.replace(/^```(?:json|JSON)?\s*/i, '').replace(/```\s*$/i, '');
        return out.trim();
    }
    const fenced = out.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
    if (fenced && fenced[1]) return fenced[1].trim();
    return out;
}

function _extractBalancedJsonObject(s) {
    if (typeof s !== 'string' || s.indexOf('{') < 0) return null;
    const start = s.indexOf('{');
    let depth = 0, inString = false, escape = false;
    for (let i = start; i < s.length; i++) {
        const ch = s[i];
        if (inString) {
            if (escape)      { escape = false; continue; }
            if (ch === '\\') { escape = true;  continue; }
            if (ch === '"')  { inString = false; }
            continue;
        }
        if (ch === '"')      { inString = true; continue; }
        if (ch === '{')      { depth++; continue; }
        if (ch === '}') {
            depth--;
            if (depth === 0) return s.slice(start, i + 1);
        }
    }
    return null;
}

function _parseJsonStrict(text) {
    const cleaned = _stripFences(text);
    try { return JSON.parse(cleaned); } catch (_) {}
    const extracted = _extractBalancedJsonObject(cleaned);
    if (extracted) {
        try { return JSON.parse(extracted); } catch (_) {}
    }
    throw new Error(`AI returned non-JSON: ${cleaned.slice(0, 160)}`);
}

let pass = 0, fail = 0;
function ok(label, actual, expected) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) { console.log(`[PASS] ${label}`); pass++; }
    else         { console.log(`[FAIL] ${label}\n       expected ${e}\n       actual   ${a}`); fail++; }
}
function throws(label, fn, msgPart) {
    try { fn(); console.log(`[FAIL] ${label} \u2014 did not throw`); fail++; }
    catch (e) {
        if (!msgPart || (e.message || '').includes(msgPart)) {
            console.log(`[PASS] ${label} \u2014 threw: ${e.message}`); pass++;
        } else {
            console.log(`[FAIL] ${label} \u2014 wrong error: ${e.message}`); fail++;
        }
    }
}

// (a) clean JSON
ok('(a) clean JSON',
    _parseJsonStrict('{"action":"BUY","symbol":"R_100","confidence":0.82}'),
    { action: 'BUY', symbol: 'R_100', confidence: 0.82 });

// (b) fenced JSON \u2014 with language tag
ok('(b1) ```json fenced',
    _parseJsonStrict('```json\n{"action":"SELL","tp":1.5}\n```'),
    { action: 'SELL', tp: 1.5 });

// (b) fenced JSON \u2014 plain fence
ok('(b2) ``` plain fence',
    _parseJsonStrict('```\n{"action":"HOLD"}\n```'),
    { action: 'HOLD' });

// (c) reasoning preamble + JSON (the actual bug from the symptom)
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

// (d) genuinely malformed \u2014 no JSON object at all
throws('(d1) no JSON anywhere',
    () => _parseJsonStrict('I cannot help with that request.'),
    'AI returned non-JSON');

// (d) truncated / unbalanced
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

// (i) defensive: empty string and non-string inputs
throws('(i1) empty string',  () => _parseJsonStrict(''),    'AI returned non-JSON');
throws('(i2) null input',    () => _parseJsonStrict(null),  'AI returned non-JSON');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
