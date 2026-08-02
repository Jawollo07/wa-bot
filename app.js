import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { writeFileSync, readFileSync } from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const parts = ['b64_0.txt', 'b64_1.txt', 'b64_2.txt'].map(f =>
  readFileSync(path.join(__dirname, f), 'utf8')
);
const code = Buffer.from(parts.join(''), 'base64').toString('utf8');
const out = path.join(__dirname, '_app_runtime.js');
writeFileSync(out, code);
await import(pathToFileURL(out).href);
