/**
 * =========================================================================
 * NOVA XMD - WhatsApp Bot Backend & Pairing Code API
 * Powered by: @whiskeysockets/baileys & Express.js
 * =========================================================================
 */

import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import pino from 'pino';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  downloadContentFromMessage,
  Browsers
} from '@whiskeysockets/baileys';
import { config } from './config.js';
import { getRealtimeStats, recordUser, incrementStat } from './statsManager.js';
import QRCode from 'qrcode';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize Express App
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve frontend static files
app.use(express.static(__dirname));

// Logger setup (silent baileys logs to keep terminal clean)
const logger = pino({ level: 'silent' });

// Global Socket Reference & Connection State
let sock = null;
let isConnected = false;
let isConnecting = false;
let connectionState = 'disconnected'; // 'connected' | 'connecting' | 'disconnected'
let connectedPhone = null;
const botStartTime = Date.now();

// Global Live QR Code State
let latestQrString = null;
let latestQrDataUrl = null;
let qrTimestamp = 0;
let qrWaitingResolvers = [];

// Ensure sessions directory exists safely (resilient to serverless / read-only filesystem)
try {
  if (!fs.existsSync(config.sessionDir)) {
    fs.mkdirSync(config.sessionDir, { recursive: true });
  }
} catch (err) {
  console.warn('[NOVA XMD] Notice: sessionDir not writable at startup:', err.message);
}

/**
 * -------------------------------------------------------------------------
 * 1. CLEAN & SANITIZE PHONE NUMBER (E.164 Standard)
 * -------------------------------------------------------------------------
 */
function cleanPhoneNumber(phone, countryCode = '252') {
  if (!phone) return '';

  // 1. Ka saar wax kasta oo aan ahayn tirooyin (+, meelaha bannaan, xariiqyada)
  let digits = phone.toString().replace(/\D/g, '');
  let code = (countryCode || '252').toString().replace(/\D/g, '');

  // 2. Haddii uu hore ugu bilaabmay koodka dalka (tusaale: 25261xxxxxxx)
  if (digits.startsWith(code)) {
    const afterCode = digits.slice(code.length);
    if (afterCode.startsWith('0')) {
      digits = code + afterCode.replace(/^0+/, '');
    }
    return digits;
  }

  // 3. Ka saar eberka hore (Leading zero: 061xxxxxxx -> 61xxxxxxx)
  digits = digits.replace(/^0+/, '');

  // 4. Ku dar koodka dalka
  return code + digits;
}

/**
 * -------------------------------------------------------------------------
 * 2. INITIALIZE WHATSAPP SOCKET (BAILEYS MULTI-DEVICE)
 * -------------------------------------------------------------------------
 */
async function initWhatsAppSocket() {
  try {
    const { state, saveCreds } = await useMultiFileAuthState(config.sessionDir);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      logger,
      printQRInTerminal: false,
      auth: state,
      // Official Ubuntu Chrome signature - keeps WhatsApp happy
      browser: Browsers.ubuntu('Chrome'),
      markOnlineOnConnect: true,
      syncFullHistory: false,
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 15000
    });

    // Save session credentials on updates (Reboot-proof session persistence)
    sock.ev.on('creds.update', saveCreds);

    // Monitor Connection Updates
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      // 0. CONNECTING STATE
      if (connection === 'connecting') {
        isConnecting = true;
        connectionState = 'connecting';
        console.log('[NOVA XMD] 🔄 Isku xiraya WhatsApp Multi-Device servers...');
      }

      // 1. LIVE QR CODE GENERATOR (Baileys -> Base64 Data URL)
      if (qr) {
        latestQrString = qr;
        qrTimestamp = Date.now();
        console.log('[NOVA XMD] 📱 Live WhatsApp QR Code la helay! U beddelaya Base64...');
        try {
          latestQrDataUrl = await QRCode.toDataURL(qr, {
            scale: 8,
            margin: 2,
            color: {
              dark: '#0a061d',
              light: '#ffffff'
            }
          });

          // U dir dhammaan codsiyada sugaya QR-ka cusub
          while (qrWaitingResolvers.length > 0) {
            const resolver = qrWaitingResolvers.shift();
            resolver(latestQrDataUrl);
          }
        } catch (err) {
          console.error('[NOVA XMD] Error converting QR code to Base64:', err);
        }
      }

      // 2. CONNECTION CLOSED / DISCONNECTED
      if (connection === 'close') {
        isConnected = false;
        isConnecting = false;
        connectionState = 'disconnected';
        connectedPhone = null;
        latestQrString = null;
        latestQrDataUrl = null;

        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const isLoggedOut = statusCode === DisconnectReason.loggedOut;
        const shouldReconnect = !isLoggedOut;

        console.log(`[NOVA XMD] ❌ Connection closed. Status code: ${statusCode}, LoggedOut: ${isLoggedOut}`);

        if (isLoggedOut) {
          console.log('[NOVA XMD] 🗑️ WhatsApp session waa laga saaray (Logged Out). Tirtiraya folder-ka sessions...');
          try {
            fs.rmSync(config.sessionDir, { recursive: true, force: true });
            fs.mkdirSync(config.sessionDir, { recursive: true });
          } catch (e) {}
          sock = null;
        } else if (shouldReconnect) {
          console.log('[NOVA XMD] ⏳ Dib ugu xirmaya si otomaatig ah 3 ilbiriqsi gudahood...');
          setTimeout(() => initWhatsAppSocket(), 3000);
        }
      } 
      // 3. CONNECTION OPEN / ONLINE
      else if (connection === 'open') {
        isConnected = true;
        isConnecting = false;
        connectionState = 'connected';
        latestQrString = null;
        latestQrDataUrl = null;
        const botNumber = sock.user.id.split(':')[0].replace(/\D/g, '');
        connectedPhone = botNumber;
        recordUser(botNumber);

        console.log(`\n======================================================`);
        console.log(`⚡ [NOVA XMD] BOT-KU WAA ONLINE! (Connected: +${botNumber})`);
        console.log(`🛡️ Anti-View Once: ACTIVE`);
        console.log(`📥 Status Saver: ACTIVE`);
        console.log(`💾 Sessions Directory: "${config.sessionDir}" (Permanent)`);
        console.log(`======================================================\n`);
      }
    });

    // Setup Message Handlers
    setupMessageHandlers(sock);

    return sock;
  } catch (error) {
    console.error('[NOVA XMD] Socket Init Error:', error);
    throw error;
  }
}

/**
 * -------------------------------------------------------------------------
 * 3. REAL WHATSAPP PAIRING CODE GENERATOR (AUTHENTIC BAILEYS API)
 * -------------------------------------------------------------------------
 */
async function getPairingCode(phone, countryCode = '252') {
  const phoneNumber = cleanPhoneNumber(phone, countryCode);

  if (!phoneNumber || phoneNumber.length < 7) {
    throw new Error('Lambarka taleefanka waa mid aan sax ahayn.');
  }

  console.log(`[NOVA XMD] 🔑 Generating authentic WhatsApp Pairing Code for: +${phoneNumber}...`);

  // 1. Xir socket hore haddii uu socday
  if (sock) {
    try {
      sock.end();
    } catch (e) {}
    sock = null;
  }
  isConnected = false;
  isConnecting = false;

  // 2. Nadiifi sessions folder-ka si WhatsApp u soo saaro kood 100% cusub oo dhab ah
  try {
    if (fs.existsSync(config.sessionDir)) {
      fs.rmSync(config.sessionDir, { recursive: true, force: true });
    }
    fs.mkdirSync(config.sessionDir, { recursive: true });
  } catch (e) {
    console.error('[NOVA XMD] Error resetting session dir:', e.message);
  }

  // 3. Bilow Socket cusub oo nadiif ah
  await initWhatsAppSocket();

  // 4. Dalbo koodka WhatsApp Baileys adigoo sugaya socket-ka (2.5 ilbiriqsi)
  return new Promise((resolve, reject) => {
    const timerTimeout = setTimeout(() => {
      reject(new Error('WhatsApp server timeout. Fadlan hubi lambarka taleefanka iyo internet-ka.'));
    }, 25000);

    setTimeout(async () => {
      try {
        console.log(`[NOVA XMD] 📡 Dalbanaya requestPairingCode(+${phoneNumber})...`);
        const code = await sock.requestPairingCode(phoneNumber);
        clearTimeout(timerTimeout);

        if (!code) {
          throw new Error('WhatsApp ma soo celin kood. Fadlan hubi lambarka taleefanka.');
        }

        const formattedCode = code?.match(/.{1,4}/g)?.join('-') || code;

        console.log(`\n======================================================`);
        console.log(`🔑 [NOVA XMD] OFFICIAL WHATSAPP PAIRING CODE: ${formattedCode}`);
        console.log(`📱 Lambarka: +${phoneNumber}`);
        console.log(`======================================================\n`);

        resolve({
          code: formattedCode,
          rawCode: code,
          phone: phoneNumber
        });
      } catch (err) {
        clearTimeout(timerTimeout);
        console.error('[NOVA XMD] Error during requestPairingCode:', err);
        reject(err);
      }
    }, 2500);
  });
}

/**
 * -------------------------------------------------------------------------
 * 3.5 LIVE QR CODE GENERATOR (BAILEYS -> BASE64 IMAGE)
 * -------------------------------------------------------------------------
 */
async function getOrGenerateQr() {
  // 1. Haddii bot-ku mar hore xirnaa oo uu online yahay
  if (sock?.user && isConnected) {
    return {
      status: 'connected',
      connected: true,
      phone: sock.user.id.split(':')[0],
      message: 'WhatsApp mar hore buu ku xirmay NOVA XMD!'
    };
  }

  // 2. Haddii uu jiro QR cusub oo 18 ilbiriqsi ka yar
  const ageInSeconds = (Date.now() - qrTimestamp) / 1000;
  if (latestQrDataUrl && ageInSeconds < 18) {
    return {
      status: 'success',
      qr: latestQrDataUrl,
      expiresIn: Math.max(2, Math.round(20 - ageInSeconds))
    };
  }

  // 3. Hubi sessions aan dhammaystirnayn
  const credsPath = path.join(config.sessionDir, 'creds.json');
  if (fs.existsSync(credsPath)) {
    try {
      const creds = JSON.parse(fs.readFileSync(credsPath, 'utf-8'));
      if (!creds?.registered) {
        fs.rmSync(config.sessionDir, { recursive: true, force: true });
        fs.mkdirSync(config.sessionDir, { recursive: true });
      }
    } catch (e) {
      fs.rmSync(config.sessionDir, { recursive: true, force: true });
      fs.mkdirSync(config.sessionDir, { recursive: true });
    }
  }

  // 4. Bilow Socket cusub haddii uusan jirin ama xiran yahay
  if (!sock || !sock.ev) {
    await initWhatsAppSocket();
  }

  // 5. Sug ilaa inta QR-ka cusub ka soo baxayo
  return new Promise((resolve) => {
    let timeoutId;

    const resolver = (dataUrl) => {
      clearTimeout(timeoutId);
      resolve({
        status: 'success',
        qr: dataUrl,
        expiresIn: 20
      });
    };

    timeoutId = setTimeout(() => {
      const idx = qrWaitingResolvers.indexOf(resolver);
      if (idx > -1) qrWaitingResolvers.splice(idx, 1);
      if (latestQrDataUrl) {
        resolve({
          status: 'success',
          qr: latestQrDataUrl,
          expiresIn: 10
        });
      } else {
        resolve({
          status: 'waiting',
          message: 'Fadlan sug dhowr ilbiriqsi, QR-ka cusub ayaa soo baxaya...'
        });
      }
    }, 12000);

    qrWaitingResolvers.push(resolver);
  });
}

/**
 * Helper to download media safely via downloadContentFromMessage (stream) or downloadMediaMessage
 */
async function downloadMediaSafely(mediaContent, mediaTypeStr, rawMsg, ctxKey) {
  // Method 1: Direct stream decryption via downloadContentFromMessage (Most Reliable)
  try {
    const streamType = mediaTypeStr === 'videoMessage' ? 'video' : (mediaTypeStr === 'audioMessage' ? 'audio' : 'image');
    const stream = await downloadContentFromMessage(mediaContent, streamType);
    let buffer = Buffer.from([]);
    for await (const chunk of stream) {
      buffer = Buffer.concat([buffer, chunk]);
    }
    if (buffer && buffer.length > 0) {
      return buffer;
    }
  } catch (err1) {
    console.log('[NOVA XMD] Stream decryption info:', err1.message);
  }

  // Method 2: Fallback to downloadMediaMessage
  try {
    return await downloadMediaMessage(
      { key: ctxKey, message: rawMsg },
      'buffer',
      {},
      { logger }
    );
  } catch (err2) {
    console.error('[NOVA XMD] downloadMediaMessage fallback error:', err2.message);
    throw err2;
  }
}

/**
 * -------------------------------------------------------------------------
 * 4. MESSAGE HANDLERS: ANTI-VIEW ONCE & STATUS SAVER ("YOURSELF" & "SEND")
 * -------------------------------------------------------------------------
 */
function setupMessageHandlers(sock) {
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (!msg.message) continue;

      const remoteJid = msg.key.remoteJid;
      const isFromMe = !!msg.key.fromMe;

      // Bot-ka naftiisa (Connected Bot Number & "Message Yourself" JID)
      const botNumber = sock?.user?.id ? sock.user.id.split(':')[0].replace(/\D/g, '') : '';
      const botSelfJid = botNumber ? `${botNumber}@s.whatsapp.net` : null;

      // Milkiilaha laga qoray config.js
      const configuredOwnerNumber = config.ownerNumbers?.[0] ? config.ownerNumbers[0].replace(/\D/g, '') : '';
      const configuredOwnerJid = configuredOwnerNumber ? `${configuredOwnerNumber}@s.whatsapp.net` : null;

      // TARGET CHATS: KALIYA CHAT-KA GAARKA AH EE MILKIILAHA (YOURSELF / SAVED CHAT)
      // Marna laguma daro remoteJid si uusan media-ha ugu noqon qofkii lahaa ama broadcast
      const targetOwnerJids = new Set();
      if (botSelfJid) targetOwnerJids.add(botSelfJid);
      if (configuredOwnerJid) targetOwnerJids.add(configuredOwnerJid);

      // Aqoonsiga qofka fariinta soo diray ama kiciyay
      const rawSender = isFromMe 
        ? botNumber 
        : (msg.key.participant || remoteJid || '').split('@')[0].replace(/\D/g, '');

      const isOwner = isFromMe || 
        (botNumber && rawSender === botNumber) || 
        config.ownerNumbers.some(num => num.replace(/\D/g, '') === rawSender);

      // A. VIEW ONCE RECOVERY (SAWIRRO, MUUQAALLO, CODAD)
      const viewOnceMsg = 
        msg.message.viewOnceMessage?.message ||
        msg.message.viewOnceMessageV2?.message ||
        msg.message.viewOnceMessageV2Extension?.message;

      if (viewOnceMsg && config.antiViewOnce.enabled) {
        try {
          console.log(`[NOVA XMD] 👁️ View Once fariin ah laga helay: +${rawSender}`);
          const mediaType = Object.keys(viewOnceMsg)[0];
          const mediaContent = viewOnceMsg[mediaType];

          if (mediaContent) {
            const buffer = await downloadMediaMessage(
              { key: msg.key, message: viewOnceMsg },
              'buffer',
              {},
              { logger, reuploadRequest: sock.updateMediaMessage }
            );

            if (buffer && buffer.length > 0) {
              const originalCaption = mediaContent.caption || 'Qoraal ma wadan';
              const recoveryCaption = 
                `${config.antiViewOnce.captionPrefix}` +
                `• *Soo diraha:* +${rawSender}\n` +
                `• *From:* ${remoteJid.includes('@g.us') ? 'Group Chat' : 'Private DM'}\n` +
                `• *Nooca:* ${mediaType.replace('Message', '').toUpperCase()}\n` +
                `• *Qoraalka:* ${originalCaption}\n` +
                `• *Bot:* NOVA XMD Multi-Device Engine ⚡`;

              for (const targetJid of targetOwnerJids) {
                if (mediaType === 'imageMessage') {
                  await sock.sendMessage(targetJid, { image: buffer, caption: recoveryCaption });
                } else if (mediaType === 'videoMessage') {
                  await sock.sendMessage(targetJid, { 
                    video: buffer, 
                    caption: recoveryCaption, 
                    mimetype: mediaContent.mimetype || 'video/mp4' 
                  });
                } else if (mediaType === 'audioMessage') {
                  await sock.sendMessage(targetJid, { 
                    audio: buffer, 
                    mimetype: mediaContent.mimetype || 'audio/mp4', 
                    ptt: mediaContent.ptt || false 
                  });
                  await sock.sendMessage(targetJid, { 
                    text: `${recoveryCaption}\n_(Codka View Once-ka ah kor ka dhageyso)_` 
                  });
                }
              }

              console.log(`[NOVA XMD] View Once feylkiisii waxaa loo diray chat-ka milkiilaha!`);
              incrementStat('viewOnceSaved');
            }
          }
        } catch (err) {
          console.error('[NOVA XMD] Error in View Once recovery:', err.message);
        }
      }

      // B. STATUS SAVER LOGIC ("YOURSELF" & "SEND")
      if (config.statusSaver.enabled) {
        const textMessage = (
          msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          ''
        ).toLowerCase().trim();

        const triggerWords = ['yourself', 'send', 'send me', 'ii soo dir', 'soo dir', 'save', 'status'];
        const isTriggerWord = triggerWords.some(kw => 
          textMessage === kw || 
          textMessage.startsWith(kw + ' ') ||
          textMessage === `.${kw}` ||
          textMessage.startsWith(`.${kw} `)
        );

        const contextInfo = msg.message.extendedTextMessage?.contextInfo;

        if (contextInfo && isTriggerWord) {
          const quotedParticipant = contextInfo.participant || '';
          let quotedMsg = contextInfo.quotedMessage;

          if (quotedMsg) {
            // Ka saar (unwrap) wrappers-ka haddii ay jiraan
            if (quotedMsg.ephemeralMessage?.message) quotedMsg = quotedMsg.ephemeralMessage.message;
            if (quotedMsg.viewOnceMessage?.message) quotedMsg = quotedMsg.viewOnceMessage.message;
            if (quotedMsg.viewOnceMessageV2?.message) quotedMsg = quotedMsg.viewOnceMessageV2.message;

            const isVideo = !!quotedMsg.videoMessage;
            const isImage = !!quotedMsg.imageMessage;

            if (isVideo || isImage) {
              const mediaContent = isVideo ? quotedMsg.videoMessage : quotedMsg.imageMessage;
              const mediaType = isVideo ? 'videoMessage' : 'imageMessage';

              // Go'aami meesha loo dirayo:
              // 1. Haddii uu qofku ka soo diray taleefanka bot-ka u xiran (fromMe) ama owner:
              //    U dir chat-ka gaarka ah ee milkiilaha ("Message Yourself" / botSelfJid).
              // 2. Haddii qof kale uu DM ugu soo qoro "send": U dir qofkaas chat-kiisa (remoteJid).
              const sendToJids = new Set();
              if (isFromMe || isOwner) {
                if (botSelfJid) sendToJids.add(botSelfJid);
                if (configuredOwnerJid) sendToJids.add(configuredOwnerJid);
              } else if (remoteJid && remoteJid !== 'status@broadcast') {
                sendToJids.add(remoteJid);
              }

              console.log(`[NOVA XMD] 📥 Status Saver la kiciyay (${isVideo ? 'Video' : 'Sawir'}). Soo diraha: +${rawSender}`);

              try {
                // Soo deji buffer-ka iyadoo la adeegsanayo habka tooska ah ee la xaqiijiyay
                const buffer = await downloadMediaSafely(
                  mediaContent,
                  mediaType,
                  quotedMsg,
                  {
                    remoteJid: 'status@broadcast',
                    id: contextInfo.stanzaId,
                    participant: contextInfo.participant || quotedParticipant
                  }
                );

                if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) {
                  throw new Error('Media buffer ma soo degin ama waa madhan yahay.');
                }

                const fileSizeMB = (buffer.length / (1024 * 1024)).toFixed(2);
                const statusOwnerPhone = (contextInfo.participant || quotedParticipant || '').split('@')[0] || 'Unknown';
                const originalCaption = mediaContent.caption ? `\n• *Caption:* ${mediaContent.caption}` : '';

                const notice = 
                  `📥 *[NOVA XMD - STATUS SAVER]*\n` +
                  `• *Status Owner:* +${statusOwnerPhone}` +
                  originalCaption + `\n` +
                  `• *Baaxadda (Size):* ${fileSizeMB} MB\n` +
                  `• *Nooca:* ${isVideo ? '🎬 HD Video' : '🖼️ HD Sawir'}\n` +
                  `⚡ _Saved with NOVA XMD Multi-Device Engine_`;

                console.log(`[NOVA XMD] ✅ Status ${isVideo ? 'Video' : 'Image'} si buuxda buu u soo degay (${fileSizeMB} MB). Diraya...`);

                for (const targetJid of sendToJids) {
                  if (isVideo) {
                    await sock.sendMessage(targetJid, {
                      video: buffer,
                      caption: notice,
                      mimetype: mediaContent.mimetype || 'video/mp4',
                      fileName: `status_video_${Date.now()}.mp4`,
                      gifPlayback: false
                    });
                  } else {
                    await sock.sendMessage(targetJid, {
                      image: buffer,
                      caption: notice,
                      mimetype: mediaContent.mimetype || 'image/jpeg'
                    });
                  }
                }

                console.log(`[NOVA XMD] 🚀 Status media waxaa loo diray: ${[...sendToJids].join(', ')}`);
                incrementStat('statusSaved');
              } catch (err) {
                console.error('[NOVA XMD] Error downloading/sending status:', err.message);
              }
            }
          }
        }
      }

    }
  });
}

/**
 * -------------------------------------------------------------------------
 * 5. EXPRESS API ROUTE (/api/pair)
 * -------------------------------------------------------------------------
 */
app.get('/api/pair', async (req, res) => {
  const rawPhone = req.query.phone || req.query.number;
  const countryCode = req.query.country || req.query.code || '252';

  if (!rawPhone) {
    return res.status(400).json({ status: false, error: 'Fadlan geli lambarka taleefanka (phone).' });
  }

  try {
    const result = await getPairingCode(rawPhone, countryCode);

    if (result.phone) {
      recordUser(result.phone);
    }
    incrementStat('messagesHandled');

    if (result.alreadyConnected) {
      return res.json({
        status: true,
        alreadyConnected: true,
        message: 'Bot-ku mar hore buu ku xirmay WhatsApp!',
        number: result.number
      });
    }

    return res.json({
      status: true,
      code: result.code,        // e.g. "ABCD-1234"
      rawCode: result.rawCode,  // e.g. "ABCD1234"
      phone: result.phone,
      expiresIn: 120,
      message: 'Pairing code generated successfully! Enter this code in WhatsApp.'
    });
  } catch (error) {
    return res.status(500).json({
      status: false,
      error: 'Lama soo saari karin Pairing Code-ka.',
      details: error.message
    });
  }
});

// POST version of /api/pair
app.post('/api/pair', async (req, res) => {
  const rawPhone = req.body.phone || req.body.number;
  const countryCode = req.body.country || req.body.code || '252';

  if (!rawPhone) {
    return res.status(400).json({ status: false, error: 'Phone number is required' });
  }

  try {
    const result = await getPairingCode(rawPhone, countryCode);
    return res.json({
      status: true,
      code: result.code,
      rawCode: result.rawCode,
      phone: result.phone,
      expiresIn: 120
    });
  } catch (err) {
    return res.status(500).json({ status: false, error: err.message });
  }
});

// GET /api/qr - Generate or return live WhatsApp Baileys QR code
app.get('/api/qr', async (req, res) => {
  try {
    const result = await getOrGenerateQr();
    res.json(result);
  } catch (error) {
    console.error('[NOVA XMD] Error handling /api/qr:', error);
    res.status(500).json({
      status: 'error',
      message: 'Cillad ayaa dhacday inta la soo saarayay QR Code-ka.',
      details: error.message
    });
  }
});

// GET /api/qr/status - Check real-time connection status after QR scan
app.get('/api/qr/status', (req, res) => {
  res.json({
    status: 'success',
    connected: isConnected,
    phone: sock?.user?.id ? sock.user.id.split(':')[0] : null,
    hasQr: !!latestQrDataUrl,
    timestamp: Date.now()
  });
});

// GET /api/stats (Real-time dynamic stats: Active servers, Total users, Free slots)
app.get('/api/stats', (req, res) => {
  try {
    const stats = getRealtimeStats(isConnected, sock?.user?.id ? sock.user.id.split(':')[0] : null);
    res.json(stats);
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// GET /api/status (Comprehensive Real-time Connection State)
app.get('/api/status', (req, res) => {
  const currentPhone = sock?.user?.id ? sock.user.id.split(':')[0].replace(/\D/g, '') : connectedPhone;
  const hasCreds = fs.existsSync(path.join(config.sessionDir, 'creds.json'));
  const uptimeSeconds = Math.floor((Date.now() - botStartTime) / 1000);
  const uptimeStr = `${Math.floor(uptimeSeconds / 3600)}h ${Math.floor((uptimeSeconds % 3600) / 60)}m ${uptimeSeconds % 60}s`;

  res.json({
    status: 'success',
    botName: config.botName,
    version: config.version,
    online: isConnected,
    connected: isConnected,
    state: isConnected ? 'connected' : (isConnecting ? 'connecting' : 'disconnected'),
    phone: isConnected ? currentPhone : null,
    formattedPhone: (isConnected && currentPhone) ? `+${currentPhone}` : null,
    hasSession: hasCreds,
    uptime: uptimeStr,
    antiViewOnce: config.antiViewOnce.enabled,
    statusSaver: config.statusSaver.enabled,
    timestamp: Date.now()
  });
});

// POST /api/disconnect & /api/logout (Disconnect & Clear Sessions)
app.post(['/api/disconnect', '/api/logout'], async (req, res) => {
  try {
    console.log('[NOVA XMD] 🛑 Disconnect / Logout codsi ayaa yimid...');
    isConnected = false;
    isConnecting = false;
    connectionState = 'disconnected';
    connectedPhone = null;
    latestQrString = null;
    latestQrDataUrl = null;

    if (sock) {
      try {
        await sock.logout();
      } catch (e) {
        try { sock.end(); } catch (err) {}
      }
      sock = null;
    }

    // Clear sessions folder
    try {
      fs.rmSync(config.sessionDir, { recursive: true, force: true });
      fs.mkdirSync(config.sessionDir, { recursive: true });
    } catch (e) {}

    console.log('[NOVA XMD] ✅ Bot session si buuxda ayaa loo tirtiray oo loo xiray!');

    res.json({
      status: 'success',
      connected: false,
      state: 'disconnected',
      message: 'Bot-ka si guul leh ayaa looga saaray (Session cleared & Disconnected).'
    });
  } catch (err) {
    console.error('[NOVA XMD] Error during disconnect:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// POST /api/restart (Restart Session)
app.post(['/api/restart', '/api/reconnect'], async (req, res) => {
  try {
    console.log('[NOVA XMD] 🔄 Restart / Reconnect codsi ayaa yimid...');
    if (sock) {
      try { sock.end(); } catch (e) {}
      sock = null;
    }
    isConnected = false;
    isConnecting = false;
    connectionState = 'connecting';
    await initWhatsAppSocket();
    res.json({
      status: 'success',
      message: 'Bot socket restarted successfully!'
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// Check if running in a Serverless Environment (Vercel, AWS Lambda)
const isServerless = !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);

// Start HTTP Server when running as a standalone persistent service
if (!isServerless) {
  app.listen(config.port, () => {
    console.log(`\n======================================================`);
    console.log(`⚡ NOVA XMD Server & WhatsApp API running on:`);
    console.log(`🌐 Website URL:  http://localhost:${config.port}`);
    console.log(`📡 Pairing API:  http://localhost:${config.port}/api/pair?phone=615123456&country=252`);
    console.log(`======================================================\n`);

    // Auto-reconnect if session exists
    try {
      const credsPath = path.join(config.sessionDir, 'creds.json');
      if (fs.existsSync(credsPath)) {
        const creds = JSON.parse(fs.readFileSync(credsPath, 'utf-8'));
        if (creds && creds.registered) {
          console.log('[NOVA XMD] Session hore ayaa laga helay folder-ka "sessions"! Auto-reconnecting...');
          initWhatsAppSocket();
        }
      }
    } catch (e) {
      console.warn('[NOVA XMD] Session auto-reconnect error:', e.message);
    }
  });
}

// Export Express app for Vercel Serverless Functions
export default app;
