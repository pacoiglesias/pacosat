import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createFaroService } from './local-server.mjs';
import { invoiceCandidates } from './pdf-invoice.mjs';
const id = '12345678-1234-1234-1234-1234567890AB';
assert.deepEqual(invoiceCandidates('RFC: XAXX010101000 Folio: ' + id.toLowerCase() + ' ' + id), {
  uuids: [id], rfcs: ['XAXX010101000'], hasText: true
});
assert.equal(invoiceCandidates('   ').hasText, false);
const origin = 'https://faro.example.com';
const proxyKey = 'a'.repeat(64);
const service = createFaroService({ dbFile: ':memory:', origin, proxyKey, html: '<!--FARO_TOKEN-->',
  analyzePdf: async data => { assert.equal(data.toString(), '%PDF-1.7'); return { uuids: [id], rfcs: [], hasText: true }; } });
let token;
async function request(url, data, overrides = {}) {
  const req = Object.assign(Readable.from(data === undefined ? [] : [Buffer.from(JSON.stringify(data))]), {
    url, method: data === undefined ? 'GET' : 'POST',
    headers: { origin, host: 'faro.example.com', 'x-faro-proxy': proxyKey, 'x-faro-token': token, ...overrides }
  });
  let response;
  await service.handle(req, { setHeader() {}, writeHead(status) { this.status = status; this.headersSent = true; },
    end(payload) { response = new Response(payload, { status: this.status }); } });
  return response;
}
try {
  assert.equal((await request('/', undefined, { 'x-faro-proxy': '' })).status, 403);
  const html = await (await request('/')).text();
  token = html.match(/name="faro-token" content="([^"]+)"/)[1];
  assert.ok(html.includes('name="faro-cloud"'));
  assert.deepEqual((await (await request('/api/pdf-analyze', { data: Buffer.from('%PDF-1.7').toString('base64') })).json()).uuids, [id]);
  const people = [{ id: 'XAXX010101000', name: 'Ejemplo' }];
  const files = [{ id: 'pdf:example', mime: 'application/pdf', content: Buffer.from('%PDF-1.7').toString('base64') }];
  assert.equal((await request('/api/storage', { batch: { people, files } })).status, 200);
  assert.deepEqual(await (await request('/api/storage?store=people')).json(), people);
  assert.deepEqual(await (await request('/api/storage?store=files&id=pdf%3Aexample')).json(), files[0]);
  assert.equal((await request('/api/storage', { batch: { people: [], fake: [] }, replace: true })).status, 400);
  assert.deepEqual(await (await request('/api/storage?store=people')).json(), people);
  const before = (await (await request('/api/status')).json()).cloudRevision;
  const renamed = [{ ...people[0], name: 'Nombre actualizado' }];
  assert.equal((await request('/api/storage', { batch: { people: renamed } })).status, 200);
  assert.deepEqual(await (await request('/api/storage?store=people')).json(), renamed);
  assert.notEqual((await (await request('/api/status')).json()).cloudRevision, before);
  console.log('OK: control del proxy, almacenamiento central, actualización, revisión, transacción y candidatos PDF.');
} finally { service.close(); }
