/* ================================================================
   EJECUTOR LOCAL DE PACOSAT (1.29.0) — corre en el equipo de Paco.

   Qué es: el programa que, desde el equipo/Chrome de Paco (su
   sesión, su IP), recoge los trabajos que PacoSAT (en el NAS)
   encola, entra al portal del SAT con la e.firma custodiada EN
   ESTE EQUIPO para el RFC del trabajo, y devuelve la traza, los
   PDF y los números de operación para que PacoSAT los verifique
   y los archive. Sin este programa en línea, los trabajos quedan
   «esperando tu equipo» en PacoSAT: nadie finge un fallo del SAT.

   Configuración (variables de entorno, ninguna es una credencial
   del SAT):
   - PACOSAT_URL: la dirección de PacoSAT (la del NAS).
   - PACOSAT_EXECUTOR_TOKEN: el token de emparejamiento que la app
     enseña UNA vez al emparejar (Ajustes/Centro SAT → Ejecutor).
   - PACOSAT_EFIRMA_DIR: carpeta LOCAL de este equipo con la
     e.firma por RFC (la misma disposición que usa PacoSAT:
     <RFC>.cer, <RFC>.key y perfiles.json). Nunca sale de aquí:
     los trabajos y las trazas no llevan credenciales — el
     protocolo del servidor las rechaza si aparecieran.
   - PACOSAT_CHROMIUM_PATH: el Chrome/Chromium de este equipo.
   - PACOSAT_EJECUTOR_HEADED=1: navegador visible (por defecto
     visible: el primer acceso de cada RFC lo ves tú y la
     contraseña de la e.firma se teclea en tu entorno si el
     portal la pide en pantalla).

   Sesión por RFC: el ejecutor mantiene un registro de sesión por
   RFC (sesiones.json junto a este archivo, sin credenciales: solo
   marcas de tiempo y resultados) y nunca mezcla sesiones entre
   RFC. Con e.firma el SAT no pide captcha; la ruta CIEC queda
   fuera de este ejecutor a propósito (es la frágil).

   Uso:  node ejecutor-local.mjs
   ================================================================ */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSatDocCredentialResolver, createFileEfirmaStorage } from './sat-doc-fetch.mjs';
import { createPlaywrightDriverFactory } from './sat-doc-browser.mjs';
import { createSatDeclFetch } from './sat-declaraciones.mjs';
import { createSatTribFetch } from './sat-tributario.mjs';
import { SAT_EXECUTOR_PROTOCOL_VERSION } from './sat-executor.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const URL_BASE = String(process.env.PACOSAT_URL || '').replace(/\/$/, '');
const TOKEN = String(process.env.PACOSAT_EXECUTOR_TOKEN || '');
const EFIRMA_DIR = process.env.PACOSAT_EFIRMA_DIR || join(HERE, 'efirma-local');
const CHROMIUM = process.env.PACOSAT_CHROMIUM_PATH || '/usr/bin/chromium';
const HEADED = process.env.PACOSAT_EJECUTOR_HEADED !== '0';
const POLL_MS = Math.max(5000, Number(process.env.PACOSAT_EJECUTOR_POLL_MS) || 20000);
const SESIONES_FILE = join(HERE, 'ejecutor-sesiones.json');

function sesiones() {
  try { return JSON.parse(readFileSync(SESIONES_FILE, 'utf8')); } catch { return {}; }
}
function marcaSesion(rfc, datos) {
  const all = sesiones();
  all[rfc] = { ...(all[rfc] || {}), ...datos, actualizado: Date.now() };
  try { writeFileSync(SESIONES_FILE, JSON.stringify(all, null, 2), { mode: 0o600 }); } catch { /* el registro local nunca tumba una corrida */ }
}

async function api(path, body) {
  const res = await fetch(URL_BASE + path, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-PacoSAT-Executor': TOKEN },
    body: JSON.stringify(body || {}) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ('PacoSAT respondió ' + res.status));
  return data;
}

function motores() {
  const storage = createFileEfirmaStorage(EFIRMA_DIR);
  const resolveCredentials = createSatDocCredentialResolver({ storage });
  const launchDriver = createPlaywrightDriverFactory({ executablePath: CHROMIUM, headless: !HEADED });
  return { decl: createSatDeclFetch({ resolveCredentials, launchDriver }),
    trib: createSatTribFetch({ resolveCredentials, launchDriver }) };
}

const toB64 = content => Buffer.from(content).toString('base64');
function diagDe(error) {
  const diag = error?.diag;
  if (!diag) return undefined;
  return { screenshotBase64: diag.screenshot ? toB64(diag.screenshot) : '',
    html: diag.html ? String(diag.html) : '', url: String(diag.url || '') };
}

async function ejecutar(job) {
  const { decl, trib } = motores();
  const steps = [];
  const onStep = (paso, detalle) => steps.push({ at: Date.now(), paso: String(paso || ''), detalle: String(detalle || '') });
  const rfc = job.rfc;
  marcaSesion(rfc, { ultimoTrabajo: job.kind, estado: 'trabajando' });
  try {
    if (job.kind === 'buzon-listar') {
      const result = await trib({ rfc }, {}, { onStep });
      marcaSesion(rfc, { estado: 'sesion-ok', ultimoOk: Date.now() });
      return { status: 'done', result: { steps, operations: ['entrar-con-efirma', 'navegar-a-lista', 'leer-lista'],
        notifications: result.notifications || [] } };
    }
    if (job.kind === 'declaraciones-recuperar' || job.kind === 'declaracion-folio' || job.kind === 'declaraciones-transacciones') {
      const query = job.kind === 'declaracion-folio'
        ? { tipo: 'folio', folio: job.payload.folio, tipoDeclaracion: job.payload.tipo || 'mensual',
            ejercicio: job.payload.ejercicio || 0, periodo: job.payload.periodo || '' }
        : job.kind === 'declaraciones-transacciones'
          ? { tipo: 'transacciones', ejercicio: job.payload.ejercicio || 0, periodo: '' }
          : { tipo: job.payload.tipo || 'mensual', ejercicio: job.payload.ejercicio || 0, periodo: job.payload.periodo || '' };
      const result = await decl({ rfc }, query, { onStep });
      marcaSesion(rfc, { estado: 'sesion-ok', ultimoOk: Date.now() });
      return { status: 'done', result: { steps,
        operations: job.kind === 'declaracion-folio' ? ['entrar-con-efirma', 'reimprimir-acuse-por-folio', 'descargar-pdf']
          : ['entrar-con-efirma', 'consultar-transacciones', 'descargar-pdf'],
        documents: (result.documents || []).map(doc => ({ tipo: query.tipo === 'anual' ? 'anual' : 'mensual',
          clase: doc.clase, ejercicio: doc.ejercicio, periodo: doc.periodo,
          fechaPresentacion: doc.fechaPresentacion || '', operacion: doc.operacion || '',
          contentBase64: toB64(doc.content) })),
        transactions: result.transactions || [], warnings: result.warnings || [] } };
    }
    if (job.kind === 'documento-sat') {
      throw Object.assign(new Error('Este ejecutor aún no descarga documentos sueltos del SAT: el trabajo queda registrado y el documento se pide desde su pantalla de siempre.'), { code: 'sin-manejador' });
    }
    throw Object.assign(new Error('Clase de trabajo no reconocida por este ejecutor: ' + job.kind), { code: 'sin-manejador' });
  } catch (error) {
    marcaSesion(rfc, { estado: 'fallo', ultimoError: String(error?.message || error).slice(0, 200) });
    return { status: 'failed', result: { steps, error: String(error?.message || error),
      errorKind: String(error?.code || ''), diag: diagDe(error) } };
  }
}

async function ciclo() {
  await api('/api/executor/heartbeat', {});
  const { trabajos } = await api('/api/executor/claim', { limit: 3 });
  for (const job of trabajos || []) {
    console.log('[ejecutor] trabajo ' + job.kind + ' · ' + job.rfc);
    const outcome = await ejecutar(job);
    await api('/api/executor/result', { jobId: job.id, ...outcome });
    console.log('[ejecutor] resultado enviado: ' + outcome.status);
  }
}

export async function runExecutorLoop({ once = false } = {}) {
  if (!URL_BASE || !TOKEN) throw new Error('Faltan PACOSAT_URL o PACOSAT_EXECUTOR_TOKEN.');
  if (!existsSync(EFIRMA_DIR)) mkdirSync(EFIRMA_DIR, { recursive: true, mode: 0o700 });
  console.log('[ejecutor] PacoSAT ' + URL_BASE + ' · protocolo ' + SAT_EXECUTOR_PROTOCOL_VERSION +
    ' · e.firma local en ' + EFIRMA_DIR);
  do {
    try { await ciclo(); } catch (error) { console.error('[ejecutor] ' + (error?.message || error)); }
    if (!once) await new Promise(resolve => setTimeout(resolve, POLL_MS));
  } while (!once);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runExecutorLoop().catch(error => { console.error('[ejecutor] ' + (error?.message || error)); process.exitCode = 1; });
}
