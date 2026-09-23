// Baixa les fonts RSS, descarta els articles que ja són al KV i deixa els nous a
// pendents/ perquè Claude els resumeixi (veure CLAUDE.md). Ús: node scripts/baixa.mjs
//   pendents/raw.json  → articles complets (els fa servir publica.mjs)
//   pendents/lot.json  → versió compacta per a Claude + temes existents + top actual
import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyOverrides, fetchAllSources } from '../rss.mjs';
import { ARREL, kvGetJson, combinedScore } from './kv.mjs';

// Articles publicats fa més de 3 dies no cal resumir-los: amb ~150 notícies/dia
// i MAX_ARTICLES=500 quedarien fora del KV de seguida.
const MAX_DIES = 3;

const PENDENTS = join(ARREL, 'pendents');
mkdirSync(PENDENTS, { recursive: true });
for (const f of readdirSync(PENDENTS)) {
  if (f.endsWith('.json')) unlinkSync(join(PENDENTS, f)); // restes d'una execució anterior
}

const existents = kvGetJson('articles', []);
const overrides = kvGetJson('source_url_overrides', {});
const idsExistents = new Set(existents.map(a => a.id));

const raw = await fetchAllSources(applyOverrides(overrides));
const limit = Date.now() - MAX_DIES * 24 * 3600 * 1000;
const nous = raw.filter(a => !idsExistents.has(a.id) && new Date(a.published_at).getTime() >= limit);

// Per fonts, per detectar-ne de caigudes
const perFont = {};
for (const a of raw) perFont[a.source] = (perFont[a.source] || 0) + 1;

writeFileSync(join(PENDENTS, 'raw.json'), JSON.stringify({
  generat_at: new Date().toISOString(), rss_total: raw.length, articles: nous,
}, null, 1));

// Temes (topic_id) dels últims 2 dies, perquè Claude els reutilitzi si és el mateix fet
const tall = new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString().slice(0, 10);
const recents = existents.filter(a => !a.is_duplicate && a.title_ca && (a.published_at || '').slice(0, 10) >= tall);
const temes = {};
for (const a of recents) if (a.topic_id) temes[a.topic_id] = (temes[a.topic_id] || 0) + 1;
const temesExistents = Object.entries(temes).sort((a, b) => b[1] - a[1]).slice(0, 80).map(([t]) => t);

const topActual = [...recents].sort((a, b) => combinedScore(b) - combinedScore(a)).slice(0, 15)
  .map(a => ({ categoria: a.category, rellevancia: a.relevance, titular: a.title_ca, resum: a.summary_ca }));

writeFileSync(join(PENDENTS, 'lot.json'), JSON.stringify({
  generat_at: new Date().toISOString(),
  total: nous.length,
  temes_existents: temesExistents,
  top_actual: topActual,
  articles: nous.map(a => ({
    id: a.id, font: `${a.source} (${a.country})`, titol: a.title, desc: a.description.slice(0, 300),
  })),
}, null, 1));

console.log(`RSS: ${raw.length} articles de ${Object.keys(perFont).length}/27 fonts`);
const mudes = applyOverrides(overrides).map(s => s.name).filter(n => !perFont[n]);
if (mudes.length) console.log(`Fonts sense articles: ${mudes.join(', ')}`);
console.log(`Ja al KV: ${existents.length} · Nous a resumir: ${nous.length} → pendents/lot.json`);
