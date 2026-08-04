/**
 * Ollama KI-Modul für wa-bot
 * Trigger: !ki <Frage>
 * Basiert auf whatsapp-ollama-human-bot (Jawollo07)
 *
 * Mitglieder-Unterscheidung:
 * - Jede Nachricht wird als „Name: Text“ gespeichert
 * - Pro Gruppe wird eine Namens-Registry (JID → Anzeigename) geführt
 * - Die KI bekommt die bekannten Mitglieder im System-Kontext
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
Du kannst Humor und Emojis nutzen, bleibst aber sachlich wenn die Frage ernst ist.

WICHTIG – Mitglieder:
- Jede User-Nachricht beginnt mit dem Namen des Absenders, z. B. „Jan: …“ oder „Tom: …“.
- Verschiedene Namen = verschiedene Personen. Verwechsle sie nicht.
- Wenn jemand über eine andere Person spricht oder du jemanden ansprichst, nutze den richtigen Namen.
- Beziehe dich im Verlauf auf den jeweiligen Sprecher („du“ = die Person, die gerade gefragt hat).`).replace(/^"|"$/g, ''),
  maxTokens: parseInt(process.env.MAX_TOKENS || '300', 10),
  memoryLimit: parseInt(process.env.MEMORY_LIMIT || '12', 10),
  persistMemory: (process.env.PERSIST_MEMORY || 'true').toLowerCase() === 'true',
  rateLimitMs: parseInt(process.env.KI_RATE_LIMIT_MS || '3000', 10),
  memoryFolder: process.env.KI_MEMORY_PATH || path.join(__dirname, 'ki_memory'),
  enabled: (process.env.KI_ENABLED || 'true').toLowerCase() === 'true'
};

const ollama = new Ollama({ host: KI_CONFIG.host });
const conversations = new Map();
/** @type {Map<string, Map<string, { name: string, phone: string, lastSeen: number }>>} */
const membersByGroup = new Map();
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

function normalizePhone(jidOrNum) {
  if (!jidOrNum) return '';
  return String(jidOrNum).split('@')[0].split(':')[0].replace(/\D/g, '');
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

function membersFile(chatId) {
  return path.join(KI_CONFIG.memoryFolder, `members_${safeChatId(chatId)}.json`);
}

function loadMembers(chatId) {
  if (membersByGroup.has(chatId)) return membersByGroup.get(chatId);
  const map = new Map();
  if (KI_CONFIG.persistMemory) {
    try {
      const file = membersFile(chatId);
      if (fs.existsSync(file)) {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        for (const [key, val] of Object.entries(data)) {
          if (val && val.name) {
            map.set(key, {
              name: String(val.name),
              phone: String(val.phone || key),
              lastSeen: Number(val.lastSeen) || 0
            });
          }
        }
      }
    } catch {
      // ignore
    }
  }
  membersByGroup.set(chatId, map);
  return map;
}

function saveMembers(chatId) {
  if (!KI_CONFIG.persistMemory) return;
  const map = membersByGroup.get(chatId);
  if (!map) return;
  const obj = {};
  for (const [key, val] of map.entries()) {
    obj[key] = val;
  }
  try {
    fs.writeFileSync(membersFile(chatId), JSON.stringify(obj, null, 0));
  } catch (err) {
    console.error('[KI] Mitglieder speichern fehlgeschlagen:', err.message);
  }
}

/**
 * Prüft, ob ein Name brauchbar ist (nicht leer, nicht nur Ziffern, nicht generisch).
 */
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

/**
 * Stabile Anzeigename-Auflösung pro Absender.
 * Priorität: bekannter Registry-Name → pushName → Mitglied_XXXX (letzte 4 Ziffern)
 */
export function resolveMemberName(chatId, senderId, pushName = '') {
  const phone = normalizePhone(senderId) || String(senderId || 'unknown');
  const map = loadMembers(chatId);
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

  // Registry aktualisieren (Name kann sich verbessern, z. B. erst Mitglied_1234 → Jan)
  const shouldUpdate =
    !existing ||
    (isUsefulName(incoming) && existing.name !== incoming) ||
    existing.name.startsWith('Mitglied_') && isUsefulName(incoming);

  if (shouldUpdate || !existing) {
    map.set(phone, {
      name,
      phone,
      lastSeen: Date.now()
    });
    saveMembers(chatId);
  } else if (existing) {
    existing.lastSeen = Date.now();
  }

  return name;
}

/**
 * Kurze Mitgliederliste für den System-Kontext.
 */
function formatMemberRoster(chatId) {
  const map = loadMembers(chatId);
  if (!map.size) return '';
  const entries = [...map.values()]
    .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0))
    .slice(0, 30);
  const lines = entries.map((m) => `- ${m.name}`);
  return (
    '\n\nBekannte Gruppenmitglieder (Namen der Absender):\n' +
    lines.join('\n') +
    '\nNutze diese Namen, um Personen zu unterscheiden und korrekt anzusprechen.'
  );
}

export function clearKiMemory(chatId) {
  conversations.delete(chatId);
  if (KI_CONFIG.persistMemory) {
    const file = path.join(KI_CONFIG.memoryFolder, `${safeChatId(chatId)}.json`);
    try {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch {}
  }
  // Mitglieder-Registry bewusst behalten – nur Chatverlauf löschen
}

export function clearKiMembers(chatId) {
  membersByGroup.delete(chatId);
  if (KI_CONFIG.persistMemory) {
    try {
      const file = membersFile(chatId);
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch {}
  }
}

export function clearAllKiMemory() {
  conversations.clear();
  if (KI_CONFIG.persistMemory && fs.existsSync(KI_CONFIG.memoryFolder)) {
    for (const f of fs.readdirSync(KI_CONFIG.memoryFolder)) {
      if (f.startsWith('members_')) continue; // Mitglieder behalten
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

function buildSystemContent(chatId) {
  return KI_CONFIG.systemPrompt + formatMemberRoster(chatId);
}

async function askOllama(chatId, userMessage, senderName = 'User') {
  let history = getHistory(chatId);
  const systemContent = buildSystemContent(chatId);

  // System-Prompt + aktuelle Mitgliederliste immer aktuell halten
  if (history.length === 0 || history[0].role !== 'system') {
    history = [{ role: 'system', content: systemContent }, ...history.filter((m) => m.role !== 'system')];
  } else {
    history[0] = { role: 'system', content: systemContent };
  }

  // Klare Zuordnung: „Jan: Frage …“
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
 * Verarbeitet !ki / !resetki / !kistatus / !kimembers
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

  // Anzeigename stabil auflösen (lernt Namen pro Mitglied)
  const memberName = resolveMemberName(groupId, senderId, pushName);

  // !kistatus / !ki status
  if (cmd === prefix + 'kistatus' || (cmd === prefix + 'ki' && args[1]?.toLowerCase() === 'status')) {
    const info = await checkOllama();
    const memberCount = loadMembers(groupId).size;
    const lines = [
      '🤖 *KI-Status*',
      `• Aktiv: ${KI_CONFIG.enabled ? '✅' : '❌'}`,
      `• Ollama: ${info.ok ? '✅ erreichbar' : '❌ ' + (info.error || 'offline')}`,
      `• Host: \`${info.host}\``,
      `• Modell: \`${info.model}\`${info.hasModel ? '' : ' ⚠️ nicht gefunden'}`,
      `• Memory-Chats: ${conversations.size}`,
      `• Bekannte Mitglieder (diese Gruppe): ${memberCount}`,
      `• Dein Name für die KI: *${memberName}*`,
      info.models.length ? `• Verfügbar: ${info.models.slice(0, 8).join(', ')}` : ''
    ].filter(Boolean);
    await sock.sendMessage(groupId, { text: lines.join('\n') }, { quoted: msg });
    return true;
  }

  // !kimembers – bekannte Namen anzeigen
  if (cmd === prefix + 'kimembers' || (cmd === prefix + 'ki' && args[1]?.toLowerCase() === 'members')) {
    const map = loadMembers(groupId);
    if (!map.size) {
      await sock.sendMessage(groupId, {
        text: '👥 Noch keine Mitglieder bekannt. Sobald jemand `!ki` nutzt, lernt die KI den Namen (WhatsApp-Anzeigename).'
      }, { quoted: msg });
      return true;
    }
    const list = [...map.values()]
      .sort((a, b) => a.name.localeCompare(b.name, 'de'))
      .map((m) => `• ${m.name}`)
      .join('\n');
    await sock.sendMessage(groupId, {
      text: `👥 *Bekannte Mitglieder für die KI* (${map.size})\n${list}`
    }, { quoted: msg });
    return true;
  }

  // !resetki – Memory dieses Chats löschen (Mitglieder bleiben)
  if (cmd === prefix + 'resetki' || (cmd === prefix + 'ki' && args[1]?.toLowerCase() === 'reset')) {
    clearKiMemory(groupId);
    await sock.sendMessage(groupId, {
      text: '🧠 KI-Memory für diesen Chat gelöscht. (Mitgliedernamen bleiben erhalten)'
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
        `• \`${prefix}kimembers\` – bekannte Mitgliedernamen\n` +
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

    const reply = await askOllama(groupId, prompt, memberName);

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
