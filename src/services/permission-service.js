import { getBotOwners } from '../config/runtime.js';
import { normalizePhone } from '../core/utils.js';

export function isBotOwner(userId) {
  const number = normalizePhone(userId);
  if (number.length < 8) return false;

  return getBotOwners().some((owner) => {
    if (!owner || owner.length < 8) return false;
    return number === owner || number.endsWith(owner) || owner.endsWith(number);
  });
}

export function canManageGroup(meta, userId) {
  if (isBotOwner(userId)) return true;
  return meta?.participants?.some((p) => {
    const id = p.id || p.jid;
    return id === userId && ['admin', 'superadmin'].includes(p.admin);
  }) || false;
}
