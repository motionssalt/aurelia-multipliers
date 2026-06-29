/* Smoke test: replicate the patched Cloudflare extractor against
   (1) the real response the user reported, (2) a reasoning-only edge
   case, (3) the legacy /ai/run/{model} shape. */
'use strict';

function extract(json) {
    const result  = json.result || json;
    const choice0 = ((result.choices || [])[0]) || {};
    const msg     = choice0.message || {};
    let   text    = msg.content || result.response || '';
    if (!text && msg.reasoning_content) {
        const rc = String(msg.reasoning_content).trim();
        const jsonMatch = rc.match(/\{[\s\S]*\}\s*$/);
        if (jsonMatch) {
            text = jsonMatch[0];
        } else {
            const quoted = rc.match(/"([^"]{4,})"\s*\.?\s*$/);
            if (quoted) {
                text = quoted[1];
            } else {
                const lines = rc.split(/\n+/).map(s => s.trim()).filter(Boolean);
                text = lines[lines.length - 1] || '';
            }
        }
    }
    if (!text) throw new Error('cloudflare returned empty text');
    return String(text).trim();
}

// (1) The user's real response — OpenAI-compat wrapped in `result`.
const userResp = {
    result: {
        choices: [{
            message: {
                role: 'assistant',
                content: 'Hello, how can I assist you today?',
                reasoning_content: 'thinking...',
            },
        }],
    },
    success: true,
};
console.log('[1] OpenAI-compat wrapped in result :', JSON.stringify(extract(userResp)));

// (2) Reasoning-only (content empty) — should recover from reasoning_content.
const reasoningOnly = {
    result: {
        choices: [{
            message: {
                role: 'assistant',
                content: '',
                reasoning_content: 'Need to answer in JSON.\n{"action":"HOLD","confidence":0.7}',
            },
        }],
    },
};
console.log('[2] reasoning_content JSON tail     :', JSON.stringify(extract(reasoningOnly)));

// (3) Legacy native endpoint shape — { result: { response: "..." } }
const legacy = { result: { response: 'legacy answer here' } };
console.log('[3] legacy result.response          :', JSON.stringify(extract(legacy)));

// (4) Failure case — should throw.
try {
    extract({ result: { choices: [{ message: {} }] } });
    console.log('[4] empty                            : FAIL — did not throw');
} catch (e) {
    console.log('[4] empty                            : OK — threw:', e.message);
}
