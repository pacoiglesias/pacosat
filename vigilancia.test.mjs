import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { createMonitor, querySat } from './sat-monitor.mjs';
import { createPacoSATService } from './local-server.mjs';

/* Vigilancia SAT rediseñada: la causa raíz del «pendiente de
   reintento» eterno (el SAT responde N-601 y el código lo trataba
   como error transitorio), el resumen por tarjetas, la revisión
   manual por tandas y el refresco de listados. */

const day = 86400000, hour = 3600000;
const acuse = (code, state) =>
  '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>' +
  '<ConsultaResponse xmlns="http://tempuri.org/">' +
  '<ConsultaResult xmlns:a="http://schemas.datacontract.org/2004/07/Sat.Cfdi.Negocio.ConsultaCfdi.Servicio">' +
  '<a:CodigoEstatus>' + code + '</a:CodigoEstatus><a:EsCancelable></a:EsCancelable>' +
  '<a:Estado>' + state + '</a:Estado><a:EstatusCancelacion></a:EstatusCancelacion>' +
  '<a:ValidacionEFOS></a:ValidacionEFOS></ConsultaResult></ConsultaResponse></s:Body></s:Envelope>';
const fakeFetch = xml => async () => ({ ok: true, status: 200, body: (async function* () { yield Buffer.from(xml); })() });
const cfdi = { id: '12345678-1234-1234-1234-1234567890AB', emitter: 'AAA010101AAA', receiver: 'XAXX010101000', total: '80.50', seal: '+/abcd==' };

/* 1) La regresión: N-601 es RESPUESTA del SAT («No encontrado»), no
   un error que reintentar cada hora. Antes de la reparación,
   querySat lanzaba «El SAT no confirmó el estado: N - 601…» y la
   fila quedaba en «pendiente de reintento» para siempre. */
assert.equal((await querySat(cfdi, fakeFetch(acuse('N - 601: La expresión impresa proporcionada no es válida.', 'No Encontrado')))).state, 'No encontrado');
assert.equal((await querySat(cfdi, fakeFetch(acuse('N - 602: Comprobante no encontrado.', 'No Encontrado')))).state, 'No encontrado');
assert.equal((await querySat(cfdi, fakeFetch(acuse('S - 601: La expresión impresa proporcionada es válida.', 'Vigente')))).state, 'Vigente');
await assert.rejects(() => querySat(cfdi, fakeFetch(acuse('N - 999: Otra cosa.', 'No Encontrado'))), /no confirmó/);
console.log('OK: N-601/N-602 se guardan como «No encontrado»; S sigue dando el estado; lo demás sigue siendo error.');

/* 2) «No encontrado» no se rechequea a la hora ni al día: al mes. */
{
  let time = 1700000000000, calls = 0;
  const db = new DatabaseSync(':memory:');
  const monitor = createMonitor(db, { now: () => time, refreshEfos: async () => new Map(),
    checkSat: async () => { calls++; return { state: 'No encontrado', code: 'N - 601', cancellation: '', cancelable: '', efos: '' }; } });
  try {
    monitor.register(cfdi);
    await monitor.tick();
    assert.equal(calls, 1);
    assert.equal(monitor.status([cfdi.id]).results[0].sat.state, 'No encontrado');
    assert.equal(monitor.status([cfdi.id]).results[0].error, '');
    time += day;
    await monitor.tick();
    assert.equal(calls, 1, 'al día siguiente no se rechequea un «No encontrado»');
    time += 30 * day;
    await monitor.tick();
    assert.equal(calls, 2, 'al mes sí se rechequea');
    console.log('OK: el «No encontrado» se rechequea a los 30 días, no en bucle.');
  } finally { db.close(); }
}

/* 3) Resumen por tarjetas + revisar ahora por tandas + listados. */
{
  let time = 1700000000000;
  const db = new DatabaseSync(':memory:');
  const mk = (suffix, emitter) => ({ id: '12345678-1234-1234-1234-1234567890' + suffix,
    emitter, receiver: 'XAXX010101000', total: '80.50', seal: '+/abcd==' });
  const A = mk('A1', 'AAA010101AAA'), B = mk('B2', 'BBB010101BBB'), C = mk('C3', 'CCC010101CCC'),
    D = mk('D4', 'DDD010101DDD'), E = mk('E5', 'EEE010101EEE'), F = mk('F6', 'FFF010101FFF');
  const behaviour = new Map([
    [A.id, { state: 'Vigente', code: 'S', cancellation: '', cancelable: '', efos: '' }],
    [B.id, { state: 'Cancelado', code: 'S', cancellation: 'Cancelado con aceptación', cancelable: '', efos: '' }],
    [C.id, { state: 'No encontrado', code: 'N - 601', cancellation: '', cancelable: '', efos: '' }],
    [D.id, new Error('The operation was aborted due to timeout')],
    [F.id, new Error('The operation was aborted due to timeout')]
  ]);
  const monitor = createMonitor(db, { now: () => time,
    refreshEfos: async () => new Map([['BBB010101BBB', new Set(['Definitivo'])]]),
    checkSat: async item => { const b = behaviour.get(item.id); if (b instanceof Error) throw b; return b; } });
  try {
    for (const row of [A, B, C, D, F]) monitor.register(row);
    const lists = await monitor.refreshLists();
    assert.equal(lists.count, 1);
    assert.ok(lists.fetched > 0);
    /* Revisar ahora: procesa solo los que no tienen respuesta. */
    const batch = await monitor.processNow(10);
    assert.equal(batch.processed, 5);
    assert.equal(batch.remaining, 2, 'quedan sin respuesta el del error (D) y el del error (F)');
    const sum = monitor.summary([A.id, B.id, C.id, D.id, E.id, F.id]);
    assert.equal(sum.counts.total, 6);
    assert.equal(sum.counts.vigentes, 1);
    assert.equal(sum.counts.cancelados, 0, 'el cancelado con 69-B cuenta en el listado, no en cancelados');
    assert.equal(sum.counts.enListado69B, 1);
    assert.deepEqual(sum.masAfectados, [{ rfc: 'BBB010101BBB', count: 1 }]);
    assert.equal(sum.counts.noEncontrados, 1);
    assert.equal(sum.counts.conProblema, 2, 'los dos que fallaron por timeout');
    assert.equal(sum.counts.sinRevisar, 1, 'el nunca registrado (E)');
    assert.equal(sum.counts.revisados, 3);
    assert.ok(sum.counts.ultimaRevision > 0);
    assert.equal(sum.lists.count, 1);
    /* checkNow solo encola a los que siguen sin respuesta. */
    assert.equal(monitor.checkNow([A.id]), 0, 'con respuesta no se encola');
    assert.equal(monitor.checkNow([F.id]), 1, 'el del error vuelve a la cola al momento');
    behaviour.set(F.id, { state: 'Vigente', code: 'S', cancellation: '', cancelable: '', efos: '' });
    const batch2 = await monitor.processNow(10);
    assert.equal(batch2.processed, 1, 'solo F estaba vencido y sin respuesta (D espera su hora)');
    assert.equal(monitor.summary([F.id]).counts.vigentes, 1);
    /* El rango de fechas del botón de descarga no pasa por aquí: lo
       cubre la prueba del diálogo de solicitud ya existente. */
    console.log('OK: resumen por tarjetas, precedencia 69-B, tandas de revisión y encolado selectivo.');
  } finally { db.close(); }
}

/* 4) Los endpoints nuevos a través del servicio completo: la
   pantalla pide el resumen, lanza «revisar ahora» y actualiza
   listados sin tocar el motor de descarga. */
{
  const origin = 'http://127.0.0.1:43731';
  const behaviour = new Map([[cfdi.id, { state: 'Vigente', code: 'S', cancellation: '', cancelable: '', efos: '' }]]);
  const service = createPacoSATService({ dbFile: ':memory:', html: '<!--PACOSAT_TOKEN-->', origin,
    monitorOptions: { checkSat: async item => behaviour.get(item.id),
      refreshEfos: async () => new Map([['AAA010101AAA', new Set(['Presunto'])]]) } });
  let token;
  async function call(path, data) {
    const headers = { host: new URL(origin).host, origin, 'x-pacosat-token': token };
    const req = Object.assign(Readable.from(data === undefined ? [] : [Buffer.from(JSON.stringify(data))]), {
      url: path, method: data === undefined ? 'GET' : 'POST', headers });
    let response;
    const res = { setHeader() {}, writeHead(status) { this.status = status; this.headersSent = true; },
      end(content) { response = new Response(content, { status: this.status }); } };
    await service.handle(req, res);
    return response;
  }
  try {
    const page = await (await call('/')).text();
    token = page.split('content="')[1].split('"')[0];
    let res = await call('/api/monitor', { records: [{ id: cfdi.id, emitter: cfdi.emitter, receiver: cfdi.receiver, total: cfdi.total, seal: cfdi.seal }], ids: [] });
    assert.equal(res.status, 200);
    /* Antes de revisar: el resumen lo cuenta como «sin revisar». */
    let sum = await (await call('/api/monitor/summary', { ids: [cfdi.id] })).json();
    assert.equal(sum.counts.total, 1);
    assert.equal(sum.counts.sinRevisar, 1);
    /* «Revisar ahora» procesa la tanda y el resumen cambia. */
    const batch = await (await call('/api/monitor/check-now', { ids: [cfdi.id] })).json();
    assert.equal(batch.queued, 1);
    assert.equal(batch.processed, 1);
    assert.equal(batch.remaining, 0);
    sum = await (await call('/api/monitor/summary', { ids: [cfdi.id] })).json();
    assert.equal(sum.counts.vigentes, 1, 'recién revisado y sin listados cargados: cuenta como vigente');
    assert.equal(sum.counts.enListado69B, 0, 'sin refrescar listados aún no hay coincidencia guardada');
    const refreshed = await (await call('/api/monitor/refresh-lists', {})).json();
    assert.equal(refreshed.lists.count, 1);
    sum = await (await call('/api/monitor/summary', { ids: [cfdi.id] })).json();
    assert.equal(sum.counts.enListado69B, 1);
    assert.equal(sum.counts.vigentes, 0, 'con el listado cargado, la coincidencia 69-B manda sobre el estado');
    assert.equal(sum.counts.revisados, 1);
    /* Validación de la selección. */
    res = await call('/api/monitor/summary', { ids: ['no-es-un-uuid'] });
    assert.equal(res.status, 400);
    console.log('OK: endpoints /api/monitor/summary, /check-now y /refresh-lists de punta a punta.');
  } finally { await service.close(); }
}
console.log('vigilancia.test: ok');
