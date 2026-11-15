/* ================================================================
   Ronda 1.31.2 — enmienda de Paco del 13 nov (23:07–23:10):
   menú ⋯ universal en las tarjetas, barra de progreso universal,
   barra de plazo con tramos, frescura «última vez · próxima
   vez», orden por urgencia + filtro «Solo lo que me necesita»,
   punto de salud en el menú, y la pasada iPhone / cualquier
   navegador / web adaptativa. Enmienda de CLIENTE: el servidor
   no gana rutas y el ejecutor no cambia (su sello queda en
   1.31.1 y su bundle no se regenera).

   Qué se prueba aquí:
   1. ESTÁTICAS: versión 1.31.2 coherente; los componentes
      universales existen una sola vez y están cableados en el
      Centro SAT (6 tarjetas), Avisos, Dinero, Pagos y
      Documentos; «Archivar» visible en la fila de Facturas;
      la barra pinta en tarjeta y en Actividad; el plazo con
      tramos en Avisos y Buzón; frescura, orden, filtro y
      puntos del menú presentes; reservas iPhone/navegador en
      el CSS (safe-area, dvh tras vh, campos de 16 px).
   2. HONESTIDAD de la barra: el % solo existe con total
      conocido (aria-valuenow tras la guarda) y la barra de
      plazo devuelve null sin inicio/vencimiento reales.
   3. SERVIDOR: sin rutas nuevas — el invitado sigue fuera de
      archivar y de cancelar trabajos del ejecutor.
   ================================================================ */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { DOMParser } from '@xmldom/xmldom';
import { createPacoSATService } from './local-server.mjs';

const ORIGIN = 'https://pacosat.test';
const KEY = 'f'.repeat(64);
const OWN = 'AAA010101AAA';
const ROOT = import.meta.dirname;
const read = name => readFileSync(join(ROOT, name), 'utf8');

function makeHarness(options = {}) {
  const clock = { t: Date.parse('2026-11-13T16:00:00Z') };
  const service = createPacoSATService({
    dbFile: ':memory:', html: '<html><head><!--PACOSAT_TOKEN--></head><body>prueba</body></html>',
    origin: ORIGIN, proxyKey: KEY, satDocRetryWaitMs: 5,
    makeConnector: () => ({ parser: DOMParser, connector: {
      request: async () => 'req-b', check: async () => ({ status: 'pending', packages: [] }),
      download: async () => { throw new Error('sin paquetes'); } } }),
    makeMailer: () => ({ verify: async () => true, sendMail: async () => ({ messageId: 'm1' }) }),
    now: () => clock.t, ...options });
  let token = '';
  const raw = async (method, path, body, extraHeaders = {}) => {
    const chunks = []; if (body !== undefined) chunks.push(Buffer.from(JSON.stringify(body)));
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
    const r = await raw(method, path, body, { 'x-pacosat-token': token, ...extraHeaders });
    let json = null; try { json = JSON.parse(r.text); } catch { /* binario */ }
    return { status: r.status, json, text: r.text, headers: r.headers };
  };
  return { service, call, raw };
}

/* ===== 1 · ESTÁTICAS ===== */
{
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.version, '1.32.1', 'la versión vigente es 1.32.1 (las enmiendas anteriores viajan dentro, acumulativas)');
  const html = read('Faro-Fiscal.html');
  assert.ok(html.includes('"version":"1.32.1"'), 'el artefacto se sella con la versión vigente');
  const ui = read('ui.part'), sat = read('sat-ui.part'), mon = read('monitor-ui.part'),
    avisos = read('avisos-ui.part'), money = read('money-ui.part'), pagos = read('pagos-ui.part'),
    prob = read('problemas-ui.part'), trib = read('tributario-ui.part'), wf = read('workflows.part'),
    polish = read('polish.part'), style = read('style.part'), layout = read('layout.part');

  /* Componentes universales: una sola definición de cada uno. */
  for (const fn of ['function cardMenu1312', 'function jobProgress1312', 'function plazoBar1312', 'function fmtElapsed1312'])
    assert.equal(html.split(fn).length - 1, 1, fn + ' se define una sola vez en el artefacto');

  /* Menú ⋯ en las seis tarjetas del Centro SAT, con sus
     acciones reales: detalle, destino, historial y cancelar. */
  assert.ok(sat.includes("cardMenu1312('Más opciones de ' + nombre)"), 'la parrilla crea el menú por tarjeta');
  for (const txt of ['Ver el detalle', 'Ver su historial en el Registro', 'Cancelar este trabajo',
    "'Ver en Facturas'", "'Ver en Documentos'", "'Abrir Declaraciones'", "'Abrir el Buzón Tributario'"])
    assert.ok(sat.includes(txt), 'opción real del menú del Centro SAT: ' + txt);
  assert.ok(sat.includes('t.menu._setItems1312(menuItems)'), 'el pintado rellena el menú según el estado');

  /* Menú ⋯ universal fuera del Centro SAT. */
  assert.ok(avisos.includes("cardMenu1312('Más opciones de este aviso')"), 'menú en las tarjetas de Avisos');
  assert.ok(avisos.includes("{ label: 'Archivar', fn: () => avisoArchivar(aviso) }"), 'Archivar de Avisos vive en su menú');
  assert.ok(avisos.includes("{ label: 'Reprogramar', fn: () => avisoReprogramar(aviso) }"), 'Reprogramar de Avisos vive en su menú');
  assert.ok(money.includes("cardMenu1312('Más opciones de este saldo')"), 'menú en las filas de Dinero');
  assert.ok(money.includes("{ label: 'Ver la factura', fn: () => invoiceDetail(item.row) }"), 'Dinero: ver la factura desde el menú');
  assert.ok(pagos.includes("cardMenu1312('Más opciones de esta preparación')"), 'menú en el historial de Pagos');
  assert.ok(pagos.includes("'Repetir esta preparación'"), 'Pagos: repetir vive en su menú');
  assert.ok(prob.includes("cardMenu1312('Más opciones de ' + nombre)"), 'menú en las tarjetas de documento');
  assert.ok(prob.includes("'Ver las versiones en Documentos'"), 'Documentos: ver versiones desde el menú');

  /* Facturas: «Archivar» en el ⋯ de la fila (re-baseline
     1.32.1, F3 — la misma doctrina que Avisos arriba: la cara
     lleva Ver CFDI + PDF + XML y lo secundario vive en el
     menú; invoiceActions es el constructor de la lista y del
     detalle). */
  assert.ok(wf.includes("{ label: 'Archivar', fn: () => cfdiArchivar1311(row)"), 'Archivar de Facturas vive en su menú ⋯');
  assert.ok(wf.includes("cardMenu1312('Más opciones de esta factura')"), 'la fila de Facturas tiene su menú ⋯');

  /* Barra de progreso: estados con progreso real y pintado en
     la tarjeta y en la Actividad universal. */
  assert.ok(sat.includes('salida.declaraciones.progreso'), 'Declaraciones expone su progreso');
  assert.ok(sat.includes('salida.buzon.progreso'), 'Buzón expone su progreso');
  assert.ok(sat.includes('progreso: { fase: progreso.step'), 'Constancia/Opinión exponen fase e inicio reales');
  assert.ok(sat.includes('t.progresoSlot.replaceChildren(jobProgress1312(e.progreso))'), 'la tarjeta pinta su barra');
  assert.ok(mon.includes('jobsBox.append(jobProgress1312({'), 'la Actividad pinta la barra de todo trabajo vivo');
  assert.ok(mon.includes('desde: entry.since || 0, done: entry.done, total: entry.total'), 'la Actividad alimenta la barra con since/done/total del servidor');

  /* Barra de plazo con tramos: Avisos y Buzón Tributario. */
  assert.ok(avisos.includes('plazoBar1312(aviso.creado, aviso.vence)'), 'Avisos pinta su barra de plazo');
  assert.ok(trib.includes("relleno.classList.add(diasQuedan <= 1 ? 'plazo-bad' : diasQuedan <= 3 ? 'plazo-warn' : 'plazo-ok')"),
    'el Buzón tiñe su barra por días que quedan');
  assert.ok(polish.includes('.job-bar-fill.plazo-ok') && polish.includes('.job-bar-fill.plazo-bad'), 'los tramos tienen color en el CSS');

  /* Frescura, orden por urgencia y filtro. */
  assert.ok(sat.includes("'Próxima vez: ' + e.proxima"), 'la frescura pinta «última vez · próxima vez»');
  assert.ok(sat.includes('estados.cfdi.proxima = localDateTime(profile.nextRun)'), 'próxima vez de CFDI desde la revisión automática');
  assert.ok(sat.includes('if (trib?.proximaAuto) estados.buzon.proxima'), 'próxima vez del Buzón desde su consulta automática');
  assert.ok(sat.includes('t.card.style.order = String(rango1312)'), 'orden por urgencia sin mover la DOM');
  assert.ok(sat.includes('Solo lo que me necesita'), 'filtro en el Centro SAT');
  assert.ok(prob.includes('Solo lo que me necesita'), 'filtro en Hoy');
  assert.ok(prob.includes('new MutationObserver(aplicarOrdenCmd1312)'), 'el orden de Hoy se reaplica al repintar');
  assert.ok(prob.includes("typeof MutationObserver !== 'undefined'"), 'el observador va guardado: reserva entre navegadores');
  assert.ok(polish.includes('.cmd-grid.solo-necesita .cmd-card[data-level="ok"]'), 'el filtro de Hoy oculta las tarjetas al día');

  /* Punto de salud del menú: anclas en el layout y pintado
     desde conteos veraces del estado global. */
  assert.ok(layout.includes('data-nav-dot="buzon"') && layout.includes('data-nav-dot="sat"'), 'el menú lateral trae los puntos');
  assert.ok(mon.includes('function paintNavDots1312()'), 'el pintado de puntos existe');
  assert.ok(mon.includes('satData?.buzonUnread') && mon.includes('satData?.tributario'), 'los puntos salen de conteos reales');

  /* iPhone / cualquier navegador / adaptativa (por código):
     área segura en la barra inferior y en los avisos, altura
     dvh con reserva vh, campos de 16 px en móvil y objetivos
     de 44 px en el menú. */
  assert.ok(polish.includes('calc(6px + env(safe-area-inset-bottom))'), 'la barra inferior respeta el área segura');
  assert.ok(polish.includes('.toasts{bottom:calc(64px + env(safe-area-inset-bottom))}'), 'los avisos flotantes respetan el área segura en móvil');
  assert.ok(polish.includes('.frame{min-height:100vh;min-height:100dvh}'), 'dvh con reserva vh para el marco');
  assert.ok(polish.includes('input,select,textarea{font-size:16px}'), 'campos de 16 px en móvil: iOS no hace zoom');
  assert.ok(polish.includes('.card-menu-btn{min-width:44px;min-height:44px'), 'el botón ⋯ es de 44 px');
  assert.ok(polish.includes('.card-menu-item{width:100%;min-height:44px'), 'las opciones del menú son de 44 px');
  assert.ok(polish.includes('max-width:calc(100vw - 24px)'), 'el menú no se sale de la pantalla');
  assert.ok(polish.includes('.bottombar button{min-height:48px') || style.includes('.bottombar button{min-height:48px') ||
    read('polish.part').includes('min-height:48px'), 'la barra inferior mantiene sus 48 px');
  console.log('OK 1.31.2 · estáticas — componentes universales, plazo, frescura, orden, puntos e iPhone por código.');
}

/* ===== 2 · HONESTIDAD DE LAS BARRAS ===== */
{
  const ui = read('ui.part');
  assert.ok(ui.includes("if (conocido) wrap.setAttribute('aria-valuenow'"), 'el % solo se declara con total conocido');
  assert.ok(ui.includes("' job-bar-ind'"), 'sin total, la barra va indeterminada');
  assert.ok(ui.includes('if (!Number.isFinite(inicio) || !Number.isFinite(vence) || vence <= inicio) return null'),
    'la barra de plazo no se pinta sin inicio y vencimiento reales');
  assert.ok(ui.includes("diasQuedan <= 1 ? 'plazo-bad' : diasQuedan <= 3 ? 'plazo-warn' : 'plazo-ok'"),
    'los tramos del plazo son por días que quedan');
  console.log('OK 1.31.2 · honestidad — sin % inventado y sin plazos derivados.');
}

/* ===== 3 · SERVIDOR: sin rutas nuevas, el invitado fuera ===== */
{
  const h = makeHarness();
  const open = await h.call('POST', '/api/unlock', { rfc: OWN, minutes: 1440, days: 7,
    direction: 'both', password: 'simulated', certificate: 'YQ==', key: 'Yg==' });
  assert.equal(open.status, 200);
  const UUID = 'AAAAAAAA-2222-4222-8222-222222222222';
  const seed = await h.call('POST', '/api/storage', { batch: { invoices: [
    { id: UUID, date: '2026-02-03T12:00:00', kind: 'I', total: '1000.00',
      from: { rfc: OWN, name: 'Prueba' }, to: { rfc: 'XAXX010101000', name: 'Cliente' } }] } });
  assert.equal(seed.status, 200);
  await h.call('POST', '/api/guest/config', { password: 'invitado-1312', enabled: true, rfcs: [OWN] });
  const login = await h.call('POST', '/api/guest/login', { password: 'invitado-1312' });
  assert.ok(login.json?.token, 'sesión de invitado emitida');
  const guestHeaders = { 'x-pacosat-token': login.json.token };
  const gArch = await h.call('POST', '/api/cfdi/archivar', { uuid: UUID, archivar: true }, guestHeaders);
  assert.notEqual(gArch.status, 200, 'el invitado NO puede archivar (el menú no le da poderes nuevos)');
  const gCancel = await h.call('POST', '/api/executor/cancel', { jobId: 'inexistente' }, guestHeaders);
  assert.notEqual(gCancel.status, 200, 'el invitado NO puede cancelar trabajos del ejecutor');
  const lista = await h.call('GET', '/api/cfdi/archivados');
  assert.ok(!(lista.json.ids || []).includes(UUID), 'el intento del invitado no archivó nada');
  await h.service.close();
  console.log('OK 1.31.2 · servidor — el invitado sigue fuera de archivar y cancelar.');
}
console.log('Ronda 1.31.2: batería completa en verde.');
