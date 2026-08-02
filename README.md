# wa-bot v3 (Baileys)

WhatsApp-Moderations-Bot auf Basis von [Baileys](https://github.com/WhiskeySockets/Baileys) + MySQL.

## Features
- Schimpfwort-Filter (Leetspeak, Trennzeichen, …)
- Anti-Spam, Link-/Media-Filter
- Mute, Kick, Verwarnungen
- Admin-Befehle (`!help`)
- Willkommens-/Abschiedsnachrichten

## Setup
```bash
npm install
cp .env.example .env   # DB + PHONE_NUMBER setzen
node app.js
```

Beim ersten Start QR-Code oder Pairing-Code (`PHONE_NUMBER`) scannen.

Auth-Daten liegen in `auth_baileys/`. Zum Neu-Koppeln Ordner löschen.

## Env
- `PHONE_NUMBER` – für Pairing-Code
- `BOT_OWNERS` – optionale Owner-Nummern
- `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_DATABASE`, `DB_PORT`
- `COMMAND_PREFIX` – default `!`
