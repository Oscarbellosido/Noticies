// ══════════════════════════════════════════════════════════════════════════
//  Fonts RSS i parseig — mòdul compartit entre worker.js (Cloudflare) i
//  scripts/baixa.mjs (Node). Si toques res d'aquí, redesplega el worker.
// ══════════════════════════════════════════════════════════════════════════

export const MAX_PER_SOURCE = 8;

export const RSS_SOURCES = [
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

export function makeId(url) {
  let hash = 0;
  for (let i=0; i<url.length; i++) hash = ((hash<<5)-hash)+url.charCodeAt(i), hash|=0;
  return Math.abs(hash).toString(16).padStart(8,'0') + url.length.toString(16);
}

export function cleanText(t) {
  return (t||'').replace(/<[^>]+>/g,' ').replace(/&[a-z]+;/gi,' ')
                .replace(/\s+/g,' ').trim().slice(0, 600);
}

export async function fetchRssSource(source) {
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

// Aplica les URLs corregides per la revisió mensual de fonts (KV `source_url_overrides`).
export function applyOverrides(overrides) {
  return RSS_SOURCES.map(s => overrides && overrides[s.name] ? { ...s, url: overrides[s.name] } : s);
}

// Baixa totes les fonts en paral·lel i elimina IDs repetits.
export async function fetchAllSources(sources) {
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
