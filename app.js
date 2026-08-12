import zlib from 'zlib';
import { writeFileSync, existsSync, statSync } from 'fs';
import { pathToFileURL } from 'url';
const B64 = "PLACEHOLDER_WILL_REPLACE";
const target = new URL('.runtime-app.js', import.meta.url);
const p = target.pathname;
if (!existsSync(p) || statSync(p).size < 1000) {
  writeFileSync(p, zlib.gunzipSync(Buffer.from(B64, 'base64')));
}
await import(pathToFileURL(p).href);
