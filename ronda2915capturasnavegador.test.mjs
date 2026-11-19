import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOMParser } from '@xmldom/xmldom';
import { createPacoSATService } from './local-server.mjs';
import { chromium } from 'playwright-core';

/* ================================================================
   Ronda 2.9.15 · Bloque C — NAVEGADOR REAL: la figura de la
   guía de Ayuda en sus dos estados, con la app viva (Chromium
   real + app de harness, como ronda2914navegador):

   · captura-hoy.png SÍ está colocada en el directorio de datos
     temporal → su figura enseña la IMAGEN real (un <img> con la
     captura cargada, naturalWidth > 0) y su figcaption de
     siempre; el hueco diseñado ya no está en esa figura.
   · captura-buzon.png NO está colocada → su figura conserva el
     hueco diseñado de la 2.9.13, intacto, y ningún <img>.

   La imagen llega por fetch con la sesión de la casa y se
   enseña como blob: — la CSP (img-src data: blob:) no admite
   un <img> directo al mismo origen; esta prueba corre bajo
   esa CSP real del servidor, así que si la imagen se ve, la
   vía es la buena.

   Puerta solo-bajo-CI (diseño e872570): sin Chromium de
   Playwright y bajo CI, la prueba se omite con constancia
   impresa y exit 0.
   ================================================================ */

const AQUI = dirname(fileURLToPath(import.meta.url));
const KEY = 'f'.repeat(64);
const OWN = 'AAA010101AAA';
const TIME = Date.parse('2026-11-19T15:00:00Z');
const PNG_PRUEBA = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64');

const dir = mkdtempSync(join(tmpdir(), 'pacosat-2915-nav-'));
const dbFile = join(dir, 'pacosat.sqlite');
const capturasDir = join(dir, 'capturas-prueba');
mkdirSync(capturasDir);
writeFileSync(join(capturasDir, 'captura-hoy.png'), PNG_PRUEBA);

let service = null;
const server = createServer((req, res) => { req.headers['x-pacosat-proxy'] = KEY; service.handle(req, res); });
await new Promise(r => server.listen(0, '127.0.0.1', r));
const ORIGIN = 'http://127.0.0.1:' + server.address().port;
service = createPacoSATService({
  dbFile, html: readFileSync(join(AQUI, 'Faro-Fiscal.html'), 'utf8'),
  lazyParts: JSON.parse(readFileSync(join(AQUI, 'lazy.json'), 'utf8')),
  capacidades: JSON.parse(readFileSync(join(AQUI, 'capacidades.json'), 'utf8')),
  origin: ORIGIN, proxyKey: KEY, capturasDir,
  makeConnector: () => ({ parser: DOMParser, connector: {
    request: async () => 'req-2915', check: async () => ({ status: 'pending', packages: [] }),
    download: async () => { throw new Error('sin paquetes'); } } }),
  makeMailer: () => ({ verify: async () => true, sendMail: async () => ({ messageId: 'm1' }) }),
  now: () => TIME });

let token = '';
const raw = async (method, path, bodyText, extraHeaders = {}) => {
  const chunks = []; if (bodyText) chunks.push(Buffer.from(String(bodyText)));
  const req = Readable.from(chunks); req.method = method; req.url = path;
  req.headers = { host: new URL(ORIGIN).host, origin: ORIGIN, 'x-pacosat-proxy': KEY, ...extraHeaders };
  let status = 0; const headers = {}; let text = '';
  const res = { writeHead(c, h) { status = c; if (h) Object.assign(headers, h); },
    setHeader(k, v) { headers[k] = v; }, getHeader(k) { return headers[k]; },
    end(ch) { if (ch) text += Buffer.isBuffer(ch) ? ch.toString('latin1') : ch; } };
  await service.handle(req, res); return { status, text, headers };
};
const call = async (method, path, body) => {
  if (!token) { const home = await raw('GET', '/'); token = /[0-9a-f]{64}/.exec(home.text)?.[0] || ''; }
  const r = await raw(method, path, body === undefined ? undefined : JSON.stringify(body), { 'x-pacosat-token': token });
  let json = null; try { json = JSON.parse(r.text); } catch { /* binario */ }
  return { status: r.status, json, text: r.text };
};
await call('POST', '/api/storage', { batch: { people: [{ id: OWN, name: 'Empresa de Prueba, S.A.' }] } });

const executablePath = [join(homedir(), '.cache/ms-playwright/chromium-1248/chrome-linux64/chrome'),
  join(homedir(), '.cache/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell')]
  .find(p => existsSync(p));
if (!executablePath && process.env.CI) {
  console.log('OMITIDA EN CI: sin Chromium de Playwright en este entorno; la prueba de navegador real corre en la máquina de Paco (diseño e872570).');
  process.exit(0);
}
assert.ok(executablePath, 'Chromium de Playwright disponible');
const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
let page;
try {
  page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(ORIGIN + '/', { waitUntil: 'load' });
  await page.waitForFunction(() => typeof navigate === 'function' && typeof satToken !== 'undefined' && Boolean(satToken),
    null, { timeout: 15000 });
  await page.evaluate(() => navigate('capacidades'));
  /* La figura de Hoy: la captura colocada sustituye al hueco. */
  await page.waitForSelector('figure[data-captura="captura-hoy.png"] img[data-captura-real2915]', { timeout: 15000 });
  await page.waitForFunction(() => {
    const img = document.querySelector('figure[data-captura="captura-hoy.png"] img[data-captura-real2915]');
    return Boolean(img) && img.complete && img.naturalWidth > 0;
  }, null, { timeout: 15000 });
  /* Dar tiempo a que las demás figuras resuelvan su 404. */
  await page.waitForTimeout(1200);
  const estado = await page.evaluate(() => {
    const figura = nombre => document.querySelector('figure[data-captura="' + nombre + '"]');
    const hoy = figura('captura-hoy.png');
    const buzon = figura('captura-buzon.png');
    return {
      hoyImg: Boolean(hoy?.querySelector('img[data-captura-real2915="captura-hoy.png"]')),
      hoyHueco: Boolean(hoy?.querySelector('.ayuda-captura-hueco2913')),
      hoyPie: hoy?.querySelector('figcaption')?.textContent || '',
      buzonImg: Boolean(buzon?.querySelector('img')),
      buzonHueco: buzon?.querySelector('.ayuda-captura-hueco2913')?.textContent || '',
      buzonPie: buzon?.querySelector('figcaption')?.textContent || '' };
  });
  assert.equal(estado.hoyImg, true, '(N) la figura de Hoy enseña la imagen real colocada tras el montaje');
  assert.equal(estado.hoyHueco, false, '(N) y su hueco diseñado ya no ocupa el sitio');
  assert.ok(estado.hoyPie.startsWith('Hoy — '), '(N) con su figcaption de siempre: «' + estado.hoyPie + '»');
  assert.equal(estado.buzonImg, false, '(N) la figura sin captura colocada no enseña ninguna imagen');
  assert.equal(estado.buzonHueco, 'Captura: Buzón Tributario',
    '(N) y conserva su hueco diseñado intacto: «' + estado.buzonHueco + '»');
  assert.ok(estado.buzonPie.startsWith('Buzón Tributario — '), '(N) también con su figcaption');
  console.log('OK 2.9.15-capturas-navegador · (N) — con PNG colocada, la figura enseña la imagen real; sin ella, el hueco diseñado intacto.');
} finally {
  await browser.close().catch(() => {});
  server.close();
  service.close();
}
