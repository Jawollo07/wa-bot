
export default function log(...args) {
    const t = new Date().toISOString().slice(11, 19);
    console.log('[' + t + ']', ...args);
}
/**
 * Vollständiges Logging in mod_logs.
 * @param {string} groupId  - Gruppen-JID oder 'SYSTEM'
 * @param {string} userId   - Betroffener User (oder 'bot' / 'system')
 * @param {string} action   - z.B. WARN, BAN, BOT_ON, TOGGLE, ...
 * @param {string} [reason] - freier Text
 * @param {string} [actorId]- Wer die Aktion ausgelöst hat (Admin/Owner/system)
 * @param {string|object} [details] - Zusatzinfos (wird als JSON gespeichert wenn Objekt)
 */
export async function logAction(groupId, userId, action, reason = null, actorId = null, details = null) {
    try {
        const detailsStr = details == null
            ? null
            : (typeof details === 'string' ? details : JSON.stringify(details));
        await dbPool.query(
            'INSERT INTO mod_logs (group_id, user_id, actor_id, action, reason, details) VALUES (?, ?, ?, ?, ?, ?)',
            [
                groupId || SYSTEM_GROUP,
                userId || 'system',
                actorId || null,
                String(action).slice(0, 64),
                reason || null,
                detailsStr
            ]
        );
    } catch (e) {
        // Logging darf den Bot nie crashen
        console.error('[logAction]', e.message || e);
    }
}