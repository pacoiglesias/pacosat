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
   refresh() de esa preparación no muere por TDZ. Afirma también el
   sello del pie (requisito expreso de Paco): «PacoSAT {versión} ·
   Modificado el {fecha} a las {hora} · Creado por Paco Iglesias»
   pintado desde la primera carga — primero con la versión, y con la
   fecha y hora en cuanto el servidor aporta la mtime del artefacto
   servido (buildModified de /api/status); si la mtime no llega, el
   sello muestra la versión y omite la fecha, como está diseñado. */
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

/* La mtime que el servidor real adjunta a /api/status es la del
   Faro-Fiscal.html servido (statSync(...).mtimeMs en local-server.mjs),
   y overview() incluye SIEMPRE settings y buildModified: el auxiliar
   reproduce esa forma. Instante fijo: 9 nov 2026, 09:52 CST. */
const STATUS_MTIME_MS = Date.UTC(2026, 10, 9, 15, 52, 0);

function makeBootContext(server, { withModified = true } = {}) {
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
    else if (target.includes('/api/status')) body = {
      settings: { installName: 'PacoSAT', hasLogo: false },
      buildModified: withModified ? STATUS_MTIME_MS : null,
      cloudRevision: null,
      profiles: [], jobs: [], inbox: [], mail: {}
    };
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

/* El sello del pie, tal y como lo compone applySettings(): la versión
   sale del package.json del artefacto y la fecha/hora se formatean
   con la misma expresión (es-MX, hora de Ciudad de México). */
const APP_VERSION = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
const sealWithoutDate = () => 'PacoSAT ' + APP_VERSION + ' · Creado por Paco Iglesias';
const sealWithDate = mtimeMs => {
  const modified = new Date(mtimeMs);
  return 'PacoSAT ' + APP_VERSION + ' · Modificado el ' +
    modified.toLocaleDateString('es-MX', { timeZone: 'America/Mexico_City', day: 'numeric', month: 'long', year: 'numeric' }) +
    ' a las ' + modified.toLocaleTimeString('es-MX', { timeZone: 'America/Mexico_City', hour: '2-digit', minute: '2-digit' }) +
    ' · Creado por Paco Iglesias';
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
  /* El sello ya se ve desde la primera carga: versión y autoría. La
     fecha aún no va: la aporta el servidor con su estado, y hasta que
     no llega se omite (no se inventa), como está diseñado. */
  assert.equal(byId.get('app-footer').textContent, sealWithoutDate(),
    'desde la primera carga el pie muestra el sello con la versión');
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
  /* El sondeo de estado corrió y, con la mtime que el servidor aporta,
     applySettings() repintó el pie con el sello COMPLETO y poblado:
     versión, fecha y hora reales formateadas, sin marcadores. */
  assert.ok(fetchCalls.some(url => url.includes('/api/status')), 'el sondeo de estado (/api/status) corrió');
  const footer = byId.get('app-footer').textContent;
  assert.equal(footer, sealWithDate(STATUS_MTIME_MS), 'el pie termina con el sello completo y poblado');
  assert.ok(!footer.includes('{'), 'el sello no deja marcadores sin rellenar');
});

test('arranque en modo servidor sin mtime: el sello muestra la versión y omite la fecha, sin romper el arranque', async () => {
  const { context, byId } = makeBootContext(true, { withModified: false });
  vm.runInContext(generatedScript(), context, { filename: 'Faro-Fiscal.html#script' });
  const readiness = vm.runInContext('readiness', context);
  await readiness;
  await settle();
  assert.equal(vm.runInContext('ready', context), true);
  assert.equal(byId.get('app-footer').textContent, sealWithoutDate(),
    'sin mtime el pie muestra versión y autoría, y omite la fecha');
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
  /* Sin servidor no hay mtime que mostrar: el sello queda con la
     versión y la autoría, y la fecha se omite (no se inventa). */
  assert.equal(byId.get('app-footer').textContent, sealWithoutDate(),
    'en modo local el pie muestra el sello con la versión, sin fecha');
});

/* Regresión 1.7.3 — los ayudantes que los fragmentos nuevos llaman
   deben EXISTIR. Hasta la 1.7.2, siete nombres se llamaban desde los
   fragmentos y no estaban definidos en ninguno: toast() (36 llamadas
   en Centro de salidas, Dinero, Cumplimiento, Bancos, Constancias…),
   fieldWrap(), showDialog(), closeDialog(), previousMonthKey(),
   money() y satApiBlob(). Cada llamada lanzaba ReferenceError —
   «toast is not defined», visto por Paco en producción — y los catch
   que avisaban con toast() enmascaraban el error verdadero tras ese
   ReferenceError. La 1.7.3 los define en ui.part/sat-ui.part sobre las
   piezas existentes (announce(), field(), el <dialog> compartido, el
   formato de amount(), satApi()); esta prueba ejecuta el bloque
   generado entero en la VM y afirma que los siete son funciones, que
   toast() pinta el aviso sin lanzar, y que los de comportamiento
   comprobable en la VM (money, previousMonthKey, fieldWrap y el
   puente de diálogos) hacen lo suyo. satApiBlob se afirma presente;
   su camino feliz exige un servidor real y lo cubre la revisión del
   paquete de defensa en Cumplimiento. */
test('regresión 1.7.3: toast() y los demás ayudantes de los fragmentos nuevos existen y funcionan', async () => {
  const { context, byId } = makeBootContext(true);
  vm.runInContext(generatedScript(), context, { filename: 'Faro-Fiscal.html#script' });
  await settle();
  for (const name of ['toast', 'fieldWrap', 'showDialog', 'closeDialog', 'previousMonthKey', 'money', 'satApiBlob'])
    assert.equal(vm.runInContext('typeof ' + name, context), 'function', name + ' debe estar definido');
  /* toast(texto, 'ok') pinta el aviso normal y toast(texto, 'error')
     lo marca como error: es announce() con el segundo argumento de
     las llamadas, y ninguno de los dos lanza. */
  vm.runInContext("toast('Aviso de prueba', 'ok')", context);
  assert.equal(byId.get('status').textContent, 'Aviso de prueba');
  assert.equal(byId.get('status').dataset.error, false);
  vm.runInContext("toast('Fallo de prueba', 'error')", context);
  assert.equal(byId.get('status').textContent, 'Fallo de prueba');
  assert.equal(byId.get('status').dataset.error, true);
  /* money() formatea un importe suelto como amount(), sin moneda. */
  assert.equal(vm.runInContext("money('1234567.89')", context), '1,234,567.89');
  assert.equal(vm.runInContext("money('0')", context), '0.00');
  /* previousMonthKey() da la clave AAAA-MM del mes anterior. */
  const now = new Date();
  const previous = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const expectedKey = previous.getFullYear() + '-' + String(previous.getMonth() + 1).padStart(2, '0');
  assert.equal(vm.runInContext('previousMonthKey()', context), expectedKey);
  /* fieldWrap() es el envoltorio de field(): la etiqueta con el
     control dentro. */
  const wrapped = vm.runInContext("fieldWrap('Mes', input('month'))", context);
  assert.equal(wrapped.tagName, 'LABEL');
  assert.equal(wrapped.children.length, 1);
  /* showDialog() aloja el formulario propio en el <dialog> compartido
     ocultando el integrado; closeDialog() lo retira y lo restaura. */
  vm.runInContext("showDialog(n('form'))", context);
  assert.notEqual(vm.runInContext('hostedForm', context), null);
  assert.equal(byId.get('form').hidden, true);
  vm.runInContext('closeDialog()', context);
  assert.equal(vm.runInContext('hostedForm', context), null);
  assert.equal(byId.get('form').hidden, false);
});
