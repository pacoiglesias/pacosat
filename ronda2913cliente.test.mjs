import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { webcrypto } from 'node:crypto';
import * as vm from 'node:vm';

/* ================================================================

/* ================================================================
   Ronda 2.9.13 · CLIENTE — los criterios de verdad de la ronda:
   (a) el «ya se pidió» DESDE LA TARJETA, con la ventana cubierta
       y con la ventana retenida (el plan del servidor contesta lo
       mismo en ambos sabores: consta pedida; la tarjeta enseña el
       aviso llano y solo envía la variante de 1 segundo, por
       sentido — jamás 'both', jamás el criterio exacto);
   (b) el encabezado de la puerta se refresca EN EL SITIO tras la
       prueba (puertaRefrescarEnSitio2913): sin cambiar de panel,
       la línea de la puerta enseña el estado nuevo;
   (c) el barrido de textos técnicos del punto A6: ninguno queda
       en el cliente ni en los textos visibles del servidor;
   y A2: Cancelar tras un error devuelve la tarjeta a su estado
   limpio (ni el mensaje ni el propio botón quedan colgados).

   Contra la 2.9.12 esta suite corre en ROJO: la tarjeta enviaba
   direction:'both' y el servidor contestaba «Dirección
   inválida.»; Cancelar no limpiaba tras un error; el encabezado
   no se refrescaba; y los textos del punto 6 existían.
   ================================================================ */
const AQUI = dirname(fileURLToPath(import.meta.url));
const OWN = 'AAA010101AAA';
const CIE = 'CIE010101AA1';
const SIN = 'SIN010101AA1';
const FIR = 'FIR010101AA1';

/* ================================================================
   Arnés DOM de la casa (el de ronda297cliente), con
   respondedor sembrado por ruta.
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

async function bootCliente2912(opciones = {}) {
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
    navigator: { onLine: true, userAgent: 'ronda2912descarga-test' },
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
    dialogo: () => context.document.getElementById('dialog'),
    textoCampos: () => textoDe(context.document.getElementById('fields')) };
}
/* Siembra base: alcance, personas y satData con los perfiles
   que cada bloque pida; la pantalla de descargas se pinta y se
   devuelve su raíz con la tarjeta localizada. */
async function pintarDescargas2912(b, { scopeRfc, perfiles, extra = '' }) {
  vm.runInContext(
    'scope = ' + JSON.stringify(scopeRfc) + ';' +
    'people = [' + [OWN, CIE, SIN, FIR].map(r => '{ id: "' + r + '", name: "Empresa ' + r + '" }').join(',') + '];' +
    'invoices = []; documents = []; activity = [];' +
    'satData = { profiles: ' + JSON.stringify(perfiles) + ', jobs: [], criteriaBook: [], mail: {},' +
    ' puerta: {}, ejecutor: {}, metadata: { records: 0, missing: [], lastSeen: null },' +
    ' coverage: { groups: [], gaps: [], days: {}, records: [] } };' + extra, b.context);
  await vm.runInContext("ensureLazyPart('descargas')", b.context);
  /* El knob de sondeo vive en la parte perezosa: se siembra
     DESPUÉS de cargarla (una `let` de la parte manda sobre la
     propiedad global si se asigna antes). */
  vm.runInContext('descargaPollMs2912 = 5;', b.context);
  await asentar(40);
  const els = vm.runInContext('satDownloadScreen()', b.context);
  const raiz = b.context.document.createElement('div');
  raiz.append(...els);
  await asentar(40);
  const tarjeta = els[0];
  return { raiz, els, tarjeta };
}
const enTarjeta = (tarjeta, dataset, valor) =>
  andar(tarjeta).find(el => el.dataset[dataset] === valor);

/* ================================================================
   C · BARRIDO A6 (criterio de verdad c): ningún texto técnico
   de la lista del punto 6 queda en el cliente, y los textos
   visibles del servidor (Registro, Cierre) tampoco.
   ================================================================ */
{
  const servidor = readFileSync(join(AQUI, 'local-server.mjs'), 'utf8');
  const satUi = readFileSync(join(AQUI, 'sat-ui.part'), 'utf8');
  const prohibidosCliente = ['en esta ráfaga', 'Planificador 5002', 'Avisos archivadas',
    'generalUn toque', 'lote lote-', '(held=1)', '(held—1)'];
  for (const texto of prohibidosCliente)
    assert.ok(!htmlCliente.includes(texto),
      'C: el cliente ya no enseña «' + texto + '»');
  for (const texto of ['quedó retenida (held=1)', '(meta: cero)', 'lote lote-', 'CFDI PUE con complemento'])
    assert.ok(!servidor.includes(texto),
      'C: los textos visibles del servidor ya no dicen «' + texto + '»');
  assert.ok(htmlCliente.includes('Avisos archivados'), 'C: la errata de Archivo quedó corregida');
  assert.ok(satUi.includes('Revisión previa'), 'C: la hoja clásica nombra el paso sin el código 5002');
  console.log('OK 2.9.13-cliente · C — barrido A6: ningún texto técnico de la lista queda a la vista.');
}

/* ================================================================
   A · «YA SE PIDIÓ» DESDE LA TARJETA (criterio de verdad a):
   sabor 1 — la ventana consta pedida en AMBOS sentidos (cubierta
   por trabajos terminados o retenida por trabajos vivos: el plan
   contesta yaPedida igual): la tarjeta enseña el aviso llano y
   el envío son DOS variantes (una por sentido), cada una con
   shiftEnd=1; el criterio exacto no se reenvía jamás y 'both'
   no viaja nunca (esa era la causa del «Dirección inválida.»).
   ================================================================ */
{
  const b = await bootCliente2912({ responder: async target => {
    if (target.includes('/api/plan'))
      return { body: { yaPedida: { at: 1760000000000, requestId: 'r-previa' } } };
    if (target.includes('/api/request')) return { body: { profiles: [], jobs: [], criteriaBook: [],
      mail: {}, puerta: {}, metadata: {}, coverage: {} } };
    if (target.includes('/api/status')) return { body: { profiles: [], jobs: [], criteriaBook: [],
      mail: {}, puerta: {}, metadata: {}, coverage: {} } };
    if (target.includes('/api/ciec')) return { body: { profiles: [] } };
    return undefined;
  } });
  const { tarjeta } = await pintarDescargas2912(b, { scopeRfc: OWN,
    perfiles: [{ rfc: OWN, accessMethod: 'efirma', efirmaStored: true, unlocked: true, ciecStored: false }] });
  await esperar(60);
  const aviso = enTarjeta(tarjeta, 'dl2912PlanAviso', '1');
  assert.ok(aviso && !aviso.hidden, 'A: el aviso de «ya se pidió» vive en la tarjeta');
  assert.ok(textoDe(aviso).includes('ya se pidió'), 'A: el aviso lo dice en llano');
  const go = enTarjeta(tarjeta, 'dl2912Go', '1');
  b.fetchLog.length = 0;
  await go.onclick();
  await asentar(40);
  const reqs = b.fetchLog.filter(l => l.method === 'POST' && l.target.includes('/api/request'));
  assert.equal(reqs.length, 2, 'A: «Emitidos y recibidos» son DOS envíos, uno por sentido');
  const cuerpos = reqs.map(r => JSON.parse(r.body));
  assert.deepEqual(cuerpos.map(c => c.direction).sort(), ['issued', 'received'],
    'A: los sentidos viajan por separado; «both» no se envía nunca (la causa raíz del «Dirección inválida.»)');
  for (const c of cuerpos)
    assert.equal(c.shiftEnd, 1, 'A: cada sentido sale como variante de 1 segundo, nunca el criterio exacto');
  console.log('OK 2.9.13-cliente · A — «ya se pidió» desde la tarjeta: aviso llano y variante por sentido.');
}

/* ================================================================
   A-bis · LA VARIANTE ES POR SENTIDO: si solo un sentido consta
   pedido, solo ese sale desplazado; el otro va con su criterio
   exacto, que nunca se ha enviado.
   ================================================================ */
{
  const b = await bootCliente2912({ responder: async (target, init) => {
    if (target.includes('/api/plan')) {
      const cuerpo = JSON.parse(init.body || '{}');
      return { body: cuerpo.direction === 'issued'
        ? { yaPedida: { at: 1760000000000, requestId: 'r-issued' } } : { ventanas: [] } };
    }
    if (target.includes('/api/request')) return { body: { profiles: [], jobs: [], criteriaBook: [],
      mail: {}, puerta: {}, metadata: {}, coverage: {} } };
    if (target.includes('/api/status')) return { body: { profiles: [], jobs: [], criteriaBook: [],
      mail: {}, puerta: {}, metadata: {}, coverage: {} } };
    if (target.includes('/api/ciec')) return { body: { profiles: [] } };
    return undefined;
  } });
  const { tarjeta } = await pintarDescargas2912(b, { scopeRfc: OWN,
    perfiles: [{ rfc: OWN, accessMethod: 'efirma', efirmaStored: true, unlocked: true, ciecStored: false }] });
  await esperar(60);
  const go = enTarjeta(tarjeta, 'dl2912Go', '1');
  b.fetchLog.length = 0;
  await go.onclick();
  await asentar(40);
  const cuerpos = b.fetchLog.filter(l => l.method === 'POST' && l.target.includes('/api/request'))
    .map(r => JSON.parse(r.body));
  assert.equal(cuerpos.length, 2, 'A-bis: dos envíos, uno por sentido');
  const recibidos = cuerpos.find(c => c.direction === 'received');
  const emitidos = cuerpos.find(c => c.direction === 'issued');
  assert.ok(recibidos && !('shiftEnd' in recibidos),
    'A-bis: recibidos sale con su criterio exacto (nunca se había pedido)');
  assert.equal(emitidos?.shiftEnd, 1, 'A-bis: emitidos sale como variante (constaba pedido)');
  console.log('OK 2.9.13-cliente · A-bis — la variante es por sentido: solo se desplaza el que consta pedido.');
}

/* ================================================================
   A2 · CANCELAR LIMPIA: tras un error de envío, Cancelar deja
   la tarjeta en su estado limpio (progreso oculto, sin fase ni
   detalle, sin el propio botón colgado).
   ================================================================ */
{
  const b = await bootCliente2912({ responder: async target => {
    if (target.includes('/api/plan')) return { body: { ventanas: [] } };
    if (target.includes('/api/request'))
      return { status: 500, body: { error: 'El SAT no contestó.' } };
    if (target.includes('/api/status')) return { body: { profiles: [], jobs: [], criteriaBook: [],
      mail: {}, puerta: {}, metadata: {}, coverage: {} } };
    if (target.includes('/api/ciec')) return { body: { profiles: [] } };
    return undefined;
  } });
  const { tarjeta } = await pintarDescargas2912(b, { scopeRfc: OWN,
    perfiles: [{ rfc: OWN, accessMethod: 'efirma', efirmaStored: true, unlocked: true, ciecStored: false }] });
  const go = enTarjeta(tarjeta, 'dl2912Go', '1');
  await go.onclick();
  await asentar(40);
  const fase = enTarjeta(tarjeta, 'dl2912Phase', '1');
  assert.equal(fase.textContent, 'No se pudo descargar', 'A2: el error se enseña primero (estado de partida)');
  const cancelar = enTarjeta(tarjeta, 'dl2912Cancel', '1');
  assert.ok(cancelar, 'A2: el Cancelar sigue en la tarjeta tras el error');
  cancelar.onclick();
  await asentar(20);
  const prog = enTarjeta(tarjeta, 'dl2912Progress', '1');
  assert.ok(prog.hidden, 'A2: tras cancelar, el progreso se oculta');
  assert.equal(fase.textContent, '', 'A2: la fase queda vacía');
  assert.equal(enTarjeta(tarjeta, 'dl2912Detail', '1').textContent, '', 'A2: el detalle del error queda vacío');
  assert.ok(andar(prog).includes(cancelar),
    'A2: el propio Cancelar vive dentro del bloque de progreso que acaba de ocultarse: se retira con él');
  assert.ok(!go.disabled, 'A2: el botón Descargar vuelve a estar disponible');
  console.log('OK 2.9.13-cliente · A2 — Cancelar devuelve la tarjeta a su estado limpio, también tras un error.');
}

/* ================================================================
   B · LA PUERTA SE REFRESCA EN EL SITIO (criterio de verdad b):
   con el encabezado pintado en «no abre», la relectura del
   estado tras la prueba lo deja en «abre» SIN cambiar de panel:
   la misma línea del encabezado cambia su texto.
   ================================================================ */
{
  const AHORA_B = Date.now();
  let puertaServidor = { ok: false, probada: AHORA_B, ultimoExito: 0, errorKind: 'portal-caido' };
  const b = await bootCliente2912({ responder: async target => {
    if (target.includes('/api/status')) return { body: { settings: { installName: 'PacoSAT', hasLogo: false },
      profiles: [], jobs: [], inbox: [], mail: {}, puerta: { [OWN]: puertaServidor },
      ejecutor: {}, paseo: 'nas', backupHealth: { enabled: false } } };
    return undefined;
  } });
  vm.runInContext(
    'page = "invoices"; scope = ' + JSON.stringify(OWN) + '; people = [{ id: ' + JSON.stringify(OWN) + ', name: "Empresa" }];' +
    'satData = { profiles: [], jobs: [], criteriaBook: [], mail: {}, paseo: "nas", puerta: { ' + JSON.stringify(OWN) +
    ': { ok: false, probada: ' + AHORA_B + ', ultimoExito: 0, errorKind: "portal-caido" } }, ejecutor: {},' +
    ' metadata: { records: 0, missing: [], lastSeen: null }, coverage: { groups: [], gaps: [], days: {}, records: [] } };',
    b.context);
  await asentar(20);
  vm.runInContext('senalesBarra1311()', b.context);
  const txtEl = b.context.document.getElementById('puerta-txt');
  const antes = txtEl.textContent;
  assert.ok(antes.includes('no abre'), 'B: el encabezado parte de la foto vieja («no abre»), como en la auditoría');
  puertaServidor = { ok: true, probada: AHORA_B + 60000, ultimoExito: AHORA_B + 60000 };
  await vm.runInContext('puertaRefrescarEnSitio2913(' + JSON.stringify(OWN) + ')', b.context);
  await asentar(20);
  const despues = b.context.document.getElementById('puerta-txt').textContent;
  assert.notEqual(despues, antes, 'B: la línea del encabezado cambió en el sitio, sin cambiar de panel');
  assert.ok(!/no abre/i.test(despues), 'B: ya no dice «no abre»: enseña el estado nuevo');
  console.log('OK 2.9.13-cliente · B — el encabezado de la puerta se refresca en el sitio tras la prueba.');
}
