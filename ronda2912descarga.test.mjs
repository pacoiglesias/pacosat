import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { webcrypto } from 'node:crypto';
import * as vm from 'node:vm';

/* ================================================================
   Ronda 2.9.12 · CLIENTE — Pieza 2 (Descargar simple), Pieza 3
   (CIEC con captcha manual dentro de la tarjeta) y Precisión 1
   (el aviso de la puerta NO va en la descarga masiva).

   LA VARA (Paco, 18 nov 2026, con su captura de OneFacture:
   «simple, fácil, limpio»): la pantalla «Descargar CFDI» abre
   con UNA tarjeta protagonista — el RFC ya elegido (el del
   selector global), dos fechas tecleables, un control claro
   Emitidos/Recibidos y UN botón «Descargar» —; al descargar,
   progreso VIVO por pasos con su palabra («Consultando al
   SAT» → «Descargando» → «Guardando»), los tres contadores
   (encontrados · descargados · guardados) y el tiempo
   corriendo; si el SAT tarda, la tarjeta lo dice en llano con
   su Cancelar visible; al terminar, una línea llana y el
   acceso a ver lo bajado en Facturas. Nada técnico en la
   vista principal (ni «metadata», ni «criterio», ni códigos).

   PIEZA 3: si el RFC elegido no tiene e.firma pero sí acceso
   CIEC, la MISMA tarjeta ofrece la vía CIEC: el sistema abre
   la sesión del portal y enseña el captcha DENTRO de la
   tarjeta para teclearlo en el momento (jamás se guarda,
   jamás lo resuelve la máquina), y al validarse sigue la
   misma descarga simple con los mismos pasos y contadores —
   reutilizando la maquinaria CIEC que ya existe (satApi
   ciec/run, ciec/captcha, ciec). Si el RFC no tiene ningún
   acceso, la tarjeta dice en llano el único gesto que falta
   y no lanza nada. La e.firma sigue siendo la vía por
   defecto cuando existe.

   PRECISIÓN 1: la descarga masiva NO usa la puerta del
   portal (va por el servicio web): la confirmación de la
   hoja de descarga ya NO enseña el aviso de la puerta. El
   despacho del portal (confirmarDespacho201, el de Buzón y
   Declaraciones) SÍ sigue enseñando el estado veraz de la
   puerta: ahí la ruta del portal se usa de verdad.

   PARIDAD (inventario contra 2.9.11, bloque P): la guía con
   sus tres acciones (Dar de alta un RFC / Configurar RFC /
   Solicitar un periodo), el modo descanso general, la cola
   «Solicitudes recientes» con sus líneas de rescate del
   portal, la «Revisión automática por RFC», el «Historial de
   peticiones al SAT» y los paneles de cobertura («Qué meses
   tienes») siguen en la pantalla, tras la tarjeta. La hoja
   downloadSheet conserva su aviso de «ya se pidió» y su
   variante de 1 segundo; la tarjeta usa el mismo plan, la
   misma guardia (guardChoice) y el mismo criterio de envío.

   Contra la 2.9.11 esta suite corre en ROJO: no existe la
   tarjeta (dataset dl2912), la confirmación de la hoja
   enseña el aviso de la puerta, y la vía CIEC no vive en la
   tarjeta protagonista.
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
async function pintarDescargas2912(b, { scopeRfc, perfiles, extra = '' }) {
  vm.runInContext(
    'scope = ' + JSON.stringify(scopeRfc) + ';' +
    'people = [' + [OWN, CIE, SIN, FIR].map(r => '{ id: "' + r + '", name: "Empresa ' + r + '" }').join(',') + '];' +
    'invoices = []; documents = []; activity = [];' +
    'satData = { profiles: ' + JSON.stringify(perfiles) + ', jobs: [], criteriaBook: [], mail: {},' +
    ' puerta: {}, ejecutor: {}, metadata: { records: 0, missing: [], lastSeen: null },' +
    ' coverage: { groups: [], gaps: [], days: {}, records: [] } };' + extra, b.context);
  await vm.runInContext("ensureLazyPart('descargas')", b.context);
  /* El knob de sondeo vive en la parte perezosa: se siembra
     DESPUÉS de cargarla (una `let` de la parte manda sobre la
     propiedad global si se asigna antes). */
  vm.runInContext('descargaPollMs2912 = 5;', b.context);
  await asentar(40);
  const els = vm.runInContext('satDownloadScreen()', b.context);
  const raiz = b.context.document.createElement('div');
  raiz.append(...els);
  await asentar(40);
  /* RE-BASE 3.0 (Bloque B del encargo): la pantalla abre con
     la tarjeta «Ponerme al día» (els[0]) y la tarjeta del
     periodo queda como la vía manual, justo debajo. La
     `tarjeta` de esta batería es la del periodo: se localiza
     por su dataset, no por posición. */
  const tarjeta = els.find(el => el.dataset && el.dataset.dl2912 === 'card') || els[0];
  return { raiz, els, tarjeta };
}
const enTarjeta = (tarjeta, dataset, valor) =>
  andar(tarjeta).find(el => el.dataset[dataset] === valor);

/* ================================================================
   A · LA TARJETA PROTAGONISTA (vía masiva, e.firma): abre con
   el RFC del selector, fechas tecleables, UN botón; el envío
   construye el mismo criterio que la hoja; el progreso pinta
   los pasos con su palabra y los tres contadores desde el
   estado real; el cierre es una línea llana con su acceso a
   Facturas. Nada técnico en la tarjeta.
   ================================================================ */
{
  const JOB = { id: 'j2912', rfc: OWN, direction: 'issued', kind: 'cfdi',
    periodStart: '2026-11-01', periodEnd: '2026-11-18', created: 1760000000000 };
  const estado = { fase: 0, actividad: [], rev: 1 };
  const statusBody = jobs => ({ settings: { installName: 'PacoSAT', hasLogo: false },
    profiles: [{ rfc: OWN, accessMethod: 'efirma', efirmaStored: true, unlocked: true }],
    jobs, criteriaBook: [], mail: {}, puerta: {}, ejecutor: {},
    metadata: { records: 0, missing: [], lastSeen: null },
    coverage: { groups: [], gaps: [], days: {}, records: [] } });
  const b = await bootCliente2912({ responder: async target => {
    if (target.includes('/api/plan')) return { body: { ventanas: [] } };
    if (target.includes('/api/request')) return { body: statusBody([{ ...JOB, status: 'pending' }]) };
    if (target.includes('/api/status'))
      return { body: statusBody([{ ...JOB, status: estado.fase ? 'finished' : 'pending' }]) };
    if (target.includes('storage/rev')) return { body: { rev: estado.rev } };
    if (target.includes('storage?') && target.includes('store=activity')) {
      if (target.includes('since=')) return { body: { rows: estado.actividad, deleted: [], rev: estado.rev } };
      return { body: estado.actividad };
    }
    if (target.includes('/api/ciec')) return { body: { profiles: [] } };
    return undefined;
  } });
  const { raiz, els, tarjeta } = await pintarDescargas2912(b, { scopeRfc: OWN,
    perfiles: [{ rfc: OWN, accessMethod: 'efirma', efirmaStored: true, unlocked: true, ciecStored: false }] });
  assert.equal(tarjeta.dataset.dl2912, 'card',
    'A: la tarjeta del periodo existe (en la 2.9.11 no existe)');
  /* RE-BASE 3.0: la pantalla abre con «Ponerme al día» y la
     tarjeta del periodo es la vía manual, debajo. */
  assert.equal(els[0].dataset.aldia30, 'card',
    'A: la pantalla abre con la tarjeta «Ponerme al día» (3.0)');
  assert.ok(els.indexOf(tarjeta) > 0,
    'A: la tarjeta del periodo va tras la protagonista (vía manual de respaldo)');
  assert.ok(textoDe(tarjeta).includes(OWN),
    'A: la tarjeta abre con el RFC del selector global ya elegido');
  const dStart = enTarjeta(tarjeta, 'dl2912Start', '1');
  const dEnd = enTarjeta(tarjeta, 'dl2912End', '1');
  assert.ok(dStart && dEnd, 'A: la tarjeta trae sus dos fechas');
  assert.equal(dStart.tagName, 'INPUT', 'A: la fecha de inicio es un campo');
  assert.equal(dStart.type, 'date', 'A: y es tecleable de verdad (type=date)');
  assert.equal(dEnd.type, 'date', 'A: la fecha de fin también');
  dStart.value = '2026-11-01'; dEnd.value = '2026-11-18';
  const dirBtn = andar(tarjeta).find(el => el.dataset.dl2912Dir === 'issued');
  assert.ok(dirBtn, 'A: el control de sentido trae «Emitidos»');
  dirBtn.onclick();
  const go = enTarjeta(tarjeta, 'dl2912Go', '1');
  assert.ok(go && !go.disabled, 'A: hay UN botón protagonista «Descargar» activo');
  const textoTarjeta = textoDe(tarjeta);
  for (const tecnico of ['metadata', 'Metadata', 'criterio', '5002', 'código del SAT'])
    assert.ok(!textoTarjeta.includes(tecnico),
      'A: la tarjeta no enseña textos técnicos («' + tecnico + '»)');
  b.fetchLog.length = 0;
  await go.onclick();
  await asentar(40);
  const req = b.fetchLog.find(l => l.method === 'POST' && l.target.includes('/api/request'));
  assert.ok(req, 'A: el botón despacha la petición masiva de siempre');
  assert.deepEqual(JSON.parse(req.body), { rfc: OWN, direction: 'issued',
    start: '2026-11-01', end: '2026-11-18', type: 'cfdi' },
    'A: el envío construye el mismo criterio que la hoja (RFC, sentido, ventana, tipo)');
  const prog = enTarjeta(tarjeta, 'dl2912Progress', '1');
  assert.ok(prog && !prog.hidden, 'A: el progreso vive en la tarjeta');
  assert.equal(enTarjeta(tarjeta, 'dl2912Phase', '1').textContent, 'Consultando al SAT',
    'A: el primer paso se dice con su palabra: «Consultando al SAT»');
  assert.ok(textoDe(tarjeta).includes('El SAT está preparando tu paquete'),
    'A: la espera del SAT se dice en llano, sin veredicto técnico');
  assert.ok(enTarjeta(tarjeta, 'dl2912Cancel', '1'),
    'A: el Cancelar está visible durante la espera');
  const cuenta = nombre => enTarjeta(tarjeta, 'dl2912Count', nombre)?.textContent;
  assert.equal(cuenta('found'), '0', 'A: encontrados arranca en 0');
  assert.equal(cuenta('downloaded'), '0', 'A: descargados arranca en 0');
  assert.equal(cuenta('saved'), '0', 'A: guardados arranca en 0');
  /* El SAT libera el paquete y la importación aterriza: los
     contadores salen del estado real (trabajo + actividad). */
  estado.fase = 1; estado.rev = 2;
  estado.actividad = [{ id: 'sat:j2912:p1', added: 6, duplicates: 0, review: 0, issues: 0 }];
  await esperar(120);
  const resultado = enTarjeta(tarjeta, 'dl2912Result', '1');
  assert.ok(resultado && !resultado.hidden, 'A: el resultado se pinta en la tarjeta');
  assert.ok(textoDe(resultado).includes('Listo: 6 XML guardados en tu expediente'),
    'A: el cierre es la línea llana con lo guardado');
  assert.equal(cuenta('found'), '6', 'A: encontrados = 6 desde la importación real');
  assert.equal(cuenta('downloaded'), '6', 'A: descargados = 6');
  assert.equal(cuenta('saved'), '6', 'A: guardados = 6');
  assert.ok(buscarBoton(resultado, 'Ver en Facturas'),
    'A: el resultado da acceso a ver lo bajado en Facturas');
  console.log('OK 2.9.12-descarga · A — la tarjeta protagonista descarga por la vía masiva con pasos y contadores reales.');
}

/* ================================================================
   A2 · LA GUARDIA SIGUE VIVA EN LA TARJETA: si el servidor
   contesta la guardia (criterio ya pedido), la elección de la
   casa (guardChoice) manda y el reintento cierra 1 segundo
   más tarde — el criterio exacto no se reenvía jamás.
   ================================================================ */
{
  let peticiones = 0;
  const b = await bootCliente2912({ responder: async target => {
    if (target.includes('/api/plan')) return { body: { ventanas: [] } };
    if (target.includes('/api/request')) {
      peticiones++;
      if (peticiones === 1) return { status: 409, body: { error: 'Ese criterio ya se pidió.',
        guard: { state: 'ultima', message: 'Ese criterio ya se pidió: no se repite.',
          startAt: '2026-11-01T00:00:00', endAt: '2026-11-18T23:59:59',
          shiftedEndAt: '2026-11-19T00:00:00' } } };
      return { body: { profiles: [], jobs: [{ id: 'j2912g', rfc: OWN, direction: 'both', kind: 'cfdi',
        status: 'pending', periodStart: '2026-11-01', periodEnd: '2026-11-18' }],
        criteriaBook: [], mail: {}, puerta: {}, metadata: {}, coverage: {} } };
    }
    if (target.includes('/api/status')) return { body: { profiles: [], jobs: [], criteriaBook: [],
      mail: {}, puerta: {}, metadata: {}, coverage: {} } };
    if (target.includes('/api/ciec')) return { body: { profiles: [] } };
    return undefined;
  } });
  const { tarjeta } = await pintarDescargas2912(b, { scopeRfc: OWN,
    perfiles: [{ rfc: OWN, accessMethod: 'efirma', efirmaStored: true, unlocked: true, ciecStored: false }] });
  const go = enTarjeta(tarjeta, 'dl2912Go', '1');
  b.fetchLog.length = 0;
  const envio = go.onclick();
  await asentar(60);
  const cajaGuardia = buscarBoton(b.campos(), 'Cerrar 1 segundo más tarde y enviar');
  assert.ok(cajaGuardia, 'A2: la guardia del servidor enseña la elección de la casa');
  await cajaGuardia.onclick();
  await envio; await asentar(40);
  const reqs = b.fetchLog.filter(l => l.method === 'POST' && l.target.includes('/api/request'));
  /* RE-BASE 2.9.13 · A1: «Emitidos y recibidos» son ahora DOS
     envíos (uno por sentido — el servidor no acepta 'both');
     la guardia cae en el primero (recibidos): envío + su
     reintento desplazado + el envío limpio de emitidos = 3. */
  assert.equal(reqs.length, 3, 'A2: envío con guardia, su reintento y el segundo sentido, ni uno más');
  assert.equal(JSON.parse(reqs[1].body).shiftEnd, 1,
    'A2: el reintento cierra 1 segundo más tarde (shiftEnd=1), nunca el criterio exacto');
  console.log('OK 2.9.12-descarga · A2 — la guardia 409 vive en la tarjeta con su elección y su variante.');
}

/* ================================================================
   B · «YA SE PIDIÓ»: el plan se consulta antes de enviar; el
   aviso vive en la tarjeta y el envío sale como variante
   (shiftEnd=1) — el criterio exacto no se repite.
   ================================================================ */
{
  const b = await bootCliente2912({ responder: async target => {
    if (target.includes('/api/plan'))
      return { body: { yaPedida: { at: 1760000000000, requestId: 'r-previa' } } };
    if (target.includes('/api/request')) return { body: { profiles: [], jobs: [{ id: 'j2912b',
      rfc: OWN, direction: 'both', kind: 'cfdi', status: 'pending',
      periodStart: '2026-11-01', periodEnd: '2026-11-30' }], criteriaBook: [], mail: {},
      puerta: {}, metadata: {}, coverage: {} } };
    if (target.includes('/api/status')) return { body: { profiles: [], jobs: [], criteriaBook: [],
      mail: {}, puerta: {}, metadata: {}, coverage: {} } };
    if (target.includes('/api/ciec')) return { body: { profiles: [] } };
    return undefined;
  } });
  const { tarjeta } = await pintarDescargas2912(b, { scopeRfc: OWN,
    perfiles: [{ rfc: OWN, accessMethod: 'efirma', efirmaStored: true, unlocked: true, ciecStored: false }] });
  await esperar(60);
  const aviso = enTarjeta(tarjeta, 'dl2912PlanAviso', '1');
  assert.ok(aviso && !aviso.hidden, 'B: el aviso de «ya se pidió» vive en la tarjeta');
  assert.ok(textoDe(aviso).includes('ya se pidió'),
    'B: el aviso lo dice en llano, con su fecha');
  const go = enTarjeta(tarjeta, 'dl2912Go', '1');
  assert.ok((go.textContent || '').includes('variante'),
    'B: el botón se renombra a pedir la variante');
  b.fetchLog.length = 0;
  await go.onclick();
  await asentar(40);
  const req = b.fetchLog.find(l => l.method === 'POST' && l.target.includes('/api/request'));
  assert.ok(req, 'B: la variante sí se despacha');
  assert.equal(JSON.parse(req.body).shiftEnd, 1,
    'B: el envío lleva shiftEnd=1: el mismo periodo cerrando 1 segundo más tarde');
  console.log('OK 2.9.12-descarga · B — «ya se pidió» avisa en la tarjeta y el envío es la variante.');
}

/* ================================================================
   C · PIEZA 3 — CIEC CON CAPTCHA MANUAL EN LA TARJETA: el
   RFC sin e.firma y con CIEC descarga desde la protagonista;
   el captcha se enseña DENTRO de la tarjeta, se teclea, y la
   descarga sigue con los mismos pasos y contadores.
   ================================================================ */
{
  const IMG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const perfilCiec = (progress, captcha, runs) => ({ rfc: CIE, ciecStored: true,
    progress, captcha, runs });
  const estado = { version: 0 };
  const versiones = [
    { profiles: [perfilCiec({ running: true, step: 'Conectando con el portal del SAT…',
      steps: [{ text: 'Conectando con el portal del SAT…' }] }, null, [])] },
    { profiles: [perfilCiec({ running: true, step: 'El portal pide el captcha…',
      steps: [{ text: 'Conectando con el portal del SAT…' }, { text: 'El portal pide el captcha: es tu gesto.' }] },
      { waiting: true, image: IMG, attempt: 1, max: 3, since: 111 }, [])] },
    { profiles: [perfilCiec({ running: true, step: 'Descargando tus facturas (6 de 6)…',
      steps: [{ text: 'Conectando con el portal del SAT…' }, { text: 'Ya estás dentro del portal.' },
        { text: 'El portal encontró 6 facturas en el rango.' },
        { text: 'Descargando tus facturas (6 de 6)…' }] }, null, [])] },
    { profiles: [perfilCiec({ running: false, ok: true, step: 'Descarga terminada',
      steps: [{ text: 'Guardando en tu expediente…' }] }, null,
      [{ ok: true, found: 6, downloaded: 6, added: 6, duplicates: 0, started: 1760000000000 }])] },
  ];
  const b = await bootCliente2912({ responder: async (target, init) => {
    if (target.includes('/api/ciec/run')) { estado.version = 1; return { body: versiones[0] }; }
    if (target.includes('/api/ciec/captcha')) { estado.version = 2; return { body: versiones[2] }; }
    if (target.includes('/api/ciec')) return { body: versiones[estado.version] };
    if (target.includes('/api/plan')) return { body: { ventanas: [] } };
    return undefined;
  } });
  const { tarjeta } = await pintarDescargas2912(b, { scopeRfc: CIE,
    perfiles: [{ rfc: CIE, accessMethod: 'ciec', efirmaStored: false, unlocked: false, ciecStored: true }] });
  assert.ok(textoDe(tarjeta).includes('CIEC'),
    'C: la tarjeta ofrece la vía CIEC para el RFC sin e.firma');
  const go = enTarjeta(tarjeta, 'dl2912Go', '1');
  assert.ok(go && !go.disabled, 'C: el botón protagonista está activo en modo CIEC');
  b.fetchLog.length = 0;
  await go.onclick();
  await asentar(50);
  const run = b.fetchLog.find(l => l.method === 'POST' && l.target.includes('/api/ciec/run'));
  assert.ok(run, 'C: el botón lanza la corrida CIEC de la maquinaria existente');
  assert.equal(JSON.parse(run.body).rfc, CIE, 'C: la corrida es del RFC elegido');
  assert.ok(!b.fetchLog.some(l => l.target.includes('/api/request')),
    'C: la vía CIEC no toca la descarga masiva');
  await esperar(80);
  const cajaCaptcha = enTarjeta(tarjeta, 'dl2912Captcha', '1');
  assert.ok(cajaCaptcha && !cajaCaptcha.hidden,
    'C: el captcha se enseña DENTRO de la tarjeta de descarga');
  const img = enTarjeta(tarjeta, 'dl2912CaptchaImg', '1');
  assert.ok(img && img.src === IMG, 'C: la imagen del captcha es la que el portal enseñó');
  assert.ok(textoDe(cajaCaptcha).includes('intento 1 de 3'),
    'C: la tarjeta dice el intento del captcha');
  const entrada = enTarjeta(tarjeta, 'dl2912CaptchaInput', '1');
  assert.ok(entrada, 'C: el campo para teclear el captcha está en la tarjeta');
  entrada.value = 'AB3DE';
  b.fetchLog.length = 0;
  await enTarjeta(tarjeta, 'dl2912CaptchaGo', '1').onclick();
  await asentar(40);
  const cap = b.fetchLog.find(l => l.method === 'POST' && l.target.includes('/api/ciec/captcha'));
  assert.ok(cap, 'C: teclear el captcha lo manda a la maquinaria CIEC');
  assert.deepEqual(JSON.parse(cap.body), { rfc: CIE, text: 'AB3DE' },
    'C: viaja solo el texto tecleado, para ese RFC');
  assert.equal(entrada.value, '', 'C: el campo se limpia al enviar: el captcha no se queda en la pantalla');
  await esperar(100);
  const cuenta = nombre => enTarjeta(tarjeta, 'dl2912Count', nombre)?.textContent;
  assert.equal(cuenta('found'), '6', 'C: encontrados sale de los pasos reales del motor (6)');
  assert.equal(cuenta('downloaded'), '6', 'C: descargados llega a 6');
  estado.version = 3;
  await esperar(120);
  const resultado = enTarjeta(tarjeta, 'dl2912Result', '1');
  assert.ok(resultado && textoDe(resultado).includes('Listo: 6 XML guardados en tu expediente'),
    'C: la vía CIEC cierra con la misma línea llana de la Pieza 2');
  assert.equal(cuenta('saved'), '6', 'C: guardados = 6 desde la corrida terminada');
  console.log('OK 2.9.12-descarga · C — CIEC con captcha manual dentro de la tarjeta, mismos pasos y contadores.');
}

/* ================================================================
   D · SIN NINGÚN ACCESO: la tarjeta dice en llano el único
   gesto que falta y NO lanza nada. Y sus dos hermanas: CIEC
   sin contraseña guardada y e.firma sin autorizar.
   ================================================================ */
{
  const b = await bootCliente2912({ responder: async target => {
    if (target.includes('/api/ciec')) return { body: { profiles: [] } };
    if (target.includes('/api/plan')) return { body: { ventanas: [] } };
    return undefined;
  } });
  const { tarjeta } = await pintarDescargas2912(b, { scopeRfc: SIN, perfiles: [] });
  const falta = enTarjeta(tarjeta, 'dl2912Falta', '1');
  assert.ok(falta && !falta.hidden, 'D: la tarjeta pinta su caja de gesto único');
  assert.ok(textoDe(falta).includes('Falta dar de alta el acceso de este RFC'),
    'D: lo dice en llano: falta dar de alta el acceso');
  assert.ok(!enTarjeta(tarjeta, 'dl2912Go', '1'),
    'D: sin acceso no hay botón de descargar que pulsar');
  b.fetchLog.length = 0;
  await enTarjeta(tarjeta, 'dl2912FaltaGo', '1').onclick();
  await asentar(40);
  assert.ok(b.textoCampos().includes('Con e.firma') && b.textoCampos().includes('Con contraseña (CIEC)'),
    'D: el gesto lleva al alta de la casa (e.firma o CIEC)');
  assert.ok(!b.fetchLog.some(l => l.target.includes('/api/request') || l.target.includes('/api/ciec/run')),
    'D: no se lanzó ninguna descarga');
}
{
  const b = await bootCliente2912({ responder: async target => {
    if (target.includes('/api/ciec')) return { body: { profiles: [] } };
    if (target.includes('/api/plan')) return { body: { ventanas: [] } };
    return undefined;
  } });
  const { tarjeta } = await pintarDescargas2912(b, { scopeRfc: CIE,
    perfiles: [{ rfc: CIE, accessMethod: 'ciec', efirmaStored: false, unlocked: false, ciecStored: false }] });
  const falta = enTarjeta(tarjeta, 'dl2912Falta', '1');
  assert.ok(falta && textoDe(falta).includes('Falta guardar la contraseña CIEC de este RFC'),
    'D2: CIEC sin contraseña: el gesto único es guardarla');
  assert.ok(enTarjeta(tarjeta, 'dl2912FaltaGo', '1'), 'D2: el gesto tiene su botón');
  console.log('OK 2.9.12-descarga · D — sin acceso, la tarjeta nombra el gesto único y no lanza nada.');
}
{
  const b = await bootCliente2912({ responder: async target => {
    if (target.includes('/api/ciec')) return { body: { profiles: [] } };
    if (target.includes('/api/plan')) return { body: { ventanas: [] } };
    return undefined;
  } });
  const { tarjeta } = await pintarDescargas2912(b, { scopeRfc: FIR,
    perfiles: [{ rfc: FIR, accessMethod: 'efirma', efirmaStored: true, unlocked: false, ciecStored: false }] });
  const falta = enTarjeta(tarjeta, 'dl2912Falta', '1');
  assert.ok(falta && textoDe(falta).includes('Autorizar la e.firma'),
    'D3: e.firma guardada pero no autorizada: el gesto es autorizarla (paridad con la hoja, B3)');
  assert.ok(!enTarjeta(tarjeta, 'dl2912Go', '1'),
    'D3: sin firmante activo no hay descarga que lanzar');
  console.log('OK 2.9.12-descarga · D3 — la e.firma sin autorizar pide su gesto, como la hoja.');
}

/* ================================================================
   F · PRECISIÓN 1: la confirmación de la descarga MASIVA no
   contiene ningún texto de puerta; el despacho del PORTAL
   (confirmarDespacho201) sí enseña el estado veraz.
   ================================================================ */
{
  const b = await bootCliente2912({ responder: async target => {
    if (target.includes('/api/plan')) return { body: { ventanas: [] } };
    if (target.includes('/api/ciec')) return { body: { profiles: [] } };
    return undefined;
  } });
  vm.runInContext(
    'scope = "' + OWN + '"; people = [{ id: "' + OWN + '", name: "Empresa de Prueba, S.A." }];' +
    'invoices = []; documents = []; activity = [];' +
    'satData = { profiles: [{ rfc: "' + OWN + '", accessMethod: "efirma", efirmaStored: true, unlocked: true }],' +
    ' jobs: [], criteriaBook: [], mail: {}, ejecutor: {}, metadata: {}, coverage: {},' +
    ' puerta: { "' + OWN + '": { ok: false, probada: 1760000000000,' +
    '   error: "El portal del SAT no respondió al abrir la página de acceso.", ultimoExito: 1750000000000 } } };',
    b.context);
  await vm.runInContext("ensureLazyPart('descargas')", b.context);
  await asentar(40);
  vm.runInContext('downloadSheet("' + OWN + '")', b.context);
  await asentar(40);
  const form = andar(b.dialogo()).find(el => el.tagName === 'FORM');
  assert.ok(form, 'F: la hoja de descarga se abre');
  form.onsubmit({ preventDefault() {} });
  await asentar(30);
  const confirmacion = textoDe(form);
  assert.ok(confirmacion.includes('Confirmar y pedir al SAT'),
    'F: la confirmación de la masiva existe');
  assert.ok(!/puerta/i.test(confirmacion),
    'F: la confirmación de la descarga MASIVA no contiene ningún texto de puerta ' +
    '(en la 2.9.11 enseñaba «Ahora no consta que la puerta…» con su botón de probarla)');
  assert.ok(!buscarBoton(form, 'Probar la puerta ahora'),
    'F: tampoco viaja el botón de probar la puerta en la masiva');
  /* El despacho del portal SÍ enseña la puerta: ahí la ruta
     del portal se usa de verdad (Buzón/Declaraciones). */
  vm.runInContext('confirmarDespacho201({ titulo: "Consultar el Buzón", lineas: ["Se abrirá el portal del SAT."],' +
    ' rfc: "' + OWN + '", boton: "Consultar", alConfirmar: () => {} })', b.context);
  await asentar(30);
  const formPortal = andar(b.dialogo()).filter(el => el.tagName === 'FORM')
    .find(el => textoDe(el).includes('Consultar el Buzón'));
  assert.ok(formPortal && /puerta/i.test(textoDe(formPortal)),
    'F: el despacho del portal sí enseña el estado veraz de la puerta');
  assert.ok(buscarBoton(formPortal, 'Probar la puerta ahora'),
    'F: y ofrece probarla ahí mismo, como siempre');
  console.log('OK 2.9.12-descarga · F — la puerta fuera de la masiva; veraz en la ruta del portal.');
}

/* ================================================================
   P · PARIDAD DE LA PANTALLA (inventario contra 2.9.11):
   todo lo que la pantalla hacía sigue, tras la tarjeta.
   ================================================================ */
{
  const b = await bootCliente2912({ responder: async target => {
    if (target.includes('/api/plan')) return { body: { ventanas: [] } };
    if (target.includes('/api/ciec')) return { body: { profiles: [] } };
    return undefined;
  } });
  const { raiz, els } = await pintarDescargas2912(b, { scopeRfc: OWN,
    perfiles: [{ rfc: OWN, accessMethod: 'efirma', efirmaStored: true, unlocked: true, ciecStored: false }] });
  const texto = textoDe(raiz);
  for (const pieza of ['Dar de alta un RFC', 'Configurar RFC', 'Solicitar un periodo',
    'Modo descanso general', 'Revisión automática por RFC', 'Solicitudes recientes',
    'Historial de peticiones al SAT', 'Qué meses tienes'])
    assert.ok(texto.includes(pieza), 'P: la pantalla conserva «' + pieza + '»');
  assert.ok(els.length >= 3, 'P: la pantalla sigue componiendo guía, cola y cobertura tras la tarjeta');
  /* La hoja clásica sigue existiendo con su aviso y su
     variante (la tarjeta no la sustituye: la precede). */
  const sat = readFileSync(join(AQUI, 'sat-ui.part'), 'utf8');
  const hoja = sat.slice(sat.indexOf('function downloadSheet'), sat.indexOf('function planYaPedidas230'));
  assert.ok(hoja.includes('planYaPedidas230') && hoja.includes('shiftEnd'),
    'P: la hoja conserva su aviso de «ya se pidió» y su variante de 1 segundo');
  assert.ok(!hoja.includes('puertaTexto201') && !hoja.includes('Probar la puerta ahora'),
    'P: la hoja ya no mezcla la puerta en su confirmación (Precisión 1, también en fuente)');
  console.log('OK 2.9.12-descarga · P — paridad inventariada: nada de la pantalla desaparece.');
}

console.log('OK ronda2912descarga: Descargar simple (Pieza 2), CIEC con captcha en la tarjeta (Pieza 3) ' +
  'y la puerta fuera de la masiva (Precisión 1).');
