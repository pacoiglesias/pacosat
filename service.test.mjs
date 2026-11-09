import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPacoSATService, pacosatCriteriaKey, pacosatShiftSecond } from './local-server.mjs';
import { crc32, parseXml } from './xml-core.mjs';

const rfc = 'XAXX010101000';
const emitter = 'AAA010101AAA';
const uuid = '12345678-1234-1234-1234-1234567890AB';
const cfdi = 'http://www.sat.gob.mx/cfd/4';
const tfd = 'http://www.sat.gob.mx/TimbreFiscalDigital';
class FixtureParser {
  parseFromString(xml) {
    const node = (localName, data = {}, children = [], namespaceURI = cfdi) => ({
      localName, namespaceURI, nodeType: 1, childNodes: children,
      getAttribute: name => data[name] || '',
      getElementsByTagNameNS: (namespace, name) => children.filter(child => child.namespaceURI === namespace && child.localName === name)
    });
    const expected = xml.includes('mismatch') ? 'XEXX010101000' : rfc;
    const documentElement = node('Comprobante', {
      Fecha: '2026-11-08T07:00:00', Total: '80.00', Moneda: 'MXN', TipoDeComprobante: 'I'
    }, [
      node('Emisor', { Rfc: emitter }), node('Receptor', { Rfc: expected }),
      node('Complemento', {}, [node('TimbreFiscalDigital', { UUID: uuid }, [], tfd)])
    ]);
    return { documentElement, getElementsByTagName: () => [] };
  }
}
function archive(payload) {
  const raw = Buffer.from(payload), name = Buffer.from('test.xml');
  const local = Buffer.alloc(30), central = Buffer.alloc(46), end = Buffer.alloc(22);
  local.writeUInt32LE(0x04034b50); local.writeUInt16LE(name.length, 26);
  central.writeUInt32LE(0x02014b50); central.writeUInt32LE(crc32(raw), 16);
  central.writeUInt32LE(raw.length, 20); central.writeUInt32LE(raw.length, 24); central.writeUInt16LE(name.length, 28);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(local.length + name.length + raw.length, 16);
  return Buffer.concat([local, name, raw, central, name, end]);
}
let time = Date.parse('2026-11-08T16:00:00Z'), counter = 0;
const calls = [], sent = [];
const valid = archive('<fixture/>'), mismatch = archive('<mismatch/>');
assert.equal(parseXml(Buffer.from('<fixture/>'), FixtureParser).to.rfc, rfc);
const origin = 'http://127.0.0.1:43729';
const service = createPacoSATService({
  dbFile: ':memory:', html: '<!--PACOSAT_TOKEN-->', origin, now: () => time,
  makeConnector: async credentials => {
    assert.equal(credentials.rfc, rfc);
    assert.equal(credentials.password, 'simulated');
    return { parser: FixtureParser, connector: {
      request: async options => { calls.push(options); return 'request-' + (++counter); },
      check: async id => ({ status: 'finished', packages: [id + '-ok', id + '-mismatch'] }),
      download: async id => id.endsWith('mismatch') ? mismatch : valid
    } };
  },
  makeMailer: options => {
    assert.equal(options.requireTLS, true);
    return { verify: async () => true, sendMail: async payload => { sent.push(payload); } };
  }
});
let token;
async function call(path, data, options = {}) {
  const headers = { host: new URL(origin).host, origin, 'x-pacosat-token': token, ...options };
  const req = Object.assign(Readable.from(data === undefined ? [] : [Buffer.from(JSON.stringify(data))]), {
    url: path, method: data === undefined ? 'GET' : 'POST', headers
  });
  let response;
  const res = { setHeader() {}, writeHead(status) { this.status = status; this.headersSent = true; },
    end(content) { response = new Response(content, { status: this.status }); } };
  await service.handle(req, res);
  return response;
}
try {
  token = (await (await call('/')).text()).match(/content="([^"]+)"/)[1];
  assert.equal((await call('/api/status', undefined, { 'x-pacosat-token': 'bad' })).status, 403);
  assert.equal((await call('/api/status', undefined, { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await call('/api/lock', { rfc }, { origin: 'http://example.com' })).status, 403);
  assert.equal((await call('/api/mail', { host: 'smtp.example.com', port: 587, from: 'from@example.com',
    recipient: 'to@example.com', user: '', password: '' })).status, 200);
  assert.equal((await call('/api/unlock', { rfc, minutes: 60, days: 7, direction: 'received', password: 'simulated',
    certificate: 'YQ==', key: 'Yg==' })).status, 200);
  await service.tick();
  assert.deepEqual(calls[0], { start: '2026-11-02', end: '2026-11-08', startTime: '00:00:00', endTime: '10:00:00', direction: 'received' });
  assert.equal((await call('/api/retry', { id: -1 })).status, 400);
  assert.equal((await call('/api/retry', { id: 999 })).status, 404);
  assert.equal((await call('/api/retry', { id: 1 })).status, 200);
  time += 5 * 60000;
  await service.tick();
  let state = await (await call('/api/status')).json();
  assert.equal(state.jobs[0].status, 'finished');
  assert.equal((await call('/api/retry', { id: 1 })).status, 409);
  assert.equal(state.inbox.length, 2);
  assert.equal(state.inbox[0].newCount, 1);
  assert.equal(state.inbox[1].review, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'to@example.com');
  assert.deepEqual(Buffer.from(await (await call('/api/packages/' + state.inbox[0].id)).arrayBuffer()), valid);
  assert.equal((await call('/api/packages/' + state.inbox[0].id, { imported: 1 })).status, 200);
  time += 60 * 60000;
  await service.tick();
  time += 5 * 60000;
  await service.tick();
  state = await (await call('/api/status')).json();
  assert.equal(state.jobs.length, 3); /* 1.6.10: CFDI + Metadata diario + siguiente CFDI */
  assert.equal(state.inbox.filter(row => row.newCount).length, 0);
  assert.equal(sent.length, 1);
  assert.equal((await call('/api/lock', { rfc })).status, 200);
  time += 60 * 60000;
  await service.tick();
  assert.equal(calls.length, 3); /* 1.6.10: dos CFDI y un Metadata */
  async function alertHarness(connector) {
    const svc = createPacoSATService({ dbFile: ':memory:', html: '<!--PACOSAT_TOKEN-->', origin, now: () => time,
      makeConnector: async () => ({ parser: FixtureParser, connector }),
      makeMailer: () => ({ verify: async () => true, sendMail: async payload => { sent.push(payload); } }) });
    const invoke = async (path, data, svcToken) => {
      const headers = { host: new URL(origin).host, origin, 'x-pacosat-token': svcToken };
      const req = Object.assign(Readable.from(data === undefined ? [] : [Buffer.from(JSON.stringify(data))]), {
        url: path, method: data === undefined ? 'GET' : 'POST', headers });
      let response;
      const res = { setHeader() {}, writeHead(status) { this.status = status; this.headersSent = true; },
        end(content) { response = new Response(content, { status: this.status }); } };
      await svc.handle(req, res);
      return response;
    };
    const svcToken = (await (await invoke('/')).text()).match(/content="([^"]+)"/)[1];
    assert.equal((await invoke('/api/mail', { host: 'smtp.example.com', port: 587, from: 'from@example.com',
      recipient: 'to@example.com', user: '', password: '' }, svcToken)).status, 200);
    assert.equal((await invoke('/api/unlock', { rfc, minutes: 60, days: 7, direction: 'received', password: 'simulated',
      certificate: 'YQ==', key: 'Yg==' }, svcToken)).status, 200);
    return svc;
  }
  const alertsBefore = sent.length;
  const expiredSvc = await alertHarness({ request: async () => 'request-expired',
    check: async () => ({ status: 'expired', packages: [] }), download: async () => valid });
  await expiredSvc.tick();
  time += 5 * 60000;
  await expiredSvc.tick();
  assert.equal(sent.slice(alertsBefore).filter(mail => /solicitud al SAT quedó vencida/.test(mail.subject)).length, 1);
  await expiredSvc.tick();
  assert.equal(sent.slice(alertsBefore).filter(mail => /solicitud al SAT quedó vencida/.test(mail.subject)).length, 1);
  expiredSvc.close();
  let failMode = true;
  const failSvc = await alertHarness({ request: async () => 'request-fail',
    check: async () => { if (failMode) throw new Error('SAT no disponible'); return { status: 'finished', packages: [] }; },
    download: async () => valid });
  const failAlerts = () => sent.slice(alertsBefore).filter(mail => /descarga automática está fallando/.test(mail.subject)).length;
  await failSvc.tick();
  /* 1.6.4: la verificación reintenta con espera creciente (5, 10, 20, 40,
     60 min), así que los tres intentos fallidos ya no caben en 15 min:
     se avanza siguiendo la propia cadencia del backoff. */
  for (const step of [5, 10, 20]) { time += step * 60000; await failSvc.tick(); }
  assert.equal(failAlerts(), 1);
  time += 5 * 60000;
  await failSvc.tick();
  assert.equal(failAlerts(), 1);
  failMode = false;
  time += 40 * 60000;
  await failSvc.tick();
  assert.equal(failAlerts(), 1);
  failMode = true;
  for (const step of [5, 10, 20]) { time += step * 60000; await failSvc.tick(); }
  assert.equal(failAlerts(), 2);
  failSvc.close();
  console.log('OK: seguridad local, programación, descarga, RFC ajeno, deduplicación, correo simulado y pausa.');
  console.log('OK: alertas por solicitud vencida sin repetir y por fallo persistente de la descarga con reinicio al recuperarse.');
} finally { service.close(); }

// --- Blindaje contra el error 5002 del SAT (1.6.2) ---
const baseCriteria = { rfc, direction: 'received', type: 'cfdi', emitter: '', receiver: '',
  startAt: '2026-10-01 00:00:00', endAt: '2026-10-07 23:59:59' };
assert.equal(pacosatCriteriaKey(baseCriteria), pacosatCriteriaKey({ ...baseCriteria }));
for (const variant of [{ direction: 'issued' }, { type: 'metadata' }, { emitter: 'AAA010101AAA' },
  { receiver: 'BBB010101BBB' }, { startAt: '2026-10-01 00:00:01' }, { endAt: '2026-10-07 23:59:58' },
  { rfc: 'XEXX010101000' }]) {
  assert.notEqual(pacosatCriteriaKey(baseCriteria), pacosatCriteriaKey({ ...baseCriteria, ...variant }));
}
assert.equal(pacosatShiftSecond('2026-10-01 00:00:00'), '2026-10-01 00:00:01');
assert.equal(pacosatShiftSecond('2026-10-01 23:59:59'), '2026-10-02 00:00:00');
assert.equal(pacosatShiftSecond('2026-12-31 23:59:59'), '2027-01-01 00:00:00');
function harness(svc, proxy) {
  const state = { token: '' };
  const call = async (path, data) => {
    const headers = { host: new URL(origin).host, origin, 'x-pacosat-token': state.token, 'x-pacosat-proxy': proxy };
    const req = Object.assign(Readable.from(data === undefined ? [] : [Buffer.from(JSON.stringify(data))]), {
      url: path, method: data === undefined ? 'GET' : 'POST', headers });
    let response;
    const res = { setHeader() {}, writeHead(status) { this.status = status; this.headersSent = true; },
      end(content) { response = new Response(content, { status: this.status }); } };
    await svc.handle(req, res);
    return response;
  };
  return { call, init: async () => { state.token = (await (await call('/')).text()).match(/content="([^"]+)"/)[1]; } };
}
let guardTime = Date.parse('2026-11-08T16:00:00Z');
const guardCalls = [], guardSent = [];
let guardCheckImpl = async () => ({ status: 'finished', packages: [] });
const guardService = createPacoSATService({ dbFile: ':memory:', html: '<!--PACOSAT_TOKEN-->', origin,
  proxyKey: 'b'.repeat(64), now: () => guardTime,
  makeConnector: async () => ({ parser: FixtureParser, connector: {
    request: async options => { guardCalls.push(options); return 'guard-req-' + guardCalls.length; },
    check: id => guardCheckImpl(id), download: async () => valid } }),
  makeMailer: () => ({ verify: async () => true, sendMail: async payload => { guardSent.push(payload); } }) });
const guardApi = harness(guardService, 'b'.repeat(64));
try {
  await guardApi.init();
  assert.equal((await guardApi.call('/api/mail', { host: 'smtp.example.com', port: 587, from: 'from@example.com',
    recipient: 'to@example.com', user: '', password: '' })).status, 200);
  assert.equal((await guardApi.call('/api/unlock', { rfc, minutes: 60, days: 7, direction: 'received',
    password: 'simulated', certificate: 'YQ==', key: 'Yg==' })).status, 200);
  const october = { rfc, direction: 'received', start: '2026-10-01', end: '2026-10-07' };
  let res = await guardApi.call('/api/request', october);
  assert.equal(res.status, 200);
  assert.deepEqual(guardCalls.at(-1), { start: '2026-10-01', end: '2026-10-07', startTime: '00:00:00',
    endTime: '23:59:59', direction: 'received' });
  await guardService.tick();
  guardTime += 5 * 60000;
  await guardService.tick();
  const callsBeforeRepeat = guardCalls.length;
  res = await guardApi.call('/api/request', october);
  assert.equal(res.status, 409);
  let guardBody = await res.json();
  assert.equal(guardBody.guard.state, 'ultima');
  assert.equal(guardBody.guard.count, 1);
  assert.match(guardBody.error, /última disponible/);
  assert.equal(guardCalls.length, callsBeforeRepeat);
  res = await guardApi.call('/api/request', { ...october, confirmRepeat: true });
  assert.equal(res.status, 200);
  assert.equal(guardCalls.length, callsBeforeRepeat + 1);
  guardTime += 5 * 60000;
  await guardService.tick();
  res = await guardApi.call('/api/request', october);
  assert.equal(res.status, 409);
  guardBody = await res.json();
  assert.equal(guardBody.guard.state, 'agotado');
  assert.equal(guardBody.guard.count, 2);
  assert.equal(guardCalls.length, callsBeforeRepeat + 1);
  res = await guardApi.call('/api/request', { ...october, shiftStart: true });
  assert.equal(res.status, 200);
  assert.equal(guardCalls.at(-1).startTime, '00:00:01');
  let guardState = await (await guardApi.call('/api/status')).json();
  const octoberJobs = guardState.jobs.filter(job => job.periodStart === '2026-10-01');
  assert.equal(octoberJobs.find(job => job.startAt === '2026-10-01 00:00:01').criteriaState, 'ultima');
  assert.equal(octoberJobs.find(job => job.startAt === '2026-10-01 00:00:00').criteriaState, 'agotado');
  const september = { rfc, direction: 'received', start: '2026-09-01', end: '2026-09-07' };
  res = await guardApi.call('/api/request', september);
  assert.equal(res.status, 200);
  const septemberRequestId = 'guard-req-' + guardCalls.length;
  guardCheckImpl = async id => id === septemberRequestId
    ? { status: 'rejected', packages: [], code: 5002 } : { status: 'finished', packages: [] };
  guardTime += 5 * 60000;
  await guardService.tick();
  await guardService.tick();
  assert.equal(guardSent.filter(mail => /agotó las solicitudes de un periodo/.test(mail.subject)).length, 1);
  const callsBeforeBlocked = guardCalls.length;
  res = await guardApi.call('/api/request', september);
  assert.equal(res.status, 409);
  guardBody = await res.json();
  assert.equal(guardBody.guard.state, 'agotado');
  assert.equal(guardBody.guard.count, 1);
  assert.equal(guardCalls.length, callsBeforeBlocked);
  guardState = await (await guardApi.call('/api/status')).json();
  assert.equal(guardState.jobs.find(job => job.periodStart === '2026-09-01').criteriaState, 'agotado');
  console.log('OK: blindaje 5002: identidad de criterio al segundo, primer repetido avisa sin enviar, confirmación expresa, segundo repetido bloquea, +1 s crea criterio nuevo y el 5002 del SAT marca agotado con un solo aviso.');
} finally { guardService.close(); }

// Colisión de la programación: la ventana automática coincide al segundo con
// un criterio ya enviado; debe desplazarse +1 s sola y dejar rastro.
const clashDir = mkdtempSync(join(tmpdir(), 'pacosat-162-'));
const clashFile = join(clashDir, 'choque.sqlite');
const clashTime = Date.parse('2026-11-08T16:00:00Z');
const clashCalls = [];
const clashConnector = () => ({ parser: FixtureParser, connector: {
  request: async options => { clashCalls.push(options); return 'clash-req-' + clashCalls.length; },
  check: async () => ({ status: 'finished', packages: [] }), download: async () => valid } });
const clashMailer = () => ({ verify: async () => true, sendMail: async () => {} });
const clashA = createPacoSATService({ dbFile: clashFile, html: '<!--PACOSAT_TOKEN-->', origin,
  proxyKey: 'c'.repeat(64), now: () => clashTime, makeConnector: async () => clashConnector(), makeMailer: clashMailer });
const clashApiA = harness(clashA, 'c'.repeat(64));
try {
  await clashApiA.init();
  assert.equal((await clashApiA.call('/api/unlock', { rfc, minutes: 60, days: 7, direction: 'received',
    password: 'simulated', certificate: 'YQ==', key: 'Yg==' })).status, 200);
  const manual = await clashApiA.call('/api/request', { rfc, direction: 'received', start: '2026-11-02', end: '2026-11-08' });
  assert.equal(manual.status, 200);
  assert.deepEqual(clashCalls[0], { start: '2026-11-02', end: '2026-11-08', startTime: '00:00:00',
    endTime: '10:00:00', direction: 'received' });
} finally { clashA.close(); }
{
  const direct = new DatabaseSync(clashFile);
  direct.prepare("UPDATE jobs SET status='finished'").run();
  direct.prepare('UPDATE profiles SET nextRun=0').run();
  direct.close();
}
const clashB = createPacoSATService({ dbFile: clashFile, html: '<!--PACOSAT_TOKEN-->', origin,
  proxyKey: 'c'.repeat(64), now: () => clashTime, makeConnector: async () => clashConnector(), makeMailer: clashMailer });
const clashApiB = harness(clashB, 'c'.repeat(64));
try {
  await clashApiB.init();
  assert.equal((await clashApiB.call('/api/unlock', { rfc, minutes: 60, days: 7, direction: 'received',
    password: 'simulated', certificate: 'YQ==', key: 'Yg==' })).status, 200);
  await clashB.tick();
  assert.equal(clashCalls.length, 3); /* 1.6.10: el Metadata diario se suma a las dos de CFDI */
  assert.equal(clashCalls[1].startTime, '00:00:01');
  assert.equal(clashCalls[1].endTime, '10:00:00');
  const activityRows = await (await clashApiB.call('/api/storage?store=activity')).json();
  assert.ok(activityRows.some(row => /Blindaje SAT 5002/.test(row.name) && /\+1 s/.test(row.event) && /5002/.test(row.event)));
  console.log('OK: la colisión de la descarga programada se auto-corrige desplazando el inicio +1 s y queda anotada en la bitácora.');
} finally { clashB.close(); }

// Migración suave: una base previa a 1.6.2 siembra el libro sin duplicar.
const legacyDir = mkdtempSync(join(tmpdir(), 'pacosat-162-'));
const legacyFile = join(legacyDir, 'legado.sqlite');
{
  const legacy = new DatabaseSync(legacyFile);
  legacy.exec(`CREATE TABLE profiles (rfc TEXT PRIMARY KEY, minutes INTEGER NOT NULL, days INTEGER NOT NULL,
    direction TEXT NOT NULL, nextRun INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '');
    CREATE TABLE jobs (id INTEGER PRIMARY KEY, rfc TEXT NOT NULL, direction TEXT NOT NULL,
    periodStart TEXT NOT NULL, periodEnd TEXT NOT NULL, requestId TEXT NOT NULL,
    status TEXT NOT NULL, imported TEXT NOT NULL DEFAULT '[]', due INTEGER NOT NULL,
    created INTEGER NOT NULL, error TEXT NOT NULL DEFAULT '', FOREIGN KEY(rfc) REFERENCES profiles(rfc));`);
  legacy.prepare("INSERT INTO profiles VALUES ('XAXX010101000',60,7,'received',0,'')").run();
  legacy.prepare("INSERT INTO jobs(rfc,direction,periodStart,periodEnd,requestId,status,imported,due,created,error) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run(rfc, 'received', '2026-08-03', '2026-08-09', 'legado-1', 'finished', '[]', 0, Date.parse('2026-08-10T15:00:00Z'), '');
  legacy.close();
}
function legacyService() {
  return createPacoSATService({ dbFile: legacyFile, html: '<!--PACOSAT_TOKEN-->', origin,
    now: () => Date.parse('2026-11-08T16:00:00Z'),
    makeConnector: async () => ({ parser: FixtureParser, connector: {
      request: async () => 'legado-nuevo', check: async () => ({ status: 'finished', packages: [] }),
      download: async () => valid } }),
    makeMailer: () => ({ verify: async () => true, sendMail: async () => {} }) });
}
const legacyA = legacyService();
const legacyApiA = harness(legacyA, '');
try {
  await legacyApiA.init();
  const state = await (await legacyApiA.call('/api/status')).json();
  const seeded = state.jobs.find(job => job.periodStart === '2026-08-03');
  assert.equal(seeded.startAt, '2026-08-03 00:00:00');
  assert.equal(seeded.endAt, '2026-08-09 23:59:59');
  assert.equal(seeded.criteriaState, 'ultima');
  assert.equal((await legacyApiA.call('/api/unlock', { rfc, minutes: 60, days: 7, direction: 'received',
    password: 'simulated', certificate: 'YQ==', key: 'Yg==' })).status, 200);
  let res = await legacyApiA.call('/api/request', { rfc, direction: 'received', start: '2026-08-03', end: '2026-08-09' });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).guard.state, 'ultima');
  res = await legacyApiA.call('/api/request', { rfc, direction: 'received', start: '2026-08-03', end: '2026-08-09', confirmRepeat: true });
  assert.equal(res.status, 200);
} finally { legacyA.close(); }
const legacyB = legacyService();
const legacyApiB = harness(legacyB, '');
try {
  await legacyApiB.init();
  assert.equal((await legacyApiB.call('/api/unlock', { rfc, minutes: 60, days: 7, direction: 'received',
    password: 'simulated', certificate: 'YQ==', key: 'Yg==' })).status, 200);
  const res = await legacyApiB.call('/api/request', { rfc, direction: 'received', start: '2026-08-03', end: '2026-08-09' });
  assert.equal(res.status, 409);
  const guardBody = await res.json();
  assert.equal(guardBody.guard.state, 'agotado');
  assert.equal(guardBody.guard.count, 2);
  console.log('OK: la migración siembra el libro desde las solicitudes previas, reconstruye los segundos y no duplica la siembra al reabrir.');
} finally { legacyB.close(); }

// --- Espera creciente en la verificación de solicitudes (1.6.4) ---
let backTime = Date.parse('2026-11-09T15:00:00Z');
let backReqCounter = 0;
const backCheckCounts = new Map();
const backService = createPacoSATService({ dbFile: ':memory:', html: '<!--PACOSAT_TOKEN-->', origin,
  proxyKey: 'f'.repeat(64), now: () => backTime,
  makeConnector: async () => ({ parser: FixtureParser, connector: {
    request: async () => 'back-req-' + (++backReqCounter),
    /* Conteo por solicitud (1.6.10): el job diario de Metadata del mismo
       perfil no debe desalinear la espera creciente del job de CFDI. */
    check: async id => { const n = (backCheckCounts.get(id) || 0) + 1; backCheckCounts.set(id, n);
      return n <= 4 ? { status: 'pending', packages: [] } : { status: 'finished', packages: [] }; },
    download: async () => valid } }),
  makeMailer: () => ({ verify: async () => true, sendMail: async () => {} }) });
const backApi = harness(backService, 'f'.repeat(64));
try {
  await backApi.init();
  assert.equal((await backApi.call('/api/unlock', { rfc, minutes: 1440, days: 7, direction: 'received',
    password: 'simulated', certificate: 'YQ==', key: 'Yg==' })).status, 200);
  await backService.tick();
  const waits = [];
  for (let round = 0; round < 4; round++) {
    let state = await (await backApi.call('/api/status')).json();
    const job = state.jobs.find(row => row.status === 'pending' && row.kind === 'cfdi');
    assert.ok(job, 'la solicitud sigue pendiente en la ronda ' + round);
    backTime = job.due;
    await backService.tick();
    state = await (await backApi.call('/api/status')).json();
    const after = state.jobs.find(row => row.id === job.id);
    assert.equal(after.status, 'pending');
    assert.equal(after.checks, round + 1);
    waits.push((after.due - backTime) / 60000);
  }
  assert.deepEqual(waits, [10, 20, 40, 60]);
  const activityRows = await (await backApi.call('/api/storage?store=activity')).json();
  assert.ok(activityRows.some(row => /espera entre consultas queda en su tope de 60 minutos/.test(row.event || '')));
  let state = await (await backApi.call('/api/status')).json();
  backTime = state.jobs.find(row => row.status === 'pending' && row.kind === 'cfdi').due;
  await backService.tick();
  state = await (await backApi.call('/api/status')).json();
  assert.equal(state.jobs.find(row => row.id === 1).status, 'finished');
  assert.equal(state.jobs.filter(row => row.status === 'pending').length, 0);
  console.log('OK: espera creciente 5→10→20→40→60 con tope, contador persistido y apunte único en bitácora al llegar al máximo.');
} finally { backService.close(); }
