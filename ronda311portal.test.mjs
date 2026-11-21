import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createSatPortalCfdiFetch } from './sat-portal-cfdi.mjs';
import { createPlaywrightDriverFactory } from './sat-doc-browser.mjs';
import { CIEC_PORTAL } from './sat-ciec.mjs';

/* ================================================================
   Ronda 3.1.1 · PARTE A — calibración del portal: la forma
   CANCELADA de la rejilla de resultados.

   EL FALLO REAL (verificado en vivo el 20 nov 2026 contra el
   portal, con la 3.1.0 ya fusionada): la pasada por estado fijó
   bien el desplegable en «Cancelado» (valor 0) y el portal LISTÓ
   las 5 canceladas recibidas de Mano Fil del 06/11/2026. Pero
   esa rejilla no trae input.ListaFolios ni spans de descarga:
   cada fila trae SOLO el span «Recuperar acuse estatus final»
   (BtnRecuperaAcuseFinal, onclick a
   AcuseSolicitudCancelacion.aspx?Datos=…) y el UUID en un span
   de texto. Verdad del portal: para una recibida cancelada NO
   se ofrece descargar el XML; solo el acuse.

   La 3.1.0 moría ahí: ciecWaitResults esperaba ListaFolios o el
   panel de sin-resultados → expiraba a los 60 s; el caminante
   lanzaba «no terminó», la corrida ABORTABA y nunca corría la
   pasada por folio. ciecRows, que solo leía ListaFolios,
   devolvía 0 filas de un listado con 5.

   QUÉ SE AFIRMA AQUÍ:
   (a) Con la fixture REAL (fixtures/pagina-fallo-310.html, la
       página que el portal entregó en vivo) servida en local y
       el driver REAL de Chromium: ciecWaitResults reconoce la
       rejilla como resultados y ciecRows devuelve las 5
       canceladas como filas-acuse { uuid, url: '', acuseUrl },
       con la URL absoluta del acuse de cada una; y el acuse se
       baja por ciecDownloadAcuse (el mismo canal de descargas
       de la sesión que los RecuperaCfdi). Sin Chromium fiable
       en el entorno, esta prueba se omite con su constancia,
       como las de navegador real de sat-doc-browser.test.mjs.
   (b) El caminante sobre esa forma (réplica declarada abajo):
       las 5 cuentan como encontradas/listadas, NO van a «no
       listadas» ni a «pendientes» por error, la corrida
       CONTINÚA con la pasada por folio para esos ítems, baja
       los 5 acuses (result.acuses) y el veredicto las nombra
       con honestidad («no ofrece su XML; solo el acuse»).
   (c) Mezcla vigente + canceladas: la vigente baja su XML y
       las canceladas su acuse, sin contaminarse.
   (d) Si la pasada por folio SÍ enseña la descarga de una
       listada-solo-acuse, la fila «sube» a descargable y el
       XML baja (absorb mejora la fila; el acuse no se baja).
   (e) Un acuse que el portal no entrega no se inventa: el
       folio queda en listedOnly y la nota lo dice.
   (f) Sin la primitiva ciecDownloadAcuse, el caminante baja
       el acuse con ciecDownloadPdf (el mecanismo de siempre).
   (g) Un fallo DURO sí aborta: si la búsqueda por fecha no
       termina de verdad, la corrida lanza «no terminó», como
       antes — la tolerancia nueva es solo para la forma
       acuse, no un cheque en blanco —.
   (h) El servidor archiva los acuses con el encaje de la casa:
       savePortalAcuses297 los guarda en 'files' y los enlaza
       en 'documents' con clase «Acuse de cancelación» y su
       uuid, y la corrida los reporta («Se bajó el acuse de N
       canceladas») en su diario y su resumen. Se afirma sobre
       la fuente, como la prueba (h) de la ronda 3.1.0.
   ================================================================ */

/* Las 5 canceladas reales del 2026-11-06 (las de la fixture). */
const CINCO = [
  '4C913CF6-0318-42B4-9E75-A4697048150F',
  '77B890AB-126E-4DE2-8248-F459950B4CA9',
  'ADC141AA-AA94-4A83-9134-115180141566',
  '8485826D-FA6A-44F8-B716-121DFCADF631',
  'D251F3BE-32ED-4A4C-873A-AE1A746F398A'];
const VIGENTE_0611 = 'B1VIGENT-0000-4000-8000-202611060001';

const xmlFor = uuid => Buffer.from('<?xml version="1.0" encoding="UTF-8"?>' +
  '<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" Version="4.0" Fecha="2026-11-06T13:41:03">' +
  '<cfdi:Complemento><tfd:TimbreFiscalDigital xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital" UUID="' +
  uuid + '"/></cfdi:Complemento></cfdi:Comprobante>');
/* Un PDF de juguete que pasa las dos guardas de la casa: la del
   caminante (%PDF- al frente) y la del envoltorio/servidor
   (isPdfBuffer de sat-doc-fetch exige además > 512 bytes). */
const pdfFor = uuid => Buffer.from('%PDF-1.4\n' +
  ('% acuse de cancelación de ' + uuid + '\n').repeat(24) + '%%EOF');
const isoDeMx = mx => { const [d, m, y] = String(mx).split('/'); return y + '-' + m + '-' + d; };
const uuidRow = (uuid, extra = {}) => ({ uuid,
  url: 'https://portalcfdi.facturaelectronica.sat.gob.mx/RecuperaCfdi.aspx?Datos=' + uuid, ...extra });
const acuseRow = (uuid, extra = {}) => ({ uuid, url: '', status: '0',
  acuseUrl: 'https://portalcfdi.facturaelectronica.sat.gob.mx/AcuseSolicitudCancelacion.aspx?Datos=' + uuid,
  ...extra });

/* ---------- (a) driver real + fixture real ---------- */

/* Resolución del Chromium, la misma regla que
   sat-doc-browser.test.mjs: solo la caché de Playwright o
   PACOSAT_CHROMIUM_PATH; en CI se omite por diseño. */
const realChromiumPath = () => {
  if (process.env.CI) return null;
  if (process.env.PACOSAT_CHROMIUM_PATH) return process.env.PACOSAT_CHROMIUM_PATH;
  const shellPath = join(homedir(), '.cache/ms-playwright/chromium_headless_shell-1248',
    'chrome-headless-shell-linux64/chrome-headless-shell');
  if (existsSync(shellPath)) return shellPath;
  const fullPath = join(homedir(), '.cache/ms-playwright/chromium-1248',
    'chrome-linux64/chrome');
  return existsSync(fullPath) ? fullPath : null;
};

test('(a) fixture real: wait/rows reconocen las 5 canceladas con su acuse y el acuse baja', async () => {
  const executablePath = realChromiumPath();
  if (!executablePath) {
    console.log('OMITIDA (sin Chromium fiable en este entorno): prueba (a) de la ronda 3.1.1');
    return;
  }
  const html = readFileSync(new URL('./fixtures/pagina-fallo-310.html', import.meta.url), 'utf8');
  const pdfAcuse = pdfFor(CINCO[0]);
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname.endsWith('ConsultaReceptor.aspx')) {
      res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(html);
    } else if (url.pathname.endsWith('AcuseSolicitudCancelacion.aspx')) {
      /* El acuse del portal llega como descarga del navegador:
         así lo captura el canal de la sesión, como los
         RecuperaCfdi. */
      res.setHeader('content-type', 'application/pdf');
      res.setHeader('content-disposition', 'attachment; filename="acuse.pdf"');
      res.end(pdfAcuse);
    } else { res.statusCode = 404; res.end('no'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  let driver = null;
  try {
    driver = await createPlaywrightDriverFactory({ executablePath })();
    const page = await driver.newPage();
    await page.goto(base + '/ConsultaReceptor.aspx');
    assert.equal(await page.ciecWaitResults(15_000), true,
      'la rejilla de canceladas (sin ListaFolios) cuenta como resultados, no expira');
    const { rows, noResults } = await page.ciecRows();
    assert.equal(noResults, false);
    assert.equal(rows.length, 5, 'la rejilla trae exactamente las 5 canceladas');
    assert.deepEqual(rows.map(r => r.uuid).sort(), [...CINCO].sort(),
      'los UUID salen de los spans de texto de cada fila');
    for (const row of rows) {
      assert.equal(row.url, '', 'sin URL de XML: el portal no la ofrece para una cancelada');
      assert.ok(row.acuseUrl.startsWith(base + '/AcuseSolicitudCancelacion.aspx?Datos='),
        'acuseUrl absoluta, resuelta contra la página: ' + row.acuseUrl);
    }
    assert.equal(new Set(rows.map(r => r.acuseUrl)).size, 5,
      'cada fila trae SU acuse (Datos distinto por fila)');
    const acuse = await page.ciecDownloadAcuse(rows[0].acuseUrl);
    assert.deepEqual(acuse, pdfAcuse,
      'el acuse baja por el canal de descargas de la sesión ya autenticada');
  } finally {
    if (driver) await driver.close();
    server.close();
  }
});

/* ---------- (b)–(g) el caminante sobre la forma acuse ---------- */

/* Réplica declarada de la página para el caminante: extiende la
   de la 3.1.0 con la forma calibrada en vivo — el listado por
   fecha con estado «cancelado» enseña filas-acuse (sin url, con
   acuseUrl) y la consulta por folio tolera esa misma forma
   (devuelve la fila del índice tal cual sea) —. */
class FakePortal311Page {
  constructor(script = {}) {
    this.script = script;
    this.currentUrl = 'about:blank';
    this.loggedIn = false;
    this.fielFormVisible = false;
    this.fielFilled = null;
    this.fielError = '';
    this.day = null;
    this.range = null;
    this.estado = 'vigente';
    this.estadoCalls = [];
    this.folioMode = false;
    this.folio = '';
    this.folioQueries = [];
    this.downloads = [];
    this.acuseDownloads = [];
    this.visited = [];
  }
  async goto(url) {
    this.visited.push(url);
    if (url.includes('portalcfdi') && !this.loggedIn)
      this.currentUrl = 'https://cfdiau.sat.gob.mx/nidp/app/login?id=portalcfdi&sid=0';
    else this.currentUrl = url;
  }
  url() { return this.currentUrl; }
  async portalOpenEfirmaDoor() {
    if (this.fielFormVisible) return false;
    this.fielFormVisible = true;
    this.currentUrl = 'https://cfdiau.sat.gob.mx/nidp/app/login?id=fiel_Aviso&sid=0';
    return true;
  }
  async clickButtonFiel() { this.fielFormVisible = true; }
  async fillFielForm(form) { this.fielFilled = form; return { faltan: [] }; }
  async submitFiel() {
    this.fielError = '';
    this.loggedIn = true;
    this.currentUrl = CIEC_PORTAL;
  }
  async divError() { return this.fielError; }
  async text() { return 'Consulta y recuperación de comprobantes'; }
  async ciecClickFechasRadio() { this.folioMode = false; return true; }
  async ciecSetRecibidosDay(day) { this.day = day; return true; }
  async ciecSetEmitidosRange(range) { this.range = range; return true; }
  async ciecSetEstadoComprobante(estado) {
    this.estado = estado;
    this.estadoCalls.push(estado);
    return true;
  }
  async ciecClickFolioRadio() { this.folioMode = true; return true; }
  async ciecSetFolio(uuid) { this.folio = uuid; this.folioQueries.push(uuid); return true; }
  async ciecSearch() {}
  async ciecWaitResults() { return this.script.waitResults !== false; }
  estadoMatch(row) {
    if (this.estado === 'todos') return true;
    if (this.estado === 'cancelado') return row.status === '0';
    return row.status !== '0';
  }
  async ciecRows() {
    const quota = this.script.quota || '';
    if (this.folioMode) {
      const row = (this.script.folioIndex || {})[this.folio];
      const rows = row ? [{ ...row }] : [];
      return { rows, quota, noResults: rows.length === 0 };
    }
    if (this.currentUrl.includes('ConsultaReceptor')) {
      const rows = ((this.script.received || {})[this.day?.iso] || []).filter(r => this.estadoMatch(r));
      return { rows, quota, noResults: rows.length === 0 };
    }
    const fromIso = isoDeMx(this.range?.from || ''), toIso = isoDeMx(this.range?.to || '');
    const rows = (this.script.issued || [])
      .filter(row => row.date >= fromIso && row.date <= toIso)
      .filter(r => this.estadoMatch(r))
      .map(({ date, ...rest }) => rest);
    return { rows, quota, noResults: rows.length === 0 };
  }
  async ciecDownloadXml(url) {
    this.downloads.push(url);
    const uuid = decodeURIComponent(String(url.split('Datos=')[1] || '')).split('&')[0];
    return xmlFor(uuid);
  }
  async ciecDownloadAcuse(url) {
    this.acuseDownloads.push(url);
    const uuid = decodeURIComponent(String(url.split('Datos=')[1] || '')).split('&')[0];
    if ((this.script.failAcuses || []).includes(uuid)) return null;
    return pdfFor(uuid);
  }
  async diagnostics() {
    return { url: this.currentUrl, screenshot: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      html: '<html><body>portal falso 3.1.1</body></html>' };
  }
  async close() {}
}

const makeFetch = (page) => createSatPortalCfdiFetch({
  resolveCredentials: async profile => ({ rfc: profile.rfc, cer: Buffer.from('certificado-de-juguete'),
    key: Buffer.from('llave-de-juguete'), password: 'pw-de-juguete', validUntil: null }),
  launchDriver: async () => ({ newPage: async () => page, close: async () => {} }) });
const hooksFor = () => {
  const steps = [];
  return { steps, hooks: { step: (text, url) => steps.push({ text, url }),
    isCancelled: () => false } };
};
const item = (uuid, direction, issuedAt, extra = {}) => ({ uuid, direction, issuedAt, ...extra });
const itemCancelado = (uuid, direction, issuedAt) => item(uuid, direction, issuedAt, { cancelled: true });

test('(b) el caso real en el caminante: listadas, no descargables por esta vía; la corrida sigue y baja los acuses', async () => {
  const page = new FakePortal311Page({
    received: { '2026-11-06': CINCO.map(u => acuseRow(u)) },
    folioIndex: Object.fromEntries(CINCO.map(u => [u, acuseRow(u)])) });
  const { hooks, steps } = hooksFor();
  const result = await makeFetch(page)({ rfc: 'MFI6212158B4' },
    { items: CINCO.map(u => itemCancelado(u, 'received', '2026-11-06')) }, hooks);
  assert.equal(result.found, 5, 'las 5 cuentan como encontradas/listadas');
  assert.equal(result.downloaded, 0, 'ningún XML: el portal no lo ofrece por esta vía');
  assert.deepEqual(result.files, []);
  assert.deepEqual(result.notListed, [], 'listadas NO son «no listadas»');
  assert.deepEqual(result.missing, [], 'listadas NO son un fallo de descarga');
  assert.deepEqual([...result.listedOnly].sort(), [...CINCO].sort(),
    'las 5 van al cubo honesto de listadas-solo-acuse');
  assert.equal(result.complete, false, 'sin XML no hay corrida completa que fingir');
  assert.deepEqual(page.folioQueries, CINCO,
    'la corrida CONTINÚA: la pasada por folio se intenta para las 5');
  assert.equal(page.downloads.length, 0, 'jamás se pidió un XML que el portal no enseñó');
  assert.equal(page.acuseDownloads.length, 5, 'se bajó el acuse de cada una');
  assert.deepEqual(result.acuses.map(a => a.uuid).sort(), [...CINCO].sort(),
    'los acuses viajan en result.acuses, distinguibles de los XML');
  for (const acuse of result.acuses)
    assert.ok(acuse.buffer.subarray(0, 5).toString('latin1') === '%PDF-', 'cada acuse es un PDF');
  assert.ok(result.notes.some(n => n.includes('no ofrece su XML') && n.includes('se bajó el acuse de 5')),
    'el veredicto honesto las nombra: ' + result.notes.join(' | '));
  assert.ok(steps.some(s => s.text.includes('acuse de 5 canceladas')),
    'el paso final cuenta también los acuses: ' + steps.map(s => s.text).join(' | '));
});

test('(c) mezcla: la vigente baja su XML y las canceladas su acuse', async () => {
  const [c1, c2] = CINCO;
  const page = new FakePortal311Page({
    received: { '2026-11-06': [uuidRow(VIGENTE_0611), acuseRow(c1), acuseRow(c2)] },
    folioIndex: { [c1]: acuseRow(c1), [c2]: acuseRow(c2) } });
  const { hooks } = hooksFor();
  const result = await makeFetch(page)({ rfc: 'MFI6212158B4' }, { items: [
    item(VIGENTE_0611, 'received', '2026-11-06'),
    itemCancelado(c1, 'received', '2026-11-06'),
    itemCancelado(c2, 'received', '2026-11-06')] }, hooks);
  assert.equal(result.found, 3);
  assert.equal(result.downloaded, 1, 'solo la vigente trae XML');
  assert.deepEqual(result.files.map(f => f.uuid), [VIGENTE_0611]);
  assert.deepEqual([...result.listedOnly].sort(), [c1, c2].sort());
  assert.deepEqual(result.acuses.map(a => a.uuid).sort(), [c1, c2].sort());
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.notListed, []);
});

test('(d) si el folio sí enseña la descarga, la fila-acuse sube a descargable y baja el XML', async () => {
  const [uuid] = CINCO;
  const page = new FakePortal311Page({
    received: { '2026-11-06': [acuseRow(uuid)] },
    folioIndex: { [uuid]: uuidRow(uuid) } });
  const { hooks } = hooksFor();
  const result = await makeFetch(page)({ rfc: 'MFI6212158B4' },
    { items: [itemCancelado(uuid, 'received', '2026-11-06')] }, hooks);
  assert.equal(result.downloaded, 1, 'el XML baja por la vía del folio');
  assert.equal(result.complete, true);
  assert.deepEqual(result.listedOnly, [], 'ya no es solo-acuse: absorb mejoró la fila');
  assert.deepEqual(result.acuses, [], 'con XML en la mano, el acuse no se baja');
  assert.equal(page.acuseDownloads.length, 0);
});

test('(e) un acuse que el portal no entrega no se inventa', async () => {
  const [uuid] = CINCO;
  const page = new FakePortal311Page({
    received: { '2026-11-06': [acuseRow(uuid)] },
    folioIndex: { [uuid]: acuseRow(uuid) },
    failAcuses: [uuid] });
  const { hooks } = hooksFor();
  const result = await makeFetch(page)({ rfc: 'MFI6212158B4' },
    { items: [itemCancelado(uuid, 'received', '2026-11-06')] }, hooks);
  assert.deepEqual(result.listedOnly, [uuid], 'sigue listada: eso sí pasó');
  assert.deepEqual(result.acuses, [], 'sin PDF del portal, no hay acuse que guardar');
  assert.deepEqual(result.missing, [], 'no es un fallo de descarga de XML');
  assert.ok(result.notes.some(n => n.includes('no se pudo bajar su acuse')),
    'la nota lo dice tal cual: ' + result.notes.join(' | '));
});

test('(f) sin ciecDownloadAcuse, el acuse baja con ciecDownloadPdf', async () => {
  const [uuid] = CINCO;
  const page = new FakePortal311Page({
    received: { '2026-11-06': [acuseRow(uuid)] },
    folioIndex: { [uuid]: acuseRow(uuid) } });
  page.ciecDownloadAcuse = undefined; /* la página solo ofrece el canal PDF de siempre */
  page.ciecDownloadPdf = async url => { page.acuseDownloads.push(url); return pdfFor(uuid); };
  const { hooks } = hooksFor();
  const result = await makeFetch(page)({ rfc: 'MFI6212158B4' },
    { items: [itemCancelado(uuid, 'received', '2026-11-06')] }, hooks);
  assert.equal(result.acuses.length, 1, 'el acuse bajó por el mecanismo de RecuperaCfdi');
  assert.deepEqual(result.listedOnly, [uuid]);
});

test('(g) un fallo duro sí aborta: la búsqueda que de verdad no termina lanza «no terminó»', async () => {
  const page = new FakePortal311Page({
    received: { '2026-11-06': [acuseRow(CINCO[0])] },
    waitResults: false });
  const { hooks } = hooksFor();
  await assert.rejects(
    makeFetch(page)({ rfc: 'MFI6212158B4' },
      { items: [itemCancelado(CINCO[0], 'received', '2026-11-06')] }, hooks),
    error => error.code === 'respuesta-inesperada' && /no terminó/.test(error.message),
    'sin resultados de ninguna forma, la corrida aborta como siempre');
});

/* ---------- (h) el encaje del acuse en el servidor ---------- */

test('(h) el servidor archiva el acuse enlazado a su UUID y la corrida lo reporta', () => {
  const server = readFileSync(new URL('./local-server.mjs', import.meta.url), 'utf8');
  assert.ok(server.includes('function savePortalAcuses297('),
    'existe el guardado de acuses del portal');
  assert.ok(server.includes("kind: 'Acuse de cancelación'"),
    'el documento nace con su clase propia, no como «Factura PDF»');
  assert.ok(server.includes("'acuse:' + randomUUID()"),
    'el fichero va a la tienda files bajo un id propio «acuse:»');
  assert.ok(/savePortalAcuses297\(result\.acuses, rfc, items/.test(server),
    'runPortalAttempt297 archiva los acuses que trae el resultado de la corrida');
  assert.ok(server.includes("'Se bajó el acuse de ' + acusesGuardados"),
    'la corrida reporta los acuses en su diario');
  assert.ok(server.includes("' · Se bajó el acuse de ' + acusesGuardados"),
    'y también en el resumen final de la corrida');
  const envoltorio = readFileSync(new URL('./sat-doc-browser.mjs', import.meta.url), 'utf8');
  assert.ok(envoltorio.includes('async ciecDownloadAcuse('),
    'la primitiva del acuse vive en el envoltorio');
  assert.ok(envoltorio.includes('BtnRecuperaAcuseFinal'),
    'wait/rows reconocen el span del acuse de la forma cancelada');
  const motor = readFileSync(new URL('./sat-portal-cfdi.mjs', import.meta.url), 'utf8');
  assert.ok(motor.includes('listedOnly') && motor.includes('acuses'),
    'el caminante devuelve listedOnly y acuses en su resultado');
});
