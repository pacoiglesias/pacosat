import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { webcrypto } from 'node:crypto';
import * as vm from 'node:vm';

/* ================================================================

/* ================================================================
   Ronda 2.9.14 · BUZÓN — los puntos 6 y 7 del añadido (reporte
   de Paco en vivo, 18 nov 22:04: tocó «Leer» y «no desplegó
   nada»; el diagnóstico contra la app real midió la ruta
   sana: la misma llamada devolvió el cuerpo en 68,4 s — el
   defecto era de superficie: un minuto sin marcha visible y
   un resultado que solo vivía en un diálogo del momento).

   (P) PURO · el comunicado-puntero: con el cuerpo REAL del
       folio …0004 (86 caracteres y su «da clic aquí») la
       decisión devuelve el href; con un comunicado normal
       (texto largo con un enlace dentro), sin enlaces, con
       dos enlaces o con un esquema que no es http(s), no se
       sigue nada. Y el veredicto del destino clasifica:
       texto / formulario / descarga / sin cargar.
   (R) RUTA · el detalle enlazado que el paseo trae viaja en
       la respuesta de /api/buzon/comunicado; sin puntero, la
       respuesta no trae detalle (null).
   (C) CLIENTE · la marcha se ve y el resultado no se pierde:
       con la respuesta del paseo RETENIDA, la tarjeta enseña
       «Leyendo en el Buzón…» y el aviso del minuto; al
       llegar, el cuerpo queda FIJADO en la tarjeta (con el
       «El detalle que enlaza este comunicado:» si lo trae) y
       también en el diálogo; salir y volver lo repinta desde
       el almacén SIN pedirlo otra vez; «Cerrar» lo repliega.
       Y si el paseo falla, el motivo queda escrito en la
       tarjeta tras salir y volver.

   Contra la 2.9.13 esta suite corre en ROJO: no existían ni
   la decisión de puntero, ni el detalle en la ruta, ni la
   zona de lectura en la tarjeta.
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
const ORIGIN = 'https://pacosat.test';
const KEY = 'c'.repeat(64);

/* ================================================================
   (P) · PURO — la decisión de puntero y el veredicto del
   destino, con el cuerpo real del folio …0004.
   ================================================================ */
import { buzonEnlacePuntero2914, buzonDestinoEnlace2914 } from './sat-tributario.mjs';
{
  const CUERPO_REAL = 'Para consultar los detalles del registro de tu mecanismo de comunicación da clic aquí.';
  const HREF = 'https://wwwmat.sat.gob.mx/iniciar-expediente/mis-comunicados/detalle-del-mecanismo';
  assert.equal(buzonEnlacePuntero2914(CUERPO_REAL, [{ href: HREF, texto: 'da clic aquí' }]), HREF,
    '(P) el caso real — 86 caracteres y un «da clic aquí» — ES un puntero: se sigue su enlace');
  const normal = 'Estimado contribuyente: se le informa que su solicitud de registro de medios de contacto ' +
    'fue recibida y quedó asentada en el expediente. Para cualquier aclaración sobre este trámite, ' +
    'da clic aquí y presente su folio en la oficina que le corresponda. Este mensaje es informativo.';
  assert.equal(buzonEnlacePuntero2914(normal, [{ href: HREF, texto: 'da clic aquí' }]), null,
    '(P) un comunicado normal con un enlace entre sus párrafos NO es un puntero: no se sigue nada');
  assert.equal(buzonEnlacePuntero2914(CUERPO_REAL, []), null, '(P) sin enlaces no hay puntero');
  assert.equal(buzonEnlacePuntero2914(CUERPO_REAL,
    [{ href: HREF, texto: 'da clic aquí' }, { href: HREF + '-2', texto: 'otro enlace' }]), null,
    '(P) con dos enlaces no hay un único puntero: no se sigue ninguno');
  assert.equal(buzonEnlacePuntero2914(CUERPO_REAL, [{ href: 'javascript:void(0)', texto: 'da clic aquí' }]), null,
    '(P) un esquema que no es http(s) no viaja');
  assert.deepEqual(buzonDestinoEnlace2914({ texto: 'Detalle del registro: tu correo quedó confirmado.' }),
    { estado: 'texto', texto: 'Detalle del registro: tu correo quedó confirmado.' },
    '(P) destino con texto: su texto es el detalle');
  assert.deepEqual(buzonDestinoEnlace2914({ texto: 'Captura tus datos', esFormulario: true }),
    { estado: 'formulario', texto: '' }, '(P) destino formulario: se nombra, no se inventa');
  assert.deepEqual(buzonDestinoEnlace2914({ esDescarga: true }),
    { estado: 'descarga', texto: '' }, '(P) destino descarga: se nombra, no se inventa');
  assert.deepEqual(buzonDestinoEnlace2914(null), { estado: 'sin-cargar', texto: '' },
    '(P) destino que no cargó: se dice, no se inventa');
  assert.deepEqual(buzonDestinoEnlace2914({ texto: '   ' }), { estado: 'sin-cargar', texto: '' },
    '(P) destino sin texto legible: no consta');
  console.log('OK 2.9.14-buzón · (P) — puntero: el caso real se sigue; el normal, no. Destino: texto/formulario/descarga/sin cargar.');
}

/* ================================================================
   (R) · RUTA — el detalle enlazado viaja en la respuesta.
   ================================================================ */
import { Readable } from 'node:stream';
import { DOMParser } from '@xmldom/xmldom';
import { createPacoSATService } from './local-server.mjs';
{
  const satTribFetch = async (_profile, _query, options = {}) => {
    const base = { notifications: [], comunicadosNoLeidos: 1,
      comunicados: { concluyente: true, soloConteos: false, noLeidos: 1, leidos: 0, items: [] },
      documentos: { concluyente: true, items: [] } };
    if (options.abrirComunicado?.folio === 'PUNTERO-2914')
      return { ...base, comunicadoAbierto: { folio: 'PUNTERO-2914', asunto: 'Medios de contacto',
        fecha: '2026-08-28 12:20', abierto: true,
        cuerpo: 'Para consultar los detalles del registro de tu mecanismo de comunicación da clic aquí.',
        enlaceDetalle: { estado: 'texto', texto: 'Detalle del registro: tu correo quedó confirmado.' } } };
    if (options.abrirComunicado?.folio === 'NORMAL-2914')
      return { ...base, comunicadoAbierto: { folio: 'NORMAL-2914', asunto: 'Aviso', fecha: '2026-08-28 12:20',
        abierto: true, cuerpo: 'Cuerpo completo del comunicado, sin puntero.' } };
    return { ...base, comunicadoAbierto: null };
  };
  const service = createPacoSATService({ dbFile: ':memory:',
    html: '<html><head><!--PACOSAT_TOKEN--></head><body>prueba</body></html>',
    origin: ORIGIN, proxyKey: KEY, executorMode: 'nas', satTribFetch,
    makeConnector: () => ({ parser: DOMParser, connector: {
      request: async () => 'req-2914', check: async () => ({ status: 'pending', packages: [] }),
      download: async () => { throw new Error('sin paquetes'); } } }),
    makeMailer: () => ({ verify: async () => true, sendMail: async () => ({ messageId: 'm1' }) }),
    now: () => Date.parse('2026-11-18T15:00:00Z') });
  let token = '';
  const call = async (method, path, body) => {
    const chunks = []; if (body !== undefined) chunks.push(Buffer.from(JSON.stringify(body)));
    const req = Readable.from(chunks);
    req.method = method; req.url = path;
    req.headers = { host: 'pacosat.test', origin: ORIGIN, 'x-pacosat-proxy': KEY,
      ...(token ? { 'x-pacosat-token': token } : {}) };
    let status = 0; let text = '';
    const res = { writeHead(c) { status = c; }, setHeader() {}, getHeader() { return undefined; },
      end(ch) { if (ch) text += Buffer.isBuffer(ch) ? ch.toString('latin1') : ch; } };
    if (!token) {
      const homeReq = Readable.from([]); homeReq.method = 'GET'; homeReq.url = '/';
      homeReq.headers = { host: 'pacosat.test', origin: ORIGIN, 'x-pacosat-proxy': KEY };
      let homeText = '';
      const homeRes = { writeHead() {}, setHeader() {}, getHeader() { return undefined; },
        end(ch) { if (ch) homeText += Buffer.isBuffer(ch) ? ch.toString('latin1') : ch; } };
      await service.handle(homeReq, homeRes);
      token = /[0-9a-f]{64}/.exec(homeText)?.[0] || '';
      req.headers['x-pacosat-token'] = token;
    }
    await service.handle(req, res);
    let json = null; try { json = JSON.parse(text); } catch { /* binario */ }
    return { status, json, text };
  };
  try {
    const puntero = await call('POST', '/api/buzon/comunicado', { rfc: OWN, folio: 'PUNTERO-2914' });
    assert.equal(puntero.json.ok, true, '(R) el comunicado puntero se abre');
    assert.deepEqual(puntero.json.detalleEnlace,
      { estado: 'texto', texto: 'Detalle del registro: tu correo quedó confirmado.' },
      '(R) y el texto de la página enlazada viaja en la respuesta como detalleEnlace');
    const normal = await call('POST', '/api/buzon/comunicado', { rfc: OWN, folio: 'NORMAL-2914' });
    assert.equal(normal.json.ok, true, '(R) el comunicado normal se abre');
    assert.equal(normal.json.detalleEnlace, null,
      '(R) sin puntero no se siguió nada: detalleEnlace es null');
    console.log('OK 2.9.14-buzón · (R) — la ruta entrega el detalle enlazado; sin puntero, null.');
  } finally { service.close(); }
}

/* ================================================================
   (C) · CLIENTE — la marcha se ve y el resultado no se pierde.
   ================================================================ */
const FOLIO_C = 'MFI6212158B40004';
const VISTA_TRIB = { rfc: OWN, notificaciones: [], papelera: [], papeleraTotal: 0,
  sinAbrir: 0, total: 0, ultimaConsulta: 1760000000000,
  comunicadosNoLeidos: 1, comunicadosFecha: 1760000000000,
  buzonCompleto240: { at: 1760000000000,
    comunicados: { concluyente: true, soloConteos: false, noLeidos: 1, leidos: 0,
      items: [{ fecha: '2026-08-28 12:20', asunto: 'Registro o actualización de medios de contacto',
        folio: FOLIO_C, leido: false }] },
    documentos: { concluyente: true, items: [] } },
  progreso: {}, runs: [] };
async function pintarBuzon2914(b) {
  vm.runInContext(
    'scope = ' + JSON.stringify(OWN) + ';' +
    'people = [{ id: "' + OWN + '", name: "Empresa ' + OWN + '" }];' +
    'invoices = []; documents = []; activity = []; tribCache = null;' +
    'satData = { profiles: [], jobs: [], criteriaBook: [], mail: {},' +
    ' puerta: {}, ejecutor: {}, metadata: { records: 0, missing: [], lastSeen: null },' +
    ' coverage: { groups: [], gaps: [], days: {}, records: [] }, tributario: {} };', b.context);
  await vm.runInContext("ensureLazyPart('buzon')", b.context);
  await asentar(40);
  const els = vm.runInContext('tributarioScreen()', b.context);
  const raiz = b.context.document.createElement('div');
  raiz.append(...els);
  await asentar(60);
  return { raiz, els };
}
const botonLeer = raiz => andar(raiz).find(el =>
  el.tagName === 'BUTTON' && (el.textContent || '').trim() === 'Leer');
const zonaDe = (raiz, folio) => andar(raiz).find(el => el.dataset.buzonLectura2914 === folio);

{
  let resolverComunicado = null;
  let llamadasComunicado = 0;
  const b = await bootCliente2912({ responder: async target => {
    if (target.includes('/api/buzon/comunicado')) {
      llamadasComunicado++;
      const cuerpo = await new Promise(res => { resolverComunicado = res; });
      return { body: cuerpo };
    }
    if (target.includes('/api/tributario')) return { body: VISTA_TRIB };
    if (target.includes('/api/status')) return { body: { settings: { installName: 'PacoSAT', hasLogo: false },
      buildModified: null, cloudRevision: null, profiles: [], jobs: [], inbox: [], mail: {},
      puerta: {}, ejecutor: {}, backupHealth: { enabled: false } } };
    return undefined;
  } });
  const { raiz } = await pintarBuzon2914(b);
  const leer = botonLeer(raiz);
  assert.ok(leer, '(C) la tarjeta del comunicado sin leer trae su «Leer»');
  const pulsacion = leer.onclick();
  await asentar(30);
  /* La marcha se VE mientras el paseo no vuelve. */
  const zonaMarcha = zonaDe(raiz, FOLIO_C);
  assert.ok(zonaMarcha, '(C) durante la lectura la tarjeta tiene su zona de lectura');
  const textoMarcha = textoDe(zonaMarcha);
  assert.ok(textoMarcha.includes('Leyendo en el Buzón'), '(C) la fase se lee en la tarjeta, no solo en el botón');
  assert.ok(textoMarcha.includes('alrededor de un minuto'), '(C) y el aviso llano de duración está desde el primer momento');
  assert.ok(textoMarcha.includes('quedará abierto aquí'), '(C) y dice que el resultado quedará en la tarjeta');
  const leerEnMarcha = andar(raiz).find(el => el.tagName === 'BUTTON' && (el.textContent || '').trim() === 'Leyendo…');
  assert.ok(leerEnMarcha && leerEnMarcha.disabled, '(C) el botón queda en «Leyendo…» y deshabilitado');
  /* Vuelve el paseo: el cuerpo queda fijado Y sale el diálogo. */
  resolverComunicado({ ok: true, folio: FOLIO_C,
    asunto: 'Registro o actualización de medios de contacto', fecha: '2026-08-28 12:20',
    cuerpo: 'Para consultar los detalles del registro de tu mecanismo de comunicación da clic aquí.',
    detalleEnlace: { estado: 'texto', texto: 'Detalle del registro: tu correo quedó confirmado.' } });
  await pulsacion;
  await asentar(30);
  const zonaOk = zonaDe(raiz, FOLIO_C);
  assert.ok(zonaOk, '(C) al volver, la zona de lectura sigue en la tarjeta');
  const textoOk = textoDe(zonaOk);
  assert.ok(textoOk.includes('da clic aquí'), '(C) el cuerpo quedó FIJADO en la tarjeta');
  assert.ok(textoOk.includes('El detalle que enlaza este comunicado:'), '(C) con su detalle enlazado nombrado');
  assert.ok(textoOk.includes('tu correo quedó confirmado'), '(C) y el texto destino dentro');
  assert.ok(textoDe(b.campos()).includes('da clic aquí'), '(C) el diálogo del momento también salió, como antes');
  /* Salir y volver: se repinta desde el almacén, sin pedir otra vez. */
  const vuelta = await pintarBuzon2914(b);
  const zonaVuelta = zonaDe(vuelta.raiz, FOLIO_C);
  assert.ok(zonaVuelta && textoDe(zonaVuelta).includes('da clic aquí'),
    '(C) salir y volver NO pierde el comunicado: sigue abierto en su tarjeta');
  assert.equal(llamadasComunicado, 1, '(C) y no se volvió a pedir al paseo: una sola llamada');
  /* Cerrar lo repliega. */
  const cerrar = andar(zonaVuelta).find(el => el.dataset.buzonLecturaCerrar2914 === '1');
  assert.ok(cerrar, '(C) la tarjeta fijada trae su «Cerrar»');
  await cerrar.onclick();
  await asentar(20);
  assert.ok(!zonaDe(vuelta.raiz, FOLIO_C), '(C) Cerrar repliega el comunicado de su tarjeta');
  console.log('OK 2.9.14-buzón · (C) — marcha visible con su aviso, cuerpo fijado que sobrevive a salir y volver, Cerrar que repliega.');
}
{
  const b = await bootCliente2912({ responder: async target => {
    if (target.includes('/api/buzon/comunicado'))
      return { body: { ok: false, error: 'El portal no respondió en esta visita.' } };
    if (target.includes('/api/tributario')) return { body: VISTA_TRIB };
    if (target.includes('/api/status')) return { body: { settings: { installName: 'PacoSAT', hasLogo: false },
      buildModified: null, cloudRevision: null, profiles: [], jobs: [], inbox: [], mail: {},
      puerta: {}, ejecutor: {}, backupHealth: { enabled: false } } };
    return undefined;
  } });
  const { raiz } = await pintarBuzon2914(b);
  await botonLeer(raiz).onclick();
  await asentar(30);
  const zonaError = zonaDe(raiz, FOLIO_C);
  assert.ok(zonaError, '(C-error) si el paseo falla, la tarjeta guarda la zona con el motivo');
  assert.ok(textoDe(zonaError).includes('No se pudo leer este comunicado: El portal no respondió en esta visita.'),
    '(C-error) el motivo queda ESCRITO en la tarjeta, no solo en un aviso pasajero');
  const vuelta = await pintarBuzon2914(b);
  assert.ok(zonaDe(vuelta.raiz, FOLIO_C), '(C-error) y sigue escrito tras salir y volver');
  console.log('OK 2.9.14-buzón · (C-error) — el motivo del fallo queda escrito en la tarjeta.');
}

/* ================================================================
   (S) · SERVIDOR — la copia de lectura queda GUARDADA y la
   vista la sirve sin paseo nuevo (la precisión del punto 6:
   el fijado es CON RESPALDO EN EL SERVIDOR, porque una
   pestaña descartada por iOS durante el paseo no vuelve
   nunca y el almacén de sesión no la rescata).
   ================================================================ */
{
  const CUERPO_S = 'Para consultar los detalles del registro de tu mecanismo de comunicación da clic aquí.';
  const DETALLE_S = { estado: 'texto', texto: 'Detalle del registro: tu correo quedó confirmado.' };
  let paseos = 0;
  const satTribFetchS = async (_profile, _query, options = {}) => {
    paseos++;
    const base = { notifications: [], comunicadosNoLeidos: 1,
      comunicados: { concluyente: true, soloConteos: false, noLeidos: 1, leidos: 0, items: [] },
      documentos: { concluyente: true, items: [] } };
    if (options.abrirComunicado?.folio === FOLIO_C)
      return { ...base, comunicadoAbierto: { folio: FOLIO_C,
        asunto: 'Registro o actualización de medios de contacto', fecha: '2026-08-28 12:20',
        cuerpo: CUERPO_S, abierto: true, enlaceDetalle: DETALLE_S } };
    return { ...base, comunicadoAbierto: null };
  };
  const service = createPacoSATService({ dbFile: ':memory:',
    html: '<html><head><!--PACOSAT_TOKEN--></head><body>prueba</body></html>',
    origin: ORIGIN, proxyKey: KEY, executorMode: 'nas', satTribFetch: satTribFetchS,
    makeConnector: () => ({ parser: DOMParser, connector: {
      request: async () => 'req-2914', check: async () => ({ status: 'pending', packages: [] }),
      download: async () => { throw new Error('sin paquetes'); } } }),
    makeMailer: () => ({ verify: async () => true, sendMail: async () => ({ messageId: 'm1' }) }),
    now: () => Date.parse('2026-11-18T15:00:00Z') });
  let tokenS = '';
  const callS = async (method, path, body) => {
    if (!tokenS) {
      const homeReq = Readable.from([]); homeReq.method = 'GET'; homeReq.url = '/';
      homeReq.headers = { host: 'pacosat.test', origin: ORIGIN, 'x-pacosat-proxy': KEY };
      let homeText = '';
      const homeRes = { writeHead() {}, setHeader() {}, getHeader() { return undefined; },
        end(ch) { if (ch) homeText += Buffer.isBuffer(ch) ? ch.toString('latin1') : ch; } };
      await service.handle(homeReq, homeRes);
      tokenS = /[0-9a-f]{64}/.exec(homeText)?.[0] || '';
    }
    const chunks = []; if (body !== undefined) chunks.push(Buffer.from(JSON.stringify(body)));
    const req = Readable.from(chunks);
    req.method = method; req.url = path;
    req.headers = { host: 'pacosat.test', origin: ORIGIN, 'x-pacosat-proxy': KEY, 'x-pacosat-token': tokenS };
    let status = 0; let text = '';
    const res = { writeHead(c) { status = c; }, setHeader() {}, getHeader() { return undefined; },
      end(ch) { if (ch) text += Buffer.isBuffer(ch) ? ch.toString('latin1') : ch; } };
    await service.handle(req, res);
    let json = null; try { json = JSON.parse(text); } catch { /* binario */ }
    return { status, json, text };
  };
  try {
    const antes = await callS('GET', '/api/tributario?rfc=' + OWN);
    assert.deepEqual(antes.json.lecturasAqui2914, {}, '(S) antes de leer, el almacén de la vista está vacío');
    const leido = await callS('POST', '/api/buzon/comunicado', { rfc: OWN, folio: FOLIO_C });
    assert.equal(leido.json.ok, true, '(S) Leer abre el comunicado');
    assert.equal(paseos, 1, '(S) con exactamente un paseo');
    const vista = await callS('GET', '/api/tributario?rfc=' + OWN);
    const guardada = vista.json.lecturasAqui2914?.[FOLIO_C];
    assert.ok(guardada, '(S) la vista trae la copia guardada de la lectura');
    assert.equal(guardada.cuerpo, CUERPO_S,
      '(S) el cuerpo servido desde el almacén es BYTE A BYTE el que trajo el paseo');
    assert.deepEqual(guardada.detalleEnlace, DETALLE_S, '(S) y el detalle del puntero quedó guardado con él');
    assert.ok(guardada.leidoAquiEn > 0, '(S) con su «cuándo se leyó aquí»');
    const vista2 = await callS('GET', '/api/tributario?rfc=' + OWN);
    assert.equal(vista2.json.lecturasAqui2914[FOLIO_C].cuerpo, CUERPO_S,
      '(S) el «Ver» se sirve de la vista-almacén las veces que haga falta');
    assert.equal(paseos, 1, '(S) SIN paseo nuevo: el contador de paseos sigue en 1 (el «Ver» no camina)');
    console.log('OK 2.9.14-buzón · (S) — Leer guarda en el servidor; la vista sirve la copia byte a byte sin paseo nuevo.');
  } finally { service.close(); }
}

/* ================================================================
   (C2) · CLIENTE, PÁGINA NUEVA — el corte total: otra página
   (otro contexto, sin memoria de sesión) enseña el «Leído
   aquí» desde el respaldo del servidor y su «Ver» despliega
   el cuerpo SIN ninguna llamada al paseo.
   ================================================================ */
{
  const CUERPO_C2 = 'Para consultar los detalles del registro de tu mecanismo de comunicación da clic aquí.';
  const VISTA_GUARDADA = { ...VISTA_TRIB,
    lecturasAqui2914: { [FOLIO_C]: { folio: FOLIO_C,
      asunto: 'Registro o actualización de medios de contacto', fecha: '2026-08-28 12:20',
      cuerpo: CUERPO_C2,
      detalleEnlace: { estado: 'texto', texto: 'Detalle del registro: tu correo quedó confirmado.' },
      leidoAquiEn: 1760000000000 } } };
  let llamadasPaseo = 0;
  const b = await bootCliente2912({ responder: async target => {
    if (target.includes('/api/buzon/comunicado')) { llamadasPaseo++; return { body: { ok: false, error: 'no debía llamarse' } }; }
    if (target.includes('/api/tributario')) return { body: VISTA_GUARDADA };
    if (target.includes('/api/status')) return { body: { settings: { installName: 'PacoSAT', hasLogo: false },
      buildModified: null, cloudRevision: null, profiles: [], jobs: [], inbox: [], mail: {},
      puerta: {}, ejecutor: {}, backupHealth: { enabled: false } } };
    return undefined;
  } });
  const { raiz } = await pintarBuzon2914(b);
  const zona = zonaDe(raiz, FOLIO_C);
  assert.ok(zona, '(C2) la página nueva enseña la zona de la copia guardada');
  const textoZona = textoDe(zona);
  assert.ok(textoZona.includes('Leído aquí'), '(C2) nombrada como lo que es: «Leído aquí», la copia de la casa');
  assert.ok(textoZona.includes('ante el SAT lo dirá el SAT'),
    '(C2) y sin fingir la marca oficial: el «leído» ante el SAT lo dirá el SAT');
  const ver = andar(zona).find(el => el.dataset.buzonLecturaVer2914 === '1');
  assert.ok(ver, '(C2) la tarjeta trae su «Ver»');
  await ver.onclick();
  await asentar(20);
  const zonaAbierta = zonaDe(raiz, FOLIO_C);
  assert.ok(zonaAbierta && textoDe(zonaAbierta).includes('da clic aquí'),
    '(C2) «Ver» despliega el cuerpo guardado en la propia tarjeta');
  assert.ok(textoDe(zonaAbierta).includes('El detalle que enlaza este comunicado:'),
    '(C2) con el detalle enlazado que quedó guardado con él');
  assert.equal(llamadasPaseo, 0, '(C2) con CERO llamadas al paseo: todo salió del almacén');
  console.log('OK 2.9.14-buzón · (C2) — página nueva: «Leído aquí» desde el servidor y «Ver» sin paseo (contador en 0).');
}
