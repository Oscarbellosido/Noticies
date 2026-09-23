// ══════════════════════════════════════════════════════════════════════════
//  NOTICIES EN CATALÀ — Cloudflare Worker
//
//  Des de setembre de 2026 el worker NO crida cap API de pagament: els articles
//  els baixa i resumeix el PC (scripts/baixa.mjs → tasca programada de Claude →
//  scripts/publica.mjs), que els escriu directament al KV. Veure CLAUDE.md.
//  El worker només serveix les dades, favorits, mapa, perspectives, alertes,
//  push i la revisió mensual de fonts.
//
//  Configuració:
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
//    crons = ["0 5 1 * *"]   # revisió de fonts RSS, dia 1 de cada mes
// ══════════════════════════════════════════════════════════════════════════

// Web Push (notificacions) — clau pública VAPID (no és secreta, ha de coincidir
// amb la constant VAPID_PUBLIC_KEY d'INDEX.html). La privada viu a env.VAPID_PRIVATE_JWK.
const VAPID_PUBLIC_KEY    = 'BM2P6l00GxYKXUEgPR7z4SQJaO8efBhJIfiIYXlGRfmert28xqmd8EQxGbjLL-TEOPnZLO-T4wU3vW4_t0x7aZQ';
const VAPID_SUBJECT       = 'https://oscarbellosido.github.io/Noticies/';
const PUSH_MIN_RELEVANCE  = 9; // notifica encara que no coincideixi amb cap paraula clau
const APP_URL             = 'https://39699323.servicio-online.net/Noti/INDEX.html';

import { RSS_SOURCES } from './rss.mjs';


// ── Helpers CORS ──────────────────────────────────────────────────────────
const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-App-Secret',
  'Content-Type':                 'application/json; charset=utf-8',
};
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: CORS });

// ══════════════════════════════════════════════════════════════════════════
// Accions que envien notificacions, alteren estat, o toquen dades personals
// (subscripcions push, paraules clau d'alerta): cal secret.
const PROTECTED_ACTIONS = new Set([
  'clearlock', 'notify',
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
      case 'fetch':      return json(FETCH_DISABLED);
      case 'stats':      return handleStats(env);
      case 'favorite':   return handleFavorite(request, env);
      case 'favorites':  return handleFavorites(env);
      case 'categories': return json({ categories: CATEGORIES });
      case 'countries':  return json({ countries: COUNTRIES });
      case 'fetchlog':   return json(JSON.parse(await env.ARTICLES.get('fetch_debug') || 'null'));
      case 'clearlock':  await env.ARTICLES.delete('fetch_lock'); return json({ ok: true });
      case 'claude':
      case 'debug':      return json({ error: "Desactivat: el worker ja no crida l'API de Claude" }, 410);
      case 'resum':      return json(JSON.parse(await env.ARTICLES.get('resum_dia') || 'null'));
      case 'notify':     return handleNotify(request, env);
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

  // ── Cron trigger: només la revisió de fonts, el dia 1 de cada mes ──
  async scheduled(event, env, ctx) {
    if (event.cron === '0 5 1 * *') ctx.waitUntil(runSourceHealthCheck(env));
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

// Les notícies ja no es processen al servidor sinó al PC (scripts/baixa.mjs +
// Claude + scripts/publica.mjs), així que ?action=fetch no fa res.
const FETCH_DISABLED = {
  status: 'disabled',
  message: "Les notícies ja no es processen al servidor: s'actualitzen automàticament des del PC dos cops al dia. Aquest botó només recarrega les dades.",
};

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

// Cridat per scripts/publica.mjs després de pujar articles nous: rep els IDs
// dels candidats (no duplicats, rellevància >= 5) i envia els avisos push.
async function handleNotify(request, env) {
  if (request.method !== 'POST') return json({ error: 'POST required' }, 405);
  const body = await request.json().catch(() => ({}));
  const ids = new Set(Array.isArray(body.ids) ? body.ids : []);
  if (!ids.size) return json({ ok: true, candidates: 0 });
  const candidates = (await loadArticles(env)).filter(a => ids.has(a.id));
  try {
    await notifyPush(env, candidates);
  } catch (e) {
    await env.ARTICLES.put('push_debug', JSON.stringify({ error: e.message, stack: e.stack }));
    return json({ ok: false, error: e.message }, 500);
  }
  return json({ ok: true, candidates: candidates.length });
}

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

// ── Utils ─────────────────────────────────────────────────────────────────

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
