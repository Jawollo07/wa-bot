import { dbPool } from '../../database/index.js';
import { normalizePhone } from '../../core/utils.js';

export function parseBanDuration(str) {
  if (!str) return { until: null, label: 'permanent' };
  const s = String(str).toLowerCase().trim();
  if (['permanent', 'perm', 'perma', 'permament', 'forever', 'ewig'].includes(s)) return { until: null, label: 'permanent' };
  const m = s.match(/^(\d+)\s*(m|min|h|d|w)$/i);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  const factors = { m: 60000, min: 60000, h: 3600000, d: 86400000, w: 604800000 };
  if (!factors[unit] || n <= 0) return null;
  return { until: new Date(Date.now() + n * factors[unit]), label: n + unit };
}

async function validateBanRow(row, groupId) {
  if (row?.banned_until && new Date(row.banned_until).getTime() <= Date.now()) {
    await dbPool.query('DELETE FROM banned_users WHERE group_id = ? AND user_id = ?', [groupId, row.user_id]);
    return null;
  }
  return row;
}

export async function getActiveBan(groupId, userId) {
  const [rows] = await dbPool.query('SELECT * FROM banned_users WHERE group_id = ? AND user_id = ?', [groupId, userId]);
  if (rows.length) return validateBanRow(rows[0], groupId);
  const phone = normalizePhone(userId);
  if (phone.length < 8) return null;
  const [fallback] = await dbPool.query(
    "SELECT * FROM banned_users WHERE group_id = ? AND REPLACE(REPLACE(user_id, '@s.whatsapp.net', ''), '@lid', '') LIKE ?",
    [groupId, '%' + phone + '%']
  );
  return fallback.length ? validateBanRow(fallback[0], groupId) : null;
}

export async function banUser(groupId, userId, until, reason, bannedBy) {
  await dbPool.query(
    'INSERT INTO banned_users (group_id, user_id, banned_until, reason, banned_by) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE banned_until = VALUES(banned_until), reason = VALUES(reason), banned_by = VALUES(banned_by), banned_at = CURRENT_TIMESTAMP',
    [groupId, userId, until, reason || null, bannedBy || null]
  );
}

export async function unbanUser(groupId, userId) {
  await dbPool.query('DELETE FROM banned_users WHERE group_id = ? AND user_id = ?', [groupId, userId]);
  const phone = normalizePhone(userId);
  if (phone.length >= 8) {
    await dbPool.query(
      "DELETE FROM banned_users WHERE group_id = ? AND REPLACE(REPLACE(user_id, '@s.whatsapp.net', ''), '@lid', '') LIKE ?",
      [groupId, '%' + phone + '%']
    );
  }
}

export function formatBanUntil(row) {
  if (!row?.banned_until) return 'permanent';
  return new Date(row.banned_until).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}
