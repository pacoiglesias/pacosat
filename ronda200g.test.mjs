/* ================================================================
   Ronda 2.0 · Tanda 7A — SALIDAS, DOCUMENTOS Y CIERRE
   (1) Cierre guiado: mes incompleto nombra lo que falta; mes
       completo se cierra y deja sus informes pre-generados.
   (2) ZIP del mes RFC-periodo con sus carpetas + envío al
       despacho preparado (y enviado solo con destinatario).
   (3) Miniatura real: PDF semilla ⇒ PNG generado una vez.
   (4) Compartir: correo preparado con ficha y adjunto, sin enviar.
   (5) Panel de valor: las cifras salen de los registros semilla.
   (6) Candado: diciembre cerrado ⇒ escrituras de 2026 bloqueadas
       EN EL SERVIDOR; el desbloqueo queda en el Registro.
   (7) Restauración guiada con respaldo de seguridad previo.
   (8) ZIP por contraparte con su índice que suma solo lo listado.
   (9) Pólizas: cuenta EN BLANCO y debe = haber con el CFDI semilla.
   (10) Webhook: doble HTTP local recibe el evento FIRMADO y la
       entrega queda registrada.
   (11) Paperless: el doble recibe el documento con su título
       «PacoSAT — <tipo> — <RFC> — <fecha>».
   (12) ICS por RFC: eventos = vencimientos; regenerar revoca.
   (13) Informes pre-generados: tras cerrar, el PDF se sirve con
       su fecha de generación.
   (14) Subir un papel: PDF suelto archivado con tipo sugerido.
   ================================================================ */
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { createPacoSATService } from './local-server.mjs';
import { buildPdf } from './salidas-doc.mjs';

const ORIGIN = 'https://pacosat.test';
const KEY = 'f'.repeat(64);
const OWN = 'MFI6212158B4';
const PROV1 = 'AAA010101AAA';
const PROV2 = 'BBB010101BB2';
const CLI1 = 'CCC010101CC3';
const R1 = '11111111-1111-4111-8111-111111111111';
const E1 = '22222222-2222-4222-8222-222222222222';
const C1 = '33333333-3333-4333-8333-333333333333';
const S1 = '44444444-4444-4444-8444-444444444444';
const D1 = '55555555-5555-4555-8555-555555555555';
const T0 = Date.parse('2026-11-05T15:00:00Z');

const pdfReal = buildPdf({ title: 'Documento semilla', subtitle: 'PacoSAT · prueba 200g',
  sections: [{ heading: 'Contenido', lines: ['Primera página del documento semilla.'] }] });
const pdf64 = pdfReal.toString('base64');
const xmlDe = uuid => ('<?xml version="1.0"?><Comprobante UUID="' + uuid + '"/>');
const xml64 = uuid => Buffer.from(xmlDe(uuid)).toString('base64');

function makeHarness(extra = {}) {
  let time = T0;
  let token = '';
  const mails = [];
  const service = createPacoSATService({
    dbFile: ':memory:', html: '<html><head><!--PACOSAT_TOKEN--></head><body>prueba</body></html>',
    origin: ORIGIN, proxyKey: KEY, now: () => time,
    extractText: async () => '',
    makeConnector: async () => ({ parser: class {}, connector: {
      request: async () => 'req-f', check: async () => ({ status: 'pending', packages: [] }),
      download: async () => { throw new Error('sin paquetes'); } } }),
    makeMailer: () => ({ verify: async () => true,
      sendMail: async mail => { mails.push(mail); return { messageId: 'm' + mails.length }; } }),
    ...extra });
  const raw = async (method, path, body, extraHeaders = {}) => {
    const chunks = []; if (body !== undefined) chunks.push(Buffer.from(JSON.stringify(body)));
    const req = Readable.from(chunks);
    req.method = method; req.url = path;
    req.headers = { host: 'pacosat.test', origin: ORIGIN, 'x-pacosat-proxy': KEY, ...extraHeaders };
    let status = 0; let text = '';
    const res = { writeHead(c) { status = c; }, setHeader() {}, getHeader() { return undefined; },
      end(chunk) { if (chunk) text += Buffer.isBuffer(chunk) ? chunk.toString('latin1') : chunk; } };
    await service.handle(req, res);
    return { status, text };
  };
  const call = async (method, path, body) => {
    if (!token) { const home = await raw('GET', '/'); token = /[0-9a-f]{64}/.exec(home.text)?.[0] || ''; }
    const r = await raw(method, path, body, { 'x-pacosat-token': token });
    let json = null; try { json = JSON.parse(r.text); } catch { /* binario */ }
    return { status: r.status, json, text: r.text };
  };
  return { service, call, raw, mails,
    set time(v) { time = v; }, get time() { return time; } };
}
const base = async h => {
  const mail = await h.call('POST', '/api/mail', { host: 'smtp.test', port: 465, security: 'ssl',
    from: 'avisos@pacosat.test', recipient: 'paco@test.mx', user: 'u', password: 'p' });
  assert.equal(mail.status, 200);
  const seed = await h.call('POST', '/api/storage', { batch: {
    people: [{ id: OWN, name: 'Mano Fil, S.A.' }] } });
  assert.equal(seed.status, 200);
  const open = await h.call('POST', '/api/unlock', { rfc: OWN, minutes: 1440, days: 7,
    direction: 'both', password: 'simulated', certificate: 'YQ==', key: 'Yg==' });
  assert.equal(open.status, 200, 'unlock');
};
const invoice = (id, date, from, to, total, extra = {}) => ({ id, date, kind: 'I',
  from: { rfc: from, name: 'EMPRESA ' + from }, to: { rfc: to, name: 'EMPRESA ' + to },
  total, currency: 'MXN',
  fiscal: { paymentMethod: 'PUE', transferred: [{ tax: '002', rate: '0.160000', amount: '0.00' }], withheld: [] },
  ...extra });

/* ===== Escenario principal con DB en fichero (semillas directas) ===== */
const dir = mkdtempSync(join(tmpdir(), 'pacosat-200g-'));
const dbFile = join(dir, 'pacosat.sqlite');
const subidasPaperless = [];
{
  const boot = createPacoSATService({ dbFile, html: 'x', origin: ORIGIN, proxyKey: KEY });
  boot.close();
  const seed = new DatabaseSync(dbFile);
  seed.prepare("INSERT INTO profiles(rfc,minutes,days,direction,nextRun,error) VALUES (?,1440,7,'both',0,'')").run(OWN);
  const meta = seed.prepare('INSERT INTO metadata_records(uuid,rfc,direction,emitter,receiver,issuedAt,total,status,cancelDate,seenAt) VALUES (?,?,?,?,?,?,?,?,?,?)');
  meta.run(R1, OWN, 'received', PROV1, OWN, '2026-10-03', '1160.00', '1', '', T0);
  meta.run(E1, OWN, 'issued', OWN, CLI1, '2026-10-04', '2320.00', '1', '', T0);
  meta.run(C1, OWN, 'received', PROV2, OWN, '2026-10-05', '580.00', '0', '2026-10-06', T0);
  meta.run(D1, OWN, 'received', PROV1, OWN, '2026-12-03', '1160.00', '1', '', T0);
  seed.prepare("INSERT INTO cfdi_watch(id,emitter,receiver,total,seal,next,checked,result,error) VALUES (?,?,?,?,?,0,?,?, '')")
    .run(C1, PROV2, OWN, '580.00', '', T0, JSON.stringify({ state: 'Cancelado' }));
  seed.prepare("INSERT INTO jobs(rfc,direction,periodStart,periodEnd,startAt,endAt,requestId,status,imported,due,created,error,checks) VALUES (?,?, '2026-10-01','2026-10-31','2026-10-01 00:00:00','2026-10-31 23:59:59','req-1','finished',?,0,?,'',0)")
    .run(OWN, 'received', JSON.stringify([R1]), T0);
  seed.prepare("INSERT INTO trib_notifications(rfc,clave,fecha,asunto,remitente,estado,abierta,primeraVez,ultimaVez,categoria,archivada,archivadaEn) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(OWN, 'clave-1', '2026-10-03', 'Aviso del Buzón', 'SAT', 'Nueva', 1, T0, T0, 'atencion', 0, 0);
  seed.prepare("INSERT INTO sat_documents(id,rfc,kind,issuedAt,fileId,source,created,error) VALUES ('satdoc-1',?, 'opinion', ?, 'pdf:doc-semilla', 'auto', ?, '')")
    .run(OWN, Date.parse('2026-10-05T12:00:00Z'), T0);
  seed.prepare("INSERT INTO declaraciones(id,rfc,tipo,clase,ejercicio,periodo,fechaPresentacion,operacion,fileId,source,created) VALUES ('decl-1',?, 'mensual','acuse',2026,'2026-10','2026-10-17','123456','pdf:doc-semilla','auto',?)")
    .run(OWN, T0);
  seed.close();
}
const h = makeHarness({ dbFile,
  makePaperlessUploader: async args => { subidasPaperless.push(args); return { status: 201 }; } });
try {
  await base(h);
  const seedInv = await h.call('POST', '/api/storage', { batch: {
    invoices: [
      invoice(R1, '2026-10-03', PROV1, OWN, '1160.00',
        { fiscal: { paymentMethod: 'PUE', series: 'A', folio: '101', transferred: [{ tax: '002', rate: '0.160000', amount: '160.00' }], withheld: [] } }),
      invoice(E1, '2026-10-04', OWN, CLI1, '2320.00',
        { fiscal: { paymentMethod: 'PUE', series: 'B', folio: '202', transferred: [{ tax: '002', rate: '0.160000', amount: '320.00' }], withheld: [] } }),
      invoice(C1, '2026-10-05', PROV2, OWN, '580.00'),
      invoice(S1, '2026-09-02', PROV1, OWN, '100.00'),
      invoice(D1, '2026-12-03', PROV1, OWN, '1160.00')],
    files: [
      { id: 'xml:' + R1, content: xml64(R1), mime: 'application/xml' },
      { id: 'xml:' + E1, content: xml64(E1), mime: 'application/xml' },
      { id: 'xml:' + C1, content: xml64(C1), mime: 'application/xml' },
      { id: 'pdf:doc-semilla', content: pdf64, mime: 'application/pdf' }],
    documents: [
      { id: 'pdf:doc-semilla', rfc: OWN, kind: 'Opinión de cumplimiento', date: '2026-10-05', period: '', name: 'opinion-octubre.pdf' }] } });
  assert.equal(seedInv.status, 200, 'semilla del escenario');

  /* ===== (1) Cierre guiado: incompleto nombra; completo cierra ===== */
  const sep = await h.call('GET', '/api/cierre200g?rfc=' + OWN + '&month=2026-09');
  assert.equal(sep.status, 200);
  assert.equal(sep.json.completo, false, 'septiembre no está completo');
  assert.ok(sep.json.faltan.some(f => f.id === 'metadatos'),
    'lo que falta se nombra: metadatos cruzados');
  const cerrarSep = await h.call('POST', '/api/cierre200g/cerrar', { rfc: OWN, month: '2026-09' });
  assert.equal(cerrarSep.status, 409, 'un mes incompleto NO se cierra');
  assert.match(cerrarSep.json.error, /no está completo/);
  const oct = await h.call('GET', '/api/cierre200g?rfc=' + OWN + '&month=2026-10');
  assert.equal(oct.json.completo, true,
    'octubre completo: ' + JSON.stringify(oct.json.faltan));
  for (const paso of oct.json.pasos) assert.equal(paso.ok, true, 'paso en verde: ' + paso.id);
  const cerrarOct = await h.call('POST', '/api/cierre200g/cerrar', { rfc: OWN, month: '2026-10' });
  assert.equal(cerrarOct.status, 200);
  assert.equal(cerrarOct.json.cerrado, true);
  assert.ok(cerrarOct.json.informes?.generadoAt, 'al cerrar se generan los informes del mes');
  console.log('OK 2.0·T7A · (1) cierre guiado — incompleto nombra lo que falta; completo se cierra.');

  /* ===== (13) Informes pre-generados servidos con su fecha ===== */
  const inf = await h.call('GET', '/api/informes200g?rfc=' + OWN + '&month=2026-10');
  assert.ok(inf.json.informe, 'el informe pre-generado consta');
  assert.match(inf.json.informe.texto, /generado al cerrar el mes, el \d{4}-\d{2}-\d{2}/);
  const servido = await h.call('POST', '/api/informes200g/servir', { rfc: OWN, month: '2026-10', cual: 'cierre' });
  assert.equal(servido.status, 200);
  assert.ok(Buffer.from(servido.json.content, 'base64').subarray(0, 5).toString() === '%PDF-',
    'el PDF guardado al cerrar se sirve tal cual');
  assert.equal(servido.json.generadoAt, inf.json.informe.generadoAt, 'con su fecha de generación');
  console.log('OK 2.0·T7A · (13) informes pre-generados al cerrar, servidos con su fecha.');

  /* ===== (2) ZIP del mes + enviar al despacho ===== */
  const zip = await h.call('POST', '/api/salidas200g/zip-mes', { rfc: OWN, month: '2026-10' });
  assert.equal(zip.status, 200);
  assert.equal(zip.json.name, OWN + '-2026-10.zip', 'nombre RFC-periodo');
  const zipTxt = Buffer.from(zip.json.content, 'base64').toString('latin1');
  for (const carpeta of ['Emitidos/', 'Recibidos/', 'Acuses/', 'Reportes/', 'manifiesto.txt'])
    assert.ok(zipTxt.includes(carpeta), 'el ZIP trae la carpeta ' + carpeta);
  assert.ok(zipTxt.includes('totales-2026-10.pdf') && zipTxt.includes('cierre-2026-10.pdf'),
    'los reportes de siempre viajan en Reportes/');
  assert.equal(zip.json.comprobantes, 3, 'solo los CFDI de octubre de este RFC');
  const sinDespacho = await h.call('POST', '/api/salidas200g/enviar-despacho',
    { rfc: OWN, month: '2026-10', soloPreparar: true });
  assert.equal(sinDespacho.json.enviado, false);
  assert.match(sinDespacho.json.nota, /No consta el correo del despacho/,
    'sin destinatario del despacho: solo ZIP y se dice');
  const mailsAntes = h.mails.length;
  await h.call('POST', '/api/reports/config',
    { nora: { enabled: true, day: 3, hour: 9, recipients: 'nora@test.mx' },
      weekly: {}, manofil: {}, friday: {} });
  const alDespacho = await h.call('POST', '/api/salidas200g/enviar-despacho', { rfc: OWN, month: '2026-10' });
  assert.equal(alDespacho.json.enviado, true, 'con destinatario, el paquete sale');
  assert.equal(h.mails.length, mailsAntes + 1, 'un solo correo al despacho');
  const correo = h.mails[h.mails.length - 1];
  assert.ok(String(correo.to).includes('nora@test.mx'));
  assert.ok((correo.attachments || []).some(a => a.filename === OWN + '-2026-10.zip'),
    'el adjunto es el ZIP del mes, sin datos de otros RFC');
  console.log('OK 2.0·T7A · (2) ZIP del mes por carpetas + envío al despacho con su correo en llano.');

  /* ===== (3) Miniatura real, una sola vez ===== */
  const lista1 = await h.call('GET', '/api/miniaturas200g?rfc=' + OWN);
  const docMini = lista1.json.documentos.find(d => d.id === 'pdf:doc-semilla');
  assert.ok(docMini, 'el documento semilla sale en el listado');
  assert.equal(docMini.estado, 'ok', 'su miniatura se generó al primer listado');
  const png1 = await h.raw('GET', '/api/miniatura200g?id=' + encodeURIComponent('pdf:doc-semilla'),
    undefined, { 'x-pacosat-token': /[0-9a-f]{64}/.exec((await h.raw('GET', '/')).text)?.[0] || '' });
  assert.equal(png1.status, 200);
  assert.ok(png1.text.startsWith('\x89PNG'), 'la miniatura es un PNG real de la primera página');
  const lista2 = await h.call('GET', '/api/miniaturas200g?rfc=' + OWN);
  assert.equal(lista2.json.documentos.find(d => d.id === 'pdf:doc-semilla').estado, 'ok',
    'la segunda vez sale de la caché (generada una vez)');
  console.log('OK 2.0·T7A · (3) miniatura real de la primera página, generada una vez y cacheada.');

  /* ===== (4) Compartir: preparado con ficha y adjunto, sin enviar ===== */
  const antes = h.mails.length;
  const comp = await h.call('POST', '/api/compartir200g', { kind: 'cfdi', id: R1 });
  assert.equal(comp.status, 200);
  assert.match(comp.json.preparado.text, /Folio: A-101/);
  assert.match(comp.json.preparado.text, /Importe: \$1,160\.00|\$1160/);
  assert.ok(comp.json.preparado.adjuntos.some(n => n.endsWith('.xml')), 'el XML viaja adjunto');
  assert.equal(h.mails.length, antes, 'compartir PREPARA: no envía nada');
  const compDoc = await h.call('POST', '/api/compartir200g', { kind: 'documento', id: 'pdf:doc-semilla' });
  assert.match(compDoc.json.preparado.text, /Opinión de cumplimiento/);
  assert.ok(compDoc.json.preparado.adjuntos.some(n => n.endsWith('.pdf')), 'el PDF del documento viaja adjunto');
  console.log('OK 2.0·T7A · (4) compartir prepara el correo con su ficha y adjunto; el envío es gesto de Paco.');

  /* ===== (5) Panel de valor = registros semilla ===== */
  const valor = await h.call('GET', '/api/valor200g?periodo=todo');
  assert.equal(valor.json.cancelaciones.numero, 1, 'una cancelación detectada (la semilla C1)');
  assert.equal(valor.json.cancelaciones.suma, '580.00');
  assert.equal(valor.json.cancelaciones.detalle[0].uuid, C1, 'con su documento detrás');
  assert.equal(valor.json.descargas.solicitudesTerminadas, 1, 'la solicitud terminada semilla');
  assert.equal(valor.json.descargas.cfdiBajados, 1, 'el CFDI que esa solicitud bajó');
  assert.ok(valor.json.buzon.cumplidos >= 1, 'la notificación del Buzón atendida consta');
  console.log('OK 2.0·T7A · (5) panel de valor contado solo de los registros.');

  /* ===== (9) Pólizas: cuenta en blanco, debe = haber ===== */
  const pol = await h.call('POST', '/api/salidas200g/polizas', { rfc: OWN, month: '2026-10' });
  assert.equal(pol.status, 200);
  assert.equal(Number(pol.json.debe.replace(/,/g, '')), 4060, 'debe = suma de los CFDI del mes');
  assert.equal(pol.json.debe, pol.json.haber, 'debe y haber cuadran');
  assert.ok(pol.json.notas.some(n => /EN BLANCO/.test(n) && /no inventa/.test(n)),
    'la propia salida documenta que la cuenta la pone el despacho');
  const xlsxTxt = Buffer.from(pol.json.content, 'base64').toString('utf8');
  assert.ok(xlsxTxt.includes('Pólizas'), 'el Excel trae su hoja de pólizas');
  console.log('OK 2.0·T7A · (9) pólizas para el contador — cuenta en blanco, debe = haber.');

  /* ===== (8) ZIP por contraparte ===== */
  const cpZip = await h.call('POST', '/api/salidas200g/contraparte-zip',
    { rfc: OWN, contraparte: PROV1, year: '2026' });
  assert.equal(cpZip.status, 200);
  assert.equal(cpZip.json.name, PROV1 + '-2026.zip', 'nombre RFCcontraparte-año');
  assert.equal(cpZip.json.sumaListada, '2420.00', 'el índice suma SOLO lo listado (S1 sep + R1 oct + D1 dic, todos de PROV1)');
  assert.equal(cpZip.json.comprobantes, 3);
  const cpTxt = Buffer.from(cpZip.json.content, 'base64').toString('latin1');
  assert.ok(cpTxt.includes('indice.csv'), 'trae su hoja índice');
  console.log('OK 2.0·T7A · (8) ZIP por contraparte con índice que suma solo lo listado.');

  /* ===== (14) Subir un papel: tipo sugerido por el nombre ===== */
  const papel = await h.call('POST', '/api/documentos200g/subir-papel',
    { name: 'constancia-situacion-fiscal.pdf', content: pdf64 });
  assert.equal(papel.status, 200);
  assert.equal(papel.json.rfc, OWN, 'RFC sugerido: el único del ámbito');
  assert.equal(papel.json.kind, 'Constancia / CIF', 'tipo sugerido por el nombre del archivo');
  const listaDocs = await h.call('GET', '/api/miniaturas200g?rfc=' + OWN);
  assert.ok(listaDocs.json.documentos.some(d => d.id === papel.json.id), 'el papel quedó archivado en Documentos');
  console.log('OK 2.0·T7A · (14) papel suelto archivado con RFC y tipo sugeridos.');

  /* ===== (11) Paperless: título canónico al doble local ===== */
  const estadoPl = await h.call('GET', '/api/paperless200g');
  assert.equal(estadoPl.json.pendiente, true, 'sin configurar, el puente consta pendiente');
  await h.call('POST', '/api/paperless/config',
    { enabled: true, baseUrl: 'http://paperless.test', token: 'token-prueba' });
  const enc = await h.call('POST', '/api/paperless200g/encolar-satdocs', {});
  assert.equal(enc.json.encolados, 1, 'el documento del SAT archivado se encola');
  await h.call('POST', '/api/paperless/retry', {});
  assert.equal(subidasPaperless.length, 1, 'el doble local recibió el documento');
  assert.equal(subidasPaperless[0].title, 'PacoSAT — Opinión de cumplimiento — ' + OWN + ' — 2026-10-05',
    'con su título «PacoSAT — <tipo> — <RFC> — <fecha>»');
  const estadoPl2 = await h.call('GET', '/api/paperless200g');
  assert.equal(estadoPl2.json.configurado, true);
  console.log('OK 2.0·T7A · (11) puente a Paperless listo: título canónico verificado con doble local.');

  /* ===== (12) ICS por RFC con token revocable ===== */
  const icsCfg = await h.call('GET', '/api/ics200g?rfc=' + OWN);
  assert.ok(icsCfg.json.tokenNuevo.startsWith('ics_'), 'la dirección nace con su token');
  const tokenViejo = icsCfg.json.tokenNuevo;
  const icsOk = await h.raw('GET', '/api/ics200g/' + OWN + '.ics?t=' + tokenViejo);
  assert.equal(icsOk.status, 200, 'el calendario se sirve con su token, sin sesión');
  assert.ok(icsOk.text.includes('BEGIN:VCALENDAR') && icsOk.text.includes('BEGIN:VEVENT'),
    'trae los vencimientos que el sistema ya conoce como eventos');
  const regen = await h.call('POST', '/api/ics200g/regenerar', { rfc: OWN });
  const tokenNuevo = regen.json.tokenNuevo;
  assert.ok(tokenNuevo && tokenNuevo !== tokenViejo);
  const icsRevocado = await h.raw('GET', '/api/ics200g/' + OWN + '.ics?t=' + tokenViejo);
  assert.equal(icsRevocado.status, 401, 'regenerar REVOCA la dirección anterior');
  const icsNuevo = await h.raw('GET', '/api/ics200g/' + OWN + '.ics?t=' + tokenNuevo);
  assert.equal(icsNuevo.status, 200, 'la nueva dirección funciona');
  console.log('OK 2.0·T7A · (12) calendario fiscal vivo por RFC; regenerar revoca la anterior.');

  /* ===== (6) Candado: diciembre cierra el ejercicio y el
     servidor bloquea las escrituras de 2026 ===== */
  const dic = await h.call('GET', '/api/cierre200g?rfc=' + OWN + '&month=2026-12');
  assert.equal(dic.json.completo, true, 'diciembre también completa: ' + JSON.stringify(dic.json.faltan));
  const cerrarDic = await h.call('POST', '/api/cierre200g/cerrar', { rfc: OWN, month: '2026-12' });
  assert.equal(cerrarDic.status, 200);
  const ejercicios = await h.call('GET', '/api/ejercicios200g');
  assert.ok(ejercicios.json.ejercicios.some(e => e.rfc === OWN && e.year === '2026' && e.cerrado),
    'al completar diciembre, el ejercicio 2026 quedó cerrado');
  const notaBloq = await h.call('POST', '/api/cfdi/nota', { uuid: R1, nota: 'no debe pasar' });
  assert.equal(notaBloq.status, 409, 'la nota sobre un CFDI de 2026 se bloquea EN EL SERVIDOR');
  assert.match(notaBloq.json.error, /Ejercicio 2026 cerrado — desbloquéalo en Cierre/);
  const archBloq = await h.call('POST', '/api/cfdi/archivar', { uuid: R1, archivar: true });
  assert.equal(archBloq.status, 409, 'archivar también se bloquea');
  const pagoBloq = await h.call('POST', '/api/money/mark-paid', { uuid: R1 });
  assert.equal(pagoBloq.status, 409, 'la marca de pago también se bloquea');
  const papelBloq = await h.call('POST', '/api/documentos200g/subir-papel',
    { name: 'papel-2026.pdf', content: pdf64, date: '2026-03-01', rfc: OWN });
  assert.equal(papelBloq.status, 409, 'H-2/H-6: el papel de un ejercicio cerrado también se bloquea');
  const papelMalo = await h.call('POST', '/api/documentos200g/subir-papel',
    { name: 'papel-fecha-mala.pdf', content: pdf64, date: 'no-es-una-fecha', rfc: OWN });
  assert.equal(papelMalo.status, 400,
    'H-6: una fecha malformada es 400 en llano, no archiva saltándose el candado — ' + papelMalo.status);
  const lectura = await h.call('GET', '/api/cierre200g?rfc=' + OWN + '&month=2026-10');
  assert.equal(lectura.status, 200, 'las lecturas NUNCA se bloquean');
  const sinConfirmar = await h.call('POST', '/api/ejercicios200g/desbloquear', { rfc: OWN, year: '2026' });
  assert.notEqual(sinConfirmar.status, 200, 'desbloquear exige confirmación expresa');
  const desbloq = await h.call('POST', '/api/ejercicios200g/desbloquear',
    { rfc: OWN, year: '2026', confirmar: true });
  assert.equal(desbloq.status, 200);
  const registro = await h.call('GET', '/api/registro');
  assert.ok(JSON.stringify(registro.json).includes('DESBLOQUEADO'),
    'el desbloqueo quedó en el Registro (quién/cuándo)');
  const notaOk = await h.call('POST', '/api/cfdi/nota', { uuid: R1, nota: 'ya se puede' });
  assert.equal(notaOk.status, 200, 'tras desbloquear, la escritura vuelve a pasar');
  const papelOk = await h.call('POST', '/api/documentos200g/subir-papel',
    { name: 'papel-fecha-buena.pdf', content: pdf64, date: '2026-03-01', rfc: OWN });
  assert.equal(papelOk.status, 200, 'H-6: con fecha bien formada y ejercicio abierto, el papel se archiva');
  console.log('OK 2.0·T7A · (6) candado de ejercicio cerrado — bloquea en servidor y el desbloqueo se registra.');
} finally { h.service.close(); rmSync(dir, { recursive: true, force: true }); }

/* ===== (10) Webhook firmado contra un doble HTTP local ===== */
{
  const recibidos = [];
  const doble = createServer((req, res) => {
    let cuerpo = '';
    req.on('data', c => { cuerpo += c; });
    req.on('end', () => { recibidos.push({ headers: req.headers, cuerpo }); res.writeHead(200); res.end('ok'); });
  });
  await new Promise(r => doble.listen(0, '127.0.0.1', r));
  const puerto = doble.address().port;
  const hw = makeHarness();
  try {
    await base(hw);
    const creado = await hw.call('POST', '/api/webhooks200g',
      { url: 'http://127.0.0.1:' + puerto + '/hook', secret: 'secreto-prueba', eventos: ['cfdi-nuevo'] });
    assert.equal(creado.status, 200);
    assert.equal(creado.json.secret, 'secreto-prueba');
    const prueba = await hw.call('POST', '/api/webhooks200g/probar', { evento: 'cfdi-nuevo', rfc: OWN });
    assert.equal(prueba.status, 200);
    assert.equal(recibidos.length, 1, 'el doble local recibió el evento');
    const firmaEsperada = 'sha256=' + createHmac('sha256', 'secreto-prueba')
      .update(recibidos[0].cuerpo).digest('hex');
    assert.equal(recibidos[0].headers['x-pacosat-firma'], firmaEsperada,
      'la firma HMAC-SHA256 de la cabecera cuadra con el cuerpo y el secreto');
    assert.equal(JSON.parse(recibidos[0].cuerpo).evento, 'cfdi-nuevo');
    const lista = await hw.call('GET', '/api/webhooks200g');
    assert.equal(lista.json.entregas.length, 1, 'la entrega quedó registrada en el panel');
    assert.equal(lista.json.entregas[0].ok, true);
    assert.equal(lista.json.entregas[0].intentos, 1);
    console.log('OK 2.0·T7A · (10) webhook firmado (HMAC-SHA256) entregado al doble y registrado.');
  } finally { hw.service.close(); doble.close(); }
}

/* ===== (7) Restauración guiada con respaldo de seguridad ===== */
{
  const backupDir = mkdtempSync(join(tmpdir(), 'pacosat-200g-backup-'));
  const hr = makeHarness();
  try {
    await base(hr);
    const N1 = '66666666-6666-4666-8666-666666666666';
    const N2 = '77777777-7777-4777-8777-777777777777';
    await hr.call('POST', '/api/storage', { batch: { invoices: [invoice(N1, '2026-10-03', PROV1, OWN, '100.00')] } });
    await hr.service.bootstrap({ backup: { password: 'respaldo-prueba-16', frequency: 'daily', dir: backupDir }, profiles: [] });
    await hr.service.backupTick(hr.time);
    const lista = await hr.call('GET', '/api/respaldos200g');
    assert.equal(lista.json.configurado, true);
    assert.equal(lista.json.respaldos.length, 1, 'el respaldo programado se lista con fecha y tamaño');
    const stamp = lista.json.respaldos[0].stamp;
    assert.ok(lista.json.respaldos[0].bytes > 0);
    /* El expediente cambia DESPUÉS del respaldo. */
    await hr.call('POST', '/api/storage', { batch: { invoices: [invoice(N2, '2026-10-04', PROV1, OWN, '200.00')] } });
    const rest = await hr.call('POST', '/api/respaldos200g/restaurar', { stamp, confirmar: true });
    assert.equal(rest.status, 200);
    assert.equal(rest.json.ok, true, 'la verificación tras restaurar cuadra');
    assert.ok(rest.json.seguridad.archivos.length >= 1,
      'ANTES de reemplazar se creó el respaldo de seguridad (obligatorio)');
    assert.ok(readdirSync(backupDir).some(n => n.includes('-seguridad')),
      'el archivo de seguridad consta en la carpeta de respaldos');
    const despues = await hr.call('GET', '/api/storage?store=invoices');
    const ids = JSON.stringify(despues.json);
    assert.ok(ids.includes(N1), 'el estado restaurado trae el CFDI del respaldo');
    assert.ok(!ids.includes(N2), 'y NO el CFDI posterior al respaldo');
    const registro = await hr.call('GET', '/api/registro');
    assert.ok(JSON.stringify(registro.json).includes('Restauración guiada'),
      'la restauración y su verificación quedaron en el Registro');
    console.log('OK 2.0·T7A · (7) restauración guiada — seguridad previa obligatoria y verificación cruzada.');
  } finally { hr.service.close(); rmSync(backupDir, { recursive: true, force: true }); }
}

/* ===== Cliente diferido y artefacto: la versión NO cambia ===== */
{
  const part = readFileSync(join(process.cwd(), 'outputs-ui.part'), 'utf8');
  for (const texto of ['cierre200gPanel', 'valor200gPanel', 'webhooks200gPanel', 'ics200gPanel',
    'restaurar200gPanel', 'compartir200g', 'subirPapel200g', 'Para el contador (pólizas)'])
    assert.ok(part.includes(texto), 'la parte diferida de Salidas trae «' + texto + '»');
  const banks = readFileSync(join(process.cwd(), 'banks-ui.part'), 'utf8');
  assert.ok(banks.includes('salidas200g/contraparte-zip'), 'Contrapartes trae su «Descargar todo (ZIP)»');
  const html = readFileSync(join(process.cwd(), 'Faro-Fiscal.html'), 'utf8');
  assert.ok(html.includes('"version":"2.9.15"'), 'la versión es la vigente 2.0.1 (las tandas no la tocaron; la subió la ronda 2.0.1 de motores)');
  console.log('OK 2.0·T7A · cliente — piezas en partes diferidas; versión intacta.');
}
/* ===== H-2 (corrección de seguridad 2.0): el candado cubre
   Pagos (preparations/paid) y la regeneración de informes ===== */
{
  const P26 = '11111111-1111-4111-8111-111111111111';
  const P27 = '22222222-2222-4222-8222-222222222222';
  const dirH2 = mkdtempSync(join(tmpdir(), 'pacosat-200g-h2-'));
  const dbFileH2 = join(dirH2, 'pacosat.sqlite');
  {
    const boot = createPacoSATService({ dbFile: dbFileH2, html: 'x', origin: ORIGIN, proxyKey: KEY });
    boot.close();
    const seed = new DatabaseSync(dbFileH2);
    seed.prepare("INSERT INTO profiles(rfc,minutes,days,direction,nextRun,error) VALUES (?,1440,7,'both',0,'')").run(OWN);
    seed.close();
  }
  const hh = makeHarness({ dbFile: dbFileH2 });
  try {
    await base(hh);
    const ppd = { fiscal: { paymentMethod: 'PPD', transferred: [], withheld: [] } };
    const seedH2 = await hh.call('POST', '/api/storage', { batch: { invoices: [
      invoice(P26, '2026-10-03', PROV1, OWN, '1160.00', ppd),
      invoice(P27, '2027-01-15', PROV1, OWN, '1160.00', ppd)] } });
    assert.equal(seedH2.status, 200);
    { const db2 = new DatabaseSync(dbFileH2);
      const ins = db2.prepare("INSERT INTO pay_preparations(id,rfc,month,total,operaciones,payload,created) VALUES (?,?,?, '1160.00',1,?,?)");
      ins.run('prep26', OWN, '2026-10', JSON.stringify({ month: '2026-10',
        bbva: { lines: [{ uuid: P26, nombre: 'Proveedor Uno' }] }, interbancario: { lines: [] }, speiIndividual: { lines: [] } }), T0);
      ins.run('prep27', OWN, '2027-01', JSON.stringify({ month: '2027-01',
        bbva: { lines: [{ uuid: P27, nombre: 'Proveedor Uno' }] }, interbancario: { lines: [] }, speiIndividual: { lines: [] } }), T0);
      db2.close(); }
    const cierreH2 = await hh.call('POST', '/api/ejercicios200g/cerrar', { rfc: OWN, year: '2026' });
    assert.equal(cierreH2.status, 200, 'ejercicio 2026 cerrado');
    const paidBloq = await hh.call('POST', '/api/pagos/preparations/paid', { rfc: OWN, id: 'prep26' });
    assert.equal(paidBloq.status, 409, 'preparations/paid de 2026: 409 — ' + JSON.stringify(paidBloq.json));
    assert.match(paidBloq.json.error || '', /Ejercicio 2026 cerrado/);
    const regenBloq = await hh.call('POST', '/api/informes200g/regenerar', { rfc: OWN, month: '2026-10' });
    assert.equal(regenBloq.status, 409, 'regenerar informes de 2026: 409 — ' + JSON.stringify(regenBloq.json));
    assert.match(regenBloq.json.error || '', /Ejercicio 2026 cerrado/);
    const paidOk27 = await hh.call('POST', '/api/pagos/preparations/paid', { rfc: OWN, id: 'prep27' });
    assert.equal(paidOk27.status, 200, 'preparations/paid de 2027 (año abierto): pasa');
    assert.equal(paidOk27.json.marcadas, 1, 'y marca su factura');
    const desbloqH2 = await hh.call('POST', '/api/ejercicios200g/desbloquear',
      { rfc: OWN, year: '2026', confirmar: true });
    assert.equal(desbloqH2.status, 200);
    const regenOk = await hh.call('POST', '/api/informes200g/regenerar', { rfc: OWN, month: '2026-10' });
    assert.equal(regenOk.status, 200, 'tras desbloquear, regenerar vuelve a pasar');
    assert.ok(regenOk.json.generadoAt);
    const paidOk26 = await hh.call('POST', '/api/pagos/preparations/paid', { rfc: OWN, id: 'prep26' });
    assert.equal(paidOk26.status, 200, 'tras desbloquear, preparations/paid vuelve a pasar');
    assert.equal(paidOk26.json.marcadas, 1);
    console.log('OK 2.0·SEG · H-2 Pagos/Informes — 409 en año cerrado y éxito en año abierto/desbloqueado.');
  } finally { hh.service.close(); rmSync(dirH2, { recursive: true, force: true }); }
}
console.log('OK ronda200g — tanda 7A de la 2.0, fijada');
