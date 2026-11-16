/* ================================================================
   Ronda 2.0 · Tanda 5 — Revisión programada de facturas nuevas
   (Paco 13:34), «Ponte al día» (BER-GHON 3), ejecutor dormido
   (BER-GHON 2 / P14), vigía de solicitudes vivas (BER-GHON 4),
   vigía del sentido de la Opinión (A2), cruce 69-B/EFOS al
   descargar (A4), «Salud del SAT hoy» (20#9) y ráfaga del
   ejecutor al reconectar (O7).

   (a) Programación: fuera de su hora no nace; en su día/hora la
       corrida nace y la siguiente encadena su ventana EXACTA
       desde la última hecha (sin huecos); la próxima servida
       coincide con el resumen en llano.
   (b) «Ponte al día» sin ejecutor: tres líneas que lo dicen y
       no prometen descargas; con ejecutor vivo encola la puerta
       (foto vieja) y lanza la revisión.
   (c) Ejecutor dormido >24 h con trabajo en cola ⇒ un correo al
       día y un aviso que se cierra al volver; sin trabajos y con
       el ajuste por defecto ⇒ ninguno; con «siempre» ⇒ avisa.
   (d) Solicitud con 20 verificaciones ⇒ fila viva en el estado
       y en Salud; su salida crea la petición desplazada 1 s sin
       tocar la vieja.
   (e) Opinión NEGATIVA archivada ⇒ aviso el mismo día con los
       motivos SOLO si el documento los enumera (dos semillas);
       y aviso de caducidad a ≤7 días, una vez por opinión.
   (f) CFDI nuevo de emisor EFOS Definitivo ⇒ el correo de
       novedades lleva la advertencia pegada a ESE comprobante
       y no junto al limpio.
   (g) Salud del SAT: con un rechazo del SAT hoy ⇒ «con fallos»;
       sin actividad hoy ⇒ «sin datos de hoy todavía».
   (h) Ráfaga: el doble del protocolo vacía 3 trabajos tras la
       reconexión en <60 s simulados (un solo reclamo).
   ================================================================ */
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPacoSATService } from './local-server.mjs';
import { executorPollDelay200e, executorClaimLimit200e } from './ejecutor-local.mjs';

const ORIGIN = 'https://pacosat.test';
const KEY = 'f'.repeat(64);
const OWN = 'MFI6212158B4';
const OTRO = 'XAXX010101000';
const MALO = 'BBB010101BB2';
const LIMPIO = 'CCC010101CC3';
const DIA_MS = 86400000;

/* Parser de juguete (el de ronda200c) para la carpeta vigilada. */
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
const xmlCfdi = ({ uuid, fecha, total = '116.00', folio = '', emisor }) =>
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital" ' +
  'Version="4.0" Fecha="' + fecha + '" Moneda="MXN" Total="' + total + '" TipoDeComprobante="I"' +
  (folio ? ' Folio="' + folio + '"' : '') + '>' +
  '<cfdi:Emisor Rfc="' + emisor + '" Nombre="EMISOR DE JUGUETE"/>' +
  '<cfdi:Receptor Rfc="' + OWN + '" Nombre="RECEPTOR DE JUGUETE"/>' +
  '<cfdi:Complemento><tfd:TimbreFiscalDigital Version="1.1" UUID="' + uuid + '" FechaTimbrado="' + fecha + '"/></cfdi:Complemento>' +
  '</cfdi:Comprobante>';

function makeHarness(extra = {}, connectorExtra = {}) {
  let time = Date.parse('2026-11-13T15:00:00Z'); /* viernes 13 nov 2026, 09:00 MX */
  let token = '';
  let reqN = 0;
  const mails = [];
  const service = createPacoSATService({
    dbFile: ':memory:', html: '<html><head><!--PACOSAT_TOKEN--></head><body>prueba</body></html>',
    origin: ORIGIN, proxyKey: KEY, satDocRetryWaitMs: 5,
    makeConnector: () => ({ parser: FixtureParser, connector: {
      request: async () => 'req-e' + (++reqN),
      check: async () => ({ status: 'pending', packages: [] }),
      download: async () => { throw new Error('sin paquetes'); }, ...connectorExtra } }),
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
  const exec = async (method, path, body, execToken) => {
    const r = await raw(method, path, body, execToken ? { 'x-pacosat-executor': execToken } : {});
    let json = null; try { json = JSON.parse(r.text); } catch { /* binario */ }
    return { status: r.status, json, text: r.text };
  };
  return { service, call, raw, exec, mails,
    set time(v) { time = v; }, get time() { return time; } };
}
const setupMail = async h => {
  const mail = await h.call('POST', '/api/mail', { host: 'smtp.test', port: 465, security: 'ssl',
    from: 'avisos@pacosat.test', recipient: 'paco@test.mx', user: 'u', password: 'p' });
  assert.equal(mail.status, 200);
};
const seedPeople = async h => {
  const seed = await h.call('POST', '/api/storage', { batch: {
    people: [{ id: OWN, name: 'Mano Fil, S.A.' }, { id: OTRO, name: 'Otra, S.A.' }] } });
  assert.equal(seed.status, 200);
};
const unlock = async (h, rfc = OWN) => {
  const open = await h.call('POST', '/api/unlock', { rfc, minutes: 1440, days: 7,
    direction: 'both', password: 'simulated', certificate: 'YQ==', key: 'Yg==' });
  assert.equal(open.status, 200, 'unlock ' + rfc);
};
const emparejar = async h => {
  const par = await h.call('POST', '/api/executor/pair', { nombre: 'Equipo de Paco' });
  assert.equal(par.status, 200, 'emparejar ejecutor');
  return par.json.token;
};
const tarjeta = (salud, id) => (salud.tarjetas || []).find(t => t.id === id);

/* ===== (a) Revisión programada: horario, ventana sin huecos ===== */
{
  const h = makeHarness();
  try {
    await seedPeople(h); await unlock(h);
    const vista = await h.call('POST', '/api/revision/config', { enabled: true, dias: [5], hora: 10 });
    assert.equal(vista.status, 200);
    assert.equal(vista.json.resumen, 'Revisará tus facturas nuevas los viernes a las 10:00',
      'el resumen en llano servido es el prometido');
    assert.equal(vista.json.proxima, Date.parse('2026-11-13T16:00:00Z'),
      'la próxima corrida servida es hoy a las 10:00 MX');
    assert.equal(vista.json.proximaTexto, '13 nov, 10:00', 'y su texto coincide con el resumen');
    await h.service.tick(); /* 09:00: fuera de horario */
    let st = (await h.call('GET', '/api/status')).json;
    assert.equal(st.revision.porRfc.find(p => p.rfc === OWN).ultima, '',
      'fuera de horario la corrida NO nace (ni retroactiva al activar)');
    h.time = Date.parse('2026-11-13T16:05:00Z'); /* 10:05 MX: ya tocó */
    await h.service.tick();
    st = (await h.call('GET', '/api/status')).json;
    const ultima = st.revision.porRfc.find(p => p.rfc === OWN).ultima;
    assert.equal(ultima, '2026-11-13 10:05:00', 'en su día/hora la corrida nace y deja su marca');
    const registro = (await h.call('GET', '/api/registro')).json;
    assert.ok(JSON.stringify(registro).includes('Revisión de facturas nuevas (programada)'),
      'la corrida deja su entrada en el Registro');
    h.time += 2 * 3600000; /* 12:05 MX */
    const run2 = await h.call('POST', '/api/revision/run-now', {});
    const r2 = run2.json.resultados.find(r => r.rfc === OWN);
    assert.equal(r2.desde, ultima, 'sin huecos: la siguiente ventana abre EXACTA donde cerró la última');
    assert.equal(r2.hasta, '2026-11-13 12:05:00', 'y cierra en el ahora de su corrida');
    console.log('OK 2.0·T5 · (a) revisión programada — horario respetado, ventana sin huecos, próxima = resumen.');
  } finally { h.service.close(); }
}

/* ===== (b) «Ponte al día»: sin ejecutor y con ejecutor vivo ===== */
{
  const h = makeHarness();
  try {
    await seedPeople(h); await unlock(h);
    const r = await h.call('POST', '/api/ponte-al-dia', {});
    assert.equal(r.status, 200);
    assert.equal(r.json.lineas.length, 3, 'el resumen son TRES líneas');
    assert.match(r.json.lineas[0], /no hay equipo emparejado/, 'la línea de la puerta dice que no se pudo probar');
    assert.match(r.json.lineas[1], /^Cola:/, 'la segunda línea es la cola');
    assert.match(r.json.lineas[2], /^Facturas: revisión lanzada/, 'la tercera lanza la revisión');
    assert.ok(!/descargad/i.test(r.json.lineas.join(' ')), 'ninguna línea promete descargas terminadas');
    const registro = (await h.call('GET', '/api/registro')).json;
    assert.ok(JSON.stringify(registro).includes('Ponte al día:'), 'el resumen queda en el Registro');
    console.log('OK 2.0·T5 · (b1) Ponte al día sin ejecutor — tres líneas honestas, sin promesas.');
  } finally { h.service.close(); }
}
{
  const h = makeHarness({ executorMode: 'remote' });
  try {
    await seedPeople(h); await unlock(h);
    const tokenEjecutor = await emparejar(h);
    const latido = await h.exec('POST', '/api/executor/heartbeat', {}, tokenEjecutor);
    assert.equal(latido.status, 200);
    const r = await h.call('POST', '/api/ponte-al-dia', {});
    assert.match(r.json.lineas[0], /prueba encolada/, 'puerta con foto vieja (nunca probada): la prueba se encola');
    assert.match(r.json.lineas[1], /ofrecidos a tu equipo ahora/, 'la cola se ofrece al equipo vivo');
    assert.match(r.json.lineas[2], /revisión lanzada/, 'la revisión se lanza en el mismo toque');
    const overview = (await h.call('GET', '/api/executor/overview')).json;
    assert.ok(overview.trabajos.some(t => t.kind === 'puerta-probar' && t.estado === 'en-cola'),
      'la prueba de la puerta quedó en la cola del ejecutor');
    console.log('OK 2.0·T5 · (b2) Ponte al día con ejecutor vivo — puerta encolada + revisión lanzada.');
  } finally { h.service.close(); }
}

/* ===== (c) Ejecutor dormido: 1 correo/día, solo si hace falta ===== */
{
  const h = makeHarness({ executorMode: 'remote' });
  try {
    await setupMail(h); await seedPeople(h); await unlock(h);
    const tokenEjecutor = await emparejar(h);
    await h.exec('POST', '/api/executor/heartbeat', {}, tokenEjecutor);
    const enc = await h.call('POST', '/api/executor/jobs', { rfc: OWN, kind: 'buzon-listar', payload: {} });
    assert.equal(enc.status, 200, 'un trabajo queda en cola esperándolo');
    const dormidos = () => h.mails.filter(m => String(m.subject || '').includes('sin dar señales'));
    h.time += 25 * 3600000;
    await h.service.tick();
    assert.equal(dormidos().length, 1, '>24 h dormido con cola: UN correo de alerta');
    assert.match(dormidos()[0].text, /enciende tu PC y abre el ejecutor/, 'el correo trae el gesto único');
    let notices = (await h.call('GET', '/api/notices')).json;
    assert.ok(notices.avisos.some(a => a.kind === 'ejecutor-dormido' && a.estado === 'abierto'),
      'el aviso interno está abierto en Hoy');
    h.time += 24 * 3600000;
    await h.service.tick();
    assert.equal(dormidos().length, 2, 'sigue dormido: un correo por día, ni uno más');
    await h.exec('POST', '/api/executor/heartbeat', {}, tokenEjecutor);
    await h.service.tick();
    notices = (await h.call('GET', '/api/notices')).json;
    assert.ok(!notices.avisos.some(a => a.kind === 'ejecutor-dormido'),
      'al volver, el aviso deja de estar abierto en Hoy');
    assert.ok((notices.historial || []).some(a => a.kind === 'ejecutor-dormido' && a.estado === 'solventado'),
      'y consta solventado en el historial: se cerró solo');
    console.log('OK 2.0·T5 · (c1) dormido con cola — 1 correo/día, aviso que se cierra al volver.');
  } finally { h.service.close(); }
}
{
  const h = makeHarness({ executorMode: 'remote' });
  try {
    await setupMail(h); await seedPeople(h);
    const tokenEjecutor = await emparejar(h);
    await h.exec('POST', '/api/executor/heartbeat', {}, tokenEjecutor);
    h.time += 25 * 3600000;
    await h.service.tick();
    assert.equal(h.mails.filter(m => String(m.subject || '').includes('sin dar señales')).length, 0,
      'sin trabajos esperándolo y con el ajuste por defecto: ningún correo (no llorar sin motivo)');
    const notices = (await h.call('GET', '/api/notices')).json;
    assert.ok(!notices.avisos.some(a => a.kind === 'ejecutor-dormido'), 'ni aviso interno');
    await h.call('POST', '/api/salud/dormido', { siempre: true });
    await h.service.tick();
    assert.equal(h.mails.filter(m => String(m.subject || '').includes('sin dar señales')).length, 1,
      'con el ajuste en «siempre», el aviso sale aunque la cola esté vacía');
    console.log('OK 2.0·T5 · (c2) dormido sin cola — silencio por defecto; «siempre» avisa.');
  } finally { h.service.close(); }
}

/* ===== (d) Solicitud viva: fila y salida de +1 s ===== */
{
  const h = makeHarness();
  try {
    await seedPeople(h); await unlock(h);
    const creada = await h.call('POST', '/api/request',
      { rfc: OWN, start: '2026-11-08', end: '2026-11-13', direction: 'received' });
    assert.equal(creada.status, 200, 'la solicitud semilla nace');
    const job = creada.json.jobs.find(j => j.kind === 'cfdi' && j.periodStart === '2026-11-08');
    assert.ok(job, 'la solicitud consta en el estado');
    for (let i = 0; i < 20; i++) { h.time += 61 * 60000; await h.service.tick(); }
    const st = (await h.call('GET', '/api/status')).json;
    const viva = st.solicitudesVivas.find(v => v.id === job.id);
    assert.ok(viva, 'con 20 verificaciones la solicitud es «viva» en el estado de Hoy');
    assert.ok(viva.checks >= 15, 'el umbral de verificaciones se alcanzó: ' + viva.checks);
    assert.match(viva.texto, /no es cosa tuya ni de PacoSAT/, 'la fila lleva su semáforo en llano: del SAT');
    const salud = (await h.call('GET', '/api/salud')).json;
    assert.ok(tarjeta(salud, 'solicitudes-vivas').datos.vivas.some(v => v.id === job.id),
      'la misma fila vive en Salud (tarjeta de trabajos), sin duplicar el gesto');
    const r = await h.call('POST', '/api/solicitudes/repedir', { jobId: job.id });
    assert.equal(r.status, 200, 'la salida responde');
    assert.equal(r.json.ok, true);
    const dStart = Date.parse(r.json.startAt.replace(' ', 'T')) - Date.parse(viva.startAt.replace(' ', 'T'));
    const dEnd = Date.parse(r.json.endAt.replace(' ', 'T')) - Date.parse(viva.endAt.replace(' ', 'T'));
    assert.ok((dEnd === 1000 && dStart === 0) || (dStart === 1000 && dEnd === 0),
      'la petición nueva es el mismo tramo desplazado exactamente 1 s (start +' + dStart + ' ms, end +' + dEnd + ' ms)');
    const st2 = (await h.call('GET', '/api/status')).json;
    const vieja = st2.jobs.find(j => j.id === job.id);
    assert.equal(vieja.status, 'pending', 'la solicitud vieja NO se tocó: se sigue vigilando');
    assert.ok(st2.jobs.some(j => j.id === r.json.jobId && j.status === 'pending'), 'la nueva consta pendiente');
    console.log('OK 2.0·T5 · (d) solicitud viva — fila en Hoy y Salud; salida +1 s sin tocar la vieja.');
  } finally { h.service.close(); }
}

/* ===== (e) Opinión NEGATIVA: motivos solo del documento ===== */
const PDF_NEG_CON = Buffer.from('%PDF-1.4 Opinión de cumplimiento NEGATIVA. Motivos: ' +
  '1. No presentó la declaración anual del ejercicio 2025 ' +
  '2. Tiene un crédito fiscal firme pendiente de pago vigente hasta el 31 de diciembre de 2026');
const PDF_NEG_SIN = Buffer.from('%PDF-1.4 Opinión de cumplimiento NEGATIVA vigente hasta el 31 de diciembre de 2026');
const PDF_POS_CAD = Buffer.from('%PDF-1.4 Opinión de cumplimiento POSITIVA vigente hasta el 18 de noviembre de 2026');
{
  const h = makeHarness({ satDocFetch: async () => ({ content: PDF_NEG_CON, issuedAt: '2026-11-13', source: 'portal' }) });
  try {
    await setupMail(h); await seedPeople(h); await unlock(h);
    const run = await h.call('POST', '/api/satdocs/run', { rfc: OWN, kind: 'opinion' });
    assert.equal(run.json.results.opinion.ok, true, 'la opinión bajó');
    h.time += 60000; await h.service.tick();
    const alerta = h.mails.find(m => String(m.subject || '').includes('salió NEGATIVA'));
    assert.ok(alerta, 'el aviso de NEGATIVA salió el mismo día, sin retenerse');
    assert.ok(alerta.text.includes('No presentó la declaración anual del ejercicio 2025'),
      'el motivo 1 es el del documento, literal');
    assert.ok(alerta.text.includes('crédito fiscal firme'), 'el motivo 2 también');
    const notices = (await h.call('GET', '/api/notices')).json;
    assert.ok(notices.avisos.some(a => a.titulo?.includes('salió NEGATIVA') ||
      a.datos?.alertaKind === 'opinion-negativa'), 'el aviso interno existe (espejo de la alerta)');
    const docs = (await h.call('GET', '/api/satdocs')).json;
    const propio = docs.profiles.find(d => d.rfc === OWN);
    assert.equal(propio.opinion.sentido, 'negativa', 'la tarjeta de Documentos enseña el sentido sin abrir el PDF');
    assert.ok(propio.opinion.vigencia.includes('31 de diciembre de 2026'), 'y su vigencia');
    console.log('OK 2.0·T5 · (e1) opinión NEGATIVA con enumeración — aviso el mismo día con SUS motivos.');
  } finally { h.service.close(); }
}
{
  const h = makeHarness({ satDocFetch: async () => ({ content: PDF_NEG_SIN, issuedAt: '2026-11-13', source: 'portal' }) });
  try {
    await setupMail(h); await seedPeople(h); await unlock(h);
    const run = await h.call('POST', '/api/satdocs/run', { rfc: OWN, kind: 'opinion' });
    assert.equal(run.json.results.opinion.ok, true, 'la opinión bajó');
    h.time += 60000; await h.service.tick();
    const alerta = h.mails.find(m => String(m.subject || '').includes('salió NEGATIVA'));
    assert.ok(alerta, 'el aviso salió también sin enumeración legible');
    assert.ok(alerta.text.includes('salió negativa; el documento enumera sus motivos'),
      'sin enumeración legible: la frase de reserva, enlazando al documento');
    assert.ok(!alerta.text.includes('declaración anual'), 'jamás un motivo inventado');
    console.log('OK 2.0·T5 · (e2) opinión NEGATIVA sin enumeración — reserva honesta, cero invención.');
  } finally { h.service.close(); }
}
{
  const h = makeHarness({ satDocFetch: async () => ({ content: PDF_POS_CAD, issuedAt: '2026-11-13', source: 'portal' }) });
  try {
    await setupMail(h); await seedPeople(h); await unlock(h);
    const run = await h.call('POST', '/api/satdocs/run', { rfc: OWN, kind: 'opinion' });
    assert.equal(run.json.results.opinion.ok, true, 'la opinión bajó');
    await h.service.tick();
    const caduca = () => h.mails.filter(m => String(m.subject || '').includes('pierde vigencia'));
    assert.equal(caduca().length, 1, 'a 5 días de perder vigencia: el aviso nace');
    assert.match(caduca()[0].subject, /en 5 días/, 'y dice los días que le quedan');
    await h.service.tick();
    assert.equal(caduca().length, 1, 'una vez por opinión: no se repite');
    console.log('OK 2.0·T5 · (e3) caducidad de la Opinión a ≤7 días — una vez por opinión.');
  } finally { h.service.close(); }
}

/* ===== (f) Cruce 69-B/EFOS al descargar (bandeja) ===== */
{
  const dir = mkdtempSync(join(tmpdir(), 'pacosat-200e-watch-'));
  const fixtures = {
    '69b': 'Información actualizada al 09 de octubre de 2026\r\nNo.,RFC,Nombre del Contribuyente,Situación del contribuyente\r\n' +
      '1,' + MALO + ',PROVEEDOR MALO SA,Definitivo\r\n',
    '69b-bis': 'Información actualizada al 09 de octubre de 2026\r\nNo.,RFC,Nombre del Contribuyente,Situación del contribuyente\r\n'
  };
  const generic = () => 'RFC,RAZON SOCIAL,SUPUESTO,FECHA\r\nXXX010101XXX,OTRA SA,X,01/01/2025\r\n';
  const h = makeHarness({ watchDir: dir, inboxParser: FixtureParser, watchSettleMs: 0,
    listFetch: async source => fixtures[source.id] || generic() });
  try {
    await setupMail(h); await seedPeople(h); await unlock(h);
    await h.call('POST', '/api/lists/refresh', {});
    for (let i = 0; i < 120; i++) {
      const progress = (await h.call('GET', '/api/lists/progress')).json;
      if (!progress.running) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    writeFileSync(join(dir, 'malo.xml'), xmlCfdi({ uuid: '66666666-6666-4666-8666-666666666666',
      fecha: '2026-11-10T10:00:00', folio: '66', emisor: MALO }));
    writeFileSync(join(dir, 'limpio.xml'), xmlCfdi({ uuid: '77777777-7777-4777-8777-777777777777',
      fecha: '2026-11-11T10:00:00', folio: '77', emisor: LIMPIO }));
    await h.service.inboxTick(h.time);
    h.time += 3 * 60000; await h.service.tick();
    const correo = h.mails.find(m => String(m.subject || '').includes('Nuevos CFDI'));
    assert.ok(correo, 'salió el correo de novedades de la bandeja');
    const lineas = correo.text.split('\n');
    const iMalo = lineas.findIndex(l => l.includes('(' + MALO + ')'));
    const iLimpio = lineas.findIndex(l => l.includes('(' + LIMPIO + ')'));
    assert.ok(iMalo >= 0 && iLimpio >= 0, 'los dos comprobantes van en el correo');
    assert.ok(lineas[iMalo + 1].includes('lista 69-B') && lineas[iMalo + 1].includes('EFOS definitivo'),
      'la advertencia va PEGADA al comprobante del emisor EFOS');
    assert.ok(!(lineas[iLimpio + 1] || '').includes('69-B'), 'junto al comprobante limpio no hay advertencia');
    assert.equal((correo.text.match(/lista 69-B/g) || []).length, 1, 'una sola advertencia en todo el correo');
    assert.ok(correo.html.includes('lista 69-B'), 'el HTML lleva la misma advertencia');
    console.log('OK 2.0·T5 · (f) EFOS al descargar — marcado y advertencia junto a su comprobante.');
  } finally { h.service.close(); rmSync(dir, { recursive: true, force: true }); }
}

/* ===== (g) Salud del SAT hoy ===== */
{
  const h = makeHarness({}, { check: async () => ({ status: 'rejected', packages: [] }) });
  try {
    await seedPeople(h); await unlock(h);
    const creada = await h.call('POST', '/api/request',
      { rfc: OWN, start: '2026-11-10', end: '2026-11-13', direction: 'received' });
    assert.equal(creada.status, 200);
    h.time += 6 * 60000; await h.service.tick();
    const st = (await h.call('GET', '/api/status')).json;
    assert.equal(st.satHoy.estado, 'fallos', 'con un rechazo del SAT hoy, el estado lo nombra');
    assert.ok(st.satHoy.fallos.sat >= 1, 'el fallo se clasifica como del SAT');
    assert.match(st.satHoy.texto, /con fallos \(1 rechazo/, 'el texto en llano dice cuántos');
    const salud = (await h.call('GET', '/api/salud')).json;
    assert.equal(tarjeta(salud, 'sat-hoy').estado, 'mal', 'la tarjeta de Salud refleja el mismo estado');
    console.log('OK 2.0·T5 · (g1) salud del SAT — «con fallos» desde lo registrado hoy.');
  } finally { h.service.close(); }
}
{
  const h = makeHarness();
  try {
    await seedPeople(h);
    const st = (await h.call('GET', '/api/status')).json;
    assert.equal(st.satHoy.texto, 'El SAT hoy: sin datos de hoy todavía',
      'sin actividad registrada hoy: «sin datos», jamás un estado inventado');
    const salud = (await h.call('GET', '/api/salud')).json;
    assert.equal(tarjeta(salud, 'sat-hoy').estado, 'sin-dato');
    console.log('OK 2.0·T5 · (g2) salud del SAT sin datos — se dice, no se rellena.');
  } finally { h.service.close(); }
}

/* ===== (h) Ráfaga del ejecutor: vaciado en <60 s simulados ===== */
{
  assert.ok(executorPollDelay200e({ activos: 0, pendientes: 3 }) >= 2000 &&
    executorPollDelay200e({ activos: 0, pendientes: 3 }) <= 5000,
    'con cola pendiente, el sondeo entra en la banda de ráfaga (2–5 s)');
  assert.ok(executorPollDelay200e({ activos: 0, pendientes: 0 }) > 5000,
    'sin cola, vuelve el pulso de reposo');
  assert.ok(executorClaimLimit200e(3) >= 3, 'el reclamo pide al menos la cola anunciada');
  const h = makeHarness({ executorMode: 'remote' });
  try {
    await seedPeople(h); await unlock(h);
    const tokenEjecutor = await emparejar(h);
    for (const [kind, payload] of [['puerta-probar', {}], ['buzon-listar', {}],
      ['declaraciones-recuperar', { ejercicio: 2026, tipo: 'mensual' }]]) {
      const enc = await h.call('POST', '/api/executor/jobs', { rfc: OWN, kind, payload });
      assert.equal(enc.status, 200, 'trabajo en cola: ' + kind);
    }
    /* Reconexión tras la ausencia: el latido anuncia la cola y el
       doble reclama con la política de ráfaga hasta vaciarla,
       midiendo el tiempo simulado entre sondeos. */
    let simMs = 0;
    const latido = await h.exec('POST', '/api/executor/heartbeat', {}, tokenEjecutor);
    assert.equal(latido.json.pendientes, 3, 'el latido anuncia los 3 pendientes (protocolo O7)');
    let pendientes = latido.json.pendientes;
    let ciclos = 0;
    while (pendientes > 0 && ciclos < 10) {
      const claim = await h.exec('POST', '/api/executor/claim',
        { limit: executorClaimLimit200e(pendientes) }, tokenEjecutor);
      assert.equal(typeof claim.json.pendientes, 'number', 'el reclamo también anuncia los pendientes');
      for (const trabajo of claim.json.trabajos) {
        const res = await h.exec('POST', '/api/executor/result', { jobId: trabajo.id, status: 'failed',
          result: { steps: [{ at: 1, paso: 'Doble del protocolo', detalle: '' }],
            operations: ['entrar-con-efirma'], error: 'fallo simulado del doble', errorKind: 'red' } }, tokenEjecutor);
        assert.equal(res.status, 200, 'el resultado del doble se acepta');
      }
      pendientes = claim.json.pendientes;
      ciclos++;
      if (pendientes > 0) simMs += executorPollDelay200e({ activos: claim.json.trabajos.length, pendientes });
    }
    assert.equal(pendientes, 0, 'la cola quedó vacía');
    assert.equal(ciclos, 1, 'los 3 trabajos se reclamaron de una vez al reconectar');
    assert.ok(simMs < 60000, 'tiempo simulado de vaciado: ' + simMs + ' ms (<60 s)');
    const overview = (await h.call('GET', '/api/executor/overview')).json;
    assert.ok(!overview.trabajos.some(t => t.estado === 'en-cola'), 'no queda nada en cola');
    console.log('OK 2.0·T5 · (h) ráfaga O7 — 3 trabajos vaciados en ' + simMs + ' ms simulados, un reclamo.');
  } finally { h.service.close(); }
}

/* ===== Cliente: el botón de Hoy y las piezas diferidas ===== */
{
  const html = readFileSync(join(process.cwd(), 'Faro-Fiscal.html'), 'utf8');
  assert.ok(html.includes('Ponte al día'), 'el artefacto trae el botón «Ponte al día» de Hoy');
  assert.ok(html.includes('"version":"2.0.0"'), 'la versión NO cambia en la tanda 5');
  const saludPart = readFileSync(join(process.cwd(), 'salud-ui.part'), 'utf8');
  for (const texto of ['revisionPanel200e', 'Pedir ese tramo otra vez', 'ponteAlDia200e',
    'Revisión programada de facturas nuevas'])
    assert.ok(saludPart.includes(texto), 'la parte diferida de Salud trae «' + texto + '»');
  console.log('OK 2.0·T5 · cliente — botón en Hoy y piezas en la parte diferida.');
}
console.log('OK ronda200e — tanda 5 de la 2.0, fijada');
