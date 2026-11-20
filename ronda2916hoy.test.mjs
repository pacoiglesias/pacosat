import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/* ================================================================
   Ronda 2.9.16 · P2 — Hoy prioriza las tareas: la pantalla
   abre con «Tus tareas», la lista de pendientes ordenada por
   urgencia con su botón directo, y los indicadores (mando y
   cifras) bajan a contexto.

   La lista FUNDE tres bloques que antes vivían separados —
   la franja «Requiere tu atención» de la 2.9.15, el panel
   «Lo que te necesita» (los gestos) y el panel «A medias» —:
   cada cosa sale una sola vez. Pisos de urgencia: 0 = Salud
   mal, 1 = gestos, 2 = Salud en vigía, 3 = a medias. Tope
   visible de 7 y el resto en un plegable del mismo panel.
   Sin foto cargada y sin filas no hay panel (ni hueco); con
   todo cargado y cero filas, el panel dice «Sin tareas
   pendientes» — un hecho calculado, no un adorno.
   ================================================================ */
const AQUI = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(AQUI, 'Faro-Fiscal.html'), 'utf8');
const ui = readFileSync(join(AQUI, 'ui.part'), 'utf8');
const finalUi = readFileSync(join(AQUI, 'final-ui.part'), 'utf8');

function extraer(desde, hasta) {
  const i = html.indexOf(desde);
  assert.ok(i >= 0, 'no se encontró: ' + desde);
  const j = html.indexOf(hasta, i);
  assert.ok(j > i, 'no se encontró el fin tras: ' + desde);
  return html.slice(i, j);
}

/* ── La lista existe y compone en orden de pisos ─────────── */
const tareas = extraer('function hoyTareas2916()', '(function cablearFoco290()');
const iMal = tareas.indexOf("t.estado === 'mal'");
const iGestos = tareas.indexOf('gestosLista1311()');
const iVigilar = tareas.indexOf("t.estado === 'vigilar'");
const iMedias = tareas.indexOf('aMediasCache2916');
assert.ok(iMal >= 0 && iGestos > iMal && iVigilar > iGestos && iMedias > iVigilar,
  'los pisos se componen en orden: mal → gestos → vigilar → a medias');
assert.ok(tareas.includes("panel('Tus tareas'"), 'el panel se titula «Tus tareas»');
assert.ok(tareas.includes("classList.add('atencion2915', 'tareas2916')"),
  'el panel conserva la clase de la franja de la 2.9.15 y gana la suya');
assert.ok(tareas.includes('filas.slice(0, 7)') && tareas.includes("plegable290('Ver las ' + resto2916.length + ' tareas restantes'"),
  'tope visible de 7 y el resto en un plegable del mismo panel');
assert.ok(tareas.includes("'Sin tareas pendientes: nada espera tu mano ni tu atención ahora.'"),
  'con todo cargado y cero filas, el panel lo dice');
assert.ok(tareas.includes('if (!filas.length && !cargado2916) return null;'),
  'sin foto y sin filas no hay panel: ni hueco vacío');
assert.ok(tareas.includes('p.dataset.gestos1311 = \'1\';'),
  'el panel es el anfitrión del gesto CIEC que llega con los datos del mes');

/* Los chips de cada piso salen del sistema canónico. */
assert.ok(tareas.includes("estadoChip2915(t.estado === 'mal' ? 'atencion' : 'pendiente'"),
  'las filas de Salud llevan su chip canónico');
assert.ok(tareas.includes("estadoChip2915('en-proceso', 'En proceso')"),
  'las filas a medias llevan el chip «En proceso»');
assert.ok(tareas.includes('seguirBoton230(jobId230)'),
  'el «Seguir» de un trabajo a medias reanuda de verdad, como en su panel de origen');

/* La foto de «a medias» se cachea como la de Salud (60 s) y
   un fallo no entra en bucle de repintado. */
const foto = extraer('function aMediasRefrescar2916()', 'function hoyTareas2916()');
assert.ok(foto.includes("satApi('a-medias201')") && foto.includes('Date.now() - aMediasFoto2916 < 60000'),
  'la lectura de a medias se cachea un minuto');
assert.ok(ui.includes('catch(() => { aMediasFoto2916 = Date.now();'),
  'un fallo también sella la foto: nada de bucle de repintados');

/* ── Hoy monta tareas primero y el mando sin gestos ──────── */
const home = extraer('function home()', 'const invoiceStateOf');
assert.ok(home.indexOf('hoyTareas2916()') < home.indexOf('hoyMando201(null)'),
  '«Tus tareas» va antes que el mando');
assert.ok(home.includes('blocks.push(hoyMando201(null));'),
  'el mando se monta sin gestos dentro');
assert.ok(home.indexOf('hoyMando201(null)') < home.indexOf('hoyDiaCifras2913()'),
  'las cifras quedan debajo, como contexto');

/* ── Las fusiones son reales: los paneles viejos no existen ─ */
assert.ok(!html.includes('function hoyAtencion2915'), 'la franja suelta de la 2.9.15 se fundió en «Tus tareas»');
assert.ok(!html.includes('function aMedias201Panel'), 'el panel «A medias» se fundió en «Tus tareas»');
assert.ok(!html.includes('function gestosPanel1311'), 'el panel «Lo que te necesita» se fundió en «Tus tareas»');
assert.ok(html.includes('function gestosLista1311'), 'la FUENTE de los gestos sigue viva (insignia del menú y lista)');
assert.ok(html.includes('function atencionHoyFilas2915'), 'el filtro de la franja sigue vivo: alimenta el piso de Salud');

/* El mando acepta y tolera la ausencia de gestos. */
assert.ok(ui.includes('if (gestos232) wrap.append(gestos232);'),
  'hoyMando201 monta los gestos solo si llegan (hoy no llegan)');

/* El gesto CIEC entra en la lista con el formato de sus
   filas y limpia su línea de vacío. */
assert.ok(finalUi.includes("querySelectorAll('.tareas-vacio2916')"),
  'la fila CIEC retira la línea «Sin tareas pendientes» al entrar');
assert.ok(finalUi.includes("n('div', undefined, 'atencion-fila2915 tarea-fila2916')"),
  'la fila CIEC se pinta como una fila más de «Tus tareas»');

console.log('ronda2916hoy: OK — «Tus tareas» manda en Hoy; franja, gestos y a medias fundidos sin perder filas.');
