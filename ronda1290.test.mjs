/* Ronda 1.29.0 — ejecutor local del SAT, papelera con lápidas,
   pagos por vencimientos y diseño navegable (12 nov 2026,
   con las adendas de papelera y de Totales del mismo día).
   Se juzga:
   - PROTOCOLO: lista cerrada de operaciones (sin apertura de
     notificaciones), rechazo de credenciales en trabajos y
     resultados, verificación de documentos (PDF de verdad +
     operación + periodo) y clasificación local del Buzón.
   - EJECUTOR: modo remoto — Buzón y Declaraciones encolan y
     quedan «esperando tu equipo» (acción en el Registro, no
     fallo); emparejar → reclamar → devolver verificado →
     archivar; deduplicación; arriendo que caduca; resultado
     inválido que no archiva nada.
   - BUZÓN: vista de atención, informativos auto-archivados que
     la sincronización no resucita, papelera con deshacer y
     purga con lápida que la sincronización reconoce.
   - PAGOS: vencimientos solo desde líneas respaldadas, cruce
     contra el banco, preparar sin duplicar ni pagar.
   - DISEÑO (estático): menú reagrupado, barra móvil, papelera
     y su límite honesto en la cara, «Preparar pagos» y nunca
     «Pagar todo», Totales por años con detalle navegable. */
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DOMParser } from '@xmldom/xmldom';
import { createPacoSATService } from './local-server.mjs';
import { buildExecutorJob, validateExecutorResult, verifyDeclarationDocument, classifyBuzonRow } from './sat-executor.mjs';

const ORIGIN = 'https://pacosat.test';
const KEY = 'f'.repeat(64);
const OWN = 'AAA010101AAA';
const ROOT = import.meta.dirname;
const read = name => readFileSync(join(ROOT, name), 'utf8');
const PDF_OK = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(300, 0x41)]);
const PDF_B64 = PDF_OK.toString('base64');

function makeHarness(options = {}) {
  const clock = { t: Date.parse('2026-11-12T14:00:00Z') };
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
  const exec = async (method, path, body, execToken) => {
    const r = await raw(method, path, body, execToken ? { 'x-pacosat-executor': execToken } : {});
    let json = null; try { json = JSON.parse(r.text); } catch { /* binario */ }
    return { status: r.status, json, text: r.text };
  };
  return { service, call, raw, exec, mails, clock };
}
const unlock = async (h, rfc) => {
  const open = await h.call('POST', '/api/unlock', { rfc, minutes: 1440, days: 7,
    direction: 'both', password: 'simulated', certificate: 'YQ==', key: 'Yg==' });
  assert.equal(open.status, 200);
};

/* ===== PROTOCOLO (unidad) ===== */
{
  const job = buildExecutorJob({ rfc: OWN, kind: 'buzon-listar' });
  assert.ok(job.plan.length >= 3, 'el plan del buzón trae sus pasos desde el mapa del portal');
  assert.ok(job.plan.every(paso => !paso.url || paso.url.includes('sat.gob.mx')),
    'el plan solo navega a *.sat.gob.mx, sin intermediarios');
  assert.ok(job.plan.some(paso => /SIN abrir ninguna/i.test(paso.paso)),
    'el plan del Buzón ordena leer la lista SIN abrir ninguna notificación');
  assert.throws(() => buildExecutorJob({ rfc: OWN, kind: 'declaracion-folio', payload: {} }), /folio/i,
    'reimprimir sin folio no se encola: no consta qué acuse es');
  assert.throws(() => validateExecutorResult(job, { operations: ['abrir-notificacion'], notifications: [] }),
    /apertura|operación/i, 'un resultado que abra notificaciones se rechaza entero');
  assert.throws(() => validateExecutorResult(job, { notifications: [], password: 'secreto' }),
    /credencial/i, 'ninguna credencial viaja en un resultado');
  assert.equal(classifyBuzonRow({ asunto: 'Opinión de cumplimiento 32-D', remitente: 'SAT' }), 'opinion');
  assert.equal(classifyBuzonRow({ asunto: 'Comunicado informativo', remitente: 'SAT' }), 'informativo');
  assert.equal(classifyBuzonRow({ asunto: 'Requerimiento de pago', remitente: 'SAT' }), 'atencion');
  const mala = verifyDeclarationDocument({ clase: 'acuse', operacion: '123456789012', periodo: '2026-10',
    contentBase64: Buffer.from('<html><body>error del portal</body></html>').toString('base64') },
    { periodo: '2026-10', ejercicio: 2026 });
  assert.equal(mala.ok, false, 'una página de error jamás se archiva como acuse');
  const folioMal = verifyDeclarationDocument({ clase: 'acuse', operacion: '111111111111', periodo: '2026-09', contentBase64: PDF_B64 },
    { folio: '999999999999', periodo: '2026-09', ejercicio: 2026 });
  assert.equal(folioMal.ok, false, 'el folio devuelto debe ser el pedido');
  const buena = verifyDeclarationDocument({ clase: 'acuse', operacion: '123456789012', periodo: '2026-10', contentBase64: PDF_B64 },
    { periodo: '2026-10', ejercicio: 2026 });
  assert.equal(buena.ok, true, 'PDF real + operación + periodo: verificado');
  /* H-1.1 (pasada de seguridad): una PALABRA no es un secreto.
     El error literal de la propia casa («La contraseña guardada
     no abre la llave .key», de sat-doc-fetch) y la página de
     fallo del portal — que trae su campo «Contraseña» — deben
     ACEPTARSE como evidencia, con el fragmento con forma de
     secreto redactado, jamás rechazarse como «protocolo». */
  const PNG_B64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).toString('base64');
  const jobDecl = buildExecutorJob({ rfc: OWN, kind: 'declaraciones-recuperar', payload: { ejercicio: 2026, tipo: 'mensual' } });
  const falloAcceso = validateExecutorResult(jobDecl, {
    steps: [{ at: 1, paso: 'Acceso al portal', detalle: 'La contraseña guardada no abre la llave .key de este perfil' }],
    operations: ['entrar-con-efirma'], errorKind: 'acceso',
    error: 'La contraseña guardada no abre la llave .key de este perfil',
    diag: { url: 'https://wwwmat.sat.gob.mx/', screenshotBase64: PNG_B64,
      html: '<html><body><label>Contraseña</label><input type="password" name="pwd" value="no-debe-viajar"></body></html>' } });
  assert.equal(falloAcceso.error, 'La contraseña guardada no abre la llave .key de este perfil',
    'H-1.1: el error literal de acceso se conserva entero y no se pierde como «protocolo»');
  assert.equal(falloAcceso.steps[0].detalle, 'La contraseña guardada no abre la llave .key de este perfil',
    'H-1.1: la traza con ese vocabulario tampoco se tumba');
  assert.ok(falloAcceso.diag.html.includes('Contraseña'), 'H-1.1: la página de fallo se conserva como evidencia');
  assert.ok(!falloAcceso.diag.html.includes('no-debe-viajar'), 'H-1.1: el valor tecleado en el campo de contraseña viaja redactado');
  assert.ok(falloAcceso.diag.html.includes('[redactado]'), 'H-1.1: la redacción deja su marca en la evidencia');
  assert.ok(Buffer.isBuffer(falloAcceso.diag.screenshot) && falloAcceso.diag.screenshot.length > 0,
    'H-1.5: la captura que sí decodifica a imagen se conserva');
  const capturaFalsa = validateExecutorResult(jobDecl, { operations: ['entrar-con-efirma'],
    diag: { html: '', screenshotBase64: Buffer.from('esto no es una imagen').toString('base64') } });
  assert.equal(capturaFalsa.diag.screenshot, null, 'H-1.5: lo que no decodifica a imagen no se archiva como captura');
  /* Y el material con forma real de secreto sigue sin pasar. */
  assert.throws(() => validateExecutorResult(jobDecl, { operations: ['leer-lista'],
    extra: '-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBg' }), /credencial/i,
    'H-1.1: un bloque de llave privada en lo estructural sigue rechazándose');
  assert.throws(() => validateExecutorResult(job, { operations: ['leer-lista'],
    notifications: [{ fecha: '2026-11-10', asunto: 'Aviso', contentBase64: 'QUJD'.repeat(100) }] }), /credencial/i,
    'H-1.5: la exención de contentBase64 solo vale en documents[] — anidada en otro sitio se barre');
  const docConSecreto = validateExecutorResult(jobDecl, { operations: ['descargar-pdf'], documents: [
    { tipo: 'mensual', clase: 'acuse', ejercicio: 2026, periodo: '2026-10', operacion: '123456789012', contentBase64: PDF_B64 }] });
  assert.equal(docConSecreto.documents.length, 1, 'H-1.5: el PDF en documents[].contentBase64 sigue exento y verificado');
  /* H-1.4: la clave de deduplicación incluye el tipo. */
  const jm = buildExecutorJob({ rfc: OWN, kind: 'declaraciones-recuperar', payload: { ejercicio: 2026, tipo: 'mensual' } });
  const ja = buildExecutorJob({ rfc: OWN, kind: 'declaraciones-recuperar', payload: { ejercicio: 2026, tipo: 'anual' } });
  assert.notEqual(jm.dedupeKey, ja.dedupeKey, 'H-1.4: mensual sin periodo y anual del mismo ejercicio no colisionan');
  console.log('OK 1.29.0 · protocolo — sin apertura, sin credenciales, verificación PDF+operación+periodo.');
}

/* ===== EJECUTOR: ciclo completo con un ejecutor simulado ===== */
{
  const h = makeHarness({ executorMode: 'remote' });
  await unlock(h, OWN);
  /* Sin ejecutor: el trabajo queda esperando, no fallando. */
  const run = await h.call('POST', '/api/tributario/run', { rfc: OWN });
  assert.equal(run.json.result.ok, false);
  assert.equal(run.json.result.waitingExecutor, true, 'sin ejecutor no hay fallo en falso: espera tu equipo');
  const declRun = await h.call('POST', '/api/declaraciones/run', { rfc: OWN, tipo: 'mensual', ejercicio: 2026, periodo: '' });
  assert.equal(declRun.json.result.waitingExecutor, true, 'declaraciones también encola en remoto');
  const declRun2 = await h.call('POST', '/api/declaraciones/run', { rfc: OWN, tipo: 'mensual', ejercicio: 2026, periodo: '' });
  assert.equal(declRun2.json.result.waitingExecutor, true);
  let overview = (await h.call('GET', '/api/executor/overview')).json;
  assert.equal(overview.enCola, 2, 'dos trabajos en cola (la repetición deduplica, no duplica)');
  assert.equal(overview.enLinea, false);
  const registro = (await h.call('GET', '/api/registro?limit=100')).json;
  assert.ok(registro.items.some(item => item.clase === 'accion' && /esperando tu equipo/i.test(item.texto)),
    'el Registro enseña el trabajo como ACCIÓN pendiente de tu equipo');
  assert.ok(!registro.items.some(item => item.clase === 'fallo' && /Buzón|Declaraciones/i.test(item.texto)),
    'y ningún fallo falso contra el SAT');
  /* Emparejar sin ser administrador: cerrado. */
  const sinAdmin = await h.exec('POST', '/api/executor/pair', { nombre: 'X' }, '');
  assert.equal(sinAdmin.status, 403, 'emparejar exige administrador: la puerta no cambia');
  const par = await h.call('POST', '/api/executor/pair', { nombre: 'Equipo de Paco' });
  assert.equal(par.status, 200);
  const execToken = par.json.token;
  assert.ok(execToken && execToken.length >= 32, 'el token se enseña una vez al emparejar');
  const malToken = await h.exec('POST', '/api/executor/claim', {}, 'token-falso-token-falso-token-falso');
  assert.equal(malToken.status, 403, 'un token de ejecutor falso no reclama nada');
  const claim = await h.exec('POST', '/api/executor/claim', { limit: 5 }, execToken);
  assert.equal(claim.status, 200);
  assert.equal(claim.json.trabajos.length, 2, 'el ejecutor reclama los dos trabajos');
  const jobBuzon = claim.json.trabajos.find(t => t.kind === 'buzon-listar');
  const jobDecl = claim.json.trabajos.find(t => t.kind === 'declaraciones-recuperar');
  /* Buzón: una de atención y una opinión (se auto-archiva). */
  const notifs = [
    { fecha: '2026-11-10', asunto: 'Requerimiento de pago de diferencias', remitente: 'SAT', estado: 'Pendiente', abierta: false },
    { fecha: '2026-11-09', asunto: 'Opinión de cumplimiento 32-D positiva', remitente: 'SAT', estado: 'Pendiente', abierta: false }];
  const resBuzon = await h.exec('POST', '/api/executor/result', { jobId: jobBuzon.id, status: 'done',
    result: { steps: [{ at: Date.now(), paso: 'Acceso al portal OK', detalle: '' }], operations: ['entrar-con-efirma', 'navegar-a-lista', 'leer-lista'],
      notifications: notifs } }, execToken);
  assert.equal(resBuzon.json.job.estado, 'hecho');
  let trib = (await h.call('GET', '/api/tributario?rfc=' + OWN + '&archivadas=1')).json;
  assert.equal(trib.total, 1, 'la vista principal solo trae lo que requiere atención');
  assert.equal(trib.sinAbrir, 1);
  assert.equal(trib.archivadas, 1, 'la opinión se archivó sola al nacer');
  assert.equal(trib.notificaciones.length, 2, 'con archivadas pedidas, salen las dos');
  const claveAtencion = trib.notificaciones.find(x => !x.archivada).clave;
  /* Declaraciones: un acuse verificable y una página de error. */
  const resDecl = await h.exec('POST', '/api/executor/result', { jobId: jobDecl.id, status: 'done',
    result: { steps: [{ at: Date.now(), paso: 'Reimpresión por folio', detalle: '' }],
      operations: ['entrar-con-efirma', 'reimprimir-acuse-por-folio', 'descargar-pdf'],
      documents: [
        { tipo: 'mensual', clase: 'acuse', ejercicio: 2026, periodo: '2026-10', operacion: '123456789012',
          fechaPresentacion: '2026-11-05', contentBase64: PDF_B64 },
        { tipo: 'mensual', clase: 'acuse', ejercicio: 2026, periodo: '2026-09', operacion: '123456789013',
          fechaPresentacion: '2026-10-05', contentBase64: Buffer.from('<html>error</html>').toString('base64') }] } }, execToken);
  assert.equal(resDecl.json.job.estado, 'hecho');
  assert.equal(resDecl.json.job.resumen.guardados, 1, 'solo el PDF verificado se archiva');
  assert.equal(resDecl.json.job.resumen.rechazados.length, 1, 'la página de error vuelve rechazada con su motivo');
  const declView = (await h.call('GET', '/api/declaraciones?rfc=' + OWN + '&ejercicio=2026')).json;
  assert.equal(declView.documentos.length, 1, 'en el expediente solo consta el documento verificado');
  const octubre = declView.mapa.meses.find(m => m.periodo === '2026-10');
  assert.equal(octubre.estado, 'presentada');
  assert.equal(octubre.operacion, '123456789012', 'el mes queda verde con su número de operación');
  assert.equal(octubre.verificada, true, 'y consta verificado');
  /* Folio equivocado: la verificación lo caza y no archiva. */
  const jobFolio = (await h.call('POST', '/api/executor/jobs',
    { rfc: OWN, kind: 'declaracion-folio', payload: { folio: '999999999999', tipo: 'mensual', ejercicio: 2026, periodo: '2026-09' } })).json.job;
  const claim2 = await h.exec('POST', '/api/executor/claim', { limit: 5 }, execToken);
  const reclamado = claim2.json.trabajos.find(t => t.id === jobFolio.id);
  assert.ok(reclamado, 'el trabajo de folio se reclama');
  const resFolio = await h.exec('POST', '/api/executor/result', { jobId: jobFolio.id, status: 'done',
    result: { steps: [], operations: ['entrar-con-efirma', 'reimprimir-acuse-por-folio', 'descargar-pdf'],
      documents: [{ tipo: 'mensual', clase: 'acuse', ejercicio: 2026, periodo: '2026-09', operacion: '111111111111', contentBase64: PDF_B64 }] } }, execToken);
  assert.equal(resFolio.json.job.estado, 'fallido', 'folio distinto del pedido: el trabajo no se da por bueno');
  const declView2 = (await h.call('GET', '/api/declaraciones?rfc=' + OWN + '&ejercicio=2026')).json;
  assert.equal(declView2.documentos.length, 1, 'y nada se archivó de ese intento');
  /* Papelera: marcar → desaparece → la sincronización no lo
     resucita → deshacer lo devuelve → purga con lápida. */
  const syncBuzon = async () => {
    const j = (await h.call('POST', '/api/executor/jobs', { rfc: OWN, kind: 'buzon-listar', payload: {} })).json.job;
    const c = await h.exec('POST', '/api/executor/claim', { limit: 5 }, execToken);
    const t = c.json.trabajos.find(x => x.id === j.id);
    assert.ok(t, 'trabajo de sincronización reclamado');
    await h.exec('POST', '/api/executor/result', { jobId: j.id, status: 'done',
      result: { steps: [], operations: ['entrar-con-efirma', 'navegar-a-lista', 'leer-lista'], notifications: notifs } }, execToken);
  };
  await h.call('POST', '/api/tributario/trash', { rfc: OWN, clave: claveAtencion, papelera: true });
  trib = (await h.call('GET', '/api/tributario?rfc=' + OWN + '&archivadas=1&papelera=1')).json;
  assert.equal(trib.total, 0, 'en la papelera: fuera de la vista principal');
  assert.equal(trib.papeleraTotal, 1, 'y consta en la Papelera');
  await syncBuzon();
  trib = (await h.call('GET', '/api/tributario?rfc=' + OWN + '&archivadas=1&papelera=1')).json;
  assert.equal(trib.total, 0, 'la sincronización NO resucita lo de la papelera');
  assert.equal(trib.papeleraTotal, 1);
  await h.call('POST', '/api/tributario/trash', { rfc: OWN, clave: claveAtencion, papelera: false });
  trib = (await h.call('GET', '/api/tributario?rfc=' + OWN)).json;
  assert.equal(trib.total, 1, 'deshacer lo devuelve a la vista, como estaba');
  await h.call('POST', '/api/tributario/trash', { rfc: OWN, clave: claveAtencion, papelera: true });
  const purga = await h.call('POST', '/api/tributario/purge', { rfc: OWN, clave: claveAtencion });
  assert.equal(purga.status, 200);
  await syncBuzon();
  trib = (await h.call('GET', '/api/tributario?rfc=' + OWN + '&archivadas=1&papelera=1')).json;
  assert.equal(trib.total, 0, 'purgado: la lápida impide que vuelva aunque el SAT lo siga listando');
  assert.equal(trib.papeleraTotal, 0, 'la copia local ya no existe');
  const registro2 = (await h.call('GET', '/api/registro?limit=200')).json;
  assert.ok(registro2.items.some(item => /Purgó definitivamente/.test(item.texto)),
    'la purga queda trazada en el Registro (qué, cuándo, quién)');
  /* Resultado con credencial: rechazado, no archiva, no «hecho». */
  const jobMal = (await h.call('POST', '/api/executor/jobs', { rfc: OWN, kind: 'buzon-listar', payload: {} })).json.job;
  const claim3 = await h.exec('POST', '/api/executor/claim', { limit: 5 }, execToken);
  assert.ok(claim3.json.trabajos.some(t => t.id === jobMal.id));
  const resMal = await h.exec('POST', '/api/executor/result', { jobId: jobMal.id, status: 'done',
    result: { steps: [], operations: ['leer-lista'], notifications: [], password: 'no-debe-viajar' } }, execToken);
  assert.notEqual(resMal.json.job.estado, 'hecho', 'un resultado con credenciales jamás se da por bueno');
  /* Arriendo que caduca: reclamado y no devuelto, vuelve a la cola. */
  const jobLease = (await h.call('POST', '/api/executor/jobs', { rfc: OWN, kind: 'buzon-listar', payload: {} })).json.job;
  const claim4 = await h.exec('POST', '/api/executor/claim', { limit: 5 }, execToken);
  assert.ok(claim4.json.trabajos.some(t => t.id === jobLease.id), 'reclamado la primera vez');
  const claim5 = await h.exec('POST', '/api/executor/claim', { limit: 5 }, execToken);
  assert.ok(!claim5.json.trabajos.some(t => t.id === jobLease.id), 'en arriendo no se reparte dos veces');
  h.clock.t += 11 * 60 * 1000;
  const claim6 = await h.exec('POST', '/api/executor/claim', { limit: 5 }, execToken);
  assert.ok(claim6.json.trabajos.some(t => t.id === jobLease.id), 'caducado el arriendo, el trabajo vuelve a la cola');
  /* Revocación del token (H-1.2): el ejecutor revocado ya no
     reclama ni entrega, su trabajo en curso vuelve a la cola,
     el gesto queda en el Registro y re-emparejar NO lo revive. */
  /* Con ejercicio en el payload: su clave de deduplicación no
     colisiona con el trabajo «malo» anterior, que sigue abierto. */
  const jobRev = (await h.call('POST', '/api/executor/jobs', { rfc: OWN, kind: 'buzon-listar', payload: { ejercicio: 2026 } })).json.job;
  const claimRev = await h.exec('POST', '/api/executor/claim', { limit: 5 }, execToken);
  assert.ok(claimRev.json.trabajos.some(t => t.id === jobRev.id), 'el trabajo queda en curso antes de revocar');
  const revSinAdmin = await h.exec('POST', '/api/executor/revoke', { id: par.json.id }, execToken);
  assert.equal(revSinAdmin.status, 403, 'revocar exige administrador: el token del ejecutor no se revoca a sí mismo');
  const rev = await h.call('POST', '/api/executor/revoke', { id: par.json.id });
  assert.equal(rev.status, 200);
  assert.equal(rev.json.revocado, true);
  overview = (await h.call('GET', '/api/executor/overview')).json;
  assert.equal(overview.ejecutores.find(e => e.id === par.json.id).revocado, true, 'el panel enseña el ejecutor revocado');
  const claimRevocado = await h.exec('POST', '/api/executor/claim', { limit: 5 }, execToken);
  assert.equal(claimRevocado.status, 403, 'el token revocado ya no reclama trabajos');
  const latidoRevocado = await h.exec('POST', '/api/executor/heartbeat', {}, execToken);
  assert.equal(latidoRevocado.status, 403, 'el token revocado ni siquiera late');
  const resRevocado = await h.exec('POST', '/api/executor/result', { jobId: jobRev.id, status: 'done',
    result: { steps: [], operations: ['leer-lista'], notifications: [] } }, execToken);
  assert.equal(resRevocado.status, 403, 'el token revocado tampoco entrega resultados');
  overview = (await h.call('GET', '/api/executor/overview')).json;
  assert.equal(overview.trabajos.find(t => t.id === jobRev.id).estado, 'en-cola',
    'su trabajo en curso volvió a la cola para otro ejecutor');
  const registro3 = (await h.call('GET', '/api/registro?limit=300')).json;
  assert.ok(registro3.items.some(item => /REVOCADO/.test(item.texto)), 'la revocación queda trazada en el Registro');
  const par2 = await h.call('POST', '/api/executor/pair', { nombre: 'Equipo de Paco' });
  assert.equal(par2.status, 200);
  assert.notEqual(par2.json.token, execToken, 're-emparejar crea un token nuevo');
  const claimNuevo = await h.exec('POST', '/api/executor/claim', { limit: 5 }, par2.json.token);
  assert.equal(claimNuevo.status, 200);
  assert.ok(claimNuevo.json.trabajos.some(t => t.id === jobRev.id), 'el ejecutor nuevo recoge el trabajo devuelto a la cola');
  const claimViejo = await h.exec('POST', '/api/executor/claim', { limit: 5 }, execToken);
  assert.equal(claimViejo.status, 403, 'y el token viejo sigue muerto: re-emparejar no lo revive');
  await h.service.close();
  console.log('OK 1.29.0 · ejecutor — ciclo completo, papelera con lápida, verificación y arriendos.');
}

/* ===== PAGOS: vencimientos con respaldo y cruce antiduplicado ===== */
{
  const dir = mkdtempSync(join(tmpdir(), 'pacosat-1290-pagos-'));
  const dbFile = join(dir, 'pacosat.sqlite');
  const h = makeHarness({ dbFile });
  h.clock.t = Date.parse('2026-01-15T12:00:00Z');
  await unlock(h, OWN);
  const linea = { nombre: 'SAT', grupo: 'BBVA', cuenta: '0123456789', clabe: '', motivo: 'Impuestos federales de octubre',
    concepto: 'Línea de captura', folio: '12345678901234567890', uuid: '',
    baseCents: 150000, ivaCents: 0, totalCents: 150000, fijo: false };
  const db = new DatabaseSync(dbFile);
  db.prepare('INSERT INTO pay_preparations(id,rfc,month,total,operaciones,payload,created) VALUES (?,?,?,?,?,?,?)')
    .run('prep-semilla', OWN, '2025-10', '1500', 1, JSON.stringify({ descripcion: 'Impuestos',
      bbva: { lines: [linea], totalCents: 150000 }, interbancario: { lines: [] }, speiIndividual: { lines: [] } }), h.clock.t);
  db.close();
  let vista = (await h.call('GET', '/api/pagos/vencimientos?rfc=' + OWN)).json;
  assert.equal(vista.todoPagado, false);
  assert.equal(vista.vencimientos.length, 1, 'un vencimiento: el de la línea respaldada');
  assert.equal(vista.vencimientos[0].organismo, 'SAT');
  assert.equal(vista.vencimientos[0].importeCents, 150000);
  assert.ok(vista.vencimientos[0].documento.label.includes('2025-10'), 'cada vencimiento trae su documento de respaldo');
  assert.ok(/puede estar caducada/.test(vista.vencimientos[0].avisoCaducidad), 'línea de un mes anterior: aviso de caducidad');
  assert.equal(vista.faltantes.length, 0, 'en enero no hay meses vencidos sin respaldo que inventar');
  const preparada = await h.call('POST', '/api/pagos/preparar-vencimientos', { rfc: OWN });
  assert.equal(preparada.status, 200, '«Preparar pagos» deja la preparación lista');
  vista = (await h.call('GET', '/api/pagos/vencimientos?rfc=' + OWN)).json;
  assert.equal(vista.vencimientos.length, 1, 'preparar no duplica: la semilla quedó reemplazada por la nueva');
  assert.equal(vista.totalCents, 150000, 'el total no se dobla');
  /* El banco ya lo cobró: el cruce lo saca de los vencimientos. */
  const db2 = new DatabaseSync(dbFile);
  db2.prepare('INSERT INTO bank_accounts(id,bank,name,last4,kind,created) VALUES (?,?,?,?,?,?)')
    .run('cta-1', 'BBVA', 'Cuenta', '1234', 'cheques', h.clock.t);
  db2.prepare('INSERT INTO bank_statements(id,accountId,month,created) VALUES (?,?,?,?)')
    .run('edo-1', 'cta-1', '2026-01', h.clock.t);
  db2.prepare('INSERT INTO bank_movements(id,statementId,date,concept,amountCents) VALUES (?,?,?,?,?)')
    .run('mov-1', 'edo-1', '2026-01-10', 'PAGO SAT IMPUESTOS FEDERALES', -150000);
  db2.close();
  vista = (await h.call('GET', '/api/pagos/vencimientos?rfc=' + OWN)).json;
  assert.equal(vista.vencimientos.length, 0, 'el movimiento del banco del mismo importe y organismo lo cruza');
  assert.equal(vista.cruces.length, 1, 'y el cruce queda anotado para revisarlo');
  assert.equal(vista.todoPagado, true, 'sin vencimientos ni faltantes: «Todo pagado»');
  await h.service.close();
  rmSync(dir, { recursive: true, force: true });
  console.log('OK 1.29.0 · pagos — vencimientos respaldados, preparar sin duplicar, cruce antiduplicado, «Todo pagado».');
}

/* ===== DISEÑO (estático, sobre las partes) ===== */
{
  const layout = read('layout.part'), trib = read('tributario-ui.part'),
    pagos = read('pagos-ui.part'), ui = read('ui.part');
  for (const grupo of ['LA MAÑANA', 'EL DINERO', 'EL SAT Y LOS PAPELES', 'LA CASA'])
    assert.ok(layout.includes(grupo), 'menú reagrupado: ' + grupo);
  assert.ok(layout.includes('Centro SAT'), '«SAT» pasa a «Centro SAT» en el menú');
  const bottom = layout.slice(layout.indexOf('bottombar'));
  for (const v of ['home', 'avisos', 'buzon', 'dinero'])
    assert.ok(bottom.includes('data-view="' + v + '"'), 'barra móvil 1.29: ' + v);
  assert.ok(!bottom.includes('data-view="invoices"') && !bottom.includes('data-view="pagos"'),
    'la barra móvil ya no lleva Facturas/Pagos: es Hoy · Avisos · Buzón · Dinero · Más');
  assert.ok(trib.includes('Papelera') && trib.includes('no se puede borrar'),
    'la papelera enseña su límite honesto en la cara');
  assert.ok(trib.includes('executor/pair') && trib.includes('Ejecutor local del SAT'),
    'el panel del ejecutor vive en la pantalla del Buzón Tributario');
  assert.ok(trib.includes('executor/revoke') && trib.includes('Revocar acceso'),
    'el panel del ejecutor trae el gesto de revocar el token (H-1.2)');
  assert.ok(pagos.includes('Preparar pagos') && pagos.includes('Todo pagado'),
    'Pagos: «Preparar pagos» y «Todo pagado»');
  assert.ok(!/Pagar todo/.test(pagos.replace(/NUNCA «Pagar todo»|nunca «Pagar todo»/g, '')),
    'jamás un botón «Pagar todo»');
  assert.ok(ui.includes('tot-anio') && ui.includes('totalesDetallePintar') && ui.includes('Suma del detalle'),
    'Totales por años, meses que se entran y suma del detalle que iguala el total');
  assert.ok(ui.includes('fmtFechaHora'), 'un formato humano único de fecha');
  assert.equal(JSON.parse(read('package.json')).version, '1.29.0', 'la versión es 1.29.0');
  assert.ok(read('docs/CAPACIDADES.md').includes('1.29.0'), 'CAPACIDADES describe la 1.29.0');
  console.log('OK 1.29.0 · diseño — menú, barra móvil, papelera honesta, pagos y totales navegables.');
}
console.log('ronda1290: ok');
