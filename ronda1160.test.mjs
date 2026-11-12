import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createPacoSATService } from './local-server.mjs';

/* Reporte Mano Fil (1.16.0) — propuesta P12 de la auditoría del
   10 nov 2026, montada sobre la capa de salidas de la 1.14.0:
   (1) El resumen responde primero (facturado, entró, salió, qué
       falta) y el detalle va detrás: lo facturado y lo cobrado con
       su folio, los pagos a proveedores del periodo (complemento,
       PUE y marcados a mano, cada uno con su fecha y su vía), lo
       que se debe y a quién, las recibidas, los impuestos (las
       declaraciones PRESENTADAS en el periodo, con fecha y nº de
       operación), la nómina (CFDI tipo N) y el saldo en bancos.
   (2) Solo datos de Mano Fil: el RFC va fijo (MFI6212158B4) y
       pedir el reporte para otro RFC se rechaza; el periodo es un
       mes o un rango de fechas.
   (3) Las canceladas se enseñan marcadas y NO suman en ningún
       total: el SUM del Excel y el total del PDF son el mismo
       número, calculado desde los registros.
   (4) El informe automático: configurado, el día fijado se genera
       el del mes anterior, queda GUARDADO en Expedientes y sale
       por correo con el PDF y el Excel; no se repite.
   Las pruebas JUZGAN EL ARTEFACTO: abren el PDF con pdfjs y leen
   su texto, y abren el .xlsx y leen el XML de sus hojas. */

const CER = 'MIIDUzCCAjugAwIBAgIUH2WzMvVXT5BC2dNEzTaqRKJcZVUwDQYJKoZIhvcNAQELBQAwOTEgMB4GA1UEAwwXRU1QUkVTQSBQUlVFQkEgU0EgREUgQ1YxFTATBgNVBAUTDE1GSTYyMTIxNThCNDAeFw0yNjExMDkwNTA0MzVaFw0zNjExMDYwNTA0MzVaMDkxIDAeBgNVBAMMF0VNUFJFU0EgUFJVRUJBIFNBIERFIENWMRUwEwYDVQQFEwxNRkk2MjEyMTU4QjQwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQDJv/UPUgh/H1XwYFWUj2DV8HVVL95Z3LSi7P5yC1m2hcXlGVyvrc9EwIxTYuKVndt3mZyafViTg7Zng3wPs/bkZIhWcXTBkFPy8/4OZF4HKhgQTByszYEqBo4hr6o98FqS638cXcIkAzKFaIhpIJUpFMmUyKlSLgdWRcW7gm4SF2TaWYWi5CBok6gSoWsbmvEdFa0BbSCTxUUOxxWeoqhaMeYgN+PYpLWkl8Iq7VZJ+JeH0LMvbKg6Bhug0KOnC3/yNSBDIrg+A1rOysN8JJOU76zPuqj6aki7+oAEZIpGcu6h3cri7S8qq3zYupFdmZHwRySGDRci3ZpyCqjlFB97AgMBAAGjUzBRMB0GA1UdDgQWBBQYRYXN6Lv4Ke+TNpNWj7H1tqkEpTAfBgNVHSMEGDAWgBQYRYXN6Lv4Ke+TNpNWj7H1tqkEpTAPBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUAA4IBAQC8EwF8xC42pm/jFhTaO/gp2LDiSfz5cIJyZe9XsbczupYA9moD0Y9qMdEFAqgSVmFqJNgE675d5meRJdvRariROlpN3BZfcvPDEqHnwjqzjgHBt9e+GYb8UzdvkWiJuN7hoWgs2m+AJdPnsIWopKVI8enqng9Un7LbzCkACmJuG03Y+N7uuT/jIE+hNBHLJI6S9CGGs3hr8S4eZ2ijQeYyrWtLoeadLFsp4QqDb/JqXGtrIWFH9p3TNDEvyyVsYUBXSBIxX9zf/EYQ9NMLqIVSJ5hR/GjmDPf0plFteYQZEhRohrXnAox6clkDaIqTJkzWHhY4PHCPn+sJAh+Jzz8Y';
const KEY = 'MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDJv/UPUgh/H1XwYFWUj2DV8HVVL95Z3LSi7P5yC1m2hcXlGVyvrc9EwIxTYuKVndt3mZyafViTg7Zng3wPs/bkZIhWcXTBkFPy8/4OZF4HKhgQTByszYEqBo4hr6o98FqS638cXcIkAzKFaIhpIJUpFMmUyKlSLgdWRcW7gm4SF2TaWYWi5CBok6gSoWsbmvEdFa0BbSCTxUUOxxWeoqhaMeYgN+PYpLWkl8Iq7VZJ+JeH0LMvbKg6Bhug0KOnC3/yNSBDIrg+A1rOysN8JJOU76zPuqj6aki7+oAEZIpGcu6h3cri7S8qq3zYupFdmZHwRySGDRci3ZpyCqjlFB97AgMBAAECggEADYRMYA86yCrqdZU8C/ItO+LajES4QiSyKjD0Uoy7ISpGRMqrCzl7Elv6Kti3CJd6bZa/nMQldpX+VwzCokSy7RYP4lwYmqKs/9vkBhp9suou5uH1O931jOzCggmZv4DxIzh0RuDAkewa6urtf2mc72iCoZ1uEWD0bI3L09EccclmqMihSGfwiihOwAWo2/1qM3ZOKraGe/AT2eUrGwfKqJKWIAzp6ec6cWHt+YtmQY+JtcpQcNVjPewosVD3xRV60knDaFKwCZeRmYQ9jZhFAoOA57nkRshPhejKV8iNvA1tdWWrqpRL/UjtpIs3y2jBfFtGNFL0oZMpWKhQSRFCzQKBgQDqRQ8hFqINPgwKorrZ676TkPPhQ2Ag2anCq0YCK84qPfRArhnwEVYbrzw9TEyF0RRn6DE22S+QzbGgjTDTcSbuBEY2jKlwgXZjGRa/NEN+rl+JWBtw02vk1l5EDBPCjXdxP7r7opL57yUU7UamnW/MBMhxG9tdSI6u6yEpi0vTBwKBgQDcdq8Wn5oRQYKYuXcZIbxEnsTuP0TQFev8Kplb91wB8SPxQt6glKmQQRJdztXX1JrOJoQUUy2Rlt43LxXh1aOWOm6TdTAeI+gOKUn/c4KYVq3yKw1sD61SNV7Oh8lZrb1laVavou0KbuKi4C3ifkmI/IYVFiaD0sKoGZ98GjWu7QKBgQDG3A5GqR6wHP49vPrdZzbjroTGr9mWqQ1oWNjZmPOted+vU9pipWSxpWN+KRk/8kXfGgNEqsGsql5gidlrcr54BprPTUG7ZbnnzvE3JxcwHrasMGVCtcT9gFaObq4LVOiR8mY3mj4m+LBCflOdtUCkL18yXFIuchvkMWV6DWs02wKBgEyOkkKC7ddsLlOmo+sAQgZ6M9yf799qnWYVzOeYwESUXmzbUb/ln/ROBHi66JtoYtGPonIEaGCUSVpUaX7g10vFwrxGB42P3nd8cwvYKtOH1iOwO5r43rEbg26ozIztvkVHDSk0pKfo1Z7FxmlOfW6qck1EQd+pApupOi64U0gJAoGBAJrkBt1d6wppq6p+RvwvIEm63/DuF80Cx/kG7YMEfJ3GQUQYmOxgIRniLZEitYSV2w3prwb/oBBu8TBsmM0nzFj/0SylLBWylVOKTtg8fxl7nEaJLJhjCyJAHtSgwtFnwLLNb2kBj2tR0BR2cT9H4wzwI0yNk0I7iEc6qsZ6FzGy';
const PWD = 'secreto-de-prueba';

const origin = 'http://127.0.0.1:43741';
let time = Date.parse('2026-11-25T18:00:00Z');
const MFI = 'MFI6212158B4';
const CHED = 'SUC580621DAA', BRIS = 'IPC2502209B0', GARC = 'GRC131111298', ACER = 'AIC150804PQ2', GEN = 'GEN010101GE1';
const EMP1 = 'AAAA900101AA1', EMP2 = 'BBBB900202BB2';
const UE1 = '11111111-1111-4111-8111-111111111101';
const UE2 = '22222222-2222-4222-8222-222222222202';
const UREPM = '55555555-5555-4555-8555-555555555505';
const U963 = '18453D78-72CC-4AF5-92D8-D66F998F241F';
const UREP = '66666666-6666-4666-8666-666666666601';
const U5166 = '22222222-2222-4222-8222-222222222201';
const U959 = '8485826D-FA6A-44F8-B716-121DFCADF631';
const UACE = '44444444-4444-4444-8444-444444444401';
const UN1 = '77777777-7777-4777-8777-777777777701';
const UN2 = '77777777-7777-4777-8777-777777777702';

const mails = [];
function harness(service) {
  let token;
  const call = async (path, data) => {
    const headers = { host: new URL(origin).host, origin, 'x-pacosat-token': token, 'x-pacosat-proxy': 'proxy-salidas' };
    const req = Object.assign(Readable.from(data === undefined ? [] : [Buffer.from(JSON.stringify(data))]), {
      url: path, method: data === undefined ? 'GET' : 'POST', headers });
    let response;
    const res = { setHeader() {}, writeHead(status) { this.status = status; this.headersSent = true; },
      end(content) { response = new Response(content, { status: this.status }); } };
    await service.handle(req, res);
    return response;
  };
  return { call, async login() {
    const page = await (await call('/')).text();
    token = page.match(/meta name="pacosat-token" content="([^"]+)"/)?.[1];
    assert.ok(token, 'token del servicio de juguete');
  } };
}
const makeService = dbFile => createPacoSATService({ dbFile, html: '<!--PACOSAT_TOKEN-->', origin,
  proxyKey: 'proxy-salidas', now: () => time,
  makeConnector: async () => ({ connector: {
    request: async () => 'req-juguete',
    check: async () => ({ status: 'pending', packages: [] }),
    download: async () => { throw new Error('sin paquetes de juguete'); } } }),
  makeMailer: () => ({ verify: async () => true,
    sendMail: async mail => { mails.push(mail); return { messageId: 'm' + mails.length }; } }) });

const fiscal = (folio, subtotal, iva, method = 'PPD', series = '') => ({ series, folio, subTotal: subtotal,
  paymentMethod: method, paymentForm: '99', transferred: iva ? [{ tax: '002', base: subtotal, amount: iva }] : [] });
const invoices = [
  { id: UE1, date: '2026-11-01', kind: 'I', currency: 'MXN',
    from: { rfc: MFI, name: 'MANO FIL SA DE CV' }, to: { rfc: CHED, name: 'COMERCIALIZADORA CHEDRAUI SA' },
    total: '296154.41', fiscal: fiscal('1101', '255305.52', '40848.88', 'PUE', 'R') },
  { id: UE2, date: '2026-11-05', kind: 'I', currency: 'MXN',
    from: { rfc: MFI, name: 'MANO FIL SA DE CV' }, to: { rfc: GEN, name: 'CLIENTE GENERICO SA' },
    total: '11600.00', fiscal: fiscal('88', '10000.00', '1600.00') },
  { id: UREPM, date: '2026-11-12', kind: 'P', currency: 'MXN',
    from: { rfc: MFI, name: 'MANO FIL SA DE CV' }, to: { rfc: GEN, name: 'CLIENTE GENERICO SA' },
    total: '0.00', fiscal: { series: '', folio: '3', payments: { totalPagos: '5800.00',
      pagos: [{ fechaPago: '2026-11-12T10:00:00', monto: '5800.00', documentos: [
        { idDocumento: UE2, serie: '', folio: '88', numParcialidad: 1, impSaldoAnt: 11600, impPagado: 5800, impSaldoInsoluto: 5800 }] }] } } },
  { id: U963, date: '2026-11-06', kind: 'I', currency: 'MXN',
    from: { rfc: BRIS, name: 'INMOBILIARIA PROYECTOS Y CONSTRUCCIONES BRISBANE SA' }, to: { rfc: MFI, name: 'MANO FIL SA DE CV' },
    total: '12760.00', fiscal: fiscal('963', '11000.00', '1760.00') },
  { id: UREP, date: '2026-11-20', kind: 'P', currency: 'MXN',
    from: { rfc: BRIS, name: 'INMOBILIARIA PROYECTOS Y CONSTRUCCIONES BRISBANE SA' }, to: { rfc: MFI, name: 'MANO FIL SA DE CV' },
    total: '0.00', fiscal: { series: 'REP', folio: '7', payments: { totalPagos: '5000.00',
      pagos: [{ fechaPago: '2026-11-20T12:00:00', monto: '5000.00', documentos: [
        { idDocumento: U963, serie: '', folio: '963', numParcialidad: 1, impSaldoAnt: 12760, impPagado: 5000, impSaldoInsoluto: 7760 }] }] } } },
  { id: U5166, date: '2026-11-04', kind: 'I', currency: 'MXN',
    from: { rfc: GARC, name: 'GARCIA RIVERA CONSTRUCCIONES SA' }, to: { rfc: MFI, name: 'MANO FIL SA DE CV' },
    total: '80040.00', fiscal: fiscal('5166', '69000.00', '11040.00') },
  { id: U959, date: '2026-11-06', kind: 'I', currency: 'MXN', state: 'Cancelado',
    from: { rfc: BRIS, name: 'INMOBILIARIA PROYECTOS Y CONSTRUCCIONES BRISBANE SA' }, to: { rfc: MFI, name: 'MANO FIL SA DE CV' },
    total: '33779.20', fiscal: fiscal('959', '29137.24', '4641.96') },
  { id: UACE, date: '2026-10-15', kind: 'I', currency: 'MXN',
    from: { rfc: ACER, name: 'ACEROS INGENIERIA Y CONSTRUCCION RT SA' }, to: { rfc: MFI, name: 'MANO FIL SA DE CV' },
    total: '33640.00', fiscal: fiscal('13564', '29000.00', '4640.00', 'PUE') },
  { id: UN1, date: '2026-11-15', kind: 'N', currency: 'MXN',
    from: { rfc: MFI, name: 'MANO FIL SA DE CV' }, to: { rfc: EMP1, name: 'EMPLEADO UNO DE JUGUETE' },
    total: '8000.00', fiscal: fiscal('45', '8000.00', '') },
  { id: UN2, date: '2026-11-15', kind: 'N', currency: 'MXN',
    from: { rfc: MFI, name: 'MANO FIL SA DE CV' }, to: { rfc: EMP2, name: 'EMPLEADO DOS DE JUGUETE' },
    total: '8000.00', fiscal: fiscal('46', '8000.00', '') }
];
const people = [{ id: MFI, name: 'MANO FIL SA DE CV' }, { id: CHED, name: 'COMERCIALIZADORA CHEDRAUI SA' },
  { id: BRIS, name: 'INMOBILIARIA PROYECTOS Y CONSTRUCCIONES BRISBANE SA' }, { id: GARC, name: 'GARCIA RIVERA CONSTRUCCIONES SA' },
  { id: ACER, name: 'ACEROS INGENIERIA Y CONSTRUCCION RT SA' }, { id: GEN, name: 'CLIENTE GENERICO SA' }];

/* ===== Semilla: servicio con base en disco (dos aperturas) ===== */
const dir = mkdtempSync(join(tmpdir(), 'pacosat-manofil-'));
const dbFile = join(dir, 'pacosat.sqlite');
{
  const service = makeService(dbFile);
  const { call, login } = harness(service);
  await login();
  assert.equal((await call('/api/mail', { host: 'smtp.test', port: 465, security: 'ssl',
    from: 'avisos@pacosat.test', recipient: 'paco@test.mx', user: 'u', password: 'p' })).status, 200);
  assert.equal((await call('/api/unlock', { rfc: MFI, minutes: 1440, days: 30, direction: 'both',
    certificate: CER, key: KEY, password: PWD })).status, 200);
  assert.equal((await call('/api/storage', { batch: { people, invoices } })).status, 200);
  const config = await (await call('/api/reports/config',
    { manofil: { enabled: true, day: 5, hour: 9, recipients: 'rodrigo@juguete.mx, jose@juguete.mx' } })).json();
  assert.equal(config.manofil?.enabled, true, 'la configuración guarda el informe de Mano Fil');
  assert.equal(config.manofil?.recipients, 'rodrigo@juguete.mx, jose@juguete.mx');
  /* La descarga automática mensual se apaga en este escenario (es
     la práctica de aislamiento de la 1.15.0): esta suite juzga el
     Reporte Mano Fil, no la corrida mensual. */
  assert.equal((await call('/api/monthly/config', { enabled: false, day: 5, hour: 9 })).status, 200);
  service.close();
}
{
  const db = new DatabaseSync(dbFile);
  const watch = db.prepare('INSERT INTO cfdi_watch(id, emitter, receiver, total, seal, next, checked, result) VALUES (?,?,?,?,?,?,?,?)');
  const estado = state => JSON.stringify({ state, code: 'S', cancellation: '', cancelable: '', error: '' });
  watch.run(UE1, MFI, CHED, '296154.41', '', time + 86400000, time, estado('Vigente'));
  watch.run(UE2, MFI, GEN, '11600.00', '', time + 86400000, time, estado('Vigente'));
  watch.run(U963, BRIS, MFI, '12760.00', '', time + 86400000, time, estado('Vigente'));
  watch.run(U5166, GARC, MFI, '80040.00', '', time + 86400000, time, estado('Vigente'));
  watch.run(U959, BRIS, MFI, '33779.20', '', time + 86400000, time, estado('Cancelado'));
  const decl = db.prepare("INSERT INTO declaraciones(id, rfc, tipo, clase, ejercicio, periodo, fechaPresentacion, operacion, fileId, source, created) VALUES (?,?,?,?,?,?,?,?,?,?,?)");
  decl.run('decl-1', MFI, 'mensual', 'declaracion', 2026, '2026-10', '2026-11-17', '12345678901234567890', 'decl-file-1', 'prueba', time);
  decl.run('decl-2', MFI, 'mensual', 'acuse', 2026, '2026-10', '2026-11-17', '12345678901234567890', 'decl-file-2', 'prueba', time);
  db.prepare('INSERT INTO bank_accounts(id,bank,name,last4,kind,created) VALUES (?,?,?,?,?,?)')
    .run('cta-1', 'BBVA', 'Cuenta operativa', '2590', '', time);
  db.prepare('INSERT INTO bank_statements(id,accountId,month,fileId,openingCents,closingCents,creditsCents,chargesCents,movements,state,detected,created) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    .run('edo-1', 'cta-1', '2026-11', '', 12000000, 15000000, 3000000, 0, 0, '', '', time);
  db.prepare('INSERT INTO manual_payments(uuid,at,nota,importe) VALUES (?,?,?,?)')
    .run(U5166, Date.parse('2026-11-18T18:00:00Z'), 'Pago de juguete a García', '20000.00');
  db.close();
}

const service = makeService(dbFile);
const { call, login } = harness(service);
await login();
/* El transporte de correo se activa por instancia (la persistencia
   entre reinicios vive en el archivo de arranque del despliegue):
   se reconfigura en esta apertura, como en la suite de la 1.15.0. */
assert.equal((await call('/api/mail', { host: 'smtp.test', port: 465, security: 'ssl',
  from: 'avisos@pacosat.test', recipient: 'paco@test.mx', user: 'u', password: 'p' })).status, 200);
const pedir = async payload => {
  const res = await call('/api/salidas/reporte-manofil', payload);
  assert.equal(res.status, 200, 'reporte-manofil responde 200');
  const data = await res.json();
  return { name: data.name, type: data.type, buffer: Buffer.from(data.content, 'base64') };
};
const pdfText = async buffer => {
  const doc = await getDocument({ data: new Uint8Array(buffer) }).promise;
  let text = '';
  for (let i = 1; i <= doc.numPages; i++)
    text += (await (await doc.getPage(i)).getTextContent()).items.map(item => item.str).join(' ') + '\n';
  return { pages: doc.numPages, text };
};
const zipRaw = buffer => {
  const entries = new Map();
  let eocd = buffer.length - 22;
  while (eocd >= 0 && buffer.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  assert.ok(eocd >= 0, 'directorio central del ZIP');
  const count = buffer.readUInt16LE(eocd + 10);
  let p = buffer.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    assert.equal(buffer.readUInt32LE(p), 0x02014b50);
    const size = buffer.readUInt32LE(p + 20);
    const nameLen = buffer.readUInt16LE(p + 28);
    const extraLen = buffer.readUInt16LE(p + 30);
    const commentLen = buffer.readUInt16LE(p + 32);
    const localAt = buffer.readUInt32LE(p + 42);
    const name = buffer.toString('utf8', p + 46, p + 46 + nameLen);
    const localNameLen = buffer.readUInt16LE(localAt + 26);
    const localExtraLen = buffer.readUInt16LE(localAt + 28);
    const start = localAt + 30 + localNameLen + localExtraLen;
    entries.set(name, buffer.subarray(start, start + size));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
};
const sheetXml = (buffer, name) => {
  const entries = zipRaw(buffer);
  const workbook = entries.get('xl/workbook.xml').toString('utf8');
  const index = [...workbook.matchAll(/<sheet name="([^"]+)"/g)].findIndex(m => m[1] === name);
  assert.ok(index >= 0, 'hoja ' + name);
  return entries.get(`xl/worksheets/sheet${index + 1}.xml`).toString('utf8');
};

/* ===== El PDF del mes: resumen que responde y detalle con folio ===== */
{
  const pdf = await pedir({ format: 'pdf', month: '2026-11' });
  assert.equal(pdf.name, 'reporte-manofil-2026-11.pdf');
  const { text } = await pdfText(pdf.buffer);
  assert.ok(text.includes('Reporte Mano Fil · Noviembre de 2026'), 'título con el periodo en palabras');
  assert.ok(text.includes('Para Rodrigo y José Javier'), 'el informe nombra a sus lectores');
  /* El resumen, contra los registros: facturado 296,154.41 + 11,600;
     entró: el PUE de Chedraui + el complemento del cliente;
     salió: el complemento a Brisbane + el pago marcado a García;
     falta: 5,800 por cobrar y 7,760 + 60,040 por pagar. */
  for (const esperado of ['$307,754.41', '$301,954.41', '$25,000.00', '$16,000.00',
      '$5,800.00', '$67,800.00', '$150,000.00'])
    assert.ok(text.includes(esperado), 'el resumen trae ' + esperado);
  assert.ok(text.includes('CHEDRAUI'), 'la renta de Chedraui consta');
  assert.ok(text.includes('R-1101'), 'el folio de la renta, con su serie');
  assert.ok(text.includes('Pagos a proveedores en el periodo'), 'sección de pagos');
  assert.ok(text.includes('Complemento de pago') && text.includes('Marcado a mano'), 'cada pago trae su vía');
  assert.ok(text.includes('963') && text.includes('5166'), 'los pagos traen el folio de su factura');
  assert.ok(text.includes('Qué se debe y a quién'), 'sección de por pagar');
  assert.ok(text.includes('Impuestos del periodo'), 'sección de impuestos');
  assert.ok(text.includes('2026-10') && text.includes('12345678901234567890'),
    'la declaración de octubre, presentada en noviembre, trae su nº de operación');
  assert.ok(text.includes('Recuperado'), 'el acuse de la declaración consta recuperado');
  assert.ok(text.includes('Nómina del periodo') && text.includes('EMPLEADO UNO DE JUGUETE'), 'la nómina trae a sus empleados');
  assert.ok(text.includes('Saldo en bancos') && text.includes('BBVA'), 'el saldo en bancos trae la cuenta');
  /* La cancelada: marcada, con su aviso de que no suma. */
  assert.ok(text.includes('959') && text.includes('Cancelado'), 'la 959 se enseña marcada como cancelada');
  assert.ok(text.includes('NO suman en los totales'), 'el aviso de que las canceladas no suman');
  /* Lo de octubre no se mezcla en noviembre. */
  assert.ok(!text.includes('13564'), 'la 13564 es de octubre: no aparece en el reporte de noviembre');
}

/* ===== El Excel del mes: las mismas cifras, como números ===== */
{
  const libro = await pedir({ format: 'xlsx', month: '2026-11' });
  assert.equal(libro.name, 'reporte-manofil-2026-11.xlsx');
  const resumen = sheetXml(libro.buffer, 'Resumen');
  for (const esperado of ['<v>307754.41</v>', '<v>301954.41</v>', '<v>25000.00</v>',
      '<v>16000.00</v>', '<v>5800.00</v>', '<v>67800.00</v>', '<v>150000.00</v>'])
    assert.ok(resumen.includes(esperado), 'la hoja Resumen trae ' + esperado);
  const facturacion = sheetXml(libro.buffer, 'Facturación emitida');
  assert.match(facturacion, /<f>SUM\(/, 'la facturación lleva su SUM');
  assert.ok(facturacion.includes('<v>307754.41</v>'), 'el SUM de emitidas cuadra con el PDF');
  assert.ok(facturacion.includes('R-1101'), 'el folio con serie viaja al Excel');
  const recibidas = sheetXml(libro.buffer, 'Facturas recibidas');
  assert.ok(recibidas.includes('<v>92800.00</v>'), 'recibidas vigentes: 12,760 + 80,040 (la cancelada no suma)');
  assert.ok(!recibidas.includes(U959), 'la cancelada no entra en la hoja de recibidas');
  const pagosHoja = sheetXml(libro.buffer, 'Pagos a proveedores');
  assert.ok(pagosHoja.includes('<v>25000.00</v>'), 'el SUM de pagos cuadra: 5,000 + 20,000');
  assert.ok(pagosHoja.includes('963') && pagosHoja.includes('5166'), 'los pagos llevan el folio de su factura');
  const porPagar = sheetXml(libro.buffer, 'Por pagar');
  assert.ok(porPagar.includes('<v>67800.00</v>'), 'por pagar: 7,760 + 60,040');
  const porCobrar = sheetXml(libro.buffer, 'Por cobrar');
  assert.ok(porCobrar.includes('<v>5800.00</v>'), 'por cobrar: el saldo del cliente genérico');
  const impuestos = sheetXml(libro.buffer, 'Impuestos');
  assert.ok(impuestos.includes('12345678901234567890'), 'la hoja de impuestos trae el nº de operación');
  const nomina = sheetXml(libro.buffer, 'Nómina');
  assert.ok(nomina.includes('<v>16000.00</v>'), 'el SUM de nómina: 8,000 + 8,000');
  const bancos = sheetXml(libro.buffer, 'Bancos');
  assert.ok(bancos.includes('<v>150000.00</v>'), 'la hoja de bancos trae la posición');
}

/* ===== El rango: octubre solo trae lo suyo ===== */
{
  const pdf = await pedir({ format: 'pdf', from: '2026-10-01', to: '2026-10-31' });
  assert.equal(pdf.name, 'reporte-manofil-2026-10-01_a_2026-10-31.pdf');
  const { text } = await pdfText(pdf.buffer);
  assert.ok(text.includes('13564'), 'en octubre sí consta la factura de Aceros');
  assert.ok(text.includes('$33,640.00'), 'y su pago PUE dentro del rango');
  assert.ok(text.includes('Facturado en el periodo: $0.00'), 'lo facturado del rango es solo del rango (noviembre no se mezcla)');
  assert.ok(text.includes('Sin facturas emitidas en el periodo'), 'octubre no tuvo emitidas y se dice');
  /* La 5166 SÍ aparece en este reporte, y bien: vive en «Por pagar»,
     que es la foto de saldos abiertos a la fecha del reporte (como
     el PDF de saldos), no un dato del periodo. */
}

/* ===== Guardas: solo Mano Fil, periodo válido ===== */
{
  const otro = await call('/api/salidas/reporte-manofil', { format: 'pdf', rfc: 'AAA010101AAA', month: '2026-11' });
  assert.equal(otro.status, 422);
  assert.match((await otro.json()).error, /solo lleva datos de Mano Fil/);
  const malMes = await call('/api/salidas/reporte-manofil', { format: 'pdf', month: '2026-13' });
  assert.equal(malMes.status, 422);
  const malRango = await call('/api/salidas/reporte-manofil', { format: 'pdf', from: '2026-11-30', to: '2026-11-01' });
  assert.equal(malRango.status, 422);
  const sinPeriodo = await call('/api/salidas/reporte-manofil', { format: 'pdf' });
  assert.equal(sinPeriodo.status, 422);
}

/* ===== Envío manual inmediato: guarda en Expedientes y manda ===== */
{
  const antes = mails.length;
  const res = await call('/api/reports/send-manofil', { month: '2026-11' });
  assert.equal(res.status, 200, 'el envío manual responde 200');
  const data = await res.json();
  assert.ok(data.recipients.includes('rodrigo@juguete.mx'), 'sale a los destinatarios configurados');
  const envio = mails.slice(antes).find(mail => mail.subject === 'PacoSAT · Reporte Mano Fil 2026-11');
  assert.ok(envio, 'el correo del reporte salió');
  assert.equal(envio.attachments.length, 2, 'viajan el PDF y el Excel');
  assert.ok(envio.attachments[0].content.subarray(0, 4).toString() === '%PDF', 'el primer adjunto es el PDF');
}

/* ===== El automático: el día fijado genera, guarda y manda; no repite ===== */
{
  const antes = mails.filter(mail => mail.subject === 'PacoSAT · Reporte Mano Fil 2026-11').length;
  time = Date.parse('2026-12-05T15:00:00Z');   // 5 dic 2026, 09:00 MX
  await service.tick();
  const despues = mails.filter(mail => mail.subject === 'PacoSAT · Reporte Mano Fil 2026-11').length;
  assert.equal(despues, antes + 1, 'el día 5 salió el reporte de noviembre, una vez');
  await service.tick();
  const otra = mails.filter(mail => mail.subject === 'PacoSAT · Reporte Mano Fil 2026-11').length;
  assert.equal(otra, despues, 'el mismo día no se repite');
  service.close();
  const db = new DatabaseSync(dbFile);
  const docs = db.prepare("SELECT value FROM records WHERE store='documents'").all()
    .map(row => JSON.parse(row.value)).filter(doc => doc.kind === 'Reporte Mano Fil');
  assert.equal(docs.length, 2, 'el envío manual y el automático guardaron su PDF en Expedientes');
  assert.ok(docs.every(doc => doc.rfc === MFI && doc.period === '2026-11'), 'los dos son de Mano Fil, de noviembre');
  const file = db.prepare("SELECT data FROM records WHERE store='files' AND id=?").get(docs[0].id);
  assert.ok(Buffer.from(file.data).subarray(0, 4).toString() === '%PDF', 'lo guardado en Expedientes es el PDF');
  db.close();
}
rmSync(dir, { recursive: true, force: true });
console.log('ronda1160.test.mjs OK');
