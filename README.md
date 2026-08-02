# wa-bot – WhatsApp Moderations-Bot

Node.js-Bot auf Basis von `whatsapp-web.js` mit MySQL.

## Features

- Schimpfwort-Filter (EN/DE/ES/LT + eigene Wörter)
- Anti-Spam
- Link- / Medien-Filter (Sticker, Bilder, Videos, Audio)
- Verwarnungen & automatischer Kick
- Mute (Nachrichten werden gelöscht)
- Willkommens- / Abschiedsnachrichten
- Gruppe sperren (`!lock` / `!unlock`)
- Admins werden **mitmoderiert** (keine Ausnahme bei Regelverstößen)
- Admin-Befehle funktionieren auch bei inaktivem Bot
- Chat-Cache gegen `getChat`-Fehler

## Setup

```bash
cp .env.example .env
# .env ausfüllen
npm install
npm start
```

Kopplungscode erscheint in der Konsole (Pairing über `PHONE_NUMBER`).

## Admin-Befehle

| Befehl | Beschreibung |
|--------|--------------|
| `!bot on/off` | Bot aktivieren/deaktivieren |
| `!bot` | Status anzeigen |
| `!help` | Hilfe |
| `!settings` | Gruppen-Einstellungen |
| `!toggle <option>` | links, stickers, images, videos, audios, antispam, welcome |
| `!maxwarns <n>` | Max. Verwarnungen setzen |
| `!setwelcome <text>` | Willkommenstext (`@user` = Erwähnung) |
| `!setleave <text>` | Abschiedstext |
| `!lock` / `!unlock` | Nur Admins dürfen schreiben |
| `!mute @User` / `!unmute @User` | Stummschalten |
| `!muted` | Liste stummgeschalteter User |
| `!kick @User` | Entfernen |
| `!warns @User` | Verwarnungen anzeigen |
| `!resetwarns @User` | Verwarnungen zurücksetzen |
| `!clearwarns` | Alle Verwarnungen der Gruppe löschen |
| `!addword <wort>` / `!delword <wort>` | Schimpfwörter |
| `!stats` | Gruppen-Statistik |
| `!ping` | Latenz-Check |
| `!info` | Bot-Info |

## Hinweise

- Bot muss **Gruppen-Admin** sein, damit Löschen/Kicken funktioniert.
- `.env` nie committen.
- Bei `getChat`-Problemen (WhatsApp-Web-Updates) greift der Fallback-Cache.
