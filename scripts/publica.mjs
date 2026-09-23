// Fusiona els resums que ha escrit Claude (pendents/resultat*.json) amb els
// articles del KV, igual que feia runFetch() al worker, i els puja.
// Ús: node scripts/publica.mjs [--dry-run]
//   pendents/raw.json          → articles complets (de baixa.mjs)
//   pendents/resultat*.json    → arrays amb els camps de processWithClaude (id, titular_ca, …)
//   pendents/resum_dia.json    → opcional: { "text": "resum narratiu del dia" }
import { existsSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { ARREL, WORKER_URL, appSecret, kvGetJson, kvPutJson } from './kv.mjs';

const MIN_RELEVANCE = 5;
const MAX_ARTICLES  = 500;
const CATEGORIES    = ['Política', 'Economia', 'Tecnologia', 'Internacional', 'Societat', 'Conflicte', 'Esports'];

const DRY = process.argv.includes('--dry-run');
const PENDENTS = join(ARREL, 'pendents');
const llegeix = f => JSON.parse(readFileSync(join(PENDENTS, f), 'utf8'));

if (!existsSync(join(PENDENTS, 'raw.json'))) {
  console.error('No hi ha pendents/raw.json: executa primer node scripts/baixa.mjs');
  process.exit(1);
}
const raw = llegeix('raw.json');
const fitxersResultat = readdirSync(PENDENTS).filter(f => /^resultat.*\.json$/.test(f)).sort();
const processats = fitxersResultat.flatMap(f => {
  const d = llegeix(f);
  return Array.isArray(d) ? d : (d.articles || []);
});

// Mateixa conversió que processWithClaude() (worker.js fins a setembre 2026)
const map = Object.fromEntries(raw.articles.map(a => [a.id, a]));
const ara = new Date().toISOString();
const avisos = [];
const nous = [];
const vistos = new Set();
for (const p of processats) {
  const r = map[p.id];
  if (!r) { avisos.push(`ID desconegut: ${p.id}`); continue; }
  if (vistos.has(p.id)) continue;
  vistos.add(p.id);
  if (!CATEGORIES.includes(p.categoria)) avisos.push(`${p.id}: categoria "${p.categoria}" → Internacional`);
  nous.push({ ...r,
    title_ca:     p.titular_ca || r.title,
    summary_ca:   p.resum_ca   || r.description || '',
    category:     CATEGORIES.includes(p.categoria) ? p.categoria : 'Internacional',
    relevance:    Math.max(1, Math.min(10, Math.round(Number(p.rellevancia)) || 5)),
    is_duplicate: !!p.es_duplicat,
    topic_id:     p.topic_id        || '',
    angle_editorial: p.angle_editorial || '',
    angle_position: typeof p.angle_position === 'number' && !isNaN(p.angle_position)
      ? Math.max(-1, Math.min(1, p.angle_position)) : null,
    processed_at: ara,
  });
}
const sense = raw.articles.filter(a => !vistos.has(a.id));

// Fusió amb el KV (es torna a llegir ara, per no perdre favorits marcats mentrestant)
const articles = kvGetJson('articles', []);
const existents = new Set(articles.map(a => a.id));
let saved = 0;
const candidats = [];
for (const art of nous) {
  if (!art.title_ca || existents.has(art.id)) continue;
  articles.push(art); // també duplicats i poc rellevants: el mapa els fa servir
  if (!art.is_duplicate && art.relevance >= MIN_RELEVANCE) { saved++; candidats.push(art.id); }
}
articles.sort((a, b) => b.published_at.localeCompare(a.published_at));
const trimmed = articles.slice(0, MAX_ARTICLES);

const steps = [
  `Mode local (PC + Claude): ${fitxersResultat.join(', ') || 'cap resultat'}`,
  `RSS: ${raw.rss_total} articles`,
  `Nous: ${raw.articles.length}`,
  `Processats: ${nous.length}, desats (rellevància ≥ ${MIN_RELEVANCE}, no duplicats): ${saved}`,
  ...(sense.length ? [`Sense resum (es tornaran a baixar): ${sense.length}`] : []),
  ...avisos.slice(0, 20),
];
console.log(steps.join('\n'));
console.log(`KV: ${articles.length} → ${trimmed.length} articles`);

let resum = null;
if (existsSync(join(PENDENTS, 'resum_dia.json'))) {
  const r = llegeix('resum_dia.json');
  if (r.text && r.text.trim()) resum = { data: ara.slice(0, 10), text: r.text.trim(), generat_at: ara };
}

if (DRY) { console.log('--dry-run: no s\'ha pujat res.'); process.exit(0); }

kvPutJson('articles', trimmed);
kvPutJson('fetch_debug', { steps });
kvPutJson('fetch_log', {
  fetched_at: ara, articles_fetched: raw.rss_total, articles_saved: saved,
  status: nous.length ? 'ok' : 'no_new', mode: 'local',
});
if (resum) { kvPutJson('resum_dia', resum); console.log('Resum del dia pujat.'); }
console.log('KV actualitzat.');

// Avisos push (paraules clau / rellevància ≥ 9): els envia el worker, que té la clau VAPID
if (candidats.length) {
  try {
    const r = await fetch(`${WORKER_URL}?action=notify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-App-Secret': appSecret() },
      body: JSON.stringify({ ids: candidats }),
      signal: AbortSignal.timeout(60000),
    });
    console.log(`Push: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  } catch (e) {
    console.log(`Push: error ${e.message}`);
  }
}

for (const f of readdirSync(PENDENTS)) if (f.endsWith('.json')) unlinkSync(join(PENDENTS, f));
console.log('Pendents esborrats.');
