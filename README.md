# wa-bot v3.4 (Baileys)

WhatsApp-**Moderations-Bot** auf Basis von [Baileys](https://github.com/WhiskeySockets/Baileys) und **MySQL**.

Kein Puppeteer/Chrome – reine WebSocket-Verbindung zu WhatsApp.

---

## Features

| Bereich | Funktionen |
|--------|------------|
| **Filter** | Schimpfwörter hybrid (klassische Liste + optional KI), Leetspeak/Trennzeichen/Wiederholungen, Links, Sticker, Bilder, Videos, Audio |
| **Anti-Spam** | Rate-Limit pro Nutzer |
| **Verwarnungen** | Automatisch, Kick bei Max, Admin-Schutz beim Kick |
| **Mute** | Stummschalten (Nachrichten werden gelöscht) |
| **Ban** | Temporär / permanent – Auto-Kick bei Wiedereintritt |
| **Gruppe** | Lock/Unlock, Kick, Stats, Willkommen/Abschied |
| **Logging** | Vollständiges MySQL-Logging aller Moderations- und Admin-Aktionen |
| **Admin** | `!help` und viele weitere Befehle |
| **KI (Ollama)** | `!ki` mit **qwen3.5:9b**, Conversation-Memory + Mitglieder-Namen in MySQL |

---

## Voraussetzungen

- **Node.js** ≥ 18 (empfohlen: 20+)
- **MySQL** 5.7+ / 8 / MariaDB (**persistenter** Speicher!)
- WhatsApp-Konto (Handy mit Internet)
- **Ollama** (optional, für `!ki` und KI-Profanity) – [ollama.com](https://ollama.com)

---

## Installation

```bash
git clone https://github.com/Jawollo07/wa-bot.git
cd wa-bot
npm install
cp .env.example .env
# .env ausfüllen (siehe unten)
node app.js
```

### Erste Anmeldung

1. Bot starten
2. **QR-Code** im Terminal mit WhatsApp scannen
   **oder** Pairing-Code nutzen (`PHONE_NUMBER` in `.env`)
3. Auth-Daten landen in `auth_baileys/`

Neu koppeln:

```bash
rm -rf auth_baileys
node app.js
```

---

## Konfiguration

### `.env` – nur Bootstrap (Pflicht: MySQL)

| Variable | Pflicht | Beschreibung |
|----------|---------|--------------|
| `DB_HOST` | ja | MySQL-Host |
| `DB_USER` | ja | MySQL-User |
| `DB_PASSWORD` | ja | MySQL-Passwort |
| `DB_DATABASE` | ja | Datenbankname |
| `DB_PORT` | nein | Default `3306` |
| `PHONE_NUMBER` | optional | Pairing (sonst `bot_config.phone_number`) |
| `BOT_OWNERS` | optional | Owner (sonst `bot_config.bot_owners`) |

```env
DB_HOST=127.0.0.1
DB_USER=wa_bot
DB_PASSWORD=geheim
DB_DATABASE=wa_bot
DB_PORT=3306
# PHONE_NUMBER=4915123456789
# BOT_OWNERS=4915123456789
```

### MySQL-Tabelle `bot_config`

Alle Laufzeit-Einstellungen (Ollama, Prefix, Spam, …) liegen in **`bot_config`** (Key/Value).
Beim ersten Start werden Defaults geschrieben; vorhandene `.env`-Werte werden einmalig migriert.

| Befehl (Owner) | Beschreibung |
|----------------|--------------|
| `!config` | Alle Keys anzeigen |
| `!setconfig <key> <wert>` | z. B. `!setconfig ollama_model qwen3.5:9b` |
| `!reloadconfig` | Neu aus DB laden + KI anwenden |

Wichtige Keys: `ollama_host`, `ollama_model`, `ki_enabled`, `max_tokens`, `memory_limit`, `ki_temperature`, `ki_timeout_ms`, `command_prefix`, `spam_max_messages`, `settings_cache_ttl_ms`, `reconnect_base_ms`, `system_prompt`, `phone_number`, `bot_owners`, `ki_profanity_enabled`, …

---

## Schnellstart in einer Gruppe

1. Bot zur Gruppe hinzufügen (als **Admin**, sonst kein Kick/Löschen/Ban)
2. Als Gruppen-Admin oder Bot-Owner: `!bot on`
3. Optional: `!settings`, `!toggle links`, `!maxwarns 3`
4. `!help` zeigt alle Befehle

---

## Admin-Befehle

Nur **Gruppen-Admins** und **Bot-Owner** (`PHONE_NUMBER` / `BOT_OWNERS`).

### Steuerung
| Befehl | Beschreibung |
|--------|--------------|
| `!bot on` / `!bot off` | Moderation an/aus (Status in MySQL) |
| `!bot` | Aktuellen Status + Group-ID anzeigen |
| `!settings` | Alle Gruppeneinstellungen |
| `!info` / `!stats` / `!ping` | Info, Statistik, Latenz |
| `!logs [n]` | Letzte n Logs dieser Gruppe anzeigen (Default 15, max 30) |

### Filter umschalten
```text
!toggle links|stickers|images|videos|audios|antispam|welcome|ki
```

### Verwarnungen
| Befehl | Beschreibung |
|--------|--------------|
| `!maxwarns 1–20` | Max. Verwarnungen bis Kick |
| `!warns @User` | Verwarnungen anzeigen |
| `!resetwarns @User` | Zurücksetzen |
| `!clearwarns` | Alle in der Gruppe löschen |

### Mute / Kick / Ban
| Befehl | Beschreibung |
|--------|--------------|
| `!mute @User` / `!unmute @User` | Stumm / wieder erlauben |
| `!muted` | Liste |
| `!kick @User` | Einmalig entfernen |
| `!ban @User` | **Permanent** bannen + kicken |
| `!ban @User 1h` | 1 Stunde |
| `!ban @User 2d spam` | 2 Tage + Grund |
| `!unban @User` | Ban aufheben |
| `!banned` | Aktive Bans |

**Ban-Dauern:** `30m`, `2h`, `1d`, `7d`, `permanent` (auch `perm` / `ewig`)

Gebannte Nutzer werden bei **jedem Wiedereintritt** automatisch wieder gekickt.

### Gruppe & Texte
| Befehl | Beschreibung |
|--------|--------------|
| `!lock` / `!unlock` | Nur Admins dürfen schreiben / alle |
| `!setwelcome …` | Willkommenstext (`@user` = Erwähnung) |
| `!setleave …` | Abschiedstext |
| `!addword` / `!delword` | Schimpfwort hinzufügen / entfernen |
| `!help` | Hilfe |

### KI (Ollama) – für alle Nutzer

**Standardmodell: `qwen3.5:9b`** (gutes Deutsch, starke Anweisungsbefolgung, passt auf ~8–12 GB RAM).

```bash
ollama pull qwen3.5:9b
# Ollama muss laufen: ollama serve
```

Die Gruppe muss mit `!bot on` aktiv sein (außer `!kistatus` / `!kimembers`).

| Befehl | Beschreibung |
|--------|--------------|
| `!ki <Frage>` | Ollama fragen (Conversation-Memory pro Gruppe) |
| Antwort auf Nachricht + `!ki …` | Zitierte Nachricht als Kontext |
| `!kistatus` | Host, Modell, Stats, Timeout, Mitglieder |
| `!kimembers` | Gelernte Mitgliedernamen |
| `!resetki` | Chat-Memory löschen (Namen bleiben) |
| `!ki resetmembers` | Namens-Registry neu lernen |
| `!toggle ki` | KI pro Gruppe an/aus (Admin) |

**Mitglieder-Unterscheidung:** Nachrichten als `Jan: …`, `Tom: …`.
Unbekannte: `Mitglied_1234` → Update bei echtem Anzeigenamen.

**Persistenz (ab v3.4):** Chat-Memory und Mitglieder liegen in MySQL (`ki_chat_memory`, `ki_members`). Alte lokale `ki_memory/*.json`-Dateien werden beim Start einmalig migriert und entfernt.

Weitere Features: Request-Timeout, Deduplizierung, Rate-Limit, Stats in `!kistatus`, Hybrid-Profanity (klassisch + KI).

Modul: `ollama.js` – optimiert für **Qwen 3.5** (Temperature, Kontext, Thinking-Tag-Filter).

---

## Datenbank

Beim Start werden Tabellen automatisch angelegt:

- `group_settings` – u. a. **`is_active`** pro Gruppe
- `warnings`, `muted_users`, `banned_users`
- `bad_words`
- **`mod_logs`** – vollständiges Audit-Log
- `bot_config` – globale Laufzeit-Config
- `ki_chat_memory`, `ki_members` – KI-Memory & Namen

### Wichtig: `is_active` nach Reboot

Der Status **`!bot on`** liegt **nur in MySQL**. MySQL-Daten müssen persistent sein (Volume / externer DB-Server).

---

## Änderungen in v3.4.0

- Settings-Cache (`settings_cache_ttl_ms`) – weniger DB-Last pro Nachricht
- Exponentielles Reconnect-Backoff (`reconnect_base_ms` / `reconnect_max_ms`)
- Fallback-Schimpfwörter, wenn Remote-Liste offline ist
- Bugfix: `!setleave` aktiviert nicht mehr fälschlich Welcome
- Spam-Map-Cleanup gegen Memory-Wachstum
- README an MySQL-KI-Memory angepasst
- Versionsnummern vereinheitlicht

---

## Hosting / Panel (Pterodactyl o. Ä.)

- **Startbefehl:** `node app.js`
- Volumes: `auth_baileys/` + MySQL persistent

---

## Projektstruktur

```text
app.js           # Bot (Baileys + Moderation + Logging + KI-Anbindung)
config.js        # bot_config (MySQL Key/Value)
ollama.js        # Ollama-KI-Modul (!ki, Memory, Profanity-KI)
profanity.js     # Klassische Schimpfwort-Erkennung
package.json     # Dependencies (ESM)
.env             # Geheimnisse (nicht committen)
auth_baileys/    # WhatsApp-Session (nicht committen)
```

---

## Troubleshooting

| Problem | Lösung |
|--------|--------|
| Keine Nachrichten | Neu koppeln (`rm -rf auth_baileys`), Bot-Logs prüfen |
| `is_active` weg nach Reboot | MySQL-Persistenz prüfen |
| Kick/Ban/Löschen geht nicht | Bot muss **Gruppen-Admin** sein |
| Pairing-Code | `PHONE_NUMBER` ohne `+` und Leerzeichen |
| Module not found | `rm -rf node_modules && npm install` |
| ESM-Fehler | Node ≥ 18, Start mit `node app.js` |
| Ollama langsam / Timeout | Kleineres Modell oder `!setconfig ki_timeout_ms 120000` |

---

## Sicherheit

- `.env` und `auth_baileys/` **nie** ins Git committen
- Bot-Nummer und DB-Zugangsdaten geheim halten
- Nur vertrauenswürdige Admins in der Gruppe

---

## Lizenz

ISC – Nutzung auf eigene Verantwortung. Nicht für Spam oder Verstöße gegen die WhatsApp-Nutzungsbedingungen.
