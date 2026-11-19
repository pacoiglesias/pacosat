import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { DOMParser } from '@xmldom/xmldom';
import { createPacoSATService, conReintentoBusy } from './local-server.mjs';

/* ================================================================
   Ronda 2.4.0 · W2 (servidor) — P5 (4 piezas) + Enviar + 24 + 28
   1 · /healthz sin sesión, sin datos sensibles.
   2 · conReintentoBusy: reintenta ante SQLITE_BUSY y error
       honesto si siempre falla; otro error no se reintenta.
   3 · Modo histórico de huecos: con hueco pide 1 (el más
       antiguo), sin hueco 0, 1/hora, y respeta el libro de
       criterios (ventana ensanchada, nunca repetida).
   4 · Conciliación: N-a-1 que cuadra, tolerancia dentro/fuera
       de banda, y el exacto sigue ganando.
   5 · Enviar: referencia válida envía y deja asiento; ruta
       libre rechazada; invitado 403; fallo del motor con
       porqué y asiento de fallo.
   6 · Resumen semanal: con datos compone el correo con las
       cifras; sin novedad no se manda (criterio declarado).
   7 · Fin de paseo con captura: el aviso la lleva adjunta.
   ================================================================ */

const ORIGIN = 'https://pacosat.test';
const KEY = 'w'.repeat(64);
const OWN = 'AAA010101AAA';
const PROV1 = 'BBB010101BB1';
const PROV2 = 'CCC010101CC1';
const CLABE = '012180001234567590';
const pdf64 = Buffer.from('%PDF-1.7 estado de juguete ' + 'x'.repeat(120)).toString('base64');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0]);

function makeHarness(options = {}) {
  const clock = { t: Date.parse('2026-11-16T15:00:00Z') };
  const mails = [];
  const requests = [];
  const flags = { mailFails: false };
  let text = '';
  const service = createPacoSATService({
    dbFile: ':memory:', html: '<html><head><!--PACOSAT_TOKEN--></head><body>prueba</body></html>',
    origin: ORIGIN, proxyKey: KEY, satDocRetryWaitMs: 5,
    extractText: async () => text,
    makeConnector: () => ({ parser: DOMParser, connector: {
      request: async args => { requests.push(args); return 'req-240-' + requests.length; },
      check: async () => ({ status: 'finished', packages: [] }),
      download: async () => { throw new Error('sin paquetes'); } } }),
    makeMailer: () => ({ verify: async () => true,
      sendMail: async mail => { if (flags.mailFails) throw new Error('SMTP de juguete caído'); mails.push(mail); return { messageId: 'm' + mails.length }; } }),
    now: () => clock.t, ...options });
  let token = '';
  const raw = async (method, path, body, extraHeaders = {}) => {
    const chunks = []; if (body !== undefined) chunks.push(Buffer.from(JSON.stringify(body)));
    const req = Readable.from(chunks);
    req.method = method; req.url = path;
    req.headers = { host: 'pacosat.test', origin: ORIGIN, 'x-pacosat-proxy': KEY, ...extraHeaders };
    let status = 0; const headers = {}; let out = '';
    const res = { writeHead(code, hdrs) { status = code; if (hdrs) Object.assign(headers, hdrs); },
      setHeader(k, v) { headers[k] = v; }, getHeader(k) { return headers[k]; },
      end(chunk) { if (chunk) out += Buffer.isBuffer(chunk) ? chunk.toString('latin1') : chunk; } };
    await service.handle(req, res);
    return { status, text: out, headers };
  };
  const call = async (method, path, body, extraHeaders = {}) => {
    if (!token) { const home = await raw('GET', '/'); token = /[0-9a-f]{64}/.exec(home.text)?.[0] || ''; }
    const r = await raw(method, path, body, { 'x-pacosat-token': token, ...extraHeaders });
    let json = null; try { json = JSON.parse(r.text); } catch { /* binario */ }
    return { status: r.status, json, text: r.text, headers: r.headers };
  };
  const callAs = async (otroToken, method, path, body) => {
    const r = await raw(method, path, body, { 'x-pacosat-token': otroToken });
    let json = null; try { json = JSON.parse(r.text); } catch { /* binario */ }
    return { status: r.status, json, text: r.text };
  };
  return { service, call, callAs, raw, mails, requests, flags, clock,
    set text(v) { text = v; }, get text() { return text; } };
}
const unlock = async (h, rfc = OWN) => {
  const open = await h.call('POST', '/api/unlock', { rfc, minutes: 1440, days: 7,
    direction: 'both', password: 'simulated', certificate: 'YQ==', key: 'Yg==' });
  assert.equal(open.status, 200, 'unlock de ' + rfc);
};
const configureMail = async h => {
  const mail = await h.call('POST', '/api/mail', { host: 'smtp.test', port: 465, security: 'ssl',
    from: 'avisos@pacosat.test', recipient: 'paco@test.mx', user: 'u', password: 'p' });
  assert.equal(mail.status, 200, 'correo configurado');
};
const invoice = (id, date, from, to, total) => ({ id, date, kind: 'I', currency: 'MXN', total,
  from: { rfc: from, name: 'EMPRESA ' + from }, to: { rfc: to, name: 'EMPRESA ' + to },
  fiscal: { paymentMethod: 'PPD', transferred: [], withheld: [] } });

/* ================= 1 · /healthz ================= */
{
  const h = makeHarness();
  try {
    const r = await h.raw('GET', '/healthz');
    assert.equal(r.status, 200, 'healthz responde 200 sin sesión');
    const body = JSON.parse(r.text);
    assert.deepEqual(Object.keys(body).sort(), ['db', 'ok', 'version'],
      'healthz solo trae ok, versión y db: sin conteos, sin RFC, sin ajustes');
    assert.equal(body.ok, true); assert.equal(body.db, 'ok');
    assert.ok(!/AAA010101|profiles|settings/.test(r.text), 'healthz no filtra datos');
    console.log('OK 2.4.0-W2 · 1 — /healthz 200 sin sesión y sin datos sensibles.');
  } finally { h.service.close(); }
}

/* ================= 2 · conReintentoBusy ================= */
{
  let calls = 0;
  const ok = conReintentoBusy(() => { calls++;
    if (calls <= 2) throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
    return 'hecho'; }, { dormir: () => {} });
  assert.equal(ok, 'hecho', 'la doble que falla 2 veces acaba ok');
  assert.equal(calls, 3, 'dos fallos + el acierto');
  let calls2 = 0;
  assert.throws(() => conReintentoBusy(() => { calls2++;
    throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' }); }, { dormir: () => {} }),
    /database is locked/, 'si siempre falla, el error de siempre sale: no se traga ni se finge');
  assert.equal(calls2, 4, 'tope de intentos por defecto: 4');
  let calls3 = 0;
  assert.throws(() => conReintentoBusy(() => { calls3++; throw new Error('otro error'); }, { dormir: () => {} }),
    /otro error/, 'un error que no es BUSY no se reintenta');
  assert.equal(calls3, 1);
  console.log('OK 2.4.0-W2 · 2 — BUSY reintenta y acaba ok; siempre-BUSY da el error honesto; otro error no se reintenta.');
}

/* ================= 4 · Conciliación N-a-1 y tolerancia ================= */
{
  const h = makeHarness();
  try {
    await h.call('POST', '/api/storage', { batch: { people: [{ id: OWN, name: 'Empresa Propia SA' }] } });
    await unlock(h);
    const F_EXACTA = '11111111-1111-4111-8111-111111111111';
    const F_500 = '22222222-2222-4222-8222-222222222222';
    const F_300 = '33333333-3333-4333-8333-333333333333';
    const F_400 = '44444444-4444-4444-8444-444444444444';
    const F_200 = '55555555-5555-4555-8555-555555555555';
    const F_1000 = '66666666-6666-4666-8666-666666666666';
    const F_2000 = '77777777-7777-4777-8777-777777777777';
    const seed = await h.call('POST', '/api/storage', { batch: { invoices: [
      invoice(F_EXACTA, '2026-10-03', PROV1, OWN, '1160.00'),
      invoice(F_500, '2026-10-03', PROV1, OWN, '500.00'),
      invoice(F_300, '2026-10-04', PROV2, OWN, '300.00'),
      invoice(F_400, '2026-10-04', PROV2, OWN, '400.00'),
      invoice(F_200, '2026-10-05', PROV2, OWN, '200.00'),
      invoice(F_1000, '2026-10-05', PROV1, OWN, '1000.00'),
      invoice(F_2000, '2026-10-06', PROV1, OWN, '2000.00')] } });
    assert.equal(seed.status, 200);
    const alta = await h.call('POST', '/api/banks/accounts',
      { bank: 'BBVA', name: 'Chequera', kind: 'cuenta', numero: CLABE, rfc: OWN });
    const account = alta.json.accounts[0];
    h.text = ['BBVA MEXICO · ESTADO DE CUENTA', 'Cuenta ' + CLABE,
      'Periodo del 01/10/2026 al 31/10/2026', 'Saldo inicial $20,000.00', 'Saldo final $14,165.00',
      'Total de abonos $0.00', 'Total de cargos $5,835.00',
      '05/10/2026 PAGO UNO $1,160.00 $18,840.00',
      '06/10/2026 PAGO DOS $500.00 $18,340.00',
      '07/10/2026 PAGO TRES $700.00 $17,640.00',
      '08/10/2026 PAGO CUATRO $995.00 $16,645.00',
      '09/10/2026 PAGO CINCO $1,980.00 $14,665.00'].join('\n');
    const ap = await h.call('POST', '/api/banks/statements/auto', { content: pdf64 });
    assert.equal(ap.json.aplicados, 5, 'los cinco movimientos se aplican: ' + ap.text);
    const vista = (await h.call('GET', '/api/banks/conciliacion?month=2026-10')).json;
    const mia = vista.porCuenta.find(v => v.account.id === account.id);
    const porImporte = importe => mia.pagosSinFactura.find(p => p.movement.amount === importe);
    const exacta = porImporte('-1160.00');
    assert.equal(exacta.propuesta240.tipo, 'exacta', 'el exacto 1-a-1 sigue como siempre');
    assert.equal(exacta.sugerencia.uuid, F_EXACTA, 'la sugerencia de siempre no cambia');
    const quinientos = porImporte('-500.00');
    assert.equal(quinientos.propuesta240.tipo, 'exacta',
      'prioridad: el exacto (F de $500) gana a la suma 300+200 que también cuadra');
    assert.equal(quinientos.propuesta240.invoices[0].uuid, F_500);
    const suma = porImporte('-700.00');
    assert.ok(suma, 'el movimiento de $700 consta');
    assert.equal(suma.propuesta240.tipo, 'suma-varias', 'N-a-1: 400+300 del mismo emisor cuadra al centavo');
    assert.deepEqual(suma.propuesta240.invoices.map(i => i.uuid).sort(), [F_300, F_400].sort(),
      'la propuesta dice qué facturas la componen');
    assert.equal(suma.propuesta240.suma, '700.00', 'y su suma');
    assert.equal(suma.sugerencia, null, 'sin exacta única no se inventa la sugerencia de siempre');
    const tol = porImporte('-995.00');
    assert.equal(tol.propuesta240.tipo, 'comision', 'tolerancia: $1,000 − $995 = $5 dentro de la banda de $10');
    assert.equal(tol.propuesta240.diferencia, '5.00');
    assert.match(tol.propuesta240.texto, /difiere en \$5\.00: encaja con una comisión bancaria dentro de tu tolerancia de \$10\.00/i);
    const fuera = porImporte('-1980.00');
    assert.equal(fuera.propuesta240, null, 'fuera de banda ($20 > $10) y sin suma que cuadre: ninguna propuesta inventada');
    assert.equal(vista.toleranciaComision240.centavos, 1000, 'la tolerancia vigente es visible en la respuesta');
    assert.match(vista.regla, /N-a-1/, 'la regla declara los modos nuevos');
    console.log('OK 2.4.0-W2 · 4 — conciliación: exacto gana, N-a-1 compone y suma, tolerancia dentro/fuera de banda.');
  } finally { h.service.close(); }
}

/* ================= 3 · Modo histórico de huecos ================= */
const seedHuecos = async (h, meses) => {
  await h.call('POST', '/api/storage', { batch: { people: [{ id: OWN, name: 'Empresa Propia SA' }] } });
  await unlock(h);
  const invoices = meses.map((mes, i) => invoice(
    '99999999-9999-4999-8999-99999999999' + i, mes + '-05', PROV1, OWN, '116.00'));
  const seed = await h.call('POST', '/api/storage', { batch: { invoices } });
  assert.equal(seed.status, 200);
  const cfg = await h.call('POST', '/api/settings', { historico240: { enabled: true } });
  assert.equal(cfg.status, 200);
  assert.equal(cfg.json.settings.historico240.enabled, true, 'el ajuste del modo histórico se guarda y se enseña');
};
{
  /* Con hueco pide 1 (el más antiguo); sin pasar una hora no pide otra. */
  const h = makeHarness();
  try {
    await seedHuecos(h, ['2026-05', '2026-08', '2026-10']); /* huecos: jun, jul, sep */
    h.clock.t = Date.parse('2026-11-17T08:30:00Z'); /* 02:30 en México */
    await h.service.tick();
    /* Las solicitudes de la cadencia programada normal del
       perfil (su ventana de 7 días, cfdi y metadatos) son de
       otra pieza y no cuentan aquí: se filtra por las ventanas
       de los meses hueco (jun/jul/sep). */
    const deHuecos = () => h.requests.filter(r => ['2026-06-01', '2026-07-01', '2026-09-01'].includes(r.start));
    const deJunio = h.requests.filter(r => r.start === '2026-06-01');
    assert.equal(deJunio.length, 1, 'con huecos pide UNA: la del hueco más antiguo (junio)');
    assert.equal(deHuecos().length, 1, 'ninguna otra solicitud de huecos salió en la ventana');
    await h.service.tick();
    assert.equal(deHuecos().length, 1, 'segunda pasada dentro de la misma hora: no excede 1/hora');
    h.clock.t += 30 * 60000;
    await h.service.tick();
    assert.equal(h.requests.filter(r => r.start === '2026-06-01').length, 1,
      'a la media hora sigue sin pedir otra (la marca es del intento)');
    const registro = (await h.call('GET', '/api/registro?limit=300')).json;
    assert.ok(JSON.stringify(registro).includes('modo histórico'),
      'cada solicitud del modo deja su asiento en el Registro');
    console.log('OK 2.4.0-W2 · 3a — modo histórico: hueco más antiguo, 1/hora, asiento en el Registro.');
  } finally { h.service.close(); }
}
{
  /* Sin huecos no pide nada. */
  const h = makeHarness();
  try {
    await seedHuecos(h, ['2026-08', '2026-09', '2026-10']);
    h.clock.t = Date.parse('2026-11-17T08:30:00Z');
    await h.service.tick();
    assert.equal(h.requests.filter(r => r.start < '2026-11-01').length, 0,
      'sin huecos no pide nada (ninguna ventana de meses pasados; la cadencia normal del perfil es otra pieza)');
    console.log('OK 2.4.0-W2 · 3b — modo histórico: sin huecos, cero solicitudes.');
  } finally { h.service.close(); }
}
{
  /* Respeta el libro: criterio exacto ya enviado ⇒ ventana ensanchada. */
  const h = makeHarness();
  try {
    await seedHuecos(h, ['2026-05', '2026-08', '2026-10']);
    /* Quema el criterio exacto de junio con una solicitud manual
       y déjala terminar (la doble la da por terminada). */
    const manual = await h.call('POST', '/api/request',
      { rfc: OWN, start: '2026-06-01', end: '2026-06-30', direction: 'received' });
    assert.equal(manual.status, 200, 'solicitud manual de junio: ' + manual.text);
    await h.service.tick(); /* la verifica y la da por terminada */
    const exactas = () => h.requests.filter(r => r.start === '2026-06-01' && r.startTime === '00:00:00');
    assert.equal(exactas().length, 1, 'el criterio exacto se envió una sola vez (la manual)');
    h.clock.t = Date.parse('2026-11-17T08:30:00Z');
    await h.service.tick();
    const ensanchada = h.requests.filter(r => r.start === '2026-06-01' && r.startTime === '00:00:01');
    assert.equal(ensanchada.length, 1,
      'el modo histórico ensancha la ventana (+1 s al inicio) en vez de repetir el criterio exacto');
    assert.equal(exactas().length, 1, 'el criterio exacto NUNCA se repite');
    console.log('OK 2.4.0-W2 · 3c — modo histórico: respeta el libro de criterios (ventana ensanchada).');
  } finally { h.service.close(); }
}

/* ================= 5 · Enviar ================= */
{
  const h = makeHarness();
  try {
    await configureMail(h);
    await h.call('POST', '/api/storage', { batch: { people: [{ id: OWN, name: 'Empresa Propia SA' }] } });
    const DOC = 'pdf:doc240';
    const contenido = Buffer.from('%PDF-1.4 constancia 240');
    const seed = await h.call('POST', '/api/storage', { batch: {
      documents: [{ id: DOC, rfc: OWN, kind: 'Constancia', name: 'Constancia 240.pdf', date: '2026-10-05', period: '2026-10' }],
      files: [{ id: DOC, mime: 'application/pdf', content: contenido.toString('base64') }] } });
    assert.equal(seed.status, 200, 'documento sembrado: ' + seed.text);
    const ok = await h.call('POST', '/api/enviar',
      { para: 'destino@ejemplo.mx', asunto: 'Tu constancia', clase: 'documento', id: DOC });
    assert.equal(ok.status, 200, 'enviar válido: ' + ok.text);
    assert.equal(ok.json.ok, true);
    assert.equal(h.mails.length, 1, 'salió un correo por el motor de la casa');
    assert.equal(h.mails[0].to, 'destino@ejemplo.mx');
    assert.equal(h.mails[0].subject, 'Tu constancia');
    assert.equal(h.mails[0].attachments[0].filename, 'Constancia 240.pdf');
    assert.ok(Buffer.from(h.mails[0].attachments[0].content).equals(contenido),
      'el adjunto es el fichero del propio expediente');
    assert.match(h.mails[0].text, /Constancia 240\.pdf/, 'el cuerpo, generado por el servidor, nombra el documento');
    const registro = (await h.call('GET', '/api/registro?limit=300')).json;
    assert.ok(JSON.stringify(registro).includes('enviado Constancia 240.pdf a destino@ejemplo.mx'),
      'asiento en el Registro: «enviado <documento> a <destinatario>»');
    /* El ZIP del mes, otra clase cerrada. */
    const zip = await h.call('POST', '/api/enviar',
      { para: 'destino@ejemplo.mx', asunto: 'Paquete de octubre', clase: 'zip-mes', rfc: OWN, mes: '2026-10' });
    assert.equal(zip.status, 200, 'zip-mes válido: ' + zip.text);
    assert.match(h.mails[1].attachments[0].filename, /PacoSAT-paquete-2026-10/);
    /* Ruta libre: rechazada, y no sale nada. */
    const libre = await h.call('POST', '/api/enviar',
      { para: 'destino@ejemplo.mx', asunto: 'x', clase: 'documento', id: DOC, ruta: '/etc/passwd' });
    assert.equal(libre.status, 400, 'cualquier ruta libre se rechaza');
    const claseLibre = await h.call('POST', '/api/enviar',
      { para: 'destino@ejemplo.mx', asunto: 'x', clase: 'fichero', path: '/etc/passwd' });
    assert.equal(claseLibre.status, 400, 'una clase fuera del conjunto cerrado se rechaza');
    assert.equal(h.mails.length, 2, 'los rechazos no enviaron nada');
    /* Invitado: 403 como el resto de rutas de acción. */
    assert.equal((await h.call('POST', '/api/guest/config',
      { password: 'invitado-240', enabled: true, rfcs: [OWN] })).status, 200);
    const login = await h.call('POST', '/api/guest/login', { password: 'invitado-240' });
    assert.ok(login.json.token, 'sesión de invitado emitida');
    const delInvitado = await h.callAs(login.json.token, 'POST', '/api/enviar',
      { para: 'destino@ejemplo.mx', asunto: 'x', clase: 'documento', id: DOC });
    assert.equal(delInvitado.status, 403, 'el invitado no envía: 403');
    assert.equal(h.mails.length, 2, 'el intento del invitado no envió nada');
    console.log('OK 2.4.0-W2 · 5a — Enviar: válido envía con adjunto del sistema y asiento; ruta libre e invitado, rechazados.');
  } finally { h.service.close(); }
}
{
  /* Fallo del motor: porqué en llano + asiento de fallo. */
  const h = makeHarness();
  try {
    await configureMail(h);
    const DOC = 'pdf:doc240f';
    const contenido = Buffer.from('%PDF-1.4 constancia 240');
    await h.call('POST', '/api/storage', { batch: {
      documents: [{ id: DOC, rfc: OWN, kind: 'Constancia', name: 'Constancia 240.pdf', date: '2026-10-05', period: '2026-10' }],
      files: [{ id: DOC, mime: 'application/pdf', content: contenido.toString('base64') }] } });
    h.flags.mailFails = true;
    const fail = await h.call('POST', '/api/enviar',
      { para: 'destino@ejemplo.mx', asunto: 'Tu constancia', clase: 'documento', id: DOC });
    assert.equal(fail.status, 502, 'el fallo del motor responde con error');
    assert.equal(fail.json.ok, false);
    assert.match(fail.json.error, /SMTP de juguete caído/, 'la respuesta dice el porqué en llano');
    assert.match(fail.json.error, /borrador no se guardó/, 'y declara que la ruta no guarda borradores');
    const registro = (await h.call('GET', '/api/registro?limit=300')).json;
    assert.ok(JSON.stringify(registro).includes('no se pudo enviar Constancia 240.pdf a destino@ejemplo.mx'),
      'el fallo también deja su asiento en el Registro');
    console.log('OK 2.4.0-W2 · 5b — Enviar: fallo del motor con porqué en llano y asiento de fallo.');
  } finally { h.service.close(); }
}

/* ================= 6 · Resumen semanal ================= */
{
  const h = makeHarness();
  try {
    await configureMail(h);
    await h.call('POST', '/api/storage', { batch: { people: [{ id: OWN, name: 'Empresa Propia SA' }] } });
    await unlock(h);
    const PPD = '88888888-8888-4888-8888-888888888888';
    const seed = await h.call('POST', '/api/storage', { batch: { invoices: [
      invoice(PPD, '2026-11-10', PROV1, OWN, '1160.00')] } });
    assert.equal(seed.status, 200);
    /* El reloj del arnés ya es lunes 16 nov 2026, 09:00 en México. */
    await h.service.tick();
    const resumen = h.mails.find(m => String(m.subject || '').includes('Resumen semanal con datos'));
    assert.ok(resumen, 'el lunes a las 08:00+ sale el resumen semanal con datos');
    assert.match(resumen.text, /COBRADO DEL PERIODO/, 'el correo trae lo cobrado, no un «abre la app»');
    assert.match(resumen.text, /REP pendiente\(s\) de PPD por \$1,160\.00/,
      'y lo que falta por RFC, con su cifra y su porqué (REP pendientes con saldo)');
    assert.ok(resumen.html && resumen.html.includes('Resumen semanal'), 'sale en HTML con la plantilla de avisos');
    console.log('OK 2.4.0-W2 · 6a — resumen semanal: correo con las cifras del cálculo reconciliado.');
  } finally { h.service.close(); }
}
{
  const h = makeHarness();
  try {
    await configureMail(h);
    await h.service.tick();
    assert.ok(!h.mails.some(m => String(m.subject || '').includes('Resumen semanal con datos')),
      'sin novedad no se manda (criterio de la casa, como el correo de novedades)');
    console.log('OK 2.4.0-W2 · 6b — resumen semanal: sin novedad, no sale.');
  } finally { h.service.close(); }
}

/* ================= 7 · Fin de paseo con captura ================= */
{
  const h = makeHarness({ executorMode: 'remote' });
  try {
    await configureMail(h);
    await unlock(h);
    const par = await h.call('POST', '/api/executor/pair', { nombre: 'Equipo 240' });
    assert.equal(par.status, 200, 'ejecutor emparejado: ' + par.text);
    const execToken = par.json.token;
    const exec = async (method, path, body) => {
      const r = await h.raw(method, path, body, { 'x-pacosat-executor': execToken });
      let json = null; try { json = JSON.parse(r.text); } catch { /* binario */ }
      return { status: r.status, json, text: r.text };
    };
    const job = (await h.call('POST', '/api/executor/jobs', { rfc: OWN, kind: 'buzon-listar', payload: {} })).json.job;
    assert.ok(job?.id, 'paseo del Buzón encolado');
    const claim = await exec('POST', '/api/executor/claim', { limit: 5 });
    assert.ok((claim.json.trabajos || []).some(t => t.id === job.id), 'el ejecutor reclama el paseo');
    const res = await exec('POST', '/api/executor/result', { jobId: job.id, status: 'failed',
      result: { steps: [{ at: 1, paso: 'Acceso al portal OK', detalle: '' }],
        operations: ['entrar-con-efirma', 'leer-lista'], notifications: [], accesoOk: true,
        error: 'La bandeja no apareció tras «Mis notificaciones».', errorKind: 'respuesta-inesperada',
        diag: { screenshotBase64: PNG.toString('base64'), html: '<html><body>bandeja</body></html>',
          url: 'https://wwwmat.sat.gob.mx/buzon' } } });
    assert.equal(res.json.ok, false, 'el paseo terminó (con error, con captura guardada)');
    assert.equal(res.json.job.resumen.captura240, 'adjunta al aviso de fin de paseo',
      'el resumen del trabajo dice que la captura va adjunta');
    await h.service.tick();
    const aviso = h.mails.find(m => String(m.subject || '').includes('Fin de paseo'));
    assert.ok(aviso, 'el aviso de fin de paseo salió por el canal de avisos');
    assert.ok(Array.isArray(aviso.attachments) && aviso.attachments.length === 1,
      'y lleva UN adjunto');
    assert.equal(aviso.attachments[0].filename, 'captura-paseo.png');
    assert.ok(Buffer.from(aviso.attachments[0].content).equals(PNG),
      'el adjunto ES la captura guardada de la corrida');
    console.log('OK 2.4.0-W2 · 7 — fin de paseo: el aviso lleva la captura adjunta.');
  } finally { h.service.close(); }
}

console.log('OK suite ronda240servidor completa');
