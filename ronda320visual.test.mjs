import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/* ================================================================
   Ronda 3.2.0 · visual — las anclas de la ronda en el artefacto
   construido y en sus partes: el esqueleto de la página lleva
   la barra de progreso, la banda de la puerta, la barra de
   deshacer, el botón de la paleta y la cabecera de impresión;
   la piel trae el tema oscuro completo, los esqueletos, los
   vacíos diseñados, la letra grande y las formas por máscara;
   y cada parte diferida trae su pieza (la paleta y el papel en
   visual320, los pisos en Salud, el mapa en Administración, la
   cuenta atrás y el calendario en el Buzón Tributario, la
   línea de vida en el Registro, el mapa de calor en Cobertura).
   Lo que se comporta se prueba en ronda320cliente y
   ronda320servidor; esto vigila que nada se caiga del barco.
   ================================================================ */
const ROOT = import.meta.dirname;
const read = name => readFileSync(join(ROOT, name), 'utf8');
const html = read('Faro-Fiscal.html');
const lazy = JSON.parse(read('lazy.json'));
const css = read('style.part') + read('design.part') + read('polish.part');
const parte = nombre => (lazy.partes[nombre]?.source || '');

/* ===== El esqueleto de la página (layout) ===== */
assert.ok(html.includes('<script data-320-tema>'), 'el script temprano de tema/letra va en la cabecera');
for (const id of ['barra320', 'banda-puerta320', 'deshacer320', 'cmdk-btn320', 'cabecera-impresion320'])
  assert.ok(html.includes('id="' + id + '"'), 'el esqueleto lleva #' + id);
console.log('OK 3.2.0 · esqueleto: barra, banda, deshacer, paleta e impresión.');

/* ===== La piel (CSS) ===== */
for (const ancla of ['[data-theme="dark"]', '.skel320', '.vacio320', 'html[data-letra="grande"]',
    '.calor320', '.fases320', '.vida320', '.papel320', '.accion-fija320', '.barra320',
    '.medallon320', '.frescura320', '.tabla-fija320'])
  assert.ok(css.includes(ancla), 'la piel trae ' + ancla);
assert.ok(css.includes('.pill320[data-nivel="ok"]') && css.includes('--i240'),
  'la pastilla de cuenta atrás lleva su forma por máscara, no por glifo');
console.log('OK 3.2.0 · piel: tema oscuro, esqueletos, vacíos, letra grande y formas.');

/* ===== La parte visual (visual320) ===== */
const visual = parte('visual320');
assert.ok(visual.length > 10000, 'la parte visual pesa lo suyo (no es un talón)');
for (const ancla of ['__pacosatCmdk320', "buscar200h?q='", 'papel320', 'vida320',
    'fasesPintar', 'logoPintar', 'tendencia', 'docsDecorar', 'facturasDecorar'])
  assert.ok(visual.includes(ancla), 'la parte visual trae ' + ancla);
console.log('OK 3.2.0 · parte visual: paleta, papel, línea de vida, fases y logotipo.');

/* ===== Las pantallas diferidas ===== */
assert.ok(parte('salud').includes('salud-piso-card320'), 'Salud abre con sus tarjetas piso');
assert.ok(parte('salud').includes('Última comprobación'), 'Salud dice en grande cuándo se comprobó');
assert.ok(parte('admin').includes('adminMapa320'), 'Administración trae su mapa de medallones');
assert.ok(parte('buzon').includes('Se tuvo por notificada hace'),
  'el Buzón Tributario dibuja la cuenta atrás del plazo sin abrir el aviso');
assert.ok(parte('buzon').includes('tribCalendario320'), 'y su calendario de vencimientos');
assert.ok(parte('registro').includes('vida-dia320'), 'el Registro agrupa por días en su línea de vida');
console.log('OK 3.2.0 · diferidas: Salud, Administración, Buzón y Registro.');

/* ===== Las fuentes principales ===== */
assert.ok(read('coverage-ui.part').includes('calor320'), 'Cobertura pinta su mapa de calor');
assert.ok(read('ui.part').includes('frescura320Crear'), 'la frescura se crea desde el tronco');
assert.ok(read('ui.part').includes('esqueleto320'), 'los esqueletos de carga viven en el tronco');
assert.ok(read('ui.part').includes('Acuse de cancelación'),
  'la clase «Acuse de cancelación» se nombra en Documentos');
assert.ok(read('final-ui.part').includes('NOVEDADES_320'), 'las novedades son las de la 3.2.0');
assert.ok(read('package.json').includes('"version": "3.2.0"'), 'el paquete está sellado 3.2.0');
console.log('OK 3.2.0 · fuentes: calor, frescura, esqueletos, acuse y sellos.');
