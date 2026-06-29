#!/usr/bin/env node
/* smoke-ai-provider-fallback.js
 *
 * Issue #2: AI provider fallback (Gemini → OpenAI) never actually triggers.
 * The bug: config.json key_registry names didn't match real env var names
 * exported by the workflow, so OpenAI was silently skipped every time.
 *
 * Coverage:
 *   F1. openai provider skipped with warning when key_registry env is NOT set.
 *   F2. openai provider IS invoked when key_registry env IS set, and result
 *       is returned correctly.
 *   F3. preflight check logs warning for provider with no resolvable keys.
 *   F4. cloudflare provider fails with clear error when key_accounts entry
 *       is missing (gets flagged rather than crashing the loop).
 *   F5. cloudflare provider routes through _callOpenAICompat with correct
 *       account-ID-injected endpoint when key + key_accounts pair is valid.
 */
'use strict';

const assert = require('assert');
const AIClient = require('../ai-client.js');

let passed = 0, failed = 0;
function ok(name, cond, detail) {
    if (cond) { passed++; console.log(' OK   ' + name); }
    else {
        failed++;
        console.error(' FAIL ' + name + (detail ? '  ' + JSON.stringify(detail) : ''));
    }
}

// Override Logger.warn so we can capture warnings.
const Logger = require('../logger.js');
const originalWarn = Logger.warn;
let capturedWarns = [];
function captureWarn(msg, meta) { capturedWarns.push({ msg, meta }); }

(async () => {
    // Save original env vars.
    const origOpenaiKey = process.env.OPENAI_API_KEY;
    const origOpenaiKey1 = process.env.OPENAI_KEY_1;
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_KEY_1;

    // F1: openai skipped when env not set.
    {
        capturedWarns = [];
        Logger.warn = captureWarn;

        const config = {
            ai: {
                key_registry: [], // empty so Gemini stage is skipped
                bench_minutes: 1,
                timeout_ms: 5000,
                providers: [
                    {
                        name: 'openai',
                        key_env: 'OPENAI_API_KEY',
                        model: 'gpt-4o-mini',
                        enabled: true,
                        key_registry: ['OPENAI_KEY_NONEXISTENT'],
                    },
                ],
            },
        };
        const state = { ai_keys_bench: {} };

        try {
            await AIClient.askDecision({ payload: { test: true }, config, state });
            ok('F1: should have thrown (no providers usable)', false);
        } catch (e) {
            ok('F1: throws "all providers/keys failed"',
                /all ai providers\/keys failed/i.test(e.message),
                { error: e.message });
        }

        // The preflight warning should have been logged.
        const preflightWarn = capturedWarns.find(w =>
            /OPENAI_KEY_NONEXISTENT/.test(w.msg)
        );
        ok('F1: preflight warning logged for missing key env',
            !!preflightWarn,
            { captured: capturedWarns.map(w => w.msg) });

        Logger.warn = originalWarn;
    }

    // F2: openai invoked successfully when env IS set.
    {
        capturedWarns = [];
        // We can't actually call OpenAI, but we CAN verify the provider path
        // is attempted by monkeypatching _callOpenAICompat.
        const origCallOpenAICompat = AIClient.__proto__ ? null : null;
        // _callOpenAICompat is a module-local function — use a side-channel:
        // temporarily set a fake key and intercept the fetch.
        process.env.OPENAI_API_KEY = 'sk-fake-test-key-12345';

        let openAICalled = false;
        let openAIArgs = null;

        // Monkeypatch the module's internal by going through the public surface.
        // We'll intercept at the _callProvider level by temporarily replacing
        // the exported askDecision and using the module's internals.
        // Simpler: we patch global.fetch to capture the outgoing request.
        const originalFetch = global.fetch;
        global.fetch = async (url, opts) => {
            if (url.includes('api.openai.com')) {
                openAICalled = true;
                openAIArgs = { url, body: opts.body ? JSON.parse(opts.body) : null };
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        choices: [{ message: { content: '{"action":"hold","rationale":"test"}' } }],
                    }),
                };
            }
            return originalFetch ? originalFetch(url, opts) : { ok: false, status: 500 };
        };

        const config = {
            ai: {
                key_registry: [], // skip Gemini stage
                bench_minutes: 1,
                timeout_ms: 5000,
                providers: [
                    {
                        name: 'openai',
                        key_env: 'OPENAI_API_KEY',
                        model: 'gpt-4o-mini',
                        enabled: true,
                        key_registry: ['OPENAI_API_KEY'],
                    },
                ],
            },
        };
        const state = { ai_keys_bench: {} };

        try {
            const result = await AIClient.askDecision({ payload: { test: true }, config, state });
            ok('F2: OpenAI provider path was invoked', openAICalled, { openAIArgs });
            ok('F2: decision returned correctly',
                result && result.decision && result.decision.action === 'hold',
                result);
        } catch (e) {
            ok('F2: OpenAI call succeeded', false, { error: e.message });
        }

        global.fetch = originalFetch;
        Logger.warn = originalWarn;
    }

    // F3: preflight check warns for provider with no resolvable keys.
    {
        capturedWarns = [];
        Logger.warn = captureWarn;
        delete process.env.OPENAI_API_KEY;

        const config = {
            ai: {
                key_registry: [],
                bench_minutes: 1,
                timeout_ms: 5000,
                providers: [
                    {
                        name: 'openai',
                        key_env: 'OPENAI_API_KEY',
                        model: 'gpt-4o-mini',
                        enabled: true,
                        key_registry: ['OPENAI_KEY_FAKE'],
                    },
                    {
                        name: 'grok',
                        key_env: 'XAI_API_KEY',
                        model: 'grok-2-latest',
                        enabled: true,
                        key_registry: ['XAI_KEY_FAKE'],
                    },
                ],
            },
        };
        const state = { ai_keys_bench: {} };

        try {
            await AIClient.askDecision({ payload: { test: true }, config, state });
        } catch (e) { /* expected — all providers fail */ }

        const openaiWarn = capturedWarns.find(w =>
            /openai.*key_registry.*NONE resolvable/i.test(w.msg)
        );
        const grokWarn = capturedWarns.find(w =>
            /grok.*key_registry.*NONE resolvable/i.test(w.msg)
        );

        ok('F3: preflight warns for openai with no resolvable keys',
            !!openaiWarn, { captured: capturedWarns.map(w => w.msg) });
        ok('F3: preflight warns for grok with no resolvable keys',
            !!grokWarn, { captured: capturedWarns.map(w => w.msg) });

        Logger.warn = originalWarn;
    }

    // F4: cloudflare fails clearly when key_accounts entry is missing.
    {
        capturedWarns = [];
        Logger.warn = captureWarn;
        process.env.CLOUDFLARE_KEY_1 = 'cf-fake-token-abc';

        const config = {
            ai: {
                key_registry: [], // skip Gemini stage
                bench_minutes: 1,
                timeout_ms: 5000,
                providers: [
                    {
                        name: 'cloudflare',
                        enabled: true,
                        model: '@cf/openai/gpt-oss-120b',
                        keys: ['CLOUDFLARE_KEY_1'],
                        // NOTE: intentionally NO key_accounts map
                    },
                ],
            },
        };
        const state = { ai_keys_bench: {} };

        try {
            await AIClient.askDecision({ payload: { test: true }, config, state });
            ok('F4: should have thrown (missing key_accounts)', false);
        } catch (e) {
            ok('F4: throws "all providers/keys failed"',
                /all ai providers\/keys failed/i.test(e.message),
                { error: e.message });
        }

        // The key should have been flagged (benchMap entry created)
        ok('F4: missing key_accounts causes key to be flagged',
            state.ai_keys_bench['CLOUDFLARE_KEY_1'] > 0,
            { benchMap: state.ai_keys_bench });

        // The error message should mention key_accounts clearly — it's in
        // the `error` meta of the "flagged" warning.
        const flagWarn = capturedWarns.find(w =>
            /key_accounts/.test(w.msg) ||
            (w.meta && w.meta.error && /key_accounts/.test(w.meta.error))
        );
        ok('F4: warning/error mentions key_accounts',
            !!flagWarn,
            { captured: capturedWarns.map(w => ({ msg: w.msg, meta: w.meta })) });

        delete process.env.CLOUDFLARE_KEY_1;
        Logger.warn = originalWarn;
    }

    // F5: cloudflare routes through _callOpenAICompat with correct endpoint.
    {
        capturedWarns = [];
        process.env.CLOUDFLARE_KEY_1 = 'cf-fake-token-xyz';

        let cloudflareCalled = false;
        let cloudflareUrl = null;

        const originalFetch = global.fetch;
        global.fetch = async (url, opts) => {
            if (url.includes('api.cloudflare.com')) {
                cloudflareCalled = true;
                cloudflareUrl = url;
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        choices: [{ message: { content: '{"action":"hold","rationale":"test"}' } }],
                    }),
                };
            }
            return originalFetch ? originalFetch(url, opts) : { ok: false, status: 500 };
        };

        const config = {
            ai: {
                key_registry: [], // skip Gemini stage
                bench_minutes: 1,
                timeout_ms: 5000,
                providers: [
                    {
                        name: 'cloudflare',
                        enabled: true,
                        model: '@cf/openai/gpt-oss-120b',
                        keys: ['CLOUDFLARE_KEY_1'],
                        key_accounts: {
                            CLOUDFLARE_KEY_1: 'a1b2c3d4e5f6g7h8i9j0k1l2m',
                        },
                    },
                ],
            },
        };
        const state = { ai_keys_bench: {} };

        try {
            const result = await AIClient.askDecision({ payload: { test: true }, config, state });
            ok('F5: Cloudflare provider path was invoked', cloudflareCalled, { cloudflareUrl });
            ok('F5: Cloudflare URL contains account ID',
                cloudflareUrl && cloudflareUrl.includes('/a1b2c3d4e5f6g7h8i9j0k1l2m/'),
                { cloudflareUrl });
            ok('F5: decision returned correctly',
                result && result.decision && result.decision.action === 'hold',
                result);
        } catch (e) {
            ok('F5: Cloudflare call succeeded', false, { error: e.message });
        }

        global.fetch = originalFetch;
        delete process.env.CLOUDFLARE_KEY_1;
        Logger.warn = originalWarn;
    }

    // Restore original env.
    if (origOpenaiKey !== undefined) process.env.OPENAI_API_KEY = origOpenaiKey;
    else delete process.env.OPENAI_API_KEY;
    if (origOpenaiKey1 !== undefined) process.env.OPENAI_KEY_1 = origOpenaiKey1;
    else delete process.env.OPENAI_KEY_1;

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
})();
