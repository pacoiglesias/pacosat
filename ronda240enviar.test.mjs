/* ================================================================
   Ronda 2.4.0 · W4a — «Enviar» en un toque (3 canales) + el
   trabajo vivo en el hueco de Hoy.
   Sobre el ARTEFACTO construido y con el arnés DOM de la casa
   (ronda200a/ronda232cliente/ronda240documentos):
   (a) cada superficie tocada pinta «Enviar» junto a «Descargar»
       (Documentos, protagonistas de Constancia/Opinión,
       Reportes, CSV del mes, Cierre guiado y ficha del CFDI);
   (b) la tarjeta de correo compone el POST exacto a /api/enviar
       con la clase correcta por superficie (documento y zip-mes);
   (c) sin confirmación en la tarjeta no hay POST;
   (d) fallo 502 ⇒ la tarjeta enseña el porqué y conserva
       destinatario y asunto;
   (e) Compartir usa navigator.share con el archivo cuando la
       doble lo admite y cae al respaldo declarado cuando no;
   (f) Hoy pinta el trabajo vivo en el hueco con su gesto de
       parada (el control real de Actividad).
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
const OWN = 'MFI6212158B4';

/* ===== Arnés DOM (el de ronda240documentos) ===== */
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
    navigator: { onLine: true, userAgent: 'ronda240enviar-test' },
    location: { href: 'http://127.0.0.1:43729/', search: '', reload: () => {} },
    localStorage: storageStub(), sessionStorage: storageStub(),
    fetch: fetchStub, setTimeout: timer, setInterval: every,
    clearTimeout, clearInterval, queueMicrotask,
    URL: BootURL, URLSearchParams, Blob, File, TextEncoder, TextDecoder, btoa, atob,
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
async function bootCliente(conSalidas = false) {
  const context = makeBootContext();
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  vm.runInContext(script, context, { filename: 'Faro-Fiscal.html#script' });
  if (conSalidas) vm.runInContext(lazy.partes.salidas.source, context, { filename: 'salidas.lazy' });
  for (let i = 0; i < 12; i++) await new Promise(resolve => setTimeout(resolve, 0));
  return context;
}
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 0)); };
const botonDe = (raiz, texto) => buscar(raiz, e => e.tagName === 'BUTTON' && (e.textContent || '').trim() === texto)[0];
const botonesDe = (raiz, texto) => buscar(raiz, e => e.tagName === 'BUTTON' && (e.textContent || '').trim() === texto);
/* RE-BASE 2.9.0: en Reportes cada «Enviar» nombra su reporte
   («Enviar este reporte», con el nombre en su dataset, su
   título y su aria-label — orden de la auditoría viva,
   Bloque C). El ayudante de conteo acepta el texto nuevo: un
   botón cuyo rótulo ES «Enviar» o empieza por «Enviar » y
   nombra lo que envía. El conteo de Reportes (6) y la
   aserción del dataset no cambian. */
const botonesEnviar = raiz => buscar(raiz, e => e.tagName === 'BUTTON' &&
  ((e.textContent || '').trim() === 'Enviar' || (e.textContent || '').trim().startsWith('Enviar ')));
function instalarSatApi(ctx, responder) {
  ctx.__llamadas240 = [];
  ctx.__responder240 = responder;
  ctx.__stub240 = async (path, data) => {
    ctx.__llamadas240.push([String(path), data === undefined ? null : data]);
    return ctx.__responder240(String(path), data);
  };
  vm.runInContext('satApi = __stub240;', ctx);
}
const perfilBase = () => ({
  rfc: OWN,
  config: { enabled: false, day: 5, hour: 9, recipients: '' },
  constancia: { issuedAt: Date.parse('2026-11-12T12:00:00Z'), ageDays: 5, level: 'ok', source: 'auto', fileId: 'pdf:cons-juguete' },
  opinion: { issuedAt: Date.parse('2026-11-12T12:00:00Z'), ageDays: 5, level: 'ok', source: 'auto', fileId: 'pdf:op-juguete',
    sentido: 'positiva', vigencia: '' },
  progress: null, runs: [], lastError: '', lastFailure: null, lastAttempt: 0
});
function semilla(ctx) {
  ctx.Node = FakeElement;
  vm.runInContext(`scope = "${OWN}"; people = [{ id: "${OWN}", name: "Mano Fil, S.A." }]; documents = []; invoices = [];`, ctx);
}
const salidaBase64 = () => btoa('contenido de juguete');
const responderSalidas = () => ({
  'salidas/last': {},
  'cierre200g': { pasos: [{ label: 'Cobertura', ok: true, detalle: 'bien' }], completo: false, cerrado: false, ejercicioCerrado: false },
  'informes200g': {},
  'salidas/pdf': { content: salidaBase64(), type: 'application/pdf', name: 'reporte-juguete.pdf' },
  'salidas/xlsx': { content: salidaBase64(), type: 'application/vnd.ms-excel', name: 'reporte-juguete.xlsx' },
  'salidas200g/zip-mes': { content: salidaBase64(), type: 'application/zip', name: 'zip-mes-juguete.zip' },
  'salidas200g/polizas': { content: salidaBase64(), type: 'application/pdf', name: 'polizas-juguete.pdf' },
  'informes200g/servir': { content: salidaBase64(), type: 'application/pdf', name: 'cierre-guardado.pdf' },
  'salidas/reporte-manofil': { content: salidaBase64(), type: 'application/pdf', name: 'manofil-juguete.pdf' },
  'salidas/cfdi': { content: salidaBase64(), type: 'application/pdf', name: 'comprobante-juguete.pdf' }
});
function responderVacio(path, _data) {
  if (path === 'satdocs') return { profiles: [perfilBase()] };
  if (path.startsWith('declaraciones?')) return { mapa: { meses: [] }, documentos: [], cruce201: null };
  if (path === 'activity') return { running: [], paused: [], recent: [] };
  const base = path.split('?')[0];
  if (base === 'cierre200g') return { pasos: [{ label: 'Cobertura', ok: true, detalle: 'bien' }],
    completo: false, cerrado: false, cerradoAt: 0, ejercicioCerrado: false };
  if (base === 'informes200g') return {};
  return responderSalidas()[base] ?? {};
}

/* ===== (a) cada superficie pinta «Enviar» junto a «Descargar» ===== */
{
  const ctx = await bootCliente(true);
  semilla(ctx);
  instalarSatApi(ctx, responderVacio);
  vm.runInContext(`documents = [{ id: "doc-1", name: "Factura de juguete.pdf", kind: "Factura PDF", rfc: "${OWN}", date: "2026-11-10", period: "2026-11" }];`, ctx);
  const parts = vm.runInContext('docsView()', ctx);
  await flush();
  /* El listado del expediente: RE-BASE 2.9.9 (mandato D2 de
     la auditoría visual) — la fila lleva UN solo botón «⋯» y
     TODAS sus acciones viven en su menú, con las mismas
     palabras: «Enviar» sigue junto a «Descargar», ahora
     dentro del menú de la fila. */
  const menuFila = buscar(parts.find(p => textoDe(p).includes('Factura de juguete.pdf')) || parts[parts.length - 1],
    e => String(e.className || '').split(' ').includes('card-menu'));
  assert.ok(menuFila.length, '(a) la fila del documento del expediente tiene su menú «⋯»');
  const itemsFila = menuFila[0].children.map(c => (c.textContent || '').trim());
  assert.ok(itemsFila.includes('Descargar'), '(a) el menú de la fila lleva su «Descargar»');
  assert.equal(itemsFila[itemsFila.indexOf('Descargar') + 1], 'Enviar',
    '(a) en el listado del expediente, «Enviar» va junto a «Descargar» (dentro del menú «⋯» desde la 2.9.9 · D2)');
  assert.ok(itemsFila.includes('Archivar'), '(a) «Archivar» sigue en la fila (en su menú): nada desaparece');
  /* Las protagonistas de Constancia y Opinión: Enviar tras Descargar. */
  const heroes = buscar(parts[0], e => String(e.className || '').split(' ').includes('doc-hero240'));
  assert.equal(heroes.length, 2, '(a) las dos protagonistas existen');
  for (const hero of heroes) {
    const ts = buscar(hero, e => e.tagName === 'BUTTON').map(b => (b.textContent || '').trim());
    assert.ok(ts.includes('Descargar'), '(a) la protagonista lleva su «Descargar»');
    /* RE-BASE 2.9.0: la adyacencia se conserva — el botón que
       sigue a «Descargar» es su «Enviar» — aceptando el
       rótulo que nombra lo que envía (empieza por «Enviar»),
       como el de Reportes. */
    assert.ok((ts[ts.indexOf('Descargar') + 1] || '').startsWith('Enviar'),
      '(a) en la protagonista, «Enviar» va junto a «Descargar»');
  }
  /* Reportes: las 6 filas (sin contraparte, sin CFDI) llevan su Enviar. */
  const reportes = vm.runInContext('reportesScreen201()', ctx);
  const enviarReportes = botonesEnviar(reportes[0]);
  assert.equal(enviarReportes.length, 6,
    '(a) Reportes pinta «Enviar» en Totales, Por mes, Declaraciones, Dinero, Conciliación y Avisos (6; Por contraparte necesita CFDI)');
  assert.ok(enviarReportes.every(b => b.dataset.reporteEnviar240),
    '(a) cada «Enviar» de Reportes nombra su reporte');
  /* RE-BASE 2.9.0: el rótulo de Reportes es el nuevo —
     «Enviar este reporte» — y cada botón nombra el suyo en
     su título (dataset.reporteEnviar240 intacto, arriba). */
  assert.ok(enviarReportes.every(b => (b.textContent || '').trim() === 'Enviar este reporte' &&
    String(b.title || '').includes(b.dataset.reporteEnviar240)),
    '(a) cada «Enviar» de Reportes dice «Enviar este reporte» y nombra el suyo en su título');
  const textoRep = textoDe(reportes[0]);
  assert.ok(textoRep.includes('Descargar el reporte en PDF') || textoRep.includes('PDF'),
    '(a) las descargas de Reportes siguen ahí');
  /* Salidas: CSV del mes, salidas por destino, cierre y Mano Fil. */
  const salidas = vm.runInContext('salidasScreen()', ctx);
  await flush();
  assert.ok(botonDe(salidas[0], 'Enviar') || botonesEnviar(salidas[0]).length,
    '(a) la pantalla de Salidas pinta «Enviar»');
  const csvEnviar = buscar(salidas[0], e => e.tagName === 'BUTTON' && e.dataset.enviarCsv240 === '1')[0];
  assert.ok(csvEnviar, '(a) el CSV del mes tiene su «Enviar» junto a «Descargar CSV del mes»');
  assert.ok(botonesEnviar(salidas[0]).length >= 4,
    '(a) Salidas por destino, el cierre y Mano Fil pintan sus «Enviar» (CSV + destino + ZIP del mes + Mano Fil, como mínimo)');
  /* El cierre guiado: tras pulsar «Comprobar», el ZIP del mes lleva Enviar. */
  const comprobar = botonDe(salidas[0], 'Comprobar el cierre del mes');
  assert.ok(comprobar, '(a) el panel de cierre guiado existe');
  await comprobar.onclick();
  await flush();
  const zipEnviar = buscar(salidas[0], e => e.tagName === 'BUTTON' && e.dataset.enviarZipMes240 === '1')[0];
  assert.ok(zipEnviar, '(a) «El mes en un ZIP» tiene su «Enviar» con correo (clase zip-mes)');
  assert.ok(buscar(salidas[0], e => e.tagName === 'BUTTON' && e.dataset.enviarPolizas240 === '1')[0],
    '(a) las pólizas también llevan su «Enviar» (solo compartir)');
  /* La ficha del CFDI: Enviar (PDF) y Enviar XML junto a las descargas. */
  const fila = { id: 'uuid-juguete-1', kind: 'I', date: '2026-11-10',
    from: { rfc: OWN, name: 'Mano Fil, S.A.' }, to: { rfc: 'AAA010101AAA', name: 'Cliente' },
    total: '100.00', fiscal: { serie: 'A', folio: '1', subtotal: '86.21' }, concepts: [] };
  vm.runInContext('invoiceDetail(' + JSON.stringify(fila).replace(/</g, '\\u003c') + ')', ctx);
  await flush();
  const campos = vm.runInContext(`$('fields')`, ctx);
  const textoFicha = textoDe(campos);
  assert.ok(textoFicha.includes('Enviar'), '(a) la ficha del CFDI pinta «Enviar» junto a sus descargas');
  assert.ok(textoFicha.includes('Enviar XML'), '(a) la ficha del CFDI pinta «Enviar XML» junto a «Descargar XML original»');
  assert.ok(textoFicha.includes('Descargar PDF'), '(a) el «Descargar PDF» de la ficha sigue ahí: paridad');
  /* Las acciones por fila de Facturas: Enviar junto a PDF/XML. */
  const accionesFila = vm.runInContext('invoiceActions(' + JSON.stringify(fila).replace(/</g, '\\u003c') + ')', ctx);
  const tsFila = buscar(accionesFila, e => e.tagName === 'BUTTON').map(b => (b.textContent || '').trim());
  assert.ok(tsFila.includes('Enviar'), '(a) la fila de la factura lleva «Enviar» junto a PDF y XML');
  assert.ok(tsFila.includes('PDF') && tsFila.includes('XML'), '(a) la fila conserva PDF y XML');
  console.log('OK 2.4.0·W4a (a) — «Enviar» junto a «Descargar» en Documentos, protagonistas, Reportes, Salidas, Cierre y ficha/fila del CFDI.');
}

/* ===== (b) la tarjeta compone el POST exacto a /api/enviar ===== */
{
  const ctx = await bootCliente();
  semilla(ctx);
  instalarSatApi(ctx, responderVacio);
  /* Documento del expediente, por id. */
  vm.runInContext(`enviarTarjeta240({ nombre: "Factura de juguete.pdf", asunto: "PacoSAT · Factura de juguete.pdf",
    correo: { clase: "documento", id: "doc-1" }, archivo: async () => ({ blob: new Blob(["x"], { type: "application/pdf" }), nombre: "Factura de juguete.pdf" }) })`, ctx);
  const campos = vm.runInContext(`$('fields')`, ctx);
  const para = buscar(campos, e => e.getAttribute && e.getAttribute('aria-label') === 'Destinatario')[0];
  const asunto = buscar(campos, e => e.getAttribute && e.getAttribute('aria-label') === 'Asunto')[0];
  assert.ok(para && asunto, '(b) la tarjeta trae destinatario y asunto');
  para.value = 'n.rodriguez@consultoresbg.com';
  asunto.value = 'PacoSAT · Factura de juguete.pdf';
  const enviar = botonDe(campos, 'Enviar por correo');
  assert.ok(enviar, '(b) la tarjeta trae su botón de confirmación de correo');
  await enviar.onclick();
  await flush();
  const llamada = ctx.__llamadas240.find(([path]) => path === 'enviar');
  assert.ok(llamada, '(b) la confirmación despacha el envío por la ruta de W2');
  assert.equal(JSON.stringify(llamada[1]), JSON.stringify({ para: 'n.rodriguez@consultoresbg.com',
    asunto: 'PacoSAT · Factura de juguete.pdf', clase: 'documento', id: 'doc-1' }),
    '(b) el POST es exacto: { para, asunto, clase: "documento", id } — sin ruta libre ni campo extra');
  const texto = textoDe(campos);
  assert.ok(texto.includes('Nora') && texto.includes('Yo mismo'),
    '(b) los frecuentes van primero: Nora/el despacho y Paco mismo');
  assert.ok(texto.includes('Enviado'), '(b) la confirmación en pantalla al enviar');
  /* ZIP del mes, por rfc y mes. */
  ctx.__llamadas240 = [];
  vm.runInContext(`enviarTarjeta240({ nombre: "ZIP del mes 2026-11 de ${OWN}", asunto: "PacoSAT · ZIP del mes 2026-11",
    correo: { clase: "zip-mes", rfc: "${OWN}", mes: "2026-11" }, archivo: async () => ({ blob: new Blob(["x"], { type: "application/zip" }), nombre: "zip.zip" }) })`, ctx);
  const campos2 = vm.runInContext(`$('fields')`, ctx);
  const para2 = buscar(campos2, e => e.getAttribute && e.getAttribute('aria-label') === 'Destinatario')[0];
  para2.value = 'paco.iglesias@gmail.com';
  await botonDe(campos2, 'Enviar por correo').onclick();
  await flush();
  const llamadaZip = ctx.__llamadas240.find(([path]) => path === 'enviar');
  assert.equal(JSON.stringify(llamadaZip[1]), JSON.stringify({ para: 'paco.iglesias@gmail.com',
    asunto: 'PacoSAT · ZIP del mes 2026-11', clase: 'zip-mes', rfc: OWN, mes: '2026-11' }),
    '(b) el ZIP del mes compone { clase: "zip-mes", rfc, mes } exactos');
  console.log('OK 2.4.0·W4a (b) — el POST a /api/enviar es exacto: documento por id y zip-mes por rfc+mes.');
}

/* ===== (c) sin confirmación, nada sale ===== */
{
  const ctx = await bootCliente();
  semilla(ctx);
  instalarSatApi(ctx, responderVacio);
  vm.runInContext(`enviarTarjeta240({ nombre: "Factura de juguete.pdf", asunto: "PacoSAT · Factura",
    correo: { clase: "documento", id: "doc-1" }, archivo: async () => ({ blob: new Blob(["x"]), nombre: "f.pdf" }) })`, ctx);
  await flush();
  assert.equal(ctx.__llamadas240.filter(([path]) => path === 'enviar').length, 0,
    '(c) abrir la tarjeta y no confirmar no despacha ningún POST a /api/enviar');
  console.log('OK 2.4.0·W4a (c) — sin confirmación en la tarjeta, nada sale.');
}

/* ===== (d) el fallo 502 enseña el porqué y conserva el borrador ===== */
{
  const ctx = await bootCliente();
  semilla(ctx);
  instalarSatApi(ctx, (path, _data) => {
    if (path === 'enviar') throw new Error('El envío no salió: el correo no está configurado en esta instalación. Tu borrador no se guardó en el servidor: consérvalo en la pantalla y reinténtalo desde ahí.');
    return responderVacio(path);
  });
  vm.runInContext(`enviarTarjeta240({ nombre: "Factura de juguete.pdf", asunto: "PacoSAT · Factura",
    correo: { clase: "documento", id: "doc-1" }, archivo: async () => ({ blob: new Blob(["x"]), nombre: "f.pdf" }) })`, ctx);
  const campos = vm.runInContext(`$('fields')`, ctx);
  const para = buscar(campos, e => e.getAttribute && e.getAttribute('aria-label') === 'Destinatario')[0];
  const asunto = buscar(campos, e => e.getAttribute && e.getAttribute('aria-label') === 'Asunto')[0];
  para.value = 'n.rodriguez@consultoresbg.com';
  asunto.value = 'Asunto de reintento';
  await botonDe(campos, 'Enviar por correo').onclick();
  await flush();
  const texto = textoDe(campos);
  assert.ok(texto.includes('No salió: El envío no salió: el correo no está configurado'),
    '(d) el fallo 502 enseña el porqué en la propia tarjeta, en llano');
  assert.equal(para.value, 'n.rodriguez@consultoresbg.com',
    '(d) el destinatario se conserva para reintentar');
  assert.equal(asunto.value, 'Asunto de reintento', '(d) el asunto se conserva para reintentar');
  console.log('OK 2.4.0·W4a (d) — fallo 502: el porqué en la tarjeta y el borrador conservado.');
}

/* ===== (e) Compartir: con archivo cuando se puede, respaldo honesto cuando no ===== */
{
  /* Con compartir-archivos: navigator.share con el archivo. */
  const ctx = await bootCliente();
  semilla(ctx);
  instalarSatApi(ctx, responderVacio);
  ctx.__share240 = null;
  ctx.navigator.share = async datos => { ctx.__share240 = datos; };
  ctx.navigator.canShare = () => true;
  vm.runInContext(`enviarTarjeta240({ nombre: "reporte-juguete.pdf", asunto: "PacoSAT · Reporte",
    correo: null, archivo: async () => ({ blob: new Blob(["contenido"], { type: "application/pdf" }), nombre: "reporte-juguete.pdf" }) })`, ctx);
  const campos = vm.runInContext(`$('fields')`, ctx);
  const textoAntes = textoDe(campos);
  assert.ok(textoAntes.includes('no está entre los que el correo de PacoSAT puede adjuntar'),
    '(e) sin clase de correo, la tarjeta explica por qué no hay correo — nunca promete un correo que la ruta rechazaría');
  const comp = buscar(campos, e => e.tagName === 'BUTTON' && e.dataset.enviarCanal === 'compartir')[0];
  assert.ok(comp, '(e) la tarjeta trae su botón Compartir');
  await comp.onclick();
  await flush();
  assert.ok(ctx.__share240, '(e) con compartir-archivos, se abre la hoja del aparato');
  assert.equal(ctx.__share240.files[0].name, 'reporte-juguete.pdf',
    '(e) la hoja lleva el archivo de verdad, con su nombre');
  /* WhatsApp en el mismo aparato: también por la hoja, con el archivo. */
  ctx.__share240 = null;
  await buscar(campos, e => e.tagName === 'BUTTON' && e.dataset.enviarCanal === 'whatsapp')[0].onclick();
  await flush();
  assert.ok(ctx.__share240 && ctx.__share240.files[0].name === 'reporte-juguete.pdf',
    '(e) en un aparato que comparte archivos, WhatsApp sale por la hoja con el adjunto');
  /* Sin compartir-archivos: respaldo declarado (descarga + wa.me) y sin promesa falsa. */
  const ctx2 = await bootCliente();
  semilla(ctx2);
  instalarSatApi(ctx2, responderVacio);
  ctx2.navigator.share = undefined;
  ctx2.navigator.canShare = undefined;
  ctx2.__wa240 = null;
  ctx2.open = url => { ctx2.__wa240 = url; };
  vm.runInContext(`enviarTarjeta240({ nombre: "reporte-juguete.pdf", asunto: "PacoSAT · Reporte",
    correo: null, archivo: async () => ({ blob: new Blob(["contenido"], { type: "application/pdf" }), nombre: "reporte-juguete.pdf" }) })`, ctx2);
  const campos2 = vm.runInContext(`$('fields')`, ctx2);
  await buscar(campos2, e => e.tagName === 'BUTTON' && e.dataset.enviarCanal === 'compartir')[0].onclick();
  await flush();
  assert.ok(textoDe(campos2).includes('no puede compartir archivos'),
    '(e) sin compartir-archivos, la tarjeta dice el respaldo en llano: el documento se descargó');
  await buscar(campos2, e => e.tagName === 'BUTTON' && e.dataset.enviarCanal === 'whatsapp')[0].onclick();
  await flush();
  assert.ok(String(ctx2.__wa240 || '').startsWith('https://wa.me/?text='),
    '(e) en PC, WhatsApp abre el chat (wa.me, sin número concreto) con el texto listo');
  assert.ok(textoDe(campos2).includes('PacoSAT no envía WhatsApp por su cuenta'),
    '(e) la tarjeta dice en llano que PacoSAT no envía WhatsApp por su cuenta');
  console.log('OK 2.4.0·W4a (e) — Compartir con archivo donde se puede; respaldo honesto (descargar + wa.me) donde no.');
}

/* ===== (f) Hoy pinta el trabajo vivo en el hueco, con su gesto ===== */
{
  const ctx = await bootCliente();
  /* RE-BASE integración 2.4.0 (W6): el control real de Actividad
     (el «Detener» de la tarjeta viva) vive en la parte diferida
     de Vigilancia. Se inyectan las fuentes desde lazy.json, en
     el orden del cargador (Descargas antes que Vigilancia) y
     ANTES de la semilla, para que el pulso que la parte arranca
     se asiente contra el stub por defecto. */
  vm.runInContext(lazy.partes.descargas.source, ctx, { filename: 'parte-descargas' });
  vm.runInContext(lazy.partes.monitor.source, ctx, { filename: 'parte-monitor' });
  await flush();
  semilla(ctx);
  const vista = {
    running: [{ label: 'Descarga masiva', kind: 'masiva', phase: 'Esperando al SAT',
      detail: 'esperando al SAT desde hace 7 min · Recibidos/Emitidos 2026-11', since: Date.now() - 420000,
      canStop: true, stopLabel: 'Detener', jobId: 'job-juguete-1', rfc: OWN }],
    paused: [{ label: 'Revisión mensual', kind: 'masiva', phase: 'En pausa',
      detail: 'en pausa · Recibidos 2026-10', since: Date.now() - 3600000,
      canResume: true, jobId: 'job-juguete-2', rfc: OWN }],
    recent: [{ text: 'Descarga terminada', at: Date.now() - 60000 }]
  };
  instalarSatApi(ctx, (path, _data) => {
    if (path === 'activity') return vista;
    if (path === 'activity/control') return { message: 'Hecho.' };
    return responderVacio(path);
  });
  const panel = vm.runInContext('hoyActividadPanel240()', ctx);
  await flush();
  /* El hueco [data-sys-activity] existe dentro del panel de Hoy. */
  const hueco = buscar(panel, e => e.getAttribute && e.getAttribute('data-sys-activity') === '')[0];
  assert.ok(hueco, '(f) el panel de Hoy trae el hueco [data-sys-activity] para lo reciente');
  /* El trabajo vivo, con su detalle y su gesto real de parada. */
  const vivos = buscar(panel, e => e.dataset && e.dataset.hoyVivo240 === '1')[0];
  assert.ok(vivos, '(f) el panel trae su zona de trabajo vivo');
  assert.equal(vivos.dataset.hoyVivos, '2', '(f) se pintan los dos trabajos vivos (en curso y en pausa)');
  const textoVivo = textoDe(vivos);
  assert.ok(textoVivo.includes('Descarga masiva') && textoVivo.includes('Esperando al SAT'),
    '(f) el trabajo en curso se ve con su detalle vivo');
  assert.ok(textoVivo.includes('Revisión mensual'), '(f) el trabajo en pausa también se ve');
  const detener = botonDe(vivos, 'Detener');
  assert.ok(detener, '(f) la solicitud viva trae su «Detener» (el control real de Actividad, no un botón pintado)');
  assert.ok(botonDe(vivos, 'Reanudar'), '(f) la retenida trae su «Reanudar»');
  /* El gesto despacha el control real con su jobId. */
  await detener.onclick();
  await flush();
  const control = ctx.__llamadas240.find(([path]) => path === 'activity/control');
  assert.ok(control, '(f) pulsar «Detener» despacha el control de actividad');
  assert.equal(JSON.stringify(control[1]), JSON.stringify({ kind: 'masiva', action: 'detener', jobId: 'job-juguete-1' }),
    '(f) el control lleva kind, acción y jobId exactos de la entrada viva');
  /* Sin trabajo vivo: el estado honesto, sin botones que prometan. */
  ctx.__responder240 = (path, _data) => {
    if (path === 'activity') return { running: [], paused: [], recent: [] };
    return responderVacio(path);
  };
  vm.runInContext('satApi = __stub240;', ctx);
  const panelVacio = vm.runInContext('hoyActividadPanel240()', ctx);
  await flush();
  const vivosVacio = buscar(panelVacio, e => e.dataset && e.dataset.hoyVivo240 === '1')[0];
  assert.ok(textoDe(vivosVacio).includes('Sin trabajo en curso ahora mismo.'),
    '(f) sin trabajo vivo, Hoy lo dice tal cual');
  console.log('OK 2.4.0·W4a (f) — Hoy enseña el trabajo vivo en el hueco, con Detener/Reanudar reales.');
}
