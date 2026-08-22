import 'dotenv/config';
import mysql from 'mysql2/promise';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import initDatabase from './src/database/index.js';
import handleAdminCommands from './src/commands/index.js';
import log, { logAction } from './src/logging/index.js';
import startSocket from './src/bot/index.js';
import * as profanity from './src/moderation/index.js';
import { handleKiCommand, checkOllama, getKiConfig, applyKiConfig, initKiDb, checkProfanityWithKi } from './src/ai/index.js';
import {
    initBotConfig,
    reloadBotConfig,
    getConfig,
    getConfigBool,
    getConfigInt,
    setConfig,
    getPrefix,
    getAuthDir,
    getPhoneNumber,
    getBotOwners,
    getSpamLimit,
    getKiSettingsFromDb,
    formatConfigList,
    isKnownConfigKey,
    CONFIG_DEFAULTS
} from './src/config/runtime.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SYSTEM_GROUP = 'SYSTEM';

export const CONFIG = {
    db: {
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_DATABASE,
        port: Number(process.env.DB_PORT) || 3306,
        connectionLimit: Number(process.env.DB_POOL_SIZE) || 10
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
        allowKi: true,
        welcomeMsg: 'Willkommen in der Gruppe, @user! 👋',
        leaveMsg: 'Ein Nutzer hat die Gruppe verlassen. 😢'
    },
    wordUrls: [
        'https://raw.githubusercontent.com/AdvancedPlugins/Chat/main/swear%20words/de.json'
    ]
};

function PREFIX() { return getPrefix(); }
function AUTH_DIR() { return getAuthDir(); }

let dbPool;
let loadedBadWords = [];
const messageTimestamps = new Map();
const groupMetaCache = new Map();
const GROUP_CACHE_TTL = 60_000;
let botStartTime = Date.now();
let stats = { messages: 0, violations: 0, commands: 0 };

process.on('unhandledRejection', (r) => console.error('[unhandledRejection]', r));
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e));

function normalizePhone(id) { return String(id || '').replace(/\D/g, ''); }
function isBotOwner(senderId) {
    if (!senderId) return false;
    const num = normalizePhone(senderId);
    if (num.length < 8) return false;
    return getBotOwners().some(owner => {
        if (!owner || owner.length < 8) return false;
        return num === owner || num.endsWith(owner) || owner.endsWith(num);
    });
}
function jidNormalizedUser(jid) { return jid ? String(jid).split(':')[0] : ''; }
function isJidGroup(jid) { return typeof jid === 'string' && jid.endsWith('@g.us'); }
function extractText(msg) {
    const m = msg.message || {};
    return m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption || m.videoMessage?.caption || m.documentMessage?.caption || m.buttonsResponseMessage?.selectedDisplayText || m.listResponseMessage?.title || '';
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
        const meta = await globalThis.__waBotSocket?.groupMetadata(groupId);
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
    return !!p && (p.admin === 'admin' || p.admin === 'superadmin' || p.isAdmin || p.isSuperAdmin);
}

async function syncAndLoadBadWords() {
    log('🔄 Synchronisiere Schimpfwörter...');
    const wordsSet = new Set();
    for (const url of CONFIG.wordUrls) {
        try {
            const response = await fetch(url);
            if (!response.ok) continue;
            const data = await response.json();
            const rawWords = Array.isArray(data) ? data : (typeof data === 'object' ? Object.values(data).flat() : []);
            for (const word of rawWords) if (typeof word === 'string' && word.trim().length > 1) wordsSet.add(word.trim().toLowerCase());
        } catch (_) {}
    }
    if (wordsSet.size) {
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
export default function mapSettingsRow(r) {
    return {
        groupId: r.group_id,
        isActive: dbFlag(r.is_active, false), allowLinks: dbFlag(r.allow_links, false), allowStickers: dbFlag(r.allow_stickers, false),
        allowImages: dbFlag(r.allow_images, true), allowVideos: dbFlag(r.allow_videos, true), allowAudios: dbFlag(r.allow_audios, true),
        antiSpam: dbFlag(r.anti_spam, true), maxWarnings: r.max_warnings != null ? Number(r.max_warnings) : CONFIG.defaultSettings.maxWarnings,
        welcomeActive: dbFlag(r.welcome_active, false), allowKi: dbFlag(r.allow_ki, true),
        welcomeMsg: r.welcome_msg || CONFIG.defaultSettings.welcomeMsg, leaveMsg: r.leave_msg || CONFIG.defaultSettings.leaveMsg
    };
}

async function startBot() {
    try {
        if (!fs.existsSync(AUTH_DIR())) fs.mkdirSync(AUTH_DIR(), { recursive: true });
        dbPool = await initDatabase();
        await initBotConfig(dbPool);
        applyKiConfig(getKiSettingsFromDb());
        await initKiDb(dbPool);
        log('⚙️ Config aus MySQL (bot_config) · KI-Memory in DB · Prefix: ' + PREFIX());
        await logAction(SYSTEM_GROUP, 'bot', 'BOT_START', 'Bot startet', 'system');
        await syncAndLoadBadWords();
        const kiCfg = getKiConfig();
        if (kiCfg.enabled) {
            const info = await checkOllama();
            if (info.ok) log('🤖 Ollama OK – Host: ' + info.host + ' | Modell: ' + info.model);
            else log('⚠️ Ollama nicht erreichbar (' + info.host + '): ' + (info.error || 'offline'));
        }
        await startSocket();
    } catch (err) {
        console.error('❌ Start fehlgeschlagen:', err);
        try { await logAction(SYSTEM_GROUP, 'bot', 'BOT_START_FAIL', err.message || String(err), 'system'); } catch (_) {}
        process.exit(1);
    }
}

startBot();
