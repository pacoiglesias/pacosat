import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createPacoSATService } from './local-server.mjs';

/* Listas negras (1.6.13): descarga con fetch de juguete (NUNCA la red
   real), línea base, transiciones, validador, importación manual y
   carga masiva del padrón. */
const origin = 'http://127.0.0.1:43731';
let time = Date.parse('2026-11-08T16:00:00Z');
const DUMMY = 'XXX010101XXX';
const fixtures = {
  '69b': 'Información actualizada al 09 de octubre de 2026\r\nNo.,RFC,Nombre del Contribuyente,Situación del contribuyente\r\n' +
    '1,AAA010101AAA,EMPRESA ALFA SA DE CV,Definitivo\r\n2,' + DUMMY + ',OTRA SA,Presunto\r\n',
  '69b-bis': 'Información actualizada al 09 de octubre de 2026\r\nNo.,RFC,Nombre del Contribuyente,Situación del contribuyente\r\n' +
    '1,' + DUMMY + ',OTRA SA,Definitivo\r\n',
  '69-firmes': 'RFC,RAZON SOCIAL,TIPO PERSONA,SUPUESTO,FECHA DE PRIMERA PUBLICACION,ENTIDAD FEDERATIVA\r\n' +
    'CCC030303CCA,EMPRESA GAMA SA,MORAL,FIRMES,15/01/2025,CIUDAD DE MEXICO\r\n'
};
const generic = () => 'RFC,RAZON SOCIAL,SUPUESTO,FECHA\r\n' + DUMMY + ',OTRA SA,X,01/01/2025\r\n';
let failing = false;
const service = createPacoSATService({ dbFile: ':memory:', html: '<!--PACOSAT_TOKEN-->', origin, now: () => time,
  listFetch: async source => { if (failing) throw new Error('fuente caída de juguete'); return fixtures[source.id] || generic(); } });
let token;
async function call(path, data, options = {}) {
  const headers = { host: new URL(origin).host, origin, 'x-pacosat-token': token, ...options };
  const req = Object.assign(Readable.from(data === undefined ? [] : [Buffer.from(JSON.stringify(data))]), {
    url: path, method: data === undefined ? 'GET' : 'POST', headers });
  let response;
  const res = { setHeader() {}, writeHead(status) { this.status = status; this.headersSent = true; },
    end(content) { response = new Response(content, { status: this.status }); } };
  await service.handle(req, res);
  return response;
}
try {
  const page = await (await call('/')).text();
  token = page.split('content="')[1].split('"')[0];

  /* Padrón previo a la primera descarga: la línea base debe avisar. */
  let res = await call('/api/lists/counterparts', { rfc: 'AAA010101AAA', name: 'EMPRESA ALFA SA DE CV', kind: 'Proveedor', note: '' });
  assert.equal(res.status, 200);
  res = await call('/api/lists/counterparts', { rfc: 'CCC030303CCA', name: 'EMPRESA GAMA SA', kind: 'Cliente', note: '' });
  assert.equal(res.status, 200);

  res = await call('/api/lists/refresh', {});
  assert.equal(res.status, 200);
  let data = await res.json();
  const list69b = data.sources.find(source => source.id === '69b');
  assert.equal(list69b.count, 2);
  assert.equal(list69b.declared, '09 de octubre de 2026');
  assert.ok(list69b.fetched > 0);
  const alfa = data.counterparts.find(cp => cp.rfc === 'AAA010101AAA');
  assert.equal(alfa.severity, 'bad');
  assert.equal(alfa.hits[0].detail, 'Definitivo');
  const gama = data.counterparts.find(cp => cp.rfc === 'CCC030303CCA');
  assert.equal(gama.severity, 'bad'); /* Firmes también es grave. */
  assert.ok(data.events.some(event => event.rfc === 'AAA010101AAA' && event.change.startsWith('Línea base')));

  /* Validador: por RFC y por nombre. */
  let validation = await (await call('/api/lists/validate', { query: 'AAA010101AAA' })).json();
  assert.equal(validation.matches.length, 1);
  assert.equal(validation.matches[0].severity, 'bad');
  validation = await (await call('/api/lists/validate', { query: 'gama' })).json();
  assert.equal(validation.matches.length, 1);
  validation = await (await call('/api/lists/validate', { query: 'empresa inexistente' })).json();
  assert.equal(validation.matches.length, 0);

  /* Transición: Alfa sale del 69-B → evento de baja y semáforo limpio. */
  fixtures['69b'] = 'Información actualizada al 10 de octubre de 2026\r\nNo.,RFC,Nombre del Contribuyente,Situación del contribuyente\r\n' +
    '1,' + DUMMY + ',OTRA SA,Presunto\r\n';
  data = await (await call('/api/lists/refresh', {})).json();
  assert.ok(data.events.some(event => event.rfc === 'AAA010101AAA' && event.change.startsWith('Baja')));
  assert.equal(data.counterparts.find(cp => cp.rfc === 'AAA010101AAA').severity, 'none');

  /* Importación manual de un listado sin URL (CSD sin efectos). */
  await call('/api/lists/counterparts', { rfc: 'DDD040404DDA', name: 'EMPRESA DELTA SA', kind: 'Proveedor', note: '' });
  const csdCsv = 'RFC,RAZON SOCIAL,SUPUESTO\r\nDDD040404DDA,EMPRESA DELTA SA,CSD SIN EFECTOS\r\n';
  res = await call('/api/lists/import', { listId: '69-csd', content: Buffer.from(csdCsv).toString('base64') });
  assert.equal(res.status, 200);
  data = await res.json();
  assert.equal(data.counterparts.find(cp => cp.rfc === 'DDD040404DDA').severity, 'bad');
  assert.ok(data.sources.find(source => source.id === '69-csd').fetched > 0);

  /* Carga masiva: una fila buena y una con RFC imposible. */
  res = await call('/api/lists/counterparts/bulk', { rows: [
    { name: 'BULK UNO SA', rfc: 'EEE050505EEA', note: 'de la hoja' },
    { name: 'MALA', rfc: 'BAD', note: '' }] });
  data = await res.json();
  assert.deepEqual(data.bulk, { saved: 1, skipped: 1 });
  assert.ok(data.counterparts.some(cp => cp.rfc === 'EEE050505EEA' && cp.note === 'de la hoja'));

  /* Fuente caída: el error queda registrado para el semáforo. */
  failing = true;
  time += 25 * 3600 * 1000;
  data = await (await call('/api/lists/refresh', {})).json();
  assert.ok(data.sources.find(source => source.id === '69b').error.includes('juguete'));

  console.log('lists.test: ok');
} finally { await service.close(); }
