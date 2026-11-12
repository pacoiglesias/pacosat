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
  /* Timeout duro de 60 s (1.6.15, mejora nº 2): el SDK crea sus
     peticiones SIN timeout si el cliente web no lo fija, y una conexión
     colgada congelaba el ciclo automático entero en silencio. El tercer
     argumento de HttpsWebClient es ese timeout, en milisegundos. */
  /* Firma REAL del SDK 2.0.0 (verificada contra su código y su
     .d.ts, 1.19.0): Service(requestBuilder, webClient, token?,
     endpoints?) — el token va TERCERO y los endpoints CUARTOS.
     Pasar los endpoints en el hueco del token dejaba el servicio
     con un «token» sin isValid() y la primera llamada moría en
     obtainCurrentToken() con un TypeError. */
  const service = new sdk.Service(new sdk.FielRequestBuilder(fiel), new sdk.HttpsWebClient(undefined, undefined, 60000), undefined, sdk.ServiceEndpoints.cfdi());
  return {
    async request({ start, end, startTime = '00:00:00', endTime = '23:59:59', direction = 'received', type = 'cfdi' }) {
      ensure(validDate(start) && validDate(end) && start <= end, 'Periodo inválido.');
      ensure(/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(startTime), 'Hora de inicio inválida.');
      ensure(/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(endTime), 'Hora de cierre inválida.');
      ensure(direction === 'received' || direction === 'issued', 'Dirección inválida.');
      ensure(type === 'cfdi' || type === 'metadata', 'Tipo de solicitud inválido.');
      /* Filtro de estado: la doctrina del hallazgo #5 (1.6.10) era
         «pedir todo, sin filtro», pero el servicio del SAT NO lo
         admite para recibidos en XML: su propio validador (SDK
         2.0.0, QueryValidator) rechaza «XML Recibidos» sin estado
         «active» — «No es posible hacer una consulta de XML
         Recibidos que contenga Cancelados». Corrección 1.19.0:
         recibidos+XML se piden SOLO vigentes (lo único que el SAT
         entrega en XML de terceros) y los cancelados recibidos se
         conocen por las solicitudes Metadata — sin restricción de
         estado — que el sistema ya envía y concilia; emitidos y
         Metadata siguen sin filtro, como mandaba el hallazgo.
         El estado inicial de cada CFDI se registra al importarlo
         (desde los metadatos).
         Los enums del SDK 2.0.0 son clases BaseEnum SIN fábricas
         estáticas (DownloadType.received() NO existe: la descarga
         automática murió en producción el 10 nov 2026 con ese
         TypeError, invisible para la suite porque el doble de
         pruebas sí las definía). Se construyen con new y el id:
         new DownloadType('received'), new RequestType('xml'). */
      const query = sdk.QueryParameters.create()
        .withPeriod(sdk.DateTimePeriod.createFromValues(start + ' ' + startTime, end + ' ' + endTime))
        .withDownloadType(new sdk.DownloadType(direction))
        .withRequestType(new sdk.RequestType(type === 'metadata' ? 'metadata' : 'xml'));
      if (direction === 'received' && type === 'cfdi')
        query.withDocumentStatus(new sdk.DocumentStatus('active'));
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
      // CodigoEstadoSolicitud de la verificación (p. ej. 5002: solicitudes de
      // por vida agotadas para el criterio). Se propaga para que el servicio
      // aprenda qué criterios ya no debe volver a enviar.
      const code = typeof result.getCodeRequest === 'function' ? result.getCodeRequest()?.getValue() : undefined;
      const status = result.getStatusRequest();
      if (status.isTypeOf('Accepted') || status.isTypeOf('InProgress')) return { status: 'pending', packages: [], code };
      for (const [type, label] of [['Expired', 'expired'], ['Failure', 'failed'], ['Rejected', 'rejected']]) {
        if (status.isTypeOf(type)) return { status: label, packages: [], code };
      }
      ensure(status.isTypeOf('Finished'), 'El SAT devolvió un estado desconocido.');
      const packages = [...new Set(result.getPackageIds())];
      ensure(packages.every(packageId => REQUEST_ID.test(packageId)), 'El SAT devolvió un identificador de paquete inválido.');
      return { status: 'finished', packages, code };
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
export async function advanceSatJob(connector, job, save, importPackage, hooks = {}) {
  if (job.status !== 'pending') return job;
  const result = await connector.check(job.requestId);
  if (result.status === 'pending') return { ...job, satCode: result.code };
  if (result.status !== 'finished') {
    const next = { ...job, status: result.status, satCode: result.code };
    await save(next);
    return next;
  }
  let next = { ...job, imported: [...(job.imported || [])], satCode: result.code };
  for (const id of result.packages) {
    if (next.imported.includes(id)) continue;
    /* Blindaje 5008 (1.6.15, mejora nº 3): el llamador lleva un
       contador persistido de descargas por paquete y decide ANTES de
       descargar si aún quedan intentos (el SAT permite 2). Sin
       intentos, la solicitud se cierra en el estado terminal
       «exhausted» con su paquete nombrado: nunca un «pendiente»
       eterno que nadie descubre hasta meses después. */
    if (hooks.beforeDownload && !await hooks.beforeDownload(id)) {
      next = { ...next, status: 'exhausted', exhaustedPackage: id };
      await save(next);
      return next;
    }
    await importPackage({ rfc: job.rfc, id, archive: await connector.download(id) });
    next = { ...next, imported: [...next.imported, id] };
    await save(next);
  }
  next = { ...next, status: 'finished' };
  await save(next);
  return next;
}
