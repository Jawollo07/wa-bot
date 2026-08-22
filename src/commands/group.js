import dispatchCommand from './registry.js';

export const GROUP_COMMANDS = Object.freeze(['lock', 'unlock', 'toggle', 'settings', 'setwelcome', 'setleave']);

export function dispatchGroupCommand(context) {
    return dispatchCommand(context);
}
