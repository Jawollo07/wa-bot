import legacyHandler from './legacy.js';

/**
 * Central command registry.
 *
 * Domain modules own command names. The legacy implementation remains behind
 * this boundary so no existing command silently disappears during migration.
 */
const COMMAND_GROUPS = Object.freeze({
    admin: new Set(['bot', 'ping', 'info', 'stats', 'logs', 'setconfig', 'config', 'help']),
    group: new Set(['lock', 'unlock', 'toggle', 'settings', 'setwelcome', 'setleave']),
    moderation: new Set([
        'mute', 'unmute', 'muted',
        'warn', 'warnings', 'unwarn', 'clearwarns',
        'kick', 'ban', 'unban', 'banned'
    ]),
    ai: new Set(['ki', 'ai', 'ask'])
});

export function getCommandName(text, prefix) {
    const first = String(text || '').trim().split(/\s+/)[0].toLowerCase();
    if (!first.startsWith(prefix.toLowerCase())) return '';
    return first.slice(prefix.length);
}

export function getCommandGroup(commandName) {
    for (const [group, commands] of Object.entries(COMMAND_GROUPS)) {
        if (commands.has(commandName)) return group;
    }
    return null;
}

export function isRegisteredCommand(commandName) {
    return getCommandGroup(commandName) !== null;
}

export async function dispatchCommand(context) {
    const commandName = getCommandName(context.text, context.prefix);
    if (!commandName) return false;

    // Known commands are now categorized by domain. Unknown commands still
    // reach the legacy handler for backwards compatibility during migration.
    return Boolean(await legacyHandler(
        context.msg,
        context.meta,
        context.settings,
        context.groupId,
        context.senderId,
        context.text
    ));
}

export { COMMAND_GROUPS };
export default dispatchCommand;
