# Noticies en Català — procediment diari

App de notícies internacionals en català. Frontend `INDEX.html` (servidor propi, https://39699323.servicio-online.net/Noti/INDEX.html)
+ Cloudflare Worker `worker.js` amb KV `ARTICLES`. Detalls tècnics a `NOTICIES_RESUM.md`.

Des de setembre de 2026 **no es fa servir l'API d'Anthropic** (0 €): els resums els escriu Claude en una tasca
programada de l'app d'escriptori (~8:00 i ~19:00), i els scripts pugen el resultat al KV amb wrangler.

## Procediment (el que fa la tasca programada)
1. `node scripts/baixa.mjs` — baixa les 27 fonts RSS (`rss.mjs`), descarta els IDs que ja són al KV i els de fa més de 3 dies,
   i escriu `pendents/lot.json` (compacte: `id`, `font`, `titol`, `desc` + `temes_existents` + `top_actual`) i `pendents/raw.json`.
2. Llegeix `pendents/lot.json` i processa **TOTS** els articles, per trossos de ~40: per cada tros escriu
   `pendents/resultat-01.json`, `resultat-02.json`, … (arrays JSON; format a sota). No te'n deixis cap: els que falten es
   tornen a baixar la propera vegada.
3. Escriu `pendents/resum_dia.json`: `{ "text": "..." }` — resum narratiu en català de 3-4 paràgrafs de què passa al món,
   a partir de les notícies més rellevants (les noves de rellevància alta + `top_actual`). Com l'obertura d'un informatiu:
   directe, clar, amb context, text corregut, sense llistes. Si no hi ha cap article nou, no l'escriguis.
4. `node scripts/publica.mjs` — fusiona amb el KV (com l'antic `runFetch`: `MIN_RELEVANCE=5`, `MAX_ARTICLES=500`, ordenat per
   data), puja `articles`, `fetch_log`, `fetch_debug`, `resum_dia`, dispara els avisos push (`?action=notify`) i buida `pendents/`.
   Amb `--dry-run` ho comprova sense pujar res.
5. No cal fer commit: les dades viuen al KV, no al repo.

## Format de cada article a `resultat-NN.json` (mateixos camps que l'antic `processWithClaude`)
```json
{ "id": "7f4d3ef553", "titular_ca": "...", "resum_ca": "...", "categoria": "Internacional",
  "rellevancia": 7, "es_duplicat": false, "topic_id": "us-iran-talks",
  "angle_editorial": "neutral", "angle_position": 0 }
```
- `id`: el mateix ID rebut (OBLIGATORI, no el canviïs).
- `titular_ca`: títol en català concís.
- `resum_ca`: resum en català de **2-3 línies** (fets concrets: qui, què, on, xifres). Només amb el que diu el títol i la descripció: no inventis.
- `categoria`: una de `Política` / `Economia` / `Tecnologia` / `Internacional` / `Societat` / `Conflicte` / `Esports`.
- `rellevancia`: enter 1-10 (importància per a un lector català interessat en l'actualitat internacional).
- `es_duplicat`: `true` si és molt similar a un altre article del lot (el mateix fet explicat per una altra font amb el mateix
  enfocament); marca només les còpies, no el primer.
- `topic_id`: cadena curta en anglès kebab-case que identifica el tema principal (ex: `gaza-ceasefire`, `trump-tariffs`,
  `ukraine-war`). Articles sobre el MATEIX fet real han de tenir EXACTAMENT el MATEIX `topic_id`. Si el tema ja és a
  `temes_existents`, reutilitza aquell identificador.
- `angle_editorial`: etiqueta molt breu (2-4 paraules) de la línia editorial del mitjà en aquest article (ex: "progressista",
  "conservador", "liberal", "neutral", "sensacionalista", "esportiu", "pro-Ucraïna", "pro-Rússia", "populista").
- `angle_position`: número de -1 a 1 on se situa l'enfocament d'aquest article en l'eix esquerra-dreta (-1 progressista,
  0 neutral, 1 conservador; decimals si cal). `null` si no té enfocament ideològic (esports, ciència, successos).
- Esports: prioritza els d'Espanya i Europa (futbol masculí i femení, bàsquet, atletisme, ciclisme, tennis). Puntua baix (1-3)
  les lligues nord-americanes (NBA, NFL, MLB) i esports poc seguits a Europa (criquet, rugby australià).

## Notes
- El worker ja no processa res: `?action=fetch` retorna `disabled` i el botó "Actualitzar" només recarrega les dades.
  El cron del worker només fa la revisió mensual de fonts (dia 1, 5h UTC).
- Estat de l'última publicació: `https://noticies.oscarbellosido.workers.dev/?action=fetchlog`.
- Canvis a `rss.mjs` o `worker.js` → `npx wrangler deploy`. Canvis a `INDEX.html` → pujar-lo al servidor web (ho fa l'usuari).
- La carpeta d'usuari `C:\Users\Carles` també és un repo git: aquesta carpeta té el seu propi `.git`. No facis `git add .` fora d'aquí.
