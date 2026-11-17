/* ================================================================
   Ronda 2.0 · Tanda 2 — Hoy adelgaza y desduplica (M5/O1/O2/O5),
   un trabajo un sitio, cabecera móvil, identidad visual por RFC,
   selector con buscador y salud, panel general y Pagos colapsado.

   (a) Estructura de Hoy: ningún bloque duplicado (cada
       data-bloque200b una vez), «Esto es lo nuevo» ausente de
       Hoy y presente en Ajustes › Acerca de; la medición de
       pantallas con el arnés de la auditoría se corre fuera de
       la suite (auditar.mjs) y su resultado va en el informe.
   (b) Color por RFC: asignar → el estado servido lo trae
       (settings.rfcColors y profiles[].color) y el medallón lo
       usa; dos RFC con colores distintos no se mezclan; la
       paleta mide contraste AA contra blanco en esta prueba.
   (c) Panel general: 3 RFC semilla, orden por urgencia y
       tocar una fila fija el ámbito.
   (d) «Ver» de «Lo que falta» con destino exacto (aviso-<id>).
   (e) En Centro SAT, un trabajo en cola NO se pinta accionable
       en la franja global (vive en su tarjeta); en Hoy, sí.
   ================================================================ */

import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { URL as NodeURL } from 'node:url';
import { DOMParser } from '@xmldom/xmldom';
import { createPacoSATService } from './local-server.mjs';

const ORIGIN = 'https://pacosat.test';
const KEY = 'f'.repeat(64);
const OWN = 'MFI6212158B4';
const ROOT = import.meta.dirname;
const read = name => readFileSync(join(ROOT, name), 'utf8');
const html = read('Faro-Fiscal.html');
const AHORA = Date.parse('2026-11-15T19:00:00Z');
const T_PUERTA = Date.parse('2026-11-13T19:02:00Z');   /* la foto vieja */
const T_SENAL = Date.parse('2026-11-14T23:02:00Z');    /* última señal: sábado */
const PUERTA_EFIRMA = { ok: false, probada: T_PUERTA, errorKind: 'sin-efirma',
  error: 'Este perfil no tiene una e.firma guardada en PacoSAT, así que la descarga automática no puede firmar.' };
const EJECUTOR_APAGADO = { emparejado: true, enLinea: false, ultimoVisto: T_SENAL, nombre: 'Equipo de Paco' };
const EJECUTOR_VIVO = { emparejado: true, enLinea: true, ultimoVisto: AHORA - 60000, nombre: 'Equipo de Paco' };

/* ===== Arnés DOM (el de ronda1291) ===== */
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
    navigator: { onLine: true, userAgent: 'ronda200a-test' },
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
  return context;
}
const textoDe = el => {
  let texto = el.textContent || '';
  for (const hijo of el.children || []) texto += ' ' + textoDe(hijo);
  return texto;
};
const buscarPorClase = (el, clase, salida = []) => {
  if (String(el.className || '').split(' ').includes(clase)) salida.push(el);
  for (const hijo of el.children || []) buscarPorClase(hijo, clase, salida);
  return salida;
};
async function bootCliente() {
  const context = makeBootContext();
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  vm.runInContext(script, context, { filename: 'Faro-Fiscal.html#script' });
  for (let i = 0; i < 12; i++) await new Promise(resolve => setTimeout(resolve, 0));
  return context;
}
const ponerSatData = (context, data) => {
  context.__sd = data;
  vm.runInContext('satData = __sd; scope = "MFI6212158B4"; people = [{ id: "MFI6212158B4", name: "Mano Fil, S.A." }];', context);
};
const OTRO = 'XAXX010101000';
const TERCERO = 'XEXX010101000';

/* ===== (b) Paleta: contraste AA medido ===== */
{
  const context = await bootCliente();
  const paleta = vm.runInContext('RFC_PALETA200B', context);
  assert.ok(paleta.length >= 8 && paleta.length <= 10, 'paleta cerrada de 8–10 tonos');
  const lum = hex => {
    const h = hex.replace('#', '');
    const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(parseInt(h.slice(0, 2), 16)) + 0.7152 * f(parseInt(h.slice(2, 4), 16)) + 0.0722 * f(parseInt(h.slice(4, 6), 16));
  };
  for (const [clave, hex] of paleta) {
    const ratio = (1.05) / (lum(hex) + 0.05);
    assert.ok(ratio >= 4.5, 'AA: ' + clave + ' ' + hex + ' con texto blanco = ' + ratio.toFixed(2) + ':1');
  }
  console.log('OK 2.0·T2 · paleta — ' + paleta.length + ' tonos, todos AA con texto blanco (≥4.5:1).');
}

/* ===== (a) Hoy: estructura sin duplicados y sin novedades ===== */
{
  const context = await bootCliente();
  ponerSatData(context, { rest: { active: false }, puerta: {}, ejecutor: EJECUTOR_VIVO,
    pendingProfiles: [], profiles: [], jobs: [], inbox: [], mail: {}, settings: {}, health: null });
  vm.runInContext('ready = true; invoices = []; documents = []; activity = []; lastImport = null;', context);
  const bloques = vm.runInContext('home()', context);
  const textoHoy = bloques.map(textoDe).join(' ');
  assert.ok(!textoHoy.includes('Esto es lo nuevo'), 'M5: «Esto es lo nuevo» NO está en Hoy');
  assert.ok(!textoHoy.includes('Centro de mando'), 'M5: el centro de mando de 7 bloques salió de Hoy');
  assert.ok(!textoHoy.includes('Últimos comprobantes'), 'M5: últimos comprobantes viven en Facturas');
  const ids = bloques.map(b => b.dataset?.bloque200b).filter(Boolean);
  assert.equal(new Set(ids).size, ids.length, 'M5: cada bloque marcado aparece UNA vez (' + ids.join(',') + ')');
  /* RE-BASE 2.0.1 (limpieza visible, orden directa de Paco del
     16 nov): la estructura de Hoy de la 2.0 — franja de botones
     «Acciones del día» (bloque200b 'acciones') y línea-resumen
     de salud ('salud-linea') — queda sustituida por el mando
     único corto: una línea de estado por pieza con su fecha,
     «Lo que te necesita» y las 4 acciones grandes que HACEN la
     cosa desde Hoy. La salud sale de Hoy: es entrada propia
     del menú. Lo que esta aserción fija desde la 2.0.1 es la
     composición nueva, no la vieja. */
  assert.ok(textoHoy.includes('Puerta del SAT') && textoHoy.includes('Última descarga'),
    '2.0.1: Hoy abre con el estado de las piezas, cada uno con su fecha');
  assert.ok(textoHoy.includes('Lo que te necesita'), '2.0.1: los gestos se llaman «Lo que te necesita»');
  for (const titulo of ['Descargar facturas', 'Buzón Tributario', 'Declaraciones', 'Documentos'])
    assert.ok(textoHoy.includes(titulo), '2.0.1: la acción grande «' + titulo + '» está en Hoy');
  assert.ok(!textoHoy.includes('Salud del sistema y respaldo'), '2.0.1: la línea de salud salió de Hoy (Salud es menú propio)');
  assert.ok(textoHoy.includes('Descargar este mes'), 'O1: «Descargar este mes» en la tarjeta grande (hoja a 1 toque más)');
  assert.ok(html.includes("downloadSheet(scope, { start: rango.start, end: rango.end })"),
    'O1: la tarjeta abre la hoja con el periodo del mes precargado');
  /* Las novedades viven en Ajustes › Acerca de. */
  const acerca = vm.runInContext('capacidadesScreen()', context);
  const textoAcerca = acerca.map(textoDe).join(' ');
  assert.ok(textoAcerca.includes('Esto es lo nuevo'), 'M5: «Esto es lo nuevo» vive en Ajustes › Acerca de');
  /* Pintado progresivo: bloques bajo el pliegue marcados, DOM completo. */
  assert.ok(html.includes('pintado-progresivo200b') && html.includes('content-visibility:auto'),
    'O2: pintado progresivo con hueco honesto (content-visibility)');
  console.log('OK 2.0·T2 · (a) Hoy — sin duplicados, sin novedades, con acciones del día y salud en una línea.');
}

/* ===== (b) Cliente: el medallón usa el color de SU RFC ===== */
{
  const context = await bootCliente();
  ponerSatData(context, { rest: { active: false }, puerta: {}, ejecutor: EJECUTOR_VIVO, pendingProfiles: [],
    profiles: [], jobs: [], inbox: [], mail: {},
    settings: { rfcColors: { [OWN]: 'burdeos', [OTRO]: 'oliva' } } });
  vm.runInContext('people = [{ id: "' + OWN + '", name: "Mano Fil, S.A." }, { id: "' + OTRO + '", name: "Cliente Mostrador" }];', context);
  const m1 = vm.runInContext('medallon200b("' + OWN + '", "Mano Fil, S.A.")', context);
  const m2 = vm.runInContext('medallon200b("' + OTRO + '", "Cliente Mostrador")', context);
  assert.equal(m1.dataset.color, 'burdeos'); assert.equal(m2.dataset.color, 'oliva');
  assert.notEqual(m1.style.background, m2.style.background, 'dos RFC, dos colores: no se mezclan');
  assert.equal(m1.textContent, 'M'); assert.equal(m2.textContent, 'C');
  const m3 = vm.runInContext('medallon200b("' + TERCERO + '", "Proveedor")', context);
  assert.equal(m3.dataset.color, '', 'sin color asignado: medallón neutro de la casa');
  assert.ok(!m3.style.background, 'sin color asignado: sin fondo inline');
  /* Salud compuesta por RFC para el selector. */
  ponerSatData(context, { rest: { active: false }, puerta: { [OWN]: PUERTA_EFIRMA }, ejecutor: EJECUTOR_APAGADO,
    pendingProfiles: [], profiles: [], jobs: [], inbox: [], mail: {}, tributario: {}, settings: {} });
  const salud = vm.runInContext('saludRfc200b("' + OWN + '", ' + AHORA + ')', context);
  assert.equal(salud.nivel, 'bad', 'salud por RFC: equipo caído ⇒ rojo con su porqué');
  assert.match(salud.porque, /tu equipo no responde/);
  console.log('OK 2.0·T2 · (b) cliente — medallón por RFC sin mezcla y salud compuesta.');
}

/* ===== (c) Panel general: orden por urgencia y ámbito ===== */
{
  const context = await bootCliente();
  ponerSatData(context, { rest: { active: false },
    puerta: { [OWN]: PUERTA_EFIRMA, [OTRO]: { ok: true, probada: AHORA - 3600000, error: '', errorKind: '' } },
    ejecutor: EJECUTOR_APAGADO, pendingProfiles: [], jobs: [], inbox: [], mail: {},
    profiles: [{ rfc: OWN, lastSatSuccess: AHORA - 86400000 }, { rfc: OTRO, lastSatSuccess: AHORA - 3600000 },
      { rfc: TERCERO, lastSatSuccess: null }],
    tributario: { [TERCERO]: { sinAbrir: 2 } }, buzonUnread: {}, settings: {} });
  vm.runInContext('people = [{ id: "' + OTRO + '", name: "Cliente Mostrador" }, { id: "' + TERCERO + '", name: "Proveedor" }, { id: "' + OWN + '", name: "Mano Fil, S.A." }]; scope = "' + OTRO + '";', context);
  const panel = vm.runInContext('contribuyentesPanel200b()', context);
  const filas = panel.children.filter(el => el.dataset && el.dataset.rfc);
  assert.equal(filas.length, 3, 'panel: una fila por RFC');
  assert.equal(filas[0].dataset.rfc, OWN, 'panel: primero quien necesita gesto (puerta con el equipo caído)');
  assert.equal(filas[filas.length - 1].dataset.rfc, OTRO, 'panel: el sano va al final');
  filas[0].onclick();
  assert.equal(vm.runInContext('scope', context), OWN, 'panel: tocar la fila fija el ámbito a ese RFC');
  const textoPanel = textoDe(panel);
  assert.ok(!/Mano Fil[\s\S]*Cliente Mostrador/.test('') && textoPanel.includes('Última descarga'), 'panel: cada fila trae su última descarga');
  console.log('OK 2.0·T2 · (c) panel general — urgencia primero y toque que fija el ámbito.');
}

/* ===== (d) Destino exacto desde «Lo que falta» ===== */
{
  assert.ok(html.includes("irDestino200b('avisos', primerAvisoId"), 'O5: el «Ver» de avisos lleva el id del primer aviso');
  assert.ok(html.includes("card.dataset.destino200b = 'aviso-' + aviso.id"), 'O5: la tarjeta de Avisos se marca con su id');
  assert.ok(html.includes("card.dataset.destino200b = clave"), 'O5: las tarjetas del Centro SAT se marcan por trámite');
  const context = await bootCliente();
  const destino = new FakeElement('article');
  context.__destino = destino;
  context.document.querySelector = sel => (String(sel).includes('aviso-7') ? destino : null);
  vm.runInContext('destinoPendiente200b = "aviso-7"; aplicarDestino200b();', context);
  assert.ok(destino.classList.contains('destino-realce200b'), 'O5: la tarjeta destino se realza al aterrizar');
  assert.equal(vm.runInContext('destinoPendiente200b', context), '', 'O5: el destino se consume una vez');
  /* Sin tarjeta en el destino: cae a la pantalla, sin error. */
  context.document.querySelector = () => null;
  vm.runInContext('destinoPendiente200b = "aviso-99"; aplicarDestino200b();', context);
  await new Promise(r => setTimeout(r, 420));
  assert.equal(vm.runInContext('destinoPendiente200b', context), '', 'O5: sin tarjeta, no queda destino colgado ni hueco muerto');
  console.log('OK 2.0·T2 · (d) destino exacto — realce en la tarjeta y caída limpia sin tarjeta.');
}

/* ===== (e) Centro SAT: el trabajo accionable vive en su tarjeta ===== */
{
  assert.ok(html.includes('franjaDuplica200b'), 'corrección 3: la franja global se suprime donde el trabajo ya tiene sitio');
  assert.ok(html.includes('Cola de trabajos:'), 'corrección 3: la pestaña Ejecutor enseña la cola como conteo con enlace');
  const context = await bootCliente();
  ponerSatData(context, { rest: { active: false }, puerta: {}, ejecutor: EJECUTOR_VIVO, pendingProfiles: [], profiles: [] });
  const trabajo = { kind: 'ejecutor', label: 'Consultar el Buzón', phase: 'En cola', detail: '', state: 'esperando',
    since: AHORA - 3600000, done: 0, total: 0, canStop: true, jobId: 'job-t2' };
  context.__trabajo = trabajo;
  vm.runInContext('activityView = { running: [__trabajo], paused: [], recent: [], nextAuto: 0 }; page = "sat"; paintActivity();', context);
  const cajaSat = context.document.getElementById('activity-jobs');
  assert.ok(cajaSat.hidden || !cajaSat.children.length, 'corrección 3: en Centro SAT la franja NO pinta el trabajo (vive en su tarjeta)');
  vm.runInContext('page = "home"; paintActivity();', context);
  const cajaHoy = context.document.getElementById('activity-jobs');
  assert.ok(!cajaHoy.hidden && cajaHoy.children.length >= 2, 'corrección 3: fuera de Centro SAT la franja sí enseña el trabajo con su barra');
  console.log('OK 2.0·T2 · (e) un trabajo, un sitio — franja muda en Centro SAT, viva en Hoy.');
}

/* ===== Piezas 6 y 10: cabecera móvil y Pagos colapsado (fuente) ===== */
{
  assert.ok(html.includes('search-toggle200b') && html.includes('.top.busqueda200b .top-search'),
    '3.3: buscador colapsable tras su icono en móvil');
  assert.ok(html.includes('@media(max-width:860px)') && html.includes('.top .icon-button{min-width:44px;min-height:44px}'),
    '3.3: cabecera móvil de una fila con iconos a 44 px');
  const pagosSrc = read('pagos-ui.part');
  assert.ok(pagosSrc.includes('Catálogo: ') && pagosSrc.includes('pagos-editar200b'),
    '2.5: el paso 1 de Pagos se colapsa a «Catálogo: N beneficiarios · Editar»');
  console.log('OK 2.0·T2 · cabecera móvil compacta y paso 1 de Pagos colapsado.');
}

/* ===== (b) Servidor real: el color se guarda y se sirve ===== */
{
  const dir = mkdtempSync(join(tmpdir(), 'pacosat-200b-'));
  const service = createPacoSATService({
    dbFile: join(dir, 't.sqlite'), efirmaDir: join(dir, 'efirma'),
    html: '<html><head><!--PACOSAT_TOKEN--></head><body>prueba</body></html>',
    origin: ORIGIN, proxyKey: KEY, satDocRetryWaitMs: 5, executorMode: 'remote',
    makeConnector: async () => { throw new Error('sin conector en esta prueba'); },
    makeMailer: () => ({ verify: async () => true, sendMail: async () => ({ messageId: 'm1' }) }),
    now: () => AHORA });
  let token = '';
  const raw = async (method, path, body, extraHeaders = {}) => {
    const chunks = []; if (body !== undefined) chunks.push(Buffer.from(JSON.stringify(body)));
    const req = Readable.from(chunks);
    req.method = method; req.url = path;
    req.headers = { host: 'pacosat.test', origin: ORIGIN, 'x-pacosat-proxy': KEY, ...extraHeaders };
    let status = 0; let text = '';
    const res = { writeHead(c) { status = c; }, setHeader() {}, getHeader() { return undefined; },
      end(chunk) { if (chunk) text += Buffer.isBuffer(chunk) ? chunk.toString('latin1') : chunk; } };
    await service.handle(req, res);
    return { status, text };
  };
  const call = async (method, path, body) => {
    if (!token) { const home = await raw('GET', '/'); token = /[0-9a-f]{64}/.exec(home.text)?.[0] || ''; }
    const r = await raw(method, path, body, { 'x-pacosat-token': token });
    let json = null; try { json = JSON.parse(r.text); } catch { /* binario */ }
    return { status: r.status, json };
  };
  try {
    const asignado = await call('POST', '/api/settings', { installName: '', senderName: '', accent: '',
      rfcColor: { rfc: OWN, color: 'burdeos' } });
    assert.equal(asignado.status, 200, 'asignar color responde 200');
    assert.equal(asignado.json.settings.rfcColors[OWN], 'burdeos', 'el estado devuelto ya trae el color');
    const segundo = await call('POST', '/api/settings', { installName: '', senderName: '', accent: '',
      rfcColors: { [OTRO]: 'oliva' } });
    assert.equal(segundo.json.settings.rfcColors[OWN], 'burdeos', 'asignar el segundo no pisa el primero');
    assert.equal(segundo.json.settings.rfcColors[OTRO], 'oliva', 'cada RFC con su color, sin mezcla');
    const estado = await call('GET', '/api/status');
    assert.equal(estado.json.settings.rfcColors[OWN], 'burdeos', 'el color viaja en el estado que el cliente descarga');
    const invalido = await call('POST', '/api/settings', { installName: '', senderName: '', accent: '',
      rfcColor: { rfc: OWN, color: 'neon' } });
    assert.equal(invalido.status, 400, 'fuera de la paleta cerrada: 400');
    const quitado = await call('POST', '/api/settings', { installName: '', senderName: '', accent: '',
      rfcColor: { rfc: OWN, color: '' } });
    assert.ok(!(OWN in (quitado.json.settings.rfcColors || {})), 'color vacío: el RFC vuelve al medallón neutro');
    console.log('OK 2.0·T2 · (b) servidor — color por RFC guardado, servido y validado contra la paleta.');
  } finally { service.close(); rmSync(dir, { recursive: true, force: true }); }
}

console.log('OK 2.0 · Tanda 2 completa.');
