/* ================================================================
   Ronda 1.31.1 — diseño y operación (corrección de Paco del
   13 nov, 21:36–22:24): contraste pleno sin lavado, archivar
   fácil con su Archivo, gestos y novedades, digest completo,
   la caché compartida de Hoy con su forma única de 7, Totales
   sin complementos, sondeo adaptativo, tope de artefactos de
   diagnóstico, VACUUM tras el respaldo y la licencia comercial
   (fuera la MIT del proyecto, orden del 22:24).

   Qué se prueba aquí:
   1. ESTÁTICAS: versión 1.31.1 coherente; la LICENSE del
      proyecto es la comercial de Paco (ni rastro de la MIT);
      package.json declara UNLICENSED; el menú trae «Archivo»;
      polish.part ya no atenúa ninguna tarjeta (fuera el.55);
      la frase de fontanería no vive en sat-ui.part; los DOS
      escritores de todayCache llenan el array de 7; el ejecutor
      trae el sondeo adaptativo; el servidor trae el tope de
      artefactos diag.
   2. CONTRASTE: las parejas de las pastillas de estado en el
      esquema claro superan 4.5:1 (WCAG AA) — la queja de Paco
      era un beige ilegible; aquí queda medido, no prometido.
   3. SERVIDOR: archivar un CFDI lo saca a /api/cfdi/archivados
      y restaurarlo lo devuelve; el invitado NO puede archivar
      ni listar archivados (la guarda es la de administrador);
      el digest trae avisosCerrados y documentosRecibidos.
   ================================================================ */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { DOMParser } from '@xmldom/xmldom';
import { createPacoSATService } from './local-server.mjs';

const ORIGIN = 'https://pacosat.test';
const KEY = 'f'.repeat(64);
const OWN = 'AAA010101AAA';
const ROOT = import.meta.dirname;
const read = name => readFileSync(join(ROOT, name), 'utf8');

function makeHarness(options = {}) {
  const clock = { t: Date.parse('2026-11-13T16:00:00Z') };
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
  return { service, call, raw, mails, clock };
}

/* ===== 1 · ESTÁTICAS ===== */
{
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.version, '2.9.14', 'la versión de la pasada es 2.0.1 (re-basificado: la 2.0.1 —motores contra el mapa real— sustituye a la 2.0.0)');
  assert.equal(pkg.license, 'UNLICENSED', 'el paquete declara UNLICENSED (orden del 22:24)');
  assert.equal(pkg.private, true, 'el paquete es privado');
  const licencia = read('LICENSE');
  assert.ok(licencia.includes('Paco Iglesias'), 'la licencia del proyecto es la comercial de Paco');
  assert.ok(licencia.includes('software comercial'), 'la licencia dice su sentido entero');
  assert.ok(!licencia.includes('MIT License'), 'fuera la MIT del proyecto');
  assert.ok(!licencia.includes('Permission is hereby granted'), 'fuera el texto MIT del proyecto');
  const ejecutor = read('ejecutor-local.mjs');
  /* Re-baseline 1.31.2: la coherencia de sello de la casa
     (ronda1310) obliga al ejecutor a declarar la versión del
     paquete; en la 1.31.2 su ÚNICO cambio es ese sello — su
     lógica queda intacta y su bundle se regenera solo por él. */
  assert.ok(ejecutor.includes("EJECUTOR_VERSION = '2.9.14'"), 'el ejecutor declara 2.0.1 (solo el sello)');
  assert.ok(ejecutor.includes('activos > 0'), 'el ejecutor trae el sondeo adaptativo');
  const html = read('Faro-Fiscal.html');
  assert.ok(html.includes('"version":"2.9.14"'), 'el artefacto se sella con 2.0.1');
  const polish = read('polish.part');
  assert.ok(!polish.includes('tiene-foco.tramite-card{opacity'), 'ninguna tarjeta se atenúa ya (fuera el lavado)');
  assert.ok(!polish.includes('.tramite-foco{opacity'), 'el foco viejo con opacidad no existe');
  const satUi = read('sat-ui.part');
  assert.ok(!satUi.includes('Se baja por el navegador del servidor'),
    'la fontanería no vive en la cara de las tarjetas');
  const layout = read('layout.part');
  /* Re-baseline 2.0.1 LIMPIEZA (orden directa de Paco, 16 nov):
     el menú corto de 9 entradas ya no trae Archivo — cuelga de
     Salud, alcanzable, y su vista sigue enrutada. */
  /* RE-BASE integración 2.4.0 (W4d): la barra de 22 destinos
     devolvió Archivo al menú como botón propio — la regla de
     Paco de que lo necesario no se esconde manda sobre el pin
     de la limpieza 2.0.1. El pin se invierte con la misma
     fuerza: el botón CONSTA. */
  assert.ok(layout.includes('data-view="archivo"'), 'el menú trae Archivo como botón propio (barra de 22 destinos, W4d)');
  assert.ok(read('salud-ui.part').includes("navigate('archivo')"), 'Archivo queda alcanzable desde Salud');
  assert.ok(layout.includes('id="puerta-dot"'), 'la barra trae el punto veraz de la puerta');
  assert.ok(layout.includes('id="gestos-badge"'), 'la barra trae la señal de gestos');
  /* RE-BASE 2.8.0 (diseño 18): la barra pierde su botón de
     búsqueda — tres puertas al mismo buscador sobraban — y
     buscar queda en la cabecera (global-search) y en Ctrl+K. */
  assert.ok(!layout.includes('id="side-search"'), 'la barra ya NO trae botón de búsqueda (diseño 18: una sola puerta, la cabecera)');
  assert.ok(layout.includes('id="global-search"'), 'la búsqueda global vive en la cabecera');
  assert.ok(layout.includes('id="side-collapse"'), 'la barra se puede plegar');
  const problemas = read('problemas-ui.part');
  assert.ok(problemas.includes("satApi('activity/digest')") && problemas.includes("satApi('registro/resumen')"),
    'el centro de mando llena la caché compartida con su forma completa de 7');
  const servidor = read('local-server.mjs');
  assert.ok(servidor.includes('DIAG_KEEP'), 'el servidor trae el tope de artefactos de diagnóstico');
  assert.ok(servidor.includes("db.exec('VACUUM')"), 'el servidor compacta tras el respaldo verificado');
  assert.ok(servidor.includes("'/api/cfdi/archivar'") || servidor.includes('/api/cfdi/archivar'),
    'el servidor trae el gesto de archivar CFDI');
  console.log('OK 1.31.1 · estáticas — versión, licencia comercial, menú, foco sin lavado y mecanismos.');
}

/* ===== 2 · CONTRASTE DE PASTILLAS (esquema claro, WCAG) ===== */
{
  const css = read('style.part');
  const tokenClaro = nombre => {
    const m = css.match(new RegExp('--' + nombre + ':light-dark\\((#[0-9a-fA-F]{6})'));
    assert.ok(m, 'token presente: --' + nombre);
    return m[1];
  };
  const lum = hex => {
    const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map(v => v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contraste = (a, b) => {
    const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (l1 + 0.05) / (l2 + 0.05);
  };
  const parejas = [['ok', 'ok-bg', 'ok-ink'], ['warn', 'warn-bg', 'warn-ink'],
    ['danger', 'danger-bg', 'danger'], ['info', 'info-bg', 'info-ink']];
  for (const [nombre, bg, ink] of parejas) {
    const c = contraste(tokenClaro(bg), tokenClaro(ink));
    assert.ok(c >= 4.5, 'la pastilla ' + nombre + ' supera AA: ' + c.toFixed(2) + ':1');
  }
  console.log('OK 1.31.1 · contraste — las cuatro pastillas de estado superan 4.5:1 en claro.');
}

/* ===== 3 · SERVIDOR: archivar, invitado fuera, digest ===== */
{
  const h = makeHarness();
  const open = await h.call('POST', '/api/unlock', { rfc: OWN, minutes: 1440, days: 7,
    direction: 'both', password: 'simulated', certificate: 'YQ==', key: 'Yg==' });
  assert.equal(open.status, 200);
  const UUID = 'AAAAAAAA-1111-4111-8111-111111111111';
  const seed = await h.call('POST', '/api/storage', { batch: { invoices: [
    { id: UUID, date: '2026-02-03T12:00:00', kind: 'I', total: '1000.00',
      from: { rfc: OWN, name: 'Prueba' }, to: { rfc: 'XAXX010101000', name: 'Cliente' } }] } });
  assert.equal(seed.status, 200);
  const arch = await h.call('POST', '/api/cfdi/archivar', { uuid: UUID, archivar: true });
  assert.equal(arch.status, 200, 'archivar responde 200');
  assert.equal(arch.json.archivado, true);
  let lista = await h.call('GET', '/api/cfdi/archivados');
  assert.ok((lista.json.ids || []).includes(UUID), 'el CFDI consta archivado');
  const tot = await h.call('POST', '/api/salidas/xlsx', { kind: 'totales', rfc: OWN, year: '2026' });
  assert.equal(tot.status, 200, 'Totales sigue saliendo con el CFDI archivado');
  const rest = await h.call('POST', '/api/cfdi/archivar', { uuid: UUID, archivar: false });
  assert.equal(rest.status, 200);
  lista = await h.call('GET', '/api/cfdi/archivados');
  assert.ok(!(lista.json.ids || []).includes(UUID), 'restaurar lo devuelve a las vistas');

  const digest = await h.call('GET', '/api/activity/digest');
  assert.equal(digest.status, 200);
  assert.equal(typeof digest.json.avisosCerrados, 'number', 'el digest cuenta avisos cerrados');
  assert.equal(typeof digest.json.documentosRecibidos, 'number', 'el digest cuenta documentos recibidos');

  /* El invitado queda fuera de las superficies nuevas. */
  await h.call('POST', '/api/guest/config', { password: 'invitado-1311', enabled: true, rfcs: [OWN] });
  const login = await h.call('POST', '/api/guest/login', { password: 'invitado-1311' });
  assert.ok(login.json?.token, 'sesión de invitado emitida');
  const guestHeaders = { 'x-pacosat-token': login.json.token };
  const gArch = await h.call('POST', '/api/cfdi/archivar', { uuid: UUID, archivar: true }, guestHeaders);
  assert.notEqual(gArch.status, 200, 'el invitado NO puede archivar');
  const gLista = await h.call('GET', '/api/cfdi/archivados', undefined, guestHeaders);
  assert.notEqual(gLista.status, 200, 'el invitado NO puede listar archivados');
  lista = await h.call('GET', '/api/cfdi/archivados');
  assert.ok(!(lista.json.ids || []).includes(UUID), 'el intento del invitado no archivó nada');

  await h.service.close();
  console.log('OK 1.31.1 · servidor — archivar con ida y vuelta, invitado fuera y digest completo.');
}
console.log('Ronda 1.31.1: batería completa en verde.');
