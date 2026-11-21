import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createPacoSATService } from './local-server.mjs';

/* ================================================================
   Ronda 3.2.0 · SERVIDOR — las cuatro piezas con datos nuevos:
   la tendencia de Hoy (pieza 12: GET /api/tendencia320, que sale
   del MISMO apiTotales de siempre — un solo cálculo — y viaja
   cercada por alcance), los campos estructurados del buscador
   (pieza 39: rfc/tipo/importe por resultado, con el cerco de
   ronda200h intacto), la forma corta de restaurar un aviso
   (pieza 28: POST /api/avisos320/restaurar, la inversa que ya
   vivía en /api/notices/atencion) y el logotipo por RFC
   (pieza 43: POST/GET /api/logo320 con su validador de firma
   real, su tope y su cerco de escritura).
   ================================================================ */
const MFI = 'MFI6212158B4';
const IEAF = 'IEAF690704QQ9';
const AAA = 'AAA010101AAA';
const CERT_B64 = 'MIIDEzCCAfugAwIBAgIUfFs/rHFz67k3fvC0q/J/MXrXGY0wDQYJKoZIhvcNAQELBQAwGTEXMBUGA1UEAwwOUGFjb1NBVCBQcnVlYmEwHhcNMjYxMTA5MDEwNDUxWhcNMzYxMTA2MDEwNDUxWjAZMRcwFQYDVQQDDA5QYWNvU0FUIFBydWViYTCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBALapu0VKqM0A+oN20MgwDgfjCV78C+snlMJTe2t4M+fYR1EU5fx4U0hmcA9vjErIlNfEpG3CVg+cf7M7w56IbCTcQ36g3/4rmGv1E9WBeb5iGxu0XrxGcj/rHFxW8p0UFjfqJf2qM+SfYSscg2jw/xsD730N9z5C1Q0FPF3n3ygekeL871HFINvo9uxlMLwK2crdU4NFJzARMlV6LZlvi+9l1jmGOzgP/Ldg1uhJThWoH2th36/NcAnIhaUXFQtoRb6MlMT9WWLDAJMpLcmrGLfFhbZkz+svrM6bz51P9xJECCxinHTiEF00hSaD2ceWfgNMFG4SNbjz1zJucaiC0tsCAwEAAaNTMFEwHQYDVR0OBBYEFNk7BZ5VXVB+IQ5edFRi/NkvKodZMB8GA1UdIwQYMBaAFNk7BZ5VXVB+IQ5edFRi/NkvKodZMB8GA1UdEwEB/wQFMAMBAf8wDQYJKoZIhvcNAQELBQADggEBAGu4dnfasM2J9JClmUYc+dLrrRgJBPtIIiAX9zdKfxM0pgkzJrdI6N1F5X3zxoIlRKYePlOqL2Wiz2XSvFT6m8m1X8oN3tKYTp4jgcapmJvX+7rJjX73fRAYeklnLvhIsGcNPWhHilnhS6bccxDmYnR2JEcdwqomemZ6hKGNXMmljIVv3Q6GrERk0sFzvau3xDdLhmJyOKAM06x3xIv2+Icb0StMVAjOypFMdHQtdNTE+U2WzxDHBvU=';
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

class ParserMin { parseFromString() { throw new Error('sin xml en esta suite'); } }

function makeService() {
  const origin = 'http://127.0.0.1:43729';
  const service = createPacoSATService({
    dbFile: ':memory:', html: '<!--PACOSAT_TOKEN-->', origin,
    now: () => Date.parse('2026-11-20T15:00:00Z'),
    proxyKey: 'clave-de-prueba-320',
    makeConnector: async () => ({ parser: ParserMin, connector: {
      request: async () => 'req-320', check: async () => ({ status: 'pending', packages: [] }),
      download: async () => { throw new Error('sin paquetes'); } } }),
    makeMailer: () => ({ verify: async () => true, sendMail: async () => {} })
  });
  async function raw(method, path, data, headers = {}) {
    const req = Object.assign(Readable.from(data === undefined ? [] : [Buffer.from(JSON.stringify(data))]), {
      url: path, method, headers: { host: new URL(origin).host, origin, 'x-pacosat-proxy': 'clave-de-prueba-320', ...headers } });
    let response;
    const hdrs = {};
    const res = { setHeader(k, v) { hdrs[k] = v; },
      writeHead(status, h) { this.status = status; this.headersSent = true; if (h) Object.assign(hdrs, h); },
      end(content) { response = new Response(content, { status: this.status, headers: hdrs }); } };
    await service.handle(req, res);
    return response;
  }
  let token;
  const call = (path, data, headers = {}) => raw(data === undefined ? 'GET' : 'POST', path, data,
    { 'x-pacosat-token': token, ...headers });
  return { service, call, raw,
    async setup() {
      const home = await (await raw('GET', '/')).text();
      token = home.match(/<meta name="pacosat-token" content="([0-9a-f]+)"/)[1];
      assert.equal((await call('/api/mail', { host: 'smtp.example.com', port: 587, from: 'from@example.com',
        recipient: 'to@example.com', user: '', password: '' })).status, 200);
    },
    async desbloquear(rfc) {
      const res = await call('/api/unlock', { rfc, minutes: 600, days: 7, direction: 'received',
        password: 'secreto-prueba', certificate: Buffer.from(CERT_B64, 'base64').toString('base64'),
        key: Buffer.from('llave-de-prueba').toString('base64') });
      assert.equal(res.status, 200, 'unlock de ' + rfc);
    },
    async invitado(rfc) {
      const inv = await (await call('/api/invitado200h', { rfc, dias: 7 })).json();
      assert.ok(inv.clave, 'la clave del invitado');
      const login = await (await raw('POST', '/api/guest/login', { password: inv.clave })).json();
      assert.ok(login.token, 'el invitado entra');
      return { 'x-pacosat-token': login.token };
    } };
}

const factura = (id, date, from, to, total) => ({ id, date, kind: 'I', currency: 'MXN', total,
  from: { rfc: from, name: 'EMPRESA ' + from }, to: { rfc: to, name: 'EMPRESA ' + to },
  fiscal: { paymentMethod: 'PPD', transferred: [], withheld: [] } });

/* ===== (12) La tendencia: los números de apiTotales, por meses ===== */
{
  const t = makeService();
  await t.setup();
  await t.desbloquear(MFI);
  const seed = await t.call('/api/storage', { batch: { invoices: [
    factura('32000000-0000-4000-8000-0000000000E1', '2026-11-05', MFI, AAA, '1160.00'),
    factura('32000000-0000-4000-8000-0000000000R1', '2026-11-07', AAA, MFI, '2320.00'),
    factura('32000000-0000-4000-8000-0000000000E2', '2026-09-03', MFI, AAA, '580.00')] } });
  assert.equal(seed.status, 200, 'siembra de facturas');

  const res = await t.call('/api/tendencia320?rfc=' + MFI);
  assert.equal(res.status, 200, 'la tendencia responde');
  const ten = await res.json();
  assert.equal(ten.rfc, MFI);
  assert.equal(ten.meses.length, 6, 'seis meses, ni uno más');
  assert.equal(ten.meses[5].mes, '2026-11', 'el último es el mes en curso');
  assert.equal(ten.meses[5].emitidas, 1); assert.equal(ten.meses[5].montoEmitidas, '1160.00');
  assert.equal(ten.meses[5].recibidas, 1); assert.equal(ten.meses[5].montoRecibidas, '2320.00');
  assert.equal(ten.meses[3].mes, '2026-09');
  assert.equal(ten.meses[3].emitidas, 1); assert.equal(ten.meses[3].montoEmitidas, '580.00');
  assert.equal(ten.meses[0].emitidas, 0); assert.equal(ten.meses[0].montoEmitidas, '0.00',
    'un mes sin facturas viaja como cero, no se inventa');

  const sinRfc = await t.call('/api/tendencia320');
  assert.equal(sinRfc.status, 400, 'sin RFC y sin alcance único, la tendencia no adivina: 400');

  const gh = await t.invitado(MFI);
  const gPropia = await t.call('/api/tendencia320?rfc=' + MFI, undefined, gh);
  assert.equal(gPropia.status, 200, 'el invitado lee la tendencia de SU RFC');
  const gAjena = await t.call('/api/tendencia320?rfc=' + IEAF, undefined, gh);
  assert.equal(gAjena.status, 403, 'el invitado NO lee la tendencia de otro RFC');
  t.service.close();
  console.log('OK 3.2.0 · tendencia320: valores del cálculo único y cerco por alcance.');
}

/* ===== (39) El buscador: cada resultado con su rfc, tipo e importe ===== */
{
  const t = makeService();
  await t.setup();
  await t.desbloquear(MFI);
  await t.call('/api/storage', { batch: { invoices: [
    factura('32000000-0000-4000-8000-0000000000E1', '2026-11-05', MFI, AAA, '1160.00')] } });
  const res = await t.call('/api/buscar200h?rfc=' + MFI + '&q=' + AAA);
  assert.equal(res.status, 200);
  const busq = await res.json();
  const todos = (busq.porRfc || []).flatMap(p => Object.values(p.grupos || {}).flat());
  const cfdis = todos.filter(r => r.tipo === 'cfdi');
  assert.ok(cfdis.length >= 1, 'la búsqueda encuentra la factura sembrada');
  assert.ok(cfdis.every(r => r.rfc === MFI && r.tipo === 'cfdi'),
    'cada resultado de CFDI lleva su RFC y su tipo');
  assert.ok(cfdis.some(r => r.importe === '1160.00'), 'y su importe cuando lo tiene');
  t.service.close();
  console.log('OK 3.2.0 · buscar200h: resultados estructurados (rfc/tipo/importe).');
}

/* ===== (43) El logotipo: ciclo completo, firma real y cerco ===== */
{
  const t = makeService();
  await t.setup();
  await t.desbloquear(MFI);
  const dataUrl = 'data:image/png;base64,' + PNG_1PX;
  const sube = await t.call('/api/logo320', { rfc: MFI, dataUrl });
  assert.equal(sube.status, 200, 'el logotipo sube: ' + (await sube.clone().text()).slice(0, 120));
  const baja = await t.call('/api/logo320?rfc=' + MFI);
  assert.equal(baja.status, 200, 'y baja');
  assert.match(baja.headers.get('content-type') || '', /image\/png/, 'con su tipo real');
  const bytes = Buffer.from(await baja.arrayBuffer());
  assert.ok(bytes.equals(Buffer.from(PNG_1PX, 'base64')), 'byte a byte el que subió');

  const falso = await t.call('/api/logo320', { rfc: MFI,
    dataUrl: 'data:image/png;base64,' + Buffer.from('esto no es un png').toString('base64') });
  assert.equal(falso.status, 400, 'una firma falsa no se cuela como PNG');
  const sinPerfil = await t.call('/api/logo320', { rfc: 'XXX010101XXX', dataUrl });
  assert.equal(sinPerfil.status, 404, 'sin perfil no hay logotipo');
  const sinLogo = await t.call('/api/logo320?rfc=' + IEAF);
  assert.equal(sinLogo.status, 404, 'un RFC sin logotipo responde 404, no un invento');

  const gh = await t.invitado(MFI);
  const gPost = await t.call('/api/logo320', { rfc: MFI, dataUrl }, gh);
  assert.equal(gPost.status, 403, 'el invitado no escribe logotipos');
  const gGet = await t.call('/api/logo320?rfc=' + MFI, undefined, gh);
  assert.equal(gGet.status, 200, 'pero sí ve el de su RFC');
  t.service.close();
  console.log('OK 3.2.0 · logo320: ciclo, validación de firma y cerco.');
}

/* ===== (28) Restaurar un aviso: la forma corta de la inversa ===== */
{
  const t = makeService();
  await t.setup();
  await t.desbloquear(MFI);
  /* La receta de la casa (1.29.2): la primera lectura quema la
     línea base sin facturas; la factura recibida que entra
     después hace nacer su aviso de saldo. */
  await t.call('/api/notices');
  await t.call('/api/storage', { batch: { people: [{ id: MFI, name: 'MANO FIL SA' }],
    invoices: [factura('32000000-0000-4000-8000-0000000000R9', '2026-10-03', AAA, MFI, '1636.00')] } });
  const lista = await (await t.call('/api/notices')).json();
  const aviso = (lista.avisos || [])[0];
  assert.ok(aviso, 'la factura recibida hace nacer su aviso de saldo');
  const arch = await (await t.call('/api/notices/atencion', { id: aviso.id, accion: 'archivar' })).json();
  assert.ok(!(arch.avisos || []).some(a => a.id === aviso.id), 'archivado sale de la vista activa');
  const rest = await t.call('/api/avisos320/restaurar', { id: aviso.id });
  assert.equal(rest.status, 200, 'la forma corta restaura');
  const restJson = await rest.json();
  assert.equal(restJson.ok, true);
  assert.ok((restJson.avisos || []).some(a => a.id === aviso.id), 'y el aviso vuelve a la vista activa');
  const fantasma = await t.call('/api/avisos320/restaurar', { id: 999999 });
  assert.equal(fantasma.status, 400, 'un aviso que no consta no se restaura');
  const gh = await t.invitado(MFI);
  const gRest = await t.call('/api/avisos320/restaurar', { id: aviso.id }, gh);
  assert.equal(gRest.status, 403, 'el invitado no restaura avisos');
  t.service.close();
  console.log('OK 3.2.0 · avisos320/restaurar: ciclo archivar→restaurar y cerco.');
}
