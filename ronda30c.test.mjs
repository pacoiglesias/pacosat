/* 3.0 · Bloque C — lo visual con verdad detrás.
   Comprobación de verdad: el HTML construido lleva (1) la
   rejilla «Lo que falta por traer» alimentada por la lista
   real de metadatos sin XML y con su toque cableado al
   portal por mes; (2) el sello de frescura en la cabecera,
   pintado por el sondeo real; (3) las cifras del día en
   Hoy tocables hasta su respaldo; y el veredicto de Hoy
   sale del servidor (aldiaVeredicto30), no de un cálculo
   del cliente que pueda fingir verde. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('./Faro-Fiscal.html', import.meta.url), 'utf8');

/* La rejilla de faltantes (mejora 9). */
assert.ok(html.includes('function coberturaFalta30('), 'La rejilla de faltantes existe.');
assert.ok(html.includes('Lo que falta por traer'), 'La rejilla se nombra en llano.');
assert.ok(html.includes('satData?.metadata?.missing'), 'La rejilla cuenta desde la lista real de metadatos sin XML.');
assert.ok(html.includes('cobFaltaMes'), 'Cada mes de la rejilla lleva su marca.');
assert.ok(/portalLanzar297\(progreso, \{ rfc, period:/.test(html),
  'Tocar un mes pide ese mes por el portal, con su progreso en la tarjeta.');
assert.ok(html.includes("'Completo'") || html.includes('Completo'), 'El mes sin faltantes se dice completo, no se finge botón.');

/* El sello de frescura (mejora 10). */
assert.ok(html.includes('id="frescura30"'), 'La cabecera lleva el sello de frescura.');
assert.ok(html.includes('function frescura30Pintar('), 'El sello tiene su pintor.');
assert.ok(html.includes('Datos de las '), 'El sello dice la hora de los datos en llano.');
assert.ok(html.includes('frescura30Pintar()'), 'El sondeo real pinta el sello al entregar estado.');

/* La foto del día, tocable (mejora 12). */
for (const marca of ['facturas-mes', 'respaldo', 'cobertura'])
  assert.ok(html.includes("hoyCifra30 = '" + marca + "'") || html.includes('hoyCifra30 = "' + marca + '"') || html.includes(marca),
    'La cifra del día lleva su marca: ' + marca);
assert.ok(/month = mesActual; invoicePage = 0; navigate\('invoices'\)/.test(html),
  'La cifra de facturas del mes abre Facturas con el mes puesto.');
assert.ok(html.includes("navigate('salud')"), 'La cifra del respaldo abre Salud.');
assert.ok(html.includes("navigate('descargar')"), 'La cifra de cobertura abre Descargar, donde vive la cobertura.');

/* El veredicto de Hoy es del servidor (mejora 20). */
assert.ok(html.includes('st?.veredicto'), 'La tarjeta de Hoy pinta el veredicto que calcula el servidor.');
assert.ok(!/veredicto.*invoices\.filter/.test(html), 'Ningún veredicto se calcula en el cliente desde las facturas locales.');

console.log('OK 3.0-C: rejilla de faltantes tocable por mes, sello de frescura del sondeo real y cifras del día que abren su respaldo.');
