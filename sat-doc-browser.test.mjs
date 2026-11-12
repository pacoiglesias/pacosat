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

/* 11 · Progreso en lenguaje llano (1.10.1): el flujo emite los
     pasos por el gancho, en orden y con la URL del momento, para
     que el servidor los persista y la pantalla los enseñe en vivo. */
{
  const page = new FakePage({ pdf: PDF,
    afterLogin: 'https://wwwmat.sat.gob.mx/operacion/43824/reimprime-tus-acuses-del-rfc' });
  const steps = [];
  const result = await fetchDocumentInBrowser({ page, kind: 'constancia',
    creds: { ...CREDS, key: KEY_3DES },
    hooks: { step: (text, url) => steps.push({ text, url }) } });
  assert.deepEqual(result.content, PDF);
  assert.deepEqual(steps.map(item => item.text),
    ['Conectando con el SAT…', 'Firmando con tu e.firma…', 'Pidiendo la constancia…']);
  assert.ok(steps.every(item => typeof item.url === 'string'));
}

/* 12 · El error del navegador viaja con su diagnóstico (1.10.1):
     captura y HTML de la página en el punto del fallo, para que el
     servidor lo guarde en el diario de la corrida. */
{
  const page = new FakePage({ noButton: true });
  page.diagnostics = async () => ({ url: 'https://login.example.test/fiel',
    screenshot: Buffer.from([0x89, 0x50, 0x4e, 0x47]), html: '<html><body>acceso</body></html>' });
  const { launch } = fakeDriver(page);
  const fetchDiag = createSatDocBrowserFetch({ launchDriver: launch,
    resolveCredentials: async () => ({ ...CREDS, key: KEY_3DES }) });
  const error = await fetchDiag({ rfc: RFC }, 'constancia').then(() => null, e => e);
  assert.equal(error.code, 'respuesta-inesperada');
  assert.equal(error.diag.url, 'https://login.example.test/fiel');
  assert.deepEqual([...error.diag.screenshot], [0x89, 0x50, 0x4e, 0x47]);
  assert.ok(error.diag.html.includes('acceso'));
}

/* 13 · NAVEGADOR REAL contra la FORMA REAL del portal (1.10.1):
     la entrada cae en «Acceso por contraseña» y el acceso con
     e.firma NAVEGA a otra página cuyo formulario trae los inputs
     de archivo ocultos (display:none) — la forma exacta que mató
     la primera corrida real de la 1.9.0 (timeout esperando
     #fileCertificate sin esperar a que el documento nuevo lo
     trajera) —. El login la atraviesa entera; el rechazo en
     pantalla se detecta por su #divError y diagnostics() entrega
     la foto del momento. */
{
  const shellPath = join(homedir(), '.cache/ms-playwright/chromium_headless_shell-1248',
    'chrome-headless-shell-linux64/chrome-headless-shell');
  const executablePath = process.env.PACOSAT_CHROMIUM_PATH ||
    (existsSync(shellPath) ? shellPath : '/usr/bin/chromium');
  const passwordPage = (href) => `<!doctype html><html><body>
    <h1>SAT Autenticación</h1>
    <form id="IDPLogin"><input type="text" id="rfc" name="Ecom_User_ID">
    <input type="password" id="password" name="Ecom_Password">
    <input type="submit" id="submit" value="Enviar">
    <a id="buttonFiel" href="${href}">e.firma</a></form></body></html>`;
  const fielPage = (onclick) => `<!doctype html><html><body>
    <h1>Acceso con e.firma</h1>
    <form id="certform" method="post">
      <input class="Box" type="text" id="txtCertificate" readonly>
      <input type="file" style="display: none" accept=".cer" id="fileCertificate">
      <input class="Box" type="text" id="txtPrivateKey" readonly>
      <input type="file" style="display: none" accept=".key" id="filePrivateKey">
      <input type="password" id="privateKeyPassword" name="privateKeyPassword">
      <div id="divError" style="display:none">Certificado, clave privada o contraseña de clave privada inválidos</div>
      <input type="button" id="submit" value="Enviar" onclick="${onclick}">
    </form></body></html>`;
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/PTSC/IdcSiat/IdcGeneraConstancia.jsf') {
      res.setHeader('content-type', 'application/pdf'); res.end(PDF); return;
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    if (url.pathname === '/lanzador-v2') res.end(passwordPage('/fiel-v2'));
    else if (url.pathname === '/fiel-v2') res.end(fielPage("location.href='/operacion/43824/reimprime'"));
    else if (url.pathname === '/operacion/43824/reimprime') res.end('<html><body><a href="/PTSC/IdcSiat/IdcGeneraConstancia.jsf">Generar Constancia</a></body></html>');
    else if (url.pathname === '/lanzador-rechazo') res.end(passwordPage('/fiel-rechazo'));
    else if (url.pathname === '/fiel-rechazo') res.end(fielPage("document.getElementById('divError').style.display='block'"));
    else { res.statusCode = 404; res.end('no'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  let driver = null;
  try {
    driver = await createPlaywrightDriverFactory({ executablePath })();
  } catch (error) {
    console.log('OMITIDA (sin Chromium en este entorno): prueba de la forma real del portal — ' +
      (error.code || error.message));
  }
  if (driver) {
    try {
      const page = await driver.newPage();
      const csf = await fetchDocumentInBrowser({ page, kind: 'constancia',
        creds: { ...CREDS, key: KEY_3DES }, urls: { constancia: base + '/lanzador-v2' } });
      assert.deepEqual(csf.content, PDF,
        'constancia a través de la navegación real a la página de e.firma con inputs ocultos');
      /* El diagnóstico se toma sobre un estado de página DETERMINADO:
         tras la bajada buena, la página principal puede quedar en la
         de reimpresión o en el visor de PDF del navegador según el
         entorno (visto en CI, 12 nov 2026: el visor ganó la carrera y
         la aserción sobre «Generar Constancia» falló sin que el
         producto fallara). Se navega de vuelta a la página de
         reimpresión del portal simulado y el diagnóstico se juzga
         sobre esa página conocida. */
      await page.goto(base + '/operacion/43824/reimprime');
      const diag = await page.diagnostics();
      assert.equal(diag.screenshot[0], 0x89, 'diagnostics entrega la captura PNG');
      assert.ok(diag.html.includes('Generar Constancia'), 'diagnostics entrega el HTML de la página');
      const rejected = await fetchDocumentInBrowser({ page, kind: 'constancia',
        creds: { ...CREDS, key: KEY_3DES }, urls: { constancia: base + '/lanzador-rechazo' } })
        .then(() => null, e => e);
      assert.equal(rejected.code, 'portal-rechaza');
      assert.match(rejected.message, /inválidos/);
      console.log('OK extra: la FORMA REAL del portal (navegación a e.firma, inputs ocultos) ' +
        'se atraviesa en Chromium local y el rechazo deja diagnóstico.');
    } finally {
      await driver.close();
    }
  }
  server.close();
}


/* 14 · CONSTANCIA DESDE EL BUZÓN (1.13.0, evidencia real 10 nov
     2026): la landing tras firmar es el Buzón Tributario y el
     trámite vive en un iframe (SessionBroker → ConsultaTramite);
     en la página principal NO hay botón. El marco tarda en
     aparecer y su botón tarda más: el flujo entra al trámite, lo
     anuncia en el diario y captura el PDF. */
{
  const FRAME_URL = 'https://rfcampc.siat.sat.gob.mx/app/seg/SessionBroker?url=/PTSC/IdcSiat/autc/ReimpresionTramite/ConsultaTramite.jsf&parametro=c';
  const page = new FakePage({ pdf: PDF, afterLogin: 'https://wwwmat.sat.gob.mx/accesoC/inicio' });
  let frameCalls = 0, generateCalls = 0;
  page.tramiteFrameUrl = async () => (++frameCalls >= 2 ? FRAME_URL : '');
  page.clickText = async () => false; /* en el Buzón no hay botón en la página */
  page.clickFrameGenerate = async () => (++generateCalls >= 2);
  page.diagnostics = async () => ({ url: page.url(), screenshot: null,
    html: '<html><title>BUZÓN TRIBUTARIO</title></html>',
    frames: [{ url: FRAME_URL, html: '<html>ConsultaTramite</html>' }] });
  const { launch } = fakeDriver(page);
  const steps = [];
  const fetchBrowser = createSatDocBrowserFetch({ launchDriver: launch, now: () => Date.now(),
    resolveCredentials: async () => ({ ...CREDS, key: KEY_3DES }) });
  const result = await fetchBrowser({ rfc: RFC }, 'constancia',
    { step: (text, url) => steps.push({ text, url }) });
  assert.deepEqual(result.content, PDF, 'la constancia baja desde el marco del Buzón');
  const entrada = steps.find(step => step.text === 'Entrando al trámite…');
  assert.ok(entrada, 'el diario anuncia la entrada al trámite');
  assert.equal(entrada.url, FRAME_URL, 'el paso lleva la URL del marco');
  console.log('OK 1.13.0: constancia desde el Buzón — marco vigilado, botón tardío dentro del marco y PDF capturado.');
}

/* 15 · EL MARCO NUNCA APARECE (1.13.0): error claro paso-interactivo
     y el diagnóstico viaja con los marcos, no solo con la página. */
{
  const page = new FakePage({ afterLogin: 'https://wwwmat.sat.gob.mx/accesoC/inicio' });
  page.tramiteFrameUrl = async () => '';
  page.clickText = async () => false;
  page.diagnostics = async () => ({ url: page.url(), screenshot: null,
    html: '<html><title>BUZÓN TRIBUTARIO</title></html>',
    frames: [{ url: 'https://wwwmat.sat.gob.mx/accesoC/inicio', html: '<html>BUZÓN SIN MARCO</html>' }] });
  const { launch } = fakeDriver(page);
  const fetchBrowser = createSatDocBrowserFetch({ launchDriver: launch, now: () => Date.now(),
    timeoutMs: 6_000, resolveCredentials: async () => ({ ...CREDS, key: KEY_3DES }) });
  const error = await fetchBrowser({ rfc: RFC }, 'constancia').then(() => null, e => e);
  assert.ok(error instanceof SatDocError);
  assert.equal(error.code, 'paso-interactivo');
  assert.match(error.message, /marco \(iframe\)/, 'el error nombra el marco que no apareció');
  assert.ok(error.diag, 'el fallo viaja con diagnóstico');
  assert.ok(Array.isArray(error.diag.frames) && error.diag.frames.length === 1,
    'el diagnóstico incluye los marcos de la página');
  console.log('OK 1.13.0: sin marco del trámite, error claro y diagnóstico con marcos.');
}

/* 16 · NAVEGADOR REAL contra el BUZÓN simulado (1.13.0): el Buzón
     con su iframe#iframetoload hacia un SessionBroker que sirve
     ConsultaTramite con el botón COMO INPUT (value=, sin texto) y
     TARDE (1,2 s); el clic abre el PDF en la propia navegación del
     marco. Y la variante rota: sin botón nunca, el diagnóstico del
     fallo contiene el HTML DEL MARCO tras su marcador. */
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
  const buzonPage = (broker) => `<!doctype html><html><head><title>BUZÓN TRIBUTARIO</title></head><body>
    <nav>Inicio › Constancia de Situación Fiscal</nav>
    <h1>Buzón Tributario de ${RFC} | empresa de prueba</h1>
    <iframe id="iframetoload" src="${broker}"></iframe></body></html>`;
  const tramitePage = (conBoton) => `<!doctype html><html><body>
    <h2>Reimpresión de acuses del RFC</h2><p id="marca-tramite">CONSULTA-TRAMITE-SIMULADO</p>
    ${conBoton ? `<script>setTimeout(() => {
      const b = document.createElement('input');
      b.type = 'submit'; b.value = 'Generar Constancia';
      b.onclick = () => { location.href = '/PTSC/IdcSiat/IdcGeneraConstancia.jsf'; };
      document.body.append(b);
    }, 1200);</script>` : '<p>El trámite no ofrece el botón en esta variante.</p>'}
    </body></html>`;
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    res.setHeader('content-type', 'text/html; charset=utf-8');
    if (url.pathname === '/PTSC/IdcSiat/IdcGeneraConstancia.jsf') {
      res.setHeader('content-type', 'application/pdf'); res.end(PDF);
    }
    else if (url.pathname === '/lanzador-buzon') res.end(loginPage('/buzon'));
    else if (url.pathname === '/buzon') res.end(buzonPage('/app/seg/SessionBroker?url=/PTSC/IdcSiat/autc/ReimpresionTramite/ConsultaTramite.jsf&parametro=c'));
    else if (url.pathname === '/app/seg/SessionBroker') res.end(tramitePage(true));
    else if (url.pathname === '/lanzador-buzon-roto') res.end(loginPage('/buzon-roto'));
    else if (url.pathname === '/buzon-roto') res.end(buzonPage('/broker-roto'));
    else if (url.pathname === '/broker-roto') res.end(tramitePage(false));
    else { res.statusCode = 404; res.end('no'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  let driver = null;
  try {
    driver = await createPlaywrightDriverFactory({ executablePath })();
  } catch (error) {
    console.log('OMITIDA (sin Chromium en este entorno): prueba del Buzón simulado — ' +
      (error.code || error.message));
  }
  if (driver) {
    let driver2 = null;
    try {
      const page = await driver.newPage();
      const steps = [];
      const csf = await fetchDocumentInBrowser({ page, kind: 'constancia',
        creds: { ...CREDS, key: KEY_3DES }, urls: { constancia: base + '/lanzador-buzon' },
        hooks: { step: (text, url) => steps.push({ text, url }) } });
      assert.deepEqual(csf.content, PDF, 'constancia real desde el iframe del Buzón simulado');
      assert.ok(steps.some(step => step.text === 'Entrando al trámite…' &&
        step.url.includes('SessionBroker')), 'el diario registra la entrada al trámite con su URL');
      /* Variante rota: driver NUEVO (las pilas de PDF son del
         contexto: reutilizar el de la corrida buena contaminaría
         la espera con su PDF). El error es paso-interactivo y el
         diagnóstico de su página trae el HTML del marco. */
      driver2 = await createPlaywrightDriverFactory({ executablePath })();
      const page2 = await driver2.newPage();
      const error = await fetchDocumentInBrowser({ page: page2, kind: 'constancia',
        creds: { ...CREDS, key: KEY_3DES }, urls: { constancia: base + '/lanzador-buzon-roto' },
        timeoutMs: 9_000 }).then(() => null, e => e);
      assert.ok(error instanceof SatDocError);
      assert.equal(error.code, 'paso-interactivo');
      const diag = await page2.diagnostics();
      assert.ok(diag.frames.length >= 1, 'diagnostics ve el marco del Buzón');
      assert.ok(diag.html.includes('MARCO (iframe)'), 'el HTML compuesto marca la sección del marco');
      assert.ok(diag.html.includes('CONSULTA-TRAMITE-SIMULADO'), 'el HTML del marco viaja en el diagnóstico');
      console.log('OK extra: navegador REAL — constancia desde el iframe del Buzón (botón input tardío) ' +
        'y diagnóstico con el HTML del marco cuando el botón no aparece.');
      if (driver2) await driver2.close();
    } finally {
      await driver.close();
    }
  }
  server.close();
}

console.log('OK: sidecar de navegador — llave AES convertida a 3DES legible por el motor JS ' +
  'del portal, constancia capturada de la respuesta, opinión por su fase de respuesta completa ' +
  'en Base64, rebote y rechazo diferenciados, pipeline HTTP→navegador con caducada sin red.');
