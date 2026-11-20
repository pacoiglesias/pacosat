/* ================================================================
   Ronda 1.32.3 — PIEZA 1 (ronda chica, orden de Paco 15 nov:
   por partes, cada pieza revisada y auditada).
   EL DEFECTO (lo cazó el propio Paco con la captura del correo
   del job 57): el correo de novedades anunció «Entraron 5
   comprobante(s) nuevo(s)… Importe total de lo nuevo: $416.41»
   por un paquete cuya importación contó esos 5 como YA
   PRESENTES (0 altas). Dos criterios de novedad convivían:
   la importación deduplica contra records (putMetadata, INSERT
   OR IGNORE) y el detalle del correo se filtraba contra
   `discovered` (lo visto por metadatos). Un XML ya guardado —
   p. ej. subido a mano, sin fila en discovered — era duplicado
   para la importación y «nuevo» para el correo.
   LA CORRECCIÓN: criterio ÚNICO — en inspectPackage, la
   novedad del aviso se calcula contra la foto de records
   (store='invoices') tomada antes de importar el paquete;
   el detalle y el total del correo salen solo de las altas
   reales, y con 0 altas no se encola aviso.
   Esta suite lo juzga con el servidor real y el doble del SAT
   de la 1.22.0: la bandeja siembra un «ya presente» genuino
   (su alta real por records, sin pasar por discovered) y dos
   descargas del SAT lo re-traen — solo, y acompañado de uno
   nuevo de verdad.
   ================================================================ */

import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPacoSATService } from './local-server.mjs';
import { crc32 } from './xml-core.mjs';

const RFC = 'XAXX010101000';
const EMISOR = 'AAA010101AAA';
const key = 'd'.repeat(64);
const MIN = 60_000;
const ROOT = import.meta.dirname;
const read = name => readFileSync(join(ROOT, name), 'utf8');

/* ===== 1 · Versión y sellos de la pieza ===== */
{
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.version, '3.1.0', 'la ronda es la 2.0.1');
  assert.ok(read('ejecutor-local.mjs').includes("EJECUTOR_VERSION = '3.1.0'"), 'el ejecutor declara 2.0.1 (solo el sello)');
  const html = read('Faro-Fiscal.html');
  assert.ok(html.includes('"version":"3.1.0"'), 'el artefacto se sella 2.0.1');
  assert.ok(html.includes("version: '3.1.0'"), 'la nota de novedades es la de esta versión');
  assert.ok(html.includes('Qué cambió desde ayer'), 'la nota cuenta la novedad en llano (re-basificado en la 2.3.0: la nota de esta ronda cuenta en llano los cambios de Hoy, el «Seguir», la línea de vida de Declaraciones y la ronda visual; en la 2.0.2 contaba las entradas propias del Buzón y de Declaraciones y la corrección del origen)');
  console.log('OK 1.32.3 · versión y sellos.');
}

/* ---------- Parser de juguete fiel a parseXml (el de la 1.22.0) ---------- */
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
        Serie: attr('cfdi:Comprobante', 'Serie'), Folio: attr('cfdi:Comprobante', 'Folio'),
        Moneda: 'MXN', TipoDeComprobante: 'I' },
      [node('Emisor', { Rfc: attr('cfdi:Emisor', 'Rfc'), Nombre: 'EMISOR DE JUGUETE' }),
       node('Receptor', { Rfc: attr('cfdi:Receptor', 'Rfc'), Nombre: 'RECEPTOR DE JUGUETE' }),
       node('Complemento', {}, [stamp])]);
    return { documentElement: root, getElementsByTagName: () => [] };
  }
}

const xmlCfdi = ({ uuid, fecha, emisor, receptor, total = '116.00', serie = '', folio = '' }) =>
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital" ' +
  'Version="4.0" Fecha="' + fecha + '" Moneda="MXN" Total="' + total + '" TipoDeComprobante="I"' +
  (serie ? ' Serie="' + serie + '"' : '') + (folio ? ' Folio="' + folio + '"' : '') + '>' +
  '<cfdi:Emisor Rfc="' + emisor + '" Nombre="EMISOR DE JUGUETE"/>' +
  '<cfdi:Receptor Rfc="' + receptor + '" Nombre="RECEPTOR DE JUGUETE"/>' +
  '<cfdi:Complemento><tfd:TimbreFiscalDigital Version="1.1" UUID="' + uuid + '" FechaTimbrado="' + fecha + '"/></cfdi:Complemento>' +
  '</cfdi:Comprobante>';

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

/* Doble del SAT: cada ventana termina a la primera con los
   paquetes sembrados por (inicio|sentido). */
function fakeSat({ packagesByRange = new Map() } = {}) {
  const calls = [];
  const byId = new Map();
  return { calls,
    connector: {
      request: async options => { calls.push({ ...options });
        const id = 'req-' + calls.length; byId.set(id, options); return id; },
      check: async id => { const options = byId.get(id);
        const files = packagesByRange.get(options.start + '|' + options.direction);
        return { status: 'finished', packages: files ? [id + '-pkg'] : [] }; },
      download: async id => { const options = byId.get(id.replace(/-pkg$/, ''));
        const files = packagesByRange.get(options.start + '|' + options.direction) || [];
        return archiveOf(files); } } };
}

function harness(sat, extra = {}) {
  let time = Date.parse('2026-12-04T15:00:00Z');   // vie 4 dic 2026: la mensual no dispara
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

const setupMail = async h => {
  const mail = await h.call('POST', '/api/mail', { host: 'smtp.test', port: 465, security: 'ssl',
    from: 'avisos@pacosat.test', recipient: 'paco@test.mx', user: 'u', password: 'p' });
  assert.equal(mail.status, 200);
  const seed = await h.call('POST', '/api/storage', { batch: {
    people: [{ id: RFC, name: 'JUGUETE SA' }, { id: EMISOR, name: 'EMISOR DE JUGUETE' }] } });
  assert.equal(seed.status, 200);
};
const unlock = async h => {
  const open = await h.call('POST', '/api/unlock', { rfc: RFC, minutes: 1440, days: 7,
    direction: 'both', password: 'simulated', certificate: 'YQ==', key: 'Yg==' });
  assert.equal(open.status, 200);
};
const newsMails = mails => mails.filter(m => String(m.subject || '').startsWith('PacoSAT · Nuevos CFDI'));
const recXml = (uuid, fecha, extra = {}) => ({ name: uuid + '.xml',
  data: xmlCfdi({ uuid, fecha, emisor: EMISOR, receptor: RFC, ...extra }) });

/* ===== 2 · La pieza: un solo criterio de novedad ===== */
{
  /* El «ya presente»: mismos datos del caso real (Google, 1 nov,
     $416.41) para que la regresión se reconozca a simple vista. */
  const A = '13230000-0001-4001-8001-000000000001';
  const B = '13230000-0002-4002-8002-000000000002';
  const xmlA = xmlCfdi({ uuid: A, fecha: '2026-11-01T10:00:00', emisor: EMISOR, receptor: RFC,
    total: '416.41', serie: 'FCP', folio: '28257675' });
  const packages = new Map([
    ['2026-10-01|received', [recXml(A, '2026-11-01T10:00:00', { total: '416.41', serie: 'FCP', folio: '28257675' })]],
    ['2026-09-01|received', [recXml(A, '2026-11-01T10:00:00', { total: '416.41', serie: 'FCP', folio: '28257675' }),
      recXml(B, '2026-11-02T10:00:00', { total: '100.00', serie: 'FCP', folio: '999' })]]]);
  const dir = mkdtempSync(join(tmpdir(), 'pacosat-1323-'));
  const h = harness(fakeSat({ packagesByRange: packages }),
    { watchDir: dir, inboxParser: FixtureParser, watchSettleMs: 0 });
  try {
    await setupMail(h);
    await unlock(h);

    /* Semilla: A entra por la bandeja — alta REAL contra records
       (la vía compartida deduplica contra records y no escribe
       en discovered: el hueco exacto del defecto). Su correo de
       bandeja SÍ debe salir: esa alta es genuina. */
    writeFileSync(join(dir, 'ya-presente.xml'), xmlA);
    await h.service.inboxTick(h.time);
    for (let i = 0; i < 10 && newsMails(h.mails).length < 1; i++) { h.time += 1 * MIN; await h.service.tick(); }
    assert.equal(newsMails(h.mails).length, 1, 'el alta de bandeja anuncia su correo (alta genuina)');
    assert.ok(newsMails(h.mails)[0].subject.includes('carpeta vigilada'), 'ese correo es el de la bandeja');
    assert.ok(newsMails(h.mails)[0].text.includes('Importe total de lo nuevo: $416.41.'),
      'la bandeja sumó su alta real');

    /* Descarga del SAT que re-trae SOLO a A: 0 altas reales →
       NO se encola aviso y NO sale correo. Con el defecto, aquí
       nacía el segundo correo («1 nuevo · $416.41»). */
    const req1 = await h.call('POST', '/api/request', { rfc: RFC, direction: 'received',
      start: '2026-10-01', end: '2026-10-31' });
    assert.equal(req1.status, 200);
    h.time += 5 * MIN; await h.service.tick();
    for (let i = 0; i < 10; i++) { h.time += 1 * MIN; await h.service.tick(); }
    assert.equal(newsMails(h.mails).length, 1,
      'un paquete sin altas no produce correo de novedades (ni un segundo anuncio de lo ya presente)');

    /* Descarga mixta: A (ya presente) + B (nuevo de verdad) →
       UN correo, con SOLO B en el detalle y SOLO su importe en
       el total. */
    const req2 = await h.call('POST', '/api/request', { rfc: RFC, direction: 'received',
      start: '2026-09-01', end: '2026-09-30' });
    assert.equal(req2.status, 200);
    h.time += 5 * MIN; await h.service.tick();
    for (let i = 0; i < 10 && newsMails(h.mails).length < 2; i++) { h.time += 1 * MIN; await h.service.tick(); }
    assert.equal(newsMails(h.mails).length, 2, 'la descarga mixta produce exactamente un correo nuevo');
    const mail = newsMails(h.mails)[1];
    assert.ok(mail.subject.includes('· 1 ·'), 'el asunto cuenta UNA alta, no dos: ' + mail.subject);
    assert.ok(mail.text.includes('Entraron 1 comprobante(s) nuevo(s)'), 'el cuerpo cuenta una alta');
    assert.ok(mail.text.includes('folio FCP-999'), 'el detalle trae al nuevo');
    assert.ok(mail.text.includes('Importe total de lo nuevo: $100.00.'),
      'el total es SOLO el del alta real');
    assert.ok(!mail.text.includes('28257675'), 'el ya presente no se re-anuncia');
    assert.ok(!mail.text.includes('416.41'), 'el ya presente no suma en el total');
    console.log('OK 1.32.3 · criterio único de novedad — sin altas no hay correo; en la mixta, solo el alta real y su importe.');
  } finally {
    h.service.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log('OK 1.32.3 · ronda completa.');
