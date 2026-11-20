import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createPlaywrightDriverFactory, satBrowserLogin } from './sat-doc-browser.mjs';
import { createSatTribFetch, buzonDiagEsMuerto, extractBuzonRowsReales, buzonConteosComunicados } from './sat-tributario.mjs';
import { createSatDeclFetch, fetchMensuales, DECL_TRANSACCIONES_DEFAULTS, DECL_DEFAULTS, DECL_PLATFORM_HOST } from './sat-declaraciones.mjs';
import { SatDocError } from './sat-doc-fetch.mjs';

/* ================================================================
   Ronda 2.0.1 — PARTE MOTORES: reconstrucción de los pasillos
   del Buzón y de Declaraciones contra la evidencia real de
   producción del 16 nov 2026 y el MAPA REAL del portal
   levantado en sesión viva ese mismo día (15:35–15:55), y
   endurecimiento del acceso con e.firma.

   El mapa vivo manda sobre el inferido de artefactos:
   - Buzón: aterrizaje en /buzon (cuerpo en blanco, navegación
     en la cabecera con el desplegable «Mis expedientes»); la
     bandeja vive en /iniciar-expediente/mis-notificaciones/
     dentro de un IFRAME central que tarda ~30 s, con
     «Destinatario: <RFC>», «Total de notificaciones
     pendientes: N» y la tabla de columnas reales (Folio del
     acto administrativo | Autoridad emisora | Acto
     administrativo | Fecha de aviso | Aviso | Documento);
     «Mis comunicados» enseña solo conteos de grupo.
   - Declaraciones: ruta pública sat.gob.mx (declaraciones-pm
     → «Provisionales y definitivas» → acordeón de la Nueva
     plataforma → «Ingresa al servicio») → segundo acceso con
     e.firma en loginda.siat.sat.gob.mx (RFC deshabilitado, lo
     deriva el portal) → plataforma en
     ptscdecprov.clouda.sat.gob.mx. El tramo interior hasta la
     consulta de presentadas/acuses sigue en reconocimiento:
     la fixture de ese tramo es RÉPLICA según el mapa, no
     página capturada, y queda nombrado como pendiente de
     verificación en vivo en la nota de la ronda.

   Esta suite prueba, con fixtures contra el mapa:
   (0) la 404 real de producción, verbatim, clasifica como
       página muerta; el extractor real y los conteos, en
       unidad;
   (A) el Buzón espera al iframe tardío de la bandeja, lista
       las 2 filas con su mapeo (folio incluido), lee el
       conteo de comunicados y NO abre nada (contador de
       aperturas de notificaciones Y mensajes a cero); la
       variante vacía probada es un éxito con 0 filas;
   (B) la sesión reutilizada que arranca ya en la 404 falla
       rápido sin clicar ni navegar, y la captura de decisión
       muerta se REEMPLAZA por la portada viva posterior;
   (C) Declaraciones: la consulta de transacciones pide
       PRIMERO la dirección directa de la ficha 22513 tras el
       segundo acceso y lee las operaciones; la portada-trampa
       que mata la página al primer clic no recibe clics
       posteriores y el fallo se clasifica ruta-muerta; con la
       página ya muerta al entrar, no se clica nada; y la
       fábrica no adjunta una decisión muerta;
   (D) el acceso con e.firma: el RFC readonly que solo se
       deriva al adjuntar el certificado por SEGUNDA vez
       completa el acceso; el que nunca se deriva aborta SIN
       enviar (envíos a cero) y su error lleva el diag con el
       HTML del formulario;
   (E) Declaraciones por la ruta viva COMPLETA (réplica
       según el mapa del 16 nov 2026, 15:56–16:04): caminata
       pública, segundo acceso en la puerta loginda con su
       botón «e.firma», plataforma clásica, salto al portal
       nuevo por su menú, «Consultas» → «De la declaración»,
       consulta por ejercicio y el acuse («Generar PDF») de
       cada fila; y (E2) el ejercicio anterior a 2022 dicho
       en llano, sin pasear por la consulta clásica muerta.
   Lo NO probado con fixtures queda declarado en la nota de la
   ronda: la navegación real del portal (la espera real de
   ~30 s del iframe y el tramo post-acceso de DyP) solo se
   prueba en vivo con Paco.
   ================================================================ */

const RFC = 'MFI6212158B4';

/* ---------- (0) La 404 real de producción, verbatim ---------- */
const HTML404_RESERVA = '<html><head>\n    <title>Página no encontrada</title>\n  </head>\n  <body>\n  <center>      \n\t<h1>Página no encontrada.</h1>\n  </center>   \n  \n\n</body></html>';
let HTML404 = HTML404_RESERVA;
try {
  const real = readFileSync(new URL('../../pacosat-201-evidencia/pagina-fallo.html', import.meta.url), 'utf8');
  if (real.includes('Página no encontrada')) HTML404 = real;
} catch { /* sin el expediente a mano manda la copia verbatim incrustada */ }
{
  assert.equal(Buffer.byteLength(HTML404, 'utf8'), 156, 'la fixture de la 404 es la real de producción: 156 bytes');
  assert.equal(HTML404, HTML404_RESERVA, 'la copia incrustada es verbatim de la real');
  assert.equal(buzonDiagEsMuerto({ url: 'https://wwwmat.sat.gob.mx/app/seg/null', html: HTML404 }), true,
    'la 404 real clasifica como página muerta (URL y HTML)');
  assert.equal(buzonDiagEsMuerto({ url: 'https://wwwmat.sat.gob.mx/portada', html: HTML404 }), true,
    'también por su HTML, aunque la URL no sea la degenerada');
  assert.equal(buzonDiagEsMuerto({ url: 'https://wwwmat.sat.gob.mx/app/seg/null', html: '' }), true,
    'también por su URL, aunque el HTML no se haya podido leer');
  assert.equal(buzonDiagEsMuerto({ url: 'https://wwwmat.sat.gob.mx/portada', html: '<html><body>Buzón Tributario</body></html>' }), false,
    'una portada viva no es página muerta');
  /* El extractor de la tabla REAL del mapa vivo, en unidad. */
  const filas = extractBuzonRowsReales([{ headers: ['Folio del acto administrativo', 'Autoridad emisora',
      'Acto administrativo', 'Fecha de aviso', 'Aviso', 'Documento'],
    rows: [['F-100', 'Auditoría', 'Requerimiento de información', '10/11/2026', 'Ver', 'PDF'],
      ['F-101', 'Recaudación', 'Invitación a regularizar', '09/11/2026', 'Ver', 'PDF']] }]);
  assert.equal(filas.length, 2, 'el extractor real lee las dos filas');
  assert.deepEqual(filas[0], { fecha: '2026-11-10', asunto: 'Requerimiento de información',
    remitente: 'Auditoría', estado: 'Pendiente', abierta: false, folio: 'F-100' },
    'mapeo del mapa: fecha←Fecha de aviso, asunto←Acto administrativo, remitente←Autoridad emisora, folio y sin abrir');
  assert.equal(extractBuzonRowsReales([{ headers: ['Fecha', 'Asunto', 'Remitente', 'Estado'], rows: [['x', 'y', 'z', 'w']] }]), null,
    'la tabla clásica no es la real: manda el extractor de respaldo');
  assert.deepEqual(buzonConteosComunicados('Mensajes no leídos (2) · Mensajes leídos (7)'),
    { noLeidos: 2, leidos: 7 }, 'los conteos de comunicados salen de sus encabezados de grupo');
  assert.equal(buzonConteosComunicados('Buzón Tributario'), null, 'sin encabezados de grupo no hay conteo');
  console.log('OK 2.0.1 · 0 — la 404 real (156 B, verbatim) clasifica como muerta; extractor real y conteos de comunicados, en unidad.');
}

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
assert.ok(CHROME, 'ronda201 necesita un Chromium local para las réplicas con navegador real: ' +
  'sin navegador la prueba que puede fallar no puede correr y la ronda no se da por probada.');

/* ---------- El servidor fixture (mapa real) ---------- */
let aperturas = 0;
let adjuntosCert = 0;
const rutasPedidas = [];
/* Ajuste de fixture 2.9.0 (Bloque A): paginaAcceso,
   formularioLogin, cabeceraBuzon y paginaBuzon se parametrizan
   SOLO para que la variante VACÍA de (A) tenga su propio
   aterrizaje, cuyo menú «Mis notificaciones» lleva a la cáscara
   vacía — en el portal real el menú y la dirección directa son
   EL MISMO destino, y desde la 2.9.0 el pasillo va primero por
   el camino humano (clic del menú): con el aterrizaje único de
   antes, la corrida «vacía» leía la bandeja con filas a la que
   el menú compartido lleva, y la variante dejaba de probar el
   vacío. Ninguna aserción cambia. */
const paginaAcceso = (fiel = '/acceso-fiel') => `<!DOCTYPE html><html><body>
  <h1>Acceso por contraseña</h1>
  <a id="buttonFiel" href="${fiel}">Acceso con e.firma</a>
</body></html>`;
const formularioLogin = (destino = '/buzon') => `<!DOCTYPE html><html><body>
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
   la CABECERA: el botón «Mis expedientes» despliega «Mis
   documentos», «Mis notificaciones» y «Mis comunicados». */
const cabeceraBuzon = (hrefNotificaciones = '/iniciar-expediente/mis-notificaciones/') => `
  <header>
    <span>BUZÓN TRIBUTARIO</span>
    <button id="btn-expedientes" type="button">Mis expedientes</button>
    <nav id="menu-expedientes" style="display:none">
      <a href="#" data-nav="documentos">Mis documentos</a>
      <a href="${hrefNotificaciones}">Mis notificaciones</a>
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
  </script>`;
const paginaBuzon = (hrefNotificaciones) =>
  `<!DOCTYPE html><html><body>${cabeceraBuzon(hrefNotificaciones)}<main></main></body></html>`;
/* La página de Mis notificaciones: cáscara con cabecera y el
   IFRAME central donde vive la bandeja (tarda en cargar: el
   servidor retiene la respuesta del marco). */
const cáscaraNotificaciones = (marco) => `<!DOCTYPE html><html><body>${cabeceraBuzon()}
  <main><iframe id="marco-bandeja" src="${marco}"></iframe></main>
</body></html>`;
const marcoNotificaciones = `<!DOCTYPE html><html><body>
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
const marcoNotificacionesVacia = `<!DOCTYPE html><html><body>
  <p>Destinatario: ${RFC}</p>
  <p>Total de notificaciones pendientes: 0</p>
  <p>No se encontraron resultados</p>
</body></html>`;
const cáscaraComunicados = `<!DOCTYPE html><html><body>${cabeceraBuzon()}
  <main><iframe id="marco-comunicados" src="/marco-comunicados"></iframe></main>
</body></html>`;
const marcoComunicados = `<!DOCTYPE html><html><body>
  <h2>Mensajes no leídos (2)</h2>
  <p><a href="/abrir-mensaje/1">Aviso de actualización de datos</a></p>
  <p><a href="/abrir-mensaje/2">Recordatorio de obligaciones</a></p>
  <h2>Mensajes leídos (7)</h2>
  <p><a href="/abrir-mensaje/3">Comunicado anterior</a></p>
</body></html>`;
/* El formulario Fiel del acceso (D): el RFC es readonly — la
   página lo deriva de su JS al adjuntar el certificado — en
   dos variantes: solo a la SEGUNDA adjunción, o nunca. */
const formularioFiel201 = ({ segunda }) => `<!DOCTYPE html><html><body>
  <h1>SAT Autenticación</h1>
  <form id="certform">
    <input type="text" id="txtCertificate">
    <input type="file" id="fileCertificate" style="display:none">
    <input type="text" id="txtPrivateKey">
    <input type="file" id="filePrivateKey" style="display:none">
    <input type="password" id="privateKeyPassword">
    <input type="text" id="rfc" readonly>
    <div id="divError" style="display:none"></div>
    <button type="button" id="submit">Acceder</button>
  </form>
  <script>
    window.__envios = 0; window.__adjuntos = 0;
    document.getElementById('fileCertificate').addEventListener('change', () => {
      window.__adjuntos += 1;
      fetch('/ping-adjunto').catch(() => {});
      setTimeout(() => { document.getElementById('txtCertificate').value = 'certificado.cer'; }, 200);
      ${segunda ? "if (window.__adjuntos >= 2) setTimeout(() => { document.getElementById('rfc').value = '" + RFC + "'; }, 400);" : ''}
    });
    document.getElementById('filePrivateKey').addEventListener('change', () => {
      setTimeout(() => { document.getElementById('txtPrivateKey').value = 'llave.key'; }, 200);
    });
    document.getElementById('submit').addEventListener('click', () => {
      window.__envios += 1;
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
      location.href = '/dentro';
    });
  </script>
</body></html>`;
/* La ruta viva de Declaraciones (E), RÉPLICA según el mapa —
   no página capturada: declaraciones-pm con su pestaña y su
   acordeón, la puerta loginda con su botón «e.firma», el
   formulario NIDP con el RFC DESHABILITADO (lo deriva el
   portal al adjuntar el certificado) y la plataforma con el
   tipo RESICO PM y su consulta de presentadas. */
const paginaDeclaracionesPm = `<!DOCTYPE html><html><body>
  <h1>Declaraciones</h1>
  <button type="button" id="tab-prov">Provisionales y definitivas</button>
  <button type="button" id="acordeon">Pagos de ISR, IVA, Retenciones por salarios y asimilados e IVA Nueva plataforma</button>
  <div id="panel-acordeon" style="display:none">
    <a href="/puerta-loginda">Ingresa al servicio</a>
  </div>
  <script>
    document.getElementById('acordeon').addEventListener('click', () => {
      document.getElementById('panel-acordeon').style.display = 'block';
    });
  </script>
</body></html>`;
const puertaLoginda = `<!DOCTYPE html><html><body>
  <h1>Acceso por contraseña</h1>
  <form id="ciecform">
    <input type="text" id="rfc">
    <input type="password" id="password">
    <input type="submit" id="submit" value="Enviar">
  </form>
  <a id="buttonFiel" href="/fiel-loginda">e.firma</a>
</body></html>`;
const formularioLoginda = `<!DOCTYPE html><html><body>
  <h1>SAT Autenticación</h1>
  <form id="certform">
    <input type="text" id="txtCertificate">
    <input type="file" id="fileCertificate" style="display:none">
    <input type="text" id="txtPrivateKey">
    <input type="file" id="filePrivateKey" style="display:none">
    <input type="password" id="privateKeyPassword">
    <input type="text" id="rfc" disabled>
    <div id="divError" style="display:none"></div>
    <button type="button" id="submit">Acceder</button>
  </form>
  <script>
    document.getElementById('fileCertificate').addEventListener('change', () => {
      setTimeout(() => { document.getElementById('txtCertificate').value = 'certificado.cer'; }, 200);
      setTimeout(() => { document.getElementById('rfc').value = '${RFC}'; }, 600);
    });
    document.getElementById('filePrivateKey').addEventListener('change', () => {
      setTimeout(() => { document.getElementById('txtPrivateKey').value = 'llave.key'; }, 200);
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
      location.href = '/plataforma-dyp';
    });
  </script>
</body></html>`;
const plataformaDyp = `<!DOCTYPE html><html><body>
  <h1>Declaraciones y Pagos</h1>
  <ul>
    <li>ISR Régimen Simplificado de Confianza. Personas morales.</li>
    <li>ISR Personas Morales</li>
    <li>IVA</li>
  </ul>
  <nav><a href="/portal-nuevo">Nuevo portal de pagos provisionales</a></nav>
</body></html>`;
/* El portal NUEVO (réplica del mapa vivo completo del 16 nov
   2026, 15:56–16:04 — no página capturada): cabecera con el
   RFC, menú «Consultas» que hay que CLICAR y su «De la
   declaración», cuyo formulario pide el Ejercicio (SOLO
   2022–2026) con la Periodicidad que habilita el Periodo, y
   lista el año entero con el «Generar PDF» de cada fila = su
   acuse. Una fila es el dato real de hoy: octubre-2026,
   operación 262620289089, presentada el 10/11/2026. */
const portalNuevo = `<!DOCTYPE html><html><body>
  <header>RFC: ${RFC} | MANO FIL SA</header>
  <h1>Declaración Provisional o Definitiva de Impuestos Federales</h1>
  <button type="button" id="menu-consultas">Consultas</button>
  <nav id="submenu-consultas" style="display:none">
    <a href="/Consulta/Consulta?tipoDocumento=1">De la declaración</a>
    <a href="#">Por obligación</a>
    <a href="#">Declaraciones pagadas</a>
    <a href="#">Acuse de recibo</a>
  </nav>
  <script>
    document.getElementById('menu-consultas').addEventListener('click', () => {
      document.getElementById('submenu-consultas').style.display = 'block';
    });
  </script>
</body></html>`;
const consultaNueva = `<!DOCTYPE html><html><body>
  <header>RFC: ${RFC} | MANO FIL SA</header>
  <h1>Consulta de la declaración</h1>
  <form>
    <input type="text" id="rfc" value="${RFC}" readonly>
    <select id="Declaracion"><option>Provisionales y Definitivas de Impuestos Federales</option></select>
    <select id="Tipo"><option>Normal</option><option>Complementaria</option>
      <option>Complementaria por corrección fiscal</option></select>
    <select id="Ejercicio"><option value="">Seleccione</option><option>2022</option><option>2023</option>
      <option>2024</option><option>2025</option><option>2026</option></select>
    <select id="Periodicidad"><option value="">Seleccione</option><option value="1">1-Mensual</option>
      <option value="3">3-Trimestral</option><option value="5">5-Semestral</option></select>
    <select id="Periodo" disabled><option value="">Seleccione</option><option>Octubre</option></select>
    <button type="button" id="buscar">Consultar</button>
  </form>
  <div id="resultados" style="display:none">
    <table>
      <thead><tr><th>Fecha de Presentación</th><th>Tipo</th><th>Periodo</th><th>No. de Operación</th><th>Línea de Captura</th><th>Acuse</th></tr></thead>
      <tbody>
        <tr><td>10/11/2026</td><td>Normal</td><td>Octubre</td><td>262620289089</td><td>LC-2026-001</td>
          <td><a href="/acuse-nuevo.pdf?op=262620289089">Generar PDF</a></td></tr>
        <tr><td>17/10/2026</td><td>Normal</td><td>Septiembre</td><td>262620111222</td><td>LC-2026-002</td>
          <td><a href="/acuse-nuevo.pdf?op=262620111222">Generar PDF</a></td></tr>
        <tr><td>05/04/2026</td><td>Complementaria</td><td>Febrero</td><td>262620333444</td><td></td>
          <td><a href="/acuse-nuevo.pdf?op=262620333444">Generar PDF</a></td></tr>
      </tbody>
    </table>
  </div>
  <script>
    document.getElementById('Periodicidad').addEventListener('change', () => {
      document.getElementById('Periodo').disabled = false;
    });
    document.getElementById('buscar').addEventListener('click', () => {
      document.getElementById('resultados').style.display = 'block';
    });
  </script>
</body></html>`;
const pdfDeOp = (op) => Buffer.concat([Buffer.from('%PDF-1.4 acuse-' + op + '\n'),
  Buffer.alloc(1024, 0x2e), Buffer.from('\n%%EOF')]);

const RETRASO_MARCO_MS = 1800;
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  rutasPedidas.push(path);
  if (path.startsWith('/abrir/') || path.startsWith('/abrir-mensaje/') || path === '/contador-apertura') {
    aperturas += 1;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!DOCTYPE html><html><body><h1>Detalle abierto</h1></body></html>');
    return;
  }
  if (path === '/ping-adjunto') { adjuntosCert += 1; res.writeHead(204); res.end(); return; }
  if (path === '/acuse-nuevo.pdf') {
    const op = new URL(req.url, 'http://x').searchParams.get('op') || '';
    res.writeHead(200, { 'content-type': 'application/pdf',
      'content-disposition': 'attachment; filename="acuse-' + op + '.pdf"' });
    res.end(pdfDeOp(op));
    return;
  }
  const conRetraso = {
    '/marco-notificaciones': marcoNotificaciones,
    '/marco-notificaciones-vacia': marcoNotificacionesVacia,
    '/marco-comunicados': marcoComunicados
  };
  if (conRetraso[path]) {
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(conRetraso[path]);
    }, path === '/marco-comunicados' ? 500 : RETRASO_MARCO_MS);
    return;
  }
  const rutas = {
    '/acceso': paginaAcceso(),
    '/acceso-fiel': formularioLogin(),
    '/buzon': paginaBuzon(),
    '/acceso-vacia': paginaAcceso('/acceso-fiel-vacia'),
    '/acceso-fiel-vacia': formularioLogin('/buzon-vacia'),
    '/buzon-vacia': paginaBuzon('/iniciar-expediente/mis-notificaciones-vacia/'),
    '/iniciar-expediente/mis-notificaciones/': cáscaraNotificaciones('/marco-notificaciones'),
    '/iniciar-expediente/mis-notificaciones-vacia/': cáscaraNotificaciones('/marco-notificaciones-vacia'),
    '/iniciar-expediente/mis-comunicados/': cáscaraComunicados,
    '/fiel-segunda': formularioFiel201({ segunda: true }),
    '/fiel-nunca': formularioFiel201({ segunda: false }),
    '/dentro': '<!DOCTYPE html><html><body><h1>Dentro del portal</h1></body></html>',
    '/declaraciones-pm': paginaDeclaracionesPm,
    '/puerta-loginda': puertaLoginda,
    '/fiel-loginda': formularioLoginda,
    '/plataforma-dyp': plataformaDyp,
    '/portal-nuevo': portalNuevo,
    '/Consulta/Consulta': consultaNueva
  };
  const html = rutas[path];
  if (!html) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const BASE = 'http://127.0.0.1:' + server.address().port;

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KEY_PORTAL = privateKey.export({ type: 'pkcs8', format: 'der',
  cipher: 'des-ede3-cbc', passphrase: 'pw-de-juguete' });
const CER = Buffer.from('certificado-de-juguete');
const resolverReal = async (profile) => ({ rfc: profile.rfc, cer: CER, key: KEY_PORTAL,
  password: 'pw-de-juguete' });
const resolverSimple = async (profile) => ({ rfc: profile.rfc, cer: CER,
  key: Buffer.from('llave-de-juguete'), password: 'pw-de-juguete' });

/* ===== (A) Buzón contra el mapa real: iframe tardío, tabla
   real, comunicados por conteo y cero aperturas ===== */
{
  const tribCon = (entryUrl, loginUrl = BASE + '/acceso') => createSatTribFetch({ resolveCredentials: resolverReal,
    launchDriver: createPlaywrightDriverFactory({ executablePath: CHROME, headless: true }),
    entryUrl, loginUrl,
    comunicadosUrl: BASE + '/iniciar-expediente/mis-comunicados/', esperaBandejaMs: 12_000 });
  const pasos = [];
  const lista = await tribCon(BASE + '/iniciar-expediente/mis-notificaciones/')(
    { rfc: RFC }, {}, { onStep: (paso, detalle) => pasos.push({ paso, detalle }) });
  assert.equal(lista.notifications.length, 2, 'la bandeja real trae sus 2 pendientes');
  assert.deepEqual(lista.notifications.map(n => n.folio), ['F-100', 'F-101'],
    'cada fila lleva el Folio del acto administrativo');
  assert.equal(lista.notifications[0].fecha, '2026-11-10', 'fecha ← Fecha de aviso, normalizada');
  assert.equal(lista.notifications[0].asunto, 'Requerimiento de información', 'asunto ← Acto administrativo');
  assert.equal(lista.notifications[0].remitente, 'Auditoría', 'remitente ← Autoridad emisora');
  assert.equal(lista.notifications[0].abierta, false, 'la lista es la de pendientes: sin abrir');
  assert.equal(lista.notifications[0].estado, 'Pendiente');
  assert.equal(lista.comunicadosNoLeidos, 2, 'el conteo de comunicados viaja en el resultado');
  assert.ok(pasos.some(p => p.paso === 'Esperando la bandeja del portal…'),
    'la espera del iframe dejó su paso de progreso: ' + pasos.map(p => p.paso).join(' | '));
  assert.ok(pasos.some(p => p.paso === 'Comunicados leídos'),
    'el tramo de comunicados quedó en el diario');
  assert.equal(aperturas, 0, 'cero aperturas: ni notificaciones ni mensajes se abrieron');
  console.log('OK 2.0.1 · A — Buzón (mapa real): iframe esperado, tabla real con folio, comunicados por conteo, cero aperturas.');

  /* La variante VACÍA probada: éxito con 0 filas. (2.9.0: la
     corrida entra por su propio acceso y aterrizaje, cuyo menú
     lleva a la cáscara vacía — como en el portal real, donde el
     menú y la dirección directa son el mismo destino; ver la
     nota de fixture junto a paginaAcceso.) */
  const pasosVacia = [];
  const vacia = await tribCon(BASE + '/iniciar-expediente/mis-notificaciones-vacia/', BASE + '/acceso-vacia')(
    { rfc: RFC }, {}, { onStep: (paso, detalle) => pasosVacia.push({ paso, detalle }) });
  assert.deepEqual(vacia.notifications, [], '«No se encontraron resultados» con Total 0 = éxito con 0 filas');
  assert.equal(vacia.comunicadosNoLeidos, 2, 'y el conteo de comunicados también se lee en la variante vacía');
  assert.equal(aperturas, 0, 'la variante vacía tampoco abrió nada');
  console.log('OK 2.0.1 · A-vacía — Buzón: la bandeja vacía probada es un éxito con 0 filas, distinguible de «no cargó».');
}

/* ===== (B1) Sesión reutilizada ya muerta: fallo rápido ===== */
{
  class PaginaMuertaFalsa {
    constructor() {
      this.currentUrl = 'https://wwwmat.sat.gob.mx/app/seg/null';
      this.gotos = 0; this.clics = 0;
    }
    url() { return this.currentUrl; }
    async goto() { this.gotos += 1; }
    async text() { return 'Página no encontrada'; }
    async evaluate() { return 'Página no encontrada'; }
    async diagnostics() { return { url: this.currentUrl, html: HTML404, screenshot: null }; }
    async clickText() { this.clics += 1; return false; }
    async clickTextExactoVisible() { this.clics += 1; return false; }
  }
  const page = new PaginaMuertaFalsa();
  let lanzamientos = 0;
  const pasos = [];
  const trib = createSatTribFetch({ resolveCredentials: resolverSimple,
    launchDriver: async () => { lanzamientos += 1; throw new Error('con sesión viva no se lanza navegador'); } });
  const error = await trib({ rfc: RFC }, {}, { sesionViva: { page },
    onStep: (paso, detalle) => pasos.push({ paso, detalle }) }).then(() => null, e => e);
  assert.ok(error instanceof SatDocError, 'la sesión muerta es un error del motor, no un paseo por la 404');
  assert.equal(error.code, 'ruta-muerta', 'se clasifica ruta-muerta');
  assert.ok(error.message.includes('/app/seg/null'), 'el mensaje nombra la URL muerta: ' + error.message);
  assert.ok(pasos.some(p => p.paso === 'la sesión reutilizada quedó en la página muerta del portal; se descarta'),
    'el diario lleva el paso claro de descarte: ' + pasos.map(p => p.paso).join(' | '));
  assert.equal(page.gotos, 0, 'no se navegó a ningún sitio sobre la página muerta');
  assert.equal(page.clics, 0, 'no se clicó nada sobre la página muerta');
  assert.equal(lanzamientos, 0, 'no se lanzó navegador: la sesión era la reutilizada');
  console.log('OK 2.0.1 · B1 — Buzón: la sesión reutilizada que arranca en /app/seg/null falla rápido y se descarta, sin clicar ni navegar.');
}

/* ===== (B2) La captura de decisión muerta se reemplaza ===== */
{
  class PaginaDecisionFalsa {
    constructor() { this.etapa = 'portada'; this.diagCalls = 0; this.currentUrl = 'about:blank'; }
    url() { return this.etapa === 'bandeja'
      ? 'https://wwwmat.sat.gob.mx/iniciar-expediente/mis-notificaciones/'
      : 'https://wwwmat.sat.gob.mx/buzon'; }
    async goto(url) { if (String(url).includes('mis-notificaciones')) this.etapa = 'bandeja'; this.currentUrl = url; }
    async clickButtonFiel() {}
    async fillFielForm() { return { faltan: [] }; }
    async submitFiel() { this.etapa = 'portada'; }
    async divError() { return ''; }
    async text() { return this.etapa === 'bandeja'
      ? 'Buzón Tributario · Destinatario: ' + RFC + ' · Total de notificaciones pendientes: 0 · No se encontraron resultados'
      : 'BUZÓN TRIBUTARIO · Mis expedientes'; }
    async evaluate(fn) {
      if (fn?.name === 'readAllTextSource') return this.text();
      if (fn?.name === 'readLinksSource') return [];
      if (fn?.name === 'readTablesSource') return [{ headers: ['Columna', 'Otra'], rows: [['x', 'y']] }];
      return '';
    }
    async diagnostics() {
      this.diagCalls += 1;
      if (this.diagCalls === 1) return { url: 'https://wwwmat.sat.gob.mx/app/seg/null', html: HTML404, screenshot: null };
      return { url: this.url(), html: '<html><body>Buzón Tributario — portada viva</body></html>', screenshot: null };
    }
  }
  const page = new PaginaDecisionFalsa();
  const trib = createSatTribFetch({ resolveCredentials: resolverSimple,
    launchDriver: async () => ({ newPage: async () => page, close: async () => {} }),
    entryUrl: 'https://wwwmat.sat.gob.mx/iniciar-expediente/mis-notificaciones/',
    loginUrl: 'https://portal.test/acceso', esperaBandejaMs: 4_000,
    comunicadosUrl: 'https://wwwmat.sat.gob.mx/iniciar-expediente/mis-comunicados/' });
  const resultado = await trib({ rfc: RFC }, {});
  assert.deepEqual(resultado.notifications, [], 'la doble enseña la bandeja vacía probada y la corrida la acepta');
  console.log('OK 2.0.1 · B2 — Buzón: la corrida sobrevive a la primera captura muerta y lista la bandeja vacía de la doble.');

  /* Y si la corrida muere después, la decisión que viaja es
     la viva que reemplazó a la muerta. */
  class PaginaDecisionErrorFalsa extends PaginaDecisionFalsa {
    async evaluate(fn) {
      if (fn?.name === 'readAllTextSource') return this.etapa === 'bandeja'
        ? 'Buzón Tributario · Mis notificaciones · Asunto' : 'BUZÓN TRIBUTARIO · Mis expedientes';
      if (fn?.name === 'readLinksSource') return [];
      if (fn?.name === 'readTablesSource') return [{ headers: ['Columna', 'Otra'], rows: [['x', 'y']] }];
      return '';
    }
  }
  const page2 = new PaginaDecisionErrorFalsa();
  const trib2 = createSatTribFetch({ resolveCredentials: resolverSimple,
    launchDriver: async () => ({ newPage: async () => page2, close: async () => {} }),
    entryUrl: 'https://wwwmat.sat.gob.mx/iniciar-expediente/mis-notificaciones/',
    loginUrl: 'https://portal.test/acceso', esperaBandejaMs: 4_000,
    comunicadosUrl: 'https://wwwmat.sat.gob.mx/iniciar-expediente/mis-comunicados/' });
  const error = await trib2({ rfc: RFC }, {}).then(() => null, e => e);
  assert.ok(error instanceof SatDocError, 'sin tabla reconocible ni firma de vacío, la corrida cierra en error');
  assert.ok(error.diagDecision, 'viaja la página de decisión');
  assert.equal(buzonDiagEsMuerto(error.diagDecision), false,
    'la decisión que viaja NO es la 404: la captura muerta fue reemplazada por la portada viva');
  assert.ok(String(error.diagDecision.html).includes('portada viva'));
  assert.ok(page2.diagCalls >= 2, 'hubo captura de refresco que pudo reemplazar a la muerta');
  console.log('OK 2.0.1 · B2b — Buzón: la captura de decisión muerta se reemplaza por la viva; la 404 no envenena.');
}

/* ===== (C1) Transacciones: primero la 22513 directa ===== */
{
  class TxFakePage {
    constructor() { this.eventos = []; this.currentUrl = 'about:blank'; }
    async goto(url) { this.eventos.push('goto:' + url); this.currentUrl = url; }
    url() { return this.currentUrl; }
    async clickButtonFiel() {}
    async fillFielForm() { return { faltan: [] }; }
    async submitFiel() { this.currentUrl = 'https://ptscdecprov.clouda.sat.gob.mx/plataforma'; }
    async divError() { return ''; }
    async clickText(t) { this.eventos.push('clickText:' + t); return t === 'Consulta de transacciones'; }
    async clickTextSeguro(t) { this.eventos.push('clickSeguro:' + t); return t === 'Consulta de transacciones'; }
    async text() { return 'Declaraciones y Pagos'; }
    async tramiteFrameUrl() { return ''; }
    async selectSelector(sel, val) { this.eventos.push('select:' + sel + '=' + val); }
    async clickSelector(sel) { this.eventos.push('clickSelector:' + sel); }
    async transacciones() { return [{ cells: ['123456789012', '17/10/2026', 'Mensual', 'Septiembre', '2026'] }]; }
    async diagnostics() { return { url: this.currentUrl, html: '<html><body>Consulta de transacciones</body></html>', screenshot: null }; }
  }
  const page = new TxFakePage();
  const pasos = [];
  const fetchDecl = createSatDeclFetch({ resolveCredentials: resolverReal,
    launchDriver: async () => ({ newPage: async () => page, close: async () => {} }),
    onStep: (paso, detalle) => pasos.push({ paso, detalle }) });
  const result = await fetchDecl({ rfc: RFC }, { tipo: 'transacciones', ejercicio: 2026 });
  assert.equal(result.found, 1, 'la consulta lee la operación de la tabla 22513');
  assert.equal(result.transactions[0].operacion, '123456789012');
  assert.equal(result.transactions[0].periodo, '2026-09');
  const idxLogin = page.eventos.indexOf('goto:' + DECL_DEFAULTS.entryUrl);
  const idxDirecta = page.eventos.indexOf('goto:' + DECL_TRANSACCIONES_DEFAULTS.appUrl);
  assert.ok(idxLogin >= 0, 'hubo segundo acceso en loginda (entryUrl de la fábrica): ' + page.eventos.join(' | '));
  assert.ok(idxDirecta > idxLogin, 'la 22513 se pidió DESPUÉS del acceso, como ruta principal del tramo');
  const clicsDelTramo = page.eventos.slice(idxLogin, idxDirecta)
    .filter(e => e.startsWith('clickText:') || e.startsWith('clickSeguro:'));
  assert.deepEqual(clicsDelTramo, [], 'entre el acceso y la 22513 no hubo clics de portada: la directa es la ruta PRINCIPAL');
  assert.ok(pasos.some(p => p.paso === 'Plataforma de Declaraciones y Pagos'),
    'el aterrizaje se comprobó contra el host de la plataforma: ' + pasos.map(p => p.paso).join(' | '));
  console.log('OK 2.0.1 · C1 — Declaraciones: segundo acceso en loginda, aterrizaje en la plataforma y 22513 directa sin clics previos.');
}

/* ===== (C2) Portada-trampa: un clic mata la página ===== */
class TrampaPage {
  constructor(muertaDeInicio = false) {
    this.muerta = muertaDeInicio;
    this.currentUrl = muertaDeInicio ? 'https://wwwmat.sat.gob.mx/app/seg/null' : 'https://ptscdecprov.clouda.sat.gob.mx/plataforma';
    this.clics = [];
  }
  url() { return this.currentUrl; }
  async goto(url) { this.currentUrl = url; }
  async text() { return this.muerta ? 'Página no encontrada' : 'Declaraciones y Pagos · Servicios Disponibles'; }
  registrar(t) {
    this.clics.push(t);
    this.muerta = true;
    this.currentUrl = 'https://wwwmat.sat.gob.mx/app/seg/null';
    return true;
  }
  async clickText(t) { return this.registrar(t); }
  async clickTextSeguro(t) { return this.registrar(t); }
  async tramiteFrameUrl() { return ''; }
  async diagnostics() { return this.muerta
    ? { url: this.currentUrl, html: HTML404, screenshot: null }
    : { url: this.currentUrl, html: '<html><body>plataforma</body></html>', screenshot: null }; }
  async selectSelector() {}
  async clickSelector() {}
  async declResults() { return []; }
}
{
  const page = new TrampaPage(false);
  const pasos = [];
  const error = await fetchMensuales({ page, ejercicio: 2026,
    onStep: (paso, detalle) => pasos.push({ paso, detalle }) }).then(() => null, e => e);
  assert.ok(error instanceof SatDocError, 'el pasillo trampa cierra en error del motor');
  assert.equal(error.code, 'ruta-muerta', 'la página muerta se clasifica, no se disfraza de «enlace no encontrado»');
  assert.ok(error.message.includes('/app/seg/null'), 'el mensaje nombra la URL muerta: ' + error.message);
  assert.equal(page.clics.length, 1,
    'tras el clic que mató la página NO hubo clics posteriores: ' + page.clics.join(' | '));
  assert.ok(pasos.some(p => p.paso === 'Ruta muerta'), 'el diario registra el paso de ruta muerta');
  console.log('OK 2.0.1 · C2 — Declaraciones: la portada-trampa muere al primer clic, se detecta y se clasifica sin clicar a ciegas.');
}
{
  const page = new TrampaPage(true);
  const error = await fetchMensuales({ page, ejercicio: 2026 }).then(() => null, e => e);
  assert.ok(error instanceof SatDocError);
  assert.equal(error.code, 'ruta-muerta', 'con la página ya muerta al entrar, el llamador clasifica ruta-muerta');
  assert.equal(page.clics.length, 0, 'con la página ya muerta al entrar no se clica NADA');
  console.log('OK 2.0.1 · C2b — Declaraciones: página muerta al entrar al pasillo: cero clics y clasificación ruta-muerta.');
}

/* ===== (C3) La fábrica no adjunta una decisión muerta ===== */
{
  class Pagina404Falsa {
    constructor() { this.currentUrl = 'about:blank'; }
    async goto(url) { this.currentUrl = url; }
    url() { return this.currentUrl; }
    async clickButtonFiel() {}
    async fillFielForm() { return { faltan: [] }; }
    async submitFiel() { this.currentUrl = 'https://wwwmat.sat.gob.mx/app/seg/null'; }
    async divError() { return ''; }
    async clickText() { return false; }
    async clickTextSeguro() { return false; }
    async tramiteFrameUrl() { return ''; }
    async text() { return 'Página no encontrada'; }
    async diagnostics() { return { url: 'https://wwwmat.sat.gob.mx/app/seg/null', html: HTML404, screenshot: null }; }
    async selectSelector() {}
    async clickSelector() {}
    async declResults() { return []; }
    async transacciones() { return []; }
  }
  const page = new Pagina404Falsa();
  const fetchDecl = createSatDeclFetch({ resolveCredentials: resolverReal,
    launchDriver: async () => ({ newPage: async () => page, close: async () => {} }) });
  const error = await fetchDecl({ rfc: RFC }, { tipo: 'mensual', ejercicio: 2026 }).then(() => null, e => e);
  assert.ok(error instanceof SatDocError);
  assert.equal(error.code, 'ruta-muerta');
  assert.ok(error.diag && String(error.diag.html).includes('Página no encontrada'),
    'la página FINAL (la 404) sí viaja en diag: es la evidencia del fallo');
  assert.ok(!error.diagDecision,
    'la «decisión» muerta NO viaja como diagDecision: el diario dirá honestamente que solo hay página final');
  console.log('OK 2.0.1 · C3 — Declaraciones: la fábrica deja diagDecision en null cuando la captura es la página muerta.');
}

/* ===== (D) Acceso con e.firma: reintentos del RFC y diag ===== */
{
  const driver = await createPlaywrightDriverFactory({ executablePath: CHROME, headless: true })();
  const page = await driver.newPage();
  const fillOriginal = page.fillFielForm.bind(page);
  const CER_D = Buffer.from('certificado-de-juguete');
  const KEY_D = Buffer.from('llave-de-juguete');
  const loginArgs = (entryUrl, pasos) => ({ cer: CER_D, key: KEY_D, password: 'pw-de-juguete',
    rfc: RFC, entryUrl, hooks: { step: (texto) => pasos.push(texto) } });
  try {
    adjuntosCert = 0;
    page.fillFielForm = (args) => fillOriginal({ ...args, esperaDerivadosMs: 2_500 });
    const pasosI = [];
    const result = await satBrowserLogin(page, loginArgs(BASE + '/fiel-segunda', pasosI));
    assert.equal(result.url, BASE + '/dentro', 'con la derivación re-disparada, el acceso entra');
    assert.ok(adjuntosCert >= 2,
      'el certificado se adjuntó al menos dos veces (la derivación se re-disparó): ' + adjuntosCert);
    assert.ok(pasosI.some(p => p.includes('vuelvo a adjuntar el certificado')),
      'la traza cuenta el re-disparo de la derivación: ' + pasosI.join(' | '));
    console.log('OK 2.0.1 · D-i — Acceso: el RFC readonly que solo deriva a la segunda adjunción completa el acceso.');

    page.fillFielForm = (args) => fillOriginal({ ...args, esperaDerivadosMs: 2_500 });
    const pasosII = [];
    const error = await satBrowserLogin(page, loginArgs(BASE + '/fiel-nunca', pasosII))
      .then(() => null, e => e);
    page.fillFielForm = fillOriginal;
    assert.ok(error instanceof SatDocError, 'el acceso imposible termina en error propio');
    assert.equal(error.code, 'respuesta-inesperada', 'no es portal-rechaza: el envío ni siquiera se produjo');
    assert.ok(error.message.includes('#rfc'), 'el error nombra el campo: ' + error.message);
    assert.ok(error.message.includes('ni reintentando el relleno'),
      'el mensaje honesto actualizado nombra los reintentos: ' + error.message);
    assert.ok(error.diag, 'el error de acceso lleva el diagnóstico adjunto (la promesa del diario ahora es verdad)');
    assert.ok(String(error.diag.html).includes('certform'),
      'el diag trae el HTML del formulario Fiel tal como quedó');
    assert.equal(await page.evaluate(() => window.__envios), 0,
      'el contador de envíos del formulario queda a CERO: nada se envió al SAT');
    assert.equal(await page.divError(), '', 'el portal nunca pintó su rechazo: no hubo envío');
    console.log('OK 2.0.1 · D-ii — Acceso: RFC inderivable: aborto sin enviar (envíos a cero) y error con diag del formulario.');
  } finally {
    await driver.close();
  }
}

/* ===== (E) Declaraciones por la ruta viva COMPLETA (réplica
   del mapa del 16 nov 2026, 15:56–16:04 — no página
   capturada): caminata pública → puerta loginda → plataforma
   clásica → salto al portal nuevo por su menú → «Consultas»
   con clic → «De la declaración» → consulta por ejercicio →
   el «Generar PDF» de cada fila baja su acuse ===== */
{
  const pasos = [];
  const fetchDecl = createSatDeclFetch({ resolveCredentials: resolverReal,
    launchDriver: createPlaywrightDriverFactory({ executablePath: CHROME, headless: true }),
    entryUrl: BASE + '/puerta-loginda', publicUrl: BASE + '/declaraciones-pm',
    onStep: (paso, detalle) => pasos.push({ paso, detalle }) });
  const result = await fetchDecl({ rfc: RFC }, { tipo: 'mensual', ejercicio: 2026 });
  assert.equal(result.found, 3, 'la consulta por ejercicio lista el año: 3 filas en la réplica');
  assert.equal(result.documents.length, 3, 'bajó el acuse de cada fila');
  assert.ok(result.documents.every(d => d.clase === 'acuse'),
    'cada documento es el acuse de su fila («Generar PDF»): la declaración misma no la ofrece esta consulta');
  const octubre = result.documents.find(d => d.operacion === '262620289089');
  assert.ok(octubre, 'la fila real de hoy está: octubre-2026, operación 262620289089');
  assert.equal(octubre.periodo, '2026-10', 'el periodo se normaliza desde el nombre del mes');
  assert.equal(octubre.fechaPresentacion, '10/11/2026', 'con su fecha de presentación');
  assert.equal(octubre.tipoPresentacion, 'Normal');
  assert.deepEqual(octubre.content, pdfDeOp('262620289089'), 'el PDF bajado es el acuse de ESA operación');
  const complementaria = result.documents.find(d => d.tipoPresentacion === 'Complementaria');
  assert.ok(complementaria && complementaria.periodo === '2026-02',
    'la complementaria de febrero viaja con su tipo y su periodo');
  assert.ok(pasos.some(p => p.paso === 'Ruta pública de declaraciones'),
    'la caminata pública quedó en el diario: ' + pasos.map(p => p.paso).join(' | '));
  assert.ok(pasos.some(p => p.paso === 'Acceso al portal OK'),
    'el segundo acceso en loginda quedó en el diario');
  assert.ok(pasos.some(p => p.paso === 'Portal nuevo de pagos provisionales'),
    'el salto al portal nuevo quedó en el diario');
  assert.ok(pasos.some(p => p.paso === 'Consulta «De la declaración»'),
    'la consulta del portal nuevo quedó en el diario');
  console.log('OK 2.0.1 · E — Declaraciones (ruta viva completa, réplica): loginda → clásica → portal nuevo → «De la declaración» → acuses por «Generar PDF».');
}

/* ===== (E2) Ejercicio anterior a 2022: dicho en llano ===== */
{
  class PaginaMinima {
    async text() { return 'Declaraciones y Pagos'; }
    async diagnostics() { return { url: 'https://ptscdecprov.clouda.sat.gob.mx/',
      html: '<html><body>plataforma</body></html>', screenshot: null }; }
  }
  const error = await fetchMensuales({ page: new PaginaMinima(), ejercicio: 2021 })
    .then(() => null, e => e);
  assert.ok(error instanceof SatDocError);
  assert.equal(error.code, 'respuesta-inesperada');
  assert.ok(error.message.includes('solo cubre ejercicios desde 2022'),
    'el motor lo dice en llano: ' + error.message);
  console.log('OK 2.0.1 · E2 — Declaraciones: el ejercicio 2021 se nombra fuera del portal nuevo, sin pasear por la consulta clásica.');
}
server.close();

/* ===== Estáticas: versión 2.0.1 y cableado de la ronda ===== */
{
  const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.version, '2.9.16', 'la versión de la ronda es 2.0.1');
  assert.ok(pkg.scripts.test.includes('ronda201.test.mjs'), 'la suite de la ronda está en la batería');
  const ejecutor = readFileSync(new URL('./ejecutor-local.mjs', import.meta.url), 'utf8');
  assert.ok(ejecutor.includes("EJECUTOR_VERSION = '2.9.16'"), 'el ejecutor declara 2.0.1');
  assert.ok(ejecutor.includes('function diagDe(error)'),
    'el ejecutor propaga error.diag con diagDe (verificado, sin tocar su lógica)');
  const browser = readFileSync(new URL('./sat-doc-browser.mjs', import.meta.url), 'utf8');
  assert.ok(browser.includes('clickTextExactoVisible'), 'el driver ofrece el clic exacto visible');
  assert.ok(browser.includes('clickTextSeguro'), 'el driver ofrece el clic seguro de los pasillos');
  assert.ok(browser.includes('ni reintentando el relleno'), 'el mensaje de acceso nombra los reintentos');
  assert.ok(browser.includes('coincide'), 'la sonda verifica que el RFC del formulario es el del perfil (higiene DyP)');
  const trib = readFileSync(new URL('./sat-tributario.mjs', import.meta.url), 'utf8');
  assert.ok(trib.includes('Esperando la bandeja del portal…'), 'el Buzón espera al iframe de la bandeja con su paso');
  assert.ok(trib.includes('extractBuzonRowsReales'), 'el Buzón trae el extractor de la tabla real');
  assert.ok(trib.includes('comunicadosNoLeidos'), 'el Buzón emite el conteo de comunicados');
  assert.ok(trib.includes('la sesión reutilizada quedó en la página muerta del portal; se descarta'),
    'el Buzón falla rápido ante la sesión reutilizada muerta');
  const decl = readFileSync(new URL('./sat-declaraciones.mjs', import.meta.url), 'utf8');
  assert.ok(decl.includes('Ruta PRINCIPAL (2.0.1)'), 'la 22513 directa es la ruta principal de transacciones');
  assert.ok(decl.includes(DECL_PLATFORM_HOST) && DECL_PLATFORM_HOST === 'ptscdecprov.clouda.sat.gob.mx',
    'la plataforma esperada tras loginda es ptscdecprov.clouda.sat.gob.mx');
  assert.ok(decl.includes('loginda.siat.sat.gob.mx'), 'el segundo acceso de Declaraciones es en loginda');
  assert.ok(decl.includes('pstcdypisr.clouda.sat.gob.mx'), 'el pasillo salta al portal nuevo de pagos provisionales');
  assert.ok(decl.includes('De la declaración'), 'la consulta del pasillo es «De la declaración» del portal nuevo');
  assert.ok(decl.includes('solo cubre ejercicios desde 2022'), 'el motor dice en llano el suelo de 2022 del portal nuevo');
  console.log('OK 2.0.1 · estáticas — versión 2.0.1 (paquete y ejecutor), suite en la batería y cableado contra el mapa real.');
}

console.log('OK suite ronda201 completa');
