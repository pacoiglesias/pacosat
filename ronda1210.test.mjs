import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import jsQR from 'jsqr';
import { createPacoSATService } from './local-server.mjs';
import { verificationUrl, formatTotalQr, qrMatrix } from './qr-cfdi.mjs';

/* Ronda 1.21.0 — el QR VERDADERO de verificación del CFDI.
   Encargo de Paco del 11 nov: el PDF del comprobante lleva su
   código QR de verificación, el oficial del SAT (Anexo 20 I.E):
   URL de verificacfdi con UUID, RFC emisor, RFC receptor, total
   en el formato 10 enteros + 6 decimales y los últimos 8
   caracteres del sello — construida desde el comprobante real.
   LA PRUEBA QUE MANDA: el QR se recupera DEL PDF GENERADO (los
   rectángulos vectoriales del flujo de contenido, entre los
   marcadores PACOSAT-QR), se rasteriza y se DECODIFICA con jsQR;
   el texto decodificado debe ser EXACTAMENTE la URL esperada para
   la semilla. Sin timbre o con el sello corto no hay QR: el PDF
   lo dice en palabras y no imprime código alguno. */

const CER = 'MIIDUzCCAjugAwIBAgIUH2WzMvVXT5BC2dNEzTaqRKJcZVUwDQYJKoZIhvcNAQELBQAwOTEgMB4GA1UEAwwXRU1QUkVTQSBQUlVFQkEgU0EgREUgQ1YxFTATBgNVBAUTDE1GSTYyMTIxNThCNDAeFw0yNjExMDkwNTA0MzVaFw0zNjExMDYwNTA0MzVaMDkxIDAeBgNVBAMMF0VNUFJFU0EgUFJVRUJBIFNBIERFIENWMRUwEwYDVQQFEwxNRkk2MjEyMTU4QjQwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQDJv/UPUgh/H1XwYFWUj2DV8HVVL95Z3LSi7P5yC1m2hcXlGVyvrc9EwIxTYuKVndt3mZyafViTg7Zng3wPs/bkZIhWcXTBkFPy8/4OZF4HKhgQTByszYEqBo4hr6o98FqS638cXcIkAzKFaIhpIJUpFMmUyKlSLgdWRcW7gm4SF2TaWYWi5CBok6gSoWsbmvEdFa0BbSCTxUUOxxWeoqhaMeYgN+PYpLWkl8Iq7VZJ+JeH0LMvbKg6Bhug0KOnC3/yNSBDIrg+A1rOysN8JJOU76zPuqj6aki7+oAEZIpGcu6h3cri7S8qq3zYupFdmZHwRySGDRci3ZpyCqjlFB97AgMBAAGjUzBRMB0GA1UdDgQWBBQYRYXN6Lv4Ke+TNpNWj7H1tqkEpTAfBgNVHSMEGDAWgBQYRYXN6Lv4Ke+TNpNWj7H1tqkEpTAPBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUAA4IBAQC8EwF8xC42pm/jFhTaO/gp2LDiSfz5cIJyZe9XsbczupYA9moD0Y9qMdEFAqgSVmFqJNgE675d5meRJdvRariROlpN3BZfcvPDEqHnwjqzjgHBt9e+GYb8UzdvkWiJuN7hoWgs2m+AJdPnsIWopKVI8enqng9Un7LbzCkACmJuG03Y+N7uuT/jIE+hNBHLJI6S9CGGs3hr8S4eZ2ijQeYyrWtLoeadLFsp4QqDb/JqXGtrIWFH9p3TNDEvyyVsYUBXSBIxX9zf/EYQ9NMLqIVSJ5hR/GjmDPf0plFteYQZEhRohrXnAox6clkDaIqTJkzWHhY4PHCPn+sJAh+Jzz8Y';
const KEY = 'MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDJv/UPUgh/H1XwYFWUj2DV8HVVL95Z3LSi7P5yC1m2hcXlGVyvrc9EwIxTYuKVndt3mZyafViTg7Zng3wPs/bkZIhWcXTBkFPy8/4OZF4HKhgQTByszYEqBo4hr6o98FqS638cXcIkAzKFaIhpIJUpFMmUyKlSLgdWRcW7gm4SF2TaWYWi5CBok6gSoWsbmvEdFa0BbSCTxUUOxxWeoqhaMeYgN+PYpLWkl8Iq7VZJ+JeH0LMvbKg6Bhug0KOnC3/yNSBDIrg+A1rOysN8JJOU76zPuqj6aki7+oAEZIpGcu6h3cri7S8qq3zYupFdmZHwRySGDRci3ZpyCqjlFB97AgMBAAECggEADYRMYA86yCrqdZU8C/ItO+LajES4QiSyKjD0Uoy7ISpGRMqrCzl7Elv6Kti3CJd6bZa/nMQldpX+VwzCokSy7RYP4lwYmqKs/9vkBhp9suou5uH1O931jOzCggmZv4DxIzh0RuDAkewa6urtf2mc72iCoZ1uEWD0bI3L09EccclmqMihSGfwiihOwAWo2/1qM3ZOKraGe/AT2eUrGwfKqJKWIAzp6ec6cWHt+YtmQY+JtcpQcNVjPewosVD3xRV60knDaFKwCZeRmYQ9jZhFAoOA57nkRshPhejKV8iNvA1tdWWrqpRL/UjtpIs3y2jBfFtGNFL0oZMpWKhQSRFCzQKBgQDqRQ8hFqINPgwKorrZ676TkPPhQ2Ag2anCq0YCK84qPfRArhnwEVYbrzw9TEyF0RRn6DE22S+QzbGgjTDTcSbuBEY2jKlwgXZjGRa/NEN+rl+JWBtw02vk1l5EDBPCjXdxP7r7opL57yUU7UamnW/MBMhxG9tdSI6u6yEpi0vTBwKBgQDcdq8Wn5oRQYKYuXcZIbxEnsTuP0TQFev8Kplb91wB8SPxQt6glKmQQRJdztXX1JrOJoQUUy2Rlt43LxXh1aOWOm6TdTAeI+gOKUn/c4KYVq3yKw1sD61SNV7Oh8lZrb1laVavou0KbuKi4C3ifkmI/IYVFiaD0sKoGZ98GjWu7QKBgQDG3A5GqR6wHP49vPrdZzbjroTGr9mWqQ1oWNjZmPOted+vU9pipWSxpWN+KRk/8kXfGgNEqsGsql5gidlrcr54BprPTUG7ZbnnzvE3JxcwHrasMGVCtcT9gFaObq4LVOiR8mFFIuchvkMWV6DWs02wKBgEyOkkKC7ddsLlOmo+sAQgZ6M9yf799qnWYVzOeYwESUXmzbUb/ln/ROBHi66JtoYtGPonIEaGCUSVpUaX7g10vFwrxGB42P3nd5cwvYKtOH1iOwO5r43rEbg26ozIztvkVHDSk0pKfo1Z7FxmlOfW6qck1EQd+pApupOi64U0gJAoGBAJrkBt1d6wppq6p+RvwvIEm63/DuF80Cx/kG7YMEfJ3GQUQYmOxgIRniLZEitYSV2w3prwb/oBBu8TBsmM0nzFj/0SylLBWylVOKTtg8fxl7nEaJLJhjCyJAHtSgwtFnwLLNb2kBj2tR0BR2cT9H4wzwI0yNk0I7iEc6qsZ6FzGy';
const PWD = 'secreto-de-prueba';

const origin = 'http://127.0.0.1:43741';
const time = Date.parse('2026-11-25T18:00:00Z');
const OWN = 'AAA010101AAA';
const BRISBANE = 'BBB010101BBB';
const U963 = '18453D78-72CC-4AF5-92D8-D66F998F241F';
const USIN = '55555555-5555-4555-8555-555555555501';
const UCORTO = '77777777-7777-4777-8777-777777777701';
/* Sello de juguete con un final INCONFUNDIBLE: los últimos 8
   («fe» de la URL) son F1n4L8xZ. */
const SELLO = 'k7J2hGf8DsA1pO4iU7yT3rE6wQ0zX5cV8bN2mK4jH6gF1dS3aP5oI7uY9tR2eW4qA6sD8fG0hJ2kL4' + 'F1n4L8xZ';
const URL_ESPERADA = 'https://verificacfdi.facturaelectronica.sat.gob.mx/default.aspx' +
  `?id=${U963}&re=${BRISBANE}&rr=${OWN}&tt=0000012760.000000&fe=F1n4L8xZ`;

function harness(service) {
  let token;
  const call = async (path, data) => {
    const headers = { host: new URL(origin).host, origin, 'x-pacosat-token': token, 'x-pacosat-proxy': 'proxy-qr' };
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
const xmlCon = ({ uuid, folio, sello }) => `<?xml version="1.0" encoding="UTF-8"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" Version="4.0" Folio="${folio}" Fecha="2026-11-02T09:00:00" SubTotal="11000.00" Moneda="MXN" Total="12760.00" TipoDeComprobante="I" MetodoPago="PPD" FormaPago="99" LugarExpedicion="72000">
<cfdi:Emisor Rfc="${BRISBANE}" Nombre="BRISBANE TEXTIL SA DE CV" RegimenFiscal="601"/>
<cfdi:Receptor Rfc="${OWN}" Nombre="EMPRESA PROPIA SA" DomicilioFiscalReceptor="72000" RegimenFiscalReceptor="601" UsoCFDI="G03"/>
<cfdi:Conceptos><cfdi:Concepto ClaveProdServ="01010101" Cantidad="1" ClaveUnidad="H87" Descripcion="Servicio general de administración y operación" ValorUnitario="11000.00" Importe="11000.00" ObjetoImp="02"><cfdi:Impuestos><cfdi:Traslados><cfdi:Traslado Base="11000.00" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="1760.00"/></cfdi:Traslados></cfdi:Impuestos></cfdi:Concepto></cfdi:Conceptos>
<cfdi:Impuestos TotalImpuestosTrasladados="1760.00"><cfdi:Traslados><cfdi:Traslado Base="11000.00" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="1760.00"/></cfdi:Traslados></cfdi:Impuestos>
${sello === null ? '' : `<cfdi:Complemento><tfd:TimbreFiscalDigital xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital" Version="1.1" UUID="${uuid}" FechaTimbrado="2026-11-02T09:01:00" RfcProvCertif="SAT970701NN3" SelloCFD="${sello}" NoCertificadoSAT="00001000000500000001" SelloSAT="BBBB"/></cfdi:Complemento>`}
</cfdi:Comprobante>`;
const fila = (id, folio) => ({ id, date: '2026-11-02', kind: 'I', currency: 'MXN',
  from: { rfc: BRISBANE, name: 'BRISBANE TEXTIL SA DE CV' }, to: { rfc: OWN, name: 'EMPRESA PROPIA SA' },
  total: '12760.00', fiscal: { series: '', folio, subTotal: '11000.00', paymentMethod: 'PPD', paymentForm: '99',
    transferred: [{ tax: '002', base: '11000.00', amount: '1760.00' }] } });

const pdfText = async buffer => {
  const doc = await getDocument({ data: new Uint8Array(buffer) }).promise;
  let text = '';
  for (let i = 1; i <= doc.numPages; i++)
    text += (await (await doc.getPage(i)).getTextContent()).items.map(item => item.str).join(' ') + '\n';
  return { pages: doc.numPages, text };
};
/* Recupera la matriz del QR DESDE el flujo del PDF: los
   rectángulos entre los marcadores PACOSAT-QR, con la geometría
   que el propio marcador declara. Nada de mirar la matriz del
   generador: lo que se decodifica es lo impreso. */
function matrizDesdeElPdf(buffer) {
  const src = buffer.toString('latin1');
  const ini = src.indexOf('% PACOSAT-QR size=');
  if (ini < 0) return null;
  const fin = src.indexOf('% PACOSAT-QR-FIN', ini);
  assert.ok(fin > ini, 'el bloque QR del PDF se cierra');
  const cab = src.slice(ini, src.indexOf('\n', ini));
  const m = cab.match(/size=(\d+) mod=([\d.]+) x=([\d.]+) ytop=([\d.]+)/);
  assert.ok(m, 'la cabecera del bloque QR declara su geometría');
  const size = Number(m[1]), mod = Number(m[2]), x0 = Number(m[3]), yTop = Number(m[4]);
  const grid = Array.from({ length: size }, () => new Array(size).fill(0));
  const re = /([\d.]+) ([\d.]+) ([\d.]+) ([\d.]+) re f/g;
  let r;
  const trozo = src.slice(ini, fin);
  while ((r = re.exec(trozo))) {
    const [x, y, w] = [Number(r[1]), Number(r[2]), Number(r[3])];
    const row = Math.round((yTop - (y + mod)) / mod) - 4;
    const col = Math.round((x - x0) / mod) - 4;
    const span = Math.round(w / mod);
    assert.ok(row >= 0 && row < size && col >= 0 && col + span <= size, 'cada rectángulo cae dentro de la matriz');
    for (let c = col; c < col + span; c++) grid[row][c] = 1;
  }
  return grid;
}
/* Rasteriza la matriz (con su zona de silencio) y la decodifica
   con jsQR, como haría la cámara de un móvil. */
function decodificar(grid) {
  const size = grid.length, quiet = 4, scale = 6;
  const n = (size + quiet * 2) * scale;
  const data = new Uint8ClampedArray(n * n * 4).fill(255);
  for (let row = 0; row < size; row++) for (let col = 0; col < size; col++) if (grid[row][col])
    for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
      const at = ((row + quiet) * scale + dy) * n * 4 + ((col + quiet) * scale + dx) * 4;
      data[at] = data[at + 1] = data[at + 2] = 0;
    }
  return jsQR(data, n, n)?.data || null;
}

/* ===== Unidades: la URL y el formato del total (Anexo 20 I.E) ===== */
assert.equal(formatTotalQr('12760.00'), '0000012760.000000');
assert.equal(formatTotalQr('0.99'), '0000000000.990000');
assert.equal(formatTotalQr('296154.41'), '0000296154.410000');
assert.equal(formatTotalQr('0'), '0000000000.000000');
assert.equal(formatTotalQr(''), null);
assert.equal(formatTotalQr('abc'), null);
assert.equal(formatTotalQr('12345678901.00'), null, 'más de 10 enteros no cabe en la especificación');
assert.equal(verificationUrl({ uuid: U963, emisor: BRISBANE, receptor: OWN, total: '12760.00', sello: SELLO }), URL_ESPERADA,
  'la URL se construye exacta: UUID, ambos RFC, total 10+6 y fe = últimos 8 del sello');
assert.equal(verificationUrl({ uuid: U963, emisor: BRISBANE, receptor: OWN, total: '12760.00', sello: 'AAAA' }), null,
  'sello de menos de 8 caracteres: sin URL, sin QR');
assert.equal(verificationUrl({ uuid: U963, emisor: BRISBANE, receptor: OWN, total: '12760.00', sello: '' }), null);
assert.equal(verificationUrl({ uuid: 'no-es-uuid', emisor: BRISBANE, receptor: OWN, total: '12760.00', sello: SELLO }), null);
assert.equal(verificationUrl({ uuid: U963, emisor: BRISBANE, receptor: OWN, total: '', sello: SELLO }), null);
assert.equal(verificationUrl(), null);
/* La matriz del generador, decodificada directamente, ya dice la
   URL — pero la prueba que manda es la del PDF, abajo. */
{
  const { size, data } = qrMatrix(URL_ESPERADA);
  const grid = Array.from({ length: size }, (_, r) => Array.from({ length: size }, (_, c) => data[r * size + c]));
  assert.equal(decodificar(grid), URL_ESPERADA, 'la matriz generada decodifica la URL esperada');
}

/* ===== El PDF del comprobante, por la ruta real de Salidas ===== */
const dir = mkdtempSync(join(tmpdir(), 'pacosat-qr-'));
const service = createPacoSATService({ dbFile: join(dir, 'pacosat.sqlite'), html: '<!--PACOSAT_TOKEN-->', origin,
  proxyKey: 'proxy-qr', now: () => time,
  makeConnector: async () => ({ connector: { download: async () => { throw new Error('sin red'); } } }) });
const { call, login } = harness(service);
await login();
assert.equal((await call('/api/unlock', { rfc: OWN, minutes: 1440, days: 30, direction: 'both',
  certificate: CER, key: KEY, password: PWD })).status, 200);
assert.equal((await call('/api/storage', { batch: {
  people: [{ id: OWN, name: 'EMPRESA PROPIA SA' }, { id: BRISBANE, name: 'BRISBANE TEXTIL SA DE CV' }],
  invoices: [fila(U963, '963'), fila(USIN, '964'), fila(UCORTO, '965')],
  files: [
    { id: 'xml:' + U963, mime: 'application/xml', content: Buffer.from(xmlCon({ uuid: U963, folio: '963', sello: SELLO })).toString('base64') },
    { id: 'xml:' + USIN, mime: 'application/xml', content: Buffer.from(xmlCon({ uuid: USIN, folio: '964', sello: null })).toString('base64') },
    { id: 'xml:' + UCORTO, mime: 'application/xml', content: Buffer.from(xmlCon({ uuid: UCORTO, folio: '965', sello: 'AAAA' })).toString('base64') }]
} })).status, 200);
const pedirPdf = async id => {
  const res = await call('/api/salidas/cfdi', { id, format: 'pdf', rfc: OWN });
  assert.equal(res.status, 200, 'el PDF del comprobante ' + id + ' responde 200');
  const data = await res.json();
  return Buffer.from(data.content, 'base64');
};

/* --- LA PRUEBA QUE MANDA: decodificar el QR impreso en el PDF --- */
{
  const pdf = await pedirPdf(U963);
  const grid = matrizDesdeElPdf(pdf);
  assert.ok(grid, 'el PDF del comprobante timbrado lleva su bloque QR');
  assert.equal(grid.length, 53, 'la matriz impresa es la de la URL completa (53×53)');
  const decodificado = decodificar(grid);
  assert.equal(decodificado, URL_ESPERADA,
    'el QR impreso en el PDF decodifica EXACTAMENTE la URL oficial con el UUID, los RFC y el total de la semilla');
  /* Y el documento sigue completo alrededor del código. */
  const { text } = await pdfText(pdf);
  for (const esperado of [U963, '$12,760.00', 'Doce mil setecientos sesenta pesos',
    'BRISBANE TEXTIL SA DE CV', 'EMPRESA PROPIA SA', 'Timbre fiscal digital', 'Verificación en el SAT',
    'Escanea este código con el móvil'])
    assert.ok(text.includes(esperado), 'el PDF con QR sigue trayendo: ' + esperado);
}

/* --- Sin timbre: sin QR y con el aviso en palabras --- */
{
  const pdf = await pedirPdf(USIN);
  assert.equal(matrizDesdeElPdf(pdf), null, 'sin Timbre Fiscal Digital no se imprime QR alguno');
  const { text } = await pdfText(pdf);
  assert.ok(text.includes('no está timbrado'), 'el PDF sin timbre lo dice en palabras');
  assert.ok(text.includes('no lleva código QR de verificación'), 'el aviso nombra lo que falta');
  assert.ok(text.includes('$12,760.00'), 'el comprobante sin timbre sigue completo');
}

/* --- Timbre con el sello incompleto: sin QR y con el aviso --- */
{
  const pdf = await pedirPdf(UCORTO);
  assert.equal(matrizDesdeElPdf(pdf), null, 'con el sello corto tampoco se inventa un QR');
  const { text } = await pdfText(pdf);
  assert.ok(text.includes('faltan datos del timbre'), 'el PDF avisa de los datos que faltan');
}
service.close();
rmSync(dir, { recursive: true, force: true });
console.log('ronda1210.test.mjs OK');
