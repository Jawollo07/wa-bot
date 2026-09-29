import { dbPool } from '../database/index.js';
import { deleteMessage, sendText, removeParticipant } from './message-service.js';
import { isParticipantAdmin, normalizePhone, extractMessageText, detectMessageType } from '../core/utils.js';
import { logAction } from '../logging/index.js';
import { getSpamLimit } from '../config/runtime.js';

const messageTimestamps = new Map();

export function isSpamming(groupId, userId) {
  const key = groupId + ':' + userId;
  const now = Date.now();
  const limit = getSpamLimit();
  const timestamps = (messageTimestamps.get(key) || []).filter((ts) => now - ts < limit.timeFrameMs);
  timestamps.push(now);
  messageTimestamps.set(key, timestamps);
  return timestamps.length > limit.maxMessages;
}

export async function addWarning(groupId, userId) {
  await dbPool.query(
    'INSERT INTO warnings (group_id, user_id, warn_count) VALUES (?, ?, 1) ON DUPLICATE KEY UPDATE warn_count = warn_count + 1',
    [groupId, userId]
  );
  const [rows] = await dbPool.query(
    'SELECT warn_count FROM warnings WHERE group_id = ? AND user_id = ?',
    [groupId, userId]
  );
  return rows[0]?.warn_count || 1;
}

export async function getWarningCount(groupId, userId) {
  const [rows] = await dbPool.query(
    'SELECT warn_count FROM warnings WHERE group_id = ? AND user_id = ?',
    [groupId, userId]
  );
  return rows[0]?.warn_count || 0;
}

export async function resetWarnings(groupId, userId) {
  await dbPool.query('DELETE FROM warnings WHERE group_id = ? AND user_id = ?', [groupId, userId]);
}

export async function isMuted(groupId, userId) {
  const [rows] = await dbPool.query(
    'SELECT 1 FROM muted_users WHERE group_id = ? AND user_id = ?',
    [groupId, userId]
  );
  return rows.length > 0;
}

export async function getActiveBan(groupId, userId) {
  const [rows] = await dbPool.query(
    'SELECT * FROM banned_users WHERE group_id = ? AND user_id = ?',
    [groupId, userId]
  );
  if (!rows.length) return null;
  const row = rows[0];
  if (row.banned_until && new Date(row.banned_until).getTime() <= Date.now()) {
    await dbPool.query('DELETE FROM banned_users WHERE group_id = ? AND user_id = ?', [groupId, userId]);
    return null;
  }
  return row;
}

export async function applyViolation({ msg, meta, groupId, senderId, reason, maxWarnings, isAdmin }) {
  const deleted = await deleteMessage(groupId, msg.key);
  const warns = await addWarning(groupId, senderId);
  const snippet = (extractMessageText(msg) || '[' + detectMessageType(msg) + ']').slice(0, 200);

  await logAction(groupId, senderId, 'WARN', reason, 'system', { warns, maxWarnings, deleted, snippet });
  const number = normalizePhone(senderId) || senderId.split('@')[0];

  if (warns >= maxWarnings) {
    if (isAdmin || isParticipantAdmin(meta, senderId)) {
      await sendText(groupId, '⛔ @' + number + ' hat das Warnlimit erreicht, wird als *Admin* nicht gekickt.\n*Grund:* ' + reason, [senderId]);
      await resetWarnings(groupId, senderId);
      return { action: 'admin-protected', warns };
    }

    await sendText(groupId, '⛔ @' + number + ' wurde automatisch gekickt.\n*Grund:* Maximale Verwarnungen erreicht.', [senderId]);
    try {
      await removeParticipant(groupId, senderId);
    } catch (error) {
      await logAction(groupId, senderId, 'KICK_FAIL', error.message || String(error), 'system');
    }
    await resetWarnings(groupId, senderId);
    await logAction(groupId, senderId, 'KICK', 'Maximale Verwarnungen erreicht', 'system', { reason });
    return { action: 'kick', warns };
  }

  await sendText(groupId, '⚠️ @' + number + ', deine Nachricht wurde entfernt.\n*Grund:* ' + reason + '\n*Verwarnung:* ' + warns + '/' + maxWarnings, [senderId]);
  return { action: 'warn', warns };
}
