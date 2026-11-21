/* ================================================================
   EJECUTOR LOCAL DE PACOSAT (1.31.0) — corre en el equipo de Paco.

   Qué es: el programa que, desde el equipo/Chrome de Paco (su
   sesión, su IP), recoge los trabajos que PacoSAT (en el NAS)
   encola, entra al portal del SAT con la e.firma custodiada EN
   ESTE EQUIPO para el RFC del trabajo, y devuelve la traza, los
   PDF y los números de operación para que PacoSAT los verifique
   y los archive. Sin este programa en línea, los trabajos quedan
   «esperando tu equipo» en PacoSAT: nadie finge un fallo del SAT.

   Novedades 1.30.0:
   - UNA SOLA ENTRADA POR RFC: la puerta se firma una vez y la
     sesión queda viva unos minutos para la tanda de trabajos de
     ese RFC (antes cada trabajo volvía a firmar). Si la sesión
     reutilizada no responde, se entra de nuevo y el trabajo se
     reintenta dentro de la misma corrida — queda registrado.
   - REINTENTO CON MEMORIA: si el portal rechaza el acceso
     (portal-rechaza) con el formulario verificado lleno — la
     variante inestable del portal que el 12 nov entró al segundo
     intento con el MISMO relleno —, se espera unos segundos y se
     reintenta UNA vez; las dos variantes quedan en la traza.
   - PUERTA-PROBAR: el trabajo que solo entra y vuelve, para que
     PacoSAT compruebe sola que la puerta sigue abriendo.
   - EMPAREJAMIENTO POR CÓDIGO CORTO: sin token.txt a mano — el
     instalador teclea el código que la app enseña y el canje
     deja el token guardado aquí (codigo.txt se borra al canjear).
     Dónde se empareja de verdad: en la app, en la pantalla del
     Buzón Tributario o en Centro SAT › Ejecutor local — allí la
     app enseña la llave larga y el código corto.
   - AUTO-ACTUALIZACIÓN: al arrancar pregunta a PacoSAT su
     versión; si hay una nueva, la baja DE PACOSAT (nunca de
     fuera), comprueba su huella SHA-256 y solo entonces se
     sustituye, conservando token.txt, efirma-local y el registro
     de sesiones; arrancar.bat lo relanza solo (salida 42).

   Novedades 1.32.1:
   - PUERTA VERAZ COMPLETA: el resultado fallido declara el
     acceso — accesoOk si la puerta abrió en la corrida aunque
     el corredor cayera después (también bajo sesión
     reutilizada que completa), accesoFallo si la caída fue
     en la entrada misma — y el diagnóstico viaja doble
     (página final + página de decisión).

   Novedades 1.31.0:
   - ACCESO OK POR CORRIDA: cada resultado declara accesoOk —
     true si la entrada con e.firma se completó EN ESTA corrida
     (la sesión final no fue reutilizada, o es la prueba de
     puerta en frío) — para que el servidor refresque el
     veredicto de la puerta aunque el trámite posterior falle.
   - CANCELACIÓN REMOTA: si Paco cancela un trabajo desde
     PacoSAT mientras este ejecutor lo está corriendo, el
     latido (heartbeat) lo trae en `cancelados` y el trabajo se
     detiene en el siguiente paso, devolviéndose como fallido
     con errorKind «cancelado» para que el servidor lo descarte
     (allí ya consta cancelado: nadie lo revive).

   Configuración (variables de entorno, ninguna es una credencial
   del SAT):
   - PACOSAT_URL: la dirección de PacoSAT (la del NAS).
   - PACOSAT_EXECUTOR_TOKEN: el token de emparejamiento (si no
     viene por entorno, se lee de token.txt junto a este archivo).
   - PACOSAT_PAIR_CODE: el código corto de emparejamiento, solo
     para el primer canje (el instalador lo deja en codigo.txt).
   - PACOSAT_EFIRMA_DIR: carpeta LOCAL de este equipo con la
     e.firma por RFC (<RFC>.cer, <RFC>.key y perfiles.json).
     Nunca sale de aquí: los trabajos y las trazas no llevan
     credenciales — el protocolo del servidor las rechaza.
   - PACOSAT_CHROMIUM_PATH: el Chrome/Chromium de este equipo.
   - PACOSAT_EJECUTOR_HEADED=1: navegador visible (por defecto
     visible: el primer acceso de cada RFC lo ves tú).

   Uso:  node ejecutor-local.mjs
   ================================================================ */
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, copyFileSync, renameSync, readdirSync, rmSync, statSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { hostname } from 'node:os';
import { createSatDocCredentialResolver, createFileEfirmaStorage } from './sat-doc-fetch.mjs';
import { createPlaywrightDriverFactory, satBrowserLogin, prepareKeyForPortal } from './sat-doc-browser.mjs';
import { BUZON_LOGIN_URL } from './sat-tributario.mjs';
import { createSatDeclFetch } from './sat-declaraciones.mjs';
import { createSatTribFetch } from './sat-tributario.mjs';
import { SAT_EXECUTOR_PROTOCOL_VERSION } from './sat-executor.mjs';
import { asegurarResidencia, estadoResidencia } from './registro-windows.mjs';

export const EJECUTOR_VERSION = '3.1.1';

const HERE = dirname(fileURLToPath(import.meta.url));
const URL_BASE = String(process.env.PACOSAT_URL || '').replace(/\/$/, '');
const EFIRMA_DIR = process.env.PACOSAT_EFIRMA_DIR || join(HERE, 'efirma-local');
const CHROMIUM = process.env.PACOSAT_CHROMIUM_PATH || '/usr/bin/chromium';
const HEADED = process.env.PACOSAT_EJECUTOR_HEADED !== '0';
const POLL_MS = Math.max(5000, Number(process.env.PACOSAT_EJECUTOR_POLL_MS) || 20000);
const SESIONES_FILE = join(HERE, 'ejecutor-sesiones.json');
const TOKEN_FILE = join(HERE, 'token.txt');
const CODIGO_FILE = join(HERE, 'codigo.txt');
/* La sesión viva por RFC caduca pronto a propósito: el portal
   también caduca las suyas, y una sesión «viva» muerta solo
   estorba. Ocho minutos cubren una tanda de trabajos seguidos. */
const SESION_VIVA_MS = 8 * 60 * 1000;
const REINTENTO_PORTAL_MS = 20 * 1000;

/* Cancelación remota (1.31.0): los ids de trabajo que el
   servidor ya marcó cancelados a petición de Paco. Se alimenta
   en ciclo() desde la respuesta del latido (`cancelados`) y
   ejecutar() lo consulta en cada paso y antes de cada intento:
   un trabajo cancelado se detiene y su resultado se descarta
   en el servidor, que ya lo tiene por cancelado. Los ids se
   guardan como texto: el id viaja por JSON y su tipo exacto
   no debe decidir si la cancelación se obedece o no. */
const canceladosRemotos = new Set();
const errorCancelado = () => Object.assign(
  new Error('Cancelado por ti desde PacoSAT: el trabajo se detiene y su resultado se descarta.'),
  { code: 'cancelado' });
const estaCancelado = job => Boolean(job?.id != null && canceladosRemotos.has(String(job.id)));

let TOKEN = String(process.env.PACOSAT_EXECUTOR_TOKEN || '');
if (!TOKEN && existsSync(TOKEN_FILE)) TOKEN = readFileSync(TOKEN_FILE, 'utf8').trim();

function sesiones() {
  try { return JSON.parse(readFileSync(SESIONES_FILE, 'utf8')); } catch { return {}; }
}
function marcaSesion(rfc, datos) {
  const all = sesiones();
  all[rfc] = { ...(all[rfc] || {}), ...datos, actualizado: Date.now() };
  try { writeFileSync(SESIONES_FILE, JSON.stringify(all, null, 2), { mode: 0o600 }); } catch { /* el registro local nunca tumba una corrida */ }
}

async function api(path, body, token = TOKEN) {
  const res = await fetch(URL_BASE + path, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-PacoSAT-Executor': token },
    body: JSON.stringify(body || {}) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ('PacoSAT respondió ' + res.status));
  return data;
}

/* ---------- Emparejamiento por código corto (1.30.0) ---------- */
async function canjearCodigo(codigo) {
  const res = await fetch(URL_BASE + '/api/executor/exchange', { method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ codigo: String(codigo || '').trim(), nombre: 'Equipo ' + hostname() }) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.token) throw new Error(data.error || 'El código corto no se pudo canjear.');
  writeFileSync(TOKEN_FILE, data.token, { mode: 0o600 });
  /* El código es de un solo uso y ya ardió en el servidor: su
     copia local se borra para que nadie lo «reutilice». */
  try { if (existsSync(CODIGO_FILE)) unlinkSync(CODIGO_FILE); } catch { /* si no se borra, el servidor igualmente lo rechaza */ }
  return data.token;
}
async function asegurarToken() {
  if (TOKEN) return TOKEN;
  const codigo = String(process.env.PACOSAT_PAIR_CODE || '').trim() ||
    (existsSync(CODIGO_FILE) ? readFileSync(CODIGO_FILE, 'utf8').trim() : '');
  if (!codigo) return '';
  TOKEN = await canjearCodigo(codigo);
  console.log('[ejecutor] emparejado con el código corto: el token quedó guardado en este equipo.');
  return TOKEN;
}

/* ---------- Auto-actualización desde el propio PacoSAT ---------- */
function compararVersiones(a, b) {
  const pa = String(a).split('.').map(n => Number(n) || 0);
  const pb = String(b).split('.').map(n => Number(n) || 0);
  for (let i = 0; i < 3; i++) { if (pa[i] !== pb[i]) return pa[i] - pb[i]; }
  return 0;
}
const PRESERVADOS_UPDATE = new Set(['token.txt', 'codigo.txt', 'ejecutor-sesiones.json', 'actualizacion.zip',
  'actualizacion-anterior', 'actualizacion-nueva', 'ejecutor.lock', 'despertar-crashes.txt']);

/* ---------- Verdad de versión (2.3.1, constructor B; evidencia
   del 17 nov 2026, diagnostico-231.md) ----------
   La instalación de la PC corría MEZCLADA: cáscara de la 2.3.0
   (su latido ya traía el reporte de residencia) con los motores
   de la 2.0.0, y nadie lo vio — el sello de versión vive en la
   cáscara, así que una copia fichero a fichero que renueva la
   cáscara pero no los motores dejaba el chequeo de versión
   satisfecho para siempre. La defensa es una HUELLA DE MOTORES:
   sha256 sobre los contenidos, en orden fijo y con su nombre,
   de los ficheros de programa que mandan en el comportamiento.
   La huella viaja en cada latido (reporteVersion231) y manda
   en la decisión de actualizar (tocaActualizar): una
   instalación mezclada con el sello ya renovado se reinstala
   sola en cuanto el servidor anuncia la huella del paquete. */
export const FICHEROS_HUELLA231 = ['ejecutor-local.mjs', 'sat-tributario.mjs',
  'sat-declaraciones.mjs', 'sat-doc-browser.mjs', 'sat-doc-fetch.mjs',
  'sat-executor.mjs', 'secret-box.mjs', 'registro-windows.mjs'];
export function huellaMotores(dir = HERE) {
  const hash = createHash('sha256');
  for (const nombre of FICHEROS_HUELLA231) {
    hash.update(nombre + '\n');
    try { hash.update(readFileSync(join(dir, nombre))); }
    catch { hash.update('<<ausente:' + nombre + '>>'); }
    hash.update('\n--\n');
  }
  return hash.digest('hex');
}
/* ---------- Huella de paquete (2.3.2, constructor B2a; E-02/M-2) ----------
   La huella de motores cubre los 8 .mjs que mandan, pero el
   comportamiento real manda en más sitios: node_modules entero
   (playwright-core y el SDK @nodecfdi se cargan dinámicamente),
   instalar.mjs y todos los lanzadores. Una copia cortada en
   node_modules o un despertar.vbs truncado pasaban la
   verificación de la 2.3.1 y se anunciaban como éxito.
   huellaPaquete es la segunda huella, determinista como la de
   motores (orden fijo, separadores fijos): sha256 sobre
   nombre + contenido de TODOS los ficheros de programa de nivel
   superior (los 8 de la huella + los 9 que quedaban fuera +
   LICENSE) y, por cada paquete de primer nivel de node_modules,
   un hash propio (sha256 sobre ruta relativa + contenido de
   cada fichero suyo, rutas ordenadas con separador '/'). Un
   paquete ausente o truncado cambia la huella igual que un
   motor cambiado cambia la suya. */
export const FICHEROS_PAQUETE232 = ['instalar.mjs', 'despertar.vbs', 'arrancar.bat', 'bandeja.ps1',
  'INSTALAR.bat', 'RESPALDAR.bat', 'LEEME.txt', 'package.json', 'package-lock.json', 'LICENSE'];
/* Integración-3 (2.3.2): la enumeración SIGUE los enlaces
   simbólicos, como ya hace readFileSync al leer el contenido.
   npm crea los .bin de node_modules como symlinks en Linux
   (en Windows son ficheros normales) y el zip del paquete
   guarda el destino como fichero normal: juzgando solo por
   Dirent.isFile()/isDirectory() —que dan false para un
   symlink— el fichero enlazado se saltaba al computar la
   huella sobre la carpeta y SÍ contaba sobre la instalación
   extraída del zip: contenido idéntico, huellas distintas
   para siempre. Ahora un symlink se resuelve con statSync
   (sigue el enlace): si el destino es fichero, se incluye con
   su ruta relativa (el contenido que se hashea es el del
   destino, vía el readFileSync de siempre); si es directorio,
   se recursa por la ruta del enlace, así que las rutas
   relativas son las del árbol enlazado — las mismas que el
   árbol materializado. Guarda contra bucles: la cadena de
   directorios ancestros por su ruta real (realpathSync) —un
   enlace que apunta a un ancestro no se vuelve a entrar— más
   un tope de profundidad; un bucle de enlaces no puede colgar
   la huella ni el arranque. Un enlace roto se salta, como
   antes. Para un árbol SIN enlaces el resultado es el de
   siempre, entrada a entrada: ordenación, separadores y el
   esquema nombre+contenido no cambian. */
const PROFUNDIDAD_MAX232 = 32;
function listarFicheros232(base, dir = base, acc = [], ancestros = null, profundidad = 0) {
  if (profundidad > PROFUNDIDAD_MAX232) return acc;
  let real;
  try { real = realpathSync(dir); } catch { real = dir; }
  if (ancestros && ancestros.has(real)) return acc;
  const cadena = new Set(ancestros || []);
  cadena.add(real);
  let entradas;
  try { entradas = readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  entradas.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entrada of entradas) {
    const ruta = join(dir, entrada.name);
    if (entrada.isDirectory()) { listarFicheros232(base, ruta, acc, cadena, profundidad + 1); continue; }
    if (entrada.isFile()) { acc.push(ruta.slice(base.length + 1).split('\\').join('/')); continue; }
    if (!entrada.isSymbolicLink()) continue;
    let destino;
    try { destino = statSync(ruta); } catch { continue; }
    if (destino.isDirectory()) listarFicheros232(base, ruta, acc, cadena, profundidad + 1);
    else if (destino.isFile()) acc.push(ruta.slice(base.length + 1).split('\\').join('/'));
  }
  return acc;
}
function huellaDirectorio232(base) {
  const hash = createHash('sha256');
  for (const rel of listarFicheros232(base)) {
    hash.update(rel + '\n');
    try { hash.update(readFileSync(join(base, rel))); } catch { hash.update('<<ausente:' + rel + '>>'); }
    hash.update('\n--\n');
  }
  return hash.digest('hex');
}
/* La misma regla de enlaces que en listarFicheros232
   (Integración-3): un paquete enlazado —su entrada en
   node_modules es un symlink a un directorio— cuenta como
   paquete, y un ámbito enlazado se abre igual (readdirSync ya
   sigue el enlace al listar sus hijos). statSync sigue el
   enlace: si está roto o el destino no es directorio, no es
   paquete, como antes. */
function esDirectorio232(entrada, ruta) {
  if (entrada.isDirectory()) return true;
  if (!entrada.isSymbolicLink()) return false;
  try { return statSync(ruta).isDirectory(); } catch { return false; }
}
export function paquetesNodeModules232(dir = HERE) {
  const nmDir = join(dir, 'node_modules');
  let entradas;
  try { entradas = readdirSync(nmDir, { withFileTypes: true }); } catch { return []; }
  const paquetes = [];
  for (const entrada of entradas) {
    if (!esDirectorio232(entrada, join(nmDir, entrada.name))) continue;
    if (entrada.name.startsWith('@')) {
      let hijos;
      try { hijos = readdirSync(join(nmDir, entrada.name), { withFileTypes: true }); } catch { continue; }
      for (const hijo of hijos) if (esDirectorio232(hijo, join(nmDir, entrada.name, hijo.name))) paquetes.push(entrada.name + '/' + hijo.name);
    } else paquetes.push(entrada.name);
  }
  return paquetes.sort();
}
export function huellaPaquete(dir = HERE) {
  const hash = createHash('sha256');
  for (const nombre of [...FICHEROS_HUELLA231, ...FICHEROS_PAQUETE232]) {
    hash.update(nombre + '\n');
    try { hash.update(readFileSync(join(dir, nombre))); }
    catch { hash.update('<<ausente:' + nombre + '>>'); }
    hash.update('\n--\n');
  }
  const nmDir = join(dir, 'node_modules');
  if (!existsSync(nmDir)) { hash.update('node_modules\n<<ausente>>\n--\n'); return hash.digest('hex'); }
  for (const paquete of paquetesNodeModules232(dir)) {
    hash.update('node_modules/' + paquete + '\n');
    hash.update(huellaDirectorio232(join(nmDir, paquete)));
    hash.update('\n--\n');
  }
  return hash.digest('hex');
}
/* Verificación de la huella de paquete, pura como la de
   motores: se recomputa DESDE EL DISCO y se compara. */
export function verificacionPaquete232(dir, huellaEsperada) {
  const huella = huellaPaquete(dir);
  return { ok: /^[0-9a-f]{64}$/.test(String(huellaEsperada || '')) && huella === huellaEsperada, huellaPaquete: huella };
}

/* ---------- Saneo del detalle por tokens (2.3.2, m-19) ----------
   El detalle de actualización viaja al servidor y se enseña en
   Salud: ninguna ruta absoluta puede viajar en él. Cada palabra
   que contenga \ o / se sustituye por su último segmento
   (C:\\Users\\…\\sat-tributario.mjs → sat-tributario.mjs)
   ANTES del colapso de espacios y del corte a 200. */
export function sanearDetalle232(detalle) {
  const palabras = String(detalle || '').split(/\s+/).filter(Boolean).map(palabra => {
    if (!palabra.includes('\\') && !palabra.includes('/')) return palabra;
    const segmentos = palabra.split(/[\\/]+/).filter(Boolean);
    return segmentos.length ? segmentos[segmentos.length - 1] : palabra;
  });
  return palabras.join(' ').replace(/\s+/g, ' ').trim().slice(0, 200);
}

/* Decisión pura de actualizar: manda la versión mayor; a igual
   versión manda la huella — si la anunciada difiere de la
   propia, la instalación está mezclada y se reinstala. Sin
   huella anunciada (servidor o paquete anterior), manda solo
   la versión, como siempre. Nunca se baja de versión. */
export function tocaActualizar(infoServidor, propia) {
  if (!infoServidor?.version || !propia?.version) return false;
  const cmp = compararVersiones(infoServidor.version, propia.version);
  if (cmp > 0) return true;
  if (cmp < 0) return false;
  const anunciada = String(infoServidor.huellaMotores || '');
  if (!/^[0-9a-f]{64}$/.test(anunciada)) return false;
  return anunciada !== String(propia.huella || '');
}
/* Verificación post-copia, pura: la huella se recomputa DESDE
   EL DISCO tras copiar y se compara con la anunciada. Solo con
   las dos iguales la actualización se da por buena. */
export function verificacionPostCopia(dir, huellaEsperada) {
  const huella = huellaMotores(dir);
  return { ok: /^[0-9a-f]{64}$/.test(String(huellaEsperada || '')) && huella === huellaEsperada, huella };
}
/* Lo último que la comprobación de actualización dejó que
   contar ({ estado: 'fallo'|'pendiente', detalle } o null):
   viaja en el reporte del latido para que el servidor lo
   enseñe en Salud. El detalle es corto (≤200) y sin rutas
   personales: nombres de fichero y causa técnica breve. */
let ultimoReporteActualizacion231 = null;
export function anotarActualizacion231(estado, detalle) {
  ultimoReporteActualizacion231 = { estado, detalle: sanearDetalle232(detalle) };
}
/* El reporte de versión del latido: solo versión, huella y,
   cuando la hay, la novedad de la actualización. Ningún dato
   sensible viaja aquí — las credenciales jamás entran en el
   protocolo (regla de la casa). */
export function reporteVersion231(dir = HERE) {
  const reporte = { version: EJECUTOR_VERSION, huella: huellaMotores(dir), huellaPaquete: huellaPaquete(dir) };
  if (ultimoReporteActualizacion231) reporte.actualizacion = { ...ultimoReporteActualizacion231 };
  return reporte;
}

/* ---------- Copia en orden de dependencias (2.3.2, B-2) ----------
   La copia de la 2.3.1 sobrescribía la instalación viva en el
   orden que devolviera readdirSync: si moría a mitad tras la
   cáscara y antes que los motores, el módulo ya no cargaba
   (imports estáticos) y la pieza que podía curarse era la que
   no arrancaba. El orden ahora es fijo y por dependencias:
   primero las carpetas (node_modules, del que cuelga todo),
   después los motores en el orden de la huella, después el
   resto de ficheros de programa, y ejecutor-local.mjs —la
   cáscara que importa a todos— EL ÚLTIMO de los de programa:
   hasta que la cáscara nueva aterriza, la vieja sigue casando
   con los motores viejos o con los nuevos ya copiados, y si la
   copia muere a mitad la instalación sigue pudiendo arrancar
   y curarse en la siguiente comprobación. */
function rangoCopia232(nombre) {
  if (nombre === 'ejecutor-local.mjs') return 9000;
  const ih = FICHEROS_HUELLA231.indexOf(nombre);
  if (ih > 0) return ih;
  const ip = FICHEROS_PAQUETE232.indexOf(nombre);
  if (ip >= 0) return 100 + ip;
  return 500;
}
export function ordenarCopia232(nombres) {
  return [...nombres].sort((a, b) => (rangoCopia232(a) - rangoCopia232(b)) || (a < b ? -1 : a > b ? 1 : 0));
}
const nombreBase232 = ruta => String(ruta || '').split(/[\\/]/).filter(Boolean).pop() || 'carpeta';
/* Copia atómica por fichero (2.3.2, D-2; auditoría final §2):
   TODA copia de fichero de la actualización va primero a un
   hermano temporal (destino + sufijo) y solo entonces se
   renombra sobre el destino — renameSync es atómico en el
   mismo volumen, así que el destino o queda entero viejo o
   entero nuevo, nunca truncado a mitad. Esto importa sobre
   todo para despertar.vbs: es pieza copiada y a la vez el
   único rescatador de todos los caminos de arranque; morir
   durante su copia directa dejaba el ejecutor sin arranque
   ni autorreparación. Si la copia o el renombrado fallan, el
   temporal se borra y el destino ORIGINAL queda intacto; al
   terminar (bien o mal) no queda ningún temporal residual.
   Las operaciones de fs son inyectables (ops232) solo como
   costura de prueba, siguiendo la del propio fichero: la
   suite fuerza un renombrado que falla y comprueba que el
   destino original sobrevive. */
export const SUFIJO_COPIA_TEMPORAL232 = '.tmp-actualizacion-232';
export function copiarFicheroAtomico232(origenFichero, destinoFichero, ops232 = {}) {
  const copiarF = ops232.copyFileSync || copyFileSync;
  const renombrarF = ops232.renameSync || renameSync;
  const borrarF = ops232.unlinkSync || unlinkSync;
  const temporal = destinoFichero + SUFIJO_COPIA_TEMPORAL232;
  try { if (existsSync(temporal)) borrarF(temporal); } catch { /* un temporal viejo no bloquea la copia */ }
  try {
    copiarF(origenFichero, temporal);
    renombrarF(temporal, destinoFichero);
  } catch (errorCopia) {
    try { if (existsSync(temporal)) borrarF(temporal); } catch { /* el error que manda es el de la copia */ }
    throw errorCopia;
  }
}
export function copiarActualizacion232(origen, destino, ops232 = {}) {
  let entradas;
  try { entradas = readdirSync(origen, { withFileTypes: true }); }
  catch (errorLectura) { throw new Error(nombreBase232(origen) + ' (' + (errorLectura?.code || 'error de lectura') + ')'); }
  const porNombre = new Map(entradas.map(e => [e.name, e]));
  const directorios = entradas.filter(e => e.isDirectory()).map(e => e.name).sort();
  for (const nombreDir of directorios) {
    const nombre = porNombre.get(nombreDir);
    if (nombre.name === 'efirma-local' || PRESERVADOS_UPDATE.has(nombre.name)) continue;
    const d = join(destino, nombre.name);
    try { mkdirSync(d, { recursive: true }); }
    catch (errorDir) { throw new Error(nombre.name + ' (' + (errorDir?.code || 'error al crear carpeta') + ')'); }
    copiarActualizacion232(join(origen, nombre.name), d, ops232);
  }
  for (const nombreFichero of ordenarCopia232(entradas.filter(e => !e.isDirectory()).map(e => e.name))) {
    const nombre = porNombre.get(nombreFichero);
    if (nombre.name === 'efirma-local' || PRESERVADOS_UPDATE.has(nombre.name)) continue;
    try { copiarFicheroAtomico232(join(origen, nombre.name), join(destino, nombre.name), ops232); }
    catch (errorCopia) { throw new Error(nombre.name + ' (' + (errorCopia?.code || 'error de copia') + ')'); }
  }
}
const copiar = copiarActualizacion232;

/* Respaldo y restauración (2.3.2, B-2): antes de copiar se
   guardan los ficheros de programa vigentes (y node_modules)
   en actualizacion-anterior/; despertar.vbs restaura esa
   carpeta si el proceso nuevo muere al arrancar una y otra
   vez, y el propio ejecutor la restaura si la verificación
   post-copia caza una mezcla. */
export function respaldarActual232(dir = HERE, respaldo = join(dir, 'actualizacion-anterior')) {
  rmSync(respaldo, { recursive: true, force: true });
  mkdirSync(respaldo, { recursive: true });
  for (const nombre of [...FICHEROS_HUELLA231, ...FICHEROS_PAQUETE232]) {
    const ruta = join(dir, nombre);
    if (existsSync(ruta)) copiarFicheroAtomico232(ruta, join(respaldo, nombre));
  }
  const nm = join(dir, 'node_modules');
  if (existsSync(nm)) copiarActualizacion232(nm, join(respaldo, 'node_modules'));
  return respaldo;
}
export function restaurarRespaldo232(dir = HERE, respaldo = join(dir, 'actualizacion-anterior')) {
  if (!existsSync(respaldo)) return false;
  copiarActualizacion232(respaldo, dir);
  return true;
}
/* Re-verificación tras restaurar (2.3.2, D-2; auditoría final
   §2): restaurar no basta para afirmar «restaurado». Se
   recomputan DESDE EL DISCO, con las mismas funciones de
   verificación de motores y de paquete de siempre
   (verificacionPostCopia / verificacionPaquete232), las
   huellas de la instalación viva y se comparan con las del
   propio respaldo — lo restaurado debe ser, huella a huella,
   lo que el respaldo guarda. Si la restauración quedó a
   medias, ok va en false aquí, en el acto, y no en el
   siguiente arranque vía despertador. */
export function reverificacionTrasRestaurar232(dir = HERE, respaldo = join(dir, 'actualizacion-anterior')) {
  const motores = verificacionPostCopia(dir, huellaMotores(respaldo));
  const paquete = verificacionPaquete232(dir, huellaPaquete(respaldo));
  return { ok: motores.ok && paquete.ok, motores, paquete, huella: motores.huella, huellaPaquete: paquete.huellaPaquete };
}

/* Humo de carga y verificación EN STAGING (2.3.2, B-2): el
   paquete nuevo se descomprime en actualizacion-nueva/ y se
   verifica ALLÍ —huella de motores, huellaPaquete y
   node --check de cada .mjs de programa— antes de tocar la
   instalación viva. Si el staging no verifica, la viva no se
   toca y el fallo se reporta. */
export function humoCarga232(dir) {
  for (const nombre of [...FICHEROS_HUELLA231, 'instalar.mjs']) {
    const ruta = join(dir, nombre);
    if (!existsSync(ruta)) continue;
    try { execFileSync(process.execPath, ['--check', ruta], { stdio: 'pipe' }); }
    catch { return { ok: false, fichero: nombre }; }
  }
  return { ok: true };
}
export function verificarStaging232(dir, info = {}) {
  const motores = verificacionPostCopia(dir, info.huellaMotores);
  if (!motores.ok) return { ok: false, motivo: 'huella-motores', huella: motores.huella };
  const paquete = verificacionPaquete232(dir, info.huellaPaquete);
  if (!paquete.ok) return { ok: false, motivo: 'huella-paquete', huellaPaquete: paquete.huellaPaquete };
  const humo = humoCarga232(dir);
  if (!humo.ok) return { ok: false, motivo: 'humo-carga', fichero: humo.fichero };
  return { ok: true, huella: motores.huella, huellaPaquete: paquete.huellaPaquete };
}

/* Decisión de actualización (2.3.2, o-4): un manifiesto sin
   huellaMotores (o sin huellaPaquete) NO se copia y NO es un
   éxito silencioso: es un pendiente reportable — el 42 ya no
   descansa solo en el sha del zip. Nunca se baja de versión. */
export function decisionActualizacion232(infoServidor, propia) {
  if (!infoServidor?.version || !propia?.version) return { accion: 'ninguna', motivo: 'sin-version' };
  const cmp = compararVersiones(infoServidor.version, propia.version);
  if (cmp < 0) return { accion: 'ninguna', motivo: 'no-bajar' };
  const huellaOk = /^[0-9a-f]{64}$/.test(String(infoServidor.huellaMotores || ''));
  const paqueteOk = /^[0-9a-f]{64}$/.test(String(infoServidor.huellaPaquete || ''));
  const necesita = cmp > 0 || (huellaOk && String(infoServidor.huellaMotores) !== String(propia.huella || ''));
  if (!necesita) return { accion: 'ninguna', motivo: 'al-dia' };
  if (!huellaOk) return { accion: 'pendiente-sin-huella', motivo: 'huellaMotores' };
  if (!paqueteOk) return { accion: 'pendiente-sin-huella', motivo: 'huellaPaquete' };
  return { accion: 'actualizar' };
}

/* Relanzamiento que no depende del padre (2.3.2, o-6): antes
   de salir con 42, el ejecutor lanza despertar.vbs desacoplado;
   el despertador ya sabe no duplicar (YaCorre) y relanzar tras
   el 42, así que la vuelta no depende de quién lanzó a este
   proceso. Fuera de Windows no hay despertador: no se lanza. */
export function lanzarDespertador232(dir = HERE) {
  if (process.platform !== 'win32') return false;
  try {
    const hijo = spawn('wscript.exe', [join(dir, 'despertar.vbs')], { detached: true, stdio: 'ignore', windowsHide: true });
    hijo.unref();
    return true;
  } catch { return false; }
}

/* Cadencia de re-comprobación (2.3.2, M-5): la actualización
   ya no se comprueba solo al arrancar. En el bucle se repite
   cada 6 h; tras un fallo o un pendiente, el reintento espera
   1 h, luego 6 h, luego 24 h (y se queda en 24 h). */
export const CADENCIA_ACTUALIZACION232_MS = 6 * 60 * 60 * 1000;
export const ESPERAS_REINTENTO232_MS = [60 * 60 * 1000, 6 * 60 * 60 * 1000, 24 * 60 * 60 * 1000];
export function proximaComprobacion232({ ultima = 0, fallosSeguidos = 0, ahora = Date.now() } = {}) {
  if (!ultima) return ahora;
  const espera = fallosSeguidos > 0
    ? ESPERAS_REINTENTO232_MS[Math.min(fallosSeguidos - 1, ESPERAS_REINTENTO232_MS.length - 1)]
    : CADENCIA_ACTUALIZACION232_MS;
  return ultima + espera;
}

/* Devuelve el desenlace ('sin-cambio' | 'pendiente' | 'fallo')
   para que el bucle lleve la cadencia de reintentos; cuando la
   actualización se aplica, sale con 42 y no vuelve. Las ramas
   de verificación post-copia vuelven sin valor (return;): el
   llamador las lee como 'fallo' con ?? 'fallo'. */
async function comprobarActualizacion() {
  let info;
  try { info = await api('/api/executor/version', {}); } catch { return 'sin-cambio'; }
  const decision = decisionActualizacion232(info, { version: EJECUTOR_VERSION, huella: huellaMotores() });
  if (decision.accion === 'ninguna') return 'sin-cambio';
  if (decision.accion === 'pendiente-sin-huella') {
    console.error('[ejecutor] el paquete de la versión ' + info.version + ' no anuncia ' + decision.motivo + ': no se copia nada.');
    anotarActualizacion231('pendiente', 'PacoSAT ofrece la versión ' + info.version +
      ' pero el paquete no anuncia ' + decision.motivo + ': no se copia nada hasta que el paquete la anuncie.');
    return 'pendiente';
  }
  if (process.platform !== 'win32') {
    console.log('[ejecutor] PacoSAT tiene la versión ' + info.version + ' del ejecutor, pero la ' +
      'actualización automática solo corre en Windows: actualiza a mano desde PacoSAT.');
    anotarActualizacion231('pendiente', 'PacoSAT ofrece la versión ' + info.version +
      ' (o el mismo sello con piezas distintas) y esta plataforma no se actualiza sola: toca actualizar a mano.');
    return 'pendiente';
  }
  const res = await fetch(URL_BASE + '/api/executor/bundle', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-PacoSAT-Executor': TOKEN }, body: '{}' });
  if (!res.ok) {
    console.error('[ejecutor] no se pudo bajar la actualización: no se toca nada.');
    anotarActualizacion231('fallo', 'No se pudo bajar el paquete de la versión ' + info.version +
      ' desde PacoSAT: no se tocó nada.');
    return 'fallo';
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const sha = createHash('sha256').update(buf).digest('hex');
  if (!info.sha256 || sha !== info.sha256) {
    console.error('[ejecutor] la actualización bajada NO coincide con la huella que PacoSAT anuncia: no se toca nada.');
    anotarActualizacion231('fallo', 'El paquete bajado de la versión ' + info.version +
      ' no coincide con la huella que PacoSAT anuncia (sha256): no se tocó nada.');
    return 'fallo';
  }
  const zipPath = join(HERE, 'actualizacion.zip');
  const tmpDir = join(HERE, 'actualizacion-nueva');
  writeFileSync(zipPath, buf);
  try {
    rmSync(tmpDir, { recursive: true, force: true });
    execFileSync('powershell', ['-NoProfile', '-Command',
      'Expand-Archive -LiteralPath $env:PACO_ZIP -DestinationPath $env:PACO_TMP -Force'],
      { env: { ...process.env, PACO_ZIP: zipPath, PACO_TMP: tmpDir }, stdio: 'pipe' });
    /* Verificación EN STAGING (2.3.2, B-2): huellas y humo de
       carga sobre la carpeta nueva; si algo no cuadra, la
       instalación viva no se ha tocado y no se toca. */
    const staging = verificarStaging232(tmpDir, info);
    if (!staging.ok) {
      console.error('[ejecutor] el paquete nuevo no verifica en staging (' + staging.motivo + '): no se toca la instalación.');
      anotarActualizacion231('fallo', 'El paquete de la versión ' + info.version +
        ' no verifica antes de copiar (' + staging.motivo + '): no se tocó la instalación.');
      return 'fallo';
    }
    /* Respaldo de lo vigente y copia en orden de dependencias
       con la cáscara la última (2.3.2, B-2). La carpeta
       efirma-local y los ficheros propios NUNCA se sobrescriben:
       la actualización trae código, no tus llaves. */
    respaldarActual232(HERE);
    copiar(tmpDir, HERE);
  } catch (error) {
    console.error('[ejecutor] la actualización falló al aplicarse (' + (error?.message || error) + '): sigo con la versión de siempre.');
    anotarActualizacion231('fallo', 'La actualización a la versión ' + info.version +
      ' falló al copiar ' + (error?.message || 'un fichero') + ': se sigue con lo que había.');
    return 'fallo';
  } finally {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* limpieza menor */ }
    try { unlinkSync(zipPath); } catch { /* limpieza menor */ }
  }
  /* Verificación post-copia (2.3.1, constructor B; ampliada en
     la 2.3.2 con la huellaPaquete, M-2): antes de dar la
     actualización por buena, las huellas se recomputan desde
     el disco y se comparan con las anunciadas. Si alguna no
     coincide, la instalación sigue mezclada: se restaura el
     respaldo, NO se anuncia éxito ni se sale como actualizado
     — el fallo queda anotado para el próximo reporte del
     latido y se sigue con lo que haya; el servidor lo
     enseñará en Salud. */
  if (info.huellaMotores) {
    const verificacion = verificacionPostCopia(HERE, info.huellaMotores);
    if (!verificacion.ok) {
      console.error('[ejecutor] tras copiar, la huella de los motores NO coincide con la anunciada: ' +
        'la instalación sigue mezclada; restauro el respaldo, lo re-verifico y lo reporto en el latido.');
      let restaurado = false;
      try { restaurado = restaurarRespaldo232(HERE); } catch { /* el respaldo queda en actualizacion-anterior para despertar.vbs */ }
      /* D-2: tras restaurar se RE-VERIFICA con las mismas
         verificaciones de motores y paquete, y ese resultado
         —no la sola restauración— es el que queda anotado. */
      const reverificacion = restaurado ? reverificacionTrasRestaurar232(HERE) : { ok: false };
      anotarActualizacion231('fallo', 'Tras copiar la versión ' + info.version +
        ', la huella de los motores no coincide con la del paquete: la instalación sigue mezclada. ' +
        (reverificacion.ok
          ? 'Restauración verificada: motores y paquete coinciden con el respaldo restaurado.'
          : 'Restauración NO verificada: lo restaurado no coincide con el respaldo (motores ' +
            (reverificacion.motores?.ok ? 'sí' : 'no') + ', paquete ' + (reverificacion.paquete?.ok ? 'sí' : 'no') + ').'));
      return;
    }
  }
  const verificacionPaquete = verificacionPaquete232(HERE, info.huellaPaquete);
  if (!verificacionPaquete.ok) {
    console.error('[ejecutor] tras copiar, la huella del paquete NO coincide con la anunciada: ' +
      'la instalación sigue mezclada; restauro el respaldo, lo re-verifico y lo reporto en el latido.');
    let restaurado = false;
    try { restaurado = restaurarRespaldo232(HERE); } catch { /* el respaldo queda en actualizacion-anterior para despertar.vbs */ }
    const reverificacion = restaurado ? reverificacionTrasRestaurar232(HERE) : { ok: false };
    anotarActualizacion231('fallo', 'Tras copiar la versión ' + info.version +
      ', la huella del paquete no coincide con la anunciada: la instalación sigue mezclada. ' +
      (reverificacion.ok
        ? 'Restauración verificada: motores y paquete coinciden con el respaldo restaurado.'
        : 'Restauración NO verificada: lo restaurado no coincide con el respaldo (motores ' +
          (reverificacion.motores?.ok ? 'sí' : 'no') + ', paquete ' + (reverificacion.paquete?.ok ? 'sí' : 'no') + ').'));
    return;
  }
  console.log('[ejecutor] actualizado a la versión ' + info.version + ': reinicio solo.');
  lanzarDespertador232(HERE);
  process.exit(42);
}

/* ---------- Motores y sesiones vivas por RFC ---------- */
function motores() {
  const storage = createFileEfirmaStorage(EFIRMA_DIR);
  const resolveCredentials = createSatDocCredentialResolver({ storage });
  const launchDriver = createPlaywrightDriverFactory({ executablePath: CHROMIUM, headless: !HEADED });
  return { decl: createSatDeclFetch({ resolveCredentials, launchDriver }),
    trib: createSatTribFetch({ resolveCredentials, launchDriver }),
    resolveCredentials, launchDriver };
}

const sesionesVivas = new Map();
async function cerrarSesionViva(rfc) {
  const viva = sesionesVivas.get(rfc);
  if (!viva) return;
  sesionesVivas.delete(rfc);
  await viva.driver.close().catch(() => {});
}
async function abrirSesionViva(rfc, m, onStep) {
  const creds = await m.resolveCredentials({ rfc });
  if (!creds) throw Object.assign(new Error('No hay e.firma guardada para ' + rfc +
    ': sin ella no se puede entrar al portal del SAT.'), { code: 'sin-efirma' });
  const driver = await m.launchDriver();
  try {
    const page = await driver.newPage();
    const keyMaterial = prepareKeyForPortal(creds.key, creds.password);
    await satBrowserLogin(page, { cer: creds.cer, key: keyMaterial.buffer,
      password: creds.password, rfc: creds.rfc || rfc, entryUrl: BUZON_LOGIN_URL,
      hooks: { step: text => onStep('Acceso: ' + text, '') } });
    onStep('Acceso al portal OK', 'la sesión queda viva unos minutos para la tanda de este RFC');
    const viva = { driver, page, creada: Date.now(), ultimoUso: Date.now() };
    sesionesVivas.set(rfc, viva);
    return viva;
  } catch (error) {
    await driver.close().catch(() => {});
    throw error;
  }
}
async function sesionVivaPara(rfc, m, onStep) {
  const viva = sesionesVivas.get(rfc);
  if (viva && Date.now() - viva.ultimoUso < SESION_VIVA_MS) {
    viva.ultimoUso = Date.now();
    return { ...viva, reutilizada: true };
  }
  if (viva) await cerrarSesionViva(rfc);
  const nueva = await abrirSesionViva(rfc, m, onStep);
  return { ...nueva, reutilizada: false };
}
async function podarSesionesVivas() {
  for (const [rfc, viva] of sesionesVivas)
    if (Date.now() - viva.ultimoUso >= SESION_VIVA_MS) await cerrarSesionViva(rfc);
}

const toB64 = content => Buffer.from(content).toString('base64');
function diagDe(error) {
  const diag = error?.diag;
  if (!diag) return undefined;
  return { screenshotBase64: diag.screenshot ? toB64(diag.screenshot) : '',
    html: diag.html ? String(diag.html) : '', url: String(diag.url || '') };
}
/* La página de DECISIÓN (1.32.1): la portada tal como quedó
   tras el acceso —o justo antes del salto al destino que
   resultó muerto—, que los motores adjuntan al error como
   diagDecision. Viaja ADEMÁS de la página final: la final
   puede ser la 404 genérica del SAT, que no dice nada; la de
   decisión enseña desde dónde se navegó y a qué URL. */
function diagDecisionDe(error) {
  const diag = error?.diagDecision;
  if (!diag) return undefined;
  return { screenshotBase64: diag.screenshot ? toB64(diag.screenshot) : '',
    html: diag.html ? String(diag.html) : '', url: String(diag.url || '') };
}
/* Evidencia de la página de RESULTADOS en las corridas de
   declaraciones (2.3.2, constructor P2): el motor la devuelve
   en su resultado como resultadosDiag (el diagnostics() de la
   página de resultados al concluir la lectura, con filas o con
   el vacío confirmado) y aquí viaja al servidor con la misma
   forma que diagDe — base64, foto + HTML + URL — para que el
   servidor la guarde como la foto/HTML de la corrida TAMBIÉN
   en las corridas buenas. Evidencia del defecto: las corridas
   del 17 nov 2026 (47496edb-5e1f-4f62-b1dc-07c08001f6ed y
   e0af7105-4c4c-4aa8-a773-8dfce3cb0e4a) cerraron ok:true con
   «Resultados leídos: 0 filas» y hasShot/hasHtml todos false:
   un 0 sin constancia se dio por bueno. */
export function resultadosDiagDe(result) {
  const diag = result?.resultadosDiag;
  if (!diag) return undefined;
  return { screenshotBase64: diag.screenshot ? toB64(diag.screenshot) : '',
    html: diag.html ? String(diag.html) : '', url: String(diag.url || '') };
}
/* Evidencia POR SECCIÓN del Buzón (2.9.3): la página de
   «Mis comunicados» o «Mis documentos» TAL COMO QUEDÓ cuando
   la sección concluyó o agotó su plazo — el motor la
   devuelve en su resultado como comunicadosDiag /
   documentosDiag, con el inventario de marcos de la página
   (la URL de cada marco y una muestra de su texto visible)
   — y aquí viaja al servidor con la misma forma que
   resultadosDiag, marcos incluidos. Evidencia del defecto:
   la corrida real 805fc97e (2.9.2, sede NAS) guardó la
   página de la BANDEJA y su corrida cerró con evidencia,
   pero comunicados volvió a no concluir y de ESA página no
   quedó nada que mirar: el artefacto guardado era el de la
   bandeja, no el momento de la sección. Puro y exportado,
   como resultadosDiagDe: la suite lo juzga sin portal. */
export function seccionDiagDe(diag) {
  if (!diag) return undefined;
  return { screenshotBase64: diag.screenshot ? toB64(diag.screenshot) : '',
    html: diag.html ? String(diag.html) : '', url: String(diag.url || ''),
    marcos: Array.isArray(diag.marcos) ? diag.marcos.map(marco => ({
      url: String(marco?.url || ''), texto: String(marco?.texto || '') })) : [] };
}
/* Buzón completo por la vía del ejecutor (2.4.0, WC1b): el
   motor (sat-tributario.mjs, castigo 4 de WC1) devuelve las
   secciones de «Mis comunicados» y «Mis documentos» en su
   resultado (comunicados/documentos) y aquí viajan al
   servidor TAL COMO el motor las devuelve — la misma
   referencia, sin copiar ni transformar ningún campo: su
   validación de forma es del protocolo (validateBuzonResult
   en sat-executor.mjs), no de este reenvío. Si el motor no
   las trae (réplicas viejas del motor), devuelve undefined
   y el resultado del trabajo no gana ningún campo: el
   servidor ya trata su ausencia como «no consta». Puro y
   exportado, como resultadosDiagDe: la suite lo juzga sin
   portal, porque ejecutarIntento no es importable. */
export function buzonSecciones240De(result) {
  if (!result) return undefined;
  const secciones = {};
  if (result.comunicados !== undefined) secciones.comunicados = result.comunicados;
  if (result.documentos !== undefined) secciones.documentos = result.documentos;
  return Object.keys(secciones).length ? secciones : undefined;
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/* Predicado puro del reintento con sesión fresca (2.3.2,
   FIX-B): en la corrida 1 se descarta la sesión y se reintenta
   UNA vez cuando (a) la sesión era REUTILIZADA y no respondió
   —el caso de siempre— O (b) el motor lanzó «ruta-muerta»,
   aunque la sesión sea FRESCA. El caso (b) es el contrato
   escrito en sat-tributario.mjs («para que el ejecutor
   descarte la sesión y reintente con un acceso fresco»): la
   evidencia viva del 17 nov ~14:57 CST (run buzon-listar
   1d36cce9) mostró una sesión recién abierta que el portal
   dejó en /app/seg/null; con la condición vieja (solo
   reutilizada) attempts quedó en 1 y el trabajo murió con la
   puerta abierta. Fuera de la corrida 1, o sin ninguno de los
   dos motivos, no hay reintento por esta vía. Puro y
   exportado: la suite lo juzga sin portal, porque
   ejecutarIntento no es importable. */
export function debeReintentarConSesionFresca232(error, sesion, corrida) {
  return corrida === 1 && Boolean(sesion?.reutilizada || error?.code === 'ruta-muerta');
}

/* Un intento de un trabajo: sesión (viva o nueva) + motor. Si la
   sesión REUTILIZADA muere a mitad, o el motor detecta la ruta
   muerta del portal (también con sesión fresca, FIX-B), se
   entra de nuevo y el motor se repite dentro del mismo
   intento — la tanda no se pierde por una sesión caducada del
   portal ni por la página muerta en la que el portal la dejó. */
async function ejecutarIntento(job, m, onStep) {
  const rfc = job.rfc;
  if (job.kind === 'puerta-probar') {
    /* La puerta se prueba EN FRÍO: sesión nueva, entrar y
       cerrar. Una sesión viva no acredita la puerta. */
    const creds = await m.resolveCredentials({ rfc });
    if (!creds) throw Object.assign(new Error('No hay e.firma guardada para ' + rfc +
      ': sin ella no se puede probar la puerta.'), { code: 'sin-efirma', enAcceso: true });
    onStep('Credenciales validadas', rfc);
    const driver = await m.launchDriver();
    try {
      const page = await driver.newPage();
      const keyMaterial = prepareKeyForPortal(creds.key, creds.password);
      await satBrowserLogin(page, { cer: creds.cer, key: keyMaterial.buffer,
        password: creds.password, rfc: creds.rfc || rfc, entryUrl: BUZON_LOGIN_URL,
        hooks: { step: text => onStep('Acceso: ' + text, '') } });
      onStep('Acceso al portal OK', 'la puerta abre: entro y vuelvo sin tocar ningún trámite');
    } catch (error) {
      /* El fallo ES de la puerta (1.32.1): queda marcado para
         que el resultado lo declare como accesoFallo y el
         servidor escriba el veredicto real en la puerta. */
      if (error && typeof error === 'object') error.enAcceso = true;
      throw error;
    } finally {
      await driver.close().catch(() => {});
    }
    /* La prueba de puerta ES una entrada en frío completada
       en esta corrida: accesoOk va siempre en true (1.31.0). */
    return { operations: ['entrar-con-efirma'], puerta: 'abre', accesoOk: true };
  }
  /* Adquisición de sesión (1.32.1): si la entrada misma cae
     —sin e.firma, credencial inválida o el portal rechaza el
     acceso—, el error nace marcado `enAcceso`: es un fallo DE
     LA PUERTA y el resultado lo declara como accesoFallo para
     que el servidor escriba el veredicto real. Si la sesión
     sale (fresca o reutilizada viva) y lo que cae es el
     corredor, el error terminal lleva `accesoOk` (ver el catch
     de la corrida): la puerta SÍ abrió en esta corrida — el
     caso del 14 nov, con la fila falsa sobreviviendo a una
     entrada buena seguida de un pasillo roto. */
  let sesion;
  try {
    sesion = await sesionVivaPara(rfc, m, onStep);
  } catch (error) {
    if (error && typeof error === 'object') error.enAcceso = true;
    throw error;
  }
  for (let corrida = 1; corrida <= 2; corrida++) {
    try {
      if (job.kind === 'buzon-listar') {
        const result = await m.trib({ rfc }, {}, { onStep, sesionViva: { page: sesion.page } });
        /* accesoOk (1.32.1): un corredor que COMPLETA bajo la
           sesión —fresca o reutilizada— acredita acceso real:
           la sesión estaba viva dentro del portal. */
        const salida = { operations: ['entrar-con-efirma', 'navegar-a-lista', 'leer-lista'],
          accesoOk: true,
          notifications: result.notifications || [],
          comunicadosNoLeidos: result.comunicadosNoLeidos ?? null,
          /* Buzón completo (2.4.0, WC1b): las secciones de
             «Mis comunicados» y «Mis documentos» se reenvían
             tal como el motor las devolvió; sin secciones en
             el motor, el resultado no gana ningún campo. */
          ...(buzonSecciones240De(result) || {}) };
        /* La evidencia de resultados viaja ADEMÁS del
           resultado (2.9.2, pieza B): la página de la bandeja
           que el motor capturó al leer la lista, con la misma
           forma que en declaraciones — el servidor la guarda
           como foto/HTML de la corrida también en las buenas
           (su espejo la esperaba desde la 2.4.0, castigo 28;
           lo que faltaba era este reenvío y que el motor la
           produjera). Solo cuando el motor la trajo: sin
           ella, el resultado no gana ningún campo. */
        const resultadosDiag = resultadosDiagDe(result);
        if (resultadosDiag) salida.resultadosDiag = resultadosDiag;
        /* La evidencia por sección viaja ADEMÁS (2.9.3): la
           página de «Mis comunicados» y la de «Mis
           documentos» tal como quedaron cuando cada sección
           concluyó o agotó su plazo, con su inventario de
           marcos — solo cuando el motor las trajo: sin ellas,
           el resultado no gana ningún campo. */
        const comunicadosDiag = seccionDiagDe(result.comunicadosDiag);
        if (comunicadosDiag) salida.comunicadosDiag = comunicadosDiag;
        const documentosDiag = seccionDiagDe(result.documentosDiag);
        if (documentosDiag) salida.documentosDiag = documentosDiag;
        return salida;
      }
      if (job.kind === 'declaraciones-recuperar' || job.kind === 'declaracion-folio' || job.kind === 'declaraciones-transacciones') {
        const query = job.kind === 'declaracion-folio'
          ? { tipo: 'folio', folio: job.payload.folio, tipoDeclaracion: job.payload.tipo || 'mensual',
              ejercicio: job.payload.ejercicio || 0, periodo: job.payload.periodo || '' }
          : job.kind === 'declaraciones-transacciones'
            ? { tipo: 'transacciones', ejercicio: job.payload.ejercicio || 0, periodo: '' }
            : { tipo: job.payload.tipo || 'mensual', ejercicio: job.payload.ejercicio || 0, periodo: job.payload.periodo || '' };
        const result = await m.decl({ rfc }, query, { onStep, sesionViva: { page: sesion.page } });
        /* accesoOk (1.32.1): como en el buzón, un corredor que
           completa bajo la sesión acredita acceso real. */
        const salida = { accesoOk: true,
          operations: job.kind === 'declaracion-folio' ? ['entrar-con-efirma', 'reimprimir-acuse-por-folio', 'descargar-pdf']
            : ['entrar-con-efirma', 'consultar-transacciones', 'descargar-pdf'],
          documents: (result.documents || []).map(doc => ({ tipo: query.tipo === 'anual' ? 'anual' : 'mensual',
            clase: doc.clase, ejercicio: doc.ejercicio, periodo: doc.periodo,
            fechaPresentacion: doc.fechaPresentacion || '', operacion: doc.operacion || '',
            contentBase64: toB64(doc.content) })),
          transactions: result.transactions || [], warnings: result.warnings || [] };
        /* La evidencia de resultados viaja ADEMÁS del resultado
           (2.3.2, P2): solo cuando el motor la trajo — las
           corridas de folio/transacciones no leen la consulta
           y no la traen — y sin cambiar la forma de siempre
           cuando no la hay. */
        const resultadosDiag = resultadosDiagDe(result);
        if (resultadosDiag) salida.resultadosDiag = resultadosDiag;
        /* «Seguir» real (2.3.0, pieza 6): SOLO declaraciones-
           recuperar lo honra — declaracion-folio y
           declaraciones-transacciones son atómicos y su
           resultado no cambia. Con soloFaltantes, los
           documentos de operaciones que ya tienen acuse se
           descartan aquí y el resultado solo lleva lo que
           faltaba; el progreso nombra las operaciones que
           ESTA corrida dejó con acuse, para que el servidor
           pueda reanudar sin repetir las que ya constan. */
        if (job.kind === 'declaraciones-recuperar') {
          const seguir = aplicarSeguir230(salida.documents, job.payload || {});
          salida.documents = seguir.documents;
          salida.progreso = seguir.progreso;
          if (seguir.saltadas.length) {
            onStep('Seguir', 'se saltan ' + seguir.saltadas.length +
              (seguir.saltadas.length === 1 ? ' operación que ya tenía acuse' : ' operaciones que ya tenían acuse'));
            salida.warnings = [...salida.warnings,
              'Seguir: ' + seguir.saltadas.length +
              (seguir.saltadas.length === 1 ? ' operación ya tenía acuse' : ' operaciones ya tenían acuse') +
              ' y no se repitió su documento.'];
          }
        }
        return salida;
      }
      if (job.kind === 'documento-sat') {
        throw Object.assign(new Error('Este ejecutor aún no descarga documentos sueltos del SAT: el trabajo queda registrado y el documento se pide desde su pantalla de siempre.'), { code: 'sin-manejador' });
      }
      throw Object.assign(new Error('Clase de trabajo no reconocida por este ejecutor: ' + job.kind), { code: 'sin-manejador' });
    } catch (error) {
      if (debeReintentarConSesionFresca232(error, sesion, corrida)) {
        /* Se descarta la sesión, se entra de nuevo y el motor
           se repite UNA vez. Queda en la traza, no en silencio.
           Si la NUEVA entrada cae, ese error sí es de la puerta
           y nace marcado (enAcceso, justo debajo). Dos motivos:
           la sesión heredada que no respondió —el caso de
           siempre— y la ruta muerta del portal, que también
           dispara el reintento con sesión FRESCA (FIX-B): el
           motor la lanza justo «para que el ejecutor descarte
           la sesión y reintente con un acceso fresco». */
        if (error?.code === 'ruta-muerta')
          onStep('La sesión quedó en la página muerta del portal', 'se descarta y se entra de nuevo con la e.firma');
        else
          onStep('La sesión reutilizada no respondió', 'se descarta y se entra de nuevo con la e.firma');
        await cerrarSesionViva(rfc);
        try {
          sesion = await sesionVivaPara(rfc, m, onStep);
        } catch (errorSesion) {
          if (errorSesion && typeof errorSesion === 'object') errorSesion.enAcceso = true;
          throw errorSesion;
        }
        continue;
      }
      /* Fallo terminal DEL CORREDOR (1.32.1): la sesión con la
         que el motor corrió estaba viva — si era reutilizada y
         es la primera corrida no se llega aquí (se reintenta
         con entrada fresca), y tampoco si era fresca pero el
         motor lanzó ruta-muerta en la primera corrida (FIX-B);
         en los demás casos con sesión fresca, su login se
         completó en esta corrida dentro de abrirSesionViva.
         La puerta abrió: el error lo declara para que el
         resultado lleve accesoOk aunque el trabajo falle. */
      if (error && typeof error === 'object' && !error.enAcceso) error.accesoOk = true;
      throw error;
    }
  }
  throw new Error('La corrida del trabajo terminó sin resultado.');
}

async function ejecutar(job) {
  const m = motores();
  const rfc = job.rfc;
  marcaSesion(rfc, { ultimoTrabajo: job.kind, estado: 'trabajando' });
  /* La traza es UNA y lleva la marca de intento en cada paso
     (el servidor la conserva): si hay reintento, el diario
     cuenta las dos variantes seguidas, sin maquillar. */
  const steps = [];
  const variantes = [];
  let ultimoError = null;
  for (let intento = 1; intento <= 2; intento++) {
    /* Cancelación remota (1.31.0): CADA paso consulta el
       conjunto de cancelados antes de anotarse — si Paco ya
       canceló este trabajo desde PacoSAT, el paso lanza
       «cancelado» y la corrida se detiene aquí, sin seguir
       navegando por un resultado que el servidor descartará. */
    const onStep = (paso, detalle) => {
      if (estaCancelado(job)) throw errorCancelado();
      steps.push({ at: Date.now(), intento, paso: String(paso || ''), detalle: String(detalle || '') });
    };
    try {
      /* Y también ANTES de empezar el intento: un trabajo que
         ya nació cancelado ni siquiera abre sesión. */
      if (estaCancelado(job)) throw errorCancelado();
      const parcial = await ejecutarIntento(job, m, onStep);
      marcaSesion(rfc, { estado: 'sesion-ok', ultimoOk: Date.now() });
      const result = { steps, ...parcial };
      /* accesoOk se propaga EXPLÍCITO al resultado final
         (1.31.0): es la señal que validateExecutorResult
         expone al servidor para refrescar la puerta. */
      result.accesoOk = parcial.accesoOk === true;
      if (variantes.length) result.warnings = [...(result.warnings || []),
        'El acceso entró al intento ' + intento + ': antes, ' +
        variantes.map(v => 'intento ' + v.intento + ' → ' + v.resultado).join(' · ')];
      return { status: 'done', result };
    } catch (error) {
      ultimoError = error;
      const kind = String(error?.code || '');
      variantes.push({ intento, resultado: kind || 'fallo' });
      /* Reintento con memoria (1.30.0): SOLO ante portal-rechaza
         — el acceso llegó a enviarse con el formulario verificado
         lleno (la guarda previa de satBrowserLogin no envía si
         algo va vacío), así que un rechazo es la variante
         inestable del portal, no un error de relleno. Un intento
         más, tras una pausa corta, y las dos variantes quedan
         registradas en la traza. */
      if (intento === 1 && kind === 'portal-rechaza') {
        await cerrarSesionViva(rfc);
        onStep('El portal rechazó el acceso con el formulario lleno',
          'variante inestable del portal: se espera ' + Math.round(REINTENTO_PORTAL_MS / 1000) + ' s y se reintenta una vez');
        await sleep(REINTENTO_PORTAL_MS);
        continue;
      }
      marcaSesion(rfc, { estado: 'fallo', ultimoError: String(error?.message || error).slice(0, 200) });
      /* Puerta veraz (1.32.1): el resultado fallido DECLARA el
         acceso — accesoOk si la puerta abrió en esta corrida
         aunque el corredor cayera después (marcado en
         ejecutarIntento), accesoFallo si la caída fue EN la
         entrada misma. Sin estas dos señales el servidor no
         puede distinguir «entró y falló dentro» de «no pudo
         entrar», y el veredicto de la puerta se quedaba con la
         última fila vieja (el caso del 14 nov). El diagnóstico
         viaja DOBLE: la página final y la de decisión (la
         portada desde la que se navegó al destino muerto). */
      return { status: 'failed', result: { steps, error: String(error?.message || error),
        errorKind: kind, accesoOk: error?.accesoOk === true,
        accesoFallo: error?.enAcceso === true,
        diag: diagDe(error), diagDecision: diagDecisionDe(error) } };
    }
  }
  /* Inalcanzable en la práctica: el bucle siempre devuelve. */
  return { status: 'failed', result: { steps, error: String(ultimoError?.message || ultimoError || 'Sin resultado'), errorKind: String(ultimoError?.code || '') } };
}

/* ================================================================
   RONDA 2.3.0 — piezas 5 y 6 (el sello EJECUTOR_VERSION no se
   toca aquí: la subida de versión es central, al empaquetar).
   ================================================================ */

/* ---------- Pieza 5: residencia e instancias VERIFICABLES ----------
   El latido deja de mandar {} y pasa a declarar la residencia
   LEÍDA de este equipo en cada pulso: estadoResidencia (en
   registro-windows.mjs, la misma pieza que asegura la
   residencia al arrancar — se reutiliza, no se duplica) dice
   si la clave Run apunta a este lanzador (registrada), si el
   protocolo pacosat:// apunta a este lanzador (protocolo) y
   si el marcador de rechazo de Paco manda (rechazada).
   Instancias: la instancia única de este ejecutor NO es un
   cerrojo dentro de este proceso — la garantiza el lanzador
   despertar.vbs, que antes de arrancar consulta por WMI si ya
   corre un node con el ejecutor-local.mjs de ESTA carpeta y,
   si corre, no arranca otro. El dato que se reporta es el de
   ESTE proceso: el que está latiendo es la instancia que
   ocupa el hueco, así que instancias = 1 — también fuera de
   Windows, donde el lanzador no corre y la forma se conserva
   con los hechos de registro a false. La lectura jamás tumba
   el ciclo: si algo falla, viaja la forma en false y el
   latido sigue. (2.3.2, M-4: instancias ya no es la constante
   de este texto — se mide con medirInstancias232 o no se
   manda; ver el bloque de instancia única más abajo.) */
/* ---------- Instancia única DE VERDAD (2.3.2, constructor B2a; E-04/M-4) ----------
   La 2.3.0 reportaba instancias = 1 como constante y arrancar.bat
   lanzaba node a pelo: el duplicado era posible y el servidor no
   podía verlo. Ahora hay un cerrojo real: al arrancar el bucle,
   el ejecutor toma ejecutor.lock en su carpeta con su PID y lo
   late (latido de fichero) en cada ciclo. Si el fichero nombra
   un PID vivo con latido fresco, el segundo proceso sale con un
   mensaje claro SIN latir ni reclamar trabajos. Un cerrojo con
   latido caducado o de un PID muerto se toma: un crash no deja
   la puerta cerrada para siempre. */
export const CERROJO_FICHERO232 = 'ejecutor.lock';
export const CERROJO_STALE232_MS = 90 * 1000;
function pidVivo232(pid) {
  if (!pid) return false;
  if (pid === process.pid) return true;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}
export function adquirirCerrojo232(dir = HERE, { ahora = Date.now(), staleMs = CERROJO_STALE232_MS } = {}) {
  const ruta = join(dir, CERROJO_FICHERO232);
  try {
    const datos = JSON.parse(readFileSync(ruta, 'utf8'));
    const pid = Number(datos?.pid) || 0;
    const latido = Number(datos?.latido) || 0;
    if (pid && pid !== process.pid && pidVivo232(pid) && (ahora - latido) < staleMs) {
      return { ok: false, pid, motivo: 'otra-instancia-viva' };
    }
  } catch { /* sin cerrojo legible: se toma */ }
  try { writeFileSync(ruta, JSON.stringify({ pid: process.pid, latido: ahora }), { mode: 0o600 }); }
  catch { return { ok: true, pid: process.pid, propio: false }; }
  return { ok: true, pid: process.pid, propio: true };
}
export function latidoCerrojo232(dir = HERE, { ahora = Date.now() } = {}) {
  const ruta = join(dir, CERROJO_FICHERO232);
  try {
    const datos = JSON.parse(readFileSync(ruta, 'utf8'));
    if (Number(datos?.pid) !== process.pid) return false;
    writeFileSync(ruta, JSON.stringify({ pid: process.pid, latido: ahora }), { mode: 0o600 });
    return true;
  } catch { return false; }
}
export function liberarCerrojo232(dir = HERE) {
  const ruta = join(dir, CERROJO_FICHERO232);
  try {
    const datos = JSON.parse(readFileSync(ruta, 'utf8'));
    if (Number(datos?.pid) === process.pid) unlinkSync(ruta);
    return true;
  } catch { return false; }
}
/* Medición de instancias: conteo REAL de procesos node con el
   ejecutor-local.mjs de ESTA carpeta — por WMI en Windows (la
   misma consulta que hace despertar.vbs) y por /proc en Linux.
   Si la medición no es fiable en el entorno (la consulta falla
   o no encuentra a este proceso, que se está contando a sí
   mismo), devuelve null y el campo instancias NO se manda:
   declarar un número sin medirlo fue el defecto E-04. */
export function medirInstancias232(dir = HERE) {
  if (process.platform === 'win32') {
    try {
      const salida = execFileSync('powershell', ['-NoProfile', '-Command',
        "$p = @(Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" | Where-Object { $_.CommandLine -like '*ejecutor-local.mjs*' }); $p.Count"],
        { encoding: 'utf8', timeout: 15000 });
      const n = Number(String(salida).trim());
      return Number.isInteger(n) && n >= 1 ? n : null;
    } catch { return null; }
  }
  if (process.platform === 'linux') {
    try {
      let cuenta = 0;
      for (const entrada of readdirSync('/proc')) {
        if (!/^[0-9]+$/.test(entrada)) continue;
        let cmdline = '';
        try { cmdline = readFileSync(join('/proc', entrada, 'cmdline'), 'utf8'); } catch { continue; }
        if (cmdline.includes('ejecutor-local.mjs')) cuenta++;
      }
      return cuenta >= 1 ? cuenta : null;
    } catch { return null; }
  }
  return null;
}
/* La constante de la 2.3.0 queda solo como referencia histórica:
   ya no se reporta — instancias se mide o no se manda (M-4). */
export const INSTANCIAS_ESTE_PROCESO230 = 1;
export async function residenciaLatido230({ dir, medirInstancias = medirInstancias232 } = {}) {
  const estado = await estadoResidencia(dir ? { dir } : {}).catch(() => null);
  const latidoResidencia = {
    registrada: estado?.registrada === true,
    protocolo: estado?.protocolo === true,
    rechazada: estado?.rechazada === true,
  };
  let instancias = null;
  try { instancias = medirInstancias(dir || HERE); } catch { instancias = null; }
  if (Number.isInteger(instancias) && instancias >= 1) latidoResidencia.instancias = instancias;
  return latidoResidencia;
}

/* ---------- Pieza 6: «Seguir» real en declaraciones ----------
   Funciones puras: la suite las juzga sin portal. La
   comparación de operaciones es por su forma sin espacios
   (la misma normalización que el protocolo del servidor
   aplica a los números de operación): «123 456» y «123456»
   son la misma operación. */
const operacionClave230 = valor => String(valor || '').replace(/\s+/g, '');
export function operacionesConAcuse230(payload = {}) {
  const lista = Array.isArray(payload?.operacionesConAcuse) ? payload.operacionesConAcuse : [];
  return [...new Set(lista.map(operacionClave230).filter(Boolean))];
}
/* Aplica el payload de «Seguir» a los documentos de UNA
   corrida de declaraciones-recuperar:
   - soloFaltantes !== true: los documentos pasan tal cual
     (la corrida es completa, como siempre);
   - soloFaltantes === true: se descartan los documentos de
     las operaciones que ya tienen acuse (las de la lista) y
     solo viaja lo que faltaba.
   En ambos casos el progreso nombra, sin repetir y en el
   orden en que quedaron, las operaciones que ESTA corrida
   dejó con acuse (documentos de clase «acuse» del resultado
   ya filtrado): ni las saltadas ni las de corridas ajenas. */
export function aplicarSeguir230(documents = [], payload = {}) {
  const yaConAcuse = new Set(operacionesConAcuse230(payload));
  const soloFaltantes = payload?.soloFaltantes === true;
  const saltadas = [];
  const quedan = [];
  for (const doc of documents || []) {
    const clave = operacionClave230(doc?.operacion);
    if (soloFaltantes && clave && yaConAcuse.has(clave)) {
      if (!saltadas.includes(clave)) saltadas.push(clave);
      continue;
    }
    quedan.push(doc);
  }
  const completadas = [];
  for (const doc of quedan) {
    const clave = operacionClave230(doc?.operacion);
    if (doc?.clase === 'acuse' && clave && !completadas.includes(clave)) completadas.push(clave);
  }
  return { documents: quedan, saltadas, progreso: { operacionesCompletadas: completadas } };
}

/* O7 (tanda 5, 2.0): modo ráfaga al reconectar. El servidor dice
   en el latido y en el reclamo cuántos trabajos quedan pendientes
   (`pendientes`); mientras la cola sea >0 el siguiente sondeo
   llega a los 3 s (dentro de la banda 2–5 s) y el reclamo pide
   hasta vaciarla — una cola acumulada durante una ausencia se
   vacía en segundos, no en pulsos de 20 s. Funciones puras: la
   suite las juzga sin proceso. */
export const executorPollDelay200e = ({ activos = 0, pendientes = 0 } = {}) =>
  (activos > 0 || pendientes > 0) ? 3000 : POLL_MS;
export const executorClaimLimit200e = pendientes =>
  Math.min(10, Math.max(3, Number(pendientes) || 0));

async function ciclo() {
  /* El latido alimenta la cancelación remota (1.31.0): el
     servidor responde `cancelados: [jobIds]` con los trabajos
     que Paco canceló mientras tanto — también los que este
     ciclo aún no reclamó y, sobre todo, el que puede estar
     corriéndose ahora mismo en este proceso. */
  /* Residencia verificable (2.3.0, pieza 5): cada latido lee
     el estado real de este equipo y lo manda en `residencia`;
     el servidor lo guarda tal cual. */
  const residencia = await residenciaLatido230();
  /* Verdad de versión (2.3.1, constructor B): cada latido lleva
     además el `reporte` — mi versión y la huella de mis motores
     recomputada en este pulso, más la novedad de la última
     comprobación de actualización cuando la hubo — para que
     una instalación mezclada se vea en el servidor en vez de
     pasar en silencio. */
  const latido = await api('/api/executor/heartbeat', { residencia, reporte: reporteVersion231() });
  if (Array.isArray(latido?.cancelados)) {
    for (const id of latido.cancelados) {
      if (id != null && id !== '') canceladosRemotos.add(String(id));
    }
  }
  const pendientesLatido = Number(latido?.pendientes) || 0;
  const respuesta = await api('/api/executor/claim', { limit: executorClaimLimit200e(pendientesLatido) });
  const trabajos = respuesta?.trabajos || [];
  for (const job of trabajos) {
    console.log('[ejecutor] trabajo ' + job.kind + ' · ' + job.rfc);
    const outcome = await ejecutar(job);
    await api('/api/executor/result', { jobId: job.id, ...outcome });
    console.log('[ejecutor] resultado enviado: ' + outcome.status);
  }
  await podarSesionesVivas();
  /* Pendientes tras el ciclo: el reclamo ya los trae contados
     DESPUÉS de repartir (quedan en cola); con un servidor viejo
     sin ese campo, se descuentan del latido los reclamados. */
  const pendientes = respuesta?.pendientes !== undefined ? Number(respuesta.pendientes) || 0 :
    Math.max(0, pendientesLatido - trabajos.length);
  return { activos: trabajos.length, pendientes };
}

export async function runExecutorLoop({ once = false } = {}) {
  if (!URL_BASE) throw new Error('Falta PACOSAT_URL.');
  await asegurarToken();
  if (!TOKEN) throw new Error('Faltan PACOSAT_EXECUTOR_TOKEN (o token.txt / codigo.txt para el primer canje).');
  if (!existsSync(EFIRMA_DIR)) mkdirSync(EFIRMA_DIR, { recursive: true, mode: 0o700 });
  /* Instancia única (2.3.2, M-4): el cerrojo se toma ANTES de
     latir o reclamar nada. Si otra instancia viva lo tiene,
     este proceso sale con el mensaje claro y sin tocar nada:
     ni un latido que pise al residente ni un trabajo doble. */
  const cerrojo = adquirirCerrojo232(HERE);
  if (!cerrojo.ok) {
    console.log('[ejecutor] ya hay otro ejecutor de PacoSAT corriendo en este equipo (proceso ' + cerrojo.pid +
      '): salgo sin latir ni reclamar trabajos. Si no es así, cierra aquel proceso y vuelve a abrir.');
    return;
  }
  process.once('exit', () => liberarCerrojo232(HERE));
  console.log('[ejecutor] PacoSAT ' + URL_BASE + ' · protocolo ' + SAT_EXECUTOR_PROTOCOL_VERSION +
    ' · ejecutor ' + EJECUTOR_VERSION + ' · e.firma local en ' + EFIRMA_DIR);
  /* Residencia (2.0.1, nº 31): el ejecutor se asegura SOLO, en su
     propio equipo, de que el protocolo pacosat:// y su arranque
     automático con Windows están registrados — idempotente,
     silencioso y solo en Windows; la e.firma no se mueve de aquí. */
  await asegurarResidencia().catch(() => {});
  /* Actualización periódica (2.3.2, M-5): la comprobación de
     arranque se repite dentro del bucle cada 6 h, y tras un
     fallo o un pendiente con espera creciente (1 h, 6 h, 24 h).
     Punto seguro elegido: la comprobación corre ENTRE ciclos —
     ciclo() reclama y ejecuta sus trabajos en secuencia, así
     que cuando vuelve, no hay ningún trabajo en curso en este
     proceso; si hay actualización, se aplica ahí o el proceso
     sale con 42, nunca a mitad de un trabajo. Los trabajos que
     el servidor tenga encolados esperan al proceso nuevo. */
  let ultimaComprobacion = Date.now();
  let fallosSeguidos = 0;
  const primera = (await comprobarActualizacion()) ?? 'fallo';
  if (primera === 'fallo' || primera === 'pendiente') fallosSeguidos = 1;
  do {
    let cicloRes = { activos: 0, pendientes: 0 };
    try { cicloRes = await ciclo(); } catch (error) { console.error('[ejecutor] ' + (error?.message || error)); }
    latidoCerrojo232(HERE);
    if (!once && Date.now() >= proximaComprobacion232({ ultima: ultimaComprobacion, fallosSeguidos })) {
      ultimaComprobacion = Date.now();
      const desenlace = (await comprobarActualizacion()) ?? 'fallo';
      fallosSeguidos = (desenlace === 'fallo' || desenlace === 'pendiente') ? fallosSeguidos + 1 : 0;
    }
    /* Sondeo adaptativo (1.31.1) llevado a su consecuencia
       (O7, tanda 5): en reposo, el pulso de siempre (20 s); si
       el ciclo movió trabajos O el servidor anuncia cola
       pendiente, el siguiente llega a los 3 s — tras una
       ausencia, la cola se vacía en segundos. */
    if (!once) await new Promise(resolve =>
      setTimeout(resolve, executorPollDelay200e(cicloRes)));
  } while (!once);
  liberarCerrojo232(HERE);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runExecutorLoop().catch(error => { console.error('[ejecutor] ' + (error?.message || error)); process.exitCode = 1; });
}
