/* ================================================================
   Ronda 2.0 · Tanda 1 — causa viva, semáforo compuesto, progreso
   honesto, «Lo que falta» sin huecos ni dobles, formato único,
   umbrales de salud, ejecutor contextual y primario por pantalla
   (auditoría 15 nov: correcciones 1, 2, 4, 6 y 8; M1, M2, M4, M9).

   (a) Ejecutor apagado + puerta vieja con error de e.firma: los
       textos compuestos nombran la causa viva (tu equipo) y NO
       mandan a la e.firma; la e.firma solo es gesto con causa
       de e.firma y prueba fresca. Servidor: al volver el
       ejecutor tras una ausencia larga, la puerta vieja se
       re-prueba sola (trabajo puerta-probar encolado).
   (b) Semáforo compuesto: con una pata caída no hay verde.
   (c) Trabajo en cola: barra a 0, sin porcentaje de relleno, y
       el tiempo de espera como protagonista.
   (d) «Lo que falta»: sin «: .» y con UNA sola fila de buzón.
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

/* ===== (a)+(b) Cliente: causa viva, caducidad y semáforo ===== */
{
  const context = await bootCliente();
  for (const fn of ['causaP200', 'textoP200', 'vigil200', 'pasoHoy200', 'localTime'])
    assert.equal(vm.runInContext('typeof ' + fn, context), 'function', fn + ' existe en el cliente');

  /* Causa viva: ejecutor apagado manda sobre la e.firma vieja. */
  context.__p = PUERTA_EFIRMA; context.__e = EJECUTOR_APAGADO; context.__a = AHORA;
  assert.equal(vm.runInContext('causaP200(__p, __e, __a).tipo', context), 'equipo',
    'M1: con el equipo apagado, la causa viva es el equipo');
  assert.equal(vm.runInContext('causaP200(__p, __e, __a).vieja', context), true,
    'M1: la prueba del 13 nov es foto vieja el 15 nov');
  const textoPuerta = vm.runInContext('textoP200(__p, __e, __a)', context);
  assert.match(textoPuerta, /Tu equipo no responde desde el/, 'M1: el texto nombra la causa viva primero');
  assert.match(textoPuerta, /foto vieja|desactualizada/, 'M1: la caducidad va visible');
  assert.match(textoPuerta, /la puerta se prueba sola antes que nada/, 'M1: y la re-prueba automática se promete');
  assert.ok(!/Carga la e\.firma|revisar la e\.firma/i.test(textoPuerta), 'M1: ese texto NO manda a la e.firma');

  /* La tarjeta del Buzón (satTramiteEstados) compone lo mismo. */
  context.__d = { rfc: OWN, profile: { unlocked: true }, lastJob: null,
    docsProfile: { progress: null }, trib: { ultimaConsulta: T_SENAL, sinAbrir: 2, runs: [] },
    puerta: PUERTA_EFIRMA, declProgreso: null, ejecutor: EJECUTOR_APAGADO, cola: [],
    ultimoCfdi: '', complementos: { total: 0, ultima: '' }, ultimoAcuse: '' };
  const detalle = vm.runInContext('satTramiteEstados(__d).buzon.detalle', context);
  assert.match(detalle, /Tu equipo no responde/, 'M1: la tarjeta del Buzón nombra la causa viva');
  assert.ok(!/NO abre — Este perfil no tiene/.test(detalle), 'M1: la tarjeta ya no sentencia con la foto vieja');

  /* Gestos de Hoy: el gesto es el equipo, no la e.firma. */
  ponerSatData(context, { rest: { active: false }, puerta: { [OWN]: PUERTA_EFIRMA },
    ejecutor: EJECUTOR_APAGADO, pendingProfiles: [], adminLogin: { configurado: true },
    scheduledBackup: { enabled: true }, profiles: [], jobs: [], inbox: [], mail: {} });
  const gestos = vm.runInContext('gestosLista1311()', context);
  assert.ok(gestos.some(g => /Tu equipo no responde/.test(g.titulo)), 'M1: Hoy lista el gesto del equipo');
  assert.ok(!gestos.some(g => g.boton === 'Revisar la e.firma'),
    'M1: con causa de equipo, ningún gesto manda a la e.firma');

  /* Solo con ejecutor vivo y prueba fresca la e.firma es el gesto. */
  const puertaFresca = { ...PUERTA_EFIRMA, probada: AHORA - 3600000 };
  context.__p2 = puertaFresca; context.__e2 = EJECUTOR_VIVO;
  assert.equal(vm.runInContext('causaP200(__p2, __e2, __a).tipo', context), 'efirma',
    'M1: causa de e.firma + prueba fresca + equipo vivo ⇒ causa e.firma');
  ponerSatData(context, { rest: { active: false }, puerta: { [OWN]: puertaFresca },
    ejecutor: EJECUTOR_VIVO, pendingProfiles: [], adminLogin: { configurado: true },
    scheduledBackup: { enabled: true }, profiles: [], jobs: [], inbox: [], mail: {} });
  const gestos2 = vm.runInContext('gestosLista1311()', context);
  assert.ok(gestos2.some(g => g.boton === 'Revisar la e.firma'),
    'M1: solo entonces el gesto es «Revisar la e.firma»');

  /* (b) Semáforo compuesto: una pata caída ⇒ nada de verde. */
  ponerSatData(context, { rest: { active: false }, puerta: { [OWN]: PUERTA_EFIRMA },
    ejecutor: EJECUTOR_APAGADO, pendingProfiles: [], profiles: [{ rfc: OWN, lastSatSuccess: AHORA - 3600000 }] });
  const vig = vm.runInContext('vigil200(' + AHORA + ')', context);
  assert.notEqual(vig.nivel, 'ok', 'M2: con el equipo caído el semáforo NO es verde');
  assert.match(vig.titulo, /tu equipo no responde/, 'M2: el rótulo nombra la pata caída');
  const interruptor = vm.runInContext('restSwitch()', context);
  const textoSwitch = textoDe(interruptor);
  assert.match(textoSwitch, /Vigilando con un problema: tu equipo no responde/, 'M2: el interruptor compone el mismo rótulo');
  assert.ok(!textoSwitch.includes('Descarga y avisos automáticos activos'), 'M2: fuera el «todo activo» falso');
  /* Puerta cerrada por e.firma fresca ⇒ rojo. */
  ponerSatData(context, { rest: { active: false }, puerta: { [OWN]: puertaFresca },
    ejecutor: EJECUTOR_VIVO, pendingProfiles: [], profiles: [{ rfc: OWN, lastSatSuccess: AHORA - 3600000 }] });
  assert.equal(vm.runInContext('vigil200(' + AHORA + ').nivel', context), 'bad',
    'M2: puerta cerrada por e.firma ⇒ rojo');
  /* Todo sano ⇒ verde, y solo entonces. */
  ponerSatData(context, { rest: { active: false }, puerta: { [OWN]: { ok: true, probada: AHORA - 3600000, error: '', errorKind: '' } },
    ejecutor: EJECUTOR_VIVO, pendingProfiles: [], profiles: [{ rfc: OWN, lastSatSuccess: AHORA - 3600000 }] });
  const vigOk = vm.runInContext('vigil200(' + AHORA + ')', context);
  assert.equal(vigOk.nivel, 'ok', 'M2: con todo sano, verde');
  assert.equal(vigOk.titulo, '🟢 Vigilando', 'M2: y el rótulo de siempre');

  /* Formato único: localDateTime ES fmtFechaHora, en 24 h. */
  const muestra = vm.runInContext('localDateTime(' + T_SENAL + ')', context);
  assert.equal(muestra, vm.runInContext('fmtFechaHora(' + T_SENAL + ')', context),
    '1.4: un solo formato para la misma señal');
  assert.match(muestra, /^\d{1,2} [a-z]{3}, \d{2}:\d{2}$/, '1.4: «14 nov, 23:02» en 24 h');
  assert.ok(!/p\.m\.|a\.m\./i.test(html), '1.4: el artefacto no pinta horas con p.m./a.m.');
  /* La ÚNICA hora suelta que queda es el pie «Modificado el…»:
     su texto exacto lo sella boot.test de la 1.32.3 y no es una
     señal del ejecutor — queda como excepción documentada. */
  assert.equal((html.match(/toLocaleTimeString/g) || []).length, 1,
    '1.4: un solo toLocaleTimeString en el artefacto (el pie sellado)');
  assert.ok(html.includes("toLocaleTimeString('es-MX', { timeZone: 'America/Mexico_City', hour: '2-digit', minute: '2-digit' })"),
    '1.4: y es el del pie, no una señal viva');
  console.log('OK 2.0 · (a)+(b) cliente — causa viva primero, caducidad visible y semáforo compuesto.');
}

/* ===== (c) Cliente: progreso honesto en cola ===== */
{
  const context = await bootCliente();
  context.__desde = AHORA - 4 * 3600000;
  const cola = vm.runInContext(
    'jobProgress1312({ fase: "En cola: esperando a tu equipo", desde: __desde, estado: "en-cola" })', context);
  assert.equal(cola.getAttribute('aria-valuenow'), '0', 'M4: en cola, el valor es 0');
  const barras = buscarPorClase(cola, 'job-bar');
  assert.equal(barras.length, 1, 'M4: una barra');
  assert.ok(String(barras[0].className).includes('job-bar-espera'), 'M4: la barra es de espera, no de avance');
  assert.ok(!String(barras[0].className).includes('job-bar-ind'), 'M4: sin vaivén que parezca avance');
  const rellenos = buscarPorClase(cola, 'job-bar-fill');
  assert.equal(rellenos[0].style.width, '0%', 'M4: relleno a 0 — nada de barra casi llena');
  assert.match(textoDe(cola), /esperando desde hace/, 'M4: el tiempo de espera es el protagonista');
  /* También por estado, como llega de la franja de actividad. */
  const porEstado = vm.runInContext(
    'jobProgress1312({ fase: "Esperando a tu equipo", desde: __desde, estado: "esperando", done: 0, total: 0 })', context);
  assert.equal(porEstado.getAttribute('aria-valuenow'), '0', 'M4: estado «esperando» ⇒ 0');
  /* En curso con pasos reales: el porcentaje es el de los pasos. */
  const curso = vm.runInContext(
    'jobProgress1312({ fase: "Trabajando en tu equipo", desde: __desde, done: 1, total: 4 })', context);
  assert.equal(curso.getAttribute('aria-valuenow'), '25', 'M4: en curso, porcentaje real de pasos');
  assert.equal(buscarPorClase(curso, 'job-bar-fill')[0].style.width, '25%', 'M4: y su relleno');
  console.log('OK 2.0 · (c) cliente — en cola, espera sin relleno; en curso, pasos reales.');
}

/* ===== Primario contextual y ejecutor contextual (cliente) ===== */
{
  const context = await bootCliente();
  ponerSatData(context, { rest: { active: false }, puerta: { [OWN]: { ok: true, probada: AHORA - 3600000, error: '', errorKind: '' } },
    ejecutor: EJECUTOR_VIVO, pendingProfiles: [], profiles: [] });
  assert.equal(vm.runInContext('page = "invoices", primaryLabel()', context), 'Descargar del SAT',
    '1.3: en Facturas el primario es «Descargar del SAT»');
  assert.equal(vm.runInContext('page = "home", primaryLabel()', context), 'Descargar CFDI del SAT',
    '1.3: en Hoy, sin gesto protagonista, el primario es descargar CFDI');
  ponerSatData(context, { rest: { active: false }, puerta: { [OWN]: PUERTA_EFIRMA },
    ejecutor: EJECUTOR_APAGADO, pendingProfiles: [], profiles: [] });
  assert.equal(vm.runInContext('page = "home", primaryLabel()', context), 'Ver tu ejecutor',
    '1.3: en Hoy, con la causa viva en el equipo, el primario es ese paso');
  assert.equal(vm.runInContext('page = "sat", satTab = "ejecutor", primaryLabel()', context), 'Tu ejecutor',
    '2.6: con ejecutor emparejado, el primario dice «Tu ejecutor»');
  ponerSatData(context, { rest: { active: false }, puerta: {}, ejecutor: { emparejado: false, enLinea: false, ultimoVisto: null, nombre: '' },
    pendingProfiles: [], profiles: [] });
  assert.equal(vm.runInContext('primaryLabel()', context), 'Emparejar un ejecutor en mi equipo',
    '2.6: sin ejecutor, la oferta es emparejar');
  /* El despacho tiene la rama de cada etiqueta nueva. */
  for (const [etiqueta, gesto] of [['Descargar del SAT', 'downloadSheet(scope)'],
    ['Ver tu ejecutor', "satTab = 'ejecutor'"], ['Tu ejecutor', 'satData?.ejecutor?.emparejado']])
    assert.ok(html.includes(etiqueta) && html.includes(gesto),
      'cabecera honesta: «' + etiqueta + '» promete y despacha (' + gesto + ')');
  console.log('OK 2.0 · primario contextual (Hoy/Facturas) y ejecutor contextual.');
}

/* ===== (d) Hoy: «Lo que falta» sin huecos ni filas dobles ===== */
{
  const context = await bootCliente();
  ponerSatData(context, { rest: { active: false }, puerta: {}, ejecutor: EJECUTOR_VIVO,
    pendingProfiles: [], profiles: [], jobs: [], inbox: [], mail: {},
    buzonUnread: { [OWN]: 5 }, tributario: {} });
  context.__lecturas = ruta => {
    if (ruta === 'notices') return { counts: { total: 2, mal: 1, falta: 1, espera: 0, necesita: 0 },
      avisos: [{ titulo: 'Falta la constancia', clase: 'falta', vence: null },
        { titulo: 'Un CFDI quedó cancelado', clase: 'mal', vence: null }],
      historial: [], canales: { correo: true, push: false } };
    if (ruta === 'reconcile') return { confirmed: [] };
    if (ruta.startsWith('reports/checklist')) return null;
    if (ruta === 'satdocs') return { profiles: [] };
    if (ruta === 'monthly') return { runs: [] };
    if (ruta === 'activity/digest') return null;
    if (ruta === 'registro/resumen') return { conexiones: 1, acciones: 2, fallos: 0 };
    if (ruta === 'executor/overview') return { enLinea: false, enCola: 0, ejecutores: [{ revocado: false, ultimoVisto: T_SENAL }] };
    return null;
  };
  vm.runInContext('satApiLectura = async ruta => __lecturas(ruta); todayCache = { at: 0, data: null };', context);
  const panel = vm.runInContext('todayPanel()', context);
  const columnas = buscarPorClase(panel, 'today-col');
  assert.equal(columnas.length, 3, 'Hoy pinta sus tres columnas');
  /* La parte asíncrona pinta en las columnas VIVAS del documento:
     el arnés le presta las del panel, como hace el navegador. */
  context.document.querySelectorAll = selector =>
    String(selector).includes('today-col') ? columnas : [];
  for (let i = 0; i < 16; i++) await new Promise(resolve => setTimeout(resolve, 0));
  const falta = textoDe(columnas[1]);
  assert.ok(falta.includes('2 aviso(s) abiertos: Falta la constancia; Un CFDI quedó cancelado.'),
    'M9: la fila de avisos NOMBRA los avisos');
  assert.ok(!/:\s+\./.test(falta) && !falta.includes('abiertos: .'), 'M9: ninguna enumeración vacía («: .»)');
  const filasBuzon = falta.split('Buzón:').length - 1;
  assert.equal(filasBuzon, 1, 'M9: una sola fila de buzón en «Lo que falta»');
  assert.ok(falta.includes('Buzón: 5 sin leer'), 'M9: la fila dice lo sin leer');
  assert.ok(falta.includes('Buzón Tributario del SAT: sin consultar todavía'),
    'M9: y el estado del Tributario, en la MISMA fila');
  console.log('OK 2.0 · (d) — «Lo que falta» nombra los avisos y el buzón vive en una fila.');
}

/* ===== Servidor real: re-prueba al volver, cola y disco ===== */
const CER_REAL_200 = 'MIIDUzCCAjugAwIBAgIUH2WzMvVXT5BC2dNEzTaqRKJcZVUwDQYJKoZIhvcNAQELBQAwOTEgMB4GA1UEAwwXRU1QUkVTQSBQUlVFQkEgU0EgREUgQ1YxFTATBgNVBAUTDE1GSTYyMTIxNThCNDAeFw0yNjExMDkwNTA0MzVaFw0zNjExMDYwNTA0MzVaMDkxIDAeBgNVBAMMF0VNUFJFU0EgUFJVRUJBIFNBIERFIENWMRUwEwYDVQQFEwxNRkk2MjEyMTU4QjQwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQDJv/UPUgh/H1XwYFWUj2DV8HVVL95Z3LSi7P5yC1m2hcXlGVyvrc9EwIxTYuKVndt3mZyafViTg7Zng3wPs/bkZIhWcXTBkFPy8/4OZF4HKhgQTByszYEqBo4hr6o98FqS638cXcIkAzKFaIhpIJUpFMmUyKlSLgdWRcW7gm4SF2TaWYWi5CBok6gSoWsbmvEdFa0BbSCTxUUOxxWeoqhaMeYgN+PYpLWkl8Iq7VZJ+JeH0LMvbKg6Bhug0KOnC3/yNSBDIrg+A1rOysN8JJOU76zPuqj6aki7+oAEZIpGcu6h3cri7S8qq3zYupFdmZHwRySGDRci3ZpyCqjlFB97AgMBAAGjUzBRMB0GA1UdDgQWBBQYRYXN6Lv4Ke+TNpNWj7H1tqkEpTAfBgNVHSMEGDAWgBQYRYXN6Lv4Ke+TNpNWj7H1tqkEpTAPBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUAA4IBAQC8EwF8xC42pm/jFhTaO/gp2LDiSfz5cIJyZe9XsbczupYA9moD0Y9qMdEFAqgSVmFqJNgE675d5meRJdvRariROlpN3BZfcvPDEqHnwjqzjgHBt9e+GYb8UzdvkWiJuN7hoWgs2m+AJdPnsIWopKVI8enqng9Un7LbzCkACmJuG03Y+N7uuT/jIE+hNBHLJI6S9CGGs3hr8S4eZ2ijQeYyrWtLoeadLFsp4QqDb/JqXGtrIWFH9p3TNDEvyyVsYUBXSBIxX9zf/EYQ9NMLqIVSJ5hR/GjmDPf0plFteYQZEhRohrXnAox6clkDaIqTJkzWHhY4PHCPn+sJAh+Jzz8Y';
{
  const dir = mkdtempSync(join(tmpdir(), 'pacosat-200a-'));
  const clock = { t: T_PUERTA };
  const service = createPacoSATService({
    dbFile: join(dir, 't.sqlite'), efirmaDir: join(dir, 'efirma'),
    html: '<html><head><!--PACOSAT_TOKEN--></head><body>prueba</body></html>',
    origin: ORIGIN, proxyKey: KEY, satDocRetryWaitMs: 5, executorMode: 'remote',
    makeConnector: async ({ password }) => {
      if (password !== 'buena') throw new Error('credencial rechazada');
      return { parser: DOMParser, connector: {
        request: async () => 'req-200', check: async () => ({ status: 'pending', packages: [] }),
        download: async () => { throw new Error('sin paquetes'); } } };
    },
    makeMailer: () => ({ verify: async () => true, sendMail: async () => ({ messageId: 'm1' }) }),
    now: () => clock.t });
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
  const call = async (method, path, body, extraHeaders = {}) => {
    if (!token) { const home = await raw('GET', '/'); token = /[0-9a-f]{64}/.exec(home.text)?.[0] || ''; }
    const r = await raw(method, path, body, { 'x-pacosat-token': token, ...extraHeaders });
    let json = null; try { json = JSON.parse(r.text); } catch { /* binario */ }
    return { status: r.status, json, text: r.text };
  };
  const exec = async (method, path, body, execToken) => {
    const r = await raw(method, path, body, execToken ? { 'x-pacosat-executor': execToken } : {});
    let json = null; try { json = JSON.parse(r.text); } catch { /* binario */ }
    return { status: r.status, json, text: r.text };
  };
  try {
    /* Alta real de la e.firma (deja los ficheros en el almacén). */
    const alta = await call('POST', '/api/efirma', { rfc: OWN, minutes: 1440, days: 7,
      direction: 'both', password: 'buena', certificate: CER_REAL_200, key: 'Yg==' });
    assert.equal(alta.status, 200, 'alta de e.firma de la semilla');
    const par = await call('POST', '/api/executor/pair', { nombre: 'Equipo de Paco' });
    assert.equal(par.status, 200);
    const tokenEjecutor = par.json.token;

    /* La foto vieja: un trabajo real cae EN la entrada el 13 nov
       con clase sin-efirma — la fila de la puerta queda así. */
    const enc = await call('POST', '/api/executor/jobs', { rfc: OWN, kind: 'buzon-listar', payload: {} });
    assert.equal(enc.status, 200);
    const claim = await exec('POST', '/api/executor/claim', { limit: 5 }, tokenEjecutor);
    const jobBuzon = claim.json.trabajos.find(t => t.id === enc.json.job.id);
    assert.ok(jobBuzon, 'el ejecutor reclama el trabajo del Buzón');
    await exec('POST', '/api/executor/result', { jobId: jobBuzon.id, status: 'failed',
      result: { steps: [{ at: 1, paso: 'Acceso', detalle: '' }], operations: ['entrar-con-efirma'],
        accesoFallo: true, error: PUERTA_EFIRMA.error, errorKind: 'sin-efirma' } }, tokenEjecutor);
    let status = (await call('GET', '/api/status')).json;
    assert.equal(status.puerta[OWN].ok, false, 'semilla: la puerta consta «no abre»');
    assert.equal(status.puerta[OWN].errorKind, 'sin-efirma', 'semilla: con su clase de e.firma');
    assert.equal(status.puerta[OWN].probada, T_PUERTA, 'semilla: probada el 13 nov');

    /* (c) Servidor: otro trabajo queda EN COLA y Actividad lo
       cuenta como espera, sin pasos que rellenar (done/total 0). */
    const enc2 = await call('POST', '/api/executor/jobs', { rfc: OWN, kind: 'buzon-listar', payload: {} });
    assert.equal(enc2.status, 200);
    const actividad = (await call('GET', '/api/activity')).json;
    const enCola = [...(actividad.paused || []), ...(actividad.running || [])]
      .find(e => e.jobId === enc2.json.job.id);
    assert.ok(enCola, 'M4: Actividad ve el trabajo en cola');
    assert.equal(enCola.state, 'esperando', 'M4: su estado es «esperando», no «en curso»');
    assert.equal(enCola.done, 0); assert.equal(enCola.total, 0);
    assert.match(enCola.detail, /En cola|no responde|emparejado/, 'M4: su detalle nombra la espera del equipo');

    /* El tiempo pasa: sábado última señal, domingo el ejecutor
       vuelve (latido tras ausencia larga) ⇒ re-prueba sola. */
    clock.t = AHORA;
    status = (await call('GET', '/api/status')).json;
    assert.equal(status.ejecutor.enLinea, false, 'antes del latido, el ejecutor consta caído');
    const latido = await exec('POST', '/api/executor/heartbeat', {}, tokenEjecutor);
    assert.equal(latido.status, 200, 'el latido de vuelta responde');
    const overview = (await call('GET', '/api/executor/overview')).json;
    const reprueba = (overview.trabajos || []).find(t => t.kind === 'puerta-probar' && t.estado === 'en-cola');
    assert.ok(reprueba, 'M1 servidor: al volver el ejecutor, la puerta vieja se re-prueba sola (puerta-probar en cola)');
    assert.equal(reprueba.rfc, OWN, 'M1 servidor: la re-prueba es del RFC de la foto vieja');

    /* (6) Disco: el state servido ES el que mandan los umbrales
       (<5 % mal, <15 % vigilar) sobre el porcentaje servido. */
    const disco = status.health.checks.find(c => c.id === 'disco');
    assert.ok(disco, 'salud: el chequeo de disco viene en el estado');
    const pct = Number(/([\d.]+) %|([\d.]+)%/.exec(disco.dato)?.[1] ?? /([\d.]+)%/.exec(disco.dato)?.[1]);
    assert.ok(Number.isFinite(pct), 'salud: el dato del disco trae su porcentaje libre');
    assert.equal(disco.state, pct < 5 ? 'mal' : pct < 15 ? 'vigilar' : 'bien',
      '3.5: el estado del disco sigue los umbrales honestos (ámbar <15 %, rojo <5 %)');
    const serverSrc = read('local-server.mjs');
    assert.ok(serverSrc.includes("freePct < 5 ? 'mal' : freePct < 15 ? 'vigilar'"),
      '3.5: los umbrales viven en el cálculo del servidor');
    console.log('OK 2.0 · servidor — re-prueba al volver, cola como espera y umbrales de disco.');
  } finally { service.close(); rmSync(dir, { recursive: true, force: true }); }
}

console.log('OK 2.0 · Tanda 1 completa.');
