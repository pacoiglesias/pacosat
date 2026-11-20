import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/* ================================================================
   Ronda 2.9.16 · P3 — Salud en tres pisos: primero lo que
   requiere acción (mal), luego lo que conviene vigilar
   (vigilar y sin dato, cada uno con su píldora) y al final
   lo que está bien. El «Ver más» de siempre corta sobre el
   orden ya agrupado: lo malo nunca queda escondido tras lo
   bueno por llegar tarde en la lista del servidor.

   Cada tarjeta enseña con claridad sus tres cosas: el estado
   (la píldora de siempre), la última revisión («Comprobada:
   …», de la 2.9.13) y el siguiente paso — su botón cuando lo
   hay; una línea que lo dice cuando no lo hay.
   ================================================================ */
const AQUI = dirname(fileURLToPath(import.meta.url));
const salud = readFileSync(join(AQUI, 'salud-ui.part'), 'utf8');
const html = readFileSync(join(AQUI, 'Faro-Fiscal.html'), 'utf8');

/* ── Los tres pisos, en orden, con su clave ──────────────── */
const iAccion = salud.indexOf("titulo: 'Requiere tu acción'");
const iVigilar = salud.indexOf("titulo: 'A vigilar'");
const iBien = salud.indexOf("titulo: 'Todo bien'");
assert.ok(iAccion >= 0 && iVigilar > iAccion && iBien > iVigilar,
  'los pisos se declaran en orden: acción → vigilar → bien');
assert.ok(salud.includes("seccion.dataset.piso2916 = piso.clave"),
  'cada piso se marca en el DOM con su clave');
assert.ok(salud.includes("cab.append(n('h3', piso.titulo)"),
  'cada piso lleva su cabecera con título y cuenta de piezas');

/* La asignación de piso: mal arriba; bien abajo; vigilar Y
   sin dato en el piso de vigilar. */
assert.ok(salud.includes("p.tarjeta.estado === 'mal' ? pisos2916[0]") &&
  salud.includes("p.tarjeta.estado === 'bien' ? pisos2916[2] : pisos2916[1]"),
  'mal → piso 1, bien → piso 3, y todo lo demás (vigilar, sin dato) → piso 2');

/* El corte de «Ver más» corre sobre el orden agrupado. */
assert.ok(salud.includes('piso.piezas.slice(0, Math.max(0, saludLimite299 - pintadas2916))'),
  'el límite de tarjetas se aplica tras agrupar, no antes');
assert.ok(salud.includes("action('Ver más', () => { saludLimite299 += 10;"),
  'el «Ver más» de siempre sigue cerrando la rejilla');

/* El veredicto protagonista y la bitácora siguen abriendo. */
const pintar = salud.slice(salud.indexOf('function saludTarjetasPintar200d'), salud.indexOf('function saludConfigPintar200d'));
assert.ok(pintar.indexOf('saludVeredicto240(data)') < pintar.indexOf('pisos2916'),
  'el veredicto abre la pantalla, antes de los pisos');
assert.ok(pintar.indexOf('saludBitacora240()') < pintar.indexOf('pisos2916'),
  'la bitácora va tras el veredicto y antes de los pisos');

/* ── Cada tarjeta: estado, última revisión, siguiente paso ─ */
assert.ok(salud.includes("'Comprobada: ' + tarjeta.frescuraTexto"),
  'la última revisión se sigue diciendo en la cabecera de cada tarjeta');
assert.ok(salud.includes("tarjeta.estado === 'bien'\n    ? 'Siguiente paso: ninguno — se vigila solo.'"),
  'una tarjeta bien sin botón dice su siguiente paso: ninguno, se vigila solo');
assert.ok(salud.includes("'Siguiente paso: sin arreglo en un toque; se vuelve a comprobar al revisar la salud.'"),
  'una tarjeta no-bien sin botón dice su siguiente paso con honestidad');
assert.ok(salud.includes("if (accionesNode) card.append(accionesNode);"),
  'con botón, el siguiente paso ES el botón (no se duplica en texto)');

/* ── Corrección tras la verificación en vivo (19 nov) ─────
   El veredicto (anterior a la ronda) no contaba las piezas
   «sin dato» en ningún sitio, y los pisos las cuentan dentro
   de «A vigilar»: la pantalla decía «3 a vigilar» arriba y
   «5 piezas» en el piso. Y el piso de acción vacío no se
   pintaba: la jerarquía se leía de dos pisos. */
const veredicto = salud.slice(salud.indexOf('function saludVeredicto240'), salud.indexOf('function saludBitacora240'));
assert.ok(veredicto.includes("sinDato = tarjetas.filter(t => t.estado !== 'mal' && t.estado !== 'vigilar' && t.estado !== 'bien')"),
  'el veredicto reparte las «sin dato» con la misma regla que los pisos (todo lo que no es mal, vigilar ni bien)');
assert.ok(veredicto.includes("'Y sin dato: ' + sinDato.map(t => t.titulo)"),
  'con piezas malas, las sin dato también se nombran en el veredicto');
assert.ok(veredicto.includes("partes2916.join(' y ')") && veredicto.includes("sinDato.length + ' sin dato'"),
  'sin piezas malas, el titular suma por partes: «con N a vigilar y M sin dato» — el mismo total que cuenta el piso');
assert.ok(veredicto.includes('} else if (aVigilar.length || sinDato.length) {'),
  '«Todo bien» solo se afirma cuando no hay mal, ni vigilar, ni sin dato');
assert.ok(salud.includes("if (!visibles.length && piso.clave !== 'mal') continue;") &&
  salud.includes("'Nada requiere tu acción ahora.'"),
  'el piso de acción vacío se pinta con su cabecera y su línea calma; los otros dos conservan su ausencia');

/* La CSS de los pisos viaja en el artefacto. */
assert.ok(html.includes('.salud-piso-cab2916{display:flex'), 'la cabecera de piso tiene su estilo');
assert.ok(html.includes('.salud-paso2916{margin-top:8px}'), 'la línea de siguiente paso tiene su estilo');

console.log('ronda2916salud: OK — tres pisos en orden, corte tras agrupar, y cada tarjeta con estado, revisión y siguiente paso.');
