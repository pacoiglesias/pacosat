import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createPacoSATService } from './local-server.mjs';
import { crc32 } from './xml-core.mjs';

/* ================================================================
   Ronda 3.0 · Bloque A (servidor) — «Ponerme al día»
   La corrida única orquesta lo existente: metadatos → portal →
   masiva de respaldo, con veredicto de las fuentes reales.
   Comprobación de verdad: con un SAT simulado cuyo paquete de
   metadatos (formato real, «~») conoce DOS folios sin XML — uno
   recibido, que el portal SÍ entrega, y uno emitido, que el
   portal NO entrega — la corrida debe: (1) ingerir los
   metadatos, (2) bajar el recibido por el portal (nuevas = 1),
   (3) pedir el emitido por la vía masiva (un trabajo CFDI de su
   mes) y (4) cerrar con la cuenta honesta: 1 nueva, 1 pendiente
   pedida. Además: sin metadatos el veredicto NO es verde
   («sin-revisar»), con el SAT caído la corrida espera y se
   reintenta sola, y Detener cierra con su frase.
   ================================================================ */
const rfc = 'XAXX010101000';
const emitter = 'AAA010101AAA';
const uuidPortal = '12345678-1234-1234-1234-1234567890AB';
const uuidMasiva = '22345678-1234-1234-1234-1234567890AB';
const cfdi = 'http://www.sat.gob.mx/cfd/4';
const tfd = 'http://www.sat.gob.mx/TimbreFiscalDigital';
class FixtureParser {
  parseFromString(xml) {
    /* El paquete genérico '<fixture/>' de los trabajos
       automáticos trae un UUID de ruido: si trajera el del
       portal, un trabajo ajeno lo guardaría primero y la
       prueba no podría distinguir quién trajo la factura. */
    const uuid = (String(xml).match(/UUID="([^"]+)"/) || [])[1] || '62345678-1234-1234-1234-1234567890AB';
    const node = (localName, data = {}, children = [], namespaceURI = cfdi) => ({
      localName, namespaceURI, nodeType: 1, childNodes: children,
      getAttribute: name => data[name] || '',
      getElementsByTagNameNS: (namespace, name) => children.filter(child => child.namespaceURI === namespace && child.localName === name)
    });
    const documentElement = node('Comprobante', {
      Fecha: '2026-11-05T09:00:00', Total: '1160.00', Moneda: 'MXN', TipoDeComprobante: 'I'
    }, [
      /* El paquete genérico es de OTRO RFC: la inspección lo
         manda a revisión y no guarda nada — así ningún
         trabajo automático puede colar un registro en la
         cuenta de «nuevas» de la corrida. */
      node('Emisor', { Rfc: 'BBB010101BBB' }), node('Receptor', { Rfc: 'CCC010101CCC' }),
      node('Complemento', {}, [node('TimbreFiscalDigital', { UUID: uuid }, [], tfd)])
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
/* Los paquetes reales son por sentido: el de recibidos solo
   trae recibidos y el de emitidos solo emitidos (la dirección
   del registro la pone el trabajo que lo trajo). */
const cabeceraMeta = 'Uuid~RfcEmisor~NombreEmisor~RfcReceptor~NombreReceptor~FechaEmision~FechaCertificacion~PacCertifico~Monto~EfectoComprobante~Estatus~FechaCancelacion';
const metadataRecibidos = [cabeceraMeta,
  uuidPortal + '~' + emitter + '~EMISOR SA~' + rfc + '~RECEPTOR SA~2026-11-05T09:00:00~2026-11-05T09:01:00~SAT970701NN3~1160.00~I~1~'].join('\n');
const metadataEmitidos = [cabeceraMeta,
  uuidMasiva + '~' + rfc + '~RECEPTOR SA~' + emitter + '~EMISOR SA~2026-11-06T10:00:00~2026-11-06T10:01:00~SAT970701NN3~500.00~I~1~'].join('\n');
/* El XML que el portal falso entrega: un CFDI bien formado
   de verdad — la ingesta del portal parsea con el parser
   real de la bandeja, no con el del conector, y un XML de
   juguete se descarta como «no válido» (pasó: la bajada
   contaba 1 y no guardaba nada). */
const xmlDe = uuid => '<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital" Version="4.0" Serie="F" Folio="A-100" Fecha="2026-11-05T09:00:00" SubTotal="1000.00" Total="1160.00" Moneda="MXN" TipoDeComprobante="I"><cfdi:Emisor Rfc="' + emitter + '" Nombre="EMISOR SA"/><cfdi:Receptor Rfc="' + rfc + '" Nombre="RECEPTOR SA"/><cfdi:Conceptos><cfdi:Concepto Cantidad="1" ClaveProdServ="01010101" Descripcion="Prueba" ValorUnitario="1000.00" Importe="1000.00"/></cfdi:Conceptos><cfdi:Complemento><tfd:TimbreFiscalDigital Version="1.1" UUID="' + uuid + '" FechaTimbrado="2026-11-05T09:01:00" SelloCFD="AAAAAAAAAA==" SelloSAT="BBBBBBBBBB=="/></cfdi:Complemento></cfdi:Comprobante>';
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(r => setImmediate(r)); };

function makeService({ satCaido = null } = {}) {
  let time = Date.parse('2026-11-08T16:00:00Z'), counter = 0;
  const calls = [];
  const origin = 'http://127.0.0.1:43729';
  const service = createPacoSATService({
    dbFile: ':memory:', html: '<!--PACOSAT_TOKEN-->', origin, now: () => time,
    /* La sede NAS — donde el caminante y esta corrida viven —
       corre tras el proxy (modo cloud): los registros quedan en
       el servidor, que es lo que la cuenta de «nuevas» lee. */
    proxyKey: 'clave-de-prueba-30',
    makeConnector: async () => ({ parser: FixtureParser, connector: {
      request: async options => {
        calls.push(options);
        if (satCaido?.()) throw new Error('El SAT no responde (simulado).');
        return 'request-' + (++counter);
      },
      check: async id => ({ status: 'finished', packages: [id + '-pkg'] }),
      download: async packageId => {
        const requestIndex = Number(packageId.replace('request-', '').replace('-pkg', '')) - 1;
        const req = calls[requestIndex];
        if (req?.type === 'metadata')
          return archive(req.direction === 'issued' ? metadataEmitidos : metadataRecibidos, 'metadata.txt');
        return archive('<fixture/>', 'test.xml');
      }
    } }),
    satPortalFetch: async (who, { items }) => {
      const files = items.filter(item => item.direction === 'received')
        .map(item => ({ uuid: item.uuid, buffer: Buffer.from(xmlDe(item.uuid)) }));
      return { files, found: items.length, downloaded: files.length,
        quotaUsed: files.length, notes: [], complete: files.length === items.length };
    },
    makeMailer: () => ({ verify: async () => true, sendMail: async () => {} })
  });
  let token;
  async function call(path, data, options = {}) {
    const headers = { host: new URL(origin).host, origin, 'x-pacosat-token': token,
      'x-pacosat-proxy': 'clave-de-prueba-30', ...options };
    const req = Object.assign(Readable.from(data === undefined ? [] : [Buffer.from(JSON.stringify(data))]), {
      url: path, method: data === undefined ? 'GET' : 'POST', headers
    });
    let response;
    const res = { setHeader() {}, writeHead(status) { this.status = status; this.headersSent = true; },
      end(content) { response = new Response(content, { status: this.status }); } };
    await service.handle(req, res);
    return response;
  }
  return { service, call, calls,
    async setup() {
      const homeHtml = await (await call('/')).text();
      token = homeHtml.match(/name="pacosat-token" content="([0-9a-f]+)"/)?.[1];
      assert.equal((await call('/api/mail', { host: 'smtp.example.com', port: 587, from: 'from@example.com',
        recipient: 'to@example.com', user: '', password: '' })).status, 200);
      assert.equal((await call('/api/unlock', { rfc, minutes: 600, days: 7, direction: 'received', password: 'simulated',
        certificate: 'YQ==', key: 'Yg==' })).status, 200);
      assert.equal((await call('/api/monthly/config', { enabled: false, day: 5, hour: 9 })).status, 200);
      /* La tienda people sincronizada, como en la app real:
         la ingesta del portal la exige para aceptar un XML
         (sin ella, la bajada cuenta pero no guarda). */
      await call('/api/storage', { batch: { people: [
        { id: rfc, name: 'RECEPTOR SA' }, { id: emitter, name: 'EMISOR SA' } ] } });
    },
    async avanzar(min = 5) { time += min * 60000; await service.tick(); await flush(); },
    async estado() { return (await call('/api/al-dia/state?rfc=' + rfc)).json(); }
  };
}

/* — Corrida completa: metadatos → portal → masiva → veredicto — */
{
  const h = makeService();
  try {
    await h.setup();
    const antes = await h.estado();
    assert.equal(antes.veredicto.estado, 'sin-revisar',
      'Sin metadatos ingeridos el veredicto NO puede ser verde.');
    const lanzada = await h.call('/api/al-dia/run', { rfc });
    assert.equal(lanzada.status, 200);
    assert.equal((await lanzada.json()).running, true);
    const repetida = await h.call('/api/al-dia/run', { rfc });
    assert.equal(repetida.status, 409, 'Una segunda corrida simultánea se rechaza.');
    for (let i = 0; i < 14; i++) {
      await h.avanzar(5);
      const st = await h.estado();
      if (!st.running && st.fin) break;
    }
    const fin = await h.estado();
    assert.equal(fin.running, false, 'La corrida termina.');
    assert.equal(fin.fin.nuevas, 1, 'El folio del portal entra como factura nueva.');
    assert.equal(fin.fin.pendientes, 1, 'El folio que el portal no entregó queda pendiente, pedido.');
    assert.match(fin.frase, /quedan 1 pedidas al SAT/);
    const statusFin = await (await h.call('/api/status')).json();
    assert.ok(statusFin.jobs.some(j => j.kind === 'cfdi' && j.direction === 'issued' && j.status === 'finished'),
      'La vía masiva cubre lo que el portal no entregó: hay un trabajo CFDI de emitidos terminado (creado por la corrida o adoptado si ya vivía).');
    assert.equal(fin.veredicto.estado, 'faltan');
    assert.equal(fin.veredicto.pendientes, 1);
    assert.equal(fin.contadorDia.porPortal, 1, 'El contador del día sale del diario del portal.');
    /* La factura nueva entró POR EL PORTAL, no por la
       masiva: su sello de origen lo prueba (3.0 · E). */
    const guardadas = await (await h.call('/api/storage?store=invoices')).json();
    const delPortal = (Array.isArray(guardadas) ? guardadas : []).find(r => r.id === uuidPortal);
    assert.ok(delPortal && delPortal.origin === 'portal',
      'La factura nueva lleva el sello del portal: entró por el caminante.');
    assert.ok(fin.contadorDia.pedidas >= 1, 'El contador del día cuenta los trabajos de hoy.');
    const todas = await (await h.call('/api/al-dia/state')).json();
    assert.ok(todas.porRfc[rfc], 'El estado sin RFC trae todos los perfiles.');
    console.log('OK 3.0-A1: «Ponerme al día» corre metadatos → portal → masiva y cierra con la cuenta honesta (1 nueva, 1 pedida).');
  } finally { h.service.close(); }
}

/* — SAT caído: espera y se reintenta solo — */
{
  let caido = true;
  const h = makeService({ satCaido: () => caido });
  try {
    await h.setup();
    await h.call('/api/al-dia/run', { rfc });
    let st = await h.estado();
    assert.equal(st.esperandoPuerta, true, 'Con el SAT caído la corrida queda esperando, no muerta.');
    assert.match(st.frase, /sigo intentando solo/);
    caido = false;
    for (let i = 0; i < 6; i++) {
      await h.avanzar(6);
      st = await h.estado();
      if (!st.esperandoPuerta && st.fase !== 'esperando') break;
    }
    assert.equal(st.esperandoPuerta, false, 'Al volver el SAT, la corrida se reintenta sola.');
    assert.ok(h.calls.some(c => c.type === 'metadata'), 'El reintento pide los metadatos.');
    console.log('OK 3.0-A2: con el SAT caído la corrida espera y se reintenta sola al volver la puerta.');
  } finally { h.service.close(); }
}

/* — Detener: cierra con su frase honesta — */
{
  const h = makeService();
  try {
    await h.setup();
    await h.call('/api/al-dia/run', { rfc });
    await h.call('/api/al-dia/cancel', { rfc });
    await h.avanzar(5);
    const st = await h.estado();
    assert.equal(st.running, false);
    assert.match(st.frase, /Detenido/);
    console.log('OK 3.0-A3: Detener cierra la corrida con su cuenta y su frase.');
  } finally { h.service.close(); }
}
