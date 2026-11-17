/* ================================================================
   Ronda 1.32.2 — diseño (orden de Paco, 14 nov: «¿Un color azul
   no se vería mejor? ¿O modo oscuro?» → «Mejóralo todo»):
   D1 rótulos de la barra lateral bajo AA en oscuro (medido
     4,26:1): el valor oscuro de --nav-muted sube a #93a9c4.
   D2 alerta de Declaraciones bajo AA en claro (medido 4,25:1):
     .decl-alerta gana color:var(--danger).
   D3 marca propia: el faro sustituye a la «A» genérica en el
     símbolo, el icono PWA y el favicon; el medallón vira con
     los tokens (fuera el #e6f8ee escrito a mano); el pie gana
     la marca sin cambiar su texto (boot.test lo sella).
   D4 Hoy: la tarjeta del día manda; «Esto es lo nuevo» entra
     tras ella, no encima.
   D5 Registro: .reg-linea con flex y hueco (hora y texto ya
     no van pegados).
   P2 acento AZUL por defecto: DEFAULT_ACCENT='azul' (una sola
     variable; el ajuste personal manda sobre el defecto) y el
     verde queda como acento elegible de pleno derecho (lista
     del servidor, etiquetas, muestra y bloques CSS).
   P3 impresión en CARTA: PAGE de salidas-doc a 612×792 (el
     MediaBox generado lo prueba), @page a letter y los textos
     que decían A4 dicen carta.
   ================================================================ */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { DOMParser } from '@xmldom/xmldom';
import { createPacoSATService } from './local-server.mjs';
import { buildPdf } from './salidas-doc.mjs';

const ORIGIN = 'https://pacosat.test';
const KEY = 'f'.repeat(64);
const ROOT = import.meta.dirname;
const read = name => readFileSync(join(ROOT, name), 'utf8');
const html = read('Faro-Fiscal.html');
/* Las partes perezosas (salidas, pagos, bancos, registro) no van
   en el artefacto: viajan en lazy.json y el cliente las carga al
   entrar en su pantalla. Los textos que viven ahí se buscan en
   el corpus completo, que es lo que el cliente acaba corriendo. */
const corpus = html + '\n' + read('lazy.json');

/* ===== 1 · Versión y sellos ===== */
{
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.version, '2.3.0', 'la ronda es la 2.0.1');
  assert.ok(read('ejecutor-local.mjs').includes("EJECUTOR_VERSION = '2.3.0'"), 'el ejecutor declara 2.0.1 (solo el sello)');
  assert.ok(html.includes('"version":"2.3.0"'), 'el artefacto se sella 2.0.1');
  console.log('OK 1.32.2 · versión y sellos.');
}

/* ===== 2 · Acento azul por defecto y verde elegible (P2) ===== */
{
  assert.ok(html.includes("const DEFAULT_ACCENT = 'azul';"), 'el defecto del producto es el azul, en una variable');
  assert.ok(html.includes('appSettings.accent || DEFAULT_ACCENT'), 'el ajuste personal manda sobre el defecto');
  assert.ok(html.includes("verde: 'Verde'"), 'el verde tiene etiqueta propia');
  assert.ok(html.includes("verde: '#0e6b4f'"), 'el verde tiene su muestra con su color');
  assert.ok(html.includes("'': '#175c9e'"), 'la muestra «Predeterminado» enseña el azul');
  assert.ok(html.includes(':root[data-accent="verde"]{--green:#0e6b4f;'), 'bloque CSS del verde en claro');
  assert.ok(html.includes(':root[data-theme="dark"][data-accent="verde"]{--green:#2fae83;'), 'bloque CSS del verde en oscuro');
  assert.ok(html.includes('Predeterminado (azul)'), 'Ajustes describe el azul como predeterminado');
  assert.ok(!html.includes('Predeterminado (verde)'), 'ningún texto vende ya el verde como defecto');
  assert.ok(html.includes('restaura el azul de la casa'), 'el texto de la paleta nombra el azul');
  assert.ok(read('local-server.mjs').includes("'verde', 'azul'"), 'el servidor acepta el verde como acento guardable');
  console.log('OK 1.32.2 · P2 — azul por defecto, verde elegible.');
}

/* ===== 3 · Carta (P3): constante, PDF real y textos ===== */
{
  const salidas = read('salidas-doc.mjs');
  assert.ok(salidas.includes('w: 612, h: 792'), 'la página de las salidas es Carta (612×792 pt)');
  assert.ok(!salidas.includes('595.28'), 'no queda rastro del A4 en el constructor');
  const pdf = buildPdf({ title: 'Reporte del periodo · 2026-11', subtitle: 'MFI6212158B4',
    generated: 'Generado por PacoSAT',
    sections: [{ heading: 'Resumen', lines: ['Una línea de prueba.'],
      table: { columns: [{ title: 'Concepto', width: 0.6 }, { title: 'Importe', width: 0.4, align: 'right' }],
        rows: [['Renta', '$343,539.12']] } }] });
  const bytes = Buffer.isBuffer(pdf) ? pdf.toString('latin1') : String(pdf);
  assert.ok(bytes.includes('/MediaBox [0 0 612 792]'), 'el PDF generado declara Carta en su MediaBox');
  assert.ok(!bytes.includes('595.28'), 'el PDF generado no declara A4');
  assert.ok(html.includes('@page{size:letter portrait'), 'la impresión del navegador sale en carta');
  assert.ok(!html.includes('@page{size:A4 portrait'), 'no queda @page en A4');
  assert.ok(corpus.includes('PDF tamaño carta con folio y totales'), 'el panel de Salidas dice carta');
  assert.ok(!corpus.includes('PDF A4 con folio'), 'ningún texto visible promete A4');
  console.log('OK 1.32.2 · P3 — Carta en el constructor, en el PDF y en los textos.');
}

/* ===== 4 · Marca propia (D3) y contraste (D1, D2) y Registro (D5) ===== */
{
  assert.ok(html.includes('M12 2.6v1.5'), 'el símbolo de la marca es el faro');
  assert.ok(html.includes('l3.1-1.6'), 'el faro lleva sus haces');
  assert.ok(!html.includes('M4 19 12 4l8 15'), 'la «A» genérica ya no está');
  assert.ok(html.includes('color:var(--accent-ink);background:var(--tint)'), 'el medallón vira con los tokens');
  assert.ok(!html.includes('background:#e6f8ee'), 'el verde pastel escrito a mano desapareció');
  assert.ok(html.includes('rel="icon"'), 'la página declara su favicon');
  assert.ok(html.includes('app-footer-row'), 'el pie lleva la marca junto al texto');
  assert.ok(html.includes('--nav-muted:light-dark(#93a9c4,#93a9c4)'), 'D1: el atenuado de la barra cumple en oscuro');
  assert.ok(html.includes('.decl-alerta{border:1px solid var(--danger);background:var(--danger-bg);color:var(--danger)'),
    'D2: la alerta de Declaraciones se lee en tinta de peligro');
  assert.ok(html.includes('.reg-linea{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}'),
    'D5: la línea del Registro tiene su hueco');
  console.log('OK 1.32.2 · D1/D2/D3/D5 — marca, contrastes y Registro.');
}

/* ===== 5 · Hoy: el día manda (D4) y novedades de la versión ===== */
{
  /* 2.0 · tanda 2 (M5): «Esto es lo nuevo» SALE de Hoy — su
     sitio es Ajustes › Acerca de, junto a la versión. */
  assert.ok(!html.includes('blocks.splice(1, 0, novedades1311)'), 'las novedades ya no entran en Hoy (2.0 tanda 2)');
  assert.ok(html.includes('novedades200b'), 'las novedades viven en Ajustes › Acerca de (capacidadesScreen)');
  assert.ok(html.includes("version: '2.3.0'"), 'la nota de novedades es la de esta versión');
  console.log('OK 1.32.2 · D4 — Hoy abre con el día.');
}

/* ===== 6 · Servicio real: el verde se guarda y el icono es el faro ===== */
{
  const service = createPacoSATService({
    dbFile: ':memory:', html, origin: ORIGIN, proxyKey: KEY, satDocRetryWaitMs: 5,
    makeConnector: () => ({ parser: DOMParser, connector: {
      request: async () => 'req-b', check: async () => ({ status: 'pending', packages: [] }),
      download: async () => { throw new Error('sin paquetes'); } } }),
    makeMailer: () => ({ verify: async () => true, sendMail: async () => ({ messageId: 'm1' }) }) });
  let token = '';
  const raw = async (method, path, body, headers = {}) => {
    const chunks = []; if (body !== undefined) chunks.push(Buffer.from(JSON.stringify(body)));
    const req = Readable.from(chunks);
    req.method = method; req.url = path;
    req.headers = { host: 'pacosat.test', origin: ORIGIN, 'x-pacosat-proxy': KEY, ...headers };
    let status = 0; let text = '';
    const res = { writeHead(c) { status = c; }, setHeader() {}, getHeader() { return undefined; },
      end(chunk) { if (chunk) text += Buffer.isBuffer(chunk) ? chunk.toString('latin1') : chunk; } };
    await service.handle(req, res);
    return { status, text };
  };
  const call = async (method, path, body) => {
    if (!token) { const home = await raw('GET', '/'); token = /[0-9a-f]{64}/.exec(home.text)?.[0] || ''; }
    const r = await raw(method, path, body, { 'x-pacosat-token': token });
    let json = null; try { json = JSON.parse(r.text); } catch { /* binario */ }
    return { status: r.status, json, text: r.text };
  };
  /* El icono servido es el faro, no el escudo con la «P». */
  const icono = await call('GET', '/icon.svg');
  assert.equal(icono.status, 200, 'el icono PWA responde');
  assert.ok(icono.text.includes('M12 2.6v1.5'), 'el icono PWA dibuja el faro');
  assert.ok(!icono.text.includes('<text'), 'el icono ya no es una letra en un escudo');
  /* El verde se guarda como cualquier acento; uno inventado, no. */
  const verde = await call('POST', '/api/settings', { installName: '', senderName: '', accent: 'verde' });
  assert.equal(verde.status, 200, 'el acento verde se acepta al guardar');
  assert.equal(verde.json.settings.accent, 'verde', 'el ajuste guardado es el verde');
  const azul = await call('POST', '/api/settings', { installName: '', senderName: '', accent: 'azul' });
  assert.equal(azul.status, 200, 'el acento azul se acepta al guardar');
  const malo = await call('POST', '/api/settings', { installName: '', senderName: '', accent: 'turquesa' });
  assert.equal(malo.status, 400, 'un acento fuera de la paleta se rechaza');
  await service.close();
  console.log('OK 1.32.2 · servicio — icono faro y acentos guardables.');
}

console.log('OK 1.32.2 · ronda completa.');
