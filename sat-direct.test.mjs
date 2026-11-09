import assert from 'node:assert/strict';
import { advanceSatJob, createSatConnector } from './sat-direct.mjs';

const rfc = 'XAXX010101000';
const status = { isAccepted: () => true };
const archive = Buffer.alloc(22);
archive.writeUInt32LE(0x06054b50);
let statusFilterCalls = 0;
const requestTypes = [];
const query = {
  withPeriod() { return this; },
  withDownloadType() { return this; },
  withRequestType(kind) { requestTypes.push(kind); return this; },
  withDocumentStatus() { statusFilterCalls++; return this; },
  validate() { return []; }
};
let remote = 'InProgress';
let remoteCode, periodArgs;
const sdk = {
  Fiel: { create: () => ({ isValid: () => true, getRfc: () => rfc }) },
  FielRequestBuilder: class {}, HttpsWebClient: class {},
  ServiceEndpoints: { cfdi: () => 'cfdi' },
  Service: class {
    async query() { return { getStatus: () => status, getRequestId: () => 'request-1' }; }
    async verify() {
      return { getStatus: () => status, getStatusRequest: () => ({ isTypeOf: type => type === remote }),
        getCodeRequest: () => ({ getValue: () => remoteCode }),
        getPackageIds: () => ['package-a', 'package-b', 'package-a'] };
    }
    async download() { return { getStatus: () => status, getPackageContent: () => archive.toString('base64') }; }
  },
  QueryParameters: { create: () => query },
  DateTimePeriod: { createFromValues(from, to) { periodArgs = [from, to]; } },
  DownloadType: { issued() {}, received() {} },
  RequestType: { xml: () => 'xml', metadata: () => 'metadata' },
  DocumentStatus: { active() {} }
};
const settings = { rfc, certificate: Buffer.alloc(0), privateKey: Buffer.alloc(0), password: 'fake' };
const connector = createSatConnector(sdk, settings);
assert.throws(() => createSatConnector(sdk, { ...settings, rfc: 'XEXX010101000' }), /corresponder/);
await assert.rejects(connector.request({ start: '2026-02-30', end: '2026-03-01' }), /Periodo/);
await assert.rejects(connector.download('../paquete'), /Identificador/);
const requestId = await connector.request({ start: '2026-11-01', end: '2026-11-08' });
assert.deepEqual(periodArgs, ['2026-11-01 00:00:00', '2026-11-08 23:59:59']);
await connector.request({ start: '2026-11-01', end: '2026-11-08', startTime: '00:00:01' });
assert.deepEqual(periodArgs, ['2026-11-01 00:00:01', '2026-11-08 23:59:59']);
await assert.rejects(connector.request({ start: '2026-11-01', end: '2026-11-08', startTime: '24:00:00' }), /Hora de inicio/);
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
remote = 'Rejected'; remoteCode = 5002;
const exhausted = await advanceSatJob(connector, { rfc, requestId, status: 'pending' }, save, ingest);
assert.equal(exhausted.status, 'rejected');
assert.equal(exhausted.satCode, 5002);
remoteCode = undefined;
console.log('OK: solicitud, RFC, validación, espera, descarga, reintento y expiración con SAT simulado.');
console.log('OK: hora de inicio desplazable y propagación del CodigoEstadoSolicitud (5002) al avanzar la solicitud.');
/* 1.6.10: recibidos SIN filtro de estado y solicitudes Metadata. */
assert.equal(statusFilterCalls, 0, 'Ninguna solicitud debe filtrar por estado (hallazgo #5).');
await connector.request({ start: '2026-11-01', end: '2026-11-08', direction: 'received' });
assert.equal(statusFilterCalls, 0);
assert.equal(requestTypes.at(-1), 'xml');
await connector.request({ start: '2026-11-01', end: '2026-11-08', direction: 'issued', type: 'metadata' });
assert.equal(requestTypes.at(-1), 'metadata');
await assert.rejects(connector.request({ start: '2026-11-01', end: '2026-11-08', type: 'otro' }), /Tipo de solicitud/);
console.log('OK: recibidos sin filtro de estado y tipo Metadata llegan al SDK sin tocar el filtro de estado.');
