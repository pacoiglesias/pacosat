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
import { createSatTribFetch, parseComunicadosReales, extractDocumentosReales } from './sat-tributario.mjs';
import { sanitizeBuzonSecciones240 } from './sat-executor.mjs';
import { EJECUTOR_VERSION } from './ejecutor-local.mjs';

/* ================================================================
   Ronda 2.9.4 — el lector de «Mis comunicados» y «Mis
   documentos» construido DESDE LA PÁGINA REAL capturada en
   producción (la evidencia por sección de la 2.9.3, corrida
   34e7b45b: la corrida cerró ok y guardó la página de cada
   sección; fixtures en fixtures/, byte a byte los de la
   evidencia):

   DIAGNÓSTICO (probado con esa evidencia): el contenido de
   AMBAS secciones SÍ llega en el paseo desde el NAS; el
   lector no lo reconoce porque espera los marcadores de la
   BANDEJA (conteos «Mensajes no leídos (n)» y una tabla de
   fecha/asunto/estado):
   - Comunicados vive en un marco de OTRO host
     (aplicacionesc.mat.sat.gob.mx/WebComunicados/
     Comunicados.aspx): NO hay línea de conteo — hay dos
     secciones con encabezado «Mensajes no leídos» y
     «Mensajes leídos» (sin «(n)») y cada mensaje es una fila
     <tr id="msgN"> cuyo texto visible es «DD/mmm/AAAA
     HH:MM hrs <asunto> <folio>», con su fila de detalle
     oculta (detalleMsgN). El onclick de la fila invoca
     VerMsg + ComunicadoVisualizado: JAMÁS se pulsa ni se
     invoca — abrir un comunicado está prohibido.
   - Documentos vive en tramitesdigitales.sat.gob.mx
     (…/FormularioGenerico/TablaDatosFormularioGenerico
     .aspx): una página DataTables cuyas tablas son
     #tablaRespons, #tablaRespons2015, #tablaResponsIMSS,
     #tablaResponsEF y #tablaResponsLC. EN LA CAPTURA REAL
     las tablas aún NO están renderizadas (la celda de
     contenido viene vacía; solo constan la página, sus
     pestañas y el script que nombra las cinco tablas):
     ese estado NO es un cero — es «sin listar» honesto.

   LA VERDAD DEL FIXTURE DE COMUNICADOS (contada del propio
   fixture): 2 no leídos — 28/ago/2026 12:20 y 07/jun/2022
   10:20, ambos «Registro o actualización de medios de
   contacto», folios MFI6212158B40004 y MFI6212158B40003 —
   y 7 leídos (msg3…msg9). Coincide con el recon de campo
   del 16 nov 2026 (2 sin leer, 7 leídos).

   PIEZAS:
   P1 · El parser puro de comunicados reales lee el fixture:
        9 mensajes con su fecha, asunto, folio y sección.
   P2 · El extractor puro de documentos reales: tablas con
        filas → la lista; tablas con su marca de vacío → un
        cero concluyente; sin tablas → null (no consta).
   P3 · El validador del ejecutor conserva el folio de cada
        comunicado (su lista blanca era fecha/asunto/leido:
        una fila con folio se rechazaba entera).
   C1 · Motor con Chromium real y el MARCO REAL de
        comunicados servido desde otro origen: la sección
        concluye con 2 sin leer y 7 leídos y la lista de 9,
        con CERO invocaciones a VerMsg/ComunicadoVisualizado
        (el servidor de marcos sirve un mensajes.js trampa
        que cuenta cualquier invocación) y cero aperturas.
        Contra la 2.9.3: la misma corrida sale no
        concluyente («sin conteo legible») — rojo.
   D1 · Motor con el MARCO REAL de documentos: la página
        llega pero sus tablas no están renderizadas → la
        sección sale NO concluyente («sin listar»), jamás
        un cero fingido. Cero aperturas.
   D2 · Motor con el marco real y sus cinco tablas
        renderizadas (reconstrucción desde la página real,
        fixtures/buzon-documentos-tablas.html): la sección
        concluye con las filas de las tablas con datos y
        el cero de las vacías. Cero aperturas.
   M1 · Los marcos mudos de la 2.9.3 («Cargando…» eterno):
        las dos secciones agotan su plazo, no concluyen y
        la evidencia por sección sigue viajando — la
        honestidad y la pieza E no se mueven.
   S1 · Sede local: la corrida que trae las secciones
        nuevas las guarda y la vista las expone enteras
        (buzonCompleto240 con los folios).

   REGLA LEGAL DURA, intacta: JAMÁS se abre una notificación
   ni un comunicado — los contadores de aperturas e
   invocaciones deben quedar a cero en todos los escenarios.
   ================================================================ */

const AQUI = dirname(fileURLToPath(import.meta.url));
const RFC = 'MFI6212158B4';
const ORIGIN = 'https://pacosat.test';
const KEY = 'b'.repeat(64);
const OWN = 'AAA010101AAA';

/* ================================================================
   Los fixtures reales y sus marcos
   ================================================================ */
const marcoDe = nombre => {
  const compuesto = readFileSync(join(AQUI, 'fixtures', nombre), 'utf8');
  const corte = compuesto.indexOf('<!-- ===== MARCO');
  assert.ok(corte >= 0, 'el fixture ' + nombre + ' trae su marcador de marco');
  return compuesto.slice(compuesto.indexOf('===== -->', corte) + '===== -->'.length);
};
const MARCO_COM_REAL = marcoDe('buzon-comunicados-real.html');
const MARCO_DOC_REAL = marcoDe('buzon-documentos-real.html');
const MARCO_DOC_TABLAS = readFileSync(join(AQUI, 'fixtures', 'buzon-documentos-tablas.html'), 'utf8');
/* La hoja de fuentes de Google no forma parte de la
   estructura que el lector juzga y la réplica no debe
   depender de la red: en la COPIA SERVIDA (el fixture en
   disco queda intacto) se sustituye por una hoja local. */
const servirLocal = html => html.replace(/https:\/\/fonts\.googleapis\.com[^"]*/g, '/vacio.css');

/* Las filas { seccion, texto } que el lector de DOM produce
   sobre el fixture, derivadas aquí del propio HTML para la
   pieza pura: el texto visible de cada <tr id="msgN"> sin su
   onclick (que trae el texto del detalle) y su sección por
   la posición respecto al <div id="faqs2"> (los leídos). */
function filasDelFixtureComunicados() {
  const corte = MARCO_COM_REAL.indexOf('<div id="faqs2">');
  assert.ok(corte > 0, 'el fixture trae el div de leídos (faqs2)');
  const filas = [];
  const re = /<tr style="cursor: hand" id="msg(\d+)"/g;
  let m;
  while ((m = re.exec(MARCO_COM_REAL))) {
    const desde = m.index;
    const posDetalle = MARCO_COM_REAL.indexOf('id="detalleMsg' + m[1] + '"', desde);
    const hasta = posDetalle > desde ? MARCO_COM_REAL.lastIndexOf('<tr', posDetalle) : -1;
    let tramo = MARCO_COM_REAL.slice(desde, hasta > desde ? hasta : desde + 4000);
    tramo = tramo.replace(/onclick="[^"]*"/g, '');
    const texto = tramo.replace(/<[^>]+>/g, ' ')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ').trim();
    filas.push({ seccion: desde < corte ? 'no-leidos' : 'leidos', texto });
  }
  return filas;
}

/* ================================================================
   P1 · El parser puro lee el fixture real de comunicados
   ================================================================ */
{
  const filas = filasDelFixtureComunicados();
  assert.equal(filas.length, 9, 'P1: el fixture trae 9 filas msgN: ' + filas.length);
  const leido = parseComunicadosReales([filas]);
  assert.ok(leido, 'P1: el parser reconoce las filas reales (en la 2.9.3 no existía)');
  assert.equal(leido.items.length, 9, 'P1: 9 mensajes listados');
  assert.equal(leido.noLeidos, 2, 'P1: 2 no leídos, los del fixture');
  assert.equal(leido.leidos, 7, 'P1: 7 leídos, los del fixture');
  assert.deepEqual(leido.items[0], { fecha: '2026-08-28 12:20',
    asunto: 'Registro o actualización de medios de contacto',
    folio: 'MFI6212158B40004', leido: false },
    'P1: el primer no leído, con su fecha, asunto y folio del fixture');
  assert.deepEqual(leido.items[1], { fecha: '2022-06-07 10:20',
    asunto: 'Registro o actualización de medios de contacto',
    folio: 'MFI6212158B40003', leido: false },
    'P1: el segundo no leído, el del 07/jun/2022');
  assert.deepEqual(leido.items[2], { fecha: '2026-08-28 12:22',
    asunto: 'Respuesta al registro o actualización de medios de contacto',
    folio: 'MFI6212158B40004', leido: true },
    'P1: el primer leído queda en su sección');
  assert.deepEqual(leido.items[8], { fecha: '2018-10-15 18:45',
    asunto: 'Registro o actualización de medios de contacto',
    folio: 'MFI6212158B40001', leido: true },
    'P1: el último leído, el del 15/oct/2018');
  assert.equal(parseComunicadosReales([[]]), null, 'P1: sin filas no hay lectura');
  assert.equal(parseComunicadosReales([[{ seccion: '', texto: filas[0].texto }]]), null,
    'P1: una fila sin sección no se clasifica — no se inventa su estado');
  console.log('OK 2.9.4 · P1 — El parser de comunicados reales lee el fixture: 2 no leídos (28/ago/2026 y 07/jun/2022, folios …0004 y …0003) y 7 leídos, con fecha, asunto y folio por mensaje.');
}

/* ================================================================
   P2 · El extractor puro de documentos reales
   ================================================================ */
{
  const tabla = (id, headers, rows, vacia = false) => ({ id, headers, rows, vacia });
  const conTablas = [{ tablas: [
    tabla('tablaRespons', ['Fecha', 'Descripción', 'Referencia', 'Estado'], [
      ['15/01/2026', 'Documento de prueba 294-A', 'REF-294-001', 'Vigente'],
      ['20/03/2026', 'Documento de prueba 294-B', 'REF-294-002', 'Concluido']]),
    tabla('tablaRespons2015', ['Fecha', 'Descripción', 'Referencia', 'Estado'], [], true),
    tabla('tablaResponsIMSS', ['Fecha', 'Descripción', 'Referencia', 'Estado'], [], true),
    tabla('tablaResponsEF', ['Fecha', 'Descripción', 'Referencia', 'Estado'], [], true),
    tabla('tablaResponsLC', ['Fecha', 'Concepto', 'Línea de captura', 'Estado'], [
      ['02/04/2026', 'Línea de prueba 294', 'LC2940001', 'Pendiente']])] }];
  const leido = extractDocumentosReales(conTablas);
  assert.ok(leido && leido.concluyente === true,
    'P2: con las tablas presentes la sección es concluyente (en la 2.9.3 no existía este lector)');
  assert.deepEqual(leido.items, [
    { fecha: '2026-01-15', nombre: 'Documento de prueba 294-A', estado: 'Vigente' },
    { fecha: '2026-03-20', nombre: 'Documento de prueba 294-B', estado: 'Concluido' },
    { fecha: '2026-04-02', nombre: 'Línea de prueba 294', estado: 'Pendiente' }],
    'P2: las filas salen de las tablas con datos, mapeadas por sus encabezados');
  const vacias = extractDocumentosReales([{ tablas: [
    tabla('tablaRespons', ['Fecha', 'Descripción', 'Referencia', 'Estado'], [], true),
    tabla('tablaResponsLC', ['Fecha', 'Concepto', 'Línea de captura', 'Estado'], [], true)] }]);
  assert.deepEqual(vacias, { concluyente: true, items: [] },
    'P2: tablas presentes con su marca de vacío = un cero concluyente, no un «sin listar»');
  assert.equal(extractDocumentosReales([null]), null,
    'P2: sin ninguna de las cinco tablas no hay lectura — no consta');
  assert.equal(extractDocumentosReales([]), null, 'P2: sin marcos no hay lectura');
  console.log('OK 2.9.4 · P2 — El extractor de documentos reales: filas de las tablas con datos, cero concluyente con la marca de vacío y null sin tablas.');
}

/* ================================================================
   P3 · El folio viaja por el protocolo del ejecutor
   ================================================================ */
{
  const secciones = sanitizeBuzonSecciones240({ comunicados: {
    concluyente: true, soloConteos: false, noLeidos: 2, leidos: 7,
    items: [{ fecha: '2026-08-28 12:20', asunto: 'Registro o actualización de medios de contacto',
      folio: 'MFI6212158B40004', leido: false }] } });
  assert.equal(secciones.comunicados?.items?.length, 1,
    'P3: la fila con folio SOBREVIVE al validador (en la 2.9.3 la clave rara la rechazaba entera)');
  assert.equal(secciones.comunicados.items[0].folio, 'MFI6212158B40004',
    'P3: y el folio llega entero');
  console.log('OK 2.9.4 · P3 — El validador del ejecutor conserva el folio de cada comunicado.');
}

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
      request: async () => 'req-294', check: async () => ({ status: 'pending', packages: [] }),
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
  return { service, call, clock, mails };
}
const unlock = async (h, rfc = OWN) => {
  const open = await h.call('POST', '/api/unlock', { rfc, minutes: 1440, days: 7,
    direction: 'both', password: 'simulated', certificate: 'YQ==', key: 'Yg==' });
  assert.equal(open.status, 200, 'unlock de ' + rfc);
};

/* ================================================================
   S1 · Sede local: las secciones nuevas se guardan y la
   vista las expone enteras
   ================================================================ */
{
  const satTribFetch = async () => ({ notifications: [], comunicadosNoLeidos: 2,
    comunicados: { concluyente: true, soloConteos: false, noLeidos: 2, leidos: 7,
      items: [
        { fecha: '2026-08-28 12:20', asunto: 'Registro o actualización de medios de contacto',
          folio: 'MFI6212158B40004', leido: false },
        { fecha: '2022-06-07 10:20', asunto: 'Registro o actualización de medios de contacto',
          folio: 'MFI6212158B40003', leido: false }] },
    documentos: { concluyente: true, items: [
      { fecha: '2026-01-15', nombre: 'Documento de prueba 294-A', estado: 'Vigente' }] } });
  const h = makeHarness({ executorMode: 'nas', satTribFetch });
  try {
    await unlock(h);
    const run = await h.call('POST', '/api/tributario/run', { rfc: OWN });
    assert.equal(run.json.result.ok, true, 'S1: la consulta concluye');
    const vista = (await h.call('GET', '/api/tributario?rfc=' + OWN)).json;
    assert.equal(vista.comunicadosNoLeidos, 2, 'S1: el conteo de comunicados sin leer queda guardado');
    const com = vista.buzonCompleto240?.comunicados;
    assert.ok(com?.concluyente, 'S1: la vista expone la sección de comunicados concluyente');
    assert.equal(com.items?.length, 2, 'S1: con su lista');
    assert.equal(com.items[0].folio, 'MFI6212158B40004',
      'S1: y el folio del primer comunicado llega a la vista — el panel lo enseña con su asunto y fecha');
    assert.equal(com.items[0].leido, false, 'S1: marcado sin leer, como consta en el portal');
    const doc = vista.buzonCompleto240?.documentos;
    assert.deepEqual(doc?.items, [{ fecha: '2026-01-15', nombre: 'Documento de prueba 294-A', estado: 'Vigente' }],
      'S1: la sección de documentos viaja igual de entera');
    console.log('OK 2.9.4 · S1 — Sede local: las secciones nuevas se guardan y buzonCompleto240 las expone con lista y folios.');
  } finally { h.service.close(); }
}

/* ================================================================
   Motor con Chromium real (patrón de ronda292/293parche)
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
assert.ok(CHROME, 'ronda294buzon necesita un Chromium local para la réplica: ' +
  'sin navegador la prueba que puede fallar no puede correr.');

let aperturas = 0;
let invocaciones = 0;
const bandejaVacia294 = `<!DOCTYPE html><html><body>
  <p>Destinatario: ${RFC}</p>
  <p>Total de notificaciones pendientes: 0</p>
  <p>No se encontraron resultados</p>
</body></html>`;
const marcoComunicadosMudo294 = `<!DOCTYPE html><html><body>
  <p>Cargando comunicados… un momento, por favor.</p>
</body></html>`;
const marcoDocumentosMudo294 = `<!DOCTYPE html><html><body>
  <p>Cargando documentos… un momento, por favor.</p>
</body></html>`;
/* El mensajes.js TRAMPA: en la página real ese archivo
   define VerMsg y ComunicadoVisualizado (las dos funciones
   que el onclick de cada fila msgN invoca para ABRIR el
   mensaje). Aquí las define contando: si el lector — o
   cualquier clic — las invocara, el contador se mueve y la
   suite lo caza. */
const MENSAJES_TRAMPA294 = `
  window.VerMsg = function () { try { navigator.sendBeacon('/invocacion'); } catch (e) {} };
  window.ComunicadoVisualizado = function () { try { navigator.sendBeacon('/invocacion'); } catch (e) {} };
  window.MouseOver = function () {}; window.MouseOut = function () {};`;
const serverMarcos = createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  if (path.startsWith('/abrir-mensaje/') || path.startsWith('/abrir-documento/')) {
    aperturas += 1;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!DOCTYPE html><html><body><h1>Abierto</h1></body></html>');
    return;
  }
  if (path === '/invocacion') { invocaciones += 1; res.writeHead(204); res.end(); return; }
  const servir = (html, ms, tipo = 'text/html; charset=utf-8') => setTimeout(() => {
    res.writeHead(200, { 'content-type': tipo });
    res.end(html);
  }, ms);
  if (path === '/bandeja') return servir(bandejaVacia294, 800);
  if (path === '/comunicados-real') return servir(servirLocal(MARCO_COM_REAL), 600);
  if (path === '/documentos-real') return servir(servirLocal(MARCO_DOC_REAL), 600);
  if (path === '/documentos-tablas') return servir(servirLocal(MARCO_DOC_TABLAS), 600);
  if (path === '/comunicados-mudo') return servir(marcoComunicadosMudo294, 600);
  if (path === '/documentos-mudo') return servir(marcoDocumentosMudo294, 600);
  if (path === '/scripts/mensajes.js') return servir(MENSAJES_TRAMPA294, 0, 'text/javascript');
  if (path.endsWith('.js') || path.includes('.axd')) return servir('', 0, 'text/javascript');
  if (path.endsWith('.css') || path === '/vacio.css') return servir('', 0, 'text/css');
  res.writeHead(404); res.end();
});
await new Promise(resolve => serverMarcos.listen(0, '127.0.0.1', resolve));
const ORIGEN2 = 'http://127.0.0.1:' + serverMarcos.address().port;

const paginaAcceso294 = (fiel) => `<!DOCTYPE html><html><body>
  <h1>Acceso por contraseña</h1>
  <a id="buttonFiel" href="${fiel}">Acceso con e.firma</a>
</body></html>`;
const formularioLogin294 = (destino) => `<!DOCTYPE html><html><body>
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
const cabeceraOk294 = (destinoNotificaciones, hrefComunicados) => `
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
const paginaBuzon294 = (destinoNotificaciones, hrefComunicados) =>
  `<!DOCTYPE html><html><body>${cabeceraOk294(destinoNotificaciones, hrefComunicados)}<main></main></body></html>`;
const cascara294 = (cabecera, marco) =>
  `<!DOCTYPE html><html><body>${cabecera}
  <main><iframe id="iframetoload" src="${marco}"></iframe></main>
</body></html>`;

const R = (x, que) => '/iniciar-expediente/mis-' + que + '-' + x + '/';
const serverPortal = createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  const rutas = {
    /* C1 · comunicados con su marco REAL; documentos mudo. */
    '/acceso-c1': paginaAcceso294('/acceso-fiel-c1'),
    '/acceso-fiel-c1': formularioLogin294('/buzon-c1'),
    '/buzon-c1': paginaBuzon294(R('c1', 'notificaciones'), R('c1', 'comunicados')),
    [R('c1', 'notificaciones')]: cascara294(cabeceraOk294(R('c1', 'notificaciones'), R('c1', 'comunicados')), ORIGEN2 + '/bandeja'),
    [R('c1', 'comunicados')]: cascara294(cabeceraOk294(R('c1', 'notificaciones'), R('c1', 'comunicados')), ORIGEN2 + '/comunicados-real'),
    [R('c1', 'documentos')]: cascara294(cabeceraOk294(R('c1', 'notificaciones'), R('c1', 'comunicados')), ORIGEN2 + '/documentos-mudo'),
    /* D1 · documentos con su marco REAL (tablas sin renderizar). */
    '/acceso-d1': paginaAcceso294('/acceso-fiel-d1'),
    '/acceso-fiel-d1': formularioLogin294('/buzon-d1'),
    '/buzon-d1': paginaBuzon294(R('d1', 'notificaciones'), R('d1', 'comunicados')),
    [R('d1', 'notificaciones')]: cascara294(cabeceraOk294(R('d1', 'notificaciones'), R('d1', 'comunicados')), ORIGEN2 + '/bandeja'),
    [R('d1', 'comunicados')]: cascara294(cabeceraOk294(R('d1', 'notificaciones'), R('d1', 'comunicados')), ORIGEN2 + '/comunicados-real'),
    [R('d1', 'documentos')]: cascara294(cabeceraOk294(R('d1', 'notificaciones'), R('d1', 'comunicados')), ORIGEN2 + '/documentos-real'),
    /* D2 · documentos con las cinco tablas renderizadas. */
    '/acceso-d2': paginaAcceso294('/acceso-fiel-d2'),
    '/acceso-fiel-d2': formularioLogin294('/buzon-d2'),
    '/buzon-d2': paginaBuzon294(R('d2', 'notificaciones'), R('d2', 'comunicados')),
    [R('d2', 'notificaciones')]: cascara294(cabeceraOk294(R('d2', 'notificaciones'), R('d2', 'comunicados')), ORIGEN2 + '/bandeja'),
    [R('d2', 'comunicados')]: cascara294(cabeceraOk294(R('d2', 'notificaciones'), R('d2', 'comunicados')), ORIGEN2 + '/comunicados-real'),
    [R('d2', 'documentos')]: cascara294(cabeceraOk294(R('d2', 'notificaciones'), R('d2', 'comunicados')), ORIGEN2 + '/documentos-tablas'),
    /* M1 · los dos marcos mudos de la 2.9.3. */
    '/acceso-m1': paginaAcceso294('/acceso-fiel-m1'),
    '/acceso-fiel-m1': formularioLogin294('/buzon-m1'),
    '/buzon-m1': paginaBuzon294(R('m1', 'notificaciones'), R('m1', 'comunicados')),
    [R('m1', 'notificaciones')]: cascara294(cabeceraOk294(R('m1', 'notificaciones'), R('m1', 'comunicados')), ORIGEN2 + '/bandeja'),
    [R('m1', 'comunicados')]: cascara294(cabeceraOk294(R('m1', 'notificaciones'), R('m1', 'comunicados')), ORIGEN2 + '/comunicados-mudo'),
    [R('m1', 'documentos')]: cascara294(cabeceraOk294(R('m1', 'notificaciones'), R('m1', 'comunicados')), ORIGEN2 + '/documentos-mudo')
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
const tribPara294 = (x, esperaBandejaMs = 6_000) => createSatTribFetch({ resolveCredentials: resolverReal,
  launchDriver: createPlaywrightDriverFactory({ executablePath: CHROME, headless: true }),
  entryUrl: ORIGEN1 + R(x, 'notificaciones'), loginUrl: ORIGEN1 + '/acceso-' + x,
  comunicadosUrl: ORIGEN1 + R(x, 'comunicados'),
  documentosUrl: ORIGEN1 + R(x, 'documentos'), esperaBandejaMs });
const correr294 = async (trib) => {
  const pasos = [];
  const aperturasAntes = aperturas;
  const invocacionesAntes = invocaciones;
  const salida = await trib({ rfc: RFC }, {},
    { onStep: (paso, detalle) => pasos.push({ paso, detalle }) })
    .then(resultado => ({ resultado }), error => ({ error }));
  return { ...salida, pasos,
    aperturas: aperturas - aperturasAntes, invocaciones: invocaciones - invocacionesAntes };
};

/* ===== C1 · Comunicados con su marco REAL ===== */
{
  const caso = await correr294(tribPara294('c1'));
  assert.ok(caso.resultado, 'C1: la corrida concluye: ' +
    (caso.error ? caso.error.code + ' — ' + caso.error.message : 'sin error'));
  assert.deepEqual(caso.resultado.notifications, [], 'C1: la bandeja vacía se lee');
  const com = caso.resultado.comunicados;
  assert.equal(com?.concluyente, true,
    'C1: la sección de comunicados CONCLUYE con su marco real (en la 2.9.3 salía «sin conteo legible»)');
  assert.equal(caso.resultado.comunicadosNoLeidos, 2, 'C1: 2 sin leer, los del portal real');
  assert.equal(com.leidos, 7, 'C1: 7 leídos, los del portal real');
  assert.equal(com.items?.length, 9, 'C1: la lista entera, 9 mensajes, sin abrir ninguno');
  assert.deepEqual(com.items[0], { fecha: '2026-08-28 12:20',
    asunto: 'Registro o actualización de medios de contacto',
    folio: 'MFI6212158B40004', leido: false }, 'C1: el primer mensaje, tal como el portal lo lista');
  assert.deepEqual(com.items[1], { fecha: '2022-06-07 10:20',
    asunto: 'Registro o actualización de medios de contacto',
    folio: 'MFI6212158B40003', leido: false }, 'C1: el segundo sin leer, el del 07/jun/2022');
  assert.equal(caso.invocaciones, 0,
    'C1: CERO invocaciones a VerMsg/ComunicadoVisualizado — ningún comunicado se abrió');
  assert.equal(caso.aperturas, 0, 'C1: cero aperturas');
  console.log('OK 2.9.4 · C1 — Comunicados: su marco real concluye con 2 sin leer y 7 leídos, la lista de 9 con fecha, asunto y folio, y cero invocaciones de apertura.');
}

/* ===== D1 · Documentos con su marco REAL: sin listar honesto ===== */
{
  const caso = await correr294(tribPara294('d1'));
  assert.ok(caso.resultado, 'D1: la corrida concluye: ' +
    (caso.error ? caso.error.code + ' — ' + caso.error.message : 'sin error'));
  assert.equal(caso.resultado.comunicados?.concluyente, true,
    'D1: comunicados concluye también en esta corrida');
  const doc = caso.resultado.documentos;
  assert.equal(doc?.concluyente, false,
    'D1: el marco real llega SIN las tablas renderizadas — la sección NO concluye: no es un cero');
  assert.ok(String(doc?.motivo || '').length > 10,
    'D1: y lo dice con su motivo: ' + doc?.motivo);
  assert.equal(caso.aperturas, 0, 'D1: cero aperturas');
  console.log('OK 2.9.4 · D1 — Documentos: su marco real sin tablas renderizadas sale «sin listar» con su motivo — jamás un cero fingido.');
}

/* ===== D2 · Documentos con las tablas renderizadas ===== */
{
  const caso = await correr294(tribPara294('d2'));
  assert.ok(caso.resultado, 'D2: la corrida concluye: ' +
    (caso.error ? caso.error.code + ' — ' + caso.error.message : 'sin error'));
  const doc = caso.resultado.documentos;
  assert.equal(doc?.concluyente, true,
    'D2: con las cinco tablas presentes la sección concluye');
  assert.deepEqual(doc.items, [
    { fecha: '2026-01-15', nombre: 'Documento de prueba 294-A', estado: 'Vigente' },
    { fecha: '2026-03-20', nombre: 'Documento de prueba 294-B', estado: 'Concluido' },
    { fecha: '2026-04-02', nombre: 'Línea de prueba 294', estado: 'Pendiente' }],
    'D2: la lista sale de las tablas con datos; las tres vacías cuentan como cero');
  assert.ok(caso.pasos.some(p => p.paso === 'Documentos listados'),
    'D2: el diario narra la sección listada');
  assert.equal(caso.aperturas, 0, 'D2: cero aperturas');
  console.log('OK 2.9.4 · D2 — Documentos: las tablas renderizadas se listan (3 filas) y las vacías cuentan cero concluyente.');
}

/* ===== M1 · Marcos mudos: la honestidad no se mueve ===== */
{
  const caso = await correr294(tribPara294('m1'));
  assert.ok(caso.resultado, 'M1: la corrida concluye: ' +
    (caso.error ? caso.error.code + ' — ' + caso.error.message : 'sin error'));
  assert.equal(caso.resultado.comunicados?.concluyente, false,
    'M1: el marco mudo de comunicados sigue sin concluir');
  assert.equal(caso.resultado.comunicadosNoLeidos, null,
    'M1: el conteo viaja null — jamás un cero fingido');
  assert.equal(caso.resultado.documentos?.concluyente, false,
    'M1: el marco mudo de documentos sigue sin listar');
  assert.ok(caso.resultado.comunicadosDiag && caso.resultado.documentosDiag,
    'M1: la evidencia por sección de la 2.9.3 sigue viajando en las dos secciones');
  assert.equal(caso.aperturas, 0, 'M1: cero aperturas');
  console.log('OK 2.9.4 · M1 — Marcos mudos: ninguna sección concluye, el conteo viaja null y la evidencia por sección sigue ahí.');
}

serverPortal.close();
serverMarcos.close();

/* ================================================================
   Estáticas de la ronda
   ================================================================ */
{
  const pkg = JSON.parse(readFileSync(join(AQUI, 'package.json'), 'utf8'));
  assert.equal(pkg.version, '2.9.15', 'la ronda es la 2.9.4');
  assert.ok(pkg.scripts.test.includes('ronda294buzon.test.mjs'),
    'la suite está registrada en la batería');
  assert.equal(EJECUTOR_VERSION, '2.9.15', 'el sello del ejecutor acompaña a la versión');
  console.log('OK 2.9.4 · Estáticas — versión 2.9.4, suite en la batería y sello del ejecutor.');
}

console.log('OK suite ronda294buzon completa');
