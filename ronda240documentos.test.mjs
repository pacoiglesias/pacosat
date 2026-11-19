/* ================================================================
   Ronda 2.4.0 · W3b — Documentos: Constancia y Opinión como
   TARJETAS PROTAGONISTAS (decisión de Paco, 17 nov 2026 15:16).
   Sobre el ARTEFACTO construido y con el arnés DOM de la casa
   (ronda200a/ronda232cliente):
   (a) la vista Documentos pinta las dos tarjetas protagonistas
       ANTES del listado del expediente;
   (b) con una copia archivada de juguete de fecha conocida, la
       tarjeta pinta esa fecha formateada en llano, en grande, y
       la Opinión enseña su sentido;
   (c) sin copia archivada, la tarjeta pinta el estado honesto
       «Aún no tienes una archivada» y no ofrece Ver/Descargar;
   (d) el botón «Bajar la de hoy» llama a la ruta real existente
       del flujo viejo — satApi('satdocs/run', { rfc, kind }) —
       y la fecha nueva queda pintada en la tarjeta al momento;
   (e) si la última bajada falló, el porqué en llano vive en la
       tarjeta con el modelo único de problema.
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

/* ===== Arnés DOM (el de ronda1291/ronda232cliente) ===== */
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
    navigator: { onLine: true, userAgent: 'ronda240documentos-test' },
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
async function bootCliente() {
  const context = makeBootContext();
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  vm.runInContext(script, context, { filename: 'Faro-Fiscal.html#script' });
  for (let i = 0; i < 12; i++) await new Promise(resolve => setTimeout(resolve, 0));
  return context;
}
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 0)); };
const heroesDe = raiz => buscar(raiz, e => String(e.className || '').split(' ').includes('doc-hero240'));
const botonDe = (raiz, texto) => buscar(raiz, e => e.tagName === 'BUTTON' && (e.textContent || '').trim() === texto)[0];

/* Perfil de juguete: la misma forma que satDocsOverview entrega
   (issuedAt en ms, ageDays, level, source, fileId y, en la
   Opinión, sentido/vigencia leídos del documento archivado). */
const FECHA_COPIA = Date.parse('2026-11-12T12:00:00Z');
const FECHA_NUEVA = Date.parse('2026-11-17T12:00:00Z');
const perfilBase = () => ({
  rfc: OWN,
  config: { enabled: false, day: 5, hour: 9, recipients: '' },
  constancia: { issuedAt: FECHA_COPIA, ageDays: 5, level: 'ok', source: 'auto', fileId: 'pdf:cons-juguete' },
  opinion: { issuedAt: FECHA_COPIA, ageDays: 5, level: 'ok', source: 'auto', fileId: 'pdf:op-juguete',
    sentido: 'positiva', vigencia: '' },
  progress: null, runs: [], lastError: '', lastFailure: null, lastAttempt: 0
});
function instalarSatApi(ctx, perfiles, alCorrer) {
  ctx.__llamadas240 = [];
  ctx.__perfiles240 = perfiles;
  ctx.__stub240 = async (path, data) => {
    ctx.__llamadas240.push([String(path), data || null]);
    if (path === 'satdocs') return { profiles: ctx.__perfiles240 };
    if (path === 'satdocs/run') {
      if (alCorrer) return alCorrer(data);
      return { results: { [data.kind]: { ok: true } }, profiles: ctx.__perfiles240 };
    }
    if (path === 'sat/trabajos') return { trabajos: [] };
    return {};
  };
  vm.runInContext('satApi = __stub240;', ctx);
}
function semilla(ctx) {
  ctx.Node = FakeElement;
  vm.runInContext(`scope = "${OWN}"; people = [{ id: "${OWN}", name: "Mano Fil, S.A." }]; documents = [];`, ctx);
}

/* ===== (a) las protagonistas van ANTES del listado ===== */
{
  const ctx = await bootCliente();
  semilla(ctx);
  instalarSatApi(ctx, [perfilBase()]);
  const parts = vm.runInContext('docsView()', ctx);
  await flush();
  const heroes = parts.flatMap(p => heroesDe(p));
  assert.equal(heroes.length, 2, '(a) la vista Documentos pinta exactamente dos tarjetas protagonistas');
  assert.equal(JSON.stringify(heroes.map(h => h.dataset.hero240)), '["constancia","opinion"]',
    '(a) primero la Constancia y al lado la Opinión');
  const texto = parts.map(textoDe).join('\n');
  const iHero = texto.indexOf('Constancia de situación fiscal');
  const iLista = texto.indexOf('El resto del expediente');
  assert.ok(iHero >= 0, '(a) la tarjeta de la Constancia se pinta en la vista');
  assert.ok(iLista > iHero, '(a) las protagonistas van ANTES del listado de documentos del expediente');
  assert.ok(texto.indexOf('Opinión de cumplimiento') < iLista,
    '(a) la tarjeta de la Opinión también va antes del listado');
  console.log('OK 2.4.0·W3b (a) — Documentos abre con Constancia y Opinión protagonistas, antes del listado.');
}

/* ===== (b) la fecha archivada, en llano y en grande; el sentido de la Opinión ===== */
{
  const ctx = await bootCliente();
  semilla(ctx);
  instalarSatApi(ctx, [perfilBase()]);
  const section = vm.runInContext('satDocsSection()', ctx);
  await flush();
  const heroes = heroesDe(section);
  assert.equal(heroes.length, 2, '(b) dos tarjetas protagonistas');
  const [cons, op] = heroes;
  const fechaCons = buscar(cons, e => String(e.className || '').split(' ').includes('doc-hero-fecha240'))[0];
  assert.ok(fechaCons, '(b) la Constancia tiene su bloque de fecha protagonista');
  assert.equal(fechaCons.tagName, 'STRONG', '(b) la fecha va en el bloque grande (total-hero > strong)');
  assert.equal((fechaCons.textContent || '').trim(), 'del 12 de noviembre de 2026',
    '(b) la fecha archivada se pinta formateada en llano: «del 12 de noviembre de 2026»');
  const fechaOp = buscar(op, e => String(e.className || '').split(' ').includes('doc-hero-fecha240'))[0];
  assert.equal((fechaOp.textContent || '').trim(), 'del 12 de noviembre de 2026',
    '(b) la Opinión pinta la fecha de su copia archivada igual');
  assert.ok(textoDe(op).includes('Sentido: POSITIVA'),
    '(b) la Opinión enseña el sentido que trae su copia archivada');
  assert.ok(botonDe(cons, 'Ver') && botonDe(cons, 'Descargar'),
    '(b) la copia archivada se ve y se descarga desde la propia tarjeta');
  assert.ok(botonDe(cons, 'Bajar la de hoy') && botonDe(op, 'Bajar la de hoy'),
    '(b) cada tarjeta lleva su botón primario «Bajar la de hoy»');
  console.log('OK 2.4.0·W3b (b) — fecha archivada en llano y en grande; sentido de la Opinión a la vista.');
}

/* ===== (c) sin copia: el estado honesto ===== */
{
  const ctx = await bootCliente();
  semilla(ctx);
  const sinCopia = perfilBase();
  sinCopia.constancia = null;
  sinCopia.opinion = null;
  instalarSatApi(ctx, [sinCopia]);
  const section = vm.runInContext('satDocsSection()', ctx);
  await flush();
  const heroes = heroesDe(section);
  assert.equal(heroes.length, 2, '(c) las tarjetas existen aunque no haya copias');
  for (const hero of heroes) {
    const fecha = buscar(hero, e => String(e.className || '').split(' ').includes('doc-hero-fecha240'))[0];
    assert.equal((fecha.textContent || '').trim(), 'Aún no tienes una archivada',
      '(c) sin copia se dice tal cual: «Aún no tienes una archivada»');
    assert.ok(!botonDe(hero, 'Ver') && !botonDe(hero, 'Descargar'),
      '(c) sin copia no se promete ni Ver ni Descargar');
    assert.ok(botonDe(hero, 'Bajar la de hoy'), '(c) el gesto de bajarla sí está, en un toque');
  }
  console.log('OK 2.4.0·W3b (c) — sin copia, estado honesto y ningún botón que prometa un papel que no existe.');
}

/* ===== (d) «Bajar la de hoy» llama a la ruta real y la fecha nueva se pinta ===== */
{
  const ctx = await bootCliente();
  semilla(ctx);
  instalarSatApi(ctx, [perfilBase()], data => {
    const nuevo = perfilBase();
    nuevo.constancia = { ...nuevo.constancia, issuedAt: FECHA_NUEVA, ageDays: 0 };
    ctx.__perfiles240 = [nuevo];
    return { results: { [data.kind]: { ok: true } }, profiles: [nuevo] };
  });
  const section = vm.runInContext('satDocsSection()', ctx);
  await flush();
  const cons = heroesDe(section)[0];
  const bajar = botonDe(cons, 'Bajar la de hoy');
  assert.ok(bajar, '(d) el botón existe en la tarjeta de la Constancia');
  await bajar.onclick();
  await flush();
  const llamada = ctx.__llamadas240.find(([path]) => path === 'satdocs/run');
  assert.ok(llamada, '(d) pulsar «Bajar la de hoy» despacha la bajada');
  assert.equal(JSON.stringify(llamada[1]), JSON.stringify({ rfc: OWN, kind: 'constancia' }),
    '(d) la ruta es la real del flujo viejo: satdocs/run con { rfc, kind } — la misma de satQuickRunDoc');
  const consNueva = heroesDe(section)[0];
  const fechaNueva = buscar(consNueva, e => String(e.className || '').split(' ').includes('doc-hero-fecha240'))[0];
  assert.equal((fechaNueva.textContent || '').trim(), 'del 17 de noviembre de 2026',
    '(d) la copia nueva sustituye a la archivada y su fecha nueva queda pintada en la tarjeta');
  console.log('OK 2.4.0·W3b (d) — «Bajar la de hoy» va por satdocs/run {rfc, kind} y la fecha nueva se pinta al momento.');
}

/* ===== (e) el fallo vive en la tarjeta, en llano ===== */
{
  const ctx = await bootCliente();
  semilla(ctx);
  const fallado = perfilBase();
  fallado.progress = { kind: 'constancia', running: false, ok: false, step: 'El portal no respondió', steps: [] };
  fallado.lastFailure = { kind: 'portal-caido', error: 'portal de juguete caído', at: FECHA_COPIA };
  instalarSatApi(ctx, [fallado]);
  const section = vm.runInContext('satDocsSection()', ctx);
  await flush();
  const cons = heroesDe(section)[0];
  const texto = textoDe(cons);
  assert.ok(texto.includes('El portal del SAT no respondió'),
    '(e) la tarjeta cuenta el fallo con el modelo único: es del SAT, no del usuario');
  assert.ok(texto.includes('Qué pasa ahora'),
    '(e) la tarjeta dice qué pasa ahora (el gesto o el reintento solo)');
  const op = heroesDe(section)[1];
  assert.ok(!textoDe(op).includes('El portal del SAT no respondió'),
    '(e) el fallo de la Constancia no contamina la tarjeta de la Opinión');
  console.log('OK 2.4.0·W3b (e) — el porqué del fallo, en llano y solo en su tarjeta.');
}
