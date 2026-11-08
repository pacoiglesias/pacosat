import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createMonitor, parseEfos, soapQuery } from './sat-monitor.mjs';
const day = 86400000, hour = 3600000;
const cfdi = { id: '12345678-1234-1234-1234-1234567890AB', emitter: 'AAA010101AAA', receiver: 'XAXX010101000', total: '80.50', seal: '+/abcd==' };
assert.match(soapQuery(cfdi), /tt=80\.500000&amp;fe=%2B%2Fabcd%3D%3D/);
assert.throws(() => soapQuery({ ...cfdi, total: '1e20' }), /datos requeridos/);
const efos = parseEfos('Listado 69-B\r\nNo.,RFC,Nombre del Contribuyente,Situación del contribuyente\r\n1,AAA010101AAA,"Nombre, SA",Presunto\r\n2,AAA010101AAA,Nombre,Definitivo\r\n3,BBB010101BBB,Otro,Sentencia favorable');
assert.deepEqual([...efos.get(cfdi.emitter)], ['Presunto','Definitivo']);
assert.throws(() => parseEfos('<html>error</html>'), /columnas/);
let time = 1700000000000, status = 'Vigente', fail = false, sends = 0;
const db = new DatabaseSync(':memory:');
const monitor = createMonitor(db, { now: () => time, refreshEfos: async () => {
  if (fail) throw new Error('Fallo del listado');
  return efos;
}, checkSat: async () => {
  if (fail) throw new Error('Fallo del SAT');
  return { state: status, code: 'S', efos: '', cancellation: '' };
}, notifyCancellation: async item => { assert.equal(item.id, cfdi.id); sends++; return true; } });
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
  console.log('OK: expresión SAT, CSV 69-B, conservación del resultado, cancelación y aviso sin repetir.');
} finally { db.close(); }
