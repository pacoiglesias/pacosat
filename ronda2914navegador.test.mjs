import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { DOMParser } from '@xmldom/xmldom';
import { createPacoSATService } from './local-server.mjs';
import { detalleComunicadoSource, leerDestinoEnlaceSource, buzonEnlacePuntero2914 } from './sat-tributario.mjs';
import { chromium } from 'playwright-core';

/* ================================================================
   Ronda 2.9.14 · NAVEGADOR REAL — los dos defectos que solo se
   ven con la app viva (Chromium real + app de harness, como
   ronda299diseno):

   (3) El desplegable de «trabajos en curso»: abierto desde
       Reportes, en la verificación en vivo de la 2.9.13 se
       quedó puesto sobre la barra lateral — ni Escape ni su
       botón lo cerraban y hizo falta recargar —. Aquí se
       exige el cierre de la casa: Escape lo cierra, un clic
       en la barra lateral lo cierra (y navega), un clic
       DENTRO de la lista NO lo cierra (es trabajo: Pausar,
       Detener) y su botón lo abre y lo cierra.
   (5) Los pasos dibujados de Descargar: la 2.9.13 creó la
       piel (.dl2913-paso, .dl2913-paso-num) y el conmutador
       (descargaPasos2913), pero los <li> nacían sin la clase
       ni el número — en vivo se vieron como texto corrido —.
       Aquí, con la tarjeta EN MARCHA de verdad (el conector
       contesta «pending»: la corrida se queda en «Consultando
       al SAT»), se exige: tres <li class="dl2913-paso">, cada
       uno con su círculo .dl2913-paso-num (1, 2, 3), el
       primero ACTIVO y su círculo con el fondo del acento —
       distinto del de un paso sin encender —.

   Contra la 2.9.13 esta suite corre en ROJO: la lista no
   tenía oyentes de cierre y los <li> no llevaban la clase.
   ================================================================ */

const AQUI = dirname(fileURLToPath(import.meta.url));
const KEY = 'd'.repeat(64);
const OWN = 'AAA010101AAA';
const TIME = Date.parse('2026-11-18T15:00:00Z');
const espera = ms => new Promise(r => setTimeout(r, ms));

let service = null;
const server = createServer((req, res) => { req.headers['x-pacosat-proxy'] = KEY; service.handle(req, res); });
await new Promise(r => server.listen(0, '127.0.0.1', r));
const ORIGIN = 'http://127.0.0.1:' + server.address().port;
const dir = mkdtempSync(join(tmpdir(), 'pacosat-2914-'));
const dbFile = join(dir, 'pacosat.sqlite');
const makeService = () => createPacoSATService({
  dbFile, html: readFileSync(join(AQUI, 'Faro-Fiscal.html'), 'utf8'),
  lazyParts: JSON.parse(readFileSync(join(AQUI, 'lazy.json'), 'utf8')),
  capacidades: JSON.parse(readFileSync(join(AQUI, 'capacidades.json'), 'utf8')),
  origin: ORIGIN, proxyKey: KEY, satDocRetryWaitMs: 5,
  makeConnector: () => ({ parser: DOMParser, connector: {
    request: async () => 'req-2914', check: async () => ({ status: 'pending', packages: [] }),
    download: async () => { throw new Error('sin paquetes'); } } }),
  makeMailer: () => ({ verify: async () => true, sendMail: async () => ({ messageId: 'm1' }) }),
  now: () => TIME });

/* Semilla en frío: perfil y DOS solicitudes vivas (la lista de
   trabajos necesita trabajos; sus ventanas de enero/febrero NO
   cubren noviembre: la corrida de Descargar de la parte (5)
   sale por la vía clásica). */
{
  service = makeService(); service.close();
  const db = new DatabaseSync(dbFile);
  db.prepare('INSERT INTO profiles(rfc, minutes, days, direction, nextRun, error) VALUES (?,?,?,?,?,?)')
    .run(OWN, 1440, 30, 'both', 0, '');
  const insJob = db.prepare('INSERT INTO jobs(rfc, direction, kind, periodStart, periodEnd, startAt, endAt, requestId, status, due, created, held) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
  insJob.run(OWN, 'received', 'cfdi', '2026-01-01', '2026-01-31', '2026-01-01 00:00:00', '2026-01-31 23:59:59', 'req-2914A', 'pending', TIME + 3600000, TIME - 7 * 60000, 0);
  insJob.run(OWN, 'issued', 'cfdi', '2026-02-01', '2026-02-28', '2026-02-01 00:00:00', '2026-02-28 23:59:59', 'req-2914B', 'pending', TIME + 3600000, TIME - 65 * 60000, 0);
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
await call('POST', '/api/storage', { batch: { people: [{ id: OWN, name: 'Empresa de Prueba, S.A.' }] } });
{
  const res = await call('POST', '/api/unlock', { rfc: OWN, minutes: 1440, days: 7, direction: 'both',
    password: 'simulated', certificate: 'YQ==', key: 'Yg==' });
  assert.equal(res.status, 200, 'unlock de ' + OWN + ' para la tarjeta de Descargar');
}

const executablePath = [join(homedir(), '.cache/ms-playwright/chromium-1248/chrome-linux64/chrome'),
  join(homedir(), '.cache/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell')]
  .find(p => existsSync(p));
assert.ok(executablePath, 'Chromium de Playwright disponible');
const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
const listaVisible = () => page.evaluate(() => {
  const l = document.getElementById('barra-trabajos-lista299');
  return Boolean(l) && !l.hidden && l.getClientRects().length > 0;
});

let page;
try {
  page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(ORIGIN + '/', { waitUntil: 'load' });
  await page.waitForFunction(() => typeof navigate === 'function' && typeof satToken !== 'undefined' && Boolean(satToken),
    null, { timeout: 15000 });
  await page.evaluate(rfc => { scope = rfc; }, OWN);

  /* ===== (3) El desplegable de trabajos: abre y CIERRA ===== */
  await page.evaluate(() => navigate('reportes'));
  await page.waitForTimeout(1200);
  await page.evaluate(() => { if (typeof paintActivity === 'function') paintActivity(); });
  await page.waitForTimeout(400);
  const botonVisible = await page.evaluate(() => {
    const b = document.getElementById('barra-trabajos299');
    return Boolean(b) && !b.hidden && b.getClientRects().length > 0;
  });
  assert.ok(botonVisible, '(3) la línea de trabajos se ve con sus dos trabajos vivos');
  await page.click('#barra-trabajos299');
  await page.waitForTimeout(300);
  assert.equal(await listaVisible(), true, '(3) su botón despliega la lista');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  assert.equal(await listaVisible(), false, '(3) Escape la cierra (en vivo no la cerraba)');
  await page.click('#barra-trabajos299');
  await page.waitForTimeout(300);
  assert.equal(await listaVisible(), true, '(3) se vuelve a abrir');
  await page.click('#barra-trabajos-lista299', { position: { x: 12, y: 8 } });
  await page.waitForTimeout(200);
  assert.equal(await listaVisible(), true, '(3) un clic DENTRO de la lista no la cierra: es zona de trabajo');
  await page.click('button[data-view="invoices"]');
  await page.waitForTimeout(600);
  assert.equal(await listaVisible(), false, '(3) un clic en la barra lateral la cierra y navega (en vivo bloqueaba la navegación)');
  await page.evaluate(() => navigate('reportes'));
  await page.waitForTimeout(800);
  await page.click('#barra-trabajos299');
  await page.waitForTimeout(300);
  assert.equal(await listaVisible(), true, '(3) se abre una vez más');
  await page.click('#barra-trabajos299');
  await page.waitForTimeout(300);
  assert.equal(await listaVisible(), false, '(3) y su propio botón la cierra');
  console.log('OK 2.9.14-navegador · (3) — la lista de trabajos cierra con Escape, clic fuera y su botón; dentro no.');

  /* ===== (5) Los pasos dibujados durante la marcha real ===== */
  await page.evaluate(() => navigate('descargar'));
  await page.waitForSelector('[data-dl2912-go]', { timeout: 15000 });
  await page.waitForTimeout(800);
  await page.evaluate(() => {
    const ini = document.querySelector('[data-dl2912-start]');
    const fin = document.querySelector('[data-dl2912-end]');
    ini.value = '2026-11-01'; fin.value = '2026-11-18';
    for (const el of [ini, fin]) {
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
  await page.waitForTimeout(800);
  await page.click('[data-dl2912-go]');
  await page.waitForTimeout(1500);
  const pasos = await page.evaluate(() => {
    const lis = [...document.querySelectorAll('li.dl2913-paso')];
    const fondo = li => { const s = li?.querySelector('.dl2913-paso-num');
      return s ? getComputedStyle(s).backgroundColor : ''; };
    return { n: lis.length,
      numeros: lis.map(li => li.querySelector('.dl2913-paso-num')?.textContent || ''),
      etiquetas: lis.map(li => li.textContent.replace(/\s+/g, ' ').trim()),
      activos: lis.map((li, i) => li.classList.contains('activo') ? i : -1).filter(i => i >= 0),
      fondoActivo: lis.length ? fondo(lis.find(li => li.classList.contains('activo')) || lis[0]) : '',
      fondoQuieto: lis.length > 1 ? fondo(lis.find(li => !li.classList.contains('activo'))) : '',
      fase: document.querySelector('[data-dl2912-phase]')?.textContent || '' };
  });
  assert.equal(pasos.n, 3, '(5) la marcha enseña TRES pasos con su clase dibujada — vistos: ' + pasos.n);
  assert.deepEqual(pasos.numeros, ['1', '2', '3'], '(5) cada paso lleva su número en su círculo');
  assert.ok(pasos.etiquetas[0].includes('Pedirlo al SAT') && pasos.etiquetas[2].includes('Guardarlo'),
    '(5) las etiquetas de siempre: ' + pasos.etiquetas.join(' | '));
  assert.deepEqual(pasos.activos, [0], '(5) en «Consultando al SAT» el paso encendido es el primero — fase: «' + pasos.fase + '»');
  assert.ok(pasos.fondoActivo && pasos.fondoActivo !== pasos.fondoQuieto,
    '(5) el círculo del paso activo va ENCENDIDO (fondo ' + pasos.fondoActivo + ' ≠ ' + pasos.fondoQuieto + ')');
  console.log('OK 2.9.14-navegador · (5) — pasos dibujados y encendidos durante la marcha real de la tarjeta.');
  await page.click('[data-dl2912-cancel]');
  await page.waitForTimeout(400);

  /* ===== (7) El comunicado-puntero, en el DOM real =====
     La fuente de página del detalle, sobre un DOM con la
     forma del portal: la fila msgN que termina en el folio y
     su detalleMsgN con el cuerpo REAL del folio …0004 — debe
     devolver el cuerpo Y su único enlace, y la decisión en
     tierra firme debe reconocer el puntero. El lector del
     destino distingue una página de texto de un formulario. */
  await page.setContent('<table><tr id="msg1"><td>28/08/2026 · Registro o actualización de medios de contacto · MFI6212158B40004</td></tr></table>' +
    '<div id="detalleMsg1">Para consultar los detalles del registro de tu mecanismo de comunicación ' +
    '<a href="https://wwwmat.sat.gob.mx/detalle-del-mecanismo">da clic aquí</a>.</div>');
  const detalleReal = await page.evaluate(detalleComunicadoSource, 'MFI6212158B40004');
  assert.equal(detalleReal.encontrado, true, '(7) la fuente encuentra el detalle del folio');
  assert.ok(detalleReal.cuerpo.includes('da clic aquí'), '(7) el cuerpo es el real, con su «da clic aquí»');
  assert.equal(detalleReal.enlaces.length, 1, '(7) el detalle trae su único enlace');
  assert.equal(detalleReal.enlaces[0].href, 'https://wwwmat.sat.gob.mx/detalle-del-mecanismo',
    '(7) con su href absoluto');
  assert.equal(buzonEnlacePuntero2914(detalleReal.cuerpo, detalleReal.enlaces),
    'https://wwwmat.sat.gob.mx/detalle-del-mecanismo',
    '(7) y la decisión reconoce el puntero sobre lo que la fuente leyó en el DOM real');
  await page.setContent('<main><h1>Detalle del registro</h1>' +
    '<p>Tu correo quedó confirmado como mecanismo de comunicación.</p>' +
    '<p>Este detalle forma parte de tu expediente en el Buzón Tributario.</p></main>');
  const destinoTexto = await page.evaluate(leerDestinoEnlaceSource);
  assert.equal(destinoTexto.esFormulario, false, '(7) la página de texto no es un formulario');
  assert.ok(destinoTexto.texto.includes('Tu correo quedó confirmado'),
    '(7) y su texto se lee entero para enseñarlo como detalle');
  await page.setContent('<form><label>Nombre <input type="text"></label>' +
    '<label>Correo <input type="email"></label><button>Enviar</button></form>');
  const destinoForm = await page.evaluate(leerDestinoEnlaceSource);
  assert.equal(destinoForm.esFormulario, true,
    '(7) la página que es un formulario se reconoce como tal: se nombrará, no se inventará');
  console.log('OK 2.9.14-navegador · (7) — el puntero se extrae del DOM real y el destino se lee o se reconoce formulario.');
} finally {
  await browser.close().catch(() => {});
  server.close();
  service.close();
}
