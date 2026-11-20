import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { webcrypto } from 'node:crypto';
import * as vm from 'node:vm';

/* ================================================================

/* ================================================================
   Ronda 2.9.14 · CLIENTE — el ground-truth de la ronda: CON LA
   FORMA REAL DE LOS DATOS, LA TARJETA NO ENVÍA.

   El plan del servidor contesta por COBERTURA (la unión de las
   ventanas terminadas y vivas de cada sentido) y la tarjeta
   decide con ella:
   (FULL) Los dos sentidos cubiertos → pulsar Descargar NO
       produce ningún POST /api/request: la tarjeta contesta
       en su resultado «Ya se pidió… No se envió nada al SAT.»
       (La 2.9.13, con esta misma ventana cubierta por un
       mosaico, envió dos solicitudes que el SAT devolvió como
       duplicadas: esta es la conducta que aquí se caza.)
   (PARCIAL) Recibidos cubierto a medias y emitidos entero →
       UN solo envío: el resto de recibidos (desde el día
       siguiente al tramo cubierto hasta el fin pedido), sin
       shiftEnd (es una ventana nueva, no una variante), y el
       aviso de la tarjeta dice qué parte ya consta y qué
       parte se pide; el botón se nombra «Pedir solo lo que
       falta».
   (NADA) Sin cobertura en ningún sentido → paridad clásica:
       dos envíos, uno por sentido, con la ventana exacta y
       sin variante.

   Contra la 2.9.13 esta suite corre en ROJO: el plan no traía
   cobertura, la tarjeta no la leía y el caso FULL enviaba.
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
  /* RE-BASE 3.0 (Bloque B): la pantalla abre con «Ponerme
     al día» (els[0]); la tarjeta del periodo se localiza por
     su dataset, no por posición. */
  const tarjeta = els.find(el => el.dataset && el.dataset.dl2912 === 'card') || els[0];
  return { raiz, els, tarjeta };
}
const enTarjeta = (tarjeta, dataset, valor) =>
  andar(tarjeta).find(el => el.dataset[dataset] === valor);

const PERFIL_EFIRMA = [{ rfc: OWN, accessMethod: 'efirma', efirmaStored: true, unlocked: true, ciecStored: false }];
const VACIO_SAT = { profiles: [], jobs: [], criteriaBook: [], mail: {}, puerta: {}, metadata: {}, coverage: {} };
const fechasDe = tarjeta => andar(tarjeta)
  .filter(el => el.tagName === 'INPUT' && /^\d{4}-\d{2}-\d{2}$/.test(el.value || ''))
  .map(el => el.value);

/* ================================================================
   FULL · LOS DOS SENTIDOS CUBIERTOS → CERO ENVÍOS.
   ================================================================ */
{
  const b = await bootCliente2912({ responder: async (target, init) => {
    if (target.includes('/api/plan')) {
      const cuerpo = JSON.parse(init.body || '{}');
      return { body: { cobertura: { completa: true,
        cubierto: [{ start: cuerpo.start, end: cuerpo.end }], restos: [] } } };
    }
    if (target.includes('/api/request')) return { body: VACIO_SAT };
    if (target.includes('/api/status')) return { body: VACIO_SAT };
    if (target.includes('/api/ciec')) return { body: { profiles: [] } };
    return undefined;
  } });
  const { tarjeta } = await pintarDescargas2912(b, { scopeRfc: OWN, perfiles: PERFIL_EFIRMA });
  await esperar(60);
  const aviso = enTarjeta(tarjeta, 'dl2912PlanAviso', '1');
  assert.ok(aviso && !aviso.hidden, 'FULL: el aviso de cobertura vive en la tarjeta');
  assert.ok(textoDe(aviso).includes('ya está cubierta'), 'FULL: el aviso dice que la ventana ya está cubierta');
  const go = enTarjeta(tarjeta, 'dl2912Go', '1');
  b.fetchLog.length = 0;
  await go.onclick();
  await asentar(40);
  const reqs = b.fetchLog.filter(l => l.method === 'POST' && l.target.includes('/api/request'));
  assert.equal(reqs.length, 0, 'FULL: cubierta entera, la tarjeta NO envía nada al SAT (el ground-truth de la ronda)');
  const resultado = enTarjeta(tarjeta, 'dl2912Result', '1');
  assert.ok(resultado && !resultado.hidden, 'FULL: la respuesta queda en el resultado de la tarjeta');
  const texto = textoDe(resultado);
  assert.ok(texto.includes('Ya se pidió'), 'FULL: la respuesta llana dice «Ya se pidió»');
  assert.ok(texto.includes('No se envió nada al SAT'), 'FULL: y dice que no se envió nada');
  console.log('OK 2.9.14-cliente · FULL — los dos sentidos cubiertos: cero envíos y respuesta llana en la tarjeta.');
}

/* ================================================================
   PARCIAL · SOLO SE ENVÍA EL RESTO.
   Recibidos: cubierto 01→08, resto 09→fin. Emitidos: entero.
   ================================================================ */
{
  const b = await bootCliente2912({ responder: async (target, init) => {
    if (target.includes('/api/plan')) {
      const cuerpo = JSON.parse(init.body || '{}');
      if (cuerpo.direction === 'received')
        return { body: { cobertura: { completa: false,
          cubierto: [{ start: cuerpo.start, end: '2026-11-08' }],
          restos: [{ start: '2026-11-09', end: cuerpo.end }] } } };
      return { body: { cobertura: { completa: true,
        cubierto: [{ start: cuerpo.start, end: cuerpo.end }], restos: [] } } };
    }
    if (target.includes('/api/request')) return { body: VACIO_SAT };
    if (target.includes('/api/status')) return { body: VACIO_SAT };
    if (target.includes('/api/ciec')) return { body: { profiles: [] } };
    return undefined;
  } });
  const { tarjeta } = await pintarDescargas2912(b, { scopeRfc: OWN, perfiles: PERFIL_EFIRMA });
  await esperar(60);
  const aviso = enTarjeta(tarjeta, 'dl2912PlanAviso', '1');
  assert.ok(aviso && !aviso.hidden, 'PARCIAL: el aviso vive en la tarjeta');
  const textoAviso = textoDe(aviso);
  assert.ok(textoAviso.includes('ya consta'), 'PARCIAL: el aviso dice qué parte ya consta');
  assert.ok(textoAviso.includes('se pedirá solo'), 'PARCIAL: y qué parte se pedirá');
  const go = enTarjeta(tarjeta, 'dl2912Go', '1');
  assert.equal((go.textContent || '').trim(), 'Pedir solo lo que falta',
    'PARCIAL: el botón se nombra por lo que hará');
  const [, finPedido] = fechasDe(tarjeta);
  b.fetchLog.length = 0;
  await go.onclick();
  await asentar(40);
  const reqs = b.fetchLog.filter(l => l.method === 'POST' && l.target.includes('/api/request'));
  assert.equal(reqs.length, 1, 'PARCIAL: UN solo envío — el sentido cubierto no envía y el parcial envía solo su resto');
  const cuerpo = JSON.parse(reqs[0].body);
  assert.equal(cuerpo.direction, 'received', 'PARCIAL: el envío es del sentido parcial');
  assert.equal(cuerpo.start, '2026-11-09', 'PARCIAL: el resto empieza el día siguiente al tramo cubierto');
  assert.equal(cuerpo.end, finPedido, 'PARCIAL: el resto llega hasta el fin pedido');
  assert.ok(!('shiftEnd' in cuerpo), 'PARCIAL: el resto es una ventana nueva — sin variante de 1 segundo');
  console.log('OK 2.9.14-cliente · PARCIAL — solo se envía el resto, sin variante, y la tarjeta lo dijo antes.');
}

/* ================================================================
   NADA · SIN COBERTURA → PARIDAD CLÁSICA.
   ================================================================ */
{
  const b = await bootCliente2912({ responder: async target => {
    if (target.includes('/api/plan')) return { body: {} };
    if (target.includes('/api/request')) return { body: VACIO_SAT };
    if (target.includes('/api/status')) return { body: VACIO_SAT };
    if (target.includes('/api/ciec')) return { body: { profiles: [] } };
    return undefined;
  } });
  const { tarjeta } = await pintarDescargas2912(b, { scopeRfc: OWN, perfiles: PERFIL_EFIRMA });
  await esperar(60);
  const [inicio, fin] = fechasDe(tarjeta);
  const go = enTarjeta(tarjeta, 'dl2912Go', '1');
  b.fetchLog.length = 0;
  await go.onclick();
  await asentar(40);
  const reqs = b.fetchLog.filter(l => l.method === 'POST' && l.target.includes('/api/request'));
  assert.equal(reqs.length, 2, 'NADA: sin cobertura, los dos envíos de siempre');
  const cuerpos = reqs.map(r => JSON.parse(r.body));
  assert.deepEqual(cuerpos.map(c => c.direction).sort(), ['issued', 'received'],
    'NADA: un envío por sentido, como siempre');
  for (const c of cuerpos) {
    assert.equal(c.start, inicio, 'NADA: la ventana exacta pedida');
    assert.equal(c.end, fin, 'NADA: la ventana exacta pedida');
    assert.ok(!('shiftEnd' in c), 'NADA: sin variante cuando nada consta');
  }
  console.log('OK 2.9.14-cliente · NADA — sin cobertura, la conducta de siempre, intacta.');
}
