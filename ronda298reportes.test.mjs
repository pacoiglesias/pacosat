import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOMParser } from '@xmldom/xmldom';
import { createPacoSATService } from './local-server.mjs';
import { chromium } from 'playwright-core';

/* ================================================================
   Ronda 2.9.8 · Pieza R — LAS CIFRAS DE LAS BARRAS SIN SOMBRA

   SÍNTOMA (re-verificación en vivo de la 2.9.7): las cifras
   sobre las barras de «Totales por mes» («$332 mil»…) se veían
   con efecto sombra/duplicado que las emborrona.

   CAUSA RAÍZ (reproducida y medida con render real ANTES de
   tocar nada; arnés en ~/workspace/pacosat-298-capturas/
   diagnostico-r.mjs, mediciones diag-r-*-antes.json):
   NO hay doble pintado: 1 solo svg.chart, 1 panel, 18 textos,
   0 duplicados exactos (texto,x,y) y 0 pares solapados (la
   medición D7 sigue en 0). Lo que hay es un TRAZO heredado:
   la regla global de iconos de style.part,
     svg{stroke:currentColor;stroke-width:1.65;fill:none;…}
   se hereda a todo el subárbol del gráfico, y el estilo
   computado de CADA <text> del gráfico era
     stroke: rgb(23,41,63) (=--ink) · stroke-width: 1.65px
     fill: rgb(84,104,127) (=--muted)
   es decir, cada glifo de 11 px se pintaba con su relleno gris
   Y un contorno de tinta de 1,65 px encima (paint-order
   normal): el halo oscuro que se leía como sombra/duplicado.
   Las barras (rect) llevaban el mismo contorno de tinta.
   Ni filter ni text-shadow: ambos computaban «none».

   EL ARREGLO (en la raíz, sin tocar los iconos): las reglas
   .chart de design.part declaran stroke:none — en el propio
   svg.chart (gana a la regla de elemento por especificidad y
   el subárbol hereda «sin trazo») y en .chart text. El único
   trazo del gráfico vuelve a ser el suyo: .grid-line.

   FIJADO AQUÍ:
   (a) estático: .chart y .chart text llevan stroke:none en la
       fuente y en el artefacto; la regla de iconos sigue
       intacta (sus trazos no se tocan);
   (b) render real (escritorio y móvil): exactamente un
       svg.chart, exactamente UN nodo de texto por cifra
       (texto,x,y sin duplicados), stroke computado «none» en
       todos los textos y barras, la rejilla conserva su trazo
       propio y el solape D7 sigue en 0 pares.
   ================================================================ */

const AQUI = dirname(fileURLToPath(import.meta.url));

/* ---------- (a) Estático: la causa y su arreglo, en la fuente ---------- */
{
  const diseno = readFileSync(join(AQUI, 'design.part'), 'utf8');
  const reglaChart = /\.chart\{[^}]*\}/.exec(diseno)?.[0] || '';
  const reglaTexto = /\.chart text\{[^}]*\}/.exec(diseno)?.[0] || '';
  assert.ok(reglaChart.includes('stroke:none'),
    '(a) .chart declara stroke:none (sin trazo heredado de la regla de iconos) — regla: ' + reglaChart);
  assert.ok(reglaTexto.includes('stroke:none'),
    '(a) .chart text declara stroke:none: cada cifra en un solo trazo — regla: ' + reglaTexto);
  const estilo = readFileSync(join(AQUI, 'style.part'), 'utf8');
  assert.ok(/svg\{[^}]*stroke:currentColor;stroke-width:1\.65/.test(estilo),
    '(a) la regla global de iconos sigue intacta: el arreglo no le quita su trazo a los iconos');
  const artefacto = readFileSync(join(AQUI, 'Faro-Fiscal.html'), 'utf8');
  assert.ok(/\.chart\{[^}]*stroke:none/.test(artefacto) && /\.chart text\{[^}]*stroke:none/.test(artefacto),
    '(a) el artefacto construido lleva el arreglo (hay que correr node build.mjs)');
  console.log('OK 2.9.8 · R-(a) — .chart y .chart text con stroke:none en fuente y artefacto; iconos intactos.');
}

/* ---------- (b) Render real ---------- */
const KEY = 'd'.repeat(64);
const OWN = 'AAA010101AAA';
const OTRO = 'BBB010101BB2';
let service = null;
const server = createServer((req, res) => { req.headers['x-pacosat-proxy'] = KEY; service.handle(req, res); });
await new Promise(r => server.listen(0, '127.0.0.1', r));
const ORIGIN = 'http://127.0.0.1:' + server.address().port;
const dir = mkdtempSync(join(tmpdir(), 'pacosat-298r-'));
service = createPacoSATService({
  dbFile: join(dir, 'pacosat.sqlite'),
  html: readFileSync(join(AQUI, 'Faro-Fiscal.html'), 'utf8'),
  lazyParts: JSON.parse(readFileSync(join(AQUI, 'lazy.json'), 'utf8')),
  capacidades: JSON.parse(readFileSync(join(AQUI, 'capacidades.json'), 'utf8')),
  origin: ORIGIN, proxyKey: KEY, satDocRetryWaitMs: 5,
  makeConnector: () => ({ parser: DOMParser, connector: {
    request: async () => 'req-298r', check: async () => ({ status: 'pending', packages: [] }),
    download: async () => { throw new Error('sin paquetes'); } } }),
  makeMailer: () => ({ verify: async () => true, sendMail: async () => ({ messageId: 'm1' }) }),
  now: () => Date.parse('2026-11-18T15:00:00Z')
});
let token = '';
const raw = async (method, path, bodyText, extraHeaders = {}) => {
  const chunks = []; if (bodyText) chunks.push(Buffer.from(String(bodyText)));
  const req = Readable.from(chunks);
  req.method = method; req.url = path;
  req.headers = { host: new URL(ORIGIN).host, origin: ORIGIN, 'x-pacosat-proxy': KEY, ...extraHeaders };
  let status = 0; const headers = {}; let text = '';
  const res = { writeHead(c, h) { status = c; if (h) Object.assign(headers, h); },
    setHeader(k, v) { headers[k] = v; }, getHeader(k) { return headers[k]; },
    end(ch) { if (ch) text += Buffer.isBuffer(ch) ? ch.toString('latin1') : ch; } };
  await service.handle(req, res);
  return { status, text, headers };
};
const call = async (method, path, body) => {
  if (!token) { const home = await raw('GET', '/'); token = /[0-9a-f]{64}/.exec(home.text)?.[0] || ''; }
  const r = await raw(method, path, body === undefined ? undefined : JSON.stringify(body),
    { 'x-pacosat-token': token });
  let json = null; try { json = JSON.parse(r.text); } catch { /* binario */ }
  return { status: r.status, json, text: r.text };
};
{
  await call('POST', '/api/storage', { batch: {
    people: [{ id: OWN, name: 'Empresa de Prueba, S.A.' }, { id: OTRO, name: 'Otra de Prueba, S.A.' }] } });
  const meses = ['2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11'];
  const invoices = []; let n = 0;
  for (const [i, mes] of meses.entries()) {
    const emitido = 980000 + i * 7311;
    const recibido = emitido - 4200 - (i % 3) * 900;
    invoices.push({ id: 'd8000000-0000-4000-8000-' + String(++n).padStart(12, '0'),
      date: mes + '-10', kind: 'I', total: emitido.toFixed(2), currency: 'MXN',
      from: { rfc: OWN, name: 'Empresa de Prueba, S.A.' }, to: { rfc: 'PROV010101AA1', name: 'Proveedor' } });
    invoices.push({ id: 'd8000000-0000-4000-8000-' + String(++n).padStart(12, '0'),
      date: mes + '-12', kind: 'I', total: recibido.toFixed(2), currency: 'MXN',
      from: { rfc: 'PROV010101AA1', name: 'Proveedor' }, to: { rfc: OWN, name: 'Empresa de Prueba, S.A.' } });
    invoices.push({ id: 'd8000000-0000-4000-8000-' + String(++n).padStart(12, '0'),
      date: mes + '-20', kind: 'I', total: (emitido * 0.41).toFixed(2), currency: 'MXN',
      from: { rfc: OWN, name: 'Empresa de Prueba, S.A.' }, to: { rfc: 'CLI010101AA2', name: 'Cliente' } });
    invoices.push({ id: 'd8000000-0000-4000-8000-' + String(++n).padStart(12, '0'),
      date: mes + '-22', kind: 'I', total: (recibido * 0.43).toFixed(2), currency: 'MXN',
      from: { rfc: 'CLI010101AA2', name: 'Cliente' }, to: { rfc: OWN, name: 'Empresa de Prueba, S.A.' } });
  }
  const r = await call('POST', '/api/storage', { batch: { invoices } });
  assert.equal(r.status, 200, '(b) la semilla de CFDI entra');
}
const INSPECT = () => {
  const charts = [...document.querySelectorAll('svg.chart')];
  const out = { numSvgChart: charts.length, textos: [], barras: [], rejilla: null, solapes: 0 };
  if (charts[0]) {
    out.textos = [...charts[0].querySelectorAll('text')].map(el => {
      const s = getComputedStyle(el);
      return { texto: el.textContent, x: el.getAttribute('x'), y: el.getAttribute('y'),
        stroke: s.stroke, fill: s.fill };
    });
    out.barras = [...charts[0].querySelectorAll('rect')].map(el => getComputedStyle(el).stroke);
    const linea = charts[0].querySelector('line.grid-line');
    if (linea) { const s = getComputedStyle(linea); out.rejilla = { stroke: s.stroke, strokeWidth: s.strokeWidth }; }
  }
  const textos = [...document.querySelectorAll('svg text')].map(el => {
    const r = el.getBoundingClientRect();
    return { texto: el.textContent, x: r.x, y: r.y, w: r.width, h: r.height };
  }).filter(t => t.w > 0 && t.h > 0);
  let pares = 0;
  for (let i = 0; i < textos.length; i++) for (let j = i + 1; j < textos.length; j++) {
    const a = textos[i], b = textos[j];
    const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
    const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    if (ox > 1 && oy > 1) pares++;
  }
  out.solapes = pares;
  return out;
};
const executablePath = [join(homedir(), '.cache/ms-playwright/chromium-1248/chrome-linux64/chrome'),
  join(homedir(), '.cache/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell')]
  .find(p => existsSync(p));
if (!executablePath && process.env.CI) {
  console.log('OMITIDA EN CI: sin Chromium de Playwright en este entorno; la prueba de navegador real corre en la máquina de Paco (diseño e872570).');
  process.exit(0);
}
assert.ok(executablePath, 'Chromium de Playwright disponible');
const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
try {
  for (const [nombre, viewport] of [['escritorio', { width: 1280, height: 900 }],
      ['movil', { width: 390, height: 844 }]]) {
    const page = await browser.newPage({ viewport });
    await page.goto(ORIGIN + '/', { waitUntil: 'load' });
    await page.waitForFunction(() => typeof navigate === 'function', null, { timeout: 15000 });
    await page.evaluate(rfc => { scope = rfc; navigate('reportes'); }, OWN);
    await page.waitForSelector('svg.chart text', { timeout: 15000 });
    await page.waitForTimeout(600);
    const info = await page.evaluate(INSPECT);
    assert.equal(info.numSvgChart, 1, '(b) ' + nombre + ': exactamente UN svg.chart (sin panel duplicado)');
    assert.equal(info.textos.length, 18, '(b) ' + nombre + ': 18 textos (12 cifras + 6 meses)');
    const claves = info.textos.map(t => t.texto + '@' + t.x + ',' + t.y);
    assert.equal(new Set(claves).size, claves.length,
      '(b) ' + nombre + ': exactamente UN nodo de texto por cifra (sin duplicados en la misma posición)');
    const cifras = info.textos.filter(t => t.texto.includes('$'));
    assert.equal(cifras.length, 12, '(b) ' + nombre + ': 12 cifras de barra');
    for (const t of info.textos)
      assert.equal(t.stroke, 'none',
        '(b) ' + nombre + ': «' + t.texto + '» sin trazo heredado (un solo trazo nítido) — stroke computado: ' + t.stroke);
    for (const s of info.barras)
      assert.equal(s, 'none', '(b) ' + nombre + ': las barras tampoco llevan el contorno de tinta');
    assert.ok(info.rejilla && info.rejilla.stroke !== 'none' && info.rejilla.strokeWidth === '1px',
      '(b) ' + nombre + ': la rejilla conserva SU trazo propio — ' + JSON.stringify(info.rejilla));
    assert.equal(info.solapes, 0, '(b) ' + nombre + ': la medición de solape de la D7 sigue en 0 pares');
    console.log('OK 2.9.8 · R-(b) ' + nombre + ' — 1 gráfico, 1 nodo por cifra, stroke=none en textos y barras, rejilla intacta, 0 solapes.');
    await page.close();
  }
} finally {
  await browser.close();
  service.close();
  server.close();
}
console.log('OK suite ronda298reportes completa');
