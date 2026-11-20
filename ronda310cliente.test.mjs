/* ================================================================
   Ronda 3.1.0 · cliente — multi-RFC sin mezclar (estructural,
   para N contribuyentes), identidad visual por RFC, el botón
   muerto de la CIEC, avisos aviso/error con su resolución, la
   tarjeta «Ponerme al día» con etapa/tiempo/resumen, cabeceras
   con RFC y periodo, y la pantalla Administración (triage).

   Arnés: el de ronda200b (DOM falso + vm sobre el HTML
   construido), con la tabla de rutas de fetch programable por
   prueba. Fixtures con TRES RFC propios (MFI6212158B4,
   IEAF690704QQ9 y XAXX010101000) para probar que el aislamiento
   no es un atajo binario: cada dato sale de SU RFC.
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
const MFI = 'MFI6212158B4', IEAF = 'IEAF690704QQ9', TERCERO = 'XAXX010101000';
const AHORA = Date.now();

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
    this.className = '';
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
  after(kid) { if (kid instanceof FakeElement) this.children.push(kid); }
  insertAdjacentElement(_where, kid) { return kid; }
  insertAdjacentHTML() {}
  insertAdjacentText() {}
  cloneNode() { return new FakeElement(this.tagName); }
  replaceChildren(...kids) { this.children = kids.filter(kid => kid instanceof FakeElement); }
  remove() {}
  click() { if (typeof this.onclick === 'function') this.onclick(); }
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
/* Rutas programables: clave = substring de la URL; valor = cuerpo
   o función(url) → cuerpo. Se reescribe por prueba. */
const rutas310 = new Map();
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
    let matched = false;
    for (const [clave, valor] of rutas310)
      if (target.includes(clave)) { body = typeof valor === 'function' ? valor(target) : valor; matched = true; break; }
    if (!matched) {
      if (target.includes('storage/rev')) body = { rev: 1 };
      else if (target.includes('storage?')) body = [];
      else if (target.includes('/api/status')) body = {
        settings: { installName: 'PacoSAT', hasLogo: false },
        buildModified: null, cloudRevision: null, profiles: [], jobs: [], inbox: [], mail: {} };
    }
    return { ok: true, status: 200, headers: { get: () => 'application/json' },
      json: async () => body, text: async () => JSON.stringify(body), blob: async () => new Blob([]) };
  };
  const timer = (fn, ms, ...args) => { const t = setTimeout(fn, ms, ...args); t.unref?.(); return t; };
  const every = (fn, ms, ...args) => { const t = setInterval(fn, ms, ...args); t.unref?.(); return t; };
  const context = vm.createContext({
    console, document: documentStub,
    navigator: { onLine: true, userAgent: 'ronda310-test' },
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
const buscarDataset = (el, clave, valor, salida = []) => {
  if (el.dataset && el.dataset[clave] === valor) salida.push(el);
  for (const hijo of el.children || []) buscarDataset(hijo, clave, valor, salida);
  return salida;
};
const dormir = async (ms = 40) => { await new Promise(r => setTimeout(r, ms)); };
async function bootCliente() {
  const context = makeBootContext();
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  vm.runInContext(script, context, { filename: 'Faro-Fiscal.html#script' });
  for (let i = 0; i < 12; i++) await new Promise(resolve => setTimeout(resolve, 0));
  return context;
}
const ponerGente = (context, gente, sd = {}) => {
  context.__gente = gente; context.__sd = sd;
  vm.runInContext('people = __gente; satData = __sd;', context);
};

/* ===== (1) Identidad: color automático estable para N RFC ===== */
{
  const context = await bootCliente();
  ponerGente(context,
    [{ id: MFI, name: 'Mano Fil, S.A.' }, { id: IEAF, name: 'Francisco Javier Iglesias Arenas' },
     { id: TERCERO, name: 'Tercero SA' }],
    { profiles: [], settings: {}, puerta: {}, ejecutor: {}, tributario: {} });
  const colores = vm.runInContext(
    '[rfcColorClave200b("' + MFI + '"), rfcColorClave200b("' + IEAF + '"), rfcColorClave200b("' + TERCERO + '")]', context);
  assert.ok(colores.every(Boolean), 'sin color asignado a mano, cada RFC propio TIENE color: ' + colores);
  assert.equal(new Set(colores).size, 3, 'tres RFC, tres colores distintos (nada de atajos binarios)');
  const otra = vm.runInContext('rfcColorClave200b("' + MFI + '")', context);
  assert.equal(otra, colores[0], 'la asignación es estable entre llamadas');
  const ajeno = vm.runInContext('rfcColorClave200b("PROV010101AAA")', context);
  assert.equal(ajeno, '', 'una contraparte no hereda color de la paleta de propios');
  /* La asignación expresa manda sobre la automática. */
  ponerGente(context,
    [{ id: MFI, name: 'Mano Fil, S.A.' }, { id: IEAF, name: 'Francisco' }],
    { profiles: [], settings: { rfcColors: { [MFI]: 'burdeos' } }, puerta: {}, ejecutor: {}, tributario: {} });
  assert.equal(vm.runInContext('rfcColorClave200b("' + MFI + '")', context), 'burdeos',
    'el color asignado a mano gana');
  assert.ok(vm.runInContext('rfcColorClave200b("' + IEAF + '")', context) !== 'burdeos',
    'y el automático del otro no pisa el asignado');
  /* Medallones con fondos distintos y la franja de cabecera. */
  ponerGente(context,
    [{ id: MFI, name: 'Mano Fil, S.A.' }, { id: IEAF, name: 'Francisco Javier Iglesias Arenas' }],
    { profiles: [], settings: {}, puerta: {}, ejecutor: {}, tributario: {} });
  const fondos = vm.runInContext(
    '[medallon200b("' + MFI + '", "Mano Fil, S.A.").style.background,' +
    ' medallon200b("' + IEAF + '", "Francisco").style.background]', context);
  assert.ok(fondos[0] && fondos[1] && fondos[0] !== fondos[1], 'medallones de dos RFC, dos fondos');
  vm.runInContext('scope = "' + MFI + '"; ambitoListo310 = true; pintarBotonScope200b();', context);
  const bandaMfi = vm.runInContext('document.getElementById("rfc-banda310").style.background', context);
  assert.ok(bandaMfi, 'la franja de la cabecera lleva el color del RFC en pantalla');
  vm.runInContext('scope = "' + IEAF + '"; ambitoListo310 = true; pintarBotonScope200b();', context);
  const bandaIeaf = vm.runInContext('document.getElementById("rfc-banda310").style.background', context);
  assert.ok(bandaIeaf && bandaIeaf !== bandaMfi, 'al cambiar de RFC, la franja cambia con él');
  console.log('OK 3.1.0 · (1) identidad por RFC: color automático estable (N), franja y medallones.');
}

/* ===== (2) Arranque: «Cargando…», no «Sin contribuyente» ===== */
{
  const context = await bootCliente();
  vm.runInContext('ambitoListo310 = false; people = []; scope = ""; pintarBotonScope200b();', context);
  const antes = vm.runInContext('[...document.getElementById("scope-menu-btn200b").children].map(c => c.textContent).join(" ")', context);
  assert.match(antes, /Cargando/, 'antes de asentar el contexto: «Cargando…», no un falso «Sin contribuyente»');
  vm.runInContext('ambitoListo310 = true; pintarBotonScope200b();', context);
  const despues = vm.runInContext('[...document.getElementById("scope-menu-btn200b").children].map(c => c.textContent).join(" ")', context);
  assert.match(despues, /Sin contribuyente/, 'con el contexto asentado y sin RFC, sí: «Sin contribuyente»');
  console.log('OK 3.1.0 · (2) arranque sin estados falsos.');
}

/* ===== (3) Avisos: el ámbito manda; aviso ≠ error; resolución ===== */
{
  const context = await bootCliente();
  ponerGente(context,
    [{ id: MFI, name: 'Mano Fil, S.A.' }, { id: IEAF, name: 'Francisco Javier Iglesias Arenas' }],
    { profiles: [], settings: {}, puerta: {}, ejecutor: {}, tributario: {} });
  const avisoMfi = { id: 1, rfc: MFI, clase: 'mal', severidad: 'alta', kind: 'saldo',
    titulo: 'Problema grave de Mano Fil', detalle: 'Detalle MFI', creado: AHORA - 86400000,
    gesto: { de: 'paco', texto: 'Págalo' }, accion: 'Revisa el saldo', responsable: 'Paco' };
  const avisoIeaf = { id: 2, rfc: IEAF, clase: 'falta', severidad: 'baja', kind: 'documento',
    titulo: 'Aviso leve de Francisco', detalle: 'Detalle IEAF', creado: AHORA - 86400000,
    gesto: { de: 'sistema', texto: '' }, accion: '', responsable: 'Paco' };
  context.__avisos = { avisos: [avisoMfi, avisoIeaf], counts: { total: 2 },
    porRfc: { [MFI]: 1, [IEAF]: 1 }, pospuestas: [], archivadas: [], historial: [],
    config: { correo: 'diario', hora: 9 } };
  /* El filtro privado guardado dice MFI; el ámbito dice IEAF:
     manda el ámbito (la pantalla es de «lo tuyo»). */
  vm.runInContext('scope = "' + IEAF + '"; avisosCache = __avisos; avisosFetchedAt = Date.now();' +
    ' avisosRfcFiltro = "' + MFI + '";', context);
  const [wrap] = vm.runInContext('avisosScreen()', context);
  const texto = textoDe(wrap);
  assert.ok(texto.includes('Aviso leve de Francisco'), 'con IEAF en pantalla, Avisos enseña los de IEAF');
  assert.ok(!texto.includes('Problema grave de Mano Fil'), 'y NINGUNO de MFI, aunque el filtro guardado dijera MFI');
  /* Distinción aviso/error y resolución con su dueño. */
  const cardMal = vm.runInContext('avisoCard(__avisos.avisos[0])', context);
  const textoMal = textoDe(cardMal);
  assert.match(textoMal, /Error/, 'un aviso de clase «mal» se presenta como ERROR, no como aviso más');
  assert.match(textoMal, /Tu gesto/, 'y dice que la resolución es de Paco');
  const cardFalta = vm.runInContext('avisoCard(__avisos.avisos[1])', context);
  const textoFalta = textoDe(cardFalta);
  assert.match(textoFalta, /Aviso/, 'un aviso de clase «falta» se presenta como AVISO');
  /* Un aviso del SAT: su resolución no es de Paco. */
  context.__avisoSat = { id: 3, rfc: IEAF, clase: 'mal', severidad: 'alta', kind: 'cancellation',
    titulo: 'Cancelaron una factura', detalle: 'El SAT la canceló', creado: AHORA - 86400000,
    gesto: { de: 'sat', texto: '' }, accion: '', responsable: 'Paco' };
  const cardSat = vm.runInContext('avisoCard(__avisoSat)', context);
  const textoSat = textoDe(cardSat);
  assert.match(textoSat, /SAT/, 'el aviso del SAT nombra al SAT como dueño de la resolución');
  assert.match(textoSat, /se resuelve solo|nada/i, 'y dice que no hay gesto de Paco');
  console.log('OK 3.1.0 · (3) avisos por RFC, aviso/error y resolución con dueño.');
}

/* ===== (4) «Ponerme al día»: nombre, etapa, tiempo y resumen ===== */
{
  const context = await bootCliente();
  ponerGente(context,
    [{ id: MFI, name: 'Mano Fil, S.A.' }, { id: IEAF, name: 'Francisco Javier Iglesias Arenas' }],
    { profiles: [], settings: {}, puerta: {}, ejecutor: {}, tributario: {} });
  /* Sin acceso: veredicto al instante, con su RFC nombrado. */
  rutas310.set('/api/al-dia/state', { configuradoPortal: false, running: false, fase: '',
    frase: '', deQuien: '', gesto: '', progreso: null, fin: null,
    portal: { progress: null, quota: null }, contadorDia: null,
    veredicto: { estado: 'falta-acceso', pendientes: 0,
      frase: 'Falta dar de alta su acceso: sin su e.firma o su contraseña CIEC, PacoSAT no puede pedir nada al SAT en su nombre.' } });
  const card = vm.runInContext('aldia30Card("' + IEAF + '")', context);
  await dormir(60);
  const veredicto = buscarDataset(card, 'aldia30Veredicto', '1')[0];
  assert.ok(veredicto, 'la tarjeta pinta su veredicto');
  assert.equal(veredicto.textContent, 'Falta dar de alta su acceso');
  assert.ok(textoDe(card).includes(IEAF), 'la tarjeta NOMBRA su RFC');
  const go = buscarDataset(card, 'aldia30Go', '1')[0];
  assert.equal(go.textContent, 'Dar de alta el acceso', 'el botón es el camino al alta, no un «Ponerme al día» vacío');
  /* Corriendo: etapa en curso y tiempo transcurrido visibles. */
  rutas310.set('/api/al-dia/state', () => ({ configuradoPortal: true, running: true, fase: 'portal',
    frase: 'Trayendo por el portal las 2 que faltan…', deQuien: '', gesto: '',
    progreso: { van: 1, total: 2 }, fin: null, startedAt: Date.now() - 125000,
    portal: { progress: null, quota: { remaining: 1998, limit: 2000 } },
    contadorDia: { porPortal: 0, pedidas: 0, fallidas: 0 },
    veredicto: { estado: 'en-curso', pendientes: 2 } }));
  const card3 = vm.runInContext('aldia30Card("' + MFI + '")', context);
  await dormir(60);
  const textoRun = textoDe(card3);
  assert.match(textoRun, /Etapa/, 'corriendo, la tarjeta nombra la etapa en curso');
  assert.match(textoRun, /portal/i, 'la etapa es la del portal');
  assert.match(textoRun, /2 min/, 'y el tiempo que lleva la corrida se ve');
  /* Terminada: el resumen final accionable, que sobrevive a la
     recarga porque sale del estado del servidor. */
  rutas310.set('/api/al-dia/state', { configuradoPortal: true, running: false, fase: 'fin',
    frase: 'Traje 1 factura nueva y quedan 1 pedidas al SAT.', deQuien: 'del SAT',
    gesto: 'Nada: lo pedido sigue su curso y entra solo.', progreso: null,
    fin: { at: AHORA, nuevas: 1, yaEstaban: 1, pendientes: 1, conError: 0, motivo: 'completa' },
    portal: { progress: null, quota: { remaining: 1998, limit: 2000 } },
    contadorDia: { porPortal: 1, pedidas: 1, fallidas: 0 },
    veredicto: { estado: 'faltan', pendientes: 1 } });
  const card4 = vm.runInContext('aldia30Card("' + MFI + '")', context);
  await dormir(60);
  const resumen = buscarDataset(card4, 'aldia30Resumen', '1')[0];
  assert.ok(resumen, 'al terminar, la tarjeta enseña el resumen final');
  const textoRes = textoDe(resumen);
  assert.match(textoRes, /1 nuevas?/, 'grupo nuevas con su cuenta');
  assert.match(textoRes, /1 ya estaban/, 'grupo ya estaban con su cuenta');
  assert.match(textoRes, /1 pendientes?/, 'grupo pendientes con su cuenta');
  assert.match(textoRes, /0 con error/, 'grupo con error con su cuenta');
  assert.ok(buscarDataset(resumen, 'aldia30Ir', 'facturas').length +
            buscarDataset(resumen, 'aldia30Ir', 'registro').length >= 2,
    'los grupos tienen acceso directo a su lista (Facturas o Registro)');
  console.log('OK 3.1.0 · (4) tarjeta al día: RFC, etapa, tiempo y resumen accionable.');
}

/* ===== (5) Listas: el resumen por RFC de verdad ===== */
{
  const context = await bootCliente();
  const data = { sources: [{ id: '69b', label: '69-B', fetched: AHORA }],
    counterparts: [
      { rfc: 'PROV00000001', hits: [{}], propios: [MFI] },
      { rfc: 'PROV00000002', hits: [{}], propios: [IEAF] },
      { rfc: 'PROV00000003', hits: [{}], propios: [MFI, IEAF] },
      { rfc: 'PROV00000004', hits: [], propios: [MFI] }] };
  context.__lists = data;
  const conteos = vm.runInContext(
    '[listsResumen201(__lists).senaladas.length,' +
    ' listsResumen201(__lists, "' + MFI + '").senaladas.length,' +
    ' listsResumen201(__lists, "' + IEAF + '").senaladas.length,' +
    ' listsResumen201(__lists, "' + TERCERO + '").senaladas.length]', context);
  assert.equal(JSON.stringify(conteos), '[3,2,2,0]',
    'cada RFC cuenta SOLO sus señaladas (la compartida cuenta en ambos; el tercero, ninguna)');
  console.log('OK 3.1.0 · (5) listas negras contadas por RFC (propios), sin restas.');
}

/* ===== (6) Hoy: propuestas y «Esto pasó» sin mezcla ===== */
{
  const context = await bootCliente();
  ponerGente(context,
    [{ id: MFI, name: 'Mano Fil, S.A.' }, { id: IEAF, name: 'Francisco Javier Iglesias Arenas' }],
    { profiles: [{ rfc: MFI }], settings: {}, puerta: {}, ejecutor: {}, tributario: {},
      metadata: { records: 3, missing: [
        { uuid: 'U1', emitter: 'AAA010101AAA', receiver: MFI },
        { uuid: 'U2', emitter: 'AAA010101AAA', receiver: MFI },
        { uuid: 'U3', emitter: 'AAA010101AAA', receiver: IEAF }] } });
  const conteos = vm.runInContext(
    '[hoyPropuestasPendientes297("' + MFI + '"), hoyPropuestasPendientes297("' + IEAF + '")]', context);
  assert.equal(JSON.stringify(conteos), '[2,1]', 'las propuestas cuentan las del RFC que se lanza, no las del ámbito a medias');
  rutas310.set('/api/cambios', { desde: 0, lineas: [], total: 0 });
  vm.runInContext('scope = "' + IEAF + '"; activity = [{ name: "SAT · ' + MFI + '", ' +
    'event: "Se guardaron 2 facturas de Mano Fil", date: new Date().toISOString(), added: 2, duplicates: 0, review: 0 }];', context);
  const panel = vm.runInContext('hoyProactivo297Panel()', context);
  await dormir(60);
  const paso = buscarDataset(panel, 'hoy297Bloque', 'paso')[0];
  assert.ok(paso, 'el bloque «Esto pasó» existe');
  assert.ok(!textoDe(paso).includes(MFI), '«Esto pasó» de IEAF no pinta actividad de MFI');
  const propongo = buscarDataset(panel, 'hoy297Bloque', 'propongo')[0];
  const textoProp = textoDe(propongo);
  assert.ok(textoProp.includes('Bajar ahora las 1'), 'la propuesta cuenta las de IEAF (1), no el total (3)');
  assert.ok(textoProp.includes(IEAF), 'y la propuesta nombra su RFC');
  console.log('OK 3.1.0 · (6) Hoy: propuestas y actividad acotadas al RFC.');
}

/* ===== (7) Cobertura y mensual: cabecera y huecos por RFC ===== */
{
  const context = await bootCliente();
  ponerGente(context,
    [{ id: MFI, name: 'Mano Fil, S.A.' }, { id: IEAF, name: 'Francisco Javier Iglesias Arenas' }],
    { profiles: [], settings: {}, puerta: {}, ejecutor: {}, tributario: {},
      coverage: { groups: [], gaps: [], days: {}, records: [] },
      metadata: { records: 48, lastSeen: AHORA, missing: [],
        porRfc: { [MFI]: { records: 47, lastSeen: AHORA }, [IEAF]: { records: 1, lastSeen: AHORA } } } });
  vm.runInContext('scope = "' + IEAF + '";', context);
  const paneles = vm.runInContext('coberturaPaneles280(true)', context);
  const todo = paneles.map(textoDe).join(' ');
  assert.ok(todo.includes('1 registros de metadatos guardados'),
    'la cabecera de metadatos enseña los del RFC en pantalla (1), no el total (48)');
  assert.ok(!todo.includes('48 registros'), 'el total global no se disfraza de suyo');
  rutas310.set('/api/monthly', { config: { enabled: true, day: 5, hour: 9 }, runs: [],
    gaps: [{ rfc: MFI, direction: 'received', month: '2026-08' },
           { rfc: IEAF, direction: 'received', month: '2026-09' }],
    currentMonth: '2026-11', targetMonth: '2026-10' });
  const mensual = vm.runInContext('monthlyPanel()', context);
  await dormir(60);
  const textoMes = textoDe(mensual);
  assert.ok(textoMes.includes('septiembre'), 'los huecos viejos enseñan los de IEAF (septiembre)');
  assert.ok(!textoMes.includes('agosto'), 'y no los de MFI (agosto)');
  console.log('OK 3.1.0 · (7) cobertura y huecos mensuales por RFC.');
}

/* ===== (8) El alta con las dos formas EN EL MISMO PASO ===== */
{
  const context = await bootCliente();
  ponerGente(context,
    [{ id: MFI, name: 'Mano Fil, S.A.' }, { id: IEAF, name: 'Francisco Javier Iglesias Arenas' }],
    { profiles: [], settings: {}, puerta: {}, ejecutor: {}, tributario: {} });
  await vm.runInContext('altaRfcDialog2912("' + IEAF + '")', context);
  await dormir(30);
  const titulo = vm.runInContext('document.getElementById("dialogTitle").textContent', context);
  assert.match(titulo, /Dar de alta/, 'el diálogo es el del alta');
  const campos = vm.runInContext('document.getElementById("fields")', context);
  const texto = textoDe(campos);
  assert.ok(texto.includes('Certificado .cer'), 'la forma e.firma vive en ESTE diálogo');
  assert.ok(texto.includes('Contraseña CIEC'), 'y la forma CIEC vive en EL MISMO diálogo (mismo paso)');
  assert.ok(buscarDataset(campos, 'alta310Metodo', 'efirma').length, 'selector de forma: e.firma');
  assert.ok(buscarDataset(campos, 'alta310Metodo', 'ciec').length, 'selector de forma: CIEC');
  console.log('OK 3.1.0 · (8) alta en un paso: e.firma o CIEC sin cambiar de ventana.');
}

/* ===== (9) El botón muerto: la acción CIEC abre el diálogo ===== */
{
  const satUi = read('sat-ui.part');
  const ini = satUi.indexOf('const acciones = {');
  const bloque = satUi.slice(ini, ini + 2600);
  const ciec = bloque.slice(bloque.indexOf('ciec:'), bloque.indexOf('emparejar:'));
  assert.match(ciec, /ciecDialog\(rfc\)/, 'la acción «ciec» ABRE ciecDialog del RFC de la tarjeta');
  assert.ok(!/#ciec-live/.test(ciec), 'y ya no hace scroll a un panel que puede no existir');
  const context = await bootCliente();
  ponerGente(context,
    [{ id: MFI, name: 'Mano Fil, S.A.' }, { id: IEAF, name: 'Francisco Javier Iglesias Arenas' }],
    { profiles: [], settings: {}, puerta: {}, ejecutor: {}, tributario: {} });
  /* Para un RFC SIN perfil ni método, el diálogo abre igual. */
  vm.runInContext('ciecDialog("' + IEAF + '")', context);
  const titulo = vm.runInContext('document.getElementById("dialogTitle").textContent', context);
  assert.match(titulo, /CIEC/, 'ciecDialog abre para el RFC sin perfil');
  const campos = vm.runInContext('document.getElementById("fields")', context);
  assert.ok(textoDe(campos).includes('Contraseña CIEC del SAT'), 'con su campo de contraseña');
  console.log('OK 3.1.0 · (9) botón «activar contraseña»: abre el diálogo, también sin perfil.');
}

/* ===== (10) Trabajos en curso: cada uno con su RFC ===== */
{
  const context = await bootCliente();
  ponerGente(context,
    [{ id: MFI, name: 'Mano Fil, S.A.' }, { id: IEAF, name: 'Francisco Javier Iglesias Arenas' }],
    { profiles: [], settings: {}, puerta: {}, ejecutor: {}, tributario: {} });
  const box = vm.runInContext('(() => { const b = n("div"); pintarHoyVivo240({ running: [' +
    '{ kind: "documentos", key: "documentos:' + MFI + '", label: "Descarga de documento del SAT", ' +
    'rfc: "' + MFI + '", detail: "Descargando…", state: "curso", since: Date.now() }' +
    '], paused: [] }, b); return b; })()', context);
  assert.ok(textoDe(box).includes(MFI),
    'un trabajo cuyo rótulo no nombra su RFC lo enseña como etiqueta visible');
  const box2 = vm.runInContext('(() => { const b = n("div"); const mk = (rfc, i) => ({ kind: "masiva",' +
    ' key: "masiva:" + i, jobId: i, rfc, label: "Solicitud de descarga en el SAT · " + rfc,' +
    ' detail: "esperando al SAT", phase: "Esperando al SAT", state: "esperando", since: Date.now() });' +
    ' pintarHoyVivo240({ running: [mk("' + MFI + '", 1), mk("' + MFI + '", 2), mk("' + MFI + '", 3),' +
    ' mk("' + IEAF + '", 4)], paused: [] }, b); return b; })()', context);
  const resumen = textoDe(box2);
  assert.match(resumen, /4 trabajos en curso/, 'el resumen cuenta los trabajos');
  assert.ok(resumen.includes(MFI) && resumen.includes(IEAF),
    'y el resumen desglosa por RFC: ninguno se presenta como del otro');
  console.log('OK 3.1.0 · (10) trabajos etiquetados con su RFC.');
}

/* ===== (11) Cabeceras con nombre propio: RFC + periodo + frescura ===== */
{
  const context = await bootCliente();
  const tira = vm.runInContext('cabeceraAlcance310("' + IEAF + '", "noviembre de 2026")', context);
  const texto = textoDe(tira);
  assert.ok(texto.includes(IEAF), 'la tira nombra el RFC');
  assert.ok(texto.includes('noviembre de 2026'), 'y el periodo que enseña');
  assert.match(texto, /Datos de las/, 'junto al sello de frescura');
  const ui = read('ui.part'), cov = read('coverage-ui.part'), salud = read('salud-ui.part');
  assert.ok(ui.includes('cabeceraAlcance310('), 'Resumen (Hoy) abre con su tira de alcance');
  assert.ok(cov.includes('cabeceraAlcance310('), 'Cobertura abre con su tira de alcance');
  assert.ok(salud.includes('cabeceraAlcance310('), 'Salud abre con su tira de alcance');
  console.log('OK 3.1.0 · (11) cabeceras con RFC, periodo y frescura.');
}


/* ===== (12) Administración: triage que agrega y nunca revuelve ===== */
{
  const context = await bootCliente();
  ponerGente(context,
    [{ id: MFI, name: 'Mano Fil, S.A.' }, { id: IEAF, name: 'Francisco Javier Iglesias Arenas' },
     { id: TERCERO, name: 'Tercero SA' }],
    { profiles: [{ rfc: MFI, efirmaStored: true, certExpires: AHORA + 20 * 86400000 },
        { rfc: IEAF, ciecStored: true }, { rfc: TERCERO, efirmaStored: true }],
      settings: {}, puerta: { [MFI]: { ok: false, errorKind: 'portal-caido', probada: AHORA } },
      ejecutor: {}, tributario: {},
      coverage: { groups: [], gaps: [{ rfc: MFI, direction: 'received' }], days: {}, records: [] },
      metadata: { records: 0, missing: [] } });
  context.__avisosAdmin = { avisos: [
      { id: 11, rfc: MFI, clase: 'mal', severidad: 'alta', kind: 'saldo', titulo: 'Problema grave de Mano Fil',
        detalle: '', creado: AHORA - 86400000, gesto: { de: 'paco', texto: 'Págalo' }, accion: '', responsable: 'Paco' },
      { id: 12, rfc: IEAF, clase: 'falta', severidad: 'baja', kind: 'documento', titulo: 'Aviso leve de Francisco',
        detalle: '', creado: AHORA - 86400000, gesto: { de: 'sistema', texto: '' }, accion: '', responsable: 'Paco' }],
    counts: { total: 2 }, porRfc: { [MFI]: 1, [IEAF]: 1 }, pospuestas: [], archivadas: [], historial: [],
    config: { correo: 'diario', hora: 9 } };
  rutas310.set('/api/notices', url => context.__avisosAdmin);
  rutas310.set('/api/lists', { sources: [{ id: '69b', label: '69-B', fetched: AHORA }],
    counterparts: [{ rfc: 'PROV00000009', hits: [{}], propios: [IEAF] }] });
  rutas310.set('/api/activity', { running: [], paused: [], recent: [], nextAuto: null });
  vm.runInContext('avisosCache = __avisosAdmin; avisosFetchedAt = Date.now();', context);
  await vm.runInContext('ensureLazyPart("admin")', context);
  const [pantalla] = await vm.runInContext('administracionScreen310()', context);
  await dormir(120);
  const texto = textoDe(pantalla);
  assert.match(texto, /2 RFC necesitan algo/, 'la protagonista cuenta RFC con problemas (2), no cifras mezcladas');
  assert.match(texto, /1 urgente/, 'y dice cuántos urgentes hay (el rojo de MFI)');
  assert.match(texto, /Revisado a las/, 'la consola lleva su sello de frescura');
  /* La franja de urgentes: SOLO el rojo, con su RFC. */
  const franja = buscarDataset(pantalla, 'adminUrgentes310', '1')[0];
  assert.ok(franja, 'la franja «Urgentes» existe');
  assert.ok(textoDe(franja).includes('Problema grave de Mano Fil'), 'el rojo de MFI se ve primero, sin abrir bloques');
  assert.ok(!textoDe(franja).includes('Aviso leve de Francisco'), 'y nada que no sea rojo entra en la franja');
  /* Los bloques: el resto de cada RFC, sin contagio. */
  const bloqueMfi = buscarDataset(pantalla, 'adminBloque310', MFI)[0];
  const bloqueIeaf = buscarDataset(pantalla, 'adminBloque310', IEAF)[0];
  assert.ok(bloqueMfi && bloqueIeaf, 'cada RFC con problemas tiene su bloque');
  const tMfi = textoDe(bloqueMfi), tIeaf = textoDe(bloqueIeaf);
  assert.ok(!tMfi.includes('Problema grave de Mano Fil'), 'el rojo NO se repite en el bloque: vive en la franja');
  assert.match(tMfi, /e\.firma/, 'MFI: su e.firma por caducar está en SU bloque');
  assert.match(tMfi, /hueco/i, 'MFI: su hueco de cobertura está en SU bloque');
  assert.ok(tIeaf.includes('Aviso leve de Francisco'), 'el bloque de IEAF trae SU aviso');
  assert.ok(!tIeaf.includes('Problema grave de Mano Fil'), 'y no el de MFI');
  assert.match(tIeaf, /Listas negras/, 'IEAF: su hallazgo de listas está en SU bloque');
  const bloqueSistema = buscarDataset(pantalla, 'adminBloque310', 'sistema')[0];
  assert.ok(bloqueSistema && /portal del SAT/i.test(textoDe(bloqueSistema)),
    'lo que no es de ningún RFC (portal caído) vive en el bloque «Del sistema»');
  /* Los limpios: UNA línea desplegable, no un renglón por RFC. */
  const limpios = buscarDataset(pantalla, 'adminLimpios310', '1')[0];
  assert.ok(limpios && /1 RFC sin problemas/.test(textoDe(limpios)),
    'los RFC sin problemas se resumen en una sola línea desplegable');
  assert.ok(textoDe(limpios).includes('Tercero SA'), 'y dentro va el nombre del RFC limpio');
  assert.ok(!textoDe(limpios).includes('Problema') && !textoDe(limpios).includes('Aviso leve'),
    'el limpio no hereda ni un aviso ajeno');
  /* La insignia del menú: el conteo del alcance (6 problemas:
     3 de MFI, 2 de IEAF, 1 del sistema), en rojo por el urgente. */
  const badge = vm.runInContext('document.getElementById("admin-badge310")', context);
  assert.equal(badge.hidden, false, 'la insignia de Administración se ve');
  assert.equal(badge.textContent, '6', 'y enseña el conteo de problemas del alcance');
  assert.equal(badge.dataset.urgente, '1', 'en rojo: hay urgentes');
  /* Tocar un problema: cambia el contexto y abre donde se resuelve. */
  vm.runInContext('__nav310 = ""; navigate = v => { __nav310 = v; };', context);
  vm.runInContext('adminIr310("' + IEAF + '", "avisos")', context);
  const destino = vm.runInContext('[scope, __nav310]', context);
  assert.equal(JSON.stringify(destino), JSON.stringify([IEAF, 'avisos']), 'tocar lleva al RFC del problema y a su pantalla');
  console.log('OK 3.1.0 · (12) Administración: urgentes primero, bloques por RFC, limpios en una línea.');
}

/* ===== (12b) Administración: el alta sin credenciales ===== */
{
  const context = await bootCliente();
  ponerGente(context,
    [{ id: IEAF, name: 'Francisco Javier Iglesias Arenas' }],
    { profiles: [{ rfc: IEAF, pending: true, efirmaStored: false, ciecStored: false }],
      settings: {}, puerta: {}, ejecutor: {}, tributario: {},
      coverage: { groups: [], gaps: [], days: {}, records: [] },
      metadata: { records: 0, missing: [] } });
  rutas310.set('/api/notices', { avisos: [], counts: { total: 0 }, porRfc: {}, pospuestas: [],
    archivadas: [], historial: [], config: { correo: 'diario', hora: 9 } });
  rutas310.set('/api/lists', { sources: [], counterparts: [] });
  rutas310.set('/api/activity', { running: [], paused: [], recent: [], nextAuto: null });
  await vm.runInContext('ensureLazyPart("admin")', context);
  const [pantalla] = await vm.runInContext('administracionScreen310()', context);
  await dormir(120);
  const bloque = buscarDataset(pantalla, 'adminBloque310', IEAF)[0];
  assert.ok(bloque && /sin credenciales/i.test(textoDe(bloque)),
    'el contribuyente dado de alta sin credenciales aparece como problema de SU RFC (el caso real de hoy)');
  console.log('OK 3.1.0 · (12b) Administración: sin credenciales, nombrado.');
}
console.log('OK 3.1.0 · cliente completo.');
