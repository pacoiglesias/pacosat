import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtempSync, readFileSync } from 'node:fs';
import { generateKeyPairSync, webcrypto } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as vm from 'node:vm';
import { deflateSync } from 'node:zlib';
import { DOMParser } from '@xmldom/xmldom';
import { createPacoSATService } from './local-server.mjs';

/* ================================================================
   Ronda 2.9.5 — los defectos que la re-verificación EN VIVO
   sobre la 2.9.4 (18 nov 2026, 06:57–07:04) dejó al descubierto.
   Cada pieza reproduce LA FORMA EXACTA del fallo en vivo: rojo
   contra la 2.9.4, verde con el arreglo. Las piezas de cliente
   ejercen el camino DEL CLIENTE — el handler real de la
   pantalla, en el cliente construido — contra el SERVIDOR REAL
   (createPacoSATService), con el fetch del cliente puenteado a
   service.handle: nada de dobles de respuesta inventados.

   R1  Revocar una llave API desde su tarjeta no surtía efecto:
       la cadena moría en el confirm() NATIVO del navegador —
       en el navegador real el diálogo nativo se traga (la
       confirmación nunca devuelve true) y el gesto muere en
       silencio, sin llamada y sin error. La ruta del servidor
       siempre funcionó (el agente principal revocó dos llaves
       por la API interna). Arreglo: la confirmación va con el
       diálogo PROPIO de la casa (doctrina desde la 1.18.0:
       «fuera el confirm() nativo») y la tarjeta se repinta
       desde la RE-LECTURA del servidor.
   R2  «Comprobar respaldo ahora» terminaba en «La respuesta
       se perdió…» sin veredicto: en vivo el respaldo NO está
       configurado (falta la contraseña de Paco) y el servidor
       respondía un ERROR («no está configurado») que el
       cliente leía como respuesta perdida; y cuando la
       respuesta sí se pierde, la re-lectura comparaba la hora
       del SERVIDOR con el reloj del NAVEGADOR (1 s de margen):
       con los relojes desfasados, el veredicto re-leído nunca
       «era de este intento». Arreglo: el servidor responde el
       veredicto completo (pendienteDePaco, como el ensayo de
       restauración) y lo guarda; el cliente lo pinta, y la
       re-lectura reconoce el veredicto de este intento porque
       su hora CAMBIÓ respecto a la de antes del clic — sin
       comparar relojes ajenos.
   R3  La Opinión seguía «Su sentido no consta»: el lector de
       texto real (extractPdfTextLines) devuelve UN STRING y
       satDocSentidoTexto290 hacía (lineas||[]).join(' ') —
       un string no tiene .join: el TypeError caía en el catch
       y el sentido volvía vacío SIEMPRE. La suite de la 2.9.3
       inyectó un extractor falso que devolvía un ARRAY: por
       eso pasaba en el arnés y fallaba en vivo. Arreglo: se
       aceptan las dos formas (array de líneas o texto).
   R4  La hoja «Descargar CFDI» (downloadSheet) no avisa de la
       ventana ya pedida: enseña «Se pedirá al SAT: …» y deja
       pedir, sin consultar el plan — el diálogo clásico sí
       avisa desde la 2.3.0. Arreglo: la hoja consulta el plan
       al abrir y al cambiar la ventana, pinta el aviso en su
       cara («ya pedida: está en espera del SAT desde…; no se
       repite») y condiciona el envío: confirmar pide la
       VARIANTE (cierre +1 s), nunca el criterio exacto.
   R5  Hoy → «Actividad del sistema» pintaba 5 renglones
       vacíos, solo «· ahora mismo»: el servidor sirve lo
       reciente como {at: ISO, name, event} — SIN campo text —
       y el pintor leía item.text (vacío) y pasaba la fecha
       ISO a haceText, que hace Number(iso) = NaN → «ahora
       mismo». Arreglo en la fuente: el servidor compone el
       texto legible de cada entrada y sirve su hora en ms; y
       el pintor no pinta entradas sin texto legible.
   R6  La tarjeta de Declaraciones de Hoy mentía: leía
       data.resumen.presentadas — el overview lo sirve en
       data.MAPA.resumen (el cálculo del panel) — y salía 0;
       y la «última» fecha salía rota («26//2/16/1») porque
       fechaPresentacion se guarda TAL COMO la da el portal
       («10/11/2026») y dateLabel la trocea como si fuera
       ISO. Arreglo: la fecha se normaliza a ISO al archivar
       y al servir (las filas viejas también leen bien), y la
       tarjeta sale del mismo cálculo que el panel.
   ================================================================ */

const AQUI = dirname(fileURLToPath(import.meta.url));
const RFC = 'MFI6212158B4';
const ORIGIN = 'https://pacosat.test';
const KEY = 'b'.repeat(64);
const OWN = 'AAA010101AAA';

/* ================================================================
   Arnés de servicio (el de la casa, con reloj mutable)
   ================================================================ */
function makeHarness(options = {}) {
  const clock = { t: options.start ?? Date.parse('2026-11-18T15:00:00Z') };
  const mails = [];
  const service = createPacoSATService({
    dbFile: options.dbFile || ':memory:',
    html: options.html || '<html><head><!--PACOSAT_TOKEN--></head><body>prueba</body></html>',
    origin: ORIGIN, proxyKey: KEY, satDocRetryWaitMs: 5,
    makeConnector: () => ({ parser: DOMParser, connector: {
      request: async () => 'req-295', check: async () => ({ status: 'pending', packages: [] }),
      download: async () => { throw new Error('sin paquetes'); } } }),
    makeMailer: () => ({ verify: async () => true,
      sendMail: async payload => { mails.push(payload); return { messageId: 'm' + mails.length }; } }),
    now: () => clock.t, ...options.serviceOptions });
  let token = '';
  const raw = async (method, path, bodyText, extraHeaders = {}) => {
    const chunks = []; if (bodyText !== undefined && bodyText !== null && bodyText !== '')
      chunks.push(Buffer.from(String(bodyText)));
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
    const r = await raw(method, path, body === undefined ? undefined : JSON.stringify(body),
      { 'x-pacosat-token': token, ...extraHeaders });
    let json = null; try { json = JSON.parse(r.text); } catch { /* binario */ }
    return { status: r.status, json, text: r.text };
  };
  return { service, call, raw, clock, mails,
    token: () => token };
}
const unlock = async (h, rfc = OWN) => {
  const open = await h.call('POST', '/api/unlock', { rfc, minutes: 1440, days: 7,
    direction: 'both', password: 'simulated', certificate: 'YQ==', key: 'Yg==' });
  assert.equal(open.status, 200, 'unlock de ' + rfc);
};

/* Un PDF de verdad, mínimo, con su texto COMPRIMIDO
   (FlateDecode): en crudo no se lee «POSITIVA» — como el del
   SAT — y solo el extractor de texto lo saca. Es la forma
   exacta de la copia viva de la Opinión. */
function pdfOpinion295() {
  const lineas = ['Opinion del cumplimiento de obligaciones fiscales',
    'Sentido: POSITIVA', 'Folio: 26NQI411794'];
  const plano = ['BT /F1 12 Tf 72 720 Td',
    ...lineas.map((l, i) => (i ? '0 -20 Td ' : '') + '(' + l + ') Tj'), 'ET'].join('\n');
  const stream = deflateSync(Buffer.from(plano, 'latin1'));
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    Buffer.concat([Buffer.from('<< /Length ' + stream.length + ' /Filter /FlateDecode >>\nstream\n', 'latin1'),
      stream, Buffer.from('\nendstream', 'latin1')]),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const partes = [Buffer.from('%PDF-1.4\n', 'latin1')];
  const offsets = [];
  objs.forEach((cuerpo, i) => {
    offsets.push(partes.reduce((s, p) => s + p.length, 0));
    partes.push(Buffer.from((i + 1) + ' 0 obj\n', 'latin1'),
      Buffer.isBuffer(cuerpo) ? cuerpo : Buffer.from(cuerpo, 'latin1'),
      Buffer.from('\nendobj\n', 'latin1'));
  });
  const xref = partes.reduce((s, p) => s + p.length, 0);
  partes.push(Buffer.from('xref\n0 ' + (objs.length + 1) + '\n0000000000 65535 f \n' +
    offsets.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('') +
    'trailer\n<< /Size ' + (objs.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF', 'latin1'));
  return Buffer.concat(partes);
}

/* ================================================================
   CLIENTE — arnés DOM de juguete (el de ronda240actividad /
   ronda293fallos) con el fetch PUENTEADO al servidor real
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

/* bootCliente295: el cliente construido, con su fetch yendo al
   servidor real del arnés (opciones.harness) o a un respondedor
   de juguete (opciones.responder, para las piezas de pintado
   puro). opciones.confirmValue: lo que el confirm() NATIVO
   devuelve (en vivo, el diálogo nativo se traga: false).
   opciones.perderRespuesta(target): la llamada llega al
   servidor y se procesa, pero su respuesta se pierde (502). */
async function bootCliente295(opciones = {}) {
  const byId = new Map();
  const slotActividad = new FakeElement('div');
  const fetchLog = [];
  let tokenReal = opciones.token || 'token-de-prueba';
  if (opciones.harness) {
    const home = await opciones.harness.raw('GET', '/');
    tokenReal = /name="pacosat-token" content="([0-9a-f]+)"/.exec(home.text)?.[1] || tokenReal;
  }
  const metas = { 'meta[name="pacosat-token"]': { content: tokenReal },
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
    const parteM = /\/parte\/(\w+)/.exec(target);
    if (parteM) { const src = lazyCliente.partes[parteM[1]]?.source || '';
      return { ok: true, status: 200, headers: { get: () => 'text/javascript' },
        json: async () => ({}), text: async () => src, blob: async () => new Blob([]) }; }
    if (opciones.harness) {
      const method = init.method || 'GET';
      const hdrsMin = {}; for (const [k, v] of Object.entries(init.headers || {})) hdrsMin[k.toLowerCase()] = v;
      const r = await opciones.harness.raw(method, target, init.body, hdrsMin);
      fetchLog.push({ method, target, status: r.status, body: init.body || '' });
      if (opciones.perderRespuesta && opciones.perderRespuesta(target)) {
        /* La respuesta se perdió por el camino: el servidor SÍ
           procesó la llamada (ya volvió de raw), el cliente
           recibe un 502 de puerta, como el de en vivo. */
        return { ok: false, status: 502, headers: { get: () => 'application/json' },
          json: async () => ({ error: 'La puerta no respondió.' }),
          text: async () => '{"error":"La puerta no respondió."}', blob: async () => new Blob([]) };
      }
      let json = null; try { json = JSON.parse(r.text); } catch { /* binario */ }
      return { ok: r.status >= 200 && r.status < 300, status: r.status,
        headers: { get: name => { const k = Object.keys(r.headers).find(h => h.toLowerCase() === String(name).toLowerCase()); return k ? r.headers[k] : null; } },
        json: async () => { if (json === null) throw new Error('no json'); return json; },
        text: async () => r.text, blob: async () => new Blob([r.text]) };
    }
    let body = {};
    if (opciones.responder) { const r = await opciones.responder(target, init); if (r !== undefined) body = r; }
    if (body === undefined || body === null) body = {};
    if (target.includes('storage/rev')) body = { rev: 1 };
    else if (target.includes('storage?')) body = [];
    else if (target.includes('/api/status')) body = { settings: { installName: 'PacoSAT', hasLogo: false },
      buildModified: null, cloudRevision: null, profiles: [], jobs: [], inbox: [], mail: {},
      puerta: {}, ejecutor: {}, backupHealth: { enabled: false } };
    return { ok: true, status: 200, headers: { get: () => 'application/json' },
      json: async () => body, text: async () => JSON.stringify(body), blob: async () => new Blob([]) };
  };
  const timer = (fn, ms, ...a) => { const t = setTimeout(fn, ms, ...a); t.unref?.(); return t; };
  const every = (fn, ms, ...a) => { const t = setInterval(fn, ms, ...a); t.unref?.(); return t; };
  const context = vm.createContext({ console, document: documentStub,
    navigator: { onLine: true, userAgent: 'ronda295-test' },
    location: { href: 'http://127.0.0.1:43729/', search: '', reload: () => {} },
    localStorage: storageStub(opciones.localStorage || {}), sessionStorage: storageStub(),
    fetch: fetchStub, setTimeout: timer, setInterval: every, clearTimeout, clearInterval, queueMicrotask,
    URL: BootURL, URLSearchParams, Blob, TextEncoder, TextDecoder, btoa, atob,
    crypto: webcrypto, DecompressionStream, Node: class FakeNode {}, IntersectionObserver: undefined,
    matchMedia: () => ({ matches: false, addEventListener: () => {}, addListener: () => {} }),
    Option: class extends FakeElement {}, alert: () => {},
    confirm: () => opciones.confirmValue !== undefined ? opciones.confirmValue : true,
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
  return { context, fetchLog, slotActividad,
    texto: () => textoDe(context.document.getElementById('body')),
    dialogo: () => context.document.getElementById('dialog') };
}

/* ================================================================
   R1 · Cliente contra servidor real: «Revocar» en la tarjeta
   de la llave, con el confirm() nativo TRAGADO (devuelve
   false, la forma exacta de en vivo: tres clics «con su
   confirmación» y nada). La confirmación debe ser el diálogo
   propio de la casa y la tarjeta debe repintarse desde la
   re-lectura del servidor.
   ================================================================ */
{
  const h = makeHarness({ html: htmlCliente });
  try {
    await unlock(h);
    const creada = await h.call('POST', '/api/apikeys', { nombre: 'Llave repro R1', alcance: 'lectura' });
    assert.equal(creada.status, 200, 'R1: la llave de juguete se crea');
    const b = await bootCliente295({ harness: h, confirmValue: false });
    vm.runInContext("page = 'settings'; ajustesSection = 'api'; render();", b.context);
    await asentar(60);
    assert.ok(b.texto().includes('Llave repro R1'), 'R1: la tarjeta de la llave se pinta');
    const boton = buscarBoton(b.context.document.getElementById('body'), 'Revocar');
    assert.ok(boton, 'R1: la tarjeta enseña su «Revocar» visible');
    b.fetchLog.length = 0;
    await boton.onclick();
    await asentar(30);
    /* La confirmación es el diálogo PROPIO: su pregunta consta
       en los campos del diálogo (en la 2.9.4 el gesto moría en
       el confirm() nativo tragado: ni llamada ni diálogo). */
    const campos = textoDe(b.context.document.getElementById('fields'));
    assert.ok(campos.includes('¿Revocar la llave «Llave repro R1»?'),
      'R1: la confirmación se abre en el diálogo propio de la casa, no en el confirm() nativo');
    assert.equal(b.context.document.getElementById('dialogTitle').textContent, 'Revocar la llave',
      'R1: el diálogo se titula por su acción');
    /* El gesto de Paco en el diálogo: su botón de confirmar. */
    await vm.runInContext('submit()', b.context);
    await asentar(60);
    const post = b.fetchLog.find(l => l.method === 'POST' && l.target.includes('apikeys/estado'));
    assert.ok(post, 'R1: el clic llega a POST /api/apikeys/estado');
    assert.deepEqual(JSON.parse(post.body), { id: creada.json.id, estado: 'revocada' },
      'R1: con el id de la tarjeta y el estado «revocada»');
    const trasPost = b.fetchLog.slice(b.fetchLog.indexOf(post) + 1)
      .find(l => l.method === 'GET' && l.target.includes('/api/apikeys'));
    assert.ok(trasPost, 'R1: tras revocar, la tarjeta se pinta desde la RE-LECTURA del servidor');
    const lista = (await h.call('GET', '/api/apikeys')).json;
    assert.equal(lista.llaves.find(k => k.id === creada.json.id)?.estado, 'revocada',
      'R1: en el servidor la llave queda revocada');
    assert.ok(b.texto().includes('Revocada'), 'R1: y la tarjeta lo enseña — ya no «Activa»');
    console.log('OK 2.9.5 · R1 — Cliente+servidor: «Revocar» confirma con el diálogo propio (sin confirm() nativo), revoca y la tarjeta se repinta desde la re-lectura.');
  } finally { h.service.close(); }
}

/* ================================================================
   R2a · Sin respaldo configurado (la forma de en vivo: falta
   la contraseña de Paco): «Comprobar respaldo ahora» debe
   pintar EL VEREDICTO — pendiente de su gesto —, no «La
   respuesta se perdió…».
   ================================================================ */
{
  const h = makeHarness({ html: htmlCliente });
  try {
    await unlock(h);
    const b = await bootCliente295({ harness: h });
    vm.runInContext('ready = true;', b.context);
    await vm.runInContext('pollSat()', b.context);
    await asentar(40);
    const tarjeta = vm.runInContext('backupHealthCard()', b.context);
    assert.ok(tarjeta, 'R2a: la tarjeta de respaldo se compone');
    b.context.document.getElementById('body').append(tarjeta);
    const boton = buscarBoton(tarjeta, 'Comprobar respaldo ahora');
    assert.ok(boton, 'R2a: la tarjeta lleva su botón de comprobación');
    await boton.onclick();
    await asentar(60);
    const texto = textoDe(tarjeta);
    assert.ok(!texto.includes('La respuesta se perdió'),
      'R2a: el texto de derrota no aparece (en la 2.9.4 era el final de siempre)');
    assert.ok(texto.includes('contraseña de respaldo'),
      'R2a: la tarjeta pinta el veredicto real: falta la contraseña de respaldo — un gesto pendiente de Paco');
    const st = await h.call('GET', '/api/status');
    assert.ok(st.json.backupHealth.verify?.pendienteDePaco,
      'R2a: el veredicto queda guardado y servido en el estado (backupHealth.verify), con su hora');
    console.log('OK 2.9.5 · R2a — Sin configurar: la comprobación pinta su veredicto (pendiente de Paco) en la tarjeta y queda en el estado.');
  } finally { h.service.close(); }
}

/* ================================================================
   R2b · Con respaldo configurado, la respuesta del gesto SE
   PIERDE (502 tras procesarse) y el reloj del SERVIDOR va
   10 s por detrás del del navegador: la re-lectura debe
   reconocer el veredicto de ESTE intento (su hora cambió
   respecto a la de antes del clic) y pintarlo.
   ================================================================ */
{
  const h = makeHarness({ html: htmlCliente, start: Date.now() - 10000 });
  try {
    await unlock(h);
    const dir = mkdtempSync(join(tmpdir(), 'pacosat-295r2-'));
    await h.service.bootstrap({ backup: { password: 'respaldo-prueba-16', frequency: 'daily',
      dir: join(dir, 'respaldos') } });
    await h.service.backupTick(h.clock.t);
    const antes = await h.call('GET', '/api/status');
    assert.ok(antes.json.backupHealth.verify?.at, 'R2b: consta la comprobación automática previa');
    h.clock.t += 60000; /* el clic ocurre un minuto después */
    const b = await bootCliente295({ harness: h,
      perderRespuesta: target => target.includes('backup/verify') });
    vm.runInContext('ready = true;', b.context);
    await vm.runInContext('pollSat()', b.context);
    await asentar(40);
    const tarjeta = vm.runInContext('backupHealthCard()', b.context);
    b.context.document.getElementById('body').append(tarjeta);
    const boton = buscarBoton(tarjeta, 'Comprobar respaldo ahora');
    await boton.onclick();
    await asentar(80);
    const texto = textoDe(tarjeta);
    assert.ok(!texto.includes('no consta una comprobación de este intento'),
      'R2b: con la respuesta perdida y los relojes desfasados, la derrota no aparece (en la 2.9.4 la comparación de relojes la hacía inevitable)');
    assert.ok(texto.includes('Íntegro') || texto.includes('íntegro'),
      'R2b: la tarjeta pinta el veredicto RE-LEÍDO de este intento: respaldo íntegro');
    const despues = await h.call('GET', '/api/status');
    assert.ok(despues.json.backupHealth.verify.at > antes.json.backupHealth.verify.at,
      'R2b: la comprobación de este intento sí corrió en el servidor (su hora es posterior a la previa)');
    console.log('OK 2.9.5 · R2b — Respuesta perdida + relojes desfasados: el veredicto de este intento se re-lee y se pinta.');
  } finally { h.service.close(); }
}

/* ================================================================
   R3 · Servidor con el extractor REAL (sin inyectar): la
   bajada del portal archiva la Opinión y su sentido POSITIVA
   queda guardado y servido — la forma exacta de la copia
   viva (PDF con el texto comprimido; el extractor real
   devuelve un string, no un array).
   ================================================================ */
{
  const pdf = pdfOpinion295();
  assert.ok(!pdf.toString('latin1').includes('POSITIVA'),
    'R3: en crudo el PDF no enseña su sentido (comprimido, como el del SAT)');
  const h = makeHarness({ serviceOptions: {
    satDocFetch: async (profile, kind) => kind === 'opinion'
      ? { content: pdf, issuedAt: '2026-11-16', fileName: 'Opinion ' + profile.rfc + '.pdf' }
      : { content: pdf, issuedAt: '2026-11-16', fileName: 'Constancia ' + profile.rfc + '.pdf' } } });
  try {
    await unlock(h);
    const run = await h.call('POST', '/api/satdocs/run', { rfc: OWN, kind: 'opinion' });
    assert.equal(run.status, 200, 'R3: la bajada de la Opinión corre: ' + run.text.slice(0, 160));
    assert.equal(run.json.results?.opinion?.ok, true, 'R3: y archiva el documento');
    const vista = (await h.call('GET', '/api/satdocs')).json;
    assert.equal(vista.profiles[0].opinion.sentido, 'positiva',
      'R3: el sentido de la Opinión archivada por la bajada real es «positiva» (en la 2.9.4 el extractor-string lo dejaba vacío para siempre)');
    console.log('OK 2.9.5 · R3a — Bajada real: la Opinión nace con su sentido POSITIVA guardado y servido.');
  } finally { h.service.close(); }
}
/* R3b · La copia YA archivada sin sentido (como quedó la viva
   del 16 nov) se rellena AL LEER Documentos — con el
   extractor real y el PDF comprimido de verdad, no con el
   extractor de juguete de la 2.9.3. */
{
  const dir = mkdtempSync(join(tmpdir(), 'pacosat-295r3-'));
  const dbFile = join(dir, 'pacosat.sqlite');
  const pdf = pdfOpinion295();
  const h = makeHarness({ dbFile });
  try {
    await unlock(h);
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(dbFile);
    const fileId = 'pdf:copia-viva-295';
    const ahora = Date.parse('2026-11-16T21:21:00Z');
    db.prepare("INSERT OR REPLACE INTO records(store,id,value,data,mime) VALUES ('files',?,NULL,?,'application/pdf')")
      .run(fileId, new Uint8Array(pdf));
    db.prepare("INSERT OR REPLACE INTO records(store,id,value) VALUES ('documents',?,?)")
      .run(fileId, JSON.stringify({ id: fileId, rfc: OWN, kind: 'Opinión de cumplimiento',
        date: '2026-11-16', sentido: '', vigencia: '' }));
    db.prepare('INSERT INTO sat_documents(id,rfc,kind,issuedAt,fileId,source,created) VALUES (?,?,?,?,?,?,?)')
      .run('doc-copia-viva-295', OWN, 'opinion', ahora, fileId, 'auto', ahora);
    db.close();
    const vista = (await h.call('GET', '/api/satdocs')).json;
    assert.equal(vista.profiles[0].opinion.sentido, 'positiva',
      'R3b: al leer Documentos, la copia sin sentido se rellena desde su propio PDF (extractor real)');
    const otra = (await h.call('GET', '/api/satdocs')).json;
    assert.equal(otra.profiles[0].opinion.sentido, 'positiva',
      'R3b: y queda guardado, no se re-deriva en cada lectura');
    console.log('OK 2.9.5 · R3b — Relleno al leer: la copia archivada sin sentido sale POSITIVA de su propio PDF.');
  } finally { h.service.close(); }
}

/* ================================================================
   R4 · Cliente contra servidor real: la hoja «Descargar
   CFDI» con la ventana EXACTA de en vivo (Recibidos
   2026-11-08 → 2026-11-14) y su solicitud viva sembrada —
   debe avisar en su cara y condicionar el envío a la
   variante, sin reenviar jamás el criterio exacto.
   ================================================================ */
{
  const h = makeHarness({ html: htmlCliente });
  try {
    await unlock(h);
    const req = await h.call('POST', '/api/request', { rfc: OWN, start: '2026-11-08',
      end: '2026-11-14', direction: 'received', type: 'cfdi' });
    assert.equal(req.status, 200, 'R4: la solicitud viva de la ventana queda sembrada');
    const b = await bootCliente295({ harness: h });
    vm.runInContext(`people = [{ id: '${OWN}', name: 'EMPRESA ALFA SA' }]; scope = '${OWN}';`, b.context);
    await vm.runInContext("ensureLazyPart('descargas')", b.context);
    await asentar(30);
    vm.runInContext(`downloadSheet('${OWN}', { start: '2026-11-08', end: '2026-11-14', direction: 'received' })`, b.context);
    await asentar(60);
    const dlg = b.dialogo();
    const textoDlg = textoDe(dlg);
    assert.ok(textoDlg.includes('Se pedirá al SAT:'), 'R4: la hoja enseña su resumen de siempre');
    assert.ok(/ya se pidió/.test(textoDlg) && textoDlg.includes('en espera del SAT'),
      'R4: la hoja AVISA en su cara: la ventana ya se pidió y está en espera del SAT (en la 2.9.4 solo decía «Se pedirá al SAT» y dejaba pedir)');
    assert.ok(/no se repite/.test(textoDlg), 'R4: y dice que no se repite');
    /* El envío, condicionado: al pedir, la confirmación pide
       la VARIANTE y lo que sale al servidor la lleva. */
    const form = andar(dlg).find(el => el.tagName === 'FORM');
    assert.ok(form?.onsubmit, 'R4: la hoja tiene su formulario de envío');
    form.onsubmit({ preventDefault() {} });
    await asentar(30);
    const textoConf = textoDe(dlg);
    assert.ok(/ya se pidió/.test(textoConf), 'R4: la confirmación repite el aviso antes de gastar nada');
    const confirmar = buscarBoton(dlg, 'Confirmar y pedir la variante');
    assert.ok(confirmar, 'R4: el botón de confirmar pide LA VARIANTE, no el criterio exacto');
    b.fetchLog.length = 0;
    await confirmar.onclick();
    await asentar(60);
    const envio = b.fetchLog.find(l => l.method === 'POST' && l.target.endsWith('/api/request'));
    assert.ok(envio, 'R4: confirmar envía la solicitud');
    const payload = JSON.parse(envio.body);
    assert.ok(Number(payload.shiftEnd) >= 1,
      'R4: lo enviado es la variante (shiftEnd ≥ 1): el criterio exacto NO se reenvía');
    assert.equal(payload.start, '2026-11-08', 'R4: la ventana es la misma');
    console.log('OK 2.9.5 · R4 — Hoja de descarga: avisa de la ventana ya pedida en su cara y el envío sale como variante.');
  } finally { h.service.close(); }
}

/* ================================================================
   R5a · Servidor: lo reciente de la actividad sale con su
   TEXTO legible compuesto en la fuente (nombre y suceso del
   diario) y su hora en milisegundos — no la fila ISO sin
   texto que la franja pintaba como «· ahora mismo».
   ================================================================ */
{
  const dir = mkdtempSync(join(tmpdir(), 'pacosat-295r5-'));
  const dbFile = join(dir, 'pacosat.sqlite');
  const h = makeHarness({ dbFile });
  try {
    await unlock(h);
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(dbFile);
    const sembrar = (id, value) => db.prepare("INSERT OR REPLACE INTO records(store,id,value) VALUES ('activity',?,?)")
      .run(id, JSON.stringify(value));
    sembrar('act-295-1', { id: 'act-295-1', name: 'Descarga de CFDI',
      event: 'Solicitud enviada al SAT: 3 paquetes en preparación',
      date: '2026-11-18T14:58:00.000Z', added: 3, duplicates: 1, review: 0 });
    sembrar('act-295-2', { id: 'act-295-2', name: 'Prueba de restauración',
      event: '', date: '2026-11-18T14:40:00.000Z', added: 0, duplicates: 0, review: 0 });
    db.close();
    const act = (await h.call('GET', '/api/activity')).json;
    const primera = act.recent.find(r => String(r.text || '').includes('Descarga de CFDI'));
    assert.ok(primera, 'R5a: la entrada reciente trae su TEXTO compuesto en el servidor (en la 2.9.4 no existía el campo)');
    assert.ok(primera.text.includes('Solicitud enviada al SAT'),
      'R5a: el texto lleva el suceso del diario, no solo el nombre');
    assert.equal(typeof primera.at, 'number',
      'R5a: y su hora viaja en milisegundos, la forma que haceText entiende');
    assert.equal(primera.at, Date.parse('2026-11-18T14:58:00.000Z'),
      'R5a: la hora es la de su fecha, convertida, no inventada');
    console.log('OK 2.9.5 · R5a — Servidor: lo reciente sale con texto legible y hora en ms.');
  } finally { h.service.close(); }
}
/* R5b · Cliente: la franja no pinta entradas sin texto
   legible; las que lo traen se pintan con su «hace …» real. */
{
  const ahora = Date.now();
  const b = await bootCliente295({
    responder: async target => {
      if (target.includes('/api/activity')) return { running: [], paused: [],
        recent: [{ text: '', name: '', event: '', at: ahora },
          { text: 'Descarga de CFDI · Solicitud enviada al SAT', at: ahora - 120000 }],
        nextAuto: null };
      return undefined;
    } });
  await vm.runInContext("ensureLazyPart('monitor')", b.context);
  vm.runInContext(`activityView = { running: [], paused: [], nextAuto: null,
    recent: [{ text: '', name: '', event: '', at: ${ahora} },
      { text: 'Descarga de CFDI · Solicitud enviada al SAT', at: ${ahora - 120000} }] }; paintActivity();`, b.context);
  await asentar(20);
  const filas = b.slotActividad.children;
  assert.equal(filas.length, 1,
    'R5b: la franja pinta SOLO la entrada con texto legible (en la 2.9.4 pintaba también la vacía: «· ahora mismo»)');
  const texto = textoDe(b.slotActividad);
  assert.ok(texto.includes('Descarga de CFDI'), 'R5b: la entrada legible se pinta con su texto');
  assert.ok(texto.includes('hace 2 minutos'), 'R5b: y con su «hace …» real, no «ahora mismo»');
  assert.ok(!texto.includes('ahora mismo'), 'R5b: ningún renglón vacío con «ahora mismo»');
  console.log('OK 2.9.5 · R5b — Cliente: sin renglones vacíos en la actividad reciente de Hoy.');
}

/* ================================================================
   R6 · El expediente sembrado COMO lo deja el paseo real
   (13 filas de 2026: 10 meses presentados + 3
   complementarias, con fechaPresentacion en el formato del
   portal «DD/MM/AAAA»): el overview sirve el MISMO cálculo
   que el panel (mapa.resumen = 10 presentadas) y las fechas
   en ISO; la tarjeta de Hoy, contra el servidor real, dice
   «10 presentada(s)» y una fecha válida.
   ================================================================ */
{
  const dir = mkdtempSync(join(tmpdir(), 'pacosat-295r6-'));
  const dbFile = join(dir, 'pacosat.sqlite');
  const h = makeHarness({ dbFile, html: htmlCliente });
  try {
    await unlock(h);
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(dbFile);
    const ins = db.prepare('INSERT INTO declaraciones(id,rfc,tipo,clase,ejercicio,periodo,fechaPresentacion,operacion,fileId,source,created,verificada,ejecutorJobId) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
    let n = 0;
    for (let m = 1; m <= 10; m++) {
      const periodo = '2026-' + String(m).padStart(2, '0');
      const fecha = m === 10 ? '10/11/2026' : '1' + (m % 9) + '/' + String(m + 1).padStart(2, '0') + '/2026';
      ins.run('decl-295-' + (++n), OWN, 'mensual', 'acuse', 2026, periodo, fecha,
        '2626' + String(10000000 + n), 'pdf:decl-295-' + n, 'auto', Date.parse('2026-11-18T10:00:00Z') + n, 1, '');
    }
    for (const [periodo, fecha] of [['2026-01', '15/03/2026'], ['2026-02', '15/03/2026'], ['2026-03', '20/04/2026']]) {
      ins.run('decl-295-' + (++n), OWN, 'mensual', 'declaracion', 2026, periodo, fecha,
        '2677' + String(10000000 + n), 'pdf:decl-295-' + n, 'auto', Date.parse('2026-11-18T10:00:00Z') + n, 1, '');
    }
    db.close();
    const ov = (await h.call('GET', '/api/declaraciones?rfc=' + OWN + '&ejercicio=2026')).json;
    assert.equal(ov.mapa.resumen.presentadas, 10,
      'R6: el cálculo reconciliado (el del panel) dice 10 presentadas de 2026');
    assert.equal(ov.documentos.length, 13, 'R6: el expediente trae las 13 filas');
    for (const doc of ov.documentos)
      assert.ok(/^\d{4}-\d{2}-\d{2}/.test(doc.fechaPresentacion || ''),
        'R6: cada fechaPresentacion sale en ISO (en la 2.9.4 salía «' + doc.fechaPresentacion + '», el formato crudo del portal)');
    const ultima = ov.documentos.map(d => d.fechaPresentacion).sort().pop();
    assert.equal(ultima, '2026-11-10', 'R6: la última presentación es la de octubre, 2026-11-10');
    /* La tarjeta de Hoy, en el cliente real contra este
       mismo servidor: el mismo número y una fecha válida. */
    const b = await bootCliente295({ harness: h });
    vm.runInContext(`people = [{ id: '${OWN}', name: 'EMPRESA ALFA SA' }]; scope = '${OWN}';`, b.context);
    vm.runInContext("page = 'home'; render();", b.context);
    await asentar(120);
    const texto = b.texto();
    assert.ok(texto.includes('Ejercicio 2026: 10 presentada(s) en el expediente'),
      'R6: la tarjeta de Hoy dice «10 presentada(s)» — el cálculo del panel (en la 2.9.4 decía 0: leía una ruta que no existe)');
    assert.ok(texto.includes('la última, del 10/11/2026'),
      'R6: y la última fecha bien formada, «10/11/2026»');
    assert.ok(!texto.includes('26//'), 'R6: la fecha rota de en vivo («26//2/16/1») no aparece');
    console.log('OK 2.9.5 · R6 — Hoy y el panel salen del mismo cálculo: 10 presentadas y la última, del 10/11/2026.');
  } finally { h.service.close(); }
}

console.log('OK suite ronda295 completa');
