import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPacoSATService } from './local-server.mjs';
import { crc32 } from './xml-core.mjs';

/* Ronda anti-5002 (aprobada el 9 nov 2026): segundos únicos en cada
   solicitud, variante de cierre +1 s por defecto, planificador que
   avisa ANTES de gastar, quemado al aprender un 5002 (en el envío y en
   la verificación), rescate asistido por el portal con marcado
   «rescatado» al entrar por la carpeta vigilada y libro de criterios
   visible por RFC. Todo con conectores y archivos de juguete:
   ningún contacto real con el SAT. */

const RFC = 'XAXX010101000';
function harness(service, origin, extraHeaders = {}) {
  let token;
  return {
    async init() {
      const page = await this.call('/');
      token = (await page.text()).match(/content="([^"]+)"/)[1];
    },
    async call(path, data) {
      const headers = { host: new URL(origin).host, origin, 'x-pacosat-token': token, ...extraHeaders };
      const req = Object.assign(Readable.from(data === undefined ? [] : [Buffer.from(JSON.stringify(data))]), {
        url: path, method: data === undefined ? 'GET' : 'POST', headers });
      let response;
      const res = { setHeader() {}, writeHead(status) { this.status = status; this.headersSent = true; },
        end(content) { response = new Response(content, { status: this.status }); } };
      await service.handle(req, res);
      return response;
    }
  };
}

/* ---------- Servicio A: unicidad, variante, planificador, quemado en el envío ---------- */
const originA = 'http://127.0.0.1:43735';
let fakeNow = Date.parse('2026-11-09T18:00:00Z'); /* 12:00:00 en Ciudad de México */
let modeA = 'ok', counterA = 0;
const serviceA = createPacoSATService({ dbFile: ':memory:', html: '<!--PACOSAT_TOKEN-->', origin: originA,
  now: () => fakeNow,
  makeConnector: async () => ({ parser: class {}, connector: {
    request: async () => {
      if (modeA === '5002') throw new Error('El SAT rechazó la solicitud: 5002 Se han agotado las solicitudes de por vida');
      return 'req-a-' + (++counterA);
    },
    check: async () => ({ status: 'pending', packages: [] }),
    download: async () => { throw new Error('sin paquetes'); }
  } }) });
const apiA = harness(serviceA, originA);
try {
  await apiA.init();
  assert.equal((await apiA.call('/api/unlock', { rfc: RFC, minutes: 60, days: 7, direction: 'received',
    password: 'pw', certificate: 'YQ==', key: 'Yg==' })).status, 200);

  /* Componente 1 · Segundos únicos en rango abierto: el fin se sella
     con la hora del envío; dos peticiones seguidas no repiten criterio
     y, dentro del mismo segundo, la guardia ofrece el cierre +1 s en
     vez de duplicar. */
  const open = { rfc: RFC, direction: 'received', start: '2026-11-01', end: '2026-11-09' };
  assert.equal((await apiA.call('/api/request', open)).status, 200);
  fakeNow += 1000;
  assert.equal((await apiA.call('/api/request', open)).status, 200);
  let statusA = await (await apiA.call('/api/status')).json();
  let openBook = statusA.criteriaBook.filter(e => e.rfc === RFC && e.startAt === '2026-11-01 00:00:00');
  assert.deepEqual(openBook.map(e => e.endAt).sort(), ['2026-11-09 12:00:00', '2026-11-09 12:00:01']);
  const dup = await apiA.call('/api/request', open);
  assert.equal(dup.status, 409);
  const dupBody = await dup.json();
  assert.equal(dupBody.guard.state, 'ultima');
  assert.equal(dupBody.guard.shiftedEndAt, '2026-11-09 12:00:02');
  assert.equal((await apiA.call('/api/request', { ...open, shiftEnd: 1 })).status, 200);
  assert.equal((await apiA.call('/api/request', { ...open, shiftEnd: 1 })).status, 409);
  assert.equal((await apiA.call('/api/request', { ...open, shiftEnd: 2 })).status, 200);
  statusA = await (await apiA.call('/api/status')).json();
  openBook = statusA.criteriaBook.filter(e => e.rfc === RFC && e.startAt === '2026-11-01 00:00:00');
  assert.equal(openBook.length, 4);
  assert.ok(openBook.every(e => e.count === 1));
  console.log('anti-5002 · segundos únicos en rango abierto: ok');

  /* Componente 2 · Variante +1 s en rango cerrado ya pedido: el fin
     23:59:59 pasa a las 00:00:00 del día siguiente; criterio nuevo sin
     duplicar el original. confirmRepeat ya no envía nada. */
  const closed = { rfc: RFC, direction: 'received', start: '2026-10-01', end: '2026-10-31' };
  assert.equal((await apiA.call('/api/request', closed)).status, 200);
  const again = await apiA.call('/api/request', closed);
  assert.equal(again.status, 409);
  const againBody = await again.json();
  assert.equal(againBody.guard.state, 'ultima');
  assert.equal(againBody.guard.shiftedEndAt, '2026-11-01 00:00:00');
  assert.match(againBody.error, /no repite criterios/);
  assert.equal((await apiA.call('/api/request', { ...closed, confirmRepeat: true })).status, 409);
  assert.equal((await apiA.call('/api/request', { ...closed, shiftEnd: 1 })).status, 200);
  statusA = await (await apiA.call('/api/status')).json();
  const closedBook = statusA.criteriaBook.filter(e => e.rfc === RFC && e.startAt === '2026-10-01 00:00:00');
  assert.deepEqual(closedBook.map(e => e.endAt).sort(), ['2026-10-31 23:59:59', '2026-11-01 00:00:00']);
  /* Compatibilidad: shiftStart sigue creando un criterio distinto. */
  const may = { rfc: RFC, direction: 'received', start: '2026-05-01', end: '2026-05-31' };
  assert.equal((await apiA.call('/api/request', may)).status, 200);
  assert.equal((await apiA.call('/api/request', { ...may, shiftStart: true })).status, 200);
  console.log('anti-5002 · variante de cierre +1 s en rango cerrado: ok');

  /* Componente 3 · Planificador: avisa antes de gastar; para explorar
     un rango amplio propone Metadatos primero, y solo para CFDI. */
  let plan = await (await apiA.call('/api/plan', closed)).json();
  assert.equal(plan.state, 'ultima');
  assert.equal(plan.recommendation, 'variant');
  assert.equal(plan.shiftedEndAt, '2026-11-01 00:00:00');
  plan = await (await apiA.call('/api/plan', { rfc: RFC, direction: 'received', start: '2026-01-01', end: '2026-03-31' })).json();
  assert.equal(plan.recommendation, 'metadata-first');
  assert.equal(plan.spanDays, 90);
  plan = await (await apiA.call('/api/plan', { rfc: RFC, direction: 'received', start: '2026-01-01', end: '2026-03-31', type: 'metadata' })).json();
  assert.equal(plan.recommendation, 'send');
  plan = await (await apiA.call('/api/plan', { rfc: RFC, direction: 'received', start: '2026-06-01', end: '2026-06-30' })).json();
  assert.equal(plan.recommendation, 'send');
  assert.equal(plan.state, 'disponible');
  console.log('anti-5002 · planificador previo al gasto: ok');

  /* Componente 4 (mitad) · 5002 en el propio envío: el criterio queda
     quemado en el libro aunque no hubiera envíos propios, la respuesta
     es la guardia 409 con las salidas, y el plan de rescate sale aunque
     no haya metadatos guardados. */
  modeA = '5002';
  const aug = { rfc: RFC, direction: 'received', start: '2026-08-01', end: '2026-08-31' };
  const burnedRes = await apiA.call('/api/request', aug);
  assert.equal(burnedRes.status, 409);
  const burnedBody = await burnedRes.json();
  assert.equal(burnedBody.guard.state, 'agotado');
  assert.equal(burnedBody.guard.rfc, RFC);
  assert.equal(burnedBody.guard.shiftedEndAt, '2026-09-01 00:00:00');
  modeA = 'ok';
  assert.equal((await apiA.call('/api/request', aug)).status, 409);
  statusA = await (await apiA.call('/api/status')).json();
  const augEntry = statusA.criteriaBook.find(e => e.rfc === RFC && e.startAt === '2026-08-01 00:00:00');
  assert.equal(augEntry.state, 'agotado');
  assert.equal(augEntry.sends.length, 0);
  const rescue = await (await apiA.call('/api/rescue', { rfc: RFC, direction: 'received', startAt: augEntry.startAt, endAt: augEntry.endAt })).json();
  assert.deepEqual(rescue.folios, []);
  assert.ok(rescue.instructions.length >= 4);
  assert.match(rescue.instructions.join(' '), /2\.000 XML/);
  assert.match(rescue.instructions.join(' '), /carpeta vigilada/);
  assert.match(rescue.instructions.join(' '), /ni la e\.firma/);
  console.log('anti-5002 · quemado aprendido en el envío y plan de rescate: ok');
} finally { await serviceA.close(); }

/* ---------- Servicio B: quemado en la verificación, folios del rescate y «rescatado» ---------- */
const cfdiNs = 'http://www.sat.gob.mx/cfd/4';
const tfdNs = 'http://www.sat.gob.mx/TimbreFiscalDigital';
class RescueParser {
  parseFromString(xml) {
    const node = (localName, data = {}, children = [], namespaceURI = cfdiNs) => ({
      localName, namespaceURI, nodeType: 1, childNodes: children,
      getAttribute: name => data[name] || '',
      getElementsByTagNameNS: (namespace, name) => children.filter(child => child.namespaceURI === namespace && child.localName === name)
    });
    const grab = name => (String(xml).match(new RegExp(name + '="([^"]+)"')) || [])[1] || '';
    const documentElement = node('Comprobante', {
      Fecha: grab('Fecha'), Total: '1160.00', Moneda: 'MXN', TipoDeComprobante: 'I'
    }, [
      node('Emisor', { Rfc: grab('Emisor'), Nombre: 'EMISOR SA' }), node('Receptor', { Rfc: grab('Receptor'), Nombre: 'RECEPTOR SA' }),
      node('Complemento', {}, [node('TimbreFiscalDigital', { UUID: grab('UUID') }, [], tfdNs)])
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
const folio = '12345678-1234-1234-1234-1234567890AB';
const metadataText = [
  'Uuid|RfcEmisor|NombreEmisor|RfcReceptor|NombreReceptor|FechaEmision|FechaCertificacion|PacCertifico|Monto|EfectoComprobante|Estatus|FechaCancelacion',
  folio + '|AAA010101AAA|EMISOR SA|' + RFC + '|RECEPTOR SA|2026-09-15T10:00:00|2026-09-15T10:01:00|SAT970701NN3|1160.00|I|1|'
].join('\n');
const originB = 'https://pacosat.example.com';
const proxyKey = 'd'.repeat(64);
let fakeNowB = Date.parse('2026-11-09T18:00:00Z');
let checkImpl = async () => ({ status: 'pending', packages: [] });
const sentB = [];
const watchDir = join(mkdtempSync(join(tmpdir(), 'pacosat-anti5002-')), 'vigilada');
mkdirSync(watchDir);
const serviceB = createPacoSATService({ dbFile: ':memory:', origin: originB, proxyKey,
  html: '<!--PACOSAT_TOKEN-->', now: () => fakeNowB, watchDir, inboxParser: RescueParser, watchSettleMs: 0,
  makeConnector: async () => ({ parser: RescueParser, connector: {
    request: async options => 'req-' + options.start + (options.type === 'metadata' ? '-meta' : ''),
    check: id => checkImpl(id),
    download: async () => archive(metadataText, 'metadata.txt')
  } }),
  makeMailer: () => ({ verify: async () => true, sendMail: async payload => { sentB.push(payload); } }) });
const apiB = harness(serviceB, originB, { 'x-pacosat-proxy': proxyKey });
try {
  await apiB.init();
  await serviceB.bootstrap({});
  assert.equal((await apiB.call('/api/storage', { batch: { people: [{ id: RFC, name: 'Ejemplo' }] } })).status, 200);
  assert.equal((await apiB.call('/api/mail', { host: 'smtp.example.com', port: 587, from: 'from@example.com',
    recipient: 'to@example.com', user: '', password: '' })).status, 200);
  assert.equal((await apiB.call('/api/unlock', { rfc: RFC, minutes: 1440, days: 7, direction: 'received',
    password: 'pw', certificate: 'YQ==', key: 'Yg==' })).status, 200);

  /* Quemado por la vía de verificación: la solicitud se envió bien y
     el SAT responde 5002 al verificarla — el libro lo marca agotado. */
  const sept = { rfc: RFC, direction: 'received', start: '2026-09-01', end: '2026-09-30' };
  assert.equal((await apiB.call('/api/request', sept)).status, 200);
  checkImpl = async id => id === 'req-2026-09-01' ? { status: 'rejected', packages: [], code: 5002 } : { status: 'pending', packages: [] };
  fakeNowB += 6 * 60000;
  await serviceB.tick();
  let statusB = await (await apiB.call('/api/status')).json();
  const septEntry = () => statusB.criteriaBook.find(e => e.rfc === RFC && e.type === 'cfdi' && e.startAt === '2026-09-01 00:00:00');
  assert.equal(septEntry().state, 'agotado');
  assert.equal(septEntry().sends.length, 1);
  console.log('anti-5002 · quemado aprendido en la verificación: ok');

  /* Los metadatos del mismo periodo alimentan la lista exacta de
     folios del rescate (el folio aún no descargado, con sus datos). */
  assert.equal((await apiB.call('/api/request', { ...sept, type: 'metadata' })).status, 200);
  checkImpl = async id => id === 'req-2026-09-01-meta' ? { status: 'finished', packages: ['meta-1'] } : { status: 'pending', packages: [] };
  fakeNowB += 6 * 60000;
  await serviceB.tick();
  const plan = await (await apiB.call('/api/rescue', { rfc: RFC, direction: 'received',
    startAt: '2026-09-01 00:00:00', endAt: '2026-09-30 23:59:59' })).json();
  assert.equal(plan.folios.length, 1);
  assert.equal(plan.folios[0].uuid, folio);
  console.log('anti-5002 · lista de folios del rescate desde metadatos: ok');

  /* El XML recuperado del portal cae en la carpeta vigilada: se
     importa y el criterio quemado pasa a «rescatado»; un XML de otro
     periodo no altera el rescate. */
  writeFileSync(join(watchDir, 'rescate.xml'),
    '<Comprobante Fecha="2026-09-15T10:00:00" Emisor="AAA010101AAA" Receptor="' + RFC + '" UUID="' + folio + '"/>');
  await serviceB.inboxTick(fakeNowB);
  assert.ok(existsSync(join(watchDir, 'procesados', '2026-11-09', 'rescate.xml')));
  statusB = await (await apiB.call('/api/status')).json();
  assert.equal(septEntry().state, 'rescatado');
  assert.equal(septEntry().rescuedCount, 1);
  const rescuedGuard = await apiB.call('/api/request', sept);
  assert.equal(rescuedGuard.status, 409);
  assert.equal((await rescuedGuard.json()).guard.state, 'rescatado');
  writeFileSync(join(watchDir, 'fuera.xml'),
    '<Comprobante Fecha="2026-10-15T10:00:00" Emisor="AAA010101AAA" Receptor="' + RFC + '" UUID="22345678-1234-1234-1234-1234567890AB"/>');
  await serviceB.inboxTick(fakeNowB);
  statusB = await (await apiB.call('/api/status')).json();
  assert.equal(septEntry().rescuedCount, 1);
  await serviceB.tick();
  /* 1.7.4: el aviso de rescate vive en el Centro (sin correo
     individual) y entra en el correo-resumen del día siguiente — el
     de hoy ya salió con el aviso del periodo agotado. */
  assert.equal(sentB.filter(mail => /rescatado por el portal/.test(mail.subject)).length, 0);
  const noticesB = await (await apiB.call('/api/notices')).json();
  assert.ok(noticesB.avisos.some(aviso => /rescatado por el portal/.test(aviso.titulo)), JSON.stringify(noticesB.avisos.map(a => a.titulo)));
  fakeNowB += 22 * 3600000;
  await serviceB.tick();
  assert.ok(sentB.some(mail => /rescatado por el portal/.test(mail.text || '')));
  console.log('anti-5002 · rescate por carpeta vigilada marca «rescatado»: ok');
} finally { await serviceB.close(); }
console.log('anti5002.test: ok');
