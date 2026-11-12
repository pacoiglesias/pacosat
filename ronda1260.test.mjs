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
assert.ok(html.includes('"version":"1.29.0"'), 'el artefacto se sella con la versión vigente (1.29.0)');
const htmlBytes = statSync(join(ROOT, 'Faro-Fiscal.html')).size;
/* Techo 598.000 desde la 1.29.0 (ejecutor local, papelera,
   peldaños 1 y 2 y Totales navegable): la página crece a
   594.876 B, con la contabilidad en el anexo de ronda1110. */
assert.ok(htmlBytes <= 598000, 'la página pesa ' + htmlBytes + ' B (tope 598.000, re-basificado en la 1.29.0)');
const cssBytes = ['style.part', 'design.part', 'polish.part']
  .reduce((sum, name) => sum + statSync(join(ROOT, name)).size, 0);
assert.ok(cssBytes <= 42500, 'el CSS pesa ' + cssBytes + ' B (tope 42.500, anexo 1.29.0 en ronda1110)');

/* Tokens cerrados */
for (const token of ['--r-s:8px', '--r-m:12px', '--r-l:14px', '--r-pill:100px',
  '--sp-1:4px', '--sp-5:24px', '--shadow-1:', '--shadow-2:', '--fs-xs:11px',
  '--accent-ink:var(--ok-ink)', '--nav-active-bg:', '--nav-active-ink:'])
  assert.ok(style.includes(token), 'token de :root presente: ' + token);
assert.ok(style.includes('.sidebar nav button[aria-current]{background:var(--nav-active-bg);color:var(--nav-active-ink)}'),
  'la barra lateral activa usa sus tokens, no hex sueltos');
assert.ok(design.includes('border-radius:var(--r-l)'), 'paneles y diálogos ruedan sobre --r-l');

/* Marca ≠ semáforo */
assert.equal([...polish.matchAll(/--accent-ink:#[0-9a-f]{6}/g)].length, 14,
  'los 14 bloques de acento (7 × claro/oscuro) definen --accent-ink');
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
assert.ok(layout.includes('data-view="buzon"><svg><use href="#i-inbox"'), 'Buzón navega con su bandeja');
assert.ok(layout.includes('data-view="tributario"><svg><use href="#i-mail"'), 'Buzón Tributario navega con su sobre');
assert.ok(layout.includes('data-view="docs"><svg><use href="#i-folder"'), 'Documentos conserva la carpeta');
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
assert.ok(layout.includes('Entrar con mi acceso de siempre'), 'la entrada trae su escape de siempre');
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
assert.ok(polish.includes('button.decl-cell{font:inherit;color:inherit;text-align:left;cursor:pointer;border:1px solid var(--line);width:100%;min-height:48px}'),
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
