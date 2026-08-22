# wa-bot v3.5 (Baileys)

WhatsApp-**Moderations-Bot** auf Basis von Baileys, MySQL und optional Ollama.

## Architektur

Der Bot verwendet jetzt eine modulare Application-Schicht unter `src/`. Die bisherigen Root-Module bleiben als kompatible Implementierungsadapter erhalten, damit bestehende Installationen und Session-/Datenbankzustände ohne Migration weiterlaufen.

```text
src/
├── ai/            # Ollama/KI-Grenze
├── bot/           # Baileys-Verbindung + Event-Grenze
├── commands/      # Command-Grenze
├── config/        # Laufzeit-Konfiguration
├── database/      # MySQL-Grenze
├── logging/       # zentrales Logging
└── moderation/    # Moderations-/Profanity-Grenze
```

Die Abhängigkeiten laufen damit grundsätzlich über:

```text
WhatsApp Event
    ↓
   bot
    ↓
 commands / moderation / ai
    ↓
 database / logging / config
```

Die bestehenden Root-Dateien (`commands.js`, `db.js`, `ollama.js`, `socket.js`, `messageHandler.js`, `mod_actions.js`, `profanity.js`, `config.js`, `logging.js`) sind aktuell die Implementierungsebene. Neue Funktionen sollten möglichst über die entsprechenden `src/*`-Module eingebunden werden. Die vollständige Aufteilung der einzelnen Command- und Service-Implementierungen kann dadurch schrittweise erfolgen, ohne den laufenden Bot zu brechen.

## Voraussetzungen

- **Node.js** ≥ 18 (empfohlen: 20+)
- **MySQL** 5.7+ / 8 / MariaDB
- WhatsApp-Konto
- **Ollama** optional für `!ki` und KI-Profanity

## Installation

```bash
git clone https://github.com/Jawollo07/wa-bot.git
cd wa-bot
npm install
cp .env.example .env
node app.js
```

## Konfiguration

In `.env` bleiben die Bootstrap-Werte für die Datenbank sowie optional Telefonnummer/Owner. Laufzeitoptionen werden in MySQL `bot_config` verwaltet.

```env
DB_HOST=127.0.0.1
DB_USER=wa_bot
DB_PASSWORD=geheim
DB_DATABASE=wa_bot
DB_PORT=3306
```

## Sicherheit

- `.env` und `auth_baileys/` niemals committen.
- DB-Zugangsdaten geheim halten.
- Nur vertrauenswürdige Gruppen-Admins/Owner verwenden.

## Lizenz

ISC – Nutzung auf eigene Verantwortung. Nicht für Spam oder Verstöße gegen die WhatsApp-Nutzungsbedingungen.

## Weiterentwicklung

Die nächste Refactoring-Stufe kann die großen Implementierungsdateien weiter zerlegen, insbesondere:

- `commands.js` → einzelne Command-Module
- `messageHandler.js` → Event-, Filter- und Moderations-Pipeline
- `mod_actions.js` → Warning/Mute/Ban/Action-Services
- `ollama.js` → Client, Memory und KI-Moderation
- `db.js` → Repositories und Migrationen

Dabei sollen die bestehenden Commands und Datenbankschemata unverändert funktionieren.
