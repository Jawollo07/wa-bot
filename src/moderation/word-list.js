import { dbPool } from '../database/index.js';
import { CONFIG } from '../config/app.js';
import * as profanity from './profanity.js';
import log from '../core/logger.js';

export async function reloadBadWordsCache() {
  const [rows] = await dbPool.query('SELECT word FROM bad_words');
  const words = rows.map((r) => r.word);
  profanity.setWordList(words);
  log('✅ ' + words.length + ' Schimpfwörter geladen (Index: ' + profanity.getIndexSize() + ' Formen).');
  return words;
}

export async function syncAndLoadBadWords() {
  log('🔄 Synchronisiere Schimpfwörter...');
  const wordsSet = new Set();
  for (const url of CONFIG.wordUrls || []) {
    try {
      const response = await fetch(url);
      if (!response.ok) continue;
      const data = await response.json();
      const rawWords = Array.isArray(data) ? data : (typeof data === 'object' ? Object.values(data).flat() : []);
      for (const word of rawWords) {
        if (typeof word === 'string' && word.trim().length > 1) wordsSet.add(word.trim().toLowerCase());
      }
    } catch (error) {
      log('⚠️ Schimpfwort-Quelle nicht erreichbar: ' + (error.message || error));
    }
  }

  if (wordsSet.size) {
    const connection = await dbPool.getConnection();
    try {
      await connection.beginTransaction();
      for (const word of wordsSet) await connection.query('INSERT IGNORE INTO bad_words (word) VALUES (?)', [word]);
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }
  return reloadBadWordsCache();
}
