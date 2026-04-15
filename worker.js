// ══════════════════════════════════════════════════════════════════════════
//  NOTICIES EN CATALÀ — Cloudflare Worker
//  Mateix patró que worker.js de MecAI
//
//  Configuració:
//    wrangler secret put API_KEY        → la teva clau Anthropic
//    wrangler kv:namespace create ARTICLES → afegeix l'ID a wrangler.toml
//
//  wrangler.toml mínim:
//    name = "noticies"
//    compatibility_date = "2024-01-01"
//    [[kv_namespaces]]
//    binding = "ARTICLES"
//    id = "EL_TEU_KV_ID"
//    [triggers]
//    crons = ["0 4,12,18 * * *"]   # 06h, 14h, 20h hora Madrid
// ══════════════════════════════════════════════════════════════════════════

const MODEL               = 'claude-haiku-4-5';
// AI Gateway URL — evita el bloqueig de Cloudflare Workers → api.anthropic.com
// Crea el gateway a: Cloudflare Dashboard → AI → AI Gateway → "noticies-gw"
const CF_ACCOUNT_ID       = '06ae974d240fa2b27e2da3fcd783a8c9';
const AI_GATEWAY_SLUG     = 'noticies-gw';
const ANTHROPIC_URL       = `https://gateway.ai.cloudflare.com/v1/${CF_ACCOUNT_ID}/${AI_GATEWAY_SLUG}/anthropic/v1/messages`;
const FETCH_INTERVAL_HOURS = 6;
const MAX_PER_SOURCE      = 8;
const MIN_RELEVANCE       = 5;
const MAX_ARTICLES        = 500;

const RSS_SOURCES = [
  { name:'BBC News',      url:'http://feeds.bbci.co.uk/news/world/rss.xml',                       country:'UK', lang:'en' },
  { name:'The Guardian',  url:'https://www.theguardian.com/world/rss',                            country:'UK', lang:'en' },
  { name:'Reuters',       url:'https://feeds.reuters.com/reuters/worldNews',                       country:'US', lang:'en' },
  { name:'AP News',       url:'https://feeds.apnews.com/rss/apf-topnews',                         country:'US', lang:'en' },
  { name:'Le Monde',      url:'https://www.lemonde.fr/rss/une.xml',                               country:'FR', lang:'fr' },
  { name:'Le Figaro',     url:'https://www.lefigaro.fr/rss/figaro_actualites.xml',                country:'FR', lang:'fr' },
  { name:'DW News',       url:'https://rss.dw.com/rdf/rss-en-world',                              country:'DE', lang:'en' },
  { name:'Politico EU',   url:'https://rss.politico.eu/europe/rss.xml',                           country:'EU', lang:'en' },
  { name:'EUobserver',    url:'https://euobserver.com/rss.xml',                                   country:'EU', lang:'en' },
  { name:'El País',         url:'https://feeds.elpais.com/mrss-s/pages/ep/site/elpais.com/portada', country:'ES', lang:'es' },
  { name:'La Vanguardia',  url:'https://www.lavanguardia.com/mvc/feed/rss/home',                   country:'ES', lang:'es' },
  { name:'Financial Times', url:'https://www.ft.com/rss/home',                                     country:'UK', lang:'en' },
  { name:'ARA',             url:'https://www.ara.cat/rss/portada.xml',                             country:'ES', lang:'ca' },
  { name:'Al Jazeera',      url:'https://www.aljazeera.com/xml/rss/all.xml',                        country:'QA', lang:'en' },
  { name:'Middle East Eye', url:'https://www.middleeasteye.net/rss',                                country:'ME', lang:'en' },
  { name:'NYT World',       url:'https://rss.nytimes.com/services/xml/rss/nf/World.xml',            country:'US', lang:'en' },
  { name:'WPost World',     url:'https://feeds.washingtonpost.com/rss/world',                       country:'US', lang:'en' },
  { name:'Der Spiegel',     url:'https://www.spiegel.de/international/index.rss',                   country:'DE', lang:'en' },
  { name:'SCMP',            url:'https://www.scmp.com/rss/91/feed',                                 country:'HK', lang:'en' },
  { name:'VilaWeb',         url:'https://www.vilaweb.cat/rss.xml',                                  country:'CA', lang:'ca' },
];

// ── Helpers CORS ──────────────────────────────────────────────────────────
const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type':                 'application/json; charset=utf-8',
};
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: CORS });

// ══════════════════════════════════════════════════════════════════════════
export default {

  // ── HTTP requests ────────────────────────────────────────────────────────
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const url    = new URL(request.url);
    const action = url.searchParams.get('action') || 'news';

    switch (action) {
      case 'news':       return handleGetNews(url, env);
      case 'top':        return handleGetTop(url, env);
      case 'fetch':      return handleFetch(env, ctx);
      case 'stats':      return handleStats(env);
      case 'favorite':   return handleFavorite(request, env);
      case 'favorites':  return handleFavorites(env);
      case 'categories': return json({ categories: CATEGORIES });
      case 'countries':  return json({ countries: COUNTRIES });
      case 'debug':      return handleDebug(env);
      case 'fetchlog':   return json(JSON.parse(await env.ARTICLES.get('fetch_debug') || 'null'));
      case 'clearlock':  await env.ARTICLES.delete('fetch_lock'); return json({ ok: true });
      case 'claude':     return handleClaude(request, env);
      case 'map':          return handleMap(env);
      case 'perspectives': return handlePerspectives(env);
      default:             return json({ error: 'Unknown action' }, 400);
    }
  },

  // ── Cron trigger (cada 3 hores) ──────────────────────────────────────────
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runFetch(env));
  },
};

// ══════════════════════════════════════════════════════════════════════════
//  HANDLERS
// ══════════════════════════════════════════════════════════════════════════

function combinedScore(article) {
  const ageHours = (Date.now() - new Date(article.published_at).getTime()) / 3600000;
  const decay = Math.max(0, 1 - ageHours / 48); // perd tot el bonus als 2 dies
  return article.relevance + (decay * 3); // bonus màxim de +3 per notícies fresques
}

async function handleGetNews(url, env) {
  const articles = await loadArticles(env);
  const cat    = url.searchParams.get('category') || '';
  const cntry  = url.searchParams.get('country')  || '';
  const search = (url.searchParams.get('search')  || '').toLowerCase();
  const limit  = Math.min(200, Math.max(1, parseInt(url.searchParams.get('limit')  || '50')));
  const offset = Math.max(0,               parseInt(url.searchParams.get('offset') || '0'));
  const minRel = Math.max(1,               parseInt(url.searchParams.get('min_relevance') || '1'));

  let filtered = articles.filter(a => {
    if (a.is_duplicate)  return false;
    if (!a.title_ca)     return false;
    if (a.relevance < minRel) return false;
    if (cat   && a.category !== cat)   return false;
    if (cntry && a.country  !== cntry) return false;
    if (search) {
      const hay = ((a.title_ca||'')+(a.summary_ca||'')).toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });

  filtered.sort((a, b) => combinedScore(b) - combinedScore(a));
  return json({ articles: filtered.slice(offset, offset + limit), total: filtered.length });
}

async function handleGetTop(url, env) {
  const articles = await loadArticles(env);
  const limit  = Math.min(30, Math.max(1, parseInt(url.searchParams.get('limit') || '10')));
  const cutoff = new Date(Date.now() - 2*24*3600*1000).toISOString().slice(0,10);

  let filtered = articles.filter(a =>
    !a.is_duplicate && a.title_ca && (a.published_at||'').slice(0,10) >= cutoff
  );
  filtered.sort((a, b) => combinedScore(b) - combinedScore(a));
  return json({ articles: filtered.slice(0, limit) });
}

async function handleFetch(env, ctx) {
  // Comprova lock
  const lock = await env.ARTICLES.get('fetch_lock');
  if (lock && (Date.now() - parseInt(lock)) < 600_000) {
    return json({ status: 'already_running' });
  }
  await env.ARTICLES.put('fetch_lock', String(Date.now()), { expirationTtl: 600 });

  // Executa síncronament (ctx.waitUntil causa problemes de xarxa des de CF Workers)
  try {
    await runFetch(env);
    return json({ status: 'done' });
  } catch(e) {
    await env.ARTICLES.put('fetch_debug', JSON.stringify({ error: e.message, stack: e.stack }));
    await env.ARTICLES.delete('fetch_lock');
    return json({ status: 'error', error: e.message });
  }
}

async function runFetch(env) {
  const log = { steps: [] };

  // 1. Obtenir RSS
  const raw = await fetchAllRSS();
  log.steps.push(`RSS: ${raw.length} articles`);

  // 2. Filtrar nous
  const articles    = await loadArticles(env);
  const existingIds = new Set(articles.map(a => a.id));
  const newArts     = raw.filter(a => !existingIds.has(a.id));
  log.steps.push(`Nous: ${newArts.length}`);

  if (!newArts.length) {
    await saveFetchLog(env, raw.length, 0, 'no_new');
    await env.ARTICLES.delete('fetch_lock');
    return;
  }

  // 3. Processar amb Claude en lots petits
  let saved = 0;
  const batches = chunkArray(newArts, 5);
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    try {
      const processed = await processWithClaude(batch, env.API_KEY);
      let batchSaved = 0;
      for (const art of processed) {
        if (!art.title_ca) continue;
        // Guardem tots els articles (incl. duplicats) per tenir dades geogràfiques al mapa
        // Però només comptem com a "guardats" els que superen el llindar de rellevància
        articles.push(art);
        if (!art.is_duplicate && art.relevance >= MIN_RELEVANCE) {
          saved++;
          batchSaved++;
        }
      }
      log.steps.push(`Lot ${i+1}/${batches.length}: ${processed.length} processats, ${batchSaved} desats`);
    } catch(e) {
      log.steps.push(`Lot ${i+1} ERROR: ${e.message}`);
    }
  }

  // 4. Limitar a MAX_ARTICLES
  articles.sort((a,b) => b.published_at.localeCompare(a.published_at));
  const trimmed = articles.slice(0, MAX_ARTICLES);

  await saveArticles(env, trimmed);
  await env.ARTICLES.put('fetch_debug', JSON.stringify(log));
  await saveFetchLog(env, raw.length, saved, 'ok');
  await env.ARTICLES.delete('fetch_lock');
}

async function handleStats(env) {
  const articles = await loadArticles(env);
  const log      = JSON.parse(await env.ARTICLES.get('fetch_log') || 'null');
  const byCategory = {}, byCountry = {};
  let total = 0;

  for (const a of articles) {
    if (!a.is_duplicate && a.title_ca) {
      total++;
      byCategory[a.category||'Internacional'] = (byCategory[a.category||'Internacional']||0)+1;
      byCountry[a.country||'INT']             = (byCountry[a.country||'INT']||0)+1;
    }
  }
  const lock = await env.ARTICLES.get('fetch_lock');
  return json({ total_articles: total, by_category: byCategory, by_country: byCountry,
                last_fetch: log, is_fetching: !!lock });
}

async function handleFavorite(request, env) {
  const body = await request.json().catch(() => ({}));
  const id   = body.id;
  if (!id) return json({ error: 'id requerit' }, 400);

  const articles = await loadArticles(env);
  const art      = articles.find(a => a.id === id);
  if (!art) return json({ error: 'Article no trobat' }, 404);

  art.is_favorite = !art.is_favorite;
  await saveArticles(env, articles);
  return json({ is_favorite: art.is_favorite });
}

async function handleFavorites(env) {
  const favs = (await loadArticles(env)).filter(a => a.is_favorite);
  favs.sort((a,b) => b.published_at.localeCompare(a.published_at));
  return json({ articles: favs });
}

async function handleMap(env) {
  const articles = await loadArticles(env);
  // Agrupa per país incloent duplicats (per mostrar d'on vénen les notícies)
  const byCountry = {};
  for (const a of articles) {
    if (!a.title_ca) continue;
    if (!byCountry[a.country]) byCountry[a.country] = [];
    byCountry[a.country].push({
      id: a.id, title_ca: a.title_ca, category: a.category,
      relevance: a.relevance, source: a.source, url: a.url,
    });
  }
  // Ordena per rellevància dins de cada país
  for (const c of Object.values(byCountry)) {
    c.sort((a,b) => (b.relevance||0)-(a.relevance||0));
  }
  return json({ by_country: byCountry });
}

async function handleClaude(request, env) {
  if (request.method !== 'POST') return json({ error: 'POST required' }, 405);
  const body = await request.json();
  const resp = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': env.API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model:      body.model      || MODEL,
      max_tokens: body.max_tokens || 1024,
      system:     body.system     || '',
      messages:   body.messages,
    }),
    signal: AbortSignal.timeout(60000),
  });
  const data = await resp.json();
  return new Response(JSON.stringify(data), { status: resp.status, headers: CORS });
}

async function handleDebug(env) {
  try {
    // Agafa 2 articles reals i prova processWithClaude
    const raw = await fetchAllRSS();
    const batch = raw.slice(0, 2);
    const result = await processWithClaude(batch, env.API_KEY);
    return json({ articles_fetched: raw.length, batch_sent: batch.map(a=>({id:a.id,title:a.title})), articles_processed: result });
  } catch(e) {
    return json({ error: e.message });
  }
}

// ══════════════════════════════════════════════════════════════════════════
//  RSS FETCHING
// ══════════════════════════════════════════════════════════════════════════

function makeId(url) {
  let hash = 0;
  for (let i=0; i<url.length; i++) hash = ((hash<<5)-hash)+url.charCodeAt(i), hash|=0;
  return Math.abs(hash).toString(16).padStart(8,'0') + url.length.toString(16);
}

function cleanText(t) {
  return (t||'').replace(/<[^>]+>/g,' ').replace(/&[a-z]+;/gi,' ')
                .replace(/\s+/g,' ').trim().slice(0, 600);
}

async function fetchRssSource(source) {
  try {
    const r = await fetch(source.url, { headers:{ 'User-Agent':'NewsAggregator/1.0' }, signal: AbortSignal.timeout(12000) });
    const xml = await r.text();
    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>|<entry>([\s\S]*?)<\/entry>/g)];
    const arts  = [];

    for (const m of items.slice(0, MAX_PER_SOURCE)) {
      const block = m[1] || m[2];
      const url   = (block.match(/<link[^>]*>([^<]+)<\/link>/) || block.match(/href="([^"]+)"/))?.[1]?.trim() || '';
      const title = cleanText((block.match(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/)?.[1]||''));
      const desc  = cleanText((block.match(/<description[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/)?.[1]
                            || block.match(/<summary[^>]*>([\s\S]*?)<\/summary>/)?.[1] || ''));
      if (!url || title.length < 10) continue;

      const dateStr = (block.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/)?.[1]
                    || block.match(/<published[^>]*>([\s\S]*?)<\/published>/)?.[1] || '').trim();
      const ts   = dateStr ? new Date(dateStr).getTime() : Date.now();
      const pubAt = new Date(ts||Date.now()).toISOString();

      arts.push({ id:makeId(url), title, description:desc, url, source:source.name, country:source.country,
                  lang:source.lang, published_at:pubAt, is_duplicate:false, is_favorite:false });
    }
    return arts;
  } catch { return []; }
}

async function fetchAllRSS() {
  const results = await Promise.allSettled(RSS_SOURCES.map(s => fetchRssSource(s)));
  const all = [], seen = new Set();
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    for (const a of r.value) {
      if (!seen.has(a.id)) { seen.add(a.id); all.push(a); }
    }
  }
  return all;
}

// ══════════════════════════════════════════════════════════════════════════
//  CLAUDE AI PROCESSING
// ══════════════════════════════════════════════════════════════════════════

async function processWithClaude(batch, apiKey) {
  const system = `Ets un editor de notícies professional i traductor expert en català.
Per cada article retorna un objecte JSON amb exactament aquests camps:
- id: el mateix ID rebut (OBLIGATORI, no el canviïs)
- titular_ca: títol en català concís
- resum_ca: resum en català de 4-6 línies
- categoria: una de Política/Economia/Tecnologia/Internacional/Societat/Conflicte
- rellevancia: enter 1-10
- es_duplicat: true si és molt similar a un altre article del lot
- topic_id: cadena curta en anglès kebab-case que identifica el tema principal (ex: "gaza-ceasefire", "trump-tariffs", "ukraine-war", "climate-summit"). Articles sobre el MATEIX fet real han de tenir EXACTAMENT el MATEIX topic_id
Respon ÚNICAMENT amb un array JSON vàlid. Cap text fora del JSON.`;

  const lines = batch.map(a =>
    `ID: ${a.id}\nFont: ${a.source} (${a.country})\nTítol: ${a.title}\nDesc: ${a.description.slice(0,300)}`
  ).join('\n---\n');

  const user = `Processa ${batch.length} articles:\n\n${lines}`;

  const resp = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: { 'Content-Type':'application/json', 'x-api-key':apiKey, 'anthropic-version':'2023-06-01' },
    body: JSON.stringify({ model:MODEL, max_tokens:4096, system, messages:[{role:'user',content:user}] }),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '(no body)');
    throw new Error(`HTTP ${resp.status}: ${errText.slice(0, 200)}`);
  }
  const data = await resp.json();
  const text = (data.content||[]).find(b=>b.type==='text')?.text || '';
  if (!text) return [];

  const s = text.indexOf('['), e = text.lastIndexOf(']');
  if (s<0||e<0) return [];
  const processed = JSON.parse(text.slice(s, e+1));
  if (!Array.isArray(processed)) return [];

  const map = Object.fromEntries(batch.map(a=>[a.id,a]));
  return processed.flatMap(p => {
    const raw = map[p.id];
    if (!raw) return [];
    return [{ ...raw,
      title_ca:    p.titular_ca || raw.title,
      summary_ca:  p.resum_ca   || '',
      category:    p.categoria  || 'Internacional',
      relevance:   Math.max(1, Math.min(10, p.rellevancia||5)),
      is_duplicate: !!p.es_duplicat,
      topic_id:    p.topic_id   || '',
      processed_at: new Date().toISOString(),
    }];
  });
}

async function handlePerspectives(env) {
  const articles = await loadArticles(env);
  const groups = {};

  for (const a of articles) {
    if (!a.title_ca || a.is_duplicate || !a.topic_id) continue;
    if (!groups[a.topic_id]) groups[a.topic_id] = [];
    groups[a.topic_id].push(a);
  }

  const result = Object.entries(groups)
    .filter(([, arts]) => new Set(arts.map(a => a.source)).size >= 2)
    .map(([topic_id, arts]) => ({ topic_id, articles: arts }))
    .sort((a, b) => {
      const sA = new Set(a.articles.map(x => x.source)).size;
      const sB = new Set(b.articles.map(x => x.source)).size;
      return sB - sA;
    })
    .slice(0, 15);

  return json({ groups: result });
}

// ══════════════════════════════════════════════════════════════════════════
//  KV STORAGE
// ══════════════════════════════════════════════════════════════════════════
async function loadArticles(env) {
  const raw = await env.ARTICLES.get('articles');
  return raw ? JSON.parse(raw) : [];
}
async function saveArticles(env, articles) {
  await env.ARTICLES.put('articles', JSON.stringify(articles));
}
async function saveFetchLog(env, fetched, saved, status) {
  await env.ARTICLES.put('fetch_log', JSON.stringify({
    fetched_at: new Date().toISOString(), articles_fetched:fetched, articles_saved:saved, status
  }));
}

// ── Utils ─────────────────────────────────────────────────────────────────
function chunkArray(arr, size) {
  const chunks = [];
  for (let i=0; i<arr.length; i+=size) chunks.push(arr.slice(i,i+size));
  return chunks;
}

const CATEGORIES = [
  {id:'Política',label:'Política',icon:'🏛️'}, {id:'Economia',label:'Economia',icon:'📈'},
  {id:'Tecnologia',label:'Tecnologia',icon:'💻'}, {id:'Internacional',label:'Internacional',icon:'🌍'},
  {id:'Societat',label:'Societat',icon:'👥'}, {id:'Conflicte',label:'Conflicte',icon:'⚔️'},
];
const COUNTRIES = [
  {id:'UK',label:'Regne Unit 🇬🇧'},{id:'US',label:'EUA 🇺🇸'},{id:'FR',label:'França 🇫🇷'},
  {id:'DE',label:'Alemanya 🇩🇪'},{id:'EU',label:'Unió Europea 🇪🇺'},{id:'ES',label:'Espanya 🇪🇸'},
];
