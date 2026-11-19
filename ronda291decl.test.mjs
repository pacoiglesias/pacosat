import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPlaywrightDriverFactory } from './sat-doc-browser.mjs';

/* ================================================================
   Ronda 2.9.1 — Pieza 5 (Declaraciones): la rejilla REAL del
   portal nuevo se lee entera, con su «Generar PDF» ligado por
   fila.

   El fallo que reproduce (probado en vivo el 18 nov 2026,
   corrida real 1d8f086b-2b3a-41bf-b7e5-618c522c8529, sede NAS,
   2.9.0): el paseo recorrió TODO el corredor — loginda con
   e.firma OK → portal nuevo pstcdypisr → Consulta «De la
   declaración» → formulario enviado (ejercicio 2026, mensual)
   — y la página de resultados SÍ enseñaba las declaraciones:
   su HTML guardado trae «Generar PDF» 27 veces. Aun así el
   lector concluyó «no-concluyente»: su detección de filas no
   casó con la estructura real de la rejilla.

   La causa, probada contra el artefacto guardado de la propia
   corrida (fixture de esta suite, recuperado por la API
   interna: GET /api/declaraciones/artifact?run=1d8f086b…&
   part=html; vive en ~/workspace/pacosat-291-evidencia/
   decl-1d8f086b-resultados.html): en #tableResult el acuse de
   cada fila NO es un enlace de texto — es
   <a id="linkDescargaPDF" href="/Consulta/RecuperarArchivo?
   …&numeroOperacion=…&ejercicio=2026"><img alt="Generar
   PDF"></a> — y el lector pedía textContent === 'generar
   pdf': la imagen no tiene texto, ninguna fila casaba. La
   página trae además la misma lista en un acordeón oculto
   (display:none) con otros 13 enlaces idénticos: el conteo
   de pdfIndex se limita a los enlaces dentro de una tabla
   para que el gemelo no desplace los índices.

   COMPROBACIÓN DE VERDAD: contra el lector 2.9.0 intacto,
   portalNuevoResults devuelve [] sobre este fixture y
   clickPortalPdf no encuentra ningún enlace (la suite sale
   en rojo); con el arreglo, lee las 13 filas — 10 Normales
   (Enero–Octubre) y 3 Complementarias de Modificación de
   Obligaciones (Enero, Febrero, Marzo), exactamente las del
   recon manual del 16 nov 2026 — y el clic por pdfIndex baja
   el acuse de SU fila (la petición a RecuperarArchivo lleva
   el numeroOperacion de esa fila).

   El fixture se sirve tal cual quedó guardado, con UNA sola
   adaptación declarada: se retiran las etiquetas <script src>
   y <link href> que apuntan a servidores externos (el CDN
   del portal) para que la prueba no dependa de la red; la
   rejilla, el acordeón y todos los datos quedan byte a byte
   como el portal los enseñó.
   ================================================================ */

const FIXTURE = process.env.PACOSAT_291_FIXTURE ||
  fileURLToPath(new URL('../../pacosat-291-evidencia/decl-1d8f086b-resultados.html', import.meta.url));
assert.ok(existsSync(FIXTURE),
  'ronda291decl necesita el artefacto real de la corrida 1d8f086b en ' + FIXTURE +
  ': sin el fixture verdadero la prueba que puede fallar no puede correr.');

function chromiumDePrueba() {
  const candidatos = [process.env.PACOSAT_TEST_CHROMIUM || '', '/usr/bin/chromium'];
  try {
    const cache = join(homedir(), '.cache', 'ms-playwright');
    for (const dir of readdirSync(cache).sort()) {
      if (dir.startsWith('chromium-')) candidatos.push(join(cache, dir, 'chrome-linux64', 'chrome'));
    }
  } catch { /* sin caché de playwright: quedan los otros candidatos */ }
  return candidatos.find(p => p && existsSync(p)) || '';
}
const CHROME = chromiumDePrueba();
assert.ok(CHROME, 'ronda291decl necesita un Chromium local para leer el fixture con el navegador real.');

const PDF = Buffer.concat([Buffer.from('%PDF-1.4 acuse de juguete\n'),
  Buffer.alloc(512, 0x2e), Buffer.from('\n%%EOF')]);

/* El artefacto, servido en local: la página de resultados en
   /resultados y el endpoint del acuse registrando qué
   operación se le pide. */
let htmlFixture = readFileSync(FIXTURE, 'utf-8');
htmlFixture = htmlFixture
  .replace(/<script[^>]+src="https?:\/\/[^"]*"[^>]*>\s*<\/script>/gi, '')
  .replace(/<link[^>]+href="https?:\/\/[^"]*"[^>]*>/gi, '');
assert.ok(htmlFixture.includes('tableResult') && htmlFixture.includes('linkDescargaPDF'),
  'el fixture conserva la rejilla real tras retirar el CDN externo');

const pedidas = [];
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/resultados') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(htmlFixture);
    return;
  }
  if (url.pathname === '/Consulta/RecuperarArchivo') {
    pedidas.push(url.searchParams.get('numeroOperacion') || '');
    res.writeHead(200, { 'content-type': 'application/pdf',
      'content-disposition': 'attachment; filename="acuse.pdf"' });
    res.end(PDF);
    return;
  }
  res.writeHead(404); res.end();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const BASE = 'http://127.0.0.1:' + server.address().port;

const launch = createPlaywrightDriverFactory({ executablePath: CHROME, headless: true });
const driver = await launch();
const page = await driver.newPage();
await page.goto(BASE + '/resultados');
/* La rejilla del artefacto ya viene poblada en el HTML; se da
   un respiro corto por si el navegador aún compone marcos. */
await new Promise(r => setTimeout(r, 600));
const rows = await page.portalNuevoResults();

/* ===== Las 13 filas de 2026, tal como el portal las enseñó ===== */
{
  assert.equal(rows.length, 13,
    'la rejilla real trae 13 declaraciones y el lector las ve todas (trajo ' + rows.length + ')');
  assert.deepEqual(rows.map(r => r.operacion),
    ['262620289089', '262990284391', '267750026871', '262660266241', '264810025913',
     '261500241392', '261730216515', '266970018713', '265230016566', '261420144422',
     '262670086039', '261540047899', '261550030435'],
    'las operaciones, en el orden del portal (fecha de presentación descendente)');
  const normales = rows.filter(r => r.tipo === 'Normal');
  const complementarias = rows.filter(r => r.tipo === 'Complementaria');
  assert.equal(normales.length, 10, '10 Normales (Enero–Octubre)');
  assert.equal(complementarias.length, 3, '3 Complementarias (Enero, Febrero y Marzo)');
  assert.deepEqual(complementarias.map(r => r.periodo), ['Marzo', 'Febrero', 'Enero'],
    'las complementarias son las de Marzo, Febrero y Enero, en el orden del portal');
  assert.ok(complementarias.every(r => r.tipoComplementaria === 'Modificación de Obligaciones'),
    'cada complementaria trae su tipo: Modificación de Obligaciones');
  assert.deepEqual(rows.map(r => r.periodo),
    ['Octubre', 'Marzo', 'Febrero', 'Septiembre', 'Enero', 'Agosto', 'Julio',
     'Junio', 'Mayo', 'Abril', 'Marzo', 'Febrero', 'Enero'],
    'cada fila trae su período, tal como la celda lo nombra');
  assert.equal(rows[0].fecha, '10/11/2026', 'la primera es la de Octubre, presentada el 10/11/2026');
  assert.equal(rows[0].lineaCaptura, '04267Z2H990051682421',
    'la línea de captura de Octubre, la misma que el recon del 16 nov leyó a mano');
  assert.equal(rows[0].ejercicio, '2026', 'el ejercicio viaja en la fila (su enlace de acuse lo lleva)');
  assert.deepEqual(rows.map(r => r.pdfIndex), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    'pdfIndex 0–12 en orden: el acordeón oculto con sus 13 enlaces gemelos NO desplaza los índices');
  console.log('OK 2.9.1 · Pieza 5-a — La rejilla real del artefacto se lee entera: 13 filas (10 Normales + 3 Complementarias de Modificación de Obligaciones), con tipo, período, fecha, línea de captura y pdfIndex ligado por fila.');
}

/* ===== El «Generar PDF» de una fila baja SU acuse ===== */
{
  await page.clickPortalPdf(rows[0].pdfIndex);
  const pdf = await page.waitForPdf(15_000);
  assert.ok(pdf && pdf.length && pdf.subarray(0, 4).toString('latin1') === '%PDF',
    'el clic en el «Generar PDF» de la primera fila baja su acuse en PDF');
  assert.deepEqual(pedidas, ['262620289089'],
    'la petición a RecuperarArchivo lleva el numeroOperacion de ESA fila (la de Octubre)');
  console.log('OK 2.9.1 · Pieza 5-b — clickPortalPdf(0) pide el acuse de la operación 262620289089 y el PDF llega.');
}
{
  /* Otra vez sobre la página, ahora una complementaria de en
     medio: el índice sigue atado a su fila tras re-leer. */
  await page.goto(BASE + '/resultados');
  await new Promise(r => setTimeout(r, 600));
  const rows2 = await page.portalNuevoResults();
  const feb = rows2.find(r => r.operacion === '267750026871');
  assert.ok(feb, 'la complementaria de Febrero sigue en la lista al re-leer');
  assert.equal(feb.pdfIndex, 2, 'su pdfIndex es el 2, el de su fila');
  await page.clickPortalPdf(feb.pdfIndex);
  const pdf = await page.waitForPdf(15_000);
  assert.ok(pdf && pdf.length && pdf.subarray(0, 4).toString('latin1') === '%PDF',
    'el acuse de la complementaria de Febrero también baja');
  assert.deepEqual(pedidas, ['262620289089', '267750026871'],
    'cada clic pidió la operación de su propia fila, ni una más');
  console.log('OK 2.9.1 · Pieza 5-c — clickPortalPdf(2) pide el acuse de la complementaria de Febrero (267750026871): la ligadura es por fila, no por posición global.');
}

await driver.close();
server.close();
console.log('OK suite ronda291decl completa');
