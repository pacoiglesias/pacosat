/* PRUEBA DE CONTRATO contra el SDK VERDADERO (1.19.0).
   El 10 nov 2026 la descarga automática murió en producción al
   instante con «sdk.DownloadType.received is not a function»
   mientras la suite pasaba entera: el doble de sat-direct.test
   definía fábricas que el SDK instalado (@nodecfdi/
   sat-ws-descarga-masiva 2.0.0) no tiene, y el conector además
   pasaba los endpoints en el hueco del token de Service y pedía
   recibidos+XML sin el «active» que el validador real exige.
   Esta prueba importa el SDK de verdad y verifica que CADA
   miembro que el código de producción usa existe con la forma
   usada — y que las trampas NO existen — para que esta clase de
   defecto no pueda volver a pasar la suite. Sin red: el Service
   real se subclasa para capturar la QueryParameters y devolver
   resultados reales sin tocar el SAT. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as sdk from '@nodecfdi/sat-ws-descarga-masiva';
import { createSatConnector, advanceSatJob } from './sat-direct.mjs';

/* ---------- 1. La superficie que producción usa, miembro a miembro ----------
   (sat-direct.mjs: Fiel.create/isValid/getRfc, FielRequestBuilder,
   HttpsWebClient, ServiceEndpoints.cfdi, Service, QueryParameters,
   DateTimePeriod.createFromValues, DownloadType, RequestType,
   DocumentStatus, y los getters de los resultados;
   sat-doc-fetch.mjs: Fiel.create e isValid.) */
assert.equal(typeof sdk.Fiel.create, 'function', 'Fiel.create existe');
for (const method of ['isValid', 'getRfc', 'sign']) assert.equal(typeof sdk.Fiel.prototype[method], 'function', 'Fiel#' + method);
assert.equal(typeof sdk.FielRequestBuilder, 'function', 'FielRequestBuilder es clase');
assert.equal(typeof sdk.HttpsWebClient, 'function', 'HttpsWebClient es clase');
assert.equal(typeof sdk.ServiceEndpoints.cfdi, 'function', 'ServiceEndpoints.cfdi existe');
assert.equal(typeof sdk.Service, 'function', 'Service es clase');
for (const method of ['query', 'verify', 'download', 'obtainCurrentToken', 'getToken'])
  assert.equal(typeof sdk.Service.prototype[method], 'function', 'Service#' + method);
assert.equal(typeof sdk.QueryParameters.create, 'function', 'QueryParameters.create existe');
for (const method of ['withPeriod', 'withDownloadType', 'withRequestType', 'withDocumentStatus', 'validate',
    'getDownloadType', 'getRequestType', 'getDocumentStatus', 'getPeriod'])
  assert.equal(typeof sdk.QueryParameters.prototype[method], 'function', 'QueryParameters#' + method);
assert.equal(typeof sdk.DateTimePeriod.createFromValues, 'function', 'DateTimePeriod.createFromValues existe');
for (const [name, proto] of [['QueryResult', sdk.QueryResult.prototype], ['VerifyResult', sdk.VerifyResult.prototype],
    ['DownloadResult', sdk.DownloadResult.prototype]])
  assert.equal(typeof proto.getStatus, 'function', name + '#getStatus');
for (const method of ['getRequestId']) assert.equal(typeof sdk.QueryResult.prototype[method], 'function', 'QueryResult#' + method);
for (const method of ['getStatusRequest', 'getCodeRequest', 'getPackageIds'])
  assert.equal(typeof sdk.VerifyResult.prototype[method], 'function', 'VerifyResult#' + method);
assert.equal(typeof sdk.DownloadResult.prototype.getPackageContent, 'function', 'DownloadResult#getPackageContent');
for (const method of ['isAccepted', 'getMessage']) assert.equal(typeof sdk.StatusCode.prototype[method], 'function', 'StatusCode#' + method);
assert.equal(typeof sdk.StatusRequest.prototype.isTypeOf, 'function', 'StatusRequest#isTypeOf');
assert.equal(typeof sdk.CodeRequest.prototype.getValue, 'function', 'CodeRequest#getValue');

/* ---------- 2. Las trampas NO existen (así murió producción) ---------- */
assert.equal(sdk.DownloadType.received, undefined, 'DownloadType.received NO existe en el SDK real');
assert.equal(sdk.DownloadType.issued, undefined, 'DownloadType.issued NO existe en el SDK real');
assert.equal(sdk.RequestType.xml, undefined, 'RequestType.xml NO existe en el SDK real');
assert.equal(sdk.RequestType.metadata, undefined, 'RequestType.metadata NO existe en el SDK real');
assert.equal(sdk.DownloadType.create, undefined, 'DownloadType.create tampoco: los enums se construyen con new');
assert.equal(sdk.RequestType.create, undefined, 'RequestType.create tampoco');
/* Y la forma buena construye y vale lo que el SAT espera: */
assert.equal(new sdk.DownloadType('received').value(), 'RfcReceptor');
assert.equal(new sdk.DownloadType('issued').value(), 'RfcEmisor');
assert.equal(new sdk.RequestType('xml').value(), 'xml');
assert.equal(new sdk.RequestType('metadata').value(), 'metadata');
assert.equal(new sdk.DocumentStatus('active').value(), '1');
assert.equal(new sdk.DownloadType('otro').value(), undefined,
  'el SDK no valida el id al construir: un id malo da value() undefined (el conector solo pasa ids de su propio dominio)');

/* ---------- 3. Guardia de fuente: el conector no recae ---------- */
const source = readFileSync(new URL('./sat-direct.mjs', import.meta.url), 'utf8');
assert.ok(!/sdk\.DownloadType\.(received|issued)\s*\(/.test(source), 'sat-direct no llama sdk.DownloadType.received()/issued()');
assert.ok(!/sdk\.RequestType\.(xml|metadata)\s*\(/.test(source), 'sat-direct no llama sdk.RequestType.xml()/metadata()');
assert.ok(/new sdk\.Service\([\s\S]*?undefined,\s*sdk\.ServiceEndpoints\.cfdi\(\)\)/.test(source),
  'Service se construye con el token vacío y los endpoints en CUARTO lugar, como manda el SDK 2.0.0');

/* ---------- 4. El conector entero sobre las clases reales ----------
   La e.firma de juguete es la pareja real de sat-doc-fetch.test
   (RFC MFI6212158B4, contraseña «buena-efirma»): se extrae de su
   fuente para no duplicarla. El Service es el REAL subclasado:
   su constructor —con las ranuras de verdad— es el que recibe
   los argumentos del conector, y dentro de query() se comprueba
   que el token es un Token y los endpoints unos ServiceEndpoints
   (con la llamada vieja, el «token» era el objeto endpoints y
   obtainCurrentToken moría con TypeError). */
const fixture = readFileSync(new URL('./sat-doc-fetch.test.mjs', import.meta.url), 'utf8');
const VALID_CER = fixture.match(/const VALID_CER = '([^']+)'/)[1];
const VALID_KEY = fixture.match(/const VALID_KEY = '([^']+)'/)[1];
const RFC = 'MFI6212158B4';
const archive = Buffer.alloc(22);
archive.writeUInt32LE(0x06054b50);
const accepted = new sdk.StatusCode(5000, 'Solicitud recibida con éxito');
const captured = [];
let verifyMode = 'InProgress';
class CapturingService extends sdk.Service {
  async query(parameters) {
    captured.push({ parameters,
      tokenOk: this.getToken() instanceof sdk.Token,
      endpointsOk: this.endpoints instanceof sdk.ServiceEndpoints });
    return new sdk.QueryResult(accepted, 'req-contrato-1');
  }
  async verify() {
    if (verifyMode === 'InProgress')
      return new sdk.VerifyResult(accepted, new sdk.StatusRequest('InProgress'), new sdk.CodeRequest(5002), 0);
    return new sdk.VerifyResult(accepted, new sdk.StatusRequest('Finished'), new sdk.CodeRequest(5000), 1, 'pkg-contrato-1');
  }
  async download() { return new sdk.DownloadResult(accepted, archive.toString('base64')); }
}
const connector = createSatConnector({ ...sdk, Service: CapturingService },
  { rfc: RFC, certificate: Buffer.from(VALID_CER, 'base64'),
    privateKey: Buffer.from(VALID_KEY, 'base64'), password: 'buena-efirma' });

/* Recibidos + XML: vigentes, como exige el validador real. */
const id = await connector.request({ start: '2026-10-01', end: '2026-10-31', direction: 'received', type: 'cfdi' });
assert.equal(id, 'req-contrato-1');
let call = captured.at(-1);
assert.ok(call.tokenOk, 'el token del Service es un Token de verdad (ranura tercera vacía)');
assert.ok(call.endpointsOk, 'los endpoints llegaron a su ranura (la cuarta)');
assert.ok(call.parameters instanceof sdk.QueryParameters, 'la solicitud es una QueryParameters real');
assert.ok(call.parameters.getDownloadType().isTypeOf('received'));
assert.ok(call.parameters.getRequestType().isTypeOf('xml'));
assert.ok(call.parameters.getDocumentStatus().isTypeOf('active'),
  'recibidos+XML llevan DocumentStatus «active»: el validador real lo exige');
assert.deepEqual(call.parameters.validate(), [], 'el validador REAL acepta la solicitud de recibidos');

/* Emitidos + Metadata: sin filtro de estado. */
await connector.request({ start: '2026-10-01', end: '2026-10-31', direction: 'issued', type: 'metadata' });
call = captured.at(-1);
assert.ok(call.parameters.getDownloadType().isTypeOf('issued'));
assert.ok(call.parameters.getRequestType().isTypeOf('metadata'));
assert.ok(call.parameters.getDocumentStatus().isTypeOf('undefined'), 'emitidos+Metadata: sin filtro de estado');
assert.deepEqual(call.parameters.validate(), [], 'el validador REAL acepta la solicitud de emitidos');

/* Recibidos + Metadata: tampoco filtra (por aquí se conocen los cancelados). */
await connector.request({ start: '2026-10-01', end: '2026-10-31', direction: 'received', type: 'metadata' });
call = captured.at(-1);
assert.ok(call.parameters.getDocumentStatus().isTypeOf('undefined'), 'la Metadata de recibidos no filtra estado');
assert.deepEqual(call.parameters.validate(), [], 'el validador REAL acepta la Metadata de recibidos');

/* check/download y el ciclo completo de avance, sobre resultados reales. */
const pending = await connector.check('req-contrato-1');
assert.deepEqual(pending, { status: 'pending', packages: [], code: 5002 },
  'el código 5002 se propaga desde el CodeRequest real');
verifyMode = 'Finished';
assert.deepEqual(await connector.check('req-contrato-1'), { status: 'finished', packages: ['pkg-contrato-1'], code: 5000 });
assert.deepEqual(await connector.download('pkg-contrato-1'), archive, 'el paquete baja y valida como ZIP');
let job = { rfc: RFC, requestId: 'req-contrato-1', status: 'pending' };
const imported = [];
job = await advanceSatJob(connector, job, async next => { job = next; },
  async ({ id: pkg }) => { imported.push(pkg); });
assert.equal(job.status, 'finished', 'el ciclo de avance cierra con las clases reales');
assert.deepEqual(imported, ['pkg-contrato-1']);
console.log('OK contrato SDK: la superficie usada existe en el SDK verdadero, las fábricas fantasma no, ' +
  'y el conector pide, verifica y descarga sobre las clases reales sin red.');
