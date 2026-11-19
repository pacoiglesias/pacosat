import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DOMParser } from '@xmldom/xmldom';
import { createPacoSATService } from './local-server.mjs';

/* ================================================================
   Ronda 2.4.0 · W2c — micro-cierres de «Enviar» y del Buzón
   completo. Cinco piezas, cada una con su porqué:
   1 · El espejo del ejecutor persiste las secciones del Buzón
       completo: una corrida espejo con secciones validadas
       deja trib_runs.secciones240 con su JSON y
       buzonCompleto240 la sirve igual que una local; una
       corrida espejo SIN secciones deja '' («no consta»).
   2 · Clase «formulario» en /api/enviar y «acuse» endurecida:
       la referencia cruzada se rechaza con su porqué y cada
       clase con su fila envía, con su rótulo correcto.
   3 · Clase «recordatorio» {uuid}: el servidor compone el
       cuerpo desde la factura reconciliada (emisor, folio,
       fecha, importe, saldo y días de atraso calculados en el
       servidor), sin adjunto; una factura que no es PPD sin
       REP vivo se rechaza honesto (400) y una que no existe,
       404.
   4 · Clase «cfdi-xml» {uuid}: adjunta el XML del almacén
       (record xml:<uuid>) con su nombre canónico; sin record,
       404 honesto.
   5 · El artefacto enseña los botones nuevos con su clase:
       formulario en Declaraciones, recordatorio en la tarjeta
       PPD, cfdi-xml/documento en ficha y fila de Facturas y
       reporte cierre-pdf/zip-cierre en «Generar todo».
   ================================================================ */

const ORIGIN = 'https://pacosat.test';
const KEY = 'c'.repeat(64);
const OWN = 'AAA010101AAA';
const PROV = 'BBB010101BB1';
const UUID_PPD = 'aaaaaaaa-1111-4111-8111-111111111111';
const UUID_PAGADA = 'bbbbbbbb-2222-4222-8222-222222222222';
const UUID_PUE = 'cccccccc-3333-4333-8333-333333333333';
const UUID_SIN_XML = 'dddddddd-4444-4444-8444-444444444444';
const AHORA = Date.parse('2026-11-16T15:00:00Z');
/* 2026-09-17 → 2026-11-16: 60 días de atraso con el reloj fijo. */
const SECC_COM = { concluyente: true,
  items: [{ fecha: '2026-11-05', asunto: 'Comunicado espejo', leido: false }],
  noLeidos: 1, leidos: 0, soloConteos: false };
const SECC_DOC = { concluyente: false, items: [],
  motivo: 'La bandeja de «Mis documentos» no cargó: no consta su contenido.' };

const dir = mkdtempSync(join(tmpdir(), 'pacosat-240enviar3-'));
const dbFile = join(dir, 'pacosat.sqlite');
const b64 = texto => Buffer.from(texto).toString('base64');
{
  const boot = createPacoSATService({ dbFile, html: 'x', origin: ORIGIN, proxyKey: KEY });
  boot.close();
  const seed = new DatabaseSync(dbFile);
  /* Declaraciones: un acuse y su formulario, con ids de fila
     DISTINTOS de sus fileId, como en la vista real. */
  seed.prepare("INSERT INTO declaraciones(id,rfc,tipo,clase,ejercicio,periodo,fechaPresentacion,operacion,fileId,source,created) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run('decl-acuse-1', OWN, 'mensual', 'acuse', 2026, '2026-10', '2026-11-15', '123456789', 'file-acuse-1', 'auto', AHORA);
  seed.prepare("INSERT INTO declaraciones(id,rfc,tipo,clase,ejercicio,periodo,fechaPresentacion,operacion,fileId,source,created) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run('decl-form-1', OWN, 'mensual', 'declaracion', 2026, '2026-10', '2026-11-15', '123456789', 'file-form-1', 'auto', AHORA);
  const file = seed.prepare("INSERT INTO records(store,id,value) VALUES ('files',?,?)");
  file.run('file-acuse-1', JSON.stringify({ content: b64('%PDF-1.4 ACUSE de juguete') }));
  file.run('file-form-1', JSON.stringify({ content: b64('%PDF-1.4 FORMULARIO de juguete') }));
  file.run('xml:' + UUID_PPD, JSON.stringify({ content: b64('<cfdi>xml de juguete</cfdi>') }));
  seed.close();
}

function makeHarness() {
  const mails = [];
  const service = createPacoSATService({
    dbFile, html: '<html><head><!--PACOSAT_TOKEN--></head><body>prueba</body></html>',
    origin: ORIGIN, proxyKey: KEY, satDocRetryWaitMs: 5, executorMode: 'remote',
    extractText: async () => '',
    makeConnector: () => ({ parser: DOMParser, connector: {
      request: async () => 'req-240c', check: async () => ({ status: 'finished', packages: [] }),
      download: async () => { throw new Error('sin paquetes'); } } }),
    makeMailer: () => ({ verify: async () => true,
      sendMail: async mail => { mails.push(mail); return { messageId: 'm' + mails.length }; } }),
    now: () => AHORA });
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
  const exec = async (method, path, body, execToken) => {
    const r = await raw(method, path, body, { 'x-pacosat-executor': execToken });
    let json = null; try { json = JSON.parse(r.text); } catch { /* binario */ }
    return { status: r.status, json, text: r.text };
  };
  return { service, call, exec, mails };
}
const invoice = (id, date, metodo, total) => ({ id, date, kind: 'I', currency: 'MXN', total,
  from: { rfc: PROV, name: 'Proveedor Uno' }, to: { rfc: OWN, name: 'Empresa Propia SA' },
  fiscal: { serie: 'A', folio: id === UUID_PPD ? '101' : '102', paymentMethod: metodo,
    transferred: [], withheld: [] } });

const h = makeHarness();
try {
  const mail = await h.call('POST', '/api/mail', { host: 'smtp.test', port: 465, security: 'ssl',
    from: 'avisos@pacosat.test', recipient: 'paco@test.mx', user: 'u', password: 'p' });
  assert.equal(mail.status, 200, 'correo configurado');
  const unlock = await h.call('POST', '/api/unlock', { rfc: OWN, minutes: 1440, days: 7,
    direction: 'both', password: 'simulated', certificate: 'YQ==', key: 'Yg==' });
  assert.equal(unlock.status, 200, 'unlock de ' + OWN);
  const seed = await h.call('POST', '/api/storage', { batch: {
    people: [{ id: OWN, name: 'Empresa Propia SA' }, { id: PROV, name: 'Proveedor Uno' }],
    invoices: [
      invoice(UUID_PPD, '2026-09-17', 'PPD', '1160.00'),
      invoice(UUID_PAGADA, '2026-10-01', 'PPD', '500.00'),
      invoice(UUID_PUE, '2026-10-02', 'PUE', '700.00'),
      { id: 'rep-pagada-1', kind: 'P', date: '2026-10-20', currency: 'XXX', total: '0.00',
        from: { rfc: PROV, name: 'Proveedor Uno' }, to: { rfc: OWN, name: 'Empresa Propia SA' },
        fiscal: { payments: { pagos: [{ fechaPago: '2026-10-20',
          documentos: [{ idDocumento: UUID_PAGADA, impPagado: '500.00' }] }] },
          transferred: [], withheld: [] } }] } });
  assert.equal(seed.status, 200, 'semilla: ' + seed.text);

  /* ===== 1 · Espejo del ejecutor con secciones ===== */
  {
    const par = await h.call('POST', '/api/executor/pair', { nombre: 'Equipo de Paco' });
    assert.equal(par.status, 200, 'ejecutor emparejado');
    const tokenEjecutor = par.json.token;
    const correrBuzon = async conSecciones => {
      const enc = await h.call('POST', '/api/executor/jobs', { rfc: OWN, kind: 'buzon-listar', payload: {} });
      assert.equal(enc.status, 200, 'trabajo del Buzón encolado');
      const claim = await h.exec('POST', '/api/executor/claim', { limit: 5 }, tokenEjecutor);
      const trabajo = claim.json.trabajos.find(t => t.id === enc.json.job.id);
      assert.ok(trabajo, 'el ejecutor reclama el trabajo');
      const result = { steps: [{ at: 1, paso: 'Acceso al portal OK', detalle: '' }],
        operations: ['entrar-con-efirma', 'navegar-a-lista', 'leer-lista'],
        notifications: [{ fecha: '2026-11-10', asunto: 'Requerimiento de información',
          remitente: 'Auditoría', estado: 'Pendiente', abierta: false }],
        comunicadosNoLeidos: 1, accesoOk: true,
        ...(conSecciones ? { comunicados: SECC_COM, documentos: SECC_DOC } : {}) };
      const res = await h.exec('POST', '/api/executor/result',
        { jobId: trabajo.id, status: 'done', result }, tokenEjecutor);
      assert.equal(res.json.ok, true, 'el resultado del ejecutor se acepta: ' + res.text);
      return trabajo.id;
    };
    await correrBuzon(true);
    const vista = (await h.call('GET', '/api/tributario?rfc=' + OWN)).json;
    assert.ok(vista.buzonCompleto240, 'buzonCompleto240 sirve la corrida del ejecutor');
    assert.deepEqual(vista.buzonCompleto240.comunicados, SECC_COM,
      'buzonCompleto240.comunicados = las secciones validadas del ejecutor');
    assert.deepEqual(vista.buzonCompleto240.documentos, SECC_DOC,
      'buzonCompleto240.documentos = las secciones validadas del ejecutor');
    const corrida = vista.runs.find(run => run.origen === 'ejecutor' && run.ok);
    assert.ok(corrida, 'la corrida espejo consta en el diario');
    assert.deepEqual(corrida.secciones240, { comunicados: SECC_COM, documentos: SECC_DOC },
      'la corrida espejo trae sus secciones en el diario servido');
    /* La fila cruda en trib_runs: el JSON persistido, no una vista. */
    const db = new DatabaseSync(dbFile);
    const fila = db.prepare("SELECT secciones240 FROM trib_runs WHERE origen='ejecutor' AND ok=1 ORDER BY rowid DESC LIMIT 1").get();
    db.close();
    assert.ok(fila?.secciones240, 'trib_runs.secciones240 no va vacío en la corrida espejo con secciones');
    assert.deepEqual(JSON.parse(fila.secciones240), { comunicados: SECC_COM, documentos: SECC_DOC },
      'trib_runs.secciones240 es el JSON de las secciones validadas');
    /* Sin secciones (réplica vieja): '' = no consta, y el
       buzonCompleto240 sigue sirviendo la corrida que sí las trajo. */
    await correrBuzon(false);
    const db2 = new DatabaseSync(dbFile);
    const fila2 = db2.prepare("SELECT secciones240 FROM trib_runs WHERE origen='ejecutor' AND ok=1 ORDER BY rowid DESC LIMIT 1").get();
    db2.close();
    assert.equal(fila2.secciones240, '', 'sin secciones validadas, la espejo deja \'\' (no consta), sin fingirlas');
    const vista2 = (await h.call('GET', '/api/tributario?rfc=' + OWN)).json;
    assert.deepEqual(vista2.buzonCompleto240.comunicados, SECC_COM,
      'buzonCompleto240 sigue sirviendo la última corrida buena CON secciones');
    console.log('OK 2.4.0·W2c (1) — espejo del ejecutor: secciones persistidas en trib_runs y servidas por buzonCompleto240; sin secciones, \'\'.');
  }

  /* ===== 2 · acuse / formulario: cruzada rechazada, cada uno envía ===== */
  {
    const antes = h.mails.length;
    const cruzadaA = await h.call('POST', '/api/enviar',
      { para: 'destino@ejemplo.mx', asunto: 'x', clase: 'acuse', id: 'decl-form-1' });
    assert.equal(cruzadaA.status, 400, '«acuse» con el id del formulario ⇒ 400');
    assert.match(cruzadaA.json.error, /no es un acuse.*formulario/i,
      'el rechazo de la cruzada dice su porqué: ' + cruzadaA.json.error);
    const cruzadaF = await h.call('POST', '/api/enviar',
      { para: 'destino@ejemplo.mx', asunto: 'x', clase: 'formulario', id: 'decl-acuse-1' });
    assert.equal(cruzadaF.status, 400, '«formulario» con el id del acuse ⇒ 400');
    assert.match(cruzadaF.json.error, /no es el formulario.*acuse/i,
      'el rechazo de la cruzada inversa dice su porqué: ' + cruzadaF.json.error);
    assert.equal(h.mails.length, antes, 'ninguna referencia cruzada envió nada');
    const okA = await h.call('POST', '/api/enviar',
      { para: 'destino@ejemplo.mx', asunto: 'Tu acuse', clase: 'acuse', id: 'decl-acuse-1' });
    assert.equal(okA.status, 200, '«acuse» con su fila envía: ' + okA.text);
    assert.match(okA.json.documento, /^Acuse de declaración/,
      'el acuse va rotulado como acuse: ' + okA.json.documento);
    assert.equal(Buffer.from(h.mails[h.mails.length - 1].attachments[0].content).toString('latin1'),
      '%PDF-1.4 ACUSE de juguete', 'el adjunto del acuse es SU fichero');
    const okF = await h.call('POST', '/api/enviar',
      { para: 'destino@ejemplo.mx', asunto: 'Tu formulario', clase: 'formulario', id: 'decl-form-1' });
    assert.equal(okF.status, 200, '«formulario» con su fila envía: ' + okF.text);
    assert.match(okF.json.documento, /^Formulario de declaración/,
      'el formulario va rotulado como formulario: ' + okF.json.documento);
    assert.equal(Buffer.from(h.mails[h.mails.length - 1].attachments[0].content).toString('latin1'),
      '%PDF-1.4 FORMULARIO de juguete', 'el adjunto del formulario es SU fichero');
    console.log('OK 2.4.0·W2c (2) — acuse/formulario: cruzadas rechazadas con su porqué; cada clase envía su fila con su rótulo.');
  }

  /* ===== 3 · recordatorio: el servidor compone; lo que no es PPD sin REP, fuera ===== */
  {
    const antes = h.mails.length;
    const ok = await h.call('POST', '/api/enviar',
      { para: 'proveedor@ejemplo.mx', asunto: 'Recordatorio de complemento de pago', clase: 'recordatorio', uuid: UUID_PPD });
    assert.equal(ok.status, 200, 'el recordatorio de la PPD viva envía: ' + ok.text);
    assert.equal(h.mails.length, antes + 1, 'salió un correo');
    const correo = h.mails[h.mails.length - 1];
    assert.ok(!correo.attachments || correo.attachments.length === 0,
      'el recordatorio va SIN adjunto');
    assert.ok(correo.text.includes('Hola, Proveedor Uno:'), 'el cuerpo se dirige al emisor de la factura');
    assert.ok(correo.text.includes('A-101'), 'el cuerpo nombra el folio calculado en el servidor');
    assert.ok(correo.text.includes('$1,160.00'), 'el cuerpo nombra el importe de la factura');
    assert.ok(correo.text.includes('60 días de atraso'),
      'el cuerpo nombra los días de atraso calculados en el servidor (reloj fijo): ' + correo.text);
    assert.ok(correo.text.includes('saldo de $1,160.00'), 'el cuerpo nombra el saldo reconciliado');
    assert.ok(correo.text.includes('17 de septiembre de 2026'), 'el cuerpo nombra la fecha de la factura');
    const pagada = await h.call('POST', '/api/enviar',
      { para: 'proveedor@ejemplo.mx', asunto: 'x', clase: 'recordatorio', uuid: UUID_PAGADA });
    assert.equal(pagada.status, 400, 'una PPD con su REP completo ya no es «PPD sin REP»: 400 honesto');
    assert.match(pagada.json.error, /ya no tiene saldo/, 'y lo dice: ' + pagada.json.error);
    const pue = await h.call('POST', '/api/enviar',
      { para: 'proveedor@ejemplo.mx', asunto: 'x', clase: 'recordatorio', uuid: UUID_PUE });
    assert.equal(pue.status, 400, 'una PUE no es PPD sin REP: 400 honesto');
    const ausente = await h.call('POST', '/api/enviar',
      { para: 'proveedor@ejemplo.mx', asunto: 'x', clase: 'recordatorio', uuid: UUID_SIN_XML });
    assert.equal(ausente.status, 404, 'una factura que no está en el expediente: 404 honesto');
    assert.equal(h.mails.length, antes + 1, 'los rechazos no enviaron nada');
    console.log('OK 2.4.0·W2c (3) — recordatorio compuesto en el servidor (folio/importe/saldo/60 días), sin adjunto; PPD pagada y PUE rechazadas.');
  }

  /* ===== 4 · cfdi-xml: el XML del almacén, con su nombre canónico ===== */
  {
    const ok = await h.call('POST', '/api/enviar',
      { para: 'destino@ejemplo.mx', asunto: 'Tu XML', clase: 'cfdi-xml', uuid: UUID_PPD });
    assert.equal(ok.status, 200, 'cfdi-xml con record en el almacén envía: ' + ok.text);
    const adjunto = h.mails[h.mails.length - 1].attachments[0];
    assert.equal(adjunto.filename, UUID_PPD + '.xml', 'el adjunto lleva su nombre canónico <uuid>.xml');
    assert.equal(Buffer.from(adjunto.content).toString('utf8'), '<cfdi>xml de juguete</cfdi>',
      'el adjunto ES el XML guardado en el almacén');
    const antes = h.mails.length;
    const sinXml = await h.call('POST', '/api/enviar',
      { para: 'destino@ejemplo.mx', asunto: 'x', clase: 'cfdi-xml', uuid: UUID_SIN_XML });
    assert.equal(sinXml.status, 404, 'sin record xml:<uuid> en el almacén: 404 honesto');
    const malo = await h.call('POST', '/api/enviar',
      { para: 'destino@ejemplo.mx', asunto: 'x', clase: 'cfdi-xml', uuid: '../../etc/passwd' });
    assert.equal(malo.status, 400, 'un uuid con forma de ruta: 400, jamás una lectura libre');
    assert.equal(h.mails.length, antes, 'los rechazos no enviaron nada');
    console.log('OK 2.4.0·W2c (4) — cfdi-xml adjunta el XML del almacén con su nombre canónico; sin record, 404.');
  }
} finally { h.service.close(); rmSync(dir, { recursive: true, force: true }); }

/* ===== 5 · El artefacto enseña los botones nuevos con su clase ===== */
{
  const html = readFileSync(join(import.meta.dirname, 'Faro-Fiscal.html'), 'utf8');
  const declaraciones = readFileSync(join(import.meta.dirname, 'declaraciones-ui.part'), 'utf8');
  const ui = readFileSync(join(import.meta.dirname, 'ui.part'), 'utf8');
  const workflows = readFileSync(join(import.meta.dirname, 'workflows.part'), 'utf8');
  /* Declaraciones: detalle y lista con su clase por doc.clase. */
  assert.equal((declaraciones.match(/clase: 'formulario', id: doc\.id/g) || []).length, 2,
    'detalle y lista completa cablean {clase:\'formulario\', id: doc.id}');
  /* RE-BASE integración 2.4.0 (W6): los cableados de formulario
     viven en la parte diferida de Declaraciones; se cuentan
     sobre artefacto + parte (lo que el navegador recibe en
     total) y el total esperado NO cambia: 2. */
  const lazyE3 = JSON.parse(readFileSync(join(import.meta.dirname, 'lazy.json'), 'utf8'));
  assert.equal(((html + lazyE3.partes.declaraciones.source).match(/clase: 'formulario', id: doc\.id/g) || []).length, 2,
    'el artefacto construido (+ su parte de Declaraciones) lleva los dos cableados de formulario');
  assert.equal((declaraciones.match(/clase: 'acuse', id: doc\.id/g) || []).length, 3,
    'los tres cableados de acuse de W4c siguen (grupo, detalle y lista): paridad');
  /* Tarjeta PPD: recordatorio por correo, sin la nota retirada. */
  assert.ok(ui.includes("correo: { clase: 'recordatorio', uuid: row.id }"),
    'la tarjeta PPD pasa su recordatorio a correo: {clase:\'recordatorio\', uuid}');
  assert.ok(html.includes("clase: 'recordatorio', uuid: row.id"), 'y el artefacto lo lleva');
  assert.ok(ui.includes("'Copiar recordatorio'") || ui.includes('Copiar recordatorio'),
    '«Copiar recordatorio» se queda en la tarjeta');
  /* Facturas: ficha y fila con cfdi-xml y documento Factura PDF. */
  assert.equal((workflows.match(/clase: 'cfdi-xml', uuid: row\.id/g) || []).length, 2,
    'ficha y fila cablean el «Enviar XML» con {clase:\'cfdi-xml\', uuid}');
  assert.ok(workflows.includes("correo: linked[0] ? { clase: 'documento', id: linked[0].id } : null"),
    'la ficha: el PDF del emisor usa el documento «Factura PDF» vinculado cuando existe');
  assert.ok(workflows.includes("correo: linkedPdfFila[0] ? { clase: 'documento', id: linkedPdfFila[0].id } : null"),
    'la fila: el mismo cableado del PDF por su documento vinculado');
  /* Generar todo: reporte y zip por la clase «reporte». */
  assert.ok(ui.includes("{ clase: 'reporte', tipo: 'cierre-pdf', rfc: scope || '', mes: monthInput.value }"),
    'el paso «reporte» de Generar todo va con {clase:\'reporte\', tipo:\'cierre-pdf\'}');
  assert.ok(ui.includes("{ clase: 'reporte', tipo: 'zip-cierre', rfc: scope || '', mes: monthInput.value }"),
    'el paso «zip» de Generar todo va con {clase:\'reporte\', tipo:\'zip-cierre\'}');
  console.log('OK 2.4.0·W2c (5) — el artefacto enseña formulario, recordatorio, cfdi-xml/documento y reporte cierre-pdf/zip-cierre con su clase.');
}

console.log('OK suite ronda240enviar3 completa');
