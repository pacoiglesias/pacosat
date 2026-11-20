/* 3.0 · Bloque D — el aviso de la cancelada y el
   recordatorio por cuenta.
   Comprobación de verdad (servidor): con una factura ya
   guardada y una suscripción push viva, cuando un paquete
   de metadatos la marca cancelada por primera vez sale UN
   aviso con su folio, su importe y su enlace profundo a la
   factura misma; la segunda pasada con el mismo estado NO
   repite. Sin factura guardada no hay aviso (nada que
   abrir). Y en el cliente: el recordatorio de estados en
   Hoy va cuenta por cuenta con su botón en la ventana
   1–10, y fuera de ella queda la fila resumen de siempre. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { createPacoSATService } from './local-server.mjs';
import { crc32 } from './xml-core.mjs';
import { DOMParser } from '@xmldom/xmldom';

const origin = 'http://127.0.0.1:43731';
const rfc = 'XAXX010101000', emitter = 'AAA010101AAA';
const uuidX = '32345678-1234-1234-1234-1234567890AB';
const xmlX = '<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital" Version="4.0" Serie="F" Folio="A-123" Fecha="2026-11-05T09:00:00" SubTotal="1000.00" Total="1160.00" Moneda="MXN" TipoDeComprobante="I"><cfdi:Emisor Rfc="' + emitter + '" Nombre="EMISOR SA"/><cfdi:Receptor Rfc="' + rfc + '" Nombre="RECEPTOR SA"/><cfdi:Conceptos><cfdi:Concepto Cantidad="1" ClaveProdServ="01010101" Descripcion="Prueba" ValorUnitario="1000.00" Importe="1000.00"/></cfdi:Conceptos><cfdi:Complemento><tfd:TimbreFiscalDigital Version="1.1" UUID="' + uuidX + '" FechaTimbrado="2026-11-05T09:01:00" SelloCFD="AAAAAAAAAA==" SelloSAT="BBBBBBBBBB=="/></cfdi:Complemento></cfdi:Comprobante>';
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
let estatus = '1';
const paqueteMeta = () => [cabecera,
  uuidX + '~' + emitter + '~EMISOR SA~' + rfc + '~RECEPTOR SA~2026-11-05T09:00:00~2026-11-05T09:01:00~SAT970701NN3~1160.00~I~' + estatus + '~' + (estatus === '0' ? '2026-11-07T10:00:00' : '')].join('\n');

let time = Date.parse('2026-11-08T16:00:00Z');
const pushes = [];
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
      return calls[i]?.type === 'metadata' ? archive(paqueteMeta(), 'metadata.txt') : archive(xmlX, 'factura.xml');
    }
  } }),
  makeMailer: () => ({ verify: async () => true, sendMail: async () => {} }),
  makePushSender: async (subscription, payload) => { pushes.push(payload); return { status: 201 }; }
});
let token;
async function call(path, data) {
  const headers = { host: new URL(origin).host, origin, 'x-pacosat-token': token, 'x-pacosat-proxy': 'clave-de-prueba-30' };
  const req = Object.assign(Readable.from(data === undefined ? [] : [Buffer.from(JSON.stringify(data))]), {
    url: path, method: data === undefined ? 'GET' : 'POST', headers });
  let status = 0, body = '';
  const res = { headers: {},
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    writeHead(code, hs) { status = code; Object.assign(this.headers, hs || {}); },
    end(chunk) { if (chunk) body += chunk; } };
  await service.handle(req, res);
  if (!token) { token = body.match(/<meta name="pacosat-token" content="([^"]+)">/)?.[1]; }
  return { status, json: async () => JSON.parse(body || '{}'), text: async () => body };
}
await call('/');
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(r => setImmediate(r)); };
const avanzar = async min => { time += min * 60000; await service.tick(); await flush(); };
await call('/api/mail', { recipient: 'paco@example.test', host: 'smtp.example.test', port: 587, user: 'u', password: 'p' });
await call('/api/unlock', { rfc, minutes: 600, days: 7, direction: 'received', password: 'simulated', certificate: 'YQ==', key: 'Yg==' });
await call('/api/monthly/config', { enabled: false });
await call('/api/push/subscribe', { endpoint: 'https://fcm.googleapis.com/fcm/send/prueba30',
  keys: { p256dh: 'B'.repeat(60), auth: 'a'.repeat(20) } });

/* 1 · Metadatos con la factura vigente, sin XML guardado:
   no hay aviso (no hay factura que abrir). */
await call('/api/request', { rfc, start: '2026-11-01', end: '2026-11-08', direction: 'received', type: 'metadata' });
await avanzar(5); await avanzar(5);
assert.equal(pushes.length, 0, 'Sin factura guardada no sale aviso de cancelada.');

/* 2 · Entra el XML por la vía masiva: la factura ya vive. */
await call('/api/request', { rfc, start: '2026-11-01', end: '2026-11-08', direction: 'received' });
await avanzar(5); await avanzar(5); await avanzar(5);
assert.equal(pushes.length, 0, 'La entrada del XML no avisa nada.');

/* 3 · Un paquete nuevo la marca cancelada: UN aviso con
   folio, importe y el enlace a la factura misma. */
estatus = '0';
await call('/api/request', { rfc, start: '2026-11-02', end: '2026-11-08', direction: 'received', type: 'metadata' });
await avanzar(5); await avanzar(5); await avanzar(5);
assert.equal(pushes.length, 1, 'La cancelación detectada avisa una sola vez.');
const aviso = pushes[0];
assert.match(aviso.title, /cancelada/i, 'El aviso dice qué pasó.');
assert.ok(aviso.body.includes('F-A-123'), 'El aviso nombra la factura por su folio: ' + aviso.body);
assert.ok(aviso.body.includes('$1,160.00'), 'El aviso nombra su importe: ' + aviso.body);
assert.equal(aviso.url, '/#/facturas?uuid=' + uuidX, 'El aviso abre la factura misma (enlace profundo de la casa).');

/* 4 · Otra pasada con el mismo estado: silencio. */
await call('/api/request', { rfc, start: '2026-11-03', end: '2026-11-08', direction: 'received', type: 'metadata' });
await avanzar(5); await avanzar(5); await avanzar(5);
assert.equal(pushes.length, 1, 'La misma cancelación no se avisa dos veces.');

/* Cliente: el recordatorio por cuenta y la rejilla/cifras
   ya probadas en C; aquí, la pieza D de Hoy. */
const problemas = await readFile(new URL('./problemas-ui.part', import.meta.url), 'utf8');
assert.ok(problemas.includes('Subir o fotografiar'), 'Cada cuenta faltante lleva su botón de subir o fotografiar.');
assert.ok(problemas.includes('estadoCuenta30'), 'Cada botón nombra su cuenta.');
assert.ok(problemas.includes('p.enVentana'), 'La vista por cuenta vive en la ventana del 1 al 10; fuera queda la fila resumen.');
const banks = await readFile(new URL('./banks-ui.part', import.meta.url), 'utf8');
assert.ok(banks.includes("setAttribute('capture', 'environment')"), 'La subida en Bancos abre la cámara del móvil.');

await service.close();
console.log('OK 3.0-D: la cancelada avisa una vez con folio, importe y su enlace; el recordatorio de estados va por cuenta con su botón.');
