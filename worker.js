// ══════════════════════════════════════════════════════════════════════════
//  NOTICIES EN CATALÀ — Cloudflare Worker
//  Mateix patró que worker.js de MecAI
//
//  Configuració:
//    wrangler secret put API_KEY          → la teva clau Anthropic
//    wrangler secret put APP_SECRET       → secret compartit amb INDEX.html (veure APP_SECRET allà)
//    wrangler secret put VAPID_PRIVATE_JWK → JSON de la clau privada VAPID (Web Push), veure gen_vapid.js
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

// Web Push (notificacions) — clau pública VAPID (no és secreta, ha de coincidir
// amb la constant VAPID_PUBLIC_KEY d'INDEX.html). La privada viu a env.VAPID_PRIVATE_JWK.
const VAPID_PUBLIC_KEY    = 'BM2P6l00GxYKXUEgPR7z4SQJaO8efBhJIfiIYXlGRfmert28xqmd8EQxGbjLL-TEOPnZLO-T4wU3vW4_t0x7aZQ';
const VAPID_SUBJECT       = 'https://oscarbellosido.github.io/Noticies/';
const PUSH_MIN_RELEVANCE  = 9; // notifica encara que no coincideixi amb cap paraula clau
const APP_URL             = 'https://39699323.servicio-online.net/Noti/INDEX.html';

const RSS_SOURCES = [
  { name:'BBC News',      url:'http://feeds.bbci.co.uk/news/world/rss.xml',                       country:'UK', lang:'en' },
  { name:'The Guardian',  url:'https://www.theguardian.com/world/rss',                            country:'UK', lang:'en' },
  { name:'Euronews',      url:'https://www.euronews.com/rss',                                     country:'EU', lang:'en' }, // substitueix Reuters (RSS retirat, ara de pagament)
  { name:'Sky News',      url:'https://feeds.skynews.com/feeds/rss/world.xml',                    country:'UK', lang:'en' }, // substitueix AP News (RSS públic retirat)
  { name:'Le Monde',      url:'https://www.lemonde.fr/rss/une.xml',                               country:'FR', lang:'fr' },
  { name:'France 24',     url:'https://www.france24.com/en/rss',                                  country:'FR', lang:'en' }, // substitueix Le Figaro (bloqueja bots amb 403)
  { name:'DW News',       url:'https://rss.dw.com/xml/rss-en-all',                                country:'DE', lang:'en' },
  { name:'Politico EU',   url:'https://www.politico.eu/feed/',                                    country:'EU', lang:'en' },
  { name:'EUobserver',    url:'https://euobserver.com/feed/',                                     country:'EU', lang:'en' },
  { name:'El País',         url:'https://feeds.elpais.com/mrss-s/pages/ep/site/elpais.com/portada', country:'ES', lang:'es' },
  { name:'La Vanguardia',  url:'https://www.lavanguardia.com/rss/home.xml',                        country:'ES', lang:'es' },
  { name:'Financial Times', url:'https://www.ft.com/rss/home',                                     country:'UK', lang:'en' },
  { name:'ARA',             url:'https://www.ara.cat/rss/latest/',                                 country:'CA', lang:'ca' },
  { name:'Al Jazeera',      url:'https://www.aljazeera.com/xml/rss/all.xml',                        country:'QA', lang:'en' },
  { name:'Middle East Eye', url:'https://www.middleeasteye.net/rss',                                country:'ME', lang:'en' },
  { name:'NYT World',       url:'https://rss.nytimes.com/services/xml/rss/nyt/World.xml',           country:'US', lang:'en' },
  { name:'WPost World',     url:'https://feeds.washingtonpost.com/rss/world',                       country:'US', lang:'en' },
  { name:'Der Spiegel',     url:'https://www.spiegel.de/international/index.rss',                   country:'DE', lang:'en' },
  { name:'SCMP',            url:'https://www.scmp.com/rss/91/feed',                                 country:'HK', lang:'en' },
  { name:'VilaWeb',         url:'https://www.vilaweb.cat/feed/',                                    country:'CA', lang:'ca' },
  { name:'Xataka',          url:'https://feeds.weblogssl.com/xataka2',                                country:'ES', lang:'es' },
  { name:'The Verge',       url:'https://www.theverge.com/rss/index.xml',                             country:'US', lang:'en' },
  { name:'Ars Technica',    url:'https://feeds.arstechnica.com/arstechnica/index',                    country:'US', lang:'en' },
  { name:'Wired',           url:'https://www.wired.com/feed/rss',                                     country:'US', lang:'en' },
  { name:'Marca',           url:'https://e00-marca.uecdn.es/rss/portada.xml',                         country:'ES', lang:'es' },
  { name:'Mundo Deportivo', url:'https://www.mundodeportivo.com/rss/home.xml',                        country:'ES', lang:'es' }, // substitueix AS (bloqueja bots amb 403)
  { name:'BBC Sport',       url:'https://feeds.bbci.co.uk/sport/rss.xml',                             country:'UK', lang:'en' },
];

// ── Helpers CORS ──────────────────────────────────────────────────────────
const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-App-Secret',
  'Content-Type':                 'application/json; charset=utf-8',
};
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: CORS });

// ══════════════════════════════════════════════════════════════════════════
// Accions que costen tokens de Claude, alteren l'estat del fetch, o toquen dades
// personals (subscripcions push, paraules clau d'alerta): cal secret.
const PROTECTED_ACTIONS = new Set([
  'claude', 'fetch', 'debug', 'clearlock',
  'push_subscribe', 'push_unsubscribe', 'alerts',
  'sources_health', 'check_sources',
]);

function isAuthorized(request, env) {
  if (!env.APP_SECRET) return true; // secret no configurat encara: no bloquejar-se fora
  return request.headers.get('X-App-Secret') === env.APP_SECRET;
}

export default {

  // ── HTTP requests ────────────────────────────────────────────────────────
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const url    = new URL(request.url);
    const action = url.searchParams.get('action') || 'news';

    if (PROTECTED_ACTIONS.has(action) && !isAuthorized(request, env)) {
      return json({ error: 'Unauthorized' }, 401);
    }

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
      case 'push_subscribe':   return handlePushSubscribe(request, env);
      case 'push_unsubscribe': return handlePushUnsubscribe(request, env);
      case 'alerts':            return handleAlerts(request, env);
      case 'sources_health':    return json(JSON.parse(await env.ARTICLES.get('source_health_report') || 'null'));
      case 'check_sources':     return handleCheckSources(env);
      default:             return json({ error: 'Unknown action' }, 400);
    }
  },

  // ── Cron trigger: fetch cada 6h (04,12,18h UTC); revisió de fonts el dia 1 de cada mes ──
  async scheduled(event, env, ctx) {
    if (event.cron === '0 5 1 * *') {
      ctx.waitUntil(runSourceHealthCheck(env));
    } else {
      ctx.waitUntil(runFetch(env));
    }
  },
};

// ══════════════════════════════════════════════════════════════════════════
//  HANDLERS
// ══════════════════════════════════════════════════════════════════════════

function combinedScore(article) {
  const ageHours = (Date.now() - new Date(article.published_at).getTime()) / 3600000;
  return article.relevance + Math.exp(-ageHours / 4) * 5;
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

const LOCK_MAX_AGE_MS = 15 * 60 * 1000; // 15 minuts — passat aquest temps, el lock es considera stale

async function handleFetch(env, ctx) {
  // Comprova lock (ignora/elimina si porta més de 15 min actiu, es considera stale)
  const lock    = await env.ARTICLES.get('fetch_lock');
  const lockAge = lock ? Date.now() - parseInt(lock, 10) : Infinity;
  if (lock && Number.isFinite(lockAge) && lockAge < LOCK_MAX_AGE_MS) {
    return json({ status: 'already_running' });
  }
  if (lock) await env.ARTICLES.delete('fetch_lock');
  await env.ARTICLES.put('fetch_lock', String(Date.now()), { expirationTtl: LOCK_MAX_AGE_MS / 1000 });

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
  const raw = await fetchAllRSS(env);
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
  const notifyCandidates = [];
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
          notifyCandidates.push(art);
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

  // 5. Notificacions push (paraula clau o rellevància molt alta)
  try {
    await notifyPush(env, notifyCandidates);
  } catch(e) {
    await env.ARTICLES.put('push_debug', JSON.stringify({ error: e.message, stack: e.stack }));
  }
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
    const raw = await fetchAllRSS(env);
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
      const rawDescBlock = block.match(/<description[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/)?.[1]
                        || block.match(/<summary[^>]*>([\s\S]*?)<\/summary>/)?.[1] || '';
      const desc  = cleanText(rawDescBlock);
      if (!url || title.length < 10) continue;

      const rawContent = block.match(/<content:encoded[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/content:encoded>/)?.[1] || '';
      const image_url =
        block.match(/<media:content[^>]+url="([^"]+)"/)?.[1] ||
        block.match(/<media:thumbnail[^>]+url="([^"]+)"/)?.[1] ||
        block.match(/<enclosure[^>]+type="image\/[^"]*"[^>]+url="([^"]+)"/)?.[1] ||
        block.match(/<enclosure[^>]+url="([^"]+)"[^>]+type="image\/[^"]*"/)?.[1] ||
        (rawDescBlock + rawContent).match(/<img[^>]+src="([^"]+)"/)?.[1] ||
        '';

      const dateStr = (block.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/)?.[1]
                    || block.match(/<published[^>]*>([\s\S]*?)<\/published>/)?.[1] || '').trim();
      const ts   = dateStr ? new Date(dateStr).getTime() : Date.now();
      const pubAt = new Date(ts||Date.now()).toISOString();

      arts.push({ id:makeId(url), title, description:desc, url, source:source.name, country:source.country,
                  lang:source.lang, published_at:pubAt, is_duplicate:false, is_favorite:false, image_url });
    }
    return arts;
  } catch { return []; }
}

// Aplica les URLs corregides automàticament per la revisió mensual de fonts
// (KV `source_url_overrides`), sense necessitat de tocar RSS_SOURCES ni desplegar.
async function effectiveSources(env) {
  const raw = await env.ARTICLES.get('source_url_overrides');
  const overrides = raw ? JSON.parse(raw) : {};
  return RSS_SOURCES.map(s => overrides[s.name] ? { ...s, url: overrides[s.name] } : s);
}

async function fetchAllRSS(env) {
  const sources = await effectiveSources(env);
  const results = await Promise.allSettled(sources.map(s => fetchRssSource(s)));
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
//  REVISIÓ MENSUAL DE FONTS — detecta URLs RSS trencades (canvi de ruta, feed
//  retirat) i intenta trobar-ne la substituta automàticament a partir de la
//  pàgina principal del mateix lloc. Els arranjaments es guarden a KV
//  (`source_url_overrides`) i s'apliquen a l'instant, sense tocar el codi.
//
//  Límit real: això només arregla "URL rot" (la ruta ha canviat però el lloc
//  encara ofereix RSS). NO pot saltar-se un bloqueig anti-bot real (WAF/403 a
//  tot el lloc) ni un feed retirat sense substitut RSS — en aquests casos
//  només ho reporta perquè algú triï una font alternativa manualment.
// ══════════════════════════════════════════════════════════════════════════

async function testFeedUrl(url) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'NewsAggregator/1.0' }, redirect: 'follow', signal: AbortSignal.timeout(12000) });
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    const text = await r.text();
    const items = (text.match(/<item[ >]/g) || []).length + (text.match(/<entry[ >]/g) || []).length;
    return { ok: items > 0, items, error: items > 0 ? null : 'resposta sense <item>' };
  } catch (e) {
    return { ok: false, items: 0, error: e.message };
  }
}

async function discoverFeedUrl(brokenUrl) {
  try {
    const origin = new URL(brokenUrl).origin;
    const r = await fetch(origin + '/', { headers: { 'User-Agent': 'Mozilla/5.0' }, redirect: 'follow', signal: AbortSignal.timeout(12000) });
    if (!r.ok) return null;
    const html = await r.text();
    const tag = html.match(/<link[^>]+type=["']application\/rss\+xml["'][^>]*>/i);
    if (!tag) return null;
    const href = tag[0].match(/href=["']([^"']+)["']/i)?.[1];
    if (!href) return null;
    return href.startsWith('http') ? href : new URL(href, origin).toString();
  } catch {
    return null;
  }
}

async function runSourceHealthCheck(env) {
  const overridesRaw = await env.ARTICLES.get('source_url_overrides');
  const overrides = overridesRaw ? JSON.parse(overridesRaw) : {};
  const report = { checked_at: new Date().toISOString(), ok: [], fixed: [], broken: [] };

  for (const source of RSS_SOURCES) {
    const currentUrl = overrides[source.name] || source.url;
    const result = await testFeedUrl(currentUrl);
    if (result.ok) {
      report.ok.push({ name: source.name, items: result.items });
      continue;
    }

    const candidateUrl = await discoverFeedUrl(currentUrl);
    const candidateResult = candidateUrl && candidateUrl !== currentUrl ? await testFeedUrl(candidateUrl) : null;

    if (candidateResult && candidateResult.ok) {
      overrides[source.name] = candidateUrl;
      report.fixed.push({ name: source.name, old_url: currentUrl, new_url: candidateUrl, items: candidateResult.items });
    } else {
      report.broken.push({ name: source.name, url: currentUrl, error: result.error });
    }
  }

  await env.ARTICLES.put('source_url_overrides', JSON.stringify(overrides));
  await env.ARTICLES.put('source_health_report', JSON.stringify(report));

  if (report.fixed.length || report.broken.length) {
    await notifySourceHealth(env, report);
  }
}

async function handleCheckSources(env) {
  await runSourceHealthCheck(env);
  return json(JSON.parse(await env.ARTICLES.get('source_health_report') || 'null'));
}

async function notifySourceHealth(env, report) {
  if (!env.VAPID_PRIVATE_JWK) return;
  let title, body;
  if (report.broken.length) {
    title = `⚠️ ${report.broken.length} font${report.broken.length>1?'s':''} de notícies sense arreglar`;
    body  = report.broken.map(b => b.name).join(', ')
          + (report.fixed.length ? ` · ${report.fixed.length} arreglades automàticament` : '');
  } else if (report.fixed.length) {
    title = `🔧 ${report.fixed.length} font${report.fixed.length>1?'s':''} de notícies arreglada${report.fixed.length>1?'es':''} automàticament`;
    body  = report.fixed.map(f => f.name).join(', ');
  } else {
    return; // tot correcte, no cal notificar
  }
  await broadcastPush(env, { title, body, url: APP_URL, id: `source-health-${Date.now()}` });
}

// Envia una mateixa notificació a totes les subscripcions guardades, retirant
// les que el servei de push confirma com a caducades (404/410).
async function broadcastPush(env, payload) {
  const subs = await loadPushSubs(env);
  if (!subs.length) return;
  let changed = false;
  const validSubs = [];
  for (const sub of subs) {
    try {
      const resp = await sendWebPush(sub, payload, env);
      if (resp.status === 404 || resp.status === 410) { changed = true; continue; }
    } catch (e) { /* error puntual: no la donem de baixa per això */ }
    validSubs.push(sub);
  }
  if (changed) await env.ARTICLES.put('push_subs', JSON.stringify(validSubs));
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
- categoria: una de Política/Economia/Tecnologia/Internacional/Societat/Conflicte/Esports
- rellevancia: enter 1-10
- es_duplicat: true si és molt similar a un altre article del lot
- topic_id: cadena curta en anglès kebab-case que identifica el tema principal (ex: "gaza-ceasefire", "trump-tariffs", "ukraine-war", "climate-summit"). Articles sobre el MATEIX fet real han de tenir EXACTAMENT el MATEIX topic_id
- angle_editorial: etiqueta molt breu (2-4 paraules) de la línia editorial del mitjà en aquest article (ex: "progressista", "conservador", "liberal", "neutral", "sensacionalista", "esportiu", "pro-Ucraïna", "pro-Rússia", "populista")
- angle_position: número de -1 a 1 que indica on se situa l'ENFOCAMENT d'aquest article concret en un eix esquerra-dreta: -1 = clarament progressista/esquerra, 0 = neutral/objectiu, 1 = clarament conservador/dreta. Usa decimals si cal (ex: -0.5). Si l'article no té cap enfocament ideològic (esports, ciència, successos sense angle polític), posa null.
Criteris de rellevància per categoria Esports: prioritza notícies d'esports d'Espanya i Europa (futbol masculí i femení, bàsquet, atletisme, ciclisme, tennis). Puntua baix (1-3) notícies de lligues nord-americanes (NBA, NFL, MLB) o esports poc seguits a Europa (criquet, rugby australià).
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
      topic_id:    p.topic_id        || '',
      angle_editorial: p.angle_editorial || '',
      angle_position: typeof p.angle_position === 'number' && !isNaN(p.angle_position)
        ? Math.max(-1, Math.min(1, p.angle_position)) : null,
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
//  WEB PUSH — subscripcions i alertes
// ══════════════════════════════════════════════════════════════════════════

async function loadPushSubs(env) {
  const raw = await env.ARTICLES.get('push_subs');
  return raw ? JSON.parse(raw) : [];
}

async function handlePushSubscribe(request, env) {
  const sub = await request.json().catch(() => null);
  if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
    return json({ error: 'Subscripció invàlida' }, 400);
  }
  const subs = await loadPushSubs(env);
  const filtered = subs.filter(s => s.endpoint !== sub.endpoint);
  filtered.push({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } });
  await env.ARTICLES.put('push_subs', JSON.stringify(filtered));
  return json({ ok: true, total: filtered.length });
}

async function handlePushUnsubscribe(request, env) {
  const body = await request.json().catch(() => ({}));
  if (!body.endpoint) return json({ error: 'endpoint requerit' }, 400);
  const subs = await loadPushSubs(env);
  await env.ARTICLES.put('push_subs', JSON.stringify(subs.filter(s => s.endpoint !== body.endpoint)));
  return json({ ok: true });
}

async function handleAlerts(request, env) {
  if (request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const keywords = Array.isArray(body.keywords)
      ? body.keywords.filter(k => typeof k === 'string' && k.trim()).slice(0, 50)
      : [];
    await env.ARTICLES.put('alert_keywords', JSON.stringify(keywords));
    return json({ ok: true, keywords });
  }
  const raw = await env.ARTICLES.get('alert_keywords');
  return json({ keywords: raw ? JSON.parse(raw) : [] });
}

// Envia una notificació per cada candidat que coincideixi amb una paraula clau
// d'alerta o que tingui rellevància molt alta (PUSH_MIN_RELEVANCE). Es limita a
// un màxim de 5 notificacions per cicle de fetch per no saturar el dispositiu.
async function notifyPush(env, candidates) {
  if (!candidates.length || !env.VAPID_PRIVATE_JWK) return;
  const subs = await loadPushSubs(env);
  if (!subs.length) return;

  const keywordsRaw = await env.ARTICLES.get('alert_keywords');
  const keywords = keywordsRaw ? JSON.parse(keywordsRaw) : [];

  const toNotify = [];
  for (const a of candidates) {
    const hay = `${a.title_ca||''} ${a.summary_ca||''}`.toLowerCase();
    const matched = keywords.find(k => hay.includes(k.toLowerCase()));
    if (matched) toNotify.push({ art: a, title: `🔔 ${a.title_ca}`, body: `Alerta: "${matched}"` });
    else if (a.relevance >= PUSH_MIN_RELEVANCE) toNotify.push({ art: a, title: `🔥 ${a.title_ca}`, body: a.summary_ca ? a.summary_ca.slice(0,140) : 'Notícia molt rellevant' });
  }
  if (!toNotify.length) return;

  const batch = toNotify.slice(0, 5);
  let changed = false;
  const validSubs = [];
  for (const sub of subs) {
    let stillValid = true;
    for (const n of batch) {
      try {
        const resp = await sendWebPush(sub, { title: n.title, body: n.body, url: n.art.url, id: n.art.id }, env);
        if (resp.status === 404 || resp.status === 410) { stillValid = false; break; }
      } catch (e) { /* error puntual d'una subscripció: no la donem de baixa per això */ }
    }
    if (stillValid) validSubs.push(sub); else changed = true;
  }
  if (changed) await env.ARTICLES.put('push_subs', JSON.stringify(validSubs));
}

// ── Codificació base64url i utilitats binàries ──────────────────────────────
function b64urlToBytes(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  const bin = atob(str);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
function bytesToB64url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function concatBytes(...arrs) {
  const total = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrs) { out.set(a, off); off += a.length; }
  return out;
}

// ── VAPID (autenticació del remitent davant el servei de push) ─────────────
let _vapidKeyPromise = null;
function getVapidPrivateKey(env) {
  if (!_vapidKeyPromise) {
    const jwk = JSON.parse(env.VAPID_PRIVATE_JWK);
    _vapidKeyPromise = crypto.subtle.importKey(
      'jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']
    );
  }
  return _vapidKeyPromise;
}

async function signVapidJWT(audience, env) {
  const key = await getVapidPrivateKey(env);
  const header  = { typ: 'JWT', alg: 'ES256' };
  const payload = { aud: audience, exp: Math.floor(Date.now()/1000) + 12*3600, sub: VAPID_SUBJECT };
  const enc = obj => bytesToB64url(new TextEncoder().encode(JSON.stringify(obj)));
  const signingInput = `${enc(header)}.${enc(payload)}`;
  // ECDSA amb WebCrypto retorna la signatura en format cru (r||s), exactament
  // el que exigeix JWT ES256 (a diferència del format DER per defecte de Node).
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${bytesToB64url(new Uint8Array(sig))}`;
}

// ── Xifratge del payload (RFC 8291, content-coding aes128gcm) ──────────────
async function hkdf(ikmBytes, saltBytes, infoBytes, lengthBytes) {
  const key = await crypto.subtle.importKey('raw', ikmBytes, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: saltBytes, info: infoBytes }, key, lengthBytes * 8
  );
  return new Uint8Array(bits);
}

async function encryptPushPayload(subscription, payloadBytes) {
  const uaPublic    = b64urlToBytes(subscription.keys.p256dh); // 65 bytes (punt EC sense comprimir)
  const authSecret  = b64urlToBytes(subscription.keys.auth);   // 16 bytes

  const localKeyPair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublicRaw  = new Uint8Array(await crypto.subtle.exportKey('raw', localKeyPair.publicKey));

  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const sharedSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, localKeyPair.privateKey, 256));

  const enc = s => new TextEncoder().encode(s);
  const keyInfo = concatBytes(enc('WebPush: info'), new Uint8Array([0]), uaPublic, asPublicRaw);
  const ikm = await hkdf(sharedSecret, authSecret, keyInfo, 32);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cekInfo   = concatBytes(enc('Content-Encoding: aes128gcm'), new Uint8Array([0]));
  const nonceInfo = concatBytes(enc('Content-Encoding: nonce'), new Uint8Array([0]));
  const cek   = await hkdf(ikm, salt, cekInfo, 16);
  const nonce = await hkdf(ikm, salt, nonceInfo, 12);

  const cekKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const padded = concatBytes(payloadBytes, new Uint8Array([2])); // delimitador de registre únic, sense padding extra
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, cekKey, padded));

  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096, false);
  const idlen = new Uint8Array([asPublicRaw.length]);

  return concatBytes(salt, rs, idlen, asPublicRaw, ciphertext);
}

async function sendWebPush(subscription, payloadObj, env) {
  const body = new TextEncoder().encode(JSON.stringify(payloadObj));
  const encryptedBody = await encryptPushPayload(subscription, body);
  const audience = new URL(subscription.endpoint).origin;
  const jwt = await signVapidJWT(audience, env);

  return fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type':     'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      'TTL':               '86400',
      'Authorization':     `vapid t=${jwt}, k=${VAPID_PUBLIC_KEY}`,
    },
    body: encryptedBody,
  });
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
  {id:'Esports',label:'Esports',icon:'⚽'},
];
const COUNTRIES = [
  {id:'UK',label:'Regne Unit 🇬🇧'},{id:'US',label:'EUA 🇺🇸'},{id:'FR',label:'França 🇫🇷'},
  {id:'DE',label:'Alemanya 🇩🇪'},{id:'EU',label:'Unió Europea 🇪🇺'},{id:'ES',label:'Espanya 🇪🇸'},
];
