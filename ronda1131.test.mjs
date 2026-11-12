import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPacoSATService, PACOSAT_HTTP_TIMEOUTS } from './local-server.mjs';
import { createMonitor } from './sat-monitor.mjs';
import { DatabaseSync } from 'node:sqlite';
import { problemSpec, downloadShortcutRange, downloadSummaryText, crc32 } from './xml-core.mjs';

/* Ronda 1.13.1 — tres piezas pedidas por Paco el 10 nov 2026 y un
   defecto confirmado por él:
   (A) «Revisar ahora» por factura: POST /api/monitor/check-one
   fuerza la consulta de UN UUID con la función de producción de
   la tanda y sus mismas reglas de guardado.
   (B) Listas con significado y cifras: listsOverview expone por
   contraparte las cifras calculadas de los CFDI guardados
   (conteo, importe, primera/última fecha por dirección y saldo
   vivo por cobrar de Dinero) y problemSpec('lista', …) genera la
   explicación por (lista, situación, rol).
   (C) Acciones directas de SAT: satQuickActions abre la pantalla
   con selector de RFC y los cuatro verbos exactos; Constancia y
   Opinión disparan /api/satdocs/run con su kind (el servidor ya
   lo aceptaba: aquí se fija el contrato), Descargar CFDI abre el
   diálogo de periodo con el RFC elegido y Declaraciones salta a
   su panel.
   (D) Impresión del comprobante: cfdiPrint cierra el diálogo
   modal antes de imprimir (el papel era una captura del diálogo)
   y la plantilla lleva bloques de emisor/receptor, sellos en
   letra pequeña y la línea de estado separada del cuerpo fiscal. */

const CER = 'MIIDUzCCAjugAwIBAgIUH2WzMvVXT5BC2dNEzTaqRKJcZVUwDQYJKoZIhvcNAQELBQAwOTEgMB4GA1UEAwwXRU1QUkVTQSBQUlVFQkEgU0EgREUgQ1YxFTATBgNVBAUTDE1GSTYyMTIxNThCNDAeFw0yNjExMDkwNTA0MzVaFw0zNjExMDYwNTA0MzVaMDkxIDAeBgNVBAMMF0VNUFJFU0EgUFJVRUJBIFNBIERFIENWMRUwEwYDVQQFEwxNRkk2MjEyMTU4QjQwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQDJv/UPUgh/H1XwYFWUj2DV8HVVL95Z3LSi7P5yC1m2hcXlGVyvrc9EwIxTYuKVndt3mZyafViTg7Zng3wPs/bkZIhWcXTBkFPy8/4OZF4HKhgQTByszYEqBo4hr6o98FqS638cXcIkAzKFaIhpIJUpFMmUyKlSLgdWRcW7gm4SF2TaWYWi5CBok6gSoWsbmvEdFa0BbSCTxUUOxxWeoqhaMeYgN+PYpLWkl8Iq7VZJ+JeH0LMvbKg6Bhug0KOnC3/yNSBDIrg+A1rOysN8JJOU76zPuqj6aki7+oAEZIpGcu6h3cri7S8qq3zYupFdmZHwRySGDRci3ZpyCqjlFB97AgMBAAGjUzBRMB0GA1UdDgQWBBQYRYXN6Lv4Ke+TNpNWj7H1tqkEpTAfBgNVHSMEGDAWgBQYRYXN6Lv4Ke+TNpNWj7H1tqkEpTAPBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUAA4IBAQC8EwF8xC42pm/jFhTaO/gp2LDiSfz5cIJyZe9XsbczupYA9moD0Y9qMdEFAqgSVmFqJNgE675d5meRJdvRariROlpN3BZfcvPDEqHnwjqzjgHBt9e+GYb8UzdvkWiJuN7hoWgs2m+AJdPnsIWopKVI8enqng9Un7LbzCkACmJuG03Y+N7uuT/jIE+hNBHLJI6S9CGGs3hr8S4eZ2ijQeYyrWtLoeadLFsp4QqDb/JqXGtrIWFH9p3TNDEvyyVsYUBXSBIxX9zf/EYQ9NMLqIVSJ5hR/GjmDPf0plFteYQZEhRohrXnAox6clkDaIqTJkzWHhY4PHCPn+sJAh+Jzz8Y';
const KEY = 'MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDJv/UPUgh/H1XwYFWUj2DV8HVVL95Z3LSi7P5yC1m2hcXlGVyvrc9EwIxTYuKVndt3mZyafViTg7Zng3wPs/bkZIhWcXTBkFPy8/4OZF4HKhgQTByszYEqBo4hr6o98FqS638cXcIkAzKFaIhpIJUpFMmUyKlSLgdWRcW7gm4SF2TaWYWi5CBok6gSoWsbmvEdFa0BbSCTxUUOxxWeoqhaMeYgN+PYpLWkl8Iq7VZJ+JeH0LMvbKg6Bhug0KOnC3/yNSBDIrg+A1rOysN8JJOU76zPuqj6aki7+oAEZIpGcu6h3cri7S8qq3zYupFdmZHwRySGDRci3ZpyCqjlFB97AgMBAAECggEADYRMYA86yCrqdZU8C/ItO+LajES4QiSyKjD0Uoy7ISpGRMqrCzl7Elv6Kti3CJd6bZa/nMQldpX+VwzCokSy7RYP4lwYmqKs/9vkBhp9suou5uH1O931jOzCggmZv4DxIzh0RuDAkewa6urtf2mc72iCoZ1uEWD0bI3L09EccclmqMihSGfwiihOwAWo2/1qM3ZOKraGe/AT2eUrGwfKqJKWIAzp6ec6cWHt+YtmQY+JtcpQcNVjPewosVD3xRV60knDaFKwCZeRmYQ9jZhFAoOA57nkRshPhejKV8iNvA1tdWWrqpRL/UjtpIs3y2jBfFtGNFL0oZMpWKhQSRFCzQKBgQDqRQ8hFqINPgwKorrZ676TkPPhQ2Ag2anCq0YCK84qPfRArhnwEVYbrzw9TEyF0RRn6DE22S+QzbGgjTDTcSbuBEY2jKlwgXZjGRa/NEN+rl+JWBtw02vk1l5EDBPCjXdxP7r7opL57yUU7UamnW/MBMhxG9tdSI6u6yEpi0vTBwKBgQDcdq8Wn5oRQYKYuXcZIbxEnsTuP0TQFev8Kplb91wB8SPxQt6glKmQQRJdztXX1JrOJoQUUy2Rlt43LxXh1aOWOm6TdTAeI+gOKUn/c4KYVq3yKw1sD61SNV7Oh8lZrb1laVavou0KbuKi4C3ifkmI/IYVFiaD0sKoGZ98GjWu7QKBgQDG3A5GqR6wHP49vPrdZzbjroTGr9mWqQ1oWNjZmPOted+vU9pipWSxpWN+KRk/8kXfGgNEqsGsql5gidlrcr54BprPTUG7ZbnnzvE3JxcwHrasMGVCtcT9gFaObq4LVOiR8mY3mj4m+LBCflOdtUCkL18yXFIuchvkMWV6DWs02wKBgEyOkkKC7ddsLlOmo+sAQgZ6M9yf799qnWYVzOeYwESUXmzbUb/ln/ROBHi66JtoYtGPonIEaGCUSVpUaX7g10vFwrxGB42P3nd8cwvYKtOH1iOwO5r43rEbg26ozIztvkVHDSk0pKfo1Z7FxmlOfW6qck1EQd+pApupOi64U0gJAoGBAJrkBt1d6wppq6p+RvwvIEm63/DuF80Cx/kG7YMEfJ3GQUQYmOxgIRniLZEitYSV2w3prwb/oBBu8TBsmM0nzFj/0SylLBWylVOKTtg8fxl7nEaJLJhjCyJAHtSgwtFnwLLNb2kBj2tR0BR2cT9H4wzwI0yNk0I7iEc6qsZ6FzGy';

const origin = 'http://127.0.0.1:43733';
let time = Date.parse('2026-11-10T21:00:00Z');

function harness(service, proxyKey = '') {
  let token;
  const call = async (path, data, options = {}) => {
    const headers = { host: new URL(origin).host, origin, 'x-pacosat-token': token,
      ...(proxyKey ? { 'x-pacosat-proxy': proxyKey } : {}), ...options };
    const req = Object.assign(Readable.from(data === undefined ? [] : [Buffer.from(JSON.stringify(data))]), {
      url: path, method: data === undefined ? 'GET' : 'POST', headers });
    let response;
    const res = { setHeader() {}, writeHead(status) { this.status = status; this.headersSent = true; },
      end(content) { response = new Response(content, { status: this.status }); } };
    await service.handle(req, res);
    return response;
  };
  return { call, async login() {
    const page = await (await call('/')).text();
    token = page.match(/meta name="pacosat-token" content="([^"]+)"/)?.[1];
    assert.ok(token, 'token del servicio de juguete');
  }, setToken(value) { token = value; }, getToken() { return token; } };
}

/* ===== A · check-one ===== */
{
  const behaviour = new Map();
  const service = createPacoSATService({ dbFile: ':memory:', html: '<!--PACOSAT_TOKEN-->', origin, now: () => time,
    monitorOptions: { checkSat: async item => { const b = behaviour.get(item.id); if (b instanceof Error) throw b; return b; },
      refreshEfos: async () => new Map() } });
  const { call, login, setToken, getToken } = harness(service);
  try {
    await login();
    const U1 = '11111111-1111-4111-8111-111111111101';
    const U2 = '11111111-1111-4111-8111-111111111102';
    const U3 = '11111111-1111-4111-8111-111111111103';
    const rec = id => ({ id, emitter: 'AAA010101AAA', receiver: 'BBB010101BBB', total: '1160.00', seal: '' });
    let res = await call('/api/monitor', { records: [rec(U1), rec(U2), rec(U3)], ids: [] });
    assert.equal(res.status, 200);
    behaviour.set(U1, { state: 'Vigente', code: 'S', cancellation: '', cancelable: '', efos: '' });
    behaviour.set(U2, { state: 'Cancelado', code: 'S', cancellation: 'Cancelado con aceptación', cancelable: '', efos: '' });
    behaviour.set(U3, { state: 'Vigente', code: 'S', cancellation: '', cancelable: '', efos: '' });
    /* Existente → Vigente, guardado como la tanda (checked=ahora). */
    res = await call('/api/monitor/check-one', { uuid: U1 });
    assert.equal(res.status, 200);
    let body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.sat.state, 'Vigente');
    assert.equal(body.checked, time);
    assert.equal(body.error, '');
    /* La fila sale de la cola: el resumen ya no la cuenta sin
       revisar y check-now no la re-encola. */
    let summary = await (await call('/api/monitor/summary', { ids: [U1, U2, U3] })).json();
    assert.equal(summary.counts.vigentes, 1);
    assert.equal(summary.counts.sinRevisar, 2);
    res = await call('/api/monitor/check-now', { ids: [U1] });
    assert.equal((await res.json()).queued, 0, 'la revisada a mano no vuelve a la cola');
    /* Existente → Cancelado, con su tipo de cancelación. */
    res = await call('/api/monitor/check-one', { uuid: U2 });
    body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.sat.state, 'Cancelado');
    assert.equal(body.sat.cancellation, 'Cancelado con aceptación');
    summary = await (await call('/api/monitor/summary', { ids: [U1, U2, U3] })).json();
    assert.equal(summary.counts.cancelados, 1);
    /* Forzar sobre una YA revisada vuelve a preguntar y actualiza. */
    behaviour.set(U1, { state: 'Cancelado', code: 'S', cancellation: '', cancelable: '', efos: '' });
    res = await call('/api/monitor/check-one', { uuid: U1.toLowerCase() });
    body = await res.json();
    assert.equal(body.sat.state, 'Cancelado', 'el forzado re-consulta aunque hubiera resultado');
    /* Inexistente → 404 con mensaje claro; mal formado → 400. */
    res = await call('/api/monitor/check-one', { uuid: '99999999-9999-4999-8999-999999999999' });
    assert.equal(res.status, 404);
    assert.match((await res.json()).error, /no está en la vigilancia/);
    res = await call('/api/monitor/check-one', { uuid: '123' });
    assert.equal(res.status, 400);
    /* Error del SAT: no pisa el estado bueno anterior. */
    res = await call('/api/monitor/check-one', { uuid: U3 });
    assert.equal((await res.json()).sat.state, 'Vigente');
    behaviour.set(U3, new Error('The operation was aborted due to timeout'));
    res = await call('/api/monitor/check-one', { uuid: U3 });
    assert.equal(res.status, 200);
    body = await res.json();
    assert.equal(body.ok, false, 'el fallo de transporte se devuelve como ok=false');
    assert.equal(body.sat.state, 'Vigente', 'el estado bueno anterior se conserva');
    assert.match(body.error, /timeout/);
    summary = await (await call('/api/monitor/summary', { ids: [U3] })).json();
    assert.equal(summary.counts.vigentes, 1, 'el resumen sigue contando el estado bueno');
    /* Invitado: fuera, como en check-now. */
    const admin = getToken();
    res = await call('/api/guest/config', { password: 'invitado-1131', enabled: true });
    assert.equal(res.status, 200);
    const guest = await (await call('/api/guest/login', { password: 'invitado-1131' })).json();
    assert.ok(guest.token);
    setToken(guest.token);
    res = await call('/api/monitor/check-one', { uuid: U1 });
    assert.equal(res.status, 403, 'el invitado no puede forzar revisiones');
    setToken(admin);
    console.log('ronda1131 A ok — check-one: Vigente, Cancelado, forzado sobre revisada, 404, error sin pisar, invitado fuera, cola intacta.');
  } finally { service.close(); }
}

/* ===== B + C · listas con cifras, explicaciones y satdocs por kind ===== */
{
  const OWN = 'MFI6212158B4';
  const PROV_DEF = 'AAA010101AAA', PROV_PRE = 'BBB010101BBB', CLI69 = 'CCC010101CCC';
  const DUMMY = 'XXX010101XXX';
  const fixtures = {
    '69b': 'Información actualizada al 09 de octubre de 2026\r\nNo.,RFC,Nombre del Contribuyente,Situación del contribuyente\r\n' +
      '1,' + PROV_DEF + ',PROVEEDOR DEFINITIVO SA,Definitivo\r\n2,' + PROV_PRE + ',PROVEEDOR PRESUNTO SA,Presunto\r\n3,' + DUMMY + ',OTRA SA,Presunto\r\n',
    '69-firmes': 'RFC,RAZON SOCIAL,TIPO PERSONA,SUPUESTO,FECHA DE PRIMERA PUBLICACION,ENTIDAD FEDERATIVA\r\n' +
      CLI69 + ',CLIENTE FIRMES SA,MORAL,FIRMES,15/01/2025,PUEBLA\r\n'
  };
  const generic = () => 'RFC,RAZON SOCIAL,SUPUESTO,FECHA\r\n' + DUMMY + ',OTRA SA,X,01/01/2025\r\n';
  const docKinds = [];
  const proxyKey = 'c'.repeat(64);
  const service = createPacoSATService({ dbFile: ':memory:', html: '<!--PACOSAT_TOKEN-->', origin, proxyKey, now: () => time,
    efirmaDir: mkdtempSync(join(tmpdir(), 'pacosat-1131-')),
    listFetch: async source => fixtures[source.id] || generic(),
    makeConnector: async ({ password }) => { if (password !== 'buena-efirma') throw new Error('mala'); return { parser: class {}, connector: {} }; },
    satDocFetch: async (profile, kind) => { docKinds.push(kind);
      return { content: Buffer.from('%PDF-1.4 ' + kind), issuedAt: new Date(time).toISOString(), fileName: kind + '.pdf' }; } });
  const { call, login } = harness(service, proxyKey);
  try {
    await login();
    let res = await call('/api/efirma', { rfc: OWN, certificate: CER, key: KEY, password: 'buena-efirma', minutes: 360, days: 30, direction: 'received' });
    assert.equal(res.status, 200);
    const inv = (id, date, from, to, total, method) => ({ id, date, kind: 'I',
      from: { rfc: from, name: 'EMPRESA ' + from }, to: { rfc: to, name: 'EMPRESA ' + to },
      total, currency: 'MXN', fiscal: { paymentMethod: method, transferred: [], withheld: [] } });
    const seed = [
      inv('AAAAAAA1-1111-4111-8111-111111111101', '2026-09-05', PROV_DEF, OWN, '10000.00', 'PUE'),
      inv('AAAAAAA1-1111-4111-8111-111111111102', '2026-10-05', PROV_DEF, OWN, '20000.00', 'PUE'),
      inv('AAAAAAA1-1111-4111-8111-111111111103', '2026-11-02', PROV_DEF, OWN, '5760.00', 'PUE'),
      inv('AAAAAAA1-1111-4111-8111-111111111104', '2026-10-20', PROV_PRE, OWN, '1160.00', 'PUE'),
      inv('AAAAAAA1-1111-4111-8111-111111111105', '2026-10-01', OWN, CLI69, '11600.00', 'PPD'),
      inv('AAAAAAA1-1111-4111-8111-111111111106', '2026-11-01', OWN, CLI69, '23200.00', 'PUE'),
      inv('AAAAAAA1-1111-4111-8111-111111111107', '2026-11-03', OWN, 'XAXX010101000', '5800.00', 'PUE')
    ];
    res = await call('/api/storage', { batch: { people: [{ id: OWN, name: 'EMPRESA PROPIA SA' }], invoices: seed } });
    assert.equal(res.status, 200);
    res = await call('/api/lists/refresh', {});
    assert.equal(res.status, 200);
    /* Trabajo con estado (pieza H): se espera a que el progreso se
       detenga antes de leer la vista cruzada. */
    for (let i = 0; i < 300; i++) {
      const progress = await (await call('/api/lists/progress')).json();
      if (!progress.running) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    const data = await (await call('/api/lists')).json();
    /* Proveedor definitivo: cifras de SUS CFDI, no escritas a mano. */
    const prov = data.counterparts.find(cp => cp.rfc === PROV_DEF);
    assert.equal(prov.hits[0].detail, 'Definitivo');
    assert.deepEqual(prov.detalle.recibidos, { count: 3, total: '35760.00', primera: '2026-09-05', ultima: '2026-11-02' });
    assert.equal(prov.detalle.emitidos, null);
    assert.equal(prov.detalle.saldoPorCobrar, null, 'un proveedor no lleva saldo por cobrar');
    assert.equal(prov.exposure.received, '35760.00', 'la exposición de siempre no cambia');
    const pre = data.counterparts.find(cp => cp.rfc === PROV_PRE);
    assert.deepEqual(pre.detalle.recibidos, { count: 1, total: '1160.00', primera: '2026-10-20', ultima: '2026-10-20' });
    /* Cliente art. 69: emitidas y saldo vivo según Dinero (la PPD
       sin pago entero; la PUE cuenta pagada). */
    const cli = data.counterparts.find(cp => cp.rfc === CLI69);
    assert.equal(cli.hits[0].listId, '69-firmes');
    assert.deepEqual(cli.detalle.emitidos, { count: 2, total: '34800.00', primera: '2026-10-01', ultima: '2026-11-01' });
    assert.deepEqual(cli.detalle.saldoPorCobrar, { total: '11600.00', facturas: 1 });
    /* RFC genérico: marcado como tal y con sus cifras. */
    const gen = data.counterparts.find(cp => cp.rfc === 'XAXX010101000');
    assert.equal(gen.generico, true);
    assert.equal(gen.detalle.emitidos.count, 1);
    assert.equal(prov.generico, false);
    /* Las explicaciones, por (lista, situación, rol). */
    const def = problemSpec('lista', { listId: '69b', detail: 'Definitivo', rol: 'proveedor', dinero: '$35,760.00', cfdiCount: 3 });
    assert.equal(def.level, 'rojo');
    assert.match(def.significa, /deducción/);
    assert.ok(def.significa.includes('35,760.00') && def.significa.includes('3 CFDI'), 'la explicación lleva las cifras');
    assert.match(def.ahora, /materialidad/);
    const pres = problemSpec('lista', { listId: '69b', detail: 'Presunto', rol: 'proveedor' });
    assert.equal(pres.level, 'ambar');
    assert.match(pres.significa + pres.ahora, /desvirtu/);
    const cliSpec = problemSpec('lista', { listId: '69-firmes', detail: 'Firmes · publicado el 15/01/2025', rol: 'cliente', saldo: '$11,600.00' });
    assert.equal(cliSpec.level, 'ambar');
    assert.match(cliSpec.significa, /No contamina/);
    assert.ok(cliSpec.ahora.includes('11,600.00'), 'el saldo vivo es la cifra del gesto');
    const genSpec = problemSpec('lista', { generico: true, listId: '69-firmes', detail: 'Firmes', rol: 'cliente' });
    assert.equal(genSpec.level, 'gris');
    assert.match(genSpec.titulo, /genérico/);
    assert.match(genSpec.ahora, /ningún riesgo/);
    const cli69b = problemSpec('lista', { listId: '69b', detail: 'Definitivo', rol: 'cliente' });
    assert.equal(cli69b.level, 'ambar');
    assert.match(cli69b.significa, /No contamina/);
    console.log('ronda1131 B ok — cifras desde los CFDI sembrados, saldo de Dinero y explicación por (lista, situación, rol).');
    /* C · satdocs/run por clase: cada botón dispara SOLO su kind. */
    res = await call('/api/satdocs/run', { rfc: OWN, kind: 'constancia' });
    assert.equal(res.status, 200);
    let runBody = await res.json();
    assert.deepEqual(Object.keys(runBody.results), ['constancia']);
    res = await call('/api/satdocs/run', { rfc: OWN, kind: 'opinion' });
    runBody = await res.json();
    assert.deepEqual(Object.keys(runBody.results), ['opinion']);
    assert.deepEqual(docKinds, ['constancia', 'opinion'], 'cada toque bajó solo su documento');
    console.log('ronda1131 C (servidor) ok — satdocs/run con kind baja solo la clase pedida.');
  } finally { service.close(); }
}

/* ===== C + D · superficie (fuentes del artefacto construido) ===== */
{
  const html = readFileSync(new URL('./Faro-Fiscal.html', import.meta.url), 'utf8');
  /* Los cuatro verbos exactos y su cableado. */
  for (const [glyph, verbo] of [['down', 'Descargar CFDI'], ['file', 'Constancia'], ['shield', 'Opinión'], ['folder', 'Declaraciones']])
    assert.ok(html.includes("mk('" + glyph + "', '" + verbo + "'"), 'botón directo «' + verbo + '»');
  assert.ok(html.includes("satQuickRunDoc('constancia'"), 'Constancia dispara su kind');
  assert.ok(html.includes("satQuickRunDoc('opinion'"), 'Opinión dispara su kind');
  assert.ok(html.includes("satApi('satdocs/run', { rfc, kind })"), 'la corrida va al endpoint de siempre con su clase');
  assert.ok(html.includes('downloadSheet(rfc)'), 'Descargar CFDI abre la hoja de descarga (C2) con el RFC elegido');
  assert.ok(html.includes('Este mes hasta hoy') && html.includes('Mes pasado completo') &&
    html.includes('Últimos 7 días') && html.includes('Últimos 30 días'), 'C2: la hoja trae los cuatro atajos de un toque');
  assert.ok(html.includes('Pedir y descargar'), 'C2: la hoja cierra con su botón de lanzamiento');
  assert.ok(html.includes('ya estaban: '), 'C2: el resultado cuenta los «ya estaban» sin duplicar');
  assert.ok(html.includes('Qué meses tienes'), 'C3: la cobertura principal se llama «Qué meses tienes»');
  assert.ok(html.includes('Descargar este mes'), 'C3: cada hueco trae su botón de descarga del mes');
  assert.ok(html.includes('Descargas pedidas al SAT'), 'C3: el libro de solicitudes queda como detalle secundario');
  assert.ok(html.includes('Declaraciones y acuses'), 'Declaraciones salta a su panel');
  /* Las acciones directas mandan arriba: abren la pantalla. La
     portada «Qué quieres hacer» (satPortada) se retiró en la
     1.18.0: la pregunta la hace el propio panel de acciones
     («¿Qué quieres del SAT?»). */
  assert.ok(html.indexOf('parts = [satQuickActions(), tabbar(') > 0, 'satView abre con las acciones directas');
  assert.ok(!html.includes('function satPortada('), 'la portada vieja del SAT ya no existe (1.18.0)');
  /* A · el botón por factura y su repintado en sitio. */
  assert.ok(html.includes("'Revisar ahora'") || html.includes('"Revisar ahora"') || html.includes('Revisar ahora'),
    'el botón «Revisar ahora» existe en la tarjeta');
  assert.ok(html.includes("satApi('monitor/check-one', { uuid: row.id })"), 'el botón llama al endpoint de uno');
  assert.ok(html.includes('data-monitor-state'), 'la celda de estado lleva su marca para repintarse en sitio');
  /* B · la tarjeta de Listas: cifras, significado y evidencia. */
  assert.ok(html.includes('Qué significa para ti'), 'el desplegable de significado existe');
  assert.ok(html.includes('Ver sus CFDI'), 'el botón a la evidencia existe');
  assert.ok(html.includes("problemSpec('lista'"), 'el significado sale del modelo único');
  assert.ok(html.includes('Saldo por cobrar: '), 'el saldo vivo se enseña en la tarjeta');
  /* D · impresión: el diálogo se cierra, el papel es la plantilla. */
  const printFn = html.slice(html.indexOf('function cfdiPrint'), html.indexOf('function invoiceDetail'));
  assert.ok(printFn.includes('dlg.close()'), 'cfdiPrint cierra el diálogo modal antes de imprimir');
  assert.ok(printFn.includes('print-parties') && printFn.includes('Régimen fiscal '), 'emisor y receptor con régimen en la plantilla');
  assert.ok(printFn.includes('Estado en PacoSAT (no forma parte del documento fiscal)'), 'línea de estado separada del cuerpo fiscal');
  for (const pantalla of ['Copiar UUID', 'Sin PDF vinculado', 'Está en la cola', 'Imprimir comprobante'])
    assert.ok(!printFn.includes(pantalla), 'la plantilla no contiene el texto de pantalla «' + pantalla + '»');
  assert.ok(html.includes('@page{size:A4 portrait'), 'papel en retrato A4');
  assert.ok(html.includes('dialog{display:none!important}'), 'el CSS de impresión oculta cualquier diálogo');
  console.log('ronda1131 C+D (superficie) ok — verbos exactos, cableado, botón por factura y plantilla de impresión limpia.');
}
/* ===== A2 · regresión: check-one fuerza aunque next esté lejos ===== */
{
  const db = new DatabaseSync(':memory:');
  let calls = 0;
  const t0 = Date.parse('2026-11-10T12:00:00Z');
  const monitor = createMonitor(db, { now: () => t0,
    checkSat: async () => { calls++; return { state: 'Vigente', code: 'S', cancellation: '', cancelable: '', efos: '' }; } });
  const ID = 'BBBBBBBB-0000-4000-8000-0000000000A2';
  monitor.register({ id: ID, emitter: 'AAA010101AAA', receiver: 'MFI6212158B4', total: '100.00', seal: '' });
  /* La fila de la era N-601: sin resultado y con next a +30 días —
     la tanda la procesó «de pasada» y la dejó fuera, como les pasó
     a las 4 facturas del cierre importadas por la bandeja. */
  db.prepare('UPDATE cfdi_watch SET next=? WHERE id=?').run(t0 + 30 * 86400000, ID);
  await monitor.tick();
  assert.equal(calls, 0, 'la tanda no lo toca: su next está a +30 días');
  const result = await monitor.checkOneNow(ID);
  assert.equal(calls, 1, 'check-one FUERZA la consulta aunque next esté en el futuro');
  assert.equal(result.ok, true);
  assert.equal(result.sat.state, 'Vigente');
  assert.equal(result.checked, t0);
  const row = db.prepare('SELECT next FROM cfdi_watch WHERE id=?').get(ID);
  /* La revisión normal de un vigente es +6 h desde la 1.27.0
     (control de cancelaciones casi en tiempo real); lo que la
     regresión guarda es que check-one reprograma como la tanda
     normal, no con el +30 días heredado de la era N-601. */
  assert.ok(row.next > t0 + 5 * 3600000 && row.next < t0 + 7 * 3600000,
    'next queda como tras una revisión normal (+6 h en la 1.27.0), no el +30 días heredado');
  console.log('OK 1.13.1 A2: check-one es la vía de escape real — fuerza con next a +30 días y guarda como la tanda.');
}

/* ===== G + G2 · correos de cancelación: transición sí, avalancha no ===== */
{
  const RFC = 'MFI6212158B4';
  let gTime = Date.parse('2026-11-10T18:00:00Z');
  const sent = [];
  const states = new Map();
  const service = createPacoSATService({ dbFile: ':memory:', html: '<!--PACOSAT_TOKEN-->', origin,
    now: () => gTime, proxyKey: 'e'.repeat(64),
    makeConnector: async () => ({ parser: class {}, connector: {} }),
    makeMailer: () => ({ verify: async () => true, sendMail: async payload => { sent.push(payload); } }),
    monitorOptions: { checkSat: async item => states.get(item.id) ||
      ({ state: 'Vigente', code: 'S', cancellation: '', cancelable: '', efos: '' }) } });
  const { call, login } = harness(service, 'e'.repeat(64));
  try {
    await login();
    let res = await call('/api/storage', { batch: { people: [{ id: RFC, name: 'Mano Fil' }] } });
    assert.equal(res.status, 200);
    res = await call('/api/mail', { host: 'smtp.example.com', port: 587, user: 'u', password: 'p', from: 'from@example.com', recipient: 'avisos@example.com' });
    assert.equal(res.status, 200);
    const CANCELADO = { state: 'Cancelado', code: 'S', cancellation: 'Cancelado sin aceptación', cancelable: '', efos: '' };
    /* Oleada histórica: 30 CFDI que se consultan por PRIMERA vez y
       ya vienen Cancelado (la avalancha real de las 15:23). */
    const wave = [];
    for (let i = 0; i < 30; i++) {
      const id = 'CCCCCCCC-0000-4000-8000-' + String(i).padStart(12, '0');
      states.set(id, CANCELADO);
      wave.push({ id, emitter: RFC, receiver: 'VALS611102P11', total: '1000.00', seal: '' });
    }
    res = await call('/api/monitor', { records: wave, ids: [] });
    assert.equal(res.status, 200);
    for (let i = 0; i < 10; i++) await service.monitorTick(gTime);
    await service.tick();
    const individuales = sent.filter(mail => /CFDI cancelado/.test(String(mail.subject)) && !/ponerte/.test(String(mail.subject)));
    assert.equal(individuales.length, 0, 'G: la oleada en primera consulta manda CERO correos individuales');
    const resumenes = sent.filter(mail => /Al ponerte al día/.test(String(mail.subject)));
    assert.equal(resumenes.length, 1, 'G: la oleada entera sale en UN solo resumen');
    for (let i = 0; i < 30; i++)
      assert.ok(resumenes[0].text.includes('CCCCCCCC-0000-4000-8000-' + String(i).padStart(12, '0')),
        'G2: el resumen trae las 30 filas (falta la ' + i + ')');
    assert.match(resumenes[0].text, /TUS PROPIAS CANCELACIONES DETECTADAS/,
      'G2: los emitidos por el propio RFC se agrupan como información, no como alarma');
    /* Re-revisar el mismo histórico: la segunda pasada no manda
       NADA (ni individuales ni otro resumen el mismo día). */
    const antes = sent.length;
    gTime += 2 * 3600000;
    for (let i = 0; i < 4; i++) await service.monitorTick(gTime);
    await service.tick();
    assert.equal(sent.length, antes, 'G2: re-revisar el mismo histórico manda 0 correos la segunda vez');

    /* Transición en caliente con TODOS los datos (G2): el CFDI de
       Brisbane consta Vigente, con su registro completo guardado,
       y pasa a Cancelado en la siguiente revisión. */
    const TID = '18453D78-72CC-4AF5-92D8-D66F998F241F';
    res = await call('/api/storage', { batch: { invoices: [{ id: TID,
      from: { rfc: 'IPC2502209B0', name: 'BRISBANE TEXTIL SA DE CV' }, to: { rfc: RFC, name: 'Mano Fil' },
      date: '2026-11-02T09:00:00', kind: 'I', total: '12760.00', currency: 'MXN',
      fiscal: { series: '', folio: '963' } }] } });
    assert.equal(res.status, 200);
    res = await call('/api/monitor', { records: [{ id: TID, emitter: 'IPC2502209B0', receiver: RFC, total: '12760.00', seal: '' }], ids: [] });
    assert.equal(res.status, 200);
    states.set(TID, { state: 'Vigente', code: 'S', cancellation: '', cancelable: '', efos: '' });
    for (let i = 0; i < 8; i++) await service.monitorTick(gTime);
    states.set(TID, CANCELADO);
    gTime += 2 * 86400000;
    for (let i = 0; i < 8; i++) await service.monitorTick(gTime);
    await service.tick();
    const transicion = sent.filter(mail => /CFDI cancelado/.test(String(mail.subject)) && !/ponerte/.test(String(mail.subject)));
    assert.equal(transicion.length, 1, 'G: la transición Vigente → Cancelado manda UN correo individual');
    assert.ok(transicion[0].subject.includes('$12,760.00'), 'G2: el asunto lleva el importe');
    assert.ok(transicion[0].subject.includes('BRISBANE TEXTIL SA DE CV'), 'G2: el asunto lleva el nombre de la contraparte');
    assert.ok(transicion[0].subject.includes('folio 963'), 'G2: el asunto lleva el folio');
    assert.ok(transicion[0].text.includes('Vigente → Cancelado'), 'G2: el cuerpo dice el estado anterior → nuevo');
    assert.ok(transicion[0].text.includes('2026-11-02'), 'G2: el cuerpo lleva la fecha de emisión');
    assert.ok(transicion[0].text.includes(TID), 'G2: el cuerpo lleva el UUID completo');
    assert.ok(transicion[0].text.includes('Recibido de un tercero'), 'G2: el cuerpo dice el tipo y su efecto');
    /* Ni re-revisiones ni el paso de los días lo vuelven a mandar. */
    gTime += 2 * 86400000;
    for (let i = 0; i < 8; i++) await service.monitorTick(gTime);
    await service.tick();
    assert.equal(sent.filter(mail => /CFDI cancelado/.test(String(mail.subject)) && !/ponerte/.test(String(mail.subject))).length, 1,
      'G2: el mismo evento (UUID + transición) no genera un segundo aviso en su vida');
    /* Interruptor apagado: ni transición ni resumen, nada. */
    res = await call('/api/mail/alerts', { enabled: false });
    assert.equal(res.status, 200);
    const TID2 = 'DDDDDDDD-0000-4000-8000-0000000000D2';
    res = await call('/api/monitor', { records: [{ id: TID2, emitter: 'AAA010101AAA', receiver: RFC, total: '50.00', seal: '' }], ids: [] });
    states.set(TID2, { state: 'Vigente', code: 'S', cancellation: '', cancelable: '', efos: '' });
    for (let i = 0; i < 8; i++) await service.monitorTick(gTime);
    states.set(TID2, CANCELADO);
    gTime += 2 * 86400000;
    for (let i = 0; i < 8; i++) await service.monitorTick(gTime);
    const antesApagado = sent.length;
    await service.tick();
    assert.equal(sent.length, antesApagado, 'G: con el ajuste de correo apagado no sale ningún correo de ningún tipo');
  } finally { await service.close(); }
  console.log('OK 1.13.1 G/G2: oleada → 1 resumen con las 30 filas y 0 individuales; transición → 1 individual con todos los datos, irrepetible; apagado → 0.');
}

/* ===== F · progreso medible y Cancelar en listados ===== */
{
  const fixtures = {
    '69b': 'Información actualizada al 09 de octubre de 2026\r\nNo.,RFC,Nombre del Contribuyente,Situación del contribuyente\r\n' +
      '1,AAA010101AAA,EMPRESA ALFA SA DE CV,Definitivo\r\n',
    '69b-bis': 'Información actualizada al 09 de octubre de 2026\r\nNo.,RFC,Nombre del Contribuyente,Situación del contribuyente\r\n' +
      '1,AAA010101AAA,EMPRESA ALFA SA DE CV,Definitivo\r\n',
    '69-firmes': 'RFC,RAZON SOCIAL,TIPO PERSONA,SUPUESTO,FECHA DE PRIMERA PUBLICACION,ENTIDAD FEDERATIVA\r\n' +
      'CCC030303CCA,EMPRESA GAMA SA,MORAL,FIRMES,15/01/2025,CIUDAD DE MEXICO\r\n',
    '69-sentencias': 'rfc,razon_social,tipo_persona,supuesto,fechas_primera_publicacion,entidad_federativa\r\n' +
      'FFF060606FFA,EMPRESA ZETA SA,M,sentencias,02/02/2024,JALISCO\r\n'
  };
  const generic = () => 'RFC,RAZON SOCIAL,SUPUESTO,FECHA\r\nXXX010101XXX,OTRA SA,X,01/01/2025\r\n';
  let slow = null;
  const service = createPacoSATService({ dbFile: ':memory:', html: '<!--PACOSAT_TOKEN-->', origin, now: () => time,
    listFetch: async source => { if (slow) await slow; return fixtures[source.id] || generic(); } });
  const { call, login } = harness(service);
  const waitDone = async () => {
    for (let i = 0; i < 300; i++) {
      const progress = await (await call('/api/lists/progress')).json();
      if (!progress.running) return progress;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('la actualización no terminó');
  };
  try {
    await login();
    let res = await call('/api/lists/refresh', {});
    assert.equal(res.status, 200);
    await waitDone();
    const before = await (await call('/api/lists')).json();
    const source69b = before.sources.find(row => row.id === '69b');
    assert.ok(source69b.count > 0 && source69b.fetched, 'copia buena sembrada');
    /* Segunda actualización LENTA: se pide cancelar a mitad y la
       copia anterior debe quedar intacta. El POST solo arranca el
       trabajo (pieza H) y la cancelación se lee en el progreso. */
    let release;
    slow = new Promise(resolve => { release = resolve; });
    res = await call('/api/lists/refresh', {});
    assert.equal((await res.json()).started, true, 'H: el POST arranca el trabajo y vuelve al instante');
    let progress = null;
    for (let i = 0; i < 50 && !progress?.running; i++) {
      await new Promise(resolve => setTimeout(resolve, 50));
      progress = await (await call('/api/lists/progress')).json();
    }
    assert.ok(progress?.running, 'F: el progreso corre y se puede leer mientras tanto');
    assert.ok(progress.phase.includes('Descargando'), 'F: el progreso dice la fase en lenguaje claro');
    assert.ok(progress.total >= 1, 'F: el progreso trae el conteo de listados');
    res = await call('/api/lists/cancel', {});
    assert.equal((await res.json()).cancelling, true, 'F: cancelar se acepta con ciclo en curso');
    release();
    const finalProgress = await waitDone();
    assert.equal(finalProgress.cancelled, true, 'F: el progreso final cuenta que se canceló por petición de Paco');
    const after = await (await call('/api/lists')).json();
    const after69b = after.sources.find(row => row.id === '69b');
    assert.equal(after69b.count, source69b.count, 'F: cancelar conserva la copia anterior (conteo intacto)');
    assert.equal(after69b.fetched, source69b.fetched, 'F: cancelar conserva la copia anterior (fecha intacta)');
    assert.ok(after.lastCancelled, 'F: la cancelación queda registrada con su hora para contarla en pantalla');
  } finally { await service.close(); }
  console.log('OK 1.13.1 F: progreso con fase y conteo en vivo, Cancelar cooperativo y copia anterior intacta.');
}

/* ===== H · el trabajo pesado no bloquea y la pantalla recomprueba ===== */
{
  assert.equal(PACOSAT_HTTP_TIMEOUTS.keepAliveTimeout, 125000,
    'H: keepAliveTimeout queda en 125 s, por encima de la reutilización del proxy');
  assert.ok(PACOSAT_HTTP_TIMEOUTS.headersTimeout > PACOSAT_HTTP_TIMEOUTS.keepAliveTimeout,
    'H: headersTimeout va por encima del keepAlive, como exige Node');
  /* Con una actualización de listados EN CURSO (fuente lenta), el
     arranque responde al instante y otra acción —forzar la revisión
     de un CFDI— responde en menos de 1 s: nada espera dentro del
     POST una importación. */
  let releaseH;
  const slowH = new Promise(resolve => { releaseH = resolve; });
  const service = createPacoSATService({ dbFile: ':memory:', html: '<!--PACOSAT_TOKEN-->', origin, now: () => time,
    listFetch: async () => { await slowH; return 'RFC,RAZON SOCIAL,SUPUESTO,FECHA\r\nXXX010101XXX,OTRA SA,X,01/01/2025\r\n'; },
    monitorOptions: { checkSat: async () => ({ state: 'Vigente', code: 'S', cancellation: '', cancelable: '', efos: '' }) } });
  const { call, login } = harness(service);
  try {
    await login();
    const HID = '12345678-1234-4234-8234-1234567890AB';
    let res = await call('/api/monitor', { records: [{ id: HID, emitter: 'AAA010101AAA', receiver: 'MFI6212158B4', total: '10.00', seal: '' }], ids: [] });
    assert.equal(res.status, 200);
    let t0 = Date.now();
    res = await call('/api/lists/refresh', {});
    assert.ok(Date.now() - t0 < 1000, 'H: arrancar la actualización de listados responde en <1 s');
    assert.equal((await res.json()).started, true);
    t0 = Date.now();
    res = await call('/api/monitor/check-one', { uuid: HID });
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 1000, 'H: con listados en curso, check-one responde en <1 s (tardó ' + elapsed + ' ms)');
    assert.equal((await res.json()).ok, true, 'H: la revisión forzada se hizo con la actualización en curso');
    res = await call('/api/lists/cancel', {});
    releaseH();
  } finally { await service.close(); }
  /* La recomprobación de la capa 2 lee ESTE estado: marcar pagado
     aterriza aunque su respuesta se pierda, y la relectura de
     Dinero lo encuentra aplicado (saldo 0.00); repetir la marca se
     rechaza sin duplicar el pago. Es lo que satApiGuardar comprueba
     antes de enseñar cualquier error. */
  const RFC = 'MFI6212158B4';
  const service2 = createPacoSATService({ dbFile: ':memory:', html: '<!--PACOSAT_TOKEN-->', origin,
    now: () => time, proxyKey: 'b'.repeat(64),
    makeConnector: async () => ({ parser: class {}, connector: {} }) });
  const h2 = harness(service2, 'b'.repeat(64));
  try {
    await h2.login();
    const MID = '12345678-1234-4234-8234-1234567890AC';
    let res = await h2.call('/api/storage', { batch: { people: [{ id: RFC, name: 'Mano Fil' }], invoices: [{
      id: MID, from: { rfc: 'AAA010101AAA', name: 'PROVEEDOR SA' }, to: { rfc: RFC, name: 'Mano Fil' },
      date: '2026-11-01T08:00:00', kind: 'I', total: '300.00', currency: 'MXN', paymentMethod: 'PPD' }] } });
    assert.equal(res.status, 200);
    let money = await (await h2.call('/api/money')).json();
    assert.ok(money.balances.some(row => row.id === MID && row.balance === '300.00'), 'H: saldo vivo antes de marcar');
    res = await h2.call('/api/money/mark-paid', { uuid: MID });
    assert.equal(res.status, 200);
    money = await (await h2.call('/api/money')).json();
    assert.ok(!money.balances.some(row => row.id === MID && row.balance !== '0.00'),
      'H: la relectura encuentra el cambio aplicado — la UI enseña el éxito real, no el error perdido');
    res = await h2.call('/api/money/mark-paid', { uuid: MID });
    assert.equal(res.status, 400, 'H: repetir la marca no duplica el pago');
    /* Superficie: el ayudante existe y lo usan Avisos y Dinero. */
    const html = readFileSync(new URL('./Faro-Fiscal.html', import.meta.url), 'utf8');
    assert.ok(html.includes('async function satApiGuardar'), 'H: el ayudante de mutación con recomprobación existe');
    assert.ok(html.includes("satApiGuardar('notices/answer'"), 'H: «Ya se pagó» de Avisos pasa por la recomprobación');
    assert.ok(html.includes("satApiGuardar('money/mark-paid'"), 'H: marcar pagado en Dinero pasa por la recomprobación');
    assert.ok(html.includes('Quedó marcado como pagado'), 'H: el éxito real tras recomprobar tiene su texto');
    assert.ok(html.includes('data-run-status') || html.includes('runStatus'), 'E: la tarjeta de progreso vive junto a la acción');
    assert.ok(html.includes('Consultando el estado en el SAT…'), 'E: la fase se cuenta en lenguaje claro junto al botón');
    assert.ok(html.includes('Cancelado por ti a las '), 'E/F: el resultado cancelado persiste junto a la acción, con su hora');
    assert.ok(html.includes('Última revisión: '), 'E: el resultado queda persistido en la pantalla de Estado');
  } finally { await service2.close(); }
  console.log('OK 1.13.1 H: timeouts sobre el proxy, listados como trabajo que no bloquea (<1 s) y recomprobación que encuentra el cambio aplicado.');
}

/* ===== C2 · atajos exactos, resumen previo e ingesta idempotente ===== */
{
  assert.deepEqual(downloadShortcutRange('mes', '2026-11-10'), { start: '2026-11-01', end: '2026-11-10' },
    'C2: «Este mes hasta hoy» compone exactamente día 1 → hoy');
  assert.deepEqual(downloadShortcutRange('mes-pasado', '2026-11-10'), { start: '2026-10-01', end: '2026-10-31' });
  assert.deepEqual(downloadShortcutRange('7d', '2026-11-10'), { start: '2026-11-04', end: '2026-11-10' });
  assert.deepEqual(downloadShortcutRange('30d', '2026-11-10'), { start: '2026-10-12', end: '2026-11-10' });
  assert.equal(downloadSummaryText('Mano Fil', 'MFI6212158B4', 'both', '2026-11-01', '2026-11-10'),
    'Se pedirá al SAT: Mano Fil (MFI6212158B4) · emitidos y recibidos · del 1 al 10 de noviembre de 2026',
    'C2: el resumen previo es la línea exacta que pidió Paco');
  /* Ingesta idempotente por el pipeline de descargas: el paquete
     trae un UUID que YA está y uno nuevo → 1 nuevo, 1 «ya estaba»,
     y la tienda no crece de más. */
  const RFC = 'MFI6212158B4';
  const DUP = 'EEEEEEEE-0000-4000-8000-0000000000E1', NEW = 'EEEEEEEE-0000-4000-8000-0000000000E2';
  const xmlFor = uuid => '<Comprobante/>|' + uuid;
  class RangeParser {
    parseFromString(xml) {
      const uuid = xml.split('|')[1];
      const cfdi = 'http://www.sat.gob.mx/cfd/4', tfd = 'http://www.sat.gob.mx/TimbreFiscalDigital';
      const node = (localName, data = {}, children = [], namespaceURI = cfdi) => ({ localName, namespaceURI, nodeType: 1,
        childNodes: children, getAttribute: name => data[name] || '',
        getElementsByTagNameNS: (ns, name) => children.filter(child => child.namespaceURI === ns && child.localName === name) });
      return { documentElement: node('Comprobante', { Fecha: '2026-11-05T08:00:00', Total: '100.00', Moneda: 'MXN', TipoDeComprobante: 'I' }, [
        node('Emisor', { Rfc: 'AAA010101AAA', Nombre: 'EMISOR SA' }), node('Receptor', { Rfc: RFC, Nombre: 'Mano Fil' }),
        node('Complemento', {}, [node('TimbreFiscalDigital', { UUID: uuid }, [], tfd)]) ]),
        getElementsByTagName: () => [] };
    }
  }
  const archiveOf = payload => {
    const raw = Buffer.from(payload), name = Buffer.from('test.xml');
    const local = Buffer.alloc(30), central = Buffer.alloc(46), end = Buffer.alloc(22);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(name.length, 26);
    central.writeUInt32LE(0x02014b50); central.writeUInt32LE(crc32(raw), 16);
    central.writeUInt32LE(raw.length, 20); central.writeUInt32LE(raw.length, 24); central.writeUInt16LE(name.length, 28);
    end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
    end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(local.length + name.length + raw.length, 16);
    return Buffer.concat([local, name, raw, central, name, end]);
  };
  /* zipXml concatena las entradas del zip: un solo archivo con los
     dos XML no sirve; se construye un zip de dos entradas. */
  const zipTwo = (a, b) => {
    const parts = [], centrals = [];
    let offset = 0;
    for (const [name, payload] of [['a.xml', a], ['b.xml', b]]) {
      const raw = Buffer.from(payload), nameBuf = Buffer.from(name);
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50); local.writeUInt16LE(nameBuf.length, 26);
      local.writeUInt32LE(crc32(raw), 14); local.writeUInt32LE(raw.length, 18); local.writeUInt32LE(raw.length, 22);
      const central = Buffer.alloc(46);
      central.writeUInt32LE(0x02014b50); central.writeUInt32LE(crc32(raw), 16);
      central.writeUInt32LE(raw.length, 20); central.writeUInt32LE(raw.length, 24); central.writeUInt16LE(nameBuf.length, 28);
      central.writeUInt32LE(offset, 42);
      parts.push(local, nameBuf, raw); centrals.push(central, nameBuf);
      offset += local.length + nameBuf.length + raw.length;
    }
    const centralSize = centrals.reduce((sum, buf) => sum + buf.length, 0);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50); end.writeUInt16LE(2, 8); end.writeUInt16LE(2, 10);
    end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16);
    return Buffer.concat([...parts, ...centrals, end]);
  };
  const service = createPacoSATService({ dbFile: ':memory:', html: '<!--PACOSAT_TOKEN-->', origin,
    now: () => time, proxyKey: 'f'.repeat(64),
    efirmaDir: mkdtempSync(join(tmpdir(), 'pacosat-1131-c2-')),
    makeConnector: async ({ password }) => {
      if (password !== 'buena-efirma') throw new Error('La contraseña no abre la llave.');
      return { parser: RangeParser, connector: {
        request: async () => 'req-c2',
        check: async () => ({ status: 'finished', packages: ['pkg-c2'] }),
        download: async () => zipTwo(xmlFor(DUP), xmlFor(NEW)) } };
    } });
  const { call, login } = harness(service, 'f'.repeat(64));
  try {
    await login();
    let res = await call('/api/storage', { batch: { people: [{ id: RFC, name: 'Mano Fil' }],
      invoices: [{ id: DUP, from: { rfc: 'AAA010101AAA', name: 'EMISOR SA' }, to: { rfc: RFC, name: 'Mano Fil' },
        date: '2026-11-05T08:00:00', kind: 'I', total: '100.00', currency: 'MXN' }] } });
    assert.equal(res.status, 200);
    res = await call('/api/efirma', { rfc: RFC, certificate: CER, key: KEY, password: 'buena-efirma', minutes: 360, days: 30, direction: 'received' });
    assert.equal(res.status, 200);
    res = await call('/api/request', { rfc: RFC, direction: 'received', start: '2026-11-01', end: '2026-11-10', type: 'cfdi' });
    assert.equal(res.status, 200);
    /* El trabajo madura por su reloj (due +5 min por sondeo): se
       avanza el tiempo del servicio y se tickea hasta que el
       paquete baja y se importa, como en producción. */
    for (let i = 0; i < 6; i++) { time += 6 * 60000; await service.tick(); }
    const activityStore = await (await call('/api/storage?store=activity')).json();
    const activityRows = activityStore.rows || activityStore;
    const act = activityRows.find(entry => String(entry.id || '').startsWith('sat:'));
    assert.ok(act, 'C2: la importación del paquete quedó en la actividad');
    assert.equal(act.added, 1, 'C2: un CFDI nuevo importado');
    assert.equal(act.duplicates, 1, 'C2: «ya estaban: 1» — el UUID repetido se cuenta, no se duplica');
    const invoices = await (await call('/api/storage?store=invoices')).json();
    const rows = invoices.rows || invoices;
    assert.equal(rows.filter(row => row.id === DUP).length, 1, 'C2: el UUID repetido sigue existiendo UNA sola vez');
    assert.equal(rows.filter(row => row.id === NEW).length, 1, 'C2: el nuevo entró una vez');
  } finally { await service.close(); }
  console.log('OK 1.13.1 C2: atajos exactos, resumen previo literal e ingesta idempotente (nuevos 1 · ya estaban 1).');
}

/* ===== C3 · cobertura desde los registros reales ===== */
{
  const RFC = 'MFI6212158B4';
  const service = createPacoSATService({ dbFile: ':memory:', html: '<!--PACOSAT_TOKEN-->', origin,
    now: () => time, proxyKey: 'a'.repeat(64),
    makeConnector: async () => ({ parser: class {}, connector: {} }) });
  const { call, login } = harness(service, 'a'.repeat(64));
  try {
    await login();
    /* Base vacía: la cobertura honesta dice que no hay datos. */
    let status = await (await call('/api/status')).json();
    assert.deepEqual(status.coverage.records, [], 'C3: sin registros, la cobertura de registros nace vacía');
    const mk = (id, month, day, extra = {}) => ({ id,
      from: { rfc: 'AAA010101AAA', name: 'EMISOR SA' }, to: { rfc: RFC, name: 'Mano Fil' },
      date: '2026-' + month + '-' + day + 'T08:00:00', kind: 'I', total: '100.00', currency: 'MXN', ...extra });
    let res = await call('/api/storage', { batch: { people: [{ id: RFC, name: 'Mano Fil' }], invoices: [
      mk('FFFFFFFF-0000-4000-8000-0000000000F1', '01', '10'), mk('FFFFFFFF-0000-4000-8000-0000000000F2', '01', '20'),
      mk('FFFFFFFF-0000-4000-8000-0000000000F3', '03', '05'),
      { id: 'FFFFFFFF-0000-4000-8000-0000000000F4', from: { rfc: RFC, name: 'Mano Fil' },
        to: { rfc: 'BBB020202BBB', name: 'CLIENTE SA' }, date: '2026-01-15T08:00:00', kind: 'I',
        total: '200.00', currency: 'MXN', origin: 'descarga' }
    ] } });
    assert.equal(res.status, 200);
    status = await (await call('/api/status')).json();
    assert.equal(status.jobs.length, 0, 'C3: cero solicitudes en el libro — y aun así hay cobertura');
    const received = status.coverage.records.find(group => group.rfc === RFC && group.direction === 'received');
    assert.ok(received, 'C3: hay grupo de recibidos desde los registros importados');
    assert.equal(received.months.find(cell => cell.month === '2026-01').count, 2, 'C3: enero enseña sus 2 CFDI');
    assert.equal(received.months.find(cell => cell.month === '2026-03').count, 1, 'C3: marzo enseña su CFDI');
    assert.deepEqual(received.huecos, ['2026-02'], 'C3: febrero es hueco visible dentro del rango de actividad');
    assert.equal(received.months[0].sinClasificar, 2, 'C3: sin marca de vía, el registro va «sin clasificar» — no se inventa');
    const issued = status.coverage.records.find(group => group.rfc === RFC && group.direction === 'issued');
    assert.equal(issued.months[0].descarga, 1, 'C3: con marca de vía, el mes cuenta los de descarga del SAT');
  } finally { await service.close(); }
  console.log('OK 1.13.1 C3: la cobertura sale de los registros (ene 2 · feb hueco · mar 1) con cero solicitudes, y la vía no se inventa.');
}

console.log('ronda1131.test: ok — 1.13.1 completa (A+A2 revisar ahora, B listas con significado, C+C2 acciones directas y hoja de descarga, C3 cobertura real, D impresión, E feedback, F cancelar, G/G2 correos sin avalancha).');
