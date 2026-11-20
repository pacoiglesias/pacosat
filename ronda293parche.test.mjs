import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createServer } from 'node:http';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOMParser } from '@xmldom/xmldom';
import { createPacoSATService } from './local-server.mjs';
import { createPlaywrightDriverFactory } from './sat-doc-browser.mjs';
import { createSatTribFetch } from './sat-tributario.mjs';
import { resultadosDiagDe, seccionDiagDe, EJECUTOR_VERSION } from './ejecutor-local.mjs';

/* ================================================================
   Ronda 2.9.3 — UNA pieza: evidencia POR SECCIÓN del Buzón.

   HECHOS EN VIVO (corrida real 805fc97e sobre la 2.9.2, sede
   NAS): la bandeja se leyó (0/0) y la corrida YA guarda su
   evidencia (hasShot/hasHtml en true — la pieza B de la 2.9.2
   funciona en vivo), pero «Mis comunicados» volvió a no
   concluir: clic humano a +32,4 s y 120 s de esperas sin que
   el marco enseñe ni su tabla ni sus conteos. Ya NO es un
   problema de plazos: el contenido de esa sección, en el
   paseo sin cabeza, o no llega o llega en una forma que el
   lector no reconoce — y el artefacto guardado es la página
   de la BANDEJA, no el momento de comunicados: de ESA página
   no quedó evidencia en ningún sitio.

   LA PIEZA: cuando una sección («Mis comunicados» o «Mis
   documentos») concluye o agota su plazo, la corrida guarda
   EN SU DIARIO la página de ESA sección en ese momento:
   HTML completo, captura y un inventario de marcos (la URL
   de cada marco y una muestra de su texto visible). La ruta
   existente /api/tributario/artifact sirve las partes
   nuevas: comunicados-html, comunicados-shot,
   comunicados-marcos (y documentos-* cuando aplica). La
   poda del diario trata estas partes como las demás.

   Se juzga:
   E1 · Motor, réplica de dos orígenes: el marco de
        comunicados NUNCA enseña ni conteos ni tabla (una
        página «cargando» eterna) y el de documentos tampoco
        — las dos secciones agotan su plazo y salen no
        concluyentes honestas — Y el resultado trae la
        evidencia de CADA sección: su HTML (con el marcador
        del marco y su URL), su captura real y su inventario
        de marcos con la URL de cada marco y la muestra de
        su texto («Cargando comunicados…» en el marco mudo).
        Contra la 2.9.2: comunicadosDiag/documentosDiag no
        existen en el resultado (rojo).
   S1 · Sede local: la corrida cuyo motor trae la evidencia
        de sección deja hasComunicadosShot/Html/Marcos (y
        hasDocumentos*) en su diario y la ruta sirve las
        tres partes — el marcos como JSON con los marcos y
        su texto —. Contra la 2.9.2: la ruta rechaza la
        parte («inválida») y las marcas no existen (rojo).
   S2 · Sede ejecutor: el cableado de buzon-listar adjunta
        seccionDiagDe(result.comunicadosDiag) y
        seccionDiagDe(result.documentosDiag) — la forma de
        cable es la de siempre, marcos incluidos — y el
        espejo guarda la evidencia que llega por el
        protocolo: la corrida espejo deja sus marcas y la
        ruta sirve las partes. Contra la 2.9.2: el resultado
        ni siquiera pasaría el protocolo con su evidencia
        (la captura en base64 quedaría en lo estructural y
        se rechazaría como material de credenciales) y el
        espejo no guardaría nada (rojo).

   REGLA LEGAL DURA, intacta: JAMÁS se abre una notificación
   ni un mensaje — los enlaces de detalle de los fixtures
   apuntan a un contador de aperturas que debe quedar a
   cero.
   ================================================================ */

const AQUI = dirname(fileURLToPath(import.meta.url));
const RFC = 'MFI6212158B4';
const ORIGIN = 'https://pacosat.test';
const KEY = 'b'.repeat(64);
const OWN = 'AAA010101AAA';

/* ================================================================
   Arnés de servicio (el de ronda292parche)
   ================================================================ */
function makeHarness(options = {}) {
  const clock = { t: options.start ?? Date.parse('2026-11-18T09:00:00Z') };
  const mails = [];
  const service = createPacoSATService({
    dbFile: ':memory:',
    html: '<html><head><!--PACOSAT_TOKEN--></head><body>prueba</body></html>',
    origin: ORIGIN, proxyKey: KEY, satDocRetryWaitMs: 5,
    makeConnector: () => ({ parser: DOMParser, connector: {
      request: async () => 'req-293', check: async () => ({ status: 'pending', packages: [] }),
      download: async () => { throw new Error('sin paquetes'); } } }),
    makeMailer: () => ({ verify: async () => true,
      sendMail: async payload => { mails.push(payload); return { messageId: 'm' + mails.length }; } }),
    now: () => clock.t, ...options });
  let token = '';
  const raw = async (method, path, body, extraHeaders = {}) => {
    const chunks = []; if (body !== undefined) chunks.push(Buffer.from(JSON.stringify(body)));
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
    const r = await raw(method, path, body, { 'x-pacosat-token': token, ...extraHeaders });
    let json = null; try { json = JSON.parse(r.text); } catch { /* binario */ }
    return { status: r.status, json, text: r.text };
  };
  const exec = async (method, path, body, execToken) => {
    const r = await raw(method, path, body, execToken ? { 'x-pacosat-executor': execToken } : {});
    let json = null; try { json = JSON.parse(r.text); } catch { /* binario */ }
    return { status: r.status, json, text: r.text };
  };
  return { service, call, exec, clock, mails };
}
const unlock = async (h, rfc = OWN) => {
  const open = await h.call('POST', '/api/unlock', { rfc, minutes: 1440, days: 7,
    direction: 'both', password: 'simulated', certificate: 'YQ==', key: 'Yg==' });
  assert.equal(open.status, 200, 'unlock de ' + rfc);
};

/* Una captura de VERDAD (PNG real de 1×1): el validador del
   protocolo solo archiva bytes de imagen reales (corrección
   H-1.5 de sat-executor.mjs). */
const PNG_293 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');
const MARCOS_COM_293 = [
  { url: 'https://wwwmat.sat.gob.mx/iniciar-expediente/mis-comunicados/',
    texto: 'BUZÓN TRIBUTARIO Mis expedientes Mis documentos Mis notificaciones Mis comunicados Cerrar sesión' },
  { url: 'https://agr.siat.sat.gob.mx/comunicados',
    texto: 'Cargando comunicados… un momento, por favor.' }];
const DIAG_COM_293 = () => ({ screenshot: PNG_293,
  html: '<html><body><p>cascara de comunicados de juguete</p>' +
    '<!-- ===== MARCO (iframe): https://agr.siat.sat.gob.mx/comunicados ===== -->' +
    '<html><body><p>Cargando comunicados…</p></body></html></body></html>',
  url: 'https://wwwmat.sat.gob.mx/iniciar-expediente/mis-comunicados/',
  marcos: MARCOS_COM_293.map(m => ({ ...m })) });
const MARCOS_DOC_293 = [
  { url: 'https://wwwmat.sat.gob.mx/iniciar-expediente/mis-documentos/',
    texto: 'BUZÓN TRIBUTARIO Mis expedientes Mis documentos' },
  { url: 'https://agr.siat.sat.gob.mx/documentos', texto: 'Cargando documentos…' }];
const DIAG_DOC_293 = () => ({ screenshot: PNG_293,
  html: '<html><body><p>cascara de documentos de juguete</p></body></html>',
  url: 'https://wwwmat.sat.gob.mx/iniciar-expediente/mis-documentos/',
  marcos: MARCOS_DOC_293.map(m => ({ ...m })) });

/* ================================================================
   S1 · Sede local (NAS): la corrida guarda la evidencia de
   CADA sección y la ruta existente sirve las partes nuevas
   ================================================================ */
{
  const satTribFetch = async () => ({ notifications: [], comunicadosNoLeidos: null,
    comunicados: { concluyente: false, items: [], noLeidos: null, leidos: null,
      motivo: 'La bandeja de «Mis comunicados» no enseñó ni su tabla ni sus conteos en el plazo de espera: no consta su contenido, no es un cero.' },
    comunicadosDiag: DIAG_COM_293(), documentosDiag: DIAG_DOC_293() });
  const h = makeHarness({ executorMode: 'nas', satTribFetch });
  try {
    await unlock(h);
    const run = await h.call('POST', '/api/tributario/run', { rfc: OWN });
    assert.equal(run.json.result.ok, true, 'S1: la consulta concluye');
    const vista = (await h.call('GET', '/api/tributario?rfc=' + OWN)).json;
    const corrida = (vista.runs || [])[0];
    assert.ok(corrida, 'S1: el diario tiene la corrida');
    assert.equal(corrida.hasComunicadosShot, true,
      'S1: la corrida deja la captura de «Mis comunicados» (en la 2.9.2 la parte ni existía)');
    assert.equal(corrida.hasComunicadosHtml, true,
      'S1: la corrida deja el HTML de «Mis comunicados»');
    assert.equal(corrida.hasComunicadosMarcos, true,
      'S1: la corrida deja el inventario de marcos de «Mis comunicados»');
    assert.equal(corrida.hasDocumentosHtml, true,
      'S1: la corrida deja también la evidencia de «Mis documentos»');
    const arteHtml = await h.call('GET',
      '/api/tributario/artifact?run=' + corrida.id + '&part=comunicados-html');
    assert.equal(arteHtml.status, 200,
      'S1: comunicados-html se sirve por /api/tributario/artifact (en la 2.9.2 la parte era «inválida»)');
    assert.ok(arteHtml.text.includes('cascara de comunicados de juguete'),
      'S1: el HTML servido es la página de la sección que la corrida capturó');
    const arteShot = await h.call('GET',
      '/api/tributario/artifact?run=' + corrida.id + '&part=comunicados-shot');
    assert.equal(arteShot.status, 200, 'S1: comunicados-shot se sirve');
    assert.equal(arteShot.text.length, PNG_293.length,
      'S1: la captura servida es, byte a byte, la de la sección');
    const arteMarcos = await h.call('GET',
      '/api/tributario/artifact?run=' + corrida.id + '&part=comunicados-marcos');
    assert.equal(arteMarcos.status, 200, 'S1: comunicados-marcos se sirve');
    const marcos = JSON.parse(arteMarcos.text);
    assert.ok(Array.isArray(marcos) && marcos.length === 2,
      'S1: el inventario lista los marcos de la página de la sección');
    assert.equal(marcos[1].url, 'https://agr.siat.sat.gob.mx/comunicados',
      'S1: el inventario trae la URL del marco de la sección');
    assert.ok(marcos[1].texto.includes('Cargando comunicados'),
      'S1: y una muestra de su texto visible');
    const arteDoc = await h.call('GET',
      '/api/tributario/artifact?run=' + corrida.id + '&part=documentos-html');
    assert.equal(arteDoc.status, 200, 'S1: documentos-html se sirve');
    assert.ok(arteDoc.text.includes('cascara de documentos de juguete'),
      'S1: el HTML de documentos es el de su sección');
    console.log('OK 2.9.3 · S1 — Sede local: la corrida guarda la evidencia por sección (html, captura y marcos) y /api/tributario/artifact sirve las partes nuevas.');
  } finally { h.service.close(); }
}

/* ================================================================
   S2 · Sede ejecutor: el reenvío en buzon-listar, la forma
   de cable y el espejo que guarda la evidencia de sección
   ================================================================ */
{
  const fuente = readFileSync(join(AQUI, 'ejecutor-local.mjs'), 'utf8');
  const idxBuzon = fuente.indexOf("job.kind === 'buzon-listar'");
  const idxDecl = fuente.indexOf("job.kind === 'declaraciones-recuperar'", idxBuzon);
  const ramaBuzon = fuente.slice(idxBuzon, idxDecl > idxBuzon ? idxDecl : undefined);
  assert.ok(idxBuzon >= 0, 'S2: la rama buzon-listar existe en ejecutor-local');
  assert.ok(ramaBuzon.includes('seccionDiagDe(result.comunicadosDiag)'),
    'S2: la rama buzon-listar reenvía la evidencia de comunicados con seccionDiagDe (en la 2.9.2 no existía)');
  assert.ok(ramaBuzon.includes('salida.comunicadosDiag = comunicadosDiag'),
    'S2: la evidencia de comunicados queda adjunta al resultado del trabajo');
  assert.ok(ramaBuzon.includes('seccionDiagDe(result.documentosDiag)'),
    'S2: la rama buzon-listar reenvía también la evidencia de documentos');
  assert.ok(ramaBuzon.includes('salida.documentosDiag = documentosDiag'),
    'S2: la evidencia de documentos queda adjunta al resultado del trabajo');
  /* La forma del cable: la de siempre, con los marcos. */
  const wire = seccionDiagDe(DIAG_COM_293());
  assert.deepEqual(wire, { screenshotBase64: PNG_293.toString('base64'),
    html: DIAG_COM_293().html, url: DIAG_COM_293().url, marcos: MARCOS_COM_293 },
    'S2: la evidencia de sección viaja con la forma de siempre y su inventario de marcos');

  /* El espejo: lo que llega por el protocolo queda guardado
     como evidencia de sección de la corrida espejo. */
  const h = makeHarness({ executorMode: 'remote' });
  try {
    await unlock(h);
    const par = await h.call('POST', '/api/executor/pair', { nombre: 'Equipo de Paco' });
    assert.ok(par.json.token, 'S2: ejecutor emparejado');
    const encolado = await h.call('POST', '/api/tributario/run', { rfc: OWN });
    const jobId = encolado.json?.result?.jobId || encolado.json?.jobId;
    assert.ok(jobId, 'S2: la consulta remota encola su trabajo: ' + encolado.text.slice(0, 200));
    const claim = await h.exec('POST', '/api/executor/claim', { limit: 5 }, par.json.token);
    assert.ok((claim.json.trabajos || []).some(t => t.id === jobId),
      'S2: el ejecutor reclama el trabajo del Buzón');
    const res = await h.exec('POST', '/api/executor/result', { jobId, status: 'done',
      result: { steps: [{ at: Date.now(), paso: 'Lista leída', detalle: '0 en la bandeja' }],
        operations: ['entrar-con-efirma', 'navegar-a-lista', 'leer-lista'],
        accesoOk: true, notifications: [], comunicadosNoLeidos: null,
        comunicadosDiag: { screenshotBase64: PNG_293.toString('base64'),
          html: DIAG_COM_293().html, url: DIAG_COM_293().url, marcos: MARCOS_COM_293 } } },
      par.json.token);
    assert.equal(res.json.job.estado, 'hecho',
      'S2: el trabajo con evidencia de sección se da por hecho (el protocolo la admite como narrativa): ' + res.text.slice(0, 200));
    const vista = (await h.call('GET', '/api/tributario?rfc=' + OWN)).json;
    const corrida = (vista.runs || [])[0];
    assert.ok(corrida, 'S2: el diario tiene la corrida espejo');
    assert.equal(corrida.hasComunicadosHtml, true,
      'S2: la corrida espejo guarda el HTML de la sección');
    assert.equal(corrida.hasComunicadosMarcos, true,
      'S2: la corrida espejo guarda el inventario de marcos de la sección');
    const arte = await h.call('GET',
      '/api/tributario/artifact?run=' + corrida.id + '&part=comunicados-marcos');
    assert.equal(arte.status, 200, 'S2: el inventario de la corrida espejo se sirve');
    const marcos = JSON.parse(arte.text);
    assert.equal(marcos[1].url, 'https://agr.siat.sat.gob.mx/comunicados',
      'S2: y trae la URL del marco de comunicados');
    console.log('OK 2.9.3 · S2 — Sede ejecutor: buzon-listar reenvía la evidencia por sección y la corrida espejo la guarda y la sirve.');
  } finally { h.service.close(); }
}

/* ================================================================
   E1 · Motor: las secciones agotan su plazo y la evidencia
   de CADA sección queda en el resultado, con sus marcos
   (réplica con dos orígenes y Chromium real, patrón de
   ronda292parche)
   ================================================================ */
function chromiumDePrueba() {
  const candidatos = [process.env.PACOSAT_TEST_CHROMIUM || '', '/usr/bin/chromium'];
  try {
    const cache = join(homedir(), '.cache', 'ms-playwright');
    for (const dir of readdirSync(cache).sort()) {
      if (dir.startsWith('chromium-')) candidatos.push(join(cache, dir, 'chrome-linux64', 'chrome'));
    }
  } catch { /* sin caché de playwright: quedan los otros candidatos */ }
  return candidatos.find(p => p && existsSync(p)) || '';
}
const CHROME = chromiumDePrueba();
assert.ok(CHROME, 'ronda293parche (E1) necesita un Chromium local para la réplica: ' +
  'sin navegador la prueba que puede fallar no puede correr.');

let aperturas = 0;
const bandejaVacia293 = `<!DOCTYPE html><html><body>
  <p>Destinatario: ${RFC}</p>
  <p>Total de notificaciones pendientes: 0</p>
  <p>No se encontraron resultados</p>
</body></html>`;
/* El marco MUDO de comunicados: carga, enseña su texto de
   espera y JAMÁS pinta ni conteos ni tabla — la forma viva
   de la corrida 805fc97e, donde la sección agotó 120 s de
   esperas sin enseñar nada legible. */
const marcoComunicadosMudo293 = `<!DOCTYPE html><html><body>
  <p>Cargando comunicados… un momento, por favor.</p>
</body></html>`;
const marcoDocumentosMudo293 = `<!DOCTYPE html><html><body>
  <p>Cargando documentos… un momento, por favor.</p>
</body></html>`;
const serverMarcos = createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  if (path.startsWith('/abrir-mensaje/') || path.startsWith('/abrir-documento/')) {
    aperturas += 1;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!DOCTYPE html><html><body><h1>Abierto</h1></body></html>');
    return;
  }
  const servir = (html, ms) => setTimeout(() => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  }, ms);
  if (path === '/bandeja') return servir(bandejaVacia293, 800);
  if (path === '/comunicados-mudo') return servir(marcoComunicadosMudo293, 600);
  if (path === '/documentos-mudo') return servir(marcoDocumentosMudo293, 600);
  res.writeHead(404); res.end();
});
await new Promise(resolve => serverMarcos.listen(0, '127.0.0.1', resolve));
const ORIGEN2 = 'http://127.0.0.1:' + serverMarcos.address().port;

const paginaAcceso293 = (fiel) => `<!DOCTYPE html><html><body>
  <h1>Acceso por contraseña</h1>
  <a id="buttonFiel" href="${fiel}">Acceso con e.firma</a>
</body></html>`;
const formularioLogin293 = (destino) => `<!DOCTYPE html><html><body>
  <h1>SAT Autenticación</h1>
  <form id="certform">
    <input type="text" id="txtCertificate">
    <input type="file" id="fileCertificate" style="display:none">
    <input type="text" id="txtPrivateKey">
    <input type="file" id="filePrivateKey" style="display:none">
    <input type="password" id="privateKeyPassword">
    <input type="text" id="rfc">
    <div id="divError" style="display:none"></div>
    <button type="button" id="submit">Acceder</button>
  </form>
  <script>
    document.getElementById('fileCertificate').addEventListener('change', () => {
      setTimeout(() => { document.getElementById('txtCertificate').value = 'certificado.cer'; }, 300);
      setTimeout(() => { document.getElementById('rfc').value = '${RFC}'; }, 600);
    });
    document.getElementById('filePrivateKey').addEventListener('change', () => {
      setTimeout(() => { document.getElementById('txtPrivateKey').value = 'llave.key'; }, 300);
    });
    document.getElementById('submit').addEventListener('click', () => {
      const falta = !document.getElementById('rfc').value ||
        !document.getElementById('fileCertificate').files.length ||
        !document.getElementById('filePrivateKey').files.length ||
        !document.getElementById('privateKeyPassword').value;
      if (falta) {
        const d = document.getElementById('divError');
        d.textContent = '¡Error! no ha llenado varios campos requeridos. Por favor verifique.';
        d.style.display = 'block';
        return;
      }
      location.href = '${destino}';
    });
  </script>
</body></html>`;
const cabeceraOk293 = (destinoNotificaciones, hrefComunicados) => `
  <header>
    <span>BUZÓN TRIBUTARIO</span>
    <button id="btn-expedientes" type="button">Mis expedientes</button>
    <nav id="menu-expedientes" style="display:none">
      <a href="#" data-nav="documentos">Mis documentos</a>
      <a href="#" id="link-notificaciones">Mis notificaciones</a>
      <a href="${hrefComunicados}">Mis comunicados</a>
    </nav>
    <a href="#" data-nav="salir">Cerrar sesión</a>
  </header>
  <script>
    document.getElementById('btn-expedientes').addEventListener('click', () => {
      const m = document.getElementById('menu-expedientes');
      m.style.display = m.style.display === 'none' ? 'block' : 'none';
    });
    document.getElementById('link-notificaciones').addEventListener('click', (ev) => {
      ev.preventDefault();
      location.href = '${destinoNotificaciones}';
    });
  </script>`;
const paginaBuzon293 = (destinoNotificaciones, hrefComunicados) =>
  `<!DOCTYPE html><html><body>${cabeceraOk293(destinoNotificaciones, hrefComunicados)}<main></main></body></html>`;
const cascara293 = (cabecera, marco) =>
  `<!DOCTYPE html><html><body>${cabecera}
  <main><iframe id="iframetoload" src="${marco}"></iframe></main>
</body></html>`;

const R = (x, que) => '/iniciar-expediente/mis-' + que + '-' + x + '/';
const serverPortal = createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  const rutas = {
    '/acceso-e1': paginaAcceso293('/acceso-fiel-e1'),
    '/acceso-fiel-e1': formularioLogin293('/buzon-e1'),
    '/buzon-e1': paginaBuzon293(R('e1', 'notificaciones'), R('e1', 'comunicados')),
    [R('e1', 'notificaciones')]: cascara293(cabeceraOk293(R('e1', 'notificaciones'), R('e1', 'comunicados')), ORIGEN2 + '/bandeja'),
    [R('e1', 'comunicados')]: cascara293(cabeceraOk293(R('e1', 'notificaciones'), R('e1', 'comunicados')), ORIGEN2 + '/comunicados-mudo'),
    [R('e1', 'documentos')]: cascara293(cabeceraOk293(R('e1', 'notificaciones'), R('e1', 'comunicados')), ORIGEN2 + '/documentos-mudo')
  };
  const html = rutas[path];
  if (!html) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
});
await new Promise(resolve => serverPortal.listen(0, '127.0.0.1', resolve));
const ORIGEN1 = 'http://127.0.0.1:' + serverPortal.address().port;

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KEY_PORTAL = privateKey.export({ type: 'pkcs8', format: 'der',
  cipher: 'des-ede3-cbc', passphrase: 'pw-de-juguete' });
const CER = Buffer.from('certificado-de-juguete');
const resolverReal = async (profile) => ({ rfc: profile.rfc, cer: CER, key: KEY_PORTAL,
  password: 'pw-de-juguete' });

{
  const trib = createSatTribFetch({ resolveCredentials: resolverReal,
    launchDriver: createPlaywrightDriverFactory({ executablePath: CHROME, headless: true }),
    entryUrl: ORIGEN1 + R('e1', 'notificaciones'), loginUrl: ORIGEN1 + '/acceso-e1',
    comunicadosUrl: ORIGEN1 + R('e1', 'comunicados'),
    documentosUrl: ORIGEN1 + R('e1', 'documentos'), esperaBandejaMs: 6_000 });
  const pasos = [];
  const aperturasAntes = aperturas;
  const resultado = await trib({ rfc: RFC }, {},
    { onStep: (paso, detalle) => pasos.push({ paso, detalle }) })
    .catch(error => { throw new Error('E1: la corrida debía concluir: ' +
      (error.code || '') + ' — ' + (error.message || error)); });
  assert.deepEqual(resultado.notifications, [], 'E1: la bandeja vacía se lee');
  /* La honestidad de siempre: sin conteos ni tabla, la
     sección sale no concluyente y el conteo viaja null. */
  assert.equal(resultado.comunicados?.concluyente, false,
    'E1: comunicados agota su plazo y sale no concluyente');
  assert.equal(resultado.comunicadosNoLeidos, null,
    'E1: el conteo viaja null — jamás un cero fingido');
  assert.equal(resultado.documentos?.concluyente, false,
    'E1: documentos agota su plazo y sale no concluyente');
  /* LA PIEZA: la evidencia de ESA sección, en el resultado. */
  const diagCom = resultado.comunicadosDiag;
  assert.ok(diagCom,
    'E1: el resultado trae la evidencia de «Mis comunicados» (en la 2.9.2 no existía: solo la de la bandeja)');
  assert.ok(String(diagCom.html || '').includes(ORIGEN2 + '/comunicados-mudo'),
    'E1: el HTML guardado es la página de comunicados, con su marco');
  assert.ok(Buffer.isBuffer(diagCom.screenshot) && diagCom.screenshot.length > 100 &&
    diagCom.screenshot[0] === 0x89 && diagCom.screenshot[1] === 0x50,
    'E1: la evidencia de comunicados trae su captura (PNG real)');
  assert.ok(Array.isArray(diagCom.marcos) && diagCom.marcos.length >= 2,
    'E1: el inventario lista los marcos de la página de comunicados');
  assert.equal(diagCom.marcos[0].url, ORIGEN1 + R('e1', 'comunicados'),
    'E1: el primer marco del inventario es la propia página de la sección');
  const marcoMudo = diagCom.marcos.find(m => m.url === ORIGEN2 + '/comunicados-mudo');
  assert.ok(marcoMudo, 'E1: el inventario trae la URL del marco de comunicados');
  assert.ok(marcoMudo.texto.includes('Cargando comunicados'),
    'E1: y la muestra de su texto visible — lo que el marco enseñaba: «' + (marcoMudo?.texto || '') + '»');
  const diagDoc = resultado.documentosDiag;
  assert.ok(diagDoc,
    'E1: el resultado trae también la evidencia de «Mis documentos»');
  const marcoDoc = (diagDoc.marcos || []).find(m => m.url === ORIGEN2 + '/documentos-mudo');
  assert.ok(marcoDoc && marcoDoc.texto.includes('Cargando documentos'),
    'E1: el inventario de documentos trae su marco y su texto');
  assert.equal(aperturas - aperturasAntes, 0, 'E1: cero aperturas');
  console.log('OK 2.9.3 · E1 — Motor: comunicados y documentos agotan su plazo sin concluir y la evidencia de CADA sección (html, captura e inventario de marcos) queda en el resultado.');
}

serverPortal.close();
serverMarcos.close();

/* ================================================================
   Estáticas de la ronda
   ================================================================ */
{
  const pkg = JSON.parse(readFileSync(join(AQUI, 'package.json'), 'utf8'));
  assert.equal(pkg.version, '2.9.16', 'la ronda es la 2.9.3');
  assert.ok(pkg.scripts.test.includes('ronda293parche.test.mjs'),
    'la suite está registrada en la batería');
  assert.equal(EJECUTOR_VERSION, '2.9.16', 'el sello del ejecutor acompaña a la versión');
  console.log('OK 2.9.3 · Estáticas — versión 2.9.3, suite en la batería y sello del ejecutor.');
}

console.log('OK suite ronda293parche completa');
