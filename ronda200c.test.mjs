/* ================================================================
   Ronda 2.0 · Tanda 3 — Correos: plantilla madre HTML (A1),
   enlaces profundos (M3), documento del SAT con sentido y
   vigencia (M6), un correo de novedades por RFC y día (O8),
   correo de prueba con la plantilla real (6.5), resumen de
   viernes (A5), pantalla «Correos y avisos» (E10) y notas de
   la API con alcance propio (M10).

   (a) composeNewsMail produce html+text con los mismos
       comprobantes y el mismo total, y el HTML contiene el
       botón con el enlace profundo correcto con URL.
   (b) Dos corridas de novedades del mismo RFC el mismo día
       ⇒ UN envío «novedades» en mail_sends.
   (c) Opinión semilla con sentido positivo ⇒ el asunto y la
       primera línea del correo lo dicen, con su vigencia.
   (d) La pantalla de enviados lista el envío con su estado
       y su contenido (vía /api/mail/log, su fuente).
   (e) Llave API limitada a un RFC ⇒ /api/v1/cfdi/notas no
       devuelve notas de otro RFC; sin alcance de notas, 403.
   ================================================================ */
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPacoSATService } from './local-server.mjs';
import { composeNewsMail } from './news-mail.mjs';

const ORIGIN = 'https://pacosat.test';
const KEY = 'f'.repeat(64);
const OWN = 'MFI6212158B4';
const OTRO = 'XAXX010101000';
const EMISOR = 'AAA010101AAA';

/* Parser de juguete (el de ronda1220) para la carpeta vigilada. */
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
        Serie: attr('cfdi:Comprobante', 'Serie'), Folio: attr('cfdi:Comprobante', 'Folio'),
        Moneda: 'MXN', TipoDeComprobante: 'I' },
      [node('Emisor', { Rfc: attr('cfdi:Emisor', 'Rfc'), Nombre: 'EMISOR DE JUGUETE' }),
       node('Receptor', { Rfc: attr('cfdi:Receptor', 'Rfc'), Nombre: 'RECEPTOR DE JUGUETE' }),
       node('Complemento', {}, [stamp])]);
    return { documentElement: root, getElementsByTagName: () => [] };
  }
}
const xmlCfdi = ({ uuid, fecha, total = '116.00', folio = '' }) =>
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital" ' +
  'Version="4.0" Fecha="' + fecha + '" Moneda="MXN" Total="' + total + '" TipoDeComprobante="I"' +
  (folio ? ' Folio="' + folio + '"' : '') + '>' +
  '<cfdi:Emisor Rfc="' + EMISOR + '" Nombre="EMISOR DE JUGUETE"/>' +
  '<cfdi:Receptor Rfc="' + OWN + '" Nombre="RECEPTOR DE JUGUETE"/>' +
  '<cfdi:Complemento><tfd:TimbreFiscalDigital Version="1.1" UUID="' + uuid + '" FechaTimbrado="' + fecha + '"/></cfdi:Complemento>' +
  '</cfdi:Comprobante>';

function makeHarness(extra = {}) {
  let time = Date.parse('2026-11-13T15:00:00Z'); /* viernes 13 nov 2026, 09:00 MX */
  let token = '';
  const mails = [];
  const service = createPacoSATService({
    dbFile: ':memory:', html: '<html><head><!--PACOSAT_TOKEN--></head><body>prueba</body></html>',
    origin: ORIGIN, proxyKey: KEY, satDocRetryWaitMs: 5,
    makeConnector: () => ({ parser: FixtureParser, connector: {
      request: async () => 'req-c', check: async () => ({ status: 'pending', packages: [] }),
      download: async () => { throw new Error('sin paquetes'); } } }),
    makeMailer: () => ({ verify: async () => true,
      sendMail: async mail => { mails.push(mail); return { messageId: 'm' + mails.length }; } }),
    now: () => time, ...extra });
  const raw = async (method, path, body, extraHeaders = {}) => {
    const chunks = []; if (body !== undefined) chunks.push(Buffer.from(JSON.stringify(body)));
    const req = Readable.from(chunks);
    req.method = method; req.url = path;
    req.headers = { host: 'pacosat.test', origin: ORIGIN, 'x-pacosat-proxy': KEY, ...extraHeaders };
    let status = 0; let text = '';
    const res = { writeHead(c) { status = c; }, setHeader() {}, getHeader() { return undefined; },
      end(chunk) { if (chunk) text += Buffer.isBuffer(chunk) ? chunk.toString('latin1') : chunk; } };
    await service.handle(req, res);
    return { status, text };
  };
  const call = async (method, path, body) => {
    if (!token) { const home = await raw('GET', '/'); token = /[0-9a-f]{64}/.exec(home.text)?.[0] || ''; }
    const r = await raw(method, path, body, { 'x-pacosat-token': token });
    let json = null; try { json = JSON.parse(r.text); } catch { /* binario */ }
    return { status: r.status, json, text: r.text };
  };
  const api = async (llave, path) => {
    const r = await raw('GET', path, undefined, { authorization: 'Bearer ' + llave });
    let json = null; try { json = JSON.parse(r.text); } catch { /* */ }
    return { status: r.status, json };
  };
  return { service, call, raw, api, mails,
    set time(v) { time = v; }, get time() { return time; } };
}
const setupMail = async h => {
  const mail = await h.call('POST', '/api/mail', { host: 'smtp.test', port: 465, security: 'ssl',
    from: 'avisos@pacosat.test', recipient: 'paco@test.mx', user: 'u', password: 'p' });
  assert.equal(mail.status, 200);
  const seed = await h.call('POST', '/api/storage', { batch: {
    people: [{ id: OWN, name: 'Mano Fil, S.A.' }, { id: OTRO, name: 'Otra, S.A.' }] } });
  assert.equal(seed.status, 200);
};
const unlock = async (h, rfc = OWN) => {
  const open = await h.call('POST', '/api/unlock', { rfc, minutes: 1440, days: 7,
    direction: 'both', password: 'simulated', certificate: 'YQ==', key: 'Yg==' });
  assert.equal(open.status, 200, 'unlock ' + rfc);
};

/* ===== (a) El compositor: html y texto, mismos datos ===== */
{
  const rows = [
    { uuid: '44444444-4444-4444-8444-444444444444', fecha: '2026-11-03', counterpartName: 'Proveedor Uno SA',
      counterpartRfc: EMISOR, folio: '41', serie: '', total: '10474.80', estado: 'Vigente', kind: 'I', direction: 'received' },
    { uuid: '55555555-5555-4555-8555-555555555555', fecha: '2026-11-05', counterpartName: 'Proveedor Dos SA',
      counterpartRfc: 'BBB010101BB2', folio: '', serie: '', total: '1000.20', estado: 'Vigente', kind: 'I', direction: 'received' }];
  const conUrl = composeNewsMail({ kind: 'sat', rfc: OWN, direction: 'received', label: '' }, rows, 2,
    { baseUrl: ORIGIN, installName: 'PacoSAT' });
  for (const nombre of ['Proveedor Uno SA', 'Proveedor Dos SA']) {
    assert.ok(conUrl.text.includes(nombre), 'texto: ' + nombre);
    assert.ok(conUrl.html.includes(nombre), 'html: ' + nombre);
  }
  assert.ok(conUrl.text.includes('Importe total de lo nuevo: $11,475.00.'), 'texto: el total');
  assert.ok(conUrl.html.includes('$11,475.00'), 'html: el MISMO total');
  assert.ok(conUrl.html.includes('#175c9e'), 'html: el azul de la casa');
  assert.ok(conUrl.html.includes('<svg'), 'html: el faro en SVG inline');
  assert.ok(conUrl.html.includes('href="' + ORIGIN + '/#/facturas?rfc=' + OWN + '&amp;periodo=2026-11"'),
    'html: el botón enlaza a Facturas con el RFC y el periodo del aviso');
  assert.ok(conUrl.text.includes(ORIGIN + '/#/facturas?rfc=' + OWN), 'texto: el mismo enlace profundo');
  const sinUrl = composeNewsMail({ kind: 'sat', rfc: OWN, direction: 'received', label: '' }, rows, 2, {});
  assert.ok(!sinUrl.html.includes('Abrir en Facturas'), 'sin URL configurada: no hay botón (nunca un enlace roto)');
  assert.ok(!sinUrl.text.includes('#/facturas'), 'sin URL: el texto conserva la prosa de siempre');
  console.log('OK 2.0·T3 · (a) compositor — html+texto con los mismos comprobantes y total, botón profundo con URL y prosa sin ella.');
}

/* ===== (b) Dos corridas el mismo día ⇒ UN envío por RFC y día ===== */
{
  const dir = mkdtempSync(join(tmpdir(), 'pacosat-200c-watch-'));
  const h = makeHarness({ watchDir: dir, inboxParser: FixtureParser, watchSettleMs: 0 });
  try {
    await setupMail(h); await unlock(h);
    writeFileSync(join(dir, 'uno.xml'), xmlCfdi({ uuid: '11111111-1111-4111-8111-111111111111', fecha: '2026-11-10T10:00:00', folio: '1' }));
    await h.service.inboxTick(h.time);
    h.time += 3 * 60000; await h.service.tick();
    const novedades1 = h.mails.filter(m => String(m.subject || '').includes('Nuevos CFDI'));
    assert.equal(novedades1.length, 1, 'la primera corrida del día manda su correo al momento');
    assert.ok(novedades1[0].html && novedades1[0].html.includes('<svg'), 'el correo de novedades sale en HTML (A1)');
    writeFileSync(join(dir, 'dos.xml'), xmlCfdi({ uuid: '22222222-2222-4222-8222-222222222222', fecha: '2026-11-11T10:00:00', folio: '2' }));
    await h.service.inboxTick(h.time);
    h.time += 3 * 60000; await h.service.tick();
    const log = await h.call('GET', '/api/mail/log');
    const enviosNovedades = log.json.sends.filter(send => send.kind === 'novedades');
    assert.equal(enviosNovedades.length, 1,
      'O8: mail_sends muestra UN envío de novedades para el RFC en el día (hubo ' + enviosNovedades.length + ')');
    assert.equal(h.mails.filter(m => String(m.subject || '').includes('Nuevos CFDI')).length, 1,
      'O8: tampoco salió un segundo correo por el transporte');
    /* (d) La pantalla de enviados: ese envío, con estado y contenido. */
    const envio = enviosNovedades[0];
    assert.equal(envio.ok, 1, 'E10: el envío consta entregado (ok)');
    assert.ok('rfc' in envio, 'E10: el envío lleva su campo RFC (la bandeja nace sin RFC atribuido, 1.24.0)');
    assert.ok(envio.body && envio.body.includes('Nuevos CFDI') === false && envio.body.includes('comprobante'),
      'E10: el envío guarda el texto que salió');
    assert.ok(envio.html && envio.html.includes('Proveedor') === false && envio.html.length > 200,
      'E10: el envío guarda su HTML');
    assert.ok(envio.subject.includes('Nuevos CFDI'), 'E10: el envío se lista con su asunto');
    console.log('OK 2.0·T3 · (b)+(d) O8/E10 — dos corridas, un envío en mail_sends, listado con estado y contenido.');
  } finally { h.service.close(); rmSync(dir, { recursive: true, force: true }); }
}

/* ===== (c) Opinión positiva: el correo lo dice sin abrir el PDF ===== */
{
  const PDF_OPINION = Buffer.from('%PDF-1.4 Opinion de cumplimiento POSITIVA vigente hasta el 31 de diciembre de 2026');
  const h = makeHarness({ satDocFetch: async () => ({ content: PDF_OPINION, issuedAt: '2026-11-13', source: 'portal' }) });
  try {
    await setupMail(h); await unlock(h);
    const run = await h.call('POST', '/api/satdocs/run', { rfc: OWN, kind: 'opinion' });
    assert.equal(run.status, 200);
    assert.equal(run.json.results.opinion.ok, true, 'la opinión bajó');
    const correo = h.mails.find(m => String(m.subject || '').includes('Opinión'));
    assert.ok(correo, 'salió el correo del documento');
    assert.ok(correo.subject.includes('POSITIVA'), 'M6: el ASUNTO dice el sentido: ' + correo.subject);
    assert.ok(correo.subject.includes('31 de diciembre de 2026'), 'M6: el asunto dice la vigencia leída del documento');
    assert.ok(correo.text.split('\n')[0].includes('POSITIVA'), 'M6: la PRIMERA línea dice el sentido');
    assert.ok(correo.html && correo.html.includes('POSITIVA'), 'M6: el HTML dice lo mismo que el texto');
    const logC = await h.call('GET', '/api/mail/log');
    const envioDoc = logC.json.sends.find(send => send.kind === 'constancia');
    assert.ok(envioDoc && envioDoc.rfc === OWN && envioDoc.ok === 1, 'E10: el envío del documento se lista con su RFC y su estado');
    console.log('OK 2.0·T3 · (c) M6 — opinión POSITIVA con vigencia en asunto y primera línea, sin abrir el PDF.');
  } finally { h.service.close(); }
}

/* ===== Correo de prueba con la plantilla real (6.5) ===== */
{
  const h = makeHarness();
  try {
    await setupMail(h);
    await h.call('POST', '/api/settings', { installName: '', senderName: 'Avisos PacoSAT', accent: '' });
    const prueba = await h.call('POST', '/api/mail/test', {});
    assert.equal(prueba.status, 200);
    const correo = h.mails.find(m => String(m.subject || '').includes('prueba'));
    assert.ok(correo, 'salió el correo de prueba');
    assert.ok(correo.text.includes('EJEMPLO'), '6.5: el ejemplo va marcado como EJEMPLO');
    assert.ok(correo.text.includes('Avisos PacoSAT'), '6.5: el cuerpo confirma el nombre de remitente que verán los destinatarios');
    assert.ok(correo.html && correo.html.includes('<svg'), '6.5: la prueba usa la plantilla madre (HTML con el faro)');
    console.log('OK 2.0·T3 · 6.5 — prueba con plantilla real, EJEMPLO en grande y remitente confirmado.');
  } finally { h.service.close(); }
}

/* ===== (e) Notas de la API: alcance propio y filtro por RFC ===== */
{
  const h = makeHarness();
  try {
    await setupMail(h); await unlock(h); await unlock(h, OTRO);
    const U1 = 'CCCCCCCC-1111-4111-8111-111111111111';
    const U2 = 'DDDDDDDD-2222-4222-8222-222222222222';
    await h.call('POST', '/api/storage', { batch: { invoices: [
      { id: U1, date: '2026-10-05T12:00:00', kind: 'I', total: '100.00',
        from: { rfc: OWN, name: 'Mano Fil, S.A.' }, to: { rfc: EMISOR, name: 'Cliente' } },
      { id: U2, date: '2026-10-06T12:00:00', kind: 'I', total: '200.00',
        from: { rfc: OTRO, name: 'Otra, S.A.' }, to: { rfc: EMISOR, name: 'Cliente' } }] } });
    await h.call('POST', '/api/cfdi/nota', { uuid: U1, nota: 'nota de Mano Fil' });
    await h.call('POST', '/api/cfdi/nota', { uuid: U2, nota: 'nota de la otra' });
    const conNotas = await h.call('POST', '/api/apikeys', { nombre: 'Notas Mano Fil', alcance: 'lectura-notas', rfc: OWN });
    assert.equal(conNotas.status, 200, 'el alcance «lectura-notas» se crea');
    const sinNotas = await h.call('POST', '/api/apikeys', { nombre: 'Lectura Mano Fil', alcance: 'lectura', rfc: OWN });
    const r1 = await h.api(conNotas.json.llave, '/api/v1/cfdi/notas');
    assert.equal(r1.status, 200, 'con alcance de notas: 200');
    assert.equal(r1.json.datos.notas[U1], 'nota de Mano Fil', 'la nota de su RFC sí sale');
    assert.ok(!(U2 in (r1.json.datos.notas || {})), 'M10: la nota del OTRO RFC no sale para esta llave');
    const r2 = await h.api(sinNotas.json.llave, '/api/v1/cfdi/notas?rfc=' + OWN);
    assert.equal(r2.status, 403, 'sin alcance de notas: 403');
    assert.equal(r2.json.error.codigo, 'alcance-insuficiente');
    const interna = await h.call('GET', '/api/cfdi/notas');
    assert.equal(interna.json.notas[U2], 'nota de la otra', 'la sesión admin de la app sigue viendo lo suyo (documentado)');
    console.log('OK 2.0·T3 · (e) M10 — notas solo con su alcance y filtradas por el RFC de la llave.');
  } finally { h.service.close(); }
}

console.log('OK 2.0 · Tanda 3 completa.');
