import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/* ================================================================
   Ronda 2.9.16 · P7 — Experiencia por perfil: la vista y los
   controles responden al alcance de la sesión, usando el
   modelo que ya existe (usuarios con nombre y alcance por
   RFC de la 2.9.8) — ningún sistema de acceso nuevo.

   · El alcance se lee de GET /api/guest/config, el único
     sitio que lo declara entero (sesionUsuario, rfcs,
     sesionContadora), y se enseña en la barra: «Sesión:
     nombre · Solo lectura · N RFC». La sesión del
     propietario no lleva rótulo: es la de siempre.
   · Una sesión de solo lectura (rol lectura o invitado
     clásico) no ve los controles de escritura de la
     cabecera — importar, la acción principal y «Agregar
     RFC» —: el servidor los rechazaría; enseñarlos sería
     enseñar botones que no le corresponden.
   · Sus «Tus tareas» no incluyen los gestos de
     administración, la fila CIEC no entra para ella y la
     insignia de gestos del menú no los cuenta.
   · La vista inicial sigue siendo Hoy para todos (la
     contadora conserva su lista del mes de la 1.25.0): lo
     que cambia con el perfil es su contenido y sus
     controles, no el destino.
   ================================================================ */
const AQUI = dirname(fileURLToPath(import.meta.url));
const leer = f => readFileSync(join(AQUI, f), 'utf8');
const html = leer('Faro-Fiscal.html');
const ui = leer('ui.part');
const layout = leer('layout.part');
const finalUi = leer('final-ui.part');

/* ── El puente de alcance: una sola fuente, la de siempre ── */
assert.ok(ui.includes('function sesionAlcance2916()'), 'existe el lector de alcance de la sesión');
const puente = ui.slice(ui.indexOf('function sesionAlcance2916()'), ui.indexOf('function pintarSesion2916()'));
assert.ok(puente.includes("satApi('guest/config')"), 'el alcance sale de /api/guest/config, como la vista de la contadora');
assert.ok(puente.includes('cfg.sesionUsuario') && puente.includes('cfg.rfcs') && puente.includes('cfg.sesionContadora'),
  'se leen el usuario con nombre, sus RFC y la marca de contadora');
assert.ok(puente.includes("'administrador'") && puente.includes("'lectura'") && puente.includes("'invitado'") && puente.includes("'propietario'"),
  'los cuatro tipos de sesión salen del rol real, sin inventar roles');
assert.ok(!puente.includes('localStorage'), 'el alcance no se guarda en el navegador: manda el servidor');

/* ── La línea de sesión en la barra ──────────────────────── */
assert.ok(layout.includes('id="sesion-line2916"'), 'la barra trae la línea de sesión');
assert.ok(ui.includes("partes.push(alcance.tipo === 'administrador' ? 'Administración'"),
  'la línea nombra el alcance con palabras: Administración');
assert.ok(ui.includes("'Solo lectura' : 'Invitado · Solo lectura'"),
  '…o Solo lectura, sea con nombre o invitado');
assert.ok(ui.includes("if (!alcance || alcance.tipo === 'propietario') { linea.hidden = true; return; }"),
  'la sesión del propietario no enseña rótulo');
assert.ok(html.includes('.sesion-line2916{font-size:12px'), 'la línea tiene su estilo en la voz baja de la barra');

/* ── Los controles que no corresponden, fuera ────────────── */
assert.ok(ui.includes("if ($('inspect')) $('inspect').hidden = !importingHere || soloLectura2916;"),
  '«Abrir XML» no se enseña en solo lectura');
assert.ok(ui.includes("if ($('pdf-import')) $('pdf-import').hidden = !importingHere || soloLectura2916;"),
  '«Factura PDF» no se enseña en solo lectura');
assert.ok(ui.includes("if ($('add')) $('add').hidden = soloLectura2916;"),
  '«Agregar RFC» no se enseña en solo lectura');
assert.ok(ui.includes("$('primary').hidden = soloLectura2916;"),
  'la acción principal de la cabecera no se enseña en solo lectura');
assert.ok(ui.includes('const soloLectura2916 = typeof guestMode !== \'undefined\' && guestMode;'),
  'la marca es la de siempre: guestMode (lectura con nombre o invitado clásico)');

/* ── Hoy se ajusta al alcance ────────────────────────────── */
const tareas = ui.slice(ui.indexOf('function hoyTareas2916()'), ui.indexOf('(function cablearFoco290()'));
assert.ok(tareas.includes('const esLectura2916 = typeof guestMode !== \'undefined\' && guestMode;') &&
  tareas.includes('if (!esLectura2916 && typeof gestosLista1311 === \'function\')'),
  'los gestos de administración no entran en las tareas de una sesión de lectura');
assert.ok(finalUi.includes("if (typeof guestMode !== 'undefined' && guestMode) return;\n  const wrap = document.querySelector('[data-gestos1311]');"),
  'la fila CIEC tampoco entra para una sesión de lectura');
assert.ok(finalUi.includes("((typeof guestMode !== 'undefined' && guestMode) ? 0 : gestosLista1311().length)"),
  'la insignia de gestos del menú no cuenta gestos ajenos a la sesión');

/* ── Lo que NO cambia: el modelo de acceso es el de la 2.9.8 ─ */
assert.ok(ui.includes('function sesionNombrada298()'), 'la sesión con nombre sigue leyéndose como en la 2.9.8');
assert.ok(ui.includes("panel('Lo que te necesita'") === false, 'sin paneles nuevos de gestos');
assert.ok(html.includes('usersPanelReal298') || html.includes('usersPanel298'),
  'el panel de usuarios con nombre sigue siendo el de la 2.9.8');

console.log('ronda2916perfil: OK — el alcance manda en cabecera, barra y tareas, con el modelo de acceso de siempre.');
