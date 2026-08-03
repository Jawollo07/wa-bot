# wa-bot v3 (Baileys)

WhatsApp-**Moderations-Bot** auf Basis von [Baileys](https://github.com/WhiskeySockets/Baileys) und **MySQL**.

Kein Puppeteer/Chrome – reine WebSocket-Verbindung zu WhatsApp.

---

## Features

| Bereich | Funktionen |
|--------|------------|
| **Filter** | Schimpfwörter (Leetspeak, Trennzeichen, Wiederholungen), Links, Sticker, Bilder, Videos, Audio |
| **Anti-Spam** | Rate-Limit pro Nutzer |
| **Verwarnungen** | Automatisch, Kick bei Max, Admin-Schutz beim Kick |
| **Mute** | Stummschalten (Nachrichten werden gelöscht) |
| **Ban** | Temporär / permanent – Auto-Kick bei Wiedereintritt |
| **Gruppe** | Lock/Unlock, Kick, Stats, Willkommen/Abschied |
| **Logging** | Vollständiges MySQL-Logging aller Moderations- und Admin-Aktionen |
| **Admin** | `!help` und viele weitere Befehle |

---

## Voraussetzungen

- **Node.js** ≥ 18 (empfohlen: 20+)
- **MySQL** 5.7+ / 8 / MariaDB (**persistenter** Speicher!)
- WhatsApp-Konto (Handy mit Internet)

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

## Umgebungsvariablen (`.env`)

| Variable | Pflicht | Beschreibung |
|----------|---------|--------------|
| `PHONE_NUMBER` | empfohlen | Nummer ohne `+`/Leerzeichen (Pairing-Code), z. B. `4915123456789` |
| `BOT_OWNERS` | nein | Zusätzliche Owner-Nummern, kommagetrennt |
| `DB_HOST` | ja | MySQL-Host |
| `DB_USER` | ja | MySQL-User |
| `DB_PASSWORD` | ja | MySQL-Passwort |
| `DB_DATABASE` | ja | Datenbankname |
| `DB_PORT` | nein | Default `3306` |
| `COMMAND_PREFIX` | nein | Default `!` |
| `SPAM_MAX_MESSAGES` | nein | Default `5` |
| `SPAM_TIMEFRAME_MS` | nein | Default `5000` |
| `BAILEYS_AUTH_PATH` | nein | Auth-Ordner (Default `./auth_baileys`) |
| `BAILEYS_LOG_LEVEL` | nein | z. B. `silent`, `info`, `debug` |

Beispiel:

```env
PHONE_NUMBER=4915123456789
BOT_OWNERS=4915123456789
DB_HOST=127.0.0.1
DB_USER=wa_bot
DB_PASSWORD=geheim
DB_DATABASE=wa_bot
DB_PORT=3306
COMMAND_PREFIX=!
```

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
!toggle links|stickers|images|videos|audios|antispam|welcome
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

---

## Datenbank

Beim Start werden Tabellen automatisch angelegt:

- `group_settings` – u. a. **`is_active`** pro Gruppe
- `warnings`, `muted_users`, `banned_users`
- `bad_words`
- **`mod_logs`** – vollständiges Audit-Log (siehe unten)

### mod_logs (vollständiges Logging)

| Spalte | Beschreibung |
|--------|--------------|
| `group_id` | Gruppen-JID oder `SYSTEM` (Bot-weite Events) |
| `user_id` | Betroffener User / `bot` / `settings` / … |
| `actor_id` | Wer die Aktion ausgelöst hat (Admin oder `system`) |
| `action` | z. B. `WARN`, `BAN`, `BOT_ON`, `TOGGLE`, `JOIN`, `CONNECTED`, … |
| `reason` | Freier Text |
| `details` | JSON mit Zusatzinfos (optional) |
| `created_at` | Zeitstempel |

**Geloggte Aktionen (Auszug):**

- Moderations: `WARN`, `WARN_MAX_ADMIN`, `KICK`, `MUTE`, `UNMUTE`, `BAN`, `UNBAN`, `BAN_REKICK`, `MUTE_DELETE`
- Admin: `BOT_ON`/`BOT_OFF`, `TOGGLE`, `MAXWARNS`, `SET_WELCOME`/`SET_LEAVE`, `LOCK`/`UNLOCK`, `ADD_WORD`/`DEL_WORD`, `COMMAND`
- Gruppe: `JOIN`, `LEAVE`, `WELCOME_SENT`, `LEAVE_MSG_SENT`
- System: `BOT_START`, `CONNECTED`, `DISCONNECTED`, `LOGGED_OUT`, `ERROR`

Beispiel-Abfragen:

```sql
-- Letzte 50 Aktionen einer Gruppe
SELECT * FROM mod_logs WHERE group_id = '120363...@g.us' ORDER BY id DESC LIMIT 50;

-- Alle Bans der letzten 7 Tage
SELECT * FROM mod_logs WHERE action = 'BAN' AND created_at > DATE_SUB(NOW(), INTERVAL 7 DAY);

-- System-Events
SELECT * FROM mod_logs WHERE group_id = 'SYSTEM' ORDER BY id DESC LIMIT 20;
```

### Wichtig: `is_active` nach Reboot

Der Status **`!bot on`** liegt **nur in MySQL**. Wenn er nach einem Neustart weg ist, liegt es fast immer an der Datenbank:

1. **MySQL-Daten müssen persistent sein** (Volume / externer DB-Server).  
   Läuft MySQL *im selben Container* ohne Volume, ist die DB nach jedem Rebuild leer → alle Gruppen wieder inaktiv.
2. Prüfen:
   ```sql
   SELECT group_id, is_active FROM group_settings;
   ```
3. Nach dem Start erneut `!bot on` setzen, wenn die DB neu war.
4. `!bot` zeigt den aktuellen Status und die Group-ID.

Der Bot speichert `is_active` per **UPSERT** und überschreibt bestehende Werte beim normalen Start **nicht**.

---

## Hosting / Panel (Pterodactyl o. Ä.)

- **Startbefehl:** `node app.js` (ESM, kein `tsx` nötig)
- **Hauptfile:** `app.js`
- `NODE_PACKAGES` leer lassen – Dependencies kommen aus `package.json`
- **Kein Chrome/Puppeteer** nötig
- Volumes persistent halten:
  - `auth_baileys/` (Login)
  - MySQL-Datenverzeichnis **oder** externe DB

`git pull` + `npm install` nach Updates.

---

## Projektstruktur

```text
app.js           # Bot (Baileys + Moderation + Logging)
profanity.js     # Schimpfwort-Erkennung
package.json     # Dependencies (ESM)
.env             # Geheimnisse (nicht committen)
auth_baileys/    # WhatsApp-Session (nicht committen)
```

---

## Troubleshooting

| Problem | Lösung |
|--------|--------|
| Keine Nachrichten | Neu koppeln (`rm -rf auth_baileys`), Bot-Logs prüfen |
| `is_active` weg nach Reboot | MySQL-Persistenz prüfen (siehe oben) |
| Kick/Ban/Löschen geht nicht | Bot muss **Gruppen-Admin** sein |
| Pairing-Code | `PHONE_NUMBER` ohne `+` und Leerzeichen |
| Module not found | `rm -rf node_modules && npm install` |
| ESM-Fehler | Node ≥ 18, Start mit `node app.js` |

---

## Sicherheit

- `.env` und `auth_baileys/` **nie** ins Git committen
- Bot-Nummer und DB-Zugangsdaten geheim halten
- Nur vertrauenswürdige Admins in der Gruppe
- Logs enthalten ggf. User-IDs und kurze Nachrichten-Snippets – DB-Zugriff einschränken

---

## Lizenz

ISC – Nutzung auf eigene Verantwortung. Nicht für Spam oder Verstöße gegen die WhatsApp-Nutzungsbedingungen.
