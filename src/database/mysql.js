import mysql from 'mysql2/promise';
import { CONFIG } from '../config/app.js';
import log from '../core/logger.js';
let dbPool;
export { dbPool };
export default async function initDatabase() {
    dbPool = mysql.createPool({ ...CONFIG.db, waitForConnections: true, connectionLimit: 10, queueLimit: 0 });
    await dbPool.query('CREATE TABLE IF NOT EXISTS bad_words (id INT AUTO_INCREMENT PRIMARY KEY, word VARCHAR(191) UNIQUE NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');
    await dbPool.query('CREATE TABLE IF NOT EXISTS warnings (id INT AUTO_INCREMENT PRIMARY KEY, group_id VARCHAR(191) NOT NULL, user_id VARCHAR(191) NOT NULL, warn_count INT DEFAULT 1, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, UNIQUE KEY unique_user_group (group_id, user_id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');
    await dbPool.query('CREATE TABLE IF NOT EXISTS community_settings (community_id VARCHAR(191) PRIMARY KEY, enabled TINYINT(1) DEFAULT 1, allow_links TINYINT(1) NULL, allow_stickers TINYINT(1) NULL, allow_images TINYINT(1) NULL, allow_videos TINYINT(1) NULL, allow_audios TINYINT(1) NULL, anti_spam TINYINT(1) NULL, max_warnings INT NULL, allow_ki TINYINT(1) NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');
    await dbPool.query('CREATE TABLE IF NOT EXISTS group_settings (group_id VARCHAR(191) PRIMARY KEY, is_active TINYINT(1) DEFAULT 1, allow_links TINYINT(1) DEFAULT 0, allow_stickers TINYINT(1) DEFAULT 0, allow_images TINYINT(1) DEFAULT 1, allow_videos TINYINT(1) DEFAULT 1, allow_audios TINYINT(1) DEFAULT 1, anti_spam TINYINT(1) DEFAULT 1, max_warnings INT DEFAULT 3, welcome_active TINYINT(1) DEFAULT 0, welcome_msg TEXT, leave_msg TEXT) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');
    log('🔄 Prüfe group_settings-Schema...');
    await ensureColumn('group_settings', 'community_override', 'TINYINT(1) DEFAULT 0');
    await ensureColumn('group_settings', 'is_active', 'TINYINT(1) DEFAULT 1');
    await ensureColumn('group_settings', 'auto_activation_disabled', 'TINYINT(1) DEFAULT 0');
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
    await ensureColumn('group_settings', 'allow_ki', 'TINYINT(1) DEFAULT 1');
    await dbPool.query('CREATE TABLE IF NOT EXISTS mod_logs (id INT AUTO_INCREMENT PRIMARY KEY,group_id VARCHAR(191) NOT NULL,user_id VARCHAR(191) NOT NULL,actor_id VARCHAR(191) NULL,action VARCHAR(64) NOT NULL,reason TEXT,details TEXT,created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,INDEX idx_group (group_id),INDEX idx_action (action),INDEX idx_created (created_at),INDEX idx_user (user_id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');
    log('🔄 Prüfe mod_logs-Schema...');
    await ensureColumn('mod_logs', 'actor_id', 'VARCHAR(191) NULL');
    await ensureColumn('mod_logs', 'details', 'TEXT');
    try { await dbPool.query('ALTER TABLE mod_logs MODIFY COLUMN action VARCHAR(64) NOT NULL'); } catch (_) {}
    await dbPool.query('CREATE TABLE IF NOT EXISTS muted_users (group_id VARCHAR(191) NOT NULL, user_id VARCHAR(191) NOT NULL, muted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (group_id, user_id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');
    await dbPool.query('CREATE TABLE IF NOT EXISTS banned_users (group_id VARCHAR(191) NOT NULL,user_id VARCHAR(191) NOT NULL,banned_until DATETIME NULL,reason TEXT,banned_by VARCHAR(191),banned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,PRIMARY KEY (group_id, user_id),INDEX idx_until (banned_until)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');
    log('✅ MySQL-Datenbank erfolgreich initialisiert!');
    return dbPool;
}
export async function ensureGroupAutoActive(groupId) {
    await dbPool.query('UPDATE group_settings SET is_active = 1 WHERE group_id = ? AND COALESCE(auto_activation_disabled, 0) = 0', [groupId]);
    return getGroupSettings(groupId);
}

export async function getCommunitySettings(communityId) {
    const [rows] = await dbPool.query('SELECT * FROM community_settings WHERE community_id = ?', [communityId]);
    if (!rows.length) return { communityId, enabled: true, allowLinks: null, allowStickers: null, allowImages: null, allowVideos: null, allowAudios: null, antiSpam: null, maxWarnings: null, allowKi: null };
    const r = rows[0];
    return { communityId, enabled: dbFlag(r.enabled, true), allowLinks: r.allow_links == null ? null : dbFlag(r.allow_links), allowStickers: r.allow_stickers == null ? null : dbFlag(r.allow_stickers), allowImages: r.allow_images == null ? null : dbFlag(r.allow_images), allowVideos: r.allow_videos == null ? null : dbFlag(r.allow_videos), allowAudios: r.allow_audios == null ? null : dbFlag(r.allow_audios), antiSpam: r.anti_spam == null ? null : dbFlag(r.anti_spam), maxWarnings: r.max_warnings == null ? null : Number(r.max_warnings), allowKi: r.allow_ki == null ? null : dbFlag(r.allow_ki) };
}

export async function setCommunitySetting(communityId, field, value) {
    const allowed = { links: 'allow_links', stickers: 'allow_stickers', images: 'allow_images', videos: 'allow_videos', audios: 'allow_audios', antispam: 'anti_spam', ki: 'allow_ki', maxwarns: 'max_warnings' };
    const column = allowed[field];
    if (!column) throw new Error('Ungültige Community-Einstellung.');
    await dbPool.query('INSERT INTO community_settings (community_id, ' + column + ') VALUES (?, ?) ON DUPLICATE KEY UPDATE ' + column + '=VALUES(' + column + ')', [communityId, value]);
    return getCommunitySettings(communityId);
}

export async function setCommunityEnabled(communityId, enabled) {
    await dbPool.query('INSERT INTO community_settings (community_id, enabled) VALUES (?, ?) ON DUPLICATE KEY UPDATE enabled=VALUES(enabled)', [communityId, enabled ? 1 : 0]);
    return getCommunitySettings(communityId);
}

export async function setGroupCommunityOverride(groupId, enabled) {
    await dbPool.query('INSERT INTO group_settings (group_id, community_override) VALUES (?, ?) ON DUPLICATE KEY UPDATE community_override=VALUES(community_override)', [groupId, enabled ? 1 : 0]);
}

export async function getGroupSettings(groupId) {
    const [rows] = await dbPool.query('SELECT * FROM group_settings WHERE group_id = ?', [groupId]);
    if (rows.length === 0) {
        const d = CONFIG.defaultSettings;
        await dbPool.query('INSERT IGNORE INTO group_settings (group_id, is_active, allow_links, allow_stickers, allow_images, allow_videos, allow_audios, anti_spam, max_warnings, welcome_active, welcome_msg, leave_msg, allow_ki) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [groupId, d.isActive ? 1 : 0, d.allowLinks ? 1 : 0, d.allowStickers ? 1 : 0, d.allowImages ? 1 : 0, d.allowVideos ? 1 : 0, d.allowAudios ? 1 : 0, d.antiSpam ? 1 : 0, d.maxWarnings, d.welcomeActive ? 1 : 0, d.welcomeMsg, d.leaveMsg, d.allowKi !== false ? 1 : 0]);
        const [again] = await dbPool.query('SELECT * FROM group_settings WHERE group_id = ?', [groupId]);
        if (again.length) return mapSettingsRow(again[0]);
        return { ...d, groupId };
    }
    return mapSettingsRow(rows[0]);
}
export async function ensureColumn(table, column, definition) {
    try {
        const [rows] = await dbPool.query('SELECT COUNT(*) AS cnt FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?', [table, column]);
        if (rows[0].cnt === 0) {
            await dbPool.query('ALTER TABLE `' + table + '` ADD COLUMN `' + column + '` ' + definition);
            log('  ➕ ' + table + '.' + column);
        }
    } catch (err) {
        try { await dbPool.query('ALTER TABLE `' + table + '` ADD COLUMN `' + column + '` ' + definition); log('  ➕ ' + table + '.' + column); }
        catch (e) { if (!String(e.message || e).includes('Duplicate column')) console.error('  ⚠️ Migration ' + table + '.' + column + ':', e.message || e); }
    }
}


function dbFlag(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return value === '1' || value.toLowerCase() === 'true';
  return Boolean(value);
}
function mapSettingsRow(r) {
  return {
    groupId: r.group_id,
    isActive: dbFlag(r.is_active),
    communityOverride: dbFlag(r.community_override),
    allowLinks: dbFlag(r.allow_links),
    allowStickers: dbFlag(r.allow_stickers),
    allowImages: dbFlag(r.allow_images, true),
    allowVideos: dbFlag(r.allow_videos, true),
    allowAudios: dbFlag(r.allow_audios, true),
    antiSpam: dbFlag(r.anti_spam, true),
    maxWarnings: r.max_warnings != null ? Number(r.max_warnings) : 3,
    welcomeActive: dbFlag(r.welcome_active),
    allowKi: dbFlag(r.allow_ki, true),
    welcomeMsg: r.welcome_msg || 'Willkommen in der Gruppe, @user! 👋',
    leaveMsg: r.leave_msg || 'Ein Nutzer hat die Gruppe verlassen. 😢'
  };
}
