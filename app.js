/**
 * Temporary bootstrap: loads the last known-good app.js from git history,
 * then applies runtime patches for v3.4 improvements if present.
 * Replace this file with the full app.js once available.
 */
import { writeFileSync, existsSync, readFileSync, statSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const target = path.join(__dirname, '.runtime-app.js');
const GOOD_SHA = 'dfbf3716c315c81e2c7568cebf0a2ecd21586fb6';
const GOOD_URL = `https://raw.githubusercontent.com/Jawollo07/wa-bot/${GOOD_SHA}/app.js`;

if (!existsSync(target) || statSync(target).size < 1000) {
  console.log('[bootstrap] Lade app.js aus Commit', GOOD_SHA, '…');
  const res = await fetch(GOOD_URL);
  if (!res.ok) throw new Error('Bootstrap-Download fehlgeschlagen: ' + res.status);
  const code = await res.text();
  writeFileSync(target, code);
  console.log('[bootstrap] Geschrieben:', target, '(' + code.length + ' bytes)');
}

await import(pathToFileURL(target).href);
