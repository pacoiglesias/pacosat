import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createPacoSATService } from './local-server.mjs';
import { folioLabel, amountInWords } from './salidas-doc.mjs';

/* Ronda Salidas (1.14.0) — la capa de salidas diseñada que aprobó
   Paco el 10 nov 2026 como primera de la tanda:
   (1) PDF de papel (periodo, cierre, saldos, contraparte y mapa
       anual de declaraciones) con el FOLIO visible y totales
       correctos, construidos con las cifras verdad del servidor.
   (2) .xlsx REALES: tipos (fecha como serial, importes como
       número con formato), fila de totales con fórmula SUM y su
       valor calculado, filtros y primera fila fijada.
   (3) Descarga a la carta por comprobante (XML / PDF / ambos) y
       ZIP por periodo, RFC, cierre o selección, ordenados
       RFC → emitidos/recibidos → año → mes, cancelados aparte,
       con índice (folio, estado SAT, estado de pago) y manifiesto;
       el ZIP de cierre trae la constancia y la opinión con la
       convención RFC-csf.pdf / RFC-32d.pdf.
   (4) El folio como dato de salida y amountInWords para el total
       en letra. Las pruebas JUZGAN EL ARTEFACTO: abren el PDF con
       pdfjs y leen su texto, y abren el .xlsx/ZIP y leen su XML. */

const CER = 'MIIDUzCCAjugAwIBAgIUH2WzMvVXT5BC2dNEzTaqRKJcZVUwDQYJKoZIhvcNAQELBQAwOTEgMB4GA1UEAwwXRU1QUkVTQSBQUlVFQkEgU0EgREUgQ1YxFTATBgNVBAUTDE1GSTYyMTIxNThCNDAeFw0yNjExMDkwNTA0MzVaFw0zNjExMDYwNTA0MzVaMDkxIDAeBgNVBAMMF0VNUFJFU0EgUFJVRUJBIFNBIERFIENWMRUwEwYDVQQFEwxNRkk2MjEyMTU4QjQwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQDJv/UPUgh/H1XwYFWUj2DV8HVVL95Z3LSi7P5yC1m2hcXlGVyvrc9EwIxTYuKVndt3mZyafViTg7Zng3wPs/bkZIhWcXTBkFPy8/4OZF4HKhgQTByszYEqBo4hr6o98FqS638cXcIkAzKFaIhpIJUpFMmUyKlSLgdWRcW7gm4SF2TaWYWi5CBok6gSoWsbmvEdFa0BbSCTxUUOxxWeoqhaMeYgN+PYpLWkl8Iq7VZJ+JeH0LMvbKg6Bhug0KOnC3/yNSBDIrg+A1rOysN8JJOU76zPuqj6aki7+oAEZIpGcu6h3cri7S8qq3zYupFdmZHwRySGDRci3ZpyCqjlFB97AgMBAAGjUzBRMB0GA1UdDgQWBBQYRYXN6Lv4Ke+TNpNWj7H1tqkEpTAfBgNVHSMEGDAWgBQYRYXN6Lv4Ke+TNpNWj7H1tqkEpTAPBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUAA4IBAQC8EwF8xC42pm/jFhTaO/gp2LDiSfz5cIJyZe9XsbczupYA9moD0Y9qMdEFAqgSVmFqJNgE675d5meRJdvRariROlpN3BZfcvPDEqHnwjqzjgHBt9e+GYb8UzdvkWiJuN7hoWgs2m+AJdPnsIWopKVI8enqng9Un7LbzCkACmJuG03Y+N7uuT/jIE+hNBHLJI6S9CGGs3hr8S4eZ2ijQeYyrWtLoeadLFsp4QqDb/JqXGtrIWFH9p3TNDEvyyVsYUBXSBIxX9zf/EYQ9NMLqIVSJ5hR/GjmDPf0plFteYQZEhRohrXnAox6clkDaIqTJkzWHhY4PHCPn+sJAh+Jzz8Y';
const KEY = 'MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDJv/UPUgh/H1XwYFWUj2DV8HVVL95Z3LSi7P5yC1m2hcXlGVyvrc9EwIxTYuKVndt3mZyafViTg7Zng3wPs/bkZIhWcXTBkFPy8/4OZF4HKhgQTByszYEqBo4hr6o98FqS638cXcIkAzKFaIhpIJUpFMmUyKlSLgdWRcW7gm4SF2TaWYWi5CBok6gSoWsbmvEdFa0BbSCTxUUOxxWeoqhaMeYgN+PYpLWkl8Iq7VZJ+JeH0LMvbKg6Bhug0KOnC3/yNSBDIrg+A1rOysN8JJOU76zPuqj6aki7+oAEZIpGcu6h3cri7S8qq3zYupFdmZHwRySGDRci3ZpyCqjlFB97AgMBAAECggEADYRMYA86yCrqdZU8C/ItO+LajES4QiSyKjD0Uoy7ISpGRMqrCzl7Elv6Kti3CJd6bZa/nMQldpX+VwzCokSy7RYP4lwYmqKs/9vkBhp9suou5uH1O931jOzCggmZv4DxIzh0RuDAkewa6urtf2mc72iCoZ1uEWD0bI3L09EccclmqMihSGfwiihOwAWo2/1qM3ZOKraGe/AT2eUrGwfKqJKWIAzp6ec6cWHt+YtmQY+JtcpQcNVjPewosVD3xRV60knDaFKwCZeRmYQ9jZhFAoOA57nkRshPhejKV8iNvA1tdWWrqpRL/UjtpIs3y2jBfFtGNFL0oZMpWKhQSRFCzQKBgQDqRQ8hFqINPgwKorrZ676TkPPhQ2Ag2anCq0YCK84qPfRArhnwEVYbrzw9TEyF0RRn6DE22S+QzbGgjTDTcSbuBEY2jKlwgXZjGRa/NEN+rl+JWBtw02vk1l5EDBPCjXdxP7r7opL57yUU7UamnW/MBMhxG9tdSI6u6yEpi0vTBwKBgQDcdq8Wn5oRQYKYuXcZIbxEnsTuP0TQFev8Kplb91wB8SPxQt6glKmQQRJdztXX1JrOJoQUUy2Rlt43LxXh1aOWOm6TdTAeI+gOKUn/c4KYVq3yKw1sD61SNV7Oh8lZrb1laVavou0KbuKi4C3ifkmI/IYVFiaD0sKoGZ98GjWu7QKBgQDG3A5GqR6wHP49vPrdZzbjroTGr9mWqQ1oWNjZmPOted+vU9pipWSxpWN+KRk/8kXfGgNEqsGsql5gidlrcr54BprPTUG7ZbnnzvE3JxcwHrasMGVCtcT9gFaObq4LVOiR8mY3mj4m+LBCflOdtUCkL18yXFIuchvkMWV6DWs02wKBgEyOkkKC7ddsLlOmo+sAQgZ6M9yf799qnWYVzOeYwESUXmzbUb/ln/ROBHi66JtoYtGPonIEaGCUSVpUaX7g10vFwrxGB42P3nd8cwvYKtOH1iOwO5r43rEbg26ozIztvkVHDSk0pKfo1Z7FxmlOfW6qck1EQd+pApupOi64U0gJAoGBAJrkBt1d6wppq6p+RvwvIEm63/DuF80Cx/kG7YMEfJ3GQUQYmOxgIRniLZEitYSV2w3prwb/oBBu8TBsmM0nzFj/0SylLBWylVOKTtg8fxl7nEaJLJhjCyJAHtSgwtFnwLLNb2kBj2tR0BR2cT9H4wzwI0yNk0I7iEc6qsZ6FzGy';
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
const UACE = '44444444-4444-4444-8444-444444444401';

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
const rowAce = { id: UACE, date: '2026-10-15', kind: 'I', currency: 'MXN',
  from: { rfc: 'AIC150804PQ2', name: 'ACEROS INDUSTRIALES SA' }, to: { rfc: OWN, name: 'EMPRESA PROPIA SA' },
  total: '33640.00', fiscal: fiscal('13564', '29000.00', '4640.00', 'PUE') };
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
/* Para leer un ZIP cualquiera se recorre el directorio central a
   mano (los ZIP de la casa van sin compresión, método store). */
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

/* ===== Semilla: servicio con base en disco (dos aperturas) ===== */
const dir = mkdtempSync(join(tmpdir(), 'pacosat-salidas-'));
const dbFile = join(dir, 'pacosat.sqlite');
{
  const service = createPacoSATService({ dbFile, html: '<!--PACOSAT_TOKEN-->', origin, proxyKey: 'proxy-salidas', now: () => time,
    makeConnector: async () => ({ connector: { download: async () => { throw new Error('sin red'); } } }) });
  const { call, login } = harness(service);
  await login();
  assert.equal((await call('/api/unlock', { rfc: OWN, minutes: 1440, days: 30, direction: 'both',
    certificate: CER, key: KEY, password: PWD })).status, 200);
  assert.equal((await call('/api/storage', { batch: {
    people: [{ id: OWN, name: 'EMPRESA PROPIA SA' }, { id: BRISBANE, name: 'BRISBANE TEXTIL SA DE CV' }],
    invoices: [row963, row5166, rowChed, row959, rowRep, rowAce],
    files: [
      { id: 'xml:' + U963, mime: 'application/xml', content: Buffer.from(xml963).toString('base64') },
      { id: 'xml:' + U5166, mime: 'application/xml', content: Buffer.from(xml5166).toString('base64') },
      { id: 'xml:' + U959, mime: 'application/xml', content: Buffer.from(xml959).toString('base64') },
      { id: 'xml:' + UREP, mime: 'application/pdf', content: Buffer.from(xmlRep).toString('base64') },
      { id: 'doc-csf', mime: 'application/pdf', content: CSF.toString('base64') },
      { id: 'doc-32d', mime: 'application/pdf', content: OPINION.toString('base64') }]
  } })).status, 200);
  /* Preparación de pagos guardada (para el Excel de pagos). */
  const prep = await call('/api/pagos/prepare', { rfc: OWN, month: '2026-11',
    group: { descripcion: 'PROVEEDORES NOVIEMBRE', cuentaRetiro: '0444392590' },
    lines: [{ nombre: 'BRISBANE TEXTIL SA DE CV', rfc: BRISBANE, banco: 'BBVA', grupo: 'BBVA',
      cuenta: '0123456789', motivo: 'SERVICIO GENERAL NOVIEMBRE', folio: '963', total: '12760.00', base: '11000.00', iva: '1760.00' }] });
  assert.equal(prep.status, 200, 'preparación de pagos de juguete');
  service.close();
}
{
  /* Vigilancia, declaraciones y documentos del SAT: filas directas,
     como las dejarían el monitor y los descargadores reales. */
  const db = new DatabaseSync(dbFile);
  const watch = db.prepare('INSERT INTO cfdi_watch(id, emitter, receiver, total, seal, next, checked, result) VALUES (?,?,?,?,?,?,?,?)');
  const estado = state => JSON.stringify({ state, code: 'S', cancellation: '', cancelable: '', error: '' });
  watch.run(U963, BRISBANE, OWN, '12760.00', '', time + 86400000, time, estado('Vigente'));
  watch.run(U5166, 'GRC131111298', OWN, '80040.00', '', time + 86400000, time, estado('Vigente'));
  watch.run(UCHED, OWN, 'SUC580621DAA', '296154.41', '', time + 86400000, time, estado('Vigente'));
  watch.run(U959, BRISBANE, OWN, '33779.20', '', time + 86400000, time, estado('Cancelado'));
  const decl = db.prepare("INSERT INTO declaraciones(id, rfc, tipo, clase, ejercicio, periodo, fechaPresentacion, operacion, fileId, source, created) VALUES (?,?,?,?,?,?,?,?,?,?,?)");
  decl.run('decl-1', OWN, 'mensual', 'declaracion', 2026, '2026-10', '2026-11-17', '12345678901234567890', 'decl-file-1', 'prueba', time);
  decl.run('decl-2', OWN, 'mensual', 'acuse', 2026, '2026-10', '2026-11-17', '12345678901234567890', 'decl-file-2', 'prueba', time);
  const doc = db.prepare('INSERT INTO sat_documents(id, rfc, kind, issuedAt, fileId, source, created) VALUES (?,?,?,?,?,?,?)');
  doc.run('sd-1', OWN, 'constancia', time - 86400000, 'doc-csf', 'prueba', time);
  doc.run('sd-2', OWN, 'opinion', time - 86400000, 'doc-32d', 'prueba', time);
  db.close();
}

const service = createPacoSATService({ dbFile, html: '<!--PACOSAT_TOKEN-->', origin, proxyKey: 'proxy-salidas', now: () => time,
  makeConnector: async () => ({ connector: { download: async () => { throw new Error('sin red'); } } }) });
const { call, login } = harness(service);
await login();
const pedir = async (ruta, payload) => {
  const res = await call('/api/salidas/' + ruta, payload);
  assert.equal(res.status, 200, ruta + ' responde 200');
  const data = await res.json();
  return { name: data.name, type: data.type, buffer: Buffer.from(data.content, 'base64') };
};

/* ===== (4) Folio y total en letra (unidades) ===== */
assert.equal(folioLabel({ fiscal: { series: 'R', folio: '1101' } }), 'R-1101');
assert.equal(folioLabel({ fiscal: { series: '', folio: '963' } }), '963');
assert.equal(folioLabel({ fiscal: null }), 'Sin folio');
assert.equal(amountInWords(12760000), 'Ciento veintisiete mil seiscientos pesos 00/100 M.N.');
assert.equal(amountInWords(20068000), 'Doscientos mil seiscientos ochenta pesos 00/100 M.N.');
assert.equal(amountInWords(100000000), 'Un millón de pesos 00/100 M.N.');
assert.equal(amountInWords(776050), 'Siete mil setecientos sesenta pesos 50/100 M.N.');

/* ===== (3) Descarga a la carta por comprobante ===== */
{
  const xml = await pedir('cfdi', { id: U963, format: 'xml', rfc: OWN });
  assert.equal(xml.name, '2026-11-02_BBB010101BBB_963.xml');
  assert.ok(xml.buffer.toString('utf8').includes(U963), 'el XML descargado es el guardado');
  const pdf = await pedir('cfdi', { id: U963, format: 'pdf', rfc: OWN });
  assert.equal(pdf.name, '2026-11-02_BBB010101BBB_963.pdf');
  const { text } = await pdfText(pdf.buffer);
  assert.ok(text.includes('963'), 'el PDF del comprobante trae su folio');
  assert.ok(text.includes(U963), 'el PDF trae el UUID completo');
  assert.ok(text.includes('$12,760.00'), 'el PDF trae el total');
  assert.ok(text.includes('Doce mil setecientos sesenta pesos'), 'el PDF trae el total en letra ($12,760)');
  assert.ok(text.includes('BRISBANE TEXTIL SA DE CV'), 'el PDF trae al emisor');
  const ambos = await pedir('cfdi', { id: U963, format: 'ambos', rfc: OWN });
  const entries = zipRaw(ambos.buffer);
  assert.deepEqual([...entries.keys()].sort(),
    ['2026-11-02_BBB010101BBB_963.pdf', '2026-11-02_BBB010101BBB_963.xml']);
  /* El REP: su PDF desglosa el documento relacionado. */
  const rep = await pedir('cfdi', { id: UREP, format: 'pdf', rfc: OWN });
  const repText = (await pdfText(rep.buffer)).text;
  assert.ok(repText.includes('Pagos relacionados'), 'el PDF del REP trae la sección de pagos');
  assert.ok(repText.includes('$5,000.00') && repText.includes('$7,760.00'), 'el REP trae pagado e insoluto');
  /* Sin XML guardado: error claro, no un artefacto vacío. */
  const res = await call('/api/salidas/cfdi', { id: UACE, format: 'xml', rfc: OWN });
  assert.equal(res.status, 404);
  assert.match((await res.json()).error, /no tiene XML guardado/);
  const falta = await call('/api/salidas/cfdi', { id: '00000000-0000-4000-8000-000000000000', format: 'pdf' });
  assert.equal(falta.status, 404);
}

/* ===== (1) PDF del periodo y de cierre ===== */
{
  const periodo = await pedir('pdf', { kind: 'periodo', rfc: OWN, month: '2026-11' });
  assert.equal(periodo.name, 'periodo-2026-11-AAA010101AAA.pdf');
  const { text } = await pdfText(periodo.buffer);
  for (const esperado of ['963', '5166', 'R-1101', '959', '$296,154.41'])
    assert.ok(text.includes(esperado), 'el PDF del periodo trae ' + esperado);
  /* 1.18.0: el total de recibidos YA no suma la cancelada (era el
     defecto que la revisión cazó en estos artefactos): la fila de
     la 959 consta marcada «Cancelado» y el total es 92,800 con su
     etiqueta «Total (sin canceladas)». */
  assert.ok(text.includes('$92,800.00'), 'el total de recibidos excluye la cancelada desde la 1.18.0');
  assert.ok(text.includes('Total (sin canceladas)'), 'la etiqueta del total avisa de la exclusión');
  assert.ok(text.includes('Cancelado'), 'la fila de la 959 se marca Cancelado en la columna de estado');
  const cierre = await pedir('pdf', { kind: 'cierre', rfc: OWN, month: '2026-11' });
  const cierreText = (await pdfText(cierre.buffer)).text;
  assert.ok(cierreText.includes('Lista de cierre del mes'), 'el cierre trae la lista de comprobación del servidor');
  assert.ok(cierreText.includes('CFDI del mes en el expediente'), 'la lista es la de monthChecklist');
  assert.ok(cierreText.includes('Vigilancia del SAT en el mes'), 'el cierre trae la vigilancia');
  assert.ok(cierreText.includes('Cancelados: 1'), 'la vigilancia cuenta la cancelada del mes');
  assert.ok(cierreText.includes('Pendientes de cobro o pago del mes'), 'el cierre trae los pendientes');
}

/* ===== (1) PDF de saldos y por contraparte ===== */
{
  const saldos = await pedir('pdf', { kind: 'saldos', rfc: OWN });
  const { text } = await pdfText(saldos.buffer);
  assert.ok(text.includes('Por pagar'), 'saldos trae la sección por pagar');
  assert.ok(text.includes('$87,800.00'), 'por pagar: 7,760 (963 tras el REP) + 80,040 (5166)');
  assert.ok(text.includes('963') && text.includes('5166'), 'saldos trae los folios');
  const cp = await pedir('pdf', { kind: 'contraparte', rfc: OWN, contraparte: BRISBANE });
  const cpText = (await pdfText(cp.buffer)).text;
  assert.ok(cpText.includes('BRISBANE TEXTIL SA DE CV'), 'la contraparte trae su nombre');
  assert.ok(cpText.includes('$7,760.00'), 'el saldo vivo de Brisbane es el de la 963 tras el REP');
  assert.ok(cpText.includes('Siete mil setecientos sesenta pesos'), 'el saldo va también en letra');
}

/* ===== (1) PDF del mapa anual de declaraciones ===== */
{
  const mapa = await pedir('pdf', { kind: 'declaraciones', rfc: OWN, year: '2026' });
  const { text } = await pdfText(mapa.buffer);
  assert.ok(text.includes('Mapa anual de declaraciones'), 'el mapa trae su título');
  assert.ok(text.includes('Octubre 2026'), 'el mapa trae los meses por nombre');
  assert.ok(text.includes('12345678901234567890'), 'el mapa trae el nº de operación recuperado');
  /* 1.18.0: el mapa en papel usa el vocabulario del mapa de
     pantalla (1.17.0): el mes con declaración y acuse consta
     «Presentada», ya no «Recuperada». */
  assert.ok(text.includes('Presentada'), 'octubre consta presentada');
  assert.ok(text.includes('Declaración anual'), 'el mapa cierra con la anual');
}

/* ===== (2) Excel reales ===== */
const sheetXml = async (buffer, name) => {
  const entries = zipRaw(buffer);
  const workbook = entries.get('xl/workbook.xml').toString('utf8');
  const index = [...workbook.matchAll(/<sheet name="([^"]+)"/g)].findIndex(m => m[1] === name);
  assert.ok(index >= 0, 'hoja ' + name);
  return entries.get(`xl/worksheets/sheet${index + 1}.xml`).toString('utf8');
};
{
  const libro = await pedir('xlsx', { kind: 'facturas', rfc: OWN, month: '2026-11' });
  /* 1.18.0: el Excel de facturas baja con nombre humano. */
  assert.equal(libro.name, 'Facturas noviembre de 2026 — AAA010101AAA.xlsx');
  const recibidas = await sheetXml(libro.buffer, 'Recibidas');
  /* 1.22.0 (auditoría de verdad, N1): el Excel de facturas ya NO
     suma la cancelada — su total es el del PDF del mismo mes,
     «sin canceladas» — y la celda NO lleva la fórmula SUM, que al
     abrir el archivo volvería a sumar la fila cancelada. (La
     1.14.0 certificó lo contrario; la auditoría lo revocó: el
     Excel es el archivo que va a la contadora.) */
  assert.ok(recibidas.includes('<v>92800.00</v>'), 'el total de recibidas excluye la cancelada: $92,800.00, como el PDF');
  assert.ok(!recibidas.includes('<v>126579.20</v>'), 'la suma vieja con la cancelada ($126,579.20) ya no aparece');
  assert.ok(recibidas.includes('<v>12760.00</v>'), 'los importes son números, no texto');
  assert.match(recibidas, /autoFilter/, 'la hoja lleva filtros');
  assert.match(recibidas, /state="frozen"/, 'la primera fila queda fijada');
  const emitidas = await sheetXml(libro.buffer, 'Emitidas');
  assert.match(emitidas, /<f>SUM\(/, 'sin canceladas en la hoja, la fila de totales sí lleva su fórmula SUM');
  assert.ok(emitidas.includes('R-1101'), 'la hoja de emitidas trae el folio con serie');
  assert.ok(emitidas.includes('<v>296154.41</v>'), 'la emitida trae su total como número');
  const saldos = await pedir('xlsx', { kind: 'saldos-pagar', rfc: OWN });
  const porPagar = await sheetXml(saldos.buffer, 'Por pagar');
  assert.ok(porPagar.includes('<v>87800.00</v>'), 'el saldo por pagar suma 87,800.00 con su fórmula');
  const complementos = await pedir('xlsx', { kind: 'complementos', rfc: OWN });
  const reps = await sheetXml(complementos.buffer, 'Complementos de pago');
  assert.ok(reps.includes(U963), 'el complemento enlaza el UUID relacionado');
  assert.ok(reps.includes('<v>5000.00</v>') && reps.includes('<v>7760.00</v>'), 'el complemento trae pagado e insoluto');
  const pagos = await pedir('xlsx', { kind: 'pagos', rfc: OWN });
  const grupo = await sheetXml(pagos.buffer, 'Grupo BBVA');
  assert.ok(grupo.includes('0123456789'), 'el Excel de pagos trae la cuenta del grupo');
  assert.ok(grupo.includes('<v>12760.00</v>'), 'el Excel de pagos trae el importe como número');
  const listados = await pedir('xlsx', { kind: 'listados' });
  assert.ok(listados.name.endsWith('.xlsx'), 'el Excel de listados se genera aunque no haya listados');
}

/* ===== (3) ZIP ordenados ===== */
{
  const periodo = await pedir('zip', { scope: 'periodo', rfc: OWN, month: '2026-11' });
  const entries = zipRaw(periodo.buffer);
  const names = [...entries.keys()];
  assert.ok(names.includes(`${OWN}/recibidos/2026/11/2026-11-02_BBB010101BBB_963.xml`), 'ruta ordenada de la 963');
  assert.ok(names.includes(`${OWN}/emitidos/2026/11/2026-11-06_SUC580621DAA_R-1101.xml`) === false, 'la emitida sin XML no se inventa');
  assert.ok(names.includes(`${OWN}/cancelados/2026/11/2026-11-06_BBB010101BBB_959.xml`), 'la cancelada va en su carpeta aparte');
  assert.ok(names.includes(`${OWN}/indice.csv`), 'el ZIP trae índice');
  assert.ok(names.includes('manifiesto.txt'), 'el ZIP trae manifiesto');
  const indice = entries.get(`${OWN}/indice.csv`).toString('utf8');
  assert.ok(indice.includes('Folio') && indice.includes('963'), 'el índice trae el folio');
  assert.ok(indice.includes('Cancelado'), 'el índice trae el estado SAT de la cancelada');
  assert.ok(indice.includes('Parcial'), 'el índice trae el estado de pago parcial de la 963');
  const manifiesto = entries.get('manifiesto.txt').toString('utf8');
  assert.ok(manifiesto.includes('Comprobantes incluidos: 5'), 'el manifiesto cuenta los del periodo');
  /* El XML dentro del ZIP es el guardado, byte a byte. */
  assert.ok(entries.get(`${OWN}/recibidos/2026/11/2026-11-02_BBB010101BBB_963.xml`).toString('utf8').includes(U963));
  const cierre = await pedir('zip', { scope: 'cierre', rfc: OWN, month: '2026-11' });
  const cierreEntries = zipRaw(cierre.buffer);
  assert.ok(cierreEntries.has('resumen-cierre.pdf'), 'el cierre incluye su PDF resumen');
  /* 1.18.0: constancia y opinión viajan en su carpeta «Documentos
     del SAT», con la misma convención de nombre RFC-csf/32d.pdf. */
  assert.ok(cierreEntries.get(`Documentos del SAT/${OWN}-csf.pdf`).equals(CSF), 'la constancia viaja como RFC-csf.pdf en su carpeta');
  assert.ok(cierreEntries.get(`Documentos del SAT/${OWN}-32d.pdf`).equals(OPINION), 'la opinión viaja como RFC-32d.pdf en su carpeta');
  const porRfc = await pedir('zip', { scope: 'rfc', rfc: OWN, year: '2026' });
  const rfcEntries = zipRaw(porRfc.buffer);
  assert.ok(rfcEntries.get(`${OWN}/indice.csv`).toString('utf8').includes('13564'),
    'el ZIP por RFC alcanza octubre: la 13564 consta en el índice (sin XML guardado, se dice en su fila)');
  assert.ok(rfcEntries.get('manifiesto.txt').toString('utf8').includes('sin XML guardado'),
    'el manifiesto avisa de los comprobantes sin XML');
  const seleccion = await pedir('zip', { scope: 'seleccion', rfc: OWN, ids: [U963, U959] });
  const selEntries = zipRaw(seleccion.buffer);
  assert.ok(selEntries.has(`${OWN}/recibidos/2026/11/2026-11-02_BBB010101BBB_963.xml`));
  assert.ok(selEntries.has(`${OWN}/cancelados/2026/11/2026-11-06_BBB010101BBB_959.xml`));
  /* Guardas: RFC que no es perfil y mes mal formado. */
  const malo = await call('/api/salidas/zip', { scope: 'periodo', rfc: 'XXX010101XXX', month: '2026-11' });
  assert.equal(malo.status, 422);
  const malMes = await call('/api/salidas/pdf', { kind: 'periodo', rfc: OWN, month: 'noviembre' });
  assert.equal(malMes.status, 422);
}
service.close();
rmSync(dir, { recursive: true, force: true });
console.log('ronda1140.test.mjs OK');
