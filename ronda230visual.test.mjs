/* Suite de la ronda visual 2.3.0 (pieza nº 9): fija sobre el
   ARTEFACTO construido (Faro-Fiscal.html) la escala tipográfica
   tokenizada, el estado vacío diseñado, la regla del menú que
   cerraba la excepción cosmética de la 2.0.2, las tarjetas del
   SAT vestidas, el oscuro de las tarjetas y la paridad de
   selectores. Sin registrar: la registra el padre. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const read = name => readFileSync(join(ROOT, name), 'utf8');
const html = read('Faro-Fiscal.html');
const css = html.match(/<style>([\s\S]*?)<\/style>/)[1];
const polish = read('polish.part');
const declUi = read('declaraciones-ui.part');

/* 1 · Escala tipográfica: los peldaños nuevos existen como
   token y los titulares de pantalla cuelgan de la escala. */
for (const token of ['--fs-m:13px', '--fs-l:14px', '--fs-xl:16px',
  '--fs-2xl:18px', '--fs-4xl:24px', '--fs-5xl:30px'])
  assert.ok(css.includes(token), 'token de escala presente: ' + token);
assert.ok(css.includes('h1{font-size:var(--fs-5xl)'), 'h1 cuelga de la escala');
assert.ok(css.includes('h2{font-size:var(--fs-2xl)'), 'h2 cuelga de la escala');
assert.ok(css.includes('h3{font-size:var(--fs-xl)'), 'h3 cuelga de la escala');
assert.ok(css.includes('font-size: var(--fs-4xl)'), 'la cifra-enlace de Hoy cuelga de la escala');
assert.ok(!css.includes('font-size: 1.55rem'), 'fuera el rem suelto de la cifra de Hoy');
assert.ok(css.includes('.puerta-line{display:flex;align-items:center;gap:7px;margin-top:9px;font-size:var(--fs-s)'),
  'la línea de la puerta deja el medio píxel (11.5) por el peldaño 12');
assert.ok(!polish.includes('12.5px') && !polish.includes('13.5px'), 'sin medios píxeles nuevos');

/* 2 · El menú: el estado va en su propio renglón, en una línea,
   y desaparece con la barra plegada (excepción de la 2.0.2). */
assert.ok(css.includes('.sidebar nav button{flex-wrap:wrap}'), 'el botón del menú envuelve');
assert.ok(css.includes('.nav-estado201{flex:1 0 100%;margin-left:26px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis'),
  'el estado ocupa su renglón, en una sola línea con elipsis');
assert.ok(css.includes('body.barra-plegada .nav-estado201{display:none}'),
  'en la barra plegada el estado se oculta con los demás textos');

/* 3 · Estados vacíos diseñados: la clase del patrón tiene su
   forma (rejilla centrada, título, texto con ancho legible) y
   su variante de párrafo suelto; los estados de Declaraciones
   que salían a ras de panel usan el patrón. */
assert.ok(css.includes('.empty{padding:36px 20px;text-align:center;display:grid;gap:6px;justify-items:center'),
  'el estado vacío tiene su forma diseñada');
assert.ok(css.includes('.empty h3{font-size:var(--fs-xl);font-weight:700'), 'el título del vacío manda');
assert.ok(css.includes('p.empty{display:block;font-size:var(--fs-l);color:var(--muted)'),
  'el párrafo suelto con clase empty también es estado diseñado');
assert.equal((declUi.match(/'No se pudieron leer las declaraciones de este RFC\.', 'empty'\)/g) || []).length, 2,
  'las dos salidas sin lectura de Declaraciones usan el estado diseñado');
assert.ok(declUi.includes("n('p', error.message, 'empty error-text')"),
  'el error de la pantalla de Declaraciones usa el estado diseñado');

/* 4 · Tarjetas del SAT y paneles nuevos de la 2.3.0 vestidos. */
assert.ok(css.includes('.sat-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(290px,1fr))'),
  'la rejilla de tarjetas del SAT existe');
assert.ok(css.includes('.sat-card{border:var(--bd);border-radius:var(--r-l);background:var(--surface-2);box-shadow:var(--card-sh)'),
  'la tarjeta del SAT habla el idioma de tarjeta de la casa');
assert.ok(css.includes('.sat-card-head{display:flex;gap:8px;align-items:center;flex-wrap:wrap'),
  'la cabecera de tarjeta del SAT existe');
assert.ok(css.includes('.cambios230>h3,.foto-rfc230>h3{padding:16px 16px 6px'),
  'los paneles nuevos de Hoy titulan con aire de panel');
assert.ok(css.includes('.foto-rfc-fila230{display:flex;gap:12px'), 'la fila de empresa de Hoy es fila de verdad');
assert.ok(css.includes('#declaraciones-section .decl-grid,#declaraciones-section .decl-detalle'),
  'el mapa de Declaraciones respira a 16 px como el resto');
assert.ok(css.includes('.plan-yapedida230{color:var(--warn-ink);font-weight:650'),
  'el aviso de ventana ya pedida se lee como aviso');

/* 5 · Oscuro pulido: la sombra de tarjeta es token con
   light-dark() (en oscuro, sombra negra real y filo de luz
   tenue) y la sombra de lujo la consume. */
assert.ok(css.includes('--card-sh:0 1px 2px light-dark(#1022190d,#0000006b)'),
  'la sombra de tarjeta lleva su valor oscuro');
assert.ok(css.includes('box-shadow:var(--card-sh)'), 'las tarjetas consumen la sombra tokenizada');
assert.ok(css.includes('.sidebar :focus-visible{outline-color:#8fe3c0}'),
  'el foco en la barra oscura se ve también con el tema claro');

/* 6 · Foco y tacto: objetivos dignos sin mover controles. */
assert.ok(css.includes('.icon-button{padding:6px;min-width:40px;min-height:40px'),
  'los botones de icono son de 40 px');
assert.ok(css.includes('@media(max-width:860px){.tabs button,.tabbar button{min-height:44px}.filter-chip{min-height:40px}}'),
  'en móvil, pestañas de 44 px y chips de 40 px');

/* 7 · Paridad: ningún selector de la casa desaparece. */
for (const sel of ['.panel{', '.metric{', '.kpi{', '.tramite-card{', '.cmd-card{',
  '.aviso-card{', '.problem-card{', '.toast-card{', '.entry-card{', '.bottombar{',
  '.decl-grid{', '.decl-cell{', '.age-fill.cobrar{', '.sat-run{', '.skel-block{',
  '.status-pill{', '.fiscal-badge{', '.cp-row{', '.today-col{', '.scope-menu200b{',
  '.salud-grid200d{', '.nav-jobs{', '.job-bar{', '.card-menu{', '.api-key-card{'])
  assert.ok(css.includes(sel), 'paridad: sigue existiendo ' + sel);

console.log('OK 2.3.0·V visual — escala, menú, vacíos, tarjetas SAT, oscuro, tacto y paridad fijados en el artefacto.');
