import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPacoSATService, migrarConfigArranque310 } from './local-server.mjs';
import { encryptSecret, decryptSecret, isEncryptedSecret } from './secret-box.mjs';
import { crc32 } from './xml-core.mjs';

/* ================================================================
   Ronda 3.1.0 · servidor — multi-RFC sin mezclar (lado servidor),
   «Ponerme al día» sin credenciales y la contraseña del archivo
   de arranque cifrada.

   Comprobación de verdad con DOS RFC de fixture (MFI6212158B4 y
   IEAF690704QQ9, el personal de Paco, sin credenciales):
   (a) el estado trae los metadatos CONTADOS POR RFC (porRfc):
       lo de cada uno, separado, sin el total disfrazado de suyo;
   (b) «Ponerme al día» de un contribuyente dado de alta SIN
       acceso resuelve al instante (200) con el veredicto en
       llano «falta-acceso» — nunca el 404 que dejaba la tarjeta
       en «Revisando…» para siempre — y un RFC desconocido sigue
       dando 404;
   (c) el resumen final de la corrida trae los cuatro grupos
       (nuevas / ya estaban / pendientes / con error) contados
       de las fuentes reales: el portal entrega una nueva, la
       vía masiva repite esa misma (ya estaba) y otra queda
       pendiente pedida;
   (d) la contraseña de config.profiles viaja a makeConnector
       DESCIFRADA (un enc:v1: se abre en memoria; un legado en
       claro sigue funcionando) y la migración asistida la cifra
       EN EL ARCHIVO una vez leída, idempotente.
   ================================================================ */
const MFI = 'MFI6212158B4';
const IEAF = 'IEAF690704QQ9';
const EMISOR = 'AAA010101AAA';
const CERT_B64 = 'MIIDEzCCAfugAwIBAgIUfFs/rHFz67k3fvC0q/J/MXrXGY0wDQYJKoZIhvcNAQELBQAwGTEXMBUGA1UEAwwOUGFjb1NBVCBQcnVlYmEwHhcNMjYxMTA5MDEwNDUxWhcNMzYxMTA2MDEwNDUxWjAZMRcwFQYDVQQDDA5QYWNvU0FUIFBydWViYTCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBALapu0VKqM0A+oN20MgwDgfjCV78C+snlMJTe2t4M+fYR1EU5fx4U0hmcA9vjErIlNfEpG3CVg+cf7M7w56IbCTcQ36g3/4rmGv1E9WBeb5iGxu0XrxGcj/rHFxW8p0UFjfqJf2qM+SfYSscg2jw/xsD730N9z5C1Q0FPF3n3ygekeL871HFINvo9uxlMLwK2crdU4NFJzARMlV6LZlvi+9l1jmGOzgP/Ldg1uhJThWoH2th36/NcAnIhaUXFQtoRb6MlMT9WWLDAJMpLcmrGLfFhbZkz+svrM6bz51P9xJECCxinHTiEF00hSaD2ceWfgNMFG4SNbjz1zJucaiC0tsCAwEAAaNTMFEwHQYDVR0OBBYEFNk7BZ5VXVB+IQ5edFRi/NkvKodZMB8GA1UdIwQYMBaAFNk7BZ5VXVB+IQ5edFRi/NkvKodZMB8GA1UdEwEB/wQFMAMBAf8wDQYJKoZIhvcNAQELBQADggEBAGu4dnfasM2J9JClmUYc+dLrrRgJ5/jbEGNSng61Ydm9vqDuFnGZ4jBPtIIiAX9zdKfxM0pgkzJrdI6N1F5X3zxoIlRKYePlOqL2Wiz2XSvFT/6m8m1X8oN3tKYTp4jgcapmJvX+7rJjX73fRAYeklnLvhIsGcNPWhHilnhS6bccxDmYnR2JEcdwqomemZ6hKGNXMmljIVv3Q6GrERk0sFzvau3xDdLhmJyOKAM06x3xIv9MDOiPFSHdZbNqCXlQaBVmx3/UCEssgXiFi2D6HOg0T4dFNoswqi34gporXtb/MwaJjv5+Icb0StMVAjOypFMdHQtdNTE+U2WzxDHBvU=';
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(r => setImmediate(r)); };

class FixtureParser {
  parseFromString(xml) {
    const text = String(xml);
    const uuid = (text.match(/UUID="([^"]+)"/) || [])[1] || '62345678-1234-1234-1234-1234567890AB';
    /* Emisor/Receptor salen del propio XML (como el parser real):
       así un paquete de la vía masiva con un CFDI de verdad se
       ingiere contra su UUID y su RFC, no contra un juguete. */
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

function makeService(opciones = {}) {
  let time = Date.parse('2026-11-20T15:00:00Z');
  let counter = 0;
  const calls = [];
  const origin = 'http://127.0.0.1:43729';
  /* Metadatos por RFC pedido: MFI conoce DOS folios; IEAF, UNO. */
  const metas = {
    [MFI]: [cabeceraMeta, filaMeta('31000000-0000-4000-8000-0000000000A1', MFI, '1160.00'),
      filaMeta('31000000-0000-4000-8000-0000000000A2', MFI, '500.00')].join('\n'),
    [IEAF]: [cabeceraMeta, filaMeta('31000000-0000-4000-8000-0000000000A3', IEAF, '700.00')].join('\n')
  };
  const service = createPacoSATService({
    dbFile: ':memory:', html: '<!--PACOSAT_TOKEN-->', origin, now: () => time,
    proxyKey: 'clave-de-prueba-310',
    ...(opciones.efirmaDir ? { efirmaDir: opciones.efirmaDir } : {}),
    makeConnector: opciones.makeConnector || (async args => {
      /* El conector nace POR PERFIL: su RFC viene en los
         argumentos de makeConnector (las opciones de request del
         SAT no lo llevan) — de él salen los metadatos de SU RFC. */
      const miRfc = args?.rfc || '';
      return { parser: FixtureParser, connector: {
        request: async options => { calls.push(options); return 'request-' + (++counter); },
        check: async id => ({ status: 'finished', packages: [id + '-pkg'] }),
        download: async packageId => {
          const req = calls[Number(packageId.replace('request-', '').replace('-pkg', '')) - 1];
          if (req?.type === 'metadata') return archive(metas[miRfc] || cabeceraMeta, 'metadata.txt');
          /* La vía masiva trae el paquete del mes: dentro viene la
             factura A1 (la misma que el portal ya entregó) — su
             ingesta cuenta como duplicada, no como nueva. */
          return archive(xmlDe('31000000-0000-4000-8000-0000000000A1', miRfc || MFI), 'test.xml');
        }
      } };
    }),
    satPortalFetch: opciones.satPortalFetch || (async (who, { items }) => {
      /* El portal entrega SOLO la A1: la A2 no sale en su listado
         (queda para la vía masiva, como las canceladas de verdad
         antes de esta ronda). */
      const files = items.filter(item => item.direction === 'received' &&
          item.uuid === '31000000-0000-4000-8000-0000000000A1')
        .map(item => ({ uuid: item.uuid, buffer: Buffer.from(xmlDe(item.uuid, who)) }));
      return { files, found: items.length, downloaded: files.length,
        quotaUsed: files.length, notes: [], complete: files.length === items.length };
    }),
    makeMailer: () => ({ verify: async () => true, sendMail: async () => {} })
  });
  let token;
  async function call(path, data, options = {}) {
    const headers = { host: new URL(origin).host, origin, 'x-pacosat-token': token,
      'x-pacosat-proxy': 'clave-de-prueba-310', ...options };
    const req = Object.assign(Readable.from(data === undefined ? [] : [Buffer.from(JSON.stringify(data))]), {
      url: path, method: data === undefined ? 'GET' : 'POST', headers });
    let response;
    const res = { setHeader() {}, writeHead(status) { this.status = status; this.headersSent = true; },
      end(content) { response = new Response(content, { status: this.status }); } };
    await service.handle(req, res);
    return response;
  }
  return { service, call, calls,
    avanzar(ms) { time += ms; },
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
        time += 5 * 60 * 1000; /* pasos de 5 min, como ronda30a: los trabajos vencen a +5 min */
      }
      return false;
    } };
}

/* ===== (a) Metadatos contados POR RFC en el estado ===== */
{
  const t = makeService();
  await t.setup();
  await t.desbloquear(MFI);
  await t.desbloquear(IEAF);
  for (const rfc of [MFI, IEAF]) {
    const res = await t.call('/api/request', { rfc, direction: 'received', type: 'metadata',
      start: '2026-11-01', end: '2026-11-20' });
    assert.equal(res.status, 200, 'solicitud de metadatos de ' + rfc);
    /* La siguiente solicitud espera a que esta se procese: el
       servidor no acepta dos a la vez (busy) y no fingimos otra
       cosa. */
    await t.tickHasta(async () => {
      const st = await (await t.call('/api/status')).json();
      return (st.metadata?.records || 0) >= (rfc === MFI ? 2 : 3);
    });
  }
  const listo = await t.tickHasta(async () => {
    const st = await (await t.call('/api/status')).json();
    return (st.metadata?.records || 0) >= 3;
  });
  assert.ok(listo, 'los metadatos de ambos RFC se ingirieron');
  const st = await (await t.call('/api/status')).json();
  assert.equal(st.metadata.records, 3, 'el total sigue siendo el total (3)');
  assert.ok(st.metadata.porRfc, 'el estado trae el desglose por RFC');
  assert.equal(st.metadata.porRfc[MFI]?.records, 2, 'MFI: sus 2 registros, no el total');
  assert.equal(st.metadata.porRfc[IEAF]?.records, 1, 'IEAF: su 1 registro, no el total');
  assert.ok(st.metadata.porRfc[MFI]?.lastSeen, 'cada RFC trae su última lectura');
  t.service.close();
  console.log('OK 3.1.0 · (a) metadatos por RFC en /api/status (porRfc).');
}

/* ===== (b) «Ponerme al día» sin credenciales: veredicto al instante ===== */
{
  const t = makeService();
  await t.setup();
  /* IEAF se da de alta SIN credenciales (el alta preparada). */
  const alta = await t.call('/api/profiles/prepare', { rfc: IEAF });
  assert.equal(alta.status, 200, 'alta preparada de IEAF');
  const estado = await t.call('/api/al-dia/state?rfc=' + IEAF);
  assert.equal(estado.status, 200, 'el estado de un RFC sin acceso NO es 404');
  const vista = await estado.json();
  assert.equal(vista.veredicto?.estado, 'falta-acceso',
    'veredicto en llano: falta dar de alta su acceso');
  assert.match(vista.veredicto?.frase || '', /Falta dar de alta su acceso/);
  const run = await t.call('/api/al-dia/run', { rfc: IEAF });
  assert.equal(run.status, 200, 'lanzar la puesta al día tampoco es 404');
  const vistaRun = await run.json();
  assert.equal(vistaRun.veredicto?.estado, 'falta-acceso');
  assert.equal(vistaRun.running, false, 'sin acceso no corre nada');
  /* Un RFC que ni siquiera es contribuyente sigue siendo 404. */
  const desconocido = await t.call('/api/al-dia/state?rfc=XAXX010101000');
  assert.equal(desconocido.status, 404, 'un RFC desconocido sigue en 404');
  /* Y un RFC CON acceso no recibe el veredicto de falta. */
  await t.desbloquear(MFI);
  const vistaMfi = await (await t.call('/api/al-dia/state?rfc=' + MFI)).json();
  assert.notEqual(vistaMfi.veredicto?.estado, 'falta-acceso',
    'con acceso desbloqueado, el veredicto es el de verdad');
  t.service.close();
  console.log('OK 3.1.0 · (b) al día sin credenciales: «Falta dar de alta su acceso» al instante.');
}

/* ===== (c) Resumen final accionable: las cuatro cuentas ===== */
{
  const t = makeService();
  await t.setup();
  await t.desbloquear(MFI);
  /* Una sola corrida con el reparto completo: el metadato conoce
     DOS recibidas de MFI; el portal entrega la A1 (nueva); la A2
     no sale en el portal y va por la vía masiva, cuyo paquete del
     mes trae OTRA VEZ la A1 (ya estaba: duplicada, no nueva) y
     no la A2 — que queda pendiente, pedida. Sin errores. */
  const res = await t.call('/api/al-dia/run', { rfc: MFI });
  assert.equal(res.status, 200, 'lanzar la puesta al día');
  const ok = await t.tickHasta(async () => {
    const v = await (await t.call('/api/al-dia/state?rfc=' + MFI)).json();
    return v.fin && !v.running;
  }, 80);
  assert.ok(ok, 'la corrida termina');
  const fin = (await (await t.call('/api/al-dia/state?rfc=' + MFI)).json()).fin;
  assert.equal(fin.nuevas, 1, 'nuevas: solo la A1');
  assert.equal(fin.yaEstaban, 1, 'ya estaban: la A1 repetida por la masiva no cuenta como nueva');
  assert.equal(fin.pendientes, 1, 'pendientes: la A2 sigue pedida al SAT');
  assert.equal(fin.conError, 0, 'con error: ninguna en esta corrida');
  t.service.close();
  console.log('OK 3.1.0 · (c) resumen final: nuevas / ya estaban / pendientes / con error.');
}

/* ===== (d) La contraseña del archivo de arranque: cifrada ===== */
{
  const dir = mkdtempSync(join(tmpdir(), 'pacosat-310-config-'));
  try {
    const efirmaDir = join(dir, 'efirma');
    const configPath = join(dir, 'config.json');
    const original = { profiles: [{ rfc: MFI, name: 'Mano Fil', minutes: 360, days: 7,
        direction: 'received', certificatePath: join(dir, 'fiel.cer'), keyPath: join(dir, 'fiel.key'),
        password: 'secreto-en-claro' }],
      mail: { host: 'smtp.example.com', port: 587, from: 'a@b.mx', recipient: 'c@d.mx', user: '', password: 'correo-en-claro' },
      backup: { password: 'respaldo-en-claro' } };
    writeFileSync(configPath, JSON.stringify(original, null, 2));
    /* La migración asistida cifra EN EL ARCHIVO una vez leído. */
    migrarConfigArranque310(configPath, efirmaDir);
    const migrado = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.ok(isEncryptedSecret(migrado.profiles[0].password), 'profiles[0].password queda enc:v1: en el archivo');
    assert.equal(decryptSecret(efirmaDir, migrado.profiles[0].password), 'secreto-en-claro',
      'y descifra al valor original');
    assert.ok(isEncryptedSecret(migrado.mail.password), 'el correo también queda cifrado en el archivo');
    assert.ok(isEncryptedSecret(migrado.backup.password), 'el respaldo también queda cifrado en el archivo');
    const bytes1 = readFileSync(configPath, 'utf8');
    migrarConfigArranque310(configPath, efirmaDir);
    assert.equal(readFileSync(configPath, 'utf8'), bytes1, 'segunda pasada: idempotente, no re-cifra');
    /* El arranque DESCIFRA al usar: makeConnector recibe la
       contraseña en claro (en memoria), venga enc:v1: o legada. */
    const certPath = join(dir, 'fiel.cer'), keyPath = join(dir, 'fiel.key');
    writeFileSync(certPath, Buffer.from(CERT_B64, 'base64'));
    writeFileSync(keyPath, 'llave-de-prueba');
    for (const [etiqueta, password] of [['cifrada', encryptSecret(efirmaDir, 'secreto-en-claro')],
                                        ['legada en claro', 'secreto-en-claro']]) {
      let recibida = null;
      const service = createPacoSATService({ dbFile: ':memory:', html: '<!--PACOSAT_TOKEN-->',
        origin: 'http://127.0.0.1:43729', proxyKey: 'clave-de-prueba-310', efirmaDir,
        makeConnector: async args => { recibida = args.password; return {}; },
        makeMailer: () => ({ verify: async () => true, sendMail: async () => {} }) });
      try {
        await service.bootstrap({ profiles: [{ rfc: MFI, name: 'Mano Fil', minutes: 360, days: 7,
          direction: 'received', certificatePath: certPath, keyPath, password }] });
        assert.equal(recibida, 'secreto-en-claro',
          'makeConnector recibe la contraseña en claro (' + etiqueta + ')');
      } finally { service.close(); }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
  console.log('OK 3.1.0 · (d) config de arranque: descifrado al usar y migración que cifra el archivo.');
}

/* ===== (e) Administración respeta el alcance del conectado =====
   La consola se alimenta de /api/status, /api/notices,
   /api/lists y /api/activity: para un usuario con nombre y
   alcance a UN RFC (la contadora), ninguna de esas fuentes
   puede traer datos —ni conteos— de los demás RFC. */
{
  const t = makeService();
  await t.setup();
  await t.desbloquear(MFI);
  await t.desbloquear(IEAF);
  for (const rfc of [MFI, IEAF]) {
    const res = await t.call('/api/request', { rfc, direction: 'received', type: 'metadata',
      start: '2026-11-01', end: '2026-11-20' });
    assert.equal(res.status, 200, 'solicitud de metadatos de ' + rfc);
    await t.tickHasta(async () => {
      const st = await (await t.call('/api/status')).json();
      return (st.metadata?.records || 0) >= (rfc === MFI ? 2 : 3);
    });
  }
  /* El principal crea a la contadora con alcance SOLO a IEAF. */
  let res = await t.call('/api/users', { nombre: 'Contadora', usuario: 'contadora310',
    password: 'clave-contadora-310', rol: 'lectura', rfcs: [IEAF], contadora: true });
  assert.equal(res.status, 200, 'el principal crea a la contadora');
  res = await t.call('/api/users/login', { usuario: 'contadora310', password: 'clave-contadora-310' });
  assert.equal(res.status, 200, 'la contadora entra con su usuario');
  const login = await res.json();
  assert.ok(login.token, 'su sesión trae token');
  const suya = { 'x-pacosat-token': login.token };
  /* El estado que ella recibe: solo su RFC existe. */
  const stElla = await (await t.call('/api/status', undefined, suya)).json();
  const rfcsElla = (stElla.profiles || []).map(p => p.rfc);
  assert.ok(rfcsElla.includes(IEAF), 'su estado trae su RFC');
  assert.ok(!rfcsElla.includes(MFI), 'y NO el de Mano Fil: ni su perfil ni su conteo');
  assert.deepEqual(Object.keys(stElla.metadata?.porRfc || {}), [IEAF],
    'el desglose de metadatos de su estado solo conoce su RFC');
  assert.equal(stElla.metadata.records, 1, 'su total de metadatos es el SUYO (1), no el de la casa (3)');
  /* La actividad: primero se comprueba que la del principal SÍ
     nombra a MFI (la prueba no es vacía) y luego que la suya no. */
  const actAdmin = await (await t.call('/api/activity')).text();
  assert.ok(actAdmin.includes(MFI), 'la actividad del principal nombra a MFI (hay algo que cercar)');
  const actElla = await (await t.call('/api/activity', undefined, suya)).text();
  assert.ok(!actElla.includes(MFI), 'la actividad de la contadora no nombra a ningún RFC fuera de su alcance');
  /* Los avisos que alimentan la consola: todos de su RFC. */
  const avisosElla = await (await t.call('/api/notices', undefined, suya)).json();
  for (const aviso of avisosElla.avisos || [])
    assert.ok(!aviso.rfc || aviso.rfc === IEAF, 'ningún aviso ajeno llega a su consola: ' + (aviso.titulo || ''));
  t.service.close();
  console.log('OK 3.1.0 · (e) la consola respeta el alcance del usuario conectado.');
}
console.log('OK 3.1.0 · servidor completo.');
