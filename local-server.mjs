import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSatConnector, advanceSatJob } from './sat-direct.mjs';
import { parseXml, zipXml } from './xml-core.mjs';
import { analyzeInvoicePdf } from './pdf-invoice.mjs';
import { createMonitor } from './sat-monitor.mjs';

const RFC = /^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/u;
const DAY = 86400000;
const MIN = 60000;
const formatDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit', day: '2-digit' });
const day = (date = Date.now()) => formatDay.format(date);
const clock = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Mexico_City', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const email = /^[a-z0-9.!#$%&'*+/=?^_\x60{|}~-]+@[a-z0-9.-]+\.[a-z]{2,63}$/i;
const MAX_BODY = 192 * 1024;
const validDate = input => /^\d{4}-\d{2}-\d{2}$/.test(input || '') && Number.isFinite(Date.parse(input)) && new Date(input).toISOString().slice(0, 10) === input;

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

export function createFaroService({ dbFile, html, origin, proxyKey = '', makeConnector = productionConnector, makeMailer,
  analyzePdf = analyzeInvoicePdf, now = Date.now, monitorOptions = {} }) {
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
      PRIMARY KEY(store,id));`);
  const token = randomBytes(32).toString('hex');
  const monitor = createMonitor(db, { now, notifyCancellation: async item => {
    if (!mail) return false;
    await mail.transport.sendMail({ from: mail.from, to: mail.recipient,
      subject: 'PacoSAT · CFDI cancelado detectado',
      text: 'El SAT reportó como cancelado el folio ' + item.id + '. Emisor: ' + item.emitter + '. Receptor: ' + item.receiver + '.',
      messageId: '<faro-cancelado-' + item.id.toLowerCase() + '@faro.local>' });
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
  const packageLookup = db.prepare('SELECT id FROM packages WHERE job=? AND remoteId=?');
  const insertPackage = db.prepare('INSERT INTO packages(job,remoteId,rfc,archive,newCount,review) VALUES (?,?,?,?,?,?)');
  const remember = db.prepare('INSERT OR IGNORE INTO discovered VALUES (?,?)');

  async function bootstrap(config) {
    for (const row of config.profiles || []) {
      try {
        need(RFC.test(row.rfc || '') && typeof row.name === 'string' && row.name.length > 0 && row.name.length <= 120 &&
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
      jobs: db.prepare('SELECT id,rfc,direction,periodStart,periodEnd,status,due,created,error FROM jobs ORDER BY id DESC LIMIT 35').all(),
      inbox: db.prepare('SELECT id,rfc,newCount,review FROM packages WHERE archive IS NOT NULL ORDER BY id LIMIT 50').all(),
      mail: { enabled: Boolean(mail), recipient: mail?.recipient || '', error: db.prepare("SELECT error FROM notices WHERE sent IS NULL AND error<>'' ORDER BY id DESC LIMIT 1").get()?.error || '' }
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

  async function schedule(profile, service, time) {
    const directions = profile.direction === 'both' ? ['received', 'issued'] : [profile.direction];
    const end = day(time), start = day(time - (profile.days - 1) * DAY);
    db.prepare('UPDATE profiles SET nextRun=?,error=? WHERE rfc=?').run(time + profile.minutes * MIN, '', profile.rfc);
    for (const direction of directions) {
      try {
        if (db.prepare("SELECT 1 FROM jobs WHERE rfc=? AND direction=? AND status='pending'").get(profile.rfc, direction)) continue;
        const requestId = await service.request({ start, end, endTime: clock.format(time), direction });
        db.prepare('INSERT INTO jobs(rfc,direction,periodStart,periodEnd,requestId,status,due,created) VALUES (?,?,?,?,?,?,?,?)')
          .run(profile.rfc, direction, start, end, requestId, 'pending', time + 5 * MIN, time);
      } catch (error) {
        db.prepare('UPDATE profiles SET error=? WHERE rfc=?').run(message(error), profile.rfc);
      }
    }
  }

  async function verifyJobs(profile, active, time) {
    const jobs = db.prepare("SELECT * FROM jobs WHERE rfc=? AND status='pending' AND due<=? ORDER BY id").all(profile.rfc, time);
    for (const job of jobs) {
      db.prepare('UPDATE jobs SET due=? WHERE id=?').run(time + 5 * MIN, job.id);
      const save = async next => db.prepare('UPDATE jobs SET imported=?,status=?,error=? WHERE id=?')
        .run(JSON.stringify(next.imported || []), next.status, '', job.id);
      try {
        await advanceSatJob(active.connector, { ...job, imported: JSON.parse(job.imported) }, save,
          ({ id, archive }) => inspectPackage(job, id, archive, active.parser));
        db.prepare('UPDATE jobs SET error=? WHERE id=?').run('', job.id);
      } catch (error) { db.prepare('UPDATE jobs SET error=? WHERE id=?').run(message(error), job.id); }
    }
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
          messageId: '<faro-' + item.id + '-' + active.instance + '@faro.local>'
        });
        db.prepare('UPDATE notices SET sent=?,error=? WHERE id=?').run(now(), '', item.id);
      } catch { db.prepare('UPDATE notices SET error=? WHERE id=?').run('El servidor SMTP no aceptó el envío. Revisa la configuración y las credenciales.', item.id); }
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
        await verifyJobs(profile, active, time);
        if (profile.nextRun <= time) await schedule(profile, active.connector, time);
      }
      await notify(time);
    } finally { busy = false; }
  }

  async function handle(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; frame-src blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    try {
      need(req.headers.host === host, 'Host inválido.', 403);
      if (cloud) need(req.headers['x-faro-proxy'] === proxyKey, 'Acceso reservado al proxy HTTPS.', 403);
      need(!req.headers['sec-fetch-site'] || ['same-origin','none'].includes(req.headers['sec-fetch-site']), 'Origen inválido.', 403);
      const url = new URL(req.url, origin);
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(html.replace('<!--FARO_TOKEN-->', '<meta name="faro-token" content="' + token + '">' +
          (cloud ? '<meta name="faro-cloud" content="1">' : '')));
      }
      need(req.headers['x-faro-token'] === token, 'Sesión local inválida.', 403);
      if (req.method === 'POST') need(req.headers.origin === origin, 'Origen inválido.', 403);
      if (req.method === 'GET' && url.pathname === '/api/status') return json(res, overview());
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
        need(typeof x.rfc === 'string' && RFC.test(x.rfc), 'RFC inválido.');
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
        busy = true;
        try {
          const prior = db.prepare("SELECT id FROM jobs WHERE rfc=? AND direction=? AND periodStart=? AND periodEnd=? AND status IN ('pending','finished')").get(x.rfc, x.direction, x.start, x.end);
          need(!prior, 'Ese periodo ya tiene una solicitud registrada.', 409);
          const requestId = await active.connector.request({ ...x, endTime: x.end === day(now()) ? clock.format(now()) : '23:59:59' });
          db.prepare('INSERT INTO jobs(rfc,direction,periodStart,periodEnd,requestId,status,due,created) VALUES (?,?,?,?,?,?,?,?)')
            .run(x.rfc, x.direction, x.start, x.end, requestId, 'pending', now() + 5 * MIN, now());
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
      if (!res.headersSent && !res.destroyed) json(res, { error: message(error) }, error.status || 502);
    }
  }
  return { handle, tick, monitorTick: monitor.tick, bootstrap, close: () => db.close() };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const path = process.env.PACOSAT_DATA_DIR || join(process.env.LOCALAPPDATA || homedir(), 'FaroFiscalLocal');
  mkdirSync(path, { recursive: true });
  const proxyKey = process.env.PACOSAT_PROXY_KEY || '';
  const origin = process.env.PACOSAT_ORIGIN || 'http://127.0.0.1:43729';
  need(origin === new URL(origin).origin && (!proxyKey || (proxyKey.length >= 32 && origin.startsWith('https://'))) &&
    (proxyKey || origin === 'http://127.0.0.1:43729'), 'Configuración de origen o proxy inválida.');
  const service = createFaroService({ dbFile: join(path, 'faro-sat.sqlite'), html: readFileSync(new URL('./Faro-Fiscal.html', import.meta.url), 'utf8'), origin, proxyKey });
  const server = createServer(service.handle);
  server.requestTimeout = 90000;
  server.on('error', error => {
    console.error(error.code === 'EADDRINUSE' ? 'El puerto local ya está ocupado. Si PacoSAT está abierto, usa su ventana actual.' : 'No se pudo iniciar Faro: ' + message(error));
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
