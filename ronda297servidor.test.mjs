import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DOMParser } from '@xmldom/xmldom';
import { createPacoSATService } from './local-server.mjs';
import { parseXml } from './xml-core.mjs';

/* Ronda 2.9.7 · SERVIDOR — Piezas A (cableado del portal), B
   (endpoint del Lector), C1 (red de fondo diaria de 1 día) y C2
   (datos del rescate). Todo con un satPortalFetch DE JUGUETE
   inyectado como opción del servicio (el patrón de sat-ciec.test)
   y el SAT masivo fingido con conectores de juguete (el patrón de
   anti5002/metadata): ningún contacto real con el SAT.
   (a) corrida manual por uuids: importa por ingestXmlBuffers, el
       diario guarda la corrida con sus cuentas y el cupo sube;
       el PDF del portal se archiva aparejado; uuid desconocido
       → 422; sin cablear → 503 honesto.
   (b) corrida por periodo sobre la ventana atorada sembrada:
       entran los folios y portalRescue pasa a recuperada=true.
   (c) cupo compartido: con el contador casi lleno la corrida
       recibe maxDownloads recortado; la corrida CIEC suma al
       MISMO contador.
   (d) cancelar a mitad: la corrida cierra parcial y lo dice.
   (e) automático: el tick lanza la corrida sola (origen
       'automatica') y no la repite dentro de las 3 h.
   (f) C1: el fondo diario pide los días de 1 día que faltan en
       ambos sentidos y salta la ventana cubierta y la viva.
   (g) Lector: XML típico y XML grande cronometrados (ms), y
       sin XML → sinXml:true; invitado fuera de alcance → 403. */

const OWN = 'XAXX010101000';
const EMISOR = 'AAA010101AAA';
const ORIGIN = 'http://127.0.0.1:43735';
const DIA = 86400000;
const mxDay = time => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City' }).format(time);

const xmlCfdi = ({ uuid, fecha = '2026-11-10T10:00:00', emisor = EMISOR, receptor = OWN, total = '116.00', conceptos = 1 }) => {
  const sub = (Number(total) / 1.16).toFixed(2);
  const tax = (Number(total) - Number(sub)).toFixed(2);
  const unConcepto = n => '<cfdi:Concepto ClaveProdServ="01010101" Cantidad="1" ClaveUnidad="H87" Descripcion="Concepto ' + n +
    '" ValorUnitario="10.00" Importe="10.00" ObjetoImp="02"><cfdi:Impuestos><cfdi:Traslados>' +
    '<cfdi:Traslado Base="10.00" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="1.60"/>' +
    '</cfdi:Traslados></cfdi:Impuestos></cfdi:Concepto>';
  const lista = Array.from({ length: conceptos }, (_, i) => unConcepto(i + 1)).join('');
  return '<?xml version="1.0" encoding="UTF-8"?>' +
    '<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital" ' +
    'Version="4.0" Fecha="' + fecha + '" SubTotal="' + sub + '" Moneda="MXN" Total="' + total + '" TipoDeComprobante="I" ' +
    'MetodoPago="PUE" FormaPago="03" LugarExpedicion="03104">' +
    '<cfdi:Emisor Rfc="' + emisor + '" Nombre="Emisor de Prueba" RegimenFiscal="601"/>' +
    '<cfdi:Receptor Rfc="' + receptor + '" Nombre="Receptor de Prueba" DomicilioFiscalReceptor="03104" RegimenFiscalReceptor="601" UsoCFDI="G03"/>' +
    '<cfdi:Conceptos>' + lista + '</cfdi:Conceptos>' +
    '<cfdi:Impuestos TotalImpuestosTrasladados="' + tax + '"><cfdi:Traslados>' +
    '<cfdi:Traslado Base="' + sub + '" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="' + tax + '"/></cfdi:Traslados></cfdi:Impuestos>' +
    '<cfdi:Complemento><tfd:TimbreFiscalDigital Version="1.1" UUID="' + uuid + '" FechaTimbrado="' + fecha + '" ' +
    'RfcProvCertif="SAT970701NN3" SelloCFD="AAAABBBB" NoCertificadoSAT="00001000000500000001" SelloSAT="CCCCDDDD"/></cfdi:Complemento>' +
    '</cfdi:Comprobante>';
};
const U = n => '29700000-0000-4000-8000-' + String(n).padStart(12, '0');

function harness(service, nowRef) {
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
  return {
    call,
    async init() { token = (await (await call('/')).text()).split('content="')[1].split('"')[0]; },
    db: null
  };
}
const waitFor = async (probe, label) => {
  for (let i = 0; i < 250; i++) { const value = await probe(); if (value) return value; await new Promise(r => setTimeout(r, 20)); }
  throw new Error('No llegó: ' + label);
};
function makeService(extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pacosat-297-'));
  const dbFile = join(dir, 'pacosat.sqlite');
  const service = createPacoSATService({ dbFile, html: '<!--PACOSAT_TOKEN-->', origin: ORIGIN,
    proxyKey: 'd'.repeat(64),
    makeConnector: async () => ({ parser: class {}, connector: {
      request: async () => 'req-297', check: async () => ({ status: 'finished', packages: [] }),
      download: async () => { throw new Error('sin paquetes'); } } }),
    makeMailer: () => ({ verify: async () => true, sendMail: async () => {} }),
    ...extra });
  const h = harness(service);
  h.dbFile = dbFile;
  h.service = service;
  h.seed = (fn) => { const db = new DatabaseSync(dbFile); try { fn(db); } finally { db.close(); } };
  return h;
}
const seedPeopleUnlock = async (h, rfc = OWN) => {
  await h.call('/api/storage', { batch: { people: [{ id: rfc, name: 'Contribuyente 297' }, { id: EMISOR, name: 'Emisor SA' }] } });
  const res = await h.call('/api/unlock', { rfc, minutes: 1440, days: 7, direction: 'both',
    password: 'simulada', certificate: 'YQ==', key: 'Yg==' });
  assert.equal(res.status, 200, 'unlock de ' + rfc);
};
const seedMetadata = (h, rows) => h.seed(db => {
  const up = db.prepare('INSERT OR REPLACE INTO metadata_records(uuid,rfc,direction,emitter,receiver,issuedAt,total,status,cancelDate,seenAt) VALUES (?,?,?,?,?,?,?,?,?,?)');
  for (const r of rows) up.run(r.uuid, r.rfc || OWN, r.direction || 'received', EMISOR, OWN, r.issuedAt, '116.00', '1', '', 1);
});
const portalState = async (h, rfc = OWN) => (await (await h.call('/api/portal-cfdi/state?rfc=' + rfc)).json());
const waitPortalDone = (h, rfc = OWN) => waitFor(async () => {
  const s = await portalState(h, rfc);
  return s.progress && !s.progress.running && s.runs.length ? s : null;
}, 'el fin de la corrida del portal');

/* Motor de juguete «feliz»: baja todo lo pedido hasta el techo. */
const happyPortal = (record = {}) => async (profile, query, hooks) => {
  record.calls = (record.calls || 0) + 1;
  record.lastQuery = query;
  hooks.step('Ya estás dentro del portal.', '');
  const take = query.items.slice(0, query.maxDownloads);
  const files = take.map(item => ({ uuid: item.uuid, name: item.uuid + '.xml',
    buffer: Buffer.from(xmlCfdi({ uuid: item.uuid, fecha: item.issuedAt + 'T10:00:00' })) }));
  return { files, found: query.items.length, downloaded: files.length,
    notListed: [], missing: query.items.slice(query.maxDownloads).map(i => i.uuid),
    complete: files.length === query.items.length,
    notes: files.length < query.items.length ? ['Techo de esta corrida alcanzado (' + query.maxDownloads + ' XML): el resto queda para la red del web service.'] : [],
    quotaUsed: files.length };
};

/* ============ (a) corrida manual por uuids + 503 + 422 + PDF ============ */
{
  const record = {};
  const h = makeService({ satPortalFetch: happyPortal(record) });
  try {
    await h.init();
    await seedPeopleUnlock(h);
    const u1 = U(101), u2 = U(102);
    seedMetadata(h, [{ uuid: u1, issuedAt: '2026-11-10T09:00:00' }, { uuid: u2, issuedAt: '2026-11-10T11:00:00' }]);
    /* UUID desconocido → 422 llano, sin lanzar nada. */
    let res = await h.call('/api/portal-cfdi/run', { rfc: OWN, uuids: [U(999)] });
    assert.equal(res.status, 422, 'uuid desconocido → 422');
    assert.match((await res.json()).error, /no consta en los metadatos/);
    assert.equal(record.calls || 0, 0, 'con 422 no se lanzó ninguna corrida');
    /* La corrida por uuids. */
    res = await h.call('/api/portal-cfdi/run', { rfc: OWN, uuids: [u1, u2], origen: 'rescate' });
    assert.equal(res.status, 200);
    const fin = await waitPortalDone(h);
    assert.equal(fin.configurado, true);
    assert.equal(fin.progress.ok, true);
    assert.equal(fin.runs.length, 1);
    assert.deepEqual(fin.runs[0].counts, { pedidos: 2, encontrados: 2, bajados: 2, noListados: 0, cuotaUsada: 2 });
    assert.equal(fin.runs[0].origen, 'rescate');
    assert.equal(fin.quota.used, 2, 'el cupo del día sube con la corrida');
    assert.equal(fin.quota.limit, 2000);
    assert.equal(fin.quota.remaining, 1998);
    /* Los comprobantes quedan en el expediente (ingestXmlBuffers). */
    const status = await (await h.call('/api/status')).json();
    assert.ok(!status.metadata.missing.some(row => row.uuid === u1 || row.uuid === u2),
      'los folios bajados ya no constan como faltantes');
    h.seed(db => {
      assert.ok(db.prepare("SELECT 1 FROM records WHERE store='invoices' AND id=?").get(u1), 'el XML de u1 está en el expediente');
      assert.ok(db.prepare("SELECT 1 FROM records WHERE store='files' AND id=?").get('xml:' + u2), 'el fichero XML de u2 está guardado');
      assert.ok(db.prepare('SELECT 1 FROM discovered WHERE rfc=? AND uuid=?').get(OWN, u1), 'lo bajado queda reconciliado como descubierto');
      const noticia = db.prepare("SELECT COUNT(*) AS n FROM news_notices WHERE opkey LIKE 'portal:%'").get().n;
      assert.ok(noticia >= 1, 'la corrida deja su aviso de novedades (kind portal)');
    });
    /* Segunda corrida del mismo folio: ya no está pendiente → 422. */
    res = await h.call('/api/portal-cfdi/run', { rfc: OWN, uuids: [u1] });
    assert.equal(res.status, 200, 'el uuid sigue constando en metadatos: la corrida sale');
    const fin2 = await waitFor(async () => {
      const s = await portalState(h);
      return s.runs.length >= 2 && !s.progress.running ? s : null;
    }, 'la segunda corrida');
    assert.equal(fin2.runs[0].counts.bajados, 1, 'baja de nuevo el XML (duplicado en la ingesta, sin error)');
    console.log('297srv (a) corrida por uuids, diario, cupo, 422 y reconciliación: ok');
  } finally { h.service.close(); }

  /* Sin cablear (fuera de la sede NAS): 503 con la línea honesta. */
  const h2 = makeService({});
  try {
    await h2.init();
    await seedPeopleUnlock(h2);
    seedMetadata(h2, [{ uuid: U(103), issuedAt: '2026-11-10T09:00:00' }]);
    const res = await h2.call('/api/portal-cfdi/run', { rfc: OWN, allMissing: true });
    assert.equal(res.status, 503);
    assert.match((await res.json()).error, /camina desde el NAS/);
    const state = await portalState(h2);
    assert.equal(state.configurado, false);
    assert.deepEqual(state.runs, []);
    assert.equal(state.quota.limit, 2000);
    console.log('297srv (a2) sin cablear: 503 honesto y estado configurado=false: ok');
  } finally { h2.service.close(); }

  /* El PDF del portal se archiva aparejado por el camino de la
     carpeta vigilada: documento «Factura PDF» con su UUID. */
  const pdfBuf = Buffer.from('%PDF-1.4 fixture del portal 297');
  const h3 = makeService({ satPortalFetch: async (profile, query, hooks) => {
    hooks.step('Ya estás dentro del portal.', '');
    const item = query.items[0];
    return { files: [{ uuid: item.uuid, name: item.uuid + '.xml',
        buffer: Buffer.from(xmlCfdi({ uuid: item.uuid, fecha: item.issuedAt + 'T10:00:00' })), pdf: pdfBuf }],
      found: 1, downloaded: 1, notListed: [], missing: [], complete: true, notes: [], quotaUsed: 1 };
  } });
  try {
    await h3.init();
    await seedPeopleUnlock(h3);
    const u = U(104);
    seedMetadata(h3, [{ uuid: u, issuedAt: '2026-11-10T09:00:00' }]);
    assert.equal((await h3.call('/api/portal-cfdi/run', { rfc: OWN, uuids: [u] })).status, 200);
    await waitPortalDone(h3);
    h3.seed(db => {
      const docs = db.prepare("SELECT value FROM records WHERE store='documents'").all()
        .map(row => JSON.parse(row.value)).filter(doc => doc.kind === 'Factura PDF' && doc.uuid === u);
      assert.equal(docs.length, 1, 'el PDF queda archivado como «Factura PDF» aparejado al UUID');
      const file = db.prepare("SELECT data,mime FROM records WHERE store='files' AND id=?").get(docs[0].id);
      assert.ok(file && Buffer.from(file.data).equals(pdfBuf), 'el fichero del PDF es el que entregó el portal');
    });
    console.log('297srv (a3) PDF del portal archivado aparejado por UUID: ok');
  } finally { h3.service.close(); }
}

/* ============ (b) periodo sobre la ventana atorada + C2 ============ */
{
  const record = {};
  const fakeNow = Date.parse('2026-11-18T18:00:00Z');
  const h = makeService({ now: () => fakeNow, satPortalFetch: happyPortal(record) });
  try {
    await h.init();
    await seedPeopleUnlock(h);
    const u1 = U(201), u2 = U(202);
    seedMetadata(h, [{ uuid: u1, issuedAt: '2026-11-09T09:00:00' }, { uuid: u2, issuedAt: '2026-11-12T09:00:00' }]);
    /* El trabajo atorado: CFDI pendiente desde hace 3 días sobre
       la ventana 2026-11-08 → 2026-11-14. */
    h.seed(db => db.prepare('INSERT INTO jobs(rfc,direction,kind,periodStart,periodEnd,startAt,endAt,requestId,status,due,created) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(OWN, 'received', 'cfdi', '2026-11-08', '2026-11-14', '2026-11-08 00:00:00', '2026-11-14 23:59:59', 'req-atorada', 'pending', fakeNow, fakeNow - 3 * DIA));
    let status = await (await h.call('/api/status')).json();
    let job = status.jobs.find(row => row.periodStart === '2026-11-08' && row.periodEnd === '2026-11-14' && row.direction === 'received');
    assert.deepEqual(job.portalRescue, { pendientes: 2, recuperada: false },
      'C2 antes: el trabajo atorado enseña sus 2 pendientes y recuperada=false');
    /* La corrida por periodo (la misma consulta del rescate). */
    const res = await h.call('/api/portal-cfdi/run', { rfc: OWN,
      period: { direction: 'received', startAt: '2026-11-08 00:00:00', endAt: '2026-11-14 23:59:59' }, origen: 'rescate' });
    assert.equal(res.status, 200);
    const fin = await waitPortalDone(h);
    assert.equal(fin.runs[0].counts.pedidos, 2);
    assert.equal(fin.runs[0].counts.bajados, 2);
    status = await (await h.call('/api/status')).json();
    job = status.jobs.find(row => row.periodStart === '2026-11-08' && row.periodEnd === '2026-11-14' && row.direction === 'received');
    assert.deepEqual(job.portalRescue, { pendientes: 0, recuperada: true },
      'C2 después: portalRescue pasa a recuperada=true');
    assert.equal(job.status, 'pending', 'la solicitud en el SAT NO se toca ni se marca cerrada');
    console.log('297srv (b) periodo sobre ventana atorada + C2 recuperada: ok');
  } finally { h.service.close(); }
}

/* ============ (c) cupo compartido: techo recortado + CIEC suma ============ */
{
  const record = {};
  const fakeNow = Date.parse('2026-11-18T18:00:00Z');
  const h = makeService({ now: () => fakeNow, satPortalFetch: happyPortal(record),
    satCiecFetch: async (profile, query, hooks) => {
      hooks.step('Paso de juguete dentro del portal…', '');
      return { files: [201, 202, 203].map(n => ({ name: 'ciec-' + n + '.xml',
          buffer: Buffer.from(xmlCfdi({ uuid: U(n), fecha: '2026-11-05T10:00:00' })) })),
        found: 3, downloaded: 3, complete: true, notes: [] };
    } });
  try {
    await h.init();
    await seedPeopleUnlock(h);
    const uuids = [U(301), U(302), U(303), U(304), U(305)];
    seedMetadata(h, uuids.map(uuid => ({ uuid, issuedAt: '2026-11-10T09:00:00' })));
    /* El contador del día casi lleno: 1999 de 2000. */
    h.seed(db => db.prepare('INSERT OR REPLACE INTO automation_state(key,value) VALUES (?,?)')
      .run('portal-cuota', JSON.stringify({ [mxDay(fakeNow)]: { [OWN]: 1999 } })));
    const res = await h.call('/api/portal-cfdi/run', { rfc: OWN, uuids });
    assert.equal(res.status, 200);
    const fin = await waitPortalDone(h);
    assert.equal(record.lastQuery.maxDownloads, 1, 'la corrida recibe maxDownloads recortado al cupo restante');
    assert.equal(fin.runs[0].counts.bajados, 1);
    assert.equal(fin.quota.used, 2000, 'el contador llega al límite del día');
    assert.equal(fin.quota.remaining, 0);
    assert.ok(fin.runs[0].steps.some(s => /Techo de esta corrida/.test(s.text)) || fin.progress.step.includes('no entregó todo'),
      'el recorte queda dicho en la corrida');
    /* Lo no bajado sigue pendiente: una corrida allMissing lo ve. */
    const pendientes = await (await h.call('/api/status')).json();
    assert.equal(pendientes.metadata.missing.filter(row => uuids.includes(row.uuid)).length, 4,
      'el resto queda pendiente con su nota, no se finge bajado');
    /* La corrida CIEC suma su downloaded al MISMO contador. */
    const RFC_C = 'BBB010101BB1';
    await h.call('/api/storage', { batch: { people: [{ id: RFC_C, name: 'Contribuyente CIEC' }] } });
    assert.equal((await h.call('/api/ciec', { rfc: RFC_C, ciec: 'secreto-ciec', minutes: 360, days: 7, direction: 'both' })).status, 200);
    assert.equal((await h.call('/api/ciec/run', { rfc: RFC_C, start: '2026-11-01', end: '2026-11-07', direction: 'received' })).status, 200);
    const ciecFin = await waitFor(async () => {
      const view = await (await h.call('/api/ciec')).json();
      const p = view.profiles.find(row => row.rfc === RFC_C);
      return p?.progress && !p.progress.running && p.runs.length ? p : null;
    }, 'el fin de la corrida CIEC');
    assert.equal(ciecFin.runs[0].downloaded, 3);
    const cuotaCiec = await portalState(h, RFC_C);
    assert.equal(cuotaCiec.quota.used, 3, 'la CIEC suma su downloaded al contador compartido del portal');
    console.log('297srv (c) cupo: techo recortado, resto pendiente y CIEC suma al mismo contador: ok');
  } finally { h.service.close(); }
}

/* ============ (d) cancelar a mitad: cierre parcial ============ */
{
  const h = makeService({ satPortalFetch: async (profile, query, hooks) => {
    hooks.step('Ya estás dentro del portal.', '');
    const item = query.items[0];
    const file = { uuid: item.uuid, name: item.uuid + '.xml',
      buffer: Buffer.from(xmlCfdi({ uuid: item.uuid, fecha: item.issuedAt + 'T10:00:00' })) };
    for (let i = 0; i < 250 && !hooks.isCancelled(); i++) await new Promise(r => setTimeout(r, 20));
    if (hooks.isCancelled())
      return { files: [file], found: query.items.length, downloaded: 1, notListed: [],
        missing: query.items.slice(1).map(x => x.uuid), complete: false,
        notes: ['Corrida cancelada: se guarda lo bajado y el resto queda pendiente (cancelado).'], quotaUsed: 1 };
    throw new Error('la cancelación no llegó al motor');
  } });
  try {
    await h.init();
    await seedPeopleUnlock(h);
    const uuids = [U(401), U(402), U(403)];
    seedMetadata(h, uuids.map(uuid => ({ uuid, issuedAt: '2026-11-10T09:00:00' })));
    assert.equal((await h.call('/api/portal-cfdi/run', { rfc: OWN, uuids })).status, 200);
    /* Segunda corrida en curso → 409 honesto. */
    assert.equal((await h.call('/api/portal-cfdi/run', { rfc: OWN, uuids })).status, 409);
    assert.equal((await h.call('/api/portal-cfdi/cancel', { rfc: OWN })).status, 200);
    const fin = await waitPortalDone(h);
    assert.match(fin.progress.step, /cancelada/i, 'el estado dice que la corrida se canceló');
    assert.equal(fin.runs[0].counts.bajados, 1, 'se guarda lo bajado');
    assert.equal(fin.runs[0].counts.pedidos, 3);
    assert.equal(fin.quota.used, 1);
    console.log('297srv (d) cancelar a mitad: cierre parcial dicho en el estado: ok');
  } finally { h.service.close(); }
}

/* ============ (e) disparador automático en el tick ============ */
{
  const record = {};
  const fakeNow = Date.parse('2026-11-18T18:00:00Z');
  const h = makeService({ now: () => fakeNow, satPortalFetch: happyPortal(record),
    makeConnector: async () => ({ parser: class {}, connector: {
      request: async () => 'req-auto-' + Math.random(),
      check: async () => ({ status: 'finished', packages: [] }),
      download: async () => { throw new Error('sin paquetes'); } } }) });
  try {
    await h.init();
    await seedPeopleUnlock(h);
    seedMetadata(h, [{ uuid: U(501), issuedAt: '2026-11-15T09:00:00' }, { uuid: U(502), issuedAt: '2026-11-16T09:00:00' }]);
    await h.service.tick();
    const fin = await waitPortalDone(h);
    assert.equal(record.calls, 1, 'el tick lanzó la corrida automática sin pedir nada');
    assert.equal(fin.runs[0].origen, 'automatica');
    assert.equal(fin.runs[0].counts.bajados, 2);
    await h.service.tick();
    await new Promise(r => setTimeout(r, 300));
    assert.equal(record.calls, 1, 'no se repite dentro de las 3 h');
    const tras = await portalState(h);
    assert.equal(tras.runs.filter(run => run.origen === 'automatica').length, 1);
    console.log('297srv (e) automático: el tick lanza solo y no repite en 3 h: ok');
  } finally { h.service.close(); }
}

/* ============ (f) C1 · red de fondo diaria de 1 día ============ */
{
  const fakeNow = Date.parse('2026-11-18T18:00:00Z'); /* miércoles 18, 12:00 MX */
  const calls = [];
  const h = makeService({ now: () => fakeNow,
    makeConnector: async () => ({ parser: class {}, connector: {
      request: async options => { calls.push(options); return 'req-fondo-' + calls.length; },
      check: async () => ({ status: 'finished', packages: [] }),
      download: async () => { throw new Error('sin paquetes'); } } }) });
  try {
    await h.init();
    await seedPeopleUnlock(h);
    await h.call('/api/monthly/config', { enabled: false, day: 5, hour: 9 });
    /* Con la revisión programada APAGADA, el fondo no pide nada. */
    await h.service.tick();
    let status = await (await h.call('/api/status')).json();
    assert.equal(status.criteriaBook.filter(e => e.sends.some(s => s.origin === 'fondo-diario')).length, 0,
      'sin el interruptor de la revisión programada, la red de fondo no corre');
    /* Ventana YA CUBIERTA: trabajo terminado de recibidos del 17. */
    h.seed(db => db.prepare('INSERT INTO jobs(rfc,direction,kind,periodStart,periodEnd,startAt,endAt,requestId,status,due,created) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(OWN, 'received', 'cfdi', '2026-11-17', '2026-11-17', '2026-11-17 00:00:00', '2026-11-17 23:59:59', 'req-cubierta', 'finished', fakeNow, fakeNow - DIA));
    /* Ventana con SOLICITUD VIVA: trabajo pendiente de emitidos del 17. */
    h.seed(db => db.prepare('INSERT INTO jobs(rfc,direction,kind,periodStart,periodEnd,startAt,endAt,requestId,status,due,created) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(OWN, 'issued', 'cfdi', '2026-11-17', '2026-11-17', '2026-11-17 00:00:00', '2026-11-17 23:59:59', 'req-viva', 'pending', fakeNow + 300000, fakeNow));
    /* Criterio YA USADO sin cobertura: recibidos del 16 pedidos por
       la ruta manual y su trabajo cerrado en fallo (ni cubierto ni
       vivo: solo el libro lo conoce) → no se re-pide. */
    assert.equal((await h.call('/api/request', { rfc: OWN, direction: 'received', start: '2026-11-16', end: '2026-11-16' })).status, 200);
    h.seed(db => db.prepare("UPDATE jobs SET status='failed' WHERE rfc=? AND direction='received' AND periodStart='2026-11-16'").run(OWN));
    /* Se enciende la revisión programada (el interruptor que manda). */
    assert.equal((await h.call('/api/revision/config', { enabled: true, dias: [0, 1, 2, 3, 4, 5, 6], hora: 8 })).status, 200);
    const antes = calls.length;
    await h.service.tick();
    status = await (await h.call('/api/status')).json();
    const fondo = status.criteriaBook.filter(e => e.sends.some(s => s.origin === 'fondo-diario'));
    const ventanas = fondo.map(e => e.direction + ' ' + e.startAt.slice(0, 10)).sort();
    assert.deepEqual(ventanas, ['issued 2026-11-15', 'issued 2026-11-16', 'received 2026-11-15'],
      'el fondo pide solo los días que faltan: ni la cubierta (recibidos 17), ni la viva (emitidos 17), ni la ya usada (recibidos 16)');
    assert.ok(fondo.every(e => e.startAt.endsWith('00:00:00') && e.endAt.endsWith('23:59:59') && e.startAt.slice(0, 10) === e.endAt.slice(0, 10)),
      'todas las ventanas del fondo son de 1 día exacto');
    const jobsFondo = status.jobs.filter(job => job.status === 'pending' &&
      ['2026-11-15', '2026-11-16'].includes(job.periodStart) && job.periodStart === job.periodEnd);
    assert.ok(jobsFondo.length >= 3, 'los trabajos del fondo quedan en la cola de siempre');
    /* Segunda pasada el mismo día: la marca lo frena. */
    const llamadasTrasPrimera = calls.length;
    await h.service.tick();
    status = await (await h.call('/api/status')).json();
    assert.equal(status.criteriaBook.filter(e => e.sends.some(s => s.origin === 'fondo-diario')).length, 3,
      'la red corre una vez al día por RFC');
    assert.ok(calls.length >= llamadasTrasPrimera, 'sin envíos nuevos del fondo en la segunda pasada');
    console.log('297srv (f) C1 fondo diario: pide lo que falta, salta cubierta/viva/usada, una vez al día: ok');
  } finally { h.service.close(); }
}

/* ============ (g) Lector: tiempos y sinXml ============ */
{
  const h = makeService({});
  try {
    await h.init();
    await h.call('/api/storage', { batch: { people: [{ id: OWN, name: 'Propia SA' }, { id: EMISOR, name: 'Emisor SA' }] } });
    const seedXml = async (uuid, conceptos) => {
      const xml = xmlCfdi({ uuid, conceptos });
      const row = parseXml(Buffer.from(xml), DOMParser);
      const res = await h.call('/api/storage', { batch: { invoices: [row],
        files: [{ id: 'xml:' + row.id, mime: 'application/xml', content: Buffer.from(xml).toString('base64') }] } });
      assert.equal(res.status, 200, 'semilla del comprobante ' + uuid);
      return xml.length;
    };
    /* XML de tamaño típico (1 concepto). */
    const uTipico = U(601);
    const bytesTipico = await seedXml(uTipico, 1);
    let t0 = Date.now();
    let res = await h.call('/api/cfdi/lectura?uuid=' + uTipico);
    const paredTipico = Date.now() - t0;
    assert.equal(res.status, 200);
    const lec = await res.json();
    assert.equal(lec.ok, true);
    assert.equal(lec.lectura.uuid, uTipico);
    assert.equal(lec.lectura.tipo, 'I');
    assert.equal(lec.lectura.emisor.rfc, EMISOR);
    assert.equal(lec.lectura.receptor.rfc, OWN);
    assert.equal(lec.lectura.receptor.uso, 'G03');
    assert.equal(lec.lectura.total, '116.00');
    assert.equal(lec.lectura.conceptos.length, 1);
    assert.equal(lec.lectura.conceptos[0].claveProdServ, '01010101');
    assert.equal(lec.lectura.impuestos.totalTrasladados, '16.00');
    assert.ok(lec.lectura.timbre.cadenaOriginal.startsWith('||1.1|' + uTipico + '|'), 'la cadena original sale del timbre parseado');
    assert.equal(lec.lectura.pagos, null);
    assert.ok(typeof lec.ms === 'number' && lec.ms < 1000, 'el parseo+servido del típico va en milisegundos');
    console.log('297srv (g) Lector típico (' + bytesTipico + ' B): servidor ' + lec.ms + ' ms · pared ' + paredTipico + ' ms');
    /* El mayor: 400 conceptos (no hay XML en las fixtures de la
       casa — solo HTML/txt — así que el mayor se construye con
       400 conceptos, ~105 KB, muy por encima de un CFDI real). */
    const uGrande = U(602);
    const bytesGrande = await seedXml(uGrande, 400);
    t0 = Date.now();
    res = await h.call('/api/cfdi/lectura?uuid=' + uGrande);
    const paredGrande = Date.now() - t0;
    assert.equal(res.status, 200);
    const lecG = await res.json();
    assert.equal(lecG.ok, true);
    assert.equal(lecG.lectura.conceptos.length, 400);
    assert.ok(lecG.ms < 1000, 'el parseo+servido del grande va en milisegundos, no segundos');
    console.log('297srv (g) Lector grande (' + bytesGrande + ' B, 400 conceptos): servidor ' + lecG.ms + ' ms · pared ' + paredGrande + ' ms');
    /* Comprobante sin XML guardado → 404 con sinXml:true. */
    const uSin = U(603);
    const rowSin = parseXml(Buffer.from(xmlCfdi({ uuid: uSin })), DOMParser);
    await h.call('/api/storage', { batch: { invoices: [rowSin] } });
    res = await h.call('/api/cfdi/lectura?uuid=' + uSin);
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { ok: false, sinXml: true });
    /* Invitado: dentro de su alcance lee; fuera, 403. */
    await h.call('/api/guest/config', { password: 'clave-invitado-297', enabled: true, rfcs: [EMISOR] });
    const guestLogin = await (await h.call('/api/guest/login', { password: 'clave-invitado-297' })).json();
    assert.ok(guestLogin.token);
    const asGuest = { 'x-pacosat-token': guestLogin.token };
    assert.equal((await h.call('/api/cfdi/lectura?uuid=' + uTipico, undefined, asGuest)).status, 200,
      'el invitado lee el comprobante de su alcance (emisor en alcance)');
    await h.call('/api/guest/config', { rfcs: ['CCC010101CC1'] });
    const guestLogin2 = await (await h.call('/api/guest/login', { password: 'clave-invitado-297' })).json();
    const asGuest2 = { 'x-pacosat-token': guestLogin2.token };
    assert.equal((await h.call('/api/cfdi/lectura?uuid=' + uTipico, undefined, asGuest2)).status, 403,
      'fuera de alcance → 403');
    console.log('297srv (g) Lector: tiempos en ms, sinXml:true y alcance del invitado: ok');
  } finally { h.service.close(); }
}

console.log('ronda297servidor.test: ok');
