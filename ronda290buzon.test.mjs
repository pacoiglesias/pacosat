import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readdirSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createPlaywrightDriverFactory } from './sat-doc-browser.mjs';
import { createSatTribFetch } from './sat-tributario.mjs';
import { SatDocError } from './sat-doc-fetch.mjs';

/* ================================================================
   Ronda 2.9.0 — Bloque A (motor): la bandeja del Buzón vive en un
   iframe de OTRO ORIGEN y el pasillo va por el CAMINO HUMANO.

   El fallo que reproduce (probado en vivo el 17 nov 2026,
   corrida d1ac98a4, sede NAS): el acceso con e.firma funcionó y,
   tras «Voy a la bandeja», el caminante esperó la firma de la
   bandeja sobre la CÁSCARA con el menú. La evidencia real
   recuperada (~/workspace/pacosat-290-evidencia/
   run-d1ac98a4-html.html, 30.687 B) enseña la causa: la cáscara
   trae UN iframe <iframe id="iframetoload" src="https://
   agr.siat.sat.gob.mx/app/seg/SessionBroker?url=/PTSC/
   notificacionElectronica/faces/Pages/
   principalNotificaciones.jsf?…"> — origen DISTINTO
   (agr.siat.sat.gob.mx ≠ wwwmat.sat.gob.mx) — y los lectores
   de siempre (page.evaluate en el marco principal recorriendo
   iframe.contentDocument) son CIEGOS a un marco de otro
   origen: los marcadores de la bandeja («Destinatario:»,
   «Total de notificaciones pendientes», «No se encontraron
   resultados») nunca pueden aparecer en el texto compuesto,
   se espere lo que se espere.

   La réplica reproduce esa evidencia con DOS ORÍGENES (dos
   puertos locales): el portal vive en el origen 1 y la bandeja
   se sirve desde el origen 2 dentro de un iframe cross-origin,
   como agr.siat. El aterrizaje /buzon trae el cuerpo en blanco
   y la cabecera con «Mis expedientes», cuyo desplegable lleva
   «Mis notificaciones» como ancla GOBERNADA POR JS (sin href
   seguible: solo el clic enruta a la cáscara), igual que la
   real del mapa vivo del 16 nov 2026.

   Casos:
   (a) camino humano completo ⇒ ok, notifications [],
       comunicadosNoLeidos 2, el diario trae el paso del camino
       humano y CERO aperturas;
   (b) variante con filas ⇒ 2 notificaciones con folio y
       abierta=false, CERO aperturas;
   (c) sin menú en el aterrizaje (el clic no encuentra) ⇒ la
       reserva directa llega y lee igual;
   (d) el marco de la bandeja nunca enseña marcadores (página
       genérica) ⇒ fallo respuesta-inesperada, SIN cero fingido.

   COMPROBACIÓN DE VERDAD DE LA RONDA: contra el motor 2.8.0
   intacto, los casos (a) y (b) FALLAN (es el fallo del 17 nov
   reproducido: la bandeja cross-origin es invisible para los
   lectores de siempre); tras el arreglo (lectores por marcos
   vía evaluateFrames + camino humano primero), la suite
   entera queda en verde. Ambas corridas quedan anotadas en
   ~/workspace/pacosat-290-nota-A.md.

   REGLA LEGAL DURA, intacta: JAMÁS se abre una notificación —
   los enlaces Aviso/Documento de las filas y los de los
   mensajes apuntan a un contador de aperturas del fixture y
   deben quedar a cero en todos los casos.
   ================================================================ */

const RFC = 'MFI6212158B4';

/* ---------- El navegador real de esta máquina ---------- */
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
assert.ok(CHROME, 'ronda290buzon necesita un Chromium local para la réplica con navegador real: ' +
  'sin navegador la prueba que puede fallar no puede correr y la ronda no se da por probada.');

/* ---------- Origen 2: la bandeja (réplica de agr.siat) ---------- */
let aperturas = 0;
const bandejaVacia = `<!DOCTYPE html><html><body>
  <p>Destinatario: ${RFC}</p>
  <p>Total de notificaciones pendientes: 0</p>
  <p>No se encontraron resultados</p>
</body></html>`;
const bandejaFilas = `<!DOCTYPE html><html><body>
  <p>Destinatario: ${RFC}</p>
  <p>Total de notificaciones pendientes: 2</p>
  <table>
    <thead><tr><th>Folio del acto administrativo</th><th>Autoridad emisora</th><th>Acto administrativo</th><th>Fecha de aviso</th><th>Aviso</th><th>Documento</th></tr></thead>
    <tbody>
      <tr><td>F-100</td><td>Auditoría</td><td>Requerimiento de información</td><td>10/11/2026</td><td><a href="/abrir/1">Ver aviso</a></td><td><a href="/abrir/1">Documento</a></td></tr>
      <tr><td>F-101</td><td>Recaudación</td><td>Invitación a regularizar</td><td>09/11/2026</td><td><a href="/abrir/2">Ver aviso</a></td><td><a href="/abrir/2">Documento</a></td></tr>
    </tbody>
  </table>
</body></html>`;
const bandejaGenerica = `<!DOCTYPE html><html><body>
  <h1>Portal de trámites y servicios</h1>
  <p>Servicios disponibles para el contribuyente.</p>
  <a href="/inicio">Inicio</a>
</body></html>`;
const marcoComunicados = `<!DOCTYPE html><html><body>
  <h2>Mensajes no leídos (2)</h2>
  <p><a href="/abrir-mensaje/1">Aviso de actualización de datos</a></p>
  <p><a href="/abrir-mensaje/2">Recordatorio de obligaciones</a></p>
  <h2>Mensajes leídos (7)</h2>
  <p><a href="/abrir-mensaje/3">Comunicado anterior</a></p>
</body></html>`;
const RETRASO_BANDEJA_MS = 2000;
const serverBandeja = createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  if (path.startsWith('/abrir/') || path.startsWith('/abrir-mensaje/')) {
    aperturas += 1;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!DOCTYPE html><html><body><h1>Detalle abierto</h1></body></html>');
    return;
  }
  const tardias = { '/bandeja': bandejaVacia, '/bandeja-filas': bandejaFilas,
    '/bandeja-generica': bandejaGenerica };
  if (tardias[path]) {
    /* La bandeja real tarda en pintar (~30 s en vivo; aquí 2 s
       bastan para probar que la espera la aguanta). */
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(tardias[path]);
    }, RETRASO_BANDEJA_MS);
    return;
  }
  if (path === '/comunicados') {
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(marcoComunicados);
    }, 500);
    return;
  }
  res.writeHead(404); res.end();
});
await new Promise(resolve => serverBandeja.listen(0, '127.0.0.1', resolve));
const ORIGEN2 = 'http://127.0.0.1:' + serverBandeja.address().port;

/* ---------- Origen 1: el portal (réplica de wwwmat) ---------- */
/* Login fiel mínimo: las mismas formas de ronda201 (su fixture
   de acceso funciona con satBrowserLogin): «Acceso por
   contraseña» con #buttonFiel que navega al formulario NIDP,
   que deriva el RFC del certificado y envía al aterrizaje. */
const paginaAcceso = (fiel) => `<!DOCTYPE html><html><body>
  <h1>Acceso por contraseña</h1>
  <a id="buttonFiel" href="${fiel}">Acceso con e.firma</a>
</body></html>`;
const formularioLogin = (destino) => `<!DOCTYPE html><html><body>
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
/* El aterrizaje real tras el acceso: /buzon, «BUZÓN
   TRIBUTARIO», cuerpo principal EN BLANCO y la navegación en
   la CABECERA: el botón «Mis expedientes» despliega el menú y
   «Mis notificaciones» es un ancla GOBERNADA POR JS (href="#":
   solo el clic enruta a la cáscara), como la real. */
const cabeceraBuzon = (destinoNotificaciones) => `
  <header>
    <span>BUZÓN TRIBUTARIO</span>
    <button id="btn-expedientes" type="button">Mis expedientes</button>
    <nav id="menu-expedientes" style="display:none">
      <a href="#" data-nav="documentos">Mis documentos</a>
      <a href="#" id="link-notificaciones">Mis notificaciones</a>
      <a href="/iniciar-expediente/mis-comunicados/">Mis comunicados</a>
    </nav>
    <a href="#" data-nav="servicios">Servicios Disponibles</a>
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
const paginaBuzon = (destinoNotificaciones) =>
  `<!DOCTYPE html><html><body>${cabeceraBuzon(destinoNotificaciones)}<main></main></body></html>`;
/* Aterrizaje SIN menú (caso c): cuerpo en blanco y una cabecera
   que no trae el desplegable — el clic humano no encuentra
   nada y manda la reserva directa. */
const paginaBuzonSinMenu = `<!DOCTYPE html><html><body>
  <header><span>BUZÓN TRIBUTARIO</span><a href="#" data-nav="salir">Cerrar sesión</a></header>
  <main></main>
</body></html>`;
/* La cáscara de «Mis notificaciones»: menú + el iframe central
   cuyo src apunta al OTRO ORIGEN, como el iframetoload real
   hacia agr.siat. */
const cascaraNotificaciones = (destinoNotificaciones, marco) =>
  `<!DOCTYPE html><html><body>${cabeceraBuzon(destinoNotificaciones)}
  <main><iframe id="iframetoload" src="${marco}"></iframe></main>
</body></html>`;
const cascaraComunicados = (destinoNotificaciones) =>
  `<!DOCTYPE html><html><body>${cabeceraBuzon(destinoNotificaciones)}
  <main><iframe id="iframetoload" src="${ORIGEN2}/comunicados"></iframe></main>
</body></html>`;

const RUTA_NOTIF = '/iniciar-expediente/mis-notificaciones/';
const RUTA_NOTIF_FILAS = '/iniciar-expediente/mis-notificaciones-filas/';
const RUTA_NOTIF_GENERICA = '/iniciar-expediente/mis-notificaciones-generica/';
const serverPortal = createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  const rutas = {
    '/acceso': paginaAcceso('/acceso-fiel'),
    '/acceso-fiel': formularioLogin('/buzon'),
    '/buzon': paginaBuzon(RUTA_NOTIF),
    '/acceso-filas': paginaAcceso('/acceso-fiel-filas'),
    '/acceso-fiel-filas': formularioLogin('/buzon-filas'),
    '/buzon-filas': paginaBuzon(RUTA_NOTIF_FILAS),
    '/acceso-sin-menu': paginaAcceso('/acceso-fiel-sin-menu'),
    '/acceso-fiel-sin-menu': formularioLogin('/buzon-sin-menu'),
    '/buzon-sin-menu': paginaBuzonSinMenu,
    '/acceso-generica': paginaAcceso('/acceso-fiel-generica'),
    '/acceso-fiel-generica': formularioLogin('/buzon-generica'),
    '/buzon-generica': paginaBuzon(RUTA_NOTIF_GENERICA),
    [RUTA_NOTIF]: cascaraNotificaciones(RUTA_NOTIF, ORIGEN2 + '/bandeja'),
    [RUTA_NOTIF_FILAS]: cascaraNotificaciones(RUTA_NOTIF_FILAS, ORIGEN2 + '/bandeja-filas'),
    [RUTA_NOTIF_GENERICA]: cascaraNotificaciones(RUTA_NOTIF_GENERICA, ORIGEN2 + '/bandeja-generica'),
    '/iniciar-expediente/mis-comunicados/': cascaraComunicados(RUTA_NOTIF)
  };
  const html = rutas[path];
  if (!html) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
});
await new Promise(resolve => serverPortal.listen(0, '127.0.0.1', resolve));
const ORIGEN1 = 'http://127.0.0.1:' + serverPortal.address().port;

/* ---------- Credenciales de juguete (las de ronda201) ---------- */
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KEY_PORTAL = privateKey.export({ type: 'pkcs8', format: 'der',
  cipher: 'des-ede3-cbc', passphrase: 'pw-de-juguete' });
const CER = Buffer.from('certificado-de-juguete');
const resolverReal = async (profile) => ({ rfc: profile.rfc, cer: CER, key: KEY_PORTAL,
  password: 'pw-de-juguete' });

const tribPara = ({ entryUrl, loginUrl, esperaBandejaMs = 8_000 }) => createSatTribFetch({
  resolveCredentials: resolverReal,
  launchDriver: createPlaywrightDriverFactory({ executablePath: CHROME, headless: true }),
  entryUrl, loginUrl,
  comunicadosUrl: ORIGEN1 + '/iniciar-expediente/mis-comunicados/',
  esperaBandejaMs });

/* Las cuatro corridas se ejecutan ANTES de juzgar: contra el
   motor intacto, (a) y (b) deben fallar y la suite debe poder
   enseñarlo en las dos, no morir en la primera aserción. */
const correr = async (trib) => {
  const pasos = [];
  const aperturasAntes = aperturas;
  const salida = await trib({ rfc: RFC }, {},
    { onStep: (paso, detalle) => pasos.push({ paso, detalle }) })
    .then(resultado => ({ resultado }), error => ({ error }));
  return { ...salida, pasos, aperturas: aperturas - aperturasAntes };
};

const casoA = await correr(tribPara({ entryUrl: ORIGEN1 + RUTA_NOTIF, loginUrl: ORIGEN1 + '/acceso' }));
const casoB = await correr(tribPara({ entryUrl: ORIGEN1 + RUTA_NOTIF_FILAS, loginUrl: ORIGEN1 + '/acceso-filas' }));
const casoC = await correr(tribPara({ entryUrl: ORIGEN1 + RUTA_NOTIF, loginUrl: ORIGEN1 + '/acceso-sin-menu' }));
const casoD = await correr(tribPara({ entryUrl: ORIGEN1 + RUTA_NOTIF_GENERICA, loginUrl: ORIGEN1 + '/acceso-generica' }));

/* Resumen de desenlaces ANTES de juzgar: contra el motor
   intacto esta línea es la evidencia de la comprobación de
   verdad — (a) y (b) deben salir «error respuesta-inesperada»
   —; tras el arreglo, los cuatro deben salir «ok». */
const desenlace = (c) => c.resultado
  ? 'ok (' + c.resultado.notifications.length + ' notificaciones)'
  : 'error ' + (c.error?.code || '?');
console.log('Desenlaces ronda290buzon: (a) ' + desenlace(casoA) + ' · (b) ' + desenlace(casoB) +
  ' · (c) ' + desenlace(casoC) + ' · (d) ' + desenlace(casoD));

/* ===== (a) Camino humano completo: bandeja vacía cross-origin ===== */
{
  assert.ok(casoA.resultado, 'la corrida (a) lee la bandeja: ' +
    (casoA.error ? casoA.error.code + ' — ' + casoA.error.message : 'sin error'));
  assert.deepEqual(casoA.resultado.notifications, [],
    'la bandeja del iframe cross-origin dice «No se encontraron resultados» con Total 0: éxito con 0 filas');
  assert.equal(casoA.resultado.comunicadosNoLeidos, 2,
    '«Mis comunicados» también vive en un iframe cross-origin: sus conteos se leen (2 sin leer)');
  assert.ok(casoA.pasos.some(p => p.paso.includes('Sigo el camino del portal') &&
      p.paso.includes('«Mis expedientes» → «Mis notificaciones»')),
    'el diario trae el paso del camino humano: ' + casoA.pasos.map(p => p.paso).join(' | '));
  assert.equal(casoA.aperturas, 0, 'cero aperturas: ni notificaciones ni mensajes se abrieron');
  console.log('OK 2.9.0 · A-a — Camino humano → cáscara → iframe cross-origin: bandeja vacía leída DENTRO de su marco, comunicados por conteo, cero aperturas.');
}

/* ===== (b) Variante con filas: 2 pendientes con folio, sin abrir ===== */
{
  assert.ok(casoB.resultado, 'la corrida (b) lee la bandeja con filas: ' +
    (casoB.error ? casoB.error.code + ' — ' + casoB.error.message : 'sin error'));
  assert.equal(casoB.resultado.notifications.length, 2, 'la tabla del marco trae sus 2 pendientes');
  assert.deepEqual(casoB.resultado.notifications.map(n => n.folio), ['F-100', 'F-101'],
    'cada fila lleva el Folio del acto administrativo');
  assert.equal(casoB.resultado.notifications[0].fecha, '2026-11-10', 'fecha ← Fecha de aviso, normalizada');
  assert.equal(casoB.resultado.notifications[0].asunto, 'Requerimiento de información', 'asunto ← Acto administrativo');
  assert.equal(casoB.resultado.notifications[0].remitente, 'Auditoría', 'remitente ← Autoridad emisora');
  assert.ok(casoB.resultado.notifications.every(n => n.abierta === false),
    'todas sin abrir: la lista es la de pendientes');
  assert.equal(casoB.aperturas, 0,
    'cero aperturas: los enlaces Aviso/Documento de las filas jamás se siguieron');
  console.log('OK 2.9.0 · A-b — Bandeja con filas en el iframe cross-origin: 2 notificaciones con folio, abierta=false, cero aperturas.');
}

/* ===== (c) Sin menú en el aterrizaje: la reserva directa lee igual ===== */
{
  assert.ok(casoC.resultado, 'la corrida (c) lee la bandeja por la reserva directa: ' +
    (casoC.error ? casoC.error.code + ' — ' + casoC.error.message : 'sin error'));
  assert.deepEqual(casoC.resultado.notifications, [],
    'sin menú, la dirección directa llega a la cáscara y el marco cross-origin se lee igual');
  assert.ok(casoC.pasos.some(p => p.paso === 'Busco la bandeja'),
    'el diario cuenta que mandó la reserva directa: ' + casoC.pasos.map(p => p.paso).join(' | '));
  assert.equal(casoC.aperturas, 0, 'cero aperturas también por la reserva');
  console.log('OK 2.9.0 · A-c — Sin menú en el aterrizaje: el clic no encuentra, la reserva directa llega y lee la bandeja cross-origin.');
}

/* ===== (d) El marco nunca enseña marcadores: fallo honesto ===== */
{
  assert.ok(casoD.error instanceof SatDocError,
    'la corrida (d) cierra en error del motor, no en un resultado vacío fingido');
  assert.equal(casoD.error.code, 'respuesta-inesperada',
    'sin marcadores de bandeja en ningún marco, el desenlace es respuesta-inesperada');
  assert.ok(!casoD.resultado, 'no hay resultado: jamás un cero fingido');
  assert.equal(casoD.aperturas, 0, 'cero aperturas también en el fallo');
  console.log('OK 2.9.0 · A-d — Marco genérico sin marcadores: fallo respuesta-inesperada con su inventario, SIN cero fingido.');
}

serverPortal.close();
serverBandeja.close();
console.log('OK suite ronda290buzon completa');
