/**
 * Central KI module.
 *
 * Public API for all AI/Ollama functionality. Keeping this boundary stable lets
 * the implementation be split into smaller modules without changing callers.
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
} from './ollama.js';
