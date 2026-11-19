import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DOMParser } from '@xmldom/xmldom';
import { createPacoSATService } from './local-server.mjs';
import { composeNewsMail } from './news-mail.mjs';

/* ================================================================
   Ronda 2.3.2 · Constructor B1 (servidor: seguridad y textos)
   B-1  Fuera el borrado en duro de CFDI (data/delete y storage
        replace) + la detección de coherencia sembrada en la base.
   M-1  Invitado con alcance de 1 RFC contra las cinco rutas:
        /api/status, /api/fiscal/issues, /api/fiscal/calendar,
        /api/lists y /api/reports/config.
   m-1  La manta de origen cubre también DELETE (logo).
   m-2  El correo de novedades en texto plano lleva el UUID.
   m-3  /api/cfdi/notas con ?rfc= y ?ids= (y sin parámetros igual).
   m-4  GUEST_GET ya no lista banks/banks-movements/offline-bundle
        ni reports/config (la denegación al invitado no cambia).
   m-5  Texto de arranque sin palabras duplicadas.
   m-8  Fuentes manuales 69-csd / 69-reduccion con estado honesto.
   M-7  /api/invoice-history compone el estado en llano desde el
        JSON real; caída honesta si no es JSON.
   m-24 /api/declaraciones/resumen sin rfc: 400 «Falta el RFC».
   o-2  La frase del autodiagnóstico, en llano y sin «5002».
   ================================================================ */

const ORIGIN = 'https://pacosat.test';
const KEY = 'b'.repeat(64);
const OWN = 'AAA010101AAA';
const OTRO = 'BBB010101BB1';
const EMISOR_A = 'CCC010101CC1';
const EMISOR_B = 'DDD010101DD1';
const A1 = '11111111-1111-4111-8111-111111111111';
const A2 = '22222222-2222-4222-8222-222222222222';
const B1 = '33333333-3333-4333-8333-333333333333';
const B2 = '44444444-4444-4444-8444-444444444444';
const META_A = '55555555-5555-4555-8555-555555555555';
const META_B = '66666666-6666-4666-8666-666666666666';

function makeHarness(options = {}) {
  const clock = { t: Date.parse('2026-11-16T15:00:00Z') };
  const mails = [];
  const service = createPacoSATService({
    dbFile: ':memory:', html: '<html><head><!--PACOSAT_TOKEN--></head><body>prueba</body></html>',
    origin: ORIGIN, proxyKey: KEY, satDocRetryWaitMs: 5,
    makeConnector: () => ({ parser: DOMParser, connector: {
      request: async () => 'req-232', check: async () => ({ status: 'pending', packages: [] }),
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
  return { service, call, callAs, raw, mails, clock };
}
const unlock = async (h, rfc) => {
  const open = await h.call('POST', '/api/unlock', { rfc, minutes: 1440, days: 7,
    direction: 'both', password: 'simulated', certificate: 'YQ==', key: 'Yg==' });
  assert.equal(open.status, 200, 'unlock de ' + rfc);
};
const invoice = (id, from, to, folio) => ({ id, date: '2026-10-05', kind: 'I', currency: 'MXN',
  total: '116.00', from: { rfc: from, name: 'Emisor ' + from }, to: { rfc: to, name: 'Receptor ' + to },
  fiscal: { serie: 'F', folio } });

/* ================= Bloque principal (base en fichero) ================= */
{
  const dir = mkdtempSync(join(tmpdir(), 'pacosat-232-b1-'));
  const file = join(dir, 'pacosat.db');
  let h = makeHarness({ dbFile: file });
  try {
    await unlock(h, OWN); await unlock(h, OTRO);
    const seed = await h.call('POST', '/api/storage', { batch: {
      people: [{ id: OWN, name: 'Empresa Propia SA' }, { id: OTRO, name: 'Otra Empresa SA' }],
      invoices: [invoice(A1, EMISOR_A, OWN, '100'), invoice(A2, EMISOR_A, OWN, '100'),
        invoice(B1, EMISOR_B, OTRO, '200'), invoice(B2, EMISOR_B, OTRO, '200')],
      files: [{ id: 'xml:' + A1, mime: 'application/xml', content: Buffer.from('<x/>').toString('base64') },
        { id: 'pdf:prueba232', mime: 'application/pdf', content: Buffer.from('%PDF-1.4 prueba').toString('base64') }] } });
    assert.equal(seed.status, 200, 'semilla del expediente');
    /* Notas (m-3) y configuración de informes con destinatarios. */
    assert.equal((await h.call('POST', '/api/cfdi/nota', { uuid: A1, nota: 'Nota del RFC propio' })).status, 200);
    assert.equal((await h.call('POST', '/api/cfdi/nota', { uuid: B1, nota: 'Nota del otro RFC' })).status, 200);
    assert.equal((await h.call('POST', '/api/reports/config', {
      nora: { enabled: true, day: 3, hour: 9, recipients: 'contadora@ejemplo.mx' },
      weekly: { enabled: false, day: 5, hour: 20, recipients: '' },
      manofil: { enabled: false, day: 3, hour: 9, recipients: '' },
      friday: { enabled: false, weekday: 5, hour: 18, recipients: '' } })).status, 200, 'informes configurados');
    /* Eventos manuales del calendario, uno por RFC. */
    assert.equal((await h.call('POST', '/api/fiscal/events',
      { rfc: OWN, title: 'Vencimiento manual propio', date: '2026-12-01' })).status, 200);
    assert.equal((await h.call('POST', '/api/fiscal/events',
      { rfc: OTRO, title: 'Vencimiento manual ajeno', date: '2026-12-02' })).status, 200);
    await h.service.close();

    /* Metadatos sin descargar: uno por RFC (la fila viaja solo
       con emisor/receptor; su RFC dueño va en la tabla). */
    const db = new DatabaseSync(file);
    const meta = db.prepare('INSERT INTO metadata_records(uuid,rfc,direction,emitter,receiver,issuedAt,total,status,cancelDate,seenAt) VALUES (?,?,?,?,?,?,?,?,?,?)');
    meta.run(META_A, OWN, 'received', EMISOR_A, OWN, '2026-10-06', '232.00', '1', '', Date.parse('2026-11-10T15:00:00Z'));
    meta.run(META_B, OTRO, 'received', EMISOR_B, OTRO, '2026-10-07', '464.00', '1', '', Date.parse('2026-11-10T15:00:00Z'));
    /* D-3 · la siembra del auditor, ampliada a todos los campos
       por RFC de /api/status: criterio del otro RFC con su
       requestId «secreto», solicitud viva de cada RFC, un job
       terminado ajeno, cuenta bancaria ajena sin estado del mes
       anterior, documento del SAT y declaración ajenos, trabajo
       del ejecutor ajeno en cola y ajustes por RFC de la
       revisión programada para los dos. */
    const crit = db.prepare('INSERT INTO criteria(key,rfc,direction,type,emitter,receiver,startAt,endAt,requestId,origin,sentAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
    crit.run(JSON.stringify([OTRO, 'received', 'cfdi', EMISOR_B, OTRO, '2026-10-01 00:00:00', '2026-10-31 23:59:59']),
      OTRO, 'received', 'cfdi', EMISOR_B, OTRO, '2026-10-01 00:00:00', '2026-10-31 23:59:59', 'REQ-SECRETO-OTRO', 'manual', Date.parse('2026-10-02T15:00:00Z'));
    crit.run(JSON.stringify([OWN, 'received', 'cfdi', EMISOR_A, OWN, '2026-10-01 00:00:00', '2026-10-31 23:59:59']),
      OWN, 'received', 'cfdi', EMISOR_A, OWN, '2026-10-01 00:00:00', '2026-10-31 23:59:59', 'REQ-PROPIO', 'manual', Date.parse('2026-10-02T15:00:00Z'));
    const jobIns = db.prepare("INSERT INTO jobs(rfc,direction,kind,periodStart,periodEnd,startAt,endAt,requestId,status,imported,due,created,error,checks) VALUES (?,?, 'cfdi',?,?,?,?,?,?,'[]',0,?, '', ?)");
    jobIns.run(OTRO, 'received', '2026-09-01', '2026-09-30', '2026-09-01 00:00:00', '2026-09-30 23:59:59', 'REQ-VIVA-OTRA', 'pending', Date.parse('2026-09-01T15:00:00Z'), 20);
    jobIns.run(OWN, 'received', '2026-09-01', '2026-09-30', '2026-09-01 00:00:00', '2026-09-30 23:59:59', 'REQ-VIVA-PROPIA', 'pending', Date.parse('2026-09-01T15:00:00Z'), 20);
    jobIns.run(OTRO, 'received', '2026-08-01', '2026-08-31', '2026-08-01 00:00:00', '2026-08-31 23:59:59', 'REQ-FIN-OTRA', 'finished', Date.parse('2026-08-01T15:00:00Z'), 3);
    db.prepare("INSERT INTO bank_accounts(id,bank,name,last4,kind,created,rfc) VALUES ('cta-otra-232','Banco Otro','Cuenta ajena','9999','debito',?,?)")
      .run(Date.parse('2026-10-01T15:00:00Z'), OTRO);
    db.prepare("INSERT INTO sat_documents(id,rfc,kind,issuedAt,fileId,source,created) VALUES ('doc-otro-232',?,'constancia',?,'docfile-otro','auto',?)")
      .run(OTRO, Date.parse('2026-10-03T15:00:00Z'), Date.parse('2026-10-03T15:00:00Z'));
    db.prepare("INSERT INTO declaraciones(id,rfc,tipo,clase,ejercicio,periodo,fileId,source,created) VALUES ('decl-otra-232',?,'mensual','acuse',2026,'2026-10','declfile-otro','auto',?)")
      .run(OTRO, Date.parse('2026-10-03T15:00:00Z'));
    db.prepare("INSERT INTO sat_executor_jobs(id,rfc,kind,estado,creado,actualizado) VALUES ('ej-otra-232',?,'buzon-listar','en-cola',?,?)")
      .run(OTRO, Date.parse('2026-11-15T15:00:00Z'), Date.parse('2026-11-15T15:00:00Z'));
    db.prepare("INSERT INTO settings(key,value) VALUES ('revision-programada',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(JSON.stringify({ enabled: false, dias: [1, 3, 5], hora: 8,
        porRfc: { [OTRO]: { enabled: true, dias: [2], hora: 9 }, [OWN]: { enabled: true, dias: [4], hora: 10 } } }));
    db.close();

    h = makeHarness({ dbFile: file });

    /* ---------- B-1 · data/delete ---------- */
    const delInv = await h.call('POST', '/api/data/delete', { store: 'invoices', ids: [A1] });
    assert.equal(delInv.status, 400, 'B-1: data/delete rechaza store invoices');
    assert.match(delInv.json?.error || '', /no se borra/i, 'el rechazo lo dice en llano');
    const delXml = await h.call('POST', '/api/data/delete', { store: 'files', ids: ['xml:' + A1] });
    assert.equal(delXml.status, 400, 'B-1: data/delete rechaza los files xml: (el XML del CFDI)');
    const siguen = await h.call('GET', '/api/storage?store=invoices');
    assert.ok((siguen.json || []).some(row => row.id === A1), 'el CFDI sigue en el expediente');
    const siguenFiles = await h.call('GET', '/api/storage?store=files');
    assert.ok((siguenFiles.json || []).some(row => row.id === 'xml:' + A1), 'su XML también sigue');
    /* Paridad: borrar lo que no es CFDI sigue funcionando. */
    const delPdf = await h.call('POST', '/api/data/delete', { store: 'files', ids: ['pdf:prueba232'] });
    assert.equal(delPdf.status, 200, 'un file que no es XML de CFDI sí se puede borrar');
    assert.equal(delPdf.json.removed, 1);
    /* Archivar con Deshacer sigue siendo el camino bueno. */
    const arch = await h.call('POST', '/api/cfdi/archivar', { uuid: A2, archivar: true });
    assert.equal(arch.status, 200, 'archivar un CFDI sigue funcionando');
    assert.equal((await h.call('POST', '/api/cfdi/archivar', { uuid: A2, archivar: false })).status, 200,
      'y desarchivar (Deshacer) también');

    /* ---------- B-1 · storage replace ---------- */
    const repInv = await h.call('POST', '/api/storage', { replace: true, batch: { invoices: [] } });
    assert.equal(repInv.status, 400, 'B-1: storage replace sobre invoices se rechaza');
    assert.match(repInv.json?.error || repInv.text || '', /no puede reemplazar|no se borra/i,
      'con un error claro: la sincronización nunca resta facturas');
    const trasReplace = await h.call('GET', '/api/storage?store=invoices');
    assert.equal((trasReplace.json || []).length, 4, 'ninguna factura desapareció en el intento');

    /* ---------- D-1 · storage replace sobre files (vía gemela del auditor) ---------- */
    /* El PDF de prueba se resiembra (salió por data/delete arriba):
       la tienda queda como la sembró el auditor, [xml:…, pdf:…]. */
    const reseedPdf = await h.call('POST', '/api/storage', { batch: {
      files: [{ id: 'pdf:prueba232', mime: 'application/pdf', content: Buffer.from('%PDF-1.4 prueba').toString('base64') }] } });
    assert.equal(reseedPdf.status, 200, 'PDF resembrado para el caso (b3)');
    const repFiles = await h.call('POST', '/api/storage', { replace: true, batch: { files: [] } });
    assert.equal(repFiles.status, 400, 'D-1 (b3): replace files:[] se rechaza — haría desaparecer el XML del CFDI');
    assert.match(repFiles.json?.error || repFiles.text || '', /XML de un comprobante/,
      'con el porqué: el XML forma parte del expediente');
    const filesTras = await h.call('GET', '/api/storage?store=files');
    assert.ok((filesTras.json || []).some(row => row.id === 'xml:' + A1), 'D-1 (b3): el XML sigue tras el replace rechazado');
    assert.ok((filesTras.json || []).some(row => row.id === 'pdf:prueba232'), 'D-1 (b3): el PDF también sigue');
    /* Lote mixto: el XML desaparece del lote de files y otra tienda
       válida cambia — el lote ENTERO se rechaza y nada se mueve. */
    const repMixto = await h.call('POST', '/api/storage', { replace: true, batch: {
      people: [{ id: OWN, name: 'Nombre Cambiado En El Lote Mixto' }, { id: OTRO, name: 'Otra Empresa SA' }],
      files: [{ id: 'pdf:prueba232', mime: 'application/pdf', content: Buffer.from('%PDF-1.4 prueba').toString('base64') }] } });
    assert.equal(repMixto.status, 400, 'D-1 mixto: files sin el xml: en el lote → 400 aunque el resto del lote sea válido');
    const peopleTras = await h.call('GET', '/api/storage?store=people');
    assert.equal((peopleTras.json || []).find(row => row.id === OWN)?.name, 'Empresa Propia SA',
      'D-1 mixto: la otra tienda del lote queda SIN cambios (el lote se revierte entero)');
    const filesTras2 = await h.call('GET', '/api/storage?store=files');
    assert.ok((filesTras2.json || []).some(row => row.id === 'xml:' + A1), 'D-1 mixto: el XML sigue');
    /* Paridad: un replace de files que CONSERVA el xml: sí pasa. */
    const repFilesOk = await h.call('POST', '/api/storage', { replace: true, batch: { files: [
      { id: 'xml:' + A1, mime: 'application/xml', content: Buffer.from('<x/>').toString('base64') },
      { id: 'pdf:prueba232', mime: 'application/pdf', content: Buffer.from('%PDF-1.4 prueba').toString('base64') }] } });
    assert.equal(repFilesOk.status, 200, 'D-1 paridad: replace de files conservando el XML no se bloquea');

    /* ---------- m-3 · notas con filtros ---------- */
    const todas = await h.call('GET', '/api/cfdi/notas');
    assert.deepEqual(Object.keys(todas.json.notas).sort(), [A1, B1].sort(),
      'sin parámetros, la respuesta de siempre: el mapa completo');
    const porRfc = await h.call('GET', '/api/cfdi/notas?rfc=' + OWN);
    assert.deepEqual(porRfc.json.notas, { [A1]: 'Nota del RFC propio' }, '?rfc= deja solo las de ese RFC');
    const porRfcOtro = await h.call('GET', '/api/cfdi/notas?rfc=' + OTRO);
    assert.deepEqual(porRfcOtro.json.notas, { [B1]: 'Nota del otro RFC' });
    const porIds = await h.call('GET', '/api/cfdi/notas?ids=' + B1);
    assert.deepEqual(porIds.json.notas, { [B1]: 'Nota del otro RFC' }, '?ids= deja solo las pedidas');
    const cruce = await h.call('GET', '/api/cfdi/notas?rfc=' + OWN + '&ids=' + B1);
    assert.deepEqual(cruce.json.notas, {}, 'con los dos filtros manda la intersección');

    /* ---------- m-24 · resumen de declaraciones ---------- */
    const sinRfc = await h.call('GET', '/api/declaraciones/resumen');
    assert.equal(sinRfc.status, 400, 'm-24: sin rfc, 400');
    assert.match(sinRfc.json?.error || '', /Falta el RFC/, 'y dice lo que falta');
    const desconocido = await h.call('GET', '/api/declaraciones/resumen?rfc=ZZZ010101ZZ1');
    assert.equal(desconocido.status, 404, 'con RFC desconocido se queda el 404');
    assert.match(desconocido.json?.error || '', /no tiene perfil/);
    assert.equal((await h.call('GET', '/api/declaraciones/resumen?rfc=' + OWN)).status, 200,
      'con RFC con perfil, el resumen responde');

    /* ---------- m-1 · DELETE bajo la manta de origen ---------- */
    const logoOk = await h.call('POST', '/api/settings/logo',
      { mime: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' });
    assert.equal(logoOk.status, 200, 'logo sembrado');
    const delAjeno = await h.raw('DELETE', '/api/settings/logo', undefined,
      { origin: 'https://evil.example', 'x-pacosat-token': (await h.raw('GET', '/')).text.match(/[0-9a-f]{64}/)[0] });
    assert.equal(delAjeno.status, 403, 'm-1: DELETE con Origin extranjero, 403 como las demás mutaciones');
    const trasAjeno = await h.call('GET', '/api/settings/logo');
    assert.equal(trasAjeno.status, 200, 'el logo sigue: el DELETE extranjero no borró nada');

    /* ---------- M-1 · el invitado de 1 RFC contra las cinco rutas ---------- */
    /* Foto admin previa, para contrastar. */
    const adminIssues = (await h.call('GET', '/api/fiscal/issues')).json.issues;
    assert.ok(adminIssues.some(i => i.id === B1 || i.id === B2), 'el admin sí ve el problema del otro RFC');
    const adminLists = (await h.call('GET', '/api/lists')).json;
    const expoBAdmin = adminLists.counterparts.find(cp => cp.rfc === EMISOR_B);
    assert.ok(expoBAdmin?.detalle?.recibidos?.count === 2, 'el admin ve la exposición del otro RFC (2 CFDI)');

    assert.equal((await h.call('POST', '/api/guest/config',
      { password: 'invitado-232', enabled: true, rfcs: [OWN] })).status, 200);
    const login = await h.call('POST', '/api/guest/login', { password: 'invitado-232' });
    assert.ok(login.json.token, 'sesión de invitado emitida');
    const guest = login.json.token;
    const g = (path) => h.callAs(guest, 'GET', path);

    const adminStatus = (await h.call('GET', '/api/status')).json;
    assert.ok((adminStatus.criteriaBook || []).some(e => e.rfc === OTRO &&
      e.sends?.some(s => s.requestId === 'REQ-SECRETO-OTRO')),
      'contraste: el admin SÍ ve el criteriaBook entero del otro RFC');
    assert.ok((adminStatus.revision?.porRfc || []).some(p => p.rfc === OTRO),
      'contraste: el admin ve revision.porRfc del otro RFC');
    assert.ok((adminStatus.solicitudesVivas || []).some(v => v.rfc === OTRO),
      'contraste: el admin ve la solicitud viva del otro RFC');
    assert.ok((adminStatus.estadosPendientes?.faltantes || []).some(f => f.accountId === 'cta-otra-232'),
      'contraste: el admin ve la cuenta ajena sin estado');
    assert.ok(adminStatus.expediente.total >= 2, 'contraste: el admin cuenta los documentos ajenos');
    assert.ok(adminStatus.metadata.records === 2, 'contraste: el admin cuenta los dos metadatos');
    assert.ok(adminStatus.ejecutorEspera201.esperando >= 1, 'contraste: el admin cuenta el trabajo del ejecutor en cola');
    assert.ok(adminStatus.downloads.finishedJobs >= 1, 'contraste: el admin cuenta el job terminado ajeno');

    const gStatus = await g('/api/status');
    assert.equal(gStatus.status, 200);
    assert.ok(gStatus.json.profiles.every(p => p.rfc === OWN), 'status: solo perfiles de su RFC');
    const missing = gStatus.json.metadata.missing || [];
    assert.ok(missing.some(m => m.uuid === META_A), 'status: su metadato sin descargar sí sale');
    assert.ok(!missing.some(m => m.uuid === META_B), 'M-1 status: el metadato del otro RFC NO sale');

    /* ---------- D-3 · /api/status entero dentro del alcance ---------- */
    assert.ok(!(gStatus.text || '').includes('REQ-SECRETO-OTRO'),
      'D-3: el requestId del criterio ajeno no llega al invitado');
    assert.ok(!(gStatus.text || '').includes(OTRO),
      'D-3: ningún campo de la respuesta nombra al otro RFC');
    assert.ok((gStatus.json.criteriaBook || []).every(e => e.rfc === OWN),
      'D-3 criteriaBook: solo entradas de su RFC');
    assert.ok((gStatus.json.criteriaBook || []).some(e => e.sends?.some(s => s.requestId === 'REQ-PROPIO')),
      'D-3 criteriaBook: su propio criterio sí sale entero');
    assert.ok((gStatus.json.revision?.porRfc || []).every(p => p.rfc === OWN),
      'D-3 revision.porRfc: solo su RFC');
    assert.ok(gStatus.json.revision?.porRfc?.some(p => p.rfc === OWN), 'D-3 revision: su fila sí sale');
    assert.ok(!Object.keys(gStatus.json.revision?.config?.porRfc || {}).some(rfc => rfc !== OWN),
      'D-3 revision.config.porRfc: sin ajustes de otro RFC');
    assert.ok((gStatus.json.solicitudesVivas || []).every(v => v.rfc === OWN),
      'D-3 solicitudesVivas: solo las de su RFC');
    assert.ok(gStatus.json.solicitudesVivas?.some(v => v.rfc === OWN), 'D-3 solicitudesVivas: la suya sí sale');
    assert.ok((gStatus.json.estadosPendientes?.faltantes || []).every(f => f.rfc === OWN),
      'D-3 estadosPendientes: ninguna cuenta ajena');
    assert.ok(!(gStatus.json.estadosPendientes?.faltantes || []).some(f => f.accountId === 'cta-otra-232'),
      'D-3 estadosPendientes: la cuenta del otro RFC no se nombra');
    assert.equal(gStatus.json.metadata.records, 1, 'D-3 metadata.records: el total es el de SU alcance, no el global');
    assert.equal(gStatus.json.downloads.finishedJobs, 0, 'D-3 downloads: el job terminado ajeno no se cuenta');
    assert.equal(gStatus.json.ejecutorEspera201.esperando, 0, 'D-3 ejecutorEspera201: la cola ajena no se cuenta');
    assert.equal(gStatus.json.expediente.total, 0, 'D-3 expediente: sin documentos del SAT ni declaraciones, porque son ajenos');
    assert.ok(Object.keys(gStatus.json.watchSummary?.perRfc || {}).every(rfc => rfc === OWN),
      'D-3 watchSummary.perRfc: solo su RFC');
    assert.equal(gStatus.json.watchSummary.total, gStatus.json.watchSummary.perRfc[OWN]?.total,
      'D-3 watchSummary: el total de arriba es el de su alcance, no el global');
    assert.ok((gStatus.json.coverage?.groups || []).every(x => x.rfc === OWN) &&
      (gStatus.json.coverage?.records || []).every(x => x.rfc === OWN) &&
      (gStatus.json.coverage?.gaps || []).every(x => x.rfc === OWN) &&
      Object.keys(gStatus.json.coverage?.days || {}).every(rfc => rfc === OWN),
      'D-3 coverage (objeto): groups, records, gaps y days solo de su RFC');
    assert.ok((adminStatus.coverage?.groups || []).some(x => x.rfc === OTRO),
      'contraste: la coverage del admin sí trae al otro RFC (el filtro viejo pedía un array y no se aplicaba)');

    const gIssues = await g('/api/fiscal/issues');
    assert.equal(gIssues.status, 200);
    assert.ok(gIssues.json.issues.length > 0, 'issues: ve los problemas de su RFC');
    assert.ok(gIssues.json.issues.every(i => [A1, A2].includes(i.id)),
      'M-1 issues: ningún problema de otro RFC (ni su UUID ni sus totales)');

    const gCal = await g('/api/fiscal/calendar');
    assert.equal(gCal.status, 200);
    assert.ok(gCal.json.events.length > 0, 'calendar: ve los eventos de su RFC');
    assert.ok(gCal.json.events.every(e => e.rfc === OWN),
      'M-1 calendar: ningún evento de otro RFC (ni su caducidad ni sus manuales)');

    const gLists = await g('/api/lists');
    assert.equal(gLists.status, 200);
    const expoA = gLists.json.counterparts.find(cp => cp.rfc === EMISOR_A);
    assert.equal(expoA?.detalle?.recibidos?.count, 2, 'lists: su exposición sale completa (2 CFDI)');
    assert.equal(expoA?.detalle?.recibidos?.total, '232.00', 'con su importe, de sus facturas');
    const expoB = gLists.json.counterparts.find(cp => cp.rfc === EMISOR_B);
    assert.ok(!expoB || (!expoB.detalle && !expoB.exposure),
      'M-1 lists: la contraparte del otro RFC no trae exposición calculada con facturas ajenas');

    const gReports = await g('/api/reports/config');
    assert.equal(gReports.status, 403, 'M-1 reports/config: fuera del alcance del invitado');
    assert.ok(!(gReports.text || '').includes('contadora@ejemplo.mx'),
      'ningún destinatario de informes llega al invitado');

    /* ---------- m-4 · banks / offline: denegados como siempre ---------- */
    for (const ruta of ['/api/banks', '/api/banks/movements', '/api/offline-bundle']) {
      const r = await g(ruta);
      assert.equal(r.status, 403, 'm-4: ' + ruta + ' sigue denegado a todo invitado (comportamiento idéntico)');
    }
    const fuente = readFileSync(join(import.meta.dirname, 'local-server.mjs'), 'utf8');
    const guestGet = fuente.slice(fuente.indexOf('const GUEST_GET'), fuente.indexOf('];', fuente.indexOf('const GUEST_GET')));
    for (const fuera of ['/api/banks', '/api/offline-bundle', '/api/reports/config'])
      assert.ok(!guestGet.includes("'" + fuera + "'"), 'm-4/M-1: GUEST_GET ya no lista ' + fuera + ' (la lista no miente)');

    /* ---------- m-8 · fuentes manuales con estado honesto ---------- */
    const adminLists2 = (await h.call('GET', '/api/lists')).json;
    for (const idFuente of ['69-csd', '69-reduccion']) {
      const src = adminLists2.sources.find(s => s.id === idFuente);
      assert.ok(src, 'la fuente ' + idFuente + ' existe');
      assert.equal(src.declared, 'sin fuente automática: se revisa a mano',
        'm-8: ' + idFuente + ' declara su estado honesto en el campo que la pantalla pinta');
      assert.ok(!src.fetched, 'm-8: sin fecha inventada');
      assert.equal(src.count, 0, 'm-8: sin conteo inventado');
    }

    /* ---------- o-2 · autodiagnóstico en llano ---------- */
    const self = await h.call('GET', '/api/selftest');
    const satCheck = (self.json.checks || []).find(c => c.id === 'sat');
    assert.ok(satCheck, 'el autodiagnóstico trae su comprobación del SAT');
    assert.equal(satCheck.detail, 'Comprobarlo gastaría solicitudes del SAT: no se comprueba en pruebas.');
    assert.ok(!/5002/.test(satCheck.detail), 'o-2: sin código interno en esa frase');

    /* ---------- Paridad B-1: replace sobre otra tienda sigue vivo ---------- */
    const repPeople = await h.call('POST', '/api/storage', { replace: true,
      batch: { people: [{ id: OWN, name: 'Empresa Propia SA' }, { id: OTRO, name: 'Otra Empresa SA' }] } });
    assert.equal(repPeople.status, 200, 'el replace de stores no-CFDI no se tocó');
  } finally { try { h.service.close(); } catch { /* ya cerrado */ } rmSync(dir, { recursive: true, force: true }); }
  console.log('OK 2.3.2 B1 · B-1/M-1/m-1(DELETE con origen ajeno, 403)/m-3/m-4/m-8/m-24/o-2 en el bloque principal.');
}

/* ================= m-1 · DELETE con origen propio SÍ pasa ================= */
{
  const h = makeHarness({});
  try {
    const logoOk = await h.call('POST', '/api/settings/logo',
      { mime: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' });
    assert.equal(logoOk.status, 200);
    const home = await h.raw('GET', '/');
    const token = /[0-9a-f]{64}/.exec(home.text)?.[0] || '';
    const delPropio = await h.raw('DELETE', '/api/settings/logo', undefined, { 'x-pacosat-token': token });
    assert.equal(delPropio.status, 200, 'm-1: DELETE con origen propio pasa la manta y borra el logo');
    assert.equal((await h.call('GET', '/api/settings/logo')).status, 404, 'el logo ya no está');
  } finally { await h.service.close(); }
  console.log('OK 2.3.2 B1 · m-1: el DELETE legítimo del logo sigue funcionando.');
}

/* ================= M-7 + B-1/c · historia y coherencia con semilla directa ================= */
{
  const dir = mkdtempSync(join(tmpdir(), 'pacosat-232-hist-'));
  const file = join(dir, 'pacosat.db');
  const H_CANC = '77777777-7777-4777-8777-777777777777';
  const H_VIEJO = '88888888-8888-4888-8888-888888888888';
  const H_LARGO = '99999999-9999-4999-8999-999999999999';
  const FANTASMA = '12121212-1212-4212-8212-121212121212';
  {
    const boot = createPacoSATService({ dbFile: file, html: '<!--PACOSAT_TOKEN-->', origin: ORIGIN, proxyKey: KEY,
      makeMailer: () => ({ verify: async () => true, sendMail: async () => {} }) });
    boot.close();
    const db = new DatabaseSync(file);
    const watch = db.prepare('INSERT INTO cfdi_watch(id,emitter,receiver,total,seal,next,checked,result,error) VALUES (?,?,?,?,?,0,?,?, \'\')');
    watch.run(H_CANC, EMISOR_A, OWN, '116.00', '', Date.parse('2026-10-09T15:00:00Z'),
      JSON.stringify({ state: 'Cancelado', code: 'S - Comprobante obtenido satisfactoriamente.', cancellation: 'Con aceptación', cancelable: '', efos: '' }));
    watch.run(H_VIEJO, EMISOR_A, OWN, '116.00', '', Date.parse('2026-10-09T15:00:00Z'), 'Vigente');
    watch.run(H_LARGO, EMISOR_A, OWN, '116.00', '', Date.parse('2026-10-09T15:00:00Z'), 'X'.repeat(400));
    const notice = db.prepare("INSERT INTO news_notices(kind,opkey,rfc,direction,label,recipient,due,sent) VALUES ('sat','op-232',?,'received','','',0,?)")
      .run(OWN, Date.parse('2026-11-10T15:00:00Z'));
    db.prepare('INSERT INTO news_items(notice,uuid,fecha,counterpartName,counterpartRfc,total,kind,direction) VALUES (?,?,?,?,?,?,?,?)')
      .run(Number(notice.lastInsertRowid), FANTASMA, '2026-10-06', 'Emisor fantasma', EMISOR_A, '10.00', 'I', 'received');
    db.close();
  }
  const h = makeHarness({ dbFile: file });
  try {
    const histCanc = (await h.call('GET', '/api/invoice-history?id=' + H_CANC)).json;
    const evCanc = histCanc.events.find(e => e.kind === 'status');
    assert.equal(evCanc.detail, 'Estado: Cancelado · Cancelación: con aceptación',
      'M-7: el JSON real se compone en llano');
    assert.ok(!/\{|\}/.test(evCanc.detail), 'nada de JSON crudo en la historia');
    const histViejo = (await h.call('GET', '/api/invoice-history?id=' + H_VIEJO)).json;
    assert.equal(histViejo.events.find(e => e.kind === 'status').detail, 'Vigente',
      'M-7: una fila vieja en texto sale tal cual (caída honesta)');
    const histLargo = (await h.call('GET', '/api/invoice-history?id=' + H_LARGO)).json;
    assert.equal(histLargo.events.find(e => e.kind === 'status').detail.length, 300,
      'M-7: el texto no-JSON se recorta, no se vuelca entero');
    const cruce = await h.call('POST', '/api/salud/coherencia', {});
    assert.equal(cruce.status, 200);
    assert.ok(cruce.json.desacuerdos.some(d => d.tipo === 'novedad-sin-alta'),
      'B-1/c: la detección «novedad-sin-alta» sigue viva sembrada en la base (sin borrar ningún CFDI)');
  } finally { await h.service.close(); rmSync(dir, { recursive: true, force: true }); }
  console.log('OK 2.3.2 B1 · M-7: historia en llano + caída honesta; coherencia detecta la novedad sin alta.');
}

/* ================= m-2 · el texto plano del correo lleva el UUID ================= */
{
  const UUID_M = '12345678-1234-4234-8234-1234567890ab';
  const mail = composeNewsMail({ kind: 'recuperacion', rfc: OWN, direction: 'received', label: 'octubre de 2026' },
    [{ uuid: UUID_M, fecha: '2026-10-05', counterpartName: 'Proveedor SA', counterpartRfc: EMISOR_A,
      folio: '100', serie: 'F', total: '116.00', estado: 'Vigente', kind: 'I', direction: 'received' }]);
  const linea = mail.text.split('\n').find(l => l.includes('Proveedor SA'));
  assert.ok(linea && linea.includes(' · UUID ' + UUID_M), 'm-2: la línea de texto lleva « · UUID <uuid>»');
  assert.ok(mail.html.includes('UUID: ' + UUID_M), 'la tarjeta HTML lo sigue llevando');
  console.log('OK 2.3.2 B1 · m-2: UUID en texto plano y en HTML.');
}

/* ================= m-5 · arranque sin duplicados ================= */
{
  const h = makeHarness({});
  try {
    await h.call('GET', '/api/salud');
    const registro = await h.call('GET', '/api/registro?limit=300');
    const entradas = (registro.json.items || []).filter(item => /arrancó:/.test(item.texto || ''));
    assert.ok(entradas.length >= 1, 'el asiento de arranque existe');
    for (const entrada of entradas) {
      assert.ok(!/(puerta puerta|correo correo|ejecutor ejecutor)/.test(entrada.texto),
        'm-5: sin palabras duplicadas en «' + entrada.texto + '»');
      assert.match(entrada.texto, /arrancó: puerta /, 'la puerta se nombra una vez');
      assert.match(entrada.texto, /, correo /, 'el correo se nombra una vez');
    }
  } finally { await h.service.close(); }
  console.log('OK 2.3.2 B1 · m-5: asiento de arranque sin duplicados.');
}

console.log('ronda232servidor.test: ok — B1 completo (B-1, M-1, m-1, m-2, m-3, m-4, m-5, m-8, M-7, m-24, o-2).');
