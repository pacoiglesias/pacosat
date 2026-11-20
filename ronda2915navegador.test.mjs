import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { DOMParser } from '@xmldom/xmldom';
import { createPacoSATService } from './local-server.mjs';
import { chromium } from 'playwright-core';

/* ================================================================
   Ronda 2.9.15 · NAVEGADOR (Bloque B) — el lote gráfico de Paco
   en Chromium real, a ancho de escritorio y de móvil:

   (B1) Hoy abre con la franja «Requiere tu atención» como
       primer panel cuando Salud sabe de algo en vigía (aquí:
       ningún aparato suscrito a avisos push), con su chip del
       sistema único (icono + «Pendiente») y su botón lleva a
       Salud, su pantalla dueña.
   (B6) El menú enseña los cinco grupos por tarea en orden y
       el grupo de la sección actual queda señalado.
   (B3) Facturas: cabeceras en orden clave (fecha, contraparte,
       folio, importe, estado, tipo) y, en móvil, los filtros
       se ven sin tocar «Filtrar».
   (B4) Las píldoras de estado enseñan icono (::before) +
       etiqueta + color, y el chip canónico supera el contraste
       4.5:1 entre su tinta y su fondo.
   (B7) En móvil: acción primaria y barra inferior con áreas
       de toque de al menos 44px, y el foco de teclado pinta
       su contorno visible.
   ================================================================ */
const AQUI = dirname(fileURLToPath(import.meta.url));
const executablePath = [join(homedir(), '.cache/ms-playwright/chromium-1248/chrome-linux64/chrome'),
  join(homedir(), '.cache/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell')]
  .find(p => { try { return readFileSync(p) && true; } catch { return false; } });
if (!executablePath && process.env.CI) {
  console.log('OMITIDA EN CI: sin Chromium de Playwright en este entorno; la prueba de navegador real corre en la máquina de Paco (diseño e872570).');
  process.exit(0);
}
assert.ok(executablePath, 'Chromium de Playwright disponible');

const KEY = 'd'.repeat(64);
const OWN = 'AAA010101AAA';
const PROV1 = 'BBB020202BBB';
const TIME = Date.parse('2026-11-19T16:00:00Z');
const espera = ms => new Promise(r => setTimeout(r, ms));

let service = null;
const server = createServer((req, res) => { req.headers['x-pacosat-proxy'] = KEY; service.handle(req, res); });
await new Promise(r => server.listen(0, '127.0.0.1', r));
const ORIGIN = 'http://127.0.0.1:' + server.address().port;
const dir = mkdtempSync(join(tmpdir(), 'pacosat-2915-nav-'));
const dbFile = join(dir, 'pacosat.sqlite');
const makeService = () => createPacoSATService({
  dbFile, html: readFileSync(join(AQUI, 'Faro-Fiscal.html'), 'utf8'),
  lazyParts: JSON.parse(readFileSync(join(AQUI, 'lazy.json'), 'utf8')),
  capacidades: JSON.parse(readFileSync(join(AQUI, 'capacidades.json'), 'utf8')),
  origin: ORIGIN, proxyKey: KEY, satDocRetryWaitMs: 5,
  makeConnector: () => ({ parser: DOMParser, connector: {
    request: async () => 'req-nav', check: async () => ({ status: 'pending', packages: [] }),
    download: async () => { throw new Error('sin paquetes'); } } }),
  makeMailer: () => ({ verify: async () => true, sendMail: async () => ({ messageId: 'm1' }) }),
  now: () => TIME });

{
  service = makeService(); service.close();
  const db = new DatabaseSync(dbFile);
  db.prepare('INSERT INTO profiles(rfc, minutes, days, direction, nextRun, error) VALUES (?,?,?,?,?,?)')
    .run(OWN, 1440, 30, 'both', 0, '');
  db.prepare("INSERT INTO records(store,id,value) VALUES ('people',?,?)")
    .run(OWN, JSON.stringify({ id: OWN, name: 'Empresa de Prueba, S.A.' }));
  const inv = { id: '11111111-2222-3333-4444-555555555555', date: '2026-11-05', kind: 'I',
    from: { rfc: PROV1, name: 'EMPRESA ' + PROV1 }, to: { rfc: OWN, name: 'EMPRESA ' + OWN },
    total: '1160.00', currency: 'MXN', fiscal: { series: 'A', folio: '100', paymentMethod: 'PPD',
      transferred: [{ tax: '002', rate: '0.160000', amount: '0.00' }], withheld: [] } };
  db.prepare("INSERT INTO records(store,id,value) VALUES ('invoices',?,?)")
    .run(inv.id, JSON.stringify(inv));
  db.close();
}
service = makeService();
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
await call('POST', '/api/unlock', { rfc: OWN, minutes: 1440, days: 7, direction: 'both',
  password: 'simulated', certificate: 'YQ==', key: 'Yg==' });

const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.goto(ORIGIN + '/', { waitUntil: 'load' });
await page.waitForFunction(() => typeof navigate === 'function' && typeof satToken !== 'undefined' && Boolean(satToken), null, { timeout: 15000 });
await page.evaluate(rfc => { scope = rfc; }, OWN);

/* ── (B1) La franja abre Hoy y su botón lleva a Salud ───────
   RE-BASE 2.9.16 (Punto 2): la franja vive dentro de «Tus
   tareas», el panel que abre Hoy (conserva la clase
   atencion2915); la fila de Salud sigue llevando a Salud. */
await page.evaluate(() => navigate('home'));
await page.waitForSelector('.atencion2915', { timeout: 15000 });
const franja = await page.evaluate(() => {
  const strip = document.querySelector('.atencion2915');
  const paneles = [...document.querySelectorAll('main .panel')];
  const chip = strip.querySelector('.estado2915');
  return { esPrimera: paneles[0] === strip,
    texto: strip.textContent,
    chipClase: chip?.className || '', chipTexto: chip?.textContent.trim() || '',
    chipTieneSvg: Boolean(chip?.querySelector('svg')) };
});
assert.ok(franja.esPrimera, '«Tus tareas» (con la franja dentro) es el primer panel de Hoy');
assert.ok(franja.texto.includes('Avisos en tus aparatos'), 'la franja trae la tarjeta en vigía de Salud (push)');
assert.ok(franja.chipClase.includes('estado-pendiente'), 'la fila lleva el chip canónico de pendiente');
assert.equal(franja.chipTexto, 'Pendiente', 'el chip dice su estado en palabras');
assert.ok(franja.chipTieneSvg, 'el chip lleva icono además de color y texto');

/* (B4) Contraste del chip: tinta sobre fondo ≥ 4.5:1. */
const contraste = await page.evaluate(() => {
  const chip = document.querySelector('.atencion2915 .estado2915');
  const cs = getComputedStyle(chip);
  const rgb = s => s.match(/[\d.]+/g).slice(0, 3).map(Number);
  const lum = ([r, g, b]) => {
    const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const l1 = lum(rgb(cs.color)), l2 = lum(rgb(cs.backgroundColor));
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
});
assert.ok(contraste >= 4.5, 'contraste del chip de estado ≥ 4.5:1 (medido: ' + contraste.toFixed(2) + ':1)');

/* El botón de la fila de Salud (la de los avisos push), no el
   primero del panel: en la 2.9.16 el panel abre con los gestos. */
await page.evaluate(() => {
  const fila = [...document.querySelectorAll('.atencion2915 .atencion-fila2915')]
    .find(f => f.textContent.includes('Avisos en tus aparatos'));
  fila?.querySelector('button')?.click();
});
await page.waitForFunction(() => typeof page !== 'undefined' && page === 'salud', null, { timeout: 10000 })
  .catch(() => page.waitForFunction(() => document.querySelector('main').textContent.includes('Centro de salud') || document.querySelector('main').textContent.includes('Salud'), null, { timeout: 5000 }));
assert.equal(await page.evaluate(() => page), 'salud', 'el botón de la franja lleva a Salud, su pantalla dueña');

/* ── (B6) Grupos del menú y grupo activo ──────────────────── */
const menu = await page.evaluate(() => {
  const captions = [...document.querySelectorAll('.sidebar .nav-caption')]
    .map(c => c.textContent.trim().replace(/\s*[▸▾]\s*$/, ''));
  const destinos = document.querySelectorAll('.sidebar nav [data-view]').length;
  return { captions, destinos };
});
assert.deepEqual(menu.captions, ['TRABAJO DIARIO', 'SAT', 'EXPEDIENTE', 'ADMINISTRACIÓN', 'MÁS'],
  'el menú enseña los cuatro grupos de la 2.9.16 y el grupo «Más»');
assert.equal(menu.destinos, 22, 'los 22 destinos siguen en el menú (3.1.0: los 21 de siempre + Administración, visible por orden expresa; ninguno perdido)');
await page.evaluate(() => navigate('invoices'));
await espera(600);
const grupoActivo = await page.evaluate(() =>
  [...document.querySelectorAll('.sidebar .nav-caption')].map(c => [c.textContent.trim().replace(/\s*[▸▾]\s*$/, ''), c.classList.contains('nav-caption-on2915')]));
assert.deepEqual(grupoActivo.filter(([, on]) => on).map(([nombre]) => nombre), ['TRABAJO DIARIO'],
  'en Facturas, el grupo señalado es TRABAJO DIARIO');

/* ── (B3/B4) Facturas en escritorio: cabeceras y píldoras ─── */
await page.waitForSelector('.grid-table', { timeout: 10000 });
const cabeceras = await page.evaluate(() =>
  [...document.querySelectorAll('.grid-table th')].map(th => th.textContent.replace(/ [↓↑]$/, '').trim()));
assert.deepEqual(cabeceras, ['', 'Fecha', 'Emisor → receptor', 'Folio', 'Total', 'Estado SAT', 'Acción'],
  'columnas clave primero en Facturas (RE-BASE 2.9.16: «Tipo» vive en la ficha lateral)');
const pill = await page.evaluate(() => {
  const p = document.querySelector('.status-pill[data-state="warn"]');
  if (!p) return null;
  const before = getComputedStyle(p, '::before');
  return { texto: p.textContent.trim(), mascara: before.maskImage || before.webkitMaskImage || '' };
});
assert.ok(pill && pill.texto.length > 0, 'la píldora de estado enseña su etiqueta');
assert.ok(pill.mascara && pill.mascara !== 'none', 'la píldora enseña su icono (::before con máscara), nunca el color a solas');

/* ── (B7/B3) Móvil: filtros a la vista y toques de 44px ───── */
await page.setViewportSize({ width: 390, height: 844 });
await page.evaluate(() => navigate('invoices'));
await espera(1200);
const movil = await page.evaluate(() => {
  const buscador = document.querySelector('.invoice-filters input');
  const caja = buscador?.getBoundingClientRect();
  const primaria = [...document.querySelectorAll('button.primary')]
    .find(b => b.getBoundingClientRect().height > 0);
  const barra = document.querySelector('.bottombar');
  const botonBarra = barra?.querySelector('button');
  return { buscadorVisible: Boolean(caja && caja.height > 0 && caja.width > 0),
    primariaAlto: primaria ? primaria.getBoundingClientRect().height : 0,
    barraVisible: Boolean(barra && barra.getBoundingClientRect().height > 0),
    barraBotonAlto: botonBarra ? botonBarra.getBoundingClientRect().height : 0 };
});
assert.ok(movil.buscadorVisible, 'en móvil el buscador de Facturas se ve sin tocar «Filtrar»');
assert.ok(movil.primariaAlto >= 44, 'la acción primaria mide ≥44px de alto (medido: ' + movil.primariaAlto + ')');
assert.ok(movil.barraVisible && movil.barraBotonAlto >= 44,
  'la barra inferior móvil y sus botones miden ≥44px (medido: ' + movil.barraBotonAlto + ')');

/* (B7) Foco de teclado visible: Tab hasta un botón y su
   contorno :focus-visible está pintado. */
await page.evaluate(() => navigate('home'));
await espera(800);
let focoVisible = false;
for (let i = 0; i < 40 && !focoVisible; i++) {
  await page.keyboard.press('Tab');
  focoVisible = await page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return false;
    const cs = getComputedStyle(el);
    return cs.outlineStyle === 'solid' && parseFloat(cs.outlineWidth) >= 2;
  });
}
assert.ok(focoVisible, 'al navegar con Tab, algún elemento enseña el contorno de foco visible');

await browser.close();
service.close(); server.close();
console.log('ronda2915navegador: franja de Hoy en vivo, menú por tarea, columnas, contraste, toque y foco verificados en Chromium real.');
