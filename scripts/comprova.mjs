// Comprova si l'última actualització programada (6h, 13h, 20h, hora de Madrid) s'ha publicat.
// La fa servir la tasca vigilant "noticies-vigilant". Ús: node scripts/comprova.mjs
// Escriu una d'aquestes línies (la primera paraula és el que compta):
//   AL DIA          → no cal fer res
//   EN CURS         → l'actualització s'està fent ara mateix: no cal fer res
//   CAL ACTUALITZAR → no s'ha publicat: cal fer el procediment sencer
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ARREL, WORKER_URL } from './kv.mjs';

const HORES = [6, 13, 20];          // ha de coincidir amb la tasca noticies-en-catala
const EN_CURS_MINUTS = 40;          // si lot.json és més recent que això, hi ha una actualització en marxa

// Hora local de Madrid d'un instant, com a {any, mes, dia, hora}
function madrid(d) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false,
  }).formatToParts(d).map(x => [x.type, x.value]));
  return { data: `${p.year}-${p.month}-${p.day}`, hora: Number(p.hour) % 24 };
}

// Instant (UTC) de l'última hora programada que ja ha passat
function ultimaProgramada(ara) {
  for (let h = 0; h < 48; h++) {
    const t = new Date(ara.getTime() - h * 3600000);
    const m = madrid(t);
    if (HORES.includes(m.hora)) {
      // inici d'aquella hora en hora de Madrid
      return new Date(Math.floor(t.getTime() / 3600000) * 3600000);
    }
  }
  return null;
}

const ara = new Date();
const programada = ultimaProgramada(ara);
const stats = await (await fetch(`${WORKER_URL}?action=stats`, { signal: AbortSignal.timeout(20000) })).json();
const publicat = stats.last_fetch?.fetched_at ? new Date(stats.last_fetch.fetched_at) : null;
const fmt = d => d ? d.toLocaleString('ca-ES', { timeZone: 'Europe/Madrid', dateStyle: 'short', timeStyle: 'short' }) : 'mai';

console.log(`Ara: ${fmt(ara)} · última actualització programada: ${fmt(programada)} · última publicació: ${fmt(publicat)}`);

if (publicat && publicat >= programada) {
  console.log('AL DIA: l\'actualització programada ja s\'ha publicat. No cal fer res més.');
} else {
  const lot = join(ARREL, 'pendents', 'lot.json');
  const minuts = existsSync(lot) ? (ara - statSync(lot).mtime) / 60000 : Infinity;
  if (minuts < EN_CURS_MINUTS) {
    console.log(`EN CURS: hi ha una actualització en marxa (lot.json de fa ${Math.round(minuts)} min). No cal fer res més.`);
  } else {
    console.log('CAL ACTUALITZAR: l\'actualització programada no s\'ha publicat. Fes el procediment sencer de CLAUDE.md.');
  }
}
