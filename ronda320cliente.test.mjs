/* ================================================================
   Ronda 3.2.0 · cliente — la ronda visual en el navegador: el
   script temprano que aplica tema oscuro y letra grande ANTES
   del primer pintado desde su preferencia guardada, la letra
   grande en vivo (aplicarLetra320), la paleta ⌘K que se abre
   desde su puente (abrirCmdk320) trayendo la parte visual, y
   los medallones de contraparte con color estable por hash.

   Arnés: el de ronda310cliente (DOM falso + vm sobre el HTML
   construido), reutilizado tal cual; las pruebas son las de
   esta ronda.
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
const MFI = 'MFI6212158B4', IEAF = 'IEAF690704QQ9', TERCERO = 'XAXX010101000';
const AHORA = Date.now();

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
    this.className = '';
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
  after(kid) { if (kid instanceof FakeElement) this.children.push(kid); }
  insertAdjacentElement(_where, kid) { return kid; }
  insertAdjacentHTML() {}
  insertAdjacentText() {}
  cloneNode() { return new FakeElement(this.tagName); }
  replaceChildren(...kids) { this.children = kids.filter(kid => kid instanceof FakeElement); }
  remove() {}
  click() { if (typeof this.onclick === 'function') this.onclick(); }
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
/* Rutas programables: clave = substring de la URL; valor = cuerpo
   o función(url) → cuerpo. Se reescribe por prueba. */
const rutas310 = new Map();
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
    let matched = false;
    for (const [clave, valor] of rutas310)
      if (target.includes(clave)) { body = typeof valor === 'function' ? valor(target) : valor; matched = true; break; }
    if (!matched) {
      if (target.includes('storage/rev')) body = { rev: 1 };
      else if (target.includes('storage?')) body = [];
      else if (target.includes('/api/status')) body = {
        settings: { installName: 'PacoSAT', hasLogo: false },
        buildModified: null, cloudRevision: null, profiles: [], jobs: [], inbox: [], mail: {} };
    }
    return { ok: true, status: 200, headers: { get: () => 'application/json' },
      json: async () => body, text: async () => JSON.stringify(body), blob: async () => new Blob([]) };
  };
  const timer = (fn, ms, ...args) => { const t = setTimeout(fn, ms, ...args); t.unref?.(); return t; };
  const every = (fn, ms, ...args) => { const t = setInterval(fn, ms, ...args); t.unref?.(); return t; };
  const context = vm.createContext({
    console, document: documentStub,
    navigator: { onLine: true, userAgent: 'ronda310-test' },
    location: { href: 'http://127.0.0.1:43729/', search: '', reload: () => {} },
    localStorage: storageStub(), sessionStorage: storageStub(),
    fetch: fetchStub, setTimeout: timer, setInterval: every,
    clearTimeout, clearInterval, queueMicrotask,
    URL: BootURL, URLSearchParams, Blob, TextEncoder, TextDecoder, btoa, atob,
    crypto: webcrypto, DecompressionStream, Node: class FakeNode {}, IntersectionObserver: undefined,
    matchMedia: () => ({ matches: false, addEventListener: () => {}, addListener: () => {} }),
    Option: class extends FakeElement {},
    alert: () => {}, addEventListener: () => {}, removeEventListener: () => {},
    requestAnimationFrame: fn => timer(fn, 0)
  });
  context.window = context;
  context.self = context;
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
  return texto;
};
const buscarDataset = (el, clave, valor, salida = []) => {
  if (el.dataset && el.dataset[clave] === valor) salida.push(el);
  for (const hijo of el.children || []) buscarDataset(hijo, clave, valor, salida);
  return salida;
};
const dormir = async (ms = 40) => { await new Promise(r => setTimeout(r, ms)); };
async function bootCliente() {
  const context = makeBootContext();
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  vm.runInContext(script, context, { filename: 'Faro-Fiscal.html#script' });
  for (let i = 0; i < 12; i++) await new Promise(resolve => setTimeout(resolve, 0));
  return context;
}
const ponerGente = (context, gente, sd = {}) => {
  context.__gente = gente; context.__sd = sd;
  vm.runInContext('people = __gente; satData = __sd;', context);
};
const buscarClase320 = (el, fragmento, salida = []) => {
  if (typeof el.className === 'string' && el.className.includes(fragmento)) salida.push(el);
  for (const hijo of el.children || []) buscarClase320(hijo, fragmento, salida);
  return salida;
};

/* ===== (4/33) El script temprano: tema y letra antes de pintar ===== */
{
  const m = html.match(/<script data-320-tema>([\s\S]*?)<\/script>/);
  assert.ok(m, 'el HTML lleva su script temprano de tema, con atributo propio');
  const correr = store => {
    const dataset = {};
    const ctx = vm.createContext({
      localStorage: { getItem: k => (k in store ? store[k] : null) },
      document: { documentElement: { dataset } } });
    vm.runInContext(m[1], ctx);
    return dataset;
  };
  assert.deepEqual(correr({ 'pacosat-tema': 'oscuro', 'pacosat-letra': 'grande' }),
    { theme: 'dark', letra: 'grande' },
    'con las dos preferencias guardadas, el <html> nace oscuro y con letra grande');
  assert.deepEqual(correr({}), {},
    'sin preferencias, el <html> nace como siempre: claro y con su letra');
  assert.deepEqual(correr({ 'pacosat-tema': 'claro' }), {},
    '«claro» no deja atributo: el claro es la ausencia, no un valor');
  console.log('OK 3.2.0 · script temprano de tema/letra antes del primer pintado.');
}

/* ===== (33) La letra grande en vivo, desde su preferencia ===== */
{
  const context = await bootCliente();
  vm.runInContext("prefSet('pacosat-letra', 'grande'); aplicarLetra320();", context);
  assert.equal(context.document.documentElement.dataset.letra, 'grande',
    'activar la letra grande la refleja en el <html> al momento');
  assert.equal(vm.runInContext("prefGet('pacosat-letra')", context), 'grande',
    'y queda guardada en su preferencia para el próximo arranque');
  vm.runInContext("prefSet('pacosat-letra', 'normal'); aplicarLetra320();", context);
  assert.equal(context.document.documentElement.dataset.letra, undefined,
    'al volver a la normal, el atributo desaparece');
  console.log('OK 3.2.0 · letra grande en vivo y persistente.');
}

/* ===== (39) La paleta ⌘K se abre desde su puente ===== */
{
  const context = await bootCliente();
  assert.equal(vm.runInContext('typeof abrirCmdk320', context), 'function',
    'el puente de la paleta existe en el script principal');
  vm.runInContext('abrirCmdk320();', context);
  await dormir(150);
  assert.equal(vm.runInContext('typeof window.__pacosatCmdk320?.abrir', context), 'function',
    'la parte visual llega y expone su paleta');
  const pintada = buscarClase320(context.document.body, 'cmdk320');
  assert.ok(pintada.length >= 1, 'la paleta se pinta sobre la página');
  console.log('OK 3.2.0 · la paleta ⌘K abre trayendo su parte diferida.');
}

/* ===== (37/19) Medallones: color estable, paleta cerrada, inicial ===== */
{
  const context = await bootCliente();
  const c1 = vm.runInContext("medallonCp320('EMPRESA AAA', 'AAA010101AAA').dataset.color", context);
  const c2 = vm.runInContext("medallonCp320('EMPRESA AAA', 'AAA010101AAA').dataset.color", context);
  assert.equal(c1, c2, 'la contraparte conserva su color entre pintados');
  assert.ok(Number(c1) >= 0 && Number(c1) <= 7, 'el color sale de la paleta cerrada de ocho');
  assert.equal(vm.runInContext("medallonCp320('EMPRESA AAA', 'AAA010101AAA').textContent", context), 'E',
    'el medallón de contraparte lleva la inicial de su nombre');
  const m1 = vm.runInContext("medallon320('MFI6212158B4', 'MANO FIL SA').dataset.color", context);
  const m2 = vm.runInContext("medallon320('MFI6212158B4', 'MANO FIL SA').dataset.color", context);
  assert.equal(m1, m2, 'el medallón del RFC también es estable');
  assert.equal(vm.runInContext("medallon320('MFI6212158B4', 'MANO FIL SA').textContent", context), 'M',
    'y el del RFC lleva su inicial');
  console.log('OK 3.2.0 · medallones estables de contraparte y de RFC.');
}
