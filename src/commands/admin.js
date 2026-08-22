import dispatchCommand from './registry.js';

export const ADMIN_COMMANDS = Object.freeze(['bot', 'ping', 'info', 'stats', 'logs', 'setconfig', 'config', 'help']);

export function dispatchAdminCommand(context) {
    return dispatchCommand(context);
}
