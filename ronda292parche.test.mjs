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
import { resultadosDiagDe, EJECUTOR_VERSION } from './ejecutor-local.mjs';

/* ================================================================
   Ronda 2.9.2 — las dos piezas que la prueba de verdad de la
   2.9.1 dejó nombradas (historial, 18 nov 2026, 03:04–03:20):
   la bandeja y las Declaraciones leen desde el NAS, pero
   «Mis comunicados» siguió no concluyente en vivo y las
   corridas del Buzón no guardaron su evidencia.

   PIEZA A · Comunicados no concluye EN VIVO. Diagnóstico con
   los tiempos de la corrida real ae67cdfa (diario guardado):
   la bandeja se leyó a +40,1 s; el paso del camino humano de
   comunicados salió a +43,0 s; «Comunicados sin conteo
   legible» a +102,4 s — 59,4 s, el límite ÚNICO que la 2.9.1
   compartía entre la lectura previa, el camino humano y la
   reserva directa (limiteCom calculado al abrir el bloque).
   La reserva directa arrancó con el plazo vencido: su goto
   recargó la cáscara (reiniciando la carga de su marco) y su
   espera quedó en una sola lectura con el marco frío. La
   bandeja nunca tuvo ese defecto: esperarBandeja calcula su
   límite AL EMPEZAR cada vía y cada vía recibe el plazo
   completo, y su vía directa no re-navega si ya está en la
   ruta. Se juzga contra una réplica fiel a la estructura del
   recon del 16 nov 2026 (grupos «Mensajes no leídos (2)» /
   «Mensajes leídos (7)» y su tabla con las filas del recon:
   los dos sin leer de «Registro o actualización de medios
   de contacto», 28/08/2026 y 07/06/2022):
   A1 · El marco de la sección tarda 45 s con un plazo de
        40 s: el camino humano lo espera entero y no basta;
        la reserva — ya en la ruta, SIN recargar — sigue
        esperando con su plazo fresco y concluye. Contra la
        2.9.1: el límite compartido vence en el camino humano
        y la reserva lee una vez con el marco recargado y
        frío → no concluyente (rojo).
   A2 · El clic cae en el marco equivocado: sobre la página
        de la bandeja, la cabecera no despliega su menú y el
        marco de la bandeja trae un elemento gemelo con el
        texto exacto «Mis comunicados» que no enruta la
        página principal (clickTextExactoVisible busca en
        todos los marcos y devuelve true igual: el paso del
        camino humano sale en el diario, como en ae67cdfa).
        El sondeo quema su plazo sobre la página equivocada
        y la reserva directa, con plazo fresco, llega a la
        sección y concluye. Contra la 2.9.1: la reserva
        hereda el plazo vencido y lee antes de que el marco
        de la directa (4 s) exista → no concluyente (rojo).
   A3 · Honestidad intacta: la sección no enseña ni conteos
        ni tabla por ninguna vía → no concluyente con su
        motivo, la corrida sigue bien y nada se inventa.

   PIEZA B · Las corridas del Buzón no guardan su evidencia:
   962e463f y ae67cdfa cerraron ok=true con hasShot/hasHtml
   en false y GET /api/tributario/artifact → 404 en las dos,
   mientras Declaraciones guarda también en las buenas (su
   artefacto de la 1d8f086b fue el fixture de la pieza 5 de
   la 2.9.1). La cadena estaba rota en tres eslabones: el
   MOTOR nunca producía resultadosDiag (solo diag de error);
   la sede local no lo reenviaba ni closeRun lo archivaba en
   el éxito; y el ejecutor no lo reenviaba en buzon-listar
   (el protocolo, su validador — que convierte la forma de
   cable a directa y solo archiva imágenes de verdad — y el
   espejo del servidor ya lo esperaban desde la 2.4.0,
   castigo 28). Se juzga: (motor) la corrida
   real de la Pieza A trae resultadosDiag con la página de la
   bandeja; (sede local) la corrida buena deja hasShot/
   hasHtml y el artefacto se sirve por la ruta existente —
   rojo contra la 2.9.1 —; (sede ejecutor) el cableado de
   ejecutor-local adjunta resultadosDiagDe(result) en la rama
   buzon-listar (ejecutarIntento no es importable: se juzga
   su texto, como en ronda240buzonx) y el espejo guarda la
   evidencia que llega por el protocolo.

   REGLA LEGAL DURA, intacta: JAMÁS se abre una notificación
   ni un mensaje — los enlaces de detalle de los fixtures
   apuntan a un contador de aperturas que debe quedar a cero.
   ================================================================ */

const AQUI = dirname(fileURLToPath(import.meta.url));
const RFC = 'MFI6212158B4';
const ORIGIN = 'https://pacosat.test';
const KEY = 'b'.repeat(64);
const OWN = 'AAA010101AAA';

/* ================================================================
   Arnés de servicio (el de ronda291parche)
   ================================================================ */
function makeHarness(options = {}) {
  const clock = { t: options.start ?? Date.parse('2026-11-18T09:00:00Z') };
  const mails = [];
  const service = createPacoSATService({
    dbFile: ':memory:',
    html: '<html><head><!--PACOSAT_TOKEN--></head><body>prueba</body></html>',
    origin: ORIGIN, proxyKey: KEY, satDocRetryWaitMs: 5,
    makeConnector: () => ({ parser: DOMParser, connector: {
      request: async () => 'req-292', check: async () => ({ status: 'pending', packages: [] }),
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
   H-1.5 de sat-executor.mjs) — con una captura fingida la
   foto se descarta por diseño y la prueba mentiría. */
const PNG_292 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');
const HTML_BANDEJA_292 = '<html><body><p>Destinatario: ' + OWN + '</p>' +
  '<p>Total de notificaciones pendientes: 0</p><p>No se encontraron resultados</p></body></html>';
const DIAG_292 = () => ({ screenshot: PNG_292, html: HTML_BANDEJA_292,
  url: 'https://wwwmat.sat.gob.mx/iniciar-expediente/mis-notificaciones/' });

/* ================================================================
   PIEZA B1 · Sede local (NAS): la corrida buena deja su
   evidencia y la ruta existente la sirve
   ================================================================ */
{
  const satTribFetch = async () => ({ notifications: [], comunicadosNoLeidos: 0,
    resultadosDiag: DIAG_292() });
  const h = makeHarness({ executorMode: 'nas', satTribFetch });
  try {
    await unlock(h);
    const run = await h.call('POST', '/api/tributario/run', { rfc: OWN });
    assert.equal(run.json.result.ok, true, 'pieza B1: la consulta concluye');
    const vista = (await h.call('GET', '/api/tributario?rfc=' + OWN)).json;
    const corrida = (vista.runs || [])[0];
    assert.ok(corrida, 'pieza B1: el diario tiene la corrida');
    assert.equal(corrida.hasShot, true,
      'pieza B1: la corrida BUENA del Buzón deja hasShot en su diario (en la 2.9.1 quedaba en false)');
    assert.equal(corrida.hasHtml, true,
      'pieza B1: la corrida BUENA del Buzón deja hasHtml en su diario (en la 2.9.1 quedaba en false)');
    const arteHtml = await h.call('GET',
      '/api/tributario/artifact?run=' + corrida.id + '&part=html');
    assert.equal(arteHtml.status, 200,
      'pieza B1: el artefacto html se sirve por /api/tributario/artifact (en la 2.9.1 era 404)');
    assert.ok(arteHtml.text.includes('Total de notificaciones pendientes: 0'),
      'pieza B1: el HTML servido es la página de la bandeja que la corrida leyó');
    const arteShot = await h.call('GET',
      '/api/tributario/artifact?run=' + corrida.id + '&part=shot');
    assert.equal(arteShot.status, 200, 'pieza B1: el artefacto shot también se sirve');
    assert.equal(arteShot.text.length, PNG_292.length,
      'pieza B1: la captura servida es, byte a byte, la que el motor capturó');
    console.log('OK 2.9.2 · Pieza B1 — Sede local: la corrida buena del Buzón guarda su evidencia y /api/tributario/artifact la sirve (html y captura).');
  } finally { h.service.close(); }
}

/* ================================================================
   PIEZA B2 · Sede ejecutor: el reenvío en buzon-listar y el
   espejo que guarda la evidencia del protocolo
   ================================================================ */
{
  /* El cableado: ejecutarIntento compone el resultado de
     buzon-listar con el reenvío de la evidencia (no es
     importable; se juzga su texto, como en ronda240buzonx). */
  const fuente = readFileSync(join(AQUI, 'ejecutor-local.mjs'), 'utf8');
  const idxBuzon = fuente.indexOf("job.kind === 'buzon-listar'");
  const idxDecl = fuente.indexOf("job.kind === 'declaraciones-recuperar'", idxBuzon);
  const ramaBuzon = fuente.slice(idxBuzon, idxDecl > idxBuzon ? idxDecl : undefined);
  assert.ok(idxBuzon >= 0, 'pieza B2: la rama buzon-listar existe en ejecutor-local');
  assert.ok(ramaBuzon.includes('resultadosDiagDe(result)'),
    'pieza B2: la rama buzon-listar reenvía la evidencia con resultadosDiagDe(result) (en la 2.9.1 no lo hacía)');
  assert.ok(ramaBuzon.includes('salida.resultadosDiag = resultadosDiag'),
    'pieza B2: la evidencia queda adjunta al resultado del trabajo buzon-listar');
  /* La forma del cable es la de siempre (la de declaraciones). */
  const wire = resultadosDiagDe({ resultadosDiag: DIAG_292() });
  assert.deepEqual(wire, { screenshotBase64: PNG_292.toString('base64'),
    html: HTML_BANDEJA_292, url: DIAG_292().url },
    'pieza B2: la evidencia del Buzón viaja con la misma forma que la de declaraciones');

  /* El espejo: lo que llega por el protocolo queda guardado
     como evidencia de la corrida espejo del Buzón. */
  const h = makeHarness({ executorMode: 'remote' });
  try {
    await unlock(h);
    const par = await h.call('POST', '/api/executor/pair', { nombre: 'Equipo de Paco' });
    assert.ok(par.json.token, 'pieza B2: ejecutor emparejado');
    const encolado = await h.call('POST', '/api/tributario/run', { rfc: OWN });
    const jobId = encolado.json?.result?.jobId || encolado.json?.jobId;
    assert.ok(jobId, 'pieza B2: la consulta remota encola su trabajo: ' + encolado.text.slice(0, 200));
    const claim = await h.exec('POST', '/api/executor/claim', { limit: 5 }, par.json.token);
    assert.ok((claim.json.trabajos || []).some(t => t.id === jobId),
      'pieza B2: el ejecutor reclama el trabajo del Buzón');
    const res = await h.exec('POST', '/api/executor/result', { jobId, status: 'done',
      result: { steps: [{ at: Date.now(), paso: 'Lista leída', detalle: '0 en la bandeja' }],
        operations: ['entrar-con-efirma', 'navegar-a-lista', 'leer-lista'],
        accesoOk: true, notifications: [], comunicadosNoLeidos: 0,
        resultadosDiag: { screenshotBase64: PNG_292.toString('base64'),
          html: HTML_BANDEJA_292, url: DIAG_292().url } } }, par.json.token);
    assert.equal(res.json.job.estado, 'hecho', 'pieza B2: el trabajo se da por hecho: ' + res.text.slice(0, 200));
    const vista = (await h.call('GET', '/api/tributario?rfc=' + OWN)).json;
    const corrida = (vista.runs || [])[0];
    assert.ok(corrida, 'pieza B2: el diario tiene la corrida espejo');
    assert.equal(corrida.hasShot, true, 'pieza B2: la corrida espejo guarda la captura');
    assert.equal(corrida.hasHtml, true, 'pieza B2: la corrida espejo guarda el HTML');
    const arte = await h.call('GET', '/api/tributario/artifact?run=' + corrida.id + '&part=html');
    assert.equal(arte.status, 200, 'pieza B2: el artefacto de la corrida espejo se sirve');
    assert.ok(arte.text.includes('Destinatario'), 'pieza B2: y es la página de la bandeja');
    console.log('OK 2.9.2 · Pieza B2 — Sede ejecutor: buzon-listar reenvía resultadosDiag y la corrida espejo guarda la evidencia servida por la ruta.');
  } finally { h.service.close(); }
}

/* ================================================================
   PIEZA A · Comunicados con la estructura del recon
   (réplica con dos orígenes y Chromium real, patrón de
   ronda291parche)
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
assert.ok(CHROME, 'ronda292parche (pieza A) necesita un Chromium local para la réplica: ' +
  'sin navegador la prueba que puede fallar no puede correr.');

let aperturas = 0;
const golpesMarco = {};
const bandejaVacia292 = `<!DOCTYPE html><html><body>
  <p>Destinatario: ${RFC}</p>
  <p>Total de notificaciones pendientes: 0</p>
  <p>No se encontraron resultados</p>
</body></html>`;
/* La bandeja con el gemelo dentro (A2): un elemento con el
   texto exacto «Mis comunicados» FUERA de cualquier tabla —
   no es un mensaje ni una notificación: es el menú de la
   propia app del marco, que no enruta la página principal. */
const bandejaTrampa292 = `<!DOCTYPE html><html><body>
  <p>Destinatario: ${RFC}</p>
  <p>Total de notificaciones pendientes: 0</p>
  <p>No se encontraron resultados</p>
  <nav><span id="gemelo-comunicados">Mis comunicados</span></nav>
</body></html>`;
/* La sección TAL COMO el recon del 16 nov 2026 la vio: los
   grupos con sus conteos y su tabla — los dos sin leer son
   «Registro o actualización de medios de contacto», del
   28/08/2026 y del 07/06/2022 —. Los enlaces de cada fila
   apuntan al contador de aperturas: jamás deben seguirse. */
const marcoComunicadosRecon292 = `<!DOCTYPE html><html><body>
  <h2>Mensajes no leídos (2)</h2>
  <h2>Mensajes leídos (7)</h2>
  <table>
    <thead><tr><th>Fecha</th><th>Asunto</th><th>Estado</th></tr></thead>
    <tbody>
      <tr><td>28/08/2026</td><td><a href="/abrir-mensaje/1">Registro o actualización de medios de contacto</a></td><td>No leído</td></tr>
      <tr><td>07/06/2022</td><td><a href="/abrir-mensaje/2">Registro o actualización de medios de contacto</a></td><td>No leído</td></tr>
      <tr><td>15/10/2026</td><td><a href="/abrir-mensaje/3">Aviso de actualización de datos</a></td><td>Leído</td></tr>
      <tr><td>02/09/2026</td><td><a href="/abrir-mensaje/4">Recordatorio de obligaciones</a></td><td>Leído</td></tr>
      <tr><td>21/05/2026</td><td><a href="/abrir-mensaje/5">Comunicado informativo</a></td><td>Leído</td></tr>
      <tr><td>11/03/2026</td><td><a href="/abrir-mensaje/6">Aviso de medios de contacto</a></td><td>Leído</td></tr>
      <tr><td>30/11/2025</td><td><a href="/abrir-mensaje/7">Comunicado anterior</a></td><td>Leído</td></tr>
      <tr><td>14/07/2025</td><td><a href="/abrir-mensaje/8">Aviso anterior</a></td><td>Leído</td></tr>
      <tr><td>05/02/2025</td><td><a href="/abrir-mensaje/9">Primer comunicado</a></td><td>Leído</td></tr>
    </tbody>
  </table>
</body></html>`;
const marcoGenerico292 = `<!DOCTYPE html><html><body>
  <h1>Portal de trámites y servicios</h1>
  <p>Servicios disponibles para el contribuyente.</p>
</body></html>`;
const serverMarcos = createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  if (path.startsWith('/abrir-mensaje/')) {
    aperturas += 1;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!DOCTYPE html><html><body><h1>Mensaje abierto</h1></body></html>');
    return;
  }
  golpesMarco[path] = (golpesMarco[path] || 0) + 1;
  const servir = (html, ms) => setTimeout(() => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  }, ms);
  if (path === '/bandeja') return servir(bandejaVacia292, 800);
  if (path === '/bandeja-trampa') return servir(bandejaTrampa292, 800);
  if (path === '/comunicados-recon') return servir(marcoComunicadosRecon292, 600);
  if (path === '/comunicados-recon-lento') return servir(marcoComunicadosRecon292, 45_000);
  if (path === '/comunicados-directa') return servir(marcoComunicadosRecon292, 4_000);
  if (path === '/generica') return servir(marcoGenerico292, 300);
  res.writeHead(404); res.end();
});
await new Promise(resolve => serverMarcos.listen(0, '127.0.0.1', resolve));
const ORIGEN2 = 'http://127.0.0.1:' + serverMarcos.address().port;

const paginaAcceso292 = (fiel) => `<!DOCTYPE html><html><body>
  <h1>Acceso por contraseña</h1>
  <a id="buttonFiel" href="${fiel}">Acceso con e.firma</a>
</body></html>`;
const formularioLogin292 = (destino) => `<!DOCTYPE html><html><body>
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
/* La cabecera que despliega (el mapa vivo): el botón abre el
   menú; «Mis notificaciones» la enruta su JS; «Mis
   comunicados» es el ancla plana de la cáscara real. */
const cabeceraOk292 = (destinoNotificaciones, hrefComunicados) => `
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
/* La cabecera que NO despliega (A2): sobre la página de la
   bandeja el botón no tiene manejador y el menú queda
   cerrado — los enlaces existen en el DOM pero no son
   visibles, así que el clic exacto y visible cae en el
   gemelo del marco. */
const cabeceraSorda292 = (hrefComunicados) => `
  <header>
    <span>BUZÓN TRIBUTARIO</span>
    <button id="btn-expedientes" type="button">Mis expedientes</button>
    <nav id="menu-expedientes" style="display:none">
      <a href="#" data-nav="documentos">Mis documentos</a>
      <a href="#" data-nav="notificaciones">Mis notificaciones</a>
      <a href="${hrefComunicados}">Mis comunicados</a>
    </nav>
    <a href="#" data-nav="salir">Cerrar sesión</a>
  </header>`;
const paginaBuzon292 = (destinoNotificaciones, hrefComunicados) =>
  `<!DOCTYPE html><html><body>${cabeceraOk292(destinoNotificaciones, hrefComunicados)}<main></main></body></html>`;
const cascara292 = (cabecera, marco) =>
  `<!DOCTYPE html><html><body>${cabecera}
  <main><iframe id="iframetoload" src="${marco}"></iframe></main>
</body></html>`;

const R = (x, que) => '/iniciar-expediente/mis-' + que + '-' + x + '/';
const serverPortal = createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  const rutas = {
    /* A2 · el clic cae en el gemelo; la reserva llega. */
    '/acceso-a2': paginaAcceso292('/acceso-fiel-a2'),
    '/acceso-fiel-a2': formularioLogin292('/buzon-a2'),
    '/buzon-a2': paginaBuzon292(R('a2', 'notificaciones'), R('a2', 'comunicados')),
    [R('a2', 'notificaciones')]: cascara292(cabeceraSorda292(R('a2', 'comunicados')), ORIGEN2 + '/bandeja-trampa'),
    [R('a2', 'comunicados')]: cascara292(cabeceraOk292(R('a2', 'notificaciones'), R('a2', 'comunicados')), ORIGEN2 + '/comunicados-directa'),
    /* A3 · ninguna vía enseña la sección: no concluyente. */
    '/acceso-a3': paginaAcceso292('/acceso-fiel-a3'),
    '/acceso-fiel-a3': formularioLogin292('/buzon-a3'),
    '/buzon-a3': paginaBuzon292(R('a3', 'notificaciones'), R('a3', 'comunicados')),
    [R('a3', 'notificaciones')]: cascara292(cabeceraOk292(R('a3', 'notificaciones'), R('a3', 'comunicados')), ORIGEN2 + '/bandeja'),
    [R('a3', 'comunicados')]: cascara292(cabeceraOk292(R('a3', 'notificaciones'), R('a3', 'comunicados')), ORIGEN2 + '/generica'),
    /* A1 · el marco tarda 45 s con plazo de 40 s por vía. */
    '/acceso-a1': paginaAcceso292('/acceso-fiel-a1'),
    '/acceso-fiel-a1': formularioLogin292('/buzon-a1'),
    '/buzon-a1': paginaBuzon292(R('a1', 'notificaciones'), R('a1', 'comunicados')),
    [R('a1', 'notificaciones')]: cascara292(cabeceraOk292(R('a1', 'notificaciones'), R('a1', 'comunicados')), ORIGEN2 + '/bandeja'),
    [R('a1', 'comunicados')]: cascara292(cabeceraOk292(R('a1', 'notificaciones'), R('a1', 'comunicados')), ORIGEN2 + '/comunicados-recon-lento')
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
const tribPara292 = (x, esperaBandejaMs) => createSatTribFetch({ resolveCredentials: resolverReal,
  launchDriver: createPlaywrightDriverFactory({ executablePath: CHROME, headless: true }),
  entryUrl: ORIGEN1 + R(x, 'notificaciones'), loginUrl: ORIGEN1 + '/acceso-' + x,
  comunicadosUrl: ORIGEN1 + R(x, 'comunicados'), esperaBandejaMs });
const correr292 = async (trib) => {
  const pasos = [];
  const aperturasAntes = aperturas;
  const salida = await trib({ rfc: RFC }, {},
    { onStep: (paso, detalle) => pasos.push({ paso, detalle }) })
    .then(resultado => ({ resultado }), error => ({ error }));
  return { ...salida, pasos, aperturas: aperturas - aperturasAntes };
};

/* ===== A2 · El clic cae en el gemelo; la reserva llega ===== */
{
  const caso = await correr292(tribPara292('a2', 6_000));
  assert.ok(caso.resultado, 'pieza A2: la corrida concluye: ' +
    (caso.error ? caso.error.code + ' — ' + caso.error.message : 'sin error'));
  assert.deepEqual(caso.resultado.notifications, [], 'pieza A2: la bandeja vacía se lee');
  assert.ok(caso.pasos.some(p => p.paso.includes('«Mis expedientes» → «Mis comunicados»')),
    'pieza A2: el paso del camino humano salió (el clic cayó en el gemelo), como en ae67cdfa');
  assert.equal(caso.resultado.comunicados?.concluyente, true,
    'pieza A2: la reserva directa, con su plazo fresco, concluye la sección');
  assert.equal(caso.resultado.comunicadosNoLeidos, 2, 'pieza A2: 2 sin leer, los del recon');
  assert.equal(caso.resultado.comunicados?.leidos, 7, 'pieza A2: 7 leídos, los del recon');
  assert.equal(caso.resultado.comunicados?.items?.length, 9,
    'pieza A2: la tabla del recon se lista entera (9 filas) sin abrir ninguna');
  assert.equal(caso.aperturas, 0, 'pieza A2: cero aperturas');
  console.log('OK 2.9.2 · Pieza A2 — Comunicados: el clic cae en el gemelo del marco y la reserva directa, con plazo fresco, lee los conteos del recon (2 sin leer · 7 leídos).');
}

/* ===== A3 · Sin conteos ni tabla por ninguna vía: no consta ===== */
{
  const caso = await correr292(tribPara292('a3', 6_000));
  assert.ok(caso.resultado, 'pieza A3: la corrida concluye: ' +
    (caso.error ? caso.error.code + ' — ' + caso.error.message : 'sin error'));
  assert.equal(caso.resultado.comunicados?.concluyente, false,
    'pieza A3: sin conteos ni tabla en ninguna vía, la sección sale no concluyente');
  assert.equal(caso.resultado.comunicadosNoLeidos, null,
    'pieza A3: el conteo viaja null — jamás un cero fingido');
  assert.ok(String(caso.resultado.comunicados?.motivo || '').includes('no consta su contenido'),
    'pieza A3: el motivo dice que no consta: ' + caso.resultado.comunicados?.motivo);
  assert.equal(caso.aperturas, 0, 'pieza A3: cero aperturas');
  console.log('OK 2.9.2 · Pieza A3 — Comunicados: la honestidad queda intacta — sin evidencia en el portal, no concluyente con su motivo.');
}

/* ===== A1 · El marco tarda más que un plazo: dos plazos ===== */
{
  const golpesAntes = golpesMarco['/comunicados-recon-lento'] || 0;
  const caso = await correr292(tribPara292('a1', 40_000));
  assert.ok(caso.resultado, 'pieza A1: la corrida concluye: ' +
    (caso.error ? caso.error.code + ' — ' + caso.error.message : 'sin error'));
  assert.equal(caso.resultado.comunicados?.concluyente, true,
    'pieza A1: la sección concluye con dos plazos — el del camino humano y el fresco de la reserva');
  assert.equal(caso.resultado.comunicadosNoLeidos, 2, 'pieza A1: 2 sin leer, los del recon');
  assert.equal(caso.resultado.comunicados?.leidos, 7, 'pieza A1: 7 leídos, los del recon');
  assert.ok(caso.pasos.some(p => p.paso === 'Esperando «Mis comunicados»…'),
    'pieza A1: la espera de la sección avisa de su progreso en el diario');
  assert.equal((golpesMarco['/comunicados-recon-lento'] || 0) - golpesAntes, 1,
    'pieza A1: el marco se pidió UNA sola vez — la reserva no recargó la cáscara que ya lo estaba cargando');
  /* La evidencia del motor (pieza B, su eslabón del motor):
     la misma corrida trae la página de la bandeja. */
  assert.ok(caso.resultado.resultadosDiag,
    'pieza B (motor): la corrida del Buzón trae su evidencia de resultados');
  assert.ok(String(caso.resultado.resultadosDiag.html || '').includes('Destinatario'),
    'pieza B (motor): el HTML de la evidencia es la página de la bandeja leída');
  assert.ok(Buffer.isBuffer(caso.resultado.resultadosDiag.screenshot) &&
    caso.resultado.resultadosDiag.screenshot.length > 0,
    'pieza B (motor): la evidencia trae su captura');
  assert.equal(caso.aperturas, 0, 'pieza A1: cero aperturas');
  console.log('OK 2.9.2 · Pieza A1 — Comunicados: el marco de 45 s concluye con el plazo fresco de la reserva, sin recargar la cáscara; y la corrida trae la evidencia de la bandeja (pieza B, motor).');
}

serverPortal.close();
serverMarcos.close();

/* ================================================================
   Estáticas de la ronda
   ================================================================ */
{
  const pkg = JSON.parse(readFileSync(join(AQUI, 'package.json'), 'utf8'));
  assert.equal(pkg.version, '2.9.16', 'la ronda es la 2.9.2');
  assert.ok(pkg.scripts.test.includes('ronda292parche.test.mjs'),
    'la suite está registrada en la batería');
  assert.equal(EJECUTOR_VERSION, '2.9.16', 'el sello del ejecutor acompaña a la versión');
  console.log('OK 2.9.2 · Estáticas — versión 2.9.2, suite en la batería y sello del ejecutor.');
}

console.log('OK suite ronda292parche completa');
