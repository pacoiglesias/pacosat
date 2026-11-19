import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { DOMParser } from '@xmldom/xmldom';
import { createPacoSATService } from './local-server.mjs';

/* ================================================================
   Ronda 2.3.2 · constructor B2b — el ECO del ejecutor: que un
   desajuste no pueda durar en silencio.

   Lo que se juzga aquí (M-3, m-18, m-19 mitad servidor, o-5):
   - ECO1 · Escalado temporal: el tick del servidor (reloj falso)
     manda UN correo a las ≥4 h de desajuste por clave completa
     y solo uno; a los 7 días DEL PRIMER CORREO (D-4,
     desajusteAvisadoEn — no del inicio del desajuste), UN
     recordatorio; cada correo deja su asiento; al sanar, el
     seguimiento se limpia y un desajuste nuevo con el mismo
     par abre un ciclo nuevo. Y ECO1b: con el correo apagado
     más de 7 días, el primer aviso sale al encenderlo (día 8)
     y el recordatorio no llega antes del día 15.
   - ECO2 · Clave completa en el asiento (m-18): (b) cambia solo
     la causa (el detalle) → asiento nuevo; (a) el paquete del
     servidor avanza y el ejecutor sigue en el mismo par viejo →
     asiento nuevo (el avance se simula reescribiendo la clave
     guardada tal como quedó con el paquete anterior, que es su
     única huella persistida); misma clave → silencio.
   - ECO3 · «En línea sin reporte» (m-18): asienta UNA vez por
     ejecutor, la marca persiste (no se repite tras un reinicio
     simulado del servidor sobre la misma base) y al por fin
     reportar (al día) asienta de nuevo.
   - ECO4 · Saneo por tokens al guardar (m-19): una ruta
     absoluta de juguete en el detalle no llega a /api/status:
     colapso de blancos y último segmento por palabra con barras.
   - ECO5 · El peor manda (o-5): con dos ejecutores, /api/status
     y Salud juzgan el desajuste aunque el sano late después;
     «sin reporte» gana a «al día» y pierde contra «desajuste».
   - ECO6 · Red semanal (M-3): la tarjeta ejecutor en desajuste
     entra en las rotas del correo de autorreparación semanal.
   El manifiesto real del árbol manda en lo esperado (patrón de
   ronda231b): sin manifiesto, los escenarios de paquete se
   omiten con constancia impresa.
   ================================================================ */

const AQUI = dirname(fileURLToPath(import.meta.url));
const leer = nombre => readFileSync(join(AQUI, nombre), 'utf8');
const MANIFIESTO = existsSync(join(AQUI, 'ejecutor-bundle.json'))
  ? JSON.parse(leer('ejecutor-bundle.json')) : {};
const VERSION_PAQUETE = String(MANIFIESTO.version || '');
const HUELLA_PAQUETE = String(MANIFIESTO.huellaMotores || '');
const CON_PAQUETE = VERSION_PAQUETE !== '' && HUELLA_PAQUETE !== '';
const ORIGIN = 'https://pacosat.test';
const KEY = 'b'.repeat(64);
const OWN = 'AAA010101AAA';
const HUELLA_A = 'a'.repeat(64);
const HOUR = 3600000;
const DAY = 86400000;
const T0 = Date.parse('2026-11-17T15:00:00Z'); // martes 17 nov 2026, 09:00 CST

function makeHarness(options = {}) {
  const clock = { t: options.start ?? T0 };
  const mails = [];
  const service = createPacoSATService({
    dbFile: options.dbFile || ':memory:',
    html: '<html><head><!--PACOSAT_TOKEN--></head><body>prueba</body></html>',
    origin: ORIGIN, proxyKey: KEY, satDocRetryWaitMs: 5,
    makeConnector: () => ({ parser: DOMParser, connector: {
      request: async () => 'req-232eco-1', check: async () => ({ status: 'pending', packages: [] }),
      download: async () => { throw new Error('sin paquetes'); } } }),
    makeMailer: () => ({ verify: async () => true,
      sendMail: async payload => { mails.push(payload); return { messageId: 'm' + mails.length }; } }),
    now: () => clock.t, executorMode: 'remote' });
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
  return { service, call, exec, clock, mails };
}
const unlock = async (h, rfc = OWN) => {
  const open = await h.call('POST', '/api/unlock', { rfc, minutes: 1440, days: 7,
    direction: 'both', password: 'simulated', certificate: 'YQ==', key: 'Yg==' });
  assert.equal(open.status, 200, 'unlock de ' + rfc);
};
const configurarCorreo = async h => {
  const r = await h.call('POST', '/api/mail', { host: 'smtp.example.com', port: 587,
    from: 'avisos@pacosat.test', recipient: 'paco@test.mx', user: '', password: '' });
  assert.equal(r.status, 200, 'el correo de juguete se configura');
};
const emparejar = async (h, nombre = 'Equipo de Paco') => {
  const par = await h.call('POST', '/api/executor/pair', { nombre });
  assert.ok(par.json.token, 'ejecutor emparejado');
  return par.json.token;
};
const latido = async (h, execToken, reporte) => {
  const r = await h.exec('POST', '/api/executor/heartbeat',
    reporte === undefined ? {} : { reporte }, execToken);
  assert.equal(r.json.ok, true, 'el latido se acepta');
};
const asientos = async (h, aguja) => {
  const registro = (await h.call('GET',
    '/api/registro?texto=' + encodeURIComponent(aguja) + '&limit=200')).json;
  return (registro.items || []).filter(i => String(i.texto || '').includes(aguja));
};
const asientosDesajuste = h => asientos(h, 'no corre el paquete guardado');
const asientosCorreo = h => asientos(h, 'desajuste persistente');
const correosDesajuste = h => h.mails.filter(m =>
  /no corre el paquete que deber| sigue sin correr el paquete/.test(String(m.subject || '')));
const tarjetaEjecutor = async h => {
  const salud = (await h.call('GET', '/api/salud')).json;
  const tarjeta = (salud.tarjetas || []).find(t => t.id === 'ejecutor');
  assert.ok(tarjeta, 'la tarjeta del ejecutor existe en Salud');
  return tarjeta;
};
const REPORTE_VIEJO = { version: '2.0.0', huella: HUELLA_A };
const REPORTE_AL_DIA = () => ({ version: VERSION_PAQUETE, huella: HUELLA_PAQUETE });

if (CON_PAQUETE) {

/* ---------- ECO1 · Escalado: 4 h → un correo; 7 días → recordatorio; al sanar se limpia ---------- */
{
  const h = makeHarness();
  await unlock(h);
  const execToken = await emparejar(h);
  await configurarCorreo(h);

  await latido(h, execToken, REPORTE_VIEJO);
  await h.service.tick();
  assert.equal(correosDesajuste(h).length, 0, 'recién desajustado no sale correo: aún no dura 4 h');

  h.clock.t = T0 + 4 * HOUR;
  await latido(h, execToken, REPORTE_VIEJO);
  await h.service.tick();
  const correos = correosDesajuste(h);
  assert.equal(correos.length, 1, 'a las 4 h sale UN correo por el desajuste');
  const texto = String(correos[0].text || '');
  assert.ok(texto.includes('2.0.0'), 'el correo dice qué corre (versión): ' + texto);
  assert.ok(texto.includes(HUELLA_A.slice(0, 12)), 'y su huella corta');
  assert.ok(texto.includes(VERSION_PAQUETE), 'dice qué debería correr (versión del paquete)');
  assert.ok(texto.includes(HUELLA_PAQUETE.slice(0, 12)), 'y la huella del paquete');
  assert.ok(texto.includes('17 nov, 09:00'), 'dice desde cuándo (el primer latido de la clave): ' + texto);
  assert.match(texto, /cierra el ejecutor y vuelve a abrirlo/i, 'trae el gesto único');
  assert.equal((await asientosCorreo(h)).length, 1, 'el correo enviado deja su asiento en el Registro');

  await h.service.tick();
  assert.equal(correosDesajuste(h).length, 1, 'otro tick con la misma clave no repite el correo');
  assert.equal((await asientosCorreo(h)).length, 1, 'ni su asiento');

  /* D-4: el recordatorio se mide desde el PRIMER CORREO
     (T0+4 h), no desde el inicio del desajuste: a los 7 días
     del desajuste aún no toca… */
  h.clock.t = T0 + 7 * DAY;
  await latido(h, execToken, REPORTE_VIEJO);
  await h.service.tick();
  assert.equal(correosDesajuste(h).length, 1,
    'D-4: a los 7 días del desajuste NO sale recordatorio: faltan 4 h para los 7 días del primer aviso');
  /* …y a los 7 días del primer aviso, sí, uno solo. */
  h.clock.t = T0 + 7 * DAY + 4 * HOUR;
  await latido(h, execToken, REPORTE_VIEJO);
  await h.service.tick();
  assert.equal(correosDesajuste(h).length, 2, 'a los 7 días del primer aviso sale el recordatorio, uno');
  assert.match(String(correosDesajuste(h)[1].subject || ''), /Recordatorio/,
    'el segundo correo es el recordatorio');
  assert.equal((await asientosCorreo(h)).length, 2, 'el recordatorio también deja su asiento');
  await h.service.tick();
  assert.equal(correosDesajuste(h).length, 2, 'y no se repite');

  /* Al sanar, el seguimiento se limpia: el mismo par viejo,
     desajustado de nuevo, abre un ciclo con su propio «desde». */
  await latido(h, execToken, REPORTE_AL_DIA());
  await h.service.tick();
  assert.equal(correosDesajuste(h).length, 2, 'al día no sale ningún correo nuevo');
  const T1 = T0 + 7 * DAY + 5 * HOUR;
  h.clock.t = T1;
  await latido(h, execToken, REPORTE_VIEJO);
  await h.service.tick();
  assert.equal(correosDesajuste(h).length, 2, 'el ciclo nuevo nace sin correo: su «desde» es nuevo');
  h.clock.t = T1 + 4 * HOUR - 60000;
  await latido(h, execToken, REPORTE_VIEJO);
  await h.service.tick();
  assert.equal(correosDesajuste(h).length, 2, 'a las 3 h 59 min del ciclo nuevo aún no toca');
  h.clock.t = T1 + 4 * HOUR;
  await latido(h, execToken, REPORTE_VIEJO);
  await h.service.tick();
  assert.equal(correosDesajuste(h).length, 3, 'a las 4 h del ciclo nuevo sale su correo: la limpieza era real');
  await h.service.close();
  console.log('OK 2.3.2 B2b · ECO1 — escalado temporal: 4 h un correo, recordatorio a los 7 días DEL AVISO (D-4), al sanar se limpia.');
}

/* ---------- ECO1b · D-4: correo apagado >7 días — aviso al encender (día 8), recordatorio no antes del día 15 ---------- */
{
  const h = makeHarness();
  await unlock(h);
  const execToken = await emparejar(h);
  /* Sin correo configurado: el desajuste nace y dura, y el
     aviso queda pendiente, no perdido (no se marca nada). */
  await latido(h, execToken, REPORTE_VIEJO);
  await h.service.tick();
  h.clock.t = T0 + 7 * DAY;
  await latido(h, execToken, REPORTE_VIEJO);
  await h.service.tick();
  assert.equal(correosDesajuste(h).length, 0, 'con el correo apagado no sale nada en 7 días (y nada se quema)');

  /* Día 8: se enciende el correo → sale el PRIMER aviso. */
  h.clock.t = T0 + 8 * DAY;
  await configurarCorreo(h);
  await latido(h, execToken, REPORTE_VIEJO);
  await h.service.tick();
  assert.equal(correosDesajuste(h).length, 1, 'al encender el correo el día 8 sale el primer aviso, entonces');
  assert.ok(!/Recordatorio/.test(String(correosDesajuste(h)[0].subject || '')),
    'ese primer correo es el aviso, no un recordatorio');

  /* El defecto D-4: antes, el siguiente ciclo ya mandaba el
     «recordatorio» porque se medía desde el inicio. Ahora no:
     ni al ciclo siguiente ni el día 14. */
  await h.service.tick();
  assert.equal(correosDesajuste(h).length, 1, 'D-4: el ciclo siguiente NO trae recordatorio pegado al aviso');
  h.clock.t = T0 + 14 * DAY;
  await latido(h, execToken, REPORTE_VIEJO);
  await h.service.tick();
  assert.equal(correosDesajuste(h).length, 1, 'D-4: el día 14 aún no toca (7 días desde el aviso = día 15)');

  h.clock.t = T0 + 15 * DAY;
  await latido(h, execToken, REPORTE_VIEJO);
  await h.service.tick();
  assert.equal(correosDesajuste(h).length, 2, 'el recordatorio llega el día 15: 7 días después del primer aviso');
  assert.match(String(correosDesajuste(h)[1].subject || ''), /Recordatorio/);
  await h.service.close();
  console.log('OK 2.3.2 B2b · ECO1b — D-4: correo encendido tarde (día 8) → aviso entonces; recordatorio no antes del día 15.');
}

/* ---------- ECO2 · Clave completa: (b) cambia la causa; (a) avanza el paquete ---------- */
{
  const dir = mkdtempSync(join(tmpdir(), 'pacosat-eco232-'));
  const dbFile = join(dir, 'eco.sqlite');
  try {
    const h = makeHarness({ dbFile });
    await unlock(h);
    const execToken = await emparejar(h);
    const conDetalle = detalle => ({ ...REPORTE_VIEJO,
      actualizacion: { estado: 'fallo', detalle } });

    await latido(h, execToken, conDetalle('fallo al descargar el paquete'));
    assert.equal((await asientosDesajuste(h)).length, 1, 'el primer desajuste asienta');
    await latido(h, execToken, conDetalle('fallo al copiar los motores'));
    assert.equal((await asientosDesajuste(h)).length, 2,
      '(b) mismo par, otra causa: la clave completa cambió y asienta de nuevo');
    await latido(h, execToken, conDetalle('fallo al copiar los motores'));
    assert.equal((await asientosDesajuste(h)).length, 2, 'misma clave completa: mismo silencio');
    await h.service.close();

    /* (a) El paquete avanza: su única huella persistida es la
       clave guardada con el esperado anterior. Se reescribe tal
       como quedó cuando el paquete era la 2.3.0 y se reabre el
       servidor sobre la misma base (reinicio simulado). */
    const db = new DatabaseSync(dbFile);
    const fila = db.prepare('SELECT reporte FROM sat_executors WHERE revocado=0').get();
    const guardado = JSON.parse(fila.reporte);
    guardado.desajusteClave = ['2.0.0', HUELLA_A, '2.3.0', 'c'.repeat(64),
      'fallo al copiar los motores'].join('|');
    db.prepare('UPDATE sat_executors SET reporte=?').run(JSON.stringify(guardado));
    db.close();

    const h2 = makeHarness({ dbFile });
    await latido(h2, execToken, conDetalle('fallo al copiar los motores'));
    assert.equal((await asientosDesajuste(h2)).length, 3,
      '(a) mismo par viejo, esperado nuevo (el paquete avanzó): asienta otra vez');
    await latido(h2, execToken, conDetalle('fallo al copiar los motores'));
    assert.equal((await asientosDesajuste(h2)).length, 3, 'y con la clave ya al día del paquete, calla');
    await h2.service.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
  console.log('OK 2.3.2 B2b · ECO2 — clave completa: asienta si cambia la causa (b) o el esperado (a); si no, calla.');
}

/* ---------- ECO3 · En línea sin reporte: una vez, persistido, y al por fin reportar ---------- */
{
  const dir = mkdtempSync(join(tmpdir(), 'pacosat-eco232-sr-'));
  const dbFile = join(dir, 'eco.sqlite');
  try {
    const h = makeHarness({ dbFile });
    await unlock(h);
    const execToken = await emparejar(h);
    await latido(h, execToken, undefined);
    assert.equal((await asientos(h, 'anterior a la 2.3.1')).length, 1,
      'en línea sin reporte (cáscara vieja): el desajuste posible deja constancia fechada, una vez');
    await latido(h, execToken, undefined);
    assert.equal((await asientos(h, 'anterior a la 2.3.1')).length, 1, 'y no se repite en cada latido');
    await h.service.close();

    const h2 = makeHarness({ dbFile });
    await latido(h2, execToken, undefined);
    assert.equal((await asientos(h2, 'anterior a la 2.3.1')).length, 1,
      'tras el reinicio simulado tampoco se repite: la marca es persistida, no de memoria');
    await latido(h2, execToken, REPORTE_AL_DIA());
    assert.equal((await asientos(h2, 'por fin reporta su versión')).length, 1,
      'cuando por fin reporta, asienta de nuevo');
    assert.equal((await asientosDesajuste(h2)).length, 0, 'reporta al día: ningún asiento de desajuste');
    await latido(h2, execToken, undefined);
    assert.equal((await asientos(h2, 'anterior a la 2.3.1')).length, 1,
      'con reporte ya guardado, un latido sin reporte no reabre el asiento de sin-reporte');
    await h2.service.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
  console.log('OK 2.3.2 B2b · ECO3 — «en línea sin reporte» asienta una vez por ejecutor, persiste y cierra al reportar.');
}

/* ---------- ECO4 · Saneo por tokens al guardar: la ruta de juguete no viaja ---------- */
{
  const h = makeHarness();
  await unlock(h);
  const execToken = await emparejar(h);
  await latido(h, execToken, { ...REPORTE_AL_DIA(),
    actualizacion: { estado: 'fallo',
      detalle: 'fallo en C:\\Users\\Paco\\AppData\\ejecutor\\sat-doc-fetch.mjs y también ' +
        '/home/paco/ejecutor/sat-executor.mjs con\nsaltos   múltiples' } });
  const estado = (await h.call('GET', '/api/status')).json;
  const detalle = estado.ejecutor.actualizacion?.detalle || '';
  assert.equal(detalle, 'fallo en sat-doc-fetch.mjs y también sat-executor.mjs con saltos múltiples',
    'el detalle guardado sale saneado por tokens: último segmento, blancos colapsados');
  assert.ok(!detalle.includes('\\') && !detalle.includes('Users') && !detalle.includes('/home'),
    'ninguna ruta absoluta llega a /api/status');
  assert.ok(detalle.length <= 200, 'y sigue recortado a 200');
  await h.service.close();
  console.log('OK 2.3.2 B2b · ECO4 — saneo por tokens al guardar: ni un ejecutor viejo cuela una ruta absoluta.');
}

/* ---------- ECO5 · La tarjeta juzga al peor, no al último ---------- */
{
  const h = makeHarness();
  await unlock(h);
  const bueno = await emparejar(h, 'Equipo bueno');
  const mezclado = await emparejar(h, 'Equipo mezclado');

  await latido(h, bueno, REPORTE_AL_DIA());
  h.clock.t += 60000;
  await latido(h, mezclado, REPORTE_VIEJO);
  let estado = (await h.call('GET', '/api/status')).json;
  assert.equal(estado.ejecutor.versionReportada, '2.0.0', 'el desajustado manda en /api/status');

  h.clock.t += 60000;
  await latido(h, bueno, REPORTE_AL_DIA());
  estado = (await h.call('GET', '/api/status')).json;
  assert.equal(estado.ejecutor.versionReportada, '2.0.0',
    'aunque el sano late después, el peor (desajuste) sigue mandando: no queda enmascarado');
  assert.equal(estado.ejecutor.huellaReportada, HUELLA_A, 'y su huella es la del peor');
  assert.equal((await tarjetaEjecutor(h)).estado, 'mal', 'la tarjeta de Salud juzga al peor: mal');

  h.clock.t += 60000;
  await latido(h, mezclado, REPORTE_AL_DIA());
  estado = (await h.call('GET', '/api/status')).json;
  assert.equal(estado.ejecutor.versionReportada, VERSION_PAQUETE, 'saneados los dos, manda el paquete');
  assert.equal((await tarjetaEjecutor(h)).estado, 'bien', 'y la tarjeta vuelve a bien');

  const viejo = await emparejar(h, 'Equipo viejo');
  h.clock.t += 60000;
  await latido(h, viejo, undefined);
  estado = (await h.call('GET', '/api/status')).json;
  assert.equal(estado.ejecutor.versionReportada, null,
    '«sin reporte» gana a «al día»: el peor tras el desajuste es el que no reporta');
  assert.equal((await tarjetaEjecutor(h)).estado, 'vigilar', 'y la tarjeta lo deja en vigilar');
  await h.service.close();
  console.log('OK 2.3.2 B2b · ECO5 — agregación del peor con dos (y tres) ejecutores: desajuste > sin reporte > al día.');
}

/* ---------- ECO6 · Red semanal: el desajuste entra en las rotas de saludAuto ---------- */
{
  const h = makeHarness({ start: Date.parse('2026-11-16T15:00:00Z') }); // lunes 16 nov 2026, 09:00 CST
  await unlock(h);
  const execToken = await emparejar(h);
  await configurarCorreo(h);
  await latido(h, execToken, REPORTE_VIEJO);
  await h.service.tick();
  const semanal = h.mails.find(m => /Autorreparación semanal de Salud/.test(String(m.subject || '')));
  assert.ok(semanal, 'el correo semanal de autorreparación sale');
  assert.ok(String(semanal.text || '').includes('Ejecutor:'),
    'y sus rotas nombran al ejecutor en desajuste: ' + String(semanal.text || ''));
  assert.ok(String(semanal.text || '').includes('no corre el paquete'),
    'con el porqué del desajuste');
  assert.equal(correosDesajuste(h).length, 0, 'el escalado de 4 h aún no toca: la red semanal es otra capa');
  await h.service.close();
  console.log('OK 2.3.2 B2b · ECO6 — la tarjeta ejecutor en desajuste entra en las rotas del correo semanal.');
}

} else {
  console.log('CONSTANCIA 2.3.2 B2b — omitido en modo batería (sin manifiesto del ejecutor en el árbol): corre entero en la pasada integrada, con el paquete colocado.');
}

console.log('Ronda 2.3.2 · constructor B2b (eco del ejecutor): batería completa en verde.');
