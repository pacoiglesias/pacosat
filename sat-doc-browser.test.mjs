import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createPlaywrightDriverFactory } from './sat-doc-browser.mjs';
import { SatDocError } from './sat-doc-fetch.mjs';
import { keyCipherInfo, convertKeyTo3Des, prepareKeyForPortal, extractBase64Pdf,
  fetchDocumentInBrowser, createSatDocBrowserFetch, createSatDocPipelineFetch } from './sat-doc-browser.mjs';

/* Sidecar de navegador (1.9.0): el portal es un DRIVER FALSO con
   páginas guionizadas equivalentes a las reales (login NIDP con
   #buttonFiel y formulario de e.firma, aterrizaje en la operación
   43824, SPA de la opinión con su fase de respuesta completa en
   Base64). Ninguna credencial sale a la red: la e.firma es de
   juguete y el «portal» vive dentro de esta misma prueba. */
const require = createRequire(import.meta.url);
const forge = require('@vilic/node-forge');
const RFC = 'MFI6212158B4';
const PASSWORD = 'buena-efirma';
const PDF = Buffer.concat([Buffer.from('%PDF-1.4 documento de juguete\n'),
  Buffer.alloc(1024, 0x2e), Buffer.from('\n%%EOF')]);

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KEY_AES = privateKey.export({ type: 'pkcs8', format: 'der', cipher: 'aes-256-cbc', passphrase: PASSWORD });
const KEY_3DES = privateKey.export({ type: 'pkcs8', format: 'der', cipher: 'des-ede3-cbc', passphrase: PASSWORD });

/* 1 · El cifrado de la llave se lee de su propio DER. */
{
  assert.equal(keyCipherInfo(KEY_AES).cipher, 'aes-256');
  assert.equal(keyCipherInfo(KEY_AES).portalCompatible, false);
  assert.equal(keyCipherInfo(KEY_3DES).cipher, '3des');
  assert.equal(keyCipherInfo(KEY_3DES).portalCompatible, true);
}

/* 2 · La conversión AES → 3DES produce una llave que el motor JS
     del portal (forge, la familia de jsrsasign) sí descifra. */
{
  const converted = convertKeyTo3Des(KEY_AES, PASSWORD);
  assert.equal(keyCipherInfo(converted).cipher, '3des');
  const asn1 = forge.asn1.fromDer(forge.util.createBuffer(converted.toString('binary')));
  assert.ok(forge.pki.decryptPrivateKeyInfo(asn1, PASSWORD), 'forge descifra la copia 3DES');
  const prepared = prepareKeyForPortal(KEY_AES, PASSWORD);
  assert.equal(prepared.converted, true);
  const untouched = prepareKeyForPortal(KEY_3DES, PASSWORD);
  assert.equal(untouched.converted, false);
  assert.deepEqual(untouched.buffer, KEY_3DES);
}

/* 3 · La fase final de la opinión: PDF en Base64 dentro de la
     respuesta completa, como describió Paco de OneFacture. */
{
  const responses = [{ url: 'https://ptsc32d.clouda.sat.gob.mx/api/ObtenerRespuestaCompletaPdf',
    body: JSON.stringify({ encabezado: { estatus: 'ok' }, documento: PDF.toString('base64') }) }];
  assert.deepEqual(extractBase64Pdf(responses), PDF);
  assert.equal(extractBase64Pdf([{ url: 'https://x.test/api', body: '{"aviso":"sin datos"}' }]), null);
}

/* Driver falso: reproduce el contrato de páginas que el módulo usa. */
class FakePage {
  constructor(script = {}) {
    Object.assign(this, { filled: null, clickedText: null, pdf: null, jsonResponses: [],
      errorText: '', afterLogin: '', noButton: false, generateOk: true }, script);
    this.currentUrl = 'about:blank';
  }
  async goto(url) { this.currentUrl = this.afterGoto || url; }
  url() { return typeof this.currentUrl === 'function' ? this.currentUrl() : this.currentUrl; }
  async clickButtonFiel() { if (this.noButton) throw new Error('selector no encontrado'); }
  async fillFielForm(form) { this.filled = form; }
  async submitFiel() { this.currentUrl = this.afterLogin; }
  async divError() { return this.errorText; }
  async clickText(text) { this.clickedText = text; return this.generateOk; }
  async waitForPdf() { return this.pdf; }
  async responses() { return this.jsonResponses; }
  async close() {}
}
const fakeDriver = (page) => {
  const state = { launches: 0, closed: false };
  const launch = async () => { state.launches++;
    return { newPage: async () => page, close: async () => { state.closed = true; } }; };
  return { launch, state };
};
const CREDS = { rfc: RFC, cer: Buffer.from('certificado-de-juguete'), password: PASSWORD };

/* 4 · Constancia en el navegador: login, botón y PDF capturado.
     La llave AES llega al formulario YA convertida a 3DES. */
{
  const page = new FakePage({ pdf: PDF,
    afterLogin: 'https://wwwmat.sat.gob.mx/operacion/43824/reimprime-tus-acuses-del-rfc' });
  const { launch } = fakeDriver(page);
  const fetchBrowser = createSatDocBrowserFetch({ launchDriver: launch, now: () => Date.now(),
    resolveCredentials: async () => ({ ...CREDS, key: KEY_AES }) });
  const result = await fetchBrowser({ rfc: RFC }, 'constancia');
  assert.deepEqual(result.content, PDF);
  assert.equal(result.fileName, RFC + '-csf.pdf', 'convención de nombre de Paco');
  assert.equal(page.clickedText, 'Generar Constancia');
  assert.equal(keyCipherInfo(page.filled.key).cipher, '3des',
    'el formulario recibió la copia 3DES, no la AES original');
  assert.equal(page.filled.password, PASSWORD);
}

/* 5 · Opinión por la fase de respuesta completa en Base64. */
{
  const page = new FakePage({ afterLogin: 'https://ptsc32d.clouda.sat.gob.mx/reporte',
    jsonResponses: [{ url: 'https://ptsc32d.clouda.sat.gob.mx/api/ObtenerRespuestaCompletaPdf',
      body: JSON.stringify({ pdf: PDF.toString('base64') }) }] });
  const { launch } = fakeDriver(page);
  const fetchBrowser = createSatDocBrowserFetch({ launchDriver: launch, now: () => Date.now(),
    resolveCredentials: async () => ({ ...CREDS, key: KEY_3DES }) });
  const result = await fetchBrowser({ rfc: RFC }, 'opinion');
  assert.deepEqual(result.content, PDF);
  assert.equal(result.fileName, RFC + '-32d.pdf', 'convención de nombre de Paco');
}

/* 6 · Rebote en la autorización de la opinión: portal-caido. */
{
  let i = 0;
  const page = new FakePage({ afterLogin: '' });
  page.afterLogin = () => 'https://ptsc32d.clouda.sat.gob.mx/oauth2/authz?n=' + (i++);
  page.currentUrl = '';
  const { launch } = fakeDriver(page);
  const fetchBrowser = createSatDocBrowserFetch({ launchDriver: launch, now: () => Date.now(),
    timeoutMs: 30_000, resolveCredentials: async () => ({ ...CREDS, key: KEY_3DES }) });
  const error = await fetchBrowser({ rfc: RFC }, 'opinion').then(() => null, e => e);
  assert.ok(error instanceof SatDocError);
  assert.equal(error.code, 'portal-caido');
  assert.match(error.message, /rebotando/);
}

/* 7 · El portal rechaza en pantalla: su texto llega tal cual. */
{
  const page = new FakePage({ errorText: 'Certificado revocado o vencido',
    afterLogin: 'https://nidp.example.test/login' });
  const { launch } = fakeDriver(page);
  const fetchBrowser = createSatDocBrowserFetch({ launchDriver: launch, now: () => Date.now(),
    resolveCredentials: async () => ({ ...CREDS, key: KEY_3DES }) });
  const error = await fetchBrowser({ rfc: RFC }, 'constancia').then(() => null, e => e);
  assert.equal(error.code, 'portal-rechaza');
  assert.match(error.message, /Certificado revocado o vencido/);
}

/* 8 · Sin botón de e.firma en la página: respuesta-inesperada y el
     formulario jamás se rellena (nada de la e.firma se teclea). */
{
  const page = new FakePage({ noButton: true });
  const error = await fetchDocumentInBrowser({ page, kind: 'constancia',
    creds: { ...CREDS, key: KEY_3DES } }).then(() => null, e => e);
  assert.equal(error.code, 'respuesta-inesperada');
  assert.equal(page.filled, null);
}

/* 9 · Pipeline: el intento HTTP se detiene en paso-interactivo y el
     navegador completa; si el navegador no está disponible, manda
     el error original; una caducada NO pasa al navegador. */
{
  let browserCalls = 0;
  const pipeline = createSatDocPipelineFetch({
    httpFetch: async () => { throw new SatDocError('paso-interactivo', 'paso en pantalla'); },
    browserFetch: async () => { browserCalls++; return { content: PDF, issuedAt: 'x', fileName: 'f.pdf' }; } });
  const result = await pipeline({ rfc: RFC }, 'constancia');
  assert.deepEqual(result.content, PDF);
  assert.equal(browserCalls, 1);

  const pipelineDown = createSatDocPipelineFetch({
    httpFetch: async () => { throw new SatDocError('paso-interactivo', 'error original HTTP'); },
    browserFetch: async () => { throw new SatDocError('navegador-no-disponible', 'sin navegador'); } });
  const original = await pipelineDown({ rfc: RFC }, 'opinion').then(() => null, e => e);
  assert.equal(original.message, 'error original HTTP');

  let called = 0;
  const pipelineExpired = createSatDocPipelineFetch({
    httpFetch: async () => { throw new SatDocError('caducada', 'caducada'); },
    browserFetch: async () => { called++; } });
  await pipelineExpired({ rfc: RFC }, 'opinion').then(() => null, () => {});
  assert.equal(called, 0, 'la caducidad se detecta en local y no abre navegador');
}

/* 10 · NAVEGADOR REAL contra un portal simulado servido en local:
     el driver de Playwright rellena el formulario de e.firma de la
     página, pulsa «Generar Constancia» y captura el PDF de la
     respuesta; la opinión llega por su fase de respuesta completa.
     Si el entorno no tiene Chromium (CI), la prueba se omite sin
     fallar: queda constancia en la salida. */
{
  const shellPath = join(homedir(), '.cache/ms-playwright/chromium_headless_shell-1248',
    'chrome-headless-shell-linux64/chrome-headless-shell');
  const executablePath = process.env.PACOSAT_CHROMIUM_PATH ||
    (existsSync(shellPath) ? shellPath : '/usr/bin/chromium');
  const loginPage = (action) => `<!doctype html><html><body>
    <h1>SAT · Acceso</h1>
    <button id="buttonFiel" onclick="document.getElementById('fiel').style.display='block'">Acceso con e.firma</button>
    <form id="fiel" style="display:none" action="${action}" method="get">
      <input type="file" id="fileCertificate">
      <input type="file" id="filePrivateKey">
      <input type="password" id="privateKeyPassword">
      <div id="divError"></div>
      <input type="submit" id="submit" value="Enviar">
    </form></body></html>`;
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/lanzador-constancia') { res.setHeader('content-type', 'text/html'); res.end(loginPage('/operacion/43824/reimprime')); }
    else if (url.pathname === '/operacion/43824/reimprime') { res.setHeader('content-type', 'text/html'); res.end('<html><body><a href="/PTSC/IdcSiat/IdcGeneraConstancia.jsf">Generar Constancia</a></body></html>'); }
    else if (url.pathname === '/PTSC/IdcSiat/IdcGeneraConstancia.jsf') { res.setHeader('content-type', 'application/pdf'); res.end(PDF); }
    else if (url.pathname === '/lanzador-opinion') { res.setHeader('content-type', 'text/html'); res.end(loginPage('/opinion/inicio')); }
    else if (url.pathname === '/opinion/inicio') { res.setHeader('content-type', 'text/html'); res.end('<html><body><script>fetch("/api/ObtenerRespuestaCompletaPdf").then(r=>r.json()).then(()=>{document.title="listo";});</script>Generando…</body></html>'); }
    else if (url.pathname === '/api/ObtenerRespuestaCompletaPdf') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ encabezado: 'ok', documento: PDF.toString('base64') })); }
    else { res.statusCode = 404; res.end('no'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  let driver = null;
  try {
    driver = await createPlaywrightDriverFactory({ executablePath })();
  } catch (error) {
    console.log('OMITIDA (sin Chromium en este entorno): prueba de navegador real — ' +
      (error.code || error.message));
  }
  if (driver) {
    try {
      const page = await driver.newPage();
      const csf = await fetchDocumentInBrowser({ page, kind: 'constancia',
        creds: { ...CREDS, key: KEY_AES }, urls: { constancia: base + '/lanzador-constancia' } });
      assert.deepEqual(csf.content, PDF, 'constancia capturada de la respuesta del navegador real');
      const page2 = await driver.newPage();
      const opinion = await fetchDocumentInBrowser({ page: page2, kind: 'opinion',
        creds: { ...CREDS, key: KEY_3DES }, urls: { opinion: base + '/lanzador-opinion' },
        timeoutMs: 30_000 });
      assert.deepEqual(opinion.content, PDF, 'opinión decodificada de su respuesta completa en el navegador real');
      console.log('OK extra: navegador REAL (Chromium local) completó constancia y opinión ' +
        'contra el portal simulado servido en local.');
    } finally {
      await driver.close();
    }
  }
  server.close();
}

console.log('OK: sidecar de navegador — llave AES convertida a 3DES legible por el motor JS ' +
  'del portal, constancia capturada de la respuesta, opinión por su fase de respuesta completa ' +
  'en Base64, rebote y rechazo diferenciados, pipeline HTTP→navegador con caducada sin red.');
