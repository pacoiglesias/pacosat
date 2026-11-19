import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { DOMParser } from '@xmldom/xmldom';
import { createPacoSATService } from './local-server.mjs';

/* ================================================================
   Ronda 2.9.6 — R3, la pieza que sobrevivió a la 2.9.3 y a la
   2.9.5: la Opinión archivada seguía «Su sentido no consta»
   en vivo aunque su documento dice el sentido en la primera
   página.

   CAUSA RAÍZ PROBADA CON LA COPIA VIVA REAL (18 nov 2026):
   el PDF vivo de la Opinión (bajada del portal el 16 nov),
   pasado por el extractor REAL de la casa, dice en su
   cabecera: «Opinión del cumplimiento de obligaciones
   fiscales Nombre, denominación o razón social Sentido
   MANO FIL SA POSITIVO RFC Folio …» — el SAT escribe el
   sentido como POSITIVO (masculino). TODOS los lectores de
   sentido de la casa buscaban solo la forma femenina
   (POSITIVA/NEGATIVA): el sentido quedó '' al archivar y
   el relleno (rellenarSentidosOpinion293) nunca pudo
   rellenarlo. La 2.9.5 normalizó el string/array del
   extractor — verdad, pero no bastaba — y su suite pasó
   porque su fixture traía «POSITIVA» escrita a mano.

   ESTA VEZ LA FIXTURE ES LA FORMA REAL: el texto extraído
   de la copia viva, enmascarado (razón social, RFC y folio
   sustituidos; la estructura «Sentido … POSITIVO» intacta),
   en fixtures/opinion-texto-real-enmascarado.txt. La suite
   lo mete en un PDF de verdad (texto comprimido
   FlateDecode, como el del SAT) y lo alimenta por el MISMO
   camino que usa el relleno en producción: el archivo
   guardado en records → satDocSentidoTexto290 con el
   extractor real → la lectura de /api/satdocs. Nada de
   reimplementar el lector dentro de la prueba.

   EL ARREGLO: el lector acepta las cuatro formas
   (POSITIVO/POSITIVA/NEGATIVO/NEGATIVA) en ambos caminos
   (texto extraído y bytes crudos), con preferencia por el
   contexto del campo: tras la etiqueta «Sentido», el valor
   es el primer POSITIV[AO]/NEGATIV[AO] de los ~120
   caracteres siguientes (entre la etiqueta y el valor
   viaja la razón social); sin etiqueta o sin valor en esa
   ventana, se busca en todo el texto con la precedencia
   de siempre (positivo antes que negativo).
   ================================================================ */

const AQUI = dirname(fileURLToPath(import.meta.url));
const ORIGIN = 'https://pacosat.test';
const KEY = 'b'.repeat(64);
const OWN = 'AAA010101AAA';
const TEXTO_REAL = readFileSync(join(AQUI, 'fixtures', 'opinion-texto-real-enmascarado.txt'), 'utf8')
  .replace(/\s+/g, ' ').trim();

/* ================================================================
   Arnés de servicio (el de la casa, con reloj mutable)
   ================================================================ */
function makeHarness(options = {}) {
  const clock = { t: options.start ?? Date.parse('2026-11-18T15:00:00Z') };
  const mails = [];
  const service = createPacoSATService({
    dbFile: options.dbFile || ':memory:',
    html: options.html || '<html><head><!--PACOSAT_TOKEN--></head><body>prueba</body></html>',
    origin: ORIGIN, proxyKey: KEY, satDocRetryWaitMs: 5,
    makeConnector: () => ({ parser: DOMParser, connector: {
      request: async () => 'req-296', check: async () => ({ status: 'pending', packages: [] }),
      download: async () => { throw new Error('sin paquetes'); } } }),
    makeMailer: () => ({ verify: async () => true,
      sendMail: async payload => { mails.push(payload); return { messageId: 'm' + mails.length }; } }),
    now: () => clock.t, ...options.serviceOptions });
  let token = '';
  const raw = async (method, path, bodyText, extraHeaders = {}) => {
    const chunks = []; if (bodyText !== undefined && bodyText !== null && bodyText !== '')
      chunks.push(Buffer.from(String(bodyText)));
    const req = Readable.from(chunks);
    req.method = method; req.url = path;
    req.headers = { host: 'pacosat.test', origin: ORIGIN, 'x-pacosat-proxy': KEY, ...extraHeaders };
    let status = 0; const headers = {}; let text = '';
    const res = { writeHead(code, hdrs) { status = code; if (hdrs) Object.assign(headers, hdrs); },
      setHeader(k, v) { headers[k] = v; }, getHeader(k) { return headers[k]; },
      end(chunk) { if (chunk) text += Buffer.isBuffer(chunk) ? chunk.toString('latin1') : chunk; } };
    await service.handle(req, res);
    return { status, text, headers };
  };
  const call = async (method, path, body, extraHeaders = {}) => {
    if (!token) { const home = await raw('GET', '/'); token = /[0-9a-f]{64}/.exec(home.text)?.[0] || ''; }
    const r = await raw(method, path, body === undefined ? undefined : JSON.stringify(body),
      { 'x-pacosat-token': token, ...extraHeaders });
    let json = null; try { json = JSON.parse(r.text); } catch { /* binario */ }
    return { status: r.status, json, text: r.text };
  };
  return { service, call, raw, clock, mails,
    token: () => token };
}
const unlock = async (h, rfc = OWN) => {
  const open = await h.call('POST', '/api/unlock', { rfc, minutes: 1440, days: 7,
    direction: 'both', password: 'simulated', certificate: 'YQ==', key: 'Yg==' });
  assert.equal(open.status, 200, 'unlock de ' + rfc);
};

/* Un PDF de verdad, mínimo, con el texto dado COMPRIMIDO
   (FlateDecode): en crudo no se lee el sentido — como el
   del SAT — y solo el extractor de texto lo saca. El texto
   se trocea por palabras para que quepa en las cadenas del
   contenido, escapando los paréntesis del literal PDF. */
function pdfConTexto296(texto) {
  const palabras = String(texto).replace(/\s+/g, ' ').trim().split(' ');
  const lineas = [];
  let linea = '';
  for (const p of palabras) {
    if ((linea + ' ' + p).trim().length > 78) { lineas.push(linea.trim()); linea = p; }
    else linea = (linea + ' ' + p).trim();
  }
  if (linea.trim()) lineas.push(linea.trim());
  const esc = s => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const plano = ['BT /F1 10 Tf 40 780 Td',
    ...lineas.map((l, i) => (i ? '0 -13 Td ' : '') + '(' + esc(l) + ') Tj'), 'ET'].join('\n');
  const stream = deflateSync(Buffer.from(plano, 'latin1'));
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    Buffer.concat([Buffer.from('<< /Length ' + stream.length + ' /Filter /FlateDecode >>\nstream\n', 'latin1'),
      stream, Buffer.from('\nendstream', 'latin1')]),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const partes = [Buffer.from('%PDF-1.4\n', 'latin1')];
  const offsets = [];
  objs.forEach((cuerpo, i) => {
    offsets.push(partes.reduce((s, p) => s + p.length, 0));
    partes.push(Buffer.from((i + 1) + ' 0 obj\n', 'latin1'),
      Buffer.isBuffer(cuerpo) ? cuerpo : Buffer.from(cuerpo, 'latin1'),
      Buffer.from('\nendobj\n', 'latin1'));
  });
  const xref = partes.reduce((s, p) => s + p.length, 0);
  partes.push(Buffer.from('xref\n0 ' + (objs.length + 1) + '\n0000000000 65535 f \n' +
    offsets.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('') +
    'trailer\n<< /Size ' + (objs.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF', 'latin1'));
  return Buffer.concat(partes);
}

/* Siembra una copia de Opinión YA archivada SIN sentido
   (la forma exacta en que quedó la copia viva del 16 nov)
   y devuelve el arnés con su BD en disco. */
async function sembrarCopiaSinSentido296(pdf, sello) {
  const dir = mkdtempSync(join(tmpdir(), 'pacosat-296' + sello + '-'));
  const dbFile = join(dir, 'pacosat.sqlite');
  const h = makeHarness({ dbFile });
  await unlock(h);
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbFile);
  const fileId = 'pdf:copia-viva-296' + sello;
  const ahora = Date.parse('2026-11-16T21:21:00Z');
  db.prepare("INSERT OR REPLACE INTO records(store,id,value,data,mime) VALUES ('files',?,NULL,?,'application/pdf')")
    .run(fileId, new Uint8Array(pdf));
  db.prepare("INSERT OR REPLACE INTO records(store,id,value) VALUES ('documents',?,?)")
    .run(fileId, JSON.stringify({ id: fileId, rfc: OWN, kind: 'Opinión de cumplimiento',
      date: '2026-11-16', sentido: '', vigencia: '' }));
  db.prepare('INSERT INTO sat_documents(id,rfc,kind,issuedAt,fileId,source,created) VALUES (?,?,?,?,?,?,?)')
    .run('doc-copia-viva-296' + sello, OWN, 'opinion', ahora, fileId, 'auto', ahora);
  db.close();
  return h;
}

/* ================================================================
   A · EL RELLENO CON LA FORMA REAL: la copia archivada sin
   sentido, con el PDF cuyo texto es EL EXTRAÍDO DE LA
   COPIA VIVA («Sentido … POSITIVO»), se rellena AL LEER
   Documentos y queda guardado. En la 2.9.5 el lector solo
   buscaba POSITIVA: el sentido quedaba '' (rojo).
   ================================================================ */
{
  assert.ok(TEXTO_REAL.includes('Sentido') && TEXTO_REAL.includes('POSITIVO'),
    '296: la fixture trae la forma real («Sentido … POSITIVO»)');
  assert.ok(!/POSITIVA|NEGATIV/.test(TEXTO_REAL),
    '296: la fixture NO trae ninguna forma femenina: es la forma exacta del fallo en vivo');
  const pdf = pdfConTexto296(TEXTO_REAL);
  assert.ok(!pdf.toString('latin1').includes('POSITIVO'),
    '296: en crudo el PDF no enseña su sentido (comprimido, como el del SAT)');
  const h = await sembrarCopiaSinSentido296(pdf, 'a');
  try {
    const vista = (await h.call('GET', '/api/satdocs')).json;
    assert.equal(vista.profiles[0].opinion.sentido, 'positiva',
      '296-A: al leer Documentos, la copia sin sentido se rellena desde su propio PDF con el texto REAL («Sentido … POSITIVO»)');
    const otra = (await h.call('GET', '/api/satdocs')).json;
    assert.equal(otra.profiles[0].opinion.sentido, 'positiva',
      '296-A: y queda guardado, no se re-deriva en cada lectura');
    console.log('OK 2.9.6 · 296-A — Relleno al leer con el texto real de la copia viva: POSITIVO se lee «positiva».');
  } finally { h.service.close(); }
}

/* ================================================================
   B · LA BAJADA REAL CON LA FORMA REAL: el portal entrega
   la Opinión con el texto real y la copia nace CON su
   sentido guardado (el camino de archiveSatDoc, que usa
   el mismo lector). En la 2.9.5 nacía con '' (rojo).
   ================================================================ */
{
  const pdf = pdfConTexto296(TEXTO_REAL);
  const h = makeHarness({ serviceOptions: {
    satDocFetch: async (profile, kind) => kind === 'opinion'
      ? { content: pdf, issuedAt: '2026-11-16', fileName: 'Opinion ' + profile.rfc + '.pdf' }
      : { content: pdf, issuedAt: '2026-11-16', fileName: 'Constancia ' + profile.rfc + '.pdf' } } });
  try {
    await unlock(h);
    const run = await h.call('POST', '/api/satdocs/run', { rfc: OWN, kind: 'opinion' });
    assert.equal(run.status, 200, '296-B: la bajada de la Opinión corre: ' + run.text.slice(0, 160));
    assert.equal(run.json.results?.opinion?.ok, true, '296-B: y archiva el documento');
    const vista = (await h.call('GET', '/api/satdocs')).json;
    assert.equal(vista.profiles[0].opinion.sentido, 'positiva',
      '296-B: la Opinión bajada con el texto real nace con su sentido «positiva» guardado');
    console.log('OK 2.9.6 · 296-B — Bajada real con el texto real: la Opinión nace con su sentido.');
  } finally { h.service.close(); }
}

/* ================================================================
   C · COMPAÑÍA — EL FORMATO ANTIGUO SIGUE LEYENDO: un
   texto con «Sentido: POSITIVA» (la forma de la fixture
   de la 2.9.5) sigue saliendo «positiva» por el relleno.
   ================================================================ */
{
  const pdf = pdfConTexto296('Opinion del cumplimiento de obligaciones fiscales ' +
    'Nombre, denominación o razón social Sentido: POSITIVA Folio: 26NQI411794');
  const h = await sembrarCopiaSinSentido296(pdf, 'c');
  try {
    const vista = (await h.call('GET', '/api/satdocs')).json;
    assert.equal(vista.profiles[0].opinion.sentido, 'positiva',
      '296-C: el formato antiguo («Sentido: POSITIVA») sigue leyendo «positiva»');
    console.log('OK 2.9.6 · 296-C — Formato antiguo: «POSITIVA» sigue leyendo «positiva».');
  } finally { h.service.close(); }
}

/* ================================================================
   D · COMPAÑÍA — NEGATIVO TRAS LA ETIQUETA: el SAT también
   escribirá «Sentido … NEGATIVO» cuando toque; el relleno
   debe leer «negativa». En la 2.9.5 quedaba '' (rojo).
   ================================================================ */
{
  const pdf = pdfConTexto296('Opinion del cumplimiento de obligaciones fiscales ' +
    'Nombre, denominación o razón social Sentido EMPRESA DE PRUEBA SA NEGATIVO RFC Folio 000000000000');
  const h = await sembrarCopiaSinSentido296(pdf, 'd');
  try {
    const vista = (await h.call('GET', '/api/satdocs')).json;
    assert.equal(vista.profiles[0].opinion.sentido, 'negativa',
      '296-D: «Sentido … NEGATIVO» lee «negativa»');
    console.log('OK 2.9.6 · 296-D — «Sentido … NEGATIVO» lee «negativa».');
  } finally { h.service.close(); }
}

/* ================================================================
   E · LA VENTANA DE LA ETIQUETA MANDA: si tras «Sentido»
   el valor es NEGATIVO, un POSITIVO que aparezca DESPUÉS
   en el cuerpo no puede voltear la lectura (la búsqueda
   general daría positivo por precedencia). El contexto
   del campo es la verdad del documento.
   ================================================================ */
{
  const pdf = pdfConTexto296('Opinion del cumplimiento de obligaciones fiscales ' +
    'Nombre, denominación o razón social Sentido EMPRESA DE PRUEBA SA NEGATIVO RFC Folio 000000000000 ' +
    'Se le informa que no se encuentra al corriente. Este párrafo menciona la palabra POSITIVO ' +
    'mucho después, fuera del campo, y no debe mandar sobre el valor del campo Sentido.');
  const h = await sembrarCopiaSinSentido296(pdf, 'e');
  try {
    const vista = (await h.call('GET', '/api/satdocs')).json;
    assert.equal(vista.profiles[0].opinion.sentido, 'negativa',
      '296-E: el valor tras la etiqueta «Sentido» manda sobre cualquier mención posterior');
    console.log('OK 2.9.6 · 296-E — La ventana de la etiqueta manda: NEGATIVO en el campo, «negativa».');
  } finally { h.service.close(); }
}

/* ================================================================
   F · SIN SENTIDO NO SE INVENTA: un texto sin ninguna de
   las cuatro formas deja el sentido como está ('').
   ================================================================ */
{
  const pdf = pdfConTexto296('Opinion del cumplimiento de obligaciones fiscales ' +
    'Nombre, denominación o razón social RFC Folio 000000000000 ' +
    'Documento sin el campo de sentido legible en esta copia.');
  const h = await sembrarCopiaSinSentido296(pdf, 'f');
  try {
    const vista = (await h.call('GET', '/api/satdocs')).json;
    assert.equal(vista.profiles[0].opinion.sentido || '', '',
      '296-F: sin sentido en el documento, no se inventa ninguno');
    console.log('OK 2.9.6 · 296-F — Sin sentido en el texto: queda vacío, nada inventado.');
  } finally { h.service.close(); }
}
