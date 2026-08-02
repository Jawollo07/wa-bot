require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const mysql = require('mysql2/promise');
const { execSync } = require('child_process');

try {
    console.log('🔄 Prüfe Chrome-Installation für Puppeteer...');
    execSync('npx puppeteer browsers install chrome', { stdio: 'inherit' });
} catch (error) {
    console.error('❌ Fehler beim Installieren von Chrome:', error.message || error);
}

const PREFIX = process.env.COMMAND_PREFIX || '!';

const CONFIG = {
    phoneNumber: process.env.PHONE_NUMBER,
    botOwners: (process.env.BOT_OWNERS || process.env.PHONE_NUMBER || '')
        .split(',')
        .map(s => s.trim().replace(/\D/g, ''))
        .filter(Boolean),
    db: {
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_DATABASE,
        port: Number(process.env.DB_PORT) || 3306
    },
    defaultSettings: {
        isActive: false,
        maxWarnings: 3,
        allowLinks: false,
        allowStickers: false,
        allowImages: true,
        allowVideos: true,
        allowAudios: true,
        antiSpam: true,
        welcomeActive: false,
        welcomeMsg: 'Willkommen in der Gruppe, @user! 👋',
        leaveMsg: 'Ein Nutzer hat die Gruppe verlassen. 😢'
    },
    spamLimit: {
        maxMessages: Number(process.env.SPAM_MAX_MESSAGES) || 5,
        timeFrameMs: Number(process.env.SPAM_TIMEFRAME_MS) || 5000
    },
    wordUrls: [
        'https://raw.githubusercontent.com/AdvancedPlugins/Chat/main/swear%20words/en.json',
        'https://raw.githubusercontent.com/AdvancedPlugins/Chat/main/swear%20words/de.json',
        'https://raw.githubusercontent.com/AdvancedPlugins/Chat/main/swear%20words/lt.json',
        'https://raw.githubusercontent.com/AdvancedPlugins/Chat/main/swear%20words/es.json'
    ]
};

let dbPool;
let loadedBadWords = [];
const messageTimestamps = new Map();
const chatCache = new Map();
const CHAT_CACHE_TTL = 60000;
let pairingCodeRequested = false;
let botStartTime = Date.now();
let stats = { messages: 0, violations: 0, commands: 0 };

process.on('unhandledRejection', (reason) => console.error('[unhandledRejection]', reason));
process.on('uncaughtException', (err) => console.error('[uncaughtException]', err));

function log(...args) {
    const t = new Date().toISOString().slice(11, 19);
    console.log('[' + t + ']', ...args);
}

function isBotOwner(senderId) {
    if (!senderId) return false;
    const num = String(senderId).replace(/\D/g, '');
    return CONFIG.botOwners.some(owner => num.includes(owner) || owner.includes(num));
}

function cacheChat(groupId, chat) {
    if (chat) chatCache.set(groupId, { chat, ts: Date.now() });
}

function getCachedChat(groupId) {
    const entry = chatCache.get(groupId);
    if (!entry) return null;
    if (Date.now() - entry.ts > CHAT_CACHE_TTL) {
        chatCache.delete(groupId);
        return null;
    }
    return entry.chat;
}

async function getChatSafe(msg, maxAttempts = 3) {
    const chatId = msg.from;
    const cached = getCachedChat(chatId);
    if (cached) return cached;
    let lastError;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            if (client.interface && client.interface.openChatWindow) {
                await client.interface.openChatWindow(chatId);
                await new Promise(r => setTimeout(r, 300));
            }
        } catch (_) {}
        try {
            const chat = await msg.getChat();
            if (chat) { cacheChat(chatId, chat); return chat; }
        } catch (err) { lastError = err; }
        try {
            const chat = await client.getChatById(chatId);
            if (chat) { cacheChat(chatId, chat); return chat; }
        } catch (err) { lastError = err; }
        try {
            const chatData = await client.pupPage.evaluate(async (id) => {
                const chat = (window.Store && window.Store.Chat && window.Store.Chat.get(id))
                    || (window.Store && window.Store.Chat && window.Store.Chat.find && window.Store.Chat.find(id))
                    || (window.WWebJS && window.WWebJS.getChat && await window.WWebJS.getChat(id, { getAsModel: false }));
                if (!chat) return null;
                const parts = (chat.groupMetadata && chat.groupMetadata.participants && chat.groupMetadata.participants.getModelsArray && chat.groupMetadata.participants.getModelsArray())
                    || (chat.groupMetadata && chat.groupMetadata.participants)
                    || [];
                return {
                    name: chat.formattedTitle || chat.name || id,
                    participants: parts.map(p => ({
                        id: p.id,
                        isAdmin: !!(p.isAdmin || p.isSuperAdmin),
                        isSuperAdmin: !!p.isSuperAdmin
                    }))
                };
            }, chatId);
            if (chatData) {
                const proxy = {
                    id: { _serialized: chatId },
                    name: chatData.name,
                    isGroup: true,
                    participants: (chatData.participants || []).map(p => ({
                        id: { _serialized: (p.id && p.id._serialized) || p.id },
                        isAdmin: p.isAdmin,
                        isSuperAdmin: p.isSuperAdmin
                    })),
                    sendMessage: (content, options) => client.sendMessage(chatId, content, options),
                    removeParticipants: async (ids) => {
                        const c = await client.getChatById(chatId);
                        return c.removeParticipants(ids);
                    },
                    setMessagesAdminsOnly: async (flag) => {
                        const c = await client.getChatById(chatId);
                        return c.setMessagesAdminsOnly(flag);
                    }
                };
                cacheChat(chatId, proxy);
                return proxy;
            }
        } catch (err) { lastError = err; }
        log('⚠️ getChat ' + attempt + '/' + maxAttempts + ': ' + (lastError && lastError.message || lastError || 'unknown'));
        if (attempt < maxAttempts) await new Promise(r => setTimeout(r, 600 * attempt));
    }
    throw lastError || new Error('Chat konnte nicht geladen werden');
}

async function ensureColumn(table, column, definition) {
    try {
        const [rows] = await dbPool.query(
            'SELECT COUNT(*) AS cnt FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
            [table, column]
        );
        if (rows[0].cnt === 0) {
            await dbPool.query('ALTER TABLE `' + table + '` ADD COLUMN `' + column + '` ' + definition);
            log('  ➕ ' + table + '.' + column);
        }
    } catch (err) {
        try {
            await dbPool.query('ALTER TABLE `' + table + '` ADD COLUMN `' + column + '` ' + definition);
            log('  ➕ ' + table + '.' + column);
        } catch (e) {
            if (!String(e.message || e).includes('Duplicate column')) {
                console.error('  ⚠️ Migration ' + table + '.' + column + ':', e.message || e);
            }
        }
    }
}

async function initDatabase() {
    dbPool = mysql.createPool({ ...CONFIG.db, waitForConnections: true, connectionLimit: 10, queueLimit: 0 });
    await dbPool.query('CREATE TABLE IF NOT EXISTS bad_words (id INT AUTO_INCREMENT PRIMARY KEY, word VARCHAR(191) UNIQUE NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');
    await dbPool.query('CREATE TABLE IF NOT EXISTS warnings (id INT AUTO_INCREMENT PRIMARY KEY, group_id VARCHAR(191) NOT NULL, user_id VARCHAR(191) NOT NULL, warn_count INT DEFAULT 1, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, UNIQUE KEY unique_user_group (group_id, user_id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');
    await dbPool.query('CREATE TABLE IF NOT EXISTS group_settings (group_id VARCHAR(191) PRIMARY KEY, is_active TINYINT(1) DEFAULT 0, allow_links TINYINT(1) DEFAULT 0, allow_stickers TINYINT(1) DEFAULT 0, allow_images TINYINT(1) DEFAULT 1, allow_videos TINYINT(1) DEFAULT 1, allow_audios TINYINT(1) DEFAULT 1, anti_spam TINYINT(1) DEFAULT 1, max_warnings INT DEFAULT 3, welcome_active TINYINT(1) DEFAULT 0, welcome_msg TEXT, leave_msg TEXT) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');
    log('🔄 Prüfe group_settings-Schema...');
    await ensureColumn('group_settings', 'is_active', 'TINYINT(1) DEFAULT 0');
    await ensureColumn('group_settings', 'allow_links', 'TINYINT(1) DEFAULT 0');
    await ensureColumn('group_settings', 'allow_stickers', 'TINYINT(1) DEFAULT 0');
    await ensureColumn('group_settings', 'allow_images', 'TINYINT(1) DEFAULT 1');
    await ensureColumn('group_settings', 'allow_videos', 'TINYINT(1) DEFAULT 1');
    await ensureColumn('group_settings', 'allow_audios', 'TINYINT(1) DEFAULT 1');
    await ensureColumn('group_settings', 'anti_spam', 'TINYINT(1) DEFAULT 1');
    await ensureColumn('group_settings', 'max_warnings', 'INT DEFAULT 3');
    await ensureColumn('group_settings', 'welcome_active', 'TINYINT(1) DEFAULT 0');
    await ensureColumn('group_settings', 'welcome_msg', 'TEXT');
    await ensureColumn('group_settings', 'leave_msg', 'TEXT');
    await dbPool.query('CREATE TABLE IF NOT EXISTS mod_logs (id INT AUTO_INCREMENT PRIMARY KEY, group_id VARCHAR(191) NOT NULL, user_id VARCHAR(191) NOT NULL, action VARCHAR(50) NOT NULL, reason TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, INDEX idx_group (group_id), INDEX idx_created (created_at)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');
    await dbPool.query('CREATE TABLE IF NOT EXISTS muted_users (group_id VARCHAR(191) NOT NULL, user_id VARCHAR(191) NOT NULL, muted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (group_id, user_id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');
    log('✅ MySQL-Datenbank erfolgreich initialisiert!');
}

async function syncAndLoadBadWords() {
    log('🔄 Synchronisiere Schimpfwörter...');
    const wordsSet = new Set();
    for (const url of CONFIG.wordUrls) {
        try {
            const response = await fetch(url);
            if (!response.ok) continue;
            const data = await response.json();
            let rawWords = Array.isArray(data) ? data : (typeof data === 'object' ? Object.values(data).flat() : []);
            for (const word of rawWords) {
                if (typeof word === 'string' && word.trim().length > 1) wordsSet.add(word.trim().toLowerCase());
            }
        } catch (_) {}
    }
    if (wordsSet.size > 0) {
        const connection = await dbPool.getConnection();
        try {
            await connection.beginTransaction();
            for (const word of wordsSet) await connection.query('INSERT IGNORE INTO bad_words (word) VALUES (?)', [word]);
            await connection.commit();
        } catch (err) { await connection.rollback(); }
        finally { connection.release(); }
    }
    await reloadBadWordsCache();
}

async function reloadBadWordsCache() {
    const [rows] = await dbPool.query('SELECT word FROM bad_words');
    loadedBadWords = rows.map(r => r.word);
    log('✅ ' + loadedBadWords.length + ' Schimpfwörter geladen.');
}

async function getGroupSettings(groupId) {
    const [rows] = await dbPool.query('SELECT * FROM group_settings WHERE group_id = ?', [groupId]);
    if (rows.length === 0) {
        const d = CONFIG.defaultSettings;
        await dbPool.query('INSERT INTO group_settings (group_id, is_active, allow_links, allow_stickers, allow_images, allow_videos, allow_audios, anti_spam, max_warnings, welcome_active, welcome_msg, leave_msg) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [groupId, d.isActive ? 1 : 0, d.allowLinks ? 1 : 0, d.allowStickers ? 1 : 0, d.allowImages ? 1 : 0, d.allowVideos ? 1 : 0, d.allowAudios ? 1 : 0, d.antiSpam ? 1 : 0, d.maxWarnings, d.welcomeActive ? 1 : 0, d.welcomeMsg, d.leaveMsg]);
        return { ...d, groupId };
    }
    const r = rows[0];
    return {
        groupId: r.group_id,
        isActive: Boolean(r.is_active),
        allowLinks: Boolean(r.allow_links),
        allowStickers: Boolean(r.allow_stickers),
        allowImages: r.allow_images === undefined ? true : Boolean(r.allow_images),
        allowVideos: r.allow_videos === undefined ? true : Boolean(r.allow_videos),
        allowAudios: r.allow_audios === undefined ? true : Boolean(r.allow_audios),
        antiSpam: r.anti_spam === undefined ? true : Boolean(r.anti_spam),
        maxWarnings: r.max_warnings != null ? r.max_warnings : CONFIG.defaultSettings.maxWarnings,
        welcomeActive: Boolean(r.welcome_active),
        welcomeMsg: r.welcome_msg || CONFIG.defaultSettings.welcomeMsg,
        leaveMsg: r.leave_msg || CONFIG.defaultSettings.leaveMsg
    };
}

async function logAction(groupId, userId, action, reason) {
    await dbPool.query('INSERT INTO mod_logs (group_id, user_id, action, reason) VALUES (?, ?, ?, ?)', [groupId, userId, action, reason]);
}

function isSpamming(groupId, userId) {
    const key = groupId + '_' + userId;
    const now = Date.now();
    let timestamps = messageTimestamps.get(key) || [];
    timestamps = timestamps.filter(ts => now - ts < CONFIG.spamLimit.timeFrameMs);
    timestamps.push(now);
    messageTimestamps.set(key, timestamps);
    return timestamps.length > CONFIG.spamLimit.maxMessages;
}

async function addWarning(groupId, userId) {
    await dbPool.query('INSERT INTO warnings (group_id, user_id, warn_count) VALUES (?, ?, 1) ON DUPLICATE KEY UPDATE warn_count = warn_count + 1', [groupId, userId]);
    const [rows] = await dbPool.query('SELECT warn_count FROM warnings WHERE group_id = ? AND user_id = ?', [groupId, userId]);
    return rows[0] ? rows[0].warn_count : 1;
}

async function resetWarnings(groupId, userId) {
    await dbPool.query('DELETE FROM warnings WHERE group_id = ? AND user_id = ?', [groupId, userId]);
}

async function getWarningCount(groupId, userId) {
    const [rows] = await dbPool.query('SELECT warn_count FROM warnings WHERE group_id = ? AND user_id = ?', [groupId, userId]);
    return rows[0] ? rows[0].warn_count : 0;
}

async function isMuted(groupId, userId) {
    const [rows] = await dbPool.query('SELECT 1 FROM muted_users WHERE group_id = ? AND user_id = ?', [groupId, userId]);
    return rows.length > 0;
}

function containsBadWords(text) {
    if (!text) return false;
    const lowerText = text.toLowerCase();
    return loadedBadWords.some(word => {
        const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp('\\b' + escaped + '\\b', 'i').test(lowerText);
    });
}

function isParticipantAdmin(chat, userId) {
    if (!chat || !chat.participants) return false;
    const p = chat.participants.find(x => x.id._serialized === userId);
    return p ? !!(p.isAdmin || p.isSuperAdmin) : false;
}

function formatUptime(ms) {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return h + 'h ' + m + 'm ' + sec + 's';
}

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-accelerated-2d-canvas', '--no-first-run', '--no-zygote', '--disable-gpu']
    }
});

client.on('qr', async () => {
    if (!pairingCodeRequested && CONFIG.phoneNumber) {
        pairingCodeRequested = true;
        try {
            const code = await client.requestPairingCode(CONFIG.phoneNumber);
            console.log('\n🔑 DEIN KOPPLUNGSCODE: ' + code + '\n');
        } catch (err) {
            console.error('❌ Fehler Kopplungscode:', err);
        }
    }
});

client.on('authenticated', () => log('🔐 Authentifiziert'));
client.on('auth_failure', (m) => console.error('❌ Auth fehlgeschlagen:', m));
client.on('disconnected', (r) => log('🔌 Getrennt:', r));
client.on('ready', () => {
    botStartTime = Date.now();
    log('🤖 Moderations-Bot v2.1.0 ist einsatzbereit!');
});

client.on('group_join', async (notification) => {
    try {
        const groupId = notification.chatId;
        const settings = await getGroupSettings(groupId);
        if (!settings.isActive || !settings.welcomeActive) return;
        for (const userId of notification.recipientIds) {
            try {
                const contact = await client.getContactById(userId);
                const text = settings.welcomeMsg.replace(/@user/gi, '@' + contact.number);
                await client.sendMessage(groupId, text, { mentions: [contact] });
            } catch (e) {
                console.error('Welcome fehlgeschlagen:', e.message || e);
            }
        }
    } catch (err) {
        console.error('group_join:', err.message || err);
    }
});

client.on('group_leave', async (notification) => {
    try {
        const groupId = notification.chatId;
        const settings = await getGroupSettings(groupId);
        if (!settings.isActive || !settings.welcomeActive) return;
        await client.sendMessage(groupId, settings.leaveMsg);
    } catch (err) {
        console.error('group_leave:', err.message || err);
    }
});

client.on('message', async (msg) => {
    if (!msg.from.endsWith('@g.us')) return;
    if (msg.fromMe) return;
    stats.messages++;
    log('📩 "' + (msg.body || ('[' + msg.type + ']')) + '"');
    try {
        const groupId = msg.from;
        const senderId = msg.author || msg.from;
        const text = msg.body || '';
        const settings = await getGroupSettings(groupId);
        let chat = null;
        try { chat = await getChatSafe(msg); } catch (_) { log('⚠️ Chat-Fallback aktiv'); }
        let isAdmin = isBotOwner(senderId) || isParticipantAdmin(chat, senderId);
        if (isAdmin && text.startsWith(PREFIX)) {
            const handled = await handleAdminCommands(msg, chat, settings, groupId);
            if (handled) {
                stats.commands++;
                log('✅ Admin-Befehl ausgeführt');
                return;
            }
        }
        if (!settings.isActive) {
            log('🔴 Bot inaktiv');
            return;
        }
        if (await isMuted(groupId, senderId)) {
            try { await msg.delete(true); } catch (e) { console.error('Mute-Löschen:', e.message || e); }
            return;
        }
        let violationReason = null;
        if (settings.antiSpam && isSpamming(groupId, senderId)) violationReason = 'Spam-Schutz: Zu viele Nachrichten.';
        if (!violationReason) {
            if (!settings.allowStickers && msg.type === 'sticker') violationReason = 'Sticker deaktiviert.';
            else if (!settings.allowImages && msg.type === 'image') violationReason = 'Bilder deaktiviert.';
            else if (!settings.allowVideos && msg.type === 'video') violationReason = 'Videos deaktiviert.';
            else if (!settings.allowAudios && (msg.type === 'audio' || msg.type === 'ptt')) violationReason = 'Audios deaktiviert.';
        }
        if (!violationReason && !settings.allowLinks && text && /(https?:\/\/[^\s]+|chat\.whatsapp\.com\/[a-zA-Z0-9]+)/i.test(text)) {
            violationReason = 'Links sind nicht gestattet.';
        }
        if (!violationReason && text && containsBadWords(text)) violationReason = 'Schimpfwort erkannt.';
        if (violationReason) {
            stats.violations++;
            log('🚨 ' + violationReason + (isAdmin ? ' (Admin)' : ''));
            await handleViolation(msg, chat, groupId, senderId, violationReason, settings.maxWarnings, isAdmin);
        }
    } catch (error) {
        console.error('⚠️ Handler-Fehler:', error.stack || error);
    }
});

async function handleViolation(msg, chat, groupId, senderId, reason, maxWarnings, isAdmin) {
    try {
        try { await msg.delete(true); } catch (e) { console.error('Löschen fehlgeschlagen:', e.message || e); }
        const currentWarns = await addWarning(groupId, senderId);
        await logAction(groupId, senderId, 'WARN', reason);
        const number = senderId.split('@')[0].replace(/\D/g, '');
        if (currentWarns >= maxWarnings) {
            if (isAdmin || isParticipantAdmin(chat, senderId)) {
                await client.sendMessage(groupId, '⛔ @' + number + ' hat max. Verwarnungen erreicht, wird als **Admin** nicht gekickt.\n**Grund:** ' + reason, { mentions: [senderId] });
                await resetWarnings(groupId, senderId);
                await logAction(groupId, senderId, 'WARN_MAX_ADMIN', reason);
                return;
            }
            await client.sendMessage(groupId, '⛔ @' + number + ' wurde automatisch gekickt.\n**Grund:** Maximale Verwarnungen erreicht.', { mentions: [senderId] });
            if (chat && chat.removeParticipants) {
                try { await chat.removeParticipants([senderId]); } catch (e) { console.error('Kick fehlgeschlagen:', e.message || e); }
            }
            await resetWarnings(groupId, senderId);
            await logAction(groupId, senderId, 'KICK', 'Maximale Verwarnungen erreicht');
        } else {
            await client.sendMessage(groupId, '⚠️ @' + number + ', deine Nachricht wurde entfernt.\n**Grund:** ' + reason + '\n**Verwarnung:** ' + currentWarns + '/' + maxWarnings, { mentions: [senderId] });
        }
    } catch (err) {
        console.error('Moderationsfehler:', err);
    }
}

async function safeReply(msg, groupId, text, options) {
    options = options || {};
    try {
        if (msg.reply) { await msg.reply(text, undefined, options); return; }
    } catch (_) {}
    await client.sendMessage(groupId, text, options);
}

async function handleAdminCommands(msg, chat, settings, groupId) {
    const args = msg.body.trim().split(/\s+/);
    const command = args[0].toLowerCase();
    const p = PREFIX;

    if (command === p + 'bot') {
        const action = args[1] && args[1].toLowerCase();
        if (action === 'on' || action === 'off') {
            const state = action === 'on' ? 1 : 0;
            await dbPool.query('UPDATE group_settings SET is_active = ? WHERE group_id = ?', [state, groupId]);
            await safeReply(msg, groupId, state ? '🟢 **Bot aktiviert!**' : '🔴 **Bot deaktiviert!**');
            return true;
        }
        await safeReply(msg, groupId, 'ℹ️ Status: **' + (settings.isActive ? '🟢 AKTIV' : '🔴 INAKTIV') + '**');
        return true;
    }
    if (command === p + 'ping') {
        const t0 = Date.now();
        await safeReply(msg, groupId, '🏓 Pong! (' + (Date.now() - t0) + 'ms) | Uptime: ' + formatUptime(Date.now() - botStartTime));
        return true;
    }
    if (command === p + 'info') {
        await safeReply(msg, groupId, '🤖 **wa-bot v2.1.0**\n• Uptime: ' + formatUptime(Date.now() - botStartTime) + '\n• Nachrichten (Session): ' + stats.messages + '\n• Verstöße (Session): ' + stats.violations + '\n• Befehle (Session): ' + stats.commands + '\n• Schimpfwörter: ' + loadedBadWords.length + '\n• Gruppe: ' + (settings.isActive ? '🟢 aktiv' : '🔴 inaktiv'));
        return true;
    }
    if (command === p + 'stats') {
        const [warnRows] = await dbPool.query('SELECT COUNT(*) AS c, COALESCE(SUM(warn_count),0) AS total FROM warnings WHERE group_id = ?', [groupId]);
        const [muteRows] = await dbPool.query('SELECT COUNT(*) AS c FROM muted_users WHERE group_id = ?', [groupId]);
        const [logRows] = await dbPool.query('SELECT COUNT(*) AS c FROM mod_logs WHERE group_id = ? AND created_at > DATE_SUB(NOW(), INTERVAL 24 HOUR)', [groupId]);
        const warnRow = warnRows[0];
        const muteRow = muteRows[0];
        const logRow = logRows[0];
        await safeReply(msg, groupId, '📊 **Gruppen-Statistik**\n• Verwarnte User: ' + warnRow.c + '\n• Summe Verwarnungen: ' + warnRow.total + '\n• Stummgeschaltet: ' + muteRow.c + '\n• Mod-Aktionen (24h): ' + logRow.c + '\n• Max. Warns: ' + settings.maxWarnings);
        return true;
    }
    if (command === p + 'lock') {
        if (chat && chat.setMessagesAdminsOnly) {
            await chat.setMessagesAdminsOnly(true);
            await safeReply(msg, groupId, '🔒 **Gruppe gesperrt.** Nur noch Admins können schreiben.');
        } else await safeReply(msg, groupId, '⚠️ Chat-Objekt nicht verfügbar.');
        return true;
    }
    if (command === p + 'unlock') {
        if (chat && chat.setMessagesAdminsOnly) {
            await chat.setMessagesAdminsOnly(false);
            await safeReply(msg, groupId, '🔓 **Gruppe entsperrt.**');
        } else await safeReply(msg, groupId, '⚠️ Chat-Objekt nicht verfügbar.');
        return true;
    }
    if (command === p + 'mute' || command === p + 'unmute') {
        const mentions = await msg.getMentions().catch(() => []);
        if (mentions.length === 0) {
            await safeReply(msg, groupId, '⚠️ Nutzung: `' + command + ' @User`');
            return true;
        }
        const target = mentions[0].id._serialized;
        if (command === p + 'mute') {
            if (isParticipantAdmin(chat, target) || isBotOwner(target)) {
                await safeReply(msg, groupId, '⚠️ Admins/Owner können nicht stummgeschaltet werden.');
                return true;
            }
            await dbPool.query('INSERT IGNORE INTO muted_users (group_id, user_id) VALUES (?, ?)', [groupId, target]);
            await logAction(groupId, target, 'MUTE', 'Manuell');
            await safeReply(msg, groupId, '🤫 @' + mentions[0].number + ' stummgeschaltet.', { mentions: [mentions[0]] });
        } else {
            await dbPool.query('DELETE FROM muted_users WHERE group_id = ? AND user_id = ?', [groupId, target]);
            await logAction(groupId, target, 'UNMUTE', 'Manuell');
            await safeReply(msg, groupId, '🔊 @' + mentions[0].number + ' darf wieder schreiben.', { mentions: [mentions[0]] });
        }
        return true;
    }
    if (command === p + 'muted') {
        const [rows] = await dbPool.query('SELECT user_id FROM muted_users WHERE group_id = ?', [groupId]);
        if (rows.length === 0) {
            await safeReply(msg, groupId, '📋 Niemand ist stummgeschaltet.');
            return true;
        }
        const list = rows.map(r => '• ' + r.user_id.split('@')[0]).join('\n');
        await safeReply(msg, groupId, '📋 **Stummgeschaltet (' + rows.length + '):**\n' + list);
        return true;
    }
    if (command === p + 'toggle' && args[1]) {
        const option = args[1].toLowerCase();
        const validOptions = { links: 'allow_links', stickers: 'allow_stickers', images: 'allow_images', videos: 'allow_videos', audios: 'allow_audios', antispam: 'anti_spam', welcome: 'welcome_active' };
        if (validOptions[option]) {
            const field = validOptions[option];
            const camelKey = field.replace(/_([a-z])/g, function(_, c) { return c.toUpperCase(); });
            const newVal = !settings[camelKey];
            await dbPool.query('UPDATE group_settings SET ' + field + ' = ? WHERE group_id = ?', [newVal ? 1 : 0, groupId]);
            await safeReply(msg, groupId, '✅ **' + option + '** ist jetzt: ' + (newVal ? 'AN ✅' : 'AUS ❌'));
        } else {
            await safeReply(msg, groupId, '⚠️ Optionen: links, stickers, images, videos, audios, antispam, welcome');
        }
        return true;
    }
    if (command === p + 'maxwarns' && args[1]) {
        const n = parseInt(args[1], 10);
        if (!n || n < 1 || n > 20) {
            await safeReply(msg, groupId, '⚠️ Bitte Zahl 1–20 angeben.');
            return true;
        }
        await dbPool.query('UPDATE group_settings SET max_warnings = ? WHERE group_id = ?', [n, groupId]);
        await safeReply(msg, groupId, '✅ Max. Verwarnungen: **' + n + '**');
        return true;
    }
    if (command === p + 'setwelcome') {
        const text = args.slice(1).join(' ').trim();
        if (!text) {
            await safeReply(msg, groupId, '⚠️ Nutzung: `' + p + 'setwelcome Willkommen @user!`\nAktuell: ' + settings.welcomeMsg);
            return true;
        }
        await dbPool.query('UPDATE group_settings SET welcome_msg = ?, welcome_active = 1 WHERE group_id = ?', [text, groupId]);
        await safeReply(msg, groupId, '✅ Willkommenstext gesetzt (Welcome aktiviert):\n' + text);
        return true;
    }
    if (command === p + 'setleave') {
        const text = args.slice(1).join(' ').trim();
        if (!text) {
            await safeReply(msg, groupId, '⚠️ Nutzung: `' + p + 'setleave Tschüss!`\nAktuell: ' + settings.leaveMsg);
            return true;
        }
        await dbPool.query('UPDATE group_settings SET leave_msg = ?, welcome_active = 1 WHERE group_id = ?', [text, groupId]);
        await safeReply(msg, groupId, '✅ Abschiedstext gesetzt:\n' + text);
        return true;
    }
    if (command === p + 'settings') {
        await safeReply(msg, groupId, '⚙️ **Gruppen-Einstellungen**\n\n• Status: ' + (settings.isActive ? '🟢' : '🔴') + '\n• Willkommen: ' + (settings.welcomeActive ? '✅' : '❌') + '\n• Links: ' + (settings.allowLinks ? '✅' : '❌') + ' | Sticker: ' + (settings.allowStickers ? '✅' : '❌') + '\n• Bilder: ' + (settings.allowImages ? '✅' : '❌') + ' | Videos: ' + (settings.allowVideos ? '✅' : '❌') + '\n• Audio: ' + (settings.allowAudios ? '✅' : '❌') + ' | Anti-Spam: ' + (settings.antiSpam ? '✅' : '❌') + '\n• Max. Verwarnungen: ' + settings.maxWarnings);
        return true;
    }
    if (command === p + 'kick') {
        const mentions = await msg.getMentions().catch(() => []);
        if (mentions.length === 0) {
            await safeReply(msg, groupId, '⚠️ Nutzung: `' + p + 'kick @User`');
            return true;
        }
        const target = mentions[0].id._serialized;
        if (isParticipantAdmin(chat, target) || isBotOwner(target)) {
            await safeReply(msg, groupId, '⚠️ Admins/Owner können nicht gekickt werden.');
            return true;
        }
        try {
            if (!chat || !chat.removeParticipants) throw new Error('Chat-Objekt nicht verfügbar');
            await chat.removeParticipants([target]);
            await logAction(groupId, target, 'KICK', 'Manueller Kick');
            await safeReply(msg, groupId, '👢 @' + mentions[0].number + ' entfernt.', { mentions: [mentions[0]] });
        } catch (e) {
            await safeReply(msg, groupId, '❌ Kick fehlgeschlagen: ' + (e.message || e));
        }
        return true;
    }
    if (command === p + 'warns') {
        const mentions = await msg.getMentions().catch(() => []);
        if (mentions.length === 0) {
            await safeReply(msg, groupId, '⚠️ Nutzung: `' + p + 'warns @User`');
            return true;
        }
        const count = await getWarningCount(groupId, mentions[0].id._serialized);
        await safeReply(msg, groupId, '⚠️ @' + mentions[0].number + ': **' + count + '/' + settings.maxWarnings + '** Verwarnungen.', { mentions: [mentions[0]] });
        return true;
    }
    if (command === p + 'resetwarns') {
        const mentions = await msg.getMentions().catch(() => []);
        if (mentions.length === 0) {
            await safeReply(msg, groupId, '⚠️ Nutzung: `' + p + 'resetwarns @User`');
            return true;
        }
        await resetWarnings(groupId, mentions[0].id._serialized);
        await logAction(groupId, mentions[0].id._serialized, 'RESET_WARNS', 'Manuell');
        await safeReply(msg, groupId, '✅ Verwarnungen von @' + mentions[0].number + ' zurückgesetzt.', { mentions: [mentions[0]] });
        return true;
    }
    if (command === p + 'clearwarns') {
        await dbPool.query('DELETE FROM warnings WHERE group_id = ?', [groupId]);
        await logAction(groupId, msg.author || msg.from, 'CLEAR_WARNS', 'Alle gelöscht');
        await safeReply(msg, groupId, '✅ Alle Verwarnungen dieser Gruppe gelöscht.');
        return true;
    }
    if (command === p + 'addword' && args[1]) {
        const word = args.slice(1).join(' ').toLowerCase().trim();
        if (word.length < 2) {
            await safeReply(msg, groupId, '⚠️ Wort zu kurz.');
            return true;
        }
        await dbPool.query('INSERT IGNORE INTO bad_words (word) VALUES (?)', [word]);
        await reloadBadWordsCache();
        await safeReply(msg, groupId, '✅ Schimpfwort **' + word + '** hinzugefügt.');
        return true;
    }
    if (command === p + 'delword' && args[1]) {
        const word = args.slice(1).join(' ').toLowerCase().trim();
        await dbPool.query('DELETE FROM bad_words WHERE word = ?', [word]);
        await reloadBadWordsCache();
        await safeReply(msg, groupId, '✅ Schimpfwort **' + word + '** entfernt.');
        return true;
    }
    if (command === p + 'help') {
        await safeReply(msg, groupId, '🛠 **Admin-Befehle**\n\n• `' + p + 'bot on/off` – Bot umschalten\n• `' + p + 'settings` / `' + p + 'stats` / `' + p + 'info` / `' + p + 'ping`\n• `' + p + 'toggle <links|stickers|images|videos|audios|antispam|welcome>`\n• `' + p + 'maxwarns <1-20>`\n• `' + p + 'setwelcome <text>` / `' + p + 'setleave <text>`\n• `' + p + 'lock` / `' + p + 'unlock`\n• `' + p + 'mute @User` / `' + p + 'unmute @User` / `' + p + 'muted`\n• `' + p + 'kick @User`\n• `' + p + 'warns @User` / `' + p + 'resetwarns @User` / `' + p + 'clearwarns`\n• `' + p + 'addword <w>` / `' + p + 'delword <w>`');
        return true;
    }
    return false;
}

async function startBot() {
    try {
        await initDatabase();
        await syncAndLoadBadWords();
        client.initialize();
    } catch (err) {
        console.error('❌ Start fehlgeschlagen:', err);
        process.exit(1);
    }
}

startBot();
