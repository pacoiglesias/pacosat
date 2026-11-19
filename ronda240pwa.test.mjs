import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { URL as NodeURL } from 'node:url';
import { DOMParser } from '@xmldom/xmldom';
import { createPacoSATService } from './local-server.mjs';

/* ================================================================
   Ronda 2.4.0 · WPWA — castigo 23 (app instalable) + micro-dato
   de Bancos para el cierre de Hoy.
   23 · PWA: el manifiesto sale del propio servidor, público y
        sin sesión como /healthz, con el installName servido
        (respaldo «PacoSAT»), standalone y los colores del
        artefacto; los iconos del FARO responden en PNG de
        verdad (192, 512 y el apple-touch-icon de 180 que iOS
        exige) rasterizados en el servidor; el SW trae la
        versión del artefacto incrustada, cachea solo el
        cascarón y su exclusión de /api/* (y del carril del
        ejecutor) está fijada por texto; la cabecera del HTML
        enlaza manifiesto + apple-touch-icon + theme-color y
        el cliente registra el SW.
   Micro · overview() trae bancosSinConciliar240 por RFC, del
        mismo cálculo de conciliación de Bancos; el invitado
        solo recibe el de SU RFC y la respuesta entera no
        nombra al otro; la fila de Bancos de cierreMesPanel240
        pinta «Bancos: N movimientos sin conciliar» y entra
        en el veredicto con el campo, y conserva el texto
        honesto («ese dato no viaja a Hoy») sin él.
   ================================================================ */

const ROOT = import.meta.dirname;
const read = name => readFileSync(join(ROOT, name), 'utf8');
const html = read('Faro-Fiscal.html');
/* RE-BASE integración 2.4.0 (W6): satData lo puebla pollSat,
   que viaja en la parte diferida de Vigilancia. El arnés
   reproduce el camino del navegador: el fetch sirve las
   partes desde lazy.json, el head EJECUTA los scripts
   inyectados y bootCliente pide la parte de Vigilancia al
   cargador real tras el arranque. Ninguna aserción cambia. */
const lazy = JSON.parse(read('lazy.json'));
const VERSION = JSON.parse(read('package.json')).version;
const ORIGIN = 'https://pacosat.test';
const KEY = 'w'.repeat(64);
const A = 'AAA010101AAA', B = 'BBB010101BB1', PROV = 'CCC010101CC1';

function makeHarness(options = {}) {
  const clock = { t: Date.parse('2026-11-16T15:00:00Z') };
  const service = createPacoSATService({
    dbFile: ':memory:', html: '<html><head><!--PACOSAT_TOKEN--></head><body>prueba</body></html>',
    origin: ORIGIN, proxyKey: KEY, satDocRetryWaitMs: 5,
    makeConnector: () => ({ parser: DOMParser, connector: {
      request: async () => 'req-240pwa', check: async () => ({ status: 'finished', packages: [] }),
      download: async () => { throw new Error('sin paquetes'); } } }),
    makeMailer: () => ({ verify: async () => true, sendMail: async () => ({ messageId: 'm1' }) }),
    now: () => clock.t, ...options });
  let token = '';
  const raw = async (method, path, body, extraHeaders = {}) => {
    const chunks = []; if (body !== undefined) chunks.push(Buffer.from(JSON.stringify(body)));
    const req = Readable.from(chunks);
    req.method = method; req.url = path;
    req.headers = { host: 'pacosat.test', origin: ORIGIN, 'x-pacosat-proxy': KEY, ...extraHeaders };
    let status = 0; const headers = {}; const out = [];
    const res = { writeHead(code, hdrs) { status = code; if (hdrs) Object.assign(headers, hdrs); },
      setHeader(k, v) { headers[k] = v; }, getHeader(k) { return headers[k]; },
      end(chunk) { if (chunk) out.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))); } };
    await service.handle(req, res);
    const buf = Buffer.concat(out);
    let json = null; try { json = JSON.parse(buf.toString('utf8')); } catch { /* binario */ }
    return { status, headers, buf, json, text: buf.toString('utf8') };
  };
  const call = async (method, path, body, extraHeaders = {}) => {
    if (!token) { const home = await raw('GET', '/'); token = /[0-9a-f]{64}/.exec(home.text)?.[0] || ''; }
    return raw(method, path, body, { 'x-pacosat-token': token, ...extraHeaders });
  };
  return { service, call, raw, clock };
}

/* ================= 23 · Manifiesto, iconos y SW ================= */
{
  const h = makeHarness();
  /* Sin sesión (raw, sin token): público como /healthz. */
  const man = await h.raw('GET', '/manifest.webmanifest');
  assert.equal(man.status, 200, '(23) el manifiesto responde sin sesión');
  assert.match(man.headers['Content-Type'], /application\/manifest\+json/, '(23) el manifiesto va con su tipo');
  const manifest = man.json;
  assert.equal(manifest.name, 'PacoSAT', '(23) sin installName, el nombre de la instalación es el respaldo «PacoSAT»');
  assert.equal(manifest.short_name, 'PacoSAT', '(23) nombre corto');
  assert.equal(manifest.display, 'standalone', '(23) display standalone');
  assert.equal(manifest.start_url, '/', '(23) start_url la raíz');
  assert.equal(manifest.scope, '/', '(23) scope la raíz');
  assert.equal(manifest.theme_color, '#0e2a47', '(23) theme_color es el del artefacto (su theme-color)');
  assert.equal(manifest.background_color, '#0e2a47', '(23) background_color es el del artefacto');
  const porSrc = Object.fromEntries(manifest.icons.map(icono => [icono.src, icono]));
  assert.equal(porSrc['/icon-192.png']?.sizes, '192x192', '(23) el manifiesto declara el PNG de 192');
  assert.equal(porSrc['/icon-192.png']?.type, 'image/png', '(23) el de 192 es PNG');
  assert.equal(porSrc['/icon-512.png']?.sizes, '512x512', '(23) el manifiesto declara el PNG de 512');
  assert.equal(porSrc['/icon-512.png']?.type, 'image/png', '(23) el de 512 es PNG');
  assert.equal(porSrc['/apple-touch-icon.png']?.sizes, '180x180', '(23) el manifiesto declara el apple-touch-icon de 180');
  assert.equal(porSrc['/icon.svg']?.type, 'image/svg+xml', '(23) el SVG del faro sigue declarado donde el estándar lo admite');

  /* El nombre de la instalación es el installName SERVIDO. */
  const ajustes = await h.call('POST', '/api/settings', { installName: 'Faro de Prueba' });
  assert.equal(ajustes.status, 200, '(23) el ajuste del nombre responde');
  const man2 = await h.raw('GET', '/manifest.webmanifest');
  assert.equal(man2.json.name, 'Faro de Prueba', '(23) con installName servido, el manifiesto lo lleva como nombre');
  assert.equal(man2.json.short_name, 'PacoSAT', '(23) el nombre corto no cambia');

  /* Los iconos PNG responden 200, con su tipo, su tamaño real
     en la cabecera IHDR y el faro DIBUJADO (fondo de la casa y
     trazo dorado), no un PNG vacío o de relleno. */
  const { createCanvas, loadImage } = await import('@napi-rs/canvas');
  for (const [ruta, lado] of [['/icon-192.png', 192], ['/icon-512.png', 512], ['/apple-touch-icon.png', 180]]) {
    const icono = await h.raw('GET', ruta);
    assert.equal(icono.status, 200, '(23) ' + ruta + ' responde sin sesión');
    assert.equal(icono.headers['Content-Type'], 'image/png', '(23) ' + ruta + ' va como image/png');
    assert.ok(icono.headers['Cache-Control'], '(23) ' + ruta + ' lleva su caché');
    assert.equal(icono.buf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', '(23) ' + ruta + ' es un PNG de verdad');
    assert.equal(icono.buf.readUInt32BE(16), lado, '(23) ' + ruta + ' mide ' + lado + ' de ancho');
    assert.equal(icono.buf.readUInt32BE(20), lado, '(23) ' + ruta + ' mide ' + lado + ' de alto');
    const img = await loadImage(icono.buf);
    const lienzo = createCanvas(lado, lado);
    const ctx = lienzo.getContext('2d');
    ctx.drawImage(img, 0, 0, lado, lado);
    const datos = ctx.getImageData(0, 0, lado, lado).data;
    const centro = (Math.floor(lado / 2) * lado + Math.floor(lado / 2)) * 4;
    assert.deepEqual([datos[centro], datos[centro + 1], datos[centro + 2]], [14, 42, 71],
      '(23) ' + ruta + ' pinta el azul de la casa #0e2a47 en el centro');
    let dorados = 0;
    for (let i = 0; i < datos.length; i += 4)
      if (datos[i] > 200 && datos[i + 1] > 140 && datos[i + 2] < 130) dorados++;
    assert.ok(dorados > 100, '(23) ' + ruta + ' dibuja el faro dorado (' + dorados + ' píxeles)');
  }
  const svg = await h.raw('GET', '/icon.svg');
  assert.equal(svg.status, 200, '(23) el SVG del faro sigue respondiendo');
  assert.match(svg.headers['Content-Type'], /image\/svg\+xml/, '(23) el SVG va con su tipo');
  assert.ok(svg.text.includes('M12 2.6v1.5'), '(23) el SVG dibuja la geometría del faro');

  /* El SW: ruta y alcance correctos, versión incrustada, la
     exclusión de /api fijada por texto y el push conservado. */
  const sw = await h.raw('GET', '/sw.js');
  assert.equal(sw.status, 200, '(23) el SW responde sin sesión');
  assert.match(sw.headers['Content-Type'], /text\/javascript/, '(23) el SW va como JavaScript');
  assert.equal(sw.headers['Service-Worker-Allowed'], '/', '(23) el alcance del SW es la raíz');
  new vm.Script(sw.text);
  assert.ok(sw.text.includes('pacosat-casco-' + VERSION),
    '(23) la caché del cascarón lleva la versión del artefacto (' + VERSION + ')');
  assert.ok(sw.text.includes("p.startsWith('/api/')"),
    '(23) la exclusión de /api/* está escrita en el SW: la API jamás se cachea');
  assert.ok(sw.text.includes("p.startsWith('/api/executor/')"),
    '(23) el carril del ejecutor está excluido por su propio nombre');
  assert.ok(sw.text.includes("if (esApi240(u.pathname) || esEjecutor240(u.pathname)) return;"),
    '(23) el fetch del SW devuelve sin interceptar cuando la ruta es de API o del ejecutor');
  assert.ok(sw.text.includes('cache.addAll(CASCO240)') && sw.text.includes("'/manifest.webmanifest'"),
    '(23) el SW registra el cascarón (manifiesto e iconos) al instalarse');
  assert.ok(sw.text.includes('pacosat-token'),
    '(23) el HTML cacheado se guarda sin la meta del token (la lección de la 1.9.0)');
  assert.ok(sw.text.includes("addEventListener('push'"), '(23) el push de la 1.25.0 se conserva');
  assert.ok(sw.text.includes("addEventListener('fetch'"), '(23) el SW tiene su fetch sobrio');

  /* La cabecera del HTML enlaza todo y el cliente registra. */
  assert.ok(html.includes('<link rel="manifest" href="/manifest.webmanifest">'),
    '(23) la cabecera enlaza el manifiesto');
  assert.ok(html.includes('<link rel="apple-touch-icon" href="/apple-touch-icon.png">'),
    '(23) la cabecera enlaza el apple-touch-icon (iOS lo pide en el HTML, no en el manifiesto)');
  assert.ok(html.includes('<meta name="theme-color" id="theme-color-meta" content="#0e2a47">'),
    '(23) la cabecera lleva el theme-color del artefacto');
  assert.ok(html.includes("navigator.serviceWorker.register('/sw.js')"),
    '(23) el cliente registra el SW desde su arranque, con su guarda de compatibilidad');
  console.log('OK 2.4.0·WPWA (23) — PWA instalable: manifiesto con installName, faro en PNG (192/512/180), SW por versión que jamás toca /api.');
}

/* ================= Micro · Bancos sin conciliar por RFC ================= */
{
  let textoEstado = '';
  const h = makeHarness({ extractText: async () => textoEstado });
  const pdf64 = Buffer.from('%PDF-1.7 estado de juguete ' + 'x'.repeat(120)).toString('base64');
  await h.call('POST', '/api/storage', { batch: {
    people: [{ id: A, name: 'Empresa A' }, { id: B, name: 'Empresa B' }],
    invoices: [{ id: '11111111-1111-4111-8111-111111111111', date: '2026-10-05', kind: 'I', currency: 'MXN',
      total: '116.00', from: { rfc: PROV, name: 'Proveedor' }, to: { rfc: A, name: 'Empresa A' },
      fiscal: { paymentMethod: 'PPD', transferred: [], withheld: [] } }] } });
  for (const rfc of [A, B]) {
    const open = await h.call('POST', '/api/unlock', { rfc, minutes: 1440, days: 7,
      direction: 'both', password: 'simulated', certificate: 'YQ==', key: 'Yg==' });
    assert.equal(open.status, 200, '(micro) unlock de ' + rfc);
  }
  assert.equal((await h.call('POST', '/api/banks/accounts',
    { bank: 'BBVA', name: 'Chequera A', kind: 'cuenta', numero: '012180001234567590', rfc: A })).status, 200);
  assert.equal((await h.call('POST', '/api/banks/accounts',
    { bank: 'BBVA', name: 'Chequera B', kind: 'cuenta', numero: '012180009876543218', rfc: B })).status, 200);
  /* A: dos cargos sin factura (2) + una factura recibida sin
     pago visto (1) = 3 sin conciliar. B: un cargo = 1. */
  textoEstado = ['BBVA MEXICO · ESTADO DE CUENTA', 'Cuenta 012180001234567590',
    'Periodo del 01/10/2026 al 31/10/2026', 'Saldo inicial $20,000.00', 'Saldo final $17,890.00',
    'Total de abonos $0.00', 'Total de cargos $2,110.00',
    '05/10/2026 COMISIÓN POR MANEJO $250.00 $19,750.00',
    '06/10/2026 PAGO A PROVEEDOR $1,860.00 $17,890.00'].join('\n');
  assert.equal((await h.call('POST', '/api/banks/statements/auto', { content: pdf64 })).json.aplicados, 2,
    '(micro) el estado de A aplica sus dos movimientos');
  textoEstado = ['BBVA MEXICO · ESTADO DE CUENTA', 'Cuenta 012180009876543218',
    'Periodo del 01/10/2026 al 31/10/2026', 'Saldo inicial $5,000.00', 'Saldo final $4,300.00',
    'Total de abonos $0.00', 'Total de cargos $700.00',
    '07/10/2026 COMISION SPEI ENVIADO $700.00 $4,300.00'].join('\n');
  assert.equal((await h.call('POST', '/api/banks/statements/auto', { content: pdf64 })).json.aplicados, 1,
    '(micro) el estado de B aplica su movimiento');

  /* El conteo es EL de la conciliación de Bancos, no otro. */
  const conc = await h.call('GET', '/api/banks/conciliacion');
  const deConciliacion = {};
  for (const cuenta of conc.json.porCuenta || [])
    deConciliacion[cuenta.account.rfc] = (deConciliacion[cuenta.account.rfc] || 0) +
      cuenta.conteos.facturasSinPagoVisto + cuenta.conteos.pagosSinFactura;
  assert.deepEqual(deConciliacion, { [A]: 3, [B]: 1 }, '(micro) el juguete deja 3 sin conciliar en A y 1 en B');
  const status = await h.call('GET', '/api/status');
  assert.deepEqual(status.json.bancosSinConciliar240, deConciliacion,
    '(micro) overview() trae el MISMO conteo de la conciliación, por RFC');
  assert.deepEqual(status.json.bancosSinConciliar240, { [A]: 3, [B]: 1 },
    '(micro) el conteo de juguete sale por RFC: A=3, B=1');

  /* Invitado con alcance [A]: solo le llega el suyo y la
     respuesta ENTERA no nombra al otro RFC (D-3). */
  assert.equal((await h.call('POST', '/api/guest/config',
    { password: 'clave-invitado-1', enabled: true, rfcs: [A] })).status, 200);
  const login = await h.raw('POST', '/api/guest/login', { password: 'clave-invitado-1' });
  assert.ok(login.json?.token, '(micro) el invitado entra');
  const guest = await h.raw('GET', '/api/status', undefined, { 'x-pacosat-token': login.json.token });
  assert.equal(guest.status, 200, '(micro) el invitado lee su estado');
  assert.deepEqual(guest.json.bancosSinConciliar240, { [A]: 3 },
    '(micro) al invitado solo le llega el conteo de SU RFC');
  assert.ok(!guest.text.includes(B),
    '(micro) la respuesta entera del invitado no nombra al otro RFC');
  console.log('OK 2.4.0·WPWA (micro) — bancosSinConciliar240 por RFC, del cálculo de Bancos, con su disposición D-3.');
}

/* ================= Micro · La fila de Hoy ================= */
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
function makeBootContext(statusBody) {
  const byId = new Map();
  const oyentes = new Map();
  const metas = { 'meta[name="pacosat-token"]': { content: 'token-de-prueba' },
    'meta[name="pacosat-cloud"]': { content: '1' } };
  const headEl = new FakeElement('head');
  const holder = {};
  /* El head ejecuta los scripts inyectados (las partes
     diferidas), como el navegador al aterrizar una parte. */
  headEl.appendChild = kid => {
    if (kid && typeof kid.textContent === 'string' && kid.textContent && holder.context)
      vm.runInContext(kid.textContent, holder.context, { filename: 'parte-diferida' });
    return kid;
  };
  const documentStub = {
    __oyentes: oyentes,
    getElementById: id => {
      if (!byId.has(id)) byId.set(id, new FakeElement('div'));
      return byId.get(id);
    },
    createElement: tag => new FakeElement(tag),
    createElementNS: (_ns, tag) => new FakeElement(tag),
    createTextNode: text => ({ textContent: String(text) }),
    querySelector: selector => metas[selector] ?? null,
    querySelectorAll: () => [],
    addEventListener: (type, fn) => { if (!oyentes.has(type)) oyentes.set(type, []); oyentes.get(type).push(fn); },
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
    if (target.includes('storage/rev')) body = { rev: 1 };
    else if (target.includes('storage?')) body = [];
    else if (target.includes('/api/status')) body = statusBody;
    return { ok: true, status: 200, headers: { get: () => 'application/json' },
      json: async () => body, text: async () => JSON.stringify(body), blob: async () => new Blob([]) };
  };
  const timer = (fn, ms, ...args) => { const t = setTimeout(fn, ms, ...args); t.unref?.(); return t; };
  const every = (fn, ms, ...args) => { const t = setInterval(fn, ms, ...args); t.unref?.(); return t; };
  const context = vm.createContext({
    console, document: documentStub,
    navigator: { onLine: true, userAgent: 'ronda240pwa-test' },
    location: { href: 'http://127.0.0.1:43729/', search: '', reload: () => {} },
    localStorage: storageStub(), sessionStorage: storageStub(),
    fetch: fetchStub, setTimeout: timer, setInterval: every,
    clearTimeout, clearInterval, queueMicrotask,
    URL: BootURL, URLSearchParams, Blob, File, TextEncoder, TextDecoder, btoa, atob,
    crypto: webcrypto, DecompressionStream,
    matchMedia: () => ({ matches: false, addEventListener: () => {}, addListener: () => {} }),
    Option: class extends FakeElement {},
    alert: () => {}, addEventListener: () => {}, removeEventListener: () => {},
    requestAnimationFrame: fn => timer(fn, 0),
    requestIdleCallback: fn => timer(() => fn({ didTimeout: false, timeRemaining: () => 50 }), 0)
  });
  context.window = context;
  context.self = context;
  holder.context = context;
  return context;
}
const textoDe = el => {
  let texto = el.textContent || '';
  for (const hijo of el.children || []) texto += ' ' + textoDe(hijo);
  return texto;
};
async function bootCliente(statusBody) {
  const context = makeBootContext(statusBody);
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  vm.runInContext(script, context, { filename: 'Faro-Fiscal.html#script' });
  for (let i = 0; i < 12; i++) await new Promise(resolve => setTimeout(resolve, 0));
  /* RE-BASE integración 2.4.0: el cargador real trae Vigilancia
     —y antes Descargas— y su pulso puebla satData con el estado
     servido, como en producción al arrancar. */
  await vm.runInContext("ensureLazyPart('monitor')", context);
  for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 0));
  return context;
}
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 0)); };
const MFI = 'MFI6212158B4', CLI = 'CLI010101AA1';
const hoyD = new Date();
const claveMes = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
const MES_PREVIO = claveMes(new Date(hoyD.getFullYear(), hoyD.getMonth() - 1, 1));
const invPue = { id: 'u-mfi', kind: 'I', date: MES_PREVIO + '-05', total: '500.00', currency: 'MXN',
  from: { rfc: MFI, name: 'Mano Fil, S.A.' }, to: { rfc: CLI, name: 'Cliente Uno' },
  fiscal: { serie: 'A', folio: '1', paymentMethod: 'PUE', paymentForm: '03', transferred: [], withheld: [] },
  concepts: [] };
const baseStatus = { settings: { installName: 'PacoSAT', hasLogo: false },
  buildModified: null, cloudRevision: null, profiles: [], jobs: [], inbox: [], mail: {} };

{
  /* Con el campo: la fila enseña el conteo y el veredicto lo suma. */
  const ctx = await bootCliente({ ...baseStatus, bancosSinConciliar240: { [MFI]: 2 } });
  ctx.Node = FakeElement;
  vm.runInContext(`scope = ""; people = [{ id: "${MFI}", name: "Mano Fil, S.A." }];
    invoices = ${JSON.stringify([invPue])}; documents = []; activity = [];
    satApi = async ruta => ruta === "lists" ? { sources: [{ fetched: ${Date.now()}, label: "69-B" }], counterparts: [] } : {};`, ctx);
  const datos = vm.runInContext(`cierreDatos240("${MFI}")`, ctx);
  assert.equal(datos.bancosSin, 2, '(micro) cierreDatos240 lee el conteo del estado global por RFC');
  const tarjeta = vm.runInContext('cierreMesPanel240()', ctx);
  await flush();
  const texto = textoDe(tarjeta);
  assert.ok(texto.includes('Bancos: 2 movimientos sin conciliar'),
    '(micro) la fila de Bancos enseña «Bancos: 2 movimientos sin conciliar»: ' + texto.slice(0, 300));
  assert.ok(texto.includes('Mano Fil, S.A.: falta 2 movimientos sin conciliar en Bancos.'),
    '(micro) el conteo entra en el veredicto como las demás filas');
  const fila = buscar(tarjeta, e => e.dataset && e.dataset.cierreBancos240 === MFI);
  assert.equal(fila.length, 1, '(micro) la fila de Bancos del RFC está en la tarjeta');
  console.log('OK 2.4.0·WPWA (micro) — la fila de Bancos de Hoy pinta el conteo servido y entra en el veredicto.');
}
{
  /* Sin el campo: el texto honesto de siempre, y nada en el veredicto. */
  const ctx = await bootCliente({ ...baseStatus });
  ctx.Node = FakeElement;
  vm.runInContext(`scope = ""; people = [{ id: "${MFI}", name: "Mano Fil, S.A." }];
    invoices = ${JSON.stringify([invPue])}; documents = []; activity = [];
    satApi = async ruta => ruta === "lists" ? { sources: [{ fetched: ${Date.now()}, label: "69-B" }], counterparts: [] } : {};`, ctx);
  const datos = vm.runInContext(`cierreDatos240("${MFI}")`, ctx);
  assert.equal(datos.bancosSin, null, '(micro) sin el campo en el estado, el conteo queda null (no consta)');
  const tarjeta = vm.runInContext('cierreMesPanel240()', ctx);
  await flush();
  const texto = textoDe(tarjeta);
  assert.ok(texto.includes('Se ve en Bancos') && texto.includes('ese dato no viaja a Hoy'),
    '(micro) sin el campo, la fila conserva el texto honesto de WC4b1');
  assert.ok(!texto.includes('movimientos sin conciliar'),
    '(micro) sin el campo, ningún conteo de Bancos se inventa ni entra en el veredicto');
  assert.ok(texto.includes('Mano Fil, S.A.: todo listo para cerrar el mes.'),
    '(micro) sin faltas conocidas, el veredicto es «todo listo»');
  console.log('OK 2.4.0·WPWA (micro) — sin el campo, la fila de Bancos conserva su texto honesto y no inventa el conteo.');
}

console.log('OK 2.4.0 · WPWA — app instalable (faro en PNG, SW seguro por versión) y micro-dato de Bancos en Hoy.');
