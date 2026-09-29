/**
 * Ollama KI-Modul für wa-bot
 * Trigger: !ki <Frage>
 * Default-Modell: qwen3.5:9b
 *
 * Memory + Mitglieder: ausschließlich MySQL
 *   - ki_chat_memory (Chatverlauf als JSON)
 *   - ki_members (Namen pro Gruppe)
 * Einmalige Migration: lokale ki_memory/*.json → DB, danach löschen
 *
 * Hybrid-Moderation: checkProfanityWithKi() für KI-gestützte Schimpfwort-Erkennung
 */
import { Ollama } from 'ollama';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_SYSTEM_PROMPT = `Du bist ein hilfreicher KI-Assistent in einer WhatsApp-Gruppe.
Antworte immer auf Deutsch, klar und knapp (1–4 Sätze, außer die Frage verlangt mehr).
Schreibe wie in einem Chat: natürlich, ohne Aufzählungs-Essay, ohne Markdown-Überschriften.
Du darfst Emojis sparsam nutzen. Bei ernsten Themen bleib sachlich.

Mitglieder (sehr wichtig):
- Jede User-Nachricht beginnt mit dem Absendernamen, z. B. „Jan: …“ oder „Tom: …“.
- Unterschiedliche Namen = unterschiedliche Personen. Verwechsle sie nie.
- „Du“ bezieht sich immer auf die Person, die gerade geschrieben hat.
- Wenn du jemanden ansprichst oder zitierst, nutze den exakten Namen aus dem Verlauf.
- Du bist kein Gruppenmitglied und gibst dich nicht als Mensch aus.

Zitate:
- Wenn ein Block „[Zitat von …]: …“ vorkommt, bezieht sich die Frage oft darauf – nutze den Inhalt.

Stil:
- Keine Floskeln wie „Als KI …“ oder „Gerne helfe ich …“.
- Keine Wiederholung der Frage.
- Keine Gedankenketten oder <think>-Blöcke in der Antwort – nur das Endergebnis.`;

/** Laufzeit-Config – aus MySQL (bot_config) per applyKiConfig() */
const KI_CONFIG = {
  host: 'http://127.0.0.1:11434',
  model: 'qwen3.5:9b',
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  maxTokens: 400,
  memoryLimit: 16,
  persistMemory: true,
  rateLimitMs: 2500,
  memoryFolder: path.join(__dirname, 'ki_memory'),
  enabled: true,
  temperature: 0.7,
  topP: 0.9,
  topK: 40,
  repeatPenalty: 1.1,
  numCtx: 8192,
  timeoutMs: 90000
};

let ollama = new Ollama({ host: KI_CONFIG.host });

/**
 * Settings aus MySQL übernehmen (config.js → getKiSettingsFromDb).
 */
export function applyKiConfig(settings) {
  if (!settings || typeof settings !== 'object') return;
  if (settings.host) KI_CONFIG.host = settings.host;
  if (settings.model) KI_CONFIG.model = settings.model;
  if (typeof settings.enabled === 'boolean') KI_CONFIG.enabled = settings.enabled;
  if (settings.maxTokens != null) KI_CONFIG.maxTokens = settings.maxTokens;
  if (settings.memoryLimit != null) KI_CONFIG.memoryLimit = settings.memoryLimit;
  if (typeof settings.persistMemory === 'boolean') KI_CONFIG.persistMemory = settings.persistMemory;
  if (settings.rateLimitMs != null) KI_CONFIG.rateLimitMs = settings.rateLimitMs;
  if (settings.memoryFolder) KI_CONFIG.memoryFolder = settings.memoryFolder;
  if (settings.temperature != null) KI_CONFIG.temperature = settings.temperature;
  if (settings.topP != null) KI_CONFIG.topP = settings.topP;
  if (settings.topK != null) KI_CONFIG.topK = settings.topK;
  if (settings.repeatPenalty != null) KI_CONFIG.repeatPenalty = settings.repeatPenalty;
  if (settings.numCtx != null) KI_CONFIG.numCtx = settings.numCtx;
  if (settings.timeoutMs != null) KI_CONFIG.timeoutMs = settings.timeoutMs;
  if (settings.systemPrompt && String(settings.systemPrompt).trim()) {
    KI_CONFIG.systemPrompt = String(settings.systemPrompt).replace(/^"|"$/g, '');
  } else {
    KI_CONFIG.systemPrompt = DEFAULT_SYSTEM_PROMPT;
  }
  ollama = new Ollama({ host: KI_CONFIG.host });
}

/** @type {import('mysql2/promise').Pool | null} */
let kiDb = null;

const conversations = new Map();
/** @type {Map<string, Map<string, { name: string, phone: string, lastSeen: number }>>} */
const membersByGroup = new Map();
const lastReplyAt = new Map();
const processing = new Set();
const seenMsgIds = new Set();
const MAX_SEEN = 2000;

const stats = {
  requests: 0,
  replies: 0,
  errors: 0,
  timeouts: 0,
  rateLimited: 0,
  profanityChecks: 0,
  profanityHits: 0
};

/**
 * Tabellen für KI-Memory + Mitglieder anlegen + einmalige File→DB-Migration.
 * @param {import('mysql2/promise').Pool} pool
 */
export async function initKiDb(pool) {
  kiDb = pool;
  await pool.query(
    `CREATE TABLE IF NOT EXISTS ki_chat_memory (
      chat_id VARCHAR(191) NOT NULL PRIMARY KEY,
      history_json MEDIUMTEXT NOT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );
  await pool.query(
    `CREATE TABLE IF NOT EXISTS ki_members (
      chat_id VARCHAR(191) NOT NULL,
      phone VARCHAR(32) NOT NULL,
      name VARCHAR(191) NOT NULL,
      last_seen BIGINT NOT NULL DEFAULT 0,
      PRIMARY KEY (chat_id, phone),
      INDEX idx_chat (chat_id),
      INDEX idx_name (name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );

  try {
    const result = await migrateLocalKiDataToDb();
    if (result.ran) {
      console.log(
        `[KI] Migration lokal→MySQL: ${result.memories} Memory-Dateien, ${result.memberFiles} Member-Dateien, ` +
          `${result.members} Mitglieder · gelöscht: ${result.deleted} Dateien` +
          (result.errors.length ? ` · Fehler: ${result.errors.length}` : '')
      );
      if (result.errors.length) {
        for (const e of result.errors.slice(0, 5)) console.error('[KI] Migration:', e);
      }
    }
  } catch (err) {
    console.error('[KI] Migration fehlgeschlagen:', err.message);
  }
}

/**
 * Einmalig: liest ./ki_memory (oder KI_CONFIG.memoryFolder), schreibt in MySQL, löscht Dateien.
 * - `*.json` (ohne members_) → ki_chat_memory
 * - `members_*.json` → ki_members
 * Vorhandene DB-Einträge werden nicht überschrieben (Memory), Mitglieder werden upserted.
 *
 * @returns {Promise<{ ran: boolean, memories: number, memberFiles: number, members: number, deleted: number, errors: string[] }>}
 */
export async function migrateLocalKiDataToDb() {
  const empty = { ran: false, memories: 0, memberFiles: 0, members: 0, deleted: 0, errors: [] };
  if (!kiDb) return empty;

  const folder = KI_CONFIG.memoryFolder || path.join(__dirname, 'ki_memory');
  if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
    return empty;
  }

  let files;
  try {
    files = fs.readdirSync(folder).filter((f) => f.endsWith('.json'));
  } catch {
    return empty;
  }
  if (!files.length) {
    try {
      fs.rmdirSync(folder);
    } catch {
      // Ordner nicht leer oder nicht löschbar
    }
    return empty;
  }

  const result = { ran: true, memories: 0, memberFiles: 0, members: 0, deleted: 0, errors: [] };
  const toDelete = [];

  for (const file of files) {
    const full = path.join(folder, file);
    try {
      const raw = fs.readFileSync(full, 'utf8');
      const data = JSON.parse(raw);

      if (file.startsWith('members_')) {
        // members_<chatId>.json → { phone: { name, phone, lastSeen }, ... }
        const chatId = file.slice('members_'.length, -'.json'.length);
        if (!chatId || typeof data !== 'object' || data === null || Array.isArray(data)) {
          result.errors.push(`${file}: ungültiges Format`);
          continue;
        }
        let count = 0;
        for (const [key, val] of Object.entries(data)) {
          if (!val || !val.name) continue;
          const phone = String(val.phone || key).replace(/\D/g, '') || String(key);
          const name = String(val.name).slice(0, 191);
          const lastSeen = Number(val.lastSeen) || 0;
          await kiDb.query(
            `INSERT INTO ki_members (chat_id, phone, name, last_seen) VALUES (?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
               name = IF(VALUES(last_seen) >= last_seen, VALUES(name), name),
               last_seen = GREATEST(last_seen, VALUES(last_seen))`,
            [chatId, phone, name, lastSeen]
          );
          count++;
        }
        result.memberFiles++;
        result.members += count;
        toDelete.push(full);
      } else {
        // <chatId>.json → History-Array
        const chatId = file.slice(0, -'.json'.length);
        if (!chatId || !Array.isArray(data)) {
          result.errors.push(`${file}: erwartet Array`);
          continue;
        }
        const [existing] = await kiDb.query(
          'SELECT chat_id FROM ki_chat_memory WHERE chat_id = ? LIMIT 1',
          [chatId]
        );
        if (existing.length) {
          // DB hat schon Daten – Datei trotzdem entfernen (Migration erledigt)
          toDelete.push(full);
          result.memories++;
          continue;
        }
        await kiDb.query(
          `INSERT INTO ki_chat_memory (chat_id, history_json) VALUES (?, ?)`,
          [chatId, JSON.stringify(data)]
        );
        result.memories++;
        toDelete.push(full);
      }
    } catch (err) {
      result.errors.push(`${file}: ${err.message}`);
    }
  }

  for (const full of toDelete) {
    try {
      fs.unlinkSync(full);
      result.deleted++;
    } catch (err) {
      result.errors.push(`Löschen ${path.basename(full)}: ${err.message}`);
    }
  }

  // Leeren Ordner entfernen
  try {
    const left = fs.readdirSync(folder);
    if (left.length === 0) fs.rmdirSync(folder);
  } catch {
    // ignore
  }

  return result;
}

function normalizePhone(jidOrNum) {
  if (!jidOrNum) return '';
  return String(jidOrNum).split('@')[0].split(':')[0].replace(/\D/g, '');
}

async function loadMemory(chatId) {
  if (!KI_CONFIG.persistMemory || !kiDb) return [];
  try {
    const [rows] = await kiDb.query(
      'SELECT history_json FROM ki_chat_memory WHERE chat_id = ? LIMIT 1',
      [chatId]
    );
    if (!rows.length) return [];
    const parsed = JSON.parse(rows[0].history_json || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error('[KI] Memory laden fehlgeschlagen:', err.message);
    return [];
  }
}

async function saveMemory(chatId, history) {
  if (!KI_CONFIG.persistMemory || !kiDb) return;
  try {
    const json = JSON.stringify(history || []);
    await kiDb.query(
      `INSERT INTO ki_chat_memory (chat_id, history_json) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE history_json = VALUES(history_json)`,
      [chatId, json]
    );
  } catch (err) {
    console.error('[KI] Memory speichern fehlgeschlagen:', err.message);
  }
}

async function loadMembers(chatId) {
  if (membersByGroup.has(chatId)) return membersByGroup.get(chatId);
  const map = new Map();
  if (KI_CONFIG.persistMemory && kiDb) {
    try {
      const [rows] = await kiDb.query(
        'SELECT phone, name, last_seen FROM ki_members WHERE chat_id = ?',
        [chatId]
      );
      for (const r of rows) {
        const phone = String(r.phone);
        map.set(phone, {
          name: String(r.name),
          phone,
          lastSeen: Number(r.last_seen) || 0
        });
      }
    } catch (err) {
      console.error('[KI] Mitglieder laden fehlgeschlagen:', err.message);
    }
  }
  membersByGroup.set(chatId, map);
  return map;
}

async function upsertMember(chatId, phone, name, lastSeen) {
  if (!KI_CONFIG.persistMemory || !kiDb) return;
  try {
    await kiDb.query(
      `INSERT INTO ki_members (chat_id, phone, name, last_seen) VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE name = VALUES(name), last_seen = VALUES(last_seen)`,
      [chatId, phone, name, lastSeen]
    );
  } catch (err) {
    console.error('[KI] Mitglied speichern fehlgeschlagen:', err.message);
  }
}

function isUsefulName(name) {
  if (!name || typeof name !== 'string') return false;
  const n = name.trim();
  if (n.length < 2) return false;
  if (/^\d+$/.test(n)) return false;
  const lower = n.toLowerCase();
  if (['user', 'jemand', 'member', 'mitglied', 'unknown', 'null', 'undefined'].includes(lower)) {
    return false;
  }
  return true;
}

export async function resolveMemberName(chatId, senderId, pushName = '') {
  const phone = normalizePhone(senderId) || String(senderId || 'unknown');
  const map = await loadMembers(chatId);
  const existing = map.get(phone);
  const incoming = (pushName || '').trim();

  let name;
  if (isUsefulName(incoming)) {
    name = incoming;
  } else if (existing?.name) {
    name = existing.name;
  } else {
    const tail = phone.slice(-4) || '????';
    name = `Mitglied_${tail}`;
  }

  const shouldUpdate =
    !existing ||
    (isUsefulName(incoming) && existing.name !== incoming) ||
    (existing.name.startsWith('Mitglied_') && isUsefulName(incoming));

  const now = Date.now();
  if (shouldUpdate || !existing) {
    map.set(phone, { name, phone, lastSeen: now });
    await upsertMember(chatId, phone, name, now);
  } else if (existing) {
    existing.lastSeen = now;
    await upsertMember(chatId, phone, existing.name, now);
  }

  return name;
}

async function formatMemberRoster(chatId) {
  const map = await loadMembers(chatId);
  if (!map.size) return '';
  const entries = [...map.values()]
    .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0))
    .slice(0, 40);
  const lines = entries.map((m) => `- ${m.name}`);
  return (
    '\n\nBekannte Gruppenmitglieder (Absendernamen):\n' +
    lines.join('\n') +
    '\nNutze genau diese Namen, um Personen zu unterscheiden und anzusprechen.'
  );
}

export async function clearKiMemory(chatId) {
  conversations.delete(chatId);
  if (kiDb) {
    try {
      await kiDb.query('DELETE FROM ki_chat_memory WHERE chat_id = ?', [chatId]);
    } catch (err) {
      console.error('[KI] Memory löschen:', err.message);
    }
  }
}

export async function clearKiMembers(chatId) {
  membersByGroup.delete(chatId);
  if (kiDb) {
    try {
      await kiDb.query('DELETE FROM ki_members WHERE chat_id = ?', [chatId]);
    } catch (err) {
      console.error('[KI] Mitglieder löschen:', err.message);
    }
  }
}

export async function clearAllKiMemory() {
  conversations.clear();
  if (kiDb) {
    try {
      await kiDb.query('DELETE FROM ki_chat_memory');
    } catch (err) {
      console.error('[KI] Alle Memories löschen:', err.message);
    }
  }
}

async function getHistory(chatId) {
  if (!conversations.has(chatId)) {
    conversations.set(chatId, await loadMemory(chatId));
  }
  return conversations.get(chatId);
}

async function buildSystemContent(chatId) {
  return KI_CONFIG.systemPrompt + (await formatMemberRoster(chatId));
}

function cleanReply(raw) {
  let reply = (raw || '').trim();
  reply = reply.replace(/<think>[\s\S]*?<\/think>/gi, '');
  reply = reply.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '');
  reply = reply.replace(/<\/?think>/gi, '');
  reply = reply
    .replace(/^(Alex|Bot|Assistent|KI|Assistant|AI|Qwen)[:：]\s*/i, '')
    .replace(/^["'„“]|["'„“]$/g, '')
    .trim();
  reply = reply.replace(/\n{3,}/g, '\n\n').trim();
  return reply;
}

/**
 * Text einer zitierten Nachricht aus Baileys-Message extrahieren.
 */
export function extractQuotedText(msg) {
  try {
    const ctx =
      msg.message?.extendedTextMessage?.contextInfo ||
      msg.message?.imageMessage?.contextInfo ||
      msg.message?.videoMessage?.contextInfo ||
      msg.message?.documentMessage?.contextInfo ||
      null;
    if (!ctx?.quotedMessage) return '';
    const q = ctx.quotedMessage;
    const text =
      q.conversation ||
      q.extendedTextMessage?.text ||
      q.imageMessage?.caption ||
      q.videoMessage?.caption ||
      q.documentMessage?.caption ||
      q.buttonsResponseMessage?.selectedDisplayText ||
      '';
    return String(text || '').trim().slice(0, 1500);
  } catch {
    return '';
  }
}

function withTimeout(promise, ms, label = 'Timeout') {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Schnelle, deterministische KI-Prüfung auf Beleidigungen / Schimpfwörter.
 * Fail-open: Bei Fehler/Timeout wird { bad: false } zurückgegeben.
 *
 * @param {string} text
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<{ bad: boolean, raw?: string }>}
 */
export async function checkProfanityWithKi(text, opts = {}) {
  if (!KI_CONFIG.enabled || !text || typeof text !== 'string') {
    return { bad: false };
  }
  const clean = String(text).trim().slice(0, 500);
  if (clean.length < 2) return { bad: false };

  const timeoutMs = opts.timeoutMs != null ? opts.timeoutMs : 8000;

  const prompt =
    `Du bist ein strenger Moderationsfilter für eine WhatsApp-Gruppe.\n` +
    `Prüfe den folgenden Text auf Beleidigungen, Schimpfwörter, Sexismus, Rassismus, Homophobie oder klare Hate-Speech.\n` +
    `Ignoriere harmlosen Slang, Ironie, Witze und normale Umgangssprache.\n` +
    `Antworte AUSSCHLIESSLICH mit JA oder NEIN (Großbuchstaben). Nichts anderes.\n\n` +
    `Text:\n"""\n${clean}\n"""`;

  stats.profanityChecks++;
  try {
    const response = await withTimeout(
      ollama.chat({
        model: KI_CONFIG.model,
        messages: [{ role: 'user', content: prompt }],
        stream: false,
        options: {
          num_predict: 8,
          temperature: 0.05,
          top_p: 0.9,
          top_k: 20,
          num_ctx: 2048
        }
      }),
      timeoutMs,
      `Profanity-KI Timeout (${Math.round(timeoutMs / 1000)}s)`
    );

    const raw = (response.message?.content || '').trim().toUpperCase();
    // Erstes Wort entscheiden (JA / NEIN)
    const first = (raw.split(/\s+|[^A-ZÄÖÜ]/)[0] || '').replace(/[^A-Z]/g, '');
    const isBad =
      first === 'JA' ||
      first === 'YES' ||
      first === 'TRUE' ||
      (raw.startsWith('JA') && !raw.includes('NEIN'));

    if (isBad) stats.profanityHits++;
    return { bad: isBad, raw: raw.slice(0, 40) };
  } catch (err) {
    if (String(err.message || '').includes('Timeout')) {
      stats.timeouts++;
    } else {
      stats.errors++;
    }
    console.error('[KI-Profanity]', err.message || err);
    // Fail-open: lieber verpassen als falsch positiv bei Fehler
    return { bad: false };
  }
}

/**
 * @param {string} chatId
 * @param {string} userMessage
 * @param {string} senderName
 * @param {{ quotedText?: string, quotedAuthor?: string }} [extra]
 */
async function askOllama(chatId, userMessage, senderName = 'User', extra = {}) {
  let history = await getHistory(chatId);
  const systemContent = await buildSystemContent(chatId);

  if (history.length === 0 || history[0].role !== 'system') {
    history = [{ role: 'system', content: systemContent }, ...history.filter((m) => m.role !== 'system')];
  } else {
    history[0] = { role: 'system', content: systemContent };
  }

  let body = userMessage;
  if (extra.quotedText) {
    const who = extra.quotedAuthor ? extra.quotedAuthor : 'jemand';
    body = `[Zitat von ${who}]: ${extra.quotedText}\n\n${userMessage}`;
  }

  history.push({ role: 'user', content: `${senderName}: ${body}` });

  if (history.length > KI_CONFIG.memoryLimit + 1) {
    history = [history[0], ...history.slice(-(KI_CONFIG.memoryLimit))];
  }

  stats.requests++;
  try {
    const response = await withTimeout(
      ollama.chat({
        model: KI_CONFIG.model,
        messages: history,
        stream: false,
        options: {
          num_predict: KI_CONFIG.maxTokens,
          temperature: KI_CONFIG.temperature,
          top_p: KI_CONFIG.topP,
          top_k: KI_CONFIG.topK,
          repeat_penalty: KI_CONFIG.repeatPenalty,
          num_ctx: KI_CONFIG.numCtx
        }
      }),
      KI_CONFIG.timeoutMs,
      `Ollama Timeout (${Math.round(KI_CONFIG.timeoutMs / 1000)}s)`
    );

    const reply = cleanReply(response.message?.content || '');
    if (!reply) {
      stats.errors++;
      return null;
    }

    history.push({ role: 'assistant', content: reply });
    conversations.set(chatId, history);
    saveMemory(chatId, history);
    stats.replies++;
    return reply;
  } catch (err) {
    if (String(err.message || '').includes('Timeout')) {
      stats.timeouts++;
      console.error('[KI] Timeout:', err.message);
      throw err;
    }
    stats.errors++;
    console.error('[KI] Ollama Fehler:', err.message);
    return null;
  }
}

function splitReply(text) {
  if (!text || text.length < 280) return [text];
  const mid = Math.floor(text.length / 2);
  let splitAt = text.lastIndexOf('. ', mid + 60);
  if (splitAt < mid - 60) splitAt = text.lastIndexOf('! ', mid + 40);
  if (splitAt < mid - 60) splitAt = text.lastIndexOf('? ', mid + 40);
  if (splitAt < mid - 60) splitAt = text.lastIndexOf('\n', mid);
  if (splitAt < mid - 60) splitAt = text.lastIndexOf(' ', mid);
  if (splitAt < 40) return [text];
  return [text.slice(0, splitAt + 1).trim(), text.slice(splitAt + 1).trim()].filter(Boolean);
}

export async function checkOllama() {
  try {
    const tags = await withTimeout(ollama.list(), 8000, 'Ollama list Timeout');
    const models = (tags.models || []).map((m) => m.name);
    const target = KI_CONFIG.model.toLowerCase();
    const hasModel = models.some((m) => {
      const n = m.toLowerCase();
      return n === target || n.startsWith(target + ':') || n.startsWith(target) || target.startsWith(n.split(':')[0]);
    });
    return {
      ok: true,
      models,
      hasModel,
      host: KI_CONFIG.host,
      model: KI_CONFIG.model
    };
  } catch (err) {
    return {
      ok: false,
      models: [],
      hasModel: false,
      host: KI_CONFIG.host,
      model: KI_CONFIG.model,
      error: err.message
    };
  }
}

function markSeen(msg) {
  const id = msg?.key?.id;
  if (!id) return false;
  if (seenMsgIds.has(id)) return true;
  seenMsgIds.add(id);
  if (seenMsgIds.size > MAX_SEEN) {
    const first = seenMsgIds.values().next().value;
    seenMsgIds.delete(first);
  }
  return false;
}

/**
 * @param {object} sock
 * @param {object} msg
 * @param {string} groupId
 * @param {string} senderId
 * @param {string} text
 * @param {string} pushName
 * @param {{ quotedText?: string, quotedAuthor?: string, allowKi?: boolean }} [opts]
 * @returns {Promise<boolean>}
 */
export async function handleKiCommand(sock, msg, groupId, senderId, text, pushName, opts = {}) {
  if (!KI_CONFIG.enabled) {
    await sock.sendMessage(
      groupId,
      { text: '🤖 KI ist global deaktiviert (`KI_ENABLED=false` in .env).' },
      { quoted: msg }
    );
    return true;
  }

  if (markSeen(msg)) {
    return true;
  }

  const args = text.trim().split(/\s+/);
  const cmd = args[0].toLowerCase();
  const prefix = (opts.prefix || '!').toString();
  const memberName = await resolveMemberName(groupId, senderId, pushName);

  const quotedText = (opts.quotedText || extractQuotedText(msg) || '').trim();
  const quotedAuthor = opts.quotedAuthor || '';

  // !kistatus
  if (cmd === prefix + 'kistatus' || (cmd === prefix + 'ki' && args[1]?.toLowerCase() === 'status')) {
    const info = await checkOllama();
    const memberCount = (await loadMembers(groupId)).size;
    const histLen = (await getHistory(groupId)).filter((m) => m.role !== 'system').length;
    const lines = [
      '🤖 *KI-Status*',
      `• Global: ${KI_CONFIG.enabled ? '✅' : '❌'}`,
      `• Gruppe KI: ${opts.allowKi === false ? '❌ (aus)' : '✅'}`,
      `• Ollama: ${info.ok ? '✅ erreichbar' : '❌ ' + (info.error || 'offline')}`,
      `• Host: \`${info.host}\``,
      `• Modell: \`${info.model}\`${info.hasModel ? ' ✅' : ' ⚠️ fehlt – `ollama pull ' + info.model + '`'}`,
      `• Temp ${KI_CONFIG.temperature} · max ${KI_CONFIG.maxTokens} Tok · ctx ${KI_CONFIG.numCtx} · Timeout ${Math.round(KI_CONFIG.timeoutMs / 1000)}s`,
      `• Memory: ${histLen}/${KI_CONFIG.memoryLimit} Einträge · ${conversations.size} Chats geladen`,
      `• Mitglieder: ${memberCount} · dein Name: *${memberName}*`,
      `• Stats: ${stats.requests} Anfragen · ${stats.replies} Antworten · ${stats.errors} Fehler · ${stats.timeouts} Timeouts · ${stats.rateLimited} Rate-Limits`,
      `• Profanity-KI: ${stats.profanityChecks} Checks · ${stats.profanityHits} Treffer`,
      info.models.length ? `• Installiert: ${info.models.slice(0, 8).join(', ')}` : ''
    ].filter(Boolean);
    await sock.sendMessage(groupId, { text: lines.join('\n') }, { quoted: msg });
    return true;
  }

  // !kimembers
  if (cmd === prefix + 'kimembers' || (cmd === prefix + 'ki' && args[1]?.toLowerCase() === 'members')) {
    const map = await loadMembers(groupId);
    if (!map.size) {
      await sock.sendMessage(
        groupId,
        {
          text: '👥 Noch keine Mitglieder bekannt. Sobald jemand `!ki` nutzt, lernt die KI den WhatsApp-Anzeigenamen.'
        },
        { quoted: msg }
      );
      return true;
    }
    const list = [...map.values()]
      .sort((a, b) => a.name.localeCompare(b.name, 'de'))
      .map((m) => `• ${m.name}`)
      .join('\n');
    await sock.sendMessage(
      groupId,
      { text: `👥 *Bekannte Mitglieder für die KI* (${map.size})\n${list}` },
      { quoted: msg }
    );
    return true;
  }

  // !resetki
  if (
    cmd === prefix + 'resetki' ||
    (cmd === prefix + 'ki' && args[1]?.toLowerCase() === 'reset' && args[2]?.toLowerCase() !== 'members')
  ) {
    await clearKiMemory(groupId);
    await sock.sendMessage(
      groupId,
      { text: '🧠 KI-Memory für diesen Chat gelöscht. (Mitgliedernamen bleiben in der DB)' },
      { quoted: msg }
    );
    return true;
  }

  // !ki resetmembers
  if (
    (cmd === prefix + 'ki' && args[1]?.toLowerCase() === 'resetmembers') ||
    cmd === prefix + 'resetkimembers'
  ) {
    await clearKiMembers(groupId);
    await sock.sendMessage(
      groupId,
      { text: '👥 Mitglieder-Registry für diesen Chat gelöscht. Namen werden neu gelernt.' },
      { quoted: msg }
    );
    return true;
  }

  if (cmd !== prefix + 'ki') return false;

  // Pro-Gruppe abschalten
  if (opts.allowKi === false) {
    await sock.sendMessage(
      groupId,
      { text: '🤖 KI ist in dieser Gruppe deaktiviert. Admin: `!toggle ki`' },
      { quoted: msg }
    );
    return true;
  }

  let prompt = args.slice(1).join(' ').trim();

  // Nur Reply ohne Text → Zitat erklären/zusammenfassen
  if (!prompt && quotedText) {
    prompt = 'Beziehe dich auf das Zitat: fasse kurz zusammen oder beantworte, worum es geht.';
  }

  if (!prompt) {
    await sock.sendMessage(
      groupId,
      {
        text:
          '🤖 *KI-Befehle* (`' +
          KI_CONFIG.model +
          '`)\n' +
          `• \`${prefix}ki <Frage>\` – fragen\n` +
          `• Auf Nachricht antworten + \`${prefix}ki …\` – Zitat als Kontext\n` +
          `• \`${prefix}kistatus\` – Status, Stats, Modell\n` +
          `• \`${prefix}kimembers\` – gelernte Namen\n` +
          `• \`${prefix}resetki\` – Chat-Memory löschen\n` +
          `• \`${prefix}ki resetmembers\` – Namen neu lernen\n` +
          `• Admin: \`${prefix}toggle ki\` – KI pro Gruppe an/aus`
      },
      { quoted: msg }
    );
    return true;
  }

  const now = Date.now();
  const last = lastReplyAt.get(groupId) || 0;
  if (now - last < KI_CONFIG.rateLimitMs) {
    stats.rateLimited++;
    await sock.sendMessage(groupId, { text: '⏳ Bitte kurz warten (Rate-Limit).' }, { quoted: msg });
    return true;
  }

  if (processing.has(groupId)) {
    await sock.sendMessage(groupId, { text: '⏳ Die KI antwortet gerade noch…' }, { quoted: msg });
    return true;
  }

  processing.add(groupId);
  try {
    await sock.sendPresenceUpdate('composing', groupId);

    const reply = await askOllama(groupId, prompt, memberName, {
      quotedText: quotedText || undefined,
      quotedAuthor: quotedAuthor || undefined
    });

    if (!reply) {
      await sock.sendMessage(
        groupId,
        {
          text:
            '❌ Keine Antwort von Ollama.\n' +
            '• `ollama serve` aktiv?\n' +
            '• `ollama pull ' +
            KI_CONFIG.model +
            '`\n' +
            '• `!kistatus` für Details'
        },
        { quoted: msg }
      );
      return true;
    }

    const parts = splitReply(reply);
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) {
        await sock.sendPresenceUpdate('composing', groupId);
        await new Promise((r) => setTimeout(r, 350 + Math.random() * 500));
      }
      await sock.sendMessage(groupId, { text: parts[i] }, { quoted: i === 0 ? msg : undefined });
    }

    lastReplyAt.set(groupId, Date.now());
    await sock.sendPresenceUpdate('paused', groupId);
  } catch (err) {
    console.error('[KI] Handler-Fehler:', err.message);
    const isTimeout = String(err.message || '').includes('Timeout');
    await sock.sendMessage(
      groupId,
      {
        text: isTimeout
          ? '⏱️ Ollama braucht zu lange (Timeout). Modell zu groß oder Server überlastet?'
          : '❌ KI-Fehler: ' + (err.message || 'unbekannt')
      },
      { quoted: msg }
    );
  } finally {
    processing.delete(groupId);
  }

  return true;
}

export function getKiConfig() {
  return { ...KI_CONFIG };
}

export function getKiStats() {
  return { ...stats };
}
