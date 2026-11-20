/* Capturas de la build 3.0 (escritorio y móvil) — NO es una
   suite: genera los PNG que el informe de la ronda enseña.
   Sirve la app real (modo cloud, como el NAS) con un perfil
   sembrado y la corrida «Ponerme al día» ya hecha, para que
   Hoy y Descargar enseñen su estado verdadero. */
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { DOMParser } from '@xmldom/xmldom';
import { chromium } from 'playwright-core';
import { createPacoSATService } from './local-server.mjs';
import { crc32 } from './xml-core.mjs';

const KEY = 'f'.repeat(64);
let ORIGIN = '';
const rfc = 'XAXX010101000', emitter = 'AAA010101AAA';
const uuidPortal = '72345678-1234-1234-1234-1234567890AB';
const uuidFalta = '82345678-1234-1234-1234-1234567890AB';
const xmlDe = (uuid, folio, total) => '<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital" Version="4.0" Serie="F" Folio="' + folio + '" Fecha="2026-11-05T09:00:00" SubTotal="1000.00" Total="' + total + '" Moneda="MXN" TipoDeComprobante="I"><cfdi:Emisor Rfc="' + emitter + '" Nombre="EMISOR SA"/><cfdi:Receptor Rfc="' + rfc + '" Nombre="RECEPTOR SA"/><cfdi:Conceptos><cfdi:Concepto Cantidad="1" ClaveProdServ="01010101" Descripcion="Prueba" ValorUnitario="1000.00" Importe="1000.00"/></cfdi:Conceptos><cfdi:Complemento><tfd:TimbreFiscalDigital Version="1.1" UUID="' + uuid + '" FechaTimbrado="2026-11-05T09:01:00" SelloCFD="AAAAAAAAAA==" SelloSAT="BBBBBBBBBB=="/></cfdi:Complemento></cfdi:Comprobante>';
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
const metadataText = [cabecera,
  uuidPortal + '~' + emitter + '~EMISOR SA~' + rfc + '~RECEPTOR SA~2026-11-05T09:00:00~2026-11-05T09:01:00~SAT970701NN3~1160.00~I~1~',
  uuidFalta + '~' + rfc + '~RECEPTOR SA~' + emitter + '~EMISOR SA~2026-11-06T10:00:00~2026-11-06T10:01:00~SAT970701NN3~500.00~I~1~'].join('\n');

const dir = mkdtempSync(join(tmpdir(), 'pacosat-30-capturas-'));
const html = readFileSync(new URL('./Faro-Fiscal.html', import.meta.url), 'utf8');
let time = Date.parse('2026-11-20T16:00:00Z');
const calls = [];
let counter = 0;
let service = null;
const server = createServer((req, res) => { req.headers['x-pacosat-proxy'] = KEY; service.handle(req, res); });
await new Promise(r => server.listen(0, '127.0.0.1', r));
ORIGIN = 'http://127.0.0.1:' + server.address().port;
service = createPacoSATService({
  dbFile: join(dir, 'pacosat.sqlite'), html, origin: ORIGIN, proxyKey: KEY, now: () => time,
  lazyParts: JSON.parse(readFileSync(new URL('./lazy.json', import.meta.url), 'utf8')),
  capacidades: JSON.parse(readFileSync(new URL('./capacidades.json', import.meta.url), 'utf8')),
  makeConnector: async () => ({ parser: DOMParser, connector: {
    request: async options => { calls.push(options); return 'request-' + (++counter); },
    check: async id => ({ status: 'finished', packages: [id + '-pkg'] }),
    download: async packageId => {
      const i = Number(packageId.replace('request-', '').replace('-pkg', '')) - 1;
      return calls[i]?.type === 'metadata' ? archive(metadataText, 'metadata.txt') : archive('<fixture/>', 'x.xml');
    }
  } }),
  satPortalFetch: async (who, { items }) => {
    const files = items.filter(it => it.uuid === uuidPortal)
      .map(it => ({ uuid: it.uuid, buffer: Buffer.from(xmlDe(it.uuid, 'A-100', '1160.00')) }));
    return { files, found: items.length, downloaded: files.length, quotaUsed: files.length, notes: [], complete: false };
  },
  makeMailer: () => ({ verify: async () => true, sendMail: async () => {} })
});
let token;
async function call(path, data) {
  const headers = { host: new URL(ORIGIN).host, origin: ORIGIN, 'x-pacosat-token': token, 'x-pacosat-proxy': KEY };
  const req = Object.assign(Readable.from(data === undefined ? [] : [Buffer.from(JSON.stringify(data))]), {
    url: path, method: data === undefined ? 'GET' : 'POST', headers });
  let status = 0, body = '';
  const res = { setHeader() {}, writeHead(code) { status = code; }, end(chunk) { if (chunk) body += chunk; } };
  await service.handle(req, res);
  return { status, json: async () => JSON.parse(body || '{}'), text: async () => body };
}
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(r => setImmediate(r)); };
token = (await (await call('/')).text()).match(/<meta name="pacosat-token" content="([^"]+)">/)?.[1];
await call('/api/mail', { host: 'smtp.example.com', port: 587, from: 'from@example.com', recipient: 'to@example.com', user: '', password: '' });
const unlockRes = await call('/api/unlock', { rfc, minutes: 1440, days: 7, direction: 'received', password: 'simulated', certificate: 'YQ==', key: 'Yg==' });
if (unlockRes.status !== 200) throw new Error('La semilla no pudo desbloquear el RFC: ' + unlockRes.status);
await call('/api/monthly/config', { enabled: false, day: 5, hour: 9 });
await call('/api/storage', { batch: { people: [{ id: rfc, name: 'CONTRIBUYENTE SA' }, { id: emitter, name: 'ZZZ EMISOR SA' }] } });
const runRes = await call('/api/al-dia/run', { rfc });
if (runRes.status !== 200) throw new Error('La semilla no pudo lanzar la corrida: ' + runRes.status);
for (let i = 0; i < 20; i++) {
  time += 5 * 60000; await service.tick(); await flush();
  const st = await (await call('/api/al-dia/state?rfc=' + rfc)).json();
  if (!st.running && st.fin) break;
}

const executablePath = join(homedir(), '.cache/ms-playwright/chromium-1248/chrome-linux64/chrome');
const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
const out = new URL('./capturas-30/', import.meta.url).pathname;
mkdirSync(out, { recursive: true });
const base = ORIGIN + '/';
async function captura(nombre, viewport, irDescargar) {
  const page = await browser.newPage({ viewport });
  await page.goto(base, { waitUntil: 'networkidle' }).catch(() => {});
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-aldia30-veredicto]');
    return el && el.textContent && !el.textContent.includes('Revisando');
  }, { timeout: 15000 }).catch(() => {});
  if (irDescargar) {
    const selector = viewport.width <= 860 ? '.bottombar [data-view="descargar"]' : '.sidebar [data-view="descargar"]';
    await page.click(selector);
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-aldia30-veredicto]');
      return el && el.textContent && !el.textContent.includes('Revisando');
    }, { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1200);
  }
  await page.screenshot({ path: join(out, nombre), fullPage: false });
  await page.close();
  console.log('captura:', nombre);
}
await captura('hoy-escritorio.png', { width: 1280, height: 800 }, false);
await captura('descargar-escritorio.png', { width: 1280, height: 800 }, true);
await captura('hoy-movil.png', { width: 390, height: 844 }, false);
await captura('descargar-movil.png', { width: 390, height: 844 }, true);
await browser.close();
server.close();
await service.close();
console.log('Capturas en', out);
