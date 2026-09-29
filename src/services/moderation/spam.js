import { getSpamLimit } from '../../config/runtime.js';
const timestamps = new Map();

export function isSpamming(groupId, userId) {
  const key = groupId + ':' + userId;
  const now = Date.now();
  const limit = getSpamLimit();
  const current = (timestamps.get(key) || []).filter((ts) => now - ts < limit.timeFrameMs);
  current.push(now);
  timestamps.set(key, current);
  return current.length > limit.maxMessages;
}

export function clearSpamState(groupId, userId) {
  timestamps.delete(groupId + ':' + userId);
}
