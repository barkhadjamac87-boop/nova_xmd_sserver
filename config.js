/**
 * NOVA XMD - Configuration File
 */

import path from 'path';
import os from 'os';

const isServerless = !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);

export const config = {
  // Bot Identity
  botName: process.env.BOT_NAME || 'NOVA XMD',
  version: '2.0.0',
  prefix: process.env.PREFIX || '.',
  
  // Owner Phone Number(s) - Format: countrycode + number (no +, no spaces)
  // Tusaale: '252611234567' (Halkan ku qor lambarkaaga WhatsApp)
  ownerNumbers: process.env.OWNER_NUMBERS 
    ? process.env.OWNER_NUMBERS.split(',').map(n => n.trim()) 
    : ['252611234567'],
  
  // Server Port for Express API
  port: process.env.PORT || 3000,
  
  // Storage Directory for Persistent Sessions (Folder-ka keydinta xogta isku-xirka)
  // In serverless environments (Vercel/Lambda), safely point to writable os.tmpdir()
  sessionDir: process.env.SESSION_DIR || (isServerless ? path.join(os.tmpdir(), 'nova_sessions') : './sessions'),
  
  // Anti View Once Settings
  antiViewOnce: {
    enabled: process.env.ANTI_VIEW_ONCE !== 'false',
    sendToOwner: true,         // U dir feylka milkiilaha chat-kiisa
    sendToSavedMessages: true,  // Bot-ku ha isugu diro chat-kiisa gaarka ah
    captionPrefix: '⚡ *[NOVA XMD - VIEW ONCE RECOVERED]*\n'
  },
  
  // Status Saver Settings
  statusSaver: {
    enabled: process.env.STATUS_SAVER !== 'false',
    // Trigger keywords marka qofka status-kiisa lagu soo jawaabo
    keywords: ['send', 'send me', 'ii soo dir', 'soo dir', 'yourself', 'status', 'save', 'dp']
  }
};
