import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSatConnector, advanceSatJob } from './sat-direct.mjs';
import { parseXml, zipXml, validateRfc } from './xml-core.mjs';
import { analyzeInvoicePdf } from './pdf-invoice.mjs';
import { createMonitor } from './sat-monitor.mjs';
import { encryptBackupBuffer, decryptBackupBuffer } from './backup-core.mjs';

/* El RFC se valida con validateRfc (xml-core): un solo criterio en todo el sistema. */
const DAY = 86400000;
const MIN = 60000;
const formatDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit', day: '2-digit' });
const day = (date = Date.now()) => formatDay.format(date);
const clock = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Mexico_City', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const email = /^[a-z0-9.!#$%&'*+/=?^_\x60{|}~-]+@[a-z0-9.-]+\.[a-z]{2,63}$/i;
const MAX_BODY = 192 * 1024;
const validDate = input => /^\d{4}-\d{2}-\d{2}$/.test(input || '') && Number.isFinite(Date.parse(input)) && new Date(input).toISOString().slice(0, 10) === input;

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
  analyzePdf = analyzeInvoicePdf, now = Date.now, monitorOptions = {}, watchDir = '', inboxParser = null, watchSettleMs = 2000 }) {
  const db = new DatabaseSync(dbFile);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
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
      learnedAt INTEGER NOT NULL, detail TEXT NOT NULL DEFAULT '');`);
  const token = randomBytes(32).toString('hex');
  const monitor = createMonitor(db, { now, notifyCancellation: async item => {
    if (!mail) return false;
    await mail.transport.sendMail({ from: mail.from, to: mail.recipient,
      subject: 'PacoSAT · CFDI cancelado detectado',
      text: 'El SAT reportó como cancelado el folio ' + item.id + '. Emisor: ' + item.emitter + '. Receptor: ' + item.receiver + '.',
      messageId: '<pacosat-cancelado-' + item.id.toLowerCase() + '@pacosat.local>' });
    return true;
  }, notifyEfos: async alert => {
    if (!mail) return false;
    await mail.transport.sendMail({ from: mail.from, to: mail.recipient,
      subject: 'PacoSAT · Nuevo RFC en el listado 69-B',
      text: 'El RFC ' + alert.rfc + ' apareció en el listado oficial del artículo 69-B con la situación: ' + alert.statuses.join(', ') +
        '. Es emisor o receptor de CFDI de tu expediente. Revisa los comprobantes relacionados en Vigilancia SAT.',
      messageId: '<pacosat-69b-' + alert.rfc.toLowerCase() + '-' + alert.statuses.join('-').toLowerCase().replaceAll(' ', '-') + '@pacosat.local>' });
    return true;
  }, ...monitorOptions });
  const host = new URL(origin).host;
  const unlocked = new Map();
  let mail, busy = false, storageRevision = 0;
  const cloud = Boolean(proxyKey);
  const stores = ['people', 'invoices', 'documents', 'files', 'activity'];
  const insertRecord = db.prepare('INSERT OR IGNORE INTO records(store,id,value,data,mime) VALUES (?,?,?,?,?)');
  const putMetadata = (store, row) => insertRecord.run(store, row.id, JSON.stringify(row), null, null);
  const putFile = (id, data, mime) => insertRecord.run('files', id, null, data, mime);
  const getState = key => db.prepare('SELECT value FROM automation_state WHERE key=?').get(key)?.value || '';
  const setState = (key, value) => db.prepare('INSERT INTO automation_state(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value));
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
    return { rfc: job.rfc, direction: job.direction, type: 'cfdi', emitter: '', receiver: '',
      startAt: job.startAt || job.periodStart + ' 00:00:00',
      endAt: job.endAt || job.periodEnd + ' 23:59:59' };
  }
  function criteriaInfo(criteria) {
    const key = pacosatCriteriaKey(criteria);
    const row = db.prepare('SELECT COUNT(*) AS count, MIN(sentAt) AS first FROM criteria WHERE key=?').get(key);
    const count = row?.count || 0;
    const exhausted = Boolean(db.prepare('SELECT 1 FROM criteria_exhausted WHERE key=?').get(key));
    return { key, count, firstSentAt: row?.first || null, exhausted,
      state: exhausted || count >= 2 ? 'agotado' : count === 1 ? 'ultima' : 'disponible' };
  }
  function guardError(info, criteria, text) {
    return Object.assign(new Error(text), { status: 409, guard: {
      state: info.state, count: info.count, firstSentAt: info.firstSentAt,
      startAt: criteria.startAt, endAt: criteria.endAt,
      shiftedStartAt: pacosatShiftSecond(criteria.startAt), message: text } });
  }
  function learnCriteria5002(job, time) {
    const info = criteriaInfo(criteriaFromJob(job));
    db.prepare('INSERT OR IGNORE INTO criteria_exhausted(key,learnedAt,detail) VALUES (?,?,?)')
      .run(info.key, time, job.requestId);
    queueAlert('criteria-5002', 'criteria:' + info.key, 'PacoSAT · El SAT agotó las solicitudes de un periodo (5002)',
      'Al verificar la solicitud ' + job.requestId + ' del RFC ' + job.rfc + ' (' + job.periodStart + ' a ' + job.periodEnd +
      ', ' + (job.direction === 'received' ? 'recibidos' : 'emitidos') + '), el SAT devolvió el código 5002: las solicitudes ' +
      'con ese mismo criterio están agotadas de por vida, aunque el gasto viniera de otra aplicación. PacoSAT ya no enviará ' +
      'ese criterio; para ese periodo usa una ventana desplazada al menos un segundo o revisa el histórico con metadatos.', time);
  }
  /* Migración suave: las solicitudes previas a 1.6.2 solo guardaban fechas.
     Se reconstruyen los segundos con la misma regla con la que se enviaron
     (cierre 23:59:59 en periodos pasados; hora del envío si el cierre era el
     día de creación) y el libro se siembra una sola vez desde jobs, sin
     perder ni duplicar ninguna solicitud ya enviada. */
  tx(db, () => {
    const jobColumns = db.prepare('PRAGMA table_info(jobs)').all().map(row => row.name);
    if (!jobColumns.includes('startAt')) db.exec("ALTER TABLE jobs ADD COLUMN startAt TEXT NOT NULL DEFAULT ''");
    if (!jobColumns.includes('endAt')) db.exec("ALTER TABLE jobs ADD COLUMN endAt TEXT NOT NULL DEFAULT ''");
    /* 1.6.4: contador de verificaciones pendientes por solicitud, para la
       espera creciente (backoff) de verifyJobs. */
    if (!jobColumns.includes('checks')) db.exec("ALTER TABLE jobs ADD COLUMN checks INTEGER NOT NULL DEFAULT 0");
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

  async function bootstrap(config) {
    for (const row of config.profiles || []) {
      try {
        need(validateRfc(row.rfc || '').level !== 'structure' && typeof row.name === 'string' && row.name.length > 0 && row.name.length <= 120 &&
          [60,120,240,720,1440].includes(row.minutes) && Number.isInteger(row.days) && row.days >= 1 && row.days <= 31 &&
          ['received','issued','both'].includes(row.direction), 'Perfil inicial inválido.');
        const certificate = readFileSync(row.certificatePath), privateKey = readFileSync(row.keyPath);
        let active;
        try { active = await makeConnector({ rfc: row.rfc, certificate, privateKey, password: row.password }); }
        finally { certificate.fill(0); privateKey.fill(0); }
        db.prepare("INSERT INTO profiles(rfc,minutes,days,direction,nextRun,error) VALUES (?,?,?,?,0,'') ON CONFLICT(rfc) DO UPDATE SET minutes=excluded.minutes,days=excluded.days,direction=excluded.direction,error='' ")
          .run(row.rfc, row.minutes, row.days, row.direction);
        putMetadata('people', { id: row.rfc, name: row.name });
        unlocked.set(row.rfc, active);
      } catch { console.error('PacoSAT: un perfil de e.firma del archivo de arranque no pudo activarse.'); }
    }
    if (config.watchFolder?.path) inbox.dir = String(config.watchFolder.path);
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
    mail = { transport, from: x.from, recipient: x.recipient, instance: token.slice(0, 16) };
  }

  function overview() {
    return {
      cloudRevision: cloud ? storageRevision + ':' + db.prepare('SELECT COALESCE(MAX(rowid),0) AS value FROM records').get().value : null,
      profiles: db.prepare('SELECT * FROM profiles ORDER BY rfc').all().map(row => ({ ...row, unlocked: unlocked.has(row.rfc) })),
      jobs: db.prepare('SELECT id,rfc,direction,periodStart,periodEnd,startAt,endAt,status,due,created,error,checks FROM jobs ORDER BY id DESC LIMIT 35').all()
        .map(row => { const info = criteriaInfo(criteriaFromJob(row));
          return { ...row, criteriaState: info.state, criteriaCount: info.count }; }),
      inbox: db.prepare('SELECT id,rfc,newCount,review FROM packages WHERE archive IS NOT NULL ORDER BY id LIMIT 50').all(),
      mail: { enabled: Boolean(mail), recipient: mail?.recipient || '', error: db.prepare("SELECT error FROM notices WHERE sent IS NULL AND error<>'' ORDER BY id DESC LIMIT 1").get()?.error || '' },
      watchFolder: { enabled: Boolean(inbox.dir), lastScan: inboxStatus.lastScan, imported: inboxStatus.imported,
        failed: inboxStatus.failed, incidents: inboxStatus.incidents, waiting: inboxStatus.waiting,
        subfolders: true, error: inboxStatus.error || getState('watch:error') },
      scheduledBackup: { enabled: Boolean(backupJob), frequency: backupJob?.frequency || '',
        last: Number(getState('backup:last')) || null, next: Number(getState('backup:next')) || null, error: getState('backup:error'),
        secondary: Boolean(backupJob?.secondaryDir), secondaryError: getState('backup:secondaryError'),
        verify: (() => { try { return JSON.parse(getState('backup:verify') || 'null'); } catch { return null; } })() },
      coverage: computeCoverage()
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
      const record = insertPackage.run(job.id, id, job.rfc, !cloud && (count || review) ? archive : null, count, review);
      if (mail && count && job.direction === 'received') {
        db.prepare('INSERT INTO notices(package,rfc,recipient,count,due) VALUES (?,?,?,?,?)')
          .run(record.lastInsertRowid, job.rfc, mail.recipient, count, now());
      }
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
    ['profiles', ['rfc', 'minutes', 'days', 'direction', 'nextRun', 'error']],
    ['jobs', ['id', 'rfc', 'direction', 'periodStart', 'periodEnd', 'startAt', 'endAt', 'requestId', 'status', 'imported', 'due', 'created', 'error', 'checks']],
    ['packages', ['id', 'job', 'remoteId', 'rfc', 'newCount', 'review']],
    ['notices', ['id', 'package', 'rfc', 'recipient', 'count', 'due', 'sent', 'error']],
    ['criteria', ['id', 'key', 'rfc', 'direction', 'type', 'emitter', 'receiver', 'startAt', 'endAt', 'requestId', 'origin', 'sentAt']],
    ['criteria_exhausted', ['key', 'learnedAt', 'detail']],
    ['alerts', ['id', 'kind', 'ref', 'subject', 'body', 'due', 'sent', 'error']],
    ['alert_state', ['key', 'failures', 'alerted']],
    ['automation_state', ['key', 'value']],
    ['discovered', ['rfc', 'uuid']],
    ['cfdi_watch', ['id', 'emitter', 'receiver', 'total', 'seal', 'next', 'checked', 'result', 'error']],
    ['cancellation_alert', ['id', 'due', 'sent']],
    ['efos_alert', ['key', 'rfc', 'due', 'sent']],
    ['efos_meta', ['id', 'fetched', 'next', 'error']]
  ];
  const tableExists = name => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  function dumpOperations() {
    const dump = { version: 1, packagesArchiveOmitted: true, efosListOmitted: true };
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
        for (const row of operations[name]) insert.run(...columns.map(column => row[column] === undefined ? null : row[column]));
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
      const importXml = raw => {
        const row = parseXml(raw, Parser);
        need(peopleIds.has(row.from.rfc) || peopleIds.has(row.to.rfc), 'Los RFC del comprobante no están registrados.');
        if (db.prepare("SELECT 1 FROM records WHERE store='invoices' AND id=?").get(row.id)) return 'duplicate';
        putFile('xml:' + row.id, raw, 'application/xml');
        putMetadata('invoices', row);
        monitor.register({ id: row.id, emitter: row.from.rfc, receiver: row.to.rfc, total: row.total,
          seal: /^[A-Za-z0-9+/=]{8}$/.test(row.seal) ? row.seal : '' });
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
    } finally { watchBusy = false; }
  }

  async function schedule(profile, service, time) {
    const directions = profile.direction === 'both' ? ['received', 'issued'] : [profile.direction];
    const end = day(time), start = day(time - (profile.days - 1) * DAY);
    db.prepare('UPDATE profiles SET nextRun=?,error=? WHERE rfc=?').run(time + profile.minutes * MIN, '', profile.rfc);
    for (const direction of directions) {
      try {
        if (db.prepare("SELECT 1 FROM jobs WHERE rfc=? AND direction=? AND status='pending'").get(profile.rfc, direction)) continue;
        let startAt = start + ' 00:00:00';
        const endAt = end + ' ' + clock.format(time);
        const criteria = { rfc: profile.rfc, direction, type: 'cfdi', emitter: '', receiver: '', startAt, endAt };
        let info = criteriaInfo(criteria);
        if (info.state !== 'disponible') {
          /* Red de seguridad del blindaje 5002 en la programación: las
             ventanas avanzan y no deberían colisionar nunca; si el criterio
             ya se solicitó, se desplaza el inicio +1 s (las veces que haga
             falta), se anota en la bitácora y se sigue. Jamás se envía un
             duplicado en silencio ni se detiene la programación sin rastro. */
          const original = startAt;
          let shifts = 0;
          while (info.state !== 'disponible' && shifts < 10) {
            startAt = pacosatShiftSecond(startAt); shifts++;
            info = criteriaInfo({ ...criteria, startAt });
          }
          need(info.state === 'disponible', 'No se encontró un criterio libre para la descarga programada.');
          putMetadata('activity', { id: 'guard5002:' + profile.rfc + ':' + direction + ':' + time,
            name: 'Blindaje SAT 5002 · ' + profile.rfc, date: new Date(time).toISOString(),
            added: 0, duplicates: 0, review: 0, issues: [],
            event: 'La descarga programada coincidía con un criterio ya solicitado (' + original + ' a ' + endAt +
              '); el inicio se desplazó a ' + startAt + ' (+' + shifts + ' s) para no agotar las solicitudes del SAT (error 5002).' });
          storageRevision++;
        }
        const requestId = await service.request({ start, end, startTime: startAt.slice(11), endTime: clock.format(time), direction });
        db.prepare('INSERT INTO jobs(rfc,direction,periodStart,periodEnd,startAt,endAt,requestId,status,due,created) VALUES (?,?,?,?,?,?,?,?,?,?)')
          .run(profile.rfc, direction, start, end, startAt, endAt, requestId, 'pending', time + 5 * MIN, time);
        insertCriteria.run(pacosatCriteriaKey({ ...criteria, startAt }), profile.rfc, direction, 'cfdi', '', '',
          startAt, endAt, requestId, 'scheduled', time);
      } catch (error) {
        db.prepare('UPDATE profiles SET error=? WHERE rfc=?').run(message(error), profile.rfc);
      }
    }
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
          ({ id, archive }) => inspectPackage(job, id, archive, active.parser));
        db.prepare('UPDATE jobs SET error=? WHERE id=?').run('', job.id);
        if (advanced?.satCode === 5002) learnCriteria5002(job, time);
      } catch (error) { db.prepare('UPDATE jobs SET error=? WHERE id=?').run(message(error), job.id); }
      const after = db.prepare('SELECT status,error FROM jobs WHERE id=?').get(job.id);
      if (after && ['expired', 'failed', 'rejected'].includes(after.status)) terminal.push({ ...job, afterStatus: after.status });
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
          from: active.from, to: item.recipient,
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
  async function sendAlerts(time) {
    if (!mail) return;
    const active = mail;
    const items = db.prepare('SELECT * FROM alerts WHERE due<=? AND sent IS NULL ORDER BY id LIMIT 10').all(time);
    for (const item of items) {
      db.prepare('UPDATE alerts SET due=? WHERE id=?').run(time + 15 * MIN, item.id);
      try {
        await active.transport.sendMail({ from: active.from, to: active.recipient, subject: item.subject, text: item.body,
          messageId: '<pacosat-alerta-' + item.id + '-' + active.instance + '@pacosat.local>' });
        db.prepare('UPDATE alerts SET sent=?,error=? WHERE id=?').run(now(), '', item.id);
      } catch { db.prepare('UPDATE alerts SET error=? WHERE id=?').run('El servidor SMTP no aceptó el envío. Revisa la configuración y las credenciales.', item.id); }
    }
  }
  async function tick() {
    if (busy) return;
    busy = true;
    try {
      const time = now();
      for (const profile of db.prepare('SELECT * FROM profiles').all()) {
        const active = unlocked.get(profile.rfc);
        if (!active) continue;
        const outcome = await verifyJobs(profile, active, time);
        for (const job of outcome.terminal) queueAlert('job-terminal', 'job:' + job.id,
          'PacoSAT · Una solicitud al SAT quedó ' + (jobStateLabel[job.afterStatus] || job.afterStatus),
          'La solicitud del RFC ' + job.rfc + ' para el periodo ' + job.periodStart + ' a ' + job.periodEnd + ' quedó ' +
          (jobStateLabel[job.afterStatus] || job.afterStatus) + ' en el SAT y no entregará paquetes. Crea una solicitud nueva para un periodo ' +
          'distinto desde el Centro SAT; no reintentes la misma, porque el SAT limita las solicitudes por periodo.', time);
        const scheduleAttempted = profile.nextRun <= time;
        if (scheduleAttempted) await schedule(profile, active.connector, time);
        const profileError = scheduleAttempted ? (db.prepare('SELECT error FROM profiles WHERE rfc=?').get(profile.rfc)?.error || '') : '';
        noteDownloadOutcome(profile.rfc, scheduleAttempted || outcome.attempted > 0,
          Boolean(profileError) || outcome.stuck > 0, time);
      }
      reconcileCoverageGaps(time);
      await scanWatchFolder(time);
      await runScheduledBackup(time);
      await notify(time);
      await sendAlerts(time);
    } finally { busy = false; }
  }

  async function handle(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; frame-src blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
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
      need(req.headers['x-pacosat-token'] === token, 'Sesión local inválida.', 403);
      if (req.method === 'POST') need(req.headers.origin === origin, 'Origen inválido.', 403);
      if (req.method === 'GET' && url.pathname === '/api/status') return json(res, overview());
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
      if (req.method === 'POST' && url.pathname === '/api/monitor') {
        const { ids = [], records = [] } = await body(req);
        need(Array.isArray(ids) && ids.length <= 500 && ids.every(id => typeof id === 'string' && id.length === 36) &&
          Array.isArray(records) && records.length <= 150, 'Lote de vigilancia inválido.');
        try { tx(db, () => records.forEach(monitor.register)); }
        catch (error) { need(false, message(error)); }
        return json(res, monitor.status(ids));
      }
      if (req.method === 'POST' && url.pathname === '/api/pdf-analyze') {
        const { data } = await body(req, 21 * 1024 * 1024);
        need(typeof data === 'string' && data.length <= 20 * 1024 * 1024, 'PDF demasiado grande.');
        try { return json(res, await analyzePdf(Buffer.from(data, 'base64'))); }
        catch (error) { need(false, message(error), error.status || 422); }
      }
      if (cloud && req.method === 'GET' && url.pathname === '/api/storage') {
        const store = url.searchParams.get('store'), id = url.searchParams.get('id');
        need(stores.includes(store), 'Tipo de almacenamiento inválido.');
        const records = id === null ? db.prepare('SELECT id,value,data,mime FROM records WHERE store=?').all(store) :
          db.prepare('SELECT id,value,data,mime FROM records WHERE store=? AND id=?').all(store,id);
        need(records.reduce((size, item) => size + (item.data?.byteLength || 0), 0) <= 100 * 1024 * 1024,
          'El respaldo supera el límite de 100 MB.', 413);
        const rows = records.map(row => row.data ? { id: row.id, mime: row.mime, content: Buffer.from(row.data).toString('base64') } : JSON.parse(row.value));
        return json(res, id === null ? rows : rows[0] || null);
      }
      if (cloud && req.method === 'POST' && url.pathname === '/api/storage') {
        const { batch, replace } = await body(req, 150 * 1024 * 1024);
        need(batch && typeof batch === 'object' && Object.keys(batch).length <= stores.length, 'Lote inválido.');
        tx(db, () => {
          for (const [store, rows] of Object.entries(batch)) {
            need(stores.includes(store) && Array.isArray(rows) && rows.length <= 50000, 'Lote inválido.');
            if (replace === true) db.prepare('DELETE FROM records WHERE store=?').run(store);
            for (const row of rows) {
              need(typeof row?.id === 'string' && row.id.length <= 220, 'Identificador inválido.');
              if (store === 'files') {
                need(typeof row.content === 'string' && row.content.length <= 20 * 1024 * 1024 &&
                  ['application/pdf','application/xml'].includes(row.mime), 'Archivo inválido.');
                putFile(row.id, Buffer.from(row.content, 'base64'), row.mime);
              } else db.prepare('INSERT INTO records(store,id,value,data,mime) VALUES (?,?,?,NULL,NULL) ON CONFLICT(store,id) DO UPDATE SET value=excluded.value').run(store, row.id, JSON.stringify(row));
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
      if (req.method === 'POST' && url.pathname === '/api/unlock') {
        const x = await body(req);
        const unlockShape = validateRfc(typeof x.rfc === 'string' ? x.rfc : '');
        need(unlockShape.level !== 'structure', unlockShape.error || 'RFC inválido.');
        need(Number.isInteger(x.minutes) && x.minutes >= 60 && x.minutes <= 1440, 'El intervalo debe ser de 60 a 1440 minutos.');
        need(Number.isInteger(x.days) && x.days >= 1 && x.days <= 31, 'El periodo de revisión debe ser de 1 a 31 días.');
        need(['received', 'issued', 'both'].includes(x.direction), 'Elige emitidos o recibidos.');
        need(typeof x.password === 'string' && x.password.length > 0 && x.password.length <= 256, 'Ingresa la contraseña de la e.firma.');
        const certificate = keyData(x.certificate), privateKey = keyData(x.key);
        let active;
        try { active = await makeConnector({ rfc: x.rfc, certificate, privateKey, password: x.password }); }
        catch (error) { need(false, message(error), 422); }
        finally { certificate.fill(0); privateKey.fill(0); x.password = ''; }
        db.prepare("INSERT INTO profiles(rfc,minutes,days,direction,nextRun,error) VALUES (?,?,?,?,?,?) ON CONFLICT(rfc) DO UPDATE SET minutes=excluded.minutes,days=excluded.days,direction=excluded.direction,error=''")
          .run(x.rfc, x.minutes, x.days, x.direction, 0, '');
        unlocked.set(x.rfc, active);
        return json(res, overview());
      }
      if (req.method === 'POST' && url.pathname === '/api/lock') {
        const x = await body(req);
        unlocked.delete(x.rfc);
        return json(res, overview());
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
      if (req.method === 'POST' && url.pathname === '/api/request') {
        const x = await body(req);
        const active = unlocked.get(x.rfc);
        need(active, 'Desbloquea la e.firma de este RFC.');
        need(validDate(x.start) && validDate(x.end) && x.start <= x.end && x.end <= day(now()), 'Selecciona un periodo válido hasta hoy.');
        need(Date.parse(x.end) - Date.parse(x.start) <= 92 * DAY, 'Selecciona un periodo de hasta 93 días.');
        need(['received', 'issued'].includes(x.direction), 'Dirección inválida.');
        need(!busy, 'PacoSAT está procesando otra solicitud. Intenta en unos segundos.', 409);
        /* Guardia previa del blindaje 5002: se compara el criterio exacto
           (con segundos) contra el libro antes de enviar nada al SAT. */
        const endTime = x.end === day(now()) ? clock.format(now()) : '23:59:59';
        let startAt = x.start + ' 00:00:00';
        if (x.shiftStart === true) startAt = pacosatShiftSecond(startAt);
        const endAt = x.end + ' ' + endTime;
        const criteria = { rfc: x.rfc, direction: x.direction, type: 'cfdi', emitter: '', receiver: '', startAt, endAt };
        const info = criteriaInfo(criteria);
        if (info.state === 'agotado') throw guardError(info, criteria,
          'Este criterio ya agotó sus solicitudes ante el SAT: una más recibiría el error 5002 ' +
          '(«Se han agotado las solicitudes de por vida»). No se envió nada.');
        if (info.state === 'ultima' && x.confirmRepeat !== true) throw guardError(info, criteria,
          'Este criterio ya se solicitó el ' + new Date(info.firstSentAt).toISOString().slice(0, 10) +
          '. Según el criterio de la comunidad técnica, el SAT admite dos solicitudes con el mismo criterio: ' +
          'repetirla gasta la última disponible y una tercera recibiría el error 5002.');
        busy = true;
        try {
          const prior = db.prepare("SELECT id FROM jobs WHERE rfc=? AND direction=? AND startAt=? AND endAt=? AND status='pending'")
            .get(x.rfc, x.direction, startAt, endAt);
          need(!prior, 'Ese criterio ya tiene una solicitud en curso.', 409);
          const requestId = await active.connector.request({ start: x.start, end: x.end, startTime: startAt.slice(11), endTime, direction: x.direction });
          db.prepare('INSERT INTO jobs(rfc,direction,periodStart,periodEnd,startAt,endAt,requestId,status,due,created) VALUES (?,?,?,?,?,?,?,?,?,?)')
            .run(x.rfc, x.direction, x.start, x.end, startAt, endAt, requestId, 'pending', now() + 5 * MIN, now());
          insertCriteria.run(info.key, x.rfc, x.direction, 'cfdi', '', '', startAt, endAt, requestId, 'manual', now());
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
  return { handle, tick, monitorTick: monitor.tick, inboxTick: (time = now()) => scanWatchFolder(time),
    backupTick: (time = now()) => runScheduledBackup(time), bootstrap, close: () => db.close() };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const path = process.env.PACOSAT_DATA_DIR || join(process.env.LOCALAPPDATA || homedir(), 'PacoSATLocal');
  mkdirSync(path, { recursive: true });
  const proxyKey = process.env.PACOSAT_PROXY_KEY || '';
  const origin = process.env.PACOSAT_ORIGIN || 'http://127.0.0.1:43729';
  need(origin === new URL(origin).origin && (!proxyKey || (proxyKey.length >= 32 && origin.startsWith('https://'))) &&
    (proxyKey || origin === 'http://127.0.0.1:43729'), 'Configuración de origen o proxy inválida.');
  const service = createPacoSATService({ dbFile: join(path, 'pacosat.sqlite'), html: readFileSync(new URL('./Faro-Fiscal.html', import.meta.url), 'utf8'), origin, proxyKey, watchDir: process.env.PACOSAT_WATCH_DIR || '' });
  const server = createServer(service.handle);
  server.requestTimeout = 90000;
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
