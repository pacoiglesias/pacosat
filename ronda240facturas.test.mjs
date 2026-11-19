/* ================================================================
   Ronda 2.4.0 · W4b — Facturas: chips de filtros rápidos (P5)
   y tarjeta protagonista «PPD sin REP» (castigo 8).
   Sobre el ARTEFACTO construido y con el arnés DOM de la casa:
   (a) con un juego de facturas de juguete (fechas relativas a
       «ahora», para que el reloj de la suite sea el real), los
       tres chips cuentan lo esperado y, activados, el motor
       de la vista (invoiceRows) deja EXACTAMENTE sus UUID;
   (b) la tarjeta PPD suma el saldo reconciliado y ordena por
       atraso, con los días calculados de las fechas;
   (c) el recordatorio generado contiene folio, importe y
       días de SU factura, y su «Enviar» va por correo con la
       clase «recordatorio» (premisa re-basada por el
       coordinador: W4b lo dejó solo-compartir porque la ruta
       no admitía recordatorios; W2c añadió la clase y el
       servidor compone el cuerpo desde la factura);
   (d) sin PPD, la tarjeta pinta su estado limpio con fecha.
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
const OWN = 'MFI6212158B4';
const DIA = 86400000;
const AHORA = Date.now();
const hace = dias => new Date(AHORA - dias * DIA).toISOString().slice(0, 10);

/* ===== Arnés DOM (el de ronda240enviar) ===== */
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
    navigator: { onLine: true, userAgent: 'ronda240facturas-test' },
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

/* ===== El juego de juguete =====
   A · PPD emitida hace 60 días, $1,160, sin REP → PPD, >30.
   B · PPD emitida hace 15 días, $2,320, REP parcial de
       $1,000 → PPD (saldo $1,320), no >30.
   C · PPD recibida hace 101 días, $580, sin REP → PPD, >30.
   D · PUE emitida hace 70 días → pagada al nacer: nada.
   E · PPD cancelada hace 40 días → fuera de PPD y de >30;
       cancelada de OTRO mes: fuera de «del mes».
   F · Cancelada HOY → «Canceladas del mes» = 1.
   G · Ingreso sin método hace 47 días, sin pagos → >30, no PPD.
   I · PPD hace 50 días con REP completo → nada. */
const A = 'aaaaaaa1-1111-4111-8111-111111111111';
const B = 'bbbbbbb2-2222-4222-8222-222222222222';
const C = 'ccccccc3-3333-4333-8333-333333333333';
const D = 'ddddddd4-4444-4444-8444-444444444444';
const E = 'eeeeeee5-5555-4555-8555-555555555555';
const F = 'fffffff6-6666-4666-8666-666666666666';
const G = 'ggggggg7-7777-4777-8777-777777777777';
const I = 'iiiiiii9-9999-4999-8999-999999999999';
const CLI1 = 'CLI010101AA1', CLI2 = 'CLI020202BB2', PROV = 'PRO010101AAA';
const inv = (id, dias, from, to, total, metodo, folio) => ({
  id, kind: 'I', date: hace(dias), total, currency: 'MXN',
  from: { rfc: from, name: from === OWN ? 'Mano Fil, S.A.' : from === PROV ? 'Proveedor Uno' : 'Cliente ' + folio },
  to: { rfc: to, name: to === OWN ? 'Mano Fil, S.A.' : 'Cliente ' + folio },
  fiscal: { serie: 'A', folio, paymentMethod: metodo, paymentForm: '99', transferred: [], withheld: [] },
  concepts: [] });
const rep = (id, docs) => ({
  id, kind: 'P', date: hace(5), total: '0.00', currency: 'XXX',
  from: { rfc: OWN, name: 'Mano Fil, S.A.' }, to: { rfc: CLI1, name: 'Cliente 101' },
  fiscal: { serie: '', folio: '', payments: { pagos: [{ fechaPago: hace(5), documentos: docs }] },
    transferred: [], withheld: [] }, concepts: [] });
function semilla(ctx) {
  ctx.Node = FakeElement;
  const filas = [
    inv(A, 60, OWN, CLI1, '1160.00', 'PPD', '101'),
    inv(B, 15, OWN, CLI2, '2320.00', 'PPD', '102'),
    inv(C, 101, PROV, OWN, '580.00', 'PPD', '103'),
    inv(D, 70, OWN, CLI1, '1000.00', 'PUE', '104'),
    inv(E, 40, OWN, CLI1, '999.00', 'PPD', '105'),
    inv(F, 0, OWN, CLI1, '700.00', 'PUE', '106'),
    inv(G, 47, PROV, OWN, '700.00', '', '107'),
    inv(I, 50, OWN, CLI2, '500.00', 'PPD', '108'),
    rep('pago-b', [{ idDocumento: B, impPagado: '1000.00' }]),
    rep('pago-i', [{ idDocumento: I, impPagado: '500.00' }])
  ];
  vm.runInContext(`scope = "${OWN}"; people = [{ id: "${OWN}", name: "Mano Fil, S.A." }];
    documents = []; activity = []; invoices = ${JSON.stringify(filas)};`, ctx);
  vm.runInContext(`fiscalResults.set("${E}", { sat: { state: "Cancelado" } });
    fiscalResults.set("${F}", { sat: { state: "Cancelado" } });`, ctx);
  vm.runInContext(`satApi = async () => ({}); render = () => {};`, ctx);
}
const idsDe = filas => filas.map(r => r.id).sort();

/* ===== (a)+(b) conteos, tarjeta y filtrado exacto ===== */
{
  const ctx = await bootCliente();
  semilla(ctx);
  const datos = vm.runInContext(`facturasDatos240(${AHORA})`, ctx);
  assert.equal(datos.conteos['ppd-sin-rep'], 3, '(a) «PPD sin REP» cuenta A, B y C');
  assert.equal(datos.conteos['canceladas-mes'], 1, '(a) «Canceladas del mes» cuenta solo F (E es de otro mes)');
  assert.equal(datos.conteos['pendientes-30'], 3, '(a) «Pendientes >30 días» cuenta A, C y G');
  assert.equal(JSON.stringify(idsDe(datos.ppd.map(x => x.row))), JSON.stringify([A, B, C].sort()), '(b) el conjunto PPD es exacto');
  assert.equal(JSON.stringify([...datos.ppd].map(x => x.row.id)), JSON.stringify([C, A, B]),
    '(b) la tarjeta ordena por atraso: C (101 días), A (60), B (15)');
  assert.equal(JSON.stringify([...datos.ppd].map(x => x.dias)), JSON.stringify([101, 60, 15]),
    '(b) los días de atraso salen de las fechas de juguete');
  assert.equal(String(datos.ppdTotal), '306000',
    '(b) el importe de la tarjeta es el saldo reconciliado: 1,160 + 1,320 (tras REP parcial) + 580, en centavos');

  /* La vista pinta chips con esos conteos y la tarjeta arriba. */
  const vista = vm.runInContext('invoiceScreen()', ctx);
  await flush();
  const textoVista = textoDe(vista[0]);
  const chips = buscar(vista[0], e => e.tagName === 'BUTTON' && e.dataset.rapido240);
  assert.equal(chips.length, 3, '(a) la vista pinta los tres chips rápidos, ni uno más');
  const chipDe = clave => chips.find(c => c.dataset.rapido240 === clave);
  assert.ok(textoDe(chipDe('ppd-sin-rep')).includes('PPD sin REP · 3'), '(a) el chip PPD enseña su conteo en vivo');
  assert.ok(textoDe(chipDe('canceladas-mes')).includes('Canceladas del mes · 1'), '(a) el chip de canceladas enseña su conteo');
  assert.ok(textoDe(chipDe('pendientes-30')).includes('Pendientes >30 días · 3'), '(a) el chip de pendientes enseña su conteo');
  const tarjeta = buscar(vista[0], e => e.dataset.ppd240)[0];
  assert.ok(tarjeta, '(b) la vista abre con su tarjeta protagonista PPD');
  assert.equal(tarjeta.dataset.ppd240, 'pendientes', '(b) con pendientes, la tarjeta lo dice');
  const textoTarjeta = textoDe(tarjeta);
  assert.ok(textoTarjeta.includes('$3,060.00'), '(b) la tarjeta enseña el total de saldo PPD sin REP');
  assert.ok(textoTarjeta.includes('Proveedor Uno') && textoTarjeta.includes('101 días de atraso'),
    '(b) la lista corta abre con el más atrasado, su emisor y sus días');
  assert.ok(textoTarjeta.includes('Folio A-101') && textoTarjeta.includes('60 días de atraso'),
    '(b) cada atrasado va con su folio y sus días');

  /* Activar cada chip filtra el listado a EXACTAMENTE sus UUID. */
  const limpiar = () => vm.runInContext(`term = ""; month = ""; invoiceKind = ""; invoiceState = "";
    invoicePayState = ""; invoiceContraparte201 = ""; direction = "Todos"; invoiceRapido240 = ""; invoicePage = 0;`, ctx);
  limpiar();
  chipDe('ppd-sin-rep').onclick();
  assert.equal(vm.runInContext('invoiceRapido240', ctx), 'ppd-sin-rep', '(a) el chip activa su filtro');
  assert.equal(JSON.stringify(idsDe(vm.runInContext('invoiceRows()', ctx))), JSON.stringify([A, B, C].sort()),
    '(a) con el chip PPD, el listado es exactamente A, B y C');
  chipDe('ppd-sin-rep').onclick();
  assert.equal(vm.runInContext('invoiceRapido240', ctx), '', '(a) desactivar el chip lo apaga');
  assert.equal(vm.runInContext('invoiceRows()', ctx).length, 10,
    '(a) al desactivarlo se vuelve al listado completo (las 10 filas del juego, con sus REP)');
  limpiar();
  chipDe('canceladas-mes').onclick();
  assert.equal(JSON.stringify(idsDe(vm.runInContext('invoiceRows()', ctx))), JSON.stringify([F]),
    '(a) con el chip de canceladas del mes, el listado es exactamente F');
  assert.equal(vm.runInContext('direction', ctx), 'Canceladas',
    '(a) el chip de canceladas se apoya en el filtro de siempre (direction)');
  chipDe('canceladas-mes').onclick();
  limpiar();
  chipDe('pendientes-30').onclick();
  assert.equal(JSON.stringify(idsDe(vm.runInContext('invoiceRows()', ctx))), JSON.stringify([A, C, G].sort()),
    '(a) con el chip de pendientes >30 días, el listado es exactamente A, C y G');
  console.log('OK 2.4.0·W4b (a)(b) — chips cuentan y filtran exacto; la tarjeta suma $3,060.00 y ordena por atraso.');
}

/* ===== (c) el recordatorio de SU factura y su Enviar ===== */
{
  const ctx = await bootCliente();
  semilla(ctx);
  const datos = vm.runInContext(`facturasDatos240(${AHORA})`, ctx);
  const itemA = datos.ppd.find(x => x.row.id === A);
  const texto = vm.runInContext(`facturasRecordatorio240(facturasDatos240(${AHORA}).ppd.find(x => x.row.id === "${A}"))`, ctx);
  assert.ok(texto.includes('A-101'), '(c) el recordatorio nombra el folio de su factura');
  assert.ok(texto.includes('$1,160.00'), '(c) el recordatorio nombra el importe de su factura');
  assert.ok(texto.includes('60 días de atraso'), '(c) el recordatorio nombra los días de atraso de su factura');
  assert.ok(texto.startsWith('Hola, Mano Fil, S.A.:'), '(c) el recordatorio se dirige al emisor de su factura');
  const textoC = vm.runInContext(`facturasRecordatorio240(facturasDatos240(${AHORA}).ppd.find(x => x.row.id === "${C}"))`, ctx);
  assert.ok(textoC.startsWith('Hola, Proveedor Uno:') && textoC.includes('A-103') &&
    textoC.includes('$580.00') && textoC.includes('101 días de atraso'),
    '(c) el recordatorio de la recibida va a su emisor (el proveedor) con sus datos');
  assert.ok(itemA && String(itemA.saldo) === '116000', '(c) el saldo del recordatorio es el de su factura');
  /* Su botón en la tarjeta: Enviar con correo por su clase
     «recordatorio» (W2c) y la hoja de compartir de siempre. */
  const tarjeta = vm.runInContext(`facturasPpdTarjeta240(facturasDatos240(${AHORA}))`, ctx);
  const enviarA = buscar(tarjeta, e => e.dataset.enviarRecordatorio240 === A)[0];
  assert.ok(enviarA, '(c) cada atrasado de la tarjeta lleva su «Enviar» del recordatorio');
  assert.equal(enviarA.dataset.enviar240, 'recordatorio',
    '(c) el Enviar del recordatorio ofrece correo por la clase «recordatorio»: el servidor compone el cuerpo desde la factura reconciliada');
  const copiar = buscar(tarjeta, e => e.tagName === 'BUTTON' && (e.textContent || '').trim() === 'Copiar recordatorio');
  assert.equal(copiar.length, 3, '(c) cada atrasado lleva su «Copiar recordatorio» con el texto listo');
  console.log('OK 2.4.0·W4b (c) — recordatorio con folio, importe y días de su factura; Enviar por correo (clase recordatorio) y por la hoja.');
}

/* ===== (d) sin PPD: la tarjeta limpia, protagonista ===== */
{
  const ctx = await bootCliente();
  semilla(ctx);
  vm.runInContext(`invoices = invoices.filter(r => r.id === "${D}" || r.kind === "P"); fiscalResults.clear();`, ctx);
  const datos = vm.runInContext(`facturasDatos240(${AHORA})`, ctx);
  assert.equal(datos.conteos['ppd-sin-rep'], 0, '(d) sin PPD con saldo, el conteo es cero');
  const tarjeta = vm.runInContext(`facturasPpdTarjeta240(facturasDatos240(${AHORA}))`, ctx);
  assert.equal(tarjeta.dataset.ppd240, 'limpio', '(d) la tarjeta marca su estado limpio');
  assert.equal(tarjeta.dataset.level, 'ok', '(d) el estado limpio va en verde honesto');
  const texto = textoDe(tarjeta);
  assert.ok(texto.includes('Sin PPD pendientes de REP'), '(d) la tarjeta dice «Sin PPD pendientes de REP»');
  assert.ok(texto.includes('Comprobado el'), '(d) la tarjeta limpia lleva su fecha de comprobación');
  console.log('OK 2.4.0·W4b (d) — sin PPD, la tarjeta pinta su estado limpio con su fecha.');
}
