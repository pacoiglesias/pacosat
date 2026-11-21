/* RONDA 3.1.1 · PARTE B — MOTOR DE DESCARGA MASIVA POR FOLIOS.
   La vía de fechas no trae el XML de los recibidos CANCELADOS
   (hallazgo #5: el SAT solo entrega vigentes en XML de terceros);
   la solicitud por folio es la puerta que puede traer el XML de
   una cancelada concreta cuyo UUID ya consta por los metadatos.
   Esta suite prueba el motor nuevo del conector (requestFolio)
   y que el ciclo genérico de avance (advanceSatJob) sirve para
   un trabajo nacido de esa vía, sin tocarlo.

   CONTRATO (verificado por el coordinador contra el código del
   SDK instalado, @nodecfdi/sat-ws-descarga-masiva 2.0.0, y
   re-verificado aquí contra ese mismo SDK en la parte 2):
   - Service.query() despacha a queryFolio() si la
     QueryParameters lleva UUID: operación SOAP
     «SolicitaDescargaFolio» con RfcSolicitante y Folio (UN solo
     UUID por solicitud; no existe operación con lista).
   - QueryValidator.validateFolio RECHAZA la consulta por UUID
     con filtro de RFC, complemento, estado de documento o tipo
     de documento. La vía por folio va SIN DocumentStatus — al
     revés que recibidos+cfdi por fechas, que lo exige.
   - Uuid.create() exige el formato UUID y lo pasa a minúsculas.

   Como en sat-direct.test.mjs, la parte 1 corre sobre un DOBLE
   FIEL al SDK (su validate() aplica validateFolio de verdad) y
   la parte 2 repite las comprobaciones clave contra el SDK
   verdadero importado, para que el doble no pueda mentir. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as realSdk from '@nodecfdi/sat-ws-descarga-masiva';
import { advanceSatJob, createSatConnector } from './sat-direct.mjs';

const rfc = 'XAXX010101000';
const FOLIO = '123e4567-e89b-42d3-a456-426614174000';
const FOLIO_EN_MAYUSCULAS = FOLIO.toUpperCase();

/* ================= PARTE 1 · DOBLE FIEL ================= */
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
}
class DocumentStatus extends FakeEnum {
  constructor(id) { super(id, ['undefined', 'active', 'cancelled']); }
  value() { return { undefined: '', active: '1', cancelled: '0' }[this._id]; }
}
class DocumentType extends FakeEnum {
  constructor(id) { super(id, ['undefined', 'ingreso', 'egreso', 'traslado', 'nomina', 'pago']); }
  value() { return { undefined: '', ingreso: 'I', egreso: 'E', traslado: 'T', nomina: 'N', pago: 'P' }[this._id]; }
}
class ComplementoUndefined extends FakeEnum {
  constructor(id = 'undefined') { super(id, ['undefined']); }
}
/* Uuid fiel al real: create() pasa a minúsculas, exige el formato
   con la misma expresión regular del SDK y lanza si no casa. */
class Uuid {
  constructor(value) { this._value = value; }
  static create(value) {
    const newValue = value.toLowerCase();
    if (!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/.test(newValue))
      throw new Error('UUID does not have the correct format');
    return new Uuid(newValue);
  }
  static empty() { return new Uuid(''); }
  isEmpty() { return this._value === ''; }
  getValue() { return this._value; }
  toJSON() { return this._value; }
}
class RfcMatches {
  constructor(items = []) { this._items = items; }
  static create(...items) { return new RfcMatches(items); }
  isEmpty() { return this._items.length === 0; }
  count() { return this._items.length; }
}
/* QueryParameters fiel: create() deja los valores por defecto del
   SDK real (sentido «issued», tipo «metadata», estado y tipo de
   documento «undefined», sin complemento, sin filtro de RFC, sin
   UUID y un periodo por defecto que la vía por folio NO toca), y
   validate() despacha a validateFolio — con sus cuatro rechazos
   y sus mensajes reales — cuando hay UUID, igual que el
   QueryValidator verdadero. Cada with* queda registrado en
   `calls` para poder afirmar lo que el conector NO llamó. */
class QueryParameters {
  constructor() {
    this.calls = [];
    this._period = { porDefecto: true };
    this._downloadType = new DownloadType('issued');
    this._requestType = new RequestType('metadata');
    this._documentType = new DocumentType('undefined');
    this._complement = new ComplementoUndefined();
    this._documentStatus = new DocumentStatus('undefined');
    this._uuid = Uuid.empty();
    this._rfcMatches = RfcMatches.create();
  }
  static create() { return new QueryParameters(); }
  withPeriod(period) { this.calls.push('withPeriod'); this._period = period; return this; }
  withDownloadType(v) { this.calls.push('withDownloadType'); this._downloadType = v; return this; }
  withRequestType(v) { this.calls.push('withRequestType'); this._requestType = v; return this; }
  withDocumentType(v) { this.calls.push('withDocumentType'); this._documentType = v; return this; }
  withComplement(v) { this.calls.push('withComplement'); this._complement = v; return this; }
  withDocumentStatus(v) { this.calls.push('withDocumentStatus'); this._documentStatus = v; return this; }
  withUuid(v) { this.calls.push('withUuid'); this._uuid = v; return this; }
  withRfcMatches(v) { this.calls.push('withRfcMatches'); this._rfcMatches = v; return this; }
  withRfcMatch(v) { this.calls.push('withRfcMatch'); this._rfcMatches = RfcMatches.create(v); return this; }
  getPeriod() { return this._period; }
  getDownloadType() { return this._downloadType; }
  getRequestType() { return this._requestType; }
  getDocumentType() { return this._documentType; }
  getComplement() { return this._complement; }
  getDocumentStatus() { return this._documentStatus; }
  getUuid() { return this._uuid; }
  getRfcMatches() { return this._rfcMatches; }
  validate() {
    if (!this._uuid.isEmpty()) {
      const errors = [];
      if (!this._rfcMatches.isEmpty()) errors.push('En una consulta por UUID no se debe usar el filtro de RFC.');
      if (!this._complement.isTypeOf('undefined')) errors.push('En una consulta por UUID no se debe usar el filtro de complemento.');
      if (!this._documentStatus.isTypeOf('undefined')) errors.push('En una consulta por UUID no se debe usar el filtro de estado de documento.');
      if (!this._documentType.isTypeOf('undefined')) errors.push('En una consulta por UUID no se debe usar el filtro de tipo de documento.');
      return errors;
    }
    const errors = [];
    if (this._downloadType?.isTypeOf('received') && this._requestType?.isTypeOf('xml') &&
        !this._documentStatus?.isTypeOf('active'))
      errors.push('No es posible hacer una consulta de XML Recibidos que contenga Cancelados.');
    return errors;
  }
}
const status = { isAccepted: () => true };
const fakeEndpoints = () => ({ getServiceType: () => ({ isTypeOf: type => type === 'cfdi' }),
  getAuthenticate: () => 'auth', getQuery: () => 'query', getVerify: () => 'verify', getDownload: () => 'download' });
/* El «paquete» simulado: magia ZIP al principio (lo que
   connector.download exige) y detrás un manifiesto JSON con las
   entradas que la ingesta simulada del llamador va a «parsear» —
   el paquete real trae XML; aquí basta la identidad y el estado
   de cada CFDI para probar el ciclo y la deduplicación. */
const UUID_VIGENTE = 'aaaaaaaa-1111-4222-8333-444444444444';
const UUID_CANCELADA = 'bbbbbbbb-1111-4222-8333-444444444444';
const packageEntries = [
  { uuid: UUID_VIGENTE, estado: 'vigente' },
  { uuid: UUID_CANCELADA, estado: 'cancelada' } ];
const archive = Buffer.concat([
  Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  Buffer.from(JSON.stringify(packageEntries), 'utf8'),
  Buffer.alloc(22) ]);
let lastQuery = null;
let remote = 'InProgress';
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
    return { getStatus: () => status, getRequestId: () => 'folio-request-1' }; }
  async verify() {
    await this.obtainCurrentToken();
    return { getStatus: () => status, getStatusRequest: () => ({ isTypeOf: type => type === remote }),
      getCodeRequest: () => ({ getValue: () => undefined }),
      getPackageIds: () => ['folio-package-1'] };
  }
  async download() { await this.obtainCurrentToken();
    return { getStatus: () => status, getPackageContent: () => archive.toString('base64') }; }
}
const sdk = {
  Fiel: { create: () => ({ isValid: () => true, getRfc: () => rfc }) },
  FielRequestBuilder: class {}, HttpsWebClient: class {},
  ServiceEndpoints: { cfdi: fakeEndpoints },
  Service, QueryParameters, DownloadType, RequestType, DocumentStatus, DocumentType, Uuid,
  DateTimePeriod: { createFromValues: (from, to) => ({ start: from, end: to }) }
};
const connector = createSatConnector(sdk, { rfc, certificate: Buffer.alloc(0), privateKey: Buffer.alloc(0), password: 'fake' });

/* ---------- (a) Construcción de la solicitud por folio ---------- */
const requestId = await connector.requestFolio({ folio: FOLIO_EN_MAYUSCULAS, direction: 'received' });
assert.equal(requestId, 'folio-request-1', 'devuelve el requestId del SAT');
assert.ok(lastQuery instanceof QueryParameters, 'lo enviado es una QueryParameters');
assert.equal(lastQuery.getUuid().getValue(), FOLIO,
  'la QueryParameters lleva el UUID pedido, normalizado a minúsculas por Uuid.create');
assert.deepEqual(lastQuery.calls, ['withUuid'],
  'el conector SOLO fija el UUID: ni periodo, ni estado, ni sentido, ni tipo, ni filtros');
assert.equal(lastQuery.getPeriod().porDefecto, true, 'el periodo queda el de por defecto: la vía por folio no pide fechas');
assert.ok(lastQuery.getDocumentStatus().isTypeOf('undefined'), 'sin DocumentStatus (el «active» de fechas aquí está prohibido)');
assert.ok(lastQuery.getDocumentType().isTypeOf('undefined'), 'sin tipo de documento');
assert.ok(lastQuery.getComplement().isTypeOf('undefined'), 'sin complemento');
assert.ok(lastQuery.getRfcMatches().isEmpty(), 'sin filtro de RFC');
assert.deepEqual(lastQuery.validate(), [], 'validate() del doble fiel acepta la solicitud por folio');
/* direction es contexto del llamador, no entra en la petición:
   pedir el mismo folio como «issued» produce la MISMA consulta. */
await connector.requestFolio({ folio: FOLIO, direction: 'issued' });
assert.deepEqual(lastQuery.calls, ['withUuid'], 'la dirección no toca la QueryParameters');
assert.equal(lastQuery.getUuid().getValue(), FOLIO);
await assert.rejects(connector.requestFolio({ folio: FOLIO, direction: 'ambas' }), /Dirección inválida/);
await assert.rejects(connector.requestFolio({ folio: 'no-es-un-uuid' }), /Folio inválido/);
await assert.rejects(connector.requestFolio({ folio: '123e4567e89b42d3a456426614174000' }), /Folio inválido/,
  'sin guiones no es un UUID para el SAT');
await assert.rejects(connector.requestFolio({ folio: '' }), /Folio inválido/);
await assert.rejects(connector.requestFolio({}), /Folio inválido/);
await assert.rejects(connector.requestFolio({ folio: 42 }), /Folio inválido/);
console.log('OK folios (a): la solicitud lleva solo el UUID, sin periodo/estado/filtros, y el folio malo se rechaza en casa.');

/* Guarda del contrato en el doble fiel: si alguien «arregla» la
   vía por folio añadiéndole el DocumentStatus de la vía de
   fechas, el validador — el mismo criterio que el real — la
   rechaza. Esta es la trampa que esta parte B no debe repetir. */
const conEstado = QueryParameters.create().withUuid(Uuid.create(FOLIO))
  .withDocumentStatus(new DocumentStatus('active'));
assert.deepEqual(conEstado.validate(),
  ['En una consulta por UUID no se debe usar el filtro de estado de documento.'],
  'validateFolio rechaza la consulta por UUID con DocumentStatus');
const conRfc = QueryParameters.create().withUuid(Uuid.create(FOLIO))
  .withRfcMatches(RfcMatches.create('XAXX010101000'));
assert.ok(conRfc.validate().some(e => /filtro de RFC/.test(e)), 'validateFolio rechaza el filtro de RFC');
const conTipo = QueryParameters.create().withUuid(Uuid.create(FOLIO))
  .withDocumentType(new DocumentType('ingreso'));
assert.ok(conTipo.validate().some(e => /tipo de documento/.test(e)), 'validateFolio rechaza el tipo de documento');
console.log('OK folios (a2): el validador rechaza UUID+DocumentStatus/RfcMatches/DocumentType — la guarda del contrato.');

/* ---------- (b) Ciclo solicitud→verificación→paquete→ingesta,
     con 1 CFDI cancelada en el paquete ---------- */
/* Ingesta simulada del llamador, como en sat-direct.test.mjs se
   simula importPackage: «parsea» el manifiesto del paquete y
   registra cada CFDI por UUID en el expediente simulado,
   deduplicando contra lo ya registrado (el criterio del
   servidor real es discovered/records; aquí, el mapa). */
const records = new Map();
const importCalls = [];
const importPackage = async ({ rfc: target, id, archive: bytes }) => {
  assert.equal(target, rfc);
  assert.deepEqual(bytes, archive);
  importCalls.push(id);
  const entries = JSON.parse(bytes.subarray(4, bytes.length - 22).toString('utf8'));
  let added = 0, duplicates = 0;
  for (const entry of entries) {
    if (records.has(entry.uuid)) { duplicates++; continue; }
    records.set(entry.uuid, entry);
    added++;
  }
  return { added, duplicates };
};
let job = { rfc, requestId, kind: 'folios', folio: FOLIO, direction: 'received', status: 'pending', imported: [] };
const save = async next => { job = next; };
assert.equal((await advanceSatJob(connector, job, save, importPackage)).status, 'pending',
  'el SAT aún procesa: el trabajo por folio espera como cualquier otro');
assert.equal(importCalls.length, 0, 'sin paquete no hay ingesta');
remote = 'Finished';
const finished = await advanceSatJob(connector, job, save, importPackage);
assert.equal(finished.status, 'finished', 'advanceSatJob cierra el trabajo nacido de requestFolio SIN cambios');
assert.deepEqual(finished.imported, ['folio-package-1']);
assert.deepEqual(importCalls, ['folio-package-1']);
assert.equal(records.size, 2, 'el paquete entró entero');
assert.equal(records.get(UUID_CANCELADA)?.estado, 'cancelada',
  'la CFDI CANCELADA quedó registrada: es justo lo que la vía de fechas no puede traer');
assert.equal(records.get(UUID_VIGENTE)?.estado, 'vigente');
console.log('OK folios (b): solicitud→verificación→paquete→ingesta con una cancelada dentro, sobre advanceSatJob intacto.');

/* ---------- (c) Dedupe contra un registro ya existente ---------- */
/* Mismo folio pedido otra vez (otro trabajo): el paquete baja de
   nuevo, pero la ingesta no duplica lo que el expediente ya
   tiene — los dos UUID cuentan como duplicados. */
records.clear();
records.set(UUID_CANCELADA, { uuid: UUID_CANCELADA, estado: 'cancelada' });
let dedupeResult = null;
const importDedupe = async item => { dedupeResult = await importPackage(item); };
let job2 = { rfc, requestId, kind: 'folios', folio: FOLIO, direction: 'received', status: 'pending', imported: [] };
const save2 = async next => { job2 = next; };
const finished2 = await advanceSatJob(connector, job2, save2, importDedupe);
assert.equal(finished2.status, 'finished');
assert.deepEqual(dedupeResult, { added: 1, duplicates: 1 },
  'la cancelada ya existente NO se re-registra; solo entra la vigente que faltaba');
assert.equal(records.size, 2);
/* Y el propio avance no reimporta un paquete ya importado: un
   trabajo que ya lo trae en `imported` cierra sin llamar a la
   ingesta otra vez. */
importCalls.length = 0;
let job3 = { rfc, requestId, kind: 'folios', folio: FOLIO, direction: 'received', status: 'pending', imported: ['folio-package-1'] };
const finished3 = await advanceSatJob(connector, job3, async next => { job3 = next; }, importPackage);
assert.equal(finished3.status, 'finished');
assert.deepEqual(importCalls, [], 'paquete ya importado: advanceSatJob no lo vuelve a importar');
/* Un trabajo ya terminado ni siquiera verifica contra el SAT. */
const untouched = await advanceSatJob(connector, finished3, async () => { throw new Error('no debe guardar'); }, importPackage);
assert.equal(untouched.status, 'finished');
console.log('OK folios (c): dedupe contra el registro existente y contra paquetes ya importados.');

/* ================= PARTE 2 · CONTRATO CON EL SDK REAL ================= */
assert.equal(typeof realSdk.Uuid?.create, 'function', 'el SDK real exporta Uuid.create');
assert.equal(typeof realSdk.QueryParameters.prototype.withUuid, 'function', 'QueryParameters#withUuid existe');
assert.equal(typeof realSdk.QueryParameters.prototype.getUuid, 'function', 'QueryParameters#getUuid existe');
assert.equal(realSdk.Uuid.create(FOLIO_EN_MAYUSCULAS).getValue(), FOLIO,
  'Uuid.create real normaliza a minúsculas');
assert.throws(() => realSdk.Uuid.create('no-es-un-uuid'), /correct format/, 'Uuid.create real rechaza el formato malo');
assert.deepEqual(realSdk.QueryParameters.create().withUuid(realSdk.Uuid.create(FOLIO)).validate(), [],
  'el validador REAL acepta la consulta por folio tal como la construye el conector');
assert.deepEqual(
  realSdk.QueryParameters.create().withUuid(realSdk.Uuid.create(FOLIO))
    .withDocumentStatus(new realSdk.DocumentStatus('active')).validate(),
  ['En una consulta por UUID no se debe usar el filtro de estado de documento.'],
  'el validador REAL rechaza UUID+DocumentStatus: la guarda del contrato, contra el SDK de verdad');
/* El conector entero sobre las clases reales: Service real
   subclasado (sin red) y la e.firma de juguete de
   sat-doc-fetch.test.mjs, como en sdk-contract.test.mjs. */
const fixture = readFileSync(new URL('./sat-doc-fetch.test.mjs', import.meta.url), 'utf8');
const VALID_CER = fixture.match(/const VALID_CER = '([^']+)'/)[1];
const VALID_KEY = fixture.match(/const VALID_KEY = '([^']+)'/)[1];
const RFC_REAL = 'MFI6212158B4';
const acceptedReal = new realSdk.StatusCode(5000, 'Solicitud recibida con éxito');
const capturedReal = [];
let verifyReal = 'InProgress';
class CapturingService extends realSdk.Service {
  async query(parameters) {
    capturedReal.push(parameters);
    return new realSdk.QueryResult(acceptedReal, 'req-folio-real-1');
  }
  async verify() {
    if (verifyReal === 'InProgress')
      return new realSdk.VerifyResult(acceptedReal, new realSdk.StatusRequest('InProgress'), new realSdk.CodeRequest(5000), 0);
    return new realSdk.VerifyResult(acceptedReal, new realSdk.StatusRequest('Finished'), new realSdk.CodeRequest(5000), 1, 'pkg-folio-real-1');
  }
  async download() { return new realSdk.DownloadResult(acceptedReal, archive.toString('base64')); }
}
const realConnector = createSatConnector({ ...realSdk, Service: CapturingService },
  { rfc: RFC_REAL, certificate: Buffer.from(VALID_CER, 'base64'),
    privateKey: Buffer.from(VALID_KEY, 'base64'), password: 'buena-efirma' });
const realId = await realConnector.requestFolio({ folio: FOLIO_EN_MAYUSCULAS, direction: 'received' });
assert.equal(realId, 'req-folio-real-1');
const realQuery = capturedReal.at(-1);
assert.ok(realQuery instanceof realSdk.QueryParameters, 'la petición real es una QueryParameters del SDK');
assert.equal(realQuery.getUuid().getValue(), FOLIO, 'el UUID pedido llega al SDK real');
assert.ok(realQuery.getDocumentStatus().isTypeOf('undefined'), 'SDK real: sin DocumentStatus');
assert.ok(realQuery.getDocumentType().isTypeOf('undefined'), 'SDK real: sin tipo de documento');
assert.ok(realQuery.getRfcMatches().isEmpty(), 'SDK real: sin filtro de RFC');
assert.deepEqual(realQuery.validate(), [], 'SDK real: validate() limpio');
await assert.rejects(realConnector.requestFolio({ folio: 'mal' }), /Folio inválido/);
/* Y el ciclo de avance también cierra sobre las clases reales. */
verifyReal = 'Finished';
let realJob = { rfc: RFC_REAL, requestId: realId, kind: 'folios', folio: FOLIO, direction: 'received', status: 'pending', imported: [] };
const realImported = [];
realJob = await advanceSatJob(realConnector, realJob, async next => { realJob = next; },
  async ({ id: pkg }) => { realImported.push(pkg); });
assert.equal(realJob.status, 'finished', 'advanceSatJob cierra el trabajo por folio con el SDK real');
assert.deepEqual(realImported, ['pkg-folio-real-1']);
console.log('OK folios (contrato real): Uuid/withUuid/validateFolio existen y se comportan como el conector espera, sin red.');
console.log('OK ronda 3.1.1 folios: motor por folio construido y probado (doble fiel + SDK real).');
