export async function onGroupParticipantsUpdate(update) {
    try {
        const groupId = update.id;
        groupMetaCache.delete(groupId);

        if (update.action === 'add') {
            for (const userId of update.participants || []) {
                const ban = await getActiveBan(groupId, userId);
                if (ban) {
                    log('🚫 Gebannter User rejoined → Kick: ' + userId);
                    try {
                        await sock.groupParticipantsUpdate(groupId, [userId], 'remove');
                        await logAction(groupId, userId, 'BAN_REKICK', ban.reason || 'Auto-Kick (Ban)', 'system', {
                            until: formatBanUntil(ban)
                        });
                        const num = normalizePhone(userId) || userId.split('@')[0];
                        await sendText(groupId, '🚫 @' + num + ' ist gebannt und wurde erneut entfernt.\nBis: ' + formatBanUntil(ban), [userId]);
                    } catch (e) {
                        console.error('Ban-Rekick fehlgeschlagen:', e.message || e);
                        await logAction(groupId, userId, 'BAN_REKICK_FAIL', e.message || String(e), 'system');
                    }
                    continue;
                }
                await logAction(groupId, userId, 'JOIN', null, 'system');
                const settings = await getGroupSettings(groupId);
                if (settings.isActive && settings.welcomeActive) {
                    const num = normalizePhone(userId) || userId.split('@')[0];
                    const t = settings.welcomeMsg.replace(/@user/gi, '@' + num);
                    await sendText(groupId, t, [userId]);
                    await logAction(groupId, userId, 'WELCOME_SENT', null, 'system');
                }
            }
        } else if (update.action === 'remove') {
            for (const userId of update.participants || []) {
                await logAction(groupId, userId, 'LEAVE', null, 'system');
            }
            const settings = await getGroupSettings(groupId);
            if (settings.isActive && settings.welcomeActive) {
                await sendText(groupId, settings.leaveMsg);
                await logAction(groupId, 'group', 'LEAVE_MSG_SENT', null, 'system');
            }
        }
    } catch (e) {
        console.error('group participants update:', e.message || e);
        await logAction(update?.id || SYSTEM_GROUP, 'system', 'ERROR', 'group-participants: ' + (e.message || e), 'system');
    }
}
export async function onIncomingMessage(msg) {
    try {
        if (!msg?.message || !msg.key) return;
        if (msg.key.fromMe) return;
        const groupId = msg.key.remoteJid;
        if (!groupId || !isJidGroup(groupId)) return;
        const senderId = msg.key.participant || msg.participant || groupId;
        const text = extractText(msg);
        const msgType = detectMsgType(msg);
        stats.messages++;
        log('📩 "' + (text || '[' + msgType + ']') + '" from=' + senderId);
        const settings = await getGroupSettings(groupId);
        const meta = await getGroupMeta(groupId);
        const ownerHit = isBotOwner(senderId);
        const adminHit = isParticipantAdmin(meta, senderId);
        const isAdmin = ownerHit || adminHit;
        if (isAdmin) log('👤 Rechte: owner=' + ownerHit + ' groupAdmin=' + adminHit + ' sender=' + senderId);
        if (isAdmin && text.startsWith(PREFIX())) {
            const handled = await handleAdminCommands(msg, meta, settings, groupId, senderId, text);
            if (handled) {
                stats.commands++;
                log('✅ Admin-Befehl ausgeführt');
                const cmdName = text.trim().split(/\s+/)[0].toLowerCase();
                await logAction(groupId, senderId, 'COMMAND', cmdName, senderId);
                return;
            }
        }

        if (text.startsWith(PREFIX())) {
            const lower = text.trim().toLowerCase();
            const p = PREFIX();
            const isKiCmd =
                lower === p + 'ki' ||
                lower.startsWith(p + 'ki ') ||
                lower === p + 'kistatus' ||
                lower === p + 'resetki' ||
                lower === p + 'kimembers' ||
                lower === p + 'resetkimembers';

            if (isKiCmd) {
                const sub = text.trim().split(/\s+/)[1]?.toLowerCase();
                const needsActive = !(
                    lower === p + 'kistatus' ||
                    lower === p + 'kimembers' ||
                    (lower.startsWith(p + 'ki ') && (sub === 'status' || sub === 'members'))
                );
                if (needsActive && !settings.isActive) {
                    log('🔴 KI-Befehl ignoriert – Bot inaktiv (group=' + groupId + ')');
                    return;
                }
                const pushName = msg.pushName || 'User';
                const handled = await handleKiCommand(sock, msg, groupId, senderId, text, pushName, {
                    allowKi: settings.allowKi !== false,
                    prefix: PREFIX()
                });
                if (handled) {
                    stats.commands++;
                    log('✅ KI-Befehl ausgeführt');
                    const cmdName = text.trim().split(/\s+/)[0].toLowerCase();
                    await logAction(groupId, senderId, 'COMMAND', cmdName, senderId);
                    return;
                }
            }
        }

        if (!settings.isActive) {
            log('🔴 Bot inaktiv (group=' + groupId + ')');
            return;
        }
        if (await isMuted(groupId, senderId)) {
            await safeDeleteMessage(groupId, msg.key);
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
            if (hit) {
                log('🔤 Schimpfwort-Match: "' + hit + '"');
                violationReason = 'Schimpfwort erkannt.';
            }
        }

        if (!violationReason && text && getConfigBool('ki_profanity_enabled', true)) {
            const minLen = getConfigInt('ki_profanity_min_length', 3);
            const maxLen = getConfigInt('ki_profanity_max_length', 500);
            const t = text.trim();
            if (t.length >= minLen && t.length <= maxLen) {
                try {
                    const timeoutMs = getConfigInt('ki_profanity_timeout_ms', 8000);
                    const kiResult = await checkProfanityWithKi(t, { timeoutMs });
                    if (kiResult && kiResult.bad) {
                        log('🤖 KI-Schimpfwort erkannt (raw: ' + (kiResult.raw || 'JA') + ')');
                        violationReason = 'Beleidigung/Schimpfwort (KI erkannt).';
                    }
                } catch (e) {
                    log('⚠️ KI-Profanity-Check Fehler: ' + (e.message || e));
                }
            }
        }

        if (violationReason) {
            stats.violations++;
            log('🚨 ' + violationReason + (isAdmin ? ' (Admin)' : ''));
            await handleViolation(msg, meta, groupId, senderId, violationReason, settings.maxWarnings, isAdmin);
        }
    } catch (error) {
        console.error('⚠️ Handler-Fehler:', error?.stack || error);
        await logAction(msg?.key?.remoteJid || SYSTEM_GROUP, 'system', 'ERROR', 'onIncomingMessage: ' + (error?.message || error), 'system');
    }
}
