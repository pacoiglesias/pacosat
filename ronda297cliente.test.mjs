import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { webcrypto } from 'node:crypto';
import * as vm from 'node:vm';

/* ================================================================
   Ronda 2.9.7 · CLIENTE — Piezas B, C2, D6 (y paridad de la B)

   B · EL LECTOR: abrir un comprobante enseña su XML leído por
   el servidor (GET /api/cfdi/lectura?uuid=): protagonista con
   el total, conceptos con sus impuestos, impuestos y timbre
   plegado; si la lectura responde sinXml, la hoja lo dice en
   llano y «Bajar ahora» lanza POST /api/portal-cfdi/run
   { rfc, uuids:[uuid], origen:'factura' }, enseña el progreso
   (poll a /api/portal-cfdi/state) con su Cancelar (POST
   /api/portal-cfdi/cancel) y, al terminar bien, re-pide la
   lectura. Paridad: ningún botón del detalle desaparece.

   C2 · LÍNEA HONESTA + RESCATE: los trabajos de Descargar con
   portalRescue (de satData.jobs) pintan su línea — recuperada
   o con el botón «Bajarlos ahora por el portal» con el periodo
   del trabajo — y la hoja del rescate (/api/rescue) gana el
   mismo botón con el periodo del plan, origen 'rescate'.

   D6 · HOY PROACTIVO: la tarjeta «Esto pasó · Esto falta ·
   Esto te propongo» sale de los datos que Hoy ya consume
   (actividad, foco focoSistema290, satData.metadata) y la
   propuesta (a) solo aparece con pendientes > 0 y dispara
   POST /api/portal-cfdi/run { rfc, allMissing:true,
   origen:'hoy' }.

   Arnés: el DOM de juguete de la casa (ronda295/297perfeccion)
   con el fetch puenteado a un respondedor sembrado que cumple
   EL CONTRATO del servidor de la ronda (las rutas nuevas aún
   las integra el agente de servidor en paralelo; aquí se
   siembran sus respuestas exactas y se verifica que el cliente
   pide lo contratado y pinta lo respondido). El resto de rutas
   cae a los cuerpos por defecto del arnés de la casa.
   ================================================================ */

const AQUI = dirname(fileURLToPath(import.meta.url));
const OWN = 'AAA010101AAA';
const PROV = 'PROV010101AA1';
const UUID = 'f0000000-0000-4000-8000-000000000297';

const LECTURA = { uuid: UUID, tipo: 'I', fecha: '2026-11-05T10:00:00',
  emisor: { rfc: PROV, nombre: 'Proveedor de Prueba', regimen: '601' },
  receptor: { rfc: OWN, nombre: 'Empresa de Prueba, S.A.', uso: 'G03' },
  moneda: 'MXN', subTotal: '1000.00', total: '1160.00', descuento: '',
  formaPago: '03', metodoPago: 'PUE',
  conceptos: [{ cantidad: '2', descripcion: 'Cobertor de prueba', valorUnitario: '500.00',
    importe: '1000.00', impuestos: { traslados: [{ impuesto: 'IVA', tasa: '0.160000', importe: '160.00' }], retenidos: [] } }],
  impuestos: { traslados: [{ impuesto: 'IVA', tasa: '0.160000', importe: '160.00' }], retenidos: [],
    totalTrasladados: '160.00', totalRetenidos: '0.00' },
  timbre: { uuid: UUID, fechaTimbrado: '2026-11-05T10:01:00', rfcProvCertif: 'PAC010101AA1',
    noCertificadoSAT: '00001000000500000001', selloCfd: 'SELLOCFD297', selloSat: 'SELLOSAT297',
    cadenaOriginal: '||1.1|CADENA297||' },
  pagos: null, estado: 'Vigente' };
const FILA = { id: UUID, date: '2026-11-05', kind: 'I', total: '1160.00', currency: 'MXN',
  from: { rfc: PROV, name: 'Proveedor de Prueba' }, to: { rfc: OWN, name: 'Empresa de Prueba, S.A.' },
  fiscal: { paymentMethod: 'PUE', serie: '', folio: '297' } };

/* ================================================================
   Arnés DOM de la casa, con respondedor sembrado por ruta.
   opciones.responder(target, init) → { status, body } | undefined
   (undefined = cuerpo por defecto del arnés).
   ================================================================ */
const htmlCliente = readFileSync(join(AQUI, 'Faro-Fiscal.html'), 'utf8');
const lazyCliente = JSON.parse(readFileSync(join(AQUI, 'lazy.json'), 'utf8'));
class BootURL extends URL { static createObjectURL() { return 'blob:prueba'; } static revokeObjectURL() {} }
class FakeElement {
  constructor(tag = 'div') {
    this.tagName = String(tag).toUpperCase();
    this.children = []; this.dataset = {}; this.style = {}; this.attributes = {};
    this.textContent = ''; this.innerHTML = ''; this.value = '';
    this.hidden = false; this.disabled = false; this.open = false; this.files = [];
    this.checked = false; this.isConnected = true;
    const classes = new Set();
    this.classList = { add: (...n) => n.forEach(x => classes.add(x)),
      remove: (...n) => n.forEach(x => classes.delete(x)),
      toggle: (name, force) => { const on = force === undefined ? !classes.has(name) : Boolean(force);
        if (on) classes.add(name); else classes.delete(name); return on; },
      contains: name => classes.has(name) };
  }
  get childNodes() { return this.children; }
  get lastChild() { return this.children[this.children.length - 1]; }
  get firstChild() { return this.children[0]; }
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
const textoDe = el => { let t = el.textContent || ''; for (const h of el.children || []) t += ' ' + textoDe(h); return t; };
const andar = (el, salida = []) => { salida.push(el); for (const h of el.children || []) andar(h, salida); return salida; };
const buscarBoton = (raiz, texto) => andar(raiz).find(el =>
  el.tagName === 'BUTTON' && (el.textContent || '').trim().startsWith(texto));
const asentar = async (n = 30) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)); };
const esperar = async ms => { await new Promise(r => setTimeout(r, ms)); await asentar(20); };

async function bootCliente297(opciones = {}) {
  const byId = new Map();
  const slotActividad = new FakeElement('div');
  const fetchLog = [];
  const metas = { 'meta[name="pacosat-token"]': { content: 'token-de-prueba' },
    'meta[name="pacosat-cloud"]': { content: '1' } };
  const headEl = new FakeElement('head');
  const documentStub = {
    getElementById: id => { if (!byId.has(id)) byId.set(id, new FakeElement('div')); return byId.get(id); },
    createElement: tag => new FakeElement(tag),
    createElementNS: (_ns, tag) => new FakeElement(tag),
    createTextNode: text => ({ textContent: String(text) }),
    querySelector: sel => sel === '[data-sys-activity]' ? slotActividad : (metas[sel] ?? null),
    querySelectorAll: () => [], addEventListener: () => {}, removeEventListener: () => {},
    documentElement: new FakeElement('html'), body: new FakeElement('body'), head: headEl,
    activeElement: null, title: '' };
  const storageStub = (semilla = {}) => { const map = new Map(Object.entries(semilla));
    return { getItem: k => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)),
      removeItem: k => map.delete(k), clear: () => map.clear() }; };
  const fetchStub = async (url, init = {}) => {
    const target = String(url);
    const method = init.method || 'GET';
    fetchLog.push({ method, target, body: init.body || '' });
    const parteM = /\/parte\/(\w+)/.exec(target);
    if (parteM) { const src = lazyCliente.partes[parteM[1]]?.source || '';
      return { ok: true, status: 200, headers: { get: () => 'text/javascript' },
        json: async () => ({}), text: async () => src, blob: async () => new Blob([]) }; }
    if (opciones.responder) {
      const r = await opciones.responder(target, init);
      if (r !== undefined) {
        const status = r.status || 200;
        return { ok: status >= 200 && status < 300, status,
          headers: { get: () => 'application/json' },
          json: async () => r.body, text: async () => JSON.stringify(r.body),
          blob: async () => new Blob([JSON.stringify(r.body)]) };
      }
    }
    let body = {};
    if (target.includes('storage/rev')) body = { rev: 1 };
    else if (target.includes('storage?')) body = [];
    else if (target.includes('/api/status')) body = { settings: { installName: 'PacoSAT', hasLogo: false },
      buildModified: null, cloudRevision: null, profiles: [], jobs: [], inbox: [], mail: {},
      puerta: {}, ejecutor: {}, backupHealth: { enabled: false } };
    else if (target.includes('/api/cfdi/notas')) body = { notas: {} };
    else if (target.includes('/api/money')) body = { balances: [] };
    else if (target.includes('/api/salidas/cfdi')) body = { content: btoa('pdf'), type: 'application/pdf', name: 'c.pdf' };
    return { ok: true, status: 200, headers: { get: () => 'application/json' },
      json: async () => body, text: async () => JSON.stringify(body), blob: async () => new Blob([]) };
  };
  const timer = (fn, ms, ...a) => { const t = setTimeout(fn, ms, ...a); t.unref?.(); return t; };
  const every = (fn, ms, ...a) => { const t = setInterval(fn, ms, ...a); t.unref?.(); return t; };
  const context = vm.createContext({ console, document: documentStub,
    navigator: { onLine: true, userAgent: 'ronda297cliente-test' },
    location: { href: 'http://127.0.0.1:43729/', search: '', reload: () => {} },
    localStorage: storageStub(), sessionStorage: storageStub(),
    fetch: fetchStub, setTimeout: timer, setInterval: every, clearTimeout, clearInterval, queueMicrotask,
    URL: BootURL, URLSearchParams, Blob, TextEncoder, TextDecoder, btoa, atob,
    crypto: webcrypto, DecompressionStream, Node: class FakeNode {}, IntersectionObserver: undefined,
    matchMedia: () => ({ matches: false, addEventListener: () => {}, addListener: () => {} }),
    Option: class extends FakeElement {}, alert: () => {}, confirm: () => true,
    addEventListener: () => {}, removeEventListener: () => {},
    requestAnimationFrame: fn => timer(fn, 0) });
  context.window = context; context.self = context;
  headEl.appendChild = kid => {
    if (kid && typeof kid.textContent === 'string' && kid.textContent)
      vm.runInContext(kid.textContent, context, { filename: 'parte-diferida' });
    return kid;
  };
  const script = htmlCliente.match(/<script>([\s\S]*?)<\/script>/)[1];
  vm.runInContext(script, context, { filename: 'Faro-Fiscal.html#script' });
  await asentar(40);
  return { context, fetchLog,
    campos: () => context.document.getElementById('fields'),
    textoCampos: () => textoDe(context.document.getElementById('fields')) };
}
const semillaBase = (b, extra = '') => vm.runInContext(
  'scope = "' + OWN + '"; people = [{ id: "' + OWN + '", name: "Empresa de Prueba, S.A." }];' +
  'invoices = [' + JSON.stringify(FILA) + ']; documents = []; activity = [];' +
  'satData = { profiles: [{ rfc: "' + OWN + '" }], jobs: [], mail: {}, puerta: {}, ejecutor: {},' +
  ' metadata: { records: 0, missing: [], lastSeen: null }, coverage: { groups: [], gaps: [], days: {}, records: [] } };' +
  'portalPollMs297 = 5;' + extra, b.context);

/* ================================================================
   Estática: el contrato de la ronda está cableado en el cliente
   ================================================================ */
{
  const ui = readFileSync(join(AQUI, 'ui.part'), 'utf8');
  const wf = readFileSync(join(AQUI, 'workflows.part'), 'utf8');
  const sat = readFileSync(join(AQUI, 'sat-ui.part'), 'utf8');
  assert.ok(ui.includes("'cfdi/lectura?uuid='"), 'B: el cliente pide la lectura por su ruta contratada');
  assert.ok(ui.includes("'portal-cfdi/run'") && ui.includes("'portal-cfdi/cancel'") &&
    ui.includes("'portal-cfdi/state?rfc='"), 'B/C2/D6: run, cancel y state del portal, por su ruta');
  assert.ok(wf.includes("origen: 'factura'") && wf.includes('uuids: [row.id]'),
    'B: «Bajar ahora» de la factura pide sus uuids con origen factura');
  assert.ok(ui.includes("origen: 'hoy'") && ui.includes('allMissing: true'),
    'D6: la propuesta de Hoy pide allMissing con origen hoy');
  assert.ok(sat.includes("origen: 'rescate'"), 'C2: el rescate pide su periodo con origen rescate');
  assert.ok(sat.includes('Sus documentos ya entraron por el portal. La solicitud sigue abierta en el SAT (no se puede cancelar desde aquí) y PacoSAT ya no depende de ella.'),
    'C2: la línea de recuperada es la frase contratada, literal');
  assert.ok(wf.includes('Este comprobante está detectado por metadatos pero su XML aún no está en tu expediente'),
    'B: la hoja sinXml lo dice en llano, con la frase contratada');
  console.log('OK 2.9.7-cliente · Estática — El contrato (lectura, run/cancel/state, orígenes) está cableado en ui/workflows/sat-ui.');
}

/* ================================================================
   (a) EL LECTOR SE PINTA desde una lectura sembrada: protagonis-
   ta con el total, conceptos con impuestos, timbre plegado; y
   (e) los botones de siempre (XML/PDF/enviar…) siguen ahí.
   ================================================================ */
{
  const b = await bootCliente297({ responder: async target => {
    if (target.includes('/api/cfdi/lectura')) return { body: { ok: true, ms: 3, lectura: LECTURA } };
    return undefined;
  } });
  semillaBase(b);
  vm.runInContext('invoiceDetail(invoices[0])', b.context);
  await asentar(60);
  const campos = b.campos();
  const texto = b.textoCampos();
  const prota = andar(campos).find(el => el.dataset.lectorProtagonista297 === '1');
  assert.ok(prota, '(a) el Lector pinta su tarjeta protagonista');
  assert.ok(textoDe(prota).includes('$1160.00'), '(a) la protagonista enseña el total de la lectura');
  assert.ok(textoDe(prota).includes('Proveedor de Prueba') && textoDe(prota).includes('Empresa de Prueba, S.A.'),
    '(a) la protagonista enseña emisor → receptor');
  assert.ok(textoDe(prota).includes('Vigente'), '(a) y el estado del comprobante');
  assert.ok(texto.includes('Cobertor de prueba'), '(a) los conceptos se pintan (descripción)');
  assert.ok(texto.includes('IVA') && texto.includes('160.00'), '(a) con sus impuestos por concepto y trasladados');
  assert.ok(texto.includes('G03'), '(a) el uso de CFDI del receptor');
  const timbre = andar(campos).find(el => el.dataset.lectorTimbre297 === '1');
  assert.ok(timbre, '(a) el timbre va en su despliegue progresivo');
  assert.equal(timbre.tagName, 'DETAILS', '(a) el timbre es un <details> plegado («Ver timbre»)');
  assert.ok(textoDe(timbre).includes('Ver timbre') && textoDe(timbre).includes('SELLOCFD297') &&
    textoDe(timbre).includes('CADENA297') && textoDe(timbre).includes('PAC010101AA1'),
    '(a) el timbre trae UUID, fecha, PAC, sellos y cadena original');
  /* (e) Paridad del detalle: lo que había, sigue. */
  for (const boton of ['Copiar UUID', 'Descargar XML original', 'Ver comprobante', 'Descargar PDF', 'XML + PDF', 'Reenviar por correo'])
    assert.ok(buscarBoton(campos, boton), '(e) el detalle conserva «' + boton + '»');
  assert.ok(andar(campos).some(el => el.tagName === 'BUTTON' && (el.textContent || '').trim().startsWith('Enviar')),
    '(e) el detalle conserva su «Enviar» junto a las descargas');
  const filaActs = vm.runInContext('invoiceActions(invoices[0])', b.context);
  for (const boton of ['Revisar ahora', 'PDF', 'XML'])
    assert.ok(buscarBoton(filaActs, boton), '(e) las acciones de fila conservan «' + boton + '»');
  assert.ok(andar(filaActs).some(el => el.tagName === 'BUTTON' && (el.textContent || '').trim() === 'Enviar XML'),
    '(e) la fila conserva su «Enviar XML»');
  const uiSrc = readFileSync(join(AQUI, 'ui.part'), 'utf8');
  assert.ok(uiSrc.includes("satApi('salidas/zip'"), '(e) el ZIP de la selección sigue en la pantalla de Facturas');
  console.log('OK 2.9.7-cliente · (a)+(e) — El Lector se pinta desde la lectura sembrada (protagonista, conceptos, timbre plegado) y el detalle conserva todas sus acciones.');
}

/* ================================================================
   (b) sinXml → «Bajar ahora»: POST correcto, progreso vivo y,
   al terminar bien, la lectura se re-pide y se enseña.
   ================================================================ */
{
  let lecturas = 0, sondeos = 0;
  const b = await bootCliente297({ responder: async target => {
    if (target.includes('/api/cfdi/lectura')) {
      lecturas++;
      return lecturas === 1 ? { status: 404, body: { ok: false, sinXml: true } }
        : { body: { ok: true, ms: 3, lectura: LECTURA } };
    }
    if (target.includes('/api/portal-cfdi/run')) return { body: { ok: true } };
    if (target.includes('/api/portal-cfdi/state')) {
      sondeos++;
      return { body: { configurado: true,
        progress: sondeos < 3 ? { running: true, ok: false, step: 'Descargando del portal…', steps: [] }
          : { running: false, ok: true, step: 'Terminado', steps: [] },
        runs: [{ ok: true }], quota: { used: 1, limit: 2000, remaining: 1999 } } };
    }
    return undefined;
  } });
  semillaBase(b);
  vm.runInContext('invoiceDetail(invoices[0])', b.context);
  await asentar(60);
  assert.ok(b.textoCampos().includes('Este comprobante está detectado por metadatos pero su XML aún no está en tu expediente'),
    '(b) sinXml: la hoja lo dice en llano');
  const bajar = andar(b.campos()).find(el => el.dataset.lectorBajar297 === '1');
  assert.ok(bajar, '(b) sinXml: la hoja ofrece «Bajar ahora»');
  b.fetchLog.length = 0;
  await bajar.onclick();
  await esperar(120);
  const run = b.fetchLog.find(l => l.method === 'POST' && l.target.includes('/api/portal-cfdi/run'));
  assert.ok(run, '(b) al pulsar sale el POST a /api/portal-cfdi/run');
  assert.deepEqual(JSON.parse(run.body), { rfc: OWN, uuids: [UUID], origen: 'factura' },
    '(b) el POST es el contratado: { rfc, uuids:[uuid], origen:\'factura\' }');
  assert.ok(b.fetchLog.filter(l => l.target.includes('/api/portal-cfdi/state')).length >= 2,
    '(b) el progreso se sondea en /api/portal-cfdi/state');
  assert.ok(lecturas >= 2, '(b) al terminar bien, la lectura se re-pide');
  assert.ok(b.textoCampos().includes('$1160.00') && b.textoCampos().includes('Cobertor de prueba'),
    '(b) y la lectura nueva se enseña (total y conceptos)');
  console.log('OK 2.9.7-cliente · (b) — sinXml → «Bajar ahora» con el POST contratado, progreso sondeado y re-lectura pintada.');
}

/* ================================================================
   (b2) CANCELAR la bajada manda su POST a /api/portal-cfdi/cancel
   ================================================================ */
{
  const b = await bootCliente297({ responder: async target => {
    if (target.includes('/api/cfdi/lectura')) return { status: 404, body: { ok: false, sinXml: true } };
    if (target.includes('/api/portal-cfdi/run')) return { body: { ok: true } };
    if (target.includes('/api/portal-cfdi/cancel')) return { body: { ok: true } };
    if (target.includes('/api/portal-cfdi/state')) return { body: { configurado: true,
      progress: { running: true, ok: false, step: 'Descargando del portal…', steps: [] },
      runs: [], quota: { used: 0, limit: 2000, remaining: 2000 } } };
    return undefined;
  } });
  semillaBase(b);
  vm.runInContext('invoiceDetail(invoices[0])', b.context);
  await asentar(60);
  const bajar = andar(b.campos()).find(el => el.dataset.lectorBajar297 === '1');
  assert.ok(bajar, '(b2) la hoja ofrece «Bajar ahora»');
  await bajar.onclick();
  await esperar(60);
  const progreso = andar(b.campos()).find(el => el.dataset.portalStep297 === '1');
  assert.ok(progreso && textoDe(progreso).includes('Descargando del portal'),
    '(b2) durante la corrida se enseña el paso vivo del estado');
  const cancelar = buscarBoton(b.campos(), 'Cancelar');
  assert.ok(cancelar, '(b2) la corrida enseña su botón «Cancelar»');
  b.fetchLog.length = 0;
  await cancelar.onclick();
  await asentar(30);
  const cancel = b.fetchLog.find(l => l.method === 'POST' && l.target.includes('/api/portal-cfdi/cancel'));
  assert.ok(cancel, '(b2) cancelar manda su POST a /api/portal-cfdi/cancel');
  assert.deepEqual(JSON.parse(cancel.body), { rfc: OWN }, '(b2) el POST de cancelar lleva el RFC');
  console.log('OK 2.9.7-cliente · (b2) — La corrida enseña el paso vivo y «Cancelar» manda su POST.');
}

/* ================================================================
   (c) HOY PROACTIVO: tres bloques; la propuesta (a) solo con
   pendientes > 0 y dispara el POST allMissing; con 0, no sale.
   ================================================================ */
{
  const responderHoy = async target => {
    if (target.includes('/api/portal-cfdi/run')) return { body: { ok: true } };
    if (target.includes('/api/portal-cfdi/state')) return { body: { configurado: true,
      progress: { running: false, ok: true, step: 'Terminado', steps: [] },
      runs: [{ ok: true }], quota: { used: 2, limit: 2000, remaining: 1998 } } };
    return undefined;
  };
  const b = await bootCliente297({ responder: responderHoy });
  semillaBase(b,
    'activity = [{ name: "CFDI nuevo", event: "Llegó un CFDI nuevo de Proveedor de Prueba", date: "2026-11-18T09:00:00" }];' +
    'satData.mail = { enabled: false };' +
    'satData.metadata = { records: 5, missing: [' +
    ' { uuid: "m1", emitter: "' + PROV + '", receiver: "' + OWN + '" },' +
    ' { uuid: "m2", emitter: "' + PROV + '", receiver: "' + OWN + '" }], lastSeen: null };');
  const panel297 = vm.runInContext('hoyProactivo297Panel()', b.context);
  await asentar(40);
  const texto = textoDe(panel297);
  for (const bloque of ['paso', 'falta', 'propongo']) {
    const el = andar(panel297).find(x => x.dataset.hoy297Bloque === bloque);
    assert.ok(el, '(c) la tarjeta trae el bloque «' + bloque + '»');
  }
  assert.ok(texto.includes('Esto pasó') && texto.includes('Esto falta') && texto.includes('Esto te propongo'),
    '(c) los tres bloques se titulan como se contrataron');
  assert.ok(texto.includes('Llegó un CFDI nuevo de Proveedor de Prueba'),
    '(c) PASÓ sale de la actividad que Hoy ya consume');
  assert.ok(texto.includes('Correo de avisos'),
    '(c) FALTA sale de las piezas del foco (el correo sin configurar es del foco)');
  const bajarHoy = buscarBoton(panel297, 'Bajar ahora las 2 facturas nuevas detectadas');
  assert.ok(bajarHoy, '(c) con pendientes > 0, la propuesta (a) aparece con su conteo');
  assert.ok(buscarBoton(panel297, 'Consultar el Buzón'), '(c) la propuesta (b) «Consultar el Buzón» está');
  assert.ok(buscarBoton(panel297, 'Revisar los avisos'), '(c) la propuesta (c) «Revisar los avisos» está');
  assert.ok(buscarBoton(panel297, 'Generar el cierre del mes'), '(c) la propuesta (d) del cierre está');
  assert.ok(texto.includes('te lleva a Cierre y reportes'),
    '(c) la (d) dice en llano que navega a Cierre (su botón vive en su panel)');
  b.fetchLog.length = 0;
  await bajarHoy.onclick();
  await esperar(80);
  const run = b.fetchLog.find(l => l.method === 'POST' && l.target.includes('/api/portal-cfdi/run'));
  assert.ok(run, '(c) la propuesta (a) dispara el POST al portal');
  assert.deepEqual(JSON.parse(run.body), { rfc: OWN, allMissing: true, origen: 'hoy' },
    '(c) el POST es el contratado: { rfc, allMissing:true, origen:\'hoy\' }');
  assert.ok(textoDe(panel297).includes('Hecho: las facturas nuevas bajaron por el portal.'),
    '(c) la propuesta enseña su estado al terminar, en la propia tarjeta');
  /* Sin pendientes, la (a) no sale; los bloques no quedan vacíos. */
  const b0 = await bootCliente297({ responder: responderHoy });
  semillaBase(b0);
  const panel0 = vm.runInContext('hoyProactivo297Panel()', b0.context);
  await asentar(40);
  assert.ok(!buscarBoton(panel0, 'Bajar ahora las'),
    '(c) con pendientes = 0, la propuesta (a) NO aparece');
  assert.ok(textoDe(panel0).includes('Nada nuevo desde ayer'),
    '(c) PASÓ sin nada lo dice en una línea');
  console.log('OK 2.9.7-cliente · (c) — Hoy trae los tres bloques; la (a) solo con pendientes>0, dispara allMissing y enseña su estado.');
}

/* ================================================================
   (d) C2: la línea honesta se pinta con portalRescue sembrado
   en los trabajos de Descargar; su botón pide el periodo del
   trabajo. Y la hoja del rescate gana el mismo botón con el
   periodo del plan.
   ================================================================ */
{
  const b = await bootCliente297({ responder: async target => {
    if (target.includes('/api/portal-cfdi/run')) return { body: { ok: true } };
    if (target.includes('/api/portal-cfdi/state')) return { body: { configurado: true,
      progress: { running: false, ok: true, step: 'Terminado', steps: [] },
      runs: [{ ok: true }], quota: { used: 3, limit: 2000, remaining: 1997 } } };
    if (target.includes('/api/rescue')) return { body: { rfc: OWN, direction: 'received',
      startAt: '2026-08-01T00:00:00', endAt: '2026-08-31T23:59:59', folios: [], instructions: ['Paso único de juguete'] } };
    return undefined;
  } });
  semillaBase(b);
  await vm.runInContext("ensureLazyPart('descargas')", b.context);
  await asentar(40);
  vm.runInContext(
    'satData = { profiles: [], criteriaBook: [], mail: {}, jobs: [' +
    ' { id: "j1", rfc: "' + OWN + '", direction: "received", kind: "cfdi", status: "pending",' +
    '   periodStart: "2026-08-01", periodEnd: "2026-08-31", created: 1760000000000, due: 1760100000000,' +
    '   portalRescue: { pendientes: 3, recuperada: false } },' +
    ' { id: "j2", rfc: "' + OWN + '", direction: "received", kind: "cfdi", status: "pending",' +
    '   periodStart: "2026-09-01", periodEnd: "2026-09-30", created: 1760000000000, due: 1760100000000,' +
    '   portalRescue: { pendientes: 0, recuperada: true } } ] }; scope = "";', b.context);
  const target = b.context.document.createElement('div');
  /* fillSat pinta sobre el nodo que se le pasa: se invoca con el
     destino real a través del contexto. */
  b.context.__target297 = target;
  vm.runInContext('fillSat(__target297)', b.context);
  await asentar(40);
  const texto = textoDe(target);
  assert.ok(texto.includes('El SAT aún no entrega esta solicitud. Sus 3 documentos conocidos se pueden bajar ahora por el portal'),
    '(d) la línea de no recuperada se pinta con su conteo');
  assert.ok(texto.includes('Sus documentos ya entraron por el portal. La solicitud sigue abierta en el SAT (no se puede cancelar desde aquí) y PacoSAT ya no depende de ella.'),
    '(d) la línea de recuperada es la frase honesta literal');
  const lineas = andar(target).filter(el => el.dataset.portalRescue297 === '1');
  assert.equal(lineas.length, 2, '(d) hay una línea por trabajo con portalRescue');
  const bajar = andar(target).find(el => el.dataset.portalRescueBajar297 === '1');
  assert.ok(bajar, '(d) la línea de pendientes trae «Bajarlos ahora por el portal»');
  b.fetchLog.length = 0;
  await bajar.onclick();
  await esperar(80);
  const run = b.fetchLog.find(l => l.method === 'POST' && l.target.includes('/api/portal-cfdi/run'));
  assert.ok(run, '(d) el botón de la línea dispara el POST al portal');
  assert.deepEqual(JSON.parse(run.body), { rfc: OWN,
    period: { direction: 'received', startAt: '2026-08-01', endAt: '2026-08-31' }, origen: 'rescate' },
    '(d) el POST lleva el periodo DEL TRABAJO y origen rescate');
  /* La hoja del rescate, con el mismo botón y el periodo del plan. */
  await vm.runInContext('rescueDialog({ rfc: "' + OWN + '", direction: "received", startAt: "2026-08-01T00:00:00", endAt: "2026-08-31T23:59:59" })', b.context);
  await asentar(50);
  const bajarRescate = andar(b.campos()).find(el => el.dataset.portalRescueBajar297 === '1');
  assert.ok(bajarRescate, '(d) la hoja del rescate gana «Bajarlos ahora por el portal»');
  b.fetchLog.length = 0;
  await bajarRescate.onclick();
  await esperar(80);
  const run2 = b.fetchLog.find(l => l.method === 'POST' && l.target.includes('/api/portal-cfdi/run'));
  assert.ok(run2, '(d) el botón del rescate dispara el POST al portal');
  assert.deepEqual(JSON.parse(run2.body), { rfc: OWN,
    period: { direction: 'received', startAt: '2026-08-01T00:00:00', endAt: '2026-08-31T23:59:59' }, origen: 'rescate' },
    '(d) el POST del rescate lleva el periodo DEL PLAN y origen rescate');
  console.log('OK 2.9.7-cliente · (d) — C2 pinta su línea honesta con portalRescue sembrado y ambos botones piden su periodo por el portal.');
}
