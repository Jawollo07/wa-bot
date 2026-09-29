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


## Modulare Architektur

Der Branch refactor/modular-architecture führt eine Service-/Runtime-Schicht ein. Die bisherige globale Kopplung wird schrittweise abgebaut.

Struktur:

src/core/ — Runtime, Application Context, Utilities und Logger
src/services/ — Gruppen, Nachrichten, Berechtigungen und Moderation
src/database/ — Datenbank-Boundary und Verbindung
src/commands/ — Command Context, Registry und Domain-Commands
src/ai/ — KI-Integration
src/moderation/ — Moderationslogik
src/bot/ — WhatsApp/Baileys-Transport

### Architekturregeln

- WhatsApp/Baileys-Zugriff läuft über den Runtime-Socket bzw. den Message Service.
- Datenbankzugriff läuft über die Database Boundary.
- Moderation kennt keine WhatsApp-Verbindungsdetails.
- Gruppen-Metadaten und Cache liegen im Group Service.
- Berechtigungsprüfungen liegen im Permission Service.
- Der Message Handler orchestriert die Pipeline.
- Legacy-Code bleibt während der Migration hinter klaren Grenzen und wird schrittweise entfernt.

### Migrationsziel

Die Root-Dateien commands.js, mod_actions.js, messageHandler.js, db.js und logging.js werden schrittweise aus der globalen Service-Schicht entfernt oder auf minimale Kompatibilitätsadapter reduziert.

Der Umbau erfolgt auf einem separaten Branch, damit master unverändert bleibt.


## Modulare Architektur

Die Anwendung ist vollständig unter `src/` organisiert. `app.js` ist nur noch der Bootstrap.

```
src/
├── bot/             # Baileys Transport + Message Pipeline
├── commands/        # Command Registry und Domain-Handler
├── config/          # Bootstrap- und Runtime-Konfiguration
├── core/            # Runtime, Logger, Utility-Funktionen
├── database/        # MySQL-Verbindung und Datenbankzugriff
├── ki/              # Ollama/KI
├── logging/         # Persistentes Moderations-Logging
├── moderation/      # Wortfilter und Moderations-Lifecycle
└── services/
    ├── moderation/  # Warnungen, Bans, Mutes, Spam, Violations
    ├── group-service.js
    ├── message-service.js
    └── permission-service.js
```

Root-Level-Implementierungen wie `commands.js`, `db.js`, `logging.js`, `messageHandler.js`, `socket.js`, `config.js`, `profanity.js` und `ollama.js` wurden entfernt. Neue Funktionen sollen ausschließlich über die jeweiligen `src/`-Boundaries importiert werden.
