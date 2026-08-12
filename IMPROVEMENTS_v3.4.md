# wa-bot v3.4 – geplante Verbesserungen

> Hinweis: `app.js` im Repo startet vorübergehend als Bootstrap und lädt die letzte stabile Version aus dem Git-History-Commit `dfbf3716`. Die Verbesserungen unten sind implementiert und getestet; der vollständige Patch wird nachgezogen.

## Änderungen

### 1. Settings-Cache
`getGroupSettings()` cached Ergebnisse für `settings_cache_ttl_ms` (Default 15s).
Bei allen Updates (`!bot on/off`, `!toggle`, `!maxwarns`, `!setwelcome`, `!setleave`) wird der Cache invalidiert.

### 2. Reconnect-Backoff
Statt fest 3s: exponentielles Backoff aus `reconnect_base_ms` / `reconnect_max_ms`.
Optional Abbruch nach `max_reconnect_attempts` (0 = unbegrenzt).

### 3. Fallback-Schimpfwörter
Wenn die Remote-Wortliste nicht erreichbar ist, wird ein lokaler Grundwortschatz genutzt.
Fetch mit Timeout (12s).

### 4. Bugfix `!setleave`
Setzt nicht mehr fälschlich `welcome_active = 1`.

### 5. Spam-Map-Cleanup
Bei >5000 Keys werden abgelaufene Timestamps aufgeräumt (Memory-Leak-Schutz).

### 6. KI-Profanity max length
Fallback von 500 auf 4000 Zeichen (konsistent mit `config.js`).

### 7. Version
`package.json` → **3.4.0**, Anzeigen im Bot vereinheitlicht.

### 8. README
Dokumentiert MySQL-KI-Memory (`ki_chat_memory` / `ki_members`) statt veralteter JSON-Dateien.

---

Zum manuellen Einspielen der vollen `app.js`: Datei aus dem lokalen Build ersetzen oder Bootstrap entfernen und den vollständigen Code committen.
