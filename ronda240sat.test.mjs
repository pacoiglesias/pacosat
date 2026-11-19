import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Readable } from 'node:stream';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DOMParser } from '@xmldom/xmldom';
import { createMonitor } from './sat-monitor.mjs';
import { createSatTribFetch, extractComunicadosRows, extractDocumentosRows,
  BUZON_COMUNICADOS_URL, BUZON_DOCUMENTOS_URL } from './sat-tributario.mjs';
import { createPacoSATService } from './local-server.mjs';

/* ================================================================
   Ronda 2.4.0 · WC1 — castigos 1–5 (SAT y descargas), lado
   servidor/motor. Todo con dobles de juguete: ningún portal vivo.
   1 · Cancelación detectada ⇒ aviso EN EL MOMENTO (monitor por
       cualquier vía de consulta + correo de suceso sin esperar
       al ciclo del servidor), con folio/emisor/importe.
   2 · Cuota: conteo por RFC del libro de criterios en la
       ventana móvil de 7 días y su renovación, con el campo
       nombrado como se declara (solicitudesEnVentana) y
       limiteSat null (el SAT no publica cuota numérica).
   3 · Constancia/Opinión programadas: misma fecha/sentido ⇒
       silencio + asiento discreto en el Registro; fecha
       cambiada ⇒ aviso llano interno, sin correo.
   4 · Buzón completo: la doble con tres bandejas devuelve las
       tres secciones; la de documentos caída ⇒ no concluyente
       con su porqué; CERO aperturas registradas.
   5 · Opinión que cambia de sentido ⇒ aviso URGENTE con la
       causa del propio documento, o «consta en el documento»
       cuando el documento no trae causa legible.
   ================================================================ */

const DAY = 86400000;
const RFC = 'MFI6212158B4';

/* ===== 1 · Monitor: el aviso sale al detectar, no en el tick ===== */
{
  const db = new DatabaseSync(':memory:');
  let estado = 'Vigente';
  const avisos = [];
  const monitor = createMonitor(db, { now: () => 1700000000000,
    checkSat: async () => ({ state: estado, code: 'S', cancellation: '', cancelable: '', efos: '' }),
    refreshEfos: async () => new Map(),
    notifyCancellation: async item => { avisos.push(item); return true; } });
  const cfdi = { id: '12345678-1234-1234-1234-1234567890AB', emitter: 'AAA010101AAA',
    receiver: RFC, total: '1234.00', seal: '' };
  monitor.register(cfdi);
  await monitor.processNow(10);
  assert.equal(monitor.status([cfdi.id]).results[0].sat.state, 'Vigente');
  assert.equal(avisos.length, 0, 'vigente: ningún aviso');
  estado = 'Cancelado';
  /* La vía forzada («Revisar ahora» de un comprobante, que
     re-consulta aunque ya tenga resultado) detecta la
     transición: el aviso debe existir AL VOLVER la llamada,
     sin que ningún tick haya recorrido la cola de alertas. */
  await monitor.checkOneNow(cfdi.id);
  assert.equal(avisos.length, 1, 'cancelación detectada ⇒ aviso en el momento, sin esperar al tick');
  assert.equal(avisos[0].id, cfdi.id, 'el aviso lleva el folio fiscal (UUID)');
  assert.equal(avisos[0].emitter, 'AAA010101AAA', 'el aviso lleva el emisor');
  assert.equal(avisos[0].total, '1234.00', 'el aviso lleva el importe');
  await monitor.tick();
  assert.equal(avisos.length, 1, 'el tick no repite el aviso ya enviado en el momento');
  db.close();
  console.log('OK WC1·1a — Monitor: transición por vía manual ⇒ aviso inmediato con UUID/emisor/importe; el tick no lo duplica.');
}
{
  /* Si el aviso del momento falla, la fila queda pendiente y
     el tick la recoge (red de seguridad), una sola vez. */
  const db = new DatabaseSync(':memory:');
  let estado = 'Vigente', intentos = 0;
  const monitor = createMonitor(db, { now: () => 1700000000000,
    checkSat: async () => ({ state: estado, code: 'S', cancellation: '', cancelable: '', efos: '' }),
    refreshEfos: async () => new Map(),
    notifyCancellation: async () => { intentos++; if (intentos === 1) throw new Error('canal caído de juguete'); return true; } });
  const cfdi = { id: '12345678-1234-1234-1234-1234567890AC', emitter: 'AAA010101AAA',
    receiver: RFC, total: '10.00', seal: '' };
  monitor.register(cfdi);
  await monitor.processNow(10);
  estado = 'Cancelado';
  await monitor.checkOneNow(cfdi.id);
  assert.equal(intentos, 1, 'el intento inmediato ocurrió al detectar');
  await monitor.tick();
  assert.equal(intentos, 2, 'el tick recoge la fila que el intento inmediato no pudo entregar');
  await monitor.tick();
  assert.equal(intentos, 2, 'y no vuelve a avisar: un evento, un aviso');
  db.close();
  console.log('OK WC1·1b — Monitor: fallo del aviso inmediato ⇒ el tick lo reintenta una vez, sin duplicar.');
}

/* ===== 4 · Buzón completo: tres bandejas, cero aperturas ===== */
const TABLA_NOTIF = [{ headers: ['Folio del acto administrativo', 'Autoridad emisora', 'Acto administrativo', 'Fecha de aviso'],
  rows: [['F-200', 'Auditoría', 'Requerimiento de información', '10/11/2026']] }];
const TABLA_COM = [{ headers: ['Fecha', 'Asunto', 'Estado'],
  rows: [['05/11/2026', 'Comunicado de prueba', 'No leído'], ['20/10/2026', 'Aviso informativo', 'Leído']] }];
const TABLA_DOC = [{ headers: ['Fecha', 'Documento', 'Estado'],
  rows: [['02/11/2026', 'Constancia de situación fiscal', 'Vigente']] }];
assert.deepEqual(extractComunicadosRows(TABLA_COM),
  [{ fecha: '2026-11-05', asunto: 'Comunicado de prueba', leido: false },
   { fecha: '2026-10-20', asunto: 'Aviso informativo', leido: true }],
  'el extractor de comunicados normaliza fecha y leído');
assert.deepEqual(extractDocumentosRows(TABLA_DOC),
  [{ fecha: '2026-11-02', nombre: 'Constancia de situación fiscal', estado: 'Vigente' }],
  'el extractor de documentos trae lo que la bandeja enseña');
assert.equal(extractComunicadosRows([{ headers: ['Columna'], rows: [['x']] }]), null,
  'sin encabezados de bandeja no hay lista fingida');
assert.equal(extractDocumentosRows([{ headers: ['Columna'], rows: [['x']] }]), null,
  'sin encabezados de bandeja no hay lista fingida (documentos)');
console.log('OK WC1·4a — Extractores puros: comunicados y documentos por encabezados; sin tabla reconocible, null.');

class BuzonCompletoDoble {
  constructor({ documentosCaidos = false } = {}) {
    this.documentosCaidos = documentosCaidos;
    this.etapa = 'aterrizaje';
    this.currentUrl = 'https://wwwmat.sat.gob.mx/buzon';
    this.gotos = []; this.clics = 0; this.aperturas = 0;
  }
  url() { return this.currentUrl; }
  async goto(url) {
    this.gotos.push(url); this.currentUrl = url;
    if (/abrir|detalle|ver-documento/i.test(url)) this.aperturas++;
    if (url.includes('mis-notificaciones')) this.etapa = 'bandeja';
    else if (url.includes('mis-comunicados')) this.etapa = 'comunicados';
    else if (url.includes('mis-documentos')) this.etapa = 'documentos';
  }
  texto() {
    if (this.etapa === 'bandeja') return 'Buzón Tributario · Destinatario: ' + RFC +
      ' · Total de notificaciones pendientes: 1';
    if (this.etapa === 'comunicados') return 'Mis comunicados · Mensajes no leídos (1) · Mensajes leídos (1)';
    if (this.etapa === 'documentos') return this.documentosCaidos
      ? 'Mis documentos · Se ha restablecido la conexión'
      : 'Mis documentos · Documentos del contribuyente';
    return 'BUZÓN TRIBUTARIO · Mis expedientes';
  }
  async text() { return this.texto(); }
  async evaluate(fn) {
    if (fn?.name === 'readAllTextSource') return this.texto();
    if (fn?.name === 'readLinksSource') return [];
    if (fn?.name === 'readTablesSource') {
      if (this.etapa === 'bandeja') return TABLA_NOTIF;
      if (this.etapa === 'comunicados') return TABLA_COM;
      if (this.etapa === 'documentos') return this.documentosCaidos ? [] : TABLA_DOC;
      return [];
    }
    return '';
  }
  async diagnostics() { return { url: this.currentUrl, html: '<html><body>doble</body></html>', screenshot: null }; }
  async clickTextExactoVisible() { this.clics++; return false; }
  async clickText() { this.clics++; return false; }
}
const resolverTrib = async profile => ({ rfc: profile.rfc, cer: Buffer.from('cer-de-juguete'),
  key: Buffer.from('key-de-juguete'), password: 'pw-de-juguete' });
{
  const page = new BuzonCompletoDoble();
  const trib = createSatTribFetch({ resolveCredentials: resolverTrib,
    launchDriver: async () => { throw new Error('con sesión viva no se lanza navegador'); },
    esperaBandejaMs: 3_000, documentosUrl: BUZON_DOCUMENTOS_URL });
  const resultado = await trib({ rfc: RFC }, {}, { sesionViva: { page } });
  assert.equal(resultado.notifications.length, 1, 'las notificaciones se listan como siempre');
  assert.equal(resultado.notifications[0].folio, 'F-200');
  assert.equal(resultado.notifications[0].abierta, false, 'la notificación sigue sin abrir');
  assert.equal(resultado.comunicadosNoLeidos, 1, 'el conteo de siempre se conserva');
  assert.equal(resultado.comunicados.concluyente, true, 'comunicados: sección concluyente');
  assert.deepEqual(resultado.comunicados.items,
    [{ fecha: '2026-11-05', asunto: 'Comunicado de prueba', leido: false },
     { fecha: '2026-10-20', asunto: 'Aviso informativo', leido: true }],
    'comunicados listados con fecha/asunto/leído');
  assert.equal(resultado.comunicados.noLeidos, 1);
  assert.equal(resultado.documentos.concluyente, true, 'documentos: sección concluyente');
  assert.deepEqual(resultado.documentos.items,
    [{ fecha: '2026-11-02', nombre: 'Constancia de situación fiscal', estado: 'Vigente' }],
    'documentos listados con lo que la bandeja enseña');
  assert.ok(page.gotos.some(url => url === BUZON_COMUNICADOS_URL), 'el paseo visitó «Mis comunicados»');
  assert.ok(page.gotos.some(url => url === BUZON_DOCUMENTOS_URL), 'el paseo visitó «Mis documentos»');
  assert.equal(page.aperturas, 0, 'NINGUNA apertura: ni notificaciones, ni mensajes, ni documentos');
  console.log('OK WC1·4b — Buzón completo: tres bandejas listadas, tres secciones en el resultado, cero aperturas.');
}
{
  const page = new BuzonCompletoDoble({ documentosCaidos: true });
  const trib = createSatTribFetch({ resolveCredentials: resolverTrib,
    launchDriver: async () => { throw new Error('con sesión viva no se lanza navegador'); },
    esperaBandejaMs: 3_000, documentosUrl: BUZON_DOCUMENTOS_URL });
  const resultado = await trib({ rfc: RFC }, {}, { sesionViva: { page } });
  assert.equal(resultado.documentos.concluyente, false,
    'documentos caídos ⇒ sección NO concluyente, no un cero fingido');
  assert.deepEqual(resultado.documentos.items, []);
  assert.match(resultado.documentos.motivo, /restablecido la conexión/i,
    'el motivo nombra la flaqueza conocida del portal: ' + resultado.documentos.motivo);
  assert.equal(resultado.comunicados.concluyente, true, 'comunicados sí concluyen en la misma corrida');
  assert.equal(page.aperturas, 0, 'ni con la bandeja caída se abrió nada');
  console.log('OK WC1·4c — Buzón completo: «Mis documentos» caída ⇒ no concluyente con su porqué.');
}

/* ===== Servicio: 1 (correo al momento), 2 (cuota), 3+5 (programadas), 4 (servido) ===== */
{
  const ORIGIN = 'https://pacosat.test';
  const KEY = 'k'.repeat(64);
  let time = Date.parse('2026-11-05T15:00:00Z');
  const sent = [];
  const requests = [];
  const estadosCfdi = new Map();
  const UUID_CANCEL = 'DDDDDDDD-0000-4000-8000-0000000000D1';
  estadosCfdi.set(UUID_CANCEL, 'Vigente');
  const POS = Buffer.from('%PDF-1.4 OPINION POSITIVA de juguete');
  const NEG = Buffer.from('%PDF-1.4 OPINION NEGATIVA. Motivos de la opinión: ' +
    '1. Omisión de la declaración mensual de octubre de 2026 ' +
    '2. Adeudo de un crédito fiscal firme por contribuciones retenidas no enteradas. Fin.');
  const guion = { constancia: { content: Buffer.from('%PDF-1.4 CONSTANCIA de juguete'), issuedAt: '2026-11-05T15:00:00Z' },
    opinion: { content: POS, issuedAt: '2026-11-05T15:00:00Z' } };
  const seccionesTrib = { comunicados: { concluyente: true,
      items: [{ fecha: '2026-11-05', asunto: 'Comunicado de juguete', leido: false }],
      noLeidos: 1, leidos: 0, soloConteos: false },
    documentos: { concluyente: false, items: [], motivo: 'La bandeja no cargó de juguete: no consta.' } };
  const service = createPacoSATService({ dbFile: ':memory:', html: '<!--PACOSAT_TOKEN-->', origin: ORIGIN,
    proxyKey: KEY, now: () => time, satDocRetryWaitMs: 5,
    efirmaDir: mkdtempSync(join(tmpdir(), 'pacosat-240sat-')),
    makeConnector: () => ({ parser: DOMParser, connector: {
      request: async args => { requests.push(args); return 'req-240sat-' + requests.length; },
      check: async () => ({ status: 'pending', packages: [] }),
      download: async () => { throw new Error('sin paquetes'); } } }),
    makeMailer: () => ({ verify: async () => true, sendMail: async payload => { sent.push(payload); } }),
    monitorOptions: { checkSat: async item => ({ state: estadosCfdi.get(item.id) || 'Vigente',
      code: 'S', cancellation: '', cancelable: '', efos: '' }),
      refreshEfos: async () => new Map() },
    satTribFetch: async () => ({ notifications: [], comunicadosNoLeidos: 1, ...seccionesTrib }),
    satDocFetch: async (profile, kind) => ({ content: guion[kind].content,
      issuedAt: guion[kind].issuedAt, fileName: kind + '.pdf' }) });
  let token = '';
  const raw = async (method, path, body, extra = {}) => {
    const chunks = []; if (body !== undefined) chunks.push(Buffer.from(JSON.stringify(body)));
    const req = Readable.from(chunks);
    req.method = method; req.url = path;
    req.headers = { host: 'pacosat.test', origin: ORIGIN, 'x-pacosat-proxy': KEY, ...extra };
    let status = 0; let out = '';
    const res = { setHeader() {}, writeHead(code) { status = code; },
      end(chunk) { if (chunk) out += Buffer.isBuffer(chunk) ? chunk.toString('latin1') : chunk; } };
    await service.handle(req, res);
    return { status, text: out };
  };
  const call = async (method, path, body) => {
    if (!token) { const home = await raw('GET', '/'); token = /[0-9a-f]{64}/.exec(home.text)?.[0] || ''; }
    const r = await raw(method, path, body, { 'x-pacosat-token': token });
    let json = null; try { json = JSON.parse(r.text); } catch { /* binario */ }
    return { status: r.status, json, text: r.text };
  };
  try {
    let res = await call('POST', '/api/unlock', { rfc: RFC, minutes: 1440, days: 30,
      direction: 'received', password: 'simulated', certificate: 'YQ==', key: 'Yg==' });
    assert.equal(res.status, 200, 'unlock del RFC de juguete');
    res = await call('POST', '/api/mail', { host: 'smtp.example.com', port: 587, user: 'u',
      password: 'p', from: 'from@example.com', recipient: 'avisos@example.com' });
    assert.equal(res.status, 200);
    res = await call('POST', '/api/monthly/config', { enabled: false, day: 5, hour: 9 });
    assert.equal(res.status, 200);
    res = await call('POST', '/api/satdocs/config', { rfc: RFC, enabled: true, day: 5, hour: 9, recipients: '' });
    assert.equal(res.status, 200);
    res = await call('POST', '/api/monitor', { records: [{ id: UUID_CANCEL,
      emitter: 'AAA010101AAA', receiver: RFC, total: '1234.00', seal: '' }], ids: [] });
    assert.equal(res.status, 200);

    /* El ajuste maestro nace encendido y viaja en el estado. */
    let status = (await call('GET', '/api/status')).json;
    assert.equal(status.settings.satdocsProgramadas240.enabled, true,
      'el on/off de programadas nace encendido en status.settings');

    /* Primer ciclo: descargas programadas (cuota) + documentos
       programados (primera copia: sin aviso por cambio). */
    const peticionesAntes = requests.length;
    await service.monitorTick(time);
    await service.tick();
    const peticionesCiclo = requests.length - peticionesAntes;
    assert.ok(peticionesCiclo >= 2, 'el ciclo envió solicitudes al SAT de juguete: ' + peticionesCiclo);

    /* --- 2 · Cuota --- */
    status = (await call('GET', '/api/status')).json;
    const cuota = status.cuotaDescargas240;
    assert.ok(cuota, 'el estado sirve cuotaDescargas240');
    assert.equal(cuota.limiteSat, null, 'limiteSat null: el SAT no publica cuota numérica que conste');
    assert.match(cuota.definicion, /no publica una cuota/i, 'la definición lo declara');
    const miCuota = cuota.porRfc[RFC];
    assert.ok(miCuota, 'la cuota va por RFC');
    assert.equal(miCuota.solicitudesEnVentana, peticionesCiclo,
      'el conteo de la ventana es el de solicitudes realmente enviadas en el ciclo (libro de criterios)');
    assert.equal(miCuota.solicitudesEnVentana, miCuota.porTipo.cfdi + miCuota.porTipo.metadata,
      'el desglose por tipo suma el total');
    assert.equal(miCuota.seRenuevaEn, time + 7 * DAY,
      'la ventana se renueva cuando su solicitud más antigua sale de ella (+7 días)');
    assert.equal(miCuota.semaforo, 'verde', 'sin 5002 ni criterios al límite: verde');
    time += 8 * DAY;
    status = (await call('GET', '/api/status')).json;
    assert.equal(status.cuotaDescargas240.porRfc[RFC].solicitudesEnVentana, 0,
      'pasada la ventana, el conteo es cero sin enviar nada nuevo');
    assert.equal(status.cuotaDescargas240.porRfc[RFC].seRenuevaEn, null,
      'sin solicitudes en la ventana no hay renovación que fechar');
    console.log('OK WC1·2 — Cuota: conteo por RFC del libro, renovación +7 días, limiteSat null y definición escrita.');

    /* --- 4 · Buzón completo servido --- */
    res = await call('POST', '/api/tributario/run', { rfc: RFC });
    assert.equal(res.status, 200);
    const vistaTrib = (await call('GET', '/api/tributario?rfc=' + RFC)).json;
    assert.ok(vistaTrib.buzonCompleto240, 'el panorama del Buzón sirve buzonCompleto240');
    assert.equal(vistaTrib.buzonCompleto240.comunicados.items[0].asunto, 'Comunicado de juguete');
    assert.equal(vistaTrib.buzonCompleto240.documentos.concluyente, false,
      'la sección caída viaja como no concluyente, no como cero');
    assert.match(vistaTrib.buzonCompleto240.documentos.motivo, /no consta/);
    console.log('OK WC1·4d — Servidor: buzonCompleto240 en el panorama del Buzón con sus dos secciones.');

    /* --- 1 · Correo de cancelación EN EL MOMENTO (vía check-one) --- */
    estadosCfdi.set(UUID_CANCEL, 'Cancelado');
    const correosAntes = sent.length;
    res = await call('POST', '/api/monitor/check-one', { uuid: UUID_CANCEL });
    assert.equal(res.status, 200);
    const correoCancel = sent.slice(correosAntes)
      .find(mail => /CFDI cancelado/.test(String(mail.subject)));
    assert.ok(correoCancel,
      'el correo de cancelación salió en la misma llamada que la detectó, sin ciclo del servidor');
    assert.ok(String(correoCancel.subject).includes('$1,234.00'),
      'el asunto lleva el importe: ' + correoCancel.subject);
    assert.ok(String(correoCancel.subject).includes('AAA010101AAA'),
      'el asunto lleva el emisor: ' + correoCancel.subject);
    assert.ok(String(correoCancel.text).includes(UUID_CANCEL), 'el cuerpo lleva el folio fiscal');
    console.log('OK WC1·1c — Servidor: check-one detecta la cancelación y su correo sale en el momento, con importe y emisor.');

    /* --- 3 · Programadas sin cambio: silencio + Registro --- */
    time = Date.parse('2026-12-05T15:00:00Z');
    const correosDic = sent.length;
    await service.tick();
    assert.equal(sent.slice(correosDic).filter(mail => /URGENTE|renovada/.test(String(mail.subject))).length, 0,
      'misma fecha y mismo sentido: ningún aviso por cambio');
    const registro = (await call('GET', '/api/registro?texto=' +
      encodeURIComponent('sin cambios'))).json;
    assert.ok((registro.items || []).some(item => /sin cambios/.test(item.texto) && item.rfc === RFC),
      'el asiento discreto quedó en el Registro');
    console.log('OK WC1·3a — Programadas: sin cambio ⇒ sin aviso y asiento discreto en el Registro.');

    /* --- 5 · Cambio de sentido ⇒ URGENTE con la causa del documento --- */
    guion.opinion = { content: NEG, issuedAt: '2027-01-05T15:00:00Z' };
    guion.constancia = { content: guion.constancia.content, issuedAt: '2027-01-05T15:00:00Z' };
    time = Date.parse('2027-01-05T15:00:00Z');
    const correosEne = sent.length;
    await service.tick();
    const urgentes = sent.slice(correosEne).filter(mail => /URGENTE/.test(String(mail.subject)));
    assert.equal(urgentes.length, 1, 'un solo aviso urgente por el cambio de sentido');
    assert.ok(urgentes[0].subject.includes('POSITIVA') && urgentes[0].subject.includes('NEGATIVA'),
      'el asunto nombra el cambio de sentido: ' + urgentes[0].subject);
    assert.ok(urgentes[0].text.includes('Omisión de la declaración mensual de octubre de 2026'),
      'la causa sale del propio documento: ' + urgentes[0].text.slice(0, 400));
    assert.equal(sent.slice(correosEne).filter(mail => /renovada/.test(String(mail.subject))).length, 0,
      'el cambio de fecha de la Constancia es aviso llano interno: no sale correo «renovada»');
    console.log('OK WC1·5a — Opinión POSITIVA→NEGATIVA ⇒ urgente con la obligación-causa del documento.');

    /* --- 5b · Sin causa legible ⇒ «consta en el documento» --- */
    guion.opinion = { content: POS, issuedAt: '2027-02-05T15:00:00Z' };
    guion.constancia = { content: guion.constancia.content, issuedAt: '2027-02-05T15:00:00Z' };
    time = Date.parse('2027-02-05T15:00:00Z');
    const correosFeb = sent.length;
    await service.tick();
    const urgentes2 = sent.slice(correosFeb).filter(mail => /URGENTE/.test(String(mail.subject)));
    assert.equal(urgentes2.length, 1, 'el cambio de vuelta también avisa urgente');
    assert.ok(urgentes2[0].subject.includes('NEGATIVA') && urgentes2[0].subject.includes('POSITIVA'));
    assert.ok(urgentes2[0].text.includes('consta en el documento'),
      'sin causa legible en el documento, el aviso lo dice y no inventa ninguna');
    console.log('OK WC1·5b — Opinión NEGATIVA→POSITIVA ⇒ urgente con «consta en el documento», sin causa inventada.');

    /* --- 3b · El on/off maestro por POST /api/settings --- */
    res = await call('POST', '/api/settings', { satdocsProgramadas240: { enabled: false } });
    assert.equal(res.status, 200);
    status = (await call('GET', '/api/status')).json;
    assert.equal(status.settings.satdocsProgramadas240.enabled, false, 'el ajuste apagado viaja en el estado');
    const vistaDocs = (await call('GET', '/api/satdocs')).json;
    const corridasAntes = vistaDocs.profiles[0].runs.length;
    guion.opinion = { content: NEG, issuedAt: '2027-03-05T15:00:00Z' };
    time = Date.parse('2027-03-05T15:00:00Z');
    await service.tick();
    const vistaDocs2 = (await call('GET', '/api/satdocs')).json;
    assert.equal(vistaDocs2.profiles[0].runs.length, corridasAntes,
      'con el maestro apagado, la programada no corre en su fecha');
    res = await call('POST', '/api/settings', { satdocsProgramadas240: { enabled: true } });
    assert.equal(res.status, 200);
    status = (await call('GET', '/api/status')).json;
    assert.equal(status.settings.satdocsProgramadas240.enabled, true, 'y se vuelve a encender por la misma vía');
    console.log('OK WC1·3b — Programadas: on/off maestro servido en status y por POST /api/settings.');
  } finally { await service.close(); }
}

console.log('OK suite ronda240sat completa');
