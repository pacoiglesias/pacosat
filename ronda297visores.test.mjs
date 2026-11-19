import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { webcrypto } from 'node:crypto';
import * as vm from 'node:vm';
import { DOMParser } from '@xmldom/xmldom';
import { DatabaseSync } from 'node:sqlite';
import { createPacoSATService } from './local-server.mjs';

/* ================================================================
   Ronda 2.9.7 · Pieza D2 — VISORES QUE NO ESPERAN

   EL PROBLEMA (barrido en vivo del 18 nov): «Ver documento» de
   la Opinión en Novedades, Ver/Descargar de Constancia y
   Opinión en Documentos y «Ver» del acuse de 22 páginas en
   Declaraciones tardaban 5–18 s. El mapa medido en arnés
   (servidor real + Chromium real, red declarada 4 Mbps/50 ms,
   PDFs de tamaño realista: Opinión 127 KB/1 pág., Constancia
   124 KB/3 pág., acuse 302 KB/22 pág.):

   ANTES — al hacer clic, el cliente pedía el PDF ENTERO por
   /api/files/view (satApiBlob: response.blob()) y SOLO
   entonces abría el diálogo con el iframe del visor del
   navegador: bytes antes de la primera pintura = el documento
   completo; diálogo a 412–1.239 ms y primera página pintada a
   960–1.529 ms en el arnés (en vivo, con el NAS y el teléfono,
   los 5–18 s del barrido). El servidor sirve files/view en
   0–1 ms: no relee ni descifra nada por apertura. La otra
   espera estaba en la MINIATURA: archiveSatDoc indexaba el
   texto al archivar (docTextoAsegurar240) pero NO aseguraba
   la miniatura — thumbs200g nacía VACÍA para todo lo que baja
   el paseo — y el primer render (451 ms el primero del
   proceso, ~100–150 ms los siguientes, en el arnés) lo pagaba
   quien abriera la lista de miniaturas (hasta 5 renders EN
   SERIE: lista fría medida 511 ms con solo 2 documentos) o la
   tarjeta protagonista. El único camino que sí aseguraba al
   crear era la subida manual de papel
   (/api/documentos200g/subir-papel), que no es el del paseo.
   Y el acuse ni siquiera pasa por archiveSatDoc: nace en
   archiveDeclaracion, también sin miniatura.

   EL ARREGLO (en la raíz, la dirección de la ronda):
   1) archiveSatDoc asegura TAMBIÉN la miniatura al archivar
      (thumbEnsure200g, sin bloquear, con su .catch como el
      texto) y archiveDeclaracion hace lo propio: ningún
      documento del paseo nace sin su vista pre-generada.
   2) El visor de la casa (viewDocOnline, por el que pasan
      Documentos, Novedades y Declaraciones) pide PRIMERO la
      vista pre-generada (/api/miniatura200g, desde su caché
      por huella) y la pinta al instante en el diálogo; el PDF
      completo carga detrás y repinta el mismo diálogo con el
      visor de siempre (paridad: iframe, «Abrir en otra
      pestaña», «Descargar original»). Sin vista posible
      (PDF ilegible, ZIP, XML) no hay paso previo: cae al
      camino honesto de siempre.

   CASOS:
   (a) Un documento archivado por archiveSatDoc (y el acuse,
       por archiveDeclaracion) nace con thumbs200g en 'ok'
       SIN que nadie lo abra ni pida su miniatura.
   (b) La apertura en caliente no dispara ningún render nuevo
       (el sello `at` de thumbs200g no se mueve ni con el reloj
       adelantado: contador de renders = 0) y
       /api/miniatura200g responde desde caché, byte a byte.
   (c) El visor pide primero la vista pre-generada y después
       el PDF (orden registrado en el arnés de cliente de la
       casa), pinta la previa mientras el PDF viaja y acaba
       con el visor completo de siempre.
   (d) Regresión: el PDF ilegible sigue sin miniatura posible
       ('fallo' cacheado, 404 honesto en la ruta) y su
       /api/files/view lo sirve entero como hoy: el visor cae
       a su comportamiento de siempre, sin fingir previa.
   ================================================================ */

const AQUI = dirname(fileURLToPath(import.meta.url));
const ORIGIN = 'https://pacosat.test';
const KEY = 'v'.repeat(64);
const OWN = 'AAA010101AAA';

/* ---------- PDFs de verdad (patrón de la casa, multipágina) ---------- */
function pdfPaginas297(paginas) {
  const objs = []; let next = 3;
  const pageNums = [], contentNums = [];
  for (let i = 0; i < paginas.length; i++) { pageNums.push(next++); contentNums.push(next++); }
  const fontNum = next;
  objs.push({ n: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' });
  objs.push({ n: 2, body: '<< /Type /Pages /Kids [' + pageNums.map(n => n + ' 0 R').join(' ') + '] /Count ' + paginas.length + ' >>' });
  const esc = s => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  paginas.forEach((lineas, i) => {
    const plano = ['BT /F1 10 Tf 40 780 Td',
      ...lineas.map((l, j) => (j ? '0 -13 Td ' : '') + '(' + esc(l) + ') Tj'), 'ET'].join('\n');
    const stream = deflateSync(Buffer.from(plano, 'latin1'));
    objs.push({ n: pageNums[i], body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ' + contentNums[i] + ' 0 R /Resources << /Font << /F1 ' + fontNum + ' 0 R >> >> >>' });
    objs.push({ n: contentNums[i], body: Buffer.concat([Buffer.from('<< /Length ' + stream.length + ' /Filter /FlateDecode >>\nstream\n', 'latin1'),
      stream, Buffer.from('\nendstream', 'latin1')]) });
  });
  objs.push({ n: fontNum, body: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>' });
  objs.sort((a, b) => a.n - b.n);
  const partes = [Buffer.from('%PDF-1.4\n', 'latin1')];
  const offsets = [];
  for (const o of objs) {
    offsets[o.n] = partes.reduce((s, p) => s + p.length, 0);
    partes.push(Buffer.from(o.n + ' 0 obj\n', 'latin1'),
      Buffer.isBuffer(o.body) ? o.body : Buffer.from(o.body, 'latin1'), Buffer.from('\nendobj\n', 'latin1'));
  }
  const xref = partes.reduce((s, p) => s + p.length, 0);
  let xr = 'xref\n0 ' + (fontNum + 1) + '\n0000000000 65535 f \n';
  for (let n = 1; n <= fontNum; n++) xr += String(offsets[n] || 0).padStart(10, '0') + ' 00000 n \n';
  partes.push(Buffer.from(xr + 'trailer\n<< /Size ' + (fontNum + 1) + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF', 'latin1'));
  return Buffer.concat(partes);
}
const PDF_OPINION = pdfPaginas297([['Opinion del cumplimiento de obligaciones fiscales',
  'Nombre, denominacion o razon social Sentido MANO FIL SA POSITIVO RFC Folio 26NQI411794']]);
const PDF_CONSTANCIA = pdfPaginas297([['Constancia de situacion fiscal pagina 1'],
  ['Constancia pagina 2'], ['Constancia pagina 3']]);
const PDF_ACUSE = pdfPaginas297(Array.from({ length: 22 }, (_, i) =>
  ['Acuse de declaracion mensual pagina ' + (i + 1) + ' de 22', 'Numero de operacion 123456789']));
const PDF_ROTO = Buffer.from('%PDF-1.4\n% ilegible: catalogo sin paginas ni streams\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF');

/* ---------- Arnés de servicio (el de la casa, reloj mutable) ---------- */
function makeHarness(options = {}) {
  const clock = { t: options.start ?? Date.parse('2026-11-18T15:00:00Z') };
  const dir = mkdtempSync(join(tmpdir(), 'pacosat-297v-'));
  const dbFile = join(dir, 'pacosat.sqlite');
  const service = createPacoSATService({
    dbFile, html: '<html><head><!--PACOSAT_TOKEN--></head><body>prueba</body></html>',
    origin: ORIGIN, proxyKey: KEY, satDocRetryWaitMs: 5,
    makeConnector: () => ({ parser: DOMParser, connector: {
      request: async () => 'req-297v', check: async () => ({ status: 'pending', packages: [] }),
      download: async () => { throw new Error('sin paquetes'); } } }),
    makeMailer: () => ({ verify: async () => true, sendMail: async () => ({ messageId: 'm1' }) }),
    now: () => clock.t, ...options.serviceOptions });
  let token = '';
  const rutasPedidas = [];
  const raw = async (method, path, bodyText, extraHeaders = {}) => {
    rutasPedidas.push(method + ' ' + path.split('?')[0]);
    const chunks = []; if (bodyText) chunks.push(Buffer.from(String(bodyText)));
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
    return { status: r.status, json, text: r.text, headers: r.headers };
  };
  const leerThumbs = () => {
    const db = new DatabaseSync(dbFile, { readOnly: true });
    try { return db.prepare('SELECT fileId, estado, at, hash FROM thumbs200g').all(); } finally { db.close(); }
  };
  const leerThumbBytes = fileId => {
    const db = new DatabaseSync(dbFile, { readOnly: true });
    try { const row = db.prepare("SELECT data FROM records WHERE store='files' AND id=?").get('thumb200g:' + fileId);
      return row?.data ? Buffer.from(row.data) : null; } finally { db.close(); }
  };
  return { service, call, raw, clock, rutasPedidas, leerThumbs, leerThumbBytes,
    token: () => token };
}
const unlock = async h => {
  const open = await h.call('POST', '/api/unlock', { rfc: OWN, minutes: 1440, days: 7,
    direction: 'both', password: 'simulated', certificate: 'YQ==', key: 'Yg==' });
  assert.equal(open.status, 200, 'unlock');
};
const espera = ms => new Promise(r => setTimeout(r, ms));
async function hastaThumb(h, fileId, estado, ms = 20000) {
  const fin = Date.now() + ms;
  for (;;) {
    const fila = h.leerThumbs().find(t => t.fileId === fileId);
    if (fila && fila.estado === estado) return fila;
    if (Date.now() > fin) return fila || null;
    await espera(120);
  }
}

/* ================================================================
   (a) NACEN CON MINIATURA — archiveSatDoc (Opinión y Constancia
   del paseo) y archiveDeclaracion (el acuse de 22 páginas),
   sin que nadie abra nada ni pida ninguna miniatura.
   ================================================================ */
let hA; const idsA = {};
{
  hA = makeHarness({ serviceOptions: {
    satDocFetch: async (profile, kind) => kind === 'opinion'
      ? { content: PDF_OPINION, issuedAt: '2026-11-16', fileName: 'Opinion ' + profile.rfc + '.pdf' }
      : { content: PDF_CONSTANCIA, issuedAt: '2026-11-15', fileName: 'Constancia ' + profile.rfc + '.pdf' } } });
  await unlock(hA);
  const runOp = await hA.call('POST', '/api/satdocs/run', { rfc: OWN, kind: 'opinion' });
  assert.equal(runOp.json?.results?.opinion?.ok, true, '(a) la bajada de la Opinión archiva');
  const runCo = await hA.call('POST', '/api/satdocs/run', { rfc: OWN, kind: 'constancia' });
  assert.equal(runCo.json?.results?.constancia?.ok, true, '(a) la bajada de la Constancia archiva');
  const upAcuse = await hA.call('POST', '/api/declaraciones/upload', { rfc: OWN, tipo: 'mensual',
    clase: 'acuse', ejercicio: 2026, periodo: '2026-10', content: PDF_ACUSE.toString('base64') });
  assert.equal(upAcuse.json?.filed, true, '(a) el acuse de 22 páginas se archiva');
  const vista = (await hA.call('GET', '/api/satdocs')).json;
  idsA.opinion = vista.profiles[0].opinion.fileId;
  idsA.constancia = vista.profiles[0].constancia.fileId;
  const decl = (await hA.call('GET', '/api/declaraciones?rfc=' + OWN + '&ejercicio=2026')).json;
  idsA.acuse = (decl.documentos || []).find(d => d.clase === 'acuse')?.fileId;
  assert.ok(idsA.opinion && idsA.constancia && idsA.acuse, '(a) los tres documentos constan archivados');
  /* Nadie ha pedido una miniatura todavía: si thumbs200g llega
     a 'ok', la aseguró el ARCHIVADO, no una apertura. */
  assert.ok(!hA.rutasPedidas.some(r => r.includes('miniatura')),
    '(a) hasta aquí nadie ha pedido /api/miniatura200g ni /api/miniaturas200g');
  for (const [nombre, id] of Object.entries(idsA)) {
    const fila = await hastaThumb(hA, id, 'ok');
    assert.equal(fila?.estado, 'ok', '(a) ' + nombre + ' nace con su miniatura asegurada al archivar (thumbs200g=ok)');
    const png = hA.leerThumbBytes(id);
    assert.ok(png && png.length > 100 && png.subarray(0, 4).toString('latin1') === '\x89PNG',
      '(a) la miniatura de ' + nombre + ' es un PNG guardado de verdad');
  }
  assert.ok(!hA.rutasPedidas.some(r => r.includes('miniatura')),
    '(a) y sigue sin que nadie la haya pedido: la generó el archivado');
  console.log('OK 2.9.7 · D2-(a) — Opinión, Constancia (archiveSatDoc) y acuse de 22 págs. (archiveDeclaracion) nacen con thumbs200g=ok sin ninguna apertura.');
}

/* ================================================================
   (b) APERTURA EN CALIENTE SIN RENDER NUEVO — con el reloj
   adelantado una hora, cualquier render re-estamparía `at`:
   si `at` no se mueve, el contador de renders es 0. Y la ruta
   de la miniatura responde los bytes cacheados, tal cual.
   ================================================================ */
{
  const antes = new Map(hA.leerThumbs().map(t => [t.fileId, t.at]));
  hA.clock.t += 3600_000; // una hora después: un render nuevo se delataría en `at`
  for (const id of Object.values(idsA)) {
    const r = await hA.raw('GET', '/api/miniatura200g?id=' + encodeURIComponent(id), undefined,
      { 'x-pacosat-token': hA.token() });
    assert.equal(r.status, 200, '(b) /api/miniatura200g responde 200 en caliente');
    const servidos = Buffer.from(r.text, 'latin1');
    assert.ok(servidos.equals(hA.leerThumbBytes(id)),
      '(b) la miniatura servida es, byte a byte, la cacheada al archivar');
    const view = await hA.raw('GET', '/api/files/view?id=' + encodeURIComponent(id), undefined,
      { 'x-pacosat-token': hA.token() });
    assert.equal(view.status, 200, '(b) /api/files/view sigue sirviendo el documento en caliente');
  }
  const lista = await hA.call('GET', '/api/miniaturas200g?rfc=' + OWN);
  assert.equal(lista.status, 200, '(b) la lista de miniaturas responde');
  for (const doc of lista.json.documentos)
    if (Object.values(idsA).includes(doc.id))
      assert.equal(doc.estado, 'ok', '(b) la lista ve la miniatura ya asegurada, sin generarla');
  const despues = new Map(hA.leerThumbs().map(t => [t.fileId, t.at]));
  assert.deepEqual([...despues.entries()].sort(), [...antes.entries()].sort(),
    '(b) ningún `at` de thumbs200g se movió en caliente: renders nuevos = 0');
  console.log('OK 2.9.7 · D2-(b) — Apertura en caliente: 0 renders nuevos (at intacto con el reloj +1 h) y miniatura servida desde caché byte a byte.');
  hA.service.close();
}

/* ================================================================
   (d) REGRESIÓN HONESTA — el PDF ilegible: 'fallo' cacheado al
   archivar, 404 llano en la miniatura (sin reintentos: su `at`
   tampoco se mueve) y el documento entero servido como hoy
   por /api/files/view, para que el visor abra con su camino
   de siempre.
   ================================================================ */
{
  const h = makeHarness({ serviceOptions: {
    satDocFetch: async (profile, kind) => ({ content: PDF_ROTO, issuedAt: '2026-11-16',
      fileName: 'Opinion ' + profile.rfc + '.pdf' }) } });
  try {
    await unlock(h);
    const run = await h.call('POST', '/api/satdocs/run', { rfc: OWN, kind: 'opinion' });
    assert.equal(run.json?.results?.opinion?.ok, true, '(d) el PDF ilegible también se archiva (como hoy)');
    const vista = (await h.call('GET', '/api/satdocs')).json;
    const id = vista.profiles[0].opinion.fileId;
    const fila = await hastaThumb(h, id, 'fallo');
    assert.equal(fila?.estado, 'fallo', '(d) su miniatura queda en «fallo» cacheado al archivar, no pendiente');
    const atFallo = fila.at;
    h.clock.t += 3600_000;
    const min = await h.raw('GET', '/api/miniatura200g?id=' + encodeURIComponent(id), undefined,
      { 'x-pacosat-token': h.token() });
    assert.equal(min.status, 404, '(d) /api/miniatura200g responde 404 honesto: no tiene miniatura');
    assert.ok(min.text.includes('no tiene miniatura'), '(d) y lo dice en llano, como hoy');
    assert.equal(h.leerThumbs().find(t => t.fileId === id)?.at, atFallo,
      '(d) el 404 no reintenta el render: el «fallo» cacheado manda');
    const view = await h.raw('GET', '/api/files/view?id=' + encodeURIComponent(id), undefined,
      { 'x-pacosat-token': h.token() });
    assert.equal(view.status, 200, '(d) /api/files/view lo sirve igual que hoy (200)');
    assert.ok(Buffer.from(view.text, 'latin1').equals(PDF_ROTO),
      '(d) y sirve el documento entero, byte a byte: el visor cae a su camino de siempre');
    console.log('OK 2.9.7 · D2-(d) — PDF ilegible: «fallo» cacheado, 404 honesto sin re-render y files/view intacto.');
  } finally { h.service.close(); }
}

/* ================================================================
   (c) EL VISOR PIDE PRIMERO LA VISTA Y DESPUÉS EL PDF —
   arnés de cliente de la casa (DOM de juguete + respondedor
   sembrado que registra el orden), sobre el artefacto real.
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
const andar = (el, salida = []) => { salida.push(el); for (const h of el.children || []) andar(h, salida); return salida; };
const textoDe = el => { let t = el.textContent || ''; for (const h of el.children || []) t += ' ' + textoDe(h); return t; };
const asentar = async (n = 30) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)); };

async function bootClienteVisor297(responder) {
  const byId = new Map();
  const slotActividad = new FakeElement('div');
  const fetchLog = [];
  const metas = { 'meta[name="pacosat-token"]': { content: 'token-de-prueba' },
    'meta[name="pacosat-cloud"]': { content: '1' } };
  const headEl = new FakeElement('head');
  const buscarEnCampos = sel => {
    const campos = byId.get('fields'); if (!campos) return null;
    if (sel.includes('data-visor-previa')) return andar(campos).find(el => el.dataset.visorPrevia) || null;
    if (sel.includes('data-visor-cargando')) return andar(campos).find(el => el.dataset.visorCargando) || null;
    return null;
  };
  const documentStub = {
    getElementById: id => { if (!byId.has(id)) byId.set(id, new FakeElement('div')); return byId.get(id); },
    createElement: tag => new FakeElement(tag),
    createElementNS: (_ns, tag) => new FakeElement(tag),
    createTextNode: text => ({ textContent: String(text) }),
    querySelector: sel => sel === '[data-sys-activity]' ? slotActividad
      : (buscarEnCampos(sel) ?? metas[sel] ?? null),
    querySelectorAll: () => [], addEventListener: () => {}, removeEventListener: () => {},
    documentElement: new FakeElement('html'), body: new FakeElement('body'), head: headEl,
    activeElement: null, title: '' };
  const storageStub = (semilla = {}) => { const map = new Map(Object.entries(semilla));
    return { getItem: k => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)),
      removeItem: k => map.delete(k), clear: () => map.clear() }; };
  const fetchStub = async (url, init = {}) => {
    const target = String(url);
    fetchLog.push({ method: init.method || 'GET', target });
    const parteM = /\/parte\/(\w+)/.exec(target);
    if (parteM) { const src = lazyCliente.partes[parteM[1]]?.source || '';
      return { ok: true, status: 200, headers: { get: () => 'text/javascript' },
        json: async () => ({}), text: async () => src, blob: async () => new Blob([]) }; }
    const r = await responder(target, init);
    if (r !== undefined) {
      const status = r.status || 200;
      return { ok: status >= 200 && status < 300, status,
        headers: { get: () => 'application/json' },
        json: async () => r.body, text: async () => JSON.stringify(r.body),
        blob: async () => new Blob([r.blobText || JSON.stringify(r.body || {})]) };
    }
    let body = {};
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
    navigator: { onLine: true, userAgent: 'ronda297visores-test' },
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
  return { context, fetchLog, campos: () => context.document.getElementById('fields') };
}
{
  /* Estática: el orden está cableado en la fuente del visor. */
  const fuente = readFileSync(join(AQUI, 'pdf-cloud-ui.part'), 'utf8');
  const cuerpo = fuente.slice(fuente.indexOf('async function viewDocOnline'));
  assert.ok(cuerpo.indexOf('/api/miniatura200g') > -1 &&
    cuerpo.indexOf('/api/miniatura200g') < cuerpo.indexOf("satApiBlob('files/view"),
    '(c) en viewDocOnline la vista pre-generada se pide ANTES que el PDF');
  const servidor = readFileSync(join(AQUI, 'local-server.mjs'), 'utf8');
  const arch = servidor.slice(servidor.indexOf('async function archiveSatDoc'), servidor.indexOf('async function archiveSatDoc') + 6000);
  assert.ok(arch.includes('thumbEnsure200g(fileId)'), '(c) archiveSatDoc asegura la miniatura al archivar');
  assert.ok(servidor.slice(servidor.indexOf('function archiveDeclaracion'), servidor.indexOf('function archiveDeclaracion') + 5000)
    .includes('thumbEnsure200g(fileId)'), '(c) archiveDeclaracion asegura la miniatura al archivar');

  const b = await bootClienteVisor297(async target => {
    if (target.includes('/api/miniatura200g')) return { body: {}, blobText: 'PNG-DE-PRUEBA' };
    if (target.includes('files/view')) { await espera(300); return { body: {}, blobText: '%PDF-de-prueba' }; }
    return undefined;
  });
  const antes = b.fetchLog.length;
  const promesa = vm.runInContext(
    'viewDocOnline({ id: "pdf:visor-297", rfc: "' + OWN + '", kind: "Opinión de cumplimiento", name: "Opinion · ' + OWN + '.pdf" })',
    b.context);
  await asentar(40); // la miniatura ya volvió; el PDF sigue viajando (300 ms)
  const pedidos = b.fetchLog.slice(antes).map(f => f.target);
  const iMin = pedidos.findIndex(t => t.includes('/api/miniatura200g'));
  const iPdf = pedidos.findIndex(t => t.includes('files/view'));
  assert.ok(iMin > -1 && iPdf > -1 && iMin < iPdf,
    '(c) el orden de peticiones del visor es: 1º la vista pre-generada, 2º el PDF — fue: ' + pedidos.join(' → '));
  const previa = andar(b.campos()).find(el => el.dataset.visorPrevia === '1');
  assert.ok(previa && previa.tagName === 'IMG',
    '(c) mientras el PDF viaja, el diálogo ya pinta la primera página (img de la previa)');
  assert.ok(andar(b.campos()).some(el => el.dataset.visorCargando === '1'),
    '(c) y el diálogo dice que el documento completo va cargando detrás');
  assert.ok(!andar(b.campos()).some(el => el.tagName === 'IFRAME'),
    '(c) el iframe del visor completo aún no está: la previa no esperó al blob entero');
  await promesa; await asentar(40);
  assert.ok(andar(b.campos()).some(el => el.tagName === 'IFRAME' && el.className === 'pdf-preview'),
    '(c) al llegar el PDF, el mismo diálogo se repinta con el visor de siempre (iframe pdf-preview)');
  assert.ok(!andar(b.campos()).some(el => el.dataset.visorPrevia),
    '(c) la previa se retira cuando el visor completo toma el relevo');
  const texto = textoDe(b.campos());
  assert.ok(texto.includes('Abrir PDF en otra pestaña') && texto.includes('Descargar original'),
    '(c) paridad del visor completo: «Abrir PDF en otra pestaña» y «Descargar original» siguen ahí');
  console.log('OK 2.9.7 · D2-(c) — El visor pide 1º la vista pre-generada y 2º el PDF, pinta la previa durante la carga y termina en el visor completo de siempre.');
}
console.log('OK suite ronda297visores completa');
