import dispatchCommand from './registry.js';

export const AI_COMMANDS = Object.freeze(['ki', 'ai', 'ask']);

export function dispatchAiCommand(context) {
    return dispatchCommand(context);
}
