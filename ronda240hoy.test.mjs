/* ================================================================
   Ronda 2.4.0 · WC4b1 — Hoy y uso diario (castigos 6, 18, 30 y 22).
   Sobre el ARTEFACTO construido y con el arnés DOM de la casa:
   (6) la tarjeta «Qué falta para cerrar el mes» veredicta por
       RFC con los conteos servidos (descargas del último mes
       cubierto, PPD sin REP del predicado de Facturas) y dice
       «todo listo» cuando no falta nada; Bancos no viaja a Hoy
       y su fila lo dice («se ve en Bancos») sin entrar en el
       veredicto; las listas entran con su fecha al llegar la
       lectura que Hoy ya hace.
   (18) «Vencimientos»: días restantes EXACTOS de fechas de
       juguete con su semáforo (>90 verde, 30–90 ámbar, <30
       rojo), e.firma leída del perfil, CSD ausente = «no
       consta» con su gesto, Constancia con fecha y edad.
   (30) el panel «Qué cambió en esta versión» enseña el bloque
       de novedades (NOVEDADES_1311) de la versión del artefacto.
   (22) atajos: el resolver puro, «?» abre la tarjeta, una
       tecla de navegación cambia de vista en la doble y la
       misma tecla dentro de un input NO navega; Esc cierra.
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
const MFI = 'MFI6212158B4', EDE = 'EDE1902136T2', CLI = 'CLI010101AA1';
const DIA = 86400000;
/* «Ahora» fijo para los cálculos de vencimientos: mediodía
   UTC, para que la fecha local salga igual en cualquier huso. */
const AHORA_VENC = Date.UTC(2026, 10, 17, 12);

/* ===== Arnés DOM (el de ronda240facturas, con registro de
   oyentes de documento para despachar teclas de verdad) ===== */
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
    navigator: { onLine: true, userAgent: 'ronda240hoy-test' },
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
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 0)); };
const hoyD = new Date();
const claveMes = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
const MES_PREVIO = claveMes(new Date(hoyD.getFullYear(), hoyD.getMonth() - 1, 1));
const MES_VIEJO = claveMes(new Date(hoyD.getFullYear(), hoyD.getMonth() - 3, 1));
const inv = (id, mes, from, total, metodo) => ({
  id, kind: 'I', date: mes + '-05', total, currency: 'MXN',
  from: { rfc: from, name: from === MFI ? 'Mano Fil, S.A.' : 'Elemental Denim' },
  to: { rfc: CLI, name: 'Cliente Uno' },
  fiscal: { serie: 'A', folio: '1', paymentMethod: metodo, paymentForm: '99', transferred: [], withheld: [] },
  concepts: [] });

/* ===== (6) Cierre del mes: datos, veredicto y tarjeta ===== */
{
  const ctx = await bootCliente();
  ctx.Node = FakeElement;
  const filas6 = [inv('u-mfi', MES_PREVIO, MFI, '1160.00', 'PPD'), inv('u-ede', MES_VIEJO, EDE, '500.00', 'PUE')];
  vm.runInContext(`scope = ""; people = [{ id: "${MFI}", name: "Mano Fil, S.A." }, { id: "${EDE}", name: "Elemental Denim" }];
    invoices = ${JSON.stringify(filas6)};
    documents = []; activity = [];`, ctx);
  const dMfi = vm.runInContext(`cierreDatos240("${MFI}")`, ctx);
  assert.equal(dMfi.ultimoMes, MES_PREVIO, '(6) el último mes cubierto de Mano Fil es el mes pasado');
  assert.equal(dMfi.alDia, true, '(6) con el mes pasado cubierto, las descargas están al día');
  assert.equal(dMfi.ppd, 1, '(6) su PPD sin REP es 1: el conteo del predicado de Facturas');
  const dEde = vm.runInContext(`cierreDatos240("${EDE}")`, ctx);
  assert.equal(dEde.alDia, false, '(6) Elemental Denim no llega al mes pasado: descargas no al día');
  assert.equal(dEde.ppd, 0, '(6) su PUE no cuenta como PPD sin REP');
  assert.equal(vm.runInContext(`cierreVeredicto240("Mano Fil, S.A.", cierreDatos240("${MFI}"), null)`, ctx),
    'Mano Fil, S.A.: falta 1 factura PPD sin REP.', '(6) el veredicto nombra la falta que consta, con su conteo');
  assert.equal(vm.runInContext(`cierreVeredicto240("Mano Fil, S.A.",
    { ultimoMes: "${MES_PREVIO}", alDia: true, ppd: 0 }, { ultima: ${Date.now()} })`, ctx),
    'Mano Fil, S.A.: todo listo para cerrar el mes.', '(6) sin faltas, el veredicto es «todo listo para cerrar el mes»');
  const vEde = vm.runInContext(`cierreVeredicto240("Elemental Denim", cierreDatos240("${EDE}"), null)`, ctx);
  assert.ok(vEde.startsWith('Elemental Denim: falta las descargas (último mes cubierto: '),
    '(6) el veredicto nombra lo que falta con su dato: ' + vEde);
  const vListas = vm.runInContext(`cierreVeredicto240("Mano Fil, S.A.", cierreDatos240("${MFI}"), { ultima: null })`, ctx);
  assert.ok(vListas.includes('la comprobación de las listas negras'),
    '(6) listas nunca comprobadas entran en el veredicto cuando el dato consta');
  /* La tarjeta pintada, con la lectura de listas de Hoy. */
  vm.runInContext(`satApi = async ruta => ruta === "lists"
    ? { sources: [{ fetched: ${Date.now()}, label: "69-B" }], counterparts: [] } : {};`, ctx);
  const tarjeta = vm.runInContext('cierreMesPanel240()', ctx);
  await flush();
  const texto = textoDe(tarjeta);
  assert.equal(tarjeta.dataset.cierre240, '1', '(6) la tarjeta del cierre existe en Hoy');
  assert.ok(texto.includes('Mano Fil, S.A.: falta 1 factura PPD sin REP.'),
    '(6) la tarjeta abre con el veredicto de Mano Fil: su PPD sin REP');
  assert.ok(texto.includes('Elemental Denim: falta las descargas'),
    '(6) y el de Elemental Denim: sus descargas, cada RFC con lo suyo');
  assert.ok(texto.includes('Se ve en Bancos') && texto.includes('ese dato no viaja a Hoy'),
    '(6) Bancos no viaja a Hoy: su fila lo dice y no se inventa el conteo');
  assert.ok(texto.includes('Última comprobación el'), '(6) la fila de listas enseña la fecha de la última comprobación');
  assert.ok(texto.includes('1 factura PPD sin su complemento de pago (REP)'),
    '(6) la fila REP enseña el conteo servido con su explicación');
  const filas = buscar(tarjeta, e => e.tagName === 'BUTTON');
  assert.ok(filas.length >= 8, '(6) cada componente de cada RFC es una fila clicable (' + filas.length + ')');
  console.log('OK 2.4.0·WC4b1 (6) — cierre del mes por RFC: veredictos, conteos servidos y Bancos honesto.');
}

/* ===== (18) Vencimientos: días exactos, semáforo, no consta ===== */
{
  const ctx = await bootCliente();
  ctx.Node = FakeElement;
  assert.equal(vm.runInContext(`vencDias240(${Date.UTC(2028, 9, 29, 12)}, ${AHORA_VENC})`, ctx), 712,
    '(18) del 17 nov 2026 al 29 oct 2028 quedan 712 días exactos');
  assert.equal(vm.runInContext(`vencDias240(${Date.UTC(2027, 0, 15, 12)}, ${AHORA_VENC})`, ctx), 59,
    '(18) al 15 ene 2027 quedan 59 días');
  assert.equal(vm.runInContext(`vencDias240(${Date.UTC(2026, 11, 5, 12)}, ${AHORA_VENC})`, ctx), 18,
    '(18) al 5 dic 2026 quedan 18 días');
  assert.equal(vm.runInContext('vencNivel240(712)', ctx), 'ok', '(18) >90 días: verde');
  assert.equal(vm.runInContext('vencNivel240(59)', ctx), 'warn', '(18) 30–90 días: ámbar');
  assert.equal(vm.runInContext('vencNivel240(18)', ctx), 'bad', '(18) <30 días: rojo');
  assert.equal(vm.runInContext('vencNivel240(-3)', ctx), 'bad', '(18) vencido: rojo');
  assert.equal(vm.runInContext('vencNivel240(null)', ctx), 'dim', '(18) sin fecha: sin semáforo');
  const datos = vm.runInContext(`vencDatos240({ rfc: "${MFI}", certExpires: ${Date.UTC(2028, 9, 29, 12)} }, undefined, ${AHORA_VENC})`, ctx);
  const efirma = datos.find(x => x.clave === 'efirma');
  assert.equal(efirma.pill, 'Quedan 712 días', '(18) la e.firma del perfil enseña sus días restantes');
  assert.equal(efirma.detalle, 'Vence el 29 oct 2028.', '(18) la fecha sale del dato del perfil, formateada');
  assert.equal(efirma.nivel, 'ok', '(18) la e.firma lejana va en verde');
  const csd = datos.find(x => x.clave === 'csd');
  assert.equal(csd.pill, 'No consta', '(18) sin dato de CSD en el perfil, la fila dice «no consta»');
  assert.ok(csd.detalle.includes('Calendario fiscal'), '(18) el «no consta» del CSD lleva su gesto: registrarla en el Calendario fiscal');
  assert.equal(datos.find(x => x.clave === 'constancia').pill, 'Leyendo…',
    '(18) la Constancia nace «leyendo» hasta que llega su lectura');
  const conDoc = vm.runInContext(`vencDatos240({ rfc: "${MFI}", certExpires: ${Date.UTC(2028, 9, 29, 12)} },
    { constancia: { issuedAt: ${Date.UTC(2026, 9, 20, 12)}, ageDays: 28, level: "ok" } }, ${AHORA_VENC})`, ctx);
  const constancia = conDoc.find(x => x.clave === 'constancia');
  assert.equal(constancia.pill, 'Hace 28 días', '(18) la Constancia enseña su edad');
  assert.ok(constancia.detalle.includes('Archivada el 20 oct 2026'), '(18) y su fecha archivada');
  assert.equal(constancia.nivel, 'ok', '(18) constancia reciente (level del servidor): verde');
  const sinDoc = vm.runInContext(`vencDatos240({ rfc: "${MFI}" }, null, ${AHORA_VENC})`, ctx);
  assert.equal(sinDoc.find(x => x.clave === 'constancia').pill, 'Sin archivar',
    '(18) leído y sin constancia: «sin archivar», no una fecha inventada');
  assert.equal(sinDoc.find(x => x.clave === 'efirma').pill, 'No consta',
    '(18) sin certExpires en el perfil, la e.firma también dice «no consta»');
  /* La tarjeta pintada en Hoy, con satdocs de juguete. */
  vm.runInContext(`scope = "${MFI}"; people = [{ id: "${MFI}", name: "Mano Fil, S.A." }];
    satData = { profiles: [{ rfc: "${MFI}", certExpires: ${Date.UTC(2028, 9, 29, 12)} }], jobs: [], inbox: [], mail: {} };
    satApi = async ruta => ruta === "satdocs"
      ? { profiles: [{ rfc: "${MFI}", constancia: { issuedAt: ${Date.UTC(2026, 9, 20, 12)}, ageDays: 28, level: "ok" } }] } : {};`, ctx);
  const tarjeta = vm.runInContext('vencPanel240()', ctx);
  await flush();
  const texto = textoDe(tarjeta);
  assert.equal(tarjeta.dataset.venc240, '1', '(18) la tarjeta de vencimientos existe en Hoy');
  assert.ok(texto.includes('Quedan') && texto.includes('días') && texto.includes('Vence el 29 oct 2028'),
    '(18) la tarjeta enseña la e.firma con sus días y su fecha');
  assert.ok(texto.includes('No consta') && texto.includes('CSD'), '(18) la tarjeta nombra el CSD como «no consta»');
  assert.ok(texto.includes('Hace 28 días') && texto.includes('Archivada el 20 oct 2026'),
    '(18) la tarjeta enseña la Constancia archivada con su edad');
  console.log('OK 2.4.0·WC4b1 (18) — vencimientos con días exactos, semáforo y «no consta» honesto.');
}

/* ===== (30) Qué cambió en esta versión ===== */
{
  const ctx = await bootCliente();
  ctx.Node = FakeElement;
  const datos = vm.runInContext('versionDatos240()', ctx);
  assert.ok(datos, '(30) el bloque de novedades de la versión en curso es alcanzable');
  assert.equal(datos.version, vm.runInContext('PACOSAT_META.version', ctx),
    '(30) el panel enseña el bloque de LA VERSIÓN DEL ARTEFACTO');
  assert.ok(Array.isArray(datos.puntos) && datos.puntos.length >= 1, '(30) el bloque trae su lista llana');
  const panel240 = vm.runInContext('versionPanel240()', ctx);
  assert.ok(panel240, '(30) el panel de Hoy se pinta con el bloque en curso');
  assert.equal(panel240.dataset.version240, datos.version, '(30) el panel va sellado con su versión');
  const texto = textoDe(panel240);
  assert.ok(texto.includes('Qué cambió en esta versión'), '(30) el panel se titula en llano');
  assert.ok(texto.includes(datos.puntos[0].slice(0, 40)), '(30) el panel enseña la lista del bloque, sin reescribirla');
  /* El buscador de funciones aterriza en ESTE panel y en atajos,
     y «qué cambió» (desde ayer) conserva su destino de siempre. */
  const version = vm.runInContext('funcionBuscador240("qué cambió en esta versión")', ctx);
  assert.equal(version?.destino, 'version240', '(30) «qué cambió en esta versión» aterriza en el panel de la versión');
  const ayer = vm.runInContext('funcionBuscador240("qué cambió")', ctx);
  assert.equal(ayer?.destino, 'cambios', '(30) «qué cambió» sigue yendo a «desde ayer»: destinos coordinados, no pisados');
  const atajos = vm.runInContext('funcionBuscador240("atajos")', ctx);
  assert.equal(atajos?.destino, 'atajos240', '(22) «atajos» en el buscador aterriza en la tarjeta de atajos');
  console.log('OK 2.4.0·WC4b1 (30) — «Qué cambió en esta versión» lee el bloque de novedades de la versión del artefacto.');
}

/* ===== (22) Atajos de teclado ===== */
{
  const ctx = await bootCliente();
  ctx.Node = FakeElement;
  /* El resolver puro. */
  assert.deepEqual({ ...vm.runInContext('atajosTecla240({ key: "f", target: { tagName: "BODY" } })', ctx) },
    { tipo: 'vista', vista: 'invoices' }, '(22) «f» pide Facturas');
  assert.deepEqual({ ...vm.runInContext('atajosTecla240({ key: "h", target: { tagName: "BODY" } })', ctx) },
    { tipo: 'vista', vista: 'home' }, '(22) «h» pide Hoy');
  assert.deepEqual({ ...vm.runInContext('atajosTecla240({ key: "d", target: { tagName: "BODY" } })', ctx) },
    { tipo: 'vista', vista: 'dinero' }, '(22) «d» pide Dinero');
  assert.deepEqual({ ...vm.runInContext('atajosTecla240({ key: "o", target: { tagName: "BODY" } })', ctx) },
    { tipo: 'vista', vista: 'docs' }, '(22) «o» pide Documentos');
  assert.deepEqual({ ...vm.runInContext('atajosTecla240({ key: "b", target: { tagName: "BODY" } })', ctx) },
    { tipo: 'buscar' }, '(22) «b» pide el Buscador');
  assert.deepEqual({ ...vm.runInContext('atajosTecla240({ key: "?", target: { tagName: "BODY" } })', ctx) },
    { tipo: 'atajos' }, '(22) «?» pide la tarjeta de atajos');
  assert.equal(vm.runInContext('atajosTecla240({ key: "f", target: { tagName: "INPUT" } })', ctx), null,
    '(22) «f» dentro de un input no pide nada: se está escribiendo');
  assert.equal(vm.runInContext('atajosTecla240({ key: "?", target: { tagName: "TEXTAREA" } })', ctx), null,
    '(22) «?» dentro de un textarea tampoco se dispara');
  assert.equal(vm.runInContext('atajosTecla240({ key: "f", ctrlKey: true, target: { tagName: "BODY" } })', ctx), null,
    '(22) con modificador, el atajo no actúa');
  assert.equal(vm.runInContext('atajosTecla240({ key: "x", target: { tagName: "BODY" } })', ctx), null,
    '(22) una tecla sin atajo no pide nada');
  /* La doble completa: despachar la tecla por el oyente real. */
  vm.runInContext('__nav240 = []; navigate = vista => { __nav240.push(vista); };', ctx);
  const oyentes = ctx.document.__oyentes.get('keydown') || [];
  assert.ok(oyentes.length >= 1, '(22) el oyente de teclado quedó instalado al arrancar');
  const despachar = ev => { for (const fn of oyentes) fn(ev); };
  despachar({ key: 'f', target: { tagName: 'BODY' }, preventDefault() {} });
  assert.deepEqual([...vm.runInContext('__nav240', ctx)], ['invoices'],
    '(22) despachar «f» en la doble navega a Facturas');
  despachar({ key: 'f', target: { tagName: 'INPUT' }, preventDefault() {} });
  assert.deepEqual([...vm.runInContext('__nav240', ctx)], ['invoices'],
    '(22) la misma «f» dentro de un input NO navega');
  despachar({ key: '?', target: { tagName: 'BODY' }, preventDefault() {} });
  /* RE-BASE 2.8.0 (diseño 26): una sola puerta de ayuda — la
     «?» navega a Preguntas, donde los atajos son una sección;
     ya no hay tarjeta-diálogo de atajos. */
  assert.deepEqual([...vm.runInContext('__nav240', ctx)].slice(-1), ['preguntas'],
    '(22) «?» abre Preguntas, la única puerta de ayuda');
  assert.equal(vm.runInContext('atajosDialogo240', ctx), null,
    '(22) ningún diálogo de atajos se abre ya');
  const preg280 = vm.runInContext('preguntasScreen()', ctx);
  const textoPreg280 = preg280.map(textoDe).join('\n');
  assert.ok(textoPreg280.includes('Ir a Facturas') && textoPreg280.includes('Ctrl+K'),
    '(22) la sección de atajos de Preguntas lista los atajos reales, incluidos los de siempre (Ctrl+K)');
  despachar({ key: 'Escape', target: { tagName: 'BODY' }, preventDefault() {} });
  assert.equal(vm.runInContext('atajosDialogo240', ctx), null, '(22) Esc no tiene tarjeta de atajos que cerrar');
  /* La tarjeta de Hoy y la entrada del menú en el artefacto. */
  const tarjeta = vm.runInContext('atajosTarjeta240()', ctx);
  assert.equal(tarjeta.dataset.atajos240, '1', '(22) la tarjeta de atajos sigue existiendo como función (su sitio visible es Preguntas, diseño 26)');
  assert.ok(textoDe(tarjeta).includes('no se disparan mientras escribes'),
    '(22) la tarjeta avisa de que escribir en un campo manda sobre los atajos');
  assert.ok(html.includes('id="atajos-btn240"'), '(22) el menú lateral lleva su entrada visible a los atajos');
  console.log('OK 2.4.0·WC4b1 (22) — atajos reales: «?» abre Preguntas, las teclas navegan, en un campo no.');
}

/* ===== Hoy integra las cuatro tarjetas ===== */
{
  const ctx = await bootCliente();
  ctx.Node = FakeElement;
  const filasHoy = [inv('u-mfi', MES_PREVIO, MFI, '1160.00', 'PPD')];
  vm.runInContext(`ready = true; scope = "${MFI}";
    people = [{ id: "${MFI}", name: "Mano Fil, S.A." }];
    invoices = ${JSON.stringify(filasHoy)};
    documents = []; activity = [];
    satData = { profiles: [{ rfc: "${MFI}", lastSatSuccess: Date.now(), certExpires: ${Date.UTC(2028, 9, 29, 12)} }],
      puerta: { "${MFI}": { ok: true, probada: Date.now() } },
      ejecutor: { emparejado: true, enLinea: true, ultimoVisto: Date.now(), residencia: { registrada: true, instancias: 1 } },
      pendingProfiles: [], jobs: [], inbox: [], mail: {} };`, ctx);
  const blocks = vm.runInContext('home()', ctx);
  const texto = blocks.map(textoDe).join('\n');
  /* RE-BASE 2.8.0 (diseño 2, 13, 14 y 15): Hoy ya NO integra
     el desglose «Qué falta para cerrar el mes» (queda su
     línea-resumen «Cierre del mes», que enlaza a Cierre), ni
     «Qué cambió en esta versión» (vive en Ajustes › Acerca
     de), ni la tarjeta de atajos (vive en la tecla «?» y en el
     botón de la barra). Los vencimientos —lo del día— se
     quedan. Se pina la composición nueva exacta. */
  assert.ok(texto.includes('Vencimientos'), 'Hoy integra la tarjeta «Vencimientos»');
  assert.ok(texto.includes('Cierre del mes'), 'Hoy integra la línea-resumen del cierre (diseño 15)');
  assert.ok(/Te faltan \d+ cosas? para cerrar|Todo listo para cerrar/.test(texto),
    'la línea-resumen dice cuántas cosas faltan para cerrar el mes');
  for (const titulo of ['Qué falta para cerrar el mes', 'Qué cambió en esta versión', 'Atajos de teclado'])
    assert.ok(!texto.includes(titulo), 'Hoy ya NO integra «' + titulo + '» (vive en su pantalla dueña, diseño 2)');
  console.log('OK 2.8.0 — Hoy integra vencimientos y la línea-resumen del cierre; versión y atajos viven en su pantalla dueña.');
}

console.log('OK 2.4.0 · WC4b1 — Hoy: cierre del mes por RFC, vencimientos con días exactos, «qué cambió en esta versión» y atajos de teclado.');
