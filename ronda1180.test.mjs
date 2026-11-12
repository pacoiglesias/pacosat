import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createPacoSATService } from './local-server.mjs';

/* Ronda Facilidad (1.18.0) — la revisión de facilidad que aprobó
   Paco el 10 nov 2026 (revision.md), juzgada en comportamiento:
   (1) Deshacer universal del servidor: «Ya se pagó» se deshace
       (unmark-paid solo quita el pago manual, nunca un REP), un
       aviso cerrado se REABRE (y su pago manual desaparece), la
       nota de un cierre se puede corregir y todo queda en la
       bitácora del aviso.
   (2) Registro único de actividad: una descarga masiva en pausa
       (held) se ve pausada, se reanuda y se vuelve a pausar por
       el gesto único; lo que no admite pausa lo dice (422 con la
       razón), y el barrido de vigilancia corre en el SERVIDOR
       (check-now lo arranca y la actividad lo cuenta).
   (3) Pagos cierra su ciclo: la preparación se reabre tal cual
       (GET preparation con su TXT), «ya pagué en el banco» marca
       sus facturas y sella la preparación, y la cuenta de retiro
       vive en el servidor (pagos/config).
   (4) Dinero con folio y vencimiento de calendario de
       contraparte en /api/money.
   (5) Los artefactos rehechos se REABREN y se leen: el cierre
       con su resumen en líneas y la cancelada fuera de los
       totales, el comprobante con fechas en palabras y la forma
       de pago por su nombre, la contraparte sin la cancelada en
       su resumen y con la dirección bien dicha, el mapa con
       «X de 12» y su columna entera, el ZIP de cierre con los
       documentos del SAT en su carpeta + índice.xlsx +
       manifiesto con totales por carpeta, y el Excel de
       facturas con su hoja «Resumen» primero. Y cada salida
       queda registrada en /api/salidas/last; generar el paquete
       de cierre a mano marca el paso «Informe a la contadora». */

const CER = 'MIIDUzCCAjugAwIBAgIUH2WzMvVXT5BC2dNEzTaqRKJcZVUwDQYJKoZIhvcNAQELBQAwOTEgMB4GA1UEAwwXRU1QUkVTQSBQUlVFQkEgU0EgREUgQ1YxFTATBgNVBAUTDE1GSTYyMTIxNThCNDAeFw0yNjExMDkwNTA0MzVaFw0zNjExMDYwNTA0MzVaMDkxIDAeBgNVBAMMF0VNUFJFU0EgUFJVRUJBIFNBIERFIENWMRUwEwYDVQQFEwxNRkk2MjEyMTU4QjQwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQDJv/UPUgh/H1XwYFWUj2DV8HVVL95Z3LSi7P5yC1m2hcXlGVyvrc9EwIxTYuKVndt3mZyafViTg7Zng3wPs/bkZIhWcXTBkFPy8/4OZF4HKhgQTByszYEqBo4hr6o98FqS638cXcIkAzKFaIhpIJUpFMmUyKlSLgdWRcW7gm4SF2TaWYWi5CBok6gSoWsbmvEdFa0BbSCTxUUOxxWeoqhaMeYgN+PYpLWkl8Iq7VZJ+JeH0LMvbKg6Bhug0KOnC3/yNSBDIrg+A1rOysN8JJOU76zPuqj6aki7+oAEZIpGcu6h3cri7S8qq3zYupFdmZHwRySGDRci3ZpyCqjlFB97AgMBAAGjUzBRMB0GA1UdDgQWBBQYRYXN6Lv4Ke+TNpNWj7H1tqkEpTAfBgNVHSMEGDAWgBQYRYXN6Lv4Ke+TNpNWj7H1tqkEpTAfBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUAA4IBAQC8EwF8xC42pm/jFhTaO/gp2LDiSfz5cIJyZe9XsbczupYA9moD0Y9qMdEFAqgSVmFqJNgE675d5meRJdvRariROlpN3BZfcvPDEqHnwjqzjgHBt9e+GYb8UzdvkMiJuN7hoWgs2m+AJdPnsIWopKVI8enqng9Un7LbzCkACmJuG03Y+N7uuT/jIE+hNBHLJI6S9CGGs3hr8S4eZ2ijQeYyrWtLoeadLFsp4QqDb/JqXGtrIWFH9p3TNDEvyyVsYUBXSBIxX9zf/EYQ9NMLqIVSJ5hR/GjmDPf0plFteYQZEhRohrXnAox6clkDaIqTJkzWHhY4PHCPn+sJAh+Jzz8Y';
const KEY = 'MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDJv/UPUgh/H1XwYFWUj2DV8HVVL95Z3LSi7P5yC1m2hcXlGVyvrc9EwIxTYuKVndt3mZyafViTg7Zng3wPs/bkZIhWcXTBkFPy8/4OZF4HKhgQTByszYEqBo4hr6o98FqS638cXcIkAzKFaIhpIJUpFMmUyKlSLgdWRcW7gm4SF2TaWYWi5CBok6gSoWsbmvEdFa0BbSCTxUUOxxWeoqhaMeYgN+PYpLWkl8Iq7VZJ+JeH0LMvbKg6Bhug0KOnC3/yNSBDIrg+A1rOysN8JJOU76zPuqj6aki7+oAEZIpGcu6h3cri7S8qq3zYupFdmZHwRySGDRci3ZpyCqjlFB97AgMBAAECggEADYRMYA86yCrqdZU8C/ItO+LajES4QiSyKjD0Uoy7ISyGRMqrCzl7Elv6Kti3CJd6bZa/nMQldpX+VwzCokSy7RYP4lwYmqKs/9vkBhp9suou5uH1O931jOzCggmZv4DxIzh0RuDAkewa6urtf2mc72iCoZ1uEWD0bI3L09EccclmqMihSGfwiihOwAWo2/1qM3ZOKraGe/AT2eUrGwfKqJKWIAzp6ec6cWHt+YtmQY+JtcpQcNVjPewosVD3xRV60knDaFKwCZeRmYQ9jZhFAoOA57nkRshPhejKV8iNvA1tdWWrqpRL/UjtpIs3y2jBfFtGNFL0oZMpWKhQSRFCzQKBgQDqRQ8hFqINPgwKorrZ676TkPPhQ2Ag2anCq0YCK84qPfRArhnwEVYbrzw9TEyF0RRn6DE22S+QzbGgjTDTcSbuBEY2jKlwgXZjGRa/NEN+rl+JWBtw02vk1l5EDBPCjXdxP7r7opL57yUU7UamnW/MBMhxG9tdSI6u6yEpi0vTBwKBgQDcdq8Wn5oRQYKYuXcZIbxEnsTuP0TQFev8Kplb91cB8SPxQt6glKmQQRJdztXX1JrOJoQUUy2Rlt43LxXh1aOWOm6TdTAeI+gOKUn/c4KYVq3yKw1sD61SNV7Oh8lZrb1laVavou0KbuKi4C3ifkmI/IYVFiaD0sKoGZ98GjWu7QKBgQDG3A5GqR6wHP49vPrdZzbjroTGr9mWqQ1oWNjZmPOted+vU9pipWSxpWN+KRk/8kXfGgNEqsGsql5gidlrcr54BprPTUG7ZbnnzvE3JxcwHrasMGVCtcT9gFaObq4LVOiR8mY3mj4m+LBCflOdtUCkL18yXFIuchvkMWV6DWs02wKBgEyOkkKC7ddsLlOmo+sAQgZ6M9yf799qnWYVzOeYwESUXmzbUb/ln/ROBHi66JtoYtGPonIEaGCUSVpUaX7g10vFwrxGB42P3nd8cwvYKtOH1iOwO5r43rEbg26ozIztvkVHDSk0pKfo1Z7FxmlOfW6qck1EQd+pApupOi64U0gJAoGBAJrkBt1d6wppq6p+RvwvIEm63/DuF80Cx/kG7YMEfJ3GQUQYmOxgIRniLZEitYSV2w3prwb/oBBu8TBsmM0nzFj/0SylLBWylVOKTtg8fxl7nEaJLJhjCyJAHtSgwtFnwLLNb2kBj2tR0BR2cT9H4wzwI0yNk0I7iEc6qsZ6FzGy';
const PWD = 'secreto-de-prueba';

const origin = 'http://127.0.0.1:43741';
const time = Date.parse('2026-11-25T18:00:00Z');
const OWN = 'AAA010101AAA';
const BRISBANE = 'BBB010101BBB';
const U963 = '18453D78-72CC-4AF5-92D8-D66F998F241F';
const U5166 = '22222222-2222-4222-8222-222222222201';
const UCHED = '33333333-3333-4333-8333-333333333301';
const U959 = '8485826D-FA6A-44F8-B716-121DFCADF631';
const UREP = '66666666-6666-4666-8666-666666666601';

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
  makeMailer: () => ({ verify: async () => true, sendMail: async () => ({ messageId: 'm-juguete' }) }) });

const xmlIngreso = ({ uuid, fecha, emisor, emisorNombre, receptor, receptorNombre, total, subtotal, iva, folio, serie = '' }) => `<?xml version="1.0" encoding="UTF-8"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" Version="4.0" Serie="${serie}" Folio="${folio}" Fecha="${fecha}" SubTotal="${subtotal}" Moneda="MXN" Total="${total}" TipoDeComprobante="I" MetodoPago="PPD" FormaPago="99" LugarExpedicion="72000">
<cfdi:Emisor Rfc="${emisor}" Nombre="${emisorNombre}" RegimenFiscal="601"/>
<cfdi:Receptor Rfc="${receptor}" Nombre="${receptorNombre}" DomicilioFiscalReceptor="72000" RegimenFiscalReceptor="601" UsoCFDI="G03"/>
<cfdi:Conceptos><cfdi:Concepto ClaveProdServ="01010101" Cantidad="1" ClaveUnidad="H87" Descripcion="Servicio general de administración y operación" ValorUnitario="${subtotal}" Importe="${subtotal}" ObjetoImp="02"><cfdi:Impuestos><cfdi:Traslados><cfdi:Traslado Base="${subtotal}" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="${iva}"/></cfdi:Traslados></cfdi:Impuestos></cfdi:Concepto></cfdi:Conceptos>
<cfdi:Impuestos TotalImpuestosTrasladados="${iva}"><cfdi:Traslados><cfdi:Traslado Base="${subtotal}" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="${iva}"/></cfdi:Traslados></cfdi:Impuestos>
<cfdi:Complemento><tfd:TimbreFiscalDigital xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital" Version="1.1" UUID="${uuid}" FechaTimbrado="${fecha}" RfcProvCertif="SAT970701NN3" SelloCFD="AAAA" NoCertificadoSAT="00001000000500000001" SelloSAT="BBBB"/></cfdi:Complemento>
</cfdi:Comprobante>`;
const xmlRep = `<?xml version="1.0" encoding="UTF-8"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" Version="4.0" Serie="REP" Folio="7" Fecha="2026-11-20T12:00:00" SubTotal="0" Moneda="XXX" Total="0" TipoDeComprobante="P" LugarExpedicion="72000">
<cfdi:Emisor Rfc="${BRISBANE}" Nombre="BRISBANE TEXTIL SA DE CV" RegimenFiscal="601"/>
<cfdi:Receptor Rfc="${OWN}" Nombre="EMPRESA PROPIA SA" DomicilioFiscalReceptor="72000" RegimenFiscalReceptor="601" UsoCFDI="CP01"/>
<cfdi:Conceptos><cfdi:Concepto ClaveProdServ="84111506" Cantidad="1" ClaveUnidad="ACT" Descripcion="Pago" ValorUnitario="0" Importe="0"/></cfdi:Conceptos>
<cfdi:Complemento><pago20:Pagos xmlns:pago20="http://www.sat.gob.mx/Pagos20" Version="2.0"><pago20:Totales TotalTrasladosBaseIVA16="4310.34" TotalTrasladosImpuestoIVA16="689.66" MontoTotalPagos="5000.00"/><pago20:Pago FechaPago="2026-11-20T12:00:00" FormaDePagoP="03" MonedaP="MXN" Monto="5000.00"><pago20:DoctoRelacionado IdDocumento="${U963}" Serie="" Folio="963" MonedaDR="MXN" NumParcialidad="1" ImpSaldoAnt="12760.00" ImpPagado="5000.00" ImpSaldoInsoluto="7760.00" ObjetoImpDR="01"/></pago20:Pago></pago20:Pagos><tfd:TimbreFiscalDigital xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital" Version="1.1" UUID="${UREP}" FechaTimbrado="2026-11-20T12:00:00" RfcProvCertif="SAT970701NN3" SelloCFD="AAAA" NoCertificadoSAT="00001000000500000001" SelloSAT="BBBB"/></cfdi:Complemento>
</cfdi:Comprobante>`;
const fiscal = (folio, subtotal, iva, method = 'PPD') => ({ series: '', folio, subTotal: subtotal,
  paymentMethod: method, paymentForm: '99', transferred: [{ tax: '002', base: subtotal, amount: iva }] });
const row963 = { id: U963, date: '2026-11-02', kind: 'I', currency: 'MXN',
  from: { rfc: BRISBANE, name: 'BRISBANE TEXTIL SA DE CV' }, to: { rfc: OWN, name: 'EMPRESA PROPIA SA' },
  total: '12760.00', fiscal: fiscal('963', '11000.00', '1760.00') };
const row5166 = { id: U5166, date: '2026-11-04', kind: 'I', currency: 'MXN',
  from: { rfc: 'GRC131111298', name: 'GARCIA RIVERA SA' }, to: { rfc: OWN, name: 'EMPRESA PROPIA SA' },
  total: '80040.00', fiscal: fiscal('5166', '69000.00', '11040.00') };
const rowChed = { id: UCHED, date: '2026-11-06', kind: 'I', currency: 'MXN',
  from: { rfc: OWN, name: 'EMPRESA PROPIA SA' }, to: { rfc: 'SUC580621DAA', name: 'COMERCIALIZADORA CHEDRAUI SA' },
  total: '296154.41', fiscal: { ...fiscal('1101', '255305.52', '40848.88', 'PUE'), series: 'R' } };
const row959 = { id: U959, date: '2026-11-06', kind: 'I', currency: 'MXN', state: 'Cancelado',
  from: { rfc: BRISBANE, name: 'BRISBANE TEXTIL SA DE CV' }, to: { rfc: OWN, name: 'EMPRESA PROPIA SA' },
  total: '33779.20', fiscal: fiscal('959', '29137.24', '4641.96') };
const rowRep = { id: UREP, date: '2026-11-20', kind: 'P', currency: 'MXN',
  from: { rfc: BRISBANE, name: 'BRISBANE TEXTIL SA DE CV' }, to: { rfc: OWN, name: 'EMPRESA PROPIA SA' },
  total: '0.00', fiscal: { series: 'REP', folio: '7', payments: { totalPagos: '5000.00',
    pagos: [{ fechaPago: '2026-11-20T12:00:00', monto: '5000.00', documentos: [
      { idDocumento: U963, serie: '', folio: '963', numParcialidad: 1, impSaldoAnt: 12760, impPagado: 5000, impSaldoInsoluto: 7760 }] }] } } };
const xml963 = xmlIngreso({ uuid: U963, fecha: '2026-11-02T09:00:00', emisor: BRISBANE, emisorNombre: 'BRISBANE TEXTIL SA DE CV',
  receptor: OWN, receptorNombre: 'EMPRESA PROPIA SA', subtotal: '11000.00', iva: '1760.00', total: '12760.00', folio: '963' });
const xml5166 = xmlIngreso({ uuid: U5166, fecha: '2026-11-04T10:00:00', emisor: 'GRC131111298', emisorNombre: 'GARCIA RIVERA SA',
  receptor: OWN, receptorNombre: 'EMPRESA PROPIA SA', subtotal: '69000.00', iva: '11040.00', total: '80040.00', folio: '5166' });
const xml959 = xmlIngreso({ uuid: U959, fecha: '2026-11-06T08:00:00', emisor: BRISBANE, emisorNombre: 'BRISBANE TEXTIL SA DE CV',
  receptor: OWN, receptorNombre: 'EMPRESA PROPIA SA', subtotal: '29137.24', iva: '4641.96', total: '33779.20', folio: '959' });
const CSF = Buffer.from('%PDF-1.4 constancia de juguete');
const OPINION = Buffer.from('%PDF-1.4 opinion de juguete');

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

/* ===== Semilla en tres fases, como la 1.14.0 ===== */
const dir = mkdtempSync(join(tmpdir(), 'pacosat-facilidad-'));
const dbFile = join(dir, 'pacosat.sqlite');
let prepId;
let heldJobId;
{
  const service = makeService(dbFile);
  const { call, login } = harness(service);
  await login();
  assert.equal((await call('/api/unlock', { rfc: OWN, minutes: 1440, days: 30, direction: 'both',
    certificate: CER, key: KEY, password: PWD })).status, 200);
  assert.equal((await call('/api/storage', { batch: {
    people: [{ id: OWN, name: 'EMPRESA PROPIA SA' }, { id: BRISBANE, name: 'BRISBANE TEXTIL SA DE CV' }],
    invoices: [row963, row5166, rowChed, row959, rowRep],
    files: [
      { id: 'xml:' + U963, mime: 'application/xml', content: Buffer.from(xml963).toString('base64') },
      { id: 'xml:' + U5166, mime: 'application/xml', content: Buffer.from(xml5166).toString('base64') },
      { id: 'xml:' + U959, mime: 'application/xml', content: Buffer.from(xml959).toString('base64') },
      { id: 'xml:' + UREP, mime: 'application/pdf', content: Buffer.from(xmlRep).toString('base64') },
      { id: 'doc-csf', mime: 'application/pdf', content: CSF.toString('base64') },
      { id: 'doc-32d', mime: 'application/pdf', content: OPINION.toString('base64') }]
  } })).status, 200);
  const prep = await call('/api/pagos/prepare', { rfc: OWN, month: '2026-11',
    group: { descripcion: 'PROVEEDORES NOVIEMBRE', cuentaRetiro: '0444392590' },
    lines: [
      { nombre: 'BRISBANE TEXTIL SA DE CV', rfc: BRISBANE, banco: 'BBVA', grupo: 'BBVA',
        cuenta: '0123456789', motivo: 'SERVICIO GENERAL NOVIEMBRE', folio: '963', total: '7760.00', base: '', iva: '', uuid: U963 },
      { nombre: 'GARCIA RIVERA SA', rfc: 'GRC131111298', banco: 'BBVA', grupo: 'BBVA',
        cuenta: '0123456788', motivo: 'SERVICIO GENERAL NOVIEMBRE', folio: '5166', total: '80040.00', base: '', iva: '', uuid: U5166 }] });
  assert.equal(prep.status, 200, 'preparación de pagos de juguete');
  prepId = (await prep.json()).id;
  assert.ok(prepId, 'la preparación guardada trae id');
  service.close();
}
{
  const db = new DatabaseSync(dbFile);
  const watch = db.prepare('INSERT INTO cfdi_watch(id, emitter, receiver, total, seal, next, checked, result) VALUES (?,?,?,?,?,?,?,?)');
  const estado = state => JSON.stringify({ state, code: 'S', cancellation: '', cancelable: '', error: '' });
  /* La 963 queda VENCIDA de revisión (next=0): el barrido del
     servidor la recoge sin que ninguna pestaña la empuje. */
  watch.run(U963, BRISBANE, OWN, '12760.00', '', 0, time - 86400000, estado('Vigente'));
  watch.run(U5166, 'GRC131111298', OWN, '80040.00', '', time + 86400000, time, estado('Vigente'));
  watch.run(UCHED, OWN, 'SUC580621DAA', '296154.41', '', time + 86400000, time, estado('Vigente'));
  watch.run(U959, BRISBANE, OWN, '33779.20', '', time + 86400000, time, estado('Cancelado'));
  const decl = db.prepare("INSERT INTO declaraciones(id, rfc, tipo, clase, ejercicio, periodo, fechaPresentacion, operacion, fileId, source, created) VALUES (?,?,?,?,?,?,?,?,?,?,?)");
  decl.run('decl-1', OWN, 'mensual', 'declaracion', 2026, '2026-10', '2026-11-17', '12345678901234567890', 'decl-file-1', 'prueba', time);
  decl.run('decl-2', OWN, 'mensual', 'acuse', 2026, '2026-10', '2026-11-17', '12345678901234567890', 'decl-file-2', 'prueba', time);
  const doc = db.prepare('INSERT INTO sat_documents(id, rfc, kind, issuedAt, fileId, source, created) VALUES (?,?,?,?,?,?,?)');
  doc.run('sd-1', OWN, 'constancia', time - 86400000, 'doc-csf', 'prueba', time);
  doc.run('sd-2', OWN, 'opinion', time - 86400000, 'doc-32d', 'prueba', time);
  /* Brisbane paga los días 10: el vencimiento de su factura del
     2 de noviembre es el 10, no «fecha + 30». */
  db.prepare('INSERT INTO counterparts(rfc, name, kind, note, source, updated, payDay, payTerms) VALUES (?,?,?,?,?,?,?,?)')
    .run(BRISBANE, 'BRISBANE TEXTIL SA DE CV', 'proveedor', '', 'prueba', time, 10, null);
  /* Una descarga masiva en PAUSA (held): existe, no corre y el
     registro de actividad debe enseñarla como pausada. */
  const heldInfo = db.prepare("INSERT INTO jobs(rfc, direction, kind, periodStart, periodEnd, startAt, endAt, requestId, status, due, created, held) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(OWN, 'received', 'cfdi', '2026-01-01', '2026-01-31', '2026-01-01', '2026-01-31', '', 'pending', 0, time, 1);
  heldJobId = Number(heldInfo.lastInsertRowid);
  db.close();
}

const service = makeService(dbFile);
const { call, login } = harness(service);
await login();
const pedir = async (ruta, payload) => {
  const res = await call('/api/salidas/' + ruta, payload);
  assert.equal(res.status, 200, ruta + ' responde 200');
  const data = await res.json();
  return { name: data.name, type: data.type, buffer: Buffer.from(data.content, 'base64') };
};
const money = async () => (await (await call('/api/money')).json()).balances;
const saldoDe = async uuid => (await money()).find(item => item.id === uuid);

/* ===== (4) Dinero: folio y vencimiento por calendario ===== */
{
  const b963 = await saldoDe(U963);
  assert.equal(b963.folio, '963', 'el saldo se identifica por su folio, no por el UUID');
  assert.equal(b963.due, '2026-11-10', 'Brisbane paga los días 10: la del 2 de noviembre vence el 10');
  assert.equal(b963.cpRfc, BRISBANE, 'el saldo trae su contraparte');
  assert.equal(b963.paid, '5000.00', 'lo pagado viene del REP');
  assert.equal(b963.balance, '7760.00', 'el saldo es total menos REP');
  const b5166 = await saldoDe(U5166);
  assert.equal(b5166.folio, '5166');
  assert.equal(b5166.due, '2026-12-04', 'sin calendario de contraparte: fecha + 30 días');
}

/* ===== (5) Artefactos rehechos, reabiertos y leídos ===== */
{
  const cierre = await pedir('pdf', { kind: 'cierre', rfc: OWN, month: '2026-11' });
  const cierreText = (await pdfText(cierre.buffer)).text;
  assert.ok(cierreText.includes('Resumen del mes'), 'el cierre abre con su resumen');
  assert.ok(cierreText.includes('Emitiste $296,154.41 y cobraste $296,154.41: cobrado todo.'),
    'el resumen responde lo emitido en una línea');
  assert.ok(cierreText.includes('Recibiste $92,800.00 y debes $87,800.00.'),
    'el resumen responde lo recibido sin la cancelada (92,800, no 126,579.20)');
  assert.ok(cierreText.includes('cancelada(s) en el mes') && cierreText.includes('fuera de los totales'),
    'la cancelada se nombra y queda fuera de los totales');
  assert.ok(cierreText.includes('Total (sin canceladas)'), 'la tabla de totales avisa de la exclusión');
  assert.ok(cierreText.includes('se revisan solos'), '«sin revisar» lleva su coletilla tranquilizadora');

  const comp = await pedir('cfdi', { id: U963, format: 'pdf', rfc: OWN });
  const compText = (await pdfText(comp.buffer)).text;
  assert.ok(compText.includes('2 de noviembre de 2026'), 'la fecha de emisión va en palabras');
  assert.ok(compText.includes('Por definir (99)'), 'la forma de pago va por su nombre, con el código detrás');
  assert.ok(compText.includes('diferido (PPD)'), 'el método va por su nombre');
  assert.ok(!compText.includes('99 · PPD'), 'fuera el código crudo como texto principal');
  const rep = await pedir('cfdi', { id: UREP, format: 'pdf', rfc: OWN });
  const repText = (await pdfText(rep.buffer)).text;
  assert.ok(repText.includes('no suma un total propio'), 'el REP explica que su «Total $0» no es deuda');

  const cp = await pedir('pdf', { kind: 'contraparte', rfc: OWN, contraparte: BRISBANE });
  const cpText = (await pdfText(cp.buffer)).text;
  assert.ok(cpText.includes('Sin contar 1 cancelada'), 'el resumen de la contraparte excluye la cancelada avisando');
  assert.ok(cpText.includes('le debes $7,760.00 a esta contraparte (por pagar)'),
    'la dirección se dice bien: le debes a la contraparte');
  assert.ok(!cpText.includes('M.N..'), 'fuera la errata del punto doble');

  const mapa = await pedir('pdf', { kind: 'declaraciones', rfc: OWN, year: '2026' });
  const mapaText = (await pdfText(mapa.buffer)).text;
  assert.ok(mapaText.includes('1 de 12 meses presentados'), 'el mapa cuenta «X de 12»');
  assert.ok(mapaText.includes('Presentada el'), 'la cabecera de la fecha va entera, sin truncar');

  const facturas = await pedir('xlsx', { kind: 'facturas', rfc: OWN, month: '2026-11' });
  assert.ok(facturas.name.startsWith('Facturas noviembre de 2026'), 'el Excel baja con nombre humano: ' + facturas.name);
  const sheets = zipRaw(facturas.buffer).get('xl/workbook.xml').toString('utf8');
  assert.ok(sheets.indexOf('Resumen') > -1 && sheets.indexOf('Resumen') < sheets.indexOf('Emitidas'),
    'la primera hoja del Excel de facturas es el Resumen');

  const saldos = await pedir('pdf', { kind: 'saldos', rfc: OWN });
  assert.ok(saldos.buffer.length > 0, 'el PDF de saldos se genera (para el registro de salidas)');

  const zipCierre = await pedir('zip', { scope: 'cierre', rfc: OWN, month: '2026-11' });
  const entries = zipRaw(zipCierre.buffer);
  assert.ok(entries.has('Documentos del SAT/' + OWN + '-csf.pdf'), 'la constancia va en su carpeta, no suelta en la raíz');
  assert.ok(entries.has('Documentos del SAT/' + OWN + '-32d.pdf'), 'la opinión va en su carpeta');
  assert.ok([...entries.keys()].some(name => name.endsWith('indice.xlsx')), 'el paquete de cierre trae su índice en Excel');
  const manifiesto = entries.get('manifiesto.txt').toString('utf8');
  assert.ok(manifiesto.includes('emitidos: 1 por $296,154.41'), 'el manifiesto da el total de emitidos');
  assert.ok(manifiesto.includes('recibidos: 3 por $92,800.00'), 'el manifiesto da el total de recibidos sin la cancelada');
  assert.ok(manifiesto.includes('Total vigente: $388,954.41'), 'el manifiesto cierra con el total vigente');

  const last = (await (await call('/api/salidas/last')).json()).last;
  for (const clave of ['pdf:cierre', 'pdf:saldos', 'pdf:contraparte', 'pdf:declaraciones', 'xlsx:facturas', 'zip:cierre'])
    assert.ok(Number.isFinite(last[clave]), 'la salida ' + clave + ' quedó registrada con su fecha');
  const checklist = await (await call('/api/reports/checklist?month=2026-11')).json();
  const informe = (checklist.items || []).find(item => item.id === 'informe');
  assert.ok(informe && informe.level === 'ok', 'generar el paquete a mano marca «Informe a la contadora»');
}

/* ===== (3) Pagos: la preparación se reabre y cierra su ciclo ===== */
{
  const cfg0 = await (await call('/api/pagos/config?rfc=' + OWN)).json();
  assert.equal(cfg0.cuentaRetiro, '', 'sin cuenta de retiro al principio');
  assert.equal((await call('/api/pagos/config', { rfc: OWN, cuentaRetiro: '0444392590' })).status, 200);
  const cfg1 = await (await call('/api/pagos/config?rfc=' + OWN)).json();
  assert.equal(cfg1.cuentaRetiro, '0444392590', 'la cuenta de retiro vive en el servidor');

  const lista = (await (await call('/api/pagos/preparations?rfc=' + OWN)).json()).preparations;
  assert.equal(lista.length, 1, 'el historial enseña la preparación guardada');
  assert.equal(lista[0].id, prepId);
  assert.equal(lista[0].operaciones, 2, 'la preparación trae sus dos operaciones');
  assert.ok(!lista[0].pagadaEn, 'aún no consta pagada');
  const detalle = await (await call('/api/pagos/preparation?rfc=' + OWN + '&id=' + prepId)).json();
  assert.equal(detalle.preparation.bbva.lines.length, 2, 'al reabrir, las líneas vuelven tal cual');
  assert.deepEqual(detalle.preparation.bbva.lines.map(linea => linea.folio).sort(), ['5166', '963'],
    'las líneas reabiertas conservan su folio');
  assert.ok(detalle.txt.includes('PROVEEDORES NOVIEMBRE') && detalle.txt.includes('0123456789') &&
    detalle.txt.includes('80040.00'),
    'el TXT regenerado es la guía campo a campo del grupo (descripción, cuentas e importes)');

  const pagada = await (await call('/api/pagos/preparations/paid', { rfc: OWN, id: prepId })).json();
  assert.equal(pagada.marcadas, 2, '«ya pagué en el banco» marca las dos facturas');
  assert.equal((await saldoDe(U963)).balance, '0.00', 'la 963 queda saldada');
  assert.equal((await saldoDe(U5166)).balance, '0.00', 'la 5166 queda saldada');
  const otra = await call('/api/pagos/preparations/paid', { rfc: OWN, id: prepId });
  assert.equal(otra.status, 422, 'repetir el gesto no duplica pagos: la preparación ya está sellada');
  assert.match((await otra.json()).error, /ya quedó marcada como pagada/, 'y lo dice en claro');
  const lista2 = (await (await call('/api/pagos/preparations?rfc=' + OWN)).json()).preparations;
  assert.ok(lista2[0].pagadaEn, 'la preparación queda sellada como pagada');
}

/* ===== (1) Deshacer: el pago manual se quita, el REP no ===== */
{
  assert.equal((await call('/api/money/unmark-paid', { uuid: U5166 })).status, 200);
  assert.equal((await saldoDe(U5166)).balance, '80040.00', 'deshacer devuelve el saldo de la 5166');
  assert.equal((await call('/api/money/unmark-paid', { uuid: U963 })).status, 200);
  const b963 = await saldoDe(U963);
  assert.equal(b963.balance, '7760.00', 'deshacer la 963 devuelve su saldo…');
  assert.equal(b963.paid, '5000.00', '…y el pago del REP sigue intacto: no era un pago manual');
}

/* ===== (1) Avisos: cerrar, corregir el cierre, bitácora, reabrir ===== */
{
  const data = await (await call('/api/notices')).json();
  const aviso = (data.avisos || []).find(item => item.ref === 'saldo:' + U963 && item.kind === 'saldo');
  assert.ok(aviso, 'existe el aviso de saldo de la 963 (vencida el día 10)');
  assert.equal((await call('/api/notices/answer', { id: aviso.id, respuesta: 'si', fecha: '2026-11-25', nota: 'Transferencia de prueba' })).status, 200);
  assert.equal((await saldoDe(U963)).balance, '0.00', 'cerrar el aviso salda la factura');
  assert.equal((await call('/api/notices/edit-close', { id: aviso.id, fecha: '2026-11-24', nota: 'Fue el 24, por SPEI' })).status, 200,
    'la nota del cierre se puede corregir');
  const log = (await (await call('/api/notices/log?id=' + aviso.id)).json()).log;
  const acciones = log.map(entry => entry.accion);
  assert.ok(acciones.includes('pago-manual'), 'la bitácora guarda el cierre (pago manual)');
  assert.ok(acciones.includes('cierre-editado'), 'la bitácora guarda la corrección');
  assert.ok(log.some(entry => String(entry.nota).includes('Fue el 24')), 'la bitácora enseña la nota corregida');
  assert.equal((await call('/api/notices/reopen', { id: aviso.id })).status, 200, 'el aviso se puede reabrir');
  assert.equal((await saldoDe(U963)).balance, '7760.00', 'reabrir devuelve el saldo: el pago manual desaparece');
  const data2 = await (await call('/api/notices')).json();
  assert.ok((data2.avisos || []).some(item => item.id === aviso.id), 'el aviso vuelve a estar abierto');
  const log2 = (await (await call('/api/notices/log?id=' + aviso.id)).json()).log;
  assert.ok(log2.map(entry => entry.accion).includes('reabierto'), 'la bitácora guarda la reapertura');
}

/* ===== (2) Actividad: pausa real de la masiva y barrido del servidor ===== */
{
  const before = await (await call('/api/activity')).json();
  const held = (before.paused || []).find(entry => entry.kind === 'masiva');
  assert.ok(held && held.jobId, 'la descarga en pausa se ve en el registro como pausada, con su id');
  assert.ok(held.canResume, 'y ofrece Reanudar');
  assert.equal((await call('/api/activity/control', { kind: 'masiva', action: 'reanudar', jobId: held.jobId })).status, 200);
  const mid = await (await call('/api/activity')).json();
  assert.ok(!(mid.paused || []).some(entry => entry.jobId === held.jobId), 'reanudar la saca de la pausa (held=0)');
  assert.equal((await call('/api/activity/control', { kind: 'masiva', action: 'pausar', jobId: held.jobId })).status, 200);
  const after = await (await call('/api/activity')).json();
  assert.ok((after.paused || []).some(entry => entry.jobId === held.jobId), 'pausar la devuelve a la pausa (held=1)');

  const honesto = await call('/api/activity/control', { kind: 'listados', action: 'pausar' });
  assert.equal(honesto.status, 422, 'lo que no admite pausa no finge el botón: responde 422');
  assert.match((await honesto.json()).error, /no se pausa/, 'y lo dice en lenguaje llano');

  const arranque = await call('/api/monitor/check-now', {});
  assert.equal(arranque.status, 200, 'check-now responde');
  const arranqueJson = await arranque.json();
  assert.equal(arranqueJson.started, true, 'check-now ARRANCA el barrido en el servidor, no devuelve tandas al cliente');
  let visto = false;
  for (let i = 0; i < 30 && !visto; i++) {
    const act = await (await call('/api/activity')).json();
    visto = (act.running || []).some(entry => entry.kind === 'barrido') ||
      (act.recent || []).some(entry => String(entry.name || '').includes('Revisión de comprobantes'));
    if (!visto) await new Promise(resolve => setTimeout(resolve, 300));
  }
  assert.ok(visto, 'el barrido aparece en la actividad (en curso o recién terminado) sin pestaña que lo empuje');
  await call('/api/activity/control', { kind: 'barrido', action: 'detener' });
}

/* ===== Cierre: el estado final en la base, leído en frío ===== */
service.close();
{
  const db = new DatabaseSync(dbFile, { readOnly: true });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM manual_payments').get().n, 0,
    'tras deshacer y reabrir no queda ningún pago manual fantasma');
  assert.equal(db.prepare('SELECT held FROM jobs WHERE id = ?').get(heldJobId).held, 1,
    'la descarga masiva termina pausada, como se dejó');
  db.close();
}
rmSync(dir, { recursive: true, force: true });
console.log('ronda1180: OK — facilidad juzgada en comportamiento (deshacer, actividad, pagos, dinero, artefactos)');
