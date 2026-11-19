import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DOMParser } from '@xmldom/xmldom';
import { createPacoSATService } from './local-server.mjs';
import { parseXml } from './xml-core.mjs';
import { buildExecutorJob, validateExecutorResult } from './sat-executor.mjs';

/* ================================================================
   Ronda 2.3.0 · SERVIDOR-2 (integración) — las piezas juzgadas
   contra su contrato:
   6) «Seguir» tras cancelar (POST /api/trabajos/seguir, siempre
      { ok, texto } en llano): declaraciones del ejecutor solo
      con lo que falta + operacionesConAcuse de punta a punta;
      otros tipos relanzados limpios; CFDI del servidor solo por
      los tramos sin cubrir; progreso conservado en el resumen;
      residencia del latido guardada y expuesta en /api/status.
   10) GET /api/cambios: cambios reales desde ayer 00:00 casa,
      sin ruido ni repetidos, máximo 8.
   11) GET /api/foto-rfc: la foto de cada RFC seguido, de las
      fuentes de siempre (puerta, Buzón, resumen de
      declaraciones, cruce de listas, paleta cerrada).
   14) Acuse programado del día 18: una vez al mes por RFC, con
      ejecutor encola y avisa CON DATOS; sin ejecutor, consta.
   15) decl_folios.fechaPresentacion: se guarda por los dos
      caminos de transacciones y el cruce la usa.
   16) Tarjeta push en Salud desde push_subscriptions.
   Cierres: el CSV del Registro honra texto=; el formato de la
   conciliación que manda el cliente (pdf|xlsx) es el servido.
   Cada bloque puede FALLAR donde el comportamiento no exista.
   ================================================================ */

const ORIGIN = 'https://pacosat.test';
const KEY = 'd'.repeat(64);
const OWN = 'AAA010101AAA';
const BBB = 'BBB010101BB1';
const PDF_OK = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(300, 0x41)]);
const PDF_B64 = PDF_OK.toString('base64');

function makeHarness(options = {}) {
  const clock = { t: Date.parse('2026-11-16T15:00:00Z') };
  const mails = [];
  const service = createPacoSATService({
    dbFile: ':memory:', html: '<html><head><!--PACOSAT_TOKEN--></head><body>prueba</body></html>',
    origin: ORIGIN, proxyKey: KEY, satDocRetryWaitMs: 5,
    makeConnector: () => ({ parser: DOMParser, connector: {
      request: async () => 'req-230-1', check: async () => ({ status: 'pending', packages: [] }),
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
  const callAs = async (otroToken, method, path, body) => {
    const r = await raw(method, path, body, { 'x-pacosat-token': otroToken });
    let json = null; try { json = JSON.parse(r.text); } catch { /* binario */ }
    return { status: r.status, json, text: r.text };
  };
  const exec = async (method, path, body, execToken) => {
    const r = await raw(method, path, body, execToken ? { 'x-pacosat-executor': execToken } : {});
    let json = null; try { json = JSON.parse(r.text); } catch { /* binario */ }
    return { status: r.status, json, text: r.text };
  };
  return { service, call, callAs, raw, exec, mails, clock };
}
const unlock = async (h, rfc) => {
  const open = await h.call('POST', '/api/unlock', { rfc, minutes: 1440, days: 7,
    direction: 'both', password: 'simulated', certificate: 'YQ==', key: 'Yg==' });
  assert.equal(open.status, 200, 'unlock de ' + rfc);
};
const dirTemporal = () => mkdtempSync(join(tmpdir(), 'pacosat-230s2-'));
const abrirDb = file => new DatabaseSync(file);

/* ---------- 6-U · Admisiones de sat-executor (unidad) ---------- */
{
  const conAcuse = buildExecutorJob({ rfc: OWN, kind: 'declaraciones-recuperar',
    payload: { soloFaltantes: true, ejercicio: 2026, periodo: '2026-10',
      operacionesConAcuse: ['2626 2010 0100', '262620100100', 'no-es-operación!!', '262620100101'] } });
  assert.deepEqual(conAcuse.payload.operacionesConAcuse, ['262620100100', '262620100101'],
    'operacionesConAcuse sobrevive a buildExecutorJob: saneado, sin espacios ni duplicados');
  const buzon = buildExecutorJob({ rfc: OWN, kind: 'buzon-listar',
    payload: { operacionesConAcuse: ['262620100100'] } });
  assert.equal(buzon.payload.operacionesConAcuse, undefined,
    'fuera de declaraciones-recuperar, el campo no viaja');
  const out = validateExecutorResult(conAcuse, { operations: ['entrar-con-efirma'],
    progreso: { operacionesCompletadas: ['262620100101', '2626 2010 0101'] }, documents: [] });
  assert.deepEqual(out.operacionesCompletadas, ['262620100101'],
    'el progreso anidado en «progreso» (la forma real del ejecutor) llega saneado a la raíz');
  console.log('OK 2.3.0 S2 · 6-U: admisiones de operacionesConAcuse y del progreso anidado.');
}

/* ---------- 6-A · Seguir una recuperación de declaraciones ---------- */
{
  const h = makeHarness({ executorMode: 'remote' });
  await unlock(h, OWN);
  const par = await h.call('POST', '/api/executor/pair', { nombre: 'Equipo de Paco' });
  const execToken = par.json.token;
  assert.ok(execToken, 'ejecutor emparejado');

  /* Semilla del cruce: una corrida que archiva el acuse de
     septiembre — esa operación ya «tiene acuse». */
  const semilla = await h.call('POST', '/api/executor/jobs',
    { rfc: OWN, kind: 'declaraciones-recuperar', payload: { ejercicio: 2026, periodo: '2026-09' } });
  const claim1 = await h.exec('POST', '/api/executor/claim', { limit: 5 }, execToken);
  const t1 = claim1.json.trabajos.find(t => t.id === semilla.json.job.id);
  const r1 = await h.exec('POST', '/api/executor/result', { jobId: t1.id, status: 'done',
    result: { operations: ['entrar-con-efirma', 'descargar-pdf'],
      documents: [{ clase: 'acuse', tipo: 'mensual', ejercicio: 2026, periodo: '2026-09',
        fechaPresentacion: '17/10/2026', operacion: '262620090100', contentBase64: PDF_B64 }] } }, execToken);
  assert.equal(r1.json.ok, true, 'la corrida semilla se cierra');

  /* La recuperación de octubre se cancela a medias. */
  const enc = await h.call('POST', '/api/executor/jobs',
    { rfc: OWN, kind: 'declaraciones-recuperar', payload: { ejercicio: 2026, periodo: '2026-10', tipo: 'mensual' } });
  const cancelado = await h.call('POST', '/api/executor/cancel', { jobId: enc.json.job.id });
  assert.equal(cancelado.json.ok, true, 'el trabajo queda cancelado');

  const seguir = await h.call('POST', '/api/trabajos/seguir', { jobId: enc.json.job.id });
  assert.equal(seguir.status, 200, 'seguir responde 200 con su texto');
  assert.equal(seguir.json.ok, true, 'seguir una recuperación cancelada: ok');
  assert.match(seguir.json.texto, /solo se pedirá lo que falta/, 'el texto dice que solo se pide lo que falta');
  assert.match(seguir.json.texto, /no se repetirán/, 'y que lo que ya tiene acuse no se repite');

  const overview = (await h.call('GET', '/api/executor/overview')).json;
  const nuevo = overview.trabajos.find(t => t.kind === 'declaraciones-recuperar' && t.id !== enc.json.job.id && t.estado === 'en-cola');
  assert.ok(nuevo, 'hay un trabajo nuevo en cola');
  assert.equal(nuevo.payload.soloFaltantes, true, 'el nuevo pide solo faltantes');
  assert.equal(nuevo.payload.ejercicio, 2026);
  assert.equal(nuevo.payload.periodo, '2026-10');
  assert.equal(nuevo.payload.tipo, 'mensual', 'el tipo del original se conserva');
  assert.deepEqual(nuevo.payload.operacionesConAcuse, ['262620090100'],
    'operacionesConAcuse = las operaciones con acuse del cruce, ni una más');

  /* El ejecutor lo reclama: el payload llega entero a su vista. */
  const claim2 = await h.exec('POST', '/api/executor/claim', { limit: 5 }, execToken);
  const t2 = claim2.json.trabajos.find(t => t.id === nuevo.id);
  assert.ok(t2, 'el ejecutor reclama el trabajo seguido');
  assert.deepEqual(t2.payload.operacionesConAcuse, ['262620090100'],
    'operacionesConAcuse sobrevive hasta la vista del ejecutor');

  /* Y su resultado trae el progreso ANIDADO (la forma real):
     queda guardado en el resumen del trabajo. */
  const r2 = await h.exec('POST', '/api/executor/result', { jobId: t2.id, status: 'done',
    result: { operations: ['entrar-con-efirma', 'consultar-transacciones', 'descargar-pdf'],
      progreso: { operacionesCompletadas: ['262620100101'] },
      documents: [{ clase: 'acuse', tipo: 'mensual', ejercicio: 2026, periodo: '2026-10',
        fechaPresentacion: '17/11/2026', operacion: '262620100101', contentBase64: PDF_B64 }] } }, execToken);
  assert.equal(r2.json.ok, true, 'el resultado del trabajo seguido se cierra');
  const overview2 = (await h.call('GET', '/api/executor/overview')).json;
  const hecho = overview2.trabajos.find(t => t.id === nuevo.id);
  assert.deepEqual(hecho.resumen.operacionesCompletadas, ['262620100101'],
    'el progreso queda guardado en el registro del trabajo');
  const decl = (await h.call('GET', '/api/declaraciones?rfc=' + OWN + '&ejercicio=2026')).json;
  const entrada = decl.cruce201.operacionesConocidas.find(e => e.operacion === '262620100101');
  assert.ok(entrada?.tieneAcuse, 'el acuse seguido consta en el cruce');
  await h.service.close();
  console.log('OK 2.3.0 S2 · 6-A: seguir declaraciones — solo faltantes, con acuse, progreso conservado.');
}

/* ---------- 6-B · Seguir: otros tipos y los «no» en llano ---------- */
{
  const h = makeHarness({ executorMode: 'remote' });
  await unlock(h, OWN);
  const par = await h.call('POST', '/api/executor/pair', { nombre: 'Equipo de Paco' });
  assert.ok(par.json.token, 'ejecutor emparejado');

  const enc = await h.call('POST', '/api/executor/jobs', { rfc: OWN, kind: 'buzon-listar', payload: {} });
  await h.call('POST', '/api/executor/cancel', { jobId: enc.json.job.id });
  const seguir = await h.call('POST', '/api/trabajos/seguir', { jobId: enc.json.job.id });
  assert.equal(seguir.json.ok, true, 'un buzón cancelado se sigue');
  assert.match(seguir.json.texto, /empieza limpio/, 'el texto dice que ese tipo se relanza limpio');
  const overview = (await h.call('GET', '/api/executor/overview')).json;
  assert.ok(overview.trabajos.some(t => t.kind === 'buzon-listar' && t.id !== enc.json.job.id && t.estado === 'en-cola'),
    'el buzón nuevo está en cola, idéntico');

  const vivo = await h.call('POST', '/api/executor/jobs', { rfc: OWN, kind: 'puerta-probar', payload: {} });
  const noCancelado = await h.call('POST', '/api/trabajos/seguir', { jobId: vivo.json.job.id });
  assert.equal(noCancelado.json.ok, false, 'un trabajo vivo no se sigue');
  assert.match(noCancelado.json.texto, /no está cancelado/, 'y el motivo va en llano');

  const inexistente = await h.call('POST', '/api/trabajos/seguir', { jobId: '00000000-0000-4000-8000-000000000000' });
  assert.equal(inexistente.json.ok, false);
  assert.match(inexistente.json.texto, /ya no existe/, 'lo que no existe se dice en llano');

  const compuesto = await h.call('POST', '/api/trabajos/seguir', { jobId: 'doc:corrida-cualquiera' });
  assert.equal(compuesto.json.ok, false);
  assert.match(compuesto.json.texto, /no se sigue desde aquí/, 'una corrida del servidor no se sigue desde aquí');

  const sinId = await h.call('POST', '/api/trabajos/seguir', {});
  assert.equal(sinId.json.ok, false, 'sin id, ok:false en llano — nunca un error técnico');
  await h.service.close();
  console.log('OK 2.3.0 S2 · 6-B: relanzamiento limpio y los «no» en llano.');
}

/* ---------- 6-C · Seguir una descarga CFDI: solo los tramos sin cubrir ---------- */
{
  const dir = dirTemporal();
  const file = join(dir, 'pacosat.db');
  const h = makeHarness({ dbFile: file });
  await unlock(h, OWN);
  const pedida = await h.call('POST', '/api/request',
    { rfc: OWN, direction: 'issued', start: '2026-10-01', end: '2026-10-31' });
  assert.equal(pedida.status, 200, 'la descarga de octubre se pide');
  const db = abrirDb(file);
  const fila = db.prepare("SELECT id FROM jobs WHERE rfc=? AND status='pending' ORDER BY id DESC LIMIT 1").get(OWN);
  db.close();
  assert.ok(fila?.id, 'la descarga quedó registrada');
  const cancelada = await h.call('POST', '/api/sat/cancel-job', { id: fila.id });
  assert.equal(cancelada.json.ok, true, 'la descarga queda cancelada');

  const seguir = await h.call('POST', '/api/trabajos/seguir', { jobId: 'job:' + fila.id });
  assert.equal(seguir.json.ok, true, 'seguir la descarga cancelada: ok — ' + (seguir.json.texto || ''));
  assert.match(seguir.json.texto, /solo lo que faltaba/, 'el texto dice que solo se pidió lo que faltaba');
  const db2 = abrirDb(file);
  const nuevas = db2.prepare("SELECT * FROM jobs WHERE rfc=? AND status='pending'").all(OWN);
  assert.equal(nuevas.length, 1, 'una sola solicitud nueva cubre el tramo que faltaba');
  assert.ok(nuevas[0].startAt >= '2026-10-01 00:00:00' && nuevas[0].startAt <= '2026-10-01 00:00:10' &&
    nuevas[0].endAt >= '2026-10-31 23:59:59',
    'el tramo nuevo cubre la ventana de octubre (con la variante de segundos de la casa, si el criterio exacto ya se usó)');
  /* Ventana ya cubierta por otra descarga terminada: no se sigue. */
  const t = Date.parse('2026-11-10T12:00:00Z');
  db2.prepare("INSERT INTO jobs(rfc,direction,kind,periodStart,periodEnd,startAt,endAt,requestId,status,due,created) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run(OWN, 'issued', 'cfdi', '2026-09-01', '2026-09-30', '2026-09-01 00:00:00', '2026-09-30 23:59:59', 'req-fin', 'finished', t, t);
  const cubierta = db2.prepare("INSERT INTO jobs(rfc,direction,kind,periodStart,periodEnd,startAt,endAt,requestId,status,due,created) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run(OWN, 'issued', 'cfdi', '2026-09-01', '2026-09-30', '2026-09-01 00:00:00', '2026-09-30 23:59:59', 'req-canc', 'cancelled', t, t);
  db2.close();
  const noSeSigue = await h.call('POST', '/api/trabajos/seguir', { jobId: 'job:' + cubierta.lastInsertRowid });
  assert.equal(noSeSigue.json.ok, false, 'una ventana ya cubierta no se sigue');
  assert.match(noSeSigue.json.texto, /ya quedó cubierta/, 'y el motivo va en llano');
  await h.service.close();

  /* Sin desbloqueo no se finge: el motivo pide desbloquear. */
  const h2 = makeHarness({ dbFile: join(dir, 'pacosat2.db') });
  const db3 = abrirDb(join(dir, 'pacosat2.db'));
  db3.prepare("INSERT INTO profiles(rfc,minutes,days,direction) VALUES (?,?,?,?)").run(OWN, 1440, 7, 'both');
  const t2 = Date.parse('2026-11-10T12:00:00Z');
  const fila2 = db3.prepare("INSERT INTO jobs(rfc,direction,kind,periodStart,periodEnd,startAt,endAt,requestId,status,due,created) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run(OWN, 'issued', 'cfdi', '2026-08-01', '2026-08-31', '2026-08-01 00:00:00', '2026-08-31 23:59:59', 'req-x', 'cancelled', t2, t2);
  db3.close();
  const bloqueado = await h2.call('POST', '/api/trabajos/seguir', { jobId: 'job:' + fila2.lastInsertRowid });
  assert.equal(bloqueado.json.ok, false, 'sin e.firma desbloqueada no se sigue');
  assert.match(bloqueado.json.texto, /no está desbloqueada/, 'el motivo pide desbloquear, en llano');
  await h2.service.close();
  rmSync(dir, { recursive: true, force: true });
  console.log('OK 2.3.0 S2 · 6-C: seguir CFDI por tramos sin cubrir; cubierta y bloqueada, en llano.');
}

/* ---------- 6-D · La residencia del latido se guarda y se expone ---------- */
{
  const h = makeHarness({ executorMode: 'remote' });
  await unlock(h, OWN);
  const par = await h.call('POST', '/api/executor/pair', { nombre: 'Equipo de Paco' });
  const execToken = par.json.token;
  await h.exec('POST', '/api/executor/heartbeat', {}, execToken);
  let estado = (await h.call('GET', '/api/status')).json;
  assert.equal(estado.ejecutor.residencia, undefined,
    'un ejecutor que no reporta residencia deja el campo AUSENTE (sin reportar todavía)');
  const latido = await h.exec('POST', '/api/executor/heartbeat',
    { residencia: { registrada: true, protocolo: true, rechazada: false, instancias: 2 } }, execToken);
  assert.equal(latido.json.ok, true, 'el latido con residencia se acepta');
  estado = (await h.call('GET', '/api/status')).json;
  assert.deepEqual(estado.ejecutor.residencia,
    { registrada: true, protocolo: true, rechazada: false, instancias: 2 },
    'la residencia sale en /api/status con la forma exacta del contrato');
  await h.exec('POST', '/api/executor/heartbeat', {}, execToken);
  estado = (await h.call('GET', '/api/status')).json;
  assert.deepEqual(estado.ejecutor.residencia,
    { registrada: true, protocolo: true, rechazada: false, instancias: 2 },
    'un latido sin residencia no borra el último reporte');
  await h.service.close();
  console.log('OK 2.3.0 S2 · 6-D: residencia guardada en el latido y expuesta; ausente sin reporte.');
}

/* ---------- 10 · Qué cambió desde ayer ---------- */
{
  const dir = dirTemporal();
  const file = join(dir, 'pacosat.db');
  const h = makeHarness({ dbFile: file });
  await unlock(h, OWN);
  const db = abrirDb(file);
  const dentro = Date.parse('2026-11-15T18:00:00Z');   /* 12:00 en casa del 15: dentro de la ventana */
  const hoy = Date.parse('2026-11-16T14:00:00Z');      /* 08:00 en casa del 16 */
  const fuera = Date.parse('2026-11-14T18:00:00Z');    /* el 14: fuera */
  db.prepare("INSERT INTO decl_runs(id,rfc,tipo,ejercicio,periodo,started,finished,ok,error,steps) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run('run-ok', OWN, 'mensual', 2026, '2026-10', dentro, dentro, 1, '', '[]');
  db.prepare("INSERT INTO decl_runs(id,rfc,tipo,ejercicio,periodo,started,finished,ok,error,steps) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run('run-vieja', OWN, 'mensual', 2026, '2026-09', fuera, fuera, 1, '', '[]');
  db.prepare("INSERT INTO decl_runs(id,rfc,tipo,ejercicio,periodo,started,finished,ok,error,steps) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run('run-fallo', OWN, 'mensual', 2026, '2026-10', hoy, hoy, 0, 'El SAT no respondió', '[]');
  db.prepare("INSERT INTO audit_events(at,clase,rfc,texto,ok) VALUES (?,?,?,?,?)")
    .run(hoy, 'accion', OWN, 'Apuntó un gasto de prueba en los libros', 1);
  db.prepare("INSERT INTO audit_events(at,clase,rfc,texto,ok) VALUES (?,?,?,?,?)")
    .run(hoy + 60000, 'accion', OWN, 'Apuntó un gasto de prueba en los libros', 1);
  db.prepare("INSERT INTO audit_events(at,clase,rfc,texto,ok) VALUES (?,?,?,?,?)")
    .run(hoy, 'sistema', '', 'PacoSAT arrancó en el servidor', 1);
  db.prepare("INSERT INTO audit_events(at,clase,rfc,texto,ok) VALUES (?,?,?,?,?)")
    .run(hoy, 'accion', OWN, 'Trabajo para el ejecutor local del SAT: «Buzón Tributario» de ' + OWN, 1);
  db.prepare("INSERT INTO access_log(at,kind,detail) VALUES (?,?,?)").run(hoy, 'login-ok', '');
  db.close();

  const cambios = (await h.call('GET', '/api/cambios?rfc=' + OWN)).json;
  assert.equal(cambios.desde, Date.parse('2026-11-15T00:00:00-06:00'),
    'la ventana abre ayer a las 00:00, hora de casa');
  assert.ok(cambios.lineas.length <= 8, 'máximo 8 líneas');
  const textos = cambios.lineas.map(l => l.texto);
  const conexion = cambios.lineas.find(l => /Recuperó declaraciones 2026-10/.test(l.texto));
  assert.ok(conexion, 'una conexión terminada en algo SÍ es un cambio');
  assert.equal(conexion.clase, 'bien', 'y su clase de salida es «bien» (verde en la pantalla)');
  assert.ok(textos.some(t => t === 'Apuntó un gasto de prueba en los libros'), 'una acción hecha es un cambio');
  assert.equal(textos.filter(t => t === 'Apuntó un gasto de prueba en los libros').length, 1,
    'el mismo cambio dos veces sale UNA vez');
  assert.ok(!textos.some(t => /no respondió|no se pudo/i.test(t)), 'un «no se pudo» es un aviso, no un cambio: fuera');
  assert.ok(!textos.some(t => /arrancó/.test(t)), 'los arranques son ruido: fuera');
  assert.ok(!textos.some(t => /Trabajo para el ejecutor/.test(t)), 'encolar no es cambiar: fuera');
  assert.ok(!textos.some(t => /Entrada a PacoSAT/.test(t)), 'entrar a la app no es un cambio: fuera');
  assert.ok(!textos.some(t => /2026-09/.test(t)), 'lo de antes de ayer queda fuera de la ventana');
  assert.ok(cambios.lineas.every((l, i, a) => i === 0 || a[i - 1].at >= l.at), 'del más reciente al más antiguo');

  /* El invitado solo ve su alcance. */
  await h.call('POST', '/api/guest/config', { password: 'invitado-230', enabled: true, rfcs: [BBB] });
  const login = await h.call('POST', '/api/guest/login', { password: 'invitado-230' });
  const guestToken = login.json.token;
  assert.ok(guestToken, 'sesión de invitado emitida');
  const fueraAlcance = (await h.callAs(guestToken, 'GET', '/api/cambios?rfc=' + OWN)).json;
  assert.deepEqual(fueraAlcance.lineas, [], 'con rfc= fuera de su alcance, el invitado no ve ningún cambio');
  const suAlcance = (await h.callAs(guestToken, 'GET', '/api/cambios')).json;
  assert.deepEqual(suAlcance.lineas, [], 'sin rfc=, solo salen cambios de SUS RFC (ninguno sembrado)');
  await h.service.close();
  rmSync(dir, { recursive: true, force: true });
  console.log('OK 2.3.0 S2 · 10: cambios reales desde ayer, sin ruido ni repetidos; invitado en su alcance.');
}

/* ---------- 11 · La foto de cada RFC ---------- */
{
  const dir = dirTemporal();
  const file = join(dir, 'pacosat.db');
  const h = makeHarness({ dbFile: file });
  await unlock(h, OWN);
  await h.call('POST', '/api/storage', { batch: {
    people: [{ id: OWN, name: 'EMPRESA PROPIA SA' }] } });
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital" Version="4.0" Fecha="2026-10-05T10:00:00" SubTotal="100.00" Moneda="MXN" Total="116.00" TipoDeComprobante="I" MetodoPago="PPD" FormaPago="99" LugarExpedicion="72000">
<cfdi:Emisor Rfc="${BBB}" Nombre="PROVEEDOR SA" RegimenFiscal="601"/>
<cfdi:Receptor Rfc="${OWN}" Nombre="EMPRESA PROPIA SA" DomicilioFiscalReceptor="72000" RegimenFiscalReceptor="601" UsoCFDI="G03"/>
<cfdi:Conceptos><cfdi:Concepto ClaveProdServ="01010101" Cantidad="1" ClaveUnidad="H87" Descripcion="Servicio" ValorUnitario="100.00" Importe="100.00" ObjetoImp="02"><cfdi:Impuestos><cfdi:Traslados><cfdi:Traslado Base="100.00" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="16.00"/></cfdi:Traslados></cfdi:Impuestos></cfdi:Concepto></cfdi:Conceptos>
<cfdi:Impuestos TotalImpuestosTrasladados="16.00"><cfdi:Traslados><cfdi:Traslado Base="100.00" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="16.00"/></cfdi:Traslados></cfdi:Impuestos>
<cfdi:Complemento><tfd:TimbreFiscalDigital Version="1.1" UUID="12345678-1234-4234-8234-1234567890ab" FechaTimbrado="2026-10-05T10:00:00" RfcProvCertif="SAT970701NN3" SelloCFD="AAAAAAAA" NoCertificadoSAT="00001000000500000001" SelloSAT="BBBB"/></cfdi:Complemento>
</cfdi:Comprobante>`;
  const row = parseXml(Buffer.from(xml), DOMParser);
  await h.call('POST', '/api/storage', { batch: {
    people: [{ id: BBB, name: 'PROVEEDOR SA' }],
    invoices: [row],
    files: [{ id: 'xml:' + row.id, mime: 'application/xml', content: Buffer.from(xml).toString('base64') }] } });
  const color = await h.call('POST', '/api/settings', { rfcColor: { rfc: OWN, color: 'azul' } });
  assert.equal(color.status, 200, 'el color se asigna en la paleta cerrada');
  const T = Date.parse('2026-11-15T12:00:00Z');
  const db = abrirDb(file);
  db.prepare("INSERT INTO sat_puerta(rfc,ok,probada,error,errorKind) VALUES (?,?,?,?,?)").run(OWN, 1, T, '', '');
  db.prepare("INSERT INTO trib_runs(id,rfc,started,finished,ok,error,sinAbrir,comunicados) VALUES (?,?,?,?,?,?,?,?)")
    .run('trib-1', OWN, T, T, 1, '', 2, 3);
  db.prepare("INSERT INTO trib_notifications(rfc,clave,fecha,asunto,remitente,estado,abierta,primeraVez,ultimaVez,categoria) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run(OWN, 'notif-1', '2026-11-14', 'Aviso de prueba 1', 'SAT', 'nuevo', 0, T, T, 'atencion');
  db.prepare("INSERT INTO trib_notifications(rfc,clave,fecha,asunto,remitente,estado,abierta,primeraVez,ultimaVez,categoria) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run(OWN, 'notif-2', '2026-11-14', 'Aviso de prueba 2', 'SAT', 'nuevo', 0, T, T, 'atencion');
  db.prepare("INSERT INTO decl_folios(id,rfc,tipo,ejercicio,periodo,folio,estado,nota,fechaPresentacion,creado,actualizado) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run('folio-1', OWN, 'mensual', 2026, '2026-09', '262620090100', 'con-acuse', '', '17/10/2026', T, T);
  /* El propio RFC señalado en un listado: la foto de Listas
     por RFC de la casa (listsResumenPanel201) enseña, por RFC
     propio, SUS hits — «Señalado en…» o «Limpio». */
  db.prepare("INSERT INTO blacklist_entries(listId,rfc,name,detail) VALUES (?,?,?,?)")
    .run('69b', OWN, 'EMPRESA PROPIA SA', 'Definitivo');
  db.prepare("INSERT INTO blacklist_meta(listId,fetched,next,count,declared,error) VALUES (?,?,?,?,?,?)")
    .run('69b', T, 0, 1, '', '');
  db.prepare("INSERT INTO pending_profiles(rfc,created,nota) VALUES (?,?,?)").run('CCC010101CC1', T, '');
  db.close();

  const foto = (await h.call('GET', '/api/foto-rfc')).json;
  const propia = foto.rfcs.find(e => e.rfc === OWN);
  assert.ok(propia, 'la foto trae el RFC con perfil');
  assert.equal(propia.nombre, 'EMPRESA PROPIA SA', 'el nombre sale del registro de personas');
  assert.equal(propia.color, 'azul', 'el color es el asignado en la paleta cerrada');
  assert.deepEqual(propia.puerta, { ok: true, fecha: T }, 'la puerta: su estado guardado y cuándo se probó');
  assert.deepEqual(propia.buzon, { pendientes: 2, comunicados: 3, fecha: T },
    'el Buzón: sin abrir y comunicados de su última consulta, con su fecha');
  assert.equal(propia.declaraciones.ejercicio, 2026, 'declaraciones del ejercicio en curso');
  assert.ok(propia.declaraciones.conocidas >= 1, 'las operaciones conocidas salen del cruce');
  assert.ok(propia.declaraciones.faltaMes === null || /^\d{4}-\d{2}$/.test(propia.declaraciones.faltaMes),
    'faltaMes viaja como periodo AAAA-MM (o null), nunca como un número suelto');
  assert.equal(propia.listas.senaladas, 1, 'el cruce de listas: el propio RFC consta señalado en un listado');
  assert.equal(propia.listas.fecha, T, 'la fecha del último cruce de listas');
  const vigilado = foto.rfcs.find(e => e.rfc === 'CCC010101CC1');
  assert.ok(vigilado, 'los RFC vigilados (sin perfil aún) también salen en la foto');
  assert.deepEqual(vigilado.puerta, { ok: false, fecha: null }, 'sin probar: ok falso y fecha null, sin inventar');
  await h.service.close();
  rmSync(dir, { recursive: true, force: true });
  console.log('OK 2.3.0 S2 · 11: foto por RFC de las fuentes de siempre, con su color de paleta.');
}

/* ---------- 14 · El acuse programado del día 18 ---------- */
{
  const dir = dirTemporal();
  const file = join(dir, 'pacosat.db');
  const h = makeHarness({ dbFile: file, executorMode: 'remote' });
  await unlock(h, OWN);
  const par = await h.call('POST', '/api/executor/pair', { nombre: 'Equipo de Paco' });
  const execToken = par.json.token;
  h.clock.t = Date.parse('2026-11-18T15:00:00Z');
  await h.service.tick();
  const overview = (await h.call('GET', '/api/executor/overview')).json;
  const programados = overview.trabajos.filter(t => t.kind === 'declaraciones-recuperar');
  assert.equal(programados.length, 1, 'el día 18 se encola UNA recuperación programada');
  assert.equal(programados[0].payload.periodo, '2026-10', 'del mes anterior');
  assert.equal(programados[0].payload.ejercicio, 2026);
  assert.equal(programados[0].payload.tipo, 'mensual');
  const registro = (await h.call('GET', '/api/registro?texto=Acuse%20programado&limit=50')).json;
  assert.ok(registro.items.some(i => /Acuse programado del día 18/.test(i.texto) && i.rfc === OWN),
    'la petición programada deja constancia en el Registro');
  await h.service.tick();
  const overview2 = (await h.call('GET', '/api/executor/overview')).json;
  assert.equal(overview2.trabajos.filter(t => t.kind === 'declaraciones-recuperar').length, 1,
    'la guardia manda: un segundo ciclo el mismo mes no duplica');

  /* Al completarse, el aviso sale CON LOS DATOS de la corrida. */
  const claim = await h.exec('POST', '/api/executor/claim', { limit: 5 }, execToken);
  const trabajo = claim.json.trabajos.find(t => t.id === programados[0].id);
  const hecho = await h.exec('POST', '/api/executor/result', { jobId: trabajo.id, status: 'done',
    result: { operations: ['entrar-con-efirma', 'descargar-pdf'],
      documents: [{ clase: 'acuse', tipo: 'mensual', ejercicio: 2026, periodo: '2026-10',
        fechaPresentacion: '17/11/2026', operacion: '262620100155', contentBase64: PDF_B64 }] } }, execToken);
  assert.equal(hecho.json.ok, true, 'la corrida programada se cierra');
  const db = abrirDb(file);
  const aviso = db.prepare("SELECT * FROM alerts WHERE kind='acuse-programado'").get();
  db.close();
  assert.ok(aviso, 'el trabajo programado avisa al completarse');
  assert.match(aviso.subject, /2026-10/, 'el aviso nombra el periodo');
  assert.match(aviso.body, /262620100155/, 'el aviso nombra la operación bajada');
  assert.match(aviso.body, /1 documento/, 'el aviso dice cuántos documentos se guardaron');
  await h.service.close();
  rmSync(dir, { recursive: true, force: true });

  /* Sin ejecutor emparejado: no se encola y consta una vez. */
  const h2 = makeHarness({});
  await unlock(h2, OWN);
  h2.clock.t = Date.parse('2026-11-18T15:00:00Z');
  await h2.service.tick();
  await h2.service.tick();
  const registro2 = (await h2.call('GET', '/api/registro?texto=Acuse%20programado&limit=50')).json;
  const notas = registro2.items.filter(i => /no hay ejecutor emparejado/.test(i.texto));
  assert.equal(notas.length, 1, 'sin ejecutor, la constancia sale UNA vez en el Registro');
  await h2.service.close();
  console.log('OK 2.3.0 S2 · 14: acuse del día 18 — encola, no duplica, avisa con datos; sin ejecutor, consta.');
}

/* ---------- 15 · La fecha de presentación vive en decl_folios ---------- */
{
  /* Camino del ejecutor: la transacción trae la fecha. */
  const h = makeHarness({ executorMode: 'remote' });
  await unlock(h, OWN);
  const par = await h.call('POST', '/api/executor/pair', { nombre: 'Equipo de Paco' });
  const execToken = par.json.token;
  const enc = await h.call('POST', '/api/executor/jobs',
    { rfc: OWN, kind: 'declaraciones-transacciones', payload: { ejercicio: 2026 } });
  const claim = await h.exec('POST', '/api/executor/claim', { limit: 5 }, execToken);
  const trabajo = claim.json.trabajos.find(t => t.id === enc.json.job.id);
  const hecho = await h.exec('POST', '/api/executor/result', { jobId: trabajo.id, status: 'done',
    result: { operations: ['entrar-con-efirma', 'consultar-transacciones'],
      transactions: [{ operacion: '262620080100', tipo: 'mensual', ejercicio: 2026,
        periodo: '2026-08', fechaPresentacion: '17/09/2026' }] } }, execToken);
  assert.equal(hecho.json.ok, true, 'la consulta de transacciones se cierra');
  const decl = (await h.call('GET', '/api/declaraciones?rfc=' + OWN + '&ejercicio=2026')).json;
  const folio = decl.folios.find(f => f.folio === '262620080100');
  /* 2.9.5 · R6: la fecha descubierta es la misma (17/09/2026
     en el portal); lo que cambia es su FORMA al guardarse y
     servirse — ISO, como todo el overview — porque el
     formato crudo del portal era el que rompía la tarjeta
     de Hoy («26//2/16/1»). */
  assert.equal(folio?.fechaPresentacion, '2026-09-17', 'la foto del folio enseña la fecha descubierta, en ISO (2.9.5 · R6)');
  const entrada = decl.cruce201.operacionesConocidas.find(e => e.operacion === '262620080100');
  assert.equal(entrada?.fechaPresentacion, '2026-09-17',
    'el cruce enseña la fecha del folio aunque ningún documento la traiga, en ISO (2.9.5 · R6)');
  await h.service.close();

  /* Camino local: el motor del servidor descubre folios. */
  const h2 = makeHarness({ satDeclFetch: async () => ({ found: 1,
    transactions: [{ operacion: '262620070100', tipo: 'mensual', ejercicio: 2026,
      periodo: '2026-07', fechaPresentacion: '17/08/2026' }] }) });
  await unlock(h2, OWN);
  const descubiertos = await h2.call('POST', '/api/declaraciones/descubrir-folios', { rfc: OWN, ejercicio: 2026 });
  assert.equal(descubiertos.json.result.descubiertos, 1, 'el descubrimiento local aprende el folio');
  const decl2 = (await h2.call('GET', '/api/declaraciones?rfc=' + OWN + '&ejercicio=2026')).json;
  const folio2 = decl2.folios.find(f => f.folio === '262620070100');
  assert.equal(folio2?.fechaPresentacion, '2026-08-17', 'el camino local también guarda la fecha, en ISO (2.9.5 · R6)');
  await h2.service.close();
  console.log('OK 2.3.0 S2 · 15: fechaPresentacion guardada por ambos caminos y usada por el cruce.');
}

/* ---------- 16 · La tarjeta push de Salud ---------- */
{
  const dir = dirTemporal();
  const file = join(dir, 'pacosat.db');
  const h = makeHarness({ dbFile: file });
  let salud = (await h.call('GET', '/api/salud')).json;
  let push = salud.tarjetas.find(t => t.id === 'push');
  assert.ok(push, 'la tarjeta push existe en Salud');
  assert.equal(push.estado, 'vigilar', 'sin aparatos suscritos, la tarjeta vigila');
  assert.equal(push.datos.suscrito, false);
  assert.equal(push.datos.dispositivos, 0);
  assert.equal(push.datos.ultimoEnvio, null, 'sin bitácora de envíos, ultimoEnvio es null — no se inventa');
  assert.match(push.frescuraTexto, /no consta|Sin envíos/, 'la frescura dice que no consta el último envío');
  const db = abrirDb(file);
  db.prepare("INSERT INTO push_subscriptions(endpoint,p256dh,auth,creado) VALUES (?,?,?,?)")
    .run('https://push.example/1', 'clave', 'auth', Date.now());
  db.close();
  salud = (await h.call('GET', '/api/salud')).json;
  push = salud.tarjetas.find(t => t.id === 'push');
  assert.equal(push.estado, 'bien', 'con un aparato suscrito, la tarjeta está bien');
  assert.equal(push.datos.suscrito, true, 'suscrito: hay al menos una suscripción');
  assert.equal(push.datos.dispositivos, 1, 'dispositivos: el conteo real de push_subscriptions');
  assert.equal(push.datos.suscripciones, 1);
  await h.service.close();
  rmSync(dir, { recursive: true, force: true });
  console.log('OK 2.3.0 S2 · 16: tarjeta push desde push_subscriptions, con su ultimoEnvio honesto.');
}

/* ---------- Cierres · CSV con texto= y formato de conciliación ---------- */
{
  const dir = dirTemporal();
  const file = join(dir, 'pacosat.db');
  const h = makeHarness({ dbFile: file });
  await unlock(h, OWN);
  const db = abrirDb(file);
  const T = Date.parse('2026-11-16T12:00:00Z');
  db.prepare("INSERT INTO audit_events(at,clase,rfc,texto,ok) VALUES (?,?,?,?,?)")
    .run(T, 'accion', OWN, 'Marcador CSV alfa de la ronda', 1);
  db.prepare("INSERT INTO audit_events(at,clase,rfc,texto,ok) VALUES (?,?,?,?,?)")
    .run(T, 'accion', OWN, 'Otra cosa sin el marcador', 1);
  db.close();
  const csv = await h.call('GET', '/api/registro/csv?texto=marcador%20csv');
  assert.equal(csv.status, 200, 'el CSV responde');
  assert.match(csv.text, /Marcador CSV alfa/, 'el CSV honra texto=: lo filtrado sale');
  assert.ok(!/Otra cosa sin el marcador/.test(csv.text), 'y lo que el filtro deja fuera, no sale');
  const sinFormato = await h.call('GET', '/api/reportes/conciliacion?rfc=' + OWN + '&mes=2026-10&formato=pdf');
  assert.ok([200, 400].includes(sinFormato.status) && sinFormato.status !== 404,
    'formato=pdf (el que manda el cliente) lo entiende el endpoint');
  const xlsx = await h.call('GET', '/api/reportes/conciliacion?rfc=' + OWN + '&mes=2026-10&formato=xlsx');
  assert.ok([200, 400].includes(xlsx.status) && xlsx.status !== 404,
    'formato=xlsx (el que manda el cliente) lo entiende el endpoint');
  await h.service.close();
  rmSync(dir, { recursive: true, force: true });
  console.log('OK 2.3.0 S2 · cierres: CSV con texto= y formato pdf|xlsx, los del cliente.');
}

console.log('Ronda 2.3.0 · SERVIDOR-2: batería completa en verde.');
