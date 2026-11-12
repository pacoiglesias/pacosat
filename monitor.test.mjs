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
/* El elemento SOAP es «expresionImpresa» con I mayúscula (10 nov
   2026): en minúsculas el SAT recibía la expresión vacía y
   respondía N-601 a todo; probado en vivo con 3 CFDI reales, donde
   con la capitalización correcta responde «S · Vigente». Se fija
   el nombre exacto Y la forma completa del sobre para que nadie
   «lo simplifique» otra vez. */
{
  const body = soapQuery(cfdi);
  assert.ok(body.includes('<expresionImpresa>'), 'el elemento abre como expresionImpresa');
  assert.ok(body.includes('</expresionImpresa>'), 'el elemento cierra como expresionImpresa');
  assert.ok(!body.includes('expresionimpresa'), 'nunca en minúsculas');
  assert.equal(body, '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><Consulta xmlns="http://tempuri.org/"><expresionImpresa>' +
    '?id=12345678-1234-1234-1234-1234567890AB&amp;re=AAA010101AAA&amp;rr=XAXX010101000&amp;tt=80.5&amp;fe=%2B%2Fabcd%3D%3D' +
    '</expresionImpresa></Consulta></s:Body></s:Envelope>');
}
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
/* Migración única reset-n601-2026-11: limpia SOLO los veredictos
   «Formato rechazado» envenenados por el elemento en minúsculas,
   una sola vez (marca persistente), sin tocar los demás estados. */
{
  const db2 = new DatabaseSync(':memory:');
  const opts = { now: () => 1700000000000, checkSat: async () => ({ state: 'Vigente', code: 'S', efos: '', cancellation: '' }), refreshEfos: async () => new Map() };
  createMonitor(db2, opts); // crea las tablas
  /* Estado heredado de la 1.11.0: filas ya consultadas y NINGUNA
     marca de migración (la tabla nace vacía en las bases viejas).
     Se borra la marca que el arranque anterior acaba de escribir
     para reproducir ese estado antes de sembrar las filas. */
  db2.exec('DELETE FROM monitor_migrations');
  const put = db2.prepare('INSERT INTO cfdi_watch(id,emitter,receiver,total,seal,next,checked,result) VALUES (?,?,?,?,?,?,?,?)');
  const base = ['AAA010101AAA', 'XAXX010101000', '80.50', ''];
  const row = (n, state) => ['12345678-1234-1234-1234-1234567890A' + n, ...base, 999, 555, JSON.stringify({ state, code: 'X' })];
  put.run(...row('1', 'Formato rechazado'));
  put.run(...row('2', 'Vigente'));
  put.run(...row('3', 'Cancelado'));
  put.run(...row('4', 'No encontrado'));
  createMonitor(db2, opts); // segundo arranque: la migración corre aquí
  const get = db2.prepare('SELECT result, checked, next FROM cfdi_watch WHERE id=?');
  const id = n => '12345678-1234-1234-1234-1234567890A' + n;
  const plain = n => ({ ...get.get(id(n)) }); // node:sqlite devuelve prototipo nulo
  assert.deepEqual(plain('1'), { result: null, checked: null, next: 0 });
  for (const n of ['2', '3', '4']) {
    const kept = get.get(id(n));
    assert.ok(kept.result !== null && kept.checked === 555 && kept.next === 999, 'no toca el estado ' + n);
  }
  assert.ok(db2.prepare("SELECT name FROM monitor_migrations WHERE name='reset-n601-2026-11'").get(), 'la marca quedó guardada');
  /* Idempotencia y «una sola vez»: un «Formato rechazado» NUEVO,
     posterior a la migración, ya no se limpia al rearrancar. */
  put.run(...row('5', 'Formato rechazado'));
  createMonitor(db2, opts);
  createMonitor(db2, opts);
  assert.ok(get.get(id('5')).result !== null, 'la migración no se repite');
  assert.deepEqual(plain('1'), { result: null, checked: null, next: 0 });
  db2.close();
  console.log('OK: migración N-601 de una sola vez — limpia solo «Formato rechazado», idempotente y sin tocar Vigente/Cancelado/No encontrado.');
}
