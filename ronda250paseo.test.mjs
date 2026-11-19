/* ================================================================
   Ronda 2.8.0 · «Paseo en casa» — la sede del paseo al portal
   del SAT (Buzón Tributario y Declaraciones) como
   configuración por instalación.

   Lo que se juzga, con puertos falsos contadores (sin portal
   real: el camino probado es el ENRUTADO y la verdad en
   pantalla, no el DOM del SAT):
   (a) Sede NAS (executorMode 'nas'): buzon-listar y
       declaraciones-recuperar corren por la rama LOCAL — el
       puerto falso se invoca — y NO nace ningún trabajo para
       el ejecutor.
   (b) Sede REMOTA (executorMode 'remote'): las mismas
       peticiones crean trabajo de ejecutor (waitingExecutor)
       y NO invocan los puertos locales — el comportamiento
       exacto de la 2.4.0.
   (c) El helper de sede paseoSedeDesdeEntorno: ausente →
       remoto, 'nas' → nas, cualquier otro valor → remoto.
       Y el arranque lo usa y cablea los caminantes solo en
       sede NAS (fijado sobre el código del arranque).
   (d) El estado expone la sede (status, vistas de Buzón y
       Declaraciones, Salud) y el texto de Salud en sede NAS
       nombra el paseo desde casa / tu NAS sin mandar a la PC.
   (e) El artefacto construido contiene la ramificación de
       textos por sede EN TIEMPO DE EJECUCIÓN: la frase NAS
       existe en el HTML construido y cuelga del dato de
       estado (satData.paseo / data.paseo), no de un fijo.
   ================================================================ */
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DOMParser } from '@xmldom/xmldom';
import { createPacoSATService, paseoSedeDesdeEntorno } from './local-server.mjs';

const ORIGIN = 'https://pacosat.test';
const KEY = 'a'.repeat(64);
const OWN = 'AAA010101AAA';
const read = name => readFileSync(join(import.meta.dirname, name), 'utf8');

function makeHarness(options = {}) {
  const clock = { t: Date.parse('2026-11-17T15:00:00Z') };
  const service = createPacoSATService({
    dbFile: ':memory:', html: '<html><head><!--PACOSAT_TOKEN--></head><body>prueba</body></html>',
    origin: ORIGIN, proxyKey: KEY, satDocRetryWaitMs: 5,
    makeConnector: () => ({ parser: DOMParser, connector: {
      request: async () => 'req-250', check: async () => ({ status: 'pending', packages: [] }),
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
    return { status: r.status, json, text: r.text };
  };
  return { service, call, clock };
}
const unlock = async (h, rfc) => {
  const open = await h.call('POST', '/api/unlock', { rfc, minutes: 1440, days: 7,
    direction: 'both', password: 'simulated', certificate: 'YQ==', key: 'Yg==' });
  assert.equal(open.status, 200, 'unlock de ' + rfc);
};
/* Puertos falsos contadores: la misma firma que los motores
   de verdad ({rfc}, query, {onStep}). */
function puertosContadores() {
  const llamadas = { trib: 0, decl: 0 };
  return { llamadas,
    satTribFetch: async () => { llamadas.trib++; return { notifications: [], comunicadosNoLeidos: 0 }; },
    satDeclFetch: async () => { llamadas.decl++; return { found: 1, documents: [], warnings: [] }; } };
}

/* ===== (c) El helper de sede ===== */
{
  assert.equal(paseoSedeDesdeEntorno({}), 'remoto', '(c) sin PACOSAT_PASEO → remoto');
  assert.equal(paseoSedeDesdeEntorno({ PACOSAT_PASEO: 'nas' }), 'nas', "(c) 'nas' → nas");
  assert.equal(paseoSedeDesdeEntorno({ PACOSAT_PASEO: 'remoto' }), 'remoto', "(c) 'remoto' → remoto");
  assert.equal(paseoSedeDesdeEntorno({ PACOSAT_PASEO: 'cualquier-otra-cosa' }), 'remoto',
    '(c) cualquier otro valor → remoto (fallo seguro)');
  assert.equal(paseoSedeDesdeEntorno({ PACOSAT_PASEO: '' }), 'remoto', '(c) vacío → remoto');
  /* El arranque lo usa y cablea los caminantes SOLO en sede
     NAS, con el resolvedor/almacén/fábrica compartidos. */
  const servidor = read('local-server.mjs');
  assert.ok(servidor.includes('paseoSedeDesdeEntorno(process.env)'),
    '(c) el arranque lee la sede del entorno con el helper');
  assert.ok(servidor.includes("executorMode: paseoSede250 === 'nas' ? 'nas' : 'remote'"),
    '(c) el arranque fija executorMode según la sede (nas / remote)');
  assert.ok(servidor.includes('satTribFetch: createSatTribFetch({') &&
    servidor.includes('satDeclFetch: createSatDeclFetch({'),
    '(c) en sede NAS el arranque cablea satTribFetch y satDeclFetch');
  assert.ok(servidor.includes('resolveCredentials: efirmaResolver250, launchDriver: launchDriver250'),
    '(c) los caminantes comparten el resolvedor y la fábrica del arranque');
  console.log('OK 2.8.0 · (c) — helper de sede: ausente/otro → remoto, nas → nas; el arranque lo usa y cablea solo en NAS.');
}

/* ===== (a) Sede NAS: rama local, sin trabajos del ejecutor ===== */
{
  const puertos = puertosContadores();
  const h = makeHarness({ executorMode: 'nas', ...puertos });
  try {
    await unlock(h, OWN);
    const trib = await h.call('POST', '/api/tributario/run', { rfc: OWN });
    assert.equal(trib.status, 200);
    assert.equal(trib.json.result.ok, true, '(a) el Buzón corre y termina bien en sede NAS');
    assert.equal(trib.json.result.waitingExecutor, false, '(a) el Buzón NO espera a tu equipo en sede NAS');
    assert.equal(puertos.llamadas.trib, 1, '(a) el puerto local del Buzón se invocó (rama local)');
    assert.equal(trib.json.view.paseo, 'nas', '(a) la vista del Buzón expone la sede nas');

    const decl = await h.call('POST', '/api/declaraciones/run', { rfc: OWN, ejercicio: 2026, tipo: 'mensual' });
    assert.equal(decl.status, 200);
    assert.equal(decl.json.result.ok, true, '(a) Declaraciones corre y termina bien en sede NAS');
    assert.equal(decl.json.result.waitingExecutor, false, '(a) Declaraciones NO espera a tu equipo en sede NAS');
    assert.equal(puertos.llamadas.decl, 1, '(a) el puerto local de Declaraciones se invocó (rama local)');
    assert.equal(decl.json.view.paseo, 'nas', '(a) la vista de Declaraciones expone la sede nas');
    assert.equal(decl.json.view.configured, true, '(a) Declaraciones consta configurada en sede NAS');

    const overview = (await h.call('GET', '/api/executor/overview')).json;
    assert.equal(overview.paseo, 'nas', '(a) la vista del ejecutor expone la sede nas');
    assert.equal(overview.trabajos.filter(t => ['buzon-listar', 'declaraciones-recuperar'].includes(t.kind)).length, 0,
      '(a) NO nació ningún trabajo de paseo para el ejecutor');
    console.log('OK 2.8.0 · (a) — sede NAS: Buzón y Declaraciones por la rama local; cero trabajos del ejecutor.');
  } finally { h.service.close(); }
}

/* ===== (b) Sede remota: trabajos del ejecutor, puertos mudos ===== */
{
  const puertos = puertosContadores();
  const h = makeHarness({ executorMode: 'remote', ...puertos });
  try {
    await unlock(h, OWN);
    const trib = await h.call('POST', '/api/tributario/run', { rfc: OWN });
    assert.equal(trib.status, 200);
    assert.equal(trib.json.result.waitingExecutor, true, '(b) el Buzón queda esperando tu equipo en sede remota');
    assert.equal(puertos.llamadas.trib, 0, '(b) el puerto local del Buzón NO se invoca en sede remota');

    const decl = await h.call('POST', '/api/declaraciones/run', { rfc: OWN, ejercicio: 2026, tipo: 'mensual' });
    assert.equal(decl.status, 200);
    assert.equal(decl.json.result.waitingExecutor, true, '(b) Declaraciones queda esperando tu equipo en sede remota');
    assert.equal(puertos.llamadas.decl, 0, '(b) el puerto local de Declaraciones NO se invoca en sede remota');

    const overview = (await h.call('GET', '/api/executor/overview')).json;
    assert.equal(overview.paseo, 'remoto', '(b) la vista del ejecutor expone la sede remoto');
    assert.ok(overview.trabajos.some(t => t.kind === 'buzon-listar' && t.estado === 'en-cola'),
      '(b) nació el trabajo buzon-listar para el ejecutor');
    assert.ok(overview.trabajos.some(t => t.kind === 'declaraciones-recuperar' && t.estado === 'en-cola'),
      '(b) nació el trabajo declaraciones-recuperar para el ejecutor');
    console.log('OK 2.8.0 · (b) — sede remota: el comportamiento 2.4.0 exacto (cola del ejecutor, puertos locales mudos).');
  } finally { h.service.close(); }
}

/* ===== (d) El estado expone la sede y Salud dice la verdad NAS ===== */
{
  const puertos = puertosContadores();
  const h = makeHarness({ executorMode: 'nas', ...puertos });
  try {
    await unlock(h, OWN);
    const status = (await h.call('GET', '/api/status')).json;
    assert.equal(status.paseo, 'nas', '(d) /api/status expone paseo: nas');
    const salud = (await h.call('GET', '/api/salud')).json;
    assert.equal(salud.paseo, 'nas', '(d) /api/salud expone paseo: nas');
    const tarjeta = (salud.tarjetas || []).find(t => t.id === 'ejecutor');
    assert.ok(tarjeta, '(d) la tarjeta del ejecutor sigue existiendo en Salud (paridad)');
    assert.match(tarjeta.porque, /desde casa/, '(d) Salud nombra el paseo desde casa en sede NAS');
    assert.match(tarjeta.porque, /NAS/, '(d) Salud nombra tu NAS en sede NAS');
    assert.ok(!/empareja/i.test(tarjeta.porque) || /no hace falta/.test(tarjeta.porque),
      '(d) la tarjeta no manda a emparejar en sede NAS');
    const pasoConfig = (salud.config || []).find(p => p.id === 'ejecutor');
    assert.ok(pasoConfig && /desde casa/.test(pasoConfig.titulo + pasoConfig.detalle),
      '(d) el paso guiado de Salud cuenta el paseo desde casa en sede NAS');
    assert.equal(pasoConfig.hecho, true, '(d) el paso del paseo consta hecho por la sede, sin emparejar nada');
    for (const t of salud.tarjetas || [])
      assert.ok(!/Empareja tu PC|abre el ejecutor en tu PC/i.test(t.porque || ''),
        '(d) ninguna tarjeta de Salud manda a la PC en sede NAS: ' + t.id);
    console.log('OK 2.8.0 · (d) — estado con la sede y Salud en sede NAS: paseo desde casa, sin mandar a la PC.');
  } finally { h.service.close(); }
  /* Y en sede remota, Salud conserva los textos de la 2.4.0. */
  const h2 = makeHarness({ executorMode: 'remote', ...puertosContadores() });
  try {
    await unlock(h2, OWN);
    const status2 = (await h2.call('GET', '/api/status')).json;
    assert.equal(status2.paseo, 'remoto', '(d) /api/status expone paseo: remoto en sede remota');
    const salud2 = (await h2.call('GET', '/api/salud')).json;
    const tarjeta2 = (salud2.tarjetas || []).find(t => t.id === 'ejecutor');
    assert.match(tarjeta2.porque, /Todavía no has emparejado ningún equipo/,
      '(d) en sede remota la tarjeta del ejecutor dice lo de la 2.4.0');
    console.log('OK 2.8.0 · (d2) — sede remota: Salud conserva los textos de la 2.4.0.');
  } finally { h2.service.close(); }
}

/* ===== (e) El artefacto ramifica los textos por sede en vivo ===== */
{
  const html = read('Faro-Fiscal.html');
  const lazy = JSON.parse(read('lazy.json'));
  const todo = html + '\n' + Object.values(lazy.partes || {}).map(p => p.source || '').join('\n');
  assert.ok(todo.includes('el paseo se hace desde casa'),
    '(e) la frase del paseo desde casa existe en el artefacto construido');
  assert.ok(todo.includes("satData?.paseo === 'nas'") || todo.includes("satData.paseo === 'nas'"),
    '(e) la ramificación cuelga del dato de estado (satData.paseo), no de un texto fijo');
  assert.ok(todo.includes("data.paseo === 'nas'") || todo.includes("overview?.paseo"),
    '(e) las vistas servidas (ejecutor/declaraciones) también ramifican por su dato paseo');
  assert.ok(todo.includes('paseoNasCliente250'),
    '(e) el ayudante de sede del cliente viaja en el artefacto');
  assert.ok(todo.includes('Empareja tu equipo'),
    '(e) paridad: el texto remoto de emparejar sigue existiendo para la sede remota');
  console.log('OK 2.8.0 · (e) — artefacto: frase NAS presente y colgando del dato de estado; textos remotos intactos.');
}

console.log('ronda250paseo: OK — Paseo en casa: sede por instalación, rama local en NAS, cola remota intacta, verdad en pantalla.');
