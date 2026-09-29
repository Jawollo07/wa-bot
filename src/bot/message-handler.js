import { getGroupSettings } from '../database/index.js';
import { getPrefix, getConfigBool, getConfigInt, getBotOwners } from '../config/runtime.js';
import { getStats, incrementStat, getRuntimeSocket } from '../core/runtime.js';
import { extractMessageText, detectMessageType, isGroupJid, normalizePhone, parseMentions } from '../core/utils.js';
import { getGroupMeta, getGroupContext, getEffectiveGroupSettings, invalidateGroup } from '../services/group-service.js';
import { isBotOwner } from '../services/permission-service.js';
import { sendText } from '../services/message-service.js';
import { getActiveBan, isMuted } from '../services/moderation/index.js';
import { isSpamming } from '../services/moderation/spam.js';
import { applyViolation } from '../services/moderation/violations.js';
import { dispatchCommand } from '../commands/index.js';
import { handleKiCommand, checkProfanityWithKi } from '../ki/index.js';
import * as profanity from '../moderation/profanity.js';
import log, { logAction } from '../logging/index.js';

const SYSTEM_GROUP = 'SYSTEM';

export async function onGroupParticipantsUpdate(update) {
  const groupId = update?.id;
  if (!groupId) return;

  try {
    invalidateGroup(groupId);

    if (update.action === 'add') {
      for (const userId of update.participants || []) {
        const ban = await getActiveBan(groupId, userId);

        if (ban) {
          log('🚫 Gebannter User rejoined → Kick: ' + userId);
          try {
            const sock = getRuntimeSocket();
            await sock.groupParticipantsUpdate(groupId, [userId], 'remove');
            await logAction(groupId, userId, 'BAN_REKICK', ban.reason || 'Auto-Kick (Ban)', 'system', {
              until: ban.banned_until || null
            });
            const number = normalizePhone(userId) || userId.split('@')[0];
            await sendText(groupId, '🚫 @' + number + ' ist gebannt und wurde erneut entfernt.', [userId]);
          } catch (error) {
            await logAction(groupId, userId, 'BAN_REKICK_FAIL', error.message || String(error), 'system');
          }
          continue;
        }

        await logAction(groupId, userId, 'JOIN', null, 'system');
        const settings = await getGroupSettings(groupId);
        if (settings.isActive && settings.welcomeActive) {
          const number = normalizePhone(userId) || userId.split('@')[0];
          await sendText(groupId, settings.welcomeMsg.replace(/@user/gi, '@' + number), [userId]);
          await logAction(groupId, userId, 'WELCOME_SENT', null, 'system');
        }
      }
      return;
    }

    if (update.action === 'remove') {
      for (const userId of update.participants || []) {
        await logAction(groupId, userId, 'LEAVE', null, 'system');
      }

      const settings = await getGroupSettings(groupId);
      if (settings.isActive && settings.welcomeActive) {
        await sendText(groupId, settings.leaveMsg);
        await logAction(groupId, 'group', 'LEAVE_MSG_SENT', null, 'system');
      }
    }
  } catch (error) {
    log('⚠️ group-participants: ' + (error.message || error));
    await logAction(groupId || SYSTEM_GROUP, 'system', 'ERROR', 'group-participants: ' + (error.message || error), 'system');
  }
}

function isKiCommand(text, prefix) {
  const lower = String(text || '').trim().toLowerCase();
  return (
    lower === prefix + 'ki' ||
    lower.startsWith(prefix + 'ki ') ||
    lower === prefix + 'kistatus' ||
    lower === prefix + 'resetki' ||
    lower === prefix + 'kimembers' ||
    lower === prefix + 'resetkimembers'
  );
}

export async function onIncomingMessage(msg) {
  try {
    if (!msg?.message || !msg.key || msg.key.fromMe) return;

    const groupId = msg.key.remoteJid;
    if (!isGroupJid(groupId)) return;

    const senderId = msg.key.participant || msg.participant || groupId;
    const text = extractMessageText(msg);
    const msgType = detectMessageType(msg);
    const stats = getStats();

    incrementStat('messages');
    log('📩 "' + (text || '[' + msgType + ']') + '" from=' + senderId);

    const context = await getGroupContext(groupId, senderId, getBotOwners());
    const settings = await getEffectiveGroupSettings(groupId, context.meta);
    const prefix = getPrefix();

    if (context.isAdmin && text.startsWith(prefix)) {
      const handled = await dispatchCommand({
        msg,
        meta: context.meta,
        settings,
        groupId,
        senderId,
        text,
        prefix,
        mentions: parseMentions(msg)
      });

      if (handled) {
        incrementStat('commands');
        await logAction(groupId, senderId, 'COMMAND', text.trim().split(/\s+/)[0].toLowerCase(), senderId);
        return;
      }
    }

    if (text.startsWith(prefix) && isKiCommand(text, prefix)) {
      const lower = text.trim().toLowerCase();
      const sub = text.trim().split(/\s+/)[1]?.toLowerCase();
      const needsActive = !(
        lower === prefix + 'kistatus' ||
        lower === prefix + 'kimembers' ||
        (lower.startsWith(prefix + 'ki ') && (sub === 'status' || sub === 'members'))
      );

      if (needsActive && !settings.isActive) return;

      const handled = await handleKiCommand(
        getRuntimeSocket(),
        msg,
        groupId,
        senderId,
        text,
        msg.pushName || 'User',
        { allowKi: settings.allowKi !== false, prefix }
      );

      if (handled) {
        incrementStat('commands');
        await logAction(groupId, senderId, 'COMMAND', text.trim().split(/\s+/)[0].toLowerCase(), senderId);
        return;
      }
    }

    if (!settings.isActive) return;

    if (await isMuted(groupId, senderId)) {
      const sock = getRuntimeSocket();
      await sock.sendMessage(groupId, { delete: msg.key });
      await logAction(groupId, senderId, 'MUTE_DELETE', 'Nachricht von gemutetem User gelöscht', 'system');
      return;
    }

    let violationReason = null;

    if (settings.antiSpam && isSpamming(groupId, senderId)) {
      violationReason = 'Spam-Schutz: Zu viele Nachrichten.';
    }

    if (!violationReason) {
      if (!settings.allowStickers && msgType === 'sticker') violationReason = 'Sticker deaktiviert.';
      else if (!settings.allowImages && msgType === 'image') violationReason = 'Bilder deaktiviert.';
      else if (!settings.allowVideos && msgType === 'video') violationReason = 'Videos deaktiviert.';
      else if (!settings.allowAudios && (msgType === 'audio' || msgType === 'ptt')) violationReason = 'Audios deaktiviert.';
    }

    if (!violationReason && !settings.allowLinks && text && /(https?:\/\/[^\s]+|chat\.whatsapp\.com\/[a-zA-Z0-9]+)/i.test(text)) {
      violationReason = 'Links sind nicht gestattet.';
    }

    if (!violationReason && text) {
      const hit = profanity.findBadWord(text);
      if (hit) violationReason = 'Schimpfwort erkannt.';
    }

    if (!violationReason && text && getConfigBool('ki_profanity_enabled', true)) {
      const minLength = getConfigInt('ki_profanity_min_length', 3);
      const maxLength = getConfigInt('ki_profanity_max_length', 4000);
      const normalizedText = text.trim();

      if (normalizedText.length >= minLength && normalizedText.length <= maxLength) {
        try {
          const result = await checkProfanityWithKi(normalizedText, {
            timeoutMs: getConfigInt('ki_profanity_timeout_ms', 12000)
          });
          if (result?.bad) violationReason = 'Beleidigung/Schimpfwort (KI erkannt).';
        } catch (error) {
          log('⚠️ KI-Profanity-Check: ' + (error.message || error));
        }
      }
    }

    if (violationReason) {
      incrementStat('violations');
      await applyViolation({
        msg,
        meta: context.meta,
        groupId,
        senderId,
        reason: violationReason,
        maxWarnings: settings.maxWarnings,
        isAdmin: context.isAdmin
      });
    }
  } catch (error) {
    console.error('⚠️ Handler-Fehler:', error?.stack || error);
    await logAction(msg?.key?.remoteJid || SYSTEM_GROUP, 'system', 'ERROR', 'onIncomingMessage: ' + (error?.message || error), 'system');
  }
}
