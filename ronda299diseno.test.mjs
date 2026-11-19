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
   Ronda 2.9.9 · Tanda DISEÑO (D1, D4, D6) — Chromium real + app
   de harness, como ronda298visor/ronda298usuarios.

   D1 · La tarjeta «Actividad del sistema» no se ve en ningún
        panel; una línea fina en la barra superior enseña el
        conteo y despliega cada trabajo con su Detener funcional.
   D4a · Declaraciones: los folios viven en UNA sola lista que
        conserva operación, periodo, la línea de presentación
        (fecha + nº de operación), Ver acuse, si hay declaración
        guardada, Borrar y los estados.
   D4b · En Hoy, puerta/buzón/declaraciones se pintan una vez:
        el lateral no repite sus chips en esa pantalla (y sí en
        las demás).
   D4c · Descargar del SAT: UNA vista principal de cobertura
        (el anillo de «Qué meses tienes»); la tabla mes a mes y
        el mapa de calor quedan tras «ver más» nombrados.
   D6 · La puerta, una sola fuente: sembrando cada estado, el
        texto del lateral y el de la fila de Contribuyentes son
        IDÉNTICOS.
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
const dir = mkdtempSync(join(tmpdir(), 'pacosat-299d-'));
const dbFile = join(dir, 'pacosat.sqlite');
const makeService = () => createPacoSATService({
  dbFile, html: readFileSync(join(AQUI, 'Faro-Fiscal.html'), 'utf8'),
  lazyParts: JSON.parse(readFileSync(join(AQUI, 'lazy.json'), 'utf8')),
  capacidades: JSON.parse(readFileSync(join(AQUI, 'capacidades.json'), 'utf8')),
  origin: ORIGIN, proxyKey: KEY, satDocRetryWaitMs: 5,
  makeConnector: () => ({ parser: DOMParser, connector: {
    request: async () => 'req-299', check: async () => ({ status: 'pending', packages: [] }),
    download: async () => { throw new Error('sin paquetes'); } } }),
  makeMailer: () => ({ verify: async () => true, sendMail: async () => ({ messageId: 'm1' }) }),
  now: () => TIME });

/* Semilla en frío: perfil, DOS solicitudes vivas (actividad),
   documentos y folios de declaraciones (ejercicio 2026). */
{
  service = makeService(); service.close();
  const db = new DatabaseSync(dbFile);
  db.prepare('INSERT INTO profiles(rfc, minutes, days, direction, nextRun, error) VALUES (?,?,?,?,?,?)')
    .run(OWN, 1440, 30, 'both', 0, '');
  const insJob = db.prepare('INSERT INTO jobs(rfc, direction, kind, periodStart, periodEnd, startAt, endAt, requestId, status, due, created, held) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
  insJob.run(OWN, 'received', 'cfdi', '2026-01-01', '2026-01-31', '2026-01-01 00:00:00', '2026-01-31 23:59:59', 'req-299A', 'pending', TIME + 3600000, TIME - 7 * 60000, 0);
  insJob.run(OWN, 'issued', 'cfdi', '2026-02-01', '2026-02-28', '2026-02-01 00:00:00', '2026-02-28 23:59:59', 'req-299B', 'pending', TIME + 3600000, TIME - 65 * 60000, 0);
  const insDoc = db.prepare('INSERT INTO declaraciones(id, rfc, tipo, clase, ejercicio, periodo, fechaPresentacion, operacion, fileId, source, created) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  insDoc.run('doc-299-acuse', OWN, 'mensual', 'acuse', 2026, '2026-10', '2026-11-05', 'OP299001', 'file-299-a', 'auto', TIME - 86400000);
  insDoc.run('doc-299-decl', OWN, 'mensual', 'declaracion', 2026, '2026-10', '2026-11-05', 'OP299001', 'file-299-d', 'auto', TIME - 86400000);
  const insFolio = db.prepare('INSERT INTO decl_folios(id, rfc, tipo, ejercicio, periodo, folio, estado, nota, fechaPresentacion, creado, actualizado) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  insFolio.run('folio-299-1', OWN, 'mensual', 2026, '2026-10', 'OP299001', 'con-acuse', '', '2026-11-05', TIME - 86400000, TIME - 86400000);
  insFolio.run('folio-299-2', OWN, 'mensual', 2026, '2026-09', 'OP299002', 'pendiente',
    'Descubierto en la Consulta de transacciones del SAT (ficha 22513)', '2026-10-06', TIME - 86400000, TIME - 86400000);
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
const visible = el => Boolean(el) && !el.hidden && el.getClientRects().length > 0;

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(ORIGIN + '/', { waitUntil: 'load' });
  await page.waitForFunction(() => typeof navigate === 'function' && typeof satToken !== 'undefined' && Boolean(satToken),
    null, { timeout: 15000 });
  await page.evaluate(rfc => { scope = rfc; }, OWN);

  /* ===== D6 · La puerta: lateral ≡ fila de Contribuyentes ===== */
  /* Fuera de Hoy: en Hoy el lateral oculta su línea (D4b) y no
     hay texto lateral que comparar — la comparación vive en
     Contribuyentes, donde los dos pintores coinciden. */
  await page.evaluate(() => navigate('contribuyentes'));
  await page.waitForTimeout(1000);
  const ESTADOS_PUERTA = [
    ['sin probar', null],
    ['probada y abre', { ok: true, probada: Date.now() - 3600000, error: '', errorKind: '' }],
    ['no abre · portal', { ok: false, probada: Date.now() - 3600000, error: 'El portal del SAT no respondió', errorKind: 'portal-rechaza' }],
    ['no abre · e.firma', { ok: false, probada: Date.now() - 3600000, error: 'La credencial fue rechazada', errorKind: 'credencial-invalida' }]];
  for (const [nombre, puerta] of ESTADOS_PUERTA) {
    const par = await page.evaluate(p => {
      satData.puerta = p ? { ['AAA010101AAA']: p } : {};
      satData.ejecutor = { emparejado: true, enLinea: true, ultimoVisto: Date.now() };
      senalesBarra1311();
      const lateral = document.getElementById('puerta-txt').textContent.replace(/^Puerta del SAT: /, '');
      const host = document.createElement('div'); document.body.append(host);
      host.append(contribuyentesPanel200b());
      const fila = host.querySelector('[data-rfc="AAA010101AAA"]');
      const m = /Puerta: (.*?) · Última descarga/.exec(fila ? fila.textContent : '');
      host.remove();
      return { lateral, fila: m ? m[1] : '(sin segmento Puerta en la fila)' };
    }, puerta);
    assert.equal(par.fila, par.lateral,
      'D6 (' + nombre + '): fila «' + par.fila + '» ≡ lateral «' + par.lateral + '»');
    if (nombre === 'probada y abre') assert.ok(par.lateral.startsWith('abre'), 'D6: abre se dice «abre»');
    if (nombre.startsWith('no abre')) assert.ok(par.lateral.includes('no abre'), 'D6: no abre se dice «no abre»');
    console.log('OK 2.9.9 · D6 (' + nombre + ') — lateral ≡ fila: «' + par.lateral + '»');
  }

  /* ===== D1 · Sin tarjeta en los paneles; línea fina con freno ===== */
  await page.evaluate(async () => { await ensureLazyPart('monitor'); activityView = await satApi('activity'); });
  for (const vista of ['invoices', 'dinero', 'registro', 'salud', 'descargar']) {
    await page.evaluate(v => navigate(v), vista);
    await page.waitForTimeout(1200);
    const vista1 = await page.evaluate(() => {
      paintActivity();
      const jobs = document.getElementById('activity-jobs');
      const barra = document.getElementById('barra-trabajos299');
      return { tarjetaVisible: Boolean(jobs) && !jobs.hidden && jobs.getClientRects().length > 0,
        barraVisible: Boolean(barra) && !barra.hidden && barra.getClientRects().length > 0,
        barraTexto: barra ? barra.textContent.replace(/\s+/g, ' ').trim() : '' };
    });
    assert.equal(vista1.tarjetaVisible, false, 'D1: la tarjeta de actividad NO se ve en «' + vista + '»');
    assert.equal(vista1.barraVisible, true, 'D1: la línea fina de la barra superior SÍ se ve en «' + vista + '»');
    assert.ok(/2 trabajos en curso/.test(vista1.barraTexto),
      'D1: la línea enseña el conteo (2 trabajos) — fue «' + vista1.barraTexto + '»');
  }
  console.log('OK 2.9.9 · D1 (paneles) — tarjeta fuera en Facturas/Dinero/Registro/Salud/Descargar; línea fina con el conteo en todas.');
  /* El despliegue lista cada trabajo con su Detener, y el
     Detener FUNCIONA (la solicitud queda retenida: Reanudar). */
  await page.evaluate(() => navigate('invoices'));
  await page.waitForTimeout(800);
  await page.click('#barra-trabajos299');
  await page.waitForTimeout(400);
  const despliegue = await page.evaluate(() => {
    const lista = document.getElementById('barra-trabajos-lista299');
    return { visible: Boolean(lista) && !lista.hidden && lista.getClientRects().length > 0,
      detener: lista ? [...lista.querySelectorAll('button')].filter(b => b.textContent === 'Detener').length : 0,
      texto: lista ? lista.textContent.replace(/\s+/g, ' ').trim() : '' };
  });
  assert.equal(despliegue.visible, true, 'D1: la línea despliega la lista de trabajos vivos');
  assert.equal(despliegue.detener, 2, 'D1: cada trabajo vivo trae su Detener (2) — botones: ' + despliegue.texto.slice(0, 160));
  await page.evaluate(() => {
    const lista = document.getElementById('barra-trabajos-lista299');
    [...lista.querySelectorAll('button')].find(b => b.textContent === 'Detener').click();
  });
  await page.waitForTimeout(2500);
  await page.evaluate(() => { paintActivity(); });
  const trasDetener = await page.evaluate(() => {
    const lista = document.getElementById('barra-trabajos-lista299');
    if (lista && lista.hidden) document.getElementById('barra-trabajos299').click();
    return lista ? lista.textContent.replace(/\s+/g, ' ').trim() : '';
  });
  assert.ok(trasDetener.includes('Reanudar'),
    'D1: el Detener de la línea retiene el trabajo (queda en pausa con su Reanudar) — lista: ' + trasDetener.slice(0, 200));
  console.log('OK 2.9.9 · D1 (freno) — despliegue con un Detener por trabajo y detención efectiva (Reanudar).');

  /* ===== D4b · En Hoy el lateral no repite puerta/buzón/declaraciones ===== */
  await page.evaluate(() => navigate('home'));
  await page.waitForTimeout(1500);
  const enHoy = await page.evaluate(() => {
    senalesBarra1311();
    const v = id => { const el = document.getElementById(id);
      return Boolean(el) && !el.hidden && el.getClientRects().length > 0; };
    return { puerta: v('puerta-txt'), buzon: v('buzon-menu-estado202'), decl: v('decl-menu-estado202') };
  });
  assert.deepEqual(enHoy, { puerta: false, buzon: false, decl: false },
    'D4b: en Hoy el lateral NO repite puerta/buzón/declaraciones (viven en sus tarjetas de Hoy)');
  await page.evaluate(() => navigate('invoices'));
  await page.waitForTimeout(800);
  const fueraHoy = await page.evaluate(() => {
    senalesBarra1311();
    const v = id => { const el = document.getElementById(id);
      return Boolean(el) && !el.hidden && el.getClientRects().length > 0; };
    return { puerta: v('puerta-txt'), buzon: v('buzon-menu-estado202'), decl: v('decl-menu-estado202') };
  });
  assert.deepEqual(fueraHoy, { puerta: true, buzon: true, decl: true },
    'D4b: fuera de Hoy el lateral conserva sus chips (paridad)');
  console.log('OK 2.9.9 · D4b — Hoy sin chips duplicados del lateral; el resto de pantallas, como siempre.');

  /* ===== D4a · Declaraciones: UNA sola lista de folios ===== */
  await page.evaluate(() => navigate('declaraciones'));
  await page.waitForFunction(() => document.body.innerText.includes('OP299001'), null, { timeout: 20000 });
  await page.waitForTimeout(800);
  const decl = await page.evaluate(() => {
    const listas = [...document.querySelectorAll('[data-decl-lista299]')];
    const filaDe = op => listas[0]?.querySelector('[data-operacion="' + op + '"]');
    const botones = f => f ? [...f.querySelectorAll('button')].map(b => b.textContent) : [];
    const f1 = filaDe('OP299001'), f2 = filaDe('OP299002');
    return { numListas: listas.length,
      titulosViejos: ['Línea de vida de cada declaración', 'Folios de tus acuses']
        .filter(t => document.body.innerText.includes(t)),
      f1: f1 ? { texto: f1.textContent.replace(/\s+/g, ' ').trim(), botones: botones(f1) } : null,
      f2: f2 ? { texto: f2.textContent.replace(/\s+/g, ' ').trim(), botones: botones(f2) } : null };
  });
  assert.equal(decl.numListas, 1, 'D4a: los folios viven en UNA sola lista (contenedores: ' + decl.numListas + ')');
  assert.deepEqual(decl.titulosViejos, [], 'D4a: fuera los títulos de las listas fundidas');
  assert.ok(decl.f1, 'D4a: la operación OP299001 tiene su fila en la lista única');
  assert.ok(decl.f1.texto.includes('2026-10') && decl.f1.texto.includes('Presentada'),
    'D4a: la fila conserva periodo y su línea de presentación — «' + decl.f1.texto.slice(0, 200) + '»');
  assert.ok(decl.f1.botones.includes('Ver acuse'), 'D4a: la fila conserva «Ver acuse» — ' + decl.f1.botones.join(','));
  assert.ok(/Declaración guardada|Ver declaración/.test(decl.f1.texto + decl.f1.botones.join(',')),
    'D4a: la fila dice si hay declaración guardada');
  assert.ok(decl.f2, 'D4a: el folio OP299002 (sin acuse) tiene su fila');
  assert.ok(decl.f2.botones.includes('Borrar'), 'D4a: la fila conserva «Borrar» — ' + decl.f2.botones.join(','));
  assert.ok(decl.f2.botones.includes('Reimprimir el acuse'), 'D4a: y «Reimprimir el acuse» del panel de folios');
  console.log('OK 2.9.9 · D4a — una sola lista; OP299001 con Ver acuse y OP299002 con Borrar/Reimprimir.');
  /* Borrar funciona desde la lista única. */
  await page.evaluate(() => {
    const f = document.querySelector('[data-decl-lista299] [data-operacion="OP299002"]');
    [...f.querySelectorAll('button')].find(b => b.textContent === 'Borrar').click();
  });
  await page.waitForTimeout(2500);
  const trasBorrar = await page.evaluate(() =>
    Boolean(document.querySelector('[data-decl-lista299] [data-operacion="OP299002"]')));
  assert.equal(trasBorrar, false, 'D4a: «Borrar» de la lista única borra el folio (la fila desaparece)');
  console.log('OK 2.9.9 · D4a (borrar) — el folio OP299002 sale de la lista al borrarlo.');

  /* ===== D4c · Cobertura: una vista principal y dos «ver más» ===== */
  const cob = await page.evaluate(() => {
    satData.coverage = { groups: [], gaps: [], days: { AAA010101AAA: { received: ['2026-11-02'], issued: [] } },
      records: [{ rfc: 'AAA010101AAA', direction: 'received', total: 3, first: '2026-09', last: '2026-11',
        months: [{ month: '2026-09', count: 3, descarga: 3 }] }],
      metadata: undefined };
    satData.metadata = { records: 0, missing: [], lastSeen: null };
    const host = document.createElement('div'); document.body.append(host);
    host.append(...coberturaPaneles280(true));
    const anillo = host.querySelector('svg.cov-ring');
    const detDe = txt => [...host.querySelectorAll('details')]
      .find(d => d.querySelector('summary')?.textContent.includes(txt));
    const detTabla = detDe('Tabla mes a mes');
    const detCalor = detDe('Mapa de calor');
    const r = { anilloVisible: Boolean(anillo) && anillo.getClientRects().length > 0,
      tablaEnVerMas: Boolean(detTabla), tablaAbierta: detTabla ? detTabla.open : null,
      calorEnVerMas: Boolean(detCalor), calorAbierto: detCalor ? detCalor.open : null,
      /* checkVisibility: el contenido de un <details> cerrado conserva
         geometría en Chromium pero no se pinta; esa es la sonda honesta. */
      calorVisibleSinAbrir: [...host.querySelectorAll('.panel')]
        .some(p => p.textContent.includes('Cobertura de solicitudes al SAT') && p.checkVisibility()) };
    window.__cob299 = { host, detTabla, detCalor };
    return r;
  });
  assert.equal(cob.anilloVisible, true, 'D4c: la vista principal es el anillo de «Qué meses tienes» (tenencia real, mes a mes)');
  assert.ok(cob.tablaEnVerMas && cob.tablaAbierta === false,
    'D4c: la tabla mes a mes vive tras su «ver más», cerrada al entrar');
  assert.ok(cob.calorEnVerMas && cob.calorAbierto === false && !cob.calorVisibleSinAbrir,
    'D4c: el mapa de calor vive tras su «ver más», cerrado al entrar');
  const calorAbierto = await page.evaluate(() => {
    const { detCalor } = window.__cob299;
    detCalor.querySelector('summary').click();
    const panel = [...detCalor.querySelectorAll('.panel')]
      .find(p => p.textContent.includes('Cobertura de solicitudes al SAT'));
    return Boolean(panel) && panel.checkVisibility();
  });
  assert.equal(calorAbierto, true, 'D4c: tras su «ver más», el mapa de calor se ve (nada inalcanzable)');
  console.log('OK 2.9.9 · D4c — anillo principal; tabla y mapa de calor tras «ver más» nombrados y alcanzables.');
} finally {
  await browser.close();
  service.close();
  server.close();
}
console.log('OK suite ronda299diseno completa');
