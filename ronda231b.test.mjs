import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOMParser } from '@xmldom/xmldom';
import { createPacoSATService } from './local-server.mjs';
import {
  EJECUTOR_VERSION, FICHEROS_HUELLA231, huellaMotores, tocaActualizar,
  verificacionPostCopia, reporteVersion231,
} from './ejecutor-local.mjs';

/* ================================================================
   Ronda 2.3.1 · constructor B — la VERDAD DE VERSIÓN del ejecutor.

   Evidencia (17 nov 2026, diagnostico-231.md): la PC corría una
   instalación MEZCLADA — cáscara de la 2.3.0 con motores de la
   2.0.0 — y nadie lo vio: el sello de versión vive en la cáscara,
   la copia fichero a fichero pudo renovarla sin renovar los
   motores, y la tarjeta de Salud fijaba versionReportada: null.

   Lo que se juzga aquí:
   - Servidor: el latido con `reporte` { version, huella,
     actualizacion? } se sanea y se guarda (columna `reporte`,
     patrón de `residencia`); /api/status lo expone como
     ejecutor.versionReportada / huellaReportada / actualizacion;
     un latido sin reporte no borra el guardado; la transición a
     desajuste deja UN asiento de fallo en el Registro por par
     (versión, huella); /api/executor/version expone
     huellaMotores del manifiesto; la tarjeta de Salud del
     ejecutor marca el desajuste («mal», con su porqué y su
     gesto), el «sin reporte» («vigilar») y el «al día» («bien»).
   - Ejecutor: huellaMotores es estable y sensible a cualquier
     motor (y a su ausencia, sin explotar); tocaActualizar
     decide por versión y por huella; verificacionPostCopia
     recomputa desde el disco. La verificación post-copia se
     ejercita en unidad con directorios temporales (el flujo de
     red de la actualización no se toca en la suite) y su
     cableado en el flujo se afirma sobre el código.
   El manifiesto real del árbol (ejecutor-bundle.json) manda en
   lo esperado: el arnés no permite sustituir el bundle, así que
   la lectura de huellaMotores se prueba contra ese manifiesto
   tal cual está (hoy sin huellaMotores: la respuesta debe
   traer la cadena vacía, sin inventar ninguna).
   ================================================================ */

const AQUI = dirname(fileURLToPath(import.meta.url));
const leer = nombre => readFileSync(join(AQUI, nombre), 'utf8');
/* Integración 2.3.1: la batería de la casa corre SIN el paquete
   del ejecutor en la raíz del árbol — sin manifiesto, lo
   esperado del servidor es la cadena vacía en versión y huella
   (su contrato «sin paquete publicado»), y la suite lo afirma
   así en vez de morir abriendo un fichero que no está. Con el
   manifiesto colocado, manda el manifiesto. */
const MANIFIESTO = existsSync(join(AQUI, 'ejecutor-bundle.json'))
  ? JSON.parse(leer('ejecutor-bundle.json')) : {};
const VERSION_PAQUETE = String(MANIFIESTO.version || '');
const HUELLA_PAQUETE = String(MANIFIESTO.huellaMotores || '');
/* Integración 2.3.2: la huella del paquete COMPLETO (M-2) que
   el manifiesto traiga — hoy el manifiesto del árbol aún no
   la trae (es anterior a la 2.3.2): lo esperado es la cadena
   vacía, sin inventar ninguna, como con huellaMotores en su
   día. Cuando el paquete 2.3.2 se coloque y el manifiesto la
   traiga, esta misma constante manda y el caso S3 la exige. */
const HUELLA_PAQUETE_COMPLETO232 = String(MANIFIESTO.huellaPaquete || '');
/* Los escenarios S1/S2 juzgan contra el paquete guardado: sin
   manifiesto en el árbol (modo batería) no hay paquete contra
   el que desajustar, y se omiten CON CONSTANCIA impresa — el
   patrón de la casa —; con el paquete colocado corren enteros
   (la pasada integrada). S3 y E1–E3 corren en ambos modos. */
const CON_PAQUETE231 = VERSION_PAQUETE !== '';
const ORIGIN = 'https://pacosat.test';
const KEY = 'b'.repeat(64);
const OWN = 'AAA010101AAA';
const HUELLA_A = 'a'.repeat(64);
const HUELLA_B = 'b'.repeat(64);

function makeHarness(options = {}) {
  const clock = { t: Date.parse('2026-11-17T15:00:00Z') };
  const service = createPacoSATService({
    dbFile: ':memory:', html: '<html><head><!--PACOSAT_TOKEN--></head><body>prueba</body></html>',
    origin: ORIGIN, proxyKey: KEY, satDocRetryWaitMs: 5,
    makeConnector: () => ({ parser: DOMParser, connector: {
      request: async () => 'req-231b-1', check: async () => ({ status: 'pending', packages: [] }),
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
  const exec = async (method, path, body, execToken) => {
    const r = await raw(method, path, body, execToken ? { 'x-pacosat-executor': execToken } : {});
    let json = null; try { json = JSON.parse(r.text); } catch { /* binario */ }
    return { status: r.status, json, text: r.text };
  };
  return { service, call, exec, clock };
}
const unlock = async (h, rfc) => {
  const open = await h.call('POST', '/api/unlock', { rfc, minutes: 1440, days: 7,
    direction: 'both', password: 'simulated', certificate: 'YQ==', key: 'Yg==' });
  assert.equal(open.status, 200, 'unlock de ' + rfc);
};
const emparejar = async h => {
  const par = await h.call('POST', '/api/executor/pair', { nombre: 'Equipo de Paco' });
  assert.ok(par.json.token, 'ejecutor emparejado');
  return par.json.token;
};
const tarjetaEjecutor = async h => {
  const salud = (await h.call('GET', '/api/salud')).json;
  const tarjeta = (salud.tarjetas || []).find(t => t.id === 'ejecutor');
  assert.ok(tarjeta, 'la tarjeta del ejecutor existe en Salud');
  return tarjeta;
};
const asientosDesajuste = async h => {
  const registro = (await h.call('GET', '/api/registro?texto=no%20corre%20el%20paquete&limit=100')).json;
  return (registro.items || []).filter(i => String(i.texto || '').includes('no corre el paquete guardado'));
};

/* ---------- S1 · Latido con reporte desajustado: se guarda, Salud lo marca, el asiento sale una vez por par ---------- */
if (CON_PAQUETE231) {
  const h = makeHarness({ executorMode: 'remote' });
  await unlock(h, OWN);
  const execToken = await emparejar(h);

  await h.exec('POST', '/api/executor/heartbeat', {}, execToken);
  let estado = (await h.call('GET', '/api/status')).json;
  assert.equal(estado.ejecutor.versionReportada, null, 'sin reporte, versionReportada es null: no consta');
  assert.equal(estado.ejecutor.huellaReportada, null, 'sin reporte, huellaReportada es null');

  const latido = await h.exec('POST', '/api/executor/heartbeat',
    { reporte: { version: '2.0.0', huella: HUELLA_A,
      actualizacion: { estado: 'fallo', detalle: 'x'.repeat(300) } } }, execToken);
  assert.equal(latido.json.ok, true, 'el latido con reporte se acepta');
  estado = (await h.call('GET', '/api/status')).json;
  assert.equal(estado.ejecutor.versionReportada, '2.0.0', 'la versión reportada sale en /api/status');
  assert.equal(estado.ejecutor.huellaReportada, HUELLA_A, 'la huella reportada sale en /api/status');
  assert.equal(estado.ejecutor.actualizacion.estado, 'fallo', 'la novedad de actualización viaja');
  assert.equal(estado.ejecutor.actualizacion.detalle.length, 200, 'el detalle se recorta a 200 caracteres');

  const tarjeta = await tarjetaEjecutor(h);
  assert.equal(tarjeta.estado, 'mal', 'emparejado, en línea y con desajuste de versión: la tarjeta está mal');
  assert.equal(tarjeta.datos.versionReportada, '2.0.0', 'la tarjeta ya no fija versionReportada a null: trae la real');
  assert.ok(tarjeta.porque.includes('2.0.0'), 'el porqué dice qué corre: ' + tarjeta.porque);
  assert.ok(tarjeta.porque.includes(VERSION_PAQUETE), 'el porqué dice qué debería correr (el paquete ' + VERSION_PAQUETE + ')');
  assert.match(tarjeta.porque, /cierra el ejecutor y vuelve a abrirlo/i, 'el porqué trae el gesto único: reabrir');
  assert.ok('huellaOk' in tarjeta.datos, 'huellaOk viaja en datos');
  assert.equal(tarjeta.datos.huellaOk, HUELLA_PAQUETE ? false : null,
    'huellaOk: false si el paquete anuncia huella y no coincide; null si el paquete no anuncia ninguna');

  assert.equal((await asientosDesajuste(h)).length, 1, 'la transición a desajuste deja UN asiento de fallo');
  await h.exec('POST', '/api/executor/heartbeat',
    { reporte: { version: '2.0.0', huella: HUELLA_A } }, execToken);
  assert.equal((await asientosDesajuste(h)).length, 1, 'mismo par (versión, huella): mismo silencio, sin spam');

  await h.exec('POST', '/api/executor/heartbeat', {}, execToken);
  estado = (await h.call('GET', '/api/status')).json;
  assert.equal(estado.ejecutor.versionReportada, '2.0.0', 'un latido sin reporte NO borra el último reporte');
  assert.equal(estado.ejecutor.huellaReportada, HUELLA_A, 'ni su huella');

  await h.exec('POST', '/api/executor/heartbeat',
    { reporte: { version: '2.0.0', huella: HUELLA_B } }, execToken);
  assert.equal((await asientosDesajuste(h)).length, 2, 'un par distinto en desajuste cuenta su transición: un asiento más');
  await h.service.close();
  console.log('OK 2.3.1 B · S1 — reporte guardado y expuesto; Salud marca el desajuste con porqué y gesto; asiento una vez por par; sin reporte no se borra.');
} else {
  console.log('CONSTANCIA 2.3.1 B · S1 — omitido en modo batería (sin manifiesto del ejecutor en el árbol): corre entero en la pasada integrada, con el paquete colocado.');
}

/* ---------- S2 · Sin reporte: «vigilar». Al día: «bien». Saneo del reporte ---------- */
if (CON_PAQUETE231) {
  const h = makeHarness({ executorMode: 'remote' });
  await unlock(h, OWN);
  const execToken = await emparejar(h);
  await h.exec('POST', '/api/executor/heartbeat', {}, execToken);

  let tarjeta = await tarjetaEjecutor(h);
  assert.equal(tarjeta.estado, 'vigilar', 'en línea y sin reporte (ejecutor anterior a la 2.3.1): vigilar');
  assert.match(tarjeta.porque, /aún no dice qué versión corre/, 'el porqué dice que aún no reporta su versión');
  assert.match(tarjeta.porque, /se pondrá al día al cerrarlo y volver a abrirlo/i, 'y que se pone al día al reabrirlo');
  assert.equal(tarjeta.datos.versionReportada, null, 'sin reporte, la tarjeta trae null, no una versión inventada');

  /* Saneo: un reporte sin la forma del contrato no se guarda. */
  await h.exec('POST', '/api/executor/heartbeat',
    { reporte: { version: '2.0', huella: 'ZZZ-no-es-hex' } }, execToken);
  let estado = (await h.call('GET', '/api/status')).json;
  assert.equal(estado.ejecutor.versionReportada, null, 'un reporte con versión/huella fuera de forma no se guarda');
  /* Integración 2.3.1: la huella de este paso es la del paquete
     cuando el manifiesto la anuncia (si no, una válida cualquiera):
     el paso juzga el SANEO de la novedad, no el desajuste — con una
     huella ajena el servidor asentaría, con razón, una transición
     a desajuste y el conteo final de asientos dejaría de ser cero. */
  await h.exec('POST', '/api/executor/heartbeat',
    { reporte: { version: VERSION_PAQUETE, huella: HUELLA_PAQUETE || HUELLA_A, actualizacion: { estado: 'raro', detalle: 'no vale' } } }, execToken);
  estado = (await h.call('GET', '/api/status')).json;
  assert.equal(estado.ejecutor.versionReportada, VERSION_PAQUETE, 'el reporte con la forma sí se guarda');
  assert.equal(estado.ejecutor.actualizacion, null, 'una novedad con estado fuera de (fallo|pendiente) no viaja');

  /* Al día: la versión del paquete y, si el manifiesto anuncia
     huella, la suya; si no la anuncia, manda la versión. */
  await h.exec('POST', '/api/executor/heartbeat',
    { reporte: { version: VERSION_PAQUETE, huella: HUELLA_PAQUETE || HUELLA_A } }, execToken);
  tarjeta = await tarjetaEjecutor(h);
  assert.equal(tarjeta.estado, 'bien', 'en línea y al día con el paquete: el «bien» de siempre');
  assert.equal(tarjeta.datos.versionReportada, VERSION_PAQUETE);
  assert.equal((await asientosDesajuste(h)).length, 0, 'al día no deja ningún asiento de desajuste');
  await h.service.close();
  console.log('OK 2.3.1 B · S2 — sin reporte, vigilar; reporte fuera de forma, fuera; al día, bien y sin asientos.');
} else {
  console.log('CONSTANCIA 2.3.1 B · S2 — omitido en modo batería (sin manifiesto del ejecutor en el árbol): corre entero en la pasada integrada, con el paquete colocado.');
}

/* ---------- S3 · /api/executor/version expone la huella de motores del manifiesto real ---------- */
{
  const h = makeHarness({ executorMode: 'remote' });
  await unlock(h, OWN);
  const execToken = await emparejar(h);
  const version = await h.exec('POST', '/api/executor/version', {}, execToken);
  assert.equal(version.status, 200, 'el endpoint de versión responde al ejecutor');
  assert.ok('huellaMotores' in version.json, 'la respuesta trae el campo huellaMotores');
  assert.equal(version.json.version, VERSION_PAQUETE, 'la versión es la del manifiesto real del árbol');
  assert.equal(version.json.huellaMotores, HUELLA_PAQUETE,
    'huellaMotores es la del manifiesto real (hoy: cadena vacía, porque el manifiesto aún no la trae)');
  /* Integración 2.3.2 · huellaPaquete (M-2): el ejecutor de
     B2a decide también por la huella del paquete completo
     (decisionActualizacion232) y la verifica en staging
     (verificarStaging232), pero la respuesta no la traía:
     el manifiesto la podía traer y se quedaba en el servidor.
     Ahora viaja tal cual la trae el manifiesto — y cuando el
     manifiesto no la trae, cadena vacía y nada más cambia. */
  assert.ok('huellaPaquete' in version.json, 'la respuesta trae el campo huellaPaquete');
  assert.equal(version.json.huellaPaquete, HUELLA_PAQUETE_COMPLETO232,
    'huellaPaquete es la del manifiesto real (hoy: cadena vacía, porque el manifiesto del árbol aún no la trae)');
  const fuenteServidor = leer('local-server.mjs');
  assert.ok(fuenteServidor.includes("huellaPaquete: String(manifest?.huellaPaquete || '')"),
    'el endpoint pasa huellaPaquete DESDE el manifiesto, no un valor fijo');
  assert.ok(fuenteServidor.includes('huellaPaquete: /^[0-9a-f]{64}$/'),
    'bundleEjecutor231 también expone huellaPaquete del manifiesto (hex de 64 o cadena vacía)');
  await h.service.close();
  console.log('OK 2.3.1 B · S3 — /api/executor/version expone huellaMotores y huellaPaquete leídas del manifiesto real del árbol.');
}

/* ---------- E1 · huellaMotores: estable, sensible y tolerante a ausencias ---------- */
{
  assert.deepEqual(FICHEROS_HUELLA231, ['ejecutor-local.mjs', 'sat-tributario.mjs', 'sat-declaraciones.mjs',
    'sat-doc-browser.mjs', 'sat-doc-fetch.mjs', 'sat-executor.mjs', 'secret-box.mjs', 'registro-windows.mjs'],
    'la huella cubre, en orden fijo, los ficheros de programa que mandan en el comportamiento');
  const tmp = mkdtempSync(join(tmpdir(), 'pacosat-huella231-'));
  try {
    for (const nombre of FICHEROS_HUELLA231) copyFileSync(join(AQUI, nombre), join(tmp, nombre));
    const h1 = huellaMotores(tmp);
    assert.match(h1, /^[0-9a-f]{64}$/, 'la huella es un sha256 en hex');
    assert.equal(huellaMotores(tmp), h1, 'la huella es estable sobre la misma carpeta');
    appendFileSync(join(tmp, 'sat-tributario.mjs'), '\n/* cambio */\n');
    const h2 = huellaMotores(tmp);
    assert.notEqual(h2, h1, 'si cambia un motor, la huella cambia: la instalación mezclada se delata');
    unlinkSync(join(tmp, 'sat-executor.mjs'));
    const h3 = huellaMotores(tmp);
    assert.match(h3, /^[0-9a-f]{64}$/, 'un fichero ausente no explota: la huella sale igual');
    assert.notEqual(h3, h2, 'y la ausencia también cambia la huella (marca de ausencia)');
  } finally { rmSync(tmp, { recursive: true, force: true }); }
  assert.equal(huellaMotores(AQUI), huellaMotores(AQUI), 'la huella del árbol es estable');
  console.log('OK 2.3.1 B · E1 — huellaMotores estable, sensible a cambios y a ausencias.');
}

/* ---------- E2 · tocaActualizar: la decisión pura ---------- */
{
  const propia = { version: '2.3.0', huella: HUELLA_A };
  assert.equal(tocaActualizar({ version: '2.3.1' }, propia), true, 'versión mayor anunciada: se actualiza');
  assert.equal(tocaActualizar({ version: '2.3.0', huellaMotores: HUELLA_B }, propia), true,
    'misma versión y huella distinta: instalación mezclada, se reinstala');
  assert.equal(tocaActualizar({ version: '2.3.0', huellaMotores: HUELLA_A }, propia), false,
    'misma versión y misma huella: nada que hacer');
  assert.equal(tocaActualizar({ version: '2.3.0' }, propia), false,
    'sin huella anunciada, manda la versión: a igual versión no se actualiza');
  assert.equal(tocaActualizar({ version: '2.3.1' }, propia), true,
    'sin huella anunciada, manda la versión: a versión mayor sí');
  assert.equal(tocaActualizar({ version: '2.2.0', huellaMotores: HUELLA_B }, propia), false,
    'nunca se baja de versión, ni con huella distinta');
  assert.equal(tocaActualizar({}, propia), false, 'sin versión anunciada no hay actualización');
  assert.equal(tocaActualizar(null, propia), false, 'sin respuesta del servidor no hay actualización');
  console.log('OK 2.3.1 B · E2 — tocaActualizar decide por versión y por huella.');
}

/* ---------- E3 · verificacionPostCopia (unidad, directorios temporales) y su cableado ---------- */
{
  const tmp = mkdtempSync(join(tmpdir(), 'pacosat-postcopia231-'));
  try {
    for (const nombre of FICHEROS_HUELLA231) copyFileSync(join(AQUI, nombre), join(tmp, nombre));
    const esperada = huellaMotores(tmp);
    const buena = verificacionPostCopia(tmp, esperada);
    assert.equal(buena.ok, true, 'tras una copia fiel, la huella recomputada coincide con la anunciada');
    assert.equal(buena.huella, esperada);
    appendFileSync(join(tmp, 'sat-declaraciones.mjs'), '\n/* copia parcial */\n');
    const mala = verificacionPostCopia(tmp, esperada);
    assert.equal(mala.ok, false, 'si un motor quedó viejo tras copiar, la verificación lo caza');
    assert.equal(mala.huella, huellaMotores(tmp), 'y devuelve la huella real del disco');
    assert.equal(verificacionPostCopia(tmp, '').ok, false, 'sin huella anunciada no hay verificación que valga');
  } finally { rmSync(tmp, { recursive: true, force: true }); }

  /* El cableado en el flujo real (solo lectura del código): la
     verificación corre tras copiar y ANTES del éxito; el fallo
     se anota para el reporte del latido y no se sale como
     actualizado; el latido manda el reporte; las protecciones
     de siempre (efirma-local y PRESERVADOS_UPDATE) quedan. */
  const fuente = leer('ejecutor-local.mjs');
  const idxCopia = fuente.indexOf('copiar(tmpDir, HERE);');
  const idxVerif = fuente.indexOf('verificacionPostCopia(HERE, info.huellaMotores)');
  const idxExito = fuente.indexOf("console.log('[ejecutor] actualizado a la versión '");
  assert.ok(idxCopia >= 0 && idxVerif > idxCopia, 'la verificación post-copia corre tras copiar');
  assert.ok(idxExito > idxVerif, 'y antes de anunciar el éxito y salir como actualizado');
  const bloqueVerif = fuente.slice(idxVerif, idxExito);
  assert.ok(bloqueVerif.includes("anotarActualizacion231('fallo'"), 'si no coincide, el fallo se anota para el reporte del latido');
  assert.ok(bloqueVerif.includes('return;'), 'y la función vuelve sin darse por actualizada');
  assert.ok(fuente.includes("reporte: reporteVersion231()"), 'el latido manda el reporte de versión');
  assert.ok(fuente.includes("nombre.name === 'efirma-local' || PRESERVADOS_UPDATE.has(nombre.name)"),
    'las protecciones quedan intactas: efirma-local y los preservados jamás se sobrescriben');
  const reporte = reporteVersion231(AQUI);
  assert.equal(reporte.version, EJECUTOR_VERSION, 'el reporte lleva la versión propia');
  assert.equal(reporte.huella, huellaMotores(AQUI), 'y la huella de los motores de esta carpeta');
  assert.ok(!('actualizacion' in reporte), 'sin novedad de actualización, el campo no viaja');
  console.log('OK 2.3.1 B · E3 — verificacionPostCopia en unidad y su cableado en el flujo, con las protecciones intactas.');
}

console.log('Ronda 2.3.1 · constructor B: batería completa en verde.');
