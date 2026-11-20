/* 3.0 · Bloques A y B — el botón en la superficie.
   Comprobación de verdad: el HTML construido (lo que Paco
   abre) lleva la tarjeta «Ponerme al día» cableada a las
   tres rutas del servidor, montada en Hoy y abriendo
   Descargar con su caminante siempre visible; y la paridad
   se mantiene: la tarjeta de periodo y el diálogo de
   petición manual siguen existiendo como camino de
   respaldo — nada desaparece, la protagonista cambia. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('./Faro-Fiscal.html', import.meta.url), 'utf8');
/* Descargar vive en la parte diferida que el servidor sirve
   en /parte/descargas: su contrato se lee en su artefacto. */
const satUi = await readFile(new URL('./sat-ui.part', import.meta.url), 'utf8');

assert.ok(html.includes('function aldia30Card('), 'La tarjeta «Ponerme al día» existe en el cliente.');
for (const ruta of ['al-dia/run', 'al-dia/cancel', 'al-dia/state'])
  assert.ok(html.includes(ruta), 'La tarjeta habla con el servidor: ' + ruta);
for (const marca of ['aldia30Go', 'aldia30Cancel', 'aldia30Veredicto', 'aldia30Frase', 'aldia30Caminante', 'aldia30Puerta', 'aldia30Cupo', 'aldia30Hoy'])
  assert.ok(html.includes(marca), 'La tarjeta pinta su pieza: ' + marca);
assert.ok(html.includes('El caminante del portal'), 'La tarjeta del caminante es visible y se nombra en llano.');
assert.ok(html.includes('Cupo del portal hoy'), 'El cupo del día se enseña en la tarjeta del caminante.');
assert.ok(html.includes('no llegaron'), 'La cuenta honesta del día nombra también lo que no llegó.');

/* Montada en las dos pantallas del encargo. */
assert.ok(/blocks\.push\(aldia30Card\(\)\)/.test(html), 'Hoy monta la tarjeta «Ponerme al día».');
assert.ok(/\[aldia30Card\(\), descargarCard2912\(\)/.test(satUi),
  'Descargar abre con «Ponerme al día» y la tarjeta de periodo queda tras ella.');

/* El veredicto nunca finge: sin revisar no hay verde. */
assert.ok(html.includes("Sin revisar todavía: pulsa «Ponerme al día»"),
  'El veredicto sin datos se dice en llano, nunca en verde.');

/* La primera lectura de la tarjeta espera al montaje
   (regresión vista en las capturas de la ronda: la tarjeta
   se construye antes de entrar en el DOM y un refresco
   inmediato se descartaba, dejando «Revisando…» fijo). */
assert.ok(html.includes('setTimeout(refrescar, 0)'), 'La primera lectura de la tarjeta se difiere al montaje.');
assert.ok(!/const refrescar = async \(\) => \{\s*if \(!card\.isConnected\)/.test(html),
  'El refresco ya no se descarta por «no conectada» en su primera pasada.');

/* Paridad: el camino manual de respaldo sigue entero. */
assert.ok(satUi.includes('function descargarCard2912('), 'La tarjeta de periodo sigue existiendo (respaldo manual).');
assert.ok(satUi.includes('function requestDialog('), 'El diálogo de petición por periodo sigue existiendo (respaldo manual).');
assert.ok(satUi.includes("'Solicitar un periodo'"), 'El gesto «Solicitar un periodo» sigue en la guía de Descargar.');

console.log('OK 3.0-B: la tarjeta «Ponerme al día» vive en Hoy y abre Descargar, con su caminante visible y el respaldo manual intacto.');
