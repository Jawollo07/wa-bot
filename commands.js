export default async function handleAdminCommands(msg, meta, settings, groupId, senderId, text) {
    const args = text.trim().split(/\s+/);
    const command = args[0].toLowerCase();
    const p = PREFIX();
    const mentions = parseMentionsFromText(text, msg);
    const reply = async (t, ments = []) => sendText(groupId, t, ments);

    if (command === p + 'bot') {
        const action = args[1]?.toLowerCase();
        if (action === 'on' || action === 'off') {
            const state = action === 'on' ? 1 : 0;
            await dbPool.query(
                'INSERT INTO group_settings (group_id, is_active) VALUES (?, ?) ON DUPLICATE KEY UPDATE is_active = VALUES(is_active)',
                [groupId, state]
            );
            log('⚙️ is_active=' + state + ' für ' + groupId);
            await logAction(groupId, 'bot', state ? 'BOT_ON' : 'BOT_OFF', null, senderId);
            await reply(state ? '🟢 *Bot aktiviert!*' : '🔴 *Bot deaktiviert!*');
            return true;
        }
        const fresh = await getGroupSettings(groupId);
        await reply('ℹ️ Status: *' + (fresh.isActive ? '🟢 AKTIV' : '🔴 INAKTIV') + '*\nGruppe: `' + groupId + '`');
        return true;
    }
    if (command === p + 'ping') {
        const t0 = Date.now();
        await reply('🏓 Pong! (' + (Date.now() - t0) + 'ms) | Uptime: ' + formatUptime(Date.now() - botStartTime));
        return true;
    }
    if (command === p + 'info') {
        const ki = getKiConfig();
        const kiProf = getConfigBool('ki_profanity_enabled', true);
        await reply(
            '🤖 *wa-bot v3.5.0 (Baileys + Ollama)*\n' +
            '• Uptime: ' + formatUptime(Date.now() - botStartTime) + '\n' +
            '• Nachrichten: ' + stats.messages + '\n' +
            '• Verstöße: ' + stats.violations + '\n' +
            '• Befehle: ' + stats.commands + '\n' +
            '• Schimpfwörter: ' + loadedBadWords.length + ' (Hybrid: klassisch' + (kiProf ? ' + KI' : '') + ')\n' +
            '• Gruppe: ' + (settings.isActive ? '🟢 aktiv' : '🔴 inaktiv') + '\n' +
            '• KI: ' + (ki.enabled ? '✅ (' + ki.model + ')' : '❌ deaktiviert')
        );
        return true;
    }
    if (command === p + 'stats') {
        const [warnRows] = await dbPool.query('SELECT COUNT(*) AS c, COALESCE(SUM(warn_count),0) AS total FROM warnings WHERE group_id = ?', [groupId]);
        const [muteRows] = await dbPool.query('SELECT COUNT(*) AS c FROM muted_users WHERE group_id = ?', [groupId]);
        const [logRows] = await dbPool.query('SELECT COUNT(*) AS c FROM mod_logs WHERE group_id = ? AND created_at > DATE_SUB(NOW(), INTERVAL 24 HOUR)', [groupId]);
        await reply('📊 *Gruppen-Statistik*\n• Verwarnte User: ' + warnRows[0].c + '\n• Summe Verwarnungen: ' + warnRows[0].total + '\n• Stummgeschaltet: ' + muteRows[0].c + '\n• Mod-Aktionen (24h): ' + logRows[0].c + '\n• Max. Warns: ' + settings.maxWarnings);
        return true;
    }
    if (command === p + 'logs') {
        const limit = Math.min(parseInt(args[1], 10) || 15, 30);
        const [rows] = await dbPool.query(
            'SELECT action, user_id, actor_id, reason, details, created_at FROM mod_logs WHERE group_id = ? ORDER BY id DESC LIMIT ?',
            [groupId, limit]
        );
        if (rows.length === 0) {
            await reply('📋 Keine Logs für diese Gruppe.');
            return true;
        }
        const lines = rows.map(r => {
            const ts = r.created_at ? new Date(r.created_at).toISOString().slice(5, 16).replace('T', ' ') : '?';
            const who = (r.user_id || '').split('@')[0].slice(-8);
            const by = r.actor_id ? ' by ' + r.actor_id.split('@')[0].slice(-6) : '';
            const reasonShort = (r.reason || '').slice(0, 40);
            return '• `' + ts + '` *' + r.action + '* ' + who + by + (reasonShort ? ' – ' + reasonShort : '');
        });
        await reply('📜 *Letzte ' + rows.length + ' Logs*\n' + lines.join('\n'));
        return true;
    }
    if (command === p + 'lock') {
        try {
            await sock.groupSettingUpdate(groupId, 'announcement');
            await logAction(groupId, 'group', 'LOCK', 'Nur Admins dürfen schreiben', senderId);
            await reply('🔒 *Gruppe gesperrt.* Nur noch Admins können schreiben.');
        } catch (e) {
            await reply('❌ Lock fehlgeschlagen: ' + (e.message || e));
            await logAction(groupId, 'group', 'LOCK_FAIL', e.message || String(e), senderId);
        }
        return true;
    }
    if (command === p + 'unlock') {
        try {
            await sock.groupSettingUpdate(groupId, 'not_announcement');
            await logAction(groupId, 'group', 'UNLOCK', 'Alle dürfen schreiben', senderId);
            await reply('🔓 *Gruppe entsperrt.*');
        } catch (e) {
            await reply('❌ Unlock fehlgeschlagen: ' + (e.message || e));
            await logAction(groupId, 'group', 'UNLOCK_FAIL', e.message || String(e), senderId);
        }
        return true;
    }
    if (command === p + 'mute' || command === p + 'unmute') {
        if (mentions.length === 0) {
            await reply('⚠️ Nutzung: `' + command + ' @User`');
            return true;
        }
        const target = mentions[0];
        if (command === p + 'mute') {
            if (isParticipantAdmin(meta, target) || isBotOwner(target)) {
                await reply('⚠️ Admins/Owner können nicht stummgeschaltet werden.');
                return true;
            }
            await dbPool.query('INSERT IGNORE INTO muted_users (group_id, user_id) VALUES (?, ?)', [groupId, target]);
            await logAction(groupId, target, 'MUTE', 'Manuell', senderId);
            await reply('🤫 User stummgeschaltet.', [target]);
        } else {
            await dbPool.query('DELETE FROM muted_users WHERE group_id = ? AND user_id = ?', [groupId, target]);
            await logAction(groupId, target, 'UNMUTE', 'Manuell', senderId);
            await reply('🔊 User darf wieder schreiben.', [target]);
        }
        return true;
    }
    if (command === p + 'muted') {
        const [rows] = await dbPool.query('SELECT user_id FROM muted_users WHERE group_id = ?', [groupId]);
        if (rows.length === 0) {
            await reply('📋 Niemand ist stummgeschaltet.');
            return true;
        }
        const list = rows.map(r => '• ' + r.user_id.split('@')[0]).join('\n');
        await reply('📋 *Stummgeschaltet (' + rows.length + '):*\n' + list);
        return true;
    }
    if (command === p + 'toggle' && args[1]) {
        const option = args[1].toLowerCase();
        const validOptions = {
            links: 'allow_links',
            stickers: 'allow_stickers',
            images: 'allow_images',
            videos: 'allow_videos',
            audios: 'allow_audios',
            antispam: 'anti_spam',
            welcome: 'welcome_active',
            ki: 'allow_ki'
        };
        if (validOptions[option]) {
            const field = validOptions[option];
            const camelKey = field.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
            const newVal = !settings[camelKey];
            await dbPool.query('UPDATE group_settings SET ' + field + ' = ? WHERE group_id = ?', [newVal ? 1 : 0, groupId]);
            await logAction(groupId, 'settings', 'TOGGLE', option + ' → ' + (newVal ? 'ON' : 'OFF'), senderId, { option, newVal });
            await reply('✅ *' + option + '* ist jetzt: ' + (newVal ? 'AN ✅' : 'AUS ❌'));
        } else {
            await reply('⚠️ Optionen: links, stickers, images, videos, audios, antispam, welcome, ki');
        }
        return true;
    }
    if (command === p + 'maxwarns' && args[1]) {
        const n = parseInt(args[1], 10);
        if (!n || n < 1 || n > 20) {
            await reply('⚠️ Bitte Zahl 1–20 angeben.');
            return true;
        }
        const old = settings.maxWarnings;
        await dbPool.query('UPDATE group_settings SET max_warnings = ? WHERE group_id = ?', [n, groupId]);
        await logAction(groupId, 'settings', 'MAXWARNS', old + ' → ' + n, senderId, { old, new: n });
        await reply('✅ Max. Verwarnungen: *' + n + '*');
        return true;
    }
    if (command === p + 'setwelcome') {
        const t = args.slice(1).join(' ').trim();
        if (!t) {
            await reply('⚠️ Nutzung: `' + p + 'setwelcome ...`\nAktuell: ' + settings.welcomeMsg);
            return true;
        }
        await dbPool.query('UPDATE group_settings SET welcome_msg = ?, welcome_active = 1 WHERE group_id = ?', [t, groupId]);
        await logAction(groupId, 'settings', 'SET_WELCOME', t.slice(0, 100), senderId);
        await reply('✅ Willkommenstext gesetzt:\n' + t);
        return true;
    }
    if (command === p + 'setleave') {
        const t = args.slice(1).join(' ').trim();
        if (!t) {
            await reply('⚠️ Nutzung: `' + p + 'setleave ...`\nAktuell: ' + settings.leaveMsg);
            return true;
        }
        await dbPool.query('UPDATE group_settings SET leave_msg = ?, welcome_active = 1 WHERE group_id = ?', [t, groupId]);
        await logAction(groupId, 'settings', 'SET_LEAVE', t.slice(0, 100), senderId);
        await reply('✅ Abschiedstext gesetzt:\n' + t);
        return true;
    }
    if (command === p + 'settings') {
        await reply(
            '⚙️ **Gruppen-Einstellungen**\n\n' +
            '• Status: ' + (settings.isActive ? '🟢' : '🔴') + '\n' +
            '• Willkommen: ' + (settings.welcomeActive ? '✅' : '❌') + '\n' +
            '• KI (!ki): ' + (settings.allowKi ? '✅' : '❌') + '\n' +
            '• Links: ' + (settings.allowLinks ? '✅' : '❌') + ' | Sticker: ' + (settings.allowStickers ? '✅' : '❌') + '\n' +
            '• Bilder: ' + (settings.allowImages ? '✅' : '❌') + ' | Videos: ' + (settings.allowVideos ? '✅' : '❌') + '\n' +
            '• Audio: ' + (settings.allowAudios ? '✅' : '❌') + ' | Anti-Spam: ' + (settings.antiSpam ? '✅' : '❌') + '\n' +
            '• Max. Verwarnungen: ' + settings.maxWarnings
        );
        return true;
    }
    if (command === p + 'ban') {
        if (mentions.length === 0) {
            await reply('⚠️ Nutzung:\n• `' + p + 'ban @User` – permanent\n• `' + p + 'ban @User 1h` – 1 Stunde\n• `' + p + 'ban @User 2d spam` – 2 Tage + Grund\n• Dauer: 30m, 2h, 1d, 7d, permanent');
            return true;
        }
        const target = mentions[0];
        if (isParticipantAdmin(meta, target) || isBotOwner(target)) {
            await reply('⚠️ Admins/Owner können nicht gebannt werden.');
            return true;
        }
        let durationArg = null;
        const reasonParts = [];
        for (const a of args.slice(1)) {
            if (a.startsWith('@')) continue;
            if (durationArg === null && parseBanDuration(a) !== null) {
                durationArg = a;
                continue;
            }
            reasonParts.push(a);
        }
        const parsed = parseBanDuration(durationArg);
        if (durationArg && parsed === null) {
            await reply('⚠️ Ungültige Dauer. Beispiele: `1h`, `2d`, `7d`, `permanent`');
            return true;
        }
        const until = parsed ? parsed.until : null;
        const label = parsed ? parsed.label : 'permanent';
        const reason = reasonParts.join(' ').trim() || 'Manueller Ban';
        const untilSql = until ? until.toISOString().slice(0, 19).replace('T', ' ') : null;
        await banUser(groupId, target, untilSql, reason, senderId);
        await logAction(groupId, target, 'BAN', reason + ' (' + label + ')', senderId, { duration: label, until: untilSql });
        try {
            await sock.groupParticipantsUpdate(groupId, [target], 'remove');
        } catch (e) {
            log('⚠️ Ban-Kick: ' + (e.message || e));
        }
        await reply('🚫 User gebannt (' + label + ').\nGrund: ' + reason + '\nBei Wiedereintritt wird automatisch gekickt.', [target]);
        return true;
    }
    if (command === p + 'unban') {
        if (mentions.length === 0) {
            await reply('⚠️ Nutzung: `' + p + 'unban @User`');
            return true;
        }
        const target = mentions[0];
        await unbanUser(groupId, target);
        await logAction(groupId, target, 'UNBAN', 'Manuell', senderId);
        await reply('✅ Ban aufgehoben.', [target]);
        return true;
    }
    if (command === p + 'banned') {
        const [rows] = await dbPool.query(
            'SELECT user_id, banned_until, reason FROM banned_users WHERE group_id = ? ORDER BY banned_at DESC LIMIT 30',
            [groupId]
        );
        const active = [];
        for (const r of rows) {
            const v = await validateBanRow(r, groupId);
            if (v) active.push(v);
        }
        if (active.length === 0) {
            await reply('📋 Niemand ist gebannt.');
            return true;
        }
        const list = active.map(r => {
            const id = r.user_id.split('@')[0];
            return '• ' + id + ' – ' + formatBanUntil(r) + (r.reason ? ' (' + r.reason + ')' : '');
        }).join('\n');
        await reply('📋 *Gebannt (' + active.length + '):*\n' + list);
        return true;
    }
    if (command === p + 'kick') {
        if (mentions.length === 0) {
            await reply('⚠️ Nutzung: `' + p + 'kick @User`');
            return true;
        }
        const target = mentions[0];
        if (isParticipantAdmin(meta, target) || isBotOwner(target)) {
            await reply('⚠️ Admins/Owner können nicht gekickt werden.');
            return true;
        }
        try {
            await sock.groupParticipantsUpdate(groupId, [target], 'remove');
            await logAction(groupId, target, 'KICK', 'Manueller Kick', senderId);
            await reply('👢 User entfernt.', [target]);
        } catch (e) {
            await reply('❌ Kick fehlgeschlagen: ' + (e.message || e));
            await logAction(groupId, target, 'KICK_FAIL', e.message || String(e), senderId);
        }
        return true;
    }
    if (command === p + 'warns') {
        if (mentions.length === 0) {
            await reply('⚠️ Nutzung: `' + p + 'warns @User`');
            return true;
        }
        const count = await getWarningCount(groupId, mentions[0]);
        await reply('⚠️ Verwarnungen: *' + count + '/' + settings.maxWarnings + '*', [mentions[0]]);
        return true;
    }
    if (command === p + 'resetwarns') {
        if (mentions.length === 0) {
            await reply('⚠️ Nutzung: `' + p + 'resetwarns @User`');
            return true;
        }
        await resetWarnings(groupId, mentions[0]);
        await logAction(groupId, mentions[0], 'RESET_WARNS', 'Manuell', senderId);
        await reply('✅ Verwarnungen zurückgesetzt.', [mentions[0]]);
        return true;
    }
    if (command === p + 'clearwarns') {
        await dbPool.query('DELETE FROM warnings WHERE group_id = ?', [groupId]);
        await logAction(groupId, senderId, 'CLEAR_WARNS', 'Alle gelöscht', senderId);
        await reply('✅ Alle Verwarnungen dieser Gruppe gelöscht.');
        return true;
    }
    if (command === p + 'addword' && args[1]) {
        const word = args.slice(1).join(' ').toLowerCase().trim();
        if (word.length < 2) {
            await reply('⚠️ Wort zu kurz.');
            return true;
        }
        await dbPool.query('INSERT IGNORE INTO bad_words (word) VALUES (?)', [word]);
        await reloadBadWordsCache();
        await logAction(SYSTEM_GROUP, 'bad_words', 'ADD_WORD', word, senderId);
        await reply('✅ Schimpfwort *' + word + '* hinzugefügt.');
        return true;
    }
    if (command === p + 'delword' && args[1]) {
        const word = args.slice(1).join(' ').toLowerCase().trim();
        await dbPool.query('DELETE FROM bad_words WHERE word = ?', [word]);
        await reloadBadWordsCache();
        await logAction(SYSTEM_GROUP, 'bad_words', 'DEL_WORD', word, senderId);
        await reply('✅ Schimpfwort *' + word + '* entfernt.');
        return true;
    }
    // ===== Globale Config (MySQL bot_config) – nur Owner =====
    if (command === p + 'config' || command === p + 'cfg') {
        if (!isBotOwner(senderId)) {
            await reply('⛔ Nur Bot-Owner dürfen die globale Config sehen.');
            return true;
        }
        await reply('⚙️ *Bot-Config (MySQL `bot_config`)*\n\n' + formatConfigList(false) +
            '\n\nÄndern: `' + p + 'setconfig <key> <wert>`\nNeu laden: `' + p + 'reloadconfig`');
        return true;
    }
    if (command === p + 'setconfig' || command === p + 'setcfg') {
        if (!isBotOwner(senderId)) {
            await reply('⛔ Nur Bot-Owner.');
            return true;
        }
        const key = (args[1] || '').toLowerCase();
        const value = args.slice(2).join(' ').trim();
        if (!key || value === '') {
            await reply('⚠️ Nutzung: `' + p + 'setconfig <key> <wert>`\nKeys: `!config`\nBeispiel: `' + p + 'setconfig ollama_model qwen3.5:9b`');
            return true;
        }
        if (!isKnownConfigKey(key) && !(key in CONFIG_DEFAULTS)) {
            await reply('⚠️ Unbekannter Key. Bekannte Keys: `!config`');
            return true;
        }
        try {
            await setConfig(key, value);
            applyKiConfig(getKiSettingsFromDb());
            await logAction(SYSTEM_GROUP, 'config', 'SET_CONFIG', key + '=' + value.slice(0, 120), senderId);
            await reply('✅ `' + key + '` = ' + (value.length > 200 ? value.slice(0, 200) + '…' : value) + '\n(KI-Config neu angewendet)');
        } catch (e) {
            await reply('❌ ' + (e.message || e));
        }
        return true;
    }
    if (command === p + 'reloadconfig' || command === p + 'reloadcfg') {
        if (!isBotOwner(senderId)) {
            await reply('⛔ Nur Bot-Owner.');
            return true;
        }
        await reloadBotConfig();
        applyKiConfig(getKiSettingsFromDb());
        await logAction(SYSTEM_GROUP, 'config', 'RELOAD_CONFIG', null, senderId);
        await reply('🔄 Config aus MySQL neu geladen. Prefix: `' + PREFIX() + '` · Modell: `' + getKiConfig().model + '`');
        return true;
    }

    if (command === p + 'help') {
        await reply(
            '🛠 *Admin-Befehle (Baileys v3)*\n\n' +
            '• `' + p + 'bot on/off`\n' +
            '• `' + p + 'settings` / `' + p + 'stats` / `' + p + 'info` / `' + p + 'ping` / `' + p + 'logs [n]`\n' +
            '• `' + p + 'toggle <links|stickers|images|videos|audios|antispam|welcome|ki>`\n' +
            '• `' + p + 'maxwarns <1-20>`\n' +
            '• `' + p + 'setwelcome` / `' + p + 'setleave`\n' +
            '• `' + p + 'lock` / `' + p + 'unlock`\n' +
            '• `' + p + 'mute` / `' + p + 'unmute` / `' + p + 'muted`\n' +
            '• `' + p + 'ban @User [Dauer] [Grund]` / `' + p + 'unban` / `' + p + 'banned`\n' +
            '• `' + p + 'kick`\n' +
            '• `' + p + 'warns` / `' + p + 'resetwarns` / `' + p + 'clearwarns`\n' +
            '• `' + p + 'addword` / `' + p + 'delword`\n' +
            '• `' + p + 'config` / `' + p + 'setconfig` / `' + p + 'reloadconfig` (Owner)\n\n' +
            '🤖 *KI (Ollama)* – für alle Nutzer:\n' +
            '• `' + p + 'ki <Frage>` · `' + p + 'kistatus` · `' + p + 'kimembers`\n' +
            '• `' + p + 'resetki` · `' + p + 'ki resetmembers`\n\n' +
            '🔤 *Schimpfwörter*: Hybrid (Wortliste + KI). Owner: `!setconfig ki_profanity_enabled true/false`'
        );
        return true;
    }
    return false;
}
