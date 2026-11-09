import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const read = name => readFileSync(new URL(name, import.meta.url), 'utf8');
const write = (name, content) => writeFileSync(new URL(name, import.meta.url), content);
/* Metadatos de la copia (1.6.6): la versión sale de package.json; la
   creación del software es la fecha del PRIMER commit del repositorio
   (git log: 483de58 «Initial commit», 8 nov 2026 13:42:35 -06:00), una
   constante documentada, no un dato tecleado; el sello de modificación
   es la fecha del último commit sin fusionar que tocó las fuentes
   (determinista para un mismo árbol: regenerar sin cambios no lo mueve
   y el diff de CI sigue limpio). Sin historial git (copia exportada) se
   conserva el sello de la copia anterior; nunca se inventa. */
const SOFTWARE_CREATED = '2026-11-08T13:42:35-06:00';
function buildStamp() {
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%cI', '--no-merges', '--', '.',
      ':(exclude)Faro-Fiscal.html', ':(exclude)xml-core.mjs'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (out) return out;
  } catch { /* sin git o sin historial útil: se conserva el sello anterior */ }
  try {
    const previous = read('Faro-Fiscal.html').match(/"modified":\s*"([^"]+)"/);
    if (previous) return previous[1];
  } catch { /* primera generación sin copia previa */ }
  return new Date().toISOString();
}
const pkg = JSON.parse(read('package.json'));
const meta = 'const PACOSAT_META = ' + JSON.stringify({ version: pkg.version, created: SOFTWARE_CREATED, modified: buildStamp() }) + ';\n';
const layout = read('layout.part')
  .replace("img-src data:; base-uri", "img-src data:; frame-src blob:; connect-src 'self'; base-uri")
  .replace('<title>PacoSAT</title>', '<title>PacoSAT</title><!--PACOSAT_TOKEN-->');
const css = ['style.part','design.part','polish.part'].map(read).join('\n');
const script = meta + ['data.part','ui.part','pdf-cloud-ui.part','operations.part','workflows.part','sat-ui.part','monitor-ui.part','coverage-ui.part','settings-ui.part'].map(read).join('\n');
write('Faro-Fiscal.html', layout.replace('/*STYLES*/', () => css).replace('/*SCRIPT*/', () => script));
write('xml-core.mjs', read('data.part') + '\nexport { crc32, parseXml, zipXml, rfcCheckDigit, validateRfc };\n');
