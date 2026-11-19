import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { generateKeyPairSync, webcrypto } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as vm from 'node:vm';
import { DOMParser } from '@xmldom/xmldom';
import { createPacoSATService } from './local-server.mjs';
import { createPlaywrightDriverFactory } from './sat-doc-browser.mjs';
import { createSatTribFetch } from './sat-tributario.mjs';
import { parseXml } from './xml-core.mjs';

/* ================================================================
   Ronda 2.9.3 — los DOCE fallos y las TRES observaciones del
   barrido funcional en vivo sobre la 2.9.2 (18 nov 2026,
   pacosat-barrido-funcional-2026-11-18.md: 74 funciones, 59
   funcionan, 12 fallan, 2 de gesto, 1 de solo describir).
   Cada pieza con su comprobación de verdad: la que reproduce
   el fallo en rojo contra la 2.9.2 y lo deja en verde.

   F1  «Probar la puerta» no probaba nada en sede NAS: la ruta
       devolvía «no se encola nada» y la marca quedaba vieja.
   F2  La pastilla «Lo que está mal» de Avisos filtraba la
       clase pero la vista persistida era «archivadas», cuyo
       panel ignora la clase: la lista no se movía.
   F3  «Imprimir seleccionados» anunciaba el documento y la
       ventana de impresión no llegaba: ahora el documento
       combinado lo construye el servidor (salidas/cfdi con
       ids) y se descarga, como el PDF individual que sí iba.
   F4  El panel de Declaraciones juzgaba por el error
       histórico de la tabla de documentos: tras la corrida
       buena seguía «La recuperación no terminó». Juzga la
       ÚLTIMA corrida.
   F5  El arranque del Chromium murió una vez con «Target
       page, context or browser has been closed» y el
       reintento manual funcionó: la fábrica reintenta sola.
   F6  «Descargar Excel de saldos» (Dinero) no pasaba el RFC
       y el servidor contestaba 422 siempre.
   F7  El cierre completo no traía Excel ni CSV: paridad.
   F8  El planificador no reconocía una ventana pedida el día
       de su cierre (su fila cierra con la hora viva, no con
       23:59:59): reconocimiento por días, sin tocar envíos.
   F9  «Revisar ahora la salud» sin efecto visible: la
       revisión corre con su estado pintado y refresca la
       marca y el veredicto de la tarjeta de coherencia.
   F10 «¿Cuánto vendí?» sumaba emitidos + recibidos: ventas
       son solo emitidos, y la respuesta lo dice.
   F11 «Comprobar respaldo ahora» acababa en «la respuesta se
       perdió»: el veredicto guardado viaja en /api/status y
       el cliente lo re-lee y lo pinta (skill de verdad de
       estado: re-leer el registro antes de dar error).
   F12 Revocar una llave API vivía solo en el menú «Más
       opciones»: botón visible en la tarjeta.
   O1  El sentido de la Opinión se rellena también AL LEER
       Documentos, no solo en el tick.
   O2  Cancelar el Buzón tardó ~6 min en reflejarse: la sonda
       de cancelación llega a las esperas del motor y la
       consulta se detiene en segundos; el texto lo dice.
   O3  En Novedades la franja de actividad repetía el trabajo
       fijado: render() re-evalúa su visibilidad al pintar,
       no solo en el pulso de 30 s.
   ================================================================ */

const AQUI = dirname(fileURLToPath(import.meta.url));
const RFC = 'MFI6212158B4';
const ORIGIN = 'https://pacosat.test';
const KEY = 'b'.repeat(64);
const OWN = 'AAA010101AAA';

/* ================================================================
   Arnés de servicio (el de ronda292parche)
   ================================================================ */
function makeHarness(options = {}) {
  const clock = { t: options.start ?? Date.parse('2026-11-18T09:00:00Z') };
  const mails = [];
  const service = createPacoSATService({
    dbFile: ':memory:',
    html: '<html><head><!--PACOSAT_TOKEN--></head><body>prueba</body></html>',
    origin: ORIGIN, proxyKey: KEY, satDocRetryWaitMs: 5,
    makeConnector: () => ({ parser: DOMParser, connector: {
      request: async () => 'req-293f', check: async () => ({ status: 'pending', packages: [] }),
      download: async () => { throw new Error('sin paquetes'); } } }),
    makeMailer: () => ({ verify: async () => true,
      sendMail: async payload => { mails.push(payload); return { messageId: 'm' + mails.length }; } }),
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
    return { status: r.status, json, text: r.text };
  };
  return { service, call, clock, mails };
}
const unlock = async (h, rfc = OWN) => {
  const open = await h.call('POST', '/api/unlock', { rfc, minutes: 1440, days: 7,
    direction: 'both', password: 'simulated', certificate: 'YQ==', key: 'Yg==' });
  assert.equal(open.status, 200, 'unlock de ' + rfc);
};

/* ================================================================
   F1 · Servidor: en sede NAS la puerta se PRUEBA y su
   veredicto queda guardado y servido
   ================================================================ */
{
  let llamadas = 0;
  const h = makeHarness({ executorMode: 'nas',
    satPuertaFetch: async () => { llamadas++; return { puerta: 'abre', accesoOk: true }; } });
  try {
    await unlock(h);
    const r = await h.call('POST', '/api/salud/puerta', { rfc: OWN });
    assert.equal(r.status, 200, 'F1: la ruta responde');
    assert.equal(r.json.probada, true,
      'F1: la respuesta dice que la prueba CORRIÓ (en la 2.9.2 solo decía «no se encola nada»)');
    assert.equal(r.json.ok, true, 'F1: el veredicto «abre» viaja en la respuesta');
    assert.equal(r.json.probadaEn, h.clock.t, 'F1: el veredicto lleva su hora');
    assert.equal(llamadas, 1, 'F1: la prueba corrió una vez');
    const st = await h.call('GET', '/api/status');
    assert.equal(st.json.puerta[OWN].ok, true, 'F1: sat_puerta quedó «abre»');
    assert.equal(st.json.puerta[OWN].probada, h.clock.t,
      'F1: la marca «probada el» avanzó a ahora (en la 2.9.2 quedaba la vieja)');
    console.log('OK 2.9.3 · F1a — Servidor: «Probar la puerta» en sede NAS corre la prueba, responde con su veredicto y la marca avanza.');
  } finally { h.service.close(); }
}
{
  const fallo = new Error('El portal rechazó el acceso (juguete)');
  fallo.code = 'portal-rechaza';
  const h = makeHarness({ executorMode: 'nas',
    satPuertaFetch: async () => { throw fallo; } });
  try {
    await unlock(h);
    const r = await h.call('POST', '/api/salud/puerta', { rfc: OWN });
    assert.equal(r.json.probada, true, 'F1: también con fallo la prueba corrió');
    assert.equal(r.json.ok, false, 'F1: el veredicto «no abre» viaja en la respuesta');
    assert.equal(r.json.errorKind, 'portal-rechaza', 'F1: el motivo viaja con su clase');
    const st = await h.call('GET', '/api/status');
    assert.equal(st.json.puerta[OWN].ok, false, 'F1: sat_puerta guarda el «no abre»');
    assert.ok(st.json.puerta[OWN].error.includes('rechazó'),
      'F1: y su motivo, para pintarlo en la tarjeta');
    console.log('OK 2.9.3 · F1b — Servidor: si la puerta no abre, el veredicto y su motivo quedan guardados y servidos.');
  } finally { h.service.close(); }
}
{
  /* Control del comportamiento viejo: sin el puerto cableado,
     la ruta sigue en su rama honesta de «no se encola». */
  const h = makeHarness({ executorMode: 'nas' });
  try {
    await unlock(h);
    const r = await h.call('POST', '/api/salud/puerta', { rfc: OWN });
    assert.equal(r.json.probada, undefined,
      'F1: sin puerto de prueba no se finge ningún veredicto');
    console.log('OK 2.9.3 · F1c — Control: sin la prueba cableada no se inventa veredicto.');
  } finally { h.service.close(); }
}

/* ================================================================
   F4 · Servidor: el panel de Declaraciones juzga por la
   ÚLTIMA corrida — una buena posterior borra el aviso viejo
   ================================================================ */
{
  let modo = 'falla';
  const satDeclFetch = async () => {
    if (modo === 'falla') {
      const e = new Error('El portal no respondió como se esperaba (juguete)');
      e.code = 'portal-rechaza';
      throw e;
    }
    return { found: 1, documents: [{ tipo: 'mensual', clase: 'acuse', ejercicio: 2026,
      periodo: '2026-10', fechaPresentacion: '2026-11-10', operacion: '262620289089',
      content: Buffer.from('%PDF-1.4 acuse de juguete').toString('base64') }] };
  };
  const h = makeHarness({ satDeclFetch });
  try {
    await unlock(h);
    const runMalo = await h.call('POST', '/api/declaraciones/run',
      { rfc: OWN, tipo: 'mensual', ejercicio: 2026, periodo: '' });
    assert.equal(runMalo.json.result.ok, false, 'F4: la primera corrida falla de verdad');
    let vista = (await h.call('GET', '/api/declaraciones?rfc=' + OWN + '&ejercicio=2026')).json;
    assert.ok(vista.lastError?.error.includes('no respondió'),
      'F4: tras la corrida mala, el panel enseña SU error');
    assert.equal(vista.ultimaCorrida.ok, false, 'F4: la última corrida consta mala');
    modo = 'bien';
    h.clock.t += 60_000;
    const runBueno = await h.call('POST', '/api/declaraciones/run',
      { rfc: OWN, tipo: 'mensual', ejercicio: 2026, periodo: '' });
    assert.equal(runBueno.json.result.ok, true, 'F4: la segunda corrida va bien');
    vista = (await h.call('GET', '/api/declaraciones?rfc=' + OWN + '&ejercicio=2026')).json;
    assert.equal(vista.lastError, null,
      'F4: tras la corrida buena el aviso viejo DESAPARECE (en la 2.9.2 el error histórico de la tabla seguía pegado)');
    assert.equal(vista.ultimaCorrida.ok, true, 'F4: la última corrida consta buena, con su hora');
    console.log('OK 2.9.3 · F4 — Servidor: el panel juzga por la última corrida; la buena retira el «no terminó» de la vieja.');
  } finally { h.service.close(); }
}

/* ================================================================
   Semilla común de salidas: dos CFDI emitidos por OWN en
   octubre de 2026, con su XML guardado
   ================================================================ */
const xmlCfdi = (uuid, folio, total) => `<?xml version="1.0" encoding="UTF-8"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" Version="4.0" Serie="A" Folio="${folio}" Fecha="2026-10-15T10:00:00" SubTotal="1000.00" Moneda="MXN" Total="${total}" TipoDeComprobante="I" MetodoPago="PPD" FormaPago="99" LugarExpedicion="72000">
<cfdi:Emisor Rfc="AAA010101AAA" Nombre="EMPRESA ALFA SA" RegimenFiscal="601"/>
<cfdi:Receptor Rfc="XAXX010101000" Nombre="CLIENTE UNO" DomicilioFiscalReceptor="72000" RegimenFiscalReceptor="601" UsoCFDI="G03"/>
<cfdi:Conceptos><cfdi:Concepto ClaveProdServ="01010101" Cantidad="1" ClaveUnidad="H87" Descripcion="Servicio" ValorUnitario="1000.00" Importe="1000.00" ObjetoImp="02"><cfdi:Impuestos><cfdi:Traslados><cfdi:Traslado Base="1000.00" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="160.00"/></cfdi:Traslados></cfdi:Impuestos></cfdi:Concepto></cfdi:Conceptos>
<cfdi:Impuestos TotalImpuestosTrasladados="160.00"><cfdi:Traslados><cfdi:Traslado Base="1000.00" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="160.00"/></cfdi:Traslados></cfdi:Impuestos>
<cfdi:Complemento><tfd:TimbreFiscalDigital xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital" Version="1.1" UUID="${uuid}" FechaTimbrado="2026-10-15T10:01:00" RfcProvCertif="SAT970701NN3" SelloCFD="AAAA" NoCertificadoSAT="00001000000500000001" SelloSAT="BBBB"/></cfdi:Complemento>
</cfdi:Comprobante>`;
const U1 = '12345678-1234-1234-1234-1234567890AB';
const U2 = '12345678-1234-1234-1234-1234567890CD';
async function sembrarSalidas(h) {
  await unlock(h);
  const filas = [parseXml(Buffer.from(xmlCfdi(U1, '1', '1160.00')), DOMParser),
    parseXml(Buffer.from(xmlCfdi(U2, '2', '1160.00')), DOMParser)];
  const r = await h.call('POST', '/api/storage', { batch: {
    people: [{ id: OWN, name: 'Empresa Alfa SA' }, { id: 'XAXX010101000', name: 'Cliente Uno' }],
    invoices: filas,
    files: [{ id: 'xml:' + U1, mime: 'application/xml', content: Buffer.from(xmlCfdi(U1, '1', '1160.00')).toString('base64') },
      { id: 'xml:' + U2, mime: 'application/xml', content: Buffer.from(xmlCfdi(U2, '2', '1160.00')).toString('base64') }] } });
  assert.equal(r.status, 200, 'semilla de salidas');
  await h.call('POST', '/api/reparse', {});
}

/* ================================================================
   F6 · Servidor: el Excel de saldos con el RFC descarga; sin
   él, el 422 de siempre (el fallo vivo era del cliente)
   ================================================================ */
{
  const h = makeHarness({});
  try {
    await sembrarSalidas(h);
    const sin = await h.call('POST', '/api/salidas/xlsx', { kind: 'dinero' });
    assert.equal(sin.status, 422, 'F6: sin RFC el servidor pide el RFC (control)');
    const con = await h.call('POST', '/api/salidas/xlsx', { kind: 'dinero', rfc: OWN });
    assert.equal(con.status, 200, 'F6: con el RFC del selector, la salida corre');
    const bytes = Buffer.from(con.json.content, 'base64');
    assert.equal(bytes.subarray(0, 2).toString('latin1'), 'PK',
      'F6: lo que baja es un XLSX de verdad');
    console.log('OK 2.9.3 · F6 — Servidor: «Descargar Excel de saldos» con el RFC baja el XLSX; el cliente ya lo pasa (cableado verificado en la sección de cliente).');
  } finally { h.service.close(); }
}

/* ================================================================
   F7 · Servidor: el cierre completo trae CINCO pasos —
   también el Excel y el CSV del mes
   ================================================================ */
{
  const h = makeHarness({});
  try {
    await sembrarSalidas(h);
    const r = await h.call('POST', '/api/reports/generate-all', { rfc: OWN, month: '2026-10' });
    assert.equal(r.status, 200, 'F7: el cierre corre');
    const ids = (r.json.pasos || []).map(p => p.id);
    assert.deepEqual(ids, ['paquete', 'reporte', 'zip', 'excel', 'csv'],
      'F7: el cierre trae los cinco artefactos (en la 2.9.2 solo tres: sin Excel ni CSV)');
    const excel = r.json.pasos.find(p => p.id === 'excel');
    assert.ok(excel.ok && Buffer.from(excel.content, 'base64').subarray(0, 2).toString('latin1') === 'PK',
      'F7: el paso Excel es un XLSX de verdad');
    const csv = r.json.pasos.find(p => p.id === 'csv');
    const csvTexto = Buffer.from(csv.content, 'base64').toString('utf8');
    assert.ok(csv.ok && csvTexto.startsWith('"UUID","Folio"') && csvTexto.includes(U1) && csvTexto.includes(U2),
      'F7: el paso CSV trae las columnas de siempre y las filas del mes');
    console.log('OK 2.9.3 · F7 — Servidor: el cierre completo genera también el Excel y el CSV del mes, con sus bytes reales.');
  } finally { h.service.close(); }
}

/* ================================================================
   F3 · Servidor: el documento combinado de la selección —
   un PDF con la representación de cada comprobante
   ================================================================ */
{
  const h = makeHarness({});
  try {
    await sembrarSalidas(h);
    const comb = await h.call('POST', '/api/salidas/cfdi', { ids: [U1, U2], format: 'pdf', rfc: OWN });
    assert.equal(comb.status, 200, 'F3: el combinado se construye');
    const pdf = Buffer.from(comb.json.content, 'base64').toString('latin1');
    assert.ok(pdf.startsWith('%PDF'), 'F3: lo que baja es un PDF');
    assert.ok(pdf.includes('Comprobante 1 de 2') && pdf.includes('Comprobante 2 de 2'),
      'F3: el combinado separa cada comprobante con su portada');
    assert.ok(pdf.includes(U1) && pdf.includes(U2),
      'F3: y trae la representación de los dos seleccionados');
    const solo = await h.call('POST', '/api/salidas/cfdi', { id: U1, format: 'pdf', rfc: OWN });
    assert.equal(solo.status, 200, 'F3: el PDF individual sigue intacto (paridad)');
    assert.ok(!Buffer.from(solo.json.content, 'base64').toString('latin1').includes('Comprobante 1 de'),
      'F3: el individual no gana portadas de combinado');
    console.log('OK 2.9.3 · F3 — Servidor: «Imprimir seleccionados» baja UN PDF combinado con las dos representaciones; el individual no cambia.');
  } finally { h.service.close(); }
}

/* ================================================================
   F8 · Servidor: el plan reconoce la ventana pedida el día
   de su cierre aunque su fila cierre con la hora viva
   ================================================================ */
{
  const h = makeHarness({});
  try {
    await unlock(h);
    const req = await h.call('POST', '/api/request', { rfc: OWN, start: '2026-11-12',
      end: '2026-11-18', direction: 'received', type: 'cfdi' });
    assert.equal(req.status, 200, 'F8: la solicitud de juguete se envía el 18 (día de su cierre): ' + req.text.slice(0, 200));
    const mismoDia = await h.call('POST', '/api/plan', { rfc: OWN, start: '2026-11-12',
      end: '2026-11-18', direction: 'received', type: 'cfdi' });
    assert.ok(mismoDia.json.yaPedida?.at > 0,
      'F8: el mismo día, el plan ya reconoce la ventana por su criterio exacto');
    h.clock.t += 24 * 3600 * 1000; /* al día siguiente, el plan compone el cierre a 23:59:59 */
    const otroDia = await h.call('POST', '/api/plan', { rfc: OWN, start: '2026-11-12',
      end: '2026-11-18', direction: 'received', type: 'cfdi' });
    assert.equal(otroDia.json.yaPedida?.porDias, true,
      'F8: al día siguiente el plan reconoce la ventana POR DÍAS (en la 2.9.2 decía «nunca se ha solicitado»)');
    assert.equal(otroDia.json.recommendation, 'variant',
      'F8: y recomienda la variante, no reenviarla tal cual');
    assert.ok(/ya se solicitó/.test(otroDia.json.reason),
      'F8: el motivo lo dice en llano: «' + otroDia.json.reason.slice(0, 60) + '…»');
    console.log('OK 2.9.3 · F8 — Servidor: el planificador reconoce la ventana ya pedida aunque su cierre se pidió con la hora viva; nada se reenvía.');
  } finally { h.service.close(); }
}

/* ================================================================
   F11 · Servidor: el veredicto de la comprobación del
   respaldo viaja en /api/status para poder re-leerlo
   ================================================================ */
{
  const h = makeHarness({});
  try {
    const dir = mkdtempSync(join(tmpdir(), 'pacosat-293f-'));
    await h.service.bootstrap({ backup: { password: 'respaldo-prueba-16', frequency: 'daily',
      dir: join(dir, 'respaldos') } });
    await h.service.backupTick(h.clock.t);
    const verify = await h.call('POST', '/api/backup/verify', {});
    assert.equal(verify.status, 200, 'F11: la comprobación corre con el respaldo configurado');
    assert.equal(verify.json.ok, true, 'F11: y su veredicto es íntegro');
    const st = await h.call('GET', '/api/status');
    assert.ok(st.json.backupHealth.verify,
      'F11: el estado sirve la última comprobación (en la 2.9.2 no viajaba: el cliente no podía re-leerla)');
    assert.equal(st.json.backupHealth.verify.ok, true, 'F11: con su veredicto');
    assert.equal(st.json.backupHealth.verify.at, h.clock.t, 'F11: y con su hora — la del clic');
    assert.ok(Array.isArray(st.json.backupHealth.verify.results) && st.json.backupHealth.verify.results.length,
      'F11: y con sus líneas, para pintarlas tal cual tras una respuesta perdida');
    console.log('OK 2.9.3 · F11 — Servidor: backupHealth.verify expone veredicto, hora y líneas de la comprobación.');
  } finally { h.service.close(); }
}

/* ================================================================
   O1 · Servidor: el sentido de la Opinión se lee de la copia
   AL LEER Documentos, no solo cuando el tick pasa. El
   registro legado se siembra como quedó de verdad: una
   Opinión archivada antes de que el sentido se leyera del
   texto (su registro nació con sentido vacío) y su PDF
   guardado — el extractor inyectado SÍ lo lee.
   ================================================================ */
{
  const dir = mkdtempSync(join(tmpdir(), 'pacosat-293o1-'));
  const dbFile = join(dir, 'pacosat.sqlite');
  const service = createPacoSATService({ dbFile,
    html: '<html><head><!--PACOSAT_TOKEN--></head><body>prueba</body></html>',
    origin: ORIGIN, proxyKey: KEY, satDocRetryWaitMs: 5,
    makeConnector: () => ({ parser: DOMParser, connector: {
      request: async () => 'req-293o1', check: async () => ({ status: 'pending', packages: [] }),
      download: async () => { throw new Error('sin paquetes'); } } }),
    makeMailer: () => ({ verify: async () => true, sendMail: async () => ({}) }),
    now: () => Date.parse('2026-11-18T09:00:00Z'),
    extractText: async () => ['Opinión del cumplimiento de obligaciones fiscales',
      'Sentido: POSITIVA', 'Folio: 26NQI411794'] });
  let token = '';
  const call = async (method, path, body) => {
    if (!token) {
      const home = await (async () => {
        const req = Readable.from([]); req.method = 'GET'; req.url = '/';
        req.headers = { host: 'pacosat.test', origin: ORIGIN, 'x-pacosat-proxy': KEY };
        let text = '';
        const res = { writeHead() {}, setHeader() {}, getHeader() {},
          end(ch) { if (ch) text += Buffer.isBuffer(ch) ? ch.toString('latin1') : ch; } };
        await service.handle(req, res); return text;
      })();
      token = /[0-9a-f]{64}/.exec(home)?.[0] || '';
    }
    const req = Readable.from(body !== undefined ? [Buffer.from(JSON.stringify(body))] : []);
    req.method = method; req.url = path;
    req.headers = { host: 'pacosat.test', origin: ORIGIN, 'x-pacosat-proxy': KEY, 'x-pacosat-token': token };
    let status = 0, text = '';
    const res = { writeHead(c) { status = c; }, setHeader() {}, getHeader() {},
      end(ch) { if (ch) text += Buffer.isBuffer(ch) ? ch.toString('latin1') : ch; } };
    await service.handle(req, res);
    let json = null; try { json = JSON.parse(text); } catch { /* binario */ }
    return { status, json, text };
  };
  try {
    const open = await call('POST', '/api/unlock', { rfc: OWN, minutes: 1440, days: 7,
      direction: 'both', password: 'simulated', certificate: 'YQ==', key: 'Yg==' });
    assert.equal(open.status, 200, 'O1: unlock');
    /* La siembra del legado, con la forma exacta que
       archiveSatDoc escribe (records files/documents +
       sat_documents), pero con el sentido vacío con el que
       las copias viejas quedaron. */
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(dbFile);
    const fileId = 'pdf:legado-o1';
    const ahora = Date.parse('2026-11-16T09:00:00Z');
    db.prepare("INSERT OR REPLACE INTO records(store,id,value,data,mime) VALUES ('files',?,NULL,?,'application/pdf')")
      .run(fileId, new Uint8Array(Buffer.from('%PDF-1.4 opinion legada de juguete')));
    db.prepare("INSERT OR REPLACE INTO records(store,id,value) VALUES ('documents',?,?)")
      .run(fileId, JSON.stringify({ id: fileId, rfc: OWN, kind: 'Opinión de cumplimiento',
        date: '2026-11-16', sentido: '', vigencia: '' }));
    db.prepare('INSERT INTO sat_documents(id,rfc,kind,issuedAt,fileId,source,created) VALUES (?,?,?,?,?,?,?)')
      .run('doc-legado-o1', OWN, 'opinion', ahora, fileId, 'sat', ahora);
    db.close();
    const antes = (await call('GET', '/api/satdocs')).json;
    assert.equal(antes.profiles[0].opinion.sentido, 'positiva',
      'O1: AL LEER Documentos, el sentido se rellena desde la copia (en la 2.9.2 la lectura no rellenaba: la tarjeta decía «no consta» de una Opinión POSITIVA)');
    const despues = (await call('GET', '/api/satdocs')).json;
    assert.equal(despues.profiles[0].opinion.sentido, 'positiva',
      'O1: y queda guardado en el registro, no se re-deriva en cada lectura');
    console.log('OK 2.9.3 · O1 — Servidor: la tarjeta de Opinión lee el sentido de la copia archivada al abrir Documentos.');
  } finally { service.close(); }
}

/* ================================================================
   F12 · Servidor (control): la ruta de revocación existe y
   revoca — el fallo vivo era del cliente (botón escondido)
   ================================================================ */
{
  const h = makeHarness({});
  try {
    const creada = await h.call('POST', '/api/apikeys', { nombre: 'Prueba barrido 2026-11-18', alcance: 'lectura' });
    assert.equal(creada.status, 200, 'F12: la llave de juguete se crea');
    const lista = (await h.call('GET', '/api/apikeys')).json;
    const llave = (lista.llaves || []).find(k => k.nombre === 'Prueba barrido 2026-11-18');
    assert.ok(llave?.id, 'F12: la llave consta activa en la lista');
    assert.equal(llave.estado, 'activa', 'F12: nace activa');
    const rev = await h.call('POST', '/api/apikeys/estado', { id: llave.id, estado: 'revocada' });
    assert.equal(rev.status, 200, 'F12: POST /api/apikeys/estado revoca');
    const lista2 = (await h.call('GET', '/api/apikeys')).json;
    assert.equal((lista2.llaves || []).find(k => k.id === llave.id)?.estado, 'revocada',
      'F12: la llave queda revocada — la ruta que el informe nombra para la llave de producción');
    console.log('OK 2.9.3 · F12 — Servidor: la revocación existe (POST /api/apikeys/estado); el botón visible va en la sección de cliente.');
  } finally { h.service.close(); }
}

/* ================================================================
   O2 · Servidor: la sonda de cancelación llega al motor y
   la corrida cierra «cancelada», sin fallo ni reintento
   ================================================================ */
{
  let sondaVista = null;
  const satTribFetch = async (profile, query, options = {}) => {
    sondaVista = typeof options.cancelada;
    const limite = Date.now() + 20_000;
    for (;;) {
      if (typeof options.cancelada === 'function' && options.cancelada()) {
        const e = new Error('Consulta cancelada por ti.');
        e.code = 'cancelada';
        throw e;
      }
      if (Date.now() > limite) throw new Error('la sonda nunca vio la cancelación');
      await new Promise(r => setTimeout(r, 25));
    }
  };
  const h = makeHarness({ executorMode: 'nas', satTribFetch });
  try {
    await unlock(h);
    const corrida = h.call('POST', '/api/tributario/run', { rfc: OWN });
    await new Promise(r => setTimeout(r, 300));
    const cancel = await h.call('POST', '/api/tributario/cancel', { rfc: OWN });
    assert.equal(cancel.status, 200, 'O2: la cancelación se pide');
    const resultado = await corrida;
    assert.equal(sondaVista, 'function', 'O2: el servidor pasa la sonda cancelada al motor');
    assert.equal(resultado.json.result.cancelled, true,
      'O2: la corrida cierra como cancelada, no como fallo');
    const vista = (await h.call('GET', '/api/tributario?rfc=' + OWN)).json;
    assert.equal(vista.runs[0].ok, false, 'O2: la corrida del diario no es un éxito');
    assert.equal(vista.runs[0].error, 'Consulta cancelada por ti.',
      'O2: y su cierre dice «cancelada por ti», sin alerta de fallo');
    console.log('OK 2.9.3 · O2a — Servidor: la sonda llega al paseo y la cancelación cierra la corrida en segundos.');
  } finally { h.service.close(); }
}

/* ================================================================
   F5 · Motor de arranque: la fábrica de navegadores
   reintenta la secuencia entera ante el error transitorio
   ================================================================ */
{
  const paginaFalsa = { on() {}, url: () => 'about:blank' };
  let lanzamientos = 0;
  const proveedorFlaky = async () => ({ chromium: { launch: async () => {
    lanzamientos++;
    const intento = lanzamientos;
    return { newContext: async () => {
        if (intento === 1) throw new Error('browserType.launch: Target page, context or browser has been closed');
        return { on() {}, newPage: async () => paginaFalsa };
      }, close: async () => {} };
  } } });
  const launch = createPlaywrightDriverFactory({ proveedorChromium: proveedorFlaky,
    esperasReintentoMs: [1, 1] });
  const driver = await launch();
  assert.equal(lanzamientos, 2,
    'F5: el primer arranque muere con el error vivo y la fábrica reintenta sola (en la 2.9.2 el paseo moría ahí)');
  assert.equal(typeof driver.newPage, 'function', 'F5: el segundo intento entrega el driver');
  await driver.close();
  let lanzamientosMal = 0;
  const proveedorMalo = async () => ({ chromium: { launch: async () => {
    lanzamientosMal++;
    return { newContext: async () => { throw new Error('Target page, context or browser has been closed'); },
      close: async () => {} };
  } } });
  const launchMalo = createPlaywrightDriverFactory({ proveedorChromium: proveedorMalo,
    esperasReintentoMs: [1, 1] });
  await assert.rejects(launchMalo(),
    e => e?.code === 'navegador-no-disponible',
    'F5: si los tres intentos caen, el error es el de siempre, con su clase');
  assert.equal(lanzamientosMal, 3, 'F5: tres intentos en total, ni más ni menos');
  console.log('OK 2.9.3 · F5 — Arranque robusto: reintento propio ante «Target page… has been closed»; el fallo total conserva su clase.');
}

/* ================================================================
   O2 · Motor: con la bandeja muda y un plazo largo, la
   cancelación pedida a mitad de la espera detiene la corrida
   en segundos (réplica de dos orígenes, patrón ronda293parche)
   ================================================================ */
function chromiumDePrueba() {
  const candidatos = [process.env.PACOSAT_TEST_CHROMIUM || '', '/usr/bin/chromium'];
  try {
    const cache = join(homedir(), '.cache', 'ms-playwright');
    for (const dir of readdirSync(cache).sort()) {
      if (dir.startsWith('chromium-')) candidatos.push(join(cache, dir, 'chrome-linux64', 'chrome'));
    }
  } catch { /* sin caché de playwright */ }
  return candidatos.find(p => p && existsSync(p)) || '';
}
const CHROME = chromiumDePrueba();
assert.ok(CHROME, 'ronda293fallos (O2 motor) necesita un Chromium local para la réplica.');

let aperturasO2 = 0;
const serverMarcosO2 = createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  if (path.startsWith('/abrir-')) { aperturasO2++; res.writeHead(200); res.end('<html><body>Abierto</body></html>'); return; }
  if (path === '/bandeja-muda') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!DOCTYPE html><html><body><p>Cargando la bandeja… un momento, por favor.</p></body></html>');
    return;
  }
  res.writeHead(404); res.end();
});
await new Promise(resolve => serverMarcosO2.listen(0, '127.0.0.1', resolve));
const ORIGEN2_O2 = 'http://127.0.0.1:' + serverMarcosO2.address().port;

const paginaAccesoO2 = `<!DOCTYPE html><html><body>
  <h1>Acceso por contraseña</h1>
  <a id="buttonFiel" href="/acceso-fiel-o2">Acceso con e.firma</a>
</body></html>`;
const formularioLoginO2 = `<!DOCTYPE html><html><body>
  <h1>SAT Autenticación</h1>
  <form id="certform">
    <input type="text" id="txtCertificate">
    <input type="file" id="fileCertificate" style="display:none">
    <input type="text" id="txtPrivateKey">
    <input type="file" id="filePrivateKey" style="display:none">
    <input type="password" id="privateKeyPassword">
    <input type="text" id="rfc">
    <div id="divError" style="display:none"></div>
    <button type="button" id="submit">Acceder</button>
  </form>
  <script>
    document.getElementById('fileCertificate').addEventListener('change', () => {
      setTimeout(() => { document.getElementById('txtCertificate').value = 'certificado.cer'; }, 300);
      setTimeout(() => { document.getElementById('rfc').value = '${RFC}'; }, 600);
    });
    document.getElementById('filePrivateKey').addEventListener('change', () => {
      setTimeout(() => { document.getElementById('txtPrivateKey').value = 'llave.key'; }, 300);
    });
    document.getElementById('submit').addEventListener('click', () => {
      const falta = !document.getElementById('rfc').value ||
        !document.getElementById('fileCertificate').files.length ||
        !document.getElementById('filePrivateKey').files.length ||
        !document.getElementById('privateKeyPassword').value;
      if (falta) {
        const d = document.getElementById('divError');
        d.textContent = '¡Error! no ha llenado varios campos requeridos. Por favor verifique.';
        d.style.display = 'block';
        return;
      }
      location.href = '/buzon-o2';
    });
  </script>
</body></html>`;
const cabeceraO2 = `
  <header>
    <span>BUZÓN TRIBUTARIO</span>
    <button id="btn-expedientes" type="button">Mis expedientes</button>
    <nav id="menu-expedientes" style="display:none">
      <a href="#" id="link-notificaciones">Mis notificaciones</a>
    </nav>
    <a href="#" data-nav="salir">Cerrar sesión</a>
  </header>
  <script>
    document.getElementById('btn-expedientes').addEventListener('click', () => {
      const m = document.getElementById('menu-expedientes');
      m.style.display = m.style.display === 'none' ? 'block' : 'none';
    });
    document.getElementById('link-notificaciones').addEventListener('click', (ev) => {
      ev.preventDefault();
      location.href = '/iniciar-expediente/mis-notificaciones-o2/';
    });
  </script>`;
const serverPortalO2 = createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  const rutas = {
    '/acceso-o2': paginaAccesoO2,
    '/acceso-fiel-o2': formularioLoginO2,
    '/buzon-o2': '<!DOCTYPE html><html><body>' + cabeceraO2 + '<main></main></body></html>',
    '/iniciar-expediente/mis-notificaciones-o2/':
      '<!DOCTYPE html><html><body>' + cabeceraO2 +
      '<main><iframe id="iframetoload" src="' + ORIGEN2_O2 + '/bandeja-muda"></iframe></main></body></html>'
  };
  const html = rutas[path];
  if (!html) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
});
await new Promise(resolve => serverPortalO2.listen(0, '127.0.0.1', resolve));
const ORIGEN1_O2 = 'http://127.0.0.1:' + serverPortalO2.address().port;

{
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const keyPortal = privateKey.export({ type: 'pkcs8', format: 'der',
    cipher: 'des-ede3-cbc', passphrase: 'pw-de-juguete' });
  const resolver = async (profile) => ({ rfc: profile.rfc, cer: Buffer.from('certificado-de-juguete'),
    key: keyPortal, password: 'pw-de-juguete' });
  const trib = createSatTribFetch({ resolveCredentials: resolver,
    launchDriver: createPlaywrightDriverFactory({ executablePath: CHROME, headless: true }),
    entryUrl: ORIGEN1_O2 + '/iniciar-expediente/mis-notificaciones-o2/',
    loginUrl: ORIGEN1_O2 + '/acceso-o2', esperaBandejaMs: 30_000 });
  /* La cancelación se pide DURANTE la espera de la bandeja
     (500 ms tras el «Acceso al portal OK»): es la espera larga
     la que la pieza gobierna — el acceso es un paso y no se
     aborta a mitad de firma. */
  let cancelada = false;
  let pedidaEn = 0;
  const onStep = (paso) => {
    if (paso === 'Acceso al portal OK' && !pedidaEn) {
      pedidaEn = Date.now();
      setTimeout(() => { cancelada = true; }, 500);
    }
  };
  const error = await trib({ rfc: RFC }, {}, { cancelada: () => cancelada, onStep })
    .then(() => null, e => e);
  const tardanza = Date.now() - pedidaEn;
  assert.ok(pedidaEn > 0, 'O2: la corrida llegó a la espera de la bandeja');
  assert.equal(error?.code, 'cancelada',
    'O2: la corrida se detiene con la clase «cancelada» (en la 2.9.2 la señal no llegaba a las esperas)');
  assert.ok(tardanza < 10_000,
    'O2: pedida la cancelación en plena espera, la corrida muere en segundos (' + tardanza + ' ms), no al agotar el plazo de 30 s');
  assert.equal(aperturasO2, 0, 'O2: cero aperturas');
  console.log('OK 2.9.3 · O2b — Motor: la espera de la bandeja mira la sonda y la consulta muere en ' + tardanza + ' ms al pedir «Detener».');
}
serverPortalO2.close();
serverMarcosO2.close();

/* ================================================================
   CLIENTE — arnés DOM de juguete (el de ronda240actividad)
   ================================================================ */
const htmlCliente = readFileSync(join(AQUI, 'Faro-Fiscal.html'), 'utf8');
const lazyCliente = JSON.parse(readFileSync(join(AQUI, 'lazy.json'), 'utf8'));
class BootURL extends URL { static createObjectURL() { return 'blob:prueba'; } static revokeObjectURL() {} }
class FakeElement {
  constructor(tag = 'div') {
    this.tagName = String(tag).toUpperCase();
    this.children = []; this.dataset = {}; this.style = {}; this.attributes = {};
    this.textContent = ''; this.innerHTML = ''; this.value = '';
    this.hidden = false; this.disabled = false; this.open = false; this.files = [];
    this.checked = false; this.isConnected = true;
    const classes = new Set();
    this.classList = { add: (...n) => n.forEach(x => classes.add(x)),
      remove: (...n) => n.forEach(x => classes.delete(x)),
      toggle: (name, force) => { const on = force === undefined ? !classes.has(name) : Boolean(force);
        if (on) classes.add(name); else classes.delete(name); return on; },
      contains: name => classes.has(name) };
  }
  get childNodes() { return this.children; }
  get lastChild() { return this.children[this.children.length - 1]; }
  get firstChild() { return this.children[0]; }
  append(...kids) { for (const k of kids) if (k instanceof FakeElement) this.children.push(k); }
  prepend(...kids) { for (const k of [...kids].reverse()) if (k instanceof FakeElement) this.children.unshift(k); }
  appendChild(k) { if (k instanceof FakeElement) this.children.push(k); return k; }
  insertBefore(k) { if (k instanceof FakeElement) this.children.push(k); return k; }
  removeChild(k) { this.children = this.children.filter(c => c !== k); return k; }
  replaceWith(...kids) { this.children = kids.filter(k => k instanceof FakeElement); }
  before() {} after() {} insertAdjacentElement(_w, k) { return k; }
  insertAdjacentHTML() {} insertAdjacentText() {}
  cloneNode() { return new FakeElement(this.tagName); }
  replaceChildren(...kids) { this.children = kids.filter(k => k instanceof FakeElement); }
  remove() {} click() {} close() {} showModal() {}
  setAttribute(n, v) { this.attributes[n] = String(v); }
  getAttribute(n) { return n in this.attributes ? this.attributes[n] : null; }
  removeAttribute(n) { delete this.attributes[n]; }
  hasAttribute(n) { return n in this.attributes; }
  addEventListener() {} removeEventListener() {}
  querySelector() { return null; } querySelectorAll() { return []; }
  closest() { return null; } focus() {} blur() {} scrollIntoView() {}
  getBoundingClientRect() { return { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 }; }
}
const textoDe = el => { let t = el.textContent || ''; for (const h of el.children || []) t += ' ' + textoDe(h); return t; };
const andar = (el, salida = []) => { salida.push(el); for (const h of el.children || []) andar(h, salida); return salida; };
const buscarBoton = (raiz, texto) => andar(raiz).find(el =>
  el.tagName === 'BUTTON' && (el.textContent || '').trim().startsWith(texto));

function makeBootContext(opciones = {}) {
  const byId = new Map();
  const metas = { 'meta[name="pacosat-token"]': { content: 'token-de-prueba' },
    'meta[name="pacosat-cloud"]': { content: '1' } };
  const headEl = new FakeElement('head');
  const documentStub = {
    getElementById: id => { if (!byId.has(id)) byId.set(id, new FakeElement('div')); return byId.get(id); },
    createElement: tag => new FakeElement(tag),
    createElementNS: (_ns, tag) => new FakeElement(tag),
    createTextNode: text => ({ textContent: String(text) }),
    querySelector: sel => metas[sel] ?? null,
    querySelectorAll: () => [], addEventListener: () => {}, removeEventListener: () => {},
    documentElement: new FakeElement('html'), body: new FakeElement('body'), head: headEl,
    activeElement: null, title: '' };
  const storageStub = (semilla = {}) => { const map = new Map(Object.entries(semilla));
    return { getItem: k => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)),
      removeItem: k => map.delete(k), clear: () => map.clear() }; };
  const fetchStub = async (url, init = {}) => {
    const target = String(url);
    const parteM = /\/parte\/(\w+)/.exec(target);
    if (parteM) { const src = lazyCliente.partes[parteM[1]]?.source || '';
      return { ok: true, status: 200, headers: { get: () => 'text/javascript' },
        json: async () => ({}), text: async () => src, blob: async () => new Blob([]) }; }
    let body = {};
    if (opciones.responder) { const r = await opciones.responder(target, init); if (r !== undefined) body = r; }
    if (body === undefined || body === null) body = {};
    if (target.includes('storage/rev')) body = { rev: 1 };
    else if (target.includes('storage?')) body = [];
    else if (target.includes('/api/status')) body = { settings: { installName: 'PacoSAT', hasLogo: false },
      buildModified: null, cloudRevision: null, profiles: [], jobs: [], inbox: [], mail: {},
      puerta: {}, ejecutor: {}, backupHealth: { enabled: false } };
    return { ok: true, status: 200, headers: { get: () => 'application/json' },
      json: async () => body, text: async () => JSON.stringify(body), blob: async () => new Blob([]) };
  };
  const timer = (fn, ms, ...a) => { const t = setTimeout(fn, ms, ...a); t.unref?.(); return t; };
  const every = (fn, ms, ...a) => { const t = setInterval(fn, ms, ...a); t.unref?.(); return t; };
  const context = vm.createContext({ console, document: documentStub,
    navigator: { onLine: true, userAgent: 'ronda293f-test' },
    location: { href: 'http://127.0.0.1:43729/', search: '', reload: () => {} },
    localStorage: storageStub(opciones.localStorage || {}), sessionStorage: storageStub(),
    fetch: fetchStub, setTimeout: timer, setInterval: every, clearTimeout, clearInterval, queueMicrotask,
    URL: BootURL, URLSearchParams, Blob, TextEncoder, TextDecoder, btoa, atob,
    crypto: webcrypto, DecompressionStream, Node: class FakeNode {}, IntersectionObserver: undefined,
    matchMedia: () => ({ matches: false, addEventListener: () => {}, addListener: () => {} }),
    Option: class extends FakeElement {}, alert: () => {}, confirm: () => true,
    addEventListener: () => {}, removeEventListener: () => {},
    requestAnimationFrame: fn => timer(fn, 0) });
  context.window = context; context.self = context;
  headEl.appendChild = kid => {
    if (kid && typeof kid.textContent === 'string' && kid.textContent)
      vm.runInContext(kid.textContent, context, { filename: 'parte-diferida' });
    return kid;
  };
  return context;
}
async function bootCliente(opciones = {}) {
  const context = makeBootContext(opciones);
  const script = htmlCliente.match(/<script>([\s\S]*?)<\/script>/)[1];
  vm.runInContext(script, context, { filename: 'Faro-Fiscal.html#script' });
  for (let i = 0; i < 12; i++) await new Promise(r => setTimeout(r, 0));
  return context;
}
const asentar = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)); };

/* ================================================================
   F2 · Cliente: la pastilla «Lo que está mal» lleva la lista
   a las ACTIVAS malas aunque la vista guardada sea Archivadas
   ================================================================ */
{
  const avisoMalo = { id: 'av-1', ref: 'saldo:jug-1', clase: 'mal', titulo: 'Aviso malo de juguete',
    detalle: 'Un saldo que no cuadra, de juguete', rfc: OWN, estado: 'abierto', severidad: 'alta',
    creado: Date.now() - 86400000, datos: {}, responsable: 'Paco' };
  const avisoMalo2 = { ...avisoMalo, id: 'av-2', ref: 'saldo:jug-2', titulo: 'Segundo aviso malo de juguete' };
  const context = await bootCliente({
    localStorage: { 'pacosat-filtros-avisos': JSON.stringify({ rfc: '', vista: 'archivadas' }) },
    responder: async target => {
      if (target.includes('/api/notices')) return { avisos: [avisoMalo, avisoMalo2],
        counts: { total: 2, mal: 2, falta: 0, necesita: 0, porConfirmar: 0 },
        porRfc: { [OWN]: 2 }, pospuestas: [], archivadas: [], historial: [],
        canales: { correo: false, push: false } };
      return undefined;
    } });
  vm.runInContext("page = 'avisos'; render();", context);
  await asentar();
  vm.runInContext('render();', context);
  await asentar();
  let cuerpo = textoDe(context.document.getElementById('body'));
  assert.ok(cuerpo.includes('Archivadas'), 'F2: la pantalla arranca en la vista guardada (Archivadas)');
  assert.equal(vm.runInContext('avisosVista', context), 'archivadas', 'F2: la vista inicial es la persistida');
  const pastilla = buscarBoton(context.document.getElementById('body'), 'Lo que está mal: 2');
  assert.ok(pastilla, 'F2: la pastilla «Lo que está mal: 2» existe');
  pastilla.onclick();
  await asentar();
  assert.equal(vm.runInContext('avisosVista', context), 'activas',
    'F2: al pulsar la pastilla, la vista pasa a las activas (en la 2.9.2 se quedaba en Archivadas)');
  cuerpo = textoDe(context.document.getElementById('body'));
  assert.ok(cuerpo.includes('Aviso malo de juguete'),
    'F2: y la lista enseña las activas malas, no «Archivadas · 0»');
  console.log('OK 2.9.3 · F2 — Cliente: la pastilla de clase conmuta la vista a las activas y la lista enseña los avisos malos.');
}

/* ================================================================
   F10 · Cliente: «¿Cuánto vendí?» son solo EMITIDOS
   ================================================================ */
{
  const context = await bootCliente();
  const OCT = new Date().getFullYear() + '-10';
  vm.runInContext(`people = [{ id: '${OWN}', name: 'EMPRESA ALFA SA' }];
    invoices = [
      { id: 'E1', kind: 'I', date: '${OCT}-05', total: '200000.00',
        from: { rfc: '${OWN}', name: 'EMPRESA ALFA SA' }, to: { rfc: 'XAXX010101000', name: 'CLIENTE UNO' } },
      { id: 'E2', kind: 'I', date: '${OCT}-20', total: '143539.11',
        from: { rfc: '${OWN}', name: 'EMPRESA ALFA SA' }, to: { rfc: 'XAXX010101000', name: 'CLIENTE UNO' } },
      { id: 'R1', kind: 'I', date: '${OCT}-07', total: '207884.52',
        from: { rfc: 'PROV010101AAA', name: 'PROVEEDOR' }, to: { rfc: '${OWN}', name: 'EMPRESA ALFA SA' } }];`, context);
  const respuesta = vm.runInContext("answerQuestion('¿Cuánto vendí en octubre?')", context);
  assert.ok(respuesta.text.includes('343,539.11'),
    'F10: la respuesta suma SOLO los emitidos ($343,539.11): «' + respuesta.text.slice(0, 80) + '…»');
  assert.ok(!respuesta.text.includes('551,423.63'),
    'F10: la cifra mezclada de emitidos + recibidos no aparece');
  assert.ok(respuesta.text.includes('solo emitidos'),
    'F10: y la respuesta DICE que son solo emitidos');
  assert.equal(respuesta.invoice?.id, 'E1', 'F10: el mayor que se abre es un emitido');
  const recibidos = vm.runInContext("answerQuestion('¿Cuánto me facturaron en octubre?')", context);
  assert.ok(!String(recibidos.text || recibidos).includes('Vendiste'),
    'F10: «me facturaron» no se disfraza de venta');
  console.log('OK 2.9.3 · F10 — Cliente: las preguntas de ventas filtran por emitidos y lo dicen en la respuesta.');
}

/* ================================================================
   O3 · Cliente: render() re-evalúa la franja de actividad —
   al entrar en una pantalla que ya enseña el trabajo, la
   franja se oculta sin esperar al pulso de 30 s
   ================================================================ */
{
  const context = await bootCliente();
  await vm.runInContext("ensureLazyPart('monitor')", context);
  await vm.runInContext("ensureLazyPart('buzon')", context);
  await asentar();
  const ahora = Date.now();
  context.__act = { running: [
    { kind: 'masiva', key: 'masiva:11', jobId: 11, rfc: OWN, label: 'Solicitud de descarga en el SAT · ' + OWN,
      detail: 'esperando al SAT', phase: 'Esperando al SAT', since: ahora - 60000,
      state: 'esperando', canStop: true, stopLabel: 'Detener' }], paused: [], recent: [], nextAuto: null };
  vm.runInContext('activityView = __act;', context);
  vm.runInContext("page = 'invoices'; paintActivity();", context);
  const jobs = context.document.getElementById('activity-jobs');
  assert.equal(jobs.hidden, true, 'O3: en Facturas la franja NO se ve desde la 2.9.9 (mandato D1: el trabajo vive en la línea fina de la barra y en los paneles propios); lo que O3 sigue fijando es que compone siempre y que su visibilidad sigue a la página al pintar');
  assert.ok(jobs.children.length > 0, 'O3: y compone sus entradas (contrato D8: compone siempre)');
  vm.runInContext("page = 'buzon'; render();", context);
  await asentar();
  assert.equal(jobs.hidden, true,
    'O3: al pintar Novedades la franja se oculta EN EL ACTO (en la 2.9.2 seguía visible hasta el pulso, repitiendo «Trabajo en curso»)');
  console.log('OK 2.9.3 · O3 — Cliente: la visibilidad de la franja sigue a la página al pintar; sin duplicidad en Novedades.');
}

/* ================================================================
   F9 · Cliente: «Revisar ahora la salud» corre con su estado
   visible y la tarjeta repinta con la marca nueva
   ================================================================ */
{
  let frescura = 'sin revisar todavía';
  let sondaAlPedir = null;
  let contextRef = null;
  const context = await bootCliente({
    responder: async target => {
      if (target.includes('salud/coherencia')) {
        sondaAlPedir = vm.runInContext('saludRevisando293', contextRef);
        frescura = 'revisado el 18 nov, 09:05';
        return { ok: true, desacuerdos: [] };
      }
      if (target.includes('/api/salud')) return { at: Date.now(), version: '2.9.3',
        tarjetas: [{ id: 'coherencia', titulo: 'Coherencia interna', queEs: 'El cruce de los datos entre sí.',
          estado: 'bien', porque: 'Todo cuadra.', frescura: Date.now(), frescuraTexto: frescura,
          datos: { desacuerdos: [] } }],
        config: {}, humo: null, auto201: null, paseo: 'nas', ejecutor: {}, puerta: {} };
      if (target.includes('/api/registro')) return { entries: [] };
      return undefined;
    } });
  contextRef = context;
  await vm.runInContext("ensureLazyPart('salud')", context);
  vm.runInContext("page = 'salud'; render();", context);
  await asentar(30);
  let cuerpo = textoDe(context.document.getElementById('body'));
  assert.ok(cuerpo.includes('sin revisar todavía'), 'F9: la tarjeta arranca con su marca vieja');
  await vm.runInContext('saludRevisar200d()', context);
  await asentar(30);
  assert.equal(sondaAlPedir, true,
    'F9: mientras la revisión corre, su estado «Revisando…» está pintado (en la 2.9.2 no había ningún estado visible)');
  assert.equal(vm.runInContext('saludRevisando293', context), false,
    'F9: al terminar, el estado de trabajo se retira');
  cuerpo = textoDe(context.document.getElementById('body'));
  assert.ok(cuerpo.includes('revisado el 18 nov, 09:05'),
    'F9: y la tarjeta repinta con la marca nueva y su veredicto');
  console.log('OK 2.9.3 · F9 — Cliente: la revisión de salud corre con estado visible y refresca marca y veredicto.');
}

/* ================================================================
   F12 · Cliente: la tarjeta de la llave lleva su «Revocar»
   VISIBLE y revoca por la ruta de siempre
   ================================================================ */
{
  const llamadas = [];
  let estadoLlave = 'activa';
  const context = await bootCliente({
    responder: async (target, init) => {
      if (target.includes('apikeys/estado')) {
        const cuerpo = JSON.parse(init?.body || '{}');
        llamadas.push(cuerpo);
        estadoLlave = cuerpo.estado;
        return { llaves: [{ id: 'k1', nombre: 'Prueba barrido 2026-11-18', estado: estadoLlave,
          alcance: 'lectura', rfc: '', creada: Date.now() - 3600000, ultimoUso: null,
          llamadasHoy: 0, llamadasTotal: 0 }], llamadas: [] };
      }
      if (target.includes('/api/apikeys')) return { llaves: [{ id: 'k1',
        nombre: 'Prueba barrido 2026-11-18', estado: estadoLlave, alcance: 'lectura', rfc: '',
        creada: Date.now() - 3600000, ultimoUso: null, llamadasHoy: 0, llamadasTotal: 0 }], llamadas: [] };
      return undefined;
    } });
  vm.runInContext("page = 'settings'; ajustesSection = 'api'; render();", context);
  await asentar(30);
  const boton = buscarBoton(context.document.getElementById('body'), 'Revocar');
  assert.ok(boton,
    'F12: la tarjeta de la llave tiene un botón «Revocar» VISIBLE (en la 2.9.2 solo vivía en el menú «Más opciones»)');
  await boton.onclick();
  await asentar();
  /* 2.9.5 · R1: la confirmación previa ya no es el confirm()
     nativo (en el navegador real se tragaba y el clic moría
     sin llamada: la llave seguía «Activa») — es el diálogo
     propio de la casa; el POST sale al confirmarlo. La
     cobertura completa del camino, contra el servidor real,
     vive en la suite ronda295 (R1). */
  assert.deepEqual(llamadas, [],
    'F12: antes de confirmar en el diálogo propio, no sale ninguna llamada');
  await vm.runInContext('submit()', context);
  await asentar();
  assert.deepEqual(llamadas, [{ id: 'k1', estado: 'revocada' }],
    'F12: confirmado el diálogo, el botón revoca por POST /api/apikeys/estado');
  console.log('OK 2.9.3 · F12 — Cliente: «Revocar» visible en la tarjeta de la llave y funcional (confirmación: el diálogo propio, 2.9.5 · R1).');
}

/* ================================================================
   Cableado del cliente (las piezas cuyo arnés DOM no llega):
   F1 pinta el veredicto, F3 pide el combinado al servidor,
   F6 pasa el RFC y F7 lista los cinco pasos del cierre
   ================================================================ */
{
  const html = htmlCliente;
  assert.ok(html.includes("descargarSalida1310('salidas/xlsx', { kind: 'dinero', rfc: scope }"),
    'F6: la cabecera de Dinero pide el Excel CON el RFC del selector');
  assert.ok(html.includes("satApi('salidas/cfdi', { ids: [...invoiceSelection], format: 'pdf', rfc: scope })"),
    'F3: «Imprimir seleccionados» pide el documento combinado al servidor en modo servidor');
  assert.ok(html.includes("['excel', 'Excel del cierre'], ['csv', 'CSV del cierre']"),
    'F7: la tarjeta del cierre lista los cinco pasos');
  assert.ok(html.includes('r?.probada') && html.includes('La puerta abre: la e.firma entró al portal (probada ahora mismo)'),
    'F1: el gesto de Hoy pinta el veredicto de la prueba cuando el servidor la corre');
  assert.ok(html.includes('backupHealth.verify') || html.includes('bh.verify'),
    'F11: la tarjeta de respaldo pinta la última comprobación servida');
  const fuenteBuzon = lazyCliente.partes.buzon?.source || '';
  assert.ok(fuenteBuzon.includes('se detiene en segundos, en el punto seguro'),
    'O2: el texto de Cancelar del Buzón promete el reflejo real (segundos), no ~2 min');
  console.log('OK 2.9.3 · Cableado — F1/F3/F6/F7/F11/O2 presentes en el cliente construido.');
}

console.log('OK suite ronda293fallos completa');
