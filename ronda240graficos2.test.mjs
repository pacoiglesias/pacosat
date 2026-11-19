/* Suite de la ronda 2.4.0 · W5b1 — gráficas aplicadas I
   (piezas 5, 8, 7 y 21). Fija sobre las FUENTES de W5b1, el
   ARTEFACTO construido y un PDF de juguete real:
   (5) el anillo de Cobertura pinta 12 segmentos con el estado
       que sale de los datos (la función de estado de la fuente,
       evaluada sobre un grupo de juguete: meses con celda,
       huecos cerrados y el mes en curso) y el hueco se
       distingue del al día en clase, color y palabra;
   (8) la plantilla común buildPdf (salidas-doc) abre con la
       portada del faro, pinta el bloque visual de totales y
       cierra con pie de RFC + fecha de generación, en Carta;
       la impresión de pantalla de outputs-ui usa la misma
       plantilla (.report-totales + membrete con logo y RFC);
   (7) la clase de frescura existe con sus tres estados, su
       contrato queda escrito en polish.part y el pintado de
       outputs-ui compone barra + «hace X» (nunca solo color);
   (21) la lista de restos oscuros corregidos en el territorio
       queda fijada por aserción sobre los selectores tocados,
       y el bloque W5b1 no introduce ningún color fijo claro. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPdf } from './salidas-doc.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const read = name => readFileSync(join(ROOT, name), 'utf8');
const html = read('Faro-Fiscal.html');
const css = html.match(/<style>([\s\S]*?)<\/style>/)[1];
const lazy = JSON.parse(read('lazy.json'));
const salidasLazy = lazy.partes.salidas.source;
const polish = read('polish.part');
const coverage = read('coverage-ui.part');
const outputs = read('outputs-ui.part');
const salidasDoc = read('salidas-doc.mjs');

/* ---------- (5) anillo: la función de estado, sobre juguete ---------- */
/* La misma regla que pinta el anillo, extraída de la fuente y
   evaluada: nada de reimplementarla aquí con otra lógica. */
const estadoSrc = coverage.match(/function covEstado240[\s\S]*?\n\}/);
assert.ok(estadoSrc, '5: la fuente trae la función de estado del anillo');
const covEstado240 = new Function(estadoSrc[0] + '; return covEstado240;')();
const hoyKey = new Date().toISOString().slice(0, 7);
const anio = hoyKey.slice(0, 4);
const meses = Array.from({ length: 12 }, (_, i) => anio + '-' + String(i + 1).padStart(2, '0'));
/* Grupo de juguete: enero–marzo con CFDI; el resto del año, no. */
const celdas = new Map(meses.slice(0, 3).map(key => [key, { month: key, count: 4, descarga: 4 }]));
const estados = meses.map(key => covEstado240(key, celdas.get(key), hoyKey, meses[0]));
assert.equal(estados.length, 12, '5: el anillo pinta los 12 meses del año');
assert.deepEqual(estados.slice(0, 3), ['aldia', 'aldia', 'aldia'],
  '5: los meses con celda del dato salen «aldia»');
const idxHoy = Number(hoyKey.slice(5, 7)) - 1;
if (idxHoy >= 3) assert.equal(estados[idxHoy], 'encurso', '5: el mes en curso sin celda sale «encurso»');
for (let i = 3; i < idxHoy; i++)
  assert.equal(estados[i], 'hueco', '5: mes cerrado sin celda dentro del rango = «hueco» (' + meses[i] + ')');
for (let i = idxHoy + 1; i < 12; i++)
  assert.equal(estados[i], 'fuera', '5: mes futuro = «fuera» (el dato no dice nada de él)');
assert.notEqual(estados[0], estados[3] === 'hueco' ? estados[3] : estados[idxHoy],
  '5: el hueco se distingue del al día ya en el estado');
/* …y en el artefacto: segmento SVG por mes, clicable, con su
   color por estado y su leyenda icono+palabra. */
assert.ok(coverage.includes('coverageRing240(group, byMonth)'),
  '5: la vista pinta el anillo por grupo antes de la tabla (que se queda: paridad)');
assert.ok(coverage.includes("class: 'cov-seg', 'data-cov': estado, tabindex: '0', role: 'button'"),
  '5: cada segmento es un botón SVG con su estado en data-cov');
assert.ok(coverage.includes("seg.addEventListener('click', abrir)"),
  '5: el mes es clicable hasta su detalle');
assert.ok(coverage.includes('Ver los CFDI') && coverage.includes('Descargar este mes'),
  '5: el detalle del anillo ofrece las mismas acciones que la fila de la tabla');
for (const regla of ['.cov-ring .cov-seg[data-cov="aldia"]{fill:var(--green)}',
  '.cov-ring .cov-seg[data-cov="encurso"]{fill:var(--chart-2);opacity:.55}',
  '.cov-ring .cov-seg[data-cov="hueco"]{fill:var(--surface-2);stroke:var(--line)}'])
  assert.ok(css.includes(regla), '5: color del anillo presente: ' + regla.slice(0, 44));
assert.ok(css.includes('.chart-legend .sw-cov-aldia{background:var(--green)}'),
  '5: la leyenda lleva su muestra de color junto a la palabra');
assert.ok(coverage.includes("COV_ESTADO240 = { aldia: 'Al día · con datos', encurso: 'En curso', hueco: 'Hueco · sin datos'"),
  '5: la leyenda y el title nombran cada estado con palabras');

/* ---------- (8) impresión diseñada: PDF común + pantalla ---------- */
const pdf = buildPdf({ title: 'Reporte del periodo · ' + anio + '-10',
  subtitle: 'MFI6212158B4 · MANO FIL SA',
  generated: 'Generado el 17 de noviembre de 2026 · PacoSAT 2.3.2',
  sections: [{ heading: 'Resumen', table: { columns: [{ title: 'Concepto', width: 0.6 },
    { title: 'Importe', width: 0.4, align: 'right' }],
    rows: [['Emitidos', '$1,160.00']], totals: [['Total', '$1,160.00']] } }] });
const pdfText = pdf.toString('latin1');
assert.ok(pdfText.startsWith('%PDF-'), '8: sale un PDF de verdad');
assert.ok(pdfText.includes('/MediaBox [0 0 612 792]'), '8: tamaño Carta, como está fijado');
assert.ok(pdfText.includes('% PACOSAT-FARO portada con la marca del faro'),
  '8: la portada del faro viaja en el contenido generado');
assert.ok(pdfText.includes('(PacoSAT)'), '8: la portada nombra la casa junto al faro');
assert.ok(pdfText.includes('RFC: MFI6212158B4'),
  '8: el RFC del subtítulo llega a la portada y al pie');
assert.ok(pdfText.includes('% PACOSAT-TOTALES bloque visual de totales'),
  '8: los totales se pintan como bloque visual, no como una fila más');
assert.ok(pdfText.includes('PacoSAT · Faro Fiscal') && pdfText.includes('Generado el 17 de noviembre de 2026'),
  '8: el pie lleva la marca y la fecha de generación en cada hoja');
assert.ok(salidasDoc.includes('const FARO_AZUL'), '8: la plantilla vive en la función común buildPdf, no reporte a reporte');
/* El RFC explícito (doc.rfc) manda sobre el buscado. */
const pdfRfc = buildPdf({ title: 'Saldos al día', subtitle: 'Todos los perfiles',
  rfc: 'XAXX010101000', generated: 'Generado el 17 de noviembre de 2026',
  sections: [{ lines: ['Sin saldos.'] }] }).toString('latin1');
assert.ok(pdfRfc.includes('RFC: XAXX010101000'), '8: doc.rfc explícito llega a portada y pie');
/* Pantalla (outputs-ui): la misma plantilla en printPeriodReport. */
assert.ok(outputs.includes("n('div', undefined, 'report-totales')") &&
  outputs.includes("rtItem('Emitidos'") && outputs.includes("rtItem('IVA acreditable'"),
  '8: la impresión de pantalla pinta sus totales en el bloque .report-totales');
assert.ok(outputs.includes('appSettings.logoData') && outputs.includes("' · REPORTE DEL PERIODO', 'hero-kicker'"),
  '8: el membrete de la impresión lleva el logo del faro de la instalación y su kicker');
assert.ok(css.includes('.report-totales{display:flex') && css.includes('border-left:5px solid var(--green)'),
  '8: el bloque de totales tiene su banda diseñada en la hoja de estilos');
assert.ok(salidasLazy.includes('report-totales') && salidasLazy.includes('frescura240'),
  '8/7: la parte diferida servida lleva la impresión diseñada y la frescura');

/* ---------- (7) frescura: clase, tres estados y contrato ---------- */
for (const regla of ['.frescura240{display:inline-flex',
  '.frescura240[data-edad="fresco"] .frescura240-fill{width:100%;background:var(--ok-ink)}',
  '.frescura240[data-edad="viejo"] .frescura240-fill{width:55%;background:var(--warn-ink)}',
  '.frescura240[data-edad="caduco"] .frescura240-fill{width:25%;background:var(--danger)}'])
  assert.ok(css.includes(regla), '7: regla de frescura presente: ' + regla.slice(0, 46));
for (const contrato of ['fresco < 24 h', 'viejo de 24 h a 7 días', 'caduco > 7 días',
  'nunca se comunica la edad solo con el color', 'haceText(ts)'])
  assert.ok(polish.includes(contrato), '7: el contrato queda escrito en polish.part: ' + contrato);
assert.ok(outputs.includes('function frescura240(at)') && outputs.includes('function frescuraEdad240(at)'),
  '7: outputs-ui trae el pintado de la frescura');
assert.ok(outputs.includes("n('span', haceText(") && outputs.includes("'frescura240-texto'"),
  '7: el pintado compone barra + texto «hace X» al lado');
assert.ok(outputs.includes("el.append(frescura240(at))"),
  '7: la frescura se pinta junto a la última generación de cada salida');
/* Los umbrales, evaluados: fresco/viejo/caduco como manda el contrato. */
const edadSrc = outputs.match(/function frescuraEdad240[\s\S]*?\n\}/);
assert.ok(edadSrc, '7: la fuente trae el clasificador de edad');
const frescuraEdad240 = new Function(edadSrc[0] + '; return frescuraEdad240;')();
const ahora = Date.now();
assert.equal(frescuraEdad240(ahora - 3600000), 'fresco', '7: hace 1 h = fresco');
assert.equal(frescuraEdad240(ahora - 3 * 86400000), 'viejo', '7: hace 3 días = viejo');
assert.equal(frescuraEdad240(ahora - 30 * 86400000), 'caduco', '7: hace 30 días = caduco');
assert.equal(frescuraEdad240('sin-fecha'), '', '7: sin timestamp no se pinta frescura');

/* ---------- (21) modo oscuro: restos corregidos, fijados ---------- */
for (const regla of ['.salud-punto200b[data-nivel="ok"]{background:light-dark(#1d9e6c,#3ecf7a)}',
  '.salud-punto200b[data-nivel="warn"]{background:light-dark(#d99a16,#e8b93e)}',
  '.salud-punto200b[data-nivel="bad"]{background:light-dark(#cf3a2e,#f0766a)}',
  'inset 0 1px 0 light-dark(rgba(255,255,255,.35),rgba(255,255,255,.08))'])
  assert.ok(css.includes(regla), '21: resto oscuro corregido: ' + regla.slice(0, 52));
assert.ok(!css.includes('.salud-punto200b[data-nivel="ok"]{background:#1d9e6c}'),
  '21: fuera el verde fijo que se apagaba en oscuro');
/* El bloque nuevo de W5b1 no introduce ningún color fijo: todo
   cuelga de variables de la casa (light-dark() vía tokens). */
/* RE-BASE 2.9.0: el corte se acota al bloque W5b1 propiamente
   — hasta el siguiente encabezado de bloque («/* =====») —.
   Hasta EOF cazaba los hex de bloques POSTERIORES (el foco
   2.9.0 usa pares light-dark(#hex,#hex), el patrón de tokens
   de la casa, igual que .salud-punto200b de esta misma suite):
   la prohibición de hex fijos DENTRO de W5b1 se conserva
   entera. */
const inicioW5b1 = polish.indexOf('2.4.0 · W5b1');
const finW5b1 = polish.indexOf('/* =====', inicioW5b1 + 1);
const bloque = polish.slice(inicioW5b1, finW5b1 > inicioW5b1 ? finW5b1 : undefined);
assert.ok(bloque.length > 500, '21: el bloque W5b1 existe en polish.part');
assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(bloque),
  '21: ningún hex fijo en el bloque W5b1 (anillo, frescura y totales)');

console.log('OK 2.4.0·W5b1 gráficas I — anillo de cobertura de 12 meses con estados del dato, portada del faro y bloque de totales en el PDF común y en la impresión de pantalla, frescura con tres estados y su contrato, y restos oscuros corregidos y fijados.');
