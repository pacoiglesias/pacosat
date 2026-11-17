/* ================================================================
   Ronda 1.32.1 — el arreglo de los caminos (orden de Paco, 14 nov:
   «todo ordenado, bien, funcional, práctico»):
   A1 cabecera honesta — aserto primaryLabel ↔ despacho para las
     pantallas tocadas: ninguna etiqueta promete lo que su clic
     no hace.
   A2 puerta veraz completa: un trabajo del ejecutor que acredita
     acceso (accesoOk) refresca la puerta aunque su corredor caiga;
     un fallo EN la entrada (accesoFallo) escribe «no abre» con el
     motivo real.
   A3 Registro compartible: las entradas traen su clave estable;
     borrar lo visible las oculta y deshacer las devuelve íntegras.
   B1 corredor de Declaraciones: la página 404 del SAT se clasifica
     «ruta-muerta» NOMBRANDO la URL (motor, contra un doble cuya
     página ES la 404), y el fallo guarda las DOS páginas — la de
     decisión y la final — servibles por el endpoint de artefactos;
     el htmlId de la corrida resuelve a un archivo existente.
   B3 activación: con el par de arranque caducado y el bueno en el
     almacén, el perfil queda ACTIVO, el par de arranque queda
     IGNORADO con su causa nombrada, y una solicitud de descarga
     contra el doble del WS se crea, se procesa y QUEDA REGISTRADA
     (jobs) y contada (cobertura). Sin perfil activo, /api/request
     lo dice antes de lanzar nada.
   ================================================================ */

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { generateKeyPairSync } from 'node:crypto';
import { DOMParser } from '@xmldom/xmldom';
import { createPacoSATService } from './local-server.mjs';
import { createSatDeclFetch } from './sat-declaraciones.mjs';
import { SatDocError } from './sat-doc-fetch.mjs';

const ORIGIN = 'https://pacosat.test';
const KEY = 'f'.repeat(64);
const OWN = 'MFI6212158B4';
const ROOT = import.meta.dirname;
const read = name => readFileSync(join(ROOT, name), 'utf8');
const PNG64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function makeHarness(options = {}) {
  const clock = { t: Date.parse('2026-11-14T16:00:00Z') };
  const service = createPacoSATService({
    dbFile: ':memory:', html: '<html><head><!--PACOSAT_TOKEN--></head><body>prueba</body></html>',
    origin: ORIGIN, proxyKey: KEY, satDocRetryWaitMs: 5,
    makeConnector: () => ({ parser: DOMParser, connector: {
      request: async () => 'req-b', check: async () => ({ status: 'pending', packages: [] }),
      download: async () => { throw new Error('sin paquetes'); } } }),
    makeMailer: () => ({ verify: async () => true, sendMail: async () => ({ messageId: 'm1' }) }),
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
  return { service, call, raw, exec, clock };
}
const unlock = async (h, rfc = OWN) => {
  const open = await h.call('POST', '/api/unlock', { rfc, minutes: 1440, days: 7,
    direction: 'both', password: 'simulated', certificate: 'YQ==', key: 'Yg==' });
  assert.equal(open.status, 200, 'unlock de ' + rfc);
};

/* ===== 1 · ESTÁTICAS + cabecera honesta (A1) ===== */
{
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.version, '2.0.1', 'la ronda es la 2.0.1');
  const ejecutor = read('ejecutor-local.mjs');
  assert.ok(ejecutor.includes("EJECUTOR_VERSION = '2.0.1'"), 'el ejecutor declara 2.0.1');
  const html = read('Faro-Fiscal.html');
  assert.ok(html.includes('"version":"2.0.1"'), 'el artefacto se sella 2.0.1');
  assert.ok(html.length <= 795000 || Buffer.byteLength(html) <= 800000, 'techo del artefacto (795.000 caracteres / 800.000 B, re-basificado en la fase 2 de cliente de la 2.0.1: el artefacto mide 794.528 caracteres / 798.249 B tras las piezas de cliente de las 30 mejoras (y la nº 31) en la parte principal —contabilidad en la re-base de ronda1110—; venía de 771.000 / 775.000 de la limpieza de esta misma ronda)');

  /* Cabecera ↔ despacho: para cada pantalla tocada por la
     auditoría, la etiqueta que primaryLabel promete y el gesto
     que primaryAction ejecuta constan AMBOS en el artefacto. */
  const pares = [
    ['Descargar CFDI del SAT', 'downloadSheet(scope)'],
    ['Consultar ahora', 'trib-consultar'],
    ['buzon-mark-all', 'buzon-mark-all'],
    ['Descargar Excel de saldos', "descargarSalida1310('salidas/xlsx', { kind: 'dinero' }"],
    ['Armar la lista del mes', 'pagos-armar'],
    ['Descargar declaraciones del SAT', 'decl-descargar'],
    ['Elegir el mes del cierre', 'cierreSection'],
    ['Descargar del SAT', 'invoiceScreen'],
  ];
  for (const [etiqueta, gesto] of pares)
    assert.ok(html.includes(etiqueta) && html.includes(gesto),
      'cabecera honesta: «' + etiqueta + '» promete y despacha (' + gesto + ')');
  assert.ok(!html.includes('Recibir CFDI'), '«Recibir CFDI» salió de las caras (S1)');
  assert.ok(!html.includes('Descargar el JSON (para el navegador del NAS)'), 'el JSON del NAS salió de Pagos (P2)');
  assert.ok(!html.includes('pacosat-secrets'), 'la carpeta interna no se nombra en las caras (X2)');
  assert.ok(!html.includes('criterios 5002'), '«criterios 5002» salió de Respaldos (X1)');
  const serverSrc = readFileSync(join(import.meta.dirname, 'local-server.mjs'), 'utf8');
  assert.ok(!serverSrc.includes("· ' + job.kind + ' de '") && !serverSrc.includes(": ' + row.kind + ' de '"),
    'las caras nunca enseñan la clase interna del trabajo (buzon-listar…): Actividad y Registro la nombran en humano');
  assert.ok(serverSrc.includes('trabajoHumano(row.kind)'), 'el Registro nombra el trabajo en humano');
  assert.ok(html.includes('Descargar declaraciones') && html.includes('salidasExportPanel'),
    'la exportación completa vive como panel propio para Respaldos (C1)');
  console.log('OK 1.32.1 · A1 — estáticas y cabecera honesta (etiqueta ↔ despacho).');
}

/* ===== 2 · A2 puerta veraz + B1 artefactos (servidor, ejecutor simulado) ===== */
{
  const h = makeHarness({ executorMode: 'remote' });
  await unlock(h);
  const par = await h.call('POST', '/api/executor/pair', { nombre: 'Equipo de Paco' });
  assert.equal(par.status, 200);
  const tokenEjecutor = par.json.token;
  const encolarReclamar = async (kind, payload = {}) => {
    const enc = await h.call('POST', '/api/executor/jobs', { rfc: OWN, kind, payload });
    assert.equal(enc.status, 200, 'se encola ' + kind);
    const claim = await h.exec('POST', '/api/executor/claim', { limit: 5 }, tokenEjecutor);
    const trabajo = claim.json.trabajos.find(t => t.id === enc.json.job.id);
    assert.ok(trabajo, 'el ejecutor reclama ' + kind);
    return trabajo;
  };
  const puerta = async () => (await h.call('GET', '/api/status')).json.puerta[OWN];

  /* Declaraciones entra bien y cae en la ruta muerta: la puerta
     queda «abre» y fresca (A2 por el corredor de declaraciones,
     cuyo espejo escribe decl_runs, no la rama genérica). */
  const urlMuerta = 'https://wwwmat.sat.gob.mx/aplicacion/77792/reimprime-tus-acuses-de-declaraciones-presentadas';
  const jobDecl = await encolarReclamar('declaraciones-recuperar', { ejercicio: 2026 });
  const falloDecl = await h.exec('POST', '/api/executor/result', { jobId: jobDecl.id, status: 'failed',
    result: { steps: [{ at: 1, paso: 'Acceso al portal OK', detalle: '' }], operations: ['entrar-con-efirma'],
      accesoOk: true,
      error: 'El portal devolvió «Página no encontrada» para ' + urlMuerta + ': esa dirección ya no responde.',
      errorKind: 'ruta-muerta',
      diag: { screenshotBase64: PNG64, html: '<html><body>Página no encontrada</body></html>', url: urlMuerta },
      diagDecision: { screenshotBase64: PNG64, html: '<html><body>Buzón Tributario de Mano Fil</body></html>',
        url: 'https://wwwmat.sat.gob.mx/app/seg/faces/pages/lanzador.jsf?tipologeo=c' } } }, tokenEjecutor);
  assert.equal(falloDecl.json.ok, false, 'el trabajo consta fallido en su corredor');
  let vista = await puerta();
  assert.equal(vista.ok, true, 'A2: acceso real de Declaraciones ⇒ puerta «abre» aunque el corredor caiga');
  assert.ok(vista.probada >= Date.parse('2026-11-14T15:59:00Z'), 'y el veredicto es fresco, no la foto vieja');

  /* B1 en el servidor: la corrida guarda las DOS páginas y el
     error nombra la URL muerta; el htmlId resuelve a un archivo. */
  const registro = (await h.call('GET', '/api/registro?limit=300')).json;
  const entrada = registro.items.find(item => /ruta|Página no encontrada/i.test(item.texto) && item.detalle);
  assert.ok(entrada, 'el fallo de Declaraciones está en el Registro con su detalle');
  assert.match(entrada.texto, /77792/, 'el error del Registro nombra la URL muerta');
  assert.equal(entrada.detalle.hasDecisionHtml, true, 'la página de decisión quedó guardada');
  assert.equal(entrada.detalle.hasDecisionShot, true, 'y su captura');
  const runId = entrada.evidencia.runId;
  const htmlFinal = await h.call('GET', '/api/declaraciones/artifact?run=' + runId + '&part=html');
  assert.equal(htmlFinal.status, 200, 'el htmlId de la corrida resuelve a un archivo existente');
  assert.match(htmlFinal.text, /no encontrada/, 'el archivo final ES la 404');
  const htmlDecision = await h.call('GET', '/api/declaraciones/artifact?run=' + runId + '&part=decision-html');
  assert.equal(htmlDecision.status, 200, 'la página de decisión se sirve');
  assert.match(htmlDecision.text, /Tributario de Mano Fil/, 'y es la portada desde la que se navegó');

  /* Un fallo EN la entrada: la puerta escribe «no abre» con el
     motivo real, aunque el trabajo sea de otro corredor. */
  const jobBuzon = await encolarReclamar('buzon-listar');
  const falloPuerta = await h.exec('POST', '/api/executor/result', { jobId: jobBuzon.id, status: 'failed',
    result: { steps: [{ at: 1, paso: 'Acceso', detalle: '' }], operations: ['entrar-con-efirma'],
      accesoFallo: true, error: 'El portal rechazó la e.firma de este RFC.', errorKind: 'credencial-invalida' } },
    tokenEjecutor);
  assert.equal(falloPuerta.json.ok, false);
  vista = await puerta();
  assert.equal(vista.ok, false, 'A2: el fallo en la entrada deja la puerta en «no abre»');
  assert.equal(vista.errorKind, 'credencial-invalida', 'con su clase real');
  assert.match(vista.error, /rechazó la e\.firma/, 'y su motivo real, no un genérico');

  /* puerta-probar sigue pudiendo decir «abre». */
  const jobProbar = await encolarReclamar('puerta-probar');
  const okProbar = await h.exec('POST', '/api/executor/result', { jobId: jobProbar.id, status: 'done',
    result: { steps: [], operations: ['entrar-con-efirma'], puerta: 'abre', accesoOk: true } }, tokenEjecutor);
  assert.equal(okProbar.json.ok, true);
  vista = await puerta();
  assert.equal(vista.ok, true, 'puerta-probar «abre» refresca el veredicto');
  await h.service.close();
  console.log('OK 1.32.1 · A2+B1 — puerta veraz en los dos sentidos y doble artefacto servible.');
}

/* ===== 3 · B1 motor: la 404 se clasifica «ruta-muerta» nombrando la URL ===== */
{
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const KEY_3DES = privateKey.export({ type: 'pkcs8', format: 'der', cipher: 'des-ede3-cbc', passphrase: 'buena-efirma' });
  const CREDS = { rfc: OWN, cer: Buffer.from('cer-juguete'), key: KEY_3DES, password: 'buena-efirma' };
  const URL404 = 'https://wwwmat.sat.gob.mx/aplicacion/77792/reimprime-tus-acuses-de-declaraciones-presentadas';
  class Pagina404 {
    constructor() { this.currentUrl = 'about:blank'; }
    async goto(url) { this.currentUrl = url; }
    url() { return this.currentUrl; }
    async clickButtonFiel() {}
    async fillFielForm() {}
    async submitFiel() { this.currentUrl = URL404; }
    async divError() { return ''; }
    async clickText() { return false; }
    async tramiteFrameUrl() { return ''; }
    async selectSelector() {}
    async clickSelector() {}
    async declResults() { return []; }
    async transacciones() { return []; }
    async diagnostics() { return { screenshot: Buffer.from(PNG64, 'base64'),
      html: '<html><head><title>Error</title></head><body>Página no encontrada</body></html>', url: URL404 }; }
    async close() {}
  }
  const page = new Pagina404();
  const fetchDecl = createSatDeclFetch({ resolveCredentials: async () => CREDS,
    launchDriver: async () => ({ newPage: async () => page, close: async () => {} }) });
  const error = await fetchDecl({ rfc: OWN }, { tipo: 'mensual', ejercicio: 2026 }).then(() => null, e => e);
  assert.ok(error instanceof SatDocError, 'el fallo es del motor');
  assert.equal(error.code, 'ruta-muerta', 'ante la 404 la clase es «ruta-muerta», no «enlace no encontrado»');
  assert.ok(error.message.includes(URL404), 'el mensaje NOMBRA la URL muerta');
  assert.ok(error.diag && String(error.diag.html).includes('Página no encontrada'), 'viaja la página final (la 404)');
  assert.ok(!error.diagDecision, 'y NO viaja página de decisión (re-basificado en la 2.0.1: la doble solo enseña la 404, así que la captura de decisión ES la página muerta y la fábrica la deja en null — el diario dirá honestamente que solo hay página final; con una captura viva sí viajaría)');
  console.log('OK 1.32.1 · B1 — el corredor clasifica la 404 como ruta muerta y guarda la página final (la decisión muerta no viaja: 2.0.1).');
}

/* ===== 4 · A3 Registro: borrar lo visible y deshacer ===== */
{
  const h = makeHarness({ executorMode: 'remote' });
  await unlock(h);
  /* Semilla: emparejar un ejecutor deja su apunte de auditoría —
     un suceso real del Registro con su clave estable. */
  const par = await h.call('POST', '/api/executor/pair', { nombre: 'Equipo de Paco' });
  assert.equal(par.status, 200);
  let registro = (await h.call('GET', '/api/registro?limit=300')).json;
  assert.ok(registro.items.length >= 1, 'hay sucesos sembrados por el propio uso');
  assert.ok(registro.items.every(item => typeof item.clave === 'string' && item.clave.length > 0),
    'toda entrada trae su clave estable');
  const claves = registro.items.map(item => item.clave);
  const textoAntes = registro.items.map(item => item.texto);
  const borrado = await h.call('POST', '/api/registro/borrar', { claves });
  assert.equal(borrado.status, 200);
  assert.equal(borrado.json.ocultadas, claves.length, 'se ocultan todas las pedidas');
  assert.ok(borrado.json.lote, 'el borrado vuelve con su lote');
  registro = (await h.call('GET', '/api/registro?limit=300')).json;
  assert.ok(!registro.items.some(item => textoAntes.includes(item.texto) && !/Registro:/.test(item.texto)),
    'lo borrado ya no se pinta (queda solo el apunte del propio borrado)');
  const deshecho = await h.call('POST', '/api/registro/deshacer', { lote: borrado.json.lote });
  assert.equal(deshecho.status, 200);
  assert.equal(deshecho.json.restauradas, claves.length, 'deshacer devuelve el lote entero');
  registro = (await h.call('GET', '/api/registro?limit=300')).json;
  assert.ok(textoAntes.every(texto => registro.items.some(item => item.texto === texto)),
    'tras deshacer, cada entrada vuelve tal cual');
  const vacio = await h.call('POST', '/api/registro/borrar', { claves: [] });
  assert.equal(vacio.status, 400, 'borrar sin claves no hace nada');
  await h.service.close();
  console.log('OK 1.32.1 · A3 — Registro: clave estable, borrar lo visible y deshacer íntegro.');
}

/* ===== 5 · B3 activación + solicitud registrada ===== */
const CER_REAL_1321 = 'MIIDUzCCAjugAwIBAgIUH2WzMvVXT5BC2dNEzTaqRKJcZVUwDQYJKoZIhvcNAQELBQAwOTEgMB4GA1UEAwwXRU1QUkVTQSBQUlVFQkEgU0EgREUgQ1YxFTATBgNVBAUTDE1GSTYyMTIxNThCNDAeFw0yNjExMDkwNTA0MzVaFw0zNjExMDYwNTA0MzVaMDkxIDAeBgNVBAMMF0VNUFJFU0EgUFJVRUJBIFNBIERFIENWMRUwEwYDVQQFEwxNRkk2MjEyMTU4QjQwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQDJv/UPUgh/H1XwYFWUj2DV8HVVL95Z3LSi7P5yC1m2hcXlGVyvrc9EwIxTYuKVndt3mZyafViTg7Zng3wPs/bkZIhWcXTBkFPy8/4OZF4HKhgQTByszYEqBo4hr6o98FqS638cXcIkAzKFaIhpIJUpFMmUyKlSLgdWRcW7gm4SF2TaWYWi5CBok6gSoWsbmvEdFa0BbSCTxUUOxxWeoqhaMeYgN+PYpLWkl8Iq7VZJ+JeH0LMvbKg6Bhug0KOnC3/yNSBDIrg+A1rOysN8JJOU76zPuqj6aki7+oAEZIpGcu6h3cri7S8qq3zYupFdmZHwRySGDRci3ZpyCqjlFB97AgMBAAGjUzBRMB0GA1UdDgQWBBQYRYXN6Lv4Ke+TNpNWj7H1tqkEpTAfBgNVHSMEGDAWgBQYRYXN6Lv4Ke+TNpNWj7H1tqkEpTAPBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUAA4IBAQC8EwF8xC42pm/jFhTaO/gp2LDiSfz5cIJyZe9XsbczupYA9moD0Y9qMdEFAqgSVmFqJNgE675d5meRJdvRariROlpN3BZfcvPDEqHnwjqzjgHBt9e+GYb8UzdvkWiJuN7hoWgs2m+AJdPnsIWopKVI8enqng9Un7LbzCkACmJuG03Y+N7uuT/jIE+hNBHLJI6S9CGGs3hr8S4eZ2ijQeYyrWtLoeadLFsp4QqDb/JqXGtrIWFH9p3TNDEvyyVsYUBXSBIxX9zf/EYQ9NMLqIVSJ5hR/GjmDPf0plFteYQZEhRohrXnAox6clkDaIqTJkzWHhY4PHCPn+sJAh+Jzz8Y';
{
  const dir = mkdtempSync(join(tmpdir(), 'pacosat-1321-b3-'));
  const llamadas = [];
  const reloj = { t: Date.parse('2026-11-14T16:00:00Z') };
  const service = createPacoSATService({
    dbFile: join(dir, 'b3.sqlite'), efirmaDir: join(dir, 'efirma'),
    html: '<html><head><!--PACOSAT_TOKEN--></head><body>prueba</body></html>',
    origin: ORIGIN, proxyKey: KEY, satDocRetryWaitMs: 5,
    makeConnector: async ({ password }) => {
      if (password === 'vieja') throw new Error('El certificado está caducado: no se pudo activar.');
      return { parser: DOMParser, connector: {
        request: async options => { llamadas.push(options); return 'req-1321-' + llamadas.length; },
        check: async () => ({ status: 'finished', packages: [] }),
        download: async () => { throw new Error('sin paquetes'); } } };
    },
    makeMailer: () => ({ verify: async () => true, sendMail: async () => ({}) }),
    now: () => reloj.t });
  let token = '';
  const raw = async (method, path, body) => {
    const chunks = []; if (body !== undefined) chunks.push(Buffer.from(JSON.stringify(body)));
    const req = Readable.from(chunks);
    req.method = method; req.url = path;
    req.headers = { host: 'pacosat.test', origin: ORIGIN, 'x-pacosat-proxy': KEY,
      ...(token ? { 'x-pacosat-token': token } : {}) };
    let status = 0; let text = '';
    const res = { writeHead(c) { status = c; }, setHeader() {}, getHeader() { return undefined; },
      end(chunk) { if (chunk) text += Buffer.isBuffer(chunk) ? chunk.toString('latin1') : chunk; } };
    await service.handle(req, res);
    return { status, text };
  };
  const call = async (method, path, body) => {
    if (!token) { const home = await raw('GET', '/'); token = /[0-9a-f]{64}/.exec(home.text)?.[0] || ''; }
    const r = await raw(method, path, body);
    let json = null; try { json = JSON.parse(r.text); } catch { /* binario */ }
    return { status: r.status, json, text: r.text };
  };
  try {
    /* Sin perfil activo, la solicitud no nace: se dice antes. */
    const sinPerfil = await call('POST', '/api/request', { rfc: OWN, direction: 'received',
      start: '2026-10-01', end: '2026-10-07' });
    assert.equal(sinPerfil.status, 400);
    assert.match(sinPerfil.json.error, /Desbloquea la e\.firma/, 'sin firmante activo, el motivo va primero');

    /* La buena entra por la app (almacén); el arranque apunta a
       la vieja caducada y su conector muere: manda el almacén. */
    const alta = await call('POST', '/api/efirma', { rfc: OWN, minutes: 1440, days: 7,
      direction: 'both', password: 'buena', certificate: CER_REAL_1321, key: 'Yg==' });
    assert.equal(alta.status, 200, 'el alta por la app funciona');
    const viejaCer = join(dir, 'arranque-vieja.cer'), viejaKey = join(dir, 'arranque-vieja.key');
    writeFileSync(viejaCer, Buffer.from('CERTIFICADO-VIEJO-2020'));
    writeFileSync(viejaKey, Buffer.from('LLAVE-VIEJA'));
    await service.bootstrap({ profiles: [{ rfc: OWN, name: 'MANO FIL SA', minutes: 360, days: 7,
      direction: 'received', certificatePath: viejaCer, keyPath: viejaKey, password: 'vieja' }] });
    let status = (await call('GET', '/api/status')).json;
    const perfil = (status.profiles || []).find(p => p.rfc === OWN);
    assert.equal(perfil.unlocked, true, 'B3: el perfil queda ACTIVO desde el almacén');
    assert.equal(status.arranque?.fallo?.ignorado, 1, 'el par de arranque consta IGNORADO');
    assert.match(status.arranque?.fallo?.causa || '', /caducado/, 'con su causa específica nombrada');

    /* La solicitud contra el doble del WS: nace, se procesa y
       QUEDA REGISTRADA en jobs y contada en el estado. */
    const pedida = await call('POST', '/api/request', { rfc: OWN, direction: 'received',
      start: '2026-10-01', end: '2026-10-07' });
    assert.equal(pedida.status, 200, 'con firmante activo la solicitud nace: ' + pedida.text.slice(0, 120));
    assert.equal(llamadas.length, 1, 'el WS del SAT (doble) recibió la solicitud firmada');
    reloj.t += 10 * 60000;
    await service.tick();
    await service.tick();
    status = (await call('GET', '/api/status')).json;
    const job = (status.jobs || []).find(j => j.rfc === OWN && j.kind === 'cfdi' &&
      j.direction === 'received' && j.periodStart === '2026-10-01' && j.periodEnd === '2026-10-07');
    assert.ok(job, 'la solicitud QUEDA REGISTRADA en el libro (jobs)');
    assert.equal(job.status, 'finished', 'y procesada hasta el final');
    assert.ok((status.criteriaBook || []).some(e => e.rfc === OWN && e.startAt === '2026-10-01 00:00:00' && e.count >= 1),
      'y contada en el libro de criterios: el envío consta, no se pierde');
    console.log('OK 1.32.1 · B3 — almacén manda, arranque caducado ignorado con causa, solicitud registrada.');
  } finally { service.close(); rmSync(dir, { recursive: true, force: true }); }
}
