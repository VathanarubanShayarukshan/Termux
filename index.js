const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, downloadContentFromMessage } = require('@whiskeysockets/baileys');
const { exec } = require('child_process');
const readline = require('readline');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const question = (text) => new Promise((resolve) => rl.question(text, resolve));

async function startBot() {
    let phoneNumber = "";
    const { state, saveCreds } = await useMultiFileAuthState('auth_session');
    
    if (!state.creds || !state.creds.registered) {
        console.clear();
        console.log('===================================================');
        phoneNumber = await question('👉 Enter your WhatsApp number with country code:\n(Example: 94775955319)\n\nType here: ');
        phoneNumber = phoneNumber.replace(/[^0-9]/g, '');
        
        if (!phoneNumber) {
            console.log('❌ Invalid number format. Exiting...');
            process.exit(0);
        }
    }

    const { version } = await fetchLatestBaileysVersion();
    
    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: ["Mac OS", "Chrome", "10.15.7"],
        keepAliveIntervalMs: 30000,
        defaultQueryTimeoutMs: undefined,
        connectTimeoutMs: 60000
    });

    if (!sock.authState.creds.registered && phoneNumber) {
        setTimeout(async () => {
            try {
                const code = await sock.requestPairingCode(phoneNumber);
                console.log('\n===================================================');
                console.log(`🔑 YOUR VALID CODE IS: \x1b[1;32m${code}\x1b[0m`);
                console.log('===================================================');
                console.log('👉 Steps: Open WhatsApp -> Linked Devices -> Link with Phone Number.');
            } catch (err) {
                console.error('\n❌ Code request timed out. Please run "node index.js" again.');
                process.exit(0);
            }
        }, 4000);
    }

    sock.ev.on('creds.update', saveCreds);
    
    sock.ev.on('connection.update', (update) => {
        const { connection } = update;
        if (connection === 'close') {
            startBot();
        } else if (connection === 'open') {
            console.log('\n✅ System Connected! .run, .send, and .get are active.');
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        try {
            const msg = m.messages[0];
            if (!msg || !msg.message) return;

            const from = msg.key.remoteJid;
            const messageType = Object.keys(msg.message);
            
            let text = '';
            if (messageType.includes('conversation')) {
                text = msg.message.conversation;
            } else if (messageType.includes('extendedTextMessage')) {
                text = msg.message.extendedTextMessage.text;
            } else if (msg.message[messageType[0]]?.caption) {
                text = msg.message[messageType[0]].caption;
            }

            text = text.trim();

            // 1. COMMAND: .run <command>
            if (text.startsWith('.run ')) {
                const command = text.slice(5);
                exec(command, (err, stdout, stderr) => {
                    const response = stdout || stderr || err?.message || 'Executed with no terminal feedback.';
                    sock.sendMessage(from, { text: `💻 System Output:\n${response}` });
                });
                return;
            }

            // 2. COMMAND: .send <file_path>
            if (text.startsWith('.send ')) {
                const filePath = text.slice(6).replace(/['"]/g, '');
                
                if (!fs.existsSync(filePath)) {
                    return sock.sendMessage(from, { text: `❌ File not found at: ${filePath}` });
                }

                const fileName = path.basename(filePath);
                const fileBuffer = fs.readFileSync(filePath);

                let messageOptions = { document: fileBuffer, fileName: fileName, mimetype: 'application/octet-stream' };
                
                if (/\.(jpg|jpeg|png)$/i.test(fileName)) {
                    messageOptions = { image: fileBuffer, caption: fileName };
                } else if (/\.(mp4|3gp|mkv)$/i.test(fileName)) {
                    messageOptions = { video: fileBuffer, caption: fileName };
                } else if (/\.(mp3|wav|m4a|ogg)$/i.test(fileName)) {
                    messageOptions = { audio: fileBuffer, mimetype: 'audio/mp4' };
                }

                await sock.sendMessage(from, messageOptions);
                return;
            }

            // 3. COMMAND: .get <file_save_location> [attached file]
            if (text.startsWith('.get')) {
                const isImage = messageType.includes('imageMessage');
                const isVideo = messageType.includes('videoMessage');
                const isAudio = messageType.includes('audioMessage');
                const isDoc = messageType.includes('documentMessage');
                
                const streamType = isImage ? 'image' : isVideo ? 'video' : isAudio ? 'audio' : isDoc ? 'document' : null;

                if (!streamType) {
                    return sock.sendMessage(from, { text: '❌ Please type `.get <location>` in the caption of a file attachment.' });
                }

                let savePath = text.slice(4).trim().replace(/['"]/g, '');
                const mediaMessage = msg.message[streamType + 'Message'];
                const originalName = mediaMessage.fileName || `file_${Date.now()}.${mediaMessage.mimetype?.split('/')[1] || 'bin'}`;

                // போல்டர் மேனேஜ்மென்ட்
                if (!savePath) {
                    savePath = originalName;
                } else if (!path.extname(savePath)) { 
                    if (!fs.existsSync(savePath)) {
                        fs.mkdirSync(savePath, { recursive: true });
                    }
                    savePath = path.join(savePath, originalName);
                } else {
                    const dir = path.dirname(savePath);
                    if (dir !== '.' && !fs.existsSync(dir)) {
                        fs.mkdirSync(dir, { recursive: true });
                    }
                }

                // டவுன்லோடிங் மெசேஜ் நீக்கப்பட்டுள்ளது (SILENT DOWNLOAD)

                const stream = await downloadContentFromMessage(mediaMessage, streamType);
                let buffer = Buffer.from([]);
                for await (const chunk of stream) {
                    buffer = Buffer.concat([buffer, chunk]);
                }

                fs.writeFileSync(savePath, buffer);
                
                // பதிவிறக்கம் முடிந்தவுடன் மட்டும் மெசேஜ் அனுப்பும்
                await sock.sendMessage(from, { text: `✅ File successfully saved at:\n*${savePath}*` });
                return;
            }

        } catch (error) {
            console.error(error);
        }
    });
}

startBot();
