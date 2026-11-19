/* Suite de la ronda 2.4.0 · W5a — cimientos gráficos (piezas
   2, 9, 3 y 4 del capítulo gráfico). Fija sobre el ARTEFACTO
   construido y las fuentes de W5a (polish.part):
   (9) el set base de iconos vive en el sprite por id, con el
       trazo único de la casa (1.65, fijado en el CSS global) y
       ningún símbolo define su propio stroke-width; los seis
       símbolos nuevos (calendario, compartir, envío, listas y
       chevrones) quedan DECLARADOS en polish.part para que la
       integración los inserte en el sprite de layout.part
       (territorio fuera de W5a; markup exacto en la nota W5a).
   (2) el estado se pinta icono + palabra + color: data-estado
       con sus seis valores y su máscara, el puente heredado
       data-state de statusPill/.fiscal-badge y el punto viejo
       sustituido por el icono.
   (3) el destello .cifra-nueva solo corre sin reduced-motion
       y la regla global de reduced-motion del artefacto apaga
       animaciones y transiciones.
   (4) las formas de esqueleto existen y reutilizan skel-pulse. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const read = name => readFileSync(join(ROOT, name), 'utf8');
const html = read('Faro-Fiscal.html');
const css = html.match(/<style>([\s\S]*?)<\/style>/)[1];
const polish = read('polish.part');

/* ---------- (9) set base en el sprite, por id ---------- */
const SET_BASE = [
  ['i-logo', 'faro / marca'], ['i-down', 'descarga'], ['i-up', 'subida / envío'],
  ['i-mail', 'correo'], ['i-search', 'buscar'], ['i-file', 'documento'],
  ['i-bank', 'dinero / banco'], ['i-chart', 'gráfica / dinero'],
  ['i-shield', 'salud / listas'], ['i-check', 'check / al día'],
  ['i-alert', 'alerta'], ['i-clock', 'reloj / espera'], ['i-folder', 'carpeta'],
  ['i-gear', 'ajuste'], ['i-close', 'cerrar'], ['i-arrow', 'flecha / chevrón lateral'],
  ['i-home', 'inicio'], ['i-sync', 'en curso'], ['i-bell', 'avisos'],
  ['i-print', 'imprimir / reportes'], ['i-pdf', 'PDF'], ['i-inbox', 'recibidos'],
  ['i-eye', 'ver'], ['i-help', 'ayuda / sin datos'], ['i-lock', 'candado'],
  ['i-plus', 'añadir'], ['i-sun', 'tema claro'], ['i-moon', 'tema oscuro'],
  ['i-volume', 'sonido'], ['i-mute', 'silencio'], ['i-dots', 'más'],
  ['i-box', 'archivo'], ['i-code', 'XML'],
  ['i-constancia', 'constancia'], ['i-opinion', 'opinión'],
  ['i-buzontrib', 'buzón tributario'], ['i-decl', 'declaraciones'],
  /* Integración del coordinador (W5a): los símbolos que vivían
     solo como markup en la nota ya están en el sprite de
     layout.part. Cierre de integración 2.4.0: la pareja de
     chevrones (i-chevd/i-chevu) se retiró del set — ninguna
     pantalla los referenciaba y la regla de ronda1110 (ningún
     símbolo muerto en el sprite) manda; volverán con su primer
     uso real si un control de desplegar los necesita. */
  ['i-calendar', 'calendario'], ['i-share', 'compartir'], ['i-send', 'enviar'],
  ['i-list', 'lista'],
];
for (const [id, uso] of SET_BASE)
  assert.ok(html.includes('<symbol id="' + id + '" viewBox="0 0 24 24">'),
    '9: el sprite del artefacto contiene ' + id + ' (' + uso + ') con viewBox 24');

/* Trazo uniforme: la regla global fija 1.65 y ningún símbolo
   del sprite declara el suyo (hereda el de la regla global). */
assert.ok(/svg\{[^}]*stroke-width:1\.65/.test(css),
  '9: el CSS global del artefacto fija el trazo único 1.65');
for (const simbolo of html.match(/<symbol[\s\S]*?<\/symbol>/g) || [])
  assert.ok(!simbolo.includes('stroke-width'),
    '9: ningún símbolo define su propio stroke-width: ' + simbolo.slice(0, 60));
/* Las máscaras de estado de W5a usan ESE mismo trazo: todo
   stroke-width que aparece en sus SVG en línea es 1.65. */
const mascaras = polish.match(/data:image\/svg\+xml,[^"]+/g) || [];
assert.ok(mascaras.length >= 6, '9/2: hay al menos seis máscaras SVG propias (una por estado)');
for (const mascara of mascaras) {
  const trazos = mascara.match(/stroke-width='[^']+'/g) || [];
  assert.ok(trazos.length >= 1 && trazos.every(t => t === "stroke-width='1.65'"),
    '9: trazo uniforme 1.65 en cada máscara de estado');
  assert.ok(mascara.includes("viewBox='0 0 24 24'"), '9: viewBox 24 en cada máscara');
}
/* Cuatro símbolos nuevos declarados para la integración en el
   sprite (layout.part, fuera del territorio de W5a). */
for (const id of ['i-calendar', 'i-share', 'i-send', 'i-list'])
  assert.ok(polish.includes(id),
    '9: símbolo nuevo declarado en polish.part para integración: ' + id);

/* ---------- (2) estado = icono + palabra + color ---------- */
for (const estado of ['aldia', 'encurso', 'esperando', 'atencion', 'error', 'sindatos']) {
  assert.ok(css.includes('[data-estado="' + estado + '"]'),
    '2: existe el estado data-estado="' + estado + '"');
  assert.ok(new RegExp('\\[data-estado="' + estado + '"\\][^{]*\\{--i240:url\\(').test(css),
    '2: data-estado="' + estado + '" define su icono (--i240)');
}
assert.ok(css.includes('mask:var(--i240) center/contain no-repeat'),
  '2: el ::before pinta el icono con la máscara de la familia');
assert.ok(css.includes('[data-estado]::before'),
  '2: el icono se antepone vía ::before (la palabra del HTML no se toca)');
/* Puente heredado: el data-state que ya pintan statusPill y
   .fiscal-badge recibe el mismo icono sin cambiar su HTML. */
for (const puente of ['.status-pill[data-state="ok"]', '.status-pill[data-state="work"]',
  '.status-pill[data-state="warn"]', '.status-pill[data-state="bad"]',
  '.status-pill[data-state="dim"]', '.fiscal-badge[data-state="Vigente"]',
  '.fiscal-badge[data-state="Cancelado"]', '.fiscal-badge[data-state="Error"]'])
  assert.ok(css.includes(puente), '2: puente heredado presente: ' + puente);
assert.ok(css.includes('.status-pill .pill-dot{display:none}'),
  '2: el punto viejo de la píldora lo sustituye el icono (no se duplica la señal)');
/* Color por estado cuando solo se aporta data-estado. */
for (const regla of ['.estado240[data-estado="aldia"]{background:var(--ok-bg);color:var(--ok-ink)}',
  '.estado240[data-estado="atencion"]{background:var(--warn-bg);color:var(--warn-ink)}',
  '.estado240[data-estado="error"]{background:var(--danger-bg);color:var(--danger)}'])
  assert.ok(css.includes(regla), '2: color del estado presente: ' + regla.slice(0, 34));
assert.ok(css.includes('.estado240{display:inline-flex'),
  '2: la clase suelta .estado240 viste cualquier chip con el mismo lenguaje');
/* Migración en territorio W5a: el dueño del aviso ya no es un
   glifo de texto, es una forma dibujada con currentColor. */
assert.ok(!polish.includes('content:"●"'), '2/9: fuera el glifo ● de .aviso-dueno');
assert.ok(polish.includes('.aviso-dueno::before{content:"";width:8px;height:8px;border-radius:50%;background:currentColor'),
  '2/9: .aviso-dueno pinta su señal como forma, no como carácter');

/* ---------- (3) destello y reduced-motion ---------- */
assert.ok(css.includes('.cifra-nueva{border-radius:6px}'), '3: la clase de destello existe');
assert.ok(css.includes('@media (prefers-reduced-motion:no-preference){.cifra-nueva{animation:cifra240 .9s ease-out}}'),
  '3: el destello SOLO corre cuando no hay reduced-motion');
assert.ok(css.includes('@keyframes cifra240{from{background:var(--tint)}to{background:transparent}}'),
  '3: el destello es un fondo que se apaga solo');
assert.ok(css.includes('@media (prefers-reduced-motion:reduce)') &&
  css.includes('animation:none!important') && css.includes('transition:none!important'),
  '3: con reduced-motion el artefacto apaga animaciones y transiciones');
assert.ok(css.includes('.view-in{animation:view-in .22s ease}'),
  '3: la transición de vista de la casa (.view-in, 220 ms) sigue viva');

/* ---------- (4) esqueletos con la forma de cada pantalla ---------- */
assert.ok(css.includes('.esqueleto{display:grid;gap:12px}'), '4: el contenedor .esqueleto existe');
assert.ok(css.includes('animation:skel-pulse 1.2s ease-in-out infinite'),
  '4: el esqueleto reutiliza el pulso sobrio de la casa (skel-pulse)');
for (const forma of ['.esqueleto .sk-hero{--skh:118px', '.esqueleto .sk-fila{--skh:54px',
  '.esqueleto .sk-card{--skh:108px', '.esqueleto .sk-graf{--skh:176px',
  '.esqueleto .sk-corta{width:55%}', '.esqueleto.sk-grid{grid-template-columns:repeat(auto-fit,minmax(160px,1fr))}'])
  assert.ok(css.includes(forma), '4: forma de esqueleto presente: ' + forma);

console.log('OK 2.4.0·W5a gráficos — sprite base por id y trazo 1.65 uniforme, estado icono+palabra+color (data-estado + puente data-state), destello .cifra-nueva solo sin reduced-motion y esqueletos por forma.');
