/* Ronda 1.15.0 — Descarga automática mensual (propuesta 1 de la
   auditoría del 10 nov 2026). Pruebas de comportamiento contra el
   motor REAL con el SAT sustituido por un doble fiel (mismo
   contrato request/check/download que el conector de verdad):
   - el día fijado, el tick baja SOLO el mes anterior completo de
     cada RFC con e.firma, pidiendo únicamente los tramos que
     ninguna descarga terminada cubre;
   - la cuenta sale de los registros reales: encontradas, nuevas y
     ya estaban cuadran (un CFDI ya importado que el SAT vuelve a
     entregar NO cuenta como nuevo ni se duplica);
   - la corrida es idempotente: ni el tick ni «descargar ahora»
     repiten un mes ya corrido, y ningún criterio se repite jamás;
   - el aviso llega en el resumen de sucesos por correo con la
     cuenta, y al «ponerse al día» no se repite;
   - los huecos de meses viejos se recuperan APARTE, con su
     solicitud propia, sin tocar la corrida mensual;
   - en descanso general no se baja nada ni se crea la corrida, y
     «descargar ahora» lo respeta con su 409;
   - un RFC con CIEC NO baja solo (su captcha es el gesto de
     Paco): su parte queda «esperando tu gesto» y, cuando Paco
     baja ese mes exacto por su vía, la cuenta se suma a la
     corrida;
   - si una solicitud del mes muere, la corrida queda «fallida»
     y el aviso entra en el Centro de Avisos (espejo);
   - apagar la función o mover su día manda: sin corrida. */
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPacoSATService } from './local-server.mjs';
import { crc32 } from './xml-core.mjs';

const RFC = 'XAXX010101000';
const EMISOR = 'AAA010101AAA';
const CIEC_RFC = 'BBB010101BB0';
const key = 'd'.repeat(64);
const MIN = 60_000, HOUR = 3_600_000;

/* ---------- Parser de juguete fiel a parseXml (regex sobre el XML) ---------- */
class FixtureParser {
  parseFromString(xml) {
    const cfdi = 'http://www.sat.gob.mx/cfd/4';
    const node = (localName, attributes = {}, children = [], namespaceURI = cfdi) => ({
      nodeType: 1, localName, namespaceURI, childNodes: children,
      get children() { return children; },
      getAttribute: name => attributes[name] ?? null,
      getElementsByTagNameNS: (ns, name) => children.filter(item => item.namespaceURI === ns && item.localName === name)
    });
    const attr = (tag, name) => (xml.match(new RegExp('<' + tag + '\\b[^>]*\\b' + name + '="([^"]*)"')) || [])[1] || '';
    const stamp = node('TimbreFiscalDigital', { UUID: attr('tfd:TimbreFiscalDigital', 'UUID') }, [],
      'http://www.sat.gob.mx/TimbreFiscalDigital');
    const root = node('Comprobante',
      { Fecha: attr('cfdi:Comprobante', 'Fecha'), Total: attr('cfdi:Comprobante', 'Total'),
        Moneda: 'MXN', TipoDeComprobante: 'I' },
      [node('Emisor', { Rfc: attr('cfdi:Emisor', 'Rfc'), Nombre: 'EMISOR DE JUGUETE' }),
       node('Receptor', { Rfc: attr('cfdi:Receptor', 'Rfc'), Nombre: 'RECEPTOR DE JUGUETE' }),
       node('Complemento', {}, [stamp])]);
    return { documentElement: root, getElementsByTagName: () => [] };
  }
}

const xmlCfdi = ({ uuid, fecha, emisor, receptor, total = '116.00' }) =>
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital" ' +
  'Version="4.0" Fecha="' + fecha + '" Moneda="MXN" Total="' + total + '" TipoDeComprobante="I">' +
  '<cfdi:Emisor Rfc="' + emisor + '" Nombre="EMISOR DE JUGUETE"/>' +
  '<cfdi:Receptor Rfc="' + receptor + '" Nombre="RECEPTOR DE JUGUETE"/>' +
  '<cfdi:Complemento><tfd:TimbreFiscalDigital Version="1.1" UUID="' + uuid + '" FechaTimbrado="' + fecha + '"/></cfdi:Complemento>' +
  '</cfdi:Comprobante>';

/* ZIP «stored» multientrada, como los paquetes reales del SAT. */
function archiveOf(files) {
  const chunks = [], central = [];
  let offset = 0;
  for (const file of files) {
    const raw = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data);
    const name = Buffer.from(file.name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(name.length, 26);
    chunks.push(local, name, raw);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt32LE(crc32(raw), 16);
    cen.writeUInt32LE(raw.length, 20); cen.writeUInt32LE(raw.length, 24);
    cen.writeUInt16LE(name.length, 28); cen.writeUInt32LE(offset, 42);
    central.push(cen, name);
    offset += local.length + name.length + raw.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, centralBuf, end]);
}

/* Doble fiel del SAT: registra cada solicitud; las mensuales con
   paquete quedan «pendientes» en la primera comprobación (el SAT
   tarda) y «terminadas» en la segunda; el resto, terminadas a la
   primera y sin paquetes. `failMonthly` simula el rechazo. */
function fakeSat({ packagesByRange = new Map(), failMonthly = false } = {}) {
  const calls = [];
  const checks = new Map();
  const byId = new Map();
  const isMonthly = options => options.start === '2026-11-01' || options.start === '2026-12-06';
  return { calls,
    connector: {
      request: async options => { calls.push({ ...options });
        const id = 'req-' + calls.length; byId.set(id, options); return id; },
      check: async id => { const options = byId.get(id);
        const n = (checks.get(id) || 0) + 1; checks.set(id, n);
        if (isMonthly(options) && failMonthly) return { status: 'failed', packages: [] };
        const files = packagesByRange.get(options.start + '|' + options.direction);
        if (isMonthly(options) && n < 2) return { status: 'pending', packages: [] };
        return { status: 'finished', packages: files ? [id + '-pkg'] : [] }; },
      download: async id => { const options = byId.get(id.replace(/-pkg$/, ''));
        const files = packagesByRange.get(options.start + '|' + options.direction) || [];
        return archiveOf(files); } } };
}

function harness(sat, extra = {}) {
  let time = Date.parse('2026-12-04T15:00:00Z');   // vie 4 dic 2026, 09:00 MX
  let token = '';
  const mails = [];
  const service = createPacoSATService({
    dbFile: ':memory:', html: '<html><head><!--PACOSAT_TOKEN--></head><body>prueba</body></html>',
    origin: 'https://pacosat.test', proxyKey: key,
    makeConnector: () => ({ parser: FixtureParser, connector: sat.connector }),
    makeMailer: () => ({ verify: async () => true,
      sendMail: async mail => { mails.push(mail); return { messageId: 'm' + mails.length }; } }),
    now: () => time, ...extra });
  const raw = async (method, path, body, headers) => {
    const chunks = []; if (body !== undefined) chunks.push(Buffer.from(JSON.stringify(body)));
    const req = Readable.from(chunks);
    req.method = method; req.url = path; req.headers = headers;
    let status = 0, text = '';
    const res = { writeHead(code) { status = code; }, setHeader() {}, getHeader() { return undefined; },
      end(chunk) { if (chunk) text += chunk; } };
    await service.handle(req, res);
    return { status, text };
  };
  const call = async (method, path, body) => {
    if (!token) { const home = await raw('GET', '/', undefined,
      { host: 'pacosat.test', 'x-pacosat-proxy': key });
      token = (home.text.match(/name="pacosat-token" content="([^"]+)"/) || [])[1] || ''; }
    const { status, text } = await raw(method, path, body,
      { host: 'pacosat.test', origin: 'https://pacosat.test', 'x-pacosat-proxy': key,
        'x-pacosat-token': token });
    return { status, json: text ? JSON.parse(text) : null };
  };
  return { service, call, mails,
    set time(value) { time = value; }, get time() { return time; } };
}

const unlock = async h => {
  const mail = await h.call('POST', '/api/mail', { host: 'smtp.test', port: 465, security: 'ssl',
    from: 'avisos@pacosat.test', recipient: 'paco@test.mx', user: 'u', password: 'p' });
  assert.equal(mail.status, 200);
  const open = await h.call('POST', '/api/unlock', { rfc: RFC, minutes: 1440, days: 7,
    direction: 'both', password: 'simulated', certificate: 'YQ==', key: 'Yg==' });
  assert.equal(open.status, 200);
};
/* Las solicitudes CFDI no llevan `type` en sus opciones (solo las
   Metadata lo traen): CFDI = ausencia de tipo. */
const monthlyCalls = (sat, extra) => sat.calls.filter(c => !c.type &&
  (c.start === '2026-11-01' || c.start === '2026-12-06') && (!extra || extra(c)));

/* Los CFDI de noviembre que el SAT «entrega»: tres recibidos —
   uno de ellos YA estaba en el expediente (importado antes) — y
   dos emitidos. */
const S1 = 'AAAAAAAA-1111-4111-8111-111111111111';
const R1 = 'BBBBBBBB-2222-4222-8222-222222222222';
const R2 = 'CCCCCCCC-3333-4333-8333-333333333333';
const I1 = 'DDDDDDDD-4444-4444-8444-444444444444';
const I2 = 'EEEEEEEE-5555-4555-8555-555555555555';
const D1 = 'FFFFFFFF-6666-4666-8666-666666666666';
const recXml = (uuid, fecha) => ({ name: uuid + '.xml', data: xmlCfdi({ uuid, fecha, emisor: EMISOR, receptor: RFC }) });
const packages = new Map([
  ['2026-11-01|received', [recXml(R1, '2026-11-03T10:00:00'), recXml(R2, '2026-11-10T10:00:00'),
    recXml(S1, '2026-11-08T10:00:00')]],
  ['2026-11-01|issued', [{ name: I1 + '.xml', data: xmlCfdi({ uuid: I1, fecha: '2026-11-05T10:00:00', emisor: RFC, receptor: EMISOR }) },
    { name: I2 + '.xml', data: xmlCfdi({ uuid: I2, fecha: '2026-11-15T10:00:00', emisor: RFC, receptor: EMISOR }) }]],
  ['2026-12-06|received', [recXml(D1, '2026-12-12T10:00:00'), recXml(R2, '2026-11-10T10:00:00')]]
]);

/* ===== Escenario A: la corrida completa, su cuenta y su correo ===== */
{
  const sat = fakeSat({ packagesByRange: packages });
  const h = harness(sat);
  await unlock(h);
  /* El expediente ya tenía UN CFDI de noviembre (importado). */
  const seed = await h.call('POST', '/api/storage', { batch: {
    people: [{ id: RFC, name: 'JUGUETE SA' }, { id: EMISOR, name: 'EMISOR DE JUGUETE' }],
    invoices: [{ id: S1, date: '2026-11-08', kind: 'I', total: '116.00', currency: 'MXN',
      from: { rfc: EMISOR, name: 'EMISOR DE JUGUETE' }, to: { rfc: RFC, name: 'JUGUETE SA' } }] } });
  assert.equal(seed.status, 200);

  /* Día 4: la programación aún no dispara. */
  await h.service.tick();
  assert.equal(monthlyCalls(sat).length, 0, 'el día 4 no se pide nada del mes');
  let overview = (await h.call('GET', '/api/monthly')).json;
  assert.equal(overview.config.day, 5);
  assert.equal(overview.targetMonth, '2026-11');
  assert.deepEqual(overview.runs, []);

  /* Día 5, 09:00 MX: la corrida nace sola. La ventana rodante ya
     cubría 28 nov → 4 dic, así que la mensual pide SOLO lo que
     falta (1 → 27 nov) en ambos sentidos, más la Metadata del mes.
     (La sesión de e.firma se redesbloquea antes, como haría Paco:
     la de ayer caducó a las 24 h.) */
  h.time = Date.parse('2026-12-05T15:00:00Z');
  await unlock(h);
  await h.service.tick();
  const pedidas = monthlyCalls(sat);
  assert.equal(pedidas.length, 2, 'una solicitud por sentido');
  assert.ok(pedidas.every(c => c.start === '2026-11-01' && c.end === '2026-11-27'),
    'solo el tramo no cubierto: ' + JSON.stringify(pedidas.map(c => [c.start, c.end])));
  assert.ok(sat.calls.some(c => c.type === 'metadata' && c.start === '2026-11-01' && c.end === '2026-11-30'),
    'la Metadata del mes completo también se pide');
  overview = (await h.call('GET', '/api/monthly')).json;
  assert.equal(overview.runs[0].month, '2026-11');
  assert.equal(overview.runs[0].status, 'en-curso');

  /* El SAT tarda: primera comprobación, pendiente. */
  h.time += 5 * MIN; await h.service.tick();
  overview = (await h.call('GET', '/api/monthly')).json;
  assert.equal(overview.runs[0].status, 'en-curso');

  /* Segunda comprobación: paquetes dentro, corrida cerrada con
     la cuenta desde los registros. */
  h.time += 10 * MIN; await h.service.tick();
  overview = (await h.call('GET', '/api/monthly')).json;
  const run = overview.runs[0];
  assert.equal(run.status, 'hecha', JSON.stringify(run));
  assert.deepEqual(run.totals, { found: 5, added: 4, duplicates: 1, gaps: 0 },
    '5 de noviembre en el expediente: 4 entraron con la corrida y 1 ya estaba');

  /* El resumen de sucesos lleva la cuenta, una sola vez. */
  const resumen = h.mails.filter(m => /Descarga automática de noviembre de 2026/.test(m.subject || '') ||
    /Descarga automática de noviembre de 2026: 5 CFDI · 4 nuevos · 1 ya estaban · 0 huecos/.test(m.text || ''));
  assert.ok(resumen.length >= 1, 'el correo-resumen trae la cuenta de la corrida');
  assert.ok(h.mails.some(m => /5 CFDI · 4 nuevos · 1 ya estaban · 0 huecos/.test(m.text || '')),
    'la línea de la cuenta es exacta');
  const actividad = (await h.call('GET', '/api/storage?store=activity')).json;
  assert.ok(actividad.some(row => row.name === 'Descarga automática mensual' && /noviembre/.test(row.event || '')),
    'la actividad queda registrada');

  /* Idempotencia: ni el tick ni «descargar ahora» repiten el mes. */
  h.time += 24 * HOUR; await h.service.tick();
  assert.equal(monthlyCalls(sat).length, 2, 'al día siguiente no se repite noviembre');
  const again = await h.call('POST', '/api/monthly/run-now', { month: '2026-11' });
  assert.equal(again.status, 409, 'la corrida de noviembre ya existe');

  /* Recuperación: noviembre ya está cubierto, no se gasta nada. */
  const before = sat.calls.length;
  const covered = await h.call('POST', '/api/monthly/recover', { rfc: RFC, direction: 'received', month: '2026-11' });
  assert.equal(covered.status, 200);
  assert.equal(covered.json.recovery.covered, true);
  assert.equal(sat.calls.length, before, 'cubierto: cero solicitudes nuevas');

  /* Recuperación aparte: mayo de 2025 pide su mes y NO se mezcla
     con la corrida mensual (la lista de corridas no cambia). */
  const rec = await h.call('POST', '/api/monthly/recover', { rfc: RFC, direction: 'received', month: '2025-05' });
  assert.equal(rec.status, 200);
  assert.equal(rec.json.recovery.covered, false);
  assert.ok(sat.calls.some(c => !c.type && c.start === '2025-05-01' && c.end === '2025-05-31' &&
    c.direction === 'received'), 'la recuperación pide mayo de 2025 completo');
  overview = (await h.call('GET', '/api/monthly')).json;
  assert.equal(overview.runs.length, 1, 'la recuperación no crea ni toca corridas');
  h.time += 5 * MIN; await h.service.tick();
  const rec2 = await h.call('POST', '/api/monthly/recover', { rfc: RFC, direction: 'received', month: '2025-05' });
  assert.equal(rec2.json.recovery.covered, true, 'tras bajarla, mayo ya consta cubierto');

  /* Enero: la corrida de diciembre nace sola, y un CFDI de
     noviembre que el SAT re-entrega en el paquete de diciembre
     NO se duplica en el expediente. */
  h.time = Date.parse('2027-01-05T15:00:00Z');
  await h.service.tick();
  assert.ok(monthlyCalls(sat, c => c.start === '2026-12-06').length >= 1, 'diciembre también se pide solo');
  h.time += 5 * MIN; await h.service.tick();
  h.time += 10 * MIN; await h.service.tick();
  overview = (await h.call('GET', '/api/monthly')).json;
  const dec = overview.runs.find(r => r.month === '2026-12');
  assert.equal(dec.status, 'hecha', JSON.stringify(dec));
  assert.equal(dec.totals.found, 1, 'de diciembre solo entró el CFDI de diciembre');
  assert.equal(dec.totals.added, 1);
  const facturas = (await h.call('GET', '/api/storage?store=invoices')).json;
  assert.equal(facturas.filter(row => row.id === R2).length, 1, 'el CFDI re-entregado no se duplica');
  h.service.close();
  console.log('OK 1.15.0 A — corrida mensual completa: dispara el día fijado, pide solo lo no cubierto, cuenta 5/4/1/0 desde los registros, avisa por correo, no repite, recupera aparte y no duplica');
}

/* ===== Escenario A2: los huecos históricos salen de los registros ===== */
{
  const sat = fakeSat({});
  const h = harness(sat);
  const seed = await h.call('POST', '/api/storage', { batch: {
    people: [{ id: RFC, name: 'JUGUETE SA' }, { id: EMISOR, name: 'EMISOR DE JUGUETE' }],
    invoices: [
      { id: '11111111-1111-4111-8111-111111111111', date: '2026-08-14', kind: 'I', total: '116.00',
        currency: 'MXN', from: { rfc: EMISOR, name: 'EMISOR DE JUGUETE' }, to: { rfc: RFC, name: 'JUGUETE SA' } },
      { id: '22222222-2222-4222-8222-222222222222', date: '2026-11-14', kind: 'I', total: '116.00',
        currency: 'MXN', from: { rfc: EMISOR, name: 'EMISOR DE JUGUETE' }, to: { rfc: RFC, name: 'JUGUETE SA' } }] } });
  assert.equal(seed.status, 200);
  const overview = (await h.call('GET', '/api/monthly')).json;
  assert.ok(overview.gaps.some(g => g.rfc === RFC && g.direction === 'received' && g.month === '2026-09'),
    'septiembre consta como hueco entre agosto y noviembre');
  assert.ok(overview.gaps.some(g => g.rfc === RFC && g.direction === 'received' && g.month === '2026-10'),
    'octubre consta como hueco entre agosto y noviembre');
  assert.ok(!overview.gaps.some(g => g.month === '2026-08' || g.month === '2026-11'),
    'los meses con registros no son huecos');
  h.service.close();
  console.log('OK 1.15.0 A2 — los huecos históricos se calculan desde los registros reales');
}

/* ===== Escenario B: el descanso general manda ===== */
{
  const sat = fakeSat({ packagesByRange: packages });
  const h = harness(sat);
  await unlock(h);
  const rest = await h.call('POST', '/api/rest', { until: h.time + 3 * 24 * HOUR });
  assert.equal(rest.status, 200);
  h.time = Date.parse('2026-12-05T15:00:00Z');
  await h.service.tick();
  assert.equal(sat.calls.filter(c => c.start === '2026-11-01').length, 0, 'descansando no se pide el mes');
  let overview = (await h.call('GET', '/api/monthly')).json;
  assert.deepEqual(overview.runs, [], 'descansando no nace la corrida');
  const now = await h.call('POST', '/api/monthly/run-now', {});
  assert.equal(now.status, 409, '«descargar ahora» también respeta el descanso');
  const wake = await h.call('POST', '/api/rest', { until: 0 });
  assert.equal(wake.status, 200);
  await h.service.tick();
  overview = (await h.call('GET', '/api/monthly')).json;
  assert.equal(overview.runs.length, 1, 'al despertar, la corrida pendiente nace');
  h.service.close();
  console.log('OK 1.15.0 B — descanso general: ni corrida ni solicitudes; al despertar se retoma');
}

/* ===== Escenario C: el RFC con CIEC espera el gesto de Paco ===== */
{
  const dir = mkdtempSync(join(tmpdir(), 'pacosat-1150-ciec-'));
  const ciecCalls = [];
  const xmlReal = '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital" ' +
    'Version="4.0" Serie="A" Folio="7" Fecha="2026-11-12T10:00:00" Sello="AAAA" FormaPago="03" SubTotal="100.00" ' +
    'Moneda="MXN" Total="116.00" TipoDeComprobante="I" MetodoPago="PUE" LugarExpedicion="72000">' +
    '<cfdi:Emisor Rfc="' + EMISOR + '" Nombre="EMISOR DE JUGUETE" RegimenFiscal="601"/>' +
    '<cfdi:Receptor Rfc="' + CIEC_RFC + '" Nombre="CLIENTE CIEC" DomicilioFiscalReceptor="72000" RegimenFiscalReceptor="601" UsoCFDI="G03"/>' +
    '<cfdi:Conceptos><cfdi:Concepto ClaveProdServ="01010101" Cantidad="1" ClaveUnidad="ACT" Descripcion="Servicio" ValorUnitario="100.00" Importe="100.00" ObjetoImp="02">' +
    '<cfdi:Impuestos><cfdi:Traslados><cfdi:Traslado Base="100.00" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="16.00"/></cfdi:Traslados></cfdi:Impuestos>' +
    '</cfdi:Concepto></cfdi:Conceptos>' +
    '<cfdi:Impuestos TotalImpuestosTrasladados="16.00"><cfdi:Traslados><cfdi:Traslado Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="16.00"/></cfdi:Traslados></cfdi:Impuestos>' +
    '<cfdi:Complemento><tfd:TimbreFiscalDigital Version="1.1" UUID="99999999-8888-4888-8888-888888888888" FechaTimbrado="2026-11-12T10:00:01" ' +
    'RfcProvCertif="AAA010101AAA" SelloCFD="BBBB" NoCertificadoSAT="00001000000500000001" SelloSAT="CCCC"/></cfdi:Complemento></cfdi:Comprobante>';
  const sat = fakeSat({});
  const h = harness(sat, { efirmaDir: dir,
    satCiecFetch: async (profile, query) => { ciecCalls.push({ rfc: profile.rfc, ...query });
      return { files: [{ name: 'ciec.xml', buffer: Buffer.from(xmlReal) }],
        found: 1, downloaded: 1, complete: true, notes: [] }; } });
  const mailCfg = await h.call('POST', '/api/mail', { host: 'smtp.test', port: 465, security: 'ssl',
    from: 'avisos@pacosat.test', recipient: 'paco@test.mx', user: 'u', password: 'p' });
  assert.equal(mailCfg.status, 200);
  const seed = await h.call('POST', '/api/storage', { batch: {
    people: [{ id: CIEC_RFC, name: 'CLIENTE CIEC' }, { id: EMISOR, name: 'EMISOR DE JUGUETE' }] } });
  assert.equal(seed.status, 200);
  const ciec = await h.call('POST', '/api/ciec', { rfc: CIEC_RFC, minutes: 360, days: 7,
    direction: 'both', ciec: 'secreto-de-paco' });
  assert.equal(ciec.status, 200, JSON.stringify(ciec.json));
  /* Día 5: la corrida nace, pero la vía CIEC NO se lanza sola. */
  h.time = Date.parse('2026-12-05T15:00:00Z');
  await h.service.tick();
  assert.equal(ciecCalls.length, 0, 'la CIEC nunca baja sola: el captcha es el gesto de Paco');
  let overview = (await h.call('GET', '/api/monthly')).json;
  assert.equal(overview.runs[0].perRfc[CIEC_RFC].status, 'esperando-gesto');
  assert.equal(overview.runs[0].status, 'parcial');
  assert.ok(h.mails.some(m => /esperando tu gesto/.test(m.text || '')), 'el resumen avisa del gesto pendiente');
  /* Paco hace su gesto: baja noviembre exacto por la vía CIEC. */
  const run = await h.call('POST', '/api/ciec/run', { rfc: CIEC_RFC,
    start: '2026-11-01', end: '2026-11-30', direction: 'received' });
  assert.equal(run.status, 200, JSON.stringify(run.json));
  for (let i = 0; i < 40; i++) { overview = (await h.call('GET', '/api/monthly')).json;
    if (overview.runs[0].perRfc[CIEC_RFC].status === 'hecha') break;
    await new Promise(resolve => setTimeout(resolve, 50)); }
  assert.equal(overview.runs[0].perRfc[CIEC_RFC].status, 'hecha',
    'la bajada CIEC del mes exacto se suma a la corrida');
  assert.equal(overview.runs[0].perRfc[CIEC_RFC].found, 1);
  assert.equal(overview.runs[0].status, 'hecha', 'con su parte hecha, la corrida queda completa');
  h.service.close();
  rmSync(dir, { recursive: true, force: true });
  console.log('OK 1.15.0 C — CIEC: nunca automático; «esperando tu gesto» en la corrida y la bajada del mes exacto se le suma');
}

/* ===== Escenario D: si el SAT rechaza, la corrida lo cuenta ===== */
{
  const sat = fakeSat({ failMonthly: true });
  const h = harness(sat);
  await unlock(h);
  h.time = Date.parse('2026-12-05T15:00:00Z');
  await unlock(h);
  await h.service.tick();
  h.time += 5 * MIN; await h.service.tick();
  const overview = (await h.call('GET', '/api/monthly')).json;
  assert.equal(overview.runs[0].status, 'fallida', JSON.stringify(overview.runs[0]));
  const notices = (await h.call('GET', '/api/notices')).json;
  assert.ok(notices.avisos.some(a => /descarga automática de noviembre/i.test(a.titulo || '')),
    'el fallo entra en el Centro de Avisos');
  assert.ok(h.mails.some(m => /no quedó completa/.test(m.text || '') || /0 CFDI · 0 nuevos/.test(m.text || '')),
    'el resumen también lo cuenta');
  h.service.close();
  console.log('OK 1.15.0 D — fallo del SAT: corrida «fallida», aviso en el Centro y cuenta en el resumen');
}

/* ===== Escenario F: la corrida que muere AL PEDIR se relanza (1.19.0) =====
   El fallo real de producción (10 nov 2026, 19:21): el conector
   lanzaba «sdk.DownloadType.received is not a function» al pedir
   — sin crear un solo job — y la corrida de octubre quedó
   «fallida» con 0 encontrados. Hasta la 1.18.0 ese mes no tenía
   reintento como corrida (el tick no recrea un mes con corrida
   y «descargar ahora» respondía 409 «ya se hizo»). Aquí: la
   corrida nace y muere al instante con el conector roto; con el
   conector corregido, «descargar ahora» la RELANZA (sustituye la
   fallida) y la corrida nueva cierra «hecha» con la cuenta desde
   los registros, sin repetir tramos cubiertos ni duplicar CFDI. */
{
  let brokenCalls = 0;
  const broken = {
    request: async () => { brokenCalls++;
      throw new TypeError('sdk.DownloadType.received is not a function'); },
    check: async () => ({ status: 'failed', packages: [] }),
    download: async () => { throw new Error('sin paquetes'); } };
  const sat = fakeSat({ packagesByRange: packages });
  let current = broken;
  const h = harness(sat, { makeConnector: () => ({ parser: FixtureParser, connector: current }) });
  await unlock(h);
  const seed = await h.call('POST', '/api/storage', { batch: {
    people: [{ id: RFC, name: 'JUGUETE SA' }, { id: EMISOR, name: 'EMISOR DE JUGUETE' }],
    invoices: [{ id: S1, date: '2026-11-08', kind: 'I', total: '116.00', currency: 'MXN',
      from: { rfc: EMISOR, name: 'EMISOR DE JUGUETE' }, to: { rfc: RFC, name: 'JUGUETE SA' } }] } });
  assert.equal(seed.status, 200);

  /* Día 5: la corrida nace y muere al instante, como en producción. */
  h.time = Date.parse('2026-12-05T15:00:00Z');
  await unlock(h);
  await h.service.tick();
  assert.ok(brokenCalls >= 1, 'la corrida intentó pedir y el conector roto la tumbó');
  let overview = (await h.call('GET', '/api/monthly')).json;
  assert.equal(overview.runs.length, 1);
  assert.equal(overview.runs[0].status, 'fallida', JSON.stringify(overview.runs[0]));
  assert.deepEqual(overview.runs[0].totals, { found: 0, added: 0, duplicates: 0, gaps: 0 },
    'fallida al instante: 0 encontrados, como la de octubre en producción');
  assert.match(overview.runs[0].perRfc[RFC].error, /DownloadType\.received is not a function/,
    'el error queda registrado en la corrida');
  assert.ok(h.mails.some(m => /no quedó completa/.test(m.subject || '') || /no quedó completa/.test(m.text || '')),
    'el aviso de la corrida fallida salió');

  /* El tick NO la recrea solo: el mes fallido no se baja solo. */
  h.time += 24 * HOUR; await h.service.tick();
  overview = (await h.call('GET', '/api/monthly')).json;
  assert.equal(overview.runs.length, 1, 'al día siguiente la fallida sigue siendo la única corrida');
  assert.equal(overview.runs[0].status, 'fallida');

  /* Con el conector corregido, «descargar ahora» RELANZA el mes. */
  current = sat.connector;
  await unlock(h);
  const relaunch = await h.call('POST', '/api/monthly/run-now', { month: '2026-11' });
  assert.equal(relaunch.status, 200, 'una corrida fallida sí se puede relanzar: ' + JSON.stringify(relaunch.json));
  overview = (await h.call('GET', '/api/monthly')).json;
  assert.equal(overview.runs.length, 1, 'la relanzada SUSTITUYE a la fallida, no se apila');
  assert.equal(overview.runs[0].status, 'en-curso');
  assert.equal(monthlyCalls(sat).length, 2, 'la relanzada pide solo los tramos no cubiertos, una por sentido');

  /* Y completa: paquetes dentro, cuenta desde los registros. */
  h.time += 5 * MIN; await h.service.tick();
  h.time += 10 * MIN; await h.service.tick();
  overview = (await h.call('GET', '/api/monthly')).json;
  const run = overview.runs[0];
  assert.equal(run.status, 'hecha', JSON.stringify(run));
  assert.deepEqual(run.totals, { found: 5, added: 4, duplicates: 1, gaps: 0 },
    'la cuenta de la relanzada: 5 en el expediente, 4 nuevos y el que ya estaba no se duplicó');

  /* Una corrida hecha ya NO se relanza: 409, como siempre. */
  const again = await h.call('POST', '/api/monthly/run-now', { month: '2026-11' });
  assert.equal(again.status, 409, 'la corrida hecha no se relanza');
  h.service.close();
  console.log('OK 1.19.0 F — la corrida que muere al pedir queda «fallida» con su error, no se recrea sola, y «descargar ahora» la relanza hasta cerrarla «hecha» sin duplicar');
}

/* ===== Escenario E: la configuración manda ===== */
{
  const sat = fakeSat({ packagesByRange: packages });
  const h = harness(sat);
  await unlock(h);
  const off = await h.call('POST', '/api/monthly/config', { enabled: false, day: 5, hour: 9 });
  assert.equal(off.status, 200);
  h.time = Date.parse('2026-12-05T15:00:00Z');
  await unlock(h);
  await h.service.tick();
  assert.deepEqual((await h.call('GET', '/api/monthly')).json.runs, [], 'apagada: no hay corrida el día 5');
  const day6 = await h.call('POST', '/api/monthly/config', { enabled: true, day: 6, hour: 9 });
  assert.equal(day6.status, 200);
  await h.service.tick();
  assert.deepEqual((await h.call('GET', '/api/monthly')).json.runs, [], 'con el día en 6, el 5 no dispara');
  h.time = Date.parse('2026-12-06T15:00:00Z');
  await unlock(h);
  await h.service.tick();
  assert.equal((await h.call('GET', '/api/monthly')).json.runs.length, 1, 'el día 6 sí dispara');
  h.service.close();
  console.log('OK 1.15.0 E — configuración: apagar y mover el día se respeta');
}
