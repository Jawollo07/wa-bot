import { dbPool } from '../../database/index.js';

export async function isMuted(groupId, userId) {
  const [rows] = await dbPool.query('SELECT 1 FROM muted_users WHERE group_id = ? AND user_id = ?', [groupId, userId]);
  return rows.length > 0;
}

export async function mute(groupId, userId) {
  await dbPool.query('INSERT IGNORE INTO muted_users (group_id, user_id) VALUES (?, ?)', [groupId, userId]);
}

export async function unmute(groupId, userId) {
  await dbPool.query('DELETE FROM muted_users WHERE group_id = ? AND user_id = ?', [groupId, userId]);
}

export async function listMuted(groupId) {
  const [rows] = await dbPool.query('SELECT user_id FROM muted_users WHERE group_id = ?', [groupId]);
  return rows.map((row) => row.user_id);
}
