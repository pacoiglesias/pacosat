import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as vm from 'node:vm';

/* ================================================================
   Ronda 2.9.16 · P6 — Estados más diferenciados: el color se
   mantiene consistente, pero ningún estado depende de él.
   Cada estado canónico se distingue por TRES canales: su
   palabra, su icono (silueta distinta en el sprite) y, desde
   esta ronda, su propio borde — punteado en Pendiente,
   continuo con el icono girando en En proceso, continuo
   grueso (y doble cuando es grave) en Requiere atención,
   continuo en Completado —. En escala de grises quedan
   cuatro siluetas distintas.

   Y la tarjeta de cuota de Descargar deja de enseñar DOS
   iconos por estado: anteponía a mano el suyo sobre la
   píldora, que ya trae el suyo por estado; rojo y ámbar,
   además, compartían el mismo triángulo antepuesto y ahora
   se distinguen (aspa en círculo frente a triángulo).
   ================================================================ */
const AQUI = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(AQUI, 'Faro-Fiscal.html'), 'utf8');
const monitor = readFileSync(join(AQUI, 'monitor-ui.part'), 'utf8');

/* ── El mapa canónico: 4 estados, 4 iconos distintos ─────── */
function extraer(desde, hasta, incluirFin = false) {
  const i = html.indexOf(desde);
  assert.ok(i >= 0, 'no se encontró: ' + desde);
  const j = html.indexOf(hasta, i);
  assert.ok(j > i, 'no se encontró el fin: ' + hasta);
  return html.slice(i, incluirFin ? j + hasta.length : j);
}
const ctx = {};
vm.createContext(ctx);
vm.runInContext(extraer('const ESTADOS2915', 'function estadoChip2915'), ctx);
const ESTADOS2915 = vm.runInContext('ESTADOS2915', ctx);
assert.ok(ESTADOS2915 && typeof ESTADOS2915 === 'object', 'el mapa de estados se extrae del artefacto');
assert.deepEqual(Object.keys(ESTADOS2915).sort(), ['atencion', 'completado', 'en-proceso', 'pendiente'],
  'los cuatro estados canónicos, ni uno más ni uno menos');
const iconos = Object.values(ESTADOS2915).map(e => e.icono);
assert.equal(new Set(iconos).size, 4, 'cuatro iconos distintos: ' + iconos.join(', '));
const etiquetas = Object.values(ESTADOS2915).map(e => e.etiqueta);
assert.equal(new Set(etiquetas).size, 4, 'cuatro palabras distintas: ' + etiquetas.join(', '));

/* Los cuatro iconos existen en el sprite. */
for (const icono of iconos)
  assert.ok(html.includes('id="i-' + icono + '"'), 'el sprite trae el icono ' + icono);

/* ── El tercer canal: el borde de cada estado ────────────── */
assert.ok(html.includes('.estado-pendiente{border:1.5px dashed currentColor}'),
  'Pendiente: borde punteado');
assert.ok(html.includes('.estado-en-proceso{border:1.5px solid currentColor}'),
  'En proceso: borde continuo');
assert.ok(html.includes('.estado-en-proceso svg{animation:pacosat-spin 1.8s linear infinite}'),
  'En proceso: su icono gira (canal de movimiento)');
assert.ok(html.includes('@media (prefers-reduced-motion:reduce){.estado-en-proceso svg{animation:none}}'),
  'con movimiento reducido, el giro se apaga y quedan icono, palabra y borde');
assert.ok(html.includes('.estado-atencion{border:2px solid currentColor}'),
  'Requiere atención: borde continuo grueso');
assert.ok(html.includes('.estado-atencion.estado-grave2915{border:3px double currentColor}'),
  'Requiere atención grave: borde DOBLE — se distingue de la no grave sin color');
assert.ok(html.includes('.estado-completado{border:1.5px solid currentColor}'),
  'Completado: borde continuo, con su check y su palabra');

/* La paleta no se toca: los colores salen de las variables
   de siempre (currentColor toma el tinte de cada estado). */
assert.ok(html.includes('.estado-pendiente{background:var(--info-bg);color:var(--info-ink)}'),
  'los colores de los chips siguen siendo los de la 2.9.15');

/* ── La cuota: un icono por estado, y distinto ─────────── */
assert.ok(monitor.includes('pill.prepend(icon(sem.icono))'),
  'la cuota pinta el icono de su semáforo (su único icono: la píldora solo trae un punto)');
const semaforo = monitor.slice(monitor.indexOf('function cuotaSemaforo240'), monitor.indexOf('function cuotaTarjeta240'));
assert.ok(semaforo.includes("s === 'rojo') return { state: 'bad', icono: 'close'"),
  'rojo lleva el aspa, no el triángulo de ámbar');
assert.ok(semaforo.includes("icono: 'alert', palabra: 'En ámbar'") &&
  semaforo.includes("icono: 'check', palabra: 'En verde'") &&
  semaforo.includes("icono: 'clock', palabra: 'Sin dato del servidor'"),
  'ámbar = triángulo, verde = marca, sin dato = reloj: cuatro iconos distintos');

console.log('ronda2916estados: OK — cuatro estados distinguibles sin color (palabra, icono y borde) y la cuota con un icono distinto por estado.');
