// Accés al KV "ARTICLES" del worker via wrangler (ja té sessió iniciada en aquest PC).
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ARREL = join(dirname(fileURLToPath(import.meta.url)), '..');
export const WORKER_URL = 'https://noticies.oscarbellosido.workers.dev/';

function wrangler(args) {
  // Els arguments són claus i rutes controlades per nosaltres (sense cometes dins).
  return execSync(['npx wrangler', ...args, '--binding ARTICLES --remote'].join(' '), {
    cwd: ARREL, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function kvGetJson(key, porDefecte = null) {
  const out = wrangler(['kv', 'key', 'get', key]).trim();
  if (!out || out === 'Value not found') return porDefecte;
  return JSON.parse(out);
}

export function kvPutJson(key, value) {
  const tmp = join(ARREL, 'pendents', `.kv-${key}.json`);
  writeFileSync(tmp, JSON.stringify(value));
  try { wrangler(['kv', 'key', 'put', key, '--path', `"${tmp}"`]); }
  finally { unlinkSync(tmp); }
}

// El secret és el mateix que porta INDEX.html (X-App-Secret).
export function appSecret() {
  const html = readFileSync(join(ARREL, 'INDEX.html'), 'utf8');
  return html.match(/const APP_SECRET\s*=\s*'([^']+)'/)?.[1] || '';
}

// Mateixa puntuació que el worker (combinedScore) per ordenar el "top".
export function combinedScore(a) {
  const ageHours = (Date.now() - new Date(a.published_at).getTime()) / 3600000;
  return a.relevance + Math.exp(-ageHours / 4) * 5;
}
