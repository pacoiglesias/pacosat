/* ================================================================
   Ronda 2.4.0 · WC4a — Salud rediseñada + Ajustes que pintan los
   ajustes nuevos de la versión.
   (a) Salud abre con la tarjeta de VEREDICTO (protagonista)
       antes que las piezas, compuesta de las tarjetas servidas:
       con una pieza «mal», el veredicto la nombra con su porqué
       y su botón lleva a su tarjeta; sin malas ni a vigilar,
       «Todo bien».
   (b) La BITÁCORA vive en la primera pantalla de Salud con
       «Exportar bitácora (CSV)» FUERA de cualquier <details> o
       panel plegado, exporta el CSV de siempre y la tarjeta dice
       el camino: «El registro completo está en Registro, que
       exporta su propio CSV», con su botón que navega a Registro.
   (c) PARIDAD: los textos y acciones que Salud ya tenía siguen
       presentes (puerta, ejecutor, respaldo y su ensayo,
       coherencia, listas, revisión programada, autorreparación,
       deshacer, duplicados, enlaces y la pestaña Configurar).
   (d) Ajustes pinta «Lo que PacoSAT hace solo» con los valores
       SERVIDOS de status.settings (modo histórico, Constancia y
       Opinión automáticas, resumen semanal — con su propia llave
       servida — y la tolerancia en PESOS) y guarda cada cambio
       con el POST /api/settings exacto; ninguna clave interna
       se ve en pantalla.
   Arnés DOM: el de la casa (ronda232cliente), artefacto real.
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
const RFC = 'AAA010101AAA';

/* ===== Arnés DOM (el de ronda232cliente) ===== */
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
  get isConnected() { return true; }
  get lastChild() { return this.children[this.children.length - 1] || null; }
  get firstChild() { return this.children[0] || null; }
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
    navigator: { onLine: true, userAgent: 'ronda240salud-test' },
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
const buscar = (el, pred, out = []) => { if (el && pred(el)) out.push(el); for (const h of el?.children || []) buscar(h, pred, out); return out; };
const buscarEn = (raices, pred) => raices.flatMap(r => buscar(r, pred));
const ticks = async (n = 10) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)); };
async function bootCliente() {
  const context = makeBootContext();
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  vm.runInContext(script, context, { filename: 'Faro-Fiscal.html#script' });
  await ticks(12);
  vm.runInContext(read('salud-ui.part'), context, { filename: 'salud-ui.part' });
  return context;
}

/* ===== Datos de juguete de /api/salud ===== */
const tarjetaBase = (id, titulo, estado, porque, datos = {}) => ({
  id, titulo, estado, porque, queEs: 'Qué es ' + titulo + '.', frescuraTexto: 'visto ahora', datos });
function saludJuguete(estadoAtascados = 'mal') {
  return {
    tarjetas: [
      tarjetaBase('puerta:' + RFC, 'Puerta del SAT · ' + RFC, 'bien', 'La puerta abre.', { rfc: RFC, tipo: 'equipo' }),
      tarjetaBase('ejecutor', 'Tu ejecutor', 'vigilar', 'Tu equipo no responde desde ayer.',
        { versionReportada: '2.3.2', bundleVersion: '2.3.2', huellaOk: true, dormido: { activo: false, ajusteSiempre: false } }),
      tarjetaBase('atascados', 'Trabajos atascados', estadoAtascados,
        estadoAtascados === 'mal' ? '1 trabajo(s) atascado(s): Descarga de ' + RFC + '.' : 'Ningún trabajo lleva más de una hora atascado.',
        { atascados: estadoAtascados === 'mal'
            ? [{ id: 'j1', nombre: 'Descarga', rfc: RFC, motivo: 'sin avanzar', desde: Date.now() - 7200000 }] : [],
          fallidos: [] }),
      tarjetaBase('correo', 'Correo saliente', 'bien', 'Configurado y su última prueba salió bien.',
        { configurado: true, destinatario: 'paco@example.com' }),
      tarjetaBase('respaldo', 'Respaldo y su ensayo', 'bien', 'Último respaldo bueno.', { ensayo: null }),
      tarjetaBase('coherencia', 'Coherencia interna', 'bien', 'Todo cuadra.', { desacuerdos: [] })
    ],
    ejecutor: { enCola: 0 }, auto201: null, humo: null, config: []
  };
}
function instalarSatApi(ctx, salud) {
  ctx.__salud = salud;
  ctx.__stubSat = async route => {
    const r = String(route);
    if (r === 'salud') return ctx.__salud;
    if (r === 'deshacer201') return { acciones: [] };
    if (r.startsWith('duplicados201')) return { sospechosos: [] };
    if (r === 'lists') return {};
    if (r === 'revision') return { resumen: 'Revisión apagada.', proxima: null, proximaTexto: '',
      config: { enabled: false, dias: [], hora: 8 }, porRfc: [] };
    return {};
  };
  vm.runInContext('satApi = __stubSat; render = () => {};', ctx);
}

/* ===== (a)+(b)+(c) · Salud con una pieza mal ===== */
{
  const ctx = await bootCliente();
  instalarSatApi(ctx, saludJuguete('mal'));
  ctx.__nav = [];
  ctx.__navFn = vista => { ctx.__nav.push(vista); };
  ctx.__descargas = [];
  ctx.__dlFn = (nombre, datos, tipo) => { ctx.__descargas.push({ nombre, tipo, texto: new TextDecoder().decode(datos) }); return Promise.resolve(); };
  vm.runInContext('navigate = __navFn; download = __dlFn;' +
    'satData.ejecutor = { residencia: { registrada: true, instancias: 1 } };' +
    'activity = [{ date: new Date().toISOString(), name: "SAT · Descarga de prueba", event: "" }];' +
    'page = "salud";', ctx);
  const blocks = vm.runInContext('saludScreen200d()', ctx);
  await ticks();
  const texto = blocks.map(textoDe).join('\n');

  /* (a) El veredicto, primero y protagonista. */
  const iVeredicto = texto.indexOf('Veredicto de salud');
  const iPrimeraPieza = texto.indexOf('Puerta del SAT · ' + RFC);
  assert.ok(iVeredicto >= 0, 'Salud pinta la tarjeta «Veredicto de salud»');
  assert.ok(iPrimeraPieza > iVeredicto, 'el veredicto va ANTES que las piezas');
  assert.ok(texto.includes('Una pieza está mal'), 'el veredicto dice que una pieza está mal');
  assert.ok(texto.includes('Trabajos atascados — 1 trabajo(s) atascado(s)'),
    'el veredicto nombra la pieza mala con su porqué');
  const veredicto = buscarEn(blocks, e => e.dataset && e.dataset.veredicto240 === '1')[0];
  assert.ok(veredicto, 'la tarjeta de veredicto lleva su marca');
  const pillVeredicto = buscar(veredicto, e => String(e.className || '').includes('status-pill'))[0];
  assert.equal(pillVeredicto?.dataset.state, 'bad', 'el veredicto lleva semáforo «bad» con su palabra');
  const btnArreglo = buscar(veredicto, e => e.tagName === 'BUTTON' && (e.textContent || '').trim() === 'Ver su arreglo')[0];
  assert.ok(btnArreglo, 'el veredicto ofrece el arreglo en un toque');
  btnArreglo.onclick();

  /* (b) La bitácora, visible y fuera de todo pliegue.
     RE-BASE 2.8.0 (diseño 10): la tarjeta ya NO exporta — la
     exportación vive solo en Registro —; enseña la cuenta,
     dice dónde vive la exportación y enlaza. */
  const iBitacora = texto.indexOf('La bitácora completa y su exportación están en Registro');
  assert.ok(iBitacora > iVeredicto && iBitacora < iPrimeraPieza,
    'la tarjeta de bitácora vive en la primera pantalla, tras el veredicto y antes de las piezas');
  const btnExportar = buscarEn(blocks, e => e.tagName === 'BUTTON' && (e.textContent || '').trim() === 'Exportar bitácora (CSV)')[0];
  assert.ok(!btnExportar, 'Salud ya NO pinta ningún «Exportar bitácora (CSV)» (diseño 10: la exportación vive en Registro)');
  const tarjetaBitacora = buscarEn(blocks, e => e.dataset && e.dataset.bitacora240 === '1')[0];
  assert.ok(tarjetaBitacora, 'la tarjeta de bitácora de Salud existe con su cuenta');
  const btnRegistro = buscarEn(blocks, e => e.tagName === 'BUTTON' && (e.textContent || '').trim() === 'Ir a Registro')[0];
  assert.ok(btnRegistro, 'el botón a Registro está pintado');
  btnRegistro.onclick();
  await ticks(3);
  assert.equal(ctx.__nav.join(','), 'registro', 'el botón navega a Registro');

  /* (c) Paridad: nada de lo que Salud tenía desaparece. */
  for (const frase of ['Re-probar la puerta', 'Ver tu ejecutor', 'Regenerar el código de emparejado',
    'Abrir el panel del ejecutor', 'Aviso de dormido', 'Re-encolar', 'Enviar correo de prueba',
    'Probar la restauración ahora', 'Ir a Respaldos', 'Revisar ahora', 'Autorreparación semanal',
    'Deshacer', 'Duplicados sospechosos', 'Listas 69-B', 'Ver las Listas',
    'Revisión programada de facturas nuevas', 'Todas las demás pantallas', 'Configurar'])
    assert.ok(texto.includes(frase), 'paridad de Salud: sigue presente «' + frase + '»');
  console.log('OK 2.4.0·WC4a Salud — veredicto protagonista primero (mal con porqué y arreglo), bitácora visible fuera de pliegues con su CSV y su camino a Registro, paridad completa.');
}

/* ===== (a2) · Salud sin nada mal: «Todo bien» ===== */
{
  const ctx = await bootCliente();
  instalarSatApi(ctx, saludJuguete('bien'));
  vm.runInContext('satData.ejecutor = { residencia: { registrada: true, instancias: 1 } }; page = "salud";', ctx);
  /* El ejecutor de juguete está «vigilar»: se deja también en bien
     para el veredicto limpio. */
  ctx.__salud.tarjetas.find(t => t.id === 'ejecutor').estado = 'bien';
  const blocks = vm.runInContext('saludScreen200d()', ctx);
  await ticks();
  const texto = blocks.map(textoDe).join('\n');
  const veredicto = buscarEn(blocks, e => e.dataset && e.dataset.veredicto240 === '1')[0];
  const pill = buscar(veredicto, e => String(e.className || '').includes('status-pill'))[0];
  assert.equal(pill?.dataset.state, 'ok', 'sin malas ni a vigilar, el semáforo del veredicto es «ok»');
  assert.ok(texto.includes('Todo bien'), 'el veredicto dice «Todo bien»');
  console.log('OK 2.4.0·WC4a Salud — veredicto «Todo bien» cuando ninguna pieza está mal ni a vigilar.');
}

/* ===== (d) · Ajustes pinta y guarda los ajustes nuevos ===== */
{
  const ctx = await bootCliente();
  ctx.__posts = [];
  ctx.__stubSettings = async (route, payload) => {
    if (route === 'settings') { ctx.__posts.push(payload); return { settings: {} }; }
    if (route === 'paperless') return { enabled: false, tokenSet: false, cola: {} };
    return {};
  };
  vm.runInContext('satApi = __stubSettings;' +
    'satData = { profiles: [], jobs: [], inbox: [], mail: {}, buildModified: null, serverStartedAt: null,' +
    ' settings: { historico240: { enabled: true }, satdocsProgramadas240: { enabled: false },' +
    ' resumenSemanal240: { enabled: true }, toleranciaComisionCentavos240: 550 } };', ctx);
  const panels = vm.runInContext('settingsScreen()', ctx);
  await ticks();
  const panelAuto = panels.find(p => textoDe(p).includes('Lo que PacoSAT hace solo'));
  assert.ok(panelAuto, 'Ajustes pinta el panel «Lo que PacoSAT hace solo»');
  const texto = textoDe(panelAuto);
  for (const frase of ['Modo histórico de huecos', 'una solicitud por hora, solo si faltan meses por descargar',
    'Constancia y Opinión automáticas', 'Se bajan solas cada mes; solo avisa si cambia el sentido o la fecha',
    'Resumen semanal por correo', 'Tolerancia de comisión al conciliar (pesos)',
    'una diferencia hasta esta cantidad se propone como comisión bancaria'])
    assert.ok(texto.includes(frase), 'el panel pinta en llano: «' + frase + '»');
  for (const clave of ['historico240', 'satdocsProgramadas240', 'resumenSemanal240', 'toleranciaComisionCentavos240'])
    assert.ok(!texto.includes(clave), 'ninguna clave interna se ve en pantalla: ' + clave);
  const control = clave => buscar(panelAuto, e => e.dataset && e.dataset.ajuste240 === clave)[0];
  assert.equal(control('historico').checked, true, 'el modo histórico se pinta con el valor servido (encendido)');
  assert.equal(control('satdocs').checked, false, 'Constancia y Opinión se pintan con el valor servido (apagado)');
  assert.equal(control('semanal').checked, true, 'el resumen semanal se pinta con el valor servido (encendido)');
  assert.equal(control('tolerancia').value, '5.5', 'la tolerancia servida (550 centavos) se pinta en pesos: 5.5');

  control('historico').checked = false;
  await control('historico').onchange();
  assert.equal(JSON.stringify(ctx.__posts.at(-1)), JSON.stringify({ historico240: { enabled: false } }),
    'apagar el histórico guarda con el POST exacto');
  control('satdocs').checked = true;
  await control('satdocs').onchange();
  assert.equal(JSON.stringify(ctx.__posts.at(-1)), JSON.stringify({ satdocsProgramadas240: { enabled: true } }),
    'encender Constancia y Opinión guarda con el POST exacto');
  control('semanal').checked = false;
  await control('semanal').onchange();
  assert.equal(JSON.stringify(ctx.__posts.at(-1)), JSON.stringify({ resumenSemanal240: { enabled: false } }),
    'apagar el resumen semanal guarda con el POST exacto');
  control('tolerancia').value = '7.25';
  await control('tolerancia').onchange();
  assert.equal(JSON.stringify(ctx.__posts.at(-1)), JSON.stringify({ toleranciaComisionCentavos240: 725 }),
    'la tolerancia se guarda en centavos (7.25 pesos → 725)');
  control('tolerancia').value = '0';
  await control('tolerancia').onchange();
  assert.equal(JSON.stringify(ctx.__posts.at(-1)), JSON.stringify({ toleranciaComisionCentavos240: 0 }),
    'con 0 la tolerancia queda apagada');
  assert.ok(textoDe(panelAuto).includes('Guardado:'), 'cada guardado deja su confirmación discreta en el panel');
  console.log('OK 2.4.0·WC4a Ajustes — los cuatro ajustes se pintan con los valores servidos y se guardan al cambiarlos con el POST exacto.');
}
