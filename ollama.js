/**
 * Ollama KI-Modul für wa-bot
 * Trigger: !ki <Frage>
 * Basiert auf whatsapp-ollama-human-bot (Jawollo07)
 */
import { Ollama } from 'ollama';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const KI_CONFIG = {
  host: process.env.OLLAMA_HOST || 'http://127.0.0.1:11434',
  model: process.env.OLLAMA_MODEL || 'llama3.2',
  systemPrompt: (process.env.SYSTEM_PROMPT || `Du bist ein hilfreicher Assistent in einer WhatsApp-Gruppe.
Du antwortest klar, knapp und auf Deutsch.
Lange Erklärungen nur wenn nötig.
Du kannst Humor und Emojis nutzen, bleibst aber sachlich wenn die Frage ernst ist.`).replace(/^"|"$/g, ''),
  maxTokens: parseInt(process.env.MAX_TOKENS || '300', 10),
  memoryLimit: parseInt(process.env.MEMORY_LIMIT || '12', 10),
  persistMemory: (process.env.PERSIST_MEMORY || 'true').toLowerCase() === 'true',
  rateLimitMs: parseInt(process.env.KI_RATE_LIMIT_MS || '3000', 10),
  memoryFolder: process.env.KI_MEMORY_PATH || path.join(__dirname, 'ki_memory'),
  enabled: (process.env.KI_ENABLED || 'true').toLowerCase() === 'true'
};

const ollama = new Ollama({ host: KI_CONFIG.host });
const conversations = new Map();
const lastReplyAt = new Map();
const processing = new Set();

function ensureMemoryDir() {
  if (KI_CONFIG.persistMemory && !fs.existsSync(KI_CONFIG.memoryFolder)) {
    fs.mkdirSync(KI_CONFIG.memoryFolder, { recursive: true });
  }
}

function safeChatId(jid) {
  return String(jid || '').replace(/[^a-zA-Z0-9@._-]/g, '_');
}

function loadMemory(chatId) {
  if (!KI_CONFIG.persistMemory) return [];
  const file = path.join(KI_CONFIG.memoryFolder, `${safeChatId(chatId)}.json`);
  try {
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
  } catch {
    // corrupt file – ignore
  }
  return [];
}

function saveMemory(chatId, history) {
  if (!KI_CONFIG.persistMemory) return;
  const file = path.join(KI_CONFIG.memoryFolder, `${safeChatId(chatId)}.json`);
  try {
    fs.writeFileSync(file, JSON.stringify(history, null, 0));
  } catch (err) {
    console.error('[KI] Memory speichern fehlgeschlagen:', err.message);
  }
}

export function clearKiMemory(chatId) {
  conversations.delete(chatId);
  if (KI_CONFIG.persistMemory) {
    const file = path.join(KI_CONFIG.memoryFolder, `${safeChatId(chatId)}.json`);
    try {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch {}
  }
}

export function clearAllKiMemory() {
  conversations.clear();
  if (KI_CONFIG.persistMemory && fs.existsSync(KI_CONFIG.memoryFolder)) {
    for (const f of fs.readdirSync(KI_CONFIG.memoryFolder)) {
      try {
        fs.unlinkSync(path.join(KI_CONFIG.memoryFolder, f));
      } catch {}
    }
  }
}

function getHistory(chatId) {
  if (!conversations.has(chatId)) {
    conversations.set(chatId, loadMemory(chatId));
  }
  return conversations.get(chatId);
}

async function askOllama(chatId, userMessage, senderName = 'User') {
  let history = getHistory(chatId);

  if (history.length === 0 || history[0].role !== 'system') {
    history = [
      { role: 'system', content: KI_CONFIG.systemPrompt },
      ...history.filter((m) => m.role !== 'system')
    ];
  }

  history.push({ role: 'user', content: `${senderName}: ${userMessage}` });

  if (history.length > KI_CONFIG.memoryLimit + 1) {
    history = [history[0], ...history.slice(-(KI_CONFIG.memoryLimit))];
  }

  try {
    const response = await ollama.chat({
      model: KI_CONFIG.model,
      messages: history,
      stream: false,
      options: {
        num_predict: KI_CONFIG.maxTokens,
        temperature: 0.75,
        top_p: 0.9
      }
    });

    let reply = (response.message?.content || '').trim();
    reply = reply
      .replace(/^(Alex|Bot|Assistent|KI|Assistant|AI):\s*/i, '')
      .replace(/^["']|["']$/g, '')
      .trim();

    if (!reply) return null;

    history.push({ role: 'assistant', content: reply });
    conversations.set(chatId, history);
    saveMemory(chatId, history);

    return reply;
  } catch (err) {
    console.error('[KI] Ollama Fehler:', err.message);
    return null;
  }
}

function splitReply(text) {
  if (!text || text.length < 220) return [text];
  const mid = Math.floor(text.length / 2);
  let splitAt = text.lastIndexOf('. ', mid + 50);
  if (splitAt < mid - 50) splitAt = text.lastIndexOf(' ', mid);
  if (splitAt < 40) return [text];
  return [text.slice(0, splitAt + 1).trim(), text.slice(splitAt + 1).trim()].filter(Boolean);
}

/**
 * Prüft Ollama-Erreichbarkeit und Modell.
 * @returns {Promise<{ok: boolean, models: string[], error?: string}>}
 */
export async function checkOllama() {
  try {
    const tags = await ollama.list();
    const models = (tags.models || []).map((m) => m.name);
    const hasModel = models.some(
      (m) => m === KI_CONFIG.model || m.startsWith(KI_CONFIG.model + ':') || m.startsWith(KI_CONFIG.model)
    );
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

/**
 * Verarbeitet !ki / !resetki / !kistatus
 * @returns {Promise<boolean>} true wenn Command gehandelt wurde
 */
export async function handleKiCommand(sock, msg, groupId, senderId, text, pushName) {
  if (!KI_CONFIG.enabled) {
    await sock.sendMessage(groupId, {
      text: '🤖 KI ist deaktiviert (`KI_ENABLED=false` in .env).'
    }, { quoted: msg });
    return true;
  }

  const args = text.trim().split(/\s+/);
  const cmd = args[0].toLowerCase();
  const prefix = process.env.COMMAND_PREFIX || '!';

  // !kistatus / !ki status
  if (cmd === prefix + 'kistatus' || (cmd === prefix + 'ki' && args[1]?.toLowerCase() === 'status')) {
    const info = await checkOllama();
    const lines = [
      '🤖 *KI-Status*',
      `• Aktiv: ${KI_CONFIG.enabled ? '✅' : '❌'}`,
      `• Ollama: ${info.ok ? '✅ erreichbar' : '❌ ' + (info.error || 'offline')}`,
      `• Host: \`${info.host}\``,
      `• Modell: \`${info.model}\`${info.hasModel ? '' : ' ⚠️ nicht gefunden'}`,
      `• Memory-Chats: ${conversations.size}`,
      info.models.length ? `• Verfügbar: ${info.models.slice(0, 8).join(', ')}` : ''
    ].filter(Boolean);
    await sock.sendMessage(groupId, { text: lines.join('\n') }, { quoted: msg });
    return true;
  }

  // !resetki – Memory dieses Chats löschen
  if (cmd === prefix + 'resetki' || (cmd === prefix + 'ki' && args[1]?.toLowerCase() === 'reset')) {
    clearKiMemory(groupId);
    await sock.sendMessage(groupId, {
      text: '🧠 KI-Memory für diesen Chat gelöscht.'
    }, { quoted: msg });
    return true;
  }

  // !ki <prompt>
  if (cmd !== prefix + 'ki') return false;

  const prompt = args.slice(1).join(' ').trim();
  if (!prompt) {
    await sock.sendMessage(groupId, {
      text:
        '🤖 *KI-Befehle*\n' +
        `• \`${prefix}ki <Frage>\` – Ollama fragen\n` +
        `• \`${prefix}kistatus\` – Status & Modell\n` +
        `• \`${prefix}resetki\` – Memory dieses Chats löschen`
    }, { quoted: msg });
    return true;
  }

  const now = Date.now();
  const last = lastReplyAt.get(groupId) || 0;
  if (now - last < KI_CONFIG.rateLimitMs) {
    await sock.sendMessage(groupId, {
      text: '⏳ Bitte kurz warten (Rate-Limit).'
    }, { quoted: msg });
    return true;
  }

  if (processing.has(groupId)) {
    await sock.sendMessage(groupId, {
      text: '⏳ Die KI antwortet gerade noch…'
    }, { quoted: msg });
    return true;
  }

  processing.add(groupId);
  try {
    await sock.sendPresenceUpdate('composing', groupId);

    const reply = await askOllama(groupId, prompt, pushName || 'User');

    if (!reply) {
      await sock.sendMessage(groupId, {
        text: '❌ Keine Antwort von Ollama. Prüfe `OLLAMA_HOST` / Modell mit `!kistatus`.'
      }, { quoted: msg });
      return true;
    }

    const parts = splitReply(reply);
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) {
        await sock.sendPresenceUpdate('composing', groupId);
        await new Promise((r) => setTimeout(r, 400 + Math.random() * 600));
      }
      await sock.sendMessage(groupId, { text: parts[i] }, { quoted: i === 0 ? msg : undefined });
    }

    lastReplyAt.set(groupId, Date.now());
    await sock.sendPresenceUpdate('paused', groupId);
  } catch (err) {
    console.error('[KI] Handler-Fehler:', err.message);
    await sock.sendMessage(groupId, {
      text: '❌ KI-Fehler: ' + (err.message || 'unbekannt')
    }, { quoted: msg });
  } finally {
    processing.delete(groupId);
  }

  return true;
}

export function getKiConfig() {
  return { ...KI_CONFIG };
}

// Memory-Ordner beim Import anlegen
ensureMemoryDir();
