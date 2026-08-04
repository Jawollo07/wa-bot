import 'dotenv/config';
import makeWASocket, {
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore
} from '@whiskeysockets/baileys';

function isJidGroup(jid) {
    return typeof jid === 'string' && jid.endsWith('@g.us');
}

function jidNormalizedUser(jid) {
    if (!jid) return '';
    return String(jid).split(':')[0];
}

import mysql from 'mysql2/promise';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import { Boom } from '@hapi/boom';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as profanity from './profanity.js';
import { handleKiCommand, checkOllama, getKiConfig } from './ollama.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PREFIX = process.env.COMMAND_PREFIX || '!';
const AUTH_DIR = process.env.BAILEYS_AUTH_PATH || path.join(__dirname, 'auth_baileys');
const SYSTEM_GROUP = 'SYSTEM';

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
        'https://raw.githubusercontent.com/AdvancedPlugins/Chat/main/swear%20words/de.json',
    ]
};

let dbPool;
let sock = null;
let loadedBadWords = [];
const messageTimestamps = new Map();
const groupMetaCache = new Map();
const GROUP_CACHE_TTL = 60_000;
let botStartTime = Date.now();
let stats = { messages: 0, violations: 0, commands: 0 };
let pairingRequested = false;

process.on('unhandledRejection', (r) => console.error('[unhandledRejection]', r));
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e));

function log(...args) {
    const t = new Date().toISOString().slice(11, 19);
    console.log('[' + t + ']', ...args);
}

function normalizePhone(id) {
    return String(id || '').replace(/\D/g, '');
}

function isBotOwner(senderId) {
    if (!senderId) return false;
    const num = normalizePhone(senderId);
    if (num.length < 8) return false;
    return CONFIG.botOwners.some(owner => {
        if (!owner || owner.length < 8) return false;
        return num === owner || num.endsWith(owner) || owner.endsWith(num);
    });
}

function extractText(msg) {
    const m = msg.message || {};
    return (
        m.conversation ||
        m.extendedTextMessage?.text ||
        m.imageMessage?.caption ||
        m.videoMessage?.caption ||
        m.documentMessage?.caption ||
        m.buttonsResponseMessage?.selectedDisplayText ||
        m.listResponseMessage?.title ||
        ''
    );
}

function detectMsgType(msg) {
    const m = msg.message || {};
    if (m.stickerMessage) return 'sticker';
    if (m.imageMessage) return 'image';
    if (m.videoMessage) return 'video';
    if (m.audioMessage) return m.audioMessage.ptt ? 'ptt' : 'audio';
    if (m.documentMessage) return 'document';
    if (m.conversation || m.extendedTextMessage) return 'chat';
    return 'unknown';
}

async function getGroupMeta(groupId) {
    const cached = groupMetaCache.get(groupId);
    if (cached && Date.now() - cached.ts < GROUP_CACHE_TTL) return cached.meta;
    try {
        const meta = await sock.groupMetadata(groupId);
        groupMetaCache.set(groupId, { meta, ts: Date.now() });
        return meta;
    } catch (e) {
        log('⚠️ groupMetadata: ' + (e.message || e));
        return cached?.meta || null;
    }
}

function isParticipantAdmin(meta, userId) {
    if (!meta?.participants || !userId) return false;
    const uid = jidNormalizedUser(userId);
    const p = meta.participants.find(x => {
        const id = jidNormalizedUser(x.id || x.jid || '');
        const lid = x.lid ? jidNormalizedUser(x.lid) : '';
        return id === uid || lid === uid || normalizePhone(id) === normalizePhone(uid);
    });
    if (!p) return false;
    return p.admin === 'admin' || p.admin === 'superadmin' || p.isAdmin || p.isSuperAdmin;
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

    // === erweiterte mod_logs Tabelle ===
    await dbPool.query(
        'CREATE TABLE IF NOT EXISTS mod_logs (' +
        'id INT AUTO_INCREMENT PRIMARY KEY,' +
        'group_id VARCHAR(191) NOT NULL,' +
        'user_id VARCHAR(191) NOT NULL,' +
        'actor_id VARCHAR(191) NULL,' +
        'action VARCHAR(64) NOT NULL,' +
        'reason TEXT,' +
        'details TEXT,' +
        'created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,' +
        'INDEX idx_group (group_id),' +
        'INDEX idx_action (action),' +
        'INDEX idx_created (created_at),' +
        'INDEX idx_user (user_id)' +
        ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'
    );
    log('🔄 Prüfe mod_logs-Schema...');
    await ensureColumn('mod_logs', 'actor_id', 'VARCHAR(191) NULL');
    await ensureColumn('mod_logs', 'details', 'TEXT');
    // ältere Installationen hatten action nur VARCHAR(50)
    try {
        await dbPool.query('ALTER TABLE mod_logs MODIFY COLUMN action VARCHAR(64) NOT NULL');
    } catch (_) {}

    await dbPool.query('CREATE TABLE IF NOT EXISTS muted_users (group_id VARCHAR(191) NOT NULL, user_id VARCHAR(191) NOT NULL, muted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (group_id, user_id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');
    await dbPool.query(
        'CREATE TABLE IF NOT EXISTS banned_users (' +
        'group_id VARCHAR(191) NOT NULL,' +
        'user_id VARCHAR(191) NOT NULL,' +
        'banned_until DATETIME NULL,' +
        'reason TEXT,' +
        'banned_by VARCHAR(191),' +
        'banned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,' +
        'PRIMARY KEY (group_id, user_id),' +
        'INDEX idx_until (banned_until)' +
        ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'
    );
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
    profanity.setWordList(loadedBadWords);
    log('✅ ' + loadedBadWords.length + ' Schimpfwörter geladen (Index: ' + profanity.getIndexSize() + ' Formen).');
}

function dbFlag(v, defaultVal = false) {
    if (v === undefined || v === null) return defaultVal;
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v !== 0;
    if (typeof v === 'string') return v === '1' || v.toLowerCase() === 'true';
    if (typeof Buffer !== 'undefined' && Buffer.isBuffer(v)) return v[0] === 1;
    return Boolean(v);
}

async function getGroupSettings(groupId) {
    const [rows] = await dbPool.query('SELECT * FROM group_settings WHERE group_id = ?', [groupId]);
    if (rows.length === 0) {
        const d = CONFIG.defaultSettings;
        await dbPool.query(
            'INSERT IGNORE INTO group_settings (group_id, is_active, allow_links, allow_stickers, allow_images, allow_videos, allow_audios, anti_spam, max_warnings, welcome_active, welcome_msg, leave_msg) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [groupId, d.isActive ? 1 : 0, d.allowLinks ? 1 : 0, d.allowStickers ? 1 : 0, d.allowImages ? 1 : 0, d.allowVideos ? 1 : 0, d.allowAudios ? 1 : 0, d.antiSpam ? 1 : 0, d.maxWarnings, d.welcomeActive ? 1 : 0, d.welcomeMsg, d.leaveMsg]
        );
        const [again] = await dbPool.query('SELECT * FROM group_settings WHERE group_id = ?', [groupId]);
        if (again.length) {
            const r = again[0];
            return mapSettingsRow(r);
        }
        return { ...d, groupId };
    }
    return mapSettingsRow(rows[0]);
}

function mapSettingsRow(r) {
    return {
        groupId: r.group_id,
        isActive: dbFlag(r.is_active, false),
        allowLinks: dbFlag(r.allow_links, false),
        allowStickers: dbFlag(r.allow_stickers, false),
        allowImages: dbFlag(r.allow_images, true),
        allowVideos: dbFlag(r.allow_videos, true),
        allowAudios: dbFlag(r.allow_audios, true),
        antiSpam: dbFlag(r.anti_spam, true),
        maxWarnings: r.max_warnings != null ? Number(r.max_warnings) : CONFIG.defaultSettings.maxWarnings,
        welcomeActive: dbFlag(r.welcome_active, false),
        welcomeMsg: r.welcome_msg || CONFIG.defaultSettings.welcomeMsg,
        leaveMsg: r.leave_msg || CONFIG.defaultSettings.leaveMsg
    };
}

/**
 * Vollständiges Logging in mod_logs.
 * @param {string} groupId  - Gruppen-JID oder 'SYSTEM'
 * @param {string} userId   - Betroffener User (oder 'bot' / 'system')
 * @param {string} action   - z.B. WARN, BAN, BOT_ON, TOGGLE, ...
 * @param {string} [reason] - freier Text
 * @param {string} [actorId]- Wer die Aktion ausgelöst hat (Admin/Owner/system)
 * @param {string|object} [details] - Zusatzinfos (wird als JSON gespeichert wenn Objekt)
 */
async function logAction(groupId, userId, action, reason = null, actorId = null, details = null) {
    try {
        const detailsStr = details == null
            ? null
            : (typeof details === 'string' ? details : JSON.stringify(details));
        await dbPool.query(
            'INSERT INTO mod_logs (group_id, user_id, actor_id, action, reason, details) VALUES (?, ?, ?, ?, ?, ?)',
            [
                groupId || SYSTEM_GROUP,
                userId || 'system',
                actorId || null,
                String(action).slice(0, 64),
                reason || null,
                detailsStr
            ]
        );
    } catch (e) {
        // Logging darf den Bot nie crashen
        console.error('[logAction]', e.message || e);
    }
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
    await dbPool.query(
        'INSERT INTO warnings (group_id, user_id, warn_count) VALUES (?, ?, 1) ON DUPLICATE KEY UPDATE warn_count = warn_count + 1',
        [groupId, userId]
    );
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

function parseBanDuration(str) {
    if (!str) return { until: null, label: 'permanent' };
    const s = String(str).toLowerCase().trim();
    if (['permanent', 'perm', 'perma', 'permament', 'forever', 'ewig'].includes(s)) {
        return { until: null, label: 'permanent' };
    }
    const m = s.match(/^(\d+)\s*(m|min|h|d|w)$/i) || s.match(/^(\d+)(m|min|h|d|w)$/i);
    if (!m) return null;
    const n = parseInt(m[1], 10);
    const unit = m[2].toLowerCase();
    let ms = 0;
    if (unit === 'm' || unit === 'min') ms = n * 60_000;
    else if (unit === 'h') ms = n * 3_600_000;
    else if (unit === 'd') ms = n * 86_400_000;
    else if (unit === 'w') ms = n * 7 * 86_400_000;
    if (ms <= 0) return null;
    return { until: new Date(Date.now() + ms), label: n + unit };
}

async function validateBanRow(row, groupId) {
    if (row.banned_until) {
        const until = new Date(row.banned_until);
        if (until.getTime() <= Date.now()) {
            await dbPool.query('DELETE FROM banned_users WHERE group_id = ? AND user_id = ?', [groupId, row.user_id]);
            return null;
        }
    }
    return row;
}

async function getActiveBan(groupId, userId) {
    const [rows] = await dbPool.query(
        'SELECT * FROM banned_users WHERE group_id = ? AND user_id = ?',
        [groupId, userId]
    );
    if (rows.length) return validateBanRow(rows[0], groupId);
    const phone = normalizePhone(userId);
    if (phone.length >= 8) {
        const [rows2] = await dbPool.query(
            "SELECT * FROM banned_users WHERE group_id = ? AND REPLACE(REPLACE(user_id, '@s.whatsapp.net', ''), '@lid', '') LIKE ?",
            [groupId, '%' + phone + '%']
        );
        if (rows2.length) return validateBanRow(rows2[0], groupId);
    }
    return null;
}

async function banUser(groupId, userId, until, reason, bannedBy) {
    await dbPool.query(
        'INSERT INTO banned_users (group_id, user_id, banned_until, reason, banned_by) VALUES (?, ?, ?, ?, ?) ' +
        'ON DUPLICATE KEY UPDATE banned_until = VALUES(banned_until), reason = VALUES(reason), banned_by = VALUES(banned_by), banned_at = CURRENT_TIMESTAMP',
        [groupId, userId, until, reason || null, bannedBy || null]
    );
}

async function unbanUser(groupId, userId) {
    await dbPool.query('DELETE FROM banned_users WHERE group_id = ? AND user_id = ?', [groupId, userId]);
    const phone = normalizePhone(userId);
    if (phone.length >= 8) {
        await dbPool.query(
            "DELETE FROM banned_users WHERE group_id = ? AND REPLACE(REPLACE(user_id, '@s.whatsapp.net', ''), '@lid', '') LIKE ?",
            [groupId, '%' + phone + '%']
        );
    }
}

function formatBanUntil(row) {
    if (!row.banned_until) return 'permanent';
    const d = new Date(row.banned_until);
    return d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

function formatUptime(ms) {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return h + 'h ' + m + 'm ' + sec + 's';
}

async function safeDeleteMessage(groupId, key) {
    try {
        await sock.sendMessage(groupId, { delete: key });
        log('🗑️ Nachricht gelöscht');
        return true;
    } catch (e) {
        log('⚠️ Löschen fehlgeschlagen: ' + (e.message || e));
        return false;
    }
}

async function sendText(groupId, text, mentions = []) {
    const content = mentions.length ? { text, mentions } : { text };
    return sock.sendMessage(groupId, content);
}

async function handleViolation(msg, meta, groupId, senderId, reason, maxWarnings, isAdmin) {
    try {
        const deleted = await safeDeleteMessage(groupId, msg.key);
        const currentWarns = await addWarning(groupId, senderId);
        const msgSnippet = (extractText(msg) || '[' + detectMsgType(msg) + ']').slice(0, 200);

        await logAction(groupId, senderId, 'WARN', reason, 'system', {
            warns: currentWarns,
            maxWarnings,
            deleted,
            snippet: msgSnippet
        });

        const number = normalizePhone(senderId) || senderId.split('@')[0];

        if (currentWarns >= maxWarnings) {
            if (isAdmin || isParticipantAdmin(meta, senderId)) {
                await sendText(groupId, '⛔ @' + number + ' hat max. Verwarnungen erreicht, wird als *Admin* nicht gekickt.\n*Grund:* ' + reason, [senderId]);
                await resetWarnings(groupId, senderId);
                await logAction(groupId, senderId, 'WARN_MAX_ADMIN', reason, 'system', { warns: currentWarns });
                return;
            }
            await sendText(groupId, '⛔ @' + number + ' wurde automatisch gekickt.\n*Grund:* Maximale Verwarnungen erreicht.', [senderId]);
            try {
                await sock.groupParticipantsUpdate(groupId, [senderId], 'remove');
            } catch (e) {
                console.error('Kick fehlgeschlagen:', e.message || e);
            }
            await resetWarnings(groupId, senderId);
            await logAction(groupId, senderId, 'KICK', 'Maximale Verwarnungen erreicht', 'system', { reason });
        } else {
            await sendText(
                groupId,
                '⚠️ @' + number + ', deine Nachricht wurde entfernt.\n*Grund:* ' + reason + '\n*Verwarnung:* ' + currentWarns + '/' + maxWarnings,
                [senderId]
            );
        }
    } catch (err) {
        console.error('Moderationsfehler:', err);
        await logAction(groupId, senderId || 'unknown', 'ERROR', 'handleViolation: ' + (err.message || err), 'system');
    }
}

function parseMentionsFromText(text, msg) {
    const ctx = msg.message?.extendedTextMessage?.contextInfo
        || msg.message?.imageMessage?.contextInfo
        || {};
    return ctx.mentionedJid || [];
}

async function handleAdminCommands(msg, meta, settings, groupId, senderId, text) {
    const args = text.trim().split(/\s+/);
    const command = args[0].toLowerCase();
    const p = PREFIX;
    const mentions = parseMentionsFromText(text, msg);
    const reply = async (t, ments = []) => sendText(groupId, t, ments);

    if (command === p + 'bot') {
        const action = args[1]?.toLowerCase();
        if (action === 'on' || action === 'off') {
            const state = action === 'on' ? 1 : 0;
            await dbPool.query(
                'INSERT INTO group_settings (group_id, is_active) VALUES (?, ?) ON DUPLICATE KEY UPDATE is_active = VALUES(is_active)',
                [groupId, state]
            );
            log('⚙️ is_active=' + state + ' für ' + groupId);
            await logAction(groupId, 'bot', state ? 'BOT_ON' : 'BOT_OFF', null, senderId);
            await reply(state ? '🟢 *Bot aktiviert!*' : '🔴 *Bot deaktiviert!*');
            return true;
        }
        const fresh = await getGroupSettings(groupId);
        await reply('ℹ️ Status: *' + (fresh.isActive ? '🟢 AKTIV' : '🔴 INAKTIV') + '*\nGruppe: `' + groupId + '`');
        return true;
    }
    if (command === p + 'ping') {
        const t0 = Date.now();
        await reply('🏓 Pong! (' + (Date.now() - t0) + 'ms) | Uptime: ' + formatUptime(Date.now() - botStartTime));
        return true;
    }
    if (command === p + 'info') {
        const ki = getKiConfig();
        await reply(
            '🤖 *wa-bot v3.2.0 (Baileys + Ollama)*\n' +
            '• Uptime: ' + formatUptime(Date.now() - botStartTime) + '\n' +
            '• Nachrichten: ' + stats.messages + '\n' +
            '• Verstöße: ' + stats.violations + '\n' +
            '• Befehle: ' + stats.commands + '\n' +
            '• Schimpfwörter: ' + loadedBadWords.length + '\n' +
            '• Gruppe: ' + (settings.isActive ? '🟢 aktiv' : '🔴 inaktiv') + '\n' +
            '• KI: ' + (ki.enabled ? '✅ (' + ki.model + ')' : '❌ deaktiviert')
        );
        return true;
    }
    if (command === p + 'stats') {
        const [warnRows] = await dbPool.query('SELECT COUNT(*) AS c, COALESCE(SUM(warn_count),0) AS total FROM warnings WHERE group_id = ?', [groupId]);
        const [muteRows] = await dbPool.query('SELECT COUNT(*) AS c FROM muted_users WHERE group_id = ?', [groupId]);
        const [logRows] = await dbPool.query('SELECT COUNT(*) AS c FROM mod_logs WHERE group_id = ? AND created_at > DATE_SUB(NOW(), INTERVAL 24 HOUR)', [groupId]);
        await reply('📊 *Gruppen-Statistik*\n• Verwarnte User: ' + warnRows[0].c + '\n• Summe Verwarnungen: ' + warnRows[0].total + '\n• Stummgeschaltet: ' + muteRows[0].c + '\n• Mod-Aktionen (24h): ' + logRows[0].c + '\n• Max. Warns: ' + settings.maxWarnings);
        return true;
    }
    if (command === p + 'logs') {
        const limit = Math.min(parseInt(args[1], 10) || 15, 30);
        const [rows] = await dbPool.query(
            'SELECT action, user_id, actor_id, reason, details, created_at FROM mod_logs WHERE group_id = ? ORDER BY id DESC LIMIT ?',
            [groupId, limit]
        );
        if (rows.length === 0) {
            await reply('📋 Keine Logs für diese Gruppe.');
            return true;
        }
        const lines = rows.map(r => {
            const ts = r.created_at ? new Date(r.created_at).toISOString().slice(5, 16).replace('T', ' ') : '?';
            const who = (r.user_id || '').split('@')[0].slice(-8);
            const by = r.actor_id ? ' by ' + r.actor_id.split('@')[0].slice(-6) : '';
            const reasonShort = (r.reason || '').slice(0, 40);
            return '• `' + ts + '` *' + r.action + '* ' + who + by + (reasonShort ? ' – ' + reasonShort : '');
        });
        await reply('📜 *Letzte ' + rows.length + ' Logs*\n' + lines.join('\n'));
        return true;
    }
    if (command === p + 'lock') {
        try {
            await sock.groupSettingUpdate(groupId, 'announcement');
            await logAction(groupId, 'group', 'LOCK', 'Nur Admins dürfen schreiben', senderId);
            await reply('🔒 *Gruppe gesperrt.* Nur noch Admins können schreiben.');
        } catch (e) {
            await reply('❌ Lock fehlgeschlagen: ' + (e.message || e));
            await logAction(groupId, 'group', 'LOCK_FAIL', e.message || String(e), senderId);
        }
        return true;
    }
    if (command === p + 'unlock') {
        try {
            await sock.groupSettingUpdate(groupId, 'not_announcement');
            await logAction(groupId, 'group', 'UNLOCK', 'Alle dürfen schreiben', senderId);
            await reply('🔓 *Gruppe entsperrt.*');
        } catch (e) {
            await reply('❌ Unlock fehlgeschlagen: ' + (e.message || e));
            await logAction(groupId, 'group', 'UNLOCK_FAIL', e.message || String(e), senderId);
        }
        return true;
    }
    if (command === p + 'mute' || command === p + 'unmute') {
        if (mentions.length === 0) {
            await reply('⚠️ Nutzung: `' + command + ' @User`');
            return true;
        }
        const target = mentions[0];
        if (command === p + 'mute') {
            if (isParticipantAdmin(meta, target) || isBotOwner(target)) {
                await reply('⚠️ Admins/Owner können nicht stummgeschaltet werden.');
                return true;
            }
            await dbPool.query('INSERT IGNORE INTO muted_users (group_id, user_id) VALUES (?, ?)', [groupId, target]);
            await logAction(groupId, target, 'MUTE', 'Manuell', senderId);
            await reply('🤫 User stummgeschaltet.', [target]);
        } else {
            await dbPool.query('DELETE FROM muted_users WHERE group_id = ? AND user_id = ?', [groupId, target]);
            await logAction(groupId, target, 'UNMUTE', 'Manuell', senderId);
            await reply('🔊 User darf wieder schreiben.', [target]);
        }
        return true;
    }
    if (command === p + 'muted') {
        const [rows] = await dbPool.query('SELECT user_id FROM muted_users WHERE group_id = ?', [groupId]);
        if (rows.length === 0) {
            await reply('📋 Niemand ist stummgeschaltet.');
            return true;
        }
        const list = rows.map(r => '• ' + r.user_id.split('@')[0]).join('\n');
        await reply('📋 *Stummgeschaltet (' + rows.length + '):*\n' + list);
        return true;
    }
    if (command === p + 'toggle' && args[1]) {
        const option = args[1].toLowerCase();
        const validOptions = { links: 'allow_links', stickers: 'allow_stickers', images: 'allow_images', videos: 'allow_videos', audios: 'allow_audios', antispam: 'anti_spam', welcome: 'welcome_active' };
        if (validOptions[option]) {
            const field = validOptions[option];
            const camelKey = field.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
            const newVal = !settings[camelKey];
            await dbPool.query('UPDATE group_settings SET ' + field + ' = ? WHERE group_id = ?', [newVal ? 1 : 0, groupId]);
            await logAction(groupId, 'settings', 'TOGGLE', option + ' → ' + (newVal ? 'ON' : 'OFF'), senderId, { option, newVal });
            await reply('✅ *' + option + '* ist jetzt: ' + (newVal ? 'AN ✅' : 'AUS ❌'));
        } else {
            await reply('⚠️ Optionen: links, stickers, images, videos, audios, antispam, welcome');
        }
        return true;
    }
    if (command === p + 'maxwarns' && args[1]) {
        const n = parseInt(args[1], 10);
        if (!n || n < 1 || n > 20) {
            await reply('⚠️ Bitte Zahl 1–20 angeben.');
            return true;
        }
        const old = settings.maxWarnings;
        await dbPool.query('UPDATE group_settings SET max_warnings = ? WHERE group_id = ?', [n, groupId]);
        await logAction(groupId, 'settings', 'MAXWARNS', old + ' → ' + n, senderId, { old, new: n });
        await reply('✅ Max. Verwarnungen: *' + n + '*');
        return true;
    }
    if (command === p + 'setwelcome') {
        const t = args.slice(1).join(' ').trim();
        if (!t) {
            await reply('⚠️ Nutzung: `' + p + 'setwelcome ...`\nAktuell: ' + settings.welcomeMsg);
            return true;
        }
        await dbPool.query('UPDATE group_settings SET welcome_msg = ?, welcome_active = 1 WHERE group_id = ?', [t, groupId]);
        await logAction(groupId, 'settings', 'SET_WELCOME', t.slice(0, 100), senderId);
        await reply('✅ Willkommenstext gesetzt:\n' + t);
        return true;
    }
    if (command === p + 'setleave') {
        const t = args.slice(1).join(' ').trim();
        if (!t) {
            await reply('⚠️ Nutzung: `' + p + 'setleave ...`\nAktuell: ' + settings.leaveMsg);
            return true;
        }
        await dbPool.query('UPDATE group_settings SET leave_msg = ?, welcome_active = 1 WHERE group_id = ?', [t, groupId]);
        await logAction(groupId, 'settings', 'SET_LEAVE', t.slice(0, 100), senderId);
        await reply('✅ Abschiedstext gesetzt:\n' + t);
        return true;
    }
    if (command === p + 'settings') {
        await reply('⚙️ **Gruppen-Einstellungen**\n\n• Status: ' + (settings.isActive ? '🟢' : '🔴') + '\n• Willkommen: ' + (settings.welcomeActive ? '✅' : '❌') + '\n• Links: ' + (settings.allowLinks ? '✅' : '❌') + ' | Sticker: ' + (settings.allowStickers ? '✅' : '❌') + '\n• Bilder: ' + (settings.allowImages ? '✅' : '❌') + ' | Videos: ' + (settings.allowVideos ? '✅' : '❌') + '\n• Audio: ' + (settings.allowAudios ? '✅' : '❌') + ' | Anti-Spam: ' + (settings.antiSpam ? '✅' : '❌') + '\n• Max. Verwarnungen: ' + settings.maxWarnings);
        return true;
    }
    if (command === p + 'ban') {
        if (mentions.length === 0) {
            await reply('⚠️ Nutzung:\n• `' + p + 'ban @User` – permanent\n• `' + p + 'ban @User 1h` – 1 Stunde\n• `' + p + 'ban @User 2d spam` – 2 Tage + Grund\n• Dauer: 30m, 2h, 1d, 7d, permanent');
            return true;
        }
        const target = mentions[0];
        if (isParticipantAdmin(meta, target) || isBotOwner(target)) {
            await reply('⚠️ Admins/Owner können nicht gebannt werden.');
            return true;
        }
        let durationArg = null;
        const reasonParts = [];
        for (const a of args.slice(1)) {
            if (a.startsWith('@')) continue;
            if (durationArg === null && parseBanDuration(a) !== null) {
                durationArg = a;
                continue;
            }
            reasonParts.push(a);
        }
        const parsed = parseBanDuration(durationArg);
        if (durationArg && parsed === null) {
            await reply('⚠️ Ungültige Dauer. Beispiele: `1h`, `2d`, `7d`, `permanent`');
            return true;
        }
        const until = parsed ? parsed.until : null;
        const label = parsed ? parsed.label : 'permanent';
        const reason = reasonParts.join(' ').trim() || 'Manueller Ban';
        const untilSql = until ? until.toISOString().slice(0, 19).replace('T', ' ') : null;
        await banUser(groupId, target, untilSql, reason, senderId);
        await logAction(groupId, target, 'BAN', reason + ' (' + label + ')', senderId, { duration: label, until: untilSql });
        try {
            await sock.groupParticipantsUpdate(groupId, [target], 'remove');
        } catch (e) {
            log('⚠️ Ban-Kick: ' + (e.message || e));
        }
        await reply('🚫 User gebannt (' + label + ').\nGrund: ' + reason + '\nBei Wiedereintritt wird automatisch gekickt.', [target]);
        return true;
    }
    if (command === p + 'unban') {
        if (mentions.length === 0) {
            await reply('⚠️ Nutzung: `' + p + 'unban @User`');
            return true;
        }
        const target = mentions[0];
        await unbanUser(groupId, target);
        await logAction(groupId, target, 'UNBAN', 'Manuell', senderId);
        await reply('✅ Ban aufgehoben.', [target]);
        return true;
    }
    if (command === p + 'banned') {
        const [rows] = await dbPool.query(
            'SELECT user_id, banned_until, reason FROM banned_users WHERE group_id = ? ORDER BY banned_at DESC LIMIT 30',
            [groupId]
        );
        const active = [];
        for (const r of rows) {
            const v = await validateBanRow(r, groupId);
            if (v) active.push(v);
        }
        if (active.length === 0) {
            await reply('📋 Niemand ist gebannt.');
            return true;
        }
        const list = active.map(r => {
            const id = r.user_id.split('@')[0];
            return '• ' + id + ' – ' + formatBanUntil(r) + (r.reason ? ' (' + r.reason + ')' : '');
        }).join('\n');
        await reply('📋 *Gebannt (' + active.length + '):*\n' + list);
        return true;
    }
    if (command === p + 'kick') {
        if (mentions.length === 0) {
            await reply('⚠️ Nutzung: `' + p + 'kick @User`');
            return true;
        }
        const target = mentions[0];
        if (isParticipantAdmin(meta, target) || isBotOwner(target)) {
            await reply('⚠️ Admins/Owner können nicht gekickt werden.');
            return true;
        }
        try {
            await sock.groupParticipantsUpdate(groupId, [target], 'remove');
            await logAction(groupId, target, 'KICK', 'Manueller Kick', senderId);
            await reply('👢 User entfernt.', [target]);
        } catch (e) {
            await reply('❌ Kick fehlgeschlagen: ' + (e.message || e));
            await logAction(groupId, target, 'KICK_FAIL', e.message || String(e), senderId);
        }
        return true;
    }
    if (command === p + 'warns') {
        if (mentions.length === 0) {
            await reply('⚠️ Nutzung: `' + p + 'warns @User`');
            return true;
        }
        const count = await getWarningCount(groupId, mentions[0]);
        await reply('⚠️ Verwarnungen: *' + count + '/' + settings.maxWarnings + '*', [mentions[0]]);
        return true;
    }
    if (command === p + 'resetwarns') {
        if (mentions.length === 0) {
            await reply('⚠️ Nutzung: `' + p + 'resetwarns @User`');
            return true;
        }
        await resetWarnings(groupId, mentions[0]);
        await logAction(groupId, mentions[0], 'RESET_WARNS', 'Manuell', senderId);
        await reply('✅ Verwarnungen zurückgesetzt.', [mentions[0]]);
        return true;
    }
    if (command === p + 'clearwarns') {
        await dbPool.query('DELETE FROM warnings WHERE group_id = ?', [groupId]);
        await logAction(groupId, senderId, 'CLEAR_WARNS', 'Alle gelöscht', senderId);
        await reply('✅ Alle Verwarnungen dieser Gruppe gelöscht.');
        return true;
    }
    if (command === p + 'addword' && args[1]) {
        const word = args.slice(1).join(' ').toLowerCase().trim();
        if (word.length < 2) {
            await reply('⚠️ Wort zu kurz.');
            return true;
        }
        await dbPool.query('INSERT IGNORE INTO bad_words (word) VALUES (?)', [word]);
        await reloadBadWordsCache();
        await logAction(SYSTEM_GROUP, 'bad_words', 'ADD_WORD', word, senderId);
        await reply('✅ Schimpfwort *' + word + '* hinzugefügt.');
        return true;
    }
    if (command === p + 'delword' && args[1]) {
        const word = args.slice(1).join(' ').toLowerCase().trim();
        await dbPool.query('DELETE FROM bad_words WHERE word = ?', [word]);
        await reloadBadWordsCache();
        await logAction(SYSTEM_GROUP, 'bad_words', 'DEL_WORD', word, senderId);
        await reply('✅ Schimpfwort *' + word + '* entfernt.');
        return true;
    }
    if (command === p + 'help') {
        await reply(
            '🛠 *Admin-Befehle (Baileys v3)*\n\n' +
            '• `' + p + 'bot on/off`\n' +
            '• `' + p + 'settings` / `' + p + 'stats` / `' + p + 'info` / `' + p + 'ping` / `' + p + 'logs [n]`\n' +
            '• `' + p + 'toggle <links|stickers|images|videos|audios|antispam|welcome>`\n' +
            '• `' + p + 'maxwarns <1-20>`\n' +
            '• `' + p + 'setwelcome` / `' + p + 'setleave`\n' +
            '• `' + p + 'lock` / `' + p + 'unlock`\n' +
            '• `' + p + 'mute` / `' + p + 'unmute` / `' + p + 'muted`\n' +
            '• `' + p + 'ban @User [Dauer] [Grund]` / `' + p + 'unban` / `' + p + 'banned`\n' +
            '• `' + p + 'kick`\n' +
            '• `' + p + 'warns` / `' + p + 'resetwarns` / `' + p + 'clearwarns`\n' +
            '• `' + p + 'addword` / `' + p + 'delword`\n\n' +
            '🤖 *KI (Ollama)* – für alle Nutzer:\n' +
            '• `' + p + 'ki <Frage>` – Ollama fragen (kennt Mitglieder)\n' +
            '• `' + p + 'kistatus` – Status & Modell\n' +
            '• `' + p + 'kimembers` – bekannte Mitgliedernamen\n' +
            '• `' + p + 'resetki` – Memory dieses Chats löschen'
        );
        return true;
    }
    return false;
}

async function onGroupParticipantsUpdate(update) {
    try {
        const groupId = update.id;
        groupMetaCache.delete(groupId);

        if (update.action === 'add') {
            for (const userId of update.participants || []) {
                const ban = await getActiveBan(groupId, userId);
                if (ban) {
                    log('🚫 Gebannter User rejoined → Kick: ' + userId);
                    try {
                        await sock.groupParticipantsUpdate(groupId, [userId], 'remove');
                        await logAction(groupId, userId, 'BAN_REKICK', ban.reason || 'Auto-Kick (Ban)', 'system', {
                            until: formatBanUntil(ban)
                        });
                        const num = normalizePhone(userId) || userId.split('@')[0];
                        await sendText(groupId, '🚫 @' + num + ' ist gebannt und wurde erneut entfernt.\nBis: ' + formatBanUntil(ban), [userId]);
                    } catch (e) {
                        console.error('Ban-Rekick fehlgeschlagen:', e.message || e);
                        await logAction(groupId, userId, 'BAN_REKICK_FAIL', e.message || String(e), 'system');
                    }
                    continue;
                }
                await logAction(groupId, userId, 'JOIN', null, 'system');
                const settings = await getGroupSettings(groupId);
                if (settings.isActive && settings.welcomeActive) {
                    const num = normalizePhone(userId) || userId.split('@')[0];
                    const t = settings.welcomeMsg.replace(/@user/gi, '@' + num);
                    await sendText(groupId, t, [userId]);
                    await logAction(groupId, userId, 'WELCOME_SENT', null, 'system');
                }
            }
        } else if (update.action === 'remove') {
            for (const userId of update.participants || []) {
                await logAction(groupId, userId, 'LEAVE', null, 'system');
            }
            const settings = await getGroupSettings(groupId);
            if (settings.isActive && settings.welcomeActive) {
                await sendText(groupId, settings.leaveMsg);
                await logAction(groupId, 'group', 'LEAVE_MSG_SENT', null, 'system');
            }
        }
    } catch (e) {
        console.error('group participants update:', e.message || e);
        await logAction(update?.id || SYSTEM_GROUP, 'system', 'ERROR', 'group-participants: ' + (e.message || e), 'system');
    }
}

async function onIncomingMessage(msg) {
    try {
        if (!msg?.message || !msg.key) return;
        if (msg.key.fromMe) return;
        const groupId = msg.key.remoteJid;
        if (!groupId || !isJidGroup(groupId)) return;
        const senderId = msg.key.participant || msg.participant || groupId;
        const text = extractText(msg);
        const msgType = detectMsgType(msg);
        stats.messages++;
        log('📩 "' + (text || '[' + msgType + ']') + '" from=' + senderId);
        const settings = await getGroupSettings(groupId);
        const meta = await getGroupMeta(groupId);
        const ownerHit = isBotOwner(senderId);
        const adminHit = isParticipantAdmin(meta, senderId);
        const isAdmin = ownerHit || adminHit;
        if (isAdmin) log('👤 Rechte: owner=' + ownerHit + ' groupAdmin=' + adminHit + ' sender=' + senderId);
        if (isAdmin && text.startsWith(PREFIX)) {
            const handled = await handleAdminCommands(msg, meta, settings, groupId, senderId, text);
            if (handled) {
                stats.commands++;
                log('✅ Admin-Befehl ausgeführt');
                // Command-Logging (ohne sensitive Texte)
                const cmdName = text.trim().split(/\s+/)[0].toLowerCase();
                await logAction(groupId, senderId, 'COMMAND', cmdName, senderId);
                return;
            }
        }

        // ===== KI-Modul (!ki / !kistatus / !resetki) – modular aus ollama.js =====
        // Erlaubt für alle Nutzer, sobald der Bot in der Gruppe aktiv ist
        // (oder Admin-Befehle, auch wenn Bot inaktiv – Status prüfen bleibt sinnvoll)
        if (text.startsWith(PREFIX)) {
            const lower = text.trim().toLowerCase();
            const p = PREFIX;
            const isKiCmd =
                lower === p + 'ki' ||
                lower.startsWith(p + 'ki ') ||
                lower === p + 'kistatus' ||
                lower === p + 'resetki' ||
                lower === p + 'kimembers';

            if (isKiCmd) {
                // !kistatus / !kimembers immer erlauben; !ki / !resetki nur wenn Gruppe aktiv
                const sub = text.trim().split(/\s+/)[1]?.toLowerCase();
                const needsActive = !(
                    lower === p + 'kistatus' ||
                    lower === p + 'kimembers' ||
                    (lower.startsWith(p + 'ki ') && (sub === 'status' || sub === 'members'))
                );
                if (needsActive && !settings.isActive) {
                    log('🔴 KI-Befehl ignoriert – Bot inaktiv (group=' + groupId + ')');
                    return;
                }
                const pushName = msg.pushName || 'User';
                const handled = await handleKiCommand(sock, msg, groupId, senderId, text, pushName);
                if (handled) {
                    stats.commands++;
                    log('✅ KI-Befehl ausgeführt');
                    const cmdName = text.trim().split(/\s+/)[0].toLowerCase();
                    await logAction(groupId, senderId, 'COMMAND', cmdName, senderId);
                    return;
                }
            }
        }

        if (!settings.isActive) {
            log('🔴 Bot inaktiv (group=' + groupId + ')');
            return;
        }
        if (await isMuted(groupId, senderId)) {
            await safeDeleteMessage(groupId, msg.key);
            await logAction(groupId, senderId, 'MUTE_DELETE', 'Nachricht von gemutetem User gelöscht', 'system');
            return;
        }
        let violationReason = null;
        if (settings.antiSpam && isSpamming(groupId, senderId)) {
            violationReason = 'Spam-Schutz: Zu viele Nachrichten.';
        }
        if (!violationReason) {
            if (!settings.allowStickers && msgType === 'sticker') violationReason = 'Sticker deaktiviert.';
            else if (!settings.allowImages && msgType === 'image') violationReason = 'Bilder deaktiviert.';
            else if (!settings.allowVideos && msgType === 'video') violationReason = 'Videos deaktiviert.';
            else if (!settings.allowAudios && (msgType === 'audio' || msgType === 'ptt')) violationReason = 'Audios deaktiviert.';
        }
        if (!violationReason && !settings.allowLinks && text && /(https?:\/\/[^\s]+|chat\.whatsapp\.com\/[a-zA-Z0-9]+)/i.test(text)) {
            violationReason = 'Links sind nicht gestattet.';
        }
        if (!violationReason && text) {
            const hit = profanity.findBadWord(text);
            if (hit) {
                log('🔤 Schimpfwort-Match: "' + hit + '"');
                violationReason = 'Schimpfwort erkannt.';
            }
        }
        if (violationReason) {
            stats.violations++;
            log('🚨 ' + violationReason + (isAdmin ? ' (Admin)' : ''));
            await handleViolation(msg, meta, groupId, senderId, violationReason, settings.maxWarnings, isAdmin);
        }
    } catch (error) {
        console.error('⚠️ Handler-Fehler:', error?.stack || error);
        await logAction(msg?.key?.remoteJid || SYSTEM_GROUP, 'system', 'ERROR', 'onIncomingMessage: ' + (error?.message || error), 'system');
    }
}

async function startSocket() {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    let version;
    try {
        const v = await fetchLatestBaileysVersion();
        version = v.version;
        log('📦 WA-Version: ' + version.join('.'));
    } catch (_) {}

    sock = makeWASocket({
        version,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
        },
        logger: pino({ level: process.env.BAILEYS_LOG_LEVEL || 'silent' }),
        printQRInTerminal: false,
        markOnlineOnConnect: false,
        syncFullHistory: false,
        generateHighQualityLinkPreview: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            console.log('\n📷 QR-Code (mit WhatsApp scannen):\n');
            qrcode.generate(qr, { small: true });
            if (!pairingRequested && CONFIG.phoneNumber) {
                pairingRequested = true;
                try {
                    const code = await sock.requestPairingCode(CONFIG.phoneNumber.replace(/\D/g, ''));
                    console.log('\n🔑 DEIN KOPPLUNGSCODE: ' + code + '\n');
                } catch (e) {
                    log('⚠️ Pairing-Code: ' + (e.message || e));
                }
            }
        }
        if (connection === 'open') {
            botStartTime = Date.now();
            log('🤖 Moderations-Bot v3.1.0 ist einsatzbereit!');
            await logAction(SYSTEM_GROUP, 'bot', 'CONNECTED', 'WhatsApp-Verbindung hergestellt', 'system');
        }
        if (connection === 'close') {
            const statusCode = (lastDisconnect?.error instanceof Boom)
                ? lastDisconnect.error.output?.statusCode
                : lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            log('🔌 Verbindung geschlossen. status=' + statusCode + ' reconnect=' + shouldReconnect);
            await logAction(SYSTEM_GROUP, 'bot', 'DISCONNECTED', 'status=' + statusCode + ' reconnect=' + shouldReconnect, 'system', {
                statusCode,
                shouldReconnect
            });
            if (shouldReconnect) {
                setTimeout(() => startSocket().catch(e => console.error(e)), 3000);
            } else {
                log('❌ Ausgeloggt – Auth-Ordner löschen und neu koppeln: ' + AUTH_DIR);
                await logAction(SYSTEM_GROUP, 'bot', 'LOGGED_OUT', 'Auth neu koppeln erforderlich', 'system');
            }
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify' && type !== 'append') return;
        for (const msg of messages) {
            await onIncomingMessage(msg);
        }
    });

    sock.ev.on('group-participants.update', onGroupParticipantsUpdate);
}

async function startBot() {
    try {
        if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
        await initDatabase();
        await logAction(SYSTEM_GROUP, 'bot', 'BOT_START', 'Bot startet', 'system');
        await syncAndLoadBadWords();

        // Ollama-Healthcheck (nicht blockierend – Bot läuft auch ohne KI)
        const kiCfg = getKiConfig();
        if (kiCfg.enabled) {
            const info = await checkOllama();
            if (info.ok) {
                log('🤖 Ollama OK – Host: ' + info.host + ' | Modell: ' + info.model +
                    (info.hasModel ? '' : ' ⚠️ Modell nicht gefunden') +
                    ' | Verfügbar: ' + (info.models.slice(0, 5).join(', ') || '–'));
            } else {
                log('⚠️ Ollama nicht erreichbar (' + info.host + '): ' + (info.error || 'offline') +
                    ' – !ki ist deaktiviert bis Ollama läuft');
            }
        } else {
            log('🤖 KI deaktiviert (KI_ENABLED=false)');
        }

        await startSocket();
    } catch (err) {
        console.error('❌ Start fehlgeschlagen:', err);
        try {
            await logAction(SYSTEM_GROUP, 'bot', 'BOT_START_FAIL', err.message || String(err), 'system');
        } catch (_) {}
        process.exit(1);
    }
}

startBot();
