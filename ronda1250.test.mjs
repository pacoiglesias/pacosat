/* Ronda 1.25.0 — «Las 20 de Paco», juzgada punto por punto:
   - 9 (AGREGAR): push PWA — el cifrado RFC 8291 se verifica
     cruzado (lo cifrado se descifra), la suscripción vive en el
     servidor y el aviso de prueba viaja GENÉRICO, sin datos
     fiscales; sin suscripción, la prueba dice la verdad;
   - 1 (MEJORAR) + 8 (AGREGAR): declaraciones por folios — el
     registro nace, se valida, se borra y la vista trae folios y
     el resumen por años; reimprimir un folio que no consta es
     un 404 honesto;
   - 2 (MEJORAR): avisos agrupados por causa raíz — dos saldos
     de la misma contraparte salen como UN grupo con su total;
   - 7 (AGREGAR): doble cobro — dos recibidas del mismo
     proveedor, importe y concepto a días: un aviso con los dos;
   - 5 (MEJORAR): Dinero explica cada saldo — cada saldo vivo
     trae su línea «qué falta»;
   - 4 (AGREGAR): previsión del mes — recurrencias con su base
     escrita y totales que cuadran;
   - 1 (AGREGAR): calendario .ics — VCALENDAR con alarmas y SIN
     importes;
   - 6 (MEJORAR): cierre «generar todo» — los tres artefactos
     en una llamada y los pasos pre-marcados al volver;
   - 5 (AGREGAR): recordatorios de cobro — el borrador NO envía
     nada; el envío solo ocurre con la ruta de enviar y deja el
     correo en el buzón de juguete;
   - 6 (AGREGAR): expediente legal por contraparte — un ZIP de
     verdad en un clic;
   - 2 (AGREGAR): puente a Paperless — configurado con el token
     de Paco, la constancia subida se copia con sus etiquetas y
     el token jamás vuelve en una lectura;
   - 3 (AGREGAR): Vista Nora — la marca «contadora» se guarda,
     la sesión invitada se reconoce y su lista del mes se lee;
   - 9 (MEJORAR): «mientras no estabas» — el resumen responde
     con su ventana y la marca de visto solo avanza;
   - 4 (MEJORAR): la corrida CIEC en espera se reanuda con una
     bajada de RANGO AMPLIO que cubre el mes, sin perder su
     sitio (harness de la 1.15.0);
   - 8 (MEJORAR): salud predictiva — la sonda detecta el cambio
     de pantalla y la corrida mensual nace avisada;
   - 10 (AGREGAR): materialidad automática — la contraparte cae
     en 69-B Definitivo con CFDI de Paco: nace el aviso con su
     expediente, una sola vez;
   - visual: el artefacto trae los tokens cerrados (--accent de
     raíz, insignia con var(--danger)), las clases fantasma
     definidas y los textos de las pantallas nuevas; el sw.js
     atiende push y notificationclick. */
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DOMParser } from '@xmldom/xmldom';
import { generateKeyPairSync } from 'node:crypto';
import { createPacoSATService } from './local-server.mjs';
import { parseXml, parseCfdiFull, fiscalSummary, crc32 } from './xml-core.mjs';
import { generateVapidKeys, vapidAuthorization, encryptPushPayload, decryptPushPayloadForTest } from './push.mjs';

const ORIGIN = 'https://pacosat.test';
const KEY = 'f'.repeat(64);
const OWN = 'AAA010101AAA';
const BBB = 'BBB010101BB1';
const PDF = Buffer.from('%PDF-1.4\n%documento de prueba\n');
const b64u = buffer => Buffer.from(buffer).toString('base64url');

function makeHarness(options = {}) {
  const clock = { t: Date.parse('2026-11-11T15:00:00Z') };
  const mails = [];
  const service = createPacoSATService({
    dbFile: ':memory:', html: '<html><head><!--PACOSAT_TOKEN--></head><body>prueba</body></html>',
    origin: ORIGIN, proxyKey: KEY, satDocRetryWaitMs: 5,
    makeConnector: () => ({ parser: DOMParser, connector: {
      request: async () => 'req-b', check: async () => ({ status: 'pending', packages: [] }),
      download: async () => { throw new Error('sin paquetes'); } } }),
    makeMailer: () => ({ verify: async () => true,
      sendMail: async mail => { mails.push(mail); return { messageId: 'm' + mails.length }; } }),
    now: () => clock.t, ...options });
  let token = '';
  const raw = async (method, path, body, extraHeaders = {}) => {
    const chunks = []; if (body !== undefined) chunks.push(Buffer.from(JSON.stringify(body)));
    const req = Readable.from(chunks);
    req.method = method; req.url = path;
    req.headers = { host: 'pacosat.test', origin: ORIGIN, 'x-pacosat-proxy': KEY, ...extraHeaders };
    let status = 0; const headers = {}; let text = '';
    const res = { writeHead(code, hdrs) { status = code; if (hdrs) Object.assign(headers, hdrs); },
      setHeader(k, v) { headers[k] = v; }, getHeader(k) { return headers[k]; },
      end(chunk) { if (chunk) text += Buffer.isBuffer(chunk) ? chunk.toString('latin1') : chunk; } };
    await service.handle(req, res);
    return { status, text, headers };
  };
  const call = async (method, path, body, extraHeaders = {}) => {
    if (!token) { const home = await raw('GET', '/'); token = /[0-9a-f]{64}/.exec(home.text)?.[0] || ''; }
    const r = await raw(method, path, body, { 'x-pacosat-token': token, ...extraHeaders });
    let json = null; try { json = JSON.parse(r.text); } catch { /* binario */ }
    return { status: r.status, json, text: r.text, headers: r.headers };
  };
  return { service, call, mails, clock };
}
const xmlCfdi = ({ uuid, fecha, emisor, receptor, total, concepto = 'Servicio' }) => {
  const sub = (Number(total) / 1.16).toFixed(2);
  const tax = (Number(total) - Number(sub)).toFixed(2);
  return `<?xml version="1.0" encoding="UTF-8"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital" Version="4.0" Fecha="${fecha}" SubTotal="${sub}" Moneda="MXN" Total="${total}" TipoDeComprobante="I" MetodoPago="PPD" FormaPago="99" LugarExpedicion="72000">
<cfdi:Emisor Rfc="${emisor}" Nombre="EMISOR SA" RegimenFiscal="601"/>
<cfdi:Receptor Rfc="${receptor}" Nombre="RECEPTOR SA" DomicilioFiscalReceptor="72000" RegimenFiscalReceptor="601" UsoCFDI="G03"/>
<cfdi:Conceptos><cfdi:Concepto ClaveProdServ="01010101" Cantidad="1" ClaveUnidad="H87" Descripcion="${concepto}" ValorUnitario="${sub}" Importe="${sub}" ObjetoImp="02"><cfdi:Impuestos><cfdi:Traslados><cfdi:Traslado Base="${sub}" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="${tax}"/></cfdi:Traslados></cfdi:Impuestos></cfdi:Concepto></cfdi:Conceptos>
<cfdi:Impuestos TotalImpuestosTrasladados="${tax}"><cfdi:Traslados><cfdi:Traslado Base="${sub}" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="${tax}"/></cfdi:Traslados></cfdi:Impuestos>
<cfdi:Complemento><tfd:TimbreFiscalDigital Version="1.1" UUID="${uuid}" FechaTimbrado="${fecha}" RfcProvCertif="SAT970701NN3" SelloCFD="AAAA" NoCertificadoSAT="00001000000500000001" SelloSAT="BBBB"/></cfdi:Complemento>
</cfdi:Comprobante>`;
};
const seedInvoices = async (h, specs) => {
  const xmls = specs.map(spec => xmlCfdi(spec));
  /* Como la ingesta real (importXmlShared): registro ligero +
     desglose fiscal — sin él no hay método de pago ni saldos.
     (withFiscal no sirve aquí: llama a parseCfdiFull sin parser
     y en Node no hay DOMParser global; el servidor sí lo pasa.) */
  const rows = xmls.map(xml => {
    const buffer = Buffer.from(xml);
    const row = parseXml(buffer, DOMParser);
    row.fiscal = fiscalSummary(parseCfdiFull(buffer, DOMParser));
    return row;
  });
  const seed = await h.call('POST', '/api/storage', { batch: {
    people: [{ id: OWN, name: 'EMPRESA PROPIA SA' }, { id: BBB, name: 'PROVEEDOR SA' }],
    invoices: rows,
    files: xmls.map((xml, i) => ({ id: 'xml:' + rows[i].id, mime: 'application/xml',
      content: Buffer.from(xml).toString('base64') })) } });
  assert.equal(seed.status, 200);
  return rows;
};
const U = n => '12500000-0000-4000-8000-' + String(n).padStart(12, '0');

/* ===== 9 · Push PWA: cifrado cruzado y aviso genérico ===== */
{
  /* La criptografía se prueba contra sí misma: lo que el
     servidor cifra para una suscripción, solo su dueño lo abre. */
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pub = publicKey.export({ format: 'jwk' });
  const priv = privateKey.export({ format: 'jwk' });
  const p256dh = b64u(Buffer.concat([Buffer.from([4]), Buffer.from(pub.x, 'base64url'), Buffer.from(pub.y, 'base64url')]));
  const auth = b64u(Buffer.from('secreto-auth-16b'));
  const cuerpo = Buffer.from(JSON.stringify({ title: 'PacoSAT · Aviso crítico', body: 'genérico' }));
  const cifrado = encryptPushPayload({ endpoint: 'https://push.test/x', keys: { p256dh, auth } }, cuerpo);
  const abierto = decryptPushPayloadForTest(cifrado, priv.d, auth);
  assert.equal(abierto.toString(), cuerpo.toString(), 'el cifrado RFC 8291 se descifra con la clave del suscriptor');
  const vapid = generateVapidKeys();
  const cabecera = vapidAuthorization('https://push.test/x', vapid, 'mailto:paco@test.mx');
  assert.match(cabecera, /^vapid t=[^,]+, k=/, 'la cabecera VAPID lleva el JWT y la clave');

  const enviados = [];
  const h = makeHarness({ makePushSender: async (subscription, payload) => {
    enviados.push({ endpoint: subscription.endpoint, payload }); return { status: 201 }; } });
  const sinSub = await h.call('POST', '/api/push/test', {});
  assert.equal(sinSub.status, 422, 'sin suscripción, la prueba dice la verdad');
  /* Desde la 1.27.0 (B2 de la pasada de seguridad de la 1.25)
     la suscripción solo acepta endpoints de los servicios de
     push reales: el endpoint de juguete pasa a ser el de FCM,
     que es el que un navegador de verdad entregaría. */
  const sub = await h.call('POST', '/api/push/subscribe',
    { endpoint: 'https://fcm.googleapis.com/fcm/send/push-test-x', keys: { p256dh, auth } });
  assert.equal(sub.status, 200);
  const mala = await h.call('POST', '/api/push/subscribe',
    { endpoint: 'http://inseguro.test/x', keys: { p256dh, auth } });
  assert.equal(mala.status, 400, 'un endpoint sin https se rechaza');
  const prueba = await h.call('POST', '/api/push/test', {});
  assert.equal(prueba.status, 200);
  assert.equal(prueba.json.sent, 1);
  assert.equal(enviados.length, 1);
  const plano = typeof enviados[0].payload === 'string'
    ? JSON.parse(enviados[0].payload) : enviados[0].payload;
  assert.match(plano.title, /Aviso crítico/);
  assert.ok(!/AAA010101|BBB010101|\$/.test(JSON.stringify(plano)), 'el push NO lleva datos fiscales');
  const fuera = await h.call('POST', '/api/push/unsubscribe', { endpoint: 'https://fcm.googleapis.com/fcm/send/push-test-x' });
  assert.equal(fuera.status, 200);
  const sw = await h.call('GET', '/sw.js');
  assert.match(sw.text, /addEventListener\('push'/, 'el service worker atiende los push');
  assert.match(sw.text, /notificationclick/, 'y el toque abre la app');
  h.service.close();
  console.log('OK 1.25.0 · push: cifrado cruzado, suscripción y aviso genérico sin datos fiscales');
}

/* ===== 1 + 8 · Declaraciones por folios y por años ===== */
{
  const h = makeHarness();
  const open = await h.call('POST', '/api/unlock', { rfc: OWN, minutes: 1440, days: 7,
    direction: 'both', password: 'simulated', certificate: 'YQ==', key: 'Yg==' });
  assert.equal(open.status, 200);
  const malo = await h.call('POST', '/api/declaraciones/folios',
    { rfc: OWN, tipo: 'mensual', ejercicio: 2026, periodo: '2026-10', folio: '123' });
  assert.equal(malo.status, 400, 'un folio corto se rechaza');
  const bueno = await h.call('POST', '/api/declaraciones/folios',
    { rfc: OWN, tipo: 'mensual', ejercicio: 2026, periodo: '2026-10', folio: '2026012345678', estado: 'pendiente' });
  assert.equal(bueno.status, 200);
  assert.equal(bueno.json.folio.folio, '2026012345678');
  const vista = (await h.call('GET', '/api/declaraciones?rfc=' + OWN + '&ejercicio=2026')).json;
  assert.ok(vista.folios.some(f => f.folio === '2026012345678' && f.estado === 'pendiente'),
    'la vista trae el folio apuntado');
  assert.ok(Array.isArray(vista.anios), 'la vista trae el resumen por años');
  const noExiste = await h.call('POST', '/api/declaraciones/folio-run', { rfc: OWN, folioId: 99999 });
  assert.equal(noExiste.status, 404, 'reimprimir un folio que no consta: 404 honesto');
  const borrado = await h.call('POST', '/api/declaraciones/folios/delete', { rfc: OWN, id: bueno.json.folio.id });
  assert.equal(borrado.status, 200);
  const vista2 = (await h.call('GET', '/api/declaraciones?rfc=' + OWN + '&ejercicio=2026')).json;
  assert.ok(!vista2.folios.some(f => f.folio === '2026012345678'), 'el folio borrado ya no consta');
  h.service.close();
  console.log('OK 1.25.0 · declaraciones: registro de folios con validación y resumen por años');
}

/* ===== 2 + 7 · Avisos agrupados y doble cobro ===== */
{
  const h = makeHarness();
  const open = await h.call('POST', '/api/unlock', { rfc: OWN, minutes: 1440, days: 7,
    direction: 'both', password: 'simulated', certificate: 'YQ==', key: 'Yg==' });
  assert.equal(open.status, 200);
  await seedInvoices(h, [
    /* Dos por cobrar a la misma contraparte: misma causa raíz. */
    { uuid: U(1), fecha: '2026-09-05T10:00:00', emisor: OWN, receptor: BBB, total: '1160.00' },
    { uuid: U(2), fecha: '2026-09-01T10:00:00', emisor: OWN, receptor: BBB, total: '2320.00' },
    /* Dos recibidas gemelas a 5 días: sospecha de doble cobro. */
    { uuid: U(3), fecha: '2026-11-02T10:00:00', emisor: BBB, receptor: OWN, total: '580.00', concepto: 'Renta de equipo' },
    { uuid: U(4), fecha: '2026-11-07T10:00:00', emisor: BBB, receptor: OWN, total: '580.00', concepto: 'Renta de equipo' }
  ]);
  const notices = (await h.call('GET', '/api/notices')).json;
  const grupo = (notices.grupos || []).find(g => g.cuenta >= 2 && g.contraparte === BBB);
  assert.ok(grupo, 'los saldos por cobrar de BBB salen agrupados: ' + JSON.stringify(notices.grupos) +
    ' · avisos: ' + JSON.stringify((notices.avisos || []).map(a => [a.kind, a.contraparte, a.importe, a.estado])));
  assert.equal(grupo.importeTotal, '3480.00', 'el grupo suma los dos saldos');
  const miembros = notices.avisos.filter(a => a.grupo === grupo.clave);
  assert.equal(miembros.length, 2, 'cada aviso sabe su grupo sin dejar de existir');
  const doble = notices.avisos.find(a => a.kind === 'doble-cobro');
  assert.ok(doble, 'el doble cobro nace como aviso');
  assert.match(doble.detalle, /580/, 'el aviso del doble cobro dice el importe');
  h.service.close();
  console.log('OK 1.25.0 · avisos: grupo por causa raíz con su total y vigilancia de doble cobro');
}

/* ===== 5 · Dinero explica + 4 · Previsión + 1 · Calendario ===== */
{
  const h = makeHarness();
  const open = await h.call('POST', '/api/unlock', { rfc: OWN, minutes: 1440, days: 7,
    direction: 'both', password: 'simulated', certificate: 'YQ==', key: 'Yg==' });
  assert.equal(open.status, 200);
  await seedInvoices(h, [
    { uuid: U(11), fecha: '2026-08-10T10:00:00', emisor: OWN, receptor: BBB, total: '1160.00' },
    { uuid: U(12), fecha: '2026-09-10T10:00:00', emisor: OWN, receptor: BBB, total: '1160.00' },
    { uuid: U(13), fecha: '2026-10-10T10:00:00', emisor: OWN, receptor: BBB, total: '1160.00' },
    { uuid: U(14), fecha: '2026-11-03T10:00:00', emisor: BBB, receptor: OWN, total: '580.00' }
  ]);
  const money = (await h.call('GET', '/api/money')).json;
  assert.ok(money.balances.length >= 3, 'hay saldos vivos');
  for (const balance of money.balances)
    assert.ok(typeof balance.falta === 'string' && balance.falta.length > 10,
      'cada saldo explica qué falta: ' + JSON.stringify(balance));
  const porCobrar = money.balances.find(b => b.balance === '1160.00');
  assert.match(porCobrar.falta, /Falta por cobrar/, 'la línea dice el sentido y el importe');
  const forecast = (await h.call('GET', '/api/forecast?month=2026-11')).json;
  const recurrencia = (forecast.entradas || []).find(l => /^Cobro recurrente/.test(l.concepto || ''));
  assert.ok(recurrencia, 'la recurrencia de BBB entra en la previsión: ' + JSON.stringify(forecast));
  assert.match(recurrencia.base, /Patrón de tus CFDI/, 'la línea escribe su base');
  assert.equal(recurrencia.importe, '1160.00', 'el importe típico es la mediana de la serie');
  const suma = lista => lista.reduce((acc, l) => acc + Number(l.importe), 0);
  assert.equal(Number(forecast.totalEntradas), suma(forecast.entradas), 'el total de entradas cuadra');
  assert.equal(Number(forecast.totalSalidas), suma(forecast.salidas), 'el total de salidas cuadra');
  const ics = await h.call('GET', '/api/fiscal/calendar.ics');
  assert.equal(ics.status, 200);
  assert.match(ics.headers['Content-Type'] || '', /text\/calendar/);
  assert.match(ics.text, /BEGIN:VCALENDAR/);
  assert.match(ics.text, /BEGIN:VALARM/, 'cada obligación lleva su alarma');
  assert.ok(!ics.text.includes('$'), 'el calendario NO lleva importes');
  h.service.close();
  console.log('OK 1.25.0 · dinero: cada saldo explicado, previsión con bases y calendario sin importes');
}

/* ===== 6 · Cierre «generar todo» + 5 · Recordatorios + 6 · Expediente ===== */
{
  const h = makeHarness();
  const open = await h.call('POST', '/api/unlock', { rfc: OWN, minutes: 1440, days: 7,
    direction: 'both', password: 'simulated', certificate: 'YQ==', key: 'Yg==' });
  assert.equal(open.status, 200);
  /* BBB paga el día 10: la factura del 5 de octubre ya venció. */
  await h.call('POST', '/api/mail', { host: 'smtp.test', port: 587, user: 'u', password: 'p',
    from: 'avisos@pacosat.test', recipient: 'paco@test.mx' });
  await h.call('POST', '/api/lists/counterparts',
    { rfc: BBB, name: 'PROVEEDOR SA', kind: 'Cliente', payDay: 10 });
  await seedInvoices(h, [
    { uuid: U(21), fecha: '2026-10-05T10:00:00', emisor: OWN, receptor: BBB, total: '1160.00' },
    { uuid: U(22), fecha: '2026-10-06T10:00:00', emisor: BBB, receptor: OWN, total: '580.00' }
  ]);
  const todo = await h.call('POST', '/api/reports/generate-all', { rfc: OWN, month: '2026-10' });
  assert.equal(todo.status, 200, JSON.stringify(todo.json));
  assert.equal(todo.json.pasos.length, 3, 'tres artefactos en un gesto');
  for (const paso of todo.json.pasos) {
    assert.ok(paso.ok, 'el paso ' + paso.id + ' salió: ' + (paso.error || ''));
    assert.ok(paso.content && paso.name, 'cada paso trae su descarga');
  }
  const estado = (await h.call('GET', '/api/reports/close-state?rfc=' + OWN + '&month=2026-10')).json;
  assert.ok(estado.cierre && ['paquete', 'reporte', 'zip'].every(id =>
    estado.cierre.pasos.some(paso => paso.id === id && paso.ok)),
    'al volver, los tres pasos constan pre-marcados');

  const notices = (await h.call('GET', '/api/notices')).json;
  const saldo = notices.avisos.find(a => a.kind === 'saldo' && a.direccion === 'cobrar');
  assert.ok(saldo, 'hay un aviso de saldo por cobrar');
  const borrador = await h.call('POST', '/api/reminders/draft', { ref: saldo.ref });
  assert.equal(borrador.status, 200, JSON.stringify(borrador.json));
  assert.equal(borrador.json.reminder.estado, 'borrador');
  assert.equal(h.mails.length, 0, 'el borrador NO envía nada: cero correos');
  const enviado = await h.call('POST', '/api/reminders/send',
    { id: borrador.json.reminder.id, to: 'cliente@test.mx' });
  assert.equal(enviado.status, 200, JSON.stringify(enviado.json));
  assert.equal(h.mails.length, 1, 'solo el toque de enviar manda el correo');
  assert.match(h.mails[0].subject, /Recordatorio de pago/);
  const lista = (await h.call('GET', '/api/reminders')).json;
  assert.equal(lista.reminders.find(r => r.id === borrador.json.reminder.id).estado, 'enviado');

  const expediente = await h.call('POST', '/api/salidas/expediente', { rfc: OWN, contraparte: BBB });
  assert.equal(expediente.status, 200);
  const zip = Buffer.from(expediente.json.content, 'base64');
  assert.equal(zip.subarray(0, 2).toString(), 'PK', 'el expediente es un ZIP de verdad');
  assert.match(expediente.json.name, /^expediente-BBB010101BB1-AAA010101AAA\.zip$/,
    'el nombre dice contraparte y RFC');
  h.service.close();
  console.log('OK 1.25.0 · cierre en un gesto, recordatorio solo con el sí y expediente ZIP en un clic');
}

/* ===== 2 · Paperless + 3 · Vista Nora + 9 · Mientras no estabas ===== */
{
  const subidas = [];
  const h = makeHarness({ makePaperlessUploader: async doc => { subidas.push(doc); } });
  const open = await h.call('POST', '/api/unlock', { rfc: OWN, minutes: 1440, days: 7,
    direction: 'both', password: 'simulated', certificate: 'YQ==', key: 'Yg==' });
  assert.equal(open.status, 200);
  const antes = (await h.call('GET', '/api/paperless')).json;
  assert.equal(antes.enabled, false, 'el puente nace apagado: la activación es de Paco');
  const cfg = await h.call('POST', '/api/paperless/config',
    { enabled: true, baseUrl: 'http://paperless.test:8000', token: 'token-de-paco-123' });
  assert.equal(cfg.status, 200);
  const despues = (await h.call('GET', '/api/paperless')).json;
  assert.equal(despues.enabled, true);
  assert.equal(despues.tokenSet, true);
  assert.ok(!JSON.stringify(despues).includes('token-de-paco-123'), 'el token NUNCA vuelve en una lectura');
  const up = await h.call('POST', '/api/satdocs/upload', { rfc: OWN, kind: 'constancia',
    date: '2026-11-02', content: PDF.toString('base64') });
  assert.equal(up.status, 200, JSON.stringify(up.json));
  assert.ok(subidas.some(d => String(d.title || '').includes(OWN) && (d.tags || []).includes('PacoSAT')),
    'la constancia archivada se copió a Paperless con sus etiquetas: ' + JSON.stringify(subidas));
  const cola = (await h.call('GET', '/api/paperless')).json;
  assert.ok((cola.cola?.subido || 0) >= 1, 'la cola cuenta la copia hecha');

  const guestCfg = await h.call('POST', '/api/guest/config',
    { password: 'clave-invitado-1', enabled: true, contadora: true });
  assert.equal(guestCfg.json.contadora, true, 'la marca de la contadora se guarda');
  const login = await h.call('POST', '/api/guest/login', { password: 'clave-invitado-1' });
  assert.ok(login.json.token, 'la invitada entra');
  const sesion = await h.call('GET', '/api/guest/config', undefined,
    { 'x-pacosat-token': login.json.token });
  assert.equal(sesion.json.sesionContadora, true, 'su sesión se reconoce como la de la contadora');
  const listaNora = await h.call('GET', '/api/reports/checklist?month=2026-11', undefined,
    { 'x-pacosat-token': login.json.token });
  assert.equal(listaNora.status, 200, 'la contadora lee su lista del mes');
  assert.ok(Array.isArray(listaNora.json.items), 'la lista trae sus pasos');

  const digest = (await h.call('GET', '/api/activity/digest')).json;
  assert.ok(digest && typeof digest.eventos === 'number' && digest.desde > 0,
    'el resumen «mientras no estabas» responde con su ventana');
  const visto = await h.call('POST', '/api/activity/seen', {});
  assert.equal(visto.status, 200);
  const digest2 = (await h.call('GET', '/api/activity/digest')).json;
  assert.ok(digest2.desde >= digest.desde, 'la marca de visto solo avanza');
  h.service.close();
  console.log('OK 1.25.0 · paperless con activación de Paco, Vista Nora reconocida y digest al entrar');
}

/* ===== 4 · La corrida CIEC se reanuda con un rango amplio ===== */
/* Parser de juguete fiel a parseXml (el de la ronda 1.15.0). */
class FixtureParser {
  parseFromString(xml) {
    const cfdi = 'http://www.sat.gob.mx/cfd/4';
    const node = (localName, attributes = {}, children = [], namespaceURI = cfdi) => ({
      nodeType: 1, localName, namespaceURI, childNodes: children,
      get children() { return children; },
      getAttribute: name => attributes[name] ?? null,
      getElementsByTagNameNS: (ns, name) => children.filter(item => item.namespaceURI === ns && item.localName === name)
    });
    const attr = (tag, name) => (xml.match(new RegExp('<' + tag + '\\b[^>]*\\b' + name + '="([^"]*)"')) || [])[1] || '';
    const stamp = node('TimbreFiscalDigital', { UUID: attr('tfd:TimbreFiscalDigital', 'UUID') }, [],
      'http://www.sat.gob.mx/TimbreFiscalDigital');
    const root = node('Comprobante',
      { Fecha: attr('cfdi:Comprobante', 'Fecha'), Total: attr('cfdi:Comprobante', 'Total'),
        Moneda: 'MXN', TipoDeComprobante: 'I' },
      [node('Emisor', { Rfc: attr('cfdi:Emisor', 'Rfc'), Nombre: 'EMISOR DE JUGUETE' }),
       node('Receptor', { Rfc: attr('cfdi:Receptor', 'Rfc'), Nombre: 'RECEPTOR DE JUGUETE' }),
       node('Complemento', {}, [stamp])]);
    return { documentElement: root, getElementsByTagName: () => [] };
  }
}
{
  const CIEC_RFC = 'CCC010101CC1';
  const EMISOR = 'AAA010101AAA';
  const dir = mkdtempSync(join(tmpdir(), 'pacosat-1250-ciec-'));
  const xmlReal = xmlCfdi({ uuid: U(31), fecha: '2026-11-12T10:00:00', emisor: EMISOR, receptor: CIEC_RFC, total: '116.00' });
  const h = makeHarness({ efirmaDir: dir,
    makeConnector: () => ({ parser: FixtureParser, connector: {
      request: async () => 'req-x', check: async () => ({ status: 'pending', packages: [] }),
      download: async () => { throw new Error('sin paquetes'); } } }),
    satCiecFetch: async () => ({ files: [{ name: 'ciec.xml', buffer: Buffer.from(xmlReal) }],
      found: 1, downloaded: 1, complete: true, notes: [] }) });
  await h.call('POST', '/api/mail', { host: 'smtp.test', port: 465, security: 'ssl',
    from: 'avisos@pacosat.test', recipient: 'paco@test.mx', user: 'u', password: 'p' });
  const seed = await h.call('POST', '/api/storage', { batch: {
    people: [{ id: CIEC_RFC, name: 'CLIENTE CIEC' }, { id: EMISOR, name: 'EMISOR DE JUGUETE' }] } });
  assert.equal(seed.status, 200);
  const ciec = await h.call('POST', '/api/ciec', { rfc: CIEC_RFC, minutes: 360, days: 7,
    direction: 'both', ciec: 'secreto-de-paco' });
  assert.equal(ciec.status, 200, JSON.stringify(ciec.json));
  /* Día 5: la corrida nace y la parte CIEC espera el gesto. */
  h.clock.t = Date.parse('2026-12-05T15:00:00Z');
  await h.service.tick();
  let overview = (await h.call('GET', '/api/monthly')).json;
  assert.equal(overview.runs[0].perRfc[CIEC_RFC].status, 'esperando-gesto',
    'la parte CIEC nace esperando el gesto');
  /* El gesto baja un RANGO AMPLIO (15 oct → 15 dic) que cubre
     noviembre: hasta la 1.24.0 la entrada solo se cerraba con el
     mes exacto y la corrida quedaba colgada para siempre. */
  const run = await h.call('POST', '/api/ciec/run', { rfc: CIEC_RFC,
    start: '2026-10-15', end: '2026-12-15', direction: 'received' });
  assert.equal(run.status, 200, JSON.stringify(run.json));
  for (let i = 0; i < 40; i++) { overview = (await h.call('GET', '/api/monthly')).json;
    if (overview.runs[0].perRfc[CIEC_RFC].status === 'hecha') break;
    await new Promise(resolve => setTimeout(resolve, 50)); }
  const entry = overview.runs[0].perRfc[CIEC_RFC];
  assert.equal(entry.status, 'hecha', 'la bajada amplia cierra la entrada en su sitio');
  assert.equal(entry.rangoAmplio, true, 'la entrada declara que vino de un rango amplio');
  assert.equal(entry.found, 1, 'lo encontrado sale de los registros del mes, no de la descarga');
  assert.equal(overview.runs[0].status, 'hecha', 'la corrida queda completa');
  h.service.close();
  rmSync(dir, { recursive: true, force: true });
  console.log('OK 1.25.0 · CIEC: la corrida en espera se reanuda con una bajada de rango amplio');
}

/* ===== 8 · Salud predictiva: la corrida nace avisada ===== */
{
  let pagina = '<html><head><title>Acceso SAT</title></head><body>' +
    '<form action="/login"><div id="campo-a"></div></form></body></html>';
  const h = makeHarness({ portalProbeFetch: async () => pagina });
  const unlock = async () => {
    const open = await h.call('POST', '/api/unlock', { rfc: OWN, minutes: 1440, days: 7,
      direction: 'both', password: 'simulated', certificate: 'YQ==', key: 'Yg==' });
    assert.equal(open.status, 200);
  };
  await unlock();
  /* Día 4: la sonda guarda la huella conocida, sin aviso. */
  h.clock.t = Date.parse('2026-12-04T15:00:00Z');
  await h.service.tick();
  let status = (await h.call('GET', '/api/status')).json;
  assert.equal(status.portalSalud.constancia.cambio, false, 'con la pantalla de siempre no hay cambio');
  /* El portal cambia su pantalla de acceso. */
  pagina = '<html><head><title>Acceso SAT</title></head><body>' +
    '<form action="/entrar"><div id="campo-nuevo"></div></form></body></html>';
  /* Día 5: la sonda lo detecta y la corrida de noviembre nace
     avisada — ANTES de que ninguna descarga se estrelle. */
  await unlock();
  h.clock.t = Date.parse('2026-12-05T15:00:00Z');
  await h.service.tick();
  status = (await h.call('GET', '/api/status')).json;
  assert.equal(status.portalSalud.constancia.cambio, true, 'la sonda marca el cambio');
  const notices = (await h.call('GET', '/api/notices')).json;
  assert.ok(notices.avisos.some(a => /portal del SAT cambió/.test(a.titulo)),
    'el aviso de cambio de portal existe antes de la corrida');
  const monthly = (await h.call('GET', '/api/monthly')).json;
  assert.ok(monthly.runs.length >= 1, 'la corrida mensual nació');
  assert.match(monthly.runs[0].avisoPortal || '', /constancia/, 'la corrida nace avisada del cambio');
  assert.ok(monthly.portal, 'el Centro SAT expone la salud del portal');
  h.service.close();
  console.log('OK 1.25.0 · predictiva: el cambio de portal se sabe antes y la corrida nace avisada');
}

/* ===== 10 · Materialidad automática al caer en 69-B ===== */
{
  const fixtures = {
    '69b': 'Información actualizada al 09 de octubre de 2026\r\nNo.,RFC,Nombre del Contribuyente,Situación del contribuyente\r\n' +
      '1,' + BBB + ',PROVEEDOR SA,Definitivo\r\n',
    '69b-bis': 'Información actualizada al 09 de octubre de 2026\r\nNo.,RFC,Nombre del Contribuyente,Situación del contribuyente\r\n'
  };
  const generic = () => 'RFC,RAZON SOCIAL,SUPUESTO,FECHA\r\nXXX010101XXX,OTRA SA,X,01/01/2025\r\n';
  const h = makeHarness({ listFetch: async source => fixtures[source.id] || generic() });
  const open = await h.call('POST', '/api/unlock', { rfc: OWN, minutes: 1440, days: 7,
    direction: 'both', password: 'simulated', certificate: 'YQ==', key: 'Yg==' });
  assert.equal(open.status, 200);
  await seedInvoices(h, [
    { uuid: U(41), fecha: '2026-10-05T10:00:00', emisor: BBB, receptor: OWN, total: '1160.00' }
  ]);
  await h.call('POST', '/api/lists/refresh', {});
  for (let i = 0; i < 120; i++) {
    const progress = (await h.call('GET', '/api/lists/progress')).json;
    if (!progress.running) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  const notices = (await h.call('GET', '/api/notices')).json;
  const materialidad = notices.avisos.filter(a => a.kind === 'materialidad');
  assert.equal(materialidad.length, 1, 'nace UN aviso de materialidad: ' +
    JSON.stringify(notices.avisos.map(a => a.kind)));
  assert.ok(materialidad[0].fileId, 'el aviso lleva el expediente a un clic');
  assert.match(materialidad[0].titulo, /69-B Definitivo/);
  const otra = (await h.call('GET', '/api/notices')).json;
  assert.equal(otra.avisos.filter(a => a.kind === 'materialidad').length, 1,
    'sin cambios en la situación, el expediente no se regenera');
  h.service.close();
  console.log('OK 1.25.0 · materialidad: expediente automático y aviso único al caer en 69-B Definitivo');
}

/* ===== El artefacto: tokens, clases y pantallas nuevas ===== */
{
  const html = readFileSync(join(process.cwd(), 'Faro-Fiscal.html'), 'utf8');
  /* Anexo 1.26.0: el sello sube con la Ronda Visual, como en
     cada ronda (el pin de la 1.17.0 en ronda1170 y este se
     mueven con la versión vigente). */
  assert.ok(html.includes('"version":"1.29.0"'), 'el artefacto se sella con la versión vigente (1.29.0)');
  assert.ok(html.includes('--accent:var(--green)'), '--accent es token de raíz');
  assert.ok(!html.includes('#2563eb'), 'el azul de emergencia desapareció');
  assert.ok(!html.includes('#d9534f'), 'la insignia ya no lleva el rojo crudo');
  assert.ok(html.includes('.soft{'), '.soft está definida por fin');
  assert.ok(html.includes('.clickable{'), '.clickable está definida por fin');
  assert.ok(html.includes('.inline-form{'), '.inline-form está definida por fin');
  for (const texto of ['Mientras no estabas', 'Marcar como visto', 'Generar todo el cierre',
    'Reimprimir el acuse', 'Recuperar el año completo', 'Recordatorio de cobro',
    'Puente a Paperless', 'Avisos push en este dispositivo', 'Vista de la contadora',
    'Expediente legal', 'Previsión del mes', 'Añadir a Google Calendar',
    'Descargar el calendario (.ics)', 'Abrir el comprobante', 'protagonista'])
    assert.ok(html.includes(texto), 'el artefacto trae «' + texto + '»');
  console.log('OK 1.25.0 · artefacto: tokens cerrados, clases definidas y pantallas nuevas presentes');
}
console.log('OK ronda1250 — las 20 de Paco, fijadas');
