import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createPacoSATService } from './local-server.mjs';
import { crc32 } from './xml-core.mjs';

/* ================================================================
   Ronda 3.1.1 · folios en el SERVIDOR — la rama {type:'folios'}
   de POST /api/request con su ciclo de trabajos y su cerco.

   El motor (requestFolio del conector) se prueba en
   ronda311folios.test.mjs; aquí se prueba lo que el servidor
   añade: la fila del trabajo (kind 'folios' con su folio), la
   guardia propia (ya en el expediente no se pide; en curso no
   se duplica), el sentido y la fecha que salen de los metadatos
   guardados, el avance por verifyJobs hasta importar el XML, y
   el cercado por alcance — el mismo de todas las peticiones:
   sin e.firma desbloqueada no se pide, y un usuario con nombre
   de solo lectura no puede pedir NADA (403), folios incluidos.
   ================================================================ */
const MFI = 'MFI6212158B4';
const IEAF = 'IEAF690704QQ9';
const EMISOR = 'AAA010101AAA';
const F1 = '31110000-0000-4000-8000-0000000000F1';
const F9 = '31110000-0000-4000-8000-0000000000F9';
const CERT_B64 = 'MIIDEzCCAfugAwIBAgIUfFs/rHFz67k3fvC0q/J/MXrXGY0wDQYJKoZIhvcNAQELBQAwGTEXMBUGA1UEAwwOUGFjb1NBVCBQcnVlYmEwHhcNMjYxMTA5MDEwNDUxWhcNMzYxMTA2MDEwNDUxWjAZMRcwFQYDVQQDDA5QYWNvU0FUIFBydWViYTCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBALapu0VKqM0A+oN20MgwDgfjCV78C+snlMJTe2t4M+fYR1EU5fx4U0hmcA9vjErIlNfEpG3CVg+cf7M7w56IbCTcQ36g3/4rmGv1E9WBeb5iGxu0XrxGcj/rHFxW8p0UFjfqJf2qM+SfYSscg2jw/xsD730N9z5C1Q0FPF3n3ygekeL871HFINvo9uxlMLwK2crdU4NFJzARMlV6LZlvi+9l1jmGOzgP/Ldg1uhJThWoH2th36/NcAnIhaUXFQtoRb6MlMT9WWLDAJMpLcmrGLfFhbZkz+svrM6bz51P9xJECCxinHTiEF00hSaD2ceWfgNMFG4SNbjz1zJucaiC0tsCAwEAAaNTMFEwHQYDVR0OBBYEFNk7BZ5VXVB+IQ5edFRi/NkvKodZMB8GA1UdIwQYMBaAFNk7BZ5VXVB+IQ5edFRi/NkvKodZMB8GA1UdEwEB/wQFMAMBAf8wDQYJKoZIhvcNAQELBQADggEBAGu4dnfasM2J9JClmUYc+dLrrRgJBPtIIiAX9zdKfxM0pgkzJrdI6N1F5X3zxoIlRKYePlOqL2Wiz2XSvFT6m8m1X8oN3tKYTp4jgcapmJvX+7rJjX73fRAYeklnLvhIsGcNPWhHilnhS6bccxDmYnR2JEcdwqomemZ6hKGNXMmljIVv3Q6GrERk0sFzvau3xDdLhmJyOKAM06x3xIv2+Icb0StMVAjOypFMdHQtdNTE+U2WzxDHBvU=';
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(r => setImmediate(r)); };

class FixtureParser {
  parseFromString(xml) {
    const text = String(xml);
    const uuid = (text.match(/UUID="([^"]+)"/) || [])[1] || '62345678-1234-1234-1234-1234567890AB';
    const rfcDe = tag => (text.match(new RegExp('<cfdi:' + tag + '[^>]*Rfc="([^"]+)"')) || [])[1] || '';
    const emisor = rfcDe('Emisor') || 'BBB010101BBB';
    const receptor = rfcDe('Receptor') || 'CCC010101CCC';
    const cfdi = 'http://www.sat.gob.mx/cfd/4', tfd = 'http://www.sat.gob.mx/TimbreFiscalDigital';
    const node = (localName, data = {}, children = [], namespaceURI = cfdi) => ({
      localName, namespaceURI, nodeType: 1, childNodes: children,
      getAttribute: name => data[name] || '',
      getElementsByTagNameNS: (namespace, name) => children.filter(child => child.namespaceURI === namespace && child.localName === name)
    });
    const documentElement = node('Comprobante',
      { Fecha: '2026-11-05T09:00:00', Total: '1160.00', Moneda: 'MXN', TipoDeComprobante: 'I' }, [
        node('Emisor', { Rfc: emisor }), node('Receptor', { Rfc: receptor }),
        node('Complemento', {}, [node('TimbreFiscalDigital', { UUID: uuid }, [], tfd)])]);
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
const cabeceraMeta = 'Uuid~RfcEmisor~NombreEmisor~RfcReceptor~NombreReceptor~FechaEmision~FechaCertificacion~PacCertifico~Monto~EfectoComprobante~Estatus~FechaCancelacion';
const filaMeta = (uuid, receptor, monto) =>
  uuid + '~' + EMISOR + '~EMISOR SA~' + receptor + '~RECEPTOR SA~2026-11-05T09:00:00~2026-11-05T09:01:00~SAT970701NN3~' + monto + '~I~1~';
const xmlDe = (uuid, receptor) => '<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital" Version="4.0" Serie="F" Folio="A-100" Fecha="2026-11-05T09:00:00" SubTotal="1000.00" Total="1160.00" Moneda="MXN" TipoDeComprobante="I"><cfdi:Emisor Rfc="' + EMISOR + '" Nombre="EMISOR SA"/><cfdi:Receptor Rfc="' + receptor + '" Nombre="RECEPTOR SA"/><cfdi:Conceptos><cfdi:Concepto Cantidad="1" ClaveProdServ="01010101" Descripcion="Prueba" ValorUnitario="1000.00" Importe="1000.00"/></cfdi:Conceptos><cfdi:Complemento><tfd:TimbreFiscalDigital Version="1.1" UUID="' + uuid + '" FechaTimbrado="2026-11-05T09:01:00" SelloCFD="AAAAAAAAAA==" SelloSAT="BBBBBBBBBB=="/></cfdi:Complemento></cfdi:Comprobante>';

function makeService() {
  let time = Date.parse('2026-11-20T15:00:00Z');
  let counter = 0;
  const folioPorSolicitud = new Map();
  const origin = 'http://127.0.0.1:43729';
  const service = createPacoSATService({
    dbFile: ':memory:', html: '<!--PACOSAT_TOKEN-->', origin, now: () => time,
    proxyKey: 'clave-de-prueba-311',
    makeConnector: async args => {
      const miRfc = args?.rfc || '';
      return { parser: FixtureParser, connector: {
        request: async options => 'request-' + (++counter) + (options?.type === 'metadata' ? '-meta' : ''),
        requestFolio: async ({ folio }) => {
          const id = 'folio-req-' + (++counter);
          folioPorSolicitud.set(id, folio);
          return id;
        },
        check: async id => ({ status: 'finished', packages: [id + '-pkg'] }),
        download: async packageId => {
          const base = packageId.replace(/-pkg$/, '');
          if (base.endsWith('-meta'))
            return archive([cabeceraMeta, filaMeta(F9, miRfc || MFI, '700.00')].join('\n'), 'metadata.txt');
          const folio = folioPorSolicitud.get(base);
          if (folio) return archive(xmlDe(folio, miRfc || MFI), 'folio.xml');
          return archive(xmlDe(F1, miRfc || MFI), 'test.xml');
        }
      } };
    },
    makeMailer: () => ({ verify: async () => true, sendMail: async () => {} })
  });
  let token;
  async function call(path, data, options = {}) {
    const headers = { host: new URL(origin).host, origin, 'x-pacosat-token': token,
      'x-pacosat-proxy': 'clave-de-prueba-311', ...options };
    const req = Object.assign(Readable.from(data === undefined ? [] : [Buffer.from(JSON.stringify(data))]), {
      url: path, method: data === undefined ? 'GET' : 'POST', headers });
    let response;
    const res = { setHeader() {}, writeHead(status) { this.status = status; this.headersSent = true; },
      end(content) { response = new Response(content, { status: this.status }); } };
    await service.handle(req, res);
    return response;
  }
  return { service, call,
    async setup() {
      const homeHtml = await (await call('/')).text();
      token = homeHtml.match(/name="pacosat-token" content="([^"]+)"/)[1];
      assert.equal((await call('/api/mail', { host: 'smtp.example.com', port: 587, from: 'from@example.com',
        recipient: 'to@example.com', user: '', password: '' })).status, 200);
    },
    async desbloquear(rfc) {
      const cer = Buffer.from(CERT_B64, 'base64').toString('base64');
      const key = Buffer.from('llave-de-prueba').toString('base64');
      const res = await call('/api/unlock', { rfc, minutes: 600, days: 7, direction: 'received',
        password: 'simulated', certificate: cer, key });
      assert.equal(res.status, 200, 'unlock de ' + rfc);
    },
    async tickHasta(condicion, tope = 40) {
      for (let i = 0; i < tope; i++) {
        await service.tick(); await flush();
        if (await condicion()) return true;
        time += 5 * 60 * 1000;
      }
      return false;
    } };
}

/* ===== (f) El ciclo completo de un folio en el servidor ===== */
{
  const t = makeService();
  await t.setup();
  await t.desbloquear(MFI);
  /* Sin metadatos previos: el folio se pide igual (sentido
     recibidos por defecto) y su trabajo nace bien formado. */
  let res = await t.call('/api/request', { rfc: MFI, type: 'folios', folios: [F1] });
  assert.equal(res.status, 200, 'la petición por folios responde 200');
  let body = await res.json();
  assert.equal(body.pedidas.length, 1, 'un folio pedido');
  assert.equal(body.pedidas[0].folio, F1);
  assert.ok(body.pedidas[0].requestId, 'con su identificador del SAT');
  let st = await (await t.call('/api/status')).json();
  let job = (st.jobs || []).find(j => j.kind === 'folios' && j.folio === F1);
  assert.ok(job, 'el trabajo por folio existe en el estado');
  assert.equal(job.status, 'pending');
  assert.equal(job.direction, 'received');
  /* En curso no se duplica. */
  res = await t.call('/api/request', { rfc: MFI, type: 'folios', folios: [F1] });
  body = await res.json();
  assert.deepEqual(body.enCurso, [F1], 'el mismo folio en curso se nombra, no se re-pide');
  assert.equal(body.pedidas.length, 0);
  /* El ciclo lo avanza verifyJobs y el XML entra al expediente. */
  const cerro = await t.tickHasta(async () => {
    const s = await (await t.call('/api/status')).json();
    return (s.jobs || []).some(j => j.kind === 'folios' && j.folio === F1 && j.status === 'finished');
  });
  assert.ok(cerro, 'el trabajo por folio termina');
  /* Ya en el expediente no se vuelve a pedir. */
  res = await t.call('/api/request', { rfc: MFI, type: 'folios', folios: [F1] });
  body = await res.json();
  assert.deepEqual(body.yaEstaban, [F1], 'el folio importado se reconoce como ya en el expediente');
  assert.equal(body.pedidas.length, 0);
  t.service.close();
  console.log('OK 3.1.1 · (f) folios en el servidor: petición, guardia, avance e ingesta.');
}

/* ===== (g) Sentido y fecha desde los metadatos guardados ===== */
{
  const t = makeService();
  await t.setup();
  await t.desbloquear(MFI);
  const resMeta = await t.call('/api/request', { rfc: MFI, direction: 'received', type: 'metadata',
    start: '2026-11-01', end: '2026-11-20' });
  assert.equal(resMeta.status, 200, 'solicitud de metadatos');
  const conMeta = await t.tickHasta(async () => {
    const s = await (await t.call('/api/status')).json();
    return (s.metadata?.records || 0) >= 1;
  });
  assert.ok(conMeta, 'los metadatos entraron (F9 consta, recibida, del 2026-11-05)');
  const res = await t.call('/api/request', { rfc: MFI, type: 'folios', folios: [F9] });
  assert.equal(res.status, 200);
  const st = await (await t.call('/api/status')).json();
  const job = (st.jobs || []).find(j => j.kind === 'folios' && j.folio === F9);
  assert.ok(job, 'trabajo de F9 creado');
  assert.equal(job.direction, 'received', 'el sentido sale de sus metadatos');
  assert.equal(job.periodStart, '2026-11-05', 'la fecha del trabajo es la de emisión que consta, no una inventada');
  t.service.close();
  console.log('OK 3.1.1 · (g) el trabajo por folio hereda sentido y fecha de los metadatos.');
}

/* ===== (h) Validación y cercado por alcance ===== */
{
  const t = makeService();
  await t.setup();
  await t.desbloquear(MFI);
  /* Folio mal formado: se nombra en errores, no se pide nada. */
  let res = await t.call('/api/request', { rfc: MFI, type: 'folios', folios: ['no-es-un-uuid'] });
  assert.equal(res.status, 200);
  let body = await res.json();
  assert.equal(body.errores.length, 1, 'el folio inválido se reporta por folio');
  assert.equal(body.pedidas.length, 0);
  /* El lote tiene tope: 101 folios no pasan. */
  const ciento1 = Array.from({ length: 101 }, (_, i) =>
    '31110000-0000-4000-8000-' + String(i).padStart(12, '0'));
  res = await t.call('/api/request', { rfc: MFI, type: 'folios', folios: ciento1 });
  assert.notEqual(res.status, 200, 'un lote de 101 folios se rechaza entero');
  /* Sin e.firma desbloqueada de ese RFC no se pide nada. */
  res = await t.call('/api/request', { rfc: IEAF, type: 'folios', folios: [F1] });
  assert.notEqual(res.status, 200, 'sin desbloqueo de IEAF, la petición se rechaza');
  /* Un usuario con nombre de solo lectura no puede pedir:
     el mismo 403 de solo lectura de cualquier otra petición. */
  res = await t.call('/api/users', { nombre: 'Contadora', usuario: 'contadora311',
    password: 'clave-contadora-311', rol: 'lectura', rfcs: [IEAF], contadora: true });
  assert.equal(res.status, 200, 'el principal crea a la contadora');
  res = await t.call('/api/users/login', { usuario: 'contadora311', password: 'clave-contadora-311' });
  assert.equal(res.status, 200, 'la contadora entra');
  const login = await res.json();
  res = await t.call('/api/request', { rfc: IEAF, type: 'folios', folios: [F1] },
    { 'x-pacosat-token': login.token });
  assert.equal(res.status, 403, 'la contadora (solo lectura) no puede pedir folios: 403');
  t.service.close();
  console.log('OK 3.1.1 · (h) validación del lote y cercado por alcance de la vía por folios.');
}
console.log('OK 3.1.1 · folios en el servidor completo.');
