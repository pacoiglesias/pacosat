import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPlaywrightDriverFactory } from './sat-doc-browser.mjs';
import { createSatTribFetch } from './sat-tributario.mjs';

/* ================================================================
   Ronda 2.9.7 · Pieza D8 — «Mis documentos» del Buzón con
   reintento paciente.

   CONTEXTO (2.9.4, probado con la evidencia real): el lector
   de la sección reconoce «Mis documentos» por sus cinco
   DataTables (#tablaRespons, #tablaRespons2015,
   #tablaResponsIMSS, #tablaResponsEF, #tablaResponsLC)
   presentes en su marco (FormularioGenerico de
   tramitesdigitales.sat.gob.mx) con filas o con su marca de
   vacío. En vivo el marco a veces llega SIN RENDERIZAR dentro
   del plazo (flakiness del SAT) y la sección quedaba «sin
   listar» al primer intento, aunque una recarga la habría
   traído.

   EL ARREGLO (esta pieza): cuando el reconocimiento concluye
   que el marco llegó sin renderizar (ni tablas ni marca de
   vacío — la misma señal que producía el «sin listar»), la
   corrida NO se rinde: recarga la sección (volver a navegar
   a su ruta, el camino ya construido) hasta 2 veces más —
   3 intentos en total — DENTRO del plazo total existente de
   la sección (los intentos comparten el presupuesto; el
   plazo de la corrida no crece). Cada reintento queda en los
   pasos («Mis documentos no cargó a la primera; lo intento
   otra vez (2 de 3)…»). La evidencia guardada es la del
   ÚLTIMO intento. Si al tercero sigue sin renderizar, la
   salida es la honesta de siempre: «sin listar» con su
   motivo (marco sin renderizar tras 3 intentos) — nunca un
   cero fingido. Las demás secciones no cambian.

   CASOS (arnés y fixtures reales de ronda294buzon):
   A · El marco renderiza al 2º intento (la página falsa
       sirve primero la fixture real sin renderizar y después
       la de tablas) → la sección concluye LISTADA con las
       filas de la fixture y los pasos registran el reintento.
       Contra el código anterior concluye «sin listar» (rojo).
   B · Renderiza al 3º intento → listada, con los dos
       reintentos en los pasos.
   C · Nunca renderiza → «sin listar» honesto con 3 intentos
       registrados, motivo «tras 3 intentos» y la evidencia
       del ÚLTIMO intento (la página falsa marca el tercer
       marco con un texto que solo él trae).
   D · Renderiza a la primera → comportamiento idéntico al
       actual: listada y SIN ningún paso de reintento.
   E · La bandeja y los comunicados de la misma corrida (la
       del caso A, con reintento de documentos, y la del C,
       con los tres intentos agotados) no se ven afectados:
       bandeja vacía leída y comunicados concluyentes con su
       lista real, y cero aperturas/invocaciones.

   REGLA LEGAL DURA, intacta: jamás se abre una notificación,
   un comunicado ni un documento.
   ================================================================ */

const AQUI = dirname(fileURLToPath(import.meta.url));
const RFC = 'MFI6212158B4';

const marcoDe = nombre => {
  const compuesto = readFileSync(join(AQUI, 'fixtures', nombre), 'utf8');
  const corte = compuesto.indexOf('<!-- ===== MARCO');
  assert.ok(corte >= 0, 'el fixture ' + nombre + ' trae su marcador de marco');
  return compuesto.slice(compuesto.indexOf('===== -->', corte) + '===== -->'.length);
};
const MARCO_COM_REAL = marcoDe('buzon-comunicados-real.html');
const MARCO_DOC_REAL = marcoDe('buzon-documentos-real.html');
const MARCO_DOC_TABLAS = readFileSync(join(AQUI, 'fixtures', 'buzon-documentos-tablas.html'), 'utf8');
const servirLocal = html => html.replace(/https:\/\/fonts\.googleapis\.com[^"]*/g, '/vacio.css');
/* La marca del ÚLTIMO intento del caso C: el mismo marco sin
   renderizar, con un texto visible que solo sirve la tercera
   carga — si la evidencia guardada lo trae, es la del último
   intento y no la de ninguno anterior. */
const MARCO_DOC_FINAL_C = MARCO_DOC_REAL.replace('</body>',
  '<p>INTENTO-FINAL-C-297</p></body>');

const ITEMS_TABLAS = [
  { fecha: '2026-01-15', nombre: 'Documento de prueba 294-A', estado: 'Vigente' },
  { fecha: '2026-03-20', nombre: 'Documento de prueba 294-B', estado: 'Concluido' },
  { fecha: '2026-04-02', nombre: 'Línea de prueba 294', estado: 'Pendiente' }];

/* ================================================================
   Motor con Chromium real (patrón de ronda294buzon)
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
assert.ok(CHROME, 'ronda297documentos necesita un Chromium local para la réplica: ' +
  'sin navegador la prueba que puede fallar no puede correr.');

let aperturas = 0;
let invocaciones = 0;
const docHits = { a: 0, b: 0, c: 0, d: 0 };
const bandejaVacia297 = `<!DOCTYPE html><html><body>
  <p>Destinatario: ${RFC}</p>
  <p>Total de notificaciones pendientes: 0</p>
  <p>No se encontraron resultados</p>
</body></html>`;
const MENSAJES_TRAMPA297 = `
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
  if (path === '/bandeja') return servir(bandejaVacia297, 400);
  if (path === '/comunicados-real') return servir(servirLocal(MARCO_COM_REAL), 400);
  /* Los marcos de documentos, por caso: cada CARGA del marco
     cuenta un intento — la primera navegación y cada recarga
     de la sección pasan por aquí. */
  if (path === '/doc-a') { docHits.a += 1; return servir(servirLocal(docHits.a >= 2 ? MARCO_DOC_TABLAS : MARCO_DOC_REAL), 300); }
  if (path === '/doc-b') { docHits.b += 1; return servir(servirLocal(docHits.b >= 3 ? MARCO_DOC_TABLAS : MARCO_DOC_REAL), 300); }
  if (path === '/doc-c') { docHits.c += 1; return servir(servirLocal(docHits.c >= 3 ? MARCO_DOC_FINAL_C : MARCO_DOC_REAL), 300); }
  if (path === '/doc-d') { docHits.d += 1; return servir(servirLocal(MARCO_DOC_TABLAS), 300); }
  if (path === '/scripts/mensajes.js') return servir(MENSAJES_TRAMPA297, 0, 'text/javascript');
  if (path.endsWith('.js') || path.includes('.axd')) return servir('', 0, 'text/javascript');
  if (path.endsWith('.css') || path === '/vacio.css') return servir('', 0, 'text/css');
  res.writeHead(404); res.end();
});
await new Promise(resolve => serverMarcos.listen(0, '127.0.0.1', resolve));
const ORIGEN2 = 'http://127.0.0.1:' + serverMarcos.address().port;

const paginaAcceso297 = (fiel) => `<!DOCTYPE html><html><body>
  <h1>Acceso por contraseña</h1>
  <a id="buttonFiel" href="${fiel}">Acceso con e.firma</a>
</body></html>`;
const formularioLogin297 = (destino) => `<!DOCTYPE html><html><body>
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
const cabeceraOk297 = (destinoNotificaciones, hrefComunicados) => `
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
const paginaBuzon297 = (destinoNotificaciones, hrefComunicados) =>
  `<!DOCTYPE html><html><body>${cabeceraOk297(destinoNotificaciones, hrefComunicados)}<main></main></body></html>`;
const cascara297 = (cabecera, marco) =>
  `<!DOCTYPE html><html><body>${cabecera}
  <main><iframe id="iframetoload" src="${marco}"></iframe></main>
</body></html>`;

const R = (x, que) => '/iniciar-expediente/mis-' + que + '-' + x + '/';
const CASOS = ['a', 'b', 'c', 'd'];
const rutasPortal = {};
for (const x of CASOS) {
  rutasPortal['/acceso-' + x] = paginaAcceso297('/acceso-fiel-' + x);
  rutasPortal['/acceso-fiel-' + x] = formularioLogin297('/buzon-' + x);
  rutasPortal['/buzon-' + x] = paginaBuzon297(R(x, 'notificaciones'), R(x, 'comunicados'));
  rutasPortal[R(x, 'notificaciones')] = cascara297(
    cabeceraOk297(R(x, 'notificaciones'), R(x, 'comunicados')), ORIGEN2 + '/bandeja');
  rutasPortal[R(x, 'comunicados')] = cascara297(
    cabeceraOk297(R(x, 'notificaciones'), R(x, 'comunicados')), ORIGEN2 + '/comunicados-real');
  rutasPortal[R(x, 'documentos')] = cascara297(
    cabeceraOk297(R(x, 'notificaciones'), R(x, 'comunicados')), ORIGEN2 + '/doc-' + x);
}
const serverPortal = createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  const html = rutasPortal[path];
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
/* El plazo de la sección: esperaBandejaMs 9 000 ⇒ el plazo
   total de «Mis documentos» es min(9 000, 30 000) = 9 s, que
   los tres intentos COMPARTEN (~3 s por intento): la corrida
   no tarda más que antes por reintentar. */
const tribPara297 = (x) => createSatTribFetch({ resolveCredentials: resolverReal,
  launchDriver: createPlaywrightDriverFactory({ executablePath: CHROME, headless: true }),
  entryUrl: ORIGEN1 + R(x, 'notificaciones'), loginUrl: ORIGEN1 + '/acceso-' + x,
  comunicadosUrl: ORIGEN1 + R(x, 'comunicados'),
  documentosUrl: ORIGEN1 + R(x, 'documentos'), esperaBandejaMs: 9_000 });
const correr297 = async (trib) => {
  const pasos = [];
  const aperturasAntes = aperturas;
  const invocacionesAntes = invocaciones;
  const salida = await trib({ rfc: RFC }, {},
    { onStep: (paso, detalle) => pasos.push({ paso, detalle }) })
    .then(resultado => ({ resultado }), error => ({ error }));
  return { ...salida, pasos,
    aperturas: aperturas - aperturasAntes, invocaciones: invocaciones - invocacionesAntes };
};
const pasosReintento = (caso) => caso.pasos.filter(p => /lo intento otra vez/.test(p.paso));

/* ===== A · Renderiza al 2º intento → listada, con su reintento ===== */
const casoA = await correr297(tribPara297('a'));
{
  assert.ok(casoA.resultado, 'A: la corrida concluye: ' +
    (casoA.error ? casoA.error.code + ' — ' + casoA.error.message : 'sin error'));
  const doc = casoA.resultado.documentos;
  assert.equal(doc?.concluyente, true,
    'A: el marco renderiza al 2º intento y la sección concluye LISTADA ' +
    '(contra el código anterior salía «sin listar» al primer intento)');
  assert.deepEqual(doc.items, ITEMS_TABLAS,
    'A: la lista es la de la fixture de tablas, leída en el segundo intento');
  const reintentos = pasosReintento(casoA);
  assert.equal(reintentos.length, 1, 'A: exactamente un reintento registrado en los pasos');
  assert.ok(reintentos[0].paso.includes('(2 de 3)'),
    'A: el paso nombra el intento: ' + reintentos[0].paso);
  assert.ok(docHits.a >= 2, 'A: el marco se cargó al menos dos veces (carga + recarga): ' + docHits.a);
  assert.equal(casoA.aperturas, 0, 'A: cero aperturas');
  console.log('OK 2.9.7 · D8-A — Documentos: sin renderizar a la primera, recarga y lista al 2º intento con las filas de la fixture; el reintento queda en los pasos.');
}

/* ===== E (sobre la corrida A) · Las demás secciones, intactas ===== */
{
  assert.deepEqual(casoA.resultado.notifications, [], 'E: la bandeja vacía se lee igual que siempre');
  const com = casoA.resultado.comunicados;
  assert.equal(com?.concluyente, true, 'E: comunicados concluye en la misma corrida del reintento');
  assert.equal(casoA.resultado.comunicadosNoLeidos, 2, 'E: 2 sin leer, los del portal real');
  assert.equal(com.items?.length, 9, 'E: la lista entera de comunicados, 9, sin abrir ninguno');
  assert.equal(casoA.invocaciones, 0, 'E: cero invocaciones a VerMsg/ComunicadoVisualizado');
  console.log('OK 2.9.7 · D8-E — La bandeja y los comunicados de la corrida con reintento no se ven afectados.');
}

/* ===== B · Renderiza al 3º intento → listada ===== */
{
  const caso = await correr297(tribPara297('b'));
  assert.ok(caso.resultado, 'B: la corrida concluye: ' +
    (caso.error ? caso.error.code + ' — ' + caso.error.message : 'sin error'));
  const doc = caso.resultado.documentos;
  assert.equal(doc?.concluyente, true, 'B: al tercer intento la sección concluye LISTADA');
  assert.deepEqual(doc.items, ITEMS_TABLAS, 'B: la lista es la de la fixture de tablas');
  const reintentos = pasosReintento(caso);
  assert.equal(reintentos.length, 2, 'B: los dos reintentos quedan registrados en los pasos');
  assert.ok(reintentos[0].paso.includes('(2 de 3)') && reintentos[1].paso.includes('(3 de 3)'),
    'B: los pasos nombran cada intento: ' + reintentos.map(r => r.paso).join(' | '));
  assert.ok(docHits.b >= 3, 'B: el marco se cargó al menos tres veces: ' + docHits.b);
  assert.equal(caso.aperturas, 0, 'B: cero aperturas');
  console.log('OK 2.9.7 · D8-B — Documentos: lista al 3º intento, con los reintentos (2 de 3) y (3 de 3) en los pasos.');
}

/* ===== C · Nunca renderiza → «sin listar» honesto tras 3 intentos ===== */
{
  const caso = await correr297(tribPara297('c'));
  assert.ok(caso.resultado, 'C: la corrida concluye: ' +
    (caso.error ? caso.error.code + ' — ' + caso.error.message : 'sin error'));
  const doc = caso.resultado.documentos;
  assert.equal(doc?.concluyente, false,
    'C: sin renderizar en ningún intento la sección NO concluye — jamás un cero fingido');
  assert.deepEqual(doc.items, [], 'C: sin filas inventadas');
  assert.ok(/tras 3 intentos/.test(String(doc?.motivo || '')),
    'C: el motivo nombra los 3 intentos: ' + doc?.motivo);
  assert.ok(/sin renderizar/.test(String(doc?.motivo || '')),
    'C: y la causa — el marco sin renderizar: ' + doc?.motivo);
  const reintentos = pasosReintento(caso);
  assert.equal(reintentos.length, 2, 'C: los dos reintentos quedan en los pasos (3 intentos en total)');
  assert.ok(docHits.c >= 3, 'C: el marco se cargó al menos tres veces: ' + docHits.c);
  assert.ok(caso.resultado.documentosDiag,
    'C: la evidencia por sección sigue viajando');
  assert.ok(String(caso.resultado.documentosDiag.html || '').includes('INTENTO-FINAL-C-297'),
    'C: la evidencia guardada es la del ÚLTIMO intento (trae su marca), no la del primero');
  /* E, segunda parte: ni con los tres intentos agotados se
     mueven las demás secciones de la corrida. */
  assert.deepEqual(caso.resultado.notifications, [], 'C/E: la bandeja se lee igual');
  assert.equal(caso.resultado.comunicados?.concluyente, true,
    'C/E: comunicados concluye igual en esta corrida');
  assert.equal(caso.aperturas, 0, 'C: cero aperturas');
  console.log('OK 2.9.7 · D8-C — Documentos: nunca renderiza → «sin listar» honesto tras 3 intentos, con la evidencia del último intento.');
}

/* ===== D · Renderiza a la primera → idéntico al actual ===== */
{
  const caso = await correr297(tribPara297('d'));
  assert.ok(caso.resultado, 'D: la corrida concluye: ' +
    (caso.error ? caso.error.code + ' — ' + caso.error.message : 'sin error'));
  const doc = caso.resultado.documentos;
  assert.equal(doc?.concluyente, true, 'D: a la primera la sección concluye, como siempre');
  assert.deepEqual(doc.items, ITEMS_TABLAS, 'D: la misma lista de siempre');
  assert.equal(pasosReintento(caso).length, 0,
    'D: SIN ningún paso de reintento — el comportamiento a la primera no cambia');
  assert.ok(caso.pasos.some(p => p.paso === 'Documentos listados'),
    'D: el diario narra la sección listada, como siempre');
  assert.equal(caso.aperturas, 0, 'D: cero aperturas');
  console.log('OK 2.9.7 · D8-D — Documentos: renderiza a la primera → listada sin un solo paso de reintento.');
}

serverPortal.close();
serverMarcos.close();
console.log('OK suite ronda297documentos completa');
