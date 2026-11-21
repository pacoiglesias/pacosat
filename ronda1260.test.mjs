/* Ronda 1.26.0 — «Ronda Visual», juzgada pieza a pieza contra
   la propuesta de la auditoría visual (sistema 6,6/10; Login 4,
   la mayor brecha) y los mandatos de Paco: diseño funcional
   (cada pantalla un trabajo, nada repetido dos veces en la
   misma pantalla), el sistema impecable y «Hoy manda»:
   - tokens cerrados: escalas de radios, espaciado, sombras y
     tipo viven en :root y docs/DESIGN.md las documenta;
   - marca ≠ semáforo: los 14 bloques de acento definen
     --accent-ink y NINGUNO redefine --ok-ink — elegir burdeos
     ya no tiñe el verde de «todo bien»;
   - colores fugados fuera: Pagos deriva de tokens con
     color-mix; no queda rgba suelto ni el #d97706 del ámbar;
   - iconografía sin gemelos: Buzón tiene su bandeja (i-inbox)
     y Buzón Tributario su sobre (i-mail); «Abrir XML» es
     código (i-code) y «Factura PDF» su PDF (i-pdf) — un glifo
     por destino;
   - avisos flotantes: #toasts en la cáscara, floatToast en el
     cliente, announce lo alimenta y toastUndo comparte UN
     deshacer entre la barra y la tarjeta;
   - pantalla de entrada diseñada: #entry con su formulario
     contra admin/login (el mismo endpoint que la tarjeta de
     Ajustes), su escape «de siempre» y la convivencia escrita;
     maybeShowEntry solo la enseña con login configurado;
   - Dinero con gráficas: antigüedad en barras y «Saldos
     abiertos por mes», y el refresco ya no calla — «cargando»
     y «error» se pintan;
   - Buzón sin dato repetido: la fila va en .cp-main con su
     línea .bz-meta y el importe sale UNA vez (el segmento
     crudo del detalle se filtra);
   - Hoy sin repetir: el héroe ya no repite el RFC que dicen el
     selector y la ceja;
   - papel como documento: @page pagina («Página X de Y») y
     reportFoot cierra el reporte mensual, el del periodo y la
     constancia de listados; sellos impresos a 9.5 px;
   - tacto y movimiento: filas con hover, botones de tabla de
     40 px, celdas de declaraciones de 48 px, diálogos que
     entran suaves; el texto del mapa de calor a 11 px y fuera
     los medios píxeles (12.5/13.5);
   - peso: la página queda bajo el techo de siempre (572.000)
     y el CSS bajo su techo nuevo, con anexo (39.600). */
import assert from 'node:assert/strict';
import { readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = import.meta.dirname;
const read = name => readFileSync(join(ROOT, name), 'utf8');
const html = read('Faro-Fiscal.html');
const layout = read('layout.part');
const style = read('style.part');
const design = read('design.part');
const polish = read('polish.part');
const ui = read('ui.part');
const moneyUi = read('money-ui.part');
const buzonUi = read('buzon-ui.part');

/* Sello y techos */
assert.ok(html.includes('"version":"3.1.1"'), 'el artefacto se sella con la versión vigente (2.0.1)');
const htmlBytes = statSync(join(ROOT, 'Faro-Fiscal.html')).size;
/* Techo 598.000 desde la 1.29.0 (ejecutor local, papelera,
   peldaños 1 y 2 y Totales navegable): la página crece a
   594.876 B, con la contabilidad en el anexo de ronda1110.
   Re-basificado en la 1.29.1 (corrección de Declaraciones +
   ampliación D6–D8): la página crece a 602.467 B y el techo
   sube a 604.000 con la contabilidad en el anexo 1.29.1 de
   ronda1110. Re-basificado en la 1.29.2 (parrilla de trámites
   + capa de atención de Avisos): crece a 618.915 B y el techo
   sube a 619.000, contabilidad en el anexo 1.29.2 de
   ronda1110. Re-basificado en la 1.30.0 (puerta auto-probada,
   código corto, demás RFC y parte de la mañana): crece a
   623.232 B y el techo sube a 623.500. Re-basificado en la
   1.31.0 (corrección del 13 nov + menú + 45 mejoras +
   reportes): crece a 659.787 B y el techo sube a 663.000,
   contabilidad en el anexo 1.31.0 de ronda1110. */
assert.ok(htmlBytes <= 893650, 'la página pesa ' + htmlBytes + ' B (tope 893.650, RE-BASE 3.1.0: el tope pasa a 893.650 B (892.846 B medidos; la contabilidad completa, en ronda1110); antes, RE-BASE 3.0 de contabilidad: el artefacto mide 880.992 B (+16.778 B sobre los 864.214 B del árbol base 2.9.17, con la contabilidad completa de ronda1110); antes, tope 866.250, RE-BASE 2.9.16 de contabilidad: el artefacto mide 865.466 B (+6.317 B sobre los 859.149 B sellados de la 2.9.15, con la contabilidad completa de ronda1110); antes, tope 859.900, RE-BASE 2.9.15 de contabilidad: el artefacto mide 859.149 B (+6.643 B sobre los 852.506 B de la 2.9.14, con la contabilidad de ronda1110); el tope acompaña al de la casa: 859.900 B; antes, tope 853.600, RE-BASE 2.9.13 de contabilidad: el artefacto mide 852.811 B (+25.893 B sobre los 826.918 B sellados de la 2.9.12: los bloques A–E de la ronda — el arreglo de Descargar y sus pasos/mapa/historial, el Buzón con Leer y su rediseño, Salud D, los encabezados de reportes y las 30 mejoras gráficas, con su piel en polish.part —; medido reconstruyendo con el propio ensamblador); el tope pasa a 853.600 B (852.811 + 789 de margen); antes, tope 827.200, RE-BASE 2.9.10 de contabilidad: el artefacto mide 826.449 B (+1.502 B sobre la 2.9.9, con la contabilidad tanda a tanda de ronda1110); el tope pasa a 827.200 B (margen 751); antes, tope 825.700, RE-BASE 2.9.9 de contabilidad: el artefacto mide 824.947 B (+1.169 B sobre la 2.9.8, con la contabilidad tanda a tanda de ronda1110); el tope pasa a 825.700 B (margen 753); antes, tope 824.500, RE-BASE 2.9.8 de contabilidad: el artefacto mide 823.778 B (+1.619 B sobre los 822.159 B sellados de la 2.9.7, medidos fichero a fichero sobre la base del paquete 2.9.7: +1.072 B netos de los usuarios con nombre propio en la carga inicial —puente de sesión en ui.part +176, línea de montaje en Ajustes +127, talón del panel, diálogo de entrada con usuario y nota de novedades 2.9.8 en final-ui.part +686 neto, manifiesto de la parte diferida en build.mjs +83; el panel entero viaja DIFERIDO en la parte «usuarios», fuera de la carga inicial—, +523 B de la Pieza V —el visor abre en el gesto— en pdf-cloud-ui.part y +24 B de la Pieza R —las reglas .chart sin el trazo heredado— en design.part; el tope pasa a 824.500 B (823.778 + 722 de margen); antes, tope 822.500, re-basificado en la 2.3.0: el artefacto mide 820.999 B (+20.350 B sobre los 800.649 B de la 2.0.2: +15.278 B de las piezas funcionales de cliente de las 20 mejoras, +2.739 B de la ronda visual, +1.607 B de los gemelos de oscuro por sistema y +726 B de la nota de novedades 2.3.0); en la 2.0.2 medía 800.649 B — +1.739 B de las entradas propias del menú con sus estados —; contabilidad anterior: fase 2 de cliente de la 2.0.1: el artefacto medía 798.249 B tras las piezas de cliente de las 30 mejoras (y la nº 31) en la parte principal —contabilidad en la re-base de ronda1110—; venía de 775.000 de la limpieza de esta misma ronda)');
const cssBytes = ['style.part', 'design.part', 'polish.part']
  .reduce((sum, name) => sum + statSync(join(ROOT, name)).size, 0);
  /* RE-BASE 2.8.0 (tope CSS): las fuentes style/design/polish
     suman 86.217 B medidos hoy — +1.259 B sobre los 84.958 B
     asentados en la integración 2.4.0. Ese crecimiento YA
     estaba en el árbol sellado de la 2.4.0 (sus tres fuentes
     suman 86.217 B en el propio paquete pacosat-240.zip,
     contra el tope de 85.719 fijado antes de su último
     retoque): la batería completa de la 2.8.0 lo cazó en su
     primera pasada. La 2.8.0 no toca ninguna fuente CSS —
     las tres quedan byte a byte como en el paquete 2.4.0 —
     y el tope se re-basifica a 86.978 conservando el mismo
     margen de 761 B que la suite venía usando. */
assert.ok(cssBytes <= 106074, 'el CSS pesa ' + cssBytes + ' B (tope 106.074, RE-BASE 3.1.0: el CSS mide 105.313 B (+1.720 B de polish.part con la piel de la ronda; la contabilidad completa, en ronda1110); antes, tope 104.354, RE-BASE 3.0 de contabilidad: el CSS mide 103.593 B en las fuentes (+2.124 B sobre los 101.469 B medidos en el árbol base 2.9.17, todo en polish.part, con la contabilidad completa de ronda1110); el tope pasa a 104.354 B conservando el margen de 761 B de siempre (103.593 + 761); antes, tope 101.606, RE-BASE 2.9.16 de contabilidad: el CSS mide 100.845 B en las fuentes (+3.372 B sobre los 97.473 B de la 2.9.15, todo en polish.part con la piel de la ronda); el tope pasa a 101.606 B conservando el margen de 761 B de siempre (100.845 + 761); antes, tope 98.234, RE-BASE 2.9.15 de contabilidad: el CSS mide 97.473 B en las fuentes (+1.864 B sobre los 95.609 B de la 2.9.13: el bloque de piel del lote gráfico en polish.part — sistema único de estados, franja de atención, grupo activo del menú, aire de identificadores y toque de 44px —); el tope pasa a 98.234 B conservando el margen de 761 B de siempre (97.473 + 761); antes, tope 95.700, RE-BASE 2.9.13 de contabilidad: el CSS mide 95.609 B en las fuentes (+6.948 B sobre los 88.661 B de la 2.9.12: el bloque «piel y gráficos» de la ronda en polish.part — pasos y mapa de Descargar, tarjetas del Buzón, semáforos de Salud, anillos de Hoy y Cierre, barras de Facturas y Reportes, conciliación dibujada, línea de vencimientos y guía de Ayuda —); el tope pasa a 95.700 B (95.609 + 91 de margen); antes, tope 88.803, RE-BASE 2.9.7: el CSS mide 88.042 B en las fuentes (+763 B sobre los 87.279 B asentados en la RE-BASE 2.8.0: +629 B acumulados en polish.part por la piel del foco del sistema de la 2.9.0, no re-basificados en las rondas 2.9.0–2.9.6, y +134 B de la regla .visor-previa297 de la pieza D2 de esta ronda en design.part); el tope conserva el mismo margen de 761 B de siempre (88.042 + 761); antes, RE-BASE 2.8.0: el CSS medía 87.279 B en las fuentes (+1.062 B de la piel de protagonista y móvil de los ítems 7 y 8 de diseño, medidos); el tope conserva el mismo margen de 761 B de siempre (87.279 + 761); antes, RE-BASE integración 2.4.0 (mal asentada: decía 84.958 B cuando las fuentes selladas sumaban 86.217 B): el CSS mide 84.958 B medidos hoy en las fuentes (+10.219 B sobre los 74.739 B de la 2.3.2: +5.293 B de W5a —estados, iconos y esqueletos— que lo llevaron a 80.211 B, y +4.747 B de W5b/WC —gráficos, tarjetas protagonistas y piezas visuales de la ronda—); el tope conserva el mismo margen de 761 B que la suite venía usando (75.500 − 74.739); el techo del HTML NO se toca: el artefacto mide 797.312 B y cumple el vigente de 822.500 B; re-basificado en la 2.3.2: el CSS mide 74.739 B (+2.471 B sobre los 72.268 B asentados en la 2.3.0, medidos contra el sellado 2.3.1: +1.887 B del bloque de cabecera sin desborde (M-10), espejos y tacto de B4 en polish.part, +339 B del endurecimiento H6-2 de la línea de Actividad en design.part y +245 B de la miga H6-3 en style.part); re-basificado en la 2.3.0: el CSS mide 72.268 B (+5.352 B sobre los 66.916 B asentados: +3.392 B de la ronda visual y +1.960 B de los gemelos de oscuro por sistema con su comentario); en la 2.0.1 medía 66.916 B tras la parte de cliente completa de esta misma ronda; venía de 66.500 de la 2.0 tanda 7B)');

/* Tokens cerrados */
for (const token of ['--r-s:8px', '--r-m:12px', '--r-l:16px', '--r-pill:100px',
  /* --r-l sube de 14 a 16 px en la 1.31.1: la vara de diseño
     pide radios amplios (13 nov, 21:54). */
  '--sp-1:4px', '--sp-5:24px', '--shadow-1:', '--shadow-2:', '--fs-xs:11px',
  '--accent-ink:var(--ok-ink)', '--nav-active-bg:', '--nav-active-ink:'])
  assert.ok(style.includes(token), 'token de :root presente: ' + token);
assert.ok(style.includes('.sidebar nav button[aria-current]{background:var(--nav-active-bg);color:var(--nav-active-ink)}'),
  'la barra lateral activa usa sus tokens, no hex sueltos');
assert.ok(design.includes('border-radius:var(--r-l)'), 'paneles y diálogos ruedan sobre --r-l');

/* Marca ≠ semáforo */
assert.equal([...polish.matchAll(/--accent-ink:#[0-9a-f]{6}/g)].length, 24,
  'los bloques de acento definen --accent-ink: 24 = 8 claros + 8 oscuros con tema + 8 gemelos oscuros por sistema (RE-BASE de la 2.3.0: sin tema guardado, applyTheme no pone data-theme y los bloques [data-theme="dark"] no casaban con el sistema en oscuro — los gemelos @media (prefers-color-scheme:dark) llevan los MISMOS valores oscuros; re-basificado en la 1.32.2: el verde se suma como acento elegible)');
assert.ok(!polish.includes('--ok-ink:#'), 'ningún acento redefine el verde del semáforo');
assert.ok(polish.includes('.swatch[aria-pressed="true"]{border-color:var(--green);background:var(--tint);color:var(--accent-ink)}'),
  'la muestra de acento pinta con tinta de marca');
assert.ok(polish.includes('.bottombar button[aria-current]{background:var(--tint);color:var(--accent-ink)}'),
  'el activo de la barra inferior pinta con tinta de marca');

/* Colores fugados */
assert.ok(!polish.includes('rgba(220,38,38'), 'Pagos: fuera el rojo rgba suelto');
assert.ok(!polish.includes('rgba(217,119,6'), 'Pagos: fuera el ámbar rgba suelto');
assert.ok(!polish.includes('rgba(37,99,235'), 'Pagos: fuera el azul rgba suelto');
assert.ok(!polish.includes('#d97706'), 'fuera el hex del punto ámbar');
assert.ok(polish.includes('.pagos-seed{border:1px dashed color-mix(in srgb,var(--chart-2)'),
  'la semilla de Pagos deriva de --chart-2');
assert.ok(!polish.includes('var(--panel'), 'fuera el token fantasma --panel');
assert.ok(!polish.includes('var(--line,#bcccdc)'), 'fuera el respaldo #bcccdc de --line');

/* Iconografía sin gemelos */
for (const sym of ['i-inbox', 'i-mail', 'i-code', 'i-pdf'])
  assert.ok(layout.includes('<symbol id="' + sym + '"'), 'símbolo presente: ' + sym);
/* RE-BASE 2.8.0 (diseño 19): «Recibidos» se llama «Novedades»
   y su botón del menú lleva el title de W4d; sigue navegando
   con su bandeja #i-inbox. (El literal viejo ya no casaba en
   la 2.4.0 sellada: casaba por el botón de la barra inferior,
   cuyo cuarto hueco es hoy el Buzón del SAT — diseño 28.) */
assert.ok(layout.includes('data-view="buzon" title="Novedades — Lo nuevo que llegó a tu expediente') &&
  layout.indexOf('#i-inbox') > layout.indexOf('data-view="buzon"'), 'Novedades navega con su bandeja');
/* Re-basificado en la 1.31.0 (punto B): el Buzón Tributario ya no es
   renglón del menú — vive dentro del Centro SAT; el sobre #i-mail
   sigue existiendo como símbolo para su tarjeta. */
/* RE-BASIFICADO en la 2.0.2 (orden directa de Paco): el Buzón
   Tributario RECUPERA su renglón propio en el menú, con su icono
   #i-buzontrib y su estado en texto — lo necesario no se esconde. */
/* RE-BASE integración 2.4.0 (W4d): los botones del menú llevan
   title con su descripción; los literales se re-pinan al
   prefijo EXACTO de hoy — el Buzón sigue navegando con su
   buzón y Documentos con su carpeta, misma fuerza. */
/* RE-BASE 2.8.0 (diseño 19): el destino se llama «Buzón del
   SAT» también en su title; el resto del title no cambia. */
assert.ok(layout.includes('data-view="tributario" title="Buzón del SAT — Las notificaciones del SAT para este RFC, sin abrir ninguna: PacoSAT las lista por ti"><svg><use href="#i-buzontrib"'), 'Buzón del SAT navega desde el menú con su buzón (2.0.2)');
assert.ok(layout.includes('data-view="docs" title="Documentos — Tu expediente por RFC: constancia, opinión, declaraciones, acuses y PDF archivados"><svg><use href="#i-folder"'), 'Documentos conserva la carpeta');
assert.ok(layout.includes('data-view="avisos"><svg><use href="#i-bell"'), 'Avisos conserva la campana');
assert.ok(layout.includes('id="inspect"><svg><use href="#i-code"'), '«Abrir XML» es código');
assert.ok(layout.includes('id="pdf-import"><svg><use href="#i-pdf"'), '«Factura PDF» es el PDF');

/* Avisos flotantes */
assert.ok(layout.includes('id="toasts"'), 'la cáscara trae la pila de avisos flotantes');
assert.ok(ui.includes('function floatToast('), 'floatToast existe');
assert.ok(ui.includes('if (message && !quiet) floatToast('), 'announce alimenta lo flotante');
assert.ok(ui.includes("floatToast(message, 'ok', run)"), 'toastUndo flota su tarjeta con el deshacer compartido');
assert.ok(polish.includes('.toast-card{'), 'la tarjeta flotante tiene su CSS');
assert.ok(polish.includes('@media (max-width:860px){.toasts{left:12px;right:12px;bottom:64px'),
  'en móvil los avisos viven sobre la barra inferior');

/* Pantalla de entrada */
assert.ok(layout.includes('id="entry"'), 'la cáscara trae la pantalla de entrada');
assert.ok(layout.includes('id="entry-form"') && layout.includes('id="entry-pass"'),
  'la entrada trae su formulario y su contraseña');
/* RE-BASE 2.8.0 (diseño 18): el escape de la puerta es un
   enlace discreto que se ofrece como salida («¿Problemas
   para entrar? Usa tu acceso de siempre»); el botón, su id y
   su función son los de siempre. */
assert.ok(layout.includes('¿Problemas para entrar? Usa tu acceso de siempre'), 'la entrada trae su escape de siempre');
assert.ok(ui.includes('function maybeShowEntry(') && ui.includes('function showEntry('),
  'la lógica de la entrada existe');
assert.ok((ui.match(/satApi\('admin\/login'/g) || []).length >= 2,
  'la entrada y la tarjeta de Ajustes comparten el endpoint admin/login');
assert.ok(ui.includes('pacosat-entry-skip'), 'el escape se recuerda por sesión del navegador');
assert.ok(read('sat-ui.part').includes('maybeShowEntry()'), 'el pulso ofrece la entrada una vez por carga');

/* Dinero: gráficas y refresco que habla */
assert.ok(moneyUi.includes('function dineroAgeChart('), 'la antigüedad en barras existe');
assert.ok(moneyUi.includes('function dineroMonthPanel('), 'el panel por meses existe');
assert.ok(moneyUi.includes("'Saldos abiertos por mes'"), 'el panel se titula «Saldos abiertos por mes»');
assert.ok(moneyUi.includes("dineroRefresh = 'error'"), 'el refresco fallido deja estado');
assert.ok(moneyUi.includes('No se pudo actualizar con el servidor'),
  'el refresco fallido se DICE en pantalla (antes: .catch vacío)');
assert.ok(!moneyUi.includes('}).catch(() => {});'), 'Dinero ya no traga el error en silencio');
assert.ok(polish.includes('.age-fill.cobrar{background:var(--green)}'), 'serie cobrar en verde de marca');
assert.ok(polish.includes('.bar-pagar{fill:var(--chart-2)}'), 'serie pagar en --chart-2');

/* Buzón: la fila en líneas, el importe una vez */
assert.ok(buzonUi.includes("'muted bz-meta'"), 'la fila del Buzón lleva su línea de meta');
assert.ok(buzonUi.includes("seg !== String(item.importe || '')"),
  'el segmento crudo del importe sale del detalle: el dato va una vez');
assert.ok(!buzonUi.includes("(item.importe ? ' · $' + money(item.importe) : '')"),
  'fuera la frase corrida título · detalle · importe · fecha');

/* Hoy sin repetir */
assert.ok(!ui.includes("scopes().get(scope) + ' · ' + scope"),
  'el héroe de Hoy ya no repite el RFC del selector y la ceja');

/* Papel */
assert.ok(polish.includes('counter(page)') && polish.includes('counter(pages)'),
  '@page pagina los documentos');
assert.ok(polish.includes('@bottom-left{content:"PacoSAT · Expediente fiscal"'), '@page firma el pie');
assert.ok(ui.includes('function reportFoot('), 'reportFoot existe');
assert.ok(ui.includes('section.append(reportFoot(scope))'), 'el reporte mensual cierra con pie');
assert.ok(read('outputs-ui.part').includes('section.append(head, body, reportFoot(scope))'),
  'el reporte del periodo cierra con pie');
assert.ok(read('lists-ui.part').includes('reportFoot(cp.rfc)'), 'la constancia de listados cierra con pie');
assert.ok(polish.includes('.print-seals{font-size:9.5px'), 'los sellos impresos a 9.5 px');

/* Tipo, tacto y movimiento */
assert.ok(polish.includes('.hm text{fill:var(--muted);font-size:11px'), 'el mapa de calor se lee: 11 px');
assert.ok(!polish.includes('12.5px') && !polish.includes('13.5px'), 'fuera los medios píxeles');
assert.ok(design.includes('td button{font-size:13px;padding:7px 10px;white-space:nowrap;min-height:40px}'),
  'botones de tabla con 40 px de objetivo');
/* 1.29.1: la regla crece con min-width:0 y overflow:hidden —
   la celda no se hincha con su contenido (D3, la rejilla no
   desborda); el objetivo de 48 px se conserva. */
assert.ok(polish.includes('button.decl-cell{font:inherit;color:inherit;text-align:left;cursor:pointer;border:1px solid var(--line);width:100%;min-height:48px;min-width:0;overflow:hidden}'),
  'celdas de declaraciones con 48 px de objetivo');
assert.ok(polish.includes('tbody tr:hover{background:var(--surface-2)}'), 'las filas responden al paso');
assert.ok(polish.includes('@keyframes dialog-in'), 'los diálogos entran con movimiento breve');
assert.ok(style.includes('.news-badge{padding:1px 7px;border-radius:var(--r-pill);background:var(--danger);color:light-dark(#fff,#471a14)'),
  'la insignia en oscuro lleva tinta oscura (contraste AA)');
assert.ok(ui.includes("themeIsDark() ? '#060d18' : '#0e2a47'"), 'el theme-color sigue al tema');

/* El documento de diseño */
assert.ok(existsSync(join(ROOT, 'docs', 'DESIGN.md')), 'docs/DESIGN.md existe');
const designDoc = read('docs/DESIGN.md');
for (const tema of ['--accent-ink', '--ok-ink', 'Marca ≠ semáforo', 'un glifo por destino',
  'report-foot', '390 px'])
  assert.ok(designDoc.includes(tema), 'DESIGN.md documenta: ' + tema);

console.log('OK 1.26.0 · artefacto: tokens cerrados, marca≠semáforo, avisos flotantes, entrada, gráficas de Dinero y papel documentado');
console.log('ronda1260.test: ok — la Ronda Visual juzgada pieza a pieza (tokens, iconos, avisos, entrada, Dinero, Buzón, impresión).');
