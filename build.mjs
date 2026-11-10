import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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
/* Documento vivo de capacidades (1.6.9): la FUENTE es docs/CAPACIDADES.md
   y la pantalla «Qué incluye PacoSAT» se genera desde ella en cada build
   (nada de texto duplicado a mano en un .part). El parser acepta el
   formato del documento: secciones «## Título», viñetas «- ✅/🔄/📋 texto»
   y párrafos sueltos; la fecha de última actualización sale de la línea
   «**Última modificación: …**» del propio documento. */
function parseCapacidades(markdown) {
  const updated = (markdown.match(/\*\*Última modificación:\s*([^*]+)\*\*/) || [])[1]?.trim() || '';
  const sections = [];
  let current = null, paragraph = [];
  const flushParagraph = () => {
    if (current && paragraph.length) current.blocks.push({ type: 'p', text: paragraph.join(' ') });
    paragraph = [];
  };
  for (const rawLine of markdown.split('\n')) {
    const line = rawLine.trim();
    const heading = line.match(/^##\s+(.*)$/);
    if (heading) { flushParagraph(); current = { title: heading[1].trim(), blocks: [] }; sections.push(current); continue; }
    if (!current) continue;
    if (line.startsWith('# ')) continue;
    const item = line.match(/^-\s+(✅|🔄|📋)\s*(.*)$/);
    if (item) { flushParagraph(); current.blocks.push({ type: 'item', state: item[1], text: item[2].trim() }); continue; }
    if (line.startsWith('- ')) { flushParagraph(); current.blocks.push({ type: 'item', state: '', text: line.slice(2).trim() }); continue; }
    if (!line) { flushParagraph(); continue; }
    if (line.startsWith('**Última modificación') || line.startsWith('Estados:')) continue;
    paragraph.push(line.replace(/\*\*/g, ''));
  }
  flushParagraph();
  return { updated, sections: sections.filter(section => section.blocks.length) };
}
const capacidades = existsSync(new URL('docs/CAPACIDADES.md', import.meta.url)) ?
  parseCapacidades(read('docs/CAPACIDADES.md')) : { updated: '', sections: [] };
const capacidadesConst = 'const PACOSAT_CAPACIDADES = ' + JSON.stringify(capacidades) + ';\n';
const css = ['style.part','design.part','polish.part'].map(read).join('\n');
const script = meta + capacidadesConst + ['data.part','ui.part','pdf-cloud-ui.part','operations.part','workflows.part','sat-ui.part','satdocs-ui.part','declaraciones-ui.part','monitor-ui.part','coverage-ui.part','settings-ui.part','lists-ui.part','outputs-ui.part','money-ui.part','visor-ui.part','pagos-ui.part','compliance-ui.part','banks-ui.part','final-ui.part','avisos-ui.part','capacidades-ui.part'].map(read).join('\n');
/* CSP estricta sin unsafe-inline (1.6.9): la app es un único bloque
   <style> y un único bloque <script>, ambos funciones puras del árbol,
   así que la política los autoriza por su huella SHA-256 exacta. Sin
   'unsafe-inline': cualquier script o estilo inyectado que no sea
   byte a byte el de esta copia queda bloqueado por el navegador. El
   servidor calcula la MISMA política desde el archivo servido (ver
   cspForHtml en local-server.mjs) y verify.cjs comprueba que ambas
   coinciden y que ningún 'unsafe-inline' sobrevive. Los estilos en
   atributo (style="…") no se usan en la app: el código pinta con
   clases y con propiedades del DOM, que la CSP no restringe. */
const sha256 = text => "'sha256-" + createHash('sha256').update(text, 'utf8').digest('base64') + "'";
const policy = "default-src 'none'; style-src " + sha256(css) + "; script-src " + sha256(script) +
  "; img-src data: blob:; frame-src blob:; connect-src 'self'; base-uri 'none'; form-action 'none'";
const layout = read('layout.part')
  .replace(/<meta http-equiv="Content-Security-Policy" content="[^"]*">/,
    '<meta http-equiv="Content-Security-Policy" content="' + policy + '">')
  .replace('<title>PacoSAT</title>', '<title>PacoSAT</title><!--PACOSAT_TOKEN-->');
if (layout.includes('unsafe-inline')) throw new Error('La CSP generada no debe contener unsafe-inline.');
write('Faro-Fiscal.html', layout.replace('/*STYLES*/', () => css).replace('/*SCRIPT*/', () => script));
write('xml-core.mjs', read('data.part') + '\nexport { crc32, parseXml, parseCfdiFull, fiscalSummary, withFiscal, moneyCents, zipXml, zipText, rfcCheckDigit, validateRfc };\n');
