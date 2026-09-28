// Accés al KV "ARTICLES" del worker via wrangler (ja té sessió iniciada en aquest PC).
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ARREL = join(dirname(fileURLToPath(import.meta.url)), '..');
export const WORKER_URL = 'https://noticies.oscarbellosido.workers.dev/';

function wranglerUnCop(cmd) {
  return execSync(cmd, {
    cwd: ARREL, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function wrangler(args) {
  // Els arguments són claus i rutes controlades per nosaltres (sense cometes dins).
  const cmd = ['npx wrangler', ...args, '--binding ARTICLES --remote'].join(' ');
  try {
    return wranglerUnCop(cmd);
  } catch (e) {
    // El token OAuth de wrangler caduca; 'whoami' el renova amb el refresh token. Un sol reintent.
    console.log(`wrangler ha fallat (${String(e.stderr || e.message).split('\n').find(l => l.trim()) || 'error'}); renovo la sessió i ho torno a provar…`);
    try { wranglerUnCop('npx wrangler whoami'); } catch { /* si no hi ha sessió, el reintent fallarà amb el missatge real */ }
    try {
      return wranglerUnCop(cmd);
    } catch (e2) {
      throw new Error(`wrangler continua fallant. Cal obrir una consola a la carpeta Noticies i executar: npx wrangler login\n${e2.stderr || e2.message}`);
    }
  }
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
