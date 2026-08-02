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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PREFIX = process.env.COMMAND_PREFIX || '!';
const AUTH_DIR = process.env.BAILEYS_AUTH_PATH || path.join(__dirname, 'auth_baileys');
const VERSION = '3.1.0';
const NODE_ENV = process.env.NODE_ENV || 'production';
let isShuttingDown = false;
let reconnectAttempts = 0;
let reconnectTimer = null;
const processedMsgIds = new Map();
const settingsCache = new Map();
const SETTINGS_CACHE_TTL = Number(process.env.SETTINGS_CACHE_TTL_MS) || 15000;

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
let sock = null;
let loadedBadWords = [];
const messageTimestamps = new Map();
const groupMetaCache = new Map();
const GROUP_CACHE_TTL = 60_000;
let botStartTime = Date.now();
let stats = { messages: 0, violations: 0, commands: 0 };
let pairingRequested = false;

process.on('unhandledRejection', (r) => console.error('[unhandledRejection]', r));
process.on('uncaughtException', (e) => {
    console.error('[uncaughtException]', e);
});

function log(...args) {
    const t = new Date().toISOString().slice(11, 19);
    console.log('[' + t + ']', ...args);
}

function validateConfig() {
    const required = ['DB_HOST', 'DB_USER', 'DB_DATABASE'];
    const missing = required.filter(k => !process.env[k]);
    if (missing.length) {
        console.error('❌ Fehlende Umgebungsvariablen: ' + missing.join(', '));
        console.error('   Kopiere .env.example nach .env und fülle die Werte aus.');
        process.exit(1);
    }
}

function isDuplicateMessage(msg) {
    const id = msg?.key?.id;
    if (!id) return false;
    const now = Date.now();
    if (processedMsgIds.has(id)) return true;
    processedMsgIds.set(id, now);
    if (processedMsgIds.size > 5000) {
        for (const [k, ts] of processedMsgIds) {
            if (now - ts > 120000) processedMsgIds.delete(k);
        }
    }
    return false;
}

function invalidateSettingsCache(groupId) {
    if (groupId) settingsCache.delete(groupId);
    else settingsCache.clear();
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
    dbPool = mysql.createPool({
        ...CONFIG.db,
        waitForConnections: true,
        connectionLimit: Number(process.env.DB_POOL_SIZE) || 10,
        queueLimit: 0,
        enableKeepAlive: true,
        keepAliveInitialDelay: 10000,
        timezone: 'Z',
        charset: 'utf8mb4'
    });
    const _c = await dbPool.getConnection();
    await _c.ping();
    _c.release();
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

// NOTE: rest of bot continues in same file - truncated for tool; will fix
console.error('INCOMPLETE FILE - DO NOT USE');
process.exit(1);
