export function normalizePhone(id) {
  return String(id || '').replace(/\D/g, '');
}

export function normalizeJid(jid) {
  return jid ? String(jid).split(':')[0] : '';
}

export function isGroupJid(jid) {
  return typeof jid === 'string' && jid.endsWith('@g.us');
}

export function extractMessageText(msg) {
  const m = msg?.message || {};
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

export function detectMessageType(msg) {
  const m = msg?.message || {};
  if (m.stickerMessage) return 'sticker';
  if (m.imageMessage) return 'image';
  if (m.videoMessage) return 'video';
  if (m.audioMessage) return m.audioMessage.ptt ? 'ptt' : 'audio';
  if (m.documentMessage) return 'document';
  if (m.conversation || m.extendedTextMessage) return 'chat';
  return 'unknown';
}

export function isParticipantAdmin(meta, userId) {
  if (!meta?.participants || !userId) return false;
  const uid = normalizeJid(userId);
  const p = meta.participants.find((x) => {
    const id = normalizeJid(x.id || x.jid || '');
    const lid = x.lid ? normalizeJid(x.lid) : '';
    return id === uid || lid === uid || normalizePhone(id) === normalizePhone(uid);
  });
  return !!p && (p.admin === 'admin' || p.admin === 'superadmin' || p.isAdmin || p.isSuperAdmin);
}

export function parseMentions(msg) {
  const ctx =
    msg?.message?.extendedTextMessage?.contextInfo ||
    msg?.message?.imageMessage?.contextInfo ||
    msg?.message?.videoMessage?.contextInfo ||
    {};
  return ctx.mentionedJid || [];
}

export function formatUptime(ms) {
  const seconds = Math.floor(ms / 1000);
  return [
    Math.floor(seconds / 3600) + 'h',
    Math.floor((seconds % 3600) / 60) + 'm',
    (seconds % 60) + 's'
  ].join(' ');
}
