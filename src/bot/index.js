/** Bot transport boundary. Keeps Baileys/socket concerns behind one module. */
export { default as startSocket } from '../../socket.js';
export { onIncomingMessage, onGroupParticipantsUpdate } from '../../messageHandler.js';
