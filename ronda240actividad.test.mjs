/* ================================================================
   Ronda 2.4.0 · W1 — P3 «que sepa lo que ocurre cada momento» y el
   DEFECTO NOMBRADO por Paco (17 nov, en vivo sobre la 2.3.1): en
   Hoy, «Solicitudes de descarga en el SAT · 2 en curso» salía con
   «lleva 0 s» CONGELADO y sin ningún botón para detener.

   (a) activityOverview: cada solicitud viva sale UNA A UNA con
       su marca REAL de creación (jobs.created), estado
       «esperando al SAT desde hace X» con X > 0 si lleva minutos
       creada, su jobId y su Detener (canStop + stopLabel).
   (b) Detener desde Actividad ejecuta la MISMA retención que el
       gesto de retener/pausar de siempre (held=1, verificado en
       la base en frío, igual que pausar la otra solicitud) y
       deja asiento en el Registro (audit) con qué se detuvo y
       su id; la retenida sale de «en curso» y queda en pausa
       con su Reanudar.
   (c) Las tarjetas de actividad pintan su gesto de parada para
       CADA kind de una respuesta de juguete: «Detener» para la
       solicitud del SAT y «Cancelar» para el resto, y
       «Reanudar» para la retenida (canResume).
   (d) El texto llano («el SAT la prepara igual; PacoSAT deja de
       recogerla y sale de tu actividad») viaja en la entrada del
       servidor (note/stopExplain), en la respuesta del control
       (message) y se lee en la tarjeta pintada.
   (e) P3: Declaraciones fija su recuperación arriba con su
       Cancelar, y Buzón (Recibidos) fija arriba el trabajo vivo
       de su RFC con su gesto de parada.
   ================================================================ */

import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { URL as NodeURL } from 'node:url';
import { createPacoSATService } from './local-server.mjs';

const ROOT = import.meta.dirname;
const read = name => readFileSync(join(ROOT, name), 'utf8');
const html = read('Faro-Fiscal.html');
/* RE-BASE integración 2.4.0 (W6/W6b): paintActivity y
   declaracionesScreen viven hoy en las partes diferidas de
   Vigilancia y Declaraciones. El arnés sirve las partes desde
   lazy.json por el fetch y el head EJECUTA los scripts
   inyectados, como el navegador con el cargador real (patrón de
   tests/ronda240diferidas): ninguna aserción cambia, solo el
   arranque aprende a traer las partes. */
const lazy = JSON.parse(read('lazy.json'));
const ORIGIN = 'http://127.0.0.1:43741';
const PROXY = 'proxy-salidas';
const TIME = Date.parse('2026-11-25T18:00:00Z');
const OWN = 'AAA010101AAA';
const GUIA = 'el SAT la prepara igual; PacoSAT deja de recogerla y sale de tu actividad';

const makeService = dbFile => createPacoSATService({ dbFile, html: '<!--PACOSAT_TOKEN-->', origin: ORIGIN,
  proxyKey: PROXY, now: () => TIME,
  makeConnector: async () => ({ connector: {
    request: async () => 'req-juguete',
    check: async () => ({ status: 'pending', packages: [] }),
    download: async () => { throw new Error('sin paquetes de juguete'); } } }),
  makeMailer: () => ({ verify: async () => true, sendMail: async () => ({ messageId: 'm-juguete' }) }) });

function harness(service) {
  let token;
  const call = async (path, data) => {
    const headers = { host: new URL(ORIGIN).host, origin: ORIGIN, 'x-pacosat-token': token, 'x-pacosat-proxy': PROXY };
    const req = Object.assign(Readable.from(data === undefined ? [] : [Buffer.from(JSON.stringify(data))]), {
      url: path, method: data === undefined ? 'GET' : 'POST', headers });
    let response;
    const res = { setHeader() {}, writeHead(status) { this.status = status; this.headersSent = true; },
      end(content) { response = new Response(content, { status: this.status }); } };
    await service.handle(req, res);
    return response;
  };
  return { call, async login() {
    const page = await (await call('/')).text();
    token = page.match(/meta name="pacosat-token" content="([^"]+)"/)?.[1];
    assert.ok(token, 'token del servicio de juguete');
  } };
}

/* ===== Semilla: un perfil y DOS solicitudes vivas con su
   creación real en el pasado (7 min y 65 min antes de TIME) ===== */
const dir = mkdtempSync(join(tmpdir(), 'pacosat-240act-'));
const dbFile = join(dir, 'pacosat.sqlite');
let jobA, jobB;
{
  const service = makeService(dbFile);
  const { login } = harness(service);
  await login();
  service.close();
}
{
  const db = new DatabaseSync(dbFile);
  db.prepare('INSERT INTO profiles(rfc, minutes, days, direction, nextRun, error) VALUES (?,?,?,?,?,?)')
    .run(OWN, 1440, 30, 'both', 0, '');
  const ins = db.prepare("INSERT INTO jobs(rfc, direction, kind, periodStart, periodEnd, startAt, endAt, requestId, status, due, created, held) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)");
  jobA = Number(ins.run(OWN, 'received', 'cfdi', '2026-01-01', '2026-01-31', '2026-01-01 00:00:00', '2026-01-31 23:59:59', 'req-A', 'pending', TIME + 3600000, TIME - 7 * 60000, 0).lastInsertRowid);
  jobB = Number(ins.run(OWN, 'issued', 'cfdi', '2026-02-01', '2026-02-28', '2026-02-01 00:00:00', '2026-02-28 23:59:59', 'req-B', 'pending', TIME + 3600000, TIME - 65 * 60000, 0).lastInsertRowid);
  db.close();
}
const service = makeService(dbFile);
const { call, login } = harness(service);
await login();
const actividad = async () => (await (await call('/api/activity')).json());

/* ===== (a) Marca real y estado «esperando al SAT desde hace X» ===== */
{
  const antes = await actividad();
  const vivas = (antes.running || []).filter(e => e.kind === 'masiva');
  assert.equal(vivas.length, 2, '(a) cada solicitud viva es su propia entrada (no un agregado sin id)');
  const a = vivas.find(e => e.jobId === jobA);
  const b = vivas.find(e => e.jobId === jobB);
  assert.ok(a && b, '(a) ambas traen su jobId');
  assert.equal(a.since, TIME - 7 * 60000, '(a) since de A es su creación real, no la hora de la lectura');
  assert.equal(b.since, TIME - 65 * 60000, '(a) since de B es su creación real');
  assert.ok(TIME - a.since >= 7 * 60000 && TIME - b.since >= 65 * 60000, '(a) el tiempo esperando es > 0');
  assert.equal(a.state, 'esperando', '(a) su estado es «esperando» (al SAT), no un curso genérico');
  assert.match(a.detail, /esperando al SAT desde hace/, '(a) el detalle dice «esperando al SAT desde hace X»');
  assert.match(a.detail, /7 min/, '(a) y X son los 7 minutos reales de A');
  assert.match(b.detail, /1 h 05 min/, '(a) y la 1 h 05 min real de B');
  assert.ok(!/desde hace 0/.test(a.detail + b.detail), '(a) nunca «0 s» clavado');
  assert.equal(a.canStop, true, '(a) la solicitud viva SÍ se puede detener (retener)');
  assert.equal(a.stopLabel, 'Detener', '(a) su botón se llama «Detener»');
  /* (d) en la respuesta del servidor */
  assert.equal(a.stopExplain, GUIA, '(d) stopExplain es el texto guía exacto');
  assert.ok(String(a.note || '').includes(GUIA), '(d) la nota de la tarjeta lleva el texto guía');
  console.log('OK 2.4.0·W1 (a)+(d-servidor) — marca real, espera en vivo y Detener por solicitud.');
}

/* ===== (b) Detener = la misma retención (held=1) + asiento ===== */
{
  const det = await call('/api/activity/control', { kind: 'masiva', action: 'detener', jobId: jobA });
  assert.equal(det.status, 200, '(b) detener responde 200');
  const detJson = await det.json();
  assert.ok(String(detJson.message || '').includes(GUIA), '(d) la confirmación del control lleva el texto guía');
  /* La otra solicitud se retiene por el gesto de siempre (pausar):
     el estado resultante en la base debe ser EL MISMO. */
  const pau = await call('/api/activity/control', { kind: 'masiva', action: 'pausar', jobId: jobB });
  assert.equal(pau.status, 200, '(b) pausar (la retención de siempre) responde 200');
  const despues = await actividad();
  assert.ok(!(despues.running || []).some(e => e.jobId === jobA), '(b) la detenida sale de «en curso»');
  const retenida = (despues.paused || []).find(e => e.jobId === jobA);
  assert.ok(retenida && retenida.canResume, '(b) y queda en pausa, retenida, con su Reanudar');
  assert.equal(retenida.since, TIME - 7 * 60000, '(b) la retenida conserva su marca real (no since=ahora)');
  const registro = (await (await call('/api/registro')).json());
  const asiento = (registro.items || []).find(item => item.clase === 'accion' &&
    String(item.texto || '').includes('detuviste la solicitud de descarga ' + jobA));
  assert.ok(asiento, '(b) el Registro guarda el asiento de la detención, con su id');
  assert.ok(String(asiento.texto).includes(OWN), '(b) el asiento nombra el RFC de la solicitud');
  service.close();
  const db = new DatabaseSync(dbFile, { readOnly: true });
  assert.equal(db.prepare('SELECT held FROM jobs WHERE id=?').get(jobA).held, 1, '(b) A queda held=1 en frío');
  assert.equal(db.prepare('SELECT held FROM jobs WHERE id=?').get(jobB).held, 1,
    '(b) B (pausada por el gesto de siempre) queda held=1: MISMO estado resultante');
  assert.equal(db.prepare("SELECT status FROM jobs WHERE id=?").get(jobA).status, 'pending',
    '(b) retener no cancela ni borra: la solicitud sigue pendiente, es del SAT');
  db.close();
  console.log('OK 2.4.0·W1 (b) — Detener retiene igual que siempre (held=1) y deja asiento.');
}

/* ===== Arnés DOM (el de ronda200b) para (c), (d) y (e) ===== */
class BootURL extends NodeURL { static createObjectURL() { return 'blob:prueba'; } static revokeObjectURL() {} }
class FakeElement {
  constructor(tag = 'div') {
    this.tagName = String(tag).toUpperCase();
    this.children = []; this.dataset = {}; this.style = {}; this.attributes = {};
    this.textContent = ''; this.innerHTML = ''; this.value = '';
    this.hidden = false; this.disabled = false; this.open = false; this.files = [];
    const classes = new Set();
    this.classList = { add: (...n) => n.forEach(x => classes.add(x)),
      remove: (...n) => n.forEach(x => classes.delete(x)),
      toggle: (name, force) => { const on = force === undefined ? !classes.has(name) : Boolean(force);
        if (on) classes.add(name); else classes.delete(name); return on; },
      contains: name => classes.has(name) };
  }
  get childNodes() { return this.children; }
  append(...kids) { for (const k of kids) if (k instanceof FakeElement) this.children.push(k); }
  prepend(...kids) { for (const k of [...kids].reverse()) if (k instanceof FakeElement) this.children.unshift(k); }
  appendChild(k) { if (k instanceof FakeElement) this.children.push(k); return k; }
  insertBefore(k) { if (k instanceof FakeElement) this.children.push(k); return k; }
  removeChild(k) { this.children = this.children.filter(c => c !== k); return k; }
  replaceWith(...kids) { this.children = kids.filter(k => k instanceof FakeElement); }
  before() {} after() {} insertAdjacentElement(_w, k) { return k; }
  insertAdjacentHTML() {} insertAdjacentText() {}
  cloneNode() { return new FakeElement(this.tagName); }
  replaceChildren(...kids) { this.children = kids.filter(k => k instanceof FakeElement); }
  remove() {} click() {} close() {} showModal() {}
  setAttribute(n, v) { this.attributes[n] = String(v); }
  getAttribute(n) { return n in this.attributes ? this.attributes[n] : null; }
  removeAttribute(n) { delete this.attributes[n]; }
  hasAttribute(n) { return n in this.attributes; }
  addEventListener() {} removeEventListener() {}
  querySelector() { return null; } querySelectorAll() { return []; }
  closest() { return null; } focus() {} blur() {} scrollIntoView() {}
  getBoundingClientRect() { return { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 }; }
}
const storageStub = () => { const map = new Map();
  return { getItem: k => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)),
    removeItem: k => map.delete(k), clear: () => map.clear() }; };
function makeBootContext() {
  const byId = new Map();
  const metas = { 'meta[name="pacosat-token"]': { content: 'token-de-prueba' },
    'meta[name="pacosat-cloud"]': { content: '1' } };
  const headEl = new FakeElement('head');
  const documentStub = {
    getElementById: id => { if (!byId.has(id)) byId.set(id, new FakeElement('div')); return byId.get(id); },
    createElement: tag => new FakeElement(tag),
    createElementNS: (_ns, tag) => new FakeElement(tag),
    createTextNode: text => ({ textContent: String(text) }),
    querySelector: sel => metas[sel] ?? null,
    querySelectorAll: () => [], addEventListener: () => {}, removeEventListener: () => {},
    documentElement: new FakeElement('html'), body: new FakeElement('body'), head: headEl,
    activeElement: null, title: '' };
  const fetchStub = async url => {
    const target = String(url);
    const parteM = /\/parte\/(\w+)/.exec(target);
    if (parteM) { const src = lazy.partes[parteM[1]]?.source || '';
      return { ok: true, status: 200, headers: { get: () => 'text/javascript' },
        json: async () => ({}), text: async () => src, blob: async () => new Blob([]) }; }
    let body = {};
    if (target.includes('storage/rev')) body = { rev: 1 };
    else if (target.includes('storage?')) body = [];
    else if (target.includes('/api/status')) body = { settings: { installName: 'PacoSAT', hasLogo: false },
      buildModified: null, cloudRevision: null, profiles: [], jobs: [], inbox: [], mail: {} };
    else if (target.includes('declaraciones?')) body = { progreso: { running: true, step: 'Paso vivo de juguete', at: Date.now() - 60000 },
      mapa: { meses: [], resumen: { presentadas: 0, pendientes: 0, sinRecuperar: 0, pagadasSinAcuse: 0, noToca: 0 }, anual: null },
      documentos: [], folios: [], ejecutor: null, lastError: null, ejercicio: 2026 };
    else if (target.includes('declaraciones/runs') || target.includes('declaraciones/resumen')) body = { runs: [] };
    return { ok: true, status: 200, headers: { get: () => 'application/json' },
      json: async () => body, text: async () => JSON.stringify(body), blob: async () => new Blob([]) };
  };
  const timer = (fn, ms, ...a) => { const t = setTimeout(fn, ms, ...a); t.unref?.(); return t; };
  const every = (fn, ms, ...a) => { const t = setInterval(fn, ms, ...a); t.unref?.(); return t; };
  const context = vm.createContext({ console, document: documentStub,
    navigator: { onLine: true, userAgent: 'ronda240-test' },
    location: { href: 'http://127.0.0.1:43729/', search: '', reload: () => {} },
    localStorage: storageStub(), sessionStorage: storageStub(),
    fetch: fetchStub, setTimeout: timer, setInterval: every, clearTimeout, clearInterval, queueMicrotask,
    URL: BootURL, URLSearchParams, Blob, TextEncoder, TextDecoder, btoa, atob,
    crypto: webcrypto, DecompressionStream, Node: class FakeNode {}, IntersectionObserver: undefined,
    matchMedia: () => ({ matches: false, addEventListener: () => {}, addListener: () => {} }),
    Option: class extends FakeElement {}, alert: () => {}, addEventListener: () => {}, removeEventListener: () => {},
    requestAnimationFrame: fn => timer(fn, 0) });
  context.window = context; context.self = context;
  /* El head ejecuta los scripts inyectados (las partes
     diferidas), como el navegador al aterrizar una parte. */
  headEl.appendChild = kid => {
    if (kid && typeof kid.textContent === 'string' && kid.textContent)
      vm.runInContext(kid.textContent, context, { filename: 'parte-diferida' });
    return kid;
  };
  return context;
}
const textoDe = el => { let t = el.textContent || ''; for (const h of el.children || []) t += ' ' + textoDe(h); return t; };
const andar = (el, salida = []) => { salida.push(el); for (const h of el.children || []) andar(h, salida); return salida; };
async function bootCliente() {
  const context = makeBootContext();
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  vm.runInContext(script, context, { filename: 'Faro-Fiscal.html#script' });
  for (let i = 0; i < 12; i++) await new Promise(r => setTimeout(r, 0));
  /* RE-BASE integración 2.4.0: el cargador real trae las partes
     que esta suite ejerce — Vigilancia (paintActivity; su
     ensureLazyPart carga ANTES Descargas, como garantiza el
     cargador) y Declaraciones (declaracionesScreen) — y se
     deja asentar el pulso que Vigilancia arranca al cargar. */
  await vm.runInContext("ensureLazyPart('monitor')", context);
  await vm.runInContext("ensureLazyPart('declaraciones')", context);
  /* RE-BASE integración 2.9.0 (Bloque D): buzonScreen vive
     hoy en la parte diferida 'buzon'; el cargador real la
     trae para la sección (e) de Buzón, como al entrar en su
     vista. Ninguna aserción cambia. */
  await vm.runInContext("ensureLazyPart('buzon')", context);
  for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 0));
  return context;
}

/* ===== (c)+(d) Tarjetas: Detener por kind y texto guía pintado ===== */
{
  const context = await bootCliente();
  const ahora = Date.now();
  const juguete = {
    running: [
      { kind: 'masiva', key: 'masiva:11', jobId: 11, rfc: OWN, label: 'Solicitud de descarga en el SAT · ' + OWN,
        detail: 'esperando al SAT desde hace 7 min · Recibidos 2026-01-01 a 2026-01-31', phase: 'Esperando al SAT',
        since: ahora - 7 * 60000, state: 'esperando', canStop: true, stopLabel: 'Detener', stopExplain: GUIA,
        note: 'Detenerla significa: ' + GUIA + '.' },
      { kind: 'barrido', key: 'barrido', label: 'Revisión de comprobantes en el SAT', detail: '3 de 9 revisados',
        since: ahora - 60000, state: 'curso', canStop: true },
      { kind: 'declaraciones', key: 'declaraciones:' + OWN, rfc: OWN, label: 'Recuperación de declaraciones · ' + OWN,
        detail: 'Recuperando…', since: ahora - 30000, state: 'curso', canStop: true },
      { kind: 'ejecutor', key: 'ejecutor:j1', jobId: 'j1', rfc: OWN, label: 'Trabajo del SAT en tu equipo · Buzón de ' + OWN,
        detail: 'Tu ejecutor lo está corriendo ahora', since: ahora - 20000, state: 'curso', canStop: true }],
    paused: [
      { kind: 'masiva', key: 'masiva:12', jobId: 12, rfc: OWN, label: 'Solicitud al SAT retenida · ' + OWN,
        detail: 'PacoSAT no la está sondeando', since: ahora - 3600000, state: 'pausado', canResume: true, canStop: false },
      { kind: 'ejecutor', key: 'ejecutor:j2', jobId: 'j2', rfc: OWN, label: 'Trabajo del SAT esperando tu equipo · Buzón de ' + OWN,
        detail: 'Tu equipo no responde', since: ahora - 120000, state: 'esperando', canStop: true }],
    recent: [], nextAuto: null };
  context.__act = juguete;
  /* RE-BASE 2.9.0 (Bloque C, auditoría viva T1): en Hoy la
     franja global ya NO pinta — Hoy tiene su propio panel
     «Actividad del sistema» (hoyActividadPanel240) y la
     auditoría cazó la tarjeta duplicada en 16 paneles y dos
     veces seguidas en Novedades. La franja pinta en las
     pantallas sin panel propio; esta sección lo verifica en
     Hoy (suprimida) y corre su fuerza en Facturas. */
  vm.runInContext('activityView = __act; page = "home"; paintActivity();', context);
  const cajaCasa = context.document.getElementById('activity-jobs');
  assert.ok(!cajaCasa || cajaCasa.hidden || !cajaCasa.children.length,
    '(c) en Hoy la franja global no pinta: el trabajo vive en el panel propio de Hoy');
  vm.runInContext('page = "invoices"; paintActivity();', context);
  const caja = context.document.getElementById('activity-jobs');
  /* RE-BASE 2.9.9 (mandato D1 de la auditoría visual): en
     Facturas la franja tampoco se ve ya — compone siempre
     (contrato D8) y el trabajo se mira en la línea fina de
     la barra superior, cada uno con su Detener. */
  assert.ok(caja.hidden && caja.children.length, '(c) en Facturas la franja compone pero NO se ve (2.9.9 · D1: el trabajo vive en la línea fina de la barra)');
  /* RE-BASE corrección visual 2.4.0 (contabilidad): esta
     aserción fijaba el VOLCADO — las 6 entradas pintadas a la
     vez y la guía repetida dentro de la entrada. La fuerza se
     conserva entera (cada trabajo sigue teniendo su
     Detener/Cancelar/Reanudar alcanzable EN la tarjeta); lo
     que cambia es el despliegue: el primer pintado enseña las
     primeras 3 entradas y el resto vive tras el botón propio
     «Ver las 3 restantes» de la misma tarjeta, y la guía se
     lee UNA vez por tarjeta, bajo la cabecera. La suite lo
     verifica en los dos estados, colapsado y desplegado. */
  /* RE-BASE 2.8.0 (diseño 1): con más de 3 trabajos la tarjeta
     nace RESUMIDA en su línea de cabecera («6 trabajos») tras
     el botón «Ver los 6 trabajos» — ninguna entrada se pinta
     colapsada, y con ella ningún «Detener»: el gesto de cada
     trabajo vive a un toque, tras el despliegue, en la misma
     tarjeta. La fuerza de la suite se conserva: desplegada, la
     tarjeta enseña TODAS las entradas con su
     Detener/Cancelar/Reanudar y la guía UNA vez. */
  const textoColapsado = textoDe(caja);
  const botonesColapsados = andar(caja).filter(el => el.tagName === 'BUTTON').map(el => el.textContent);
  assert.ok(textoColapsado.includes('6 trabajos'), '(c) colapsada, la tarjeta se resume en su línea: «6 trabajos»');
  assert.ok(!botonesColapsados.includes('Detener'), '(c) colapsada no pinta ningún «Detener»: vive tras el despliegue');
  for (const e of [...juguete.running, ...juguete.paused])
    assert.ok(!textoColapsado.includes(e.label), '(c) colapsada NO vuelca la entrada «' + e.kind + '»: queda tras el despliegue');
  const toggle = andar(caja).find(el => el.tagName === 'BUTTON' && el.textContent === 'Ver los 6 trabajos');
  assert.ok(toggle, '(c) la tarjeta lleva su botón «Ver los 6 trabajos»');
  toggle.onclick();
  const texto = textoDe(caja);
  const botones = andar(caja).filter(el => el.tagName === 'BUTTON').map(el => el.textContent);
  assert.ok(botones.includes('Detener'), '(c) la solicitud del SAT pinta su botón «Detener»: ' + botones.join(','));
  assert.ok(botones.filter(b => b === 'Cancelar').length >= 3, '(c) barrido, declaraciones y ejecutor pintan «Cancelar»');
  assert.ok(botones.includes('Reanudar'), '(c) la retenida (canResume) pinta su «Reanudar»');
  for (const e of [...juguete.running, ...juguete.paused])
    assert.ok(texto.includes(e.label), '(c) la tarjeta de «' + e.kind + '» está pintada');
  assert.ok(texto.includes(GUIA), '(d) el texto guía se lee EN la tarjeta de la solicitud');
  assert.equal(texto.split(GUIA).length - 1, 1,
    '(d) desplegada, la guía sigue leyéndose exactamente UNA vez (no una por entrada)');
  /* (2.8.0 · diseño 1) La espera real se enseña en la línea
     única: el estado al frente y el «desde hace» detrás —
     «Esperando al SAT · desde hace 7 min» —, no pegados como
     los traía el detalle crudo del servidor. */
  assert.ok(texto.includes('Esperando al SAT · desde hace 7 min'), '(d) la tarjeta enseña la espera real');
  console.log('OK 2.4.0·W1 (c)+(d-cliente) — Detener/Cancelar/Reanudar por kind y guía en la tarjeta.');
}

/* ===== (e) Declaraciones: su corrida, fijada arriba ===== */
{
  const context = await bootCliente();
  vm.runInContext('scope = "' + OWN + '"; satData = { profiles: [], jobs: [], inbox: [], mail: {} };', context);
  const secciones = vm.runInContext('declaracionesScreen()', context);
  for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 0));
  const nodos = andar(secciones[0]);
  const fijada = nodos.find(el => el.dataset && el.dataset.trabajoFijado240 === 'declaraciones');
  assert.ok(fijada, '(e) Declaraciones pinta su tarjeta fijada de trabajo en curso');
  assert.ok(textoDe(fijada).includes('Paso vivo de juguete'), '(e) la fijada enseña el paso en vivo');
  assert.ok(andar(fijada).some(el => el.tagName === 'BUTTON' && el.textContent === 'Cancelar recuperación'),
    '(e) y su Cancelar vive EN la tarjeta fijada');
  const rejilla = nodos.find(el => String(el.className || '').split(' ').includes('decl-grid'));
  assert.ok(rejilla && nodos.indexOf(fijada) < nodos.indexOf(rejilla), '(e) la fijada va ANTES del mapa (arriba)');
  console.log('OK 2.4.0·W1 (e-declaraciones) — recuperación fijada arriba con su Cancelar.');
}

/* ===== (e) Buzón (Recibidos): trabajo vivo de su RFC, fijado ===== */
{
  const context = await bootCliente();
  const ahora = Date.now();
  context.__act = { running: [{ kind: 'tributario', key: 'tributario:' + OWN, rfc: OWN,
      label: 'Consulta del Buzón Tributario · ' + OWN, detail: 'Listando sin abrir…',
      since: ahora - 45000, state: 'curso', canStop: true }], paused: [], recent: [], nextAuto: null };
  vm.runInContext('activityView = __act; scope = "' + OWN + '"; satData = { profiles: [], jobs: [], inbox: [], mail: {}, buzonUnread: {} };', context);
  const pantallas = vm.runInContext('buzonScreen()', context);
  const wrap = pantallas[0];
  const fijado = wrap.children.find(el => el.dataset && el.dataset.trabajoFijado240 === 'buzon');
  assert.ok(fijado, '(e) Buzón pinta su tarjeta fijada de trabajo en curso');
  assert.equal(wrap.children[0], fijado, '(e) y es lo PRIMERO de la pantalla (arriba del todo)');
  assert.ok(textoDe(fijado).includes('Consulta del Buzón Tributario'), '(e) la fijada nombra el trabajo');
  assert.ok(andar(fijado).some(el => el.tagName === 'BUTTON' && el.textContent === 'Cancelar'),
    '(e) y lleva su Cancelar en la propia tarjeta');
  console.log('OK 2.4.0·W1 (e-buzón) — trabajo vivo fijado arriba en Buzón con su gesto.');
}

rmSync(dir, { recursive: true, force: true });
console.log('OK 2.4.0 · W1 actividad completa.');
