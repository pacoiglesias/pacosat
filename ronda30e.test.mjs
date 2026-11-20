/* 3.0 · Bloque E — confianza: el origen se prueba, el
   fallo se cuenta en llano y el vacío enseña su paso.
   Comprobación de verdad (servidor): la factura que entra
   por el caminante queda sellada origin='portal' con su
   hora, y la que entra por la vía masiva, origin='descarga'
   con la suya — la ficha puede decir «Traída por el portal
   hoy a las…» sin inventar. En el cliente: la ficha pinta
   esa línea, el fallo del caminante sale con de quién es /
   qué significa / el gesto y su detalle técnico plegado, y
   los vacíos nuevos enseñan el siguiente paso con botón. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { createPacoSATService } from './local-server.mjs';
import { crc32 } from './xml-core.mjs';
import { DOMParser } from '@xmldom/xmldom';

const origin = 'http://127.0.0.1:43733';
const rfc = 'XAXX010101000', emitter = 'AAA010101AAA';
const uuidPortal = '42345678-1234-1234-1234-1234567890AB';
const uuidMasiva = '52345678-1234-1234-1234-1234567890AB';
const xmlDe = (uuid, folio) => '<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital" Version="4.0" Serie="F" Folio="' + folio + '" Fecha="2026-11-05T09:00:00" SubTotal="1000.00" Total="1160.00" Moneda="MXN" TipoDeComprobante="I"><cfdi:Emisor Rfc="' + emitter + '" Nombre="EMISOR SA"/><cfdi:Receptor Rfc="' + rfc + '" Nombre="RECEPTOR SA"/><cfdi:Conceptos><cfdi:Concepto Cantidad="1" ClaveProdServ="01010101" Descripcion="Prueba" ValorUnitario="1000.00" Importe="1000.00"/></cfdi:Conceptos><cfdi:Complemento><tfd:TimbreFiscalDigital Version="1.1" UUID="' + uuid + '" FechaTimbrado="2026-11-05T09:01:00" SelloCFD="AAAAAAAAAA==" SelloSAT="BBBBBBBBBB=="/></cfdi:Complemento></cfdi:Comprobante>';
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
const cabecera = 'Uuid~RfcEmisor~NombreEmisor~RfcReceptor~NombreReceptor~FechaEmision~FechaCertificacion~PacCertifico~Monto~EfectoComprobante~Estatus~FechaCancelacion';
const filaMeta = (uuid, folio) => uuid + '~' + emitter + '~EMISOR SA~' + rfc + '~RECEPTOR SA~2026-11-05T09:00:00~2026-11-05T09:01:00~SAT970701NN3~1160.00~I~1~';
const metadataText = [cabecera, filaMeta(uuidPortal), filaMeta(uuidMasiva)].join('\n');

let time = Date.parse('2026-11-08T16:00:00Z');
const calls = [];
let counter = 0;
const service = createPacoSATService({
  dbFile: ':memory:', html: '<!--PACOSAT_TOKEN-->', origin, now: () => time,
  proxyKey: 'clave-de-prueba-30',
  makeConnector: async () => ({ parser: DOMParser, connector: {
    request: async options => { calls.push(options); return 'request-' + (++counter); },
    check: async id => ({ status: 'finished', packages: [id + '-pkg'] }),
    download: async packageId => {
      const i = Number(packageId.replace('request-', '').replace('-pkg', '')) - 1;
      if (calls[i]?.type === 'metadata') return archive(metadataText, 'metadata.txt');
      return archive(xmlDe(uuidMasiva, 'A-200'), 'masiva.xml');
    }
  } }),
  satPortalFetch: async (who, { items }) => {
    const files = items.filter(it => it.uuid === uuidPortal)
      .map(it => ({ uuid: it.uuid, buffer: Buffer.from(xmlDe(it.uuid, 'A-100')) }));
    return { files, found: items.length, downloaded: files.length, quotaUsed: files.length, notes: [], complete: false };
  },
  makeMailer: () => ({ verify: async () => true, sendMail: async () => {} })
});
let token;
async function call(path, data) {
  const headers = { host: new URL(origin).host, origin, 'x-pacosat-token': token, 'x-pacosat-proxy': 'clave-de-prueba-30' };
  const req = Object.assign(Readable.from(data === undefined ? [] : [Buffer.from(JSON.stringify(data))]), {
    url: path, method: data === undefined ? 'GET' : 'POST', headers });
  let status = 0, body = '';
  const res = { setHeader() {}, writeHead(code) { status = code; }, end(chunk) { if (chunk) body += chunk; } };
  await service.handle(req, res);
  return { status, json: async () => JSON.parse(body || '{}'), text: async () => body };
}
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(r => setImmediate(r)); };
const avanzar = async min => { time += min * 60000; await service.tick(); await flush(); };
token = (await (await call('/')).text()).match(/<meta name="pacosat-token" content="([^"]+)">/)?.[1];
await call('/api/mail', { host: 'smtp.example.com', port: 587, from: 'from@example.com', recipient: 'to@example.com', user: '', password: '' });
await call('/api/unlock', { rfc, minutes: 600, days: 7, direction: 'received', password: 'simulated', certificate: 'YQ==', key: 'Yg==' });
await call('/api/monthly/config', { enabled: false, day: 5, hour: 9 });
/* La app real siempre tiene a sus contribuyentes
   sincronizados en el servidor (la tienda people): la
   ingesta del portal los exige para aceptar un XML, igual
   que en producción. Se siembran como los sincroniza el
   cliente. */
await call('/api/storage', { batch: { people: [
  { id: rfc, name: 'RECEPTOR SA' }, { id: emitter, name: 'EMISOR SA' } ] } });

/* La corrida entera: el portal trae uuidPortal y la masiva
   queda pedida para uuidMasiva. */
await call('/api/al-dia/run', { rfc });
for (let i = 0; i < 16; i++) { await avanzar(5); const st = await (await call('/api/al-dia/state?rfc=' + rfc)).json(); if (!st.running && st.fin) break; }
await avanzar(5); await avanzar(5); await avanzar(5); await avanzar(5);
const storage = await (await call('/api/storage?store=invoices')).json();
const invoices = Array.isArray(storage) ? storage : (storage.rows || storage.invoices || []);
const delPortal = invoices.find(r => r.id === uuidPortal);
const deMasiva = invoices.find(r => r.id === uuidMasiva);
assert.ok(delPortal, 'La factura del portal está guardada.');
assert.equal(delPortal.origin, 'portal', 'Su sello dice la vía verdadera: el portal.');
assert.ok(delPortal.originAt && !Number.isNaN(Date.parse(delPortal.originAt)), 'Su sello lleva la hora de entrada.');
assert.ok(deMasiva, 'La factura de la vía masiva está guardada.');
assert.equal(deMasiva.origin, 'descarga', 'Su sello dice la vía verdadera: la petición al SAT.');
assert.ok(deMasiva.originAt, 'Su sello también lleva la hora.');

/* La cobertura no se rompe con la vía nueva: el portal
   cuenta como descarga del SAT (no «sin clasificar»). */
const status = await (await call('/api/status')).json();
const grupo = (status.coverage?.records || []).find(g => g.rfc === rfc);
assert.ok(grupo, 'La cobertura por registros existe para el RFC.');
const mes = grupo.months.find(m => m.month === '2026-11');
assert.ok(mes && mes.descarga >= 2 && !mes.sinClasificar, 'Portal y masiva cuentan como descarga en cobertura: ' + JSON.stringify(mes));

/* Cliente: la ficha, el fallo en llano y los vacíos. */
const html = await readFile(new URL('./Faro-Fiscal.html', import.meta.url), 'utf8');
assert.ok(html.includes('Traída por el portal del SAT'), 'La ficha dice el origen del portal en llano.');
assert.ok(html.includes('Traída por una petición al SAT'), 'La ficha dice el origen de la petición en llano.');
assert.ok(html.includes('hoy a las '), 'La ficha dice «hoy a las…» cuando la entrada es de hoy.');
assert.ok(html.includes('origen30'), 'La línea de origen lleva su marca.');
assert.ok(html.includes('function portalFallaLlana30('), 'El fallo del caminante tiene su traductor a llano.');
assert.ok(html.includes('Se acabó el cupo del portal por hoy'), 'El fallo de cupo se cuenta en llano.');
assert.ok(html.includes('Ver detalle'), 'El motivo técnico queda tras «Ver detalle».');
assert.ok(html.includes('portalFalla30'), 'La línea de fallo lleva su marca en el progreso del portal.');
const coverage = await readFile(new URL('./coverage-ui.part', import.meta.url), 'utf8');
assert.ok(coverage.includes('No falta nada por traer') && coverage.includes('Aún no se ha revisado'),
  'El vacío de la rejilla enseña su estado y su siguiente paso.');
const ui = await readFile(new URL('./ui.part', import.meta.url), 'utf8');
assert.ok(ui.includes('Aún no hay un RFC dado de alta'), 'La tarjeta sin RFC enseña el paso que falta, no un error.');

await service.close();
console.log('OK 3.0-E: el origen queda sellado por vía y hora en el servidor y se dice en la ficha; el fallo se cuenta en llano y los vacíos enseñan su paso.');
