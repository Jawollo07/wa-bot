import { getRuntimeSocket } from '../core/runtime.js';

export async function sendText(groupId, text, mentions = [], options = {}) {
  const sock = getRuntimeSocket();
  if (!sock) throw new Error('WhatsApp-Socket ist nicht verfügbar');
  const content = mentions.length ? { text, mentions } : { text };
  return sock.sendMessage(groupId, content, options);
}

export async function deleteMessage(groupId, key) {
  const sock = getRuntimeSocket();
  if (!sock) return false;
  try {
    await sock.sendMessage(groupId, { delete: key });
    return true;
  } catch {
    return false;
  }
}

export async function removeParticipant(groupId, userId) {
  const sock = getRuntimeSocket();
  if (!sock) throw new Error('WhatsApp-Socket ist nicht verfügbar');
  return sock.groupParticipantsUpdate(groupId, [userId], 'remove');
}
