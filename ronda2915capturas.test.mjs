import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Readable } from 'node:stream';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DOMParser } from '@xmldom/xmldom';
import { createPacoSATService } from './local-server.mjs';

/* ================================================================
   Ronda 2.9.15 · Bloque C — CAPTURAS DE LA GUÍA DE AYUDA.

   La guía (Ajustes › Acerca de) dibuja cinco figuras con su
   hueco diseñado (captura-hoy.png, captura-descargar.png,
   captura-buzon.png, captura-salud.png, captura-facturas.png).
   Desde esta ronda el servidor las sirve de verdad cuando el
   PNG real está colocado en el DIRECTORIO DE DATOS de la app
   (fuera del artefacto: colocarlas tras el montaje no exige
   reconstruir), y el cliente enseña la imagen en el sitio del
   hueco; sin archivo, el hueco diseñado se queda (paridad).

   Esta suite prueba la RUTA contra el servidor real de la app
   (el patrón de servicio de ronda2914buzon), en los dos
   estados y con las tres resoluciones del directorio:
   (1) SIN archivo → 404; un nombre fuera de la lista blanca
       (incluido un intento de traversal) → 404; sin sesión →
       403, como toda ruta /api de la casa.
   (2) CON una PNG mínima válida escrita por la propia suite
       en el directorio temporal → 200, image/png y los bytes
       exactos que se colocaron.
   (3) RESOLUCIÓN: la opción capturasDir manda si no hay
       variable; PACOSAT_CAPTURAS_DIR manda sobre la opción;
       y sin ninguna de las dos, el directorio es
       «ayuda-capturas» junto a la base de datos de la app.

   La figura en el navegador real (img visible frente a hueco)
   vive en ronda2915capturasnavegador.test.mjs.
   ================================================================ */
const ORIGIN = 'https://pacosat.test';
const KEY = 'e'.repeat(64);
/* PNG mínima válida de 1×1, generada por la propia suite. */
const PNG_PRUEBA = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64');
const NOMBRES = ['captura-hoy.png', 'captura-descargar.png', 'captura-buzon.png',
  'captura-salud.png', 'captura-facturas.png'];

function crearServicio(opciones = {}) {
  return createPacoSATService({ dbFile: ':memory:',
    html: '<html><head><!--PACOSAT_TOKEN--></head><body>prueba</body></html>',
    origin: ORIGIN, proxyKey: KEY, executorMode: 'nas',
    makeConnector: () => ({ parser: DOMParser, connector: {
      request: async () => 'req-2915', check: async () => ({ status: 'pending', packages: [] }),
      download: async () => { throw new Error('sin paquetes'); } } }),
    makeMailer: () => ({ verify: async () => true, sendMail: async () => ({ messageId: 'm1' }) }),
    now: () => Date.parse('2026-11-19T15:00:00Z'), ...opciones });
}

/* Llamada en memoria al handle del servicio, con el cuerpo
   recogido en Buffer (la respuesta de la captura es binaria:
   nada de pasarla por texto). */
async function llamar(service, { method = 'GET', path = '/', token = '' } = {}) {
  const req = Readable.from([]);
  req.method = method; req.url = path;
  req.headers = { host: 'pacosat.test', origin: ORIGIN, 'x-pacosat-proxy': KEY,
    ...(token ? { 'x-pacosat-token': token } : {}) };
  const res = { status: 0, headers: {}, chunks: [],
    writeHead(c, h) { this.status = c; if (h) Object.assign(this.headers, h); },
    setHeader(k, v) { this.headers[k] = v; }, getHeader(k) { return this.headers[k]; },
    end(ch) { if (ch) this.chunks.push(Buffer.isBuffer(ch) ? ch : Buffer.from(String(ch))); } };
  await service.handle(req, res);
  return { status: res.status, headers: res.headers, body: Buffer.concat(res.chunks) };
}
async function tokenDe(service) {
  const home = await llamar(service, { path: '/' });
  return /[0-9a-f]{64}/.exec(home.body.toString('utf8'))?.[0] || '';
}

test('(1) sin archivo colocado: 404 para los cinco nombres, 404 fuera de la lista blanca y 403 sin sesión', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pacosat-2915-vacio-'));
  const service = crearServicio({ capturasDir: dir });
  try {
    const token = await tokenDe(service);
    assert.ok(token, '(1) la portada entrega el token de sesión de la casa');
    for (const nombre of NOMBRES) {
      const r = await llamar(service, { path: '/api/ayuda-captura?archivo=' + nombre, token });
      assert.equal(r.status, 404, '(1) «' + nombre + '» sin colocar contesta 404, no un hueco fingido');
    }
    for (const malo of ['captura-otra.png', '../pacosat.sqlite', '..%2F..%2Fpackage.json',
        'captura-hoy.png/extra', 'CAPTURA-HOY.PNG', '']) {
      const r = await llamar(service, { path: '/api/ayuda-captura?archivo=' + malo, token });
      assert.equal(r.status, 404, '(1) el nombre «' + malo + '» no está en la lista blanca: 404');
    }
    const sinArchivo = await llamar(service, { path: '/api/ayuda-captura', token });
    assert.equal(sinArchivo.status, 404, '(1) sin parámetro archivo también es 404');
    const sinSesion = await llamar(service, { path: '/api/ayuda-captura?archivo=captura-hoy.png' });
    assert.equal(sinSesion.status, 403,
      '(1) sin sesión la ruta contesta 403: sigue la puerta de siempre de las rutas /api');
    console.log('OK 2.9.15-capturas · (1) — sin archivo: 404 en los cinco; fuera de la lista blanca: 404; sin sesión: 403.');
  } finally { service.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('(2) con la PNG colocada en el directorio de datos: 200, image/png y los bytes exactos', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pacosat-2915-lleno-'));
  writeFileSync(join(dir, 'captura-hoy.png'), PNG_PRUEBA);
  const service = crearServicio({ capturasDir: dir });
  try {
    const token = await tokenDe(service);
    const r = await llamar(service, { path: '/api/ayuda-captura?archivo=captura-hoy.png', token });
    assert.equal(r.status, 200, '(2) la captura colocada se sirve');
    assert.equal(r.headers['Content-Type'], 'image/png', '(2) con su Content-Type image/png');
    assert.deepEqual(r.body, PNG_PRUEBA, '(2) y los bytes servidos son EXACTAMENTE los colocados');
    const vecina = await llamar(service, { path: '/api/ayuda-captura?archivo=captura-salud.png', token });
    assert.equal(vecina.status, 404, '(2) la vecina no colocada sigue en 404: cada figura va por la suya');
    console.log('OK 2.9.15-capturas · (2) — con PNG: 200 image/png y bytes exactos; la no colocada, 404.');
  } finally { service.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('(3) resolución del directorio: junto a la base por defecto y PACOSAT_CAPTURAS_DIR por encima de todo', async () => {
  /* Por defecto: «ayuda-capturas» junto a la base de datos. */
  const base = mkdtempSync(join(tmpdir(), 'pacosat-2915-datos-'));
  const dirJuntoBase = join(base, 'ayuda-capturas');
  mkdirSync(dirJuntoBase);
  writeFileSync(join(dirJuntoBase, 'captura-buzon.png'), PNG_PRUEBA);
  const porDefecto = crearServicio({ dbFile: join(base, 'pacosat.sqlite') });
  try {
    const token = await tokenDe(porDefecto);
    const r = await llamar(porDefecto, { path: '/api/ayuda-captura?archivo=captura-buzon.png', token });
    assert.equal(r.status, 200, '(3) sin opción ni variable, sirve desde <datos>/ayuda-capturas');
    assert.deepEqual(r.body, PNG_PRUEBA, '(3) con los bytes colocados junto a la base');
  } finally { porDefecto.close(); }
  /* La variable de entorno manda sobre la opción del servicio. */
  const dirEntorno = mkdtempSync(join(tmpdir(), 'pacosat-2915-entorno-'));
  writeFileSync(join(dirEntorno, 'captura-salud.png'), PNG_PRUEBA);
  const dirOpcion = mkdtempSync(join(tmpdir(), 'pacosat-2915-opcion-'));
  process.env.PACOSAT_CAPTURAS_DIR = dirEntorno;
  const porEntorno = crearServicio({ capturasDir: dirOpcion });
  try {
    const token = await tokenDe(porEntorno);
    const r = await llamar(porEntorno, { path: '/api/ayuda-captura?archivo=captura-salud.png', token });
    assert.equal(r.status, 200, '(3) PACOSAT_CAPTURAS_DIR manda: la captura se lee del directorio del entorno');
    assert.deepEqual(r.body, PNG_PRUEBA, '(3) y no del directorio de la opción, que está vacío');
  } finally {
    porEntorno.close();
    delete process.env.PACOSAT_CAPTURAS_DIR;
    rmSync(base, { recursive: true, force: true });
    rmSync(dirEntorno, { recursive: true, force: true });
    rmSync(dirOpcion, { recursive: true, force: true });
  }
  console.log('OK 2.9.15-capturas · (3) — resolución: PACOSAT_CAPTURAS_DIR > opción > <datos>/ayuda-capturas.');
});
