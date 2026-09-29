# wa-bot v3.6.0 (Baileys)

WhatsApp-**Moderations-Bot** auf Basis von Baileys, MySQL und optional Ollama.

## Architektur

Der Bot ist vollständig modularisiert. `app.js` ist nur noch der Bootstrap; fachliche Logik liegt unter `src/`.

```text
src/
├── bot/             # Baileys-Transport + Message-Pipeline
├── commands/        # Command-Registry + Domain-Commands
├── config/          # Bootstrap- und Laufzeit-Konfiguration
├── core/            # Runtime, Logger, Utilities
├── database/        # MySQL-Boundary
├── ki/              # Ollama/KI
├── logging/         # Persistentes Moderations-Logging
├── moderation/      # Wortfilter + öffentliche Moderations-Boundary
└── services/
    ├── moderation/  # Warnungen, Bans, Mutes, Spam, Violations
    ├── group-service.js
    ├── message-service.js
    └── permission-service.js
```

### Architekturregeln

- WhatsApp/Baileys-Zugriff läuft über `src/bot/` und die Runtime-/Message-Service-Boundaries.
- Datenbankzugriff läuft über `src/database/`.
- Moderationslogik liegt unter `src/moderation/` und `src/services/moderation/`.
- Gruppen-Metadaten und Cache liegen im Group Service.
- Berechtigungsprüfungen liegen im Permission Service.
- Der Message Handler orchestriert die Nachrichten-Pipeline.
- Neue Funktionen werden nicht mehr als Root-Level-Implementierungen angelegt.

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

## Community-Unterstützung

Der Bot verarbeitet automatisch jede WhatsApp-Gruppe, in der sein Konto Mitglied ist. Das gilt auch für Gruppen innerhalb einer WhatsApp Community. Beim Start werden alle aktuell beteiligten Gruppen über Baileys synchronisiert und neue Gruppen werden automatisch mit aktivierter Bot-Konfiguration angelegt.

- Keine manuelle Aktivierung mit `bot on` nötig.
- Community-Untergruppen werden anhand ihrer Community-Metadaten erkannt.
- Ein Bot kann nicht selbst einer Gruppe beitreten; er muss Mitglied der jeweiligen Gruppe sein.
- `bot off` bleibt als bewusste manuelle Deaktivierung erhalten und verhindert die automatische Reaktivierung.

## Release 3.6.0

Die 3.6.0-Version finalisiert die modulare Architektur:

- Root-Level-Implementierungen wurden entfernt.
- Command-, Moderations-, Datenbank-, Logging-, KI- und Bot-Logik sind über klare `src/`-Boundaries organisiert.
- `app.js` dient ausschließlich als Bootstrap.
- Moderationsfunktionen sind in spezialisierte Services für Warnungen, Bans, Mutes, Spam und Violations aufgeteilt.
- Die README beschreibt jetzt den finalen Stand statt eines laufenden Migrationszustands.
