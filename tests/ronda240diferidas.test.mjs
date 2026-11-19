/* ================================================================
   Ronda 2.4.0 · W6 — Declaraciones y Vigilancia (monitor) pasan
   a partes diferidas: la carga inicial BAJA y las dos pantallas
   viajan en /parte/declaraciones y /parte/monitor, autorizadas
   por su SHA-256 exacto en la CSP, como las cinco de siempre.

   Lo que esta suite fija, sobre el artefacto construido:
   (a) build.mjs: LAZY_PARTS lleva las dos y MAIN_PARTS ya no
       las incluye; las funciones reales de pantalla NO están en
       el script principal y SÍ en su parte de lazy.json, con su
       huella dentro de la CSP de la página.
   (b) El servidor sirve / con la CSP que autoriza ambas huellas
       y sirve /parte/declaraciones y /parte/monitor (200, con su
       pantalla dentro); una parte inexistente dice 404.
   (c) La carga inicial servida en / pesa MENOS que el artefacto
       anterior a esta extracción (983.566 B medidos al abrir el
       bloque) y no contiene los cuerpos diferidos.
   (d) Referencias cruzadas resueltas por el PUENTE de ui.part:
       antes de cargar ninguna parte, el bloque principal ya
       tiene fiscalResults, monitorFilter, declEjercicio,
       declFechaLarga (con su texto exacto), statusCell y los
       lanzadores puente (declRun, monitorCheckNow,
       monitorCheckOne, pollMonitor, pintarDeclMenu202,
       declaracionesScreen, declaracionesGrupo201); y NO tiene
       todavía activityControlButton ni monitorScreen.
   (e) Con la parte de Vigilancia cargada por el cargador real
       (ensureLazyPart contra el fetch que sirve lazy.json),
       activityControlButton es alcanzable desde Hoy:
       pintarHoyVivo240 pinta el botón REAL «Cancelar» de un
       trabajo en curso, no el «Ver el control» de mientras tanto.
   (f) Con la parte de Declaraciones cargada, los puentes quedan
       sustituidos por las funciones reales (su fuente ya no es
       la del puente) y declaracionesScreen existe de verdad.
   ================================================================ */
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { URL as NodeURL } from 'node:url';
import { createPacoSATService } from '../local-server.mjs';

const ROOT = join(import.meta.dirname, '..');
const read = name => readFileSync(join(ROOT, name), 'utf8');
const html = read('Faro-Fiscal.html');
const buildSrc = read('build.mjs');
const lazy = JSON.parse(read('lazy.json'));
const PESO_ANTES_W6 = 983566; /* artefacto medido al abrir W6, antes de extraer */

/* ===== (a) build: las dos partes salen del principal ===== */
{
  assert.match(buildSrc, /declaraciones: 'declaraciones-ui\.part'/, '(a) LAZY_PARTS mapea declaraciones → declaraciones-ui.part');
  assert.match(buildSrc, /monitor: 'monitor-ui\.part'/, '(a) LAZY_PARTS mapea monitor → monitor-ui.part');
  const mainParts = buildSrc.match(/const MAIN_PARTS = \[([^\]]*)\]/)[1];
  assert.ok(!mainParts.includes('declaraciones-ui.part'), '(a) MAIN_PARTS ya no incluye declaraciones-ui.part');
  assert.ok(!mainParts.includes('monitor-ui.part'), '(a) MAIN_PARTS ya no incluye monitor-ui.part');
  for (const fn of ['function monitorScreen', 'function declaracionesSection', 'function paintActivity',
      'function activityControlButton', 'function declRunsDetails', 'function monitorCheckNow() {\n  const'])
    assert.ok(!html.includes(fn), '(a) el script principal no lleva «' + fn + '»');
  for (const [nombre, fn] of [['declaraciones', 'function declaracionesScreen'], ['declaraciones', 'function declRun'],
      ['monitor', 'function monitorScreen'], ['monitor', 'function activityControlButton'], ['monitor', 'function paintActivity']]) {
    assert.ok(lazy.partes[nombre], '(a) lazy.json lleva la parte «' + nombre + '»');
    assert.ok(lazy.partes[nombre].source.includes(fn), '(a) la parte «' + nombre + '» trae «' + fn + '»');
    assert.ok(html.includes(lazy.partes[nombre].hash), '(a) la CSP de la página autoriza la huella de «' + nombre + '»');
  }
  assert.ok(html.includes('"declaraciones":"/parte/declaraciones"'), '(a) el manifiesto PACOSAT_LAZY nombra /parte/declaraciones');
  assert.ok(html.includes('"monitor":"/parte/monitor"'), '(a) el manifiesto PACOSAT_LAZY nombra /parte/monitor');
  assert.ok(html.includes("if (view === 'declaraciones') return 'declaraciones';"), '(a) el cargador mapea la vista declaraciones a su parte');
  assert.ok(html.includes("if (view === 'monitor') return 'monitor';"), '(a) el cargador mapea la vista monitor a su parte');
  assert.ok(html.includes("if (view === 'descargar') return 'monitor';"),
    '(a) Descargas también espera a Vigilancia: su cuota y «Baja lo mismo» envuelven fillSat desde esa parte');
  console.log('OK 2.4.0·W6 (a) — build: declaraciones y monitor diferidas, fuera del principal, con huella en la CSP.');
}

/* ===== (b)+(c) Servidor: /, las dos partes y la CSP ===== */
const ORIGIN = 'http://127.0.0.1:43746';
const KEY = 'proxy-diferidas';
function makeServerHarness() {
  const service = createPacoSATService({ dbFile: ':memory:', html, origin: ORIGIN, proxyKey: KEY,
    lazyParts: lazy, satDocRetryWaitMs: 5,
    makeConnector: async () => ({ connector: { request: async () => 'req-juguete',
      check: async () => ({ status: 'pending', packages: [] }),
      download: async () => { throw new Error('sin paquetes de juguete'); } } }),
    makeMailer: () => ({ verify: async () => true, sendMail: async () => ({ messageId: 'm-juguete' }) }) });
  let token = '';
  const raw = async (method, path, extraHeaders = {}) => {
    const req = Object.assign(Readable.from([]), { url: path, method,
      headers: { host: new URL(ORIGIN).host, origin: ORIGIN, 'x-pacosat-proxy': KEY, ...extraHeaders } });
    let status = 0; const headers = {}; let text = '';
    const res = { setHeader(k, v) { headers[String(k).toLowerCase()] = v; },
      writeHead(code) { status = code; this.headersSent = true; },
      end(chunk) { if (chunk) text += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk; } };
    await service.handle(req, res);
    return { status, text, headers };
  };
  return { service, raw,
    async call(path) {
      if (!token) { const home = await raw('GET', '/'); token = /[0-9a-f]{64}/.exec(home.text)?.[0] || ''; }
      return raw('GET', path, { 'x-pacosat-token': token });
    } };
}
{
  const h = makeServerHarness();
  const home = await h.raw('GET', '/');
  assert.equal(home.status, 200, '(b) GET / responde 200');
  const csp = home.headers['content-security-policy'] || '';
  assert.ok(csp.includes(lazy.partes.declaraciones.hash), '(b) la CSP servida autoriza la parte de declaraciones');
  assert.ok(csp.includes(lazy.partes.monitor.hash), '(b) la CSP servida autoriza la parte de monitor');
  assert.ok(!csp.includes('unsafe-inline'), '(b) la CSP servida sigue sin unsafe-inline');
  const pesoServido = Buffer.byteLength(home.text);
  assert.ok(pesoServido < PESO_ANTES_W6, '(c) la carga inicial servida (' + pesoServido + ' B) baja del artefacto previo a W6 (' + PESO_ANTES_W6 + ' B)');
  assert.ok(!home.text.includes('function monitorScreen'), '(c) la carga inicial no lleva la pantalla de Vigilancia');
  assert.ok(!home.text.includes('function declaracionesSection'), '(c) la carga inicial no lleva la sección de Declaraciones');
  const decl = await h.call('/parte/declaraciones');
  assert.equal(decl.status, 200, '(b) GET /parte/declaraciones responde 200');
  assert.ok(decl.text.includes('function declaracionesScreen'), '(b) y sirve la pantalla de Declaraciones');
  assert.equal(Buffer.byteLength(decl.text), Buffer.byteLength(lazy.partes.declaraciones.source),
    '(b) lo servido es byte a byte la parte sellada en lazy.json');
  const mon = await h.call('/parte/monitor');
  assert.equal(mon.status, 200, '(b) GET /parte/monitor responde 200');
  assert.ok(mon.text.includes('function monitorScreen'), '(b) y sirve la pantalla de Vigilancia');
  assert.ok(mon.text.includes('function activityControlButton'), '(b) y su botón de control de actividad');
  assert.equal(Buffer.byteLength(mon.text), Buffer.byteLength(lazy.partes.monitor.source),
    '(b) lo servido es byte a byte la parte sellada en lazy.json');
  const noHay = await h.call('/parte/inexistente-w6');
  assert.equal(noHay.status, 404, '(b) una parte que no existe dice 404');
  h.service.close();
  console.log('OK 2.4.0·W6 (b)+(c) — servidor: / con CSP por huellas, partes servidas byte a byte, inicial en ' +
    pesoServido + ' B (antes ' + PESO_ANTES_W6 + ' B; artefacto en disco ' + statSync(join(ROOT, 'Faro-Fiscal.html')).size + ' B).');
}

/* ===== Arnés DOM (el de la casa) con head que EJECUTA los
   scripts inyectados, como el navegador al cargar una parte == */
class BootURL extends NodeURL {
  static createObjectURL() { return 'blob:prueba'; }
  static revokeObjectURL() {}
}
class FakeElement {
  constructor(tag = 'div') {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.dataset = {};
    this.style = {};
    this.attributes = {};
    this.textContent = '';
    this.innerHTML = '';
    this.value = '';
    this.hidden = false;
    this.disabled = false;
    this.open = false;
    this.files = [];
    const classes = new Set();
    this.classList = {
      add: (...names) => names.forEach(name => classes.add(name)),
      remove: (...names) => names.forEach(name => classes.delete(name)),
      toggle: (name, force) => {
        const on = force === undefined ? !classes.has(name) : Boolean(force);
        if (on) classes.add(name); else classes.delete(name);
        return on;
      },
      contains: name => classes.has(name) };
  }
  get childNodes() { return this.children; }
  append(...kids) { for (const kid of kids) if (kid instanceof FakeElement) this.children.push(kid); }
  prepend(...kids) { for (const kid of [...kids].reverse()) if (kid instanceof FakeElement) this.children.unshift(kid); }
  appendChild(kid) { if (kid instanceof FakeElement) this.children.push(kid); return kid; }
  insertBefore(kid) { if (kid instanceof FakeElement) this.children.push(kid); return kid; }
  removeChild(kid) { this.children = this.children.filter(child => child !== kid); return kid; }
  replaceWith(...kids) { this.children = kids.filter(kid => kid instanceof FakeElement); }
  before() {}
  after(kid) { if (kid instanceof FakeElement) this.children.push(kid); }
  insertAdjacentElement(_where, kid) { return kid; }
  insertAdjacentHTML() {}
  insertAdjacentText() {}
  cloneNode() { return new FakeElement(this.tagName); }
  replaceChildren(...kids) { this.children = kids.filter(kid => kid instanceof FakeElement); }
  remove() {}
  click() {}
  close() {}
  showModal() {}
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return name in this.attributes ? this.attributes[name] : null; }
  removeAttribute(name) { delete this.attributes[name]; }
  hasAttribute(name) { return name in this.attributes; }
  addEventListener() {}
  removeEventListener() {}
  querySelector() { return null; }
  querySelectorAll() { return []; }
  closest() { return null; }
  focus() {}
  blur() {}
  scrollIntoView() {}
  getBoundingClientRect() { return { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 }; }
}
const buscar = (el, pred, out = []) => { if (el && pred(el)) out.push(el); for (const h of el?.children || []) buscar(h, pred, out); return out; };
const textoDe = el => { let t = el.textContent || ''; for (const h of el.children || []) t += ' ' + textoDe(h); return t; };
const storageStub = () => {
  const map = new Map();
  return { getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: key => map.delete(key), clear: () => map.clear() };
};
function makeBootContext() {
  const byId = new Map();
  const metas = { 'meta[name="pacosat-token"]': { content: 'token-de-prueba' },
    'meta[name="pacosat-cloud"]': { content: '1' } };
  const head = new FakeElement('head');
  const documentStub = {
    getElementById: id => { if (!byId.has(id)) byId.set(id, new FakeElement('div')); return byId.get(id); },
    createElement: tag => new FakeElement(tag),
    createElementNS: (_ns, tag) => new FakeElement(tag),
    createTextNode: text => ({ textContent: String(text) }),
    querySelector: selector => metas[selector] ?? null,
    querySelectorAll: () => [],
    addEventListener: () => {}, removeEventListener: () => {},
    documentElement: new FakeElement('html'), body: new FakeElement('body'), head,
    activeElement: null, title: '' };
  const fetchStub = async url => {
    const target = String(url);
    let body = {};
    if (target.includes('/parte/declaraciones'))
      return { ok: true, status: 200, headers: { get: () => 'text/javascript' },
        json: async () => ({}), text: async () => lazy.partes.declaraciones.source, blob: async () => new Blob([]) };
    if (target.includes('/parte/monitor'))
      return { ok: true, status: 200, headers: { get: () => 'text/javascript' },
        json: async () => ({}), text: async () => lazy.partes.monitor.source, blob: async () => new Blob([]) };
    if (target.includes('/parte/'))
      return { ok: true, status: 200, headers: { get: () => 'text/javascript' },
        json: async () => ({}), text: async () => '', blob: async () => new Blob([]) };
    if (target.includes('storage/rev')) body = { rev: 1 };
    else if (target.includes('storage?')) body = [];
    else if (target.includes('/api/status')) body = { settings: { installName: 'PacoSAT', hasLogo: false },
      buildModified: null, cloudRevision: null, profiles: [], jobs: [], inbox: [], mail: {} };
    return { ok: true, status: 200, headers: { get: () => 'application/json' },
      json: async () => body, text: async () => JSON.stringify(body), blob: async () => new Blob([]) };
  };
  const timer = (fn, ms, ...args) => { const t = setTimeout(fn, ms, ...args); t.unref?.(); return t; };
  const every = (fn, ms, ...args) => { const t = setInterval(fn, ms, ...args); t.unref?.(); return t; };
  const context = vm.createContext({ console, document: documentStub,
    navigator: { onLine: true, userAgent: 'ronda240diferidas-test' },
    location: { href: 'http://127.0.0.1:43746/', search: '', reload: () => {} },
    localStorage: storageStub(), sessionStorage: storageStub(),
    fetch: fetchStub, setTimeout: timer, setInterval: every, clearTimeout, clearInterval, queueMicrotask,
    URL: BootURL, URLSearchParams, Blob, File, TextEncoder, TextDecoder, btoa, atob,
    crypto: webcrypto, DecompressionStream,
    matchMedia: () => ({ matches: false, addEventListener: () => {}, addListener: () => {} }),
    Option: class extends FakeElement {},
    alert: () => {}, addEventListener: () => {}, removeEventListener: () => {},
    requestAnimationFrame: fn => timer(fn, 0) });
  context.window = context; context.self = context;
  /* El navegador ejecuta un <script> al insertarlo en <head>:
     el arnés hace lo mismo con el código de la parte. */
  head.appendChild = kid => {
    if (kid && typeof kid.textContent === 'string' && kid.textContent)
      vm.runInContext(kid.textContent, context, { filename: 'parte-diferida' });
    return kid;
  };
  return context;
}
async function bootCliente() {
  const context = makeBootContext();
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  vm.runInContext(script, context, { filename: 'Faro-Fiscal.html#script' });
  for (let i = 0; i < 12; i++) await new Promise(r => setTimeout(r, 0));
  return context;
}
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 0)); };

/* ===== (d) El puente, antes de cargar ninguna parte ===== */
{
  const ctx = await bootCliente();
  const tipo = expr => vm.runInContext('typeof ' + expr, ctx);
  assert.equal(tipo('fiscalResults'), 'object', '(d) fiscalResults vive en el principal desde el arranque');
  assert.equal(vm.runInContext('fiscalResults instanceof Map', ctx), true, '(d) y es el Map compartido');
  assert.equal(tipo('monitorFilter'), 'string', '(d) monitorFilter vive en el principal');
  assert.equal(tipo('declEjercicio'), 'number', '(d) declEjercicio vive en el principal');
  assert.equal(vm.runInContext("declFechaLarga('2026-11-17')", ctx), '17 de noviembre de 2026',
    '(d) declFechaLarga del puente compone la fecha exacta');
  assert.equal(vm.runInContext("declFechaCorta('2026-11-17')", ctx), '17 nov 2026',
    '(d) declFechaCorta del puente compone la fecha exacta');
  assert.equal(vm.runInContext("declFaltaMes230('2026-10')", ctx), 'octubre',
    '(d) declFaltaMes230 del puente nombra el mes del periodo');
  assert.equal(tipo('statusCell'), 'function', '(d) statusCell vive en el principal (lo pinta Facturas)');
  assert.equal(tipo('monitorStateInfo'), 'function', '(d) monitorStateInfo vive en el principal (lo pinta Problemas)');
  for (const fn of ['declRun', 'monitorCheckNow', 'monitorCheckOne', 'pollMonitor',
      'pintarDeclMenu202', 'declaracionesScreen', 'declaracionesGrupo201'])
    assert.equal(tipo(fn), 'function', '(d) el lanzador puente «' + fn + '» existe antes de cargar su parte');
  assert.equal(tipo('activityControlButton'), 'undefined', '(d) activityControlButton aún NO existe: vive en la parte de Vigilancia');
  assert.equal(tipo('monitorScreen'), 'undefined', '(d) monitorScreen aún NO existe: vive en su parte');
  assert.equal(tipo('declaracionesSection'), 'undefined', '(d) declaracionesSection aún NO existe: vive en su parte');
  /* El estado compartido funciona sin la parte: el estado de un
     CFDI se lee del Map del puente. */
  vm.runInContext(`invoices = [{ id: 'uuid-w6', kind: 'I' }];
    fiscalResults.set('uuid-w6', { sat: { state: 'Cancelado' }, efos: [] });`, ctx);
  assert.equal(vm.runInContext("invoiceStateOf(invoices[0])", ctx), 'Cancelado',
    '(d) invoiceStateOf lee el fiscalResults del puente sin cargar Vigilancia');
  assert.equal(vm.runInContext("monitorStateInfo(invoices[0]).badge", ctx), 'Cancelado',
    '(d) monitorStateInfo del puente resuelve el estado sin cargar Vigilancia');
  console.log('OK 2.4.0·W6 (d) — puente: estado, ayudas y lanzadores en el principal; lo diferido, aún fuera.');
}

/* ===== (e) Hoy alcanza el botón REAL con la parte cargada ===== */
{
  const ctx = await bootCliente();
  const ok = await vm.runInContext("ensureLazyPart('monitor')", ctx);
  assert.equal(ok, true, '(e) el cargador real trae la parte de Vigilancia');
  await flush();
  assert.equal(vm.runInContext('typeof activityControlButton', ctx), 'function',
    '(e) con la parte cargada, activityControlButton existe');
  assert.equal(vm.runInContext('typeof monitorScreen', ctx), 'function',
    '(e) y monitorScreen existe de verdad');
  assert.ok(!vm.runInContext('monitorCheckNow.toString()', ctx).includes('ensureLazyPart'),
    '(e) el puente de monitorCheckNow quedó sustituido por la función real');
  const ahora = Date.now();
  ctx.__view = { running: [{ kind: 'masiva', key: 'masiva:11', jobId: 11, label: 'Solicitud de descarga en el SAT',
      detail: 'esperando al SAT desde hace 7 min', phase: 'Esperando al SAT', since: ahora - 7 * 60000,
      state: 'esperando', canStop: true, stopLabel: 'Detener' }], paused: [], recent: [], nextAuto: null };
  const caja = vm.runInContext(`(() => { const box = n('div'); box.isConnected = true;
    pintarHoyVivo240(__view, box); return box; })()`, ctx);
  const botones = buscar(caja, e => e.tagName === 'BUTTON').map(e => (e.textContent || '').trim());
  assert.ok(botones.includes('Detener'), '(e) Hoy pinta el botón REAL de parada de la parte: ' + botones.join(','));
  assert.ok(!botones.includes('Ver el control'), '(e) y no el «Ver el control» de mientras la parte no llegaba');
  assert.ok(textoDe(caja).includes('Solicitud de descarga en el SAT'), '(e) la fila del trabajo vivo se pinta');
  console.log('OK 2.4.0·W6 (e) — Hoy + parte de Vigilancia cargada: el botón real «Detener» vive en el panel.');
}

/* ===== (f) Declaraciones: el puente cede a la parte real ===== */
{
  const ctx = await bootCliente();
  assert.ok(vm.runInContext('declaracionesScreen.toString()', ctx).includes('Cargando esta pantalla'),
    '(f) antes de cargar, declaracionesScreen es el puente que enseña el cargando');
  const ok = await vm.runInContext("ensureLazyPart('declaraciones')", ctx);
  assert.equal(ok, true, '(f) el cargador real trae la parte de Declaraciones');
  await flush();
  assert.equal(vm.runInContext('typeof declaracionesSection', ctx), 'function',
    '(f) con la parte cargada, declaracionesSection existe');
  assert.ok(!vm.runInContext('declaracionesScreen.toString()', ctx).includes('Cargando esta pantalla'),
    '(f) declaracionesScreen ya es la real, no el puente');
  assert.ok(!vm.runInContext('declRun.toString()', ctx).includes('ensureLazyPart'),
    '(f) el puente de declRun quedó sustituido por el lanzador real');
  assert.ok(!vm.runInContext('pintarDeclMenu202.toString()', ctx).includes('ensureLazyPart'),
    '(f) el puente de pintarDeclMenu202 quedó sustituido por el real');
  /* El ejercicio del puente y el de la parte son EL MISMO let:
     fijarlo desde el principal se lee dentro de la parte. */
  vm.runInContext('declEjercicio = 2026;', ctx);
  assert.equal(vm.runInContext('declEjercicio', ctx), 2026, '(f) declEjercicio compartido puente↔parte');
  console.log('OK 2.4.0·W6 (f) — Declaraciones cargada: puentes sustituidos por las funciones reales.');
}

console.log('OK 2.4.0 · W6 diferidas completa.');
