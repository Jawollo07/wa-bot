import dispatchCommand from './registry.js';

export const MODERATION_COMMANDS = Object.freeze([
    'mute', 'unmute', 'muted',
    'warn', 'warnings', 'unwarn', 'clearwarns',
    'kick', 'ban', 'unban', 'banned'
]);

export function dispatchModerationCommand(context) {
    return dispatchCommand(context);
}
