#!/usr/bin/env node
/* smoke-key-registry-fix.js
 *
 * Regression test for the "AI providers exhausted: No AI providers
 * configured with keys" bug shown in the Telegram screenshot.
 *
 * Repro context: the user has registered Gemini keys in
 * `config.ai.key_registry` and OpenAI keys in
 * `config.ai.providers[].key_registry` (exactly as SETUP.md instructs),
 * but `config.ai.providers[].keys` is left empty. The old code only
 * looked at `keys[]`, so it threw "No AI providers configured with keys"
 * even though valid keys were registered and exported to env.
 *
 * Expected after fix:
 *   • askDecision MUST find the keys via key_registry / top-level
 *     key_registry and dispatch to a provider.
 *   • _preflightKeyCheck MUST report keys as "resolvable" when env is set.
 */
'use strict';

const assert = require('assert');
const AIClient = require('../ai-client.js');
const Logger = require('../logger.js');

let passed = 0, failed = 0;
function ok(name, cond, detail) {
    if (cond) { passed++; console.log(' OK   ' + name); }
    else { failed++; console.error(' FAIL ' + name + (detail ? '  ' + JSON.stringify(detail) : '')); }
}

(async () => {
    // Stub the network: intercept any outbound fetch and return a valid
    // JSON decision so we can verify which provider/key was attempted.
    const origFetch = global.fetch;
    let calls = [];
    global.fetch = async (url, opts) => {
        calls.push({ url, body: opts && opts.body ? JSON.parse(opts.body) : null });
        // Mimic Gemini response shape if the URL hits generativelanguage
        if (String(url).includes('generativelanguage.googleapis.com')) {
            return {
                ok: true, status: 200,
                json: async () => ({
                    candidates: [{ content: { parts: [{ text: '{"action":"hold","rationale":"ok"}' }] } }],
                }),
            };
        }
        // OpenAI-compat shape for everyone else
        return {
            ok: true, status: 200,
            json: async () => ({
                choices: [{ message: { content: '{"action":"hold","rationale":"ok"}' } }],
            }),
        };
    };

    // Capture warnings
    const origWarn = Logger.warn;
    let warns = [];
    Logger.warn = (m, meta) => { warns.push({ m, meta }); };

    // Mirror the real config.json shape: providers have keys=[] but the
    // registry arrays carry the actual env var names.
    const config = {
        ai: {
            model: 'gemini-2.5-flash',
            timeout_ms: 5000,
            providers: [
                {
                    name: 'gemini',
                    model: 'gemini-2.5-flash',
                    enabled: true,
                    keys: [],
                    // No per-provider key_registry — relies on the
                    // top-level one (the SETUP.md flow for Gemini).
                },
                {
                    name: 'openai',
                    model: 'gpt-4o-mini',
                    enabled: true,
                    keys: [],
                    key_registry: ['OPENAI_KEY_1', 'OPENAI_KEY_2'],
                },
            ],
            key_registry: ['GEMINI_KEY_PRIMARY', 'GEMINI_KEY_2'],
        },
    };

    // --- T1: Before any env vars are set, the loop should still BUILD
    // a queue (i.e. no longer throw "No AI providers configured with
    // keys"). It will eventually throw "All AI providers/keys failed"
    // because no env values exist — that is the EXPECTED, distinct error.
    {
        for (const k of ['GEMINI_KEY_PRIMARY','GEMINI_KEY_2','OPENAI_KEY_1','OPENAI_KEY_2']) {
            delete process.env[k];
        }
        try {
            await AIClient.askDecision({
                payload: { test: 1 }, config, state: { ai_keys_bench: {} },
            });
            ok('T1: should have thrown (no env values)', false);
        } catch (e) {
            ok('T1: registry-only config no longer reports "No AI providers configured with keys"',
                !/No AI providers configured with keys/i.test(e.message),
                { err: e.message });
            ok('T1: instead reports the expected "all providers/keys failed"',
                /All AI providers\/keys failed/i.test(e.message),
                { err: e.message });
        }
    }

    // --- T2: With a Gemini env var set, the runner MUST dispatch to
    // Gemini (top-level key_registry resolves through to the gemini
    // provider since config.ai.model starts with "gemini-").
    {
        calls = [];
        process.env.GEMINI_KEY_PRIMARY = 'fake-gemini-key';
        try {
            const r = await AIClient.askDecision({
                payload: { test: 1 }, config, state: { ai_keys_bench: {} },
            });
            ok('T2: askDecision resolved with a decision',
                !!(r && r.decision && r.decision.action === 'hold'), r);
            ok('T2: dispatched to Gemini endpoint',
                calls.some(c => String(c.url).includes('generativelanguage.googleapis.com')),
                { urls: calls.map(c => c.url) });
            ok('T2: keyUsed is GEMINI_KEY_PRIMARY (resolved via top-level key_registry)',
                r && r.keyUsed === 'GEMINI_KEY_PRIMARY', r);
        } catch (e) {
            ok('T2: askDecision succeeded', false, { err: e.message });
        }
        delete process.env.GEMINI_KEY_PRIMARY;
    }

    // --- T3: With only an OpenAI env var set, the runner MUST waterfall
    // past Gemini (no resolvable env) and dispatch to OpenAI using a
    // name from provider.key_registry.
    {
        calls = [];
        process.env.OPENAI_KEY_2 = 'fake-openai-key';
        try {
            const r = await AIClient.askDecision({
                payload: { test: 1 }, config, state: { ai_keys_bench: {} },
            });
            ok('T3: askDecision resolved with a decision',
                !!(r && r.decision && r.decision.action === 'hold'), r);
            ok('T3: dispatched to OpenAI endpoint',
                calls.some(c => String(c.url).includes('api.openai.com')),
                { urls: calls.map(c => c.url) });
            ok('T3: keyUsed is OPENAI_KEY_2 (resolved via provider.key_registry)',
                r && r.keyUsed === 'OPENAI_KEY_2', r);
        } catch (e) {
            ok('T3: askDecision succeeded', false, { err: e.message });
        }
        delete process.env.OPENAI_KEY_2;
    }

    // restore
    Logger.warn = origWarn;
    global.fetch = origFetch;

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})();
