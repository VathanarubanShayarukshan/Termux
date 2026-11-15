// End-to-end test for the bot's .agent mode without a real WhatsApp login.
// Mocks Baileys, feeds fake owner messages, and asserts the bot's replies
// against a live JARVIS server + stub provider.
//
// Run:  python JARVIS/scripts/stub_provider.py &   (port 9500)
//       python -m app.main &                        (JARVIS, port 8000)
//       node test-agent-mode.js
process.env.AGENTIC_URL = process.env.AGENTIC_URL || 'http://127.0.0.1:8000';
process.env.AGENTIC_PASSWORD = process.env.AGENTIC_PASSWORD || 'test-pass';

const Module = require('module');
const { EventEmitter } = require('events');
const assert = require('assert');

const BASE = process.env.AGENTIC_URL;
const PASS = process.env.AGENTIC_PASSWORD;

const sent = [];
let msgSeq = 0;
const fakeEv = new EventEmitter();
const fakeSock = {
    ev: fakeEv,
    user: { id: '94767751412@s.whatsapp.net', lid: '99999@lid' },
    authState: { creds: { registered: true } },
    sendMessage: async (jid, content) => {
        sent.push({ jid, content });
        return { key: { id: 'BOTMSG' + (++msgSeq), remoteJid: jid } };
    },
    requestPairingCode: async () => '12345678',
};

const fakeBaileys = {
    default: () => fakeSock,
    useMultiFileAuthState: async () => ({ state: { creds: { registered: true } }, saveCreds: () => {} }),
    fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 1015901307] }),
    downloadMediaMessage: async () => Buffer.from(''),
    jidNormalizedUser: (jid) => {
        if (!jid) return '';
        const [user, server] = jid.split('@');
        return user.split(':')[0] + '@' + server;
    },
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === '@whiskeysockets/baileys') return fakeBaileys;
    return origLoad.apply(this, arguments);
};

async function api(path, method = 'GET', body = null, token = null) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    let json = null;
    try { json = await res.json(); } catch (e) {}
    return { status: res.status, json };
}

async function ensureTestProviders() {
    let token = null;
    const login = await api('/api/auth/login', 'POST', { password: PASS });
    if (login.status === 200) token = login.json.token;
    const list = await api('/api/providers', 'GET', null, token);
    const names = (list.json || []).map(p => p.name);
    if (!names.includes('Stub')) {
        await api('/api/providers', 'POST', { name: 'Stub', base_url: 'http://127.0.0.1:9500/v1', api_key: 'test-key', models: ['stub-1'] }, token);
    }
    if (!names.includes('Dead')) {
        await api('/api/providers', 'POST', { name: 'Dead', base_url: 'http://127.0.0.1:9599/v1', api_key: 'test-key', models: ['dead-1'] }, token);
    }
}

require('./index.js');

const OWNER_JID = '94767751412@s.whatsapp.net';
function send(text) {
    const handler = fakeEv.listeners('messages.upsert')[0];
    assert(handler, 'messages.upsert handler not registered');
    handler({
        messages: [{
            key: { remoteJid: OWNER_JID, fromMe: true, id: 'USERMSG' + (++msgSeq) },
            message: { conversation: text },
        }],
        type: 'notify',
    });
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function waitFor(predicate, timeoutMs = 30000, label = 'reply') {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const hit = sent.find(predicate);
        if (hit) return hit;
        await sleep(100);
    }
    throw new Error('TIMEOUT waiting for ' + label + '. Got: ' + JSON.stringify(sent.map(s => s.content.text || '[media]').slice(-6)));
}

function allText() { return sent.map(s => s.content.text || '').join('\n'); }
function countOccurrences(haystack, needle) { return haystack.split(needle).length - 1; }

async function waitForIdle(timeoutMs = 30000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const before = sent.length;
        await sleep(700);
        if (sent.length === before) return;
    }
}

(async () => {
    await ensureTestProviders();
    await sleep(500); // let startBot() register handlers
    let results = [];
    const check = (name, fn) => {
        try { fn(); results.push('PASS  ' + name); }
        catch (e) { results.push('FAIL  ' + name + ' -> ' + e.message); }
    };

    // 1. .agent activates mode
    sent.length = 0;
    send('.agent');
    await waitFor(s => (s.content.text || '').includes('AGENT MODE ACTIVATED'), 10000, '.agent activation');
    check('.agent activates agent mode', () => assert(allText().includes('AGENT MODE ACTIVATED')));

    // 2. .agent <task> -> stub provider runs, output arrives exactly once
    sent.length = 0;
    send('.agent create a hello file');
    await waitFor(s => (s.content.text || '').includes('JARVIS Agent Output:'), 60000, 'agent output');
    await waitForIdle();
    check('agent output received', () => assert(allText().includes('I created the file for you')));
    check('no duplicated output (done event handled)', () => assert.strictEqual(countOccurrences(allText(), 'I created the file for you'), 1));

    // 3. .pro shows live status mid-run
    sent.length = 0;
    send('.agent another task for progress');
    await sleep(450);
    send('.pro');
    await waitFor(s => (s.content.text || '').includes('Active Tasks'), 10000, '.pro reply');
    const proText = allText();
    check('.pro shows live tool status', () => assert(/Running: write_file|Result: write_file|Thinking\.\.\./.test(proText), 'got: ' + proText));
    await waitFor(s => (s.content.text || '').includes('JARVIS Agent Output:'), 60000, 'second agent output');
    await waitForIdle();

    // 4. .model -> provider list -> select Stub -> select model
    sent.length = 0;
    send('.model');
    const provMenu = await waitFor(s => (s.content.text || '').includes('Step 1: Select Provider'), 15000, 'provider menu');
    const stubLine = provMenu.content.text.split('\n').find(l => l.includes('Stub'));
    assert(stubLine, 'Stub provider not in menu: ' + provMenu.content.text);
    const stubNum = stubLine.match(/\*(\d+)\.\*/)[1];
    send(stubNum);
    await waitFor(s => (s.content.text || '').includes('Step 2: Select Model'), 10000, 'model menu');
    send('1');
    await waitFor(s => (s.content.text || '').includes('Model Selected Successfully'), 10000, 'model selected');
    check('.model provider/model selection works', () => assert(allText().includes('stub-1')));

    // 5. long reply is chunked, content intact
    sent.length = 0;
    const longTask = 'L'.repeat(9000);
    send(longTask);
    await waitFor(s => (s.content.text || '').includes('JARVIS Agent Output:'), 90000, 'long task output');
    await waitForIdle();
    const chunks = sent.filter(s => (s.content.text || '').length > 0);
    check('long reply chunked into multiple messages', () => assert(chunks.length >= 3, 'chunks: ' + chunks.length));
    check('no chunk exceeds 4000 chars', () => assert(chunks.every(c => c.content.text.length <= 4000)));
    const joined = chunks.map(c => c.content.text).join('').replace('🤖 *JARVIS Agent Output:*\n\n', '');
    check('long task text echoed back intact', () => assert(joined.includes(longTask)));

    // 6. .agent new creates a fresh session
    sent.length = 0;
    send('.agent new');
    await waitFor(s => (s.content.text || '').includes('New Agent Chat Created'), 15000, '.agent new');
    check('.agent new works', () => assert(allText().includes('Step 1: Select Provider')));

    // 7. provider without key -> clear error (HTTP 400 path)
    send('1'); // Gemini preset, no key
    await waitFor(s => (s.content.text || '').includes('Step 2: Select Model'), 10000, 'gemini model menu');
    send('1');
    await waitFor(s => (s.content.text || '').includes('Model Selected Successfully'), 10000, 'gemini model selected');
    sent.length = 0;
    send('this should fail with a clear error');
    await waitFor(s => (s.content.text || '').includes('Agent Error'), 30000, 'error surfaced');
    check('missing API key error surfaced to WhatsApp', () => assert(allText().includes('no API key'), allText()));

    // 8. unreachable provider -> SSE error event surfaced
    sent.length = 0;
    send('.model');
    const provMenu2 = await waitFor(s => (s.content.text || '').includes('Step 1: Select Provider'), 15000, 'provider menu 2');
    const deadLine = provMenu2.content.text.split('\n').find(l => l.includes('Dead'));
    assert(deadLine, 'Dead provider not in menu');
    send(deadLine.match(/\*(\d+)\.\*/)[1]);
    await waitFor(s => (s.content.text || '').includes('Step 2: Select Model'), 10000, 'dead model menu');
    send('1');
    await waitFor(s => (s.content.text || '').includes('Model Selected Successfully'), 10000, 'dead model selected');
    sent.length = 0;
    send('this hits a dead endpoint');
    await waitFor(s => (s.content.text || '').includes('Agent Error'), 60000, 'SSE error surfaced');
    check('SSE error event surfaced to WhatsApp', () => assert(/Cannot reach provider|Provider error/.test(allText()), allText()));

    console.log('\n===== RESULTS =====');
    results.forEach(r => console.log(r));
    const failed = results.filter(r => r.startsWith('FAIL')).length;
    console.log(failed === 0 ? 'ALL TESTS PASSED' : failed + ' TEST(S) FAILED');
    process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.error('HARNESS ERROR:', e.message); process.exit(2); });