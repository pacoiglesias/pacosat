import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID, X509Certificate, scryptSync, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSatConnector, advanceSatJob } from './sat-direct.mjs';
import { parseXml, parseCfdiFull, fiscalSummary, crc32, zipXml, zipText, validateRfc } from './xml-core.mjs';
import { analyzeInvoicePdf } from './pdf-invoice.mjs';
import { createMonitor } from './sat-monitor.mjs';
import { LIST_CATALOG, parseList, declaredDate, listSeverity, SEVERITY_ORDER } from './sat-lists.mjs';
import { parseStatementText, extractPdfTextLines, moneyToCents } from './bank-statement.mjs';
import { encryptBackupBuffer, decryptBackupBuffer } from './backup-core.mjs';
import { createSatDocFetch, createFileEfirmaStorage, createSatDocCredentialResolver } from './sat-doc-fetch.mjs';
import { createSatDocBrowserFetch, createSatDocPipelineFetch, createPlaywrightDriverFactory } from './sat-doc-browser.mjs';
import { createSatDeclFetch } from './sat-declaraciones.mjs';

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
export function cspForHtml(html) {
  const blockHash = tag => {
    const match = html.match(new RegExp('<' + tag + '>([\\s\\S]*?)</' + tag + '>'));
    return match ? "'sha256-" + createHash('sha256').update(match[1], 'utf8').digest('base64') + "'" : "'none'";
  };
  return "default-src 'none'; style-src " + blockHash('style') + "; script-src " + blockHash('script') +
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
  analyzePdf = analyzeInvoicePdf, now = Date.now, monitorOptions = {}, watchDir = '', inboxParser = null, watchSettleMs = 2000, buildModified = null, efirmaDir = '', listFetch = null, officialLists = false, satDocFetch = null, satDeclFetch = null, extractText = extractPdfTextLines }) {
  const cspHeader = cspForHtml(html);
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
    CREATE TABLE IF NOT EXISTS records (store TEXT NOT NULL, id TEXT NOT NULL, value TEXT, data BLOB, mime TEXT,
      PRIMARY KEY(store,id));
    /* Sync por diferencias (1.7.0, mejora nº 10): cada registro lleva
       una revisión global creciente y los borrados dejan lápida, para
       que la app copie solo lo que cambió desde su última marca. */
    CREATE TABLE IF NOT EXISTS record_tombstones (store TEXT NOT NULL, id TEXT NOT NULL, rev INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS access_log (at INTEGER NOT NULL DEFAULT 0, kind TEXT NOT NULL DEFAULT '', detail TEXT NOT NULL DEFAULT '');
    CREATE TABLE IF NOT EXISTS alerts (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, ref TEXT NOT NULL UNIQUE,
      subject TEXT NOT NULL, body TEXT NOT NULL, due INTEGER NOT NULL,
      sent INTEGER, error TEXT NOT NULL DEFAULT '');
    CREATE TABLE IF NOT EXISTS alert_state (key TEXT PRIMARY KEY, failures INTEGER NOT NULL DEFAULT 0,
      alerted INTEGER NOT NULL DEFAULT 0);
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
      created INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '');
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
      error TEXT NOT NULL DEFAULT '');
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
  const monitor = createMonitor(db, { now, notifyCancellation: async item => {
    /* Cancelación post-pago (1.6.17 → 1.7.4): ya NO sale un correo
       directo. Entra como alerta interna y el Centro de Avisos la
       espeja en «Lo que está mal» con severidad alta; el correo, si
       acaso, la llevará dentro del resumen (criterio 3 del punto 17).
       Si el CFDI cancelado tenía pagos vinculados, el texto lo nombra:
       es el caso que exige actuar ya. */
    const paid = moneyPaidBy().get(item.id) || 0n;
    const wasPaid = paid > 0n;
    queueAlert('cancellation', 'cancel:' + item.id,
      wasPaid ? 'PacoSAT · ALERTA ROJA: CFDI cancelado DESPUÉS de pagado' : 'PacoSAT · CFDI cancelado detectado',
      'El SAT reportó como cancelado el folio ' + item.id + '. Emisor: ' + item.emitter + '. Receptor: ' + item.receiver + '.' +
        (wasPaid ? ' ATENCIÓN: este CFDI tenía pagos registrados por $' + moneyShow(paid) + ' (la relación de pagos está en la pantalla Dinero). ' +
          'Un CFDI cancelado tras cobrarse/pagarse exige revisión inmediata con tu contadora.' : ''), now());
    return true;
  }, notifyEfos: async alert => {
    /* 69-B (1.7.4): también al Centro, sin correo individual. */
    queueAlert('efos', 'efos:' + alert.rfc + ':' + alert.statuses.join(','),
      'PacoSAT · Nuevo RFC en el listado 69-B',
      'El RFC ' + alert.rfc + ' apareció en el listado oficial del artículo 69-B con la situación: ' + alert.statuses.join(', ') +
        '. Es emisor o receptor de CFDI de tu expediente. Revisa los comprobantes relacionados en Vigilancia SAT.', now());
    return true;
  }, ...monitorOptions });
  const host = new URL(origin).host;
  const unlocked = new Map();
  let mail, busy = false, storageRevision = 0;
  const cloud = Boolean(proxyKey);
  const stores = ['people', 'invoices', 'documents', 'files', 'activity'];
  /* La columna rev debe existir ANTES de preparar insertRecord: la
     migración va aquí, junto a la creación del esquema. */
  if (!db.prepare('PRAGMA table_info(records)').all().some(row => row.name === 'rev'))
    db.exec('ALTER TABLE records ADD COLUMN rev INTEGER NOT NULL DEFAULT 0');
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
  const inboxStatus = { lastScan: 0, imported: 0, failed: 0, incidents: 0, waiting: 0, error: '' };
  const inboxStuck = new Set();
  let backupJob = null;
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
  function readEfirmaIndex() {
    try { return JSON.parse(readFileSync(efirmaIndexPath, 'utf8')); } catch { return {}; }
  }
  function writeEfirmaFiles(rfc, certificate, privateKey, meta) {
    mkdirSync(efirmaBase, { recursive: true, mode: 0o700 });
    writeFileSync(efirmaPath(rfc, '.cer'), certificate, { mode: 0o600 });
    writeFileSync(efirmaPath(rfc, '.key'), privateKey, { mode: 0o600 });
    const index = readEfirmaIndex();
    index[rfc] = meta;
    writeFileSync(efirmaIndexPath, JSON.stringify(index, null, 2), { mode: 0o600 });
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
          '. Sin e.firma vigente PacoSAT no puede descargar CFDI del SAT. Renuévala en el SAT y vuelve a desbloquear el perfil en el Centro SAT con el certificado nuevo.', time);
      }
    }
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
          dir: config.backup.dir ? String(config.backup.dir) : join(dirname(dbFile), 'respaldos'),
          secondaryDir: config.backup.secondaryDir ? String(config.backup.secondaryDir) : '' };
      } else console.error('PacoSAT: el respaldo programado requiere una contraseña de al menos 12 caracteres.');
    }
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

  function overview() {
    return {
      settings: publicSettings(),
      serverStartedAt: startedAt,
      buildModified: servedBuildModified,
      cloudRevision: cloud ? storageRevision + ':' + db.prepare('SELECT COALESCE(MAX(rowid),0) AS value FROM records').get().value : null,
      profiles: db.prepare('SELECT * FROM profiles ORDER BY rfc').all().map(row => ({ ...row, unlocked: unlocked.has(row.rfc),
        efirmaStored: existsSync(efirmaPath(row.rfc, '.cer')),
        lastSatSuccess: db.prepare("SELECT MAX(created) AS last FROM jobs WHERE rfc=? AND status='finished'").get(row.rfc)?.last || null })),
      jobs: db.prepare('SELECT id,rfc,direction,kind,periodStart,periodEnd,startAt,endAt,status,due,created,error,checks FROM jobs ORDER BY id DESC LIMIT 35').all()
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
      inbox: db.prepare('SELECT id,rfc,newCount,review FROM packages WHERE archive IS NOT NULL ORDER BY id LIMIT 50').all(),
      mail: { enabled: Boolean(mail), recipient: mail?.recipient || '', error: db.prepare("SELECT error FROM notices WHERE sent IS NULL AND error<>'' ORDER BY id DESC LIMIT 1").get()?.error || '' },
      watchFolder: { enabled: Boolean(inbox.dir), lastScan: inboxStatus.lastScan, imported: inboxStatus.imported,
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
      } catch { return { total: 0, porConfirmar: 0 }; } })()
    };
  }

  async function inspectPackage(job, id, archive, Parser) {
    if (packageLookup.get(job.id, id)) return;
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
          if (!putMetadata('invoices', row).changes) continue;
          monitor.register({ id: row.id, emitter: row.from.rfc, receiver: row.to.rfc, total: row.total,
            seal: /^[A-Za-z0-9+/=]{8}$/.test(row.seal) ? row.seal : '' });
        }
        count += discovered;
      }
      if (cloud) putMetadata('activity', { id: 'sat:' + job.id + ':' + id, name: ('SAT · ' + job.rfc).slice(0, 180),
        date: new Date(now()).toISOString(), added: count, duplicates: valid.length - count, review, issues });
      if (count && job.direction === 'received') setState('news:last:' + job.rfc, String(now()));
      const record = insertPackage.run(job.id, id, job.rfc, !cloud && (count || review) ? archive : null, count, review);
      if (mail && count && job.direction === 'received') {
        db.prepare('INSERT INTO notices(package,rfc,recipient,count,due) VALUES (?,?,?,?,?)')
          .run(record.lastInsertRowid, job.rfc, mail.recipient, count, now());
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
    ['package_attempts', ['job', 'remoteId', 'attempts']],
    ['mail_sends', ['id', 'at', 'recipients', 'subject', 'kind', 'ok', 'error']],
    /* Bancos y Avisos en el respaldo (1.9.0, punto 2 del plan): hasta
       la 1.8.0 el respaldo NO los incluía — una restauración perdía
       cuentas, estados, movimientos, conciliaciones y el historial
       de avisos solventados. Desde la 1.9.0 viajan completos. */
    ['bank_accounts', ['id', 'bank', 'name', 'last4', 'kind', 'created']],
    ['bank_statements', ['id', 'accountId', 'month', 'fileId', 'openingCents', 'closingCents', 'creditsCents', 'chargesCents', 'movements', 'state', 'detected', 'created']],
    ['bank_movements', ['id', 'statementId', 'date', 'concept', 'amountCents', 'balanceCents']],
    ['bank_matches', ['id', 'movementId', 'invoices', 'mode', 'amountCents', 'why', 'estado', 'created', 'undone']],
    ['bank_movement_marks', ['movementId', 'estado', 'nota', 'at']],
    ['avisos', ['id', 'ref', 'kind', 'clase', 'estado', 'severidad', 'titulo', 'detalle', 'contraparte', 'nombre', 'importe', 'enlace', 'datos', 'baseline', 'creado', 'actualizado', 'resuelto', 'resolucion', 'correo', 'rfc', 'responsable', 'vence', 'accion']],
    ['avisos_acciones', ['id', 'aviso', 'at', 'accion', 'nota']],
    ['manual_payments', ['uuid', 'at', 'nota', 'importe']],
    ['declaraciones', ['id', 'rfc', 'tipo', 'clase', 'ejercicio', 'periodo', 'fechaPresentacion', 'operacion', 'fileId', 'source', 'created', 'error']]
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
        const defaults = { kind: 'cfdi', paused: 0, pauseUntil: 0 };
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
      const names = readdirSync(dir).filter(name => /^PacoSAT-\d{4}-\d{2}-\d{2}\.faro$/.test(name)).sort();
      return names.length ? join(dir, names[names.length - 1]) : '';
    } catch { return ''; }
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
      const file = latestBackupFile(dir);
      if (!file) return { label, ok: false, detail: 'No hay ningún respaldo en este destino.' };
      try {
        const info = validateBackupData(decryptBackupBuffer(readFileSync(file), backupJob.password));
        return { label, ok: true, detail: 'Íntegro · ' + info.invoices + ' CFDI · ' + info.documents + ' documentos' +
          (info.operations ? ' · estado operativo: ' + info.operations.jobs + ' solicitudes, ' + info.operations.criteria +
            ' criterios (' + info.operations.exhausted + ' agotados), ' + info.operations.pendingAlerts + ' avisos pendientes' : ' · sin estado operativo (respaldo anterior a 1.6.4)') };
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

  function snapshotFromRecords() {
    const data = { version: 2 };
    let fileBytes = 0;
    /* Una sola transacción de lectura: expediente y estado operativo son
       la misma foto, sin cambios a mitad de camino. */
    db.exec('BEGIN');
    try {
      for (const store of stores) {
        const rows = db.prepare('SELECT id,value,data FROM records WHERE store=? ORDER BY id').all(store);
        if (store === 'files') {
          data[store] = rows.map(row => { fileBytes += row.data?.length || 0; return { id: row.id, content: Buffer.from(row.data || []).toString('base64') }; });
        } else data[store] = rows.map(row => JSON.parse(row.value));
      }
      data.operations = dumpOperations();
    } finally { db.exec('COMMIT'); }
    need(fileBytes + Buffer.byteLength(JSON.stringify(data.operations)) <= 100 * 1024 * 1024, 'El respaldo supera el límite de 100 MB.');
    return data;
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
      const buffer = encryptBackupBuffer(snapshotFromRecords(), backupJob.password);
      writeFileSync(join(backupJob.dir, 'PacoSAT-' + stamp + '.faro'), buffer);
      /* Destino secundario (1.6.4): el MISMO .faro cifrado en una segunda
         ruta (pensada para una carpeta sincronizada fuera del NAS). Su
         fallo no tumba el respaldo principal: se anota y se avisa aparte. */
      let secondaryError = '';
      if (backupJob.secondaryDir) {
        try { mkdirSync(backupJob.secondaryDir, { recursive: true }); writeFileSync(join(backupJob.secondaryDir, 'PacoSAT-' + stamp + '.faro'), buffer); }
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
      putMetadata('activity', { id: 'backup:' + stamp + ':' + backupJob.frequency, name: 'Respaldo cifrado programado',
        date: new Date(time).toISOString(), added: 0, duplicates: 0, review: 0, issues: [],
        event: 'Respaldo programado · copia cifrada guardada (' + stamp + ')' +
          (backupJob.secondaryDir ? (secondaryError ? ' · el destino secundario falló: ' + secondaryError : ' · también en el destino secundario') : '') +
          ' · incluye el estado operativo' });
      storageRevision++;
      /* Prueba de restauración automática contra lo recién escrito. */
      try { verifyLatestBackup(time, 'automática tras el respaldo'); }
      catch (error) { queueAlert('backup-verify-fail', 'backupverify:' + stamp, 'PacoSAT · La prueba de restauración falló',
        'El respaldo se escribió, pero su prueba de restauración automática no pasó: ' + message(error), time); }
    } catch (error) {
      setState('backup:error', message(error));
      setState('backup:next', time + 60 * MIN);
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
  async function scanWatchFolder(time) {
    if (!cloud || !inbox.dir || watchBusy) return;
    watchBusy = true;
    try {
      try { readdirSync(inbox.dir); }
      catch (error) { inboxStatus.error = message(error); setState('watch:error', inboxStatus.error); return; }
      inboxStatus.error = ''; setState('watch:error', '');
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
      const importXml = raw => {
        const row = parseXml(raw, Parser);
        need(peopleIds.has(row.from.rfc) || peopleIds.has(row.to.rfc), 'Los RFC del comprobante no están registrados.');
        if (db.prepare("SELECT 1 FROM records WHERE store='invoices' AND id=?").get(row.id)) return 'duplicate';
        putFile('xml:' + row.id, raw, 'application/xml');
        putMetadata('invoices', row);
        monitor.register({ id: row.id, emitter: row.from.rfc, receiver: row.to.rfc, total: row.total,
          seal: /^[A-Za-z0-9+/=]{8}$/.test(row.seal) ? row.seal : '' });
        addedRows.push(row);
        return 'added';
      };
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
        } else inboxStatus.imported++;
      }
      if (added || duplicates || review) {
        putMetadata('activity', { id: 'inbox:' + time + ':' + added + ':' + review, name: 'Carpeta vigilada',
          date: new Date(time).toISOString(), added, duplicates, review, issues });
        storageRevision++;
      }
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
  async function verifyJobs(profile, active, time) {
    const jobs = db.prepare("SELECT * FROM jobs WHERE rfc=? AND status='pending' AND due<=? ORDER BY id").all(profile.rfc, time);
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
      if (after && ['expired', 'failed', 'rejected', 'exhausted'].includes(after.status)) terminal.push({ ...job, afterStatus: after.status });
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
    return { groups: out, gaps, days };
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

  async function notify(time) {
    if (!mail) return;
    const active = mail;
    const items = db.prepare('SELECT * FROM notices WHERE recipient=? AND due<=? AND sent IS NULL ORDER BY id LIMIT 10').all(active.recipient, time);
    for (const item of items) {
      db.prepare('UPDATE notices SET due=? WHERE id=?').run(time + 15 * MIN, item.id);
      try {
        await active.transport.sendMail({
          from: displayFrom(active.from), to: item.recipient,
          subject: 'PacoSAT · Nuevos CFDI recibidos',
          text: 'PacoSAT detectó ' + item.count + ' comprobante(s) nuevo(s) para el RFC ' + item.rfc + '. Abre PacoSAT para revisar el expediente.',
          messageId: '<pacosat-' + item.id + '-' + active.instance + '@pacosat.local>'
        });
        db.prepare('UPDATE notices SET sent=?,error=? WHERE id=?').run(now(), '', item.id);
      } catch { db.prepare('UPDATE notices SET error=? WHERE id=?').run('El servidor SMTP no aceptó el envío. Revisa la configuración y las credenciales.', item.id); }
    }
  }
  const jobStateLabel = { expired: 'vencida', failed: 'fallida', rejected: 'rechazada' };
  function queueAlert(kind, ref, subject, bodyText, time) {
    db.prepare('INSERT OR IGNORE INTO alerts(kind,ref,subject,body,due) VALUES (?,?,?,?,?)').run(kind, ref, subject, bodyText, time);
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
    const config = avisosConfig();
    if (config.correo === 'no') return;
    const mx = mxParts(time);
    if (mx.hour < config.hora) return;
    const pendientes = db.prepare("SELECT * FROM avisos WHERE estado NOT IN ('solventado','descartado') AND baseline=0 AND correo=0 ORDER BY creado").all();
    if (!pendientes.length) return;
    const graves = pendientes.filter(aviso => aviso.severidad === 'alta');
    const lastDay = getState('avisos:digest-day');
    let incluir = null;
    if (config.correo === 'diario' && lastDay !== day(time)) incluir = pendientes;
    else if (config.correo === 'semanal' && mx.weekday === 1 && lastDay !== day(time)) incluir = pendientes;
    else if (config.correo === 'graves' && graves.length) incluir = graves;
    if (!incluir || !incluir.length) return;
    const active = mail;
    const claseNombre = { necesita: 'LO QUE EL SISTEMA NECESITA DE TI', mal: 'LO QUE ESTÁ MAL', falta: 'LO QUE FALTA' };
    const lines = ['Resumen de avisos de PacoSAT · ' + day(time), '',
      'Tienes ' + incluir.length + ' aviso(s) esperando en el Centro de Avisos de la app.', ''];
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
    lines.push('Todo se ve y se solventa dentro de PacoSAT, en la pantalla Avisos. Este correo es solo el resumen.');
    try {
      await active.transport.sendMail({ from: displayFrom(active.from), to: active.recipient,
        subject: 'PacoSAT · Resumen de avisos: ' + incluir.length + ' necesitan tu atención',
        text: lines.join('\n'),
        messageId: '<pacosat-resumen-' + day(time) + '-' + active.instance + '@pacosat.local>' });
      const mark = db.prepare('UPDATE avisos SET correo=1 WHERE id=?');
      for (const aviso of incluir) mark.run(aviso.id);
      setState('avisos:digest-day', day(time));
      db.prepare('INSERT INTO mail_sends(at,recipients,subject,kind,ok,error) VALUES (?,?,?,?,1,\'\')')
        .run(now(), active.recipient, 'Resumen de avisos (' + incluir.length + ')', 'avisos-resumen');
    } catch { /* sin envío: los avisos quedan sin marcar y el resumen se reintenta en el siguiente ciclo */ }
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
        threshold + ' días. Puede ser normal (sin operaciones) o la señal de una factura esperada que no llegó: revísalo en el Centro SAT.', time);
    }
  }

  /* ===== Listas negras vivas (1.6.13) =====
     Descarga diaria de los listados oficiales con URL, importación
     manual para los que no la tienen, cruce continuo contra el padrón
     de contrapartes (del CFDI y manual) y aviso ante CUALQUIER cambio:
     altas, bajas, cambios de situación y la línea base de la primera
     carga. Las entradas son datos públicos: no viajan en respaldos. */
  let listsBusy = false;
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
      (detail ? ' (' + detail + ')' : '') + '. Revisa el panel de Listas negras para ver su exposición.', time);
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
    if (!fetcher && !officialLists) return;
    if (listsBusy) return;
    listsBusy = true;
    try {
      for (const source of LIST_CATALOG) {
        if (!source.url) continue;
        const meta = listMeta(source.id);
        if (time < meta.next) continue;
        try { await refreshList(source, time, fetcher); }
        catch (error) {
          db.prepare('INSERT INTO blacklist_meta(listId,fetched,next,count,declared,error) VALUES (?,?,?,?,?,?) ' +
            'ON CONFLICT(listId) DO UPDATE SET next=excluded.next,error=excluded.error')
            .run(source.id, meta.fetched, time + HOUR_MS, meta.count, meta.declared, message(error));
        }
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
    } finally { listsBusy = false; }
  }
  function listsOverview() {
    const sources = LIST_CATALOG.map(source => {
      const meta = listMeta(source.id);
      return { id: source.id, label: source.label, url: source.url, manual: !source.url,
        fetched: meta.fetched, count: meta.count, declared: meta.declared, error: meta.error };
    });
    /* Exposición y presencia por contraparte desde el expediente. */
    const exposure = new Map();
    try {
      for (const row of db.prepare("SELECT value FROM records WHERE store='invoices'").all()) {
        const invoice = JSON.parse(row.value);
        for (const [rfc, role] of [[invoice?.from?.rfc, 'emitter'], [invoice?.to?.rfc, 'receiver']]) {
          if (!rfc) continue;
          if (!exposure.has(rfc)) exposure.set(rfc, { name: '', receivedCents: 0n, receivedCount: 0, issuedCount: 0 });
          const item = exposure.get(rfc);
          const name = role === 'emitter' ? invoice.from?.name : invoice.to?.name;
          if (name && !item.name) item.name = name;
          if (role === 'emitter') {
            item.receivedCount++;
            const [integer, decimals = ''] = String(invoice.total || '0').split('.');
            if (/^\d+$/.test(integer) && (!invoice.currency || invoice.currency === 'MXN'))
              item.receivedCents += BigInt(integer) * 100n + BigInt((decimals + '00').slice(0, 2));
          } else item.issuedCount++;
        }
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
      return { rfc, name: reg?.name || expo?.name || '', kind: reg?.kind ||
          (profileRfcs.has(rfc) ? 'Propio' : expo ? (expo.receivedCount && expo.issuedCount ? 'Ambos' :
            expo.receivedCount ? 'Proveedor' : 'Cliente') : ''),
        note: reg?.note || '', source: reg ? reg.source : (profileRfcs.has(rfc) ? 'perfil' : 'cfdi'),
        payDay: reg?.payDay ?? null, payTerms: reg?.payTerms ?? null,
        hits, severity,
        exposure: expo ? { receivedCount: expo.receivedCount, issuedCount: expo.issuedCount,
          received: (expo.receivedCents / 100n).toString() + '.' + String(expo.receivedCents % 100n).padStart(2, '0') } : null };
    }).sort((a, b) => (SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity]) || a.rfc.localeCompare(b.rfc));
    const events = db.prepare('SELECT * FROM list_events ORDER BY id DESC LIMIT 100').all()
      .map(row => ({ ...row, label: LIST_CATALOG.find(item => item.id === row.listId)?.label || row.listId }));
    return { sources, counterparts, events };
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
  async function sendAppMail({ to, subject, text, attachments }, kind, time) {
    const recipients = String(to || '').trim() || (mail ? mail.recipient : '');
    let ok = false, errorText = '';
    try {
      need(mail, 'El correo no está configurado en esta instalación.', 409);
      need(recipients, 'Falta el destinatario del correo.');
      await mail.transport.sendMail({ from: displayFrom(mail.from), to: recipients, subject, text, attachments });
      ok = true;
    } catch (error) { errorText = message(error); }
    db.prepare('INSERT INTO mail_sends(at,recipients,subject,kind,ok,error) VALUES (?,?,?,?,?,?)')
      .run(time, recipients, subject, kind, ok ? 1 : 0, errorText);
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
  function buildMonthlyPackage(monthKey) {
    const invoices = recordInvoices().filter(invoice => String(invoice.date || '').startsWith(monthKey));
    const entries = [];
    const index = [['UUID', 'Fecha', 'Tipo', 'Emisor RFC', 'Emisor', 'Receptor RFC', 'Receptor', 'Total', 'Moneda', 'Estado']];
    let issued = 0n, received = 0n;
    const profileRfcs = new Set(db.prepare('SELECT rfc FROM profiles').all().map(row => row.rfc));
    for (const invoice of invoices) {
      index.push([invoice.id, invoice.date, invoice.kind, invoice.from?.rfc, invoice.from?.name, invoice.to?.rfc, invoice.to?.name,
        invoice.total, invoice.currency || 'MXN', invoice.state || '']);
      if (!invoice.currency || invoice.currency === 'MXN') {
        if (profileRfcs.has(invoice.from?.rfc)) issued += centsOf(invoice.total);
        if (profileRfcs.has(invoice.to?.rfc)) received += centsOf(invoice.total);
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
        const file = readFileRecord(doc.id);
        if (file) entries.push({ name: 'documentos/' + (doc.rfc || 'sin-rfc') + '/' + String(doc.name || doc.id).replace(/[\\/:*?"<>|]/g, '_'), buffer: file.buffer });
      }
    } catch { /* sin documentos */ }
    /* Base DIOT del mes con el desglose persistido. */
    const diot = new Map();
    for (const invoice of invoices) {
      if (!profileRfcs.has(invoice.to?.rfc) || invoice.kind !== 'I') continue;
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
    /* Novedades de listas negras del mes. */
    const monthStart = Date.parse(monthKey + '-01T00:00:00Z');
    const events = db.prepare('SELECT * FROM list_events WHERE at>=? AND at<? ORDER BY at').all(monthStart, monthStart + 32 * DAY);
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
    const sentido = invoice => profileRfcs.has(invoice.from?.rfc) ? 'Por cobrar (emitida)' : 'Por pagar (recibida)';
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
        profileRfcs.has(invoice.from?.rfc) ? invoice.to?.name : invoice.from?.name,
        invoice.total, moneyText(paid), moneyText(saldo)]);
      if (saldo > 0n) { pendingComplements++;
        complementPendingRows.push([invoice.id, invoice.date, sentido(invoice),
          profileRfcs.has(invoice.from?.rfc) ? invoice.to?.name : invoice.from?.name,
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
        if (target && target.fiscal?.paymentMethod === 'PUE' && String(target.date || '').startsWith(monthKey))
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
    /* Conciliación bancaria del mes y movimientos sin identificar. */
    const movements = db.prepare('SELECT m.*, s.accountId FROM bank_movements m JOIN bank_statements s ON s.id=m.statementId').all()
      .filter(mv => String(mv.date || '').startsWith(monthKey));
    const activeMatches = db.prepare("SELECT * FROM bank_matches WHERE estado='activo'").all();
    const matchByMovement = new Map(activeMatches.map(match => [match.movementId, match]));
    const marks = new Set(db.prepare('SELECT movementId FROM bank_movement_marks').all().map(row => row.movementId));
    const accountsById = new Map(banksOverview().accounts.map(account => [account.id, account]));
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
      if (account.missing.includes(monthKey))
        missingRows.push(['Estado de cuenta faltante', account.bank + ' ' + (account.name || '') + ' · ' + monthKey]);
    entries.push({ name: 'faltantes.csv', buffer: Buffer.from(csvText(missingRows)) });
    /* Bitácora del mes: avisos (Buzón interno) y correos enviados —
       las invitaciones del SAT también llegan por correo (C.3). */
    const avisoRows = [['Creado', 'Clase', 'Título', 'RFC', 'Responsable', 'Estado', 'Resolución']];
    for (const aviso of db.prepare('SELECT * FROM avisos WHERE creado>=? AND creado<? ORDER BY creado').all(monthStart, monthStart + 32 * DAY))
      avisoRows.push([new Date(aviso.creado).toISOString(), aviso.clase, aviso.titulo, aviso.rfc || '', aviso.responsable || '', aviso.estado, aviso.resolucion || '']);
    entries.push({ name: 'avisos-del-mes.csv', buffer: Buffer.from(csvText(avisoRows)) });
    const mailRows = [['Fecha', 'Destinatarios', 'Asunto', 'Tipo', 'Enviado', 'Error']];
    for (const send of db.prepare('SELECT * FROM mail_sends WHERE at>=? AND at<? ORDER BY at').all(monthStart, monthStart + 32 * DAY))
      mailRows.push([new Date(send.at).toISOString(), send.recipients, send.subject, send.kind, send.ok ? 'sí' : 'no', send.error || '']);
    entries.push({ name: 'correos-del-mes.csv', buffer: Buffer.from(csvText(mailRows)) });
    /* Conciliación PUE vs declarado (base, barrido C.3): el IVA de
       los PUE emitidos es lo que el SAT cruza contra la declaración;
       la cifra declarada la aporta la contadora — aquí va la base
       exacta, por RFC, para conciliar en un vistazo. */
    let pueIva = 0n, pueTotal = 0n;
    for (const invoice of invoices.filter(item => item.kind === 'I' && item.fiscal?.paymentMethod === 'PUE' && profileRfcs.has(item.from?.rfc))) {
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
    const summary = ['PacoSAT · Paquete mensual ' + monthKey, '',
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
    return { buffer: zipStoreBuffers(entries), filename: 'PacoSAT-paquete-' + monthKey + '.zip',
      counts: { invoices: invoices.length, events: events.length, pendingComplements,
        pueWithComplement: pueWithComplement.size, unmatchedMovements: unmatchedRows.length - 1,
        cancelled: cancelRows.length - 1, missing: missingRows.length - 1 } };
  }
  /* Lista de cierre del mes calculada en el SERVIDOR (1.9.0): la
     pantalla ya no trae pasos «sin comprobar» — cada renglón trae su
     cifra real y su nivel, y es la misma verdad que va dentro del
     ZIP en revision-contadora.txt. */
  function monthChecklist(monthKey, time) {
    const invoices = recordInvoices().filter(invoice => String(invoice.date || '').startsWith(monthKey));
    const items = [];
    const push = (id, label, level, detail) => items.push({ id, label, level, detail });
    push('cfdi', 'CFDI del mes en el expediente', invoices.length ? 'ok' : 'dim',
      invoices.length ? invoices.length + ' comprobantes de ' + monthKey + '.' : 'Aún no hay comprobantes de ' + monthKey + '.');
    const sinDesglose = invoices.filter(invoice => invoice.kind === 'I' && !invoice.fiscal).length;
    push('desglose', 'Desglose fiscal completo', sinDesglose ? 'warn' : 'ok',
      sinDesglose ? sinDesglose + ' CFDI de ingreso sin desglose: la base DIOT sale incompleta.' : 'Todos los CFDI de ingreso traen desglose.');
    const movements = db.prepare('SELECT m.id FROM bank_movements m JOIN bank_statements s ON s.id=m.statementId WHERE m.date LIKE ?').all(monthKey + '%');
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
        if (target?.fiscal?.paymentMethod === 'PUE' && String(target.date || '').startsWith(monthKey)) pueComp++;
      }
    push('pue', 'CFDI PUE con complemento (meta: cero)', pueComp ? 'bad' : 'ok',
      pueComp ? pueComp + ' caso(s): es la combinación que el SAT observa por Buzón Tributario.' : 'Ningún PUE del mes tiene complemento asociado.');
    const paidBy = moneyPaidBy();
    const canceladas = invoices.filter(invoice => String(invoice.state || '').toLowerCase().startsWith('cancel'));
    const cancelPagadas = canceladas.filter(invoice => (paidBy.get(invoice.id) || 0n) > 0n).length;
    push('cancelaciones', 'Cancelaciones del mes', cancelPagadas ? 'bad' : canceladas.length ? 'warn' : 'ok',
      canceladas.length ? canceladas.length + ' cancelada(s)' + (cancelPagadas ? ', ' + cancelPagadas + ' ya pagada(s): revisar ya.' : '.') : 'Sin cancelaciones en el mes.');
    const xmlFaltantes = invoices.filter(invoice => !readFileRecord('xml:' + invoice.id)).length;
    const estadosFaltantes = banksOverview().accounts.filter(account => account.missing.includes(monthKey)).length;
    push('faltantes', 'Faltantes de descarga y archivo', (xmlFaltantes || estadosFaltantes) ? 'warn' : 'ok',
      (xmlFaltantes || estadosFaltantes) ? xmlFaltantes + ' XML sin guardar y ' + estadosFaltantes + ' estado(s) de cuenta faltante(s) del mes.' : 'Nada falta: XML y estados del mes están archivados.');
    const backup = overview().scheduledBackup;
    const respaldoOk = backup.last && time - backup.last < 10 * DAY;
    push('respaldo', 'Respaldo reciente', respaldoOk ? 'ok' : 'warn',
      backup.last ? 'Último respaldo: ' + new Date(backup.last).toISOString().slice(0, 10) + '.' : 'Aún no hay respaldo ejecutado.');
    const docsView = satDocsOverview(time);
    const sinConstancia = docsView.filter(profile => !profile.constancia || !profile.opinion).length;
    push('constancias', 'Constancias y opinión al día', sinConstancia ? 'warn' : 'ok',
      sinConstancia ? sinConstancia + ' perfil(es) sin constancia u opinión archivada.' : 'Constancias y opiniones archivadas por perfil.');
    let noraMonth = '';
    try { noraMonth = JSON.parse(getState('reports-state') || '{}').noraMonth || ''; } catch { noraMonth = ''; }
    push('informe', 'Informe a la contadora', noraMonth === monthKey ? 'ok' : 'dim',
      noraMonth === monthKey ? 'El paquete de ' + monthKey + ' ya salió a la contadora.' :
        'El paquete de ' + monthKey + ' aún no consta enviado (sale el día fijado del mes siguiente o a mano desde Salidas).');
    return { month: monthKey, items };
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
              'novedades de listas negras y PPD del mes. Generado automáticamente por PacoSAT.',
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
          const activity = (() => { try { return db.prepare("SELECT value FROM records WHERE store='activity'").all()
            .map(row => JSON.parse(row.value)).filter(item => Date.parse(item.date || 0) >= since); } catch { return []; } })();
          const added = activity.reduce((sum, item) => sum + (item.added || 0), 0);
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
    }
    /* (e) Espejo de las alertas internas históricas (respaldo, SAT,
       listados…): cada una se ve UNA vez en el Centro, en su clase.
       Las de antigüedad PPD y las de factura esperada NO se espejan:
       las sustituyen los generadores estructurados (a) y (b). */
    const ESPEJO = { cancellation: ['mal', 'alta', 'monitor'], efos: ['mal', 'alta', 'monitor'],
      'backup-fail': ['mal', 'alta', 'backup'], 'criteria-5002': ['mal', 'alta', 'sat'],
      'backup-secondary-fail': ['mal', 'media', 'backup'], 'backup-verify-fail': ['mal', 'media', 'backup'],
      'backup-external-stale': ['falta', 'media', 'backup'], 'criteria-presumed': ['mal', 'media', 'sat'],
      'criteria-rescued': ['falta', 'baja', 'sat'], 'download-fail': ['mal', 'media', 'sat'],
      'package-exhausted': ['mal', 'media', 'sat'], 'job-terminal': ['mal', 'media', 'operaciones'],
      'list-transition': ['mal', 'media', 'lists'], 'nora-report-fail': ['mal', 'media', 'operaciones'],
      'weekly-fail': ['mal', 'media', 'operaciones'], 'satdoc-fail': ['mal', 'media', 'docs'],
      'watch-fail': ['mal', 'media', 'operaciones'], 'watch-incidents': ['mal', 'media', 'operaciones'],
      'decl-fail': ['mal', 'media', 'docs'],
      'tick-stuck': ['mal', 'media', 'operaciones'],
      'cert-expiry': ['necesita', 'media', 'sat'], 'fiscal-due': ['necesita', 'media', 'cumplimiento'],
      'satdoc-mail': ['necesita', 'media', 'docs'],
      silence: ['falta', 'baja', 'sat'], 'list-stale': ['falta', 'baja', 'lists'], 'satdoc-old': ['falta', 'baja', 'docs'] };
    for (const alert of db.prepare('SELECT * FROM alerts').all()) {
      const mapa = ESPEJO[alert.kind];
      if (!mapa) continue;
      /* El espejo NO es línea base (es un suceso, no la foto del
         histórico) y una alerta que ya salió por correo en su día no
         vuelve a entrar en ningún resumen (correo=1). */
      avisoEnsure({ ref: 'alerta:' + alert.id, kind: 'general', clase: mapa[0], estado: 'abierto', severidad: mapa[1],
        titulo: String(alert.subject || '').replace(/^PacoSAT · /, ''), detalle: alert.body || '',
        contraparte: '', nombre: '', importe: '', enlace: mapa[2], correo: alert.sent ? 1 : 0,
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
    return { ok: true, resolucion: 'Marcado como corregido por ti; queda registrado en el historial.' };
  }
  function avisosOverview() {
    const open = db.prepare("SELECT * FROM avisos WHERE estado NOT IN ('solventado','descartado') ORDER BY baseline ASC, creado ASC").all();
    const history = db.prepare("SELECT * FROM avisos WHERE estado='solventado' ORDER BY resuelto DESC LIMIT 50").all();
    const serialize = row => { const datos = avisoDatos(row); return { id: row.id, ref: row.ref, kind: row.kind, clase: row.clase,
      estado: row.estado, severidad: row.severidad, titulo: row.titulo, detalle: row.detalle, contraparte: row.contraparte,
      nombre: row.nombre, importe: row.importe, enlace: row.enlace, baseline: Boolean(row.baseline), creado: row.creado,
      resuelto: row.resuelto, resolucion: row.resolucion, direccion: datos.direccion || '',
      rfc: row.rfc || '', responsable: row.responsable || 'Paco', vence: row.vence || null,
      accion: row.accion || '', actualizado: row.actualizado,
      solicitud: row.kind === 'solicitud-estado' ? { banco: datos.banco || '', mes: datos.mes || '' } : null }; };
    const counts = { total: open.length, mal: 0, falta: 0, necesita: 0, porConfirmar: 0 };
    const porRfc = {};
    for (const row of open) { counts[row.clase] = (counts[row.clase] || 0) + 1; if (row.estado === 'por-confirmar') counts.porConfirmar++;
      if (row.rfc) porRfc[row.rfc] = (porRfc[row.rfc] || 0) + 1; }
    return { avisos: open.map(serialize), historial: history.map(serialize), counts, porRfc, config: avisosConfig() };
  }

  /* ===== Dinero (1.6.17) =====
     Saldos desde la relación Pagos↔facturas persistida en el desglose
     (1.6.16/1.6.17): por cobrar y por pagar con antigüedad, avisos de
     PPD que envejecen sin pago completo y detector de facturas
     esperadas (proveedor recurrente que este mes no ha llegado). La
     conciliación con estados de cuenta consume estos mismos saldos
     cuando llega la ronda de Bancos (1.6.19). */
  function moneyPaidBy() {
    const paidBy = new Map();
    for (const payment of recordInvoices()) {
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
  function moneyBalances() {
    const paidBy = moneyPaidBy();
    const profileRfcs = new Set(db.prepare('SELECT rfc FROM profiles').all().map(row => row.rfc));
    return recordInvoices().filter(invoice => invoice.kind === 'I').map(invoice => {
      const total = centsOf(invoice.total);
      const paid = invoice.fiscal?.paymentMethod === 'PUE' ? total : (paidBy.get(invoice.id) || 0n);
      return { id: invoice.id, date: invoice.date, from: invoice.from, to: invoice.to, kind: invoice.kind,
        method: invoice.fiscal?.paymentMethod || '', total, paid, balance: total - paid,
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
    return Array.isArray(config.rfcs) && config.rfcs.length
      ? new Set(config.rfcs.map(rfc => String(rfc).toUpperCase())) : null;
  }
  const guestLoginFails = [];
  function guestLoginThrottled() {
    const cutoff = now() - 10 * 60 * 1000;
    while (guestLoginFails.length && guestLoginFails[0] < cutoff) guestLoginFails.shift();
    return guestLoginFails.length >= 8;
  }
  const GUEST_GET = ['/api/status', '/api/storage', '/api/storage/rev', '/api/lists', '/api/money', '/api/notices',
    '/api/fiscal/calendar', '/api/fiscal/issues', '/api/banks', '/api/banks/movements', '/api/offline-bundle', '/api/reports/config'];
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
      balances: moneyBalances().filter(item => item.balance > 0n).map(item => ({ ...item,
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
  function archiveDeclaracion(rfc, doc, time) {
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
      db.prepare('INSERT INTO declaraciones(id,rfc,tipo,clase,ejercicio,periodo,fechaPresentacion,operacion,fileId,source,created) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .run(randomUUID(), rfc, doc.tipo, doc.clase, doc.ejercicio, doc.periodo || '',
          doc.fechaPresentacion || '', doc.operacion || '', fileId, 'auto', time);
    });
    return true;
  }
  async function runDeclaracionesAttempt(rfc, query, time) {
    try {
      if (!satDeclFetch) throw new Error('La recuperación automática de declaraciones no está disponible en esta instalación: el navegador interno no está configurado.');
      const result = await satDeclFetch({ rfc }, query);
      let saved = 0;
      for (const doc of result.documents || [])
        if (archiveDeclaracion(rfc, { ...doc, tipo: query.tipo }, time)) saved++;
      return { ok: true, found: result.found || 0, saved, warnings: result.warnings || [] };
    } catch (error) {
      db.prepare('INSERT INTO declaraciones(id,rfc,tipo,clase,ejercicio,periodo,created,error) VALUES (?,?,?,?,?,?,?,?)')
        .run(randomUUID(), rfc, query.tipo, '', Number(query.ejercicio) || 0, String(query.periodo || ''), time, message(error));
      queueAlert('decl-fail', 'decl:' + rfc + ':' + query.tipo + ':' + Math.floor(time / DAY),
        'PacoSAT · No se pudieron recuperar declaraciones de ' + rfc,
        'El intento de recuperación de declaraciones ' + (query.tipo === 'anual' ? 'anuales' : 'mensuales') +
        ' de ' + query.ejercicio + ' falló: ' + message(error), time);
      return { ok: false, error: message(error) };
    }
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
    const lastError = db.prepare("SELECT error,created FROM declaraciones WHERE rfc=? AND error<>'' ORDER BY created DESC LIMIT 1").get(rfc);
    return { rfc, ejercicio, configured: Boolean(satDeclFetch), mensuales,
      anual: { declaracion: anualDocs.some(row => row.clase === 'declaracion'),
        acuse: anualDocs.some(row => row.clase === 'acuse'),
        estado: anualDocs.length ? 'recuperada' : 'sin-recuperar' },
      documentos: mine.map(row => ({ id: row.id, tipo: row.tipo, clase: row.clase, ejercicio: row.ejercicio,
        periodo: row.periodo, fechaPresentacion: row.fechaPresentacion, operacion: row.operacion,
        fileId: row.fileId, created: row.created, label: DECL_LABEL[row.tipo + ':' + row.clase] || 'Declaración' })),
      lastError: lastError ? { error: lastError.error, at: lastError.created } : null };
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
  function docLevel(issuedAt, time) {
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
    return fileId;
  }
  async function runSatDocAttempt(rfc, kind, time) {
    const state = satDocsState();
    state[rfc] = state[rfc] || {};
    state[rfc][kind + 'Attempt'] = time;
    saveSatDocsState(state);
    try {
      if (!satDocFetch) throw new Error('La descarga automática desde el portal del SAT no está disponible en esta instalación todavía: sube el PDF en esta pantalla y quedará archivado y vigilado igual.');
      const result = await satDocFetch({ rfc }, kind);
      const content = result?.content;
      if (!content || !(Buffer.isBuffer(content) ? content.length : String(content).length))
        throw new Error('El portal del SAT no devolvió el documento.');
      const issuedAt = result.issuedAt ? Date.parse(result.issuedAt) || time : time;
      archiveSatDoc(rfc, kind, content, issuedAt, 'auto', time, result.fileName);
      state[rfc][kind + 'Month'] = new Date(time).toISOString().slice(0, 7);
      saveSatDocsState(state);
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
          db.prepare('INSERT INTO mail_sends(at,recipients,subject,kind,ok,error) VALUES (?,?,?,?,1,\'\')')
            .run(time, recipients.length ? recipients.join(', ') : mail.recipient,
              DOC_KIND_LABEL[kind] + ' de ' + rfc, 'constancia');
        } catch (error) {
          queueAlert('satdoc-mail', 'satdoc-mail:' + rfc + ':' + kind + ':' + Math.floor(time / DAY),
            'PacoSAT · El documento se archivó pero el correo falló',
            '«' + DOC_KIND_LABEL[kind] + '» de ' + rfc + ' quedó en Expedientes, pero el envío por correo falló: ' + message(error), time);
        }
      }
      return { ok: true };
    } catch (error) {
      db.prepare('INSERT INTO sat_documents(id,rfc,kind,issuedAt,fileId,source,created,error) VALUES (?,?,?,?,?,?,?,?)')
        .run(randomUUID(), rfc, kind, 0, '', 'auto', time, message(error));
      queueAlert('satdoc-fail', 'satdoc:' + rfc + ':' + kind + ':' + Math.floor(time / DAY),
        'PacoSAT · No se pudo descargar ' + DOC_KIND_LABEL[kind] + ' de ' + rfc,
        'El intento de descarga automática falló: ' + message(error) +
        ' El documento seguirá vigilado por antigüedad; también puedes subir el PDF a mano en el Centro SAT.', time);
      return { ok: false, error: message(error) };
    }
  }
  async function satDocsTick(time) {
    const config = satDocsConfig(), state = satDocsState();
    for (const profile of db.prepare('SELECT rfc FROM profiles').all()) {
      const item = config[profile.rfc];
      /* Alarma de antigüedad: roja y sin aviso esta semana → correo. */
      for (const kind of ['constancia', 'opinion']) {
        const latest = latestSatDoc(profile.rfc, kind);
        if (latest && docLevel(latest.issuedAt, time) === 'bad')
          queueAlert('satdoc-old', 'satdoc-old:' + profile.rfc + ':' + kind + ':' + Math.floor(time / (7 * DAY)),
            'PacoSAT · ' + DOC_KIND_LABEL[kind] + ' de ' + profile.rfc + ' lleva más de 90 días',
            'La última emisión archivada es del ' + day(latest.issuedAt) + '. Renueva el documento: si la descarga automática está activa, PacoSAT lo intenta solo; si no, súbelo en el Centro SAT.', time);
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
        view[kind] = latest ? { issuedAt: latest.issuedAt, ageDays: Math.floor((time - latest.issuedAt) / DAY),
          level: docLevel(latest.issuedAt, time), source: latest.source } : null;
        const failure = db.prepare("SELECT error,created FROM sat_documents WHERE rfc=? AND kind=? AND error<>'' ORDER BY created DESC LIMIT 1")
          .get(profile.rfc, kind);
        if (failure && (!latest || failure.created >= latest.created)) view.lastError = failure.error;
      }
      view.lastAttempt = Math.max(state[profile.rfc]?.constanciaAttempt || 0, state[profile.rfc]?.opinionAttempt || 0);
      return view;
    });
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
        await reportsTick(time);
        moneyTick(time);
        fiscalTick(time);
      }
      await scanWatchFolder(time);
      await runScheduledBackup(time);
      if (!isResting) {
        checkExternalCopyAge(time);
        await notify(time);
        await sendAlerts(time);
      }
    } finally { busy = false; tickStartedAt = 0; }
  }

  async function handle(req, res) {
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
        return res.end("self.addEventListener('install',e=>{self.skipWaiting()});" +
          "self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.map(k=>caches.delete(k)))).then(()=>self.clients.claim()))});" +
          "self.addEventListener('fetch',e=>{});");
      }
      /* Entrada del invitado (1.7.0): la misma app con una meta que la
         pone en modo invitado; el token llega tras el login. */
      if (req.method === 'GET' && url.pathname === '/invitado') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(html.replace('<!--PACOSAT_TOKEN-->', '<meta name="pacosat-guest" content="1">' +
          (cloud ? '<meta name="pacosat-cloud" content="1">' : '')));
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
      /* Autenticación: el token principal (administrador) o una
         sesión de invitado viva (solo lectura, guarda más abajo). */
      const presented = req.headers['x-pacosat-token'];
      let guest = false;
      if (presented !== token) {
        const sessions = guestSessions();
        if (presented && sessions[presented] > now()) guest = true;
        else need(false, 'Sesión local inválida.', 403);
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
      if (req.method === 'GET' && url.pathname === '/api/status') {
        const data = overview();
        if (gScope) {
          const inScope = row => !row?.rfc || gScope.has(String(row.rfc).toUpperCase());
          if (Array.isArray(data.profiles)) data.profiles = data.profiles.filter(inScope);
          if (Array.isArray(data.jobs)) data.jobs = data.jobs.filter(inScope);
          if (Array.isArray(data.coverage)) data.coverage = data.coverage.filter(inScope);
          if (Array.isArray(data.inbox)) data.inbox = data.inbox.filter(inScope);
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
      if (req.method === 'POST' && url.pathname === '/api/monitor/summary') {
        /* Resumen de la Vigilancia SAT: las cifras de las tarjetas,
           contadas sobre TODA la selección del contribuyente. */
        const { ids = [] } = await body(req);
        need(Array.isArray(ids) && ids.length <= 20000 && ids.every(id => typeof id === 'string' && id.length === 36),
          'Selección de resumen inválida.');
        return json(res, monitor.summary(ids));
      }
      if (req.method === 'POST' && url.pathname === '/api/monitor/check-now') {
        /* «Revisar mis CFDI ahora»: encola los pedidos sin respuesta y
           procesa una tanda; la pantalla encadena llamadas con el
           indicador de actividad hasta agotar la cola. */
        const { ids = [] } = await body(req);
        need(Array.isArray(ids) && ids.length <= 20000 && ids.every(id => typeof id === 'string' && id.length === 36),
          'Selección de revisión inválida.');
        const queued = monitor.checkNow(ids);
        const batch = await monitor.processNow(10);
        return json(res, { queued, ...batch });
      }
      if (req.method === 'POST' && url.pathname === '/api/monitor/refresh-lists') {
        /* «Actualizar listados»: fuerza la descarga del listado 69-B
           que usa la vigilancia (el de la pantalla de Listas negras va
           por /api/lists/refresh). */
        return json(res, { lists: await monitor.refreshLists() });
      }
      if (req.method === 'GET' && url.pathname === '/api/lists') return json(res, listsOverview());
      if (req.method === 'POST' && url.pathname === '/api/lists/refresh') {
        /* Actualizar ahora: marca como vencidos los listados pedidos (o
           todos) y corre el ciclo de listas en el acto. */
        const x = await body(req);
        need(!listsBusy, 'Ya hay una actualización de listados en curso: espera a que termine.', 409);
        for (const source of LIST_CATALOG) {
          if (x.listId && source.id !== x.listId) continue;
          if (!source.url) continue;
          db.prepare('INSERT INTO blacklist_meta(listId,next) VALUES (?,0) ON CONFLICT(listId) DO UPDATE SET next=0')
            .run(source.id);
        }
        await listsTick(now(), listFetch || undefined);
        return json(res, listsOverview());
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
      if (req.method === 'GET' && url.pathname === '/api/satdocs') return json(res, { profiles: satDocsOverview(now()) });
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
        for (const kind of kinds) results[kind] = await runSatDocAttempt(x.rfc, kind, now());
        return json(res, { results, profiles: satDocsOverview(now()) });
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
        const config = { nora: clean(x.nora), weekly: clean(x.weekly) };
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
        const pack = buildMonthlyPackage(x.month);
        const result = await sendAppMail({ to: config.nora?.recipients || '', subject: 'PacoSAT · Informe mensual ' + x.month,
          text: 'Adjunto el paquete del mes ' + x.month + ' generado por PacoSAT (índice, XML, documentos, base DIOT, novedades de listas y PPD).',
          attachments: [{ filename: pack.filename, content: pack.buffer }] }, 'nora', now());
        return json(res, { ok: true, recipients: result.recipients, counts: pack.counts });
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
      if (req.method === 'GET' && url.pathname === '/api/guest/config') {
        const config = guestConfig();
        return json(res, { enabled: Boolean(config.enabled), hasPassword: Boolean(config.hash),
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
        if (Array.isArray(x.rfcs)) {
          need(x.rfcs.length <= 24, 'Demasiados RFC en el alcance del invitado.');
          config.rfcs = [...new Set(x.rfcs.map(rfc => String(rfc).toUpperCase().trim()).filter(rfc => /^[A-ZÑ&0-9]{12,13}$/.test(rfc)))];
        }
        setState('guest-config', JSON.stringify(config));
        logAccess('guest-config', (config.enabled ? 'Invitado activado' : 'Invitado desactivado') +
          (config.rfcs?.length ? ' · alcance: ' + config.rfcs.join(', ') : ' · sin límite por RFC'));
        return json(res, { enabled: Boolean(config.enabled), hasPassword: Boolean(config.hash),
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
          return json(res, banksOverview());
        }
        need(String(x.bank || '').trim().length >= 2, 'Escribe el banco.');
        need(String(x.name || '').trim().length >= 2, 'Ponle un nombre a la cuenta (p. ej. Cuenta principal).');
        const id = 'bank-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
        db.prepare('INSERT INTO bank_accounts(id,bank,name,last4,kind,created) VALUES (?,?,?,?,?,?)')
          .run(id, String(x.bank).trim().slice(0, 60), String(x.name).trim().slice(0, 80),
            String(x.last4 || '').replace(/\D/g, '').slice(-4), String(x.kind || '').slice(0, 40), now());
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
           el mismo cálculo en modo local). */
        let balances = moneyBalances().filter(item => item.balance > 0n || item.method === 'PPD');
        let expected = expectedInvoices(now());
        if (gScope) {
          balances = balances.filter(item => gScope.has(String(item.from?.rfc || '').toUpperCase()) ||
            gScope.has(String(item.to?.rfc || '').toUpperCase()));
          expected = []; /* las esperadas se calculan entre todos los RFC: fuera del alcance */
        }
        return json(res, { balances: balances.map(item => ({ ...item, total: moneyText(item.total),
            paid: moneyText(item.paid), balance: moneyText(item.balance) })),
          expected });
      }
      if (req.method === 'POST' && url.pathname === '/api/money/mark-paid') {
        /* «Marcar como pagado» directo (1.9.0, visor de comprobantes):
           registra el pago manual por el saldo vivo, igual que el
           cierre rápido del Centro de Avisos pero sin pasar por un
           aviso. Queda en manual_payments y alimenta los saldos. */
        const x = await body(req);
        const balance = moneyBalances().find(item => item.id === String(x.uuid || ''));
        need(balance, 'Ese comprobante no está en el expediente.', 404);
        need(balance.balance > 0n, 'Ese comprobante ya no tiene saldo pendiente.');
        const notaFinal = (x.fecha ? String(x.fecha) + ' · ' : '') +
          (String(x.nota || '').trim() || 'Pago marcado desde el Visor de comprobantes (' + day(now()) + ')');
        db.prepare('INSERT INTO manual_payments(uuid,at,nota,importe) VALUES (?,?,?,?) ' +
          'ON CONFLICT(uuid) DO UPDATE SET at=excluded.at,nota=excluded.nota,importe=excluded.importe')
          .run(balance.id, now(), notaFinal.slice(0, 300), moneyText(balance.balance));
        const after = moneyBalances().find(item => item.id === balance.id);
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
      if (req.method === 'POST' && url.pathname === '/api/declaraciones/run') {
        const x = await body(req);
        need(db.prepare('SELECT 1 FROM profiles WHERE rfc=?').get(String(x.rfc || '')), 'Ese RFC no tiene perfil en PacoSAT.', 404);
        need(['mensual', 'anual'].includes(x.tipo), 'Tipo de declaración inválido.');
        const ejercicio = Number(x.ejercicio);
        need(Number.isInteger(ejercicio) && ejercicio >= 2015 && ejercicio <= 2100, 'Ejercicio inválido.');
        const result = await runDeclaracionesAttempt(String(x.rfc),
          { tipo: x.tipo, ejercicio, periodo: String(x.periodo || '') }, now());
        return json(res, { result, view: declaracionesOverview(String(x.rfc), ejercicio, now()) });
      }
      if (req.method === 'GET' && url.pathname === '/api/reports/checklist') {
        const month = String(url.searchParams.get('month') || mxParts(now()).monthKey);
        need(/^\d{4}-\d{2}$/.test(month), 'Mes inválido.');
        return json(res, monthChecklist(month, now()));
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
        need(until === 0 || (until > now() && until < now() + 366 * DAY), 'Fecha de reactivación inválida.');
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
      if (req.method === 'POST' && url.pathname === '/api/mail') {
        const x = await body(req);
        if (x.enabled === false) { mail = undefined; return json(res, overview()); }
        await configureMail(x);
        return json(res, overview());
      }
      need(false, 'Ruta no encontrada.', 404);
    } catch (error) {
      if (!res.headersSent && !res.destroyed) json(res, { error: message(error),
        ...(error.guard ? { guard: error.guard } : {}) }, error.status || 502);
    }
  }
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
        timeoutMs: 90_000 }) }),
    /* Declaraciones y acuses (1.9.0, punto 7): dos conectores
       (mensuales y anuales) sobre la misma sesión del navegador. */
    satDeclFetch: createSatDeclFetch({
      resolveCredentials: createSatDocCredentialResolver({ storage: createFileEfirmaStorage(
        process.env.PACOSAT_EFIRMA_DIR || join(path, 'efirma')) }),
      launchDriver: createPlaywrightDriverFactory({
        executablePath: process.env.PACOSAT_CHROMIUM_PATH || '/usr/bin/chromium' }) }),
    buildModified: statSync(new URL('./Faro-Fiscal.html', import.meta.url)).mtimeMs });
  const server = createServer(service.handle);
  server.requestTimeout = 300000;
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
