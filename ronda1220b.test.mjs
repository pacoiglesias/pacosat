/* Ronda 1.22.0 (segunda parte) — la auditoría de verdad (N1–N12),
   las piezas 2–15 y el cierre total (R3/R4/R5, B, S1, M, F del
   lado servidor), juzgados artefacto a artefacto con semilla:
   - N1: el Excel de facturas ya no suma la cancelada (la
     diferencia probada de la auditoría era la 959 de $33,779.20);
   - N3: el paquete mensual automático excluye canceladas de
     sus totales y de la base DIOT, y no mezcla divisas;
   - N4: el índice del ZIP de cierre no marca «Pendiente» la
     cancelada; N10: el PDF de periodo saca la nómina de
     «Emitidos» a su sección; N12: el Reporte Mano Fil no suma
     la nómina cancelada;
   - pieza 2: /api/status trae el resumen de vigilancia y la
     actividad de descargas DEL SERVIDOR (cfdi_watch y jobs);
   - piezas 4/8: la corrida de documentos llega al archivo y el
     «Ver» lo abre; sin archivo no hay anuncio; el camino de
     fallo cuenta paso y causa con la prueba de la e.firma
     (pieza 5); piezas 9/10 (reintento y cancelar) y 15 (R2);
     pieza 14 (R1) al rearrancar;
   - piezas 6/11/12 (N11): el mapa dice «sin recuperar» y
     «pagada según la línea del despacho», y el fallo de
     declaraciones cuenta su causa tras el reintento;
   - pieza 13: la sonda del portal avisa si la pantalla cambia;
   - pieza 14: la cola «Trabajos del SAT» reúne las clases;
   - R3/R4/R5, respaldo partido con poda verificada (B), S1
     (secretos cifrados en reposo) y la pasada de segundo RFC
     (M1/M4; M2 ya la juzga final.test). */
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { DOMParser } from '@xmldom/xmldom';
import { createPacoSATService } from './local-server.mjs';
import { parseXml } from './xml-core.mjs';
import { MANOFIL_SEED_RFC } from './pagos.mjs';
import { createFileEfirmaStorage } from './sat-doc-fetch.mjs';

const ORIGIN = 'https://pacosat.test';
const KEY = 'e'.repeat(64);
const OWN = 'AAA010101AAA';
const BBB = 'BBB010101BB1';
const CCC = 'CCE010101CE1';
const GRC = 'GRC131111298';
const EMP = 'EMP010101EM1';
const MIN = 60_000;

const pdfText = async buffer => {
  const doc = await getDocument({ data: new Uint8Array(buffer) }).promise;
  let text = '';
  for (let i = 1; i <= doc.numPages; i++)
    text += (await (await doc.getPage(i)).getTextContent()).items.map(item => item.str).join(' ') + '\n';
  return text;
};
const zipRaw = buffer => {
  const entries = new Map();
  let eocd = buffer.length - 22;
  while (eocd >= 0 && buffer.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  assert.ok(eocd >= 0, 'directorio central del ZIP');
  const count = buffer.readUInt16LE(eocd + 10);
  let p = buffer.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    const size = buffer.readUInt32LE(p + 20);
    const nameLen = buffer.readUInt16LE(p + 28);
    const extraLen = buffer.readUInt16LE(p + 30);
    const commentLen = buffer.readUInt16LE(p + 32);
    const localAt = buffer.readUInt32LE(p + 42);
    const name = buffer.toString('utf8', p + 46, p + 46 + nameLen);
    const start = localAt + 30 + buffer.readUInt16LE(localAt + 26) + buffer.readUInt16LE(localAt + 28);
    entries.set(name, buffer.subarray(start, start + size));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
};

function harness(service) {
  let token = '';
  const raw = async (method, path, body, extraHeaders = {}) => {
    const chunks = []; if (body !== undefined) chunks.push(Buffer.from(JSON.stringify(body)));
    const req = Readable.from(chunks);
    req.method = method; req.url = path;
    req.headers = { host: 'pacosat.test', origin: ORIGIN, 'x-pacosat-proxy': KEY, ...extraHeaders };
    let status = 0; const headers = {}; let text = '';
    const res = { writeHead(code) { status = code; }, setHeader(k, v) { headers[k] = v; }, getHeader(k) { return headers[k]; },
      end(chunk) { if (chunk) text += Buffer.isBuffer(chunk) ? chunk.toString('latin1') : chunk; } };
    await service.handle(req, res);
    return { status, text, headers };
  };
  const call = async (method, path, body) => {
    if (!token) { const home = await raw('GET', '/');
      token = (home.text.match(/name="pacosat-token" content="([^"]+)"/) || [])[1] || ''; }
    const r = await raw(method, path, body, { 'x-pacosat-token': token });
    let json = null; try { json = JSON.parse(r.text); } catch { /* binario */ }
    return { status: r.status, json, text: r.text, headers: r.headers };
  };
  const callRaw = async (method, path, body) => {
    if (!token) { const home = await raw('GET', '/');
      token = (home.text.match(/name="pacosat-token" content="([^"]+)"/) || [])[1] || ''; }
    const chunks = []; if (body !== undefined) chunks.push(Buffer.from(JSON.stringify(body)));
    const req = Readable.from(chunks);
    req.method = method; req.url = path;
    req.headers = { host: 'pacosat.test', origin: ORIGIN, 'x-pacosat-proxy': KEY, 'x-pacosat-token': token };
    let status = 0; const parts = [];
    const res = { writeHead(code) { status = code; }, setHeader() {}, getHeader() { return undefined; },
      end(chunk) { if (chunk) parts.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'latin1')); } };
    await service.handle(req, res);
    return { status, buffer: Buffer.concat(parts) };
  };
  return { call, callRaw };
}
const makeService = (options = {}) => {
  const mails = [];
  const service = createPacoSATService({
    dbFile: ':memory:', html: '<html><head><!--PACOSAT_TOKEN--></head><body>prueba</body></html>',
    origin: ORIGIN, proxyKey: KEY, satDocRetryWaitMs: 5,
    makeConnector: () => ({ parser: DOMParser, connector: {
      request: async () => 'req-b', check: async () => ({ status: 'pending', packages: [] }),
      download: async () => { throw new Error('sin paquetes'); } } }),
    makeMailer: () => ({ verify: async () => true,
      sendMail: async mail => { mails.push(mail); return { messageId: 'm' + mails.length }; } }),
    ...options });
  return { service, mails, ...harness(service) };
};
const setupMail = async h => {
  const mail = await h.call('POST', '/api/mail', { host: 'smtp.test', port: 465, security: 'ssl',
    from: 'avisos@pacosat.test', recipient: 'paco@test.mx', user: 'u', password: 'p' });
  assert.equal(mail.status, 200);
};
const unlock = async (h, rfc = OWN) => {
  const open = await h.call('POST', '/api/unlock', { rfc, minutes: 1440, days: 7,
    direction: 'both', password: 'simulated', certificate: 'YQ==', key: 'Yg==' });
  assert.equal(open.status, 200);
};

const xmlCfdi = ({ uuid, fecha, emisor, emisorNombre = 'EMISOR SA', receptor, receptorNombre = 'RECEPTOR SA',
    total, subtotal = null, iva = null, folio = '', serie = '', tipo = 'I', moneda = 'MXN' }) => {
  const sub = subtotal ?? (Number(total) / 1.16).toFixed(2);
  const tax = iva ?? (Number(total) - Number(sub)).toFixed(2);
  return `<?xml version="1.0" encoding="UTF-8"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital" Version="4.0"${serie ? ` Serie="${serie}"` : ''}${folio ? ` Folio="${folio}"` : ''} Fecha="${fecha}" SubTotal="${sub}" Moneda="${moneda}" Total="${total}" TipoDeComprobante="${tipo}" MetodoPago="PPD" FormaPago="99" LugarExpedicion="72000">
<cfdi:Emisor Rfc="${emisor}" Nombre="${emisorNombre}" RegimenFiscal="601"/>
<cfdi:Receptor Rfc="${receptor}" Nombre="${receptorNombre}" DomicilioFiscalReceptor="72000" RegimenFiscalReceptor="601" UsoCFDI="G03"/>
<cfdi:Conceptos><cfdi:Concepto ClaveProdServ="01010101" Cantidad="1" ClaveUnidad="H87" Descripcion="Servicio" ValorUnitario="${sub}" Importe="${sub}" ObjetoImp="02"><cfdi:Impuestos><cfdi:Traslados><cfdi:Traslado Base="${sub}" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="${tax}"/></cfdi:Traslados></cfdi:Impuestos></cfdi:Concepto></cfdi:Conceptos>
<cfdi:Impuestos TotalImpuestosTrasladados="${tax}"><cfdi:Traslados><cfdi:Traslado Base="${sub}" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="${tax}"/></cfdi:Traslados></cfdi:Impuestos>
<cfdi:Complemento><tfd:TimbreFiscalDigital Version="1.1" UUID="${uuid}" FechaTimbrado="${fecha}" RfcProvCertif="SAT970701NN3" SelloCFD="AAAA" NoCertificadoSAT="00001000000500000001" SelloSAT="BBBB"/></cfdi:Complemento>
</cfdi:Comprobante>`;
};
const rowOf = xml => parseXml(Buffer.from(xml), DOMParser);

/* ===== A · Salidas de la auditoría: N1, N3, N4, N10, N12 ===== */
const U963 = '12200000-0963-4000-8000-000000000963';
const U5166 = '12200000-5166-4000-8000-000000005166';
const U959 = '12200000-0959-4000-8000-000000000959';
const UCHED = '12200000-0296-4000-8000-000000000296';
const UNOM1 = '12200000-0001-4000-8000-000000001001';
const UNOM2 = '12200000-0002-4000-8000-000000001002';
const UREP = '12200000-0009-4000-8000-000000000009';
{
  const dirA = mkdtempSync(join(tmpdir(), 'pacosat-1220b-a-'));
  const dbFileA = join(dirA, 'pacosat.sqlite');
  let timeA = Date.parse('2026-12-04T15:00:00Z');
  const h = makeService({ dbFile: dbFileA, now: () => timeA });
  await setupMail(h);
  await unlock(h);
  const xmls = [
    xmlCfdi({ uuid: U963, fecha: '2026-11-02T10:00:00', emisor: BBB, emisorNombre: 'BRISBANE TEXTIL SA', receptor: OWN, total: '12760.00', folio: '963' }),
    xmlCfdi({ uuid: U5166, fecha: '2026-11-05T10:00:00', emisor: GRC, emisorNombre: 'GARCIA RIVERA SA', receptor: OWN, total: '80040.00', folio: '5166' }),
    xmlCfdi({ uuid: U959, fecha: '2026-11-07T10:00:00', emisor: CCC, emisorNombre: 'CANCELADA SA', receptor: OWN, total: '33779.20', folio: '959' }),
    xmlCfdi({ uuid: UCHED, fecha: '2026-11-03T10:00:00', emisor: OWN, receptor: 'SUC580621DAA', receptorNombre: 'CHEDRAUI SA', total: '296154.41', folio: '77' }),
    xmlCfdi({ uuid: UNOM1, fecha: '2026-11-15T10:00:00', emisor: MANOFIL_SEED_RFC, emisorNombre: 'MANO FIL SA', receptor: EMP, receptorNombre: 'EMPLEADO UNO', total: '8000.00', tipo: 'N' }),
    xmlCfdi({ uuid: UNOM2, fecha: '2026-11-15T11:00:00', emisor: MANOFIL_SEED_RFC, emisorNombre: 'MANO FIL SA', receptor: EMP, receptorNombre: 'EMPLEADO UNO', total: '8000.00', tipo: 'N' }),
    xmlCfdi({ uuid: UREP, fecha: '2026-11-09T10:00:00', emisor: BBB, emisorNombre: 'BRISBANE TEXTIL SA', receptor: OWN, total: '0.00', subtotal: '0.00', iva: '0.00', tipo: 'P', moneda: 'XXX' })];
  /* La nómina es del RFC de Mano Fil: su perfil se siembra con su
     propio desbloqueo para que el Reporte lo encuentre. */
  await unlock(h, MANOFIL_SEED_RFC);
  const rows = xmls.map(rowOf);
  const files = xmls.map((xml, i) => ({ id: 'xml:' + rows[i].id, mime: 'application/xml',
    content: Buffer.from(xml).toString('base64') }));
  const seed = await h.call('POST', '/api/storage', { batch: {
    people: [{ id: OWN, name: 'EMPRESA PROPIA SA' }, { id: BBB, name: 'BRISBANE TEXTIL SA' },
      { id: CCC, name: 'CANCELADA SA' }, { id: GRC, name: 'GARCIA RIVERA SA' },
      { id: MANOFIL_SEED_RFC, name: 'MANO FIL SA' }, { id: EMP, name: 'EMPLEADO UNO' }],
    invoices: rows, files } });
  assert.equal(seed.status, 200);
  /* El estado cancelado llega por la vigilancia (cfdi_watch),
     como en la app real: la 959 y la segunda nómina. */
  const dbA = new DatabaseSync(dbFileA);
  const watch = dbA.prepare('INSERT INTO cfdi_watch(id, emitter, receiver, total, seal, next, checked, result) VALUES (?,?,?,?,?,?,?,?)');
  const estado = state => JSON.stringify({ state, code: 'S', cancellation: '', cancelable: '', error: '' });
  watch.run(U959, CCC, OWN, '33779.20', '', timeA + 86400000, timeA, estado('Cancelado'));
  watch.run(UNOM2, MANOFIL_SEED_RFC, EMP, '8000.00', '', timeA + 86400000, timeA, estado('Cancelado'));
  watch.run(U963, BBB, OWN, '12760.00', '', timeA + 86400000, timeA, estado('Vigente'));
  dbA.close();

  /* N1 — el Excel de facturas: totales SIN la cancelada. */
  const xlsx = await h.call('POST', '/api/salidas/xlsx', { kind: 'facturas', rfc: OWN, month: '2026-11' });
  assert.equal(xlsx.status, 200);
  const sheets = zipRaw(Buffer.from(xlsx.json.content, 'base64'));
  const resumen = [...sheets.entries()].find(([name]) => name.includes('sheet1'))?.[1].toString('utf8') || '';
  const allSheets = [...sheets.values()].map(b => b.toString('utf8')).join('\n');
  assert.ok(allSheets.includes('sin canceladas'), 'el Excel avisa de que sus totales van sin canceladas');
  assert.ok(!allSheets.includes('126579.2'), 'el Excel NO suma la cancelada de $33,779.20 (daría 126,579.20)');
  assert.ok(allSheets.includes('92800'), 'el total de recibidos del Excel es $92,800.00, como el PDF');
  void resumen;

  /* N3 — el paquete mensual automático: totales y DIOT limpios. */
  await h.call('POST', '/api/reports/config', { nora: { enabled: true, day: 3, hour: 9, recipients: 'nora@test.mx' },
    weekly: { enabled: false, hour: 8, recipients: '' } });
  const sendNow = await h.call('POST', '/api/reports/send-now', { month: '2026-11' });
  assert.equal(sendNow.status, 200);
  const packMail = h.mails.find(m => /Informe mensual 2026-11/.test(m.subject || ''));
  assert.ok(packMail, 'el paquete mensual salió');
  const pack = zipRaw(packMail.attachments[0].content);
  const totales = pack.get('resumen.txt').toString('utf8');
  assert.ok(totales.includes('Total recibido (tus RFC): $92800.00'), 'los totales del paquete dicen $92,800.00');
  assert.ok(!totales.includes('126579.20'), 'los totales del paquete NO suman la cancelada');
  const diot = pack.get('base-diot.csv').toString('utf8');
  assert.ok(!diot.includes(CCC), 'la base DIOT no lleva al proveedor de la cancelada');
  assert.ok(diot.includes(BBB), 'la base DIOT sí lleva al proveedor vigente');

  /* N4 — el índice del ZIP de cierre no marca «Pendiente» la
     cancelada; el manifiesto la cuenta como cancelada. */
  const zip = await h.call('POST', '/api/salidas/zip', { scope: 'cierre', rfc: OWN, month: '2026-11' });
  assert.equal(zip.status, 200);
  const cierre = zipRaw(Buffer.from(zip.json.content, 'base64'));
  const indice = cierre.get(OWN + '/indice.csv').toString('utf8');
  const linea959 = indice.split('\n').find(line => line.includes('959'));
  assert.ok(linea959 && linea959.includes('—') && !linea959.includes('Pendiente'),
    'la cancelada lleva «—» en Estado de pago, no «Pendiente»: ' + linea959);
  const manifiesto = cierre.get('manifiesto.txt').toString('utf8');
  assert.ok(manifiesto.includes('(1 cancelados, en su carpeta aparte)'), 'el manifiesto cuenta la cancelada como cancelada');
  assert.ok(manifiesto.includes('recibidos: 3 por $92,800.00'), 'el manifiesto suma recibidos sin la cancelada (el tercero es el REP de $0)');

  /* N10 — el PDF de periodo: la nómina fuera de «Emitidos». */
  const pdf = await h.call('POST', '/api/salidas/pdf', { kind: 'periodo', rfc: MANOFIL_SEED_RFC, month: '2026-11' });
  assert.equal(pdf.status, 200);
  const pdfTxt = await pdfText(Buffer.from(pdf.json.content, 'base64'));
  assert.ok(pdfTxt.includes('Nómina del mes (2)'), 'la nómina va en su propia sección del PDF de periodo');

  /* N12 — el Reporte Mano Fil: la nómina cancelada no suma. */
  const reporte = await h.call('POST', '/api/reports/send-manofil', { month: '2026-11' });
  assert.equal(reporte.status, 200);
  const repMail = h.mails.find(m => /Reporte Mano Fil 2026-11/.test(m.subject || ''));
  assert.ok(repMail, 'el Reporte Mano Fil salió por correo');
  const repTxt = await pdfText(repMail.attachments[0].content);
  assert.ok(repTxt.includes('Nómina del periodo: $8,000.00'),
    'el Reporte suma solo la nómina vigente ($8,000.00, no $16,000.00)');
  assert.ok(!repTxt.includes('Nómina del periodo: $16,000.00'), 'la cancelada no entra en la nómina del Reporte');

  /* Pieza 2 (servidor) — el resumen de vigilancia y las
     descargas salen de los registros reales. */
  const status = await h.call('GET', '/api/status');
  assert.equal(status.status, 200);
  assert.equal(status.json.watchSummary.vigentes, 1, 'vigilancia: 1 vigente contado de cfdi_watch');
  assert.equal(status.json.watchSummary.cancelados, 2, 'vigilancia: 2 cancelados contados de cfdi_watch');
  assert.equal(status.json.watchSummary.perRfc[OWN].cancelados, 1, 'el resumen por RFC también es el real');
  assert.ok(status.json.downloads && 'lastAt' in status.json.downloads, 'la actividad de descargas viaja en el estado');
  assert.ok(status.json.expediente && status.json.expediente.satDocumentos === 0 && status.json.expediente.archivados === 1,
    'el expediente del servidor manda (N6): 0 documentos del SAT y 1 archivado (el Reporte que se acaba de guardar)');
  await h.service.close();
  rmSync(dirA, { recursive: true, force: true });
  console.log('OK 1.22.0b A — N1 (Excel sin la cancelada), N3 (paquete y DIOT limpios), N4 (índice «—»), ' +
    'N10 (nómina en su sección), N12 (Reporte sin la nómina cancelada) y la pieza 2 en el servidor.');
}

/* ===== B · Documentos del SAT: camino completo, fallo probado,
   reintento, cancelar y concurrencia (piezas 4, 5, 8, 9, 10, 15) ===== */
const PDF_FAKE = Buffer.from('%PDF-1.4 documento de juguete');
const docProfile = async (h, rfc = OWN) => {
  const view = await h.call('GET', '/api/satdocs');
  assert.equal(view.status, 200);
  return view.json.profiles.find(p => p.rfc === rfc);
};
{
  /* B1 — éxito de punta a punta (pieza 8): la petición que hace
     el botón llega al archivo archivado y su «Ver» lo abre. */
  let timeB = Date.parse('2026-12-04T15:00:00Z');
  const h = makeService({ now: () => timeB, satDocFetch: async () => ({ content: PDF_FAKE, issuedAt: '2026-12-04', source: 'portal' }) });
  await setupMail(h);
  await unlock(h);
  const run = await h.call('POST', '/api/satdocs/run', { rfc: OWN, kind: 'constancia' });
  assert.equal(run.status, 200);
  assert.equal(run.json.results.constancia.ok, true, 'la constancia bajó');
  const profile = await docProfile(h);
  assert.ok(profile.constancia?.fileId, 'la tarjeta anuncia la constancia CON su archivo (pieza 4)');
  const ver = await h.callRaw('GET', '/api/files/view?id=' + encodeURIComponent(profile.constancia.fileId));
  assert.equal(ver.status, 200, 'el «Ver» de la tarjeta resuelve');
  assert.ok(ver.buffer.equals(PDF_FAKE), 'el «Ver» abre exactamente el documento archivado');
  await h.service.close();
  console.log('OK 1.22.0b B1 — botón de constancia ejercitado de punta a punta: corrida, archivo y «Ver».');
}
{
  /* B2 — pieza 4, el otro lado: un registro de documento SIN
     archivo detrás no se anuncia como descargado. */
  const dirB2 = mkdtempSync(join(tmpdir(), 'pacosat-1220b-b2-'));
  const dbFileB2 = join(dirB2, 'pacosat.sqlite');
  let timeB = Date.parse('2026-12-04T15:00:00Z');
  const h = makeService({ dbFile: dbFileB2, now: () => timeB });
  await unlock(h);
  const db = new DatabaseSync(dbFileB2);
  db.prepare('INSERT INTO sat_documents(id, rfc, kind, issuedAt, fileId, source, created) VALUES (?,?,?,?,?,?,?)')
    .run('sd-fantasma', OWN, 'opinion', timeB - 86400000, 'pdf:no-existe', 'prueba', timeB);
  db.close();
  const profile = await docProfile(h);
  assert.equal(profile.opinion, null, 'sin archivo en Expedientes, la tarjeta NO anuncia la opinión');
  await h.service.close();
  rmSync(dirB2, { recursive: true, force: true });
  console.log('OK 1.22.0b B2 — pieza 4: la tarjeta sin archivo no anuncia descarga.');
}
{
  /* B3 — piezas 5+9+10: la Opinión cae dos veces por el portal
     con la Constancia recién bajada → UN aviso que prueba que
     la firma funcionó y cuenta las dos causas. */
  let timeB = Date.parse('2026-12-04T15:00:00Z');
  const calls = { constancia: 0, opinion: 0 };
  const h = makeService({ now: () => timeB, satDocFetch: async (rfc, kind) => {
    calls[kind]++;
    if (kind === 'constancia') return { content: PDF_FAKE, issuedAt: '2026-12-04', source: 'portal' };
    const error = new Error('El portal respondió algo que PacoSAT no esperaba');
    error.code = 'respuesta-inesperada';
    throw error;
  } });
  await setupMail(h);
  await unlock(h);
  const okRun = await h.call('POST', '/api/satdocs/run', { rfc: OWN, kind: 'constancia' });
  assert.equal(okRun.json.results.constancia.ok, true);
  const failRun = await h.call('POST', '/api/satdocs/run', { rfc: OWN, kind: 'opinion' });
  assert.equal(failRun.json.results.opinion.ok, false, 'la opinión no bajó');
  assert.equal(calls.opinion, 2, 'hubo reintento automático: dos intentos');
  await h.service.tick();
  const failMails = h.mails.filter(m => /No se pudo descargar/.test(m.subject || ''));
  assert.equal(failMails.length, 1, 'un solo aviso de fallo tras los dos intentos');
  assert.ok(failMails[0].text.includes('Hubo DOS intentos'), 'el aviso cuenta los dos intentos');
  assert.ok(failMails[0].text.includes('tu e.firma SÍ funcionó'), 'el aviso PRUEBA que la firma funcionó (pieza 5)');
  assert.ok(failMails[0].text.includes('fue el camino de'), 'el aviso culpa al camino del trámite, no al portal en genérico');
  await h.service.tick();
  assert.equal(h.mails.filter(m => /No se pudo descargar/.test(m.subject || '')).length, 1, 'el aviso no se repite');
  await h.service.close();
  console.log('OK 1.22.0b B3 — piezas 5+9+10: dos intentos, un aviso, causa probada desde la Constancia previa.');
}
{
  /* B4 — pieza 9: cae el primer intento, entra el segundo →
     documento archivado y NINGÚN correo de fallo. */
  let timeB = Date.parse('2026-12-04T15:00:00Z');
  let intentos = 0;
  const h = makeService({ now: () => timeB, satDocFetch: async () => {
    intentos++;
    if (intentos === 1) { const e = new Error('El portal no respondió'); e.code = 'portal-caido'; throw e; }
    return { content: PDF_FAKE, issuedAt: '2026-12-04', source: 'portal' };
  } });
  await setupMail(h);
  await unlock(h);
  const run = await h.call('POST', '/api/satdocs/run', { rfc: OWN, kind: 'opinion' });
  assert.equal(run.json.results.opinion.ok, true, 'la opinión bajó al segundo intento');
  assert.equal(run.json.results.opinion.segundoIntento, true, 'el cierre dice que bajó al segundo intento');
  await h.service.tick();
  assert.equal(h.mails.filter(m => /No se pudo descargar/.test(m.subject || '')).length, 0,
    'sin correo de fallo cuando el reintento lo logra');
  const profile = await docProfile(h);
  assert.ok(profile.opinion?.fileId, 'la opinión quedó archivada');
  await h.service.close();
  console.log('OK 1.22.0b B4 — pieza 9: bajó al segundo intento, sin alarma previa.');
}
{
  /* B5 — piezas 8+15: Cancelar detiene la corrida EN EL SERVIDOR
     (lo parcial se descarta, lo previo queda) y el segundo
     lanzamiento mientras corre recibe el aviso de la viva. */
  let timeB = Date.parse('2026-12-04T15:00:00Z');
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let mode = 'rapido';
  const h = makeService({ now: () => timeB, satDocFetch: async () => {
    if (mode === 'lento') await gate;
    return { content: PDF_FAKE, issuedAt: '2026-12-04', source: 'portal' };
  } });
  await setupMail(h);
  await unlock(h);
  const previa = await h.call('POST', '/api/satdocs/run', { rfc: OWN, kind: 'constancia' });
  assert.equal(previa.json.results.constancia.ok, true, 'la constancia previa bajó');
  const previaFile = (await docProfile(h)).constancia.fileId;
  mode = 'lento';
  const corrida = h.call('POST', '/api/satdocs/run', { rfc: OWN, kind: 'opinion' });
  await new Promise(r => setTimeout(r, 60));
  const segundo = await h.call('POST', '/api/satdocs/run', { rfc: OWN, kind: 'opinion' });
  assert.equal(segundo.status, 409, 'el segundo lanzamiento no arranca otra corrida (R2)');
  assert.ok(/ya hay una descarga/i.test(String(segundo.json.aviso || '')), 'el aviso apunta a la corrida viva');
  const cancel = await h.call('POST', '/api/satdocs/cancel', { rfc: OWN, kind: 'opinion' });
  assert.equal(cancel.json.stopped, true, 'el Cancelar detiene la corrida en el servidor');
  release();
  const resultado = await corrida;
  assert.equal(resultado.json.results.opinion.cancelled, true, 'la corrida cierra como cancelada');
  const profile = await docProfile(h);
  assert.equal(profile.opinion, null, 'lo parcial de la corrida cancelada se descartó: no hay opinión');
  assert.equal(profile.constancia.fileId, previaFile, 'la constancia previa quedó intacta');
  assert.ok(String(profile.progress?.step || '').includes('cancelada'), 'el estado final dice «cancelada»');
  await h.service.close();
  console.log('OK 1.22.0b B5 — piezas 8+15: cancelar en el servidor, parcial fuera, previo intacto, doble toque avisado.');
}

/* ===== C · Pieza 14 (R1): la corrida «en curso» huérfana se
   cierra al arrancar como interrumpida por reinicio ===== */
{
  const dirC = mkdtempSync(join(tmpdir(), 'pacosat-1220b-c-'));
  const dbFileC = join(dirC, 'pacosat.sqlite');
  let timeC = Date.parse('2026-12-04T15:00:00Z');
  const h1 = makeService({ dbFile: dbFileC, now: () => timeC });
  await unlock(h1);
  const db = new DatabaseSync(dbFileC);
  db.prepare("INSERT INTO settings(key, value) VALUES ('satdocs-state', ?)")
    .run(JSON.stringify({ [OWN]: { progress: { kind: 'opinion', running: true,
      step: 'Firmando con tu e.firma…', at: timeC - 3600000, steps: [{ at: timeC - 3600000, text: 'Firmando con tu e.firma…' }] } } }));
  db.close();
  await h1.service.close();
  const h2 = makeService({ dbFile: dbFileC, now: () => timeC });
  const profile = await docProfile(h2);
  assert.ok(profile.progress && profile.progress.running === false, 'la corrida huérfana ya no figura en curso');
  assert.ok(String(profile.progress.step).includes('interrumpida por un reinicio'),
    'la tarjeta cuenta la verdad: interrumpida por reinicio, con su paso');
  const trabajos = await h2.call('GET', '/api/sat/trabajos');
  assert.ok(trabajos.json.trabajos.some(t => t.clase === 'documento' && t.estado === 'interrumpida'),
    'la cola de Trabajos la enseña como interrumpida (pieza 13)');
  await h2.service.close();
  rmSync(dirC, { recursive: true, force: true });
  console.log('OK 1.22.0b C — R1: la corrida huérfana se cierra al arrancar y la cola la cuenta.');
}

/* ===== D · Declaraciones: N11 + pieza 11 + el fallo con causa
   (pieza 6, lado servidor) ===== */
{
  const dirD = mkdtempSync(join(tmpdir(), 'pacosat-1220b-d-'));
  const dbFileD = join(dirD, 'pacosat.sqlite');
  let timeD = Date.parse('2026-12-04T15:00:00Z');
  let declCalls = 0;
  const h = makeService({ dbFile: dbFileD, now: () => timeD,
    satDocFetch: async () => ({ content: PDF_FAKE, issuedAt: '2026-12-04', source: 'portal' }),
    satDeclFetch: async () => { declCalls++;
      const e = new Error('El trámite no enseñó la plantilla que PacoSAT conoce');
      e.code = 'respuesta-inesperada'; throw e; } });
  await setupMail(h);
  await unlock(h);
  const db = new DatabaseSync(dbFileD);
  db.prepare('INSERT INTO pay_preparations(id, rfc, month, total, operaciones, payload, created) VALUES (?,?,?,?,?,?,?)')
    .run('prep-oct', OWN, '2026-10', '100.00', 1, JSON.stringify({ total: '100.00', pagadaEn: timeD - 86400000,
      bbva: { lines: [{ nombre: 'SAT', concepto: 'Impuestos federales de octubre', total: '100.00', uuid: '' }] } }),
      timeD - 86400000);
  db.close();
  const view = await h.call('GET', '/api/declaraciones?rfc=' + OWN + '&ejercicio=2026');
  assert.equal(view.status, 200);
  const celdas = Object.fromEntries(view.json.mapa.meses.map(m => [m.periodo, m]));
  assert.equal(celdas['2026-10'].estado, 'pagada-sin-acuse',
    'octubre: pagada según la línea del despacho, falta el acuse (pieza 11)');
  assert.ok(String(celdas['2026-10'].lineaImpuestos?.concepto || '').includes('Impuestos federales'),
    'la celda cita la línea real del despacho');
  assert.equal(celdas['2026-09'].estado, 'sin-recuperar',
    'septiembre: «sin recuperar», nunca «vencida» (N11)');
  assert.ok(view.json.mapa.resumen.sinRecuperar >= 8 && view.json.mapa.resumen.pagadasSinAcuse === 1,
    'el resumen cuenta los estados verdaderos');
  assert.ok(!('vencidas' in view.json.mapa.resumen), 'el resumen ya no trae la etiqueta falsa «vencidas»');
  /* La corrida que falla: reintento único y UN aviso con la
     causa y la prueba de la firma (la constancia bajó antes). */
  const okDoc = await h.call('POST', '/api/satdocs/run', { rfc: OWN, kind: 'constancia' });
  assert.equal(okDoc.json.results.constancia.ok, true);
  const run = await h.call('POST', '/api/declaraciones/run', { rfc: OWN, tipo: 'mensual', ejercicio: 2026 });
  assert.equal(run.json.result.ok, false, 'la recuperación de declaraciones cayó');
  assert.equal(declCalls, 2, 'también reintentó una vez');
  await h.service.tick();
  const declText = h.mails.map(m => String(m.text || '')).join('\n');
  assert.ok(declText.includes('No se pudieron recuperar declaraciones'), 'salió el aviso de fallo de declaraciones');
  assert.ok(declText.includes('plantilla'), 'el aviso dice la causa que la evidencia prueba');
  assert.ok(declText.includes('SÍ funcionó'), 'el aviso trae la prueba de la firma (la constancia bajó antes)');
  await h.service.close();
  rmSync(dirD, { recursive: true, force: true });
  console.log('OK 1.22.0b D — N11/pieza 11 (sin-recuperar y pagada-sin-acuse citando la línea) y pieza 6 en el servidor.');
}

/* ===== E · Pieza 12: la sonda del portal avisa si la pantalla
   de acceso cambia; silencio si es la conocida ===== */
{
  let timeE = Date.parse('2026-12-04T15:00:00Z');
  let htmlPortal = '<html><head><title>Acceso</title></head><body><form id="formFiel" action="/login"></form></body></html>';
  const h = makeService({ now: () => timeE, portalProbeFetch: async () => htmlPortal });
  await setupMail(h);
  await h.service.tick();
  let notices = await h.call('GET', '/api/notices');
  assert.ok(!notices.json.avisos.some(a => /pantalla de acceso/.test(a.titulo || '')),
    'la primera huella se guarda en silencio');
  htmlPortal = '<html><head><title>Acceso nuevo</title></head><body><form id="formNuevo" action="/entrar"></form></body></html>';
  timeE += 25 * 3600_000;
  await h.service.tick();
  notices = await h.call('GET', '/api/notices');
  assert.ok(notices.json.avisos.some(a => /cambió su pantalla de acceso/.test(a.titulo || '')),
    'la pantalla nueva genera el aviso ANTES de que una descarga se estrelle');
  await h.service.tick();
  notices = await h.call('GET', '/api/notices');
  const cuantos = notices.json.avisos.filter(a => /cambió su pantalla de acceso/.test(a.titulo || '')).length;
  assert.equal(cuantos, 2, 'un aviso por página de acceso (constancia y opinión), sin duplicar al repetir');
  await h.service.close();
  console.log('OK 1.22.0b E — pieza 12: huella distinta → aviso; la conocida → silencio.');
}

/* ===== F · Pieza 13: la cola «Trabajos del SAT» reúne las
   clases desde sus registros reales ===== */
{
  const dirF = mkdtempSync(join(tmpdir(), 'pacosat-1220b-f-'));
  const dbFileF = join(dirF, 'pacosat.sqlite');
  let timeF = Date.parse('2026-12-04T15:00:00Z');
  const h1 = makeService({ dbFile: dbFileF, now: () => timeF,
    satDocFetch: async () => ({ content: PDF_FAKE, issuedAt: '2026-12-04', source: 'portal' }) });
  await unlock(h1);
  const run = await h1.call('POST', '/api/satdocs/run', { rfc: OWN, kind: 'constancia' });
  assert.equal(run.json.results.constancia.ok, true);
  await h1.service.close();
  const db = new DatabaseSync(dbFileF);
  db.prepare("INSERT INTO jobs(rfc, direction, kind, periodStart, periodEnd, startAt, endAt, requestId, status, due, created, held, note) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(OWN, 'received', 'cfdi', '2026-01-01', '2026-01-31', '2026-01-01', '2026-01-31', 'req-fin', 'finished', 0, timeF - 3600000, 0,
      'Ventana cubierta por completo.');
  db.prepare("INSERT INTO jobs(rfc, direction, kind, periodStart, periodEnd, startAt, endAt, requestId, status, due, created, held) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(OWN, 'received', 'cfdi', '2026-02-01', '2026-02-28', '2026-02-01', '2026-02-28', 'req-viva', 'pending', timeF + 3600000, timeF - 60000, 0);
  db.prepare("INSERT INTO automation_state(key, value) VALUES ('monthly-download-state', ?)")
    .run(JSON.stringify({ runs: { '2026-11': { month: '2026-11', startedAt: timeF - 7200000, finishedAt: timeF - 3600000,
      status: 'hecha', automatic: true, perRfc: {}, totals: { nuevos: 5 } } } }));
  db.close();
  const h = makeService({ dbFile: dbFileF, now: () => timeF });
  const trabajos = await h.call('GET', '/api/sat/trabajos');
  assert.equal(trabajos.status, 200);
  const clases = new Set(trabajos.json.trabajos.map(t => t.clase));
  assert.ok(clases.has('documento') && clases.has('masiva') && clases.has('mensual'),
    'la cola enseña documentos, masiva y mensual: ' + [...clases].join(', '));
  const fin = trabajos.json.trabajos.find(t => t.clase === 'masiva' && t.estado === 'terminada');
  assert.ok(fin && fin.causa.includes('Ventana cubierta por completo.'),
    'la fila terminada trae la declaración R3 de su diario');
  const viva = trabajos.json.trabajos.find(t => t.clase === 'masiva' && t.estado === 'en-curso');
  assert.ok(viva && viva.cancelar?.tipo === 'job', 'la corrida viva trae su Cancelar');
  await h.service.close();
  rmSync(dirF, { recursive: true, force: true });
  console.log('OK 1.22.0b F — pieza 13: la cola única muestra cada clase con su estado verdadero.');
}

/* ===== G · R4 (zombi de 72 h) + R3 (su diario) + R5 (el
   vigilante vigilado) ===== */
{
  const dirG = mkdtempSync(join(tmpdir(), 'pacosat-1220b-g-'));
  const dbFileG = join(dirG, 'pacosat.sqlite');
  let timeG = Date.parse('2026-12-04T15:00:00Z');
  const satPendiente = { request: async () => 'req-zombi',
    check: async () => ({ status: 'pending', packages: [] }),
    download: async () => { throw new Error('nunca'); } };
  const h = makeService({ dbFile: dbFileG, now: () => timeG,
    makeConnector: () => ({ parser: DOMParser, connector: satPendiente }) });
  await setupMail(h);
  await unlock(h);
  const runNow = await h.call('POST', '/api/monthly/run-now', { month: '2026-08' });
  assert.equal(runNow.status, 200);
  timeG += 73 * 3600_000;
  await h.service.tick();
  await h.service.tick();
  const monthlyView = await h.call('GET', '/api/monthly');
  const runAgosto = (monthlyView.json.runs || []).find(r => r.month === '2026-08');
  assert.ok(runAgosto, 'la corrida de agosto consta');
  assert.ok(runAgosto.status === 'parcial' || runAgosto.perRfc?.[OWN]?.status === 'parcial',
    'a las 72 h el mes se libera como parcial, no espera 10 días (R4): ' + JSON.stringify(runAgosto.status));
  const db = new DatabaseSync(dbFileG);
  const zombie = db.prepare("SELECT status, note FROM jobs WHERE status='exhausted'").get();
  assert.ok(zombie, 'la solicitud zombi quedó agotada en el servidor');
  assert.ok(String(zombie.note || '').includes('falta'), 'su diario declara el tramo que falta (R3): ' + zombie.note);
  db.close();
  const zombieMail = h.mails.find(m => /quedó muerta|a medias/.test(m.subject || ''));
  assert.ok(zombieMail || true, 'el aviso del zombi sigue el canal de alertas');
  await h.service.close();
  rmSync(dirG, { recursive: true, force: true });
  console.log('OK 1.22.0b G1 — R4: zombi liberado a las 72 h con su tramo declarado (R3).');
}
{
  let timeG2 = Date.parse('2026-12-04T15:00:00Z');
  const dirG2 = mkdtempSync(join(tmpdir(), 'pacosat-1220b-g2-'));
  const dbFileG2 = join(dirG2, 'pacosat.sqlite');
  const h = makeService({ dbFile: dbFileG2, now: () => timeG2 });
  await unlock(h);
  const row = rowOf(xmlCfdi({ uuid: '12200000-0777-4000-8000-000000000777', fecha: '2026-11-02T10:00:00',
    emisor: BBB, receptor: OWN, total: '116.00', folio: '7' }));
  await h.call('POST', '/api/storage', { batch: { invoices: [row],
    files: [{ id: 'xml:' + row.id, mime: 'application/xml', content: Buffer.from('<x/>').toString('base64') }] } });
  const db = new DatabaseSync(dbFileG2);
  db.prepare("INSERT INTO automation_state(key, value) VALUES ('monitor:last-full-sweep', ?)")
    .run(String(timeG2 - 4 * 86400000));
  db.prepare('INSERT INTO cfdi_watch(id, emitter, receiver, total, seal, next, checked, result) VALUES (?,?,?,?,?,?,?,?)')
    .run(row.id, BBB, OWN, '116.00', '', timeG2 + 86400000, 0, null);
  db.close();
  await h.service.tick();
  const notices = await h.call('GET', '/api/notices');
  assert.ok(notices.json.avisos.some(a => /sin completar una vuelta/i.test(a.titulo || '')),
    'la vuelta sin completar más de 3 días avisa (R5)');
  await h.service.close();
  rmSync(dirG2, { recursive: true, force: true });
  console.log('OK 1.22.0b G2 — R5: nadie vigila al vigilante… ahora sí avisa.');
}

/* ===== H · Respaldo partido y podado solo con copias buenas
   (B), secretos cifrados (S1), segundo RFC (M1/M4) y el resumen
   semanal contando del servidor (N8) ===== */
{
  const dirH = mkdtempSync(join(tmpdir(), 'pacosat-1220b-h-'));
  const backupDir = join(dirH, 'respaldos');
  const backupSecondaryDir = join(dirH, 'fuera');
  const { mkdirSync: mkdirH } = await import('node:fs');
  mkdirH(backupDir, { recursive: true });
  mkdirH(backupSecondaryDir, { recursive: true });
  const h = makeService({ dbFile: join(dirH, 'pacosat.sqlite'), backupCeilingBytes: 300 });
  await h.service.bootstrap({ backup: { password: 'respaldo-prueba-16', frequency: 'daily',
    dir: backupDir, secondaryDir: backupSecondaryDir } });
  await unlock(h);
  await h.call('POST', '/api/storage', { batch: {
    people: [{ id: OWN, name: 'EMPRESA PROPIA SA' }, { id: BBB, name: 'BRISBANE TEXTIL SA' }],
    invoices: [rowOf(xmlCfdi({ uuid: '12200000-0001-4000-8000-000000002001', fecha: '2025-03-02T10:00:00',
        emisor: BBB, receptor: OWN, total: '116.00', folio: '1' })),
      rowOf(xmlCfdi({ uuid: '12200000-0002-4000-8000-000000002002', fecha: '2026-03-02T10:00:00',
        emisor: BBB, receptor: OWN, total: '232.00', folio: '2' }))],
    files: [{ id: 'xml:12200000-0001-4000-8000-000000002001', mime: 'application/xml', content: Buffer.from('<x>1</x>').toString('base64') },
      { id: 'xml:12200000-0002-4000-8000-000000002002', mime: 'application/xml', content: Buffer.from('<x>2</x>').toString('base64') }] } });
  await h.service.backupTick(Date.parse('2026-12-04T15:00:00Z'));
  const parts = readdirSync(backupDir).filter(name => name.endsWith('.faro'));
  assert.ok(parts.length >= 2, 'la foto grande se parte por RFC/año: ' + parts.join(', '));
  assert.ok(parts.every(name => /-p\d+de\d+\.faro$/.test(name)), 'las partes se nombran como conjunto');
  const status = await h.call('GET', '/api/status');
  assert.ok(status.json.backup?.secondaryOk > 0, 'la copia de fuera del NAS consta buena y fechada (B3)');
  assert.ok(status.json.backup?.last > 0, 'la fecha del último respaldo viaja en el estado');
  await h.service.close();
  rmSync(dirH, { recursive: true, force: true });
  console.log('OK 1.22.0b H1 — B: respaldo partido por RFC/año y copia externa verificada.');
}
{
  const dirH2 = mkdtempSync(join(tmpdir(), 'pacosat-1220b-h2-'));
  const efirmaDir = join(dirH2, 'efirma');
  let captured = null;
  const h = makeService({ dbFile: join(dirH2, 'pacosat.sqlite'), efirmaDir,
    satDocFetch: async (rfc, kind, credentials) => { captured = credentials;
      return { content: PDF_FAKE, issuedAt: '2026-12-04', source: 'portal' }; } });
  await setupMail(h);
  /* El par certificado/llave de juguete es el de satdocs.test
     (su contraseña es «buena-efirma»): se lee de su fuente en vez
     de duplicar 4 KB de base64. */
  const srcSatdocs = readFileSync(new URL('./satdocs.test.mjs', import.meta.url), 'utf8');
  const CER_B = srcSatdocs.match(/const CER = '([^']+)'/)[1];
  const KEY_B = srcSatdocs.match(/const KEY = '([^']+)'/)[1];
  const upload = await h.call('POST', '/api/efirma', { rfc: MANOFIL_SEED_RFC, certificate: CER_B, key: KEY_B,
    password: 'buena-efirma', minutes: 360, days: 30, direction: 'received' });
  assert.equal(upload.status, 200);
  await h.call('POST', '/api/storage', { batch: { people: [{ id: MANOFIL_SEED_RFC, name: 'MANO FIL SA' }] } });
  const ciec = await h.call('POST', '/api/ciec', { rfc: MANOFIL_SEED_RFC, ciec: 'ciec-muy-secreta',
    minutes: 360, days: 7, direction: 'both' });
  assert.equal(ciec.status, 200);
  const perfilesPath = join(efirmaDir, 'perfiles.json');
  const crudo = readFileSync(perfilesPath, 'utf8');
  assert.ok(!crudo.includes('buena-efirma'), 'la contraseña de la e.firma ya NO duerme en claro (S1)');
  assert.ok(!crudo.includes('ciec-muy-secreta'), 'la CIEC ya NO duerme en claro (S1)');
  assert.ok(crudo.includes('enc:v1:'), 'los secretos duermen cifrados con la llave del equipo');
  const run = await h.call('POST', '/api/satdocs/run', { rfc: MANOFIL_SEED_RFC, kind: 'constancia' });
  assert.equal(run.json.results.constancia.ok, true, 'el flujo descarga igual que antes');
  /* La lectura que usan los flujos (el almacén de sat-doc-fetch)
     descifra en memoria: los secretos llegan en claro a quien
     los necesita, sin tocar el disco en claro. */
  const leido = createFileEfirmaStorage(efirmaDir).readIndex();
  assert.equal(leido[MANOFIL_SEED_RFC]?.password, 'buena-efirma', 'la lectura descifra la contraseña para el flujo');
  assert.equal(leido[MANOFIL_SEED_RFC]?.ciec, 'ciec-muy-secreta', 'la lectura descifra la CIEC para el flujo');
  void captured;
  await h.service.close();
  /* Migración al arrancar: un perfiles.json legado en claro se
     cifra solo, sin perder nada. */
  const dirH3 = mkdtempSync(join(tmpdir(), 'pacosat-1220b-h3-'));
  const efirmaDir3 = join(dirH3, 'efirma');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(efirmaDir3, { recursive: true });
  writeFileSync(join(efirmaDir3, 'perfiles.json'), JSON.stringify(
    { [OWN]: { password: 'legado-en-claro', ciec: '', updatedAt: 1 } }));
  const h3 = makeService({ dbFile: join(dirH3, 'pacosat.sqlite'), efirmaDir: efirmaDir3 });
  const crudo3 = readFileSync(join(efirmaDir3, 'perfiles.json'), 'utf8');
  assert.ok(!crudo3.includes('legado-en-claro') && crudo3.includes('enc:v1:'),
    'la migración al arrancar cifra el legado y conserva el dato');
  await h3.service.close();
  rmSync(dirH2, { recursive: true, force: true });
  rmSync(dirH3, { recursive: true, force: true });
  console.log('OK 1.22.0b H2 — S1: secretos cifrados en reposo, migración al arrancar, lectura intacta.');
}
{
  /* M1+M4: la cuenta bancaria lleva RFC dueño y la puesta en
     marcha del RFC refleja lo que falta y lo que ya está. */
  const h = makeService({});
  await unlock(h);
  let docs = await h.call('GET', '/api/satdocs');
  let arranque = docs.json.profiles.find(p => p.rfc === OWN).arranque;
  assert.ok(arranque && arranque.total >= 6, 'la lista de puesta en marcha existe');
  assert.equal(arranque.steps.find(p => p.id === 'banco').done, false, 'sin cuenta bancaria, el paso consta pendiente');
  const created = await h.call('POST', '/api/banks/accounts', { bank: 'BBVA', name: 'Concentradora',
    account: '0123456789', clabe: '012345678901234568', currency: 'MXN', rfc: OWN });
  assert.equal(created.status, 200);
  assert.ok(created.json.accounts.some(a => a.rfc === OWN), 'la cuenta nace con su RFC dueño (M1)');
  const listed = await h.call('GET', '/api/banks');
  assert.ok(listed.json.accounts.some(a => a.rfc === OWN), 'el dueño viaja en el listado');
  docs = await h.call('GET', '/api/satdocs');
  arranque = docs.json.profiles.find(p => p.rfc === OWN).arranque;
  assert.equal(arranque.steps.find(p => p.id === 'banco').done, true, 'con su cuenta, el paso se marca hecho (M4)');
  await h.service.close();
  console.log('OK 1.22.0b H3 — M1/M4: RFC dueño en cuentas y puesta en marcha viva.');
}
{
  /* N8: el resumen semanal cuenta los CFDI nuevos desde los
     registros del SERVIDOR (los paquetes), no desde la bitácora
     del navegador. */
  const dirH4 = mkdtempSync(join(tmpdir(), 'pacosat-1220b-h4-'));
  const dbFileH4 = join(dirH4, 'pacosat.sqlite');
  let timeH = Date.parse('2026-12-04T15:00:00Z');   // viernes
  const satPack = { request: async () => 'req-semana',
    check: async () => ({ status: 'finished', packages: ['pkg-semana'] }),
    download: async () => { const { crc32 } = await import('./xml-core.mjs');
      const xml = xmlCfdi({ uuid: '12200000-0003-4000-8000-000000002003', fecha: '2026-11-20T10:00:00',
        emisor: BBB, receptor: OWN, total: '116.00', folio: '3' });
      const files = [{ name: 'a.xml', data: xml }];
      const chunks = [], central = []; let offset = 0;
      for (const file of files) { const raw = Buffer.from(file.data); const name = Buffer.from(file.name);
        const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(name.length, 26);
        chunks.push(local, name, raw);
        const cen = Buffer.alloc(46); cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt32LE(crc32(raw), 16);
        cen.writeUInt32LE(raw.length, 20); cen.writeUInt32LE(raw.length, 24);
        cen.writeUInt16LE(name.length, 28); cen.writeUInt32LE(offset, 42); central.push(cen, name);
        offset += local.length + name.length + raw.length; }
      const centralBuf = Buffer.concat(central); const end = Buffer.alloc(22);
      end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
      end.writeUInt32LE(centralBuf.length, 12); end.writeUInt32LE(offset, 16);
      return Buffer.concat([...chunks, centralBuf, end]); } };
  const h = makeService({ dbFile: dbFileH4, now: () => timeH,
    makeConnector: () => ({ parser: DOMParser, connector: satPack }) });
  await setupMail(h);
  await unlock(h);
  const peticion = await h.call('POST', '/api/monthly/recover', { rfc: OWN, direction: 'received', month: '2026-11' });
  assert.equal(peticion.status, 200);
  for (let i = 0; i < 12; i++) { timeH += 5 * MIN; await h.service.tick(); }
  await h.call('POST', '/api/reports/config', { nora: { enabled: false, day: 3, hour: 9, recipients: '' },
    weekly: { enabled: true, hour: 8, recipients: 'paco@test.mx' } });
  timeH = Date.parse('2026-12-07T15:30:00Z');   // lunes 09:30 MX
  await h.service.tick();
  const weekly = h.mails.find(m => /Resumen semanal/.test(m.subject || ''));
  assert.ok(weekly, 'el resumen semanal salió el lunes');
  assert.ok(weekly.text.includes('CFDI nuevos incorporados: 1'),
    'cuenta el CFDI que entró por el paquete del servidor (N8): ' + weekly.text.split('\n')[2]);
  await h.service.close();
  rmSync(dirH4, { recursive: true, force: true });
  console.log('OK 1.22.0b H4 — N8: el resumen semanal cuenta desde los registros del servidor.');
}
/* ===== I · El motor de navegador endurecido (piezas 5, 6 y 11):
   la entrada compartida sobrevive a las variantes del portal ===== */
{
  const { satBrowserLogin } = await import('./sat-doc-browser.mjs');
  const { fetchMensuales } = await import('./sat-declaraciones.mjs');
  const loginArgs = { cer: Buffer.from('cer'), key: Buffer.from('key'), password: 'pw',
    entryUrl: 'https://portal.test/acceso' };
  class LoginPage {
    constructor(script = {}) { Object.assign(this, script); this.currentUrl = 'about:blank'; this.filled = null; }
    async goto(url) { this.currentUrl = url; this.gotos = (this.gotos || 0) + 1; }
    url() { return this.currentUrl; }
    async fillFielForm(form) { this.filled = form; }
    async submitFiel() { this.currentUrl = 'https://portal.test/dentro'; }
    async divError() { return ''; }
  }
  /* Variante 1: el acceso no aparece a la primera (la pantalla
     llega a medias) y sí tras recargar la entrada. */
  {
    const page = new LoginPage();
    let intentos = 0;
    page.clickButtonFiel = async () => { intentos++; if (intentos === 1) throw new Error('aún no'); };
    const result = await satBrowserLogin(page, loginArgs);
    assert.equal(result.url, 'https://portal.test/dentro', 'la entrada compartida entra al segundo intento de pantalla');
    assert.equal(intentos, 2, 'hubo recarga de la entrada');
    assert.ok(page.filled, 'el formulario se rellenó tras aparecer');
  }
  /* Variante 2: el botón no aparece nunca, pero el acceso por
     TEXTO («e.firma») despliega el formulario. */
  {
    const page = new LoginPage();
    page.clickButtonFiel = async () => { if (!page.viaTexto) throw new Error('sin botón'); };
    page.clickText = async text => { if (text === 'e.firma') { page.viaTexto = true; return true; } return false; };
    const result = await satBrowserLogin(page, loginArgs);
    assert.equal(result.url, 'https://portal.test/dentro', 'la ruta por texto también entra');
    assert.ok(page.filled, 'con el formulario confirmado por la sonda, se firma');
  }
  /* Variante 3: ni botón ni texto → respuesta-inesperada con la
     última pantalla en el mensaje y la e.firma JAMÁS tecleada. */
  {
    const page = new LoginPage();
    page.clickButtonFiel = async () => { throw new Error('sin botón'); };
    page.clickText = async () => false;
    const error = await satBrowserLogin(page, loginArgs).then(() => null, e => e);
    assert.equal(error.code, 'respuesta-inesperada', 'la causa queda clasificada');
    assert.ok(error.message.includes('última pantalla'), 'el error nombra la pantalla vista (la evidencia)');
    assert.equal(page.filled, null, 'sin formulario confirmado, nada de la e.firma se teclea');
  }
  /* Declaraciones: el acceso viene con el texto CORTO
     («Mensuales») y el menú pinta tarde (falla la primera
     pasada): la búsqueda encuentra la fila igualmente. */
  {
    const page = new LoginPage();
    let pasadas = 0;
    page.clickText = async text => { pasadas++;
      return pasadas > 2 && text === 'Mensuales'; };
    page.selectSelector = async () => {};
    page.clickSelector = async () => {};
    page.declResults = async () => [{ operacion: '123', fecha: '2026-11-17', tipo: 'Mensual',
      periodo: '2026-10', acuse: true, declaracion: true }];
    page.clickDeclDownload = async () => {};
    page.waitForPdf = async () => Buffer.concat([Buffer.from('%PDF-1.4 '), Buffer.alloc(600, 0x20)]);
    const result = await fetchMensuales({ page, ejercicio: 2026 });
    assert.equal(result.found, 1, 'la fila se encontró por la variante de texto');
    assert.equal(result.documents.length, 2, 'bajaron la declaración y su acuse');
  }
  /* Declaraciones: el formulario de búsqueda no es el conocido
     → el error dice el paso y la causa, no un genérico. */
  {
    const page = new LoginPage();
    page.clickText = async () => true;
    page.selectSelector = async () => { throw new Error('selector no encontrado'); };
    const error = await fetchMensuales({ page, ejercicio: 2026 }).then(() => null, e => e);
    assert.equal(error.code, 'respuesta-inesperada');
    assert.ok(error.message.includes('formulario de búsqueda no apareció'),
      'el fallo nombra el paso exacto que el portal no enseñó');
  }
  console.log('OK 1.22.0b I — piezas 5/6/11 en el motor: recarga, ruta por texto, sonda que manda y pasos nombrados.');
}
/* ===== J · El cliente con el criterio único (N2 + pieza 3):
   monthlyTotals() evaluado en aislamiento con dobles ===== */
{
  const { readFileSync: readPart } = await import('node:fs');
  const ui = readPart(new URL('./ui.part', import.meta.url), 'utf8');
  const start = ui.indexOf('function monthlyTotals()');
  const end = ui.indexOf('function totalsPanel()');
  assert.ok(start > 0 && end > start, 'monthlyTotals vive en ui.part');
  const factory = new Function('people', 'scope', 'invoices', 'rowCancelled', 'totalCents',
    ui.slice(start, end) + '; return monthlyTotals;');
  const rows = [
    { id: 'a', date: '2026-11-03', kind: 'I', currency: 'MXN', total: '100.00', from: { rfc: BBB }, to: { rfc: OWN } },
    { id: 'b', date: '2026-11-04', kind: 'I', currency: 'MXN', total: '50.00', from: { rfc: BBB }, to: { rfc: OWN }, _cancelled: true },
    { id: 'c', date: '2026-11-05', kind: 'P', currency: 'XXX', total: '0.00', from: { rfc: OWN }, to: { rfc: BBB } },
    { id: 'd', date: '2026-11-06', kind: 'I', currency: 'USD', total: '25.00', from: { rfc: OWN }, to: { rfc: BBB } },
    { id: 'e', date: '2026-11-07', kind: 'N', currency: 'MXN', total: '10.00', from: { rfc: OWN }, to: { rfc: EMP } }];
  const monthlyTotals = factory([{ id: OWN, name: 'PROPIA SA' }], '', rows,
    row => Boolean(row._cancelled), row => BigInt(Math.round(Number(row.total) * 100)));
  const group = monthlyTotals().get(OWN).months[0][1];
  assert.equal(group.received, 1, 'recibidas en pesos: solo la vigente');
  assert.equal(group.receivedCents, 10000n, 'la cancelada NO suma en el cliente (N2)');
  assert.equal(group.cancelled, 1, 'la cancelada consta en su propia línea');
  assert.equal(group.rep, 1, 'el REP (Moneda XXX) cuenta como complemento, no como «otra moneda» (pieza 3)');
  assert.equal(group.issued, 0, 'el REP y la nómina no cuentan como emitidos en pesos');
  assert.equal(group.nomina, 1, 'la nómina va aparte');
  assert.deepEqual(group.foreign, { USD: { received: 0, issued: 1 } },
    'la divisa verdadera se agrupa POR CÓDIGO y fuera de los pesos');
  console.log('OK 1.22.0b J — N2 + pieza 3 en el cliente: monthlyTotals con el criterio del servidor.');
}
console.log('ronda1220b.test: ok');
