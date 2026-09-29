import { getGroupSettings, getCommunitySettings } from '../database/index.js';
import { getRuntimeSocket } from '../core/runtime.js';
import { normalizeJid, normalizePhone, isParticipantAdmin } from '../core/utils.js';
import log from '../logging/index.js';

const cache = new Map();
const CACHE_TTL = 60_000;

export function invalidateGroup(groupId) { cache.delete(groupId); }

export async function getGroupMeta(groupId) {
  const cached = cache.get(groupId);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) return cached.meta;
  const sock = getRuntimeSocket();
  if (!sock) return cached?.meta || null;
  try {
    const meta = await sock.groupMetadata(groupId);
    cache.set(groupId, { meta, timestamp: Date.now() });
    return meta;
  } catch (error) {
    log('⚠️ groupMetadata: ' + (error.message || error));
    return cached?.meta || null;
  }
}

export async function getGroupContext(groupId, senderId, owners = []) {
  const meta = await getGroupMeta(groupId);
  const normalized = normalizePhone(senderId);
  const isOwner = owners.some((owner) => normalized === owner || normalized.endsWith(owner) || owner.endsWith(normalized));
  return { groupId, meta, senderId, isOwner, isAdmin: isOwner || isParticipantAdmin(meta, senderId) };
}

export async function getSettings(groupId) { return getGroupSettings(groupId); }

export async function getParticipatingGroups() {
  const sock = getRuntimeSocket();
  if (!sock?.groupFetchAllParticipating) return [];
  try {
    const groups = await sock.groupFetchAllParticipating();
    return Object.values(groups || {});
  } catch (error) {
    log('⚠️ groupFetchAllParticipating: ' + (error.message || error));
    return [];
  }
}

export function isCommunityGroup(meta) {
  return Boolean(meta?.isCommunity || meta?.isCommunityAnnounce || meta?.linkedParent);
}

export { normalizeJid };


export function getCommunityId(meta) {
  if (!meta) return null;
  if (meta.isCommunity && meta.id) return meta.id;
  return meta.linkedParent || null;
}

export async function getEffectiveGroupSettings(groupId, meta = null) {
  const group = await getGroupSettings(groupId);
  const communityId = getCommunityId(meta);
  if (!communityId || group.communityOverride) return { ...group, communityId, communityApplied: false };
  const community = await getCommunitySettings(communityId);
  if (!community.enabled) return { ...group, communityId, communityApplied: false };
  const merged = { ...group };
  for (const key of ['allowLinks','allowStickers','allowImages','allowVideos','allowAudios','antiSpam','maxWarnings','allowKi']) {
    if (community[key] !== null && community[key] !== undefined) merged[key] = community[key];
  }
  merged.communityId = communityId;
  merged.communityApplied = true;
  return merged;
}
