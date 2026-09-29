import { dbPool } from '../../database/index.js';

export async function addWarning(groupId, userId) {
  await dbPool.query(
    'INSERT INTO warnings (group_id, user_id, warn_count) VALUES (?, ?, 1) ON DUPLICATE KEY UPDATE warn_count = warn_count + 1',
    [groupId, userId]
  );
  const [rows] = await dbPool.query('SELECT warn_count FROM warnings WHERE group_id = ? AND user_id = ?', [groupId, userId]);
  return rows[0]?.warn_count || 1;
}

export async function getWarningCount(groupId, userId) {
  const [rows] = await dbPool.query('SELECT warn_count FROM warnings WHERE group_id = ? AND user_id = ?', [groupId, userId]);
  return rows[0]?.warn_count || 0;
}

export async function resetWarnings(groupId, userId) {
  await dbPool.query('DELETE FROM warnings WHERE group_id = ? AND user_id = ?', [groupId, userId]);
}

export async function clearWarnings(groupId) {
  await dbPool.query('DELETE FROM warnings WHERE group_id = ?', [groupId]);
}
