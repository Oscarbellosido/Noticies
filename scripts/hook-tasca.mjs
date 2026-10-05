// Hook PreToolUse (Bash/PowerShell) per a la tasca programada "noticies-en-catala".
// La tasca s'executa sense ningú davant: si intenta una ordre sense permís, es
// queda encallada hores esperant que algú l'aprovi. Aquest hook la denega a
// l'instant (la tasca rep l'error i continua). Només s'aplica a les sessions
// iniciades per la tasca; les converses normals no es veuen afectades.
import { openSync, readSync, closeSync } from 'node:fs';

const PERMESES = /^node scripts[\\/](baixa|publica)\.mjs( --dry-run)?\s*$/;

let entrada = '';
for await (const tros of process.stdin) entrada += tros;
let dades;
try { dades = JSON.parse(entrada); } catch { process.exit(0); }

function esTascaNoticies(transcript) {
  if (!transcript) return false;
  try {
    const fd = openSync(transcript, 'r');
    const buf = Buffer.alloc(65536);
    const n = readSync(fd, buf, 0, buf.length, 0);
    closeSync(fd);
    for (const linia of buf.subarray(0, n).toString('utf8').split('\n')) {
      let e; try { e = JSON.parse(linia); } catch { continue; }
      if (e.type !== 'user') continue;
      const c = e.message?.content;
      const text = typeof c === 'string' ? c : Array.isArray(c) ? (c.find(b => b.type === 'text')?.text || '') : '';
      return text.trimStart().startsWith('<scheduled-task name="noticies-en-catala"');
    }
  } catch { /* sense transcripció llegible: no hi intervenim */ }
  return false;
}

if (!esTascaNoticies(dades.transcript_path)) process.exit(0);

const ordre = String(dades.tool_input?.command || '').trim();
if (PERMESES.test(ordre)) process.exit(0);

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason:
      `A la tasca programada només es pot executar "node scripts/baixa.mjs", "node scripts/publica.mjs --dry-run" i ` +
      `"node scripts/publica.mjs", exactament així. Per comprovar els fitxers resultat-NN.json fes servir ` +
      `"node scripts/publica.mjs --dry-run". Per llegir fitxers fes servir l'eina Read. Continua amb el procediment.`,
  },
}));
