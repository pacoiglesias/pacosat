/* ================================================================
   Ronda 2.4.0 · WC3b — castigos 14, 15 y 20.
   (14) CFDI DE RETENCIONES como tipo propio: un XML con raíz
        <retenciones:Retenciones> (esquema real 2.0) se CLASIFICA
        como su tipo — no se rechaza como Comprobante ni se archiva
        como tal —, se parsea con sus campos exactos (emisor y
        receptor, folio interno, fecha, periodo, monto de la
        operación, total retenido y detalle por impuesto/base/
        importe), se guarda como documento «CFDI de retenciones»
        y se deduplica por su identidad (folio + emisor + periodo
        + receptor) y por la huella del fichero, sin UUID inventado.
        El cruce contra los CFDI normales cuadra cuando los datos
        lo permiten y dice «sin cruce posible» cuando no.
   (15) COMPARADOR XML/PDF en la ficha: con el PDF DEL EMISOR
        archivado (documento «Factura PDF» con el UUID), su texto
        — leído con el extractor real de bank-statement — se
        contrasta campo a campo: un total distinto pinta SOLO ese
        campo como DIFERENTE con las dos cifras, y el IVA ausente
        en el PDF sale «no consta», nunca como diferencia.
   (20) INTEGRIDAD al abrir un XML: estructura + huella SHA-256
        registrada al importar + estado en el SAT. Íntegro con
        huella coincidente y vigente ⇒ verde; huella cambiada ⇒
        rojo; sin timbre ⇒ rojo en estructura; sin huella de
        importación ⇒ ámbar con «no consta»; y el texto de lo NO
        verificable (el sello criptográfico del emisor) está
        presente y dice por qué.
   ================================================================ */
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createHash, webcrypto } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { URL as NodeURL } from 'node:url';
import { DOMParser, Node as XmlNode } from '@xmldom/xmldom';
import { createPacoSATService } from './local-server.mjs';
import { extractPdfTextLines } from './bank-statement.mjs';
import { clasificaDocumentoXml, parseXml, parseCfdiFull, parseRetenciones, retencionesDocRow,
  retencionesEsDuplicada, cruceRetenciones, sha256Hex, integridadCfdi, compararCfdiPdf, crc32 } from './xml-core.mjs';

const EMISOR = 'AAA010101AAA', RECEPTOR = 'BBB010101BB1', PROPIO = 'XAXX010101000';
const UUID = '12345678-1234-4234-8234-1234567890AB';
const SELLO = 'A'.repeat(342) + '==';
const sha256 = raw => createHash('sha256').update(raw).digest('hex');

/* ===== Juguetes ===== */
const CFDI_XML = `<?xml version="1.0" encoding="UTF-8"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" Version="4.0" Serie="A" Folio="101" Fecha="2026-10-05T10:00:00" SubTotal="1000.00" Total="1160.00" Moneda="MXN" TipoDeComprobante="I" NoCertificado="00001000000501234567" Sello="${SELLO}">
<cfdi:Emisor Rfc="${EMISOR}" Nombre="PAGADORA SA DE CV"/><cfdi:Receptor Rfc="${RECEPTOR}" Nombre="CLIENTE SA DE CV"/>
<cfdi:Conceptos><cfdi:Concepto ClaveProdServ="84111500" Cantidad="1" ClaveUnidad="E48" Descripcion="Servicio profesional" ValorUnitario="1000.00" Importe="1000.00"/></cfdi:Conceptos>
<cfdi:Impuestos TotalImpuestosTrasladados="160.00"><cfdi:Traslados><cfdi:Traslado Base="1000.00" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="160.00"/></cfdi:Traslados></cfdi:Impuestos>
<cfdi:Complemento><tfd:TimbreFiscalDigital xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital" Version="1.1" UUID="${UUID}" FechaTimbrado="2026-10-05T10:01:00" RfcProvCertif="SAT970701NN3" NoCertificadoSAT="00001000000504465028" SelloCFD="${SELLO}" SelloSAT="${SELLO}"/></cfdi:Complemento>
</cfdi:Comprobante>`;
const CFDI_SIN_TIMBRE = CFDI_XML.replace(/<cfdi:Complemento>[\s\S]*<\/cfdi:Complemento>/, '');
const RET_XML = `<?xml version="1.0" encoding="UTF-8"?>
<retenciones:Retenciones xmlns:retenciones="http://www.sat.gob.mx/esquemas/retencionpago/2" Version="2.0" FolioInt="RET-2026-011" FechaExp="2026-10-31T12:00:00">
<retenciones:Emisor RfcEmisor="${EMISOR}" NomEmisor="PAGADORA SA DE CV"/>
<retenciones:Receptor Nacionalidad="Nacional"><retenciones:Nacional RfcReceptor="${RECEPTOR}" NomReceptor="PROFESIONISTA SA DE CV"/></retenciones:Receptor>
<retenciones:Periodo MesIni="10" MesFin="10" Ejercicio="2026"/>
<retenciones:Totales MontoTotOperacion="10000.00" MontoTotGrav="10000.00" MontoTotExent="0.00" MontoTotRet="2600.00"/>
<retenciones:ImpRetenidos BaseRet="10000.00" Impuesto="001" MontoRet="1000.00" TipoPagoRet="04"/>
<retenciones:ImpRetenidos BaseRet="10000.00" Impuesto="002" MontoRet="1600.00" TipoPagoRet="04"/>
</retenciones:Retenciones>`;
const enc = texto => new TextEncoder().encode(texto);

/* PDF de juguete hecho a mano (xref calculado), con el total
   DISTINTO del XML ($1,260.00 frente a $1,160.00) y SIN línea de
   IVA: el comparador debe pintar solo el total como diferente y
   el IVA como «no consta». */
function pdfJuguete(lineas) {
  const esc = t => t.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const stream = 'BT /F1 12 Tf 72 720 Td ' + lineas.map((linea, i) =>
    (i ? '0 -22 Td ' : '') + '(' + esc(linea) + ') Tj').join(' ') + ' ET';
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Length ' + stream.length + ' >>\nstream\n' + stream + '\nendstream'];
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((body, i) => { offsets.push(pdf.length); pdf += (i + 1) + ' 0 obj\n' + body + '\nendobj\n'; });
  const xrefAt = pdf.length;
  pdf += 'xref\n0 ' + (objs.length + 1) + '\n0000000000 65535 f \n' +
    offsets.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('') +
    'trailer\n<< /Size ' + (objs.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + xrefAt + '\n%%EOF';
  return Buffer.from(pdf, 'latin1');
}
const PDF_LINEAS = [
  'EMISOR PAGADORA SA DE CV RFC ' + EMISOR,
  'RECEPTOR CLIENTE SA DE CV RFC ' + RECEPTOR,
  'SERIE A FOLIO 101',
  'FECHA DE EMISION 2026-10-05',
  'FOLIO FISCAL ' + UUID,
  'SUBTOTAL $1,000.00',
  'TOTAL $1,260.00'];
const pdfEmisor = pdfJuguete(PDF_LINEAS);

/* ===== (14) núcleo: clasificación, parser exacto, identidad ===== */
{
  assert.equal(clasificaDocumentoXml(enc(RET_XML), DOMParser), 'retenciones',
    '(14) la raíz Retenciones se clasifica como su propio tipo');
  assert.equal(clasificaDocumentoXml(enc(CFDI_XML), DOMParser), 'comprobante',
    '(14) un Comprobante normal sigue clasificándose como comprobante');
  assert.equal(clasificaDocumentoXml(enc('<otra/>'), DOMParser), 'otro',
    '(14) un XML ajeno no se clasifica ni como comprobante ni como retenciones');
  assert.throws(() => parseXml(enc(RET_XML), DOMParser), /No es un CFDI/,
    '(14) el importador de Comprobantes NO traga un Retenciones como si lo fuera');
  const row = parseXml(enc(CFDI_XML), DOMParser);
  assert.equal(row.id, UUID, '(14) el Comprobante normal sigue su camino intacto (parseXml)');
  assert.equal(row.total, '1160.00', '(14) el Comprobante normal conserva su total');

  const ret = parseRetenciones(enc(RET_XML), DOMParser);
  assert.equal(ret.clase, 'CFDI de retenciones', '(14) su clase lleva su nombre llano');
  assert.equal(ret.from.rfc, EMISOR, '(14) RFC del emisor (retenedor) exacto');
  assert.equal(ret.from.name, 'PAGADORA SA DE CV', '(14) nombre del emisor exacto');
  assert.equal(ret.to.rfc, RECEPTOR, '(14) RFC del receptor (contribuyente) exacto, leído del hijo Nacional del esquema 2.0');
  assert.equal(ret.to.name, 'PROFESIONISTA SA DE CV', '(14) nombre del receptor exacto');
  assert.equal(ret.folioInt, 'RET-2026-011', '(14) folio interno exacto');
  assert.equal(ret.fecha, '2026-10-31T12:00:00', '(14) fecha de expedición exacta');
  assert.deepEqual(ret.periodo, { mesIni: '10', mesFin: '10', ejercicio: '2026' }, '(14) periodo (mes/ejercicio) exacto');
  assert.equal(ret.totales.operacion, '10000.00', '(14) monto total de la operación exacto');
  assert.equal(ret.totales.retenido, '2600.00', '(14) total de retenciones exacto');
  assert.deepEqual(ret.detalle, [
    { base: '10000.00', impuesto: '001', monto: '1000.00', tipoPago: '04' },
    { base: '10000.00', impuesto: '002', monto: '1600.00', tipoPago: '04' }],
    '(14) el detalle por impuesto/base/importe es exacto');
  assert.equal(ret.identidad, EMISOR + '|RET-2026-011|2026|10|10|' + RECEPTOR,
    '(14) su identidad es folio + emisor + periodo + receptor: sin UUID inventado');

  const hash = sha256(enc(RET_XML));
  const docRow = retencionesDocRow(ret, hash, EMISOR, 'importacion');
  assert.equal(docRow.kind, 'CFDI de retenciones', '(14) la fila del expediente es de su tipo propio');
  assert.equal(docRow.xmlHash, hash, '(14) la fila guarda la huella del fichero');
  assert.equal(retencionesDocRow(ret, hash, EMISOR).id, docRow.id,
    '(14) el id es determinista: reimportar el mismo fichero da el mismo documento');
  assert.equal(retencionesEsDuplicada([docRow], ret, 'f'.repeat(64)), true,
    '(14) misma identidad con otra huella: duplicado');
  assert.equal(retencionesEsDuplicada([docRow], { ...ret, identidad: 'OTRA|IDENTIDAD' }, hash), true,
    '(14) misma huella con otra identidad: duplicado');
  assert.equal(retencionesEsDuplicada([docRow], { ...ret, identidad: 'OTRA|IDENTIDAD' }, 'e'.repeat(64)), false,
    '(14) identidad y huella distintas: no es duplicado');
  assert.equal(retencionesEsDuplicada([{ kind: 'Factura PDF', identidad: ret.identidad, xmlHash: hash }], ret, hash), false,
    '(14) un documento de otro tipo con la misma identidad NO cuenta como duplicado');

  /* Cruce: cuadra con los CFDI normales del mismo par y periodo… */
  const cfdiConRet = [{ from: { rfc: RECEPTOR }, to: { rfc: EMISOR }, date: '2026-10-15T09:00:00',
    fiscal: { withheld: [{ tax: '001', amount: '1000.00' }, { tax: '002', amount: '1600.00' }] } }];
  const cruce = cruceRetenciones(ret, cfdiConRet);
  assert.equal(cruce.estado, 'cuadra', '(14) el cruce cuadra cuando los CFDI normales declaran las mismas retenciones');
  assert.ok(cruce.detalle.every(fila => fila.estado === 'igual'), '(14) el cruce detalla impuesto a impuesto');
  const cruceSin = cruceRetenciones(ret, []);
  assert.equal(cruceSin.estado, 'sin-cruce', '(14) sin CFDI del periodo no hay cruce');
  assert.ok(cruceSin.mensaje.startsWith('Sin cruce posible con lo archivado'),
    '(14) sin datos, la ficha lo dice en vez de fingir un cruce');
  const cruceSinDesglose = cruceRetenciones(ret, [{ from: { rfc: RECEPTOR }, to: { rfc: EMISOR }, date: '2026-10-15T09:00:00', fiscal: null }]);
  assert.equal(cruceSinDesglose.estado, 'sin-cruce',
    '(14) con CFDI del periodo pero sin desglose guardado, tampoco hay cruce que afirmar');
  console.log('OK 2.4.0·WC3b (14) núcleo — clasificación, parser exacto, identidad/huella y cruce honesto.');
}

/* ===== (15) comparador con el extractor REAL de PDF ===== */
{
  const texto = await extractPdfTextLines(pdfEmisor);
  assert.ok(texto.includes('TOTAL'), '(15) el extractor real lee el PDF de juguete');
  const full = parseCfdiFull(enc(CFDI_XML), DOMParser);
  const campos = compararCfdiPdf(full, texto);
  const porCampo = Object.fromEntries(campos.map(c => [c.campo, c]));
  assert.equal(porCampo.Total.estado, 'diferente', '(15) el total distinto es DIFERENTE');
  assert.equal(porCampo.Total.xml, '1160.00', '(15) la diferencia enseña el total del XML');
  assert.equal(porCampo.Total.pdf, '1260.00', '(15) la diferencia enseña el total del PDF');
  assert.equal(porCampo.IVA.estado, 'no-consta', '(15) el IVA ausente en el PDF sale «no consta», nunca diferencia');
  for (const campo of ['UUID', 'Folio (serie-folio)', 'Fecha de emisión', 'RFC del emisor', 'RFC del receptor', 'Subtotal'])
    assert.equal(porCampo[campo].estado, 'igual', '(15) «' + campo + '» coincide y sale igual');
  assert.equal(campos.filter(c => c.estado === 'diferente').length, 1,
    '(15) SOLO el total sale diferente: ningún otro campo se contamina');
  console.log('OK 2.4.0·WC3b (15) núcleo — comparador con texto real de PDF: solo el total difiere; el IVA ausente no consta.');
}

/* ===== (20) integridad pura ===== */
{
  const raw = enc(CFDI_XML);
  const full = parseCfdiFull(raw, DOMParser);
  const huella = await sha256Hex(raw);
  assert.equal(huella, sha256(raw), '(20) la huella es el SHA-256 del fichero');
  const verde = integridadCfdi(full, { huellaRegistrada: huella, huellaActual: huella, estadoSat: 'Vigente', revisadoEl: '05/11/2026 10:00' });
  assert.equal(verde.nivel, 'verde', '(20) íntegro + huella coincidente + vigente ⇒ verde');
  assert.ok(verde.puntos.every(p => p.estado === 'ok'), '(20) en verde, los tres puntos salen bien');
  const cambiada = integridadCfdi(full, { huellaRegistrada: huella, huellaActual: 'f'.repeat(64), estadoSat: 'Vigente' });
  assert.equal(cambiada.nivel, 'rojo', '(20) huella cambiada ⇒ rojo');
  assert.equal(cambiada.puntos.find(p => p.nombre === 'Huella del fichero').estado, 'mal',
    '(20) el punto que falla es la huella, nombrado');
  const sinTimbre = integridadCfdi(parseCfdiFull(enc(CFDI_SIN_TIMBRE), DOMParser),
    { huellaRegistrada: huella, huellaActual: huella, estadoSat: 'Vigente' });
  assert.equal(sinTimbre.nivel, 'rojo', '(20) XML sin timbre ⇒ rojo');
  assert.equal(sinTimbre.puntos.find(p => p.nombre === 'Estructura completa').estado, 'mal',
    '(20) sin timbre falla la estructura, nombrada');
  const sinHuella = integridadCfdi(full, { huellaRegistrada: '', huellaActual: huella, estadoSat: 'Vigente' });
  assert.equal(sinHuella.nivel, 'ambar', '(20) sin huella de importación ⇒ ámbar, no verde');
  assert.ok(sinHuella.puntos.find(p => p.nombre === 'Huella del fichero').detalle.includes('Sin huella de importación: no consta'),
    '(20) los viejos salen «sin huella de importación: no consta»');
  const cancelado = integridadCfdi(full, { huellaRegistrada: huella, huellaActual: huella, estadoSat: 'Cancelado' });
  assert.equal(cancelado.nivel, 'rojo', '(20) cancelado en el SAT ⇒ rojo');
  for (const informe of [verde, cambiada, sinTimbre, sinHuella])
    assert.ok(informe.noVerificado.includes('NO se verifica') && informe.noVerificado.includes('certificado del emisor'),
      '(20) el texto de lo no verificable está presente: el sello del emisor no se finge verificado');
  console.log('OK 2.4.0·WC3b (20) núcleo — verde/rojo/ámbar honestos y lo no verificable, dicho.');
}

/* ===== Arnés de servidor (carpeta vigilada, paquetes, rutas) ===== */
const ORIGIN = 'https://pacosat.test';
const KEY = 'c'.repeat(64);
function makeHarness(extra = {}) {
  const clock = { t: Date.parse('2026-11-08T16:00:00Z') };
  const mails = [];
  const service = createPacoSATService({
    html: '<!--PACOSAT_TOKEN-->', origin: ORIGIN, proxyKey: KEY, now: () => clock.t,
    makeConnector: async () => ({ parser: class {}, connector: {
      request: async () => 'req-f', check: async () => ({ status: 'pending', packages: [] }),
      download: async () => { throw new Error('sin paquetes'); } } }),
    makeMailer: () => ({ verify: async () => true, sendMail: async mail => { mails.push(mail); return { messageId: 'm' }; } }),
    ...extra });
  let token = '';
  const raw = async (method, path, body, extraHeaders = {}) => {
    const chunks = []; if (body !== undefined) chunks.push(Buffer.from(JSON.stringify(body)));
    const req = Readable.from(chunks);
    req.method = method; req.url = path;
    req.headers = { host: 'pacosat.test', origin: ORIGIN, 'x-pacosat-proxy': KEY, ...extraHeaders };
    let status = 0; const headers = {}; let text = '';
    const res = { writeHead(c, hdrs) { status = c; if (hdrs) Object.assign(headers, hdrs); },
      setHeader(k, v) { headers[k] = v; }, getHeader(k) { return headers[k]; },
      end(chunk) { if (chunk) text += Buffer.isBuffer(chunk) ? chunk.toString('latin1') : chunk; } };
    await service.handle(req, res);
    return { status, text, headers };
  };
  const call = async (method, path, body) => {
    if (!token) { const home = await raw('GET', '/'); token = /[0-9a-f]{64}/.exec(home.text)?.[0] || ''; }
    const r = await raw(method, path, body, { 'x-pacosat-token': token });
    let json = null; try { json = JSON.parse(r.text); } catch { /* binario */ }
    return { status: r.status, json, text: r.text, headers: r.headers };
  };
  return { service, call, raw, mails, clock };
}
function zipMulti(entries) {
  const chunks = [], central = [];
  let offset = 0;
  for (const [name, payload] of entries) {
    const raw = Buffer.from(payload), nameBuf = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(nameBuf.length, 26);
    chunks.push(local, nameBuf, raw);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50); cen.writeUInt32LE(crc32(raw), 16);
    cen.writeUInt32LE(raw.length, 20); cen.writeUInt32LE(raw.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28); cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);
    offset += 30 + nameBuf.length + raw.length;
  }
  const cenBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cenBuf.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cenBuf, end]);
}

/* ===== (14)+(20) servidor: la carpeta vigilada clasifica ===== */
{
  const dir = mkdtempSync(join(tmpdir(), 'pacosat-wc3b-watch-'));
  const inbox = join(dir, 'vigilada'); mkdirSync(inbox);
  const h = makeHarness({ dbFile: ':memory:', watchDir: inbox, inboxParser: DOMParser, watchSettleMs: 0 });
  try {
    assert.equal((await h.call('POST', '/api/storage', { batch: { people: [{ id: EMISOR, name: 'Pagadora SA de CV' }] } })).status, 200);
    await h.service.bootstrap({ mail: { host: 'smtp.example.com', port: 587, from: 'from@example.com', recipient: 'to@example.com', user: '', password: '' } });
    writeFileSync(join(inbox, 'retenciones.xml'), RET_XML);
    writeFileSync(join(inbox, 'factura.xml'), CFDI_XML);
    await h.service.inboxTick(h.clock.t);
    const docs = (await h.call('GET', '/api/storage?store=documents')).json;
    const rets = docs.filter(d => d.kind === 'CFDI de retenciones');
    assert.equal(rets.length, 1, '(14) la carpeta vigilada archiva el Retenciones como documento de su tipo');
    assert.equal(rets[0].retenciones.detalle.length, 2, '(14) el documento guardado trae su detalle parseado');
    assert.equal(rets[0].retenciones.totales.retenido, '2600.00', '(14) el documento guardado trae sus totales');
    assert.equal(rets[0].xmlHash, sha256(enc(RET_XML)), '(14) el documento guarda la huella de su fichero');
    const invs = (await h.call('GET', '/api/storage?store=invoices')).json;
    assert.equal(invs.length, 1, '(14) el Comprobante del mismo lote entra como comprobante, sin mezclarse');
    assert.equal(invs[0].id, UUID, '(14) el comprobante es el del UUID esperado');
    assert.equal(invs[0].xmlHash, sha256(enc(CFDI_XML)), '(20) la importación del servidor registra la huella SHA-256 del XML');
    /* Reimportar el MISMO Retenciones: duplicado por identidad/huella. */
    writeFileSync(join(inbox, 'retenciones-otra-vez.xml'), RET_XML);
    await h.service.inboxTick(h.clock.t);
    const docs2 = (await h.call('GET', '/api/storage?store=documents')).json;
    assert.equal(docs2.filter(d => d.kind === 'CFDI de retenciones').length, 1,
      '(14) el mismo Retenciones no se duplica: identidad y huella mandan');
    assert.ok(existsSync(join(inbox, 'procesados', '2026-11-08', 'retenciones-otra-vez.xml')),
      '(14) el duplicado se aparta como procesado, no como error');
    console.log('OK 2.4.0·WC3b (14)(20) servidor — carpeta vigilada: clasifica, archiva el tipo propio, deduplica y registra huellas.');
  } finally { h.service.close(); }
}

/* ===== (14) servidor: un paquete del SAT con Retenciones ===== */
{
  /* El paquete es del RFC propio: en estos juguetes él es el
     receptor, como en una descarga de recibidos de verdad. */
  const RET_PROPIO = RET_XML.replaceAll(RECEPTOR, PROPIO);
  const CFDI_PROPIO = CFDI_XML.replaceAll(RECEPTOR, PROPIO);
  const paquete = zipMulti([['retenciones.xml', RET_PROPIO], ['factura.xml', CFDI_PROPIO]]);
  const h = makeHarness({ dbFile: ':memory:', makeConnector: async () => ({ parser: DOMParser, connector: {
    request: async () => 'req-1',
    check: async () => ({ status: 'finished', packages: ['req-1-pkg'] }),
    download: async () => paquete } }) });
  try {
    assert.equal((await h.call('POST', '/api/unlock', { rfc: PROPIO, minutes: 60, days: 7, direction: 'received',
      password: 'simulada', certificate: 'YQ==', key: 'Yg==' })).status, 200);
    await h.call('POST', '/api/monthly/config', { enabled: false, day: 5, hour: 9 });
    assert.equal((await h.call('POST', '/api/request', { rfc: PROPIO, direction: 'received',
      start: '2026-10-01', end: '2026-10-31', type: 'cfdi' })).status, 200);
    /* La encuesta al SAT madura a los 5 minutos: el reloj avanza. */
    for (let i = 0; i < 8; i++) { h.clock.t += 5 * 60000; await h.service.tick(); }
    const docs = (await h.call('GET', '/api/storage?store=documents')).json;
    const rets = docs.filter(d => d.kind === 'CFDI de retenciones');
    assert.equal(rets.length, 1, '(14) el paquete del SAT archiva el Retenciones como su tipo, no como comprobante');
    assert.equal(rets[0].rfc, PROPIO, '(14) el Retenciones del paquete queda en el expediente del RFC del paquete');
    const invs = (await h.call('GET', '/api/storage?store=invoices')).json;
    assert.equal(invs.length, 1, '(14) el Comprobante del paquete entra como comprobante');
    assert.equal(invs[0].xmlHash, sha256(enc(CFDI_PROPIO)), '(20) el paquete también registra la huella al importar');
    console.log('OK 2.4.0·WC3b (14) servidor — paquete del SAT: el Retenciones no se rechaza ni se archiva como Comprobante.');
  } finally { h.service.close(); }
}

/* ===== (15) servidor: la ruta del texto del PDF del emisor ===== */
{
  const h = makeHarness({ dbFile: ':memory:' });
  try {
    await h.call('POST', '/api/storage', { batch: { people: [{ id: EMISOR, name: 'Pagadora SA de CV' }] } });
    const docId = 'pdf:' + 'a'.repeat(8);
    const r = await h.call('POST', '/api/storage', { batch: {
      documents: [{ id: docId, rfc: EMISOR, kind: 'Factura PDF', date: '2026-10-05', period: '', name: 'factura-emisor.pdf', uuid: UUID }],
      files: [{ id: docId, mime: 'application/pdf', content: pdfEmisor.toString('base64') }] } });
    assert.equal(r.status, 200, '(15) la semilla del PDF del emisor entra por el almacén de siempre');
    const ok = await h.call('GET', '/api/cfdi/pdf-texto240?id=' + encodeURIComponent(docId));
    assert.equal(ok.status, 200, '(15) la ruta del texto responde');
    assert.equal(ok.json.estado, 'ok', '(15) el PDF trae texto legible');
    assert.ok(ok.json.texto.includes('1,260.00'), '(15) el texto servido es el del PDF archivado (su total distinto incluido)');
    const campos = compararCfdiPdf(parseCfdiFull(enc(CFDI_XML), DOMParser), ok.json.texto);
    assert.equal(campos.find(c => c.campo === 'Total').estado, 'diferente',
      '(15) con el texto servido por la ruta, el comparador pinta el total como diferente');
    assert.equal((await h.call('GET', '/api/cfdi/pdf-texto240?id=no-existe')).status, 404,
      '(15) un documento que no está en el expediente es 404, no un texto inventado');
    console.log('OK 2.4.0·WC3b (15) servidor — la ruta sirve el texto del PDF del emisor y solo el de ese documento.');
  } finally { h.service.close(); }
}

/* ===== Cliente: la ficha pinta integridad y comparador ===== */
const html = readFileSync(join(import.meta.dirname, 'Faro-Fiscal.html'), 'utf8');
class BootURL extends NodeURL {
  static createObjectURL() { return 'blob:prueba'; }
  static revokeObjectURL() {}
}
class FakeElement {
  constructor(tag = 'div') {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.dataset = {};
    this.style = {};
    this.attributes = {};
    this.textContent = '';
    this.innerHTML = '';
    this.value = '';
    this.hidden = false;
    this.disabled = false;
    this.open = false;
    this.files = [];
    const classes = new Set();
    this.classList = {
      add: (...names) => names.forEach(name => classes.add(name)),
      remove: (...names) => names.delete(name),
      toggle: (name, force) => {
        const on = force === undefined ? !classes.has(name) : Boolean(force);
        if (on) classes.add(name); else classes.delete(name);
        return on;
      },
      contains: name => classes.has(name)
    };
  }
  get childNodes() { return this.children; }
  append(...kids) { for (const kid of kids) if (kid instanceof FakeElement) this.children.push(kid); }
  prepend(...kids) { for (const kid of [...kids].reverse()) if (kid instanceof FakeElement) this.children.unshift(kid); }
  appendChild(kid) { if (kid instanceof FakeElement) this.children.push(kid); return kid; }
  insertBefore(kid) { if (kid instanceof FakeElement) this.children.push(kid); return kid; }
  removeChild(kid) { this.children = this.children.filter(child => child !== kid); return kid; }
  replaceWith(...kids) { this.children = kids.filter(kid => kid instanceof FakeElement); }
  before() {}
  after() {}
  insertAdjacentElement(_where, kid) { return kid; }
  insertAdjacentHTML() {}
  insertAdjacentText() {}
  cloneNode() { return new FakeElement(this.tagName); }
  replaceChildren(...kids) { this.children = kids.filter(kid => kid instanceof FakeElement); }
  remove() {}
  click() {}
  close() {}
  showModal() {}
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return name in this.attributes ? this.attributes[name] : null; }
  removeAttribute(name) { delete this.attributes[name]; }
  hasAttribute(name) { return name in this.attributes; }
  addEventListener() {}
  removeEventListener() {}
  querySelector() { return null; }
  querySelectorAll() { return []; }
  closest() { return null; }
  focus() {}
  blur() {}
  scrollIntoView() {}
  getBoundingClientRect() { return { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 }; }
}
const buscar = (el, pred, out = []) => { if (el && pred(el)) out.push(el); for (const h of el?.children || []) buscar(h, pred, out); return out; };
FakeElement.prototype.querySelector = function (sel) {
  if (!String(sel).startsWith('.')) return null;
  const clase = String(sel).slice(1);
  return buscar(this, e => String(e.className || '').split(' ').includes(clase)).find(e => e !== this) || null;
};
FakeElement.prototype.querySelectorAll = function (sel) {
  if (!String(sel).startsWith('.')) return [];
  const clase = String(sel).slice(1);
  return buscar(this, e => String(e.className || '').split(' ').includes(clase)).filter(e => e !== this);
};
const storageStub = () => {
  const map = new Map();
  return { getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: key => map.delete(key), clear: () => map.clear() };
};
function makeBootContext() {
  const byId = new Map();
  const metas = { 'meta[name="pacosat-token"]': { content: 'token-de-prueba' },
    'meta[name="pacosat-cloud"]': { content: '1' } };
  const documentStub = {
    getElementById: id => {
      if (!byId.has(id)) byId.set(id, new FakeElement('div'));
      return byId.get(id);
    },
    createElement: tag => new FakeElement(tag),
    createElementNS: (_ns, tag) => new FakeElement(tag),
    createTextNode: text => ({ textContent: String(text) }),
    querySelector: selector => metas[selector] ?? null,
    querySelectorAll: () => [],
    addEventListener: () => {},
    removeEventListener: () => {},
    documentElement: new FakeElement('html'),
    body: new FakeElement('body'),
    head: new FakeElement('head'),
    activeElement: null,
    title: ''
  };
  const fetchStub = async url => {
    const target = String(url);
    let body = {};
    if (target.includes('storage/rev')) body = { rev: 1 };
    else if (target.includes('storage?')) body = [];
    else if (target.includes('/api/status')) body = {
      settings: { installName: 'PacoSAT', hasLogo: false },
      buildModified: null, cloudRevision: null, profiles: [], jobs: [], inbox: [], mail: {} };
    return { ok: true, status: 200, headers: { get: () => 'application/json' },
      json: async () => body, text: async () => JSON.stringify(body), blob: async () => new Blob([]) };
  };
  const timer = (fn, ms, ...args) => { const t = setTimeout(fn, ms, ...args); t.unref?.(); return t; };
  const every = (fn, ms, ...args) => { const t = setInterval(fn, ms, ...args); t.unref?.(); return t; };
  const context = vm.createContext({
    console, document: documentStub,
    navigator: { onLine: true, userAgent: 'ronda240retenciones-test' },
    location: { href: 'http://127.0.0.1:43729/', search: '', reload: () => {} },
    localStorage: storageStub(), sessionStorage: storageStub(),
    fetch: fetchStub, setTimeout: timer, setInterval: every,
    DOMParser, Node: XmlNode,
    clearTimeout, clearInterval, queueMicrotask,
    URL: BootURL, URLSearchParams, Blob, File, TextEncoder, TextDecoder, btoa, atob,
    crypto: webcrypto, DecompressionStream,
    matchMedia: () => ({ matches: false, addEventListener: () => {}, addListener: () => {} }),
    Option: class extends FakeElement {},
    alert: () => {}, addEventListener: () => {}, removeEventListener: () => {},
    requestAnimationFrame: fn => timer(fn, 0)
  });
  context.window = context;
  context.self = context;
  return context;
}
const textoDe = el => {
  let texto = el.textContent || '';
  for (const hijo of el.children || []) texto += ' ' + textoDe(hijo);
  return texto;
};
async function bootCliente() {
  const context = makeBootContext();
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  vm.runInContext(script, context, { filename: 'Faro-Fiscal.html#script' });
  for (let i = 0; i < 12; i++) await new Promise(resolve => setTimeout(resolve, 0));
  return context;
}
const flush = async () => { for (let i = 0; i < 30; i++) await new Promise(r => setTimeout(r, 5)); };

{
  const ctx = await bootCliente();
  const xmlB64 = Buffer.from(CFDI_XML).toString('base64');
  const huellaReal = sha256(enc(CFDI_XML));
  const textoPdfPlano = PDF_LINEAS.join(' ');
  vm.runInContext(`
    scope = "${EMISOR}";
    people = [{ id: "${EMISOR}", name: "Pagadora SA de CV" }, { id: "${RECEPTOR}", name: "Cliente SA de CV" }];
    invoices = [{ id: "${UUID}", kind: "I", date: "2026-10-05T10:00:00", total: "1160.00", currency: "MXN",
      from: { rfc: "${EMISOR}", name: "PAGADORA SA DE CV" }, to: { rfc: "${RECEPTOR}", name: "CLIENTE SA DE CV" },
      concepts: [], xmlHash: "${huellaReal}",
      fiscal: { series: "A", folio: "101", subtotal: "1000.00", transferred: [{ tax: "002", amount: "160.00" }], withheld: [] } }];
    documents = [{ id: "pdf:emisor1", rfc: "${EMISOR}", kind: "Factura PDF", date: "2026-10-05", period: "", name: "factura-emisor.pdf", uuid: "${UUID}" }];
    activity = [];
    fiscalResults.set("${UUID}", { sat: { state: "Vigente" }, checked: Date.now() });
    satApi = async path => {
      const p = String(path);
      if (p.startsWith("storage?")) {
        const q = new URLSearchParams(p.slice(p.indexOf("?") + 1));
        if (q.get("store") === "files") return { id: q.get("id"), mime: "application/xml", content: "${xmlB64}" };
        return [];
      }
      if (p.startsWith("cfdi/pdf-texto240")) return { estado: "ok", texto: ${JSON.stringify(textoPdfPlano)} };
      if (p.startsWith("cfdi/notas")) return { notas: {} };
      if (p === "money") return { balances: [] };
      if (p.startsWith("invoice-history")) return { events: [] };
      if (p.startsWith("vida200h")) return { hitos: [] };
      return {};
    };
    render = () => {};
  `, ctx);
  vm.runInContext('invoiceDetail(invoices[0])', ctx);
  await flush();
  const fields = vm.runInContext("$('fields')", ctx);
  const textoFicha = textoDe(fields);
  const intBox = buscar(fields, e => e.dataset.integridad240)[0];
  assert.ok(intBox, '(20) la ficha pinta su semáforo de integridad');
  assert.equal(intBox.dataset.integridad240, 'verde',
    '(20) con huella registrada coincidente y vigente, la ficha pinta verde');
  assert.ok(textoFicha.includes('El sello criptográfico del emisor NO se verifica aquí'),
    '(20) la ficha dice en llano que el sello del emisor no se verifica y por qué');
  assert.ok(textoFicha.includes('Huella del fichero'), '(20) la ficha nombra el punto de la huella');

  const boton = buscar(fields, e => e.tagName === 'BUTTON' && (e.textContent || '').includes('Comparar con su PDF'))[0];
  assert.ok(boton, '(15) con el PDF del emisor archivado, la ficha ofrece «Comparar con su PDF»');
  await boton.onclick();
  await flush();
  const campos = buscar(fields, e => e.dataset.campo240);
  const porCampo = Object.fromEntries(campos.map(c => [c.dataset.campo240, c.dataset.estado240]));
  assert.equal(porCampo.Total, 'diferente', '(15) en la ficha, el total distinto sale DIFERENTE');
  assert.equal(porCampo.IVA, 'no-consta', '(15) en la ficha, el IVA ausente en el PDF sale «no consta»');
  assert.equal(porCampo.UUID, 'igual', '(15) en la ficha, el UUID coincidente sale igual');
  const lineaTotal = campos.find(c => c.dataset.campo240 === 'Total');
  assert.ok(textoDe(lineaTotal).includes('1160.00') && textoDe(lineaTotal).includes('1260.00'),
    '(15) la línea diferente enseña las dos cifras, la del XML y la del PDF');

  /* La misma ficha SIN huella registrada y sin revisar: ámbar. */
  vm.runInContext('invoices[0].xmlHash = ""; fiscalResults.clear(); invoiceDetail(invoices[0])', ctx);
  await flush();
  const fields2 = vm.runInContext("$('fields')", ctx);
  const intBox2 = buscar(fields2, e => e.dataset.integridad240)[0];
  assert.equal(intBox2.dataset.integridad240, 'ambar',
    '(20) sin huella de importación y sin revisar en el SAT, la ficha pinta ámbar');
  assert.ok(textoDe(fields2).includes('Sin huella de importación: no consta'),
    '(20) la ficha nombra la huella que no consta');

  /* Sin PDF del emisor: no se ofrece comparación falsa. */
  vm.runInContext('documents = []; invoiceDetail(invoices[0])', ctx);
  await flush();
  const fields3 = vm.runInContext("$('fields')", ctx);
  assert.ok(!buscar(fields3, e => e.tagName === 'BUTTON' && (e.textContent || '').includes('Comparar con su PDF')).length,
    '(15) sin PDF del emisor no hay botón de comparar');
  assert.ok(textoDe(fields3).includes('Sin PDF del emisor no hay comparación XML/PDF'),
    '(15) la ficha lo dice y explica que el PDF diseñado sale del mismo XML');

  /* La ficha del CFDI de retenciones, con su cruce. */
  const ret = parseRetenciones(enc(RET_XML), DOMParser);
  const docRet = retencionesDocRow(ret, sha256(enc(RET_XML)), EMISOR, 'importacion');
  vm.runInContext(`
    documents = ${JSON.stringify([docRet])};
    invoices = [{ id: "11111111-2222-4333-8444-555555555555", kind: "I", date: "2026-10-15T09:00:00", total: "12600.00", currency: "MXN",
      from: { rfc: "${RECEPTOR}", name: "PROFESIONISTA SA DE CV" }, to: { rfc: "${EMISOR}", name: "PAGADORA SA DE CV" },
      concepts: [], fiscal: { withheld: [{ tax: "001", amount: "1000.00" }, { tax: "002", amount: "1600.00" }], transferred: [] } }];
    retencionesDetail(documents[0]);
  `, ctx);
  await flush();
  const fields4 = vm.runInContext("$('fields')", ctx);
  const textoRet = textoDe(fields4);
  assert.ok(textoRet.includes('CFDI de retenciones'), '(14) la ficha del documento lo nombra por su tipo');
  assert.ok(textoRet.includes('RET-2026-011'), '(14) la ficha enseña su folio interno');
  assert.ok(textoRet.includes('$2600.00') || textoRet.includes('2600.00'), '(14) la ficha enseña su total retenido');
  const cruceEl = buscar(fields4, e => e.dataset.cruce240)[0];
  assert.equal(cruceEl.dataset.cruce240, 'cuadra', '(14) la ficha enseña el cruce y aquí cuadra');
  console.log('OK 2.4.0·WC3b cliente — ficha con semáforo (verde/ámbar), comparador pintado y ficha de retenciones con su cruce.');
}
console.log('OK suite ronda240retenciones completa');
