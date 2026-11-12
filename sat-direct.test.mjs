import assert from 'node:assert/strict';
import { advanceSatJob, createSatConnector } from './sat-direct.mjs';

const rfc = 'XAXX010101000';
const status = { isAccepted: () => true };
const archive = Buffer.alloc(22);
archive.writeUInt32LE(0x06054b50);
/* DOBLE FIEL AL SDK REAL (corrección 1.19.0). El doble anterior
   definía DownloadType.received()/issued() y RequestType.xml()/
   metadata() — fábricas que el SDK verdadero (@nodecfdi/
   sat-ws-descarga-masiva 2.0.0) NO tiene: sus enums son clases
   BaseEnum que se construyen con new y el id. Por eso la suite
   pasaba mientras producción moría con «sdk.DownloadType.received
   is not a function». Este doble imita la superficie real:
   - enums como CLASES sin fábricas estáticas, con id validado;
   - Service con la firma real (requestBuilder, webClient,
     token?, endpoints?): si los endpoints caen en el hueco del
     token, obtainCurrentToken() muere con TypeError, igual que
     el de verdad;
   - QueryParameters que exige instancias de los enums y cuyo
     validate() aplica la regla real del QueryValidator para
     recibidos+XML (sin «active» hay error).
   La prueba de contrato (sdk-contract.test.mjs) verifica además
   esta superficie contra el SDK verdadero importado. */
class FakeEnum {
  constructor(id, allowed) {
    if (!allowed.includes(id)) throw new Error('Valor de enum no válido: ' + id);
    this._id = id;
  }
  index() { return this._id; }
  isTypeOf(type) { return this._id === type; }
  toJSON() { return this._id; }
}
class DownloadType extends FakeEnum {
  constructor(id) { super(id, ['issued', 'received']); }
  value() { return this._id === 'issued' ? 'RfcEmisor' : 'RfcReceptor'; }
}
class RequestType extends FakeEnum {
  constructor(id) { super(id, ['xml', 'metadata']); }
  value() { return this._id; }
  getQueryAttributeValue() { return this._id === 'xml' ? 'CFDI' : 'Metadata'; }
}
class DocumentStatus extends FakeEnum {
  constructor(id) { super(id, ['undefined', 'active', 'cancelled']); }
  value() { return { undefined: '', active: '1', cancelled: '0' }[this._id]; }
  getQueryAttributeValue() { return { undefined: 'Todos', active: 'Vigente', cancelled: 'Cancelado' }[this._id]; }
}
const statusFilterValues = [];
const requestTypes = [];
let lastQuery = null;
class QueryParameters {
  static create() { return new QueryParameters(); }
  withPeriod(period) { this._period = period; return this; }
  withDownloadType(downloadType) {
    if (!(downloadType instanceof DownloadType)) throw new TypeError('withDownloadType espera un DownloadType');
    this._downloadType = downloadType; return this;
  }
  withRequestType(requestType) {
    if (!(requestType instanceof RequestType)) throw new TypeError('withRequestType espera un RequestType');
    requestTypes.push(requestType.index());
    this._requestType = requestType; return this;
  }
  withDocumentStatus(documentStatus) {
    if (!(documentStatus instanceof DocumentStatus)) throw new TypeError('withDocumentStatus espera un DocumentStatus');
    statusFilterValues.push(documentStatus.index());
    this._documentStatus = documentStatus; return this;
  }
  validate() {
    const errors = [];
    if (this._downloadType?.isTypeOf('received') && this._requestType?.isTypeOf('xml') &&
        !this._documentStatus?.isTypeOf('active'))
      errors.push('No es posible hacer una consulta de XML Recibidos que contenga Cancelados. Solicitado: ' +
        (this._documentStatus ? this._documentStatus.getQueryAttributeValue() : 'Todos') + '.');
    return errors;
  }
}
let remote = 'InProgress';
let remoteCode, periodArgs;
const fakeEndpoints = () => ({ getServiceType: () => ({ isTypeOf: type => type === 'cfdi' }),
  getAuthenticate: () => 'auth', getQuery: () => 'query', getVerify: () => 'verify', getDownload: () => 'download' });
class Service {
  constructor(requestBuilder, webClient, token = null, endpoints = null) {
    this._currentToken = token ?? { isValid: () => false };
    this.endpoints = endpoints ?? fakeEndpoints();
  }
  async obtainCurrentToken() {
    if (!this._currentToken.isValid()) this._currentToken = { isValid: () => true };
    return this._currentToken;
  }
  async query(params) { await this.obtainCurrentToken(); lastQuery = params;
    return { getStatus: () => status, getRequestId: () => 'request-1' }; }
  async verify() {
    await this.obtainCurrentToken();
    return { getStatus: () => status, getStatusRequest: () => ({ isTypeOf: type => type === remote }),
      getCodeRequest: () => ({ getValue: () => remoteCode }),
      getPackageIds: () => ['package-a', 'package-b', 'package-a'] };
  }
  async download() { await this.obtainCurrentToken();
    return { getStatus: () => status, getPackageContent: () => archive.toString('base64') }; }
}
const sdk = {
  Fiel: { create: () => ({ isValid: () => true, getRfc: () => rfc }) },
  FielRequestBuilder: class {}, HttpsWebClient: class {},
  ServiceEndpoints: { cfdi: fakeEndpoints },
  Service, QueryParameters, DownloadType, RequestType, DocumentStatus,
  DateTimePeriod: { createFromValues(from, to) { periodArgs = [from, to]; return { start: from, end: to }; } }
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
/* Filtro de estado, doctrina corregida (1.19.0): la lectura del
   hallazgo #5 («sin filtro, pedir todo») la desmiente el propio
   SAT para recibidos+XML — su validador exige «active» y el
   doble fiel lo aplica igual que el QueryValidator real. Los
   cancelados recibidos llegan por las Metadata (sin filtro).
   Hasta aquí TODAS las solicitudes de la prueba fueron de
   recibidos en CFDI (las de connector.request sin `type`), así
   que cada una debió fijar «active» exactamente una vez. */
assert.ok(statusFilterValues.length >= 2 && statusFilterValues.every(value => value === 'active'),
  'recibidos+XML fijan DocumentStatus «active», ni uno más ni otro valor: ' + JSON.stringify(statusFilterValues));
const filtrosAntes = statusFilterValues.length;
await connector.request({ start: '2026-11-01', end: '2026-11-08', direction: 'received' });
assert.equal(statusFilterValues.length, filtrosAntes + 1, 'recibidos+XML: un filtro «active» por solicitud');
assert.equal(requestTypes.at(-1), 'xml');
await connector.request({ start: '2026-11-01', end: '2026-11-08', direction: 'issued', type: 'metadata' });
assert.equal(requestTypes.at(-1), 'metadata');
assert.equal(statusFilterValues.length, filtrosAntes + 1, 'emitidos y Metadata NO llevan filtro de estado');
await connector.request({ start: '2026-11-01', end: '2026-11-08', direction: 'received', type: 'metadata' });
assert.equal(statusFilterValues.length, filtrosAntes + 1, 'la Metadata de recibidos tampoco filtra: trae los cancelados');
await assert.rejects(connector.request({ start: '2026-11-01', end: '2026-11-08', type: 'otro' }), /Tipo de solicitud/);
console.log('OK: recibidos+XML con «active» (regla real del SAT), emitidos y Metadata sin filtro, y el tipo Metadata llega al SDK.');
