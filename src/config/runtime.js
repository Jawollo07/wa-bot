/** Configuration boundary. Keep runtime configuration in one place. */
export {
  CONFIG_DEFAULTS,
  initBotConfig,
  reloadBotConfig,
  getConfig,
  getConfigBool,
  getConfigInt,
  setConfig,
  getPrefix,
  getAuthDir,
  getPhoneNumber,
  getBotOwners,
  getSpamLimit,
  getKiSettingsFromDb,
  formatConfigList,
  isKnownConfigKey
} from '../../config.js';
