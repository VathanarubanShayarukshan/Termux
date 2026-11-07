process.on('uncaughtException', (err) => {
    console.error('[Anti-Crash Shield] Exception:', err.message || err);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('[Anti-Crash Shield] Rejection:', promise, 'reason:', reason);
});

// -------------------------------------------------------------
// OWNER & ACCESS CONFIGURATION
// -------------------------------------------------------------
const OWNER_NUMBERS = ['94767751412']; // Authorized owner number
const ALLOW_GROUPS = false;            // Set false to ignore group chats
// -------------------------------------------------------------

const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, downloadMediaMessage, jidNormalizedUser } = require('@whiskeysockets/baileys');
const { exec } = require('child_process');
const readline = require('readline');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const http = require('http');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const question = (text) => new Promise((resolve) => rl.question(text, resolve));
const sessions = {};
const botMessageIds = new Set();

const AGENTIC_BASE_URL = process.env.AGENTIC_URL || 'http://127.0.0.1:8000';
const AGENTIC_PASS = process.env.AGENTIC_PASSWORD || 'test-pass';
let agentSessionCache = { token: '', sessionId: '', providerId: '', model: '' };

function httpPostJson(urlStr, data, headers = {}) {
    return new Promise((resolve, reject) => {
        try {
            const u = new URL(urlStr);
            const payload = JSON.stringify(data);
            const req = http.request(u, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(payload),
                    ...headers
                }
            }, (res) => {
                let body = '';
                res.on('data', chunk => body += chunk);
                res.on('end', () => {
                    try { resolve(JSON.parse(body)); } catch (e) { resolve({}); }
                });
            });
            req.on('error', reject);
            req.write(payload);
            req.end();
        } catch (e) { reject(e); }
    });
}

function httpGetJson(urlStr, headers = {}) {
    return new Promise((resolve, reject) => {
        try {
            const u = new URL(urlStr);
            const req = http.get(u, { headers }, (res) => {
                let body = '';
                res.on('data', chunk => body += chunk);
                res.on('end', () => {
                    try { resolve(JSON.parse(body)); } catch (e) { resolve({}); }
                });
            });
            req.on('error', reject);
        } catch (e) { reject(e); }
    });
}

async function initAgentConfig() {
    try {
        if (!agentSessionCache.token) {
            const authRes = await httpPostJson(`${AGENTIC_BASE_URL}/api/auth/login`, { password: AGENTIC_PASS });
            if (authRes && authRes.token) agentSessionCache.token = authRes.token;
        }
        const authHeader = agentSessionCache.token ? { 'Authorization': `Bearer ${agentSessionCache.token}` } : {};

        if (!agentSessionCache.sessionId) {
            const sessRes = await httpPostJson(`${AGENTIC_BASE_URL}/api/sessions`, {}, authHeader);
            if (sessRes && sessRes.id) agentSessionCache.sessionId = sessRes.id;
        }

        if (!agentSessionCache.providerId || !agentSessionCache.model) {
            const providers = await httpGetJson(`${AGENTIC_BASE_URL}/api/providers`, authHeader);
            if (Array.isArray(providers) && providers.length > 0) {
                const activeP = providers.find(p => p.models && p.models.length > 0 && p.api_key_set) || providers[0];
                if (activeP && activeP.models && activeP.models.length > 0) {
                    agentSessionCache.providerId = activeP.id;
                    agentSessionCache.model = activeP.models[0];
                }
            }
        }
        return true;
    } catch (e) {
        console.error('[Agent Init Error]', e.message);
        return false;
    }
}

async function startBot() {
    let phoneNumber = "";
    const { state, saveCreds } = await useMultiFileAuthState('auth_session');

    if (!state.creds || !state.creds.registered) {
        console.clear();
        phoneNumber = await question('👉 Enter your WhatsApp number with country code:\n');
        phoneNumber = phoneNumber.replace(/[^0-9]/g, '');
    }

    const { version } = await fetchLatestBaileysVersion();
    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: ["Mac OS", "Chrome", "10.15.7"],
        keepAliveIntervalMs: 30000,
        connectTimeoutMs: 60000
    });

    const sendMessageSafe = async (jid, content, options = {}) => {
        try {
            const res = await sock.sendMessage(jid, content, options);
            if (res && res.key && res.key.id) botMessageIds.add(res.key.id);
            return res;
        } catch (e) {
            console.error('[Send Error]', e.message);
            return null;
        }
    };

    const sendFileToUser = async (from, currentSession, filePath) => {
        const fullPath = path.isAbsolute(filePath) ? filePath : path.join(currentSession.cwd, filePath);
        if (fs.existsSync(fullPath)) {
            try {
                const stats = fs.statSync(fullPath);
                if (stats.isDirectory()) {
                    await sendMessageSafe(from, { text: `❌ \`${fullPath}\` is a directory. Please specify a file.` });
                    return;
                }
                const sizeMb = (stats.size / (1024 * 1024)).toFixed(2);
                await sendMessageSafe(from, { text: `📁 *SEND MODE:* Uploading \`${path.basename(fullPath)}\` (${sizeMb} MB)...` });

                let mimeType = 'application/octet-stream';
                if (fullPath.endsWith('.apk')) mimeType = 'application/vnd.android.package-archive';
                else if (fullPath.endsWith('.pdf')) mimeType = 'application/pdf';
                else if (fullPath.endsWith('.zip')) mimeType = 'application/zip';
                else if (fullPath.endsWith('.mp4')) mimeType = 'video/mp4';
                else if (fullPath.endsWith('.png')) mimeType = 'image/png';
                else if (fullPath.endsWith('.jpg') || fullPath.endsWith('.jpeg')) mimeType = 'image/jpeg';

                await sendMessageSafe(from, {
                    document: { url: fullPath },
                    fileName: path.basename(fullPath),
                    mimetype: mimeType
                });
            } catch (e) {
                await sendMessageSafe(from, { text: `❌ *Send Failed:* ${e.message}` });
            }
        } else {
            await sendMessageSafe(from, { text: `❌ *File Not Found:* \`${fullPath}\`` });
        }
    };

    const processBrowsingCommand = async (from, currentSession, inputCmd) => {
        let delaySec = 2;
        let isFullPage = false;
        let cropHeight = 800;

        const dMatch = inputCmd.match(/-d\s*(\d+)(ms|s)?/i);
        if (dMatch) {
            let val = parseInt(dMatch[1]);
            if (val > 30 || dMatch[2] === 'ms') {
                delaySec = Math.max(1, Math.min(10, Math.round(val / 1000)));
            } else {
                delaySec = Math.max(1, Math.min(10, val));
            }
        }

        const pMatch = inputCmd.match(/-p\s*(\d+)%?/i);
        if (pMatch) {
            let pct = parseInt(pMatch[1]);
            if (pct >= 75) {
                isFullPage = true;
            } else {
                cropHeight = Math.max(400, Math.round(800 * (pct / 50)));
            }
        }

        let cleanCmd = inputCmd.replace(/-d\s*\d+(ms|s)?/gi, '').replace(/-p\s*\d+%?/gi, '').trim();
        let urlCandidate = cleanCmd.split(/\s+/)[0];
        if (!urlCandidate) urlCandidate = 'google.com';
        if (!/^https?:\/\//i.test(urlCandidate)) {
            urlCandidate = 'https://' + urlCandidate;
        }

        await sendMessageSafe(from, {
            text: `🌐 *BROWSE MODE:* Processing \`${urlCandidate}\` (Delay: ${delaySec}s, Page:${isFullPage ? '100%' : (pMatch ? pMatch[1] + '%' : 'Default')})...`
        });

        const runScript = `cd '${currentSession.cwd}' && agentic-browser${inputCmd} 2>&1`;
        exec(runScript, async (err, stdout, stderr) => {
            const output = stdout || stderr || '';
            if (!err && output && !output.includes('not found')) {
                await sendMessageSafe(from, { text: `🌐 *Browser Output:*\n\n${output}` });
            } else {
                try {
                    let thumOpts = `delay/${delaySec}/width/1200/`;
                    if (isFullPage) {
                        thumOpts += `fullpage/`;
                    } else {
                        thumOpts += `crop/${cropHeight}/`;
                    }
                    const screenshotUrl = `https://image.thum.io/get/${thumOpts}${urlCandidate}`;

                    await sendMessageSafe(from, {
                        image: { url: screenshotUrl },
                        caption: `🌐 *Browser Screenshot Result*\n🔗 **URL:** \`${urlCandidate}\`\n⏱️ **Delay:** \`${delaySec}s\` | 📐 **Page:** \`${isFullPage ? '100%' : (pMatch ? pMatch[1] + '%' : 'Standard')}\`\nℹ️ *(Captured via Cloud Renderer)*`
                    });
                } catch (fallbackErr) {
                    await sendMessageSafe(from, { text: `❌ *Browse Failed:* Could not capture \`${urlCandidate}\`.` });
                }
            }
        });
    };

    if (!sock.authState.creds.registered && phoneNumber) {
        setTimeout(async () => {
            try {
                const code = await sock.requestPairingCode(phoneNumber);
                console.log(`\n🔑 PAIRING CODE: \x1b[1;32m${code}\x1b[0m`);
            } catch (e) { console.error(e); }
        }, 4000);
    }

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', (update) => {
        if (update.connection === 'open') console.log('\n✅ Connected to WhatsApp!');
        if (update.connection === 'close') startBot();
    });

    sock.ev.on('messages.upsert', async (m) => {
        try {
            for (const msg of m.messages) {
                if (!msg || !msg.message) continue;

                const from = msg.key.remoteJid;
                if (!from || from === 'status@broadcast') continue;

                // 1. GROUP FILTER
                const isGroup = from.endsWith('@g.us');
                if (isGroup && !ALLOW_GROUPS) continue;

                // 2. SENDER AUTHORIZATION & SELF-CHAT ISOLATION FIX
                const isFromMe = msg.key.fromMe;
                const myJid = sock.user ? jidNormalizedUser(sock.user.id) : '';
                const myLid = sock.user?.lid ? jidNormalizedUser(sock.user.lid) : '';
                const normalizedFrom = jidNormalizedUser(from);

                if (isFromMe) {
                    const isSelfChat = normalizedFrom === myJid ||
                                       (myLid && normalizedFrom === myLid) ||
                                       OWNER_NUMBERS.some(num => from.includes(num));
                    if (!isSelfChat) continue; // Ignore commands sent in other people's chats
                } else {
                    const senderJid = msg.key.participant || from;
                    const senderNumber = senderJid.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
                    const isOwner = OWNER_NUMBERS.includes(senderNumber);
                    if (!isOwner) continue;
                }

                // 3. IGNORE BOT'S OWN AUTOMATED OUTBOUND MESSAGES (ECHO PREVENT)
                if (msg.key && msg.key.id && botMessageIds.has(msg.key.id)) continue;

                let msgContent = msg.message;
                if (msgContent.ephemeralMessage) msgContent = msgContent.ephemeralMessage.message;
                if (msgContent.viewOnceMessage) msgContent = msgContent.viewOnceMessage.message;
                if (msgContent.viewOnceMessageV2) msgContent = msgContent.viewOnceMessageV2.message;
                if (msgContent.documentWithCaptionMessage) msgContent = msgContent.documentWithCaptionMessage.message;

                if (!msgContent) continue;

                let text = (msgContent.conversation ||
                            msgContent.extendedTextMessage?.text ||
                            msgContent.imageMessage?.caption ||
                            msgContent.videoMessage?.caption ||
                            msgContent.documentMessage?.caption || '').trim();

                if (!sessions[from]) {
                    sessions[from] = {
                        mode: 'normal',
                        cwd: '/home/ubuntu',
                        tasks: [],
                        agentSessionId: null,
                        providerId: null,
                        model: null,
                        selectionStep: null,
                        providersList: [],
                        pendingProvider: null,
                        modelsList: [],
                        pendingGetPath: null
                    };
                }
                const currentSession = sessions[from];

                // 4. STOP COMMAND (Global Reset)
                if (text === '.stop') {
                    currentSession.mode = 'normal';
                    currentSession.selectionStep = null;
                    currentSession.pendingGetPath = null;
                    currentSession.tasks = [];
                    await sendMessageSafe(from, { text: `✅ *MODE TERMINATED & RESET TO NORMAL*` });
                    continue;
                }

                // 5. MEDIA HANDLING (STRICTLY ONLY WHEN IN GET MODE)
                const isMedia = msgContent.imageMessage || msgContent.documentMessage || msgContent.videoMessage || msgContent.audioMessage || msgContent.stickerMessage;
                if (isMedia) {
                    if (currentSession.mode !== 'get') {
                        continue;
                    }

                    let defaultExt = '.bin';
                    let rawName = `upload_${Date.now()}`;

                    if (msgContent.imageMessage) defaultExt = '.jpg';
                    else if (msgContent.videoMessage) defaultExt = '.mp4';
                    else if (msgContent.audioMessage) defaultExt = '.mp3';
                    else if (msgContent.documentMessage) {
                        rawName = msgContent.documentMessage.fileName || rawName;
                        defaultExt = '';
                    }

                    let userPath = text || currentSession.pendingGetPath;
                    let savePath;

                    if (!userPath) {
                        savePath = path.join(currentSession.cwd, `${rawName}${defaultExt}`);
                    } else {
                        savePath = path.isAbsolute(userPath) ? userPath : path.join(currentSession.cwd, userPath);
                        try {
                            if (fs.existsSync(savePath) && fs.statSync(savePath).isDirectory()) {
                                savePath = path.join(savePath, `${rawName}${defaultExt}`);
                            }
                        } catch(e) {}
                    }

                    try {
                        await sendMessageSafe(from, { text: `📥 *GET MODE:* Downloading file to server...` });
                        const buffer = await downloadMediaMessage(msg, 'buffer', {});
                        fs.mkdirSync(path.dirname(savePath), { recursive: true });
                        fs.writeFileSync(savePath, buffer);
                        currentSession.pendingGetPath = null;
                        currentSession.mode = 'normal';
                        await sendMessageSafe(from, { text: `✅ *File Saved Successfully!*\n📍 Location: \`${savePath}\`` });
                    } catch (err) {
                        await sendMessageSafe(from, { text: `❌ *Save Failed:* ${err.message}` });
                    }
                    continue;
                }

                if (!text) continue;

                // Prevent self-looping on bot's own output text
                if (isFromMe) {
                    const cleanText = text.replace(/[*_`~]/g, '');
                    const isBotReply = cleanText.includes('MODE ACTIVATED') ||
                                       cleanText.includes('MODE TERMINATED') ||
                                       cleanText.includes('Directory:') ||
                                       cleanText.includes('Active Tasks') ||
                                       cleanText.includes('JARVIS Agent') ||
                                       cleanText.includes('New Agent Chat') ||
                                       cleanText.includes('Command Guide') ||
                                       cleanText.includes('Step 1: Select Provider') ||
                                       cleanText.includes('Step 2: Select Model') ||
                                       cleanText.includes('Browser Output:') ||
                                       cleanText.includes('Browser Screenshot Result');
                    if (isBotReply) continue;
                }

                if (text === '.help') {
                    let helpText = `📖 *TCZone AI - Command Guide* 📖\n\n` +
                                   `🤖 *Available Core Modes & Examples:*\n\n` +
                                   `🤖 *1. AGENT MODE (JARVIS Agentic AI)*\n` +
                                   `• Format: \`.agent <task_or_question>\` or type \`.agent\`\n` +
                                   `• New Session: \`.agent new\`\n` +
                                   `• Switch Model: \`.model\`\n\n` +
                                   `💻 *2. RUN MODE (Linux Terminal)*\n` +
                                   `• Format: \`.run <command>\` or type \`.run\`\n\n` +
                                   `📁 *3. SEND MODE (File Downloader)*\n` +
                                   `• Format: \`.send <file_name>\` or type \`.send\`\n\n` +
                                   `📥 *4. GET MODE (File Uploader)*\n` +
                                   `• Format: \`.get <save_path>\` or type \`.get\`\n\n` +
                                   `🌐 *5. BROWSE MODE (Web Screenshot Controls)*\n` +
                                   `• Format: \`.brows <url> -p <pct> -d <delay>\`\n\n` +
                                   `⚙️ *Task Control:*\n` +
                                   `• \`.pro\` - Check active background tasks\n` +
                                   `• \`.kill\` - Stop running processes\n` +
                                   `• \`.stop\` - Exit interactive mode and reset to normal`;
                    await sendMessageSafe(from, { text: helpText });
                    continue;
                }

                if (text === '.pro') {
                    const modeTasks = currentSession.tasks.filter(t => t.mode === currentSession.mode);
                    if (modeTasks.length > 0) {
                        let out = `📊 *Active Tasks (${currentSession.mode.toUpperCase()} MODE):*`;
                        modeTasks.forEach(t => {
                            out += `\n• \`${t.name}\` - *${t.progress}\%* \vert{} ⚙️ *${t.statusMsg || 'Working...'}*`;
                        });
                        await sendMessageSafe(from, { text: out });
                    } else {
                        await sendMessageSafe(from, { text: `📊 *Progress:* No active tasks in *${currentSession.mode}* mode.` });
                    }
                    continue;
                }

                if (text === '.kill') {
                    const modeTasks = currentSession.tasks.filter(t => t.mode === currentSession.mode);
                    if (modeTasks.length > 0) {
                        for (const t of modeTasks) {
                            t.wasKilled = true;
                            if (t.req) { try { t.req.destroy(); } catch(e){} }
                            if (t.process) { try { t.process.kill('SIGKILL'); } catch(e){} }
                        }
                        currentSession.tasks = currentSession.tasks.filter(t => t.mode !== currentSession.mode);
                        await sendMessageSafe(from, { text: `❌ *Tasks Terminated.*` });
                    } else {
                        await sendMessageSafe(from, { text: `ℹ️ No active tasks to kill in *${currentSession.mode}* mode.` });
                    }
                    continue;
                }

                if (text === '.get' || text.startsWith('.get ')) {
                    const targetPath = text.slice(4).trim();
                    currentSession.mode = 'get';
                    if (targetPath) {
                        currentSession.pendingGetPath = targetPath;
                        await sendMessageSafe(from, {
                            text: `📥 *GET MODE ACTIVATED*\n` +
                                  `📍 Save Target: \`${targetPath}\`\n\n` +
                                  `👉 Send your media file (image, video, document) now.`
                        });
                    } else {
                        currentSession.pendingGetPath = null;
                        await sendMessageSafe(from, {
                            text: `📥 *GET MODE ACTIVATED*\n` +
                                  `📂 Current Directory: \`${currentSession.cwd}\`\n\n` +
                                  `👉 Send your media file in your next message.`
                        });
                    }
                    continue;
                }

                if (text === '.send' || text.startsWith('.send ')) {
                    const targetFile = text.slice(5).trim();
                    if (!targetFile) {
                        currentSession.mode = 'send';
                        await sendMessageSafe(from, {
                            text: `📁 *SEND MODE ACTIVATED*\n` +
                                  `📂 Current Directory: \`${currentSession.cwd}\`\n\n` +
                                  `👉 Send the file path/name in your next message.`
                        });
                        continue;
                    }
                    await sendFileToUser(from, currentSession, targetFile);
                    continue;
                }

                if (text === '.brows' || text.startsWith('.brows ')) {
                    const browsCmd = text.slice(6).trim();
                    currentSession.mode = 'brows';
                    if (!browsCmd) {
                        await sendMessageSafe(from, {
                            text: `🌐 *BROWSE MODE ACTIVATED*\n\n` +
                                  `👉 Send target URL and options.`
                        });
                        continue;
                    }
                    await processBrowsingCommand(from, currentSession, browsCmd);
                    continue;
                }

                if (text === '.model' || text === '.agent model' || text === '.agent new') {
                    currentSession.mode = 'agent';
                    await initAgentConfig();

                    const authHeader = agentSessionCache.token ? { 'Authorization': `Bearer ${agentSessionCache.token}` } : {};

                    if (text === '.agent new') {
                        const sessRes = await httpPostJson(`${AGENTIC_BASE_URL}/api/sessions`, {}, authHeader);
                        if (sessRes && sessRes.id) currentSession.agentSessionId = sessRes.id;
                    }

                    const providers = await httpGetJson(`${AGENTIC_BASE_URL}/api/providers`, authHeader);
                    const validProviders = Array.isArray(providers) ? providers.filter(p => p.models && p.models.length > 0) : [];

                    if (validProviders.length === 0) {
                        await sendMessageSafe(from, { text: `❌ No active providers available.` });
                        continue;
                    }

                    currentSession.providersList = validProviders;
                    currentSession.selectionStep = 'provider';

                    let menuText = text === '.agent new' ? `🆕 *New Agent Chat Created*\n\n` : `⚙️ *Change Model Configuration*\n\n`;
                    menuText += `📌 *Step 1: Select Provider*\n\n`;

                    validProviders.forEach((p, idx) => {
                        menuText += `*${idx + 1}.* ${p.name || p.id}\n`;
                    });

                    menuText += `\n👉 *Reply with the provider number*.`;
                    await sendMessageSafe(from, { text: menuText });
                    continue;
                }

                if (currentSession.mode === 'agent' && currentSession.selectionStep) {
                    const choiceIndex = parseInt(text.trim()) - 1;

                    if (currentSession.selectionStep === 'provider') {
                        if (!isNaN(choiceIndex) && currentSession.providersList[choiceIndex]) {
                            const selectedProvider = currentSession.providersList[choiceIndex];
                            currentSession.pendingProvider = selectedProvider;
                            currentSession.modelsList = selectedProvider.models;
                            currentSession.selectionStep = 'model';

                            let menuText = `🧠 *Step 2: Select Model for ${selectedProvider.name || selectedProvider.id}*\n\n`;
                            selectedProvider.models.forEach((m, idx) => {
                                menuText += `*${idx + 1}.* \`${m}\`\n`;
                            });
                            menuText += `\n👉 *Reply with the model number*.`;
                            await sendMessageSafe(from, { text: menuText });
                        } else {
                            await sendMessageSafe(from, { text: `❌ Invalid choice. Reply with a valid provider number.` });
                        }
                        continue;
                    }

                    if (currentSession.selectionStep === 'model') {
                        if (!isNaN(choiceIndex) && currentSession.modelsList[choiceIndex]) {
                            const selectedModel = currentSession.modelsList[choiceIndex];
                            currentSession.providerId = currentSession.pendingProvider.id;
                            currentSession.model = selectedModel;
                            currentSession.selectionStep = null;

                            await sendMessageSafe(from, {
                                text: `✅ *Model Selected Successfully!*\n\n` +
                                      `🤖 *Provider:* ${currentSession.pendingProvider.name || currentSession.pendingProvider.id}\n` +
                                      `🧠 *Model:* \`${selectedModel}\`\n` +
                                      `🆔 *Active Session:* \`${currentSession.agentSessionId || agentSessionCache.sessionId || 'default'}\`\n\n` +
                                      `Send your prompt to JARVIS Agent.`
                            });
                        } else {
                            await sendMessageSafe(from, { text: `❌ Invalid choice. Reply with a valid model number.` });
                        }
                        continue;
                    }
                }

                if (text === '.agent' || text.startsWith('.agent ')) {
                    currentSession.mode = 'agent';
                    const promptText = text.slice(6).trim();
                    if (!promptText) {
                        await sendMessageSafe(from, { text: `🤖 *AGENT MODE ACTIVATED*\nSend your prompt or use \`.agent new\` / \`.model\` to change settings.` });
                        continue;
                    }
                    text = promptText;
                } else if (text === '.run' || text.startsWith('.run ')) {
                    currentSession.mode = 'run';
                    const cmdText = text.slice(4).trim();
                    if (!cmdText) {
                        await sendMessageSafe(from, { text: `💻 *RUN MODE ACTIVATED*\n📂 CWD: \`${currentSession.cwd}\`\n\nSend terminal commands in your next messages.` });
                        continue;
                    }
                    text = cmdText;
                }

                if (currentSession.mode === 'send') {
                    await sendFileToUser(from, currentSession, text);
                    continue;
                }

                if (currentSession.mode === 'brows') {
                    await processBrowsingCommand(from, currentSession, text);
                    continue;
                }

                if (currentSession.mode === 'agent') {
                    await initAgentConfig();
                    const currentTaskId = Date.now();
                    const taskObj = { id: currentTaskId, name: text.slice(0, 25), progress: 10, statusMsg: 'Thinking...', req: null, wasKilled: false, mode: 'agent' };
                    currentSession.tasks.push(taskObj);

                    const activeSessionId = currentSession.agentSessionId || agentSessionCache.sessionId;
                    const activeProviderId = currentSession.providerId || agentSessionCache.providerId;
                    const activeModel = currentSession.model || agentSessionCache.model;

                    (async () => {
                        let finalResponseText = '';
                        let errorMessage = '';
                        let sseBuffer = '';
                        try {
                            const u = new URL(`${AGENTIC_BASE_URL}/api/chat`);
                            const payload = JSON.stringify({
                                session_id: activeSessionId,
                                message: text,
                                provider_id: activeProviderId,
                                model: activeModel
                            });
                            const authHeader = agentSessionCache.token ? { 'Authorization': `Bearer ${agentSessionCache.token}` } : {};

                            await new Promise((resolve, reject) => {
                                const req = http.request(u, {
                                    method: 'POST',
                                    timeout: 120000,
                                    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...authHeader }
                                }, (res) => {
                                    res.on('data', (chunk) => {
                                        const liveTask = currentSession.tasks.find(t => t.id === currentTaskId);
                                        if (!liveTask || liveTask.wasKilled) { res.destroy(); return; }

                                        sseBuffer += chunk.toString();
                                        let lines = sseBuffer.split('\n');
                                        sseBuffer = lines.pop() || '';

                                        for (const line of lines) {
                                            const trimmedLine = line.trim();
                                            if (trimmedLine.startsWith('data: ')) {
                                                const jsonData = trimmedLine.slice(6).trim();
                                                if (jsonData === '[DONE]') continue;
                                                try {
                                                    const parsed = JSON.parse(jsonData);
                                                    if (parsed.text) finalResponseText += parsed.text;
                                                    else if (parsed.content) finalResponseText += parsed.content;
                                                    else if (parsed.delta) finalResponseText += parsed.delta;
                                                    if (parsed.status) liveTask.statusMsg = parsed.status;
                                                    if (parsed.progress) liveTask.progress = parsed.progress;
                                                } catch (e) {
                                                    finalResponseText += jsonData;
                                                }
                                            }
                                        }
                                    });
                                    res.on('end', () => resolve());
                                    res.on('error', (e) => reject(e));
                                });
                                req.on('error', (e) => reject(e));
                                taskObj.req = req;
                                req.write(payload);
                                req.end();
                            });
                        } catch (err) {
                            errorMessage = err.message;
                        } finally {
                            currentSession.tasks = currentSession.tasks.filter(t => t.id !== currentTaskId);
                            if (taskObj.wasKilled) return;
                            if (finalResponseText.trim()) {
                                await sendMessageSafe(from, { text: `🤖 *JARVIS Agent Output:*\n\n${finalResponseText.trim()}` });
                            } else if (errorMessage) {
                                await sendMessageSafe(from, { text: `❌ *Agent Request Failed:* ${errorMessage}` });
                            } else {
                                await sendMessageSafe(from, { text: `⚠️ No response received from agent.` });
                            }
                        }
                    })();
                    continue;
                }

                if (currentSession.mode === 'run') {
                    if (text.startsWith('cd ')) {
                        const targetDir = text.slice(3).trim();
                        const newPath = path.isAbsolute(targetDir) ? targetDir : path.join(currentSession.cwd, targetDir);
                        if (fs.existsSync(newPath) && fs.statSync(newPath).isDirectory()) {
                            currentSession.cwd = path.resolve(newPath);
                            await sendMessageSafe(from, { text: `📂 *CWD Changed:* \`${currentSession.cwd}\`` });
                        } else {
                            await sendMessageSafe(from, { text: `❌ *Directory Not Found:* \`${newPath}\`` });
                        }
                        continue;
                    }

                    const currentTaskId = Date.now();
                    const taskObj = { id: currentTaskId, name: text.slice(0, 25), progress: 50, statusMsg: 'Executing...', process: null, wasKilled: false, mode: 'run' };
                    currentSession.tasks.push(taskObj);

                    await sendMessageSafe(from, { text: `💻 *Executing:* \`${text}\`\n📂 *CWD:* \`${currentSession.cwd}\`` });

                    const child = exec(text, { cwd: currentSession.cwd, maxBuffer: 1024 * 1024 * 10 }, async (err, stdout, stderr) => {
                        currentSession.tasks = currentSession.tasks.filter(t => t.id !== currentTaskId);
                        if (taskObj.wasKilled) return;

                        let output = stdout || stderr || '';
                        if (!output && !err) output = '✅ Command executed with no output.';
                        if (err && !output) output = `❌ Error: ${err.message}`;

                        if (output.length > 4000) {
                            const outPath = path.join(currentSession.cwd, `output_${currentTaskId}.txt`);
                            fs.writeFileSync(outPath, output);
                            await sendMessageSafe(from, { text: `⚠️ Output too large (${output.length} chars). File generated:` });
                            await sendFileToUser(from, currentSession, outPath);
                        } else {
                            await sendMessageSafe(from, { text: `💻 *Output:*\n\n\`\`\`\n${output}\n\`\`\`` });
                        }
                    });
                    taskObj.process = child;
                    continue;
                }
            }
        } catch (err) {
            console.error('[Upsert Error]', err);
        }
    });
}

startBot();
