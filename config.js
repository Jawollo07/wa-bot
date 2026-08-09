/**
 * Zentrale Bot-Konfiguration in MySQL (Tabelle bot_config).
 * In .env bleiben nur Bootstrap-Geheimnisse: DB_*, optional PHONE_NUMBER / BOT_OWNERS.
 */
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Defaults – werden beim ersten Start in MySQL geschrieben */
export const CONFIG_DEFAULTS = {
  // WhatsApp / Bot
  phone_number: '',
  bot_owners: '',
  command_prefix: '!',
  baileys_auth_path: './auth_baileys',
  baileys_log_level: 'silent',
  spam_max_messages: '5',
  spam_timeframe_ms: '5000',
  settings_cache_ttl_ms: '15000',
  reconnect_base_ms: '3000',
  reconnect_max_ms: '60000',
  max_reconnect_attempts: '0',

  // Ollama / KI
  ollama_host: 'http://127.0.0.1:11434',
  ollama_model: 'qwen3.5:9b',
  ki_enabled: 'true',
  max_tokens: '400',
  memory_limit: '16',
  persist_memory: 'true',
  ki_rate_limit_ms: '2500',
  ki_memory_path: './ki_memory',
  ki_temperature: '0.7',
  ki_top_p: '0.9',
  ki_top_k: '40',
  ki_repeat_penalty: '1.1',
  ki_num_ctx: '8192',
  ki_timeout_ms: '90000',
  system_prompt: '',

  // Hybrid-Schimpfwort-Erkennung (klassisch + KI)
  // max_length höher, damit auch längere Nachrichten/Kontexte geprüft werden
  ki_profanity_enabled: 'true',
  ki_profanity_timeout_ms: '12000',
  ki_profanity_min_length: '3',
  ki_profanity_max_length: '4000'
};

/** Keys die nicht per !setconfig öffentlich angezeigt/geändert werden sollten */
const SENSITIVE_HINTS = new Set(['bot_owners', 'phone_number']);

/** @type {Map<string, string>} */
let store = new Map();
let dbPoolRef = null;

function envFallback(key, def) {
  const envKey = key.toUpperCase();
  if (process.env[envKey] != null && process.env[envKey] !== '') {
    return String(process.env[envKey]);
  }
  // Aliase
  const aliases = {
    ollama_host: 'OLLAMA_HOST',
    ollama_model: 'OLLAMA_MODEL',
    ki_enabled: 'KI_ENABLED',
    max_tokens: 'MAX_TOKENS',
    memory_limit: 'MEMORY_LIMIT',
    persist_memory: 'PERSIST_MEMORY',
    ki_rate_limit_ms: 'KI_RATE_LIMIT_MS',
    ki_memory_path: 'KI_MEMORY_PATH',
    ki_temperature: 'KI_TEMPERATURE',
    ki_top_p: 'KI_TOP_P',
    ki_top_k: 'KI_TOP_K',
    ki_repeat_penalty: 'KI_REPEAT_PENALTY',
    ki_num_ctx: 'KI_NUM_CTX',
    ki_timeout_ms: 'KI_TIMEOUT_MS',
    system_prompt: 'SYSTEM_PROMPT',
    command_prefix: 'COMMAND_PREFIX',
    spam_max_messages: 'SPAM_MAX_MESSAGES',
    spam_timeframe_ms: 'SPAM_TIMEFRAME_MS',
    baileys_auth_path: 'BAILEYS_AUTH_PATH',
    baileys_log_level: 'BAILEYS_LOG_LEVEL',
    phone_number: 'PHONE_NUMBER',
    bot_owners: 'BOT_OWNERS',
    ki_profanity_enabled: 'KI_PROFANITY_ENABLED',
    ki_profanity_timeout_ms: 'KI_PROFANITY_TIMEOUT_MS',
    ki_profanity_min_length: 'KI_PROFANITY_MIN_LENGTH',
    ki_profanity_max_length: 'KI_PROFANITY_MAX_LENGTH'
  };
  const alt = aliases[key];
  if (alt && process.env[alt] != null && process.env[alt] !== '') {
    return String(process.env[alt]);
  }
  return def != null ? String(def) : '';
}

/**
 * Tabelle anlegen und Defaults + optional .env-Migration einspielen.
 * @param {import('mysql2/promise').Pool} pool
 */
export async function initBotConfig(pool) {
  dbPoolRef = pool;
  await pool.query(
    `CREATE TABLE IF NOT EXISTS bot_config (
      config_key VARCHAR(64) NOT NULL PRIMARY KEY,
      config_value TEXT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );

  const [rows] = await pool.query('SELECT config_key, config_value FROM bot_config');
  const existing = new Set(rows.map((r) => r.config_key));

  // Fehlende Keys aus Defaults + .env-Fallback seeden
  for (const [key, def] of Object.entries(CONFIG_DEFAULTS)) {
    if (existing.has(key)) continue;
    const value = envFallback(key, def);
    await pool.query(
      'INSERT INTO bot_config (config_key, config_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE config_key = config_key',
      [key, value]
    );
  }

  await reloadBotConfig();
  return getAllConfig();
}

export async function reloadBotConfig() {
  if (!dbPoolRef) return getAllConfig();
  const [rows] = await dbPoolRef.query('SELECT config_key, config_value FROM bot_config');
  store = new Map();
  for (const r of rows) {
    store.set(r.config_key, r.config_value == null ? '' : String(r.config_value));
  }
  // Sicherstellen dass alle Default-Keys im Memory sind
  for (const [key, def] of Object.entries(CONFIG_DEFAULTS)) {
    if (!store.has(key)) store.set(key, envFallback(key, def));
  }
  return getAllConfig();
}

export function getConfig(key, fallback = '') {
  if (store.has(key)) {
    const v = store.get(key);
    return v == null ? fallback : v;
  }
  return envFallback(key, fallback !== '' ? fallback : CONFIG_DEFAULTS[key] ?? '');
}

export function getConfigBool(key, fallback = false) {
  const v = getConfig(key, fallback ? 'true' : 'false').toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

export function getConfigInt(key, fallback = 0) {
  const n = parseInt(getConfig(key, String(fallback)), 10);
  return Number.isFinite(n) ? n : fallback;
}

export function getConfigFloat(key, fallback = 0) {
  const n = parseFloat(getConfig(key, String(fallback)));
  return Number.isFinite(n) ? n : fallback;
}

export function getAllConfig() {
  const obj = {};
  for (const [k, v] of store.entries()) obj[k] = v;
  for (const [k, def] of Object.entries(CONFIG_DEFAULTS)) {
    if (!(k in obj)) obj[k] = def;
  }
  return obj;
}

/**
 * Wert in MySQL speichern und Memory aktualisieren.
 */
export async function setConfig(key, value) {
  if (!dbPoolRef) throw new Error('Config-DB nicht initialisiert');
  const k = String(key).toLowerCase().trim();
  if (!/^[a-z][a-z0-9_]*$/.test(k)) throw new Error('Ungültiger Config-Key');
  const val = value == null ? '' : String(value);
  await dbPoolRef.query(
    `INSERT INTO bot_config (config_key, config_value) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE config_value = VALUES(config_value)`,
    [k, val]
  );
  store.set(k, val);
  return val;
}

export function getPrefix() {
  return getConfig('command_prefix', '!') || '!';
}

export function getAuthDir() {
  const p = getConfig('baileys_auth_path', './auth_baileys') || './auth_baileys';
  return path.isAbsolute(p) ? p : path.join(__dirname, p);
}

export function getPhoneNumber() {
  // .env hat Vorrang fürs Pairing (Bootstrap), sonst MySQL
  if (process.env.PHONE_NUMBER) return process.env.PHONE_NUMBER.replace(/\D/g, '');
  return getConfig('phone_number', '').replace(/\D/g, '');
}

export function getBotOwners() {
  const fromEnv = process.env.BOT_OWNERS || process.env.PHONE_NUMBER || '';
  const fromDb = getConfig('bot_owners', '') || getConfig('phone_number', '');
  const raw = fromEnv || fromDb;
  return String(raw)
    .split(',')
    .map((s) => s.trim().replace(/\D/g, ''))
    .filter(Boolean);
}

export function getSpamLimit() {
  return {
    maxMessages: getConfigInt('spam_max_messages', 5),
    timeFrameMs: getConfigInt('spam_timeframe_ms', 5000)
  };
}

/** Snapshot für ollama.js applyKiConfig */
export function getKiSettingsFromDb() {
  return {
    host: getConfig('ollama_host', 'http://127.0.0.1:11434'),
    model: getConfig('ollama_model', 'qwen3.5:9b'),
    enabled: getConfigBool('ki_enabled', true),
    maxTokens: getConfigInt('max_tokens', 400),
    memoryLimit: getConfigInt('memory_limit', 16),
    persistMemory: getConfigBool('persist_memory', true),
    rateLimitMs: getConfigInt('ki_rate_limit_ms', 2500),
    memoryFolder: (() => {
      const p = getConfig('ki_memory_path', './ki_memory') || './ki_memory';
      return path.isAbsolute(p) ? p : path.join(__dirname, p);
    })(),
    temperature: getConfigFloat('ki_temperature', 0.7),
    topP: getConfigFloat('ki_top_p', 0.9),
    topK: getConfigInt('ki_top_k', 40),
    repeatPenalty: getConfigFloat('ki_repeat_penalty', 1.1),
    numCtx: getConfigInt('ki_num_ctx', 8192),
    timeoutMs: getConfigInt('ki_timeout_ms', 90000),
    systemPrompt: getConfig('system_prompt', '')
  };
}

export function formatConfigList(includeSensitive = false) {
  const all = getAllConfig();
  const keys = Object.keys(all).sort();
  const lines = [];
  for (const k of keys) {
    if (!includeSensitive && SENSITIVE_HINTS.has(k)) {
      lines.push(`• \`${k}\` = *(gesetzt)*`);
      continue;
    }
    let v = all[k] ?? '';
    if (k === 'system_prompt' && v.length > 80) v = v.slice(0, 80) + '…';
    lines.push(`• \`${k}\` = ${v === '' ? '*(leer)*' : v}`);
  }
  return lines.join('\n');
}

export function isKnownConfigKey(key) {
  return Object.prototype.hasOwnProperty.call(CONFIG_DEFAULTS, key) || store.has(key);
}
