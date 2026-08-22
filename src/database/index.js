/** Database boundary. SQL implementation remains isolated behind this module. */
export { default as initDatabase, dbPool, getGroupSettings, ensureColumn } from '../../db.js';
