import initDatabase, { dbPool, getGroupSettings, ensureColumn } from '../../db.js';
import { setDatabase } from '../core/runtime.js';

export async function initializeDatabase() {
  const pool = await initDatabase();
  setDatabase(pool);
  return pool;
}

export { dbPool, getGroupSettings, ensureColumn };
export default initializeDatabase;
