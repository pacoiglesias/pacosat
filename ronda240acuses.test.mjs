/* ================================================================
   Ronda 2.4.0 · W4c — «Enviar» en los acuses de Declaraciones.
   Cableado pendiente de W4a: la infraestructura (enviarBoton240 /
   enviarTarjeta240, en ui.part) y la ruta POST /api/enviar ya
   admitían {clase:'acuse', id}, pero todas las filas de acuses
   con «Descargar» viven en declaraciones-ui.part.

   MAPEO DE IDS (verificado leyendo el código, no supuesto):
   · La ruta (local-server.mjs, resolverAdjuntoEnviar240, clase
     'acuse') hace SELECT * FROM declaraciones WHERE id=? — espera
     el id de la fila en la tabla DECLARACIONES y de ahí saca su
     fileId para leer el fichero.
   · La vista (declaracionesOverview, en el mismo servidor) manda
     cada documento como { id: row.id, fileId: row.fileId, … }:
     doc.id ES ese id de declaraciones y doc.fileId es OTRO id —
     el de la entrada en el expediente (documents), que es el que
     usan «Ver»/«Descargar» (downloadDocOnline/viewDocOnline).
   · El id de corrida (decl_runs, el «run=» de
     /api/declaraciones/artifact?run=…&part=…) NO es ninguno de
     los dos: sirve para la evidencia de una corrida caída, no
     para un acuse. Hueco declarado abajo.

   Sobre el ARTEFACTO construido y con el arnés DOM de la casa:
   (a) el grupo de Documentos, el detalle del mes y la lista
       completa pintan «Enviar» JUSTO tras «Descargar» en la fila
       del acuse, sin mover ningún «Descargar»;
   (b) el clic compone la referencia exacta {clase:'acuse',
       id: doc.id} — el id de declaraciones, NO el fileId del
       expediente — y la tarjeta despacha el POST exacto;
   (c) la fila de la declaración (formulario) pinta su
       «Enviar» con la clase «formulario», NUNCA con «acuse»
       (premisa re-basada por el coordinador: W4c la dejó sin
       botón porque la ruta solo admitía «acuse» y la habría
       rotulado mal; W2c añadió la clase «formulario» y
       endureció «acuse» para exigir su clase de fila);
   (d) la evidencia de la corrida caída (diario, evidenceButtons
       con run.id de decl_runs) no gana ningún «Enviar»: la vista
       no tiene ahí ningún id de declaraciones que mandar.
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
const parte = read('declaraciones-ui.part');
/* RE-BASE integración 2.4.0 (W6): Declaraciones viaja diferida
   (/parte/declaraciones). Los cableados de «Enviar» ya no
   pesan en el artefacto: viven en la parte que el navegador
   recibe (lazy.json) — el conteo de abajo los cuenta sobre
   artefacto + parte, con el MISMO total esperado (3). Y el
   arnés sirve las partes por el fetch y ejecuta los scripts
   inyectados en el head, como el cargador real (patrón de
   tests/ronda240diferidas), para que declaracionesScreen y
   declaracionesGrupo201 sean las funciones reales. */
const lazy = JSON.parse(read('lazy.json'));
const OWN = 'MFI6212158B4';
const ID_DECL = 'decl-acuse-juguete-1';
const ID_FILE = 'file-acuse-juguete-1';

/* ===== Comprobaciones estáticas del mapeo ===== */
{
  const sitios = parte.match(/correo: \{ clase: 'acuse', id: doc\.id \}/g) || [];
  assert.equal(sitios.length, 3,
    '(mapa) hay exactamente 3 cableados {clase:\'acuse\', id: doc.id}: grupo, detalle e historial');
  assert.ok(!/clase: 'acuse', id: doc\.fileId/.test(parte),
    '(mapa) ningún «Enviar» de acuse usa doc.fileId (ese es el id del expediente, el de «Descargar»)');
  assert.ok(!/clase: 'acuse', id: (run|registro|folio)/.test(parte),
    '(mapa) ningún «Enviar» de acuse usa un id de corrida o de folio');
  /* RE-BASE integración 2.4.0: el hogar de los cableados es
     hoy la parte diferida de Declaraciones; se cuentan sobre
     artefacto + parte (lo que el navegador recibe en total)
     y el total esperado NO cambia: 3. */
  const enArtefacto = (html + lazy.partes.declaraciones.source)
    .match(/correo: \{ clase: 'acuse', id: doc\.id \}/g) || [];
  assert.equal(enArtefacto.length, 3, '(mapa) el artefacto construido + su parte de Declaraciones llevan los 3 cableados');
  const guardas = parte.match(/doc\.clase === 'acuse' && doc\.id/g) || [];
  assert.equal(guardas.length, 2,
    '(c) detalle e historial solo pintan «Enviar» en la fila del acuse (el grupo ya filtra acuses)');
  console.log('OK 2.4.0·W4c (mapa) — la referencia es doc.id (tabla declaraciones); fileId y run.id quedan fuera.');
}

/* ===== Arnés DOM (el de ronda240enviar) ===== */
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
    navigator: { onLine: true, userAgent: 'ronda240acuses-test' },
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
  /* El head ejecuta los scripts inyectados (las partes
     diferidas), como el navegador al aterrizar una parte. */
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
async function bootCliente() {
  const context = makeBootContext();
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  vm.runInContext(script, context, { filename: 'Faro-Fiscal.html#script' });
  for (let i = 0; i < 12; i++) await new Promise(resolve => setTimeout(resolve, 0));
  /* RE-BASE integración 2.4.0: el cargador real trae la parte
     de Declaraciones; sus funciones reales sustituyen a los
     puentes-pantalla del principal, como en producción. */
  await vm.runInContext("ensureLazyPart('declaraciones')", context);
  for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 0));
  return context;
}
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 0)); };
const botonDe = (raiz, texto) => buscar(raiz, e => e.tagName === 'BUTTON' && (e.textContent || '').trim() === texto)[0];
const botonesDe = (raiz, texto) => buscar(raiz, e => e.tagName === 'BUTTON' && (e.textContent || '').trim() === texto);
function instalarSatApi(ctx, responder) {
  ctx.__llamadas240 = [];
  ctx.__responder240 = responder;
  ctx.__stub240 = async (path, data) => {
    ctx.__llamadas240.push([String(path), data === undefined ? null : data]);
    return ctx.__responder240(String(path), data);
  };
  vm.runInContext('satApi = __stub240;', ctx);
}
/* La vista de juguete: UN acuse y UNA declaración del mismo mes,
   con ids deliberadamente DISTINTOS en cada tabla para que un
   puente equivocado se vea en el acto. */
const docAcuse = () => ({ id: ID_DECL, tipo: 'mensual', clase: 'acuse', ejercicio: 2026,
  periodo: '2026-10', fechaPresentacion: '2026-11-15', operacion: '123456789',
  fileId: ID_FILE, label: 'Acuse mensual' });
const docForm = () => ({ id: 'decl-form-juguete-1', tipo: 'mensual', clase: 'declaracion', ejercicio: 2026,
  periodo: '2026-10', fechaPresentacion: '2026-11-15', operacion: '123456789',
  fileId: 'file-form-juguete-1', label: 'Declaración mensual' });
const vistaGrupo = () => ({
  mapa: { meses: [{ periodo: '2026-10', estado: 'presentada' }] },
  documentos: [docAcuse()], cruce201: null });
const vistaPantalla = () => ({
  rfc: OWN, ejercicio: 2026, ejecutor: null, lastError: null, progreso: null,
  mapa: { meses: [{ periodo: '2026-10', estado: 'presentada', fechaPresentacion: '2026-11-15',
      operacion: '123456789', limite: '2026-11-17', declaracion: true, acuse: true }],
    resumen: { presentadas: 1, pendientes: 0, sinRecuperar: 0, pagadasSinAcuse: 0, noToca: 0 },
    anual: { estado: 'no-toca', limite: '2027-03-31', declaracion: false, acuse: false } },
  documentos: [docAcuse(), docForm()],
  cruce201: { operacionesConocidas: [], faltanAcuses: [], resumen: { conocidas: 1, conAcuse: 1 } },
  folios: [], anios: [] });
function responderBase(vista) {
  return (path, _data) => {
    if (path === 'enviar') return { ok: true, documento: 'Acuse de declaración 2026-10 de ' + OWN };
    if (path.startsWith('declaraciones/resumen')) return { hayDatos: false };
    if (path.startsWith('declaraciones/runs')) return { runs: [] };
    if (path.startsWith('declaraciones?')) return vista;
    return {};
  };
}
/* Pulsa «Enviar» en una fila, rellena la tarjeta y confirma el
   correo: devuelve el payload exacto despachado a la ruta. */
async function enviarDesde(ctx, botonEnviar) {
  assert.ok(botonEnviar, 'la fila pinta su botón «Enviar»');
  botonEnviar.onclick();
  await flush();
  const campos = vm.runInContext(`$('fields')`, ctx);
  const para = buscar(campos, e => e.getAttribute && e.getAttribute('aria-label') === 'Destinatario')[0];
  assert.ok(para, 'la tarjeta de envío trae su campo de destinatario');
  para.value = 'n.rodriguez@consultoresbg.com';
  const confirmar = botonDe(campos, 'Enviar por correo');
  assert.ok(confirmar, 'la tarjeta trae su confirmación «Enviar por correo»');
  await confirmar.onclick();
  await flush();
  const llamada = ctx.__llamadas240.find(([path]) => path === 'enviar');
  assert.ok(llamada, 'la confirmación despacha el POST a /api/enviar');
  return llamada[1];
}
const filaCon = (raiz, texto) => buscar(raiz,
  e => String(e.className || '').split(' ').includes('cp-row') && textoDe(e).includes(texto))
  .sort((a, b) => textoDe(a).length - textoDe(b).length)[0];
const textosBotones = fila => buscar(fila, e => e.tagName === 'BUTTON').map(b => (b.textContent || '').trim());

/* ===== (a)+(b) El grupo de Declaraciones en Documentos ===== */
{
  const ctx = await bootCliente();
  vm.runInContext(`scope = "${OWN}"; people = [{ id: "${OWN}", name: "Mano Fil, S.A." }];
    documents = [{ id: "${ID_FILE}", name: "Acuse mensual · ${OWN}.pdf", kind: "Acuse", rfc: "${OWN}", date: "2026-11-15" }];
    invoices = [];`, ctx);
  instalarSatApi(ctx, responderBase(vistaGrupo()));
  const grupo = vm.runInContext('declaracionesGrupo201()', ctx);
  grupo.isConnected = true; /* el grupo solo pinta si su panel sigue en el DOM */
  await flush();
  const fila = filaCon(grupo, 'Acuse mensual');
  assert.ok(fila, '(a) el grupo pinta la fila del acuse');
  const ts = textosBotones(fila);
  assert.equal(ts[ts.indexOf('Descargar') + 1], 'Enviar',
    '(a) en el grupo, «Enviar» va JUSTO tras «Descargar»: ' + ts.join(','));
  assert.ok(ts.includes('Ver') && ts.includes('Archivar'),
    '(a) paridad: «Ver» y «Archivar» siguen en la fila, sin moverse');
  const payload = await enviarDesde(ctx, botonDe(fila, 'Enviar'));
  assert.equal(payload.clase, 'acuse', '(b) la clase compuesta es «acuse»');
  assert.equal(payload.id, ID_DECL,
    '(b) el id compuesto es doc.id — el de la tabla declaraciones que la ruta espera');
  assert.notEqual(payload.id, ID_FILE,
    '(b) y NO es doc.fileId, el id del expediente que usa «Descargar»');
  assert.deepEqual(Object.keys(payload).sort(), ['asunto', 'clase', 'id', 'para'],
    '(b) el POST es exacto: {para, asunto, clase, id}, sin campos extra');
  console.log('OK 2.4.0·W4c (a)+(b-grupo) — grupo de Documentos: «Enviar» tras «Descargar» y POST {clase:\'acuse\', id: doc.id}.');
}

/* ===== (a)+(b)+(c) La pantalla: detalle del mes e historial ===== */
{
  const ctx = await bootCliente();
  vm.runInContext(`scope = "${OWN}"; people = [{ id: "${OWN}", name: "Mano Fil, S.A." }];
    documents = []; invoices = []; declEjercicio = 2026;`, ctx);
  instalarSatApi(ctx, responderBase(vistaPantalla()));
  const secciones = vm.runInContext('declaracionesScreen()', ctx);
  await flush();
  const pantalla = secciones[0];
  /* El detalle del mes: se toca la celda de octubre. */
  const celda = buscar(pantalla, e => e.tagName === 'BUTTON' && textoDe(e).includes('Octubre'))[0];
  assert.ok(celda, '(a) el mapa pinta la celda de octubre');
  celda.onclick();
  await flush();
  const detalle = buscar(pantalla, e => String(e.className || '').split(' ').includes('decl-detalle'))[0];
  assert.ok(detalle, '(a) el detalle del mes se pinta al tocar la celda');
  const filaAcuseDetalle = filaCon(detalle, 'Acuse');
  const tsDetalle = textosBotones(filaAcuseDetalle);
  assert.equal(tsDetalle[tsDetalle.indexOf('Descargar') + 1], 'Enviar',
    '(a) en el detalle, «Enviar» va JUSTO tras «Descargar» en la fila del acuse: ' + tsDetalle.join(','));
  const filaFormDetalle = filaCon(detalle, 'Declaración');
  const tsFormDetalle = textosBotones(filaFormDetalle);
  assert.ok(tsFormDetalle.includes('Descargar') && tsFormDetalle.includes('Enviar'),
    '(c) en el detalle, la fila de la declaración pinta su «Enviar» tras su «Descargar»');
  const payloadForm = await enviarDesde(ctx, botonDe(filaFormDetalle, 'Enviar'));
  assert.equal(payloadForm.clase, 'formulario',
    '(c) el «Enviar» de la declaración compone clase «formulario», nunca «acuse»');
  /* La lista completa (historial del ejercicio). */
  const filaAcuseLista = buscar(pantalla, e => String(e.className || '').split(' ').includes('cp-row') &&
    textoDe(e).includes('Acuse mensual') && textoDe(e).includes('periodo 2026-10'))[0];
  assert.ok(filaAcuseLista, '(a) la lista completa pinta la fila del acuse');
  const tsLista = textosBotones(filaAcuseLista);
  assert.equal(tsLista[tsLista.indexOf('Descargar') + 1], 'Enviar',
    '(a) en la lista completa, «Enviar» va JUSTO tras «Descargar»: ' + tsLista.join(','));
  const filaFormLista = buscar(pantalla, e => String(e.className || '').split(' ').includes('cp-row') &&
    textoDe(e).includes('Declaración mensual') && textoDe(e).includes('periodo 2026-10'))[0];
  const tsFormLista = textosBotones(filaFormLista);
  assert.ok(tsFormLista.includes('Descargar') && tsFormLista.includes('Enviar'),
    '(c) en la lista completa, la declaración también pinta su «Enviar» (clase «formulario»)');
  /* Total en la pantalla: detalle + lista, acuses y formularios. */
  assert.equal(botonesDe(pantalla, 'Enviar').length, 4,
    '(a) la pantalla pinta exactamente 4 «Enviar» (acuse y formulario, en detalle y en lista completa)');
  /* El clic del detalle compone la referencia correcta. */
  ctx.__llamadas240 = [];
  const payloadDetalle = await enviarDesde(ctx, botonDe(filaAcuseDetalle, 'Enviar'));
  assert.equal(payloadDetalle.clase, 'acuse', '(b) el detalle compone clase «acuse»');
  assert.equal(payloadDetalle.id, ID_DECL, '(b) el detalle manda doc.id, el de declaraciones');
  /* Y el de la lista completa, el mismo. */
  ctx.__llamadas240 = [];
  const payloadLista = await enviarDesde(ctx, botonDe(filaAcuseLista, 'Enviar'));
  assert.equal(payloadLista.clase, 'acuse', '(b) la lista compone clase «acuse»');
  assert.equal(payloadLista.id, ID_DECL, '(b) la lista manda doc.id, el de declaraciones');
  console.log('OK 2.4.0·W4c (a)+(b)+(c-pantalla) — detalle e historial: «Enviar» solo en el acuse, con su id de declaraciones.');
}

/* ===== (d) Hueco de la corrida: su evidencia no es un acuse ===== */
{
  assert.ok(parte.includes("evidenceButtons('declaraciones', run)"),
    '(d) el diario de la corrida sigue pintando su evidencia como hasta ahora');
  const diario = parte.slice(parte.indexOf('function declRunsDetails'),
    parte.indexOf('/* Fallback asistido'));
  assert.ok(!diario.includes('enviarBoton240'),
    '(d) el diario NO pinta «Enviar»: su único id es el de la corrida (decl_runs), que la ruta «acuse» no acepta');
  console.log('OK 2.4.0·W4c (d) — hueco fijado: la evidencia de la corrida (run.id) no gana «Enviar» con id equivocado.');
}
console.log('OK 2.4.0·W4c — «Enviar» en los acuses de Declaraciones: grupo, detalle e historial, con {clase:\'acuse\', id: doc.id}.');
