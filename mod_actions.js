export function isSpamming(groupId, userId) {
    const key = groupId + '_' + userId;
    const now = Date.now();
    let timestamps = messageTimestamps.get(key) || [];
    const spam = getSpamLimit();
    timestamps = timestamps.filter(ts => now - ts < spam.timeFrameMs);
    timestamps.push(now);
    messageTimestamps.set(key, timestamps);
    return timestamps.length > getSpamLimit().maxMessages;
}

export async function addWarning(groupId, userId) {
    await dbPool.query(
        'INSERT INTO warnings (group_id, user_id, warn_count) VALUES (?, ?, 1) ON DUPLICATE KEY UPDATE warn_count = warn_count + 1',
        [groupId, userId]
    );
    const [rows] = await dbPool.query('SELECT warn_count FROM warnings WHERE group_id = ? AND user_id = ?', [groupId, userId]);
    return rows[0] ? rows[0].warn_count : 1;
}

export async function resetWarnings(groupId, userId) {
    await dbPool.query('DELETE FROM warnings WHERE group_id = ? AND user_id = ?', [groupId, userId]);
}

export async function getWarningCount(groupId, userId) {
    const [rows] = await dbPool.query('SELECT warn_count FROM warnings WHERE group_id = ? AND user_id = ?', [groupId, userId]);
    return rows[0] ? rows[0].warn_count : 0;
}

export async function isMuted(groupId, userId) {
    const [rows] = await dbPool.query('SELECT 1 FROM muted_users WHERE group_id = ? AND user_id = ?', [groupId, userId]);
    return rows.length > 0;
}

function parseBanDuration(str) {
    if (!str) return { until: null, label: 'permanent' };
    const s = String(str).toLowerCase().trim();
    if (['permanent', 'perm', 'perma', 'permament', 'forever', 'ewig'].includes(s)) {
        return { until: null, label: 'permanent' };
    }
    const m = s.match(/^(\d+)\s*(m|min|h|d|w)$/i) || s.match(/^(\d+)(m|min|h|d|w)$/i);
    if (!m) return null;
    const n = parseInt(m[1], 10);
    const unit = m[2].toLowerCase();
    let ms = 0;
    if (unit === 'm' || unit === 'min') ms = n * 60_000;
    else if (unit === 'h') ms = n * 3_600_000;
    else if (unit === 'd') ms = n * 86_400_000;
    else if (unit === 'w') ms = n * 7 * 86_400_000;
    if (ms <= 0) return null;
    return { until: new Date(Date.now() + ms), label: n + unit };
}

async function validateBanRow(row, groupId) {
    if (row.banned_until) {
        const until = new Date(row.banned_until);
        if (until.getTime() <= Date.now()) {
            await dbPool.query('DELETE FROM banned_users WHERE group_id = ? AND user_id = ?', [groupId, row.user_id]);
            return null;
        }
    }
    return row;
}

async function getActiveBan(groupId, userId) {
    const [rows] = await dbPool.query(
        'SELECT * FROM banned_users WHERE group_id = ? AND user_id = ?',
        [groupId, userId]
    );
    if (rows.length) return validateBanRow(rows[0], groupId);
    const phone = normalizePhone(userId);
    if (phone.length >= 8) {
        const [rows2] = await dbPool.query(
            "SELECT * FROM banned_users WHERE group_id = ? AND REPLACE(REPLACE(user_id, '@s.whatsapp.net', ''), '@lid', '') LIKE ?",
            [groupId, '%' + phone + '%']
        );
        if (rows2.length) return validateBanRow(rows2[0], groupId);
    }
    return null;
}

async function banUser(groupId, userId, until, reason, bannedBy) {
    await dbPool.query(
        'INSERT INTO banned_users (group_id, user_id, banned_until, reason, banned_by) VALUES (?, ?, ?, ?, ?) ' +
        'ON DUPLICATE KEY UPDATE banned_until = VALUES(banned_until), reason = VALUES(reason), banned_by = VALUES(banned_by), banned_at = CURRENT_TIMESTAMP',
        [groupId, userId, until, reason || null, bannedBy || null]
    );
}

async function unbanUser(groupId, userId) {
    await dbPool.query('DELETE FROM banned_users WHERE group_id = ? AND user_id = ?', [groupId, userId]);
    const phone = normalizePhone(userId);
    if (phone.length >= 8) {
        await dbPool.query(
            "DELETE FROM banned_users WHERE group_id = ? AND REPLACE(REPLACE(user_id, '@s.whatsapp.net', ''), '@lid', '') LIKE ?",
            [groupId, '%' + phone + '%']
        );
    }
}

function formatBanUntil(row) {
    if (!row.banned_until) return 'permanent';
    const d = new Date(row.banned_until);
    return d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

function formatUptime(ms) {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return h + 'h ' + m + 'm ' + sec + 's';
}

async function safeDeleteMessage(groupId, key) {
    try {
        await sock.sendMessage(groupId, { delete: key });
        log('🗑️ Nachricht gelöscht');
        return true;
    } catch (e) {
        log('⚠️ Löschen fehlgeschlagen: ' + (e.message || e));
        return false;
    }
}

async function sendText(groupId, text, mentions = []) {
    const content = mentions.length ? { text, mentions } : { text };
    return sock.sendMessage(groupId, content);
}

async function handleViolation(msg, meta, groupId, senderId, reason, maxWarnings, isAdmin) {
    try {
        const deleted = await safeDeleteMessage(groupId, msg.key);
        const currentWarns = await addWarning(groupId, senderId);
        const msgSnippet = (extractText(msg) || '[' + detectMsgType(msg) + ']').slice(0, 200);

        await logAction(groupId, senderId, 'WARN', reason, 'system', {
            warns: currentWarns,
            maxWarnings,
            deleted,
            snippet: msgSnippet
        });

        const number = normalizePhone(senderId) || senderId.split('@')[0];

        if (currentWarns >= maxWarnings) {
            if (isAdmin || isParticipantAdmin(meta, senderId)) {
                await sendText(groupId, '⛔ @' + number + ' hat max. Verwarnungen erreicht, wird als *Admin* nicht gekickt.\n*Grund:* ' + reason, [senderId]);
                await resetWarnings(groupId, senderId);
                await logAction(groupId, senderId, 'WARN_MAX_ADMIN', reason, 'system', { warns: currentWarns });
                return;
            }
            await sendText(groupId, '⛔ @' + number + ' wurde automatisch gekickt.\n*Grund:* Maximale Verwarnungen erreicht.', [senderId]);
            try {
                await sock.groupParticipantsUpdate(groupId, [senderId], 'remove');
            } catch (e) {
                console.error('Kick fehlgeschlagen:', e.message || e);
            }
            await resetWarnings(groupId, senderId);
            await logAction(groupId, senderId, 'KICK', 'Maximale Verwarnungen erreicht', 'system', { reason });
        } else {
            await sendText(
                groupId,
                '⚠️ @' + number + ', deine Nachricht wurde entfernt.\n*Grund:* ' + reason + '\n*Verwarnung:* ' + currentWarns + '/' + maxWarnings,
                [senderId]
            );
        }
    } catch (err) {
        console.error('Moderationsfehler:', err);
        await logAction(groupId, senderId || 'unknown', 'ERROR', 'handleViolation: ' + (err.message || err), 'system');
    }
}

function parseMentionsFromText(text, msg) {
    const ctx = msg.message?.extendedTextMessage?.contextInfo
        || msg.message?.imageMessage?.contextInfo
        || {};
    return ctx.mentionedJid || [];
}