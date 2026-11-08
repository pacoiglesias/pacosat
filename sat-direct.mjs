import { X509Certificate } from 'node:crypto';

const REQUEST_ID = /^[a-z0-9][a-z0-9._-]{0,149}$/i;
const RFC = /^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/u;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const PACKAGE_LIMIT = 80 * 1024 * 1024;

function ensure(ok, message) {
  if (!ok) throw new Error(message);
}

function accepted(result, action) {
  const status = result.getStatus();
  if (!status.isAccepted()) throw new Error(action + ': ' + String(status.getMessage()).slice(0, 240));
  return result;
}

function validDate(value) {
  if (!DATE.test(value)) return false;
  const date = new Date(value);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function certificateRfc(fiel, certificate) {
  if (typeof fiel.getRfc === 'function') return String(fiel.getRfc()).toUpperCase();
  const subject = new X509Certificate(Buffer.from(certificate)).subject;
  for (const line of subject.split('\n')) {
    const value = line.match(/^(?:x500UniqueIdentifier|uniqueIdentifier|serialNumber|2\.5\.4\.45)\s*=\s*([^/]+)/i)?.[1].trim().toUpperCase();
    if (RFC.test(value || '')) return value;
  }
  return '';
}

// Credentials are passed by the local caller in memory. This module only sends
// signed requests to the SAT endpoints defined by ServiceEndpoints.cfdi().
export function createSatConnector(sdk, { rfc, certificate, privateKey, password }) {
  ensure(RFC.test(rfc), 'RFC inválido.');
  const encoding = value => Buffer.from(value).toString('latin1');
  const fiel = sdk.Fiel.create(encoding(certificate), encoding(privateKey), password);
  ensure(fiel.isValid(), 'Usa una e.firma vigente con su llave y contraseña.');
  ensure(certificateRfc(fiel, certificate) === rfc,
    'La e.firma debe corresponder al RFC del expediente.');
  const service = new sdk.Service(new sdk.FielRequestBuilder(fiel), new sdk.HttpsWebClient(), sdk.ServiceEndpoints.cfdi());
  return {
    async request({ start, end, endTime = '23:59:59', direction = 'received' }) {
      ensure(validDate(start) && validDate(end) && start <= end, 'Periodo inválido.');
      ensure(/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(endTime), 'Hora de cierre inválida.');
      ensure(direction === 'received' || direction === 'issued', 'Dirección inválida.');
      let query = sdk.QueryParameters.create()
        .withPeriod(sdk.DateTimePeriod.createFromValues(start + ' 00:00:00', end + ' ' + endTime))
        .withDownloadType(direction === 'received' ? sdk.DownloadType.received() : sdk.DownloadType.issued())
        .withRequestType(sdk.RequestType.xml());
      if (direction === 'received') query = query.withDocumentStatus(sdk.DocumentStatus.active());
      const errors = query.validate();
      ensure(!errors.length, errors.join(' · '));
      const result = accepted(await service.query(query), 'El SAT rechazó la solicitud');
      const id = result.getRequestId();
      ensure(REQUEST_ID.test(id), 'El SAT no devolvió un identificador válido.');
      return id;
    },
    async check(id) {
      ensure(REQUEST_ID.test(id), 'Identificador de solicitud inválido.');
      const result = accepted(await service.verify(id), 'El SAT no pudo verificar la solicitud');
      const status = result.getStatusRequest();
      if (status.isTypeOf('Accepted') || status.isTypeOf('InProgress')) return { status: 'pending', packages: [] };
      for (const [type, label] of [['Expired', 'expired'], ['Failure', 'failed'], ['Rejected', 'rejected']]) {
        if (status.isTypeOf(type)) return { status: label, packages: [] };
      }
      ensure(status.isTypeOf('Finished'), 'El SAT devolvió un estado desconocido.');
      const packages = [...new Set(result.getPackageIds())];
      ensure(packages.every(packageId => REQUEST_ID.test(packageId)), 'El SAT devolvió un identificador de paquete inválido.');
      return { status: 'finished', packages };
    },
    async download(id) {
      ensure(REQUEST_ID.test(id), 'Identificador de paquete inválido.');
      const result = accepted(await service.download(id), 'El SAT no entregó el paquete');
      const content = result.getPackageContent();
      ensure(typeof content === 'string' && content.length <= 4 * Math.ceil(PACKAGE_LIMIT / 3),
        'Paquete inválido o mayor de 80 MB.');
      const archive = Buffer.from(content, 'base64');
      ensure(archive.length >= 22 && archive.length <= PACKAGE_LIMIT &&
        [0x04034b50, 0x06054b50].includes(archive.readUInt32LE()), 'El SAT no devolvió un ZIP válido.');
      return archive;
    }
  };
}

// The caller persists requestId and imported package IDs. Failed imports are
// left pending so that the next scheduled execution can retry safely.
export async function advanceSatJob(connector, job, save, importPackage) {
  if (job.status !== 'pending') return job;
  const result = await connector.check(job.requestId);
  if (result.status === 'pending') return job;
  if (result.status !== 'finished') {
    const next = { ...job, status: result.status };
    await save(next);
    return next;
  }
  let next = { ...job, imported: [...(job.imported || [])] };
  for (const id of result.packages) {
    if (next.imported.includes(id)) continue;
    await importPackage({ rfc: job.rfc, id, archive: await connector.download(id) });
    next = { ...next, imported: [...next.imported, id] };
    await save(next);
  }
  next = { ...next, status: 'finished' };
  await save(next);
  return next;
}
