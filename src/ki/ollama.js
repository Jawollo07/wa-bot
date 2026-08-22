/**
 * Ollama implementation boundary.
 *
 * The legacy root module is temporarily used as the implementation source while
 * the KI internals are migrated into this directory. No application code should
 * import the root module directly after the migration is complete.
 */
export {
  handleKiCommand,
  checkOllama,
  getKiConfig,
  applyKiConfig,
  initKiDb,
  migrateLocalKiDataToDb,
  resolveMemberName,
  checkProfanityWithKi
} from '../../ollama.js';
