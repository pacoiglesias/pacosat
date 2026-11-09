import { SatDocError, isPdfBuffer, failure } from './sat-doc-fetch.mjs';
import { satBrowserLogin, prepareKeyForPortal } from './sat-doc-browser.mjs';

/* ================================================================
   Declaraciones y acuses (punto 7 de la 1.9.0, aprobado por Paco
   el 9 nov 2026 a las 16:56): recuperación de declaraciones
   PRESENTADAS y de sus acuses con la misma sesión autenticada del
   navegador interno que usa constancia/opinión.
   ---------------------------------------------------------------
   DOS conectores separados, como aprobó Paco:
   (a) MENSUALES: búsqueda de las declaraciones mensuales
       presentadas de un ejercicio (por periodo o el ejercicio
       entero) y descarga de cada documento: la DECLARACIÓN y su
       ACUSE son documentos distintos y se archivan como tales.
   (b) ANUALES: búsqueda de la declaración anual de un ejercicio y
       generación/descarga de su PDF, más su acuse.

   Disciplina: flujo reproducido con código propio sobre el
   contrato de página documentado aquí; ninguna credencial sale
   del proceso; la validación local de la e.firma (caducidad, RFC,
   pareja) corre ANTES de abrir el navegador, igual que en
   constancia/opinión. La navegación tras el login es por TEXTOS
   visibles del portal (no por rutas inventadas): si el portal no
   muestra el acceso esperado, el error es respuesta-inesperada y
   no se teclea nada más.

   Contrato de página que el conector sabe usar (el portal
   simulado de las pruebas lo implementa tal cual):
   - Tras el login, enlaces con texto «Declaraciones mensuales» /
     «Declaración anual».
   - Formulario de búsqueda: selectores #ejercicio y #periodo
     (mensuales) y el botón #buscar.
   - Resultados: filas tr[data-operacion] con celdas de texto
     (fecha de presentación, tipo, periodo) y enlaces
     a[data-descargar="acuse"|"declaracion"|"anual"] cuyo clic
     entrega el PDF como descarga o como respuesta del navegador.
   Los selectores viven en OPCIONES (declSelectors) para poder
   ajustarlos en la primera corrida real sin tocar la lógica.
   ================================================================ */

export const DECL_DEFAULTS = {
  entryUrl: 'https://wwwmat.sat.gob.mx/app/seg/faces/pages/lanzador.jsf?tipoLogeo=c&target=principal&hostServer=https://wwwmat.sat.gob.mx',
  linkMensuales: 'Declaraciones mensuales',
  linkAnuales: 'Declaración anual',
  ejercicio: '#ejercicio',
  periodo: '#periodo',
  buscar: '#buscar'
};

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/* Lee las filas de resultados a través del driver: la fábrica real
   las extrae del DOM; el driver falso de las pruebas las sirve. */
async function readResults(page) {
  const rows = await page.declResults();
  return (rows || []).map(row => ({
    operacion: String(row.operacion || ''),
    fechaPresentacion: String(row.fecha || ''),
    tipo: String(row.tipo || ''),
    periodo: String(row.periodo || ''),
    tieneAcuse: !!row.acuse,
    tieneDeclaracion: !!row.declaracion
  }));
}

async function downloadOne(page, clase, index) {
  await page.clickDeclDownload(clase, index);
  const pdf = await page.waitForPdf(30_000);
  if (pdf && isPdfBuffer(pdf)) return pdf;
  return null;
}

/* Conector (a): mensuales de un ejercicio (y periodo opcional). */
export async function fetchMensuales({ page, ejercicio, periodo = '', selectors = DECL_DEFAULTS }) {
  const linked = await page.clickText(selectors.linkMensuales).catch(() => false);
  if (!linked) throw failure('respuesta-inesperada',
    'Tras el acceso, el portal no mostró el acceso a las declaraciones mensuales que PacoSAT ' +
    'sabe usar. Si el portal cambió su página, habrá que actualizar PacoSAT.');
  await page.selectSelector(selectors.ejercicio, String(ejercicio));
  if (periodo) await page.selectSelector(selectors.periodo, periodo);
  await page.clickSelector(selectors.buscar);
  await sleep(600);
  const rows = await readResults(page);
  const documents = [];
  const warnings = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const base = { ejercicio: Number(ejercicio), periodo: row.periodo || periodo,
      fechaPresentacion: row.fechaPresentacion, operacion: row.operacion,
      tipoPresentacion: row.tipo };
    if (row.tieneDeclaracion) {
      const content = await downloadOne(page, 'declaracion', i);
      if (content) documents.push({ ...base, clase: 'declaracion', content });
      else warnings.push('La declaración del periodo ' + base.periodo + ' apareció en la lista pero su PDF no llegó.');
    }
    if (row.tieneAcuse) {
      const content = await downloadOne(page, 'acuse', i);
      if (content) documents.push({ ...base, clase: 'acuse', content });
      else warnings.push('El acuse del periodo ' + base.periodo + ' apareció en la lista pero su PDF no llegó.');
    }
  }
  return { documents, warnings, found: rows.length };
}

/* Conector (b): la anual de un ejercicio (PDF + acuse). */
export async function fetchAnual({ page, ejercicio, selectors = DECL_DEFAULTS }) {
  const linked = await page.clickText(selectors.linkAnuales).catch(() => false);
  if (!linked) throw failure('respuesta-inesperada',
    'Tras el acceso, el portal no mostró el acceso a la declaración anual que PacoSAT sabe ' +
    'usar. Si el portal cambió su página, habrá que actualizar PacoSAT.');
  await page.selectSelector(selectors.ejercicio, String(ejercicio));
  await page.clickSelector(selectors.buscar);
  await sleep(600);
  const rows = await readResults(page);
  const documents = [];
  const warnings = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const base = { ejercicio: Number(ejercicio), periodo: String(ejercicio),
      fechaPresentacion: row.fechaPresentacion, operacion: row.operacion,
      tipoPresentacion: row.tipo || 'Anual' };
    if (row.tieneDeclaracion) {
      const content = await downloadOne(page, 'anual', i);
      if (content) documents.push({ ...base, clase: 'declaracion', content });
      else warnings.push('La declaración anual de ' + ejercicio + ' apareció pero su PDF no se generó o no llegó.');
    }
    if (row.tieneAcuse) {
      const content = await downloadOne(page, 'acuse', i);
      if (content) documents.push({ ...base, clase: 'acuse', content });
      else warnings.push('El acuse de la anual de ' + ejercicio + ' apareció pero su PDF no llegó.');
    }
  }
  return { documents, warnings, found: rows.length };
}

/* Fábrica con el puerto que espera el servicio:
   satDeclFetch({ rfc }, { tipo, ejercicio, periodo }) ->
   { documents: [...], warnings: [...], found }.
   Una sesión a la vez, como en constancia/opinión. */
export function createSatDeclFetch({ resolveCredentials, launchDriver, now = () => Date.now(),
  selectors = DECL_DEFAULTS, entryUrl = DECL_DEFAULTS.entryUrl } = {}) {
  void now;
  let chain = Promise.resolve();
  const run = async (profile, query) => {
    const tipo = query?.tipo === 'anual' ? 'anual' : 'mensual';
    const ejercicio = Number(query?.ejercicio);
    if (!Number.isInteger(ejercicio) || ejercicio < 2015 || ejercicio > 2100) {
      throw failure('respuesta-inesperada', 'Ejercicio no válido para buscar declaraciones: ' + query?.ejercicio);
    }
    const creds = await resolveCredentials(profile); // valida ANTES de abrir el navegador
    let driver = null;
    try {
      driver = await launchDriver();
    } catch (error) {
      if (error instanceof SatDocError) throw error;
      throw failure('navegador-no-disponible', 'El navegador interno de PacoSAT no pudo arrancar ' +
        'en el servidor (' + (error?.message || error) + ').');
    }
    try {
      const page = await driver.newPage();
      const keyMaterial = prepareKeyForPortal(creds.key, creds.password);
      await satBrowserLogin(page, { cer: creds.cer, key: keyMaterial.buffer,
        password: creds.password, entryUrl });
      const result = tipo === 'anual'
        ? await fetchAnual({ page, ejercicio, selectors })
        : await fetchMensuales({ page, ejercicio, periodo: String(query?.periodo || ''), selectors });
      if (!result.found) {
        return { documents: [], warnings: ['El portal no mostró declaraciones ' +
          (tipo === 'anual' ? 'anuales' : 'mensuales') + ' presentadas de ' + ejercicio +
          ' para este RFC: puede que no se haya presentado ninguna o que la búsqueda necesite otro periodo.'],
          found: 0 };
      }
      if (!result.documents.length) {
        throw failure('paso-interactivo', 'El portal mostró ' + result.found + ' declaración(es) ' +
          'pero ningún PDF llegó al navegador. ' + (result.warnings[0] || ''));
      }
      return result;
    } finally {
      await driver.close().catch(() => {});
    }
  };
  return (profile, query) => {
    const result = chain.then(() => run(profile, query));
    chain = result.catch(() => {});
    return result;
  };
}
