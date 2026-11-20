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
   Ronda 2.9.16 · NAVEGADOR — la tanda de Paco en Chromium real:

   (P1) El menú enseña los cuatro bloques y «Más» nace
       plegado: sus destinos no se ven hasta abrirlo, el
       estado se recuerda y navegar a un destino suyo lo abre
       solo.
   (P2) Hoy abre con «Tus tareas» como primer panel (aquí,
       con un trabajo atascado sembrado: su fila «Requiere
       atención» manda) y el mando va después.
   (P3) Salud ordena sus tarjetas en pisos (acción → vigilar
       → bien) y ninguna tarjeta queda fuera de su piso.
   (P5) Facturas: la franja es fija (sticky), la tabla ya no
       trae la columna «Tipo» y el detalle se abre como ficha
       lateral a todo el alto; al cerrar, el diálogo no
       conserva el ancla. Registro: los selectores de
       contribuyente y de clase EXISTEN en la pantalla (el
       defecto cazado en la ronda: funcionaban sin verse).
   (P6) Los cuatro chips canónicos se distinguen sin color:
       palabra, icono y borde distintos (con la escena en
       escala de grises aplicada).
   (P7) Una sesión de solo lectura (usuario con nombre de la
       2.9.8) no ve la acción principal, ni «Agregar RFC», ni
       importar; su línea de sesión dice quién es y su
       alcance; sus tareas no traen gestos de administración
       (que en la sesión del propietario sí están).
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
const dir = mkdtempSync(join(tmpdir(), 'pacosat-2916-nav-'));
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

const invoice = (id, date, from, to, total, folio) => ({ id, date, kind: 'I',
  from: { rfc: from, name: 'EMPRESA ' + from }, to: { rfc: to, name: 'EMPRESA ' + to },
  total, currency: 'MXN', fiscal: { series: 'A', folio, paymentMethod: 'PPD',
    transferred: [{ tax: '002', rate: '0.160000', amount: '0.00' }], withheld: [] } });

{
  service = makeService(); service.close();
  const db = new DatabaseSync(dbFile);
  db.prepare('INSERT INTO profiles(rfc, minutes, days, direction, nextRun, error) VALUES (?,?,?,?,?,?)')
    .run(OWN, 1440, 30, 'both', 0, '');
  db.prepare("INSERT INTO records(store,id,value) VALUES ('people',?,?)")
    .run(OWN, JSON.stringify({ id: OWN, name: 'Empresa de Prueba, S.A.' }));
  const rec = db.prepare("INSERT INTO records(store,id,value) VALUES ('invoices',?,?)");
  rec.run('11111111-2222-3333-4444-555555555555', JSON.stringify(invoice('11111111-2222-3333-4444-555555555555', '2026-11-05', PROV1, OWN, '1160.00', '100')));
  rec.run('22222222-3333-4444-5555-666666666666', JSON.stringify(invoice('22222222-3333-4444-5555-666666666666', '2026-11-09', PROV1, OWN, '2320.00', '101')));
  rec.run('33333333-4444-5555-6666-777777777777', JSON.stringify(invoice('33333333-4444-5555-6666-777777777777', '2026-11-12', OWN, PROV1, '580.00', '102')));
  db.prepare('INSERT INTO jobs(rfc, direction, kind, periodStart, periodEnd, startAt, endAt, requestId, status, due, created, held) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(OWN, 'received', 'cfdi', '2026-11-01', '2026-11-16', '2026-11-01 00:00:00', '2026-11-16 23:59:59', 'req-atascada', 'pending', TIME - 3600000, TIME - 3 * 3600000, 0);
  /* Sucesos del Registro sembrados (30, con textos distintos
     para que no se agrupen): la lista larga de verdad, como
     en la casa de Paco — sin ella, el div que envuelve la
     franja del Registro mide apenas 300 px y ningún sticky
     tiene recorrido que afirmar. */
  const act = db.prepare("INSERT INTO records(store,id,value) VALUES ('activity',?,?)");
  for (let i = 1; i <= 30; i++)
    act.run('semilla-reg-' + String(i).padStart(2, '0'), JSON.stringify({
      name: 'Suceso sembrado del Registro ' + String(i).padStart(2, '0'),
      at: TIME - i * 3600000, rfc: OWN, ok: true }));
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
/* La usuaria de solo lectura de la prueba (modelo 2.9.8). */
const creada = await call('POST', '/api/users', { nombre: 'Lectora Prueba', usuario: 'lectora',
  password: 'clave-lectora-2916', rol: 'lectura', rfcs: [OWN], contadora: false });
assert.equal(creada.status, 200, 'el principal crea a la usuaria de solo lectura');

const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.goto(ORIGIN + '/', { waitUntil: 'load' });
await page.waitForFunction(() => typeof navigate === 'function' && typeof satToken !== 'undefined' && Boolean(satToken), null, { timeout: 15000 });
await page.evaluate(rfc => { scope = rfc; }, OWN);

/* ── (P1) Menú: bloques, «Más» plegado y apertura al navegar ─ */
const navFoto = await page.evaluate(() => {
  const captions = [...document.querySelectorAll('.sidebar nav .nav-caption')].map(c => c.textContent.trim());
  const archivo = document.querySelector('.sidebar nav [data-view="archivo"]');
  return { captions, archivoVisible: archivo && getComputedStyle(archivo).display !== 'none',
    masExpanded: document.getElementById('nav-mas-btn2916')?.getAttribute('aria-expanded') };
});
assert.deepEqual(navFoto.captions.slice(0, 4), ['TRABAJO DIARIO', 'SAT', 'EXPEDIENTE', 'ADMINISTRACIÓN'],
  'los cuatro bloques abren el menú, en orden');
assert.equal(navFoto.archivoVisible, false, '«Más» nace plegado: Archivo no se ve');
assert.equal(navFoto.masExpanded, 'false', 'el botón de «Más» nace con aria-expanded=false');
await page.click('#nav-mas-btn2916');
const trasAbrir = await page.evaluate(() => getComputedStyle(document.querySelector('.sidebar nav [data-view="archivo"]')).display);
assert.notEqual(trasAbrir, 'none', 'al tocar «Más», sus destinos se ven');
await page.click('#nav-mas-btn2916');
await page.evaluate(() => navigate('archivo'));
const trasNavegar = await page.evaluate(() => ({
  expanded: document.getElementById('nav-mas-btn2916')?.getAttribute('aria-expanded'),
  visible: getComputedStyle(document.querySelector('.sidebar nav [data-view="archivo"]')).display !== 'none' }));
assert.equal(trasNavegar.expanded, 'true', 'navegar a un destino de «Más» lo abre solo');
assert.equal(trasNavegar.visible, true, 'el destino navegado queda visible en el menú');
console.log('2916nav P1 menú: ok');

/* ── (P2) Hoy: «Tus tareas» manda ─────────────────────────── */
await page.evaluate(() => navigate('home'));
await page.waitForFunction(() => {
  const p = document.querySelector('.page .panel.tareas2916');
  return p && p.querySelector('.tarea-fila2916');
}, null, { timeout: 20000 });
const hoyFoto = await page.evaluate(() => {
  const panels = [...document.querySelectorAll('.page .panel')];
  const tareas = document.querySelector('.page .panel.tareas2916');
  const titulosGestos = gestosLista1311().map(g => g.titulo);
  return { primeroEsTareas: panels[0] === tareas,
    filas: tareas.querySelectorAll('.tarea-fila2916').length,
    gestosDentro: titulosGestos.filter(t => tareas.textContent.includes(t)).length,
    gestosTotal: titulosGestos.length };
});
assert.equal(hoyFoto.primeroEsTareas, true, '«Tus tareas» es el primer panel de Hoy');
assert.ok(hoyFoto.filas >= 1, 'la lista trae filas reales');
assert.equal(hoyFoto.gestosDentro, hoyFoto.gestosTotal,
  'en la sesión del propietario, todos los gestos viven dentro de «Tus tareas»');
console.log('2916nav P2 hoy: ok');

/* ── (P3) Salud en tres pisos ─────────────────────────────── */
await page.evaluate(() => navigate('salud'));
await page.waitForFunction(() => document.querySelectorAll('[data-piso2916]').length >= 1 &&
  document.querySelectorAll('.salud-card2913').length >= 3, null, { timeout: 20000 });
const saludFoto = await page.evaluate(() => {
  const pisos = [...document.querySelectorAll('[data-piso2916]')].map(s => s.dataset.piso2916);
  const tarjetas = [...document.querySelectorAll('.salud-card2913')];
  const fuera = tarjetas.filter(c => !c.closest('[data-piso2916]')).length;
  const conPaso = tarjetas.filter(c => c.textContent.includes('Siguiente paso:')).length;
  /* Corrección tras la verificación en vivo: el piso de
     acción existe siempre; las cuentas de las cabeceras
     salen de las píldoras de las propias tarjetas; y el
     veredicto nombra las mismas partes que el piso cuenta. */
  const seccion = clave => document.querySelector('[data-piso2916="' + clave + '"]');
  const cuentaCab = clave => { const s = seccion(clave);
    const m = s && s.querySelector('.salud-piso-cab2916 span')?.textContent.match(/\d+/);
    return m ? +m[0] : null; };
  const porPildora = { Mal: 0, 'A vigilar': 0, 'Sin dato': 0, Bien: 0 };
  for (const c of tarjetas) {
    const p = c.querySelector('.salud-estado2913')?.textContent.trim();
    if (p in porPildora) porPildora[p]++;
  }
  const veredicto = document.querySelector('[data-veredicto240]')?.textContent || '';
  const mV = veredicto.match(/(\d+) piezas? a vigilar/);
  const mS = veredicto.match(/(\d+) sin dato/);
  return { pisos, total: tarjetas.length, fuera, conPaso,
    pisoAccion: !!seccion('mal'),
    calma: seccion('mal')?.textContent.includes('Nada requiere tu acción ahora.') || false,
    malTarjetas: seccion('mal')?.querySelectorAll('.salud-card2913').length || 0,
    cab: { mal: cuentaCab('mal'), vigilar: cuentaCab('vigilar'), bien: cuentaCab('bien') },
    porPildora, verVig: mV ? +mV[1] : 0, verSin: mS ? +mS[1] : 0 };
});
/* Las cabeceras cuentan las piezas del piso ENTERAS y la
   rejilla corta a 10 con «Ver más»: para cotejar cabecera
   contra píldoras se despliega todo primero. */
for (let i = 0; i < 6; i++) {
  const hayMas = await page.evaluate(() => {
    const b = [...document.querySelectorAll('.table-foot button')]
      .find(x => x.textContent.includes('Ver más'));
    if (b) { b.click(); return true; } return false;
  });
  if (!hayMas) break;
  await espera(350);
}
const saludCuentas = await page.evaluate(() => {
  const seccion = clave => document.querySelector('[data-piso2916="' + clave + '"]');
  const cuentaCab = clave => { const s = seccion(clave);
    const m = s && s.querySelector('.salud-piso-cab2916 span')?.textContent.match(/\d+/);
    return m ? +m[0] : null; };
  const porPildora = { Mal: 0, 'A vigilar': 0, 'Sin dato': 0, Bien: 0 };
  for (const c of document.querySelectorAll('.salud-card2913')) {
    const p = c.querySelector('.salud-estado2913')?.textContent.trim();
    if (p in porPildora) porPildora[p]++;
  }
  const veredicto = document.querySelector('[data-veredicto240]')?.textContent || '';
  const mV = veredicto.match(/(\d+) piezas? a vigilar/);
  const mS = veredicto.match(/(\d+) sin dato/);
  return { cab: { mal: cuentaCab('mal'), vigilar: cuentaCab('vigilar'), bien: cuentaCab('bien') },
    porPildora, verVig: mV ? +mV[1] : 0, verSin: mS ? +mS[1] : 0 };
});
const ordenPisos = ['mal', 'vigilar', 'bien'];
assert.deepEqual(saludFoto.pisos, ordenPisos.filter(p => saludFoto.pisos.includes(p)),
  'los pisos presentes van en orden: acción → vigilar → bien (' + saludFoto.pisos.join(', ') + ')');
assert.ok(saludFoto.pisos.length >= 2, 'hay al menos dos pisos con la foto sembrada');
assert.equal(saludFoto.fuera, 0, 'ninguna tarjeta queda fuera de su piso');
assert.ok(saludFoto.conPaso >= 1, 'las tarjetas sin botón dicen su siguiente paso');
assert.equal(saludFoto.pisoAccion, true, 'el piso «Requiere tu acción» existe siempre, aunque esté vacío');
if (!saludFoto.malTarjetas) assert.equal(saludFoto.calma, true,
  'sin piezas en mal, el piso de acción lo dice con su línea calma');
assert.equal(saludCuentas.cab.mal, saludCuentas.porPildora.Mal, 'la cabecera del piso de acción cuenta sus piezas');
if (saludCuentas.cab.vigilar !== null) assert.equal(saludCuentas.cab.vigilar,
  saludCuentas.porPildora['A vigilar'] + saludCuentas.porPildora['Sin dato'],
  'el piso «A vigilar» cuenta a vigilar + sin dato, como dicen sus tarjetas');
if (saludCuentas.cab.bien !== null) assert.equal(saludCuentas.cab.bien, saludCuentas.porPildora.Bien,
  'la cabecera de «Todo bien» cuenta sus piezas');
if (!saludCuentas.porPildora.Mal && (saludCuentas.porPildora['A vigilar'] + saludCuentas.porPildora['Sin dato']) > 0) {
  assert.equal(saludCuentas.verVig, saludCuentas.porPildora['A vigilar'],
    'el veredicto nombra las mismas piezas a vigilar que cuenta el piso');
  assert.equal(saludCuentas.verSin, saludCuentas.porPildora['Sin dato'],
    'el veredicto nombra las piezas sin dato que el piso incluye en su cuenta');
}
console.log('2916nav P3 salud: ok');

/* ── (P5) Facturas: franja fija, sin «Tipo», ficha lateral ── */
await page.evaluate(() => navigate('invoices'));
await page.waitForFunction(() => document.querySelector('.grid-table tbody tr'), null, { timeout: 15000 });
const factFoto = await page.evaluate(() => {
  const franja = document.querySelector('.franja2916');
  const ths = [...document.querySelectorAll('.grid-table thead th')].map(th => th.textContent.replace(/ [↓↑]$/, ''));
  /* Corrección tras la verificación en vivo: la franja nace
     visible — directamente bajo la tarjeta protagonista y
     por encima de la gráfica —, no solo pegajosa al llegar. */
  const ppd = document.querySelector('[data-ppd240]');
  const graf = document.querySelector('.facturas-graficos2913');
  const tras = (a, b) => a && b &&
    (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
  return { sticky: franja ? getComputedStyle(franja).position : '', ths,
    bajoProtagonista: tras(ppd, franja), sobreGrafica: tras(franja, graf),
    franjaEnPantalla: franja ? franja.getBoundingClientRect().top < window.innerHeight : false };
});
assert.equal(factFoto.sticky, 'sticky', 'la franja de Facturas es fija al hacer scroll');
assert.equal(factFoto.bajoProtagonista, true, 'la franja va directamente debajo de la tarjeta «PPD sin REP»');
assert.equal(factFoto.sobreGrafica, true, 'la franja va por encima de la gráfica y los totales');
assert.equal(factFoto.franjaEnPantalla, true, 'la franja se ve al entrar, sin bajar');
assert.deepEqual(factFoto.ths, ['', 'Fecha', 'Emisor → receptor', 'Folio', 'Total', 'Estado SAT', 'Acción'],
  'la tabla enseña las columnas del día, sin «Tipo»');
/* La franja AGARRA de verdad (segunda corrección tras la
   verificación en vivo): afirmar el CSS computado no bastó
   — pasaba con el sticky inerte, preso del overflow:hidden
   del panel —. Aquí se baja más de una pantalla sobre la
   tabla y se afirma el comportamiento: la franja sigue en
   el viewport, pegada arriba. */
await page.evaluate(() => window.scrollTo(0, 0));
await espera(250);
const franjaBase = await page.evaluate(() => {
  const f = document.querySelector('.franja2916');
  const r = f.getBoundingClientRect();
  return { docTop: r.top + window.scrollY, vh: window.innerHeight };
});
await page.evaluate(f => window.scrollTo(0, f.docTop + f.vh), franjaBase);
await espera(350);
const franjaPegada = await page.evaluate(() => {
  const f = document.querySelector('.franja2916');
  const r = f.getBoundingClientRect();
  const cs = getComputedStyle(f);
  return { scrollY: window.scrollY, top: r.top, bottom: r.bottom,
    visible: r.bottom > 0 && r.top < window.innerHeight && cs.display !== 'none' && cs.visibility !== 'hidden' };
});
assert.ok(franjaPegada.scrollY >= franjaBase.vh,
  'se bajó al menos una pantalla entera sobre la tabla (scrollY=' + Math.round(franjaPegada.scrollY) + ')');
assert.ok(franjaPegada.scrollY > franjaBase.docTop,
  'se bajó más allá de donde la franja nace: sin un sticky que agarre, estaría fuera de pantalla');
assert.ok(Math.abs(franjaPegada.top) <= 1,
  'la franja queda pegada arriba del viewport (top=' + Math.round(franjaPegada.top) + ')');
assert.equal(franjaPegada.visible, true, 'la franja sigue visible en el viewport tras el scroll');
await page.evaluate(() => window.scrollTo(0, 0));
await espera(250);
console.log('2916nav P5 facturas scroll: ok');
await page.click('.grid-table tbody tr button.cell-link-total');
await page.waitForFunction(() => document.querySelector('dialog')?.open &&
  document.querySelector('dialog').classList.contains('cfdi-dialog'), null, { timeout: 15000 });
await espera(450); /* la animación de entrada de la ficha, terminada: se mide la geometría final */
const fichaFoto = await page.evaluate(() => {
  const dlg = document.querySelector('dialog');
  const r = dlg.getBoundingClientRect();
  return { right: Math.round(r.right), top: Math.round(r.top), height: Math.round(r.height),
    vw: window.innerWidth, vh: window.innerHeight };
});
assert.ok(Math.abs(fichaFoto.right - fichaFoto.vw) <= 2, 'la ficha toca el borde derecho');
assert.ok(fichaFoto.top <= 1 && Math.abs(fichaFoto.height - fichaFoto.vh) <= 2, 'la ficha va a todo el alto');
await page.keyboard.press('Escape');
await espera(400);
const trasCerrar = await page.evaluate(() => {
  const dlg = document.querySelector('dialog');
  return { open: dlg.open, clases: dlg.classList.contains('cfdi-dialog') || dlg.classList.contains('invoice-dialog') };
});
assert.equal(trasCerrar.open, false, 'la ficha se cierra con Esc');
assert.equal(trasCerrar.clases, false, 'al cerrar, el diálogo no conserva el ancla de la ficha');
console.log('2916nav P5 facturas: ok');

/* ── (P5) Registro: los filtros, por fin en pantalla ─────── */
await page.evaluate(() => navigate('registro'));
await page.waitForFunction(() => [...document.querySelectorAll('.page select')]
  .some(s => [...s.options].some(o => o.textContent === 'Solo fallos')), null, { timeout: 20000 });
const regFoto = await page.evaluate(() => {
  const selects = [...document.querySelectorAll('.page select')];
  const textos = selects.flatMap(s => [...s.options].map(o => o.textContent));
  const franja = document.querySelector('.franja2916');
  return { contribuyentes: textos.includes('Todos los contribuyentes'),
    clase: textos.includes('Solo conexiones') && textos.includes('Solo fallos'),
    orden: textos.includes('Orden: más antiguos primero'),
    sticky: franja ? getComputedStyle(franja).position : '' };
});
assert.equal(regFoto.contribuyentes, true, 'el selector de contribuyente EXISTE en la pantalla');
assert.equal(regFoto.clase, true, 'el selector de clase EXISTE en la pantalla');
assert.equal(regFoto.orden, true, 'el selector de orden existe');
assert.equal(regFoto.sticky, 'sticky', 'la franja del Registro también es fija');
/* Y agarra, con el mismo mecanismo (segunda corrección):
   con la lista sembrada larga, se baja más de una pantalla
   sobre los sucesos y la franja sigue en el viewport,
   pegada arriba — la misma afirmación que en Facturas. */
await page.evaluate(() => window.scrollTo(0, 0));
await espera(250);
const regBase = await page.evaluate(() => {
  const f = document.querySelector('.franja2916');
  const r = f.getBoundingClientRect();
  return { docTop: r.top + window.scrollY, vh: window.innerHeight };
});
await page.evaluate(f => window.scrollTo(0, f.docTop + f.vh), regBase);
await espera(350);
const regPegada = await page.evaluate(() => {
  const f = document.querySelector('.franja2916');
  const r = f.getBoundingClientRect();
  const cs = getComputedStyle(f);
  return { scrollY: window.scrollY, top: r.top, bottom: r.bottom,
    visible: r.bottom > 0 && r.top < window.innerHeight && cs.display !== 'none' && cs.visibility !== 'hidden' };
});
assert.ok(regPegada.scrollY >= regBase.vh,
  'se bajó al menos una pantalla entera sobre los sucesos (scrollY=' + Math.round(regPegada.scrollY) + ')');
assert.ok(regPegada.scrollY > regBase.docTop,
  'se bajó más allá de donde la franja del Registro nace: sin un sticky que agarre, estaría fuera de pantalla');
assert.ok(Math.abs(regPegada.top) <= 1,
  'la franja del Registro queda pegada arriba del viewport (top=' + Math.round(regPegada.top) + ')');
assert.equal(regPegada.visible, true, 'la franja del Registro sigue visible en el viewport tras el scroll');
await page.evaluate(() => window.scrollTo(0, 0));
await espera(250);
console.log('2916nav P5 registro: ok');

/* ── (P6) Estados sin color: palabra, icono y borde ──────── */
const estadosFoto = await page.evaluate(() => {
  const caja = document.createElement('div');
  caja.style.filter = 'grayscale(1)';
  caja.style.position = 'fixed'; caja.style.top = '0'; caja.style.left = '0'; caja.style.zIndex = '9999';
  document.body.append(caja);
  const claves = ['pendiente', 'en-proceso', 'atencion', 'completado'];
  const salida = {};
  for (const clave of claves) {
    const chip = estadoChip2915(clave, ESTADOS2915[clave].etiqueta, false);
    caja.append(chip);
    const cs = getComputedStyle(chip);
    salida[clave] = { borde: cs.borderTopStyle, grueso: cs.borderTopWidth,
      icono: chip.querySelector('use')?.getAttribute('href'), texto: chip.textContent.trim() };
  }
  const grave = estadoChip2915('atencion', 'Requiere atención', true);
  caja.append(grave);
  const cg = getComputedStyle(grave);
  salida.grave = { borde: cg.borderTopStyle, grueso: cg.borderTopWidth };
  caja.remove();
  return salida;
});
assert.equal(estadosFoto.pendiente.borde, 'dashed', 'Pendiente: borde punteado');
assert.equal(estadosFoto['en-proceso'].borde, 'solid', 'En proceso: borde continuo');
assert.equal(estadosFoto.atencion.borde, 'solid', 'Requiere atención: borde continuo');
assert.equal(estadosFoto.grave.borde, 'double', 'Requiere atención GRAVE: borde doble');
assert.equal(estadosFoto.completado.borde, 'solid', 'Completado: borde continuo');
assert.equal(new Set(Object.values(estadosFoto).map(e => e.icono).filter(Boolean)).size, 4,
  'cuatro iconos distintos en escala de grises');
assert.equal(new Set(['pendiente', 'en-proceso', 'atencion', 'completado'].map(k => estadosFoto[k].texto)).size, 4,
  'cuatro palabras distintas');
console.log('2916nav P6 estados: ok');

/* ── (P7) La sesión de solo lectura se ajusta a su alcance ── */
/* La página del arnés se sirve con el token del principal
   incrustado (así entra su dueño); la de un usuario con
   nombre se sirve SIN él — su token es el de su login —.
   Se reproduce sirviendo el mismo HTML sin la meta del
   token antes de entrar como la lectora. */
const htmlServido = await raw('GET', '/');
const htmlSinToken = htmlServido.text.replace(/<meta name="pacosat-token"[^>]*>/, '');
assert.ok(htmlSinToken !== htmlServido.text, 'la meta del token principal se retira para la sesión con nombre');
await page.route(ORIGIN + '/', async route => {
  if (route.request().resourceType() === 'document')
    await route.fulfill({ contentType: 'text/html', body: htmlSinToken });
  else await route.continue();
});
await page.reload({ waitUntil: 'load' });
await page.evaluate(async () => {
  const response = await fetch('/api/users/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usuario: 'lectora', password: 'clave-lectora-2916' }) });
  const data = await response.json();
  sessionStorage.setItem('pacosat-guest-token', data.token);
  sessionStorage.setItem('pacosat-user-session', JSON.stringify({ nombre: data.nombre, rol: data.rol }));
  location.reload();
});
await page.waitForFunction(() => typeof navigate === 'function' && typeof satToken !== 'undefined' && Boolean(satToken), null, { timeout: 15000 });
await page.waitForFunction(() => {
  const l = document.getElementById('sesion-line2916');
  return l && !l.hidden && l.textContent.includes('Solo lectura');
}, null, { timeout: 15000 });
await page.evaluate(() => navigate('home'));
await page.waitForFunction(() => document.querySelector('.page .panel.tareas2916'), null, { timeout: 20000 });
const perfilFoto = await page.evaluate(async () => {
  const alcance = typeof sesionAlcance2916 === 'function' ? sesionAlcance2916() : null;
  const tareas = document.querySelector('.page .panel.tareas2916');
  const titulosGestos = gestosLista1311().map(g => g.titulo);
  return { primaryHidden: document.getElementById('primary').hidden,
    addHidden: document.getElementById('add').hidden,
    inspectHidden: document.getElementById('inspect').hidden,
    linea: document.getElementById('sesion-line2916').textContent,
    tipo: alcance?.tipo, rfcs: alcance?.rfcs,
    destinos: document.querySelectorAll('.sidebar nav [data-view]').length,
    gestosEnTareas: tareas ? titulosGestos.filter(t => tareas.textContent.includes(t)).length : -1 };
});
assert.equal(perfilFoto.primaryHidden, true, 'la acción principal no se enseña en solo lectura');
assert.equal(perfilFoto.addHidden, true, '«Agregar RFC» no se enseña en solo lectura');
assert.equal(perfilFoto.inspectHidden, true, 'importar no se enseña en solo lectura');
assert.ok(perfilFoto.linea.includes('Lectora Prueba'), 'la línea de sesión nombra a la usuaria');
assert.equal(perfilFoto.tipo, 'lectura', 'el alcance leído es «lectura»');
assert.deepEqual(perfilFoto.rfcs, [OWN], 'su alcance es el RFC dado de alta');
assert.equal(perfilFoto.destinos, 21, 'los 21 destinos siguen en su menú: consultar no pierde pantallas');
assert.equal(perfilFoto.gestosEnTareas, 0, 'sus tareas no traen gestos de administración');
console.log('2916nav P7 perfil: ok');

await browser.close();
service.close(); server.close();
console.log('ronda2916navegador: OK — menú, tareas, pisos, ficha, filtros del Registro, estados sin color y perfil, en Chromium real.');
