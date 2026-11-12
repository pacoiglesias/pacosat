import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID, X509Certificate, scryptSync, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, statfsSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSatConnector, advanceSatJob } from './sat-direct.mjs';
import { parseXml, parseCfdiFull, fiscalSummary, crc32, zipXml, zipText, validateRfc } from './xml-core.mjs';
import { zipBuffers, buildXlsx, buildPdf, folioLabel, amountInWords } from './salidas-doc.mjs';
import { verificationUrl, qrMatrix } from './qr-cfdi.mjs';

/* La versión vive en package.json (la misma que sella la build del
   cliente); el servidor la lee al arrancar para firmar sus salidas. */
const APP_VERSION = (() => {
  try { return JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version || ''; }
  catch { return ''; }
})();
import { analyzeInvoicePdf } from './pdf-invoice.mjs';
import { createMonitor } from './sat-monitor.mjs';
import { LIST_CATALOG, parseList, declaredDate, listSeverity, SEVERITY_ORDER } from './sat-lists.mjs';
import { parseStatementText, extractPdfTextLines, moneyToCents } from './bank-statement.mjs';
import { encryptBackupBuffer, decryptBackupBuffer } from './backup-core.mjs';
import { createSatDocFetch, createFileEfirmaStorage, createSatDocCredentialResolver, CSF_ENTRY_URL, OPINION_ENTRY_URL } from './sat-doc-fetch.mjs';
import { createSatDocBrowserFetch, createSatDocPipelineFetch, createPlaywrightDriverFactory } from './sat-doc-browser.mjs';
import { createSatDeclFetch } from './sat-declaraciones.mjs';
import { createSatTribFetch, buzonPlazo } from './sat-tributario.mjs';
import { SAT_EXECUTOR_PROTOCOL_VERSION, buildExecutorJob, validateExecutorResult,
  classifyBuzonRow } from './sat-executor.mjs';
import { createSatCiecFetch, createCiecCredentialResolver } from './sat-ciec.mjs';
import { composeNewsMail, NEWS_MAIL_LIMIT } from './news-mail.mjs';
import { encryptIndexSecrets, decryptIndexSecrets, isEncryptedSecret } from './secret-box.mjs';
import { normalizarBeneficiario, construirPreparacion, preparacionTxt, MANOFIL_SEED, MANOFIL_SEED_RFC } from './pagos.mjs';
import { generateVapidKeys, sendWebPush } from './push.mjs';

/* El RFC se valida con validateRfc (xml-core): un solo criterio en todo el sistema. */
const DAY = 86400000;
const HOUR_MS = 3600000;
const MIN = 60000;
const formatDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit', day: '2-digit' });
const day = (date = Date.now()) => formatDay.format(date);
const clock = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Mexico_City', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const email = /^[a-z0-9.!#$%&'*+/=?^_\x60{|}~-]+@[a-z0-9.-]+\.[a-z]{2,63}$/i;
const MAX_BODY = 192 * 1024;
const validDate = input => /^\d{4}-\d{2}-\d{2}$/.test(input || '') && Number.isFinite(Date.parse(input)) && new Date(input).toISOString().slice(0, 10) === input;

/* CSP estricta sin comodín en línea (1.6.9): la política se calcula desde
   el HTML servido, autorizando por huella SHA-256 el único bloque
   <style> y el único bloque <script> de la copia — exactamente la
   misma política que build.mjs incrusta como meta en el artefacto
   (verify.cjs comprueba que coinciden y que no queda comodín en línea).
   La sustitución del token al servir no toca esos bloques. */
export function cspForHtml(html, extraScriptHashes = []) {
  const blockHash = tag => {
    const match = html.match(new RegExp('<' + tag + '>([\\s\\S]*?)</' + tag + '>'));
    return match ? "'sha256-" + createHash('sha256').update(match[1], 'utf8').digest('base64') + "'" : "'none'";
  };
  /* Huellas extra (1.24.0): las partes de carga diferida que el
     build sella en lazy.json; la política las autoriza por su
     huella exacta, sin comodines, igual que los bloques. */
  const extras = (extraScriptHashes || []).filter(hash => /^'sha256-[A-Za-z0-9+/=]+'$/.test(String(hash)));
  return "default-src 'none'; style-src " + blockHash('style') + "; script-src " + blockHash('script') +
    (extras.length ? ' ' + extras.join(' ') : '') +
    "; img-src data: blob:; frame-src blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
}

/* Blindaje 5002 (1.6.2). El SAT documenta oficialmente el error 5002
   («Se han agotado las solicitudes de por vida» / límite «con el mismo
   criterio», doc. WS v1.5) sin publicar la cifra; que el mismo criterio solo
   admite dos solicitudes es el criterio de la comunidad técnica (PhpCfdi).
   El criterio se identifica con precisión de segundos: RFC solicitante,
   sentido (emitidos/recibidos son operaciones separadas), tipo de solicitud,
   RFC emisor/receptor cuando se filtran, y fechas inicial y final exactas. */
const pad2 = value => String(value).padStart(2, '0');
/* Tiempos del servidor HTTP frente al proxy (1.13.1, pieza H): el
   keepAlive de Node nace en 5 s y el proxy (Caddy) reutiliza
   conexiones durante mucho más; si el servidor cierra un socket
   que el proxy está a punto de reutilizar, la respuesta se pierde
   con «connection reset by peer» aunque el dato ya se guardó —
   los 502 del 10 nov. El servidor queda como el último en cerrar:
   keepAliveTimeout 125 s (por encima del minuto largo del proxy)
   y headersTimeout un segundo por encima, como exige Node. */
export const PACOSAT_HTTP_TIMEOUTS = { keepAliveTimeout: 125000, headersTimeout: 126000, requestTimeout: 300000 };
export function pacosatShiftSecond(datetime, seconds = 1) {
  const [datePart, timePart] = datetime.split(' ');
  const [year, month, date] = datePart.split('-').map(Number);
  const [hour, minute, second] = timePart.split(':').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, date, hour, minute, second) + seconds * 1000);
  return shifted.getUTCFullYear() + '-' + pad2(shifted.getUTCMonth() + 1) + '-' + pad2(shifted.getUTCDate()) +
    ' ' + pad2(shifted.getUTCHours()) + ':' + pad2(shifted.getUTCMinutes()) + ':' + pad2(shifted.getUTCSeconds());
}
export function pacosatCriteriaKey(criteria) {
  return JSON.stringify([criteria.rfc, criteria.direction, criteria.type || 'cfdi',
    criteria.emitter || '', criteria.receiver || '', criteria.startAt, criteria.endAt]);
}
/* Corte de prescripción (1.23.0): menor ejercicio vivo Y tal que
   el 1 de abril de Y+6 aún no ha llegado — la anual de Y, presentada
   en marzo de Y+1, prescribe a los 5 años, el 1 de abril de Y+6.
   En 2026 el primer ejercicio vivo es 2021 (2020 prescribió el
   1-abr-2026); el 1-abr-2027 pasará a ser 2022. */
export function prescriptionLiveYear(time) {
  const t = Number(time) || 0;
  let year = new Date(t).getUTCFullYear() - 6;
  if (Date.UTC(year + 6, 3, 1) <= t) year += 1;
  return year;
}

function need(ok, message, status = 400) {
  if (!ok) throw Object.assign(new Error(message), { status });
}
function tx(db, work) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = work(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
function message(error) {
  return typeof error?.message === 'string' ? error.message.replace(/[\r\n]/g, ' ').slice(0, 220) : 'Error inesperado.';
}
function keyData(value) {
  need(typeof value === 'string' && value.length <= 48000 && /^[A-Za-z0-9+/]+={0,2}$/.test(value), 'El archivo de e.firma no es válido.');
  const decoded = Buffer.from(value, 'base64');
  need(decoded.length > 0 && decoded.length <= 32 * 1024, 'Archivo de e.firma demasiado grande.');
  return decoded;
}
function json(res, value, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}
async function body(req, limit = MAX_BODY) {
  let length = 0;
  const chunks = [];
  for await (const chunk of req) {
    length += chunk.length;
    need(length <= limit, 'Solicitud demasiado grande.', 413);
    chunks.push(chunk);
  }
  let data;
  try { data = JSON.parse(Buffer.concat(chunks)); }
  catch { need(false, 'Solicitud inválida.'); }
  need(data && typeof data === 'object' && !Array.isArray(data), 'Solicitud inválida.');
  return data;
}
async function productionConnector(credentials) {
  const [sdk, dom] = await Promise.all([
    import('@nodecfdi/sat-ws-descarga-masiva'), import('@xmldom/xmldom')
  ]).catch(() => { throw new Error('Faltan componentes del SAT. Ejecuta Iniciar-PacoSAT.cmd con internet para instalarlos.'); });
  const connector = createSatConnector(sdk, credentials);
  return { connector, parser: dom.DOMParser };
}

export function createPacoSATService({ dbFile, html, origin, proxyKey = '', makeConnector = productionConnector, makeMailer,
  analyzePdf = analyzeInvoicePdf, now = Date.now, monitorOptions = {}, watchDir = '', inboxParser = null, watchSettleMs = 2000, buildModified = null, efirmaDir = '', listFetch = null, officialLists = false, satDocFetch = null, satDeclFetch = null, satCiecFetch = null, satTribFetch = null, extractText = extractPdfTextLines, capacidades = null, lazyParts = null,
  satDocRetryWaitMs = 120000, portalProbeFetch = null, backupCeilingBytes = 100 * 1024 * 1024,
  makePushSender = null, makePaperlessUploader = null, executorMode = '' }) {
  /* Ejecutor local del SAT (1.29.0): con executorMode='remote', las
     corridas de Buzón Tributario y Declaraciones NO navegan desde
     este proceso: crean un trabajo para el ejecutor del equipo de
     Paco y quedan «esperando tu equipo». Sin la opción, manda el
     comportamiento de siempre (los puertos inyectados), que es lo
     que las baterías anteriores ejercitan. La producción (abajo)
     fija 'remote'. */
  const remoteExecutor = executorMode === 'remote';
  const cspHeader = cspForHtml(html, lazyParts?.partes ?
    Object.values(lazyParts.partes).map(part => part.hash) : []);
  const db = new DatabaseSync(dbFile);
  /* synchronous=FULL (1.6.15, mejora nº 4): en WAL el defecto es NORMAL
     y un corte de luz puede perder las últimas transacciones — justo el
     libro de criterios 5002 y la cola de solicitudes, cuya pérdida
     provocaría reenviar un criterio que el SAT ya contó. La base es
     pequeña y las escrituras pocas: el coste es inapreciable. */
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS profiles (rfc TEXT PRIMARY KEY, minutes INTEGER NOT NULL, days INTEGER NOT NULL,
      direction TEXT NOT NULL, nextRun INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '');
    CREATE TABLE IF NOT EXISTS jobs (id INTEGER PRIMARY KEY, rfc TEXT NOT NULL, direction TEXT NOT NULL,
      periodStart TEXT NOT NULL, periodEnd TEXT NOT NULL, requestId TEXT NOT NULL,
      status TEXT NOT NULL, imported TEXT NOT NULL DEFAULT '[]', due INTEGER NOT NULL,
      created INTEGER NOT NULL, error TEXT NOT NULL DEFAULT '', FOREIGN KEY(rfc) REFERENCES profiles(rfc));
    CREATE TABLE IF NOT EXISTS packages (id INTEGER PRIMARY KEY, job INTEGER NOT NULL, remoteId TEXT NOT NULL,
      rfc TEXT NOT NULL, archive BLOB, newCount INTEGER NOT NULL, review INTEGER NOT NULL,
      UNIQUE(job,remoteId), FOREIGN KEY(job) REFERENCES jobs(id));
    CREATE TABLE IF NOT EXISTS discovered (rfc TEXT NOT NULL, uuid TEXT NOT NULL, PRIMARY KEY(rfc,uuid));
    CREATE TABLE IF NOT EXISTS notices (id INTEGER PRIMARY KEY, package INTEGER NOT NULL UNIQUE,
      rfc TEXT NOT NULL, recipient TEXT NOT NULL, count INTEGER NOT NULL, due INTEGER NOT NULL,
      sent INTEGER, error TEXT NOT NULL DEFAULT '', FOREIGN KEY(package) REFERENCES packages(id));
    /* Correo de CFDI nuevos (1.22.0): cada comprobante que entra
       deja aquí su fila de detalle (la que pinta el correo) y cada
       OPERACIÓN (una recuperación, una descarga con varias
       pasadas, una importación de bandeja, una corrida CIEC) deja
       un solo aviso de su género, que el despachador agrupa en UN
       correo por operación. La fusión de avisos del mismo género
       en la misma ventana de gracia es lo que impide el «un correo
       por paquete» de antes: varios paquetes de la misma operación
       entran en ticks distintos pero caen en el mismo aviso. */
    CREATE TABLE IF NOT EXISTS news_notices (id INTEGER PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'sat',
      opkey TEXT NOT NULL DEFAULT '', rfc TEXT NOT NULL DEFAULT '', direction TEXT NOT NULL DEFAULT 'received',
      label TEXT NOT NULL DEFAULT '', recipient TEXT NOT NULL DEFAULT '', due INTEGER NOT NULL DEFAULT 0,
      sent INTEGER, error TEXT NOT NULL DEFAULT '');
    CREATE UNIQUE INDEX IF NOT EXISTS news_notices_open ON news_notices(opkey) WHERE sent IS NULL;
    CREATE TABLE IF NOT EXISTS news_items (id INTEGER PRIMARY KEY, notice INTEGER NOT NULL,
      uuid TEXT NOT NULL DEFAULT '', fecha TEXT NOT NULL DEFAULT '', counterpartName TEXT NOT NULL DEFAULT '',
      counterpartRfc TEXT NOT NULL DEFAULT '', folio TEXT NOT NULL DEFAULT '', serie TEXT NOT NULL DEFAULT '',
      total TEXT NOT NULL DEFAULT '', estado TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT 'I',
      direction TEXT NOT NULL DEFAULT '',
      UNIQUE(notice, uuid));
    CREATE TABLE IF NOT EXISTS records (store TEXT NOT NULL, id TEXT NOT NULL, value TEXT, data BLOB, mime TEXT,
      PRIMARY KEY(store,id));
    /* Sync por diferencias (1.7.0, mejora nº 10): cada registro lleva
       una revisión global creciente y los borrados dejan lápida, para
       que la app copie solo lo que cambió desde su última marca. */
    CREATE TABLE IF NOT EXISTS record_tombstones (store TEXT NOT NULL, id TEXT NOT NULL, rev INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS access_log (at INTEGER NOT NULL DEFAULT 0, kind TEXT NOT NULL DEFAULT '', detail TEXT NOT NULL DEFAULT '');
    CREATE TABLE IF NOT EXISTS alerts (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, ref TEXT NOT NULL UNIQUE,
      subject TEXT NOT NULL, body TEXT NOT NULL, due INTEGER NOT NULL,
      sent INTEGER, error TEXT NOT NULL DEFAULT '', rfc TEXT NOT NULL DEFAULT '');
    CREATE TABLE IF NOT EXISTS alert_state (key TEXT PRIMARY KEY, failures INTEGER NOT NULL DEFAULT 0,
      alerted INTEGER NOT NULL DEFAULT 0);
    /* Registro unificado (1.28.0, P1): solo lo que ningún diario
       guarda hoy — acciones del administrador hechas desde la app e
       historial de corridas de respaldo (antes solo sobrevivía el
       último estado). El resto del Registro es una proyección de
       lectura sobre los diarios, access_log, activity y mail_sends. */
    CREATE TABLE IF NOT EXISTS audit_events (id INTEGER PRIMARY KEY, at INTEGER NOT NULL DEFAULT 0,
      clase TEXT NOT NULL DEFAULT 'accion', rfc TEXT NOT NULL DEFAULT '',
      texto TEXT NOT NULL DEFAULT '', ok INTEGER NOT NULL DEFAULT 1);
    /* Buzón del resumen de sucesos (1.13.1, pieza G): los avisos
       individuales que el tope horario de correos detiene se copian
       aquí y salen dentro del resumen único del día. Nada se pierde
       y nada se manda suelto por encima del tope. */
    CREATE TABLE IF NOT EXISTS event_digest (id INTEGER PRIMARY KEY, at INTEGER NOT NULL DEFAULT 0,
      subject TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '', sent INTEGER,
      rfc TEXT NOT NULL DEFAULT '');
    CREATE TABLE IF NOT EXISTS automation_state (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '');
    CREATE TABLE IF NOT EXISTS criteria (id INTEGER PRIMARY KEY, key TEXT NOT NULL,
      rfc TEXT NOT NULL, direction TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'cfdi',
      emitter TEXT NOT NULL DEFAULT '', receiver TEXT NOT NULL DEFAULT '',
      startAt TEXT NOT NULL, endAt TEXT NOT NULL, requestId TEXT NOT NULL DEFAULT '',
      origin TEXT NOT NULL DEFAULT 'manual', sentAt INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS criteria_key_idx ON criteria(key);
    CREATE TABLE IF NOT EXISTS criteria_exhausted (key TEXT PRIMARY KEY,
      learnedAt INTEGER NOT NULL, detail TEXT NOT NULL DEFAULT '');
    /* Rescate 5002 (ronda anti-5002): criterios quemados cuyo contenido
       se recuperó por el canal aparte del portal web del SAT y entró por
       la carpeta vigilada. El criterio sigue agotado ante el SAT; lo que
       cambia es que su contenido ya está en el expediente. */
    CREATE TABLE IF NOT EXISTS criteria_rescued (key TEXT PRIMARY KEY,
      rescuedAt INTEGER NOT NULL, count INTEGER NOT NULL DEFAULT 0, detail TEXT NOT NULL DEFAULT '');
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '');
    /* Metadatos del SAT (1.6.10): registros ligeros de las solicitudes
       tipo Metadata, para reconciliar cobertura sin descargar XML. El
       estado (1 vigente / 0 cancelado) es el que el SAT reportaba en el
       paquete: sirve de estado inicial de cada CFDI. */
    CREATE TABLE IF NOT EXISTS metadata_records (uuid TEXT PRIMARY KEY, rfc TEXT NOT NULL,
      direction TEXT NOT NULL, emitter TEXT NOT NULL DEFAULT '', receiver TEXT NOT NULL DEFAULT '',
      issuedAt TEXT NOT NULL DEFAULT '', total TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT '',
      cancelDate TEXT NOT NULL DEFAULT '', seenAt INTEGER NOT NULL DEFAULT 0);
    /* Listas negras vivas (1.6.13): metadatos por listado, entradas
       (datos públicos re-descargables: NO viajan en los respaldos),
       padrón de contrapartes y registro de cambios detectados. */
    CREATE TABLE IF NOT EXISTS blacklist_meta (listId TEXT PRIMARY KEY, fetched INTEGER, next INTEGER NOT NULL DEFAULT 0,
      count INTEGER NOT NULL DEFAULT 0, declared TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '');
    CREATE TABLE IF NOT EXISTS blacklist_entries (listId TEXT NOT NULL, rfc TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '', detail TEXT NOT NULL DEFAULT '', PRIMARY KEY (listId, rfc));
    CREATE TABLE IF NOT EXISTS counterparts (rfc TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT 'manual',
      updated INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS list_events (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, listId TEXT NOT NULL,
      rfc TEXT NOT NULL, change TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '');
    /* Constancias y opinión (1.6.14): registro de documentos del SAT
       por RFC — la descarga automática deja aquí cada intento; el PDF
       vive en Expedientes (records) y esta tabla guarda su edad. */
    CREATE TABLE IF NOT EXISTS sat_documents (id TEXT PRIMARY KEY, rfc TEXT NOT NULL, kind TEXT NOT NULL,
      issuedAt INTEGER NOT NULL DEFAULT 0, fileId TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT 'auto',
      created INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '');
    /* Diario de corridas del descargador (1.10.1): cada intento de
       descarga —automático o a mano— deja su diario con los pasos
       en lenguaje llano (hora y URL de cada paso) y, si falló
       dentro del navegador, la captura de pantalla y el volcado
       HTML de la página en el punto del fallo (records 'files',
       ids shotId/htmlId), para revisar el error sin repetir la
       corrida. Se conservan las últimas 20 por RFC. */
    CREATE TABLE IF NOT EXISTS sat_doc_runs (id TEXT PRIMARY KEY, rfc TEXT NOT NULL, kind TEXT NOT NULL,
      started INTEGER NOT NULL DEFAULT 0, finished INTEGER NOT NULL DEFAULT 0, ok INTEGER NOT NULL DEFAULT 0,
      error TEXT NOT NULL DEFAULT '', errorKind TEXT NOT NULL DEFAULT '', steps TEXT NOT NULL DEFAULT '[]',
      shotId TEXT NOT NULL DEFAULT '', htmlId TEXT NOT NULL DEFAULT '');
    /* Diario de corridas de la descarga por CIEC (1.12.0): la misma
       idea que el diario del descargador de documentos — pasos en
       lenguaje llano y, si el fallo ocurrió dentro del navegador,
       captura y HTML de la página — más la cuenta de la corrida
       (encontradas/descargadas/nuevas/duplicadas). Últimas 20 por
       RFC, como las demás. */
    CREATE TABLE IF NOT EXISTS ciec_runs (id TEXT PRIMARY KEY, rfc TEXT NOT NULL,
      started INTEGER NOT NULL DEFAULT 0, finished INTEGER NOT NULL DEFAULT 0, ok INTEGER NOT NULL DEFAULT 0,
      error TEXT NOT NULL DEFAULT '', errorKind TEXT NOT NULL DEFAULT '', steps TEXT NOT NULL DEFAULT '[]',
      shotId TEXT NOT NULL DEFAULT '', htmlId TEXT NOT NULL DEFAULT '',
      found INTEGER NOT NULL DEFAULT 0, downloaded INTEGER NOT NULL DEFAULT 0,
      added INTEGER NOT NULL DEFAULT 0, duplicates INTEGER NOT NULL DEFAULT 0);
    /* Bitácora de correos enviados desde la app (1.6.16). */
    /* Bancos (1.6.19): cuentas libres, estados archivados con su
       lectura y movimientos para la conciliación de Dinero. */
    CREATE TABLE IF NOT EXISTS bank_accounts (id TEXT PRIMARY KEY, bank TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL DEFAULT '', last4 TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT '',
      created INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS bank_statements (id TEXT PRIMARY KEY, accountId TEXT NOT NULL, month TEXT NOT NULL,
      fileId TEXT NOT NULL DEFAULT '', openingCents INTEGER, closingCents INTEGER, creditsCents INTEGER,
      chargesCents INTEGER, movements INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'review',
      detected TEXT NOT NULL DEFAULT '', created INTEGER NOT NULL DEFAULT 0, UNIQUE(accountId, month));
    CREATE TABLE IF NOT EXISTS bank_movements (id TEXT PRIMARY KEY, statementId TEXT NOT NULL, date TEXT NOT NULL DEFAULT '',
      concept TEXT NOT NULL DEFAULT '', amountCents INTEGER NOT NULL DEFAULT 0, balanceCents INTEGER);
    /* Declaraciones y acuses (1.9.0, punto 7): cada documento
       recuperado del portal —declaración y acuse como documentos
       DISTINTOS— con su ejercicio, periodo, fecha de presentación
       y número de operación; el PDF vive en Expedientes (records). */
    CREATE TABLE IF NOT EXISTS declaraciones (id TEXT PRIMARY KEY, rfc TEXT NOT NULL, tipo TEXT NOT NULL DEFAULT 'mensual',
      clase TEXT NOT NULL DEFAULT 'acuse', ejercicio INTEGER NOT NULL DEFAULT 0, periodo TEXT NOT NULL DEFAULT '',
      fechaPresentacion TEXT NOT NULL DEFAULT '', operacion TEXT NOT NULL DEFAULT '',
      fileId TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT 'auto',
      created INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '', errorKind TEXT NOT NULL DEFAULT '');
    /* Diario de corridas de declaraciones (1.23.0, frente A3):
       cada recuperación deja su corrida con los pasos en texto
       corto (steps JSON: at, intento, paso, detalle), su resultado
       y el número de intentos. Se conservan las últimas 20 por RFC,
       como sat_doc_runs. */
    CREATE TABLE IF NOT EXISTS decl_runs (id TEXT PRIMARY KEY, rfc TEXT NOT NULL DEFAULT '', tipo TEXT NOT NULL DEFAULT '',
      ejercicio INTEGER NOT NULL DEFAULT 0, periodo TEXT NOT NULL DEFAULT '',
      started INTEGER NOT NULL DEFAULT 0, finished INTEGER NOT NULL DEFAULT 0, ok INTEGER NOT NULL DEFAULT 0,
      error TEXT NOT NULL DEFAULT '', errorKind TEXT NOT NULL DEFAULT '', steps TEXT NOT NULL DEFAULT '[]',
      attempts INTEGER NOT NULL DEFAULT 0,
      shotId TEXT NOT NULL DEFAULT '', htmlId TEXT NOT NULL DEFAULT '');
    /* Marcas de leído del Buzón (1.23.0, frente B): un CFDI recibido
       o un documento del SAT consta leído solo si existe su marca
       para ese RFC; sin marca, es «no leído». */
    CREATE TABLE IF NOT EXISTS buzon_marks (rfc TEXT, itemKey TEXT, readAt INTEGER DEFAULT 0,
      PRIMARY KEY(rfc,itemKey));
    /* Buzón Tributario del SAT (1.24.0, punto 1): el diario de
       consultas (patrón decl_runs) y las notificaciones LISTADAS
       —nunca abiertas por la máquina— como registros consultables
       por RFC. La clave resume fecha+asunto+remitente: la misma
       notificación en dos consultas es la misma fila. */
    CREATE TABLE IF NOT EXISTS trib_runs (id TEXT PRIMARY KEY, rfc TEXT NOT NULL DEFAULT '',
      started INTEGER NOT NULL DEFAULT 0, finished INTEGER NOT NULL DEFAULT 0, ok INTEGER NOT NULL DEFAULT 0,
      error TEXT NOT NULL DEFAULT '', errorKind TEXT NOT NULL DEFAULT '', steps TEXT NOT NULL DEFAULT '[]',
      attempts INTEGER NOT NULL DEFAULT 0, encontradas INTEGER NOT NULL DEFAULT 0, sinAbrir INTEGER NOT NULL DEFAULT 0,
      shotId TEXT NOT NULL DEFAULT '', htmlId TEXT NOT NULL DEFAULT '');
    CREATE TABLE IF NOT EXISTS trib_notifications (rfc TEXT NOT NULL, clave TEXT NOT NULL,
      fecha TEXT NOT NULL DEFAULT '', asunto TEXT NOT NULL DEFAULT '', remitente TEXT NOT NULL DEFAULT '',
      estado TEXT NOT NULL DEFAULT '', abierta INTEGER NOT NULL DEFAULT 0,
      primeraVez INTEGER NOT NULL DEFAULT 0, ultimaVez INTEGER NOT NULL DEFAULT 0,
      categoria TEXT NOT NULL DEFAULT 'atencion', archivada INTEGER NOT NULL DEFAULT 0,
      archivadaEn INTEGER NOT NULL DEFAULT 0,
      enPapelera INTEGER NOT NULL DEFAULT 0, papeleraEn INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(rfc, clave));
    /* Lápidas del Buzón Tributario (1.29.0, adenda de papelera):
       los identificadores de lo purgado quedan aquí para siempre:
       la sincronización con el SAT los reconoce y NUNCA los
       resucita, aunque el portal los siga listando. Guardan solo
       el identificador (la clave) y la marca de tiempo — el
       contenido purgado no se conserva en ningún sitio. */
    CREATE TABLE IF NOT EXISTS trib_tombstones (rfc TEXT NOT NULL, clave TEXT NOT NULL,
      creado INTEGER NOT NULL DEFAULT 0, motivo TEXT NOT NULL DEFAULT '',
      asunto TEXT NOT NULL DEFAULT '', PRIMARY KEY(rfc, clave));
    /* Ejecutor local del SAT (1.29.0): PacoSAT ordena, registra y
       archiva; el ejecutor del equipo de Paco navega el portal.
       sat_executors guarda SOLO la huella SHA-256 de su token de
       emparejamiento (el token en claro se enseña una vez al
       crearlo y vive en el ejecutor). sat_executor_jobs es la cola
       de trabajos con su traza completa; sat_executor_attempts
       conserva CADA intento por separado, para que el Registro
       pueda abrir el detalle de un intento concreto aunque el
       trabajo se reintente después. Ninguna de las tres tablas
       guarda credenciales del SAT: el protocolo las prohíbe. */
    CREATE TABLE IF NOT EXISTS sat_executors (id TEXT PRIMARY KEY, nombre TEXT NOT NULL DEFAULT '',
      tokenHash TEXT NOT NULL DEFAULT '', creado INTEGER NOT NULL DEFAULT 0,
      ultimoVisto INTEGER NOT NULL DEFAULT 0, revocado INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS sat_executor_jobs (id TEXT PRIMARY KEY, dedupeKey TEXT NOT NULL DEFAULT '',
      rfc TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT '', payload TEXT NOT NULL DEFAULT '{}',
      plan TEXT NOT NULL DEFAULT '[]', estado TEXT NOT NULL DEFAULT 'en-cola',
      creado INTEGER NOT NULL DEFAULT 0, actualizado INTEGER NOT NULL DEFAULT 0,
      reclamadoPor TEXT NOT NULL DEFAULT '', reclamadoEn INTEGER NOT NULL DEFAULT 0,
      leaseHasta INTEGER NOT NULL DEFAULT 0, intentos INTEGER NOT NULL DEFAULT 0,
      steps TEXT NOT NULL DEFAULT '[]', error TEXT NOT NULL DEFAULT '', errorKind TEXT NOT NULL DEFAULT '',
      resumen TEXT NOT NULL DEFAULT '{}', shotId TEXT NOT NULL DEFAULT '', htmlId TEXT NOT NULL DEFAULT '',
      origen TEXT NOT NULL DEFAULT '');
    CREATE TABLE IF NOT EXISTS sat_executor_attempts (id TEXT PRIMARY KEY, jobId TEXT NOT NULL DEFAULT '',
      executorId TEXT NOT NULL DEFAULT '', started INTEGER NOT NULL DEFAULT 0, finished INTEGER NOT NULL DEFAULT 0,
      ok INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '', errorKind TEXT NOT NULL DEFAULT '',
      steps TEXT NOT NULL DEFAULT '[]', shotId TEXT NOT NULL DEFAULT '', htmlId TEXT NOT NULL DEFAULT '');
    /* Altas preparadas sin credenciales (1.24.0, punto 7): el RFC
       consta como contribuyente «faltan credenciales» hasta que su
       CIEC o su e.firma se guarden desde el Centro SAT. */
    CREATE TABLE IF NOT EXISTS pending_profiles (rfc TEXT PRIMARY KEY,
      created INTEGER NOT NULL DEFAULT 0, nota TEXT NOT NULL DEFAULT '');
    /* ===== Ronda 1.25.0 — «LAS 20 DE PACO» =====
       Registro de folios de declaraciones (mejora nº 1): el
       servicio oficial de acuses (PTSC 77792) reimprime POR FOLIO
       conocido, no busca por ejercicio; el folio se guarda aquí
       —a mano o solo, cuando una búsqueda lo revela— y su acuse
       se reimprime folio a folio. */
    CREATE TABLE IF NOT EXISTS decl_folios (id TEXT PRIMARY KEY, rfc TEXT NOT NULL DEFAULT '',
      tipo TEXT NOT NULL DEFAULT 'mensual', ejercicio INTEGER NOT NULL DEFAULT 0,
      periodo TEXT NOT NULL DEFAULT '', folio TEXT NOT NULL DEFAULT '',
      estado TEXT NOT NULL DEFAULT 'pendiente', nota TEXT NOT NULL DEFAULT '',
      creado INTEGER NOT NULL DEFAULT 0, actualizado INTEGER NOT NULL DEFAULT 0);
    /* Recordatorios de cobro (AGREGAR 5): BORRADORES que solo
       salen con el toque de Paco; nacen de un aviso de saldo por
       cobrar y guardan su texto editable y su destino. */
    CREATE TABLE IF NOT EXISTS reminders (id TEXT PRIMARY KEY, avisoRef TEXT NOT NULL DEFAULT '',
      rfc TEXT NOT NULL DEFAULT '', contraparte TEXT NOT NULL DEFAULT '', nombre TEXT NOT NULL DEFAULT '',
      uuid TEXT NOT NULL DEFAULT '', asunto TEXT NOT NULL DEFAULT '', cuerpo TEXT NOT NULL DEFAULT '',
      destino TEXT NOT NULL DEFAULT '', estado TEXT NOT NULL DEFAULT 'borrador',
      creado INTEGER NOT NULL DEFAULT 0, enviado INTEGER NOT NULL DEFAULT 0);
    /* Suscripciones Web Push (AGREGAR 9): el endpoint del
       navegador y sus claves públicas de cifrado; la privada del
       navegador nunca sale de él. */
    CREATE TABLE IF NOT EXISTS push_subscriptions (endpoint TEXT PRIMARY KEY,
      p256dh TEXT NOT NULL DEFAULT '', auth TEXT NOT NULL DEFAULT '',
      creado INTEGER NOT NULL DEFAULT 0);
    /* Cola del puente a Paperless (AGREGAR 2): cada documento
       archivado (constancia, opinión, acuses) espera aquí su
       subida con sus etiquetas; un fallo no pierde el documento
       —sigue en PacoSAT— y la cola se reintenta sola. */
    CREATE TABLE IF NOT EXISTS paperless_queue (id TEXT PRIMARY KEY, fileId TEXT NOT NULL DEFAULT '',
      titulo TEXT NOT NULL DEFAULT '', etiquetas TEXT NOT NULL DEFAULT '[]',
      estado TEXT NOT NULL DEFAULT 'pendiente', error TEXT NOT NULL DEFAULT '',
      creado INTEGER NOT NULL DEFAULT 0, enviado INTEGER NOT NULL DEFAULT 0);
    /* Pagos al banco (1.10.0): catálogo de beneficiarios por RFC
       dueño (payload = la ficha completa validada) y preparaciones
       de pago generadas, con sus cifras de control. */
    CREATE TABLE IF NOT EXISTS pay_beneficiaries (id TEXT PRIMARY KEY, rfc TEXT NOT NULL,
      nombre TEXT NOT NULL DEFAULT '', payload TEXT NOT NULL DEFAULT '{}',
      created INTEGER NOT NULL DEFAULT 0, updated INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS pay_preparations (id TEXT PRIMARY KEY, rfc TEXT NOT NULL,
      month TEXT NOT NULL DEFAULT '', total TEXT NOT NULL DEFAULT '0', operaciones INTEGER NOT NULL DEFAULT 0,
      payload TEXT NOT NULL DEFAULT '{}', created INTEGER NOT NULL DEFAULT 0);
    /* Conciliación asistida (1.9.0, punto 5 del plan): la decisión
       de vincular un movimiento con uno o varios CFDI queda
       REGISTRADA y se puede deshacer; deshacer no borra la fila,
       la marca, para que el historial diga qué pasó. */
    CREATE TABLE IF NOT EXISTS bank_matches (id TEXT PRIMARY KEY, movementId TEXT NOT NULL,
      invoices TEXT NOT NULL DEFAULT '[]', mode TEXT NOT NULL DEFAULT 'total',
      amountCents INTEGER NOT NULL DEFAULT 0, why TEXT NOT NULL DEFAULT '',
      estado TEXT NOT NULL DEFAULT 'activo', created INTEGER NOT NULL DEFAULT 0,
      undone INTEGER NOT NULL DEFAULT 0);
    /* Movimientos marcados a mano como «sin factura legítimo»
       (comisión, impuesto, traspaso): salen de los sin identificar
       del cierre sin fingir una conciliación. */
    CREATE TABLE IF NOT EXISTS bank_movement_marks (movementId TEXT PRIMARY KEY,
      estado TEXT NOT NULL DEFAULT '', nota TEXT NOT NULL DEFAULT '', at INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS mail_sends (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, recipients TEXT NOT NULL DEFAULT '',
      subject TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT '', ok INTEGER NOT NULL DEFAULT 0,
      error TEXT NOT NULL DEFAULT '', rfc TEXT NOT NULL DEFAULT '');
    /* Intentos de descarga por paquete (1.6.15, mejora nº 3): el SAT
       permite como máximo 2 descargas por paquete (error 5008); el
       contador se persiste ANTES de cada descarga, como la intención
       de la mejora nº 1. Tabla aparte para no interferir con la fila
       del paquete importado. */
    CREATE TABLE IF NOT EXISTS package_attempts (job INTEGER NOT NULL, remoteId TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (job, remoteId));
    /* Centro de Avisos (1.7.4, pieza 2): los avisos viven DENTRO del
       sistema, en tres clases (mal / falta / necesita), con estado
       «por-confirmar» para cobros y pagos, historial de solventados y
       bitácora de acciones. El correo deja de ser por aviso: como
       mucho sale UN resumen (digest) y la columna correo marca qué
       avisos ya entraron en un resumen enviado. */
    CREATE TABLE IF NOT EXISTS avisos (id INTEGER PRIMARY KEY, ref TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL DEFAULT '', clase TEXT NOT NULL DEFAULT 'falta',
      estado TEXT NOT NULL DEFAULT 'abierto', severidad TEXT NOT NULL DEFAULT 'media',
      titulo TEXT NOT NULL DEFAULT '', detalle TEXT NOT NULL DEFAULT '',
      contraparte TEXT NOT NULL DEFAULT '', nombre TEXT NOT NULL DEFAULT '',
      importe TEXT NOT NULL DEFAULT '', enlace TEXT NOT NULL DEFAULT '',
      datos TEXT NOT NULL DEFAULT '{}', baseline INTEGER NOT NULL DEFAULT 0,
      creado INTEGER NOT NULL DEFAULT 0, actualizado INTEGER NOT NULL DEFAULT 0,
      resuelto INTEGER, resolucion TEXT NOT NULL DEFAULT '', correo INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS avisos_acciones (id INTEGER PRIMARY KEY, aviso INTEGER NOT NULL,
      at INTEGER NOT NULL DEFAULT 0, accion TEXT NOT NULL DEFAULT '', nota TEXT NOT NULL DEFAULT '');
    /* Pagos marcados a mano (1.7.4): «Sí, ya pagó» con nota obligatoria
       cuenta como pago enlazado para el saldo, sin tocar el CFDI. */
    CREATE TABLE IF NOT EXISTS manual_payments (uuid TEXT PRIMARY KEY, at INTEGER NOT NULL DEFAULT 0,
      nota TEXT NOT NULL DEFAULT '', importe TEXT NOT NULL DEFAULT '');`);
  const token = randomBytes(32).toString('hex');
  /* Datos del comprobante para los correos de cancelación (1.13.1,
     pieza G2): el aviso lleva TODO lo que Paco necesita para saber
     qué se canceló sin abrir la app — contraparte con nombre, fecha
     de emisión, serie/folio, importe, si era emitido o recibido y
     qué le hace a él en cada caso, estado anterior → nuevo, cuándo
     se detectó y si consta pagado o con saldo. La fuente es el
     registro guardado; el folio/serie viven en su desglose fiscal.
     Sin registro (solo vigilancia), se cae a los datos de la fila
     de vigilancia: emisor, receptor e importe de la consulta. */
  function cfdiMailFacts(id, watchItem) {
    const rec = recordInvoices().find(invoice => invoice.id === id);
    /* «Propio» = cualquier RFC del padrón de contribuyentes (la
       tienda people), tenga o no e.firma guardada: una cancelación
       de un CFDI emitido por un RFC de la casa es, en general,
       una cancelación hecha por la propia casa. */
    const profileRfcs = new Set([...db.prepare('SELECT rfc FROM profiles').all().map(row => row.rfc),
      ...db.prepare("SELECT value FROM records WHERE store='people'").all()
        .map(row => { try { return JSON.parse(row.value).id; } catch { return ''; } })].filter(Boolean));
    const emitter = rec?.from?.rfc || watchItem?.emitter || '';
    const receiver = rec?.to?.rfc || watchItem?.receiver || '';
    const emitido = profileRfcs.has(emitter);
    const contraparte = emitido ? { rfc: receiver, name: rec?.to?.name || '' } : { rfc: emitter, name: rec?.from?.name || '' };
    const balance = rec ? moneyBalances().find(item => item.id === id) : null;
    const paid = moneyPaidBy().get(id) || 0n;
    return { rec, emitido, contraparte,
      fecha: rec?.date ? String(rec.date).slice(0, 10) : '',
      serie: rec?.fiscal?.series || '', folio: rec?.fiscal?.folio || '',
      total: rec?.total || watchItem?.total || '',
      pagado: paid, saldo: balance && balance.balance > 0n ? balance.balance : 0n,
      pagadoCompleto: Boolean(balance) && balance.balance <= 0n && centsOf(rec?.total) > 0n };
  }
  const monitor = createMonitor(db, { now, notifyCancellation: async item => {
    /* Transición Vigente → Cancelado (1.13.1, piezas G/G2): es el
       ÚNICO caso de correo individual, y sale una sola vez en la
       vida del evento — la fila de cancellation_alert es la llave
       (una por UUID) y la alerta interna hereda su ref única; ni
       re-revisiones ni migraciones lo re-mandan, y ante la duda
       (la fila ya existe marcada) no se manda. El asunto y el
       cuerpo llevan los datos completos del comprobante. Entra
       también como alerta interna que el Centro de Avisos espeja
       en «Lo que está mal» con severidad alta. */
    const facts = cfdiMailFacts(item.id, item);
    const wasPaid = facts.pagado > 0n;
    const folioTxt = facts.folio ? ' · folio ' + (facts.serie ? facts.serie + '-' : '') + facts.folio : '';
    const subject = (wasPaid ? 'PacoSAT · ALERTA ROJA: CFDI cancelado DESPUÉS de pagado' : 'PacoSAT · CFDI cancelado') +
      (facts.total ? ' · $' + importeShow(facts.total) : '') +
      ' · ' + (facts.contraparte.name || facts.contraparte.rfc) + ' (' + facts.contraparte.rfc + ')' + folioTxt;
    const efecto = facts.emitido
      ? 'Era una factura EMITIDA por ti: si ya te la pagaron, el cobro quedó sin comprobante válido y toca verlo con tu contadora.'
      : 'Era una factura RECIBIDA: no la deduzcas ni acredites su IVA si aún no lo hiciste; si ya la dedujiste, avisa a tu contadora.';
    const lineas = [
      'Tipo: ' + (facts.emitido ? 'Emitido por tu RFC' : 'Recibido de un tercero') + '. ' + efecto,
      'Contraparte: ' + (facts.contraparte.name || '—') + ' (' + facts.contraparte.rfc + ')',
      'Fecha de emisión: ' + (facts.fecha || '—') + (folioTxt ? ' · Serie/folio: ' + (facts.serie ? facts.serie + '-' : '') + facts.folio : ''),
      'Importe: ' + (facts.total ? '$' + importeShow(facts.total) : '—'),
      'Folio fiscal (UUID): ' + item.id,
      'Estado: Vigente → Cancelado (detectado el ' + new Date(now()).toLocaleString('es-MX') + ')',
      facts.pagadoCompleto ? 'Pago: consta pagado por completo en PacoSAT.' :
        facts.saldo > 0n ? 'Saldo: constan $' + moneyShow(facts.saldo) + ' sin pago enlazado en PacoSAT.' :
        wasPaid ? 'Pagos: constan pagos enlazados por $' + moneyShow(facts.pagado) + '.' : 'Pago: sin pagos enlazados en PacoSAT.',
      'Ábrelo en PacoSAT: ' + origin + ' — búscalo por su UUID en Facturas para ver su tarjeta completa.'
    ];
    if (wasPaid) lineas.splice(1, 0, 'ATENCIÓN: este CFDI tenía pagos registrados por $' + moneyShow(facts.pagado) +
      ' (la relación de pagos está en la pantalla Dinero). Un CFDI cancelado tras cobrarse/pagarse exige revisión inmediata con tu contadora.');
    queueAlert('cancellation', 'cancel:' + item.id, subject, lineas.join('\n'), now(), ownRfcOfWatch(item));
    return true;
  }, notifyCancelPending: async (item, row) => {
    /* Solicitud de cancelación PENDIENTE de aceptación (1.27.0,
       bloque D): alguien pidió cancelar un CFDI vigente y la
       aceptación está en el aire — si nadie la rechaza, el SAT
       la da por aceptada al vencer el plazo. El aviso sale UNA
       vez por solicitud, con la fecha límite en el asunto y en
       el cuerpo, y queda espejado en Avisos (clase «necesita»:
       la decisión es de Paco o de su contraparte, en el portal
       del SAT — PacoSAT no acepta ni rechaza nada). */
    if (!item || !row) return false;
    const facts = cfdiMailFacts(item.id, item);
    const limite = new Date(row.due).toLocaleDateString('es-MX', { day: 'numeric', month: 'long', year: 'numeric' });
    const subject = 'PacoSAT · Solicitud de cancelación en curso' +
      (facts.total ? ' · $' + importeShow(facts.total) : '') +
      ' · ' + (facts.contraparte.name || facts.contraparte.rfc) + ' (' + facts.contraparte.rfc + ')' +
      ' · vence el ' + limite;
    const lineas = [
      'Qué pasó: el SAT muestra una solicitud de cancelación EN PROCESO para este comprobante, detectada el ' +
        new Date(row.firstSeen).toLocaleString('es-MX') + '.',
      'Tipo: ' + (facts.emitido ? 'Emitido por tu RFC (la solicitud la hizo tu contraparte o tu propio despacho)' :
        'Recibido de un tercero (la solicitud es del emisor)'),
      'Contraparte: ' + (facts.contraparte.name || '—') + ' (' + facts.contraparte.rfc + ')',
      'Fecha de emisión: ' + (facts.fecha || '—') + (facts.folio ? ' · Serie/folio: ' + (facts.serie ? facts.serie + '-' : '') + facts.folio : ''),
      'Importe: ' + (facts.total ? '$' + importeShow(facts.total) : '—'),
      'Folio fiscal (UUID): ' + item.id,
      'Fecha límite: si la aceptación no se rechaza antes del ' + limite + ', el SAT la tiene por aceptada y el CFDI se cancela.',
      'Qué hacer: si la cancelación NO procede, hay que rechazarla en el portal del SAT (o pedir a la contraparte que la retire) antes de esa fecha. PacoSAT solo avisa: aceptar o rechazar es un gesto en el portal, nunca de la máquina.'
    ];
    queueAlert('cancel-pending', 'cancel-pending:' + item.id, subject, lineas.join('\n'), now(), ownRfcOfWatch(item));
    return true;
  }, notifyDiscovery: async item => {
    /* Primer descubrimiento (1.13.1, pieza G): el CFDI ya constaba
       cancelado la primera vez que se le consulta (o tras un
       reseteo de su fila). Se registra en Avisos igual que una
       transición —su ref «cancel-first:» lo distingue—, pero el
       envío individual lo excluye siempre: su correo, si toca, es
       el resumen único «al ponerte al día». */
    if (!item) return false;
    queueAlert('cancellation', 'cancel-first:' + item.id,
      'PacoSAT · CFDI que ya constaba cancelado',
      'Al revisar el histórico se encontró ya cancelado el folio ' + item.id + '. Emisor: ' + item.emitter +
        '. Receptor: ' + item.receiver + '. No es una cancelación nueva: constaba así en la primera consulta, ' +
        'así que queda registrado en Avisos sin correo individual.', now(), ownRfcOfWatch(item));
    return true;
  }, notifyEfos: async alert => {
    /* 69-B (1.7.4): también al Centro, sin correo individual. */
    queueAlert('efos', 'efos:' + alert.rfc + ':' + alert.statuses.join(','),
      'PacoSAT · Nuevo RFC en el listado 69-B',
      'El RFC ' + alert.rfc + ' apareció en el listado oficial del artículo 69-B con la situación: ' + alert.statuses.join(', ') +
        '. Es emisor o receptor de CFDI de tu expediente. Revisa los comprobantes relacionados en Vigilancia SAT.', now(), alert.rfc);
    return true;
  }, ...monitorOptions });
  const host = new URL(origin).host;
  const unlocked = new Map();
  let mail, busy = false, storageRevision = 0;
  /* ===== Correo de CFDI nuevos CON DATOS y agrupado (1.22.0) =====
     El correo viejo de novedades no decía NI UN dato del
     comprobante («detectó N comprobante(s) nuevo(s)… abre la
     app»), y el aviso era POR PAQUETE: la recuperación de la
     noche del 10→11 nov (7 meses) mandó 7 correos en 36 segundos.
     Ahora la novedad se acumula por OPERACIÓN: cada operación —
     una recuperación, una descarga con varias pasadas o paquetes,
     una importación de bandeja, una corrida CIEC — deja UN aviso
     con el detalle fila a fila de todo lo que trajo nuevo
     (fecha, contraparte con nombre, serie/folio, importe y estado
     si consta), y el despachador manda UN correo por operación.
     La agrupación reutiliza el patrón de la 1.13.1: interruptor
     maestro y cadencia de Ajustes › Correo como guardianes, tope
     de 5 correos de suceso por hora COMPARTIDO con los avisos de
     suceso, y lo que el tope detiene va al resumen del día. */
  const NEWS_MAIL_GRACE_MS = 120000;
  const peopleNames = () => { const map = new Map();
    for (const row of db.prepare("SELECT value FROM records WHERE store='people'").all()) {
      try { const person = JSON.parse(row.value); if (person?.id) map.set(person.id, person.name || ''); } catch { /* registro ilegible */ } }
    return map; };
  /* La fila de detalle de un comprobante nuevo: la contraparte es
     el OTRO respecto del RFC dueño (el emisor si entró un recibido,
     el receptor si entró un emitido) y la dirección sale de a qué
     RFC del padrón llegó. Los registros guardados no siempre traen
     el nombre: se completa desde el padrón de personas, sin
     inventar nada — si no consta, va solo el RFC. */
  function newsItemOf(row, watchStates) {
    const names = peopleNames();
    /* «Propio» es SOLO el perfil dado de alta: el padrón de
       personas guarda también a los proveedores y clientes, y
       contarlos como propios volvía «emitido» un recibido de la
       bandeja cuyo emisor constaba en el padrón (cazado por la
       suite de esta ronda). El padrón solo completa NOMBRES. */
    const own = new Set(db.prepare('SELECT rfc FROM profiles').all().map(item => item.rfc));
    const ownReceiver = own.has(row.to?.rfc), ownEmitter = own.has(row.from?.rfc);
    const recibido = ownReceiver && !ownEmitter ? true : ownEmitter && !ownReceiver ? false : Boolean(watchStates);
    const contra = recibido ? row.from : row.to;
    return { uuid: row.id, fecha: String(row.date || '').slice(0, 10),
      counterpartName: contra?.name || names.get(contra?.rfc) || '', counterpartRfc: contra?.rfc || '',
      folio: row.fiscal?.folio || '', serie: row.fiscal?.series || '',
      total: row.total || '', estado: watchStates?.get(row.id) || row.state || '', kind: row.kind || 'I',
      direction: recibido ? 'received' : 'issued' };
  }
  /* Clave de operación del aviso de un job del SAT: el género con
     su RFC, su sentido y su ventana exacta comparten aviso (una
     descarga con varias pasadas o paquetes es UNA operación); la
     recuperación ata por mes, porque Paco la lanza mes a mes y el
     asunto debe nombrar ese mes. */
  const newsOpKey = (kind, rfc, direction, periodo, startAt, endAt) => kind === 'recuperacion' ?
    kind + ':' + rfc + ':' + direction + ':' + periodo :
    kind + ':' + rfc + ':' + direction + ':' + startAt + '|' + endAt;
  /* Acumula el detalle en el aviso abierto de la operación: crea
     la fila la primera vez fijando su género y su ventana de
     gracia, y añade solo comprobantes que aún no estén en él
     (la llave (aviso, UUID) hace el resto). Devuelve el aviso. */
  function queueNews(op, rows, time) {
    if (!rows.length) return null;
    const insertItem = db.prepare('INSERT OR IGNORE INTO news_items(notice,uuid,fecha,counterpartName,counterpartRfc,folio,serie,total,estado,kind,direction) ' +
      'VALUES (?,?,?,?,?,?,?,?,?,?,?)');
    const addTo = noticeId => {
      for (const item of rows) insertItem.run(noticeId, item.uuid, item.fecha, item.counterpartName,
        item.counterpartRfc, item.folio, item.serie, item.total, item.estado, item.kind, item.direction || '');
    };
    const open = db.prepare('SELECT * FROM news_notices WHERE opkey=? AND sent IS NULL').get(op.opkey);
    if (open) { addTo(open.id); return open; }
    /* Fusión por género: un aviso abierto del MISMO género (y, si
       la trae, de la misma etiqueta) cuya gracia aún corre absorbe
       la operación nueva — la recuperación de varios meses entra
       así en un solo aviso aunque cada mes sea su propia llave.
       La corrida mensual no se fusiona: su cuenta ya viaja en el
       resumen de sucesos y su correo NO debe existir.
       Correos por RFC (1.24.0, M3): la fusión SOLO absorbe avisos
       del MISMO RFC que la operación — antes, una recuperación de
       un RFC podía absorber la de otro y el aviso salía con el
       RFC borrado (mezcla de dos contribuyentes en un correo). */
    if (op.kind !== 'mensual') {
      /* La recuperación se lanza mes a mes y cada mes tarda lo
         suyo en bajar e importarse: el aviso sigue siendo de la
         MISMA operación mientras no se haya enviado y no lleve
         más de 15 minutos abierto. Si el mes siguiente entra
         cuando la gracia del primero ya venció pero su correo
         aún no ha salido, entra en ese mismo correo — no abre
         uno nuevo por mes, que es justo el defecto que se
         corrige en esta ronda. */
      const since = time;
      /* Recuperación: cualquier aviso de recuperación aún sin
         enviar absorbe el mes nuevo, sin condición de gracia —
         el envío está retenido mientras la operación siga viva
         (recoveryStillRunning), así que el aviso del primer mes
         sigue abierto cuando el último encola el suyo. */
      const sibling = op.kind === 'recuperacion' ?
        db.prepare('SELECT * FROM news_notices WHERE kind=? AND rfc=? AND sent IS NULL ORDER BY id LIMIT 1').get(op.kind, op.rfc || '') :
        db.prepare('SELECT * FROM news_notices WHERE kind=? AND rfc=? AND sent IS NULL AND due>? ORDER BY id LIMIT 1')
          .get(op.kind, op.rfc || '', since);
      if (sibling && (op.kind === 'bandeja' || op.kind === 'ciec' || op.kind === 'recuperacion' || sibling.label === op.label)) {
        addTo(sibling.id);
        db.prepare("UPDATE news_notices SET rfc=CASE WHEN rfc='' OR rfc=? THEN rfc ELSE '' END, " +
          "direction=CASE WHEN direction=? THEN direction ELSE 'mixed' END, " +
          "label=CASE WHEN label=? THEN label ELSE '' END WHERE id=?")
          .run(op.rfc || '', op.direction || '', op.label || '', sibling.id);
        return sibling;
      }
    }
    /* La gracia de agrupación solo hace falta en la recuperación
       (meses que terminan en ciclos distintos, y aun así manda la
       retención con la operación viva); una descarga normal manda
       su correo en el mismo ciclo, como siempre hizo el aviso por
       paquete al que esto sustituye. */
    const inserted = db.prepare('INSERT INTO news_notices(kind,opkey,rfc,direction,label,recipient,due) VALUES (?,?,?,?,?,?,?)')
      .run(op.kind, op.opkey, op.rfc || '', op.direction || '', op.label || '',
        mail ? mail.recipient : '', time + (op.kind === 'recuperacion' ? NEWS_MAIL_GRACE_MS : 0));
    const notice = db.prepare('SELECT * FROM news_notices WHERE id=?').get(Number(inserted.lastInsertRowid));
    addTo(notice.id);
    return notice;
  }
  /* Despachador de novedades: sustituye al viejo notify() por
     paquete. Respeta los MISMOS guardianes que los avisos de
     suceso (sin correo no sale nada; interruptor maestro apagado
     o cadencia «no» tampoco) y el MISMO tope horario compartido:
     lo que el tope detiene no se pierde — entra en el resumen del
     día con su asunto y la primera línea de su detalle —. La
     corrida mensual queda fuera a propósito: su cuenta ya viaja
     dentro del resumen de sucesos (1.15.0) y un correo más sería
     duplicarla. */
  async function sendNewsNotices(time) {
    if (!mail || !mailAlertsOn()) return;
    if (avisosConfig().correo === 'no') return;
    const active = mail;
    const items = db.prepare("SELECT * FROM news_notices WHERE kind<>'mensual' AND sent IS NULL AND due<=? ORDER BY due LIMIT 10").all(time);
    const recoveryAlive = items.some(item => item.kind === 'recuperacion') ? recoveryStillRunning() : false;
    for (const item of items) {
      /* Retención «la operación sigue viva» (1.22.0): un aviso de
         recuperación no sale mientras quede una solicitud de
         recuperación pendiente — el correo es de la OPERACIÓN,
         no del primer mes que terminó —. Tope de seguridad: 2 h
         desde el vencimiento; un trabajo atascado no retiene el
         correo para siempre. */
      if (item.kind === 'recuperacion' && recoveryAlive && time < item.due + 2 * 3600000) continue;
      const rows = db.prepare('SELECT * FROM news_items WHERE notice=? ORDER BY fecha,id').all(item.id)
        .map(row => ({ ...row, direction: item.direction && item.direction !== 'mixed' ? item.direction : row.direction || '' }));
      if (!rows.length) { db.prepare('UPDATE news_notices SET sent=?,error=? WHERE id=?')
        .run(time, 'Sin comprobantes nuevos que contar.', item.id); continue; }
      const sentThisHour = db.prepare("SELECT COUNT(*) AS n FROM mail_sends WHERE kind IN ('alerta-evento','novedades') AND ok=1 AND at>=?").get(time - 3600000).n;
      if (sentThisHour >= EVENT_MAIL_CAP_PER_HOUR) {
        const preview = composeNewsMail(item, rows.slice(0, 1), rows.length);
        db.prepare('INSERT INTO event_digest(at,subject,body,rfc) VALUES (?,?,?,?)')
          .run(time, preview.subject, preview.text.split('\n').slice(0, 3).join('\n'), item.rfc || '');
        db.prepare('UPDATE news_notices SET sent=?,error=? WHERE id=?')
          .run(time, 'Agrupada en el resumen del día: tope horario de correos alcanzado.', item.id);
        continue;
      }
      /* Reenvío automático (punto 11): si el dueño de algún
         recibido del aviso tiene la regla activa, se reenvía
         ANTES de enviar el aviso para que el propio aviso lo
         diga (transparencia), y queda en actividad. Un fallo
         del reenvío nunca tumba el aviso. */
      let reenvioNota = '';
      try { reenvioNota = await forwardAutoReceived(rows, time); } catch { reenvioNota = ''; }
      const composed = composeNewsMail(item, rows, rows.length);
      if (reenvioNota) composed.text += '\n\n' + reenvioNota;
      db.prepare('UPDATE news_notices SET due=? WHERE id=?').run(time + 15 * MIN, item.id);
      try {
        await active.transport.sendMail({ from: displayFrom(active.from), to: active.recipient,
          subject: composed.subject, text: composed.text,
          messageId: '<pacosat-novedades-' + item.id + '-' + active.instance + '@pacosat.local>' });
        db.prepare('UPDATE news_notices SET sent=?,error=? WHERE id=?').run(now(), '', item.id);
        db.prepare("INSERT INTO mail_sends(at,recipients,subject,kind,ok,error,rfc) VALUES (?,?,?,'novedades',1,'',?)")
          .run(now(), active.recipient, composed.subject, String(item.rfc || '').toUpperCase());
      } catch { db.prepare('UPDATE news_notices SET error=? WHERE id=?').run('El servidor SMTP no aceptó el envío. Revisa la configuración y las credenciales.', item.id); }
    }
    /* Reenvío automático de la corrida mensual (punto 11): sus
       avisos no llevan correo propio, pero lo que llegó SÍ se
       reenvía si el dueño tiene la regla activa; queda en
       actividad y en la bitácora de envíos. */
    try {
      const mensuales = db.prepare("SELECT id FROM news_notices WHERE kind='mensual' AND sent IS NULL AND due<=?").all(time);
      if (mensuales.length) {
        const items = mensuales.flatMap(notice =>
          db.prepare('SELECT uuid,direction FROM news_items WHERE notice=?').all(notice.id));
        await forwardAutoReceived(items, time);
      }
    } catch { /* el reenvío nunca tumba el cierre de avisos */ }
    /* La gracia vencida de la corrida mensual se cierra en
       silencio: sin correo propio, como se diseñó arriba. */
    db.prepare("UPDATE news_notices SET sent=?,error='La cuenta de la corrida mensual viaja en el resumen de sucesos.' " +
      "WHERE kind='mensual' AND sent IS NULL AND due<=?").run(time, time);
  }
  /* ===== Reenvío por correo desde el Buzón (1.24.0, punto 11) =====
     Un comprobante se reenvía a la dirección que Paco indique con
     su XML y su PDF adjuntos (el del emisor si llegó vinculado;
     si no, la representación impresa de PacoSAT) y los datos que
     lo prueban en asunto y cuerpo. Destinos recordados por RFC y
     regla automática opcional por RFC («todo lo que llegue a
     este Buzón, a esta dirección»), APAGADA por defecto. Ningún
     reenvío mezcla comprobantes de dos RFC (M3): cada correo es
     de UN comprobante de UN contribuyente. */
  const FORWARD_SUGGESTION = { MFI6212158B4: 'manofil@masfacturas.mx' };
  const forwardConfigAll = () => {
    try { return JSON.parse(getState('forward-config') || '{}'); } catch { return {}; }
  };
  const forwardConfigFor = rfc => {
    const cfg = forwardConfigAll()[rfc] || {};
    return { dests: Array.isArray(cfg.dests) ? cfg.dests : [], autoTo: String(cfg.autoTo || '') };
  };
  const forwardConfigSave = (rfc, cfg) => {
    const all = forwardConfigAll();
    all[rfc] = { dests: (cfg.dests || []).slice(0, 5), autoTo: String(cfg.autoTo || '') };
    setState('forward-config', JSON.stringify(all));
  };
  const forwardRemember = (rfc, to) => {
    const cfg = forwardConfigFor(rfc);
    cfg.dests = [to, ...cfg.dests.filter(dest => dest !== to)];
    forwardConfigSave(rfc, cfg);
  };
  const forwardAutoLog = () => {
    try { return JSON.parse(getState('forward-auto-log') || '{}'); } catch { return {}; }
  };
  async function forwardCfdiMail({ rfc, invoice, to, time, origen }) {
    const xml = readFileRecord('xml:' + invoice.id);
    if (!xml?.buffer) return { id: invoice.id, ok: false, error: 'ese comprobante no tiene XML guardado en el expediente' };
    const base = salidaNombreArchivo(invoice, rfc);
    const attachments = [{ filename: base + '.xml', content: xml.buffer }];
    let pdfOrigen = '';
    const docs = db.prepare("SELECT value FROM records WHERE store='documents'").all()
      .map(row => { try { return JSON.parse(row.value); } catch { return null; } }).filter(Boolean);
    const issuerDoc = docs.find(doc => doc.kind === 'Factura PDF' && doc.uuid === invoice.id);
    const issuerFile = issuerDoc ? readFileRecord(issuerDoc.id) : null;
    if (issuerFile?.buffer) { attachments.push({ filename: base + '.pdf', content: issuerFile.buffer }); pdfOrigen = 'el PDF del emisor'; }
    else {
      const pdf = await salidaCfdiPdf(invoice, rfc);
      if (pdf) { attachments.push({ filename: base + '.pdf', content: pdf }); pdfOrigen = 'la representación impresa de PacoSAT'; }
    }
    const subject = 'CFDI de ' + (invoice.from?.name || invoice.from?.rfc || 'emisor') +
      ' · ' + folioLabel(invoice) + ' · ' + String(invoice.date || '').slice(0, 10) +
      ' · $' + String(invoice.total || '') + ' · ' + invoice.id + ' · ' + rfc;
    const lines = [
      'Reenvío desde el Buzón de PacoSAT (' + (origen === 'automatico' ? 'regla automática' : 'petición manual') + ').',
      '',
      'Emisor: ' + (invoice.from?.name || '') + ' (' + (invoice.from?.rfc || '') + ')',
      'Receptor: ' + (invoice.to?.name || '') + ' (' + (invoice.to?.rfc || '') + ')',
      'Serie y folio: ' + folioLabel(invoice),
      'Fecha: ' + String(invoice.date || '').slice(0, 10),
      'Total: $' + String(invoice.total || ''),
      'Folio fiscal (UUID): ' + invoice.id,
      '',
      'Adjuntos: el XML del comprobante' + (pdfOrigen ? ' y su PDF (' + pdfOrigen + ').' :
        '. No se pudo adjuntar el PDF de este comprobante.')];
    try {
      await sendAppMail({ to, subject, text: lines.join('\n'), attachments, rfc }, 'reenvio', time);
      return { id: invoice.id, ok: true };
    } catch (error) { return { id: invoice.id, ok: false, error: message(error) }; }
  }
  async function forwardInvoices({ rfc, ids, to, time, origen, onSent = null }) {
    const invoices = recordInvoices();
    const results = [];
    for (const id of [...new Set((ids || []).map(String))].slice(0, 50)) {
      const invoice = invoices.find(item => item.id === id);
      if (!invoice) { results.push({ id, ok: false, error: 'ese comprobante no está en el expediente' }); continue; }
      const esDelRfc = String(invoice.from?.rfc || '').toUpperCase() === rfc ||
        String(invoice.to?.rfc || '').toUpperCase() === rfc;
      if (!esDelRfc) { results.push({ id, ok: false, error: 'ese comprobante es de otro contribuyente y no se mezcla' }); continue; }
      const result = await forwardCfdiMail({ rfc, invoice, to, time, origen });
      results.push(result);
      /* Aviso al momento de CADA envío (1.27.0, H-3.1): quien
         necesite dejar constancia de lo enviado — la regla
         automática y su marca anti-duplicados — la deja AQUÍ,
         con el correo recién salido, no cuando la tanda entera
         termine: un corte a mitad de tanda no puede perder la
         marca de lo que ya salió. */
      if (result.ok && typeof onSent === 'function') {
        try { onSent(result.id); } catch { /* la constancia nunca tumba el envío */ }
      }
    }
    const enviados = results.filter(result => result.ok);
    if (enviados.length) putMetadata('activity', { id: 'reenvio:' + time + ':' + rfc + ':' + enviados.length,
      name: 'Reenvío por correo', date: new Date(time).toISOString(), added: 0, duplicates: 0, review: 0, issues: [],
      event: 'Reenviados ' + enviados.length + ' comprobante(s) de ' + rfc + ' a ' + to +
        (origen === 'automatico' ? ' por la regla automática' : '') + ': ' + enviados.map(result => result.id).join(', ') });
    return results;
  }
  /* La regla automática sobre los ítems recibidos de un aviso:
     agrupa por dueño (el receptor del CFDI), salta lo ya
     reenviado en automático y devuelve la frase de transparencia
     para que el aviso de llegada lo diga. */
  async function forwardAutoReceived(items, time) {
    const autoLog = forwardAutoLog();
    const invoices = new Map(recordInvoices().map(invoice => [invoice.id, invoice]));
    const grupos = new Map();
    for (const item of items || []) {
      if ((item.direction || '') !== 'received' || !item.uuid || autoLog[item.uuid]) continue;
      const invoice = invoices.get(item.uuid);
      const dueno = String(invoice?.to?.rfc || '').toUpperCase();
      if (!dueno) continue;
      const cfg = forwardConfigFor(dueno);
      if (!cfg.autoTo) continue;
      if (!grupos.has(dueno)) grupos.set(dueno, { to: cfg.autoTo, ids: [] });
      grupos.get(dueno).ids.push(item.uuid);
    }
    const notas = [];
    for (const [dueno, grupo] of grupos) {
      /* La marca se PERSISTE en el momento de cada envío
         (1.27.0, H-3.1): hasta la 1.26 vivía solo en memoria
         hasta el final de la función, y un corte en mitad de la
         tanda perdía las marcas de lo ya enviado — que se
         reenviaba duplicado en la siguiente pasada. El onSent
         salta dentro del propio bucle de envíos, correo a
         correo. */
      const results = await forwardInvoices({ rfc: dueno, ids: grupo.ids, to: grupo.to, time, origen: 'automatico',
        onSent: id => {
          autoLog[id] = { to: grupo.to, at: time };
          setState('forward-auto-log',
            JSON.stringify(Object.fromEntries(Object.entries(autoLog).slice(-500))));
        } });
      const okCount = results.filter(result => result.ok).length;
      if (okCount) notas.push(okCount + ' comprobante(s) de ' + dueno + ' reenviado(s) automáticamente a ' + grupo.to);
    }
    return notas.length ? 'Reenvío automático: ' + notas.join('; ') + '.' : '';
  }
  const cloud = Boolean(proxyKey);
  const stores = ['people', 'invoices', 'documents', 'files', 'activity'];
  /* La columna rev debe existir ANTES de preparar insertRecord: la
     migración va aquí, junto a la creación del esquema. */
  if (!db.prepare('PRAGMA table_info(records)').all().some(row => row.name === 'rev'))
    db.exec('ALTER TABLE records ADD COLUMN rev INTEGER NOT NULL DEFAULT 0');
  /* Archivo por prescripción (1.23.0, frente E): archived=1 saca el
     registro de Dinero y de las colas vivas SIN borrarlo — sigue en
     el expediente y en las exportaciones como archivo consultable.
     Migración aditiva guardada, como la de rev. */
  if (!db.prepare('PRAGMA table_info(records)').all().some(row => row.name === 'archived'))
    db.exec('ALTER TABLE records ADD COLUMN archived INTEGER NOT NULL DEFAULT 0');
  /* Calendario de pago por contraparte (1.7.4, criterio 6): día de
     pago del mes (payDay) y/o plazo en días desde la factura
     (payTerms). Migración guardada, como la de records.rev. */
  /* Centro de Avisos por RFC (1.9.0, punto 4 del plan): cada aviso
     sabe de qué RFC propio es, quién lo resuelve, cuándo vence y
     cuál es la siguiente acción — como datos, no escondidos en el
     texto. */
  const avisosCols = db.prepare('PRAGMA table_info(avisos)').all().map(row => row.name);
  if (!avisosCols.includes('rfc')) db.exec("ALTER TABLE avisos ADD COLUMN rfc TEXT NOT NULL DEFAULT ''");
  if (!avisosCols.includes('responsable')) db.exec("ALTER TABLE avisos ADD COLUMN responsable TEXT NOT NULL DEFAULT ''");
  if (!avisosCols.includes('vence')) db.exec('ALTER TABLE avisos ADD COLUMN vence INTEGER');
  if (!avisosCols.includes('accion')) db.exec("ALTER TABLE avisos ADD COLUMN accion TEXT NOT NULL DEFAULT ''");
  const counterpartCols = db.prepare('PRAGMA table_info(counterparts)').all();
  if (!counterpartCols.some(row => row.name === 'payDay'))
    db.exec('ALTER TABLE counterparts ADD COLUMN payDay INTEGER');
  /* Clase de fallo de cada corrida (1.13.0): los motores ya clasifican
     sus errores (error.code: «portal-caido», «paso-interactivo»,
     «credenciales»…), pero el diario solo guardaba el texto. La
     pantalla de problemas necesita la CLASE para contar cada fallo
     con su semáforo y su titular sin adivinar desde el texto libre.
     Migración guardada, como las anteriores. */
  for (const table of ['sat_doc_runs', 'ciec_runs', 'declaraciones']) {
    const cols = db.prepare('PRAGMA table_info(' + table + ')').all();
    if (cols.length && !cols.some(row => row.name === 'errorKind'))
      db.exec("ALTER TABLE " + table + " ADD COLUMN errorKind TEXT NOT NULL DEFAULT ''");
  }
  /* R3 (1.22.0): la nota de cierre de cada solicitud — si su
     ventana quedó cubierta o qué tramo falta — vive en el propio
     trabajo, no solo en la tarjeta de Cobertura días después. */
  if (!db.prepare('PRAGMA table_info(jobs)').all().some(row => row.name === 'note'))
    db.exec("ALTER TABLE jobs ADD COLUMN note TEXT NOT NULL DEFAULT ''");
  /* M1 (1.22.0): cada cuenta bancaria declara su RFC dueño; sin
     dueño (legado) la cuenta se enseña en todos los contribuyentes
     hasta que se le asigne, y con dueño solo en el suyo. */
  if (!db.prepare('PRAGMA table_info(bank_accounts)').all().some(row => row.name === 'rfc'))
    db.exec("ALTER TABLE bank_accounts ADD COLUMN rfc TEXT NOT NULL DEFAULT ''");
  /* 1.27.0: el diario de declaraciones y del buzón guarda TAMBIÉN
     la página del fallo (shotId/htmlId, como sat_doc_runs desde la
     1.10.1), y las alertas y el buzón del resumen llevan el RFC
     como DATO (H-6.1: la atribución por contribuyente deja de
     adivinarse buscando un RFC con forma de RFC en el texto).
     La bitácora de envíos (mail_sends) se suma al mismo dato
     (residuo de H-6.1 cerrado en esta misma ronda: el paquete
     mensual atribuye «correos del mes» por esa columna, no por
     el asunto). */
  for (const table of ['decl_runs', 'trib_runs']) {
    const cols = db.prepare('PRAGMA table_info(' + table + ')').all();
    if (cols.length && !cols.some(row => row.name === 'shotId'))
      db.exec("ALTER TABLE " + table + " ADD COLUMN shotId TEXT NOT NULL DEFAULT ''");
    if (cols.length && !cols.some(row => row.name === 'htmlId'))
      db.exec("ALTER TABLE " + table + " ADD COLUMN htmlId TEXT NOT NULL DEFAULT ''");
  }
  for (const table of ['alerts', 'event_digest', 'mail_sends']) {
    const cols = db.prepare('PRAGMA table_info(' + table + ')').all();
    if (cols.length && !cols.some(row => row.name === 'rfc'))
      db.exec("ALTER TABLE " + table + " ADD COLUMN rfc TEXT NOT NULL DEFAULT ''");
  }
  /* Origen de cada corrida (1.28.0, P1): quién la lanzó — «paco»
     (un toque suyo) o «sistema» (la cadencia automática) — en los
     cuatro diarios de motor. Migración amable, como las demás. */
  for (const table of ['sat_doc_runs', 'ciec_runs', 'decl_runs', 'trib_runs']) {
    const cols = db.prepare('PRAGMA table_info(' + table + ')').all();
    if (cols.length && !cols.some(row => row.name === 'origen'))
      db.exec("ALTER TABLE " + table + " ADD COLUMN origen TEXT NOT NULL DEFAULT ''");
  }
  /* Buzón detector (1.29.0): clasificación y archivo LOCAL de cada
     notificación listada. Migración aditiva e idempotente, como
     las demás: las filas viejas nacen en «atencion» sin archivar,
     que es exactamente como se enseñaban hasta la 1.28.0. La
     sincronización posterior NO toca estas columnas de las filas
     que ya existen: archivar es una decisión local que el SAT no
     puede deshacer al volver a listar la misma notificación. */
  for (const [col, def] of [['categoria', "TEXT NOT NULL DEFAULT 'atencion'"],
      ['archivada', 'INTEGER NOT NULL DEFAULT 0'], ['archivadaEn', 'INTEGER NOT NULL DEFAULT 0'],
      ['enPapelera', 'INTEGER NOT NULL DEFAULT 0'], ['papeleraEn', 'INTEGER NOT NULL DEFAULT 0']]) {
    const cols = db.prepare('PRAGMA table_info(trib_notifications)').all();
    if (cols.length && !cols.some(row => row.name === col))
      db.exec('ALTER TABLE trib_notifications ADD COLUMN ' + col + ' ' + def);
  }
  /* Verificación estricta de declaraciones (1.29.0): un documento
     solo da un mes por bueno si su PDF quedó guardado Y su número
     de operación verificado. Las filas que ya existían conservan
     su valor (la columna nace en 1 para no desmarcar de golpe el
     expediente histórico, que entró por los motores con su
     operación leída del portal o por el gesto manual de Paco);
     lo que entre desde esta ronda marca la columna según la
     verificación que de verdad pasó: el ejecutor solo archiva
     documentos verificados (verificada=1) y la subida manual sin
     número de operación entra con verificada=0 hasta que su
     operación conste. */
  {
    const cols = db.prepare('PRAGMA table_info(declaraciones)').all();
    if (cols.length && !cols.some(row => row.name === 'verificada'))
      db.exec('ALTER TABLE declaraciones ADD COLUMN verificada INTEGER NOT NULL DEFAULT 1');
    if (cols.length && !cols.some(row => row.name === 'ejecutorJobId'))
      db.exec("ALTER TABLE declaraciones ADD COLUMN ejecutorJobId TEXT NOT NULL DEFAULT ''");
  }
  if (!counterpartCols.some(row => row.name === 'payTerms'))
    db.exec('ALTER TABLE counterparts ADD COLUMN payTerms INTEGER');
  const insertRecord = db.prepare('INSERT OR IGNORE INTO records(store,id,value,data,mime,rev) VALUES (?,?,?,?,?,?)');
  let recordRev = 0;
  try { recordRev = Number(JSON.parse(getState('records-rev') || '0')) || 0; } catch { recordRev = 0; }
  const nextRev = () => { recordRev += 1; setState('records-rev', JSON.stringify(recordRev)); return recordRev; };
  const putMetadata = (store, row) => insertRecord.run(store, row.id, JSON.stringify(row), null, null, nextRev());
  const putFile = (id, data, mime) => insertRecord.run('files', id, null, data, mime, nextRev());
  const getState = key => db.prepare('SELECT value FROM automation_state WHERE key=?').get(key)?.value || '';
  const setState = (key, value) => db.prepare('INSERT INTO automation_state(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value));
  /* Ajustes de identidad de la instalación (1.6.6): viven en la base de
     datos del volumen de datos, junto al estado operativo — sobreviven a
     reinicios y redespliegues y viajan en el respaldo completo. NUNCA en
     pacosat-secrets: no son credenciales. */
  const startedAt = now();
  /* Fecha de modificación real del archivo de la copia servida (su
     mtime al arrancar el proceso): es el sello «Modificado el» de la
     interfaz en modo servidor. Null cuando quien crea el servicio no la
     conoce (p. ej. la copia local suelta), y entonces no se muestra. */
  const servedBuildModified = buildModified;
  const getSetting = key => db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value || '';
  const setSetting = (key, value) => db.prepare('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value));
  /* Ejemplo precargado del criterio 6 (una sola vez): Chedraui paga
     los días 10 — si su contraparte ya existe sin calendario, nace
     con el día 10. Si Paco lo cambia o lo borra después, se respeta. */
  if (!getState('avisos:seed-calendario')) {
    db.prepare('UPDATE counterparts SET payDay=10 WHERE rfc=? AND payDay IS NULL').run('TCH850701RM1');
    setState('avisos:seed-calendario', '1');
  }
  const deleteSetting = key => db.prepare('DELETE FROM settings WHERE key=?').run(key);
  const SETTING_ACCENTS = ['', 'azul', 'teal', 'violeta', 'burdeos', 'ambar', 'rosa', 'grafito'];
  const cleanSettingName = value => String(value ?? '').replace(/[<>"'\\\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);
  const publicSettings = () => ({ installName: getSetting('installName'), senderName: getSetting('senderName'),
    accent: getSetting('accent'), hasLogo: Boolean(getSetting('logoMime')) });
  const displayFrom = from => { const name = cleanSettingName(getSetting('senderName'));
    return name ? name + ' <' + from + '>' : from; };
  /* Logo: validación de tipo REAL (magia o estructura), no la extensión.
     PNG y JPEG por sus bytes de firma; el SVG por su estructura y sin
     scripts, controladores de eventos ni objetos externos. */
  const LOGO_MAX = 200 * 1024;
  function validateLogo(mime, bytes) {
    if (!['image/png', 'image/jpeg', 'image/svg+xml'].includes(mime)) return 'Formato no admitido: usa PNG, JPG o SVG.';
    if (!bytes.length || bytes.length > LOGO_MAX) return 'La imagen debe pesar entre 1 byte y 200 KB.';
    if (mime === 'image/png' && !(bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47))
      return 'El archivo no es un PNG válido.';
    if (mime === 'image/jpeg' && !(bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff))
      return 'El archivo no es un JPEG válido.';
    if (mime === 'image/svg+xml') {
      const text = bytes.toString('utf8');
      if (!/<svg[\s>]/i.test(text) || /<script|javascript:|on\w+\s*=|<foreignObject/i.test(text))
        return 'El SVG no es seguro o no contiene un elemento <svg>.';
    }
    return '';
  }
  const inbox = { dir: watchDir || '' };
  const inboxStatus = { lastScan: 0, lastProcessed: 0, imported: 0, failed: 0, incidents: 0, waiting: 0, error: '' };
  const inboxStuck = new Set();
  let backupJob = null;
  /* Login propio de administrador (1.24.0, decisión 2A): sal +
     hash scrypt SOLO desde la configuración del servidor
     (bootstrap); en código no existe ningún valor por defecto
     usable. Las sesiones viven en el estado (admin-sessions),
     como las del invitado.
     Endurecimiento 1.27.0 (bloque A, H-1.1 y H-1.2):
     - el freno a fuerza bruta vive en el ESTADO, no en memoria:
       un reinicio del contenedor ya no lo borra (5 fallos en
       10 minutos bloquean con retardo creciente, como antes);
     - cada sesión guarda la HUELLA del hash vigente al nacer:
       cambiar la contraseña en la configuración invalida todas
       las sesiones anteriores sin tocar la tabla, porque su
       huella ya no casa con la del hash actual. Las sesiones
       legadas (número suelto, sin huella) dejan de valer: hay
       que entrar de nuevo una vez tras actualizar. */
  let adminAuth = null;
  const adminFingerprint = () => adminAuth
    ? createHash('sha256').update(adminAuth.hash).digest('hex').slice(0, 16) : '';
  const adminFailState = () => { try { return JSON.parse(getState('admin-login-fails') || '{}'); } catch { return {}; } };
  const adminSessions = () => { try { return JSON.parse(getState('admin-sessions') || '{}'); } catch { return {}; } };
  const adminSessionValid = value => {
    if (!value || !adminAuth) return false;
    const entry = adminSessions()[value];
    return Boolean(entry) && typeof entry === 'object' &&
      Number(entry.exp || 0) > now() && entry.fp === adminFingerprint();
  };
  const adminCookie = req => {
    for (const part of String(req.headers.cookie || '').split(';')) {
      const [name, ...rest] = part.trim().split('=');
      if (name === 'pacosat_admin') return rest.join('=');
    }
    return '';
  };
  const packageLookup = db.prepare('SELECT id FROM packages WHERE job=? AND remoteId=?');
  const insertPackage = db.prepare('INSERT INTO packages(job,remoteId,rfc,archive,newCount,review) VALUES (?,?,?,?,?,?)');
  const remember = db.prepare('INSERT OR IGNORE INTO discovered VALUES (?,?)');

  /* Libro de criterios (blindaje 5002): la tabla criteria es append-only —
     solo recibe inserciones, una por cada SolicitaDescarga realmente enviado
     al SAT — y los criterios que el SAT devuelve agotados (5002) se marcan en
     criteria_exhausted, sin tocar las filas del libro. */
  const insertCriteria = db.prepare('INSERT INTO criteria(key,rfc,direction,type,emitter,receiver,startAt,endAt,requestId,origin,sentAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  function criteriaFromJob(job) {
    return { rfc: job.rfc, direction: job.direction, type: job.kind === 'metadata' ? 'metadata' : 'cfdi', emitter: '', receiver: '',
      startAt: job.startAt || job.periodStart + ' 00:00:00',
      endAt: job.endAt || job.periodEnd + ' 23:59:59' };
  }
  /* Origen REAL de un trabajo (1.22.0): el criterio sintético no lo
     lleva — vive en el libro, en la fila que sendSatRequest escribió
     al enviar la solicitud ('monthly' / 'recovery' / 'manual'…).
     Sin esta lectura, inspectPackage clasificaba TODA novedad como
     «sat» y la agrupación por operación (mensual sin correo propio,
     recuperación en un solo correo) nunca llegaba a aplicarse. */
  function jobOrigin(job) {
    const key = pacosatCriteriaKey(criteriaFromJob(job));
    const row = db.prepare('SELECT origin FROM criteria WHERE key=? ORDER BY sentAt DESC, id DESC LIMIT 1').get(key);
    return row?.origin || '';
  }
  /* ¿Queda alguna solicitud de recuperación sin terminar? Mientras
     la operación siga viva, su aviso de novedades NO sale: el mes
     siguiente puede estar aún bajando y su detalle debe entrar en
     el MISMO correo (la cola procesa los trabajos uno a uno y cada
     mes encola su aviso en un tick distinto — ninguna ventana de
     gracia cubre ese escalonamiento, probado en la depuración de
     la 1.22.0: mayo salía solo y junio abría un segundo correo). */
  function recoveryStillRunning() {
    return db.prepare("SELECT * FROM jobs WHERE status='pending'").all()
      .some(job => jobOrigin(job) === 'recovery');
  }
  function criteriaInfo(criteria) {
    const key = pacosatCriteriaKey(criteria);
    const row = db.prepare('SELECT COUNT(*) AS count, MIN(CASE WHEN sentAt>0 THEN sentAt END) AS first FROM criteria WHERE key=?').get(key);
    const count = row?.count || 0;
    const exhausted = Boolean(db.prepare('SELECT 1 FROM criteria_exhausted WHERE key=?').get(key));
    const rescuedRow = db.prepare('SELECT rescuedAt,count FROM criteria_rescued WHERE key=?').get(key);
    const rescued = rescuedRow ? { at: rescuedRow.rescuedAt, count: rescuedRow.count } : null;
    /* Estados (ronda anti-5002): «rescatado» es un agotado cuyo contenido
       ya entró por el portal; «ultima» ya no invita a gastar la última
       solicitud repitiendo — la guardia bloquea el duplicado y ofrece la
       variante de cierre +1 s. */
    return { key, count, firstSentAt: row?.first || null, exhausted, rescued,
      state: exhausted ? (rescued ? 'rescatado' : 'agotado') : count >= 2 ? 'agotado' : count === 1 ? 'ultima' : 'disponible' };
  }
  function guardError(info, criteria, text) {
    return Object.assign(new Error(text), { status: 409, guard: {
      state: info.state, count: info.count, firstSentAt: info.firstSentAt,
      rfc: criteria.rfc, direction: criteria.direction, type: criteria.type || 'cfdi',
      startAt: criteria.startAt, endAt: criteria.endAt,
      shiftedStartAt: pacosatShiftSecond(criteria.startAt),
      shiftedEndAt: pacosatShiftSecond(criteria.endAt),
      rescuedAt: info.rescued?.at || null, rescuedCount: info.rescued?.count || 0,
      message: text } });
  }
  /* Marcar un criterio como quemado (5002): lo aprende la verificación
     posterior o la propia llamada de envío cuando el SAT la rechaza.
     Solo se quema ESA combinación exacta — ni el RFC, ni la e.firma,
     ni otras fechas — y el libro lo muestra «agotado» hasta que el
     rescate por el portal lo marque «rescatado». */
  function markCriteriaExhausted(criteria, time, detail) {
    const key = pacosatCriteriaKey(criteria);
    db.prepare('INSERT OR IGNORE INTO criteria_exhausted(key,learnedAt,detail) VALUES (?,?,?)')
      .run(key, time, detail);
    return key;
  }
  /* Blindaje 5002 a prueba de cortes (1.6.15, mejora nº 1): la fila
     del libro se escribe en estado «enviando» (sentAt 0, sin
     requestId) ANTES de llamar al SAT, y se completa al volver la
     respuesta. Si el proceso muere entre ambas cosas, la fila queda
     como «presunto enviado»: criteriaInfo la cuenta igual que una
     enviada (la guardia no reenvía el criterio a ciegas) y el arranque
     avisa de su existencia. Único caso en que la intención se retira:
     el SAT responde 5002 en la propia llamada — confirma que NO contó
     esta solicitud (el cupo lo gastaron las filas anteriores, que ya
     están en el libro). */
  async function sendSatRequest(send, criteria, origin, time) {
    /* Última línea de defensa (ronda anti-5002): NINGUNA solicitud sale
       con un criterio idéntico a uno ya registrado para ese RFC, venga
       de la ruta que venga. Las rutas ya lo comprueban antes (guardia
       manual y planificador; auto-desplazamiento en la programación);
       esto lo garantiza aunque una ruta futura lo olvide. La fila
       «enviando» (sentAt 0) también cuenta: un envío interrumpido a
       mitad jamás habilita un reenvío idéntico a ciegas. */
    const prior = criteriaInfo(criteria);
    if (prior.count > 0 || prior.exhausted) throw guardError(prior, criteria,
      'Ese criterio exacto ya consta en el libro de PacoSAT: no se envía un duplicado.');
    const intent = insertCriteria.run(pacosatCriteriaKey(criteria), criteria.rfc, criteria.direction,
      criteria.type, criteria.emitter || '', criteria.receiver || '', criteria.startAt, criteria.endAt,
      '', origin, 0);
    try {
      const requestId = await send();
      db.prepare('UPDATE criteria SET requestId=?, sentAt=? WHERE id=?')
        .run(requestId, time, intent.lastInsertRowid);
      return requestId;
    } catch (error) {
      if (error?.code === 5002 || /5002/.test(message(error))) {
        db.prepare('DELETE FROM criteria WHERE id=?').run(intent.lastInsertRowid);
        /* El 5002 en la propia llamada también se aprende: el criterio
           queda quemado en el libro aunque el gasto viniera de otra
           aplicación, y la guardia lo bloqueará desde ya con sus
           salidas (variante +1 s o rescate por el portal). */
        markCriteriaExhausted(criteria, time, 'envío rechazado');
        queueAlert('criteria-5002', 'criteria:' + pacosatCriteriaKey(criteria),
          'PacoSAT · El SAT agotó las solicitudes de un periodo (5002)',
          'Al enviar la solicitud del RFC ' + criteria.rfc + ' (' + criteria.startAt + ' a ' + criteria.endAt + ', ' +
          (criteria.direction === 'received' ? 'recibidos' : 'emitidos') + (criteria.type === 'metadata' ? ', metadatos' : '') +
          '), el SAT devolvió el código 5002: las solicitudes con ese mismo criterio están agotadas de por vida, ' +
          'aunque el gasto viniera de otra aplicación. El criterio quedó marcado «quemado» en el libro: lo quemado es ' +
          'solo esa combinación exacta — ni el RFC ni la e.firma —. Salidas: el mismo periodo cerrando 1 segundo ' +
          'más tarde, o el rescate por el portal web (Libro de criterios, en el Centro SAT).', time);
      }
      throw error;
    }
  }
  function learnCriteria5002(job, time) {
    const criteria = criteriaFromJob(job);
    const info = criteriaInfo(criteria);
    markCriteriaExhausted(criteria, time, job.requestId);
    queueAlert('criteria-5002', 'criteria:' + info.key, 'PacoSAT · El SAT agotó las solicitudes de un periodo (5002)',
      'Al verificar la solicitud ' + job.requestId + ' del RFC ' + job.rfc + ' (' + job.periodStart + ' a ' + job.periodEnd +
      ', ' + (job.direction === 'received' ? 'recibidos' : 'emitidos') + '), el SAT devolvió el código 5002: las solicitudes ' +
      'con ese mismo criterio están agotadas de por vida, aunque el gasto viniera de otra aplicación. Lo quemado es solo ' +
      'esa combinación exacta — ni el RFC ni la e.firma ni otras fechas —. PacoSAT ya no enviará ese criterio; salidas: ' +
      'el mismo periodo cerrando 1 segundo más tarde, o el rescate por el portal web (Libro de criterios, en el Centro SAT).', time);
  }
  /* Libro de criterios visible por RFC (ronda anti-5002, componente 5):
     una entrada por criterio exacto con sus envíos (cuándo, con qué
     folio del SAT y desde qué ruta) y su estado: disponible, ya usado
     (no se repite), quemado (5002) o rescatado por el portal. Incluye
     los quemados sin envíos propios — el gasto vino de otra aplicación
     y la intención se retiró —: sus datos salen de la propia clave. */
  function criteriaBook(limit = 300) {
    const byKey = new Map();
    const ensure = (key, fields) => {
      let entry = byKey.get(key);
      if (!entry) { entry = { key, ...fields, sends: [] }; byKey.set(key, entry); }
      return entry;
    };
    for (const row of db.prepare('SELECT * FROM criteria ORDER BY id').all())
      ensure(row.key, { rfc: row.rfc, direction: row.direction, type: row.type, emitter: row.emitter,
        receiver: row.receiver, startAt: row.startAt, endAt: row.endAt })
        .sends.push({ requestId: row.requestId, origin: row.origin, sentAt: row.sentAt });
    const exhausted = new Map(db.prepare('SELECT * FROM criteria_exhausted').all().map(row => [row.key, row]));
    const rescued = new Map(db.prepare('SELECT * FROM criteria_rescued').all().map(row => [row.key, row]));
    for (const key of exhausted.keys()) if (!byKey.has(key)) {
      try { const [rfc, direction, type, emitter, receiver, startAt, endAt] = JSON.parse(key);
        ensure(key, { rfc, direction, type, emitter, receiver, startAt, endAt }); }
      catch { /* clave ilegible: no se inventa ninguna entrada */ }
    }
    const entries = [...byKey.values()].map(entry => {
      const burned = exhausted.get(entry.key), saved = rescued.get(entry.key);
      return { ...entry,
        count: entry.sends.length,
        firstSentAt: entry.sends.reduce((min, s) => s.sentAt > 0 && (min === null || s.sentAt < min) ? s.sentAt : min, null),
        lastSentAt: entry.sends.reduce((max, s) => Math.max(max, s.sentAt || 0), 0) || null,
        presumed: entry.sends.some(s => !s.sentAt),
        state: burned ? (saved ? 'rescatado' : 'agotado') : entry.sends.length >= 2 ? 'agotado' : entry.sends.length === 1 ? 'ultima' : 'disponible',
        exhaustedAt: burned?.learnedAt || null, exhaustedDetail: burned?.detail || '',
        rescuedAt: saved?.rescuedAt || null, rescuedCount: saved?.count || 0 };
    });
    entries.sort((a, b) => (b.lastSentAt || b.exhaustedAt || 0) - (a.lastSentAt || a.exhaustedAt || 0));
    return entries.slice(0, limit);
  }
  /* Variante automática para las rutas programadas (ronda anti-5002):
     busca el criterio libre más cercano desplazando primero el CIERRE
     +1 s en +1 s (el inicio nunca se mueve: no se pierde ningún CFDI
     del primer segundo ni se abren micro-huecos al principio de la
     ventana), sin cruzar al día siguiente; solo si el cierre está en
     el último segundo del día se recurre a desplazar el inicio, como
     hacía el blindaje 1.6.15. Devuelve null si no hay criterio libre. */
  function freeCriteria(criteria) {
    let candidate = { ...criteria };
    let info = criteriaInfo(candidate);
    let endShifts = 0;
    while (info.state !== 'disponible' && endShifts < 10) {
      const shifted = pacosatShiftSecond(candidate.endAt);
      if (shifted.slice(0, 10) !== candidate.endAt.slice(0, 10)) break;
      candidate = { ...candidate, endAt: shifted }; endShifts++;
      info = criteriaInfo(candidate);
    }
    let startShifts = 0;
    while (info.state !== 'disponible' && startShifts < 10) {
      candidate = { ...candidate, startAt: pacosatShiftSecond(candidate.startAt) }; startShifts++;
      info = criteriaInfo(candidate);
    }
    return info.state === 'disponible' ? { criteria: candidate, endShifts, startShifts } : null;
  }
  /* Migración suave: las solicitudes previas a 1.6.2 solo guardaban fechas.
     Se reconstruyen los segundos con la misma regla con la que se enviaron
     (cierre 23:59:59 en periodos pasados; hora del envío si el cierre era el
     día de creación) y el libro se siembra una sola vez desde jobs, sin
     perder ni duplicar ninguna solicitud ya enviada. */
  tx(db, () => {
    const recordColumns = db.prepare('PRAGMA table_info(records)').all().map(row => row.name);
    if (!recordColumns.includes('rev')) db.exec('ALTER TABLE records ADD COLUMN rev INTEGER NOT NULL DEFAULT 0');
    const jobColumns = db.prepare('PRAGMA table_info(jobs)').all().map(row => row.name);
    if (!jobColumns.includes('startAt')) db.exec("ALTER TABLE jobs ADD COLUMN startAt TEXT NOT NULL DEFAULT ''");
    if (!jobColumns.includes('endAt')) db.exec("ALTER TABLE jobs ADD COLUMN endAt TEXT NOT NULL DEFAULT ''");
    /* 1.6.4: contador de verificaciones pendientes por solicitud, para la
       espera creciente (backoff) de verifyJobs. */
    if (!jobColumns.includes('checks')) db.exec("ALTER TABLE jobs ADD COLUMN checks INTEGER NOT NULL DEFAULT 0");
    /* 1.6.10: tipo de solicitud (cfdi | metadata) y pausa por perfil
       (modo descanso: interruptor y «hasta» programado). */
    if (!jobColumns.includes('kind')) db.exec("ALTER TABLE jobs ADD COLUMN kind TEXT NOT NULL DEFAULT 'cfdi'");
    /* 1.18.0 (Ronda Facilidad): «dejar de insistir» por solicitud —
       pausa con nombre propio de una descarga masiva ya entregada
       al SAT: la solicitud sigue siendo del SAT, pero PacoSAT no
       la sondea mientras held=1; reanudar es volver a held=0. */
    if (!jobColumns.includes('held')) db.exec("ALTER TABLE jobs ADD COLUMN held INTEGER NOT NULL DEFAULT 0");
    const profileColumnsPre = db.prepare('PRAGMA table_info(profiles)').all().map(row => row.name);
    if (!profileColumnsPre.includes('paused')) db.exec("ALTER TABLE profiles ADD COLUMN paused INTEGER NOT NULL DEFAULT 0");
    if (!profileColumnsPre.includes('pauseUntil')) db.exec("ALTER TABLE profiles ADD COLUMN pauseUntil INTEGER NOT NULL DEFAULT 0");
    /* 1.6.5: caducidad real del certificado de la e.firma por perfil
       (epoch ms); NULL cuando nunca se pudo leer: «sin dato», jamás una
       fecha inventada. */
    const profileColumns = db.prepare('PRAGMA table_info(profiles)').all().map(row => row.name);
    if (!profileColumns.includes('certExpires')) db.exec("ALTER TABLE profiles ADD COLUMN certExpires INTEGER");
    for (const job of db.prepare("SELECT * FROM jobs WHERE startAt=''").all()) {
      const endAt = job.periodEnd + ' ' + (job.periodEnd === day(job.created) ? clock.format(job.created) : '23:59:59');
      db.prepare('UPDATE jobs SET startAt=?,endAt=? WHERE id=?').run(job.periodStart + ' 00:00:00', endAt, job.id);
    }
    if (!getState('ledger:seeded')) {
      for (const job of db.prepare('SELECT * FROM jobs ORDER BY id').all()) {
        const criteria = criteriaFromJob(job);
        insertCriteria.run(pacosatCriteriaKey(criteria), criteria.rfc, criteria.direction, criteria.type,
          '', '', criteria.startAt, criteria.endAt, job.requestId, 'seed', job.created);
      }
      setState('ledger:seeded', '1');
    }
  });

  /* Caducidad de la e.firma (1.6.5): se lee la fecha notAfter del
     certificado X.509 al desbloquear o al arrancar con un perfil, y se
     persiste en el perfil (viaja también en el respaldo operativo). Si el
     certificado no se puede interpretar, queda «sin dato»: nunca se
     inventa una fecha. */
  function certExpiryMs(buffer) {
    for (const input of [buffer, buffer?.toString('utf8')]) {
      try {
        const ms = Date.parse(new X509Certificate(input).validTo);
        if (Number.isFinite(ms)) return ms;
      } catch { /* probar la siguiente representación */ }
    }
    return null;
  }
  function recordCertExpiry(rfc, buffer) {
    const expires = certExpiryMs(buffer);
    if (expires) db.prepare('UPDATE profiles SET certExpires=? WHERE rfc=?').run(expires, rfc);
    return expires;
  }
  /* RFC dentro del certificado (1.6.12): el SAT lo trae en el campo
     serialNumber del sujeto (a veces acompañado del CURP: se toma el
     token con forma exacta de RFC). Sin coincidencia clara, ''. */
  function certRfc(buffer) {
    const tokenRfc = text => (String(text).toUpperCase().split(/[^A-ZÑ&0-9]+/)
      .find(token => /^[A-ZÑ&]{3,4}[0-9]{6}[A-Z0-9]{3}$/.test(token))) || '';
    for (const input of [buffer, buffer?.toString('utf8')]) {
      try {
        const subject = new X509Certificate(input).subject || '';
        const serialLine = subject.split(/\r?\n/).find(line => line.startsWith('serialNumber='));
        const found = (serialLine && tokenRfc(serialLine)) || tokenRfc(subject);
        if (found) return found;
      } catch { /* probar la siguiente representación */ }
    }
    return '';
  }
  /* Carpeta protegida de e.firma (1.6.12): los .cer/.key subidos desde
     la app y su índice (contraseña y agenda por RFC) viven SOLO aquí —
     por defecto junto a la base de datos del servidor, o donde diga
     PACOSAT_EFIRMA_DIR (en el NAS: la carpeta pacosat-secrets). Nunca
     entran en la BD, en los respaldos ni en las exportaciones. */
  const efirmaBase = efirmaDir ? String(efirmaDir) : join(dirname(dbFile), 'efirma');
  const efirmaPath = (rfc, ext) => join(efirmaBase, rfc + ext);
  const efirmaIndexPath = join(efirmaBase, 'perfiles.json');
  function readEfirmaIndexRaw() {
    try { return JSON.parse(readFileSync(efirmaIndexPath, 'utf8')); } catch { return {}; }
  }
  /* S1 (1.22.0): la lectura entrega los secretos EN CLARO a los
     flujos (como siempre) y la escritura los guarda CIFRADOS en
     reposo con la llave del equipo. */
  function readEfirmaIndex() { return decryptIndexSecrets(efirmaBase, readEfirmaIndexRaw()); }
  function writeEfirmaIndex(index) {
    writeFileSync(efirmaIndexPath, JSON.stringify(encryptIndexSecrets(efirmaBase, index), null, 2), { mode: 0o600 });
  }
  /* Migración al arrancar: cualquier secreto legado en claro se
     cifra en sitio. Si algo falla, el fichero queda COMO ESTABA
     (no se pierde el original) y el fallo se anota y se avisa. */
  function migrateEfirmaSecrets(time) {
    try {
      const raw = readEfirmaIndexRaw();
      const pending = Object.values(raw).some(meta => (meta?.password && !isEncryptedSecret(meta.password)) ||
        (meta?.ciec && !isEncryptedSecret(meta.ciec)));
      if (!pending) return;
      writeEfirmaIndex(raw);
      const after = readEfirmaIndexRaw();
      const stillPlain = Object.values(after).some(meta => (meta?.password && !isEncryptedSecret(meta.password)) ||
        (meta?.ciec && !isEncryptedSecret(meta.ciec)));
      if (stillPlain) throw new Error('La migración no cifró todos los secretos.');
    } catch (error) {
      setState('efirma:secret-migration-error', message(error));
      queueAlert('secret-migration', 'secret-migration:' + Math.floor(time / (7 * DAY)),
        'PacoSAT · La migración de secretos cifrados no se completó',
        'PacoSAT intentó cifrar en reposo la CIEC y la contraseña de la e.firma guardadas, y algo falló: ' +
        message(error) + ' Tus credenciales siguen guardadas como estaban (no se perdió nada) y los flujos siguen ' +
        'leyéndolas igual; la migración se reintentará en el próximo arranque.', time);
    }
  }
  function writeEfirmaFiles(rfc, certificate, privateKey, meta) {
    mkdirSync(efirmaBase, { recursive: true, mode: 0o700 });
    writeFileSync(efirmaPath(rfc, '.cer'), certificate, { mode: 0o600 });
    writeFileSync(efirmaPath(rfc, '.key'), privateKey, { mode: 0o600 });
    const index = readEfirmaIndex();
    /* Método de acceso del RFC (1.12.0): guardar la e.firma deja el
       método en «efirma»; el método «ciec» lo pone writeCiecCredentials. */
    index[rfc] = { ...meta, access: 'efirma' };
    writeEfirmaIndex(index);
  }
  /* Acceso con contraseña CIEC (1.12.0): la contraseña del portal se
     custodia en el MISMO índice protegido que la de la e.firma —
     misma carpeta 0700, mismo fichero 0600, fuera de la BD, de los
     respaldos y de las exportaciones — y el guardado marca el
     método del RFC como «ciec» sin pedir .cer/.key: es la vía de
     los RFC que no tienen e.firma. Lo que hubiera de un método
     anterior se conserva (los ficheros .cer/.key no se tocan), pero
     el método guardado es el que manda en el arranque y en las
     pantallas. La contraseña nunca se devuelve en una respuesta ni
     se escribe en diarios ni en la bitácora. */
  function writeCiecCredentials(rfc, meta) {
    mkdirSync(efirmaBase, { recursive: true, mode: 0o700 });
    const index = readEfirmaIndex();
    index[rfc] = { ...index[rfc], access: 'ciec', ciec: meta.ciec,
      minutes: meta.minutes, days: meta.days, direction: meta.direction };
    writeEfirmaIndex(index);
  }
  /* Avisos de caducidad: una sola vez por umbral (90, 60, 30 y 0 días) y
     por certificado — la referencia del aviso incluye la fecha de
     caducidad, así un certificado renovado vuelve a tener sus avisos. */
  function checkCertExpiries(time) {
    for (const profile of db.prepare('SELECT rfc,certExpires FROM profiles WHERE certExpires IS NOT NULL').all()) {
      const daysLeft = Math.ceil((profile.certExpires - time) / DAY);
      for (const threshold of [90, 60, 30, 0]) {
        if (daysLeft > threshold) continue;
        queueAlert('cert-expiry', 'cert:' + profile.rfc + ':' + profile.certExpires + ':' + threshold,
          threshold === 0 ? 'PacoSAT · La e.firma de ' + profile.rfc + ' está vencida o vence hoy' :
            'PacoSAT · La e.firma de ' + profile.rfc + ' vence en ' + Math.max(daysLeft, 0) + ' días',
          'El certificado de la e.firma del RFC ' + profile.rfc + ' caduca el ' + day(profile.certExpires) +
          '. Sin e.firma vigente PacoSAT no puede descargar CFDI del SAT. Renuévala en el SAT y vuelve a desbloquear el perfil en el Centro SAT con el certificado nuevo.', time, profile.rfc);
      }
    }
  }

  /* Alta preparada sin credenciales (1.24.0, punto 7): el perfil
     queda creado en estado «faltan credenciales» — tiene su fila
     y su hueco en el directorio, pero ninguna descarga se intenta
     hasta que Paco aporte la CIEC o la e.firma desde el Centro
     SAT, que es donde las credenciales se guardan (nunca por
     chat). La fila usa la agenda por defecto de la casa (6 h /
     7 días / recibidos, la misma del alta por CIEC). */
  function ensurePendingProfileRow(rfc) {
    db.prepare("INSERT OR IGNORE INTO profiles(rfc,minutes,days,direction,nextRun,error) VALUES (?,360,7,'received',0,'')").run(rfc);
  }
  function pendingProfileRfcs() {
    try { return db.prepare('SELECT rfc FROM pending_profiles ORDER BY rfc').all().map(row => row.rfc); }
    catch { return []; }
  }

  async function bootstrap(config) {
    for (const row of config.profiles || []) {
      try {
        need(validateRfc(row.rfc || '').level !== 'structure' && typeof row.name === 'string' && row.name.length > 0 && row.name.length <= 120 &&
          Number.isInteger(row.minutes) && row.minutes >= 60 && row.minutes <= 1440 && Number.isInteger(row.days) && row.days >= 1 && row.days <= 31 &&
          ['received','issued','both'].includes(row.direction), 'Perfil inicial inválido.');
        const certificate = readFileSync(row.certificatePath), privateKey = readFileSync(row.keyPath);
        const expires = certExpiryMs(certificate);
        let active;
        try { active = await makeConnector({ rfc: row.rfc, certificate, privateKey, password: row.password }); }
        finally { certificate.fill(0); privateKey.fill(0); }
        db.prepare("INSERT INTO profiles(rfc,minutes,days,direction,nextRun,error) VALUES (?,?,?,?,0,'') ON CONFLICT(rfc) DO UPDATE SET minutes=excluded.minutes,days=excluded.days,direction=excluded.direction,error='' ")
          .run(row.rfc, row.minutes, row.days, row.direction);
        if (expires) db.prepare('UPDATE profiles SET certExpires=? WHERE rfc=?').run(expires, row.rfc);
        putMetadata('people', { id: row.rfc, name: row.name });
        unlocked.set(row.rfc, active);
      } catch { console.error('PacoSAT: un perfil de e.firma del archivo de arranque no pudo activarse.'); }
    }
    /* Perfiles guardados desde la app (1.6.12): se activan igual que los
       del archivo de arranque, desde la carpeta protegida de e.firma.
       Si un RFC está en ambos sitios, manda el de la app (es el más
       reciente: lo subió Paco desde la pantalla). */
    for (const [rfc, meta] of Object.entries(readEfirmaIndex())) {
      if (meta?.access === 'ciec') {
        /* Método CIEC (1.12.0): no hay e.firma que activar. El
           perfil existe con su agenda para que el RFC tenga su
           tarjeta en la pantalla del SAT; su descarga va por el
           portal con contraseña y captcha, lanzada a mano, y nunca
           entra en el desbloqueo ni en la programación automática. */
        db.prepare("INSERT INTO profiles(rfc,minutes,days,direction,nextRun,error) VALUES (?,?,?,?,0,'') ON CONFLICT(rfc) DO UPDATE SET minutes=excluded.minutes,days=excluded.days,direction=excluded.direction")
          .run(rfc, meta.minutes || 360, meta.days || 7, meta.direction || 'received');
        continue;
      }
      try {
        const certificate = readFileSync(efirmaPath(rfc, '.cer')), privateKey = readFileSync(efirmaPath(rfc, '.key'));
        const expires = certExpiryMs(certificate);
        let active;
        try { active = await makeConnector({ rfc, certificate, privateKey, password: meta.password }); }
        finally { certificate.fill(0); privateKey.fill(0); }
        db.prepare("INSERT INTO profiles(rfc,minutes,days,direction,nextRun,error) VALUES (?,?,?,?,0,'') ON CONFLICT(rfc) DO UPDATE SET minutes=excluded.minutes,days=excluded.days,direction=excluded.direction,error='' ")
          .run(rfc, meta.minutes, meta.days, meta.direction);
        if (expires) db.prepare('UPDATE profiles SET certExpires=? WHERE rfc=?').run(expires, rfc);
        unlocked.set(rfc, active);
      } catch { console.error('PacoSAT: un perfil de e.firma guardado desde la app no pudo activarse.'); }
    }
    if (config.watchFolder?.path) inbox.dir = String(config.watchFolder.path);
    /* «Presunto enviado» (1.6.15, mejora nº 1): filas del libro en
       estado «enviando» sin respuesta = el proceso murió durante la
       llamada al SAT. Cuentan como enviadas para la guardia 5002 y se
       avisa una sola vez de su existencia. */
    const presumed = db.prepare('SELECT COUNT(*) AS n FROM criteria WHERE sentAt=0').get().n;
    if (presumed) queueAlert('criteria-presumed', 'criteria-presumed',
      'PacoSAT · Hay solicitudes marcadas como «presunto enviadas»',
      presumed + ' solicitud(es) quedaron registradas como intención sin confirmación del SAT (un corte durante ' +
      'el envío). Por seguridad cuentan como enviadas para el blindaje 5002: el mismo criterio no se reenviará ' +
      'sin desplazar la ventana un segundo.', now());
    if (config.backup?.password) {
      if (String(config.backup.password).length >= 12) {
        backupJob = { password: String(config.backup.password),
          frequency: config.backup.frequency === 'weekly' ? 'weekly' : 'daily',
          /* Carpeta del respaldo (1.23.0, frente C): manda primero
             la variable PACOSAT_BACKUP_DIR, después la del archivo
             de arranque y por último el defecto de siempre — sin
             variable, el comportamiento es idéntico al anterior. */
          dir: process.env.PACOSAT_BACKUP_DIR ? String(process.env.PACOSAT_BACKUP_DIR) :
            config.backup.dir ? String(config.backup.dir) : join(dirname(dbFile), 'respaldos'),
          secondaryDir: config.backup.secondaryDir ? String(config.backup.secondaryDir) : '' };
      } else console.error('PacoSAT: el respaldo programado requiere una contraseña de al menos 12 caracteres.');
    }
    /* Login propio (1.24.0): la sección admin del archivo de
       arranque trae sal y hash; con otra forma, queda sin
       configurar y se dice en el registro del servidor. */
    if (config.admin?.hash && config.admin?.salt) {
      const hashValido = /^[0-9a-f]{64}$/i.test(String(config.admin.hash));
      /* Suelo de sal: 16 bytes — 32 caracteres hex (H-1.3, pasada
         de seguridad de la 1.24.0); es lo que genera el
         procedimiento documentado (randomBytes(16)). Una sal más
         corta deja el login sin configurar, con el motivo en el
         registro y sin volcar ningún valor. */
      const salValida = /^[0-9a-f]{32,128}$/i.test(String(config.admin.salt));
      if (hashValido && salValida)
        adminAuth = { hash: String(config.admin.hash).toLowerCase(), salt: String(config.admin.salt).toLowerCase() };
      else console.error('PacoSAT: la sección admin del archivo de arranque no trae un hash/sal válidos' +
        (!salValida ? ' — la sal debe ser hexadecimal de al menos 32 caracteres (16 bytes)' : '') +
        '; el login propio queda sin configurar.');
    }
    /* Altas preparadas (1.24.0, punto 7): su fila de perfil se
       (re)crea al arrancar para que el directorio las enseñe en
       «faltan credenciales» también tras un reinicio. */
    for (const rfc of pendingProfileRfcs()) ensurePendingProfileRow(rfc);
    if (config.mail) {
      try { await configureMail(config.mail); }
      catch { console.error('PacoSAT: no se pudo activar el correo del archivo de arranque.'); }
    }
  }

  async function configureMail(x) {
    need(typeof x.recipient === 'string' && email.test(x.recipient) && x.recipient.length <= 200 &&
      typeof x.from === 'string' && email.test(x.from) && x.from.length <= 200, 'Revisa el correo de origen y destino.');
    need(typeof x.host === 'string' && x.host.length <= 253 && /^[a-z0-9.-]+$/i.test(x.host) &&
      [465, 587].includes(x.port), 'Usa un servidor SMTP y el puerto 465 o 587.');
    need(typeof x.user === 'string' && x.user.length <= 200 && typeof x.password === 'string' &&
      x.password.length <= 512 && Boolean(x.user) === Boolean(x.password), 'Completa ambos campos SMTP o deja ambos vacíos.');
    let transport;
    try {
      const factory = makeMailer || (await import('nodemailer')).default.createTransport;
      transport = factory({
        host: x.host, port: x.port, secure: x.port === 465, requireTLS: x.port === 587,
        auth: x.user ? { user: x.user, pass: x.password } : undefined,
        connectionTimeout: 12000, greetingTimeout: 12000, socketTimeout: 18000,
        disableFileAccess: true, disableUrlAccess: true
      });
      await transport.verify();
    } catch { need(false, 'No se pudo verificar SMTP. Revisa el servidor, el puerto y las credenciales.', 422); }
    /* El identificador de instancia de los Message-ID era un
       fragmento del token de administrador (auditoría 1.9.0): ahora
       es un valor aleatorio independiente y persistente, sin
       relación con ninguna credencial. */
    let mailInstance = getState('mail-instance');
    if (!mailInstance) { mailInstance = randomBytes(8).toString('hex'); setState('mail-instance', mailInstance); }
    mail = { transport, from: x.from, recipient: x.recipient, instance: mailInstance };
  }

  /* ===== Salud del sistema (1.13.0, pieza «5» de la lista) =====
     Chequeo calculado en el servidor y enseñado en Hoy con el
     modelo único de problema: cada comprobación con su estado
     (bien / vigilar / mal) y su dato, y UN semáforo general = el
     peor estado. Nació de la falsa alarma del «contenedor
     fantasma»: que el estado real del sistema se vea de un
     vistazo, sin forenses. Nada de esto toca motores: solo lee
     estado que el servidor ya conoce y hace una micro-prueba de
     lectura/escritura sobre automation_state. */
  function systemHealth(time) {
    /* Los datos de los chequeos se leen en voz alta en Hoy: fecha
       corta y legible, nunca la marca ISO cruda. */
    const fechaCorta = ts => new Date(ts).toLocaleString('es-MX',
      { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'America/Mexico_City' });
    const checks = [];
    try {
      const probe = 'health:' + time;
      setState('health:probe', probe);
      if (getState('health:probe') !== probe) throw new Error('La lectura no coincidió con lo escrito.');
      checks.push({ id: 'db', label: 'La app y su base de datos', state: 'bien', dato: 'Responde y guarda datos.' });
    } catch { checks.push({ id: 'db', label: 'La app y su base de datos', state: 'mal', dato: 'La prueba de lectura y escritura falló.' }); }
    const watchError = inboxStatus.error || getState('watch:error');
    if (!inbox.dir) checks.push({ id: 'bandeja', label: 'Bandeja de importación', state: 'vigilar', dato: 'Sin configurar en el servidor.' });
    else if (watchError || !existsSync(inbox.dir)) checks.push({ id: 'bandeja', label: 'Bandeja de importación', state: 'mal',
      dato: watchError || 'La carpeta configurada no existe.' });
    else if (inboxStatus.failed > 0) checks.push({ id: 'bandeja', label: 'Bandeja de importación', state: 'vigilar',
      dato: inboxStatus.failed + ' archivo(s) no se importaron; el último procesado fue ' + (inboxStatus.lastProcessed ? 'reciente' : 'nunca') + '.' });
    else checks.push({ id: 'bandeja', label: 'Bandeja de importación', state: 'bien',
      dato: inboxStatus.lastProcessed ? 'Activa; último archivo procesado el ' + fechaCorta(inboxStatus.lastProcessed) + '.' : 'Activa; aún no procesa ningún archivo.' });
    const backupLast = Number(getState('backup:last')) || 0;
    const backupError = getState('backup:error');
    if (backupError) checks.push({ id: 'respaldo', label: 'Último respaldo', state: 'mal', dato: String(backupError) });
    else if (!backupLast) checks.push({ id: 'respaldo', label: 'Último respaldo', state: 'vigilar', dato: 'No consta ningún respaldo programado terminado.' });
    else if (time - backupLast > 8 * DAY) checks.push({ id: 'respaldo', label: 'Último respaldo', state: 'vigilar',
      dato: 'El último bueno es del ' + fechaCorta(backupLast) + ' (más de 8 días).' });
    else checks.push({ id: 'respaldo', label: 'Último respaldo', state: 'bien', dato: 'Último bueno: el ' + fechaCorta(backupLast) + '.' });
    try {
      const stats = statfsSync(dbFile === ':memory:' ? process.cwd() : dirname(dbFile));
      const freePct = stats.bsize ? Math.round(1000 * stats.bavail / stats.blocks) / 10 : 100;
      const freeGb = Math.round(stats.bavail * stats.bsize / 107374182.4) / 10;
      checks.push({ id: 'disco', label: 'Espacio en el disco', state: freePct < 5 ? 'mal' : freePct < 12 ? 'vigilar' : 'bien',
        dato: freeGb + ' GB libres (' + freePct + '% del volumen).' });
    } catch { checks.push({ id: 'disco', label: 'Espacio en el disco', state: 'vigilar', dato: 'No se pudo medir el espacio libre.' }); }
    const lastDocRun = db.prepare('SELECT ok,started FROM sat_doc_runs ORDER BY started DESC LIMIT 1').get();
    if (!lastDocRun) checks.push({ id: 'documentos', label: 'Documentos del SAT', state: 'vigilar', dato: 'Aún no se ha descargado ninguno.' });
    else if (!lastDocRun.ok) checks.push({ id: 'documentos', label: 'Documentos del SAT', state: 'vigilar',
      dato: 'el ' + fechaCorta(lastDocRun.started) });
    else checks.push({ id: 'documentos', label: 'Documentos del SAT', state: 'bien',
      dato: 'La última descarga salió bien el ' + fechaCorta(lastDocRun.started) + '.' });
    const lastWatch = db.prepare('SELECT MAX(checked) AS last FROM cfdi_watch').get()?.last || 0;
    if (!lastWatch) checks.push({ id: 'vigilancia', label: 'Revisión de comprobantes', state: 'vigilar', dato: 'Aún no se ha revisado ningún comprobante.' });
    else if (time - lastWatch > 2 * DAY) checks.push({ id: 'vigilancia', label: 'Revisión de comprobantes', state: 'vigilar',
      dato: 'La última revisión es del ' + fechaCorta(lastWatch) + ' (más de 2 días).' });
    else checks.push({ id: 'vigilancia', label: 'Revisión de comprobantes', state: 'bien',
      dato: 'Última revisión: el ' + fechaCorta(lastWatch) + '.' });
    const efosRow = db.prepare('SELECT fetched,error FROM efos_meta WHERE id=1').get();
    if (!efosRow?.fetched) checks.push({ id: 'listados', label: 'Listado 69-B', state: 'vigilar', dato: 'Aún no se ha descargado.' });
    else if (time - efosRow.fetched > 35 * DAY) checks.push({ id: 'listados', label: 'Listado 69-B', state: 'vigilar',
      dato: 'La copia es del ' + fechaCorta(efosRow.fetched) + ' (más de 35 días).' });
    else checks.push({ id: 'listados', label: 'Listado 69-B', state: 'bien', dato: 'Copia del ' + fechaCorta(efosRow.fetched) + '.' });
    /* El correo de avisos (la vieja franja de Hoy lo vigilaba y el
       Centro de mando no debe perder esa señal): sin correo, los
       avisos importantes de la pieza de correo se quedan dentro. */
    if (!mail) checks.push({ id: 'correo', label: 'Correo de avisos', state: 'vigilar',
      dato: 'Sin configurar: los avisos importantes no saldrán de la app.' });
    else if (!mailAlertsOn()) checks.push({ id: 'correo', label: 'Correo de avisos', state: 'vigilar',
      dato: 'Configurado, pero los avisos importantes están desactivados en Ajustes.' });
    else checks.push({ id: 'correo', label: 'Correo de avisos', state: 'bien',
      dato: 'Los avisos importantes llegan a ' + mail.recipient + '.' });
    const level = checks.some(check => check.state === 'mal') ? 'mal' :
      checks.some(check => check.state === 'vigilar') ? 'vigilar' : 'bien';
    return { at: time, level, checks };
  }
  /* ===== Avisos importantes por correo (1.13.0, pieza «3») =====
     Los tres sucesos que no pueden quedarse dentro de la app
     salen por correo, UNO por evento, reutilizando la tabla de
     alertas internas (su ref única deduplica; sus columnas
     due/sent/error son el control de envío y reintento, el mismo
     patrón de 15 minutos de los avisos de paquetes): una factura
     vigilada que pasa a CANCELADA, un emisor que entra en el
     69-B (Presunto o Definitivo) y una descarga de documentos
     del SAT que termina mal. El correo se compone con el modelo
     único de problema (titular, de quién es, qué significa, el
     gesto único) y solo con datos que el aviso interno ya lleva:
     jamás credenciales. Interruptor en Ajustes, activado por
     defecto; sin correo configurado no sale nada. */
  function mailAlertsOn() { return getSetting('mailAlerts') !== '0'; }
  /* Migración única (1.13.1, pieza G): las alertas de cancelación
     que al actualizar aún estén sin enviar son la avalancha
     histórica — su ref pasa a «cancel-first:» para que el envío
     individual las excluya y el resumen único las recoja, como a
     cualquier primer descubrimiento posterior. */
  if (!getState('cancel-first-1131')) {
    db.prepare("UPDATE alerts SET ref='cancel-first:'||substr(ref,8) WHERE kind='cancellation' AND sent IS NULL AND ref LIKE 'cancel:%'").run();
    setState('cancel-first-1131', '1');
  }
  /* Tope anti-avalancha (1.13.1): máximo de correos individuales de
     suceso por hora, sumando TODOS los tipos (cancelaciones por
     transición, 69-B y fallos de documentos). Lo que pase del tope
     no se pierde ni se manda suelto: se agrupa en el resumen. */
  const EVENT_MAIL_CAP_PER_HOUR = 5;
  const EVENT_MAIL_KIND = {
    cancellation: { deQuien: 'Del SAT: fue el SAT quien canceló el comprobante.',
      gesto: 'Qué hacer: entra en PacoSAT, en Vigilancia, y revisa el comprobante; si ya se pagó o se dedujo, avisa a tu contadora.' },
    efos: { deQuien: 'Del listado oficial del SAT (artículo 69-B).',
      gesto: 'Qué hacer: entra en PacoSAT, en Vigilancia, y revisa los comprobantes de ese RFC antes de deducirlos.' },
    'satdoc-fail': { deQuien: 'Del portal del SAT o de la conexión con él; tu e.firma firmó bien.',
      gesto: 'Qué hacer: entra en PacoSAT, en Documentos, y mira el problema en la tarjeta del RFC; desde el Centro de mando puedes reintentar la descarga.' }
  };
  async function sendEventAlerts(time) {
    if (!mail || !mailAlertsOn()) return;
    /* La cadencia de Ajustes › Correo manda también aquí: con el
       correo de avisos apagado («no») no sale ningún individual. */
    if (avisosConfig().correo === 'no') return;
    const active = mail;
    const sentThisHour = db.prepare("SELECT COUNT(*) AS n FROM mail_sends WHERE kind='alerta-evento' AND ok=1 AND at>=?").get(time - 3600000).n;
    let budget = Math.max(0, EVENT_MAIL_CAP_PER_HOUR - sentThisHour);
    /* Los primeros descubrimientos (ref «cancel-first:») quedan
       fuera SIEMPRE: su único correo posible es el resumen. */
    const items = db.prepare("SELECT * FROM alerts WHERE kind IN ('cancellation','efos','satdoc-fail') AND sent IS NULL AND due<=? AND ref NOT LIKE 'cancel-first:%' ORDER BY due LIMIT 10").all(time);
    for (const item of items) {
      if (!budget) {
        db.prepare('INSERT INTO event_digest(at,subject,body,rfc) VALUES (?,?,?,?)').run(time, item.subject, item.body, item.rfc || '');
        db.prepare('UPDATE alerts SET sent=?,error=? WHERE id=?').run(time,
          'Agrupada en el resumen del día: tope horario de correos alcanzado.', item.id);
        continue;
      }
      budget--;
      db.prepare('UPDATE alerts SET due=? WHERE id=?').run(time + 15 * MIN, item.id);
      const framing = EVENT_MAIL_KIND[item.kind];
      const text = ['Qué pasó: ' + item.body, '',
        'De quién es la causa: ' + framing.deQuien, '',
        framing.gesto, '',
        '— PacoSAT (aviso automático; el detalle completo y el historial están en la app).'].join('\n');
      try {
        await active.transport.sendMail({ from: displayFrom(active.from), to: active.recipient,
          subject: item.subject, text,
          messageId: '<pacosat-alerta-' + item.id + '-' + active.instance + '@pacosat.local>' });
        db.prepare('UPDATE alerts SET sent=?,error=? WHERE id=?').run(now(), '', item.id);
        db.prepare("INSERT INTO mail_sends(at,recipients,subject,kind,ok,error,rfc) VALUES (?,?,?,'alerta-evento',1,'',?)")
          .run(now(), active.recipient, item.subject, String(item.rfc || '').toUpperCase());
      } catch { db.prepare('UPDATE alerts SET error=? WHERE id=?').run('El servidor SMTP no aceptó el envío. Revisa la configuración y las credenciales.', item.id); }
    }
  }
  /* El resumen único de sucesos (1.13.1, pieza G): como mucho UN
     correo al día con (a) los comprobantes que ya constaban
     cancelados al descubrirlos revisando el histórico y (b) los
     avisos que el tope horario agrupó. Lo gobiernan el mismo
     interruptor de avisos importantes y la misma cadencia: con
     cualquiera de los dos apagado, no sale nada. */
  /* RFC nombrado en un texto (1.24.0, M3): el primer token con
     forma exacta de RFC; lo usa el resumen de sucesos para partir
     por contribuyente lo que solo se conoce por su texto. */
  const rfcEnTexto = text => (String(text || '').toUpperCase().split(/[^A-ZÑ&0-9]+/)
    .find(token => /^[A-ZÑ&]{3,4}[0-9]{6}[A-Z0-9]{3}$/.test(token))) || '';

  async function sendEventDigest(time) {
    if (!mail || !mailAlertsOn()) return;
    if (avisosConfig().correo === 'no') return;
    const discoveriesAll = db.prepare('SELECT s.id AS id, w.emitter AS emitter, w.receiver AS receiver ' +
      'FROM cancellation_seen s LEFT JOIN cfdi_watch w ON w.id=s.id WHERE s.digested IS NULL ORDER BY s.at').all()
      .map(row => ({ ...row, facts: cfdiMailFacts(row.id, row) }));
    const pooledAll = db.prepare('SELECT * FROM event_digest WHERE sent IS NULL ORDER BY at').all();
    /* La cuenta de la descarga automática mensual (1.15.0): viaja
       en ESTE resumen, como su propia sección — no es un aviso
       suelto ni un agrupado por el tope — y solo se borra de la
       cola cuando el resumen sale de verdad. */
    const monthlyAll = (() => { try { return JSON.parse(getState('monthly-digest-pending') || '[]'); } catch { return []; } })();
    if (!discoveriesAll.length && !pooledAll.length && !monthlyAll.length) return;
    /* Correos por RFC (1.24.0, M3): el resumen de sucesos se parte
       por contribuyente, como el de avisos. Cada suceso se asigna
       al RFC dueño que consta en los datos (el perfil entre
       emisor y receptor en las cancelaciones; el RFC nombrado en
       el texto en los agrupados y en las notas mensuales); lo que
       no nombra a ningún perfil viaja en el correo de la
       instalación. El día se marca POR GRUPO y cada grupo marca
       solo sus filas: un fallo de envío deja su grupo intacto. */
    const profileSet = new Set(db.prepare('SELECT rfc FROM profiles').all().map(row => row.rfc));
    const groups = new Map();
    const groupOf = key => { if (!groups.has(key)) groups.set(key, { discoveries: [], pooled: [], monthlyNotes: [] }); return groups.get(key); };
    for (const row of discoveriesAll)
      groupOf(profileSet.has(row.emitter) ? row.emitter : profileSet.has(row.receiver) ? row.receiver : '').discoveries.push(row);
    for (const row of pooledAll) {
      /* H-6.1 (1.27.0): la columna rfc manda; la búsqueda en el
         texto queda SOLO para filas legadas que llegaron sin ella. */
      const porColumna = row.rfc && profileSet.has(row.rfc) ? row.rfc : '';
      const nombrado = porColumna || rfcEnTexto(String(row.subject || '') + ' ' + String(row.body || ''));
      groupOf(profileSet.has(nombrado) ? nombrado : '').pooled.push(row);
    }
    for (const note of monthlyAll) {
      /* Las notas mensuales nuevas traen sus RFC como dato
         (note.rfcs, 1.27.0); las legadas, por el texto. */
      const porDato = Array.isArray(note.rfcs) ? note.rfcs.find(r => profileSet.has(r)) || '' : '';
      const nombrado = porDato || rfcEnTexto(String(note.subject || '') + ' ' + String(note.body || ''));
      groupOf(profileSet.has(nombrado) ? nombrado : '').monthlyNotes.push(note);
    }
    const active = mail;
    /* Tabla con los datos que faltaban en la avalancha (G2):
       contraparte con nombre, folio, fecha e importe por fila. */
    const filaDescubierta = row => {
      const f = row.facts;
      return '· ' + (f.contraparte.name || f.contraparte.rfc) + ' (' + f.contraparte.rfc + ')' +
        (f.folio ? ' · folio ' + (f.serie ? f.serie + '-' : '') + f.folio : '') +
        (f.fecha ? ' · ' + f.fecha : '') + (f.total ? ' · $' + importeShow(f.total) : '') +
        ' · UUID ' + row.id;
    };
    const sentMonthly = [];
    for (const [rfc, group] of groups) {
      const { discoveries, pooled, monthlyNotes } = group;
      if (!discoveries.length && !pooled.length && !monthlyNotes.length) continue;
      if (getState('event-digest-day:' + (rfc || 'instalacion')) === day(time)) continue;
      const lines = ['Resumen de sucesos de PacoSAT · ' + (rfc ? 'RFC ' + rfc + ' · ' : '') + day(time), ''];
      const propias = discoveries.filter(row => row.facts.emitido);
      const ajenas = discoveries.filter(row => !row.facts.emitido);
      if (ajenas.length) {
        lines.push('AL PONERTE AL DÍA — COMPROBANTES QUE YA CONSTABAN CANCELADOS (' + ajenas.length + '):',
          'Aparecieron al revisar el histórico; ninguno es una cancelación nueva, y por eso no salió un correo por cada uno.', '');
        for (const row of ajenas.slice(0, 100)) lines.push(filaDescubierta(row));
        if (ajenas.length > 100) lines.push("· …y " + (ajenas.length - 100) + " más, en Vigilancia dentro de la app.");
        lines.push('');
      }
      if (propias.length) {
        /* Emitidos por el propio RFC (G2): normalmente los canceló
           él mismo — se agrupan como información, no como alarma. */
        lines.push('TUS PROPIAS CANCELACIONES DETECTADAS (' + propias.length + '):',
          'Son facturas emitidas por tu RFC que ya constaban canceladas en la primera consulta — en general, cancelaciones hechas por ti. Solo quedan registradas.', '');
        for (const row of propias.slice(0, 100)) lines.push(filaDescubierta(row));
        if (propias.length > 100) lines.push("· …y " + (propias.length - 100) + " más, en Vigilancia dentro de la app.");
        lines.push('');
      }
      if (pooled.length) {
        lines.push('AVISOS AGRUPADOS POR EL TOPE DE CORREOS (' + pooled.length + '):', '');
        for (const row of pooled.slice(0, 15)) {
          lines.push('· ' + row.subject);
          if (row.body) lines.push('  ' + String(row.body).slice(0, 220));
        }
        if (pooled.length > 15) lines.push('· …y ' + (pooled.length - 15) + ' más, en el Centro de Avisos.');
        lines.push('');
      }
      if (monthlyNotes.length) {
        lines.push('DESCARGA AUTOMÁTICA MENSUAL:', '');
        for (const note of monthlyNotes) {
          lines.push('· ' + note.subject);
          for (const extra of String(note.body || '').split('\n')) if (extra) lines.push('  ' + extra);
        }
        lines.push('');
      }
      lines.push('Todo queda registrado en el Centro de Avisos de PacoSAT. Este es el único resumen del día de ' +
        (rfc || 'la instalación') + ' por estos sucesos.');
      const subjectBase = monthlyNotes.length && !discoveries.length && !pooled.length
        ? 'PacoSAT · ' + monthlyNotes[0].subject
        : discoveries.length && !pooled.length
        ? 'PacoSAT · Al ponerte al día: ' + discoveries.length + ' comprobantes ya constaban cancelados'
        : 'PacoSAT · Resumen de sucesos: ' + (discoveries.length + pooled.length) + ' avisos agrupados';
      try {
        await active.transport.sendMail({ from: displayFrom(active.from), to: active.recipient,
          subject: rfc ? 'PacoSAT · ' + rfc + ' · ' + subjectBase.replace(/^PacoSAT · /, '') : subjectBase,
          text: lines.join('\n'),
          messageId: '<pacosat-resumen-sucesos-' + day(time) + '-' + (rfc || 'instalacion') + '-' + active.instance + '@pacosat.local>' });
        const markSeen = db.prepare('UPDATE cancellation_seen SET digested=? WHERE id=?');
        for (const row of discoveries) markSeen.run(time, row.id);
        const markPool = db.prepare('UPDATE event_digest SET sent=? WHERE id=?');
        for (const row of pooled) markPool.run(time, row.id);
        for (const note of monthlyNotes) sentMonthly.push(note);
        setState('event-digest-day:' + (rfc || 'instalacion'), day(time));
        db.prepare("INSERT INTO mail_sends(at,recipients,subject,kind,ok,error,rfc) VALUES (?,?,?,'resumen-eventos',1,'',?)")
          .run(time, active.recipient, 'Resumen de sucesos ' + (rfc || 'instalación') + ' (' + (discoveries.length + pooled.length) + ')', rfc || '');
      } catch { /* sin envío: este grupo queda sin marcar y se reintenta en el siguiente ciclo */ }
    }
    if (sentMonthly.length)
      setState('monthly-digest-pending', JSON.stringify(monthlyAll.filter(note => !sentMonthly.includes(note))));
  }

  /* Resumen GLOBAL de vigilancia desde el registro verdadero
     (1.22.0, pieza 2): la tarjeta de Hoy ya no cuenta desde la
     caché de sesión del navegador (fiscalResults, que nace vacía
     y congelaba «2.612 por revisar · Aún sin revisiones» contra
     una base que decía otra cosa). Aquí manda cfdi_watch: cada
     comprobante del expediente con su último estado guardado.
     «Por revisar» = sin resultado guardado todavía; los 112
     recuperados entran así hasta que la vigilancia los mira, y
     la tarjeta lo dice en palabras, no con un contador espejo. */
  function monitorGlobalSummary() {
    const watch = new Map();
    let lastChecked = 0;
    for (const row of db.prepare('SELECT id,checked,result,error FROM cfdi_watch').all()) {
      let state = '';
      try { state = JSON.parse(row.result || '{}').state || ''; } catch { state = ''; }
      if (!state && row.error) state = 'Error';
      watch.set(row.id, state);
      if (row.checked) lastChecked = Math.max(lastChecked, row.checked);
    }
    const ownRfcs = db.prepare('SELECT rfc FROM profiles').all().map(row => row.rfc);
    const blank = () => ({ total: 0, vigentes: 0, cancelados: 0, problemas: 0, porRevisar: 0 });
    const perRfc = {};
    for (const rfc of ownRfcs) perRfc[rfc] = blank();
    const all = blank();
    const tally = (bucket, state) => {
      bucket.total++;
      if (state === 'Vigente') bucket.vigentes++;
      else if (state === 'Cancelado') bucket.cancelados++;
      else if (state === 'No encontrado' || state === 'Formato rechazado' || state === 'Error') bucket.problemas++;
      else bucket.porRevisar++;
    };
    const archivadosVigilancia = archivedInvoiceIds();
    const ejercicioVivo = prescriptionLiveYear(now());
    for (const invoice of recordInvoices()) {
      /* Corte de prescripción en la vigilancia ACTIVA (1.24.0,
         punto 2): la vigilancia contaba desde recordInvoices()
         ENTERO —también lo archivado por el cierre de línea base
         y todo ejercicio ya prescrito—, así que sus cifras no
         podían cuadrar con Avisos, Dinero y el Buzón, que ya
         aplican el corte. Aquí manda la misma regla: fuera lo
         archivado y fuera todo CFDI de un ejercicio anterior al
         primer ejercicio vivo (prescriptionLiveYear, la función
         de la 1.23.0). Lo de fecha ilegible no se descarta: no
         consta que sea viejo. El archivo sigue consultable en el
         expediente; solo deja de contar como trabajo vivo. */
      if (archivadosVigilancia.has(invoice.id)) continue;
      const anioFactura = Number(String(invoice.date || '').slice(0, 4));
      if (Number.isInteger(anioFactura) && anioFactura > 0 && anioFactura < ejercicioVivo) continue;
      const state = watch.get(invoice.id);
      tally(all, state);
      const involved = new Set([invoice.from?.rfc, invoice.to?.rfc].filter(rfc => perRfc[rfc]));
      for (const rfc of involved) tally(perRfc[rfc], state);
    }
    return { ...all, perRfc, lastChecked: lastChecked || null,
      /* R5 (1.22.0): la última VUELTA COMPLETA de la vigilancia,
         para poder decir «nadie vigila al vigilante» con datos:
         el tick la compara y avisa si lleva días sin completarse. */
      lastFullSweep: Number(getState('monitor:last-full-sweep') || 0) || null };
  }
  /* Conteos del expediente real (1.22.0, N6): Hoy contaba el
     almacén «documents» DEL NAVEGADOR (2) contra un expediente
     del servidor con constancias, opiniones y declaraciones.
     Esto cuenta las tres fuentes del servidor y las nombra. */
  function expedienteCounts() {
    const satDocumentos = db.prepare("SELECT COUNT(*) AS n FROM sat_documents WHERE fileId<>''").get().n;
    const declaraciones = db.prepare("SELECT COUNT(*) AS n FROM declaraciones WHERE fileId<>''").get().n;
    let archivados = 0;
    try { archivados = db.prepare("SELECT COUNT(*) AS n FROM records WHERE store='documents'").get().n; } catch { archivados = 0; }
    return { satDocumentos, declaraciones, archivados, total: satDocumentos + declaraciones + archivados };
  }

  /* ===== Buzón (1.23.0, frente B) =====
     Bandeja de entrada del RFC: mezcla los CFDI recibidos y los
     documentos del SAT ya guardados, lo nuevo primero, con marca
     de leído por RFC en buzon_marks. No promete el Buzón Tributario
     del SAT: solo enseña lo que PacoSAT ya capturó. */
  function buzonItems(rfc, limit = 200) {
    const target = String(rfc || '');
    const tope = Math.max(1, Math.min(500, Number(limit) || 200));
    let marks = new Set();
    try { marks = new Set(db.prepare('SELECT itemKey FROM buzon_marks WHERE rfc=?').all(target).map(row => row.itemKey)); }
    catch { marks = new Set(); }
    const items = [];
    /* Frente E (1.23.0): lo archivado por el cierre de línea base
       tampoco vive en el Buzón — es archivo consultable, no
       bandeja de trabajo. */
    const archivados = archivedInvoiceIds();
    for (const invoice of recordInvoices()) {
      if (archivados.has(invoice.id)) continue;
      if (String(invoice.to?.rfc || '') !== target) continue;
      const key = 'cfdi:' + invoice.id;
      const atMs = Date.parse(String(invoice.date || '')) || 0;
      const detalle = [folioLabel(invoice), invoice.total ? String(invoice.total) : '',
        invoice.state ? String(invoice.state) : ''].filter(Boolean).join(' · ');
      items.push({ key, kind: 'cfdi', at: Number.isFinite(atMs) ? atMs : 0,
        titulo: invoice.from?.name || invoice.from?.rfc || '', detalle,
        importe: invoice.total || '', uuid: invoice.id, read: marks.has(key) });
    }
    const DOC_LABEL_LOCAL = { constancia: 'Constancia / CIF', opinion: 'Opinión de cumplimiento' };
    try {
      for (const row of db.prepare('SELECT * FROM sat_documents WHERE rfc=?').all(target)) {
        const key = 'doc:' + row.id;
        items.push({ key, kind: 'documento', at: Number(row.issuedAt) || Number(row.created) || 0,
          titulo: DOC_LABEL_LOCAL[row.kind] || row.kind || 'Documento del SAT',
          detalle: '', importe: '', uuid: '', id: row.id, fileId: row.fileId || '',
          read: marks.has(key) });
      }
    } catch { /* sin documentos del SAT */ }
    items.sort((a, b) => (b.at - a.at) || String(b.key).localeCompare(String(a.key)));
    return items.slice(0, tope);
  }

  /* ===== Buzón Tributario del SAT (1.24.0, punto 1) =====
     Consulta que LISTA las notificaciones sin abrir ninguna: el
     motor (sat-tributario.mjs) lee la bandeja con la e.firma del
     perfil y devuelve solo la lista; aquí se guarda como
     registros consultables por RFC (trib_notifications), con su
     diario por pasos (trib_runs, patrón decl_runs), su reintento
     si la causa es del portal y su aviso en Hoy cuando quedan
     notificaciones sin abrir. Abrir una notificación es gesto de
     Paco en el portal oficial: puede darla por notificada e
     iniciar plazos, y la máquina no lo hace jamás. */
  const tribLive = new Map();
  const tribState = () => { try { return JSON.parse(getSetting('trib-state') || '{}'); } catch { return {}; } };
  function writeTribProgress(rfc, progress) {
    const current = tribState();
    current[rfc] = progress;
    setSetting('trib-state', JSON.stringify(current));
  }
  const tribNorm = value => String(value || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
  /* Fecha larga desde un ISO 'AAAA-MM-DD' (UTC, sin depender de
     la zona del servidor): para las frases de plazo del buzón. */
  const fechaLargaIso = iso => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
    if (!m) return String(iso || '');
    return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
      .toLocaleDateString('es-MX', { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric' });
  };
  /* La sin-abrir más antigua de un RFC y su fecha de «tenida por
     notificada» (1.27.0, bloque D): la que manda en Hoy y en el
     aviso, porque su plazo es el primero que vence. */
  function tribProximaTenida(rfc) {
    /* Solo lo que requiere atención manda en el plazo: lo archivado
       en local (opiniones e informativos) no empuja avisos. */
    const row = db.prepare("SELECT fecha FROM trib_notifications WHERE rfc=? AND abierta=0 AND archivada=0 AND enPapelera=0 AND fecha<>'' ORDER BY fecha LIMIT 1").get(rfc);
    if (!row) return null;
    const plazo = buzonPlazo(row.fecha);
    return plazo ? { fecha: row.fecha, tenida: plazo.tenida, limite: plazo.limite, efectos: plazo.efectos } : null;
  }
  function tribClave(row) {
    return createHash('sha256')
      .update([row.fecha || '', tribNorm(row.asunto), tribNorm(row.remitente)].join('|'))
      .digest('hex').slice(0, 32);
  }
  function tribStoreNotifications(rfc, rows, time) {
    let nuevas = 0;
    /* Archivo local que la sincronización NO resucita (1.29.0): la
       clasificación nace del texto listado (classifyBuzonRow) y las
       opiniones/informativos se archivan solos AL NACER. En filas
       que ya existen, el ON CONFLICT actualiza solo lo que el SAT
       enseña (estado/abierta/última vez): categoria, archivada y
       archivadaEn son estado LOCAL y jamás se pisan desde una
       sincronización. */
    const upsert = db.prepare('INSERT INTO trib_notifications(rfc,clave,fecha,asunto,remitente,estado,abierta,primeraVez,ultimaVez,categoria,archivada,archivadaEn) ' +
      'VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(rfc,clave) DO UPDATE SET estado=excluded.estado, abierta=excluded.abierta, ultimaVez=excluded.ultimaVez');
    const lapida = db.prepare('SELECT 1 FROM trib_tombstones WHERE rfc=? AND clave=?');
    for (const row of rows) {
      const clave = tribClave(row);
      /* Lápida (1.29.0): lo purgado por Paco no vuelve JAMÁS,
         aunque el SAT lo siga listando en cada consulta. */
      if (lapida.get(rfc, clave)) continue;
      const existed = db.prepare('SELECT clave FROM trib_notifications WHERE rfc=? AND clave=?').get(rfc, clave);
      const categoria = classifyBuzonRow(row);
      const archivada = categoria === 'atencion' ? 0 : 1;
      upsert.run(rfc, clave, String(row.fecha || ''), String(row.asunto || ''), String(row.remitente || ''),
        String(row.estado || ''), row.abierta ? 1 : 0, time, time,
        categoria, archivada, archivada ? time : 0);
      if (!existed) nuevas++;
    }
    return nuevas;
  }
  function tribOverview(rfc, { incluirArchivadas = false, incluirPapelera = false } = {}) {
    const todas = db.prepare('SELECT * FROM trib_notifications WHERE rfc=? ORDER BY fecha DESC, primeraVez DESC').all(rfc);
    /* Vista principal = solo lo que requiere atención (1.29.0):
       las archivadas en local (opiniones de cumplimiento y
       documentos informativos, o lo que Paco archive a mano) solo
       salen cuando la pantalla las pide expresamente. Lo que está
       en la papelera sale de TODAS las vistas principales: solo
       la Papelera lo enseña, cuando la pantalla la abre. */
    const vivas = todas.filter(row => !row.enPapelera);
    const rows = incluirArchivadas ? vivas : vivas.filter(row => !row.archivada);
    const papeleraRows = incluirPapelera ? todas.filter(row => row.enPapelera) : [];
    const runs = db.prepare('SELECT * FROM trib_runs WHERE rfc=? ORDER BY started DESC LIMIT 10').all(rfc)
      .map(row => ({ id: row.id, started: row.started, finished: row.finished, ok: Boolean(row.ok),
        error: row.error, errorKind: row.errorKind, attempts: row.attempts,
        encontradas: row.encontradas, sinAbrir: row.sinAbrir, origen: row.origen || '',
        hasShot: Boolean(row.shotId), hasHtml: Boolean(row.htmlId),
        steps: (() => { try { return JSON.parse(row.steps || '[]'); } catch { return []; } })() }));
    const lastOk = runs.find(run => run.ok);
    const atencion = vivas.filter(row => !row.archivada);
    const mapear = row => ({ clave: row.clave, fecha: row.fecha, asunto: row.asunto, remitente: row.remitente,
      estado: row.estado, abierta: Boolean(row.abierta), primeraVez: row.primeraVez, ultimaVez: row.ultimaVez,
      categoria: row.categoria || 'atencion', archivada: Boolean(row.archivada), archivadaEn: row.archivadaEn || 0,
      enPapelera: Boolean(row.enPapelera), papeleraEn: row.papeleraEn || 0,
      /* El plazo corre aunque nadie abra (1.27.0): cada sin
         abrir enseña cuándo se tiene por notificada. */
      plazo: row.abierta ? null : buzonPlazo(row.fecha) });
    return { rfc,
      notificaciones: rows.map(mapear),
      papelera: papeleraRows.map(mapear),
      papeleraTotal: todas.filter(row => row.enPapelera).length,
      /* sinAbrir cuenta lo que requiere atención sin abrir; el
         total listado y las archivadas viajan aparte, sin mezclar. */
      sinAbrir: atencion.filter(row => !row.abierta).length,
      sinAbrirTotal: vivas.filter(row => !row.abierta).length,
      archivadas: vivas.length - atencion.length,
      total: atencion.length, totalListadas: vivas.length,
      proximaTenida: tribProximaTenida(rfc),
      /* Consulta automática semanal (1.28.0, P3): la cadencia se
         ancla en la ÚLTIMA corrida — de cualquier origen — y la
         pantalla dice cuándo toca la siguiente. */
      cadenciaDias: 7,
      proximaAuto: runs.length ? runs[0].started + TRIB_CADENCE_MS : null,
      ultimaConsulta: lastOk ? lastOk.finished : null, runs, progreso: tribState()[rfc] || null };
  }
  /* Cadencia automática del Buzón Tributario (1.28.0, P3): una
     consulta por semana y RFC, lanzada por el propio tick con el
     MISMO intento del botón. Semanal y no mensual porque la
     notificación no abierta se tiene por notificada al 4.º día
     (art. 134-I CFF): con cadencia mensual, una notificación
     podría descubrirse con los efectos ya corriendo. Respeta el
     descanso (el tick no la llama en Descansar), la pausa del
     perfil y que el acceso sea por e.firma (el buzón no admite
     CIEC); si hay una consulta en curso, espera a la siguiente
     vuelta. */
  const TRIB_CADENCE_MS = 7 * DAY;
  async function tribAutoTick(time) {
    const index = readEfirmaIndex();
    for (const profile of db.prepare('SELECT * FROM profiles ORDER BY rfc').all()) {
      const rfc = profile.rfc;
      if (profilePaused(profile, time)) continue;
      if (tribLive.has(rfc)) continue;
      /* El método es CIEC solo cuando el índice lo dice: sin
         entrada, el acceso es por e.firma — el mismo defecto que
         enseña el parte (accessMethod). Y la cadencia solo corre
         con la e.firma GUARDADA en el equipo (la subida desde la
         app): es la que sobrevive a los reinicios y la que el
         motor lee; un desbloqueo solo en memoria es de sesión y
         no sostiene una consulta automática semanal. */
      if (index[rfc]?.access === 'ciec') continue;
      if (!existsSync(efirmaPath(rfc, '.cer'))) continue;
      const last = db.prepare('SELECT MAX(started) AS started FROM trib_runs WHERE rfc=?').get(rfc)?.started || 0;
      if (last && time - last < TRIB_CADENCE_MS) continue;
      try { await runTributarioAttempt(rfc, time, 'sistema'); }
      catch { /* el intento ya dejó su diario y su aviso */ }
    }
  }
  /* Declaraciones en automático (1.29.0): en modo remoto el tick
     encola, una vez por semana y RFC, la recuperación del ejercicio
     en curso para el ejecutor local — sin ejecutor, el trabajo
     espera; con ejecutor, su primera recogida ES la prueba viva
     (Mano Fil, un mes, PDF + operación). La cadencia se ancla en
     el último trabajo de esa clase o en la última corrida del
     diario, lo primero que conste, y respeta pausa y descanso
     como el resto de cadencias. En modo local no se encola nada:
     la recuperación sigue siendo el gesto de su pantalla. */
  const DECL_AUTO_CADENCE_MS = 7 * DAY;
  async function declAutoTick(time) {
    if (!remoteExecutor) return;
    const index = readEfirmaIndex();
    const ejercicio = Number(new Date(time).toISOString().slice(0, 4));
    for (const profile of db.prepare('SELECT * FROM profiles ORDER BY rfc').all()) {
      const rfc = profile.rfc;
      if (profilePaused(profile, time)) continue;
      if (index[rfc]?.access === 'ciec') continue;
      if (!existsSync(efirmaPath(rfc, '.cer'))) continue;
      const lastJob = db.prepare("SELECT MAX(creado) AS t FROM sat_executor_jobs WHERE rfc=? AND kind='declaraciones-recuperar'").get(rfc)?.t || 0;
      const lastRun = db.prepare('SELECT MAX(started) AS t FROM decl_runs WHERE rfc=?').get(rfc)?.t || 0;
      const last = Math.max(lastJob, lastRun);
      if (last && time - last < DECL_AUTO_CADENCE_MS) continue;
      try { queueRemoteRun(rfc, 'declaraciones-recuperar', { ejercicio, tipo: 'mensual' }, 'sistema'); }
      catch { /* el trabajo no nació: la siguiente vuelta lo intenta */ }
    }
  }
  function tribSummaryPorRfc() {
    const out = {};
    try {
      for (const row of db.prepare('SELECT rfc, COUNT(*) AS total, SUM(CASE WHEN abierta=0 AND archivada=0 AND enPapelera=0 THEN 1 ELSE 0 END) AS sinAbrir FROM trib_notifications GROUP BY rfc').all())
        out[row.rfc] = { total: row.total, sinAbrir: row.sinAbrir || 0,
          proximaTenida: tribProximaTenida(row.rfc) };
    } catch { /* sin consultas todavía */ }
    return out;
  }
  /* ===== Ejecutor local del SAT (1.29.0) =====
     PacoSAT ordena, registra y archiva; el ejecutor del equipo de
     Paco navega. Un trabajo nace «en-cola»; si ningún ejecutor lo
     reclama, NO es un fallo del SAT: está «esperando tu equipo».
     El ejecutor se empareja con un token propio (solo su huella
     vive aquí), reclama trabajos con una concesión (lease) corta,
     y al terminar devuelve traza + resultado por el protocolo de
     sat-executor.mjs, que rechaza credenciales y operaciones de
     apertura del Buzón. El cierre aplica el resultado SOLO tras
     validarlo: buzón → tribStoreNotifications; declaraciones →
     archiveDeclaracion con los documentos ya verificados (PDF +
     operación); y cada intento queda en sat_executor_attempts y
     reflejado en el diario del motor (trib_runs / decl_runs), que
     es lo que el Registro enseña desde la 1.28.0. */
  const EXECUTOR_LEASE_MS = 10 * MIN;
  const EXECUTOR_ONLINE_MS = 3 * MIN;
  const executorTokenHash = token => createHash('sha256').update(String(token || '')).digest('hex');
  function executorByToken(token) {
    if (!token || String(token).length < 32) return null;
    const row = db.prepare('SELECT * FROM sat_executors WHERE tokenHash=? AND revocado=0')
      .get(executorTokenHash(token));
    return row || null;
  }
  function executorOnline(time = now()) {
    const row = db.prepare('SELECT MAX(ultimoVisto) AS visto FROM sat_executors WHERE revocado=0').get();
    return Boolean(row?.visto && time - row.visto < EXECUTOR_ONLINE_MS);
  }
  function executorJobView(row) {
    if (!row) return null;
    let payload = {}, plan = [], steps = [], resumen = {};
    try { payload = JSON.parse(row.payload || '{}'); } catch { /* payload ilegible */ }
    try { plan = JSON.parse(row.plan || '[]'); } catch { /* plan ilegible */ }
    try { steps = JSON.parse(row.steps || '[]'); } catch { /* traza ilegible */ }
    try { resumen = JSON.parse(row.resumen || '{}'); } catch { /* resumen ilegible */ }
    return { id: row.id, protocol: SAT_EXECUTOR_PROTOCOL_VERSION, rfc: row.rfc, kind: row.kind,
      payload, plan, estado: row.estado, creado: row.creado, actualizado: row.actualizado,
      reclamadoPor: row.reclamadoPor || '', intentos: row.intentos || 0, steps,
      error: row.error || '', errorKind: row.errorKind || '', resumen,
      hasShot: Boolean(row.shotId), hasHtml: Boolean(row.htmlId), origen: row.origen || '',
      esperandoEquipo: row.estado === 'en-cola' && !executorOnline(row.actualizado || now()) };
  }
  function enqueueExecutorJob({ rfc, kind, payload = {}, origen = 'paco' }) {
    const descriptor = buildExecutorJob({ rfc, kind, payload, created: now() });
    const abierto = db.prepare("SELECT * FROM sat_executor_jobs WHERE dedupeKey=? AND estado IN ('en-cola','reclamado','en-curso') ORDER BY creado DESC LIMIT 1")
      .get(descriptor.dedupeKey);
    if (abierto) return { job: executorJobView(abierto), repetido: true };
    const id = randomUUID();
    db.prepare('INSERT INTO sat_executor_jobs(id,dedupeKey,rfc,kind,payload,plan,estado,creado,actualizado,origen) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(id, descriptor.dedupeKey, descriptor.rfc, descriptor.kind,
        JSON.stringify(descriptor.payload), JSON.stringify(descriptor.plan), 'en-cola',
        descriptor.created, descriptor.created, origen || 'paco');
    auditEvent('accion', 'Trabajo para el ejecutor local del SAT: ' + descriptor.kind + ' de ' + descriptor.rfc +
      (executorOnline() ? '' : ' (queda esperando tu equipo)'), descriptor.rfc, 1);
    return { job: executorJobView(db.prepare('SELECT * FROM sat_executor_jobs WHERE id=?').get(id)), repetido: false };
  }
  function expireExecutorLeases(time) {
    const vencidos = db.prepare("SELECT * FROM sat_executor_jobs WHERE estado IN ('reclamado','en-curso') AND leaseHasta>0 AND leaseHasta<?").all(time);
    for (const row of vencidos) {
      db.prepare("UPDATE sat_executor_jobs SET estado='en-cola', reclamadoPor='', leaseHasta=0, actualizado=? WHERE id=?")
        .run(time, row.id);
      auditEvent('accion', 'La concesión del trabajo ' + row.kind + ' de ' + row.rfc +
        ' venció sin resultado: vuelve a la cola, esperando tu equipo.', row.rfc, 1);
    }
    return vencidos.length;
  }
  function claimExecutorJobs(executor, limit = 5) {
    const time = now();
    expireExecutorLeases(time);
    db.prepare('UPDATE sat_executors SET ultimoVisto=? WHERE id=?').run(time, executor.id);
    const rows = db.prepare("SELECT * FROM sat_executor_jobs WHERE estado='en-cola' ORDER BY creado LIMIT ?")
      .all(Math.max(1, Math.min(20, Number(limit) || 5)));
    const claimed = [];
    for (const row of rows) {
      db.prepare("UPDATE sat_executor_jobs SET estado='en-curso', reclamadoPor=?, reclamadoEn=?, leaseHasta=?, intentos=intentos+1, actualizado=? WHERE id=?")
        .run(executor.id, time, time + EXECUTOR_LEASE_MS, time, row.id);
      claimed.push(executorJobView(db.prepare('SELECT * FROM sat_executor_jobs WHERE id=?').get(row.id)));
    }
    return claimed;
  }
  /* Refleja el intento en el diario del motor correspondiente,
     con la evidencia persistida por saveRunDiag (verificado). */
  function mirrorExecutorDiary(job, attemptId, ok, validated, errorText, errorKind, time) {
    const steps = (validated?.steps || []).map(step => ({ at: step.at || time, intento: 1, paso: step.paso, detalle: step.detalle || '' }));
    const guardado = !ok && validated?.diag ? saveRunDiag(attemptId, validated.diag) : { shotId: '', htmlId: '', faltas: [] };
    if (!ok && validated?.diag)
      steps.push(...diagCierreSteps(validated.diag, guardado).map(paso => ({ at: paso.at, intento: 1, paso: paso.text, detalle: '' })));
    if (job.kind === 'buzon-listar') {
      db.prepare('INSERT INTO trib_runs(id,rfc,started,finished,ok,error,errorKind,steps,attempts,encontradas,sinAbrir,shotId,htmlId,origen) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(attemptId, job.rfc, time, time, ok ? 1 : 0, errorText || '', errorKind || '', JSON.stringify(steps), 1,
          validated?.counts?.total || 0, validated?.counts?.sinAbrir || 0, guardado.shotId, guardado.htmlId, 'ejecutor');
      pruneRunDiary('trib_runs', job.rfc, time);
    } else if (job.kind.startsWith('declaraciones') || job.kind === 'declaracion-folio') {
      const tipo = job.kind === 'declaracion-folio' ? 'folio' :
        job.kind === 'declaraciones-transacciones' ? 'transacciones' : (job.payload?.tipo || 'mensual');
      db.prepare('INSERT INTO decl_runs(id,rfc,tipo,ejercicio,periodo,started,finished,ok,error,errorKind,steps,attempts,shotId,htmlId,origen) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(attemptId, job.rfc, tipo, Number(job.payload?.ejercicio) || 0, String(job.payload?.periodo || ''),
          time, time, ok ? 1 : 0, errorText || '', errorKind || '', JSON.stringify(steps), 1,
          guardado.shotId, guardado.htmlId, 'ejecutor');
      pruneRunDiary('decl_runs', job.rfc, time);
    }
    return guardado;
  }
  function completeExecutorJob(jobRow, executor, body) {
    const time = now();
    need(jobRow.estado === 'en-curso' && jobRow.reclamadoPor === executor.id,
      'Ese trabajo no está reclamado por este ejecutor (o su concesión venció).', 409);
    const job = { rfc: jobRow.rfc, kind: jobRow.kind, payload: JSON.parse(jobRow.payload || '{}') };
    const attemptId = randomUUID();
    let validated = null;
    try {
      validated = validateExecutorResult(job, body?.result || {});
    } catch (error) {
      /* Un resultado que viola el protocolo se registra como
         intento rechazado, con el motivo literal: el Registro lo
         enseña y el trabajo vuelve a la cola una vez; a la segunda
         queda fallido para no ciclar para siempre. */
      const steps = [{ at: time, paso: 'Resultado rechazado por el protocolo', detalle: message(error) }];
      db.prepare('INSERT INTO sat_executor_attempts(id,jobId,executorId,started,finished,ok,error,errorKind,steps) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(attemptId, jobRow.id, executor.id, time, time, 0, message(error), 'protocolo', JSON.stringify(steps));
      const reintenta = (jobRow.intentos || 0) < 2;
      db.prepare('UPDATE sat_executor_jobs SET estado=?, reclamadoPor=?, leaseHasta=0, steps=?, error=?, errorKind=?, actualizado=? WHERE id=?')
        .run(reintenta ? 'en-cola' : 'fallido', reintenta ? '' : jobRow.reclamadoPor, JSON.stringify(steps),
          message(error), 'protocolo', time, jobRow.id);
      return { ok: false, rechazado: true, error: message(error), reintenta };
    }
    const fallo = body?.status === 'failed' || Boolean(validated.error);
    let guardados = 0, descubiertos = 0;
    const resumen = { operations: validated.operations, warnings: validated.warnings };
    if (!fallo && job.kind === 'buzon-listar') {
      resumen.nuevas = tribStoreNotifications(job.rfc, validated.notifications, time);
      resumen.encontradas = validated.counts.total;
      resumen.sinAbrir = tribOverview(job.rfc).sinAbrir;
    }
    if (!fallo && (job.kind === 'declaraciones-recuperar' || job.kind === 'declaracion-folio')) {
      for (const doc of validated.documents) {
        if (archiveDeclaracion(job.rfc, { ...doc, ejecutorJobId: jobRow.id }, time, 'ejecutor')) guardados++;
      }
      resumen.guardados = guardados;
      resumen.rechazados = validated.rejected;
      if (validated.rejected.length && !guardados) {
        validated.error = 'El ejecutor devolvió documentos que NO pasaron la verificación: ' +
          validated.rejected.map(r => (r.periodo || r.operacion || 'documento') + ' — ' + r.reasons.join('; ')).join(' · ');
        validated.errorKind = 'verificacion';
      }
    }
    if (!fallo && validated.transactions?.length) {
      for (const t of validated.transactions) {
        const existing = db.prepare('SELECT id FROM decl_folios WHERE rfc=? AND folio=?').get(job.rfc, t.operacion);
        if (!existing) {
          db.prepare('INSERT INTO decl_folios(id,rfc,tipo,ejercicio,periodo,folio,estado,nota,creado,actualizado) VALUES (?,?,?,?,?,?,?,?,?,?)')
            .run(randomUUID(), job.rfc, t.tipo, t.ejercicio, t.periodo, t.operacion, 'visto',
              'Descubierto por el ejecutor local en la Consulta de transacciones del SAT (ficha 22513)', time, time);
          descubiertos++;
        }
      }
      resumen.descubiertos = descubiertos;
    }
    const okFinal = !fallo && !validated.error;
    const errorText = validated.error || (fallo ? 'El ejecutor informó un fallo sin detalle.' : '');
    const guardado = mirrorExecutorDiary(jobRow, attemptId, okFinal, validated, errorText, validated.errorKind || '', time);
    db.prepare('INSERT INTO sat_executor_attempts(id,jobId,executorId,started,finished,ok,error,errorKind,steps,shotId,htmlId) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(attemptId, jobRow.id, executor.id, time, time, okFinal ? 1 : 0, errorText, validated.errorKind || '',
        JSON.stringify(validated.steps), guardado.shotId || '', guardado.htmlId || '');
    db.prepare('UPDATE sat_executor_jobs SET estado=?, steps=?, error=?, errorKind=?, resumen=?, shotId=?, htmlId=?, leaseHasta=0, actualizado=? WHERE id=?')
      .run(okFinal ? 'hecho' : 'fallido', JSON.stringify(validated.steps), errorText, validated.errorKind || '',
        JSON.stringify(resumen), guardado.shotId || '', guardado.htmlId || '', time, jobRow.id);
    if (okFinal && job.kind === 'buzon-listar' && resumen.sinAbrir > 0) {
      const proxima = tribProximaTenida(job.rfc);
      queueAlert('trib-sin-abrir', 'trib:' + job.rfc + ':' + resumen.sinAbrir,
        'PacoSAT · Buzón Tributario de ' + job.rfc + ': ' + resumen.sinAbrir + ' notificación(es) sin abrir' +
          (proxima ? ' · la más antigua se tiene por notificada el ' + fechaLargaIso(proxima.tenida) : ''),
        'El ejecutor local listó el Buzón Tributario de ' + job.rfc + ' SIN abrir ninguna notificación: ' +
        resumen.encontradas + ' en la bandeja y ' + resumen.sinAbrir + ' que requieren atención sin abrir. ' +
        'Ábrelas tú en el portal oficial del SAT cuando decidas atenderlas.', time, job.rfc);
    }
    return { ok: okFinal, guardados, descubiertos, resumen, error: errorText };
  }
  function executorOverview() {
    expireExecutorLeases(now());
    const ejecutores = db.prepare('SELECT id,nombre,creado,ultimoVisto,revocado FROM sat_executors ORDER BY creado DESC').all()
      .map(row => ({ id: row.id, nombre: row.nombre, creado: row.creado, ultimoVisto: row.ultimoVisto,
        revocado: Boolean(row.revocado), enLinea: Boolean(row.ultimoVisto && now() - row.ultimoVisto < EXECUTOR_ONLINE_MS) }));
    const trabajos = db.prepare('SELECT * FROM sat_executor_jobs ORDER BY creado DESC LIMIT 100').all().map(executorJobView);
    return { protocol: SAT_EXECUTOR_PROTOCOL_VERSION, enLinea: executorOnline(), ejecutores, trabajos,
      enCola: trabajos.filter(t => t.estado === 'en-cola').length,
      enCurso: trabajos.filter(t => t.estado === 'en-curso' || t.estado === 'reclamado').length };
  }
  /* La orden que el botón y la cadencia comparten en modo remoto:
     encolar y decir la verdad — «esperando tu equipo» — sin tocar
     el portal desde el NAS y sin fingir un fallo del SAT. */
  function queueRemoteRun(rfc, kind, payload, origen = 'paco') {
    const { job, repetido } = enqueueExecutorJob({ rfc, kind, payload, origen });
    return { ok: false, waitingExecutor: true, repetido, jobId: job.id,
      error: executorOnline()
        ? 'Trabajo en cola para el ejecutor de tu equipo: en cuanto lo reclame, su resultado y su traza quedan aquí.'
        : 'Esperando tu equipo: el trabajo quedó en cola para el ejecutor local. No es un fallo del SAT — en cuanto tu equipo esté en línea, el ejecutor lo recoge.' };
  }

  async function runTributarioAttemptOnce(rfc, time, ctx = {}) {
    try {
      if (!satTribFetch) throw new Error('La consulta del Buzón Tributario no está disponible en esta instalación: el navegador interno no está configurado.');
      const result = await satTribFetch({ rfc }, {}, { onStep: ctx.onStep });
      if (ctx.token?.cancelled)
        return { ok: false, cancelled: true, error: 'Consulta cancelada por ti.' };
      const rows = Array.isArray(result?.notifications) ? result.notifications : [];
      const nuevas = tribStoreNotifications(rfc, rows, time);
      /* sinAbrir = lo que requiere atención sin abrir (1.29.0):
         lo archivado en local no cuenta como pendiente. */
      return { ok: true, encontradas: rows.length, nuevas, sinAbrir: tribOverview(rfc).sinAbrir };
    } catch (error) {
      /* La página del fallo viaja con el error (1.27.0): el
         cierre de la corrida la archiva en el diario. */
      return { ok: false, error: message(error), errorKind: error?.code || '', diag: error?.diag || null };
    }
  }
  async function runTributarioAttempt(rfc, time, origen = 'paco') {
    /* Modo remoto (1.29.0): la consulta la ejecuta el ejecutor del
       equipo de Paco; aquí solo se encola el trabajo. */
    if (remoteExecutor) return queueRemoteRun(rfc, 'buzon-listar', {}, origen);
    if (tribLive.has(rfc)) return { ok: false, yaEnCurso: true,
      error: 'Ya hay una consulta del Buzón Tributario en curso para ' + rfc + ': mírala en su pantalla (ahí está su Cancelar).' };
    const token = { cancelled: false, startedAt: time };
    tribLive.set(rfc, token);
    const runId = randomUUID();
    const steps = [];
    let attempt = 0;
    let runClosed = false;
    const failures = [];
    let diagFiles = { shotId: '', htmlId: '' };
    const closeRun = (ok, errorText = '', errorKind = '', extra = {}) => {
      if (runClosed) return;
      runClosed = true;
      try {
        /* La página del fallo queda archivada en el diario
           (1.27.0): captura y HTML como records, con su id en la
           corrida — la corrida viva del 11 nov murió sin ella.
           1.28.0: el guardado se verifica al guardar (saveRunDiag)
           y el cierre anota el inventario de la página y, si la
           hubo, la falta de guardado: nunca una referencia colgada
           en silencio. La poda es la común (fallos de 90 días con
           su página se quedan). */
        if (extra.diag && !diagFiles.shotId && !diagFiles.htmlId)
          diagFiles = saveRunDiag(runId, extra.diag);
        if (!ok && extra.diag) steps.push(...diagCierreSteps(extra.diag, diagFiles)
          .map(paso => ({ at: paso.at, intento: attempt, paso: paso.text, detalle: '' })));
        db.prepare('UPDATE trib_runs SET finished=?,ok=?,error=?,errorKind=?,steps=?,attempts=?,encontradas=?,sinAbrir=?,shotId=?,htmlId=? WHERE id=?')
          .run(now(), ok ? 1 : 0, String(errorText || ''), String(errorKind || ''),
            JSON.stringify(steps), attempt, extra.encontradas || 0, extra.sinAbrir || 0,
            diagFiles.shotId, diagFiles.htmlId, runId);
        pruneRunDiary('trib_runs', rfc, now());
      } catch { /* el diario nunca tumba la consulta */ }
    };
    const onStep = (paso, detalle) => {
      steps.push({ at: now(), intento: attempt, paso: String(paso || ''), detalle: String(detalle || '') });
      try { db.prepare('UPDATE trib_runs SET steps=?,attempts=? WHERE id=?')
        .run(JSON.stringify(steps), attempt, runId); } catch { /* ídem */ }
    };
    try {
      try { db.prepare('INSERT INTO trib_runs(id,rfc,started,steps,origen) VALUES (?,?,?,?,?)')
        .run(runId, rfc, time, '[]', origen || ''); } catch { /* ídem */ }
      writeTribProgress(rfc, { running: true,
        step: 'Consultando el Buzón Tributario: solo la lista, sin abrir ninguna notificación…', at: time });
      for (attempt = 1; attempt <= 2; attempt++) {
        const result = await runTributarioAttemptOnce(rfc, attempt === 1 ? time : now(), { token, onStep });
        if (result.ok) {
          writeTribProgress(rfc, { running: false, ok: true,
            step: 'Consulta guardada: ' + result.encontradas + ' notificación(es) en la bandeja, ' +
              result.sinAbrir + ' sin abrir', at: now() });
          closeRun(true, '', '', result);
          if (result.sinAbrir > 0) {
            /* El plazo corre aunque nadie abra (1.27.0, bloque
               D): el aviso nombra la fecha en que la más antigua
               se tiene por notificada (arts. 134-I y 135 CFF). */
            const proxima = tribProximaTenida(rfc);
            queueAlert('trib-sin-abrir', 'trib:' + rfc + ':' + result.sinAbrir,
              'PacoSAT · Buzón Tributario de ' + rfc + ': ' + result.sinAbrir + ' notificación(es) sin abrir' +
                (proxima ? ' · la más antigua se tiene por notificada el ' + fechaLargaIso(proxima.tenida) : ''),
              'La consulta del Buzón Tributario de ' + rfc + ' encontró ' + result.sinAbrir +
              ' notificación(es) sin abrir (' + result.encontradas + ' en la bandeja). PacoSAT solo las LISTÓ: ' +
              'no abrió ninguna, porque abrirla puede darla por notificada e iniciar plazos. ' +
              (proxima
                ? 'OJO: no abrirla NO congela el plazo — la notificación más antigua se tiene por notificada el ' +
                  fechaLargaIso(proxima.tenida) + ' aunque nadie la abra (tienes hasta el ' + fechaLargaIso(proxima.limite) +
                  ' para abrirla tú; sus efectos corren desde el ' + fechaLargaIso(proxima.efectos) + '). '
                : '') +
              'Ábrelas tú en el portal oficial del SAT cuando decidas atenderlas.', now(), rfc);
          } else {
            for (const aviso of db.prepare("SELECT ref FROM avisos WHERE rfc=? AND estado NOT IN ('solventado','descartado') AND datos LIKE '%\"alertaKind\":\"trib-sin-abrir\"%'").all(rfc))
              avisoSolve(aviso.ref, 'La última consulta del Buzón Tributario no encontró notificaciones sin abrir.', now());
          }
          return attempt === 2 ? { ...result, segundoIntento: true } : result;
        }
        if (result.cancelled) {
          writeTribProgress(rfc, { running: false, ok: false, step: 'Consulta cancelada por ti', at: now() });
          closeRun(false, result.error || 'Consulta cancelada por ti.', result.errorKind || '');
          return result;
        }
        failures.push({ error: result.error, errorKind: result.errorKind || '', at: now(), diag: result.diag || null });
        if (attempt === 1 && SATDOC_PORTAL_KINDS.includes(result.errorKind) && !token.cancelled) {
          const waitMs = satDocRetryWait();
          writeTribProgress(rfc, { running: true,
            step: 'El portal no respondió como se esperaba: reintento automático en ' +
              Math.max(1, Math.round(waitMs / 1000)) + ' s (puedes cancelar la espera)…', at: now() });
          const waited = await sleepCancellable(waitMs, token);
          if (!waited || token.cancelled) {
            writeTribProgress(rfc, { running: false, ok: false, step: 'Consulta cancelada por ti', at: now() });
            closeRun(false, 'Consulta cancelada por ti.', '');
            return { ok: false, cancelled: true, error: 'Consulta cancelada por ti.' };
          }
          continue;
        }
        break;
      }
      writeTribProgress(rfc, { running: false, ok: false,
        step: failures[failures.length - 1].error, at: now() });
      queueAlert('trib-fail', 'trib-fail:' + rfc + ':' + Math.floor(time / DAY),
        'PacoSAT · No se pudo consultar el Buzón Tributario de ' + rfc,
        'La consulta falló: ' + failures[failures.length - 1].error +
        ' No se abrió ninguna notificación. Gesto único: reinténtalo desde la pantalla Buzón Tributario; el diario de la consulta guarda los pasos y la página del momento del fallo.', now(), rfc);
      closeRun(false, failures[failures.length - 1].error, failures[failures.length - 1].errorKind || '',
        { diag: failures[failures.length - 1].diag || null });
      return { ok: false, error: failures[failures.length - 1].error, errorKind: failures[failures.length - 1].errorKind || '' };
    } finally {
      closeRun(false, failures[failures.length - 1]?.error || 'Consulta cancelada por ti.',
        failures[failures.length - 1]?.errorKind || '',
        { diag: failures[failures.length - 1]?.diag || null });
      tribLive.delete(rfc);
    }
  }

  function overview() {
    return {
      settings: publicSettings(),
      /* Salud predictiva del portal (1.25.0, mejora nº 8): Hoy la
         enseña sin abrir el Centro SAT. */
      portalSalud: portalSalud(),
      serverStartedAt: startedAt,
      buildModified: servedBuildModified,
      cloudRevision: cloud ? storageRevision + ':' + db.prepare('SELECT COALESCE(MAX(rowid),0) AS value FROM records').get().value : null,
      profiles: (() => { const credentialIndex = readEfirmaIndex();
        return db.prepare('SELECT * FROM profiles ORDER BY rfc').all().map(row => ({ ...row, unlocked: unlocked.has(row.rfc),
          efirmaStored: existsSync(efirmaPath(row.rfc, '.cer')),
          /* Método de acceso al SAT (1.12.0): «efirma» o «ciec», y si
             la contraseña CIEC está guardada — el valor jamás sale. */
          accessMethod: credentialIndex[row.rfc]?.access === 'ciec' ? 'ciec' : 'efirma',
          ciecStored: Boolean(credentialIndex[row.rfc]?.ciec),
          lastSatSuccess: db.prepare("SELECT MAX(created) AS last FROM jobs WHERE rfc=? AND status='finished'").get(row.rfc)?.last || null })); })(),
      jobs: db.prepare('SELECT id,rfc,direction,kind,periodStart,periodEnd,startAt,endAt,status,due,created,error,checks,note FROM jobs ORDER BY id DESC LIMIT 35').all()
        .map(row => { const info = criteriaInfo(criteriaFromJob(row));
          return { ...row, criteriaState: info.state, criteriaCount: info.count }; }),
      rest: { until: restUntil(), active: resting(now()) },
      silenceDays: Number(getSetting('silenceDays') || 0),
      metadata: (() => {
        const total = db.prepare('SELECT COUNT(*) AS n FROM metadata_records').get()?.n || 0;
        const missing = db.prepare(`SELECT m.uuid,m.emitter,m.receiver,m.issuedAt,m.total,m.status FROM metadata_records m
          WHERE NOT EXISTS (SELECT 1 FROM discovered d WHERE d.rfc=m.rfc AND d.uuid=m.uuid) ORDER BY m.issuedAt DESC LIMIT 100`).all();
        const lastSeen = db.prepare('SELECT MAX(seenAt) AS last FROM metadata_records').get()?.last || null;
        return { records: total, missing, lastSeen };
      })(),
      /* Actividad de descargas REAL (1.22.0, pieza 2): la tarjeta
         de Hoy leía satData.profiles de la sesión — vacío al
         entrar — y decía «Aún sin descargas» la mañana después
         de la mensual y de 7 recuperaciones. Esto sale de los
         registros: trabajos terminados y corridas mensuales. */
      downloads: (() => {
        const finished = db.prepare("SELECT COUNT(*) AS n, MAX(created) AS last FROM jobs WHERE status='finished'").get();
        const failed = db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status IN ('failed','expired','rejected','exhausted')").get().n;
        const pending = db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status='pending'").get().n;
        const runs = Object.values(monthlyState().runs || {}).filter(run => run.finishedAt)
          .sort((a, b) => b.finishedAt - a.finishedAt);
        const lastRun = runs[0] || null;
        return { lastAt: Math.max(finished.last || 0, lastRun?.finishedAt || 0) || null,
          finishedJobs: finished.n, failedJobs: failed, pendingJobs: pending,
          lastRun: lastRun ? { month: lastRun.month, status: lastRun.status, at: lastRun.finishedAt } : null };
      })(),
      watchSummary: monitorGlobalSummary(),
      expediente: expedienteCounts(),
      /* B3 (1.22.0): la fecha REAL de la última copia buena fuera
         del NAS, para la línea de Hoy. */
      backup: { last: Number(getState('backup:last') || 0),
        secondaryOk: Number(getState('backup:secondaryOk') || 0),
        secondaryError: getState('backup:secondaryError') || '' },
      inbox: db.prepare('SELECT id,rfc,newCount,review FROM packages WHERE archive IS NOT NULL ORDER BY id LIMIT 50').all(),
      mail: { enabled: Boolean(mail), recipient: mail?.recipient || '', alerts: mailAlertsOn(), error: db.prepare("SELECT error FROM notices WHERE sent IS NULL AND error<>'' ORDER BY id DESC LIMIT 1").get()?.error || '' },
      health: systemHealth(now()),
      watchFolder: { enabled: Boolean(inbox.dir), lastScan: inboxStatus.lastScan, lastProcessed: inboxStatus.lastProcessed || null, imported: inboxStatus.imported,
        failed: inboxStatus.failed, incidents: inboxStatus.incidents, waiting: inboxStatus.waiting,
        subfolders: true, error: inboxStatus.error || getState('watch:error') },
      scheduledBackup: { enabled: Boolean(backupJob), frequency: backupJob?.frequency || '',
        last: Number(getState('backup:last')) || null, next: Number(getState('backup:next')) || null, error: getState('backup:error'),
        secondary: Boolean(backupJob?.secondaryDir), secondaryError: getState('backup:secondaryError'),
        secondaryLastOk: Number(getState('backup:secondaryOk') || 0),
        secondaryStale: Boolean(backupJob?.secondaryDir) &&
          now() - (Number(getState('backup:secondaryOk') || 0) || startedAt) > 7 * DAY,
        verify: (() => { try { return JSON.parse(getState('backup:verify') || 'null'); } catch { return null; } })() },
      coverage: computeCoverage(),
      criteriaBook: criteriaBook(),
      avisos: (() => { try {
        const row = db.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN estado='por-confirmar' THEN 1 ELSE 0 END) AS porConfirmar FROM avisos WHERE estado NOT IN ('solventado','descartado')").get();
        return { total: row?.total || 0, porConfirmar: row?.porConfirmar || 0 };
      } catch { return { total: 0, porConfirmar: 0 }; } })(),
      /* Buzón sin leer por RFC (1.23.0, frente B): el contador que
         Hoy enseña; sale de buzonItems con su tope, igual que la
         bandeja. */
      buzonUnread: (() => { try {
        const out = {};
        for (const profile of db.prepare('SELECT rfc FROM profiles ORDER BY rfc').all())
          out[profile.rfc] = buzonItems(profile.rfc).filter(item => !item.read).length;
        return out;
      } catch { return {}; } })(),
      /* Salud del respaldo (1.23.0, frente C): silencio = todo bien;
         Hoy solo avisa si está activado y lleva más de 48 h sin un
         respaldo correcto, o si el último intento dejó error. */
      /* Buzón Tributario por RFC (1.24.0, punto 1): totales y sin
         abrir de lo ya listado; Hoy lo enseña con su «Ver». */
      tributario: tribSummaryPorRfc(),
      /* Altas preparadas (1.24.0, punto 7): RFC en «faltan
         credenciales», para que el directorio las marque. */
      pendingProfiles: pendingProfileRfcs(),
      /* Login propio de administrador (1.24.0, decisión 2A): solo
         su estado — configurado o pendiente de fijar —; la
         contraseña jamás viaja en ninguna respuesta. */
      adminLogin: { configurado: Boolean(adminAuth) },
      backupHealth: (() => { const lastOk = Number(getState('backup:last') || 0) || null;
        const t = now();
        return { enabled: Boolean(backupJob), lastOk,
          daysSince: lastOk ? Math.floor((t - lastOk) / 86400000) : null,
          stale: Boolean(backupJob) && lastOk > 0 && t - lastOk > 48 * 3600 * 1000,
          failed: Boolean(getState('backup:error')), error: getState('backup:error') || '' }; })()
    };
  }

  async function inspectPackage(job, id, archive, Parser) {
    if (packageLookup.get(job.id, id)) return;
    /* Foto de lo ya descubierto ANTES de abrir el paquete: la
       cuenta de novedades de siempre (remember.changes) — y con
       ella el DETALLE de lo nuevo para el correo (1.22.0) — sale
       de comparar contra esta foto, no de otra tabla. */
    const before = new Set(db.prepare('SELECT uuid FROM discovered WHERE rfc=?').all(job.rfc).map(row => row.uuid));
    const valid = [];
    const issues = [];
    let review = 0;
    try {
      for await (const entry of zipXml(archive)) {
        try {
          const row = parseXml(entry.xml, Parser);
          /* Desglose fiscal (1.6.16): se persiste junto al CFDI; si el
             parseo completo falla, el registro ligero ya vale. */
          try { row.fiscal = fiscalSummary(parseCfdiFull(entry.xml, Parser)); } catch { /* sin desglose */ }
          const validForDirection = job.direction === 'received' ? row.to.rfc === job.rfc : row.from.rfc === job.rfc;
          need(validForDirection, 'CFDI de otro RFC.');
          valid.push({ row, raw: cloud ? entry.xml : null });
        } catch (error) { review++; if (issues.length < 20) issues.push({ name: entry.name, reason: message(error) }); }
      }
    } catch (error) { review++; if (issues.length < 20) issues.push({ name: id, reason: message(error) }); }
    tx(db, () => {
      if (packageLookup.get(job.id, id)) return;
      let count = 0;
      for (const { row, raw } of valid) {
        const discovered = Number(remember.run(job.rfc, row.id).changes);
        if (cloud) {
          putFile('xml:' + row.id, raw, 'application/xml');
          row.origin = 'descarga';
          if (!putMetadata('invoices', row).changes) continue;
          monitor.register({ id: row.id, emitter: row.from.rfc, receiver: row.to.rfc, total: row.total,
            seal: /^[A-Za-z0-9+/=]{8}$/.test(row.seal) ? row.seal : '' });
        }
        count += discovered;
      }
      if (cloud) putMetadata('activity', { id: 'sat:' + job.id + ':' + id, name: ('SAT · ' + job.rfc).slice(0, 180),
        date: new Date(now()).toISOString(), added: count, duplicates: valid.length - count, review, issues });
      if (count && job.direction === 'received') setState('news:last:' + job.rfc, String(now()));
      /* El paquete queda registrado SIEMPRE (la bandeja de Hoy y
         la cobertura salen de esta tabla): esta fila existía antes
         de la 1.22.0 y su inserción se perdió en la primera
         redacción de la pieza 1 — restaurada tal cual. */
      const record = insertPackage.run(job.id, id, job.rfc, !cloud && (count || review) ? archive : null, count, review);
      void record;
      /* Aviso de novedades (1.22.0): lo que entra nuevo deja su
         detalle fila a fila en el aviso de SU OPERACIÓN — el
         género sale del origen del criterio que trajo el job
         (mensual / recuperación / normal) — y el despachador lo
         manda en UN correo por operación, con cada comprobante
         nombrado. Antes: un aviso por paquete con solo la cuenta. */
      /* Sin puerta «cloud»: el aviso por paquete al que esto
         sustituye también salía en modo local (la instalación de
         escritorio manda su correo igual). */
      if (valid.some(({ row }) => !before.has(row.id))) {
        const origin = jobOrigin(job);
        const periodo = job.periodStart && job.periodEnd ? (job.periodStart === job.periodEnd ? job.periodStart :
          job.periodStart.slice(0, 7) === job.periodEnd.slice(0, 7) && job.periodStart.endsWith('-01') ?
            job.periodStart.slice(0, 7) : job.periodStart + ' a ' + job.periodEnd) : '';
        const kind = origin === 'monthly' ? 'mensual' : origin === 'recovery' ? 'recuperacion' : 'sat';
        const label = kind === 'mensual' ? (periodo.length === 7 ? monthLabel(periodo) : 'descarga automática mensual') :
          kind === 'recuperacion' ? (periodo.length === 7 ? monthLabel(periodo) : 'recuperación del ' + periodo) :
          (periodo.length === 7 ? monthLabel(periodo) : periodo);
        const watchStates = new Map(db.prepare('SELECT id,result FROM cfdi_watch').all()
          .map(row => { try { return [row.id, JSON.parse(row.result || '{}').state || '']; } catch { return [row.id, '']; } }));
        const detail = valid.filter(({ row }) => !before.has(row.id))
          .map(({ row }) => newsItemOf(row, watchStates));
        if (detail.length) queueNews({ kind, opkey: newsOpKey(kind, job.rfc, job.direction, periodo, job.periodStart, job.periodEnd),
          rfc: job.rfc, direction: job.direction, label }, detail, now());
      }
    });
  }

  /* Solicitudes Metadata (1.6.10): el paquete trae un .txt con una fila
     por CFDI (columnas separadas por «|», con cabecera). Se guardan los
     registros ligeros y se reconcilian contra lo descargado: lo que el
     SAT conoce y PacoSAT no tiene en XML queda listado como faltante en
     la cobertura, y el estado del registro queda como estado inicial
     de los CFDI ya importados. Nada de esto envía solicitudes nuevas. */
  const METADATA_COLUMNS = ['uuid', 'rfcemisor', 'nombreemisor', 'rfcreceptor', 'nombrereceptor', 'fechaemision',
    'fechacertificacion', 'paccertifico', 'monto', 'efectocomprobante', 'estatus', 'fechacancelacion'];
  function parseMetadataText(text) {
    const lines = String(text || '').split(/\r?\n/).filter(line => line.trim());
    if (!lines.length) return [];
    let header = null, start = 0;
    const first = lines[0].split('|').map(value => value.trim().toLowerCase().replace(/[^a-z]/g, ''));
    if (first.includes('uuid')) { header = first; start = 1; }
    const records = [];
    for (let i = start; i < lines.length; i++) {
      const cells = lines[i].split('|').map(value => value.trim());
      const get = name => {
        const index = header ? header.indexOf(name) : METADATA_COLUMNS.indexOf(name);
        return index >= 0 ? (cells[index] || '') : '';
      };
      const uuid = get('uuid').toUpperCase();
      if (!/^[0-9A-F-]{36}$/.test(uuid)) continue;
      records.push({ uuid, emitter: get('rfcemisor').toUpperCase(), receiver: get('rfcreceptor').toUpperCase(),
        issuedAt: get('fechaemision'), total: get('monto'), status: get('estatus'), cancelDate: get('fechacancelacion') });
    }
    return records;
  }
  function patchInitialState(uuid, status) {
    if (!cloud) return;
    const row = db.prepare("SELECT value FROM records WHERE store='invoices' AND id=?").get(uuid);
    if (!row?.value) return;
    try {
      const invoice = JSON.parse(row.value);
      const label = status === '0' ? 'Cancelado' : status === '1' ? 'Vigente' : '';
      if (!label || invoice.initialState === label) return;
      invoice.initialState = label;
      db.prepare("UPDATE records SET value=? WHERE store='invoices' AND id=?").run(JSON.stringify(invoice), uuid);
      storageRevision++;
    } catch { /* fila ilegible: el estado inicial es informativo, no crítico */ }
  }
  async function inspectMetadataPackage(job, id, archive) {
    if (packageLookup.get(job.id, id)) return;
    let found = [], review = 0;
    try {
      for await (const entry of zipText(archive)) found = found.concat(parseMetadataText(entry.text));
    } catch { review++; }
    const time = now();
    tx(db, () => {
      if (packageLookup.get(job.id, id)) return;
      let count = 0;
      const upsert = db.prepare(`INSERT INTO metadata_records(uuid,rfc,direction,emitter,receiver,issuedAt,total,status,cancelDate,seenAt)
        VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(uuid) DO UPDATE SET status=excluded.status,
        cancelDate=excluded.cancelDate, seenAt=excluded.seenAt`);
      for (const record of found) {
        const known = db.prepare('SELECT 1 FROM metadata_records WHERE uuid=?').get(record.uuid);
        upsert.run(record.uuid, job.rfc, job.direction, record.emitter, record.receiver, record.issuedAt,
          record.total, record.status, record.cancelDate, time);
        if (!known) count++;
        patchInitialState(record.uuid, record.status);
      }
      if (cloud) putMetadata('activity', { id: 'satmeta:' + job.id + ':' + id, name: ('SAT Metadatos · ' + job.rfc).slice(0, 180),
        date: new Date(time).toISOString(), added: count, duplicates: found.length - count, review,
        issues: [], event: 'Paquete de metadatos: ' + found.length + ' registros del SAT para ' + job.rfc +
          ' (' + (job.direction === 'received' ? 'recibidos' : 'emitidos') + ', ' + job.periodStart + ' a ' + job.periodEnd + ').' });
      insertPackage.run(job.id, id, job.rfc, null, count, review);
    });
  }

  /* Respaldo completo (1.6.4). El .faro sigue siendo el formato v2 de
     siempre (las tiendas del expediente, con los archivos en base64) y
     añade una sección `operations` versionada con el ESTADO OPERATIVO:
     perfiles, cola de descargas (jobs, con su contador de verificaciones),
     libro de criterios 5002 y criterios agotados, notificaciones y alertas
     TODAVÍA PENDIENTES, contadores de fallo persistente, estado de
     automatización, UUID ya descubiertos y el estado de la vigilancia
     (consultas CFDI programadas, 69-B y avisos de cancelación pendientes).
     Diseño: volcado versionado DENTRO del mismo .faro cifrado (no una
     copia binaria de SQLite), leído en una sola transacción de lectura
     para que expediente y estado sean una foto coherente del mismo
     instante. Los respaldos viejos (sin `operations`) se restauran como
     antes y dejan el estado intacto; una restauración nueva ignora la
     sección si su versión no conoce. Nunca viaja la e.firma (vive solo en
     memoria y en pacosat-secrets, fuera del respaldo por diseño) ni las
     credenciales SMTP (se configuran en el servidor, no se respaldan).
     Exclusiones deliberadas: los ZIP de paquetes sin importar (columna
     `packages.archive`) NO se copian — sus XML forman parte del expediente
     al importarse y un paquete pendiente se puede volver a descargar con
     su IdSolicitud; y la lista 69-B (`efos_rfc`) tampoco, porque se
     descarga de nuevo del SAT. El límite de 100 MB del formato SÍ existe
     (este snapshot, la subida por /api/storage y el respaldo del
     navegador) y se aplica al CONJUNTO: bytes de archivos + tamaño del
     estado operativo serializado. Para expedientes que lo superen, el
     diseño previsto es partir el respaldo en un .faro por RFC y año
     (los registros ya llevan RFC y fecha; el estado operativo, pequeño,
     iría completo en cada parte) — queda documentado, no implementado. */
  const OPERATIONS_TABLES = [
    ['profiles', ['rfc', 'minutes', 'days', 'direction', 'nextRun', 'error', 'certExpires', 'paused', 'pauseUntil']],
    ['jobs', ['id', 'rfc', 'direction', 'kind', 'periodStart', 'periodEnd', 'startAt', 'endAt', 'requestId', 'status', 'imported', 'due', 'created', 'error', 'checks']],
    ['packages', ['id', 'job', 'remoteId', 'rfc', 'newCount', 'review']],
    ['notices', ['id', 'package', 'rfc', 'recipient', 'count', 'due', 'sent', 'error']],
    ['criteria', ['id', 'key', 'rfc', 'direction', 'type', 'emitter', 'receiver', 'startAt', 'endAt', 'requestId', 'origin', 'sentAt']],
    ['criteria_exhausted', ['key', 'learnedAt', 'detail']],
    ['criteria_rescued', ['key', 'rescuedAt', 'count', 'detail']],
    ['alerts', ['id', 'kind', 'ref', 'subject', 'body', 'due', 'sent', 'error']],
    ['alert_state', ['key', 'failures', 'alerted']],
    ['automation_state', ['key', 'value']],
    ['settings', ['key', 'value']],
    ['discovered', ['rfc', 'uuid']],
    ['cfdi_watch', ['id', 'emitter', 'receiver', 'total', 'seal', 'next', 'checked', 'result', 'error']],
    ['cancellation_alert', ['id', 'due', 'sent']],
    ['efos_alert', ['key', 'rfc', 'due', 'sent']],
    ['efos_meta', ['id', 'fetched', 'next', 'error']],
    ['counterparts', ['rfc', 'name', 'kind', 'note', 'source', 'updated', 'payDay', 'payTerms']],
    ['blacklist_meta', ['listId', 'fetched', 'next', 'count', 'declared', 'error']],
    ['list_events', ['id', 'at', 'listId', 'rfc', 'change', 'detail']],
    ['sat_documents', ['id', 'rfc', 'kind', 'issuedAt', 'fileId', 'source', 'created', 'error']],
    ['sat_doc_runs', ['id', 'rfc', 'kind', 'started', 'finished', 'ok', 'error', 'errorKind', 'steps', 'shotId', 'htmlId']],
    ['ciec_runs', ['id', 'rfc', 'started', 'finished', 'ok', 'error', 'errorKind', 'steps', 'shotId', 'htmlId', 'found', 'downloaded', 'added', 'duplicates']],
    ['package_attempts', ['job', 'remoteId', 'attempts']],
    ['mail_sends', ['id', 'at', 'recipients', 'subject', 'kind', 'ok', 'error', 'rfc']],
    /* Bancos y Avisos en el respaldo (1.9.0, punto 2 del plan): hasta
       la 1.8.0 el respaldo NO los incluía — una restauración perdía
       cuentas, estados, movimientos, conciliaciones y el historial
       de avisos solventados. Desde la 1.9.0 viajan completos. */
    ['bank_accounts', ['id', 'bank', 'name', 'last4', 'kind', 'created', 'rfc']],
    ['bank_statements', ['id', 'accountId', 'month', 'fileId', 'openingCents', 'closingCents', 'creditsCents', 'chargesCents', 'movements', 'state', 'detected', 'created']],
    ['bank_movements', ['id', 'statementId', 'date', 'concept', 'amountCents', 'balanceCents']],
    ['bank_matches', ['id', 'movementId', 'invoices', 'mode', 'amountCents', 'why', 'estado', 'created', 'undone']],
    ['bank_movement_marks', ['movementId', 'estado', 'nota', 'at']],
    ['avisos', ['id', 'ref', 'kind', 'clase', 'estado', 'severidad', 'titulo', 'detalle', 'contraparte', 'nombre', 'importe', 'enlace', 'datos', 'baseline', 'creado', 'actualizado', 'resuelto', 'resolucion', 'correo', 'rfc', 'responsable', 'vence', 'accion']],
    ['avisos_acciones', ['id', 'aviso', 'at', 'accion', 'nota']],
    ['manual_payments', ['uuid', 'at', 'nota', 'importe']],
    ['declaraciones', ['id', 'rfc', 'tipo', 'clase', 'ejercicio', 'periodo', 'fechaPresentacion', 'operacion', 'fileId', 'source', 'created', 'error', 'errorKind']],
    ['pay_beneficiaries', ['id', 'rfc', 'nombre', 'payload', 'created', 'updated']],
    ['pay_preparations', ['id', 'rfc', 'month', 'total', 'operaciones', 'payload', 'created']]
  ];
  const tableExists = name => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  function dumpOperations() {
    const dump = { version: 1, packagesArchiveOmitted: true, efosListOmitted: true, listsEntriesOmitted: true };
    for (const [name] of OPERATIONS_TABLES) {
      if (!tableExists(name)) { dump[name] = []; continue; }
      /* Solo lo pendiente de avisos: lo ya enviado es historia, no estado. */
      const pendingOnly = name === 'notices' || name === 'alerts' || name === 'cancellation_alert' || name === 'efos_alert';
      dump[name] = db.prepare('SELECT * FROM ' + name + (pendingOnly ? ' WHERE sent IS NULL' : '')).all();
    }
    return dump;
  }
  function restoreOperations(operations) {
    need(operations && typeof operations === 'object' && !Array.isArray(operations), 'La sección de estado operativo no es válida.');
    need(operations.version === 1, 'La versión del estado operativo no es compatible con esta instalación.');
    const present = OPERATIONS_TABLES.filter(([name]) => operations[name] !== undefined);
    for (const [name] of present) {
      need(Array.isArray(operations[name]) && operations[name].length <= 100000, 'El estado operativo tiene un tamaño no válido (' + name + ').');
      for (const row of operations[name]) need(row && typeof row === 'object' && !Array.isArray(row), 'El estado operativo contiene filas no válidas (' + name + ').');
    }
    tx(db, () => {
      for (const [name] of [...present].reverse()) if (tableExists(name)) db.prepare('DELETE FROM ' + name).run();
      for (const [name, columns] of present) {
        if (!tableExists(name)) continue;
        const insert = db.prepare('INSERT INTO ' + name + '(' + columns.join(',') + ') VALUES (' + columns.map(() => '?').join(',') + ')');
        /* Columnas con NOT NULL añadidas tras 1.6.4 (kind, paused,
           pauseUntil en 1.6.10): un respaldo viejo no las trae y su
           valor por defecto es el de la propia columna. */
        const defaults = { kind: 'cfdi', paused: 0, pauseUntil: 0, rfc: '' };
        for (const row of operations[name]) insert.run(...columns.map(column =>
          row[column] === undefined || row[column] === null ? (defaults[column] ?? null) : row[column]));
      }
    });
    /* Las sesiones de e.firma viven solo en memoria y NO se restauran:
       los perfiles restaurados quedan bloqueados hasta desbloquearlos. */
    return Object.fromEntries(present.map(([name]) => [name, operations[name].length]));
  }
  function validateBackupData(data) {
    need(data && typeof data === 'object' && !Array.isArray(data), 'El respaldo no contiene un objeto válido.');
    need(data.version === 2, 'La versión del respaldo no es compatible.');
    let fileBytes = 0, invoices = 0, documents = 0;
    for (const store of stores) {
      need(Array.isArray(data[store]), 'El respaldo está incompleto: falta la tienda «' + store + '».');
      if (store === 'files') for (const file of data[store]) {
        need(file && typeof file.content === 'string', 'Un archivo del respaldo no es válido.');
        fileBytes += Buffer.from(file.content, 'base64').length;
      }
      if (store === 'invoices') invoices = data[store].length;
      if (store === 'documents') documents = data[store].length;
    }
    let operations = null;
    if (data.operations !== undefined) {
      need(data.operations && data.operations.version === 1, 'La versión del estado operativo del respaldo no es compatible.');
      operations = { jobs: (data.operations.jobs || []).length, criteria: (data.operations.criteria || []).length,
        exhausted: (data.operations.criteria_exhausted || []).length,
        pendingAlerts: (data.operations.alerts || []).length + (data.operations.notices || []).length };
    }
    return { fileBytes, invoices, documents, operations };
  }
  function latestBackupFile(dir) {
    try {
      const names = readdirSync(dir).filter(name => /^PacoSAT-\d{4}-\d{2}-\d{2}(-p\d+de\d+)?\.faro$/.test(name)).sort();
      return names.length ? join(dir, names[names.length - 1]) : '';
    } catch { return ''; }
  }
  /* El conjunto de respaldo más reciente de un destino: todas las
     partes del mismo día (una sola si la foto cupo entera). */
  function latestBackupSet(dir) {
    try {
      const names = readdirSync(dir).filter(name => /^PacoSAT-\d{4}-\d{2}-\d{2}(-p\d+de\d+)?\.faro$/.test(name)).sort();
      if (!names.length) return [];
      const stamp = names[names.length - 1].slice(8, 18);
      return names.filter(name => name.slice(8, 18) === stamp).map(name => join(dir, name));
    } catch { return []; }
  }
  /* Prueba de restauración: descifra el respaldo más reciente de cada
     destino con la contraseña configurada y valida estructura y conteos
     SIN tocar la base activa. Queda registrada en la bitácora y en el
     estado para verla en Respaldos; también corre sola tras cada
     respaldo programado, contra el archivo recién escrito. */
  function verifyLatestBackup(time, source) {
    need(backupJob, 'El respaldo programado no está configurado.');
    const destinations = [['principal', backupJob.dir]];
    if (backupJob.secondaryDir) destinations.push(['secundario', backupJob.secondaryDir]);
    const results = destinations.map(([label, dir]) => {
      const set = latestBackupSet(dir);
      if (!set.length) return { label, ok: false, detail: 'No hay ningún respaldo en este destino.' };
      try {
        /* Conjunto partido (B1): se validan TODAS las partes y los
           conteos se suman; un conjunto cojo no pasa la prueba. */
        let invoices = 0, documents = 0, operations = null;
        for (const file of set) {
          const info = validateBackupData(decryptBackupBuffer(readFileSync(file), backupJob.password));
          invoices += info.invoices; documents += info.documents;
          if (info.operations) operations = info.operations;
        }
        return { label, ok: true, detail: 'Íntegro · ' + invoices + ' CFDI · ' + documents + ' documentos' +
          (set.length > 1 ? ' · conjunto partido en ' + set.length + ' archivos' : '') +
          (operations ? ' · estado operativo: ' + operations.jobs + ' solicitudes, ' + operations.criteria +
            ' criterios (' + operations.exhausted + ' agotados), ' + operations.pendingAlerts + ' avisos pendientes' : ' · sin estado operativo (respaldo anterior a 1.6.4)') };
      } catch (error) { return { label, ok: false, detail: message(error) }; }
    });
    const ok = results.every(result => result.ok);
    setState('backup:verify', JSON.stringify({ at: time, ok, source, results }));
    putMetadata('activity', { id: 'backupverify:' + time, name: 'Prueba de restauración',
      date: new Date(time).toISOString(), added: 0, duplicates: 0, review: ok ? 0 : 1,
      issues: results.filter(result => !result.ok).map(result => ({ name: 'Destino ' + result.label, reason: result.detail })),
      event: 'Prueba de restauración (' + source + '): ' + results.map(result => result.label + ' → ' + result.detail).join(' · ') });
    storageRevision++;
    return { ok, results };
  }

  /* Ensayo de restauración COMPLETO (1.24.0, punto 6): la prueba
     de siempre (verifyLatestBackup) descifra la foto y valida su
     estructura; este ensayo la RESUCITA — vuelca el conjunto
     entero en una base SQLite aislada y desechable, la cierra, la
     REABRE desde el disco, pasa su control de integridad y cuenta
     lo que contiene. La base viva jamás se toca: el scratch nace
     en el temporal del sistema y se borra al terminar, salga el
     ensayo bien o mal. */
  function restoreTestLatest(time) {
    need(backupJob, 'El respaldo programado no está configurado: falta la contraseña en la configuración del servidor. Sin respaldo configurado no hay copia que probar.');
    const set = latestBackupSet(backupJob.dir);
    if (!set.length) return { ok: false, hayConjunto: false,
      detail: 'Todavía no hay ningún conjunto de respaldo en la carpeta: crea primero una copia (con «Crear copia ahora» o la automática) y vuelve a probar.' };
    let merged;
    try {
      merged = { version: 2, people: [], invoices: [], documents: [], files: [], activity: [], operations: null };
      for (const file of set) {
        const part = decryptBackupBuffer(readFileSync(file), backupJob.password);
        validateBackupData(part);
        for (const store of stores) merged[store].push(...part[store]);
        if (part.operations) merged.operations = part.operations;
      }
    } catch (error) { return { ok: false, hayConjunto: true, detail: 'El conjunto no se pudo descifrar o está incompleto: ' + message(error) }; }
    const scratchDir = mkdtempSync(join(tmpdir(), 'pacosat-restore-test-'));
    try {
      const scratchFile = join(scratchDir, 'resucitada.sqlite');
      const counts = {};
      let integridad = '';
      const scratch = new DatabaseSync(scratchFile);
      try {
        scratch.exec("CREATE TABLE records(store TEXT NOT NULL, id TEXT NOT NULL, value TEXT, data BLOB, PRIMARY KEY(store,id))");
        const insert = scratch.prepare('INSERT INTO records(store,id,value,data) VALUES (?,?,?,?)');
        for (const store of stores) merged[store].forEach((row, index) => {
          if (store === 'files') insert.run(store, String(row.id || index), '', Buffer.from(row.content || '', 'base64'));
          else insert.run(store, String(row.id || index), JSON.stringify(row), null);
        });
        for (const store of stores) counts[store] = scratch.prepare('SELECT COUNT(*) AS n FROM records WHERE store=?').get(store).n;
        integridad = String(scratch.prepare('PRAGMA integrity_check').get()?.integrity_check || '');
      } finally { scratch.close(); }
      /* Reapertura desde el disco, como haría una restauración
         de verdad: si la base resucitada no se deja leer, el
         ensayo no pasa aunque el volcado hubiera ido bien. */
      const reopened = new DatabaseSync(scratchFile, { readOnly: true });
      let reCounts = 0;
      try { reCounts = reopened.prepare('SELECT COUNT(*) AS n FROM records').get().n; } finally { reopened.close(); }
      const registros = Object.values(counts).reduce((a, b) => a + b, 0);
      const vigilados = Array.isArray(merged.operations?.cfdi_watch) ? merged.operations.cfdi_watch.length : null;
      const ok = integridad === 'ok' && reCounts === registros;
      const detail = ok
        ? 'La copia resucita: ' + registros + ' registros restaurados en una base aislada (' +
          counts.invoices + ' CFDI, ' + counts.documents + ' documentos, ' + counts.people + ' personas' +
          (vigilados !== null ? ', ' + vigilados + ' comprobantes en vigilancia' : '') +
          '), integridad íntegra y reapertura correcta. La base viva no se tocó.'
        : 'La copia se descifró, pero la base resucitada no pasó la comprobación (integridad: ' +
          (integridad || 'sin lectura') + ').';
      setState('backup:restore-test', JSON.stringify({ at: time, ok, detail }));
      putMetadata('activity', { id: 'restoretest:' + time, name: 'Ensayo de restauración',
        date: new Date(time).toISOString(), added: 0, duplicates: 0, review: ok ? 0 : 1,
        issues: ok ? [] : [{ name: 'Ensayo de restauración', reason: detail }],
        event: 'Ensayo de restauración completo: ' + detail });
      storageRevision++;
      return { ok, hayConjunto: true, registros, cfdi: counts.invoices, documentos: counts.documents,
        personas: counts.people, vigilados, partes: set.length, detail };
    } finally { rmSync(scratchDir, { recursive: true, force: true }); }
  }

  /* Barrido de arranque (H-5.1, pasada de seguridad de la
     1.24.0): si el proceso muere a mitad de un ensayo, su
     scratch pacosat-restore-test-* queda en el temporal CON EL
     EXPEDIENTE DESCIFRADO — el finally no corre cuando el
     proceso muere. Al arrancar se borran esos huérfanos; los
     tocados hace menos de 5 minutos se respetan por si otro
     proceso de la misma máquina estuviera ensayando ahora. */
  function sweepOrphanRestoreTests() {
    try {
      const base = tmpdir(), corte = Date.now() - 5 * 60 * 1000;
      for (const name of readdirSync(base)) {
        if (!name.startsWith('pacosat-restore-test-')) continue;
        try {
          if (statSync(join(base, name)).mtimeMs < corte)
            rmSync(join(base, name), { recursive: true, force: true });
        } catch { /* un nombre que se resiste no impide arrancar */ }
      }
    } catch { /* el barrido nunca impide arrancar */ }
  }

  function snapshotFromRecords() {
    const data = { version: 2 };
    /* Mantenimiento del WAL (1.27.0, bloque C): antes de la foto
       se vuelca el diario WAL sobre el fichero principal y se
       trunca — en producción el WAL llegó a 34,8 MB junto a una
       base de 88,3 MB sin que nadie lo recogiera. Guardado: si
       el checkpoint no puede correr, la foto sigue con la
       lectura transaccional de siempre. */
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* la foto no depende del checkpoint */ }
    /* Una sola transacción de lectura: expediente y estado operativo son
       la misma foto, sin cambios a mitad de camino. */
    db.exec('BEGIN');
    try {
      for (const store of stores) {
        const rows = db.prepare('SELECT id,value,data FROM records WHERE store=? ORDER BY id').all(store);
        if (store === 'files') {
          data[store] = rows.map(row => ({ id: row.id, content: Buffer.from(row.data || []).toString('base64') }));
        } else data[store] = rows.map(row => JSON.parse(row.value));
      }
      data.operations = dumpOperations();
    } finally { db.exec('COMMIT'); }
    return data;
  }
  /* ===== Respaldo partido por RFC/año (1.22.0, B1): la foto única
     moría al cruzar el techo de 100 MB (need() en snapshot). Ahora,
     si la foto completa no cabe, se parte como el propio código
     preveía: una parte BASE (personas, documentos, actividad,
     estado operativo y los archivos que no cuelgan de facturas) y
     una parte por cada grupo RFC+ejercicio de facturas con SUS
     archivos — las tiendas quedan DISJUNTAS entre partes, cada
     parte es un respaldo v2 estructuralmente válido y la base
     lleva el manifiesto del conjunto. ===== */
  function backupSets(data, stamp) {
    const size = value => Buffer.byteLength(JSON.stringify(value));
    if (size(data) <= backupCeilingBytes) return [{ suffix: '', data }];
    const profileRfcs = new Set(db.prepare('SELECT rfc FROM profiles').all().map(row => row.rfc));
    const ownerOf = invoice => profileRfcs.has(invoice?.from?.rfc) ? invoice.from.rfc
      : profileRfcs.has(invoice?.to?.rfc) ? invoice.to.rfc : (invoice?.from?.rfc || invoice?.to?.rfc || 'SIN-RFC');
    const groups = new Map();
    for (const invoice of data.invoices || []) {
      const key = ownerOf(invoice) + '|' + String(invoice?.date || '').slice(0, 4);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(invoice);
    }
    const fileById = new Map((data.files || []).map(file => [file.id, file]));
    const usedFiles = new Set();
    const slices = [];
    for (const [key, invoices] of [...groups.entries()].sort()) {
      const files = [];
      for (const invoice of invoices) {
        for (const ref of ['xml:' + invoice.id, 'pdf:' + invoice.id]) {
          const file = fileById.get(ref);
          if (file && !usedFiles.has(file.id)) { usedFiles.add(file.id); files.push(file); }
        }
      }
      slices.push({ scope: key.replace('|', ' · '), data: { version: 2,
        people: [], invoices, documents: [], files, activity: [] } });
    }
    /* Empaquetado voraz: grupos vecinos comparten parte mientras
       quepan bajo el techo; un grupo que solo ya lo supera viaja
       solo (su XML manda, no se puede partir un comprobante). */
    const packed = [];
    for (const slice of slices) {
      const last = packed[packed.length - 1];
      if (last && size({ ...last.data, invoices: [...last.data.invoices, ...slice.data.invoices],
        files: [...last.data.files, ...slice.data.files] }) <= backupCeilingBytes) {
        last.data.invoices.push(...slice.data.invoices);
        last.data.files.push(...slice.data.files);
        last.scope += ' + ' + slice.scope;
      } else packed.push(slice);
    }
    const base = { version: 2, people: data.people || [], invoices: [], documents: data.documents || [],
      files: (data.files || []).filter(file => !usedFiles.has(file.id)), activity: data.activity || [],
      operations: data.operations };
    const of = packed.length + 1;
    base.part = { set: stamp, index: 0, of, scope: 'base' };
    base.manifest = { set: stamp, parts: [{ scope: 'base', invoices: 0 },
      ...packed.map(slice => ({ scope: slice.scope, invoices: slice.data.invoices.length }))] };
    const out = [{ suffix: '-p0de' + of, data: base }];
    packed.forEach((slice, index) => {
      slice.data.part = { set: stamp, index: index + 1, of, scope: slice.scope };
      out.push({ suffix: '-p' + (index + 1) + 'de' + of, data: slice.data });
    });
    return out;
  }
  /* ===== Retención del respaldo (1.22.0, B4), declarada:
     · los conjuntos de los últimos 14 días se conservan todos;
     · de las 8 semanas anteriores, el más reciente de cada semana;
     · de los 12 meses anteriores, el más reciente de cada mes;
     · el resto se borra — SOLO tras verificar en este mismo ciclo
     que existen copias buenas en TODOS los destinos configurados
     (dentro y fuera del NAS). Sin verificación buena, no se poda. */
  function backupRetentionKeep(stamps, time) {
    const dayMs = 86400000;
    const stampDay = stamp => Date.parse(stamp + 'T00:00:00Z');
    const keep = new Set();
    const sorted = [...stamps].sort();
    for (const stamp of sorted) if (time - stampDay(stamp) < 14 * dayMs) keep.add(stamp);
    const byBucket = (list, keyOf) => {
      const buckets = new Map();
      for (const stamp of list) {
        const key = keyOf(stamp);
        if (!buckets.has(key) || buckets.get(key) < stamp) buckets.set(key, stamp);
      }
      return [...buckets.values()];
    };
    const mid = sorted.filter(stamp => !keep.has(stamp) && time - stampDay(stamp) < (14 + 56) * dayMs);
    for (const stamp of byBucket(mid, stamp => {
      const d = new Date(stampDay(stamp));
      return d.getUTCFullYear() + '-W' + Math.floor((stampDay(stamp) - Date.UTC(d.getUTCFullYear(), 0, 1)) / (7 * dayMs));
    })) keep.add(stamp);
    const old = sorted.filter(stamp => !keep.has(stamp) && time - stampDay(stamp) < (14 + 56 + 365) * dayMs);
    for (const stamp of byBucket(old, stamp => stamp.slice(0, 7))) keep.add(stamp);
    return keep;
  }
  function pruneBackupDir(dir, time) {
    let names = [];
    try { names = readdirSync(dir).filter(name => /^PacoSAT-\d{4}-\d{2}-\d{2}(-p\d+de\d+)?\.faro$/.test(name)); }
    catch { return 0; }
    const stamps = [...new Set(names.map(name => name.slice(8, 18)))];
    const keep = backupRetentionKeep(stamps, time);
    let removed = 0;
    for (const name of names) {
      if (keep.has(name.slice(8, 18))) continue;
      try { unlinkSync(join(dir, name)); removed++; } catch { /* se reintenta al ciclo siguiente */ }
    }
    return removed;
  }

  let backupBusy = false;
  async function runScheduledBackup(time) {
    if (!cloud || !backupJob || backupBusy) return;
    const next = Number(getState('backup:next') || 0);
    if (next && time < next) return;
    backupBusy = true;
    try {
      mkdirSync(backupJob.dir, { recursive: true });
      const stamp = day(time);
      /* B1: la foto puede viajar partida en varios .faro (base +
         partes por RFC/año) si cruza el techo; cada destino recibe
         el conjunto entero. */
      const sets = backupSets(snapshotFromRecords(), stamp)
        .map(set => ({ suffix: set.suffix, buffer: encryptBackupBuffer(set.data, backupJob.password) }));
      for (const set of sets) writeFileSync(join(backupJob.dir, 'PacoSAT-' + stamp + set.suffix + '.faro'), set.buffer);
      /* Destino secundario (1.6.4): el MISMO conjunto cifrado en una
         segunda ruta (pensada para una carpeta sincronizada fuera del
         NAS). Su fallo no tumba el respaldo principal: se anota y se
         avisa aparte. */
      let secondaryError = '';
      if (backupJob.secondaryDir) {
        try { mkdirSync(backupJob.secondaryDir, { recursive: true });
          for (const set of sets) writeFileSync(join(backupJob.secondaryDir, 'PacoSAT-' + stamp + set.suffix + '.faro'), set.buffer); }
        catch (error) { secondaryError = message(error); }
        setState('backup:secondaryError', secondaryError);
        /* Última copia externa buena (1.6.15): la vigila el semáforo de
           antigüedad de Salud y la alarma de los 7 días. */
        if (!secondaryError) setState('backup:secondaryOk', String(time));
        if (secondaryError) queueAlert('backup-secondary-fail', 'backup2:' + stamp, 'PacoSAT · El destino secundario del respaldo falló',
          'La copia principal del respaldo cifrado (' + stamp + ') se guardó, pero el destino secundario no aceptó la suya: ' +
          secondaryError + ' Revisa esa carpeta (sincronización, espacio o permisos).', time);
      }
      setState('backup:last', time);
      setState('backup:next', time + (backupJob.frequency === 'weekly' ? 7 * DAY : DAY));
      setState('backup:error', '');
      /* Historial de corridas de respaldo (1.28.0, P1): antes solo
         sobrevivía el último estado; ahora cada corrida deja su
         línea en el Registro. */
      auditEvent('accion', 'Respaldo cifrado programado guardado (' + stamp + ')' +
        (sets.length > 1 ? ' · partido en ' + sets.length + ' archivos' : '') +
        (backupJob.secondaryDir ? (secondaryError ? ' · el destino secundario falló: ' + secondaryError : ' · también en el destino secundario') : ''),
        '', !secondaryError, time);
      putMetadata('activity', { id: 'backup:' + stamp + ':' + backupJob.frequency, name: 'Respaldo cifrado programado',
        date: new Date(time).toISOString(), added: 0, duplicates: 0, review: 0, issues: [],
        event: 'Respaldo programado · copia cifrada guardada (' + stamp + ')' +
          (sets.length > 1 ? ' · partido en ' + sets.length + ' archivos por RFC/año (supera el techo en una sola foto)' : '') +
          (backupJob.secondaryDir ? (secondaryError ? ' · el destino secundario falló: ' + secondaryError : ' · también en el destino secundario') : '') +
          ' · incluye el estado operativo' });
      storageRevision++;
      /* Prueba de restauración automática contra lo recién escrito. */
      let verified = null;
      try { verified = verifyLatestBackup(time, 'automática tras el respaldo'); }
      catch (error) { queueAlert('backup-verify-fail', 'backupverify:' + stamp, 'PacoSAT · La prueba de restauración falló',
        'El respaldo se escribió, pero su prueba de restauración automática no pasó: ' + message(error), time); }
      /* B4: la poda SOLO corre con la verificación buena de TODOS
         los destinos en este mismo ciclo — la primera poda llega
         tras comprobar que hay copias buenas dentro y fuera. */
      if (verified?.ok) {
        let pruned = pruneBackupDir(backupJob.dir, time);
        if (backupJob.secondaryDir && !secondaryError) pruned += pruneBackupDir(backupJob.secondaryDir, time);
        if (pruned) {
          setState('backup:pruned', JSON.stringify({ at: time, count: pruned }));
          putMetadata('activity', { id: 'backup-prune:' + stamp, name: 'Poda de respaldos antiguos',
            date: new Date(time).toISOString(), added: 0, duplicates: 0, review: 0, issues: [],
            event: 'Retención aplicada tras verificar copias buenas en todos los destinos: ' + pruned +
              ' archivo(s) antiguos borrados (diarios 14 días · semanal 8 semanas · mensual 12 meses).' });
        }
      }
    } catch (error) {
      setState('backup:error', message(error));
      setState('backup:next', time + 60 * MIN);
      auditEvent('fallo', 'El respaldo programado falló: ' + message(error), '', 0, time);
      queueAlert('backup-fail', 'backup:' + day(time), 'PacoSAT · El respaldo programado falló',
        'El respaldo cifrado programado no pudo completarse: ' + message(error) +
        ' Se reintentará en una hora. Revisa la carpeta de respaldos y el espacio disponible.', time);
    } finally { backupBusy = false; }
  }

  let watchBusy = false;
  async function resolveInboxParser() {
    if (inboxParser) return inboxParser;
    const dom = await import('@xmldom/xmldom').catch(() => { throw new Error('Falta el lector XML del servidor.'); });
    return dom.DOMParser;
  }
  /* Carpeta vigilada (1.6.3): escaneo recursivo. El ciclo recorre todo el
     árbol bajo la carpeta configurada buscando XML/ZIP/PDF, porque los
     comprobantes se guardan en un folder con sus propias carpetas. Guardas:
     nunca se entra en las carpetas de salida del primer nivel (`procesados/`,
     `errores/` e `incidencias/`, esta última desde 1.6.4) para no reimportar
     lo ya movido entre ciclos; se ignoran
     archivos y carpetas ocultos o temporales; no se siguen enlaces
     simbólicos y la profundidad se limita a 8 carpetas. Cada ciclo procesa
     como máximo 20 archivos en orden estable de ruta relativa: lo procesado
     sale del árbol al moverse, así que ninguna subcarpeta se queda siempre
     al final; el resto espera al siguiente ciclo. El destino conserva la
     ruta relativa (`procesados/AAAA-MM-DD/<ruta>` y `errores/<ruta>`) y, si
     el nombre ya existe en el destino, se añade un sufijo numérico. */
  const WATCH_LIMIT = 20;
  const WATCH_MAX_DEPTH = 8;
  const WATCH_OUTPUT_DIRS = new Set(['procesados', 'errores', 'incidencias']);
  function collectWatchFiles(root) {
    const found = [];
    const walk = (dir, segments) => {
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); }
      catch { return; }
      for (const entry of entries) {
        if (entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
        if (entry.isDirectory()) {
          if (segments.length === 0 && WATCH_OUTPUT_DIRS.has(entry.name.toLowerCase())) continue;
          if (segments.length + 1 > WATCH_MAX_DEPTH) continue;
          walk(join(dir, entry.name), [...segments, entry.name]);
        } else if (entry.isFile()) {
          if (!/\.(xml|zip|pdf)$/i.test(entry.name)) continue;
          if (entry.name.startsWith('~$') || entry.name.endsWith('~')) continue;
          found.push([...segments, entry.name].join('/'));
        }
      }
    };
    walk(root, []);
    return found.sort();
  }
  function watchDestination(base, rel) {
    const segments = rel.split('/');
    let target = join(base, ...segments);
    if (!existsSync(target)) return target;
    const file = segments[segments.length - 1];
    const dot = file.lastIndexOf('.');
    const stem = dot > 0 ? file.slice(0, dot) : file;
    const ext = dot > 0 ? file.slice(dot) : '';
    for (let n = 2; ; n++) {
      target = join(base, ...segments.slice(0, -1), stem + ' (' + n + ')' + ext);
      if (!existsSync(target)) return target;
    }
  }
  /* Rescate 5002 (ronda anti-5002): los XML recuperados a mano desde el
     portal del SAT llegan por la carpeta vigilada — el canal aparte —.
     Si un CFDI recién importado cae dentro de la ventana de un criterio
     quemado de su RFC y sentido, ese criterio pasa a «rescatado»: el
     contenido ya está en el expediente, aunque el SAT siga sin aceptar
     ese criterio exacto. Solo cuentan los CFDI NUEVOS (los duplicados
     no rescatan nada) y solo criterios CFDI (los XML no rescatan un
     criterio de metadatos). */
  function markRescuedCriteria(imported, time) {
    for (const { key } of db.prepare('SELECT key FROM criteria_exhausted').all()) {
      let fields; try { fields = JSON.parse(key); } catch { continue; }
      const [rfc, direction, type] = fields;
      if (type !== 'cfdi') continue;
      const startAt = fields[5], endAt = fields[6];
      const matches = imported.filter(row => {
        if (direction === 'received' ? row.to.rfc !== rfc : row.from.rfc !== rfc) return false;
        const at = String(row.date || '').replace('T', ' ');
        return at >= startAt && at <= endAt;
      });
      if (!matches.length) continue;
      const was = db.prepare('SELECT 1 FROM criteria_rescued WHERE key=?').get(key);
      db.prepare(`INSERT INTO criteria_rescued(key,rescuedAt,count,detail) VALUES (?,?,?,?)
        ON CONFLICT(key) DO UPDATE SET rescuedAt=excluded.rescuedAt,
        count=criteria_rescued.count+excluded.count, detail=excluded.detail`)
        .run(key, time, matches.length, 'carpeta vigilada');
      if (!was) queueAlert('criteria-rescued', 'rescued:' + key,
        'PacoSAT · Un periodo quemado (5002) quedó rescatado por el portal',
        'Entraron ' + matches.length + ' CFDI por la carpeta vigilada dentro del periodo ' + startAt + ' a ' + endAt +
        ' de ' + rfc + ' (' + (direction === 'received' ? 'recibidos' : 'emitidos') + '), que estaba quemado ante el SAT ' +
        '(5002): su contenido ya está en el expediente y el criterio queda marcado «rescatado» en el libro. ' +
        'El SAT sigue sin aceptar ese criterio exacto, pero ya no hace falta pedirlo.', time);
    }
  }
  /* Ingesta de UN XML ya en memoria (núcleo compartido, 1.12.0):
     parsea, exige que emisor o receptor sea un RFC registrado,
     descarta duplicados por UUID y, si entra, guarda el fichero,
     el registro y la alta en la Vigilancia. Lo usan la carpeta
     vigilada (su camino histórico) y la descarga por CIEC, para
     que los XML del portal acaben en el MISMO almacén, con los
     mismos registros y la misma Vigilancia que los de cualquier
     otra vía. Devuelve 'added' o 'duplicate'; lanza con el motivo
     si el XML no puede entrar. */
  function importXmlShared(raw, Parser, peopleIds, addedRows, origin = 'importacion') {
    const row = parseXml(raw, Parser);
    /* Desglose fiscal también en esta vía (1.22.0): sin él, el
       detalle de novedades de la bandeja/CIEC salía «sin folio»
       aunque el XML lo trajera — la descarga masiva lo adjunta
       en inspectPackage y esta vía compartida no lo hacía. */
    try { row.fiscal = fiscalSummary(parseCfdiFull(raw, Parser)); } catch { /* sin desglose */ }
    need(peopleIds.has(row.from.rfc) || peopleIds.has(row.to.rfc), 'Los RFC del comprobante no están registrados.');
    if (db.prepare("SELECT 1 FROM records WHERE store='invoices' AND id=?").get(row.id)) return 'duplicate';
    putFile('xml:' + row.id, raw, 'application/xml');
    /* Origen del registro (1.13.1, pieza C3): la cobertura por
       meses distingue lo que vino por descarga del SAT de lo
       importado; los registros viejos no lo traen y la cobertura
       los cuenta como «sin clasificar», sin inventar su vía. */
    row.origin = origin;
    putMetadata('invoices', row);
    monitor.register({ id: row.id, emitter: row.from.rfc, receiver: row.to.rfc, total: row.total,
      seal: /^[A-Za-z0-9+/=]{8}$/.test(row.seal) ? row.seal : '' });
    addedRows.push(row);
    return 'added';
  }
  /* Ingesta de un lote de XML en memoria (descarga por CIEC,
     1.12.0): cada XML se intenta por el núcleo compartido; los
     que no pueden entrar cuentan como «por revisar» con su motivo
     (tope 20 en el registro de actividad, como la bandeja) y lo
     que entra puede rescatar criterios 5002 igual que lo que
     entra por la carpeta vigilada. */
  async function ingestXmlBuffers(buffers, time) {
    const Parser = await resolveInboxParser();
    const peopleIds = new Set(db.prepare("SELECT value FROM records WHERE store='people'").all().map(row => JSON.parse(row.value).id));
    const addedRows = [];
    let added = 0, duplicates = 0, review = 0;
    const issues = [];
    for (const buffer of buffers) {
      try { if (importXmlShared(buffer, Parser, peopleIds, addedRows, 'descarga') === 'added') added++; else duplicates++; }
      catch (error) {
        review++;
        if (issues.length < 20) issues.push({ name: 'XML del portal', reason: message(error) });
      }
    }
    if (added || duplicates || review) {
      putMetadata('activity', { id: 'ciec:' + time + ':' + added + ':' + review, name: 'Descarga CIEC desde el portal del SAT',
        date: new Date(time).toISOString(), added, duplicates, review, issues });
      storageRevision++;
    }
    if (addedRows.length) markRescuedCriteria(addedRows, time);
    return { added, duplicates, review, issues, addedRows };
  }
  async function scanWatchFolder(time) {
    if (!cloud || !inbox.dir || watchBusy) return;
    watchBusy = true;
    try {
      try { readdirSync(inbox.dir); }
      catch (error) {
        inboxStatus.error = message(error); setState('watch:error', inboxStatus.error);
        /* El barrido que no puede ni LEER la carpeta avisa
           (1.27.0, bloque A): hasta hoy dejaba solo una nota de
           estado en la pantalla — si Paco no la abría, la carpeta
           vigilada podía estar caída días en silencio. A la
           tercera pasada seguida sin poder leerla sale UN aviso
           (su ref es el día: no se repite dentro del mismo). */
        const streak = Number(getState('watch:fail-streak') || 0) + 1;
        setState('watch:fail-streak', String(streak));
        if (streak >= 3)
          queueAlert('watch-sweep-fail', 'watch-sweep:' + day(time),
            'PacoSAT · La carpeta vigilada no se puede leer',
            'El barrido de la carpeta vigilada lleva ' + streak + ' pasadas seguidas sin poder leerla: ' +
            inboxStatus.error + ' Los CFDI que lleguen a esa carpeta no están entrando. Revisa que la carpeta exista y que el NAS la tenga montada.', time);
        return;
      }
      inboxStatus.error = ''; setState('watch:error', '');
      if (getState('watch:fail-streak')) setState('watch:fail-streak', '');
      const candidates = collectWatchFiles(inbox.dir)
        .filter(rel => !inboxStuck.has(rel)).slice(0, WATCH_LIMIT);
      inboxStatus.lastScan = time;
      inboxStatus.waiting = 0;
      if (!candidates.length) return;
      /* Ingesta robusta (1.6.4): el tamaño se comprueba con stat ANTES de
         leer el contenido —un archivo que excede su límite se rechaza sin
         cargarlo entero— y cada candidato debe verse igual (tamaño y
         mtime) en dos lecturas separadas por una espera corta: si está
         creciendo (una copia a medias) se deja para el siguiente ciclo,
         sin contarlo como fallo ni como atascado. */
      const sizeLimits = [[/\.xml$/i, 8 * 1024 * 1024, 'El XML supera 8 MB.'],
        [/\.zip$/i, 80 * 1024 * 1024, 'El ZIP supera 80 MB.'], [/\.pdf$/i, 20 * 1024 * 1024, 'El PDF supera 20 MB.']];
      const stats = new Map(), oversize = new Map();
      for (const rel of candidates) {
        try {
          const stat = statSync(join(inbox.dir, ...rel.split('/')));
          stats.set(rel, { size: stat.size, mtimeMs: stat.mtimeMs });
          const limit = sizeLimits.find(([pattern]) => pattern.test(rel));
          if (limit && stat.size > limit[1]) oversize.set(rel, limit[2]);
        } catch { /* desapareció entre el listado y la lectura: se ignora este ciclo */ }
      }
      let ready = candidates.filter(rel => stats.has(rel));
      if (watchSettleMs > 0 && ready.some(rel => !oversize.has(rel))) {
        await new Promise(resolve => setTimeout(resolve, watchSettleMs));
        ready = ready.filter(rel => {
          if (oversize.has(rel)) return true;
          try {
            const again = statSync(join(inbox.dir, ...rel.split('/')));
            const before = stats.get(rel);
            if (again.size === before.size && again.mtimeMs === before.mtimeMs) return true;
          } catch { return false; }
          inboxStatus.waiting++;
          return false;
        });
      }
      if (!ready.length) return;
      const Parser = await resolveInboxParser();
      const peopleIds = new Set(db.prepare("SELECT value FROM records WHERE store='people'").all().map(row => JSON.parse(row.value).id));
      const okDir = join(inbox.dir, 'procesados', day(time));
      const badDir = join(inbox.dir, 'errores');
      const addedRows = [];
      const importXml = raw => importXmlShared(raw, Parser, peopleIds, addedRows);
      let added = 0, duplicates = 0, review = 0;
      const issues = [];
      const incidentsDir = join(inbox.dir, 'incidencias');
      for (const rel of ready) {
        const name = rel.split('/').pop();
        const path = join(inbox.dir, ...rel.split('/'));
        const fileIssues = [];
        const importedBefore = added + duplicates;
        let failed = '';
        try {
          if (oversize.has(rel)) throw new Error(oversize.get(rel));
          const raw = readFileSync(path);
          if (/\.xml$/i.test(name)) {
            need(raw.length <= 8 * 1024 * 1024, 'El XML supera 8 MB.');
            if (importXml(raw) === 'added') added++; else duplicates++;
          } else if (/\.zip$/i.test(name)) {
            need(raw.length <= 80 * 1024 * 1024, 'El ZIP supera 80 MB.');
            let count = 0;
            for await (const entry of zipXml(raw)) {
              count++;
              try { if (importXml(entry.xml) === 'added') added++; else duplicates++; }
              catch (error) { fileIssues.push({ name: rel + ' · ' + entry.name, reason: message(error) }); }
            }
            need(count > 0, 'El ZIP no contiene CFDI XML.');
          } else {
            const result = await analyzePdf(raw);
            const uuids = Array.isArray(result?.uuids) ? result.uuids : [];
            need(uuids.length === 1, 'El PDF no contiene un único folio fiscal identificable.');
            const saved = db.prepare("SELECT value FROM records WHERE store='invoices' AND id=?").get(uuids[0]);
            need(saved, 'El CFDI del PDF aún no está en el expediente; importa primero su XML.');
            const invoice = JSON.parse(saved.value);
            const rfc = [invoice.from.rfc, invoice.to.rfc].find(value => peopleIds.has(value));
            need(rfc, 'El CFDI del PDF no pertenece a un RFC registrado.');
            const docs = db.prepare("SELECT value FROM records WHERE store='documents'").all().map(row => JSON.parse(row.value));
            need(!docs.some(doc => doc.kind === 'Factura PDF' && doc.uuid === uuids[0] && doc.rfc === rfc), 'Ese CFDI ya tiene su PDF archivado.');
            const id = 'pdf:' + randomUUID();
            putFile(id, raw, 'application/pdf');
            putMetadata('documents', { id, rfc, kind: 'Factura PDF', date: invoice.date.slice(0, 10),
              period: '', name: rel.slice(0, 180), uuid: uuids[0] });
            added++;
          }
        } catch (error) { failed = message(error); }
        /* Tres resultados (1.6.4): procesado, procesado CON INCIDENCIAS
           (un ZIP del que entró algo pero no todo: el contenedor va a
           «incidencias» con su ruta relativa y el desglose por entrada
           queda en la bitácora y en el aviso) y rechazado (a «errores»).
           Un ZIP sin ninguna entrada válida es un rechazo, no una
           incidencia. */
        review += fileIssues.length;
        for (const issue of fileIssues) if (issues.length < 20) issues.push(issue);
        let outcome = failed ? 'failed' : 'ok';
        if (!failed && fileIssues.length) {
          if (added + duplicates > importedBefore) outcome = 'incidents';
          else { failed = 'El ZIP no aportó ningún CFDI: ' + (fileIssues[0]?.reason || 'entradas no válidas.'); outcome = 'failed'; }
        }
        try {
          const target = watchDestination(outcome === 'failed' ? badDir : outcome === 'incidents' ? incidentsDir : okDir, rel);
          mkdirSync(dirname(target), { recursive: true });
          renameSync(path, target);
        } catch { inboxStuck.add(rel); }
        if (outcome === 'failed') {
          review++;
          inboxStatus.failed++;
          if (issues.length < 20) issues.push({ name: rel, reason: failed });
          queueAlert('watch-fail', 'watch:' + rel, 'PacoSAT · Un archivo de la carpeta vigilada no se importó',
            'El archivo ' + rel + ' de la carpeta vigilada no pudo importarse: ' + failed +
            ' Quedó apartado en la subcarpeta «errores» de la carpeta vigilada, conservando su ruta relativa.', time);
        } else if (outcome === 'incidents') {
          inboxStatus.incidents++;
          queueAlert('watch-incidents', 'watchinc:' + rel, 'PacoSAT · Un archivo de la carpeta vigilada se importó con incidencias',
            'El archivo ' + rel + ' se importó solo en parte: ' + fileIssues.length + ' entrada(s) no pudieron importarse (' +
            fileIssues.slice(0, 3).map(issue => issue.name.split(' · ').pop() + ': ' + issue.reason).join('; ') +
            '). El contenedor quedó en la subcarpeta «incidencias» de la carpeta vigilada, conservando su ruta relativa; el desglose completo está en la bitácora.', time);
        } else { inboxStatus.imported++; inboxStatus.lastProcessed = time; }
      }
      if (added || duplicates || review) {
        putMetadata('activity', { id: 'inbox:' + time + ':' + added + ':' + review, name: 'Carpeta vigilada',
          date: new Date(time).toISOString(), added, duplicates, review, issues });
        storageRevision++;
      }
      /* Novedades de la bandeja (1.22.0): una pasada de la carpeta
         vigilada es UNA operación — su aviso lleva el detalle de
         todo lo que entró en ella, venga en un archivo o en diez. */
      if (addedRows.length) queueNews({ kind: 'bandeja', opkey: 'bandeja:' + time, label: 'importación por la carpeta vigilada' },
        addedRows.map(row => newsItemOf(row)), time);
      /* Lo recién importado puede rescatar criterios quemados (5002)
         recuperados a mano desde el portal: se marcan en el libro. */
      if (addedRows.length) markRescuedCriteria(addedRows, time);
    } finally { watchBusy = false; }
  }

  const profilePaused = (profile, time) => Boolean(profile.paused) || (profile.pauseUntil || 0) > time;
  const restUntil = () => Number(getSetting('restUntil') || 0);
  const resting = time => restUntil() > time;

  async function schedule(profile, service, time) {
    if (profilePaused(profile, time)) {
      /* Modo descanso por RFC (1.6.10): ni solicitudes ni avisos; la
         próxima revisión queda para cuando termine la pausa y al
         reanudar se calcula la ventana pendiente (catch-up). */
      db.prepare('UPDATE profiles SET nextRun=? WHERE rfc=?')
        .run(Math.max(profile.pauseUntil || 0, time + profile.minutes * MIN), profile.rfc);
      return;
    }
    const directions = profile.direction === 'both' ? ['received', 'issued'] : [profile.direction];
    const end = day(time);
    const catchupFrom = Number(getState('catchup:' + profile.rfc) || 0);
    const start = catchupFrom ? day(Math.max(Math.min(catchupFrom, time), time - 92 * DAY)) : day(time - (profile.days - 1) * DAY);
    if (catchupFrom) setState('catchup:' + profile.rfc, '');
    db.prepare('UPDATE profiles SET nextRun=?,error=? WHERE rfc=?').run(time + profile.minutes * MIN, '', profile.rfc);
    for (const direction of directions) {
      try {
        if (db.prepare("SELECT 1 FROM jobs WHERE rfc=? AND direction=? AND status='pending'").get(profile.rfc, direction)) continue;
        const startAt = start + ' 00:00:00';
        const endAt = end + ' ' + clock.format(time);
        const criteria = { rfc: profile.rfc, direction, type: 'cfdi', emitter: '', receiver: '', startAt, endAt };
        /* Red de seguridad anti-5002 en la programación: las ventanas
           avanzan y no deberían colisionar nunca; si el criterio exacto
           ya se solicitó, se usa la variante de cierre +1 s (el inicio
           no se mueve: ningún CFDI del primer segundo se queda fuera),
           se anota en la bitácora y se sigue. Jamás se envía un
           duplicado en silencio ni se detiene la programación sin rastro. */
        const free = freeCriteria(criteria);
        need(free, 'No se encontró un criterio libre para la descarga programada.');
        if (free.endShifts || free.startShifts) {
          putMetadata('activity', { id: 'guard5002:' + profile.rfc + ':' + direction + ':' + time,
            name: 'Blindaje SAT 5002 · ' + profile.rfc, date: new Date(time).toISOString(),
            added: 0, duplicates: 0, review: 0, issues: [],
            event: 'La descarga programada coincidía con un criterio ya solicitado (' + startAt + ' a ' + endAt +
              '); ' + (free.endShifts
                ? 'el cierre se desplazó a ' + free.criteria.endAt + ' (+' + free.endShifts + ' s)'
                : 'el inicio se desplazó a ' + free.criteria.startAt + ' (+' + free.startShifts + ' s)') +
              ' para no repetir el criterio ni agotar las solicitudes del SAT (error 5002).' });
          storageRevision++;
        }
        const requestId = await sendSatRequest(
          () => service.request({ start, end: free.criteria.endAt.slice(0, 10), startTime: free.criteria.startAt.slice(11), endTime: free.criteria.endAt.slice(11), direction }),
          free.criteria, 'scheduled', time);
        db.prepare('INSERT INTO jobs(rfc,direction,periodStart,periodEnd,startAt,endAt,requestId,status,due,created) VALUES (?,?,?,?,?,?,?,?,?,?)')
          .run(profile.rfc, direction, start, free.criteria.endAt.slice(0, 10), free.criteria.startAt, free.criteria.endAt, requestId, 'pending', time + 5 * MIN, time);
      } catch (error) {
        db.prepare('UPDATE profiles SET error=? WHERE rfc=?').run(message(error), profile.rfc);
      }
    }
  }

  /* Metadatos programados (1.6.10): una solicitud Metadata por RFC y
     sentido al día como máximo, con la misma ventana de la revisión y
     el mismo blindaje de criterios (tipo 'metadata': no consume los
     criterios de CFDI). Sirve para reconciliar cobertura y registrar
     estados sin descargar XML. Si el criterio no está disponible, se
     espera al siguiente ciclo: los metadatos nunca fuerzan un envío. */
  async function scheduleMetadata(profile, service, time) {
    if (profilePaused(profile, time)) return;
    const last = Number(getState('metadata:last:' + profile.rfc) || 0);
    if (time - last < DAY) return;
    const directions = profile.direction === 'both' ? ['received', 'issued'] : [profile.direction];
    const end = day(time), start = day(time - (profile.days - 1) * DAY);
    let sent = false;
    for (const direction of directions) {
      try {
        if (db.prepare("SELECT 1 FROM jobs WHERE rfc=? AND direction=? AND kind='metadata' AND status='pending'").get(profile.rfc, direction)) continue;
        const startAt = start + ' 00:00:00';
        const endAt = end + ' ' + clock.format(time);
        const criteria = { rfc: profile.rfc, direction, type: 'metadata', emitter: '', receiver: '', startAt, endAt };
        /* Misma variante anti-5002 que en CFDI: cierre +1 s hasta dar
           con un criterio libre; si no lo hay, se espera al siguiente
           ciclo — los metadatos nunca fuerzan un envío duplicado. */
        const free = freeCriteria(criteria);
        if (!free) continue;
        const requestId = await sendSatRequest(
          () => service.request({ start, end: free.criteria.endAt.slice(0, 10), startTime: free.criteria.startAt.slice(11), endTime: free.criteria.endAt.slice(11), direction, type: 'metadata' }),
          free.criteria, 'scheduled', time);
        db.prepare('INSERT INTO jobs(rfc,direction,kind,periodStart,periodEnd,startAt,endAt,requestId,status,due,created) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
          .run(profile.rfc, direction, 'metadata', start, free.criteria.endAt.slice(0, 10), free.criteria.startAt, free.criteria.endAt, requestId, 'pending', time + 5 * MIN, time);
        sent = true;
      } catch { /* metadatos: si el SAT no responde, se reintenta en el siguiente ciclo sin ensuciar el perfil */ }
    }
    if (sent) setState('metadata:last:' + profile.rfc, String(time));
  }

  /* Espera creciente entre verificaciones (1.6.4): 5, 10, 20, 40 y 60 min
     como tope. Sustituye el ritmo fijo de 5 min sin tope (hallazgo M-4 de
     la ronda 2): una solicitud que el SAT tarda en atender ya no se
     consulta en bucle corto, y el contador `jobs.checks` queda en el
     respaldo operativo para reanudar la cadencia tras un reinicio. */
  const verifyBackoffMin = checks => Math.min(5 * 2 ** checks, 60);
  /* Tramos de la ventana de UNA solicitud que ninguna solicitud
     terminada (de su RFC, sentido y clase) cubre (R3, 1.22.0).
     Las costuras de 1–2 s del blindaje +1 s no son hueco. */
  function jobWindowGaps(job) {
    const start = stampSeconds(job.startAt || job.periodStart + ' 00:00:00');
    const end = stampSeconds(job.endAt || job.periodEnd + ' 23:59:59');
    const ranges = db.prepare("SELECT startAt,endAt,periodStart,periodEnd FROM jobs WHERE rfc=? AND direction=? AND kind=? AND status='finished'")
      .all(job.rfc, job.direction, job.kind)
      .map(r => [stampSeconds(r.startAt || r.periodStart + ' 00:00:00'), stampSeconds(r.endAt || r.periodEnd + ' 23:59:59')])
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const gaps = [];
    let cursor = start;
    for (const [s, e] of ranges) {
      if (s > cursor + 1 && cursor <= end) gaps.push([cursor, Math.min(s - 1, end)]);
      cursor = Math.max(cursor, e + 1);
      if (cursor > end) break;
    }
    if (cursor <= end) gaps.push([cursor, end]);
    return gaps.filter(([s, e]) => e - s > 2).map(([s, e]) => stampText(s) + ' a ' + stampText(e));
  }
  async function verifyJobs(profile, active, time) {
    const jobs = db.prepare("SELECT * FROM jobs WHERE rfc=? AND status='pending' AND held=0 AND due<=? ORDER BY id").all(profile.rfc, time);
    const terminal = [];
    let stuck = 0;
    for (const job of jobs) {
      /* Si el proceso muere a mitad de la verificación, la solicitud no
         queda vencida al momento: se reprograma ya con su espera actual. */
      db.prepare('UPDATE jobs SET due=? WHERE id=?').run(time + verifyBackoffMin(job.checks || 0) * MIN, job.id);
      const save = async next => db.prepare('UPDATE jobs SET imported=?,status=?,error=? WHERE id=?')
        .run(JSON.stringify(next.imported || []), next.status, '', job.id);
      try {
        const advanced = await advanceSatJob(active.connector, { ...job, imported: JSON.parse(job.imported) }, save,
          ({ id, archive }) => job.kind === 'metadata' ? inspectMetadataPackage(job, id, archive) :
            inspectPackage(job, id, archive, active.parser), {
          /* Contador 5008 persistido ANTES de descargar (mejora nº 3):
             a los 2 intentos sin éxito, no se descarga más y la
             solicitud se cierra como «exhausted» con aviso. */
          beforeDownload: async remoteId => {
            const row = db.prepare('SELECT attempts FROM package_attempts WHERE job=? AND remoteId=?').get(job.id, remoteId);
            const attempts = (row?.attempts || 0) + 1;
            db.prepare('INSERT INTO package_attempts(job,remoteId,attempts) VALUES (?,?,?) ' +
              'ON CONFLICT(job,remoteId) DO UPDATE SET attempts=excluded.attempts').run(job.id, remoteId, attempts);
            if (attempts <= 2) return true;
            queueAlert('package-exhausted', 'pkg:' + job.id + ':' + remoteId,
              'PacoSAT · Un paquete agotó sus descargas ante el SAT (5008)',
              'El paquete ' + remoteId + ' de la solicitud ' + job.requestId + ' (' + job.rfc + ', ' +
              job.periodStart + ' a ' + job.periodEnd + ') ya se intentó descargar dos veces sin éxito y el SAT no ' +
              'permite más descargas de ese paquete (error 5008). La solicitud quedó cerrada con este aviso, no ' +
              'pendiente para siempre. Salida: solicita el mismo periodo cerrando un segundo más tarde desde ' +
              '«Solicitar un periodo» en el Centro SAT.', time);
            return false;
          } });
        db.prepare('UPDATE jobs SET error=? WHERE id=?').run('', job.id);
        if (advanced?.satCode === 5002) learnCriteria5002(job, time);
      } catch (error) { db.prepare('UPDATE jobs SET error=? WHERE id=?').run(message(error), job.id); }
      const after = db.prepare('SELECT status,error FROM jobs WHERE id=?').get(job.id);
      /* R3 (1.22.0): al terminar, la solicitud DECLARA en su
         diario si su ventana quedó cubierta o qué tramo falta —
         el hueco ya no se descubre días después en Cobertura. */
      if (after?.status === 'finished' && job.kind === 'cfdi') {
        const gaps = jobWindowGaps(job);
        const review = db.prepare('SELECT COALESCE(SUM(review),0) AS n FROM packages WHERE job=?').get(job.id).n;
        const note = gaps.length ? 'Quedó a medias: falta ' + gaps.join('; ') + ' de la ventana pedida.' :
          review ? 'Ventana cubierta; ' + review + ' XML quedaron por revisar en sus paquetes.' :
          'Ventana cubierta por completo.';
        db.prepare('UPDATE jobs SET note=? WHERE id=?').run(note, job.id);
        putMetadata('activity', { id: 'sat-cierre:' + job.id, name: 'Descarga del SAT · ' + job.rfc,
          date: new Date(time).toISOString(), added: 0, duplicates: 0, review, issues: [],
          event: 'La solicitud ' + job.requestId + ' (' + job.periodStart + ' a ' + job.periodEnd + ', ' +
            (job.direction === 'received' ? 'recibidos' : 'emitidos') + ') terminó. ' + note });
        storageRevision++;
      }
      if (after && ['expired', 'failed', 'rejected', 'exhausted'].includes(after.status)) {
        /* R3 también al caer: la solicitud cortada declara qué
           tramo de su ventana NO cubre ninguna solicitud
           terminada — el tramo que falta, dicho al cerrar. */
        if (job.kind === 'cfdi') {
          const gaps = jobWindowGaps(job);
          const note = gaps.length ? 'Terminó sin completar (' + after.status + '): falta ' + gaps.join('; ') +
              ' de la ventana pedida; ninguna solicitud terminada lo cubre.' :
            'Terminó sin completar (' + after.status + '), pero su ventana ya la cubre otra solicitud terminada.';
          db.prepare('UPDATE jobs SET note=? WHERE id=?').run(note, job.id);
          putMetadata('activity', { id: 'sat-cierre:' + job.id, name: 'Descarga del SAT · ' + job.rfc,
            date: new Date(time).toISOString(), added: 0, duplicates: 0, review: 0, issues: [],
            event: 'La solicitud ' + job.requestId + ' (' + job.periodStart + ' a ' + job.periodEnd + ', ' +
              (job.direction === 'received' ? 'recibidos' : 'emitidos') + ') no terminó. ' + note });
          storageRevision++;
        }
        terminal.push({ ...job, afterStatus: after.status });
      }
      else if (after?.status === 'pending') {
        const checks = (job.checks || 0) + 1;
        const wait = verifyBackoffMin(checks);
        db.prepare('UPDATE jobs SET checks=?,due=? WHERE id=?').run(checks, time + wait * MIN, job.id);
        if (after.error) stuck++;
        if (wait >= 60 && verifyBackoffMin(checks - 1) < 60) {
          putMetadata('activity', { id: 'backoff:' + job.id, name: 'Verificación al SAT · espera máxima',
            date: new Date(time).toISOString(), added: 0, duplicates: 0, review: 0, issues: [],
            event: 'La solicitud ' + job.requestId + ' del RFC ' + job.rfc + ' (' + job.periodStart + ' a ' + job.periodEnd +
              ') sigue pendiente en el SAT tras ' + checks + ' verificaciones; la espera entre consultas queda en su tope de 60 minutos.' });
          storageRevision++;
        }
      }
    }
    return { terminal, attempted: jobs.length, stuck };
  }

  /* Cobertura de descarga por RFC (1.6.4). A partir de las solicitudes
     (con sus instantes exactos al segundo del blindaje) y del libro de
     criterios: por RFC y sentido, los tramos ya descargados (solicitudes
     terminadas), lo que sigue en curso, lo fallido y los criterios
     agotados. Dos tramos terminados dejan hueco solo si entre el fin de
     uno y el inicio del siguiente queda más de un segundo sin cubrir;
     los huecos de 1–2 s son las costuras del desplazamiento +1 s del
     blindaje y se marcan como micro-huecos. «Verificado hasta» es el fin
     del primer tramo continuo. La conciliación SOLO anota en la bitácora
     los huecos nuevos: PacoSAT no solicita nada al SAT por su cuenta. */
  const stampSeconds = datetime => {
    const [datePart, timePart] = String(datetime || '').split(' ');
    const [year, month, date] = (datePart || '').split('-').map(Number);
    const [hour, minute, second] = (timePart || '00:00:00').split(':').map(Number);
    return Date.UTC(year || 1970, (month || 1) - 1, date || 1, hour || 0, minute || 0, second || 0) / 1000;
  };
  const stampText = seconds => {
    const date = new Date(seconds * 1000);
    return date.getUTCFullYear() + '-' + pad2(date.getUTCMonth() + 1) + '-' + pad2(date.getUTCDate()) +
      ' ' + pad2(date.getUTCHours()) + ':' + pad2(date.getUTCMinutes()) + ':' + pad2(date.getUTCSeconds());
  };
  function computeCoverage() {
    const exhaustedKeys = new Set(db.prepare('SELECT key FROM criteria_exhausted').all().map(row => row.key));
    const groups = new Map();
    const groupFor = (rfc, direction) => {
      const key = rfc + '|' + direction;
      if (!groups.has(key)) groups.set(key, { rfc, direction, ranges: [], pending: 0, failed: 0, exhausted: 0 });
      return groups.get(key);
    };
    for (const job of db.prepare('SELECT rfc,direction,periodStart,periodEnd,startAt,endAt,status FROM jobs').all()) {
      const group = groupFor(job.rfc, job.direction);
      if (job.status === 'finished') group.ranges.push([job.startAt || job.periodStart + ' 00:00:00', job.endAt || job.periodEnd + ' 23:59:59']);
      else if (job.status === 'pending') group.pending++;
      else group.failed++;
    }
    for (const row of db.prepare("SELECT rfc,direction,key FROM criteria WHERE type='cfdi'").all())
      if (exhaustedKeys.has(row.key)) groupFor(row.rfc, row.direction).exhausted++;
    const gaps = [], days = {}, out = [];
    for (const group of groups.values()) {
      const merged = [];
      for (const [start, end] of group.ranges.map(([s, e]) => [stampSeconds(s), stampSeconds(e)]).sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
        const last = merged[merged.length - 1];
        if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
        else merged.push([start, end]);
      }
      for (let i = 1; i < merged.length; i++) {
        const uncovered = merged[i][0] - merged[i - 1][1] - 1;
        if (uncovered > 0) gaps.push({ rfc: group.rfc, direction: group.direction,
          from: stampText(merged[i - 1][1] + 1), to: stampText(merged[i][0] - 1), seconds: uncovered, micro: uncovered <= 2 });
      }
      const daySet = days[group.rfc] || (days[group.rfc] = { received: new Set(), issued: new Set() });
      for (const [start, end] of merged) {
        const first = Math.floor(start / 86400), last = Math.floor(end / 86400);
        for (let d = first; d <= last && d - first < 3700; d++)
          daySet[group.direction].add(new Date(d * 86400000).toISOString().slice(0, 10));
      }
      out.push({ rfc: group.rfc, direction: group.direction, verifiedUntil: merged.length ? stampText(merged[0][1]) : '',
        covered: merged.map(([s, e]) => [stampText(s), stampText(e)]), pending: group.pending, failed: group.failed, exhausted: group.exhausted });
    }
    for (const rfc of Object.keys(days)) { days[rfc].received = [...days[rfc].received].sort(); days[rfc].issued = [...days[rfc].issued].sort(); }
    gaps.sort((a, b) => (a.rfc + a.direction + a.from).localeCompare(b.rfc + b.direction + b.from));
    out.sort((a, b) => (a.rfc + a.direction).localeCompare(b.rfc + b.direction));
    /* Cobertura REAL desde los registros (1.13.1, pieza C3): las
       tarjetas de «qué meses tienes» salen de los CFDI que el
       sistema TIENE (importados o descargados), no del libro de
       solicitudes — con 2.495 importados y cero solicitudes, la
       cobertura ya no puede decir «aún no hay descargas». Por RFC
       y sentido: meses con su conteo, el desglose por vía cuando
       el registro la declara (los viejos van «sin clasificar», sin
       inventar), y los meses hueco dentro del rango de actividad
       (primer y último mes con datos) para enseñarlos como
       «sin datos» con su botón de descarga. */
    const peopleIds = new Set(db.prepare("SELECT value FROM records WHERE store='people'").all()
      .map(row => { try { return JSON.parse(row.value).id; } catch { return ''; } }).filter(Boolean));
    const recGroups = new Map();
    for (const invoice of recordInvoices()) {
      const month = String(invoice.date || '').slice(0, 7);
      if (!/^\d{4}-\d{2}$/.test(month)) continue;
      for (const [rfc, direction] of [[invoice.from?.rfc, 'issued'], [invoice.to?.rfc, 'received']]) {
        if (!rfc || !peopleIds.has(rfc)) continue;
        const key = rfc + '|' + direction;
        if (!recGroups.has(key)) recGroups.set(key, { rfc, direction, byMonth: new Map() });
        const cell = recGroups.get(key).byMonth.get(month) ||
          { month, count: 0, descarga: 0, importacion: 0, sinClasificar: 0 };
        cell.count++;
        if (invoice.origin === 'descarga') cell.descarga++;
        else if (invoice.origin === 'importacion') cell.importacion++;
        else cell.sinClasificar++;
        recGroups.get(key).byMonth.set(month, cell);
      }
    }
    const recordsCoverage = [...recGroups.values()].map(group => {
      const months = [...group.byMonth.values()].sort((a, b) => a.month.localeCompare(b.month));
      const first = months[0]?.month || '', last = months[months.length - 1]?.month || '';
      const huecos = [];
      if (first && last) {
        let cursor = first, guard = 0;
        while (cursor < last && guard++ < 240) {
          const [y, m] = cursor.split('-').map(Number);
          cursor = m === 12 ? (y + 1) + '-01' : y + '-' + String(m + 1).padStart(2, '0');
          if (cursor < last && !group.byMonth.has(cursor)) huecos.push(cursor);
        }
      }
      return { rfc: group.rfc, direction: group.direction, months, first, last, huecos,
        total: months.reduce((sum, cell) => sum + cell.count, 0) };
    }).sort((a, b) => (a.rfc + a.direction).localeCompare(b.rfc + b.direction));
    return { groups: out, gaps, days, records: recordsCoverage };
  }
  function reconcileCoverageGaps(time) {
    let gaps;
    try { gaps = computeCoverage().gaps; } catch { return; }
    const signature = JSON.stringify(gaps.map(gap => [gap.rfc, gap.direction, gap.from, gap.to]));
    if (!gaps.length) { if (getState('coverage:gaps')) setState('coverage:gaps', ''); return; }
    if (getState('coverage:gaps') === signature) return;
    setState('coverage:gaps', signature);
    let hash = 0;
    for (const char of signature) hash = ((hash * 31) + char.charCodeAt(0)) >>> 0;
    const list = gaps.slice(0, 8).map(gap => gap.rfc + ' · ' + (gap.direction === 'received' ? 'recibidos' : 'emitidos') +
      ': del ' + gap.from + ' al ' + gap.to + (gap.micro ? ' (micro-hueco: costura del blindaje)' : '')).join(' · ');
    putMetadata('activity', { id: 'coverage:' + hash.toString(36), name: 'Conciliación de cobertura',
      date: new Date(time).toISOString(), added: 0, duplicates: 0, review: gaps.length, issues: [],
      event: 'Se detectaron ' + gaps.length + ' hueco(s) sin descargar: ' + list +
        '. PacoSAT no pide nada al SAT por su cuenta: para cubrir un tramo, solicítalo desde el Centro SAT (si el criterio exacto ya se envió, desplaza un extremo un segundo).' });
    storageRevision++;
  }

  /* notify() conserva su nombre y su lugar en el ciclo (1.22.0):
     despacha los avisos de novedades agrupados por operación con
     su detalle (sendNewsNotices). La vieja tabla notices —un aviso
     por paquete con solo la cuenta— ya no recibe filas nuevas: su
     despachador quedó retirado con el correo que no decía datos. */
  async function notify(time) { await sendNewsNotices(time); }
  const jobStateLabel = { expired: 'vencida', failed: 'fallida', rejected: 'rechazada' };
  function queueAlert(kind, ref, subject, bodyText, time, rfc = '') {
    /* El RFC dueño viaja como DATO cuando el sitio que encola lo
       conoce (1.27.0, H-6.1): el resumen de sucesos agrupa por
       esta columna y solo lo que llegó sin ella — filas legadas —
       se atribuye por el texto, como hasta la 1.26. */
    db.prepare('INSERT OR IGNORE INTO alerts(kind,ref,subject,body,due,rfc) VALUES (?,?,?,?,?,?)')
      .run(kind, ref, subject, bodyText, time, String(rfc || '').toUpperCase());
  }
  /* ===== Registro unificado (1.28.0, P1) =====
     Una sola lista cronológica de Conexiones / Acciones / Fallos
     en lenguaje llano. Es una PROYECCIÓN de solo lectura sobre lo
     que ya se registra (los cuatro diarios de motor, access_log,
     activity, mail_sends) más la tabla audit_events, que guarda
     solo lo que ningún diario guardaba: las acciones del
     administrador hechas desde la app y el historial de corridas
     de respaldo (antes solo sobrevivía el último estado). */
  function auditEvent(clase, texto, rfc = '', ok = 1, at = null) {
    try { db.prepare('INSERT INTO audit_events(at,clase,rfc,texto,ok) VALUES (?,?,?,?,?)')
      .run(at ?? now(), clase, String(rfc || '').toUpperCase(), String(texto || ''), ok ? 1 : 0); }
    catch { /* el registro nunca tumba la acción registrada */ }
  }
  const auditAdmin = (texto, rfc = '') => auditEvent('accion', texto, rfc, 1);
  function registroOverview({ rfc = '', clase = '', limit = 300 } = {}) {
    const filtroRfc = String(rfc || '').toUpperCase();
    const tope = Math.max(1, Math.min(2000, Number(limit) || 300));
    const items = [];
    let seq = 0;
    /* Atribución por texto de las dos fuentes que no guardan su
       RFC como dato (access_log y activity): corrección H-1.2
       de la pasada de seguridad. Una línea solo se atribuye a un
       contribuyente si ese RFC —de un perfil conocido— es el
       ÚNICO que su texto nombra; si nombra a dos o más, no se
       atribuye a ninguno (en la vista sin filtrar sigue estando,
       sin RFC). Lo que tenga su RFC como dato (la entrada de
       activity que lo trae, los diarios, los correos y
       audit_events) no pasa por aquí. */
    const perfilesConocidos = new Set(db.prepare('SELECT rfc FROM profiles').all()
      .map(row => String(row.rfc || '').toUpperCase()));
    const rfcEnTexto = texto => {
      const vistos = new Set();
      for (const m of String(texto || '').toUpperCase().matchAll(/\b[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}\b/g))
        if (perfilesConocidos.has(m[0])) vistos.add(m[0]);
      return vistos.size === 1 ? [...vistos][0] : '';
    };
    const push = (at, claseItem, rfcItem, texto, ok, evidencia = null, origen = '', detalle = null) => {
      if (!at) return;
      items.push({ at, clase: claseItem, rfc: rfcItem || '', texto, ok: Boolean(ok),
        evidencia, origen: origen || '', detalle, seq: seq++ });
    };
    /* Detalle abrible de una corrida (1.29.0, punto 4): la traza
       ENTERA de ese intento — pasos con su hora, error literal y
       clase — viaja con el suceso del Registro para corregir desde
       el propio log, sin cazar la corrida pantalla a pantalla. */
    const detalleRun = row => {
      let steps = [];
      try { steps = JSON.parse(row.steps || '[]'); } catch { steps = []; }
      return { steps, error: row.error || '', errorKind: row.errorKind || '',
        attempts: row.attempts || 0, started: row.started || 0, finished: row.finished || 0 };
    };
    /* Los cuatro diarios de motor: éxito = conexión; fallo =
       fallo con su motivo y, si la página quedó guardada, su
       evidencia abrible. Las corridas sin cerrar no son suceso. */
    for (const row of db.prepare("SELECT * FROM sat_doc_runs WHERE finished>0 ORDER BY started DESC LIMIT 400").all()) {
      const label = DOC_KIND_LABEL[row.kind] || row.kind;
      if (row.ok) push(row.finished, 'conexion', row.rfc, 'Descargó «' + label + '» de ' + row.rfc, true, null, row.origen);
      else push(row.finished, 'fallo', row.rfc, 'No se pudo descargar «' + label + '» de ' + row.rfc + (row.error ? ': ' + row.error : ''), false,
        { motor: 'satdoc', runId: row.id, hasShot: Boolean(row.shotId), hasHtml: Boolean(row.htmlId) }, row.origen, detalleRun(row));
    }
    for (const row of db.prepare("SELECT * FROM ciec_runs WHERE finished>0 ORDER BY started DESC LIMIT 400").all()) {
      if (row.ok) push(row.finished, 'conexion', row.rfc, 'Descarga por CIEC de ' + row.rfc + ': ' + (row.added || 0) + ' facturas nuevas', true, null, row.origen);
      else push(row.finished, 'fallo', row.rfc, 'La descarga por CIEC de ' + row.rfc + ' no terminó' + (row.error ? ': ' + row.error : ''), false,
        { motor: 'ciec', runId: row.id, hasShot: Boolean(row.shotId), hasHtml: Boolean(row.htmlId) }, row.origen, detalleRun(row));
    }
    for (const row of db.prepare("SELECT * FROM decl_runs WHERE finished>0 ORDER BY started DESC LIMIT 400").all()) {
      const que = row.tipo === 'anual' ? 'la declaración anual ' + row.ejercicio : 'declaraciones ' + (row.periodo || row.ejercicio || '');
      if (row.ok) push(row.finished, 'conexion', row.rfc, 'Recuperó ' + que + ' de ' + row.rfc, true, null, row.origen);
      else push(row.finished, 'fallo', row.rfc, 'No se pudieron recuperar ' + que + ' de ' + row.rfc + (row.error ? ': ' + row.error : ''), false,
        { motor: 'declaraciones', runId: row.id, hasShot: Boolean(row.shotId), hasHtml: Boolean(row.htmlId) }, row.origen, detalleRun(row));
    }
    for (const row of db.prepare("SELECT * FROM trib_runs WHERE finished>0 ORDER BY started DESC LIMIT 400").all()) {
      if (row.ok) push(row.finished, 'conexion', row.rfc, 'Consultó el Buzón Tributario de ' + row.rfc + ': ' +
        (row.encontradas || 0) + ' en la bandeja, ' + (row.sinAbrir || 0) + ' sin abrir', true, null, row.origen);
      else push(row.finished, 'fallo', row.rfc, 'No se pudo consultar el Buzón Tributario de ' + row.rfc + (row.error ? ': ' + row.error : ''), false,
        { motor: 'tributario', runId: row.id, hasShot: Boolean(row.shotId), hasHtml: Boolean(row.htmlId) }, row.origen, detalleRun(row));
    }
    /* Trabajos e intentos del ejecutor local (1.29.0): el trabajo
       en cola NO es un fallo — es una acción «esperando tu equipo» —;
       cada INTENTO cerrado entra con su traza entera y su evidencia,
       para que el detalle se abra desde esta misma lista aunque el
       trabajo se reintente después con otro intento. */
    for (const row of db.prepare("SELECT * FROM sat_executor_jobs ORDER BY creado DESC LIMIT 200").all()) {
      const view = executorJobView(row);
      if (row.estado === 'en-cola')
        push(row.creado, 'accion', row.rfc, 'Trabajo del SAT esperando tu equipo: ' + row.kind + ' de ' + row.rfc +
          ' — el ejecutor local aún no lo ha recogido (no es un fallo del SAT).', true, null, row.origen || '',
          { steps: [], estado: row.estado, jobId: row.id, payload: view.payload });
      else if (row.estado === 'en-curso' || row.estado === 'reclamado')
        push(row.actualizado, 'accion', row.rfc, 'El ejecutor de tu equipo está trabajando: ' + row.kind + ' de ' + row.rfc + '.', true, null, row.origen || '',
          { steps: view.steps, estado: row.estado, jobId: row.id, payload: view.payload });
    }
    for (const row of db.prepare("SELECT a.*, j.rfc, j.kind FROM sat_executor_attempts a JOIN sat_executor_jobs j ON j.id=a.jobId ORDER BY a.finished DESC LIMIT 400").all()) {
      const evidencia = { motor: row.kind === 'buzon-listar' ? 'tributario' : 'declaraciones', runId: row.id,
        hasShot: Boolean(row.shotId), hasHtml: Boolean(row.htmlId) };
      if (row.ok) push(row.finished, 'conexion', row.rfc, 'El ejecutor local completó «' + row.kind + '» de ' + row.rfc, true, null, 'ejecutor',
        detalleRun({ ...row, attempts: 1 }));
      else push(row.finished, 'fallo', row.rfc, 'El ejecutor local no pudo con «' + row.kind + '» de ' + row.rfc + (row.error ? ': ' + row.error : ''), false,
        evidencia, 'ejecutor', detalleRun({ ...row, attempts: 1 }));
    }
    /* Accesos a la instalación (la lectura del invitado, 'guest',
       es ruido por lectura: no entra). El detalle ya viene en
       lenguaje llano de logAccess; la clase sale del tipo. */
    const ACCESS_CLASE = { 'login-ok': 'conexion', 'admin-login': 'conexion', 'guest-login': 'conexion',
      'admin-login-failed': 'fallo', 'guest-login-failed': 'fallo', 'guest-blocked': 'fallo' };
    const ACCESS_TEXT = { 'login-ok': 'Entrada a PacoSAT con la llave de acceso',
      'backup-restore': 'Se restauró un respaldo',
      'install-created': 'Se creó la llave de acceso de la instalación',
      'install-rotated': 'Se renovó la llave de acceso de la instalación',
      'guest-link': 'Se creó o renovó el enlace de invitado',
      'pause': 'Se pausó o reanudó un contribuyente', 'rest': 'Se cambió el descanso general' };
    for (const row of db.prepare("SELECT * FROM access_log ORDER BY at DESC LIMIT 400").all()) {
      if (row.kind === 'guest') continue;
      const claseItem = ACCESS_CLASE[row.kind] || 'accion';
      const texto = String(row.detail || '').trim() || ACCESS_TEXT[row.kind] || row.kind;
      push(row.at, claseItem, rfcEnTexto(texto), texto, claseItem !== 'fallo');
    }
    /* Actividad que la propia app fue anotando (importaciones,
       descargas hechas a mano, envíos…). */
    for (const row of db.prepare("SELECT value FROM records WHERE store='activity' ORDER BY rowid DESC LIMIT 300").all()) {
      let entry = null;
      try { entry = JSON.parse(row.value || 'null'); } catch { entry = null; }
      if (!entry) continue;
      const texto = String(entry.name || entry.title || entry.event || '').trim();
      if (!texto) continue;
      push(Number(entry.at || entry.time || entry.created || 0), 'accion',
        String(entry.rfc || '').toUpperCase() || rfcEnTexto(texto), texto, entry.ok !== false);
    }
    /* Correos: el envío que consta, con su RFC cuando lo lleva. */
    for (const row of db.prepare("SELECT * FROM mail_sends ORDER BY at DESC LIMIT 300").all()) {
      if (row.ok) push(row.at, 'accion', row.rfc || '', 'Correo enviado: ' + (row.subject || ''), true);
      else push(row.at, 'fallo', row.rfc || '', 'Correo no enviado: ' + (row.subject || '') + (row.error ? ' — ' + row.error : ''), false);
    }
    /* Lo que solo guarda audit_events: acciones del administrador
       y corridas de respaldo. */
    for (const row of db.prepare("SELECT * FROM audit_events ORDER BY at DESC LIMIT 400").all())
      push(row.at, row.clase, row.rfc || '', row.texto, Boolean(row.ok));
    items.sort((a, b) => (b.at - a.at) || (b.seq - a.seq));
    const filtrados = items.filter(item =>
      (!filtroRfc || item.rfc === filtroRfc) && (!clase || item.clase === clase));
    return { items: filtrados.slice(0, tope).map(({ seq: _seq, ...item }) => item), total: filtrados.length };
  }
  /* La línea de Hoy: lo de las últimas 24 h, contado una vez. */
  function registroResumen(time) {
    const desde = time - DAY;
    const { items } = registroOverview({ limit: 2000 });
    const recientes = items.filter(item => item.at >= desde);
    const ultimoFallo = recientes.find(item => item.clase === 'fallo') || null;
    return { fallos: recientes.filter(item => item.clase === 'fallo').length,
      conexiones: recientes.filter(item => item.clase === 'conexion').length,
      acciones: recientes.filter(item => item.clase === 'accion').length,
      ultimoFallo: ultimoFallo ? { at: ultimoFallo.at, texto: ultimoFallo.texto, rfc: ultimoFallo.rfc } : null };
  }
  /* El RFC propio de un CFDI vigilado: el perfil que consta como
     emisor o como receptor (para atribuir sus sucesos al resumen
     de SU contribuyente). '' si ninguno de los dos es perfil. */
  function ownRfcOfWatch(item) {
    if (!item) return '';
    const ps = new Set(db.prepare('SELECT rfc FROM profiles').all().map(row => row.rfc));
    return ps.has(item.emitter) ? item.emitter : ps.has(item.receiver) ? item.receiver : '';
  }
  function noteDownloadOutcome(rfc, attempted, failed, time) {
    const key = 'autofail:' + rfc;
    if (!attempted) return;
    if (!failed) { db.prepare('DELETE FROM alert_state WHERE key=?').run(key); return; }
    db.prepare('INSERT INTO alert_state(key,failures,alerted) VALUES (?,1,0) ON CONFLICT(key) DO UPDATE SET failures=failures+1').run(key);
    const state = db.prepare('SELECT failures,alerted FROM alert_state WHERE key=?').get(key);
    if (state.failures >= 3 && !state.alerted) {
      queueAlert('download-fail', key + ':' + time, 'PacoSAT · La descarga automática está fallando',
        'Las revisiones automáticas del RFC ' + rfc + ' llevan ' + state.failures + ' intentos seguidos con error. ' +
        'Revisa la conexión y el estado del SAT en el Centro SAT; el detalle del último error aparece junto al RFC.', time);
      db.prepare('UPDATE alert_state SET alerted=1 WHERE key=?').run(key);
    }
  }
  /* Correo-resumen del Centro de Avisos (1.7.4, criterio 3): NUNCA
     más un correo por aviso. sendAlerts conserva su nombre y su lugar
     en el ciclo, pero ahora sincroniza el Centro y, como mucho, manda
     UN correo con el resumen de avisos abiertos no-línea-base aún no
     resumidos, según la cadencia elegida (diario / semanal-lunes /
     solo graves / sin correo). Las alertas internas (tabla alerts)
     quedan como fuente del espejo del Centro; ya no se envían de una
     en una. El informe mensual a Nora y el resumen semanal ejecutivo
     de Informes son correos APARTE, con su propio interruptor. */
  async function sendAlerts(time) {
    avisosSync(time);
    if (!mail) return;
    /* El interruptor «Avisos importantes por correo» es el maestro
       de TODO el correo de avisos (1.13.1, pieza G): apagado, ni el
       resumen de Avisos sale. Los Informes son aparte, con el suyo. */
    if (!mailAlertsOn()) return;
    const config = avisosConfig();
    if (config.correo === 'no') return;
    const mx = mxParts(time);
    if (mx.hour < config.hora) return;
    const pendientes = db.prepare("SELECT * FROM avisos WHERE estado NOT IN ('solventado','descartado') AND baseline=0 AND correo=0 ORDER BY creado").all();
    if (!pendientes.length) return;
    /* Correos por RFC (1.24.0, M3): el resumen se parte por
       contribuyente — ningún correo mezcla avisos de dos RFC. Los
       avisos sin RFC propio (los del sistema) viajan en su propio
       correo, el de la instalación. La cadencia se cuenta POR
       GRUPO (avisos:digest-day:<rfc>): que salga el resumen de un
       RFC no consume el día de otro, y cada grupo marca solo sus
       avisos como resumidos. */
    const grupos = new Map();
    for (const aviso of pendientes) {
      const clave = String(aviso.rfc || '');
      if (!grupos.has(clave)) grupos.set(clave, []);
      grupos.get(clave).push(aviso);
    }
    const active = mail;
    const claseNombre = { necesita: 'LO QUE EL SISTEMA NECESITA DE TI', mal: 'LO QUE ESTÁ MAL', falta: 'LO QUE FALTA' };
    for (const [rfc, delGrupo] of grupos) {
      const graves = delGrupo.filter(aviso => aviso.severidad === 'alta');
      const lastDay = getState('avisos:digest-day:' + (rfc || 'instalacion'));
      let incluir = null;
      if (config.correo === 'diario' && lastDay !== day(time)) incluir = delGrupo;
      else if (config.correo === 'semanal' && mx.weekday === 1 && lastDay !== day(time)) incluir = delGrupo;
      else if (config.correo === 'graves' && graves.length) incluir = graves;
      if (!incluir || !incluir.length) continue;
      const lines = ['Resumen de avisos de PacoSAT · ' + (rfc ? 'RFC ' + rfc + ' · ' : '') + day(time), '',
        'Tienes ' + incluir.length + ' aviso(s) ' + (rfc ? 'de este contribuyente ' : 'de la instalación ') +
        'esperando en el Centro de Avisos de la app.', ''];
      for (const clase of ['necesita', 'mal', 'falta']) {
        const deClase = incluir.filter(aviso => aviso.clase === clase);
        if (!deClase.length) continue;
        lines.push(claseNombre[clase] + ' (' + deClase.length + '):');
        for (const aviso of deClase.slice(0, 15)) {
          lines.push('· ' + aviso.titulo + (aviso.importe ? ' — $' + importeShow(aviso.importe) : '') +
            (aviso.estado === 'por-confirmar' ? ' (por confirmar)' : ''));
          if (aviso.detalle) lines.push('  ' + String(aviso.detalle).slice(0, 220));
        }
        if (deClase.length > 15) lines.push('· …y ' + (deClase.length - 15) + ' más en el panel.');
        lines.push('');
      }
      lines.push('Todo se ve y se solventa dentro de PacoSAT, en la pantalla Avisos. Este correo es solo el resumen de ' +
        (rfc || 'la instalación') + '.');
      try {
        await active.transport.sendMail({ from: displayFrom(active.from), to: active.recipient,
          subject: 'PacoSAT · ' + (rfc ? rfc + ' · ' : '') + 'Resumen de avisos: ' + incluir.length + ' necesitan tu atención',
          text: lines.join('\n'),
          messageId: '<pacosat-resumen-' + day(time) + '-' + (rfc || 'instalacion') + '-' + active.instance + '@pacosat.local>' });
        const mark = db.prepare('UPDATE avisos SET correo=1 WHERE id=?');
        for (const aviso of incluir) mark.run(aviso.id);
        setState('avisos:digest-day:' + (rfc || 'instalacion'), day(time));
        db.prepare('INSERT INTO mail_sends(at,recipients,subject,kind,ok,error,rfc) VALUES (?,?,?,?,1,\'\',?)')
          .run(now(), active.recipient, 'Resumen de avisos ' + (rfc || 'instalación') + ' (' + incluir.length + ')', 'avisos-resumen', rfc || '');
      } catch { /* sin envío: los avisos de este grupo quedan sin marcar y su resumen se reintenta en el siguiente ciclo */ }
    }
  }
  /* Aviso de silencio (1.6.10): si el umbral configurable está activo y
     un RFC lleva más días que el umbral sin CFDI recibidos nuevos, se
     avisa una sola vez por episodio (la referencia incluye la fecha del
     último CFDI: cuando llega uno nuevo, el episodio se reinicia). */
  function checkSilence(time) {
    const threshold = Number(getSetting('silenceDays') || 0);
    if (!threshold) return;
    if (getState('silence:day') === day(time)) return;
    setState('silence:day', day(time));
    for (const profile of db.prepare('SELECT * FROM profiles').all()) {
      if (profilePaused(profile, time)) continue;
      const last = Number(getState('news:last:' + profile.rfc) || 0) ||
        db.prepare("SELECT MAX(created) AS last FROM jobs WHERE rfc=? AND status='finished'").get(profile.rfc)?.last || time;
      if (time - last <= threshold * DAY) continue;
      queueAlert('silence', 'silence:' + profile.rfc + ':' + last,
        'PacoSAT · Silencio de CFDI en ' + profile.rfc,
        'El RFC ' + profile.rfc + ' lleva ' + Math.floor((time - last) / DAY) + ' días sin CFDI recibidos nuevos y tu umbral de aviso es de ' +
        threshold + ' días. Puede ser normal (sin operaciones) o la señal de una factura esperada que no llegó: revísalo en el Centro SAT.', time, profile.rfc);
    }
  }

  /* ===== Listas negras vivas (1.6.13) =====
     Descarga diaria de los listados oficiales con URL, importación
     manual para los que no la tienen, cruce continuo contra el padrón
     de contrapartes (del CFDI y manual) y aviso ante CUALQUIER cambio:
     altas, bajas, cambios de situación y la línea base de la primera
     carga. Las entradas son datos públicos: no viajan en respaldos. */
  let listsBusy = false;
  /* Progreso medible y cancelación cooperativa (1.13.1, piezas E/F):
     la actualización de listados enseña su fase («Descargando…»,
     «Cruzando con tu padrón»), cuántos listados lleva de cuántos y
     desde cuándo; y puede cancelarse: la bandera se consulta en los
     puntos seguros (tras descargar y parsear cada listado, ANTES
     de aplicar su tx) — lo parcial se descarta y la copia anterior
     sigue vigente. La cancelación queda registrada con su hora. */
  let listsCancelRequested = false;
  let listsProgress = { running: false, phase: '', done: 0, total: 0, startedAt: 0, cancelled: false };
  /* ===== Registro único de trabajos (1.18.0, Ronda Facilidad) =====
     «Que se vea lo que hace el sistema siempre» y «detener o
     reanudar operaciones»: cada trabajo con motor propio vive en
     un estado con nombre (en curso / pausado / terminado) y la
     vista /api/activity los reúne a todos — los de motor propio
     (este barrido, listados, documentos, CIEC) y los que ya son
     del SAT (solicitudes masivas: se pueden retener, no parar) o
     del calendario (la descarga automática mensual, con su held).
     El barrido de Vigilancia deja de encadenarse desde el cliente
     (una cadena de llamadas que moría al cerrar la pestaña) y pasa
     a ser un trabajo del servidor: un bucle propio que procesa
     tandas con la MISMA función de producción (monitor.processNow)
     y se detiene entre tandas — el punto seguro — si se pausa o
     se detiene. Lo ya revisado queda guardado por la propia tanda;
     reanudar sigue con los pendientes que queden, sin repetir ni
     duplicar un solo CFDI. El último resultado se persiste en
     ajustes ('sweep-last') para que la pantalla lo enseñe tras
     recargar, con la misma regla de los resúmenes persistidos. */
  let sweepState = { running: false, paused: false, total: 0, done: 0, remaining: 0, startedAt: 0, finishedAt: 0 };
  const sweepLast = () => { try { return JSON.parse(getState('sweep-last') || 'null'); } catch { return null; } };
  /* R5 (1.22.0) — nadie vigilaba al vigilante: si la vigilancia
     lleva días sin completar una vuelta (sin que cfdi_watch quede
     a cero pendientes), el silencio se leía como «todo vigente».
     Ahora: la vuelta completa se fecha cuando los pendientes
     llegan a cero, y a los 3 días sin vuelta habiendo pendientes
     sale UN aviso por semana, con la fecha de la última vuelta. */
  function watchStaleTick(time) {
    const total = db.prepare('SELECT COUNT(*) AS n FROM cfdi_watch').get().n;
    if (!total) return;
    const pending = db.prepare('SELECT COUNT(*) AS n FROM cfdi_watch WHERE result IS NULL').get().n;
    if (!pending) { setState('monitor:last-full-sweep', String(time)); return; }
    const lastFull = Number(getState('monitor:last-full-sweep') || 0);
    if (lastFull && time - lastFull > 3 * DAY)
      queueAlert('watch-stale', 'watch-stale:' + Math.floor(time / (7 * DAY)),
        'PacoSAT · La vigilancia del SAT lleva días sin completar una vuelta',
        'La última vuelta completa de la vigilancia fue el ' + day(lastFull) + ' y aún quedan ' + pending +
        ' comprobantes por revisar. Los estados que ves pueden estar viejos: no es que todo esté vigente, es que ' +
        'la revisión no ha terminado de dar la vuelta. Se sigue intentando sola en cada ciclo; si el atasco persiste, ' +
        'revisa el Centro SAT (puede ser el portal o el descanso de solicitudes).', time);
  }
  async function sweepLoop() {
    while (sweepState.running) {
      if (sweepState.paused) { await new Promise(resolve => setTimeout(resolve, 700)); continue; }
      let batch;
      try { batch = await monitor.processNow(10); }
      catch { batch = { processed: 0, remaining: sweepState.remaining, busy: false }; }
      if (batch.busy) { await new Promise(resolve => setTimeout(resolve, 700)); continue; }
      sweepState.done += batch.processed || 0;
      sweepState.remaining = batch.remaining ?? sweepState.remaining;
      if (!batch.processed && !sweepState.remaining) {
        sweepState.running = false;
        sweepState.finishedAt = now();
        setState('sweep-last', JSON.stringify({ at: sweepState.finishedAt, done: sweepState.done,
          total: sweepState.total, stopped: false }));
        /* R5 (1.22.0): una vuelta completa de la vigilancia queda
           fechada — es el dato que permite vigilar al vigilante. */
        setState('monitor:last-full-sweep', String(sweepState.finishedAt));
        putMetadata('activity', { id: 'sweep:' + sweepState.finishedAt, name: 'Revisión de comprobantes en el SAT',
          date: new Date(sweepState.finishedAt).toISOString(), added: 0, duplicates: 0, review: 0, issues: [],
          event: 'Revisión terminada: ' + sweepState.done + ' comprobantes revisados.' });
      }
      if (sweepState.running) await new Promise(resolve => setTimeout(resolve, 120));
    }
  }
  function sweepStart(queued) {
    if (sweepState.running) return sweepState;
    const pending = db.prepare('SELECT COUNT(*) AS total FROM cfdi_watch WHERE result IS NULL').get().total;
    sweepState = { running: true, paused: false, total: Math.max(queued, pending), done: 0,
      remaining: pending, startedAt: now(), finishedAt: 0 };
    sweepLoop().catch(() => { sweepState.running = false; });
    return sweepState;
  }
  /* La vista del registro: trabajos en curso o pausados con sus
     gestos honestos, lo reciente del diario de actividad y la
     próxima acción automática conocida. */
  function activityOverview(time) {
    const running = [], paused = [];
    if (sweepState.running) {
      (sweepState.paused ? paused : running).push({ kind: 'barrido', key: 'barrido', label: 'Revisión de comprobantes en el SAT',
        detail: sweepState.done + ' de ' + sweepState.total + ' revisados', done: sweepState.done, total: sweepState.total,
        since: sweepState.startedAt, state: sweepState.paused ? 'pausado' : 'curso',
        canPause: !sweepState.paused, canResume: sweepState.paused, canStop: true });
    }
    if (listsProgress.running) {
      running.push({ kind: 'listados', key: 'listados', label: 'Actualización de listados del SAT',
        detail: listsProgress.phase || 'Actualizando…', done: listsProgress.done, total: listsProgress.total,
        since: listsProgress.startedAt, state: 'curso', canPause: false, canResume: false, canStop: true,
        note: 'Se detiene en el punto seguro y lo parcial se descarta.' });
    }
    try {
      const docsState = satDocsState();
      for (const [rfc, item] of Object.entries(docsState))
        if (item?.progress?.running) running.push({ kind: 'documentos', key: 'documentos:' + rfc,
          label: 'Descarga de documento del SAT · ' + rfc, detail: item.progress.step || 'Descargando…',
          done: 0, total: 0, since: item.progress.at || time, state: 'curso',
          canPause: false, canResume: false, canStop: true, stopKind: item.progress.kind || '',
          note: 'Su Cancelar (en la tarjeta del documento o aquí) la detiene en el servidor y descarta lo parcial.' });
    } catch { /* sin estado de documentos */ }
    try {
      const cState = ciecState();
      for (const [rfc, item] of Object.entries(cState)) {
        if (item?.captcha) paused.push({ kind: 'ciec', key: 'ciec:' + rfc, label: 'Descarga por CIEC · ' + rfc,
          detail: 'Esperando el captcha que solo tú puedes teclear', done: 0, total: 0,
          since: item.captcha.since || time, state: 'esperando', canPause: false, canResume: false, canStop: false,
          note: 'Está pausada en tu gesto: se reanuda sola cuando respondas el captcha.' });
        else if (item?.progress?.running) running.push({ kind: 'ciec', key: 'ciec:' + rfc,
          label: 'Descarga por CIEC · ' + rfc, detail: item.progress.step || 'Descargando…', done: 0, total: 0,
          since: item.progress.at || time, state: 'curso', canPause: false, canResume: false, canStop: false,
          note: 'Termina su paso actual; no se puede parar a mitad.' });
      }
    } catch { /* sin estado CIEC */ }
    const heldJobs = db.prepare("SELECT id,rfc,direction,kind,periodStart,periodEnd FROM jobs WHERE status='pending' AND held=1 ORDER BY id").all();
    for (const job of heldJobs)
      paused.push({ kind: 'masiva', key: 'masiva:' + job.id, label: 'Solicitud al SAT retenida · ' + job.rfc,
        detail: (job.direction === 'received' ? 'Recibidos' : 'Emitidos') + ' ' + job.periodStart + ' a ' + job.periodEnd +
          ' — PacoSAT no la está sondeando', done: 0, total: 0, since: time, state: 'pausado',
        canPause: false, canResume: true, canStop: false, jobId: job.id,
        note: 'La solicitud ya es del SAT: no se puede retirar, pero sí dejar de insistir.' });
    const liveJobs = db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status='pending' AND held=0").get().n;
    if (liveJobs) running.push({ kind: 'masiva', key: 'masiva', label: 'Solicitudes de descarga en el SAT',
      detail: liveJobs + ' en curso: el SAT las prepara y PacoSAT las recoge solo', done: 0, total: 0,
      since: time, state: 'curso', canPause: false, canResume: false, canStop: false,
      note: 'Cada solicitud se puede retener desde Vigilancia › Descargas.' });
    try {
      const mState = monthlyState();
      for (const run of Object.values(mState.runs || {}))
        if (run.status === 'en-curso') (run.held ? paused : running).push({ kind: 'mensual', key: 'mensual:' + run.month,
          label: 'Descarga automática de ' + monthLabel(run.month), detail: monthlySummaryLine(run),
          done: 0, total: 0, since: run.startedAt, state: run.held ? 'pausado' : 'curso',
          canPause: !run.held, canResume: Boolean(run.held), canStop: false, month: run.month });
    } catch { /* sin corridas mensuales */ }
    let recent = [];
    try {
      recent = db.prepare("SELECT value FROM records WHERE store='activity' ORDER BY rowid DESC LIMIT 40").all()
        .map(row => { try { return JSON.parse(row.value); } catch { return null; } }).filter(Boolean)
        .sort((a, b) => String(b.date || '').localeCompare(String(a.date || ''))).slice(0, 12)
        .map(item => ({ at: item.date || '', name: item.name || '', event: item.event || '',
          added: item.added || 0, duplicates: item.duplicates || 0, review: item.review || 0 }));
    } catch { /* sin diario */ }
    const nextWatch = db.prepare('SELECT MIN(next) AS next FROM cfdi_watch WHERE result IS NULL AND next>0').get()?.next || 0;
    return { running, paused, recent,
      nextAuto: nextWatch ? { label: 'próxima revisión automática', at: nextWatch } : null,
      resting: resting(time), serverTime: time };
  }
  /* ===== Trabajos del SAT (1.22.0, pieza 14): UNA lectura
     unificada de los registros reales de TODAS las corridas —
     documentos, declaraciones, trabajos CFDI (masiva y
     recuperaciones), mensual y CIEC — con su estado verdadero y
     su causa probada. No es otro motor: ordena lo que las tablas
     ya guardan y enlaza a cada detalle/diario. ===== */
  function satTrabajos(time) {
    const rows = [];
    try {
      const docsState = satDocsState();
      for (const [rfc, item] of Object.entries(docsState))
        if (item?.progress?.running) rows.push({ id: 'doc-live:' + rfc + ':' + (item.progress.kind || ''),
          clase: 'documento', titulo: (DOC_KIND_LABEL[item.progress.kind] || 'Documento') + ' · ' + rfc,
          estado: 'en-curso', at: item.progress.at || time, fin: 0, causa: item.progress.step || '',
          enlace: 'satdocs', cancelar: { tipo: 'satdoc', rfc, kind: item.progress.kind || '' } });
    } catch { /* sin estado */ }
    for (const run of db.prepare('SELECT * FROM sat_doc_runs ORDER BY started DESC LIMIT 30').all())
      rows.push({ id: 'doc:' + run.id, clase: 'documento',
        titulo: (DOC_KIND_LABEL[run.kind] || run.kind) + ' · ' + run.rfc,
        estado: run.ok ? 'terminada' : run.errorKind === 'cancelada' ? 'cancelada'
          : run.errorKind === 'interrumpida' ? 'interrumpida' : 'fallida',
        at: run.started, fin: run.finished, causa: run.ok ? '' : (run.error || ''),
        enlace: 'satdocs' });
    try {
      const dState = declState();
      for (const [rfc, progress] of Object.entries(dState))
        if (progress) rows.push({ id: 'decl-live:' + rfc, clase: 'declaraciones',
          titulo: 'Declaraciones ' + (progress.tipo || '') + ' ' + (progress.ejercicio || '') + ' · ' + rfc,
          estado: progress.running ? 'en-curso' : progress.ok ? 'terminada' : 'fallida',
          at: progress.at || time, fin: 0, causa: progress.running || progress.ok ? '' : (progress.step || ''),
          enlace: 'declaraciones', ...(progress.running ? { cancelar: { tipo: 'decl', rfc } } : {}) });
    } catch { /* sin estado */ }
    for (const row of db.prepare("SELECT error,errorKind,created,rfc,tipo,ejercicio FROM declaraciones WHERE error<>'' ORDER BY created DESC LIMIT 10").all())
      rows.push({ id: 'decl-err:' + row.created + ':' + row.rfc, clase: 'declaraciones',
        titulo: 'Declaraciones ' + row.tipo + ' ' + row.ejercicio + ' · ' + row.rfc,
        estado: row.errorKind === 'cancelada' ? 'cancelada' : 'fallida',
        at: row.created, fin: row.created, causa: row.error, enlace: 'declaraciones' });
    for (const job of db.prepare('SELECT * FROM jobs ORDER BY created DESC LIMIT 30').all()) {
      const origin = jobOrigin(job);
      rows.push({ id: 'job:' + job.id, clase: origin === 'recovery' ? 'recuperacion' : 'masiva',
        titulo: 'Paquetes ' + (job.direction === 'received' ? 'recibidos' : 'emitidos') + ' ' +
          job.periodStart + ' → ' + job.periodEnd + ' · ' + job.rfc,
        estado: job.status === 'pending' ? (job.held ? 'pausada' : 'en-curso')
          : job.status === 'finished' ? 'terminada' : job.status === 'cancelled' ? 'cancelada' : 'fallida',
        at: job.created, fin: job.finished || 0,
        causa: job.status === 'finished' ? (job.note || '') : (job.error || ''),
        enlace: 'vigilancia',
        ...(job.status === 'pending' ? { cancelar: { tipo: 'job', id: job.id } } : {}) });
    }
    try {
      const mState = monthlyState();
      for (const run of Object.values(mState.runs || {}))
        rows.push({ id: 'mensual:' + run.month + ':' + run.startedAt, clase: 'mensual',
          titulo: 'Descarga mensual de ' + monthLabel(run.month),
          estado: run.status === 'en-curso' ? (run.held ? 'pausada' : 'en-curso')
            : run.status === 'hecha' ? 'terminada' : run.status === 'fallida' ? 'fallida' : 'terminada',
          at: run.startedAt || time, fin: run.finishedAt || 0,
          causa: run.status === 'en-curso' ? monthlySummaryLine(run) : (run.error || monthlySummaryLine(run)),
          enlace: 'mensual' });
    } catch { /* sin mensual */ }
    for (const run of db.prepare('SELECT * FROM ciec_runs ORDER BY started DESC LIMIT 10').all())
      rows.push({ id: 'ciec:' + run.id, clase: 'ciec', titulo: 'Descarga por CIEC · ' + run.rfc,
        estado: run.ok ? 'terminada' : 'fallida', at: run.started, fin: run.finished,
        causa: run.ok ? '' : (run.error || ''), enlace: 'ciec' });
    rows.sort((a, b) => (b.at || 0) - (a.at || 0));
    return rows.slice(0, 60);
  }
  /* ===== Sonda del portal (1.22.0, pieza 13): una vez al día,
     SIN credenciales, se leen las páginas PÚBLICAS de acceso de
     los dos trámites de documentos y se guarda la huella de su
     estructura (ids, formularios, título). Si la huella cambia,
     el Centro de Avisos y el diario lo cuentan ANTES de que una
     descarga se estrelle contra una pantalla nueva. ===== */
  function portalFingerprint(html) {
    const text = String(html || '');
    const ids = [...text.matchAll(/ id="([^"]+)"/g)].map(m => m[1]);
    const forms = [...text.matchAll(/<form[^>]* action="([^"]*)"/g)].map(m => m[1]);
    const title = (text.match(/<title>([^<]*)<\/title>/i) || [])[1] || '';
    return createHash('sha256').update(JSON.stringify(
      { ids: [...new Set(ids)].sort(), forms: [...new Set(forms)].sort(), title })).digest('hex').slice(0, 16);
  }
  /* Núcleo de la sonda (1.25.0, mejora nº 8): lee las páginas
     públicas y compara huellas; lo usan el tick diario y el
     arranque de la corrida mensual (salud predictiva: el cambio
     se sabe ANTES de la descarga, no cuando esta se estrella).
     Devuelve los trámites cuya pantalla cambió en esta pasada. */
  async function portalProbeRun(time) {
    const dayKey = new Date(time).toISOString().slice(0, 10);
    const fetcher = portalProbeFetch || (async url => {
      const response = await fetch(url, { redirect: 'follow' });
      return await response.text();
    });
    const cambios = [];
    for (const [which, url] of [['constancia', CSF_ENTRY_URL], ['opinion', OPINION_ENTRY_URL]]) {
      let html = '';
      try { html = await fetcher(url); } catch { continue; }
      if (!html) continue;
      const fp = portalFingerprint(html);
      const prev = getSetting('probe:fp:' + which);
      if (!prev) { setSetting('probe:fp:' + which, fp); setSetting('probe:buena:' + which, fp); continue; }
      setSetting('probe:fp:' + which, fp);
      /* La referencia es la huella CONOCIDA («buena»), no la
         última vista: si la referencia fuera la última, la
         segunda pasada sobre la pantalla ya cambiada la tomaría
         por normal y el aviso se apagaría solo — la sonda corre
         dos veces el día de la corrida (tick diario y arranque
         de la mensual) y el cambio debe SEGUIR marcado hasta que
         la pantalla vuelva a la conocida o Paco cierre el aviso
         (cerrarlo acepta la pantalla nueva como la conocida). */
      const buena = getSetting('probe:buena:' + which) || prev;
      if (fp === buena) {
        if (getSetting('probe:cambio:' + which)) {
          setSetting('probe:cambio:' + which, '');
          avisoSolve('portal-probe:' + which, 'La pantalla volvió a la estructura conocida.', time);
        }
        continue;
      }
      const avisoRow = db.prepare('SELECT estado FROM avisos WHERE ref=?').get('portal-probe:' + which);
      const yaAvisado = Boolean(getSetting('probe:cambio:' + which));
      if (yaAvisado && avisoRow && (avisoRow.estado === 'solventado' || avisoRow.estado === 'descartado')) {
        setSetting('probe:buena:' + which, fp);
        setSetting('probe:cambio:' + which, '');
        continue;
      }
      if (!yaAvisado) {
        setSetting('probe:cambio:' + which, String(time));
        cambios.push(which);
        avisoEnsure({ ref: 'portal-probe:' + which, kind: 'sistema', clase: 'necesita', estado: 'pendiente',
          severidad: 'media', titulo: 'El portal del SAT cambió su pantalla de acceso (' + which + ')',
          detalle: 'La sonda (sin credenciales, solo la página pública) detectó que la pantalla de acceso de ' +
            which + ' ya no tiene la estructura conocida (' + buena + ' → ' + fp + '). El aviso llega ANTES de la ' +
            'próxima corrida: la descarga entra avisada y, si el flujo no reconoce la pantalla nueva, su diario ' +
            'traerá la página para adaptarlo.',
          rfc: '', accion: 'Nada por tu parte: es un aviso preventivo.' }, time, false);
        putMetadata('activity', { id: 'probe:' + which + ':' + dayKey, name: 'Sonda del portal del SAT',
          date: new Date(time).toISOString(), added: 0, duplicates: 0, review: 1,
          issues: [{ name: 'Portal del SAT', reason: 'La pantalla de acceso de ' + which + ' cambió.' }],
          event: 'El portal cambió su pantalla de acceso (' + which + '): huella ' + buena + ' → ' + fp + '.' });
      }
    }
    setSetting('probe:ultima', String(time));
    return cambios;
  }
  async function portalProbeTick(time) {
    const dayKey = new Date(time).toISOString().slice(0, 10);
    if (getSetting('probe:day') === dayKey) return;
    setSetting('probe:day', dayKey);
    await portalProbeRun(time);
  }
  /* Salud del portal para Hoy y para el Centro SAT: última sonda
     y qué pantallas constan cambiadas desde cuándo. */
  function portalSalud() {
    const uno = which => ({ cambio: Boolean(getSetting('probe:cambio:' + which)),
      desde: Number(getSetting('probe:cambio:' + which) || 0) || null });
    return { ultima: Number(getSetting('probe:ultima') || 0) || null,
      constancia: uno('constancia'), opinion: uno('opinion') };
  }
  /* ===== Cierre al arranque (1.22.0, pieza 15/R1): una corrida
     de documentos o declaraciones que figura «en curso» en el
     estado persistido pero no tiene proceso vivo en ESTE arranque
     (el contenedor reinició a mitad — incluido el despliegue de
     esta misma versión) se cierra como «interrumpida por
     reinicio», con su último paso y su hora. La mensual ya se
     reconstruye sola: no se toca. ===== */
  function reconcileOrphanRuns(time) {
    try {
      const state = satDocsState();
      let changed = false;
      for (const [rfc, item] of Object.entries(state)) {
        const progress = item?.progress;
        if (!progress?.running) continue;
        if (satDocLive.has(rfc + ':' + progress.kind)) continue;
        const text = 'Corrida interrumpida por un reinicio del servidor: quedó en el paso «' +
          (progress.step || 'sin paso registrado') + '» a las ' + stampText(progress.at || time) +
          '. El documento no se archivó en esa corrida; tu último documento bueno sigue intacto. Reinténtala desde su tarjeta.';
        item.progress = { ...progress, running: false, ok: false, interrupted: true, step: text, at: time };
        saveSatDocRun(rfc, progress.kind || 'constancia', progress.at || time, time, false,
          text, progress.steps || [], null, 'interrumpida');
        changed = true;
      }
      if (changed) saveSatDocsState(state);
    } catch { /* el arranque no muere por reconciliar */ }
    try {
      const dState = declState();
      let changed = false;
      for (const [rfc, progress] of Object.entries(dState)) {
        if (!progress?.running) continue;
        if ([...declLive.keys()].some(key => key.startsWith(rfc + ':'))) continue;
        dState[rfc] = { ...progress, running: false, ok: false,
          step: 'Recuperación interrumpida por un reinicio del servidor: no se archivó nada en esa corrida. Reinténtala desde el panel.' };
        changed = true;
      }
      if (changed) saveDeclState(dState);
    } catch { /* idem */ }
  }
  const listMeta = listId => db.prepare('SELECT * FROM blacklist_meta WHERE listId=?').get(listId) ||
    { listId, fetched: null, next: 0, count: 0, declared: '', error: '' };
  function counterpartRfcs() {
    const set = new Set(db.prepare('SELECT rfc FROM counterparts').all().map(row => row.rfc));
    for (const profile of db.prepare('SELECT rfc FROM profiles').all()) set.add(profile.rfc);
    try {
      for (const row of db.prepare("SELECT value FROM records WHERE store='invoices'").all()) {
        const invoice = JSON.parse(row.value);
        if (invoice?.from?.rfc) set.add(invoice.from.rfc);
        if (invoice?.to?.rfc) set.add(invoice.to.rfc);
      }
    } catch { /* sin expedientes todavía */ }
    return set;
  }
  function recordListEvent(time, source, rfc, change, detail) {
    db.prepare('INSERT INTO list_events(at,listId,rfc,change,detail) VALUES (?,?,?,?,?)')
      .run(time, source.id, rfc, change, detail);
  }
  function alertListChange(time, source, rfc, change, detail) {
    queueAlert('list-transition', 'list:' + source.id + ':' + rfc + ':' + change + ':' + detail,
      'PacoSAT · Listas negras: ' + change + ' en ' + source.label,
      'La contraparte ' + rfc + ' registró un cambio en el listado «' + source.label + '»: ' + change +
      (detail ? ' (' + detail + ')' : '') + '. Revisa el panel de Listas negras para ver su exposición.', time, rfc);
  }
  async function refreshList(source, time, fetcher) {
    let content;
    if (fetcher) content = await fetcher(source);
    else {
      /* Los CDN oficiales (Akamai) rechazan la petición «pelada» de un
         servidor con HTTP 403; con las cabeceras de un navegador normal
         la descarga pasa (verificado el 9 nov 2026: datos.gob.mx llega
         al origen y repodatos.atdt.gob.mx entrega los CSV del Art. 69). */
      const response = await fetch(source.url, { redirect: 'follow', signal: AbortSignal.timeout(90000),
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          'Accept': 'text/csv,text/html,application/xhtml+xml,application/octet-stream;q=0.8,*/*;q=0.7',
          'Accept-Language': 'es-MX,es;q=0.9,en;q=0.8',
          'Referer': 'https://www.datos.gob.mx/',
          'sec-ch-ua': '"Chromium";v="131", "Google Chrome";v="131", "Not-A.Brand";v="99"',
          'sec-ch-ua-mobile': '?0', 'sec-ch-ua-platform': '"Windows"',
          'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'cross-site'
        } });
      if (!response.ok) throw new Error('La fuente oficial respondió HTTP ' + response.status + '.');
      const raw = Buffer.from(await response.arrayBuffer());
      if (raw.length > 64 * 1024 * 1024) throw new Error('El listado supera el tamaño permitido.');
      try { content = new TextDecoder('utf-8', { fatal: true }).decode(raw); }
      catch { content = new TextDecoder('windows-1252').decode(raw); }
    }
    const entries = parseList(content, source);
    /* Punto seguro de cancelación (1.13.1, pieza F): el listado ya
       se descargó y se parseó, pero AÚN no se aplicó nada — si se
       pidió cancelar, lo parcial se descarta entero y la copia
       anterior sigue vigente, sin tocar meta ni entradas. */
    if (listsCancelRequested) return 'cancelled';
    listsProgress.phase = 'Cruzando el listado ' + source.label + ' con tu padrón (' + entries.size.toLocaleString('es-MX') + ' registros)';
    const declared = declaredDate(content);
    const meta = listMeta(source.id);
    const baseline = !meta.fetched;
    const watched = counterpartRfcs();
    const changes = [];
    tx(db, () => {
      const before = new Map(db.prepare('SELECT rfc,detail FROM blacklist_entries WHERE listId=?').all(source.id)
        .map(row => [row.rfc, row.detail]));
      for (const rfc of watched) {
        const was = before.get(rfc), is = entries.get(rfc)?.detail;
        if (was === is) continue;
        const change = baseline && is ? ['Línea base: ya constaba', is] :
          !was && is ? ['Alta nueva', is] :
          was && !is ? ['Baja: ya no consta', was] :
          ['Cambio de situación', was + ' → ' + is];
        recordListEvent(time, source, rfc, change[0], change[1]);
        changes.push([rfc, change[0], change[1]]);
      }
      db.prepare('DELETE FROM blacklist_entries WHERE listId=?').run(source.id);
      const insert = db.prepare('INSERT INTO blacklist_entries(listId,rfc,name,detail) VALUES (?,?,?,?)');
      for (const [rfc, entry] of entries) insert.run(source.id, rfc, entry.name, entry.detail);
      db.prepare('INSERT INTO blacklist_meta(listId,fetched,next,count,declared,error) VALUES (?,?,?,?,?,?) ' +
        'ON CONFLICT(listId) DO UPDATE SET fetched=excluded.fetched,next=excluded.next,count=excluded.count,declared=excluded.declared,error=\'\'')
        .run(source.id, time, time + DAY, entries.size, declared, '');
    });
    /* Avisos: hasta 5 cambios, uno por contraparte; si son más, un
       solo correo resumen (la línea base de un padrón grande no debe
       convertirse en 50 correos). El detalle queda en list_events. */
    if (changes.length <= 5) for (const [rfc, change, detail] of changes) alertListChange(time, source, rfc, change, detail);
    else queueAlert('list-transition', 'list:' + source.id + ':resumen:' + time,
      'PacoSAT · Listas negras: ' + changes.length + ' cambios en ' + source.label,
      'La actualización del listado «' + source.label + '» trajo ' + changes.length + ' cambios en tus contrapartes ' +
      '(' + changes.slice(0, 8).map(([rfc, change]) => rfc + ': ' + change).join('; ') + (changes.length > 8 ? '; …' : '') +
      '). El detalle completo está en el panel de Listas negras.', time);
    return entries.size;
  }
  async function listsTick(time, fetcher) {
    /* Sin fetcher inyectado (pruebas) y sin la autorización expresa de
       la entrada de producción (officialLists), el ciclo NO sale a la
       red: ninguna prueba descarga listados reales jamás. */
    if (!fetcher && !officialLists) return { cancelled: false };
    if (listsBusy) return { cancelled: false };
    listsBusy = true;
    listsCancelRequested = false;
    const dueSources = LIST_CATALOG.filter(source => source.url && time >= listMeta(source.id).next);
    listsProgress = { running: true, phase: 'Preparando la actualización de listados', done: 0,
      total: dueSources.length, startedAt: time, cancelled: false };
    let cancelled = false;
    try {
      for (const source of LIST_CATALOG) {
        if (!source.url) continue;
        const meta = listMeta(source.id);
        if (time < meta.next) continue;
        if (listsCancelRequested) { cancelled = true; break; }
        listsProgress.phase = 'Descargando el listado ' + source.label;
        try {
          const result = await refreshList(source, time, fetcher);
          if (result === 'cancelled') { cancelled = true; break; }
        }
        catch (error) {
          db.prepare('INSERT INTO blacklist_meta(listId,fetched,next,count,declared,error) VALUES (?,?,?,?,?,?) ' +
            'ON CONFLICT(listId) DO UPDATE SET next=excluded.next,error=excluded.error')
            .run(source.id, meta.fetched, time + HOUR_MS, meta.count, meta.declared, message(error));
        }
        listsProgress.done++;
        listsProgress.phase = 'Cruzando con tu padrón: ' + source.label;
        if (listsCancelRequested) { cancelled = true; break; }
      }
      /* Lista rancia: más de 48 h sin una descarga buena de un listado
         con URL (o con datos cargados a mano) → aviso una vez al día. */
      for (const source of LIST_CATALOG) {
        const meta = listMeta(source.id);
        if (!meta.fetched || time - meta.fetched <= 2 * DAY) continue;
        const ref = 'stale:' + source.id + ':' + Math.floor(time / DAY);
        queueAlert('list-stale', ref, 'PacoSAT · Un listado oficial lleva más de 48 h sin actualizar',
          'El listado «' + source.label + '» no se actualiza desde ' + day(meta.fetched) +
          '. PacoSAT lo sigue intentando; si la fuente oficial no responde, la vigilancia trabaja con datos viejos.', time);
      }
    } finally {
      listsBusy = false;
      listsProgress.running = false;
      listsProgress.phase = cancelled ? 'Cancelado por ti' : 'Actualización terminada';
      listsProgress.cancelled = cancelled;
      if (cancelled) setState('lists:lastCancel', String(time));
    }
    return { cancelled };
  }
  function listsOverview() {
    const sources = LIST_CATALOG.map(source => {
      const meta = listMeta(source.id);
      return { id: source.id, label: source.label, url: source.url, manual: !source.url,
        fetched: meta.fetched, count: meta.count, declared: meta.declared, error: meta.error };
    });
    /* Exposición y presencia por contraparte desde el expediente.
       1.13.1: además del total recibido de siempre, se calculan las
       cifras que la pantalla de Listas enseña dentro de la tarjeta —
       por dirección (recibidos de un proveedor / emitidos a un
       cliente): número de CFDI, importe total y primera y última
       fecha — para que «qué significa» venga con el dinero que hay
       de por medio, no solo con el nombre del listado. */
    const exposure = new Map();
    const newStat = () => ({ count: 0, cents: 0n, primera: '', ultima: '' });
    try {
      for (const row of db.prepare("SELECT value FROM records WHERE store='invoices'").all()) {
        const invoice = JSON.parse(row.value);
        for (const [rfc, role] of [[invoice?.from?.rfc, 'emitter'], [invoice?.to?.rfc, 'receiver']]) {
          if (!rfc) continue;
          if (!exposure.has(rfc)) exposure.set(rfc, { name: '', receivedCents: 0n, receivedCount: 0, issuedCount: 0,
            receivedStat: newStat(), issuedStat: newStat() });
          const item = exposure.get(rfc);
          const name = role === 'emitter' ? invoice.from?.name : invoice.to?.name;
          if (name && !item.name) item.name = name;
          const stat = role === 'emitter' ? item.receivedStat : item.issuedStat;
          stat.count++;
          if (!invoice.currency || invoice.currency === 'MXN') stat.cents += centsOf(invoice.total);
          const fecha = String(invoice.date || '').slice(0, 10);
          if (/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
            if (!stat.primera || fecha < stat.primera) stat.primera = fecha;
            if (!stat.ultima || fecha > stat.ultima) stat.ultima = fecha;
          }
          if (role === 'emitter') { item.receivedCount++; item.receivedCents = item.receivedStat.cents; }
          else item.issuedCount++;
        }
      }
    } catch { /* sin expedientes todavía */ }
    /* Saldo vivo por cobrar por cliente (1.13.1): el mismo cálculo
       de Dinero (moneyBalances: PUE cuenta pagada; PPD, lo cobrado
       por los complementos y por las marcas a mano). Solo saldos
       positivos de facturas emitidas desde un RFC propio. */
    const saldoPorRfc = new Map();
    try {
      for (const balance of moneyBalances()) {
        if (!balance.receivable || !(balance.balance > 0n) || balance.cancelled) continue;
        const rfc = balance.to?.rfc;
        if (!rfc) continue;
        const entry = saldoPorRfc.get(rfc) || { cents: 0n, count: 0 };
        entry.cents += balance.balance; entry.count++;
        saldoPorRfc.set(rfc, entry);
      }
    } catch { /* sin expedientes todavía */ }
    const registry = new Map(db.prepare('SELECT * FROM counterparts').all().map(row => [row.rfc, row]));
    const profileRfcs = new Set(db.prepare('SELECT rfc FROM profiles').all().map(row => row.rfc));
    const rfcs = new Set([...registry.keys(), ...exposure.keys(), ...profileRfcs]);
    const entriesByRfc = new Map();
    /* Solo se leen las entradas de las contrapartes (el total de los
       listados suma cientos de miles de filas ajenas). */
    const rfcList = [...rfcs];
    for (let i = 0; i < rfcList.length; i += 400) {
      const chunk = rfcList.slice(i, i + 400);
      for (const entry of db.prepare('SELECT * FROM blacklist_entries WHERE rfc IN (' +
        chunk.map(() => '?').join(',') + ')').all(...chunk)) {
        if (!entriesByRfc.has(entry.rfc)) entriesByRfc.set(entry.rfc, []);
        entriesByRfc.get(entry.rfc).push(entry);
      }
    }
    const counterparts = [...rfcs].map(rfc => {
      const reg = registry.get(rfc), expo = exposure.get(rfc);
      const hits = (entriesByRfc.get(rfc) || []).map(entry => {
        const source = LIST_CATALOG.find(item => item.id === entry.listId);
        return { listId: entry.listId, label: source?.label || entry.listId, detail: entry.detail,
          severity: source ? listSeverity(source, entry.detail) : 'warn' };
      });
      const severity = hits.reduce((worst, hit) =>
        SEVERITY_ORDER[hit.severity] > SEVERITY_ORDER[worst] ? hit.severity : worst, hits.length ? 'ok' : 'none');
      /* Las cifras de la tarjeta (1.13.1): por dirección, con el
         saldo vivo si es cliente. saldoPorCobrar viaja solo cuando
         hay emitidas a ese RFC: null = no aplica; «0.00» = cliente
         sin nada pendiente de cobro. */
      const tramo = stat => stat && stat.count ? { count: stat.count, total: moneyText(stat.cents),
        primera: stat.primera, ultima: stat.ultima } : null;
      const recibidos = tramo(expo?.receivedStat), emitidos = tramo(expo?.issuedStat);
      const saldo = emitidos ? saldoPorRfc.get(rfc) : undefined;
      const detalle = (recibidos || emitidos) ? { recibidos, emitidos,
        saldoPorCobrar: emitidos ? { total: moneyText(saldo?.cents || 0n), facturas: saldo?.count || 0 } : null } : null;
      return { rfc, name: reg?.name || expo?.name || '', kind: reg?.kind ||
          (profileRfcs.has(rfc) ? 'Propio' : expo ? (expo.receivedCount && expo.issuedCount ? 'Ambos' :
            expo.receivedCount ? 'Proveedor' : 'Cliente') : ''),
        note: reg?.note || '', source: reg ? reg.source : (profileRfcs.has(rfc) ? 'perfil' : 'cfdi'),
        payDay: reg?.payDay ?? null, payTerms: reg?.payTerms ?? null,
        hits, severity, detalle, generico: rfc === 'XAXX010101000' || rfc === 'XEXX010101000',
        exposure: expo ? { receivedCount: expo.receivedCount, issuedCount: expo.issuedCount,
          received: (expo.receivedCents / 100n).toString() + '.' + String(expo.receivedCents % 100n).padStart(2, '0') } : null };
    }).sort((a, b) => (SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity]) || a.rfc.localeCompare(b.rfc));
    const events = db.prepare('SELECT * FROM list_events ORDER BY id DESC LIMIT 100').all()
      .map(row => ({ ...row, label: LIST_CATALOG.find(item => item.id === row.listId)?.label || row.listId }));
    /* La última cancelación pedida por Paco, con su hora (pieza F):
       la pantalla la cuenta igual que un éxito o un fallo. */
    return { sources, counterparts, events, lastCancelled: Number(getState('lists:lastCancel') || 0) || null };
  }

  /* Copia externa (Google Drive vía Cloud Sync): si el destino
     secundario está activo y lleva más de 7 días sin una copia buena
     —o nunca la tuvo desde hace más de 7 días—, un aviso por semana.
     La antigüedad también se expone en el resumen para el semáforo de
     Salud. */
  function checkExternalCopyAge(time) {
    if (!backupJob?.secondaryDir) return;
    const lastOk = Number(getState('backup:secondaryOk') || 0);
    const reference = lastOk || startedAt;
    if (time - reference <= 7 * DAY) return;
    queueAlert('backup-external-stale', 'ext-stale:' + Math.floor(time / (7 * DAY)),
      'PacoSAT · La copia externa del respaldo lleva más de 7 días sin renovarse',
      (lastOk ? 'La última copia buena en el destino externo (Google Drive) es del ' + day(lastOk) + '.' :
        'Todavía no consta ninguna copia buena en el destino externo (Google Drive).') +
      ' Revisa que Cloud Sync esté sincronizando la carpeta del respaldo y que el destino secundario siga configurado.', time);
  }

  /* ===== Centro de salidas (1.6.16) =====
     Correo DESDE la app con bitácora, paquete mensual de la contadora
     construido en el servidor, informe automático a Nora, resumen
     semanal de los lunes, exportación completa legible y re-parseo
     del histórico. Todo sale de los datos locales: nada se inventa y
     el desglose fiscal viene del XML guardado. */
  function readFileRecord(id) {
    const row = db.prepare("SELECT value,data,mime FROM records WHERE store='files' AND id=?").get(id);
    if (!row) return null;
    if (row.data) return { buffer: Buffer.from(row.data), mime: row.mime || 'application/octet-stream' };
    try { const parsed = JSON.parse(row.value); return { buffer: Buffer.from(parsed.content || '', 'base64'), mime: parsed.mime || 'application/octet-stream' }; }
    catch { return null; }
  }
  function zipStoreBuffers(entries) {
    const chunks = [], central = [];
    let offset = 0;
    for (const { name, buffer } of entries) {
      const nameBuf = Buffer.from(name, 'utf8');
      const crc = crc32(buffer);
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
      local.writeUInt32LE(crc, 14); local.writeUInt32LE(buffer.length, 18); local.writeUInt32LE(buffer.length, 22);
      local.writeUInt16LE(nameBuf.length, 26);
      chunks.push(local, nameBuf, buffer);
      const cen = Buffer.alloc(46);
      cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x0800, 8);
      cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(buffer.length, 20); cen.writeUInt32LE(buffer.length, 24);
      cen.writeUInt16LE(nameBuf.length, 28); cen.writeUInt32LE(offset, 42);
      central.push(cen, nameBuf);
      offset += local.length + nameBuf.length + buffer.length;
    }
    const centralBuf = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(centralBuf.length, 12); end.writeUInt32LE(offset, 16);
    return Buffer.concat([...chunks, centralBuf, end]);
  }
  const csvCell = value => '"' + String(value ?? '').replaceAll('"', '""') + '"';
  const csvText = rows => '﻿' + rows.map(row => row.map(csvCell).join(',')).join('\r\n');
  async function sendAppMail({ to, subject, text, attachments, rfc = '' }, kind, time) {
    const recipients = String(to || '').trim() || (mail ? mail.recipient : '');
    let ok = false, errorText = '';
    try {
      need(mail, 'El correo no está configurado en esta instalación.', 409);
      need(recipients, 'Falta el destinatario del correo.');
      await mail.transport.sendMail({ from: displayFrom(mail.from), to: recipients, subject, text, attachments });
      ok = true;
    } catch (error) { errorText = message(error); }
    /* El envío guarda el RFC dueño como DATO cuando el
       llamador lo conoce (H-6.1): la atribución de «correos
       del mes» en el paquete se hace por esta columna, jamás
       buscando el RFC en el asunto. Sin dueño conocido, la
       columna queda vacía: ese correo no se atribuye a ningún
       contribuyente. */
    db.prepare('INSERT INTO mail_sends(at,recipients,subject,kind,ok,error,rfc) VALUES (?,?,?,?,?,?,?)')
      .run(time, recipients, subject, kind, ok ? 1 : 0, errorText, String(rfc || '').trim().toUpperCase());
    if (!ok) throw new Error(errorText);
    return { recipients };
  }
  const recordInvoices = () => {
    try { return db.prepare("SELECT value FROM records WHERE store='invoices'").all().map(row => JSON.parse(row.value)); }
    catch { return []; }
  };
  const centsOf = value => {
    const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(String(value ?? '').trim());
    if (!match) return 0n;
    const cents = BigInt(match[2]) * 100n + BigInt((match[3] || '').padEnd(2, '0'));
    return match[1] ? -cents : cents;
  };
  const moneyText = cents => { const sign = cents < 0n ? '-' : ''; const abs = cents < 0n ? -cents : cents;
    return sign + (abs / 100n).toString() + '.' + String(abs % 100n).padStart(2, '0'); };
  /* Solo presentación (pulido 1.7.4): el mismo importe con separador
     de miles, para los textos que lee Paco en los avisos («$343,539.11»
     en vez de «$343539.11»). El valor GUARDADO no cambia: avisos.importe
     y los pagos a mano se siguen escribiendo con moneyText, sin agrupar,
     porque se vuelven a leer como número (centsOf). */
  const importeShow = text => { const [ent, dec] = String(text ?? '').split('.');
    return ent.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (dec !== undefined ? '.' + dec : ''); };
  const moneyShow = cents => importeShow(moneyText(cents));
  function buildMonthlyPackage(monthKey, rfc = '') {
    /* Alcance por contribuyente (1.27.0, H-4.1 MEDIA de la pasada
       de seguridad de la 1.25): sin RFC, el paquete es el de la
       instalación (el informe programado de siempre); CON RFC,
       el paquete lleva SOLO lo de ese contribuyente — sus
       comprobantes (emitidos y recibidos), sus documentos, su
       DIOT, sus cuentas y sus avisos — porque el paso «paquete»
       del cierre «Generar todo» es por RFC y mezclar dos
       contribuyentes en un ZIP que sale del sistema es justo lo
       que la pasada marcó como condición previa a dar de alta
       un segundo RFC en producción. */
    const scope = String(rfc || '').toUpperCase();
    const delAlcance = invoice => !scope ||
      String(invoice.from?.rfc || '').toUpperCase() === scope ||
      String(invoice.to?.rfc || '').toUpperCase() === scope;
    const invoices = recordInvoices().filter(invoice => String(invoice.date || '').startsWith(monthKey) && delAlcance(invoice));
    const entries = [];
    const index = [['UUID', 'Fecha', 'Tipo', 'Emisor RFC', 'Emisor', 'Receptor RFC', 'Receptor', 'Total', 'Moneda', 'Estado']];
    let issued = 0n, received = 0n;
    const profileRfcs = new Set(db.prepare('SELECT rfc FROM profiles').all().map(row => row.rfc));
    const esEmisor = invoice => scope ? String(invoice.from?.rfc || '').toUpperCase() === scope : profileRfcs.has(invoice.from?.rfc);
    const esReceptor = invoice => scope ? String(invoice.to?.rfc || '').toUpperCase() === scope : profileRfcs.has(invoice.to?.rfc);
    for (const invoice of invoices) {
      index.push([invoice.id, invoice.date, invoice.kind, invoice.from?.rfc, invoice.from?.name, invoice.to?.rfc, invoice.to?.name,
        invoice.total, invoice.currency || 'MXN', invoice.state || '']);
      /* N3 (1.22.0): este paquete es el ÚNICO que sale sin revisión
         humana (lo manda la app sola a la contadora) y era el que
         no aplicaba el criterio único: sumaba las canceladas.
         Fuera de los totales, como en todas las demás salidas;
         las canceladas constan en el índice con su estado. */
      if (salidaCancelado(invoice)) continue;
      if (!invoice.currency || invoice.currency === 'MXN') {
        if (esEmisor(invoice)) issued += centsOf(invoice.total);
        if (esReceptor(invoice)) received += centsOf(invoice.total);
      }
      const file = readFileRecord('xml:' + invoice.id);
      if (file) entries.push({ name: 'xml/' + invoice.id + '.xml', buffer: file.buffer });
    }
    entries.unshift({ name: 'indice.csv', buffer: Buffer.from(csvText(index)) });
    /* Documentos PDF del mes (constancias, opiniones, acuses…). */
    try {
      for (const row of db.prepare("SELECT value FROM records WHERE store='documents'").all()) {
        const doc = JSON.parse(row.value);
        if (!String(doc.date || '').startsWith(monthKey)) continue;
        if (scope && String(doc.rfc || '').toUpperCase() !== scope) continue;
        const file = readFileRecord(doc.id);
        if (file) entries.push({ name: 'documentos/' + (doc.rfc || 'sin-rfc') + '/' + String(doc.name || doc.id).replace(/[\\/:*?"<>|]/g, '_'), buffer: file.buffer });
      }
    } catch { /* sin documentos */ }
    /* Base DIOT del mes con el desglose persistido. */
    const diot = new Map();
    for (const invoice of invoices) {
      if (!esReceptor(invoice) || invoice.kind !== 'I') continue;
      /* N3: la base DIOT tampoco filtraba estado ni moneda: una
         cancelada entraba en «Valor de actos» y un CFDI en USD
         sumaba como si fuera MXN. Mismo criterio único. */
      if (salidaCancelado(invoice)) continue;
      if (invoice.currency && invoice.currency !== 'MXN') continue;
      const key = invoice.from.rfc;
      if (!diot.has(key)) diot.set(key, { name: invoice.from.name || '', count: 0, base: 0n, iva: 0n, withheld: 0n, total: 0n, fiscal: 0 });
      const group = diot.get(key);
      group.count++; group.total += centsOf(invoice.total);
      if (invoice.fiscal) {
        group.fiscal++;
        for (const t of invoice.fiscal.transferred) if (t.tax === '002') { group.base += centsOf(t.base); group.iva += centsOf(t.amount); }
        for (const w of invoice.fiscal.withheld) group.withheld += centsOf(w.amount);
      }
    }
    const diotRows = [['RFC proveedor', 'Proveedor', 'CFDI recibidos', 'Valor de actos', 'IVA trasladado', 'Retenciones', 'Total', 'CFDI con desglose']];
    for (const [rfc, group] of diot) diotRows.push([rfc, group.name, group.count, moneyText(group.base), moneyText(group.iva), moneyText(group.withheld), moneyText(group.total), group.fiscal]);
    entries.push({ name: 'base-diot.csv', buffer: Buffer.from(csvText(diotRows)) });
    /* Novedades de listas negras del mes. Con alcance, solo las
       de las contrapartes que operaron con ese RFC en el mes. */
    const monthStart = Date.parse(monthKey + '-01T00:00:00Z');
    const scopeParties = scope ? new Set(invoices.flatMap(invoice => [invoice.from?.rfc, invoice.to?.rfc]).filter(Boolean)) : null;
    const events = db.prepare('SELECT * FROM list_events WHERE at>=? AND at<? ORDER BY at').all(monthStart, monthStart + 32 * DAY)
      .filter(event => !scopeParties || scopeParties.has(event.rfc) || event.rfc === scope);
    const eventRows = [['Fecha', 'Listado', 'RFC', 'Cambio', 'Detalle']];
    for (const event of events) eventRows.push([new Date(event.at).toISOString(), event.listId, event.rfc, event.change, event.detail]);
    entries.push({ name: 'listas-novedades.csv', buffer: Buffer.from(csvText(eventRows)) });
    /* ===== Ampliación 1.9.0 (punto 4 del plan + barrido de
       comunidades del 9 nov 2026): el paquete pasa a cerrar el mes
       de verdad — conciliación, pendientes reales por saldo y las
       revisiones PUE/PPD que el SAT está observando por Buzón. */
    const allInvoices = recordInvoices();
    const byUuid = new Map(allInvoices.map(invoice => [invoice.id, invoice]));
    const balances = new Map(moneyBalances().map(balance => [balance.id, balance]));
    const paidBy = moneyPaidBy();
    const sentido = invoice => esEmisor(invoice) ? 'Por cobrar (emitida)' : 'Por pagar (recibida)';
    /* PPD del mes con su saldo REAL (la 1.8.0 listaba todos los PPD
       como si debieran el complemento aunque ya estuvieran pagados). */
    const pendingRows = [['UUID', 'Fecha', 'Sentido', 'Contraparte', 'Total', 'Pagado', 'Saldo pendiente']];
    const complementPendingRows = [['UUID', 'Fecha', 'Sentido', 'Contraparte', 'Total', 'Pagado', 'Saldo pendiente', 'Nota']];
    let pendingComplements = 0;
    for (const invoice of invoices.filter(item => item.fiscal?.paymentMethod === 'PPD' && item.kind === 'I')) {
      const balance = balances.get(invoice.id);
      const paid = balance ? balance.total - balance.balance : 0n;
      const saldo = balance ? balance.balance : centsOf(invoice.total);
      pendingRows.push([invoice.id, invoice.date, sentido(invoice),
        esEmisor(invoice) ? invoice.to?.name : invoice.from?.name,
        invoice.total, moneyText(paid), moneyText(saldo)]);
      if (saldo > 0n) { pendingComplements++;
        complementPendingRows.push([invoice.id, invoice.date, sentido(invoice),
          esEmisor(invoice) ? invoice.to?.name : invoice.from?.name,
          invoice.total, moneyText(paid), moneyText(saldo),
          'Si el pago llegó en ' + monthKey + ', su complemento vence a más tardar el día 5 del mes siguiente (regla 2.7.1.32).']);
      }
    }
    entries.push({ name: 'ppd-del-mes.csv', buffer: Buffer.from(csvText(pendingRows)) });
    entries.push({ name: 'complementos-pendientes.csv', buffer: Buffer.from(csvText(complementPendingRows)) });
    /* Complementos del mes, revisados uno a uno contra su factura
       (barrido C.5): UUID, importe, fecha y forma del pago, y si la
       factura relacionada es PUE — la combinación que el SAT está
       avisando por Buzón Tributario (barrido C.1, meta: cero). */
    const complementRows = [['UUID complemento', 'Fecha complemento', 'UUID factura', 'Fecha de pago', 'Importe pagado', 'Forma de pago', 'Método de la factura', 'Revisión']];
    const pueWithComplement = new Map();
    for (const payment of invoices.filter(item => item.kind === 'P' && item.fiscal?.payments)) {
      for (const pago of payment.fiscal.payments.pagos || []) for (const doc of pago.documentos || []) {
        const target = byUuid.get(doc.idDocumento);
        const revision = !target ? 'La factura relacionada no está en el expediente' :
          target.fiscal?.paymentMethod === 'PUE' ? 'OJO: la factura es PUE y tiene complemento (combinación observada por el SAT)' :
          target.fiscal?.paymentMethod !== 'PPD' ? 'La factura no es PPD: revisar' : 'Correcto: complemento de una PPD';
        complementRows.push([payment.id, payment.date, doc.idDocumento, pago.fechaPago || '',
          doc.impPagado, pago.formaPago || '', target?.fiscal?.paymentMethod || '', revision]);
        if (target?.fiscal?.paymentMethod === 'PUE') pueWithComplement.set(target.id, target);
      }
    }
    /* También cuentan los PUE del mes con complemento de OTRO mes. */
    for (const payment of allInvoices.filter(item => item.kind === 'P' && item.fiscal?.payments))
      for (const pago of payment.fiscal.payments.pagos || []) for (const doc of pago.documentos || []) {
        const target = byUuid.get(doc.idDocumento);
        if (target && target.fiscal?.paymentMethod === 'PUE' && String(target.date || '').startsWith(monthKey) && delAlcance(target))
          pueWithComplement.set(target.id, target);
      }
    entries.push({ name: 'complementos-del-mes.csv', buffer: Buffer.from(csvText(complementRows)) });
    const pueRows = [['UUID', 'Fecha', 'Emisor', 'Receptor', 'Total', 'Aviso']];
    for (const invoice of pueWithComplement.values()) pueRows.push([invoice.id, invoice.date,
      invoice.from?.name, invoice.to?.name, invoice.total,
      'CFDI emitido como PUE con complemento de pago asociado: es la combinación que el SAT está observando por Buzón Tributario y puede duplicar el ingreso en la precarga de Declaraciones y Pagos.']);
    entries.push({ name: 'pue-con-complemento.csv', buffer: Buffer.from(csvText(pueRows)) });
    /* PUE del mes sin evidencia de pago al cierre y PUE cuyo pago
       llegó con forma distinta a la registrada (regla 2.7.1.39 del
       barrido: cancelar y reexpedir según el caso). */
    const matchedUuids = new Set();
    for (const match of db.prepare("SELECT invoices FROM bank_matches WHERE estado='activo'").all())
      for (const inv of JSON.parse(match.invoices || '[]')) matchedUuids.add(inv.uuid);
    const pueReviewRows = [['UUID', 'Fecha', 'Contraparte', 'Total', 'Tipo de revisión', 'Detalle']];
    for (const invoice of invoices.filter(item => item.kind === 'I' && item.fiscal?.paymentMethod === 'PUE')) {
      const hasPaymentEvidence = matchedUuids.has(invoice.id) || db.prepare('SELECT 1 AS x FROM manual_payments WHERE uuid=?').get(invoice.id);
      if (!hasPaymentEvidence && !pueWithComplement.has(invoice.id))
        pueReviewRows.push([invoice.id, invoice.date, invoice.to?.name || invoice.from?.name, invoice.total,
          'PUE sin evidencia de pago al cierre del mes',
          'Si el pago no llegó a más tardar el último día del mes, la regla 2.7.1.39 pide cancelar y reexpedir como PPD (forma 99, relación de sustitución) y emitir los complementos por los pagos recibidos.']);
      for (const payment of allInvoices.filter(item => item.kind === 'P' && item.fiscal?.payments))
        for (const pago of payment.fiscal.payments.pagos || [])
          if ((pago.documentos || []).some(doc => doc.idDocumento === invoice.id) &&
              pago.formaPago && invoice.fiscal?.paymentForm && pago.formaPago !== invoice.fiscal.paymentForm)
            pueReviewRows.push([invoice.id, invoice.date, invoice.to?.name || invoice.from?.name, invoice.total,
              'PUE pagado con forma distinta a la registrada',
              'La factura dice forma ' + invoice.fiscal.paymentForm + ' y el pago llegó con forma ' + pago.formaPago +
              ': la regla 2.7.1.39 pide cancelar y reexpedir señalando la forma correcta.']);
    }
    entries.push({ name: 'pue-revision.csv', buffer: Buffer.from(csvText(pueReviewRows)) });
    /* Inconsistencias de forma de pago detectables (barrido C.4,
       error CFDI40105): PPD con forma distinta de 99 y PUE con 99. */
    const formaRows = [['UUID', 'Fecha', 'Método', 'Forma registrada', 'Inconsistencia']];
    for (const invoice of invoices.filter(item => item.kind === 'I' && item.fiscal)) {
      if (invoice.fiscal.paymentMethod === 'PPD' && invoice.fiscal.paymentForm && invoice.fiscal.paymentForm !== '99')
        formaRows.push([invoice.id, invoice.date, 'PPD', invoice.fiscal.paymentForm, 'Un PPD debe llevar forma 99 (por definir); con otra forma el timbrado da el error CFDI40105.']);
      if (invoice.fiscal.paymentMethod === 'PUE' && invoice.fiscal.paymentForm === '99')
        formaRows.push([invoice.id, invoice.date, 'PUE', '99', 'Un PUE debe llevar la forma real de pago, no 99 (por definir).']);
    }
    entries.push({ name: 'inconsistencias-forma.csv', buffer: Buffer.from(csvText(formaRows)) });
    /* Cancelaciones del mes, con la señal grave: cancelada YA pagada. */
    const cancelRows = [['UUID', 'Fecha', 'Emisor', 'Receptor', 'Total', 'Ya pagada', 'Nota']];
    let cancelledPaid = 0;
    for (const invoice of invoices.filter(item => String(item.state || '').toLowerCase().startsWith('cancel'))) {
      const paid = (paidBy.get(invoice.id) || 0n) > 0n;
      if (paid) cancelledPaid++;
      cancelRows.push([invoice.id, invoice.date, invoice.from?.name, invoice.to?.name, invoice.total,
        paid ? 'SÍ' : 'No', paid ? 'Cancelada con pago enlazado: revisar con la contadora antes de darla por cerrada.' : '']);
    }
    entries.push({ name: 'cancelaciones.csv', buffer: Buffer.from(csvText(cancelRows)) });
    /* Conciliación bancaria del mes y movimientos sin identificar.
       Con alcance, solo los movimientos de las cuentas cuyo RFC
       dueño es el del paquete (las sin dueño no se atribuyen). */
    const accountsById = new Map(banksOverview().accounts.map(account => [account.id, account]));
    const movements = db.prepare('SELECT m.*, s.accountId FROM bank_movements m JOIN bank_statements s ON s.id=m.statementId').all()
      .filter(mv => String(mv.date || '').startsWith(monthKey))
      .filter(mv => !scope || String(accountsById.get(mv.accountId)?.rfc || '').toUpperCase() === scope);
    const activeMatches = db.prepare("SELECT * FROM bank_matches WHERE estado='activo'").all();
    const matchByMovement = new Map(activeMatches.map(match => [match.movementId, match]));
    const marks = new Set(db.prepare('SELECT movementId FROM bank_movement_marks').all().map(row => row.movementId));
    const reconcileRows = [['Fecha', 'Concepto', 'Importe', 'Modo', 'Facturas', 'Por qué se propuso']];
    const unmatchedRows = [['Fecha', 'Cuenta', 'Concepto', 'Importe']];
    for (const mv of movements) {
      const match = matchByMovement.get(mv.id);
      if (match) reconcileRows.push([mv.date, mv.concept, moneyText(BigInt(mv.amountCents)), match.mode,
        JSON.parse(match.invoices || '[]').map(inv => inv.uuid).join(' + '), match.why]);
      else if (!marks.has(mv.id)) { const account = accountsById.get(mv.accountId);
        unmatchedRows.push([mv.date, account ? (account.bank + ' ' + (account.name || '')) : mv.accountId, mv.concept, moneyText(BigInt(mv.amountCents))]); }
    }
    entries.push({ name: 'conciliaciones.csv', buffer: Buffer.from(csvText(reconcileRows)) });
    entries.push({ name: 'movimientos-sin-identificar.csv', buffer: Buffer.from(csvText(unmatchedRows)) });
    /* Faltantes: XML no guardados y estados de cuenta del mes. */
    const missingRows = [['Tipo', 'Detalle']];
    for (const invoice of invoices) if (!readFileRecord('xml:' + invoice.id))
      missingRows.push(['XML no guardado', invoice.id + ' · ' + (invoice.from?.name || '') + ' · ' + invoice.total]);
    for (const account of banksOverview().accounts)
      if (account.missing.includes(monthKey) && (!scope || String(account.rfc || '').toUpperCase() === scope))
        missingRows.push(['Estado de cuenta faltante', account.bank + ' ' + (account.name || '') + ' · ' + monthKey]);
    entries.push({ name: 'faltantes.csv', buffer: Buffer.from(csvText(missingRows)) });
    /* Bitácora del mes: avisos (Buzón interno) y correos enviados —
       las invitaciones del SAT también llegan por correo (C.3). */
    const avisoRows = [['Creado', 'Clase', 'Título', 'RFC', 'Responsable', 'Estado', 'Resolución']];
    for (const aviso of db.prepare('SELECT * FROM avisos WHERE creado>=? AND creado<? ORDER BY creado').all(monthStart, monthStart + 32 * DAY)
      .filter(aviso => !scope || String(aviso.rfc || '').toUpperCase() === scope))
      avisoRows.push([new Date(aviso.creado).toISOString(), aviso.clase, aviso.titulo, aviso.rfc || '', aviso.responsable || '', aviso.estado, aviso.resolucion || '']);
    entries.push({ name: 'avisos-del-mes.csv', buffer: Buffer.from(csvText(avisoRows)) });
    /* Los correos se atribuyen por el RFC guardado como DATO
       en el envío (H-6.1 y su residuo, pasadas de la 1.24.0 y
       la 1.27.0): antes este filtro buscaba el RFC como
       subcadena del ASUNTO, y un resumen que citara a los dos
       contribuyentes constaba en el paquete de ambos. Un envío
       sin RFC registrado — los legados y los de la instalación
       entera — no se atribuye a nadie: solo viaja en el
       paquete sin acotar, y el paquete acotado lo declara en
       su resumen. */
    const mailRows = [['Fecha', 'Destinatarios', 'Asunto', 'Tipo', 'Enviado', 'Error', 'RFC']];
    for (const send of db.prepare('SELECT * FROM mail_sends WHERE at>=? AND at<? ORDER BY at').all(monthStart, monthStart + 32 * DAY)
      .filter(send => !scope || String(send.rfc || '').toUpperCase() === scope))
      mailRows.push([new Date(send.at).toISOString(), send.recipients, send.subject, send.kind, send.ok ? 'sí' : 'no', send.error || '', send.rfc || '']);
    entries.push({ name: 'correos-del-mes.csv', buffer: Buffer.from(csvText(mailRows)) });
    /* Conciliación PUE vs declarado (base, barrido C.3): el IVA de
       los PUE emitidos es lo que el SAT cruza contra la declaración;
       la cifra declarada la aporta la contadora — aquí va la base
       exacta, por RFC, para conciliar en un vistazo. */
    let pueIva = 0n, pueTotal = 0n;
    for (const invoice of invoices.filter(item => item.kind === 'I' && item.fiscal?.paymentMethod === 'PUE' && esEmisor(item))) {
      pueTotal += centsOf(invoice.total);
      for (const t of invoice.fiscal?.transferred || []) if (t.tax === '002') pueIva += centsOf(t.amount);
    }
    /* Lista de revisión para la contadora, con las cifras del mes. */
    const checklist = ['PacoSAT · Lista de revisión del cierre ' + monthKey, '',
      '1. CFDI del mes en el expediente: ' + invoices.length + ' (indice.csv, con sus XML en /xml).',
      '2. Conciliación bancaria: ' + (reconcileRows.length - 1) + ' movimiento(s) conciliados (conciliaciones.csv) y ' +
        (unmatchedRows.length - 1) + ' sin identificar (movimientos-sin-identificar.csv).',
      '3. Complementos pendientes por saldo real: ' + pendingComplements + ' (complementos-pendientes.csv). ' +
        'Ojo al plazo: el complemento de un pago recibido en el mes vence a más tardar el día 5 del mes siguiente.',
      '4. Complementos del mes revisados uno a uno (complementos-del-mes.csv): ' + (complementRows.length - 1) + '.',
      '5. CFDI PUE con complemento asociado: ' + pueWithComplement.size + ' (pue-con-complemento.csv). La meta es cero: ' +
        'es la combinación que el SAT está observando por Buzón Tributario.',
      '6. PUE a revisar (sin evidencia de pago al cierre o pagados con otra forma): ' + (pueReviewRows.length - 1) + ' (pue-revision.csv).',
      '7. Inconsistencias de forma de pago PUE/PPD: ' + (formaRows.length - 1) + ' (inconsistencias-forma.csv).',
      '8. Cancelaciones del mes: ' + (cancelRows.length - 1) + ', de ellas ya pagadas: ' + cancelledPaid + ' (cancelaciones.csv).',
      '9. Faltantes (XML sin guardar, estados sin archivar): ' + (missingRows.length - 1) + ' (faltantes.csv).',
      '10. IVA trasladado de los CFDI PUE emitidos del mes: $' + moneyText(pueIva) + ' sobre $' + moneyText(pueTotal) +
        ' — es la cifra que el SAT cruza contra lo declarado; concíliala con la declaración antes de que llegue la invitación.',
      '11. Base DIOT por proveedor: base-diot.csv · Novedades de listados: listas-novedades.csv.',
      '12. Avisos y correos del mes: avisos-del-mes.csv y correos-del-mes.csv (las invitaciones del SAT también llegan por correo; la aclaración se presenta en Mi Portal).'].join('\n');
    entries.push({ name: 'revision-contadora.txt', buffer: Buffer.from(checklist) });
    const summary = ['PacoSAT · Paquete mensual ' + monthKey + (scope ? ' · ' + scope : ''), '',
      ...(scope ? ['Contribuyente: ' + scope + ' — este paquete lleva SOLO sus comprobantes, documentos y cuentas.',
        'Correos del mes: solo los envíos que llevan ESTE RFC como dato del propio envío (correos-del-mes.csv). ' +
        'Los correos sin RFC registrado — los legados y los de la instalación entera — no se atribuyen a ningún contribuyente y no van en este paquete.'] : []),
      'CFDI del mes: ' + invoices.length,
      'Total emitido (tus RFC): $' + moneyText(issued),
      'Total recibido (tus RFC): $' + moneyText(received),
      'Documentos PDF del mes incluidos en /documentos.',
      'Conciliados: ' + (reconcileRows.length - 1) + ' · Sin identificar: ' + (unmatchedRows.length - 1) +
        ' · Complementos pendientes: ' + pendingComplements + ' · PUE con complemento: ' + pueWithComplement.size +
        ' · Cancelaciones: ' + (cancelRows.length - 1) + ' · Faltantes: ' + (missingRows.length - 1),
      'La lista de revisión paso a paso va en revision-contadora.txt.',
      'Base DIOT con desglose: base-diot.csv · Novedades de listas: listas-novedades.csv · PPD del mes: ppd-del-mes.csv'].join('\n');
    entries.push({ name: 'resumen.txt', buffer: Buffer.from(summary) });
    return { buffer: zipStoreBuffers(entries), filename: 'PacoSAT-paquete-' + monthKey + (scope ? '-' + scope : '') + '.zip',
      counts: { invoices: invoices.length, events: events.length, pendingComplements,
        pueWithComplement: pueWithComplement.size, unmatchedMovements: unmatchedRows.length - 1,
        cancelled: cancelRows.length - 1, missing: missingRows.length - 1, rfc: scope } };
  }
  /* Lista de cierre del mes calculada en el SERVIDOR (1.9.0): la
     pantalla ya no trae pasos «sin comprobar» — cada renglón trae su
     cifra real y su nivel, y es la misma verdad que va dentro del
     ZIP en revision-contadora.txt. */
  function monthChecklist(monthKey, time, scopeRfcs = null) {
    /* Alcance por RFC (1.27.0, H-4.2 de la pasada de la 1.25): la
       lista del invitado se calcula SOLO con los contribuyentes
       de su alcance — conteos y estados, sin importes, como ya
       era su regla — y no con la instalación entera: con dos RFC
       dados de alta, la Vista Nora de uno no puede contar los
       comprobantes del otro. scopeRfcs=null = sin acotar (el
       administrador en su propia pantalla). */
    const enAlcance = invoice => !scopeRfcs || scopeRfcs.includes(String(invoice.from?.rfc || '').toUpperCase()) ||
      scopeRfcs.includes(String(invoice.to?.rfc || '').toUpperCase());
    const invoices = recordInvoices().filter(invoice => String(invoice.date || '').startsWith(monthKey) && enAlcance(invoice));
    const items = [];
    const push = (id, label, level, detail) => items.push({ id, label, level, detail });
    push('cfdi', 'CFDI del mes en el expediente', invoices.length ? 'ok' : 'dim',
      invoices.length ? invoices.length + ' comprobantes de ' + monthKey + '.' : 'Aún no hay comprobantes de ' + monthKey + '.');
    const sinDesglose = invoices.filter(invoice => invoice.kind === 'I' && !invoice.fiscal).length;
    push('desglose', 'Desglose fiscal completo', sinDesglose ? 'warn' : 'ok',
      sinDesglose ? sinDesglose + ' CFDI de ingreso sin desglose: la base DIOT sale incompleta.' : 'Todos los CFDI de ingreso traen desglose.');
    const accountsByIdCheck = new Map(banksOverview().accounts.map(account => [account.id, account]));
    const movements = db.prepare('SELECT m.id, s.accountId FROM bank_movements m JOIN bank_statements s ON s.id=m.statementId WHERE m.date LIKE ?').all(monthKey + '%')
      .filter(mv => !scopeRfcs || scopeRfcs.includes(String(accountsByIdCheck.get(mv.accountId)?.rfc || '').toUpperCase()));
    const matched = new Set(db.prepare("SELECT movementId FROM bank_matches WHERE estado='activo'").all().map(row => row.movementId));
    const marked = new Set(db.prepare('SELECT movementId FROM bank_movement_marks').all().map(row => row.movementId));
    const sinIdentificar = movements.filter(mv => !matched.has(mv.id) && !marked.has(mv.id)).length;
    push('conciliacion', 'Conciliación bancaria del mes', movements.length === 0 ? 'dim' : sinIdentificar ? 'warn' : 'ok',
      movements.length === 0 ? 'Sin movimientos bancarios archivados de ' + monthKey + '.' :
        sinIdentificar ? sinIdentificar + ' movimiento(s) sin identificar de ' + movements.length + '.' : 'Todos los movimientos del mes están conciliados o marcados.');
    const balances = new Map(moneyBalances().map(balance => [balance.id, balance]));
    const pendientes = invoices.filter(invoice => invoice.fiscal?.paymentMethod === 'PPD' && invoice.kind === 'I' &&
      (balances.get(invoice.id)?.balance || 0n) > 0n).length;
    push('complementos', 'Complementos de pago pendientes', pendientes ? 'warn' : 'ok',
      pendientes ? pendientes + ' PPD del mes con saldo: su complemento vence a más tardar el día 5 del mes siguiente.' : 'Ningún PPD del mes queda con saldo.');
    const byUuid = new Map(recordInvoices().map(invoice => [invoice.id, invoice]));
    let pueComp = 0;
    for (const payment of recordInvoices().filter(invoice => invoice.kind === 'P' && invoice.fiscal?.payments))
      for (const pago of payment.fiscal.payments.pagos || []) for (const doc of pago.documentos || []) {
        const target = byUuid.get(doc.idDocumento);
        if (target?.fiscal?.paymentMethod === 'PUE' && String(target.date || '').startsWith(monthKey) && enAlcance(target)) pueComp++;
      }
    push('pue', 'CFDI PUE con complemento (meta: cero)', pueComp ? 'bad' : 'ok',
      pueComp ? pueComp + ' caso(s): es la combinación que el SAT observa por Buzón Tributario.' : 'Ningún PUE del mes tiene complemento asociado.');
    const paidBy = moneyPaidBy();
    const canceladas = invoices.filter(invoice => String(invoice.state || '').toLowerCase().startsWith('cancel'));
    const cancelPagadas = canceladas.filter(invoice => (paidBy.get(invoice.id) || 0n) > 0n).length;
    push('cancelaciones', 'Cancelaciones del mes', cancelPagadas ? 'bad' : canceladas.length ? 'warn' : 'ok',
      canceladas.length ? canceladas.length + ' cancelada(s)' + (cancelPagadas ? ', ' + cancelPagadas + ' ya pagada(s): revisar ya.' : '.') : 'Sin cancelaciones en el mes.');
    const xmlFaltantes = invoices.filter(invoice => !readFileRecord('xml:' + invoice.id)).length;
    const estadosFaltantes = banksOverview().accounts
      .filter(account => account.missing.includes(monthKey))
      .filter(account => !scopeRfcs || scopeRfcs.includes(String(account.rfc || '').toUpperCase())).length;
    push('faltantes', 'Faltantes de descarga y archivo', (xmlFaltantes || estadosFaltantes) ? 'warn' : 'ok',
      (xmlFaltantes || estadosFaltantes) ? xmlFaltantes + ' XML sin guardar y ' + estadosFaltantes + ' estado(s) de cuenta faltante(s) del mes.' : 'Nada falta: XML y estados del mes están archivados.');
    const backup = overview().scheduledBackup;
    const respaldoOk = backup.last && time - backup.last < 10 * DAY;
    push('respaldo', 'Respaldo reciente', respaldoOk ? 'ok' : 'warn',
      backup.last ? 'Último respaldo: ' + new Date(backup.last).toISOString().slice(0, 10) + '.' : 'Aún no hay respaldo ejecutado.');
    const docsView = satDocsOverview(time);
    const sinConstancia = docsView.filter(profile => !profile.constancia || !profile.opinion)
      .filter(profile => !scopeRfcs || scopeRfcs.includes(String(profile.rfc || '').toUpperCase())).length;
    push('constancias', 'Constancias y opinión al día', sinConstancia ? 'warn' : 'ok',
      sinConstancia ? sinConstancia + ' perfil(es) sin constancia u opinión archivada.' : 'Constancias y opiniones archivadas por perfil.');
    let noraMonth = '';
    try { noraMonth = JSON.parse(getState('reports-state') || '{}').noraMonth || ''; } catch { noraMonth = ''; }
    push('informe', 'Informe a la contadora', noraMonth === monthKey ? 'ok' : 'dim',
      noraMonth === monthKey ? 'El paquete de ' + monthKey + ' ya salió a la contadora.' :
        'El paquete de ' + monthKey + ' aún no consta enviado (sale el día fijado del mes siguiente o a mano desde Salidas).');
    return { month: monthKey, items, scope: scopeRfcs || [] };
  }
  /* ===== Capa de salidas (Ronda Salidas, 1.14.0) =====
     Los artefactos que salen de PacoSAT se DISEÑAN para su destino
     (papel o Excel); no se vuelca la pantalla. PDF A4 con el FOLIO
     visible y totales correctos, .xlsx reales con tipos y fórmulas,
     ZIP ordenados RFC → emitidos/recibidos → año → mes con los
     cancelados en carpeta aparte e índice + manifiesto dentro, y la
     descarga a la carta por comprobante (XML / PDF / ambos). Los
     constructores puros viven en salidas-doc.mjs; aquí solo se
     reúnen las filas VERDAD del servidor (moneyBalances,
     monthChecklist, cfdi_watch, declaracionesOverview): el PDF de
     cierre no usa jamás cifras de la sesión del cliente. Todo
     responde con la convención de descargas de la casa:
     JSON { name, type, content: base64 }. */
  const salidaNum = new Intl.NumberFormat('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const salidaFechaLarga = new Intl.DateTimeFormat('es-MX', { dateStyle: 'long', timeZone: 'America/Mexico_City' });
  const salidaPesos = cents => '$' + salidaNum.format((Number(cents) || 0) / 100);
  const salidaGenerado = () => 'Generado el ' + salidaFechaLarga.format(now()) + ' · PacoSAT' + (APP_VERSION ? ' ' + APP_VERSION : '');
  /* Fechas y códigos EN PALABRAS en los documentos (1.18.0, eje
     Reportes de la revisión de facilidad): una persona lee «2 de
     noviembre de 2026», no «2026-11-02»; y la forma/método de pago
     se nombra primero y el código va entre paréntesis, al revés
     de como salía («99 · PPD» en crudo). */
  const SALIDA_MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  const SALIDA_MESES_CORTOS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  const salidaFechaPalabras = iso => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
    return m ? Number(m[3]) + ' de ' + SALIDA_MESES[Number(m[2]) - 1] + ' de ' + m[1] : String(iso || '');
  };
  const salidaFechaCorta = iso => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
    return m ? Number(m[3]) + ' ' + SALIDA_MESES_CORTOS[Number(m[2]) - 1] + ' ' + m[1] : String(iso || '');
  };
  const SALIDA_FORMA_PAGO = { '01': 'Efectivo', '02': 'Cheque nominativo', '03': 'Transferencia electrónica de fondos',
    '04': 'Tarjeta de crédito', '05': 'Monedero electrónico', '06': 'Dinero electrónico', '15': 'Condonación',
    '17': 'Compensación', '23': 'Novación', '24': 'Confusión', '25': 'Remisión de deuda', '26': 'Prescripción o caducidad',
    '27': 'A satisfacción del acreedor', '28': 'Tarjeta de débito', '29': 'Tarjeta de servicios',
    '30': 'Aplicación de anticipos', '31': 'Intermediario de pagos', '99': 'Por definir' };
  const SALIDA_METODO_PAGO = { PUE: 'Pago en una sola exhibición', PPD: 'Pago en parcialidades o diferido' };
  const salidaFormaMetodo = (forma, metodo) => {
    /* Cada concepto con su nombre primero y SU código detrás, entre
       paréntesis: «Por definir (99) · Pago en parcialidades o
       diferido (PPD)» — nunca el par de códigos como texto principal. */
    const partes = [];
    if (forma) partes.push((SALIDA_FORMA_PAGO[forma] || forma) + ' (' + forma + ')');
    if (metodo) partes.push((SALIDA_METODO_PAGO[metodo] || metodo) + ' (' + metodo + ')');
    return partes.join(' · ');
  };
  /* El RFC es «del expediente» si es un perfil de PacoSAT (misma
     regla que Pagos); el nombre comercial vive en el registro de
     personas, no en la tabla de perfiles. */
  const salidaPerfil = rfc => {
    if (!rfc || !db.prepare('SELECT 1 FROM profiles WHERE rfc = ?').get(rfc)) return null;
    let name = '';
    try { name = JSON.parse(db.prepare("SELECT value FROM records WHERE store = 'people' AND id = ?").get(rfc)?.value || '{}').name || ''; }
    catch { name = ''; }
    return { rfc, name };
  };
  const salidaEstadoSat = id => {
    const row = db.prepare('SELECT checked, result FROM cfdi_watch WHERE id = ?').get(id);
    if (!row?.checked) return 'Sin revisar';
    try {
      const result = JSON.parse(row.result || '{}');
      if (result.error) return 'Con problema';
      return result.state === 'Cancelado' ? 'Cancelado' : 'Vigente';
    } catch { return 'Con problema'; }
  };
  const salidaCancelado = invoice => salidaEstadoSat(invoice.id) === 'Cancelado' ||
    String(invoice.state || '').toLowerCase().startsWith('cancel');
  const salidaDelRfc = (rfc, monthKey = '') => recordInvoices()
    .filter(invoice => invoice.from?.rfc === rfc || invoice.to?.rfc === rfc)
    .filter(invoice => !monthKey || String(invoice.date || '').startsWith(monthKey))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.id).localeCompare(String(b.id)));
  const salidaContraparte = (invoice, rfc) => invoice.from?.rfc === rfc ? invoice.to : invoice.from;
  const salidaNombreArchivo = (invoice, rfc) => {
    const cp = salidaContraparte(invoice, rfc);
    const folio = folioLabel(invoice).replace(/[\\/:*?"<>|]/g, '').trim();
    return `${String(invoice.date || '').slice(0, 10)}_${cp?.rfc || 'SIN-RFC'}_${folio === 'Sin folio' ? invoice.id.slice(0, 8) : folio}`;
  };
  const salidaMapaSaldos = () => new Map(moneyBalances().map(balance => [balance.id, balance]));
  const salidaEstadoPago = (invoice, balances) => {
    if (invoice.kind !== 'I') return '—';
    const balance = balances.get(invoice.id);
    if (!balance) return 'Sin datos';
    return balance.balance <= 0n ? 'Pagada' : balance.paid > 0n ? 'Parcial' : 'Pendiente';
  };
  const salidaFilaPeriodo = (invoice, rfc, balances) => {
    const cp = salidaContraparte(invoice, rfc);
    const balance = balances.get(invoice.id);
    return [folioLabel(invoice), cp?.name || cp?.rfc || '', String(invoice.date || '').slice(0, 10),
      salidaPesos(centsOf(invoice.total)), invoice.kind === 'I' && balance ? salidaPesos(balance.paid) : '—',
      invoice.kind === 'I' && balance ? salidaPesos(balance.balance) : '—', salidaEstadoSat(invoice.id)];
  };
  const SALIDA_COLUMNAS_PERIODO = [
    { title: 'Folio', width: 0.13 }, { title: 'Contraparte', width: 0.31 }, { title: 'Fecha', width: 0.11 },
    { title: 'Total', width: 0.13, align: 'right' }, { title: 'Pagado', width: 0.11, align: 'right' },
    { title: 'Saldo', width: 0.11, align: 'right' }, { title: 'Estado SAT', width: 0.10 }];
  const salidaTotalesPeriodo = rows => {
    /* Los totales NO cuentan las canceladas (1.18.0): una factura
       cancelada no se cobra ni se paga, y meterla en el total sin
       avisar era el defecto que la revisión cazó en los artefactos
       de la 1.14.0. La fila sigue en la tabla, marcada «Cancelado»,
       y la etiqueta del total lo dice. */
    const vivas = rows.filter(invoice => !salidaCancelado(invoice));
    const total = vivas.reduce((sum, invoice) => sum + centsOf(invoice.total), 0n);
    const etiqueta = vivas.length === rows.length ? 'Total' : 'Total (sin canceladas)';
    return [[etiqueta, '', '', salidaPesos(total), '', '', '']];
  };
  function salidaPdfPeriodo(rfc, monthKey, conCierre) {
    const perfil = salidaPerfil(rfc);
    const rows = salidaDelRfc(rfc, monthKey);
    const balances = salidaMapaSaldos();
    const emitidos = rows.filter(invoice => invoice.from?.rfc === rfc);
    const recibidos = rows.filter(invoice => invoice.to?.rfc === rfc);
    const sections = [];
    const tabla = lista => ({ columns: SALIDA_COLUMNAS_PERIODO,
      rows: lista.map(invoice => salidaFilaPeriodo(invoice, rfc, balances)), totals: salidaTotalesPeriodo(lista) });
    if (conCierre) {
      /* El resumen que responde (1.18.0): tres líneas arriba que
         contestan «¿cómo quedó el mes?» sin leer las tablas, con
         las canceladas fuera y contadas aparte. */
      const vivas = lista => lista.filter(invoice => invoice.kind === 'I' && !salidaCancelado(invoice));
      const sumaCampo = (lista, campo) => lista.reduce((sum, invoice) =>
        sum + (balances.get(invoice.id)?.[campo] || 0n), 0n);
      const emVivas = vivas(emitidos), recVivas = vivas(recibidos);
      const emTotal = emVivas.reduce((sum, invoice) => sum + centsOf(invoice.total), 0n);
      const recTotal = recVivas.reduce((sum, invoice) => sum + centsOf(invoice.total), 0n);
      const emSaldo = sumaCampo(emVivas, 'balance'), recSaldo = sumaCampo(recVivas, 'balance');
      const canceladas = rows.filter(invoice => salidaCancelado(invoice)).length;
      const reps = rows.filter(invoice => invoice.kind === 'P').length;
      sections.push({ heading: 'Resumen del mes', lines: [
        `Emitiste ${salidaPesos(emTotal)} y cobraste ${salidaPesos(emTotal - emSaldo)}` +
          (emSaldo > 0n ? `: te faltan ${salidaPesos(emSaldo)} por cobrar.` : ': cobrado todo.'),
        `Recibiste ${salidaPesos(recTotal)} y debes ${salidaPesos(recSaldo)}` +
          (recSaldo > 0n ? '.' : ': nada pendiente de pago.'),
        canceladas ? `${canceladas} cancelada(s) en el mes: constan en las tablas, marcadas, y quedan fuera de los totales.`
          : 'Sin canceladas en el mes.',
        ...(reps ? [`Este mes trae ${reps} comprobante(s) de pago (REP): acreditan pagos de otras facturas y no suman total propio.`] : [])] });
    }
    /* N10 (1.22.0): «Emitidos» mezclaba la nómina (clase N) con la
       facturación sin decirlo; el Reporte Mano Fil la separa y
       este PDF no. La nómina va en su propia sección, nombrada. */
    const nominaRows = rows.filter(invoice => invoice.kind === 'N');
    const emitidosFact = emitidos.filter(invoice => invoice.kind !== 'N');
    const recibidosFact = recibidos.filter(invoice => invoice.kind !== 'N');
    sections.push({ heading: `Emitidos (${emitidosFact.length})`, table: tabla(emitidosFact) });
    sections.push({ heading: `Recibidos (${recibidosFact.length})`, table: tabla(recibidosFact) });
    if (nominaRows.length) sections.push({ heading: `Nómina del mes (${nominaRows.length})`, table: tabla(nominaRows) });
    if (conCierre) {
      const check = monthChecklist(monthKey, now());
      const nivel = { ok: 'Listo', warn: 'Atención', bad: 'Problema', dim: 'Pendiente' };
      sections.push({ heading: 'Lista de cierre del mes',
        lines: check.items.map(item => `${nivel[item.level] || item.level} · ${item.label} — ${item.detail}`) });
      const conteo = { Vigente: 0, Cancelado: 0, 'Sin revisar': 0, 'Con problema': 0 };
      for (const invoice of rows) conteo[salidaEstadoSat(invoice.id)] = (conteo[salidaEstadoSat(invoice.id)] || 0) + 1;
      sections.push({ heading: 'Vigilancia del SAT en el mes',
        lines: [`Vigentes: ${conteo.Vigente} · Cancelados: ${conteo.Cancelado} · Sin revisar: ${conteo['Sin revisar']} · Con problema: ${conteo['Con problema']}. Los que constan «sin revisar» se revisan solos en el ciclo automático.`] });
      const pendientes = rows.filter(invoice => invoice.kind === 'I' && !salidaCancelado(invoice) &&
        (balances.get(invoice.id)?.balance || 0n) > 0n);
      if (pendientes.length) sections.push({ heading: 'Pendientes de cobro o pago del mes',
        table: { columns: SALIDA_COLUMNAS_PERIODO, rows: pendientes.map(invoice => salidaFilaPeriodo(invoice, rfc, balances)) } });
    }
    return buildPdf({ title: `${conCierre ? 'Cierre mensual' : 'Reporte del periodo'} · ${monthKey}`,
      subtitle: `${rfc}${perfil?.name ? ' · ' + perfil.name : ''}`, generated: salidaGenerado(), sections });
  }
  function salidaPdfSaldos(rfc) {
    /* moneyBalances deja from/to como OBJETOS { rfc, name } de la
       factura: el filtro por RFC va contra su .rfc. Y ojo: no
       excluye canceladas (cada pantalla filtra por su lado, como
       la propuesta de pagos); un saldo de una factura cancelada
       NO se debe ni se cobra, así que aquí se excluyen. */
    const byId = new Map(recordInvoices().map(invoice => [invoice.id, invoice]));
    const balances = moneyBalances().filter(balance => balance.balance > 0n &&
      (!rfc || balance.from?.rfc === rfc || balance.to?.rfc === rfc) &&
      !(byId.get(balance.id) && salidaCancelado(byId.get(balance.id))));
    const fila = balance => {
      const invoice = byId.get(balance.id);
      const cp = balance.receivable ? balance.to : balance.from;
      return [cp?.name || cp?.rfc || '', invoice ? folioLabel(invoice) : '—', String(balance.date || '').slice(0, 10),
        salidaPesos(balance.total), salidaPesos(balance.paid), salidaPesos(balance.balance)];
    };
    const columns = [{ title: 'Contraparte', width: 0.32 }, { title: 'Folio', width: 0.12 },
      { title: 'Fecha', width: 0.11 }, { title: 'Total', width: 0.15, align: 'right' },
      { title: 'Pagado', width: 0.15, align: 'right' }, { title: 'Saldo', width: 0.15, align: 'right' }];
    const totales = lista => [['Total', '', '', salidaPesos(lista.reduce((s, b) => s + b.total, 0n)),
      salidaPesos(lista.reduce((s, b) => s + b.paid, 0n)), salidaPesos(lista.reduce((s, b) => s + b.balance, 0n))]];
    const cobrar = balances.filter(balance => balance.receivable);
    const pagar = balances.filter(balance => balance.payable);
    return buildPdf({ title: 'Saldos al día', subtitle: rfc || 'Todos los perfiles',
      generated: salidaGenerado(), sections: [
        { heading: `Por cobrar (${cobrar.length})`, table: { columns, rows: cobrar.map(fila), totals: totales(cobrar) } },
        { heading: `Por pagar (${pagar.length})`, table: { columns, rows: pagar.map(fila), totals: totales(pagar) } }] });
  }
  function salidaPdfContraparte(rfc, cpRfc) {
    const perfil = salidaPerfil(rfc);
    const rows = salidaDelRfc(rfc).filter(invoice =>
      (invoice.from?.rfc === cpRfc || invoice.to?.rfc === cpRfc));
    const balances = salidaMapaSaldos();
    const nombre = rows.find(invoice => salidaContraparte(invoice, rfc)?.rfc === cpRfc)
      ? salidaContraparte(rows.find(invoice => salidaContraparte(invoice, rfc)?.rfc === cpRfc), rfc)?.name || '' : '';
    const emitidos = rows.filter(invoice => invoice.from?.rfc === rfc);
    const recibidos = rows.filter(invoice => invoice.to?.rfc === rfc);
    const suma = lista => lista.reduce((sum, invoice) => sum + centsOf(invoice.total), 0n);
    /* El resumen no cuenta las canceladas (1.18.0): el titular y la
       tabla contaban distinto en la 1.14.0 — la cancelada 959
       entraba en el total sin avisar. Ahora el resumen suma solo
       lo vivo y las canceladas se nombran en su propia línea. */
    const sumaViva = lista => suma(lista.filter(invoice => !salidaCancelado(invoice)));
    const canceladasCp = rows.filter(invoice => salidaCancelado(invoice));
    let saldoNeto = 0n;
    for (const invoice of rows) {
      const balance = balances.get(invoice.id);
      if (!balance || salidaCancelado(invoice)) continue;
      saldoNeto += invoice.from?.rfc === rfc ? balance.balance : -balance.balance;
    }
    const columns = [{ title: 'Fecha', width: 0.11 }, { title: 'Folio', width: 0.12 },
      { title: 'Sentido', width: 0.11 }, { title: 'Tipo', width: 0.07 },
      { title: 'Total', width: 0.14, align: 'right' }, { title: 'Pagado', width: 0.13, align: 'right' },
      { title: 'Saldo', width: 0.13, align: 'right' }, { title: 'Estado SAT', width: 0.19 }];
    return buildPdf({ title: `Reporte por contraparte · ${cpRfc}`,
      subtitle: `${nombre || cpRfc} frente a ${rfc}${perfil?.name ? ' · ' + perfil.name : ''}`,
      generated: salidaGenerado(), sections: [
        { heading: 'Resumen', lines: [
          `Emitidos a esta contraparte: ${emitidos.filter(invoice => !salidaCancelado(invoice)).length} por ${salidaPesos(sumaViva(emitidos))}.`,
          `Recibidos de esta contraparte: ${recibidos.filter(invoice => !salidaCancelado(invoice)).length} por ${salidaPesos(sumaViva(recibidos))}.`,
          ...(canceladasCp.length ? [`Sin contar ${canceladasCp.length} cancelada(s) por ${salidaPesos(suma(canceladasCp))}: no se deben ni se cobran.`] : []),
          saldoNeto === 0n ? 'Saldo neto: sin saldo pendiente.' :
            saldoNeto > 0n ? `Saldo neto: te debe ${salidaPesos(saldoNeto)} esta contraparte (por cobrar).`
              : `Saldo neto: le debes ${salidaPesos(-saldoNeto)} a esta contraparte (por pagar).`,
          `En letra: ${amountInWords(Number(saldoNeto < 0n ? -saldoNeto : saldoNeto))}`] },
        { heading: 'Movimientos', table: { columns, rows: rows.map(invoice => {
          const balance = balances.get(invoice.id);
          return [String(invoice.date || '').slice(0, 10), folioLabel(invoice),
            invoice.from?.rfc === rfc ? 'Emitido' : 'Recibido', invoice.kind || '',
            salidaPesos(centsOf(invoice.total)),
            invoice.kind === 'I' && balance ? salidaPesos(balance.paid) : '—',
            invoice.kind === 'I' && balance ? salidaPesos(balance.balance) : '—', salidaEstadoSat(invoice.id)];
        }) } }] });
  }
  function salidaPdfDeclaraciones(rfc, ejercicio) {
    /* declaracionesOverview compara el ejercicio como NÚMERO (así
       lo guarda el motor de declaraciones y así lo pide su ruta):
       aquí se pasa igual o el mapa saldría vacío. */
    const view = declaracionesOverview(rfc, Number(ejercicio), now());
    const meses = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
    const estadoTexto = estado => ({ recuperada: 'Recuperada', 'aun-no-toca': 'Aún no toca', 'sin-recuperar': 'Sin recuperar' })[estado] || estado;
    const docPorPeriodo = new Map();
    for (const doc of view.documentos) if (doc.periodo) {
      const prev = docPorPeriodo.get(doc.periodo) || {};
      if (doc.fechaPresentacion && !prev.fecha) prev.fecha = doc.fechaPresentacion;
      if (doc.operacion && !prev.operacion) prev.operacion = doc.operacion;
      docPorPeriodo.set(doc.periodo, prev);
    }
    /* Cabecera sin truncar y color de estado (1.18.0): la columna
       se llama «Presentada el» — cabe entera — y cada fila viaja
       con el color de su estado, como la rejilla de la pantalla.
       El resumen «X de 12» abre el documento: el papel también
       responde antes de la tabla. */
    const columns = [{ title: 'Periodo', width: 0.18 }, { title: 'Declaración', width: 0.11 },
      { title: 'Acuse', width: 0.08 }, { title: 'Presentada el', width: 0.21 },
      { title: 'Nº de operación', width: 0.20 }, { title: 'Estado', width: 0.22 }];
    const COLOR_ESTADO = { presentada: '0.1 0.45 0.3', pendiente: '0.55 0.4 0.05',
      'pagada-sin-acuse': '0.55 0.4 0.05', 'no-toca': '0.45 0.45 0.45', recuperada: '0.1 0.45 0.3', 'sin-recuperar': '0.65 0.15 0.1' };
    /* N11: «Sin recuperar» — no consta en el expediente, no es una
       acusación de incumplimiento. Pieza 12: la intermedia nombra
       la línea del despacho. */
    const ESTADO_PALABRA = { presentada: 'Presentada', pendiente: 'Pendiente', 'no-toca': 'Aún no toca',
      'sin-recuperar': 'Sin recuperar · no consta en tu expediente',
      'pagada-sin-acuse': 'Pagada según la línea del despacho — falta bajar el acuse' };
    const mapaPorPeriodo = new Map((view.mapa?.meses || []).map(mes => [mes.periodo, mes]));
    const rows = view.mensuales.map((mensual, index) => {
      const doc = docPorPeriodo.get(mensual.periodo) || {};
      const delMapa = mapaPorPeriodo.get(mensual.periodo);
      const estado = delMapa?.estado || mensual.estado;
      return { color: COLOR_ESTADO[estado] || '0 0 0', cells: [`${meses[index]} ${ejercicio}`,
        mensual.declaracion ? 'Sí' : '—', mensual.acuse ? 'Sí' : '—',
        doc.fecha ? salidaFechaCorta(doc.fecha) : '—', doc.operacion || '—',
        ESTADO_PALABRA[estado] || estadoTexto(mensual.estado)] };
    });
    const resumenMapa = view.mapa?.resumen;
    const presentadas = resumenMapa ? resumenMapa.presentadas
      : view.mensuales.filter(mensual => mensual.declaracion || mensual.acuse).length;
    const sinRecuperar = resumenMapa ? resumenMapa.sinRecuperar : 0;
    const pagadasSinAcuse = resumenMapa ? resumenMapa.pagadasSinAcuse : 0;
    const pendientes = resumenMapa ? resumenMapa.pendientes : 0;
    const anualDoc = view.documentos.find(doc => doc.tipo === 'anual');
    return buildPdf({ title: `Mapa anual de declaraciones · ${ejercicio}`, subtitle: rfc,
      generated: salidaGenerado(), sections: [
        { heading: 'Resumen', lines: [
          `${presentadas} de 12 meses presentados en ${ejercicio}.` +
            (sinRecuperar ? ` ${sinRecuperar} sin recuperar (no constan en el expediente; no es constancia de que no se presentaran).` : '') +
            (pagadasSinAcuse ? ` ${pagadasSinAcuse} pagada(s) según la línea del despacho, con el acuse por bajar.` : '') +
            (pendientes ? ` ${pendientes} pendiente(s) en plazo.` : '')] },
        { heading: 'Mensuales', table: { columns, rows } },
        { heading: 'Declaración anual', lines: [
          `Declaración anual ${ejercicio}: ${view.anual.declaracion ? 'recuperada' : 'sin recuperar'} · Acuse: ${view.anual.acuse ? 'recuperado' : 'sin recuperar'}.`,
          ...(anualDoc?.fechaPresentacion ? [`Fecha de presentación: ${salidaFechaPalabras(anualDoc.fechaPresentacion)}${anualDoc.operacion ? ' · Nº de operación: ' + anualDoc.operacion : ''}.`] : [])] }] });
  }
  async function salidaCfdiPdf(invoice, rfc) {
    const record = readFileRecord('xml:' + invoice.id);
    if (!record?.buffer) return null;
    const Parser = await resolveInboxParser();
    let full = null;
    try { full = parseCfdiFull(record.buffer, Parser); } catch { full = null; }
    if (!full) return null;
    const aCentavos = value => Math.round((Number(value) || 0) * 100);
    const tipoNombre = { I: 'Ingreso', E: 'Egreso', P: 'Pago', N: 'Nómina', T: 'Traslado' }[full.kind] || full.kind || '';
    const sections = [];
    sections.push({ heading: 'Datos del comprobante', lines: [
      `Folio fiscal (UUID): ${invoice.id}`,
      `Serie y folio: ${folioLabel(invoice)}`,
      `Fecha de emisión: ${salidaFechaPalabras(String(full.fecha || invoice.date || '').slice(0, 10))}`,
      `Tipo de comprobante: ${tipoNombre}`,
      ...([full.formaPago || invoice.fiscal?.paymentForm, full.metodoPago || invoice.fiscal?.paymentMethod].filter(Boolean).length
        ? [`Forma y método de pago: ${salidaFormaMetodo(full.formaPago || invoice.fiscal?.paymentForm || '', full.metodoPago || invoice.fiscal?.paymentMethod || '')}`] : []),
      `Moneda: ${full.moneda || invoice.currency || 'MXN'}`,
      ...(full.lugarExpedicion ? [`Lugar de expedición: ${full.lugarExpedicion}`] : [])] });
    sections.push({ heading: 'Emisor y receptor', lines: [
      `Emisor: ${full.emisor?.nombre || invoice.from?.name || ''} · ${full.emisor?.rfc || invoice.from?.rfc || ''}`,
      `Receptor: ${full.receptor?.nombre || invoice.to?.name || ''} · ${full.receptor?.rfc || invoice.to?.rfc || ''}`] });
    sections.push({ heading: 'Conceptos', table: { columns: [
      { title: 'Cantidad', width: 0.10, align: 'right' }, { title: 'Descripción', width: 0.48 },
      { title: 'Valor unitario', width: 0.21, align: 'right' }, { title: 'Importe', width: 0.21, align: 'right' }],
      rows: (full.conceptos || []).map(concepto => [String(concepto.cantidad ?? ''), concepto.descripcion || '',
        salidaPesos(aCentavos(concepto.valorUnitario)), salidaPesos(aCentavos(concepto.importe))]) } });
    const filasTotales = [['Subtotal', salidaPesos(aCentavos(full.subTotal))]];
    if (Number(full.descuento)) filasTotales.push(['Descuento', '-' + salidaPesos(aCentavos(full.descuento))]);
    for (const traslado of full.impuestos?.traslados || [])
      filasTotales.push([`IVA trasladado${traslado.tasa ? ' (' + (Number(traslado.tasa) * 100).toFixed(0) + '%)' : ''}`, salidaPesos(aCentavos(traslado.importe))]);
    for (const retencion of full.impuestos?.retenciones || [])
      filasTotales.push(['Retención', '-' + salidaPesos(aCentavos(retencion.importe))]);
    sections.push({ heading: 'Totales', table: { columns: [
      { title: 'Concepto', width: 0.70 }, { title: 'Importe', width: 0.30, align: 'right' }],
      rows: filasTotales, totals: [['TOTAL', salidaPesos(aCentavos(full.total))]] },
      lines: [`Total en letra: ${amountInWords(aCentavos(full.total), full.moneda || 'MXN')}`] });
    if (full.pagos?.pagos?.length) {
      const filas = [];
      for (const pago of full.pagos.pagos) for (const doc of pago.documentos || [])
        filas.push([String(pago.fechaPago || '').slice(0, 10), `${doc.serie || ''}${doc.serie ? '-' : ''}${doc.folio || ''}`,
          doc.idDocumento || '', salidaPesos(aCentavos(doc.impSaldoAnt)), salidaPesos(aCentavos(doc.impPagado)), salidaPesos(aCentavos(doc.impSaldoInsoluto))]);
      sections.push({ heading: 'Pagos relacionados (complemento)',
        note: 'Comprobante de pago (REP): acredita pagos de otras facturas; no suma un total propio.', table: { columns: [
        { title: 'Fecha de pago', width: 0.13 }, { title: 'Folio relacionado', width: 0.13 },
        { title: 'UUID relacionado', width: 0.26 }, { title: 'Saldo anterior', width: 0.16, align: 'right' },
        { title: 'Importe pagado', width: 0.16, align: 'right' }, { title: 'Saldo insoluto', width: 0.16, align: 'right' }], rows: filas } });
    }
    if (full.timbre) sections.push({ heading: 'Timbre fiscal digital', lines: [
      `Fecha de timbrado: ${salidaFechaPalabras(String(full.timbre.fechaTimbrado || '').slice(0, 10))}${String(full.timbre.fechaTimbrado || '').length > 11 ? ', ' + String(full.timbre.fechaTimbrado).slice(11, 19) : ''}`,
      `Certificado del SAT: ${full.timbre.noCertificadoSAT || ''} · Proveedor: ${full.timbre.rfcProvCertif || ''}`] });
    /* QR verdadero de verificación (1.21.0): la URL oficial del
       SAT construida desde ESTE comprobante (qr-cfdi.mjs). Sin
       timbre o sin cualquiera de los datos que la especificación
       exige, el PDF lo dice en palabras y no imprime código
       alguno: un QR inventado sería peor que ninguno. */
    const urlVerificacion = full.timbre ? verificationUrl({ uuid: full.timbre.uuid || invoice.id,
      emisor: full.emisor?.rfc || invoice.from?.rfc, receptor: full.receptor?.rfc || invoice.to?.rfc,
      total: full.total, sello: full.timbre.selloCfd }) : null;
    if (urlVerificacion) sections.push({ heading: 'Verificación en el SAT', qr: qrMatrix(urlVerificacion), qrCaption: [
      'Escanea este código con el móvil para verificar el comprobante en el SAT.',
      'La consulta oficial confirma el folio fiscal, el RFC del emisor y del receptor, el total y el estado del comprobante.'] });
    else sections.push({ heading: 'Verificación en el SAT', lines: [
      full.timbre ? 'Este comprobante no lleva código QR de verificación: faltan datos del timbre fiscal (sello, RFC o total con la forma que pide el SAT) y PacoSAT no imprime un código que no sea el verdadero.'
        : 'Este comprobante no lleva código QR de verificación porque no está timbrado: sin Timbre Fiscal Digital no existe folio fiscal que verificar en el SAT.'] });
    return buildPdf({ title: `Comprobante ${folioLabel(invoice)}`,
      subtitle: `${full.emisor?.nombre || invoice.from?.name || ''} > ${full.receptor?.nombre || invoice.to?.name || ''}`,
      generated: salidaGenerado(), sections });
  }
  function salidaZipPaquete({ rfc, monthKey = '', year = '', ids = null, conCierre = false }) {
    const balances = salidaMapaSaldos();
    let invoices = ids ? recordInvoices().filter(invoice => ids.includes(invoice.id))
      : salidaDelRfc(rfc, monthKey);
    if (!ids && year) invoices = invoices.filter(invoice => String(invoice.date || '').startsWith(year));
    invoices.sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.id).localeCompare(String(b.id)));
    const entries = [];
    const indice = [['Folio', 'UUID', 'Fecha', 'Sentido', 'Contraparte RFC', 'Contraparte', 'Tipo', 'Total', 'Estado SAT', 'Estado de pago', 'Archivo']];
    let vigentes = 0n, canceladosTotal = 0n, cuentaCancelados = 0, sinXml = 0;
    let vigentesEmitidos = 0n, vigentesRecibidos = 0n, cuentaEmitidos = 0, cuentaRecibidos = 0;
    for (const invoice of invoices) {
      const cancelado = salidaCancelado(invoice);
      const sentido = invoice.from?.rfc === rfc ? 'emitidos' : 'recibidos';
      const [anio, mes] = String(invoice.date || '').slice(0, 7).split('-');
      const carpeta = cancelado ? `${rfc}/cancelados/${anio || 'sin-fecha'}/${mes || '00'}`
        : `${rfc}/${sentido}/${anio || 'sin-fecha'}/${mes || '00'}`;
      const nombre = salidaNombreArchivo(invoice, rfc);
      const record = readFileRecord('xml:' + invoice.id);
      let archivo = 'SIN XML GUARDADO';
      if (record?.buffer) {
        entries.push({ name: `${carpeta}/${nombre}.xml`, data: record.buffer });
        archivo = `${nombre}.xml`;
      } else sinXml++;
      const cp = salidaContraparte(invoice, rfc);
      indice.push([folioLabel(invoice), invoice.id, String(invoice.date || '').slice(0, 10), sentido,
        cp?.rfc || '', cp?.name || '', invoice.kind || '', moneyText(centsOf(invoice.total)),
        salidaEstadoSat(invoice.id),
        /* N4 (1.22.0): una cancelada no se debe — su «Estado de
           pago» es «—», nunca «Pendiente» (el manifiesto del mismo
           ZIP ya la cuenta como cancelada). */
        cancelado ? '—' : salidaEstadoPago(invoice, balances), archivo]);
      if (cancelado) { canceladosTotal += centsOf(invoice.total); cuentaCancelados++; }
      else { vigentes += centsOf(invoice.total);
        if (sentido === 'emitidos') { vigentesEmitidos += centsOf(invoice.total); cuentaEmitidos++; }
        else { vigentesRecibidos += centsOf(invoice.total); cuentaRecibidos++; } }
    }
    const celda = value => /[",\n]/.test(String(value)) ? '"' + String(value).replace(/"/g, '""') + '"' : String(value);
    entries.push({ name: `${rfc}/indice.csv`, data: indice.map(row => row.map(celda).join(',')).join('\n') });
    if (conCierre && monthKey) {
      entries.push({ name: 'resumen-cierre.pdf', data: salidaPdfPeriodo(rfc, monthKey, true) });
      for (const [kind, suffix] of [['constancia', 'csf'], ['opinion', '32d']]) {
        const row = db.prepare('SELECT fileId FROM sat_documents WHERE rfc = ? AND kind = ? ORDER BY issuedAt DESC LIMIT 1').get(rfc, kind);
        const docRecord = row?.fileId ? readFileRecord(row.fileId) : null;
        /* En su carpeta «Documentos del SAT» (1.18.0): en la raíz
           viajaban sueltos entre carpetas de comprobantes. El
           nombre sigue la convención RFC-csf.pdf / RFC-32d.pdf. */
        if (docRecord?.buffer) entries.push({ name: `Documentos del SAT/${rfc}-${suffix}.pdf`, data: docRecord.buffer });
      }
      /* El índice también en Excel (1.18.0): mismo contenido que
         el CSV, en el formato que la contadora abre sin pelear. */
      entries.push({ name: `${rfc}/indice.xlsx`, data: buildXlsx({ sheets: [{ name: 'Índice', columns: [
        { title: 'Folio', width: 14 }, { title: 'UUID', width: 38 }, { title: 'Fecha', type: 'date', width: 12 },
        { title: 'Sentido', width: 11 }, { title: 'Contraparte RFC', width: 15 }, { title: 'Contraparte', width: 38 },
        { title: 'Tipo', width: 8 }, { title: 'Total', type: 'money', width: 15, total: true },
        { title: 'Estado SAT', width: 13 }, { title: 'Estado de pago', width: 13 }, { title: 'Archivo', width: 30 }],
        rows: indice.slice(1).map(row => [row[0], row[1], row[2], row[3], row[4], row[5], row[6],
          Number(centsOf(row[7])), row[8], row[9], row[10]]), totals: { label: 'Total del índice' } }] }) });
    }
    const alcance = ids ? `Selección a la carta: ${invoices.length} comprobante(s)` :
      monthKey ? `Periodo ${monthKey}` : year ? `Ejercicio ${year}` : 'Todo el expediente del RFC';
    entries.push({ name: 'manifiesto.txt', data: [
      'PacoSAT · Paquete de comprobantes', salidaGenerado(), `RFC del expediente: ${rfc}`, `Alcance: ${alcance}`,
      `Comprobantes incluidos: ${invoices.length} (${cuentaCancelados} cancelados, en su carpeta aparte)`,
      `Total vigente: ${salidaPesos(vigentes)} — emitidos: ${cuentaEmitidos} por ${salidaPesos(vigentesEmitidos)} · recibidos: ${cuentaRecibidos} por ${salidaPesos(vigentesRecibidos)} · Total cancelado: ${salidaPesos(canceladosTotal)}`,
      sinXml ? `AVISO: ${sinXml} comprobante(s) sin XML guardado (constan en el índice).` : 'Todos los comprobantes llevan su XML.',
      'El índice (indice.csv) trae folio, UUID, estado en el SAT y estado de pago de cada comprobante.',
      'Los nombres de archivo siguen la forma AAAA-MM-DD_RFC-contraparte_FOLIO.xml.'].join('\n') });
    return zipBuffers(entries);
  }
  function salidaXlsxFacturas(rfc, monthKey) {
    const balances = salidaMapaSaldos();
    const columns = [
      { title: 'Fecha', type: 'date', width: 12 }, { title: 'Folio', width: 12 },
      { title: 'Contraparte', width: 38 }, { title: 'RFC contraparte', width: 15 },
      { title: 'Tipo', width: 8 }, { title: 'Método', width: 9 }, { title: 'Moneda', width: 9 },
      { title: 'Subtotal', type: 'money', width: 15, total: true },
      { title: 'IVA trasladado', type: 'money', width: 15, total: true },
      { title: 'Total', type: 'money', width: 15, total: true },
      { title: 'Estado SAT', width: 13 }, { title: 'Estado de pago', width: 13 }, { title: 'UUID', width: 38 }];
    const fila = invoice => {
      const cp = salidaContraparte(invoice, rfc);
      const iva = (invoice.fiscal?.transferred || []).filter(t => t.tax === '002')
        .reduce((sum, t) => sum + centsOf(t.amount), 0n);
      return [String(invoice.date || '').slice(0, 10), folioLabel(invoice), cp?.name || '', cp?.rfc || '',
        invoice.kind || '', invoice.fiscal?.paymentMethod || '', invoice.currency || 'MXN',
        invoice.fiscal ? Number(centsOf(invoice.fiscal.subTotal || '0')) : null, Number(iva),
        Number(centsOf(invoice.total)), salidaEstadoSat(invoice.id), salidaEstadoPago(invoice, balances), invoice.id];
    };
    const rows = salidaDelRfc(rfc, monthKey);
    const perfil = salidaPerfil(rfc);
    const emitidasRows = rows.filter(i => i.from?.rfc === rfc);
    const recibidasRows = rows.filter(i => i.to?.rfc === rfc);
    const sumaTotal = lista => lista.reduce((sum, i) => sum + centsOf(i.total), 0n);
    /* N1 (1.22.0): el Excel es el archivo que va a la contadora y
       sumaba las CANCELADAS donde el PDF del mismo mes dice «sin
       canceladas» (diferencia probada en la auditoría: exactamente
       la cancelada). Criterio único: las canceladas constan en su
       fila, marcadas en «Estado SAT», y quedan FUERA de todo
       total; la fila de totales se titula como en el PDF. */
    const vivas = lista => lista.filter(i => !salidaCancelado(i));
    const canceladasDe = lista => lista.filter(i => salidaCancelado(i));
    const resumenCanceladas = [...canceladasDe(emitidasRows), ...canceladasDe(recibidasRows)];
    return buildXlsx({ sheets: [
      /* Hoja «Resumen» primero (1.18.0): qué es el archivo, de qué
         mes y RFC, y sus totales — sin abrir las demás hojas. */
      { name: 'Resumen', columns: [{ title: 'Concepto', width: 26 }, { title: 'Valor', width: 62 }], rows: [
        ['Qué es este archivo', 'Facturas ' + (monthKey ? 'de ' + monthKey : 'del expediente completo') +
          ' de ' + rfc + (perfil?.name ? ' · ' + perfil.name : '')],
        ['Emitidas', vivas(emitidasRows).length + ' por ' + salidaPesos(sumaTotal(vivas(emitidasRows))) + ' (sin canceladas)'],
        ['Recibidas', vivas(recibidasRows).length + ' por ' + salidaPesos(sumaTotal(vivas(recibidasRows))) + ' (sin canceladas)'],
        ...(resumenCanceladas.length ? [['Canceladas (fuera de los totales)',
          resumenCanceladas.length + ' por ' + salidaPesos(sumaTotal(resumenCanceladas)) + ' — constan marcadas en sus hojas']] : []),
        ['Generado', salidaGenerado()]] },
      { name: 'Emitidas', columns, rows: emitidasRows.map(fila),
        totals: { label: 'Total emitidas (sin canceladas)', skip: emitidasRows.map(i => salidaCancelado(i)) } },
      { name: 'Recibidas', columns, rows: recibidasRows.map(fila),
        totals: { label: 'Total recibidas (sin canceladas)', skip: recibidasRows.map(i => salidaCancelado(i)) } }] });
  }
  function salidaXlsxSaldos(rfc, sentido) {
    const byId = new Map(recordInvoices().map(invoice => [invoice.id, invoice]));
    const balances = moneyBalances().filter(balance => balance.balance > 0n &&
      (sentido === 'cobrar' ? balance.receivable : balance.payable) &&
      (!rfc || balance.from?.rfc === rfc || balance.to?.rfc === rfc) &&
      !(byId.get(balance.id) && salidaCancelado(byId.get(balance.id))));
    const columns = [
      { title: 'Contraparte', width: 38 }, { title: 'RFC contraparte', width: 15 }, { title: 'Folio', width: 12 },
      { title: 'Fecha', type: 'date', width: 12 }, { title: 'Método', width: 9 },
      { title: 'Total', type: 'money', width: 15, total: true }, { title: 'Pagado', type: 'money', width: 15, total: true },
      { title: 'Saldo', type: 'money', width: 15, total: true }, { title: 'UUID', width: 38 }];
    const rows = balances.map(balance => {
      const invoice = byId.get(balance.id);
      const cp = sentido === 'cobrar' ? balance.to : balance.from;
      return [cp?.name || '', cp?.rfc || '', invoice ? folioLabel(invoice) : '—',
        String(balance.date || '').slice(0, 10), balance.method || '', Number(balance.total),
        Number(balance.paid), Number(balance.balance), balance.id];
    });
    return buildXlsx({ sheets: [{ name: sentido === 'cobrar' ? 'Por cobrar' : 'Por pagar', columns, rows,
      totals: { label: sentido === 'cobrar' ? 'Total por cobrar' : 'Total por pagar' } }] });
  }
  function salidaXlsxComplementos(rfc) {
    const aCentavos = value => Math.round((Number(value) || 0) * 100);
    const columns = [
      { title: 'Fecha del REP', type: 'date', width: 13 }, { title: 'Folio REP', width: 12 },
      { title: 'Fecha de pago', type: 'date', width: 13 }, { title: 'Contraparte', width: 34 },
      { title: 'Folio relacionado', width: 14 }, { title: 'Parcialidad', type: 'int', width: 11 },
      { title: 'Saldo anterior', type: 'money', width: 15, total: true },
      { title: 'Importe pagado', type: 'money', width: 15, total: true },
      { title: 'Saldo insoluto', type: 'money', width: 15, total: true },
      { title: 'UUID relacionado', width: 38 }, { title: 'UUID del REP', width: 38 }];
    const rows = [];
    for (const invoice of salidaDelRfc(rfc)) {
      if (invoice.kind !== 'P' || !invoice.fiscal?.payments) continue;
      const cp = salidaContraparte(invoice, rfc);
      for (const pago of invoice.fiscal.payments.pagos || []) for (const doc of pago.documentos || [])
        rows.push([String(invoice.date || '').slice(0, 10), folioLabel(invoice),
          String(pago.fechaPago || '').slice(0, 10), cp?.name || '',
          `${doc.serie || ''}${doc.serie ? '-' : ''}${doc.folio || ''}`, Number(doc.numParcialidad) || null,
          aCentavos(doc.impSaldoAnt), aCentavos(doc.impPagado), aCentavos(doc.impSaldoInsoluto),
          doc.idDocumento || '', invoice.id]);
    }
    return buildXlsx({ sheets: [{ name: 'Complementos de pago', columns, rows, totals: { label: 'Total' } }] });
  }
  function salidaXlsxListados() {
    const view = listsOverview();
    const columns = [
      { title: 'RFC', width: 15 }, { title: 'Nombre', width: 38 }, { title: 'Tipo', width: 11 },
      { title: 'Lista', width: 18 }, { title: 'Detalle', width: 16 }, { title: 'Publicado', type: 'date', width: 12 },
      { title: 'Recibidos', type: 'money', width: 16, total: true }, { title: 'Emitidos', type: 'money', width: 16, total: true },
      { title: 'Nº recibidos', type: 'int', width: 12 }, { title: 'Nº emitidos', type: 'int', width: 12 },
      { title: 'Saldo por cobrar', type: 'money', width: 16, total: true }];
    const rows = [];
    for (const cp of view.counterparts || []) for (const hit of cp.hits || [])
      rows.push([cp.rfc, cp.name || '', cp.kind || '', hit.label || '', hit.detail || '', String(hit.published || '').slice(0, 10),
        Number(centsOf(cp.exposure?.received || '0')), Number(centsOf(cp.exposure?.issued || '0')),
        cp.exposure?.receivedCount || 0, cp.exposure?.issuedCount || 0,
        cp.detalle?.saldoPorCobrar ? Number(centsOf(typeof cp.detalle.saldoPorCobrar === 'object' ? (cp.detalle.saldoPorCobrar.total || '0') : cp.detalle.saldoPorCobrar)) : null]);
    return buildXlsx({ sheets: [{ name: 'Contrapartes en listados', columns, rows, totals: { label: 'Total exposición' } }] });
  }
  function salidaXlsxPagos(rfc, preparationId) {
    const row = preparationId
      ? db.prepare('SELECT payload FROM pay_preparations WHERE id = ? AND rfc = ?').get(preparationId, rfc)
      : db.prepare('SELECT payload FROM pay_preparations WHERE rfc = ? ORDER BY created DESC LIMIT 1').get(rfc);
    if (!row?.payload) return null;
    const prep = JSON.parse(row.payload);
    const columns = [
      { title: 'Beneficiario', width: 38 }, { title: 'RFC', width: 15 }, { title: 'Cuenta / CLABE', width: 20 },
      { title: 'Motivo de pago', width: 34 }, { title: 'Folio', width: 12 },
      { title: 'Importe', type: 'money', width: 15, total: true }];
    const fila = linea => [linea.nombre || '', linea.rfc || '', linea.cuenta || linea.clabe || '',
      linea.motivo || linea.concepto || '', linea.folio || '', Number(linea.totalCents) || 0];
    const sheets = [{ name: 'Resumen', columns: [{ title: 'Concepto', width: 26 }, { title: 'Valor', width: 44 }],
      rows: [['Preparación del mes', prep.month || ''], ['Descripción del grupo', prep.group?.descripcion || ''],
        ['Cuenta de retiro', prep.group?.cuentaRetiro || ''], ['Fecha de cargo', prep.group?.fechaCargo || ''],
        ['Fecha de abono', prep.group?.fechaAbono || ''], ['Operaciones', String(prep.operaciones || 0)],
        ['Total preparado', salidaPesos(prep.totalCents || 0)]] }];
    for (const [key, name] of [['bbva', 'Grupo BBVA'], ['interbancario', 'Grupo interbancario'], ['speiIndividual', 'SPEI individual']])
      if (prep[key]?.lines?.length) sheets.push({ name, columns, rows: prep[key].lines.map(fila), totals: { label: 'Total ' + name } });
    return buildXlsx({ sheets });
  }

  /* ===== Reporte Mano Fil (1.16.0, propuesta P12 de la auditoría) =====
     El informe del negocio para Rodrigo y José Javier, montado SOBRE
     la capa de salidas: mismos constructores (buildPdf / buildXlsx)
     y las cifras verdad del servidor (moneyBalances, los flujos de
     los REP y los pagos marcados a mano). Solo datos de Mano Fil —
     el RFC va FIJO (MANOFIL_SEED_RFC): ningún otro negocio se mezcla
     en este informe, por la regla de Paco de que cada negocio se
     explica solo en su propio contexto. El resumen responde primero
     (cuánto entró, cuánto salió, qué falta) y el detalle va detrás.
     Las canceladas se enseñan marcadas pero NO suman en ningún
     total. Lo que el expediente no prueba, se dice: los impuestos
     salen de las declaraciones presentadas (fecha y nº de operación
     recuperados), porque PacoSAT no guarda líneas de captura pagadas
     como dato; la nómina sale de los CFDI de tipo N del periodo. */
  const MANOFIL_RFC = MANOFIL_SEED_RFC;
  const manofilMesLargo = monthKey => {
    const [y, m] = String(monthKey).split('-').map(Number);
    const texto = new Intl.DateTimeFormat('es-MX', { month: 'long', year: 'numeric', timeZone: 'UTC' })
      .format(new Date(Date.UTC(y, m - 1, 1)));
    return texto.charAt(0).toUpperCase() + texto.slice(1);
  };
  const manofilFechaLarga = iso => salidaFechaLarga.format(new Date(String(iso).slice(0, 10) + 'T12:00:00Z'));
  function manofilPeriodoDe(input) {
    if (/^\d{4}-\d{2}$/.test(String(input?.month || ''))) {
      const month = String(input.month);
      const [y, m] = month.split('-').map(Number);
      if (m < 1 || m > 12) return null;
      const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
      return { from: month + '-01', to: month + '-' + String(last).padStart(2, '0'),
        clave: month, etiqueta: manofilMesLargo(month) };
    }
    const from = String(input?.from || ''), to = String(input?.to || '');
    if (validDate(from) && validDate(to) && from <= to)
      return { from, to, clave: from + '_a_' + to,
        etiqueta: 'del ' + manofilFechaLarga(from) + ' al ' + manofilFechaLarga(to) };
    return null;
  }
  /* Flujos de dinero con fecha, desde la misma evidencia que
     alimenta moneyBalances: los documentos relacionados de los REP
     (con su fecha de pago), los pagos marcados a mano (con su fecha)
     y los PUE sin otra evidencia (pagados al emitirse, la regla de
     Dinero). La dirección sale de la factura destino: si Mano Fil la
     emitió, es un cobro; si la recibió, es un pago a proveedor. */
  function manofilFlujos(rfc) {
    const byId = new Map(recordInvoices().map(invoice => [invoice.id, invoice]));
    const eventos = [];
    const empujar = (fecha, tipo, invoice, importe, via) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha) || importe <= 0n) return;
      eventos.push({ fecha, tipo, invoice, importe, via });
    };
    for (const rep of recordInvoices()) {
      if (rep.kind !== 'P' || !rep.fiscal?.payments) continue;
      for (const pago of rep.fiscal.payments.pagos || []) for (const doc of pago.documentos || []) {
        const target = byId.get(doc.idDocumento);
        if (!target || target.kind !== 'I' || salidaCancelado(target)) continue;
        const fecha = String(pago.fechaPago || rep.date || '').slice(0, 10);
        if (target.from?.rfc === rfc) empujar(fecha, 'cobro', target, centsOf(doc.impPagado), 'Complemento de pago');
        else if (target.to?.rfc === rfc) empujar(fecha, 'pago', target, centsOf(doc.impPagado), 'Complemento de pago');
      }
    }
    for (const manual of db.prepare('SELECT * FROM manual_payments').all()) {
      const target = byId.get(manual.uuid);
      if (!target || target.kind !== 'I' || salidaCancelado(target)) continue;
      const fecha = manual.at ? day(manual.at) : '';
      if (target.from?.rfc === rfc) empujar(fecha, 'cobro', target, centsOf(manual.importe), 'Marcado a mano');
      else if (target.to?.rfc === rfc) empujar(fecha, 'pago', target, centsOf(manual.importe), 'Marcado a mano');
    }
    const conEventos = new Set(eventos.map(evento => evento.invoice.id));
    for (const invoice of recordInvoices()) {
      if (invoice.kind !== 'I' || invoice.fiscal?.paymentMethod !== 'PUE' ||
          salidaCancelado(invoice) || conEventos.has(invoice.id)) continue;
      const fecha = String(invoice.date || '').slice(0, 10);
      if (invoice.from?.rfc === rfc) empujar(fecha, 'cobro', invoice, centsOf(invoice.total), 'PUE · pagada al emitirse');
      else if (invoice.to?.rfc === rfc) empujar(fecha, 'pago', invoice, centsOf(invoice.total), 'PUE · pagada al emitirse');
    }
    return eventos.sort((a, b) => a.fecha.localeCompare(b.fecha) || String(a.invoice.id).localeCompare(String(b.invoice.id)));
  }
  function manofilDatos(periodo) {
    const rfc = MANOFIL_RFC;
    const enRango = fecha => { const d = String(fecha || '').slice(0, 10); return d >= periodo.from && d <= periodo.to; };
    const balances = salidaMapaSaldos();
    const byId = new Map(recordInvoices().map(invoice => [invoice.id, invoice]));
    const delPeriodo = salidaDelRfc(rfc).filter(invoice => enRango(invoice.date));
    const emitidos = delPeriodo.filter(invoice => invoice.kind === 'I' && invoice.from?.rfc === rfc);
    const recibidos = delPeriodo.filter(invoice => invoice.kind === 'I' && invoice.to?.rfc === rfc);
    const nomina = delPeriodo.filter(invoice => invoice.kind === 'N');
    const flujos = manofilFlujos(rfc).filter(evento => enRango(evento.fecha));
    const cobros = flujos.filter(evento => evento.tipo === 'cobro');
    const pagos = flujos.filter(evento => evento.tipo === 'pago');
    const sumaTotal = lista => lista.reduce((sum, invoice) => sum + centsOf(invoice.total), 0n);
    /* Declaraciones PRESENTADAS dentro del periodo (la fecha de
       presentación es cuando el impuesto se pagó/presentó), con su
       acuse si también se recuperó. */
    const acuses = new Set(db.prepare("SELECT periodo, operacion FROM declaraciones WHERE rfc=? AND clase='acuse'").all(rfc)
      .map(row => (row.periodo || '') + '|' + (row.operacion || '')));
    const declaraciones = db.prepare("SELECT * FROM declaraciones WHERE rfc=? AND clase='declaracion' ORDER BY fechaPresentacion, periodo").all(rfc)
      .filter(row => enRango(row.fechaPresentacion))
      .map(row => ({ periodo: row.periodo || String(row.ejercicio || ''), tipo: row.tipo || 'mensual',
        fecha: String(row.fechaPresentacion || '').slice(0, 10), operacion: row.operacion || '',
        acuse: acuses.has((row.periodo || '') + '|' + (row.operacion || '')) }));
    /* Saldos abiertos: la foto de hoy (como el PDF de saldos), sin
       saldos de facturas canceladas, que no se deben ni se cobran. */
    const abiertoSano = balance => { const inv = byId.get(balance.id); return inv && !salidaCancelado(inv); };
    const porFecha = (a, b) => String(a.date).localeCompare(String(b.date)) || String(a.id).localeCompare(String(b.id));
    const porCobrar = [...balances.values()].filter(b => b.balance > 0n && b.from?.rfc === rfc && abiertoSano(b)).sort(porFecha);
    const porPagar = [...balances.values()].filter(b => b.balance > 0n && b.to?.rfc === rfc && abiertoSano(b)).sort(porFecha);
    const bancosVista = banksOverview();
    const bancos = bancosVista.accounts.filter(account => account.position)
      .map(account => ({ banco: account.bank || 'Sin banco', cuenta: account.name || '',
        ultimos: account.last4 || '', mes: account.position.month, saldo: centsOf(account.position.closing) }));
    const vigentes = lista => lista.filter(invoice => !salidaCancelado(invoice));
    return { perfil: salidaPerfil(rfc), emitidos, recibidos, nomina, cobros, pagos, declaraciones,
      porCobrar, porPagar, bancos, bancosMes: bancosVista.position.asOf,
      resumen: {
        facturado: sumaTotal(vigentes(emitidos)),
        cobradoPeriodo: cobros.reduce((sum, evento) => sum + evento.importe, 0n),
        pagadoPeriodo: pagos.reduce((sum, evento) => sum + evento.importe, 0n),
        /* N12 (1.22.0): la nómina sumaba SIN excluir canceladas,
           la única excepción del reporte al criterio único. */
        nominaTotal: sumaTotal(vigentes(nomina)),
        porCobrarTotal: porCobrar.reduce((sum, b) => sum + b.balance, 0n),
        porPagarTotal: porPagar.reduce((sum, b) => sum + b.balance, 0n),
        bancosTotal: centsOf(bancosVista.position.total),
        canceladosEmitidos: emitidos.filter(invoice => salidaCancelado(invoice)),
        canceladosRecibidos: recibidos.filter(invoice => salidaCancelado(invoice)) } };
  }
  function reporteManofilPdf(periodo) {
    const rfc = MANOFIL_RFC;
    const datos = manofilDatos(periodo);
    const r = datos.resumen;
    const balances = salidaMapaSaldos();
    const fecha10 = value => String(value || '').slice(0, 10);
    const sections = [];
    const emitidosVigentes = datos.emitidos.filter(invoice => !salidaCancelado(invoice));
    sections.push({ heading: 'Resumen · el periodo en pocas líneas', lines: [
      `Facturado en el periodo: ${salidaPesos(r.facturado)} (${emitidosVigentes.length} factura(s) emitida(s)` +
        (r.canceladosEmitidos.length ? `; ${r.canceladosEmitidos.length} cancelada(s) en el periodo no suman en ningún total` : '') + ').',
      `Entró · cobrado en el periodo: ${salidaPesos(r.cobradoPeriodo)}.`,
      `Salió · pagado a proveedores en el periodo: ${salidaPesos(r.pagadoPeriodo)}.`,
      `Nómina del periodo: ${salidaPesos(r.nominaTotal)} (${datos.nomina.filter(invoice => !salidaCancelado(invoice)).length} CFDI de nómina vigentes; las canceladas no suman).`,
      datos.declaraciones.length
        ? `Impuestos: ${datos.declaraciones.length} declaración(es) presentada(s) dentro del periodo (el detalle, en su sección).`
        : 'Impuestos: ninguna declaración consta presentada dentro del periodo en el expediente.',
      `Qué falta · por cobrar: ${salidaPesos(r.porCobrarTotal)} · por pagar: ${salidaPesos(r.porPagarTotal)} (saldos abiertos a la fecha de este reporte).`,
      datos.bancos.length
        ? `Saldo en bancos: ${salidaPesos(r.bancosTotal)} según el último estado archivado de cada cuenta (${datos.bancosMes}).`
        : 'Saldo en bancos: no hay estados de cuenta archivados en el expediente.'] });
    const colFact = [{ title: 'Folio', width: 0.11 }, { title: 'Fecha', width: 0.10 },
      { title: 'Contraparte', width: 0.27 }, { title: 'Total', width: 0.13, align: 'right' },
      { title: 'Cobrado/Pagado', width: 0.13, align: 'right' }, { title: 'Saldo', width: 0.12, align: 'right' },
      { title: 'Estado SAT', width: 0.14 }];
    const filaFact = (invoice, cp) => { const b = balances.get(invoice.id);
      return [folioLabel(invoice), fecha10(invoice.date), cp?.name || cp?.rfc || '', salidaPesos(centsOf(invoice.total)),
        invoice.kind === 'I' && b ? salidaPesos(b.paid) : '—', invoice.kind === 'I' && b ? salidaPesos(b.balance) : '—',
        salidaEstadoSat(invoice.id)]; };
    const totalesFact = lista => { const vig = lista.filter(invoice => !salidaCancelado(invoice));
      const sum = pick => vig.reduce((s, invoice) => s + pick(invoice), 0n);
      return [['Total (sin canceladas)', '', '', salidaPesos(sum(i => centsOf(i.total))),
        salidaPesos(sum(i => balances.get(i.id)?.paid || 0n)), salidaPesos(sum(i => balances.get(i.id)?.balance || 0n)), '']]; };
    const notaCanceladas = lista => lista.length
      ? 'Cancelada(s) en el periodo: ' + lista.map(invoice => 'folio ' + folioLabel(invoice) +
          ' (' + salidaPesos(centsOf(invoice.total)) + ')').join(', ') + '. Se enseñan marcadas y NO suman en los totales.' : undefined;
    sections.push({ heading: 'Lo facturado y lo cobrado · facturas emitidas',
      note: notaCanceladas(r.canceladosEmitidos),
      lines: datos.emitidos.length ? [] : ['Sin facturas emitidas en el periodo.'],
      table: datos.emitidos.length ? { columns: colFact,
        rows: datos.emitidos.map(invoice => filaFact(invoice, invoice.to)), totals: totalesFact(datos.emitidos) } : undefined });
    sections.push({ heading: 'Pagos a proveedores en el periodo',
      lines: datos.pagos.length ? [] : ['Sin pagos a proveedores con fecha en el periodo según el expediente (complementos, PUE y pagos marcados).'],
      table: datos.pagos.length ? { columns: [
          { title: 'Fecha', width: 0.11 }, { title: 'Proveedor', width: 0.30 }, { title: 'Folio de la factura', width: 0.15 },
          { title: 'Vía', width: 0.22 }, { title: 'Importe', width: 0.22, align: 'right' }],
        rows: datos.pagos.map(evento => [evento.fecha, evento.invoice.from?.name || evento.invoice.from?.rfc || '',
          folioLabel(evento.invoice), evento.via, salidaPesos(evento.importe)]),
        totals: [['Total pagado', '', '', '', salidaPesos(r.pagadoPeriodo)]] } : undefined });
    const colSaldo = [{ title: 'Contraparte', width: 0.29 }, { title: 'Folio', width: 0.11 },
      { title: 'Fecha', width: 0.10 }, { title: 'Total', width: 0.14, align: 'right' },
      { title: 'Pagado', width: 0.13, align: 'right' }, { title: 'Saldo', width: 0.13, align: 'right' },
      { title: 'UUID', width: 0.10 }];
    const byIdSaldo = new Map(recordInvoices().map(i => [i.id, i]));
    const filaSaldoDe = balance => { const inv = byIdSaldo.get(balance.id);
      const cp = balance.receivable ? balance.to : balance.from;
      return [cp?.name || cp?.rfc || '', inv ? folioLabel(inv) : '—', fecha10(balance.date),
        salidaPesos(balance.total), salidaPesos(balance.paid), salidaPesos(balance.balance), String(balance.id).slice(0, 8) + '…']; };
    const totalesSaldo = lista => [['Total', '', '', salidaPesos(lista.reduce((s, b) => s + b.total, 0n)),
      salidaPesos(lista.reduce((s, b) => s + b.paid, 0n)), salidaPesos(lista.reduce((s, b) => s + b.balance, 0n)), '']];
    sections.push({ heading: 'Qué se debe y a quién · por pagar',
      lines: datos.porPagar.length ? [] : ['Sin saldos por pagar abiertos.'],
      table: datos.porPagar.length ? { columns: colSaldo, rows: datos.porPagar.map(filaSaldoDe), totals: totalesSaldo(datos.porPagar) } : undefined });
    sections.push({ heading: 'Por cobrar',
      lines: datos.porCobrar.length ? [] : ['Sin saldos por cobrar abiertos.'],
      table: datos.porCobrar.length ? { columns: colSaldo, rows: datos.porCobrar.map(filaSaldoDe), totals: totalesSaldo(datos.porCobrar) } : undefined });
    sections.push({ heading: 'Facturas recibidas del periodo',
      note: notaCanceladas(r.canceladosRecibidos),
      lines: datos.recibidos.length ? [] : ['Sin facturas recibidas en el periodo.'],
      table: datos.recibidos.length ? { columns: colFact,
        rows: datos.recibidos.map(invoice => filaFact(invoice, invoice.from)), totals: totalesFact(datos.recibidos) } : undefined });
    sections.push({ heading: 'Impuestos del periodo',
      note: 'Las declaraciones que constan PRESENTADAS dentro del periodo, recuperadas del portal del SAT: el impuesto se pagó al presentarlas. PacoSAT no guarda líneas de captura como dato, así que el importe pagado no se inventa: consta la presentación, su fecha y su número de operación.',
      lines: datos.declaraciones.length ? [] : ['Ninguna declaración consta presentada dentro del periodo en el expediente.'],
      table: datos.declaraciones.length ? { columns: [
          { title: 'Periodo declarado', width: 0.18 }, { title: 'Tipo', width: 0.14 },
          { title: 'Fecha de presentación', width: 0.20 }, { title: 'Nº de operación', width: 0.28 },
          { title: 'Acuse', width: 0.20 }],
        rows: datos.declaraciones.map(d => [d.periodo, d.tipo === 'anual' ? 'Anual' : 'Mensual', d.fecha,
          d.operacion || '—', d.acuse ? 'Recuperado' : 'Sin recuperar']) } : undefined });
    sections.push({ heading: 'Nómina del periodo',
      lines: datos.nomina.length ? [] : ['Sin CFDI de nómina en el periodo en el expediente.'],
      table: datos.nomina.length ? { columns: [
          { title: 'Fecha', width: 0.12 }, { title: 'Folio', width: 0.12 },
          { title: 'Empleado', width: 0.44 }, { title: 'Total', width: 0.32, align: 'right' }],
        rows: datos.nomina.map(invoice => { const empleado = invoice.from?.rfc === rfc ? invoice.to : invoice.from;
          return [fecha10(invoice.date), folioLabel(invoice),
            (empleado?.name || empleado?.rfc || '') + (salidaCancelado(invoice) ? ' · CANCELADA' : ''), salidaPesos(centsOf(invoice.total))]; }),
        totals: [['Total de nómina', '', '', salidaPesos(r.nominaTotal)]] } : undefined });
    sections.push({ heading: 'Saldo en bancos',
      note: 'Según el último estado de cuenta archivado de cada cuenta en Bancos.',
      lines: datos.bancos.length ? [] : ['Sin estados de cuenta archivados en el expediente.'],
      table: datos.bancos.length ? { columns: [
          { title: 'Banco', width: 0.20 }, { title: 'Cuenta', width: 0.34 },
          { title: 'Último estado', width: 0.16 }, { title: 'Saldo', width: 0.30, align: 'right' }],
        rows: datos.bancos.map(cuenta => [cuenta.banco, (cuenta.cuenta || '') + (cuenta.ultimos ? ' ····' + cuenta.ultimos : ''), cuenta.mes, salidaPesos(cuenta.saldo)]),
        totals: [['Posición total', '', '', salidaPesos(r.bancosTotal)]] } : undefined });
    return buildPdf({ title: 'Reporte Mano Fil · ' + periodo.etiqueta,
      subtitle: `${rfc}${datos.perfil?.name ? ' · ' + datos.perfil.name : ''} · Para Rodrigo y José Javier`,
      generated: salidaGenerado(), sections });
  }
  function reporteManofilXlsx(periodo) {
    const rfc = MANOFIL_RFC;
    const datos = manofilDatos(periodo);
    const r = datos.resumen;
    const balances = salidaMapaSaldos();
    const byId = new Map(recordInvoices().map(invoice => [invoice.id, invoice]));
    const vigentes = lista => lista.filter(invoice => !salidaCancelado(invoice));
    const colFact = [
      { title: 'Fecha', type: 'date', width: 12 }, { title: 'Folio', width: 12 },
      { title: 'Contraparte', width: 38 }, { title: 'RFC contraparte', width: 15 },
      { title: 'Total', type: 'money', width: 15, total: true },
      { title: 'Cobrado/Pagado', type: 'money', width: 15, total: true },
      { title: 'Saldo', type: 'money', width: 15, total: true },
      { title: 'Estado SAT', width: 13 }, { title: 'UUID', width: 38 }];
    const filaFact = (invoice, cp) => { const b = balances.get(invoice.id);
      return [String(invoice.date || '').slice(0, 10), folioLabel(invoice), cp?.name || '', cp?.rfc || '',
        Number(centsOf(invoice.total)), b ? Number(b.paid) : null, b ? Number(b.balance) : null,
        salidaEstadoSat(invoice.id), invoice.id]; };
    const colSaldo = [
      { title: 'Contraparte', width: 38 }, { title: 'RFC contraparte', width: 15 }, { title: 'Folio', width: 12 },
      { title: 'Fecha', type: 'date', width: 12 }, { title: 'Total', type: 'money', width: 15, total: true },
      { title: 'Pagado', type: 'money', width: 15, total: true }, { title: 'Saldo', type: 'money', width: 15, total: true },
      { title: 'UUID', width: 38 }];
    const filaSaldo = balance => { const inv = byId.get(balance.id); const cp = balance.receivable ? balance.to : balance.from;
      return [cp?.name || '', cp?.rfc || '', inv ? folioLabel(inv) : '—', String(balance.date || '').slice(0, 10),
        Number(balance.total), Number(balance.paid), Number(balance.balance), balance.id]; };
    return buildXlsx({ sheets: [
      { name: 'Resumen', columns: [
          { title: 'Concepto', width: 46 }, { title: 'Importe', type: 'money', width: 18 }, { title: 'Detalle', width: 64 }],
        rows: [
          ['Facturado en el periodo', Number(r.facturado), `${vigentes(datos.emitidos).length} factura(s) emitida(s); las canceladas no suman`],
          ['Cobrado en el periodo (entró)', Number(r.cobradoPeriodo), 'Complementos, PUE y pagos marcados con fecha en el periodo'],
          ['Pagado a proveedores en el periodo (salió)', Number(r.pagadoPeriodo), 'Detalle en la hoja «Pagos a proveedores»'],
          ['Nómina del periodo', Number(r.nominaTotal), `${vigentes(datos.nomina).length} CFDI de nómina vigentes; las canceladas no suman (N12)`],
          ['Por cobrar (saldos abiertos)', Number(r.porCobrarTotal), 'A la fecha de generación'],
          ['Por pagar (saldos abiertos)', Number(r.porPagarTotal), 'A la fecha de generación'],
          ['Saldo en bancos', Number(r.bancosTotal), datos.bancos.length ? 'Último estado archivado: ' + datos.bancosMes : 'Sin estados archivados']] },
      { name: 'Facturación emitida', columns: colFact,
        rows: vigentes(datos.emitidos).map(invoice => filaFact(invoice, invoice.to)), totals: { label: 'Total emitidas' } },
      { name: 'Facturas recibidas', columns: colFact,
        rows: vigentes(datos.recibidos).map(invoice => filaFact(invoice, invoice.from)), totals: { label: 'Total recibidas' } },
      { name: 'Pagos a proveedores', columns: [
          { title: 'Fecha', type: 'date', width: 12 }, { title: 'Proveedor', width: 38 },
          { title: 'RFC proveedor', width: 15 }, { title: 'Folio de la factura', width: 15 },
          { title: 'Vía', width: 24 }, { title: 'Importe', type: 'money', width: 15, total: true }],
        rows: datos.pagos.map(evento => [evento.fecha, evento.invoice.from?.name || '', evento.invoice.from?.rfc || '',
          folioLabel(evento.invoice), evento.via, Number(evento.importe)]), totals: { label: 'Total pagado' } },
      { name: 'Por pagar', columns: colSaldo, rows: datos.porPagar.map(filaSaldo), totals: { label: 'Total por pagar' } },
      { name: 'Por cobrar', columns: colSaldo, rows: datos.porCobrar.map(filaSaldo), totals: { label: 'Total por cobrar' } },
      { name: 'Impuestos', columns: [
          { title: 'Periodo declarado', width: 16 }, { title: 'Tipo', width: 12 },
          { title: 'Fecha de presentación', type: 'date', width: 16 }, { title: 'Nº de operación', width: 24 },
          { title: 'Acuse', width: 14 }],
        rows: datos.declaraciones.map(d => [d.periodo, d.tipo === 'anual' ? 'Anual' : 'Mensual', d.fecha || null, d.operacion || '', d.acuse ? 'Recuperado' : 'Sin recuperar']) },
      { name: 'Nómina', columns: [
          { title: 'Fecha', type: 'date', width: 12 }, { title: 'Folio', width: 12 },
          { title: 'Empleado', width: 38 }, { title: 'RFC empleado', width: 15 },
          { title: 'Total', type: 'money', width: 15, total: true }, { title: 'UUID', width: 38 }],
        rows: datos.nomina.map(invoice => { const empleado = invoice.from?.rfc === rfc ? invoice.to : invoice.from;
          return [String(invoice.date || '').slice(0, 10), folioLabel(invoice),
            (empleado?.name || '') + (salidaCancelado(invoice) ? ' · CANCELADA' : ''), empleado?.rfc || '',
            Number(centsOf(invoice.total)), invoice.id]; }),
        totals: { label: 'Total nómina (sin canceladas)', skip: datos.nomina.map(invoice => salidaCancelado(invoice)) } },
      { name: 'Bancos', columns: [
          { title: 'Banco', width: 20 }, { title: 'Cuenta', width: 30 }, { title: 'Últimos dígitos', width: 14 },
          { title: 'Último estado', width: 13 }, { title: 'Saldo', type: 'money', width: 16, total: true }],
        rows: datos.bancos.map(cuenta => [cuenta.banco, cuenta.cuenta, cuenta.ultimos, cuenta.mes, Number(cuenta.saldo)]),
        totals: { label: 'Posición total' } }] });
  }

  const mxFormat = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Mexico_City', weekday: 'short',
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', hourCycle: 'h23' });
  function mxParts(time) {
    const parts = Object.fromEntries(mxFormat.formatToParts(time).map(part => [part.type, part.value]));
    return { weekday: { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 0 }[parts.weekday],
      day: Number(parts.day), hour: Number(parts.hour) % 24, monthKey: parts.year + '-' + parts.month };
  }
  const reportsConfig = () => { try { return JSON.parse(db.prepare("SELECT value FROM settings WHERE key='reports'").get()?.value || '{}'); } catch { return {}; } };
  async function reportsTick(time) {
    const config = reportsConfig();
    const state = (() => { try { return JSON.parse(getState('reports-state') || '{}'); } catch { return {}; } })();
    const mx = mxParts(time);
    /* Informe mensual a la contadora: el día fijado, se envía el
       paquete del mes ANTERIOR una sola vez. */
    if (config.nora?.enabled) {
      const [year, month] = mx.monthKey.split('-').map(Number);
      const prevDate = new Date(Date.UTC(year, month - 2, 1));
      const prev = prevDate.toISOString().slice(0, 7);
      if (mx.day >= Math.min(28, Math.max(1, config.nora.day || 3)) && mx.hour >= (config.nora.hour ?? 9) && state.noraMonth !== prev) {
        try {
          const pack = buildMonthlyPackage(prev);
          await sendAppMail({ to: config.nora.recipients || '', subject: 'PacoSAT · Informe mensual ' + prev,
            text: 'Adjunto el paquete del mes ' + prev + ': índice de CFDI, XML, documentos, base DIOT con desglose, ' +
              'novedades de listas negras y PPD del mes. Generado automáticamente por PacoSAT.\n\n' +
              /* El correo se prueba sin abrir el adjunto (1.27.0,
                 doctrina de correos con datos): las cifras del
                 propio paquete, contadas al construirlo. */
              'El paquete trae: ' + pack.counts.invoices + ' CFDI del mes · ' + pack.counts.pendingComplements +
              ' complemento(s) pendiente(s) por saldo · ' + pack.counts.pueWithComplement + ' PUE con complemento (meta: cero) · ' +
              pack.counts.unmatchedMovements + ' movimiento(s) bancario(s) sin identificar · ' + pack.counts.cancelled +
              ' cancelación(es) · ' + pack.counts.missing + ' faltante(s) (XML o estados sin archivar). ' +
              'La lista de revisión paso a paso va dentro, en revision-contadora.txt.',
            attachments: [{ filename: pack.filename, content: pack.buffer }] }, 'nora', time);
          state.noraMonth = prev; setState('reports-state', JSON.stringify(state));
        } catch (error) {
          queueAlert('nora-report-fail', 'nora:' + prev, 'PacoSAT · El informe mensual no pudo enviarse',
            'El paquete de ' + prev + ' no salió: ' + message(error) + ' Puedes enviarlo a mano desde Salidas.', time);
        }
      }
    }
    /* Resumen semanal ejecutivo: lunes a la hora fijada, una vez. */
    if (config.weekly?.enabled && mx.weekday === 1 && mx.hour >= (config.weekly.hour ?? 8)) {
      const monday = day(time - ((mx.weekday + 6) % 7) * DAY);
      if (state.weeklyMonday !== monday) {
        try {
          const since = time - 7 * DAY;
          /* N8 (1.22.0): «CFDI nuevos» salía de la bitácora que
             escribe el NAVEGADOR al importar a mano — las
             incorporaciones del servidor (mensual, recuperaciones,
             CIEC) no la escriben y una semana con 112 recuperados
             podía reportar «0 nuevos». Ahora se cuenta del registro
             del servidor: los paquetes descargados (su newCount,
             por la fecha de su solicitud) más lo entrado por la
             bandeja y la CIEC (sus avisos de novedades). */
          const added = db.prepare('SELECT COALESCE(SUM(p.newCount),0) AS n FROM packages p JOIN jobs j ON j.id=p.job WHERE j.created>=?').get(since).n +
            db.prepare("SELECT COUNT(*) AS n FROM news_items ni JOIN news_notices nn ON nn.id=ni.notice WHERE nn.kind IN ('bandeja','ciec') AND nn.due>=?").get(since).n;
          const finishedJobs = db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status='finished' AND created>=?").get(since).n;
          const listChanges = db.prepare('SELECT COUNT(*) AS n FROM list_events WHERE at>=?').get(since).n;
          const alertsSent = db.prepare('SELECT COUNT(*) AS n FROM alerts WHERE sent IS NOT NULL AND sent>=?').get(since).n;
          const lines = ['Resumen semanal de PacoSAT · semana del ' + monday, '',
            '· CFDI nuevos incorporados: ' + added,
            '· Solicitudes al SAT terminadas: ' + finishedJobs,
            '· Cambios en listas negras: ' + listChanges,
            '· Avisos enviados: ' + alertsSent,
            '· Último respaldo: ' + (getState('backup:last') ? day(Number(getState('backup:last'))) : 'sin registro'),
            '', 'El detalle completo está en la bitácora de la app (Operaciones).'];
          await sendAppMail({ to: config.weekly.recipients || '', subject: 'PacoSAT · Resumen semanal ' + monday,
            text: lines.join('\n') }, 'weekly', time);
          state.weeklyMonday = monday; setState('reports-state', JSON.stringify(state));
        } catch (error) {
          queueAlert('weekly-fail', 'weekly:' + monday, 'PacoSAT · El resumen semanal no pudo enviarse', message(error), time);
        }
      }
    }
    /* Reporte Mano Fil mensual (1.16.0, P12): el día fijado se
       genera solo el del mes ANTERIOR, queda GUARDADO en Expedientes
       y sale por correo (PDF + Excel) a los destinatarios fijados
       (Rodrigo y José Javier, si Paco lo activa). Sin perfil de Mano
       Fil en la instalación, esta rama no existe: el informe es de
       ese negocio y de ningún otro. El guardado manda: si el correo
       falla, el reporte ya está en Expedientes y el aviso lo dice. */
    if (config.manofil?.enabled && salidaPerfil(MANOFIL_RFC)) {
      const [year, month] = mx.monthKey.split('-').map(Number);
      const prevDate = new Date(Date.UTC(year, month - 2, 1));
      const prev = prevDate.toISOString().slice(0, 7);
      if (mx.day >= Math.min(28, Math.max(1, config.manofil.day || 5)) && mx.hour >= (config.manofil.hour ?? 9) && state.manofilMonth !== prev) {
        try {
          const periodo = manofilPeriodoDe({ month: prev });
          const pdf = reporteManofilPdf(periodo);
          const xlsx = reporteManofilXlsx(periodo);
          const fileId = 'pdf:' + randomUUID();
          tx(db, () => {
            putFile(fileId, pdf, 'application/pdf');
            putMetadata('documents', { id: fileId, rfc: MANOFIL_RFC, kind: 'Reporte Mano Fil',
              date: day(time), period: prev, name: 'Reporte Mano Fil · ' + manofilMesLargo(prev) + '.pdf' });
          });
          state.manofilMonth = prev; setState('reports-state', JSON.stringify(state));
          try {
            await sendAppMail({ to: config.manofil.recipients || '',
              subject: 'PacoSAT · Reporte Mano Fil ' + prev,
              text: 'Adjunto el Reporte Mano Fil de ' + prev + ' (PDF y Excel): la renta facturada y cobrada, ' +
                'los pagos a proveedores, lo que se debe y a quién, los impuestos presentados, la nómina y el saldo en bancos. ' +
                'Quedó guardado también en Expedientes. Generado automáticamente por PacoSAT.',
              attachments: [{ filename: 'reporte-manofil-' + prev + '.pdf', content: pdf },
                { filename: 'reporte-manofil-' + prev + '.xlsx', content: xlsx }], rfc: MANOFIL_RFC }, 'manofil', time);
          } catch (mailError) {
            queueAlert('manofil-report-fail', 'manofil:' + prev, 'PacoSAT · El Reporte Mano Fil quedó guardado, pero el correo no salió',
              'El reporte de ' + prev + ' está en Expedientes; el envío falló: ' + message(mailError) +
              ' Puedes descargarlo desde Salidas › Reporte Mano Fil.', time);
          }
        } catch (error) {
          queueAlert('manofil-report-fail', 'manofil:' + prev, 'PacoSAT · El Reporte Mano Fil no pudo generarse',
            'El reporte de ' + prev + ' no se generó: ' + message(error) + ' Puedes generarlo a mano desde Salidas.', time);
        }
      }
    }
  }

  /* ===== Centro de Avisos (1.7.4, pieza 2 · punto 17) =====
     El motor que sustituye a los correos sueltos de antigüedad: genera
     avisos ESTRUCTURADOS dentro del sistema, en tres clases —
     «mal» (lo que está mal), «falta» (lo que falta) y «necesita» (lo
     que el sistema necesita de ti) — y los mantiene sincronizados con
     la realidad: cuando la condición se corrige (llega el pago, el
     CFDI o el estado), el aviso se solventa solo y queda en el
     historial. Reglas de Paco (9-nov-2026): textos veraces («no consta
     el pago en PacoSAT», jamás «sin pagar»), preguntar ANTES de hablar
     de atraso, calendario de pago por contraparte y línea base
     silenciosa para el histórico. */
  /* ===== Push PWA (1.25.0, AGREGAR 9) =====
     Claves VAPID de la aplicación: se generan una vez y viven en
     la configuración del servidor (la privada firma las
     peticiones a los servicios de push; la pública la usa el
     navegador para suscribirse). El asunto de contacto sale del
     correo configurado de la casa, sin inventar direcciones. */
  function pushVapid() {
    /* Las claves VAPID viven en la carpeta de secretos (1.27.0,
       B3 de la pasada de la 1.25): la privada es una credencial
       de la instalación y no debe circular en un volcado de la
       base de datos. Migración suave: si aún constan en el
       ajuste viejo, se copian al fichero (0600) y el ajuste se
       borra. En memoria (pruebas) no hay carpeta: el ajuste de
       siempre, sin persistir fichero. */
    const fileBacked = dbFile !== ':memory:';
    if (fileBacked) {
      try {
        const saved = JSON.parse(readFileSync(join(efirmaBase, 'vapid.json'), 'utf8'));
        if (saved?.publicKey && saved?.privateKey) return saved;
      } catch { /* aún no hay fichero: migración o generación */ }
      try {
        const legacy = JSON.parse(getSetting('push-vapid') || 'null');
        if (legacy?.publicKey && legacy?.privateKey) {
          mkdirSync(efirmaBase, { recursive: true });
          writeFileSync(join(efirmaBase, 'vapid.json'), JSON.stringify(legacy), { mode: 0o600 });
          setSetting('push-vapid', '');
          return legacy;
        }
      } catch { /* se genera */ }
      const keys = generateVapidKeys();
      try {
        mkdirSync(efirmaBase, { recursive: true });
        writeFileSync(join(efirmaBase, 'vapid.json'), JSON.stringify(keys), { mode: 0o600 });
      } catch { /* sin carpeta escribible: las claves viven en memoria esta sesión */ }
      return keys;
    }
    try {
      const saved = JSON.parse(getSetting('push-vapid') || 'null');
      if (saved?.publicKey && saved?.privateKey) return saved;
    } catch { /* se genera */ }
    const keys = generateVapidKeys();
    setSetting('push-vapid', JSON.stringify(keys));
    return keys;
  }
  const pushSubject = () => 'mailto:' + (mail?.recipient || 'paco@cobertores.com');
  async function pushSender(subscription, payload) {
    if (makePushSender) return makePushSender(subscription, payload);
    return sendWebPush({ subscription, payload, vapid: pushVapid(), subject: pushSubject() });
  }
  /* Push genérico de aviso crítico: el cuerpo NO lleva datos
     fiscales (viaja por servicios de terceros); dice que hay un
     aviso y de qué familia es, y el detalle se lee en la app. */
  async function pushCritico() {
    const subs = db.prepare('SELECT * FROM push_subscriptions').all();
    if (!subs.length) return 0;
    let sent = 0;
    for (const sub of subs) {
      const subscription = { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } };
      try {
        const result = await pushSender(subscription, { title: 'PacoSAT · Aviso crítico',
          body: 'Hay un aviso que necesita tu revisión. Ábrelo en PacoSAT para ver el detalle.', url: '/' });
        if (result?.status === 404 || result?.status === 410)
          db.prepare('DELETE FROM push_subscriptions WHERE endpoint=?').run(sub.endpoint);
        else sent++;
      } catch { /* una suscripción caída no frena a las demás */ }
    }
    return sent;
  }
  /* ===== Puente a Paperless (1.25.0, AGREGAR 2) =====
     Las constancias, opiniones y acuses que PacoSAT archiva se
     suben TAMBIÉN a su Paperless, con etiquetas por RFC y tipo,
     por la API del propio Paperless (POST
     /api/documents/post_document/, un fichero por llamada,
     cabecera «Authorization: Token …»). La dirección y el token
     los escribe Paco en Ajustes (viven solo en la configuración
     del servidor); sin ellos el puente está apagado y nada se
     encola. Si Paperless no responde, el documento NO se pierde:
     queda en su cola y se reintenta en cada ciclo. */
  function paperlessConfig() {
    let parsed = {};
    try { parsed = JSON.parse(getSetting('paperless') || '{}'); } catch { parsed = {}; }
    return { enabled: Boolean(parsed.enabled),
      baseUrl: String(parsed.baseUrl || '').replace(/\/+$/, ''),
      token: String(getSetting('paperless-token') || '') };
  }
  function paperlessEnqueue(fileId, titulo, etiquetas) {
    const config = paperlessConfig();
    if (!config.enabled || !config.baseUrl || !fileId) return;
    const ya = db.prepare("SELECT id FROM paperless_queue WHERE fileId=? AND estado IN ('pendiente','subido')").get(fileId);
    if (ya) return;
    db.prepare('INSERT INTO paperless_queue(id,fileId,titulo,etiquetas,estado,creado) VALUES (?,?,?,?,?,?)')
      .run(randomUUID(), fileId, String(titulo || '').slice(0, 200),
        JSON.stringify((etiquetas || []).filter(Boolean)), 'pendiente', now());
    paperlessProcess().catch(() => { /* queda en cola */ });
  }
  async function paperlessUploaderDefault({ baseUrl, token, fileName, buffer, title, tags }) {
    const form = new FormData();
    form.append('document', new Blob([buffer], { type: 'application/pdf' }), fileName);
    if (title) form.append('title', title);
    for (const tag of tags || []) form.append('tags', String(tag));
    const response = await fetch(baseUrl + '/api/documents/post_document/', { method: 'POST',
      headers: token ? { 'Authorization': 'Token ' + token } : {}, body: form });
    if (!response.ok) throw new Error('Paperless respondió ' + response.status + ' al subir «' + title + '».');
    return { status: response.status };
  }
  async function paperlessProcess() {
    const config = paperlessConfig();
    if (!config.enabled || !config.baseUrl) return 0;
    const pendientes = db.prepare("SELECT * FROM paperless_queue WHERE estado IN ('pendiente','error') ORDER BY creado ASC LIMIT 10").all();
    let ok = 0;
    for (const item of pendientes) {
      const file = readFileRecord(item.fileId);
      if (!file) {
        db.prepare("UPDATE paperless_queue SET estado='error', error=? WHERE id=?")
          .run('El documento ya no está en el expediente de PacoSAT.', item.id);
        continue;
      }
      try {
        const etiquetas = JSON.parse(item.etiquetas || '[]');
        const uploader = makePaperlessUploader || paperlessUploaderDefault;
        await uploader({ baseUrl: config.baseUrl, token: config.token,
          fileName: item.titulo || 'documento.pdf', buffer: file.buffer, title: item.titulo, tags: etiquetas });
        db.prepare("UPDATE paperless_queue SET estado='subido', enviado=?, error='' WHERE id=?").run(now(), item.id);
        ok++;
      } catch (error) {
        db.prepare("UPDATE paperless_queue SET estado='error', error=? WHERE id=?").run(message(error), item.id);
      }
    }
    return ok;
  }
  function avisosConfig() {
    let parsed = {};
    try { parsed = JSON.parse(getSetting('avisos') || '{}'); } catch { parsed = {}; }
    return { correo: ['diario', 'semanal', 'graves', 'no'].includes(parsed.correo) ? parsed.correo : 'diario',
      hora: Number.isInteger(parsed.hora) && parsed.hora >= 0 && parsed.hora <= 23 ? parsed.hora : 9 };
  }
  function avisoDatos(aviso) { try { return JSON.parse(aviso.datos || '{}'); } catch { return {}; } }
  function avisoLog(avisoId, accion, nota, time) {
    db.prepare('INSERT INTO avisos_acciones(aviso,at,accion,nota) VALUES (?,?,?,?)')
      .run(avisoId, time, accion, String(nota || '').slice(0, 500));
  }
  function avisoEnsure(row, time, baseline) {
    const existing = db.prepare('SELECT * FROM avisos WHERE ref=?').get(row.ref);
    /* Durabilidad del cierre de línea base (1.23.0, frente E): un
       aviso de línea base descartado CON la nota del cierre en
       bloque no se reabre ni se recrea en la sincronización — su
       registro queda en el archivo tal como se cerró. La guarda es
       acotada: solo baseline=1, solo descartado y solo con esa
       nota; cualquier otro aviso sigue su reapertura legítima. */
    if (existing && existing.baseline === 1 && existing.estado === 'descartado' &&
      String(existing.resolucion || '').startsWith('Cierre de línea base')) return existing;
    if (existing) {
      if (existing.estado !== 'solventado')
        db.prepare('UPDATE avisos SET titulo=?,detalle=?,importe=?,actualizado=?,rfc=?,vence=?,accion=? WHERE id=?')
          .run(row.titulo, row.detalle, row.importe || '', time,
            row.rfc || existing.rfc || '', row.vence ?? existing.vence ?? null,
            row.accion || existing.accion || '', existing.id);
      return existing;
    }
    db.prepare('INSERT INTO avisos(ref,kind,clase,estado,severidad,titulo,detalle,contraparte,nombre,importe,enlace,datos,baseline,creado,actualizado,correo,rfc,responsable,vence,accion) ' +
      'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(row.ref, row.kind, row.clase, row.estado, row.severidad, row.titulo, row.detalle,
        row.contraparte || '', row.nombre || '', row.importe || '', row.enlace || '',
        JSON.stringify(row.datos || {}), baseline ? 1 : 0, time, time, row.correo ? 1 : 0,
        row.rfc || '', row.responsable || 'Paco', row.vence ?? null, row.accion || '');
    const created = db.prepare('SELECT * FROM avisos WHERE ref=?').get(row.ref);
    avisoLog(created.id, 'creado', row.titulo, time);
    /* Push PWA para lo crítico (1.25.0, AGREGAR 9): un aviso
       NUEVO de clase «mal» y severidad alta (una factura cobrada
       que se cancela, una contraparte en 69-B definitivo, un
       expediente de materialidad) sale también como push genérico
       a los navegadores suscritos — sin datos fiscales en el
       cuerpo: el detalle se lee dentro de la app. */
    if (created.clase === 'mal' && created.severidad === 'alta')
      pushCritico().catch(() => { /* el push nunca tumba el aviso */ });
    return created;
  }
  function avisoSolve(ref, resolucion, time) {
    const aviso = db.prepare("SELECT * FROM avisos WHERE ref=? AND estado<>'solventado'").get(ref);
    if (!aviso) return;
    db.prepare("UPDATE avisos SET estado='solventado',resuelto=?,resolucion=?,actualizado=? WHERE id=?")
      .run(time, resolucion, time, aviso.id);
    avisoLog(aviso.id, 'solventado', resolucion, time);
  }
  /* Pago manual con cierre rápido (ronda de correcciones, 9 nov
     2026): la nota es OPCIONAL — si ya se pagó, el aviso se cierra
     con un toque, sin decir cómo ni dónde. La bitácora registra sola
     el cierre: la fecha, que fue manual y el origen (tarjeta o lote).
     Vale como pago enlazado en Dinero vía manual_payments. */
  function avisoMarkPaid(aviso, nota, fecha, time, lote = false) {
    const datos = avisoDatos(aviso);
    const balance = moneyBalances().find(item => item.id === datos.uuid);
    const importe = balance ? moneyText(balance.balance) : (aviso.importe || '0.00');
    const notaFinal = (fecha ? fecha + ' · ' : '') +
      (nota || 'Pago confirmado sin nota (' + (lote ? 'cierre en lote' : 'cierre rápido') + ', ' + day(time) + ')');
    db.prepare('INSERT INTO manual_payments(uuid,at,nota,importe) VALUES (?,?,?,?) ' +
      'ON CONFLICT(uuid) DO UPDATE SET at=excluded.at,nota=excluded.nota,importe=excluded.importe')
      .run(String(datos.uuid || ''), time, notaFinal, importe);
    avisoLog(aviso.id, lote ? 'pago-manual-lote' : 'pago-manual', notaFinal, time);
    avisoSolve(aviso.ref, 'Pagado a mano' + (lote ? ' (en lote)' : '') + ': ' + (nota || 'pago confirmado, sin nota.'), time);
  }
  /* Fecha en que «toca» pagar una factura PPD según el calendario de
     su contraparte: plazo en días si está fijado; si no, el día de
     pago del mes (el de la factura o el siguiente); si no hay
     calendario, la regla histórica (30 días por pagar / 60 por
     cobrar). Devuelve la clave AAAA-MM-DD comparable con day(time). */
  function saldoDueKey(balance, cp) {
    const fecha = String(balance.date || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return '9999-12-31';
    if (cp && cp.payTerms !== null && cp.payTerms !== undefined)
      return day(Date.parse(fecha + 'T12:00:00Z') + Number(cp.payTerms) * DAY);
    if (cp && cp.payDay !== null && cp.payDay !== undefined) {
      const [y, m] = fecha.split('-').map(Number);
      const candidate = (yy, mm) => {
        const last = new Date(Date.UTC(yy, mm, 0)).getUTCDate();
        return yy + '-' + String(mm).padStart(2, '0') + '-' + String(Math.min(Number(cp.payDay), last)).padStart(2, '0');
      };
      let due = candidate(y, m);
      if (due < fecha) due = candidate(m === 12 ? y + 1 : y, m === 12 ? 1 : m + 1);
      return due;
    }
    return day(Date.parse(fecha + 'T12:00:00Z') + (balance.payable ? 30 : 60) * DAY);
  }
  function avisosSync(time) {
    /* Línea base silenciosa (criterio 4): la primera evaluación de la
       vida de la base, o cualquier salto de ≥50 facturas entre dos
       evaluaciones (una importación de histórico), marca lo creado
       como línea base: vive en el panel, SIN correos y sin que nada
       nazca ya «vencido» en un resumen. */
    const first = !getState('avisos:baseline-done');
    let invoiceCount = 0;
    try { invoiceCount = db.prepare("SELECT COUNT(*) AS n FROM records WHERE store='invoices'").get().n; } catch { invoiceCount = 0; }
    const lastCount = Number(getState('avisos:last-count') || 0);
    const baseline = (first || invoiceCount - lastCount >= 50) ? 1 : 0;
    const cpMap = new Map(db.prepare('SELECT * FROM counterparts').all().map(row => [row.rfc, row]));
    const todayKey = day(time);
    /* (a) Saldos PPD: solo nacen tras vencer el calendario de la
       contraparte y nacen PREGUNTANDO («por confirmar»). Antes: en
       plazo, sin aviso. Si el saldo llega a cero, se cierra solo. */
    for (const balance of moneyBalances()) {
      const ref = 'saldo:' + balance.id;
      /* Cierre de línea base (1.23.0): si este saldo ya se cerró en
         bloque por prescripción, la sincronización no lo toca —
         ni lo solventa con otra nota ni lo vuelve a crear. */
      const previoCierre = db.prepare('SELECT baseline,estado,resolucion FROM avisos WHERE ref=?').get(ref);
      if (previoCierre && previoCierre.baseline === 1 && previoCierre.estado === 'descartado' &&
        String(previoCierre.resolucion || '').startsWith('Cierre de línea base')) continue;
      /* Cancelada (1.20.0): nunca genera alerta de pago y cualquier
         aviso de saldo abierto se solventa solo — la factura ya no
         se debe ni se cobra. (Los avisos de DETECCIÓN de la
         cancelación son otros: viven en la Vigilancia y no se
         tocan.) */
      if (balance.cancelled) { avisoSolve(ref, 'La factura consta cancelada: ya no se debe ni se cobra, y sale de los saldos de Dinero.', time); continue; }
      if (balance.balance <= 0n) { avisoSolve(ref, 'El pago quedó enlazado en PacoSAT: el saldo llegó a cero.', time); continue; }
      if (balance.method !== 'PPD') continue;
      const cpRfc = balance.receivable ? balance.to?.rfc : balance.from?.rfc;
      const cpName = balance.receivable ? (balance.to?.name || '') : (balance.from?.name || '');
      const due = saldoDueKey(balance, cpMap.get(cpRfc));
      if (todayKey <= due) continue;
      /* Si Paco ya confirmó el atraso («No, aún no»), el aviso es
         suyo: la sincronización no reescribe su título ni su texto. */
      const previo = db.prepare('SELECT estado FROM avisos WHERE ref=?').get(ref);
      if (previo && previo.estado === 'abierto') continue;
      const cobrar = balance.receivable;
      avisoEnsure({ ref, kind: 'saldo', clase: 'necesita', estado: 'por-confirmar', severidad: 'media',
        titulo: 'Día de pago ' + (cobrar ? 'de ' : 'a ') + (cpName || cpRfc || 'la contraparte'),
        detalle: 'El día de pago ' + (cobrar ? 'de ' : 'a ') + (cpName || cpRfc) + ' fue el ' + due +
          ' y en PacoSAT no consta el pago de $' + moneyShow(balance.balance) + ' (factura del ' + String(balance.date).slice(0, 10) +
          ', total $' + moneyShow(balance.total) + '). ' + (cobrar ? '¿Ya pagaron?' : '¿Ya se pagó?') +
          ' Si ya se pagó, ciérralo aquí mismo con un toque («Ya se pagó · Cerrar»; la nota es opcional); si llegó el complemento de pago, enlázalo en Dinero y este aviso se cierra solo.',
        contraparte: cpRfc || '', nombre: cpName, importe: moneyText(balance.balance), enlace: 'dinero',
        rfc: (cobrar ? balance.from?.rfc : balance.to?.rfc) || '', responsable: 'Paco',
        vence: Date.parse(due + 'T12:00:00Z') || null,
        accion: cobrar ? 'Confirmar si la contraparte ya pagó o registrar el pago' : 'Confirmar si ya se pagó o registrar el pago',
        datos: { direccion: cobrar ? 'cobrar' : 'pagar', uuid: balance.id, vence: due } }, time, baseline);
    }
    /* (b) Facturas esperadas que no han llegado (desde el día 10). */
    if (mxParts(time).day >= 10) for (const item of expectedInvoices(time))
      avisoEnsure({ ref: 'esperada:' + item.rfc + ':' + item.month, kind: 'esperada', clase: 'falta',
        estado: 'abierto', severidad: 'baja',
        titulo: 'Falta la factura esperada de ' + (item.name || item.rfc),
        detalle: (item.name || item.rfc) + ' facturó en ' + item.monthsActive + ' de los últimos 6 meses, pero en ' + item.month +
          ' aún no consta ningún CFDI suyo en PacoSAT. Si era un gasto fijo, puede haberse perdido o no haberse emitido.',
        contraparte: item.rfc, nombre: item.name || '', importe: '', enlace: 'sat',
        responsable: 'Paco', accion: 'Comprobar si la factura llegó por otro canal o pedírsela al proveedor',
        datos: { rfc: item.rfc, month: item.month } }, time, baseline);
    for (const aviso of db.prepare("SELECT * FROM avisos WHERE kind='esperada' AND estado<>'solventado'").all()) {
      const datos = avisoDatos(aviso);
      const arrived = recordInvoices().some(invoice => invoice.kind === 'I' && invoice.from?.rfc === datos.rfc &&
        String(invoice.date || '').startsWith(datos.month || ''));
      if (arrived) avisoSolve(aviso.ref, 'Ya consta el CFDI del mes en PacoSAT.', time);
    }
    /* (b2) Vigilancia de doble cobro (1.25.0, AGREGAR 7): dos
       facturas RECIBIDAS del mismo proveedor, con el mismo importe
       y el mismo primer concepto, a pocos días una de otra y AMBAS
       aún con saldo vivo — el patrón de «me la cobraron dos
       veces» — avisan ANTES de pagar ninguna de las dos. Cuando
       una se paga o se cancela, el aviso se cierra solo. */
    {
      const porClave = new Map();
      const conceptoDe = invoice => {
        const primero = invoice?.concepts?.[0];
        const texto = typeof primero === 'string' ? primero
          : (primero?.descripcion || primero?.description || '');
        return String(texto).toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 60);
      };
      const byId = new Map(recordInvoices().map(invoice => [invoice.id, invoice]));
      for (const balance of moneyBalances()) {
        if (!balance.payable || balance.cancelled || balance.balance <= 0n) continue;
        const invoice = byId.get(balance.id);
        if (!invoice) continue;
        const concepto = conceptoDe(invoice);
        if (!concepto) continue;
        const clave = (balance.from?.rfc || '') + '|' + String(balance.total) + '|' + concepto;
        if (!porClave.has(clave)) porClave.set(clave, []);
        porClave.get(clave).push(balance);
      }
      for (const [clave, grupo] of porClave) {
        if (grupo.length < 2) continue;
        const orden = [...grupo].sort((a, b) => String(a.date).localeCompare(String(b.date)));
        for (let i = 0; i + 1 < orden.length; i++) {
          const a = orden[i], b = orden[i + 1];
          const dias = Math.round((Date.parse(String(b.date).slice(0, 10) + 'T12:00:00Z') -
            Date.parse(String(a.date).slice(0, 10) + 'T12:00:00Z')) / DAY);
          if (!(dias >= 0 && dias <= 10)) continue;
          const ref = 'doble:' + [a.id, b.id].sort().join('+');
          avisoEnsure({ ref, kind: 'doble-cobro', clase: 'mal', estado: 'abierto', severidad: 'media',
            titulo: 'Posible doble cobro de ' + (a.from?.name || a.from?.rfc || 'un proveedor'),
            detalle: 'Dos facturas de ' + (a.from?.name || a.from?.rfc) + ' por el mismo importe ($' +
              moneyShow(a.total) + ') y el mismo concepto («' + clave.split('|')[2] + '»), a ' + dias +
              ' día(s) una de otra (' + String(a.date).slice(0, 10) + ' y ' + String(b.date).slice(0, 10) +
              '), y las dos siguen con saldo vivo. Antes de pagar, comprueba que no sea el mismo cobro dos veces: ' +
              'si una es la buena, cancela o devuelve la otra con el proveedor.',
            contraparte: a.from?.rfc || '', nombre: a.from?.name || '', importe: moneyText(a.total), enlace: 'dinero',
            rfc: a.to?.rfc || '', responsable: 'Paco',
            accion: 'Comprobar con el proveedor cuál de las dos es la buena antes de pagar',
            datos: { uuids: [a.id, b.id], dias } }, time, baseline);
        }
      }
      const balancesNow = moneyBalances();
      for (const aviso of db.prepare("SELECT * FROM avisos WHERE kind='doble-cobro' AND estado<>'solventado'").all()) {
        const datos = avisoDatos(aviso);
        const vivos = (datos.uuids || []).filter(uuid => {
          const balance = balancesNow.find(item => item.id === uuid);
          return balance && !balance.cancelled && balance.balance > 0n;
        });
        if (vivos.length < 2) avisoSolve(aviso.ref, 'Una de las dos facturas ya se pagó o se canceló: la vigilancia de doble cobro se cierra.', time);
      }
    }
    /* (c) Estados de cuenta faltantes (pasados) y su solicitud interna:
       el sistema PIDE el estado dentro del panel, con subida ahí. */
    const monthNow = mxParts(time).monthKey;
    for (const account of banksOverview().accounts) for (const mes of account.missing) {
      if (mes >= monthNow) continue;
      avisoEnsure({ ref: 'estado:' + account.id + ':' + mes, kind: 'estado', clase: 'falta',
        estado: 'abierto', severidad: 'baja',
        titulo: 'Falta el estado de ' + account.bank + ' de ' + mes,
        detalle: 'En Bancos no está archivado el estado de ' + account.bank + ' (' + (account.name || 'cuenta') + ') del mes ' + mes +
          '. Sin él no se cierra la cadena de saldos ni se concilia ese mes.',
        contraparte: '', nombre: account.bank, importe: '', enlace: 'bancos',
        responsable: 'Paco', accion: 'Subir el estado de cuenta de ' + mes + ' en Bancos',
        datos: { banco: account.bank, mes, accountId: account.id } }, time, baseline);
      avisoEnsure({ ref: 'solicitud:' + account.id + ':' + mes, kind: 'solicitud-estado', clase: 'necesita',
        estado: 'abierto', severidad: 'media',
        titulo: 'Necesito el estado de ' + account.bank + ' de ' + mes,
        detalle: 'Para conciliar los pagos de ' + mes + ' me falta el estado de ' + account.bank + ' (' + (account.name || 'cuenta') +
          '). Súbelo aquí mismo, en esta tarjeta: se procesa al momento y los avisos que dependen de él se solventan solos.',
        contraparte: '', nombre: account.bank, importe: '', enlace: 'bancos',
        responsable: 'Paco', accion: 'Subir el estado de cuenta de ' + mes + ' aquí mismo, en esta tarjeta',
        datos: { banco: account.bank, mes, accountId: account.id } }, time, baseline);
    }
    for (const aviso of db.prepare("SELECT * FROM avisos WHERE kind IN ('estado','solicitud-estado') AND estado<>'solventado'").all()) {
      const datos = avisoDatos(aviso);
      const exists = db.prepare('SELECT 1 AS x FROM bank_statements WHERE accountId=? AND month=?').get(datos.accountId || '', datos.mes || '');
      if (exists) avisoSolve(aviso.ref, 'El estado pedido ya está archivado en Bancos.', time);
    }
    /* (d) Contrapartes que coinciden con listados del SAT. */
    for (const cp of listsOverview().counterparts) {
      const ref = 'lista:' + cp.rfc;
      if (!cp.hits.length) { avisoSolve(ref, 'La contraparte ya no aparece en los listados cruzados.', time); continue; }
      avisoEnsure({ ref, kind: 'lista', clase: 'mal', estado: 'abierto',
        severidad: cp.severity === 'bad' ? 'alta' : 'media',
        titulo: (cp.name || cp.rfc) + ' aparece en listados del SAT',
        detalle: 'Coincide en: ' + cp.hits.map(hit => hit.label + (hit.detail ? ' (' + hit.detail + ')' : '')).join(' · ') +
          '. Revisa los comprobantes relacionados antes de seguir operando con esta contraparte.',
        contraparte: cp.rfc, nombre: cp.name || '', importe: '', enlace: 'lists',
        responsable: 'Contadora', accion: 'Revisar los comprobantes de esta contraparte con la contadora antes de seguir operando',
        datos: { rfc: cp.rfc } }, time, baseline);
      /* 69-B Definitivo con CFDI de Paco (1.25.0, AGREGAR 10):
         el expediente de materialidad se arma solo. */
      materialidadAuto(cp, time);
    }
    /* (e) Espejo de las alertas internas históricas (respaldo, SAT,
       listados…): cada una se ve UNA vez en el Centro, en su clase.
       Las de antigüedad PPD y las de factura esperada NO se espejan:
       las sustituyen los generadores estructurados (a) y (b). */
    const ESPEJO = { cancellation: ['mal', 'alta', 'monitor'], efos: ['mal', 'alta', 'monitor'],
      'cancel-pending': ['necesita', 'alta', 'monitor'],
      'descarga-dudosa': ['mal', 'alta', 'sat'], 'watch-sweep-fail': ['falta', 'media', 'operaciones'],
      'backup-fail': ['mal', 'alta', 'backup'], 'backup-stale': ['mal', 'alta', 'backup'], 'criteria-5002': ['mal', 'alta', 'sat'],
      'backup-secondary-fail': ['mal', 'media', 'backup'], 'backup-verify-fail': ['mal', 'media', 'backup'],
      'backup-external-stale': ['falta', 'media', 'backup'], 'criteria-presumed': ['mal', 'media', 'sat'],
      'criteria-rescued': ['falta', 'baja', 'sat'], 'download-fail': ['mal', 'media', 'sat'],
      'package-exhausted': ['mal', 'media', 'sat'], 'job-terminal': ['mal', 'media', 'operaciones'],
      'list-transition': ['mal', 'media', 'lists'], 'nora-report-fail': ['mal', 'media', 'operaciones'],
      'weekly-fail': ['mal', 'media', 'operaciones'], 'satdoc-fail': ['mal', 'media', 'docs'],
      'watch-fail': ['mal', 'media', 'operaciones'], 'watch-incidents': ['mal', 'media', 'operaciones'],
      'decl-fail': ['mal', 'media', 'docs'],
      'trib-sin-abrir': ['necesita', 'media', 'tributario'], 'trib-fail': ['mal', 'media', 'tributario'],
      'monthly-fail': ['falta', 'media', 'sat'],
      'tick-stuck': ['mal', 'media', 'operaciones'],
      'cert-expiry': ['necesita', 'media', 'sat'], 'fiscal-due': ['necesita', 'media', 'cumplimiento'],
      'satdoc-mail': ['necesita', 'media', 'docs'],
      silence: ['falta', 'baja', 'sat'], 'list-stale': ['falta', 'baja', 'lists'], 'satdoc-old': ['falta', 'baja', 'docs'],
      'watch-stale': ['falta', 'baja', 'sat'], 'monthly-zombie': ['mal', 'media', 'sat'],
      'portal-probe': ['info', 'baja', 'docs'], 'secret-migration': ['mal', 'alta', 'docs'] };
    for (const alert of db.prepare('SELECT * FROM alerts').all()) {
      const mapa = ESPEJO[alert.kind];
      if (!mapa) continue;
      /* El espejo NO es línea base (es un suceso, no la foto del
         histórico) y una alerta que ya salió por correo en su día no
         vuelve a entrar en ningún resumen (correo=1). */
      avisoEnsure({ ref: 'alerta:' + alert.id, kind: 'general', clase: mapa[0], estado: 'abierto', severidad: mapa[1],
        titulo: String(alert.subject || '').replace(/^PacoSAT · /, ''), detalle: alert.body || '',
        contraparte: '', nombre: '', importe: '', enlace: mapa[2], correo: alert.sent ? 1 : 0,
        /* El RFC viaja como DATO en la alerta desde la 1.27.0
           (H-6.1): manda la columna; la extracción por la ref
           queda solo para filas legadas sin ella (1.28.0: sin
           esto, el aviso espejo de decl-fail/satdoc-fail nacía
           sin RFC aunque su alerta lo llevaba). */
        rfc: alert.rfc || /^(?:trib|trib-fail):([A-Z0-9]{12,13}):/.exec(alert.ref || '')?.[1] || '',
        responsable: mapa[2] === 'cumplimiento' ? 'Contadora' : 'Paco',
        accion: 'Abrir la pantalla enlazada y corregir la causa; después, «Ya lo corregí»',
        datos: { alerta: alert.id, alertaKind: alert.kind } }, time, 0);
    }
    if (first) setState('avisos:baseline-done', '1');
    setState('avisos:last-count', String(invoiceCount));
  }
  /* Re-comprobación de «Ya lo corregí»: se verifica la condición REAL
     que originó el aviso; si sigue presente, se dice qué falta. */
  function avisoRecheck(aviso) {
    const datos = avisoDatos(aviso);
    if (aviso.kind === 'saldo') {
      const balance = moneyBalances().find(item => item.id === datos.uuid);
      if (balance && balance.cancelled) return { ok: true, resolucion: 'La factura consta cancelada: ya no se debe ni se cobra, y salió de los saldos de Dinero.' };
      if (!balance || balance.balance <= 0n) return { ok: true, resolucion: 'El pago quedó enlazado en PacoSAT: el saldo llegó a cero.' };
      return { ok: false, falta: 'En PacoSAT sigue constando un saldo de $' + moneyShow(balance.balance) +
        ' sin pago enlazado. Enlaza el complemento de pago en Dinero, concílialo en Bancos o ciérralo con «Ya se pagó · Cerrar».' };
    }
    if (aviso.kind === 'esperada') {
      const arrived = recordInvoices().some(invoice => invoice.kind === 'I' && invoice.from?.rfc === datos.rfc &&
        String(invoice.date || '').startsWith(datos.month || ''));
      return arrived ? { ok: true, resolucion: 'Ya consta el CFDI del mes en PacoSAT.' }
        : { ok: false, falta: 'Aún no consta ningún CFDI de esa contraparte en ' + (datos.month || 'ese mes') +
            ' dentro de PacoSAT. Cuando llegue (descarga del SAT o importación), este aviso se cierra solo.' };
    }
    if (aviso.kind === 'estado' || aviso.kind === 'solicitud-estado') {
      const exists = db.prepare('SELECT 1 AS x FROM bank_statements WHERE accountId=? AND month=?').get(datos.accountId || '', datos.mes || '');
      return exists ? { ok: true, resolucion: 'El estado pedido ya está archivado en Bancos.' }
        : { ok: false, falta: 'Todavía no está archivado el estado de ' + (datos.banco || 'ese banco') + ' de ' + (datos.mes || 'ese mes') +
            '. Súbelo en la tarjeta de la solicitud o desde Bancos.' };
    }
    if (aviso.kind === 'lista') {
      const cp = listsOverview().counterparts.find(item => item.rfc === datos.rfc);
      return !cp || !cp.hits.length ? { ok: true, resolucion: 'La contraparte ya no aparece en los listados cruzados.' }
        : { ok: false, falta: 'La contraparte sigue apareciendo en: ' + cp.hits.map(hit => hit.label).join(' · ') +
            '. El aviso se cierra cuando deje de coincidir en los listados.' };
    }
    if (aviso.kind === 'doble-cobro') {
      const balances = moneyBalances();
      const vivos = (datos.uuids || []).filter(uuid => {
        const balance = balances.find(item => item.id === uuid);
        return balance && !balance.cancelled && balance.balance > 0n;
      });
      return vivos.length < 2 ? { ok: true, resolucion: 'Una de las dos facturas ya se pagó o se canceló: la vigilancia de doble cobro se cierra.' }
        : { ok: false, falta: 'Las dos facturas siguen vivas y con saldo. Paga solo la buena (o cancela la otra con el proveedor) y este aviso se cierra solo.' };
    }
    if (aviso.kind === 'materialidad') {
      const cp = listsOverview().counterparts.find(item => item.rfc === datos.rfc);
      const sigue = cp && (cp.hits || []).some(hit => hit.listId === '69b' && (hit.severity === 'bad' || /definitiv/i.test(String(hit.detail || ''))));
      return sigue ? { ok: false, falta: 'La contraparte sigue en 69-B Definitivo. El aviso se cierra cuando deje de constar así o cuando registres su entrega a la contadora en la nota del cierre.' }
        : { ok: true, resolucion: 'La contraparte ya no consta en 69-B Definitivo.' };
    }
    return { ok: true, resolucion: 'Marcado como corregido por ti; queda registrado en el historial.' };
  }
  function avisosOverview() {
    const open = db.prepare("SELECT * FROM avisos WHERE estado NOT IN ('solventado','descartado') ORDER BY baseline ASC, creado ASC").all();
    const history = db.prepare("SELECT * FROM avisos WHERE estado='solventado' ORDER BY resuelto DESC LIMIT 50").all();
    const serialize = row => { const datos = avisoDatos(row); return { id: row.id, ref: row.ref, kind: row.kind, clase: row.clase,
      estado: row.estado, severidad: row.severidad, titulo: row.titulo, detalle: row.detalle, contraparte: row.contraparte,
      nombre: row.nombre, importe: row.importe, enlace: row.enlace, baseline: Boolean(row.baseline), creado: row.creado,
      resuelto: row.resuelto, resolucion: row.resolucion, direccion: datos.direccion || '',
      fileId: datos.fileId || '',
      rfc: row.rfc || '', responsable: row.responsable || 'Paco', vence: row.vence || null,
      accion: row.accion || '', actualizado: row.actualizado,
      solicitud: row.kind === 'solicitud-estado' ? { banco: datos.banco || '', mes: datos.mes || '' } : null }; };
    const counts = { total: open.length, mal: 0, falta: 0, necesita: 0, porConfirmar: 0 };
    const porRfc = {};
    for (const row of open) { counts[row.clase] = (counts[row.clase] || 0) + 1; if (row.estado === 'por-confirmar') counts.porConfirmar++;
      if (row.rfc) porRfc[row.rfc] = (porRfc[row.rfc] || 0) + 1; }
    /* Agrupados por causa raíz (1.25.0, mejora nº 2): cuando la
       MISMA causa (mismo tipo de aviso, misma contraparte y mismo
       contribuyente) se repite en varios comprobantes, la lista
       los presenta como UN grupo con sus N comprobantes dentro y
       el importe sumado — un aviso por causa, no uno por papel.
       Los avisos sueltos no llevan grupo (grupo = null). */
    const gruposMap = new Map();
    for (const row of open) {
      const clave = row.kind + '|' + (row.contraparte || '') + '|' + (row.rfc || '');
      if (!gruposMap.has(clave)) gruposMap.set(clave, []);
      gruposMap.get(clave).push(row);
    }
    const grupos = [];
    const conGrupo = new Set();
    for (const [clave, miembros] of gruposMap) {
      if (miembros.length < 2) continue;
      const primero = miembros[0];
      const totalCents = miembros.reduce((sum, row) => sum + (row.importe ? centsOf(row.importe) : 0n), 0n);
      grupos.push({ clave, kind: primero.kind, clase: primero.clase, contraparte: primero.contraparte,
        nombre: primero.nombre, rfc: primero.rfc, estado: primero.estado, severidad: primero.severidad,
        responsable: primero.responsable, enlace: primero.enlace,
        titulo: primero.titulo, cuenta: miembros.length, importeTotal: moneyText(totalCents),
        miembros: miembros.map(row => row.id) });
      for (const row of miembros) conGrupo.add(row.id);
    }
    const avisosOut = open.map(row => ({ ...serialize(row), grupo: conGrupo.has(row.id) ?
      row.kind + '|' + (row.contraparte || '') + '|' + (row.rfc || '') : null }));
    return { avisos: avisosOut, grupos, historial: history.map(serialize), counts, porRfc, config: avisosConfig() };
  }

  /* ===== Dinero (1.6.17) =====
     Saldos desde la relación Pagos↔facturas persistida en el desglose
     (1.6.16/1.6.17): por cobrar y por pagar con antigüedad, avisos de
     PPD que envejecen sin pago completo y detector de facturas
     esperadas (proveedor recurrente que este mes no ha llegado). La
     conciliación con estados de cuenta consume estos mismos saldos
     cuando llega la ronda de Bancos (1.6.19). */
  /* Archivo por prescripción en Dinero (1.23.0, frente E): los ids
     archivados SOLO se excluyen aquí —la fuente de los saldos de
     Dinero y, por compartirla, del generador de avisos de saldo—.
     recordInvoices() sigue devolviendo todo: exportaciones,
     historial y expediente ven el archivo completo. */
  function archivedInvoiceIds() {
    try { return new Set(db.prepare("SELECT id FROM records WHERE store='invoices' AND archived=1").all().map(row => row.id)); }
    catch { return new Set(); }
  }
  function moneyPaidBy() {
    const paidBy = new Map();
    const archivedIds = archivedInvoiceIds();
    for (const payment of recordInvoices()) {
      if (archivedIds.has(payment.id)) continue;
      if (payment.kind !== 'P' || !payment.fiscal?.payments) continue;
      for (const pago of payment.fiscal.payments.pagos || [])
        for (const doc of pago.documentos || [])
          paidBy.set(doc.idDocumento, (paidBy.get(doc.idDocumento) || 0n) + centsOf(doc.impPagado));
    }
    /* Pagos marcados a mano desde el Centro de Avisos (1.7.4): la
       confirmación de Paco vale como pago enlazado (la nota es
       opcional desde la ronda de correcciones). */
    for (const manual of db.prepare('SELECT * FROM manual_payments').all())
      paidBy.set(manual.uuid, (paidBy.get(manual.uuid) || 0n) + centsOf(manual.importe));
    return paidBy;
  }
  /* Desglose de lo pagado por comprobante (1.25.0, mejora nº 5):
     cuánto vino de complementos de pago (REP) enlazados y cuánto
     de marcas a mano — Dinero lo usa para explicar cada saldo en
     una línea («qué falta: el REP, el pago o la marca»). */
  function moneyPaidDetail() {
    const rep = new Map(), manual = new Map();
    const archivedIds = archivedInvoiceIds();
    for (const payment of recordInvoices()) {
      if (archivedIds.has(payment.id)) continue;
      if (payment.kind !== 'P' || !payment.fiscal?.payments) continue;
      for (const pago of payment.fiscal.payments.pagos || [])
        for (const doc of pago.documentos || [])
          rep.set(doc.idDocumento, (rep.get(doc.idDocumento) || 0n) + centsOf(doc.impPagado));
    }
    for (const row of db.prepare('SELECT * FROM manual_payments').all())
      manual.set(row.uuid, (manual.get(row.uuid) || 0n) + centsOf(row.importe));
    return { rep, manual };
  }
  function moneyBalances() {
    const paidBy = moneyPaidBy();
    const archivedIds = archivedInvoiceIds();
    const profileRfcs = new Set(db.prepare('SELECT rfc FROM profiles').all().map(row => row.rfc));
    return recordInvoices().filter(invoice => invoice.kind === 'I' && !archivedIds.has(invoice.id)).map(invoice => {
      const total = centsOf(invoice.total);
      const paid = invoice.fiscal?.paymentMethod === 'PUE' ? total : (paidBy.get(invoice.id) || 0n);
      /* Cancelada (1.20.0): la marca viaja con el saldo para que
         TODAS las superficies de Dinero apliquen el criterio único
         de Paco (11 nov): la cancelada no se debe ni se cobra —
         fuera de por pagar/por cobrar y sin alerta de pago — y se
         enseña aparte, en su línea de canceladas. Es el mismo
         criterio que el PDF de saldos aplica desde la 1.14.0. */
      return { id: invoice.id, date: invoice.date, from: invoice.from, to: invoice.to, kind: invoice.kind,
        method: invoice.fiscal?.paymentMethod || '', total, paid, balance: total - paid,
        cancelled: salidaCancelado(invoice),
        receivable: profileRfcs.has(invoice.from?.rfc), payable: profileRfcs.has(invoice.to?.rfc) };
    });
  }
  function expectedInvoices(time) {
    const mx = mxParts(time);
    const currentMonth = mx.monthKey;
    const byEmitter = new Map();
    for (const invoice of recordInvoices()) {
      if (invoice.kind !== 'I') continue;
      const profileRfcs = new Set(db.prepare('SELECT rfc FROM profiles').all().map(row => row.rfc));
      if (!profileRfcs.has(invoice.to?.rfc)) continue;
      const month = String(invoice.date || '').slice(0, 7);
      if (!byEmitter.has(invoice.from.rfc)) byEmitter.set(invoice.from.rfc, { name: invoice.from.name || '', months: new Map() });
      const entry = byEmitter.get(invoice.from.rfc);
      entry.months.set(month, (entry.months.get(month) || 0) + 1);
    }
    const expected = [];
    for (const [rfc, entry] of byEmitter) {
      if (entry.months.has(currentMonth)) continue;
      /* Recurrente: facturó en al menos 3 de los últimos 6 meses. */
      let recent = 0;
      for (let i = 1; i <= 6; i++) {
        const date = new Date(Date.UTC(Number(currentMonth.slice(0, 4)), Number(currentMonth.slice(5, 7)) - 1 - i, 1));
        if (entry.months.has(date.toISOString().slice(0, 7))) recent++;
      }
      if (recent >= 3) expected.push({ rfc, name: entry.name, monthsActive: recent, month: currentMonth });
    }
    return expected;
  }
  /* ===== Previsión del mes (1.25.0, AGREGAR 4) =====
     Lo que el mes va a mover, calculado SOLO desde los datos del
     expediente, cada línea con su base escrita: saldos que vencen
     en el mes (con su fecha de calendario), cobros y gastos
     recurrentes detectados en los CFDI (≥3 de los últimos 6
     meses, importe típico = mediana de sus meses) y los pagos
     fijos del catálogo. Nada se inventa: lo que no consta como
     patrón, no sale como previsión. */
  function monthForecast(monthKey, time) {
    const cpMap = new Map(db.prepare('SELECT * FROM counterparts').all().map(row => [row.rfc, row]));
    const profileRfcs = new Set(db.prepare('SELECT rfc FROM profiles').all().map(row => row.rfc));
    const entradas = [], salidas = [];
    for (const balance of moneyBalances()) {
      if (balance.cancelled || balance.balance <= 0n) continue;
      const cpRfc = balance.receivable ? balance.to?.rfc : balance.from?.rfc;
      const due = saldoDueKey(balance, cpMap.get(cpRfc));
      if (!due.startsWith(monthKey)) continue;
      const item = { fecha: due, concepto: (balance.receivable ? 'Cobro a ' : 'Pago a ') +
          (balance.receivable ? (balance.to?.name || balance.to?.rfc) : (balance.from?.name || balance.from?.rfc)),
        importe: moneyText(balance.balance), uuid: balance.id,
        base: 'Saldo vivo de la factura del ' + String(balance.date).slice(0, 10) +
          ' que vence el ' + due + ' según el calendario de la contraparte.' };
      (balance.receivable ? entradas : salidas).push(item);
    }
    const mediana = values => {
      const orden = [...values].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
      return orden.length ? orden[Math.floor(orden.length / 2)] : 0n;
    };
    const diaTipico = fechas => {
      const dias = fechas.map(fecha => Number(String(fecha).slice(8, 10))).filter(Boolean).sort((a, b) => a - b);
      return dias.length ? dias[Math.floor(dias.length / 2)] : 1;
    };
    const mesesPrevios = [];
    for (let i = 1; i <= 6; i++) {
      const d = new Date(Date.UTC(Number(monthKey.slice(0, 4)), Number(monthKey.slice(5, 7)) - 1 - i, 1));
      mesesPrevios.push(d.toISOString().slice(0, 7));
    }
    const fechaDelMes = dia => monthKey + '-' + String(Math.min(dia, 28)).padStart(2, '0');
    /* Recurrencias por contraparte y sentido, desde los CFDI. */
    const recurr = new Map();
    for (const invoice of recordInvoices()) {
      if (invoice.kind !== 'I' || salidaCancelado(invoice)) continue;
      const mes = String(invoice.date || '').slice(0, 7);
      const emitido = profileRfcs.has(invoice.from?.rfc);
      const recibido = profileRfcs.has(invoice.to?.rfc);
      if (!emitido && !recibido) continue;
      const cp = emitido ? invoice.to : invoice.from;
      if (!cp?.rfc) continue;
      const clave = (emitido ? 'emitido|' : 'recibido|') + invoice.from?.rfc + '|' + invoice.to?.rfc;
      if (!recurr.has(clave)) recurr.set(clave,
        { emitido, cpRfc: cp.rfc, cpNombre: cp.name || '', porMes: new Map(), fechas: [] });
      const entry = recurr.get(clave);
      if (mes === monthKey) entry.yaEsteMes = true;
      if (mesesPrevios.includes(mes)) {
        entry.porMes.set(mes, (entry.porMes.get(mes) || 0n) + centsOf(invoice.total));
        entry.fechas.push(String(invoice.date).slice(0, 10));
      }
    }
    for (const entry of recurr.values()) {
      if (entry.yaEsteMes || entry.porMes.size < 3) continue;
      const tipico = mediana([...entry.porMes.values()]);
      if (tipico <= 0n) continue;
      const item = { fecha: fechaDelMes(diaTipico(entry.fechas)),
        concepto: (entry.emitido ? 'Cobro recurrente de ' : 'Gasto recurrente de ') + (entry.cpNombre || entry.cpRfc),
        importe: moneyText(tipico), uuid: '',
        base: 'Patrón de tus CFDI: ' + entry.porMes.size + ' de los últimos 6 meses, importe típico $' +
          moneyShow(tipico) + ' (la mediana de esos meses). Aún no consta este mes.' };
      (entry.emitido ? entradas : salidas).push(item);
    }
    /* Pagos fijos del catálogo de beneficiarios. */
    for (const ben of db.prepare('SELECT * FROM pay_beneficiaries').all()) {
      let payload = {};
      try { payload = JSON.parse(ben.payload || '{}'); } catch { payload = {}; }
      if (payload.montoTipo !== 'fijo' || payload.activo === false || payload.activo === 0) continue;
      const total = centsOf(payload.base || '0') + centsOf(payload.iva || '0');
      if (total <= 0n) continue;
      salidas.push({ fecha: fechaDelMes(1), concepto: 'Pago fijo: ' + (ben.nombre || payload.nombre || 'beneficiario'),
        importe: moneyText(total), uuid: '',
        base: 'Línea fija de tu catálogo de pagos (base + IVA como la guardaste).' });
    }
    const suma = items => items.reduce((sum, item) => sum + centsOf(item.importe), 0n);
    entradas.sort((a, b) => a.fecha.localeCompare(b.fecha));
    salidas.sort((a, b) => a.fecha.localeCompare(b.fecha));
    return { month: monthKey, entradas, salidas,
      totalEntradas: moneyText(suma(entradas)), totalSalidas: moneyText(suma(salidas)),
      neto: moneyText(suma(entradas) - suma(salidas)) };
  }
  function moneyTick(time) {
    /* 1.7.4: el antiguo motor de antigüedad (un correo por factura
       «cumple 30/60 días sin pago completo») desaparece. Los saldos y
       las esperadas los genera ahora el Centro de Avisos, con
       calendario por contraparte, estado «por confirmar» y textos
       veraces; el correo es solo el resumen de sendAlerts. */
    avisosSync(time);
  }

  /* ===== Final 1.7.0: invitado, autodiagnóstico y paquete offline =====
     Acceso invitado de SOLO LECTURA con credencial separada
     (desactivado por defecto), bitácora de accesos, «Probar todo» y
     el paquete para consultar sin conexión (últimos 3 meses). */
  function logAccess(kind, detail) {
    db.prepare('INSERT INTO access_log(at,kind,detail) VALUES (?,?,?)').run(now(), kind, String(detail || '').slice(0, 200));
    db.prepare('DELETE FROM access_log WHERE rowid NOT IN (SELECT rowid FROM access_log ORDER BY rowid DESC LIMIT 1000)').run();
  }
  function guestConfig() {
    try { return JSON.parse(getState('guest-config') || '{}'); } catch { return {}; }
  }
  function guestSessions() {
    try { return JSON.parse(getState('guest-sessions') || '{}'); } catch { return {}; }
  }
  /* Alcance por RFC del invitado (1.9.0, auditoría de seguridad):
     la configuración puede limitar la lectura a unos RFC propios;
     vacío = sin límite (comportamiento histórico). Con alcance,
     las rutas de bancos y el paquete sin conexión quedan fuera:
     los bancos son del titular, no de un RFC concreto. */
  function guestScopeRfcs() {
    const config = guestConfig();
    /* M2 (1.22.0): un invitado SIN alcance configurado ya NO ve
       todo por omisión — ve NADA (conjunto vacío) hasta que se le
       asigne alcance. Antes, la lista vacía devolvía null y todos
       los filtros se saltaban: el invitado lo veía todo. */
    return new Set((Array.isArray(config.rfcs) ? config.rfcs : [])
      .map(rfc => String(rfc).toUpperCase()));
  }
  const guestLoginFails = [];
  function guestLoginThrottled() {
    const cutoff = now() - 10 * 60 * 1000;
    while (guestLoginFails.length && guestLoginFails[0] < cutoff) guestLoginFails.shift();
    return guestLoginFails.length >= 8;
  }
  const GUEST_GET = ['/api/status', '/api/storage', '/api/storage/rev', '/api/lists', '/api/money', '/api/notices',
    '/api/fiscal/calendar', '/api/fiscal/issues', '/api/banks', '/api/banks/movements', '/api/offline-bundle', '/api/reports/config',
    '/api/files/view', '/api/capacidades', '/api/buzon', '/api/declaraciones/runs',
    /* Vista Nora (1.25.0, AGREGAR 3): la contadora invitada lee
       la lista del mes y su estado — solo lectura, como todo lo
       suyo. Y lee la propia configuración de invitado: es la
       única vía de que su cliente sepa que su sesión es la de
       la contadora (sesionContadora) y abra en su Vista Nora;
       la respuesta no trae la contraseña ni su huella. */
    '/api/reports/checklist', '/api/guest/config'];
  function selfTest() {
    const checks = [];
    try { db.prepare('SELECT 1').get(); checks.push({ id: 'db', label: 'Base de datos local', state: 'ok', detail: 'Responde y guarda los datos.' }); }
    catch (error) { checks.push({ id: 'db', label: 'Base de datos local', state: 'bad', detail: message(error) }); }
    if (mail) checks.push({ id: 'mail', label: 'Correo de avisos', state: 'ok', detail: 'Configurado para ' + mail.recipient + '.' });
    else checks.push({ id: 'mail', label: 'Correo de avisos', state: 'warn', detail: 'Sin configurar: los avisos no saldrán. Actívalo en el Centro SAT.' });
    const lists = listsOverview();
    const stale = lists.sources.filter(source => !source.fetched || now() - source.fetched > 48 * 3600 * 1000);
    checks.push({ id: 'lists', label: 'Listados oficiales al día', state: stale.length ? 'warn' : 'ok',
      detail: stale.length ? 'Con retraso o sin cargar: ' + stale.map(source => source.label).join(', ') + '.' : 'Los ' + lists.sources.length + ' listados están dentro de las 48 horas.' });
    const backup = overview().scheduledBackup;
    checks.push({ id: 'backup', label: 'Respaldo programado', state: backup.last && now() - backup.last < 8 * DAY ? 'ok' : 'warn',
      detail: backup.last ? 'Último respaldo: ' + new Date(backup.last).toISOString().slice(0, 10) + '.' : 'Aún no hay respaldo programado ejecutado.' });
    checks.push({ id: 'external', label: 'Copia externa (Google Drive)', state: backup.secondaryStale ? 'warn' : backup.secondaryLastOk ? 'ok' : 'dim',
      detail: backup.secondaryLastOk ? 'Última copia buena: ' + new Date(backup.secondaryLastOk).toISOString().slice(0, 10) + '.' : 'Sin copia externa registrada todavía.' });
    const profiles = db.prepare('SELECT rfc,certExpires FROM profiles').all();
    if (!profiles.length) checks.push({ id: 'efirma', label: 'e.firma de los perfiles', state: 'dim', detail: 'Sin perfiles SAT configurados.' });
    for (const profile of profiles) {
      const days = profile.certExpires ? Math.ceil((profile.certExpires - now()) / DAY) : null;
      checks.push({ id: 'efirma-' + profile.rfc, label: 'e.firma · ' + profile.rfc,
        state: days === null ? 'warn' : days < 0 ? 'bad' : days <= 45 ? 'warn' : 'ok',
        detail: days === null ? 'Sin caducidad registrada.' : days < 0 ? 'CADUCADA: hay que renovarla en el SAT.' : 'Caduca en ' + days + ' días.' });
    }
    checks.push({ id: 'sat', label: 'Conexión con el SAT', state: 'dim', detail: 'No se comprueba en el diagnóstico: la disciplina de solicitudes (5002) prohíbe gastar peticiones en pruebas.' });
    return { at: now(), checks };
  }
  function offlineBundle() {
    const cutoff = new Date(now() - 92 * DAY).toISOString().slice(0, 10);
    const invoices = recordInvoices().filter(invoice => String(invoice.date || '') >= cutoff).slice(0, 8000);
    const months = [];
    const profileRfcs = new Set(db.prepare('SELECT rfc FROM profiles').all().map(row => row.rfc));
    for (let i = 0; i < 3; i++) {
      const key = new Date(now() - i * 31 * DAY).toISOString().slice(0, 7);
      if (months.some(item => item.month === key)) continue;
      const mine = recordInvoices().filter(invoice => String(invoice.date || '').startsWith(key) && invoice.kind === 'I');
      let issuedCount = 0, receivedCount = 0, issuedTotal = 0n, receivedTotal = 0n, withoutFiscal = 0;
      const ivaByRfc = new Map();
      for (const invoice of mine) {
        const issued = profileRfcs.has(invoice.from?.rfc);
        if (issued) { issuedCount++; issuedTotal += centsOf(invoice.total); } else { receivedCount++; receivedTotal += centsOf(invoice.total); }
        if (!invoice.fiscal) { withoutFiscal++; continue; }
        const ownRfc = issued ? invoice.from.rfc : invoice.to?.rfc;
        if (!ownRfc) continue;
        if (!ivaByRfc.has(ownRfc)) ivaByRfc.set(ownRfc, { rfc: ownRfc, payable: 0n, creditable: 0n });
        const entry = ivaByRfc.get(ownRfc);
        for (const tax of invoice.fiscal.transferred || []) {
          if (tax.tax !== '002') continue;
          if (issued) entry.payable += centsOf(tax.amount); else entry.creditable += centsOf(tax.amount);
        }
      }
      months.push({ month: key, withoutFiscal,
        totals: { issuedCount, receivedCount, issuedTotal: moneyText(issuedTotal), receivedTotal: moneyText(receivedTotal) },
        iva: [...ivaByRfc.values()].map(entry => ({ rfc: entry.rfc, payable: moneyText(entry.payable),
          creditable: moneyText(entry.creditable), balance: moneyText(entry.payable - entry.creditable) })) });
    }
    return { generatedAt: now(), invoices,
      balances: moneyBalances().filter(item => item.balance > 0n && !item.cancelled).map(item => ({ ...item,
        total: moneyText(item.total), paid: moneyText(item.paid), balance: moneyText(item.balance) })),
      expected: expectedInvoices(now()), listsSources: listsOverview().sources.map(source => ({ id: source.id, label: source.label, fetched: source.fetched, count: source.count, error: source.error })),
      bankPosition: banksOverview().position, reports: months };
  }

  /* ===== Bancos (1.6.19) =====
     Archivo de estados de cuenta por banco/cuenta/mes con lectura
     automática conservadora, cadena de saldos verificada, semáforo
     de faltantes y posición total. Los movimientos alimentan la
     conciliación de Dinero (1.6.17). */
  function banksOverview() {
    const accounts = db.prepare('SELECT * FROM bank_accounts ORDER BY bank,name').all();
    const statements = db.prepare('SELECT * FROM bank_statements ORDER BY month').all();
    const byAccount = new Map(accounts.map(account => [account.id, []]));
    for (const statement of statements) byAccount.get(statement.accountId)?.push(statement);
    const result = { accounts: [], position: { total: '0.00', byBank: {}, asOf: '' } };
    const bankTotals = new Map();
    let global = 0n;
    const monthKeyOf = time => mxParts(time).monthKey;
    for (const account of accounts) {
      const mine = byAccount.get(account.id) || [];
      /* Cadena de saldos: el inicial de un mes debe ser el final del
         anterior archivado. */
      let previous = null, chainBroken = null;
      for (const statement of mine) {
        statement.chain = 'ok';
        if (previous && previous.closingCents !== null && statement.openingCents !== null &&
            BigInt(previous.closingCents) !== BigInt(statement.openingCents)) {
          statement.chain = 'broken';
          statement.chainDetail = 'El mes ' + previous.month + ' cerró en $' + moneyText(BigInt(previous.closingCents)) +
            ' pero ' + statement.month + ' abre en $' + moneyText(BigInt(statement.openingCents)) + '.';
          chainBroken = statement;
        }
        previous = statement;
      }
      /* Faltantes: desde el primer estado hasta el mes actual. */
      const missing = [];
      if (mine.length) {
        const have = new Set(mine.map(statement => statement.month));
        let [year, month] = mine[0].month.split('-').map(Number);
        const [endYear, endMonth] = monthKeyOf(now()).split('-').map(Number);
        while (year < endYear || (year === endYear && month <= endMonth)) {
          const key = year + '-' + String(month).padStart(2, '0');
          if (!have.has(key)) missing.push(key);
          month++; if (month > 12) { month = 1; year++; }
        }
      }
      const latest = mine.filter(statement => statement.closingCents !== null).at(-1);
      if (latest) {
        global += BigInt(latest.closingCents);
        const bankKey = account.bank || 'Sin banco';
        bankTotals.set(bankKey, (bankTotals.get(bankKey) || 0n) + BigInt(latest.closingCents));
        if (latest.month > result.position.asOf) result.position.asOf = latest.month;
      }
      result.accounts.push({ ...account, statements: mine.map(statement => ({ ...statement,
          opening: statement.openingCents === null ? null : moneyText(BigInt(statement.openingCents)),
          closing: statement.closingCents === null ? null : moneyText(BigInt(statement.closingCents)),
          credits: statement.creditsCents === null ? null : moneyText(BigInt(statement.creditsCents)),
          charges: statement.chargesCents === null ? null : moneyText(BigInt(statement.chargesCents)) })),
        missing, chainBroken: Boolean(chainBroken),
        position: latest ? { closing: moneyText(BigInt(latest.closingCents)), month: latest.month } : null });
    }
    result.position.total = moneyText(global);
    for (const [bank, total] of bankTotals) result.position.byBank[bank] = moneyText(total);
    /* El mes de CADA saldo que compone la posición (1.28.0, P10):
       la posición ya no suma meses distintos en silencio — la
       pantalla enseña de qué mes sale el saldo de cada cuenta. */
    result.position.cuentas = result.accounts.filter(account => account.position)
      .map(account => ({ banco: account.bank || 'Sin banco', nombre: account.name || '',
        mes: account.position.month, saldo: account.position.closing }));
    return result;
  }

  /* ===== Conciliación bancaria asistida (1.9.0, punto 3) =====
     El sistema PROPONE vínculos movimiento↔CFDI↔complemento y dice
     por qué (importe contra total o saldo, suma de dos saldos,
     complemento que cubre la factura, fecha, moneda, mención de la
     contraparte en el concepto). Nada se aplica sin la decisión de
     Paco: confirmar persiste el vínculo (bank_matches), deshacer lo
     marca — no lo borra — y un movimiento puede declararse «sin
     factura legítimo» (comisión, impuesto, traspaso). */
  function reconcileOverview() {
    const movements = db.prepare('SELECT m.*, s.accountId FROM bank_movements m JOIN bank_statements s ON s.id=m.statementId ORDER BY m.date, m.id').all();
    const active = db.prepare("SELECT * FROM bank_matches WHERE estado='activo'").all();
    const matchByMovement = new Map(active.map(match => [match.movementId, match]));
    const marks = new Map(db.prepare('SELECT * FROM bank_movement_marks').all().map(row => [row.movementId, row]));
    const byUuid = new Map(recordInvoices().map(invoice => [invoice.id, invoice]));
    const usedByMatches = new Map();
    for (const match of active) for (const inv of JSON.parse(match.invoices || '[]'))
      usedByMatches.set(inv.uuid, (usedByMatches.get(inv.uuid) || 0n) + BigInt(inv.amountCents || 0));
    /* Las canceladas no son candidatas: conciliar un movimiento
       contra un CFDI cancelado escondería el problema. */
    const balances = moneyBalances().filter(balance => balance.balance > 0n &&
      !String(byUuid.get(balance.id)?.state || '').toLowerCase().startsWith('cancel'));
    const effective = balance => balance.balance - (usedByMatches.get(balance.id) || 0n);
    const brief = invoice => invoice ? { uuid: invoice.id, date: invoice.date, total: invoice.total,
      currency: invoice.currency || 'MXN', from: invoice.from, to: invoice.to, method: invoice.fiscal?.paymentMethod || '' } : null;
    const suggestions = [];
    for (const mv of movements) {
      if (matchByMovement.has(mv.id) || marks.has(mv.id)) continue;
      const amount = BigInt(mv.amountCents);
      if (amount === 0n) continue;
      const abs = amount < 0n ? -amount : amount;
      const concept = String(mv.concept || '').toUpperCase();
      const candidates = [];
      const scoreFor = (invoice, why) => {
        let score = why.length * 10;
        const days = Math.abs(Math.round((Date.parse(invoice.date) - Date.parse(mv.date)) / DAY));
        if (Number.isFinite(days) && days <= 45) { why.push('fecha a ' + days + ' días del movimiento'); score += 5; }
        if ((invoice.currency || 'MXN') === 'MXN') { why.push('moneda MXN'); score += 2; }
        const names = [invoice.from?.name, invoice.to?.name, invoice.from?.rfc, invoice.to?.rfc].filter(Boolean);
        if (names.some(name => String(name).length >= 4 && concept.includes(String(name).toUpperCase().slice(0, 12)))) {
          why.push('el concepto del movimiento menciona a la contraparte'); score += 15; }
        if (concept.includes(invoice.id.slice(0, 8).toUpperCase())) { why.push('el concepto trae el inicio del folio fiscal'); score += 20; }
        return score;
      };
      for (const balance of balances) {
        const invoice = byUuid.get(balance.id);
        if (!invoice) continue;
        const eff = effective(balance);
        if (eff <= 0n) continue;
        if (eff === abs) {
          const why = [eff === balance.total ? 'el importe iguala el total de la factura' : 'el importe iguala el saldo pendiente de la factura'];
          candidates.push({ mode: eff === balance.total ? 'total' : 'parcial', score: scoreFor(invoice, why),
            why, invoices: [{ ...brief(invoice), amount: moneyText(abs) }] });
        } else if (balance.total === abs && eff < balance.total) {
          const why = ['el importe iguala el TOTAL de la factura, que ya tiene pagos parciales enlazados'];
          candidates.push({ mode: 'total', score: scoreFor(invoice, why), why,
            invoices: [{ ...brief(invoice), amount: moneyText(abs) }] });
        }
      }
      for (const payment of recordInvoices().filter(invoice => invoice.kind === 'P')) {
        if (centsOf(payment.total) !== abs) continue;
        const docs = (payment.fiscal?.payments?.pagos || []).flatMap(pago => pago.documentos || []);
        if (!docs.length) continue;
        candidates.push({ mode: 'complemento', score: 30, paymentUuid: payment.id,
          why: ['el importe iguala el total del complemento de pago ' + payment.id.slice(0, 8) + '…, que cubre ' + docs.length + ' factura(s)'],
          invoices: docs.map(doc => ({ ...brief(byUuid.get(doc.idDocumento)), uuid: doc.idDocumento, amount: moneyText(centsOf(doc.impPagado)) })) });
      }
      if (!candidates.length) {
        const open = balances.filter(balance => effective(balance) > 0n);
        outer: for (let i = 0; i < open.length; i++) for (let j = i + 1; j < open.length; j++) {
          if (effective(open[i]) + effective(open[j]) === abs) {
            const a = byUuid.get(open[i].id), b = byUuid.get(open[j].id);
            candidates.push({ mode: 'multiple', score: 18,
              why: ['la suma de los saldos pendientes de estas dos facturas iguala el importe del movimiento'],
              invoices: [{ ...brief(a), amount: moneyText(effective(open[i])) }, { ...brief(b), amount: moneyText(effective(open[j])) }] });
            break outer;
          }
        }
      }
      if (candidates.length) {
        candidates.sort((a, b) => b.score - a.score);
        suggestions.push({ movement: { id: mv.id, date: mv.date, concept: mv.concept,
            amount: moneyText(amount), accountId: mv.accountId },
          candidates: candidates.slice(0, 3).map(({ score, ...rest }) => rest) });
      }
    }
    const confirmed = db.prepare('SELECT * FROM bank_matches ORDER BY created DESC LIMIT 100').all().map(match => {
      const mv = movements.find(item => item.id === match.movementId);
      return { id: match.id, movementId: match.movementId, mode: match.mode, estado: match.estado,
        amount: moneyText(BigInt(match.amountCents)), why: match.why, created: match.created, undone: match.undone,
        movement: mv ? { date: mv.date, concept: mv.concept } : null,
        invoices: JSON.parse(match.invoices || '[]').map(inv => ({ ...brief(byUuid.get(inv.uuid)), uuid: inv.uuid, amount: moneyText(BigInt(inv.amountCents || 0)) })) };
    });
    return { suggestions, confirmed,
      counts: { movements: movements.length, matched: matchByMovement.size,
        unmatched: movements.filter(mv => !matchByMovement.has(mv.id) && !marks.has(mv.id)).length, ignored: marks.size } };
  }

  /* ===== Declaraciones y acuses (1.9.0, punto 7) =====
     DECLARACIÓN y ACUSE son documentos distintos en Expedientes,
     con su ejercicio, periodo, fecha de presentación y número de
     operación; la vista dice qué hay recuperado y qué falta. */
  const DECL_LABEL = { 'mensual:declaracion': 'Declaración mensual', 'mensual:acuse': 'Acuse de declaración mensual',
    'anual:declaracion': 'Declaración anual', 'anual:acuse': 'Acuse de declaración anual' };
  function archiveDeclaracion(rfc, doc, time, source = 'auto') {
    /* Verificación (1.29.0): el PDF debe ser PDF de verdad antes de
       tocar el archivo — una página de error del portal jamás se
       archiva como acuse — y la marca «verificada» solo nace si el
       documento trae número de operación. La subida manual sin
       operación queda guardada (es el gesto de Paco) pero sin la
       marca: su mes no se da por verificado hasta que la operación
       conste. */
    const bytes = doc.content ? Buffer.from(doc.content) : null;
    if (!bytes || bytes.length < 5 || bytes.subarray(0, 4).toString('latin1') !== '%PDF') return false;
    const verificada = String(doc.operacion || '').trim() ? 1 : 0;
    const label = DECL_LABEL[doc.tipo + ':' + doc.clase] || 'Declaración';
    const existing = db.prepare("SELECT id FROM declaraciones WHERE rfc=? AND tipo=? AND clase=? AND ejercicio=? AND periodo=? AND operacion=? AND fileId<>''")
      .get(rfc, doc.tipo, doc.clase, doc.ejercicio, doc.periodo || '', doc.operacion || '');
    if (existing) return false;
    const fileId = 'pdf:' + randomUUID();
    const name = label + ' ' + (doc.periodo || doc.ejercicio) + (doc.operacion ? ' · op. ' + doc.operacion : '') + ' · ' + rfc + '.pdf';
    tx(db, () => {
      db.prepare("INSERT OR REPLACE INTO records(store,id,value,data,mime) VALUES ('files',?,NULL,?,'application/pdf')")
        .run(fileId, doc.content);
      db.prepare("INSERT OR REPLACE INTO records(store,id,value) VALUES ('documents',?,?)")
        .run(fileId, JSON.stringify({ id: fileId, rfc, kind: label,
          date: /^\d{4}-\d{2}-\d{2}/.test(doc.fechaPresentacion || '') ? doc.fechaPresentacion.slice(0, 10) : new Date(time).toISOString().slice(0, 10),
          period: doc.periodo || '', name }));
      db.prepare('INSERT INTO declaraciones(id,rfc,tipo,clase,ejercicio,periodo,fechaPresentacion,operacion,fileId,source,created,verificada,ejecutorJobId) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(randomUUID(), rfc, doc.tipo, doc.clase, doc.ejercicio, doc.periodo || '',
          doc.fechaPresentacion || '', doc.operacion || '', fileId, source, time,
          verificada, String(doc.ejecutorJobId || ''));
    });
    /* Registro de folios (1.25.0, mejora nº 1): si el documento
       trae número de operación, el folio queda guardado solo —
       es el dato que la reimpresión del 77792 necesita. */
    if (doc.operacion) declFolioTouch(rfc, doc, time);
    /* Puente a Paperless (1.25.0): declaración y acuse también
       se archivan allí con sus etiquetas, si el puente vive. */
    paperlessEnqueue(fileId, name, ['PacoSAT', rfc,
      doc.clase === 'acuse' ? 'Acuse' : 'Declaración', doc.periodo || String(doc.ejercicio || '')]);
    return true;
  }
  /* El folio se aprende de cualquier documento archivado con
     número de operación: nace «visto» y pasa a «con-acuse»
     cuando su acuse consta en el expediente. */
  function declFolioTouch(rfc, doc, time) {
    const folio = String(doc.operacion || '').trim();
    if (!folio) return;
    const existing = db.prepare('SELECT * FROM decl_folios WHERE rfc=? AND folio=?').get(rfc, folio);
    const estado = doc.clase === 'acuse' ? 'con-acuse' : (existing?.estado === 'con-acuse' ? 'con-acuse' : 'visto');
    if (existing) {
      db.prepare('UPDATE decl_folios SET estado=?, ejercicio=?, periodo=?, tipo=?, actualizado=? WHERE id=?')
        .run(estado, Number(doc.ejercicio) || existing.ejercicio, doc.periodo || existing.periodo,
          doc.tipo || existing.tipo, time, existing.id);
    } else {
      db.prepare('INSERT INTO decl_folios(id,rfc,tipo,ejercicio,periodo,folio,estado,creado,actualizado) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(randomUUID(), rfc, doc.tipo || 'mensual', Number(doc.ejercicio) || 0, doc.periodo || '',
          folio, estado, time, time);
    }
  }
  /* Corridas de declaraciones: mismo envoltorio que los
     documentos (1.22.0, piezas 9/10/15) — registro de vivas,
     progreso persistido, un reintento si la causa es del portal
     y aviso final desde el diagnóstico. */
  const declLive = new Map();
  const declState = () => { try { return JSON.parse(getSetting('decl-state') || '{}'); } catch { return {}; } };
  const saveDeclState = value => setSetting('decl-state', JSON.stringify(value));
  function writeDeclProgress(rfc, progress) {
    const current = declState();
    current[rfc] = progress;
    saveDeclState(current);
  }
  function declFailBody(rfc, query, failures) {
    const lines = [];
    if (failures.length > 1)
      lines.push('Hubo DOS intentos y los dos cayeron. Intento 1: ' + failures[0].error +
        ' Intento 2: ' + failures[1].error);
    else lines.push('El intento de recuperación falló: ' + failures[0].error);
    const docOk = db.prepare('SELECT started FROM sat_doc_runs WHERE rfc=? AND ok=1 ORDER BY started DESC LIMIT 1').get(rfc);
    if (docOk && failures[failures.length - 1].at - docOk.started < 30 * MIN)
      lines.push('El dato que lo prueba: tu e.firma SÍ funcionó — un documento del SAT de este mismo RFC bajó a las ' +
        new Date(docOk.started).toISOString().slice(11, 16) + ' (UTC) con la misma firma. Lo que falló fue el camino del trámite de declaraciones dentro del portal, no tu firma ni el portal en genérico.');
    lines.push('Gesto único: reinténtalo desde el panel de Declaraciones; si el portal cambió su pantalla, el diario de esta misma corrida guarda la página que el portal enseñó, para adaptar el flujo sin repetir la corrida a ciegas.');
    return lines.join(' ');
  }
  async function runDeclaracionesAttemptOnce(rfc, query, time, ctx = {}) {
    try {
      if (!satDeclFetch) throw new Error('La recuperación automática de declaraciones no está disponible en esta instalación: el navegador interno no está configurado.');
      /* Diario por pasos (1.23.0): el onStep de la corrida se pasa
         como tercer argumento; un satDeclFetch que no lo acepte lo
         ignora sin romperse (compatibilidad con puertos previos). */
      const result = await satDeclFetch({ rfc }, query, { onStep: ctx.onStep });
      if (ctx.token?.cancelled)
        return { ok: false, cancelled: true, error: 'Recuperación cancelada por ti: lo parcial se descartó.' };
      /* Descubrimiento de folios (1.27.0, bloque C): la Consulta
         de transacciones (22513) no baja documentos: ENSEÑA los
         números de operación de lo presentado. Cada folio nuevo
         entra en el registro como «visto», con su nota de origen,
         y desde ahí su acuse se reimprime con el 77792. */
      if (query.tipo === 'transacciones') {
        let nuevos = 0;
        const noValidos = [];
        for (const t of result.transactions || []) {
          /* El folio se normaliza y se valida ANTES de entrar
             en el registro (H-3.1, pasada de seguridad de la
             1.27.0): el portal puede enseñar la operación
             agrupada con espacios («1234 5678 9012») y, tal
             cual, el registro la guardaría sucia — la
             deduplicación por par exacto no la reconocería si
             mañana llegara sin agrupar, y la reimpresión del
             77792 teclearía la cadena con espacios. Aquí se le
             quitan TODOS los espacios y pasa la MISMA regex
             del alta manual de folios; lo que no case NO entra
             y queda anotado en el diario de la corrida y en
             sus avisos, nunca en silencio. */
          const folio = String(t.operacion || '').replace(/\s+/g, '');
          if (!folio) continue;
          if (!/^[0-9A-Za-z-]{6,40}$/.test(folio)) { noValidos.push(String(t.operacion || '')); continue; }
          const existing = db.prepare('SELECT * FROM decl_folios WHERE rfc=? AND folio=?').get(rfc, folio);
          if (!existing) {
            db.prepare('INSERT INTO decl_folios(id,rfc,tipo,ejercicio,periodo,folio,estado,nota,creado,actualizado) VALUES (?,?,?,?,?,?,?,?,?,?)')
              .run(randomUUID(), rfc, t.tipo === 'anual' ? 'anual' : 'mensual', Number(t.ejercicio) || 0,
                String(t.periodo || ''), folio, 'visto',
                'Descubierto en la Consulta de transacciones del SAT (ficha 22513)', time, time);
            nuevos++;
          } else if (!existing.ejercicio && t.ejercicio) {
            db.prepare('UPDATE decl_folios SET ejercicio=?, periodo=?, actualizado=? WHERE id=?')
              .run(Number(t.ejercicio) || 0, String(t.periodo || '') || existing.periodo, time, existing.id);
          }
        }
        const warnings = [...(result.warnings || [])];
        if (noValidos.length) {
          const nota = 'La Consulta de transacciones enseñó ' + noValidos.length +
            ' número(s) de operación que no pasan la validación de folio y NO entraron en el registro: ' +
            noValidos.slice(0, 5).join(' · ') + (noValidos.length > 5 ? '…' : '');
          warnings.push(nota);
          if (typeof ctx.onStep === 'function')
            try { ctx.onStep('Folios leídos y no aprendidos', nota); } catch { /* el diario nunca tumba la corrida */ }
        }
        return { ok: true, found: result.found || (result.transactions || []).length,
          descubiertos: nuevos, noAprendidos: noValidos.length, guardados: 0, warnings };
      }
      let saved = 0;
      /* Reimpresión por folio (1.25.0): el documento que baja es
         el ACUSE de la declaración del registro — su tipo real
         (mensual/anual) es el del folio, no «folio». */
      const tipoDoc = query.tipo === 'folio'
        ? (query.tipoDeclaracion === 'anual' ? 'anual' : 'mensual') : query.tipo;
      for (const doc of result.documents || [])
        if (archiveDeclaracion(rfc, { ...doc, tipo: tipoDoc }, time)) saved++;
      return { ok: true, found: result.found || 0, saved, warnings: result.warnings || [] };
    } catch (error) {
      db.prepare('INSERT INTO declaraciones(id,rfc,tipo,clase,ejercicio,periodo,created,error,errorKind) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(randomUUID(), rfc, query.tipo, '', Number(query.ejercicio) || 0, String(query.periodo || ''), time, message(error), error?.code || '');
      if (!ctx.deferAlert)
        queueAlert('decl-fail', 'decl:' + rfc + ':' + query.tipo + ':' + Math.floor(time / DAY),
          'PacoSAT · No se pudieron recuperar declaraciones de ' + rfc,
          declFailBody(rfc, query, [{ error: message(error), at: time }]), time, rfc);
      /* La página del fallo viaja con el error (1.27.0): el
         cierre de la corrida la archiva en el diario. */
      return { ok: false, error: message(error), errorKind: error?.code || '', diag: error?.diag || null };
    }
  }
  async function runDeclaracionesAttempt(rfc, query, time, origen = 'paco') {
    /* Modo remoto (1.29.0): la recuperación la ejecuta el ejecutor
       del equipo de Paco; aquí solo se encola el trabajo con su
       clase: folio conocido → reimpresión 77792; transacciones →
       descubrimiento 22513; mensual/anual → recuperación del
       ejercicio (el ejecutor descubre folios y reimprime). */
    if (remoteExecutor) {
      if (query.tipo === 'folio')
        return queueRemoteRun(rfc, 'declaracion-folio',
          { folio: String(query.folio || ''), tipo: query.tipoDeclaracion === 'anual' ? 'anual' : 'mensual',
            ejercicio: Number(query.ejercicio) || 0, periodo: String(query.periodo || '') }, origen);
      if (query.tipo === 'transacciones')
        return queueRemoteRun(rfc, 'declaraciones-transacciones', { ejercicio: Number(query.ejercicio) || 0 }, origen);
      return queueRemoteRun(rfc, 'declaraciones-recuperar',
        { ejercicio: Number(query.ejercicio) || 0, periodo: String(query.periodo || ''),
          tipo: query.tipo === 'anual' ? 'anual' : 'mensual' }, origen);
    }
    const key = rfc + ':' + query.tipo + ':' + query.ejercicio;
    if (declLive.has(key)) return { ok: false, yaEnCurso: true,
      error: 'Ya hay una recuperación de declaraciones en curso para ' + rfc + ': mírala en su panel (ahí está su Cancelar).' };
    const token = { cancelled: false, startedAt: time };
    declLive.set(key, token);
    const failures = [];
    /* Diario decl_runs (1.23.0, frente A3): la fila nace al empezar,
       cada paso del conector se añade en memoria y se persiste al
       momento (UPDATE steps), y la fila se cierra al terminar —
       éxito, fallo o cancelación — con sus intentos. Poda a las
       últimas 20 por RFC, como sat_doc_runs. */
    const declRunId = randomUUID();
    const declSteps = [];
    let declAttempt = 0;
    let declRunClosed = false;
    let declDiagFiles = { shotId: '', htmlId: '' };
    const closeDeclRun = (ok, errorText = '', errorKind = '', diag = null) => {
      if (declRunClosed) return;
      declRunClosed = true;
      try {
        /* La página del fallo queda archivada en el diario
           (1.27.0): captura y HTML como records, con su id en la
           corrida — un fallo sin página guardada es un fallo
           perdido (la corrida viva del 11 nov murió sin ella).
           1.28.0: guardado verificado + inventario de la página
           en el propio diario + poda común (ver saveRunDiag). */
        if (diag && !declDiagFiles.shotId && !declDiagFiles.htmlId)
          declDiagFiles = saveRunDiag(declRunId, diag);
        if (!ok && diag) declSteps.push(...diagCierreSteps(diag, declDiagFiles)
          .map(paso => ({ at: paso.at, intento: declAttempt, paso: paso.text, detalle: '' })));
        db.prepare('UPDATE decl_runs SET finished=?,ok=?,error=?,errorKind=?,steps=?,attempts=?,shotId=?,htmlId=? WHERE id=?')
          .run(now(), ok ? 1 : 0, String(errorText || ''), String(errorKind || ''),
            JSON.stringify(declSteps), declAttempt, declDiagFiles.shotId, declDiagFiles.htmlId, declRunId);
        pruneRunDiary('decl_runs', rfc, now());
      } catch { /* el diario nunca tumba la corrida */ }
    };
    const onStep = (paso, detalle) => {
      declSteps.push({ at: now(), intento: declAttempt, paso: String(paso || ''), detalle: String(detalle || '') });
      try { db.prepare('UPDATE decl_runs SET steps=?,attempts=? WHERE id=?')
        .run(JSON.stringify(declSteps), declAttempt, declRunId); } catch { /* ídem */ }
    };
    try {
      try { db.prepare('INSERT INTO decl_runs(id,rfc,tipo,ejercicio,periodo,started,finished,ok,error,errorKind,steps,attempts,origen) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(declRunId, rfc, String(query.tipo || ''), Number(query.ejercicio) || 0, String(query.periodo || ''),
          time, 0, 0, '', '', '[]', 0, origen || ''); } catch { /* el diario nunca tumba la corrida */ }
      writeDeclProgress(rfc, { tipo: query.tipo, ejercicio: query.ejercicio, running: true,
        step: 'Recuperando declaraciones del portal…', at: time });
      for (let attempt = 1; attempt <= 2; attempt++) {
        declAttempt = attempt;
        const result = await runDeclaracionesAttemptOnce(rfc, query, attempt === 1 ? time : now(),
          { attempt, token, deferAlert: true, onStep });
        if (result.ok) {
          writeDeclProgress(rfc, { tipo: query.tipo, ejercicio: query.ejercicio, running: false, ok: true,
            step: attempt === 2 ? 'Recuperación guardada · bajó al segundo intento' : 'Recuperación guardada', at: now() });
          closeDeclRun(true, '', '');
          return attempt === 2 ? { ...result, segundoIntento: true } : result;
        }
        if (result.cancelled) {
          writeDeclProgress(rfc, { tipo: query.tipo, ejercicio: query.ejercicio, running: false, ok: false,
            step: 'Recuperación cancelada por ti', at: now() });
          closeDeclRun(false, result.error || 'Recuperación cancelada por ti.', result.errorKind || '');
          return result;
        }
        failures.push({ error: result.error, errorKind: result.errorKind || '', at: now(), diag: result.diag || null });
        if (attempt === 1 && SATDOC_PORTAL_KINDS.includes(result.errorKind) && !token.cancelled) {
          const waitMs = satDocRetryWait();
          writeDeclProgress(rfc, { tipo: query.tipo, ejercicio: query.ejercicio, running: true,
            step: 'El portal no respondió como se esperaba: reintento automático en ' +
              Math.max(1, Math.round(waitMs / 1000)) + ' s (puedes cancelar la espera)…', at: now() });
          const waited = await sleepCancellable(waitMs, token);
          if (!waited || token.cancelled) {
            writeDeclProgress(rfc, { tipo: query.tipo, ejercicio: query.ejercicio, running: false, ok: false,
              step: 'Recuperación cancelada por ti', at: now() });
            closeDeclRun(false, 'Recuperación cancelada por ti.', '');
            return { ok: false, cancelled: true, error: 'Recuperación cancelada por ti.' };
          }
          continue;
        }
        break;
      }
      writeDeclProgress(rfc, { tipo: query.tipo, ejercicio: query.ejercicio, running: false, ok: false,
        step: failures[failures.length - 1].error, at: now() });
      queueAlert('decl-fail', 'decl:' + rfc + ':' + query.tipo + ':' + Math.floor(time / DAY),
        'PacoSAT · No se pudieron recuperar declaraciones de ' + rfc + (failures.length > 1 ? ' (dos intentos)' : ''),
        declFailBody(rfc, query, failures), time, rfc);
      closeDeclRun(false, failures[failures.length - 1].error, failures[failures.length - 1].errorKind || '',
        failures[failures.length - 1].diag || null);
      return { ok: false, error: failures[failures.length - 1].error };
    } finally { closeDeclRun(false, failures[failures.length - 1]?.error || 'Recuperación cancelada por ti.', failures[failures.length - 1]?.errorKind || '', failures[failures.length - 1]?.diag || null); declLive.delete(key); }
  }
  function cancelDeclRun(rfc) {
    let found = false;
    for (const [key, token] of declLive) if (key.startsWith(rfc + ':')) { token.cancelled = true; found = true; }
    return found;
  }
  function declaracionesOverview(rfc, ejercicio, time) {
    const rows = db.prepare("SELECT * FROM declaraciones WHERE rfc=? AND fileId<>'' ORDER BY created DESC").all(rfc);
    const mine = rows.filter(row => row.ejercicio === ejercicio);
    const monthOf = time => new Date(time).toISOString().slice(0, 7);
    const currentMonth = monthOf(time);
    const mensuales = [];
    for (let m = 1; m <= 12; m++) {
      const periodo = ejercicio + '-' + String(m).padStart(2, '0');
      const docs = mine.filter(row => row.tipo === 'mensual' && row.periodo === periodo);
      const futuro = periodo >= currentMonth;
      mensuales.push({ periodo, futuro,
        declaracion: docs.some(row => row.clase === 'declaracion'),
        acuse: docs.some(row => row.clase === 'acuse'),
        estado: docs.length ? 'recuperada' : futuro ? 'aun-no-toca' : 'sin-recuperar' });
    }
    const anualDocs = mine.filter(row => row.tipo === 'anual');
    const lastError = db.prepare("SELECT error,errorKind,created FROM declaraciones WHERE rfc=? AND error<>'' ORDER BY created DESC LIMIT 1").get(rfc);
    /* ===== Mapa anual (1.17.0, propuesta P13 — su mitad de
       PANTALLA; la de papel salió en la capa de salidas de la
       1.14.0): el estado de cada obligación del año en palabras,
       calculado desde los documentos recuperados y con el
       calendario que la propia app ya usa en Cumplimiento — la
       mensual vence el día 17 del mes siguiente y la anual el 31
       de marzo del ejercicio siguiente:
       · «presentada»: consta recuperada (la declaración o su
         acuse; el acuse solo existe si se presentó), con su fecha
         de presentación y su nº de operación.
       · «pendiente»: el periodo ya cerró y el plazo sigue abierto.
       · «vencida»: pasó la fecha límite sin que conste presentada
         en el expediente — el hueco que se ve en rojo desde el
         mapa, sin entrar mes a mes.
       · «no-toca»: el periodo aún no cierra. ===== */
    const hoyMapa = new Date(time).toISOString().slice(0, 10);
    const isoMapa = (y, m, d) => new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10);
    /* N11 (1.22.0): el mapa llamaba «Vencida» a todo mes pasado
       sin documento recuperado — afirmaba un incumplimiento donde
       los datos solo dicen «no consta en PacoSAT» (la declaración
       pudo presentarla la contadora por otra vía). Sin documento,
       el estado es «sin-recuperar»: no consta presentada EN TU
       EXPEDIENTE. «Vencida» queda reservada a una constancia
       positiva de no presentación, que no existe como dato. */
    const mapaCelda = (docs, limite, cierre) => {
      /* La verificación manda al elegir (1.29.0): si hay un
         documento verificado (PDF guardado + nº de operación
         comprobado contra el trabajo que lo pidió), es ESE el que
         da el mes por bueno; la subida manual de Paco conserva su
         gesto — su fila lleva verificada=0 a la vista en
         «documentos» hasta que su operación conste. */
      const ordenados = [...docs].sort((a, b) => (b.verificada ? 1 : 0) - (a.verificada ? 1 : 0));
      const doc = ordenados.find(row => row.clase === 'declaracion') || ordenados[0];
      if (doc) return { estado: 'presentada', limite, verificada: Boolean(doc.verificada),
        fechaPresentacion: doc.fechaPresentacion || '', operacion: doc.operacion || '' };
      return { estado: hoyMapa <= cierre ? 'no-toca' : hoyMapa <= limite ? 'pendiente' : 'sin-recuperar',
        limite, fechaPresentacion: '', operacion: '' };
    };
    /* Pieza 12 (1.22.0): el estado intermedio honesto — el mes
       tiene una LÍNEA DE IMPUESTOS PAGADA en los pagos del mes
       (la preparación que el despacho alimenta y Paco marcó
       pagada) pero su acuse aún no se ha recuperado: ni
       «presentada» (eso solo lo dice el acuse) ni «sin recuperar»
       a secas. El cruce cita la preparación y la línea reales. */
    const lineaImpuestosPagada = periodo => {
      const rows = db.prepare('SELECT id,payload FROM pay_preparations WHERE rfc=? AND month=? ORDER BY created DESC').all(rfc, periodo);
      for (const row of rows) {
        let prep = null;
        try { prep = JSON.parse(row.payload); } catch { prep = null; }
        if (!prep?.pagadaEn) continue;
        const lineas = [...(prep.bbva?.lines || []), ...(prep.interbancario?.lines || []), ...(prep.speiIndividual?.lines || [])];
        const linea = lineas.find(l => /impuesto|contribuci|línea de captura|linea de captura|\bSAT\b/i
          .test([l.nombre, l.concepto, l.motivo, l.folio].filter(Boolean).join(' ')));
        if (linea) return { preparacion: row.id, pagadaEn: prep.pagadaEn,
          concepto: linea.concepto || linea.nombre || 'Línea de impuestos' };
      }
      return null;
    };
    const mapaMeses = mensuales.map((mes, index) => {
      const docs = mine.filter(row => row.tipo === 'mensual' && row.periodo === mes.periodo);
      const celda = { periodo: mes.periodo, declaracion: mes.declaracion, acuse: mes.acuse,
        ...mapaCelda(docs, isoMapa(ejercicio, index + 1, 17), isoMapa(ejercicio, index + 1, 0)) };
      if (celda.estado === 'sin-recuperar' || celda.estado === 'pendiente') {
        const linea = lineaImpuestosPagada(mes.periodo);
        if (linea) { celda.estado = 'pagada-sin-acuse'; celda.lineaImpuestos = linea; }
      }
      return celda;
    });
    const mapaAnual = { ejercicio, declaracion: anualDocs.some(row => row.clase === 'declaracion'),
      acuse: anualDocs.some(row => row.clase === 'acuse'),
      ...mapaCelda(anualDocs, isoMapa(ejercicio + 1, 2, 31), isoMapa(ejercicio, 11, 31)) };
    const mapaResumen = { presentadas: 0, pendientes: 0, sinRecuperar: 0, pagadasSinAcuse: 0, noToca: 0 };
    for (const celda of mapaMeses) {
      if (celda.estado === 'presentada') mapaResumen.presentadas++;
      else if (celda.estado === 'pendiente') mapaResumen.pendientes++;
      else if (celda.estado === 'pagada-sin-acuse') mapaResumen.pagadasSinAcuse++;
      else if (celda.estado === 'sin-recuperar') mapaResumen.sinRecuperar++;
      else mapaResumen.noToca++;
    }
    const mapa = { meses: mapaMeses, anual: mapaAnual, resumen: mapaResumen };
    return { rfc, ejercicio, configured: Boolean(satDeclFetch || remoteExecutor), mensuales, mapa,
      anual: { declaracion: anualDocs.some(row => row.clase === 'declaracion'),
        acuse: anualDocs.some(row => row.clase === 'acuse'),
        estado: anualDocs.length ? 'recuperada' : 'sin-recuperar' },
      documentos: mine.map(row => ({ id: row.id, tipo: row.tipo, clase: row.clase, ejercicio: row.ejercicio,
        periodo: row.periodo, fechaPresentacion: row.fechaPresentacion, operacion: row.operacion,
        fileId: row.fileId, created: row.created, label: DECL_LABEL[row.tipo + ':' + row.clase] || 'Declaración' })),
      lastError: lastError ? { error: lastError.error, kind: lastError.errorKind || '', at: lastError.created } : null,
      progreso: declState()[rfc] || null,
      /* Registro de folios y mapa por años (1.25.0, mejora nº 1 y
         AGREGAR 8): el servicio oficial de acuses (77792)
         reimprime POR FOLIO; aquí viven los folios conocidos del
         ejercicio y, en «anios», la foto de cada ejercicio para
         la recuperación histórica por año completo. */
      folios: db.prepare('SELECT * FROM decl_folios WHERE rfc=? AND ejercicio=? ORDER BY periodo, folio').all(rfc, ejercicio)
        .map(row => ({ id: row.id, tipo: row.tipo, ejercicio: row.ejercicio, periodo: row.periodo,
          folio: row.folio, estado: row.estado, nota: row.nota, creado: row.creado })),
      anios: declAnios(rfc, time) };
  }
  /* Foto por ejercicio (AGREGAR 8): para cada año con algo
     archivado o con folios, cuántos meses tienen su acuse, si la
     anual consta y cuántos folios se conocen — la base de la
     recuperación histórica por año completo. */
  function declAnios(rfc, time) {
    const years = new Set();
    for (const row of db.prepare("SELECT DISTINCT ejercicio FROM declaraciones WHERE rfc=? AND fileId<>''").all(rfc)) years.add(row.ejercicio);
    for (const row of db.prepare('SELECT DISTINCT ejercicio FROM decl_folios WHERE rfc=?').all(rfc)) years.add(row.ejercicio);
    const currentYear = Number(new Date(time).toISOString().slice(0, 4));
    years.add(currentYear); years.add(currentYear - 1);
    return [...years].filter(year => year >= 2015).sort((a, b) => b - a).map(ejercicio => {
      const docs = db.prepare("SELECT * FROM declaraciones WHERE rfc=? AND ejercicio=? AND fileId<>''").all(rfc, ejercicio);
      const mesesConAcuse = new Set(docs.filter(row => row.tipo === 'mensual' && row.clase === 'acuse').map(row => row.periodo)).size;
      const mesesConDecl = new Set(docs.filter(row => row.tipo === 'mensual' && row.clase === 'declaracion').map(row => row.periodo)).size;
      const folios = db.prepare('SELECT COUNT(*) AS n FROM decl_folios WHERE rfc=? AND ejercicio=?').get(rfc, ejercicio).n;
      const foliosPendientes = db.prepare("SELECT COUNT(*) AS n FROM decl_folios WHERE rfc=? AND ejercicio=? AND estado<>'con-acuse'").get(rfc, ejercicio).n;
      return { ejercicio, mesesConAcuse, mesesConDecl,
        anual: docs.some(row => row.tipo === 'anual'),
        folios, foliosPendientes,
        completo: mesesConAcuse >= 12 && docs.some(row => row.tipo === 'anual' && row.clase === 'acuse') };
    });
  }

  /* ===== Cumplimiento (1.6.18) =====
     Calendario fiscal por RFC (lo que el sistema conoce — caducidad
     de e.firma, constancias que envejecen, día 17 y anual — más lo
     que se capture a mano), detector de errores y duplicados sobre
     los registros guardados y paquete de defensa por periodo. */
  function fiscalEvents(time) {
    const events = [];
    const mx = mxParts(time);
    const profiles = db.prepare('SELECT rfc,certExpires FROM profiles').all();
    for (const profile of profiles) {
      if (profile.certExpires) events.push({ rfc: profile.rfc, kind: 'efirma', title: 'Caducidad de la e.firma',
        date: new Date(profile.certExpires).toISOString().slice(0, 10) });
      /* Día 17: provisionales y DIOT del mes anterior. */
      const due17 = mx.day <= 17 ? mx.monthKey + '-17' : (() => { const d = new Date(Date.UTC(Number(mx.monthKey.slice(0, 4)), Number(mx.monthKey.slice(5, 7)), 17)); return d.toISOString().slice(0, 10); })();
      events.push({ rfc: profile.rfc, kind: 'mensual', title: 'Pago provisional y DIOT (día 17)', date: due17 });
      const annualYear = mx.monthKey <= '03' || (mx.monthKey.slice(5, 7) === '03' && mx.day <= 31) ? mx.monthKey.slice(0, 4) : String(Number(mx.monthKey.slice(0, 4)) + 1);
      events.push({ rfc: profile.rfc, kind: 'anual', title: 'Declaración anual (31 de marzo)', date: annualYear + '-03-31' });
      const docs = db.prepare('SELECT MAX(issuedAt) AS newest FROM sat_documents WHERE rfc=?').get(profile.rfc);
      if (docs?.newest) {
        const staleAt = new Date(docs.newest + 90 * DAY).toISOString().slice(0, 10);
        events.push({ rfc: profile.rfc, kind: 'constancia', title: 'La constancia/opinión cumple 90 días (renovarla)', date: staleAt });
      }
    }
    let manual = [];
    try { manual = JSON.parse(getState('fiscal-events') || '[]'); } catch { manual = []; }
    for (const item of Array.isArray(manual) ? manual : [])
      events.push({ rfc: item.rfc || '', kind: 'manual', title: item.title, date: item.date, id: item.id });
    for (const event of events) event.daysLeft = Math.round((Date.parse(event.date + 'T12:00:00Z') - time) / DAY);
    return events.sort((a, b) => a.date.localeCompare(b.date));
  }
  function fiscalIssues() {
    const issues = [];
    const profileRfcs = new Set(db.prepare('SELECT rfc FROM profiles').all().map(row => row.rfc));
    const invoices = recordInvoices();
    const byFolio = new Map();
    for (const invoice of invoices) {
      if (invoice.fiscal?.serie || invoice.fiscal?.folio) {
        const key = invoice.from.rfc + '|' + (invoice.fiscal.serie || '') + '|' + (invoice.fiscal.folio || '');
        /* Folio repetido (afinado en la ronda de correcciones, 9 nov
           2026): los bancos usan como folio el nº de cuenta/contrato,
           idéntico cada mes, con fechas e importes distintos — eso NO
           es un duplicado. Solo es sospechoso (el patrón de una
           cancelada reemitida con el mismo folio) si ADEMÁS coincide
           la fecha de emisión o el importe total con otro UUID. */
        const diaEmision = String(invoice.date || '').slice(0, 10);
        const total = centsOf(invoice.total);
        const group = byFolio.get(key) || [];
        const clash = group.find(other => other.id !== invoice.id &&
          ((diaEmision && other.dia === diaEmision) || (total > 0n && other.total === total)));
        if (clash)
          issues.push({ id: invoice.id, kind: 'folio-duplicado',
            detail: 'Mismo emisor, serie y folio que ' + clash.id + ' con otro UUID, y además coincide ' +
              (diaEmision && clash.dia === diaEmision ? 'la fecha de emisión' : 'el importe total') +
              ': patrón de una factura reemitida con el mismo folio.' });
        group.push({ id: invoice.id, dia: diaEmision, total });
        byFolio.set(key, group);
      }
      if (invoice.kind === 'I' && invoice.to?.rfc && !profileRfcs.has(invoice.to.rfc) && profileRfcs.has(invoice.from?.rfc) === false &&
          ![...profileRfcs].some(rfc => invoice.from?.rfc === rfc))
        issues.push({ id: invoice.id, kind: 'receptor-ajeno', detail: 'El receptor ' + invoice.to.rfc + ' no es ningún perfil de PacoSAT (¿importado en la empresa equivocada?).' });
      const fiscal = invoice.fiscal;
      if (fiscal && fiscal.subtotal) {
        const expected = (centsOf(fiscal.subtotal) - centsOf(fiscal.discount) + centsOf(fiscal.totalTransferred) - centsOf(fiscal.totalWithheld));
        if (Math.abs(Number(expected - centsOf(invoice.total))) > 5)
          issues.push({ id: invoice.id, kind: 'totales-no-cuadran', detail: 'Subtotal − descuento + impuestos − retenciones = $' + moneyText(expected) + ' pero el total dice $' + moneyText(centsOf(invoice.total)) + '.' });
      }
    }
    return issues.slice(0, 200);
  }
  function fiscalTick(time) {
    for (const event of fiscalEvents(time)) {
      if (event.daysLeft > 3 || event.daysLeft < -7) continue;
      queueAlert('fiscal-due', 'fiscal:' + (event.rfc || 'general') + ':' + event.date + ':' + event.title,
        'PacoSAT · Vencimiento fiscal cercano',
        (event.rfc ? event.rfc + ' · ' : '') + event.title + ' — fecha: ' + event.date +
        (event.daysLeft < 0 ? ' (ya venció hace ' + (-event.daysLeft) + ' días)' : event.daysLeft === 0 ? ' (vence HOY)' : ' (faltan ' + event.daysLeft + ' días)') +
        '. Ábrelo en la pantalla Cumplimiento para resolverlo.', time);
    }
  }
  async function buildDefensePackage(month) {
    const invoices = recordInvoices().filter(invoice => String(invoice.date || '').startsWith(month));
    const entries = [];
    const lines = [['uuid', 'fecha', 'emisor', 'receptor', 'tipo', 'total'].join(',')];
    for (const invoice of invoices) {
      lines.push([invoice.id, invoice.date, invoice.from.rfc, invoice.to.rfc, invoice.kind, invoice.total].join(','));
      const file = readFileRecord('xml:' + invoice.id);
      if (file) entries.push({ name: 'xml/' + invoice.id + '.xml', buffer: file.buffer });
    }
    entries.push({ name: 'indice.csv', buffer: Buffer.from(lines.join('\r\n'), 'utf8') });
    /* Constancias de validación: situación en listados de cada
       contraparte del periodo, a fecha de hoy. */
    const parties = new Set();
    for (const invoice of invoices) { parties.add(invoice.from.rfc); parties.add(invoice.to.rfc); }
    const validation = [['rfc', 'situacion'].join(',')];
    for (const rfc of parties) {
      const hits = db.prepare('SELECT listId, detail FROM blacklist_entries WHERE rfc=?').all(rfc)
        .map(hit => (LIST_CATALOG.find(item => item.id === hit.listId)?.label || hit.listId) + ' ' + hit.detail);
      validation.push([rfc, hits.length ? hits.join(' | ') : 'Sin coincidencias'].join(','));
    }
    entries.push({ name: 'validaciones.csv', buffer: Buffer.from(validation.join('\r\n'), 'utf8') });
    for (const profile of db.prepare('SELECT rfc FROM profiles').all())
      for (const kind of ['constancia', 'opinion']) {
        const doc = db.prepare('SELECT fileId FROM sat_documents WHERE rfc=? AND kind=? ORDER BY issuedAt DESC LIMIT 1').get(profile.rfc, kind);
        const file = doc?.fileId ? readFileRecord(doc.fileId) : null;
        if (file) entries.push({ name: 'documentos/' + profile.rfc + '-' + kind + '.pdf', buffer: file.buffer });
      }
    entries.push({ name: 'resumen.txt', buffer: Buffer.from('Paquete de defensa PacoSAT · Periodo ' + month + '\r\n' +
      'Generado: ' + new Date(now()).toISOString() + '\r\nXML del periodo: ' + invoices.length + '\r\n' +
      'Contiene: indice.csv, xml/ con los CFDI del periodo, validaciones.csv (listados oficiales a hoy) y las constancias/opiniones vigentes archivadas.\r\n', 'utf8') });
    return zipStoreBuffers(entries);
  }

  /* ===== Expediente legal por contraparte (1.25.0, AGREGAR 6) =====
     Un clic: todos los CFDI entre el perfil y la contraparte (XML
     archivados + índice), su situación en los listados oficiales
     a hoy (69-B incluido), las constancias/opinión vigentes del
     perfil y un resumen con los saldos vivos. Es el mismo patrón
     del paquete de defensa mensual, acotado a una contraparte:
     sirve tal cual para entregar a la contadora o a un abogado. */
  function buildCounterpartFile(perfilRfc, cpRfc) {
    const invoices = recordInvoices().filter(invoice =>
      (invoice.from?.rfc === cpRfc && invoice.to?.rfc === perfilRfc) ||
      (invoice.from?.rfc === perfilRfc && invoice.to?.rfc === cpRfc));
    const entries = [];
    const lines = [['uuid', 'fecha', 'sentido', 'tipo', 'total', 'estado'].join(',')];
    let recibidos = 0n, emitidos = 0n;
    for (const invoice of invoices) {
      const sentido = invoice.from?.rfc === cpRfc ? 'recibido' : 'emitido';
      if (invoice.kind === 'I') { if (sentido === 'recibido') recibidos += centsOf(invoice.total); else emitidos += centsOf(invoice.total); }
      lines.push([invoice.id, invoice.date, sentido, invoice.kind, invoice.total,
        salidaEstadoSat(invoice.id)].join(','));
      const file = readFileRecord('xml:' + invoice.id);
      if (file) entries.push({ name: 'xml/' + invoice.id + '.xml', buffer: file.buffer });
    }
    entries.push({ name: 'indice.csv', buffer: Buffer.from(lines.join('\r\n'), 'utf8') });
    const hits = db.prepare('SELECT listId, detail FROM blacklist_entries WHERE rfc=?').all(cpRfc)
      .map(hit => (LIST_CATALOG.find(item => item.id === hit.listId)?.label || hit.listId) + ' — ' + hit.detail);
    entries.push({ name: 'validaciones.csv', buffer: Buffer.from(
      ['rfc', 'situacion-en-listados'].join(',') + '\r\n' +
      [cpRfc, hits.length ? hits.join(' | ') : 'Sin coincidencias en los listados cargados'].join(','), 'utf8') });
    for (const kind of ['constancia', 'opinion']) {
      const doc = db.prepare('SELECT fileId FROM sat_documents WHERE rfc=? AND kind=? ORDER BY issuedAt DESC LIMIT 1').get(perfilRfc, kind);
      const file = doc?.fileId ? readFileRecord(doc.fileId) : null;
      if (file) entries.push({ name: 'documentos/' + perfilRfc + '-' + kind + '.pdf', buffer: file.buffer });
    }
    const saldos = moneyBalances().filter(balance => !balance.cancelled && balance.balance > 0n &&
      ((balance.from?.rfc === cpRfc && balance.to?.rfc === perfilRfc) ||
       (balance.from?.rfc === perfilRfc && balance.to?.rfc === cpRfc)));
    entries.push({ name: 'resumen.txt', buffer: Buffer.from(
      'Expediente legal por contraparte · PacoSAT\r\n' +
      'Perfil: ' + perfilRfc + '\r\nContraparte: ' + cpRfc + '\r\n' +
      'Generado: ' + new Date(now()).toISOString() + '\r\n' +
      'Comprobantes entre ambos: ' + invoices.length + ' (recibidos $' + moneyText(recibidos) +
      ' · emitidos $' + moneyText(emitidos) + ')\r\n' +
      'Saldos vivos: ' + saldos.length + ' por $' + moneyText(saldos.reduce((sum, b) => sum + b.balance, 0n)) + '\r\n' +
      'Situación en listados: ' + (hits.length ? hits.join(' | ') : 'sin coincidencias') + '\r\n' +
      'Contiene: indice.csv, xml/ con los CFDI archivados, validaciones.csv y las constancias/opinión vigentes del perfil.\r\n', 'utf8') });
    return zipStoreBuffers(entries);
  }
  /* Expediente de materialidad AUTOMÁTICO (1.25.0, AGREGAR 10 —
     patrón STOLOOF): cuando una contraparte cae en 69-B
     Definitivo y Paco tiene CFDI con ella, el expediente se arma
     solo (el de arriba) y queda archivado en Expedientes con su
     aviso: nadie tiene que acordarse de pedirlo a mano el día
     que el SAT lo necesite. La huella de la situación evita
     regenerarlo en cada ciclo: solo se rehace si la situación
     en los listados cambia. */
  function materialidadAuto(cp, time) {
    const definitivo = (cp.hits || []).some(hit => hit.listId === '69b' &&
      (hit.severity === 'bad' || /definitiv/i.test(String(hit.detail || ''))));
    if (!definitivo) return;
    const profileRfcs = new Set(db.prepare('SELECT rfc FROM profiles').all().map(row => row.rfc));
    const huella = createHash('sha256').update(JSON.stringify(cp.hits)).digest('hex').slice(0, 12);
    for (const perfil of profileRfcs) {
      const tiene = recordInvoices().some(invoice =>
        (invoice.from?.rfc === cp.rfc && invoice.to?.rfc === perfil) ||
        (invoice.from?.rfc === perfil && invoice.to?.rfc === cp.rfc));
      if (!tiene) continue;
      const clave = 'materialidad-fp:' + perfil + ':' + cp.rfc;
      if (getState(clave) === huella) continue;
      setState(clave, huella);
      let buffer = null;
      try { buffer = buildCounterpartFile(perfil, cp.rfc); } catch { buffer = null; }
      if (!buffer) continue;
      const fileId = 'zip:' + randomUUID();
      tx(db, () => {
        putFile(fileId, buffer, 'application/zip');
        putMetadata('documents', { id: fileId, rfc: perfil, kind: 'Expediente de materialidad 69-B',
          date: day(time), period: '', name: 'Expediente de materialidad · ' + (cp.name || cp.rfc) + ' (' + cp.rfc + ').zip' });
      });
      avisoEnsure({ ref: 'materialidad:' + perfil + ':' + cp.rfc, kind: 'materialidad', clase: 'mal', estado: 'abierto',
        severidad: 'alta',
        titulo: (cp.name || cp.rfc) + ' cayó en 69-B Definitivo: expediente de materialidad listo',
        detalle: 'La contraparte ' + (cp.name || cp.rfc) + ' (' + cp.rfc + ') consta en el listado 69-B con situación ' +
          'Definitivo y tienes comprobantes con ella. PacoSAT ya armó el expediente de materialidad (CFDI, validaciones ' +
          'y constancias) y lo dejó en Expedientes: es el patrón del caso STOLOOF, hecho solo y a tiempo. ' +
          'Pásaselo a la contadora para valorar la defensa de esos comprobantes.',
        contraparte: cp.rfc, nombre: cp.name || '', importe: '', enlace: 'lists',
        rfc: perfil, responsable: 'Contadora',
        accion: 'Entregar el expediente de materialidad a la contadora y valorar la defensa',
        datos: { rfc: cp.rfc, fileId } }, time, 0);
      putMetadata('activity', { id: 'materialidad:' + perfil + ':' + cp.rfc + ':' + huella,
        name: 'Expediente de materialidad 69-B', date: new Date(time).toISOString(), added: 0, duplicates: 0, review: 1,
        issues: [{ name: cp.name || cp.rfc, reason: 'Cayó en 69-B Definitivo: expediente de materialidad generado.' }],
        event: 'Expediente de materialidad generado para ' + (cp.name || cp.rfc) + ' (' + cp.rfc + ') al caer en 69-B Definitivo.' });
    }
  }

  /* ===== Constancias y opinión del SAT (1.6.14) =====
     SOLO SAT (el IMSS quedó fuera por orden de Paco). Por RFC se puede
     activar la descarga mensual automática de la constancia de
     situación fiscal y la opinión de cumplimiento: el PDF se archiva
     en Expedientes, se envía por correo a los destinatarios fijados y
     su antigüedad se vigila con semáforo (verde <60 días, ámbar
     60–90, rojo >90). La descarga pasa por el puerto satDocFetch: el
     portal del SAT exige su propio flujo con e.firma; si un intento
     falla —portal caído, flujo rechazado o puerto no disponible— el
     intento queda registrado, llega una alerta y el semáforo manda.
     También se puede subir el PDF a mano: vale igual. */
  const DOC_KIND_LABEL = { constancia: 'Constancia / CIF', opinion: 'Opinión de cumplimiento' };
  const satDocsConfig = () => { try { return JSON.parse(db.prepare("SELECT value FROM settings WHERE key='satdocs'").get()?.value || '{}'); } catch { return {}; } };
  const satDocsState = () => { try { return JSON.parse(db.prepare("SELECT value FROM settings WHERE key='satdocs-state'").get()?.value || '{}'); } catch { return {}; } };
  const saveSatDocsState = state => db.prepare("INSERT INTO settings(key,value) VALUES ('satdocs-state',?) " +
    "ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(state));
  function latestSatDoc(rfc, kind) {
    return db.prepare("SELECT * FROM sat_documents WHERE rfc=? AND kind=? AND fileId<>'' ORDER BY issuedAt DESC, created DESC LIMIT 1")
      .get(rfc, kind) || null;
  }
  /* N7 (1.22.0): la «caducidad» 60/90 era una política propia
     presentada como caducidad externa — y la constancia no
     caduca. Los niveles son de RECENCIA (banda 60/90 para ambos
     documentos), declarados como política de la casa en las
     alertas y en la pantalla. */
  function docLevel(issuedAt, time, kind = '') {
    /* N7 (1.22.0): los umbrales 60/90 son la POLÍTICA DE RECENCIA
       propia de PacoSAT — ningún documento «caduca» oficialmente
       a los 60/90 días (la constancia no caduca) — y así se
       etiqueta en las alertas y en la pantalla. Los umbrales no
       cambian: lo que cambia es que ya no se presentan como una
       caducidad del SAT. */
    if (!issuedAt) return 'none';
    const days = Math.floor((time - issuedAt) / DAY);
    return days < 60 ? 'ok' : days <= 90 ? 'warn' : 'bad';
  }
  function archiveSatDoc(rfc, kind, content, issuedAt, source, time, fileName) {
    const fileId = 'pdf:' + randomUUID();
    const base64 = Buffer.isBuffer(content) ? content.toString('base64') : String(content);
    tx(db, () => {
      db.prepare("INSERT OR REPLACE INTO records(store,id,value,data,mime) VALUES ('files',?,NULL,?,'application/pdf')")
        .run(fileId, Buffer.isBuffer(content) ? content : Buffer.from(base64, 'base64'));
      db.prepare("INSERT OR REPLACE INTO records(store,id,value) VALUES ('documents',?,?)")
        .run(fileId, JSON.stringify({ id: fileId, rfc, kind: DOC_KIND_LABEL[kind],
          date: new Date(issuedAt).toISOString().slice(0, 10), period: '', name: fileName || DOC_KIND_LABEL[kind] + ' · ' + rfc + '.pdf' }));
      db.prepare('INSERT INTO sat_documents(id,rfc,kind,issuedAt,fileId,source,created) VALUES (?,?,?,?,?,?,?)')
        .run(randomUUID(), rfc, kind, issuedAt, fileId, source, time);
    });
    /* Puente a Paperless (1.25.0): la constancia/opinión también
       se archiva allí, con sus etiquetas, si el puente está
       activado; si no, esta llamada no hace nada. */
    paperlessEnqueue(fileId, (DOC_KIND_LABEL[kind] || kind) + ' · ' + rfc + '.pdf',
      ['PacoSAT', rfc, kind === 'constancia' ? 'Constancia' : 'Opinión']);
    return fileId;
  }
  /* Poda de diarios (1.28.0, P1 + addendum): se conservan las
     últimas 20 corridas de cada RFC y motor Y, además, los
     fallos de los últimos 90 días con su página: la evidencia de un
     fallo nunca se la lleva la poda mientras sea reciente. Antes
     la poda era solo «20 por RFC» y podía borrar la página del
     fallo que había que diagnosticar. Corrección H-5.1 de la
     pasada de seguridad: la retención de fallos gana un techo
     (100 por RFC y motor) y audit_events gana su propia poda. */
  const RUN_DIARY_KEEP = 20, RUN_FAILURE_KEEP_MS = 90 * DAY, RUN_FAILURE_KEEP_MAX = 100;
  /* Poda de audit_events (corrección H-5.1): la tabla de las
     acciones del administrador y de las corridas de respaldo
     también tiene techo — los últimos 180 días y, como mucho,
     las 5.000 filas más recientes — y corre en el mismo punto
     que la poda de diarios. */
  const AUDIT_KEEP_MS = 180 * DAY, AUDIT_KEEP_MAX = 5000;
  function pruneAuditEvents(ahora) {
    try {
      db.prepare('DELETE FROM audit_events WHERE at < ?').run(ahora - AUDIT_KEEP_MS);
      db.prepare('DELETE FROM audit_events WHERE id NOT IN (SELECT id FROM audit_events ORDER BY at DESC, id DESC LIMIT ' + AUDIT_KEEP_MAX + ')').run();
    } catch { /* la poda nunca tumba el cierre de un diario */ }
  }
  function pruneRunDiary(table, rfc, ahora) {
    /* Techo de la retención de fallos (corrección H-5.1): dentro
       de la ventana de 90 días se conservan como mucho los 100
       fallos más recientes por RFC y motor; los que excedan se
       podan con su evidencia, como el resto de la poda. */
    const retenidos = new Set(db.prepare('SELECT id FROM ' + table +
      ' WHERE rfc=? AND ok=0 AND started>? ORDER BY started DESC LIMIT ' + RUN_FAILURE_KEEP_MAX)
      .all(rfc, ahora - RUN_FAILURE_KEEP_MS).map(row => row.id));
    const stale = db.prepare('SELECT id,shotId,htmlId,ok,started FROM ' + table +
      ' WHERE rfc=? ORDER BY started DESC LIMIT -1 OFFSET ' + RUN_DIARY_KEEP).all(rfc);
    for (const row of stale) {
      if (!row.ok && row.started > ahora - RUN_FAILURE_KEEP_MS && retenidos.has(row.id)) continue;
      for (const fileId of [row.shotId, row.htmlId]) {
        if (fileId) db.prepare("DELETE FROM records WHERE store='files' AND id=?").run(fileId);
      }
      db.prepare('DELETE FROM ' + table + ' WHERE id=?').run(row.id);
    }
    pruneAuditEvents(ahora);
  }
  /* Inventario de la página del fallo (1.28.0, addendum): cuando
     un motor muere buscando un enlace o una bandeja, el diario
     anota qué enlaces y textos SÍ enseñaba la página, para que el
     arreglo se haga contra la pantalla real. Se extrae del HTML
     guardado, sin navegador y sin coste. */
  function diagLinkInventory(html) {
    if (!html) return [];
    /* Un diagnóstico corrupto jamás tumba el cierre del diario:
       si ni siquiera se puede leer como texto, no hay inventario. */
    let source = '';
    try { source = String(html); } catch { return []; }
    const seen = new Set(), out = [];
    const push = text => { const clean = String(text || '').replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ')
      .replace(/\s+/g, ' ').trim(); if (clean && clean.length <= 80 && !seen.has(clean.toLowerCase())) {
      seen.add(clean.toLowerCase()); out.push(clean); } };
    for (const match of source.matchAll(/<a\b[^>]*>([\s\S]{0,300}?)<\/a>/gi)) push(match[1]);
    for (const match of source.matchAll(/<(?:button|input)\b[^>]*(?:value|title|aria-label)\s*=\s*["']([^"']{1,80})["']/gi)) push(match[1]);
    return out.slice(0, 24);
  }
  /* Archiva la página de un fallo (captura + HTML) como records
     'diag:<runId>:shot'/':html' y devuelve sus ids (1.27.0): lo
     comparten los cuatro diarios. 1.28.0 (addendum): el guardado
     se VERIFICA releyendo cada artefacto; si una parte no se pudo
     guardar, su id queda vacío y `faltas` lo dice — el diario lo
     anota en un paso y jamás queda una referencia colgada en
     silencio (en producción, 12 nov, una corrida del buzón dejó
     un shotId que no resolvía a ningún artefacto). */
  /* Tope del HTML guardado (corrección H-5.1): 2 MB por
     artefacto; la página que lo exceda se guarda recortada,
     con su marca dentro y su aviso en el diario — nunca entera
     y nunca perdida en silencio. */
  const DIAG_HTML_MAX_BYTES = 2 * 1024 * 1024;
  function saveRunDiag(runId, diag) {
    let shotId = '', htmlId = '';
    const faltas = [];
    const avisos = [];
    if (diag) {
      if (diag.screenshot && diag.screenshot.length) {
        const id = 'diag:' + runId + ':shot';
        try {
          const data = Buffer.isBuffer(diag.screenshot) ? diag.screenshot : Buffer.from(diag.screenshot);
          db.prepare("INSERT OR REPLACE INTO records(store,id,value,data,mime) VALUES ('files',?,NULL,?,'image/png')").run(id, data);
          const back = db.prepare("SELECT data FROM records WHERE store='files' AND id=?").get(id);
          if (back?.data && back.data.length === data.length) shotId = id;
          else faltas.push('la captura de pantalla (no se pudo guardar)');
        } catch (error) { faltas.push('la captura de pantalla (no se pudo guardar: ' + (error?.message || error) + ')'); }
      }
      if (diag.html) {
        const id = 'diag:' + runId + ':html';
        try {
          let data = Buffer.from(String(diag.html), 'utf8');
          let recortada = false;
          if (data.length > DIAG_HTML_MAX_BYTES) {
            const marca = Buffer.from('\n<!-- PacoSAT: página recortada a 2 MB por tamaño -->\n', 'utf8');
            data = Buffer.concat([data.subarray(0, DIAG_HTML_MAX_BYTES - marca.length), marca]);
            recortada = true;
          }
          db.prepare("INSERT OR REPLACE INTO records(store,id,value,data,mime) VALUES ('files',?,NULL,?,'text/html; charset=utf-8')").run(id, data);
          const back = db.prepare("SELECT data FROM records WHERE store='files' AND id=?").get(id);
          if (back?.data && back.data.length === data.length) {
            htmlId = id;
            if (recortada) avisos.push('la página HTML era mayor de 2 MB y quedó guardada recortada a 2 MB');
          }
          else faltas.push('la página HTML (no se pudo guardar)');
        } catch (error) { faltas.push('la página HTML (no se pudo guardar: ' + (error?.message || error) + ')'); }
      }
    }
    return { shotId, htmlId, faltas, avisos };
  }
  /* Pasos que el cierre de un diario añade solo cuando la corrida
     FALLÓ con página guardada: el inventario de lo que la página
     enseñaba y, si la hubo, la falta de guardado (1.28.0). */
  function diagCierreSteps(diag, guardado) {
    const steps = [];
    if (!diag) return steps;
    const inventario = diagLinkInventory(diag.html);
    if (inventario.length) steps.push({ at: now(), text: 'La página del momento enseñaba: ' + inventario.join(' · ') });
    for (const aviso of guardado?.avisos || [])
      steps.push({ at: now(), text: 'Página del fallo: ' + aviso + '.' });
    if (guardado?.faltas?.length) steps.push({ at: now(), text: 'Página del fallo: no se pudo guardar ' + guardado.faltas.join(' ni ') + '.' });
    else if (guardado && (guardado.shotId || guardado.htmlId)) steps.push({ at: now(), text: 'Página del fallo guardada: puedes verla con «Ver la página del fallo».' });
    return steps;
  }
  /* Diario de una corrida (1.10.1): guarda los pasos y, si el
     fallo trajo la foto del momento (error.diag del navegador:
     captura + HTML de la página), la archiva como records para
     poder verla y bajarla desde la propia pantalla. */
  function saveSatDocRun(rfc, kind, started, finished, ok, errorText, steps, diag, errorKind = '', origen = '') {
    const id = randomUUID();
    /* Guardado verificado de la página del fallo (1.28.0): los ids
       solo quedan si el artefacto se releyó bien; si no, el diario
       lo dice en un paso (diagCierreSteps) y no cuelga referencias. */
    const guardado = ok ? { shotId: '', htmlId: '', faltas: [] } : saveRunDiag(id, diag);
    const pasos = ok ? (steps || []) : [...(steps || []), ...diagCierreSteps(diag, guardado)];
    db.prepare('INSERT INTO sat_doc_runs(id,rfc,kind,started,finished,ok,error,errorKind,steps,shotId,htmlId,origen) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, rfc, kind, started, finished, ok ? 1 : 0, errorText || '', errorKind || '', JSON.stringify(pasos), guardado.shotId, guardado.htmlId, origen || '');
    /* Poda 1.28.0: últimas 20 por RFC y todos los fallos de los
       últimos 90 días con su página (pruneRunDiary). */
    pruneRunDiary('sat_doc_runs', rfc, finished || now());
    return id;
  }
  function satDocRuns(rfc, limit = 8) {
    return db.prepare('SELECT id,kind,started,finished,ok,error,errorKind,steps,shotId,htmlId,origen FROM sat_doc_runs WHERE rfc=? ORDER BY started DESC LIMIT ?')
      .all(rfc, limit).map(row => ({ id: row.id, kind: row.kind, started: row.started, finished: row.finished,
        ok: Boolean(row.ok), error: row.error, errorKind: row.errorKind || '', steps: JSON.parse(row.steps || '[]'),
        hasShot: Boolean(row.shotId), hasHtml: Boolean(row.htmlId), origen: row.origen || '' }));
  }
  /* ===== Corridas de documentos: concurrencia, reintento y
     cancelar (1.22.0, piezas 9, 10 y 15) =====
     satDocLive es el registro de corridas VIVAS de este proceso,
     por RFC+tipo: la guarda de concurrencia (R2) responde desde
     él y el Cancelar marca su token — la corrida lo consulta tras
     cada paso y antes de archivar, descarta lo parcial y deja el
     último buen estado intacto. La espera del reintento también
     se cancela desde el token. */
  const satDocLive = new Map();
  const SATDOC_PORTAL_KINDS = ['respuesta-inesperada', 'portal-caido', 'paso-interactivo'];
  const satDocRetryWait = () => {
    const configured = Number(getSetting('satdocs-retry-wait-sec'));
    return Number.isFinite(configured) && configured >= 0 ? configured * 1000 : satDocRetryWaitMs;
  };
  const sleepCancellable = async (ms, token) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (token?.cancelled) return false;
      await new Promise(resolve => setTimeout(resolve, Math.min(200, end - Date.now())));
    }
    return !token?.cancelled;
  };
  function writeSatDocProgress(rfc, progress) {
    const current = satDocsState();
    current[rfc] = current[rfc] || {};
    current[rfc].progress = progress;
    saveSatDocsState(current);
  }
  /* El cuerpo del aviso de fallo sale del DIAGNÓSTICO, no de una
     plantilla (pieza 5): si el documento hermano del mismo RFC
     bajó minutos antes con la misma e.firma, el aviso lo dice —
     la firma funcionó y lo que falló fue el camino de ESTE
     trámite dentro del portal — y si hubo dos intentos, cuenta
     la causa probada de cada uno (pieza 10). */
  function satDocFailBody(rfc, kind, failures) {
    const label = DOC_KIND_LABEL[kind];
    const sister = kind === 'opinion' ? 'constancia' : 'opinion';
    const sisterOk = db.prepare('SELECT started FROM sat_doc_runs WHERE rfc=? AND kind=? AND ok=1 ORDER BY started DESC LIMIT 1')
      .get(rfc, sister);
    const lines = [];
    if (failures.length > 1)
      lines.push('Hubo DOS intentos y los dos cayeron. Intento 1: ' + failures[0].error +
        ' Intento 2: ' + failures[1].error);
    else lines.push('El intento de descarga automática falló: ' + failures[0].error);
    const last = failures[failures.length - 1];
    if (sisterOk && last.at - sisterOk.started < 30 * MIN)
      lines.push('El dato que lo prueba: tu e.firma SÍ funcionó — ' +
        (kind === 'opinion' ? 'la Constancia' : 'la Opinión') + ' de este mismo RFC bajó a las ' +
        new Date(sisterOk.started).toISOString().slice(11, 16) + ' (UTC) con la misma firma, minutos antes. ' +
        'Lo que falló no fue el portal en genérico ni tu firma: fue el camino de ' + label + ' dentro del portal tras firmar.');
    lines.push('El diario de la corrida (en Documentos, tarjeta de ' + label + ') guarda la página que el portal enseñó en el paso que falló. ' +
      'Gesto único: reinténtalo desde esa tarjeta o sube el PDF a mano; el documento sigue vigilado por antigüedad.');
    return lines.join(' ');
  }
  async function runSatDocAttemptOnce(rfc, kind, time, ctx = {}) {
    const state = satDocsState();
    state[rfc] = state[rfc] || {};
    state[rfc][kind + 'Attempt'] = time;
    saveSatDocsState(state);
    /* Progreso visible y diario (1.10.1): cada paso se persiste en
       el estado en cuanto ocurre. La pantalla lo enseña EN VIVO
       mientras la corrida sigue en el servidor (la descarga corre
       aquí, no en el navegador de Paco) y, si refresca o vuelve
       después, enseña el estado real —en curso con su paso actual
       o el resultado— en vez de un «Descargando del portal…» mudo
       que no dice si se conectó ni qué está haciendo. */
    const steps = [];
    const pushStep = (at, text, url) => {
      const entry = { at, text: String(text || ''), url: String(url || '') };
      steps.push(entry);
      const current = satDocsState();
      current[rfc] = current[rfc] || {};
      current[rfc].progress = { kind, running: true, step: entry.text, at: entry.at, steps: steps.slice(-12) };
      saveSatDocsState(current);
    };
    const finishProgress = (ok, finalText) => {
      const current = satDocsState();
      current[rfc] = current[rfc] || {};
      current[rfc].progress = { kind, running: false, ok, step: finalText, at: now(), steps: steps.slice(-12) };
      saveSatDocsState(current);
    };
    if (ctx.attempt > 1) pushStep(time, 'Reintento automático (intento ' + ctx.attempt + ' de 2)…', '');
    pushStep(time, 'Conectando con el SAT…', '');
    const hooks = { step: (text, url) => pushStep(now(), text, url) };
    try {
      if (!satDocFetch) throw new Error('La descarga automática desde el portal del SAT no está disponible en esta instalación todavía: sube el PDF en esta pantalla y quedará archivado y vigilado igual.');
      const result = await satDocFetch({ rfc }, kind, hooks);
      const content = result?.content;
      if (!content || !(Buffer.isBuffer(content) ? content.length : String(content).length))
        throw new Error('El portal del SAT no devolvió el documento.');
      const issuedAt = result.issuedAt ? Date.parse(result.issuedAt) || time : time;
      /* Cancelar (pieza 9): si Paco canceló mientras el portal
         trabajaba, lo traído se descarta — no se archiva, no se
         envía — y el último buen estado queda intacto. */
      if (ctx.token?.cancelled)
        throw Object.assign(new Error('Descarga cancelada por ti: lo parcial se descartó y tu último documento archivado sigue intacto.'), { code: 'cancelada' });
      pushStep(now(), 'Guardando en Expedientes…', '');
      archiveSatDoc(rfc, kind, content, issuedAt, 'auto', time, result.fileName);
      const doneState = satDocsState();
      doneState[rfc] = doneState[rfc] || {};
      doneState[rfc][kind + 'Month'] = new Date(time).toISOString().slice(0, 7);
      saveSatDocsState(doneState);
      finishProgress(true, 'Guardado en Expedientes');
      saveSatDocRun(rfc, kind, time, now(), true, '', steps, null, '', ctx.origen || '');
      /* Envío automático a los destinatarios configurados. */
      const config = satDocsConfig()[rfc] || {};
      const recipients = String(config.recipients || '').split(/[,;]/).map(item => item.trim()).filter(Boolean);
      if (mail && (recipients.length || mail.recipient)) {
        try {
          await mail.transport.sendMail({ from: displayFrom(mail.from), to: recipients.length ? recipients.join(', ') : mail.recipient,
            subject: 'PacoSAT · ' + DOC_KIND_LABEL[kind] + ' de ' + rfc + ' (' + day(issuedAt) + ')',
            text: 'Se descargó y archivó en Expedientes el documento «' + DOC_KIND_LABEL[kind] + '» de ' + rfc +
              ', emitido el ' + day(issuedAt) + '. Va adjunto en PDF.',
            attachments: [{ filename: (DOC_KIND_LABEL[kind] + ' ' + rfc + '.pdf').replaceAll('/', '-'),
              content: Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'base64') }] });
          db.prepare('INSERT INTO mail_sends(at,recipients,subject,kind,ok,error,rfc) VALUES (?,?,?,?,1,\'\',?)')
            .run(time, recipients.length ? recipients.join(', ') : mail.recipient,
              DOC_KIND_LABEL[kind] + ' de ' + rfc, 'constancia', rfc);
        } catch (error) {
          queueAlert('satdoc-mail', 'satdoc-mail:' + rfc + ':' + kind + ':' + Math.floor(time / DAY),
            'PacoSAT · El documento se archivó pero el correo falló',
            '«' + DOC_KIND_LABEL[kind] + '» de ' + rfc + ' quedó en Expedientes, pero el envío por correo falló: ' + message(error), time, rfc);
        }
      }
      return { ok: true };
    } catch (error) {
      if (error?.code === 'cancelada' || ctx.token?.cancelled) {
        /* Cancelada: sin fila de error, sin alerta; el diario sí
           deja constancia de la cancelación. */
        finishProgress(false, 'Descarga cancelada por ti');
        saveSatDocRun(rfc, kind, time, now(), false, 'Descarga cancelada por ti.', steps, null, 'cancelada', ctx.origen || '');
        return { ok: false, cancelled: true, error: 'Descarga cancelada por ti.' };
      }
      db.prepare('INSERT INTO sat_documents(id,rfc,kind,issuedAt,fileId,source,created,error) VALUES (?,?,?,?,?,?,?,?)')
        .run(randomUUID(), rfc, kind, 0, '', 'auto', time, message(error));
      /* El aviso de fallo lo compone el envoltorio (runSatDocAttempt)
         desde el diagnóstico, tras agotar el reintento: aquí solo se
         avisa cuando nadie envuelve (ctx.deferAlert falso). */
      if (!ctx.deferAlert)
        queueAlert('satdoc-fail', 'satdoc:' + rfc + ':' + kind + ':' + Math.floor(time / DAY),
          'PacoSAT · No se pudo descargar ' + DOC_KIND_LABEL[kind] + ' de ' + rfc,
          satDocFailBody(rfc, kind, [{ error: message(error), at: time }]), time, rfc);
      finishProgress(false, message(error));
      saveSatDocRun(rfc, kind, time, now(), false, message(error), steps, error?.diag || null, error?.code || '', ctx.origen || '');
      return { ok: false, error: message(error), errorKind: error?.code || '' };
    }
  }
  /* Envoltorio de la corrida de documentos (1.22.0): guarda de
     concurrencia por RFC+tipo (R2), UN reintento automático tras
     espera configurable si la causa es del portal (pieza 10) y el
     aviso final único compuesto desde el diagnóstico (pieza 5). */
  async function runSatDocAttempt(rfc, kind, time, origen = 'sistema') {
    const key = rfc + ':' + kind;
    if (satDocLive.has(key)) return { ok: false, yaEnCurso: true,
      error: 'Ya hay una descarga de ' + DOC_KIND_LABEL[kind] + ' en curso para ' + rfc +
        ': mírala en su tarjeta — ahí está su progreso y su Cancelar.' };
    const token = { cancelled: false, startedAt: time };
    satDocLive.set(key, token);
    const failures = [];
    try {
      for (let attempt = 1; attempt <= 2; attempt++) {
        const result = await runSatDocAttemptOnce(rfc, kind, attempt === 1 ? time : now(),
          { attempt, token, deferAlert: true, origen });
        if (result.ok) {
          if (attempt === 2) {
            const current = satDocsState();
            if (current[rfc]?.progress) {
              current[rfc].progress = { ...current[rfc].progress, ok: true,
                step: 'Guardado en Expedientes · bajó al segundo intento' };
              saveSatDocsState(current);
            }
            return { ...result, segundoIntento: true };
          }
          return result;
        }
        if (result.cancelled) return result;
        failures.push({ error: result.error, errorKind: result.errorKind || '', at: now() });
        if (attempt === 1 && SATDOC_PORTAL_KINDS.includes(result.errorKind) && !token.cancelled) {
          const waitMs = satDocRetryWait();
          writeSatDocProgress(rfc, { kind, running: true,
            step: 'El portal no respondió como se esperaba: reintento automático en ' +
              Math.max(1, Math.round(waitMs / 1000)) + ' s (puedes cancelar la espera)…',
            at: now(), steps: [] });
          const waited = await sleepCancellable(waitMs, token);
          if (!waited || token.cancelled) {
            writeSatDocProgress(rfc, { kind, running: false, ok: false,
              step: 'Descarga cancelada por ti', at: now(), steps: [] });
            saveSatDocRun(rfc, kind, time, now(), false, 'Descarga cancelada por ti durante la espera del reintento.', [], null, 'cancelada', origen);
            return { ok: false, cancelled: true, error: 'Descarga cancelada por ti.' };
          }
          continue;
        }
        break;
      }
      queueAlert('satdoc-fail', 'satdoc:' + rfc + ':' + kind + ':' + Math.floor(time / DAY),
        'PacoSAT · No se pudo descargar ' + DOC_KIND_LABEL[kind] + ' de ' + rfc +
          (failures.length > 1 ? ' (dos intentos)' : ''),
        satDocFailBody(rfc, kind, failures), time, rfc);
      const lastFailure = failures[failures.length - 1];
      return { ok: false, error: lastFailure.error, errorKind: lastFailure.errorKind };
    } finally { satDocLive.delete(key); }
  }
  /* Cancelar una corrida de documentos (pieza 9): marca el token
     vivo; la corrida lo recoge tras el paso en curso o durante la
     espera del reintento. Sin corrida viva, no hay nada que parar. */
  function cancelSatDocRun(rfc, kind) {
    const keys = kind ? [rfc + ':' + kind] : [rfc + ':constancia', rfc + ':opinion'];
    let found = false;
    for (const key of keys) {
      const token = satDocLive.get(key);
      if (token) { token.cancelled = true; found = true; }
    }
    return found;
  }
  async function satDocsTick(time) {
    const config = satDocsConfig(), state = satDocsState();
    for (const profile of db.prepare('SELECT rfc FROM profiles').all()) {
      const item = config[profile.rfc];
      /* Alarma de antigüedad: roja y sin aviso esta semana → correo. */
      for (const kind of ['constancia', 'opinion']) {
        const latest = latestSatDoc(profile.rfc, kind);
        if (latest && docLevel(latest.issuedAt, time, kind) === 'bad')
          queueAlert('satdoc-old', 'satdoc-old:' + profile.rfc + ':' + kind + ':' + Math.floor(time / (7 * DAY)),
            'PacoSAT · ' + DOC_KIND_LABEL[kind] + ' de ' + profile.rfc + ' ya no se considera reciente',
            'La última emisión archivada es del ' + day(latest.issuedAt) + '. Ojo: no es que el documento haya caducado — la constancia no caduca —; es la política de recencia de PacoSAT (verde menos de 60 días, ámbar hasta 90, rojo después) para que ningún cliente te pida uno más fresco. Renueva el documento: si la descarga automática está activa, PacoSAT lo intenta solo; si no, súbelo en el Centro SAT.', time);
      }
      if (!item?.enabled) continue;
      const date = new Date(time);
      const due = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), Math.min(28, Math.max(1, item.day || 5)), item.hour ?? 9);
      const monthKey = date.toISOString().slice(0, 7);
      for (const kind of ['constancia', 'opinion']) {
        const done = state[profile.rfc]?.[kind + 'Month'] === monthKey;
        const attempted = state[profile.rfc]?.[kind + 'Attempt'] || 0;
        if (!done && time >= due && time - attempted >= DAY) await runSatDocAttempt(profile.rfc, kind, time);
      }
    }
  }
  function satDocsOverview(time) {
    const config = satDocsConfig(), state = satDocsState();
    return db.prepare('SELECT rfc FROM profiles ORDER BY rfc').all().map(profile => {
      const view = { rfc: profile.rfc, config: config[profile.rfc] ||
        { enabled: false, day: 5, hour: 9, recipients: '' }, lastError: '' };
      for (const kind of ['constancia', 'opinion']) {
        const latest = latestSatDoc(profile.rfc, kind);
        /* Pieza 4 (1.22.0): la tarjeta solo anuncia una descarga
           si el ARCHIVO existe en Expedientes — un registro con
           fileId cuyo fichero ya no está no anuncia nada, para
           que su «Ver» nunca prometa un papel que no se abre. */
        const fileOk = latest ? Boolean(readFileRecord(latest.fileId)?.buffer) : false;
        view[kind] = latest && fileOk ? { issuedAt: latest.issuedAt, ageDays: Math.floor((time - latest.issuedAt) / DAY),
          level: docLevel(latest.issuedAt, time, kind), source: latest.source, fileId: latest.fileId } : null;
        const failure = db.prepare("SELECT error,created FROM sat_documents WHERE rfc=? AND kind=? AND error<>'' ORDER BY created DESC LIMIT 1")
          .get(profile.rfc, kind);
        if (failure && (!latest || failure.created >= latest.created)) view.lastError = failure.error;
      }
      view.lastAttempt = Math.max(state[profile.rfc]?.constanciaAttempt || 0, state[profile.rfc]?.opinionAttempt || 0);
      /* El último fallo de corrida, con su clase de motor (1.13.0):
         la tarjeta cuenta el problema con el modelo único —semáforo,
         de quién es, qué hacer— en vez del mensaje crudo, que queda
         como detalle técnico. lastError (texto) se conserva para el
         semáforo de «fallo más reciente que el último éxito». */
      const lastFailure = db.prepare('SELECT error,errorKind,started FROM sat_doc_runs WHERE rfc=? AND ok=0 ORDER BY started DESC LIMIT 1').get(profile.rfc);
      view.lastFailure = lastFailure ? { error: lastFailure.error, kind: lastFailure.errorKind || '', at: lastFailure.started } : null;
      /* Progreso de la última corrida y su diario (1.10.1): la
         pantalla los enseña en vivo y al volver tras refrescar. */
      view.progress = state[profile.rfc]?.progress || null;
      view.runs = satDocRuns(profile.rfc);
      /* M4 (1.22.0): puesta en marcha del contribuyente. */
      view.arranque = puestaEnMarcha(profile.rfc);
      return view;
    });
  }
  /* La lista de puesta en marcha de un contribuyente (M4): cada
     paso se comprueba contra su registro real; la lista dice qué
     falta y dónde se hace, sin preguntar a nadie. El alta real
     (con la e.firma/CIEC del contribuyente) es gesto de Paco. */
  function puestaEnMarcha(rfc) {
    const index = readEfirmaIndex()[rfc] || {};
    const access = index.access || '';
    const hasDoc = kind => Boolean(db.prepare("SELECT 1 FROM sat_documents WHERE rfc=? AND kind=? AND fileId<>'' LIMIT 1").get(rfc, kind));
    const steps = [
      { id: 'perfil', label: 'Perfil de descarga creado', done: true, gesto: '' },
      { id: 'credencial', label: access === 'ciec' ? 'Contraseña CIEC guardada' : 'e.firma guardada',
        done: access === 'efirma' || access === 'ciec',
        gesto: 'Desbloquea el perfil con su e.firma (o guarda su CIEC) en el Centro SAT.' },
      { id: 'descarga', label: 'Primera descarga de CFDI hecha',
        done: Boolean(db.prepare("SELECT 1 FROM jobs WHERE rfc=? AND status='finished' LIMIT 1").get(rfc)) ||
          Boolean(db.prepare('SELECT 1 FROM packages WHERE rfc=? LIMIT 1').get(rfc)),
        gesto: 'Lanza la primera descarga desde Vigilancia o espera a la mensual automática.' },
      { id: 'constancia', label: 'Constancia de situación fiscal archivada', done: hasDoc('constancia'),
        gesto: 'Descárgala desde su tarjeta en Documentos o sube el PDF.' },
      { id: 'opinion', label: 'Opinión de cumplimiento archivada', done: hasDoc('opinion'),
        gesto: 'Descárgala desde su tarjeta en Documentos o sube el PDF.' },
      { id: 'declaraciones', label: 'Primera declaración recuperada',
        done: Boolean(db.prepare("SELECT 1 FROM declaraciones WHERE rfc=? AND fileId<>'' LIMIT 1").get(rfc)),
        gesto: 'Recupera las declaraciones del año desde su panel.' },
      { id: 'banco', label: 'Cuenta bancaria asignada a este RFC',
        done: Boolean(db.prepare('SELECT 1 FROM bank_accounts WHERE rfc=? LIMIT 1').get(rfc)),
        gesto: 'Al dar de alta la cuenta en Bancos, elige este RFC como dueño.' }];
    return { total: steps.length, hechas: steps.filter(step => step.done).length, steps };
  }

  /* ===== Descarga de CFDI por CIEC (1.12.0) =====
     La vía del portal web para los RFC sin e.firma. Como el
     descargador de documentos: progreso paso a paso persistido
     en el servidor (sobrevive a recargar la página) y diario por
     corrida con la foto del fallo. Y una pieza propia: la PAUSA
     del captcha. Cuando el portal lo enseña, la corrida se queda
     esperando aquí dentro —la imagen viaja en el estado, para
     que la pantalla la pinte aunque se recargue— hasta que Paco
     escribe el texto en la pantalla (POST /api/ciec/captcha lo
     despierta) o pasan 10 minutos y la corrida se cierra limpia
     con su motivo en el diario. La contraseña CIEC no pasa por
     este bloque: vive en la custodia protegida y la resuelve el
     propio puerto de descarga en el momento de la corrida. */
  const CIEC_CAPTCHA_WAIT_MS = 10 * 60 * 1000;
  const ciecState = () => { try { return JSON.parse(db.prepare("SELECT value FROM settings WHERE key='ciec-state'").get()?.value || '{}'); } catch { return {}; } };
  const saveCiecState = state => db.prepare("INSERT INTO settings(key,value) VALUES ('ciec-state',?) " +
    "ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(state));
  const ciecCaptchaWaiters = new Map();
  function saveCiecRun(rfc, started, finished, ok, errorText, steps, diag, counts = {}, errorKind = '', origen = '') {
    const id = randomUUID();
    /* Guardado verificado de la página del fallo (1.28.0), como en
       los demás diarios: ids solo si el artefacto se releyó bien. */
    const guardado = ok ? { shotId: '', htmlId: '', faltas: [] } : saveRunDiag(id, diag);
    const pasos = ok ? (steps || []) : [...(steps || []), ...diagCierreSteps(diag, guardado)];
    db.prepare('INSERT INTO ciec_runs(id,rfc,started,finished,ok,error,errorKind,steps,shotId,htmlId,found,downloaded,added,duplicates,origen) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, rfc, started, finished, ok ? 1 : 0, errorText || '', errorKind || '', JSON.stringify(pasos), guardado.shotId, guardado.htmlId,
        counts.found || 0, counts.downloaded || 0, counts.added || 0, counts.duplicates || 0, origen || '');
    pruneRunDiary('ciec_runs', rfc, finished || now());
    return id;
  }
  function ciecRuns(rfc, limit = 8) {
    return db.prepare('SELECT id,started,finished,ok,error,errorKind,steps,shotId,htmlId,found,downloaded,added,duplicates,origen FROM ciec_runs WHERE rfc=? ORDER BY started DESC LIMIT ?')
      .all(rfc, limit).map(row => ({ id: row.id, started: row.started, finished: row.finished,
        ok: Boolean(row.ok), error: row.error, errorKind: row.errorKind || '', steps: JSON.parse(row.steps || '[]'),
        hasShot: Boolean(row.shotId), hasHtml: Boolean(row.htmlId),
        found: row.found, downloaded: row.downloaded, added: row.added, duplicates: row.duplicates, origen: row.origen || '' }));
  }
  function ciecOverview() {
    const state = ciecState();
    const index = readEfirmaIndex();
    return db.prepare('SELECT rfc FROM profiles ORDER BY rfc').all()
      .filter(profile => index[profile.rfc]?.access === 'ciec')
      .map(profile => {
        const item = state[profile.rfc] || {};
        return { rfc: profile.rfc, ciecStored: Boolean(index[profile.rfc]?.ciec),
          progress: item.progress || null,
          /* La imagen del captcha SOLO vive en el estado mientras
             la corrida espera: se borra al responder o al vencer
             la espera, y no entra en ningún diario. */
          captcha: item.captcha ? { waiting: true, image: item.captcha.image,
            attempt: item.captcha.attempt, max: item.captcha.max, since: item.captcha.since } : null,
          runs: ciecRuns(profile.rfc) };
      });
  }
  async function runCiecAttempt(rfc, query, time, origen = 'paco') {
    const steps = [];
    const pushStep = (at, text, url) => {
      const entry = { at, text: String(text || ''), url: String(url || '') };
      steps.push(entry);
      const current = ciecState();
      current[rfc] = current[rfc] || {};
      current[rfc].progress = { running: true, step: entry.text, at: entry.at, steps: steps.slice(-12) };
      saveCiecState(current);
    };
    const finishProgress = (ok, finalText) => {
      const current = ciecState();
      current[rfc] = current[rfc] || {};
      current[rfc].progress = { running: false, ok, step: finalText, at: now(), steps: steps.slice(-12) };
      current[rfc].captcha = null;
      saveCiecState(current);
    };
    /* La pausa del captcha: publica la imagen en el estado (la
       pantalla la pinta y sobrevive a la recarga) y espera la
       respuesta de Paco o el vencimiento de los 10 minutos. */
    const askCaptcha = (image, attempt, max) => new Promise(resolve => {
      const settle = value => {
        clearTimeout(timer);
        if (ciecCaptchaWaiters.get(rfc)?.resolve === settle) ciecCaptchaWaiters.delete(rfc);
        const current = ciecState();
        if (current[rfc]) { current[rfc].captcha = null; saveCiecState(current); }
        resolve(value);
      };
      const timer = setTimeout(() => settle(null), CIEC_CAPTCHA_WAIT_MS);
      ciecCaptchaWaiters.set(rfc, { resolve: settle });
      const current = ciecState();
      current[rfc] = current[rfc] || {};
      current[rfc].captcha = { image, attempt, max, since: now() };
      saveCiecState(current);
    });
    pushStep(time, 'Conectando con el portal del SAT…', '');
    const hooks = { step: (text, url) => pushStep(now(), text, url), askCaptcha };
    try {
      if (!satCiecFetch) throw new Error('La descarga por CIEC no está activa en esta instalación.');
      const result = await satCiecFetch({ rfc }, query, hooks);
      pushStep(now(), 'Guardando en tu expediente…', '');
      const ingested = await ingestXmlBuffers((result.files || []).map(file => file.buffer), now());
      const summary = 'Descarga terminada: ' + ingested.added + ' facturas nuevas en tu expediente' +
        (ingested.duplicates ? ' · ' + ingested.duplicates + ' ya estaban' : '') +
        (ingested.review ? ' · ' + ingested.review + ' por revisar' : '') +
        (result.complete ? '' : ' · El portal no entregó todo el rango: mira el diario de la corrida.');
      finishProgress(true, summary);
      saveCiecRun(rfc, time, now(), true, '', steps, null,
        { found: result.found, downloaded: result.downloaded, added: ingested.added, duplicates: ingested.duplicates }, '', origen);
      /* Si la corrida cubrió un mes exacto que la descarga
         automática mensual dejó «esperando tu gesto», su cuenta se
         pliega en la de la corrida mensual (1.15.0). */
      if (result.complete) monthlyCiecFold(rfc, query,
        { found: result.found, added: ingested.added, duplicates: ingested.duplicates }, now());
      /* La corrida CIEC es UNA operación (1.22.0): su aviso de
         novedades lleva el detalle de lo que entró con ella. */
      if (ingested.addedRows?.length) queueNews({ kind: 'ciec', opkey: 'ciec:' + rfc + ':' + time,
        rfc, direction: 'mixed', label: 'descarga por CIEC' }, ingested.addedRows.map(row => newsItemOf(row)), now());
      return { ok: true };
    } catch (error) {
      queueAlert('ciec-fail', 'ciec:' + rfc + ':' + Math.floor(time / DAY),
        'PacoSAT · La descarga por CIEC de ' + rfc + ' no terminó',
        'La descarga de facturas por el portal (CIEC) de ' + rfc + ' terminó con error: ' + message(error) +
        ' El diario de la corrida, en la pantalla del SAT, guarda los pasos y la foto del momento del fallo.', time, rfc);
      finishProgress(false, message(error));
      saveCiecRun(rfc, time, now(), false, message(error), steps, error?.diag || null, {}, error?.code || '', origen);
      return { ok: false, error: message(error) };
    }
  }

  /* ===== Descarga automática mensual (1.15.0, propuesta P11) =====
     El día fijado (5 por defecto, configurable) PacoSAT baja SOLO
     el mes anterior completo de cada RFC, sin que nadie lo pida:
     pide únicamente los tramos del mes que ninguna solicitud
     TERMINADA cubre todavía (la cobertura del libro, la misma que
     pinta la pantalla de Cobertura), por el motor de siempre —
     sendSatRequest con su blindaje 5002: jamás un criterio
     repetido; y los CFDI entran por UUID con INSERT OR IGNORE:
     jamás un duplicado en el expediente —, más la solicitud
     Metadata del mes para la reconciliación. Al cerrar, la cuenta
     (encontradas / nuevas / ya estaban / huecos) queda en la
     bitácora, en «Hoy» y en el resumen de sucesos por correo; si
     algo no queda completo, además entra en el Centro de Avisos.
     El descanso general la frena entera (este tick solo corre
     dentro del bloque que el descanso ya detiene) y el descanso
     por RFC deja ese RFC anotado y lo retoma al despertar, dentro
     de la misma corrida. La vía CIEC NO entra en la programación
     automática — su captcha es el gesto de Paco, la misma
     doctrina del arranque («el perfil CIEC nunca entra en la
     programación automática») y su cupo del portal (~2.000
     CFDI/día/RFC) lo guarda el propio motor CIEC —: la corrida
     deja el mes «esperando tu gesto» y la descarga CIEC de ese
     mes exacto, cuando Paco la lanza, se pliega en la cuenta.
     Los huecos de meses viejos NO se mezclan con la corrida: se
     ofrecen como recuperación aparte (POST /api/monthly/recover),
     un mes y un sentido cada vez, con origen «recovery». */
  const MONTHLY_DEFAULT = { enabled: true, day: 5, hour: 9 };
  const MONTHLY_MAX_AGE = 10 * DAY;
  /* R4 (1.22.0): plazo de la solicitud zombi «pending» en el SAT. */
  const MONTHLY_ZOMBIE_AGE = 72 * 3600000;
  const MONTH_LABELS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  const monthLabel = key => MONTH_LABELS[Number(key.slice(5, 7)) - 1] + ' de ' + key.slice(0, 4);
  const monthWindow = key => ({ start: key + '-01 00:00:00',
    end: key + '-' + String(new Date(Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5, 7)), 0)).getUTCDate()).padStart(2, '0') + ' 23:59:59' });
  const prevMonthKey = time => { const [y, m] = mxParts(time).monthKey.split('-').map(Number);
    return m === 1 ? (y - 1) + '-12' : y + '-' + String(m - 1).padStart(2, '0'); };
  function monthlyConfig() {
    let parsed = {};
    try { parsed = JSON.parse(getSetting('monthly-download') || '{}'); } catch { parsed = {}; }
    return { enabled: parsed.enabled !== false,
      day: Number.isInteger(parsed.day) && parsed.day >= 1 && parsed.day <= 28 ? parsed.day : MONTHLY_DEFAULT.day,
      hour: Number.isInteger(parsed.hour) && parsed.hour >= 0 && parsed.hour <= 23 ? parsed.hour : MONTHLY_DEFAULT.hour };
  }
  const monthlyState = () => { try { return JSON.parse(getState('monthly-download-state') || '{}'); } catch { return {}; } };
  const saveMonthlyState = state => setState('monthly-download-state', JSON.stringify(state));
  const monthlyDirections = profile => profile.direction === 'both' ? ['received', 'issued'] : [profile.direction];
  /* Tramos del mes que ninguna solicitud terminada cubre, por RFC
     y sentido, desde la cobertura del libro. Las costuras de ≤2 s
     cuentan como cubiertas: son el micro-hueco del blindaje. */
  function monthUncovered(rfc, direction, monthKey, coverage) {
    const { start, end } = monthWindow(monthKey);
    const group = (coverage || computeCoverage()).groups.find(item => item.rfc === rfc && item.direction === direction);
    const ranges = (group?.covered || []).slice().sort((a, b) => a[0].localeCompare(b[0]));
    const span = (from, to) => stampSeconds(to) - stampSeconds(from) + 1;
    const gaps = [];
    let cursor = start;
    for (const [rangeStart, rangeEnd] of ranges) {
      if (rangeEnd < start || rangeStart > end) continue;
      const clipStart = rangeStart < start ? start : rangeStart;
      const clipEnd = rangeEnd > end ? end : rangeEnd;
      if (clipStart > cursor) {
        const gapEnd = stampText(stampSeconds(clipStart) - 1);
        if (span(cursor, gapEnd) > 2) gaps.push([cursor, gapEnd]);
      }
      if (clipEnd >= cursor) cursor = stampText(stampSeconds(clipEnd) + 1);
      if (cursor > end) break;
    }
    if (cursor <= end && span(cursor, end) > 2) gaps.push([cursor, end]);
    return gaps;
  }
  /* Envía las solicitudes CFDI de unos tramos por el MISMO camino
     que la programación (sendSatRequest + freeCriteria) y deja los
     jobs en la cola de siempre: el ciclo los verifica, los paquetes
     entran por inspectPackage y la Vigilancia los toma como
     cualquier descarga. Un job pendiente del mismo tramo exacto se
     ADOPTA (se sigue su curso), no se duplica. */
  async function sendMonthRequests(profile, connector, direction, ranges, origin, time) {
    const jobIds = [];
    let firstError = '';
    for (const [startAt, endAt] of ranges) {
      try {
        const pending = db.prepare("SELECT id FROM jobs WHERE rfc=? AND direction=? AND kind='cfdi' AND status='pending' AND startAt=? AND endAt=?")
          .get(profile.rfc, direction, startAt, endAt);
        if (pending) { jobIds.push(pending.id); continue; }
        const criteria = { rfc: profile.rfc, direction, type: 'cfdi', emitter: '', receiver: '', startAt, endAt };
        const free = freeCriteria(criteria);
        need(free, 'No se encontró un criterio libre para pedir ese tramo del mes.');
        const requestId = await sendSatRequest(
          () => connector.request({ start: free.criteria.startAt.slice(0, 10), end: free.criteria.endAt.slice(0, 10),
            startTime: free.criteria.startAt.slice(11), endTime: free.criteria.endAt.slice(11), direction }),
          free.criteria, origin, time);
        const inserted = db.prepare('INSERT INTO jobs(rfc,direction,periodStart,periodEnd,startAt,endAt,requestId,status,due,created) VALUES (?,?,?,?,?,?,?,?,?,?)')
          .run(profile.rfc, direction, free.criteria.startAt.slice(0, 10), free.criteria.endAt.slice(0, 10),
            free.criteria.startAt, free.criteria.endAt, requestId, 'pending', time + 5 * MIN, time);
        jobIds.push(Number(inserted.lastInsertRowid));
      } catch (error) { if (!firstError) firstError = message(error); }
    }
    return { jobIds, error: firstError };
  }
  /* La solicitud Metadata del mes completo (reconciliación de
     estados sin gastar descargas): una por sentido, sin forzar
     jamás un criterio gastado — si no hay variante libre, se
     omite en silencio, como la Metadata diaria. */
  async function sendMonthMetadata(profile, connector, direction, monthKey, time) {
    const { start, end } = monthWindow(monthKey);
    try {
      /* Solo la omite una Metadata pendiente que ya cubra el mes
         desde su inicio; la diaria de la ventana reciente no la
         sustituye (empieza dentro del mes o después). */
      if (db.prepare("SELECT 1 FROM jobs WHERE rfc=? AND direction=? AND kind='metadata' AND status='pending' AND startAt<=?")
        .get(profile.rfc, direction, start)) return 0;
      const criteria = { rfc: profile.rfc, direction, type: 'metadata', emitter: '', receiver: '', startAt: start, endAt: end };
      const free = freeCriteria(criteria);
      if (!free) return 0;
      const requestId = await sendSatRequest(
        () => connector.request({ start: free.criteria.startAt.slice(0, 10), end: free.criteria.endAt.slice(0, 10),
          startTime: free.criteria.startAt.slice(11), endTime: free.criteria.endAt.slice(11), direction, type: 'metadata' }),
        free.criteria, 'monthly', time);
      const inserted = db.prepare('INSERT INTO jobs(rfc,direction,kind,periodStart,periodEnd,startAt,endAt,requestId,status,due,created) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .run(profile.rfc, direction, 'metadata', free.criteria.startAt.slice(0, 10), free.criteria.endAt.slice(0, 10),
          free.criteria.startAt, free.criteria.endAt, requestId, 'pending', time + 5 * MIN, time);
      return Number(inserted.lastInsertRowid);
    } catch { return 0; }
  }
  /* Arranca (o retoma) la parte de UN RFC dentro de la corrida del
     mes, según su vía y su estado en este instante. */
  async function monthlyStartProfile(run, profile, time, coverage) {
    const entry = run.perRfc[profile.rfc] || (run.perRfc[profile.rfc] = { method: 'efirma', status: 'pendiente',
      jobs: [], metaJobs: [], found: 0, added: 0, duplicates: 0, gaps: 0, gapSeconds: 0, error: '' });
    entry.method = readEfirmaIndex()[profile.rfc]?.access === 'ciec' ? 'ciec' : 'efirma';
    if (entry.method === 'ciec') { entry.status = 'esperando-gesto'; return; }
    if (profilePaused(profile, time)) { entry.status = 'pausado'; return; }
    const active = unlocked.get(profile.rfc);
    if (!active) { entry.status = 'sin-credencial'; return; }
    entry.status = 'en-curso';
    entry.error = '';
    /* Foto previa para la cuenta: cuántos CFDI del mes YA tenía el
       expediente al empezar la parte de este RFC. Se toma una sola
       vez (las retomadas no la pisan). */
    if (entry.before === undefined) entry.before = monthlyRecordsCount(profile, run.month);
    for (const direction of monthlyDirections(profile)) {
      const ranges = monthUncovered(profile.rfc, direction, run.month, coverage);
      if (ranges.length) {
        const sent = await sendMonthRequests(profile, active.connector, direction, ranges, 'monthly', time);
        entry.jobs.push(...sent.jobIds);
        if (sent.error && !entry.error) entry.error = sent.error;
      }
      const metaId = await sendMonthMetadata(profile, active.connector, direction, run.month, time);
      if (metaId) entry.metaJobs.push(metaId);
    }
    if (!entry.jobs.length && entry.error) entry.status = 'fallida';
  }
  /* CFDI del mes que el expediente TIENE para un RFC en los
     sentidos de su perfil, contados desde los registros reales
     (la doctrina de la cobertura 1.13.1: los registros mandan,
     no el libro de solicitudes). */
  function monthlyRecordsCount(profile, monthKey) {
    const directions = monthlyDirections(profile);
    let found = 0;
    for (const invoice of recordInvoices()) {
      if (!String(invoice.date || '').startsWith(monthKey)) continue;
      if (directions.includes('issued') && invoice.from?.rfc === profile.rfc) found++;
      else if (directions.includes('received') && invoice.to?.rfc === profile.rfc) found++;
    }
    return found;
  }
  /* La cuenta de un RFC al cerrar su parte, toda desde los
     registros: encontradas = los CFDI del mes que el expediente
     tiene al cerrar; nuevas = las que entraron desde la foto
     previa de ESTA corrida; ya estaban = las que la foto previa
     ya contaba. Huecos = sentidos del mes que aún quedan sin
     cubrir por solicitudes terminadas. */
  function monthlyEntryCounts(entry, profile, monthKey, coverage) {
    const directions = monthlyDirections(profile);
    const found = monthlyRecordsCount(profile, monthKey);
    const before = entry.before === undefined ? found : entry.before;
    let gaps = 0, gapSeconds = 0;
    for (const direction of directions) {
      const uncovered = monthUncovered(profile.rfc, direction, monthKey, coverage);
      if (uncovered.length) gaps++;
      gapSeconds += uncovered.reduce((sum, [from, to]) => sum + (stampSeconds(to) - stampSeconds(from) + 1), 0);
    }
    return { found, added: Math.max(0, found - before), duplicates: Math.min(before, found), gaps, gapSeconds };
  }
  /* N9 (1.22.0): los correos no vuelcan el error técnico crudo
     como explicación principal («sdk.DownloadType.received is
     not a function» fue la línea principal del resumen real del
     11 nov). Lo conocido se traduce a lenguaje llano y el texto
     técnico queda solo como detalle secundario. */
  function errorLlano(text) {
    const raw = String(text || '');
    if (!raw) return '';
    if (/is not a function|TypeError|ReferenceError|SyntaxError|Cannot read propert/i.test(raw))
      return 'un fallo interno de PacoSAT, ya corregido en la versión actual (detalle técnico: ' + raw + ')';
    if (/5002/.test(raw)) return 'el SAT ya había agotado las solicitudes de ese criterio exacto (error 5002): no es un fallo de tu e.firma';
    if (/ECONNREFUSED|ENOTFOUND|fetch failed|network|ETIMEDOUT|socket/i.test(raw))
      return 'no hubo conexión con el SAT en ese momento (detalle técnico: ' + raw + ')';
    return raw;
  }
  function monthlyEntryLine(rfc, entry) {
    const sentidos = entry.method === 'ciec' ? 'por CIEC' : 'con e.firma';
    if (entry.status === 'esperando-gesto')
      return rfc + ' (' + sentidos + '): esperando tu gesto — el portal pide tu captcha; el mes se baja desde su tarjeta en el Centro SAT.';
    if (entry.status === 'fallida')
      return rfc + ' (' + sentidos + '): no terminó' + (entry.error ? ' — ' + errorLlano(entry.error) : '') + '.';
    return rfc + ' (' + sentidos + '): ' + entry.found + ' CFDI · ' + entry.added + ' nuevos · ' + entry.duplicates +
      ' ya estaban · ' + (entry.gaps ? entry.gaps + ' sentido(s) con hueco' : 'sin huecos') + '.';
  }
  function monthlySummaryLine(run) {
    const t = run.totals || { found: 0, added: 0, duplicates: 0, gaps: 0 };
    return monthLabel(run.month) + ': ' + t.found + ' CFDI · ' + t.added + ' nuevos · ' + t.duplicates +
      ' ya estaban · ' + (t.gaps ? t.gaps + ' hueco(s)' : '0 huecos');
  }
  /* Reconciliación del cierre mensual (1.27.0, bloque C — la
     contradicción viva de octubre de 2026: el mes quedó marcado
     «hecho» con 0 CFDI mientras una alerta decía que la descarga
     no se había completado): un mes SOLO se cierra «hecho» si la
     cuenta cuadra contra lo que el SAT dice que existe —
       · si el expediente tiene CFDI del mes, la Metadata del SAT
         no puede conocer MÁS de los que el expediente guarda;
       · si el expediente tiene CERO, hace falta la prueba de la
         Metadata terminada de ese mes (que vio el mes entero y
         no encontró nada): sin esa prueba, cero no es «hecho»,
         es «no consta» — y no consta se declara, no se cierra
         en silencio. */
  function monthlyReconcile(entry, profile, monthKey) {
    const directions = monthlyDirections(profile);
    const placeholders = directions.map(() => '?').join(',');
    const metaCount = db.prepare('SELECT COUNT(*) AS n FROM metadata_records WHERE rfc=? AND direction IN (' +
      placeholders + ") AND substr(issuedAt,1,7)=?").get(profile.rfc, ...directions, monthKey).n;
    const found = entry.found || 0;
    const metaFinished = (entry.metaJobs || []).some(id =>
      db.prepare('SELECT status FROM jobs WHERE id=?').get(id)?.status === 'finished');
    if (found === 0 && !metaFinished)
      return { ok: false, metaCount,
        motivo: 'El mes cerró con 0 CFDI en el expediente y SIN la prueba de la Metadata del SAT que lo recorrió entero: no consta que el mes esté vacío.' };
    if (metaCount > found)
      return { ok: false, metaCount,
        motivo: 'La Metadata del SAT conoce ' + metaCount + ' CFDI de este mes para este RFC y el expediente solo guarda ' + found + ': falta bajar la diferencia.' };
    return { ok: true, metaCount };
  }
  /* Repaso de la corrida abierta: retoma los RFC que despertaron o
     se desbloquearon, cierra los que ya terminaron y, cuando no
     queda nada en curso, finaliza la corrida con su cuenta y sus
     avisos. Devuelve true si la corrida quedó finalizada. */
  async function monthlyReview(run, time) {
    /* Pausa con nombre propio (1.18.0): la corrida retenida no
       arranca perfiles ni se cierra por edad mientras Paco no la
       reanude; su estado queda tal cual, sin perder lo hecho. */
    if (run.held) return false;
    const coverage = computeCoverage();
    let blocked = false;
    for (const [rfc, entry] of Object.entries(run.perRfc)) {
      if (entry.status === 'esperando-gesto' || entry.status === 'hecha' ||
          entry.status === 'parcial' || entry.status === 'fallida') continue;
      const profile = db.prepare('SELECT * FROM profiles WHERE rfc=?').get(rfc);
      if (!profile) { entry.status = 'fallida'; entry.error = entry.error || 'El perfil ya no existe en PacoSAT.'; continue; }
      if (entry.status === 'pausado' || entry.status === 'sin-credencial' || entry.status === 'pendiente') {
        if (!profilePaused(profile, time) && unlocked.has(rfc)) await monthlyStartProfile(run, profile, time, coverage);
        else { blocked = true; continue; }
      }
      if (entry.status === 'en-curso') {
        const states = entry.jobs.map(id => db.prepare('SELECT status FROM jobs WHERE id=?').get(id)?.status || 'finished');
        if (states.some(state => state === 'pending')) {
          /* R4 (1.22.0): la solicitud ZOMBI — aceptada por el SAT y
             «pending» para siempre — secuestraba la corrida hasta
             el plazo de 10 días, y detrás esperaba la del mes
             siguiente. A las 72 h sin avance se declara muerta
             (agotada), se avisa, y el mes cierra como parcial
             recuperable en vez de quedar «en curso» diez días.
             El plazo de 10 días sigue gobernando los demás
             bloqueos (gestos pendientes, perfiles pausados). */
          const killedIds = new Set();
          entry.jobs.forEach((id, i) => {
            if (states[i] !== 'pending') return;
            const job = db.prepare('SELECT created FROM jobs WHERE id=?').get(id);
            if (job && time - job.created > MONTHLY_ZOMBIE_AGE) {
              db.prepare("UPDATE jobs SET status='exhausted', error=? WHERE id=?")
                .run('Solicitud sin avance en el SAT durante más de 72 horas: PacoSAT la declara muerta para no bloquear el calendario de descargas.', id);
              /* R3: la muerta también declara su tramo en el diario. */
              const full = db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
              if (full?.kind === 'cfdi') {
                const gaps = jobWindowGaps(full);
                db.prepare('UPDATE jobs SET note=? WHERE id=?').run(gaps.length ?
                  'Terminó sin completar (zombi de 72 h): falta ' + gaps.join('; ') + ' de la ventana pedida.' :
                  'Terminó sin completar (zombi de 72 h), pero su ventana ya la cubre otra solicitud terminada.', id);
              }
              states[i] = 'exhausted'; killedIds.add(id);
            }
          });
          if (killedIds.size) {
            entry.zombieKilled = true;
            queueAlert('monthly-zombie', 'monthly-zombie:' + run.month + ':' + rfc,
              'PacoSAT · Una solicitud del SAT quedó muerta y el mes se liberó',
              'La solicitud de ' + monthLabel(run.month) + ' para ' + rfc + ' llevaba más de 72 horas «en curso» en el SAT sin avanzar. ' +
              'PacoSAT la ha declarado muerta: el mes cierra como parcial y lo que falte se puede pedir desde Cobertura, en el Centro SAT. ' +
              'La corrida del mes siguiente ya no espera detrás de esta.', time);
          }
          if (states.some(state => state === 'pending')) { blocked = true; continue; }
        }
        /* Las solicitudes Metadata del mes también mandan en el
           cierre (1.27.0): una Metadata «pending» eterna ya no
           deja el mes colgado ni —peor— cerrado sin su prueba:
           espera como las de CFDI, muere como zombi a las 72 h
           y su estado terminado es la prueba que la
           reconciliación exige para un mes en cero. */
        const metaStates = (entry.metaJobs || []).map(id =>
          db.prepare('SELECT status FROM jobs WHERE id=?').get(id)?.status || 'finished');
        (entry.metaJobs || []).forEach((id, i) => {
          if (metaStates[i] !== 'pending') return;
          const job = db.prepare('SELECT created FROM jobs WHERE id=?').get(id);
          if (job && time - job.created > MONTHLY_ZOMBIE_AGE) {
            db.prepare("UPDATE jobs SET status='exhausted', error=? WHERE id=?")
              .run('Solicitud Metadata sin avance en el SAT durante más de 72 horas: PacoSAT la declara muerta para no bloquear el calendario de descargas.', id);
            metaStates[i] = 'exhausted';
          }
        });
        if (metaStates.some(state => state === 'pending')) { blocked = true; continue; }
        Object.assign(entry, monthlyEntryCounts(entry, profile, run.month, coverage));
        const hardFail = entry.jobs.some((id, i) => ['expired', 'failed', 'rejected'].includes(states[i]) ||
          (states[i] === 'exhausted' && !entry.zombieKilled));
        entry.status = hardFail ? 'fallida' : entry.gaps ? 'parcial' : 'hecha';
        /* Reconciliación antes de declarar el mes «hecho»
           (1.27.0): si la cuenta no cuadra contra lo que el SAT
           dice que existe, el mes baja a «parcial» con su motivo
           y su aviso — el fallo grita, nunca cierra en silencio. */
        if (entry.status === 'hecha') {
          const reconciliacion = monthlyReconcile(entry, profile, run.month);
          if (!reconciliacion.ok) {
            entry.status = 'parcial';
            entry.dudosa = reconciliacion.motivo;
            queueAlert('descarga-dudosa', 'descarga-dudosa:' + run.month + ':' + rfc,
              'PacoSAT · La descarga de ' + monthLabel(run.month) + ' de ' + rfc + ' no cuadra y no se da por hecha',
              reconciliacion.motivo + ' El mes queda «parcial»: lo que falte se puede pedir desde Cobertura, en el Centro SAT. ' +
              'PacoSAT no marca un mes como hecho sin la cuenta cuadrada.', time, rfc);
          }
        }
      }
      if (entry.status === 'en-curso' || entry.status === 'pausado' || entry.status === 'sin-credencial' || entry.status === 'pendiente') blocked = true;
    }
    if (blocked && time - run.startedAt <= MONTHLY_MAX_AGE) return false;
    if (blocked) {
      for (const entry of Object.values(run.perRfc))
        if (['en-curso', 'pausado', 'sin-credencial', 'pendiente'].includes(entry.status)) {
          entry.status = 'fallida';
          entry.error = entry.error || 'La corrida se cerró a los 10 días sin que este RFC terminara.';
        }
    }
    run.finishedAt = time;
    const entries = Object.values(run.perRfc);
    run.totals = entries.reduce((acc, entry) => ({ found: acc.found + (entry.found || 0), added: acc.added + (entry.added || 0),
      duplicates: acc.duplicates + (entry.duplicates || 0), gaps: acc.gaps + (entry.gaps || 0) }),
      { found: 0, added: 0, duplicates: 0, gaps: 0 });
    run.status = entries.length && entries.every(entry => entry.status === 'hecha') ? 'hecha' :
      entries.some(entry => entry.status === 'hecha' || entry.status === 'parcial' || entry.status === 'esperando-gesto') ? 'parcial' : 'fallida';
    const resumen = 'Descarga automática de ' + monthlySummaryLine(run);
    const body = Object.entries(run.perRfc).map(([rfc, entry]) => monthlyEntryLine(rfc, entry)).join('\n');
    putMetadata('activity', { id: 'monthly:' + run.month, name: 'Descarga automática mensual',
      date: new Date(time).toISOString(), added: run.totals.added, duplicates: run.totals.duplicates,
      review: entries.filter(entry => entry.status === 'fallida').length, issues: [],
      event: resumen + (body ? ' — ' + body.replace(/\n/g, ' · ') : '') });
    storageRevision++;
    const pending = (() => { try { return JSON.parse(getState('monthly-digest-pending') || '[]'); } catch { return []; } })();
    /* Los RFC de la corrida viajan como DATO en la nota (1.27.0,
       H-6.1): el resumen los agrupa por la columna, no por el
       primer RFC que aparezca en el texto. */
    pending.push({ subject: resumen, body, rfcs: Object.keys(run.perRfc || {}) });
    setState('monthly-digest-pending', JSON.stringify(pending.slice(-4)));
    if (run.status !== 'hecha')
      queueAlert('monthly-fail', 'monthly:' + run.month,
        'PacoSAT · La descarga automática de ' + monthLabel(run.month) + ' no quedó completa',
        resumen + '. ' + body + ' Lo que falta se puede pedir desde Cobertura, en el Centro SAT; el mes no se vuelve a bajar solo.', time);
    return true;
  }
  /* Reparación única de los meses ya cerrados (1.27.0): las
     corridas «hechas» con 0 CFDI y sin la prueba de la Metadata
     — el caso vivo de octubre de 2026 — bajan a «parcial» con su
     aviso, una sola vez, para que la foto guardada deje de
     afirmar lo que nunca se probó. No toca meses con CFDI ni
     meses cuya Metadata terminada sí prueba el cero. */
  function monthlyRepairDoubtful(time) {
    if (getState('monthly-repair-1270')) return;
    const state = monthlyState();
    let changed = false;
    for (const run of Object.values(state.runs || {})) {
      if (!run.finishedAt) continue;
      for (const [rfc, entry] of Object.entries(run.perRfc || {})) {
        /* La vía CIEC cierra con su propio diario (corrida con el
           gesto de Paco y su cuenta): la reconciliación guarda la
           vía automática de e.firma, que es donde vivía la
           contradicción de octubre. */
        if (entry.status !== 'hecha' || (entry.found || 0) > 0 || entry.method === 'ciec') continue;
        const profile = db.prepare('SELECT * FROM profiles WHERE rfc=?').get(rfc);
        if (!profile) continue;
        const reconciliacion = monthlyReconcile({ ...entry, found: 0 }, profile, run.month);
        if (reconciliacion.ok) continue;
        entry.status = 'parcial';
        entry.dudosa = 'Reparación 1.27.0: este mes constaba «hecho» con 0 CFDI y sin la prueba que hoy se exige. ' + reconciliacion.motivo;
        queueAlert('descarga-dudosa', 'descarga-dudosa:' + run.month + ':' + rfc,
          'PacoSAT · La descarga de ' + monthLabel(run.month) + ' de ' + rfc + ' no cuadra y no se da por hecha',
          'Al revisar los meses ya cerrados con la regla nueva (1.27.0), este mes no supera la reconciliación: ' +
          reconciliacion.motivo + ' Queda «parcial»: lo que falte se puede pedir desde Cobertura, en el Centro SAT.', time, rfc);
        changed = true;
      }
      if (changed) {
        const entries = Object.values(run.perRfc || {});
        run.status = entries.length && entries.every(entry => entry.status === 'hecha') ? 'hecha' :
          entries.some(entry => entry.status === 'hecha' || entry.status === 'parcial' || entry.status === 'esperando-gesto') ? 'parcial' : 'fallida';
      }
    }
    /* El orden de escritura es el arreglo de H-5.1 (pasada de
       seguridad de la 1.27.0): PRIMERO se persiste el estado
       reparado y SOLO DESPUÉS la marca de «reparación hecha».
       Antes la marca se guardaba al entrar y el estado al
       salir: un corte entre medias (un reinicio del contenedor
       en el primer tick tras desplegar) dejaba la marca puesta
       con las entradas aún «hechas» sin prueba — la reparación
       consumida y el heredado falso en pie para siempre. Con
       este orden, un corte deja como mucho la reparación por
       repetir, y repetirla no daña: solo degrada entradas que
       siguen «hecha», y lo ya degradado ya no lo es. */
    if (changed) saveMonthlyState(state);
    setState('monthly-repair-1270', String(time));
  }
  /* Crea la corrida de un mes y arranca la parte de cada RFC.
     Devuelve la corrida ya guardada en el estado. */
  async function monthlyCreateRun(monthKey, time, automatic) {
    const state = monthlyState();
    state.runs = state.runs || {};
    const run = { month: monthKey, startedAt: time, finishedAt: 0, status: 'en-curso', automatic: Boolean(automatic), perRfc: {}, totals: null };
    /* Si la sonda tiene un cambio de portal sin resolver, la
       corrida nace avisada y su ficha lo dice (mejora nº 8). */
    const cambiosPortal = ['constancia', 'opinion'].filter(which => getSetting('probe:cambio:' + which));
    if (cambiosPortal.length) run.avisoPortal = cambiosPortal.join(' y ');
    const coverage = computeCoverage();
    for (const profile of db.prepare('SELECT * FROM profiles').all())
      await monthlyStartProfile(run, profile, time, coverage);
    state.runs[monthKey] = run;
    const keys = Object.keys(state.runs).sort();
    for (const key of keys.slice(0, Math.max(0, keys.length - 12))) delete state.runs[key];
    saveMonthlyState(state);
    if (await monthlyReview(run, time)) saveMonthlyState(state);
    return run;
  }
  async function monthlyDownloadTick(time) {
    try {
      monthlyRepairDoubtful(time);
      const state = monthlyState();
      const open = Object.values(state.runs || {}).find(run => run.status === 'en-curso');
      if (open && await monthlyReview(open, time)) saveMonthlyState(state);
      const config = monthlyConfig();
      if (!config.enabled) return;
      const target = prevMonthKey(time);
      if (state.runs?.[target]) return;
      const mx = mxParts(time);
      if (!(mx.day >= config.day && mx.hour >= config.hour)) return;
      if (!db.prepare('SELECT 1 FROM profiles LIMIT 1').get()) return;
      /* Una sola corrida abierta a la vez: si otra sigue en curso,
         esta espera a que cierre (y el mes queda para el repaso). */
      if (Object.values(state.runs || {}).some(run => run.status === 'en-curso')) return;
      /* Salud predictiva (1.25.0, mejora nº 8): la sonda del
         portal corre FRESCA justo antes de crear la corrida — si
         la pantalla cambió, su aviso ya existe cuando la primera
         descarga arranca, no después del primer estrellón. */
      await portalProbeRun(time).catch(() => { /* la corrida no muere por la sonda */ });
      await monthlyCreateRun(target, time, true);
    } catch { /* la descarga mensual nunca tumba el ciclo principal */ }
  }
  /* Pliegue CIEC: la descarga por el portal que termina completa
     y CUBRE un mes entero (el mes exacto o un rango más amplio)
     cuyo RFC estaba «esperando tu gesto» en la corrida de ese mes
     absorbe su cuenta en la corrida: la corrida en espera se
     reanuda sola al darse el gesto, sin perder su sitio en la
     cola mensual (1.15.0; rango amplio, 1.25.0 mejora nº 4). Con
     el mes exacto la cuenta es la de la propia descarga; con un
     rango amplio, la cuenta sale de los registros del mes — la
     descarga pudo traer también otros meses y no se le atribuye
     a este lo que no es suyo. */
  function monthlyCiecFold(rfc, query, counts, time) {
    const start = String(query?.start || '').slice(0, 10), end = String(query?.end || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) return;
    const state = monthlyState();
    let monthKey = '', run = null, entry = null, exacta = false;
    for (const [key, candidate] of Object.entries(state.runs || {})) {
      const candidateEntry = candidate?.perRfc?.[rfc];
      if (!candidateEntry || candidateEntry.status !== 'esperando-gesto') continue;
      const monthStart = key + '-01';
      const monthEnd = monthWindow(key).end.slice(0, 10);
      if (start <= monthStart && end >= monthEnd) {
        monthKey = key; run = candidate; entry = candidateEntry;
        exacta = start === monthStart && end === monthEnd;
        break;
      }
    }
    if (!run || !entry) return;
    entry.status = 'hecha';
    if (exacta) {
      entry.found = counts.found || 0;
      entry.added = counts.added || 0;
      entry.duplicates = counts.duplicates || 0;
    } else {
      const profile = db.prepare('SELECT * FROM profiles WHERE rfc=?').get(rfc);
      entry.found = profile ? monthlyRecordsCount(profile, monthKey) : 0;
      entry.added = 0;
      entry.duplicates = entry.found;
      entry.rangoAmplio = true;
    }
    entry.gaps = 0; entry.gapSeconds = 0;
    if (run.totals) {
      run.totals.found += entry.found; run.totals.added += entry.added;
      run.totals.duplicates += entry.duplicates;
    }
    if (run.status !== 'en-curso' && Object.values(run.perRfc).every(item => item.status === 'hecha')) run.status = 'hecha';
    saveMonthlyState(state);
    putMetadata('activity', { id: 'monthly-ciec:' + monthKey + ':' + rfc, name: 'Descarga automática mensual · CIEC',
      date: new Date(time).toISOString(), added: entry.added, duplicates: entry.duplicates, review: 0, issues: [],
      event: 'La descarga por CIEC de ' + rfc + ' completó ' + monthLabel(monthKey) + ' dentro de la corrida automática: ' +
        entry.found + ' CFDI · ' + entry.added + ' nuevos · ' + entry.duplicates + ' ya estaban.' });
    storageRevision++;
  }
  /* Huecos históricos desde los registros (los de la tarjeta «Qué
     meses tienes»): meses sin ningún CFDI dentro del rango de
     actividad de cada RFC y sentido. Son la oferta de recuperación
     — aparte de la corrida mensual, nunca dentro de ella. */
  function monthlyHistoricalGaps(coverage) {
    const gaps = [];
    for (const group of (coverage || computeCoverage()).records)
      for (const month of group.huecos) gaps.push({ rfc: group.rfc, direction: group.direction, month });
    return gaps.sort((a, b) => (a.rfc + a.direction + a.month).localeCompare(b.rfc + b.direction + b.month));
  }
  function monthlyOverview() {
    const state = monthlyState();
    const runs = Object.values(state.runs || {}).sort((a, b) => b.month.localeCompare(a.month)).slice(0, 6);
    return { config: monthlyConfig(), currentMonth: mxParts(now()).monthKey, targetMonth: prevMonthKey(now()),
      runs, gaps: monthlyHistoricalGaps(), portal: portalSalud() };
  }

  /* Ciclo completo de un perfil (1.6.11): verificar lo pendiente,
     programar CFDI y metadatos y anotar el resultado. Lo usa el tick y
     también el botón «Descargar ahora» por RFC. */
  async function runProfileCycle(profile, time) {
    const active = unlocked.get(profile.rfc);
    if (!active || profilePaused(profile, time)) return;
    const outcome = await verifyJobs(profile, active, time);
    for (const job of outcome.terminal) {
      const isMeta = job.kind === 'metadata';
      queueAlert('job-terminal', 'job:' + job.id,
        isMeta ? 'PacoSAT · Una solicitud de metadatos al SAT quedó ' + (jobStateLabel[job.afterStatus] || job.afterStatus) :
          'PacoSAT · Una solicitud al SAT quedó ' + (jobStateLabel[job.afterStatus] || job.afterStatus),
        isMeta ?
          'La solicitud de metadatos del RFC ' + job.rfc + ' para el periodo ' + job.periodStart + ' a ' + job.periodEnd + ' quedó ' +
          (jobStateLabel[job.afterStatus] || job.afterStatus) + ' en el SAT. La reconciliación de ese periodo se reintentará en el siguiente ciclo diario de metadatos.' :
          'La solicitud del RFC ' + job.rfc + ' para el periodo ' + job.periodStart + ' a ' + job.periodEnd + ' quedó ' +
          (jobStateLabel[job.afterStatus] || job.afterStatus) + ' en el SAT y no entregará paquetes. Crea una solicitud nueva para un periodo ' +
          'distinto desde el Centro SAT; no reintentes la misma, porque el SAT limita las solicitudes por periodo.', time);
    }
    const scheduleAttempted = profile.nextRun <= time;
    if (scheduleAttempted) await schedule(profile, active.connector, time);
    if (scheduleAttempted) await scheduleMetadata(profile, active.connector, time);
    const profileError = scheduleAttempted ? (db.prepare('SELECT error FROM profiles WHERE rfc=?').get(profile.rfc)?.error || '') : '';
    noteDownloadOutcome(profile.rfc, scheduleAttempted || outcome.attempted > 0,
      Boolean(profileError) || outcome.stuck > 0, time);
  }
  let tickStartedAt = 0;
  async function tick() {
    if (busy) {
      /* Vigilante del ciclo (1.6.15, mejora nº 2): un tick que lleva
         más de 10 minutos en curso no puede pasar en silencio — con el
         timeout de 60 s por llamada no debería ocurrir, y si ocurre
         hay que saberlo el mismo día. */
      if (tickStartedAt && now() - tickStartedAt > 10 * MIN)
        queueAlert('tick-stuck', 'tick-stuck:' + day(now()),
          'PacoSAT · El ciclo automático lleva más de 10 minutos en curso',
          'Un ciclo de descarga y verificación sigue abierto desde hace más de 10 minutos. Las llamadas al SAT ' +
          'tienen un límite de 60 segundos, así que algo va mal (red del NAS o el propio SAT). Si el ciclo no ' +
          'termina solo, reinicia el contenedor de PacoSAT y revisa el Centro SAT.', now());
      return;
    }
    busy = true;
    tickStartedAt = now();
    try {
      const time = now();
      /* Modo descanso general (1.6.10): con el descanso activo no se
         envía NADA al SAT ni se genera ningún aviso; la carpeta vigilada
         y el respaldo (operaciones locales) siguen su curso. Al vencer
         la fecha, todo se reanuda solo. */
      const isResting = resting(time);
      if (!isResting && getState('rest:since')) {
        /* El descanso venció solo: se reanuda con ventana pendiente. */
        const since = Number(getState('rest:since'));
        setState('rest:since', '');
        setSetting('restUntil', '');
        for (const profile of db.prepare('SELECT rfc FROM profiles').all())
          if (!getState('catchup:' + profile.rfc)) setState('catchup:' + profile.rfc, String(since));
      }
      if (!isResting) {
        for (const profile of db.prepare('SELECT * FROM profiles').all())
          await runProfileCycle(profile, time);
        reconcileCoverageGaps(time);
        checkCertExpiries(time);
        checkSilence(time);
        await listsTick(time, listFetch || undefined);
        await satDocsTick(time);
        /* Buzón Tributario automático semanal (1.28.0, P3): el
           tick solo la invoca fuera de Descansar; la cadencia
           espera sola si el perfil descansa o no toca aún. */
        await tribAutoTick(time);
        await declAutoTick(time);
        await monthlyDownloadTick(time);
        await reportsTick(time);
        moneyTick(time);
        fiscalTick(time);
        watchStaleTick(time);
        await portalProbeTick(time);
        paperlessProcess().catch(() => { /* la cola se reintenta en el siguiente ciclo */ });
      }
      await scanWatchFolder(time);
      await runScheduledBackup(time);
      /* Respaldo retrasado (1.23.0, frente C): si el respaldo está
         activado y el último correcto lleva más de 48 h, queda un
         aviso —uno por día, por su ref— con la fecha de ese último
         correcto. Sin respaldo activado o sin ningún correcto
         previo, no se avisa nada nuevo. */
      if (backupJob) {
        const lastOkBackup = Number(getState('backup:last') || 0);
        if (lastOkBackup > 0 && time - lastOkBackup > 48 * 3600 * 1000)
          queueAlert('backup-stale', 'backup-stale:' + day(time),
            'PacoSAT · El respaldo lleva más de 48 h sin completarse',
            'El último respaldo correcto fue el ' + day(lastOkBackup) +
            ' y ya han pasado más de 48 horas sin que se complete otro. ' +
            'Revisa la carpeta de respaldos, el espacio disponible y la configuración del respaldo programado.', time);
      }
      if (!isResting) {
        checkExternalCopyAge(time);
        await notify(time);
        await sendAlerts(time);
        await sendEventAlerts(time);
        await sendEventDigest(time);
      }
    } finally { busy = false; tickStartedAt = 0; }
  }

  async function handle(req, res) {
    /* gzip extremo a extremo (1.27.0, bloque A): si el cliente lo
       acepta, la respuesta se comprime en el propio servidor —
       hasta hoy la compresión dependía de que el proxy la hiciera
       y la página servida viajaba entera. El envoltorio retiene
       la cabecera hasta el cuerpo final: solo se comprime lo
       compresible (texto, JSON, JS, SVG) de 1 KB o más, sin
       tocar lo ya codificado ni los binarios (PDF/ZIP viajan
       tal cual). Sin Accept-Encoding: gzip, la respuesta es la
       de siempre, byte a byte. */
    if (/\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))) {
      const originalEnd = res.end.bind(res);
      const originalWriteHead = res.writeHead.bind(res);
      let headArgs = null;
      res.writeHead = (status, headers) => { headArgs = [status, headers]; return res; };
      res.end = (chunk, ...rest) => {
        const bodyBuf = chunk === undefined || chunk === null ? Buffer.alloc(0)
          : Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
        const headers = { ...(headArgs?.[1] || {}) };
        const type = String(headers['Content-Type'] || headers['content-type'] ||
          (typeof res.getHeader === 'function' ? res.getHeader('Content-Type') : '') || '');
        const already = headers['Content-Encoding'] || headers['content-encoding'] ||
          (typeof res.getHeader === 'function' ? res.getHeader('Content-Encoding') : '');
        if (!already && bodyBuf.length >= 1024 &&
            /^(text\/|application\/(json|manifest\+json|javascript)|image\/svg\+xml)/.test(type)) {
          const zipped = gzipSync(bodyBuf);
          headers['Content-Encoding'] = 'gzip';
          headers['Vary'] = 'Accept-Encoding';
          if (headers['Content-Length'] !== undefined) headers['Content-Length'] = zipped.length;
          if (headers['content-length'] !== undefined) headers['content-length'] = zipped.length;
          originalWriteHead(headArgs ? headArgs[0] : 200, headers);
          return originalEnd(zipped, ...rest);
        }
        if (headArgs) originalWriteHead(headArgs[0], headArgs[1]);
        return originalEnd(chunk, ...rest);
      };
    }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', cspHeader);
    try {
      need(req.headers.host === host, 'Host inválido.', 403);
      if (cloud) need(req.headers['x-pacosat-proxy'] === proxyKey, 'Acceso reservado al proxy HTTPS.', 403);
      need(!req.headers['sec-fetch-site'] || ['same-origin','none'].includes(req.headers['sec-fetch-site']), 'Origen inválido.', 403);
      const url = new URL(req.url, origin);
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(html.replace('<!--PACOSAT_TOKEN-->', '<meta name="pacosat-token" content="' + token + '">' +
          (cloud ? '<meta name="pacosat-cloud" content="1">' : '')));
      }
      /* PWA (1.7.0): manifiesto, service worker e icono, públicos como
         la propia portada (sin datos dentro). */
      if (req.method === 'GET' && url.pathname === '/manifest.webmanifest') {
        res.writeHead(200, { 'Content-Type': 'application/manifest+json; charset=utf-8' });
        return res.end(JSON.stringify({ name: 'PacoSAT', short_name: 'PacoSAT', start_url: '/', scope: '/',
          display: 'standalone', background_color: '#0e2a47', theme_color: '#0e2a47',
          icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }] }));
      }
      if (req.method === 'GET' && url.pathname === '/icon.svg') {
        res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8' });
        return res.end('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="18" fill="#0e2a47"/><path d="M50 14 80 24v26c0 18-12 30-30 36C32 80 20 68 20 50V24Z" fill="#f4b942"/><text x="50" y="62" font-size="34" font-family="sans-serif" font-weight="bold" text-anchor="middle" fill="#0e2a47">P</text></svg>');
      }
      if (req.method === 'GET' && url.pathname === '/sw.js') {
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Service-Worker-Allowed': '/' });
        /* 1.9.0 (auditoría de seguridad): el SW YA NO cachea «/». La
           página lleva el token de administrador en una meta y la
           v1 lo persistía en Cache Storage — también en el navegador
           de una invitada, cuyo login registraba el mismo SW. Este
           SW solo purga las cachés viejas (incluida la v1 con token)
           y reclama los clientes; la app funciona sin copia offline
           de la cáscara (el paquete sin conexión va por su ruta). */
        /* 1.25.0 (AGREGAR 9): el SW aprende push — recibe el aviso
           crítico GENÉRICO (sin datos fiscales: el cuerpo que el
           servidor manda no los lleva) y lo enseña como
           notificación del sistema; tocarla abre la app. Sigue
           sin cachear la cáscara: la disciplina de la 1.9.0 manda. */
        return res.end("self.addEventListener('install',e=>{self.skipWaiting()});" +
          "self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.map(k=>caches.delete(k)))).then(()=>self.clients.claim()))});" +
          "self.addEventListener('fetch',e=>{});" +
          "self.addEventListener('push',e=>{let d={};try{d=e.data?e.data.json():{}}catch(_){}" +
          "e.waitUntil(self.registration.showNotification(d.title||'PacoSAT · Aviso crítico'," +
          "{body:d.body||'Hay un aviso que necesita tu revisión.',data:{url:d.url||'/'}}))});" +
          "self.addEventListener('notificationclick',e=>{e.notification.close();" +
          "e.waitUntil(clients.matchAll({type:'window',includeUncontrolled:true}).then(ws=>{" +
          "const w=ws.find(x=>x.url.includes(self.location.origin));" +
          "if(w)return w.focus();return clients.openWindow((e.notification.data&&e.notification.data.url)||'/')}))});");
      }
      /* Partes de carga diferida (1.24.0, punto 4b): código de la
         propia app, sin datos dentro — viajan tras la misma
         puerta del proxy que la portada y la CSP las autoriza
         por la huella que el build selló en lazy.json. */
      if (req.method === 'GET' && url.pathname.startsWith('/parte/')) {
        const part = lazyParts?.partes?.[url.pathname.slice('/parte/'.length)];
        if (!part) { res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' }); return res.end(JSON.stringify({ error: 'Parte no encontrada.' })); }
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
        return res.end(part.source);
      }
      /* Entrada del invitado (1.7.0): la misma app con una meta que la
         pone en modo invitado; el token llega tras el login. */
      if (req.method === 'GET' && url.pathname === '/invitado') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(html.replace('<!--PACOSAT_TOKEN-->', '<meta name="pacosat-guest" content="1">' +
          (cloud ? '<meta name="pacosat-cloud" content="1">' : '')));
      }
      /* Login propio de administrador (1.24.0, decisión 2A):
         CONVIVE con la puerta vigente — esta versión no retira el
         token tras Caddy ni cambia el acceso actual —. La sesión
         viaja en cookie httpOnly (Secure tras el proxy) y también
         vale presentada como token en la cabecera, como la del
         invitado. Sin sección admin en la configuración del
         servidor, el login responde la verdad: no está
         configurado. */
      if (req.method === 'POST' && url.pathname === '/api/admin/login') {
        need(req.headers.origin === origin, 'Origen inválido.', 403);
        need(adminAuth, 'El login propio aún no está configurado: falta fijar la contraseña en la configuración del servidor.', 403);
        need(now() >= Number(adminFailState().lockUntil || 0), 'Demasiados intentos fallidos: el acceso está bloqueado unos minutos.', 429);
        const x = await body(req);
        const candidate = scryptSync(String(x.password || ''), adminAuth.salt, 32);
        const expected = Buffer.from(adminAuth.hash, 'hex');
        if (!(candidate.length === expected.length && timingSafeEqual(candidate, expected))) {
          /* El freno se persiste (H-1.1): sobrevive a reinicios. */
          const fails = (Array.isArray(adminFailState().fails) ? adminFailState().fails : [])
            .filter(at => now() - at <= 10 * MIN);
          fails.push(now());
          const lockUntil = fails.length >= 5
            ? now() + Math.min(60, 2 ** (fails.length - 5)) * MIN : 0;
          setState('admin-login-fails', JSON.stringify({ fails, lockUntil }));
          logAccess('admin-login-failed', 'Contraseña de administrador incorrecta');
          need(false, 'Contraseña incorrecta.');
        }
        setState('admin-login-fails', JSON.stringify({ fails: [], lockUntil: 0 }));
        const sessions = adminSessions();
        const sessionToken = randomBytes(24).toString('hex');
        /* La sesión nace con la huella del hash vigente (H-1.2). */
        sessions[sessionToken] = { exp: now() + 12 * 3600 * 1000, fp: adminFingerprint() };
        for (const [key, entry] of Object.entries(sessions))
          if (typeof entry !== 'object' || Number(entry.exp || 0) < now()) delete sessions[key];
        setState('admin-sessions', JSON.stringify(sessions));
        logAccess('admin-login', 'Entrada con el login propio de administrador');
        res.setHeader('Set-Cookie', 'pacosat_admin=' + sessionToken + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200' + (cloud ? '; Secure' : ''));
        return json(res, { ok: true, expira: sessions[sessionToken].exp });
      }
      if (req.method === 'POST' && url.pathname === '/api/admin/logout') {
        need(req.headers.origin === origin, 'Origen inválido.', 403);
        const sesion = adminCookie(req) || String(req.headers['x-pacosat-token'] || '');
        const sessions = adminSessions();
        if (sessions[sesion]) { delete sessions[sesion]; setState('admin-sessions', JSON.stringify(sessions)); }
        logAccess('admin-logout', 'Salida del login propio de administrador');
        res.setHeader('Set-Cookie', 'pacosat_admin=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0' + (cloud ? '; Secure' : ''));
        return json(res, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/guest/login') {
        need(req.headers.origin === origin, 'Origen inválido.', 403);
        const config = guestConfig();
        need(config.enabled && config.hash && config.salt, 'El acceso de invitado está desactivado.', 403);
        /* Límite de intentos (1.9.0): 8 fallos en 10 minutos
           bloquean nuevos intentos hasta que la ventana se vacía. */
        need(!guestLoginThrottled(), 'Demasiados intentos fallidos: espera unos minutos e inténtalo de nuevo.', 429);
        const x = await body(req);
        const candidate = scryptSync(String(x.password || ''), config.salt, 32);
        const expected = Buffer.from(config.hash, 'hex');
        if (!(candidate.length === expected.length && timingSafeEqual(candidate, expected))) {
          guestLoginFails.push(now());
          logAccess('guest-login-failed', 'Contraseña de invitado incorrecta');
          need(false, 'Contraseña de invitado incorrecta.');
        }
        guestLoginFails.length = 0;
        const sessions = guestSessions();
        const sessionToken = randomBytes(24).toString('hex');
        sessions[sessionToken] = now() + 12 * 3600 * 1000;
        for (const [key, expiry] of Object.entries(sessions)) if (expiry < now()) delete sessions[key];
        setState('guest-sessions', JSON.stringify(sessions));
        logAccess('guest-login', 'Entrada del invitado');
        return json(res, { token: sessionToken, expires: sessions[sessionToken] });
      }
      /* ===== Ejecutor local del SAT (1.29.0) =====
         Estas rutas van ANTES de la puerta general porque el
         ejecutor no es un navegador de la app: es el programa del
         equipo de Paco, emparejado con su propio token (solo su
         huella vive en la base). Sus rutas de trabajo exigen ESE
         token y solo pueden reclamar/devolver trabajos — nada más.
         Las rutas de administración (emparejar, ver la cola, crear
         trabajos) exigen la sesión de administrador de siempre; la
         puerta del invitado no cambia: un token de invitado no
         empareja ni ve la cola. */
      if (url.pathname.startsWith('/api/executor/')) {
        const adminOk = req.headers['x-pacosat-token'] === token ||
          adminSessionValid(req.headers['x-pacosat-token']) || adminSessionValid(adminCookie(req));
        const executor = executorByToken(req.headers['x-pacosat-executor']);
        if (req.method === 'POST' && url.pathname === '/api/executor/pair') {
          need(adminOk, 'Solo el administrador empareja un ejecutor.', 403);
          need(req.headers.origin === origin, 'Origen inválido.', 403);
          const x = await body(req);
          const rawToken = randomBytes(32).toString('hex');
          const id = randomUUID();
          db.prepare('INSERT INTO sat_executors(id,nombre,tokenHash,creado,ultimoVisto) VALUES (?,?,?,?,?)')
            .run(id, String(x.nombre || 'Equipo de Paco').slice(0, 80), executorTokenHash(rawToken), now(), 0);
          auditAdmin('Ejecutor local del SAT emparejado: ' + String(x.nombre || 'Equipo de Paco'));
          /* El token en claro se enseña UNA vez, en esta respuesta:
             queda en el ejecutor; aquí solo vive su huella. */
          return json(res, { id, token: rawToken, protocol: SAT_EXECUTOR_PROTOCOL_VERSION });
        }
        if (req.method === 'GET' && url.pathname === '/api/executor/overview') {
          need(adminOk, 'Solo el administrador ve la cola del ejecutor.', 403);
          return json(res, executorOverview());
        }
        if (req.method === 'POST' && url.pathname === '/api/executor/jobs') {
          need(adminOk, 'Solo el administrador crea trabajos del ejecutor.', 403);
          need(req.headers.origin === origin, 'Origen inválido.', 403);
          const x = await body(req);
          need(db.prepare('SELECT 1 FROM profiles WHERE rfc=?').get(String(x.rfc || '').toUpperCase()),
            'Ese RFC no tiene perfil en PacoSAT.', 404);
          try {
            const { job, repetido } = enqueueExecutorJob({ rfc: String(x.rfc).toUpperCase(),
              kind: String(x.kind || ''), payload: x.payload || {}, origen: 'paco' });
            return json(res, { job, repetido });
          } catch (error) { need(false, message(error), 422); }
        }
        if (req.method === 'POST' && url.pathname === '/api/executor/revoke') {
          /* Revocación del token de emparejamiento (1.29.0, H-1.2):
             el token era un portador permanente — la columna
             revocado se leía pero nadie la ponía a 1. Revocar lo
             apaga al instante (executorByToken ya filtra
             revocado=0: ni late, ni reclama, ni entrega), sus
             trabajos en curso vuelven a la cola para otro
             ejecutor, y el gesto queda en el Registro. Re-emparejar
             crea un token NUEVO: nunca revive el revocado. */
          need(adminOk, 'Solo el administrador revoca un ejecutor.', 403);
          need(req.headers.origin === origin, 'Origen inválido.', 403);
          const x = await body(req);
          const row = db.prepare('SELECT * FROM sat_executors WHERE id=?').get(String(x.id || ''));
          need(row, 'Ese ejecutor no existe.', 404);
          db.prepare('UPDATE sat_executors SET revocado=1 WHERE id=?').run(row.id);
          const devueltos = db.prepare("UPDATE sat_executor_jobs SET estado='en-cola', reclamadoPor='', leaseHasta=0, actualizado=? WHERE reclamadoPor=? AND estado IN ('en-curso','reclamado')")
            .run(now(), row.id).changes;
          auditAdmin('Ejecutor local del SAT REVOCADO: ' + row.nombre + ' — su token dejó de funcionar' +
            (devueltos ? '; ' + devueltos + ' trabajo(s) en curso volvieron a la cola' : ''));
          return json(res, { ok: true, id: row.id, revocado: true, devueltos });
        }
        if (req.method === 'POST' && url.pathname === '/api/executor/heartbeat') {
          need(executor, 'Token de ejecutor inválido.', 403);
          db.prepare('UPDATE sat_executors SET ultimoVisto=? WHERE id=?').run(now(), executor.id);
          expireExecutorLeases(now());
          const pendientes = db.prepare("SELECT COUNT(*) AS n FROM sat_executor_jobs WHERE estado='en-cola'").get()?.n || 0;
          return json(res, { ok: true, pendientes });
        }
        if (req.method === 'POST' && url.pathname === '/api/executor/claim') {
          need(executor, 'Token de ejecutor inválido.', 403);
          const x = await body(req);
          return json(res, { trabajos: claimExecutorJobs(executor, Number(x.limit) || 5) });
        }
        if (req.method === 'POST' && url.pathname === '/api/executor/result') {
          need(executor, 'Token de ejecutor inválido.', 403);
          const x = await body(req, 24 * 1024 * 1024);
          const jobRow = db.prepare('SELECT * FROM sat_executor_jobs WHERE id=?').get(String(x.jobId || ''));
          need(jobRow, 'Ese trabajo ya no existe.', 404);
          try {
            const outcome = completeExecutorJob(jobRow, executor, x);
            return json(res, { ...outcome, job: executorJobView(db.prepare('SELECT * FROM sat_executor_jobs WHERE id=?').get(jobRow.id)) });
          } catch (error) { need(false, message(error), error.status || 422); }
        }
        need(false, 'Ruta del ejecutor no encontrada.', 404);
      }
      /* Autenticación: el token principal (administrador) o una
         sesión de invitado viva (solo lectura, guarda más abajo). */
      const presented = req.headers['x-pacosat-token'];
      let guest = false;
      if (presented !== token) {
        /* Sesión del login propio de administrador (1.24.0): vale
           como el token principal, por cabecera o por su cookie
           httpOnly. No es invitada: no hereda sus límites. */
        if (adminSessionValid(presented) || adminSessionValid(adminCookie(req))) { /* administrador por login propio */ }
        else {
          const sessions = guestSessions();
          if (presented && sessions[presented] > now()) guest = true;
          else need(false, 'Sesión local inválida.', 403);
        }
      }
      const gScope = guest ? guestScopeRfcs() : null;
      if (guest) {
        const allowed = (req.method === 'GET' && GUEST_GET.includes(url.pathname)) ||
          (req.method === 'POST' && url.pathname === '/api/lists/validate');
        if (!allowed) { logAccess('guest-blocked', req.method + ' ' + url.pathname); need(false, 'El acceso de invitado es de solo lectura.', 403); }
        if (gScope && ['/api/banks', '/api/banks/movements', '/api/offline-bundle'].includes(url.pathname)) {
          logAccess('guest-blocked', req.method + ' ' + url.pathname + ' (fuera de su alcance por RFC)');
          need(false, 'Esa información no forma parte del alcance de este acceso de invitado.', 403);
        }
        if (url.pathname !== '/api/status') logAccess('guest', req.method + ' ' + url.pathname);
      }
      if (req.method === 'POST') need(req.headers.origin === origin, 'Origen inválido.', 403);
      /* Documento de capacidades bajo demanda (1.11.0): los 37,9 KB
         del documento «Qué incluye PacoSAT» ya no viajan dentro del
         HTML en cada carga; se piden solo al abrir Acerca de. El
         documento lo genera build.mjs en capacidades.json desde la
         misma fuente docs/CAPACIDADES.md. */
      if (req.method === 'GET' && url.pathname === '/api/capacidades') {
        return json(res, capacidades || { updated: '', sections: [] });
      }
      if (req.method === 'GET' && url.pathname === '/api/status') {
        const data = overview();
        if (gScope) {
          const inScope = row => !row?.rfc || gScope.has(String(row.rfc).toUpperCase());
          if (Array.isArray(data.profiles)) data.profiles = data.profiles.filter(inScope);
          if (Array.isArray(data.jobs)) data.jobs = data.jobs.filter(inScope);
          if (Array.isArray(data.coverage)) data.coverage = data.coverage.filter(inScope);
          if (Array.isArray(data.inbox)) data.inbox = data.inbox.filter(inScope);
          /* Buzón sin leer (1.23.0): el invitado solo ve los
             contadores de SU alcance por RFC. */
          if (data.buzonUnread && typeof data.buzonUnread === 'object')
            data.buzonUnread = Object.fromEntries(Object.entries(data.buzonUnread)
              .filter(([rfc]) => gScope.has(String(rfc).toUpperCase())));
          if (data.tributario && typeof data.tributario === 'object')
            data.tributario = Object.fromEntries(Object.entries(data.tributario)
              .filter(([rfc]) => gScope.has(String(rfc).toUpperCase())));
        }
        return json(res, data);
      }
      /* Restauración del estado operativo (1.6.4): la hace el diálogo de
         restauración tras volcar las tiendas del expediente, con la
         sección `operations` del mismo .faro ya descifrado. Disponible
         también en modo local: el estado vive en este servidor igualmente. */
      if (req.method === 'POST' && url.pathname === '/api/backup/operations') {
        const operations = await body(req, 32 * 1024 * 1024);
        const counts = restoreOperations(operations);
        putMetadata('activity', { id: 'oprestore:' + now(), name: 'Restauración del estado operativo',
          date: new Date(now()).toISOString(), added: 0, duplicates: 0, review: 0, issues: [],
          event: 'Estado operativo restaurado desde un respaldo: ' + Object.entries(counts).map(([name, count]) => name + ' ' + count).join(' · ') +
            '. Las e.firma no viajan en el respaldo: desbloquea cada perfil para reanudar las descargas.' });
        storageRevision++;
        return json(res, { ok: true, counts });
      }
      if (req.method === 'POST' && url.pathname === '/api/backup/verify') {
        await body(req);
        return json(res, verifyLatestBackup(now(), 'manual'));
      }
      /* Ensayo de restauración completo (1.24.0, punto 6):
         resucita el conjunto en una base aislada y lo cuenta. */
      if (req.method === 'POST' && url.pathname === '/api/backup/restore-test') {
        await body(req);
        return json(res, restoreTestLatest(now()));
      }
      /* Historia de un CFDI (1.6.5): línea de tiempo armada SOLO con datos
         ya guardados — emisión (del propio XML), descargas del SAT que lo
         incluyeron (jobs.imported), consultas de estado de la vigilancia,
         aviso de cancelación y PDF vinculado. Lo que no exista, no se
         muestra: ningún evento se fabrica. */
      if (req.method === 'POST' && url.pathname === '/api/settings') {
        const x = await body(req);
        if (!SETTING_ACCENTS.includes(x.accent ?? '')) need(false, 'Color de acento no válido.', 400);
        setSetting('installName', cleanSettingName(x.installName));
        setSetting('senderName', cleanSettingName(x.senderName));
        setSetting('accent', x.accent || '');
        return json(res, { ok: true, settings: publicSettings() });
      }
      if (url.pathname === '/api/settings/logo') {
        if (req.method === 'GET') {
          const mime = getSetting('logoMime'), data = getSetting('logoData');
          if (!mime || !data) need(false, 'Esta instalación no tiene logo.', 404);
          return json(res, { mime, data });
        }
        if (req.method === 'POST') {
          /* Límite de cuerpo propio: un logo de 200 KB viaja en base64
             (~273 KB de JSON), por encima del tope general de 192 KB. */
          const x = await body(req, 320 * 1024);
          const bytes = Buffer.from(String(x.data || ''), 'base64');
          const problem = validateLogo(String(x.mime || ''), bytes);
          if (problem) need(false, problem, 400);
          setSetting('logoMime', String(x.mime));
          setSetting('logoData', bytes.toString('base64'));
          return json(res, { ok: true, settings: publicSettings() });
        }
        if (req.method === 'DELETE') {
          deleteSetting('logoMime'); deleteSetting('logoData');
          return json(res, { ok: true, settings: publicSettings() });
        }
      }
      if (req.method === 'GET' && url.pathname === '/api/invoice-history') {
        const id = url.searchParams.get('id') || '';
        need(id.length > 0 && id.length <= 40, 'Folio fiscal inválido.');
        const events = [];
        const invoiceRow = db.prepare("SELECT value FROM records WHERE store='invoices' AND id=?").get(id);
        if (invoiceRow) {
          const invoice = JSON.parse(invoiceRow.value);
          events.push({ at: invoice.date, kind: 'emission', label: 'CFDI emitido',
            detail: 'Tipo ' + invoice.kind + ' · ' + invoice.from.rfc + ' → ' + invoice.to.rfc + ' · ' + invoice.total + ' ' + (invoice.currency || 'MXN') });
        }
        for (const job of db.prepare("SELECT * FROM jobs WHERE status='finished'").all()) {
          let imported = [];
          try { imported = JSON.parse(job.imported || '[]'); } catch { imported = []; }
          if (Array.isArray(imported) && imported.includes(id)) events.push({ at: new Date(job.created).toISOString(), kind: 'download',
            label: 'Descargado del SAT', detail: 'Periodo ' + job.periodStart + ' a ' + job.periodEnd + ' · ' + (job.direction === 'received' ? 'recibidos' : 'emitidos') + ' · ' + job.rfc });
        }
        if (tableExists('cfdi_watch')) {
          const watch = db.prepare('SELECT checked,result FROM cfdi_watch WHERE id=?').get(id);
          if (watch?.checked) events.push({ at: new Date(watch.checked).toISOString(), kind: 'status',
            label: 'Estado consultado en el SAT', detail: watch.result || 'Sin resultado' });
          const cancel = db.prepare('SELECT due,sent FROM cancellation_alert WHERE id=?').get(id);
          if (cancel) events.push({ at: cancel.due ? new Date(cancel.due).toISOString() : null, kind: 'alert',
            label: 'Aviso de cancelación', detail: cancel.sent ? 'Aviso enviado por correo' : 'Aviso pendiente de envío' });
        }
        for (const docRow of db.prepare("SELECT value FROM records WHERE store='documents'").all()) {
          try {
            const doc = JSON.parse(docRow.value);
            if (doc.kind === 'Factura PDF' && doc.uuid === id) events.push({ at: null, kind: 'pdf', label: 'PDF vinculado', detail: doc.name || '' });
          } catch { /* documento ilegible: no forma parte de la historia */ }
        }
        events.sort((a, b) => (a.at || '9999').localeCompare(b.at || '9999'));
        return json(res, { events });
      }
      if (req.method === 'POST' && url.pathname === '/api/monitor') {
        const { ids = [], records = [] } = await body(req);
        need(Array.isArray(ids) && ids.length <= 500 && ids.every(id => typeof id === 'string' && id.length === 36) &&
          Array.isArray(records) && records.length <= 150, 'Lote de vigilancia inválido.');
        try { tx(db, () => records.forEach(monitor.register)); }
        catch (error) { need(false, message(error)); }
        return json(res, monitor.status(ids));
      }
      if (req.method === 'GET' && url.pathname === '/api/monitor/global') {
        /* La tarjeta de Hoy (1.22.0, pieza 2): el resumen sale de
           cfdi_watch del servidor, no de la caché del navegador. */
        return json(res, monitorGlobalSummary());
      }
      if (req.method === 'POST' && url.pathname === '/api/monitor/summary') {
        /* Resumen de la Vigilancia SAT: las cifras de las tarjetas,
           contadas sobre TODA la selección del contribuyente. */
        const { ids = [] } = await body(req);
        need(Array.isArray(ids) && ids.length <= 20000 && ids.every(id => typeof id === 'string' && id.length === 36),
          'Selección de resumen inválida.');
        return json(res, monitor.summary(ids));
      }
      if (req.method === 'POST' && url.pathname === '/api/monitor/check-now') {
        /* «Revisar mis CFDI ahora» (1.18.0): encola los pedidos sin
           respuesta y ARRANCA el barrido como trabajo del servidor
           — la respuesta vuelve al instante y el avance vive en
           /api/activity. Antes la pantalla encadenaba llamadas
           (hasta 400 rondas) y la cadena moría al cerrar la
           pestaña; ahora el trabajo es del servidor y sobrevive. */
        const { ids = [] } = await body(req);
        need(Array.isArray(ids) && ids.length <= 20000 && ids.every(id => typeof id === 'string' && id.length === 36),
          'Selección de revisión inválida.');
        const queued = monitor.checkNow(ids);
        const state = sweepStart(queued);
        return json(res, { queued, started: true, processed: 0, remaining: state.remaining,
          sweep: { running: state.running, total: state.total, remaining: state.remaining } });
      }
      if (req.method === 'GET' && url.pathname === '/api/activity') {
        /* El registro único de trabajos: en curso, pausados, lo
           reciente y la próxima acción automática. Solo lectura. */
        return json(res, activityOverview(now()));
      }
      /* «Mientras no estabas» (1.25.0, mejora nº 9): el resumen
         de lo que el sistema hizo desde la última vez que Paco
         marcó «visto» — CFDI nuevos, corridas y avisos — para
         entrar y saber en diez segundos qué cambió. La marca es
         del servidor (vale en todos sus dispositivos) y solo
         avanza con su toque, nunca sola. */
      if (req.method === 'GET' && url.pathname === '/api/activity/digest') {
        const time = now();
        const marca = Number(getState('hoy:last-seen') || 0) || (time - DAY);
        const desde = Math.max(marca, time - 7 * DAY);
        const porNombre = new Map();
        let cfdiNuevos = 0, eventos = 0;
        for (const row of db.prepare("SELECT value FROM records WHERE store='activity'").all()) {
          let item; try { item = JSON.parse(row.value || '{}'); } catch { continue; }
          const at = Date.parse(item.date || '') || 0;
          if (at < desde || at > time) continue;
          eventos++;
          cfdiNuevos += Number(item.added || 0);
          const nombre = String(item.name || 'Actividad');
          porNombre.set(nombre, (porNombre.get(nombre) || 0) + 1);
        }
        const avisosNuevos = db.prepare('SELECT COUNT(*) AS n FROM avisos WHERE creado>=?').get(desde).n;
        const criticos = db.prepare("SELECT COUNT(*) AS n FROM avisos WHERE creado>=? AND clase='mal' AND severidad='alta' AND estado NOT IN ('solventado','descartado')").get(desde).n;
        return json(res, { desde, eventos, cfdiNuevos, avisosNuevos, criticos,
          hechos: [...porNombre.entries()].map(([nombre, n]) => ({ nombre, n }))
            .sort((a, b) => b.n - a.n).slice(0, 6) });
      }
      if (req.method === 'POST' && url.pathname === '/api/activity/seen') {
        const anterior = Number(getState('hoy:last-seen') || 0);
        if (now() > anterior) setState('hoy:last-seen', String(now()));
        return json(res, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/activity/control') {
        /* Detener o reanudar una operación (1.18.0): cada clase
           admite solo los gestos que su motor permite de verdad;
           lo demás se dice, no se finge. */
        const x = await body(req);
        /* El cliente manda los verbos en español («pausar»,
           «reanudar», «detener»); se normalizan aquí a la forma
           interna para que ningún botón muera por vocabulario. */
        const action = { pausar: 'pause', reanudar: 'resume', detener: 'stop' }[String(x.action || '')] ||
          String(x.action || '');
        need(['pause', 'resume', 'stop'].includes(action), 'Acción de control inválida.');
        if (x.kind === 'barrido') {
          if (action === 'pause') { need(sweepState.running, 'El barrido no está en curso.'); sweepState.paused = true; }
          else if (action === 'resume') { need(sweepState.running, 'El barrido no está en curso.'); sweepState.paused = false; }
          else { need(sweepState.running, 'El barrido no está en curso.');
            sweepState.running = false; sweepState.paused = false; sweepState.finishedAt = now();
            setState('sweep-last', JSON.stringify({ at: sweepState.finishedAt, done: sweepState.done,
              total: sweepState.total, stopped: true })); }
          return json(res, activityOverview(now()));
        }
        if (x.kind === 'listados') {
          if (action === 'stop') { if (listsBusy) listsCancelRequested = true; return json(res, activityOverview(now())); }
          need(false, 'La actualización de listados no se pausa: se detiene o se vuelve a lanzar.', 422);
        }
        if (x.kind === 'masiva') {
          const job = db.prepare("SELECT * FROM jobs WHERE id=? AND status='pending'").get(Number(x.jobId));
          need(job, 'Esa solicitud ya no está pendiente en el SAT.', 404);
          if (action === 'resume') db.prepare('UPDATE jobs SET held=0 WHERE id=?').run(job.id);
          else if (action === 'pause') db.prepare('UPDATE jobs SET held=1 WHERE id=?').run(job.id);
          else need(false, 'Una solicitud ya entregada al SAT no se puede detener: se puede retener (pausar) para que PacoSAT deje de sondearla.', 422);
          return json(res, activityOverview(now()));
        }
        if (x.kind === 'mensual') {
          const mState = monthlyState();
          const run = (mState.runs || {})[String(x.month || '')];
          need(run && run.status === 'en-curso', 'Esa descarga automática ya no está en curso.', 404);
          run.held = action === 'pause';
          saveMonthlyState(mState);
          return json(res, activityOverview(now()));
        }
        if (x.kind === 'documentos') {
          /* Cancelar desde Actividad (1.22.0): la clave trae el RFC
             («documentos:<rfc>») y el gesto «detener» marca el token
             vivo; la corrida se cierra como cancelada en el servidor. */
          need(action === 'stop', 'La descarga de documentos solo admite detener (cancelar).', 422);
          const rfc = String(x.key || '').split(':').slice(1).join(':');
          const stopped = cancelSatDocRun(rfc, x.stopKind ? String(x.stopKind) : null);
          need(stopped, 'Esa descarga ya no está en curso.', 404);
          return json(res, activityOverview(now()));
        }
        need(false, 'Esa operación no admite pausa: termina su paso actual y se detiene sola.', 422);
      }
      if (req.method === 'POST' && url.pathname === '/api/monitor/check-one') {
        /* «Revisar ahora» de UNA factura (1.13.1): fuerza la consulta
           al SAT de ese UUID al momento, con la misma función y las
           mismas reglas de guardado de la tanda automática. Como el
           resto de POST de monitor, el invitado queda fuera por la
           guarda general de solo lectura. */
        const { uuid } = await body(req);
        need(typeof uuid === 'string' && uuid.length === 36, 'UUID de revisión inválido.');
        const result = await monitor.checkOneNow(uuid.toUpperCase());
        need(result, 'Ese comprobante no está en la vigilancia: impórtalo o descárgalo primero.', 404);
        need(!result.busy, 'La vigilancia está revisando otra tanda ahora mismo: inténtalo en unos segundos.', 409);
        return json(res, result);
      }
      if (req.method === 'POST' && url.pathname === '/api/monitor/refresh-lists') {
        /* «Actualizar listados»: fuerza la descarga del listado 69-B
           que usa la vigilancia (el de la pantalla de Listas negras va
           por /api/lists/refresh). */
        return json(res, { lists: await monitor.refreshLists() });
      }
      if (req.method === 'GET' && url.pathname === '/api/lists') return json(res, listsOverview());
      if (req.method === 'GET' && url.pathname === '/api/lists/progress') return json(res, listsProgress);
      if (req.method === 'POST' && url.pathname === '/api/lists/cancel') {
        /* Cancelar la actualización en curso (1.13.1, pieza F):
           parada cooperativa — el ciclo se detiene en el siguiente
           punto seguro y lo parcial se descarta. Sin ciclo en curso,
           no hay nada que cancelar y se dice. */
        if (!listsBusy) return json(res, { cancelling: false });
        listsCancelRequested = true;
        return json(res, { cancelling: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/lists/refresh') {
        /* Actualizar ahora (1.13.1, pieza H): marca como vencidos los
           listados pedidos (o todos) y ARRANCA el ciclo como trabajo
           con estado — la respuesta vuelve al instante y el avance
           (fase, conteo, cancelar, resultado) vive en
           /api/lists/progress. Ninguna petición espera dentro de sí
           la importación de un listado: eso era parte de los cortes
           «el servicio local no respondió» del 10 nov. */
        const x = await body(req);
        if (listsBusy) return json(res, { started: false, progress: listsProgress, ...listsOverview() });
        for (const source of LIST_CATALOG) {
          if (x.listId && source.id !== x.listId) continue;
          if (!source.url) continue;
          db.prepare('INSERT INTO blacklist_meta(listId,next) VALUES (?,0) ON CONFLICT(listId) DO UPDATE SET next=0')
            .run(source.id);
        }
        listsTick(now(), listFetch || undefined).catch(() => { /* el error queda en el progreso/meta */ });
        return json(res, { started: true, progress: listsProgress, ...listsOverview() });
      }
      if (req.method === 'POST' && url.pathname === '/api/lists/import') {
        /* Importación manual de un listado sin URL oficial en CSV
           (CSD sin efectos, Reducción 74, o una copia semilla): pasa por
           el mismo parser y el mismo cruce que una descarga. */
        const x = await body(req, 72 * 1024 * 1024);
        const source = LIST_CATALOG.find(item => item.id === x.listId);
        need(source, 'Listado desconocido.', 404);
        need(typeof x.content === 'string' && x.content.length > 0, 'Falta el contenido del listado.');
        const raw = Buffer.from(x.content, 'base64');
        need(raw.length <= 64 * 1024 * 1024, 'El listado supera el tamaño permitido.');
        let content;
        try { content = new TextDecoder('utf-8', { fatal: true }).decode(raw); }
        catch { content = new TextDecoder('windows-1252').decode(raw); }
        try { await refreshList(source, now(), async () => content); }
        catch (error) { need(false, message(error), 422); }
        return json(res, listsOverview());
      }
      if (req.method === 'POST' && url.pathname === '/api/lists/counterparts') {
        const x = await body(req);
        const shape = validateRfc(typeof x.rfc === 'string' ? x.rfc : '');
        need(shape.level !== 'structure', shape.error || 'RFC inválido.');
        need(['', 'Cliente', 'Proveedor', 'Ambos', 'Propio'].includes(x.kind || ''), 'Tipo de contraparte inválido.');
        /* Calendario de pago (1.7.4): día del mes 1–31 y/o plazo en
           días. Campo ausente = conservar el que haya; vacío = sin
           fijar (vuelve la regla general de antigüedad). */
        const existingCp = db.prepare('SELECT payDay,payTerms FROM counterparts WHERE rfc=?').get(x.rfc);
        const payDay = x.payDay === undefined ? (existingCp?.payDay ?? null)
          : x.payDay === null || x.payDay === '' ? null : Math.floor(Number(x.payDay));
        const payTerms = x.payTerms === undefined ? (existingCp?.payTerms ?? null)
          : x.payTerms === null || x.payTerms === '' ? null : Math.floor(Number(x.payTerms));
        need(payDay === null || (payDay >= 1 && payDay <= 31), 'El día de pago debe ser entre 1 y 31.');
        need(payTerms === null || (payTerms >= 0 && payTerms <= 365), 'El plazo debe ser entre 0 y 365 días.');
        db.prepare('INSERT INTO counterparts(rfc,name,kind,note,source,updated,payDay,payTerms) VALUES (?,?,?,?,?,?,?,?) ' +
          'ON CONFLICT(rfc) DO UPDATE SET name=excluded.name,kind=excluded.kind,note=excluded.note,source=\'manual\',updated=excluded.updated,payDay=excluded.payDay,payTerms=excluded.payTerms')
          .run(x.rfc, String(x.name || '').slice(0, 200), x.kind || '', String(x.note || '').slice(0, 300), 'manual', now(), payDay, payTerms);
        return json(res, listsOverview());
      }
      if (req.method === 'POST' && url.pathname === '/api/lists/counterparts/bulk') {
        /* Carga masiva (Excel/CSV de 3 columnas ya leído en la app). */
        const x = await body(req, 8 * 1024 * 1024);
        need(Array.isArray(x.rows) && x.rows.length <= 5000, 'Lote inválido.');
        let saved = 0, skipped = 0;
        const upsert = db.prepare('INSERT INTO counterparts(rfc,name,kind,note,source,updated) VALUES (?,?,?,?,?,?) ' +
          'ON CONFLICT(rfc) DO UPDATE SET name=excluded.name,note=excluded.note,source=\'manual\',updated=excluded.updated');
        for (const row of x.rows) {
          const rfc = String(row?.rfc || '').trim().toUpperCase();
          if (validateRfc(rfc).level === 'structure') { skipped++; continue; }
          upsert.run(rfc, String(row?.name || '').slice(0, 200),
            ['Cliente', 'Proveedor', 'Ambos'].includes(row?.kind) ? row.kind : '',
            String(row?.note || '').slice(0, 300), 'manual', now());
          saved++;
        }
        return json(res, { ...listsOverview(), bulk: { saved, skipped } });
      }
      if (req.method === 'POST' && url.pathname === '/api/lists/counterparts/remove') {
        const x = await body(req);
        db.prepare('DELETE FROM counterparts WHERE rfc=?').run(String(x.rfc || ''));
        return json(res, listsOverview());
      }
      if (req.method === 'POST' && url.pathname === '/api/lists/validate') {
        /* Validador en tiempo real: por RFC exacto o por nombre/razón
           social (sin acentos ni mayúsculas) contra TODOS los listados
           cargados, no solo contra el padrón. */
        const x = await body(req);
        const query = String(x.query || '').trim();
        need(query.length >= 3, 'Escribe un RFC completo o al menos 3 letras del nombre.');
        const matches = [];
        const pushEntry = entry => {
          const source = LIST_CATALOG.find(item => item.id === entry.listId);
          matches.push({ rfc: entry.rfc, name: entry.name, listId: entry.listId,
            label: source?.label || entry.listId, detail: entry.detail,
            severity: source ? listSeverity(source, entry.detail) : 'warn' });
        };
        if (/^[A-Za-zÑ&0-9]{12,13}$/.test(query)) {
          for (const entry of db.prepare('SELECT * FROM blacklist_entries WHERE rfc=?').all(query.toUpperCase())) pushEntry(entry);
        } else {
          const needle = query.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
          for (const entry of db.prepare('SELECT * FROM blacklist_entries').all()) {
            if (matches.length >= 50) break;
            const name = (entry.name || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
            if (name.includes(needle)) pushEntry(entry);
          }
        }
        return json(res, { query, matches });
      }
      if (req.method === 'GET' && url.pathname === '/api/satdocs') return json(res, { profiles: satDocsOverview(now()), expediente: expedienteCounts() });
      /* Buzón Tributario (1.24.0, punto 1): consultar = lanzar la
         corrida que LISTA sin abrir; la pantalla lee su panorama
         (notificaciones guardadas, diario y progreso) por GET. */
      if (req.method === 'POST' && url.pathname === '/api/tributario/run') {
        const x = await body(req);
        need(db.prepare('SELECT 1 FROM profiles WHERE rfc=?').get(String(x.rfc || '')), 'Ese RFC no tiene perfil en PacoSAT.', 404);
        const result = await runTributarioAttempt(String(x.rfc), now());
        return json(res, { result: { waitingExecutor: false, ...result }, view: tribOverview(String(x.rfc)) });
      }
      if (req.method === 'GET' && url.pathname === '/api/tributario') {
        return json(res, tribOverview(String(url.searchParams.get('rfc') || ''),
          { incluirArchivadas: url.searchParams.get('archivadas') === '1',
            incluirPapelera: url.searchParams.get('papelera') === '1' }));
      }
      if (req.method === 'POST' && url.pathname === '/api/tributario/trash') {
        /* A la papelera LOCAL (1.29.0, adenda): sale de todas las
           vistas principales en el acto; no toca el SAT ni abre
           nada. Deshacer = la misma ruta con papelera:false. Todo
           queda trazado en el Registro por la vía del administrador. */
        const x = await body(req);
        const rfc = String(x.rfc || '');
        need(db.prepare('SELECT 1 FROM profiles WHERE rfc=?').get(rfc), 'Ese RFC no tiene perfil en PacoSAT.', 404);
        const row = db.prepare('SELECT * FROM trib_notifications WHERE rfc=? AND clave=?').get(rfc, String(x.clave || ''));
        need(row, 'Esa notificación ya no consta en el buzón local.', 404);
        const aPapelera = x.papelera !== false;
        db.prepare('UPDATE trib_notifications SET enPapelera=?, papeleraEn=? WHERE rfc=? AND clave=?')
          .run(aPapelera ? 1 : 0, aPapelera ? now() : 0, rfc, row.clave);
        auditAdmin((aPapelera ? 'Mandó a la papelera local' : 'Devolvió de la papelera local') +
          ' una notificación del Buzón Tributario de ' + rfc + ' («' + String(row.asunto || '').slice(0, 80) + '»)', rfc);
        return json(res, { ok: true, view: tribOverview(rfc, { incluirArchivadas: true, incluirPapelera: true }) });
      }
      if (req.method === 'POST' && url.pathname === '/api/tributario/purge') {
        /* Purga definitiva (1.29.0, adenda): la hace Paco con su
           toque desde la Papelera. Borra la COPIA local y deja la
           LÁPIDA (identificador + cuándo) para que la
           sincronización no la resucite jamás. El registro
           original en el SAT no se toca — es constancia oficial
           y la pantalla lo dice. Queda trazado en el Registro. */
        const x = await body(req);
        const rfc = String(x.rfc || '');
        need(db.prepare('SELECT 1 FROM profiles WHERE rfc=?').get(rfc), 'Ese RFC no tiene perfil en PacoSAT.', 404);
        const row = db.prepare('SELECT * FROM trib_notifications WHERE rfc=? AND clave=?').get(rfc, String(x.clave || ''));
        need(row, 'Esa notificación ya no consta en el buzón local.', 404);
        need(row.enPapelera, 'Solo se purga desde la Papelera: mándala allí primero.', 422);
        db.prepare('INSERT OR REPLACE INTO trib_tombstones(rfc,clave,creado,motivo,asunto) VALUES (?,?,?,?,?)')
          .run(rfc, row.clave, now(), 'purga-manual', String(row.asunto || '').slice(0, 120));
        db.prepare('DELETE FROM trib_notifications WHERE rfc=? AND clave=?').run(rfc, row.clave);
        auditAdmin('Purgó definitivamente de PacoSAT una notificación del Buzón Tributario de ' + rfc +
          ' («' + String(row.asunto || '').slice(0, 80) + '»): queda su lápida para que no vuelva; el original en el SAT no se toca.', rfc);
        return json(res, { ok: true, view: tribOverview(rfc, { incluirArchivadas: true, incluirPapelera: true }) });
      }
      if (req.method === 'POST' && url.pathname === '/api/tributario/archive') {
        /* Archivo LOCAL de una notificación listada (1.29.0): no
           toca el SAT ni abre nada — solo cambia si la vista
           principal la enseña. La sincronización no lo deshace. */
        const x = await body(req);
        const rfc = String(x.rfc || '');
        need(db.prepare('SELECT 1 FROM profiles WHERE rfc=?').get(rfc), 'Ese RFC no tiene perfil en PacoSAT.', 404);
        const row = db.prepare('SELECT * FROM trib_notifications WHERE rfc=? AND clave=?').get(rfc, String(x.clave || ''));
        need(row, 'Esa notificación ya no consta en el buzón local.', 404);
        const archivada = x.archivada === false ? 0 : 1;
        db.prepare('UPDATE trib_notifications SET archivada=?, archivadaEn=? WHERE rfc=? AND clave=?')
          .run(archivada, archivada ? now() : 0, rfc, row.clave);
        auditAdmin((archivada ? 'Archivó en local' : 'Devolvió a la vista principal') +
          ' una notificación del Buzón Tributario de ' + rfc + ' («' + String(row.asunto || '').slice(0, 80) + '»)', rfc);
        return json(res, { ok: true, view: tribOverview(rfc, { incluirArchivadas: true }) });
      }
      if (req.method === 'POST' && url.pathname === '/api/tributario/cancel') {
        const x = await body(req);
        const token = tribLive.get(String(x.rfc || ''));
        if (token) token.cancelled = true;
        return json(res, { ok: true, habia: Boolean(token) });
      }
      /* Alta preparada (1.24.0, punto 7): crea el contribuyente en
         «faltan credenciales»; ningún dato fiscal se inventa. */
      if (req.method === 'POST' && url.pathname === '/api/profiles/prepare') {
        const x = await body(req);
        const rfc = String(x.rfc || '').toUpperCase();
        need(validateRfc(rfc).level !== 'structure', 'El RFC no tiene una estructura válida.');
        db.prepare('INSERT OR IGNORE INTO pending_profiles(rfc,created,nota) VALUES (?,?,?)')
          .run(rfc, now(), 'Alta preparada desde el directorio de contribuyentes: faltan credenciales.');
        ensurePendingProfileRow(rfc);
        return json(res, { ok: true, rfc, pendiente: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/satdocs/config') {
        const x = await body(req);
        need(db.prepare('SELECT 1 FROM profiles WHERE rfc=?').get(String(x.rfc || '')), 'Ese RFC no tiene perfil en PacoSAT.', 404);
        const day = Math.floor(Number(x.day)), hour = Math.floor(Number(x.hour));
        need(day >= 1 && day <= 28, 'El día del mes debe estar entre 1 y 28.');
        need(hour >= 0 && hour <= 23, 'La hora debe estar entre 0 y 23.');
        const config = satDocsConfig();
        config[x.rfc] = { enabled: Boolean(x.enabled), day, hour,
          recipients: String(x.recipients || '').slice(0, 500) };
        db.prepare("INSERT INTO settings(key,value) VALUES ('satdocs',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
          .run(JSON.stringify(config));
        auditAdmin('Cambió el ajuste de descarga de documentos del SAT de ' + String(x.rfc || '') +
          ' (día ' + day + ', ' + (config[x.rfc].enabled ? 'activada' : 'desactivada') + ')', String(x.rfc || ''));
        return json(res, { profiles: satDocsOverview(now()) });
      }
      if (req.method === 'POST' && url.pathname === '/api/satdocs/run') {
        /* Descargar ahora: intento inmediato de una o de las dos
           clases de documento; el resultado queda registrado. */
        const x = await body(req);
        need(db.prepare('SELECT 1 FROM profiles WHERE rfc=?').get(String(x.rfc || '')), 'Ese RFC no tiene perfil en PacoSAT.', 404);
        const kinds = x.kind ? [x.kind] : ['constancia', 'opinion'];
        for (const kind of kinds) need(DOC_KIND_LABEL[kind], 'Clase de documento inválida.');
        const results = {};
        for (const kind of kinds) results[kind] = await runSatDocAttempt(x.rfc, kind, now(), 'paco');
        /* R2: si alguna clase ya corría, la respuesta lo dice con
           su código — la pantalla lleva a la corrida viva. */
        const enCurso = Object.values(results).find(r => r?.yaEnCurso);
        return json(res, { results, profiles: satDocsOverview(now()),
          ...(enCurso ? { aviso: enCurso.error } : {}) }, enCurso ? 409 : 200);
      }
      if (req.method === 'POST' && url.pathname === '/api/satdocs/cancel') {
        /* Cancelar la descarga (pieza 9): detiene la corrida EN EL
           SERVIDOR; la respuesta se lee tras re-leer el estado, y
           la pantalla confirma con el progreso final. */
        const x = await body(req);
        need(db.prepare('SELECT 1 FROM profiles WHERE rfc=?').get(String(x.rfc || '')), 'Ese RFC no tiene perfil en PacoSAT.', 404);
        const stopped = cancelSatDocRun(String(x.rfc), x.kind ? String(x.kind) : null);
        return json(res, { stopped, profiles: satDocsOverview(now()) });
      }
      if (req.method === 'POST' && url.pathname === '/api/declaraciones/cancel') {
        const x = await body(req);
        need(db.prepare('SELECT 1 FROM profiles WHERE rfc=?').get(String(x.rfc || '')), 'Ese RFC no tiene perfil en PacoSAT.', 404);
        const stopped = cancelDeclRun(String(x.rfc));
        const ejercicio = Number(x.ejercicio) || Number(new Date(now()).toISOString().slice(0, 4));
        return json(res, { stopped, view: declaracionesOverview(String(x.rfc), ejercicio, now()) });
      }
      if (req.method === 'POST' && url.pathname === '/api/sat/cancel-job') {
        /* Cancelar un trabajo CFDI pendiente (masiva/recuperación):
           sale de la cola y su hueco queda visible en Cobertura. */
        const x = await body(req);
        const job = db.prepare('SELECT * FROM jobs WHERE id=?').get(String(x.id || ''));
        need(job, 'Ese trabajo ya no existe.', 404);
        if (job.status === 'pending') {
          db.prepare("UPDATE jobs SET status='cancelled',error=? WHERE id=?")
            .run('Cancelado por ti desde Trabajos del SAT: el hueco queda visible en Cobertura.', job.id);
          settleJob(job.id);
        }
        return json(res, { ok: true, trabajos: satTrabajos(now()) });
      }
      if (req.method === 'GET' && url.pathname === '/api/sat/trabajos') {
        return json(res, { trabajos: satTrabajos(now()) });
      }
      if (req.method === 'POST' && url.pathname === '/api/satdocs/upload') {
        /* Subida manual del PDF: se archiva en Expedientes con su
           fecha de emisión y vale para el semáforo igual que una
           descarga automática. */
        const x = await body(req, 22 * 1024 * 1024);
        need(db.prepare('SELECT 1 FROM profiles WHERE rfc=?').get(String(x.rfc || '')), 'Ese RFC no tiene perfil en PacoSAT.', 404);
        need(DOC_KIND_LABEL[x.kind], 'Clase de documento inválida.');
        const issuedAt = Date.parse(String(x.date || ''));
        need(Number.isFinite(issuedAt), 'Indica la fecha de emisión del documento.');
        need(typeof x.content === 'string' && x.content.length > 0, 'Falta el archivo PDF.');
        const raw = Buffer.from(x.content, 'base64');
        need(raw.length <= 16 * 1024 * 1024 && raw.subarray(0, 4).toString() === '%PDF', 'El archivo no es un PDF válido de hasta 16 MB.');
        archiveSatDoc(x.rfc, x.kind, raw, issuedAt, 'manual', now(), String(x.name || '').slice(0, 180) || undefined);
        return json(res, { profiles: satDocsOverview(now()) });
      }
      if (req.method === 'GET' && url.pathname === '/api/satdocs/artifact') {
        /* Artefactos del diario de una corrida (1.10.1): la captura
           de pantalla o el volcado HTML de la página tal como quedó
           en el punto del fallo, para revisar el error con la foto
           delante en vez de repetir la corrida a ciegas. */
        const run = db.prepare('SELECT * FROM sat_doc_runs WHERE id=?').get(String(url.searchParams.get('run') || ''));
        need(run, 'Esa corrida del diario ya no existe.', 404);
        const part = String(url.searchParams.get('part') || '');
        need(part === 'shot' || part === 'html', 'Parte del diario inválida.');
        const fileId = part === 'shot' ? run.shotId : run.htmlId;
        need(fileId, 'Esa corrida no guardó esa parte del diario.', 404);
        const file = readFileRecord(fileId);
        need(file, 'Ese archivo del diario ya no existe.', 404);
        const stamp = new Date(run.started).toISOString().slice(0, 10);
        const name = 'diario-' + run.rfc + '-' + run.kind + '-' + stamp + (part === 'shot' ? '-captura.png' : '-pagina.html');
        res.writeHead(200, { 'content-type': file.mime, 'content-disposition': 'attachment; filename="' + name + '"' });
        return res.end(file.buffer);
      }
      if (req.method === 'GET' && (url.pathname === '/api/declaraciones/artifact' || url.pathname === '/api/tributario/artifact')) {
        /* Artefactos del diario de declaraciones y del buzón
           (1.27.0): la misma evidencia que la de documentos —
           captura y HTML de la página en el punto del fallo —
           servida desde su corrida. No están en las lecturas del
           invitado; y si un invitado llegara, su alcance manda:
           fuera de él, la corrida no existe. */
        const table = url.pathname === '/api/declaraciones/artifact' ? 'decl_runs' : 'trib_runs';
        const run = db.prepare('SELECT * FROM ' + table + ' WHERE id=?').get(String(url.searchParams.get('run') || ''));
        need(run, 'Esa corrida del diario ya no existe.', 404);
        need(!gScope || gScope.has(String(run.rfc || '').toUpperCase()), 'Esa corrida del diario ya no existe.', 404);
        const part = String(url.searchParams.get('part') || '');
        need(part === 'shot' || part === 'html', 'Parte del diario inválida.');
        const fileId = part === 'shot' ? run.shotId : run.htmlId;
        need(fileId, 'Esa corrida no guardó esa parte del diario.', 404);
        const file = readFileRecord(fileId);
        need(file, 'Ese archivo del diario ya no existe.', 404);
        const stamp = new Date(run.started).toISOString().slice(0, 10);
        const name = 'diario-' + run.rfc + '-' + (table === 'decl_runs' ? 'declaraciones' : 'buzon') + '-' + stamp + (part === 'shot' ? '-captura.png' : '-pagina.html');
        res.writeHead(200, { 'content-type': file.mime, 'content-disposition': 'attachment; filename="' + name + '"' });
        return res.end(file.buffer);
      }
      if (req.method === 'GET' && url.pathname === '/api/ciec') {
        /* Vista de la descarga por CIEC: perfiles con ese método,
           su progreso en vivo, la pausa del captcha si la hay y el
           diario. NO está en la lista de lecturas del invitado: el
           invitado ni la ve (solo lectura y sin CIEC, como Pagos). */
        return json(res, { profiles: ciecOverview() });
      }
      if (req.method === 'POST' && url.pathname === '/api/ciec') {
        /* Guardar el acceso CIEC de un RFC (1.12.0): SOLO RFC y
           contraseña — sin .cer/.key — para los RFC que no tienen
           e.firma. La contraseña va a la carpeta protegida con la
           misma custodia que la de la e.firma y el método del RFC
           queda en «ciec». No se puede probar contra el SAT sin el
           captcha de Paco: la prueba es la primera descarga, que
           queda en el diario con su motivo si algo no cuadra. */
        const x = await body(req);
        const shape = validateRfc(typeof x.rfc === 'string' ? x.rfc : '');
        need(shape.level !== 'structure', shape.error || 'RFC inválido.');
        need(db.prepare("SELECT 1 FROM records WHERE store='people' AND id=?").get(x.rfc),
          'Ese RFC no está registrado como contribuyente en PacoSAT: regístralo primero.', 404);
        need(Number.isInteger(x.minutes) && x.minutes >= 60 && x.minutes <= 1440, 'El intervalo debe ser de 60 a 1440 minutos.');
        need(Number.isInteger(x.days) && x.days >= 1 && x.days <= 31, 'El periodo de revisión debe ser de 1 a 31 días.');
        need(['received', 'issued', 'both'].includes(x.direction), 'Elige emitidos o recibidos.');
        need(typeof x.ciec === 'string' && x.ciec.length > 0 && x.ciec.length <= 256, 'Escribe la contraseña CIEC del SAT.');
        try {
          writeCiecCredentials(x.rfc, { ciec: x.ciec, minutes: x.minutes, days: x.days, direction: x.direction });
          db.prepare("INSERT INTO profiles(rfc,minutes,days,direction,nextRun,error) VALUES (?,?,?,?,0,'') ON CONFLICT(rfc) DO UPDATE SET minutes=excluded.minutes,days=excluded.days,direction=excluded.direction")
            .run(x.rfc, x.minutes, x.days, x.direction);
        } finally { x.ciec = ''; }
        return json(res, overview());
      }
      if (req.method === 'POST' && url.pathname === '/api/ciec/run') {
        /* Lanzar la descarga por CIEC: la corrida va por su cuenta
           en el servidor (puede pausarse 10 minutos en el captcha)
           y esta llamada devuelve la vista al momento; la pantalla
           sigue la corrida por GET /api/ciec. */
        const x = await body(req);
        const rfc = String(x.rfc || '');
        need(db.prepare('SELECT 1 FROM profiles WHERE rfc=?').get(rfc), 'Ese RFC no tiene perfil en PacoSAT.', 404);
        need(readEfirmaIndex()[rfc]?.access === 'ciec', 'Este RFC no usa el método CIEC: su acceso al SAT es con e.firma.');
        need(satCiecFetch, 'La descarga por CIEC no está activa en esta instalación.', 503);
        const start = String(x.start || ''), end = String(x.end || '');
        need(validDate(start) && validDate(end) && start <= end, 'Elige un rango de fechas válido: primero el día inicial y después el final.');
        need((Date.parse(end) - Date.parse(start)) / DAY <= 365, 'El rango máximo de una descarga por CIEC es de un año: parte el periodo en dos corridas.');
        const direction = ['received', 'issued', 'both'].includes(x.direction) ? x.direction : 'both';
        need(!ciecState()[rfc]?.progress?.running, 'Ya hay una descarga por CIEC en curso para este RFC: espera a que termine.', 409);
        void runCiecAttempt(rfc, { start, end, direction }, now());
        return json(res, { profiles: ciecOverview() });
      }
      if (req.method === 'POST' && url.pathname === '/api/ciec/captcha') {
        /* El gesto de Paco: lo que escribe en la pantalla despierta
           la corrida pausada y el motor lo teclea en el portal.
           El texto no se guarda en ningún sitio: viaja de la
           pantalla a la página del SAT y se olvida. */
        const x = await body(req);
        const rfc = String(x.rfc || '');
        const waiter = ciecCaptchaWaiters.get(rfc);
        need(waiter, 'Ahora mismo ninguna descarga está esperando un captcha para este RFC.', 409);
        const text = String(x.text || '').trim().slice(0, 32);
        need(text, 'Escribe lo que ves en la imagen del captcha.');
        waiter.resolve(text);
        return json(res, { profiles: ciecOverview() });
      }
      if (req.method === 'GET' && url.pathname === '/api/ciec/artifact') {
        /* Artefactos del diario CIEC: la captura o el HTML de la
           página tal como quedó en el punto del fallo. */
        const run = db.prepare('SELECT * FROM ciec_runs WHERE id=?').get(String(url.searchParams.get('run') || ''));
        need(run, 'Esa corrida del diario ya no existe.', 404);
        const part = String(url.searchParams.get('part') || '');
        need(part === 'shot' || part === 'html', 'Parte del diario inválida.');
        const fileId = part === 'shot' ? run.shotId : run.htmlId;
        need(fileId, 'Esa corrida no guardó esa parte del diario.', 404);
        const file = readFileRecord(fileId);
        need(file, 'Ese archivo del diario ya no existe.', 404);
        const stamp = new Date(run.started).toISOString().slice(0, 10);
        const name = 'diario-ciec-' + run.rfc + '-' + stamp + (part === 'shot' ? '-captura.png' : '-pagina.html');
        res.writeHead(200, { 'content-type': file.mime, 'content-disposition': 'attachment; filename="' + name + '"' });
        return res.end(file.buffer);
      }
      if (req.method === 'GET' && url.pathname === '/api/monthly') {
        /* Descarga automática mensual (1.15.0): configuración, las
           últimas corridas con su cuenta y los huecos históricos
           que se ofrecen como recuperación. Como CIEC y Documentos
           del SAT, NO está en las lecturas del invitado. */
        return json(res, monthlyOverview());
      }
      if (req.method === 'POST' && url.pathname === '/api/monthly/config') {
        const x = await body(req);
        const day = Math.floor(Number(x.day)), hour = Math.floor(Number(x.hour));
        need(day >= 1 && day <= 28, 'El día del mes debe estar entre 1 y 28.');
        need(hour >= 0 && hour <= 23, 'La hora debe estar entre 0 y 23.');
        db.prepare("INSERT INTO settings(key,value) VALUES ('monthly-download',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
          .run(JSON.stringify({ enabled: Boolean(x.enabled), day, hour }));
        auditAdmin('Cambió el ajuste de la descarga automática mensual (día ' + day + ' a las ' + hour + ':00, ' +
          (x.enabled ? 'activada' : 'desactivada') + ')');
        return json(res, monthlyOverview());
      }
      if (req.method === 'POST' && url.pathname === '/api/monthly/run-now') {
        /* Lanzar la corrida de un mes cerrado sin esperar al día
           fijado: la misma corrida que la automática crearía, con
           sus mismos frenos (descanso general) y sin duplicar una
           que ya exista para ese mes. */
        const x = await body(req);
        const time = now();
        const month = String(x.month || prevMonthKey(time));
        need(/^\d{4}-\d{2}$/.test(month) && month < mxParts(time).monthKey,
          'Elige un mes ya cerrado (anterior al mes en curso).');
        need(!resting(time), 'PacoSAT está en descanso general: desactívalo para descargar ahora.', 409);
        need(!busy, 'El servicio está en un ciclo de revisión: espera unos segundos y reintenta.', 409);
        const existing = monthlyState().runs?.[month];
        /* Relanzar una corrida «fallida» (1.19.0): hasta aquí un
           mes fallido quedaba condenado — ni el tick lo recrea ni
           «descargar ahora» lo aceptaba — y el fallo real del
           10 nov 2026 (la corrida de octubre murió al pedir, sin
           un solo job) no tenía reintento como corrida. Una
           corrida fallida no completó nada como corrida: se
           sustituye por una nueva del mismo mes, y lo que ya
           hubiera entrado lo descuenta la cobertura (los tramos
           cubiertos no se vuelven a pedir). Las corridas hechas
           o parciales NO se relanzan: su camino es Cobertura. */
        need(!existing || existing.status === 'fallida', existing?.status === 'en-curso' ?
          'La corrida de ' + monthLabel(month) + ' ya está en curso.' :
          'La corrida de ' + monthLabel(month) + ' ya se hizo; su cuenta está en Cobertura.', 409);
        need(db.prepare('SELECT 1 FROM profiles LIMIT 1').get(), 'Todavía no hay ningún RFC configurado.', 409);
        need(!Object.values(monthlyState().runs || {}).some(run => run.status === 'en-curso'),
          'Hay otra corrida mensual en curso: espera a que cierre.', 409);
        busy = true;
        try { await monthlyCreateRun(month, time, false); }
        finally { busy = false; }
        return json(res, monthlyOverview());
      }
      if (req.method === 'POST' && url.pathname === '/api/monthly/recover') {
        /* Recuperación de UN hueco histórico (1.15.0): un mes y un
           sentido, aparte de la corrida mensual — sus jobs llevan
           origen «recovery» en el libro y jamás se pliegan en la
           cuenta del mes automático. Solo pide los tramos que
           ninguna solicitud terminada cubre; si el mes ya está
           cubierto, lo dice sin gastar una solicitud. */
        const x = await body(req);
        const time = now();
        const profile = db.prepare('SELECT * FROM profiles WHERE rfc=?').get(String(x.rfc || ''));
        need(profile, 'Ese RFC no tiene perfil en PacoSAT.', 404);
        const month = String(x.month || '');
        need(/^\d{4}-\d{2}$/.test(month) && month < mxParts(time).monthKey,
          'Elige un mes ya cerrado (anterior al mes en curso).');
        need(['received', 'issued'].includes(x.direction), 'Elige emitidos o recibidos.');
        need(readEfirmaIndex()[profile.rfc]?.access !== 'ciec',
          'Ese RFC baja por CIEC: lánzalo desde su tarjeta indicando ese mes; el portal pedirá tu captcha.', 409);
        need(!resting(time), 'PacoSAT está en descanso general: desactívalo para descargar ahora.', 409);
        need(!profilePaused(profile, time), 'Ese RFC está en descanso: reanúdalo para descargar.', 409);
        const active = unlocked.get(profile.rfc);
        need(active, 'Ese RFC está bloqueado: autoriza su e.firma primero.', 409);
        const ranges = monthUncovered(profile.rfc, x.direction, month);
        if (!ranges.length) return json(res, { ...monthlyOverview(), recovery: { month, direction: x.direction, covered: true, jobs: [] } });
        const sent = await sendMonthRequests(profile, active.connector, x.direction, ranges, 'recovery', time);
        need(sent.jobIds.length || !sent.error, sent.error || 'No se pudo pedir ese mes.', 502);
        return json(res, { ...monthlyOverview(), recovery: { month, direction: x.direction, covered: false, jobs: sent.jobIds, error: sent.error } });
      }
      if (req.method === 'GET' && url.pathname === '/api/files/view') {
        /* Visor en línea de Expedientes (1.10.2): un clic y el PDF
           delante, DENTRO de la app. El fichero se sirve INLINE (su
           content-type y «content-disposition: inline»), no como
           descarga: descargar sigue siendo la opción secundaria del
           propio visor. Solo se sirven documentos archivados —los
           que tienen fila en la tienda 'documents'—: esa fila manda
           el RFC dueño y el nombre que se enseña. Para el invitado
           vale el mismo criterio que el filtro de /api/storage:
           fuera de su alcance por RFC, el documento no existe (404),
           no se filtra ni que exista. */
        const id = String(url.searchParams.get('id') || '');
        const row = db.prepare("SELECT value FROM records WHERE store='documents' AND id=?").get(id);
        let doc = null;
        try { doc = row ? JSON.parse(row.value) : null; } catch { doc = null; }
        need(doc, 'Ese documento no está en Expedientes.', 404);
        if (gScope && !gScope.has(String(doc.rfc || '').toUpperCase()))
          need(false, 'Ese documento no está en Expedientes.', 404);
        const file = readFileRecord(id);
        need(file, 'El archivo de ese documento ya no existe.', 404);
        const name = (String(doc.name || 'documento.pdf').replace(/["\r\n]/g, '').slice(0, 180)) || 'documento.pdf';
        res.writeHead(200, { 'content-type': file.mime, 'content-length': file.buffer.length,
          'content-disposition': 'inline; filename="' + name + '"' });
        return res.end(file.buffer);
      }
      if (req.method === 'POST' && url.pathname === '/api/mail/send') {
        /* Correo desde la app (1.6.16): con adjuntos del expediente o
           generados al momento; todo envío queda en la bitácora. */
        const x = await body(req, 30 * 1024 * 1024);
        need(mail, 'El correo no está configurado en esta instalación.', 409);
        const tos = String(x.to || '').split(/[,;]/).map(item => item.trim()).filter(Boolean);
        need(tos.length && tos.every(item => email.test(item)), 'Revisa los destinatarios.');
        need(typeof x.subject === 'string' && x.subject.trim() && x.subject.length <= 200, 'Escribe el asunto.');
        need(typeof x.text === 'string' && x.text.length <= 20000, 'El mensaje es demasiado largo.');
        const attachments = [];
        for (const item of Array.isArray(x.attachments) ? x.attachments.slice(0, 10) : []) {
          if (item.fileId) {
            const file = readFileRecord(String(item.fileId));
            need(file, 'Un adjunto ya no existe en el expediente.', 404);
            attachments.push({ filename: String(item.filename || item.fileId).slice(0, 120), content: file.buffer });
          } else if (typeof item.content === 'string') {
            const buffer = Buffer.from(item.content, 'base64');
            need(buffer.length <= 15 * 1024 * 1024, 'Un adjunto supera los 15 MB.');
            attachments.push({ filename: String(item.filename || 'adjunto').slice(0, 120), content: buffer });
          }
        }
        const result = await sendAppMail({ to: tos.join(', '), subject: x.subject.trim(), text: x.text, attachments }, 'compose', now());
        return json(res, { ok: true, recipients: result.recipients });
      }
      if (req.method === 'GET' && url.pathname === '/api/mail/log') {
        return json(res, { sends: db.prepare('SELECT * FROM mail_sends ORDER BY id DESC LIMIT 100').all() });
      }
      if (cloud && req.method === 'POST' && url.pathname === '/api/reparse') {
        /* Re-parseo histórico (mejora nº 6): completa el desglose de
           los CFDI viejos desde su XML guardado. Sin contactar al SAT. */
        const Parser = await resolveInboxParser();
        let updated = 0, skipped = 0, failed = 0;
        for (const row of db.prepare("SELECT id,value FROM records WHERE store='invoices'").all()) {
          const invoice = JSON.parse(row.value);
          /* Sin desglose, o complemento de pago aún sin su relación de
             pagos persistida (desglose anterior a la 1.6.17). */
          if (invoice.fiscal && (invoice.kind !== 'P' || invoice.fiscal.payments !== undefined)) { skipped++; continue; }
          const file = readFileRecord('xml:' + invoice.id);
          if (!file) { failed++; continue; }
          try {
            invoice.fiscal = fiscalSummary(parseCfdiFull(file.buffer, Parser));
            db.prepare("UPDATE records SET value=? WHERE store='invoices' AND id=?").run(JSON.stringify(invoice), invoice.id);
            updated++;
          } catch { failed++; }
        }
        if (updated) storageRevision++;
        return json(res, { updated, skipped, failed });
      }
      if (cloud && req.method === 'POST' && url.pathname === '/api/export-full') {
        /* Exportación completa legible: ZIP con XML/PDF por RFC y año
           más el índice — independiente del formato .faro cifrado. */
        const x = await body(req);
        const year = /^\d{4}$/.test(String(x.year || '')) ? String(x.year) : '';
        const entries = [];
        const index = [['UUID', 'Fecha', 'Año', 'Emisor RFC', 'Emisor', 'Receptor RFC', 'Receptor', 'Tipo', 'Total', 'Moneda']];
        let bytes = 0;
        for (const invoice of recordInvoices()) {
          const invoiceYear = String(invoice.date || '').slice(0, 4);
          if (year && invoiceYear !== year) continue;
          index.push([invoice.id, invoice.date, invoiceYear, invoice.from?.rfc, invoice.from?.name, invoice.to?.rfc, invoice.to?.name,
            invoice.kind, invoice.total, invoice.currency || 'MXN']);
          const file = readFileRecord('xml:' + invoice.id);
          if (file) { entries.push({ name: (invoice.from?.rfc || 'sin-rfc') + '/' + invoiceYear + '/' + invoice.id + '.xml', buffer: file.buffer }); bytes += file.buffer.length; }
        }
        try {
          for (const row of db.prepare("SELECT value FROM records WHERE store='documents'").all()) {
            const doc = JSON.parse(row.value);
            const docYear = String(doc.date || '').slice(0, 4);
            if (year && docYear !== year) continue;
            const file = readFileRecord(doc.id);
            if (file) { entries.push({ name: (doc.rfc || 'sin-rfc') + '/' + docYear + '/documentos/' + String(doc.name || doc.id).replace(/[\\/:*?"<>|]/g, '_'), buffer: file.buffer }); bytes += file.buffer.length; }
          }
        } catch { /* sin documentos */ }
        need(bytes <= 200 * 1024 * 1024, 'La exportación supera 200 MB: exporta por año.', 413);
        entries.unshift({ name: 'indice.csv', buffer: Buffer.from(csvText(index)) });
        const buffer = zipStoreBuffers(entries);
        return json(res, { name: 'PacoSAT-exportacion' + (year ? '-' + year : '-completa') + '.zip',
          content: buffer.toString('base64'), files: entries.length - 1 });
      }
      if (req.method === 'GET' && url.pathname === '/api/reports/config') return json(res, reportsConfig());
      if (req.method === 'POST' && url.pathname === '/api/reports/config') {
        const x = await body(req);
        const clean = item => ({ enabled: Boolean(item?.enabled),
          day: Math.min(28, Math.max(1, Math.floor(Number(item?.day) || 3))),
          hour: Math.min(23, Math.max(0, Math.floor(Number(item?.hour) || 0))),
          recipients: String(item?.recipients || '').slice(0, 500) });
        const config = { nora: clean(x.nora), weekly: clean(x.weekly), manofil: clean(x.manofil) };
        db.prepare("INSERT INTO settings(key,value) VALUES ('reports',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
          .run(JSON.stringify(config));
        return json(res, config);
      }
      if (req.method === 'POST' && url.pathname === '/api/reports/send-now') {
        /* Envío inmediato del paquete de un mes (p. ej. el informe a
           Nora a mano): usa los destinatarios configurados. */
        const x = await body(req);
        need(/^\d{4}-\d{2}$/.test(String(x.month || '')), 'Indica el mes (AAAA-MM).');
        const config = reportsConfig();
        const pack = buildMonthlyPackage(x.month, String(x.rfc || '').toUpperCase());
        const result = await sendAppMail({ to: config.nora?.recipients || '', subject: 'PacoSAT · Informe mensual ' + x.month + (pack.counts.rfc ? ' · ' + pack.counts.rfc : ''),
          text: 'Adjunto el paquete del mes ' + x.month + ' generado por PacoSAT (índice, XML, documentos, base DIOT, novedades de listas y PPD).' +
            (pack.counts.rfc ? '\nContribuyente: ' + pack.counts.rfc + ' (solo sus comprobantes y documentos).' : '') +
            '\nCFDI del mes: ' + pack.counts.invoices + ' · Complementos pendientes: ' + pack.counts.pendingComplements +
            ' · Sin identificar en bancos: ' + pack.counts.unmatchedMovements + ' · Cancelaciones: ' + pack.counts.cancelled +
            ' · Faltantes: ' + pack.counts.missing + '.',
          attachments: [{ filename: pack.filename, content: pack.buffer }], rfc: pack.counts.rfc || '' }, 'nora', now());
        return json(res, { ok: true, recipients: result.recipients, counts: pack.counts });
      }
      if (req.method === 'POST' && url.pathname === '/api/reports/send-manofil') {
        /* Envío inmediato del Reporte Mano Fil de un mes (1.16.0):
           genera el PDF y el Excel, guarda el PDF en Expedientes y
           lo manda a los destinatarios del informe automático. */
        const x = await body(req);
        need(/^\d{4}-\d{2}$/.test(String(x.month || '')), 'Indica el mes (AAAA-MM).');
        need(salidaPerfil(MANOFIL_RFC), 'El perfil de Mano Fil (' + MANOFIL_RFC + ') no está en este expediente.', 422);
        const periodo = manofilPeriodoDe({ month: String(x.month) });
        const pdf = reporteManofilPdf(periodo);
        const xlsx = reporteManofilXlsx(periodo);
        const fileId = 'pdf:' + randomUUID();
        tx(db, () => {
          putFile(fileId, pdf, 'application/pdf');
          putMetadata('documents', { id: fileId, rfc: MANOFIL_RFC, kind: 'Reporte Mano Fil',
            date: day(now()), period: String(x.month), name: 'Reporte Mano Fil · ' + manofilMesLargo(String(x.month)) + '.pdf' });
        });
        const config = reportsConfig();
        const result = await sendAppMail({ to: config.manofil?.recipients || '',
          subject: 'PacoSAT · Reporte Mano Fil ' + x.month,
          text: 'Adjunto el Reporte Mano Fil de ' + x.month + ' (PDF y Excel), generado desde PacoSAT y guardado en Expedientes.',
          attachments: [{ filename: 'reporte-manofil-' + x.month + '.pdf', content: pdf },
            { filename: 'reporte-manofil-' + x.month + '.xlsx', content: xlsx }], rfc: MANOFIL_RFC }, 'manofil', now());
        return json(res, { ok: true, recipients: result.recipients, saved: fileId });
      }
      /* Cierre de mes en UN gesto (1.25.0, mejora nº 6): «Generar
         todo» produce los tres artefactos del cierre del mes —
         el paquete de la contadora, el reporte del periodo y el
         ZIP del expediente — y deja cada paso marcado con su
         hora: al volver, los pasos cumplidos salen pre-marcados
         y solo se regenera lo que falte o se pida de nuevo. */
      if (req.method === 'POST' && url.pathname === '/api/reports/generate-all') {
        const x = await body(req);
        const rfc = String(x.rfc || '').toUpperCase();
        need(salidaPerfil(rfc), 'Elige primero el RFC del expediente.', 422);
        need(/^\d{4}-\d{2}$/.test(String(x.month || '')), 'Elige el mes del cierre con formato AAAA-MM.');
        const month = String(x.month);
        const pasos = [];
        const paso = async (id, label, make) => {
          try {
            const out = await make();
            pasos.push({ id, label, ok: true, name: out.name, type: out.type,
              content: out.buffer.toString('base64') });
          } catch (error) { pasos.push({ id, label, ok: false, error: message(error) }); }
        };
        await paso('paquete', 'Paquete de la contadora (índice, XML, DIOT y novedades)', () => {
          /* Acotado al RFC del cierre (H-4.1): el paquete de un
             contribuyente no mezcla los comprobantes de otro. */
          const pack = buildMonthlyPackage(month, rfc);
          return { name: pack.filename, type: 'application/zip', buffer: pack.buffer };
        });
        await paso('reporte', 'Reporte del periodo (PDF de cierre)', () => ({
          name: 'cierre-' + month + '-' + rfc + '.pdf', type: 'application/pdf',
          buffer: salidaPdfPeriodo(rfc, month, true) }));
        await paso('zip', 'ZIP del expediente del mes', () => ({
          name: 'pacosat-cierre-' + month + '-' + rfc + '.zip', type: 'application/zip',
          buffer: salidaZipPaquete({ rfc, monthKey: month, conCierre: true }) }));
        if (pasos.some(item => item.ok)) {
          let last = {};
          try { last = JSON.parse(getState('salidas-last') || '{}'); } catch { /* sin registro */ }
          for (const item of pasos) if (item.ok) last['todo:' + item.id] = now();
          setState('salidas-last', JSON.stringify(last));
          if (pasos.find(item => item.id === 'paquete')?.ok) {
            try {
              const reportsState = JSON.parse(getState('reports-state') || '{}');
              reportsState.noraMonth = month;
              setState('reports-state', JSON.stringify(reportsState));
            } catch { /* la marca es un extra */ }
          }
          setState('cierre-todo:' + rfc + ':' + month, JSON.stringify(
            { at: now(), pasos: pasos.map(item => ({ id: item.id, ok: item.ok })) }));
        }
        return json(res, { ok: pasos.every(item => item.ok), pasos });
      }
      if (req.method === 'GET' && url.pathname === '/api/reports/close-state') {
        const rfc = String(url.searchParams.get('rfc') || '').toUpperCase();
        const month = String(url.searchParams.get('month') || '');
        let cierre = null;
        try { cierre = JSON.parse(getState('cierre-todo:' + rfc + ':' + month) || 'null'); } catch { cierre = null; }
        return json(res, { cierre });
      }
      if (req.method === 'GET' && url.pathname === '/api/selftest') {
        return json(res, selfTest());
      }
      if (req.method === 'GET' && url.pathname === '/api/offline-bundle') {
        return json(res, offlineBundle());
      }
      if (req.method === 'GET' && url.pathname === '/api/access-log') {
        need(!guest, 'Solo el administrador ve la bitácora de accesos.', 403);
        return json(res, { entries: db.prepare('SELECT at,kind,detail FROM access_log ORDER BY rowid DESC LIMIT 200').all() });
      }
      if (req.method === 'GET' && url.pathname === '/api/admin/session') {
        return json(res, { configurado: Boolean(adminAuth),
          activa: adminSessionValid(adminCookie(req)) || adminSessionValid(req.headers['x-pacosat-token']) });
      }
      if (req.method === 'GET' && url.pathname === '/api/guest/config') {
        const config = guestConfig();
        return json(res, { enabled: Boolean(config.enabled), hasPassword: Boolean(config.hash),
          contadora: Boolean(config.contadora),
          /* La sesión actual: si quien pregunta es la invitada
             contadora, su cliente abre en su Vista Nora. */
          sesionContadora: Boolean(guest && config.contadora),
          rfcs: Array.isArray(config.rfcs) ? config.rfcs : [] });
      }
      if (req.method === 'POST' && url.pathname === '/api/guest/config') {
        need(!guest, 'Solo el administrador configura el acceso de invitado.', 403);
        const x = await body(req);
        const config = guestConfig();
        if (x.password) {
          need(String(x.password).length >= 8, 'La contraseña del invitado debe tener al menos 8 caracteres.');
          config.salt = randomBytes(16).toString('hex');
          config.hash = scryptSync(String(x.password), config.salt, 32).toString('hex');
        }
        if (typeof x.enabled === 'boolean') config.enabled = x.enabled;
        /* Vista Nora (1.25.0, AGREGAR 3): el invitado puede ser
           «la contadora» — su sesión abre en su lista del mes,
           de solo lectura. */
        if (typeof x.contadora === 'boolean') config.contadora = x.contadora;
        if (Array.isArray(x.rfcs)) {
          need(x.rfcs.length <= 24, 'Demasiados RFC en el alcance del invitado.');
          config.rfcs = [...new Set(x.rfcs.map(rfc => String(rfc).toUpperCase().trim()).filter(rfc => /^[A-ZÑ&0-9]{12,13}$/.test(rfc)))];
        }
        setState('guest-config', JSON.stringify(config));
        logAccess('guest-config', (config.enabled ? 'Invitado activado' : 'Invitado desactivado') +
          (config.rfcs?.length ? ' · alcance: ' + config.rfcs.join(', ') : ' · sin límite por RFC'));
        return json(res, { enabled: Boolean(config.enabled), hasPassword: Boolean(config.hash),
          contadora: Boolean(config.contadora),
          rfcs: Array.isArray(config.rfcs) ? config.rfcs : [] });
      }
      if (req.method === 'GET' && url.pathname === '/api/banks') {
        return json(res, banksOverview());
      }
      if (req.method === 'GET' && url.pathname === '/api/banks/movements') {
        const rows = db.prepare('SELECT m.id,m.date,m.concept,m.amountCents,s.accountId FROM bank_movements m ' +
          'JOIN bank_statements s ON s.id=m.statementId ORDER BY m.date').all();
        const matched = new Set(db.prepare("SELECT movementId FROM bank_matches WHERE estado='activo'").all().map(row => row.movementId));
        const marked = new Set(db.prepare('SELECT movementId FROM bank_movement_marks').all().map(row => row.movementId));
        return json(res, { movements: rows.map(row => ({ id: row.id, date: row.date, concept: row.concept,
          amount: moneyText(BigInt(row.amountCents)), accountId: row.accountId,
          conciliado: matched.has(row.id), sinFactura: marked.has(row.id) })) });
      }
      if (req.method === 'POST' && url.pathname === '/api/banks/accounts') {
        const x = await body(req);
        if (x.delete) {
          tx(db, () => {
            const statements = db.prepare('SELECT id FROM bank_statements WHERE accountId=?').all(String(x.delete));
            for (const statement of statements) db.prepare('DELETE FROM bank_movements WHERE statementId=?').run(statement.id);
            db.prepare('DELETE FROM bank_statements WHERE accountId=?').run(String(x.delete));
            db.prepare('DELETE FROM bank_accounts WHERE id=?').run(String(x.delete));
          });
          auditAdmin('Borró una cuenta bancaria y sus estados');
          return json(res, banksOverview());
        }
        if (x.id && x.rfc !== undefined) {
          /* Asignar el RFC dueño a una cuenta existente (M1).
             El dueño se valida como en las demás altas de la
             casa (H-7.1, pasada de seguridad de la 1.27.0):
             cadena vacía = quitar el dueño, que es un estado
             legítimo; cualquier otro valor debe tener FORMA de
             RFC (validateRfc) Y perfil en la instalación, como
             exigen el alta de folios y el descubrimiento 22513.
             Antes entraba cualquier cadena de 13 caracteres:
             un dueño inexistente dejaba la cuenta huérfana —
             sus movimientos no entraban en el paquete de
             NINGÚN RFC — y el faltante era silencioso. */
          const rfc = String(x.rfc || '').trim().toUpperCase().slice(0, 13);
          if (rfc) {
            need(validateRfc(rfc).level !== 'structure', 'El RFC no tiene una estructura válida.');
            need(db.prepare('SELECT 1 FROM profiles WHERE rfc=?').get(rfc),
              'Ese RFC no tiene perfil en PacoSAT: primero da de alta al contribuyente.', 404);
          }
          db.prepare('UPDATE bank_accounts SET rfc=? WHERE id=?')
            .run(rfc, String(x.id));
          auditAdmin(rfc ? 'Asignó la cuenta bancaria al RFC ' + rfc : 'Quitó el dueño de una cuenta bancaria', rfc);
          return json(res, banksOverview());
        }
        need(String(x.bank || '').trim().length >= 2, 'Escribe el banco.');
        need(String(x.name || '').trim().length >= 2, 'Ponle un nombre a la cuenta (p. ej. Cuenta principal).');
        const rfcAlta = String(x.rfc || '').trim().toUpperCase().slice(0, 13);
        if (rfcAlta) {
          need(validateRfc(rfcAlta).level !== 'structure', 'El RFC no tiene una estructura válida.');
          need(db.prepare('SELECT 1 FROM profiles WHERE rfc=?').get(rfcAlta),
            'Ese RFC no tiene perfil en PacoSAT: primero da de alta al contribuyente.', 404);
        }
        const id = 'bank-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
        db.prepare('INSERT INTO bank_accounts(id,bank,name,last4,kind,created,rfc) VALUES (?,?,?,?,?,?,?)')
          .run(id, String(x.bank).trim().slice(0, 60), String(x.name).trim().slice(0, 80),
            String(x.last4 || '').replace(/\D/g, '').slice(-4), String(x.kind || '').slice(0, 40), now(),
            rfcAlta);
        auditAdmin('Dio de alta la cuenta bancaria ' + String(x.bank).trim() + ' · ' + String(x.name).trim(), rfcAlta);
        return json(res, banksOverview());
      }
      if (req.method === 'POST' && url.pathname === '/api/banks/statements') {
        const x = await body(req, 16 * 1024 * 1024);
        const account = db.prepare('SELECT * FROM bank_accounts WHERE id=?').get(String(x.accountId || ''));
        need(account, 'La cuenta no existe.');
        need(/^\d{4}-\d{2}$/.test(String(x.month || '')), 'El mes debe ser AAAA-MM.');
        const raw = Buffer.from(String(x.content || ''), 'base64');
        need(raw.length > 100 && raw.subarray(0, 5).toString() === '%PDF-', 'Sube el PDF del estado de cuenta.');
        const text = await extractText(raw);
        const parsed = parseStatementText(text, String(x.month));
        const id = 'stmt-' + account.id + '-' + x.month;
        const fileId = 'bankpdf:' + id;
        putFile(fileId, raw, 'application/pdf');
        tx(db, () => {
          db.prepare('DELETE FROM bank_movements WHERE statementId=?').run(id);
          db.prepare('INSERT INTO bank_statements(id,accountId,month,fileId,openingCents,closingCents,creditsCents,chargesCents,movements,state,detected,created) ' +
            'VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET fileId=excluded.fileId,openingCents=excluded.openingCents,' +
            'closingCents=excluded.closingCents,creditsCents=excluded.creditsCents,chargesCents=excluded.chargesCents,' +
            'movements=excluded.movements,state=excluded.state,detected=excluded.detected,created=excluded.created')
            .run(id, account.id, String(x.month), fileId,
              parsed.opening === null ? null : Number(parsed.opening), parsed.closing === null ? null : Number(parsed.closing),
              parsed.credits === null ? null : Number(parsed.credits), parsed.charges === null ? null : Number(parsed.charges),
              parsed.movements.length, parsed.state, parsed.detected, now());
          const insert = db.prepare('INSERT INTO bank_movements(id,statementId,date,concept,amountCents,balanceCents) VALUES (?,?,?,?,?,?)');
          parsed.movements.forEach((movement, index) => insert.run(id + ':' + index, id, movement.date, movement.concept,
            Number(movement.amountCents), movement.balanceCents === null ? null : Number(movement.balanceCents)));
        });
        /* Al aportar el estado, las solicitudes y faltas del Centro
           que dependían de él se solventan en el acto (criterio 8). */
        avisosSync(now());
        return json(res, banksOverview());
      }
      if (req.method === 'POST' && url.pathname === '/api/banks/statements/confirm') {
        const x = await body(req);
        const statement = db.prepare('SELECT * FROM bank_statements WHERE id=?').get(String(x.id || ''));
        need(statement, 'El estado no existe.');
        const cents = value => { const parsed = moneyToCents(value); need(parsed !== null, 'Importe no válido: ' + value); return Number(parsed); };
        db.prepare('UPDATE bank_statements SET openingCents=?,closingCents=?,creditsCents=?,chargesCents=?,state=? WHERE id=?')
          .run(cents(x.opening), cents(x.closing),
            x.credits === '' || x.credits === undefined ? statement.creditsCents : cents(x.credits),
            x.charges === '' || x.charges === undefined ? statement.chargesCents : cents(x.charges),
            'manual', statement.id);
        return json(res, banksOverview());
      }
      if (req.method === 'POST' && url.pathname === '/api/banks/statements/delete') {
        const x = await body(req);
        tx(db, () => {
          db.prepare('DELETE FROM bank_movements WHERE statementId=?').run(String(x.id || ''));
          db.prepare('DELETE FROM bank_statements WHERE id=?').run(String(x.id || ''));
        });
        return json(res, banksOverview());
      }
      if (req.method === 'GET' && url.pathname === '/api/fiscal/calendar') {
        return json(res, { events: fiscalEvents(now()) });
      }
      /* Calendario exportable (1.25.0, AGREGAR 1): las
         obligaciones como fichero .ics estándar, listo para
         importar en Google Calendar (o en cualquier calendario):
         un evento por vencimiento con su RFC y su fecha, sin
         importes ni datos de comprobantes. */
      if (req.method === 'GET' && url.pathname === '/api/fiscal/calendar.ics') {
        const esc = value => String(value || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;')
          .replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
        const stamp = new Date(now()).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
        const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//PacoSAT//Obligaciones//ES',
          'CALSCALE:GREGORIAN', 'X-WR-CALNAME:PacoSAT · Obligaciones'];
        for (const event of fiscalEvents(now())) {
          const fecha = String(event.date || '').replace(/-/g, '');
          if (!/^\d{8}$/.test(fecha)) continue;
          const uid = 'pacosat-' + createHash('sha256')
            .update((event.rfc || '') + '|' + (event.kind || '') + '|' + event.date + '|' + (event.title || ''))
            .digest('hex').slice(0, 20) + '@pacosat';
          lines.push('BEGIN:VEVENT', 'UID:' + uid, 'DTSTAMP:' + stamp,
            'DTSTART;VALUE=DATE:' + fecha,
            'SUMMARY:' + esc('PacoSAT · ' + (event.title || 'Vencimiento') + (event.rfc ? ' (' + event.rfc + ')' : '')),
            'DESCRIPTION:' + esc('Vencimiento seguido por PacoSAT. El detalle y su estado están en la pantalla Cumplimiento.'),
            'BEGIN:VALARM', 'TRIGGER:-P1D', 'ACTION:DISPLAY', 'DESCRIPTION:Recordatorio PacoSAT', 'END:VALARM',
            'END:VEVENT');
        }
        lines.push('END:VCALENDAR');
        res.writeHead(200, { 'Content-Type': 'text/calendar; charset=utf-8',
          'Content-Disposition': 'attachment; filename="pacosat-obligaciones.ics"' });
        return res.end(lines.join('\r\n'));
      }
      if (req.method === 'GET' && url.pathname === '/api/fiscal/issues') {
        return json(res, { issues: fiscalIssues() });
      }
      if (req.method === 'POST' && url.pathname === '/api/fiscal/events') {
        const x = await body(req);
        let list = [];
        try { list = JSON.parse(getState('fiscal-events') || '[]'); } catch { list = []; }
        if (!Array.isArray(list)) list = [];
        if (x.delete) {
          setState('fiscal-events', JSON.stringify(list.filter(item => item.id !== String(x.delete))));
          return json(res, { ok: true });
        }
        need(String(x.title || '').trim().length >= 3, 'Escribe qué vence (al menos 3 letras).');
        need(/^\d{4}-\d{2}-\d{2}$/.test(String(x.date || '')), 'La fecha debe ser AAAA-MM-DD.');
        const item = { id: Date.now().toString(36), rfc: String(x.rfc || '').toUpperCase(), title: String(x.title).trim().slice(0, 120), date: String(x.date) };
        list.push(item);
        setState('fiscal-events', JSON.stringify(list.slice(-200)));
        return json(res, { ok: true, item });
      }
      if (req.method === 'POST' && url.pathname === '/api/fiscal/defense') {
        const x = await body(req);
        need(/^\d{4}-\d{2}$/.test(String(x.month || '')), 'El periodo debe ser AAAA-MM.');
        const zip = await buildDefensePackage(String(x.month));
        res.writeHead(200, { 'content-type': 'application/zip',
          'content-disposition': 'attachment; filename="paquete-defensa-' + x.month + '.zip"' });
        return res.end(zip);
      }
      if (req.method === 'GET' && url.pathname === '/api/money') {
        /* Saldos y esperadas para la pantalla Dinero (el cliente hace
           el mismo cálculo en modo local). Criterio único de
           canceladas (1.20.0, decisión de Paco del 11 nov): las
           canceladas NO viajan en balances — no suman en por pagar
           ni en por cobrar, como en el PDF de saldos — y viajan
           APARTE en «canceladas» (número e importe total), para su
           línea propia fuera de todo total. */
        const allMoney = moneyBalances();
        let balances = allMoney.filter(item => !item.cancelled && (item.balance > 0n || item.method === 'PPD'));
        let canceladasMoney = allMoney.filter(item => item.cancelled && (item.receivable || item.payable));
        let expected = expectedInvoices(now());
        if (gScope) {
          balances = balances.filter(item => gScope.has(String(item.from?.rfc || '').toUpperCase()) ||
            gScope.has(String(item.to?.rfc || '').toUpperCase()));
          canceladasMoney = canceladasMoney.filter(item => gScope.has(String(item.from?.rfc || '').toUpperCase()) ||
            gScope.has(String(item.to?.rfc || '').toUpperCase()));
          expected = []; /* las esperadas se calculan entre todos los RFC: fuera del alcance */
        }
        /* Folio y vencimiento por fila (1.18.0): el folio sale del
           propio CFDI y el vencimiento del calendario de la
           contraparte (saldoDueKey, la misma regla de los avisos)
           — la pantalla ya no identifica por fragmento de UUID ni
           cuenta la antigüedad desde la fecha de la factura. */
        const cpMapMoney = new Map(db.prepare('SELECT * FROM counterparts').all().map(row => [row.rfc, row]));
        const invByIdMoney = new Map(recordInvoices().map(inv => [inv.id, inv]));
        const paidDetail = moneyPaidDetail();
        const hoyKey = day(now());
        return json(res, { balances: balances.map(item => {
            const cpRfc = item.receivable ? (item.to?.rfc || '') : (item.from?.rfc || '');
            const due = saldoDueKey(item, cpMapMoney.get(cpRfc));
            /* Cada saldo explicado en una línea (1.25.0, mejora
               nº 5): qué falta exactamente — el complemento de
               pago (REP), el pago o la marca — con su importe y
               su vencimiento, sin que Paco tenga que adivinarlo. */
            let falta = '';
            if (item.balance <= 0n) {
              const via = (paidDetail.manual.get(item.id) || 0n) > 0n ? 'marcado como pagado a mano' :
                (paidDetail.rep.get(item.id) || 0n) > 0n ? 'pagado con su complemento enlazado' :
                item.method === 'PUE' ? 'pagado en una sola exhibición (PUE)' : 'sin saldo';
              falta = 'Nada: ya está saldado (' + via + ').';
            } else {
              const verbo = item.receivable ? 'cobrar' : 'pagar';
              const partes = [];
              if (item.paid > 0n) {
                const vias = [];
                if ((paidDetail.rep.get(item.id) || 0n) > 0n) vias.push('$' + moneyShow(paidDetail.rep.get(item.id)) + ' con complemento');
                if ((paidDetail.manual.get(item.id) || 0n) > 0n) vias.push('$' + moneyShow(paidDetail.manual.get(item.id)) + ' marcado a mano');
                partes.push('Van $' + moneyShow(item.paid) + ' de $' + moneyShow(item.total) +
                  (vias.length ? ' (' + vias.join(' · ') + ')' : '') + '.');
              }
              partes.push('Falta por ' + verbo + ' $' + moneyShow(item.balance) + ': ' +
                (item.paid > 0n ? 'falta el complemento del resto o marcar el resto como pagado.' :
                  'no consta complemento de pago (REP) enlazado ni marca de pago.'));
              if (/^\d{4}-\d{2}-\d{2}$/.test(due))
                partes.push(due < hoyKey ? 'Venció el ' + due + '.' : 'Vence el ' + due + '.');
              falta = partes.join(' ');
            }
            return { ...item, total: moneyText(item.total),
              paid: moneyText(item.paid), balance: moneyText(item.balance),
              folio: invByIdMoney.get(item.id) ? folioLabel(invByIdMoney.get(item.id)) : '',
              due, cpRfc, falta };
          }),
          canceladas: { count: canceladasMoney.length,
            total: moneyText(canceladasMoney.reduce((sum, item) => sum + item.total, 0n)) },
          expected });
      }
      /* Previsión del mes (1.25.0, AGREGAR 4): vencimientos,
         recurrencias y pagos fijos, cada línea con su base. */
      if (req.method === 'GET' && url.pathname === '/api/forecast') {
        const month = String(url.searchParams.get('month') || mxParts(now()).monthKey);
        need(/^\d{4}-\d{2}$/.test(month), 'Mes inválido.');
        return json(res, monthForecast(month, now()));
      }
      if (req.method === 'POST' && url.pathname === '/api/money/mark-paid') {
        /* «Marcar como pagado» directo (1.9.0, visor de comprobantes):
           registra el pago manual por el saldo vivo, igual que el
           cierre rápido del Centro de Avisos pero sin pasar por un
           aviso. Queda en manual_payments y alimenta los saldos. */
        const x = await body(req);
        const balance = moneyBalances().find(item => item.id === String(x.uuid || ''));
        need(balance, 'Ese comprobante no está en el expediente.', 404);
        need(!balance.cancelled, 'Ese comprobante consta cancelado: no se debe ni se cobra, y no admite marca de pago.');
        need(balance.balance > 0n, 'Ese comprobante ya no tiene saldo pendiente.');
        const notaFinal = (x.fecha ? String(x.fecha) + ' · ' : '') +
          (String(x.nota || '').trim() || 'Pago marcado desde el Visor de comprobantes (' + day(now()) + ')');
        db.prepare('INSERT INTO manual_payments(uuid,at,nota,importe) VALUES (?,?,?,?) ' +
          'ON CONFLICT(uuid) DO UPDATE SET at=excluded.at,nota=excluded.nota,importe=excluded.importe')
          .run(balance.id, now(), notaFinal.slice(0, 300), moneyText(balance.balance));
        const after = moneyBalances().find(item => item.id === balance.id);
        return json(res, { ok: true, balance: after ? moneyText(after.balance) : '0.00' });
      }
      if (req.method === 'POST' && url.pathname === '/api/money/unmark-paid') {
        /* Deshacer «Marcar pagada» (1.18.0): retira SOLO el pago
           marcado a mano (manual_payments); un pago que consta
           por un complemento (REP) no se toca — ese no se marcó
           aquí y su verdad vive en el propio CFDI. */
        const x = await body(req);
        const uuid = String(x.uuid || '');
        const pago = db.prepare('SELECT uuid FROM manual_payments WHERE uuid=?').get(uuid);
        need(pago, 'Ese comprobante no tiene un pago marcado a mano que deshacer.');
        db.prepare('DELETE FROM manual_payments WHERE uuid=?').run(uuid);
        const after = moneyBalances().find(item => item.id === uuid);
        return json(res, { ok: true, balance: after ? moneyText(after.balance) : '0.00' });
      }
      /* ===== Centro de Avisos (1.7.4): leer, responder, solventar ===== */
      if (req.method === 'GET' && url.pathname === '/api/notices') {
        avisosSync(now());
        const data = avisosOverview();
        if (gScope) {
          const inScope = aviso => !aviso.rfc || gScope.has(String(aviso.rfc).toUpperCase());
          data.avisos = data.avisos.filter(inScope);
          data.historial = data.historial.filter(inScope);
          data.counts = { total: data.avisos.length, mal: 0, falta: 0, necesita: 0, porConfirmar: 0 };
          for (const aviso of data.avisos) { data.counts[aviso.clase] = (data.counts[aviso.clase] || 0) + 1;
            if (aviso.estado === 'por-confirmar') data.counts.porConfirmar++; }
          data.porRfc = {};
          for (const aviso of data.avisos) if (aviso.rfc) data.porRfc[aviso.rfc] = (data.porRfc[aviso.rfc] || 0) + 1;
        }
        return json(res, data);
      }
      if (req.method === 'POST' && url.pathname === '/api/notices/answer') {
        /* Respuesta a un «por confirmar» (criterio 7): «sí» registra
           el pago manual en bitácora y cierra el aviso — desde la
           ronda de correcciones la nota es OPCIONAL: si ya se pagó,
           se cierra con un toque y la bitácora anota sola la fecha,
           que fue manual y el origen. «no» convierte el aviso en
           atraso declarado — con el texto veraz: en PacoSAT no consta
           el pago. */
        const x = await body(req);
        const aviso = db.prepare("SELECT * FROM avisos WHERE id=? AND estado NOT IN ('solventado','descartado')").get(Number(x.id));
        need(aviso, 'Ese aviso ya no está abierto.');
        need(aviso.kind === 'saldo', 'Ese aviso no es de un saldo.');
        need(x.respuesta !== 'no' || aviso.estado === 'por-confirmar', 'Ese aviso ya no está por confirmar.');
        const datos = avisoDatos(aviso);
        if (x.respuesta === 'si') {
          avisoMarkPaid(aviso, String(x.nota || '').trim(), x.fecha ? String(x.fecha) : '', now());
        } else if (x.respuesta === 'no') {
          db.prepare("UPDATE avisos SET estado='abierto',clase='mal',severidad='alta',titulo=?,detalle=?,actualizado=? WHERE id=?")
            .run('Saldo vencido: no consta el pago en PacoSAT',
              'Confirmaste que aún no se ha pagado. En PacoSAT no consta el pago de $' + importeShow(aviso.importe) +
              ' de ' + (aviso.nombre || aviso.contraparte || 'la contraparte') + ' (día de pago: ' + (datos.vence || '—') +
              '). Enlaza el complemento en Dinero, concílialo en Bancos o márcalo pagado a mano cuando se pague.',
              now(), aviso.id);
          avisoLog(aviso.id, 'confirmado-no', 'El usuario confirmó que aún no se ha pagado.', now());
        } else need(false, 'Respuesta inválida.');
        avisosSync(now());
        return json(res, avisosOverview());
      }
      if (req.method === 'POST' && url.pathname === '/api/notices/resolve') {
        /* «Ya lo corregí»: re-comprobación real de la condición. */
        const x = await body(req);
        const aviso = db.prepare("SELECT * FROM avisos WHERE id=? AND estado NOT IN ('solventado','descartado')").get(Number(x.id));
        need(aviso, 'Ese aviso ya no está abierto.');
        const check = avisoRecheck(aviso);
        if (!check.ok) return json(res, { ok: false, falta: check.falta });
        avisoSolve(aviso.ref, check.resolucion, now());
        return json(res, { ok: true, ...avisosOverview() });
      }
      if (req.method === 'POST' && url.pathname === '/api/notices/reopen') {
        /* Deshacer un cierre (1.18.0, Ronda Facilidad): «me
           equivoqué: reabrir aviso». Si el cierre fue un pago
           manual, el pago se retira de manual_payments (Dinero
           vuelve a enseñar el saldo, porque el pago ya no consta)
           y el aviso vuelve a abierto con su motivo en bitácora.
           La sincronización posterior lo re-evalúa como cualquier
           aviso abierto: si el pago consta por otra vía (un
           complemento), se solventará solo con esa verdad. */
        const x = await body(req);
        const aviso = db.prepare("SELECT * FROM avisos WHERE id=? AND estado='solventado'").get(Number(x.id));
        need(aviso, 'Ese aviso no está en el historial de cerrados.');
        const datos = avisoDatos(aviso);
        if (aviso.kind === 'saldo' && datos.uuid) {
          const pago = db.prepare('SELECT uuid FROM manual_payments WHERE uuid=?').get(String(datos.uuid));
          if (pago) db.prepare('DELETE FROM manual_payments WHERE uuid=?').run(String(datos.uuid));
        }
        db.prepare("UPDATE avisos SET estado='abierto',resuelto=NULL,resolucion='',actualizado=? WHERE id=?")
          .run(now(), aviso.id);
        avisoLog(aviso.id, 'reabierto', 'Reabierto por ti: se deshizo el cierre' +
          (aviso.kind === 'saldo' ? ' y se retiró el pago marcado a mano.' : '.'), now());
        avisosSync(now());
        return json(res, avisosOverview());
      }
      if (req.method === 'POST' && url.pathname === '/api/notices/edit-close') {
        /* Editar el cierre ya hecho (1.18.0): la nota y la fecha
           del pago de un aviso solventado a mano, desde su
           historial — conecta por fin el diálogo que la 1.11.0
           dejó preparado sin endpoint. Solo avisos de saldo con
           pago manual vivo: lo demás no tiene cierre que editar. */
        const x = await body(req);
        const aviso = db.prepare("SELECT * FROM avisos WHERE id=? AND estado='solventado'").get(Number(x.id));
        need(aviso, 'Ese aviso no está en el historial de cerrados.');
        need(aviso.kind === 'saldo', 'Ese aviso no es de un saldo: no tiene un pago que editar.');
        const datos = avisoDatos(aviso);
        const pago = datos.uuid ? db.prepare('SELECT * FROM manual_payments WHERE uuid=?').get(String(datos.uuid)) : null;
        need(pago, 'Ese cierre no fue un pago marcado a mano: no hay nota que editar.');
        const notaFinal = (x.fecha ? String(x.fecha) + ' · ' : '') +
          (String(x.nota || '').trim() || 'Pago confirmado sin nota (cierre editado, ' + day(now()) + ')');
        db.prepare('UPDATE manual_payments SET nota=? WHERE uuid=?').run(notaFinal.slice(0, 300), pago.uuid);
        avisoLog(aviso.id, 'cierre-editado', notaFinal, now());
        return json(res, avisosOverview());
      }
      if (req.method === 'GET' && url.pathname === '/api/notices/log') {
        /* La bitácora de UN aviso (1.18.0): qué pasó con este
           aviso, paso a paso — la guarda el servidor desde la
           1.7.4 y la pantalla no la enseñaba. */
        const aviso = db.prepare('SELECT * FROM avisos WHERE id=?').get(Number(url.searchParams.get('id')));
        need(aviso, 'Ese aviso ya no existe.', 404);
        const rows = db.prepare('SELECT at,accion,nota FROM avisos_acciones WHERE aviso=? ORDER BY at ASC, rowid ASC LIMIT 200')
          .all(aviso.id);
        return json(res, { id: aviso.id, titulo: aviso.titulo, log: rows });
      }
      if (req.method === 'POST' && url.pathname === '/api/notices/batch') {
        /* Acciones por lote (ronda de correcciones, 9 nov 2026):
           «pagadas» solo actúa sobre avisos de saldo que admiten pago
           (los demás se saltan y se reportan); «cerrar» solventa sin
           re-comprobación y va al historial; «borrar» DESCARTA: el
           aviso deja de aparecer y los generadores respetan el estado
           (no resucita en la siguiente sincronización). Un lote vacío
           no hace nada. Todo queda en bitácora como operación por
           lote y la respuesta dice aplicados y saltados, con motivo. */
        const x = await body(req);
        need(['pagadas', 'cerrar', 'borrar'].includes(x.accion), 'Acción por lote inválida.');
        const ids = [...new Set((Array.isArray(x.ids) ? x.ids : []).map(Number).filter(Number.isFinite))].slice(0, 200);
        let aplicados = 0;
        const motivos = [];
        for (const id of ids) {
          const aviso = db.prepare("SELECT * FROM avisos WHERE id=? AND estado NOT IN ('solventado','descartado')").get(id);
          if (!aviso) { motivos.push({ id, motivo: 'ya no está abierto' }); continue; }
          if (x.accion === 'pagadas') {
            if (aviso.kind !== 'saldo') { motivos.push({ id, motivo: 'no es un aviso de saldo' }); continue; }
            avisoMarkPaid(aviso, '', '', now(), true);
          } else if (x.accion === 'cerrar') {
            avisoLog(aviso.id, 'cerrado-lote', 'Cerrado en lote desde el Centro de Avisos.', now());
            avisoSolve(aviso.ref, 'Cerrado por ti en lote (sin re-comprobación).', now());
          } else {
            db.prepare("UPDATE avisos SET estado='descartado',actualizado=? WHERE id=?").run(now(), aviso.id);
            avisoLog(aviso.id, 'descartado-lote', 'Descartado en lote desde el Centro de Avisos.', now());
          }
          aplicados++;
        }
        avisosSync(now());
        return json(res, { aplicados, saltados: motivos.length, motivos, ...avisosOverview() });
      }
      if (req.method === 'POST' && url.pathname === '/api/notices/config') {
        const x = await body(req);
        need(['diario', 'semanal', 'graves', 'no'].includes(x.correo), 'Cadencia de resumen inválida.');
        const hora = Math.floor(Number(x.hora));
        need(hora >= 0 && hora <= 23, 'La hora debe ser entre 0 y 23.');
        setSetting('avisos', JSON.stringify({ correo: x.correo, hora }));
        return json(res, avisosConfig());
      }
      if (req.method === 'POST' && url.pathname === '/api/notices/responsable') {
        /* Responsable del aviso (1.9.0): quién lo resuelve — Paco o
           la contadora — queda registrado y en bitácora. */
        const x = await body(req);
        const aviso = db.prepare("SELECT * FROM avisos WHERE id=? AND estado NOT IN ('solventado','descartado')").get(Number(x.id));
        need(aviso, 'Ese aviso ya no está abierto.');
        need(['Paco', 'Contadora'].includes(x.responsable), 'Responsable inválido: Paco o Contadora.');
        db.prepare('UPDATE avisos SET responsable=?,actualizado=? WHERE id=?').run(x.responsable, now(), aviso.id);
        avisoLog(aviso.id, 'responsable', 'Responsable asignado: ' + x.responsable, now());
        avisosSync(now());
        return json(res, avisosOverview());
      }
      if (req.method === 'GET' && url.pathname === '/api/reconcile') {
        return json(res, reconcileOverview());
      }
      if (req.method === 'POST' && url.pathname === '/api/reconcile/confirm') {
        /* Confirmar una propuesta (o un vínculo armado a mano): la
           decisión queda registrada con su porqué y se puede deshacer. */
        const x = await body(req);
        const movement = db.prepare('SELECT * FROM bank_movements WHERE id=?').get(String(x.movementId || ''));
        need(movement, 'Ese movimiento ya no existe.', 404);
        need(!db.prepare("SELECT 1 AS x FROM bank_matches WHERE movementId=? AND estado='activo'").get(movement.id),
          'Ese movimiento ya está conciliado: deshaz primero el vínculo actual.');
        const invoicesIn = (Array.isArray(x.invoices) ? x.invoices : []).slice(0, 20)
          .map(inv => ({ uuid: String(inv.uuid || ''), amountCents: Math.round(Number(inv.amountCents) || 0) }));
        need(invoicesIn.length && invoicesIn.every(inv => inv.uuid && inv.amountCents > 0), 'El vínculo no trae facturas válidas.');
        const known = new Set(recordInvoices().map(invoice => invoice.id));
        need(invoicesIn.every(inv => known.has(inv.uuid)), 'Una de las facturas del vínculo no está en el expediente.');
        const total = invoicesIn.reduce((sum, inv) => sum + inv.amountCents, 0);
        db.prepare('INSERT INTO bank_matches(id,movementId,invoices,mode,amountCents,why,estado,created) VALUES (?,?,?,?,?,?,?,?)')
          .run(randomUUID(), movement.id, JSON.stringify(invoicesIn),
            ['total', 'parcial', 'multiple', 'complemento', 'manual'].includes(x.mode) ? x.mode : 'manual',
            total, String(x.why || 'Vínculo confirmado por ti.').slice(0, 300), 'activo', now());
        return json(res, reconcileOverview());
      }
      if (req.method === 'POST' && url.pathname === '/api/reconcile/undo') {
        const x = await body(req);
        const match = db.prepare("SELECT * FROM bank_matches WHERE id=? AND estado='activo'").get(String(x.matchId || ''));
        need(match, 'Ese vínculo ya no está activo.');
        db.prepare("UPDATE bank_matches SET estado='deshecho',undone=? WHERE id=?").run(now(), match.id);
        return json(res, reconcileOverview());
      }
      if (req.method === 'POST' && url.pathname === '/api/reconcile/ignore') {
        /* «Sin factura legítimo»: el movimiento sale de los sin
           identificar del cierre, con su nota, sin fingir vínculo. */
        const x = await body(req);
        const movement = db.prepare('SELECT * FROM bank_movements WHERE id=?').get(String(x.movementId || ''));
        need(movement, 'Ese movimiento ya no existe.', 404);
        db.prepare("INSERT INTO bank_movement_marks(movementId,estado,nota,at) VALUES (?,'sin-factura',?,?) " +
          'ON CONFLICT(movementId) DO UPDATE SET estado=excluded.estado,nota=excluded.nota,at=excluded.at')
          .run(movement.id, String(x.nota || 'Sin factura (marcado por ti)').slice(0, 300), now());
        return json(res, reconcileOverview());
      }
      if (req.method === 'GET' && url.pathname === '/api/declaraciones') {
        const rfc = String(url.searchParams.get('rfc') || '');
        need(db.prepare('SELECT 1 FROM profiles WHERE rfc=?').get(rfc), 'Ese RFC no tiene perfil en PacoSAT.', 404);
        const ejercicio = Number(url.searchParams.get('ejercicio')) || Number(new Date(now()).toISOString().slice(0, 4));
        return json(res, declaracionesOverview(rfc, ejercicio, now()));
      }
      if (req.method === 'GET' && url.pathname === '/api/declaraciones/runs') {
        /* Diario de corridas de declaraciones (1.23.0, frente A3):
           las últimas corridas del RFC con sus pasos ya parseados.
           Alcance de invitado como en /api/status y /api/money:
           fuera de su alcance, para el invitado no hay corridas. */
        const rfc = String(url.searchParams.get('rfc') || '');
        const limit = Math.max(1, Math.min(100, Number(url.searchParams.get('limit')) || 20));
        if (gScope && rfc && !gScope.has(rfc.toUpperCase())) return json(res, { runs: [] });
        const rows = rfc
          ? db.prepare('SELECT * FROM decl_runs WHERE rfc=? ORDER BY started DESC LIMIT ?').all(rfc, limit)
          : gScope
            ? db.prepare('SELECT * FROM decl_runs ORDER BY started DESC LIMIT ?').all(limit)
              .filter(row => gScope.has(String(row.rfc || '').toUpperCase()))
            : db.prepare('SELECT * FROM decl_runs ORDER BY started DESC LIMIT ?').all(limit);
        return json(res, { runs: rows.map(row => ({ id: row.id, rfc: row.rfc, tipo: row.tipo,
          ejercicio: row.ejercicio, periodo: row.periodo, started: row.started, finished: row.finished,
          ok: Boolean(row.ok), error: row.error, errorKind: row.errorKind || '', origen: row.origen || '',
          hasShot: Boolean(row.shotId), hasHtml: Boolean(row.htmlId),
          steps: (() => { try { return JSON.parse(row.steps || '[]'); } catch { return []; } })(),
          attempts: row.attempts })) });
      }
      if (req.method === 'GET' && url.pathname === '/api/registro') {
        /* Registro unificado (1.28.0, P1): proyección de solo
           lectura sobre los diarios, access_log, activity,
           mail_sends y audit_events. No entra en la lista del
           invitado: es la bitácora del administrador. */
        return json(res, registroOverview({
          rfc: String(url.searchParams.get('rfc') || ''),
          clase: String(url.searchParams.get('clase') || ''),
          limit: Number(url.searchParams.get('limit')) || 300 }));
      }
      if (req.method === 'GET' && url.pathname === '/api/registro/resumen') {
        return json(res, registroResumen(now()));
      }
      if (req.method === 'GET' && url.pathname === '/api/registro/csv') {
        const { items } = registroOverview({
          rfc: String(url.searchParams.get('rfc') || ''),
          clase: String(url.searchParams.get('clase') || ''), limit: 2000 });
        /* Higiene de exportación (corrección H-1.1 de la pasada
           de seguridad de la 1.28.0): una celda cuyo texto empieza
           por =, +, - o @ la interpreta una hoja de cálculo como
           fórmula aunque venga entrecomillada; un apóstrofo
           delante la deja en texto. */
        const celda = value => {
          const texto = String(value ?? '');
          return '"' + (/^[=+\-@]/.test(texto.trimStart()) ? "'" : '') + texto.replaceAll('"', '""') + '"';
        };
        const lines = ['Fecha;Clase;RFC;Origen;Texto'].concat(items.map(item =>
          [new Date(item.at).toISOString(), item.clase, item.rfc,
            item.origen === 'paco' ? 'Paco' : item.origen === 'sistema' ? 'Sistema' : '', item.texto].map(celda).join(';')));
        res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="registro-pacosat.csv"' });
        return res.end('﻿' + lines.join('\r\n'));
      }
      if (req.method === 'GET' && url.pathname === '/api/buzon') {
        /* Buzón (1.23.0, frente B): bandeja del RFC con leído/no
           leído. Alcance de invitado como en /api/money: fuera de
           su alcance, la bandeja sale vacía. */
        const rfc = String(url.searchParams.get('rfc') || '');
        if (gScope && !gScope.has(rfc.toUpperCase())) return json(res, { rfc, items: [], unread: 0 });
        const limitParam = Number(url.searchParams.get('limit'));
        const items = buzonItems(rfc, Number.isFinite(limitParam) && limitParam > 0 ? limitParam : 200);
        return json(res, { rfc, items, unread: items.filter(item => !item.read).length });
      }
      if (req.method === 'POST' && url.pathname === '/api/buzon/read') {
        /* Marcar leído (1.23.0): por claves o todo lo de la bandeja.
           La marca es INSERT OR IGNORE: marcar dos veces no cambia
           la primera fecha de lectura. */
        const x = await body(req);
        const rfc = String(x.rfc || '');
        need(rfc, 'Falta el RFC del buzón.');
        if (gScope && !gScope.has(rfc.toUpperCase())) need(false, 'Ese buzón no forma parte de tu alcance.', 403);
        let keys = [];
        if (x.all === true) keys = buzonItems(rfc).map(item => item.key);
        else if (Array.isArray(x.keys)) keys = x.keys.map(item => String(item || '')).filter(Boolean).slice(0, 500);
        const stamp = now();
        const insertMark = db.prepare('INSERT OR IGNORE INTO buzon_marks(rfc,itemKey,readAt) VALUES (?,?,?)');
        for (const key of keys) insertMark.run(rfc, key, stamp);
        const itemsAfter = buzonItems(rfc);
        return json(res, { ok: true, unread: itemsAfter.filter(item => !item.read).length });
      }
      if (req.method === 'GET' && url.pathname === '/api/buzon/forward-config') {
        /* Reenvío (punto 11): destinos recordados y regla
           automática del RFC. La sugerencia de Mano Fil consta en
           sus documentos (buzón de recepción de Más Facturas) y
           solo se ofrece cuando aún no hay destinos recordados. */
        const rfc = String(url.searchParams.get('rfc') || '').toUpperCase();
        if (gScope && !gScope.has(rfc)) return json(res, { rfc, dests: [], autoTo: '', sugerencia: '' });
        const cfg = forwardConfigFor(rfc);
        return json(res, { rfc, dests: cfg.dests, autoTo: cfg.autoTo,
          sugerencia: cfg.dests.length ? '' : (FORWARD_SUGGESTION[rfc] || '') });
      }
      if (req.method === 'POST' && url.pathname === '/api/buzon/forward-config') {
        /* Fijar o quitar la regla automática del RFC ('' = sin
           regla). Los destinos recordados no se tocan aquí. */
        const x = await body(req);
        const rfc = String(x.rfc || '').toUpperCase();
        need(rfc, 'Falta el RFC.');
        if (gScope && !gScope.has(rfc)) need(false, 'Ese buzón no forma parte de tu alcance.', 403);
        const autoTo = String(x.autoTo || '').trim();
        need(!autoTo || email.test(autoTo), 'La dirección de la regla automática no parece un correo válido.');
        const cfg = forwardConfigFor(rfc);
        cfg.autoTo = autoTo;
        forwardConfigSave(rfc, cfg);
        return json(res, { ok: true, rfc, autoTo });
      }
      if (req.method === 'POST' && url.pathname === '/api/buzon/forward') {
        /* Reenvío manual (punto 11): uno o varios comprobantes
           del RFC a una dirección. Cada comprobante viaja en su
           propio correo con XML y PDF; el destino queda
           recordado para el RFC. */
        const x = await body(req);
        const rfc = String(x.rfc || '').toUpperCase();
        need(rfc, 'Falta el RFC del buzón.');
        if (gScope && !gScope.has(rfc)) need(false, 'Ese buzón no forma parte de tu alcance.', 403);
        const to = String(x.to || '').trim();
        need(email.test(to), 'Escribe una dirección de correo válida.');
        const ids = Array.isArray(x.ids) ? x.ids.map(String).filter(Boolean) : [];
        need(ids.length, 'Elige al menos un comprobante para reenviar.');
        const results = await forwardInvoices({ rfc, ids, to, time: now(), origen: 'manual' });
        forwardRemember(rfc, to);
        const okCount = results.filter(result => result.ok).length;
        return json(res, { ok: okCount > 0, enviados: okCount, resultados: results,
          error: okCount ? '' : (results[0]?.error || 'No se pudo reenviar.') });
      }
      /* ===== Ronda 1.25.0 — rutas nuevas ===== */
      /* Recordatorios de cobro (AGREGAR 5): BORRADORES desde un
         aviso de saldo por cobrar. Nada se envía al crear el
         borrador: el envío es otra ruta y otro toque de Paco, con
         el texto y el destino que él deje en el borrador. */
      if (req.method === 'GET' && url.pathname === '/api/reminders') {
        const rows = db.prepare('SELECT * FROM reminders ORDER BY (estado=\'borrador\') DESC, creado DESC LIMIT 50').all();
        return json(res, { reminders: rows });
      }
      if (req.method === 'POST' && url.pathname === '/api/reminders/draft') {
        const x = await body(req);
        const aviso = db.prepare('SELECT * FROM avisos WHERE ref=?').get(String(x.ref || ''));
        need(aviso, 'Ese aviso ya no está en el Centro de Avisos.', 404);
        need(aviso.kind === 'saldo', 'Los recordatorios nacen de un aviso de saldo por cobrar o por pagar.', 422);
        const datos = avisoDatos(aviso);
        need(datos.direccion === 'cobrar', 'Ese aviso es de un pago vuestro, no de un cobro: no lleva recordatorio al cliente.', 422);
        need(aviso.estado !== 'solventado', 'Ese aviso ya está solventado: no hace falta recordatorio.', 422);
        const balance = moneyBalances().find(item => item.id === datos.uuid);
        const nombre = aviso.nombre || aviso.contraparte || 'cliente';
        const importe = balance ? moneyText(balance.balance) : (aviso.importe || '');
        const fechaFactura = balance ? String(balance.date).slice(0, 10) : '';
        const asunto = 'Recordatorio de pago · Factura ' + (fechaFactura || '') + ' · $' + importe;
        const cuerpo = 'Estimado equipo de ' + nombre + ':\n\n' +
          'Les escribimos para recordarles que la factura del ' + (fechaFactura || '—') +
          ' por $' + importe + ' sigue pendiente de pago' +
          (datos.vence ? ' (su fecha de pago fue el ' + datos.vence + ')' : '') + '.\n' +
          'Si ya realizaron el pago, les agradeceremos compartirnos el comprobante para registrarlo; ' +
          'si está en proceso, esta nota es solo un recordatorio amable.\n\n' +
          'Quedamos atentos.\n' + (aviso.rfc || '');
        const previo = db.prepare("SELECT * FROM reminders WHERE avisoRef=? AND estado='borrador'").get(aviso.ref);
        if (previo) return json(res, { ok: true, reminder: previo, ya: true });
        const row = { id: randomUUID(), avisoRef: aviso.ref, rfc: aviso.rfc || '',
          contraparte: aviso.contraparte || '', nombre: aviso.nombre || '', uuid: datos.uuid || '',
          asunto, cuerpo, destino: String(getSetting('reminder-to:' + (aviso.contraparte || '')) || ''),
          estado: 'borrador', creado: now(), enviado: 0 };
        db.prepare('INSERT INTO reminders(id,avisoRef,rfc,contraparte,nombre,uuid,asunto,cuerpo,destino,estado,creado,enviado) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(row.id, row.avisoRef, row.rfc, row.contraparte, row.nombre, row.uuid,
            row.asunto, row.cuerpo, row.destino, row.estado, row.creado, row.enviado);
        return json(res, { ok: true, reminder: row });
      }
      if (req.method === 'POST' && url.pathname === '/api/reminders/send') {
        const x = await body(req);
        const row = db.prepare('SELECT * FROM reminders WHERE id=?').get(String(x.id || ''));
        need(row, 'Ese borrador ya no existe.', 404);
        need(row.estado === 'borrador', 'Ese recordatorio ya no está en borrador.', 422);
        const destino = String(x.to || row.destino || '').trim();
        need(email.test(destino), 'Escribe el correo del cliente al que va el recordatorio.');
        const asunto = String(x.asunto || row.asunto).slice(0, 200);
        const cuerpo = String(x.cuerpo || row.cuerpo).slice(0, 4000);
        await sendAppMail({ to: destino, subject: asunto, text: cuerpo, rfc: row.rfc || '' }, 'cobro', now());
        db.prepare("UPDATE reminders SET estado='enviado', enviado=?, destino=?, asunto=?, cuerpo=? WHERE id=?")
          .run(now(), destino, asunto, cuerpo, row.id);
        if (row.contraparte) setSetting('reminder-to:' + row.contraparte, destino);
        const avisoRow = db.prepare('SELECT id FROM avisos WHERE ref=?').get(row.avisoRef);
        if (avisoRow) avisoLog(avisoRow.id, 'recordatorio', 'Recordatorio de cobro enviado a ' + destino, now());
        return json(res, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/reminders/discard') {
        const x = await body(req);
        db.prepare("UPDATE reminders SET estado='descartado' WHERE id=? AND estado='borrador'")
          .run(String(x.id || ''));
        return json(res, { ok: true });
      }
      /* Push PWA (AGREGAR 9): la clave pública VAPID, el alta y
         la baja de suscripciones del navegador y una prueba. */
      if (req.method === 'GET' && url.pathname === '/api/push/vapid') {
        return json(res, { key: pushVapid().publicKey,
          suscripciones: db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get().n });
      }
      if (req.method === 'POST' && url.pathname === '/api/push/subscribe') {
        const x = await body(req);
        const endpoint = String(x.endpoint || '');
        need(/^https:\/\//.test(endpoint) && endpoint.length <= 1000, 'La suscripción push no trae un endpoint válido.');
        /* Solo servicios de push reales (1.27.0, B2 de la pasada
           de la 1.25): sin lista, cualquier URL https valía como
           endpoint y el servidor firmaba peticiones VAPID contra
           ella (un SSRF menor con la llave de la casa). Los
           servicios de los navegadores son un conjunto cerrado
           y conocido: FCM (Chrome/Android), Apple, Microsoft y
           Mozilla. */
        let pushHost = '';
        try { pushHost = new URL(endpoint).hostname.toLowerCase(); } catch { pushHost = ''; }
        const pushHostOk = pushHost === 'fcm.googleapis.com' ||
          pushHost === 'web.push.apple.com' || pushHost.endsWith('.push.apple.com') ||
          pushHost.endsWith('.notify.windows.com') || pushHost.endsWith('.push.services.mozilla.com');
        need(pushHostOk, 'Ese endpoint no es de un servicio de notificaciones reconocido (FCM, Apple, Microsoft o Mozilla).');
        need(String(x.keys?.p256dh || '').length >= 40 && String(x.keys?.auth || '').length >= 10,
          'La suscripción push no trae sus claves de cifrado.');
        db.prepare('INSERT INTO push_subscriptions(endpoint,p256dh,auth,creado) VALUES (?,?,?,?) ' +
          'ON CONFLICT(endpoint) DO UPDATE SET p256dh=excluded.p256dh, auth=excluded.auth')
          .run(endpoint, String(x.keys.p256dh), String(x.keys.auth), now());
        return json(res, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/push/unsubscribe') {
        const x = await body(req);
        db.prepare('DELETE FROM push_subscriptions WHERE endpoint=?').run(String(x.endpoint || ''));
        return json(res, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/push/test') {
        const sent = await pushCritico();
        need(sent > 0, 'No hay ningún navegador suscrito todavía: activa los avisos en este dispositivo primero.', 422);
        return json(res, { ok: true, sent });
      }
      /* Puente a Paperless (AGREGAR 2): estado y configuración.
         El token se guarda solo en el servidor y nunca vuelve
         al cliente (la lectura dice si está puesto, no cuál es). */
      if (req.method === 'GET' && url.pathname === '/api/paperless') {
        const config = paperlessConfig();
        const cola = db.prepare('SELECT estado, COUNT(*) AS n FROM paperless_queue GROUP BY estado').all();
        const ultimoError = db.prepare("SELECT error FROM paperless_queue WHERE estado='error' ORDER BY creado DESC LIMIT 1").get();
        return json(res, { enabled: config.enabled, baseUrl: config.baseUrl, tokenSet: Boolean(config.token),
          cola: Object.fromEntries(cola.map(row => [row.estado, row.n])),
          ultimoError: ultimoError?.error || '' });
      }
      if (req.method === 'POST' && url.pathname === '/api/paperless/config') {
        const x = await body(req);
        const baseUrl = String(x.baseUrl || '').replace(/\/+$/, '');
        if (x.enabled) need(/^https?:\/\//.test(baseUrl), 'Escribe la dirección de tu Paperless (http:// o https://…).');
        setSetting('paperless', JSON.stringify({ enabled: Boolean(x.enabled), baseUrl }));
        if (String(x.token || '').trim()) setSetting('paperless-token', String(x.token).trim());
        if (x.enabled) paperlessProcess().catch(() => { /* la cola queda para el ciclo */ });
        return json(res, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/paperless/retry') {
        const ok = await paperlessProcess();
        return json(res, { ok: true, subidos: ok });
      }
      /* Expediente legal por contraparte (AGREGAR 6): el ZIP de
         un clic con CFDI, validaciones y constancias. */
      if (req.method === 'POST' && url.pathname === '/api/salidas/expediente') {
        const x = await body(req);
        const rfc = String(x.rfc || '').toUpperCase();
        need(salidaPerfil(rfc), 'Elige primero el RFC del expediente.', 422);
        const cp = String(x.contraparte || '').toUpperCase();
        need(/^[A-Z0-9]{12,13}$/.test(cp), 'Falta la contraparte del expediente.');
        const buffer = buildCounterpartFile(rfc, cp);
        let last = {};
        try { last = JSON.parse(getState('salidas-last') || '{}'); } catch { /* sin registro */ }
        last['expediente:' + cp] = now();
        setState('salidas-last', JSON.stringify(last));
        return json(res, { name: 'expediente-' + cp + '-' + rfc + '.zip', type: 'application/zip',
          content: buffer.toString('base64') });
      }
      if (req.method === 'POST' && url.pathname === '/api/admin/baseline-close') {
        /* Cierre de línea base por prescripción (1.23.0, frente E):
           primero se enseña la cuenta (dryRun) y solo con
           dryRun=false se ejecuta, en una sola transacción. Lo
           archivado NO se borra: sale de Dinero y de las colas y
           queda en el archivo consultable. Idempotente. */
        const x = await body(req);
        const dryRun = x.dryRun !== false;
        const time = now();
        const corte = prescriptionLiveYear(time);
        const round2 = value => Math.round((Number(value) || 0) * 100) / 100;
        let compCount = 0, compSum = 0, ilegibles = 0;
        const affectedIds = [];
        for (const row of db.prepare("SELECT id,value FROM records WHERE store='invoices' AND archived=0").all()) {
          let parsed;
          try { parsed = JSON.parse(row.value); } catch { ilegibles++; continue; }
          const year = Number(String(parsed?.date || '').slice(0, 4));
          if (!Number.isInteger(year) || year >= corte) continue;
          compCount++; affectedIds.push(row.id);
          const total = parseFloat(parsed?.total); compSum += Number.isFinite(total) ? total : 0;
        }
        const avisoRows = db.prepare("SELECT * FROM avisos WHERE baseline=1 AND kind='saldo' AND estado IN ('abierto','por-confirmar')").all();
        let avisoSum = 0;
        for (const aviso of avisoRows) { const imp = parseFloat(aviso.importe); avisoSum += Number.isFinite(imp) ? imp : 0; }
        const report = { dryRun, corte: { primerEjercicioVivo: corte },
          avisos: { count: avisoRows.length, sum: round2(avisoSum) },
          comprobantes: { count: compCount, sum: round2(compSum), ilegibles }, ejecutado: false };
        if (dryRun) return json(res, report);
        const nota = 'Cierre de línea base (1.23.0): aviso histórico cerrado en bloque por corte de prescripción — ejercicio ≤ ' +
          (corte - 1) + ' ya prescrito (ventana viva desde ' + corte + '). Sin borrar el registro: queda en el archivo.';
        tx(db, () => {
          const archive = db.prepare("UPDATE records SET archived=1 WHERE store='invoices' AND id=? AND archived=0");
          for (const id of affectedIds) archive.run(id);
          const closeAviso = db.prepare("UPDATE avisos SET estado='descartado',resuelto=?,actualizado=?,resolucion=? WHERE id=?");
          const logAccion = db.prepare('INSERT INTO avisos_acciones(aviso,at,accion,nota) VALUES (?,?,?,?)');
          for (const aviso of avisoRows) { closeAviso.run(time, time, nota, aviso.id); logAccion.run(aviso.id, time, 'cierre-linea-base', nota); }
        });
        const restantes = db.prepare("SELECT COUNT(*) AS n FROM avisos WHERE baseline=1 AND kind='saldo' AND estado IN ('abierto','por-confirmar')").get().n;
        return json(res, { ...report, dryRun: false, ejecutado: true, avisosAbiertosBaseline: restantes });
      }
      if (req.method === 'POST' && url.pathname === '/api/declaraciones/upload') {
        /* Fallback asistido (1.23.0, A.2): si la recuperación
           automática no llega, Paco baja el acuse (o la declaración)
           del portal a mano y lo suelta en la app; se archiva con el
           MISMO casado que la descarga automática — tabla
           declaraciones, fuente «manual» — y el mapa lo enseña
           como presentado desde ese momento. */
        const x = await body(req, 22 * 1024 * 1024);
        need(db.prepare('SELECT 1 FROM profiles WHERE rfc=?').get(String(x.rfc || '')), 'Ese RFC no tiene perfil en PacoSAT.', 404);
        need(['mensual', 'anual'].includes(x.tipo), 'Tipo de declaración inválido.');
        need(['acuse', 'declaracion'].includes(x.clase), 'Clase de documento inválida.');
        const ejercicio = Number(x.ejercicio);
        need(Number.isInteger(ejercicio) && ejercicio >= 2015 && ejercicio <= 2100, 'Ejercicio inválido.');
        const periodo = x.tipo === 'anual' ? '' : String(x.periodo || '');
        need(x.tipo === 'anual' || (/^\d{4}-\d{2}$/.test(periodo) && periodo.startsWith(ejercicio + '-')),
          'Indica el mes (periodo) de la declaración mensual.');
        need(typeof x.content === 'string' && x.content.length > 0, 'Falta el archivo PDF.');
        const raw = Buffer.from(x.content, 'base64');
        need(raw.length <= 16 * 1024 * 1024 && raw.subarray(0, 4).toString() === '%PDF', 'El archivo no es un PDF válido de hasta 16 MB.');
        const filed = archiveDeclaracion(String(x.rfc),
          { tipo: x.tipo, clase: x.clase, ejercicio, periodo, fechaPresentacion: '', operacion: '', content: raw },
          now(), 'manual');
        return json(res, { filed, view: declaracionesOverview(String(x.rfc), ejercicio, now()) });
      }
      if (req.method === 'POST' && url.pathname === '/api/declaraciones/run') {
        const x = await body(req);
        need(db.prepare('SELECT 1 FROM profiles WHERE rfc=?').get(String(x.rfc || '')), 'Ese RFC no tiene perfil en PacoSAT.', 404);
        need(['mensual', 'anual'].includes(x.tipo), 'Tipo de declaración inválido.');
        const ejercicio = Number(x.ejercicio);
        need(Number.isInteger(ejercicio) && ejercicio >= 2015 && ejercicio <= 2100, 'Ejercicio inválido.');
        const result = await runDeclaracionesAttempt(String(x.rfc),
          { tipo: x.tipo, ejercicio, periodo: String(x.periodo || '') }, now());
        /* Contrato (1.29.0): waitingExecutor viaja SIEMPRE en el
           resultado — false cuando el motor corrió aquí, true
           cuando el trabajo quedó en cola para el ejecutor. */
        return json(res, { result: { waitingExecutor: false, ...result }, view: declaracionesOverview(String(x.rfc), ejercicio, now()) });
      }
      /* Registro de folios (1.25.0, mejora nº 1): el servicio
         oficial de acuses reimprime POR FOLIO (ficha 77792 del
         PTSC); el folio se apunta aquí — viene en el propio acuse
         y en la constancia de presentación — y su acuse se
         reimprime con «Reimprimir acuse». Sin folio no hay
         reimpresión: PacoSAT no promete un listado por ejercicio
         que el SAT no ofrece en ese servicio. */
      if (req.method === 'POST' && url.pathname === '/api/declaraciones/folios') {
        const x = await body(req);
        const rfc = String(x.rfc || '').toUpperCase();
        need(db.prepare('SELECT 1 FROM profiles WHERE rfc=?').get(rfc), 'Ese RFC no tiene perfil en PacoSAT.', 404);
        const folio = String(x.folio || '').trim();
        need(/^[0-9A-Za-z-]{6,40}$/.test(folio), 'El folio debe tener entre 6 y 40 caracteres (letras, números o guiones), tal como viene en el acuse.');
        const tipo = x.tipo === 'anual' ? 'anual' : 'mensual';
        const ejercicio = Number(x.ejercicio);
        need(Number.isInteger(ejercicio) && ejercicio >= 2015 && ejercicio <= 2100, 'Ejercicio inválido.');
        const periodo = tipo === 'anual' ? '' : String(x.periodo || '');
        if (tipo === 'mensual' && periodo) need(/^\d{4}-\d{2}$/.test(periodo), 'El periodo debe ser AAAA-MM.');
        const existing = db.prepare('SELECT * FROM decl_folios WHERE rfc=? AND folio=?').get(rfc, folio);
        if (existing) {
          db.prepare('UPDATE decl_folios SET tipo=?, ejercicio=?, periodo=?, nota=?, actualizado=? WHERE id=?')
            .run(tipo, ejercicio, periodo || existing.periodo, String(x.nota || '').slice(0, 200), now(), existing.id);
          auditAdmin('Actualizó el folio ' + folio + ' de declaraciones de ' + rfc, rfc);
          return json(res, { ok: true, folio: { ...existing, tipo, ejercicio, periodo: periodo || existing.periodo } });
        }
        const row = { id: randomUUID(), rfc, tipo, ejercicio, periodo, folio, estado: 'pendiente' };
        db.prepare('INSERT INTO decl_folios(id,rfc,tipo,ejercicio,periodo,folio,estado,nota,creado,actualizado) VALUES (?,?,?,?,?,?,?,?,?,?)')
          .run(row.id, rfc, tipo, ejercicio, periodo, folio, 'pendiente', String(x.nota || '').slice(0, 200), now(), now());
        auditAdmin('Anotó a mano el folio ' + folio + ' de declaraciones de ' + rfc, rfc);
        return json(res, { ok: true, folio: row });
      }
      if (req.method === 'POST' && url.pathname === '/api/declaraciones/folios/delete') {
        const x = await body(req);
        const row = db.prepare('SELECT * FROM decl_folios WHERE id=?').get(String(x.id || ''));
        db.prepare('DELETE FROM decl_folios WHERE id=?').run(String(x.id || ''));
        if (row) auditAdmin('Borró el folio ' + row.folio + ' de declaraciones de ' + row.rfc, row.rfc);
        return json(res, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/declaraciones/folio-run') {
        const x = await body(req);
        const row = db.prepare('SELECT * FROM decl_folios WHERE id=?').get(String(x.id || x.folioId || ''));
        need(row, 'Ese folio no está en el registro.', 404);
        need(db.prepare('SELECT 1 FROM profiles WHERE rfc=?').get(row.rfc), 'Ese RFC no tiene perfil en PacoSAT.', 404);
        const result = await runDeclaracionesAttempt(row.rfc,
          { tipo: 'folio', folio: row.folio, tipoDeclaracion: row.tipo,
            ejercicio: row.ejercicio, periodo: row.periodo }, now());
        const after = db.prepare('SELECT * FROM decl_folios WHERE id=?').get(row.id);
        return json(res, { result: { waitingExecutor: false, ...result }, folio: after, view: declaracionesOverview(row.rfc, row.ejercicio, now()) });
      }
      /* Recuperación histórica por año completo (1.25.0,
         AGREGAR 8): un gesto pide TODO el ejercicio — las
         mensuales del año entero y la anual — en dos corridas
         encadenadas con su diario, y la foto del año dice qué
         quedó y qué sigue faltando (con sus folios, si los hay). */
      if (req.method === 'POST' && url.pathname === '/api/declaraciones/recover-year') {
        const x = await body(req);
        const rfc = String(x.rfc || '');
        need(db.prepare('SELECT 1 FROM profiles WHERE rfc=?').get(rfc), 'Ese RFC no tiene perfil en PacoSAT.', 404);
        const ejercicio = Number(x.ejercicio);
        need(Number.isInteger(ejercicio) && ejercicio >= 2015 && ejercicio <= 2100, 'Ejercicio inválido.');
        const mensual = await runDeclaracionesAttempt(rfc, { tipo: 'mensual', ejercicio, periodo: '' }, now());
        const anual = mensual.ok || !mensual.yaEnCurso
          ? await runDeclaracionesAttempt(rfc, { tipo: 'anual', ejercicio, periodo: '' }, now())
          : { ok: false, yaEnCurso: true };
        return json(res, { mensual, anual, view: declaracionesOverview(rfc, ejercicio, now()) });
      }
      /* Descubrimiento de folios (1.27.0, bloque C): la Consulta
         de transacciones del SAT (ficha 22513) enseña los números
         de operación de lo presentado; cada folio nuevo entra en
         el registro y su acuse se reimprime después con el 77792.
         La corrida deja su diario con la página guardada: su
         primera corrida viva es la que confirma la mecánica del
         servicio, que la ficha pública no documenta. */
      if (req.method === 'POST' && url.pathname === '/api/declaraciones/descubrir-folios') {
        const x = await body(req);
        const rfc = String(x.rfc || '');
        need(db.prepare('SELECT 1 FROM profiles WHERE rfc=?').get(rfc), 'Ese RFC no tiene perfil en PacoSAT.', 404);
        const ejercicio = Number(x.ejercicio) || 0;
        need(ejercicio === 0 || (Number.isInteger(ejercicio) && ejercicio >= 2015 && ejercicio <= 2100), 'Ejercicio inválido.');
        const result = await runDeclaracionesAttempt(rfc, { tipo: 'transacciones', ejercicio, periodo: '' }, now());
        return json(res, { result: { waitingExecutor: false, ...result }, view: declaracionesOverview(rfc, ejercicio || Number(new Date(now()).toISOString().slice(0, 4)), now()) });
      }
      if (req.method === 'GET' && url.pathname === '/api/reports/checklist') {
        const month = String(url.searchParams.get('month') || mxParts(now()).monthKey);
        need(/^\d{4}-\d{2}$/.test(month), 'Mes inválido.');
        /* El alcance del invitado sale de su SESIÓN, nunca del
           parámetro (H-4.2); el administrador puede acotar a un
           RFC con ?rfc= o ver la instalación entera sin él. */
        let scope = null;
        if (gScope) scope = [...gScope];
        else if (url.searchParams.get('rfc')) {
          const rfcParam = String(url.searchParams.get('rfc')).toUpperCase();
          if (db.prepare('SELECT 1 FROM profiles WHERE rfc=?').get(rfcParam)) scope = [rfcParam];
        }
        return json(res, monthChecklist(month, now(), scope));
      }
      if (req.method === 'POST' && url.pathname === '/api/pdf-analyze') {
        const { data } = await body(req, 21 * 1024 * 1024);
        need(typeof data === 'string' && data.length <= 20 * 1024 * 1024, 'PDF demasiado grande.');
        try { return json(res, await analyzePdf(Buffer.from(data, 'base64'))); }
        catch (error) { need(false, message(error), error.status || 422); }
      }
      if (cloud && req.method === 'GET' && url.pathname === '/api/storage/rev') {
        return json(res, { rev: recordRev });
      }
      if (cloud && req.method === 'GET' && url.pathname === '/api/storage') {
        const store = url.searchParams.get('store'), id = url.searchParams.get('id');
        need(stores.includes(store), 'Tipo de almacenamiento inválido.');
        /* Sync por diferencias (1.7.0): con ?since=<rev> solo viajan
           los registros nuevos/cambiados y los borrados desde esa
           marca; sin since, la tienda completa de siempre. */
        /* Alcance por RFC del invitado (1.9.0): la tienda se filtra
           en el servidor; fuera de su alcance, un registro no existe. */
        const scopeRows = rows => {
          if (!gScope) return rows;
          const up = value => String(value || '').toUpperCase();
          if (store === 'people') return rows.filter(row => gScope.has(up(row.id)));
          if (store === 'invoices') return rows.filter(row => gScope.has(up(row.from?.rfc)) || gScope.has(up(row.to?.rfc)));
          if (store === 'documents') return rows.filter(row => gScope.has(up(row.rfc)));
          if (store === 'activity') return [];
          if (store === 'files') {
            const invoiceIds = new Set(db.prepare("SELECT id,value FROM records WHERE store='invoices'").all()
              .map(row => { try { return JSON.parse(row.value); } catch { return null; } })
              .filter(row => row && (gScope.has(up(row.from?.rfc)) || gScope.has(up(row.to?.rfc)))).map(row => row.id));
            const docIds = new Set(db.prepare("SELECT id,value FROM records WHERE store='documents'").all()
              .map(row => { try { return JSON.parse(row.value); } catch { return null; } })
              .filter(row => row && gScope.has(up(row.rfc))).map(row => row.id));
            return rows.filter(row => (row.id.startsWith('xml:') && invoiceIds.has(row.id.slice(4))) || docIds.has(row.id));
          }
          return rows;
        };
        const since = url.searchParams.get('since');
        if (id === null && since !== null && /^\d+$/.test(since)) {
          const changed = db.prepare('SELECT id,value,data,mime FROM records WHERE store=? AND rev>?').all(store, Number(since));
          const rows = scopeRows(changed.map(row => row.data ? { id: row.id, mime: row.mime, content: Buffer.from(row.data).toString('base64') } : JSON.parse(row.value)));
          const deleted = db.prepare('SELECT id FROM record_tombstones WHERE store=? AND rev>?').all(store, Number(since)).map(row => row.id);
          return json(res, { rev: recordRev, rows, deleted: gScope && store !== 'people' ? [] :
            gScope ? deleted.filter(rowId => gScope.has(String(rowId).toUpperCase())) : deleted });
        }
        const records = id === null ? db.prepare('SELECT id,value,data,mime FROM records WHERE store=?').all(store) :
          db.prepare('SELECT id,value,data,mime FROM records WHERE store=? AND id=?').all(store,id);
        need(records.reduce((size, item) => size + (item.data?.byteLength || 0), 0) <= 100 * 1024 * 1024,
          'El respaldo supera el límite de 100 MB.', 413);
        const rows = scopeRows(records.map(row => row.data ? { id: row.id, mime: row.mime, content: Buffer.from(row.data).toString('base64') } : JSON.parse(row.value)));
        return json(res, id === null ? rows : rows[0] || null);
      }
      if (cloud && req.method === 'POST' && url.pathname === '/api/storage') {
        const { batch, replace } = await body(req, 150 * 1024 * 1024);
        need(batch && typeof batch === 'object' && Object.keys(batch).length <= stores.length, 'Lote inválido.');
        tx(db, () => {
          for (const [store, rows] of Object.entries(batch)) {
            need(stores.includes(store) && Array.isArray(rows) && rows.length <= 50000, 'Lote inválido.');
            if (replace === true) {
              const existing = db.prepare('SELECT id FROM records WHERE store=?').all(store);
              const tomb = db.prepare('INSERT INTO record_tombstones(store,id,rev) VALUES (?,?,?)');
              for (const row of existing) tomb.run(store, row.id, nextRev());
              db.prepare('DELETE FROM records WHERE store=?').run(store);
            }
            for (const row of rows) {
              need(typeof row?.id === 'string' && row.id.length <= 220, 'Identificador inválido.');
              if (store === 'files') {
                need(typeof row.content === 'string' && row.content.length <= 20 * 1024 * 1024 &&
                  ['application/pdf','application/xml'].includes(row.mime), 'Archivo inválido.');
                putFile(row.id, Buffer.from(row.content, 'base64'), row.mime);
              } else db.prepare('INSERT INTO records(store,id,value,data,mime,rev) VALUES (?,?,?,NULL,NULL,?) ON CONFLICT(store,id) DO UPDATE SET value=excluded.value,rev=excluded.rev').run(store, row.id, JSON.stringify(row), nextRev());
            }
          }
        });
        storageRevision++;
        return json(res, { ok: true });
      }
      const packageRoute = url.pathname.match(/^\/api\/packages\/(\d+)$/);
      if (packageRoute && req.method === 'GET') {
        const record = db.prepare('SELECT archive FROM packages WHERE id=?').get(Number(packageRoute[1]));
        need(record?.archive, 'Paquete no disponible.', 404);
        res.writeHead(200, { 'Content-Type': 'application/zip' });
        return res.end(record.archive);
      }
      if (packageRoute && req.method === 'POST') {
        await body(req);
        db.prepare('UPDATE packages SET archive=NULL WHERE id=?').run(Number(packageRoute[1]));
        return json(res, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/efirma') {
        /* e.firma desde la app (1.6.12): «Probar y guardar». Se valida
           TODO antes de escribir nada — certificado legible, el RFC del
           certificado coincide con el pedido, caducidad futura y pareja
           .cer/.key/contraseña aceptada por el conector — y solo
           entonces los archivos van a la carpeta protegida del servidor
           y el perfil queda activo y persistente entre reinicios. */
        const x = await body(req);
        const shape = validateRfc(typeof x.rfc === 'string' ? x.rfc : '');
        need(shape.level !== 'structure', shape.error || 'RFC inválido.');
        need(Number.isInteger(x.minutes) && x.minutes >= 60 && x.minutes <= 1440, 'El intervalo debe ser de 60 a 1440 minutos.');
        need(Number.isInteger(x.days) && x.days >= 1 && x.days <= 31, 'El periodo de revisión debe ser de 1 a 31 días.');
        need(['received', 'issued', 'both'].includes(x.direction), 'Elige emitidos o recibidos.');
        need(typeof x.password === 'string' && x.password.length > 0 && x.password.length <= 256, 'Ingresa la contraseña de la e.firma.');
        const certificate = keyData(x.certificate), privateKey = keyData(x.key);
        try {
          const owner = certRfc(certificate);
          need(owner, 'El archivo .cer no se pudo leer como certificado: súbelo de nuevo.');
          need(owner === x.rfc, 'El certificado es del RFC ' + owner + ', no de ' + x.rfc + ': revisa qué e.firma estás subiendo. No se guardó nada.');
          const expires = certExpiryMs(certificate);
          need(expires, 'No se pudo leer la caducidad del certificado. No se guardó nada.');
          need(expires > now(), 'Esta e.firma caducó el ' + day(expires) + ': renuévala en el SAT y sube la nueva. No se guardó nada.');
          let active;
          try { active = await makeConnector({ rfc: x.rfc, certificate, privateKey, password: x.password }); }
          catch (error) { need(false, 'La llave y la contraseña no cuadran con el certificado: ' + message(error) + ' No se guardó nada.', 422); }
          writeEfirmaFiles(x.rfc, certificate, privateKey,
            { password: x.password, minutes: x.minutes, days: x.days, direction: x.direction });
          db.prepare("INSERT INTO profiles(rfc,minutes,days,direction,nextRun,error) VALUES (?,?,?,?,?,?) ON CONFLICT(rfc) DO UPDATE SET minutes=excluded.minutes,days=excluded.days,direction=excluded.direction,error=''")
            .run(x.rfc, x.minutes, x.days, x.direction, 0, '');
          db.prepare('UPDATE profiles SET certExpires=? WHERE rfc=?').run(expires, x.rfc);
          unlocked.set(x.rfc, active);
        } finally { certificate.fill(0); privateKey.fill(0); x.password = ''; }
        return json(res, overview());
      }
      if (req.method === 'POST' && url.pathname === '/api/unlock') {
        const x = await body(req);
        const unlockShape = validateRfc(typeof x.rfc === 'string' ? x.rfc : '');
        need(unlockShape.level !== 'structure', unlockShape.error || 'RFC inválido.');
        need(Number.isInteger(x.minutes) && x.minutes >= 60 && x.minutes <= 1440, 'El intervalo debe ser de 60 a 1440 minutos.');
        need(Number.isInteger(x.days) && x.days >= 1 && x.days <= 31, 'El periodo de revisión debe ser de 1 a 31 días.');
        need(['received', 'issued', 'both'].includes(x.direction), 'Elige emitidos o recibidos.');
        need(typeof x.password === 'string' && x.password.length > 0 && x.password.length <= 256, 'Ingresa la contraseña de la e.firma.');
        const certificate = keyData(x.certificate), privateKey = keyData(x.key);
        const expires = certExpiryMs(certificate);
        let active;
        try { active = await makeConnector({ rfc: x.rfc, certificate, privateKey, password: x.password }); }
        catch (error) { need(false, message(error), 422); }
        finally { certificate.fill(0); privateKey.fill(0); x.password = ''; }
        db.prepare("INSERT INTO profiles(rfc,minutes,days,direction,nextRun,error) VALUES (?,?,?,?,?,?) ON CONFLICT(rfc) DO UPDATE SET minutes=excluded.minutes,days=excluded.days,direction=excluded.direction,error=''")
          .run(x.rfc, x.minutes, x.days, x.direction, 0, '');
        if (expires) db.prepare('UPDATE profiles SET certExpires=? WHERE rfc=?').run(expires, x.rfc);
        unlocked.set(x.rfc, active);
        return json(res, overview());
      }
      if (req.method === 'POST' && url.pathname === '/api/lock') {
        const x = await body(req);
        unlocked.delete(x.rfc);
        return json(res, overview());
      }
      /* Modo descanso por RFC (1.6.10): interruptor y «hasta» en un solo
         gesto. Al pausar se anota desde cuándo; al reanudar, la agenda
         calcula la ventana pendiente desde ese instante (catch-up). */
      if (req.method === 'POST' && url.pathname === '/api/pause') {
        const x = await body(req);
        const profile = db.prepare('SELECT * FROM profiles WHERE rfc=?').get(x.rfc);
        need(profile, 'RFC no configurado.', 404);
        const time = now();
        logAccess('pause', String(x.rfc || '') + ' · ' +
          (x.paused === true ? 'pausado' : Number(x.until) > time ? 'pausado hasta ' + new Date(Number(x.until)).toISOString() : 'reanudado'));
        if (x.paused === true || Number(x.until) > time) {
          if (!profilePaused(profile, time)) setState('pause:since:' + x.rfc, String(time));
          db.prepare('UPDATE profiles SET paused=?,pauseUntil=? WHERE rfc=?')
            .run(x.paused === true && !x.until ? 1 : 0, Number(x.until) > time ? Number(x.until) : 0, x.rfc);
        } else if (x.paused === false || x.until !== undefined) {
          const since = Number(getState('pause:since:' + x.rfc) || 0);
          if (since) { setState('catchup:' + x.rfc, String(since)); setState('pause:since:' + x.rfc, ''); }
          db.prepare("UPDATE profiles SET paused=0,pauseUntil=0,nextRun=0,error='' WHERE rfc=?").run(x.rfc);
        } else need(false, 'Indica paused o until.', 400);
        return json(res, overview());
      }
      /* Descanso general (1.6.10): hasta una fecha (epoch ms) o 0 para
         reactivar todo de inmediato. Al reactivar, cada RFC retoma con
         ventana pendiente desde que empezó el descanso. */
      if (req.method === 'POST' && url.pathname === '/api/rest') {
        const x = await body(req);
        const until = Number(x.until) || 0;
        /* «Sin fecha» (1.27.0, bloque C): el interruptor de un toque
           de la pantalla manda el centinela del año 2100 — hasta la
           1.26 la validación lo RECHAZABA por superar los 366 días
           y el clic moría en silencio, sin guardar nada (la causa
           probada de que «Descansar» no desactivara nada). El
           centinela se acepta y se guarda TAL CUAL: el descanso
           queda activo sin fecha hasta que Paco lo quite; las
           fechas finitas conservan su validación de siempre. */
        const sinFecha = until >= Date.UTC(2099, 0, 1);
        need(until === 0 || sinFecha || (until > now() && until < now() + 366 * DAY), 'Fecha de reactivación inválida.');
        logAccess('rest', until === 0 ? 'reactivar todo' : sinFecha ? 'descanso sin fecha' : 'descanso hasta ' + new Date(until).toISOString());
        if (until) {
          if (!getState('rest:since')) setState('rest:since', String(now()));
          setSetting('restUntil', String(until));
        } else {
          const since = Number(getState('rest:since') || 0);
          setSetting('restUntil', '');
          setState('rest:since', '');
          if (since) for (const profile of db.prepare('SELECT rfc FROM profiles').all())
            if (!getState('catchup:' + profile.rfc)) setState('catchup:' + profile.rfc, String(since));
          db.prepare('UPDATE profiles SET nextRun=0').run();
        }
        return json(res, overview());
      }
      /* Umbral del aviso de silencio (1.6.10): días sin CFDI recibidos
         nuevos antes de avisar; 0 lo desactiva. */
      if (req.method === 'POST' && url.pathname === '/api/silence') {
        const x = await body(req);
        need(Number.isInteger(x.days) && x.days >= 0 && x.days <= 365, 'El umbral debe ser de 0 a 365 días.');
        setSetting('silenceDays', x.days ? String(x.days) : '');
        return json(res, overview());
      }
      if (req.method === 'POST' && url.pathname === '/api/run-now') {
        /* «Descargar ahora» por RFC (UX-06, 1.6.11): fuerza el ciclo de
           ese perfil al momento, con los mismos frenos que el tick: en
           descanso (general o del RFC) o bloqueado no se envía nada. */
        const x = await body(req);
        const profile = db.prepare('SELECT * FROM profiles WHERE rfc=?').get(String(x.rfc || ''));
        need(profile, 'Ese RFC no está configurado en el servidor.', 404);
        need(!resting(), 'PacoSAT está en descanso general: desactívalo para descargar ahora.', 409);
        need(!profilePaused(profile), 'Ese RFC está en descanso: reanúdalo para descargar ahora.', 409);
        need(unlocked.has(profile.rfc), 'Ese RFC está bloqueado: autoriza su e.firma primero.', 409);
        need(!busy, 'El servicio está en un ciclo de revisión: espera unos segundos y reintenta.', 409);
        busy = true;
        try {
          const time = now();
          await runProfileCycle(profile, time);
          await notify(time);
          await sendAlerts(time);
          await sendEventAlerts(time);
          await sendEventDigest(time);
          await sendNewsNotices(time);
        } finally { busy = false; }
        return json(res, overview());
      }
      if (req.method === 'POST' && url.pathname === '/api/mail/test') {
        /* Correo de prueba (UX-09, 1.6.11): la primera verificación del
           SMTP no debe ser un aviso real perdido. */
        await body(req);
        need(mail, 'El correo de avisos no está activo: configúralo primero en el Centro SAT.', 409);
        try {
          await mail.transport.sendMail({ from: displayFrom(mail.from), to: mail.recipient,
            subject: 'PacoSAT · Correo de prueba',
            text: 'Este correo confirma que los avisos de PacoSAT llegan bien a esta dirección.\n' +
              'Si lo recibiste, la configuración de correo funciona y los avisos reales también llegarán.',
            messageId: '<pacosat-prueba-' + Date.now() + '@pacosat.local>' });
        } catch (error) {
          return json(res, { error: 'El servidor de correo rechazó el envío: ' + error.message }, 502);
        }
        return json(res, { ok: true });
      }
      if (cloud && req.method === 'POST' && url.pathname === '/api/data/delete') {
        /* Borrado puntual de registros (UX-07, 1.6.11): mantenimiento de
           cartera con confirmación en la app y asiento en la bitácora (el cliente registra el evento). */
        const x = await body(req);
        need(stores.includes(x.store) && Array.isArray(x.ids) && x.ids.length && x.ids.length <= 500 &&
          x.ids.every(id => typeof id === 'string' && id.length <= 220), 'Borrado inválido.');
        let removed = 0;
        const del = db.prepare('DELETE FROM records WHERE store=? AND id=?');
        const tomb = db.prepare('INSERT INTO record_tombstones(store,id,rev) VALUES (?,?,?)');
        for (const id of x.ids) { removed += del.run(x.store, id).changes; tomb.run(x.store, id, nextRev()); }
        storageRevision++;
        return json(res, { removed, revision: storageRevision });
      }
      if (req.method === 'POST' && url.pathname === '/api/retry') {
        const x = await body(req);
        need(Number.isSafeInteger(x.id) && x.id > 0, 'Solicitud inválida.');
        const job = db.prepare('SELECT * FROM jobs WHERE id=?').get(x.id);
        need(job, 'Solicitud no encontrada.', 404);
        need(unlocked.has(job.rfc), 'Autoriza primero la e.firma de este RFC.');
        need(job.status === 'pending', 'Solo se reintentan consultas pendientes; para solicitudes terminadas crea otro periodo.', 409);
        need(!busy, 'Espera a que termine la sincronización actual.', 409);
        db.prepare('UPDATE jobs SET due=?,error=? WHERE id=?').run(now(), '', job.id);
        return json(res, overview());
      }
      /* Planificador anti-5002 (componente 3): lectura seca del libro —
         NUNCA envía nada —. Dice si el criterio exacto ya consta (y
         entonces la vía es la variante de cierre +1 s, nunca el
         duplicado) y, para un rango CFDI amplio nunca pedido, propone
         explorar primero con Metadatos antes de gastar la solicitud. */
      if (req.method === 'POST' && url.pathname === '/api/plan') {
        const x = await body(req);
        need(unlocked.has(x.rfc), 'Desbloquea la e.firma de este RFC.');
        need(validDate(x.start) && validDate(x.end) && x.start <= x.end && x.end <= day(now()), 'Selecciona un periodo válido hasta hoy.');
        need(['received', 'issued'].includes(x.direction), 'Dirección inválida.');
        need(x.type === undefined || ['cfdi', 'metadata'].includes(x.type), 'Tipo de solicitud inválido.');
        const kind = x.type === 'metadata' ? 'metadata' : 'cfdi';
        const endTime = x.end === day(now()) ? clock.format(now()) : '23:59:59';
        const criteria = { rfc: x.rfc, direction: x.direction, type: kind, emitter: '', receiver: '',
          startAt: x.start + ' 00:00:00', endAt: x.end + ' ' + endTime };
        const info = criteriaInfo(criteria);
        const spanDays = Math.round((Date.parse(x.end) - Date.parse(x.start)) / DAY) + 1;
        let recommendation = 'send', reason = 'Criterio nuevo: esta combinación exacta nunca se ha solicitado.';
        if (info.state === 'ultima') { recommendation = 'variant';
          reason = 'Este criterio ya se pidió una vez: no se repetirá. La variante es el mismo periodo cerrando 1 segundo más tarde.'; }
        else if (info.state === 'agotado') { recommendation = 'variant';
          reason = 'Criterio quemado (5002): solo cabe la variante de cierre +1 segundo o el rescate por el portal.'; }
        else if (info.state === 'rescatado') { recommendation = 'variant';
          reason = 'Este periodo ya se quemó (5002) y se rescató por el portal: los XML ya están en el expediente.'; }
        else if (kind === 'cfdi' && spanDays > 31) { recommendation = 'metadata-first';
          reason = 'Rango amplio (' + spanDays + ' días) nunca pedido: para explorar sin gastar la solicitud de CFDI, ' +
            'pide primero los Metadatos de este rango — ves qué CFDI hay — y descarga después solo lo que falte.'; }
        return json(res, { state: info.state, count: info.count, firstSentAt: info.firstSentAt,
          startAt: criteria.startAt, endAt: criteria.endAt, shiftedEndAt: pacosatShiftSecond(criteria.endAt),
          spanDays, recommendation, reason });
      }
      /* Rescate 5002 asistido (componente 4): prepara la recuperación
         por el portal web del SAT — canal aparte del servicio de
         descarga, con su propio cupo de 2.000 XML al día —: la lista
         exacta de folios pendientes del periodo quemado (de los
         metadatos guardados, descontando los ya descargados) y las
         instrucciones paso a paso. Solo lee; no envía nada al SAT. */
      if (req.method === 'POST' && url.pathname === '/api/rescue') {
        const x = await body(req);
        need(typeof x.rfc === 'string' && x.rfc.length >= 12 && x.rfc.length <= 13, 'RFC inválido.');
        need(['received', 'issued'].includes(x.direction), 'Dirección inválida.');
        const stampOk = value => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value || '');
        need(stampOk(x.startAt) && stampOk(x.endAt) && x.startAt <= x.endAt, 'Periodo inválido.');
        const stampOf = value => String(value || '').replace('T', ' ').slice(0, 19);
        const folios = db.prepare(`SELECT m.uuid,m.emitter,m.receiver,m.issuedAt,m.total,m.status FROM metadata_records m
          WHERE m.rfc=? AND m.direction=? AND NOT EXISTS (SELECT 1 FROM discovered d WHERE d.rfc=m.rfc AND d.uuid=m.uuid)
          ORDER BY m.issuedAt`).all(x.rfc, x.direction)
          .filter(row => { const at = stampOf(row.issuedAt); return at >= x.startAt && at <= x.endAt; });
        return json(res, { rfc: x.rfc, direction: x.direction, startAt: x.startAt, endAt: x.endAt, folios,
          instructions: [
            'Entra al portal del SAT (www.sat.gob.mx) → «Factura electrónica» → «Recupera tus facturas» e inicia sesión con la e.firma o la contraseña (CIEC) de ' + x.rfc + '. Este portal es un canal aparte del servicio de descarga: tiene su propio cupo y no gasta solicitudes.',
            'Elige «Consultar facturas ' + (x.direction === 'received' ? 'recibidas' : 'emitidas') + '» y captura el periodo exacto, con segundos: del ' + x.startAt + ' al ' + x.endAt + '.',
            'Descarga los XML' + (folios.length ? ' de los ' + folios.length + ' folios de la lista de abajo' : ' del periodo') + ' (el portal permite hasta 2.000 XML al día por esta vía).',
            'Guarda los archivos descargados (los XML sueltos o el ZIP del portal) en la carpeta vigilada de PacoSAT: se importan solos y este criterio pasará a marcarse «rescatado» en el libro.',
            'Recuerda qué se quemó: solo esta combinación exacta (RFC, sentido, tipo CFDI y fechas con segundos). Ni el RFC ni la e.firma están quemados: los demás periodos, y este mismo con el cierre 1 segundo más tarde, siguen disponibles.' ] });
      }
      if (req.method === 'POST' && url.pathname === '/api/request') {
        const x = await body(req);
        const active = unlocked.get(x.rfc);
        need(active, 'Desbloquea la e.firma de este RFC.');
        need(validDate(x.start) && validDate(x.end) && x.start <= x.end && x.end <= day(now()), 'Selecciona un periodo válido hasta hoy.');
        need(Date.parse(x.end) - Date.parse(x.start) <= 92 * DAY, 'Selecciona un periodo de hasta 93 días.');
        need(['received', 'issued'].includes(x.direction), 'Dirección inválida.');
        need(x.type === undefined || ['cfdi', 'metadata'].includes(x.type), 'Tipo de solicitud inválido.');
        const kind = x.type === 'metadata' ? 'metadata' : 'cfdi';
        need(!busy, 'PacoSAT está procesando otra solicitud. Intenta en unos segundos.', 409);
        /* Guardia previa anti-5002: se compara el criterio exacto (con
           segundos) contra el libro antes de enviar nada al SAT. Un
           criterio ya usado NO se repite jamás — confirmRepeat quedó
           retirado: ya no se gasta «la última» duplicando —; la única
           vía es la variante de cerrar el periodo más tarde, segundo a
           segundo (shiftEnd = nº de segundos sobre el cierre), que ante
           el SAT es un criterio nuevo y en la práctica no deja entrar
           ningún CFDI extra. shiftStart se mantiene por compatibilidad. */
        const endTime = x.end === day(now()) ? clock.format(now()) : '23:59:59';
        let startAt = x.start + ' 00:00:00';
        if (x.shiftStart === true) startAt = pacosatShiftSecond(startAt);
        let endAt = x.end + ' ' + endTime;
        const endShifts = x.shiftEnd === true ? 1 : Number.isSafeInteger(x.shiftEnd) && x.shiftEnd > 0 ? Math.min(x.shiftEnd, 10) : 0;
        for (let i = 0; i < endShifts; i++) endAt = pacosatShiftSecond(endAt);
        const criteria = { rfc: x.rfc, direction: x.direction, type: kind, emitter: '', receiver: '', startAt, endAt };
        const info = criteriaInfo(criteria);
        if (info.state === 'agotado') throw guardError(info, criteria,
          'Este criterio ya agotó las solicitudes que el SAT admite para esta combinación exacta ' +
          '(error 5002: «Se han agotado las solicitudes de por vida»). Lo quemado es solo esta combinación: ' +
          'ni el RFC, ni la e.firma, ni otras fechas. No se envió nada.');
        if (info.state === 'rescatado') throw guardError(info, criteria,
          'Este periodo ya se quemó ante el SAT (5002) y se rescató por el portal web: los XML recuperados ' +
          'ya están en el expediente. Pedirlo otra vez con el mismo criterio no aporta nada. No se envió nada.');
        if (info.state === 'ultima') throw guardError(info, criteria,
          'Este criterio ya se solicitó el ' + new Date(info.firstSentAt).toISOString().slice(0, 10) +
          ' y PacoSAT no repite criterios exactos: la segunda copia no aporta nada y acercaría el error 5002. ' +
          'La salida es el mismo periodo cerrando 1 segundo más tarde: ante el SAT es un criterio nuevo y en ' +
          'la práctica no entra ningún CFDI extra. No se envió nada.');
        busy = true;
        try {
          const prior = db.prepare("SELECT id FROM jobs WHERE rfc=? AND direction=? AND kind=? AND startAt=? AND endAt=? AND status='pending'")
            .get(x.rfc, x.direction, kind, startAt, endAt);
          need(!prior, 'Ese criterio ya tiene una solicitud en curso.', 409);
          let requestId;
          try {
            requestId = await sendSatRequest(
              () => active.connector.request({ start: x.start, end: endAt.slice(0, 10), startTime: startAt.slice(11), endTime: endAt.slice(11), direction: x.direction,
                ...(kind === 'metadata' ? { type: 'metadata' } : {}) }),
              criteria, 'manual', now());
          } catch (error) {
            /* 5002 en la propia llamada: el criterio quedó aprendido
               como quemado en el libro; se responde con la guardia (409)
               y sus salidas — variante +1 s o rescate — en vez de un
               502 seco que no explica nada. */
            if (!error.guard && (error?.code === 5002 || /5002/.test(message(error))))
              throw guardError(criteriaInfo(criteria), criteria,
                'El SAT rechazó el envío con el error 5002: este criterio exacto ya había agotado sus ' +
                'solicitudes de por vida (el gasto pudo venir de otra aplicación). Quedó marcado «quemado» ' +
                'en el libro. No se envió nada más.');
            throw error;
          }
          db.prepare('INSERT INTO jobs(rfc,direction,kind,periodStart,periodEnd,startAt,endAt,requestId,status,due,created) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
            .run(x.rfc, x.direction, kind, x.start, endAt.slice(0, 10), startAt, endAt, requestId, 'pending', now() + 5 * MIN, now());
        } finally { busy = false; }
        return json(res, overview());
      }
      /* ===== PAGOS AL BANCO (1.10.0) =====
         Catálogo de beneficiarios por RFC y generador de pagos.
         La propuesta cruza los CFDI recibidos del mes con el
         catálogo por RFC del emisor. NO filtra por el saldo de
         Dinero: ese saldo da las PUE por pagadas por definición y
         las facturas de proveedor de Paco son PUE que él paga por
         el banco; se excluye solo lo que él ya marcó pagado a mano
         o lo conciliado contra un movimiento del banco. */
      const payProfile = owner => {
        need(/^[A-ZÑ&0-9]{12,13}$/.test(owner), 'Falta un RFC válido.');
        need(db.prepare('SELECT 1 FROM profiles WHERE rfc=?').get(owner), 'Ese RFC no es un perfil de PacoSAT.', 404);
      };
      const payCatalogList = owner => db.prepare('SELECT payload FROM pay_beneficiaries WHERE rfc=? ORDER BY nombre').all(owner)
        .map(row => { try { return JSON.parse(row.payload); } catch { return null; } }).filter(Boolean);
      if (req.method === 'GET' && url.pathname === '/api/pagos/catalog') {
        const owner = String(url.searchParams.get('rfc') || '').toUpperCase();
        payProfile(owner);
        return json(res, { beneficiaries: payCatalogList(owner) });
      }
      if (req.method === 'POST' && url.pathname === '/api/pagos/catalog') {
        const x = await body(req);
        const owner = String(x.rfc || '').toUpperCase();
        payProfile(owner);
        if (x.action === 'seed') {
          let inserted = 0;
          if (owner === MANOFIL_SEED_RFC) {
            const existing = new Set(payCatalogList(owner).map(ben => ben.contraparte));
            for (const seedBen of MANOFIL_SEED) {
              if (existing.has(seedBen.contraparte)) continue;
              const ben = { ...normalizarBeneficiario(seedBen), id: randomUUID() };
              db.prepare('INSERT INTO pay_beneficiaries(id,rfc,nombre,payload,created,updated) VALUES (?,?,?,?,?,?)')
                .run(ben.id, owner, ben.nombre, JSON.stringify(ben), now(), now());
              inserted++;
            }
          }
          return json(res, { beneficiaries: payCatalogList(owner), inserted });
        }
        if (x.action === 'delete') {
          need(x.id, 'Falta el beneficiario a borrar.');
          db.prepare('DELETE FROM pay_beneficiaries WHERE rfc=? AND id=?').run(owner, String(x.id));
          return json(res, { beneficiaries: payCatalogList(owner) });
        }
        let ben;
        try { ben = normalizarBeneficiario(x.beneficiary || {}); }
        catch (error) { need(false, error.message, 422); }
        const id = String((x.beneficiary && x.beneficiary.id) || randomUUID());
        ben = { ...ben, id };
        if (db.prepare('SELECT id FROM pay_beneficiaries WHERE rfc=? AND id=?').get(owner, id))
          db.prepare('UPDATE pay_beneficiaries SET nombre=?, payload=?, updated=? WHERE rfc=? AND id=?')
            .run(ben.nombre, JSON.stringify(ben), now(), owner, id);
        else db.prepare('INSERT INTO pay_beneficiaries(id,rfc,nombre,payload,created,updated) VALUES (?,?,?,?,?,?)')
          .run(id, owner, ben.nombre, JSON.stringify(ben), now(), now());
        return json(res, { beneficiaries: payCatalogList(owner) });
      }
      /* ===== Salidas diseñadas (1.14.0) =====
         Cuatro caminos, todos POST y solo administrador (los
         invitados quedan fuera por la lista de invitados): el
         comprobante a la carta, el ZIP ordenado, el PDF de papel y
         el Excel real. El servidor construye el artefacto completo;
         el cliente solo lo descarga. */
      if (req.method === 'GET' && url.pathname === '/api/salidas/last') {
        /* Última generación de cada salida (1.18.0): las tarjetas
           por destino de la pantalla enseñan «generado el …» sin
           adivinar — el registro lo escribe cada ruta al generar. */
        let last = {};
        try { last = JSON.parse(getState('salidas-last') || '{}'); } catch { /* sin registro */ }
        return json(res, { last });
      }
      if (req.method === 'POST' && url.pathname.startsWith('/api/salidas/')) {
        const x = await body(req);
        const enviar = (name, buffer, type) => json(res, { name, type, content: buffer.toString('base64') });
        const salidaMark = key => { let last = {};
          try { last = JSON.parse(getState('salidas-last') || '{}'); } catch { /* sin registro */ }
          last[key] = now(); setState('salidas-last', JSON.stringify(last)); };
        const mesValido = value => /^\d{4}-\d{2}$/.test(String(value || ''));
        if (url.pathname === '/api/salidas/cfdi') {
          const invoice = recordInvoices().find(item => item.id === String(x.id || ''));
          need(invoice, 'No encontré ese comprobante en el expediente.', 404);
          const owner = String(x.rfc || invoice.from?.rfc || '').toUpperCase();
          const format = String(x.format || 'pdf');
          const nombre = salidaNombreArchivo(invoice, owner);
          const xmlRecord = readFileRecord('xml:' + invoice.id);
          if (format === 'xml') {
            need(xmlRecord?.buffer, 'Este comprobante no tiene XML guardado en el expediente.', 404);
            salidaMark('cfdi:xml');
            return enviar(nombre + '.xml', xmlRecord.buffer, 'application/xml');
          }
          const pdf = await salidaCfdiPdf(invoice, owner);
          need(pdf, 'No pude construir el PDF de este comprobante: falta su XML guardado o no se pudo leer.', 422);
          if (format === 'ambos') {
            need(xmlRecord?.buffer, 'Este comprobante no tiene XML guardado en el expediente.', 404);
            salidaMark('cfdi:ambos');
            return enviar(nombre + '.zip', zipBuffers([
              { name: nombre + '.xml', data: xmlRecord.buffer },
              { name: nombre + '.pdf', data: pdf }]), 'application/zip');
          }
          salidaMark('cfdi:pdf');
          return enviar(nombre + '.pdf', pdf, 'application/pdf');
        }
        if (url.pathname === '/api/salidas/zip') {
          const rfc = String(x.rfc || '').toUpperCase();
          need(salidaPerfil(rfc), 'Elige primero el RFC del expediente.', 422);
          const scope = String(x.scope || 'periodo');
          if (scope === 'seleccion') {
            const ids = Array.isArray(x.ids) ? x.ids.map(String) : [];
            need(ids.length, 'No hay comprobantes seleccionados.', 422);
            salidaMark('zip:seleccion');
            return enviar(`pacosat-seleccion-${rfc}.zip`,
              salidaZipPaquete({ rfc, ids }), 'application/zip');
          }
          if (scope === 'cierre') {
            need(mesValido(x.month), 'Elige el mes del cierre con formato AAAA-MM.', 422);
            salidaMark('zip:cierre');
            /* El paso «Informe a la contadora» del cierre también se
               marca cuando el paquete se genera A MANO (1.18.0):
               antes solo lo marcaba el envío automático por correo
               y la checklist mentía tras una generación manual. */
            try {
              const reportsState = JSON.parse(getState('reports-state') || '{}');
              reportsState.noraMonth = String(x.month);
              setState('reports-state', JSON.stringify(reportsState));
            } catch { /* el paquete sale igual; la marca es un extra */ }
            return enviar(`pacosat-cierre-${x.month}-${rfc}.zip`,
              salidaZipPaquete({ rfc, monthKey: String(x.month), conCierre: true }), 'application/zip');
          }
          if (scope === 'rfc') {
            const year = /^\d{4}$/.test(String(x.year || '')) ? String(x.year) : '';
            salidaMark('zip:rfc');
            return enviar(`pacosat-${rfc}${year ? '-' + year : ''}.zip`,
              salidaZipPaquete({ rfc, year }), 'application/zip');
          }
          need(mesValido(x.month), 'Elige el mes con formato AAAA-MM.', 422);
          salidaMark('zip:periodo');
          return enviar(`pacosat-${x.month}-${rfc}.zip`,
            salidaZipPaquete({ rfc, monthKey: String(x.month) }), 'application/zip');
        }
        if (url.pathname === '/api/salidas/pdf') {
          const kind = String(x.kind || '');
          const rfc = String(x.rfc || '').toUpperCase();
          if (kind === 'saldos') { salidaMark('pdf:saldos');
            return enviar(`saldos-${rfc || 'todos'}.pdf`, salidaPdfSaldos(rfc), 'application/pdf'); }
          need(salidaPerfil(rfc), 'Elige primero el RFC del expediente.', 422);
          if (kind === 'cierre' || kind === 'periodo') {
            need(mesValido(x.month), 'Elige el mes con formato AAAA-MM.', 422);
            salidaMark('pdf:' + kind);
            return enviar(`${kind}-${x.month}-${rfc}.pdf`,
              salidaPdfPeriodo(rfc, String(x.month), kind === 'cierre'), 'application/pdf');
          }
          if (kind === 'contraparte') {
            const cp = String(x.contraparte || '').toUpperCase();
            need(cp, 'Falta la contraparte del reporte.', 422);
            salidaMark('pdf:contraparte');
            return enviar(`contraparte-${cp}-${rfc}.pdf`, salidaPdfContraparte(rfc, cp), 'application/pdf');
          }
          if (kind === 'declaraciones') {
            const ejercicio = /^\d{4}$/.test(String(x.year || '')) ? String(x.year) : String(now()).slice(0, 4);
            salidaMark('pdf:declaraciones');
            return enviar(`declaraciones-${ejercicio}-${rfc}.pdf`,
              salidaPdfDeclaraciones(rfc, ejercicio), 'application/pdf');
          }
          need(false, 'No conozco ese tipo de PDF.', 422);
        }
        if (url.pathname === '/api/salidas/reporte-manofil') {
          /* Reporte Mano Fil (1.16.0, P12): el RFC va FIJO a Mano
             Fil — si piden otro, se dice y no sale nada: este
             informe no mezcla negocios. Periodo por mes o por rango. */
          const pedido = String(x.rfc || MANOFIL_RFC).toUpperCase();
          need(pedido === MANOFIL_RFC, 'El Reporte Mano Fil solo lleva datos de Mano Fil (' + MANOFIL_RFC + '): ningún otro negocio se mezcla en este informe.', 422);
          need(salidaPerfil(MANOFIL_RFC), 'El perfil de Mano Fil (' + MANOFIL_RFC + ') no está en este expediente.', 422);
          const periodo = manofilPeriodoDe(x);
          need(periodo, 'Elige el mes (AAAA-MM) o un rango válido: desde y hasta en formato AAAA-MM-DD, desde no posterior a hasta.', 422);
          if (String(x.format || 'pdf') === 'xlsx') { salidaMark('manofil:xlsx');
            return enviar(`reporte-manofil-${periodo.clave}.xlsx`, reporteManofilXlsx(periodo),
              'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); }
          salidaMark('manofil:pdf');
          return enviar(`reporte-manofil-${periodo.clave}.pdf`, reporteManofilPdf(periodo), 'application/pdf');
        }
        if (url.pathname === '/api/salidas/xlsx') {
          const kind = String(x.kind || '');
          const rfc = String(x.rfc || '').toUpperCase();
          const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
          if (kind === 'listados') { salidaMark('xlsx:listados'); return enviar('listados-contrapartes.xlsx', salidaXlsxListados(), XLSX); }
          need(salidaPerfil(rfc), 'Elige primero el RFC del expediente.', 422);
          if (kind === 'saldos-cobrar') { salidaMark('xlsx:saldos'); return enviar(`saldos-por-cobrar-${rfc}.xlsx`, salidaXlsxSaldos(rfc, 'cobrar'), XLSX); }
          if (kind === 'saldos-pagar') { salidaMark('xlsx:saldos'); return enviar(`saldos-por-pagar-${rfc}.xlsx`, salidaXlsxSaldos(rfc, 'pagar'), XLSX); }
          if (kind === 'complementos') { salidaMark('xlsx:complementos'); return enviar(`complementos-de-pago-${rfc}.xlsx`, salidaXlsxComplementos(rfc), XLSX); }
          if (kind === 'pagos') {
            const libro = salidaXlsxPagos(rfc, String(x.preparationId || ''));
            need(libro, 'Todavía no hay ninguna preparación de pagos guardada para este RFC.', 404);
            salidaMark('xlsx:pagos');
            return enviar(`pagos-al-banco-${rfc}.xlsx`, libro, XLSX);
          }
          const monthKey = mesValido(x.month) ? String(x.month) : '';
          salidaMark('xlsx:facturas');
          /* Nombre de descarga en lenguaje de persona (1.18.0);
             el nombre interno del paquete no cambia. */
          return enviar(`Facturas ${monthKey ? monthLabel(monthKey) : 'completas'} — ${rfc}.xlsx`, salidaXlsxFacturas(rfc, monthKey), XLSX);
        }
        need(false, 'Ruta no encontrada.', 404);
      }
      /* ===== Vencimientos SAT · IMSS · ISN (1.29.0, punto 5) =====
         La tarjeta «Todo pagado» / «Preparar pagos» se alimenta SOLO
         de lo que el expediente ya respalda: las líneas de impuestos
         y cuotas que viven en preparaciones de pago aún NO selladas
         como pagadas. Cada línea trae su importe y su documento de
         respaldo (la propia preparación, con su mes y su fecha).
         Nada se inventa: si el mapa de declaraciones enseña un mes
         sin presentar y no hay importe respaldado, el concepto entra
         en «faltantes» diciendo que su importe NO consta — y con un
         faltante así, la tarjeta no puede decir «Todo pagado».
         El cruce antiduplicado mira los movimientos del banco: mismo
         importe y el mismo organismo o la misma línea de captura en
         el concepto ⇒ la línea sale de los vencimientos y queda
         anotada en «cruces» para que Paco la revise, no se prepara
         dos veces. */
      const taxKindOf = texto => {
        const t = String(texto || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
        if (/\bisn\b|impuesto sobre nomina|nomina estatal/.test(t)) return 'ISN';
        if (/\bimss\b|seguro social|cuotas obrero/.test(t)) return 'IMSS';
        if (/\bsat\b|impuesto|contribuci|declaraci|linea de captura/.test(t)) return 'SAT';
        return '';
      };
      const pagosVencimientos = owner => {
        const hoyIso = new Date(now()).toISOString().slice(0, 10);
        const mesActual = hoyIso.slice(0, 7);
        const manual = new Set(db.prepare('SELECT uuid FROM manual_payments').all().map(row => row.uuid));
        const conciliados = new Set();
        for (const row of db.prepare("SELECT invoices FROM bank_matches WHERE estado='activo'").all())
          try { for (const inv of JSON.parse(row.invoices || '[]')) conciliados.add(inv.uuid); } catch { /* fila ilegible */ }
        const movements = db.prepare('SELECT m.*, s.accountId FROM bank_movements m JOIN bank_statements s ON s.id=m.statementId').all();
        const vencimientos = [], cruces = [], faltantes = [];
        const mesesConLinea = new Set();
        for (const row of db.prepare('SELECT * FROM pay_preparations WHERE rfc=? ORDER BY created DESC').all(owner)) {
          let prep = null;
          try { prep = JSON.parse(row.payload); } catch { prep = null; }
          if (!prep || prep.pagadaEn || prep.reemplazadaPor) continue;
          const lineas = [...(prep.bbva?.lines || []), ...(prep.interbancario?.lines || []), ...(prep.speiIndividual?.lines || [])];
          for (const linea of lineas) {
            const texto = [linea.nombre, linea.motivo, linea.concepto, linea.folio].filter(Boolean).join(' ');
            const organismo = taxKindOf(texto);
            if (!organismo) continue;
            mesesConLinea.add(row.month);
            const captura = (String(linea.folio || '') + ' ' + String(linea.motivo || '')).match(/\d{20,}/)?.[0] || '';
            const base = { organismo, concepto: linea.motivo || linea.nombre || organismo,
              importeCents: Number(linea.totalCents) || 0, lineaCaptura: captura,
              documento: { tipo: 'preparacion', id: row.id, month: row.month, creada: row.created,
                label: 'Preparación de ' + row.month + ' (armada el ' + new Date(row.created).toISOString().slice(0, 10) + ')' },
              linea, preparacionId: row.id };
            if (linea.uuid && (manual.has(linea.uuid) || conciliados.has(linea.uuid))) {
              cruces.push({ ...base, motivo: 'Esa línea ya consta pagada o conciliada contra el banco: no se prepara otra vez.' });
              continue;
            }
            const token = organismo === 'SAT' ? /\bsat\b|impuesto/i : organismo === 'IMSS' ? /imss/i : /isn|nomina estatal/i;
            const movimiento = movements.find(mv => Number(mv.amountCents) < 0 &&
              Math.abs(Number(mv.amountCents)) === base.importeCents &&
              (token.test(String(mv.concept || '')) || (captura && String(mv.concept || '').includes(captura))));
            if (movimiento) {
              cruces.push({ ...base, motivo: 'Hay un movimiento del banco del mismo importe (' + movimiento.date + ' · ' +
                String(movimiento.concept || '').slice(0, 80) + ') que parece este mismo pago: no se prepara otra vez sin que lo revises.' });
              continue;
            }
            const fechaEnTexto = (texto.match(/20\d{2}-\d{2}-\d{2}/) || [''])[0];
            const caducada = Boolean(fechaEnTexto && fechaEnTexto < hoyIso);
            const avisoCaducidad = caducada
              ? 'La línea de captura trae fecha ' + fechaEnTexto + ', anterior a hoy: está caducada; pide una nueva antes de pagar.'
              : (captura && row.month < mesActual)
                ? 'La línea de captura es de ' + row.month + ': puede estar caducada; revísala antes de autorizar.'
                : '';
            vencimientos.push({ ...base, caducada, avisoCaducidad });
          }
        }
        /* Lo que el expediente enseña sin importe: meses sin
           acuse verificado y sin línea respaldada. No se les pone
           importe — no consta — pero impiden un «Todo pagado» falso. */
        try {
          const view = declaracionesOverview(owner, Number(hoyIso.slice(0, 4)), now());
          for (const mes of view.mapa?.meses || []) {
            if (mes.estado !== 'sin-recuperar' && mes.estado !== 'pendiente') continue;
            if (mes.periodo >= mesActual) continue; /* el mes en curso aún no falta */
            if (mesesConLinea.has(mes.periodo)) continue;
            faltantes.push({ organismo: 'SAT', periodo: mes.periodo,
              motivo: 'El mes ' + mes.periodo + ' no consta presentado con acuse verificado y no hay importe ni documento de respaldo en el expediente: cuánto se debe no consta.' });
          }
        } catch { /* sin mapa: los faltantes no se inventan */ }
        return { rfc: owner, todoPagado: vencimientos.length === 0 && faltantes.length === 0,
          vencimientos, cruces, faltantes,
          totalCents: vencimientos.reduce((sum, item) => sum + item.importeCents, 0) };
      };
      if (req.method === 'GET' && url.pathname === '/api/pagos/vencimientos') {
        const owner = String(url.searchParams.get('rfc') || '').toUpperCase();
        payProfile(owner);
        return json(res, pagosVencimientos(owner));
      }
      if (req.method === 'POST' && url.pathname === '/api/pagos/preparar-vencimientos') {
        /* «Preparar pagos» (NUNCA «Pagar todo»): arma UNA
           preparación bancaria nueva con los vencimientos vigentes
           — ya cruzados contra el banco — y la deja en el historial
           lista para autorizar en el banco. No paga nada. */
        const x = await body(req);
        const owner = String(x.rfc || '').toUpperCase();
        payProfile(owner);
        const vista = pagosVencimientos(owner);
        need(vista.vencimientos.length, 'No hay vencimientos con importe respaldado que preparar.', 422);
        const month = String(x.month || vista.vencimientos[0].documento.month || '').slice(0, 7);
        const lines = vista.vencimientos.map(item => ({ ...item.linea,
          total: (item.importeCents / 100).toFixed(2),
          base: ((Number(item.linea.baseCents) || 0) / 100).toFixed(2),
          iva: ((Number(item.linea.ivaCents) || 0) / 100).toFixed(2) }));
        let preparation;
        try {
          preparation = construirPreparacion({ rfc: owner, month,
            group: { descripcion: 'IMPUESTOS Y CUOTAS' }, lines });
        } catch (error) { need(false, error.message, 422); }
        const id = randomUUID();
        db.prepare('INSERT INTO pay_preparations(id,rfc,month,total,operaciones,payload,created) VALUES (?,?,?,?,?,?,?)')
          .run(id, owner, preparation.month, String(preparation.totalCents), preparation.operaciones,
            JSON.stringify(preparation), now());
        /* Las preparaciones de ORIGEN quedan reemplazadas por la
           nueva: sus líneas ya viven en ella, y los vencimientos
           no las cuentan dos veces. No se borran — el historial
           sigue enseñándolas —; solo dejan de alimentar la tarjeta. */
        for (const prepId of [...new Set(vista.vencimientos.map(item => item.preparacionId).filter(Boolean))]) {
          const origen = db.prepare('SELECT payload FROM pay_preparations WHERE id=?').get(prepId);
          if (!origen) continue;
          try {
            const payload = JSON.parse(origen.payload);
            payload.reemplazadaPor = id;
            db.prepare('UPDATE pay_preparations SET payload=? WHERE id=?').run(JSON.stringify(payload), prepId);
          } catch { /* payload ilegible: la preparación nueva manda */ }
        }
        auditAdmin('Preparó los pagos de impuestos y cuotas de ' + owner + ' (' + preparation.operaciones +
          ' operaciones): quedan listos para autorizar en el banco, sin pagar nada.', owner);
        return json(res, { id, preparation, txt: preparacionTxt(preparation), vencimientos: pagosVencimientos(owner) });
      }
      if (req.method === 'GET' && url.pathname === '/api/pagos/proposal') {
        const owner = String(url.searchParams.get('rfc') || '').toUpperCase();
        const month = String(url.searchParams.get('month') || '');
        payProfile(owner);
        need(/^\d{4}-\d{2}$/.test(month), 'Elige el mes con formato AAAA-MM.');
        const catalog = payCatalogList(owner).filter(ben => ben.activo !== 0 && ben.activo !== false);
        const byRfc = new Map();
        for (const ben of catalog) if (!byRfc.has(ben.contraparte)) byRfc.set(ben.contraparte, ben);
        const paidManual = new Set(db.prepare('SELECT uuid FROM manual_payments').all().map(row => row.uuid));
        const matched = new Set();
        for (const row of db.prepare("SELECT invoices FROM bank_matches WHERE estado='activo'").all())
          try { for (const uuid of JSON.parse(row.invoices || '[]')) matched.add(uuid); } catch {}
        const lines = [], sinCatalogo = [];
        for (const invoice of recordInvoices()) {
          if (invoice.kind !== 'I' || invoice.state === 'Cancelado') continue;
          if ((invoice.to?.rfc || '') !== owner) continue;
          if (String(invoice.date || '').slice(0, 7) !== month) continue;
          if (invoice.currency && invoice.currency !== 'MXN') continue;
          if (paidManual.has(invoice.id) || matched.has(invoice.id)) continue;
          const ben = byRfc.get(invoice.from?.rfc || '');
          const ivaRow = (invoice.fiscal?.transferred || []).find(t => t.tax === '002');
          if (!ben) {
            sinCatalogo.push({ uuid: invoice.id, folio: String(invoice.fiscal?.folio || ''),
              emisorRfc: invoice.from?.rfc || '', emisorNombre: invoice.from?.name || '',
              total: moneyText(centsOf(invoice.total)), fecha: invoice.date || '' });
            continue;
          }
          lines.push({ beneficiaryId: ben.id, nombre: ben.nombre, rfc: ben.contraparte, banco: ben.banco,
            grupo: ben.grupo, cuenta: ben.cuenta || '', clabe: ben.clabe || '', motivo: ben.concepto || '',
            folio: String(invoice.fiscal?.folio || ''), uuid: invoice.id, fijo: false,
            base: ivaRow ? moneyText(centsOf(ivaRow.base)) : '', iva: ivaRow ? moneyText(centsOf(ivaRow.amount)) : '',
            total: moneyText(centsOf(invoice.total)) });
        }
        for (const ben of catalog) if (ben.montoTipo === 'fijo')
          lines.push({ beneficiaryId: ben.id, nombre: ben.nombre, rfc: ben.contraparte, banco: ben.banco,
            grupo: ben.grupo, cuenta: ben.cuenta || '', clabe: ben.clabe || '', motivo: ben.concepto || '',
            folio: '', uuid: '', fijo: true, base: ben.base, iva: ben.iva,
            total: moneyText(centsOf(ben.base) + centsOf(ben.iva || '0')) });
        return json(res, { lines, sinCatalogo });
      }
      if (req.method === 'POST' && url.pathname === '/api/pagos/prepare') {
        const x = await body(req);
        const owner = String(x.rfc || '').toUpperCase();
        payProfile(owner);
        let preparation;
        try {
          preparation = construirPreparacion({ rfc: owner, month: String(x.month || ''),
            group: x.group || {}, lines: Array.isArray(x.lines) ? x.lines : [] });
        } catch (error) { need(false, error.message, 422); }
        const id = randomUUID();
        db.prepare('INSERT INTO pay_preparations(id,rfc,month,total,operaciones,payload,created) VALUES (?,?,?,?,?,?,?)')
          .run(id, owner, preparation.month, String(preparation.totalCents), preparation.operaciones,
            JSON.stringify(preparation), now());
        return json(res, { id, preparation, txt: preparacionTxt(preparation) });
      }
      if (req.method === 'GET' && url.pathname === '/api/pagos/preparations') {
        const owner = String(url.searchParams.get('rfc') || '').toUpperCase();
        payProfile(owner);
        const preparations = db.prepare('SELECT id, month, total, operaciones, created, payload FROM pay_preparations WHERE rfc=? ORDER BY created DESC LIMIT 24').all(owner)
          .map(row => { let pagadaEn = 0;
            try { pagadaEn = JSON.parse(row.payload)?.pagadaEn || 0; } catch { /* payload ilegible */ }
            return { id: row.id, month: row.month, totalCents: Number(row.total), operaciones: row.operaciones, created: row.created, pagadaEn }; });
        return json(res, { preparations });
      }
      if (req.method === 'GET' && url.pathname === '/api/pagos/preparation') {
        /* Reabrir una preparación guardada (1.18.0): el detalle
           completo vive en pay_preparations desde la 1.10.0, pero
           ninguna pantalla lo pedía: la preparación «moría» al
           recargar. Ahora el historial la reabre tal cual se armó. */
        const owner = String(url.searchParams.get('rfc') || '').toUpperCase();
        payProfile(owner);
        const row = db.prepare('SELECT * FROM pay_preparations WHERE rfc=? AND id=?').get(owner, String(url.searchParams.get('id') || ''));
        need(row, 'Esa preparación ya no está guardada.', 404);
        let preparation = null;
        try { preparation = JSON.parse(row.payload); } catch { /* payload ilegible */ }
        need(preparation, 'Esa preparación guardada no se puede leer.', 422);
        return json(res, { id: row.id, created: row.created, preparation, txt: preparacionTxt(preparation) });
      }
      if (req.method === 'POST' && url.pathname === '/api/pagos/preparations/paid') {
        /* «Ya pagué esto en el banco» (1.18.0): cierra el ciclo —
           cada línea con factura queda marcada como pagada a mano
           por su saldo vivo, Dinero se entera al momento y la
           preparación queda sellada con su fecha de pago. Lo ya
           pagado por otra vía se salta y se cuenta, no se duplica. */
        const x = await body(req);
        const owner = String(x.rfc || '').toUpperCase();
        payProfile(owner);
        const row = db.prepare('SELECT * FROM pay_preparations WHERE rfc=? AND id=?').get(owner, String(x.id || ''));
        need(row, 'Esa preparación ya no está guardada.', 404);
        let preparation = null;
        try { preparation = JSON.parse(row.payload); } catch { /* payload ilegible */ }
        need(preparation, 'Esa preparación guardada no se puede leer.', 422);
        need(!preparation.pagadaEn, 'Esta preparación ya quedó marcada como pagada en el banco.', 422);
        const nota = 'Pagado en el banco · preparación de ' + (preparation.month || row.month) + ' (' + day(now()) + ')';
        let marcadas = 0, yaEstaban = 0;
        const lineas = [...(preparation.bbva?.lines || []), ...(preparation.interbancario?.lines || []),
          ...(preparation.speiIndividual?.lines || [])];
        for (const linea of lineas) {
          const uuid = String(linea.uuid || '');
          if (uuid.length !== 36) continue;
          if (db.prepare('SELECT 1 FROM manual_payments WHERE uuid=?').get(uuid)) { yaEstaban++; continue; }
          const balance = moneyBalances().find(item => item.id === uuid);
          if (!balance || balance.balance <= 0n || balance.cancelled) { yaEstaban++; continue; }
          db.prepare('INSERT INTO manual_payments(uuid,at,nota,importe) VALUES (?,?,?,?)').run(uuid, now(), nota, moneyText(balance.balance));
          marcadas++;
        }
        preparation.pagadaEn = now();
        preparation.pagoResumen = { marcadas, yaEstaban };
        db.prepare('UPDATE pay_preparations SET payload=? WHERE id=?').run(JSON.stringify(preparation), row.id);
        putMetadata('activity', { id: 'pagos:' + row.id + ':' + preparation.pagadaEn, name: 'Pagos al banco confirmados',
          date: new Date(preparation.pagadaEn).toISOString(), added: 0, duplicates: 0, review: 0, issues: [],
          event: 'Preparación de ' + (preparation.month || row.month) + ' marcada como pagada en el banco: ' +
            marcadas + ' facturas cerradas' + (yaEstaban ? ', ' + yaEstaban + ' ya constaban pagadas' : '') + '.' });
        return json(res, { ok: true, marcadas, yaEstaban, pagadaEn: preparation.pagadaEn });
      }
      if (req.method === 'GET' && url.pathname === '/api/pagos/config') {
        /* La cuenta de retiro vive en el servidor (1.18.0): antes
           se guardaba en el navegador de cada equipo y se perdía
           al cambiar de equipo. */
        const owner = String(url.searchParams.get('rfc') || '').toUpperCase();
        payProfile(owner);
        let config = {};
        try { config = JSON.parse(getState('pagos-config') || '{}'); } catch { /* sin config */ }
        return json(res, { cuentaRetiro: String(config[owner] || '') });
      }
      if (req.method === 'POST' && url.pathname === '/api/pagos/config') {
        const x = await body(req);
        const owner = String(x.rfc || '').toUpperCase();
        payProfile(owner);
        const cuenta = String(x.cuentaRetiro || '').replace(/\D/g, '');
        need(cuenta.length >= 10 && cuenta.length <= 18, 'La cuenta de retiro debe tener entre 10 y 18 dígitos.');
        let config = {};
        try { config = JSON.parse(getState('pagos-config') || '{}'); } catch { /* sin config */ }
        config[owner] = cuenta;
        setState('pagos-config', JSON.stringify(config));
        return json(res, { cuentaRetiro: cuenta });
      }
      if (req.method === 'POST' && url.pathname === '/api/mail') {
        const x = await body(req);
        if (x.enabled === false) { mail = undefined; return json(res, overview()); }
        await configureMail(x);
        return json(res, overview());
      }
      if (req.method === 'POST' && url.pathname === '/api/mail/alerts') {
        /* Interruptor de los avisos importantes por correo (1.13.0):
           solo guarda la preferencia; el envío lo hace el despachador
           del ciclo, y solo si hay correo configurado. */
        const x = await body(req);
        setSetting('mailAlerts', x.enabled === false ? '0' : '1');
        return json(res, overview());
      }
      need(false, 'Ruta no encontrada.', 404);
    } catch (error) {
      if (!res.headersSent && !res.destroyed) json(res, { error: message(error),
        ...(error.guard ? { guard: error.guard } : {}) }, error.status || 502);
    }
  }
  /* Arranque: reconciliar corridas huérfanas (R1), migrar los
     secretos del índice a cifrado en reposo (S1) y barrer los
     scratch de ensayos de restauración huérfanos (H-5.1), antes
     de servir. */
  reconcileOrphanRuns(now());
  migrateEfirmaSecrets(now());
  sweepOrphanRestoreTests();
  return { handle, tick, monitorTick: (time = now()) => resting(time) ? Promise.resolve() : monitor.tick(time), inboxTick: (time = now()) => scanWatchFolder(time),
    backupTick: (time = now()) => runScheduledBackup(time), bootstrap, close: () => db.close() };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const path = process.env.PACOSAT_DATA_DIR || join(process.env.LOCALAPPDATA || homedir(), 'PacoSATLocal');
  mkdirSync(path, { recursive: true });
  const proxyKey = process.env.PACOSAT_PROXY_KEY || '';
  const origin = process.env.PACOSAT_ORIGIN || 'http://127.0.0.1:43729';
  need(origin === new URL(origin).origin && (!proxyKey || (proxyKey.length >= 32 && origin.startsWith('https://'))) &&
    (proxyKey || origin === 'http://127.0.0.1:43729'), 'Configuración de origen o proxy inválida.');
  const service = createPacoSATService({ dbFile: join(path, 'pacosat.sqlite'), html: readFileSync(new URL('./Faro-Fiscal.html', import.meta.url), 'utf8'), origin, proxyKey, watchDir: process.env.PACOSAT_WATCH_DIR || '',
    efirmaDir: process.env.PACOSAT_EFIRMA_DIR || '', officialLists: true,
    capacidades: existsSync(new URL('./capacidades.json', import.meta.url)) ?
      JSON.parse(readFileSync(new URL('./capacidades.json', import.meta.url), 'utf8')) : null,
    lazyParts: existsSync(new URL('./lazy.json', import.meta.url)) ?
      JSON.parse(readFileSync(new URL('./lazy.json', import.meta.url), 'utf8')) : null,
    /* Descargador de constancia y opinión (1.7.4): lee la e.firma de
       la misma carpeta protegida que resuelve el servicio (la de
       PACOSAT_EFIRMA_DIR o <datos>/efirma). Sin credenciales válidas
       el propio descargador devuelve el error claro que toca; nunca
       sale al portal con una e.firma caducada. */
    satDocFetch: createSatDocPipelineFetch({
      httpFetch: createSatDocFetch({ storage: createFileEfirmaStorage(
        process.env.PACOSAT_EFIRMA_DIR || join(path, 'efirma')) }),
      /* Ruta principal 1.9.0: navegador real interno (sidecar). El
         intento HTTP queda como paso previo barato; cuando se
         detiene en el paso en pantalla de siempre, el navegador
         completa el flujo firmando el reto dentro del portal. */
      browserFetch: createSatDocBrowserFetch({
        resolveCredentials: createSatDocCredentialResolver({ storage: createFileEfirmaStorage(
          process.env.PACOSAT_EFIRMA_DIR || join(path, 'efirma')) }),
        launchDriver: createPlaywrightDriverFactory({
          executablePath: process.env.PACOSAT_CHROMIUM_PATH || '/usr/bin/chromium' }),
        /* 150 s (1.10.1): sat-dm presupuesta hasta 180 s solo para
           el login FIEL; el aterrizaje tras firmar puede tardar
           decenas de segundos en un portal lento. */
        timeoutMs: 150_000 }) }),
    /* Declaraciones y Buzón (1.29.0, corrección de arquitectura):
       la ejecución contra el portal ya NO corre en este proceso
       del NAS. PacoSAT orquesta (trabajos, Registro, archivo) y el
       ejecutor del equipo de Paco navega con su sesión y su IP.
       Los conectores de navegador interno quedan en el árbol para
       las baterías y el modo asistido/local de pruebas, pero la
       producción arranca en modo remoto: sin ejecutor presente,
       los trabajos quedan «esperando tu equipo», nunca fallando
       en falso contra el SAT. */
    executorMode: 'remote',
    /* Descarga de CFDI por CIEC (1.12.0): el portal web de
       consulta con el mismo Chromium interno; las credenciales
       salen de la misma carpeta protegida (perfiles.json), solo
       para los RFC cuyo método guardado sea «ciec», y el captcha
       lo resuelve Paco en la pantalla de la app. */
    satCiecFetch: createSatCiecFetch({
      resolveCredentials: createCiecCredentialResolver({ storage: createFileEfirmaStorage(
        process.env.PACOSAT_EFIRMA_DIR || join(path, 'efirma')) }),
      launchDriver: createPlaywrightDriverFactory({
        executablePath: process.env.PACOSAT_CHROMIUM_PATH || '/usr/bin/chromium' }) }),
    buildModified: statSync(new URL('./Faro-Fiscal.html', import.meta.url)).mtimeMs });
  const server = createServer(service.handle);
  server.requestTimeout = PACOSAT_HTTP_TIMEOUTS.requestTimeout;
  server.keepAliveTimeout = PACOSAT_HTTP_TIMEOUTS.keepAliveTimeout;
  server.headersTimeout = PACOSAT_HTTP_TIMEOUTS.headersTimeout;
  server.on('error', error => {
    console.error(error.code === 'EADDRINUSE' ? 'El puerto local ya está ocupado. Si PacoSAT está abierto, usa su ventana actual.' : 'No se pudo iniciar PacoSAT: ' + message(error));
    service.close();
    process.exitCode = 1;
  });
  server.listen(43729, proxyKey ? '0.0.0.0' : '127.0.0.1', async () => {
    console.log('PacoSAT | ' + origin + ' | Mantén esta ventana abierta para sincronizar.');
    if (process.argv.includes('--open') && process.platform === 'win32') {
      const browser = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', origin], { detached: true, stdio: 'ignore' });
      browser.on('error', () => console.log('Abre la dirección anterior en Chrome o Edge.'));
      browser.unref();
    }
    if (process.env.PACOSAT_STARTUP_CONFIG) {
      try { await service.bootstrap(JSON.parse(readFileSync(process.env.PACOSAT_STARTUP_CONFIG, 'utf8'))); }
      catch { console.error('PacoSAT: no se pudo leer la configuración de arranque.'); }
    }
    const run = () => service.tick().catch(error => console.error('Error en la cola local: ' + message(error)));
    const watch = () => service.monitorTick().catch(error => console.error('Error en vigilancia SAT: ' + message(error)));
    void run(); void watch(); setInterval(run, 30000); setInterval(watch, 30000);
  });
}
