import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createPacoSATService } from './local-server.mjs';
import { crc32, parseXml } from './xml-core.mjs';

/* Ronda 2.9.17: el paquete Metadata REAL del SAT separa los campos
   con «~» (tilde), no con «|». El SDK (@nodecfdi/sat-ws-descarga-
   masiva) lo confirma dos veces: su filtro de contenido exige que
   el archivo empiece por «Uuid~RfcEmisor~» y su CsvReader parte
   cada línea por /[|~]/ (el «|» es el formato histórico).
   Hasta la 2.9.16, parseMetadataText partía SOLO por «|»: con un
   paquete real la cabecera quedaba en una sola celda, cada fila
   entera caía en la columna uuid, ninguna pasaba la validación de
   UUID y el paquete se ingería con 0 registros y SIN error. En
   producción metadata_records quedó vacía pese a decenas de
   trabajos «finished» (octubre completo incluido) y el caminante
   del portal — que lee esa tabla — nunca pudo arrancar.
   La suite metadata.test.mjs no lo cazaba porque su fixture usaba
   «|»: el laboratorio compartía el error. Esta prueba usa el
   formato real y afirma que los registros aterrizan en
   metadata_records y que el faltante se calcula. Contra el código
   de la 2.9.16 esta prueba FALLA (0 registros); con el arreglo,
   pasa. Todo contra un SAT simulado: ninguna solicitud sale. */
const rfc = 'XAXX010101000';
const emitter = 'AAA010101AAA';
const uuidKnown = '12345678-1234-1234-1234-1234567890AB';
const uuidMissing = '22345678-1234-1234-1234-1234567890AB';
const cfdi = 'http://www.sat.gob.mx/cfd/4';
const tfd = 'http://www.sat.gob.mx/TimbreFiscalDigital';
class FixtureParser {
  parseFromString(xml) {
    const node = (localName, data = {}, children = [], namespaceURI = cfdi) => ({
      localName, namespaceURI, nodeType: 1, childNodes: children,
      getAttribute: name => data[name] || '',
      getElementsByTagNameNS: (namespace, name) => children.filter(child => child.namespaceURI === namespace && child.localName === name)
    });
    const documentElement = node('Comprobante', {
      Fecha: '2026-11-08T07:00:00', Total: '80.00', Moneda: 'MXN', TipoDeComprobante: 'I'
    }, [
      node('Emisor', { Rfc: emitter }), node('Receptor', { Rfc: rfc }),
      node('Complemento', {}, [node('TimbreFiscalDigital', { UUID: uuidKnown }, [], tfd)])
    ]);
    return { documentElement, getElementsByTagName: () => [] };
  }
}
function archive(payload, name) {
  const raw = Buffer.from(payload), entry = Buffer.from(name);
  const local = Buffer.alloc(30), central = Buffer.alloc(46), end = Buffer.alloc(22);
  local.writeUInt32LE(0x04034b50); local.writeUInt16LE(entry.length, 26);
  central.writeUInt32LE(0x02014b50); central.writeUInt32LE(crc32(raw), 16);
  central.writeUInt32LE(raw.length, 20); central.writeUInt32LE(raw.length, 24); central.writeUInt16LE(entry.length, 28);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + entry.length, 12); end.writeUInt32LE(local.length + entry.length + raw.length, 16);
  return Buffer.concat([local, entry, raw, central, entry, end]);
}
/* El paquete tal como lo entrega el SAT: cabecera y filas con «~». */
const metadataTextTilde = [
  'Uuid~RfcEmisor~NombreEmisor~RfcReceptor~NombreReceptor~FechaEmision~FechaCertificacion~PacCertifico~Monto~EfectoComprobante~Estatus~FechaCancelacion',
  uuidKnown + '~' + emitter + '~EMISOR SA~' + rfc + '~RECEPTOR SA~2026-11-05T09:00:00~2026-11-05T09:01:00~SAT970701NN3~1160.00~I~1~',
  uuidMissing + '~' + emitter + '~EMISOR SA~' + rfc + '~RECEPTOR SA~2026-11-06T10:00:00~2026-11-06T10:01:00~SAT970701NN3~500.00~I~0~2026-11-07T00:00:00'
].join('\n');
let time = Date.parse('2026-11-08T16:00:00Z'), counter = 0;
const calls = [], sent = [];
const origin = 'http://127.0.0.1:43729';
const service = createPacoSATService({
  dbFile: ':memory:', html: '<!--PACOSAT_TOKEN-->', origin, now: () => time,
  makeConnector: async () => ({ parser: FixtureParser, connector: {
    request: async options => { calls.push(options); return 'request-' + (++counter); },
    check: async id => ({ status: 'finished', packages: [id + '-pkg'] }),
    download: async packageId => {
      const requestIndex = Number(packageId.replace('request-', '').replace('-pkg', '')) - 1;
      return calls[requestIndex]?.type === 'metadata' ? archive(metadataTextTilde, 'metadata.txt') : archive('<fixture/>', 'test.xml');
    }
  } }),
  makeMailer: () => ({ verify: async () => true, sendMail: async payload => { sent.push(payload); } })
});
let token;
async function call(path, data, options = {}) {
  const headers = { host: new URL(origin).host, origin, 'x-pacosat-token': token, ...options };
  const req = Object.assign(Readable.from(data === undefined ? [] : [Buffer.from(JSON.stringify(data))]), {
    url: path, method: data === undefined ? 'GET' : 'POST', headers
  });
  let response;
  const res = { setHeader() {}, writeHead(status) { this.status = status; this.headersSent = true; },
    end(content) { response = new Response(content, { status: this.status }); } };
  await service.handle(req, res);
  return response;
}
try {
  const homeHtml = await (await call('/')).text();
  token = homeHtml.split('content="')[1].split('"')[0];
  assert.equal((await call('/api/mail', { host: 'smtp.example.com', port: 587, from: 'from@example.com',
    recipient: 'to@example.com', user: '', password: '' })).status, 200);
  assert.equal((await call('/api/unlock', { rfc, minutes: 60, days: 7, direction: 'received', password: 'simulated',
    certificate: 'YQ==', key: 'Yg==' })).status, 200);
  assert.equal((await call('/api/monthly/config', { enabled: false, day: 5, hour: 9 })).status, 200);
  /* Primera vuelta: se programan el CFDI y el Metadata diarios; el
     Metadata baja el paquete en formato real (con «~»). */
  await service.tick();
  assert.ok(calls.some(entry => entry.type === 'metadata'), 'Debe programarse la solicitud Metadata diaria.');
  /* Solicitud Metadata manual por la ruta de periodos. */
  const manual = await call('/api/request', { rfc, direction: 'received', start: '2026-10-01', end: '2026-10-31', type: 'metadata' });
  assert.equal(manual.status, 200);
  time += 5 * 60000;
  await service.tick();
  const state = await (await call('/api/status')).json();
  assert.ok(state.jobs.some(job => job.kind === 'metadata' && job.status === 'finished'));
  /* EL CORAZÓN DE LA PRUEBA: con el separador real, los dos
     registros del paquete aterrizan en metadata_records (con el
     código de la 2.9.16 aquí había 0) y el faltante — el que el
     SAT conoce y no tiene XML — se calcula con sus datos. */
  assert.equal(state.metadata.records, 2, 'El paquete con «~» debe ingerir sus 2 registros.');
  assert.deepEqual(state.metadata.missing.map(row => row.uuid), [uuidMissing]);
  assert.equal(state.metadata.missing[0].status, '0');
  assert.equal(state.metadata.missing[0].total, '500.00');
  assert.equal(state.metadata.missing[0].emitter, emitter);
  assert.equal(state.metadata.missing[0].receiver, rfc);
  console.log('OK 2.9.17-metadatos: el paquete Metadata real (separador «~») se ingiere — 2 registros en metadata_records y el faltante calculado con emisor, receptor, monto y estatus.');
} finally { service.close(); }
