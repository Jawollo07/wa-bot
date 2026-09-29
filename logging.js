import { dbPool } from './db.js';

export default function log(...args) {
  const t = new Date().toISOString().slice(11, 19);
  console.log('[' + t + ']', ...args);
}

export async function logAction(groupId, userId, action, reason = null, actorId = null, details = null) {
  try {
    if (!dbPool) return;
    const detailsStr = details == null ? null : (typeof details === 'string' ? details : JSON.stringify(details));
    await dbPool.query(
      'INSERT INTO mod_logs (group_id, user_id, actor_id, action, reason, details) VALUES (?, ?, ?, ?, ?, ?)',
      [groupId || 'SYSTEM', userId || 'system', actorId || null, String(action).slice(0, 64), reason || null, detailsStr]
    );
  } catch (error) {
    console.error('[logAction]', error.message || error);
  }
}
