import legacyHandler from './legacy.js';

/**
 * Central command registry.
 *
 * Each domain owns its command names. The current implementation is kept behind
 * the adapter so commands can be migrated one-by-one without changing the bot.
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

/**
 * Execute a registered command through its current implementation.
 * Unknown commands are deliberately not consumed.
 */
export async function dispatchCommand(context) {
    const { text, prefix } = context;
    const commandName = getCommandName(text, prefix);
    if (!commandName || !isRegisteredCommand(commandName)) return false;

    return Boolean(await legacyHandler(
        context.msg,
        context.meta,
        context.settings,
        context.groupId,
        context.senderId,
        text
    ));
}

export { COMMAND_GROUPS };
export default dispatchCommand;
