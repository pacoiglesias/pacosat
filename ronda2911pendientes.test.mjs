import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createPacoSATService } from './local-server.mjs';

/* Ronda 2.9.11 · SERVIDOR — los pendientes nombrados se
   re-evalúan contra lo que ya aterrizó.
   El hueco, probado en producción el 18 nov 2026: la cura de
   la 2.9.9 nombró los trabajos 77/78 (metadatos recibidos,
   código 5004) porque en ESE momento ninguna solicitud
   terminada cubría sus ventanas. A las ~15:51 se pidieron a
   mano los trabajos 79 (recibidos 2026-11-10→17) y 80
   (recibidos 2026-11-11→18), AMBOS «finished» y conteniendo
   por completo las ventanas de 77/78 — y a las 16:20 los dos
   seguían «uncovered», nombrados en el veredicto con un
   «ninguna solicitud terminada la cubre» ya falso. La cura
   solo miraba al nombrar; nadie volvía a mirar.
   La pieza: una pasada de re-evaluación idempotente, sin
   polling nuevo, en el camino del veredicto y de la
   reconciliación del ciclo — todo «uncovered» que una
   solicitud TERMINADA de su mismo RFC, sentido y clase
   contenga por completo se cierra como cubierto por otra
   vía (el mismo estado/coveredBy de la cura), con su nota
   actualizada y su asiento en el Registro.
   (1) contenido → se cierra y el veredicto ya no lo nombra;
   (2) solape parcial → sigue nombrado (ni siquiera dos
       terminados que juntos lo encadenan: la regla de esta
       pasada es la contención de UNA solicitud, como se
       encargó; la de encadenar es la de la cura al nombrar);
   (3) distinta clase o distinto sentido → sigue nombrado;
   (4) idempotente: ni el veredicto repetido ni el ciclo
       duplican asientos ni tocan lo ya cerrado. */

const OWN = 'XAXX010101000';
const EMISOR = 'AAA010101AAA';
const ORIGIN = 'http://127.0.0.1:43735';
const DIA = 86400000;
const FAKE = Date.parse('2026-11-18T18:00:00Z'); /* miércoles 18, 12:00 MX */

function harness(service) {
  let token;
  const call = async (path, data, headers = {}) => {
    const hdrs = { host: new URL(ORIGIN).host, origin: ORIGIN, 'x-pacosat-token': token,
      'x-pacosat-proxy': 'd'.repeat(64), ...headers };
    const req = Object.assign(Readable.from(data === undefined ? [] : [Buffer.from(JSON.stringify(data))]), {
      url: path, method: data === undefined ? 'GET' : 'POST', headers: hdrs });
    let response;
    const res = { setHeader() {}, writeHead(status) { this.status = status; this.headersSent = true; },
      end(content) { response = new Response(content, { status: this.status }); } };
    await service.handle(req, res);
    return response;
  };
  return { call,
    async init() { token = (await (await call('/')).text()).split('content="')[1].split('"')[0]; } };
}
function makeService(extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pacosat-2911-'));
  const dbFile = join(dir, 'pacosat.sqlite');
  const calls = [];
  const service = createPacoSATService({ dbFile, html: '<!--PACOSAT_TOKEN-->', origin: ORIGIN,
    proxyKey: 'd'.repeat(64), now: () => FAKE,
    makeConnector: async () => ({ parser: class {}, connector: {
      request: async options => { calls.push(options); return 'req-2911-' + calls.length; },
      check: async () => ({ status: 'pending', packages: [] }),
      download: async () => { throw new Error('sin paquetes'); } } }),
    makeMailer: () => ({ verify: async () => true, sendMail: async () => {} }),
    ...extra });
  const h = harness(service);
  h.dbFile = dbFile; h.service = service; h.calls = calls;
  h.seed = fn => { const db = new DatabaseSync(dbFile); try { fn(db); } finally { db.close(); } };
  h.read = fn => { const db = new DatabaseSync(dbFile, { readOnly: true }); try { return fn(db); } finally { db.close(); } };
  h.status = async () => (await h.call('/api/status')).json();
  return h;
}
const seedPeopleUnlock = async (h, rfc = OWN) => {
  await h.call('/api/storage', { batch: { people: [{ id: rfc, name: 'Contribuyente 2911' }, { id: EMISOR, name: 'Emisor SA' }] } });
  const res = await h.call('/api/unlock', { rfc, minutes: 1440, days: 7, direction: 'both',
    password: 'secreto', certificate: 'Y2VydA==', key: 'a2V5' });
  assert.equal(res.status, 200, 'unlock de ' + rfc);
};
const seedJob = (h, job) => {
  let out;
  h.seed(db => { out = db.prepare(
    'INSERT INTO jobs(rfc,direction,kind,periodStart,periodEnd,startAt,endAt,requestId,status,due,created,error,checks,note,satCode,rerouteOf) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(job.rfc || OWN, job.direction || 'received', job.kind || 'metadata',
      job.periodStart, job.periodEnd, job.startAt, job.endAt, job.requestId || ('req-seed-' + Math.random()),
      job.status || 'finished', job.due ?? FAKE, job.created ?? (FAKE - DIA), job.error || '', job.checks || 0,
      job.note || '', job.satCode || '', job.rerouteOf || 0); });
  return Number(out.lastInsertRowid);
};
const prepararTick = async h => {
  await h.call('/api/monthly/config', { enabled: false, day: 5, hour: 9 });
  await h.call('/api/revision/config', { enabled: true, dias: [0, 1, 2, 3, 4, 5, 6], hora: 8 });
};
const notaNombrado = ventana =>
  'Pendiente nombrado · del SAT: el SAT rechazó también la re-ruta de esta ventana (código 5004) y ninguna ' +
  'solicitud terminada la cubre (' + ventana + '). No es un fallo colgado: queda nombrada en el veredicto de ' +
  'descargas; para cubrirla hay que pedirla de nuevo desde «Descargar del SAT» con un criterio distinto.';

/* ============ (1) contenido → se cierra; el veredicto ya no lo nombra ============ */
{
  const h = makeService();
  try {
    await h.init();
    await seedPeopleUnlock(h);
    /* La forma exacta de producción: los nombrados 77/78… */
    const id77 = seedJob(h, { periodStart: '2026-11-11', periodEnd: '2026-11-17',
      startAt: '2026-11-11 00:00:00', endAt: '2026-11-17 02:24:43', status: 'uncovered',
      satCode: '5004', note: notaNombrado('2026-11-11 00:00:00 a 2026-11-17 02:24:43'), created: FAKE - 3600000 });
    const id78 = seedJob(h, { periodStart: '2026-11-12', periodEnd: '2026-11-18',
      startAt: '2026-11-12 00:00:00', endAt: '2026-11-18 02:25:02', status: 'uncovered',
      satCode: '5004', note: notaNombrado('2026-11-12 00:00:00 a 2026-11-18 02:25:02'), created: FAKE - 3600000 });
    /* …y los terminados 79/80 que aterrizaron DESPUÉS, con la
       ventana ensanchada, conteniéndolos por completo. */
    const id79 = seedJob(h, { periodStart: '2026-11-10', periodEnd: '2026-11-17',
      startAt: '2026-11-10 00:00:00', endAt: '2026-11-17 23:59:59', status: 'finished' });
    const id80 = seedJob(h, { periodStart: '2026-11-11', periodEnd: '2026-11-18',
      startAt: '2026-11-11 00:00:00', endAt: '2026-11-18 23:59:59', status: 'finished' });
    /* Antes de la pasada constan nombrados en la BD (la lectura
       directa no dispara nada: es el estado que producción
       enseñó a las 16:20). */
    const antes = h.read(db => db.prepare("SELECT id,status FROM jobs WHERE status='uncovered' ORDER BY id").all());
    assert.deepEqual(antes.map(j => j.id), [id77, id78], 'la siembra deja los dos pendientes nombrados');
    const status = await h.status();
    assert.equal(status.descargas299.pendientesNombrados.length, 0,
      'el veredicto ya NO nombra a los que una terminada cubre');
    const fila77 = h.read(db => db.prepare('SELECT * FROM jobs WHERE id=?').get(id77));
    const fila78 = h.read(db => db.prepare('SELECT * FROM jobs WHERE id=?').get(id78));
    assert.equal(fila77.status, 'covered', 'el 77 cierra como cubierto por otra vía');
    assert.equal(fila78.status, 'covered', 'el 78 cierra como cubierto por otra vía');
    assert.deepEqual(JSON.parse(fila77.coveredBy || '[]'), [id79], 'coveredBy del 77 nombra a la solicitud que lo cubre (la 79)');
    assert.deepEqual(JSON.parse(fila78.coveredBy || '[]'), [id80], 'coveredBy del 78 nombra a la solicitud que lo cubre (la 80)');
    assert.match(fila77.note, /cubierta por otra vía/i, 'la nota queda actualizada');
    assert.match(fila77.note, new RegExp('#' + id79), 'la nota nombra la solicitud que cubre');
    assert.doesNotMatch(fila77.note, /ninguna solicitud terminada la cubre/, 'la nota ya no dice lo que dejó de ser verdad');
    assert.equal(h.read(db => db.prepare(
      "SELECT COUNT(*) n FROM audit_events WHERE texto LIKE '%cerrada como cubierta por otra vía%'").get().n), 2,
      'cada cierre deja su asiento en el Registro');
    console.log('2911pendientes (1) contenido → «covered», fuera del veredicto, con asiento: ok');

    /* ============ (4) idempotencia: ni veredicto ni ciclo duplican ============ */
    await h.status();
    await h.status();
    await prepararTick(h);
    await h.service.tick();
    await h.status();
    assert.equal(h.read(db => db.prepare(
      "SELECT COUNT(*) n FROM audit_events WHERE texto LIKE '%cerrada como cubierta por otra vía%'").get().n), 2,
      'la segunda mirada no duplica asientos');
    const otraVez = h.read(db => db.prepare('SELECT status,coveredBy FROM jobs WHERE id=?').get(id77));
    assert.equal(otraVez.status, 'covered');
    assert.deepEqual(JSON.parse(otraVez.coveredBy || '[]'), [id79], 'lo cerrado no se vuelve a tocar');
    console.log('2911pendientes (4) idempotente: sin asientos duplicados ni re-toques: ok');
  } finally { h.service.close(); }
}

/* ============ (2) solape parcial → sigue nombrado ============ */
{
  const h = makeService();
  try {
    await h.init();
    await seedPeopleUnlock(h);
    const idU = seedJob(h, { periodStart: '2026-11-11', periodEnd: '2026-11-17',
      startAt: '2026-11-11 00:00:00', endAt: '2026-11-17 23:59:59', status: 'uncovered',
      satCode: '5004', note: notaNombrado('2026-11-11 00:00:00 a 2026-11-17 23:59:59'), created: FAKE - 3600000 });
    /* Dos terminados que SOLAPAN parcialmente (uno entra por la
       izquierda, otro sale por la derecha): ni juntos ni por
       separado contienen la ventana entera con UNA solicitud. */
    seedJob(h, { periodStart: '2026-11-10', periodEnd: '2026-11-15',
      startAt: '2026-11-10 00:00:00', endAt: '2026-11-15 23:59:59', status: 'finished' });
    seedJob(h, { periodStart: '2026-11-16', periodEnd: '2026-11-20',
      startAt: '2026-11-16 00:00:00', endAt: '2026-11-20 23:59:59', status: 'finished' });
    const status = await h.status();
    assert.equal(status.descargas299.pendientesNombrados.length, 1, 'el solape parcial sigue nombrado en el veredicto');
    assert.equal(status.descargas299.pendientesNombrados[0].id, idU);
    await prepararTick(h);
    await h.service.tick();
    const fila = h.read(db => db.prepare('SELECT status FROM jobs WHERE id=?').get(idU));
    assert.equal(fila.status, 'uncovered', 'ni el ciclo lo cierra con solape parcial');
    console.log('2911pendientes (2) solape parcial → sigue nombrado: ok');
  } finally { h.service.close(); }
}

/* ============ (3) distinta clase o distinto sentido → sigue nombrado ============ */
{
  const h = makeService();
  try {
    await h.init();
    await seedPeopleUnlock(h);
    const idU = seedJob(h, { periodStart: '2026-11-11', periodEnd: '2026-11-17',
      startAt: '2026-11-11 00:00:00', endAt: '2026-11-17 02:24:43', status: 'uncovered',
      satCode: '5004', note: notaNombrado('2026-11-11 00:00:00 a 2026-11-17 02:24:43'), created: FAKE - 3600000 });
    /* Contienen la ventana, pero uno es CFDI (otra clase) y el
       otro es de EMITIDOS (otro sentido): no cubren un pendiente
       de METADATOS RECIBIDOS. */
    seedJob(h, { kind: 'cfdi', periodStart: '2026-11-10', periodEnd: '2026-11-17',
      startAt: '2026-11-10 00:00:00', endAt: '2026-11-17 23:59:59', status: 'finished' });
    seedJob(h, { direction: 'issued', periodStart: '2026-11-10', periodEnd: '2026-11-18',
      startAt: '2026-11-10 00:00:00', endAt: '2026-11-18 23:59:59', status: 'finished' });
    const status = await h.status();
    assert.equal(status.descargas299.pendientesNombrados.length, 1,
      'otra clase u otro sentido no cierran el pendiente: sigue nombrado');
    assert.equal(status.descargas299.pendientesNombrados[0].id, idU);
    const fila = h.read(db => db.prepare('SELECT status FROM jobs WHERE id=?').get(idU));
    assert.equal(fila.status, 'uncovered');
    console.log('2911pendientes (3) distinta clase/sentido → sigue nombrado: ok');
  } finally { h.service.close(); }
}

console.log('OK suite ronda2911pendientes completa');
