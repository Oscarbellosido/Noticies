# Noticies en Català — Resum Tècnic

## Descripció
Aplicació web que recopila notícies internacionals de fonts RSS, les tradueix al català i les resumeix usant IA (Claude). Tot el processament es fa al servidor (Cloudflare Worker), de manera que l'app carrega en <1 segon des de qualsevol dispositiu.

---

## Arquitectura

```
[Fonts RSS] → [Cloudflare Worker "noticies"] → [KV Storage]
                        ↑                            ↓
               [Cron: 06h, 14h, 20h]         [INDEX.html]
                        ↑
               [Claude Haiku 4.5 API]
```

- **Frontend**: `INDEX.html` — HTML/CSS/JS pur, sense frameworks. Usa Tailwind CDN.
- **Backend**: Cloudflare Worker (`worker.js`) amb KV Storage.
- **IA**: Claude Haiku 4.5 via API d'Anthropic.
- **Dades**: Cloudflare KV (clau `articles`, `fetch_log`, `fetch_lock`, `fetch_debug`).

---

## Fitxers

| Fitxer | Descripció |
|--------|-----------|
| `INDEX.html` | Frontend complet. Es puja al servidor web. |
| `worker.js` | Cloudflare Worker (backend). Es desplega amb Wrangler. |
| `wrangler.toml` | Configuració del Worker (nom, KV, cron). |

---

## Cloudflare Worker (`worker.js`)

### Endpoints (via `?action=...`)

| Action | Mètode | Descripció |
|--------|--------|-----------|
| `news` | GET | Llista articles amb filtres (category, country, search, topic, min_relevance, limit, offset) |
| `top` | GET | Top N articles més rellevants (últims 2 dies), accepta filtre `country` |
| `topics` | GET | Top 12 temes trending (últims 2 dies) amb comptador d'articles |
| `fetch` | GET | Inicia descàrrega i processament en background |
| `stats` | GET | Estadístiques (total, per categoria, per país, is_fetching) |
| `favorite` | POST | Toggle favorit d'un article `{id}` |
| `favorites` | GET | Llista articles marcats com a favorits |
| `categories` | GET | Llista de categories disponibles |
| `countries` | GET | Llista de països disponibles |
| `debug` | GET | Test: agafa 2 articles RSS i els processa amb Claude |
| `fetchlog` | GET | Log detallat de l'última execució |
| `clearlock` | GET | Neteja el lock de fetch (útil si es queda encallat) |

### Cron
- Horari: `0 4,12,18 * * *` (UTC) = 06h, 14h, 20h hora Madrid
- Executa `runFetch()` automàticament

### Flux de `runFetch()`
1. Descarrega RSS de totes les fonts (`fetchAllRSS`)
2. Carrega articles existents del KV
3. Filtra els articles nous (per ID)
4. Processa en lots de 5 amb Claude (`processWithClaude`)
5. Desa els articles amb rellevància ≥ 5 al KV
6. Limita a `MAX_ARTICLES = 500`

### `processWithClaude(batch, apiKey)`
- Envia un lot d'articles a Claude amb títol, descripció i font
- Claude retorna JSON amb: `id`, `titular_ca`, `resum_ca`, `categoria`, `rellevancia`, `es_duplicat`
- **Important**: el prompt ha d'incloure explícitament `id` com a camp obligatori, sinó Claude no el retorna i el matching falla
- Model: `claude-haiku-4-5` (barat i ràpid)
- max_tokens: 4096
- **No usar `thinking`** — no compatible amb Haiku
- **Les crides van via Cloudflare AI Gateway** (`noticies-gw`) — vegeu secció AI Gateway
- **Fallback `summary_ca`**: si Claude no retorna `resum_ca`, s'usa `raw.description` (descripció original RSS) en lloc de cadena buida — garanteix que la cerca funcioni encara que el resum no estigui traduït

### Cloudflare AI Gateway
- **Problema**: `api.anthropic.com` està darrera de Cloudflare. Els Workers no poden fer subrequests a hosts Cloudflare-proxied (retorna HTTP 403 "error code: 1000").
- **Solució**: Cloudflare AI Gateway actua de pont intern. **Gratuït**.
- Gateway creat: `noticies-gw` (account: `06ae974d240fa2b27e2da3fcd783a8c9`)
- URL usada: `https://gateway.ai.cloudflare.com/v1/{account_id}/noticies-gw/anthropic/v1/messages`
- **Autenticació del gateway**: desactivada (no cal token `cf-aig-authorization`)
- El cost visible al dashboard del Gateway (~$0.15/dia) és el cost de l'API d'Anthropic, no del Gateway.

### `handleFetch()` — execució síncrona
- S'executa síncronament (`await runFetch(env)`) en lloc de `ctx.waitUntil`
- Motiu: `ctx.waitUntil` en HTTP handlers tenia problemes de xarxa en aquest worker
- El cron (`scheduled`) segueix usant `ctx.waitUntil` sense problemes

### Fonts RSS configurades

| Font | País | Idioma |
|------|------|--------|
| BBC News | UK | en |
| The Guardian | UK | en |
| Reuters | US | en |
| AP News | US | en |
| Le Monde | FR | fr |
| Le Figaro | FR | fr |
| DW News | DE | en |
| Politico EU | EU | en |
| EUobserver | EU | en |
| El País | ES | es |
| La Vanguardia | ES | es |
| Financial Times | UK | en |
| ARA | ES | ca |

### Filtre de països (INDEX.html)
Països disponibles al dropdown:
`UK, US, FR, DE, EU, ES, CA (Catalunya), QA (Qatar), HK (Hong Kong), ME (Orient Mitjà)`

- El desplegable és un component **custom HTML/CSS** (no un `<select>` natiu) perquè Windows no renderitza emojis de bandera en controls natius del SO
- La llista de països es defineix a `COUNTRY_LIST` al JavaScript
- El filtre de país funciona a totes les vistes: **Top**, **Totes** i redirigeix a Totes des de les altres
- `handleGetTop` (worker.js) també accepta i aplica el paràmetre `country`

---

## Frontend (`INDEX.html`)

### Tecnologies
- HTML/CSS/JS pur (sense frameworks JS)
- Tailwind CSS CDN (dark mode: `class`) — **config DESPRÉS del CDN**
- `fetch()` per cridar el worker

### Estat global (`S`)
```js
{
  view, category, country, search,
  topic,    // tema trending actiu (filtra per topic_id)
  minRel,   // rellevància mínima (1 = totes, 5 = alta, 8 = molt alta)
  offset, limit, articles, topArts, favArts, perspArts,
  dark, modalId, isFetching
}
```
`category`, `country` i `minRel` es persisteixen a `localStorage` i es restauren en cada càrrega.

### Funcions principals

| Funció | Descripció |
|--------|-----------|
| `loadTop()` | Carrega top 10 notícies (passa `country: S.country`) |
| `loadAll()` | Carrega totes amb filtres (categoria, país, cerca, topic, min_relevance) |
| `loadTopics()` | Carrega trending topics i mostra la secció 🔥 Trending a "Totes" |
| `loadBriefing()` | Vista compacta de les 15 més rellevants |
| `loadFavs()` | Carrega favorits |
| `loadStats()` | Mostra estadístiques al header |
| `triggerFetch()` | Crida `?action=fetch` i fa polling cada 5s fins que acaba |
| `quickFav(id, btn)` | Toggle favorit via POST al worker |
| `openModal(id)` | Obre modal amb detall de l'article |
| `apiGet(params)` | Helper GET al worker |
| `apiPost(params, body)` | Helper POST al worker (action via URL, dades via body) |
| `initCountryDD()` | Inicialitza el desplegable de països custom (crida al DOMContentLoaded) |
| `toggleCountryDD()` | Obre/tanca el desplegable de països |
| `pickCountry(v)` | Selecciona un país, desa a localStorage, refresca vista activa |
| `setCategory(cat)` | Selecciona categoria, desa a localStorage |
| `setRelevance(v)` | Canvia `S.minRel` (1/5/8), desa a localStorage, refresca |
| `updateRelButtons(active)` | Actualitza estil visual dels botons de rellevància |
| `setTopic(id)` | Activa/desactiva filtre de tema (toggle); buida la cerca |

### Vistes
- **⭐ Top**: 10 notícies més rellevants dels últims 2 dies
- **📰 Totes**: totes les notícies amb filtres per categoria, país, rellevància i tema trending
- **📋 Briefing**: vista de lectura ràpida (~2 min)
- **❤️ Favs**: notícies guardades com a favorites

### Funcionalitats de la vista "Totes"
- **Filtre rellevància**: botons `Totes / Alta ≥5 / Molt alta ≥8` — passa `min_relevance` al backend
- **🔥 Trending topics**: etiquetes clicables generades a partir dels `topic_id` Claude dels últims 2 dies. Clicar una etiqueta filtra per aquell tema; clicar de nou o "Tots" el treu
- **Badge notícies noves**: quan el refresc automàtic (cada 30 min) detecta articles nous, apareix un badge vermell `●N` sobre el botó ⭐ Top i un banner blau amb botó "Actualitzar"

### Categories i colors Tailwind
```js
'Política':      'bg-blue-100   text-blue-800'
'Economia':      'bg-green-100  text-green-800'
'Tecnologia':    'bg-purple-100 text-purple-800'
'Internacional': 'bg-orange-100 text-orange-800'
'Societat':      'bg-pink-100   text-pink-800'
'Conflicte':     'bg-red-100    text-red-800'
```

---

## Desplegament

### Requisits
- Compte Cloudflare (pla gratuït suficient)
- Wrangler CLI: `npm install -g wrangler`
- Clau API d'Anthropic

### Passos
```bash
wrangler login
wrangler kv namespace create ARTICLES   # copia l'ID al wrangler.toml
wrangler secret put API_KEY             # enganxa la clau Anthropic
wrangler deploy
```

> **Requisit addicional**: crear l'AI Gateway `noticies-gw` al Cloudflare Dashboard → AI → AI Gateway → Create custom gateway (autenticació desactivada).

### `wrangler.toml` mínim
```toml
name = "noticies"
main = "worker.js"
compatibility_date = "2024-01-01"

[[kv_namespaces]]
binding = "ARTICLES"
id = "EL_TEU_KV_ID"

[triggers]
crons = ["0 4,12,18 * * *"]
```

---

## Cost aproximat
- **Cloudflare Worker**: gratuït (100k req/dia, 3 crons/dia)
- **Anthropic Haiku 4.5**: ~$1.50-2/mes (3 runs/dia × ~8 lots × cost mínim)
- **Servidor web** (INDEX.html): el que ja tens

---

## Errors coneguts i solucions

| Error | Causa | Solució |
|-------|-------|---------|
| 0 articles guardats | Claude no retornava `id` al JSON | Afegir `id` explícitament al prompt |
| 0 articles guardats | Model invàlid (`claude-3-5-haiku-20241022`) | Usar `claude-haiku-4-5` |
| 0 articles guardats | `thinking:{type:'adaptive'}` incompatible amb Haiku | Eliminar el paràmetre `thinking` |
| Dark mode no funciona | Config Tailwind abans del CDN | Posar `tailwind.config` DESPRÉS del `<script src CDN>` |
| Worker encallat | Lock de fetch no s'esborra | Cridar `?action=clearlock` |
| HTTP 403 "error code: 1000" | `api.anthropic.com` és Cloudflare-proxied, Workers no hi pot accedir | Usar Cloudflare AI Gateway (`noticies-gw`) |
| 0 articles guardats al cron | Idem — totes les crides a Claude fallen | Idem — AI Gateway ho soluciona |
| Cerca no troba res | `summary_ca` era cadena buida si Claude no retornava resum | Fallback a `raw.description` (worker.js:405) |
| Filtre de país no funciona a Top | `handleGetTop` ignorava el paràmetre `country` | Afegit filtre `(!cntry \|\| a.country === cntry)` |
| Banderes no es veuen al desplegable | `<select>` natiu de Windows no renderitza emojis de bandera | Substituït per desplegable custom HTML/CSS amb imatges PNG (flagcdn.com) i SVG Base64 (estelada) |
| Trending no apareix | `trending-wrap` queda `hidden` si `?action=topics` no retorna res | Normal si no hi ha articles amb `topic_id`; actualitza les notícies primer |
| Filtre rellevància/trending no visible | Aquests elements només es mostren a la vista "📰 Totes" | Clicar "Totes" per veure'ls |

---

## Worker de MecAI (proxy auxiliar)
El worker `mecai.oscarbellosido.workers.dev` s'usa com a proxy doble:
- `GET ?action=rss&url=...` → proxy RSS (evita CORS)
- `POST {model, messages, ...}` → proxy Claude API

Aquest worker **ja no és necessari** per a Noticies (el nou worker ho fa tot directament), però segueix actiu per a l'app MecAI.
