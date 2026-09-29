import { getRuntimeSocket, getRuntimeDatabase, getStats } from './runtime.js';

export function createApplicationContext() {
  return Object.freeze({
    get socket() {
      return getRuntimeSocket();
    },
    get database() {
      return getRuntimeDatabase();
    },
    stats: getStats()
  });
}
