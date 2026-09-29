/** Bot transport boundary. */
import startSocket, { getSocket, getBotStartTime } from './socket.js';
export { onIncomingMessage, onGroupParticipantsUpdate } from './message-handler.js';
export { startSocket, getSocket, getBotStartTime };
export default startSocket;
