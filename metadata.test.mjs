import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createPacoSATService } from './local-server.mjs';
import { crc32, parseXml } from './xml-core.mjs';

/* Ronda 1.6.10: solicitudes Metadata (ingesta y reconciliación), modo
   descanso por RFC y general con catch-up, y aviso de silencio. Todo
   contra un SAT simulado: ninguna solicitud sale del proceso. */
const rfc = 'XAXX010101000';
const emitter = 'AAA010101AAA';
const uuidKnown = '12345678-1234-1234-1234-1234567890AB';
const uuidMissing = '22345678-1234-1234-1234-1234567890AB';
const cfdi = 'http://www.sat.gob.mx/cfd/4';
const tfd = 'http://www.sat.gob.mx/TimbreFiscalDigital';
class FixtureParser {
  parseFromString(xml) {
    const node = (localName, data = {}, children = [], namespaceURI = cfdi) => ({
      localName, namespaceURI, nodeType: 1, childNodes: children,
      getAttribute: name => data[name] || '',
      getElementsByTagNameNS: (namespace, name) => children.filter(child => child.namespaceURI === namespace && child.localName === name)
    });
    const documentElement = node('Comprobante', {
      Fecha: '2026-11-08T07:00:00', Total: '80.00', Moneda: 'MXN', TipoDeComprobante: 'I'
    }, [
      node('Emisor', { Rfc: emitter }), node('Receptor', { Rfc: rfc }),
      node('Complemento', {}, [node('TimbreFiscalDigital', { UUID: uuidKnown }, [], tfd)])
    ]);
    return { documentElement, getElementsByTagName: () => [] };
  }
}
function archive(payload, name) {
  const raw = Buffer.from(payload), entry = Buffer.from(name);
  const local = Buffer.alloc(30), central = Buffer.alloc(46), end = Buffer.alloc(22);
  local.writeUInt32LE(0x04034b50); local.writeUInt16LE(entry.length, 26);
  central.writeUInt32LE(0x02014b50); central.writeUInt32LE(crc32(raw), 16);
  central.writeUInt32LE(raw.length, 20); central.writeUInt32LE(raw.length, 24); central.writeUInt16LE(entry.length, 28);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + entry.length, 12); end.writeUInt32LE(local.length + entry.length + raw.length, 16);
  return Buffer.concat([local, entry, raw, central, entry, end]);
}
const metadataText = [
  'Uuid|RfcEmisor|NombreEmisor|RfcReceptor|NombreReceptor|FechaEmision|FechaCertificacion|PacCertifico|Monto|EfectoComprobante|Estatus|FechaCancelacion',
  uuidKnown + '|' + emitter + '|EMISOR SA|' + rfc + '|RECEPTOR SA|2026-11-05T09:00:00|2026-11-05T09:01:00|SAT970701NN3|1160.00|I|1|',
  uuidMissing + '|' + emitter + '|EMISOR SA|' + rfc + '|RECEPTOR SA|2026-11-06T10:00:00|2026-11-06T10:01:00|SAT970701NN3|500.00|I|0|2026-11-07T00:00:00'
].join('\n');
let time = Date.parse('2026-11-08T16:00:00Z'), counter = 0;
const calls = [], sent = [];
const origin = 'http://127.0.0.1:43729';
const service = createPacoSATService({
  dbFile: ':memory:', html: '<!--PACOSAT_TOKEN-->', origin, now: () => time,
  makeConnector: async () => ({ parser: FixtureParser, connector: {
    request: async options => { calls.push(options); return 'request-' + (++counter); },
    check: async id => ({ status: 'finished', packages: [id + '-pkg'] }),
    download: async packageId => {
      const requestIndex = Number(packageId.replace('request-', '').replace('-pkg', '')) - 1;
      return calls[requestIndex]?.type === 'metadata' ? archive(metadataText, 'metadata.txt') : archive('<fixture/>', 'test.xml');
    }
  } }),
  makeMailer: () => ({ verify: async () => true, sendMail: async payload => { sent.push(payload); } })
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
  const homeHtml = await (await call('/')).text();
  token = homeHtml.split('content="')[1].split('"')[0];
  assert.equal((await call('/api/mail', { host: 'smtp.example.com', port: 587, from: 'from@example.com',
    recipient: 'to@example.com', user: '', password: '' })).status, 200);
  assert.equal((await call('/api/unlock', { rfc, minutes: 60, days: 7, direction: 'received', password: 'simulated',
    certificate: 'YQ==', key: 'Yg==' })).status, 200);
  /* Primera vuelta: se programa el CFDI y también el Metadata diario. */
  await service.tick();
  const cfdiCall = calls.find(entry => entry.type === undefined);
  const metaCall = calls.find(entry => entry.type === 'metadata');
  assert.ok(cfdiCall, 'Debe programarse la descarga de CFDI.');
  assert.ok(metaCall, 'Debe programarse la solicitud Metadata diaria.');
  /* Solicitud Metadata manual por la ruta de periodos. */
  const manual = await call('/api/request', { rfc, direction: 'received', start: '2026-10-01', end: '2026-10-31', type: 'metadata' });
  assert.equal(manual.status, 200);
  time += 5 * 60000;
  await service.tick();
  let state = await (await call('/api/status')).json();
  assert.ok(state.jobs.some(job => job.kind === 'metadata' && job.status === 'finished'));
  assert.equal(state.metadata.records, 2);
  assert.deepEqual(state.metadata.missing.map(row => row.uuid), [uuidMissing]);
  assert.equal(state.metadata.missing[0].status, '0');
  /* Descanso por RFC: en pausa no se envía nada; al reanudar, la
     ventana arranca el día en que empezó la pausa (catch-up). */
  const pauseDay = new Date(time).toISOString().slice(0, 10);
  const before = calls.length;
  assert.equal((await call('/api/pause', { rfc, paused: true })).status, 200);
  time += 3 * 86400000;
  await service.tick();
  assert.equal(calls.length, before, 'En descanso no debe salir ninguna solicitud.');
  assert.equal((await call('/api/pause', { rfc, paused: false })).status, 200);
  await service.tick();
  const catchup = calls.slice(before).find(entry => entry.type === undefined);
  assert.ok(catchup, 'Al reanudar debe programarse la descarga.');
  assert.equal(catchup.start, pauseDay, 'La ventana pendiente arranca al inicio de la pausa.');
  /* Descanso general: tampoco sale nada y el monitor se detiene. */
  const beforeRest = calls.length;
  assert.equal((await call('/api/rest', { until: time + 2 * 86400000 })).status, 200);
  time += 86400000;
  await service.tick();
  await service.monitorTick();
  assert.equal(calls.length, beforeRest, 'En descanso general no debe salir ninguna solicitud.');
  assert.equal((await call('/api/rest', { until: 0 })).status, 200);
  /* Aviso de silencio: umbral de 3 días; el último CFDI llegó al
     principio de la prueba, así que a +10 días debe avisar por correo. */
  assert.equal((await call('/api/silence', { days: 3 })).status, 200);
  time += 10 * 86400000;
  await service.tick();
  assert.ok(sent.some(mail => /Silencio de CFDI/.test(mail.subject)), 'Debe llegar el aviso de silencio.');
  console.log('OK: metadatos ingeridos y reconciliados (faltante detectado), descanso por RFC y general sin envíos, catch-up al reanudar y aviso de silencio.');
} finally { service.close(); }
