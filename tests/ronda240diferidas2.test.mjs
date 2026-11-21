/* ================================================================
   Ronda 2.4.0 · W6b — Descargas (sat-ui) y Dinero (money-ui)
   pasan a partes diferidas: la carga inicial queda POR DEBAJO
   del artefacto 2.3.1 (818.135 B) y las dos pantallas viajan en
   /parte/descargas y /parte/dinero, autorizadas por su SHA-256
   exacto en la CSP, como las siete anteriores.

   Lo que esta suite fija, sobre el artefacto construido:
   (a) build.mjs: LAZY_PARTS lleva descargas y dinero y
       MAIN_PARTS ya no incluye sat-ui.part ni money-ui.part;
       los cuerpos de pantalla NO están en el script principal
       y SÍ en su parte de lazy.json, con su huella en la CSP.
   (b) El servidor sirve / con la CSP que autoriza ambas
       huellas y sirve /parte/descargas y /parte/dinero (200,
       byte a byte contra lazy.json); una parte inexistente
       dice 404.
   (c) La carga inicial servida en / pesa MENOS que el tope
       vigente de 827.200 B (RE-BASE 2.9.10 junto a la constante
       PESO_TOPE: la referencia histórica 2.3.1 de 818.135 B quedó
       superada por el crecimiento funcional medido de la 2.9.7).
   (d) Referencias cruzadas resueltas por el PUENTE de ui.part:
       antes de cargar ninguna parte, el bloque principal ya
       tiene el núcleo SAT (satToken, satData, satApi,
       satApiLectura, localDateTime, causaP200, textoP200,
       vigil200, restSwitch, selectPerson, satQuickCuando,
       descargarSalida1310) y el de Dinero (dineroMarcados,
       dineroServerInfo, paidByMap, balanceOf, setInvoiceTerm
       funcionando), más los lanzadores (pollSat, downloadSheet,
       requestDialog, unlockDialog, fillSat, satDownloadScreen);
       y NO tiene todavía dineroScreen, satCardGrid ni
       cascadaMes240.
   (e) ORDEN DE CARGA de la envoltura de fillSat: pedir SOLO la
       parte de Vigilancia trae ANTES la de Descargas, así la
       envoltura (cuota + «Baja lo mismo») captura el fillSat
       REAL y no el lanzador del puente.
   (f) Descargas pinta con sus partes cargadas por el cargador
       real: fillSat es la envoltura de Vigilancia y su pintado
       enseña la tarjeta de cuota (dataset.cuota240).
   (g) Dinero pinta con su parte cargada por el cargador real:
       dineroScreen compone su resumen y los lanzadores del
       puente quedan sustituidos por las funciones reales.
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
const PESO_231 = 818135; /* artefacto 2.3.1: la referencia histórica */
/* RE-BASE 2.9.7 (punto c): la referencia 2.3.1 (818.135 B) quedó
   superada por el crecimiento funcional de las partes PRINCIPALES,
   medido y atribuido: la 2.9.6 sellada servía 804.888 B en / y la
   2.9.7 sirve 822.280 B (+17.392 B de artefacto construido: el
   Lector de XML de la pieza B en workflows.part, la maquinaria del
   portal y el Hoy proactivo de las piezas A/C/D6 en ui.part, la
   vista previa de los visores de la pieza D2 en pdf-cloud-ui.part
   y la nota de novedades). El tope operativo pasa a ser el mismo
   822.500 B que ronda1260 mantiene para el artefacto, con su
   contabilidad; PESO_231 se conserva como referencia histórica y
   la línea OK sigue informando de la distancia contra ella. La
   salida de fondo —diferir el detalle de Facturas o el panel de
   Hoy si la carga inicial vuelve a crecer— queda nombrada en el
   informe de la 2.9.7, no escondida. */
/* RE-BASE 2.9.10: la carga inicial servida mide 826.570 B (el artefacto, 826.449 B, + los 121 B del sellado al servir). El crecimiento es el de la ronda, con la contabilidad tanda a tanda de ronda1110 (+1.502 B sobre la 2.9.9: respaldo partido reconstruido en final-ui.part +1.472, parámetro opcional de snapshot() en workflows.part +44, entrada del menú en ui.part −15, empalmes +1). El tope acompaña al de la casa: 827.200 B (margen 630 B).
   RE-BASE 2.9.9: la carga inicial servida mide 825.068 B (el artefacto, 824.947 B, + los 121 B del sellado al servir). El crecimiento es el de la ronda, con la contabilidad tanda a tanda de ronda1110 (+1.169 B sobre la 2.9.8: diseño estructural +567, D2/D3/D5 −100 netos, veredicto B3 +439, nota de novedades 2.9.9 +263). El tope acompaña al de la casa: 825.700 B (margen 632 B).
   RE-BASE 2.9.8: la carga inicial servida mide 823.899 B (el artefacto, 823.778 B, + los 121 B del sellado al servir que esta suite ya medía en la 2.9.7: 822.280 servidos sobre 822.159 de fichero). El crecimiento es el de la ronda, con la contabilidad fichero a fichero de ronda1110 (usuarios con nombre propio +1.072 B netos en la carga inicial —el panel entero viaja diferido en la parte «usuarios»—, Pieza V +523 B, Pieza R +24 B). El tope acompaña al de la casa: 824.500 B (margen 601 B). */
/* RE-BASE 3.0: la carga inicial servida mide 881.113 B (el artefacto, 880.992 B, + los 121 B del sellado al servir). El crecimiento es el de la ronda 3.0, con la contabilidad de ronda1110 (+16.778 B sobre los 864.214 B del árbol base 2.9.17: la tarjeta «Ponerme al día» y su caminante, el sello de frescura, la rejilla de meses, la prueba de origen, las acciones rápidas y la barra nueva). El tope acompaña al de la casa: 881.800 B (margen 687 B).
   RE-BASE 2.9.16: la carga inicial servida mide 865.587 B (el artefacto, 865.466 B, + los 121 B del sellado al servir). El crecimiento es el de la ronda, con la contabilidad de ronda1110 (+6.317 B sobre la 2.9.15: «Tus tareas» y el alcance de sesión en ui.part, la piel de estados/pisos/franja/ficha en polish.part, el menú de cuatro bloques en layout.part y las partes diferidas de Salud y Registro). El tope acompaña al de la casa: 866.250 B (margen 663 B). */
const PESO_TOPE = 915208; /* RE-BASE 3.2.0: la carga inicial servida mide 914.525 B; el tope acompaña al de la casa (915.208; contabilidad en ronda1110). Antes, RE-BASE 3.1.0: 893.650. */

/* ===== (a) build: las dos partes salen del principal ===== */
{
  assert.match(buildSrc, /descargas: 'sat-ui\.part'/, '(a) LAZY_PARTS mapea descargas → sat-ui.part');
  assert.match(buildSrc, /dinero: 'money-ui\.part'/, '(a) LAZY_PARTS mapea dinero → money-ui.part');
  const mainParts = buildSrc.match(/const MAIN_PARTS = \[([^\]]*)\]/)[1];
  assert.ok(!mainParts.includes('sat-ui.part'), '(a) MAIN_PARTS ya no incluye sat-ui.part');
  assert.ok(!mainParts.includes('money-ui.part'), '(a) MAIN_PARTS ya no incluye money-ui.part');
  for (const fn of ['function dineroScreen', 'function satCardGrid', 'function cascadaMes240',
      'function dineroCascadaPanel240', 'function reconcilePanel', 'function satTramiteEstados'])
    assert.ok(!html.includes(fn), '(a) el script principal no lleva «' + fn + '»');
  for (const [nombre, fn] of [['descargas', 'function satDownloadScreen'], ['descargas', 'function fillSat'],
      ['descargas', 'function pollSat'], ['descargas', 'function satCardGrid'],
      ['dinero', 'function dineroScreen'], ['dinero', 'function cascadaMes240'],
      ['dinero', 'function dineroCascadaPanel240'], ['dinero', 'function reconcilePanel']]) {
    assert.ok(lazy.partes[nombre], '(a) lazy.json lleva la parte «' + nombre + '»');
    assert.ok(lazy.partes[nombre].source.includes(fn), '(a) la parte «' + nombre + '» trae «' + fn + '»');
    assert.ok(html.includes(lazy.partes[nombre].hash), '(a) la CSP de la página autoriza la huella de «' + nombre + '»');
  }
  assert.ok(html.includes('"descargas":"/parte/descargas"'), '(a) el manifiesto PACOSAT_LAZY nombra /parte/descargas');
  assert.ok(html.includes('"dinero":"/parte/dinero"'), '(a) el manifiesto PACOSAT_LAZY nombra /parte/dinero');
  assert.ok(html.includes("if (view === 'dinero') return dineroTab === 'bancos' ? 'bancos' : 'dinero';"),
    '(a) el cargador mapea la vista dinero a su parte (y Bancos a la suya)');
  assert.ok(html.includes("if (view === 'descargar') return 'monitor';"),
    '(a) Descargas sigue esperando a Vigilancia: su envoltura de fillSat vive allí');
  assert.ok(html.includes("ensureLazyPart('descargas').then(() => ensureLazyPart('monitor'))"),
    '(a) el cargador garantiza el orden Descargas→Vigilancia para la envoltura de fillSat');
  console.log('OK 2.4.0·W6b (a) — build: descargas y dinero diferidas, fuera del principal, con huella en la CSP.');
}

/* ===== (b)+(c) Servidor: /, las dos partes y la CSP ===== */
const ORIGIN = 'http://127.0.0.1:43747';
const KEY = 'proxy-diferidas2';
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
  assert.ok(csp.includes(lazy.partes.descargas.hash), '(b) la CSP servida autoriza la parte de descargas');
  assert.ok(csp.includes(lazy.partes.dinero.hash), '(b) la CSP servida autoriza la parte de dinero');
  assert.ok(!csp.includes('unsafe-inline'), '(b) la CSP servida sigue sin unsafe-inline');
  const pesoServido = Buffer.byteLength(home.text);
  assert.ok(pesoServido < PESO_TOPE, '(c) la carga inicial servida (' + pesoServido + ' B) queda por debajo del tope vigente (' + PESO_TOPE + ' B, RE-BASE 2.9.13 (852.811 B medidos; contabilidad en ronda1110); antes RE-BASE 2.9.7; referencia histórica 2.3.1: ' + PESO_231 + ' B)');
  assert.ok(statSync(join(ROOT, 'Faro-Fiscal.html')).size < PESO_TOPE, '(c) el artefacto en disco también queda por debajo del tope vigente (' + PESO_TOPE + ' B)');
  assert.ok(!home.text.includes('function dineroScreen'), '(c) la carga inicial no lleva la pantalla de Dinero');
  assert.ok(!home.text.includes('function satCardGrid'), '(c) la carga inicial no lleva la parrilla del Centro SAT');
  const des = await h.call('/parte/descargas');
  assert.equal(des.status, 200, '(b) GET /parte/descargas responde 200');
  assert.ok(des.text.includes('function satDownloadScreen'), '(b) y sirve la pantalla de Descargas');
  assert.ok(des.text.includes('function fillSat'), '(b) y su fillSat real');
  assert.equal(Buffer.byteLength(des.text), Buffer.byteLength(lazy.partes.descargas.source),
    '(b) lo servido es byte a byte la parte sellada en lazy.json');
  const din = await h.call('/parte/dinero');
  assert.equal(din.status, 200, '(b) GET /parte/dinero responde 200');
  assert.ok(din.text.includes('function dineroScreen'), '(b) y sirve la pantalla de Dinero');
  assert.ok(din.text.includes('function cascadaMes240'), '(b) y su cascada del mes');
  assert.equal(Buffer.byteLength(din.text), Buffer.byteLength(lazy.partes.dinero.source),
    '(b) lo servido es byte a byte la parte sellada en lazy.json');
  const noHay = await h.call('/parte/inexistente-w6b');
  assert.equal(noHay.status, 404, '(b) una parte que no existe dice 404');
  h.service.close();
  console.log('OK 2.4.0·W6b (b)+(c) — servidor: / con CSP por huellas, partes servidas byte a byte, inicial en ' +
    pesoServido + ' B (referencia 2.3.1: ' + PESO_231 + ' B).');
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
    const parte = /\/parte\/(\w+)/.exec(target);
    if (parte && lazy.partes[parte[1]])
      return { ok: true, status: 200, headers: { get: () => 'text/javascript' },
        json: async () => ({}), text: async () => lazy.partes[parte[1]].source, blob: async () => new Blob([]) };
    if (target.includes('/parte/'))
      return { ok: true, status: 200, headers: { get: () => 'text/javascript' },
        json: async () => ({}), text: async () => '', blob: async () => new Blob([]) };
    let body = {};
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
    navigator: { onLine: true, userAgent: 'ronda240diferidas2-test' },
    location: { href: 'http://127.0.0.1:43747/', search: '', reload: () => {} },
    localStorage: storageStub(), sessionStorage: storageStub(),
    fetch: fetchStub, setTimeout: timer, setInterval: every, clearTimeout, clearInterval, queueMicrotask,
    URL: BootURL, URLSearchParams, Blob, File, TextEncoder, TextDecoder, btoa, atob,
    crypto: webcrypto, DecompressionStream,
    matchMedia: () => ({ matches: false, addEventListener: () => {}, addListener: () => {} }),
    Option: class extends FakeElement {},
    alert: () => {}, addEventListener: () => {}, removeEventListener: () => {},
    requestAnimationFrame: fn => timer(fn, 0) });
  context.window = context; context.self = context;
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
  for (const nombre of ['satToken', 'satData', 'guestMode', 'satStatus', 'directions'])
    assert.notEqual(tipo(nombre), 'undefined', '(d) «' + nombre + '» vive en el principal desde el arranque');
  assert.equal(vm.runInContext('satToken', ctx), 'token-de-prueba', '(d) satToken sale de la meta, como siempre');
  for (const fn of ['satApi', 'satApiLectura', 'satApiGuardar', 'satApiBlob', 'friendlyError',
      'localDateTime', 'localTime', 'causaP200', 'textoP200', 'vigil200', 'restSwitch',
      'selectPerson', 'satQuickCuando', 'descargarSalida1310'])
    assert.equal(tipo(fn), 'function', '(d) la ayuda del puente «' + fn + '» existe antes de cargar Descargas');
  assert.equal(vm.runInContext("causaP200(null, null).tipo", ctx), 'sin-probar',
    '(d) causaP200 del puente resuelve la puerta sin probar, sin cargar la parte');
  assert.equal(vm.runInContext('vigil200().nivel', ctx), 'ok',
    '(d) vigil200 del puente compone su nivel sin cargar la parte (sin puerta probada ni perfil, su veredicto de siempre)');
  for (const nombre of ['dineroMarcados', 'dineroServerInfo'])
    assert.notEqual(tipo(nombre), 'undefined', '(d) «' + nombre + '» vive en el principal desde el arranque');
  assert.equal(vm.runInContext('dineroMarcados instanceof Set', ctx), true, '(d) dineroMarcados es el Set compartido');
  assert.equal(vm.runInContext('dineroServerInfo instanceof Map', ctx), true, '(d) dineroServerInfo es el Map compartido');
  for (const fn of ['paidByMap', 'balanceOf', 'setInvoiceTerm'])
    assert.equal(tipo(fn), 'function', '(d) la ayuda de Dinero «' + fn + '» vive en el puente');
  vm.runInContext("setInvoiceTerm('uuid-w6b')", ctx);
  assert.equal(vm.runInContext('term', ctx), 'uuid-w6b',
    '(d) setInvoiceTerm del puente fija el término de Facturas sin cargar Dinero');
  for (const fn of ['pollSat', 'downloadSheet', 'requestDialog', 'unlockDialog', 'fillSat', 'satDownloadScreen'])
    assert.equal(tipo(fn), 'function', '(d) el lanzador puente «' + fn + '» existe antes de cargar su parte');
  assert.equal(tipo('dineroScreen'), 'undefined', '(d) dineroScreen aún NO existe: vive en la parte de Dinero');
  assert.equal(tipo('satCardGrid'), 'undefined', '(d) satCardGrid aún NO existe: vive en la parte de Descargas');
  assert.equal(tipo('cascadaMes240'), 'undefined', '(d) cascadaMes240 aún NO existe: vive en la parte de Dinero');
  assert.equal(tipo('satMailSection'), 'undefined', '(d) satMailSection aún NO existe: vive en la parte de Descargas');
  console.log('OK 2.4.0·W6b (d) — puente: núcleo SAT y Dinero en el principal; lo diferido, aún fuera.');
}

/* ===== (e) Orden: Vigilancia trae antes a Descargas ===== */
{
  const ctx = await bootCliente();
  assert.ok(vm.runInContext('fillSat.toString()', ctx).includes('ensureLazyPart'),
    '(e) antes de cargar, fillSat es el lanzador del puente');
  const ok = await vm.runInContext("ensureLazyPart('monitor')", ctx);
  assert.equal(ok, true, '(e) el cargador real trae Vigilancia');
  await flush();
  assert.equal(vm.runInContext("lazyLoadedParts.has('descargas')", ctx), true,
    '(e) pedir Vigilancia cargó ANTES la parte de Descargas');
  assert.equal(vm.runInContext("lazyLoadedParts.has('monitor')", ctx), true,
    '(e) y después la de Vigilancia');
  assert.equal(vm.runInContext('fillSat.name', ctx), 'fillSat240',
    '(e) fillSat ya es la ENVOLTURA de Vigilancia, no el lanzador ni el real a secas');
  assert.ok(!vm.runInContext('pollSat.toString()', ctx).includes('ensureLazyPart'),
    '(e) el puente de pollSat quedó sustituido por el real de Descargas');
  console.log('OK 2.4.0·W6b (e) — orden Descargas→Vigilancia: la envoltura captura el fillSat real.');
}

/* ===== (f) Descargas pinta con la envoltura y su cuota ===== */
{
  const ctx = await bootCliente();
  await vm.runInContext("ensureLazyPart('monitor')", ctx);
  await flush();
  vm.runInContext(`satData.cuotaDescargas240 = { definicion: 'Definición de prueba de la cuota.',
    limiteSat: null, porRfc: { 'AAA010101AAA': { rfc: 'AAA010101AAA', solicitudesEnVentana: 3,
      porTipo: { cfdi: 2, metadata: 1 }, criteriosAlLimite: 0, criteriosAgotados5002: 0,
      semaforo: 'verde', texto: 'Cuota en verde de prueba.', seRenuevaEn: null } } };`, ctx);
  const caja = vm.runInContext(`(() => { const box = n('div'); fillSat(box); return box; })()`, ctx);
  const cuotas = buscar(caja, e => e.dataset && e.dataset.cuota240 === '1');
  assert.equal(cuotas.length, 1, '(f) el fillSat envuelto antepone exactamente una tarjeta de cuota');
  assert.ok(textoDe(caja).includes('Cuota de descargas al SAT'), '(f) la tarjeta de cuota se pinta');
  assert.ok(textoDe(caja).includes('Solicitudes recientes'), '(f) y la pantalla de Descargas de siempre va debajo');
  console.log('OK 2.4.0·W6b (f) — Descargas + Vigilancia cargadas: fillSat envuelto pinta la cuota.');
}

/* ===== (g) Dinero pinta con su parte cargada ===== */
{
  const ctx = await bootCliente();
  const ok = await vm.runInContext("ensureLazyPart('dinero')", ctx);
  assert.equal(ok, true, '(g) el cargador real trae la parte de Dinero');
  await flush();
  assert.equal(vm.runInContext('typeof dineroScreen', ctx), 'function',
    '(g) con la parte cargada, dineroScreen existe');
  assert.equal(vm.runInContext('typeof cascadaMes240', ctx), 'function',
    '(g) y la cascada del mes existe de verdad');
  const partes = vm.runInContext('dineroScreen()', ctx);
  assert.ok(textoDe(partes[0]).includes('El dinero, de un vistazo'),
    '(g) la pantalla de Dinero compone su resumen con la parte cargada');
  assert.ok(textoDe(partes[0]).includes('Por cobrar'),
    '(g) y su panel de saldos');
  /* El estado del puente y el de la parte son LOS MISMOS: marcar
     desde el principal se ve dentro de la parte. */
  vm.runInContext("dineroMarcados.add('uuid-puente')", ctx);
  assert.equal(vm.runInContext("dineroMarcados.has('uuid-puente')", ctx), true,
    '(g) dineroMarcados compartido puente↔parte');
  console.log('OK 2.4.0·W6b (g) — Dinero cargada: la pantalla pinta y el estado es el del puente.');
}

console.log('OK 2.4.0 · W6b diferidas2 completa.');
