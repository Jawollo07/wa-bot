import 'dotenv/config';

import fs from 'fs';
import { getAuthDir, initBotConfig, getKiSettingsFromDb } from './src/config/runtime.js';
import { initializeDatabase } from './src/database/index.js';
import { log, logAction } from './src/logging/index.js';
import { applyKiConfig, initKiDb, checkOllama, getKiConfig } from './src/ki/index.js';
import { syncAndLoadBadWords } from './src/moderation/word-list.js';
import startSocket from './src/bot/index.js';

const SYSTEM_GROUP = 'SYSTEM';

process.on('unhandledRejection', (reason) => console.error('[unhandledRejection]', reason));
process.on('uncaughtException', (error) => console.error('[uncaughtException]', error));

async function bootstrap() {
  try {
    const authDir = getAuthDir();
    if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

    const dbPool = await initializeDatabase();
    await initBotConfig(dbPool);
    applyKiConfig(getKiSettingsFromDb());
    await initKiDb(dbPool);

    await logAction(SYSTEM_GROUP, 'bot', 'BOT_START', 'Bot startet', 'system');
    await syncAndLoadBadWords();

    const kiConfig = getKiConfig();
    if (kiConfig.enabled) {
      const info = await checkOllama();
      if (info.ok) {
        log('🤖 Ollama OK – Host: ' + info.host + ' | Modell: ' + info.model);
      } else {
        log('⚠️ Ollama nicht erreichbar (' + info.host + '): ' + (info.error || 'offline'));
      }
    }

    await startSocket();
  } catch (error) {
    console.error('❌ Start fehlgeschlagen:', error);
    try {
      await logAction(SYSTEM_GROUP, 'bot', 'BOT_START_FAIL', error.message || String(error), 'system');
    } catch (_) {}
    process.exitCode = 1;
  }
}

bootstrap();
