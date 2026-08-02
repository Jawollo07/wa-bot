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

const CONFIG = {
    phoneNumber: process.env.PHONE_NUMBER,

    botOwners: (process.env.BOT_OWNERS || process.env.PHONE_NUMBER || '')
        .split(',')
        .map(s => s.trim().replace(/\D/g, ''))
        .filter(Boolean),

    allowedGroups: [
    ],

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
        maxMessages: 5,
        timeFrameMs: 5000
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
let pairingCodeRequested = false;

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection bei:', promise, 'Grund:', reason);
});
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
});

function isBotOwner(senderId) {
    if (!senderId) return false;
    const num = String(senderId).replace(/\D/g, '');
    return CONFIG.botOwners.some(owner => num.includes(owner) || owner.includes(num));
}

async function getChatSafe(msg, maxAttempts = 4) {
    const chatId = msg.from;
    let lastError;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            if (client.interface?.openChatWindow) {
                await client.interface.openChatWindow(chatId);
                await new Promise(r => setTimeout(r, 400));
            }
        } catch (_) {}

        try {
            const chat = await msg.getChat();
            if (chat) return chat;
        } catch (err) {
            lastError = err;
        }

        try {
            const chat = await client.getChatById(chatId);
            if (chat) return chat;
        } catch (err) {
            lastError = err;
        }

        try {
            const chatData = await client.pupPage.evaluate(async (id) => {
                const chat = window.Store?.Chat?.get(id)
                    || window.Store?.Chat?.find?.(id)
                    || (await window.WWebJS?.getChat?.(id, { getAsModel: false }));
                if (!chat) return null;
                return {
                    id: chat.id,
                    name: chat.formattedTitle || chat.name || id,
                    isGroup: true,
                    participants: (chat.groupMetadata?.participants?.getModelsArray?.()
                        || chat.groupMetadata?.participants
                        || []).map(p => ({
                            id: p.id,
                            isAdmin: !!(p.isAdmin || p.isSuperAdmin),
                            isSuperAdmin: !!p.isSuperAdmin
                        }))
                };
            }, chatId);

            if (chatData) {
                return {
                    id: { _serialized: chatId },
                    name: chatData.name,
                    isGroup: true,
                    participants: (chatData.participants || []).map(p => ({
                        id: { _serialized: p.id?._serialized || p.id },
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
            }
        } catch (err) {
            lastError = err;
        }

        const msgText = lastError?.message || String(lastError || 'unknown');
        console.log(`⚠️ getChat Versuch ${attempt}/${maxAttempts} fehlgeschlagen: ${msgText}`);
        if (attempt < maxAttempts) {
            await new Promise(r => setTimeout(r, 800 * attempt));
        }
    }

    throw lastError || new Error('Chat konnte nicht geladen werden');
}

async function ensureColumn(table, column, definition) {
    try {
        const [rows] = await dbPool.query(
            `SELECT COUNT(*) AS cnt FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE()
               AND TABLE_NAME = ?
               AND COLUMN_NAME = ?`,
            [table, column]
        );
        if (rows[0].cnt === 0) {
            await dbPool.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
            console.log(`  ➕ Spalte ${table}.${column} hinzugefügt`);
        }
    } catch (err) {
        try {
            await dbPool.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
            console.log(`  ➕ Spalte ${table}.${column} hinzugefügt`);
        } catch (e) {
            if (!String(e.message || e).includes('Duplicate column')) {
                console.error(`  ⚠️ Migration ${table}.${column}:`, e.message || e);
            }
        }
    }
}

async function initDatabase() {
    try {
        dbPool = mysql.createPool({
            ...CONFIG.db,
            waitForConnections: true,
            connectionLimit: 10,
            queueLimit: 0
        });

        await dbPool.query(`
            CREATE TABLE IF NOT EXISTS bad_words (
                id INT AUTO_INCREMENT PRIMARY KEY,
                word VARCHAR(191) UNIQUE NOT NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
        `);

        await dbPool.query(`
            CREATE TABLE IF NOT EXISTS warnings (
                id INT AUTO_INCREMENT PRIMARY KEY,
                group_id VARCHAR(191) NOT NULL,
                user_id VARCHAR(191) NOT NULL,
                warn_count INT DEFAULT 1,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                UNIQUE KEY unique_user_group (group_id, user_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
        `);

        await dbPool.query(`
            CREATE TABLE IF NOT EXISTS group_settings (
                group_id VARCHAR(191) PRIMARY KEY,
                is_active TINYINT(1) DEFAULT 0,
                allow_links TINYINT(1) DEFAULT 0,
                allow_stickers TINYINT(1) DEFAULT 0,
                allow_images TINYINT(1) DEFAULT 1,
                allow_videos TINYINT(1) DEFAULT 1,
                allow_audios TINYINT(1) DEFAULT 1,
                anti_spam TINYINT(1) DEFAULT 1,
                max_warnings INT DEFAULT 3,
                welcome_active TINYINT(1) DEFAULT 0,
                welcome_msg TEXT,
                leave_msg TEXT
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
        `);

        console.log('🔄 Prüfe group_settings-Schema...');
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

        await dbPool.query(`
            CREATE TABLE IF NOT EXISTS mod_logs (
                id INT AUTO_INCREMENT PRIMARY KEY,
                group_id VARCHAR(191) NOT NULL,
                user_id VARCHAR(191) NOT NULL,
                action VARCHAR(50) NOT NULL,
                reason TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
        `);

        await dbPool.query(`
            CREATE TABLE IF NOT EXISTS muted_users (
                group_id VARCHAR(191) NOT NULL,
                user_id VARCHAR(191) NOT NULL,
                PRIMARY KEY (group_id, user_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
        `);

        console.log('✅ MySQL-Datenbank erfolgreich initialisiert!');
    } catch (error) {
        console.error('❌ Fehler bei der MySQL-Initialisierung:', error);
        process.exit(1);
    }
}

async function syncAndLoadBadWords() {
    console.log('🔄 Synchronisiere Schimpfwörter...');
    const wordsSet = new Set();
    for (const url of CONFIG.wordUrls) {
        try {
            const response = await fetch(url);
            if (!response.ok) continue;
            const data = await response.json();
            let rawWords = Array.isArray(data)
                ? data
                : (typeof data === 'object' ? Object.values(data).flat() : []);
            for (const word of rawWords) {
                if (typeof word === 'string' && word.trim().length > 1) {
                    wordsSet.add(word.trim().toLowerCase());
                }
            }
        } catch (_) {}
    }
    if (wordsSet.size > 0) {
        const connection = await dbPool.getConnection();
        try {
            await connection.beginTransaction();
            for (const word of wordsSet) {
                await connection.query('INSERT IGNORE INTO bad_words (word) VALUES (?)', [word]);
            }
            await connection.commit();
        } catch (err) {
            await connection.rollback();
        } finally {
            connection.release();
        }
    }
    await reloadBadWordsCache();
}

async function reloadBadWordsCache() {
    const [rows] = await dbPool.query('SELECT word FROM bad_words');
    loadedBadWords = rows.map(r => r.word);
    console.log(`✅ ${loadedBadWords.length} Schimpfwörter geladen.`);
}

async function getGroupSettings(groupId) {
    const [rows] = await dbPool.query('SELECT * FROM group_settings WHERE group_id = ?', [groupId]);
    if (rows.length === 0) {
        await dbPool.query(
            `INSERT INTO group_settings (
                group_id, is_active, allow_links, allow_stickers, allow_images, allow_videos,
                allow_audios, anti_spam, max_warnings, welcome_active, welcome_msg, leave_msg
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                groupId,
                CONFIG.defaultSettings.isActive ? 1 : 0,
                CONFIG.defaultSettings.allowLinks ? 1 : 0,
                CONFIG.defaultSettings.allowStickers ? 1 : 0,
                CONFIG.defaultSettings.allowImages ? 1 : 0,
                CONFIG.defaultSettings.allowVideos ? 1 : 0,
                CONFIG.defaultSettings.allowAudios ? 1 : 0,
                CONFIG.defaultSettings.antiSpam ? 1 : 0,
                CONFIG.defaultSettings.maxWarnings,
                CONFIG.defaultSettings.welcomeActive ? 1 : 0,
                CONFIG.defaultSettings.welcomeMsg,
                CONFIG.defaultSettings.leaveMsg
            ]
        );
        return { ...CONFIG.defaultSettings, groupId };
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
        maxWarnings: r.max_warnings ?? CONFIG.defaultSettings.maxWarnings,
        welcomeActive: Boolean(r.welcome_active),
        welcomeMsg: r.welcome_msg || CONFIG.defaultSettings.welcomeMsg,
        leaveMsg: r.leave_msg || CONFIG.defaultSettings.leaveMsg
    };
}

async function logAction(groupId, userId, action, reason) {
    await dbPool.query(
        'INSERT INTO mod_logs (group_id, user_id, action, reason) VALUES (?, ?, ?, ?)',
        [groupId, userId, action, reason]
    );
}

function isSpamming(groupId, userId) {
    const key = `${groupId}_${userId}`;
    const now = Date.now();
    let timestamps = messageTimestamps.get(key) || [];
    timestamps = timestamps.filter(ts => now - ts < CONFIG.spamLimit.timeFrameMs);
    timestamps.push(now);
    messageTimestamps.set(key, timestamps);
    return timestamps.length > CONFIG.spamLimit.maxMessages;
}

async function addWarning(groupId, userId) {
    await dbPool.query(
        `INSERT INTO warnings (group_id, user_id, warn_count) VALUES (?, ?, 1)
         ON DUPLICATE KEY UPDATE warn_count = warn_count + 1`,
        [groupId, userId]
    );
    const [rows] = await dbPool.query(
        'SELECT warn_count FROM warnings WHERE group_id = ? AND user_id = ?',
        [groupId, userId]
    );
    return rows[0] ? rows[0].warn_count : 1;
}

async function resetWarnings(groupId, userId) {
    await dbPool.query('DELETE FROM warnings WHERE group_id = ? AND user_id = ?', [groupId, userId]);
}

async function getWarningCount(groupId, userId) {
    const [rows] = await dbPool.query(
        'SELECT warn_count FROM warnings WHERE group_id = ? AND user_id = ?',
        [groupId, userId]
    );
    return rows[0] ? rows[0].warn_count : 0;
}

async function isMuted(groupId, userId) {
    const [rows] = await dbPool.query(
        'SELECT 1 FROM muted_users WHERE group_id = ? AND user_id = ?',
        [groupId, userId]
    );
    return rows.length > 0;
}

function containsBadWords(text) {
    if (!text) return false;
    const lowerText = text.toLowerCase();
    return loadedBadWords.some(word => {
        const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`\\b${escaped}\\b`, 'i');
        return regex.test(lowerText);
    });
}

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu'
        ]
    }
});

client.on('qr', async () => {
    if (!pairingCodeRequested && CONFIG.phoneNumber) {
        pairingCodeRequested = true;
        try {
            const code = await client.requestPairingCode(CONFIG.phoneNumber);
            console.log(`\n🔑 DEIN KOPPLUNGSCODE: ${code}\n`);
        } catch (err) {
            console.error('❌ Fehler Kopplungscode:', err);
        }
    }
});

client.on('ready', () => {
    console.log('🤖 Vollausgestatteter Moderations-Bot ist einsatzbereit!');
});

client.on('group_join', async (notification) => {
    try {
        const groupId = notification.chatId;
        const settings = await getGroupSettings(groupId);
        if (!settings.isActive || !settings.welcomeActive) return;

        for (const userId of notification.recipientIds) {
            try {
                const contact = await client.getContactById(userId);
                const text = settings.welcomeMsg.replace('@user', `@${contact.number}`);
                await client.sendMessage(groupId, text, { mentions: [contact] });
            } catch (e) {
                console.error('Welcome-Nachricht fehlgeschlagen:', e.message || e);
            }
        }
    } catch (err) {
        console.error('Fehler bei group_join:', err.message || err);
    }
});

client.on('group_leave', async (notification) => {
    try {
        const groupId = notification.chatId;
        const settings = await getGroupSettings(groupId);
        if (!settings.isActive || !settings.welcomeActive) return;
        await client.sendMessage(groupId, settings.leaveMsg);
    } catch (err) {
        console.error('Fehler bei group_leave:', err.message || err);
    }
});

client.on('message', async (msg) => {
    if (!msg.from.endsWith('@g.us')) return;

    console.log('\n--- 📩 NEUE NACHRICHT EMPFANGEN ---');
    console.log(`Text: "${msg.body || 'Kein Text (Medien/Sticker)'}"`);

    try {
        const groupId = msg.from;
        const senderId = msg.author || msg.from;
        const text = msg.body || '';

        console.log('[1] Lade Einstellungen...');
        const settings = await getGroupSettings(groupId);

        console.log('[2] Lade Chat (mit Retry)...');
        let chat = null;
        try {
            chat = await getChatSafe(msg);
        } catch (err) {
            console.log('⚠️ Chat nicht ladbar – Fallback-Modus (ohne Participants).');
        }

        console.log('[3] Prüfe Admin-Status...');
        let isAdmin = isBotOwner(senderId);

        if (chat && chat.participants) {
            const participants = chat.participants || [];
            const participant = participants.find(p => p.id._serialized === senderId);
            isAdmin = isAdmin || (participant ? (participant.isAdmin || participant.isSuperAdmin) : false);
        }

        // Admin-Befehle (!...) immer verarbeiten – auch wenn Bot inaktiv
        console.log('[4] Verarbeite mögliche Befehle...');
        if (isAdmin && text.startsWith('!')) {
            const handled = await handleAdminCommands(msg, chat, settings, groupId);
            if (handled) {
                console.log('✅ Admin-Befehl ausgeführt.');
                return;
            }
            console.log('ℹ️ Unbekannter Admin-Befehl.');
            return;
        }

        // Bot aus → keine Moderation
        if (!settings.isActive) {
            console.log('🔴 Bot ist inaktiv – Nachricht ignoriert.');
            return;
        }

        // Ab hier: JEDER wird moderiert – auch Admins (keine Ausnahme mehr)

        console.log('[5] Prüfe auf Stummschaltung (Mute)...');
        if (await isMuted(groupId, senderId)) {
            try {
                await msg.delete(true);
            } catch (e) {
                console.error('Löschen fehlgeschlagen:', e.message || e);
            }
            return;
        }

        console.log('[6] Prüfe auf Regelverstöße...');
        let violationReason = null;

        if (settings.antiSpam && isSpamming(groupId, senderId)) {
            violationReason = 'Spam-Schutz: Zu viele Nachrichten.';
        }

        if (!violationReason) {
            if (!settings.allowStickers && msg.type === 'sticker') violationReason = 'Sticker deaktiviert.';
            else if (!settings.allowImages && msg.type === 'image') violationReason = 'Bilder deaktiviert.';
            else if (!settings.allowVideos && msg.type === 'video') violationReason = 'Videos deaktiviert.';
            else if (!settings.allowAudios && (msg.type === 'audio' || msg.type === 'ptt')) {
                violationReason = 'Audios deaktiviert.';
            }
        }

        if (!violationReason && !settings.allowLinks && text &&
            /(https?:\/\/[^\s]+|chat\.whatsapp\.com\/[a-zA-Z0-9]+)/i.test(text)) {
            violationReason = 'Links sind nicht gestattet.';
        }

        if (!violationReason && text && containsBadWords(text)) {
            violationReason = 'Schimpfwort erkannt.';
        }

        if (violationReason) {
            console.log(`🚨 Regelverstoß erkannt: ${violationReason}${isAdmin ? ' (Admin)' : ''}`);
            await handleViolation(msg, chat, groupId, senderId, violationReason, settings.maxWarnings);
        } else {
            console.log('✅ Nachricht ist sauber.');
        }

    } catch (error) {
        console.error('⚠️ ABSTURZ BEI SCHRITT-VERARBEITUNG! Fehler:', error.stack || error);
    }
});

async function handleViolation(msg, chat, groupId, senderId, reason, maxWarnings) {
    try {
        try {
            await msg.delete(true);
        } catch (e) {
            console.error('Nachricht konnte nicht gelöscht werden:', e.message || e);
        }

        const currentWarns = await addWarning(groupId, senderId);
        await logAction(groupId, senderId, 'WARN', reason);

        const number = senderId.split('@')[0].replace(/\D/g, '');

        if (currentWarns >= maxWarnings) {
            await client.sendMessage(
                groupId,
                `⛔ @${number} wurde automatisch gekickt.\n**Grund:** Maximale Verwarnungen erreicht.`,
                { mentions: [senderId] }
            );
            if (chat?.removeParticipants) {
                try {
                    await chat.removeParticipants([senderId]);
                } catch (e) {
                    console.error('Kick fehlgeschlagen:', e.message || e);
                }
            }
            await resetWarnings(groupId, senderId);
            await logAction(groupId, senderId, 'KICK', 'Maximale Verwarnungen erreicht');
        } else {
            await client.sendMessage(
                groupId,
                `⚠️ @${number}, deine Nachricht wurde entfernt.\n**Grund:** ${reason}\n**Verwarnung:** ${currentWarns}/${maxWarnings}`,
                { mentions: [senderId] }
            );
        }
    } catch (err) {
        console.error('Fehler bei Moderationsaktion:', err);
    }
}

async function safeReply(msg, groupId, text, options = {}) {
    try {
        if (msg.reply) {
            await msg.reply(text, undefined, options);
            return;
        }
    } catch (_) {}
    await client.sendMessage(groupId, text, options);
}

async function handleAdminCommands(msg, chat, settings, groupId) {
    const args = msg.body.trim().split(/\s+/);
    const command = args[0].toLowerCase();

    if (command === '!bot') {
        const action = args[1]?.toLowerCase();
        if (action === 'on' || action === 'off') {
            const state = action === 'on' ? 1 : 0;
            await dbPool.query(
                'UPDATE group_settings SET is_active = ? WHERE group_id = ?',
                [state, groupId]
            );
            await safeReply(msg, groupId, state ? '🟢 **Bot aktiviert!**' : '🔴 **Bot deaktiviert!**');
            return true;
        }
        await safeReply(msg, groupId, `ℹ️ Status: **${settings.isActive ? '🟢 AKTIV' : '🔴 INAKTIV'}**`);
        return true;
    }

    if (command === '!lock') {
        if (chat?.setMessagesAdminsOnly) {
            await chat.setMessagesAdminsOnly(true);
            await safeReply(msg, groupId, '🔒 **Gruppe gesperrt.** Nur noch Admins können schreiben.');
        } else {
            await safeReply(msg, groupId, '⚠️ Chat-Objekt nicht verfügbar – !lock nicht möglich.');
        }
        return true;
    }

    if (command === '!unlock') {
        if (chat?.setMessagesAdminsOnly) {
            await chat.setMessagesAdminsOnly(false);
            await safeReply(msg, groupId, '🔓 **Gruppe entsperrt.** Alle können wieder schreiben.');
        } else {
            await safeReply(msg, groupId, '⚠️ Chat-Objekt nicht verfügbar – !unlock nicht möglich.');
        }
        return true;
    }

    if (command === '!mute' || command === '!unmute') {
        const mentions = await msg.getMentions().catch(() => []);
        if (mentions.length > 0) {
            const target = mentions[0].id._serialized;
            if (command === '!mute') {
                await dbPool.query(
                    'INSERT IGNORE INTO muted_users (group_id, user_id) VALUES (?, ?)',
                    [groupId, target]
                );
                await safeReply(msg, groupId,
                    `🤫 @${mentions[0].number} wurde stummgeschaltet.`,
                    { mentions: [mentions[0]] }
                );
            } else {
                await dbPool.query(
                    'DELETE FROM muted_users WHERE group_id = ? AND user_id = ?',
                    [groupId, target]
                );
                await safeReply(msg, groupId,
                    `🔊 @${mentions[0].number} darf wieder schreiben.`,
                    { mentions: [mentions[0]] }
                );
            }
        } else {
            await safeReply(msg, groupId, '⚠️ Bitte einen Nutzer markieren: `!mute @User`');
        }
        return true;
    }

    if (command === '!toggle' && args[1]) {
        const option = args[1].toLowerCase();
        const validOptions = {
            links: 'allow_links',
            stickers: 'allow_stickers',
            images: 'allow_images',
            videos: 'allow_videos',
            audios: 'allow_audios',
            antispam: 'anti_spam',
            welcome: 'welcome_active'
        };

        if (validOptions[option]) {
            const field = validOptions[option];
            const camelKey = field.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
            const newVal = !settings[camelKey];
            await dbPool.query(
                `UPDATE group_settings SET ${field} = ? WHERE group_id = ?`,
                [newVal ? 1 : 0, groupId]
            );
            await safeReply(msg, groupId, `✅ Einstellung für **${option}** ist jetzt: ${newVal ? 'AN' : 'AUS'}`);
        } else {
            await safeReply(msg, groupId, '⚠️ Ungültige Option. Verfügbar: links, stickers, images, videos, audios, antispam, welcome');
        }
        return true;
    }

    if (command === '!settings') {
        await safeReply(msg, groupId,
            `⚙️ **Gruppen-Einstellungen:**\n\n` +
            `• Status: ${settings.isActive ? '🟢' : '🔴'}\n` +
            `• Willkommensnachrichten: ${settings.welcomeActive ? '✅' : '❌'}\n` +
            `• Links: ${settings.allowLinks ? '✅' : '❌'} | Sticker: ${settings.allowStickers ? '✅' : '❌'}\n` +
            `• Bilder: ${settings.allowImages ? '✅' : '❌'} | Videos: ${settings.allowVideos ? '✅' : '❌'}\n` +
            `• Audio/Voice: ${settings.allowAudios ? '✅' : '❌'} | Anti-Spam: ${settings.antiSpam ? '✅' : '❌'}\n` +
            `• Max. Verwarnungen: ${settings.maxWarnings}`
        );
        return true;
    }

    if (command === '!kick') {
        const mentions = await msg.getMentions().catch(() => []);
        if (mentions.length === 0) {
            await safeReply(msg, groupId, '⚠️ Bitte einen Nutzer markieren: `!kick @User`');
            return true;
        }
        const target = mentions[0].id._serialized;
        try {
            if (chat?.removeParticipants) {
                await chat.removeParticipants([target]);
            } else {
                throw new Error('Chat-Objekt nicht verfügbar');
            }
            await logAction(groupId, target, 'KICK', 'Manueller Kick durch Admin');
            await safeReply(msg, groupId, `👢 @${mentions[0].number} wurde entfernt.`, { mentions: [mentions[0]] });
        } catch (e) {
            await safeReply(msg, groupId, `❌ Kick fehlgeschlagen: ${e.message || e}`);
        }
        return true;
    }

    if (command === '!warns') {
        const mentions = await msg.getMentions().catch(() => []);
        if (mentions.length === 0) {
            await safeReply(msg, groupId, '⚠️ Bitte einen Nutzer markieren: `!warns @User`');
            return true;
        }
        const target = mentions[0].id._serialized;
        const count = await getWarningCount(groupId, target);
        await safeReply(msg, groupId,
            `⚠️ @${mentions[0].number} hat **${count}/${settings.maxWarnings}** Verwarnungen.`,
            { mentions: [mentions[0]] }
        );
        return true;
    }

    if (command === '!resetwarns') {
        const mentions = await msg.getMentions().catch(() => []);
        if (mentions.length === 0) {
            await safeReply(msg, groupId, '⚠️ Bitte einen Nutzer markieren: `!resetwarns @User`');
            return true;
        }
        const target = mentions[0].id._serialized;
        await resetWarnings(groupId, target);
        await logAction(groupId, target, 'RESET_WARNS', 'Verwarnungen zurückgesetzt');
        await safeReply(msg, groupId,
            `✅ Verwarnungen von @${mentions[0].number} wurden zurückgesetzt.`,
            { mentions: [mentions[0]] }
        );
        return true;
    }

    if (command === '!addword' && args[1]) {
        const word = args.slice(1).join(' ').toLowerCase().trim();
        if (word.length < 2) {
            await safeReply(msg, groupId, '⚠️ Wort zu kurz.');
            return true;
        }
        try {
            await dbPool.query('INSERT IGNORE INTO bad_words (word) VALUES (?)', [word]);
            await reloadBadWordsCache();
            await safeReply(msg, groupId, `✅ Schimpfwort **${word}** hinzugefügt.`);
        } catch (e) {
            await safeReply(msg, groupId, `❌ Fehler: ${e.message || e}`);
        }
        return true;
    }

    if (command === '!delword' && args[1]) {
        const word = args.slice(1).join(' ').toLowerCase().trim();
        try {
            await dbPool.query('DELETE FROM bad_words WHERE word = ?', [word]);
            await reloadBadWordsCache();
            await safeReply(msg, groupId, `✅ Schimpfwort **${word}** entfernt.`);
        } catch (e) {
            await safeReply(msg, groupId, `❌ Fehler: ${e.message || e}`);
        }
        return true;
    }

    if (command === '!help') {
        await safeReply(msg, groupId,
            `🛠 **Erweiterte Befehle:**\n\n` +
            `• \`!bot on/off\` - Bot umschalten\n` +
            `• \`!settings\` - Übersicht anzeigen\n` +
            `• \`!toggle <links|stickers|images|videos|audios|antispam|welcome>\`\n` +
            `• \`!lock / !unlock\` - Chat sperren/öffnen\n` +
            `• \`!mute @User\` / \`!unmute @User\`\n` +
            `• \`!kick @User\`\n` +
            `• \`!warns @User\` / \`!resetwarns @User\`\n` +
            `• \`!addword <Wort>\` / \`!delword <Wort>\``
        );
        return true;
    }

    return false;
}

async function startBot() {
    await initDatabase();
    await syncAndLoadBadWords();
    client.initialize();
}

startBot();
