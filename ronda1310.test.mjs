import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { DOMParser } from '@xmldom/xmldom';
import { createPacoSATService } from './local-server.mjs';
import { buildExecutorJob, validateExecutorResult } from './sat-executor.mjs';

/* ================================================================
   Ronda 1.31.0 — la corrección del 13 nov, de golpe (orden de
   Paco: «¿no puedes hacer todo de golpe?» · «quiero un mayor
   avance»; montaje el lunes 16 con él presente).

   Comprobaciones de verdad de esta suite:
   1. PROTOCOLO accesoOk: solo el booleano true acredita el
      acceso; el plan del Buzón va por textos de la portada real
      («Mis notificaciones»), sin rutas del lanzador.
   2. PUERTA VERAZ (A4, servidor): una puerta-probar fallida deja
      «no abre»; un trabajo del Buzón que FALLA en el pasillo pero
      declara accesoOk la refresca a «abre» — el acceso real manda
      sobre la fila vieja.
   3. REGISTRO SIN GEMELOS (A2): el fallo del Buzón aparece UNA
      vez (la entrada del trámite, del diario del motor) y la del
      intento no se duplica; el intento SIN espejo (puerta-probar)
      conserva su propia entrada.
   4. CANCELAR (A3, servidor): en cola, el trabajo sale de la
      cola y ningún ejecutor lo reclama; en curso, el latido le
      lleva la cancelación al ejecutor y el resultado que llega se
      DESCARTA entero (ni notificaciones guardadas) quedando el
      intento como cancelado.
   5. REPORTES (D, servidor): los Excel nuevos (totales,
      declaraciones, avisos, dinero) salen como .xlsx de verdad
      (firma PK) y los PDF nuevos (totales, avisos) como %PDF,
      desde las rutas de siempre. F12: la nota de un CFDI se
      guarda, se lee y viaja en el mapa de notas.
   6. ESTÁTICAS de la ola: versión 1.31.0 en paquete y ejecutor,
      menú ordenado en el artefacto (Recibidos, Trabajos en
      curso, sin distintivos de inventario), y las piezas nuevas
      del cliente (descargarSalida1310, cancelarTramite1310).
   ================================================================ */

const ORIGIN = 'https://pacosat.test';
const KEY = 'f'.repeat(64);
const OWN = 'AAA010101AAA';
const ROOT = import.meta.dirname;
const read = name => readFileSync(join(ROOT, name), 'utf8');

function makeHarness(options = {}) {
  const clock = { t: Date.parse('2026-11-13T16:00:00Z') };
  const mails = [];
  const service = createPacoSATService({
    dbFile: ':memory:', html: '<html><head><!--PACOSAT_TOKEN--></head><body>prueba</body></html>',
    origin: ORIGIN, proxyKey: KEY, satDocRetryWaitMs: 5,
    makeConnector: () => ({ parser: DOMParser, connector: {
      request: async () => 'req-b', check: async () => ({ status: 'pending', packages: [] }),
      download: async () => { throw new Error('sin paquetes'); } } }),
    makeMailer: () => ({ verify: async () => true,
      sendMail: async mail => { mails.push(mail); return { messageId: 'm' + mails.length }; } }),
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
  const exec = async (method, path, body, execToken) => {
    const r = await raw(method, path, body, execToken ? { 'x-pacosat-executor': execToken } : {});
    let json = null; try { json = JSON.parse(r.text); } catch { /* binario */ }
    return { status: r.status, json, text: r.text };
  };
  return { service, call, raw, exec, mails, clock };
}
const unlock = async (h, rfc) => {
  const open = await h.call('POST', '/api/unlock', { rfc, minutes: 1440, days: 7,
    direction: 'both', password: 'simulated', certificate: 'YQ==', key: 'Yg==' });
  assert.equal(open.status, 200);
};

/* ===== 6 · ESTÁTICAS ===== */
{
  const pkg = JSON.parse(read('package.json'));
  /* Re-baseline 1.31.1: la aserción pasa de la literal de la ola
     a la COHERENCIA del sello — paquete, ejecutor y artefacto
     declaran la MISMA versión, que es la propiedad que la
     1.31.0 fijó; la literal de cada ola vive en su propia
     ronda (la de esta, en ronda1311). */
  assert.ok(/^\d+\.\d+\.\d+$/.test(pkg.version), 'la versión del paquete tiene forma X.Y.Z');
  const ejecutor = read('ejecutor-local.mjs');
  assert.ok(ejecutor.includes("EJECUTOR_VERSION = '" + pkg.version + "'"), 'el ejecutor declara la versión del paquete');
  assert.ok(ejecutor.includes('cancelados'), 'el ejecutor atiende las cancelaciones del latido');
  const html = read('Faro-Fiscal.html');
  assert.ok(html.includes('"version":"' + pkg.version + '"'), 'el artefacto se sella con la versión del paquete');
  /* RE-BASE 2.8.0 (diseño 19 y 11): el buzón de comprobantes
     se llama «Novedades» (ya no se pisa con el Buzón del SAT)
     y la fila «Trabajos en curso» sale del menú — la actividad
     se anuncia en la tarjeta y en el punto del menú. */
  assert.ok(html.includes('> Novedades <'), 'el menú llama «Novedades» al buzón de comprobantes');
  assert.ok(!html.includes('id="nav-jobs"'), 'la fila de trabajos en curso ya NO existe en el menú (diseño 11)');
  /* RE-BASE 2.9.13 · mejora 5 (orden directa de Paco en las
     30 mejoras, posterior a la 1.31.0): el contador de
     pendientes de Novedades («buzon-badge», los sin leer del
     RFC elegido) vuelve al menú; los de inventario (dinero,
     tributario) siguen fuera. */
  assert.ok(html.includes('id="buzon-badge"') && !html.includes('id="dinero-badge"') &&
    !html.includes('id="tributario-badge"'), 'el menú lleva el contador de pendientes de Novedades (mejora 5), no los de inventario');
  assert.ok(html.includes('descargarSalida1310'), 'el cliente trae el descargador de reportes');
  /* RE-BASE integración 2.4.0 (W6b): cancelarTramite1310 vive
     en la parte diferida de Descargas; se busca en artefacto +
     parte, con el mismo literal. */
  const lazy1310 = JSON.parse(read('lazy.json'));
  assert.ok((html + lazy1310.partes.descargas.source).includes('cancelarTramite1310'), 'el cliente trae el Cancelar de las tarjetas');
  const servidor = read('local-server.mjs');
  for (const ruta of ['/api/executor/cancel', '/api/cfdi/nota', '/api/cfdi/notas'])
    assert.ok(servidor.includes(ruta), 'el servidor sirve ' + ruta);
  console.log('OK 1.31.0 · estáticas — versión, menú ordenado y piezas nuevas cableadas.');
}

/* ===== 1 · PROTOCOLO accesoOk y plan por textos ===== */
{
  const job = buildExecutorJob({ rfc: OWN, kind: 'buzon-listar' });
  assert.ok(job.plan.some(paso => paso.url === '' && /Mis notificaciones/.test(paso.paso)),
    'el plan del Buzón sigue «Mis notificaciones» por su texto, sin URL del lanzador');
  const base = { operations: ['entrar-con-efirma', 'leer-lista'], notifications: [], steps: [] };
  assert.equal(validateExecutorResult(job, { ...base, accesoOk: true }).accesoOk, true,
    'accesoOk true acredita el acceso');
  assert.equal(validateExecutorResult(job, { ...base }).accesoOk, false,
    'sin accesoOk no hay acceso acreditado');
  assert.equal(validateExecutorResult(job, { ...base, accesoOk: 'true' }).accesoOk, false,
    'accesoOk como texto NO acredita: solo el booleano');
  console.log('OK 1.31.0 · protocolo — accesoOk estricto y plan del Buzón por textos.');
}

/* ===== 2+3+4+5 · SERVIDOR: puerta, registro, cancelar, reportes ===== */
{
  const h = makeHarness({ executorMode: 'remote' });
  await unlock(h, OWN);
  const par = await h.call('POST', '/api/executor/pair', { nombre: 'Equipo de Paco' });
  assert.equal(par.status, 200);
  const tokenEjecutor = par.json.token;
  const encolarReclamar = async kind => {
    const enc = await h.call('POST', '/api/executor/jobs', { rfc: OWN, kind, payload: {} });
    assert.equal(enc.status, 200, 'se encola ' + kind);
    const claim = await h.exec('POST', '/api/executor/claim', { limit: 5 }, tokenEjecutor);
    const trabajo = claim.json.trabajos.find(t => t.id === enc.json.job.id);
    assert.ok(trabajo, 'el ejecutor reclama ' + kind);
    return trabajo;
  };

  /* La puerta cae primero: veredicto «no abre» (la fila falsa). */
  const puertaJob = await encolarReclamar('puerta-probar');
  const falloPuerta = await h.exec('POST', '/api/executor/result', { jobId: puertaJob.id, status: 'failed',
    result: { steps: [{ at: 1, paso: 'Acceso', detalle: '' }], operations: ['entrar-con-efirma'],
      error: 'Este perfil no tiene una e.firma guardada en PacoSAT.', errorKind: 'sin-efirma' } }, tokenEjecutor);
  assert.equal(falloPuerta.json.ok, false);
  let estado = (await h.call('GET', '/api/status')).json;
  assert.equal(estado.puerta[OWN].ok, false, 'tras la prueba fallida la puerta consta «no abre»');

  /* El Buzón entra (accesoOk) y cae en el pasillo: la puerta se
     refresca a «abre» porque el acceso real manda (A4). */
  const buzonJob = await encolarReclamar('buzon-listar');
  const falloBuzon = await h.exec('POST', '/api/executor/result', { jobId: buzonJob.id, status: 'failed',
    result: { steps: [{ at: 1, paso: 'Acceso al portal OK', detalle: '' }], operations: ['entrar-con-efirma', 'leer-lista'],
      notifications: [], accesoOk: true,
      error: 'La bandeja no apareció tras «Mis notificaciones».', errorKind: 'respuesta-inesperada' } }, tokenEjecutor);
  assert.equal(falloBuzon.json.ok, false, 'el trabajo del Buzón consta fallido: lo que cayó fue el pasillo');
  estado = (await h.call('GET', '/api/status')).json;
  assert.equal(estado.puerta[OWN].ok, true, 'A4: el acceso real refresca la puerta a «abre» aunque el trámite caiga');

  /* A2: el fallo del Buzón aparece UNA sola vez en el Registro —
     la entrada del trámite — y el intento sin espejo
     (puerta-probar) conserva la suya. */
  const registro = (await h.call('GET', '/api/registro?limit=300')).json;
  const delBuzon = registro.items.filter(item => /Buzón Tributario/.test(item.texto) && item.ok === false);
  assert.equal(delBuzon.length, 1, 'A2: el fallo del Buzón tiene exactamente una entrada en el Registro');
  assert.ok(!registro.items.some(item => /El ejecutor local no pudo con «buzon-listar»/.test(item.texto)),
    'A2: la entrada gemela del intento del Buzón no se pinta');
  assert.ok(registro.items.some(item => /puerta-probar/.test(item.texto)),
    'A2: el intento sin espejo (puerta-probar) conserva su entrada');

  /* A3 en cola: cancelar saca el trabajo de la cola. */
  const encCola = await h.call('POST', '/api/executor/jobs', { rfc: OWN, kind: 'buzon-listar', payload: {} });
  assert.equal(encCola.status, 200);
  const cancelaCola = await h.call('POST', '/api/executor/cancel', { jobId: encCola.json.job.id });
  assert.equal(cancelaCola.status, 200, 'cancelar en cola responde bien');
  const claimTras = await h.exec('POST', '/api/executor/claim', { limit: 5 }, tokenEjecutor);
  assert.ok(!claimTras.json.trabajos.some(t => t.id === encCola.json.job.id),
    'A3: el trabajo cancelado en cola no lo reclama nadie');

  /* A3 en curso: el latido lleva la cancelación y el resultado
     que llega se descarta entero. */
  const cursoJob = await encolarReclamar('buzon-listar');
  const cancelaCurso = await h.call('POST', '/api/executor/cancel', { jobId: cursoJob.id });
  assert.equal(cancelaCurso.status, 200, 'cancelar en curso responde bien');
  const latido = await h.exec('POST', '/api/executor/heartbeat', {}, tokenEjecutor);
  assert.ok((latido.json.cancelados || []).includes(cursoJob.id),
    'A3: el latido le dice al ejecutor qué trabajo suyo fue cancelado');
  const tardio = await h.exec('POST', '/api/executor/result', { jobId: cursoJob.id, status: 'done',
    result: { steps: [{ at: 1, paso: 'Acceso al portal OK', detalle: '' }], operations: ['entrar-con-efirma', 'leer-lista'],
      accesoOk: true,
      notifications: [{ fecha: '13/11/2026', asunto: 'No debió guardarse', remitente: 'SAT', estado: 'No leída', abierta: false }] } },
    tokenEjecutor);
  assert.equal(tardio.json.cancelado, true, 'A3: el resultado tardío se reconoce como cancelado');
  const trib = (await h.call('GET', '/api/tributario?rfc=' + OWN)).json;
  assert.equal((trib.notificaciones || []).length, 0,
    'A3: lo parcial de un trabajo cancelado NO se guarda (la notificación no existe)');

  /* D: los reportes nuevos salen como archivos de verdad (el
     sobre de salidas trae el contenido en base64, como todas:
     se decodifica y se comprueba la firma del archivo). */
  const firma = r => Buffer.from(r.json.content || '', 'base64').slice(0, 4).toString('latin1');
  const xlsxTotales = await h.call('POST', '/api/salidas/xlsx', { kind: 'totales', rfc: OWN, year: '2026' });
  assert.equal(xlsxTotales.status, 200); assert.equal(firma(xlsxTotales).slice(0, 2), 'PK', 'Totales sale en .xlsx real');
  const xlsxDecl = await h.call('POST', '/api/salidas/xlsx', { kind: 'declaraciones', rfc: OWN, year: '2026' });
  assert.equal(xlsxDecl.status, 200); assert.equal(firma(xlsxDecl).slice(0, 2), 'PK', 'Declaraciones sale en .xlsx real');
  const xlsxAvisos = await h.call('POST', '/api/salidas/xlsx', { kind: 'avisos', rfc: OWN });
  assert.equal(xlsxAvisos.status, 200); assert.equal(firma(xlsxAvisos).slice(0, 2), 'PK', 'Avisos sale en .xlsx real');
  const xlsxDinero = await h.call('POST', '/api/salidas/xlsx', { kind: 'dinero', rfc: OWN, month: '2026-10' });
  assert.equal(xlsxDinero.status, 200); assert.equal(firma(xlsxDinero).slice(0, 2), 'PK', 'Dinero sale en .xlsx real');
  const pdfTotales = await h.call('POST', '/api/salidas/pdf', { kind: 'totales', rfc: OWN, year: '2026' });
  assert.equal(pdfTotales.status, 200); assert.equal(firma(pdfTotales), '%PDF', 'Totales sale en PDF real');
  const pdfAvisos = await h.call('POST', '/api/salidas/pdf', { kind: 'avisos', rfc: OWN });
  assert.equal(pdfAvisos.status, 200); assert.equal(firma(pdfAvisos), '%PDF', 'Avisos sale en PDF real');

  /* F12: la nota de un CFDI se guarda y se lee. */
  const UUID = '12345678-1234-1234-1234-1234567890AB';
  const nota = await h.call('POST', '/api/cfdi/nota', { uuid: UUID, nota: 'Esto es la renta de diciembre' });
  assert.equal(nota.status, 200);
  const notas = (await h.call('GET', '/api/cfdi/notas')).json;
  assert.equal(notas.notas[UUID], 'Esto es la renta de diciembre', 'F12: la nota queda guardada en su mapa');

  await h.service.close();
  console.log('OK 1.31.0 · servidor — puerta veraz, registro sin gemelos, cancelar que descarta y reportes reales.');
}

console.log('Ronda 1.31.0: batería completa en verde.');
