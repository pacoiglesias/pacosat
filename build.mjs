import { readFileSync, writeFileSync } from 'node:fs';
const read = name => readFileSync(new URL(name, import.meta.url), 'utf8');
const write = (name, content) => writeFileSync(new URL(name, import.meta.url), content);
/* Metadatos de la copia (1.6.6): la versión sale de package.json y la
   creación del software es la fecha del PRIMER commit del repositorio
   (git log: 483de58 «Initial commit», 8 nov 2026 13:42:35 -06:00), una
   constante documentada, no un dato tecleado. Ambos son funciones del
   árbol: el artefacto generado es reproducible byte a byte en cualquier
   checkout (la regla del diff de CI). La «última modificación» NO va en
   el artefacto: un sello derivado del historial git no es reproducible
   entre checkouts (la publicación aplasta commits con fechas nuevas y
   la CI de la 1.6.6 lo demostró), así que la aporta el servidor al
   servir la copia — la fecha de modificación real del archivo servido
   (buildModified en /api/status) — y en modo local sin servidor esa
   línea se omite, como documenta AUDITORIA §1.6.6. */
const SOFTWARE_CREATED = '2026-11-08T13:42:35-06:00';
const pkg = JSON.parse(read('package.json'));
const meta = 'const PACOSAT_META = ' + JSON.stringify({ version: pkg.version, created: SOFTWARE_CREATED }) + ';\n';
const layout = read('layout.part')
  .replace("img-src data:; base-uri", "img-src data:; frame-src blob:; connect-src 'self'; base-uri")
  .replace('<title>PacoSAT</title>', '<title>PacoSAT</title><!--PACOSAT_TOKEN-->');
const css = ['style.part','design.part','polish.part'].map(read).join('\n');
const script = meta + ['data.part','ui.part','pdf-cloud-ui.part','operations.part','workflows.part','sat-ui.part','monitor-ui.part','coverage-ui.part','settings-ui.part'].map(read).join('\n');
write('Faro-Fiscal.html', layout.replace('/*STYLES*/', () => css).replace('/*SCRIPT*/', () => script));
write('xml-core.mjs', read('data.part') + '\nexport { crc32, parseXml, zipXml, rfcCheckDigit, validateRfc };\n');
