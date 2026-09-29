import { deleteMessage, sendText, removeParticipant } from '../message-service.js';
import { isParticipantAdmin, normalizePhone, extractMessageText, detectMessageType } from '../../core/utils.js';
import { logAction } from '../../logging/index.js';
import { addWarning, resetWarnings } from './warnings.js';

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
    try { await removeParticipant(groupId, senderId); }
    catch (error) { await logAction(groupId, senderId, 'KICK_FAIL', error.message || String(error), 'system'); }
    await resetWarnings(groupId, senderId);
    await logAction(groupId, senderId, 'KICK', 'Maximale Verwarnungen erreicht', 'system', { reason });
    return { action: 'kick', warns };
  }

  await sendText(groupId, '⚠️ @' + number + ', deine Nachricht wurde entfernt.\n*Grund:* ' + reason + '\n*Verwarnung:* ' + warns + '/' + maxWarnings, [senderId]);
  return { action: 'warn', warns };
}
