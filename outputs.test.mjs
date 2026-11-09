import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { DOMParser } from '@xmldom/xmldom';
import { createPacoSATService } from './local-server.mjs';
import { parseXml } from './xml-core.mjs';

/* Centro de salidas (1.6.16): re-parseo del desglose, correo desde la
   app con bitácora, exportación completa legible, paquete mensual e
   informes programados (mensual y semanal). Todo local y de juguete. */
const origin = 'https://pacosat.example.com';
const proxyKey = 'b'.repeat(64);
const UUID = '12345678-1234-1234-1234-1234567890AB';
const XML = `<?xml version="1.0" encoding="UTF-8"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" Version="4.0" Serie="A" Folio="1" Fecha="2026-10-15T10:00:00" SubTotal="1000.00" Moneda="MXN" Total="1160.00" TipoDeComprobante="I" MetodoPago="PPD" FormaPago="99" LugarExpedicion="72000">
<cfdi:Emisor Rfc="AAA010101AAA" Nombre="EMPRESA ALFA SA" RegimenFiscal="601"/>
<cfdi:Receptor Rfc="XAXX010101000" Nombre="CLIENTE UNO" DomicilioFiscalReceptor="72000" RegimenFiscalReceptor="601" UsoCFDI="G03"/>
<cfdi:Conceptos><cfdi:Concepto ClaveProdServ="01010101" Cantidad="1" ClaveUnidad="H87" Descripcion="Servicio" ValorUnitario="1000.00" Importe="1000.00" ObjetoImp="02"><cfdi:Impuestos><cfdi:Traslados><cfdi:Traslado Base="1000.00" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="160.00"/></cfdi:Traslados></cfdi:Impuestos></cfdi:Concepto></cfdi:Conceptos>
<cfdi:Impuestos TotalImpuestosTrasladados="160.00"><cfdi:Traslados><cfdi:Traslado Base="1000.00" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="160.00"/></cfdi:Traslados></cfdi:Impuestos>
<cfdi:Complemento><tfd:TimbreFiscalDigital xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital" Version="1.1" UUID="${UUID}" FechaTimbrado="2026-10-15T10:01:00" RfcProvCertif="SAT970701NN3" SelloCFD="AAAA" NoCertificadoSAT="00001000000500000001" SelloSAT="BBBB"/></cfdi:Complemento>
</cfdi:Comprobante>`;
let time = Date.parse('2026-11-10T15:00:00Z');
const sent = [];
const service = createPacoSATService({ dbFile: ':memory:', html: '<!--PACOSAT_TOKEN-->', origin, proxyKey, now: () => time,
  makeConnector: async () => ({ parser: DOMParser, connector: {
    request: async () => 'req-salidas-1',
    check: async () => ({ status: 'pending', packages: [] }),
    download: async () => { throw new Error('sin paquetes'); } } }),
  makeMailer: () => ({ verify: async () => true, sendMail: async payload => { sent.push(payload); } }) });
let token;
async function call(path, data, options = {}) {
  const headers = { host: 'pacosat.example.com', origin, 'x-pacosat-proxy': proxyKey, 'x-pacosat-token': token, ...options };
  const req = Object.assign(Readable.from(data === undefined ? [] : [Buffer.from(JSON.stringify(data))]), {
    url: path, method: data === undefined ? 'GET' : 'POST', headers });
  let response;
  const res = { setHeader() {}, writeHead(status) { this.status = status; this.headersSent = true; },
    end(content) { response = new Response(content, { status: this.status }); } };
  await service.handle(req, res);
  return response;
}
try {
  const page = await (await call('/')).text();
  token = page.split('content="')[1].split('"')[0];
  assert.equal((await call('/api/mail', { host: 'smtp.example.com', port: 587, user: 'u', password: 'p',
    from: 'from@example.com', recipient: 'avisos@example.com' })).status, 200);
  assert.equal((await call('/api/unlock', { rfc: 'XAXX010101000', minutes: 1440, days: 7, direction: 'received',
    password: 'simulated', certificate: 'YQ==', key: 'Yg==' })).status, 200);
  /* Semilla: un CFDI recibido SIN desglose + su XML guardado. */
  const row = parseXml(Buffer.from(XML), DOMParser);
  assert.equal(row.id, UUID);
  assert.equal((await call('/api/storage', { batch: {
    people: [{ id: 'XAXX010101000', name: 'Cliente Uno' }],
    invoices: [row],
    files: [{ id: 'xml:' + UUID, mime: 'application/xml', content: Buffer.from(XML).toString('base64') }]
  } })).status, 200);
  /* Re-parseo: completa el desglose sin contactar al SAT. */
  const reparse = await (await call('/api/reparse', {})).json();
  assert.deepEqual(reparse, { updated: 1, skipped: 0, failed: 0 });
  const stored = await (await call('/api/storage?store=invoices')).json();
  assert.equal(stored[0].fiscal.paymentMethod, 'PPD');
  assert.equal(stored[0].fiscal.transferred[0].amount, '160.00');
  assert.equal(stored[0].fiscal.cfdiUse, 'G03');
  /* Correo desde la app con adjunto del expediente + bitácora. */
  const compose = await call('/api/mail/send', { to: 'nora@example.com', subject: 'CFDI de octubre', text: 'Adjunto el XML.',
    attachments: [{ fileId: 'xml:' + UUID, filename: 'factura.xml' }] });
  assert.equal(compose.status, 200);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].attachments[0].filename, 'factura.xml');
  let log = await (await call('/api/mail/log')).json();
  assert.equal(log.sends[0].kind, 'compose');
  assert.equal(log.sends[0].ok, 1);
  /* Exportación completa legible del año. */
  const full = await (await call('/api/export-full', { year: '2026' })).json();
  assert.ok(full.name.endsWith('2026.zip'));
  const zip = Buffer.from(full.content, 'base64');
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  assert.ok(zip.includes(Buffer.from('indice.csv')));
  assert.ok(zip.includes(Buffer.from('AAA010101AAA/2026/' + UUID + '.xml')));
  /* Paquete mensual a mano para la contadora. */
  await call('/api/reports/config', { nora: { enabled: true, day: 3, hour: 9, recipients: 'nora@example.com' },
    weekly: { enabled: true, hour: 8, recipients: '' } });
  const sendNow = await (await call('/api/reports/send-now', { month: '2026-10' })).json();
  assert.equal(sendNow.counts.invoices, 1);
  const packMail = sent.find(mail => /Informe mensual 2026-10/.test(mail.subject));
  assert.ok(packMail);
  assert.equal(packMail.attachments[0].filename, 'PacoSAT-paquete-2026-10.zip');
  const packZip = packMail.attachments[0].content;
  assert.ok(packZip.includes(Buffer.from('base-diot.csv')));
  assert.ok(packZip.includes(Buffer.from('ppd-del-mes.csv')));
  /* Programados: lunes 7-dic 09:30 MX (=15:30Z) salen el resumen
     semanal y el informe del mes anterior (noviembre). */
  time = Date.parse('2026-12-07T15:30:00Z');
  await service.tick();
  assert.ok(sent.some(mail => /Resumen semanal/.test(mail.subject)));
  assert.ok(sent.some(mail => /Informe mensual 2026-11/.test(mail.subject)));
  log = await (await call('/api/mail/log')).json();
  assert.ok(log.sends.some(send => send.kind === 'weekly' && send.ok === 1));
  assert.ok(log.sends.some(send => send.kind === 'nora' && send.ok === 1));
  /* Y no se repiten en el siguiente ciclo del mismo periodo. */
  const before = sent.length;
  await service.tick();
  assert.equal(sent.length, before);
  console.log('outputs.test: ok');
} finally { await service.close(); }
