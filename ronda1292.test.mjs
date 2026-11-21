import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { generateKeyPairSync, webcrypto } from 'node:crypto';
import vm from 'node:vm';
import { URL as NodeURL } from 'node:url';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPlaywrightDriverFactory, satBrowserLogin } from './sat-doc-browser.mjs';
import { createSatTribFetch, buzonRescueCandidates, buzonRescueScore, buzonInventarioTextos } from './sat-tributario.mjs';
import { SatDocError } from './sat-doc-fetch.mjs';
import { Readable } from 'node:stream';
import { DOMParser } from '@xmldom/xmldom';
import { createPacoSATService } from './local-server.mjs';

/* ================================================================
   Ronda 1.29.2 — el acceso con e.firma espera a la página.

   El defecto (probado en vivo el 12 nov 2026 en el equipo de
   Paco, trabajo buzon-listar): credenciales validadas, navegador
   listo, formulario de e.firma enviado AL INSTANTE y el portal
   contestó «¡Error! no ha llenado varios campos requeridos. Por
   favor verifique.» (portal-rechaza), porque la página de acceso
   rellena ELLA el campo RFC desde el certificado — con su
   tiempo — y su validación exige el formulario completo.

   Esta suite levanta una RÉPLICA local de esa página (mismos
   ids que el mapa real del NIDP: #buttonFiel que navega a la
   variante de e.firma, #fileCertificate/#filePrivateKey
   ocultos, #privateKeyPassword, #rfc que la «página» rellena
   2 s después del cambio del certificado, #submit que valida
   los cuatro campos y pinta el MISMO #divError del portal) y
   demuestra, con el navegador y el driver REALES:
   (a) la secuencia VIEJA (legado1291: sin espera) es rechazada
       con el mensaje del portal, y el error nombra el campo
       que quedó vacío (#rfc);
   (b) la secuencia NUEVA espera, ve el RFC rellenado por la
       página («el portal rellenó el RFC desde tu certificado»)
       y ENTRA;
   (c) si la página nunca rellena el RFC pero el campo es
       editable, lo rellena el motor con el RFC del perfil y
       ENTRA («rellenando el RFC que el portal dejó vacío»);
   (d) si el campo no se puede rellenar (readonly y la página
       no lo deriva), el motor NO envía: respuesta-inesperada
       que nombra el campo, sin portal-rechaza y sin envío.
   Y las estáticas del cableado: la versión, el RFC que viaja
   desde los tres llamadores y que la secuencia legada vive
   solo como opción interna de esta prueba.
   ================================================================ */

const RFC = 'MFI6212158B4';

/* ---------- La réplica del acceso NIDP ---------- */
const paginaAcceso = `<!DOCTYPE html><html><body>
  <h1>Acceso por contraseña</h1>
  <a id="buttonFiel" href="/acceso-fiel">Acceso con e.firma</a>
</body></html>`;

const formularioFiel = ({ derivaRfc, rfcReadonly }) => `<!DOCTYPE html><html><body>
  <h1>SAT Autenticación</h1>
  <form id="certform">
    <input type="text" id="txtCertificate">
    <input type="file" id="fileCertificate" style="display:none">
    <input type="text" id="txtPrivateKey">
    <input type="file" id="filePrivateKey" style="display:none">
    <input type="password" id="privateKeyPassword">
    <input type="text" id="rfc" ${rfcReadonly ? 'readonly' : ''}>
    <div id="divError" style="display:none"></div>
    <button type="button" id="submit">Acceder</button>
  </form>
  <script>
    window.__envios = 0;
    document.getElementById('fileCertificate').addEventListener('change', () => {
      setTimeout(() => { document.getElementById('txtCertificate').value = 'certificado.cer'; }, 300);
      ${derivaRfc ? `setTimeout(() => { document.getElementById('rfc').value = '${RFC}'; }, 2000);` : ''}
    });
    document.getElementById('filePrivateKey').addEventListener('change', () => {
      setTimeout(() => { document.getElementById('txtPrivateKey').value = 'llave.key'; }, 300);
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

/* ----- La réplica post-acceso del Buzón (A2) -----
   Tres paneles de aterrizaje tras el «Acceso OK»: (i) con el
   enlace esperado, (ii) sin él pero con una alternativa
   plausible («Bandeja de notificaciones», que el criterio
   viejo NO elegía: ni ruta conocida ni etiqueta exacta) y
   (iii) sin ningún candidato. La bandeja trae su tabla con
   los asuntos como enlaces DENTRO de la tabla: cualquier
   apertura — clic o navegación — se cuenta en el servidor
   (`aperturas`) y la suite exige que quede a cero. */
let aperturas = 0;
const bandejaHtml = (titulo, filas, extra = '') => `<!DOCTYPE html><html><body>
  <h1>Buzón Tributario — Mis notificaciones</h1>
  <nav><a href="/bandeja-notificados">Notificados</a></nav>
  <h2>${titulo}</h2>
  <table>
    <thead><tr><th>Fecha</th><th>Asunto</th><th>Remitente</th><th>Estado</th></tr></thead>
    <tbody>${filas}</tbody>
  </table>${extra}
  <script>document.querySelectorAll('a.msg').forEach(a =>
    a.addEventListener('click', () => fetch('/contador-apertura')));</script>
</body></html>`;
const filaMsg = (n, fecha, asunto, remitente, estado) =>
  `<tr><td>${fecha}</td><td><a class="msg" href="/abrir/${n}">${asunto}</a></td>` +
  `<td>${remitente}</td><td>${estado}</td></tr>`;
/* La portada REAL post-acceso (diagnóstico 21:05): «Portal de
   trámites y servicios» — sin lista alguna —, los enlaces de
   régimen TODOS a /iniciar-expediente/mis-notificaciones/, el
   enlace «Trámites y servicios» y el iframe lanzador. */
const REGIMENES = ['Asalariados', 'Arrendadores', 'Empresarios y profesionistas',
  'Incorporación Fiscal', 'Simplificado de confianza', 'Otros ingresos',
  'General de ley', 'Cooperativas', 'Sector primario', 'Sin fines de lucro',
  'Grupos', 'Coordinados'];
const portadaHtml = ({ regimenes = true, lanzador = true, extra = '' } = {}) => `<!DOCTYPE html><html><body>
  <h1>Portal de trámites y servicios - SAT</h1>
  <nav>${regimenes ? REGIMENES.map(r => `<a href="/iniciar-expediente/mis-notificaciones/">${r}</a>`).join(' · ') : ''}
  <a href="/personas">Trámites y servicios</a>${extra}</nav>
  ${lanzador ? '<iframe src="/lanzador"></iframe>' : ''}
  <p>Servicios frecuentes y avisos generales del portal.</p>
</body></html>`;
const lanzadorHtml = `<!DOCTYPE html><html><body>
  <nav><a href="/inicio-lanzador">Inicio</a> · <a href="/iniciar-expediente/mis-notificaciones/">Buzón Tributario</a></nav>
</body></html>`;

const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  if (path.startsWith('/abrir/') || path === '/contador-apertura') {
    aperturas += 1;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!DOCTYPE html><html><body><h1>Detalle abierto</h1></body></html>');
    return;
  }
  const rutas = {
    '/acceso': paginaAcceso,
    '/acceso-fiel': formularioFiel({ derivaRfc: true, rfcReadonly: false }),
    '/acceso-fiel-sinrfc': formularioFiel({ derivaRfc: false, rfcReadonly: false }),
    '/acceso-fiel-roto': formularioFiel({ derivaRfc: false, rfcReadonly: true }),
    '/dentro': '<!DOCTYPE html><html><body><h1>Dentro del portal</h1></body></html>',
    '/panel-i': portadaHtml({}),
    '/panel-ii': portadaHtml({ regimenes: false }),
    '/panel-iii': portadaHtml({ regimenes: false, lanzador: false,
      extra: ' · <a href="/perfil">Mi perfil</a> · <a href="/ayuda">Ayuda</a>' }),
    '/lanzador': lanzadorHtml,
    '/personas': '<!DOCTYPE html><html><body><h1>Trámites y servicios</h1></body></html>',
    '/iniciar-expediente/mis-notificaciones/': bandejaHtml('Pendientes',
      filaMsg(1, '10/11/2026', 'Requerimiento de información', 'Auditoría', 'No leída') +
      filaMsg(2, '09/11/2026', 'Invitación a regularizar', 'Recaudación', 'No leída')),
    '/bandeja': bandejaHtml('Pendientes',
      filaMsg(1, '10/11/2026', 'Requerimiento de información', 'Auditoría', 'No leída') +
      filaMsg(2, '09/11/2026', 'Invitación a regularizar', 'Recaudación', 'No leída')),
    '/bandeja-notificados': bandejaHtml('Notificados',
      filaMsg(3, '21/10/2026', 'Actos administrativos', 'Recaudación', 'Leída'))
  };
  const html = rutas[path];
  if (!html) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const BASE = 'http://127.0.0.1:' + server.address().port;

/* ---------- El navegador real de esta máquina ---------- */
function chromiumDePrueba() {
  const candidatos = [process.env.PACOSAT_TEST_CHROMIUM || '', '/usr/bin/chromium'];
  try {
    const cache = join(homedir(), '.cache', 'ms-playwright');
    for (const dir of readdirSync(cache).sort()) {
      if (dir.startsWith('chromium-')) {
        candidatos.push(join(cache, dir, 'chrome-linux64', 'chrome'));
      }
    }
  } catch { /* sin caché de playwright: quedan los otros candidatos */ }
  return candidatos.find(p => p && existsSync(p)) || '';
}
const CHROME = chromiumDePrueba();
assert.ok(CHROME, 'ronda1292 necesita un Chromium local para la réplica del acceso ' +
  '(PACOSAT_TEST_CHROMIUM, /usr/bin/chromium o la caché de playwright): sin navegador ' +
  'la prueba que puede fallar no puede correr y la ronda no se da por probada.');

const launchDriver = createPlaywrightDriverFactory({ executablePath: CHROME, headless: true });
const driver = await launchDriver();
const page = await driver.newPage();
const fillOriginal = page.fillFielForm.bind(page);
const CER = Buffer.from('certificado-de-juguete');
const KEY = Buffer.from('llave-de-juguete');
const loginArgs = (entryUrl, pasos) => ({ cer: CER, key: KEY, password: 'pw-de-juguete',
  rfc: RFC, entryUrl, hooks: { step: (texto) => pasos.push(texto) } });

/* ===== (a) La secuencia VIEJA: envío al instante → el portal
   réplica rechaza con SU mensaje y el error nombra el #rfc ===== */
{
  page.fillFielForm = (args) => fillOriginal({ ...args, legado1291: true });
  const pasos = [];
  const error = await satBrowserLogin(page, loginArgs(BASE + '/acceso', pasos))
    .then(() => null, e => e);
  assert.ok(error instanceof SatDocError, 'la secuencia vieja termina en error del portal');
  assert.equal(error.code, 'portal-rechaza', 'la clase es la del rechazo en vivo');
  assert.ok(error.message.includes('no ha llenado varios campos requeridos'),
    'el mensaje del portal es el de la corrida viva: ' + error.message);
  assert.ok(error.message.includes('#rfc'),
    'el error enriquecido nombra el campo que quedó vacío: ' + error.message);
  console.log('OK 1.29.2 A — la secuencia sin espera reproduce el rechazo en vivo y el error nombra #rfc.');
}

/* ===== (b) La secuencia NUEVA: espera a que la página rellene
   el RFC desde el certificado y ENTRA ===== */
{
  page.fillFielForm = fillOriginal;
  const pasos = [];
  const result = await satBrowserLogin(page, loginArgs(BASE + '/acceso', pasos));
  assert.equal(result.url, BASE + '/dentro', 'con la espera, el acceso entra a la réplica');
  assert.ok(pasos.some(p => p.includes('rellenó el RFC desde tu certificado')),
    'la traza cuenta que el portal rellenó el RFC: ' + pasos.join(' | '));
  assert.ok(!pasos.some(p => p.includes('rellenando el RFC que el portal dejó vacío')),
    'si la página lo rellenó, el motor no lo escribe');
  console.log('OK 1.29.2 B — la secuencia nueva espera el RFC derivado y entra.');
}

/* ===== (c) La página no deriva el RFC pero el campo es
   editable: lo rellena el motor con el RFC del perfil ===== */
{
  const pasos = [];
  const result = await satBrowserLogin(page, loginArgs(BASE + '/acceso-fiel-sinrfc', pasos));
  assert.equal(result.url, BASE + '/dentro', 'con el RFC del perfil, el acceso entra');
  assert.ok(pasos.some(p => p.includes('rellenando el RFC que el portal dejó vacío')),
    'la traza cuenta el relleno propio: ' + pasos.join(' | '));
  console.log('OK 1.29.2 C — si el portal deja el RFC vacío y es editable, lo rellena el motor y entra.');
}

/* ===== (d) El campo no se puede rellenar: NO se envía ===== */
{
  page.fillFielForm = (args) => fillOriginal({ ...args, esperaDerivadosMs: 2_500 });
  const pasos = [];
  const error = await satBrowserLogin(page, loginArgs(BASE + '/acceso-fiel-roto', pasos))
    .then(() => null, e => e);
  page.fillFielForm = fillOriginal;
  assert.ok(error instanceof SatDocError, 'el acceso imposible termina en error propio');
  assert.equal(error.code, 'respuesta-inesperada',
    'no es portal-rechaza: el envío ni siquiera se produjo');
  assert.ok(error.message.includes('#rfc'), 'el error nombra el campo: ' + error.message);
  assert.equal(await page.divError(), '', 'el portal nunca pintó su rechazo: no hubo envío');
  assert.ok(page.url().includes('/acceso-fiel-roto'), 'la página no navegó a ningún sitio');
  console.log('OK 1.29.2 D — campo imposible de rellenar: no se envía y el error nombra el campo.');
}

/* ===== A2 · La bandeja tras el acceso, contra la réplica
   post-acceso, con el motor del Buzón REAL (createSatTribFetch)
   y su acceso completo por la misma réplica de login ===== */
{
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const KEY_PORTAL = privateKey.export({ type: 'pkcs8', format: 'der',
    cipher: 'des-ede3-cbc', passphrase: 'pw-de-juguete' });
  const resolver = async (profile) => ({ rfc: profile.rfc, cer: CER, key: KEY_PORTAL,
    password: 'pw-de-juguete' });
  const tribCon = (entryUrl) => createSatTribFetch({ resolveCredentials: resolver,
    launchDriver: createPlaywrightDriverFactory({ executablePath: CHROME, headless: true }),
    entryUrl, loginUrl: BASE + '/acceso' });

  /* (i) La portada real, con sus regímenes y su lanzador: el
     motor sigue el enlace de notificaciones (dedupe por href,
     «General de ley» primero), lista las dos bandejas y NO
     abre ninguna notificación. */
  const listaI = await tribCon(BASE + '/panel-i')({ rfc: RFC }, {});
  assert.equal(listaI.notifications.length, 3, 'dos pendientes + una notificada');
  assert.equal(listaI.notifications.filter(n => !n.abierta).length, 2, 'las de «Pendientes», sin abrir');
  assert.equal(listaI.notifications.filter(n => n.abierta).length, 1, 'la de «Notificados», abierta');
  assert.equal(aperturas, 0, 'ninguna notificación se abrió en la variante (i)');
  console.log('OK 1.29.2 A2-i — portada real con regímenes: lista completa, cero aperturas.');

  /* (ii) Portada SIN regímenes: solo queda el lanzador (iframe)
     con su enlace «Buzón Tributario» a la misma ruta — el
     inventario de marcos del mismo origen lo encuentra. */
  const listaII = await tribCon(BASE + '/panel-ii')({ rfc: RFC }, {});
  assert.equal(listaII.notifications.length, 3, 'la alternativa también lleva a la lista completa');
  assert.equal(aperturas, 0, 'ninguna notificación se abrió en la variante (ii)');
  console.log('OK 1.29.2 A2-ii — sin regímenes: el lanzador del iframe lleva a la bandeja.');

  /* (iii) Sin ningún candidato: el error lleva el inventario
     de textos (sin URLs) y la garantía de no apertura. */
  const error = await tribCon(BASE + '/panel-iii')({ rfc: RFC }, {}).then(() => null, e => e);
  assert.ok(error instanceof SatDocError, 'sin bandeja alcanzable hay error, no silencio');
  assert.equal(error.code, 'respuesta-inesperada');
  assert.ok(error.message.includes('Mi perfil'),
    'el error incluye el inventario de textos de la página: ' + error.message);
  assert.ok(!error.message.includes('/perfil') && !error.message.includes('http'),
    'el inventario no lleva URLs (ni tokens de sesión)');
  assert.ok(error.message.includes('No se abrió ninguna notificación'));
  assert.equal(aperturas, 0, 'ninguna notificación se abrió en la variante (iii)');
  console.log('OK 1.29.2 A2-iii — sin candidato: el error lleva el inventario, sin URLs, cero aperturas.');
}

/* ===== A2 · Unidades de la puntuación y el inventario ===== */
{
  const generico = { text: 'Notificaciones recientes', inTable: false,
    href: 'https://wwwmat.sat.gob.mx/personas/inicio' };
  assert.deepEqual(buzonRescueCandidates([generico]), [],
    'la etiqueta parecida sola sigue sin bastar (pin de la 1.24.0)');
  const alternativa = { text: 'Bandeja de notificaciones', inTable: false,
    href: 'https://wwwmat.sat.gob.mx/personas/bandeja' };
  assert.deepEqual(buzonRescueCandidates([alternativa]), [alternativa],
    'etiqueta plausible + ruta que la nombra = candidata');
  const detalle = { text: 'Requerimiento de información', inTable: true,
    href: 'https://wwwmat.sat.gob.mx/bandeja' };
  assert.deepEqual(buzonRescueCandidates([detalle]), [],
    'dentro de una tabla no hay puntuación que valga');
  /* La portada real: once regímenes, UN destino. El candidato
     es único (dedupe por href) y es «General de ley» — el
     régimen de la persona moral probada en vivo —. */
  const hrefNotif = 'https://wwwmat.sat.gob.mx/iniciar-expediente/mis-notificaciones/';
  const deRegimen = nombre => ({ text: nombre, inTable: false, href: hrefNotif });
  const candidatosRegimen = buzonRescueCandidates(
    ['Asalariados', 'Arrendadores', 'General de ley', 'Cooperativas'].map(deRegimen));
  assert.equal(candidatosRegimen.length, 1, 'un solo candidato por destino compartido');
  assert.equal(candidatosRegimen[0].text, 'General de ley', 'el desempate pone primero el régimen general');
  assert.ok(buzonRescueScore(deRegimen('General de ley')) > buzonRescueScore(deRegimen('Asalariados')),
    'la ruta mis-notificaciones puntúa la máxima y el régimen general desempata');
  const textos = buzonInventarioTextos([generico, detalle,
    { text: 'Mi perfil', inTable: false, href: 'https://x.test/perfil?token=secreto' }]);
  assert.deepEqual(textos, ['Notificaciones recientes', 'Mi perfil'],
    'el inventario trae textos fuera de tablas, sin asuntos ni hrefs');
  console.log('OK 1.29.2 A2-u — puntuación con umbral e inventario solo-textos.');
}

await driver.close();
server.close();

/* ===== Estáticas: versión, cableado del RFC, sonda sin
   valores y la secuencia legada confinada a la prueba ===== */
{
  const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.version, '3.2.0', 'la versión de la ronda (re-basificado en la 2.0.1: motores reconstruidos contra el mapa real del portal)');
  const browser = readFileSync(new URL('./sat-doc-browser.mjs', import.meta.url), 'utf8');
  assert.ok(browser.includes('fillFielForm({ cer, key, password, rfc, step })'),
    'satBrowserLogin pasa el RFC y la traza al relleno');
  assert.ok(browser.includes('password: creds.password, rfc: creds.rfc, entryUrl, hooks'),
    'la ruta de documentos pasa el RFC del perfil');
  for (const modulo of ['sat-tributario.mjs', 'sat-declaraciones.mjs']) {
    const src = readFileSync(new URL('./' + modulo, import.meta.url), 'utf8');
    assert.ok(src.includes('rfc: creds.rfc'), modulo + ' pasa el RFC del perfil al acceso');
  }
  /* La sonda que corre en la página solo MIDE valores (su
     longitud o si hay archivos): ningún .value sale de ella. */
  const ini = browser.indexOf('function sondaFielFormEnPagina');
  const fin = browser.indexOf('/* Del estado de la sonda', ini);
  assert.ok(ini > 0 && fin > ini, 'la sonda existe en su bloque único');
  const sonda = browser.slice(ini, fin);
  const usosValue = (sonda.match(/\.value/g) || []).length;
  /* Re-basificado en la 2.0.1: la higiene DyP compara el RFC
     del formulario con el del perfil DENTRO de la página y de
     la sonda solo sale el booleano (coincide) — el valor sigue
     sin salir jamás —; la forma ).trim() alimenta ese ===
     booleano y se suma a las formas medidas sancionadas. */
  const usosMedidos = (sonda.match(/\.value( ==|\)\.length|\)\.trim\(\))/g) || []).length;
  assert.equal(usosValue, usosMedidos,
    'en la sonda, todo .value se mide (==, .length o la comparación booleana de la 2.0.1), nunca se devuelve');
  /* La secuencia vieja vive solo como opción interna del
     driver, y ningún módulo de producción la activa. */
  const produccion = readdirSync(new URL('.', import.meta.url))
    .filter(n => n.endsWith('.mjs') && !n.endsWith('.test.mjs'));
  const conLegado = produccion.filter(n =>
    readFileSync(new URL('./' + n, import.meta.url), 'utf8').includes('legado1291'));
  assert.deepEqual(conLegado, ['sat-doc-browser.mjs'],
    'legado1291 solo existe en el driver, como opción interna de prueba');
  console.log('OK 1.29.2 E — estáticas: versión, RFC cableado en las tres rutas, sonda sin valores, legado confinado.');
}

/* ===== Arnés DOM falso (el de la ronda1291) para la parrilla == */
class BootURL extends NodeURL {
  static createObjectURL() { return 'blob:prueba'; }
  static revokeObjectURL() {}
}
class FakeElement {
  constructor(tag = 'div') {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.dataset = {};
    this.style = {};
    this.attributes = {};
    this.textContent = '';
    this.innerHTML = '';
    this.value = '';
    this.hidden = false;
    this.disabled = false;
    this.open = false;
    this.files = [];
    const classes = new Set();
    this.classList = {
      add: (...names) => names.forEach(name => classes.add(name)),
      remove: (...names) => names.forEach(name => classes.delete(name)),
      toggle: (name, force) => {
        const on = force === undefined ? !classes.has(name) : Boolean(force);
        if (on) classes.add(name); else classes.delete(name);
        return on;
      },
      contains: name => classes.has(name)
    };
  }
  get childNodes() { return this.children; }
  append(...kids) { for (const kid of kids) if (kid instanceof FakeElement) this.children.push(kid); }
  prepend(...kids) { for (const kid of [...kids].reverse()) if (kid instanceof FakeElement) this.children.unshift(kid); }
  appendChild(kid) { if (kid instanceof FakeElement) this.children.push(kid); return kid; }
  insertBefore(kid) { if (kid instanceof FakeElement) this.children.push(kid); return kid; }
  removeChild(kid) { this.children = this.children.filter(child => child !== kid); return kid; }
  replaceWith(...kids) { this.children = kids.filter(kid => kid instanceof FakeElement); }
  before() {}
  after() {}
  insertAdjacentElement(_where, kid) { return kid; }
  insertAdjacentHTML() {}
  insertAdjacentText() {}
  cloneNode() { return new FakeElement(this.tagName); }
  replaceChildren(...kids) { this.children = kids.filter(kid => kid instanceof FakeElement); }
  remove() {}
  click() {}
  close() {}
  showModal() {}
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return name in this.attributes ? this.attributes[name] : null; }
  removeAttribute(name) { delete this.attributes[name]; }
  hasAttribute(name) { return name in this.attributes; }
  addEventListener() {}
  removeEventListener() {}
  querySelector() { return null; }
  querySelectorAll() { return []; }
  closest() { return null; }
  focus() {}
  blur() {}
  scrollIntoView() {}
  getBoundingClientRect() { return { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 }; }
}
const storageStub1292 = () => {
  const map = new Map();
  return {
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: key => map.delete(key),
    clear: () => map.clear()
  };
};
function makeBootContext1292() {
  const byId = new Map();
  const metas = { 'meta[name="pacosat-token"]': { content: 'token-de-prueba' },
    'meta[name="pacosat-cloud"]': { content: '1' } };
  const documentStub = {
    getElementById: id => {
      if (!byId.has(id)) byId.set(id, new FakeElement('div'));
      return byId.get(id);
    },
    createElement: tag => new FakeElement(tag),
    createElementNS: (_ns, tag) => new FakeElement(tag),
    createTextNode: text => ({ textContent: String(text) }),
    querySelector: selector => metas[selector] ?? null,
    querySelectorAll: () => [],
    addEventListener: () => {},
    removeEventListener: () => {},
    documentElement: new FakeElement('html'),
    body: new FakeElement('body'),
    head: new FakeElement('head'),
    activeElement: null,
    title: ''
  };
  const fetchStub = async url => {
    const target = String(url);
    let body = {};
    if (target.includes('storage/rev')) body = { rev: 1 };
    else if (target.includes('storage?')) body = [];
    else if (target.includes('/api/status')) body = {
      settings: { installName: 'PacoSAT', hasLogo: false },
      buildModified: null, cloudRevision: null, profiles: [], jobs: [], inbox: [], mail: {} };
    else if (target.includes('/api/satdocs')) body = { profiles: [{ rfc: 'MFI6212158B4',
      constancia: null, opinion: null, progress: null }] };
    else if (target.includes('/api/tributario')) body = { ultimaConsulta: null, sinAbrir: 0, total: 0 };
    else if (target.includes('/api/declaraciones')) body = { documentos: [], progreso: null, ejecutor: null };
    else if (target.includes('/api/executor/overview')) body = { enLinea: false, ejecutores: [], trabajos: [] };
    return { ok: true, status: 200, headers: { get: () => 'application/json' },
      json: async () => body, text: async () => JSON.stringify(body), blob: async () => new Blob([]) };
  };
  const timer = (fn, ms, ...args) => { const t = setTimeout(fn, ms, ...args); t.unref?.(); return t; };
  const every = (fn, ms, ...args) => { const t = setInterval(fn, ms, ...args); t.unref?.(); return t; };
  const context = vm.createContext({
    console, document: documentStub,
    navigator: { onLine: true, userAgent: 'ronda1292-test' },
    location: { href: 'http://127.0.0.1:43729/', search: '', reload: () => {} },
    localStorage: storageStub1292(), sessionStorage: storageStub1292(),
    fetch: fetchStub, setTimeout: timer, setInterval: every,
    clearTimeout, clearInterval, queueMicrotask,
    URL: BootURL, URLSearchParams, Blob, TextEncoder, TextDecoder, btoa, atob,
    crypto: webcrypto, DecompressionStream,
    matchMedia: () => ({ matches: false, addEventListener: () => {}, addListener: () => {} }),
    Option: class extends FakeElement {},
    alert: () => {}, addEventListener: () => {}, removeEventListener: () => {},
    requestAnimationFrame: fn => timer(fn, 0)
  });
  context.window = context;
  context.self = context;
  return context;
}
const textoDe1292 = el => {
  let texto = el.textContent || '';
  for (const hijo of el.children || []) texto += ' ' + textoDe1292(hijo);
  return texto;
};
const filasDe1292 = (el, clase) => {
  const salida = [];
  const andar = nodo => {
    if (String(nodo.className || '').split(' ').includes(clase)) salida.push(nodo);
    for (const hijo of nodo.children || []) andar(hijo);
  };
  andar(el);
  return salida;
};

/* ===== G · La parrilla de trámites: estados con la forma de
   producción (función pura) y navegación de «Ver los últimos». */
{
  const context = makeBootContext1292();
  const html = readFileSync(new URL('./Faro-Fiscal.html', import.meta.url), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  vm.runInContext(script, context, { filename: 'Faro-Fiscal.html#script' });
  for (let i = 0; i < 12; i++) await new Promise(r => setTimeout(r, 0));
  /* RE-BASE integración 2.4.0 (W6b): satTramiteEstados y
     satCardGrid viven en la parte diferida de Descargas; se
     inyecta su fuente desde lazy.json (lo que el navegador
     recibe) tras el arranque. Ninguna aserción cambia. */
  const lazy1292 = JSON.parse(readFileSync(new URL('./lazy.json', import.meta.url), 'utf8'));
  vm.runInContext(lazy1292.partes.descargas.source, context, { filename: 'parte-descargas' });
  assert.equal(vm.runInContext('typeof satTramiteEstados', context), 'function', 'G: la máquina de estados existe');
  assert.equal(vm.runInContext('typeof satCardGrid', context), 'function', 'G: la parrilla existe');
  const estados = datos => {
    context.__datos1292 = datos;
    return vm.runInContext('satTramiteEstados(__datos1292)', context);
  };
  const base = { rfc: 'MFI6212158B4', profile: { rfc: 'MFI6212158B4', accessMethod: 'efirma' },
    lastJob: { status: 'finished', created: Date.now() - 86400000 },
    docsProfile: { constancia: { issuedAt: Date.now() - 86400000, level: 'ok' }, opinion: null, progress: null },
    trib: { ultimaConsulta: Date.now() - 3600000, sinAbrir: 0 },
    declProgreso: null, ejecutor: { emparejado: true, enLinea: true, ultimoVisto: Date.now() },
    cola: [], ultimoCfdi: 'Recibido · hoy',
    complementos: { total: 2, ultima: new Date().toISOString() }, ultimoAcuse: 'Acuse oct 2026' };
  /* G1 · Sin ejecutor emparejado: las dos tarjetas de la puerta
     dicen «Esperando tu equipo» y su acción es emparejar — nunca
     «al día» con la vía sin probar. */
  const sinEjecutor = estados({ ...base, ejecutor: { emparejado: false, enLinea: false, ultimoVisto: null } });
  assert.equal(sinEjecutor.declaraciones.frase, 'Esperando tu equipo');
  assert.equal(sinEjecutor.declaraciones.accion, 'emparejar');
  assert.equal(sinEjecutor.buzon.frase, 'Esperando tu equipo');
  assert.equal(sinEjecutor.buzon.accion, 'emparejar');
  /* G2 · Con trabajo en cola: esperando si el equipo no está,
     trabajando si está en línea y el trabajo está reclamado. */
  const enCola = estados({ ...base, ejecutor: { emparejado: true, enLinea: false, ultimoVisto: Date.now() - 3600000 },
    cola: [{ rfc: base.rfc, kind: 'buzon-listar', estado: 'en-cola', esperandoEquipo: true }] });
  assert.equal(enCola.buzon.frase, 'Esperando tu equipo');
  const corriendo = estados({ ...base,
    cola: [{ rfc: base.rfc, kind: 'buzon-listar', estado: 'en-curso', esperandoEquipo: false }] });
  assert.equal(corriendo.buzon.frase, 'Trabajando');
  /* G3 · Complementos: sin tipo P, «sin recibir» y la explicación
     de que no hay motor aparte; con tipo P, el conteo manda. */
  const sinComp = estados({ ...base, complementos: { total: 0, ultima: '' } });
  assert.equal(sinComp.complementos.frase, 'Sin recibir todavía');
  assert.match(sinComp.complementos.tecnico || '', /no hay una bajada aparte/,
    'la explicación vive en el detalle plegado desde la 1.31.1, no en la cara');
  const conComp = estados(base);
  assert.equal(conComp.complementos.nivel, 'ok');
  assert.match(conComp.complementos.detalle, /2 complemento\(s\)/);
  /* G4 · Constancia/Opinión: recencia y progreso verdaderos. */
  const vieja = estados({ ...base, docsProfile: { constancia: { issuedAt: Date.now() - 70 * 86400000, level: 'warn' }, opinion: null, progress: null } });
  assert.equal(vieja.constancia.frase, 'Conviene renovarla');
  const corriendoDoc = estados({ ...base, docsProfile: { constancia: null, opinion: null, progress: { kind: 'opinion', running: true, step: 'Pidiendo la opinión…' } } });
  assert.equal(corriendoDoc.opinion.frase, 'Trabajando');
  assert.equal(corriendoDoc.constancia.frase, 'Sin recibir todavía');
  console.log('OK 1.29.2 G — parrilla: estados verdaderos (esperando tu equipo, trabajando, complementos tipo P, recencia).');
}
/* G5 · La parrilla viva: Complementos cuenta SOLO tipo P y «Ver
   los últimos» deja el filtro de Facturas en su tipo. */
{
  const context = makeBootContext1292();
  const html = readFileSync(new URL('./Faro-Fiscal.html', import.meta.url), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  vm.runInContext(script, context, { filename: 'Faro-Fiscal.html#script' });
  for (let i = 0; i < 12; i++) await new Promise(r => setTimeout(r, 0));
  /* RE-BASE integración 2.4.0 (W6b): satCardGrid vive en la
     parte diferida de Descargas; se inyecta su fuente desde
     lazy.json tras el arranque, como en el bloque G. */
  const lazy1292b = JSON.parse(readFileSync(new URL('./lazy.json', import.meta.url), 'utf8'));
  vm.runInContext(lazy1292b.partes.descargas.source, context, { filename: 'parte-descargas' });
  vm.runInContext(`satData = { profiles: [{ rfc: 'MFI6212158B4', accessMethod: 'efirma' }], jobs: [] };
    people = [{ id: 'MFI6212158B4', name: 'MANO FIL SA' }];
    scope = 'MFI6212158B4';
    invoices = [
      { id: 'a', kind: 'I', date: '2026-11-01', from: { rfc: 'XAXX010101000' }, to: { rfc: 'MFI6212158B4' } },
      { id: 'b', kind: 'P', date: '2026-11-05', from: { rfc: 'XAXX010101000' }, to: { rfc: 'MFI6212158B4' } },
      { id: 'c', kind: 'P', date: '2026-11-09', from: { rfc: 'MFI6212158B4' }, to: { rfc: 'XAXX010101000' } },
      { id: 'd', kind: 'N', date: '2026-11-03', from: { rfc: 'MFI6212158B4' }, to: { rfc: 'MFI6212158B4' } }
    ];`, context);
  const grid = vm.runInContext('satCardGrid()', context);
  /* El render real cuelga la parrilla del documento antes de que
     las lecturas vuelvan: sin estar conectada, la guarda de la
     propia parrilla (isConnected) descarta el pintado — como en
     producción. Aquí se simula ese colgado. */
  grid.isConnected = true;
  for (let i = 0; i < 30; i++) await new Promise(r => setTimeout(r, 0));
  const tarjetas = filasDe1292(grid, 'tramite-card');
  assert.equal(tarjetas.length, 6, 'G5: seis tarjetas-trámite');
  const textoComp = textoDe1292(tarjetas[1]);
  assert.match(textoComp, /Complementos/);
  assert.match(textoComp, /2 complemento\(s\) registrados/, 'G5: Complementos cuenta solo los tipo P (2 de 4 filas)');
  let botonVer = null;
  const andar = nodo => { if (nodo.textContent === 'Ver los últimos' && !botonVer) botonVer = nodo;
    for (const hijo of nodo.children || []) andar(hijo); };
  andar(tarjetas[1]);
  assert.ok(botonVer && typeof botonVer.onclick === 'function', 'G5: la tarjeta trae su «Ver los últimos» con acción');
  try { botonVer.onclick(); } catch { /* navigate/render no corren en el DOM falso: el filtro ya quedó puesto */ }
  assert.equal(vm.runInContext('invoiceKind', context), 'P', 'G5: «Ver los últimos» de Complementos filtra Facturas por tipo P');
  console.log('OK 1.29.2 G5 — parrilla viva: 6 tarjetas, Complementos = solo tipo P, Ver filtra por P.');
}

/* ===== H · Alertas: nacimiento notificado una vez, atención
   persistida (posponer/archivar) y renacimiento por hecho. */
{
  const ORIGIN_H = 'https://pacosat.test';
  const KEY_H = 'f'.repeat(64);
  const clock = { t: Date.parse('2026-11-12T15:00:00Z') };
  const mails = [];
  const pushes = [];
  const service = createPacoSATService({
    dbFile: ':memory:', html: '<html><head><!--PACOSAT_TOKEN--></head><body>prueba</body></html>',
    origin: ORIGIN_H, proxyKey: KEY_H, satDocRetryWaitMs: 5,
    makeConnector: () => ({ parser: DOMParser, connector: {
      request: async () => 'req-b', check: async () => ({ status: 'pending', packages: [] }),
      download: async () => { throw new Error('sin paquetes'); } } }),
    makeMailer: () => ({ verify: async () => true,
      sendMail: async mail => { mails.push(mail); return { messageId: 'm' + mails.length }; } }),
    makePushSender: async (subscription, payload) => { pushes.push(payload); return { status: 201 }; },
    now: () => clock.t });
  let tokenH = '';
  const rawH = async (method, path, body, extra = {}) => {
    const chunks = []; if (body !== undefined) chunks.push(Buffer.from(JSON.stringify(body)));
    const req = Readable.from(chunks);
    req.method = method; req.url = path;
    req.headers = { host: 'pacosat.test', origin: ORIGIN_H, 'x-pacosat-proxy': KEY_H, ...extra };
    let status = 0; let text = '';
    const res = { writeHead(c) { status = c; }, setHeader() {}, getHeader() { return undefined; },
      end(chunk) { if (chunk) text += Buffer.isBuffer(chunk) ? chunk.toString('latin1') : chunk; } };
    await service.handle(req, res);
    return { status, text };
  };
  const callH = async (method, path, body) => {
    if (!tokenH) { const home = await rawH('GET', '/'); tokenH = /[0-9a-f]{64}/.exec(home.text)?.[0] || ''; }
    const r = await rawH(method, path, body, { 'x-pacosat-token': tokenH });
    let json = null; try { json = JSON.parse(r.text); } catch { /* binario */ }
    return { status: r.status, json, text: r.text };
  };
  const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(r => setImmediate(r)); };
  const OWN_H = 'MFI6212158B4';
  await callH('POST', '/api/mail', { host: 'smtp.test', port: 587, user: 'u', password: 'p',
    from: 'pacosat@test.mx', recipient: 'paco@test.mx' });
  const par = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pubH = par.publicKey.export({ format: 'jwk' });
  const p256dh = Buffer.concat([Buffer.from([4]), Buffer.from(pubH.x, 'base64url'), Buffer.from(pubH.y, 'base64url')]).toString('base64url');
  const authH = Buffer.from('secreto-auth-16b').toString('base64url');
  const subH = await callH('POST', '/api/push/subscribe',
    { endpoint: 'https://fcm.googleapis.com/fcm/send/push-test-h', keys: { p256dh, auth: authH } });
  assert.equal(subH.status, 200, 'H: la suscripción push queda viva (vía conectada)');
  /* El perfil se da de alta (la vía de siempre) y la primera
     sincronización quema la línea base SIN facturas: lo que
     nazca después es vida real y sí notifica. */
  await callH('POST', '/api/unlock', { rfc: OWN_H, minutes: 1440, days: 7,
    direction: 'both', password: 'simulated', certificate: 'YQ==', key: 'Yg==' });
  await callH('GET', '/api/notices');
  const factura = (total) => ({ id: 'H-AVISO-0000-4000-8000-000000000001', date: '2026-10-03', kind: 'I',
    from: { rfc: 'PPC980624U16', name: 'PEGASO PCS SA DE CV' }, to: { rfc: OWN_H, name: 'MANO FIL SA' },
    total, currency: 'MXN', fiscal: { paymentMethod: 'PPD', transferred: [], withheld: [] } });
  await callH('POST', '/api/storage', { batch: { people: [{ id: OWN_H, name: 'MANO FIL SA' }],
    invoices: [factura('1636.00')] } });
  let vista = (await callH('GET', '/api/notices')).json;
  assert.equal(vista.counts.total, 1, 'H: nace un aviso de saldo');
  assert.equal(vista.canales.correo, true, 'H: el canal correo consta conectado');
  assert.equal(vista.canales.push, true, 'H: el canal push consta conectado');
  const aviso = vista.avisos[0];
  assert.equal(aviso.gesto.texto, 'tuyo', 'H: el gesto del saldo por pagar es de Paco');
  await service.tick(); await flush();
  const nacimientos = mails.filter(m => /Nueva alerta/.test(m.subject || ''));
  assert.equal(nacimientos.length, 1, 'H: el nacimiento manda UN correo');
  assert.match(nacimientos[0].text, /Importe: \$1[.,]636\.00/, 'H: el correo lleva el importe del aviso');
  assert.match(nacimientos[0].text, /PPC980624U16/, 'H: el correo lleva la contraparte');
  assert.match(nacimientos[0].text, /De quién es el gesto: tuyo/, 'H: el correo lleva el gesto');
  assert.equal(pushes.length, 1, 'H: el nacimiento manda UN push');
  assert.match(String(pushes[0].title), /Nueva alerta/);
  assert.match(String(pushes[0].body), /gesto tuyo/, 'H: el push lleva el gesto');
  /* El recálculo con el mismo hecho NO re-notifica. */
  await callH('GET', '/api/notices'); await service.tick(); await flush();
  assert.equal(mails.filter(m => /Nueva alerta/.test(m.subject || '')).length, 1, 'H: el recálculo no re-notifica');
  assert.equal(pushes.length, 1, 'H: el recálculo no re-envía el push');
  /* Posponer: sale de los conteos, no notifica, y al vencer
     vuelve con su notificación de vuelta. */
  const posp = (await callH('POST', '/api/notices/posponer', { id: aviso.id, cuando: 'tres-dias' })).json;
  assert.equal(posp.counts.total, 0, 'H: la pospuesta no cuenta');
  assert.equal(posp.pospuestas.length, 1, 'H: la pospuesta se ve en su vista');
  assert.ok(posp.pospuestas[0].pospuestaHasta > clock.t + 2.5 * 86400000, 'H: vuelve en ~3 días');
  clock.t += 4 * 86400000;
  vista = (await callH('GET', '/api/notices')).json;
  assert.ok(vista.avisos.some(a => a.id === aviso.id), 'H: al vencer, vuelve a la vista activa');
  assert.equal(vista.pospuestas.length, 0);
  await service.tick(); await flush();
  assert.equal(mails.filter(m => /Volvió tu alerta/.test(m.subject || '')).length, 1, 'H: la vuelta notifica una vez');
  assert.equal(pushes.filter(p => /Volvió tu alerta/.test(String(p.title))).length, 1, 'H: la vuelta manda su push');
  /* Archivar + deshacer (restaurar): vuelve idéntica. */
  const totalAntesArchivar = (await callH('GET', '/api/notices')).json.counts.total;
  const arch = (await callH('POST', '/api/notices/atencion', { id: aviso.id, accion: 'archivar' })).json;
  assert.equal(arch.counts.total, totalAntesArchivar - 1, 'H: la archivada no cuenta');
  assert.ok(!arch.avisos.some(a => a.id === aviso.id), 'H: la archivada sale de la lista activa');
  assert.ok(arch.archivadas.some(a => a.id === aviso.id), 'H: la archivada se ve en su vista');
  await callH('GET', '/api/notices'); await service.tick(); await flush();
  const mailsTrasArchivar = mails.length;
  const rest = (await callH('POST', '/api/notices/atencion', { id: aviso.id, accion: 'restaurar' })).json;
  assert.equal(rest.counts.total, totalAntesArchivar, 'H: restaurar la devuelve a los conteos');
  const devuelta = rest.avisos.find(a => a.id === aviso.id);
  assert.ok(devuelta && devuelta.titulo === aviso.titulo && devuelta.importe === aviso.importe,
    'H: la restaurada es la misma alerta (mismo título e importe)');
  assert.equal(mails.length, mailsTrasArchivar, 'H: archivar/restaurar no notifica');
  /* Archivada con el hecho intacto: el recálculo la respeta.
     Con el hecho cambiado (otro importe): renace y notifica. */
  await callH('POST', '/api/notices/atencion', { id: aviso.id, accion: 'archivar' });
  vista = (await callH('GET', '/api/notices')).json;
  assert.ok(!vista.avisos.some(a => a.id === aviso.id) && vista.archivadas.some(a => a.id === aviso.id),
    'H: el recálculo respeta la archivada con el hecho intacto');
  await callH('POST', '/api/storage', { batch: { invoices: [factura('2000.00')] } });
  vista = (await callH('GET', '/api/notices')).json;
  assert.ok(vista.avisos.some(a => a.id === aviso.id), 'H: si el hecho cambia, la archivada RENACE a la vista activa');
  await service.tick(); await flush();
  assert.ok(mails.filter(m => /Volvió tu alerta/.test(m.subject || '')).length >= 2,
    'H: el renacimiento notifica como llegada nueva');
  console.log('OK 1.29.2 H — alertas: nace y notifica una vez con datos, posponer/archivar con estado en servidor, renace si el hecho cambia.');
}

/* Certificado de prueba REAL (el de efirma.test): RFC
   MFI6212158B4, vigente 2026–2036 — la vía /api/efirma lo
   valida de verdad (RFC y caducidad) antes de guardarlo. */
const CER_REAL_1292 = 'MIIDUzCCAjugAwIBAgIUH2WzMvVXT5BC2dNEzTaqRKJcZVUwDQYJKoZIhvcNAQELBQAwOTEgMB4GA1UEAwwXRU1QUkVTQSBQUlVFQkEgU0EgREUgQ1YxFTATBgNVBAUTDE1GSTYyMTIxNThCNDAeFw0yNjExMDkwNTA0MzVaFw0zNjExMDYwNTA0MzVaMDkxIDAeBgNVBAMMF0VNUFJFU0EgUFJVRUJBIFNBIERFIENWMRUwEwYDVQQFEwxNRkk2MjEyMTU4QjQwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQDJv/UPUgh/H1XwYFWUj2DV8HVVL95Z3LSi7P5yC1m2hcXlGVyvrc9EwIxTYuKVndt3mZyafViTg7Zng3wPs/bkZIhWcXTBkFPy8/4OZF4HKhgQTByszYEqBo4hr6o98FqS638cXcIkAzKFaIhpIJUpFMmUyKlSLgdWRcW7gm4SF2TaWYWi5CBok6gSoWsbmvEdFa0BbSCTxUUOxxWeoqhaMeYgN+PYpLWkl8Iq7VZJ+JeH0LMvbKg6Bhug0KOnC3/yNSBDIrg+A1rOysN8JJOU76zPuqj6aki7+oAEZIpGcu6h3cri7S8qq3zYupFdmZHwRySGDRci3ZpyCqjlFB97AgMBAAGjUzBRMB0GA1UdDgQWBBQYRYXN6Lv4Ke+TNpNWj7H1tqkEpTAfBgNVHSMEGDAWgBQYRYXN6Lv4Ke+TNpNWj7H1tqkEpTAPBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUAA4IBAQC8EwF8xC42pm/jFhTaO/gp2LDiSfz5cIJyZe9XsbczupYA9moD0Y9qMdEFAqgSVmFqJNgE675d5meRJdvRariROlpN3BZfcvPDEqHnwjqzjgHBt9e+GYb8UzdvkWiJuN7hoWgs2m+AJdPnsIWopKVI8enqng9Un7LbzCkACmJuG03Y+N7uuT/jIE+hNBHLJI6S9CGGs3hr8S4eZ2ijQeYyrWtLoeadLFsp4QqDb/JqXGtrIWFH9p3TNDEvyyVsYUBXSBIxX9zf/EYQ9NMLqIVSJ5hR/GjmDPf0plFteYQZEhRohrXnAox6clkDaIqTJkzWHhY4PHCPn+sJAh+Jzz8Y';

/* ===== I · D-ARRANQUE: el archivo de arranque puede fallar
   sin dejar Firmas vacía ni su causa en el aire. El arranque
   apunta a OTRA e.firma (la vieja, caducada) y su activación
   muere; la buena vive en el almacén desde la app. ===== */
{
  const dirI = mkdtempSync(join(tmpdir(), 'pacosat-1292-arranque-'));
  const KEY_I = 'f'.repeat(64);
  const service = createPacoSATService({
    dbFile: join(dirI, 'i.sqlite'), efirmaDir: join(dirI, 'efirma'),
    html: '<html><head><!--PACOSAT_TOKEN--></head><body>prueba</body></html>',
    origin: 'https://pacosat.test', proxyKey: KEY_I, satDocRetryWaitMs: 5,
    makeConnector: async ({ password }) => {
      if (password === 'vieja') throw new Error('El certificado está caducado: no se pudo activar.');
      return { parser: DOMParser, connector: {
        request: async () => 'req-i', check: async () => ({ status: 'pending', packages: [] }),
        download: async () => { throw new Error('sin paquetes'); } } };
    },
    makeMailer: () => ({ verify: async () => true, sendMail: async () => ({}) }),
    now: () => Date.parse('2026-11-12T15:00:00Z') });
  let tokenI = '';
  const rawI = async (method, path, body, extra = {}) => {
    const chunks = []; if (body !== undefined) chunks.push(Buffer.from(JSON.stringify(body)));
    const req = Readable.from(chunks);
    req.method = method; req.url = path;
    req.headers = { host: 'pacosat.test', origin: 'https://pacosat.test', 'x-pacosat-proxy': KEY_I, ...extra };
    let status = 0; let text = '';
    const res = { writeHead(c) { status = c; }, setHeader() {}, getHeader() { return undefined; },
      end(chunk) { if (chunk) text += Buffer.isBuffer(chunk) ? chunk.toString('latin1') : chunk; } };
    await service.handle(req, res);
    return { status, text };
  };
  const callI = async (method, path, body) => {
    if (!tokenI) { const home = await rawI('GET', '/'); tokenI = /[0-9a-f]{64}/.exec(home.text)?.[0] || ''; }
    const r = await rawI(method, path, body, { 'x-pacosat-token': tokenI });
    let json = null; try { json = JSON.parse(r.text); } catch { /* binario */ }
    return { status: r.status, json, text: r.text };
  };
  try {
    /* La buena entra por la app, como el 9 nov: queda en el
       almacén (POST /api/efirma, la vía de «Probar y guardar»,
       con el certificado de prueba del propio RFC, vigente). */
    const unlock = await callI('POST', '/api/efirma', { rfc: RFC, minutes: 1440, days: 7,
      direction: 'both', password: 'buena', certificate: CER_REAL_1292, key: 'Yg==' });
    assert.equal(unlock.status, 200, 'el alta por la app funciona: ' + unlock.text.slice(0, 120));
    /* El archivo de arranque apunta a la vieja y su conector muere. */
    const viejaCer = join(dirI, 'arranque-vieja.cer'), viejaKey = join(dirI, 'arranque-vieja.key');
    writeFileSync(viejaCer, Buffer.from('CERTIFICADO-VIEJO-2020'));
    writeFileSync(viejaKey, Buffer.from('LLAVE-VIEJA'));
    await service.bootstrap({ profiles: [{ rfc: RFC, name: 'MANO FIL SA', minutes: 360, days: 7,
      direction: 'received', certificatePath: viejaCer, keyPath: viejaKey, password: 'vieja' }] });
    const status = (await callI('GET', '/api/status')).json;
    const perfil = (status.profiles || []).find(p => p.rfc === RFC);
    assert.ok(perfil, 'D-ARRANQUE: el perfil vivo SIGUE en los datos aunque el arranque falló');
    assert.equal(perfil.efirmaStored, true, 'su e.firma consta guardada en el almacén');
    assert.equal(perfil.unlocked, true, 'y activa desde el almacén: la buena manda sobre el arranque');
    assert.equal(status.arranque?.fallo?.rfc, RFC, 'el fallo de arranque queda expuesto con su RFC');
    assert.match(status.arranque?.fallo?.causa || '', /caducado/, 'y con su causa real, no una línea genérica');
    assert.equal(status.arranque?.apuntaVieja, true, 'el sistema nombra que el arranque apunta a la vieja');
    const registro = (await callI('GET', '/api/registro?clase=fallo')).json;
    assert.ok((registro.items || []).some(item => /archivo de arranque/.test(item.texto || '') && /caducado/.test(item.texto || '')),
      'el Registro guarda la causa del arranque (qué perfil, qué archivo, por qué)');
    const htmlI = readFileSync(new URL('./Faro-Fiscal.html', import.meta.url), 'utf8');
    assert.ok(htmlI.includes('tu e.firma buena es la del almacén'),
      'la pantalla de Firmas enseña el aviso de la e.firma vieja');
    console.log('OK 1.29.2 I — D-ARRANQUE: Firmas pinta desde la BD/almacén, la causa queda en el Registro y el aviso nombra la vieja.');
  } finally { service.close(); rmSync(dirI, { recursive: true, force: true }); }
}

console.log('OK suite ronda1292 completa');
