import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createSatPortalCfdiFetch } from './sat-portal-cfdi.mjs';
import { createPlaywrightDriverFactory } from './sat-doc-browser.mjs';
import { CIEC_PORTAL } from './sat-ciec.mjs';

/* ================================================================
   Ronda 2.9.7 · Pieza A — motor del portal CFDI con e.firma.

   RÉPLICA DECLARADA: ningún canal de recon alcanzó la sección
   en vivo desde este asiento (nota A0 de la ronda:
   ~/workspace/pacosat-297-nota-A0.md), así que la suite corre
   contra FakePortalFielPage, la extensión DECLARADA de la
   FakePortalPage de sat-ciec.test.mjs (que no se exporta desde
   aquel archivo — corre su propia suite al importarlo —, por
   lo que aquí se reproduce su contrato ciec* y se extiende):

   - Sin sesión, cualquier dirección de portalcfdi redirige al
     NIDP de cfdiau (id=portalcfdi), como la réplica CIEC.
   - La PUERTA de e.firma: portalOpenEfirmaDoor() pulsa el
     control de acceso con e.firma de la puerta de contraseña y
     el formulario FIEL queda a la vista (variante fiel_Aviso
     del NIDP); la elección queda pegajosa en la réplica — es
     una SUPOSICIÓN declarada, frontera de calibración nº 1 —.
   - satBrowserLogin camina con sus primitivas de siempre:
     clickButtonFiel / fillFielForm (devuelve { faltan: [] }) /
     submitFiel / divError / text / diagnostics.
   - Tras el acceso sirve ConsultaReceptor (filas por día) y
     ConsultaEmisor (filas por rango, con su fecha interna para
     filtrar; las filas devueltas llevan { uuid, url, pdfUrl? },
     la forma de ciecRows), registra TODAS las URLs visitadas
     (goto, puerta, envío, descargas) y cuenta las descargas.
   - script.rejectFiel hace que el portal rechace la e.firma
     (divError del NIDP); script.issuedBulkWindow modela la
     ventana mensual que devuelve el tope de 500 filas.
   ================================================================ */

const xmlFor = uuid => Buffer.from('<?xml version="1.0" encoding="UTF-8"?>' +
  '<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" Version="4.0" Fecha="2026-11-05T10:00:00">' +
  '<cfdi:Complemento><tfd:TimbreFiscalDigital xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital" UUID="' +
  uuid + '"/></cfdi:Complemento></cfdi:Comprobante>');
const PDF_FAKE = Buffer.concat([Buffer.from('%PDF-1.4 documento de juguete\n'), Buffer.alloc(600, 0x2e)]);
const isoDeMx = mx => { const [d, m, y] = String(mx).split('/'); return y + '-' + m + '-' + d; };
const uuidRow = (uuid, extra = {}) => ({ uuid,
  url: 'https://portalcfdi.facturaelectronica.sat.gob.mx/RecuperaCfdi.aspx?Datos=' + uuid, ...extra });

/* Base: la réplica del portal según el contrato de sat-ciec. */
class FakePortalPage {
  constructor(script = {}) {
    this.script = script;
    this.currentUrl = 'about:blank';
    this.loggedIn = false;
    this.login = null;
    this.error = '';
    this.day = null;
    this.range = null;
    this.downloads = [];
    this.visited = [];
  }
  async goto(url) {
    this.visited.push(url);
    if (url.includes('portalcfdi') && !this.loggedIn)
      this.currentUrl = 'https://cfdiau.sat.gob.mx/nidp/app/login?id=portalcfdi&sid=0';
    else this.currentUrl = url;
  }
  url() { return this.currentUrl; }
  async ciecHasLoginForm() { return this.currentUrl.includes('cfdiau'); }
  async ciecCaptchaImage() { return 'data:image/png;base64,CAPTCHAFAKE'; }
  async ciecFillLogin(values) { this.login = { ...this.login, ...values }; return { rfc: true, password: true, captcha: true }; }
  async ciecSubmitLogin() { this.loggedIn = true; this.currentUrl = CIEC_PORTAL; }
  async ciecErrorText() { return this.error; }
  async ciecClickFechasRadio() { return true; }
  async ciecSetRecibidosDay(day) { this.day = day; return true; }
  async ciecSetEmitidosRange(range) { this.range = range; return true; }
  async ciecSearch() {}
  async ciecWaitResults() { return true; }
  async ciecRows() {
    if (this.currentUrl.includes('ConsultaReceptor')) {
      const rows = (this.script.received || {})[this.day?.iso] || [];
      return { rows, quota: this.script.quota || '', noResults: rows.length === 0 };
    }
    const rows = this.script.issued || [];
    return { rows, quota: this.script.quota || '', noResults: rows.length === 0 };
  }
  async ciecDownloadXml(url) {
    this.visited.push(url);
    this.downloads.push(url);
    const uuid = decodeURIComponent(String(url.split('Datos=')[1] || '')).split('&')[0];
    if ((this.script.failDownloads || []).includes(uuid)) return null;
    return xmlFor(uuid);
  }
  async diagnostics() {
    return { url: this.currentUrl, screenshot: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      html: '<html><body>portal falso fiel · ' + this.currentUrl + '</body></html>' };
  }
  async close() {}
}

/* Extensión FIEL: puerta de e.firma + acceso satBrowserLogin +
   filas emitidas por rango con fecha + PDF por fila. */
class FakePortalFielPage extends FakePortalPage {
  constructor(script = {}) {
    super(script);
    this.doorOpened = false;
    this.fielFormVisible = false;
    this.fielFilled = null;
    this.fielError = '';
    this.pdfDownloads = [];
    this.driverClosed = false;
  }
  async portalOpenEfirmaDoor() {
    if (this.fielFormVisible) return false;
    if (!this.currentUrl.includes('cfdiau') && !this.currentUrl.includes('portalcfdi')) return false;
    this.doorOpened = true;
    this.fielFormVisible = true;
    this.currentUrl = 'https://cfdiau.sat.gob.mx/nidp/app/login?id=fiel_Aviso&sid=0';
    this.visited.push(this.currentUrl);
    return true;
  }
  async clickButtonFiel() { this.fielFormVisible = true; }
  async fillFielForm(form) { this.fielFilled = form; return { faltan: [] }; }
  async submitFiel() {
    if (this.script.rejectFiel) {
      this.fielError = 'Certificado, clave privada o contraseña de clave privada inválidos';
      return;
    }
    this.fielError = '';
    this.loggedIn = true;
    this.currentUrl = CIEC_PORTAL;
    this.visited.push(this.currentUrl);
  }
  async divError() { return this.fielError; }
  async text() {
    return this.loggedIn ? 'Consulta y recuperación de comprobantes'
      : 'SAT Autenticación · Acceso por contraseña · e.firma';
  }
  async ciecRows() {
    if (this.currentUrl.includes('ConsultaReceptor')) return super.ciecRows();
    const fromIso = isoDeMx(this.range?.from || ''), toIso = isoDeMx(this.range?.to || '');
    if (this.script.issuedBulkWindow && fromIso !== toIso) {
      return { rows: this.script.issuedBulkWindow, quota: this.script.quota || '', noResults: false };
    }
    const rows = (this.script.issued || [])
      .filter(row => row.date >= fromIso && row.date <= toIso)
      .map(({ date, ...rest }) => rest);
    return { rows, quota: this.script.quota || '', noResults: rows.length === 0 };
  }
  async ciecDownloadPdf(url) {
    this.visited.push(url);
    this.pdfDownloads.push(url);
    return PDF_FAKE;
  }
}

const makeFetch = (page, extra = {}) => createSatPortalCfdiFetch({
  resolveCredentials: async profile => ({ rfc: profile.rfc, cer: Buffer.from('certificado-de-juguete'),
    key: Buffer.from('llave-de-juguete'), password: 'pw-de-juguete', validUntil: null, ...extra.creds }),
  launchDriver: async () => ({ newPage: async () => page,
    close: async () => { page.driverClosed = true; } }),
  ...extra.factory });

const hooksFor = (isCancelled) => {
  const steps = [];
  return { steps, hooks: { step: (text, url) => steps.push({ text, url }),
    isCancelled: isCancelled || (() => false) } };
};
const item = (uuid, direction, issuedAt) => ({ uuid, direction, issuedAt });

/* (a) Camino feliz mixto: 3 recibidos en 2 días + 2 emitidos,
   todos bajados, 1 con PDF. */
test('(a) camino feliz mixto: recibidos por día + emitidos por ventana, con un PDF', async () => {
  const page = new FakePortalFielPage({
    received: { '2026-11-08': [uuidRow('UUID-R1'), uuidRow('UUID-R2')],
      '2026-11-09': [uuidRow('UUID-R3')] },
    issued: [
      { ...uuidRow('UUID-I1', { pdfUrl: 'https://portalcfdi.facturaelectronica.sat.gob.mx/RecuperaCfdi.aspx?Datos=UUID-I1&tipo=pdf' }), date: '2026-11-10' },
      { ...uuidRow('UUID-I2'), date: '2026-11-12' }] });
  const { hooks, steps } = hooksFor();
  const fetch = makeFetch(page);
  const result = await fetch({ rfc: 'MFI6212158B4' }, { items: [
    item('UUID-R1', 'received', '2026-11-08'), item('UUID-R2', 'received', '2026-11-08'),
    item('UUID-R3', 'received', '2026-11-09'),
    item('UUID-I1', 'issued', '2026-11-10'), item('UUID-I2', 'issued', '2026-11-12')] }, hooks);
  assert.equal(result.found, 5);
  assert.equal(result.downloaded, 5);
  assert.equal(result.quotaUsed, 5);
  assert.equal(result.complete, true);
  assert.deepEqual(result.notListed, []);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.files.map(f => f.uuid),
    ['UUID-R1', 'UUID-R2', 'UUID-R3', 'UUID-I1', 'UUID-I2'], 'los archivos salen en el orden pedido');
  const conPdf = result.files.find(f => f.uuid === 'UUID-I1');
  assert.ok(Buffer.isBuffer(conPdf.pdf) && conPdf.pdf.subarray(0, 5).toString('latin1') === '%PDF-',
    'la fila con pdfUrl bajó también su PDF');
  assert.equal(page.pdfDownloads.length, 1, 'solo se pidió el PDF de la fila que lo traía');
  for (const f of result.files.filter(f => f.uuid !== 'UUID-I1'))
    assert.equal(f.pdf, undefined, 'sin pdfUrl no hay PDF ni nota: ' + f.uuid);
  assert.ok(result.notes.every(n => !/pdf/i.test(n)), 'ninguna nota habla de PDF');
  assert.equal(page.doorOpened, true, 'la puerta de e.firma se abrió antes del acceso FIEL');
  assert.ok(page.fielFilled && page.fielFilled.rfc === 'MFI6212158B4', 'el formulario FIEL recibió el RFC');
  assert.ok(steps.some(s => s.text.includes('Ya estás dentro del portal')));
  assert.equal(page.driverClosed, true, 'el navegador se cerró al terminar');
});

/* (b) Un UUID que el portal no lista → notListed, complete=false,
   los demás bajan. */
test('(b) un UUID no listado va a notListed y los demás bajan', async () => {
  const page = new FakePortalFielPage({
    received: { '2026-11-08': [uuidRow('UUID-R1'), uuidRow('UUID-R2')] }, issued: [] });
  const { hooks } = hooksFor();
  const result = await makeFetch(page)({ rfc: 'MFI6212158B4' }, { items: [
    item('UUID-R1', 'received', '2026-11-08'), item('UUID-AUSENTE', 'received', '2026-11-08'),
    item('UUID-R2', 'received', '2026-11-08')] }, hooks);
  assert.deepEqual(result.notListed, ['UUID-AUSENTE']);
  assert.equal(result.found, 2);
  assert.equal(result.downloaded, 2);
  assert.equal(result.complete, false);
  assert.deepEqual(result.missing, []);
  assert.ok(result.notes.some(n => n.includes('no listó')), 'la nota nombra lo no listado: ' + result.notes.join(' | '));
});

/* (c) Techo maxDownloads=2 con 4 pedidos → 2 bajados, 2 en
   missing con su nota. */
test('(c) techo maxDownloads: para en el techo y el resto queda para el web service', async () => {
  const page = new FakePortalFielPage({
    received: { '2026-11-08': [uuidRow('UUID-R1'), uuidRow('UUID-R2'), uuidRow('UUID-R3'), uuidRow('UUID-R4')] },
    issued: [] });
  const { hooks } = hooksFor();
  const result = await makeFetch(page)({ rfc: 'MFI6212158B4' }, { maxDownloads: 2, items: [
    item('UUID-R1', 'received', '2026-11-08'), item('UUID-R2', 'received', '2026-11-08'),
    item('UUID-R3', 'received', '2026-11-08'), item('UUID-R4', 'received', '2026-11-08')] }, hooks);
  assert.equal(result.downloaded, 2);
  assert.equal(result.quotaUsed, 2);
  assert.equal(page.downloads.length, 2, 'el portal solo recibió 2 descargas');
  assert.deepEqual(result.missing, ['UUID-R3', 'UUID-R4']);
  assert.equal(result.complete, false);
  assert.ok(result.notes.some(n => n.includes('queda para la red del web service')),
    'la nota del techo es la fijada: ' + result.notes.join(' | '));
});

/* (d) Quota 'CuotaCompleta' → 0 descargas y nota. */
test('(d) cuota completa del portal: no se baja nada y se dice', async () => {
  const page = new FakePortalFielPage({ quota: 'CuotaCompleta',
    received: { '2026-11-08': [uuidRow('UUID-R1'), uuidRow('UUID-R2')] }, issued: [] });
  const { hooks } = hooksFor();
  const result = await makeFetch(page)({ rfc: 'MFI6212158B4' }, { items: [
    item('UUID-R1', 'received', '2026-11-08'), item('UUID-R2', 'received', '2026-11-08')] }, hooks);
  assert.equal(result.downloaded, 0);
  assert.equal(result.quotaUsed, 0);
  assert.equal(page.downloads.length, 0, 'con la cuota completa no se quema ni una descarga');
  assert.deepEqual(result.missing, ['UUID-R1', 'UUID-R2']);
  assert.equal(result.complete, false);
  assert.ok(result.notes.some(n => n.includes('cupo')), 'la nota habla del cupo: ' + result.notes.join(' | '));
});

/* (e) Cancelación tras la primera descarga → devuelve 1,
   complete=false, con su nota. */
test('(e) cancelación tras la primera descarga: devuelve lo bajado, incompleto', async () => {
  const page = new FakePortalFielPage({
    received: { '2026-11-08': [uuidRow('UUID-R1'), uuidRow('UUID-R2'), uuidRow('UUID-R3')] }, issued: [] });
  const { hooks } = hooksFor(() => page.downloads.length >= 1);
  const result = await makeFetch(page)({ rfc: 'MFI6212158B4' }, { items: [
    item('UUID-R1', 'received', '2026-11-08'), item('UUID-R2', 'received', '2026-11-08'),
    item('UUID-R3', 'received', '2026-11-08')] }, hooks);
  assert.equal(result.downloaded, 1);
  assert.equal(result.files[0].uuid, 'UUID-R1');
  assert.equal(result.complete, false);
  assert.deepEqual(result.missing, ['UUID-R2', 'UUID-R3']);
  assert.ok(result.notes.some(n => n.includes('cancelado')), 'la nota dice cancelado: ' + result.notes.join(' | '));
});

/* (f) Fallo de acceso: la réplica rechaza la e.firma → error
   con .code y .diag. */
test('(f) la e.firma rechazada es un fallo duro con código y diagnóstico', async () => {
  const page = new FakePortalFielPage({ rejectFiel: true });
  const { hooks } = hooksFor();
  const error = await makeFetch(page)({ rfc: 'MFI6212158B4' },
    { items: [item('UUID-R1', 'received', '2026-11-08')] }, hooks).then(() => null, e => e);
  assert.ok(error instanceof Error, 'el fallo de acceso lanza, no resuelve parcial');
  assert.equal(error.code, 'portal-rechaza', 'el código es el del acceso FIEL: ' + error.code);
  assert.ok(error.diag, 'el error viaja con diag');
  assert.ok(String(error.diag.html).includes('portal falso fiel'), 'el diag es el diagnostics() de la página');
  assert.ok(String(error.diag.url).includes('cfdiau'), 'el diag conserva la URL del acceso');
  assert.equal(page.downloads.length, 0);
  assert.equal(page.driverClosed, true, 'el navegador se cierra también en el fallo duro');
});

/* (g) Ninguna URL visitada sale de portalcfdi/cfdiau: este
   caminante jamás abre el Buzón ni una notificación. */
test('(g) ninguna URL visitada sale de portalcfdi/cfdiau', async () => {
  const page = new FakePortalFielPage({
    received: { '2026-11-08': [uuidRow('UUID-R1')] },
    issued: [{ ...uuidRow('UUID-I1'), date: '2026-11-10' }] });
  const { hooks } = hooksFor();
  const result = await makeFetch(page)({ rfc: 'MFI6212158B4' }, { items: [
    item('UUID-R1', 'received', '2026-11-08'), item('UUID-I1', 'issued', '2026-11-10')] }, hooks);
  assert.equal(result.downloaded, 2);
  assert.ok(page.visited.length >= 5, 'la réplica registró la caminata: ' + page.visited.join(' | '));
  for (const url of page.visited) {
    const host = new URL(url).hostname;
    assert.ok(host === 'portalcfdi.facturaelectronica.sat.gob.mx' || host === 'cfdiau.sat.gob.mx',
      'URL fuera del portal de consulta: ' + url);
    assert.ok(!/buzon|notificacion|wwwmat/i.test(url), 'jamás el Buzón ni una notificación: ' + url);
  }
});

/* Extra de la regla 2: ventana de emitidos con el tope de 500
   → se parte por días, se reintenta y todo lo pedido baja. */
test('(h) ventana de emitidos con 500 filas: se parte por días y se recupera todo', async () => {
  const bulk = Array.from({ length: 500 }, (_, i) => uuidRow('UUID-RELLENO-' + i));
  const page = new FakePortalFielPage({ issuedBulkWindow: bulk,
    issued: [{ ...uuidRow('UUID-I1'), date: '2026-11-10' },
      { ...uuidRow('UUID-I2'), date: '2026-11-12' }] });
  const { hooks } = hooksFor();
  const result = await makeFetch(page)({ rfc: 'MFI6212158B4' }, { items: [
    item('UUID-I1', 'issued', '2026-11-10'), item('UUID-I2', 'issued', '2026-11-12')] }, hooks);
  assert.equal(result.downloaded, 2);
  assert.equal(result.complete, true, 'tras partir por días, todo lo pedido bajó: completa');
  assert.deepEqual(result.notListed, []);
  assert.ok(result.notes.some(n => n.includes('parto la ventana por días')),
    'la nota cuenta el partir: ' + result.notes.join(' | '));
});

/* Primitivas nuevas del driver REAL (sat-doc-browser.mjs):
   portalOpenEfirmaDoor pulsa el control de e.firma solo si el
   formulario FIEL no está ya en el DOM, y ciecDownloadPdf solo
   devuelve cuerpos que son PDF. Se ejercitan contra una página
   Playwright falsa mínima (proveedorChromium inyectado): el
   evaluate de la doble ejecuta la función real de la primitiva
   sobre un document de juguete. */
test('(i) primitivas del driver real: portalOpenEfirmaDoor y ciecDownloadPdf', async () => {
  const pdfResponse = { url: () => 'https://portalcfdi.facturaelectronica.sat.gob.mx/RecuperaCfdi.aspx?Datos=UUID-I1&tipo=pdf',
    headers: () => ({ 'content-type': 'application/pdf' }), body: async () => PDF_FAKE };
  class FakePwPage {
    constructor() {
      this.handlers = {};
      this.current = 'https://cfdiau.sat.gob.mx/nidp/app/login?id=portalcfdi';
      this.scenario = 'door';
      this.doorClicked = false;
    }
    on(event, fn) { (this.handlers[event] ||= []).push(fn); }
    url() { return this.current; }
    async waitForTimeout() {}
    async evaluate(fn, arg) {
      const page = this;
      globalThis.document = page.scenario === 'door'
        ? { querySelector: () => null,
            querySelectorAll: () => [{ id: 'buttonFiel', textContent: '', value: '',
              getAttribute: () => '', click() { page.doorClicked = true; } }] }
        : { querySelector: sel => (sel === '#fileCertificate' ? {} : null), querySelectorAll: () => [] };
      try { return fn(arg); } finally { delete globalThis.document; }
    }
    async goto(url) {
      this.current = url;
      if (String(url).includes('RecuperaCfdi')) {
        for (const fn of this.handlers.response || []) fn(pdfResponse);
      }
    }
    async waitForEvent() { return {}; }
  }
  const pwPage = new FakePwPage();
  const context = { newPage: async () => pwPage, on: () => {}, close: async () => {} };
  const browser = { newContext: async () => context, close: async () => {} };
  const launch = createPlaywrightDriverFactory({ executablePath: '/fake/chromium',
    proveedorChromium: async () => ({ chromium: { launch: async () => browser } }) });
  const driver = await launch();
  try {
    const page = await driver.newPage();
    assert.equal(typeof page.portalOpenEfirmaDoor, 'function', 'el envoltorio ofrece la puerta');
    assert.equal(typeof page.ciecDownloadPdf, 'function', 'el envoltorio ofrece la descarga de PDF');
    assert.equal(await page.portalOpenEfirmaDoor(), true, 'sin formulario FIEL, la puerta se pulsa');
    assert.equal(pwPage.doorClicked, true, 'el clic cayó en el control de e.firma de la doble');
    pwPage.scenario = 'fiel';
    assert.equal(await page.portalOpenEfirmaDoor(), false,
      'con el formulario FIEL ya en el DOM, la puerta no se toca');
    const pdf = await page.ciecDownloadPdf(pdfResponse.url());
    assert.ok(Buffer.isBuffer(pdf) && pdf.equals(PDF_FAKE), 'ciecDownloadPdf devuelve el PDF capturado');
  } finally { await driver.close(); }

  /* Y el motor solo usa el PDF cuando la página lo ofrece: la
     fuente del envoltorio declara ambas primitivas como
     opcionales y el motor las sondea con typeof. */
  const browserSource = readFileSync(new URL('./sat-doc-browser.mjs', import.meta.url), 'utf8');
  assert.ok(browserSource.includes('async portalOpenEfirmaDoor()'), 'la puerta vive en el envoltorio');
  assert.ok(browserSource.includes('async ciecDownloadPdf(url)'), 'la descarga de PDF vive en el envoltorio');
  const motorSource = readFileSync(new URL('./sat-portal-cfdi.mjs', import.meta.url), 'utf8');
  assert.ok(motorSource.includes("typeof page.portalOpenEfirmaDoor === 'function'"), 'el motor sondea la puerta');
  assert.ok(motorSource.includes("typeof page.ciecDownloadPdf === 'function'"), 'el motor sondea el PDF');
});
