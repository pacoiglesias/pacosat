import assert from 'node:assert/strict';
import { advanceSatJob, createSatConnector } from './sat-direct.mjs';

const rfc = 'XAXX010101000';
const status = { isAccepted: () => true };
const archive = Buffer.alloc(22);
archive.writeUInt32LE(0x06054b50);
const query = {
  withPeriod() { return this; },
  withDownloadType() { return this; },
  withRequestType() { return this; },
  withDocumentStatus() { return this; },
  validate() { return []; }
};
let remote = 'InProgress';
const sdk = {
  Fiel: { create: () => ({ isValid: () => true, getRfc: () => rfc }) },
  FielRequestBuilder: class {}, HttpsWebClient: class {},
  ServiceEndpoints: { cfdi: () => 'cfdi' },
  Service: class {
    async query() { return { getStatus: () => status, getRequestId: () => 'request-1' }; }
    async verify() {
      return { getStatus: () => status, getStatusRequest: () => ({ isTypeOf: type => type === remote }),
        getPackageIds: () => ['package-a', 'package-b', 'package-a'] };
    }
    async download() { return { getStatus: () => status, getPackageContent: () => archive.toString('base64') }; }
  },
  QueryParameters: { create: () => query },
  DateTimePeriod: { createFromValues() {} },
  DownloadType: { issued() {}, received() {} },
  RequestType: { xml() {} },
  DocumentStatus: { active() {} }
};
const settings = { rfc, certificate: Buffer.alloc(0), privateKey: Buffer.alloc(0), password: 'fake' };
const connector = createSatConnector(sdk, settings);
assert.throws(() => createSatConnector(sdk, { ...settings, rfc: 'XEXX010101000' }), /corresponder/);
await assert.rejects(connector.request({ start: '2026-02-30', end: '2026-03-01' }), /Periodo/);
await assert.rejects(connector.download('../paquete'), /Identificador/);
const requestId = await connector.request({ start: '2026-11-01', end: '2026-11-08' });
let saved = { rfc, requestId, status: 'pending' };
const save = async next => { saved = next; };
const imported = [];
const ingest = async ({ rfc: target, id, archive: bytes }) => {
  assert.equal(target, rfc);
  assert.deepEqual(bytes, archive);
  imported.push(id);
};
assert.equal((await advanceSatJob(connector, saved, save, ingest)).status, 'pending');
remote = 'Finished';
await assert.rejects(advanceSatJob(connector, saved, save, async item => {
  if (item.id === 'package-b') throw new Error('Fallo simulado');
  await ingest(item);
}), /Fallo simulado/);
assert.deepEqual(saved.imported, ['package-a']);
assert.equal((await advanceSatJob(connector, saved, save, ingest)).status, 'finished');
assert.deepEqual(imported, ['package-a', 'package-b']);
remote = 'Expired';
assert.equal((await advanceSatJob(connector, { rfc, requestId, status: 'pending' }, save, ingest)).status, 'expired');
console.log('OK: solicitud, RFC, validación, espera, descarga, reintento y expiración con SAT simulado.');
