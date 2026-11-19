/* ================================================================
   Ronda 2.4.0 · W5b2 — gráficas aplicadas II: sparklines (1),
   línea de tiempo del CFDI (6), portada de acceso (10),
   esqueletos aplicados (4b) y migración de glifos (9b).
   Sobre el ARTEFACTO construido y con el arnés DOM de la casa:
   (1) la sparkline sale de una serie de juguete con sus
       puntos EXACTOS y no se pinta sin serie; las series de
       Hoy y Dinero salen de los datos que cada pantalla ya
       trae (cobrado por mes con la regla PUE/complemento;
       emitido por mes de monthlyTotals).
   (6) la línea de tiempo de una factura pagada con REP pinta
       emitido → pagado → REP con sus fechas reales; la
       cancelada añade el cuarto paso; la PPD sin pagar se
       queda en emitido.
   (10) la portada trae la marca, el nombre y el estado que
       sale de /healthz (puro sobre su respuesta); sin lectura
       posible, el estado es el honesto, no un «en línea».
   (4b) el esqueleto se pinta ANTES del dato en una doble de
       carga diferida y desaparece al pintar el dato.
   (9b) ningún glifo viejo (✓ ✗ ⚠ ⏳ ● ○ ✕) queda en los
       ficheros de W5b2: ui, money-ui, workflows, layout,
       final-ui.
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
/* RE-BASE integración 2.4.0 (W6b): dineroSerieMensual240 vive
   en la parte diferida de Dinero. El bloque de series reales
   inyecta su fuente desde lazy.json (lo que el navegador
   recibe) antes de pedir la serie. Ninguna aserción cambia. */
const lazy = JSON.parse(read('lazy.json'));
const OWN = 'MFI6212158B4', CLI = 'CLI010101AA1';

/* ===== Arnés DOM (el de ronda240hoy) ===== */
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
  remove() { this.children = []; }
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
  const oyentes = new Map();
  const metas = { 'meta[name="pacosat-token"]': { content: 'token-de-prueba' },
    'meta[name="pacosat-cloud"]': { content: '1' } };
  const documentStub = {
    __oyentes: oyentes,
    getElementById: id => {
      if (!byId.has(id)) byId.set(id, new FakeElement('div'));
      return byId.get(id);
    },
    createElement: tag => new FakeElement(tag),
    createElementNS: (_ns, tag) => new FakeElement(tag),
    createTextNode: text => ({ textContent: String(text) }),
    querySelector: selector => metas[selector] ?? null,
    querySelectorAll: () => [],
    addEventListener: (type, fn) => { if (!oyentes.has(type)) oyentes.set(type, []); oyentes.get(type).push(fn); },
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
    navigator: { onLine: true, userAgent: 'ronda240graficos3-test' },
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
const inv = (id, date, total, metodo) => ({
  id, kind: 'I', date, total, currency: 'MXN',
  from: { rfc: OWN, name: 'Mano Fil, S.A.' }, to: { rfc: CLI, name: 'Cliente Uno' },
  fiscal: { serie: 'A', folio: '1', paymentMethod: metodo, paymentForm: '99', transferred: [], withheld: [] },
  concepts: [] });
const REP_JUGUETE = {
  id: 'rep-1', kind: 'P', date: '2026-02-10', total: '0.00', currency: 'XXX',
  from: { rfc: CLI, name: 'Cliente Uno' }, to: { rfc: OWN, name: 'Mano Fil, S.A.' },
  fiscal: { payments: { pagos: [{ fechaPago: '2026-02-09', formaDePagoP: '03',
    documentos: [{ idDocumento: 'u-ppd', impPagado: '1160.00', impSaldoAnt: '1160.00', impSaldoInsoluto: '0.00' }] }] } },
  concepts: [] };

/* ===== (1) Sparkline: puntos exactos y «sin serie, no se pinta» ===== */
{
  const ctx = await bootCliente();
  ctx.Node = FakeElement;
  const puntos = vm.runInContext('sparklinePuntos240([0, 50, 100])', ctx);
  assert.equal(JSON.stringify(puntos.map(p => [...p])), JSON.stringify([[3, 25], [48, 14], [93, 3]]),
    '(1) la sparkline de [0,50,100] cae en sus puntos exactos (ancho 96, alto 28, margen 3)');
  assert.equal(JSON.stringify(vm.runInContext('sparklinePuntos240([7, 7])', ctx).map(p => [...p])), JSON.stringify([[3, 14], [93, 14]]),
    '(1) serie plana: la línea va por el centro');
  assert.equal(vm.runInContext('sparkline240([5])', ctx), null, '(1) un solo punto no es serie: no se pinta');
  assert.equal(vm.runInContext('sparkline240([])', ctx), null, '(1) sin serie no se pinta nada');
  assert.equal(vm.runInContext('sparklineBloque240([], "últimos 6 meses")', ctx), null,
    '(1) el bloque tampoco se pinta sin serie');
  const bloque = vm.runInContext('sparklineBloque240([{ mes: "2026-01", cents: 100n }, { mes: "2026-02", cents: 300n }], "Emitido por mes · últimos 6 meses", "Tendencia")', ctx);
  assert.ok(bloque, '(1) con serie de dos meses el bloque se pinta');
  assert.equal(bloque.dataset.spark240, '1', '(1) el bloque va sellado');
  assert.ok(textoDe(bloque).includes('últimos 6 meses'), '(1) el periodo va nombrado en palabra');
  const svg = buscar(bloque, e => e.tagName === 'svg' || e.tagName === 'SVG')[0] || buscar(bloque, e => String(e.tagName).toLowerCase() === 'svg')[0];
  assert.ok(svg, '(1) el bloque contiene su SVG propio');
  console.log('OK 2.4.0·W5b2 (1) — sparkline con puntos exactos y sin serie no se pinta.');
}
/* ===== (1) Las series reales de Hoy y de Dinero ===== */
{
  const ctx = await bootCliente();
  ctx.Node = FakeElement;
  const filas = [inv('u-pue', '2026-09-05', '500.00', 'PUE'), inv('u-ppd', '2026-01-05', '1160.00', 'PPD'), REP_JUGUETE];
  vm.runInContext(`scope = "${OWN}"; people = [{ id: "${OWN}", name: "Mano Fil, S.A." }];
    invoices = ${JSON.stringify(filas)}; documents = []; activity = [];`, ctx);
  vm.runInContext(lazy.partes.dinero.source, ctx, { filename: 'parte-dinero' });
  const serieHoy = vm.runInContext('hoySerieCobrado240(6)', ctx);
  assert.equal(JSON.stringify(serieHoy.map(s => [s.mes, String(s.cents)])), JSON.stringify([['2026-02', '116000'], ['2026-09', '50000']]),
    '(1) Hoy: la PUE cobra en su mes de emisión y la PPD en el mes de la fechaPago de su complemento, sin duplicar');
  const serieDinero = vm.runInContext('dineroSerieMensual240(6)', ctx);
  assert.equal(JSON.stringify(serieDinero.map(s => [s.mes, String(s.cents)])), JSON.stringify([['2026-01', '116000'], ['2026-02', '0'], ['2026-09', '50000']]),
    '(1) Dinero: la serie es la de monthlyTotals (lo emitido por mes), la que alimenta su gráfica — febrero consta con 0 porque ese mes solo trae el REP, como en el comparativo');
  console.log('OK 2.4.0·W5b2 (1) — series reales de Hoy y Dinero, sin inventar ninguna.');
}
/* ===== (3) Destello solo con cambio real ===== */
{
  const ctx = await bootCliente();
  ctx.Node = FakeElement;
  const r = vm.runInContext(`(() => {
    const el = document.createElement('span');
    marcarCifra240(el, '$100.00');
    const primero = el.classList.contains('cifra-nueva');
    marcarCifra240(el, '$100.00');
    const mismo = el.classList.contains('cifra-nueva');
    marcarCifra240(el, '$200.00');
    const cambio = el.classList.contains('cifra-nueva');
    const a = document.createElement('span'), b = document.createElement('span'), c = document.createElement('span');
    marcarCifraPulso240(a, 'clave-prueba', '1');
    marcarCifraPulso240(b, 'clave-prueba', '2');
    marcarCifraPulso240(c, 'clave-prueba', '2');
    return { primero, mismo, cambio, pulsoA: a.classList.contains('cifra-nueva'),
      pulsoB: b.classList.contains('cifra-nueva'), pulsoC: c.classList.contains('cifra-nueva') };
  })()`, ctx);
  assert.deepEqual({ ...r }, { primero: false, mismo: false, cambio: true, pulsoA: false, pulsoB: true, pulsoC: false },
    '(3) ni el primer pintado ni el mismo valor destellan; el cambio real sí, también entre repintados del pulso');
  console.log('OK 2.4.0·W5b2 (3) — .cifra-nueva solo cuando el valor cambia de verdad.');
}
/* ===== (6) Línea de tiempo del CFDI ===== */
{
  const ctx = await bootCliente();
  ctx.Node = FakeElement;
  vm.runInContext(`invoices = ${JSON.stringify([inv('u-ppd', '2026-01-05', '1160.00', 'PPD'), REP_JUGUETE])};`, ctx);
  const pasos = vm.runInContext(`cfdiLineaDatos240(invoices.find(r => r.id === "u-ppd"), invoices, {})`, ctx);
  assert.equal(JSON.stringify(pasos.map(p => [p.clave, p.estado, p.fecha])),
    JSON.stringify([['emitido', 'hecho', '2026-01-05'], ['pagado', 'hecho', '2026-02-09'], ['rep', 'hecho', '2026-02-10']]),
    '(6) pagada con REP: tres pasos con sus fechas reales (emisión, fechaPago del complemento, fecha del REP)');
  const cancelada = vm.runInContext(`cfdiLineaDatos240(invoices.find(r => r.id === "u-ppd"), invoices,
    { cancelada: true, fechaCancelacion: ${Date.UTC(2026, 2, 15, 12)} })`, ctx);
  assert.equal(cancelada.length, 4, '(6) la cancelada añade el cuarto paso');
  assert.equal(cancelada[3].clave, 'cancelado', '(6) el cuarto paso es la cancelación');
  assert.equal(cancelada[3].fecha, Date.UTC(2026, 2, 15, 12), '(6) su fecha es la de la vigilancia, la que consta');
  const sinPagar = vm.runInContext(`cfdiLineaDatos240(invoices.find(r => r.id === "u-ppd"), [invoices[0]], {})`, ctx);
  assert.equal(JSON.stringify(sinPagar.map(p => p.clave)), JSON.stringify(['emitido']), '(6) la PPD sin pagar se queda en emitido');
  const visual = vm.runInContext(`cfdiLineaVisual240(cfdiLineaDatos240(invoices.find(r => r.id === "u-ppd"), invoices, {}))`, ctx);
  const texto = textoDe(visual);
  for (const palabra of ['Emitido', 'Pagado', 'REP', 'Hecho', '05/01/2026', '09/02/2026', '10/02/2026'])
    assert.ok(texto.includes(palabra), '(6) la línea pintada enseña «' + palabra + '»');
  const chips = buscar(visual, e => e.dataset && e.dataset.estado);
  assert.ok(chips.length === 3 && chips.every(c => c.dataset.estado === 'aldia'),
    '(6) cada paso hecho va con su estado icono+palabra (data-estado=aldia)');
  console.log('OK 2.4.0·W5b2 (6) — línea de tiempo emitido → pagado → REP (+cancelado) con fechas reales.');
}
/* ===== (10) Portada de acceso ===== */
{
  assert.ok(html.includes('id="entry"'), '(10) la portada de acceso existe en el artefacto');
  const entrada = html.slice(html.indexOf('id="entry"'), html.indexOf('id="toasts"'));
  assert.ok(entrada.includes('#i-logo'), '(10) la portada abre con el faro de la marca en grande');
  assert.ok(entrada.includes('entry-title'), '(10) la portada lleva el nombre de la instalación');
  assert.ok(entrada.includes('id="entry-estado240"'), '(10) la portada tiene su hueco de estado del sistema');
  assert.ok(entrada.includes('id="entry-pass"') && entrada.includes('id="entry-form"'),
    '(10) el flujo de credenciales queda intacto');
  const ctx = await bootCliente();
  const enLinea = vm.runInContext(`entradaEstado240({ ok: true, version: "2.3.2", db: "ok" })`, ctx);
  assert.equal(enLinea.estado, 'aldia', '(10) con /healthz ok, el estado es «al día»');
  assert.ok(enLinea.texto.includes('Sistema en línea'), '(10) y su palabra es «Sistema en línea»');
  const caido = vm.runInContext(`entradaEstado240({ ok: false, version: "2.3.2", db: "sin respuesta en el plazo" })`, ctx);
  assert.equal(caido.estado, 'error', '(10) con la base sin respuesta, el estado es error, no un «en línea» fingido');
  const sinLectura = vm.runInContext(`entradaEstado240(null)`, ctx);
  assert.equal(sinLectura.estado, 'atencion', '(10) sin lectura posible, el estado lo dice: atención');
  assert.ok(sinLectura.texto.includes('No se pudo comprobar'), '(10) la palabra honesta de la falta de lectura');
  assert.ok(read('ui.part').includes("fetch('/healthz'"), '(10) la lectura de la portada es la ruta sin sesión /healthz');
  console.log('OK 2.4.0·W5b2 (10) — portada con marca, nombre y estado honesto desde /healthz.');
}
/* ===== (4b) Esqueleto antes del dato, en una doble diferida ===== */
{
  const ctx = await bootCliente();
  ctx.Node = FakeElement;
  const r = vm.runInContext(`(() => {
    const caja = document.createElement('div');
    caja.setAttribute('aria-busy', 'true');
    caja.append(esqueletoPantalla240(3));
    const antes = caja.children.length === 1 && caja.children[0].dataset.esqueleto240 === '1' &&
      caja.children[0].children.some(h => h.className === 'sk-hero') &&
      caja.children[0].children.filter(h => h.className === 'sk-fila').length === 3;
    const dato = document.createElement('p');
    dato.textContent = 'El dato, por fin';
    caja.replaceChildren(dato);
    caja.removeAttribute('aria-busy');
    const despues = caja.children.length === 1 && caja.children[0] === dato &&
      !caja.children.some(h => h.dataset && h.dataset.esqueleto240);
    return { antes, despues };
  })()`, ctx);
  assert.deepEqual({ ...r }, { antes: true, despues: true },
    '(4b) la doble enseña primero el esqueleto (protagonista + 3 filas) y el dato lo sustituye entero');
  const ui = read('ui.part');
  assert.ok(ui.includes('esqueletoPantalla240(3)'), '(4b) Hoy carga con su esqueleto de forma');
  assert.ok(ui.includes('esqueletoPantalla240(2)'), '(4b) la carga diferida de pantallas enseña su esqueleto');
  assert.ok(read('money-ui.part').includes('sk-graf'), '(4b) el flujo de Dinero espera con su silueta de gráfica');
  assert.ok(read('workflows.part').includes('esqueletoPantalla240(2)'), '(4b) la historia del CFDI espera con su esqueleto');
  console.log('OK 2.4.0·W5b2 (4b) — esqueletos aplicados con la forma de cada pantalla.');
}
/* ===== (9b) Ningún glifo viejo en el territorio W5b2 ===== */
{
  const GLIFOS = ['✓', '✗', '⚠', '⏳', '●', '○', '✕'];
  for (const fichero of ['ui.part', 'money-ui.part', 'workflows.part', 'layout.part', 'final-ui.part']) {
    const fuente = read(fichero);
    for (const glifo of GLIFOS)
      assert.ok(!fuente.includes(glifo), '(9b) sin el glifo «' + glifo + '» en ' + fichero);
  }
  console.log('OK 2.4.0·W5b2 (9b) — migración de glifos completa en ui, money-ui, workflows, layout y final-ui.');
}
console.log('OK 2.4.0·W5b2 gráficos II — sparklines, línea de tiempo, portada, esqueletos y glifos.');
