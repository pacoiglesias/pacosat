import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createSatPortalCfdiFetch } from './sat-portal-cfdi.mjs';
import { createPlaywrightDriverFactory } from './sat-doc-browser.mjs';
import { CIEC_PORTAL } from './sat-ciec.mjs';

/* ================================================================
   Ronda 3.1.0 — el caminante del portal trae TAMBIÉN las
   canceladas (orden de Paco, 20 nov 2026: «que el sistema
   descargue como OneFactura todo al momento, y no pidiendo
   lotes»).

   EL CASO REAL (probado en producción el 20 nov 2026 con la
   3.0.0): la corrida «Ponerme al día» de MFI6212158B4 detectó
   5 faltantes, todas RECIBIDAS del 2026-11-06 y todas
   CANCELADAS (estatus «0» en el metadato). El caminante las
   buscó por fecha («Buscando tus facturas recibidas del
   06/11/2026…») y el portal no listó ni una: su diario dice
   «El portal no listó 1 de los folios pedidos». Las vigentes
   por el mismo camino SÍ bajan (10 de oct-2025, en vivo).

   QUÉ MANDA HOY EL CAMINANTE (leído en su código): solo el
   radio de fechas (#ctl00_MainContent_RdoFechas) + las fechas
   + el botón de búsqueda. NUNCA fija el estado del comprobante
   ni usa la consulta por folio fiscal: una petición por UUIDs
   se traduce a la misma búsqueda por fecha del día de emisión.

   LA CORRECCIÓN: dos pasadas nuevas, con primitivas OPCIONALES
   del envoltorio (el patrón de la casa para controles aún no
   calibrados en vivo, como portalOpenEfirmaDoor en la 2.9.7):
     1 · ESTADO: los folios que el metadato marca cancelados
         (estatus «0») y la búsqueda normal no listó se buscan
         otra vez por fecha con el estado en «cancelados».
     2 · FOLIO: cualquier folio pedido que siga sin listarse
         se consulta por su folio fiscal, uno a uno.
   Si la página no ofrece esos controles, las primitivas no
   existen o devuelven false y la corrida acaba EXACTAMENTE
   como la 3.0.0 (no listados → la masiva de respaldo): jamás
   se finge una descarga que el portal no enseñó.

   RÉPLICA DECLARADA (FakePortal301Page): extiende la de la
   2.9.7 con lo que producción ya probó y lo que el formulario
   del portal declara —
   - El listado por fecha enseña por defecto las VIGENTES: es
     lo que producción probó (las canceladas no salieron y las
     vigentes sí). La réplica lo modela con estado inicial
     «vigente»; cada fila lleva su status ('1' por defecto,
     '0' si cancelada) y ciecRows filtra por el estado fijado.
   - ciecSetEstadoComprobante('cancelado'|'vigente'|'todos')
     fija ese filtro y la consulta por fecha lo respeta.
   - El modo folio (ciecClickFolioRadio + ciecSetFolio) hace
     que ciecRows devuelva la fila de ESE folio del índice,
     sea cual sea su estado (la consulta por folio fiscal es
     por definición la ficha de un comprobante concreto).
   FRONTERA DE CALIBRACIÓN (declarada, no inventada): los
   selectores reales del desplegable de estado y del modo
   folio se contrastan en la primera corrida en vivo contra
   una de las 5 canceladas reales; las primitivas del
   envoltorio los buscan de forma tolerante (id/nombre que
   hable de estado o de folio, u opciones/etiquetas que los
   nombren) y devuelven false si no están, sin tocar nada.
   ================================================================ */

const xmlFor = uuid => Buffer.from('<?xml version="1.0" encoding="UTF-8"?>' +
  '<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" Version="4.0" Fecha="2026-11-06T13:41:03">' +
  '<cfdi:Complemento><tfd:TimbreFiscalDigital xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital" UUID="' +
  uuid + '"/></cfdi:Complemento></cfdi:Comprobante>');
const isoDeMx = mx => { const [d, m, y] = String(mx).split('/'); return y + '-' + m + '-' + d; };
const uuidRow = (uuid, extra = {}) => ({ uuid,
  url: 'https://portalcfdi.facturaelectronica.sat.gob.mx/RecuperaCfdi.aspx?Datos=' + uuid, ...extra });
const canceladaRow = (uuid, extra = {}) => uuidRow(uuid, { status: '0', ...extra });

/* Las 5 canceladas reales del 2026-11-06 (producción, 3.0.0). */
const CINCO = [
  '4C913CF6-0318-42B4-9E75-A4697048150F',
  '77B890AB-126E-4DE2-8248-F459950B4CA9',
  'ADC141AA-AA94-4A83-9134-115180141566',
  '8485826D-FA6A-44F8-B716-121DFCADF631',
  'D251F3BE-32ED-4A4C-873A-AE1A746F398A'];
const VIGENTE_0611 = 'B1VIGENT-0000-4000-8000-202611060001';

class FakePortal301Page {
  constructor(script = {}) {
    this.script = script;
    this.currentUrl = 'about:blank';
    this.loggedIn = false;
    this.doorOpened = false;
    this.fielFormVisible = false;
    this.fielFilled = null;
    this.fielError = '';
    this.day = null;
    this.range = null;
    this.estado = 'vigente'; /* el listado por fecha enseña vigentes: producción */
    this.estadoCalls = [];
    this.folioMode = false;
    this.folio = '';
    this.folioQueries = [];
    this.downloads = [];
    this.visited = [];
    this.driverClosed = false;
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
  async ciecWaitResults() { return true; }
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
    this.visited.push(url);
    this.downloads.push(url);
    const uuid = decodeURIComponent(String(url.split('Datos=')[1] || '')).split('&')[0];
    if ((this.script.failDownloads || []).includes(uuid)) return null;
    return xmlFor(uuid);
  }
  async diagnostics() {
    return { url: this.currentUrl, screenshot: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      html: '<html><body>portal falso 3.1.0 · ' + this.currentUrl + '</body></html>' };
  }
  async close() {}
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
const item = (uuid, direction, issuedAt, extra = {}) => ({ uuid, direction, issuedAt, ...extra });
const itemCancelado = (uuid, direction, issuedAt) => item(uuid, direction, issuedAt, { cancelled: true });

/* (a) EL CASO REAL: las 5 canceladas recibidas del 2026-11-06
   + 1 vigente del mismo día. Con la 3.0.0: baja 1, las 5 quedan
   en no listadas. Con la corrección: las 6 bajan al momento. */
test('(a) el caso real: las 5 canceladas del 06/11/2026 bajan por la pasada de estado', async () => {
  const page = new FakePortal301Page({
    received: { '2026-11-06': [uuidRow(VIGENTE_0611), ...CINCO.map(u => canceladaRow(u))] } });
  const { hooks } = hooksFor();
  const result = await makeFetch(page)({ rfc: 'MFI6212158B4' }, { items: [
    item(VIGENTE_0611, 'received', '2026-11-06'),
    ...CINCO.map(u => itemCancelado(u, 'received', '2026-11-06'))] }, hooks);
  assert.equal(result.downloaded, 6, 'las 6 bajan: la vigente y las 5 canceladas');
  assert.equal(result.found, 6);
  assert.equal(result.complete, true);
  assert.deepEqual(result.notListed, []);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.files.map(f => f.uuid),
    [VIGENTE_0611, ...CINCO], 'los archivos salen en el orden pedido');
  assert.ok(page.estadoCalls.includes('cancelado'),
    'el caminante fijó el estado en cancelados: ' + page.estadoCalls.join(','));
  assert.ok(result.notes.some(n => /cancelad/i.test(n)),
    'una nota cuenta la pasada de canceladas: ' + result.notes.join(' | '));
});

/* (b) Sin primitiva de estado, la consulta por folio rescata
   la cancelada (está en el índice de folios, no en el listado
   del día a la vista). */
test('(b) sin vía de estado, el folio fiscal rescata la cancelada', async () => {
  const [uuid] = CINCO;
  const page = new FakePortal301Page({
    received: { '2026-11-06': [canceladaRow(uuid)] },
    folioIndex: { [uuid]: canceladaRow(uuid) } });
  page.ciecSetEstadoComprobante = undefined; /* la página no ofrece el desplegable */
  const { hooks } = hooksFor();
  const result = await makeFetch(page)({ rfc: 'MFI6212158B4' },
    { items: [itemCancelado(uuid, 'received', '2026-11-06')] }, hooks);
  assert.equal(result.downloaded, 1, 'la cancelada baja por su folio');
  assert.equal(result.complete, true);
  assert.deepEqual(page.folioQueries, [uuid], 'se consultó el folio exacto');
  assert.deepEqual(result.notListed, []);
});

/* (c) Una VIGENTE que el listado por fecha no enseña también
   se rescata por su folio (la segunda pasada no es solo para
   canceladas: es para todo folio pedido no listado). */
test('(c) una vigente no listada por fecha también se rescata por folio', async () => {
  const page = new FakePortal301Page({
    received: { '2026-11-06': [] },
    folioIndex: { [VIGENTE_0611]: uuidRow(VIGENTE_0611) } });
  const { hooks } = hooksFor();
  const result = await makeFetch(page)({ rfc: 'MFI6212158B4' },
    { items: [item(VIGENTE_0611, 'received', '2026-11-06')] }, hooks);
  assert.equal(result.downloaded, 1);
  assert.equal(result.complete, true);
  assert.deepEqual(page.folioQueries, [VIGENTE_0611]);
});

/* (d) Residuo honesto: la cancelada que NINGUNA vía lista
   queda en no listadas, sin fingir descarga. */
test('(d) la cancelada que ninguna vía lista queda en no listadas, sin fingir', async () => {
  const [uuid] = CINCO;
  const page = new FakePortal301Page({ received: { '2026-11-06': [] }, folioIndex: {} });
  const { hooks } = hooksFor();
  const result = await makeFetch(page)({ rfc: 'MFI6212158B4' },
    { items: [itemCancelado(uuid, 'received', '2026-11-06')] }, hooks);
  assert.equal(result.downloaded, 0);
  assert.equal(result.found, 0);
  assert.equal(result.complete, false);
  assert.deepEqual(result.notListed, [uuid]);
  assert.equal(page.downloads.length, 0, 'jamás se pidió una descarga que el portal no enseñó');
  assert.ok(result.notes.some(n => n.includes('no listó')),
    'la nota honesta de siempre: ' + result.notes.join(' | '));
});

/* (e) Paridad con una página SIN ninguna primitiva nueva (la
   réplica de la 2.9.7): la corrida se comporta EXACTAMENTE
   como la 3.0.0 — la vigente baja, la cancelada queda en no
   listadas y nada se rompe. */
test('(e) página sin primitivas nuevas: comportamiento idéntico a la 3.0.0', async () => {
  const [uuid] = CINCO;
  const page = new FakePortal301Page({
    received: { '2026-11-06': [uuidRow(VIGENTE_0611), canceladaRow(uuid)] } });
  page.ciecSetEstadoComprobante = undefined;
  page.ciecClickFolioRadio = undefined;
  page.ciecSetFolio = undefined;
  const { hooks } = hooksFor();
  const result = await makeFetch(page)({ rfc: 'MFI6212158B4' }, { items: [
    item(VIGENTE_0611, 'received', '2026-11-06'),
    itemCancelado(uuid, 'received', '2026-11-06')] }, hooks);
  assert.equal(result.downloaded, 1, 'baja la vigente, como en la 3.0.0');
  assert.deepEqual(result.notListed, [uuid], 'la cancelada queda en no listadas, como en la 3.0.0');
  assert.equal(result.complete, false);
});

/* (f) Emitidas canceladas: la pasada de estado corre también
   sobre la ventana de emitidos. */
test('(f) emitidas canceladas: la pasada de estado cubre la ventana de emitidos', async () => {
  const em1 = 'E1CANCEL-0000-4000-8000-202611100001';
  const em2 = 'E2CANCEL-0000-4000-8000-202611120002';
  const emV = 'E3VIGENT-0000-4000-8000-202611110003';
  const page = new FakePortal301Page({ issued: [
    { ...uuidRow(emV), date: '2026-11-11' },
    { ...canceladaRow(em1), date: '2026-11-10' },
    { ...canceladaRow(em2), date: '2026-11-12' }] });
  const { hooks } = hooksFor();
  const result = await makeFetch(page)({ rfc: 'MFI6212158B4' }, { items: [
    itemCancelado(em1, 'issued', '2026-11-10'), item(emV, 'issued', '2026-11-11'),
    itemCancelado(em2, 'issued', '2026-11-12')] }, hooks);
  assert.equal(result.downloaded, 3, 'bajan la vigente y las dos canceladas emitidas');
  assert.equal(result.complete, true);
  assert.ok(page.estadoCalls.includes('cancelado'));
});

/* (g) Las primitivas REALES del envoltorio
   (sat-doc-browser.mjs) contra un documento de juguete, como
   la prueba (i) de la 2.9.7: con los controles presentes las
   tres actúan; sin ellos, las tres devuelven false sin tocar
   nada. */
test('(g) primitivas del driver real: estado, radio de folio y caja de folio', async () => {
  class ToyEl {
    constructor(props = {}) { Object.assign(this, { disabled: false, readOnly: false,
      value: '', options: [], events: [], clicked: false }, props); }
    getAttribute(name) { return this.attrs?.[name] || ''; }
    dispatchEvent(event) { this.events.push(event?.type || ''); return true; }
    click() { this.clicked = true; }
  }
  class FakePwPage {
    constructor(conControles) {
      this.conControles = conControles;
      this.current = 'https://portalcfdi.facturaelectronica.sat.gob.mx/ConsultaReceptor.aspx';
      this.estadoSelect = new ToyEl({ id: 'ctl00_MainContent_DdlEstadoComprobante',
        options: [{ value: '-1', textContent: 'Todos' }, { value: '1', textContent: 'Vigente' },
          { value: '0', textContent: 'Cancelado' }] });
      this.folioRadio = new ToyEl({ id: 'ctl00_MainContent_RdoFolioFiscal' });
      this.folioInput = new ToyEl({ id: 'ctl00_MainContent_TxtFolioFiscal' });
    }
    on() {}
    url() { return this.current; }
    async waitForTimeout() {}
    locator() { return { click: async () => { throw new Error('sin localizador en la doble'); } }; }
    async evaluate(fn, arg) {
      const page = this;
      globalThis.document = {
        querySelector: sel => {
          if (!page.conControles) return null;
          if (sel.includes('TxtFolioFiscal')) return page.folioInput;
          return null;
        },
        querySelectorAll: sel => {
          if (!page.conControles) return [];
          if (sel === 'select') return [page.estadoSelect];
          if (String(sel).includes('radio')) return [page.folioRadio];
          if (String(sel).includes('input')) return [page.folioInput];
          return [];
        } };
      globalThis.Event = class { constructor(type) { this.type = type; } };
      try { return fn(arg); } finally { delete globalThis.document; delete globalThis.Event; }
    }
    async goto(url) { this.current = url; }
    async waitForEvent() { return {}; }
  }
  const launchWith = async (pwPage) => {
    const context = { newPage: async () => pwPage, on: () => {}, close: async () => {} };
    const browser = { newContext: async () => context, close: async () => {} };
    const launch = createPlaywrightDriverFactory({ executablePath: '/fake/chromium',
      proveedorChromium: async () => ({ chromium: { launch: async () => browser } }) });
    const driver = await launch();
    return { driver, page: await driver.newPage() };
  };
  { /* Con controles: las tres primitivas actúan. */
    const pwPage = new FakePwPage(true);
    const { driver, page } = await launchWith(pwPage);
    try {
      assert.equal(typeof page.ciecSetEstadoComprobante, 'function', 'el envoltorio ofrece el estado');
      assert.equal(typeof page.ciecClickFolioRadio, 'function', 'el envoltorio ofrece el radio de folio');
      assert.equal(typeof page.ciecSetFolio, 'function', 'el envoltorio ofrece la caja de folio');
      assert.equal(await page.ciecSetEstadoComprobante('cancelado'), true, 'el estado se fija');
      assert.equal(pwPage.estadoSelect.value, '0', 'el desplegable quedó en la opción Cancelado');
      assert.ok(pwPage.estadoSelect.events.includes('change'), 'el cambio se anunció al formulario');
      assert.equal(await page.ciecSetEstadoComprobante('todos'), true, 'el estado se puede reabrir');
      assert.equal(pwPage.estadoSelect.value, '-1', 'el desplegable quedó en Todos');
      assert.equal(await page.ciecClickFolioRadio(), true, 'el radio de folio se pulsa');
      assert.equal(pwPage.folioRadio.clicked, true, 'el clic cayó en el radio de folio');
      assert.equal(await page.ciecSetFolio(CINCO[0]), true, 'la caja de folio se rellena');
      assert.equal(pwPage.folioInput.value, CINCO[0], 'la caja lleva el folio pedido');
    } finally { await driver.close(); }
  }
  { /* Sin controles: las tres devuelven false, sin tocar nada. */
    const pwPage = new FakePwPage(false);
    const { driver, page } = await launchWith(pwPage);
    try {
      assert.equal(await page.ciecSetEstadoComprobante('cancelado'), false, 'sin desplegable: false');
      assert.equal(await page.ciecClickFolioRadio(), false, 'sin radio de folio: false');
      assert.equal(await page.ciecSetFolio(CINCO[0]), false, 'sin caja de folio: false');
    } finally { await driver.close(); }
  }
});

/* (h) El servidor alimenta la marca: los pendientes del
   portal salen de metadata_records CON su estatus y la marca
   «cancelled» llega al motor tanto en la consulta general
   como en la petición por UUIDs. Se afirma sobre la fuente,
   como la prueba (i) de la 2.9.7 afirma el cableado del
   motor con el envoltorio. */
test('(h) el servidor pasa la marca de cancelada desde los metadatos al motor', () => {
  const server = readFileSync(new URL('./local-server.mjs', import.meta.url), 'utf8');
  assert.ok(server.includes('m.status') || server.includes('m.issuedAt,m.status'),
    'pendingPortalItems297 lee el estatus del metadato');
  assert.ok(/cancelled:\s*String\(row\.status\)\s*===\s*'0'/.test(server) ||
      /cancelled:\s*row\.status\s*===\s*'0'/.test(server),
    'la marca cancelled nace del estatus «0» del metadato');
  const motor = readFileSync(new URL('./sat-portal-cfdi.mjs', import.meta.url), 'utf8');
  assert.ok(motor.includes('ciecSetEstadoComprobante'), 'el motor usa la vía del estado');
  assert.ok(motor.includes('ciecClickFolioRadio') && motor.includes('ciecSetFolio'),
    'el motor usa la vía del folio');
  const envoltorio = readFileSync(new URL('./sat-doc-browser.mjs', import.meta.url), 'utf8');
  assert.ok(envoltorio.includes('async ciecSetEstadoComprobante('), 'la primitiva de estado vive en el envoltorio');
  assert.ok(envoltorio.includes('async ciecClickFolioRadio('), 'la primitiva del radio vive en el envoltorio');
  assert.ok(envoltorio.includes('async ciecSetFolio('), 'la primitiva de la caja vive en el envoltorio');
});
