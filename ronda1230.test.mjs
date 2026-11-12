/* Ronda 1.23.0 — el plan futuro íntegro, juzgado por frentes:
   - E: frontera de prescripción rodante (2020 fuera / 2021 vivo),
     cierre de línea base con dry-run, ejecución idempotente, nota
     trazable, Dinero sin lo archivado y archivo consultable;
   - B: Buzón por contribuyente (leído/no leído persistido,
     contador en /api/status, aislamiento por RFC, y lo archivado
     por el cierre tampoco vive en la bandeja);
   - A3: diario de corrida de declaraciones por pasos (éxito y
     fallo quedan escritos y se consultan por la API);
   - A2: la subida manual del fallback casa con el mapa (el acuse
     soltado a mano rellena la celda como la descarga automática);
   - D2 (lado servidor): responder «sí» dos veces al mismo aviso
     no duplica la marca de pago — la segunda respuesta dice que
     ya no está abierto y el estado re-leído manda;
   - C: /api/status trae backupHealth y la verificación de
     integridad responde con verdad cuando no hay respaldo
     configurado (error claro, sin inventar un «correcto»). */
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DOMParser } from '@xmldom/xmldom';
import { createPacoSATService } from './local-server.mjs';
import { parseXml } from './xml-core.mjs';

const ORIGIN = 'https://pacosat.test';
const KEY = 'e'.repeat(64);
const OWN = 'AAA010101AAA';
const BBB = 'BBB010101BB1';
const PDF = Buffer.from('%PDF-1.4\n%respaldo de prueba\n');

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
    if (!token) { const home = await raw('GET', '/'); token = /[0-9a-f]{64}/.exec(home.text)?.[0] || ''; }
    const r = await raw(method, path, body, { 'x-pacosat-token': token });
    let json = null; try { json = JSON.parse(r.text); } catch { /* binario */ }
    return { status: r.status, json, text: r.text, headers: r.headers };
  };
  return { call };
}
const makeService = (options = {}) => {
  const service = createPacoSATService({
    dbFile: ':memory:', html: '<html><head><!--PACOSAT_TOKEN--></head><body>prueba</body></html>',
    origin: ORIGIN, proxyKey: KEY, satDocRetryWaitMs: 5,
    makeConnector: () => ({ parser: DOMParser, connector: {
      request: async () => 'req-b', check: async () => ({ status: 'pending', packages: [] }),
      download: async () => { throw new Error('sin paquetes'); } } }),
    makeMailer: () => ({ verify: async () => true, sendMail: async () => ({ messageId: 'm1' }) }),
    ...options });
  return { service, ...harness(service) };
};
const unlock = async (h, rfc = OWN) => {
  const open = await h.call('POST', '/api/unlock', { rfc, minutes: 1440, days: 7,
    direction: 'both', password: 'simulated', certificate: 'YQ==', key: 'Yg==' });
  assert.equal(open.status, 200);
};
const xmlCfdi = ({ uuid, fecha, emisor, receptor, total, folio = '' }) => {
  const sub = (Number(total) / 1.16).toFixed(2);
  const tax = (Number(total) - Number(sub)).toFixed(2);
  return `<?xml version="1.0" encoding="UTF-8"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital" Version="4.0"${folio ? ` Folio="${folio}"` : ''} Fecha="${fecha}" SubTotal="${sub}" Moneda="MXN" Total="${total}" TipoDeComprobante="I" MetodoPago="PPD" FormaPago="99" LugarExpedicion="72000">
<cfdi:Emisor Rfc="${emisor}" Nombre="EMISOR SA" RegimenFiscal="601"/>
<cfdi:Receptor Rfc="${receptor}" Nombre="RECEPTOR SA" DomicilioFiscalReceptor="72000" RegimenFiscalReceptor="601" UsoCFDI="G03"/>
<cfdi:Conceptos><cfdi:Concepto ClaveProdServ="01010101" Cantidad="1" ClaveUnidad="H87" Descripcion="Servicio" ValorUnitario="${sub}" Importe="${sub}" ObjetoImp="02"><cfdi:Impuestos><cfdi:Traslados><cfdi:Traslado Base="${sub}" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="${tax}"/></cfdi:Traslados></cfdi:Impuestos></cfdi:Concepto></cfdi:Conceptos>
<cfdi:Impuestos TotalImpuestosTrasladados="${tax}"><cfdi:Traslados><cfdi:Traslado Base="${sub}" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="${tax}"/></cfdi:Traslados></cfdi:Impuestos>
<cfdi:Complemento><tfd:TimbreFiscalDigital Version="1.1" UUID="${uuid}" FechaTimbrado="${fecha}" RfcProvCertif="SAT970701NN3" SelloCFD="AAAA" NoCertificadoSAT="00001000000500000001" SelloSAT="BBBB"/></cfdi:Complemento>
</cfdi:Comprobante>`;
};

/* ===== E · La frontera de prescripción rueda sola ===== */
for (const [cuando, corte] of [['2026-03-31T15:00:00Z', 2020], ['2026-04-01T15:00:00Z', 2021],
    ['2026-11-11T17:00:00Z', 2021], ['2027-04-01T15:00:00Z', 2022]]) {
  const h = makeService({ now: () => Date.parse(cuando) });
  await unlock(h);
  const dry = await h.call('POST', '/api/admin/baseline-close', { dryRun: true });
  assert.equal(dry.status, 200);
  assert.equal(dry.json.corte.primerEjercicioVivo, corte, 'corte a ' + cuando);
  assert.equal(dry.json.ejecutado, false);
}

/* ===== Servicio compartido: B, D2, E y C ===== */
const dir = mkdtempSync(join(tmpdir(), 'pacosat-1230-'));
const dbFile = join(dir, 'pacosat.sqlite');
const AHORA = Date.parse('2026-11-11T17:00:00Z');
const h = makeService({ dbFile, now: () => AHORA });
await unlock(h, OWN);
await unlock(h, BBB);
const U2019 = '12300000-2019-4000-8000-000000002019';
const U2026 = '12300000-2026-4000-8000-000000002026';
const xmls = [
  xmlCfdi({ uuid: U2019, fecha: '2019-05-10T10:00:00', emisor: BBB, receptor: OWN, total: '1160.00', folio: '19' }),
  xmlCfdi({ uuid: U2026, fecha: '2026-10-05T10:00:00', emisor: BBB, receptor: OWN, total: '2320.00', folio: '26' })];
const rows = xmls.map(xml => parseXml(Buffer.from(xml), DOMParser));
const seed = await h.call('POST', '/api/storage', { batch: {
  people: [{ id: OWN, name: 'EMPRESA PROPIA SA' }, { id: BBB, name: 'PROVEEDOR SA' }],
  invoices: rows,
  files: xmls.map((xml, i) => ({ id: 'xml:' + rows[i].id, mime: 'application/xml',
    content: Buffer.from(xml).toString('base64') })) } });
assert.equal(seed.status, 200);
/* Tres avisos de la línea base: dos por cerrar y uno para el
   camino de «Ya se pagó» (su factura es la de 2026). */
const db = new DatabaseSync(dbFile);
const insAviso = db.prepare(`INSERT INTO avisos(ref,kind,clase,estado,titulo,importe,datos,baseline,creado,actualizado)
  VALUES (?,?,?,?,?,?,?,?,?,?)`);
insAviso.run('saldo:fake-2018', 'saldo', 'falta', 'por-confirmar', 'Saldo viejo 1', '1000.25', '{}', 1, AHORA, AHORA);
insAviso.run('saldo:fake-2019', 'saldo', 'falta', 'por-confirmar', 'Saldo viejo 2', '2000.25', '{}', 1, AHORA, AHORA);
insAviso.run('saldo:' + U2026, 'saldo', 'necesita', 'por-confirmar', 'Saldo 2026', '2320.00',
  JSON.stringify({ uuid: U2026 }), 1, AHORA, AHORA);
const idAviso2026 = db.prepare("SELECT id FROM avisos WHERE ref='saldo:' || ?").get(U2026).id;
/* Un documento del SAT para la bandeja. */
const up = await h.call('POST', '/api/satdocs/upload', { rfc: OWN, kind: 'constancia',
  date: '2026-11-01', content: PDF.toString('base64'), name: 'constancia.pdf' });
assert.equal(up.status, 200);

/* ===== B · Buzón: bandeja, leído persistido, aislamiento ===== */
let buzon = await h.call('GET', '/api/buzon?rfc=' + OWN);
assert.equal(buzon.status, 200);
assert.equal(buzon.json.unread, 3, 'dos CFDI + la constancia, todo sin leer');
assert.ok(buzon.json.items.some(item => item.kind === 'cfdi' && item.uuid === U2026.toLowerCase() || item.uuid === U2026));
assert.ok(buzon.json.items.some(item => item.kind === 'documento' && item.fileId), 'el documento trae su fileId para el «Ver»');
let status = await h.call('GET', '/api/status');
assert.equal(status.json.buzonUnread[OWN], 3, 'el contador de Hoy sale del servidor');
const claveCfdi = buzon.json.items.find(item => item.kind === 'cfdi').key;
let read = await h.call('POST', '/api/buzon/read', { rfc: OWN, keys: [claveCfdi] });
assert.equal(read.json.unread, 2);
read = await h.call('POST', '/api/buzon/read', { rfc: OWN, all: true });
assert.equal(read.json.unread, 0);
buzon = await h.call('GET', '/api/buzon?rfc=' + BBB);
assert.equal(buzon.json.items.length, 0, 'aislamiento: el buzón de otro RFC va vacío');
assert.equal(buzon.json.unread, 0);

/* ===== Dinero antes del cierre: la de 2019 consta por pagar ===== */
let money = await h.call('GET', '/api/money?rfc=' + OWN);
assert.ok(money.json.balances.some(b => b.id === U2019 && b.balance === '1160.00'));

/* ===== D2 · «Ya se pagó» dos veces: una sola marca ===== */
const ans1 = await h.call('POST', '/api/notices/answer', { id: idAviso2026, respuesta: 'si' });
assert.equal(ans1.status, 200);
assert.equal(db.prepare('SELECT COUNT(*) n FROM manual_payments WHERE uuid=?').get(U2026).n, 1);
const ans2 = await h.call('POST', '/api/notices/answer', { id: idAviso2026, respuesta: 'si' });
assert.ok(ans2.status >= 400, 'la segunda respuesta dice la verdad: ya no está abierto');
assert.equal(db.prepare('SELECT COUNT(*) n FROM manual_payments WHERE uuid=?').get(U2026).n, 1,
  'sin duplicar la marca: la re-lectura del cliente manda');
assert.equal(db.prepare('SELECT estado FROM avisos WHERE id=?').get(idAviso2026).estado, 'solventado');
money = await h.call('GET', '/api/money?rfc=' + OWN);
const bal2026 = money.json.balances.find(b => b.id === U2026);
assert.ok(!bal2026 || bal2026.balance === '0.00', 'la de 2026 ya no consta por pagar');

/* ===== E · Cierre de línea base: dry-run, ejecución, idempotencia ===== */
const dry = await h.call('POST', '/api/admin/baseline-close', { dryRun: true });
assert.equal(dry.json.corte.primerEjercicioVivo, 2021);
assert.deepEqual(dry.json.avisos, { count: 2, sum: 3000.50 });
assert.deepEqual(dry.json.comprobantes, { count: 1, sum: 1160, ilegibles: 0 });
assert.equal(dry.json.ejecutado, false);
const run = await h.call('POST', '/api/admin/baseline-close', { dryRun: false });
assert.equal(run.json.ejecutado, true);
assert.equal(run.json.avisos.count, 2);
const cerrados = db.prepare("SELECT estado, resolucion FROM avisos WHERE ref LIKE 'saldo:fake-%'").all();
assert.ok(cerrados.every(a => a.estado === 'descartado' && a.resolucion.startsWith('Cierre de línea base')),
  'cerrados con la nota fija trazable');
assert.ok(db.prepare("SELECT 1 FROM avisos_acciones WHERE accion='cierre-linea-base'").get(), 'acción en bitácora');
assert.equal(db.prepare("SELECT archived FROM records WHERE store='invoices' AND id=?").get(U2019.toLowerCase())?.archived ??
  db.prepare("SELECT archived FROM records WHERE store='invoices' AND id=?").get(U2019)?.archived, 1);
/* Dinero ya no enseña lo archivado; el archivo sí lo guarda. */
money = await h.call('GET', '/api/money?rfc=' + OWN);
assert.ok(!money.json.balances.some(b => b.id === U2019), 'la de 2019 desaparece de Dinero');
const archivo = await h.call('GET', '/api/storage?store=invoices');
assert.ok(JSON.stringify(archivo.json).includes('2019'), 'el archivo consultable conserva el registro');
/* Ni un tick posterior resucita los saldos cerrados. */
await h.service.tick();
assert.ok(db.prepare("SELECT estado FROM avisos WHERE ref LIKE 'saldo:fake-%'").all()
  .every(a => a.estado === 'descartado'), 'el cierre sobrevive a la sincronización de avisos');
/* El Buzón tampoco enseña lo archivado. */
buzon = await h.call('GET', '/api/buzon?rfc=' + OWN);
assert.ok(!buzon.json.items.some(item => item.uuid === U2019 || item.uuid === U2019.toLowerCase()),
  'lo archivado no vive en la bandeja');
/* Idempotente: la segunda ejecución no encuentra nada. */
const run2 = await h.call('POST', '/api/admin/baseline-close', { dryRun: false });
assert.equal(run2.json.avisos.count, 0);
assert.equal(run2.json.comprobantes.count, 0);

/* ===== C · Salud del respaldo en el estado; verify dice la verdad ===== */
status = await h.call('GET', '/api/status');
assert.ok(status.json.backupHealth, 'backupHealth viaja en /api/status');
assert.equal(status.json.backupHealth.enabled, false);
assert.equal(status.json.backupHealth.stale, false);
const verify = await h.call('POST', '/api/backup/verify', {});
assert.ok(verify.status >= 400 && /no está configurado/.test(verify.json?.error || verify.text),
  'sin respaldo configurado, la comprobación lo dice — no finge un correcto');
db.close();
rmSync(dir, { recursive: true, force: true });

/* ===== A3 · Diario de corrida: éxito y fallo quedan escritos ===== */
const pasosVistos = [];
const fakeOk = async (profile, query, opts) => {
  opts?.onStep?.('Acceso al portal OK', '');
  opts?.onStep?.('Enlace del trámite', 'encontrado');
  opts?.onStep?.('Resultados leídos', '1 acuse');
  pasosVistos.push(...['a', 'b', 'c']);
  return { found: 1, warnings: [], documents: [
    { clase: 'acuse', ejercicio: query.ejercicio, periodo: '2026-10',
      fechaPresentacion: '2026-11-05', operacion: 'OP-123', content: PDF }] };
};
const hOk = makeService({ now: () => AHORA, satDeclFetch: fakeOk });
await unlock(hOk);
const corrida = await hOk.call('POST', '/api/declaraciones/run', { rfc: OWN, tipo: 'mensual', ejercicio: 2026 });
assert.equal(corrida.status, 200);
let runs = await hOk.call('GET', '/api/declaraciones/runs?rfc=' + OWN);
assert.equal(runs.json.runs.length, 1);
assert.equal(runs.json.runs[0].ok, true);
assert.equal(runs.json.runs[0].steps.length, 3, 'el diario guarda los pasos del motor con su hora');
assert.ok(runs.json.runs[0].steps.some(s => s.paso === 'Acceso al portal OK'));
assert.ok(runs.json.runs[0].steps.every(s => s.at > 0 && s.intento === 1));
const fakeFail = async () => { const e = new Error('credencial rechazada de juguete'); e.code = 'credencial-invalida'; throw e; };
const hFail = makeService({ now: () => AHORA, satDeclFetch: fakeFail });
await unlock(hFail);
await hFail.call('POST', '/api/declaraciones/run', { rfc: OWN, tipo: 'mensual', ejercicio: 2026 });
runs = await hFail.call('GET', '/api/declaraciones/runs?rfc=' + OWN);
assert.equal(runs.json.runs[0].ok, false);
assert.equal(runs.json.runs[0].errorKind, 'credencial-invalida');
runs = await hFail.call('GET', '/api/declaraciones/runs?rfc=' + BBB);
assert.equal(runs.json.runs.length, 0, 'el diario también es por contribuyente');

/* ===== A2 · El acuse soltado a mano casa con el mapa ===== */
const hMan = makeService({ now: () => AHORA });
await unlock(hMan);
let vista = await hMan.call('GET', '/api/declaraciones?rfc=' + OWN + '&ejercicio=2026');
assert.equal(vista.json.mapa.meses[9].estado !== 'presentada', true);
const subido = await hMan.call('POST', '/api/declaraciones/upload', { rfc: OWN, tipo: 'mensual',
  clase: 'acuse', ejercicio: 2026, periodo: '2026-10', content: PDF.toString('base64') });
assert.equal(subido.status, 200);
assert.equal(subido.json.filed, true);
assert.equal(subido.json.view.mapa.meses[9].estado, 'presentada', 'la celda se marca al momento');
assert.ok(subido.json.view.documentos.some(d => d.clase === 'acuse' && d.fileId), 'y el PDF queda en Expedientes');
const repetido = await hMan.call('POST', '/api/declaraciones/upload', { rfc: OWN, tipo: 'mensual',
  clase: 'acuse', ejercicio: 2026, periodo: '2026-10', content: PDF.toString('base64') });
assert.equal(repetido.json.filed, false, 'el mismo acuse no se duplica');
const malo = await hMan.call('POST', '/api/declaraciones/upload', { rfc: OWN, tipo: 'mensual',
  clase: 'acuse', ejercicio: 2026, periodo: '2025-10', content: PDF.toString('base64') });
assert.ok(malo.status >= 400, 'un periodo de otro ejercicio se rechaza');

console.log('ronda1230.test.mjs: OK (E frontera y cierre, B, D2, C, A3, A2)');
