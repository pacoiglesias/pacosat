/* Ronda 1.24.0 — la ronda de cierre total, juzgada por puntos:
   - 5: login propio de administrador (sin configurar dice la
     verdad; contraseña mala frena y bloquea; la buena entra con
     cookie httpOnly, la sesión autoriza sin el token y el logout
     la mata; la puerta vigente no se toca);
   - 1: Buzón Tributario con motor simulado — la corrida LISTA
     sin abrir (el contrato del motor no tiene operación de
     apertura), guarda por RFC con su diario, reintenta lo del
     portal y deja su aviso con el RFC cuando hay sin abrir;
   - 2: vigilancia activa con el corte de prescripción — lo de
     2019 y lo archivado no cuentan como vivo, coherente con lo
     que Dinero y el Buzón excluyen;
   - 3 (M3): correos por RFC — el resumen de avisos sale uno por
     contribuyente y ningún cuerpo nombra al otro RFC;
   - 6: ensayo de restauración invocable — un conjunto generado
     resucita en su base aislada con sus conteos, sin tocar la
     base viva; sin respaldo configurado responde la verdad;
   - 4: velocidad — Hoy comparte lecturas (la caché satLecturas
     vive en el artefacto) y la carga diferida sirve las partes
     por /parte/<nombre> con su huella en la CSP, la página
     inicial pesa menos que la 1.23.0 y las rutas quedan;
   - 7: alta guiada — el perfil nace en «faltan credenciales»
     con un toque, sin inventar datos, y un RFC inválido se
     rechaza;
   - 10: los destinos nuevos existen en el menú (Buzón
     Tributario con su contador) y en el mapa de pantallas;
   - 12: correcciones de la pasada de seguridad — el rescate
     del Buzón solo sigue enlaces de LISTA fuera de tablas
     (nunca un detalle), el arranque barre los scratch de
     ensayos huérfanos y la sal del login propio exige 16
     bytes (H-2.1, H-5.1, H-1.3). */
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtempSync, rmSync, readFileSync, readdirSync, statSync, existsSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { scryptSync, randomBytes } from 'node:crypto';
import { DOMParser } from '@xmldom/xmldom';
import { createPacoSATService } from './local-server.mjs';
import { parseXml } from './xml-core.mjs';
import { BUZON_ENTRY_URL, extractBuzonRows, pickBuzonRescueLink } from './sat-tributario.mjs';

const ORIGIN = 'https://pacosat.test';
const KEY = 'f'.repeat(64);
const OWN = 'AAA010101AAA';
const BBB = 'BBB010101BB1';
const EDE = 'EDE1902136T2';
const PDF = Buffer.from('%PDF-1.4\n%respaldo de prueba\n');

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
    const res = { writeHead(code) { status = code; }, setHeader(k, v) { headers[k] = v; }, getHeader(k) { return headers[k]; },
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
  const callSinToken = async (method, path, body, extraHeaders = {}) => {
    const r = await raw(method, path, body, extraHeaders);
    let json = null; try { json = JSON.parse(r.text); } catch { /* binario */ }
    return { status: r.status, json, text: r.text, headers: r.headers };
  };
  return { service, call, callSinToken, mails, clock };
}
const unlock = async (h, rfc) => {
  const open = await h.call('POST', '/api/unlock', { rfc, minutes: 1440, days: 7,
    direction: 'both', password: 'simulated', certificate: 'YQ==', key: 'Yg==' });
  assert.equal(open.status, 200);
};
const xmlCfdi = ({ uuid, fecha, emisor, receptor, total, folio = '' }) => {
  const sub = (Number(total) / 1.16).toFixed(2);
  const tax = (Number(total) - Number(sub)).toFixed(2);
  return `<?xml version="1.0" encoding="UTF-8"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital" Version="4.0"${folio ? ` Folio="${folio}"` : ''} Fecha="${fecha}" SubTotal="${sub}" Moneda="MXN" Total="${total}" TipoDeComprobante="I" MetodoPago="PPD" FormaPago="99" LugarExpedicion="72000">
<cfdi:Emisor Rfc="${emisor}" Nombre="EMISOR SA" RegimenFiscal="601"/>
<cfdi:Receptor Rfc="${receptor}" Nombre="RECEPTOR SA" DomicilioFiscalReceptor="72000" RegimenFiscalReceptor="601" UsoCFDI="G03"/>
<cfdi:Conceptos><cfdi:Concepto ClaveProdServ="01010101" Cantidad="1" ClaveUnidad="H87" Descripcion="Servicio" ValorUnitario="${sub}" Importe="${sub}" ObjetoImp="02"><cfdi:Impuestos><cfdi:Traslados><cfdi:Traslado Base="${sub}" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="${tax}"/></cfdi:Traslados></cfdi:Impuestos></cfdi:Concepto></cfdi:Conceptos>
<cfdi:Impuestos TotalImpuestosTrasladados="${tax}"><cfdi:Traslados><cfdi:Traslado Base="${sub}" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="${tax}"/></cfdi:Traslados></cfdi:Impuestos>
<cfdi:Complemento><tfd:TimbreFiscalDigital Version="1.1" UUID="${uuid}" FechaTimbrado="${fecha}" RfcProvCertif="SAT970701NN3" SelloCFD="AAAA" NoCertificadoSAT="00001000000500000001" SelloSAT="BBBB"/></cfdi:Complemento>
</cfdi:Comprobante>`;
};
const seedInvoices = async (h, specs) => {
  const xmls = specs.map(spec => xmlCfdi(spec));
  const rows = xmls.map(xml => parseXml(Buffer.from(xml), DOMParser));
  const seed = await h.call('POST', '/api/storage', { batch: {
    people: [{ id: OWN, name: 'EMPRESA PROPIA SA' }, { id: BBB, name: 'PROVEEDOR SA' }],
    invoices: rows,
    files: xmls.map((xml, i) => ({ id: 'xml:' + rows[i].id, mime: 'application/xml',
      content: Buffer.from(xml).toString('base64') })) } });
  assert.equal(seed.status, 200);
  return rows;
};

/* ===== 5 · Login propio de administrador ===== */
{
  /* Sin configurar: la verdad, sin puerta falsa. */
  const h0 = makeHarness();
  const sin = await h0.call('POST', '/api/admin/login', { password: 'lo-que-sea' });
  assert.equal(sin.status, 403);
  assert.match(sin.json.error, /no está configurado/);
  let status = await h0.call('GET', '/api/status');
  assert.equal(status.json.adminLogin.configurado, false);

  /* Configurado como lo fijaría Paco: hash scrypt con su sal,
     SOLO en la configuración del servidor. */
  const h = makeHarness();
  const salt = randomBytes(16).toString('hex');
  const secreto = 'mi-clave-de-administrador';
  const hash = scryptSync(secreto, salt, 32).toString('hex');
  await h.service.bootstrap({ admin: { hash, salt } });
  status = await h.call('GET', '/api/status');
  assert.equal(status.json.adminLogin.configurado, true, 'Ajustes puede enseñar «configurado»');

  for (let i = 0; i < 5; i++) {
    const bad = await h.call('POST', '/api/admin/login', { password: 'incorrecta-' + i });
    assert.ok(bad.status >= 400 && bad.status < 500, 'la mala se rechaza');
    assert.match(bad.json.error, /Contraseña incorrecta/);
  }
  const locked = await h.call('POST', '/api/admin/login', { password: secreto });
  assert.equal(locked.status, 429, 'tras 5 fallos, ni la buena entra: bloqueo temporal');

  h.clock.t += 61 * 1000; /* el bloqueo crece y expira: 60 s el primero */
  const good = await h.call('POST', '/api/admin/login', { password: secreto });
  assert.equal(good.status, 200, 'pasado el bloqueo, la buena entra');
  const cookie = String(good.headers['Set-Cookie'] || '');
  assert.match(cookie, /^pacosat_admin=[0-9a-f]{48};/, 'cookie de sesión propia');
  assert.match(cookie, /HttpOnly/, 'la cookie es httpOnly');
  assert.match(cookie, /Secure/, 'y Secure tras el proxy HTTPS');

  /* La sesión autoriza SIN el token de la página. */
  const solo = await h.callSinToken('GET', '/api/status', undefined, { cookie });
  assert.equal(solo.status, 200, 'la sesión del login propio abre la puerta, en convivencia');
  const sesion = await h.callSinToken('GET', '/api/admin/session', undefined, { cookie });
  assert.equal(sesion.json.activa, true);
  const sinSesion = await h.callSinToken('GET', '/api/status');
  assert.ok(sinSesion.status >= 400, 'sin token ni sesión, la puerta sigue cerrada');

  /* Logout: la sesión muere de verdad. */
  const out = await h.callSinToken('POST', '/api/admin/logout', {}, { cookie });
  assert.equal(out.status, 200);
  const muerta = await h.callSinToken('GET', '/api/status', undefined, { cookie });
  assert.ok(muerta.status >= 400, 'tras cerrar sesión, la cookie ya no autoriza');
  console.log('OK 1.24.0 · 5 — login propio: verdad sin configurar, freno y bloqueo, cookie httpOnly, sesión sin token y logout real.');
}

/* ===== 1 · Buzón Tributario: lista sin abrir ===== */
{
  const dir = mkdtempSync(join(tmpdir(), 'pacosat-1240-trib-'));
  const dbFile = join(dir, 'pacosat.sqlite');
  const firmas = [];
  let bandeja = [
    { fecha: '2026-11-03', asunto: 'Requerimiento de información', remitente: 'Administración General de Auditoría', estado: 'No leída', abierta: false },
    { fecha: '2026-10-21', asunto: 'Invitación a regularizar', remitente: 'Recaudación', estado: 'Leída', abierta: true }];
  const motor = async (profile, query, opts) => {
    firmas.push([profile, query, Object.keys(opts || {})]);
    opts?.onStep?.('Acceso: e.firma verificada por el servidor', '');
    opts?.onStep?.('Bandeja leída', bandeja.length + ' notificaciones listadas sin abrir ninguna');
    return { notifications: bandeja };
  };
  const h = makeHarness({ dbFile, satTribFetch: motor });
  await unlock(h, OWN);
  const run1 = await h.call('POST', '/api/tributario/run', { rfc: OWN });
  assert.equal(run1.status, 200);
  assert.equal(run1.json.result.ok, true);
  assert.equal(run1.json.result.encontradas, 2);
  assert.equal(run1.json.result.sinAbrir, 1);
  /* El contrato del motor es solo-listar: se le llamó una vez con
     (perfil, consulta, {onStep}) y no existe operación de
     apertura en su superficie — la corrida no puede abrir. */
  assert.equal(firmas.length, 1);
  assert.deepEqual(Object.keys(firmas[0][1]), [], 'sin parámetros de apertura en la consulta');
  let view = await h.call('GET', '/api/tributario?rfc=' + OWN);
  assert.equal(view.json.total, 2);
  assert.equal(view.json.sinAbrir, 1);
  assert.equal(view.json.notificaciones.find(n => n.asunto.includes('Requerimiento')).abierta, false);
  assert.equal(view.json.runs.length, 1, 'el diario de la corrida queda guardado');
  assert.ok(view.json.runs[0].steps.some(s => /sin abrir/.test(s.paso + s.detalle)), 'el diario dice que no se abrió ninguna');
  let status = await h.call('GET', '/api/status');
  assert.equal(status.json.tributario[OWN].sinAbrir, 1, 'el contador de Hoy sale del servidor');
  /* El aviso espejo nace con el RFC puesto. */
  await h.service.tick();
  const db = new DatabaseSync(dbFile);
  const aviso = db.prepare("SELECT estado, rfc FROM avisos WHERE datos LIKE '%trib-sin-abrir%'").get();
  assert.ok(aviso && aviso.rfc === OWN, 'el aviso del buzón tributario lleva su RFC');

  /* Segunda consulta con la bandeja ya abierta en el portal: se
     actualiza el estado sin duplicar registros y el aviso se
     solventa solo. */
  bandeja = bandeja.map(n => ({ ...n, estado: 'Leída', abierta: true }));
  const run2 = await h.call('POST', '/api/tributario/run', { rfc: OWN });
  assert.equal(run2.json.result.sinAbrir, 0);
  view = await h.call('GET', '/api/tributario?rfc=' + OWN);
  assert.equal(view.json.total, 2, 'la misma notificación no se duplica');
  assert.equal(view.json.sinAbrir, 0);
  await h.service.tick();
  assert.notEqual(db.prepare("SELECT estado FROM avisos WHERE datos LIKE '%trib-sin-abrir%'").get().estado, 'abierto',
    'con 0 sin abrir, el aviso se solventa');

  /* Lo del portal se reintenta una vez; lo de credenciales, no. */
  let intentos = 0;
  const fragil = async () => { intentos++;
    if (intentos === 1) { const e = new Error('la plantilla no respondió como se esperaba'); e.code = 'respuesta-inesperada'; throw e; }
    return { notifications: [] }; };
  const h2 = makeHarness({ satTribFetch: fragil });
  await unlock(h2, OWN);
  const re = await h2.call('POST', '/api/tributario/run', { rfc: OWN });
  assert.equal(re.json.result.ok, true, 'el fallo de plantilla se reintenta y la corrida sale');
  assert.equal(intentos, 2);
  assert.equal(re.json.view.runs[0].attempts, 2, 'el diario registra los dos intentos');
  const h3 = makeHarness({ satTribFetch: async () => { const e = new Error('credencial rechazada'); e.code = 'credencial-invalida'; throw e; } });
  await unlock(h3, OWN);
  const fail = await h3.call('POST', '/api/tributario/run', { rfc: OWN });
  assert.equal(fail.json.result.ok, false);
  assert.equal(fail.json.result.errorKind, 'credencial-invalida');
  const sinPerfil = await h3.call('POST', '/api/tributario/run', { rfc: BBB });
  assert.equal(sinPerfil.status, 404, 'sin perfil no hay consulta que inventar');
  db.close();
  rmSync(dir, { recursive: true, force: true });
  console.log('OK 1.24.0 · 1 — Buzón Tributario: lista sin abrir, diario, deduplicación, aviso por RFC, reintento de portal y fallo con su clase.');
}

/* ===== 1b · Puerta y bandejas del mapa REA (sat-tributario) ===== */
{
  /* La puerta es la ruta oficial de «Mis notificaciones» en el
     PTSC (wwwmat), no el portal nuevo ni el patrón 53027 de la
     constancia: así lo documenta el propio SAT según el mapa. */
  assert.equal(BUZON_ENTRY_URL, 'https://wwwmat.sat.gob.mx/personas/login/mis-notificaciones');
  const tabla = [{ headers: ['Fecha', 'Asunto', 'Remitente', 'Estado'], rows: [
    ['03/11/2026', 'Requerimiento de información', 'Auditoría', 'No leída'],
    ['21/10/2026', 'Invitación a regularizar', 'Recaudación', 'Leída']] }];
  /* Sin bandeja: manda el estado de cada fila. */
  const libres = extractBuzonRows(tabla);
  assert.deepEqual(libres.map(r => r.abierta), [false, true]);
  /* En «Pendientes» manda la bandeja: todo sin abrir. */
  const pendientes = extractBuzonRows(tabla, false);
  assert.deepEqual(pendientes.map(r => r.abierta), [false, false]);
  /* En «Notificados» manda la bandeja: todo abierto. */
  const notificados = extractBuzonRows(tabla, true);
  assert.deepEqual(notificados.map(r => r.abierta), [true, true]);
  assert.equal(pendientes[0].fecha, '2026-11-03', 'la fecha se normaliza a ISO');
  assert.equal(extractBuzonRows([{ headers: ['Otra', 'Cosa'], rows: [['x', 'y']] }]), null,
    'sin encabezados de fecha+asunto+estado no se lista nada');
  console.log('OK 1.24.0 · 1b — puerta wwwmat de «Mis notificaciones» y bandejas Pendientes/Notificados del mapa REA.');
}

/* ===== 2 · Vigilancia activa con el corte de prescripción ===== */
{
  const dir = mkdtempSync(join(tmpdir(), 'pacosat-1240-vig-'));
  const dbFile = join(dir, 'pacosat.sqlite');
  const h = makeHarness({ dbFile });
  await unlock(h, OWN);
  const U2019 = '12400000-2019-4000-8000-000000002019';
  const U2021 = '12400000-2021-4000-8000-000000002021';
  const U2026 = '12400000-2026-4000-8000-000000002026';
  const UARC = '12400000-2026-4000-8000-000000009999';
  await seedInvoices(h, [
    { uuid: U2019, fecha: '2019-05-10T10:00:00', emisor: BBB, receptor: OWN, total: '1160.00' },
    { uuid: U2021, fecha: '2021-05-10T10:00:00', emisor: BBB, receptor: OWN, total: '1160.00' },
    { uuid: U2026, fecha: '2026-10-05T10:00:00', emisor: BBB, receptor: OWN, total: '2320.00' },
    { uuid: UARC, fecha: '2026-09-01T10:00:00', emisor: BBB, receptor: OWN, total: '580.00' }]);
  const db = new DatabaseSync(dbFile);
  db.prepare("UPDATE records SET archived=1 WHERE store='invoices' AND id=?").run(UARC.toLowerCase());
  const status = await h.call('GET', '/api/status');
  assert.equal(status.json.watchSummary.total, 2, 'vivos: 2021 y 2026 — ni el prescrito (2019) ni el archivado cuentan');
  assert.equal(status.json.watchSummary.porRevisar, 2);
  assert.equal(status.json.watchSummary.perRfc[OWN].total, 2, 'el conteo por RFC cuadra con el global');
  /* Coherencia con las demás pantallas en lo que comparten: lo
     ARCHIVADO no vive en Dinero ni en el Buzón (su salida de
     Dinero la ejecuta el cierre de línea base archivando — ronda
     1.23.0 —; la vigilancia, por orden de esta ronda, aplica
     además el corte de fecha directamente). */
  const money = await h.call('GET', '/api/money?rfc=' + OWN);
  assert.ok(!money.json.balances.some(b => b.id === UARC), 'lo archivado tampoco vive en Dinero');
  assert.ok(money.json.balances.some(b => b.id === U2021), 'el de 2021 sigue vivo en Dinero');
  const buzon = await h.call('GET', '/api/buzon?rfc=' + OWN);
  assert.ok(!buzon.json.items.some(item => item.uuid === UARC || item.uuid === UARC.toLowerCase()),
    'el Buzón tampoco enseña lo archivado');
  db.close();
  rmSync(dir, { recursive: true, force: true });
  console.log('OK 1.24.0 · 2 — vigilancia con corte: 2019 y lo archivado fuera del conteo vivo, por RFC y en global.');
}

/* ===== 3 · Correos por RFC (M3) ===== */
{
  const dir = mkdtempSync(join(tmpdir(), 'pacosat-1240-mail-'));
  const dbFile = join(dir, 'pacosat.sqlite');
  const h = makeHarness({ dbFile });
  await h.call('POST', '/api/mail', { host: 'smtp.test', port: 465, security: 'ssl',
    from: 'avisos@pacosat.test', recipient: 'paco@test.mx', user: 'u', password: 'p' });
  await unlock(h, OWN);
  await unlock(h, BBB);
  /* La primera evaluación de la base fija la línea base
     silenciosa (sin correos); los saldos de abajo nacen DESPUÉS,
     ya como trabajo vivo, que es lo que el resumen reparte. */
  await h.service.tick();
  /* Dos saldos vencidos, uno por contribuyente: el resumen debe
     salir partido en dos correos, cada uno con su RFC. Las
     facturas se siembran como registros con su fiscal (PPD), la
     forma en que la ingesta real los guarda. */
  const factura = (id, from, to, total) => ({ id, date: '2026-08-01', kind: 'I',
    from: { rfc: from, name: 'EMPRESA NEUTRA' }, to: { rfc: to, name: 'EMPRESA NEUTRA' },
    total, currency: 'MXN', fiscal: { paymentMethod: 'PPD', transferred: [], withheld: [] } });
  const seed = await h.call('POST', '/api/storage', { batch: {
    people: [{ id: OWN, name: 'EMPRESA PROPIA SA' }, { id: BBB, name: 'PROVEEDOR SA' }],
    invoices: [factura('12400000-2026-4000-8000-000000001111', BBB, OWN, '1160.00'),
      factura('12400000-2026-4000-8000-000000002222', OWN, BBB, '2320.00')] } });
  assert.equal(seed.status, 200);
  await h.service.tick();
  const resumenes = h.mails.filter(m => /Resumen de avisos/.test(String(m.subject || '')));
  assert.equal(resumenes.length, 2, 'un correo por contribuyente, no un agregado');
  const deOwn = resumenes.find(m => m.subject.includes(OWN));
  const deBbb = resumenes.find(m => m.subject.includes(BBB));
  assert.ok(deOwn && deBbb, 'cada asunto nombra su RFC');
  assert.ok(!String(deOwn.text).includes(BBB), 'el cuerpo de uno no mezcla al otro RFC');
  assert.ok(!String(deBbb.text).includes(OWN), 'ni al revés');
  /* Cada factura genera el aviso de SU contribuyente acreedor:
     la de 2,320 la cobra OWN y la de 1,160 la cobra BBB; cada
     correo trae solo el aviso (y el importe) de su RFC. */
  assert.ok(String(deOwn.text).includes('2,320.00') && !String(deOwn.text).includes('1,160.00'),
    'cada cuerpo trae SOLO los avisos de su contribuyente');
  assert.ok(String(deBbb.text).includes('1,160.00') && !String(deBbb.text).includes('2,320.00'),
    'y el otro, solo los suyos');
  assert.ok(String(deOwn.text).includes(OWN), 'el cuerpo identifica de quién habla');
  rmSync(dir, { recursive: true, force: true });
  console.log('OK 1.24.0 · 3 — correos por RFC: dos resúmenes, dos RFC, cero mezcla.');
}

/* ===== 6 · Ensayo de restauración invocable ===== */
{
  const dir = mkdtempSync(join(tmpdir(), 'pacosat-1240-restore-'));
  const dbFile = join(dir, 'pacosat.sqlite');
  const bakDir = join(dir, 'respaldos');
  const h = makeHarness({ dbFile });
  /* Sin respaldo configurado: la verdad. */
  const sinRespaldo = await h.call('POST', '/api/backup/restore-test', {});
  assert.ok(sinRespaldo.status >= 400 && /no está configurado/.test(sinRespaldo.json?.error || ''),
    'sin respaldo, el ensayo lo dice — no finge una resurrección');

  await unlock(h, OWN);
  await seedInvoices(h, [
    { uuid: '12400000-2026-4000-8000-000000003333', fecha: '2026-10-05T10:00:00', emisor: BBB, receptor: OWN, total: '2320.00' }]);
  await h.service.bootstrap({ backup: { password: 'respaldo-prueba-16', frequency: 'daily', dir: bakDir } });
  await h.service.tick();
  const conjuntos = readdirSync(bakDir).filter(name => name.endsWith('.faro'));
  assert.ok(conjuntos.length >= 1, 'el tick generó el conjunto de prueba');
  const vivasAntes = await h.call('GET', '/api/storage?store=invoices');
  const ensayo = await h.call('POST', '/api/backup/restore-test', {});
  assert.equal(ensayo.status, 200);
  assert.equal(ensayo.json.ok, true);
  assert.match(ensayo.json.detail, /La copia resucita: \d+ registros restaurados/);
  assert.match(ensayo.json.detail, /1 CFDI/, 'el ensayo cuenta lo resucitado de verdad');
  const vivasDespues = await h.call('GET', '/api/storage?store=invoices');
  assert.equal(JSON.stringify(vivasDespues.json).length, JSON.stringify(vivasAntes.json).length,
    'la base viva no se tocó: el ensayo vive en su espacio aislado');
  rmSync(dir, { recursive: true, force: true });
  console.log('OK 1.24.0 · 6 — ensayo de restauración: conjunto generado y resucitado en aislado, base viva intacta, verdad sin respaldo.');
}

/* ===== 4 + 10 · Carga diferida, peso y destinos nuevos ===== */
{
  const html = readFileSync(new URL('./Faro-Fiscal.html', import.meta.url), 'utf8');
  const lazy = JSON.parse(readFileSync(new URL('./lazy.json', import.meta.url), 'utf8'));
  /* La página inicial ya no carga las tres pantallas diferidas. */
  for (const fn of ['function pagosScreen', 'function salidasScreen', 'function bancosScreen'])
    assert.ok(!html.includes(fn), fn + ' viaja en su parte, no en la página inicial');
  for (const name of ['pagos', 'salidas', 'bancos']) {
    assert.ok(lazy.partes[name], 'la parte ' + name + ' consta en lazy.json');
    assert.ok(html.includes(lazy.partes[name].hash), 'la CSP de la página autoriza la huella de ' + name);
  }
  assert.ok(lazy.partes.pagos.source.includes('function pagosScreen'), 'la parte de Pagos trae su pantalla');
  /* Las rutas no se pierden: el mapa de pantallas y el menú
     conservan todos los destinos, y el nuevo consta con su
     contador. */
  assert.ok(html.includes('data-view="tributario"'), 'el menú tiene el destino Buzón Tributario');
  assert.ok(html.includes('id="tributario-badge"'), 'y su contador de sin abrir');
  assert.ok(html.includes("tributario: ['Buzón Tributario'"), 'la pantalla consta en el mapa');
  assert.ok(html.includes('tributario: tributarioScreen'), 'y se resuelve en el render');
  assert.ok(html.includes('function satApiLectura'), 'Hoy comparte sus lecturas por pintado');
  assert.ok(html.includes('PACOSAT_LAZY'), 'el manifiesto de partes viaja en la página');
  const pesoInicial = statSync(new URL('./Faro-Fiscal.html', import.meta.url)).size;
  const pesoPartes = Object.values(lazy.partes).reduce((sum, part) => sum + Buffer.byteLength(part.source), 0);
  /* La guardia de peso se re-basifica en la 1.27.0: nació como
     «menos que la 1.23.0» (569.448 B); la ronda visual (1.26.0)
     la dejó en 567.387 B y el frente de bajadas de la 1.27.0
     (descubrimiento de folios, plazo del buzón, evidencia en
     los diarios, Descansar confirmado) la lleva a ~570,7 KB.
     El techo de la casa es el de ronda1110/ronda1260: 572.000 B,
     y esta guardia queda alineada con él — un crecimiento
     futuro que lo cruce sigue siendo un fallo, no una sorpresa. */
  assert.ok(pesoInicial < 572000, 'la primera pintura bajo el techo de la casa (572.000 B): ' + pesoInicial + ' B');
  /* El servicio sirve las partes tras la misma puerta del proxy. */
  const h = makeHarness({ lazyParts: lazy });
  const parte = await h.call('GET', '/parte/pagos');
  assert.equal(parte.status, 200);
  assert.ok(parte.text.includes('function pagosScreen'), 'GET /parte/pagos sirve la pantalla de Pagos');
  const noHay = await h.call('GET', '/parte/inexistente');
  assert.equal(noHay.status, 404, 'una parte que no existe dice 404, no inventa código');
  console.log('OK 1.24.0 · 4/10 — carga diferida servida y sellada por huellas; peso inicial ' +
    pesoInicial + ' B, partes diferidas ' + pesoPartes + ' B, total ' + (pesoInicial + pesoPartes) + ' B.');
}

/* ===== 7 · Alta guiada de Elemental Denim ===== */
{
  const h = makeHarness();
  await unlock(h, OWN);
  const mala = await h.call('POST', '/api/profiles/prepare', { rfc: 'XXX' });
  assert.ok(mala.status >= 400, 'un RFC sin estructura válida se rechaza');
  const alta = await h.call('POST', '/api/profiles/prepare', { rfc: EDE });
  assert.equal(alta.status, 200);
  assert.equal(alta.json.pendiente, true);
  const status = await h.call('GET', '/api/status');
  assert.ok(status.json.pendingProfiles.includes(EDE), 'el directorio puede enseñar «faltan credenciales»');
  assert.ok(status.json.profiles.some(p => p.rfc === EDE), 'el perfil consta en el servidor');
  const satdocs = await h.call('GET', '/api/satdocs');
  const vistaEde = (satdocs.json.profiles || satdocs.json || []).find(v => v.rfc === EDE);
  assert.ok(vistaEde?.arranque, 'su tarjeta del Centro SAT trae la puesta en marcha');
  assert.equal(vistaEde.arranque.steps.find(p => p.id === 'credencial').done, false,
    'su puesta en marcha dice la verdad: falta la credencial');
  const otra = await h.call('POST', '/api/profiles/prepare', { rfc: EDE });
  assert.equal(otra.status, 200, 'prepararla dos veces no rompe ni duplica');
  console.log('OK 1.24.0 · 7 — alta guiada: perfil nacido en «faltan credenciales», sin datos inventados, idempotente.');
}

/* ===== 11 · Reenvío por correo desde el Buzón ===== */
{
  const dir = mkdtempSync(join(tmpdir(), 'pacosat-1240-fwd-'));
  const dbFile = join(dir, 'pacosat.sqlite');
  const h = makeHarness({ dbFile });
  await h.call('POST', '/api/mail', { host: 'smtp.test', port: 465, security: 'ssl',
    from: 'avisos@pacosat.test', recipient: 'paco@test.mx', user: 'u', password: 'p' });
  await h.service.tick(); /* línea base de avisos en vacío: silencio */
  const U1 = 'F1F1F1F1-1111-4111-8111-111111111111';
  const U2 = 'F2F2F2F2-2222-4222-8222-222222222222';
  const U3 = 'F3F3F3F3-3333-4333-8333-333333333333';
  const rows = await seedInvoices(h, [
    { uuid: U1, fecha: '2026-11-05T10:00:00', emisor: BBB, receptor: OWN, total: '1160.00', folio: 'F-101' },
    { uuid: U2, fecha: '2026-11-06T10:00:00', emisor: BBB, receptor: OWN, total: '2320.00', folio: 'F-102' },
    { uuid: U3, fecha: '2026-11-07T10:00:00', emisor: BBB, receptor: OWN, total: '580.00', folio: 'F-103' },
    { uuid: 'F9F9F9F9-9999-4999-8999-999999999999', fecha: '2026-11-05T10:00:00', emisor: BBB, receptor: 'CCC010101CC1', total: '100.00', folio: 'F-900' }]);
  const idOf = uuid => rows.find(row => row.id === uuid)?.id || uuid;
  /* El parseo ligero de la semilla no trae el desglose fiscal;
     en producción cada CFDI lo lleva persistido desde la
     importación. Se completa aquí como quedaría allí. */
  const folios = ['F-101', 'F-102', 'F-103', 'F-900'];
  const fiscalSeed = await h.call('POST', '/api/storage', { batch: { invoices:
    rows.map((row, i) => ({ ...row, fiscal: { ...(row.fiscal || {}), series: '', folio: folios[i], paymentMethod: 'PPD' } })) } });
  assert.equal(fiscalSeed.status, 200);
  /* El PDF del emisor de U1, vinculado como en el expediente. */
  const docSeed = await h.call('POST', '/api/storage', { batch: {
    documents: [{ id: 'pdf:emisor-u1', rfc: OWN, kind: 'Factura PDF', uuid: idOf(U1),
      name: 'Factura del emisor.pdf', date: '2026-11-05' }],
    files: [{ id: 'pdf:emisor-u1', mime: 'application/pdf', content: PDF.toString('base64') }] } });
  assert.equal(docSeed.status, 200);

  /* Manual: dos comprobantes, un correo por comprobante, con los
     datos que lo prueban y el RFC en el asunto (M3). */
  const fwd = await h.call('POST', '/api/buzon/forward',
    { rfc: OWN, ids: [idOf(U1), idOf(U2)], to: 'destino@test.mx' });
  assert.equal(fwd.status, 200);
  assert.equal(fwd.json.enviados, 2);
  const alDestino = h.mails.filter(mail => mail.to === 'destino@test.mx');
  assert.equal(alDestino.length, 2, 'un correo por comprobante, nunca un lote mezclado');
  const mailU1 = alDestino.find(mail => mail.subject.includes(idOf(U1)));
  assert.ok(mailU1.subject.includes('EMISOR SA') && mailU1.subject.includes('F-101') &&
    mailU1.subject.includes('AAA010101AAA'), 'el asunto prueba el comprobante y nombra su RFC');
  assert.equal(mailU1.attachments.length, 2, 'XML y PDF adjuntos');
  assert.ok(mailU1.attachments[0].filename.endsWith('.xml'));
  assert.ok(mailU1.attachments[1].content.equals(PDF), 'si el PDF del emisor llegó, viaja ese');
  const mailU2 = alDestino.find(mail => mail.subject.includes(idOf(U2)));
  assert.ok(mailU2.attachments[1].content.toString('latin1').startsWith('%PDF'),
    'sin PDF del emisor, viaja la representación impresa de PacoSAT');
  assert.ok(mailU2.text.includes('Folio fiscal (UUID): ' + idOf(U2)), 'el cuerpo lleva el UUID');

  /* El destino queda recordado por RFC; la sugerencia de Mano
     Fil solo existe para su RFC y solo sin destinos recordados. */
  let cfg = await h.call('GET', '/api/buzon/forward-config?rfc=' + OWN);
  assert.deepEqual(cfg.json.dests, ['destino@test.mx']);
  assert.equal(cfg.json.sugerencia, '');
  cfg = await h.call('GET', '/api/buzon/forward-config?rfc=MFI6212158B4');
  assert.equal(cfg.json.sugerencia, 'manofil@masfacturas.mx', 'la sugerencia consta en los documentos de Mano Fil');

  /* Lo de otro contribuyente no se mezcla jamás. */
  const ajeno = await h.call('POST', '/api/buzon/forward',
    { rfc: OWN, ids: [idOf('F9F9F9F9-9999-4999-8999-999999999999')], to: 'destino@test.mx' });
  assert.equal(ajeno.json.enviados, 0);
  assert.match(ajeno.json.resultados[0].error, /otro contribuyente/);
  assert.equal(h.mails.filter(mail => mail.to === 'destino@test.mx').length, 2, 'el ajeno no salió');
  const malCorreo = await h.call('POST', '/api/buzon/forward', { rfc: OWN, ids: [idOf(U1)], to: 'no-es-correo' });
  assert.ok(malCorreo.status >= 400, 'sin dirección válida no hay reenvío');

  /* Regla automática: el aviso de llegada lo dice y no se
     reenvía dos veces el mismo comprobante. */
  const setAuto = await h.call('POST', '/api/buzon/forward-config', { rfc: OWN, autoTo: 'auto@test.mx' });
  assert.equal(setAuto.status, 200);
  const db = new DatabaseSync(dbFile);
  const mkNotice = (opkey, uuid) => {
    const info = db.prepare('INSERT INTO news_notices(kind,opkey,rfc,direction,label,recipient,due) VALUES (?,?,?,?,?,?,?)')
      .run('sat', opkey, OWN, 'received', 'descarga de prueba', '', h.clock.t - 1000);
    db.prepare('INSERT INTO news_items(notice,uuid,fecha,counterpartName,counterpartRfc,folio,total,estado,kind,direction) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(Number(info.lastInsertRowid), uuid, '2026-11-07', 'PROVEEDOR SA', BBB, 'F-103', '580.00', 'vigente', 'I', 'received');
  };
  mkNotice('sat:auto:1', idOf(U3));
  await h.service.tick();
  const alAuto = h.mails.filter(mail => mail.to === 'auto@test.mx');
  assert.equal(alAuto.length, 1, 'la regla reenvía lo que llega, una vez');
  assert.ok(alAuto[0].subject.includes(idOf(U3)));
  const aviso = h.mails.find(mail => mail.to === 'paco@test.mx' && String(mail.text || '').includes('Reenvío automático'));
  assert.ok(aviso, 'el aviso de llegada DICE que se reenvió automáticamente');
  assert.ok(aviso.text.includes('auto@test.mx'));
  mkNotice('sat:auto:2', idOf(U3));
  await h.service.tick();
  assert.equal(h.mails.filter(mail => mail.to === 'auto@test.mx').length, 1,
    'el mismo comprobante no se reenvía dos veces en automático');
  const actividad = db.prepare("SELECT value FROM records WHERE store='activity'").all()
    .map(row => JSON.parse(row.value)).filter(row => String(row.event || '').includes('Reenviados'));
  assert.ok(actividad.length >= 2, 'cada reenvío queda en actividad (manual y automático)');
  db.close();
  rmSync(dir, { recursive: true, force: true });
  console.log('OK 1.24.0 · 11 — Reenvío: un correo por comprobante con XML y PDF (emisor o representación), asunto con RFC, destino recordado, sugerencia de Mano Fil, nada de otro RFC y regla automática que el aviso declara y no duplica.');
}

/* ===== 12 · Correcciones de la pasada de seguridad ===== */
{
  /* H-2.1 — el rescate del Buzón: solo enlaces de LISTA, fuera
     de tablas, jamás con pinta de detalle. */
  const lista = { text: 'Mis notificaciones', inTable: false,
    href: 'https://wwwmat.sat.gob.mx/personas/login/mis-notificaciones' };
  assert.equal(pickBuzonRescueLink([lista]), lista, 'un enlace de menú a la lista SÍ se sigue');
  assert.equal(pickBuzonRescueLink([{ ...lista, inTable: true }]), null,
    'el mismo enlace DENTRO de una tabla se ignora: ahí viven las notificaciones');
  const detalle = { text: 'Notificación: Requerimiento de información', inTable: false,
    href: 'https://wwwmat.sat.gob.mx/personas/notificacion/ver/202611030001' };
  assert.equal(pickBuzonRescueLink([detalle]), null, 'un enlace de detalle nunca se sigue');
  assert.equal(pickBuzonRescueLink([{ text: 'Ver notificación', inTable: false,
    href: 'https://wwwmat.sat.gob.mx/personas/login/mis-notificaciones?folio=ABC123' }]), null,
    'ni disfrazado de ruta de lista: el parámetro de folio lo delata');
  const menu = { text: 'Buzón Tributario', inTable: false,
    href: 'https://wwwmat.sat.gob.mx/personas/inicio' };
  assert.equal(pickBuzonRescueLink([menu]), menu, 'la etiqueta exacta de menú vale como rescate');
  assert.equal(pickBuzonRescueLink([{ text: 'Notificaciones recientes', inTable: false,
    href: 'https://wwwmat.sat.gob.mx/personas/inicio' }]), null,
    'una etiqueta parecida pero no exacta no basta');
  assert.equal(pickBuzonRescueLink([{ ...detalle, inTable: true }, { ...lista, inTable: true }, menu]), menu,
    'entre un detalle, una fila de tabla y el menú, el rescate elige el menú');

  /* H-5.1 — el arranque barre el scratch huérfano de un ensayo
     cortado a mitad; el recién tocado (otro proceso ensayando)
     se respeta. */
  const huerfano = mkdtempSync(join(tmpdir(), 'pacosat-restore-test-'));
  writeFileSync(join(huerfano, 'resucitada.sqlite'), 'expediente descifrado de mentira');
  const haceUnaHora = new Date(Date.now() - 60 * 60 * 1000);
  utimesSync(huerfano, haceUnaHora, haceUnaHora);
  const reciente = mkdtempSync(join(tmpdir(), 'pacosat-restore-test-'));
  makeHarness(); /* crear el servicio ES el arranque que barre */
  assert.ok(!existsSync(huerfano), 'el scratch huérfano desaparece al arrancar');
  assert.ok(existsSync(reciente), 'el scratch recién tocado no se toca');
  rmSync(reciente, { recursive: true, force: true });

  /* H-1.3 — la sal corta ya no configura el login propio. */
  for (const bytes of [8, 12]) {
    const h = makeHarness();
    const salCorta = randomBytes(bytes).toString('hex');
    const hashCorto = scryptSync('mi-clave-de-administrador', salCorta, 32).toString('hex');
    await h.service.bootstrap({ admin: { hash: hashCorto, salt: salCorta } });
    const status = await h.call('GET', '/api/status');
    assert.equal(status.json.adminLogin.configurado, false,
      'una sal de ' + bytes + ' bytes se trata como «no configurado»');
    const login = await h.call('POST', '/api/admin/login', { password: 'mi-clave-de-administrador' });
    assert.equal(login.status, 403);
    assert.match(login.json.error, /no está configurado/);
  }
  console.log('OK 1.24.0 · 12 — Pasada de seguridad: rescate solo-lista fuera de tablas (H-2.1), barrido de scratch huérfanos (H-5.1) y suelo de sal de 16 bytes (H-1.3).');
}

console.log('ronda1240.test.mjs: OK (5 login, 1 tributario, 2 vigilancia, 3 correos, 6 restauración, 4 velocidad, 7 alta guiada, 10 destinos, 11 reenvío, 12 seguridad)');
