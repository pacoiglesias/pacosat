/* ===== Ronda 2.8.0 · diseño completo (las 30 de la auditoría) =====
   Fija las decisiones de composición de la ronda: una sola
   composición de actividad con el estado al frente y la barra
   solo con conteo real; Hoy sin duplicados; una sola casa de
   descargas; la bitácora se exporta solo desde Registro; el
   menú y la barra inferior con sus destinos de hoy; y los
   nombres únicos («Novedades», «Buzón del SAT», «Descargar
   del SAT»). Las pruebas de pantalla completa viven en las
   suites de cada ronda; aquí se fija la ARQUITECTURA. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const ROOT = import.meta.dirname;
const read = name => readFileSync(join(ROOT, name), 'utf8');
const html = read('Faro-Fiscal.html');
const layout = read('layout.part');
const ui = read('ui.part');

/* ---------- (1) Actividad: estado al frente, una vez ---------- */
{
  const ini = html.indexOf('function actividadGuia240');
  const fin = html.indexOf('function hoyVivoTexto240', ini);
  assert.ok(ini >= 0 && fin > ini, 'las funciones de la línea de actividad viven en el artefacto');
  const ctx = vm.createContext({ console });
  const fns = vm.runInContext(html.slice(ini, fin) + '\n;({ actividadLinea240, actividadProgreso240 });', ctx);
  const linea = fns.actividadLinea240({ phase: 'Esperando al SAT', detail: 'Esperando al SAT · desde hace 7 min', state: 'esperando', since: 0 });
  assert.ok(linea.startsWith('Esperando al SAT'), 'la línea abre con el estado: ' + linea);
  assert.equal(linea.split('Esperando al SAT').length - 1, 1, 'el estado se dice UNA vez: ' + linea);
  assert.ok(linea.includes('desde hace 7 min'), 'el «desde hace» del detalle se conserva: ' + linea);
  /* La barra solo existe con conteo real (done/total). */
  const ctx2 = vm.createContext({ console, jobProgress1312: x => x });
  const prog = vm.runInContext(html.slice(html.indexOf('function actividadProgreso240'), html.indexOf('function hoyVivoTexto240')) + '\n;actividadProgreso240;', ctx2);
  assert.equal(prog({ phase: 'Bajando', state: 'trabajando' }, 'Bajando'), null, 'sin conteo real no hay barra (era la tercera repetición del estado)');
  const conConteo = prog({ phase: 'Bajando', state: 'trabajando', done: 3, total: 9 }, 'Bajando');
  assert.ok(conConteo && conConteo.done === 3 && conConteo.total === 9 && conConteo.fase === '', 'con conteo real la barra vive y no repite la fase');
  console.log('OK 2.8.0 diseño · (1) actividad: estado al frente una vez; barra solo con conteo real.');
}

/* ---------- (2) Menú, barra inferior y nombres (11, 19, 28) ---------- */
{
  assert.ok(!layout.includes('data-view="coverage"'), '«Descargados del SAT» sale del menú: su casa es Descargar del SAT (diseño 3)');
  assert.ok(!layout.includes('id="nav-jobs"'), 'la fila de trabajos en curso sale del menú (diseño 11)');
  assert.ok(!layout.includes('id="side-search"'), 'el espejo lateral del buscador sale del menú (diseño 11)');
  assert.ok(!layout.includes('id="sound-toggle"'), 'el altavoz sale de la cabecera: vive en Ajustes › General (diseño 27)');
  const bottom = layout.slice(layout.indexOf('bottombar'), layout.indexOf('bottombar') + 1400);
  /* RE-BASE 3.0 (mejora 21): la barra inferior es Al día ·
     Hoy · Descargar · Avisos · Más; el Buzón del SAT
     conserva su sitio en el menú lateral y en «Más». */
  for (const view of ['home', 'avisos', 'descargar'])
    assert.ok(bottom.includes('data-view="' + view + '"'), 'barra inferior 3.0: ' + view);
  assert.ok(bottom.includes('id="aldia30-bar"'), 'barra inferior 3.0: botón «Al día»');
  assert.ok(!bottom.includes('data-view="dinero"'), 'Dinero no ocupa la barra inferior: vive en «Más» (diseño 28)');
  assert.ok(layout.includes('> Novedades <'), 'el buzón de comprobantes se llama «Novedades» (diseño 19)');
  assert.ok(layout.includes('> Buzón del SAT <'), 'el Buzón Tributario se llama «Buzón del SAT» (diseño 19)');
  assert.ok(!ui.includes("'Descargar CFDI del SAT'") && !ui.includes('"Descargar CFDI del SAT"'),
    'un solo nombre para descargar: «Descargar del SAT» (diseño 19)');
  console.log('OK 2.8.0 diseño · (2) menú y barra de hoy; nombres únicos.');
}

/* ---------- (3) Hoy sin duplicados (13, 14, 15) ---------- */
{
  assert.ok(ui.includes('function cierreResumen280()'), 'Hoy cierra el mes con una línea-resumen (diseño 15)');
  assert.equal(ui.split('atajosTarjeta240()').length - 1, 1, 'atajosTarjeta240 queda definida pero ya no se monta en Hoy (diseño 14)');
  assert.equal(ui.split('versionPanel240()').length - 1, 1, 'versionPanel240 queda definido pero ya no se monta en Hoy (diseño 13)');
  assert.ok(read('final-ui.part').includes('const NOVEDADES_1311'), 'las novedades viven en su mecanismo (Acerca de), no pintadas en Hoy (diseño 13)');
  console.log('OK 2.8.0 diseño · (3) Hoy: sin atajos ni versión pintados; cierre en una línea.');
}

/* ---------- (4) Casas únicas: descargas, bitácora, reportes, ayuda (3, 10, 5, 26) ---------- */
{
  const coverage = read('coverage-ui.part');
  assert.ok(coverage.includes('function coberturaPaneles280('), 'los paneles de «qué tienes» se componen una vez (diseño 3)');
  const sat = read('sat-ui.part');
  assert.ok(sat.includes('coberturaPaneles280(true)'), 'Descargar del SAT monta los paneles de cobertura en casa (diseño 3)');
  assert.ok(!html.includes('Exportar bitácora (CSV)'), 'ningún botón exporta la bitácora fuera de Registro (diseño 10)');
  const lazy280 = JSON.parse(read('lazy.json'));
  assert.ok((lazy280.partes.salud?.source || '').includes('La bitácora completa y su exportación están en Registro'),
    'Salud dice dónde vive la exportación (diseño 10)');
  assert.ok(ui.includes("cierreSection === 'reportes'") && ui.includes("navigate('reportes')") || html.includes('Ir a Reportes'),
    'Cierre enlaza a la única pantalla de Reportes (diseño 5)');
  assert.ok(ui.includes('let ayudaContexto280') && ui.includes("navigate('preguntas')"),
    'el «?» abre Preguntas con el contexto de la pantalla (diseño 26)');
  const finalUi = read('final-ui.part');
  assert.ok(finalUi.includes("panel('Atajos de teclado'"), 'los atajos son una sección de Preguntas (diseño 26)');
  console.log('OK 2.8.0 diseño · (4) casas únicas: descargas, bitácora, reportes, ayuda.');
}

/* ---------- (5) Protagonistas y piel (7, 24, 25, 9) ---------- */
{
  assert.ok(html.includes('.protagonista280{'), 'la piel de protagonista existe en el CSS (diseño 7)');
  assert.ok(ui.includes('function contribProtagonista280()'), 'Contribuyentes abre con su protagonista y su gesto (diseño 24)');
  const finalUi = read('final-ui.part');
  assert.ok(finalUi.includes("dataset.protagonista280 = 'archivo'"), 'Archivo abre con su protagonista (diseño 25)');
  assert.ok(finalUi.includes("'Recuperar el más antiguo'"), 'el gesto propio de Archivo es recuperar (diseño 25)');
  const money = read('money-ui.part');
  assert.ok(money.includes("dataset.protagonista280 = 'dinero'"), 'Dinero abre con «El dinero, de un vistazo» (diseño 9)');
  assert.ok(money.includes("'Previsión y el mes'") && money.includes("'Por contraparte'"), 'Dinero agrupa el resto en pliegues por tema (diseño 9)');
  const banks = read('banks-ui.part');
  assert.ok(banks.includes('reconcilePanel('), 'la conciliación vive en Bancos (diseño 9)');
  console.log('OK 2.8.0 diseño · (5) protagonistas con piel común y gestos propios.');
}

/* ---------- (6) Ajustes en dos grupos y sonidos (29, 27) ---------- */
{
  assert.ok(ui.includes("'Del día a día'") && ui.includes('ajustes-grupo280'), 'Ajustes se abre en dos grupos con rótulo (diseño 29)');
  const settings = read('settings-ui.part');
  assert.ok(settings.includes("master280.id = 'sound-toggle'"), 'el interruptor general de sonidos vive en Ajustes › General (diseño 27)');
  console.log('OK 2.8.0 diseño · (6) Ajustes: dos grupos; sonidos en General.');
}

console.log('OK ronda 2.8.0 · diseño completo: arquitectura fijada.');
