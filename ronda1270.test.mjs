/* Ronda 1.27.0 — el frente final: que las BAJADAS funcionen y
   que ningún fallo cierre en silencio. Se juzga:
   - C3 · «Descansar» PERSISTE de punta a punta: el botón manda
     «sin fecha» (año 2100), el servidor lo acepta y lo guarda,
     y el parte lo enseña activo; la fecha finita sigue
     validada (≤366 días) y cada petición queda registrada en
     el diario de accesos;
   - C1 · el diario de declaraciones y del buzón guarda LA
     PÁGINA del fallo: la corrida fallida deja captura y HTML
     y la evidencia se sirve por su ruta (fuera de la lista de
     lecturas del invitado, y dentro con su alcance por RFC);
   - C2 · el descubrimiento de folios (Consulta de
     transacciones, ficha 22513): el motor lee la tabla, el
     intérprete reconoce operación/fecha/tipo/ejercicio/
     periodo, y el servidor aprende los folios que no constan;
   - C2b · el aterrizaje nuevo del portal: tras el acceso, el
     trámite no está en la portada (aterriza en el Buzón) y el
     motor entra por el marco del trámite (SessionBroker);
   - D3 · el buzón con su plazo: buzonPlazo calcula límite
     (+3 días), tenida por notificada (+4) y efectos (siguiente
     hábil); el parte del buzón trae el plazo por notificación
     y la próxima tenida; el acceso del buzón entra por el
     lanzador que la corrida viva probó y luego va a la
     bandeja; su diario también guarda la página;
   - H-1.1/H-1.2 · el freno del login propio SOBREVIVE a un
     rearranque (vive en el estado, no en memoria) y cambiar
     la contraseña invalida las sesiones anteriores (huella);
   - H-3.1 · el reenvío automático marca cada comprobante AL
     ENVIARLO: si el correo muere a mitad de tanda, lo ya
     marcado no se reenvía al reintentar;
   - H-4.1 · el paquete de «generar todo» acotado por RFC: el
     ZIP de un contribuyente no lleva comprobantes del otro y
     su nombre lo dice;
   - H-4.2 · la lista del invitado cuenta SOLO su RFC;
   - B2/B3 · push: endpoint fuera de la lista de servicios
     reales se rechaza; la llave VAPID vive en su archivo 0600
     junto a la e.firma, no en un ajuste de la base;
   - C5 · la reconciliación del cierre mensual: 0 CFDI sin la
     prueba de la Metadata NO cierra «hecho» (la contradicción
     de octubre), con la prueba sí; si la Metadata conoce más
     que el expediente, «parcial»; la Metadata pendiente
     bloquea y la zombi muere a las 72 h; la reparación
     única baja los «hecho» dudosos heredados;
   - D2 · cancelación en proceso: la vigilancia la registra
     con su plazo (3 días), avisa UNA vez con la fecha y la
     da por resuelta cuando el SAT deja de decir «en
     proceso»; el vigente se revisa cada 6 h, no a diario;
   - A9 · gzip: la página viaja comprimida cuando el
     navegador lo pide y llega íntegra al descomprimir;
   - SEG · las cinco bajas de la pasada de seguridad de
     aceptación de la propia 1.27.0, corregidas antes de
     desplegar: H-4.1 el salto a «Notificados» con las
     exclusiones del rescate; H-3.1 el folio 22513
     normalizado y validado antes del registro; H-5.1 la
     reparación persiste el estado ANTES que su marca;
     H-6.1 «correos del mes» atribuido por la columna RFC
     del envío, no por el asunto; H-7.1 «Asignar dueño»
     exige forma válida y perfil existente. */
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { gunzipSync } from 'node:zlib';
import { generateKeyPairSync, randomBytes, scryptSync } from 'node:crypto';
import { DOMParser } from '@xmldom/xmldom';
import { createPacoSATService } from './local-server.mjs';
import { parseXml, parseCfdiFull, fiscalSummary } from './xml-core.mjs';
import { createMonitor } from './sat-monitor.mjs';
import { createSatDeclFetch, interpretTransaccionRow } from './sat-declaraciones.mjs';
import { createSatTribFetch, buzonPlazo, BUZON_LOGIN_URL, BUZON_ENTRY_URL,
  pickBuzonRescueLink, pickBuzonNotificadosLink } from './sat-tributario.mjs';
import { SatDocError } from './sat-doc-fetch.mjs';

const ORIGIN = 'https://pacosat.test';
const KEY = 'f'.repeat(64);
const OWN = 'AAA010101AAA';
const BBB = 'BBB010101BB1';
const DAY = 86400000;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

function makeHarness(options = {}) {
  const clock = { t: Date.parse('2026-11-11T15:00:00Z') };
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
  const callSinToken = async (method, path, body, extraHeaders = {}) => {
    const r = await raw(method, path, body, extraHeaders);
    let json = null; try { json = JSON.parse(r.text); } catch { /* binario */ }
    return { status: r.status, json, text: r.text, headers: r.headers };
  };
  return { service, call, callSinToken, raw, mails, clock };
}
const xmlCfdi = ({ uuid, fecha, emisor, receptor, total }) => {
  const sub = (Number(total) / 1.16).toFixed(2);
  const tax = (Number(total) - Number(sub)).toFixed(2);
  return `<?xml version="1.0" encoding="UTF-8"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital" Version="4.0" Fecha="${fecha}" SubTotal="${sub}" Moneda="MXN" Total="${total}" TipoDeComprobante="I" MetodoPago="PPD" FormaPago="99" LugarExpedicion="72000">
<cfdi:Emisor Rfc="${emisor}" Nombre="EMISOR SA" RegimenFiscal="601"/>
<cfdi:Receptor Rfc="${receptor}" Nombre="RECEPTOR SA" DomicilioFiscalReceptor="72000" RegimenFiscalReceptor="601" UsoCFDI="G03"/>
<cfdi:Conceptos><cfdi:Concepto ClaveProdServ="01010101" Cantidad="1" ClaveUnidad="H87" Descripcion="Servicio" ValorUnitario="${sub}" Importe="${sub}" ObjetoImp="02"><cfdi:Impuestos><cfdi:Traslados><cfdi:Traslado Base="${sub}" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="${tax}"/></cfdi:Traslados></cfdi:Impuestos></cfdi:Concepto></cfdi:Conceptos>
<cfdi:Impuestos TotalImpuestosTrasladados="${tax}"><cfdi:Traslados><cfdi:Traslado Base="${sub}" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="${tax}"/></cfdi:Traslados></cfdi:Impuestos>
<cfdi:Complemento><tfd:TimbreFiscalDigital Version="1.1" UUID="${uuid}" FechaTimbrado="${fecha}" RfcProvCertif="SAT970701NN3" SelloCFD="AAAA" NoCertificadoSAT="00001000000500000001" SelloSAT="BBBB"/></cfdi:Complemento>
</cfdi:Comprobante>`;
};
const seedInvoices = async (h, specs) => {
  const rows = specs.map(spec => {
    const buffer = Buffer.from(xmlCfdi(spec));
    const row = parseXml(buffer, DOMParser);
    row.fiscal = fiscalSummary(parseCfdiFull(buffer, DOMParser));
    return { row, xml: buffer };
  });
  const seed = await h.call('POST', '/api/storage', { batch: {
    people: [{ id: OWN, name: 'EMPRESA PROPIA SA' }, { id: BBB, name: 'PROVEEDOR SA' }],
    invoices: rows.map(r => r.row),
    files: rows.map(r => ({ id: 'xml:' + r.row.id, mime: 'application/xml',
      content: r.xml.toString('base64') })) } });
  assert.equal(seed.status, 200, JSON.stringify(seed.json));
  return rows.map(r => r.row);
};
const zipNames = buffer => {
  const names = [];
  let eocd = buffer.length - 22;
  while (eocd >= 0 && buffer.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  assert.ok(eocd >= 0, 'directorio central del ZIP');
  const count = buffer.readUInt16LE(eocd + 10);
  let p = buffer.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    const nameLen = buffer.readUInt16LE(p + 28), extraLen = buffer.readUInt16LE(p + 30), commentLen = buffer.readUInt16LE(p + 32);
    names.push(buffer.toString('utf8', p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return names;
};
/* El contenido de una entrada del ZIP «stored» del paquete
   (zipStoreBuffers no comprime: el dato va tal cual tras la
   cabecera local). */
const zipEntry = (buffer, name) => {
  let p = 0;
  while (p + 30 <= buffer.length && buffer.readUInt32LE(p) === 0x04034b50) {
    const size = buffer.readUInt32LE(p + 18);
    const nameLen = buffer.readUInt16LE(p + 26), extraLen = buffer.readUInt16LE(p + 28);
    const entryName = buffer.toString('utf8', p + 30, p + 30 + nameLen);
    const dataStart = p + 30 + nameLen + extraLen;
    if (entryName === name) return buffer.toString('utf8', dataStart, dataStart + size);
    p = dataStart + size;
  }
  return null;
};

/* ===== C3 · Descansar persiste de punta a punta ===== */
{
  const dir = mkdtempSync(join(tmpdir(), 'pacosat-1270-rest-'));
  const dbFile = join(dir, 'pacosat.sqlite');
  const h = makeHarness({ dbFile });
  /* El gesto real del cliente: «sin fecha» viaja como el año
     2100 — antes el servidor lo rechazaba (>366 días) y el
     botón moría en silencio sin guardar NADA. */
  const sinFecha = await h.call('POST', '/api/rest', { until: Date.UTC(2100, 0, 1) });
  assert.equal(sinFecha.status, 200, JSON.stringify(sinFecha.json));
  assert.equal(sinFecha.json.rest.active, true, 'el descanso sin fecha queda ACTIVO en la respuesta');
  const estado = await h.call('GET', '/api/status');
  assert.equal(estado.json.rest.active, true, 'y el parte lo confirma: descanso persistido');
  assert.equal(estado.json.rest.until, Date.UTC(2100, 0, 1));
  /* La fecha finita sigue su validación de siempre. */
  const finita = await h.call('POST', '/api/rest', { until: h.clock.t + 10 * DAY });
  assert.equal(finita.status, 200);
  assert.equal(finita.json.rest.until, h.clock.t + 10 * DAY);
  const abusiva = await h.call('POST', '/api/rest', { until: h.clock.t + 400 * DAY });
  assert.ok(abusiva.status >= 400, 'una fecha finita a más de un año se sigue rechazando');
  const fin = await h.call('POST', '/api/rest', { until: 0 });
  assert.equal(fin.json.rest.active, false, 'levantar el descanso también persiste');
  /* Cada petición quedó en el diario de accesos: si el botón
     «no hace nada», el diario dice si la petición llegó. */
  await h.service.close();
  const db = new DatabaseSync(dbFile);
  const rests = db.prepare("SELECT COUNT(*) AS n FROM access_log WHERE kind='rest'").get().n;
  assert.ok(rests >= 3, 'el diario de accesos registró las peticiones de descanso: ' + rests);
  db.close();
  rmSync(dir, { recursive: true, force: true });
  console.log('OK 1.27.0 · C3 — Descansar persiste: sin fecha aceptado y guardado, finita validada, diario con la petición.');
}

/* ===== C1+C2 · Declaraciones: página guardada y folios descubiertos ===== */
{
  /* El motor muere como en vivo (respuesta-inesperada) y trae
     su diagnóstico: la corrida lo guarda en el diario. */
  const fallo = async () => {
    const e = new SatDocError('respuesta-inesperada', 'Enlace del trámite — no encontrado (portal)');
    e.diag = { screenshot: PNG, html: '<html><body>portal-cambiado-1270</body></html>', url: 'https://wwwmat.sat.gob.mx/inicio' };
    throw e;
  };
  const h = makeHarness({ satDeclFetch: fallo });
  await h.call('POST', '/api/profiles/prepare', { rfc: OWN });
  const run = await h.call('POST', '/api/declaraciones/run', { rfc: OWN, tipo: 'mensual', ejercicio: 2026 });
  assert.equal(run.json.result.ok, false, 'la corrida falla como en vivo');
  const runs = await h.call('GET', '/api/declaraciones/runs?rfc=' + OWN);
  const ultima = runs.json.runs[0];
  assert.ok(ultima, 'la corrida consta en el diario');
  assert.equal(ultima.ok, false);
  assert.equal(ultima.hasShot, true, 'el diario guarda la CAPTURA del fallo');
  assert.equal(ultima.hasHtml, true, 'y la PÁGINA del fallo');
  const pagina = await h.call('GET', '/api/declaraciones/artifact?run=' + ultima.id + '&part=html');
  assert.equal(pagina.status, 200);
  assert.ok(pagina.text.includes('portal-cambiado-1270'), 'la evidencia servida es la página que el portal enseñó');
  const captura = await h.call('GET', '/api/declaraciones/artifact?run=' + ultima.id + '&part=shot');
  assert.equal(captura.status, 200);
  assert.match(String(captura.headers['content-type'] || ''), /image\/png/);
  /* La guarda: la evidencia NO está en la lista de lecturas
     del invitado — su puerta la rechaza entera (y dentro, la
     ruta además exige el alcance por RFC del diario). */
  await h.call('POST', '/api/guest/config', { password: 'clave-invitado-1', enabled: true, rfcs: [BBB] });
  const login = await h.call('POST', '/api/guest/login', { password: 'clave-invitado-1' });
  const ajena = await h.call('GET', '/api/declaraciones/artifact?run=' + ultima.id + '&part=html',
    undefined, { 'x-pacosat-token': login.json.token });
  assert.equal(ajena.status, 403, 'el invitado no llega a la evidencia: su puerta la cierra');
  await h.service.close();
  console.log('OK 1.27.0 · C1 — el diario de declaraciones guarda la página del fallo y la sirve con su guarda.');
}
{
  /* Descubrimiento 22513: el motor devuelve la tabla leída y
     el servidor aprende los folios que no constaban. */
  const motor = async (profile, query) => {
    if (query.tipo !== 'transacciones') throw new Error('consulta inesperada: ' + query.tipo);
    return { found: 2, transactions: [
      { operacion: '123456789012', fecha: '2026-10-17', tipo: 'mensual', ejercicio: 2026, periodo: '2026-09' },
      { operacion: '123456789013', fecha: '2026-09-16', tipo: 'mensual', ejercicio: 2026, periodo: '2026-08' }] };
  };
  const h = makeHarness({ satDeclFetch: motor });
  await h.call('POST', '/api/profiles/prepare', { rfc: OWN });
  const des = await h.call('POST', '/api/declaraciones/descubrir-folios', { rfc: OWN, ejercicio: 2026 });
  assert.equal(des.status, 200, JSON.stringify(des.json));
  assert.equal(des.json.result.ok, true);
  assert.equal(des.json.result.descubiertos, 2, 'los dos folios se aprenden');
  const vista = await h.call('GET', '/api/declaraciones?rfc=' + OWN + '&ejercicio=2026');
  const folios = (vista.json.folios || []).map(f => f.folio);
  assert.ok(folios.includes('123456789012') && folios.includes('123456789013'),
    'el registro de folios los enseña: ' + folios.join(', '));
  const aprendido = (vista.json.folios || []).find(f => f.folio === '123456789012');
  assert.match(aprendido.nota || '', /22513/, 'su nota dice de dónde salió: la Consulta de transacciones');
  const otra = await h.call('POST', '/api/declaraciones/descubrir-folios', { rfc: OWN, ejercicio: 2026 });
  assert.equal(otra.json.result.descubiertos, 0, 'descubrir dos veces no duplica');
  await h.service.close();
  console.log('OK 1.27.0 · C2 — descubrimiento 22513: folios aprendidos con su nota, sin duplicar.');
}

/* ===== Motores: intérprete 22513, aterrizaje Buzón y diagnóstico ===== */
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KEY_3DES = privateKey.export({ type: 'pkcs8', format: 'der', cipher: 'des-ede3-cbc', passphrase: 'buena-efirma' });
const CREDS = { rfc: 'MFI6212158B4', cer: Buffer.from('cer-juguete'), key: KEY_3DES, password: 'buena-efirma' };
const resolver = async () => CREDS;
{
  const fila = interpretTransaccionRow(['123456789012', '17/10/2026', 'Mensual', 'Septiembre', '2026']);
  assert.deepEqual(fila, { operacion: '123456789012', tipo: 'mensual', ejercicio: 2026, periodo: '2026-09', fechaPresentacion: '17/10/2026' });
  const provisional = interpretTransaccionRow(['123456789013', '17/10/2026', 'Provisional', 'Septiembre', '2026']);
  assert.equal(provisional.tipo, '', '«Provisional» no se traduce a mensual: lo que la tabla no nombra, no se inventa');
  assert.equal(provisional.periodo, '2026-09', 'pero su periodo sí se lee del mes nombrado');
  const anual = interpretTransaccionRow(['998877665544', '2026-03-28', 'Anual', '2025']);
  assert.equal(anual.tipo, 'anual');
  assert.equal(anual.ejercicio, 2025);
  assert.equal(interpretTransaccionRow(['sin', 'operación', 'válida']), null, 'una fila sin operación no es una transacción');
  console.log('OK 1.27.0 · C2 — el intérprete de la tabla 22513 reconoce operación, fecha, tipo, ejercicio y periodo.');
}
class DeclFakePage1270 {
  constructor(script = {}) {
    Object.assign(this, { rows: [], transaccionesFilas: [], links: [], marco: '', enMarco: false,
      pdfsByKey: {}, armedPdf: null, selects: {}, errorText: '' }, script);
    this.currentUrl = 'about:blank';
    this.visitas = [];
  }
  async goto(url) { this.currentUrl = url; this.visitas.push(url); if (url === this.marco) this.enMarco = true; }
  url() { return this.currentUrl; }
  async clickButtonFiel() {}
  async fillFielForm(form) { this.filled = form; }
  async submitFiel() { this.currentUrl = 'https://wwwmat.sat.gob.mx/inicio'; }
  async divError() { return this.errorText; }
  async clickText(text) {
    if (this.enMarco) return ['Declaraciones mensuales', 'Declaración anual', 'Consulta de transacciones'].includes(text);
    return this.links.includes(text);
  }
  async tramiteFrameUrl() { return this.marco || undefined; }
  async selectSelector(selector, value) { this.selects[selector] = value; }
  async clickSelector() {}
  async declResults() { return this.rows; }
  async transacciones() { return this.transaccionesFilas; }
  async clickDeclDownload(kind, index) {
    this.armedPdf = this.pdfsByKey[kind + ':' + index] || null;
    if (!this.armedPdf) throw new Error('sin descarga');
  }
  async waitForPdf() { return this.armedPdf; }
  async responses() { return []; }
  async diagnostics() { return { screenshot: PNG, html: '<html><body>diag-1270</body></html>', url: this.currentUrl }; }
  async close() {}
}
const driverOf = page => async () => ({ newPage: async () => page, close: async () => {} });
const pdfOf = label => Buffer.concat([Buffer.from('%PDF-1.4 ' + label + '\n'), Buffer.alloc(1024, 0x2e), Buffer.from('\n%%EOF')]);
{
  /* El portal aterriza en el Buzón (sin el enlace en la
     portada, como la corrida viva del 11 nov): el motor entra
     por el marco del trámite y baja igual. */
  const page = new DeclFakePage1270({
    marco: 'https://wwwmat.sat.gob.mx/applications/sessionbroker/SessionBroker?llave=prueba',
    rows: [{ operacion: 'OP-100', fecha: '2026-10-17', tipo: 'Provisional', periodo: '2026-09', acuse: true, declaracion: true }],
    pdfsByKey: { 'declaracion:0': pdfOf('decl-sep'), 'acuse:0': pdfOf('acuse-sep') } });
  const fetchDecl = createSatDeclFetch({ resolveCredentials: resolver, launchDriver: driverOf(page) });
  const result = await fetchDecl({ rfc: 'MFI6212158B4' }, { tipo: 'mensual', ejercicio: 2026 });
  assert.equal(result.documents.length, 2, 'por el marco del trámite la bajada llega');
  assert.ok(page.visitas.some(u => u.includes('sessionbroker')), 'el motor navegó al marco del trámite');
  console.log('OK 1.27.0 · C2b — aterrizaje en el Buzón: el motor entra por el marco del trámite (SessionBroker).');
}
{
  /* La consulta de transacciones por el motor entero. */
  const page = new DeclFakePage1270({
    links: ['Consulta de transacciones'],
    transaccionesFilas: [{ cells: ['123456789012', '17/10/2026', 'Provisional', 'Septiembre', '2026'] },
      { cells: ['998877665544', '2026-03-28', 'Anual', '2025'] }] });
  const fetchDecl = createSatDeclFetch({ resolveCredentials: resolver, launchDriver: driverOf(page) });
  const result = await fetchDecl({ rfc: 'MFI6212158B4' }, { tipo: 'transacciones', ejercicio: 2026 });
  assert.equal(result.found, 2);
  assert.equal(result.transactions[0].periodo, '2026-09');
  assert.equal(result.transactions[1].tipo, 'anual');
  console.log('OK 1.27.0 · C2 — la Consulta de transacciones devuelve las operaciones interpretadas.');
}
{
  /* Sin trámite ni marco: el error trae la página guardada. */
  const page = new DeclFakePage1270({ links: [] });
  const fetchDecl = createSatDeclFetch({ resolveCredentials: resolver, launchDriver: driverOf(page) });
  const error = await fetchDecl({ rfc: 'MFI6212158B4' }, { tipo: 'mensual', ejercicio: 2026 }).then(() => null, e => e);
  assert.ok(error instanceof SatDocError);
  assert.equal(error.code, 'respuesta-inesperada');
  assert.ok(error.diag && String(error.diag.html).includes('diag-1270'),
    'el motor adjunta el diagnóstico (captura + página) a su error');
  console.log('OK 1.27.0 · C1 — el motor de declaraciones adjunta la página del fallo a su error.');
}

/* ===== D3 · Buzón Tributario: plazo, lanzador y página guardada ===== */
{
  assert.deepEqual(buzonPlazo('2026-11-09'),
    { limite: '2026-11-12', tenida: '2026-11-13', efectos: '2026-11-16' },
    'lunes +3 = jueves límite, +4 = viernes tenida, efectos el siguiente hábil (lunes)');
  assert.deepEqual(buzonPlazo('2026-11-11'),
    { limite: '2026-11-14', tenida: '2026-11-15', efectos: '2026-11-16' },
    'tenida en domingo → efectos el lunes');
  assert.equal(buzonPlazo('no-es-fecha'), null);
  console.log('OK 1.27.0 · D3 — buzonPlazo: 3 días para abrir, al 4º tenida por notificada, efectos el siguiente hábil (arts. 134-I y 135 CFF).');
}
class TribFakePage1270 {
  constructor(script = {}) {
    Object.assign(this, { pendientes: [], abiertas: [], errorText: '', fielRoto: false }, script);
    this.currentUrl = 'about:blank';
    this.visitas = [];
  }
  async goto(url) { this.currentUrl = url; this.visitas.push(url); }
  url() { return this.currentUrl; }
  async clickButtonFiel() { if (this.fielRoto) throw new Error('la página no enseñó el acceso con e.firma'); }
  async fillFielForm(form) { this.filled = form; }
  async submitFiel() { this.currentUrl = 'https://wwwmat.sat.gob.mx/inicio'; }
  async divError() { return this.errorText; }
  async clickText() { return false; }
  async text() { return 'Buzón Tributario · Mis notificaciones · Asunto · No leídas'; }
  async evaluate(fn) {
    if (fn && fn.name === 'readLinksSource')
      return this.currentUrl.includes('notificados') ? [] :
        [{ text: 'Notificados', href: 'https://wwwmat.sat.gob.mx/buzon/notificados', inTable: false }];
    if (fn && fn.name === 'readTablesSource') {
      const filas = this.currentUrl.includes('notificados') ? this.abiertas : this.pendientes;
      return [{ headers: ['Fecha', 'Asunto', 'Remitente', 'Estado'],
        rows: filas.map(r => [r.fechaPortal, r.asunto, r.remitente, r.estado]) }];
    }
    return [];
  }
  async diagnostics() { return { screenshot: PNG, html: '<html><body>diag-trib-1270</body></html>', url: this.currentUrl }; }
  async close() {}
}
{
  const page = new TribFakePage1270({
    pendientes: [{ fechaPortal: '09/11/2026', asunto: 'Requerimiento de información', remitente: 'Auditoría', estado: 'No leída' }],
    abiertas: [{ fechaPortal: '21/10/2026', asunto: 'Invitación', remitente: 'Recaudación', estado: 'Leída' }] });
  const fetchTrib = createSatTribFetch({ resolveCredentials: resolver, launchDriver: driverOf(page) });
  const result = await fetchTrib({ rfc: 'MFI6212158B4' }, {});
  assert.equal(result.notifications.length, 2);
  assert.equal(result.notifications.find(n => n.asunto.includes('Requerimiento')).abierta, false,
    'la de «Pendientes» sale sin abrir');
  assert.equal(result.notifications.find(n => n.asunto.includes('Requerimiento')).fecha, '2026-11-09',
    'su fecha se normaliza desde el formato del portal');
  assert.equal(result.notifications.find(n => n.asunto.includes('Invitación')).abierta, true,
    'la de «Notificados» sale abierta');
  assert.equal(page.visitas[0], BUZON_LOGIN_URL,
    'el acceso entra por el lanzador de wwwmat (la puerta que la corrida viva del 11 nov probó)');
  assert.ok(page.visitas.includes(BUZON_ENTRY_URL), 'y después va a la bandeja de notificaciones');
  console.log('OK 1.27.0 · D3/C4 — el buzón accede por el lanzador probado en vivo y luego va a su bandeja.');
}
{
  const page = new TribFakePage1270({ fielRoto: true });
  const fetchTrib = createSatTribFetch({ resolveCredentials: resolver, launchDriver: driverOf(page) });
  const error = await fetchTrib({ rfc: 'MFI6212158B4' }, {}).then(() => null, e => e);
  assert.ok(error, 'el acceso roto es un error, no un silencio');
  assert.ok(error.diag && String(error.diag.html).includes('diag-trib-1270'),
    'el motor del buzón también adjunta la página del fallo');
  console.log('OK 1.27.0 · C1 — el motor del buzón adjunta la página del fallo a su error.');
}
{
  /* El parte del buzón trae el plazo por notificación y la
     próxima tenida; el aviso espejo nombra la fecha. */
  const dir = mkdtempSync(join(tmpdir(), 'pacosat-1270-trib-'));
  const dbFile = join(dir, 'pacosat.sqlite');
  const motor = async () => ({ notifications: [
    { fecha: '2026-11-09', asunto: 'Requerimiento de información', remitente: 'Auditoría', estado: 'No leída', abierta: false },
    { fecha: '2026-10-21', asunto: 'Invitación', remitente: 'Recaudación', estado: 'Leída', abierta: true }] });
  const h = makeHarness({ dbFile, satTribFetch: motor });
  await h.call('POST', '/api/profiles/prepare', { rfc: OWN });
  const run = await h.call('POST', '/api/tributario/run', { rfc: OWN });
  assert.equal(run.json.result.ok, true, JSON.stringify(run.json));
  const view = await h.call('GET', '/api/tributario?rfc=' + OWN);
  const sinAbrirN = view.json.notificaciones.find(n => !n.abierta);
  assert.equal(sinAbrirN.plazo.tenida, '2026-11-13', 'la sin abrir trae su fecha de tenida por notificada');
  assert.equal(view.json.proximaTenida.tenida, '2026-11-13', 'y el parte nombra la próxima');
  const abiertaN = view.json.notificaciones.find(n => n.abierta);
  assert.equal(abiertaN.plazo, null, 'la abierta no lleva plazo: ya corre por su acuse');
  await h.service.tick();
  const db = new DatabaseSync(dbFile);
  const aviso = db.prepare("SELECT titulo, detalle FROM avisos WHERE datos LIKE '%trib-sin-abrir%'").get();
  assert.ok(aviso, 'el aviso espejo del buzón nació');
  assert.ok(String(aviso.detalle || '').includes('se tiene por notificada el 13 de noviembre de 2026'),
    'el aviso NOMBRA la fecha en que se tiene por notificada: ' + String(aviso.detalle || '').slice(0, 120));
  db.close();
  await h.service.close();
  rmSync(dir, { recursive: true, force: true });
  console.log('OK 1.27.0 · D3 — el buzón enseña «se tiene por notificada el día X» en su parte y en su aviso.');
}
{
  /* El fallo del buzón también deja su página en el diario. */
  const fallo = async () => {
    const e = new Error('El portal no respondió como se esperaba en «Verificación de la bandeja».');
    e.code = 'respuesta-inesperada';
    e.diag = { screenshot: PNG, html: '<html><body>buzon-cambiado-1270</body></html>', url: 'https://wwwmat.sat.gob.mx/' };
    throw e;
  };
  const h = makeHarness({ satTribFetch: fallo });
  await h.call('POST', '/api/profiles/prepare', { rfc: OWN });
  const run = await h.call('POST', '/api/tributario/run', { rfc: OWN });
  assert.equal(run.json.result.ok, false);
  const view = await h.call('GET', '/api/tributario?rfc=' + OWN);
  const ultima = view.json.runs[0];
  assert.equal(ultima.hasShot, true, 'el diario del buzón guarda la captura del fallo');
  assert.equal(ultima.hasHtml, true, 'y su página');
  const pagina = await h.call('GET', '/api/tributario/artifact?run=' + ultima.id + '&part=html');
  assert.equal(pagina.status, 200);
  assert.ok(pagina.text.includes('buzon-cambiado-1270'));
  await h.service.close();
  console.log('OK 1.27.0 · C1 — el diario del buzón guarda la página de su fallo y la sirve.');
}

/* ===== H-1.1/H-1.2 · El freno del login sobrevive; la huella manda ===== */
{
  const dir = mkdtempSync(join(tmpdir(), 'pacosat-1270-admin-'));
  const dbFile = join(dir, 'pacosat.sqlite');
  const secreto = 'mi-clave-de-administrador';
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(secreto, salt, 32).toString('hex');
  const h1 = makeHarness({ dbFile });
  await h1.service.bootstrap({ admin: { hash, salt } });
  for (let i = 0; i < 5; i++)
    await h1.call('POST', '/api/admin/login', { password: 'incorrecta-' + i });
  await h1.service.close();
  /* Rearranque sobre la MISMA base: el bloqueo sigue puesto
     (antes vivía en memoria y un reinicio lo borraba). */
  const h2 = makeHarness({ dbFile });
  await h2.service.bootstrap({ admin: { hash, salt } });
  const bloqueado = await h2.call('POST', '/api/admin/login', { password: secreto });
  assert.equal(bloqueado.status, 429, 'tras el rearranque, el freno de intentos sigue activo');
  h2.clock.t += 61 * 1000;
  const bueno = await h2.call('POST', '/api/admin/login', { password: secreto });
  assert.equal(bueno.status, 200, 'pasado el bloqueo, la buena entra');
  const cookie = String(bueno.headers['Set-Cookie'] || '');
  const conSesion = await h2.callSinToken('GET', '/api/status', undefined, { cookie });
  assert.equal(conSesion.status, 200, 'la sesión autoriza');
  /* Cambiar la contraseña invalida las sesiones anteriores:
     llevan la huella de la credencial con la que nacieron. */
  const salt2 = randomBytes(16).toString('hex');
  const hash2 = scryptSync('otra-clave-nueva', salt2, 32).toString('hex');
  await h2.service.bootstrap({ admin: { hash: hash2, salt: salt2 } });
  const vieja = await h2.callSinToken('GET', '/api/status', undefined, { cookie });
  assert.ok(vieja.status >= 400, 'la sesión de la contraseña anterior ya no autoriza');
  const nuevo = await h2.call('POST', '/api/admin/login', { password: 'otra-clave-nueva' });
  assert.equal(nuevo.status, 200, 'la contraseña nueva entra');
  await h2.service.close();
  rmSync(dir, { recursive: true, force: true });
  console.log('OK 1.27.0 · H-1.1/H-1.2 — el freno persiste tras rearrancar y cambiar la contraseña mata las sesiones viejas.');
}

/* ===== H-3.1 · La marca del reenvío se guarda al enviar, no al final ===== */
{
  const dir = mkdtempSync(join(tmpdir(), 'pacosat-1270-fwd-'));
  const dbFile = join(dir, 'pacosat.sqlite');
  const U1 = 'A1A1A1A1-1111-4111-8111-111111111111';
  const U2 = 'A2A2A2A2-2222-4222-8222-222222222222';
  const U3 = 'A3A3A3A3-3333-4333-8333-333333333333';
  const marcasDurante = [];
  let enviosAuto = 0;
  const mailer = { verify: async () => true,
    sendMail: async mail => {
      if (mail.to === 'auto@test.mx') {
        enviosAuto++;
        /* En mitad de la tanda, otra conexión lee el estado:
           la marca del envío ANTERIOR ya debe estar guardada
           (con el código de la 1.26 solo se guardaba al final
           de toda la función). */
        const lector = new DatabaseSync(dbFile, { readOnly: true });
        const row = lector.prepare("SELECT value FROM automation_state WHERE key='forward-auto-log'").get();
        lector.close();
        marcasDurante.push(row ? Object.keys(JSON.parse(row.value)) : []);
      }
      return { messageId: 'm' + enviosAuto };
    } };
  const h = makeHarness({ dbFile, makeMailer: () => mailer });
  await h.call('POST', '/api/mail', { host: 'smtp.test', port: 465, security: 'ssl',
    from: 'avisos@pacosat.test', recipient: 'paco@test.mx', user: 'u', password: 'p' });
  await h.service.tick(); /* línea base */
  await seedInvoices(h, [
    { uuid: U1, fecha: '2026-11-05T10:00:00', emisor: BBB, receptor: OWN, total: '116.00' },
    { uuid: U2, fecha: '2026-11-06T10:00:00', emisor: BBB, receptor: OWN, total: '232.00' },
    { uuid: U3, fecha: '2026-11-07T10:00:00', emisor: BBB, receptor: OWN, total: '348.00' }]);
  await h.call('POST', '/api/buzon/forward-config', { rfc: OWN, autoTo: 'auto@test.mx' });
  const db = new DatabaseSync(dbFile);
  const info = db.prepare('INSERT INTO news_notices(kind,opkey,rfc,direction,label,recipient,due) VALUES (?,?,?,?,?,?,?)')
    .run('sat', 'sat:1270:fwd', OWN, 'received', 'descarga de prueba', '', h.clock.t - 1000);
  for (const [uuid, total] of [[U1, '116.00'], [U2, '232.00'], [U3, '348.00']])
    db.prepare('INSERT INTO news_items(notice,uuid,fecha,counterpartName,counterpartRfc,folio,total,estado,kind,direction) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(Number(info.lastInsertRowid), uuid, '2026-11-07', 'PROVEEDOR SA', BBB, 'F-1', total, 'vigente', 'I', 'received');
  db.close();
  await h.service.tick();
  assert.equal(enviosAuto, 3, 'la regla reenvió los tres comprobantes');
  assert.ok(marcasDurante[1]?.includes(U1),
    'durante el 2º envío, la marca del 1º YA estaba persistida: ' + JSON.stringify(marcasDurante));
  assert.ok(marcasDurante[2]?.includes(U1) && marcasDurante[2]?.includes(U2),
    'durante el 3º, las de los dos anteriores');
  await h.service.close();
  rmSync(dir, { recursive: true, force: true });
  console.log('OK 1.27.0 · H-3.1 — cada reenvío automático deja su marca guardada al momento de enviarse.');
}

/* ===== H-4.1 · El paquete de «generar todo» acotado por RFC ===== */
{
  const h = makeHarness({ dbFile: ':memory:' });
  const U1 = 'B1B1B1B1-1111-4111-8111-111111111111';
  const U2 = 'B2B2B2B2-2222-4222-8222-222222222222';
  await seedInvoices(h, [
    { uuid: U1, fecha: '2026-10-05T10:00:00', emisor: BBB, receptor: OWN, total: '1160.00' },
    { uuid: U2, fecha: '2026-10-06T10:00:00', emisor: BBB, receptor: 'CCC010101CC1', total: '2320.00' }]);
  await h.call('POST', '/api/profiles/prepare', { rfc: OWN });
  const todo = await h.call('POST', '/api/reports/generate-all', { month: '2026-10', rfc: OWN });
  assert.equal(todo.status, 200, JSON.stringify(todo.json));
  const paso = (todo.json.pasos || []).find(s => s.id === 'paquete');
  assert.ok(paso?.ok, 'el paso del paquete salió: ' + JSON.stringify(todo.json.pasos?.map(p => p.id + ':' + p.ok)));
  assert.ok(String(paso.name).includes(OWN), 'el nombre del paquete lleva el RFC del alcance: ' + paso.name);
  const nombres = zipNames(Buffer.from(paso.content, 'base64'));
  assert.ok(nombres.some(n => n.includes(U1)), 'el paquete trae el comprobante del RFC pedido');
  assert.ok(!nombres.some(n => n.includes(U2)), 'y NO trae el del otro contribuyente: ' + nombres.join(' | '));
  await h.service.close();
  console.log('OK 1.27.0 · H-4.1 — «generar todo» con RFC: el paquete solo lleva lo de ese contribuyente.');
}

/* ===== H-4.2 · La lista del invitado cuenta solo su RFC ===== */
{
  const h = makeHarness();
  const U1 = 'C1C1C1C1-1111-4111-8111-111111111111';
  const U2 = 'C2C2C2C2-2222-4222-8222-222222222222';
  await seedInvoices(h, [
    { uuid: U1, fecha: '2026-11-05T10:00:00', emisor: BBB, receptor: OWN, total: '1160.00' },
    { uuid: U2, fecha: '2026-11-06T10:00:00', emisor: OWN, receptor: BBB, total: '2320.00' }]);
  const cfdiDe = vista => vista.items.find(i => i.id === 'cfdi');
  const completa = await h.call('GET', '/api/reports/checklist?month=2026-11');
  assert.match(cfdiDe(completa.json).detail, /^2 comprobantes/, 'sin alcance, la lista cuenta toda la instalación');
  await h.call('POST', '/api/guest/config', { password: 'clave-invitado-1', enabled: true, rfcs: [OWN] });
  const login = await h.call('POST', '/api/guest/login', { password: 'clave-invitado-1' });
  const delInvitado = await h.call('GET', '/api/reports/checklist?month=2026-11', undefined,
    { 'x-pacosat-token': login.json.token });
  assert.equal(delInvitado.status, 200, 'la contadora lee su lista');
  assert.deepEqual(delInvitado.json.scope, [OWN], 'la lista declara su alcance');
  assert.match(cfdiDe(delInvitado.json).detail, /^2 comprobantes/,
    'con alcance OWN cuentan sus dos (la recibida y la emitida)');
  /* Con el alcance en un RFC que no es parte de NINGÚN
     comprobante del mes, la lista cuenta cero: no se filtra
     ni un conteo del otro contribuyente. */
  await h.call('POST', '/api/guest/config', { password: 'clave-invitado-1', enabled: true, rfcs: ['CCC010101CC1'] });
  const login2 = await h.call('POST', '/api/guest/login', { password: 'clave-invitado-1' });
  const deCcc = await h.call('GET', '/api/reports/checklist?month=2026-11', undefined,
    { 'x-pacosat-token': login2.json.token });
  assert.match(cfdiDe(deCcc.json).detail, /^Aún no hay comprobantes/,
    'con un alcance ajeno a los dos comprobantes, la lista cuenta cero');
  await h.service.close();
  console.log('OK 1.27.0 · H-4.2 — la lista del mes del invitado cuenta solo lo de su RFC.');
}

/* ===== B2/B3 · Push: lista de servicios y llave VAPID en su archivo ===== */
{
  const dir = mkdtempSync(join(tmpdir(), 'pacosat-1270-push-'));
  const dbFile = join(dir, 'pacosat.sqlite');
  const h = makeHarness({ dbFile });
  const keys = { p256dh: 'B' + 'x'.repeat(60), auth: 'a'.repeat(16) };
  const malo = await h.call('POST', '/api/push/subscribe',
    { endpoint: 'https://servidor-cualquiera.example.com/push/123', keys });
  assert.ok(malo.status >= 400, 'un endpoint que no es de FCM/Apple/Microsoft/Mozilla se rechaza');
  assert.match(malo.json.error, /no es de un servicio de notificaciones/);
  const bueno = await h.call('POST', '/api/push/subscribe',
    { endpoint: 'https://fcm.googleapis.com/fcm/send/abc123', keys });
  assert.equal(bueno.status, 200, 'el de FCM entra');
  const vapid = await h.call('GET', '/api/push/vapid');
  assert.ok(vapid.json.key, 'la clave pública se sirve (y al nacer, la privada se archiva)');
  /* La llave VAPID nació en su archivo 0600 junto a la e.firma
     y el ajuste heredado de la base quedó limpio. */
  const vapidFile = join(dir, 'efirma', 'vapid.json');
  assert.ok(existsSync(vapidFile), 'la llave VAPID vive en efirma/vapid.json');
  const modo = statSync(vapidFile).mode & 0o777;
  assert.equal(modo, 0o600, 'con permisos 0600: ' + modo.toString(8));
  const guardadas = JSON.parse(readFileSync(vapidFile, 'utf8'));
  assert.ok(guardadas.publicKey && guardadas.privateKey, 'el par completo, fuera de la base');
  const db = new DatabaseSync(dbFile);
  assert.equal(db.prepare("SELECT value FROM automation_state WHERE key='push-vapid'").get(), undefined,
    'el ajuste «push-vapid» de la base ya no guarda la llave');
  db.close();
  await h.service.close();
  rmSync(dir, { recursive: true, force: true });
  console.log('OK 1.27.0 · B2/B3 — push con lista de servicios reales y la llave VAPID en su archivo 0600.');
}

/* ===== C5 · La reconciliación del cierre mensual ===== */
const seedMonthlyService = async (perRfcEntry, extra) => {
  const dir = mkdtempSync(join(tmpdir(), 'pacosat-1270-mes-'));
  const dbFile = join(dir, 'pacosat.sqlite');
  const t0 = Date.parse('2026-09-03T15:00:00Z');
  const h = makeHarness({ dbFile, now: () => t0 });
  await h.service.close();
  const db = new DatabaseSync(dbFile);
  db.prepare('INSERT INTO profiles(rfc,minutes,days,direction,nextRun,error) VALUES (?,?,?,?,0,?)')
    .run(OWN, 60, 30, 'both', '');
  if (extra) extra(db, t0);
  db.prepare("INSERT INTO automation_state(key, value) VALUES ('monthly-download-state', ?)")
    .run(JSON.stringify({ runs: { '2026-08': { month: '2026-08', startedAt: t0 - 3600000, finishedAt: 0,
      status: 'en-curso', automatic: true, perRfc: { [OWN]: perRfcEntry }, totals: { found: 0, added: 0, duplicates: 0, gaps: 0 } } } }));
  db.close();
  const h2 = makeHarness({ dbFile, now: () => t0 });
  return { h: h2, dir, dbFile, t0 };
};
const monthlyEntryOf = async (h) => {
  const view = await h.call('GET', '/api/monthly');
  return (view.json.runs || []).find(r => r.month === '2026-08');
};
const seedCfdiJobsAgosto = (db, t0) => {
  /* Los trabajos de CFDI del mes, terminados y cubriendo la
     ventana entera en los dos sentidos: sin huecos — la forma
     exacta de octubre (la descarga «terminó» y aun así el mes
     no constaba). */
  for (const [id, direction] of [[10, 'received'], [11, 'issued']])
    db.prepare("INSERT INTO jobs(id,rfc,direction,kind,periodStart,periodEnd,startAt,endAt,requestId,status,due,created,held) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, OWN, direction, 'cfdi', '2026-08-01', '2026-08-31', '2026-08-01 00:00:00', '2026-08-31 23:59:59', 'req-' + id, 'finished', 0, t0 - 7200000, 0);
};
{
  /* La contradicción de octubre: 0 CFDI y NINGUNA prueba de
     la Metadata → el mes NO cierra «hecho»: «parcial» con su
     motivo y su aviso. */
  const { h, dir } = await seedMonthlyService(
    { status: 'en-curso', jobs: [10, 11], metaJobs: [], found: 0, added: 0, duplicates: 0, gaps: 0 },
    seedCfdiJobsAgosto);
  await h.service.tick();
  const run = await monthlyEntryOf(h);
  assert.equal(run.perRfc[OWN].status, 'parcial', 'sin la prueba de la Metadata, cero no es «hecho»: ' + JSON.stringify(run.perRfc[OWN]));
  assert.match(run.perRfc[OWN].dudosa || '', /Metadata/, 'el motivo queda escrito en la corrida');
  await h.service.tick(); /* el aviso espejo nace en la pasada de avisos */
  const avisos = await h.call('GET', '/api/notices');
  assert.ok(avisos.json.avisos.some(a => /no cuadra/.test(a.titulo || '')),
    'el fallo GRITA: nace el aviso «la descarga no cuadra»: ' +
    avisos.json.avisos.map(a => a.titulo).join(' | '));
  await h.service.close();
  rmSync(dir, { recursive: true, force: true });
  console.log('OK 1.27.0 · C5a — 0 CFDI sin prueba de Metadata: «parcial» con motivo, nunca «hecho» en silencio.');
}
{
  /* Con la Metadata terminada que vio el mes vacío: «hecha». */
  const { h, dir } = await seedMonthlyService(
    { status: 'en-curso', jobs: [10, 11], metaJobs: [1], found: 0, added: 0, duplicates: 0, gaps: 0 },
    (db, t0) => {
      seedCfdiJobsAgosto(db, t0);
      db.prepare("INSERT INTO jobs(id,rfc,direction,kind,periodStart,periodEnd,startAt,endAt,requestId,status,due,created,held) VALUES (1,?,?,?,?,?,?,?,?,?,?,?,0)")
        .run(OWN, 'received', 'metadata', '2026-08-01', '2026-08-31', '2026-08-01', '2026-08-31', 'req-meta', 'finished', 0, t0 - 7200000);
    });
  await h.service.tick();
  const run = await monthlyEntryOf(h);
  assert.equal(run.perRfc[OWN].status, 'hecha', 'con la Metadata terminada en cero, el mes sí consta vacío');
  await h.service.close();
  rmSync(dir, { recursive: true, force: true });
  console.log('OK 1.27.0 · C5b — con la prueba de la Metadata terminada, el mes en cero cierra «hecha».');
}
{
  /* La Metadata conoce 1 y el expediente 0: «parcial». */
  const { h, dir } = await seedMonthlyService(
    { status: 'en-curso', jobs: [10, 11], metaJobs: [1], found: 0, added: 0, duplicates: 0, gaps: 0 },
    (db, t0) => {
      seedCfdiJobsAgosto(db, t0);
      db.prepare("INSERT INTO jobs(id,rfc,direction,kind,periodStart,periodEnd,startAt,endAt,requestId,status,due,created,held) VALUES (1,?,?,?,?,?,?,?,?,?,?,?,0)")
        .run(OWN, 'received', 'metadata', '2026-08-01', '2026-08-31', '2026-08-01', '2026-08-31', 'req-meta', 'finished', 0, t0 - 7200000);
      db.prepare("INSERT INTO metadata_records(uuid,rfc,direction,emitter,receiver,issuedAt,total,status,seenAt) VALUES (?,?,?,?,?,?,?,?,?)")
        .run('D1D1D1D1-1111-4111-8111-111111111111', OWN, 'received', BBB, OWN, '2026-08-15T10:00:00', '116.00', 'Vigente', t0);
    });
  await h.service.tick();
  const run = await monthlyEntryOf(h);
  assert.equal(run.perRfc[OWN].status, 'parcial');
  assert.match(run.perRfc[OWN].dudosa || '', /conoce 1 CFDI/, 'el motivo dice la diferencia exacta');
  await h.service.close();
  rmSync(dir, { recursive: true, force: true });
  console.log('OK 1.27.0 · C5c — la Metadata conoce más que el expediente: «parcial» con la diferencia escrita.');
}
{
  /* La Metadata pendiente bloquea el cierre; a las 72 h muere
     como zombi y el mes cierra (parcial: murió sin probar). */
  const dir = mkdtempSync(join(tmpdir(), 'pacosat-1270-mes-'));
  const dbFile = join(dir, 'pacosat.sqlite');
  const t0 = Date.parse('2026-09-03T15:00:00Z');
  const h0 = makeHarness({ dbFile, now: () => t0 });
  await h0.service.close();
  const db = new DatabaseSync(dbFile);
  db.prepare('INSERT INTO profiles(rfc,minutes,days,direction,nextRun,error) VALUES (?,?,?,?,0,?)').run(OWN, 60, 30, 'both', '');
  db.prepare("INSERT INTO jobs(id,rfc,direction,kind,periodStart,periodEnd,startAt,endAt,requestId,status,due,created,held) VALUES (1,?,?,?,?,?,?,?,?,?,?,?,0)")
    .run(OWN, 'received', 'metadata', '2026-08-01', '2026-08-31', '2026-08-01', '2026-08-31', 'req-meta', 'pending', t0 + DAY, t0 - 3600000);
  db.prepare("INSERT INTO automation_state(key, value) VALUES ('monthly-download-state', ?)")
    .run(JSON.stringify({ runs: { '2026-08': { month: '2026-08', startedAt: t0 - 3600000, finishedAt: 0,
      status: 'en-curso', automatic: true,
      perRfc: { [OWN]: { status: 'en-curso', jobs: [], metaJobs: [1], found: 0, added: 0, duplicates: 0, gaps: 0 } },
      totals: { found: 0, added: 0, duplicates: 0, gaps: 0 } } } }));
  db.close();
  let t = t0;
  const h = makeHarness({ dbFile, now: () => t });
  await h.service.tick();
  let run = await monthlyEntryOf(h);
  assert.equal(run.status, 'en-curso', 'con la Metadata pendiente, el mes espera');
  t += 73 * 3600000;
  await h.service.tick();
  run = await monthlyEntryOf(h);
  assert.notEqual(run.status, 'en-curso', 'a las 72 h la Metadata zombi muere y el mes se libera');
  assert.equal(run.perRfc[OWN].status, 'parcial', 'y cierra parcial: la zombi no es prueba de mes vacío');
  await h.service.close();
  rmSync(dir, { recursive: true, force: true });
  console.log('OK 1.27.0 · C5d — Metadata pendiente bloquea; zombi a las 72 h; el mes cierra parcial, no hecho.');
}
{
  /* La reparación única: un «hecha» heredado con 0 CFDI y sin
     método CIEC baja a «parcial» en la primera pasada. */
  const dir = mkdtempSync(join(tmpdir(), 'pacosat-1270-mes-'));
  const dbFile = join(dir, 'pacosat.sqlite');
  const t0 = Date.parse('2026-11-11T15:00:00Z');
  const h0 = makeHarness({ dbFile, now: () => t0 });
  await h0.service.close();
  const db = new DatabaseSync(dbFile);
  db.prepare('INSERT INTO profiles(rfc,minutes,days,direction,nextRun,error) VALUES (?,?,?,?,0,?)').run(OWN, 60, 30, 'both', '');
  db.prepare("INSERT INTO automation_state(key, value) VALUES ('monthly-download-state', ?)")
    .run(JSON.stringify({ runs: { '2026-10': { month: '2026-10', startedAt: t0 - 9 * DAY, finishedAt: t0 - 8 * DAY,
      status: 'hecha', automatic: true,
      perRfc: { [OWN]: { status: 'hecha', method: 'sat', jobs: [], metaJobs: [], found: 0, added: 0, duplicates: 0, gaps: 0 } },
      totals: { found: 0, added: 0, duplicates: 0, gaps: 0 } } } }));
  db.close();
  const h = makeHarness({ dbFile, now: () => t0 });
  await h.service.tick();
  const view = await h.call('GET', '/api/monthly');
  const run = (view.json.runs || []).find(r => r.month === '2026-10');
  assert.equal(run.perRfc[OWN].status, 'parcial',
    'el «hecho» heredado sin prueba baja a parcial (la forma exacta de la contradicción de octubre)');
  assert.match(run.perRfc[OWN].dudosa || '', /Reparación 1\.27\.0/);
  await h.service.close();
  rmSync(dir, { recursive: true, force: true });
  console.log('OK 1.27.0 · C5e — la reparación única corrige los «hecho» dudosos heredados.');
}

/* ===== D2 · Cancelación en proceso: plazo, un aviso, resolución ===== */
{
  const db = new DatabaseSync(':memory:');
  let t = Date.parse('2026-11-11T15:00:00Z');
  let cancelState = 'En proceso de cancelación';
  const avisosPendientes = [];
  const monitor = createMonitor(db, { now: () => t,
    refreshEfos: async () => new Map(),
    checkSat: async () => ({ state: 'Vigente', code: 'S', efos: '', cancellation: cancelState }),
    notifyCancellation: async () => true,
    notifyEfos: async () => true,
    notifyCancelPending: async (item, pending) => { avisosPendientes.push({ item, pending }); return true; } });
  const cfdi = { id: 'E1E1E1E1-1111-4111-8111-111111111111', emitter: BBB, receiver: OWN, total: '116.00', seal: '+/abcd==' };
  monitor.register(cfdi);
  await monitor.tick();
  const pendientes = monitor.pendingCancellations();
  assert.equal(pendientes.length, 1, 'la cancelación en proceso queda registrada');
  assert.equal(pendientes[0].due, pendientes[0].firstSeen + 3 * DAY, 'con su plazo: 3 días desde que se vio');
  assert.equal(avisosPendientes.length, 1, 'y avisa una vez, con la fecha límite');
  assert.equal(avisosPendientes[0].pending.due, pendientes[0].due);
  const fila = db.prepare('SELECT next FROM cfdi_watch WHERE id=?').get(cfdi.id);
  assert.ok(Math.abs(fila.next - (t + 6 * 3600000)) < 60000,
    'el vigente se revisa a las 6 h, no al día siguiente: ' + new Date(fila.next).toISOString());
  t += 6 * 3600000 + 1000;
  await monitor.tick();
  assert.equal(avisosPendientes.length, 1, 'la segunda vuelta no repite el aviso');
  cancelState = '';
  t += 6 * 3600000 + 1000;
  await monitor.tick();
  assert.equal(monitor.pendingCancellations().length, 0,
    'cuando el SAT deja de decir «en proceso», la pendiente se resuelve');
  console.log('OK 1.27.0 · D2 — cancelación en proceso: registrada con su plazo, un aviso, resuelta al concluir.');
}

/* ===== A9 · gzip de punta a punta ===== */
{
  const htmlGrande = '<html><head><!--PACOSAT_TOKEN--></head><body>' + 'contenido de la página '.repeat(200) + '</body></html>';
  const h = makeHarness({ html: htmlGrande });
  const conGzip = await h.raw('GET', '/', undefined, { 'accept-encoding': 'gzip' });
  assert.equal(conGzip.headers['Content-Encoding'], 'gzip', 'pidiendo gzip, la página viaja comprimida');
  const sinGzip = await h.raw('GET', '/');
  assert.notEqual(sinGzip.headers['Content-Encoding'], 'gzip', 'sin pedirlo, viaja tal cual');
  assert.equal(gunzipSync(Buffer.from(conGzip.text, 'latin1')).toString(), sinGzip.text,
    'al descomprimir, la página es EXACTAMENTE la misma que viaja sin comprimir');
  await h.service.close();
  console.log('OK 1.27.0 · A9 — gzip verificado contra la página servida de verdad.');
}

/* ===== SEG · Las cinco bajas de la pasada de aceptación ===== */
{
  /* H-4.1 · el salto a «Notificados» pasa por las exclusiones
     del rescate (H-2.1): un enlace de detalle que nombre la
     bandeja NUNCA se navega — cargar el detalle de una
     notificación es, a los ojos del SAT, abrirla. */
  const detalleEnTabla = { text: 'Actos notificados de octubre',
    href: 'https://wwwmat.sat.gob.mx/buzon/detalle/12345678', inTable: true };
  const detalleConId = { text: 'Ver notificados',
    href: 'https://wwwmat.sat.gob.mx/buzon/ver?id=99887766', inTable: false };
  const pestana = { text: 'Notificados',
    href: 'https://wwwmat.sat.gob.mx/buzon/mis-notificaciones/notificados', inTable: false };
  assert.equal(pickBuzonNotificadosLink([detalleEnTabla, detalleConId, pestana]), pestana,
    'ni el asunto dentro de la tabla ni el destino con pinta de detalle secuestran el salto: manda la pestaña');
  assert.equal(pickBuzonNotificadosLink([detalleEnTabla, detalleConId]), null,
    'sin candidato seguro no hay salto: la corrida lista solo «Pendientes»');
  assert.equal(pickBuzonRescueLink([{ text: 'Mis notificaciones',
    href: 'https://wwwmat.sat.gob.mx/personas/login/mis-notificaciones', inTable: false }])?.href,
    'https://wwwmat.sat.gob.mx/personas/login/mis-notificaciones',
    'el rescate conserva su criterio tras compartir el filtro con el salto');
  assert.equal(pickBuzonRescueLink([detalleEnTabla]), null,
    'y sigue sin seguir jamás un enlace dentro de una tabla');
  console.log('OK 1.27.0 · H-4.1 (seguridad) — el salto a «Notificados» aplica las mismas exclusiones que el rescate.');
}
class TribFakePageVeneno1270 extends TribFakePage1270 {
  async evaluate(fn) {
    if (fn && fn.name === 'readLinksSource') {
      if (this.currentUrl.includes('notificados')) return [];
      return [
        { text: 'Actos notificados de octubre', href: 'https://wwwmat.sat.gob.mx/buzon/detalle/12345678', inTable: true },
        { text: 'Ver notificados', href: 'https://wwwmat.sat.gob.mx/buzon/ver?id=99887766', inTable: false },
        { text: 'Notificados', href: 'https://wwwmat.sat.gob.mx/buzon/notificados', inTable: false }];
    }
    return super.evaluate(fn);
  }
}
{
  /* H-4.1 por el motor entero: con la bandeja envenenada, el
     motor salta a la pestaña y jamás al detalle. */
  const page = new TribFakePageVeneno1270({
    pendientes: [{ fechaPortal: '09/11/2026', asunto: 'Requerimiento', remitente: 'Auditoría', estado: 'No leída' }],
    abiertas: [{ fechaPortal: '21/10/2026', asunto: 'Invitación', remitente: 'Recaudación', estado: 'Leída' }] });
  const fetchTrib = createSatTribFetch({ resolveCredentials: resolver, launchDriver: driverOf(page) });
  const result = await fetchTrib({ rfc: 'MFI6212158B4' }, {});
  assert.equal(result.notifications.length, 2, 'las dos bandejas se leen');
  assert.ok(!page.visitas.some(u => u.includes('detalle')),
    'el motor NUNCA navegó al detalle de una notificación: ' + page.visitas.join(' | '));
  assert.ok(!page.visitas.some(u => u.includes('ver?id')), 'ni al destino con parámetro de detalle');
  assert.ok(page.visitas.includes('https://wwwmat.sat.gob.mx/buzon/notificados'), 'saltó a la pestaña de la bandeja');
  console.log('OK 1.27.0 · H-4.1 (seguridad) — el motor del buzón salta a la pestaña y jamás al detalle envenenado.');
}
{
  /* H-3.1 · el folio descubierto se NORMALIZA (sin espacios)
     y se VALIDA con la regex del alta manual antes de entrar
     en el registro; lo que no valida no entra, y queda
     anotado en el resultado y en el diario de la corrida. */
  const dir = mkdtempSync(join(tmpdir(), 'pacosat-1270-folios-'));
  const dbFile = join(dir, 'pacosat.sqlite');
  const motor = async (profile, query) => {
    if (query.tipo !== 'transacciones') throw new Error('consulta inesperada: ' + query.tipo);
    return { found: 3, transactions: [
      { operacion: '1234 5678 9012', fecha: '2026-10-17', tipo: 'mensual', ejercicio: 2026, periodo: '2026-09' },
      { operacion: '123456789012', fecha: '2026-10-17', tipo: 'mensual', ejercicio: 2026, periodo: '2026-09' },
      { operacion: '12 34', fecha: '2026-10-17', tipo: 'mensual', ejercicio: 2026, periodo: '2026-09' }] };
  };
  const h = makeHarness({ dbFile, satDeclFetch: motor });
  await h.call('POST', '/api/profiles/prepare', { rfc: OWN });
  const des = await h.call('POST', '/api/declaraciones/descubrir-folios', { rfc: OWN, ejercicio: 2026 });
  assert.equal(des.status, 200, JSON.stringify(des.json));
  assert.equal(des.json.result.descubiertos, 1,
    'el folio agrupado con espacios y el mismo sin agrupar son EL MISMO: se aprende una sola vez');
  assert.equal(des.json.result.noAprendidos, 1, 'el que no pasa la validación se cuenta como no aprendido');
  assert.ok((des.json.result.warnings || []).some(w => /NO entraron en el registro/.test(w)),
    'y el resultado de la corrida lo declara: ' + JSON.stringify(des.json.result.warnings));
  const vista = await h.call('GET', '/api/declaraciones?rfc=' + OWN + '&ejercicio=2026');
  const folios = (vista.json.folios || []).map(f => f.folio);
  assert.deepEqual(folios, ['123456789012'],
    'el registro guarda el folio NORMALIZADO, sin espacios: ' + folios.join(', '));
  await h.service.close();
  const db = new DatabaseSync(dbFile);
  const corrida = db.prepare("SELECT steps FROM decl_runs WHERE tipo='transacciones' ORDER BY started DESC").get();
  assert.ok(corrida && String(corrida.steps).includes('Folios leídos y no aprendidos'),
    'el diario de la corrida anota lo no aprendido: nada queda en silencio');
  db.close();
  rmSync(dir, { recursive: true, force: true });
  console.log('OK 1.27.0 · H-3.1 (seguridad) — el folio 22513 entra normalizado y validado; lo inválido no entra y queda en el diario.');
}
{
  /* H-5.1 (a) · tras la reparación, el estado reparado Y la
     marca constan persistidos: el par completo. */
  const dir = mkdtempSync(join(tmpdir(), 'pacosat-1270-mes-'));
  const dbFile = join(dir, 'pacosat.sqlite');
  const t0 = Date.parse('2026-11-11T15:00:00Z');
  const h0 = makeHarness({ dbFile, now: () => t0 });
  await h0.service.close();
  const db = new DatabaseSync(dbFile);
  db.prepare('INSERT INTO profiles(rfc,minutes,days,direction,nextRun,error) VALUES (?,?,?,?,0,?)').run(OWN, 60, 30, 'both', '');
  db.prepare("INSERT INTO automation_state(key, value) VALUES ('monthly-download-state', ?)")
    .run(JSON.stringify({ runs: { '2026-10': { month: '2026-10', startedAt: t0 - 9 * DAY, finishedAt: t0 - 8 * DAY,
      status: 'hecha', automatic: true,
      perRfc: { [OWN]: { status: 'hecha', method: 'sat', jobs: [], metaJobs: [], found: 0, added: 0, duplicates: 0, gaps: 0 } },
      totals: { found: 0, added: 0, duplicates: 0, gaps: 0 } } } }));
  db.close();
  const h = makeHarness({ dbFile, now: () => t0 });
  await h.service.tick();
  await h.service.close();
  const db2 = new DatabaseSync(dbFile);
  const guardado = JSON.parse(db2.prepare("SELECT value FROM automation_state WHERE key='monthly-download-state'").get().value);
  assert.equal(guardado.runs['2026-10'].perRfc[OWN].status, 'parcial', 'el estado reparado quedó PERSISTIDO');
  assert.ok(db2.prepare("SELECT value FROM automation_state WHERE key='monthly-repair-1270'").get(),
    'y la marca también: el par completo, escrito en el orden seguro');
  db2.close();
  rmSync(dir, { recursive: true, force: true });
  console.log('OK 1.27.0 · H-5.1 (seguridad) — tras la reparación, estado y marca constan persistidos.');
}
{
  /* H-5.1 (b) · el estado intermedio que un corte deja con
     el orden nuevo — marca AUSENTE y entradas ya reparadas —
     converge sin daño: la re-ejecución no retoca lo degradado
     ni duplica el aviso, y cierra dejando la marca puesta. */
  const dir = mkdtempSync(join(tmpdir(), 'pacosat-1270-mes-'));
  const dbFile = join(dir, 'pacosat.sqlite');
  const t0 = Date.parse('2026-11-11T15:00:00Z');
  const h0 = makeHarness({ dbFile, now: () => t0 });
  await h0.service.close();
  const db = new DatabaseSync(dbFile);
  db.prepare('INSERT INTO profiles(rfc,minutes,days,direction,nextRun,error) VALUES (?,?,?,?,0,?)').run(OWN, 60, 30, 'both', '');
  db.prepare("INSERT INTO automation_state(key, value) VALUES ('monthly-download-state', ?)")
    .run(JSON.stringify({ runs: { '2026-10': { month: '2026-10', startedAt: t0 - 9 * DAY, finishedAt: t0 - 8 * DAY,
      status: 'parcial', automatic: true,
      perRfc: { [OWN]: { status: 'parcial', method: 'sat', jobs: [], metaJobs: [], found: 0, added: 0, duplicates: 0, gaps: 0,
        dudosa: 'Reparación 1.27.0: este mes constaba «hecho» con 0 CFDI y sin la prueba que hoy se exige.' } },
      totals: { found: 0, added: 0, duplicates: 0, gaps: 0 } } } }));
  db.close();
  const h = makeHarness({ dbFile, now: () => t0 });
  await h.service.tick();
  const view = await h.call('GET', '/api/monthly');
  const run = (view.json.runs || []).find(r => r.month === '2026-10');
  assert.equal(run.perRfc[OWN].status, 'parcial', 'lo ya reparado no se retoca al re-ejecutar');
  await h.service.close();
  const db2 = new DatabaseSync(dbFile);
  assert.ok(db2.prepare("SELECT value FROM automation_state WHERE key='monthly-repair-1270'").get(),
    'la re-ejecución cierra dejando la marca puesta');
  assert.equal(db2.prepare("SELECT COUNT(*) AS n FROM alerts WHERE ref LIKE 'descarga-dudosa:2026-10:%'").get().n, 0,
    'y no duplica el aviso de descarga dudosa: repetir la reparación no daña');
  db2.close();
  rmSync(dir, { recursive: true, force: true });
  console.log('OK 1.27.0 · H-5.1 (seguridad) — estado primero, marca después: un corte deja solo una repetición inocua.');
}
{
  /* H-6.1 · «correos del mes» se atribuye por el RFC guardado
     como DATO en el envío (columna rfc de mail_sends), no por
     buscar el RFC en el asunto. */
  const dir = mkdtempSync(join(tmpdir(), 'pacosat-1270-correos-'));
  const dbFile = join(dir, 'pacosat.sqlite');
  const h0 = makeHarness({ dbFile });
  await h0.service.close();
  const at = Date.parse('2026-10-15T10:00:00Z');
  const db = new DatabaseSync(dbFile);
  const ins = db.prepare('INSERT INTO mail_sends(at,recipients,subject,kind,ok,error,rfc) VALUES (?,?,?,?,1,?,?)');
  ins.run(at, 'contadora@test.mx', 'Informe de octubre (sin/rfc en el asunto)', 'compose', '', OWN);
  ins.run(at, 'contadora@test.mx', 'Resumen ' + OWN + ' legado sin dato', 'resumen-eventos', '', '');
  ins.run(at, 'contadora@test.mx', 'Aviso que nombra a ' + OWN, 'alerta-evento', '', 'CCC010101CC1');
  db.close();
  const h = makeHarness({ dbFile });
  const U1 = 'D1D1D1D1-1111-4111-8111-111111111111';
  await seedInvoices(h, [{ uuid: U1, fecha: '2026-10-05T10:00:00', emisor: BBB, receptor: OWN, total: '1160.00' }]);
  await h.call('POST', '/api/profiles/prepare', { rfc: OWN });
  const todo = await h.call('POST', '/api/reports/generate-all', { month: '2026-10', rfc: OWN });
  assert.equal(todo.status, 200, JSON.stringify(todo.json));
  const paso = (todo.json.pasos || []).find(s => s.id === 'paquete');
  assert.ok(paso?.ok, 'el paso del paquete salió');
  const zip = Buffer.from(paso.content, 'base64');
  const correos = zipEntry(zip, 'correos-del-mes.csv');
  assert.ok(correos, 'el paquete trae correos-del-mes.csv');
  assert.ok(correos.includes('Informe de octubre (sin/rfc en el asunto)'),
    'el envío CON el RFC como dato entra en su paquete aunque su asunto no lo nombre');
  assert.ok(!correos.includes('legado sin dato'),
    'el legado SIN dato no se atribuye, aunque su asunto nombre al RFC');
  assert.ok(!correos.includes('Aviso que nombra a'),
    'ni el envío de otro contribuyente, aunque su asunto nombre a este');
  const resumen = zipEntry(zip, 'resumen.txt');
  assert.ok(resumen && resumen.includes('no se atribuyen a ningún contribuyente'),
    'el paquete lo declara: lo que no lleva dato queda sin atribuir');
  /* Y el dato nace al enviar: el envío del paquete a la
     contadora deja su RFC guardado en la bitácora. */
  await h.call('POST', '/api/mail', { host: 'smtp.test', port: 465, security: 'ssl',
    from: 'avisos@pacosat.test', recipient: 'paco@test.mx', user: 'u', password: 'p' });
  const envio = await h.call('POST', '/api/reports/send-now', { month: '2026-10', rfc: OWN });
  assert.equal(envio.status, 200, JSON.stringify(envio.json));
  await h.service.close();
  const db2 = new DatabaseSync(dbFile);
  const fila = db2.prepare("SELECT rfc FROM mail_sends WHERE kind='nora' ORDER BY id DESC").get();
  assert.equal(fila?.rfc, OWN, 'el envío a la contadora guardó su RFC como dato: ' + JSON.stringify(fila));
  db2.close();
  rmSync(dir, { recursive: true, force: true });
  console.log('OK 1.27.0 · H-6.1 (seguridad) — correos del mes atribuidos por dato (columna RFC), no por subcadena del asunto.');
}
{
  /* H-7.1 · «Asignar dueño» valida el RFC: forma válida Y
     perfil existente; un dueño inexistente se rechaza con
     error claro y la cuenta conserva su dueño anterior. */
  const h = makeHarness();
  await h.call('POST', '/api/profiles/prepare', { rfc: OWN });
  const creada = await h.call('POST', '/api/banks/accounts', { bank: 'BBVA', name: 'Operativa', kind: 'cuenta' });
  assert.equal(creada.status, 200, JSON.stringify(creada.json));
  const cuenta = creada.json.accounts.find(a => a.name === 'Operativa');
  assert.ok(cuenta?.id, 'la cuenta nació');
  const buena = await h.call('POST', '/api/banks/accounts', { id: cuenta.id, rfc: OWN });
  assert.equal(buena.status, 200, 'asignar un dueño con perfil entra');
  assert.equal(buena.json.accounts.find(a => a.id === cuenta.id).rfc, OWN, 'y el dueño queda puesto');
  const fantasma = await h.call('POST', '/api/banks/accounts', { id: cuenta.id, rfc: 'ZZZ010101ZZ1' });
  assert.equal(fantasma.status, 404, 'un RFC bien formado pero SIN perfil se rechaza: ' + fantasma.status);
  assert.match(fantasma.json.error, /no tiene perfil/, 'con el error en claro: ' + fantasma.json.error);
  const trasRechazo = await h.call('GET', '/api/banks');
  assert.equal(trasRechazo.json.accounts.find(a => a.id === cuenta.id).rfc, OWN,
    'el rechazo no tocó el dueño anterior: la cuenta no quedó huérfana en silencio');
  const deforme = await h.call('POST', '/api/banks/accounts', { id: cuenta.id, rfc: '12345' });
  assert.ok(deforme.status >= 400, 'un RFC sin estructura válida también se rechaza');
  assert.match(deforme.json.error, /estructura válida/, 'diciendo por qué: ' + deforme.json.error);
  const sinDueno = await h.call('POST', '/api/banks/accounts', { id: cuenta.id, rfc: '' });
  assert.equal(sinDueno.status, 200, 'quitar el dueño (cadena vacía) sigue siendo legítimo');
  assert.equal(sinDueno.json.accounts.find(a => a.id === cuenta.id).rfc || '', '');
  const altaFantasma = await h.call('POST', '/api/banks/accounts', { bank: 'BBVA', name: 'Fantasma', rfc: 'ZZZ010101ZZ1' });
  assert.equal(altaFantasma.status, 404, 'el alta de cuenta con dueño inexistente también se rechaza');
  const altaBuena = await h.call('POST', '/api/banks/accounts', { bank: 'BBVA', name: 'Con dueño', rfc: OWN });
  assert.equal(altaBuena.status, 200, 'y el alta con dueño real entra');
  await h.service.close();
  console.log('OK 1.27.0 · H-7.1 (seguridad) — asignar dueño exige forma válida y perfil existente en la instalación.');
}
console.log('OK 1.27.0 · suite completa.');
