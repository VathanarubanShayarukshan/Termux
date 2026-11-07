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
const { exec, spawn } = require('child_process');
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

// -------------------------------------------------------------
// VIDEO MODE CONFIG (YouTube Downloader - replica of
// https://github.com/DrelezTM/YouTubeDLWhatsAppBOT)
// -------------------------------------------------------------
const VIDEO_CONFIG = {
    name: 'YouTubeDLBOT',
    filename: { mp3: 'youtubedl', mp4: 'youtubedl' }, // file base names
    maxVideoSeconds: 600,     // WhatsApp hard-limits media around 16 min; send longer as document
    downloadDir: path.join(__dirname, 'src', 'database'),
    timezone: 'Asia/Jakarta'
};
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

    // --- Reliable large-file upload for Baileys v5/v6 (bypasses broken
    // media-url fetching when the message object has no top-level msgId) ---
    const withMsgId = (content, msgId) => {
        const keys = ['image', 'video', 'document', 'audio'];
        const out = { ...content };
        for (const k of keys) {
            if (out[k] && typeof out[k] === 'object' && !out[k].msgId) {
                out[k] = { ...out[k], msgId };
            }
        }
        return out;
    };

    const uploadMediaRaw = (bufferOrStream, medType, opts = {}) => new Promise((resolve, reject) => {
        try {
            const enc = sock.signal?.keys?.get?.(sock.user?.id);
            const upload = sock.getMediaMessageID || sock.uploadMediaMessageID;
            if (typeof upload !== 'function') throw new Error('No media upload API in this Baileys version');
            resolve(Promise.resolve(upload.call(sock, medType, bufferOrStream, { enc, ...opts })));
        } catch (e) { reject(e); }
    });

    const readFileBufferSafe = async (filePath) => {
        try {
            return await fs.promises.readFile(filePath);
        } catch (e) {
            if (e.code === 'EMOJI_RANGE' || (e.message || '').includes('emoji range')) {
                return await fs.promises.readFile(path.normalize('\\\\?\\' + filePath));
            }
            throw e;
        }
    };

    const mimeFromExt = (p) => {
        const ext = path.extname(p).toLowerCase();
        if (ext === '.mp4') return 'video/mp4';
        if (ext === '.mkv') return 'video/x-matroska';
        if (ext === '.webm') return 'video/webm';
        if (ext === '.mov') return 'video/quicktime';
        if (ext === '.mp3') return 'audio/mpeg';
        if (ext === '.ogg' || ext === '.oga') return 'audio/ogg';
        if (ext === '.wav') return 'audio/wav';
        if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
        if (ext === '.png') return 'image/png';
        if (ext === '.webp') return 'image/webp';
        if (ext === '.gif') return 'image/gif';
        if (ext === '.pdf') return 'application/pdf';
        if (ext === '.zip') return 'application/zip';
        if (ext === '.apk') return 'application/vnd.android.package-archive';
        return 'application/octet-stream';
    };

    // Send any local file as a WhatsApp DOCUMENT (works for big files too):
    // manual encryption upload -> direct msg-id reference -> retry w/ buffer.
    const sendDocumentReliable = async (from, currentSession, filePath, caption = '') => {
        const fullPath = path.isAbsolute(filePath) ? filePath : path.join(currentSession.cwd, filePath);
        if (!fs.existsSync(fullPath)) {
            await sendMessageSafe(from, { text: `❌ *File Not Found:* \`${fullPath}\`` });
            return false;
        }
        const stats = fs.statSync(fullPath);
        if (stats.isDirectory()) {
            await sendMessageSafe(from, { text: `❌ \`${fullPath}\` is a directory. Please specify a file.` });
            return false;
        }
        const sizeMb = (stats.size / (1024 * 1024)).toFixed(2);
        const fileName = path.basename(fullPath);
        const mimetype = mimeFromExt(fullPath);
        const taskId = Date.now();
        const taskObj = { id: taskId, name: `${fileName} (upload)`, progress: 5, statusMsg: `Uploading ${sizeMb} MB...`, process: null, wasKilled: false, mode: 'send' };
        currentSession.tasks.push(taskObj);
        await sendMessageSafe(from, { text: `📁 *SEND MODE:* Uploading \`${fileName}\` (${sizeMb} MB)... This runs in background — check \`.pro\` anytime.` });

        const markDone = () => { currentSession.tasks = currentSession.tasks.filter(t => t.id !== taskId); };
        const buildDocContent = (msgId) => {
            const c = {
                document: { url: fullPath, fileLength: stats.size, [Symbol.for('baileys-msg-updated-id')]: msgId },
                mimetype,
                fileName
            };
            if (caption) c.caption = caption;
            return c;
        };

        try {
            const msgId = await uploadMediaRaw(fullPath, 'document', { extract: false });
            markDone();
            if (taskObj.wasKilled) return false;
            const res = await sock.sendMessage(from, buildDocContent(msgId));
            if (res && res.key && res.key.id) botMessageIds.add(res.key.id);
            return true;
        } catch (e1) {
            console.error('[DocUpload-1]', e1.message);
            try {
                taskObj.statusMsg = 'Retry: reading file into memory...';
                const buf = await readFileBufferSafe(fullPath);
                const msgId = await uploadMediaRaw(buf, 'document', { extract: false });
                markDone();
                if (taskObj.wasKilled) return false;
                const res = await sock.sendMessage(from, buildDocContent(msgId));
                if (res && res.key && res.key.id) botMessageIds.add(res.key.id);
                return true;
            } catch (e2) {
                console.error('[DocUpload-2]', e2.message);
                markDone();
                await sendMessageSafe(from, { text: `❌ *Send Failed:* ${e2.message}` });
                return false;
            }
        }
    };

    const sendFileToUser = async (from, currentSession, filePath, caption = '') => {
        return await sendDocumentReliable(from, currentSession, filePath, caption);
    };

    // Native video send with reliable upload fallback (used by VIDEO MODE)
    const sendVideoReliable = async (from, filePath, caption = '') => {
        const stats = fs.statSync(filePath);
        const mimetype = mimeFromExt(filePath);
        const build = (msgId) => ({
            video: { url: filePath, fileLength: stats.size, [Symbol.for('baileys-msg-updated-id')]: msgId },
            mimetype,
            caption
        });
        try {
            const msgId = await uploadMediaRaw(filePath, 'video', { extract: false });
            const res = await sock.sendMessage(from, build(msgId));
            if (res && res.key && res.key.id) botMessageIds.add(res.key.id);
            return true;
        } catch (e1) {
            console.error('[VideoUpload-1]', e1.message);
            try {
                const buf = await readFileBufferSafe(filePath);
                const msgId = await uploadMediaRaw(buf, 'video', { extract: false });
                const res = await sock.sendMessage(from, build(msgId));
                if (res && res.key && res.key.id) botMessageIds.add(res.key.id);
                return true;
            } catch (e2) {
                console.error('[VideoUpload-2]', e2.message);
                return false;
            }
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


    // ---------------------------------------------------------
    // VIDEO MODE (YouTube Downloader) — replica of
    // https://github.com/DrelezTM/YouTubeDLWhatsAppBOT
    // Uses ytdl-core when installed, otherwise falls back to yt-dlp.
    // Commands: .video <url> | .audio <url> | .detail <url>
    // ---------------------------------------------------------
    let ytdlLib = null;
    try { ytdlLib = require('ytdl-core'); } catch (e) { ytdlLib = null; }

    const YT_URL_REGEX = /(https?:\/\/)?(www\.|m\.|music\.)?(youtube\.com|youtu\.be)\/\S+/i;

    const extractUrl = (raw) => {
        if (!raw) return null;
        const match = raw.match(YT_URL_REGEX);
        return match ? match[0] : null;
    };

    const isValidYouTubeUrl = (url) => {
        if (!url) return false;
        if (ytdlLib && typeof ytdlLib.validateURL === 'function') {
            try { return ytdlLib.validateURL(url); } catch (e) { return false; }
        }
        return YT_URL_REGEX.test(url);
    };

    const getVideoInfo = (url) => new Promise((resolve, reject) => {
        if (ytdlLib) {
            ytdlLib.getInfo(url).then((info) => {
                resolve({
                    channel: {
                        name: info.videoDetails.author.name,
                        user: info.videoDetails.author.user,
                        channelUrl: info.videoDetails.author.channel_url,
                        userUrl: info.videoDetails.author.user_url,
                        verified: info.videoDetails.author.verified,
                        subscriber: info.videoDetails.author.subscriber_count
                    },
                    video: {
                        title: info.videoDetails.title,
                        description: info.videoDetails.description,
                        lengthSeconds: parseInt(info.videoDetails.lengthSeconds || '0'),
                        videoUrl: info.videoDetails.video_url,
                        publishDate: info.videoDetails.publishDate,
                        viewCount: info.videoDetails.viewCount
                    }
                });
            }).catch(reject);
            return;
        }
        exec(`yt-dlp -J --no-warnings "${url.replace(/"/g, '\\"')}"`, { maxBuffer: 1024 * 1024 * 20 }, (err, stdout) => {
            if (err || !stdout) return reject(new Error('Could not fetch video info (install ytdl-core or yt-dlp).'));
            try {
                const d = JSON.parse(stdout);
                resolve({
                    channel: {
                        name: d.uploader || d.channel || 'Unknown',
                        user: d.channel_id || d.uploader_id || 'Unknown',
                        channelUrl: d.channel_url || d.uploader_url || '',
                        userUrl: d.uploader_url || '',
                        verified: false,
                        subscriber: d.channel_follower_count ? `${d.channel_follower_count} subscribers` : 'N/A'
                    },
                    video: {
                        title: d.title,
                        description: d.description,
                        lengthSeconds: d.duration || 0,
                        videoUrl: d.webpage_url || url,
                        publishDate: d.upload_date ? `${d.upload_date.slice(0, 4)}-${d.upload_date.slice(4, 6)}-${d.upload_date.slice(6, 8)}` : 'N/A',
                        viewCount: String(d.view_count || 0)
                    }
                });
            } catch (e) { reject(e); }
        });
    });

    const processVideoCommand = async (from, currentSession, subCmd, rawArgs) => {
        const url = extractUrl(rawArgs);

        if (subCmd === 'help' || (!url && !rawArgs)) {
            await sendMessageSafe(from, {
                text: `*${VIDEO_CONFIG.name}*\n\n` +
                      `[🎥] : *.video <youtube-url>*\n` +
                      `[🎧] : *.audio <youtube-url>*\n` +
                      `[ℹ️] : *.detail <youtube-url>*\n\n` +
                      `*Example :*\n.audio https://youtu.be/abcdefghij`
            });
            return;
        }

        if (!isValidYouTubeUrl(url)) {
            await sendMessageSafe(from, { text: `*[❎]* Failed!, Invalid YouTube URL` });
            return;
        }

        const timeStart = Date.now();
        await sendMessageSafe(from, { text: `[⏳] Loading..` });

        let data = null;
        try {
            data = await getVideoInfo(url);
        } catch (err) {
            await sendMessageSafe(from, { text: `*[❎]* Failed! ${err.message || ''}` });
            return;
        }

        // .detail command -> just print metadata (replica of detailYouTube)
        if (subCmd === 'detail') {
            await sendMessageSafe(from, {
                text: `*CHANNEL DETAILS*\n• Name : *${data.channel.name}*\n• User : *${data.channel.user}*\n• Verified : *${data.channel.verified}*\n• Channel : *${data.channel.channelUrl}*\n• Subscriber : *${data.channel.subscriber}*`
            });
            await sendMessageSafe(from, {
                text: `*VIDEO DETAILS*\n• Title : *${data.video.title}*\n• Seconds : *${data.video.lengthSeconds}*\n• VideoURL : *${data.video.videoUrl}*\n• Publish : *${data.video.publishDate}*\n• Viewers : *${data.video.viewCount}*`
            });
            await sendMessageSafe(from, { text: `*[✅]* Successfully!` });
            return;
        }

        const format = subCmd === 'audio' ? 'mp3' : 'mp4';
        const filter = format === 'mp3' ? 'audioonly' : 'audioandvideo';
        const safeTitle = (data.video.title || 'download').replace(/[^\w\s\-().]/g, '').slice(0, 60).trim().replace(/\s+/g, '_') || 'download';
        const baseName = `${VIDEO_CONFIG.filename[format]}_${safeTitle}_${Date.now()}`;
        const outPath = path.join(VIDEO_CONFIG.downloadDir, baseName);

        try {
            fs.mkdirSync(VIDEO_CONFIG.downloadDir, { recursive: true });
        } catch (e) {}

        const currentTaskId = Date.now();
        const taskObj = { id: currentTaskId, name: `${baseName}.${format}`, progress: 50, statusMsg: 'Downloading...', process: null, wasKilled: false, mode: 'video' };
        currentSession.tasks.push(taskObj);

        let finalFile = null;
        try {
            if (ytdlLib) {
                finalFile = `${outPath}.${format}`;
                await new Promise((resolve, reject) => {
                    const stream = ytdlLib(url, { filter, quality: format === 'mp3' ? 'highestaudio' : 'highest' })
                        .pipe(fs.createWriteStream(finalFile));
                    stream.on('finish', resolve);
                    stream.on('error', reject);
                    taskObj.process = { kill: () => { try { stream.destroy(); } catch (e) {} } };
                });
            } else {
                const proc = exec(
                    format === 'mp3'
                        ? `yt-dlp -f "bestaudio/best" -x --audio-format mp3 --audio-quality 0 -o "${outPath}.%(ext)s" --no-playlist --no-warnings "${url.replace(/"/g, '\\"')}"`
                        : `yt-dlp -f "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/best" -o "${outPath}.%(ext)s" --no-playlist --no-warnings "${url.replace(/"/g, '\\"')}"`
                );
                taskObj.process = proc;
                await new Promise((resolveP, rejectP) => {
                    proc.on('close', (code) => code === 0 ? resolveP() : rejectP(new Error('yt-dlp failed (is yt-dlp/ffmpeg installed?).')));
                    proc.on('error', rejectP);
                });
                const files = fs.readdirSync(VIDEO_CONFIG.downloadDir).filter(f => f.startsWith(baseName) && !f.endsWith('.part'));
                if (!files.length) throw new Error('Downloaded file not found.');
                finalFile = path.join(VIDEO_CONFIG.downloadDir, files[0]);
            }
        } catch (err) {
            currentSession.tasks = currentSession.tasks.filter(t => t.id !== currentTaskId);
            if (!taskObj.wasKilled) await sendMessageSafe(from, { text: `*[❎]* Failed! ${err.message || ''}` });
            return;
        }

        currentSession.tasks = currentSession.tasks.filter(t => t.id !== currentTaskId);
        if (taskObj.wasKilled) return;

        const timestamp = (Date.now() - timeStart) / 1000;
        const fileName = `${VIDEO_CONFIG.filename[format]}.${path.extname(finalFile).replace('.', '')}`;

        try {
            if (format === 'mp4' && data.video.lengthSeconds <= VIDEO_CONFIG.maxVideoSeconds) {
                await sendMessageSafe(from, {
                    video: { url: finalFile },
                    mimetype: 'video/mp4',
                    fileName,
                    caption: `🎥 *${data.video.title}*`
                });
            } else {
                await sendFileToUser(from, currentSession, finalFile);
            }
        } catch (sendErr) {
            await sendMessageSafe(from, { text: `⚠️ *Upload failed:* ${sendErr.message}. Trying as document...` });
            try { await sendFileToUser(from, currentSession, finalFile); } catch (e) {}
        }

        await sendMessageSafe(from, {
            text: `• Title : *${data.video.title}*\n` +
                  `• Channel : *${data.channel.user || data.channel.name}*\n` +
                  `• View Count : *${data.video.viewCount}*\n` +
                  `• TimeStamp : *${timestamp.toFixed(1)} seconds*`
        });
        await sendMessageSafe(from, { text: `*[✅]* Successfully!` });

        try { fs.unlinkSync(finalFile); } catch (e) {}
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
                        pendingGetPath: null,
                        pendingVideoUrl: null
                    };
                }
                const currentSession = sessions[from];

                // 4. STOP COMMAND (Global Reset)
                if (text === '.stop') {
                    currentSession.mode = 'normal';
                    currentSession.selectionStep = null;
                    currentSession.pendingGetPath = null;
                    currentSession.pendingVideoUrl = null;
                    currentSession.tasks = [];
                    await sendMessageSafe(from, { text: `✅ *MODE TERMINATED & RESET TO NORMAL*` });
                    continue;
                }

                // 5. MEDIA HANDLING (STRICTLY ONLY WHEN IN GET MODE)
                const isMedia = msgContent.imageMessage || msgContent.documentMessage || msgContent.videoMessage || msgContent.audioMessage || msgContent.stickerMessage;
                if (isMedia) {
                    // Allow captioned media to trigger VIDEO MODE commands (e.g. forwarded ".video <url>" caption)
                    const mediaCaption = (msgContent.imageMessage?.caption || msgContent.videoMessage?.caption || msgContent.documentMessage?.caption || '').trim();
                    const isVideoCmd = /^\.(video|audio|detail)(\s|$)/.test(mediaCaption);
                    if (currentSession.mode !== 'get' && !isVideoCmd) {
                        continue;
                    }
                    if (isVideoCmd && currentSession.mode !== 'get') {
                        const subCmd = mediaCaption.slice(1).split(/\s+/)[0];
                        const rawArgs = mediaCaption.slice(1 + subCmd.length).trim();
                        currentSession.mode = 'video';
                        await processVideoCommand(from, currentSession, subCmd, rawArgs);
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
                                   `🎬 *6. VIDEO MODE (YouTube Downloader)*\n` +
                                   `• Video: \`.video <youtube-url>\` (sends MP4)\n` +
                                   `• Audio: \`.audio <youtube-url>\` (sends MP3)\n` +
                                   `• Info: \`.detail <youtube-url>\` (channel & video metadata)\n\n` +
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

                // VIDEO MODE COMMANDS (.video / .audio / .detail) — YouTube downloader
                if (text === '.video' || text.startsWith('.video ') ||
                    text === '.audio' || text.startsWith('.audio ') ||
                    text === '.detail' || text.startsWith('.detail ')) {
                    const subCmd = text.slice(1).split(/\s+/)[0];          // video | audio | detail
                    const rawArgs = text.slice(1 + subCmd.length).trim();  // rest of the message
                    currentSession.mode = 'video';
                    if (!rawArgs) {
                        currentSession.pendingVideoUrl = null;
                        await sendMessageSafe(from, {
                            text: `🎬 *VIDEO MODE ACTIVATED*\n\n` +
                                  `👉 Send a YouTube link in your next message.`
                        });
                        continue;
                    }
                    await processVideoCommand(from, currentSession, subCmd, rawArgs);
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

                if (currentSession.mode === 'video') {
                    const targetUrl = extractUrl(text) || currentSession.pendingVideoUrl;
                    currentSession.pendingVideoUrl = null;
                    await processVideoCommand(from, currentSession, 'video', targetUrl || '');
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
