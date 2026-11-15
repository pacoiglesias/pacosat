/* ================================================================
   Ronda 1.32.0 — la API vendible (orden de Paco, 13 nov 23:44):
   puerta /api/v1 de SOLO LECTURA sobre el cálculo reconciliado
   único, llaves con el patrón del ejecutor (huella SHA-256, se
   enseñan una vez, pausa reversible y revocación inmediata),
   alcances (lectura / lectura-resumen), llave limitada a un RFC,
   muros (sin sesión, sin rutas de administración ni del
   ejecutor, el invitado no gestiona llaves), límite de ritmo con
   su 429, auditoría en el Registro sin la llave en claro y
   paginación. Las cifras se contrastan contra el criterio de la
   pantalla Totales calculado a mano sobre la semilla.
   ================================================================ */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { DOMParser } from '@xmldom/xmldom';
import { createPacoSATService } from './local-server.mjs';

const ORIGIN = 'https://pacosat.test';
const KEY = 'f'.repeat(64);
const OWN = 'MFI6212158B4';
const OTHER = 'AAA010101AAA';
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
  const api = async (llave, path, method = 'GET') => {
    const r = await raw(method, path, undefined,
      llave ? { authorization: 'Bearer ' + llave } : {});
    let json = null; try { json = JSON.parse(r.text); } catch { /* binario */ }
    return { status: r.status, json, text: r.text };
  };
  return { service, call, raw, api };
}

const h = makeHarness();
for (const rfc of [OWN, OTHER]) {
  const open = await h.call('POST', '/api/unlock', { rfc, minutes: 1440, days: 7,
    direction: 'both', password: 'simulated', certificate: 'YQ==', key: 'Yg==' });
  assert.equal(open.status, 200, 'unlock ' + rfc);
}
await h.call('POST', '/api/storage', { batch: { people: [
  { id: OWN, name: 'Mano Fil, S.A.' }, { id: OTHER, name: 'Otra, S.A.' }] } });
const U = n => 'BBBBBBBB-3333-4333-8333-33333333333' + n;
await h.call('POST', '/api/storage', { batch: { invoices: [
  { id: U(1), date: '2026-10-05T12:00:00', kind: 'I', total: '1000.00', folio: 'A1',
    from: { rfc: OWN, name: 'Mano Fil, S.A.' }, to: { rfc: 'XAXX010101000', name: 'Cliente' } },
  { id: U(2), date: '2026-10-07T12:00:00', kind: 'I', total: '2000.50', folio: 'B7',
    from: { rfc: 'PROV010101AAA', name: 'Proveedor' }, to: { rfc: OWN, name: 'Mano Fil, S.A.' } },
  { id: U(3), date: '2026-10-09T12:00:00', kind: 'P', total: '0.00',
    from: { rfc: 'PROV010101AAA', name: 'Proveedor' }, to: { rfc: OWN, name: 'Mano Fil, S.A.' } },
  { id: U(4), date: '2026-10-10T12:00:00', kind: 'N', total: '500.00',
    from: { rfc: OWN, name: 'Mano Fil, S.A.' }, to: { rfc: 'EMPLE010101AA', name: 'Empleado' } },
  { id: U(5), date: '2026-10-11T12:00:00', kind: 'I', total: '700.00', state: 'Cancelado',
    from: { rfc: OWN, name: 'Mano Fil, S.A.' }, to: { rfc: 'XAXX010101000', name: 'Cliente' } },
  { id: U(6), date: '2026-10-12T12:00:00', kind: 'I', total: '100.00', currency: 'USD',
    from: { rfc: 'PROV010101AAA', name: 'Proveedor' }, to: { rfc: OWN, name: 'Mano Fil, S.A.' } },
  { id: U(7), date: '2026-10-06T12:00:00', kind: 'I', total: '9999.00',
    from: { rfc: 'PROV010101AAA', name: 'Proveedor' }, to: { rfc: OTHER, name: 'Otra, S.A.' } }] } });

/* ===== 1 · Llaves: crear, enseñar una vez, listar sin secretos ===== */
const c1 = await h.call('POST', '/api/apikeys', { nombre: 'Excel de Paco', alcance: 'lectura', rfc: '' });
assert.equal(c1.status, 200);
const K1 = c1.json.llave;
assert.ok(K1.startsWith('psat_'), 'la llave nace con su prefijo');
const c2 = await h.call('POST', '/api/apikeys', { nombre: 'Resumen IA', alcance: 'lectura-resumen', rfc: '' });
const K2 = c2.json.llave;
const c3 = await h.call('POST', '/api/apikeys', { nombre: 'Solo Mano Fil', alcance: 'lectura', rfc: OWN });
const K3 = c3.json.llave;
const malAlcance = await h.call('POST', '/api/apikeys', { nombre: 'X', alcance: 'escritura', rfc: '' });
assert.notEqual(malAlcance.status, 200, 'no existe alcance de escritura');
const lista0 = await h.call('GET', '/api/apikeys');
assert.equal(lista0.json.llaves.length, 3, 'las tres llaves se listan');
assert.ok(!JSON.stringify(lista0.json).includes(K1), 'la lista NUNCA enseña la llave en claro');
assert.ok(!JSON.stringify(lista0.json).includes('huella'), 'la lista no enseña ni la huella');
const vistaK1 = lista0.json.llaves.find(k => k.nombre === 'Excel de Paco');
assert.deepEqual({ alcance: vistaK1.alcance, rfc: vistaK1.rfc, estado: vistaK1.estado,
  llamadasHoy: vistaK1.llamadasHoy, llamadasTotal: vistaK1.llamadasTotal },
  { alcance: 'lectura', rfc: '', estado: 'activa', llamadasHoy: 0, llamadasTotal: 0 },
  'la vista del panel nace con sus contadores a cero');
console.log('OK 1.32.0 · llaves — crear, una sola enseñanza, lista sin secretos.');

/* ===== 2 · Muros: sin llave, llave falsa, llave como sesión ===== */
{
  const sin = await h.api(null, '/api/v1/estado');
  assert.equal(sin.status, 401, 'sin llave: 401');
  assert.equal(sin.json.error.codigo, 'llave-invalida');
  const falsa = await h.api('psat_' + '0'.repeat(48), '/api/v1/estado');
  assert.equal(falsa.status, 401, 'llave falsa: 401');
  const sesionConLlave = await h.raw('GET', '/api/status', undefined,
    { 'x-pacosat-token': K1, 'x-pacosat-proxy': KEY });
  assert.notEqual(sesionConLlave.status, 200, 'la llave de API NO es una sesión de la app');
  const ejecutor = await h.raw('GET', '/api/executor/overview', undefined,
    { authorization: 'Bearer ' + K1, 'x-pacosat-proxy': KEY });
  assert.notEqual(ejecutor.status, 200, 'la llave de API no abre las rutas del ejecutor');
  const post = await h.api(K1, '/api/v1/totales?rfc=' + OWN, 'POST');
  assert.equal(post.status, 405, 'la API es de solo lectura: POST da 405');
  console.log('OK 1.32.0 · muros — 401 sin llave y la llave no es sesión ni abre el ejecutor.');
}

/* ===== 3 · Cifras: idénticas al criterio de la pantalla ===== */
let llamadasK1 = 0, llamadasK2 = 0, llamadasK3 = 0;
{
  const estado = await h.api(K1, '/api/v1/estado'); llamadasK1++;
  assert.equal(estado.status, 200);
  assert.equal(estado.json.datos.version, JSON.parse(read('package.json')).version, 'el estado declara la versión');
  const tot = await h.api(K1, '/api/v1/totales?rfc=' + OWN + '&desde=2026-10&hasta=2026-10'); llamadasK1++;
  assert.equal(tot.status, 200);
  assert.deepEqual(tot.json.datos.meses, [{ mes: '2026-10', recibidas: 1, recibidasImporte: '2000.50',
    emitidas: 1, emitidasImporte: '1000.00', complementos: 1, nomina: 1, canceladas: 1,
    otrasDivisas: { USD: { recibidas: 1, emitidas: 0 } } }],
    'totales de octubre: el criterio de Totales, al centavo (P y N aparte, cancelada fuera, USD sin sumar)');
  assert.equal(tot.json.datos.totales.recibidasImporte, '2000.50');
  const sinRfc = await h.api(K1, '/api/v1/totales'); llamadasK1++;
  assert.equal(sinRfc.status, 400, 'sin RFC no hay lectura mezclada');
  assert.equal(sinRfc.json.error.codigo, 'falta-rfc');
  const otro = await h.api(K1, '/api/v1/totales?rfc=' + OTHER + '&desde=2026-10&hasta=2026-10'); llamadasK1++;
  assert.equal(otro.json.datos.totales.recibidasImporte, '9999.00', 'cada RFC lee SOLO lo suyo');
  console.log('OK 1.32.0 · cifras — totales por RFC, al centavo, sin mezclar.');
}

/* ===== 4 · CFDI: lista paginada y detalle ===== */
{
  const lista = await h.api(K1, '/api/v1/cfdi?rfc=' + OWN + '&porPagina=2&pagina=1'); llamadasK1++;
  assert.equal(lista.status, 200);
  assert.equal(lista.json.meta.total, 6, 'seis comprobantes de OWN (el de OTHER no se cuela)');
  assert.equal(lista.json.meta.paginas, 3);
  assert.equal(lista.json.datos.length, 2);
  const pagina3 = await h.api(K1, '/api/v1/cfdi?rfc=' + OWN + '&porPagina=2&pagina=3'); llamadasK1++;
  assert.equal(pagina3.json.datos.length, 2, 'la paginación corta sin perder ni repetir de más');
  const soloP = await h.api(K1, '/api/v1/cfdi?rfc=' + OWN + '&tipo=P'); llamadasK1++;
  assert.equal(soloP.json.meta.total, 1, 'el filtro por tipo funciona');
  const detalle = await h.api(K1, '/api/v1/cfdi/' + U(2) + '?rfc=' + OWN); llamadasK1++;
  assert.equal(detalle.status, 200);
  assert.equal(detalle.json.datos.direccion, 'recibida');
  assert.equal(detalle.json.datos.total, '2000.50');
  assert.equal(detalle.json.datos.estado, 'Vigente');
  const ajeno = await h.api(K1, '/api/v1/cfdi/' + U(7) + '?rfc=' + OWN); llamadasK1++;
  assert.equal(ajeno.status, 404, 'el detalle de otro RFC no existe para esta lectura');
  console.log('OK 1.32.0 · CFDI — paginación, filtros y detalle por RFC.');
}

/* ===== 5 · Alcances y llave limitada ===== */
{
  const totRes = await h.api(K2, '/api/v1/totales?rfc=' + OWN); llamadasK2++;
  assert.equal(totRes.status, 200, 'la llave de resúmenes SÍ lee totales');
  const cfdiRes = await h.api(K2, '/api/v1/cfdi?rfc=' + OWN); llamadasK2++;
  assert.equal(cfdiRes.status, 403, 'la llave de resúmenes NO lee CFDI');
  assert.equal(cfdiRes.json.error.codigo, 'alcance-insuficiente');
  const regRes = await h.api(K2, '/api/v1/registro'); llamadasK2++;
  assert.equal(regRes.status, 403, 'la llave de resúmenes NO lee el Registro en detalle');
  const aviRes = await h.api(K2, '/api/v1/avisos?rfc=' + OWN); llamadasK2++;
  assert.equal(aviRes.status, 200, 'la llave de resúmenes lee avisos en forma de resumen');
  assert.ok(!JSON.stringify(aviRes.json).includes('detalle'), 'el resumen no lleva el detalle de los avisos');
  const limSin = await h.api(K3, '/api/v1/totales?desde=2026-10&hasta=2026-10'); llamadasK3++;
  assert.equal(limSin.status, 200, 'la llave limitada lee su RFC sin tener que decirlo');
  assert.equal(limSin.json.datos.totales.recibidasImporte, '2000.50');
  const limFuera = await h.api(K3, '/api/v1/totales?rfc=' + OTHER); llamadasK3++;
  assert.equal(limFuera.status, 403, 'la llave limitada NO lee otro RFC');
  assert.equal(limFuera.json.error.codigo, 'fuera-de-su-rfc');
  console.log('OK 1.32.0 · alcances — resúmenes sin CFDI y llave atada a su RFC.');
}

/* ===== 6 · Contadores del panel y auditoría en el Registro ===== */
{
  const buzon = await h.api(K1, '/api/v1/buzon/resumen?rfc=' + OWN); llamadasK1++;
  assert.equal(buzon.status, 200);
  assert.equal(buzon.json.datos.sinAbrir, 0, 'el resumen del Buzón son conteos, sin contenido');
  assert.ok(!('notificaciones' in buzon.json.datos), 'el Buzón NO entrega notificaciones por la API');
  const docs = await h.api(K1, '/api/v1/documentos?rfc=' + OWN); llamadasK1++;
  assert.equal(docs.status, 200);
  const registro = await h.api(K1, '/api/v1/registro?porPagina=200'); llamadasK1++;
  const eventosApi = registro.json.datos.filter(item => String(item.texto).startsWith('API ·'));
  const panel = await h.call('GET', '/api/apikeys');
  const sumaPanel = panel.json.llaves.reduce((acc, k) => acc + k.llamadasTotal, 0);
  const vista = panel.json.llaves.find(k => k.nombre === 'Excel de Paco');
  assert.equal(vista.llamadasTotal, llamadasK1, 'el contador de la llave cuadra con sus llamadas');
  assert.equal(vista.llamadasHoy, llamadasK1, 'hoy y total coinciden en la semilla del mismo día');
  /* La foto del Registro se toma ANTES de auditar la propia
     lectura que la pide: por eso sus eventos «API ·» son el
     libro menos esa una — y con ella, cuadran exactos. */
  assert.equal(eventosApi.length, sumaPanel - 1,
    'los eventos «API ·» del Registro cuadran con el libro de llamadas');
  assert.ok(!JSON.stringify(registro.json).includes(K1), 'el Registro jamás guarda la llave en claro');
  const ultima = panel.json.llamadas[0];
  assert.ok(ultima && ultima.llave === 'Excel de Paco' && ultima.recurso === '/api/v1/registro',
    'el panel enseña las últimas llamadas con su llave, recurso y resultado');
  console.log('OK 1.32.0 · panel y Registro — contadores que cuadran y ni rastro de la llave.');
}

/* ===== 7 · Pausa, reactivación y revocación inmediatas ===== */
{
  const idK1 = (await h.call('GET', '/api/apikeys')).json.llaves.find(k => k.nombre === 'Excel de Paco').id;
  await h.call('POST', '/api/apikeys/estado', { id: idK1, estado: 'en-pausa' });
  const enPausa = await h.api(K1, '/api/v1/estado');
  assert.equal(enPausa.status, 403, 'pausar bloquea al instante');
  assert.equal(enPausa.json.error.codigo, 'llave-en-pausa');
  await h.call('POST', '/api/apikeys/estado', { id: idK1, estado: 'activa' });
  const reactivada = await h.api(K1, '/api/v1/estado');
  assert.equal(reactivada.status, 200, 'reactivar restaura la llave');
  await h.call('POST', '/api/apikeys/estado', { id: idK1, estado: 'revocada' });
  const revocada = await h.api(K1, '/api/v1/estado');
  assert.equal(revocada.status, 403, 'revocar apaga la llave al instante');
  assert.equal(revocada.json.error.codigo, 'llave-revocada');
  console.log('OK 1.32.0 · estados — pausa reversible y revocación inmediata.');
}

/* ===== 8 · El invitado no gestiona llaves ===== */
{
  await h.call('POST', '/api/guest/config', { password: 'invitado-1320', enabled: true, rfcs: [OWN] });
  const login = await h.call('POST', '/api/guest/login', { password: 'invitado-1320' });
  const guestHeaders = { 'x-pacosat-token': login.json.token };
  const gLista = await h.call('GET', '/api/apikeys', undefined, guestHeaders);
  assert.notEqual(gLista.status, 200, 'el invitado no ve las llaves');
  const gCrea = await h.call('POST', '/api/apikeys', { nombre: 'Del invitado', alcance: 'lectura', rfc: '' }, guestHeaders);
  assert.notEqual(gCrea.status, 200, 'el invitado no crea llaves');
  console.log('OK 1.32.0 · invitado — fuera de la gestión de llaves.');
}

/* ===== 9 · Ritmo: el 429 honesto ===== */
{
  let ultimo = null;
  for (let i = 0; i < 61; i++) ultimo = await h.api(K3, '/api/v1/estado');
  assert.equal(ultimo.status, 429, 'la llamada 61 en un minuto recibe su 429');
  assert.equal(ultimo.json.error.codigo, 'limite-excedido');
  console.log('OK 1.32.0 · ritmo — 60 por minuto y el 429 con su código.');
}

/* ===== 10 · El panel en el artefacto ===== */
{
  const html = read('Faro-Fiscal.html');
  const settings = read('settings-ui.part');
  const ui = read('ui.part');
  assert.ok(html.includes('apiPanelSection1320'), 'el panel de la API viaja en el artefacto');
  assert.ok(html.includes('API de PacoSAT · Qué es y cómo se usa'), 'la documentación de la API viaja en el panel');
  assert.ok(ui.includes("['api', 'API']"), 'Ajustes tiene su pestaña «API»');
  assert.ok(ui.includes("ajustesSection === 'api'"), 'la pestaña pinta el panel de la API');
  assert.ok(settings.includes("satApi('apikeys/estado'"), 'el panel pausa/reactiva/revoca por la ruta de gestión');
  assert.ok(settings.includes("cardMenu1312('Más opciones de la llave '"), 'cada llave lleva su menú ⋯');
  assert.ok(settings.includes('Web.Contents'), 'la documentación trae la fórmula de Power Query para Excel');
  /* El constructor n() de la casa NO acepta hijos por argumento:
     los hijos se adjuntan con append. Esta guarda existe porque
     la primera versión del panel lo usó mal y las tarjetas
     pintaban vacías (cazado en las capturas de la ronda). */
  for (const malo of ["api-ejemplo-head', [", "'actions', [copiar, cerrar]", "'tramite-head', [", "'api-key-meta', ["])
    assert.ok(!settings.includes(malo), 'sin hijos por argumento en n(): ' + malo);
  console.log('OK 1.32.0 · panel — documentación, pestaña, menú de llave y construcción correcta.');
}

await h.service.close();
console.log('Ronda 1.32.0: batería completa en verde.');
