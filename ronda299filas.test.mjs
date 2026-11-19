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
import { chromium } from 'playwright-core';

/* ================================================================
   Ronda 2.9.9 · SEGUNDA tanda de diseño (D2, D3, D5) — Chromium
   real + app de harness, como ronda299diseno/ronda298visor.

   Inventario «antes» de acciones por fila (extraído del código
   previo a esta tanda, pantalla a pantalla):
   · Facturas (invoiceActions): directas «Revisar ahora», «PDF»,
     «XML», «Enviar», «Enviar XML» + ⋯ con «Imprimir», «Copiar
     UUID», «Ver XML», «Archivar», «Compartir por correo».
   · Documentos (documentScreen): «Ver», «Descargar», «Enviar»,
     «Desvincular», «Compartir», «Archivar», «Papelera».
   · Dinero (balancePanel): directa «Ya me pagaron»/«Ya se pagó»
     + ⋯ con «Ver la factura», «Verla en Facturas».
   · Listas negras (padrón): «Ver sus CFDI», «Constancia»,
     «Expediente legal» (+ «Editar», «Quitar» en manuales).
   · Vigilancia (monitorScreen): directa «Abrir».
   · Registro (evidenceButtons por fallo): «Ver la captura del
     fallo», «Bajar el HTML de la página», «Ver la página de
     decisión», «Bajar el HTML de decisión».

   D2 · Cada fila enseña UN solo botón de acciones (el ⋯) y el
        menú abierto contiene TODAS las del inventario, por
        nombre; al menos una se ejecuta de verdad por pantalla.
   D3 · Las listas largas cortan en su página (25; Salud, 10
        tarjetas) y «Ver más» revela el resto sin perder filtros
        ni selección (Facturas: la selección sobrevive al paginado
        Anterior/Siguiente que ya existía, verificado).
   D5 · Salud sin «Qué es esto:» visible al entrar y alcanzable
        por su icono; Buzón con sus párrafos tras «Ver más»;
        Archivo con una sola tarjeta de vacío visible; Cierre
        con la línea única «5 artefactos listos · {fecha}».
   ================================================================ */

const AQUI = dirname(fileURLToPath(import.meta.url));
const KEY = 'f'.repeat(64);
const OWN = 'AAA010101AAA';
const TIME = Date.parse('2026-11-18T15:00:00Z');
const espera = ms => new Promise(r => setTimeout(r, ms));

let service = null;
const server = createServer((req, res) => { req.headers['x-pacosat-proxy'] = KEY; service.handle(req, res); });
await new Promise(r => server.listen(0, '127.0.0.1', r));
const ORIGIN = 'http://127.0.0.1:' + server.address().port;
const dir = mkdtempSync(join(tmpdir(), 'pacosat-299f-'));
const dbFile = join(dir, 'pacosat.sqlite');
const makeService = () => createPacoSATService({
  dbFile, html: readFileSync(join(AQUI, 'Faro-Fiscal.html'), 'utf8'),
  lazyParts: JSON.parse(readFileSync(join(AQUI, 'lazy.json'), 'utf8')),
  capacidades: JSON.parse(readFileSync(join(AQUI, 'capacidades.json'), 'utf8')),
  origin: ORIGIN, proxyKey: KEY, satDocRetryWaitMs: 5,
  makeConnector: () => ({ parser: DOMParser, connector: {
    request: async () => 'req-299f', check: async () => ({ status: 'pending', packages: [] }),
    download: async () => { throw new Error('sin paquetes'); } } }),
  makeMailer: () => ({ verify: async () => true, sendMail: async () => ({ messageId: 'm1' }) }),
  now: () => TIME });
{
  service = makeService(); service.close();
  const db = new DatabaseSync(dbFile);
  db.prepare('INSERT INTO profiles(rfc, minutes, days, direction, nextRun, error) VALUES (?,?,?,?,?,?)')
    .run(OWN, 1440, 30, 'both', 0, '');
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

const executablePath = [join(homedir(), '.cache/ms-playwright/chromium-1248/chrome-linux64/chrome'),
  join(homedir(), '.cache/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell')]
  .find(p => existsSync(p));
if (!executablePath && process.env.CI) {
  console.log('OMITIDA EN CI: sin Chromium de Playwright en este entorno; la prueba de navegador real corre en la máquina de Paco (diseño e872570).');
  process.exit(0);
}
assert.ok(executablePath, 'Chromium de Playwright disponible');
const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });

/* Utilidades de página: montar un nodo y diseccionar una fila. */
const montar = (page, expr) => page.evaluate(e => {
  const host = document.createElement('div');
  host.dataset.host299 = '1';
  document.body.append(host);
  const nodo = eval(e);
  if (Array.isArray(nodo)) host.append(...nodo); else if (nodo) host.append(nodo);
  return true;
}, expr);
const diseccionFila = (page, filaSel) => page.evaluate(sel => {
  const host = document.querySelector('[data-host299="1"]');
  const fila = host.querySelector(sel);
  if (!fila) return { encontrada: false };
  const fueraDelMenu = [...fila.querySelectorAll('button')].filter(b => !b.closest('.card-menu'));
  const toggle = fila.querySelector('.card-menu-btn');
  if (toggle) toggle.click();
  const items = [...fila.querySelectorAll('.card-menu-item')].map(b => b.textContent.trim());
  return { encontrada: true, botonesFuera: fueraDelMenu.length,
    etiquetaToggle: toggle ? (toggle.getAttribute('aria-label') || '') : '', items };
}, filaSel);
const clicItem = (page, filaSel, etiqueta) => page.evaluate(([sel, et]) => {
  const host = document.querySelector('[data-host299="1"]');
  const fila = host.querySelector(sel);
  const item = [...fila.querySelectorAll('.card-menu-item')].find(b => b.textContent.trim() === et);
  if (!item) return false;
  item.click();
  return true;
}, [filaSel, etiqueta]);
const limpiarHosts = page => page.evaluate(() => {
  document.querySelectorAll('[data-host299="1"]').forEach(h => h.remove());
});

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', e => console.log('PAGEERROR:', String(e).slice(0, 200)));
  await page.goto(ORIGIN + '/', { waitUntil: 'load' });
  await page.waitForFunction(() => typeof navigate === 'function' && typeof satToken !== 'undefined' && Boolean(satToken),
    null, { timeout: 15000 });
  await page.evaluate(rfc => { scope = rfc; }, OWN);

  /* ===== D2 · Facturas: una fila, un botón, todo el inventario ===== */
  {
    await page.evaluate(() => {
      window.__an299 = '';
      const original = announce;
      window.__annOriginal299 = original;
      announce = msg => { window.__an299 = String(msg); };
    });
    await montar(page, `invoiceActions({ id: 'UUID-299-F1', date: '2026-11-02', kind: 'I',
      from: { rfc: '${OWN}', name: 'Emisor SA' }, to: { rfc: 'BBB020202BB2', name: 'Receptor SA' },
      total: '1000.00', fiscal: { serie: 'A', folio: '123' }, concepts: [] })`);
    /* La «fila» aquí es el propio control devuelto: se disecciona el host. */
    const dd = await page.evaluate(() => {
      const host = document.querySelector('[data-host299="1"]');
      const fuera = [...host.querySelectorAll('button')].filter(b => !b.closest('.card-menu'));
      const toggle = host.querySelector('.card-menu-btn');
      const items = [...host.querySelectorAll('.card-menu-item')].map(b => b.textContent.trim());
      return { botonesFuera: fuera.length, hayToggle: Boolean(toggle), items };
    });
    assert.equal(dd.botonesFuera, 1, 'D2 Facturas: la fila enseña 1 solo botón de acciones (el ⋯) — fuera del menú hay ' + dd.botonesFuera);
    assert.deepEqual(dd.items, ['Revisar ahora', 'PDF', 'XML', 'Enviar', 'Enviar XML', 'Imprimir',
      'Copiar UUID', 'Ver XML', 'Archivar', 'Compartir por correo'],
      'D2 Facturas: el menú contiene TODO el inventario «antes», por nombre — fue: ' + dd.items.join(' | '));
    const okClic = await page.evaluate(() => {
      const host = document.querySelector('[data-host299="1"]');
      const item = [...host.querySelectorAll('.card-menu-item')].find(b => b.textContent.trim() === 'Copiar UUID');
      item.click(); return true;
    });
    assert.ok(okClic);
    await espera(400);
    const anuncio = await page.evaluate(() => window.__an299);
    assert.ok(anuncio.includes('UUID-299-F1'),
      'D2 Facturas: «Copiar UUID» se ejecuta de verdad (anuncio: «' + anuncio + '»)');
    await page.evaluate(() => { announce = window.__annOriginal299; });
    await limpiarHosts(page);
    console.log('OK 2.9.9 · D2 Facturas — 1 botón por fila; menú con las 10 acciones del inventario; «Copiar UUID» ejecutado.');
  }

  /* ===== D2 · Documentos: la fila del expediente ===== */
  {
    await page.evaluate(rfc => {
      documents = [{ id: 'doc-299-1', kind: 'Contrato', rfc, date: '2026-11-01', period: '2026-11',
        name: 'Contrato prueba.pdf', uuid: 'UUID-299-D1' }];
      docFilter = ''; docTerm = ''; docPage = 0; docsGrupoDecl201 = false;
      window.__visto299 = '';
      viewDocOnline = doc => { window.__visto299 = doc.id; };
    }, OWN);
    await montar(page, 'documentScreen()[0]');
    const d = await diseccionFila(page, 'table tbody tr');
    assert.ok(d.encontrada, 'D2 Documentos: la fila existe');
    assert.equal(d.botonesFuera, 1, 'D2 Documentos: 1 solo botón de acciones por fila — fuera: ' + d.botonesFuera);
    assert.deepEqual(d.items, ['Ver', 'Descargar', 'Enviar', 'Desvincular', 'Compartir', 'Archivar', 'Papelera'],
      'D2 Documentos: el menú contiene TODO el inventario «antes» — fue: ' + d.items.join(' | '));
    assert.ok(await clicItem(page, 'table tbody tr', 'Ver'), 'D2 Documentos: «Ver» está en el menú');
    await espera(200);
    assert.equal(await page.evaluate(() => window.__visto299), 'doc-299-1',
      'D2 Documentos: «Ver» se ejecuta de verdad (abre el visor del documento)');
    await limpiarHosts(page);
    console.log('OK 2.9.9 · D2 Documentos — 1 botón por fila; menú con las 7 acciones; «Ver» ejecutado.');
  }

  /* ===== D2 + D3 · Dinero: menú único y página de 25 ===== */
  {
    await page.evaluate(async () => { await ensureLazyPart('dinero'); });
    const mkItems = n => Array.from({ length: n }, (_, i) => ({
      row: { id: 'UUID-299-M' + i, date: '2026-10-' + String(1 + (i % 28)).padStart(2, '0'), kind: 'I',
        from: { rfc: 'CLI010101AA1', name: 'Cliente Uno' }, to: { rfc: 'AAA010101AAA', name: 'Empresa de Prueba' },
        total: '100.00', fiscal: { serie: 'A', folio: String(i + 1) }, concepts: [] },
      total: 10000n, paid: 0n, balance: 10000n }));
    await page.evaluate(items => { window.__items299 = items; }, mkItems(3).map(it => ({ ...it, total: '10000', paid: '0', balance: '10000' })));
    /* Los importes viajan como BigInt dentro de la página: se reconstruyen allí. */
    await montar(page, `balancePanel('Por cobrar', 'desc', window.__items299.map(it => ({
      row: it.row, total: BigInt(it.total), paid: BigInt(it.paid), balance: BigInt(it.balance) })), 'from', 'Ya me pagaron')`);
    const d = await diseccionFila(page, '.cp-row.clickable');
    assert.ok(d.encontrada, 'D2 Dinero: la fila de saldo existe');
    assert.equal(d.botonesFuera, 1, 'D2 Dinero: 1 solo botón de acciones por fila — fuera: ' + d.botonesFuera);
    assert.deepEqual(d.items, ['Ya me pagaron', 'Ver la factura', 'Verla en Facturas'],
      'D2 Dinero: el menú contiene TODO el inventario «antes» — fue: ' + d.items.join(' | '));
    await page.evaluate(() => { window.__det299 = ''; invoiceDetail = row => { window.__det299 = row.id; }; });
    assert.ok(await clicItem(page, '.cp-row.clickable', 'Ver la factura'));
    await espera(200);
    assert.equal(await page.evaluate(() => window.__det299), 'UUID-299-M0',
      'D2 Dinero: «Ver la factura» se ejecuta de verdad (abre la ficha)');
    await limpiarHosts(page);
    /* D3: 30 saldos cortan en 25 y «Ver más» trae los 30. */
    await page.evaluate(items => { window.__items299 = items; }, mkItems(30).map(it => ({ ...it, total: '10000', paid: '0', balance: '10000' })));
    await page.evaluate(() => {
      window.__renderOrig299 = render;
      render = () => { window.__renders299 = (window.__renders299 || 0) + 1; };
    });
    await montar(page, `balancePanel('Por cobrar', 'desc', window.__items299.map(it => ({
      row: it.row, total: BigInt(it.total), paid: BigInt(it.paid), balance: BigInt(it.balance) })), 'from', 'Ya me pagaron')`);
    const corte = await page.evaluate(() => {
      const host = document.querySelector('[data-host299="1"]');
      const menus = host.querySelectorAll('.card-menu-btn').length;
      const verMas = [...host.querySelectorAll('button')].find(b => b.textContent.trim() === 'Ver más');
      if (verMas) verMas.click();
      return { menus, hayVerMas: Boolean(verMas) };
    });
    assert.equal(corte.menus, 25, 'D3 Dinero: la lista corta en 25 filas — fueron ' + corte.menus);
    assert.ok(corte.hayVerMas, 'D3 Dinero: hay «Ver más»');
    await espera(300);
    assert.equal(await page.evaluate(() => dineroLimites299['Por cobrar']), 50,
      'D3 Dinero: «Ver más» sube el límite a 50 sin salir de la pantalla');
    await limpiarHosts(page);
    const tras = await page.evaluate(() => {
      const host = document.createElement('div'); host.dataset.host299 = '1'; document.body.append(host);
      host.append(balancePanel('Por cobrar', 'desc', window.__items299.map(it => ({
        row: it.row, total: BigInt(it.total), paid: BigInt(it.paid), balance: BigInt(it.balance) })), 'from', 'Ya me pagaron'));
      return host.querySelectorAll('.card-menu-btn').length;
    });
    assert.equal(tras, 30, 'D3 Dinero: tras «Ver más» se ven las 30 filas');
    await page.evaluate(() => { render = window.__renderOrig299; delete dineroLimites299['Por cobrar']; });
    await limpiarHosts(page);
    console.log('OK 2.9.9 · D2+D3 Dinero — menú único con las 3 acciones («Ver la factura» ejecutada); corte en 25 y «Ver más» a 30.');
  }

  /* ===== D2 · Listas negras: la fila del padrón ===== */
  {
    await page.evaluate(() => {
      LISTS_VIEW.data = { sources: [], events: [], lastCancelled: null,
        counterparts: [{ rfc: 'XAXX010101000', name: 'Contraparte Uno', kind: 'Proveedor', source: 'manual',
          severity: 'ok', hits: [], note: '',
          detalle: { recibidos: { total: '100.00', count: 1, primera: '2026-01-01', ultima: '2026-01-01' },
            emitidos: null, saldoPorCobrar: null },
          exposure: { receivedCount: 1, received: '100.00' } }] };
      window.__cert299 = '';
      printListsCertificate = cp => { window.__cert299 = cp.rfc; };
    });
    await montar(page, 'listsScreen()[0]');
    const d = await diseccionFila(page, '.cp-row.clickable');
    assert.ok(d.encontrada, 'D2 Listas: la fila del padrón existe');
    assert.equal(d.botonesFuera, 1, 'D2 Listas: 1 solo botón de acciones por fila — fuera: ' + d.botonesFuera);
    assert.deepEqual(d.items, ['Ver sus CFDI', 'Constancia', 'Expediente legal', 'Editar', 'Quitar'],
      'D2 Listas: el menú contiene TODO el inventario «antes» — fue: ' + d.items.join(' | '));
    assert.ok(await clicItem(page, '.cp-row.clickable', 'Constancia'));
    await espera(200);
    assert.equal(await page.evaluate(() => window.__cert299), 'XAXX010101000',
      'D2 Listas: «Constancia» se ejecuta de verdad');
    await limpiarHosts(page);
    console.log('OK 2.9.9 · D2 Listas negras — 1 botón por fila; menú con las 5 acciones; «Constancia» ejecutada.');
  }

  /* ===== D2 + D3 · Vigilancia: «Abrir» al menú y página de 25 ===== */
  {
    await page.evaluate(async rfc => {
      await ensureLazyPart('monitor');
      invoices = Array.from({ length: 30 }, (_, i) => ({ id: 'UUID-299-V' + i,
        date: '2026-11-' + String(1 + (i % 28)).padStart(2, '0'), kind: 'I',
        from: { rfc, name: 'Empresa de Prueba' }, to: { rfc: 'BBB020202BB2', name: 'Receptor SA' },
        total: '500.00', fiscal: { serie: 'A', folio: String(i + 1) }, concepts: [] }));
      monitorSummary = { counts: { total: 30, vigentes: 30, cancelados: 0, enListado69B: 0,
          sinRevisar: 0, noEncontrados: 0, conProblema: 0, revisados: 30, ultimaRevision: Date.now() },
        lists: { fetched: Date.now(), count: 10 }, masAfectados: [] };
      monitorFilter = 'all'; monitorSearch = ''; monitorLimit = 25;
      window.__det299 = ''; invoiceDetail = row => { window.__det299 = row.id; };
      window.__renderOrig299 = render;
      render = () => { window.__renders299 = (window.__renders299 || 0) + 1; };
    }, OWN);
    await montar(page, 'monitorScreen()[1]');
    const base = await page.evaluate(() => {
      const host = document.querySelector('[data-host299="1"]');
      return { filas: host.querySelectorAll('table tbody tr').length,
        hayVerMas: [...host.querySelectorAll('button')].some(b => b.textContent.trim() === 'Ver más') };
    });
    assert.equal(base.filas, 25, 'D3 Vigilancia: la lista corta en 25 — fueron ' + base.filas);
    assert.ok(base.hayVerMas, 'D3 Vigilancia: hay «Ver más»');
    const d = await diseccionFila(page, 'table tbody tr');
    assert.equal(d.botonesFuera, 1, 'D2 Vigilancia: 1 solo botón de acciones por fila — fuera: ' + d.botonesFuera);
    assert.deepEqual(d.items, ['Abrir'], 'D2 Vigilancia: el menú contiene «Abrir», la acción de antes — fue: ' + d.items.join(' | '));
    assert.ok(await clicItem(page, 'table tbody tr', 'Abrir'));
    await espera(200);
    assert.ok((await page.evaluate(() => window.__det299)).startsWith('UUID-299-V'),
      'D2 Vigilancia: «Abrir» se ejecuta de verdad (abre la ficha)');
    await page.evaluate(() => {
      const host = document.querySelector('[data-host299="1"]');
      [...host.querySelectorAll('button')].find(b => b.textContent.trim() === 'Ver más').click();
    });
    const limite = await page.evaluate(() => monitorLimit);
    assert.equal(limite, 50, 'D3 Vigilancia: «Ver más» sube el límite a 50');
    await limpiarHosts(page);
    const tras = await page.evaluate(() => {
      const host = document.createElement('div'); host.dataset.host299 = '1'; document.body.append(host);
      host.append(monitorScreen()[1]);
      return host.querySelectorAll('table tbody tr').length;
    });
    assert.equal(tras, 30, 'D3 Vigilancia: tras «Ver más» se ven las 30 filas');
    await page.evaluate(() => { render = window.__renderOrig299; monitorLimit = 25; });
    await limpiarHosts(page);
    console.log('OK 2.9.9 · D2+D3 Vigilancia — «Abrir» en el ⋯ y ejecutado; corte en 25 y «Ver más» a 30.');
  }

  /* ===== D2 + D3 · Registro: menú «Evidencia» y página de 25 ===== */
  {
    await page.evaluate(async () => { await ensureLazyPart('registro'); });
    await page.evaluate(t => {
      window.__origSatApi299 = satApi;
      window.__blob299 = '';
      const items = Array.from({ length: 40 }, (_, i) => ({ clave: 'k' + i, clase: 'fallo',
        at: t - i * 60000, texto: 'Suceso de prueba número ' + i, rfc: 'AAA010101AAA', origen: 'sistema' }));
      items[0].evidencia = { motor: 'declaraciones', runId: 'run-299', hasShot: true, hasHtml: true };
      items[0].detalle = { hasDecisionShot: true, hasDecisionHtml: true, steps: [], error: '' };
      satApi = async (path, body) => String(path).startsWith('registro?')
        ? { total: items.length, items } : window.__origSatApi299(path, body);
      const origBlob = satApiBlob;
      window.__origBlob299 = origBlob;
      satApiBlob = async path => { window.__blob299 = String(path); return new Blob(['x'], { type: 'image/png' }); };
      registroLimite299 = 25;
    }, TIME);
    await montar(page, 'registroScreen()[0]');
    await page.waitForFunction(() =>
      document.querySelectorAll('[data-host299="1"] .activity-item').length > 0, null, { timeout: 10000 });
    const base = await page.evaluate(() =>
      document.querySelectorAll('[data-host299="1"] .activity-item').length);
    assert.equal(base, 25, 'D3 Registro: la lista corta en 25 sucesos — fueron ' + base);
    const d = await diseccionFila(page, '.activity-item');
    assert.equal(d.botonesFuera, 1, 'D2 Registro: 1 solo botón de acciones en la fila del fallo — fuera: ' + d.botonesFuera);
    assert.equal(d.etiquetaToggle, 'Evidencia',
      'D2 Registro: el ⋯ de la fila ES el menú «Evidencia» (su aria-label lo nombra) — fue «' + d.etiquetaToggle + '»');
    assert.deepEqual(d.items, ['Ver la captura del fallo', 'Bajar el HTML de la página',
      'Ver la página de decisión', 'Bajar el HTML de decisión'],
      'D2 Registro: el menú «Evidencia» contiene TODAS las piezas de antes — fue: ' + d.items.join(' | '));
    assert.ok(await clicItem(page, '.activity-item', 'Ver la captura del fallo'));
    await espera(500);
    assert.ok((await page.evaluate(() => window.__blob299)).includes('declaraciones/artifact?run=run-299&part=shot'),
      'D2 Registro: la evidencia se ejecuta de verdad (pide la captura de la corrida)');
    await page.evaluate(() => {
      const host = document.querySelector('[data-host299="1"]');
      [...host.querySelectorAll('button')].find(b => b.textContent.trim() === 'Ver más').click();
    });
    await page.waitForFunction(() =>
      document.querySelectorAll('[data-host299="1"] .activity-item').length === 40, null, { timeout: 10000 });
    console.log('OK 2.9.9 · D2+D3 Registro — menú «Evidencia» con las 4 piezas y captura ejecutada; corte en 25 y «Ver más» a 40.');
    await page.evaluate(() => { satApi = window.__origSatApi299; satApiBlob = window.__origBlob299; registroLimite299 = 25; });
    await limpiarHosts(page);
  }

  /* ===== D3 · Facturas: la selección sobrevive al paginado ===== */
  {
    await page.evaluate(rfc => {
      invoices = Array.from({ length: 40 }, (_, i) => ({ id: 'UUID-299-S' + i,
        date: '2026-11-' + String(1 + (i % 28)).padStart(2, '0'), kind: 'I',
        from: { rfc, name: 'Empresa de Prueba' }, to: { rfc: 'BBB020202BB2', name: 'Receptor SA' },
        total: '500.00', fiscal: { serie: 'A', folio: String(i + 1) }, concepts: [] }));
      term = ''; month = ''; invoiceKind = ''; invoiceState = ''; invoicePayState = '';
      direction = 'Todos'; invoiceRapido240 = ''; invoiceContraparte201 = ''; invoicePage = 0;
      invoiceSelection.clear();
    }, OWN);
    await montar(page, 'invoiceScreen()');
    /* Los botones de paginación van por action(): su trabajo
       corre en microtarea, así que cada clic se lee en la
       evaluación siguiente, como el gesto real. */
    const paso1 = await page.evaluate(() => {
      const host = document.querySelector('[data-host299="1"]');
      const filas1 = host.querySelectorAll('table tbody tr').length;
      host.querySelector('table tbody tr input[type="checkbox"]').click();
      return { filas1, trasMarcar: [...invoiceSelection] };
    });
    await page.evaluate(() => {
      const host = document.querySelector('[data-host299="1"]');
      [...host.querySelectorAll('button')].find(b => b.textContent.trim() === 'Siguiente').click();
    });
    await espera(300);
    const paso2 = await page.evaluate(() => ({ pagina: invoicePage, seleccionEnPagina2: [...invoiceSelection] }));
    await page.evaluate(() => {
      const host = document.querySelector('[data-host299="1"]');
      [...host.querySelectorAll('button')].find(b => b.textContent.trim() === 'Anterior').click();
    });
    await espera(300);
    const paso3 = await page.evaluate(() => {
      const host = document.querySelector('[data-host299="1"]');
      const checkDeVuelta = host.querySelector('table tbody tr input[type="checkbox"]');
      return { marcadaDeVuelta: checkDeVuelta.checked, seleccionFinal: [...invoiceSelection] };
    });
    const paso = { ...paso1, ...paso2, ...paso3 };
    assert.equal(paso.filas1, 35, 'D3 Facturas: la paginación existente corta en 35 por página — fueron ' + paso.filas1);
    assert.equal(paso.trasMarcar.length, 1, 'D3 Facturas: marcar una fila la mete en la selección');
    assert.equal(paso.pagina, 1, 'D3 Facturas: «Siguiente» cambia de página');
    assert.deepEqual(paso.seleccionEnPagina2, paso.trasMarcar,
      'D3 Facturas: la selección SOBREVIVE al cambio de página (el ZIP/PDF combinado no la pierde)');
    assert.ok(paso.marcadaDeVuelta, 'D3 Facturas: al volver, la fila sigue marcada');
    assert.deepEqual(paso.seleccionFinal, paso.trasMarcar, 'D3 Facturas: la selección final es la misma');
    await limpiarHosts(page);
    console.log('OK 2.9.9 · D3 Facturas — paginación existente verificada (35/página) y selección múltiple intacta tras ir y volver.');
  }

  /* ===== D3 · Avisos: el historial pagina ===== */
  {
    await page.evaluate(t => {
      avisosCache = { avisos: [], counts: { total: 0 }, porRfc: {}, grupos: [], pospuestas: [], archivadas: [],
        historial: Array.from({ length: 30 }, (_, i) => ({ id: 'h' + i, kind: 'otro',
          titulo: 'Aviso histórico ' + i, resuelto: t - i * 86400000, resolucion: 'Resuelto' })) };
      aPag299.hist = 25;
      window.__renderOrig299 = render;
      render = () => { window.__renders299 = (window.__renders299 || 0) + 1; };
    }, TIME);
    await montar(page, 'avisosScreen()[0]');
    const base = await page.evaluate(() => {
      const host = document.querySelector('[data-host299="1"]');
      const panelHist = [...host.querySelectorAll('section')].find(s => s.textContent.includes('Historial · ya solventado'));
      return { filas: panelHist.querySelectorAll('.cp-row').length,
        hayVerMas: [...panelHist.querySelectorAll('button')].some(b => b.textContent.trim() === 'Ver más') };
    });
    assert.equal(base.filas, 25, 'D3 Avisos: el historial corta en 25 — fueron ' + base.filas);
    assert.ok(base.hayVerMas, 'D3 Avisos: el historial trae «Ver más»');
    await page.evaluate(() => {
      const host = document.querySelector('[data-host299="1"]');
      const panelHist = [...host.querySelectorAll('section')].find(s => s.textContent.includes('Historial · ya solventado'));
      [...panelHist.querySelectorAll('button')].find(b => b.textContent.trim() === 'Ver más').click();
    });
    assert.equal(await page.evaluate(() => aPag299.hist), 50, 'D3 Avisos: «Ver más» sube el límite del historial');
    await limpiarHosts(page);
    const tras = await page.evaluate(() => {
      const host = document.createElement('div'); host.dataset.host299 = '1'; document.body.append(host);
      host.append(avisosScreen()[0]);
      const panelHist = [...host.querySelectorAll('section')].find(s => s.textContent.includes('Historial · ya solventado'));
      return panelHist.querySelectorAll('.cp-row').length;
    });
    assert.equal(tras, 30, 'D3 Avisos: tras «Ver más» el historial enseña las 30 filas');
    await page.evaluate(() => { render = window.__renderOrig299; aPag299.hist = 25; });
    await limpiarHosts(page);
    console.log('OK 2.9.9 · D3 Avisos — historial con corte en 25 y «Ver más» a 30 (activas y vistas comparten el mismo ayudante).');
  }

  /* ===== D5 + D3 · Salud: ayuda por icono y tarjetas paginadas ===== */
  {
    await page.evaluate(async () => { await ensureLazyPart('salud'); });
    await page.evaluate(() => {
      window.__origSatApi299 = satApi;
      const tarjetas = Array.from({ length: 13 }, (_, i) => ({ id: 'pieza-' + i, titulo: 'Pieza ' + i,
        porque: 'Porque de la pieza ' + i, queEs: 'Explicación completa de la pieza ' + i,
        estado: 'bien', frescuraTexto: 'hoy', datos: {} }));
      satApi = async (path, body) => String(path) === 'salud'
        ? { tarjetas, ejecutor: {} } : window.__origSatApi299(path, body);
      page = 'salud'; saludLimite299 = 10;
    });
    await montar(page, 'saludScreen200d()[0]');
    await page.waitForFunction(() =>
      document.querySelectorAll('[data-host299="1"] .salud-grid200d > section').length > 0, null, { timeout: 10000 });
    const base = await page.evaluate(() => {
      const host = document.querySelector('[data-host299="1"]');
      const tarjetas = [...host.querySelectorAll('.salud-grid200d > section')];
      const parrafosQueEs = [...host.querySelectorAll('p')].filter(p => p.textContent.startsWith('Qué es esto:'));
      const visibles = parrafosQueEs.filter(p => !p.hidden && p.getClientRects().length > 0);
      const iconos = [...host.querySelectorAll('button')].filter(b => b.getAttribute('aria-label') === 'Qué es esto: ayuda de esta sección');
      return { nTarjetas: tarjetas.length, queEsTotal: parrafosQueEs.length,
        queEsVisibles: visibles.length, iconos: iconos.length,
        hayVerMas: [...host.querySelectorAll('button')].some(b => b.textContent.trim() === 'Ver más') };
    });
    assert.equal(base.nTarjetas, 10, 'D3 Salud: las tarjetas cortan en 10 — fueron ' + base.nTarjetas);
    assert.equal(base.queEsVisibles, 0, 'D5 Salud: NINGÚN «Qué es esto:» visible al entrar — visibles: ' + base.queEsVisibles);
    assert.equal(base.queEsTotal, 10, 'D5 Salud: el texto íntegro sigue en la pantalla, plegado (10 de 10 tarjetas pintadas)');
    assert.equal(base.iconos, 10, 'D5 Salud: un icono de ayuda por sección');
    assert.ok(base.hayVerMas, 'D3 Salud: hay «Ver más»');
    const abierto = await page.evaluate(() => {
      const host = document.querySelector('[data-host299="1"]');
      const icono = [...host.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'Qué es esto: ayuda de esta sección');
      icono.click();
      const p = [...host.querySelectorAll('p')].find(x => x.textContent.startsWith('Qué es esto:'));
      return { visible: !p.hidden && p.getClientRects().length > 0, texto: p.textContent };
    });
    assert.ok(abierto.visible && abierto.texto.includes('Explicación completa de la pieza'),
      'D5 Salud: el icono despliega el texto íntegro («' + abierto.texto.slice(0, 60) + '…»)');
    await page.evaluate(() => {
      const host = document.querySelector('[data-host299="1"]');
      [...host.querySelectorAll('button')].find(b => b.textContent.trim() === 'Ver más').click();
    });
    await espera(300);
    const tras = await page.evaluate(() =>
      document.querySelectorAll('[data-host299="1"] .salud-grid200d > section').length);
    assert.equal(tras, 13, 'D3 Salud: tras «Ver más» se ven las 13 tarjetas');
    await page.evaluate(() => { satApi = window.__origSatApi299; saludLimite299 = 10; });
    await limpiarHosts(page);
    console.log('OK 2.9.9 · D5+D3 Salud — cero «Qué es esto:» visibles, texto íntegro tras su icono; tarjetas 10 → 13 con «Ver más».');
  }

  /* ===== D3 · Descargar del SAT: solicitudes paginadas ===== */
  {
    await page.evaluate(async t => {
      await ensureLazyPart('descargas');
      satData = { profiles: [], criteriaBook: [],
        jobs: Array.from({ length: 30 }, (_, i) => ({ id: 'job-' + i, rfc: 'AAA010101AAA', direction: 'received',
          kind: 'cfdi', periodStart: '2026-01-01', periodEnd: '2026-01-31', status: 'pending',
          error: '', criteriaState: '', created: t - i * 60000, due: t + 3600000 })) };
      satJobsLimite299 = 25;
    }, TIME);
    await page.evaluate(() => {
      const host = document.createElement('div'); host.id = 'host-descargas299'; document.body.append(host);
      window.__hostDescargas299 = host;
    });
    await page.evaluate(() => fillSat(window.__hostDescargas299));
    const contar = () => page.evaluate(() => {
      const host = window.__hostDescargas299;
      const panelCola = [...host.querySelectorAll('section')].find(s => s.textContent.includes('Solicitudes recientes'));
      return { filas: panelCola.querySelectorAll('table tbody tr').length,
        hayVerMas: [...panelCola.querySelectorAll('button')].some(b => b.textContent.trim() === 'Ver más') };
    });
    const base = await contar();
    assert.equal(base.filas, 25, 'D3 Descargas: la lista de solicitudes corta en 25 — fueron ' + base.filas);
    assert.ok(base.hayVerMas, 'D3 Descargas: hay «Ver más»');
    await page.evaluate(() => {
      const panelCola = [...window.__hostDescargas299.querySelectorAll('section')]
        .find(s => s.textContent.includes('Solicitudes recientes'));
      [...panelCola.querySelectorAll('button')].find(b => b.textContent.trim() === 'Ver más').click();
    });
    const tras = await contar();
    assert.equal(tras.filas, 30, 'D3 Descargas: tras «Ver más» se ven las 30 solicitudes');
    await page.evaluate(() => { window.__hostDescargas299.remove(); satJobsLimite299 = 25; });
    console.log('OK 2.9.9 · D3 Descargar del SAT — solicitudes con corte en 25 y «Ver más» a 30.');
  }

  /* ===== D5 · Cierre: una sola línea de artefactos ===== */
  {
    await page.evaluate(t => {
      window.__origSatApi299 = satApi;
      satApi = async (path, body) => String(path).startsWith('reports/close-state')
        ? { cierre: { at: t, pasos: ['paquete', 'reporte', 'zip', 'excel', 'csv'].map(id => ({ id, ok: true })) } }
        : window.__origSatApi299(path, body);
    }, TIME);
    await montar(page, `cierreTodoCard('2026-11')`);
    await page.waitForFunction(() =>
      document.querySelector('[data-host299="1"]').textContent.includes('artefactos listos'), null, { timeout: 10000 });
    const d = await page.evaluate(() => {
      const host = document.querySelector('[data-host299="1"]');
      const caja = host.querySelector('.traffic-strip');
      return { hijos: caja.children.length, texto: caja.textContent.replace(/\s+/g, ' ').trim(),
        medallas: caja.querySelectorAll('.pill, [class*="pill"]').length };
    });
    assert.equal(d.hijos, 1, 'D5 Cierre: UNA sola línea en vez de las cinco medallas — hijos: ' + d.hijos);
    assert.ok(/^5 artefactos listos · /.test(d.texto),
      'D5 Cierre: la línea dice «5 artefactos listos · {fecha}» — fue «' + d.texto + '»');
    assert.ok(d.texto.includes('2026'), 'D5 Cierre: la fecha sale del propio registro del cierre — «' + d.texto + '»');
    await page.evaluate(() => { satApi = window.__origSatApi299; });
    await limpiarHosts(page);
    console.log('OK 2.9.9 · D5 Cierre — línea única: «' + d.texto + '».');
  }

  /* ===== D5 · Archivo: una sola tarjeta de vacío ===== */
  {
    await page.evaluate(() => { invoicesArchivo = []; documents = []; });
    await montar(page, 'archivoScreen1311()');
    const d = await page.evaluate(() => {
      const host = document.querySelector('[data-host299="1"]');
      const secciones = [...host.querySelectorAll('section')];
      const porTitulo = titulo => secciones.find(s => s.textContent.includes(titulo));
      /* Visible al entrar: con rects y FUERA de un <details>
         cerrado (el patrón seal-details de la casa; el shell
         headless reporta rects aun dentro del details cerrado,
         así que el pliegue se comprueba estructuralmente). */
      const visible = s => { if (!s) return false;
        const det = s.closest('details');
        return s.getClientRects().length > 0 && !(det && !det.open); };
      const prota = porTitulo('Lo que duerme en el archivo');
      const papelera = porTitulo('Papelera de documentos');
      return { protaVisible: visible(prota),
        protaTexto: prota ? prota.textContent.replace(/\s+/g, ' ').trim() : '',
        contenidoVisibles: ['Comprobantes archivados', 'Documentos archivados', 'Papelera de documentos']
          .filter(t => visible(porTitulo(t))).length,
        papeleraEnDetalles: Boolean(papelera && papelera.closest('details')),
        hayVerMas: [...host.querySelectorAll('summary')].some(s => s.textContent.trim() === 'Ver más') };
    });
    assert.ok(d.protaVisible, 'D5 Archivo: la tarjeta con el cero (la protagonista) se ve');
    assert.ok(d.protaTexto.includes('0 comprobante(s) y 0 documento(s) archivados'),
      'D5 Archivo: el cero consta en la tarjeta — «' + d.protaTexto.slice(0, 80) + '»');
    assert.equal(d.contenidoVisibles, 0,
      'D5 Archivo: ninguna otra tarjeta de vacío se ve al entrar (las demás van a «Ver más»)');
    assert.ok(d.papeleraEnDetalles, 'D5 Archivo: la Papelera sigue existiendo, dentro del «Ver más», con sus acciones');
    assert.ok(d.hayVerMas, 'D5 Archivo: hay «Ver más»');
    await limpiarHosts(page);
    console.log('OK 2.9.9 · D5 Archivo — una sola tarjeta con el cero; Papelera y demás tarjetas tras «Ver más».');
  }

  /* ===== D5 · Buzón: los párrafos, tras «Ver más» ===== */
  {
    await page.evaluate(t => {
      tribCache = { rfc: 'AAA010101AAA', ultimaConsulta: t, total: 2, sinAbrir: 2,
        proximaTenida: null, proximaAuto: null, comunicadosNoLeidos: null, notificaciones: [], progreso: {} };
    }, TIME);
    /* La pintura con la vista guardada es SÍNCRONA al construir
       la pantalla: las aserciones corren en la misma tarea, antes
       de que la lectura fresca repinte. */
    const d = await page.evaluate(() => {
      const host = document.createElement('div'); host.dataset.host299 = '1'; document.body.append(host);
      host.append(tributarioScreen()[0]);
      const parrafo = [...host.querySelectorAll('p')].find(p => p.textContent.includes('Son notificaciones de la autoridad'));
      const auto = [...host.querySelectorAll('p')].find(p => p.textContent.includes('Consulta automática'));
      const resumen = [...host.querySelectorAll('summary')].find(s => s.textContent.includes('Ver más'));
      const enDetallesCerrado = el => { const det = el && el.closest('details'); return Boolean(det && !det.open); };
      return { parrafoExiste: Boolean(parrafo),
        parrafoVisible: Boolean(parrafo) && !enDetallesCerrado(parrafo),
        parrafoEnDetalles: enDetallesCerrado(parrafo),
        autoEnDetalles: enDetallesCerrado(auto),
        resumenVerMas: Boolean(resumen) };
    });
    assert.ok(d.parrafoExiste, 'D5 Buzón: el párrafo explicativo sigue existiendo (texto íntegro)');
    assert.equal(d.parrafoVisible, false, 'D5 Buzón: el párrafo NO se ve al entrar (vive plegado en su «Ver más»)');
    assert.ok(d.parrafoEnDetalles, 'D5 Buzón: el párrafo vive tras el «Ver más»');
    assert.ok(d.autoEnDetalles, 'D5 Buzón: el párrafo de la consulta automática también va al «Ver más»');
    assert.ok(d.resumenVerMas, 'D5 Buzón: el desplegable se nombra «Ver más · Cómo funciona este buzón»');
    await limpiarHosts(page);
    console.log('OK 2.9.9 · D5 Buzón — párrafos explicativos tras «Ver más · Cómo funciona este buzón», íntegros.');
  }

  console.log('OK 2.9.9 · ronda299filas completa (D2 + D3 + D5).');
} finally {
  await browser.close();
  server.close();
  service.close();
}
