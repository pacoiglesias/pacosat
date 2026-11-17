/* Ronda 1.29.1 — corrección de la pantalla de Declaraciones
   contra la pantalla REAL de producción (1.29.0, 12 nov 2026,
   18:22). Se juzga:
   - D1/D2: el histórico por años pintaba «Ejercicio undefined»
     DOS veces. El servidor manda el campo «ejercicio» (número)
     y el cliente leía «anio»; los dos ejercicios que la vista
     trae siempre (el año en curso y el anterior, en producción
     ambos vacíos) salían gemelos e indistinguibles, y nada
     normalizaba ni deduplicaba la lista. Las pruebas usan la
     FORMA REAL del payload, capturada del servidor con datos
     de producción — no la idealizada del entorno de la ronda.
   - D3: la rejilla de meses desbordaba (pastilla con la frase
     entera en nowrap y sin min-width:0 en la cadena de la
     rejilla): pastilla corta en la celda y protecciones CSS.
   - D4: el muro de texto previo (sermón de los folios, nota de
     SAT Móvil) se recoge en un «Cómo funciona» plegado al
     final; el primer pantallazo es estado y acciones.
   - D5: la espera del ejecutor enseña su estado real — sin
     equipo emparejado lo dice así, con el gesto de emparejar;
     emparejado sin latido, «tu equipo no responde» con su
     última señal — en la vista, en los mensajes de cola, en
     la guía de Declaraciones y en el panel del ejecutor. */
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { URL as NodeURL } from 'node:url';
import { DOMParser } from '@xmldom/xmldom';
import { createPacoSATService } from './local-server.mjs';

const ORIGIN = 'https://pacosat.test';
const KEY = 'f'.repeat(64);
const OWN = 'AAA010101AAA';
const ROOT = import.meta.dirname;
const read = name => readFileSync(join(ROOT, name), 'utf8');

function makeHarness(options = {}) {
  const clock = { t: Date.parse('2026-11-12T14:00:00Z') };
  const mails = [];
  const service = createPacoSATService({
    dbFile: ':memory:', html: '<html><head><!--PACOSAT_TOKEN--></head><body>prueba</body></html>',
    origin: ORIGIN, proxyKey: KEY, satDocRetryWaitMs: 5,
    makeConnector: () => ({ parser: DOMParser, connector: {
      request: async () => 'req-b', check: async () => ({ status: 'pending', packages: [] }),
      download: async () => { throw new Error('sin paquetes'); } } }),
    makeMailer: () => ({ verify: async () => true,
      sendMail: async mail => { mails.push(mail); return { messageId: 'm' + mails.length }; } }),
    now: () => clock.t, ...options });
  let token = '';
  const raw = async (method, path, body, extraHeaders = {}) => {
    const chunks = []; if (body !== undefined) chunks.push(Buffer.from(JSON.stringify(body)));
    const req = Readable.from(chunks);
    req.method = method; req.url = path;
    req.headers = { host: 'pacosat.test', origin: ORIGIN, 'x-pacosat-proxy': KEY, ...extraHeaders };
    let status = 0; const headers = {}; let text = '';
    const res = { writeHead(code, hdrs) { status = code; if (hdrs) Object.assign(headers, hdrs); },
      setHeader(k, v) { headers[k] = v; }, getHeader(k) { return headers[k]; },
      end(chunk) { if (chunk) text += Buffer.isBuffer(chunk) ? chunk.toString('latin1') : chunk; } };
    await service.handle(req, res);
    return { status, text, headers };
  };
  const call = async (method, path, body, extraHeaders = {}) => {
    if (!token) { const home = await raw('GET', '/'); token = /[0-9a-f]{64}/.exec(home.text)?.[0] || ''; }
    const r = await raw(method, path, body, { 'x-pacosat-token': token, ...extraHeaders });
    let json = null; try { json = JSON.parse(r.text); } catch { /* binario */ }
    return { status: r.status, json, text: r.text, headers: r.headers };
  };
  const exec = async (method, path, body, execToken) => {
    const r = await raw(method, path, body, execToken ? { 'x-pacosat-executor': execToken } : {});
    let json = null; try { json = JSON.parse(r.text); } catch { /* binario */ }
    return { status: r.status, json, text: r.text };
  };
  return { service, call, raw, exec, mails, clock };
}
const unlock = async (h, rfc) => {
  const open = await h.call('POST', '/api/unlock', { rfc, minutes: 1440, days: 7,
    direction: 'both', password: 'simulated', certificate: 'YQ==', key: 'Yg==' });
  assert.equal(open.status, 200, 'unlock del RFC de prueba');
};

/* La FORMA REAL del payload de producción, capturada del
   servidor con la semilla de producción (perfil sin ninguna
   declaración archivada): el campo se llama «ejercicio». */
const ANIO_PRODUCCION = ejercicio => ({ ejercicio, mesesConAcuse: 0, mesesConDecl: 0,
  anual: false, folios: 0, foliosPendientes: 0, completo: false });

/* ===== SERVICIO: el contrato real de los años (D1) ===== */
{
  const h = makeHarness();
  await unlock(h, OWN);
  const view = (await h.call('GET', '/api/declaraciones?rfc=' + OWN)).json;
  assert.ok(Array.isArray(view.anios), 'la vista trae la lista de años');
  assert.equal(view.anios.length, 2, 'sin archivo: año en curso y anterior');
  for (const anio of view.anios) {
    assert.equal(typeof anio.ejercicio, 'number', 'D1: el campo real es «ejercicio» y es número');
    assert.ok(Number.isInteger(anio.ejercicio), 'D1: el ejercicio es entero');
    assert.ok(!('anio' in anio), 'D1: el payload NO trae ningún campo «anio» — leerlo era el defecto');
  }
  assert.deepEqual(view.anios.map(a => a.ejercicio), [2026, 2025],
    'los dos ejercicios de la vista, distintos y en orden');
  assert.equal(new Set(view.anios.map(a => a.ejercicio)).size, view.anios.length,
    'D2: el servidor no manda el mismo ejercicio dos veces');
  /* D5: la vista trae el estado real del ejecutor. */
  assert.deepEqual(view.ejecutor, { emparejado: false, enLinea: false, ultimoVisto: null, nombre: '' },
    'D5: sin equipo emparejado, la vista lo dice así');
  await h.service.close();
  console.log('OK 1.29.1 · servicio — contrato real: «ejercicio» numérico, sin duplicados, ejecutor en la vista.');
}

/* ===== SERVICIO: los mensajes de espera dicen el estado (D5) ===== */
{
  const h = makeHarness({ executorMode: 'remote' });
  await unlock(h, OWN);
  /* Sin ningún equipo emparejado: Buzón y Declaraciones lo dicen. */
  const buzon = await h.call('POST', '/api/tributario/run', { rfc: OWN });
  assert.equal(buzon.json.result.waitingExecutor, true);
  assert.match(buzon.json.result.error, /todavía no has emparejado ningún equipo/,
    'D5: sin emparejar, el mensaje de cola lo dice así');
  assert.equal(buzon.json.result.ejecutor.emparejado, false);
  const decl = await h.call('POST', '/api/declaraciones/run',
    { rfc: OWN, tipo: 'mensual', ejercicio: 2026, periodo: '' });
  assert.equal(decl.json.result.waitingExecutor, true);
  assert.match(decl.json.result.error, /todavía no has emparejado ningún equipo/);
  /* Emparejado pero sin latido: «tu equipo no responde». */
  const par = await h.call('POST', '/api/executor/pair', { nombre: 'Equipo de Paco' });
  assert.equal(par.status, 200, 'emparejar para la segunda mitad de la prueba');
  const decl2 = await h.call('POST', '/api/declaraciones/run',
    { rfc: OWN, tipo: 'mensual', ejercicio: 2026, periodo: '' });
  assert.equal(decl2.json.result.waitingExecutor, true);
  assert.match(decl2.json.result.error, /tu equipo no responde/,
    'D5: emparejado sin señal, el mensaje lo dice así');
  assert.equal(decl2.json.result.ejecutor.emparejado, true);
  assert.equal(decl2.json.result.ejecutor.enLinea, false);
  const view = (await h.call('GET', '/api/declaraciones?rfc=' + OWN)).json;
  assert.equal(view.ejecutor.emparejado, true, 'D5: la vista refleja el equipo emparejado');
  assert.equal(view.ejecutor.enLinea, false);
  await h.service.close();
  console.log('OK 1.29.1 · servicio — la espera nombra el estado real del ejecutor, sin genéricos.');
}

/* ===== DOM: el panel de años con la forma de producción ===== */
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
  return {
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: key => map.delete(key),
    clear: () => map.clear()
  };
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
    navigator: { onLine: true, userAgent: 'ronda1291-test' },
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
const filasDe = (el, clase) => {
  const salida = [];
  const andar = nodo => {
    if (String(nodo.className || '').split(' ').includes(clase)) salida.push(nodo);
    for (const hijo of nodo.children || []) andar(hijo);
  };
  andar(el);
  return salida;
};
{
  const context = makeBootContext();
  const html = read('Faro-Fiscal.html');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  vm.runInContext(script, context, { filename: 'Faro-Fiscal.html#script' });
  for (let i = 0; i < 12; i++) await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(vm.runInContext('typeof declAniosPanel', context), 'function');
  assert.equal(vm.runInContext('typeof declAniosVista', context), 'function');
  assert.equal(vm.runInContext('typeof executorGuiaCard', context), 'function');
  const pintar = view => {
    context.__view1291 = view;
    return vm.runInContext('declAniosPanel(__view1291, function(){})', context);
  };
  /* D1+D2 con la forma REAL: dos ejercicios distintos y vacíos
     (el caso exacto de producción) → dos bloques, cada uno con
     SU año, y «undefined» en ninguna parte. */
  const panel = pintar({ anios: [ANIO_PRODUCCION(2026), ANIO_PRODUCCION(2025)] });
  const filas = filasDe(panel, 'decl-anio-row');
  assert.equal(filas.length, 2, 'D2: un bloque por ejercicio, ni uno más');
  const texto = textoDe(panel);
  assert.ok(texto.includes('Ejercicio 2026'), 'D1: el rótulo pinta el año real');
  assert.ok(texto.includes('Ejercicio 2025'), 'D1: el segundo ejercicio es el suyo, no un gemelo');
  assert.ok(!texto.includes('undefined'), 'D1: «undefined» no se pinta jamás');
  assert.ok(textoDe(filas[0]).includes('Ejercicio 2026') && !textoDe(filas[0]).includes('2025'),
    'D2: cada bloque es de su ejercicio');
  /* La lista endurecida: el mismo ejercicio repetido y en otro
     tipo (cadena) sigue pintando UN bloque por ejercicio. */
  const panelDup = pintar({ anios: [ANIO_PRODUCCION(2026),
    { ...ANIO_PRODUCCION(2026), ejercicio: '2026' }, ANIO_PRODUCCION(2025)] });
  const filasDup = filasDe(panelDup, 'decl-anio-row');
  assert.equal(filasDup.length, 2, 'D2: duplicado en la lista → un solo bloque por ejercicio');
  assert.equal(filasDup.filter(f => textoDe(f).includes('Ejercicio 2026')).length, 1,
    'D2: exactamente 1 bloque para 2026');
  /* Sin año en el dato: la fila dice «Ejercicio sin año». */
  const panelSin = pintar({ anios: [{ mesesConAcuse: 0, mesesConDecl: 0, anual: false,
    folios: 0, foliosPendientes: 0, completo: false }] });
  const filasSin = filasDe(panelSin, 'decl-anio-row');
  assert.equal(filasSin.length, 1);
  assert.ok(textoDe(panelSin).includes('Ejercicio sin año'), 'D1: sin año consta «sin año»');
  assert.ok(!textoDe(panelSin).includes('undefined'), 'D1: ni así se pinta «undefined»');
  /* D5 en el cliente: la guía con sus tres estados. */
  context.__sinEquipo = { emparejado: false, enLinea: false, ultimoVisto: null, nombre: '' };
  const guiaSin = vm.runInContext('executorGuiaCard(__sinEquipo, null)', context);
  assert.ok(guiaSin, 'D5: sin equipo hay tarjeta guía');
  const textoSin = textoDe(guiaSin);
  assert.ok(textoSin.includes('Todavía no has emparejado ningún equipo'), 'D5: lo dice así');
  assert.ok(textoSin.includes('programa que corre en tu PC'), 'D5: la línea honesta de qué es el ejecutor');
  assert.ok(textoSin.includes('Emparejar mi equipo'), 'D5: el gesto de emparejar, a un toque');
  const TS = Date.parse('2026-11-12T09:41:00Z');
  context.__mudo = { emparejado: true, enLinea: false, ultimoVisto: TS, nombre: 'Equipo de Paco' };
  const guiaMuda = vm.runInContext('executorGuiaCard(__mudo, null)', context);
  const textoMudo = textoDe(guiaMuda);
  /* RE-BASE 2.0.1 · nº 31: el estado se dice con el vocabulario
     de la jerarquía del ejecutor residente — «está dormido» —
     y la tarjeta lleva el gesto «Ejecutar aquí» en ella. */
  assert.ok(textoMudo.includes('Tu ejecutor está dormido'), 'D5·2.0.1: emparejado sin latido, lo dice así: está dormido');
  assert.ok(textoMudo.includes('Ejecutar aquí'), 'D5·2.0.1: el gesto de despertarlo vive en la misma tarjeta');
  const esperada = vm.runInContext('fmtFechaHora(' + TS + ')', context);
  assert.ok(textoMudo.includes(esperada), 'D5: la guía enseña la hora de la última señal');
  context.__enLinea = { emparejado: true, enLinea: true, ultimoVisto: TS, nombre: 'Equipo de Paco' };
  assert.equal(vm.runInContext('executorGuiaCard(__enLinea, null)', context), null,
    'D5: en línea no hay tarjeta — no hay espera que guiar');
  /* D4 en el cliente: el «Cómo funciona» recoge las explicaciones. */
  const como = vm.runInContext('declComoFunciona()', context);
  assert.equal(como.tagName, 'DETAILS', 'D4: las explicaciones viven en un pliegue');
  const textoComo = textoDe(como);
  assert.ok(textoComo.includes('Cómo funciona'));
  assert.ok(textoComo.includes('Así trabaja el SAT'), 'D4: el sermón de los folios, recogido aquí');
  assert.ok(textoComo.includes('SAT Móvil'), 'D4: la nota de SAT Móvil, recogida aquí');
  console.log('OK 1.29.1 · DOM — años con su rótulo y sin duplicados, guía del ejecutor, «Cómo funciona».');
}

/* ===== ESTÁTICAS: rejilla (D3), muro (D4) y cableado ===== */
{
  const decl = read('declaraciones-ui.part');
  const trib = read('tributario-ui.part');
  const polish = read('polish.part');
  const server = read('local-server.mjs');
  /* D1: el cliente ya no lee el campo inexistente. */
  assert.ok(!decl.includes("'Ejercicio ' + anio.anio"), 'D1: fuera la lectura de «anio.anio»');
  assert.ok(decl.includes('function declAniosVista'), 'D1: la normalización vive en un solo sitio');
  /* D4: el sermón y la nota viven UNA vez, dentro del pliegue. */
  assert.equal(decl.split('Así trabaja el SAT').length - 1, 1, 'D4: el sermón existe una sola vez');
  assert.ok(decl.indexOf('Así trabaja el SAT') > decl.indexOf('function declComoFunciona'),
    'D4: el sermón está dentro del «Cómo funciona», no abriendo la pantalla');
  assert.equal(decl.split('¿No tienes el folio?').length - 1, 1, 'D4: la nota de SAT Móvil existe una sola vez');
  assert.ok(decl.indexOf('¿No tienes el folio?') > decl.indexOf('function declComoFunciona'),
    'D4: la nota de SAT Móvil está dentro del «Cómo funciona»');
  const foliosPanel = decl.slice(decl.indexOf('function declFoliosPanel'), decl.indexOf('function declAniosVista'));
  assert.ok(!foliosPanel.includes('Así trabaja el SAT'), 'D4: el panel de folios abre con acciones, no con el sermón');
  /* D3: la rejilla y la celda no pueden desbordar. */
  assert.ok(polish.includes('grid-template-columns:repeat(auto-fill,minmax(min(150px,100%),1fr))'),
    'D3: la pista mínima de la rejilla cabe siempre en su contenedor');
  assert.ok(polish.includes('min-height:48px;min-width:0;overflow:hidden'),
    'D3: la celda no se hincha con su contenido');
  assert.ok(polish.includes('.decl-cell small{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}'),
    'D3: la segunda línea de la celda se trunca con sentido, no se derrama');
  assert.ok(decl.includes('DECL_ESTADO_PILL_TEXTO'), 'D3: la pastilla de la celda es corta por diseño');
  assert.ok(!decl.includes("n('span', DECL_ESTADO_TEXTO[mes.estado]"), 'D3: la celda ya no pinta la frase entera');
  /* D5: la guía y el emparejar compartidos; el servidor la alimenta. */
  assert.ok(trib.includes('Todavía no has emparejado ningún equipo'), 'D5: el panel dice el estado sin equipo');
  assert.ok(trib.includes('Tu ejecutor está dormido'), 'D5·2.0.1: el panel dice el estado sin latido: está dormido (nº 31)');
  assert.ok(trib.includes('function executorGuiaCard') && trib.includes('function executorPairBoton'),
    'D5: guía y emparejar viven en un solo sitio');
  assert.ok(decl.includes('executorGuiaCard(view.ejecutor'), 'D5: Declaraciones consume la guía con el estado de su vista');
  assert.ok(server.includes('function executorEstado()'), 'D5: el servidor calcula el estado del ejecutor');
  assert.ok(server.includes('ejecutor: executorEstado()'), 'D5: la vista de declaraciones lo lleva');
  assert.ok(server.includes('todavía no has emparejado ningún equipo'),
    'D5: el mensaje de cola del servidor nombra el estado sin equipo');
  assert.ok(JSON.parse(read('package.json')).scripts.test.includes('ronda1291.test.mjs'),
    'la suite de la corrección corre en la batería');
  console.log('OK 1.29.1 · estáticas — rejilla que cabe, explicaciones plegadas, guía cableada.');
}
/* ===== D8 SERVICIO: la actividad cuenta la cola del ejecutor ===== */
{
  const h = makeHarness({ executorMode: 'remote' });
  await unlock(h, OWN);
  await h.call('POST', '/api/tributario/run', { rfc: OWN });
  await h.call('POST', '/api/declaraciones/run', { rfc: OWN, tipo: 'mensual', ejercicio: 2026, periodo: '' });
  const antes = (await h.call('GET', '/api/activity')).json;
  /* Re-basificado en la 1.31.0 (punto A3): la espera del ejecutor ya
     no es un agregado «N trabajos en cola» sin gesto — cada trabajo
     en cola es su propia entrada en pausa, con su Cancelar (jobId y
     canStop), para poder sacarlo de la cola desde Actividad. */
  const entradas = (antes.paused || []).filter(e => e.kind === 'ejecutor');
  assert.equal(entradas.length, 2, 'D8: la espera trae un renglón por trabajo en cola');
  const entrada = entradas[0];
  assert.equal(entrada.state, 'esperando');
  assert.ok(entradas.every(e => e.canStop && e.jobId), 'D8: cada espera trae su Cancelar');
  assert.match(entrada.detail, /todavía no has emparejado ningún equipo/i, 'D8: y por qué esperan');
  /* Con el equipo en línea reclamando, la espera desaparece. */
  const par = await h.call('POST', '/api/executor/pair', { nombre: 'Equipo de Paco' });
  const reclamo = await h.exec('POST', '/api/executor/claim', { waitMs: 0 }, par.json.token);
  assert.equal(reclamo.status, 200, 'el ejecutor reclama y queda en línea');
  const despues = (await h.call('GET', '/api/activity')).json;
  assert.ok(!(despues.paused || []).some(e => e.kind === 'ejecutor'),
    'D8: con el equipo en línea, la actividad ya no enseña la espera');
  await h.service.close();
  console.log('OK 1.29.1 · D8 servicio — la actividad (y su barra) cuentan la cola del ejecutor.');
}

/* ===== D8 DOM: la banda de actividad une título y detalle
   con un solo separador en su componente compartido ===== */
{
  const context = makeBootContext();
  const html = read('Faro-Fiscal.html');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  vm.runInContext(script, context, { filename: 'Faro-Fiscal.html#script' });
  for (let i = 0; i < 12; i++) await new Promise(resolve => setTimeout(resolve, 0));
  const entrada = { kind: 'ejecutor', key: 'ejecutor', state: 'esperando', enPausa: true,
    label: 'Trabajos del SAT esperando tu equipo',
    detail: '2 trabajos en cola: todavía no has emparejado ningún equipo',
    note: 'El ejecutor corre en tu PC, junto a tu Chrome: en cuanto esté en línea, recoge los trabajos solo.' };
  context.__entradaActividad = entrada;
  const linea = vm.runInContext('activityEntryText(__entradaActividad)', context);
  assert.equal(linea, entrada.label + ' · En pausa · ' + entrada.detail + ' · ' + entrada.note,
    'D8: título y detalle se componen en una sola línea limpia');
  assert.ok(!linea.includes('equipoEn'), 'D8: el título no queda pegado al detalle');
  assert.ok(!linea.includes('· ·'), 'D8: no hay doble separador');
  assert.equal(linea.split(entrada.label + ' · ').length - 1, 1,
    'D8: el separador aparece una sola vez entre el título y el detalle');
  context.__actividad = { running: [], paused: [entrada], recent: [], nextAuto: null };
  vm.runInContext('activityView = __actividad; paintActivity();', context);
  const jobs = vm.runInContext("document.getElementById('activity-jobs')", context);
  const nodos = [];
  const andar = nodo => { nodos.push(nodo); for (const hijo of nodo.children || []) andar(hijo); };
  andar(jobs);
  const titulo = nodos.find(el => el.tagName === 'STRONG' && String(el.textContent || '').startsWith(entrada.label));
  const detalle = nodos.find(el => String(el.className || '').split(' ').includes('activity-detail'));
  assert.ok(titulo && detalle, 'D8: la banda pinta título y detalle desde el componente compartido');
  assert.equal(titulo.textContent + detalle.textContent, linea,
    'D8: lo pintado conserva la unión compuesta, sin texto pegado ni separadores dobles');
  console.log('OK 1.29.1 · D8 DOM — banda de actividad con título y detalle unidos una sola vez.');
}

/* ===== D6/D7 DOM: panel alcanzable, contadores de lo visible,
   y el recálculo que trabaja, avisa y no se traga el error ===== */
{
  const context = makeBootContext();
  const html = read('Faro-Fiscal.html');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  vm.runInContext(script, context, { filename: 'Faro-Fiscal.html#script' });
  for (let i = 0; i < 12; i++) await new Promise(resolve => setTimeout(resolve, 0));
  const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0)); };
  /* D6: el panel del ejecutor se monta en el Buzón Tributario
     AUNQUE no haya contribuyente elegido (el retorno temprano
     que lo escondía), y la pestaña de Centro SAT lo monta tal
     cual — el panel pinta su estado y su botón de emparejar. */
  const trib = vm.runInContext('tributarioScreen()', context);
  await settle();
  const textoTrib = trib.map(textoDe).join(' ');
  /* Re-baseline 1.32.1 (B2, auditoría de caminos): el panel
     COMPLETO del ejecutor ya no vive apilado en el Buzón — su
     casa es la pestaña «Ejecutor local» del Centro SAT (la que
     la propia D6 creó) — y en el Buzón queda su LÍNEA DE ESTADO
     con el enlace: el ejecutor sigue sin desaparecer en
     silencio, que era el fondo de D6, sin montar la sala de
     máquinas sobre cada visita al Buzón. */
  assert.ok(textoTrib.includes('Abrir el Ejecutor local'), 'B2: sin contribuyente, la línea del ejecutor está con su enlace');
  assert.ok(textoTrib.includes('Ejecutor'), 'B2: y su estado se anuncia');
  const panelSolo = vm.runInContext('executorPanel()', context);
  await settle();
  assert.ok(textoDe(panelSolo).includes('Emparejar un ejecutor en mi equipo'),
    'D6: el panel que monta la pestaña «Ejecutor local» pinta el emparejamiento');
  /* D7: los contadores de Avisos cuentan la lista VISIBLE. */
  /* RE-BASE 2.0.1 · nº 9: las secciones de Avisos ya no son las
     tres clases — son los DOS GRUPOS POR GESTO («Necesita tu
     gesto» / «Informativos», por gesto.de que ya viaja en cada
     aviso) y el distintivo del menú cuenta SOLO los de gesto
     de Paco. Las pastillas por clase se conservan como foto y
     siguen contando lo visible. La semilla trae el gesto que
     el servidor real adjunta (avisoGesto): los «mal» son del
     SAT, el «necesita» es de Paco. */
  const avisoFalso = (id, clase, rfc, gestoDe = 'sat') => ({ id, ref: 'semilla:' + id, kind: 'semilla', clase,
    estado: 'abierto', severidad: 'media', titulo: 'Aviso ' + id, detalle: '', contraparte: 'C' + id,
    nombre: '', importe: '', enlace: '', baseline: false, creado: Date.now(), resuelto: null,
    resolucion: '', direccion: '', fileId: '', rfc, responsable: 'Paco', vence: null, accion: '', actualizado: 0,
    gesto: { de: gestoDe, texto: gestoDe === 'paco' ? 'tuyo' : 'del SAT' } });
  const datos = { counts: { total: 11, mal: 7, falta: 3, necesita: 1, porConfirmar: 0 },
    porRfc: { MFI6212158B4: 3, AAA010101AAA: 8 }, grupos: [], historial: [],
    avisos: [avisoFalso(1, 'mal', 'MFI6212158B4'), avisoFalso(2, 'mal', 'MFI6212158B4'),
      avisoFalso(3, 'necesita', 'MFI6212158B4', 'paco'),
      ...[4, 5, 6, 7, 8].map(id => avisoFalso(id, 'mal', 'AAA010101AAA')),
      ...[9, 10, 11].map(id => avisoFalso(id, 'falta', 'AAA010101AAA', 'sistema'))] };
  context.__datos = datos;
  vm.runInContext('avisosCache = __datos; avisosRfcFiltro = ""; scope = "MFI6212158B4";', context);
  const pantalla = vm.runInContext('avisosScreen()', context);
  await settle();
  const textoAvisos = pantalla.map(textoDe).join(' ');
  assert.ok(textoAvisos.includes('Lo que está mal: 2'), 'D7: la pastilla cuenta lo visible (2), no el total (7)');
  assert.ok(!textoAvisos.includes('Lo que está mal: 7'), 'D7: el total global ya no se anuncia como filtro');
  assert.ok(textoAvisos.includes('Necesita tu gesto (1)'), 'D7·2.0.1: la sección de gesto cuenta lo visible de gesto (1)');
  assert.ok(textoAvisos.includes('Informativos (2)'), 'D7·2.0.1: la sección informativa cuenta el resto visible (2)');
  assert.ok(textoAvisos.includes('Lo que falta: 0'), 'D7: la clase sin visibles se anuncia a 0, como su (ausente) sección');
  assert.equal(vm.runInContext('avisosBadgeCount(__datos)', context), 1,
    'D7·2.0.1: el distintivo del menú cuenta los de gesto de Paco del RFC en pantalla (1), no su total (3) ni el global (11)');
  /* Re-baseline 1.32.1 (auditoría A3): el botón se llama
     «Revisar avisos ahora» — sigue diciendo la verdad de lo
     que hace (recalcular al momento), en la palabra llana. */
  assert.ok(textoAvisos.includes('Revisar avisos ahora'), 'D7: el botón dice la verdad de lo que hace');
  /* D7 comportamiento: mismo payload → «sin cambios» con hora;
     error de red → error visible y botón rehabilitado; con
     cambios → el delta se anuncia. satApi se sustituye en la VM
     para gobernar las tres respuestas. */
  const statusTexto = () => vm.runInContext("document.getElementById('status').textContent", context);
  vm.runInContext('satApi = async () => __datos;', context);
  await vm.runInContext('avisosRecalcular()', context);
  assert.match(statusTexto(), /Avisos recalculados · .+ — sin cambios\./,
    'D7: con el payload idéntico, el recálculo igualmente se ve: hora y «sin cambios»');
  const datosB = { ...datos, avisos: datos.avisos.filter(a => a.id !== 3).concat([avisoFalso(12, 'falta', 'MFI6212158B4')]) };
  context.__datosB = datosB;
  vm.runInContext('satApi = async () => __datosB;', context);
  await vm.runInContext('avisosRecalcular()', context);
  assert.match(statusTexto(), /1 nuevo\(s\), 1 cerrado\(s\)/, 'D7: el delta se anuncia (1 nuevo, 1 cerrado)');
  vm.runInContext("satApi = async () => { throw new Error('sin conexión de prueba'); };", context);
  const boton = vm.runInContext('avisosRecalcularBoton()', context);
  await boton.onclick();
  assert.match(statusTexto(), /No se pudieron recalcular los avisos: sin conexión de prueba/,
    'D7: el error es literal y visible — el catch silencioso desapareció de esta ruta');
  assert.equal(boton.disabled, false, 'D7: tras el error el botón se rehabilita');
  assert.equal(boton.textContent, 'Revisar avisos ahora', 'D7: y su rótulo vuelve');
  console.log('OK 1.29.1 · D6/D7 DOM — ejecutor alcanzable y pintado; avisos contados de lo visible; recálculo veraz.');
}

/* ===== D6–D8 ESTÁTICAS: cableado de la ampliación ===== */
{
  const ui = read('ui.part');
  const trib = read('tributario-ui.part');
  const avisos = read('avisos-ui.part');
  const ejecutor = read('ejecutor-local.mjs');
  const server = read('local-server.mjs');
  /* RE-BASIFICADO en la 2.0.1 (parte de cliente): el Centro
     SAT con pestañas se retiró («Ya no hay un Centro SAT con
     pestañas escondidas», nota de la ronda) y el Ejecutor
     local se resuelve como destino propio en el mapa de
     pantallas, montando el mismo panel real de siempre. */
  assert.ok(ui.includes("ejecutor: typeof executorPanel === 'function' ? () => [executorPanel()] : null"),
    'D6: el Ejecutor local se resuelve en el mapa de pantallas (2.0.1)');
  assert.ok(!ui.includes("['ejecutor', 'Ejecutor local']"),
    'D6: fuera la pestaña «Ejecutor local» del Centro SAT retirado');
  const pantallaTrib = trib.slice(trib.indexOf('function tributarioScreen'));
  assert.ok(pantallaTrib.indexOf('wrap.append(executorStatusLine())') < pantallaTrib.indexOf('if (!scope)'),
    'B2: en el Buzón la línea del ejecutor se monta antes del retorno de «sin contribuyente»');
  assert.ok(trib.includes('El ejecutor se empareja y se consulta desde el servidor'),
    'D6: sin servidor, la entrada del ejecutor dice qué falta en vez de desaparecer');
  assert.ok(!ejecutor.includes('Ajustes/Centro SAT → Ejecutor'), 'D6: fuera la documentación falsa del ejecutor');
  assert.ok(ejecutor.includes('Centro SAT › Ejecutor local'), 'D6: la cabecera del ejecutor dice dónde se empareja de verdad');
  assert.ok(!avisos.includes("'Actualizar ahora'"), 'D7: fuera el rótulo que fingía una actualización');
  assert.ok(avisos.includes('function avisosRecalcular') && avisos.includes('Recalculando…'),
    'D7: el recálculo existe y trabaja a la vista');
  assert.ok(ui.includes('Tus trabajos del SAT esperan tu equipo'), 'D8: Hoy tiene el protagonista del ejecutor');
  assert.ok(ui.includes("satTab = 'ejecutor'; navigate('sat')"), 'D8: el toque de Hoy lleva al panel del ejecutor');
  assert.ok(server.includes("kind: 'ejecutor'"), 'D8: la actividad del servidor cuenta la cola del ejecutor');
  console.log('OK 1.29.1 · D6–D8 estáticas — pestaña, panel sin retornos mudos, protagonista y actividad.');
}
console.log('ronda1291.test: ok — D1–D8 corregidos y probados (D1/D2 con la forma real de producción).');
