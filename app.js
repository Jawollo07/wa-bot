require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const mysql = require('mysql2/promise');

const CONFIG = {
    phoneNumber: process.env.PHONE_NUMBER,
    
    allowedGroups: [
    ],
    
    // MySQL Zugangsdaten aus der .env laden
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
        welcomeMsg: "Willkommen in der Gruppe, @user! 👋",
        leaveMsg: "Ein Nutzer hat die Gruppe verlassen. 😢"
    },
    
    // Anti-Spam Konfiguration
    spamLimit: {
        maxMessages: 5,
        timeFrameMs: 5000
    },
    
    // GitHub-Listen zum Erst-Import
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

// --- ANTI-CRASH SYSTEM ---
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection bei:', promise, 'Grund:', reason);
});
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
});

/**
 * Initialisiert die erweiterte Datenbank
 */
async function initDatabase() {
    try {
        dbPool = mysql.createPool({ ...CONFIG.db, waitForConnections: true, connectionLimit: 10, queueLimit: 0 });

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

        // Erweiterte Group-Settings Tabelle
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

        // NEU: Tabelle für stummgeschaltete Nutzer
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

// --- DATENBANK HILFSFUNKTIONEN ---
async function syncAndLoadBadWords() { /* Bleibt identisch zum Basis-Code */
    console.log('🔄 Synchronisiere Schimpfwörter...');
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
        } catch (error) {}
    }
    if (wordsSet.size > 0) {
        const connection = await dbPool.getConnection();
        try {
            await connection.beginTransaction();
            for (const word of wordsSet) { await connection.query('INSERT IGNORE INTO bad_words (word) VALUES (?)', [word]); }
            await connection.commit();
        } catch (err) { await connection.rollback(); } 
        finally { connection.release(); }
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
                groupId, CONFIG.defaultSettings.isActive ? 1 : 0, CONFIG.defaultSettings.allowLinks ? 1 : 0, 
                CONFIG.defaultSettings.allowStickers ? 1 : 0, CONFIG.defaultSettings.allowImages ? 1 : 0,
                CONFIG.defaultSettings.allowVideos ? 1 : 0, CONFIG.defaultSettings.allowAudios ? 1 : 0,
                CONFIG.defaultSettings.antiSpam ? 1 : 0, CONFIG.defaultSettings.maxWarnings,
                CONFIG.defaultSettings.welcomeActive ? 1 : 0, CONFIG.defaultSettings.welcomeMsg, CONFIG.defaultSettings.leaveMsg
            ]
        );
        return { ...CONFIG.defaultSettings, groupId };
    }
    return {
        groupId: rows[0].group_id, isActive: Boolean(rows[0].is_active), allowLinks: Boolean(rows[0].allow_links),
        allowStickers: Boolean(rows[0].allow_stickers), allowImages: Boolean(rows[0].allow_images),
        allowVideos: Boolean(rows[0].allow_videos), allowAudios: Boolean(rows[0].allow_audios),
        antiSpam: Boolean(rows[0].anti_spam), maxWarnings: rows[0].max_warnings,
        welcomeActive: Boolean(rows[0].welcome_active), welcomeMsg: rows[0].welcome_msg, leaveMsg: rows[0].leave_msg
    };
}

async function logAction(groupId, userId, action, reason) {
    await dbPool.query('INSERT INTO mod_logs (group_id, user_id, action, reason) VALUES (?, ?, ?, ?)', [groupId, userId, action, reason]);
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
    await dbPool.query(`INSERT INTO warnings (group_id, user_id, warn_count) VALUES (?, ?, 1) ON DUPLICATE KEY UPDATE warn_count = warn_count + 1`, [groupId, userId]);
    const [rows] = await dbPool.query('SELECT warn_count FROM warnings WHERE group_id = ? AND user_id = ?', [groupId, userId]);
    return rows[0] ? rows[0].warn_count : 1;
}

async function resetWarnings(groupId, userId) {
    await dbPool.query('DELETE FROM warnings WHERE group_id = ? AND user_id = ?', [groupId, userId]);
}

async function isMuted(groupId, userId) {
    const [rows] = await dbPool.query('SELECT 1 FROM muted_users WHERE group_id = ? AND user_id = ?', [groupId, userId]);
    return rows.length > 0;
}

function containsBadWords(text) {
    if(!text) return false;
    const lowerText = text.toLowerCase();
    return loadedBadWords.some(word => {
        const regex = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
        return regex.test(lowerText);
    });
}

// --- WHATSAPP CLIENT INITIALISIERUNG ---
const client = new Client({
    authStrategy: new LocalAuth(),
    webVersionCache: { type: 'remote', remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version-historical/main/html/2.2412.54.html' },
    puppeteer: { args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-accelerated-2d-canvas', '--no-first-run', '--no-zygote', '--disable-gpu'] }
});

client.on('qr', async () => {
    if (!pairingCodeRequested && CONFIG.phoneNumber) {
        pairingCodeRequested = true;
        try {
            const code = await client.requestPairingCode(CONFIG.phoneNumber);
            console.log(`\n🔑 DEIN KOPPLUNGSCODE: ${code}\n`);
        } catch (err) { console.error('❌ Fehler Kopplungscode:', err); }
    }
});

client.on('ready', () => { console.log('🤖 Vollausgestatteter Moderations-Bot ist einsatzbereit!'); });

// --- WELCOME / LEAVE EVENTS (NEU) ---
client.on('group_join', async (notification) => {
    const groupId = notification.chatId;
    const settings = await getGroupSettings(groupId);
    if (!settings.isActive || !settings.welcomeActive) return;

    const chat = await client.getChatById(groupId);
    for (const userId of notification.recipientIds) {
        const contact = await client.getContactById(userId);
        const msg = settings.welcomeMsg.replace('@user', `@${contact.number}`);
        await chat.sendMessage(msg, { mentions: [contact] });
    }
});

client.on('group_leave', async (notification) => {
    const groupId = notification.chatId;
    const settings = await getGroupSettings(groupId);
    if (!settings.isActive || !settings.welcomeActive) return;

    const chat = await client.getChatById(groupId);
    await chat.sendMessage(settings.leaveMsg);
});

// --- HAUPT LOGIK FÜR NACHRICHTEN ---
client.on('message', async (msg) => {
    if (!msg.from.endsWith('@g.us')) return;

    try {
        const chat = await msg.getChat();
        if (!chat) return;

        const groupId = chat.id._serialized;
        const senderId = msg.author || msg.from;
        const participant = chat.participants.find(p => p.id._serialized === senderId);
        const isAdmin = participant ? (participant.isAdmin || participant.isSuperAdmin) : false;
        const settings = await getGroupSettings(groupId);

        // 1. Admin Commands
        if (isAdmin && msg.body.startsWith('!')) {
            const handled = await handleAdminCommands(msg, chat, settings);
            if (handled) return;
        }

        if (!settings.isActive || isAdmin) return;

        // 2. Mute Check (Löscht Nachricht sofort, ohne Warnung)
        if (await isMuted(groupId, senderId)) {
            await msg.delete(true);
            return;
        }

        // 3. Moderations-Checks
        let violationReason = null;

        if (settings.antiSpam && isSpamming(groupId, senderId)) violationReason = 'Spam-Schutz: Zu viele Nachrichten in kurzer Zeit.';
        
        // Medien Kontrolle
        if (!violationReason) {
            if (!settings.allowStickers && msg.type === 'sticker') violationReason = 'Sticker sind deaktiviert.';
            else if (!settings.allowImages && msg.type === 'image') violationReason = 'Bilder sind deaktiviert.';
            else if (!settings.allowVideos && msg.type === 'video') violationReason = 'Videos sind deaktiviert.';
            else if (!settings.allowAudios && (msg.type === 'audio' || msg.type === 'ptt')) violationReason = 'Sprachnachrichten/Audios sind deaktiviert.';
        }

        if (!violationReason && !settings.allowLinks && msg.body && /(https?:\/\/[^\s]+|chat\.whatsapp\.com\/[a-zA-Z0-9]+)/i.test(msg.body)) {
            violationReason = 'Das Teilen von Links ist nicht gestattet.';
        }

        if (!violationReason && msg.body && containsBadWords(msg.body)) {
            violationReason = 'Unerwünschte Sprache / Schimpfwort erkannt.';
        }

        if (violationReason) {
            await handleViolation(msg, chat, senderId, violationReason, settings.maxWarnings);
        }

    } catch (error) {
        console.error('⚠️ Fehler bei der Nachrichtenverarbeitung:', error.message);
    }
});

async function handleViolation(msg, chat, senderId, reason, maxWarnings) {
    try {
        const groupId = chat.id._serialized;
        await msg.delete(true);
        const currentWarns = await addWarning(groupId, senderId);
        await logAction(groupId, senderId, 'WARN', reason);
        const contact = await msg.getContact();

        if (currentWarns >= maxWarnings) {
            await chat.sendMessage(`⛔ @${contact.number} wurde automatisch gekickt.\n**Grund:** Maximale Verwarnungen erreicht.`, { mentions: [contact] });
            await chat.removeParticipants([senderId]);
            await resetWarnings(groupId, senderId);
            await logAction(groupId, senderId, 'KICK', 'Maximale Verwarnungen erreicht');
        } else {
            await chat.sendMessage(`⚠️ @${contact.number}, deine Nachricht wurde entfernt.\n**Grund:** ${reason}\n**Verwarnung:** ${currentWarns}/${maxWarnings}`, { mentions: [contact] });
        }
    } catch (err) { console.error('Fehler bei Moderationsaktion:', err); }
}

// --- ERWEITERTE ADMIN BEFEHLE ---
async function handleAdminCommands(msg, chat, settings) {
    const args = msg.body.trim().split(' ');
    const command = args[0].toLowerCase();
    const groupId = chat.id._serialized;

    if (command === '!bot') {
        const action = args[1]?.toLowerCase();
        if (action === 'on' || action === 'off') {
            const state = action === 'on' ? 1 : 0;
            await dbPool.query('UPDATE group_settings SET is_active = ? WHERE group_id = ?', [state, groupId]);
            await msg.reply(state ? '🟢 **Bot aktiviert!**' : '🔴 **Bot deaktiviert!**');
            return true;
        }
        await msg.reply(`ℹ️ Status: **${settings.isActive ? '🟢 AKTIV' : '🔴 INAKTIV'}**`);
        return true;
    }

    if (!settings.isActive) return false;

    // --- NEUE COMMANDS ---
    if (command === '!lock') {
        await chat.setMessagesAdminsOnly(true);
        await msg.reply('🔒 **Gruppe gesperrt.** Nur noch Admins können schreiben.');
        return true;
    }
    if (command === '!unlock') {
        await chat.setMessagesAdminsOnly(false);
        await msg.reply('🔓 **Gruppe entsperrt.** Alle können wieder schreiben.');
        return true;
    }

    if (command === '!mute' || command === '!unmute') {
        const mentions = await msg.getMentions();
        if (mentions.length > 0) {
            const target = mentions[0].id._serialized;
            if (command === '!mute') {
                await dbPool.query('INSERT IGNORE INTO muted_users (group_id, user_id) VALUES (?, ?)', [groupId, target]);
                await msg.reply(`🤫 @${mentions[0].number} wurde stummgeschaltet. Alle Nachrichten werden gelöscht.`);
            } else {
                await dbPool.query('DELETE FROM muted_users WHERE group_id = ? AND user_id = ?', [groupId, target]);
                await msg.reply(`🔊 @${mentions[0].number} darf wieder schreiben.`);
            }
        }
        return true;
    }

    if (command === '!toggle' && args[1]) {
        const option = args[1].toLowerCase();
        const validOptions = {
            'links': 'allow_links', 'stickers': 'allow_stickers', 'images': 'allow_images', 
            'videos': 'allow_videos', 'audios': 'allow_audios', 'antispam': 'anti_spam', 'welcome': 'welcome_active'
        };
        
        if (validOptions[option]) {
            const field = validOptions[option];
            const newVal = !settings[field.replace(/_([a-z])/g, g => g[1].toUpperCase())];
            await dbPool.query(`UPDATE group_settings SET ${field} = ? WHERE group_id = ?`, [newVal ? 1 : 0, groupId]);
            await msg.reply(`✅ Einstellung für **${option}** geändert.`);
        }
        return true;
    }

    if (command === '!settings') {
        await msg.reply(
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

    if (command === '!help') {
        await msg.reply(
            `🛠 **Erweiterte Befehle:**\n\n` +
            `• \`!bot on/off\` - Bot umschalten\n` +
            `• \`!settings\` - Übersicht anzeigen\n` +
            `• \`!toggle <links|stickers|images|videos|audios|antispam|welcome>\`\n` +
            `• \`!lock / !unlock\` - Chat für Mitglieder sperren/öffnen\n` +
            `• \`!mute @User\` / \`!unmute @User\` - User stummschalten\n` +
            `• \`!kick @User\` - Nutzer entfernen\n` +
            `• \`!warns @User\` / \`!resetwarns @User\`\n` +
            `• \`!addword <Wort>\` / \`!delword <Wort>\``
        );
        return true;
    }
    
    /* ... (Die restlichen Basis-Befehle wie !addword, !delword, !warns, !kick bleiben identisch wie in deiner Vorlage) ... */
    
    return false;
}

async function startBot() {
    await initDatabase();
    await syncAndLoadBadWords();
    client.initialize();
}

startBot();
