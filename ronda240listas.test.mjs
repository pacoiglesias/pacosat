/* Suite de la ronda 2.4.0 · W3a — «Listas negras»: renombre y
   rediseño de la pantalla de listados.
   (a) El artefacto construido ya no contiene «Listas del SAT»
       como etiqueta visible (menú, título, referencias cruzadas)
       y los ids internos quedan intactos: la ruta /api/lists y
       las fuentes del catálogo responden igual.
   (b) Las dos fuentes manuales (69-csd y 69-reduccion) llevan su
       enlace oficial del SAT en los datos de sat-lists (campo
       enlaceSat, verificado el 17 nov 2026) y la tarjeta de la
       fuente lo pinta junto a la carga manual.
   (c) El veredicto se CALCULA de una respuesta de juguete con el
       golpe STOLOOF SPS2203295V2 (Definitivo, 6 CFDI recibidos,
       $358.156,22, 2023) y pinta RFC, situación, CFDI, importe y
       año; los créditos fiscales van en su clase, sin mezclarse
       con las listas negras.
   (d) Con una respuesta sin golpes, el veredicto dice limpio
       con la fecha real de la última comprobación. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LIST_CATALOG } from './sat-lists.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const read = name => readFileSync(join(ROOT, name), 'utf8');
const html = read('Faro-Fiscal.html');
const listsUi = read('lists-ui.part');
const server = read('local-server.mjs');

const ENLACE_SAT = 'https://www.sat.gob.mx/minisitio/DatosAbiertos/contribuyentes_publicados.html';

/* ---------- (a) renombre visible, ids internos intactos ---------- */
assert.ok(!html.includes('Listas del SAT'),
  'a: el artefacto ya no contiene «Listas del SAT» en ninguna etiqueta visible');
assert.ok(html.includes('data-view="lists"'),
  'a: la entrada del menú conserva su ruta interna «lists»');
assert.ok(/data-view="lists"[^>]*>[\s\S]{0,200}Listas negras/.test(html),
  'a: la entrada del menú se llama «Listas negras»');
assert.ok(html.includes("lists: ['Listas negras'"),
  'a: el título de la pantalla (VIEW_META) es «Listas negras»');
assert.ok(html.includes('Ir a Listas negras'), 'a: Avisos enlaza a «Listas negras»');
assert.ok(html.includes('Listas negras · padrón de contrapartes'),
  'a: la impresión del padrón lleva el nombre nuevo');
assert.ok(html.includes('lists-menu-estado201'),
  'a: el span de estado del menú conserva su id interno');
assert.ok(server.includes("url.pathname === '/api/lists'") &&
  server.includes("url.pathname === '/api/lists/refresh'"),
  'a: las rutas internas /api/lists siguen respondiendo igual');
assert.deepEqual(LIST_CATALOG.map(source => source.id),
  ['69b', '69b-bis', '69-firmes', '69-exigibles', '69-no-localizados',
   '69-cancelados', '69-sentencias', '69-entes-omisos', '69-csd', '69-reduccion'],
  'a: los ids internos de las fuentes no cambian');

/* ---------- (b) enlace oficial en las dos fuentes manuales ---------- */
for (const id of ['69-csd', '69-reduccion']) {
  const source = LIST_CATALOG.find(item => item.id === id);
  assert.ok(source, 'b: existe la fuente ' + id);
  assert.equal(source.url, null, 'b: ' + id + ' sigue manual (sin archivo oficial descargable)');
  assert.equal(source.enlaceSat, ENLACE_SAT,
    'b: ' + id + ' declara su enlace oficial del SAT en el catálogo');
  assert.match(source.estadoManual, /sin fuente automática/,
    'b: ' + id + ' conserva su declaración honesta de manualidad (m-8)');
}
for (const source of LIST_CATALOG.filter(item => item.url))
  assert.equal(source.enlaceSat, undefined,
    'b: las fuentes automáticas no llevan enlace manual (' + source.id + ')');
assert.ok(listsUi.includes('source.enlaceSat'),
  'b: la tarjeta de la fuente pinta el enlace que declara el catálogo');
assert.ok(listsUi.includes("n('a', 'Buscar en el SAT ↗')"),
  'b: el enlace se pinta como «Buscar en el SAT ↗» junto a la carga manual');

/* ---------- (c) y (d): el veredicto se calcula de la respuesta ---------- */
/* Las funciones puras del veredicto (entre las marcas
   VEREDICTO240 de lists-ui.part) más listsResumen201, del que
   dependen, ejercitadas con formateadores de juguete. */
const bloqueResumen = listsUi.slice(listsUi.indexOf('function listsResumen201'),
  listsUi.indexOf('async function listsComprobarAhora201'));
const bloqueVeredicto = listsUi.slice(listsUi.indexOf('/*VEREDICTO240-INICIO*/'),
  listsUi.indexOf('/*VEREDICTO240-FIN*/'));
assert.ok(bloqueResumen.includes('function listsResumen201'), 'c: se extrae listsResumen201');
assert.ok(bloqueVeredicto.includes('function listsVeredicto240'), 'c: se extrae el veredicto');
const fabrica = new Function('money', 'localDateTime', 'localDate',
  bloqueResumen + '\n' + bloqueVeredicto +
  '\nreturn { listsVeredicto240, listsVeredictoTexto240, listsClase240 };');
const { listsVeredicto240, listsVeredictoTexto240, listsClase240 } = fabrica(
  value => '$FMT(' + value + ')',
  value => 'FECHA(' + value + ')',
  value => 'DIA(' + value + ')');

assert.equal(listsClase240({ listId: '69b' }), 'negras', 'c: 69-B es lista negra');
assert.equal(listsClase240({ listId: '69b-bis' }), 'negras', 'c: 69-B Bis es lista negra');
assert.equal(listsClase240({ listId: '69-firmes' }), 'creditos', 'c: firmes es crédito fiscal');
assert.equal(listsClase240({ listId: '69-exigibles' }), 'creditos', 'c: exigibles es crédito fiscal');
assert.equal(listsClase240({ listId: '69-no-localizados' }), 'supuestos', 'c: no localizados es supuesto');

const T = Date.parse('2026-11-16T18:23:00Z');
const fuentes = [
  { id: '69b', label: 'Art. 69-B · Operaciones inexistentes', fetched: T, count: 1000 },
  { id: '69-firmes', label: 'Art. 69 · Créditos firmes', fetched: T, count: 500 }];
const conGolpe = {
  sources: fuentes, events: [],
  counterparts: [
    { rfc: 'SPS2203295V2', name: 'STOLOOF SA DE CV', kind: 'Proveedor', severity: 'bad',
      hits: [{ listId: '69b', label: 'Art. 69-B · Operaciones inexistentes', detail: 'Definitivo', severity: 'bad' }],
      exposure: { receivedCount: 6, received: '358156.22', issuedCount: 0 },
      detalle: { recibidos: { count: 6, total: '358156.22', primera: '2023-02-01', ultima: '2023-09-14' },
        emitidos: null, saldoPorCobrar: null } },
    { rfc: 'ITS000330380', name: 'OTRA SA', kind: 'Cliente', severity: 'bad',
      hits: [{ listId: '69-firmes', label: 'Art. 69 · Créditos firmes', detail: 'Firmes · publicado el 01/01/2024', severity: 'bad' }],
      exposure: null, detalle: null }] };
const vGolpe = listsVeredicto240(conGolpe);
assert.equal(vGolpe.estado, 'con-golpe', 'c: hay golpe vigente');
assert.equal(vGolpe.golpe.cp.rfc, 'SPS2203295V2', 'c: el golpe protagonista es STOLOOF');
assert.equal(vGolpe.grupos.negras.length, 1, 'c: un golpe en las negras');
assert.equal(vGolpe.grupos.creditos.length, 1, 'c: el firme va a créditos fiscales, no a las negras');
const textoGolpe = listsVeredictoTexto240(conGolpe);
for (const esperado of ['SPS2203295V2', 'Definitivo', '6 CFDI', '$FMT(358156.22)', '2023', 'FECHA(' + T + ')'])
  assert.ok(textoGolpe.includes(esperado), 'c: el veredicto pinta «' + esperado + '» — ' + textoGolpe);

/* Solo créditos fiscales: no es lista negra y se dice. */
const soloCreditos = { sources: fuentes, events: [], counterparts: [conGolpe.counterparts[1]] };
const vCreditos = listsVeredicto240(soloCreditos);
assert.equal(vCreditos.estado, 'con-avisos', 'c: sin golpe negro, el estado es «con avisos»');
assert.equal(vCreditos.golpe, null, 'c: un crédito fiscal nunca es el golpe protagonista');
assert.match(listsVeredictoTexto240(soloCreditos), /créditos fiscales.*no es una lista negra/,
  'c: los créditos fiscales se presentan como lo que son');

/* (d) Sin golpes: limpio, con su fecha. */
const limpio = {
  sources: fuentes, events: [],
  counterparts: [{ rfc: 'AAA010101AAA', name: 'EMPRESA PROPIA SA', kind: 'Propio',
    source: 'perfil', severity: 'none', hits: [], exposure: null, detalle: null }] };
const vLimpio = listsVeredicto240(limpio);
assert.equal(vLimpio.estado, 'limpio', 'd: sin golpes, el veredicto es limpio');
const textoLimpio = listsVeredictoTexto240(limpio);
assert.ok(textoLimpio.includes('Limpio'), 'd: el veredicto dice limpio');
assert.ok(textoLimpio.includes('FECHA(' + T + ')'),
  'd: el veredicto pinta la fecha real de la última comprobación');
assert.ok(textoLimpio.includes('Sin cambios detectados'),
  'd: sin eventos, la frescura dice que no hay cambios detectados');

/* Sin ninguna descarga: todavía no se ha comprobado. */
const sinComprobar = { sources: fuentes.map(s => ({ ...s, fetched: null, count: 0 })),
  counterparts: [], events: [] };
assert.equal(listsVeredicto240(sinComprobar).estado, 'sin-comprobar',
  'd: sin descargas no se afirma limpieza: «sin comprobar»');

console.log('ronda240listas.test: ok');
