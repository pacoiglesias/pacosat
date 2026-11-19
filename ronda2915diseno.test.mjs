import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as vm from 'node:vm';

/* ================================================================
   Ronda 2.9.15 · DISEÑO (Bloque B) — el lote gráfico de Paco,
   probado sobre el artefacto construido y las fuentes:

   (B1) La franja «Requiere tu atención» de Hoy se alimenta de
       las tarjetas de Salud con su filtro EXACTO: entran los
       ids que Hoy no enseña en otro sitio con estado mal o
       vigilar; quedan fuera la puerta, el ejecutor y el correo
       (ya viven en el mando y el proactivo: cada dato una sola
       vez en la pantalla) y el respaldo sin contraseña (su
       gesto de definirla ya es del mando); con contraseña, el
       respaldo pendiente de verificar SÍ entra.
   (B4) hace2915, el sello de frescura único: «actualizado
       hace…» en palabras, y el sistema de cuatro estados
       canónicos existe como render compartido (estadoChip2915)
       con su CSS (etiqueta + icono + color).
   (B6) El menú queda agrupado por tarea — EXPEDIENTE, SAT,
       BANCOS, DOCUMENTOS, AJUSTES — con los 21 destinos de
       siempre, cada uno en su grupo.
   (B3) Facturas: columnas clave primero (fecha, contraparte,
       folio, importe, estado; el tipo, secundario) y los
       filtros nacen abiertos también en móvil.
   (B2) Descargar del SAT: lo avanzado (año, historial y
       cobertura completa) viaja plegado en la parte perezosa;
       lo frecuente (la tarjeta de descarga) sigue a la vista.
   (B5) El visor copia con un toque UUID, RFC de emisor y de
       receptor e importe.
   (B7) CSS de toque: acciones ≥44px en puntero táctil y barra
       inferior móvil ≥48px.
   ================================================================ */
const AQUI = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(AQUI, 'Faro-Fiscal.html'), 'utf8');
const lazy = JSON.parse(readFileSync(join(AQUI, 'lazy.json'), 'utf8'));
const layout = readFileSync(join(AQUI, 'layout.part'), 'utf8');

/* ── Extracción de funciones puras del artefacto ──────────── */
function extraer(desde, hasta, incluirFin = false) {
  const i = html.indexOf(desde);
  assert.ok(i >= 0, 'no se encontró el inicio: ' + desde);
  const j = html.indexOf(hasta, i);
  assert.ok(j > i, 'no se encontró el fin: ' + hasta);
  return html.slice(i, incluirFin ? j + hasta.length : j);
}
const ctx = {};
vm.createContext(ctx);
vm.runInContext(extraer('const ATENCION_HOY2915', 'function hoyAtencion2915'), ctx);
vm.runInContext(extraer('function hace2915', '\n}', true), ctx);
const { atencionHoyFilas2915, hace2915 } = ctx;
assert.equal(typeof atencionHoyFilas2915, 'function', 'atencionHoyFilas2915 extraíble');
assert.equal(typeof hace2915, 'function', 'hace2915 extraíble');

/* ── (B1) El filtro de la franja, con la forma real de Salud ─ */
const tarjeta = (id, estado, datos) => ({ id, estado, titulo: 'T-' + id, porque: 'P-' + id, frescura: 1000, datos });
const salud = { tarjetas: [
  tarjeta('puerta:AAA010101AAA', 'mal'), tarjeta('ejecutor', 'mal'),
  tarjeta('correo', 'vigilar'), tarjeta('atascados', 'mal'),
  tarjeta('efirma', 'vigilar'), tarjeta('push', 'vigilar'),
  tarjeta('respaldo', 'vigilar', { contrasenaPuesta: false }),
  tarjeta('solicitudes-vivas', 'bien'), tarjeta('sat-hoy', 'vigilar'),
  tarjeta('disco', 'mal') ] };
assert.deepEqual(atencionHoyFilas2915(salud).map(t => t.id),
  ['atascados', 'efirma', 'push', 'sat-hoy'],
  'entran solo los ids propios de la franja con mal/vigilar; puerta, ejecutor, correo y disco quedan fuera');
const saludRespaldo = { tarjetas: [tarjeta('respaldo', 'mal', { contrasenaPuesta: true })] };
assert.deepEqual(atencionHoyFilas2915(saludRespaldo).map(t => t.id), ['respaldo'],
  'el respaldo con contraseña puesta y algo que verificar SÍ entra');
assert.deepEqual([...atencionHoyFilas2915(null)], [], 'sin foto de Salud, sin filas');
assert.deepEqual([...atencionHoyFilas2915({ tarjetas: [tarjeta('push', 'bien')] })], [],
  'todo en bien: sin filas (la franja no se pinta)');

/* ── (B4) Frescura en palabras ─────────────────────────────── */
const AHORA = 1_700_000_000_000;
assert.equal(hace2915(0, AHORA), '', 'sin fecha no hay sello');
assert.equal(hace2915(AHORA - 20_000, AHORA), 'actualizado ahora mismo');
assert.equal(hace2915(AHORA - 5 * 60_000, AHORA), 'actualizado hace 5 min');
assert.equal(hace2915(AHORA - 2 * 3_600_000, AHORA), 'actualizado hace 2 horas');
assert.equal(hace2915(AHORA - 3 * 86_400_000, AHORA), 'actualizado hace 3 días');

/* ── (B4) El sistema único de estados, en código y en CSS ──── */
const bloqueEstados = html.slice(html.indexOf('const ESTADOS2915'), html.indexOf('const ESTADOS2915') + 500);
for (const [clave, etiqueta] of [['pendiente', 'Pendiente'], ['en-proceso', 'En proceso'],
    ['atencion', 'Requiere atención'], ['completado', 'Completado']])
  assert.ok(bloqueEstados.includes(clave) && bloqueEstados.includes("'" + etiqueta + "'"),
    'ESTADOS2915 trae ' + clave + ' = «' + etiqueta + '»');
assert.ok(html.includes('function estadoChip2915'), 'el render compartido estadoChip2915 existe');
for (const css of ['.estado-completado{', '.estado-pendiente{', '.estado-en-proceso{',
    '.estado-atencion{', '.estado-atencion.estado-grave2915{'])
  assert.ok(html.includes(css), 'CSS del sistema de estados: ' + css);

/* ── (B6) Menú agrupado por tarea, con paridad de destinos ── */
const finNav = layout.indexOf('data-view="settings"');
const segNav = layout.slice(layout.indexOf('<span class="nav-caption">'),
  layout.indexOf('\n', finNav));
const captions = [...segNav.matchAll(/<span class="nav-caption">([^<]+)<\/span>/g)].map(m => m[1]);
assert.deepEqual(captions, ['EXPEDIENTE', 'SAT', 'BANCOS', 'DOCUMENTOS', 'AJUSTES'],
  'los cinco grupos por tarea, en orden');
const grupos = {};
let grupoActual = null;
for (const linea of segNav.split('\n')) {
  const cap = /<span class="nav-caption">([^<]+)<\/span>/.exec(linea);
  if (cap) { grupoActual = cap[1]; grupos[grupoActual] = []; continue; }
  const vista = /data-view="([a-z]+)"/.exec(linea);
  if (vista && grupoActual) grupos[grupoActual].push(vista[1]);
}
assert.deepEqual(grupos, {
  EXPEDIENTE: ['home', 'avisos', 'buzon', 'contribuyentes', 'invoices', 'archivo', 'registro'],
  SAT: ['descargar', 'tributario', 'monitor', 'lists', 'ejecutor'],
  BANCOS: ['dinero', 'pagos', 'reportes', 'salidas'],
  DOCUMENTOS: ['docs', 'declaraciones'],
  AJUSTES: ['salud', 'preguntas', 'settings'] },
  'cada destino en su grupo; los 21 de siempre, ninguno perdido');
assert.ok(html.includes('nav-caption-on2915'), 'la señal del grupo activo viaja en el artefacto');

/* ── (B3) Facturas: columnas y filtros ─────────────────────── */
assert.ok(html.includes("grid(['', 'Fecha', 'Emisor → receptor', 'Folio', 'Total', 'Estado SAT', 'Tipo', 'Acción']"),
  'columnas clave primero en Facturas');
assert.ok(html.includes("classList.add('invoice-filters', 'open')"),
  'los filtros de Facturas nacen abiertos');

/* ── (B2) Descargar: lo avanzado, plegado en su parte perezosa */
const descargas = lazy.partes.descargas.source;
assert.ok(descargas.includes("plegable290('El año de un vistazo'"), 'el año, plegado');
assert.ok(descargas.includes("plegable290('Historial de descargas'"), 'el historial, plegado');
assert.ok(descargas.includes("plegable290('Cobertura completa: meses, huecos y automática'"), 'la cobertura completa, plegada');
assert.ok(descargas.includes('function descargarCard2912'), 'la tarjeta frecuente de descarga sigue a la vista');

/* ── (B5) Copiar con un toque en el visor ──────────────────── */
for (const texto of ['Copiar UUID', 'Copiar RFC emisor', 'Copiar RFC receptor', 'Copiar importe'])
  assert.ok(html.includes(texto), 'el visor trae «' + texto + '»');

/* ── (B7) Toque: mínimos de 44px en CSS ────────────────────── */
assert.ok(html.includes('@media (pointer:coarse){.actions button{min-height:44px}}'),
  'acciones de 44px en puntero táctil');
assert.ok(html.includes('.bottombar button{min-height:48px}'), 'barra inferior móvil de 48px');

console.log('ronda2915diseno: B1–B7 verificados sobre el artefacto (filtro de la franja, frescura, estados, menú, columnas, plegados, copias y toque).');
