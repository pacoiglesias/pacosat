import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPacoSATService } from './local-server.mjs';
import { fetchCfdiViaCiec, classifyCiecLoginError, ciecDayList,
  createCiecCredentialResolver, createSatCiecFetch } from './sat-ciec.mjs';

/* Descarga por CIEC (1.12.0): motor contra un portal FALSO que
   sigue el contrato documentado de portalcfdi (formulario NIDP
   con captcha de imagen, consultas con resultados en el DOM y
   descargas por token), y el servidor completo con un puerto de
   descarga de juguete: custodia, pausa del captcha, ingesta en
   el almacén común y exclusión del invitado. Nunca el SAT real
   ni una CIEC de verdad. */

const xmlFor = uuid => Buffer.from('<?xml version="1.0" encoding="UTF-8"?>' +
  '<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital" ' +
  'Version="4.0" Fecha="2026-11-05T10:00:00" SubTotal="100.00" Moneda="MXN" Total="116.00" TipoDeComprobante="I" ' +
  'MetodoPago="PUE" FormaPago="03" LugarExpedicion="03104">' +
  '<cfdi:Emisor Rfc="AAA010101AAA" Nombre="Emisor de Prueba" RegimenFiscal="626"/>' +
  '<cfdi:Receptor Rfc="XAXX010101000" Nombre="Receptor de Prueba" DomicilioFiscalReceptor="03104" RegimenFiscalReceptor="626" UsoCFDI="G03"/>' +
  '<cfdi:Conceptos><cfdi:Concepto ClaveProdServ="01010101" Cantidad="1" ClaveUnidad="H87" Descripcion="Prueba" ValorUnitario="100.00" Importe="100.00" ObjetoImp="01"/></cfdi:Conceptos>' +
  '<cfdi:Complemento><tfd:TimbreFiscalDigital Version="1.1" UUID="' + uuid + '" FechaTimbrado="2026-11-05T10:01:00" ' +
  'RfcProvCertif="AAA010101AAA" SelloCFD="AAAABBBBCCCCDDDD" NoCertificadoSAT="00001000000000000001" SelloSAT="EEEEFFFF"/></cfdi:Complemento>' +
  '</cfdi:Comprobante>');

/* Portal falso: la página del driver con el contrato ciec*. El
   captcha «bueno» es CAPTCHA_TEXTO; cualquier otro texto deja la
   sesión en el acceso con el error del captcha pintado. La
   contraseña buena es PASSWORD_OK; otra, error de credenciales. */
const CAPTCHA_TEXTO = 'KX7P2';
const PASSWORD_OK = 'ciec-buena';
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
  }
  /* Como el portal real: sin sesión, cualquier dirección de
     portalcfdi redirige al acceso del NIDP (cfdiau). */
  async goto(url) {
    if (url.includes('portalcfdi') && !this.loggedIn)
      this.currentUrl = 'https://cfdiau.sat.gob.mx/nidp/app/login?id=portalcfdi&sid=0';
    else this.currentUrl = url;
  }
  url() { return this.currentUrl; }
  async ciecHasLoginForm() { return this.currentUrl.includes('cfdiau'); }
  async ciecCaptchaImage() { return 'data:image/png;base64,CAPTCHAFAKE'; }
  async ciecFillLogin(values) { this.login = { ...this.login, ...values }; return { rfc: true, password: true, captcha: true }; }
  async ciecSubmitLogin() {
    if (this.login?.password !== PASSWORD_OK) { this.error = 'La contraseña proporcionada no es correcta.'; return; }
    if (this.login?.captcha !== CAPTCHA_TEXTO) { this.error = 'El texto de la imagen no coincide, capture de nuevo los caracteres.'; return; }
    this.error = '';
    this.loggedIn = true;
    this.currentUrl = 'https://portalcfdi.facturaelectronica.sat.gob.mx/';
  }
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
    this.downloads.push(url);
    const uuid = decodeURIComponent(url.split('Datos=')[1] || '');
    if ((this.script.failDownloads || []).includes(uuid)) return null;
    return xmlFor(uuid);
  }
  async diagnostics() { return { url: this.currentUrl, screenshot: Buffer.from([0x89, 0x50, 0x4e, 0x47]), html: '<html><body>portal falso</body></html>' }; }
  async close() {}
}
const hooksFor = (answers, record = {}) => ({
  step: (text) => { (record.steps ||= []).push(text); },
  askCaptcha: async (image, attempt, max) => {
    (record.captchas ||= []).push({ image, attempt, max });
    return answers.shift();
  }
});
const uuidRow = n => ({ uuid: 'UUID-' + n, url: 'https://portalcfdi.facturaelectronica.sat.gob.mx/RecuperaCfdi.aspx?Datos=UUID-' + n });

try {
  /* Clasificación de errores del acceso y lista de días. */
  assert.equal(classifyCiecLoginError('El texto de la imagen no coincide'), 'captcha');
  assert.equal(classifyCiecLoginError('La contraseña es incorrecta'), 'credentials');
  assert.equal(classifyCiecLoginError('captcha incorrecto'), 'captcha');
  assert.equal(classifyCiecLoginError(''), 'unknown');
  assert.deepEqual(ciecDayList('2026-11-05', '2026-11-07').map(day => day.iso),
    ['2026-11-05', '2026-11-06', '2026-11-07']);
  assert.deepEqual(ciecDayList('2026-11-07', '2026-11-05'), []);

  /* Camino feliz: captcha a la primera, recibidos de dos días y
     emitidos del rango, todo descargado y completo. */
  {
    const page = new FakePortalPage({ received: { '2026-11-05': [uuidRow(1)], '2026-11-06': [uuidRow(2)] },
      issued: [uuidRow(3)] });
    const record = {};
    const result = await fetchCfdiViaCiec(page, { rfc: 'XAXX010101000', ciec: PASSWORD_OK,
      start: '2026-11-05', end: '2026-11-06', direction: 'both' }, hooksFor([CAPTCHA_TEXTO], record));
    assert.equal(result.found, 3);
    assert.equal(result.downloaded, 3);
    assert.equal(result.complete, true);
    assert.equal(result.files[0].name, 'UUID-1.xml');
    assert.equal(record.captchas.length, 1);
    assert.equal(record.captchas[0].attempt, 1);
    assert.ok(record.steps.some(step => step.includes('Ya estás dentro del portal')));
    assert.ok(record.steps.some(step => step.includes('recibidas del 05/11/2026')));
    assert.ok(record.steps.some(step => step.includes('emitidas del 05/11/2026 al 06/11/2026')));
  }
  /* Captcha malo y luego bueno: el portal sirve otro y se entra
     al segundo intento. */
  {
    const page = new FakePortalPage({ received: { '2026-11-05': [] }, issued: [] });
    const record = {};
    const result = await fetchCfdiViaCiec(page, { rfc: 'XAXX010101000', ciec: PASSWORD_OK,
      start: '2026-11-05', end: '2026-11-05', direction: 'both' }, hooksFor(['MALO1', CAPTCHA_TEXTO], record));
    assert.equal(result.found, 0);
    assert.equal(record.captchas.length, 2);
    assert.equal(record.captchas[1].attempt, 2);
  }
  /* Contraseña rechazada: se aborta al primer intento, sin
     gastar los demás captchas. */
  {
    const page = new FakePortalPage({});
    const record = {};
    await assert.rejects(fetchCfdiViaCiec(page, { rfc: 'XAXX010101000', ciec: 'mala',
      start: '2026-11-05', end: '2026-11-05', direction: 'both' }, hooksFor([CAPTCHA_TEXTO, CAPTCHA_TEXTO], record)),
      error => error.code === 'credenciales');
    assert.equal(record.captchas.length, 1);
  }
  /* Tres captchas malos: la corrida termina con su motivo. */
  {
    const page = new FakePortalPage({});
    const record = {};
    await assert.rejects(fetchCfdiViaCiec(page, { rfc: 'XAXX010101000', ciec: PASSWORD_OK,
      start: '2026-11-05', end: '2026-11-05', direction: 'both' }, hooksFor(['A', 'B', 'C'], record)),
      error => error.code === 'captcha-rechazado' && error.diag?.html.includes('portal falso'));
    assert.equal(record.captchas.length, 3);
  }
  /* Sin respuesta al captcha (la espera vence): cierre limpio. */
  {
    const page = new FakePortalPage({});
    await assert.rejects(fetchCfdiViaCiec(page, { rfc: 'XAXX010101000', ciec: PASSWORD_OK,
      start: '2026-11-05', end: '2026-11-05', direction: 'both' }, hooksFor([null])),
      error => error.code === 'captcha-sin-respuesta');
  }
  /* Cupo del día completo según el propio portal: no se quema
     ni una descarga y la corrida lo dice en claro. */
  {
    const page = new FakePortalPage({ received: { '2026-11-05': [uuidRow(9)] }, issued: [], quota: 'CuotaCompleta' });
    const result = await fetchCfdiViaCiec(page, { rfc: 'XAXX010101000', ciec: PASSWORD_OK,
      start: '2026-11-05', end: '2026-11-05', direction: 'received' }, hooksFor([CAPTCHA_TEXTO]));
    assert.equal(result.downloaded, 0);
    assert.equal(result.complete, false);
    assert.equal(page.downloads.length, 0);
    assert.ok(result.notes.some(note => note.includes('cupo')));
  }
  /* Página de 500 recibidos en un día: puede haber más; la
     corrida lo anota y baja los que el portal enseña. */
  {
    const rows = Array.from({ length: 500 }, (_, i) => uuidRow('M' + i));
    const page = new FakePortalPage({ received: { '2026-11-05': rows }, issued: [] });
    const result = await fetchCfdiViaCiec(page, { rfc: 'XAXX010101000', ciec: PASSWORD_OK,
      start: '2026-11-05', end: '2026-11-05', direction: 'received' }, hooksFor([CAPTCHA_TEXTO]));
    assert.equal(result.found, 500);
    assert.equal(result.downloaded, 500);
    assert.equal(result.complete, false);
    assert.ok(result.notes.some(note => note.includes('500')));
  }
  /* Tres fallos de descarga seguidos: se para con lo guardado. */
  {
    const page = new FakePortalPage({ received: { '2026-11-05': [uuidRow('F1'), uuidRow('F2'), uuidRow('F3'), uuidRow('F4')] },
      issued: [], failDownloads: ['UUID-F1', 'UUID-F2', 'UUID-F3'] });
    const result = await fetchCfdiViaCiec(page, { rfc: 'XAXX010101000', ciec: PASSWORD_OK,
      start: '2026-11-05', end: '2026-11-05', direction: 'received' }, hooksFor([CAPTCHA_TEXTO]));
    assert.equal(result.downloaded, 0);
    assert.equal(result.complete, false);
    assert.equal(page.downloads.length, 3);
  }
  /* Resolvedor de credenciales: solo el método CIEC y jamás
     para un perfil de e.firma. */
  {
    const storage = { readIndex: () => ({ XAXX010101000: { access: 'ciec', ciec: 'guardada' },
      AAA010101AAA: { access: 'efirma', password: 'x' } }) };
    const resolve = createCiecCredentialResolver({ storage });
    assert.deepEqual(await resolve({ rfc: 'XAXX010101000' }), { rfc: 'XAXX010101000', ciec: 'guardada' });
    await assert.rejects(resolve({ rfc: 'AAA010101AAA' }), error => error.code === 'sin-ciec');
    await assert.rejects(resolve({ rfc: 'BBB010101BBB' }), error => error.code === 'sin-ciec');
  }
  /* Puerto completo con driver de juguete: resuelve, abre,
     descarga y cierra el navegador. */
  {
    let closed = false;
    const page = new FakePortalPage({ received: { '2026-11-05': [uuidRow(7)] }, issued: [] });
    const fetch = createSatCiecFetch({
      resolveCredentials: async () => ({ rfc: 'XAXX010101000', ciec: PASSWORD_OK }),
      launchDriver: async () => ({ newPage: async () => page, close: async () => { closed = true; } }) });
    const result = await fetch({ rfc: 'XAXX010101000' },
      { start: '2026-11-05', end: '2026-11-05', direction: 'received' }, hooksFor([CAPTCHA_TEXTO]));
    assert.equal(result.downloaded, 1);
    assert.equal(closed, true);
  }
  console.log('sat-ciec.test (motor): ok');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}

/* ===== Servidor: custodia, pausa, ingesta e invitado ===== */
const RFC2 = 'XAXX010101000';
const CIEC_SECRET = 'secreto-ciec-1';
const efirmaDir2 = mkdtempSync(join(tmpdir(), 'pacosat-ciec-'));
let captchaSeen = null;
const service2 = createPacoSATService({ dbFile: ':memory:', html: '<!--PACOSAT_TOKEN-->', origin: 'http://127.0.0.1:43735',
  proxyKey: 'd'.repeat(64),
  efirmaDir: efirmaDir2,
  makeConnector: async () => ({ parser: class {}, connector: {} }),
  satCiecFetch: async (profile, query, hooks) => {
    assert.equal(profile.rfc, RFC2);
    hooks.step('Paso de juguete dentro del portal…', '');
    const text = await hooks.askCaptcha('data:image/png;base64,AAAA', 1, 3);
    captchaSeen = text;
    return { files: [{ name: 'del-portal.xml', buffer: xmlFor('AAAAAAAA-1111-2222-3333-444444444444') }],
      found: 1, downloaded: 1, complete: true, notes: [] };
  } });
let token2;
async function call2(path, data, options = {}) {
  const headers = { host: '127.0.0.1:43735', origin: 'http://127.0.0.1:43735', 'x-pacosat-token': token2,
    'x-pacosat-proxy': 'd'.repeat(64), ...options };
  const req = Object.assign(Readable.from(data === undefined ? [] : [Buffer.from(JSON.stringify(data))]), {
    url: path, method: data === undefined ? 'GET' : 'POST', headers });
  let response;
  const res = { setHeader() {}, writeHead(status) { this.status = status; this.headersSent = true; },
    end(content) { response = new Response(content, { status: this.status }); } };
  await service2.handle(req, res);
  return response;
}
const waitFor = async (probe, label) => {
  for (let i = 0; i < 200; i++) { const value = await probe(); if (value) return value; await new Promise(r => setTimeout(r, 20)); }
  throw new Error('No llegó: ' + label);
};
try {
  token2 = (await (await call2('/')).text()).split('content="')[1].split('"')[0];
  /* Sin contribuyente registrado, el guardado CIEC se rechaza. */
  let res = await call2('/api/ciec', { rfc: 'BBB010101BB1', ciec: 'x', minutes: 360, days: 7, direction: 'both' });
  assert.equal(res.status, 404);
  /* Se siembran los contribuyentes por la vía normal de la app. */
  res = await call2('/api/storage', { batch: { people: [{ id: RFC2, name: 'Contribuyente CIEC' },
    { id: 'AAA010101AAA', name: 'Contribuyente e.firma' }] } });
  assert.equal(res.status, 200);
  /* Guardado CIEC: solo RFC + contraseña; el método queda en
     «ciec», la contraseña NO vuelve en la respuesta y el índice
     protegido la guarda SIN crear ficheros .cer/.key. */
  res = await call2('/api/ciec', { rfc: RFC2, ciec: CIEC_SECRET, minutes: 360, days: 7, direction: 'both' });
  assert.equal(res.status, 200);
  const overview2 = await res.json();
  const profile2 = overview2.profiles.find(row => row.rfc === RFC2);
  assert.equal(profile2.accessMethod, 'ciec');
  assert.equal(profile2.ciecStored, true);
  assert.equal(profile2.unlocked, false);
  assert.ok(!(await (await call2('/api/status')).text()).includes(CIEC_SECRET), 'la CIEC no sale en ninguna respuesta');
  const index2 = JSON.parse(readFileSync(join(efirmaDir2, 'perfiles.json'), 'utf8'));
  assert.equal(index2[RFC2].access, 'ciec');
  /* S1 (1.22.0): en reposo la CIEC viaja CIFRADA con la llave del
     equipo — el fichero ya no contiene el secreto en claro; la
     corrida de abajo prueba que los flujos lo leen descifrado. */
  assert.ok(!JSON.stringify(index2).includes(CIEC_SECRET), 'la CIEC no queda en claro en el fichero');
  assert.ok(String(index2[RFC2].ciec).startsWith('enc:v1:'), 'la CIEC queda cifrada en reposo');
  assert.equal(existsSync(join(efirmaDir2, RFC2 + '.cer')), false);
  assert.equal(existsSync(join(efirmaDir2, RFC2 + '.key')), false);
  /* Un perfil de e.firma no puede lanzar la descarga CIEC. */
  res = await call2('/api/unlock', { rfc: 'AAA010101AAA', minutes: 60, days: 7, direction: 'received',
    password: 'x', certificate: 'YQ==', key: 'Yg==' });
  assert.equal(res.status, 200);
  res = await call2('/api/ciec/run', { rfc: 'AAA010101AAA', start: '2026-11-01', end: '2026-11-07', direction: 'received' });
  assert.equal(res.status, 400);
  /* Sin captcha esperando, responder al captcha es un 409. */
  res = await call2('/api/ciec/captcha', { rfc: RFC2, text: 'XXXX' });
  assert.equal(res.status, 409);
  /* La corrida: se pausa en el captcha (visible por la API, con
     su imagen), Paco lo escribe por la API y la corrida sigue e
     ingresa el XML en el almacén común. */
  res = await call2('/api/ciec/run', { rfc: RFC2, start: '2026-11-01', end: '2026-11-07', direction: 'received' });
  assert.equal(res.status, 200);
  const waiting = await waitFor(async () => {
    const view = await (await call2('/api/ciec')).json();
    return view.profiles[0]?.captcha?.waiting ? view.profiles[0] : null;
  }, 'la pausa del captcha');
  assert.ok(waiting.captcha.image.startsWith('data:image'));
  assert.equal(waiting.progress.running, true);
  res = await call2('/api/ciec/captcha', { rfc: RFC2, text: 'LOQUESEA' });
  assert.equal(res.status, 200);
  const finished = await waitFor(async () => {
    const view = await (await call2('/api/ciec')).json();
    return view.profiles[0]?.progress && !view.profiles[0].progress.running ? view.profiles[0] : null;
  }, 'el fin de la corrida');
  assert.equal(captchaSeen, 'LOQUESEA');
  assert.equal(finished.progress.ok, true);
  assert.equal(finished.captcha, null);
  assert.equal(finished.runs.length, 1);
  assert.equal(finished.runs[0].ok, true);
  assert.equal(finished.runs[0].added, 1);
  assert.equal(finished.runs[0].found, 1);
  /* Segunda corrida con el mismo XML: entra como duplicado —
     la ingesta es la del almacén común, no una paralela. */
  res = await call2('/api/ciec/run', { rfc: RFC2, start: '2026-11-01', end: '2026-11-07', direction: 'received' });
  assert.equal(res.status, 200);
  await waitFor(async () => (await (await call2('/api/ciec')).json()).profiles[0]?.captcha?.waiting, 'la segunda pausa');
  await call2('/api/ciec/captcha', { rfc: RFC2, text: 'OTRO' });
  const finished2 = await waitFor(async () => {
    const view = await (await call2('/api/ciec')).json();
    return view.profiles[0]?.runs?.length >= 2 && !view.profiles[0].progress.running ? view.profiles[0] : null;
  }, 'el fin de la segunda corrida');
  assert.equal(finished2.runs[0].added, 0);
  assert.equal(finished2.runs[0].duplicates, 1);
  /* Invitado: ni ve la vista CIEC ni lanza ni responde captchas
     (la misma exclusión que en Pagos). */
  await call2('/api/guest/config', { password: 'clave-invitado-1', enabled: true });
  const guestLogin = await (await call2('/api/guest/login', { password: 'clave-invitado-1' })).json();
  assert.ok(guestLogin.token);
  const asGuest = { 'x-pacosat-token': guestLogin.token };
  assert.equal((await call2('/api/ciec', undefined, asGuest)).status, 403);
  assert.equal((await call2('/api/ciec/run', { rfc: RFC2, start: '2026-11-01', end: '2026-11-07' }, asGuest)).status, 403);
  assert.equal((await call2('/api/ciec/captcha', { rfc: RFC2, text: 'X' }, asGuest)).status, 403);
  assert.equal((await call2('/api/ciec', { rfc: RFC2, ciec: 'otra', minutes: 60, days: 7, direction: 'both' }, asGuest)).status, 403);

  console.log('sat-ciec.test (servidor): ok');
} finally { await service2.close(); }
