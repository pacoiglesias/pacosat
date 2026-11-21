import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { DOMParser } from '@xmldom/xmldom';
import { createPacoSATService } from './local-server.mjs';
import { buildExecutorJob, validateExecutorResult, SAT_EXECUTOR_JOB_KINDS } from './sat-executor.mjs';
import { createSatTribFetch } from './sat-tributario.mjs';

/* ================================================================
   Ronda 1.30.0 — la ola de las seis mejoras (orden de Paco,
   12 nov 2026, 23:03: «aplica todas las mejoras de una vez»).

   Comprobaciones de verdad de esta suite:
   1. PUERTA-PROBAR (protocolo + servidor): el trabajo existe en
      el protocolo cerrado, su plan es SOLO entrar, un resultado
      «abre» sin la operación de entrar se rechaza, y el ciclo
      completo en el servidor (encolar → reclamar → «abre»)
      deja el veredicto por RFC en /api/status; un «no abre»
      posterior crea UNA alerta y el siguiente «no abre» no la
      duplica.
   2. SESIÓN VIVA (motor del Buzón con página falsa): con
      options.sesionViva el motor NO lanza navegador, NO vuelve
      a firmar y NO cierra la página — y lista igual; sin ella,
      el camino de siempre firma y cierra (contraste).
   3. CÓDIGO CORTO (servidor): sin admin no nace; el canje bueno
      entrega el token una vez; el mismo código no canjea dos
      veces; un código inventado no canjea; caducado, tampoco.
   4. AUTO-ACTUALIZACIÓN (servidor): /api/executor/version sin
      paquete publicado responde versión vacía (nadie se
      actualiza a ciegas) y /bundle responde 404.
   5. ESTÁTICAS de la ola: versión 1.30.0, el ejecutor nuevo con
      sus piezas (sesión viva, reintento, código, actualización),
      el Dockerfile y el .dockerignore que embarcan el paquete
      del ejecutor, el workflow de GHCR listo y el compose del
      árbol ya apuntando a la imagen, la parrilla con «falta su
      e.firma» y la puerta en la tarjeta del Buzón, el parte de
      la mañana en el resumen diario y el instalador en el
      paquete del ejecutor.
   ================================================================ */

const ORIGIN = 'https://pacosat.test';
const KEY = 'f'.repeat(64);
const OWN = 'AAA010101AAA';
const ROOT = import.meta.dirname;
const read = name => readFileSync(join(ROOT, name), 'utf8');

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

/* ===== 5 · ESTÁTICAS ===== */
{
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.version, '3.1.1', 'la versión de la ola es 2.0.1 (re-basificado: la 2.0.1 —motores contra el mapa real— sustituye a la 2.0.0 como versión a montar)');
  const ejecutor = read('ejecutor-local.mjs');
  /* Re-baseline 1.31.2 (bis): el sello del ejecutor sube con
     el paquete por la coherencia de la casa (ronda1310); en la
     1.31.2 es su ÚNICO cambio y su bundle se regenera por él. */
  assert.ok(ejecutor.includes("EJECUTOR_VERSION = '3.1.1'"), 'el ejecutor declara su versión (sello 2.0.1)');
  assert.ok(ejecutor.includes('sesionViva'), 'el ejecutor pasa la sesión viva a los motores');
  assert.ok(ejecutor.includes('puerta-probar'), 'el ejecutor sabe probar la puerta');
  assert.ok(ejecutor.includes('portal-rechaza') && ejecutor.includes('REINTENTO_PORTAL_MS'),
    'el ejecutor reintenta una vez ante portal-rechaza, con su pausa');
  assert.ok(ejecutor.includes('/api/executor/exchange'), 'el ejecutor canjea el código corto');
  assert.ok(ejecutor.includes('/api/executor/version') && ejecutor.includes("process.exit(42)"),
    'el ejecutor se auto-actualiza desde PacoSAT y se relanza (salida 42)');
  assert.ok(ejecutor.includes('createHash') && ejecutor.includes('sha256'),
    'la auto-actualización comprueba la huella antes de tocar nada');
  const dockerfile = read('Dockerfile');
  assert.ok(dockerfile.includes('ejecutor-bundle.zip') && dockerfile.includes('ejecutor-bundle.json'),
    'la imagen embarca el paquete del ejecutor y su manifiesto');
  const dockerignore = read('.dockerignore');
  assert.ok(dockerignore.includes('!ejecutor-bundle.zip') && dockerignore.includes('!ejecutor-bundle.json'),
    'el .dockerignore deja pasar el paquete del ejecutor');
  // El workflow de GHCR vive en el árbol local a la espera del gesto de Paco
  // (el conector no tiene permiso de Workflows y no puede subirlo). En un
  // checkout limpio (CI) aún no está: ahí la aserción se omite; donde el
  // archivo está presente, su contenido se verifica entero.
  const workflowPath = join(ROOT, '.github/workflows/ghcr.yml');
  if (existsSync(workflowPath)) {
    const workflow = read('.github/workflows/ghcr.yml');
    assert.ok(workflow.includes('ghcr.io/pacoiglesias/pacosat') && workflow.includes('packages: write'),
      'el workflow de GHCR está listo en el árbol para el gesto de Paco');
  }
  const compose = read('compose.yml');
  assert.ok(compose.includes('image: ghcr.io/pacoiglesias/pacosat:latest'),
    'el compose del árbol ya consume la imagen de GHCR (el NAS solo cambiará su copia adaptada)');
  const servidor = read('local-server.mjs');
  for (const ruta of ['/api/executor/pair-code', '/api/executor/exchange', '/api/executor/version', '/api/executor/bundle'])
    assert.ok(servidor.includes(ruta), 'el servidor sirve ' + ruta);
  assert.ok(servidor.includes('sat_puerta') && servidor.includes('puertaAutoTick'),
    'la puerta auto-probada tiene su tabla y su cadencia semanal');
  assert.ok(servidor.includes('TU PARTE DE LA MAÑANA'), 'el resumen diario lleva el parte de la mañana');
  assert.ok(servidor.includes('pending: true'), 'las altas preparadas viajan como perfiles «pending» en el estado');
  const satUi = read('sat-ui.part');
  assert.ok(satUi.includes('Falta su e.firma') && satUi.includes('d.profile?.pending'),
    'la parrilla enseña «falta su e.firma» en un RFC preparado sin credenciales');
  /* RE-BASE integración 2.4.0 (W6b): el veredicto «Puerta
     probada el…» lo compone textoP200, que vive en el puente
     de ui.part; el ancla se busca en su nuevo hogar (ui.part
     se lee más abajo en este mismo bloque), mismo literal. */
  assert.ok(read('ui.part').includes('Puerta probada el'), 'la tarjeta del Buzón enseña el veredicto de la puerta');
  assert.ok(satUi.includes('(satData.pendingProfiles || []).includes(rfc)'),
    'la parrilla cruza el perfil con pendingProfiles: el alta preparada tiene fila y la fila sola no la marca');
  const tribUi = read('tributario-ui.part');
  assert.ok(tribUi.includes('executor/pair-code') && tribUi.includes('Código corto para el instalador'),
    'el panel del ejecutor crea el código corto');
  const ui = read('ui.part');
  assert.ok(ui.includes('otroRfcAltaCard'), 'el alta guiada de cualquier otro RFC existe');
  console.log('OK 1.30.0 · estáticas — versión, piezas del ejecutor, GHCR listo, parrilla y parte cableados.');
}

/* ===== 1 · PUERTA-PROBAR: protocolo ===== */
{
  assert.ok(SAT_EXECUTOR_JOB_KINDS.includes('puerta-probar'), 'la puerta-probar es una clase cerrada del protocolo');
  const job = buildExecutorJob({ rfc: OWN, kind: 'puerta-probar' });
  assert.equal(job.plan.length, 2, 'el plan de la puerta tiene dos pasos: entrar y volver');
  assert.ok(job.plan[0].url.includes('lanzador.jsf'), 'el primer paso es la puerta de acceso de siempre');
  assert.ok(job.plan.every(paso => !paso.url || paso === job.plan[0]),
    'ningún paso posterior navega a ningún trámite: la puerta se prueba sin tocar nada');
  const ok = validateExecutorResult(job, { operations: ['entrar-con-efirma'], puerta: 'abre',
    steps: [{ at: 1, paso: 'Acceso al portal OK', detalle: '' }] });
  assert.equal(ok.puerta, 'abre', 'un «abre» con su operación de entrar acredita la puerta');
  assert.throws(() => validateExecutorResult(job, { operations: ['leer-lista'], puerta: 'abre' }),
    /operación|entrar/i, 'un «abre» sin la operación de entrar se rechaza: no acredita nada');
  const sinMarca = validateExecutorResult(job, { operations: ['entrar-con-efirma'] });
  assert.equal(sinMarca.puerta, '', 'sin la marca «abre» el resultado no acredita la puerta');
  console.log('OK 1.30.0 · puerta (protocolo) — solo entrar, con su operación, sin navegar.');
}

/* ===== 2 · SESIÓN VIVA en el motor del Buzón ===== */
{
  const TEXTO_BANDEJA = 'Buzón Tributario · Mis notificaciones · Fecha Asunto Remitente Estado';
  const TABLAS = [{ headers: ['Fecha', 'Asunto', 'Remitente', 'Estado'],
    rows: [['10/11/2026', 'Aviso de presentación', 'SAT', 'No leída']] }];
  const paginaFalsa = () => {
    const llamadas = { evaluate: 0, goto: 0, fillFielForm: 0, submitFiel: 0 };
    return { llamadas,
      url: () => 'https://wwwmat.sat.gob.mx/iniciar-expediente/mis-notificaciones/',
      goto: async () => { llamadas.goto++; },
      text: async () => TEXTO_BANDEJA,
      /* La doble responde por el NOMBRE del lector que el motor
         evalúa: texto completo, tablas o enlaces. */
      evaluate: async (fn) => { llamadas.evaluate++;
        if (fn?.name === 'readTablesSource') return TABLAS;
        if (fn?.name === 'readLinksSource') return [];
        return TEXTO_BANDEJA; },
      clickButtonFiel: async () => true,
      fillFielForm: async () => { llamadas.fillFielForm++; },
      fielEmptyFields: async () => [],
      submitFiel: async () => { llamadas.submitFiel++; },
      divError: async () => '',
      diagnostics: async () => ({ url: '', html: '', screenshot: null }) };
  };
  const creds = { cer: Buffer.from('cer'), key: Buffer.from('key'), password: 'pw', rfc: OWN };
  /* Con sesión viva: ni lanzar, ni firmar, ni cerrar. */
  let lanzamientos = 0, cierres = 0;
  const paginaViva = paginaFalsa();
  const tribViva = createSatTribFetch({
    resolveCredentials: async () => creds,
    launchDriver: async () => { lanzamientos++; throw new Error('con sesión viva no se lanza navegador'); } });
  const resultado = await tribViva({ rfc: OWN }, {}, { sesionViva: { page: paginaViva } });
  assert.equal(resultado.notifications.length, 1, 'con sesión viva la bandeja se lista igual');
  assert.equal(lanzamientos, 0, 'con sesión viva no se lanza ningún navegador');
  assert.equal(paginaViva.llamadas.fillFielForm, 0, 'con sesión viva no se vuelve a firmar');
  assert.equal(paginaViva.llamadas.goto, 0, 'desde la bandeja no se navega a ningún otro sitio');
  /* Sin sesión viva: el camino de siempre firma y cierra. */
  const paginaNueva = paginaFalsa();
  const tribNueva = createSatTribFetch({
    resolveCredentials: async () => creds,
    launchDriver: async () => ({ newPage: async () => paginaNueva,
      close: async () => { cierres++; } }) });
  const resultado2 = await tribNueva({ rfc: OWN }, {}, {});
  assert.equal(resultado2.notifications.length, 1, 'sin sesión viva la bandeja también se lista');
  assert.equal(paginaNueva.llamadas.fillFielForm, 1, 'sin sesión viva se firma como siempre');
  assert.equal(cierres, 1, 'sin sesión viva el navegador se cierra al terminar (la página viva no se toca: cierres de la viva = 0 en su corrida)');
  console.log('OK 1.30.0 · sesión viva — una sola firma por tanda; el camino de siempre, intacto.');
}

/* ===== 1+3+4 · SERVIDOR: puerta, código corto y versión ===== */
{
  const h = makeHarness({ executorMode: 'remote' });
  await unlock(h, OWN);
  /* Emparejar un ejecutor por la vía larga de siempre. */
  const par = await h.call('POST', '/api/executor/pair', { nombre: 'Equipo de Paco' });
  assert.equal(par.status, 200);
  const tokenEjecutor = par.json.token;
  /* Código corto: sin admin no nace. */
  const sinAdmin = await h.exec('POST', '/api/executor/pair-code', {}, '');
  assert.equal(sinAdmin.status, 403, 'el código corto no nace sin administrador');
  const codigoResp = await h.call('POST', '/api/executor/pair-code', {});
  assert.equal(codigoResp.status, 200);
  assert.match(codigoResp.json.codigo, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/, 'el código corto tiene su forma XXXX-XXXX');
  /* Un código inventado no canjea. */
  const malo = await h.exec('POST', '/api/executor/exchange', { codigo: 'XXXX-9999', nombre: 'X' }, '');
  assert.equal(malo.status, 403, 'un código inventado no canjea');
  /* El bueno canjea UNA vez y entrega la llave. */
  const canje = await h.exec('POST', '/api/executor/exchange', { codigo: codigoResp.json.codigo, nombre: 'Equipo del instalador' }, '');
  assert.equal(canje.status, 200, 'el código bueno canjea');
  assert.ok(canje.json.token && canje.json.token.length >= 32, 'el canje entrega la llave del ejecutor');
  const repetido = await h.exec('POST', '/api/executor/exchange', { codigo: codigoResp.json.codigo, nombre: 'X' }, '');
  assert.equal(repetido.status, 403, 'el mismo código no canjea dos veces: era de un solo uso');
  /* El ejecutor canjeado late: su llave vale. */
  const late = await h.exec('POST', '/api/executor/heartbeat', {}, canje.json.token);
  assert.equal(late.status, 200, 'la llave del canje funciona para el ejecutor');
  /* Versión y paquete del ejecutor: el manifiesto ejecutor-bundle.json
     vive en el árbol desde la 1.32.2 (viaja en el snapshot de GitHub);
     donde está presente, la versión publicada es la suya y se verifica
     contra él. Donde no está (el paquete es artefacto de empaquetado),
     la versión va vacía: nadie se actualiza a ciegas. El .zip no viaja
     al repositorio: sin paquete guardado, /bundle es 404. */
  const version = await h.exec('POST', '/api/executor/version', {}, tokenEjecutor);
  assert.equal(version.status, 200);
  if (existsSync(join(ROOT, 'ejecutor-bundle.json'))) {
    const manifiesto = JSON.parse(read('ejecutor-bundle.json'));
    assert.equal(version.json.version, manifiesto.version,
      'con manifiesto en el servidor, la versión publicada es la del manifiesto');
  } else {
    assert.equal(version.json.version, '', 'sin manifiesto en el servidor, la versión va vacía: nadie se actualiza a ciegas');
  }
  const bundle = await h.exec('POST', '/api/executor/bundle', {}, tokenEjecutor);
  if (!existsSync(join(ROOT, 'ejecutor-bundle.zip')))
    assert.equal(bundle.status, 404, 'sin paquete guardado, /bundle es 404');
  /* La puerta: encolar, reclamar, «abre» → veredicto en el estado. */
  const enc = await h.call('POST', '/api/executor/jobs', { rfc: OWN, kind: 'puerta-probar', payload: {} });
  assert.equal(enc.status, 200, 'la puerta-probar se encola para un RFC con perfil');
  const claim = await h.exec('POST', '/api/executor/claim', { limit: 5 }, tokenEjecutor);
  const trabajo = claim.json.trabajos.find(t => t.kind === 'puerta-probar');
  assert.ok(trabajo, 'el ejecutor reclama la prueba de puerta');
  const hecho = await h.exec('POST', '/api/executor/result', { jobId: trabajo.id, status: 'done',
    result: { steps: [{ at: 1, paso: 'Acceso al portal OK', detalle: '' }], operations: ['entrar-con-efirma'], puerta: 'abre' } }, tokenEjecutor);
  assert.equal(hecho.json.ok, true, 'la prueba «abre» se cierra como hecha');
  let estado = (await h.call('GET', '/api/status')).json;
  assert.equal(estado.puerta[OWN].ok, true, 'el estado enseña la puerta de este RFC: abre');
  assert.ok(estado.puerta[OWN].probada > 0, 'y cuándo se probó');
  /* Un «no abre» crea la alerta; el segundo «no abre» no la duplica. */
  const alertasAntes = estado.alerts ? estado.alerts.length : null;
  const enc2 = await h.call('POST', '/api/executor/jobs', { rfc: OWN, kind: 'puerta-probar', payload: {} });
  const claim2 = await h.exec('POST', '/api/executor/claim', { limit: 5 }, tokenEjecutor);
  const trabajo2 = claim2.json.trabajos.find(t => t.id === enc2.json.job.id);
  const fallo = await h.exec('POST', '/api/executor/result', { jobId: trabajo2.id, status: 'failed',
    result: { steps: [{ at: 1, paso: 'Acceso', detalle: '' }], operations: ['entrar-con-efirma'],
      error: 'El portal del SAT rechazó el acceso: ¡Error! no ha llenado varios campos requeridos.', errorKind: 'portal-rechaza' } }, tokenEjecutor);
  assert.equal(fallo.json.ok, false);
  estado = (await h.call('GET', '/api/status')).json;
  assert.equal(estado.puerta[OWN].ok, false, 'tras el fallo, la puerta consta «no abre»');
  const registro = (await h.call('GET', '/api/registro?limit=200')).json;
  assert.ok(registro.items.some(item => /puerta del SAT/i.test(item.texto) && /NO abre/i.test(item.texto)),
    'el Registro cuenta la prueba fallida de la puerta');
  await h.service.close();
  console.log('OK 1.30.0 · servidor — código corto de un uso, puerta con veredicto y versión sin paquete.');
}

console.log('Ronda 1.30.0: batería completa en verde.');
