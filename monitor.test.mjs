import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createMonitor, parseEfos, soapQuery, normalizeTotalForQuery, querySat } from './sat-monitor.mjs';
const day = 86400000, hour = 3600000;
const cfdi = { id: '12345678-1234-1234-1234-1234567890AB', emitter: 'AAA010101AAA', receiver: 'XAXX010101000', total: '80.50', seal: '+/abcd==' };
/* Expresión impresa normalizada (1.9.0, barrido de comunidades): el
   total va sin ceros no significativos — el formato de seis decimales
   es la causa documentada del N-601 — y el UUID en mayúsculas. */
assert.match(soapQuery(cfdi), /tt=80\.5&amp;fe=%2B%2Fabcd%3D%3D/);
assert.equal(normalizeTotalForQuery('0.99'), '0.99');
assert.equal(normalizeTotalForQuery('1.00'), '1.0');
assert.equal(normalizeTotalForQuery('0.00'), '0.0');
assert.equal(normalizeTotalForQuery('115860.80'), '115860.8');
assert.equal(normalizeTotalForQuery('204000'), '204000.0');
assert.match(soapQuery({ ...cfdi, id: cfdi.id.toLowerCase() }), /id=12345678-1234-1234-1234-1234567890AB/);
/* N-601 y N-602 se distinguen: formato rechazado ≠ no encontrado. */
{
  const acuseXml = (code) => '<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>' +
    '<ConsultaResponse xmlns="http://tempuri.org/"><ConsultaResult xmlns:a="http://schemas.datacontract.org/2004/07/Sat.Cfdi.Negocio.ConsultaCfdi.Servicio" xmlns:i="http://www.w3.org/2001/XMLSchema-instance">' +
    '<a:CodigoEstatus>' + code + '</a:CodigoEstatus><a:EsCancelable>NoCancelable</a:EsCancelable><a:Estado></a:Estado>' +
    '<a:EstatusCancelacion></a:EstatusCancelacion><a:ValidacionEFOS></a:ValidacionEFOS></ConsultaResult></ConsultaResponse></s:Body></s:Envelope>';
  const fakeRequest = (code) => async () => ({ ok: true, status: 200,
    body: (async function* () { yield Buffer.from(acuseXml(code)); })() });
  assert.equal((await querySat(cfdi, fakeRequest('N - 601'))).state, 'Formato rechazado');
  assert.equal((await querySat(cfdi, fakeRequest('N - 602'))).state, 'No encontrado');
}
assert.throws(() => soapQuery({ ...cfdi, total: '1e20' }), /datos requeridos/);
const efos = parseEfos('Listado 69-B\r\nNo.,RFC,Nombre del Contribuyente,Situación del contribuyente\r\n1,AAA010101AAA,"Nombre, SA",Presunto\r\n2,AAA010101AAA,Nombre,Definitivo\r\n3,BBB010101BBB,Otro,Sentencia favorable');
assert.deepEqual([...efos.get(cfdi.emitter)], ['Presunto','Definitivo']);
assert.throws(() => parseEfos('<html>error</html>'), /columnas/);
let time = 1700000000000, status = 'Vigente', fail = false, sends = 0;
let efosData = efos; const efosSends = [];
const db = new DatabaseSync(':memory:');
const monitor = createMonitor(db, { now: () => time, refreshEfos: async () => {
  if (fail) throw new Error('Fallo del listado');
  return efosData;
}, checkSat: async () => {
  if (fail) throw new Error('Fallo del SAT');
  return { state: status, code: 'S', efos: '', cancellation: '' };
}, notifyCancellation: async item => { assert.equal(item.id, cfdi.id); sends++; return true; },
  notifyEfos: async alert => { efosSends.push(alert); return true; } });
try {
  monitor.register(cfdi);
  await monitor.tick();
  assert.equal(monitor.status([cfdi.id]).results[0].sat.state, 'Vigente');
  time += day; fail = true;
  await monitor.tick();
  assert.equal(monitor.status([cfdi.id]).results[0].sat.state, 'Vigente');
  assert.equal(monitor.status([cfdi.id]).results[0].error, 'Fallo del SAT');
  assert.equal(monitor.status([cfdi.id]).results[0].efos.length, 2);
  fail = false; status = 'Cancelado'; time += hour;
  await monitor.tick();
  assert.equal(monitor.status([cfdi.id]).results[0].sat.state, 'Cancelado');
  assert.equal(sends, 1);
  time += day;
  await monitor.tick();
  assert.equal(sends, 1);
  assert.equal(efosSends.length, 0);
  const efos2 = new Map(efosData);
  efos2.set(cfdi.receiver, new Set(['Definitivo']));
  efos2.set('CCC010101CCC', new Set(['Definitivo']));
  efosData = efos2;
  time += day + hour;
  await monitor.tick();
  assert.equal(efosSends.length, 1);
  assert.equal(efosSends[0].rfc, cfdi.receiver);
  assert.deepEqual(efosSends[0].statuses, ['Definitivo']);
  time += day;
  await monitor.tick();
  assert.equal(efosSends.length, 1);
  console.log('OK: expresión SAT, CSV 69-B, conservación del resultado, cancelación y aviso sin repetir, alta 69-B de un RFC del expediente sin repetir y sin avisar RFC ajenos.');
} finally { db.close(); }
