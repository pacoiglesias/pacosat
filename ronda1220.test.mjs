/* Ronda 1.22.0 — Los correos de novedades, CON DATOS y AGRUPADOS.
   El correo viejo no decía ni un dato («detectó N comprobante(s)
   nuevo(s)… abre la app») y era POR PAQUETE: la recuperación de
   la noche del 10→11 nov mandó 7 correos en 36 segundos. Esta
   ronda juzga los correos que el sistema GENERA con semilla:
   - el compositor puro: asunto con cuenta y periodo, una línea
     por comprobante con fecha, contraparte, folio (o «sin
     folio»), importe, estado si consta y clase; tope de 50
     líneas y la línea «y N más — el detalle completo está en
     PacoSAT» con semilla grande;
   - una recuperación de DOS meses lanzada como una operación
     produce exactamente UN correo con el detalle de CADA
     comprobante de ambos meses;
   - una recuperación de UN mes nombra ese mes en el asunto;
   - la bandeja agrupa su pasada en un correo, con recibidos y
     emitidos distinguidos línea a línea;
   - el interruptor maestro de Ajustes › Correo apaga también
     estos avisos (y al encenderlo, lo pendiente sale);
   - el tope compartido de 5 correos de suceso por hora detiene
     el sexto aviso de novedades: no sale un sexto correo. */
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPacoSATService } from './local-server.mjs';
import { crc32 } from './xml-core.mjs';
import { composeNewsMail, NEWS_MAIL_LIMIT } from './news-mail.mjs';

const RFC = 'XAXX010101000';
const EMISOR = 'AAA010101AAA';
const key = 'd'.repeat(64);
const MIN = 60_000;

/* ---------- Parser de juguete fiel a parseXml (con Serie/Folio) ---------- */
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

/* Doble fiel del SAT (el de la ronda 1.15.0): las ventanas
   mensuales especiales tardan una comprobación; el resto termina
   a la primera con los paquetes sembrados por ventana. */
function fakeSat({ packagesByRange = new Map() } = {}) {
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
        const files = packagesByRange.get(options.start + '|' + options.direction);
        if (isMonthly(options) && n < 2) return { status: 'pending', packages: [] };
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

/* ===== U · El compositor puro: datos, asunto, tope y «y N más» ===== */
{
  const rows = [
    { uuid: 'U1', fecha: '2025-11-12', counterpartName: 'COMERCIAL EJEMPLO SA', counterpartRfc: EMISOR,
      folio: '4821', serie: 'F', total: '15230.80', estado: 'Vigente', kind: 'I', direction: 'received' },
    { uuid: 'U2', fecha: '2025-11-27', counterpartName: 'OTRO PROVEEDOR SA', counterpartRfc: 'BBB010101BB2',
      folio: '', serie: '', total: '980.00', estado: '', kind: 'I', direction: 'received' }];
  const mail = composeNewsMail({ kind: 'recuperacion', rfc: RFC, direction: 'received', label: 'noviembre de 2025' }, rows);
  /* 1.24.0 (M3, correos por RFC): el asunto también nombra el RFC del que habla. */
  assert.equal(mail.subject, 'PacoSAT · Nuevos CFDI recibidos · 2 · noviembre de 2025 · XAXX010101000');
  assert.ok(mail.text.includes('12 de noviembre de 2025'), 'fecha larga del primero');
  assert.ok(mail.text.includes('COMERCIAL EJEMPLO SA (AAA010101AAA)'), 'contraparte con nombre y RFC');
  assert.ok(mail.text.includes('folio F-4821'), 'serie y folio');
  assert.ok(mail.text.includes('$15,230.80'), 'importe con formato');
  assert.ok(mail.text.includes('Vigente'), 'el estado consta cuando consta');
  assert.ok(mail.text.includes('recibido · ingreso'), 'la clase de cada comprobante');
  assert.ok(mail.text.includes('27 de noviembre de 2025') && mail.text.includes('sin folio'),
    'sin folio se dice, no se inventa');
  assert.ok(mail.text.includes('Importe total de lo nuevo: $16,210.80.'), 'la suma de los importes');
  assert.ok(mail.text.includes('para el RFC ' + RFC), 'a quién afecta');

  const big = Array.from({ length: 55 }, (_, i) => ({ uuid: 'B' + i, fecha: '2025-11-' + String(1 + (i % 28)).padStart(2, '0'),
    counterpartName: 'PROVEEDOR ' + i, counterpartRfc: EMISOR, folio: String(1000 + i), serie: '',
    total: '100.00', estado: '', kind: 'I', direction: 'received' }));
  const capped = composeNewsMail({ kind: 'recuperacion', rfc: RFC, direction: 'received', label: 'noviembre de 2025' }, big);
  const detailLines = capped.text.split('\n').filter(line => line.startsWith('· ') && !line.includes('…y'));
  assert.equal(detailLines.length, NEWS_MAIL_LIMIT, 'el detalle se corta en el tope declarado');
  assert.ok(capped.text.includes('…y 5 más — el detalle completo está en PacoSAT'), 'la línea de resto');
  assert.ok(capped.subject.includes('· 55 ·'), 'el asunto cuenta TODOS, no solo los listados');
  console.log('OK 1.22.0 U — el compositor: asunto con cuenta y periodo, detalle completo por comprobante, tope de ' +
    NEWS_MAIL_LIMIT + ' y línea «y N más».');
}

/* ===== A · Una recuperación de DOS meses = UN correo con todo ===== */
{
  const M1 = '12200000-0001-4001-8001-000000000101';
  const M2 = '12200000-0002-4002-8002-000000000102';
  const J1 = '12200000-0003-4003-8003-000000000103';
  const packages = new Map([
    ['2025-05-01|received', [recXml(M1, '2025-05-06T10:00:00', { total: '1160.00', serie: 'A', folio: '101' }),
      recXml(M2, '2025-05-20T10:00:00', { total: '2320.00', serie: 'A', folio: '102' })]],
    ['2025-06-01|received', [recXml(J1, '2025-06-11T10:00:00', { total: '580.00' })]]]);
  const h = harness(fakeSat({ packagesByRange: packages }));
  await setupMail(h);
  await unlock(h);
  const recMay = await h.call('POST', '/api/monthly/recover', { rfc: RFC, direction: 'received', month: '2025-05' });
  assert.equal(recMay.status, 200);
  h.time += 5 * MIN; await h.service.tick();           // mayo baja y se importa
  const recJun = await h.call('POST', '/api/monthly/recover', { rfc: RFC, direction: 'received', month: '2025-06' });
  assert.equal(recJun.status, 200);
  /* La cola procesa los trabajos uno a uno (entre mayo y junio
     corren también la vigilancia y la cobertura): se drena con
     ticks de un minuto, como el tick real, hasta que la operación
     entera ha terminado y su ÚNICO correo ha salido. El aviso de
     mayo no puede salir antes: la retención «la operación sigue
     viva» lo guarda hasta que junio también haya entrado. */
  let news = newsMails(h.mails);
  for (let i = 0; i < 90 && !news.length; i++) { h.time += 1 * MIN; await h.service.tick(); news = newsMails(h.mails); }
  assert.equal(news.length, 1, 'la operación drenó y produjo su correo');
  for (let i = 0; i < 5; i++) { h.time += 1 * MIN; await h.service.tick(); }
  news = newsMails(h.mails);
  assert.equal(news.length, 1, 'dos meses recuperados de una vez = UN correo, no uno por mes');
  assert.equal(news[0].subject, 'PacoSAT · Nuevos CFDI recibidos · 3 · XAXX010101000');
  for (const needle of ['6 de mayo de 2025', 'folio A-101', '$1,160.00',
      '20 de mayo de 2025', 'folio A-102', '$2,320.00',
      '11 de junio de 2025', 'sin folio', '$580.00', 'EMISOR DE JUGUETE'])
    assert.ok(news[0].text.includes(needle), 'el correo trae «' + needle + '»');
  assert.ok(news[0].text.includes('Importe total de lo nuevo: $4,060.00.'), 'la suma cuadra con la semilla');
  assert.ok(news[0].text.includes('meses anteriores'), 'sin prometer un solo mes cuando entraron dos');
  h.service.close();
  console.log('OK 1.22.0 A — recuperación de dos meses: exactamente un correo, con fecha/emisor/folio/importe de cada comprobante.');
}

/* ===== B · Una recuperación de UN mes nombra ese mes ===== */
{
  const N1 = '12200000-0011-4011-8011-000000000111';
  const N2 = '12200000-0012-4012-8012-000000000112';
  const packages = new Map([
    ['2025-11-01|received', [recXml(N1, '2025-11-03T10:00:00', { total: '10000.00', serie: 'B', folio: '7' }),
      recXml(N2, '2025-11-21T10:00:00', { total: '2500.50', serie: 'B', folio: '8' })]]]);
  const h = harness(fakeSat({ packagesByRange: packages }));
  await setupMail(h);
  await unlock(h);
  const rec = await h.call('POST', '/api/monthly/recover', { rfc: RFC, direction: 'received', month: '2025-11' });
  assert.equal(rec.status, 200);
  h.time += 5 * MIN; await h.service.tick();
  h.time += 3 * MIN; await h.service.tick();
  const news = newsMails(h.mails);
  assert.equal(news.length, 1);
  assert.equal(news[0].subject, 'PacoSAT · Nuevos CFDI recibidos · 2 · noviembre de 2025 · XAXX010101000',
    'el asunto lleva la cuenta, el periodo y el RFC (1.24.0, M3)');
  assert.ok(news[0].text.includes('con la recuperación de noviembre de 2025'));
  assert.ok(news[0].text.includes('folio B-7') && news[0].text.includes('$10,000.00'));
  assert.ok(news[0].text.includes('folio B-8') && news[0].text.includes('$2,500.50'));
  assert.ok(news[0].text.includes('Importe total de lo nuevo: $12,500.50.'));
  h.service.close();
  console.log('OK 1.22.0 B — recuperación de un mes: asunto «· 2 · noviembre de 2025» y detalle completo.');
}

/* ===== C · La bandeja: una pasada, un correo, sentidos por línea ===== */
{
  const dir = mkdtempSync(join(tmpdir(), 'pacosat-1220-bandeja-'));
  const h = harness(fakeSat(), { watchDir: dir, inboxParser: FixtureParser, watchSettleMs: 0 });
  await setupMail(h);
  await unlock(h);   // el perfil existe: la bandeja distingue recibidos de emitidos contra ÉL
  const W1 = '12200000-0021-4021-8021-000000000121';
  const W2 = '12200000-0022-4022-8022-000000000122';
  writeFileSync(join(dir, 'proveedor.xml'), xmlCfdi({ uuid: W1, fecha: '2026-11-02T10:00:00',
    emisor: EMISOR, receptor: RFC, total: '4640.00', serie: 'C', folio: '55' }));
  writeFileSync(join(dir, 'cliente.xml'), xmlCfdi({ uuid: W2, fecha: '2026-11-09T10:00:00',
    emisor: RFC, receptor: EMISOR, total: '1160.00', serie: 'C', folio: '56' }));
  await h.service.inboxTick(h.time);
  h.time += 3 * MIN; await h.service.tick();
  const news = newsMails(h.mails);
  assert.equal(news.length, 1, 'la pasada de la bandeja es un solo correo');
  /* La bandeja NO lleva RFC en el asunto (1.24.0, M3): su aviso
     nace sin RFC atribuido — es la operación de la carpeta
     vigilada de la instalación, no de un contribuyente — y el
     asunto solo nombra el RFC cuando el aviso lo trae. */
  assert.equal(news[0].subject, 'PacoSAT · Nuevos CFDI · 2 · carpeta vigilada');
  assert.ok(news[0].text.includes('folio C-55') && news[0].text.includes('recibido · ingreso'));
  assert.ok(news[0].text.includes('folio C-56') && news[0].text.includes('emitido · ingreso'));
  assert.ok(news[0].text.includes('$4,640.00') && news[0].text.includes('$1,160.00'));
  h.service.close();
  rmSync(dir, { recursive: true, force: true });
  console.log('OK 1.22.0 C — bandeja: un correo por pasada, con el sentido de cada comprobante en su línea.');
}

/* ===== D · El interruptor maestro apaga también estos avisos ===== */
{
  const D1 = '12200000-0031-4031-8031-000000000131';
  const packages = new Map([
    ['2025-11-01|received', [recXml(D1, '2025-11-14T10:00:00', { total: '700.00', serie: 'D', folio: '9' })]]]);
  const h = harness(fakeSat({ packagesByRange: packages }));
  await setupMail(h);
  await unlock(h);
  const off = await h.call('POST', '/api/mail/alerts', { enabled: false });
  assert.equal(off.status, 200);
  const rec = await h.call('POST', '/api/monthly/recover', { rfc: RFC, direction: 'received', month: '2025-11' });
  assert.equal(rec.status, 200);
  h.time += 5 * MIN; await h.service.tick();
  h.time += 5 * MIN; await h.service.tick();
  assert.equal(newsMails(h.mails).length, 0, 'con el interruptor apagado no sale ni un aviso de novedades');
  const on = await h.call('POST', '/api/mail/alerts', { enabled: true });
  assert.equal(on.status, 200);
  h.time += 1 * MIN; await h.service.tick();
  assert.equal(newsMails(h.mails).length, 1, 'al encenderlo, el aviso pendiente sale con su detalle');
  assert.ok(newsMails(h.mails)[0].text.includes('folio D-9'));
  h.service.close();
  console.log('OK 1.22.0 D — Ajustes › Correo manda: apagado = cero correos de novedades; encendido = sale el pendiente.');
}

/* ===== E · El tope horario compartido detiene el sexto aviso ===== */
{
  const dir = mkdtempSync(join(tmpdir(), 'pacosat-1220-tope-'));
  mkdirSync(dir, { recursive: true });
  const h = harness(fakeSat(), { watchDir: dir, inboxParser: FixtureParser, watchSettleMs: 0 });
  await setupMail(h);
  for (let i = 1; i <= 6; i++) {
    const uuid = '12200000-004' + i + '-404' + i + '-804' + i + '-00000000014' + i;
    writeFileSync(join(dir, 'lote' + i + '.xml'), xmlCfdi({ uuid, fecha: '2026-11-0' + i + 'T10:00:00',
      emisor: EMISOR, receptor: RFC, total: '100.00', serie: 'E', folio: String(i) }));
    await h.service.inboxTick(h.time);
    h.time += 3 * MIN; await h.service.tick();
  }
  assert.equal(newsMails(h.mails).length, 5,
    'cinco avisos en la hora salen; el sexto lo detiene el tope compartido y va al resumen del día');
  h.service.close();
  rmSync(dir, { recursive: true, force: true });
  console.log('OK 1.22.0 E — tope de 5 correos/hora compartido con los avisos de suceso: el sexto no sale como correo.');
}
