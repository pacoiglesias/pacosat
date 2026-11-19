/* ================================================================
   Ronda 2.3.2 · frente CLIENTE B3 — Hoy manda, Totales vuelve,
   ningún primario muerto.
   M-6  totalsPanel() + monthlyChart() MONTADOS en Cierre ›
        Reportes y el Comparativo ejercitable de verdad.
   M-8  Hoy: «Lo que te necesita» por encima de las 4 tarjetas.
   M-9  Hoy sin duplicados: última descarga ×1, puerta fuera de
        la línea de estado, ejecutor ×1 (su línea).
   M-11 Primarios que despachan su verbo: ejecutor (prueba de
        puerta encolada), API (re-lee llaves), Calendario
        (aplica el mes), Preguntas (envía la pregunta).
   m-9  Dinero: píldoras a Dinero filtrado; la tercera, texto.
   m-10 Vigilancia: KPI-enlace a la tabla filtrada; hub fuera.
   m-11 statusPill como <span> dentro de otro botón.
   m-14/m-7 Hitos con título llano y una sola afirmación del
        estado; m-15/m-16 «Ver historia» y «Ver CFDI» fuera.
   o-7  home() sin la construcción que no montaba.
   Arnés DOM: el de la casa (ronda200a), artefacto real.
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
const uiSrc = read('ui.part');
const wfSrc = read('workflows.part');
const moneySrc = read('money-ui.part');
const monitorSrc = read('monitor-ui.part');
/* RE-BASE integración 2.4.0 (W6/W6b): dineroScreen vive en la
   parte diferida de Dinero y monitorScreen en la de
   Vigilancia. Los bloques que las llaman inyectan en el
   contexto la fuente de la parte DESDE lazy.json (lo que el
   navegador recibe), en el orden del cargador (descargas
   antes que monitor). Ninguna aserción cambia. */
const lazy = JSON.parse(read('lazy.json'));
const OWN = 'MFI6212158B4';
const FISCAL = { paymentMethod: 'PPD', serie: '', folio: '10', payments: null, transferred: [], withheld: [] };
const semilla = ctx => { ctx.Node = FakeElement; vm.runInContext(`ready = true; scope = "${OWN}";
  people = [{ id: "${OWN}", name: "Mano Fil, S.A." }];
  invoices = [
    { id: "AAAAAAAA-1111-4111-8111-111111111111", date: "2026-10-05", kind: "I", total: "1160.00", currency: "MXN",
      from: { rfc: "${OWN}", name: "Mano Fil, S.A." }, to: { rfc: "XAXX010101000", name: "Cliente Uno" },
      fiscal: { paymentMethod: "PPD", serie: "", folio: "10", payments: null, transferred: [], withheld: [] } },
    { id: "BBBBBBBB-2222-4222-8222-222222222222", date: "2026-11-03", kind: "I", total: "2320.00", currency: "MXN",
      from: { rfc: "XAXX010101000", name: "Proveedor Uno" }, to: { rfc: "${OWN}", name: "Mano Fil, S.A." },
      fiscal: { paymentMethod: "PPD", serie: "", folio: "20", payments: null, transferred: [], withheld: [] } }];
  satData = { profiles: [{ rfc: "${OWN}", lastSatSuccess: Date.parse("2026-11-10T15:00:00Z") }],
    puerta: { "${OWN}": { ok: true, probada: Date.parse("2026-11-10T15:00:00Z") } },
    ejecutor: { emparejado: true, enLinea: true, ultimoVisto: Date.parse("2026-11-16T15:00:00Z"),
      residencia: { registrada: true, instancias: 1 } },
    pendingProfiles: [], jobs: [], inbox: [], mail: {} };`, ctx); };
const buscar = (el, pred, out = []) => { if (el && pred(el)) out.push(el); for (const h of el?.children || []) buscar(h, pred, out); return out; };
const buscarEn = (raices, pred) => raices.flatMap(r => buscar(r, pred));
const contar = (texto, frase) => (texto.match(new RegExp(frase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;

/* ===== Arnés DOM (el de ronda1291) ===== */
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
    createTextNode: text => ({ textContent: String(text) }),
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
    navigator: { onLine: true, userAgent: 'ronda200a-test' },
    location: { href: 'http://127.0.0.1:43729/', search: '', reload: () => {} },
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
  return context;
}
const textoDe = el => {
  let texto = el.textContent || '';
  for (const hijo of el.children || []) texto += ' ' + textoDe(hijo);
  return texto;
};
const buscarPorClase = (el, clase, salida = []) => {
  if (String(el.className || '').split(' ').includes(clase)) salida.push(el);
  for (const hijo of el.children || []) buscarPorClase(hijo, clase, salida);
  return salida;
};
async function bootCliente() {
  const context = makeBootContext();
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  vm.runInContext(script, context, { filename: 'Faro-Fiscal.html#script' });
  for (let i = 0; i < 12; i++) await new Promise(resolve => setTimeout(resolve, 0));
  return context;
}
const ponerSatData = (context, data) => {
  context.__sd = data;
  vm.runInContext('satData = __sd; scope = "MFI6212158B4"; people = [{ id: "MFI6212158B4", name: "Mano Fil, S.A." }];', context);
};


/* El FakeElement de la casa devuelve null en querySelector;
   totalsPanel() y compañía buscan su .panel-head de verdad:
   se le da la búsqueda por clase sobre el árbol falso. */
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

/* ===== M-8 + M-9 · Hoy: gestos arriba y cero duplicados ===== */
{
  const ctx = await bootCliente();
  semilla(ctx);
  const blocks = vm.runInContext('home()', ctx);
  const texto = blocks.map(textoDe).join('\n');
  const iGestos = texto.indexOf('Lo que te necesita');
  const iTarjetas = texto.indexOf('Descargar facturas');
  assert.ok(iGestos >= 0, 'Hoy pinta «Lo que te necesita»');
  assert.ok(iTarjetas > iGestos, 'M-8: los gestos van POR ENCIMA de las 4 tarjetas de acción');
  assert.equal(contar(texto, 'Última descarga'), 1, 'M-9: «Última descarga» una sola vez (la línea de estado)');
  assert.equal(contar(texto, 'Puerta del SAT'), 1, 'M-9: la puerta queda UNA vez en Hoy (su línea de estado); la de «Tus empresas» sale al pintar');
  assert.ok(uiSrc.includes("fotoSemaforos230(f).filter(s => s.nombre !== 'Puerta')"),
    'M-9: «Tus empresas» pinta solo sus semáforos por-RFC distintos (buzón, declaraciones, listas)');
  assert.equal(contar(texto, 'está despierto'), 0, 'M-9: las tarjetas ya no repiten el estado del ejecutor');
  assert.equal(contar(texto, 'Abrir ejecutor'), 0, 'M-9: las tarjetas ya no repiten el botón del ejecutor');
  assert.equal(contar(texto, 'Tu ejecutor'), 1, 'M-9: una sola mención del ejecutor en Hoy (su línea de estado)');
  assert.ok(texto.includes('Consultar el buzón') && texto.includes('Recuperar declaraciones'),
    'M-9: las tarjetas conservan su acción propia');
  console.log('OK 2.3.2·B3 M-8/M-9 — Hoy: gestos sobre las tarjetas; descarga ×1, puerta ×0 en el mando, ejecutor ×1.');
}

/* ===== o-7 · home() ya no construye lo que no monta ===== */
{
  const homeSrc = uiSrc.slice(uiSrc.indexOf('function home()'), uiSrc.indexOf('const invoiceStateOf'));
  assert.ok(!homeSrc.includes('dashboard-hero'), 'o-7: fuera la construcción del héroe no montado');
  assert.ok(!homeSrc.includes("panel('Últimos comprobantes')"), 'o-7: fuera «Últimos comprobantes» no montado');
  assert.ok(!homeSrc.includes("panel('Actividad')"), 'o-7: fuera «Actividad» no montada');
  assert.ok(!homeSrc.includes('void secondary'), 'o-7: fuera los void de los bloques muertos');
  assert.ok(homeSrc.includes('hoyMando201(gestosPanel1311())'), 'o-7/M-8: el mando recibe los gestos');
  console.log('OK 2.3.2·B3 o-7 — home() sin construcción muerta; la pantalla pintada no cambia.');
}

/* ===== M-6 · Totales montado en Reportes, comparativo ejercitable =====
   RE-BASE 2.8.0 (diseño 5): la pestaña «Reportes» de Cierre
   desaparece; totales y gráfico se pintan en la pantalla
   Reportes (reportesScreen201), su única superficie. */
{
  const ctx = await bootCliente();
  semilla(ctx);
  vm.runInContext(read('outputs-ui.part'), ctx);
  vm.runInContext('lazyLoadedParts.add("salidas"); page = "reportes";', ctx);
  const parts = vm.runInContext('reportesScreen201()', ctx);
  const texto = parts.map(textoDe).join('\n');
  assert.ok(texto.includes('Totales por RFC y mes'), 'M-6: totalsPanel() se PINTA en Reportes');
  assert.ok(texto.includes('octubre 2026') && texto.includes('noviembre 2026'), 'M-6: la rejilla/detalle por mes se pinta con los meses sembrados');
  assert.ok(texto.includes('Comparar dos meses'), 'M-6: el Comparativo mes contra mes (nº 11) está en pantalla');
  assert.ok(texto.includes('Totales por mes'), 'M-6: monthlyChart() se pinta en la misma sección');
  const boton = buscarEn(parts, e => e.tagName === 'BUTTON' && (e.textContent || '').trim() === 'Comparar')[0];
  assert.ok(boton, 'M-6: el botón «Comparar» existe en pantalla');
  const meses = buscarEn(parts, e => e.tagName === 'INPUT' && e.type === 'month');
  assert.ok(meses.length >= 2, 'M-6: los dos selectores de mes del comparativo están en pantalla');
  ctx.__llamadas = [];
  ctx.__stubSat = async url => { ctx.__llamadas.push(String(url));
    return { texto: 'Noviembre sube frente a octubre.', a: { comprobantes: 1, importe: '1,160.00' }, b: { comprobantes: 1, importe: '2,320.00' } }; };
  vm.runInContext('satApi = __stubSat;', ctx);
  meses[meses.length - 2].value = '2026-10';
  meses[meses.length - 1].value = '2026-11';
  await boton.onclick();
  for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0));
  assert.ok(ctx.__llamadas.some(u => u.startsWith('totales200h?rfc=' + OWN) && u.includes('&a=2026-10') && u.includes('&b=2026-11')),
    'M-6: comparar despacha totales200h con los dos meses elegidos: ' + ctx.__llamadas.join(' | '));
  const texto2 = parts.map(textoDe).join('\n');
  assert.ok(texto2.includes('Noviembre sube frente a octubre.'), 'M-6: la comparación se pinta en pantalla');
  console.log('OK 2.3.2·B3 M-6 — Totales y gráfico montados en Cierre › Reportes; comparativo ejercido de verdad.');
}

/* ===== M-11 · los primarios despachan su verbo ===== */
{
  /* Ejecutor emparejado → encola la prueba de puerta. */
  const ctx = await bootCliente();
  semilla(ctx);
  ctx.__llamadas = [];
  ctx.__stubSat = async url => { ctx.__llamadas.push(String(url)); return { encolado: true, repetido: false }; };
  vm.runInContext('satApi = __stubSat; pollSat = async () => {}; render = () => {}; page = "ejecutor";', ctx);
  await ctx.document.getElementById('primary').onclick();
  for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0));
  assert.ok(ctx.__llamadas.some(u => u === 'salud/puerta'), 'M-11 ejecutor: el primario encola salud/puerta: ' + ctx.__llamadas.join(' | '));
  console.log('OK 2.3.2·B3 M-11 ejecutor — el primario PRUEBA el ejecutor (salud/puerta), no repinta.');
}
{
  /* Ajustes › API → re-lee las llaves desde el servidor. */
  const ctx = await bootCliente();
  semilla(ctx);
  ctx.__llamadas = [];
  ctx.__stubSat = async url => { ctx.__llamadas.push(String(url)); return { llaves: [{ id: 1 }, { id: 2 }] }; };
  vm.runInContext('satApi = __stubSat; pollSat = async () => {}; render = () => {}; page = "settings"; ajustesSection = "api";', ctx);
  await ctx.document.getElementById('primary').onclick();
  for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0));
  assert.ok(ctx.__llamadas.some(u => u === 'apikeys'), 'M-11 API: el primario re-lee apikeys del servidor');
  console.log('OK 2.3.2·B3 M-11 API — el primario refresca el panel desde el servidor (apikeys).');
}
{
  /* Cierre › Calendario → aplica el mes elegido y lo enseña. */
  const ctx = await bootCliente();
  semilla(ctx);
  vm.runInContext(read('outputs-ui.part'), ctx);
  const mesEl = new FakeElement('input'); mesEl.type = 'month'; mesEl.value = '2026-10';
  ctx.document.querySelector = sel => (String(sel).includes('month') ? mesEl : null);
  vm.runInContext('lazyLoadedParts.add("salidas"); render = () => {}; page = "salidas"; cierreSection = "calendario";', ctx);
  await ctx.document.getElementById('primary').onclick();
  for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0));
  assert.equal(vm.runInContext('OUT.month', ctx), '2026-10', 'M-11 calendario: el mes elegido queda aplicado (OUT.month)');
  assert.equal(vm.runInContext('cierreSection', ctx), 'reportes', 'M-11 calendario: la vista enseña el cierre de ese mes (Reportes)');
  console.log('OK 2.3.2·B3 M-11 calendario — el primario aplica el mes elegido y lo enseña.');
}
{
  /* Preguntas → envía la pregunta (pulsa el «Preguntar» real). */
  const ctx = await bootCliente();
  semilla(ctx);
  let enviado = 0;
  const btn = new FakeElement('button'); btn.textContent = 'Preguntar';
  btn.click = () => { enviado++; };
  ctx.document.querySelectorAll = sel => (sel === 'main button' ? [btn] : []);
  vm.runInContext('page = "preguntas";', ctx);
  await ctx.document.getElementById('primary').onclick();
  for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0));
  assert.equal(enviado, 1, 'M-11 preguntas: el primario pulsa el botón real «Preguntar» de su pantalla');
  assert.ok(!wfSrc.includes("page === 'preguntas') { render();"), 'M-11 preguntas: fuera el primario de solo repintar+enfocar');
  console.log('OK 2.3.2·B3 M-11 preguntas — el primario ENVÍA la pregunta escrita.');
}

/* ===== m-9 · Dinero: píldoras con destino, tercera como texto ===== */
{
  const ctx = await bootCliente();
  semilla(ctx);
  vm.runInContext('page = "dinero"; render = () => {}; satApi = async () => ({ balances: [], canceladas: null });', ctx);
  vm.runInContext(lazy.partes.dinero.source, ctx, { filename: 'parte-dinero' });
  const din = vm.runInContext('dineroScreen()', ctx);
  const pills = buscarEn(din, e => String(e.className || '').includes('status-pill'));
  const pillCobrar = pills.find(p => textoDe(p).includes('Por cobrar'));
  const pillPagar = pills.find(p => textoDe(p).includes('Por pagar'));
  const pillConteo = pills.find(p => textoDe(p).includes('facturas con saldo abierto'));
  assert.ok(pillCobrar && pillCobrar.tagName === 'BUTTON' && typeof pillCobrar.onclick === 'function', 'm-9: «Por cobrar» es botón con destino');
  assert.ok(pillPagar && pillPagar.tagName === 'BUTTON' && typeof pillPagar.onclick === 'function', 'm-9: «Por pagar» es botón con destino');
  assert.ok(pillConteo && pillConteo.tagName === 'SPAN', 'm-9: el conteo de facturas abiertas se pinta como TEXTO (span), no como botón');
  pillCobrar.onclick();
  assert.equal(vm.runInContext('dineroFiltro232', ctx), 'cobrar', 'm-9: la píldora deja Dinero filtrado a «cobrar»');
  const din2 = vm.runInContext('dineroScreen()', ctx);
  const h2s = buscarEn(din2, e => e.tagName === 'H2').map(h => h.textContent);
  assert.ok(h2s.includes('Por cobrar') && !h2s.includes('Por pagar'), 'm-9: Dinero filtrado enseña solo su panel: ' + h2s.join(' | '));
  console.log('OK 2.3.2·B3 m-9 — Dinero: píldoras que navegan filtrado y conteo como texto.');
}

/* ===== m-10 · Vigilancia: KPI-enlace y pantalla que abre con su resumen ===== */
{
  const ctx = await bootCliente();
  semilla(ctx);
  /* La parte de Vigilancia se inyecta ANTES de sembrar
     monitorSummary: la parte lo declara con let. El orden del
     cargador se respeta (Descargas antes que Vigilancia). */
  vm.runInContext(lazy.partes.descargas.source, ctx, { filename: 'parte-descargas' });
  vm.runInContext(lazy.partes.monitor.source, ctx, { filename: 'parte-monitor' });
  vm.runInContext(`monitorSummary = { counts: { total: 2, vigentes: 1, cancelados: 1, enListado69B: 0,
      sinRevisar: 0, noEncontrados: 0, conProblema: 0, revisados: 2, ultimaRevision: Date.parse("2026-11-16T10:00:00Z") },
    lists: { fetched: Date.parse("2026-11-15T10:00:00Z"), count: 100 }, masAfectados: [] };
    fiscalResults.set(invoices[1].id, { sat: { state: "Cancelado" } });
    page = "monitor"; render = () => {};`, ctx);
  const mon = vm.runInContext('monitorScreen()', ctx);
  const texto = mon.map(textoDe).join('\n');
  assert.ok(!texto.includes('Qué quieres hacer'), 'm-10: el hub duplicado se retira de Vigilancia');
  assert.ok(textoDe(mon[0]).includes('Resumen de tus comprobantes'), 'm-10: la pantalla ABRE con el resumen propio de la vigilancia');
  const kpis = buscarEn(mon, e => String(e.className || '').split(' ').includes('kpi'));
  assert.ok(kpis.length >= 6 && kpis.every(k => k.tagName === 'BUTTON'), 'm-10: todos los KPI son enlace (botón)');
  const kpiCanc = kpis.find(k => textoDe(k).includes('Cancelados'));
  kpiCanc.onclick();
  assert.equal(vm.runInContext('monitorFilter', ctx), 'cancelled', 'm-10: el KPI Cancelados deja la tabla filtrada por cancelados');
  const mon2 = vm.runInContext('monitorScreen()', ctx);
  const texto2 = mon2.map(textoDe).join('\n');
  assert.ok(texto2.includes('Proveedor Uno'), 'm-10: la tabla filtrada enseña el CFDI cancelado');
  assert.ok(!texto2.includes('Cliente Uno'), 'm-10: y solo ese estado');
  console.log('OK 2.3.2·B3 m-10 — Vigilancia: KPI con destino a la tabla filtrada; sin hub duplicado.');
}

/* ===== m-11 · statusPill como span dentro de otro botón ===== */
{
  const ctx = await bootCliente();
  const pill = vm.runInContext('statusPill("ok", "Puerta: abre", "", null, true)', ctx);
  assert.equal(pill.tagName, 'SPAN', 'm-11: con asSpan, la píldora es <span> (válida dentro de un <button>)');
  const normal = vm.runInContext('statusPill("ok", "Ir", "", () => {})', ctx);
  assert.equal(normal.tagName, 'BUTTON', 'm-11: sin asSpan, la píldora con destino sigue siendo botón');
  assert.ok(uiSrc.includes("statusPill(s.estado, s.nombre + ': ' + s.texto, '', null, true)"),
    'm-11: las filas de «Tus empresas» pintan sus píldoras como span');
  console.log('OK 2.3.2·B3 m-11 — statusPill: span dentro de botón, botón con destino fuera.');
}

/* ===== M-7/m-14/m-15/m-16 · diálogo del CFDI ===== */
{
  const ctx = vm.createContext({ console, Date, Math, JSON, Number, String, Boolean, Array, Object, Set, Map });
  const src = wfSrc.slice(wfSrc.indexOf('const HITO_TITULOS232'), wfSrc.indexOf('function invoiceActions'));
  assert.ok(src.length > 100, 'slice de hitos vacío');
  vm.runInContext(src, ctx);
  assert.equal(ctx.hitoTitulo232('estado-sat'), 'Estado consultado en el SAT');
  assert.equal(ctx.hitoTitulo232('emision'), 'Emisión');
  assert.equal(ctx.hitoTitulo232('cancelada'), 'Cancelada');
  assert.ok(!ctx.hitoTitulo232('emision').includes('emision') || ctx.hitoTitulo232('emision') === 'Emisión', 'm-14: sin clave interna en el título');
  const visibles = ctx.vidaHitosVisibles232([{ tipo: 'emision' }, { tipo: 'estado-sat' }, { tipo: 'pago' }]);
  assert.deepEqual(visibles.map(h => h.tipo), ['emision', 'pago'],
    'M-7: el hito estado-sat sale de la línea de vida (el hecho lo cuenta UNA vez la historia)');
  assert.ok(!html.includes('Ver historia'), 'm-15: «Ver historia» fuera del artefacto');
  assert.ok(!html.includes('Ver CFDI'), 'm-16: «Ver CFDI» fuera del artefacto (folio e importe son los enlaces)');
  assert.ok(uiSrc.includes("folioBtn.title = 'Abrir el detalle de este comprobante'") &&
    uiSrc.includes("totalBtn.title = 'Abrir el detalle de este comprobante'"),
    'm-16: folio e importe quedan como enlaces al detalle en la fila');
  console.log('OK 2.3.2·B3 M-7/m-14/m-15/m-16 — diálogo: una sola afirmación, títulos llanos, sin botones que solo desplazan.');
}

console.log('SUITE 2.3.2 CLIENTE B3: TODO OK');
