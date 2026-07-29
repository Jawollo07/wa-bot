const { Client, LocalAuth } = require('whatsapp-web.js');
const mysql = require('mysql2/promise');
// --- GLOBALE KONFIGURATION ---
const CONFIG = {
    phoneNumber: '4915129562482',
    // MySQL Zugangsdaten
    db: {
        host: '192.168.10.2',
        user: 'u28_C4mFdwzqFJ',
        password: 'eVJnFYAx^DTk.jpzNbqWhZ5i',
        database: 's28_wa_bot',
        port: 3306
    },
    // Standard-Einstellungen für neue Gruppen
    defaultSettings: {
        maxWarnings: 3,
        allowLinks: false,
        allowStickers: false,
        antiSpam: true
    },
    // Anti-Spam Konfiguration: Max. X Nachrichten in Y Millisekunden
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
// In-Memory Spam-Tracker: Map<"groupId_userId", Array<timestamp>>
const messageTimestamps = new Map();

/**
 * Initialisiert die Datenbank und legt alle benötigten Tabellen an
 */
async function initDatabase() {
    try {
        dbPool = mysql.createPool({
            ...CONFIG.db,
            waitForConnections: true,
            connectionLimit: 10,
            queueLimit: 0
        });

        // 1. Schimpfwörter-Tabelle
        await dbPool.query(`
            CREATE TABLE IF NOT EXISTS bad_words (
                id INT AUTO_INCREMENT PRIMARY KEY,
                word VARCHAR(191) UNIQUE NOT NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
        `);

        // 2. Verwarnungen-Tabelle
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

        // 3. Gruppen-Einstellungen
        await dbPool.query(`
            CREATE TABLE IF NOT EXISTS group_settings (
                group_id VARCHAR(191) PRIMARY KEY,
                allow_links TINYINT(1) DEFAULT 0,
                allow_stickers TINYINT(1) DEFAULT 0,
                anti_spam TINYINT(1) DEFAULT 1,
                max_warnings INT DEFAULT 3
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
        `);

        // 4. Audit-Log (Protokoll)
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

        console.log('✅ MySQL-Datenbank & Tabellen erfolgreich initialisiert!');
    } catch (error) {
        console.error('❌ Fehler bei der MySQL-Initialisierung:', error);
        process.exit(1);
    }
}

/**
 * Lädt Schimpfwörter von GitHub und gleicht sie mit der DB ab
 */
async function syncAndLoadBadWords() {
    console.log('🔄 Synchronisiere Schimpfwörter...');
    const wordsSet = new Set();

    for (const url of CONFIG.wordUrls) {
        try {
            const response = await fetch(url);
            if (!response.ok) continue;

            const data = await response.json();
            let rawWords = Array.isArray(data) ? data : (typeof data === 'object' ? Object.values(data).flat() : []);

            for (const word of rawWords) {
                if (typeof word === 'string' && word.trim().length > 1) {
                    wordsSet.add(word.trim().toLowerCase());
                }
            }
        } catch (error) {
            console.error(`⚠️ Fehler beim Laden von ${url}:`, error.message);
        }
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

/**
 * Lädt alle Wörter aus der DB in den Arbeitsspeicher
 */
async function reloadBadWordsCache() {
    const [rows] = await dbPool.query('SELECT word FROM bad_words');
    loadedBadWords = rows.map(r => r.word);
    console.log(`✅ ${loadedBadWords.length} Schimpfwörter geladen.`);
}

/**
 * Holt oder erstellt Gruppen-Einstellungen aus MySQL
 */
async function getGroupSettings(groupId) {
    const [rows] = await dbPool.query('SELECT * FROM group_settings WHERE group_id = ?', [groupId]);
    
    if (rows.length === 0) {
        await dbPool.query(
            'INSERT INTO group_settings (group_id, allow_links, allow_stickers, anti_spam, max_warnings) VALUES (?, ?, ?, ?, ?)',
            [
                groupId, 
                CONFIG.defaultSettings.allowLinks ? 1 : 0, 
                CONFIG.defaultSettings.allowStickers ? 1 : 0, 
                CONFIG.defaultSettings.antiSpam ? 1 : 0, 
                CONFIG.defaultSettings.maxWarnings
            ]
        );
        return { ...CONFIG.defaultSettings, group_id: groupId };
    }

    return {
        groupId: rows[0].group_id,
        allowLinks: Boolean(rows[0].allow_links),
        allowStickers: Boolean(rows[0].allow_stickers),
        antiSpam: Boolean(rows[0].anti_spam),
        maxWarnings: rows[0].max_warnings
    };
}

/**
 * Protokolliert Aktionen im Moderations-Log
 */
async function logAction(groupId, userId, action, reason) {
    await dbPool.query(
        'INSERT INTO mod_logs (group_id, user_id, action, reason) VALUES (?, ?, ?, ?)',
        [groupId, userId, action, reason]
    );
}

/**
 * Prüft auf Spamming (zu viele Nachrichten in kurzer Zeit)
 */
function isSpamming(groupId, userId) {
    const key = `${groupId}_${userId}`;
    const now = Date.now();
    
    let timestamps = messageTimestamps.get(key) || [];
    timestamps = timestamps.filter(ts => now - ts < CONFIG.spamLimit.timeFrameMs);
    timestamps.push(now);
    
    messageTimestamps.set(key, timestamps);
    return timestamps.length > CONFIG.spamLimit.maxMessages;
}

/**
 * Verwarnungen verwalten
 */
async function addWarning(groupId, userId) {
    await dbPool.query(`
        INSERT INTO warnings (group_id, user_id, warn_count)
        VALUES (?, ?, 1)
        ON DUPLICATE KEY UPDATE warn_count = warn_count + 1
    `, [groupId, userId]);

    const [rows] = await dbPool.query(
        'SELECT warn_count FROM warnings WHERE group_id = ? AND user_id = ?',
        [groupId, userId]
    );

    return rows[0] ? rows[0].warn_count : 1;
}

async function getWarningCount(groupId, userId) {
    const [rows] = await dbPool.query(
        'SELECT warn_count FROM warnings WHERE group_id = ? AND user_id = ?',
        [groupId, userId]
    );
    return rows[0] ? rows[0].warn_count : 0;
}

async function resetWarnings(groupId, userId) {
    await dbPool.query('DELETE FROM warnings WHERE group_id = ? AND user_id = ?', [groupId, userId]);
}

function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function containsBadWords(text) {
    const lowerText = text.toLowerCase();
    return loadedBadWords.some(word => {
        const regex = new RegExp(`\\b${escapeRegExp(word)}\\b`, 'i');
        return regex.test(lowerText);
    });
}

// WhatsApp Client Init
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: { args: ['--no-sandbox', '--disable-setuid-sandbox'] }
});

client.on('qr', async () => {
    if (!pairingCodeRequested) {
        pairingCodeRequested = true;

        if (!CONFIG.phoneNumber || CONFIG.phoneNumber === '491701234567') {
            console.error('❌ FEHLER: Bitte trage zuerst deine echte Telefonnummer in CONFIG.phoneNumber ein!');
            return;
        }

        try {
            // Anforderung des 8-stelligen Kopplungscodes
            const code = await client.requestPairingCode(CONFIG.phoneNumber);
            
            console.log('\n==================================================');
            console.log(`🔑 DEIN KOPPLUNGSCODE:  ${code}`);
            console.log('==================================================\n');
            console.log('👉 So verknüpfst du den Bot auf deinem Handy:');
            console.log('1. Öffne WhatsApp auf deinem Smartphone.');
            console.log('2. Gehe zu "Einstellungen" > "Verknüpfte Geräte".');
            console.log('3. Tippe auf "Gerät verknüpfen".');
            console.log('4. Wähle unten "Stattdessen mit Telefonnummer verknüpfen".');
            console.log(`5. Gib diesen Code ein: ${code}\n`);
        } catch (err) {
            console.error('❌ Fehler beim Anfordern des Kopplungscodes:', err);
        }
    }
});
client.on('ready', () => {
    console.log('🤖 Moderations-Bot ist einsatzbereit!');
});

client.on('message', async (msg) => {
    if (!msg.from.endsWith('@g.us')) return;

    try {
        const chat = await msg.getChat();
        const groupId = chat.id._serialized;
        const senderId = msg.author || msg.from;

        const participant = chat.participants.find(p => p.id._serialized === senderId);
        const isAdmin = participant ? (participant.isAdmin || participant.isSuperAdmin) : false;

        // Admin-Befehle
        if (isAdmin) {
            await handleAdminCommands(msg, chat);
            if (msg.body.startsWith('!')) return; // Befehle nicht moderieren
        }

        const settings = await getGroupSettings(groupId);
        let violationReason = null;

        // 1. SPAM-SCHUTZ
        if (settings.antiSpam && isSpamming(groupId, senderId)) {
            violationReason = 'Spam-Schutz: Zu viele Nachrichten in kurzer Zeit.';
        }

        // 2. STICKER-SCHUTZ
        if (!violationReason && !settings.allowStickers && msg.type === 'sticker') {
            violationReason = 'Sticker sind in dieser Gruppe deaktiviert.';
        }

        // 3. LINK-SCHUTZ
        if (!violationReason && !settings.allowLinks && msg.body) {
            const hasLink = /(https?:\/\/[^\s]+|chat\.whatsapp\.com\/[a-zA-Z0-9]+)/i.test(msg.body);
            if (hasLink) {
                violationReason = 'Das Teilen von Links ist nicht gestattet.';
            }
        }

        // 4. SCHIMPF WORT-FILTER
        if (!violationReason && msg.body) {
            if (containsBadWords(msg.body)) {
                violationReason = 'Unerwünschte Sprache / Schimpfwort erkannt.';
            }
        }

        // Bei Verstoß reagieren
        if (violationReason) {
            await handleViolation(msg, chat, senderId, violationReason, settings.maxWarnings);
        }

    } catch (error) {
        console.error('Fehler bei der Nachrichtenverarbeitung:', error);
    }
});

/**
 * Handhabt Regelverstöße
 */
async function handleViolation(msg, chat, senderId, reason, maxWarnings) {
    try {
        const groupId = chat.id._serialized;
        await msg.delete(true);

        const currentWarns = await addWarning(groupId, senderId);
        await logAction(groupId, senderId, 'WARN', reason);

        const contact = await msg.getContact();
        const mention = `@${contact.number}`;

        if (currentWarns >= maxWarnings) {
            await chat.sendMessage(
                `⛔ ${mention} wurde automatisch gekickt.\n` +
                `**Grund:** Maximale Verwarnungen (${maxWarnings}/${maxWarnings}) erreicht.`
            );
            await chat.removeParticipants([senderId]);
            await resetWarnings(groupId, senderId);
            await logAction(groupId, senderId, 'KICK', 'Maximale Verwarnungen erreicht');
            console.log(`User ${senderId} gekickt aus ${chat.name}.`);
        } else {
            await chat.sendMessage(
                `⚠️ ${mention}, deine Nachricht wurde entfernt.\n` +
                `**Grund:** ${reason}\n` +
                `**Verwarnung:** ${currentWarns}/${maxWarnings}`
            );
        }
    } catch (err) {
        console.error('Fehler bei Moderationsaktion:', err);
    }
}

/**
 * Erweitere Admin-Befehle
 */
async function handleAdminCommands(msg, chat) {
    const text = msg.body.trim();
    const groupId = chat.id._serialized;
    const args = text.split(' ');
    const command = args[0].toLowerCase();

    // Hilfe
    if (command === '!help') {
        await msg.reply(
            `🛠 **Erweiterte Moderations-Befehle:**\n\n` +
            `• \`!settings\` - Zeigt aktuelle Gruppen-Einstellungen\n` +
            `• \`!toggle links\` - Links erlauben/verbieten\n` +
            `• \`!toggle stickers\` - Sticker erlauben/verbieten\n` +
            `• \`!toggle antispam\` - Anti-Spam ein-/ausschalten\n` +
            `• \`!addword <Wort>\` - Neues Wort sperren\n` +
            `• \`!delword <Wort>\` - Wort aus der Sperrliste entfernen\n` +
            `• \`!warns @User\` - Verwarnungen eines Nutzers abfragen\n` +
            `• \`!resetwarns @User\` - Verwarnungen zurücksetzen\n` +
            `• \`!kick @User\` - Nutzer manuell kicken`
        );
    }

    // Einstellungen anzeigen
    if (command === '!settings') {
        const s = await getGroupSettings(groupId);
        await msg.reply(
            `⚙️ **Gruppen-Einstellungen:**\n\n` +
            `• Links erlaubt: ${s.allowLinks ? '✅ Ja' : '❌ Nein'}\n` +
            `• Sticker erlaubt: ${s.allowStickers ? '✅ Ja' : '❌ Nein'}\n` +
            `• Anti-Spam aktiv: ${s.antiSpam ? '✅ Ja' : '❌ Nein'}\n` +
            `• Max. Verwarnungen: ${s.maxWarnings}`
        );
    }

    // Toggles für Einstellungen
    if (command === '!toggle' && args[1]) {
        const option = args[1].toLowerCase();
        const settings = await getGroupSettings(groupId);

        if (option === 'links') {
            const newVal = !settings.allowLinks;
            await dbPool.query('UPDATE group_settings SET allow_links = ? WHERE group_id = ?', [newVal ? 1 : 0, groupId]);
            await msg.reply(`✅ Links sind nun ${newVal ? '**erlaubt**' : '**verboten**'}.`);
        } else if (option === 'stickers') {
            const newVal = !settings.allowStickers;
            await dbPool.query('UPDATE group_settings SET allow_stickers = ? WHERE group_id = ?', [newVal ? 1 : 0, groupId]);
            await msg.reply(`✅ Sticker sind nun ${newVal ? '**erlaubt**' : '**verboten**'}.`);
        } else if (option === 'antispam') {
            const newVal = !settings.antiSpam;
            await dbPool.query('UPDATE group_settings SET anti_spam = ? WHERE group_id = ?', [newVal ? 1 : 0, groupId]);
            await msg.reply(`✅ Anti-Spam ist nun ${newVal ? '**aktiviert**' : '**deaktiviert**'}.`);
        }
    }

    // Wörter dynamisch hinzufügen
    if (command === '!addword' && args[1]) {
        const newWord = args[1].toLowerCase().trim();
        await dbPool.query('INSERT IGNORE INTO bad_words (word) VALUES (?)', [newWord]);
        await reloadBadWordsCache();
        await msg.reply(`✅ Das Wort **"${newWord}"** wurde zur Sperrliste hinzugefügt.`);
    }

    // Wörter dynamisch entfernen
    if (command === '!delword' && args[1]) {
        const wordToRemove = args[1].toLowerCase().trim();
        await dbPool.query('DELETE FROM bad_words WHERE word = ?', [wordToRemove]);
        await reloadBadWordsCache();
        await msg.reply(`✅ Das Wort **"${wordToRemove}"** wurde aus der Sperrliste entfernt.`);
    }

    // Verwarnungen abfragen
    if (command === '!warns') {
        const mentions = await msg.getMentions();
        if (mentions.length > 0) {
            const target = mentions[0];
            const count = await getWarningCount(groupId, target.id._serialized);
            await msg.reply(`ℹ️ @${target.number} hat aktuell **${count}** Verwarnung(en).`);
        }
    }

    // Verwarnungen zurücksetzen
    if (command === '!resetwarns') {
        const mentions = await msg.getMentions();
        if (mentions.length > 0) {
            const target = mentions[0];
            await resetWarnings(groupId, target.id._serialized);
            await logAction(groupId, target.id._serialized, 'RESET_WARNS', 'Manuell durch Admin');
            await msg.reply(`✅ Verwarnungen für @${target.number} wurden zurückgesetzt.`);
        }
    }

    // Nutzer kicken
    if (command === '!kick') {
        const mentions = await msg.getMentions();
        if (mentions.length > 0) {
            const target = mentions[0];
            await chat.removeParticipants([target.id._serialized]);
            await resetWarnings(groupId, target.id._serialized);
            await logAction(groupId, target.id._serialized, 'KICK', 'Manuell durch Admin');
            await msg.reply(`⛔ @${target.number} wurde vom Admin gekickt.`);
        }
    }
}

// Bot starten
async function startBot() {
    await initDatabase();
    await syncAndLoadBadWords();
    client.initialize();
}

startBot();
