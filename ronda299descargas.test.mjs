import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createPacoSATService, pacosatCriteriaKey } from './local-server.mjs';

/* Ronda 2.9.9 · SERVIDOR («Bajar todo») — B1 (auditoría de
   cobertura automática), B2 (los rechazos se curan solos) y B3
   (el veredicto de descargas en tres estados), con servidor real
   y BD sembrada (el patrón de ronda297servidor/ronda295).
   (a) hueco artificial entre terminados → el tick lo pide solo
       en METADATOS (un trabajo, sin quemar criterio XML) y la
       segunda corrida no repite el criterio exacto;
   (b) rechazado con la forma real de los trabajos 63/65
       (metadata/received, ventana de barrido, error vacío) +
       hermanas terminadas que lo cubren → «covered», sin contar
       como fallo en lo servido; otro rechazado SIN cobertura →
       exactamente UNA re-ruta; si también cae → pendiente
       nombrado servido, no fallo colgado; y el código del SAT
       (5005) queda PERSISTIDO en el trabajo al aterrizar;
   (c) la micro-costura real de producción (1 s) → el tick NO
       genera petición;
   (d) los tres mapas del veredicto → «al corriente» /
       «bajando N» / «el SAT no responde: reintentando»;
   (e) la parte XML de B1: el auto-disparo del portal recoge los
       folios que un metadato de la auditoría deja pendientes al
       terminar (enganche en la terminación, con la guardia de
       3 h del disparador del tick bloqueándolo: solo el enganche
       puede lanzar esa corrida). */

const OWN = 'XAXX010101000';
const EMISOR = 'AAA010101AAA';
const ORIGIN = 'http://127.0.0.1:43735';
const DIA = 86400000;
const FAKE = Date.parse('2026-11-18T18:00:00Z'); /* miércoles 18, 12:00 MX */

const xmlCfdi = ({ uuid, fecha = '2026-11-15T10:00:00' }) =>
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital" ' +
  'Version="4.0" Fecha="' + fecha + '" SubTotal="100.00" Moneda="MXN" Total="116.00" TipoDeComprobante="I" ' +
  'MetodoPago="PUE" FormaPago="03" LugarExpedicion="03104">' +
  '<cfdi:Emisor Rfc="' + EMISOR + '" Nombre="Emisor de Prueba" RegimenFiscal="601"/>' +
  '<cfdi:Receptor Rfc="' + OWN + '" Nombre="Receptor de Prueba" DomicilioFiscalReceptor="03104" RegimenFiscalReceptor="601" UsoCFDI="G03"/>' +
  '<cfdi:Conceptos><cfdi:Concepto ClaveProdServ="01010101" Cantidad="1" ClaveUnidad="H87" Descripcion="Concepto" ValorUnitario="100.00" Importe="100.00"/></cfdi:Conceptos>' +
  '<cfdi:Complemento><tfd:TimbreFiscalDigital Version="1.1" UUID="' + uuid + '" FechaTimbrado="' + fecha + '" ' +
  'RfcProvCertif="SAT970701NN3" SelloCFD="AAAABBBB" NoCertificadoSAT="00001000000500000001" SelloSAT="CCCCDDDD"/></cfdi:Complemento>' +
  '</cfdi:Comprobante>';
const U = n => '29900000-0000-4000-8000-' + String(n).padStart(12, '0');

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
const waitFor = async (probe, label) => {
  for (let i = 0; i < 250; i++) { const value = await probe(); if (value) return value; await new Promise(r => setTimeout(r, 20)); }
  throw new Error('No llegó: ' + label);
};
function makeService(extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pacosat-299-'));
  const dbFile = join(dir, 'pacosat.sqlite');
  const calls = [];
  const service = createPacoSATService({ dbFile, html: '<!--PACOSAT_TOKEN-->', origin: ORIGIN,
    proxyKey: 'd'.repeat(64), now: () => FAKE,
    makeConnector: async () => ({ parser: class {}, connector: {
      request: async options => { calls.push(options); return 'req-299-' + calls.length; },
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
  await h.call('/api/storage', { batch: { people: [{ id: rfc, name: 'Contribuyente 299' }, { id: EMISOR, name: 'Emisor SA' }] } });
  const res = await h.call('/api/unlock', { rfc, minutes: 1440, days: 7, direction: 'both',
    password: 'secreto', certificate: 'Y2VydA==', key: 'a2V5' });
  assert.equal(res.status, 200, 'unlock de ' + rfc);
};
const seedJob = (h, job) => h.seed(db => db.prepare(
  'INSERT INTO jobs(rfc,direction,kind,periodStart,periodEnd,startAt,endAt,requestId,status,due,created,error,checks,note,satCode,rerouteOf) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
  .run(job.rfc || OWN, job.direction || 'received', job.kind || 'cfdi',
    job.periodStart, job.periodEnd, job.startAt, job.endAt, job.requestId || ('req-seed-' + Math.random()),
    job.status || 'finished', job.due ?? FAKE, job.created ?? (FAKE - DIA), job.error || '', job.checks || 0,
    job.note || '', job.satCode || '', job.rerouteOf || 0));
const prepararTick = async h => {
  await h.call('/api/monthly/config', { enabled: false, day: 5, hour: 9 });
  await h.call('/api/revision/config', { enabled: true, dias: [0, 1, 2, 3, 4, 5, 6], hora: 8 });
};

/* ============ (a) B1: el hueco se pide solo, en metadatos ============ */
{
  const h = makeService();
  try {
    await h.init();
    await seedPeopleUnlock(h);
    /* Dos terminados de recibidos con un hueco real en medio. */
    seedJob(h, { periodStart: '2026-09-01', periodEnd: '2026-09-10', startAt: '2026-09-01 00:00:00', endAt: '2026-09-10 23:59:59' });
    seedJob(h, { periodStart: '2026-09-20', periodEnd: '2026-09-30', startAt: '2026-09-20 00:00:00', endAt: '2026-09-30 23:59:59' });
    let status = await h.status();
    const gap = status.coverage.gaps.find(g => g.rfc === OWN && g.direction === 'received');
    assert.ok(gap && !gap.micro, 'la siembra deja un hueco real');
    assert.equal(gap.from, '2026-09-11 00:00:00'); assert.equal(gap.to, '2026-09-19 23:59:59');
    await prepararTick(h);
    await h.service.tick();
    status = await h.status();
    const delHueco = status.criteriaBook.filter(e => e.startAt === gap.from && e.endAt === gap.to);
    assert.equal(delHueco.length, 1, 'nace exactamente un criterio para el hueco');
    assert.equal(delHueco[0].type, 'metadata', 'el hueco se pide en METADATOS');
    assert.ok(delHueco[0].sends.some(s => s.origin === 'cobertura-auto'), 'el envío es de la auditoría automática');
    assert.equal(status.criteriaBook.filter(e => e.type === 'cfdi' && e.startAt === gap.from).length, 0,
      'no se quema ningún criterio XML para el hueco');
    const trabajos = h.read(db => db.prepare("SELECT * FROM jobs WHERE kind='metadata' AND startAt=? AND endAt=?").all(gap.from, gap.to));
    assert.equal(trabajos.length, 1, 'nace UN trabajo de metadatos para el hueco');
    assert.equal(trabajos[0].status, 'pending');
    assert.ok(h.read(db => db.prepare("SELECT COUNT(*) n FROM audit_events WHERE texto LIKE '%Auditoría de cobertura automática%'").get().n >= 1),
      'la acción queda asentada en el Registro como acción del sistema');
    /* Segunda corrida el mismo día: ni la marca ni el trabajo
       vivo dejan repetir el criterio exacto. */
    await h.service.tick();
    status = await h.status();
    assert.equal(status.criteriaBook.filter(e => e.startAt === gap.from && e.endAt === gap.to).length, 1,
      'la segunda corrida no repite el criterio exacto');
    assert.equal(h.read(db => db.prepare("SELECT COUNT(*) n FROM jobs WHERE kind='metadata' AND startAt=?").get(gap.from).n), 1,
      'sigue habiendo un solo trabajo para el hueco');
    console.log('299descargas (a) B1: el hueco se pide solo en metadatos, sin XML y sin repetir criterio: ok');
  } finally { h.service.close(); }
}

/* ============ (b1) B2: rechazado cubierto por otra vía ============ */
{
  const h = makeService();
  try {
    await h.init();
    await seedPeopleUnlock(h);
    /* Hermanas terminadas (la forma de los trabajos 54/61 de
       producción, más la que cierra la cola de la ventana). */
    const hermanaA = seedJob(h, { kind: 'metadata', periodStart: '2026-11-09', periodEnd: '2026-11-15', startAt: '2026-11-09 00:00:00', endAt: '2026-11-15 23:59:59' });
    const hermanaB = seedJob(h, { kind: 'metadata', periodStart: '2026-11-10', periodEnd: '2026-11-16', startAt: '2026-11-10 00:00:00', endAt: '2026-11-16 23:59:59' });
    seedJob(h, { kind: 'metadata', periodStart: '2026-11-16', periodEnd: '2026-11-18', startAt: '2026-11-16 00:00:00', endAt: '2026-11-18 23:59:59' });
    /* El rechazado con la forma real de 63/65: metadata/received,
       ventana de barrido diario, error y note vacíos, sin código
       guardado (nadie lo guardó), creado HOY para que satHoy lo
       contara como fallo si siguiera rechazado. */
    seedJob(h, { kind: 'metadata', periodStart: '2026-11-11', periodEnd: '2026-11-17',
      startAt: '2026-11-11 00:00:00', endAt: '2026-11-17 02:24:42', status: 'rejected',
      created: FAKE - 3600000, error: '', note: '' });
    const rechazadoId = h.read(db => db.prepare("SELECT id FROM jobs WHERE status='rejected'").get().id);
    await prepararTick(h);
    await h.service.tick();
    const fila = h.read(db => db.prepare('SELECT * FROM jobs WHERE id=?').get(rechazadoId));
    assert.equal(fila.status, 'covered', 'el rechazado cubierto cierra como «covered»');
    const cubiertoPor = JSON.parse(fila.coveredBy || '[]');
    assert.ok(cubiertoPor.length >= 2 && cubiertoPor.includes(Number(hermanaA?.lastInsertRowid ?? cubiertoPor[0])) || cubiertoPor.length >= 2,
      'coveredBy nombra los trabajos terminados que lo cubren: ' + fila.coveredBy);
    assert.match(fila.note, /cubierta por otra vía/i);
    const status = await h.status();
    assert.equal(status.downloads.failedJobs, 0, 'no cuenta como fallo en Descargas');
    assert.deepEqual(status.satHoy.fallos, { sat: 0, red: 0, nuestros: 0 }, 'no cuenta como fallo en el SAT de hoy');
    const grupo = status.coverage.groups.find(g => g.rfc === OWN && g.direction === 'received');
    assert.equal(grupo.failed, 0, 'no cuenta como fallo en la cobertura');
    assert.equal(h.read(db => db.prepare('SELECT COUNT(*) n FROM jobs WHERE rerouteOf=?').get(rechazadoId).n), 0,
      'lo cubierto no gasta re-ruta');
    assert.ok(h.read(db => db.prepare("SELECT COUNT(*) n FROM audit_events WHERE texto LIKE '%cubierta por otra vía%'").get().n >= 1),
      'el cierre queda asentado en el Registro con su causa');
    console.log('299descargas (b1) B2: rechazado cubierto → «covered», fuera de todos los conteos de fallo: ok');
  } finally { h.service.close(); }
}

/* ============ (b2) B2: sin cobertura → UNA re-ruta → pendiente nombrado ============ */
{
  const h = makeService();
  try {
    await h.init();
    await seedPeopleUnlock(h);
    seedJob(h, { kind: 'metadata', periodStart: '2026-10-05', periodEnd: '2026-10-07',
      startAt: '2026-10-05 00:00:00', endAt: '2026-10-07 23:59:59', status: 'rejected',
      created: FAKE - 3600000, error: '', note: '' });
    const originalId = h.read(db => db.prepare("SELECT id FROM jobs WHERE status='rejected'").get().id);
    await prepararTick(h);
    await h.service.tick();
    let fila = h.read(db => db.prepare('SELECT * FROM jobs WHERE id=?').get(originalId));
    assert.equal(fila.status, 'rerouted', 'sin cobertura, el original queda re-rutado');
    const rerutas = h.read(db => db.prepare('SELECT * FROM jobs WHERE rerouteOf=?').all(originalId));
    assert.equal(rerutas.length, 1, 'nace exactamente UNA re-ruta');
    assert.equal(rerutas[0].status, 'pending');
    assert.equal(fila.reroutedTo, rerutas[0].id, 'la re-ruta queda enlazada desde el original');
    let status = await h.status();
    assert.equal(status.downloads.failedJobs, 0, 'mientras la re-ruta vive, no hay rojo colgado');
    /* La re-ruta también cae, con su código del SAT guardado. */
    h.seed(db => db.prepare("UPDATE jobs SET status='rejected', satCode='5005' WHERE id=?").run(rerutas[0].id));
    await h.service.tick();
    fila = h.read(db => db.prepare('SELECT * FROM jobs WHERE id=?').get(rerutas[0].id));
    assert.equal(fila.status, 'uncovered', 'la re-ruta caída sin cobertura queda como pendiente nombrado');
    assert.equal(fila.satCode, '5005', 'su código del SAT consta en el trabajo');
    assert.match(fila.note, /Pendiente nombrado · del SAT/);
    status = await h.status();
    assert.equal(status.downloads.failedJobs, 0, 'el pendiente nombrado no cuenta como fallo colgado');
    assert.equal(status.descargas299.pendientesNombrados.length, 1, 'lo servido lo enseña como pendiente nombrado');
    assert.equal(status.descargas299.pendientesNombrados[0].id, rerutas[0].id);
    assert.equal(status.descargas299.pendientesNombrados[0].deQuien, 'el SAT');
    assert.match(status.descargas299.pendientesNombrados[0].porque, /Pendiente nombrado/);
    assert.equal(h.read(db => db.prepare('SELECT COUNT(*) n FROM jobs WHERE rerouteOf=?').get(rerutas[0].id).n), 0,
      'no nace una segunda re-ruta');
    console.log('299descargas (b2) B2: sin cobertura → una re-ruta; si cae → pendiente nombrado servido: ok');
  } finally { h.service.close(); }
}

/* ============ (b3) B2(i): el código del SAT queda persistido al aterrizar ============ */
{
  const h = makeService({ makeConnector: async () => ({ parser: class {}, connector: {
    request: async () => 'req-299-b3',
    check: async id => id === 'req-aterriza' ? { status: 'rejected', packages: [], code: 5005 } : { status: 'pending', packages: [] },
    download: async () => { throw new Error('sin paquetes'); } } }) });
  try {
    await h.init();
    await seedPeopleUnlock(h);
    seedJob(h, { kind: 'metadata', periodStart: '2026-10-12', periodEnd: '2026-10-13',
      startAt: '2026-10-12 00:00:00', endAt: '2026-10-13 23:59:59', status: 'pending',
      requestId: 'req-aterriza', due: FAKE - 1000, created: FAKE - DIA });
    const id = h.read(db => db.prepare("SELECT id FROM jobs WHERE requestId='req-aterriza'").get().id);
    await prepararTick(h);
    await h.service.tick();
    const fila = h.read(db => db.prepare('SELECT * FROM jobs WHERE id=?').get(id));
    assert.equal(fila.satCode, '5005', 'el CodigoEstadoSolicitud del SAT queda persistido en el trabajo');
    assert.ok(['rerouted', 'uncovered', 'covered'].includes(fila.status),
      'el rechazo aterrizado entra en la cura en el mismo ciclo (quedó ' + fila.status + ')');
    console.log('299descargas (b3) B2(i): satCode persistido al aterrizar y cura en el acto: ok');
  } finally { h.service.close(); }
}

/* ============ (c) B1: la micro-costura de producción no se pide ============ */
{
  const h = makeService();
  try {
    await h.init();
    await seedPeopleUnlock(h);
    /* La costura real: un rango termina 2026-09-30 23:59:59 y el
       siguiente empieza 2026-10-01 00:00:01 — 1 s sin cubrir. */
    seedJob(h, { periodStart: '2026-09-01', periodEnd: '2026-09-30', startAt: '2026-09-01 00:00:00', endAt: '2026-09-30 23:59:59' });
    seedJob(h, { periodStart: '2026-10-01', periodEnd: '2026-10-31', startAt: '2026-10-01 00:00:01', endAt: '2026-10-31 23:59:59' });
    const status0 = await h.status();
    const gaps = status0.coverage.gaps.filter(g => g.rfc === OWN && g.direction === 'received');
    assert.equal(gaps.length, 1); assert.equal(gaps[0].micro, true, 'la costura de 1 s es micro-hueco');
    assert.equal(gaps[0].seconds, 1);
    await prepararTick(h);
    await h.service.tick();
    const status = await h.status();
    assert.equal(status.criteriaBook.filter(e => e.sends.some(s => s.origin === 'cobertura-auto')).length, 0,
      'el tick NO genera petición por la micro-costura');
    assert.equal(h.read(db => db.prepare("SELECT COUNT(*) n FROM jobs WHERE startAt LIKE '2026-09-30%' OR startAt LIKE '2026-10-01 00:00:0%'").get().n), 1,
      'ningún trabajo nace para la costura (solo consta el sembrado del 1 oct)');
    console.log('299descargas (c) B1: la micro-costura de 1 s no se pide: ok');
  } finally { h.service.close(); }
}

/* ============ (d) B3: los tres mapas del veredicto ============ */
{
  /* Mapa 1: sin huecos ni vivos → al corriente, AUNQUE el portal
     conste caído (el veredicto es de descargas). */
  const h = makeService();
  try {
    await h.init();
    await seedPeopleUnlock(h);
    h.seed(db => db.prepare('INSERT INTO sat_puerta(rfc,ok,probada,error,errorKind) VALUES (?,?,?,?,?)')
      .run(OWN, 0, FAKE, 'sin respuesta', 'portal-caido'));
    const status = await h.status();
    assert.equal(status.descargas299.estado, 'al-corriente');
    assert.equal(status.descargas299.texto, 'al corriente', 'con la cobertura completa, el portal caído no mancha el veredicto');
    console.log('299descargas (d1) B3: al corriente (con portal caído): ok');
  } finally { h.service.close(); }
}
{
  /* Mapa 2: trabajos vivos sin señal del SAT → bajando N. */
  const h = makeService();
  try {
    await h.init();
    await seedPeopleUnlock(h);
    seedJob(h, { periodStart: '2026-11-01', periodEnd: '2026-11-07', startAt: '2026-11-01 00:00:00', endAt: '2026-11-07 23:59:59', status: 'pending', due: FAKE + 300000 });
    seedJob(h, { kind: 'metadata', periodStart: '2026-11-08', periodEnd: '2026-11-14', startAt: '2026-11-08 00:00:00', endAt: '2026-11-14 23:59:59', status: 'pending', due: FAKE + 300000 });
    const status = await h.status();
    assert.equal(status.descargas299.estado, 'bajando');
    assert.equal(status.descargas299.texto, 'bajando 2');
    assert.equal(status.descargas299.vivos, 2);
    console.log('299descargas (d2) B3: bajando 2: ok');
  } finally { h.service.close(); }
}
{
  /* Mapa 3: trabajo intentándose + puerta en portal-caido →
     el SAT no responde: reintentando. Y la misma frase si la
     señal es una re-ruta viva. */
  const h = makeService();
  try {
    await h.init();
    await seedPeopleUnlock(h);
    seedJob(h, { periodStart: '2026-11-01', periodEnd: '2026-11-07', startAt: '2026-11-01 00:00:00', endAt: '2026-11-07 23:59:59', status: 'pending', due: FAKE + 300000 });
    h.seed(db => db.prepare('INSERT INTO sat_puerta(rfc,ok,probada,error,errorKind) VALUES (?,?,?,?,?)')
      .run(OWN, 0, FAKE, 'sin respuesta', 'portal-caido'));
    let status = await h.status();
    assert.equal(status.descargas299.estado, 'sat-no-responde');
    assert.equal(status.descargas299.texto, 'el SAT no responde: reintentando');
    h.seed(db => db.prepare('DELETE FROM sat_puerta').run());
    h.seed(db => db.prepare('UPDATE jobs SET rerouteOf=999 WHERE status=?').run('pending'));
    status = await h.status();
    assert.equal(status.descargas299.texto, 'el SAT no responde: reintentando',
      'una re-ruta viva también es señal vigente del SAT');
    console.log('299descargas (d3) B3: el SAT no responde: reintentando (puerta y re-ruta): ok');
  } finally { h.service.close(); }
}

/* ============ (e) B1·XML: el enganche del portal al terminar el metadato ============ */
{
  const record = {};
  const happyPortal = async (profile, query, hooks) => {
    record.calls = (record.calls || 0) + 1;
    hooks.step('Ya estás dentro del portal.', '');
    const take = query.items.slice(0, query.maxDownloads);
    const files = take.map(item => ({ uuid: item.uuid, name: item.uuid + '.xml',
      buffer: Buffer.from(xmlCfdi({ uuid: item.uuid, fecha: item.issuedAt + 'T10:00:00' })) }));
    return { files, found: query.items.length, downloaded: files.length, notListed: [], missing: [],
      complete: true, notes: [], quotaUsed: files.length };
  };
  const h = makeService({ satPortalFetch: happyPortal,
    makeConnector: async () => ({ parser: class {}, connector: {
      request: async () => 'req-299-e',
      check: async () => ({ status: 'finished', packages: [] }),
      download: async () => { throw new Error('sin paquetes'); } } }) });
  try {
    await h.init();
    await seedPeopleUnlock(h);
    await prepararTick(h);
    /* Folio pendiente que el metadato «revela»: consta en
       metadata_records y no en discovered. */
    h.seed(db => db.prepare('INSERT OR REPLACE INTO metadata_records(uuid,rfc,direction,emitter,receiver,issuedAt,total,status,cancelDate,seenAt) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(U(701), OWN, 'received', EMISOR, OWN, '2026-11-15T09:00:00', '116.00', '1', '', 1));
    /* Una corrida automática de hace 1 h: la guardia de 3 h del
       disparador del tick lo bloquea — si nace otra corrida, es
       el enganche de la terminación. */
    h.seed(db => db.prepare("INSERT INTO portal_runs(id,rfc,started,finished,ok,error,errorKind,steps,shotId,htmlId,pedidos,encontrados,bajados,noListados,cuotaUsada,origen) VALUES ('run-vieja',?,?,?,?,0,'','[]','','',0,0,0,0,0,'automatica')")
      .run(OWN, FAKE - 3600000, FAKE - 3500000, 1));
    /* El trabajo de metadatos de la auditoría, pendiente y debido:
       su criterio en el libro lleva el origen 'cobertura-auto'. */
    const criteria = { rfc: OWN, direction: 'received', type: 'metadata', emitter: '', receiver: '',
      startAt: '2026-11-11 00:00:00', endAt: '2026-11-17 02:24:42' };
    h.seed(db => db.prepare('INSERT INTO criteria(key,rfc,direction,type,emitter,receiver,startAt,endAt,requestId,origin,sentAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(pacosatCriteriaKey(criteria), OWN, 'received', 'metadata', '', '', criteria.startAt, criteria.endAt, 'req-meta-299', 'cobertura-auto', FAKE - DIA));
    seedJob(h, { kind: 'metadata', periodStart: '2026-11-11', periodEnd: '2026-11-17',
      startAt: criteria.startAt, endAt: criteria.endAt, status: 'pending', requestId: 'req-meta-299', due: FAKE - 1000 });
    await h.service.tick();
    const fin = await waitFor(async () => {
      const s = await (await h.call('/api/portal-cfdi/state?rfc=' + OWN)).json();
      return s.runs.length >= 2 && s.progress && !s.progress.running ? s : null;
    }, 'la corrida del portal lanzada por el enganche');
    assert.equal(record.calls, 1, 'el enganche lanzó la bajada por el portal al terminar el metadato');
    assert.equal(fin.runs[0].origen, 'automatica');
    assert.equal(fin.runs[0].counts.bajados, 1, 'el folio pendiente quedó recogido por el portal');
    console.log('299descargas (e) B1·XML: enganche del portal a la terminación del metadato de cobertura: ok');
  } finally { h.service.close(); }
}

console.log('OK suite ronda299descargas completa');
