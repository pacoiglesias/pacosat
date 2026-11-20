/* 3.0 · Bloque F — el móvil de verdad.
   Comprobación de verdad: los artefactos que el iPhone
   carga llevan (21) la barra de pulgar con «Al día» como
   primer gesto, cableado a la corrida y a Descargar, con
   Buzón vivo en el menú (paridad); (22) las acciones de un
   toque en las tarjetas de Facturas con los mismos efectos
   que el menú ⋯, que sigue entero; (23) la posición de la
   lista guardada al abrir la ficha y restaurada al
   repintar; (24) el manifiesto instalable de la casa;
   (25) el envío por la hoja del sistema, que ya existía y
   se verifica; (26) Hoy que abre con lo último conocido y
   se refresca con el sondeo; (27) el service worker que
   por fin navega al destino del aviso con la app abierta;
   (28) los objetivos de dedo ≥44px en lo nuevo y en la
   barra. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('./Faro-Fiscal.html', import.meta.url), 'utf8');
const layout = await readFile(new URL('./layout.part', import.meta.url), 'utf8');
const ui = await readFile(new URL('./ui.part', import.meta.url), 'utf8');
const workflows = await readFile(new URL('./workflows.part', import.meta.url), 'utf8');
const finalUi = await readFile(new URL('./final-ui.part', import.meta.url), 'utf8');
const server = await readFile(new URL('./local-server.mjs', import.meta.url), 'utf8');
const polish = await readFile(new URL('./polish.part', import.meta.url), 'utf8');

/* 21 · La barra de pulgar. */
const barra = layout.slice(layout.indexOf('<nav class="bottombar"'), layout.indexOf('</nav>', layout.indexOf('<nav class="bottombar"')));
assert.ok(barra.includes('id="aldia30-bar"'), 'La barra lleva el botón «Al día».');
assert.ok(barra.indexOf('aldia30-bar') < barra.indexOf('data-view="home"'), '«Al día» es el primer gesto de la barra.');
for (const vista of ['home', 'descargar', 'avisos'])
  assert.ok(barra.includes('data-view="' + vista + '"'), 'La barra lleva su destino: ' + vista);
assert.ok(!barra.includes('data-view="tributario"'), 'Buzón sale de la barra (queda en el menú lateral y en Más).');
assert.ok(layout.includes('data-view="tributario"'), 'Paridad: Buzón sigue en el menú lateral.');
assert.ok(finalUi.includes('aldiaBarCableado30') && finalUi.includes('aldiaRun30(rfcBar30)') && finalUi.includes("navigate('descargar')"),
  'El botón de la barra lanza la corrida y lleva a Descargar.');

/* 22 · Un toque en las tarjetas de Facturas. */
assert.ok(workflows.includes('function invoiceQuick30('), 'La franja de un toque existe.');
for (const etiqueta of ["'Ver'", "'PDF'", "'Enviar'"])
  assert.ok(workflows.includes('n(\'button\', ' + etiqueta) || workflows.includes(etiqueta), 'La franja lleva: ' + etiqueta);
assert.ok(ui.includes('invoiceQuick30(row)'), 'Las tarjetas montan la franja al pintarse.');
assert.ok(workflows.includes('function invoiceActions('), 'Paridad: el menú ⋯ de la fila sigue entero.');

/* 23 · La posición de la lista se conserva. */
assert.ok(workflows.includes('window.__scrollFacturas30 = window.scrollY'), 'Al abrir la ficha se guarda la posición.');
assert.ok(ui.includes('window.__scrollFacturas30') && ui.includes('window.scrollTo(0, destino30)'), 'Al repintar Facturas se restaura.');

/* 24 · El manifiesto instalable (ruta del servidor). */
assert.ok(server.includes("short_name: 'PacoSAT'") && server.includes("display: 'standalone'"), 'El manifiesto nombra PacoSAT y abre como app.');
assert.ok(server.includes("icon-512.png") && server.includes('maskable'), 'El manifiesto trae su icono enmascarable.');

/* 25 · Enviar por la hoja del sistema (preexistente, verificado). */
assert.ok(ui.includes('function enviarCompartirArchivo240(') || html.includes('enviarCompartirArchivo240'),
  'Compartir usa la hoja del sistema.');
assert.ok(ui.includes('function enviarPorWhatsApp240(') || html.includes('enviarPorWhatsApp240'),
  'WhatsApp sale desde el aparato, como manda la casa.');

/* 26 · Hoy instantánea con lo último conocido. */
assert.ok(ui.includes("localStorage.getItem('pacosat30-satdata')"), 'El arranque hidrata el estado desde la copia del aparato.');
const satUi = await readFile(new URL('./sat-ui.part', import.meta.url), 'utf8');
assert.ok(satUi.includes("localStorage.setItem('pacosat30-satdata'"), 'Cada sondeo con éxito renueva la copia.');

/* 27 · El aviso abre SU factura también con la app abierta. */
assert.ok(server.includes('w.navigate(destino30)'), 'El service worker navega al destino del aviso.');

/* 28 · Tamaño de dedo. */
assert.ok(polish.includes('.rapidas30 button{min-height:44px'), 'Las acciones de un toque miden para el dedo.');
assert.ok(polish.includes('@media (pointer:coarse)'), 'La pasada de puntero grueso existe.');
assert.ok(polish.includes('.cob-falta-mes30{min-height:56px'), 'La rejilla de meses también mide para el dedo.');

console.log('OK 3.0-F: barra con «Al día», un toque en Facturas, posición conservada, manifiesto, compartir del sistema, Hoy instantánea y objetivos de dedo.');
