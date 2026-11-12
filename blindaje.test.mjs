import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPacoSATService } from './local-server.mjs';
import { advanceSatJob } from './sat-direct.mjs';

/* Blindaje (1.6.15): intención 5002 antes de enviar, «presunto
   enviado» al arrancar, contador 5008 por paquete con estado terminal
   y durabilidad synchronous=FULL. Todo con conectores de juguete. */

/* --- Nº 3: advanceSatJob deja de descargar a la tercera vez --- */
{
  let downloads = 0;
  const attempts = new Map();
  const connector = {
    check: async () => ({ status: 'finished', packages: ['pkg-1'] }),
    download: async id => { downloads++; return Buffer.from('zip'); }
  };
  const job = { status: 'pending', requestId: 'req-1', imported: [] };
  const save = async next => Object.assign(job, next);
  const hooks = { beforeDownload: async id => {
    const n = (attempts.get(id) || 0) + 1; attempts.set(id, n); return n <= 2; } };
  const failingImport = async () => { throw new Error('importación de juguete que falla'); };
  await assert.rejects(() => advanceSatJob(connector, job, save, failingImport, hooks));
  await assert.rejects(() => advanceSatJob(connector, job, save, failingImport, hooks));
  const third = await advanceSatJob(connector, job, save, failingImport, hooks);
  assert.equal(third.status, 'exhausted');
  assert.equal(third.exhaustedPackage, 'pkg-1');
  assert.equal(downloads, 2); /* la tercera vez NI se descarga */
  console.log('blindaje 5008: ok');
}

/* --- Nº 1 y nº 4: intención, presunto enviado y PRAGMA --- */
assert.ok(readFileSync(new URL('./local-server.mjs', import.meta.url), 'utf8').includes('PRAGMA synchronous=FULL'),
  'La base debe abrirse con synchronous=FULL.');
const origin = 'http://127.0.0.1:43735';
const RFC = 'XAXX010101000';
const dbFile = join(mkdtempSync(join(tmpdir(), 'pacosat-blindaje-')), 'test.sqlite');
let mode = 'network';
const makeConnector = async () => ({ parser: class {}, connector: {
  request: async () => {
    if (mode === 'network') throw new Error('ECONNRESET de juguete');
    if (mode === '5002') throw new Error('El SAT rechazó la solicitud: 5002 Se han agotado las solicitudes de por vida');
    return 'req-ok-1';
  },
  check: async () => ({ status: 'pending', packages: [] }),
  download: async () => { throw new Error('sin paquetes'); }
} });
function harness(service) {
  let token;
  return {
    setToken(value) { token = value; },
    async call(path, data) {
      const headers = { host: new URL(origin).host, origin, 'x-pacosat-token': token };
      const req = Object.assign(Readable.from(data === undefined ? [] : [Buffer.from(JSON.stringify(data))]), {
        url: path, method: data === undefined ? 'GET' : 'POST', headers });
      let response;
      const res = { setHeader() {}, writeHead(status) { this.status = status; this.headersSent = true; },
        end(content) { response = new Response(content, { status: this.status }); } };
      await service.handle(req, res);
      return response;
    }
  };
}
const service = createPacoSATService({ dbFile, html: '<!--PACOSAT_TOKEN-->', origin, makeConnector });
const api = harness(service);
try {
  const page = await (await api.call('/')).text();
  api.setToken(page.split('content="')[1].split('"')[0]);
  assert.equal((await api.call('/api/unlock', { rfc: RFC, minutes: 60, days: 7, direction: 'received',
    password: 'simulated', certificate: 'YQ==', key: 'Yg==' })).status, 200);
  const criteria = { rfc: RFC, start: '2026-10-01', end: '2026-10-31', direction: 'received' };
  /* Fallo de red durante el envío: la intención QUEDA y cuenta como
     enviada — repetir el mismo criterio exige confirmación (409). */
  assert.equal((await api.call('/api/request', criteria)).status, 502);
  const guarded = await api.call('/api/request', criteria);
  assert.equal(guarded.status, 409);
  assert.equal((await guarded.json()).guard.state, 'ultima');
  /* Respuesta 5002 del SAT en la llamada: la intención se RETIRA, pero
     el criterio se APRENDE como quemado (ronda anti-5002): la respuesta
     es la guardia 409 «agotado» con sus salidas, y repetir tampoco
     vuelve a enviar nada. */
  mode = '5002';
  const other = { rfc: RFC, start: '2026-09-01', end: '2026-09-30', direction: 'received' };
  const burned = await api.call('/api/request', other);
  assert.equal(burned.status, 409);
  assert.equal((await burned.json()).guard.state, 'agotado');
  assert.equal((await api.call('/api/request', other)).status, 409);
  /* Envío correcto: queda registrado y también cuenta para la guardia. */
  mode = 'ok';
  const third = { rfc: RFC, start: '2026-08-01', end: '2026-08-31', direction: 'received' };
  assert.equal((await api.call('/api/request', third)).status, 200);
  assert.equal((await api.call('/api/request', third)).status, 409);
  console.log('blindaje intención 5002: ok');
} finally { await service.close(); }

/* Arranque con una intención sin confirmar: aviso «presunto enviado». */
/* Hora INYECTADA (1.23.0, frente F): el resumen de avisos solo sale a
   partir de la hora configurada (defecto 9:00, hora de México) y el
   arnés corría con el reloj real — la aserción de abajo fallaba en la
   madrugada sin que nada estuviera roto. La hora queda fijada a las
   11:00 de México del mismo día del escenario: la prueba ya no
   depende de cuándo se corre. */
const sent = [];
const service2 = createPacoSATService({ dbFile, html: '<!--PACOSAT_TOKEN-->', origin, makeConnector,
  now: () => Date.parse('2026-11-11T17:00:00Z'),
  makeMailer: () => ({ verify: async () => true, sendMail: async payload => { sent.push(payload); } }) });
const api2 = harness(service2);
try {
  const page = await (await api2.call('/')).text();
  api2.setToken(page.split('content="')[1].split('"')[0]);
  await service2.bootstrap({});
  assert.equal((await api2.call('/api/mail', { host: 'smtp.example.com', port: 587, user: 'u', password: 'p',
    from: 'from@example.com', recipient: 'avisos@example.com' })).status, 200);
  await service2.tick();
  /* 1.7.4: el aviso vive en el Centro y se nombra en el cuerpo del
     único correo-resumen (ya no sale un correo individual). */
  assert.ok(sent.some(mail => /presunto enviadas/.test(mail.text || '')), 'Debe avisar de la intención sin confirmar.');
  console.log('blindaje presunto enviado: ok');
} finally { await service2.close(); }
console.log('blindaje.test: ok');
