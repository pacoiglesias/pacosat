import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createPacoSATService } from './local-server.mjs';

/* Final 1.7.0: PWA, acceso invitado de solo lectura con bitácora,
   autodiagnóstico, paquete offline y sync por diferencias. */
const origin = 'https://pacosat.example.com';
const proxyKey = 'f'.repeat(64);
let time = Date.parse('2026-11-12T15:00:00Z');
const service = createPacoSATService({ dbFile: ':memory:', html: '<!--PACOSAT_TOKEN-->', origin, proxyKey, now: () => time,
  makeMailer: () => ({ verify: async () => true, sendMail: async () => {} }) });
let token;
async function call(path, data, asGuest) {
  const headers = { host: 'pacosat.example.com', origin, 'x-pacosat-proxy': proxyKey,
    'x-pacosat-token': asGuest || token };
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
  /* PWA pública */
  const manifest = await (await call('/manifest.webmanifest')).json();
  assert.equal(manifest.short_name, 'PacoSAT');
  assert.equal((await call('/sw.js')).status, 200);
  assert.equal((await call('/icon.svg')).status, 200);
  const guestPage = await (await call('/invitado')).text();
  assert.ok(guestPage.includes('pacosat-guest'));
  /* Invitado desactivado: ni login ni lectura. */
  assert.equal((await call('/api/guest/login', { password: 'la-que-sea-123' })).status, 403);
  let config = await (await call('/api/guest/config', { password: 'clave-invitado-1', enabled: true })).json();
  assert.deepEqual(config, { enabled: true, hasPassword: true, rfcs: [] });
  assert.equal((await call('/api/guest/login', { password: 'incorrecta' })).ok, false);
  const login = await (await call('/api/guest/login', { password: 'clave-invitado-1' })).json();
  assert.ok(login.token);
  /* El invitado lee… */
  assert.equal((await call('/api/money', undefined, login.token)).status, 200);
  assert.equal((await call('/api/offline-bundle', undefined, login.token)).status, 200);
  /* …pero no escribe ni ve la bitácora de accesos. */
  const blocked = await call('/api/storage', { batch: { people: [] } }, login.token);
  assert.equal(blocked.status, 403);
  assert.match((await blocked.json()).error, /solo lectura/);
  assert.equal((await call('/api/access-log', undefined, login.token)).status, 403);
  const log = await (await call('/api/access-log')).json();
  assert.ok(log.entries.some(entry => entry.kind === 'guest-login'));
  assert.ok(log.entries.some(entry => entry.kind === 'guest-blocked'));
  /* Autodiagnóstico */
  const self = await (await call('/api/selftest')).json();
  assert.ok(self.checks.some(item => item.id === 'db' && item.state === 'ok'));
  assert.ok(self.checks.some(item => item.id === 'sat' && item.state === 'dim'));
  /* Sync por diferencias */
  const rev0 = (await (await call('/api/storage/rev')).json()).rev;
  const person = { id: 'XAXX010101000', name: 'Cliente Uno' };
  assert.equal((await call('/api/storage', { batch: { people: [person] } })).status, 200);
  let diff = await (await call('/api/storage?store=people&since=' + rev0)).json();
  assert.deepEqual(diff.rows.map(row => row.id), [person.id]);
  assert.deepEqual(diff.deleted, []);
  const rev1 = diff.rev;
  assert.equal((await call('/api/storage', { batch: { people: [{ ...person, name: 'Cliente Uno Editado' }] } })).status, 200);
  diff = await (await call('/api/storage?store=people&since=' + rev1)).json();
  assert.equal(diff.rows[0].name, 'Cliente Uno Editado');
  const rev2 = diff.rev;
  assert.equal((await call('/api/data/delete', { store: 'people', ids: [person.id] })).status, 200);
  diff = await (await call('/api/storage?store=people&since=' + rev2)).json();
  assert.deepEqual(diff.deleted, [person.id]);
  /* Paquete offline con datos del mes */
  const invoice = { id: 'FFFFFFFF-1111-1111-1111-111111111111', date: '2026-11-05', kind: 'I',
    from: { rfc: 'AAA010101AAA', name: 'PROVEEDOR' }, to: { rfc: 'XAXX010101000', name: 'CLIENTE' },
    total: '116.00', currency: 'MXN', fiscal: { transferred: [{ tax: '002', amount: '16.00' }], withheld: [] } };
  await call('/api/storage', { batch: { people: [person], invoices: [invoice] } });
  const bundle = await (await call('/api/offline-bundle')).json();
  assert.ok(bundle.invoices.some(item => item.id === invoice.id));
  const november = bundle.reports.find(report => report.month === '2026-11');
  assert.equal(november.totals.receivedCount, 1);
  assert.equal(november.totals.receivedTotal, '116.00');
  console.log('final.test: ok');
} finally { await service.close(); }
