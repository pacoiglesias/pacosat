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
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, copyFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { hostname } from 'node:os';
import { createSatDocCredentialResolver, createFileEfirmaStorage } from './sat-doc-fetch.mjs';
import { createPlaywrightDriverFactory, satBrowserLogin, prepareKeyForPortal } from './sat-doc-browser.mjs';
import { BUZON_LOGIN_URL } from './sat-tributario.mjs';
import { createSatDeclFetch } from './sat-declaraciones.mjs';
import { createSatTribFetch } from './sat-tributario.mjs';
import { SAT_EXECUTOR_PROTOCOL_VERSION } from './sat-executor.mjs';

export const EJECUTOR_VERSION = '1.32.2';

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
const PRESERVADOS_UPDATE = new Set(['token.txt', 'codigo.txt', 'ejecutor-sesiones.json', 'actualizacion.zip']);
async function comprobarActualizacion() {
  let info;
  try { info = await api('/api/executor/version', {}); } catch { return; }
  if (!info?.version || compararVersiones(info.version, EJECUTOR_VERSION) <= 0) return;
  if (process.platform !== 'win32') {
    console.log('[ejecutor] PacoSAT tiene la versión ' + info.version + ' del ejecutor, pero la ' +
      'actualización automática solo corre en Windows: actualiza a mano desde PacoSAT.');
    return;
  }
  const res = await fetch(URL_BASE + '/api/executor/bundle', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-PacoSAT-Executor': TOKEN }, body: '{}' });
  if (!res.ok) { console.error('[ejecutor] no se pudo bajar la actualización: no se toca nada.'); return; }
  const buf = Buffer.from(await res.arrayBuffer());
  const sha = createHash('sha256').update(buf).digest('hex');
  if (!info.sha256 || sha !== info.sha256) {
    console.error('[ejecutor] la actualización bajada NO coincide con la huella que PacoSAT anuncia: no se toca nada.');
    return;
  }
  const zipPath = join(HERE, 'actualizacion.zip');
  const tmpDir = join(HERE, 'actualizacion-tmp');
  writeFileSync(zipPath, buf);
  try {
    rmSync(tmpDir, { recursive: true, force: true });
    execFileSync('powershell', ['-NoProfile', '-Command',
      'Expand-Archive -LiteralPath $env:PACO_ZIP -DestinationPath $env:PACO_TMP -Force'],
      { env: { ...process.env, PACO_ZIP: zipPath, PACO_TMP: tmpDir }, stdio: 'pipe' });
    /* La carpeta efirma-local y los ficheros propios NUNCA se
       sobrescriben: la actualización trae código, no tus llaves. */
    const copiar = (origen, destino) => {
      for (const nombre of readdirSync(origen, { withFileTypes: true })) {
        if (nombre.name === 'efirma-local' || PRESERVADOS_UPDATE.has(nombre.name)) continue;
        const o = join(origen, nombre.name), d = join(destino, nombre.name);
        if (nombre.isDirectory()) { mkdirSync(d, { recursive: true }); copiar(o, d); }
        else copyFileSync(o, d);
      }
    };
    copiar(tmpDir, HERE);
  } catch (error) {
    console.error('[ejecutor] la actualización falló al aplicarse (' + (error?.message || error) + '): sigo con la versión de siempre.');
    return;
  } finally {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* limpieza menor */ }
    try { unlinkSync(zipPath); } catch { /* limpieza menor */ }
  }
  console.log('[ejecutor] actualizado a la versión ' + info.version + ': reinicio solo.');
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
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/* Un intento de un trabajo: sesión (viva o nueva) + motor. Si la
   sesión REUTILIZADA muere a mitad, se entra de nuevo y el motor
   se repite dentro del mismo intento — la tanda no se pierde
   por una sesión caducada del portal. */
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
        return { operations: ['entrar-con-efirma', 'navegar-a-lista', 'leer-lista'],
          accesoOk: true,
          notifications: result.notifications || [] };
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
        return { accesoOk: true,
          operations: job.kind === 'declaracion-folio' ? ['entrar-con-efirma', 'reimprimir-acuse-por-folio', 'descargar-pdf']
            : ['entrar-con-efirma', 'consultar-transacciones', 'descargar-pdf'],
          documents: (result.documents || []).map(doc => ({ tipo: query.tipo === 'anual' ? 'anual' : 'mensual',
            clase: doc.clase, ejercicio: doc.ejercicio, periodo: doc.periodo,
            fechaPresentacion: doc.fechaPresentacion || '', operacion: doc.operacion || '',
            contentBase64: toB64(doc.content) })),
          transactions: result.transactions || [], warnings: result.warnings || [] };
      }
      if (job.kind === 'documento-sat') {
        throw Object.assign(new Error('Este ejecutor aún no descarga documentos sueltos del SAT: el trabajo queda registrado y el documento se pide desde su pantalla de siempre.'), { code: 'sin-manejador' });
      }
      throw Object.assign(new Error('Clase de trabajo no reconocida por este ejecutor: ' + job.kind), { code: 'sin-manejador' });
    } catch (error) {
      if (corrida === 1 && sesion.reutilizada) {
        /* La sesión heredada no respondió: se descarta, se entra
           de nuevo y el motor se repite UNA vez. Queda en la
           traza, no en silencio. Si la NUEVA entrada cae, ese
           error sí es de la puerta y nace marcado. */
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
         con entrada fresca); si era fresca, su login se
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

async function ciclo() {
  /* El latido alimenta la cancelación remota (1.31.0): el
     servidor responde `cancelados: [jobIds]` con los trabajos
     que Paco canceló mientras tanto — también los que este
     ciclo aún no reclamó y, sobre todo, el que puede estar
     corriéndose ahora mismo en este proceso. */
  const latido = await api('/api/executor/heartbeat', {});
  if (Array.isArray(latido?.cancelados)) {
    for (const id of latido.cancelados) {
      if (id != null && id !== '') canceladosRemotos.add(String(id));
    }
  }
  const { trabajos } = await api('/api/executor/claim', { limit: 3 });
  for (const job of trabajos || []) {
    console.log('[ejecutor] trabajo ' + job.kind + ' · ' + job.rfc);
    const outcome = await ejecutar(job);
    await api('/api/executor/result', { jobId: job.id, ...outcome });
    console.log('[ejecutor] resultado enviado: ' + outcome.status);
  }
  await podarSesionesVivas();
  return (trabajos || []).length;
}

export async function runExecutorLoop({ once = false } = {}) {
  if (!URL_BASE) throw new Error('Falta PACOSAT_URL.');
  await asegurarToken();
  if (!TOKEN) throw new Error('Faltan PACOSAT_EXECUTOR_TOKEN (o token.txt / codigo.txt para el primer canje).');
  if (!existsSync(EFIRMA_DIR)) mkdirSync(EFIRMA_DIR, { recursive: true, mode: 0o700 });
  console.log('[ejecutor] PacoSAT ' + URL_BASE + ' · protocolo ' + SAT_EXECUTOR_PROTOCOL_VERSION +
    ' · ejecutor ' + EJECUTOR_VERSION + ' · e.firma local en ' + EFIRMA_DIR);
  await comprobarActualizacion();
  do {
    let activos = 0;
    try { activos = await ciclo(); } catch (error) { console.error('[ejecutor] ' + (error?.message || error)); }
    /* Sondeo adaptativo (1.31.1): en reposo, el pulso de
       siempre (20 s); si el ciclo acaba de mover trabajos, el
       siguiente llega a los 5 s — una ráfaga (mensuales de
       varios meses, puerta + trámite) no espera un pulso
       entero entre trabajo y trabajo, y el NAS no recibe ni
       una petición más cuando no hay nada. */
    if (!once) await new Promise(resolve =>
      setTimeout(resolve, activos > 0 ? Math.min(POLL_MS, 5000) : POLL_MS));
  } while (!once);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runExecutorLoop().catch(error => { console.error('[ejecutor] ' + (error?.message || error)); process.exitCode = 1; });
}
