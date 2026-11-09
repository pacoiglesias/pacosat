/* Regresión 1.7.2 — el arranque no puede morir por zona muerta (TDZ).
   Hasta la 1.7.1 la secuencia de arranque vivía al final de
   workflows.part (5.º fragmento del bloque <script> generado): el
   primer render() llamaba a applySettings(), que lee satData/satToken,
   declarados con let en sat-ui.part (6.º fragmento, DESPUÉS). typeof
   sobre un let en TDZ lanza ReferenceError, la excepción abortaba el
   resto del bloque entero — beginReadiness() nunca corría, las
   declaraciones de sat-ui.part y posteriores jamás se ejecutaban — y
   la app nacía rota (Resumen en esqueleto, Centro SAT en blanco).
   Esta suite extrae el bloque <script> REAL del HTML generado (el
   orden exacto que recibe el navegador) y lo ejecuta en una VM con un
   DOM mínimo: afirma que la carga inicial completa sin excepciones,
   que la preparación del almacenamiento corre y termina, y que el
   refresh() de esa preparación no muere por TDZ. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import { webcrypto } from 'node:crypto';
import { URL as NodeURL } from 'node:url';

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
  return {
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: key => map.delete(key),
    clear: () => map.clear()
  };
};

function makeBootContext(server) {
  const byId = new Map();
  const metas = server
    ? { 'meta[name="pacosat-token"]': { content: 'token-de-prueba' }, 'meta[name="pacosat-cloud"]': { content: '1' } }
    : {};
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
  const fetchCalls = [];
  const fetchStub = async url => {
    const target = String(url);
    fetchCalls.push(target);
    let body = {};
    if (target.includes('storage/rev')) body = { rev: 1 };
    else if (target.includes('storage?')) body = [];
    else if (target.includes('/api/status')) body = { profiles: [], jobs: [], inbox: [], mail: {} };
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => body,
      text: async () => JSON.stringify(body),
      blob: async () => new Blob([])
    };
  };
  const timer = (fn, ms, ...args) => { const t = setTimeout(fn, ms, ...args); t.unref?.(); return t; };
  const every = (fn, ms, ...args) => { const t = setInterval(fn, ms, ...args); t.unref?.(); return t; };
  const context = vm.createContext({
    console,
    document: documentStub,
    navigator: { onLine: true, userAgent: 'boot-test' },
    location: { href: 'http://127.0.0.1:43729/', search: '', reload: () => {} },
    localStorage: storageStub(),
    sessionStorage: storageStub(),
    fetch: fetchStub,
    setTimeout: timer,
    setInterval: every,
    clearTimeout,
    clearInterval,
    queueMicrotask,
    URL: BootURL,
    URLSearchParams,
    Blob,
    TextEncoder,
    TextDecoder,
    btoa,
    atob,
    crypto: webcrypto,
    DecompressionStream,
    matchMedia: () => ({ matches: false, addEventListener: () => {}, addListener: () => {} }),
    Option: class extends FakeElement {},
    alert: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    requestAnimationFrame: fn => timer(fn, 0)
  });
  context.window = context;
  context.self = context;
  return { context, byId, fetchCalls };
}

const generatedScript = () => {
  const html = fs.readFileSync('Faro-Fiscal.html', 'utf8');
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(match, 'el HTML generado trae su bloque <script>');
  return match[1];
};

const settle = async () => {
  for (let i = 0; i < 12; i++) await new Promise(resolve => setTimeout(resolve, 0));
};

test('arranque en modo servidor: el bloque generado carga entero, la preparación termina y refresh() no muere por TDZ', async () => {
  const { context, byId, fetchCalls } = makeBootContext(true);
  /* Con el defecto, esta línea lanzaba ReferenceError (TDZ de satData)
     a mitad del bloque y nada de lo posterior se ejecutaba. */
  vm.runInContext(generatedScript(), context, { filename: 'Faro-Fiscal.html#script' });
  /* Las declaraciones posteriores al arranque existen y valen lo suyo. */
  assert.equal(vm.runInContext('typeof satData', context), 'object');
  assert.equal(vm.runInContext('satToken', context), 'token-de-prueba');
  assert.equal(vm.runInContext('typeof startup', context), 'object');
  /* El render inicial pintó el Resumen (no quedó el esqueleto). */
  assert.ok(byId.get('body').children.length > 0, 'el render inicial dejó contenido en #body');
  /* beginReadiness() corrió en la carga y su refresh() terminó: la
     promesa readiness se resuelve y ready queda en true. Si refresh()
     muriera por TDZ, readiness rechazaría con ReferenceError. */
  const readiness = vm.runInContext('readiness', context);
  assert.ok(readiness && typeof readiness.then === 'function', 'beginReadiness() dejó una promesa readiness');
  await readiness;
  await settle();
  assert.equal(vm.runInContext('ready', context), true);
  /* refresh() leyó las cuatro tiendas por la vía del servidor. */
  const storeReads = fetchCalls.filter(url => url.includes('/api/storage')).length;
  assert.ok(storeReads >= 4, `refresh() leyó las tiendas (llamadas a /api/storage: ${storeReads})`);
});

test('arranque en modo local: el bloque generado carga entero y la preparación se resuelve sin excepciones', async () => {
  const { context, byId } = makeBootContext(false);
  vm.runInContext(generatedScript(), context, { filename: 'Faro-Fiscal.html#script' });
  assert.equal(vm.runInContext('typeof satData', context), 'object');
  assert.equal(vm.runInContext('satToken', context), undefined);
  assert.ok(byId.get('body').children.length > 0, 'el render inicial dejó contenido en #body');
  /* Sin IndexedDB en la VM la apertura local falla y readiness se
     resuelve en falso (el aviso de almacenamiento es el camino
     previsto); lo que no puede pasar es que la carga muera o que la
     promesa quede rechazada por un TDZ. */
  const readiness = vm.runInContext('readiness', context);
  assert.ok(readiness && typeof readiness.then === 'function', 'beginReadiness() dejó una promesa readiness');
  assert.equal(await readiness, false);
  await settle();
  assert.equal(vm.runInContext('ready', context), false);
});
