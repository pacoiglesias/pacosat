/* ================================================================
   Ronda 2.4.0 · WC2 — Facturas y dinero (castigo 7, 9, 10 y 12,
   lado cliente), sobre el ARTEFACTO construido y la parte
   diferida de Pagos (lazy.json), con el arnés DOM de la casa:
   (7) duplicados por contenido — un par gemelo (mismo emisor,
       importe al centavo y fecha, UUID distinto) se detecta y
       dos facturas que difieren en 1 centavo o en fecha NO;
   (9) antigüedad por contraparte — facturas de juguete caen en
       su banda exacta por días (bordes 30/31, 60/61, 90/91) y
       el total por contraparte cuadra con su saldo;
   (10) cascada del mes — los tres escalones salen de las cifras
       de juguete (REP con su fecha + PUE al emitir) y el saldo
       vivo = cobrado − pagado, sin doble conteo de la PUE;
   (12) 69-B en Pagos — un lote con factura de RFC listado pinta
       el aviso con su RFC antes de dispersar (y su «reciente»
       sale del historial de cambios), y un lote limpio no pinta
       nada.
   ================================================================ */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { URL as NodeURL } from 'node:url';

const ROOT = import.meta.dirname;
const read = name => readFileSync(join(ROOT, name), 'utf8');
const html = read('Faro-Fiscal.html');
const lazy = JSON.parse(read('lazy.json'));
/* RE-BASE integración 2.4.0 (W6b): antiguedadContraparte240,
   cascadaMes240, dineroCascadaSvg240, dineroScreen y los
   paneles de Dinero viven en la parte diferida de Dinero. Los
   bloques (9), (10) y el de pantalla entera inyectan su fuente
   desde lazy.json (lo que el navegador recibe), como ya hacía
   el bloque (12) con la de Pagos. Ninguna aserción cambia. */
const inyectarDinero = ctx =>
  vm.runInContext(lazy.partes.dinero.source, ctx, { filename: 'parte-dinero' });
const OWN = 'MFI6212158B4';
const DIA = 86400000;
const AHORA = Date.parse('2026-11-17T12:00:00Z');
const hace = dias => new Date(AHORA - dias * DIA).toISOString().slice(0, 10);

/* ===== Arnés DOM (el de ronda240facturas) ===== */
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
      remove: (...names) => names.delete(name),
      toggle: (name, force) => {
        const on = force === undefined ? !classes.has(name) : Boolean(force);
        if (on) classes.add(name); else classes.delete(name);
        return on;
      },
      contains: name => classes.has(name)
    };
  }
  get childNodes() { return this.children; }
  append(...kids) { for (const kid of kids) if (kid instanceof FakeElement) this.children.push(kid); }
  prepend(...kids) { for (const kid of [...kids].reverse()) if (kid instanceof FakeElement) this.children.unshift(kid); }
  appendChild(kid) { if (kid instanceof FakeElement) this.children.push(kid); return kid; }
  insertBefore(kid) { if (kid instanceof FakeElement) this.children.push(kid); return kid; }
  removeChild(kid) { this.children = this.children.filter(child => child !== kid); return kid; }
  replaceWith(...kids) { this.children = kids.filter(kid => kid instanceof FakeElement); }
  before() {}
  after() {}
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
FakeElement.prototype.querySelector = function (sel) {
  if (!String(sel).startsWith('.')) return null;
  const clase = String(sel).slice(1);
  return buscar(this, e => String(e.className || '').split(' ').includes(clase)).find(e => e !== this) || null;
};
FakeElement.prototype.querySelectorAll = function (sel) {
  if (!String(sel).startsWith('.')) return [];
  const clase = String(sel).slice(1);
  return buscar(this, e => String(e.className || '').split(' ').includes(clase)).filter(e => e !== this);
};
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
  const documentStub = {
    getElementById: id => {
      if (!byId.has(id)) byId.set(id, new FakeElement('div'));
      return byId.get(id);
    },
    createElement: tag => new FakeElement(tag),
    createElementNS: (_ns, tag) => new FakeElement(tag),
    createTextNode: text => { const nodo = new FakeElement('span'); nodo.textContent = String(text); return nodo; },
    querySelector: selector => metas[selector] ?? null,
    querySelectorAll: () => [],
    addEventListener: () => {},
    removeEventListener: () => {},
    documentElement: new FakeElement('html'),
    body: new FakeElement('body'),
    head: new FakeElement('head'),
    activeElement: null,
    title: ''
  };
  const fetchStub = async url => {
    const target = String(url);
    let body = {};
    if (target.includes('storage/rev')) body = { rev: 1 };
    else if (target.includes('storage?')) body = [];
    else if (target.includes('/api/status')) body = {
      settings: { installName: 'PacoSAT', hasLogo: false },
      buildModified: null, cloudRevision: null, profiles: [], jobs: [], inbox: [], mail: {} };
    return { ok: true, status: 200, headers: { get: () => 'application/json' },
      json: async () => body, text: async () => JSON.stringify(body), blob: async () => new Blob([]) };
  };
  const timer = (fn, ms, ...args) => { const t = setTimeout(fn, ms, ...args); t.unref?.(); return t; };
  const every = (fn, ms, ...args) => { const t = setInterval(fn, ms, ...args); t.unref?.(); return t; };
  const context = vm.createContext({
    console, document: documentStub,
    navigator: { onLine: true, userAgent: 'ronda240dinero-test' },
    location: { href: 'http://127.0.0.1:43729/', search: '', reload: () => {} },
    localStorage: storageStub(), sessionStorage: storageStub(),
    fetch: fetchStub, setTimeout: timer, setInterval: every,
    clearTimeout, clearInterval, queueMicrotask,
    URL: BootURL, URLSearchParams, Blob, File, TextEncoder, TextDecoder, btoa, atob,
    crypto: webcrypto, DecompressionStream,
    matchMedia: () => ({ matches: false, addEventListener: () => {}, addListener: () => {} }),
    Option: class extends FakeElement {},
    alert: () => {}, addEventListener: () => {}, removeEventListener: () => {},
    requestAnimationFrame: fn => timer(fn, 0)
  });
  context.window = context;
  context.self = context;
  return context;
}
const textoDe = el => {
  let texto = el.textContent || '';
  for (const hijo of el.children || []) texto += ' ' + textoDe(hijo);
  return texto;
};
async function bootCliente() {
  const context = makeBootContext();
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  vm.runInContext(script, context, { filename: 'Faro-Fiscal.html#script' });
  for (let i = 0; i < 12; i++) await new Promise(resolve => setTimeout(resolve, 0));
  return context;
}
const PROV = 'PRO010101AAA', CLI = 'CLI010101AA1';
const inv = (id, fecha, from, to, total, metodo = 'PPD', folio = '') => ({
  id, kind: 'I', date: fecha, total, currency: 'MXN',
  from: { rfc: from, name: from === PROV ? 'Proveedor Uno' : from === OWN ? 'Mano Fil, S.A.' : 'Cliente ' + folio },
  to: { rfc: to, name: to === OWN ? 'Mano Fil, S.A.' : 'Cliente ' + folio },
  fiscal: { serie: 'A', folio, paymentMethod: metodo, paymentForm: '99', transferred: [], withheld: [] },
  concepts: [] });
function semillaBase(ctx, filas) {
  ctx.Node = FakeElement;
  vm.runInContext(`scope = "${OWN}"; people = [{ id: "${OWN}", name: "Mano Fil, S.A." }];
    documents = []; activity = []; invoices = ${JSON.stringify(filas)};`, ctx);
  vm.runInContext(`satApi = async () => ({}); render = () => {};`, ctx);
}

/* ===== (7) duplicados por contenido ===== */
{
  const ctx = await bootCliente();
  const G1 = '11111111-1111-4111-8111-111111111111';
  const G2 = '22222222-2222-4222-8222-222222222222';
  const CENT = '33333333-3333-4333-8333-333333333333';
  const FECHA = '44444444-4444-4444-8444-444444444444';
  const OTRO = '55555555-5555-4555-8555-555555555555';
  const filas = [
    inv(G1, '2026-11-03', PROV, OWN, '1160.00', 'PPD', '201'),
    inv(G2, '2026-11-03', PROV, OWN, '1160.00', 'PPD', '202'),
    inv(CENT, '2026-11-03', PROV, OWN, '1160.01', 'PPD', '203'),
    inv(FECHA, '2026-11-04', PROV, OWN, '1160.00', 'PPD', '204'),
    inv(OTRO, '2026-11-03', CLI, OWN, '1160.00', 'PPD', '205'),
    inv(G1, '2026-11-03', PROV, OWN, '1160.00', 'PPD', '201')
  ];
  semillaBase(ctx, filas);
  const pares = vm.runInContext('duplicadosContenido240(invoices)', ctx);
  assert.equal(pares.length, 1, '(7) se detecta exactamente un par gemelo');
  assert.equal(JSON.stringify(pares[0].filas.map(f => f.id).sort()), JSON.stringify([G1, G2].sort()),
    '(7) el par son las dos facturas de UUID distinto con emisor, importe y fecha idénticos');
  assert.equal(String(pares[0].cents), '116000', '(7) el importe del par es exacto al centavo');
  const sinGemelo = vm.runInContext(`duplicadosContenido240(invoices.filter(f => f.id !== "${G2}"))`, ctx);
  assert.equal(sinGemelo.length, 0,
    '(7) sin la gemela no hay par: la que difiere en 1 centavo, la de otra fecha y la de otro emisor NO cuentan');
  const panelEl = vm.runInContext('duplicadosPanel240()', ctx);
  assert.ok(panelEl, '(7) con un par, el panel de Problemas se pinta');
  assert.equal(panelEl.dataset.duplicados240, '1', '(7) el panel declara su número de pares');
  const texto = textoDe(panelEl);
  assert.ok(texto.includes('Posible duplicado del emisor') && texto.includes('Proveedor Uno') &&
    texto.includes('$1,160.00') && texto.includes('pagar dos veces la misma compra') ||
    texto.includes('pagas dos veces la misma compra'),
    '(7) el hallazgo trae su semáforo en palabras: de quién es (el emisor) y qué significa (pagar dos veces)');
  const botones = buscar(panelEl, e => e.tagName === 'BUTTON' && (e.textContent || '').startsWith('Ver la factura'));
  assert.equal(botones.length, 2, '(7) la sospecha enlaza a LAS DOS facturas');
  assert.ok(botones.some(b => b.textContent.includes('Folio A-201')) && botones.some(b => b.textContent.includes('Folio A-202')),
    '(7) cada enlace nombra el folio de su factura');
  vm.runInContext(`invoices = invoices.filter(f => f.id !== "${G2}");`, ctx);
  assert.equal(vm.runInContext('duplicadosPanel240()', ctx), null,
    '(7) sin pares, no hay panel: la superficie no crece con tarjetas vacías');
  console.log('OK 2.4.0·WC2 (7) — par gemelo detectado y enlazado; 1 centavo o 1 día de diferencia no disparan.');
}

/* ===== (9) antigüedad por contraparte ===== */
{
  const ctx = await bootCliente();
  semillaBase(ctx, []);
  inyectarDinero(ctx);
  /* Los items se construyen DENTRO del contexto: sus saldos son
     BigInt, como los de balanceOf en la pantalla real. */
  const datos = vm.runInContext(`(() => {
    const items = [
      { row: { id: 'e10', date: '${hace(10)}', from: { rfc: '${PROV}', name: 'Proveedor Uno' } }, balance: 10000n },
      { row: { id: 'e30', date: '${hace(30)}', from: { rfc: '${PROV}', name: 'Proveedor Uno' } }, balance: 20000n },
      { row: { id: 'e31', date: '${hace(31)}', from: { rfc: '${PROV}', name: 'Proveedor Uno' } }, balance: 30000n },
      { row: { id: 'e60', date: '${hace(60)}', from: { rfc: '${PROV}', name: 'Proveedor Uno' } }, balance: 35000n },
      { row: { id: 'e61', date: '${hace(61)}', from: { rfc: '${PROV}', name: 'Proveedor Uno' } }, balance: 40000n },
      { row: { id: 'e90', date: '${hace(90)}', from: { rfc: '${PROV}', name: 'Proveedor Uno' } }, balance: 45000n },
      { row: { id: 'e91', date: '${hace(91)}', from: { rfc: '${PROV}', name: 'Proveedor Uno' } }, balance: 50000n },
      { row: { id: 'x5', date: '${hace(5)}', from: { rfc: '${CLI}', name: 'Cliente Cinco' } }, balance: 7000n }
    ];
    return antiguedadContraparte240(items, 'from', ${AHORA}).map(cp => ({
      rfc: cp.rfc, total: String(cp.total),
      bandas: cp.bandas.map(b => ({ label: b.label, cents: String(b.cents), count: b.count })) }));
  })()`, ctx);
  assert.equal(datos.length, 2, '(9) dos contrapartes con saldo');
  assert.equal(datos[0].rfc, PROV, '(9) la contraparte mayor va primero');
  assert.equal(datos[0].total, '230000', '(9) el total por contraparte cuadra con la suma de sus saldos vivos');
  assert.equal(JSON.stringify(datos[0].bandas.map(b => [b.label, b.cents, b.count])), JSON.stringify([
    ['0–30 días', '30000', 2], ['31–60 días', '65000', 2],
    ['61–90 días', '85000', 2], ['Más de 90 días', '50000', 1]]),
    '(9) cada factura cae en su banda exacta por días (bordes 30/31, 60/61, 90/91 incluidos)');
  const panelEl = vm.runInContext(`dineroAntiguedadContrapartePanel240([], [
    { row: { id: 'p1', date: '${hace(95)}', from: { rfc: '${PROV}', name: 'Proveedor Uno' }, to: { rfc: '${OWN}', name: 'Mano Fil' } }, balance: 50000n }])`, ctx);
  const chips = buscar(panelEl, e => e.dataset.banda240);
  assert.equal(chips.length, 1, '(9) el panel pinta solo las bandas con saldo');
  assert.equal(chips[0].dataset.banda240, 'Más de 90 días', '(9) la banda del chip es la de su edad');
  assert.equal(chips[0].dataset.estado, 'error', '(9) la banda vieja lleva su estado con icono y palabra (W5a)');
  assert.equal(chips[0].dataset.rfc240, PROV, '(9) el chip lleva la contraparte a la que navega');
  assert.ok(textoDe(panelEl).includes('$500.00') && textoDe(panelEl).includes('Proveedor Uno'),
    '(9) la tarjeta enseña contraparte e importe, no una tabla pelada');
  console.log('OK 2.4.0·WC2 (9) — bandas exactas por días y total por contraparte cuadrado con su saldo.');
}

/* ===== (10) cascada del mes ===== */
{
  const ctx = await bootCliente();
  const I1 = 'c1111111-1111-4111-8111-111111111111';
  const I2 = 'c2222222-2222-4222-8222-222222222222';
  const I3 = 'c3333333-3333-4333-8333-333333333333';
  const I4 = 'c4444444-4444-4444-8444-444444444444';
  const I5 = 'c5555555-5555-4555-8555-555555555555';
  const I6 = 'c6666666-6666-4666-8666-666666666666';
  const rep = (id, fechaPago, docs) => ({
    id, kind: 'P', date: fechaPago, total: '0.00', currency: 'XXX',
    from: { rfc: OWN, name: 'Mano Fil, S.A.' }, to: { rfc: CLI, name: 'Cliente' },
    fiscal: { serie: '', folio: '', payments: { pagos: [{ fechaPago, documentos: docs }] },
      transferred: [], withheld: [] }, concepts: [] });
  const filas = [
    inv(I1, '2026-11-03', OWN, CLI, '5000.00', 'PUE', '301'),
    inv(I2, '2026-11-05', OWN, CLI, '10000.00', 'PPD', '302'),
    inv(I3, '2026-11-06', PROV, OWN, '3000.00', 'PPD', '303'),
    inv(I4, '2026-11-07', PROV, OWN, '2000.00', 'PUE', '304'),
    inv(I5, '2026-10-05', OWN, CLI, '9000.00', 'PPD', '305'),
    inv(I6, '2026-11-08', OWN, CLI, '7000.00', 'PUE', '306'),
    rep('p-i2', '2026-11-10', [{ idDocumento: I2, impPagado: '4000.00' }]),
    rep('p-i3', '2026-11-12', [{ idDocumento: I3, impPagado: '3000.00' }]),
    rep('p-i5', '2026-10-20', [{ idDocumento: I5, impPagado: '9000.00' }]),
    rep('p-i1', '2026-11-15', [{ idDocumento: I1, impPagado: '5000.00' }])
  ];
  semillaBase(ctx, filas);
  inyectarDinero(ctx);
  vm.runInContext(`fiscalResults.set("${I6}", { sat: { state: "Cancelado" } });`, ctx);
  const cifras = vm.runInContext(`(() => { const c = cascadaMes240(invoices, '2026-11', new Set(['${OWN}']));
    return { cobrado: String(c.cobrado), pagado: String(c.pagado), saldo: String(c.saldo) }; })()`, ctx);
  assert.equal(cifras.cobrado, '900000',
    '(10) cobrado de noviembre = PUE emitida $5,000 + REP de la PPD $4,000 (el REP de la PUE no duplica; la cancelada y octubre, fuera)');
  assert.equal(cifras.pagado, '500000', '(10) pagado de noviembre = REP de la recibida $3,000 + PUE recibida $2,000');
  assert.equal(cifras.saldo, '400000', '(10) saldo vivo = cobrado − pagado');
  const svg = vm.runInContext(`dineroCascadaSvg240(900000n, 500000n, 400000n, '2026-11')`, ctx);
  assert.equal(svg.dataset.cascada240, '2026-11', '(10) la gráfica declara su mes');
  const textoSvg = textoDe(svg);
  assert.ok(textoSvg.includes('$9,000.00') && textoSvg.includes('− $5,000.00') && textoSvg.includes('$4,000.00'),
    '(10) los tres escalones van rotulados en pesos, con la diferencia del paso intermedio');
  assert.ok(textoSvg.includes('Saldo vivo'), '(10) el tercer escalón se nombra «Saldo vivo»');
  const vacia = vm.runInContext(`dineroCascadaSvg240(0n, 0n, 0n, '2026-11')`, ctx);
  assert.ok(textoDe(vacia).includes('la cascada queda a cero'), '(10) un mes sin movimientos lo dice, no pinta una gráfica falsa');
  console.log('OK 2.4.0·WC2 (10) — cascada: $9,000.00 cobrado − $5,000.00 pagado = $4,000.00 de saldo vivo.');
}

/* ===== (9)+(10) la pantalla Dinero entera, con sus paneles ===== */
{
  const ctx = await bootCliente();
  const filas = [
    inv('smoke-1', '2026-09-01', PROV, OWN, '1160.00', 'PPD', '901'),
    inv('smoke-2', '2026-11-02', OWN, CLI, '2320.00', 'PPD', '902')
  ];
  semillaBase(ctx, filas);
  inyectarDinero(ctx);
  const vista = vm.runInContext('dineroScreen()', ctx);
  for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 0));
  const texto = textoDe(vista[0]);
  assert.ok(texto.includes('Antigüedad por contraparte'), '(9) la pantalla Dinero pinta el panel de antigüedad por contraparte');
  assert.ok(texto.includes('La cascada del mes'), '(10) la pantalla Dinero pinta el panel de la cascada');
  assert.ok(texto.includes('Proveedor Uno') && texto.includes('$1,160.00'),
    '(9) el panel de la pantalla enseña la contraparte con su saldo vivo');
  console.log('OK 2.4.0·WC2 (9)(10) — Dinero entera pinta con antigüedad por contraparte y cascada.');
}

/* ===== (12) semáforo 69-B en Pagos ===== */
{
  const ctx = await bootCliente();
  semillaBase(ctx, []);
  assert.ok(lazy.partes.pagos, '(12) la parte diferida de Pagos consta en lazy.json');
  vm.runInContext(lazy.partes.pagos.source, ctx, { filename: 'pagos.lazy' });
  const MALO = 'MAL010101XX1', BUENO = 'BUE020202YY2', ACLARADO = 'ACL030303ZZ3';
  const datosListas = {
    counterparts: [
      { rfc: MALO, name: 'Malo, S.A.', hits: [{ listId: '69b', label: 'Listado 69-B', detail: 'Definitivo', severity: 'bad' }] },
      { rfc: BUENO, name: 'Bueno, S.A.', hits: [] },
      { rfc: ACLARADO, name: 'Aclarado, S.A.', hits: [{ listId: '69b', label: 'Listado 69-B', detail: 'Desvirtuado', severity: 'ok' }] }
    ],
    events: [{ rfc: MALO, listId: '69b', change: 'Alta nueva', detail: 'Definitivo', at: Date.UTC(2026, 10, 15, 12) }]
  };
  const lineas = [
    { rfc: MALO, nombre: 'Malo, S.A.', folio: 'A-55', uuid: 'uuid-de-la-mala', total: '100.00' },
    { rfc: BUENO, nombre: 'Bueno, S.A.', folio: 'A-56', uuid: 'uuid-de-la-buena', total: '200.00' },
    { rfc: ACLARADO, nombre: 'Aclarado, S.A.', folio: 'A-57', uuid: 'uuid-de-la-aclarada', total: '300.00' }
  ];
  const avisos = vm.runInContext(`pagosCruce69b240(${JSON.stringify(lineas)}, ${JSON.stringify(datosListas)})`, ctx);
  assert.equal(avisos.length, 1, '(12) el cruce marca solo la factura del RFC listado vigente (la aclarada no avisa)');
  assert.equal(avisos[0].rfc, MALO, '(12) el aviso nombra el RFC listado');
  assert.equal(avisos[0].folio, 'A-55', '(12) el aviso nombra su factura');
  assert.equal(avisos[0].reciente, true, '(12) el «Alta nueva» del historial marca el aviso como reciente');
  const el = vm.runInContext(`pagosAviso69bEl240(${JSON.stringify(lineas)}, ${JSON.stringify(datosListas)})`, ctx);
  assert.ok(el, '(12) el lote con RFC listado pinta su aviso antes de dispersar');
  assert.equal(el.dataset.pagos69b240, '1', '(12) el aviso declara cuántos RFC del lote están listados');
  const texto = textoDe(el);
  assert.ok(texto.includes('Antes de dispersar') && texto.includes(MALO) && texto.includes('folio A-55'),
    '(12) el aviso es protagonista: dice «Antes de dispersar», el RFC y la factura');
  assert.ok(texto.includes('reciente') && texto.includes('no bloquea el pago'),
    '(12) el aviso dice que es reciente y que no bloquea: decide Paco');
  const sinEventos = { counterparts: datosListas.counterparts, events: [] };
  const elSin = vm.runInContext(`pagosAviso69bEl240(${JSON.stringify(lineas)}, ${JSON.stringify(sinEventos)})`, ctx);
  assert.ok(textoDe(elSin).includes('no consta un alta reciente'),
    '(12) sin historial que lo pruebe, el aviso dice «consta listado; no consta alta reciente» — no inventa la fecha');
  const limpias = lineas.filter(l => l.rfc !== MALO);
  assert.equal(vm.runInContext(`pagosAviso69bEl240(${JSON.stringify(limpias)}, ${JSON.stringify(datosListas)})`, ctx), null,
    '(12) un lote limpio no pinta nada');
  console.log('OK 2.4.0·WC2 (12) — lote con RFC 69-B recién listado avisa con su RFC y su factura; lote limpio, silencio.');
}
