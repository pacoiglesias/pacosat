/* Suite visual de la ronda 2.3.2 · B4 (cliente: pulido, móvil y
   cabecera): fija sobre el ARTEFACTO construido y las fuentes de
   B4 las reglas de esta ronda — cabecera sin desborde con razón
   social larga (M-10/H6), táctiles small de 44 px en móvil
   (M-12, completo en el mini-cierre: soft, status-pill-botón
   y filter-chip también a 44 px), espejos laterales fuera en escritorio (m-12), Listas
   sin duplicado y con el error en llano (m-6/m-7), Descargados
   precargado (m-13), Buzón sin botón-desplazamiento (m-17),
   frase de la huella en Salud (m-22), fecha del Registro en
   minúsculas (m-25) y Preguntas vestida (m-26). La medición en
   vivo (desborde real a 1280/390) vive en las capturas de la
   ronda; aquí se fija la estructura que la produce. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const read = name => readFileSync(join(ROOT, name), 'utf8');
const html = read('Faro-Fiscal.html');
const css = html.match(/<style>([\s\S]*?)<\/style>/)[1];
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const lazy = JSON.parse(read('lazy.json'));
const ui = read('ui.part');
const settingsUi = read('settings-ui.part');
const listsUi = read('lists-ui.part');
const coverageUi = read('coverage-ui.part');
const tributarioUi = read('tributario-ui.part');

/* 1 · M-10/H6-1: la cabecera puede encoger de verdad — el lado
   derecho y cada tramo flexible llevan min-width:0, el selector
   cede (flex que encoge) y su nombre va con elipsis; las
   herramientas y el distintivo no ceden. */
assert.ok(css.includes('.top-side{flex:1 1 auto;min-width:0;justify-content:flex-end'),
  'M-10: .top-side flexible, encogible y pegado a la derecha');
assert.ok(css.includes('.scope-menu-btn200b{flex:0 1 auto;min-width:0'),
  'M-10: el selector de contribuyente puede encoger');
assert.ok(css.includes('.scope-nombre200b{flex:1 1 auto;min-width:0'),
  'M-10: el nombre del selector es el tramo que cede');
assert.ok(css.includes('.scope-rfc200b{flex:none;white-space:nowrap'),
  'M-10: el RFC del selector no se parte ni cede');
assert.ok(css.includes('.top-search{flex:0 1 230px;min-width:0'),
  'M-10: el buscador de cabecera cede tras el selector');
assert.ok(css.includes('.top-search input{min-width:0;width:100%'),
  'M-10: el campo de búsqueda no impone su ancho mínimo viejo');
assert.ok(css.includes('.top-tools{flex:none}') && css.includes('.top-side .badge{flex:none}'),
  'M-10: herramientas y distintivo «Servidor privado» quedan en pantalla');

/* 2 · pintarBotonScope200b: nombre y RFC en tramos propios y el
   nombre COMPLETO en el title; en móvil el botón enseña solo
   medallón + RFC (el nombre se oculta solo dentro del botón,
   no en las filas del menú). */
const pintar = ui.slice(ui.indexOf('function pintarBotonScope200b()'),
  ui.indexOf('function pintarScopeMenu200b'));
assert.ok(pintar.includes("n('span', persona.name, 'scope-nombre200b')"),
  'M-10: el nombre va en su propio tramo');
assert.ok(pintar.includes("n('span', scope, 'scope-rfc200b')"),
  'M-10: el RFC va en su propio tramo');
assert.ok(pintar.includes("btn.title = 'Contribuyente: ' + (persona?.name || scope || '—')"),
  'M-10: el title del selector lleva el nombre completo');
assert.ok(css.includes('.scope-menu-btn200b .scope-nombre200b,.scope-menu-btn200b .scope-sep200b{display:none}'),
  'M-10: en móvil el selector enseña solo medallón + RFC');

/* 3 · H6-2/H6-3: la línea de Actividad envuelve y la miga
   superior no se parte. */
assert.ok(css.includes('.activity-item{min-width:0}'), 'H6-2: la fila de Actividad puede encoger');
assert.ok(css.includes('.activity-body{overflow-wrap:anywhere}'), 'H6-2: el cuerpo de Actividad envuelve');
assert.ok(css.includes('.top>span:first-child{flex:none;white-space:nowrap'),
  'H6-3: el primer tramo de la cabecera va en una línea y no cede');

/* 4 · M-12: todo botón small es objetivo de 44 px en móvil. */
const movil = css.slice(css.indexOf('/* ===== 2.3.2 · B4'));
assert.ok(/@media\(max-width:860px\)\{[^}]*button\.small\{min-height:44px\}/.test(css) ||
  movil.includes('button.small{min-height:44px}'),
  'M-12: button.small sube a 44 px en ≤860 px');

/* 4b · M-12 completo (mini-cierre táctil): la vara de la casa es
   TODO objetivo táctil ≥44 px en móvil — la medición viva de B5
   dejó 31/44 botones de Salud bajo 44 (18 «soft» a 42 px y 13
   «status-pill»-botón a 33 px). En el MISMO bloque ≤860 px que
   la regla de B4 viven también button.soft (cubre «soft» y
   «soft small») y button.status-pill (solo cuando la píldora
   ES un botón; la variante span no es objetivo táctil y no se
   toca), y el chip de filtros del bloque de pestañas sube de
   40 a 44 px. Se fija sobre el artefacto construido. */
assert.ok(/@media\(max-width:860px\)\{\s*button\.small\{min-height:44px\}\s*button\.soft\{min-height:44px\}\s*button\.status-pill\{min-height:44px\}/.test(css),
  'M-12 completo: button.soft y button.status-pill suben a 44 px en ≤860 px, en el bloque de button.small');
assert.ok(css.includes('button.soft{min-height:44px}'),
  'M-12 completo: button.soft a 44 px en el artefacto (cubre soft y soft small)');
assert.ok(css.includes('button.status-pill{min-height:44px}'),
  'M-12 completo: button.status-pill a 44 px en el artefacto');
assert.ok(!css.includes('span.status-pill{min-height:44px}'),
  'M-12 completo: la píldora como span no se toca (no es objetivo táctil)');
assert.ok(css.includes('@media(max-width:860px){.tabs button,.tabbar button{min-height:44px}.filter-chip{min-height:44px}}'),
  'M-12 completo: .filter-chip sube a 44 px en ≤860 px');
assert.ok(!css.includes('.filter-chip{min-height:40px}'),
  'M-12 completo: ya no queda .filter-chip a 40 px en el artefacto');

/* 5 · m-12: en escritorio no hay espejos laterales del selector
   ni del buscador; el superior es el único. */
assert.ok(css.includes('@media(min-width:861px)'), 'm-12: existe la banda de escritorio');
assert.ok(css.includes('#side-search{display:none}'), 'm-12: el buscador lateral se oculta en escritorio');
assert.ok(css.includes('.switcher label[for="scope"],#scope{display:none}'),
  'm-12: el selector lateral se oculta en escritorio');

/* 6 · m-6/m-7 Listas: un solo «Actualizar listados» (el de la
   cabecera, en ui/workflows) y el error de la fuente traducido
   a llano antes de pintar — nunca el texto crudo. */
assert.ok(!listsUi.includes("n('button', 'Actualizar listados'"),
  'm-6: el panel de Listas ya no crea el botón duplicado');
assert.ok(listsUi.includes('function listsErrorLlano232'), 'm-7: existe el traductor a llano');
assert.ok(listsUi.includes('listsErrorLlano232(source.error)'), 'm-7: la tarjeta pinta la traducción');
assert.ok(!listsUi.includes("'Último intento: ' + source.error") &&
  !listsUi.includes("falló (' + source.error"),
  'm-7: el error crudo ya no se pinta en la tarjeta');

/* 7 · m-13 Descargados: sin configuración guardada, el
   formulario de la descarga automática precarga día 1 y 06:00
   (la hora 0 guardada se respeta: no es un vacío). */
assert.ok(coverageUi.includes('Number(men.config.day) || 1'), 'm-13: el día precarga 1');
assert.ok(coverageUi.includes("men.config.hour === ''") && coverageUi.includes('? 6 : Number(men.config.hour)'),
  'm-13: la hora precarga 06:00 solo si viene vacía');

/* 8 · m-17 Buzón: fuera el botón que solo desplazaba a la
   parrilla de la misma pantalla; la cola se queda como texto. */
assert.ok(!tributarioUi.includes("n('button', 'Ver en su tarjeta'"), 'm-17: el botón-desplazamiento se retiró');
assert.ok(tributarioUi.includes('Cola de trabajos: '), 'm-17: el conteo de la cola sigue como texto');

/* 9 · m-22 Salud: la huella de motores se dice en frase, desde
   el dato huellaOk que ya viajaba en la tarjeta. */
assert.ok(lazy.partes.salud.source.includes('Huella de motores: '),
  'm-22: la frase de la huella está en la parte de Salud');
assert.ok(lazy.partes.salud.source.includes("tarjeta.datos.huellaOk === true ? 'coincide'"),
  'm-22: la frase sale del dato huellaOk (coincide / no coincide / no consta)');

/* 10 · m-25 Registro: la cabecera de día sin capitalización CSS
    y la fecha formateada ya en minúsculas. */
assert.ok(css.includes('.reg-dia{margin:16px 0 6px;font-size:13px;color:var(--muted)}'),
  'm-25: .reg-dia ya no capitaliza la fecha');
assert.ok(lazy.partes.registro.source.includes("toLocaleLowerCase('es-MX')"),
  'm-25: la fecha del Registro se formatea en minúsculas');

/* 11 · m-26 Preguntas: ejemplos tocables que rellenan el campo
    y estado vacío de respuesta diseñado. */
for (const ejemplo of ['¿Cuánto me deben?', '¿Cuánto debo?', '¿Cuánto IVA tengo en octubre?', '¿Qué vence esta semana?'])
  assert.ok(script.includes(ejemplo), 'm-26: ejemplo tocable presente: ' + ejemplo);
assert.ok(script.includes('preg-ejemplos232'), 'm-26: la fila de ejemplos existe');
assert.ok(script.includes('question.value = texto'), 'm-26: el ejemplo rellena el campo');
assert.ok(script.includes('Tu respuesta aparecerá aquí'), 'm-26: estado vacío de respuesta diseñado');

/* 12 · D-5 (auditoría final §8): el placeholder del campo de
   Paperless es un ejemplo neutro — la IP de la red de Paco
   (192.168.68.126) no viaja en ningún texto visible del
   producto. Se fija en la fuente y en el artefacto. */
assert.ok(settingsUi.includes("placeholder: 'http://tu-paperless:8000'"),
  'D-5: la fuente lleva el placeholder neutro de Paperless');
assert.ok(!settingsUi.includes('192.168.68.126'),
  'D-5: la fuente ya no contiene la IP de la red de Paco');
assert.ok(html.includes("placeholder: 'http://tu-paperless:8000'"),
  'D-5: el artefacto construido contiene el placeholder neutro');
assert.ok(!html.includes('192.168.68.126'),
  'D-5: el artefacto construido NO contiene la IP de la red de Paco');

console.log('OK 2.3.2·B4 visual — cabecera sin desborde, small de 44 px, espejos, Listas, Descargados, Buzón, huella, Registro y Preguntas fijados.');
