import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createServer } from 'node:http';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DOMParser } from '@xmldom/xmldom';
import { createPacoSATService } from './local-server.mjs';
import { createPlaywrightDriverFactory } from './sat-doc-browser.mjs';
import { createSatTribFetch, extractBuzonRows, extractBuzonRowsReales,
  buzonBandejaVacia } from './sat-tributario.mjs';

/* ================================================================
   Ronda 2.9.1 — el parche de la prueba de verdad de la 2.9.0
   (18 nov 2026, corridas reales 962e463f del Buzón y 1d8f086b
   de Declaraciones; la pieza 5, la rejilla, vive en
   ronda291decl). Aquí se juzgan las piezas 1–4:

   PIEZA 1 · La notificación fantasma: la corrida 962e463f leyó
   la bandeja por primera vez desde el NAS y guardó UNA
   notificación cuyo asunto era el texto literal de la TABLA
   VACÍA («Folio del acto administrativo Autoridad emisora
   Seleccione Acto administrativo Seleccione Fecha de aviso
   Aviso Documento No se encontraron resultados p p p p»),
   con sinAbrir=1 y su alerta falsa. PROCEDENCIA DEL FIXTURE:
   el artefacto de esa corrida NO existe en la API (el agente
   principal verificó GET /api/tributario/artifact?run=962e463f
   &part=html|shot → 404 «Esa corrida no guardó esa parte del
   diario»), así que el fixture se construye DESDE ESE TEXTO
   LITERAL: la fila tal como el parser la consumió — el asunto
   guardado ES, verbatim, la celda de «Acto administrativo» que
   el extractor leyó —. Se juzga: el marcador «No se
   encontraron resultados» (y «Total de notificaciones
   pendientes: 0») es vacío confirmado → CERO filas, y jamás
   se construye una fila con textos de cabecera ni con el
   marcador, en el extractor real ni en el clásico.

   PIEZA 2 · Limpieza: el guardado del Buzón era un upsert sin
   reemplazo — lo que una consulta dejaba de listar se quedaba
   guardado para siempre (así habría sobrevivido el fantasma).
   Se juzga: una consulta concluyente REEMPLAZA la lista
   guardada (lo no listado sale), una concluyente con 0 filas
   deja la lista en 0 y sinAbrir en 0, y la papelera local —
   gesto de Paco, con su borrado definitivo propio — no la
   toca la sincronización.

   PIEZA 3 · Comunicados no concluyente en la misma corrida
   («no enseñó ni su tabla ni sus conteos en el plazo de
   espera»): su página tiene su propio marco tras su cáscara.
   Razonado desde el código y desde el tratamiento que la
   bandeja recibió en la 2.9.0: camino humano primero (el clic
   de la cabecera), la directa como reserva y el plazo
   COMPLETO de la corrida (la espera estaba recortada a 30 s
   y el marco tarda ~30 s según el mapa vivo del 16 nov).
   Réplica con dos orígenes, como la de ronda290buzon:
   (a) la ruta directa sirve una cáscara cuyo marco jamás
   concluye y SOLO el camino del menú lleva a los conteos;
   (b) el marco de comunicados tarda 33 s en pintar sus
   conteos: con el recorte de 30 s no concluye; con el plazo
   completo (40 s en la réplica) concluye con 2 sin leer y
   7 leídos — los conteos del recon del 16 nov 2026.

   PIEZA 4 · Ruido de sede: con paseo=nas, el «desajuste
   persistente del ejecutor» seguía disparando su correo (el
   Registro de producción enseña esos correos ya en sede
   nas): en sede nas el ejecutor de PC es la reserva y su
   desajuste no es un aviso. Se juzga: el mismo escenario de
   ronda232eco (emparejado, reporte viejo, 5 h de reloj) en
   sede REMOTA manda su correo (el tick vive) y en sede NAS
   no manda ninguno ni deja asiento.

   REGLA LEGAL DURA, intacta en toda la suite: JAMÁS se abre
   una notificación ni un mensaje — los enlaces de detalle
   del fixture apuntan a un contador de aperturas que debe
   quedar a cero.
   ================================================================ */

const RFC = 'MFI6212158B4';
const ORIGIN = 'https://pacosat.test';
const KEY = 'b'.repeat(64);
const OWN = 'AAA010101AAA';

/* ================================================================
   PIEZA 1 · El parser no construye el fantasma
   ================================================================ */
const FANTASMA = 'Folio del acto administrativo Autoridad emisora Seleccione ' +
  'Acto administrativo Seleccione Fecha de aviso Aviso Documento ' +
  'No se encontraron resultados p p p p';
const CABECERAS_REALES = ['Folio del acto administrativo', 'Autoridad emisora',
  'Acto administrativo', 'Fecha de aviso', 'Aviso', 'Documento'];
{
  /* La fila fantasma tal como la consumió el parser: la celda
     del acto trae el texto entero de la tabla vacía. */
  const tablaFantasma = { headers: CABECERAS_REALES,
    rows: [['', '', FANTASMA, '', '', '']] };
  assert.deepEqual(extractBuzonRowsReales([tablaFantasma]), [],
    'pieza 1: la fila construida con el texto de la tabla vacía NO es una notificación: cero filas');
  /* La forma colspan de la tabla vacía real. */
  const tablaVacia = { headers: CABECERAS_REALES,
    rows: [['No se encontraron resultados']] };
  assert.deepEqual(extractBuzonRowsReales([tablaVacia]), [],
    'pieza 1: la fila del marcador de vacío (colspan) tampoco construye nada');
  /* La fila de filtros de la cabecera (los «Seleccione»). */
  const tablaFiltros = { headers: CABECERAS_REALES,
    rows: [['', 'Seleccione', 'Seleccione', '', '', '']] };
  assert.deepEqual(extractBuzonRowsReales([tablaFiltros]), [],
    'pieza 1: la fila de filtros de la tabla no es una notificación');
  /* El extractor clásico de respaldo, con su forma de tabla:
     el mismo fantasma en su columna de asunto. */
  const tablaFantasmaClasica = { headers: ['Fecha', 'Asunto', 'Remitente', 'Estado'],
    rows: [['', FANTASMA, '', '']] };
  const clasicas = extractBuzonRows([tablaFantasmaClasica], false);
  assert.ok(!clasicas || clasicas.length === 0,
    'pieza 1: el extractor clásico tampoco construye el fantasma (trajo ' +
    (clasicas ? clasicas.length : 'null') + ')');
  /* El marcador manda como vacío confirmado. */
  assert.equal(buzonBandejaVacia('Destinatario: ' + RFC +
    ' · Total de notificaciones pendientes: 0 · No se encontraron resultados'), true,
    'pieza 1: «No se encontraron resultados» con la firma de la bandeja es vacío confirmado');
  assert.equal(buzonBandejaVacia('Destinatario: ' + RFC +
    ' · Total de notificaciones pendientes: 0'), true,
    'pieza 1: «Total de notificaciones pendientes: 0» también es vacío confirmado');
  /* Control positivo: las filas de verdad se siguen leyendo. */
  const tablaReal = { headers: CABECERAS_REALES,
    rows: [['F-100', 'Auditoría', 'Requerimiento de información', '10/11/2026', 'Ver', 'PDF'],
      ['F-101', 'Recaudación', 'Invitación a regularizar', '09/11/2026', 'Ver', 'PDF']] };
  const reales = extractBuzonRowsReales([tablaReal]);
  assert.equal(reales.length, 2, 'pieza 1: las filas reales se leen como siempre');
  assert.equal(reales[0].asunto, 'Requerimiento de información');
  console.log('OK 2.9.1 · Pieza 1 — el parser reconoce la tabla vacía como vacío confirmado: cero filas, sin fantasma, y las filas reales intactas.');
}

/* ================================================================
   Arnés de servicio (el de ronda250paseo/ronda232eco)
   ================================================================ */
function makeHarness(options = {}) {
  const clock = { t: options.start ?? Date.parse('2026-11-18T06:00:00Z') };
  const mails = [];
  const service = createPacoSATService({
    dbFile: ':memory:',
    html: '<html><head><!--PACOSAT_TOKEN--></head><body>prueba</body></html>',
    origin: ORIGIN, proxyKey: KEY, satDocRetryWaitMs: 5,
    makeConnector: () => ({ parser: DOMParser, connector: {
      request: async () => 'req-291', check: async () => ({ status: 'pending', packages: [] }),
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

/* ================================================================
   PIEZA 2 · El guardado reemplaza: lo no listado sale
   ================================================================ */
{
  const fila = (asunto, fecha) => ({ fecha, asunto, remitente: 'Auditoría',
    estado: 'Pendiente', abierta: false });
  const R1 = fila('Requerimiento de pago', '2026-11-10');
  const R2 = fila('Requerimiento de información', '2026-11-09');
  const R3 = fila('Multa por omisión', '2026-11-08');
  const guion = [
    { notifications: [R1, R2, R3], comunicadosNoLeidos: 0 },
    { notifications: [R1], comunicadosNoLeidos: 0 },
    { notifications: [], comunicadosNoLeidos: 0 }];
  const satTribFetch = async () => guion.shift();
  const h = makeHarness({ executorMode: 'nas', satTribFetch });
  try {
    await unlock(h);
    const vista = async (extra = '') =>
      (await h.call('GET', '/api/tributario?rfc=' + OWN + extra)).json;

    const runA = await h.call('POST', '/api/tributario/run', { rfc: OWN });
    assert.equal(runA.json.result.ok, true, 'pieza 2: la primera consulta concluye');
    assert.equal(runA.json.result.encontradas, 3, 'pieza 2: la primera consulta lista 3');
    assert.equal((await vista()).total, 3, 'pieza 2: quedan guardadas las 3');
    assert.equal((await vista()).sinAbrir, 3, 'pieza 2: las 3 sin abrir');

    /* R3 a la papelera LOCAL: gesto de Paco, fuera del alcance
       de la sincronización. */
    const conPapelera = await vista('&papelera=1');
    const claveR3 = conPapelera.notificaciones.find(n => n.asunto === R3.asunto)?.clave;
    assert.ok(claveR3, 'pieza 2: la fila R3 tiene su clave para mandarla a la papelera');
    const trash = await h.call('POST', '/api/tributario/trash',
      { rfc: OWN, clave: claveR3, papelera: true });
    assert.equal(trash.json.ok, true, 'pieza 2: R3 va a la papelera local');

    const runB = await h.call('POST', '/api/tributario/run', { rfc: OWN });
    assert.equal(runB.json.result.encontradas, 1, 'pieza 2: la segunda consulta lista solo 1');
    const vistaB = await vista();
    assert.equal(vistaB.total, 1,
      'pieza 2: lo que la consulta concluyente dejó de listar SALE de la lista guardada (R2 ya no consta)');
    assert.equal(vistaB.sinAbrir, 1, 'pieza 2: sinAbrir sigue a la lista reemplazada');
    assert.deepEqual(vistaB.notificaciones.map(n => n.asunto), [R1.asunto],
      'pieza 2: la lista guardada es exactamente la última lista concluyente');
    const vistaBP = await vista('&papelera=1');
    assert.equal(vistaBP.papeleraTotal, 1,
      'pieza 2: la papelera local NO la toca la sincronización (R3 sigue en su papelera)');

    const runC = await h.call('POST', '/api/tributario/run', { rfc: OWN });
    assert.equal(runC.json.result.encontradas, 0, 'pieza 2: la tercera consulta lista 0');
    assert.equal(runC.json.result.sinAbrir, 0,
      'pieza 2: la consulta concluyente con 0 filas deja sinAbrir en 0 (el fantasma no sobrevive)');
    const vistaC = await vista();
    assert.equal(vistaC.total, 0, 'pieza 2: la lista guardada queda en 0');
    assert.deepEqual(vistaC.notificaciones, [], 'pieza 2: ninguna notificación guardada');
    console.log('OK 2.9.1 · Pieza 2 — el guardado del Buzón es un reemplazo: lo no listado sale, el 0 concluyente deja lista y sinAbrir en 0, y la papelera local se respeta.');
  } finally { h.service.close(); }
}

/* ================================================================
   PIEZA 4 · En sede NAS el desajuste del ejecutor no dispara
   ================================================================ */
const MANIFIESTO = existsSync(join(import.meta.dirname, 'ejecutor-bundle.json'))
  ? JSON.parse(readFileSync(join(import.meta.dirname, 'ejecutor-bundle.json'), 'utf8')) : {};
const CON_PAQUETE = String(MANIFIESTO.version || '') !== '' &&
  String(MANIFIESTO.huellaMotores || '') !== '';
if (CON_PAQUETE) {
  const T0 = Date.parse('2026-11-17T15:00:00Z');
  const HORA = 3600000;
  const escenarioDesajuste = async (executorMode) => {
    const h = makeHarness({ executorMode, start: T0 });
    await unlock(h);
    const par = await h.call('POST', '/api/executor/pair', { nombre: 'Equipo de Paco' });
    assert.ok(par.json.token, 'pieza 4: ejecutor emparejado en sede ' + executorMode);
    const mail = await h.call('POST', '/api/mail', { host: 'smtp.example.com', port: 587,
      from: 'avisos@pacosat.test', recipient: 'paco@test.mx', user: '', password: '' });
    assert.equal(mail.status, 200, 'pieza 4: el correo de juguete se configura');
    const latido = async () => {
      const r = await h.exec('POST', '/api/executor/heartbeat',
        { reporte: { version: '2.0.0', huella: 'a'.repeat(64) } }, par.json.token);
      assert.equal(r.json.ok, true, 'pieza 4: el latido con el reporte viejo se acepta');
    };
    await latido();
    await h.service.tick();
    h.clock.t = T0 + 5 * HORA;
    await latido();
    await h.service.tick();
    return h;
  };
  const correosDesajuste = h => h.mails.filter(m =>
    /no corre el paquete|sigue sin correr el paquete/.test(String(m.subject || '')));

  const remoto = await escenarioDesajuste('remote');
  try {
    assert.equal(correosDesajuste(remoto).length, 1,
      'pieza 4 (control): en sede REMOTA el desajuste de 5 h manda su correo — el tick vive');
  } finally { remoto.service.close(); }

  const nas = await escenarioDesajuste('nas');
  try {
    assert.equal(correosDesajuste(nas).length, 0,
      'pieza 4: en sede NAS el desajuste persistente del ejecutor NO dispara correo');
    const registro = (await nas.call('GET',
      '/api/registro?texto=' + encodeURIComponent('desajuste persistente') + '&limit=50')).json;
    assert.equal((registro.items || []).filter(i =>
      String(i.texto || '').includes('desajuste persistente')).length, 0,
      'pieza 4: en sede NAS tampoco queda asiento del correo del desajuste');
    console.log('OK 2.9.1 · Pieza 4 — sede NAS: el desajuste del ejecutor (reserva) no dispara ni correo ni asiento; en sede remota el aviso sigue vivo.');
  } finally { nas.service.close(); }
} else {
  console.log('Pieza 4 OMITIDA: sin ejecutor-bundle.json en el árbol no hay paquete contra el que desajustar.');
}

/* ================================================================
   PIEZA 3 · Comunicados: camino humano y plazo completo
   (réplica con dos orígenes, patrón de ronda290buzon)
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
assert.ok(CHROME, 'ronda291parche (pieza 3) necesita un Chromium local para la réplica: ' +
  'sin navegador la prueba que puede fallar no puede correr.');

let aperturas = 0;
const bandejaVacia291 = `<!DOCTYPE html><html><body>
  <p>Destinatario: ${RFC}</p>
  <p>Total de notificaciones pendientes: 0</p>
  <p>No se encontraron resultados</p>
</body></html>`;
const marcoComunicados291 = `<!DOCTYPE html><html><body>
  <h2>Mensajes no leídos (2)</h2>
  <p><a href="/abrir-mensaje/1">Aviso de actualización de datos</a></p>
  <p><a href="/abrir-mensaje/2">Recordatorio de obligaciones</a></p>
  <h2>Mensajes leídos (7)</h2>
  <p><a href="/abrir-mensaje/3">Comunicado anterior</a></p>
</body></html>`;
const marcoGenerico291 = `<!DOCTYPE html><html><body>
  <h1>Portal de trámites y servicios</h1>
  <p>Servicios disponibles para el contribuyente.</p>
</body></html>`;
const serverBandeja = createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  if (path.startsWith('/abrir/') || path.startsWith('/abrir-mensaje/')) {
    aperturas += 1;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!DOCTYPE html><html><body><h1>Detalle abierto</h1></body></html>');
    return;
  }
  const servir = (html, ms) => setTimeout(() => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  }, ms);
  if (path === '/bandeja') return servir(bandejaVacia291, 1000);
  if (path === '/comunicados') return servir(marcoComunicados291, 500);
  if (path === '/comunicados-lento') return servir(marcoComunicados291, 33_000);
  if (path === '/generica') return servir(marcoGenerico291, 300);
  res.writeHead(404); res.end();
});
await new Promise(resolve => serverBandeja.listen(0, '127.0.0.1', resolve));
const ORIGEN2 = 'http://127.0.0.1:' + serverBandeja.address().port;

const paginaAcceso291 = (fiel) => `<!DOCTYPE html><html><body>
  <h1>Acceso por contraseña</h1>
  <a id="buttonFiel" href="${fiel}">Acceso con e.firma</a>
</body></html>`;
const formularioLogin291 = (destino) => `<!DOCTYPE html><html><body>
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
/* La cabecera del Buzón: «Mis notificaciones» gobernada por JS
   (solo el clic enruta) y «Mis comunicados» como enlace a la
   ruta que el fixture decida (la del menú). */
const cabecera291 = (destinoNotificaciones, hrefComunicados) => `
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
const paginaBuzon291 = (destinoNotificaciones, hrefComunicados) =>
  `<!DOCTYPE html><html><body>${cabecera291(destinoNotificaciones, hrefComunicados)}<main></main></body></html>`;
const cascara291 = (destinoNotificaciones, hrefComunicados, marco) =>
  `<!DOCTYPE html><html><body>${cabecera291(destinoNotificaciones, hrefComunicados)}
  <main><iframe id="iframetoload" src="${marco}"></iframe></main>
</body></html>`;

const RUTA_NOTIF_A = '/iniciar-expediente/mis-notificaciones-a/';
const RUTA_NOTIF_B = '/iniciar-expediente/mis-notificaciones-b/';
const RUTA_COM_MENU_A = '/iniciar-expediente/mis-comunicados-menu-a/';
const RUTA_COM_A = '/iniciar-expediente/mis-comunicados-a/';
const RUTA_COM_B = '/iniciar-expediente/mis-comunicados-b/';
const serverPortal = createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  const rutas = {
    /* (a) Solo el menú lleva a los conteos: la ruta directa
       sirve una cáscara con un marco genérico que jamás
       concluye. */
    '/acceso-a': paginaAcceso291('/acceso-fiel-a'),
    '/acceso-fiel-a': formularioLogin291('/buzon-a'),
    '/buzon-a': paginaBuzon291(RUTA_NOTIF_A, RUTA_COM_MENU_A),
    [RUTA_NOTIF_A]: cascara291(RUTA_NOTIF_A, RUTA_COM_MENU_A, ORIGEN2 + '/bandeja'),
    [RUTA_COM_MENU_A]: cascara291(RUTA_NOTIF_A, RUTA_COM_MENU_A, ORIGEN2 + '/comunicados'),
    [RUTA_COM_A]: cascara291(RUTA_NOTIF_A, RUTA_COM_MENU_A, ORIGEN2 + '/generica'),
    /* (b) El marco de comunicados tarda 33 s: menú y directa
       son la misma ruta (como en el portal real). */
    '/acceso-b': paginaAcceso291('/acceso-fiel-b'),
    '/acceso-fiel-b': formularioLogin291('/buzon-b'),
    '/buzon-b': paginaBuzon291(RUTA_NOTIF_B, RUTA_COM_B),
    [RUTA_NOTIF_B]: cascara291(RUTA_NOTIF_B, RUTA_COM_B, ORIGEN2 + '/bandeja'),
    [RUTA_COM_B]: cascara291(RUTA_NOTIF_B, RUTA_COM_B, ORIGEN2 + '/comunicados-lento')
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
const tribPara291 = ({ entryUrl, loginUrl, comunicadosUrl, esperaBandejaMs }) =>
  createSatTribFetch({ resolveCredentials: resolverReal,
    launchDriver: createPlaywrightDriverFactory({ executablePath: CHROME, headless: true }),
    entryUrl, loginUrl, comunicadosUrl, esperaBandejaMs });
const correr291 = async (trib) => {
  const pasos = [];
  const aperturasAntes = aperturas;
  const salida = await trib({ rfc: RFC }, {},
    { onStep: (paso, detalle) => pasos.push({ paso, detalle }) })
    .then(resultado => ({ resultado }), error => ({ error }));
  return { ...salida, pasos, aperturas: aperturas - aperturasAntes };
};

/* ===== (a) Solo el camino del menú lleva a los conteos ===== */
{
  const caso = await correr291(tribPara291({
    entryUrl: ORIGEN1 + RUTA_NOTIF_A, loginUrl: ORIGEN1 + '/acceso-a',
    comunicadosUrl: ORIGEN1 + RUTA_COM_A, esperaBandejaMs: 20_000 }));
  assert.ok(caso.resultado, 'pieza 3(a): la corrida concluye: ' +
    (caso.error ? caso.error.code + ' — ' + caso.error.message : 'sin error'));
  assert.deepEqual(caso.resultado.notifications, [], 'pieza 3(a): la bandeja vacía se lee');
  assert.equal(caso.resultado.comunicadosNoLeidos, 2,
    'pieza 3(a): los conteos de comunicados se leen por el camino del menú (2 sin leer)');
  assert.equal(caso.resultado.comunicados?.concluyente, true,
    'pieza 3(a): la sección de comunicados sale concluyente');
  assert.equal(caso.resultado.comunicados?.leidos, 7,
    'pieza 3(a): y los leídos son los del recon (7)');
  assert.ok(caso.pasos.some(p => p.paso.includes('«Mis expedientes» → «Mis comunicados»')),
    'pieza 3(a): el diario trae el paso del camino humano de comunicados: ' +
    caso.pasos.map(p => p.paso).join(' | '));
  assert.equal(caso.aperturas, 0, 'pieza 3(a): cero aperturas');
  console.log('OK 2.9.1 · Pieza 3(a) — Comunicados: la directa no concluye y el camino humano («Mis expedientes» → «Mis comunicados») lee los conteos dentro de su marco.');
}

/* ===== (b) El marco tarda 33 s: manda el plazo completo ===== */
{
  const caso = await correr291(tribPara291({
    entryUrl: ORIGEN1 + RUTA_NOTIF_B, loginUrl: ORIGEN1 + '/acceso-b',
    comunicadosUrl: ORIGEN1 + RUTA_COM_B, esperaBandejaMs: 40_000 }));
  assert.ok(caso.resultado, 'pieza 3(b): la corrida concluye: ' +
    (caso.error ? caso.error.code + ' — ' + caso.error.message : 'sin error'));
  assert.equal(caso.resultado.comunicadosNoLeidos, 2,
    'pieza 3(b): un marco que tarda 33 s concluye con el plazo completo de la corrida (sin el recorte de 30 s)');
  assert.equal(caso.resultado.comunicados?.concluyente, true,
    'pieza 3(b): la sección sale concluyente, no un «no consta» por plazo corto');
  assert.equal(caso.aperturas, 0, 'pieza 3(b): cero aperturas');
  console.log('OK 2.9.1 · Pieza 3(b) — Comunicados: el marco lento (33 s) se espera con el plazo completo y concluye con sus conteos.');
}

serverPortal.close();
serverBandeja.close();
console.log('OK suite ronda291parche completa');
