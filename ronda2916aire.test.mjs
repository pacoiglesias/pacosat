import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/* ================================================================
   Ronda 2.9.16 · P4 — Más aire: el patrón de plegables de
   Descargar (2.9.15) se extiende a las pantallas densas.
   Plegado ≠ retirado: cada bloque plegado se sigue
   construyendo igual que siempre y queda a un toque, con su
   clave de memoria; la vista inicial se reserva a lo
   habitual y lo protagonista NO se pliega jamás.

   Pliegues nuevos de esta ronda:
   · Salud: «Mantenimiento y piezas avanzadas» (autorrepa-
     ración, deshacer, duplicados, revisión programada).
   · Declaraciones: «Recuperar por años y
     cómo funciona» tras el mapa.
   · Bancos: «Conciliación asistida y reglas de clasifica-
     ción» tras la conciliación del día.
   · Listas negras: «Las fuentes, una a una» y «Cambios
     detectados».
   Ya plegados de antes (se comprueba que siguen): Descargar
   (2.9.15) y los <details> de Dinero, Declaraciones (diario)
   y Documentos (diario por documento).
   ================================================================ */
const AQUI = dirname(fileURLToPath(import.meta.url));
const leer = f => readFileSync(join(AQUI, f), 'utf8');
const salud = leer('salud-ui.part');
const decl = leer('declaraciones-ui.part');
const bancos = leer('banks-ui.part');
const listas = leer('lists-ui.part');
const sat = leer('sat-ui.part');
const dinero = leer('money-ui.part');
const satdocs = leer('satdocs-ui.part');

/* ── Salud: el grupo avanzado, con sus cuatro paneles ────── */
const iFoldSalud = salud.indexOf("plegable290('Mantenimiento y piezas avanzadas'");
assert.ok(iFoldSalud >= 0, 'Salud pliega su grupo de mantenimiento');
const grupoSalud = salud.slice(salud.indexOf('const avanzado2916'), iFoldSalud);
for (const fn of ['saludAutoPanel201(data.auto201)', 'saludDeshacerPanel201()', 'saludDuplicadosPanel201()', 'revisionPanel200e()'])
  assert.ok(grupoSalud.includes(fn), 'el grupo de Salud contiene ' + fn + ' (se construye igual que siempre)');
assert.ok(salud.includes("'salud-avanzado2916'"), 'el pliegue de Salud tiene su clave de memoria');
/* Lo habitual de Salud NO se pliega: veredicto, bitácora y
   la línea de Listas van fuera del grupo. */
assert.ok(salud.indexOf('body.append(saludListasLinea201());') < iFoldSalud &&
  salud.indexOf('body.append(saludListasLinea201());') > salud.indexOf('saludVeredicto240(data)'),
  'la línea de Listas queda visible, antes del grupo plegado');

/* ── Declaraciones: lo ocasional, tras el mapa ───────────── */
const iFoldDecl = decl.indexOf("plegable290('Recuperar por años y cómo funciona'");
assert.ok(iFoldDecl >= 0, 'Declaraciones pliega la recuperación por años y la explicación');
const grupoDecl = decl.slice(decl.indexOf('const detalleEj2916'), iFoldDecl);
for (const fn of ['declAniosPanel(view, fill)', 'declComoFunciona()'])
  assert.ok(grupoDecl.includes(fn), 'el pliegue de Declaraciones contiene ' + fn);
/* La lista de folios NO se pliega: es el detalle de trabajo
   de la pantalla y se monta a la vista, antes del pliegue. */
assert.ok(decl.indexOf('body.append(declFoliosPanel(view, fill));') >= 0 &&
  decl.indexOf('body.append(declFoliosPanel(view, fill));') < iFoldDecl,
  'la lista de folios queda a la vista, antes del pliegue');
/* El mapa (lo habitual) se monta ANTES del pliegue. */
assert.ok(decl.indexOf('body.append(grid, detalle);') < iFoldDecl,
  'el mapa del año se pinta antes que el detalle plegado');
/* El diario de corridas ya era un <details>: no se repliega. */
assert.ok(decl.includes("const details = n('details', undefined, 'sat-run');"),
  'el diario de Declaraciones sigue en su <details> de siempre');

/* ── Bancos: asistida y reglas, tras la conciliación ─────── */
const iFoldBancos = bancos.indexOf("plegable290('Conciliación asistida y reglas de clasificación'");
assert.ok(iFoldBancos >= 0, 'Bancos pliega la conciliación asistida y las reglas');
const grupoBancos = bancos.slice(bancos.indexOf('const asistida2916'), iFoldBancos);
assert.ok(grupoBancos.includes('reconcilePanel(') && grupoBancos.includes('bancosReglasPanel240()'),
  'el grupo de Bancos contiene la asistida y las reglas');
assert.ok(bancos.indexOf('body.append(bancosConciliacionPanel200f());') < iFoldBancos,
  'la conciliación del día queda visible, antes del pliegue');

/* ── Listas negras: fuentes e histórico plegados ─────────── */
assert.ok(listas.includes("plegable290('Las fuentes, una a una', sourcesPanel, 'listas-fuentes2916')"),
  'las fuentes de Listas van plegadas');
assert.ok(listas.includes("plegable290('Cambios detectados', eventsPanel, 'listas-cambios2916')"),
  'el histórico de cambios de Listas va plegado');
assert.ok(listas.includes('wrap.append(listsVeredictoPanel240(data));'),
  'el veredicto de Listas sigue abriendo la pantalla, sin plegar');

/* ── Lo ya plegado de antes sigue plegado (paridad) ──────── */
for (const clave of ['desc-anio2915', 'desc-hist2915', 'desc-cobertura2915'])
  assert.ok(sat.includes("'" + clave + "'"), 'Descargar conserva su pliegue ' + clave);
assert.ok(dinero.includes("n('details'"), 'Dinero conserva sus grupos en <details>');
assert.ok(satdocs.includes("n('details', undefined, 'sat-run')"),
  'el diario por documento de Documentos sigue en sus <details>');

/* Ningún constructor plegado desaparece del árbol. */
for (const [src, fn] of [[salud, 'function saludAutoPanel201'], [salud, 'function saludDeshacerPanel201'],
  [salud, 'function saludDuplicadosPanel201'], [salud, 'function revisionPanel200e'],
  [decl, 'function declFoliosPanel'], [decl, 'function declAniosPanel'], [decl, 'function declComoFunciona'],
  [bancos, 'function bancosReglasPanel240'], [listas, 'function listsVeredictoPanel240']])
  assert.ok(src.includes(fn), 'sigue existiendo ' + fn);

console.log('ronda2916aire: OK — cuatro pantallas respiran con pliegues nuevos y ningún bloque retirado.');
