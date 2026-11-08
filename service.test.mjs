import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createPacoSATService } from './local-server.mjs';
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
  assert.deepEqual(calls[0], { start: '2026-11-02', end: '2026-11-08', endTime: '10:00:00', direction: 'received' });
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
  assert.equal(state.jobs.length, 2);
  assert.equal(state.inbox.filter(row => row.newCount).length, 0);
  assert.equal(sent.length, 1);
  assert.equal((await call('/api/lock', { rfc })).status, 200);
  time += 60 * 60000;
  await service.tick();
  assert.equal(calls.length, 2);
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
  for (let i = 0; i < 3; i++) { time += 5 * 60000; await failSvc.tick(); }
  assert.equal(failAlerts(), 1);
  time += 5 * 60000;
  await failSvc.tick();
  assert.equal(failAlerts(), 1);
  failMode = false;
  time += 5 * 60000;
  await failSvc.tick();
  failMode = true;
  time += 60 * 60000;
  await failSvc.tick();
  for (let i = 0; i < 3; i++) { time += 5 * 60000; await failSvc.tick(); }
  assert.equal(failAlerts(), 2);
  failSvc.close();
  console.log('OK: seguridad local, programación, descarga, RFC ajeno, deduplicación, correo simulado y pausa.');
  console.log('OK: alertas por solicitud vencida sin repetir y por fallo persistente de la descarga con reinicio al recuperarse.');
} finally { service.close(); }
