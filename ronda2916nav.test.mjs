import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/* ================================================================
   Ronda 2.9.16 · P1 — Navegación simplificada (orden de Paco,
   19 nov): el menú pasa de los cinco grupos de la 2.9.15
   (EXPEDIENTE, SAT, BANCOS, DOCUMENTOS, AJUSTES) a cuatro
   bloques — Trabajo diario, SAT, Expediente y Administración
   — y los destinos menos frecuentes viven dentro de «Más»,
   un grupo plegable que se recuerda y se abre solo al
   navegar a uno de los suyos.

   PARIDAD: los 21 destinos de siempre, ni uno menos, cada
   uno alcanzable; Hoy, Avisos y Facturas visibles en el
   primer bloque. La barra inferior móvil no cambia.
   ================================================================ */
const AQUI = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(AQUI, 'Faro-Fiscal.html'), 'utf8');
const layout = readFileSync(join(AQUI, 'layout.part'), 'utf8');
const finalUi = readFileSync(join(AQUI, 'final-ui.part'), 'utf8');

/* ── El nav del artefacto: orden exacto de destinos ──────── */
const navIni = layout.indexOf('<nav aria-label="Navegación principal">');
assert.ok(navIni >= 0, 'el <nav> principal conserva su etiqueta histórica');
assert.ok(finalUi.includes('navMasCableado2916') &&
  finalUi.includes("classList.toggle('nav-mas-cerrado2916', !abierto)") &&
  finalUi.includes("localStorage.getItem('pacosat-nav-mas2916') === 'abierto'"),
  'el grupo «Más» se pliega al arrancar (salvo que el equipo lo recuerde abierto)');
const navFin = layout.indexOf('</nav>', navIni);
const nav = layout.slice(navIni, navFin);
const destinos = [...nav.matchAll(/data-view="([a-z]+)"/g)].map(m => m[1]);
assert.deepEqual(destinos, [
  'home', 'avisos', 'invoices', 'descargar', 'tributario',
  'monitor', 'lists', 'declaraciones',
  'buzon', 'contribuyentes', 'docs', 'registro',
  'dinero', 'pagos', 'salud', 'settings',
  'ejecutor', 'archivo', 'reportes', 'salidas', 'preguntas'],
  'los 21 destinos, en el orden de los cuatro bloques + Más');

/* Paridad contra el inventario de la 2.9.15 (como conjunto). */
const inventario2915 = ['home', 'avisos', 'buzon', 'contribuyentes', 'invoices', 'archivo', 'registro',
  'descargar', 'tributario', 'monitor', 'lists', 'ejecutor', 'dinero', 'pagos', 'reportes', 'salidas',
  'docs', 'declaraciones', 'salud', 'preguntas', 'settings'];
assert.deepEqual([...destinos].sort(), [...inventario2915].sort(),
  'paridad total: el mismo inventario de destinos que en la 2.9.15');

/* ── Las cabeceras, en orden, y el botón de «Más» ─────────── */
const cabeceras = [...nav.matchAll(/<span class="nav-caption">([^<]+)<\/span>/g)].map(m => m[1]);
assert.deepEqual(cabeceras, ['TRABAJO DIARIO', 'SAT', 'EXPEDIENTE', 'ADMINISTRACIÓN'],
  'cuatro bloques con su cabecera, en orden');
assert.ok(/<button type="button" id="nav-mas-btn2916" class="nav-caption nav-mas-btn2916" aria-expanded="false"/.test(nav),
  '«Más» es un botón-cabecera con su aria-expanded');
const enMas = [...nav.matchAll(/<button data-view="([a-z]+)" class="nav-mas-item2916"/g)].map(m => m[1]);
assert.deepEqual(enMas, ['ejecutor', 'archivo', 'reportes', 'salidas', 'preguntas'],
  'los cinco destinos de «Más» llevan la clase que los pliega');
assert.equal((nav.match(/nav-mas-item2916/g) || []).length, 5,
  'ningún destino de los bloques lleva la clase de «Más»');

/* Hoy, Avisos y Facturas: visibles en el primer bloque. */
const primerBloque = nav.slice(nav.indexOf('TRABAJO DIARIO'), nav.indexOf('>SAT<'));
for (const v of ['home', 'avisos', 'invoices'])
  assert.ok(primerBloque.includes('data-view="' + v + '"'), v + ' visible en Trabajo diario');

/* ── El cableado: estado recordado y apertura al navegar ── */
assert.ok(finalUi.includes('function navMasFijar2916'), 'el plegado de «Más» tiene su fijador');
assert.ok(finalUi.includes("localStorage.setItem('pacosat-nav-mas2916'"), 'el estado de «Más» se recuerda en el equipo');
assert.ok(finalUi.includes('function navMasAbrir2916'), 'existe la apertura programática');
assert.ok(html.includes("classList.contains('nav-mas-item2916') && typeof navMasAbrir2916 === 'function') navMasAbrir2916()"),
  'navigate() abre «Más» solo cuando el destino vive dentro');

/* La CSS: plegado solo en la barra desplegada; en la barra de
   iconos todos los destinos se enseñan (plegar ≠ esconder). */
assert.ok(html.includes('.sidebar nav.nav-mas-cerrado2916 .nav-mas-item2916{display:none}'),
  'la clase del <nav> pliega los destinos de «Más»');
assert.ok(html.includes('body.barra-plegada .sidebar nav.nav-mas-cerrado2916 .nav-mas-item2916{display:flex}'),
  'en la barra plegada a iconos, los destinos de «Más» se enseñan como los demás');

/* ── La barra inferior móvil no cambia (paridad) ─────────── */
const barraIni = layout.indexOf('<nav class="bottombar"');
const barra = layout.slice(barraIni, layout.indexOf('</nav>', barraIni));
assert.deepEqual([...barra.matchAll(/data-view="([a-z]+)"/g)].map(m => m[1]),
  ['home', 'avisos', 'descargar', 'tributario'],
  'la barra inferior conserva Hoy, Avisos, Descargar y Buzón, y su «Más»');

console.log('ronda2916nav: OK — 21 destinos en 4 bloques + «Más», paridad total, barra inferior intacta.');
