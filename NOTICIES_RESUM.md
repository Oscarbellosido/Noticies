# Noticies en Català — Resum Tècnic

## Descripció
Aplicació web que recopila notícies internacionals de fonts RSS, les tradueix al català i les resumeix amb Claude.
El frontend llegeix les dades d'un Cloudflare Worker, de manera que l'app carrega en <1 segon des de qualsevol dispositiu.

> **Canvi de setembre de 2026 — cost 0 €.** Fins al 22/08/2026 el worker processava les notícies amb l'API d'Anthropic
> (claude-haiku-4-5 via AI Gateway, ~8-10 €/mes) i es va aturar quan es va acabar el crèdit. Ara els resums els escriu
> Claude dins d'una **tasca programada de l'app d'escriptori** (pla de subscripció), igual que l'app TransVideo.
> Procediment pas a pas a `CLAUDE.md`.

---

## Arquitectura

```
PC (tasca programada "noticies-en-catala", 8:00 i 19:00)
  node scripts/baixa.mjs   → [Fonts RSS] → pendents/lot.json (només articles nous)
  Claude escriu            → pendents/resultat-NN.json + resum_dia.json
  node scripts/publica.mjs → wrangler kv key put → [KV ARTICLES] → POST ?action=notify (push)
                                                        ↓
                         [Cloudflare Worker "noticies"] (només lectura + favorits/alertes/push)
                                                        ↓
                                                  [INDEX.html]
```

- **Frontend**: `INDEX.html` — HTML/CSS/JS pur, sense frameworks. Usa Tailwind CDN.
- **Backend**: Cloudflare Worker (`worker.js`) amb KV Storage. Ja no crida cap API de pagament.
- **IA**: Claude a la tasca programada (0 €). Resums de 2-3 línies.
- **Dades**: Cloudflare KV (`articles`, `fetch_log`, `fetch_debug`, `resum_dia`, `push_subs`, `alert_keywords`,
  `source_url_overrides`, `source_health_report`).

### Limitacions
- Només s'actualitza si el PC està encès i l'app de Claude oberta a l'hora programada (si està tancada, la tasca
  s'executa en tornar-la a obrir).
- El botó "Actualitzar" de l'app **ja no processa notícies**: només torna a llegir les dades del worker.
- `wrangler` ha de tenir la sessió iniciada al PC (`npx wrangler login` si caduca).

---

## Fitxers

| Fitxer | Descripció |
|--------|-----------|
| `INDEX.html` | Frontend complet. Es puja al servidor web. |
| `worker.js` | Cloudflare Worker (backend). Es desplega amb Wrangler. |
| `wrangler.toml` | Configuració del Worker (nom, KV, cron mensual de fonts). |
| `rss.mjs` | Llista de fonts RSS i parseig, compartit pel worker i `scripts/baixa.mjs`. |
| `scripts/baixa.mjs` | Baixa l'RSS i deixa els articles nous a `pendents/`. |
| `scripts/publica.mjs` | Fusiona els resums amb el KV (com l'antic `runFetch`), puja i dispara els push. |
| `scripts/kv.mjs` | Helpers de wrangler KV. |
| `CLAUDE.md` | Procediment diari i criteris dels resums (el que llegeix la tasca programada). |

---

## Cloudflare Worker (`worker.js`)

### Endpoints (via `?action=...`)

| Action | Mètode | Descripció |
|--------|--------|-----------|
| `news` | GET | Llista articles amb filtres (category, country, search, topic, min_relevance, limit, offset) |
| `top` | GET | Top N articles més rellevants (últims 2 dies), accepta filtre `country` |
| `topics` | GET | Top 12 temes trending (últims 2 dies) amb comptador d'articles |
| `fetch` | GET | **Desactivat**: retorna `{status:'disabled'}` (el processament es fa al PC) |
| `stats` | GET | Estadístiques (total, per categoria, per país, is_fetching) |
| `favorite` | POST | Toggle favorit d'un article `{id}` |
| `favorites` | GET | Llista articles marcats com a favorits |
| `categories` | GET | Llista de categories disponibles |
| `countries` | GET | Llista de països disponibles |
| `debug`, `claude` | — | **Desactivats** (410): el worker ja no crida l'API |
| `resum` | GET | Resum narratiu del dia (clau KV `resum_dia`) |
| `notify` | POST 🔒 | `{ids}`: envia els avisos push dels articles nous (el crida `publica.mjs`) |
| `fetchlog` | GET | Log detallat de l'última execució |
| `clearlock` | GET | Neteja el lock de fetch (útil si es queda encallat) |

### Cron
- Només `0 5 1 * *` (UTC, dia 1 de cada mes): revisió de salut de les fonts RSS (`runSourceHealthCheck`), que
  arregla URLs trencades a `source_url_overrides` i avisa per push.
- Els antics crons de processament (`0 4,12,18 * * *`) s'han eliminat.

### Processament dels articles (abans `runFetch` + `processWithClaude`, ara al PC)
1. `baixa.mjs`: descarrega RSS (27 fonts, fins a 8 per font), descarta IDs ja al KV i articles de fa més de 3 dies.
2. Claude escriu per cada article: `id`, `titular_ca`, `resum_ca`, `categoria`, `rellevancia`, `es_duplicat`,
   `topic_id`, `angle_editorial`, `angle_position` (criteris a `CLAUDE.md`).
3. `publica.mjs`: els converteix als camps del frontend (`title_ca`, `summary_ca`, `category`, `relevance`,
   `is_duplicate`…), els afegeix al KV (també duplicats, per al mapa), compta com a desats els de rellevància ≥ 5,
   ordena per data i limita a `MAX_ARTICLES = 500`.
4. Escriu `fetch_log` (`mode: 'local'`) i `fetch_debug`, i crida `?action=notify` per als push.

> Històric: l'AI Gateway `noticies-gw` i el secret `API_KEY` ja no s'utilitzen.

### Fonts RSS configurades

27 fonts (BBC, Guardian, Euronews, Sky News, Le Monde, France 24, DW, Politico EU, EUobserver, El País, La Vanguardia, FT, ARA, Al Jazeera, Middle East Eye, NYT, WPost, Der Spiegel, SCMP, VilaWeb, Xataka, The Verge, Ars Technica, Wired, Marca, Mundo Deportivo, BBC Sport). La llista és a `rss.mjs` (`RSS_SOURCES`).

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
| `triggerFetch()` | Botó "Actualitzar": només torna a llegir estadístiques i la vista actual |
| `generarResum()` | Mostra el resum narratiu del dia (`?action=resum`), escrit per la tasca programada |
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

### Passos
```bash
wrangler login
wrangler kv namespace create ARTICLES   # copia l'ID al wrangler.toml
wrangler secret put APP_SECRET          # el mateix valor que APP_SECRET a INDEX.html
wrangler secret put VAPID_PRIVATE_JWK   # clau privada per als push
wrangler deploy
```

> Ja no cal l'AI Gateway ni cap clau d'Anthropic.

### `wrangler.toml` mínim
```toml
name = "noticies"
main = "worker.js"
compatibility_date = "2024-01-01"

[[kv_namespaces]]
binding = "ARTICLES"
id = "EL_TEU_KV_ID"

[triggers]
crons = ["0 5 1 * *"]
```

---

## Cost aproximat
- **Cloudflare Worker + KV**: gratuït.
- **Resums**: 0 € (tasca programada de Claude dins del pla de subscripció). Abans: ~8-10 €/mes d'API.
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
