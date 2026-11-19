/* ================================================================
   Ronda 2.4.0 · WC4b2 — Descargas y uso diario: castigo 2 (tarjeta
   de cuota), 27 («baja lo mismo del mes pasado»), 26 (calendario
   fiscal pintado) y 25 (deshacer también en lote).
   Sobre el ARTEFACTO construido y con el arnés DOM de la casa
   (ronda240documentos/ronda240facturas):
   (a) la tarjeta de cuota pinta el dato SERVIDO de juguete por RFC:
       solicitudes en la ventana con su desglose, el semáforo con
       icono y palabra, el texto TAL CUAL lo compone el servidor,
       la renovación en llano y, con limiteSat null, «el SAT no
       publica una cuota» sin tope inventado; la definición servida
       vive en su «Qué significa».
   (b) «baja lo mismo» compone el mes anterior con los parámetros
       de la descarga MANUAL del mes pasado de juguete (sentido y
       tipo del libro de criterios; el envío «monthly» NO cuenta)
       y NO envía nada: compone la hoja y el satApi no registra
       ninguna petición «request». Sin manual el mes pasado,
       compone con lo habitual y lo dice.
   (c) el calendario de Cumplimiento coloca un vencimiento servido
       en su día exacto, la lista de siempre sigue debajo y tocar
       el día enseña sus vencimientos.
   (d) el archivado en lote de Facturas: la barra nace con la
       selección, «Archivar varios» archiva los N por la ruta de
       siempre, el lote queda asentado en el Registro como UN
       hecho con su conteo y su «Deshacer» restaura el lote entero
       con un gesto. Un lote con un fallo a mitad dice qué entró
       y qué no, y el Deshacer cubre solo lo archivado.
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
/* RE-BASE integración 2.4.0 (W6/W6b): la tarjeta de cuota vive
   en la envoltura de fillSat que trae la parte de Vigilancia,
   y fillSat/pollSat reales en la de Descargas. El arnés sirve
   las partes desde lazy.json por el fetch y el head EJECUTA
   los scripts inyectados, como el navegador con el cargador
   real (patrón de tests/ronda240diferidas): pedir Vigilancia
   carga antes Descargas, que es la puerta descargar→monitor
   de producción. Ninguna aserción cambia. */
const lazy = JSON.parse(read('lazy.json'));
const OWN = 'AAA010101AAA';

/* ===== Arnés DOM (el de ronda240documentos) ===== */
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
/* Vencimientos de juguete que sirve el «servidor» de la suite. */
let eventosJuguete = [];
/* Estado extra que el /api/status de juguete sirve en cada bloque
   (cuota, libro de criterios, perfiles): la vía real por la que
   esos datos llegan al cliente, sin carreras con el pulso. */
let estadoServido240 = {};
function makeBootContext() {
  const byId = new Map();
  const metas = { 'meta[name="pacosat-token"]': { content: 'token-de-prueba' },
    'meta[name="pacosat-cloud"]': { content: '1' } };
  const headEl = new FakeElement('head');
  const documentStub = {
    getElementById: id => {
      if (!byId.has(id)) byId.set(id, new FakeElement('div'));
      return byId.get(id);
    },
    createElement: tag => new FakeElement(tag),
    createElementNS: (_ns, tag) => new FakeElement(tag),
    createTextNode: text => ({ textContent: String(text) }),
    querySelector: selector => metas[selector] ?? null,
    querySelectorAll: () => [],
    addEventListener: () => {},
    removeEventListener: () => {},
    documentElement: new FakeElement('html'),
    body: new FakeElement('body'),
    head: headEl,
    activeElement: null,
    title: ''
  };
  const fetchStub = async url => {
    const target = String(url);
    const parteM = /\/parte\/(\w+)/.exec(target);
    if (parteM) { const src = lazy.partes[parteM[1]]?.source || '';
      return { ok: true, status: 200, headers: { get: () => 'text/javascript' },
        json: async () => ({}), text: async () => src, blob: async () => new Blob([]) }; }
    let body = {};
    if (target.includes('storage/rev')) body = { rev: 1 };
    else if (target.includes('storage?')) body = [];
    else if (target.includes('fiscal/calendar')) body = { events: eventosJuguete };
    else if (target.includes('fiscal/issues')) body = { issues: [] };
    else if (target.includes('/api/status')) body = {
      settings: { installName: 'PacoSAT', hasLogo: false },
      buildModified: null, cloudRevision: null, profiles: [], jobs: [], inbox: [], mail: {},
      ...estadoServido240 };
    return { ok: true, status: 200, headers: { get: () => 'application/json' },
      json: async () => body, text: async () => JSON.stringify(body), blob: async () => new Blob([]) };
  };
  const timer = (fn, ms, ...args) => { const t = setTimeout(fn, ms, ...args); t.unref?.(); return t; };
  const every = (fn, ms, ...args) => { const t = setInterval(fn, ms, ...args); t.unref?.(); return t; };
  const context = vm.createContext({
    console, document: documentStub,
    navigator: { onLine: true, userAgent: 'ronda240descargas-test' },
    location: { href: 'http://127.0.0.1:43743/', search: '', reload: () => {} },
    localStorage: storageStub(), sessionStorage: storageStub(),
    fetch: fetchStub, setTimeout: timer, setInterval: every,
    clearTimeout, clearInterval, queueMicrotask,
    URL: BootURL, URLSearchParams, Blob, TextEncoder, TextDecoder, btoa, atob,
    crypto: webcrypto, DecompressionStream,
    matchMedia: () => ({ matches: false, addEventListener: () => {}, addListener: () => {} }),
    Option: class extends FakeElement {},
    alert: () => {}, addEventListener: () => {}, removeEventListener: () => {},
    requestAnimationFrame: fn => timer(fn, 0)
  });
  context.window = context;
  context.self = context;
  /* El head ejecuta los scripts inyectados (las partes
     diferidas), como el navegador al aterrizar una parte. */
  headEl.appendChild = kid => {
    if (kid && typeof kid.textContent === 'string' && kid.textContent)
      vm.runInContext(kid.textContent, context, { filename: 'parte-diferida' });
    return kid;
  };
  return context;
}
const textoDe = el => {
  let texto = el.textContent || '';
  for (const hijo of el.children || []) texto += ' ' + textoDe(hijo);
  return texto.replace(/\s+/g, ' ');
};
async function bootCliente() {
  const context = makeBootContext();
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  vm.runInContext(script, context, { filename: 'Faro-Fiscal.html#script' });
  for (let i = 0; i < 12; i++) await new Promise(resolve => setTimeout(resolve, 0));
  /* RE-BASE integración 2.4.0: el cargador real trae Vigilancia
     —y antes que ella, Descargas, por su dependencia de orden—:
     fillSat queda ENVUELTO (cuota + «baja lo mismo») y pollSat
     es el real, igual que en producción al abrir Descargas. */
  await vm.runInContext("ensureLazyPart('monitor')", context);
  for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 0));
  return context;
}
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 0)); };
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const fmtFH = ms => { const d = new Date(Number(ms));
  return d.getDate() + ' ' + MESES[d.getMonth()] + ', ' + String(d.getHours()).padStart(2, '0') + ':' +
    String(d.getMinutes()).padStart(2, '0'); };
const claveFecha = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' +
  String(d.getDate()).padStart(2, '0');

/* ===== (a) la tarjeta de cuota pinta el dato servido ===== */
{
  const RENUEVA = Date.parse('2026-11-24T15:30:00Z');
  const cuota = {
    definicion: 'DEFINICION SERVIDA DE JUGUETE: las solicitudes se cuentan del libro de criterios.',
    limiteSat: null, ventanaMs: 604800000, criterioPorCriterio: 2,
    porRfc: { [OWN]: { rfc: OWN, solicitudesEnVentana: 5, porTipo: { cfdi: 3, metadata: 2 },
      criteriosAlLimite: 1, criteriosAgotados5002: 0, semaforo: 'ambar',
      texto: 'TEXTO QUE COMPONE EL SERVIDOR DE JUGUETE', seRenuevaEn: RENUEVA } }
  };
  estadoServido240 = { cuotaDescargas240: cuota };
  const ctx = await bootCliente();
  ctx.Node = FakeElement;
  vm.runInContext(`scope = ""; people = [{ id: "${OWN}", name: "Mano Fil, S.A." }];`, ctx);
  await vm.runInContext('pollSat()', ctx);
  await flush();
  ctx.__destino = new FakeElement('div');
  vm.runInContext('fillSat(__destino)', ctx);
  await flush();
  const tarjetas = buscar(ctx.__destino, e => e.dataset?.cuota240 === '1');
  assert.equal(tarjetas.length, 1, '(a) Descargas pinta exactamente una tarjeta de cuota');
  assert.equal(ctx.__destino.children[0], tarjetas[0], '(a) la tarjeta de cuota abre la pantalla (protagonista)');
  const texto = textoDe(tarjetas[0]);
  assert.ok(texto.includes('5 solicitudes enviadas en los últimos 7 días'),
    '(a) pinta las solicitudes enviadas en la ventana de 7 días');
  assert.ok(texto.includes('CFDI completos: 3') && texto.includes('Solo el listado (metadatos): 2'),
    '(a) pinta el desglose por tipo servido');
  assert.ok(texto.includes('En ámbar'), '(a) el semáforo va con su palabra («En ámbar»)');
  assert.ok(buscar(tarjetas[0], e => String(e.tagName).toLowerCase() === 'svg').length >= 1,
    '(a) el semáforo va con su icono');
  const pill = buscar(tarjetas[0], e => String(e.className || '').split(' ').includes('status-pill'))[0];
  assert.equal(pill?.dataset.state, 'warn', '(a) el semáforo ámbar se pinta con el estado warn de la casa');
  assert.ok(texto.includes('TEXTO QUE COMPONE EL SERVIDOR DE JUGUETE'),
    '(a) el texto de la tarjeta es el que compone el servidor, sin reescribir');
  assert.ok(texto.includes('Se renueva el ' + fmtFH(RENUEVA)),
    '(a) la renovación se pinta con la fecha/hora servida, en llano');
  assert.ok(texto.includes('El SAT no publica una cuota'),
    '(a) con limiteSat null la tarjeta lo dice: el SAT no publica una cuota');
  assert.ok(!/tope de \d|cuota de \d/i.test(texto.replace('El SAT no publica una cuota', '')),
    '(a) no se inventa ningún tope numérico');
  assert.ok(texto.includes('Qué significa esta cuota') &&
    texto.includes('DEFINICION SERVIDA DE JUGUETE'),
    '(a) la definición servida vive en su «Qué significa» desplegable');
  console.log('OK 2.4.0·WC4b2 (a) — tarjeta de cuota: dato servido, semáforo con icono y palabra, renovación en llano y sin tope inventado.');
}
/* (a2) Sin dato servido nunca, no hay tarjeta (nada fingido):
   arranque limpio, sin la copia buena de otro bloque. */
{
  estadoServido240 = {};
  const ctx = await bootCliente();
  ctx.Node = FakeElement;
  vm.runInContext(`scope = ""; people = [{ id: "${OWN}", name: "Mano Fil, S.A." }];`, ctx);
  await vm.runInContext('pollSat()', ctx);
  await flush();
  ctx.__destino2 = new FakeElement('div');
  vm.runInContext('fillSat(__destino2)', ctx);
  assert.equal(buscar(ctx.__destino2, e => e.dataset?.cuota240 === '1').length, 0,
    '(a2) sin cuotaDescargas240 en el estado no se pinta ninguna tarjeta');
  console.log('OK 2.4.0·WC4b2 (a2) — sin dato de cuota servido, Descargas no finge ninguna tarjeta.');
}

/* ===== (b) «baja lo mismo del mes pasado»: compone y NO envía ===== */
{
  const ahora = new Date();
  const primeroPasado = new Date(ahora.getFullYear(), ahora.getMonth() - 1, 1);
  const ultimoPasado = new Date(ahora.getFullYear(), ahora.getMonth(), 0);
  const envioManual = new Date(ahora.getFullYear(), ahora.getMonth() - 1, 10, 12, 0, 0).getTime();
  const libro = [
    { rfc: OWN, direction: 'issued', type: 'cfdi', startAt: '2020-01-01 00:00:00', endAt: '2020-01-31 23:59:59',
      sends: [{ requestId: 'r-manual', origin: 'manual', sentAt: envioManual }] },
    { rfc: OWN, direction: 'received', type: 'metadata', startAt: '2020-01-01 00:00:00', endAt: '2020-01-31 23:59:59',
      sends: [{ requestId: 'r-auto', origin: 'monthly', sentAt: envioManual }] },
    { rfc: OWN, direction: 'received', type: 'cfdi', startAt: '2020-01-01 00:00:00', endAt: '2020-01-31 23:59:59',
      sends: [{ requestId: 'r-hoy', origin: 'manual', sentAt: Date.now() }] }
  ];
  estadoServido240 = { profiles: [{ rfc: OWN, minutes: 240, days: 7, direction: 'received', nextRun: 0,
      unlocked: false, error: '', paused: false }],
    criteriaBook: libro };
  const ctx = await bootCliente();
  ctx.Node = FakeElement;
  ctx.__llamadas240 = [];
  ctx.__compuestas240 = [];
  vm.runInContext(`scope = "${OWN}"; people = [{ id: "${OWN}", name: "Mano Fil, S.A." }];`, ctx);
  await vm.runInContext('pollSat()', ctx);
  await flush();
  vm.runInContext(`satApi = async (path, data) => { __llamadas240.push([String(path), data || null]); return {}; };
    downloadSheet = (rfc, preset) => { __compuestas240.push(['hoja', rfc, preset]); };
    requestDialog = preset => { __compuestas240.push(['dialogo', preset]); };`, ctx);
  const plan = vm.runInContext('bajaLoMismoPlan240()', ctx);
  assert.equal(plan.length, 1, '(b) el plan trae el RFC visible');
  assert.equal(plan[0].conRegistro, true, '(b) hubo descarga manual el mes pasado y el plan lo sabe');
  assert.equal(plan[0].direction, 'issued',
    '(b) el sentido sale de la descarga MANUAL del mes pasado (el «monthly» de recibidos no cuenta, ni el manual de hoy)');
  assert.equal(plan[0].tipo, 'cfdi', '(b) el tipo sale de esa misma descarga manual');
  assert.equal(plan[0].desde, claveFecha(primeroPasado), '(b) compone el mes anterior al actual, desde su día 1');
  assert.equal(plan[0].hasta, claveFecha(ultimoPasado), '(b) y hasta su último día');
  ctx.__destino = new FakeElement('div');
  vm.runInContext('fillSat(__destino)', ctx);
  await flush();
  const boton = buscar(ctx.__destino, e => e.dataset?.bajaLoMismo240 === OWN)[0];
  assert.ok(boton, '(b) Descargas enseña el botón de componer para el RFC visible');
  assert.equal(ctx.__llamadas240.filter(([path]) => path === 'request').length, 0,
    '(b) antes del gesto no se ha enviado ninguna petición');
  await boton.onclick();
  await flush();
  assert.equal(ctx.__compuestas240.length, 1, '(b) un toque compone exactamente una descarga');
  assert.equal(ctx.__compuestas240[0][0], 'hoja', '(b) se compone la hoja de descarga de siempre');
  assert.equal(ctx.__compuestas240[0][1], OWN, '(b) para el RFC visible');
  assert.deepEqual({ ...ctx.__compuestas240[0][2] },
    { start: claveFecha(primeroPasado), end: claveFecha(ultimoPasado), direction: 'issued' },
    '(b) la hoja queda compuesta con el mes anterior y los parámetros del mes pasado');
  assert.equal(ctx.__llamadas240.filter(([path]) => path === 'request').length, 0,
    '(b) componer NO quema ningún criterio: el envío sigue siendo la confirmación de la hoja');
  /* Sin descarga manual el mes pasado: lo habitual, y se dice. */
  vm.runInContext('satData.criteriaBook = [];', ctx);
  const planVacio = vm.runInContext('bajaLoMismoPlan240()', ctx);
  assert.equal(planVacio[0].conRegistro, false, '(b) sin manual el mes pasado, el plan lo declara');
  assert.equal(planVacio[0].direction, 'both', '(b) y compone con lo habitual de la vista (los dos sentidos)');
  assert.equal(planVacio[0].tipo, 'cfdi', '(b) y CFDI completos, lo habitual');
  ctx.__destino3 = new FakeElement('div');
  vm.runInContext('fillSat(__destino3)', ctx);
  assert.ok(textoDe(ctx.__destino3).includes('sin descarga manual el mes pasado: compuesto con lo habitual'),
    '(b) la fila lo dice en llano cuando no hubo descarga manual el mes pasado');
  console.log('OK 2.4.0·WC4b2 (b) — «baja lo mismo» compone el mes anterior con los parámetros manuales del mes pasado y no envía nada sin la confirmación.');
}

/* ===== (c) el calendario fiscal pinta el vencimiento en su día ===== */
{
  estadoServido240 = {};
  const hoy = new Date();
  const fechaEvento = claveFecha(new Date(hoy.getFullYear(), hoy.getMonth(), 15));
  const daysLeft = Math.round((Date.parse(fechaEvento + 'T12:00:00') - Date.now()) / 86400000);
  eventosJuguete = [{ rfc: OWN, kind: 'mensual', title: 'Pago provisional y DIOT (día 17)',
    date: fechaEvento, daysLeft }];
  const ctx = await bootCliente();
  ctx.Node = FakeElement;
  vm.runInContext(`scope = "${OWN}"; people = [{ id: "${OWN}", name: "Mano Fil, S.A." }]; invoices = []; documents = [];`, ctx);
  const parts = vm.runInContext('cumplimientoScreen()', ctx);
  await flush();
  const raiz = parts[0];
  const rejillas = buscar(raiz, e => e.dataset?.cal240 === '1');
  assert.equal(rejillas.length, 1, '(c) Cumplimiento pinta su calendario del mes');
  const celda = buscar(rejillas[0], e => e.dataset?.fecha === fechaEvento)[0];
  assert.ok(celda, '(c) el calendario tiene la celda del día exacto del vencimiento servido (' + fechaEvento + ')');
  assert.ok(textoDe(celda).includes('Pago provisional y DIOT (día 17)'),
    '(c) el vencimiento va marcado EN su día, con su nombre');
  const textoTotal = textoDe(raiz);
  const apariciones = textoTotal.split('Pago provisional y DIOT (día 17)').length - 1;
  assert.ok(apariciones >= 2, '(c) la lista de siempre sigue debajo del calendario (el vencimiento sale en los dos sitios)');
  celda.onclick();
  await flush();
  const trasTocar = textoDe(raiz).split('Pago provisional y DIOT (día 17)').length - 1;
  assert.ok(trasTocar > apariciones, '(c) tocar el día enseña sus vencimientos en el detalle');
  const celdaVacia = buscar(rejillas[0], e => e.dataset?.fecha &&
    e.dataset.fecha !== fechaEvento && !textoDe(e).includes('Pago provisional'))[0];
  celdaVacia.onclick();
  assert.ok(textoDe(raiz).includes('no vence nada'), '(c) un día sin vencimientos lo dice al tocarlo');
  console.log('OK 2.4.0·WC4b2 (c) — calendario fiscal: el vencimiento servido cae en su día exacto, la lista sigue debajo y el día se abre al tocarlo.');
}
eventosJuguete = [];

/* ===== (d) archivar en lote y deshacer el lote entero ===== */
{
  estadoServido240 = {};
  const ctx = await bootCliente();
  ctx.Node = FakeElement;
  const fila = (id, folio) => ({ id, kind: 'I', date: '2026-11-05', total: '100.00', currency: 'MXN',
    from: { rfc: OWN, name: 'Mano Fil, S.A.' }, to: { rfc: 'BBB010101BBB', name: 'Cliente ' + folio },
    fiscal: { serie: 'A', folio, paymentMethod: 'PUE', paymentForm: '99', transferred: [], withheld: [] }, concepts: [] });
  const filas = [fila('UUID-LOTE-1', '201'), fila('UUID-LOTE-2', '202'), fila('UUID-LOTE-3', '203')];
  ctx.__llamadas240 = [];
  vm.runInContext(`scope = "${OWN}"; people = [{ id: "${OWN}", name: "Mano Fil, S.A." }];
    documents = []; activity = []; invoices = ${JSON.stringify(filas)};
    page = "invoices";
    for (const r of invoices) invoiceSelection.add(r.id);`, ctx);
  /* La envoltura de render quedó puesta al cargar el artefacto
     (se comprueba ANTES de sustituir render por el doble). */
  assert.equal(vm.runInContext('render.name', ctx), 'render240',
    '(d) el pintado pasa por la envoltura que inyecta la barra del lote');
  vm.runInContext(`satApi = async (path, data) => { __llamadas240.push([String(path), data || null]);
      if (path === "cfdi/archivados") return { ids: [] }; return {}; };
    render = () => {};`, ctx);
  /* La barra nace con la selección viva. */
  vm.runInContext('loteBarra240()', ctx);
  const body = vm.runInContext('document.getElementById("body")', ctx);
  const barras = buscar(body, e => e.dataset?.lote240 === '1');
  assert.equal(barras.length, 1, '(d) Facturas enseña la barra del lote cuando hay selección');
  const boton = buscar(barras[0], e => e.dataset?.lote240Btn === '1')[0];
  assert.ok(boton && textoDe(barras[0]).includes('Archivar varios'),
    '(d) la barra trae su «Archivar varios» y el conteo de seleccionados');
  await boton.onclick();
  await flush();
  const archivados = ctx.__llamadas240.filter(([p, d]) => p === 'cfdi/archivar' && d.archivar === true);
  assert.deepEqual(archivados.map(([, d]) => d.uuid).sort(),
    ['UUID-LOTE-1', 'UUID-LOTE-2', 'UUID-LOTE-3'],
    '(d) «Archivar varios» archiva los 3 por la ruta de siempre, uno a uno');
  const asientos = vm.runInContext('activity.filter(a => String(a.event || "").includes("Archivados en lote"))', ctx);
  assert.equal(asientos.length, 1, '(d) el lote queda asentado en el Registro como UN solo hecho');
  assert.ok(asientos[0].event.includes('3 comprobante(s)'), '(d) y el asiento lleva su conteo');
  assert.equal(vm.runInContext('invoiceSelection.size', ctx), 0,
    '(d) la selección se limpia de lo ya archivado');
  /* El Deshacer del aviso restaura EL LOTE ENTERO con un gesto. */
  const toasts = vm.runInContext('document.getElementById("toasts")', ctx);
  const deshacer = buscar(toasts, e => e.tagName === 'BUTTON' && (e.textContent || '').trim() === 'Deshacer')[0];
  assert.ok(deshacer, '(d) el aviso del lote trae su «Deshacer»');
  await deshacer.onclick();
  await flush();
  const restaurados = ctx.__llamadas240.filter(([p, d]) => p === 'cfdi/archivar' && d.archivar === false);
  assert.deepEqual(restaurados.map(([, d]) => d.uuid).sort(),
    ['UUID-LOTE-1', 'UUID-LOTE-2', 'UUID-LOTE-3'],
    '(d) un solo gesto de Deshacer restaura los 3 del lote');
  const asientosDes = vm.runInContext('activity.filter(a => String(a.event || "").includes("Deshecho el lote"))', ctx);
  assert.equal(asientosDes.length, 1, '(d) el deshacer del lote también queda asentado como un hecho');
  console.log('OK 2.4.0·WC4b2 (d) — lote de 3 archivado por la ruta de siempre, un asiento con su conteo y un solo Deshacer que lo restaura entero.');
}

/* ===== (d2) lote con un fallo a mitad: se dice y el Deshacer cubre lo archivado ===== */
{
  estadoServido240 = {};
  const ctx = await bootCliente();
  ctx.Node = FakeElement;
  const filas = [{ id: 'UUID-PARC-1' }, { id: 'UUID-PARC-2' }, { id: 'UUID-PARC-3' }];
  ctx.__llamadas240 = [];
  vm.runInContext(`scope = "${OWN}"; people = [{ id: "${OWN}", name: "Mano Fil, S.A." }];
    documents = []; activity = []; invoices = [];`, ctx);
  vm.runInContext(`satApi = async (path, data) => { __llamadas240.push([String(path), data || null]);
      if (path === "cfdi/archivar" && data.archivar === true && data.uuid === "UUID-PARC-2")
        throw new Error("fallo de juguete al archivar");
      if (path === "cfdi/archivados") return { ids: [] }; return {}; };
    render = () => {};`, ctx);
  ctx.__filas240 = filas;
  const resultado = await vm.runInContext('cfdiArchivarLote240(__filas240)', ctx);
  await flush();
  assert.deepEqual([...resultado.archivados], ['UUID-PARC-1', 'UUID-PARC-3'],
    '(d2) el lote cuenta como archivados solo los que entraron');
  assert.deepEqual([...resultado.fallidos], ['UUID-PARC-2'], '(d2) y nombra el que falló a mitad');
  const asiento = vm.runInContext('activity.find(a => String(a.event || "").includes("Archivados en lote"))', ctx);
  assert.ok(asiento && asiento.event.includes('2 comprobante(s)') && asiento.event.includes('sin archivar 1'),
    '(d2) el asiento del lote dice qué se archivó y qué no');
  const toasts = vm.runInContext('document.getElementById("toasts")', ctx);
  const deshacer = buscar(toasts, e => e.tagName === 'BUTTON' && (e.textContent || '').trim() === 'Deshacer')[0];
  assert.ok(deshacer, '(d2) el lote parcial también trae su Deshacer');
  await deshacer.onclick();
  await flush();
  const restaurados = ctx.__llamadas240.filter(([p, d]) => p === 'cfdi/archivar' && d.archivar === false);
  assert.deepEqual(restaurados.map(([, d]) => d.uuid).sort(), ['UUID-PARC-1', 'UUID-PARC-3'],
    '(d2) el Deshacer cubre exactamente lo que sí se archivó');
  console.log('OK 2.4.0·WC4b2 (d2) — lote parcial: se dice qué entró y qué no, y el Deshacer cubre solo lo archivado.');
}
console.log('OK ronda240descargas — castigo 2, piezas 27, 26 y 25 verdes.');
