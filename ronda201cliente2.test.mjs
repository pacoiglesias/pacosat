/* ================================================================
   Ronda 2.0.1 · Fase 2 (cliente) — las 30 mejoras sobre la
   estructura limpia: el cliente consume los contratos de la
   fase 1 tal como el servidor los sirve de verdad (verificados
   contra local-server.mjs, no contra la nota: duplicados201
   trae {sospechosos:[{detalle, comprobantes[]}]}, deshacer201
   trae {acciones:[{texto, accion, payload, limite}]} y
   a-medias201 trae {items:[{texto, seguir:{vista}}]}).
   Esta suite fija el cableado en el artefacto construido y en
   las partes diferidas, y en unidad la plantilla «anio».
   ================================================================ */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { downloadShortcutRange } from './xml-core.mjs';

const ROOT = new URL('.', import.meta.url).pathname;
const html = readFileSync(join(ROOT, 'Faro-Fiscal.html'), 'utf8');
const lazy = JSON.parse(readFileSync(join(ROOT, 'lazy.json'), 'utf8'));
const parte = nombre => {
  const found = Object.entries(lazy.partes).find(([name]) => name === nombre);
  assert.ok(found, 'la parte diferida «' + nombre + '» existe en lazy.json');
  return found[1].contenido || found[1].content || JSON.stringify(found[1]);
};
const salud = parte('salud'), bancos = parte('bancos'), registro = parte('registro'), salidas = parte('salidas');
/* RE-BASE integración 2.4.0 (W6/W6b): varias piezas que esta
   suite fija viven hoy en partes diferidas (la hoja de
   descarga en Descargas, entre otras). enHtml busca en
   artefacto + TODAS las partes de lazy.json (lo que el
   navegador recibe en total), con los mismos textos y la
   misma fuerza; la ausencia de «Tu ejecutor está despierto»
   se juzga sobre el mismo total (más fuerte: ni en las
   partes puede quedar la frase duplicada). */
const todo201 = html + Object.values(lazy.partes).map(p => p.source).join('\n');
const enHtml = (texto, pieza) => assert.ok(todo201.includes(texto), pieza + ': falta «' + texto + '» en el artefacto (+ sus partes)');

/* (nº 28) La plantilla «Año en curso»: del 1 de enero a hoy,
   y las de siempre intactas. */
assert.deepEqual(downloadShortcutRange('anio', '2026-11-16'), { start: '2026-01-01', end: '2026-11-16' });
assert.deepEqual(downloadShortcutRange('mes-pasado', '2026-11-16'), { start: '2026-10-01', end: '2026-10-31' });
assert.deepEqual(downloadShortcutRange('mes', '2026-11-16'), { start: '2026-11-01', end: '2026-11-16' });
enHtml("'anio', 'Año en curso'", 'nº 28 chip en la hoja de descarga');

/* (nº 5 + nº 21) Confirmación con pre-vuelo: el ayudante único,
   con el último éxito real (ultimoExito) y la prueba de la
   puerta en el sitio; usado por Hoy (buzón/declaraciones),
   por Documentos (bajar acuses) y por la hoja de descarga. */
enHtml('function confirmarDespacho201', 'nº 5/21 ayudante de confirmación');
enHtml('ultimoExito', 'nº 21 ultimoExito en el pre-vuelo');
enHtml("satApi('salud/puerta'", 'nº 21 probar la puerta ahí mismo');
enHtml('Confirmar y pedir al SAT', 'nº 5 confirmación dentro de la hoja de descarga');

/* (nº 4) Modo «Solo lo urgente» en Hoy. */
enHtml('hoyUrgente201', 'nº 4 interruptor de Hoy');
enHtml('Solo lo urgente', 'nº 4 etiqueta del interruptor');

/* (nº 15) Tira fiscal desde la fuente del calendario/ICS. */
enHtml('hoyFiscalTira201', 'nº 15 tira fiscal');
enHtml("satApi('fiscal/calendar')", 'nº 15 fuente fiscal/calendar');

/* (nº 16) A medias, con su «seguir» por pieza. */
enHtml('aMedias201Panel', 'nº 16 panel a medias');
enHtml("satApi('a-medias201')", 'nº 16 contrato a-medias201');
enHtml('item.seguir?.vista', 'nº 16 seguir por pieza');

/* (nº 27) Trabajos esperando con el ejecutor dormido. */
enHtml('ejecutorEspera201', 'nº 27 espera del ejecutor en Hoy');

/* (nº 23) Foto del ejercicio cerrado tocada, en Hoy y en Salud
   (la tarjeta del servidor ya viaja en /api/salud). */
enHtml('fotoTocada201', 'nº 23 foto tocada en Hoy');

/* (nº 3) Ponte al día alineado al cruce201 del servidor. */
enHtml('cruce201', 'nº 3 cruce201 en Documentos');
enHtml('faltanAcuses', 'nº 3 faltanAcuses del cruce');
enHtml('Bajar los que faltan', 'nº 3 botón de recuperación');

/* (nº 6) Línea de vida: hito cancelada y documento enlazado. */
enHtml("hito.tipo === 'cancelada' ? 'Cancelada'", 'nº 6 hito cancelada pintado');
enHtml('hito.documento', 'nº 6 documento del paso enlazado');

/* (nº 22) Tiempo estimado solo cuando el servidor lo da. */
enHtml('tiempoEstimado201', 'nº 22 ayudante de estimación');
enHtml("satApi('tiempos201')", 'nº 22 contrato tiempos201');
enHtml('suele tardar ', 'nº 22 formato en llano junto a la barra');

/* (nº 9) Avisos en dos grupos por gesto y distintivo de gesto. */
enHtml('Necesita tu gesto', 'nº 9 grupo de gesto');
enHtml("'Informativos'", 'nº 9 grupo informativo');
const avisosSrc = readFileSync(join(ROOT, 'avisos-ui.part'), 'utf8');
assert.match(avisosSrc, /avisosBadgeCount[\s\S]{0,400}gesto\?\.de === 'paco'/,
  'nº 9: el distintivo del menú cuenta solo los de gesto de Paco');

/* (nº 10) Marca emisor-nuevo en Avisos y en la ficha. */
enHtml("satApi('marcas200h'", 'nº 10 marcas en el cliente');
enHtml("m.marca === 'emisor-nuevo'", 'nº 10 marca en Avisos');
enHtml("marca === 'emisor-nuevo'", 'nº 10 marca en la ficha de contraparte');

/* (nº 11) Comparativo a/b de Totales, del servidor. */
enHtml('totalesComparativo201', 'nº 11 comparativo en Totales');
enHtml('&a=', 'nº 11 parámetros a/b de totales200h');

/* (nº 12) Vista «Mes» en Dinero, con orígenes nombrados. */
enHtml('dineroMesPanel201', 'nº 12 vista Mes');
enHtml('de tus CFDI guardados', 'nº 12 origen facturas');
enHtml('de los estados de cuenta cargados en Bancos', 'nº 12 origen movimientos');

/* (nº 13 + nº 24 + nº 26) Facturas: contraparte, importe y
   concepto en la búsqueda, orden por importe. */
enHtml('invoiceContraparte201', 'nº 13 selector de contraparte');
enHtml('Total de lo filtrado', 'nº 13 total de lo filtrado');
enHtml('row.concepts', 'nº 24 conceptos en la búsqueda');
enHtml('importe-mayor', 'nº 26 orden por importe');
enHtml('Ordenar por ', 'nº 26 cabeceras tocables');

/* (nº 2) Imprimir generalizado: Avisos, Listas, Registro y
   Contribuyentes usan imprimirVista201. */
enHtml("imprimirVista201('Avisos'", 'nº 2 imprimir Avisos');
enHtml("imprimirVista201('Contribuyentes'", 'nº 2 imprimir Contribuyentes');
enHtml('Listas negras · padrón de contrapartes', 'nº 2 imprimir Listas');
assert.ok(registro.includes('imprimirVista201'), 'nº 2: imprimir en Registro (parte diferida)');

/* (nº 29 + nº 1) La ficha de contraparte descarga su PDF con
   periodo, el mismo generador de Reportes. */
enHtml("kind: 'contraparte'", 'nº 29 PDF de contraparte');
enHtml('Ficha en PDF', 'nº 29 botón en la ficha');

/* (nº 17) Registro: filtros de RFC y clase (ya viajaban) y
   búsqueda de texto sobre el payload. */
assert.ok(registro.includes('registroTexto201'), 'nº 17 búsqueda de texto en Registro');
assert.ok(registro.includes('registroFiltro.clase'), 'nº 17 filtro de clase en Registro');

/* (nº 7 + nº 8 + nº 14) Salud: autorreparación, Deshacer y
   duplicados, en su parte diferida. */
assert.ok(salud.includes('saludAutoPanel201'), 'nº 7 tarjeta de autorreparación');
assert.ok(salud.includes('auto201'), 'nº 7 contrato auto201');
assert.ok(salud.includes("satApi('deshacer201')"), 'nº 8 contrato deshacer201');
assert.ok(salud.includes('accion.accion'), 'nº 8 deshacer por el endpoint de cada entrada');
assert.ok(salud.includes("satApi('duplicados201'"), 'nº 14 contrato duplicados201');
assert.ok(salud.includes('sospechosos'), 'nº 14 sospechosos de duplicados201');

/* (nº 18) Ayuda: los cinco textos que faltaban. */
for (const clave of ['reportes', 'lists', 'bancos', 'cumplimiento', 'salidas'])
  assert.ok(salud.includes(clave + ': {'), 'nº 18: falta el texto de ayuda de «' + clave + '»');
enHtml("dineroTab === 'bancos' ? 'bancos' : page", 'nº 18 la ayuda de Bancos gana en su subvista');

/* (nº 25) Arrastrar y pegar con la misma confirmación. */
assert.ok(bancos.includes('procesarArchivo'), 'nº 25 Bancos: un solo camino de entrada');
assert.ok(bancos.includes("addEventListener('paste'"), 'nº 25 Bancos: pegar');
assert.ok(bancos.includes("addEventListener('drop'"), 'nº 25 Bancos: soltar');
assert.ok(salidas.includes("addEventListener('paste'"), 'nº 25 Documentos: pegar al papel');
const finalSrc = readFileSync(join(ROOT, 'final-ui.part'), 'utf8');
assert.ok(finalSrc.includes("page === 'docs'"), 'nº 25 el interceptor global deja paso a Documentos y Bancos');

/* (nº 30) «Sin rastro» en Bancos, solo lectura. */
assert.ok(bancos.includes('bancosSinRastroPanel201'), 'nº 30 panel Sin rastro');
assert.ok(bancos.includes('facturasSinPagoVisto'), 'nº 30 contrato facturasSinPagoVisto');

/* (nº 19) Versiones en Documentos: la derivación vigente /
   anterior de la limpieza sigue en pie en el artefacto. */
enHtml('satDocVersiones', 'nº 19 versiones de constancia/opinión');

/* (nº 31) Ejecutor integrado: el botón «Ejecutar aquí» es un
   enlace LOCAL pacosat://ejecutar; el estado manda y
   arrancar.bat solo se nombra como reserva junto al botón.
   Vive en Hoy (línea de espera y tarjetas), en la guía
   compartida de Buzón/Declaraciones, en la línea del Buzón
   y en el panel del ejecutor.
   Re-baseline 2.3.2 (M-9): la frase «Tu ejecutor está
   despierto» era la repetición que las tarjetas de Hoy
   hacían de la línea de estado, y M-9 la retiró a propósito:
   el ejecutor se menciona UNA vez en Hoy — su línea de
   estado, linea('Tu ejecutor', …) — y «Ejecutar aquí» sigue
   en «Trabajos esperando». El contrato nuevo es ese: la
   frase duplicada NO está y la mención única SÍ. (El conteo
   ejercido sobre Hoy pintado vive en ronda232cliente:
   «Tu ejecutor» ×1.) */
enHtml('function ejecutarAqui201', 'nº 31 ayudante del botón');
enHtml('pacosat://ejecutar', 'nº 31 enlace local del protocolo');
enHtml('Ejecutar aquí', 'nº 31 etiqueta del gesto');
enHtml('Tu ejecutor está dormido', 'nº 31 el estado manda: dormido');
assert.ok(!todo201.includes('Tu ejecutor está despierto'),
  'nº 31 / M-9: la frase duplicada «Tu ejecutor está despierto» NO está en el artefacto ni en sus partes');
enHtml("linea('Tu ejecutor'", 'nº 31 / M-9: la mención única del ejecutor en Hoy (su línea de estado) sí está');
enHtml(': pulsa «Ejecutar aquí» para despertarlo.',
  'nº 31 / M-9: «Ejecutar aquí» sigue en «Trabajos esperando»');
enHtml('Si el botón no responde, ábrelo con arrancar.bat en tu equipo.',
  'nº 31 arrancar.bat solo como reserva junto al botón');

console.log('ronda201cliente2: OK — fase 2 de cliente de las 30 mejoras, cableada contra los contratos reales.');
