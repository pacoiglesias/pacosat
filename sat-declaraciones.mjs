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

/* Endurecimiento 1.22.0 (pieza 6): la corrida real del 11 nov
   murió porque «el trámite no enseñó la plantilla que PacoSAT
   conoce» — el menú tras el acceso tarda en pintarse y el texto
   del acceso puede venir en su forma corta. El enlace se busca
   por VARIOS textos visibles y con una segunda pasada tras una
   espera corta (el menú del portal es un SPA que pinta tarde);
   y si el formulario de búsqueda no aparece como se conoce, el
   error lo dice EN ESE PASO y con esa causa, no en genérico. */
async function clickTramiteLink(page, candidates) {
  for (let pass = 0; pass < 2; pass++) {
    for (const text of candidates) {
      if (await page.clickText(text).catch(() => false)) return text;
    }
    if (pass === 0) await sleep(1500);
  }
  return '';
}
/* Aterrizaje real del portal (1.27.0, bloque C — evidencia viva
   del 11 nov 2026): tras el acceso con e.firma el portal NO deja
   al contribuyente en el lanzador de trámites: aterriza primero
   en el Buzón Tributario, y el enlace del trámite no apareció en
   la corrida viva («Enlace del trámite — no encontrado», dos
   intentos). El remapeo: si los textos no aparecen en la página
   de aterrizaje, se entra al MARCO del trámite que el propio
   portal tenga cargado (la misma vía que la constancia usa desde
   la 1.13.0: el marco vive tras el SessionBroker) navegando a su
   dirección y se busca otra vez ahí dentro. Si tampoco, el error
   sale con la página guardada (la fábrica adjunta el diagnóstico)
   y la primera corrida viva enseñará el aterrizaje real. */
async function enterTramite(page, candidates, onStep) {
  const directo = await clickTramiteLink(page, candidates);
  if (directo) return directo;
  notifyStep(onStep, 'Aterrizaje del portal', 'el enlace no estaba en la primera pantalla; se busca dentro del marco del trámite');
  if (typeof page.tramiteFrameUrl === 'function' && typeof page.goto === 'function') {
    const frameUrl = await page.tramiteFrameUrl().catch(() => '');
    if (frameUrl) {
      await page.goto(frameUrl).catch(() => {});
      const enMarco = await clickTramiteLink(page, candidates);
      if (enMarco) {
        notifyStep(onStep, 'Enlace del trámite', 'encontrado dentro del marco: «' + enMarco + '»');
        return enMarco;
      }
    }
  }
  return '';
}
async function fillSearchForm(page, selectors, ejercicio, periodo, tramite) {
  try {
    await page.selectSelector(selectors.ejercicio, String(ejercicio));
    if (periodo) await page.selectSelector(selectors.periodo, periodo);
    await page.clickSelector(selectors.buscar);
  } catch {
    throw failure('respuesta-inesperada',
      'Tras entrar a ' + tramite + ', el formulario de búsqueda no apareció como PacoSAT lo ' +
      'conoce (ejercicio, periodo y botón de buscar): el portal enseñó otra pantalla. ' +
      'La página que enseñó queda guardada en el diario de la corrida.');
  }
  await sleep(600);
}

/* Diario por pasos (1.23.0): el llamante puede pasar onStep(paso,
   detalle) y recibe cada fase en texto corto en español, sin que
   eso cambie selectores ni la navegación. Un onStep que falle no
   debe tumbar la corrida: se traga su error. */
const notifyStep = (onStep, paso, detalle = '') => {
  if (typeof onStep !== 'function') return;
  try { onStep(String(paso || ''), String(detalle || '')); } catch { /* el diario nunca tumba la corrida */ }
};

/* Conector (a): mensuales de un ejercicio (y periodo opcional). */
export async function fetchMensuales({ page, ejercicio, periodo = '', selectors = DECL_DEFAULTS, onStep = null }) {
  const linked = await enterTramite(page,
    [selectors.linkMensuales, 'Mensuales', 'Declaraciones presentadas'], onStep);
  if (!linked) {
    notifyStep(onStep, 'Enlace del trámite', 'no encontrado');
    throw failure('respuesta-inesperada',
      'Tras el acceso, el portal no mostró el acceso a las declaraciones mensuales que PacoSAT ' +
      'sabe usar. Si el portal cambió su página, habrá que actualizar PacoSAT.');
  }
  notifyStep(onStep, 'Enlace del trámite', 'encontrado: «' + linked + '»');
  await fillSearchForm(page, selectors, ejercicio, periodo, 'las declaraciones mensuales');
  notifyStep(onStep, 'Formulario de búsqueda enviado', 'ejercicio ' + ejercicio + (periodo ? ' · periodo ' + periodo : ''));
  const rows = await readResults(page);
  notifyStep(onStep, 'Resultados leídos', rows.length + (rows.length === 1 ? ' fila' : ' filas'));
  const documents = [];
  const warnings = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const base = { ejercicio: Number(ejercicio), periodo: row.periodo || periodo,
      fechaPresentacion: row.fechaPresentacion, operacion: row.operacion,
      tipoPresentacion: row.tipo };
    if (row.tieneDeclaracion) {
      const content = await downloadOne(page, 'declaracion', i);
      notifyStep(onStep, 'Descarga de documento', 'declaracion · ' + base.periodo + (content ? ' · ok' : ' · sin PDF'));
      if (content) documents.push({ ...base, clase: 'declaracion', content });
      else warnings.push('La declaración del periodo ' + base.periodo + ' apareció en la lista pero su PDF no llegó.');
    }
    if (row.tieneAcuse) {
      const content = await downloadOne(page, 'acuse', i);
      notifyStep(onStep, 'Descarga de documento', 'acuse · ' + base.periodo + (content ? ' · ok' : ' · sin PDF'));
      if (content) documents.push({ ...base, clase: 'acuse', content });
      else warnings.push('El acuse del periodo ' + base.periodo + ' apareció en la lista pero su PDF no llegó.');
    }
  }
  return { documents, warnings, found: rows.length };
}

/* Conector (b): la anual de un ejercicio (PDF + acuse). */
export async function fetchAnual({ page, ejercicio, selectors = DECL_DEFAULTS, onStep = null }) {
  const linked = await enterTramite(page,
    [selectors.linkAnuales, 'Anual', 'Declaración anual presentada'], onStep);
  if (!linked) {
    notifyStep(onStep, 'Enlace del trámite', 'no encontrado');
    throw failure('respuesta-inesperada',
      'Tras el acceso, el portal no mostró el acceso a la declaración anual que PacoSAT sabe ' +
      'usar. Si el portal cambió su página, habrá que actualizar PacoSAT.');
  }
  notifyStep(onStep, 'Enlace del trámite', 'encontrado: «' + linked + '»');
  await fillSearchForm(page, selectors, ejercicio, '', 'la declaración anual');
  notifyStep(onStep, 'Formulario de búsqueda enviado', 'ejercicio ' + ejercicio);
  const rows = await readResults(page);
  notifyStep(onStep, 'Resultados leídos', rows.length + (rows.length === 1 ? ' fila' : ' filas'));
  const documents = [];
  const warnings = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const base = { ejercicio: Number(ejercicio), periodo: String(ejercicio),
      fechaPresentacion: row.fechaPresentacion, operacion: row.operacion,
      tipoPresentacion: row.tipo || 'Anual' };
    if (row.tieneDeclaracion) {
      const content = await downloadOne(page, 'anual', i);
      notifyStep(onStep, 'Descarga de documento', 'declaracion · ' + base.periodo + (content ? ' · ok' : ' · sin PDF'));
      if (content) documents.push({ ...base, clase: 'declaracion', content });
      else warnings.push('La declaración anual de ' + ejercicio + ' apareció pero su PDF no se generó o no llegó.');
    }
    if (row.tieneAcuse) {
      const content = await downloadOne(page, 'acuse', i);
      notifyStep(onStep, 'Descarga de documento', 'acuse · ' + base.periodo + (content ? ' · ok' : ' · sin PDF'));
      if (content) documents.push({ ...base, clase: 'acuse', content });
      else warnings.push('El acuse de la anual de ' + ejercicio + ' apareció pero su PDF no llegó.');
    }
  }
  return { documents, warnings, found: rows.length };
}

/* ================================================================
   REIMPRESIÓN POR FOLIO (1.25.0, mejora nº 1 de «LAS 20 DE PACO»):
   el mapa del portal (REA, 11 nov 2026) establece con la ficha
   pública del servicio que la aplicación 77792 del PTSC
   («Reimprime tus acuses de declaraciones presentadas»,
   wwwmat.sat.gob.mx/aplicacion/77792/…) NO es un buscador por
   ejercicio: es una REIMPRESIÓN POR FOLIO CONOCIDO — elegir el
   tipo de declaración en la lista y capturar el número de folio
   de la declaración para reimprimir su acuse. El diseño honesto
   de PacoSAT trabaja así: los folios se guardan en su registro
   (a mano, o solos cuando una búsqueda los revela en la columna
   de operación) y cada acuse se reimprime folio a folio.
   La app ejecutable tras el login NO está mapeada (no se mapea
   sin sesión): la navegación va por TEXTOS visibles y por los
   selectores de OPCIONES, con el diario por pasos de siempre —
   si el portal enseña otra pantalla, el error lo dice en ese
   paso y la página queda guardada en el diario de la corrida.
   La URL de la aplicación SÍ consta: es la de la ficha pública.
   ================================================================ */
export const DECL_FOLIO_DEFAULTS = {
  appUrl: 'https://wwwmat.sat.gob.mx/aplicacion/77792/reimprime-tus-acuses-de-declaraciones-presentadas',
  linkTextos: ['Reimprime tus acuses', 'Reimpresión de acuses', 'Reimprimir acuse', 'Acuses de declaraciones'],
  tipo: '#tipoDeclaracion',
  folio: '#folio',
  buscar: '#consultar',
  buscarTextos: ['Consultar', 'Reimprimir', 'Buscar'],
  imprimirTextos: ['Imprimir', 'Descargar', 'Guardar']
};

export async function fetchAcusePorFolio({ page, folio, tipoDeclaracion = '', ejercicio = 0, periodo = '',
  selectors = DECL_DEFAULTS, folioSelectors = DECL_FOLIO_DEFAULTS, onStep = null }) {
  const folioLimpio = String(folio || '').trim();
  if (!folioLimpio) throw failure('respuesta-inesperada', 'Falta el número de folio a reimprimir.');
  /* Entrada a la aplicación 77792: primero por los textos del
     menú del portal; si el menú no los enseña, por la URL pública
     de la ficha (la sesión ya está abierta tras el login). */
  let entrada = '';
  for (const texto of folioSelectors.linkTextos) {
    if (await page.clickText(texto).catch(() => false)) { entrada = 'enlace «' + texto + '»'; break; }
  }
  if (!entrada) {
    try { await page.goto(folioSelectors.appUrl); entrada = 'la dirección pública del servicio (77792)'; }
    catch { entrada = ''; }
  }
  if (!entrada) {
    notifyStep(onStep, 'Entrada al servicio de acuses', 'no encontrada');
    throw failure('respuesta-inesperada',
      'Tras el acceso, el portal no mostró la entrada a la reimpresión de acuses (77792) que la ficha ' +
      'del servicio describe. La página que enseñó queda guardada en el diario de la corrida.');
  }
  notifyStep(onStep, 'Entrada al servicio de acuses', entrada);
  /* Formulario de la ficha: tipo en una lista + folio capturado. */
  try {
    if (tipoDeclaracion) {
      const etiqueta = tipoDeclaracion === 'anual' ? 'Anual' : 'Mensual';
      await page.selectSelector(folioSelectors.tipo, etiqueta).catch(async () => {
        await page.selectSelector(folioSelectors.tipo, tipoDeclaracion);
      });
    }
    await page.fillSelector(folioSelectors.folio, folioLimpio);
  } catch {
    throw failure('respuesta-inesperada',
      'El formulario de reimpresión no apareció como la ficha lo describe (tipo de declaración en ' +
      'una lista y campo para el número de folio): el portal enseñó otra pantalla. La página que ' +
      'enseñó queda guardada en el diario de la corrida.');
  }
  notifyStep(onStep, 'Folio capturado', folioLimpio);
  let buscado = await page.clickSelector(folioSelectors.buscar).then(() => true).catch(() => false);
  if (!buscado) for (const texto of folioSelectors.buscarTextos) {
    if (await page.clickText(texto).catch(() => false)) { buscado = true; break; }
  }
  if (!buscado) throw failure('respuesta-inesperada',
    'El formulario de reimpresión no enseñó su botón de consulta: el portal mostró otra pantalla. ' +
    'La página que enseñó queda guardada en el diario de la corrida.');
  await sleep(600);
  /* Resultado: la fila del folio con su acuse descargable (mismo
     contrato de resultados que los demás trámites), o el botón
     de imprimir/guardar de la propia aplicación. */
  const documents = [];
  const rows = await readResults(page).catch(() => []);
  for (let i = 0; i < rows.length; i++) {
    if (!rows[i].tieneAcuse) continue;
    const content = await downloadOne(page, 'acuse', i);
    notifyStep(onStep, 'Descarga del acuse', 'folio ' + folioLimpio + (content ? ' · ok' : ' · sin PDF'));
    if (content) documents.push({ clase: 'acuse', ejercicio: Number(ejercicio) || 0,
      periodo: periodo || rows[i].periodo || '', fechaPresentacion: rows[i].fechaPresentacion || '',
      operacion: folioLimpio, tipoPresentacion: rows[i].tipo || tipoDeclaracion, content });
  }
  if (!documents.length) {
    for (const texto of folioSelectors.imprimirTextos) {
      if (await page.clickText(texto).catch(() => false)) {
        const pdf = await page.waitForPdf(30_000).catch(() => null);
        if (pdf && isPdfBuffer(pdf)) {
          notifyStep(onStep, 'Descarga del acuse', 'folio ' + folioLimpio + ' · ok (botón «' + texto + '»)');
          documents.push({ clase: 'acuse', ejercicio: Number(ejercicio) || 0, periodo: periodo || '',
            fechaPresentacion: '', operacion: folioLimpio, tipoPresentacion: tipoDeclaracion, content: pdf });
        }
        break;
      }
    }
  }
  if (!documents.length) {
    notifyStep(onStep, 'Resultado de la reimpresión', 'sin acuse descargable');
    throw failure('paso-interactivo',
      'El servicio de reimpresión no entregó el acuse del folio ' + folioLimpio + ' en esta corrida: ' +
      'puede que el folio no corresponda al tipo de declaración elegido o que el portal haya enseñado ' +
      'otra pantalla. El diario guarda lo que el portal enseñó.');
  }
  return { documents, warnings: [], found: 1 };
}

/* ================================================================
   DESCUBRIMIENTO DE FOLIOS — CONSULTA DE TRANSACCIONES (1.27.0,
   bloque C; ficha 22513 del catálogo de trámites): el servicio
   enseña, por contribuyente, el nº de operación, el tipo, el
   ejercicio, el periodo y las fechas de sus trámites — es EL
   descubridor de folios cuando el folio no se conoce y el 77792
   no puede ni empezar. DECLARADO: la ficha pública describe qué
   enseña, NO su mecánica interna (si pregunta por criterios o
   por folio) — este conector entra por los textos del portal,
   intenta el patrón de búsqueda conocido (ejercicio + buscar)
   y lee cualquier tabla de operaciones que la página enseñe,
   con la página guardada en el diario sea cual sea el desenlace.
   Su primera corrida viva es la que confirma la mecánica; si el
   servicio resultara ser por-folio, el descubrimiento se queda
   sin filas y el diseño degrada al modo asistido sin romperse.
   ================================================================ */
export const DECL_TRANSACCIONES_DEFAULTS = {
  linkTextos: ['Consulta de transacciones', 'Transacciones', 'Mis transacciones']
};
const MESES_TX = { enero: '01', febrero: '02', marzo: '03', abril: '04', mayo: '05', junio: '06',
  julio: '07', agosto: '08', septiembre: '09', octubre: '10', noviembre: '11', diciembre: '12' };

export function interpretTransaccionRow(cells) {
  const limpias = (cells || []).map(cell => String(cell || '').trim()).filter(Boolean);
  if (!limpias.length) return null;
  const operacion = limpias.find(cell => /^\d{8,20}$/.test(cell.replace(/\s/g, ''))) || '';
  if (!operacion) return null;
  const fechaCelda = limpias.find(cell => /\d{2}\/\d{2}\/\d{4}|\d{4}-\d{2}-\d{2}/.test(cell)) || '';
  const fechaPresentacion = (fechaCelda.match(/\d{2}\/\d{2}\/\d{4}|\d{4}-\d{2}-\d{2}/) || [''])[0];
  const tipoCelda = limpias.find(cell => /anual/i.test(cell)) ? 'anual'
    : limpias.find(cell => /mensual/i.test(cell)) ? 'mensual' : '';
  const ejercicioCelda = limpias.find(cell => /^20\d{2}$/.test(cell)) || '';
  const ejercicio = Number(ejercicioCelda) ||
    Number((fechaPresentacion.match(/(?:\d{2}\/\d{2}\/)?(20\d{2})/) || [])[1]) || 0;
  let periodo = (limpias.find(cell => /^\d{4}[-/]\d{2}$/.test(cell)) || '').replace('/', '-');
  if (!periodo && ejercicio) {
    const mesCelda = limpias.find(cell => MESES_TX[cleanTx(cell)]);
    if (mesCelda) periodo = ejercicio + '-' + MESES_TX[cleanTx(mesCelda)];
  }
  return { operacion, tipo: tipoCelda, ejercicio, periodo, fechaPresentacion };
}
function cleanTx(value) {
  return String(value || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
}

export async function fetchTransacciones({ page, ejercicio = 0, selectors = DECL_DEFAULTS,
  transaccionesSelectors = DECL_TRANSACCIONES_DEFAULTS, onStep = null }) {
  const linked = await enterTramite(page, transaccionesSelectors.linkTextos, onStep);
  if (!linked) {
    notifyStep(onStep, 'Enlace del trámite', 'no encontrado (Consulta de transacciones)');
    throw failure('respuesta-inesperada',
      'Tras el acceso, el portal no mostró la entrada a la Consulta de transacciones (ficha 22513) ' +
      'que descubre los folios. La página que enseñó queda guardada en el diario de la corrida.');
  }
  notifyStep(onStep, 'Enlace del trámite', 'encontrado: «' + linked + '»');
  /* La mecánica de su formulario NO consta en la ficha: se
     intenta el patrón de búsqueda del portal (ejercicio y botón)
     y, enseñe lo que enseñe, se lee la tabla de operaciones. */
  if (ejercicio) {
    try {
      await page.selectSelector(selectors.ejercicio, String(ejercicio));
      await page.clickSelector(selectors.buscar);
      notifyStep(onStep, 'Formulario de consulta enviado', 'ejercicio ' + ejercicio);
    } catch {
      notifyStep(onStep, 'Formulario de consulta', 'el patrón conocido no apareció; se lee la página tal como quedó');
    }
    await sleep(600);
  }
  const crudas = typeof page.transacciones === 'function' ? await page.transacciones().catch(() => []) : [];
  const transactions = [];
  const vistas = new Set();
  for (const row of crudas || []) {
    const interpretada = interpretTransaccionRow(row?.cells);
    if (!interpretada || vistas.has(interpretada.operacion)) continue;
    vistas.add(interpretada.operacion);
    transactions.push(interpretada);
  }
  notifyStep(onStep, 'Transacciones leídas', transactions.length + (transactions.length === 1 ? ' folio descubierto' : ' folios descubiertos'));
  if (!transactions.length) {
    throw failure('respuesta-inesperada',
      'La Consulta de transacciones no enseñó ninguna tabla de operaciones legible: su mecánica ' +
      'interna no consta en la ficha pública y esta corrida no pudo confirmarla. La página que ' +
      'enseñó queda guardada en el diario; si el servicio pregunta por folio en vez de listar, el ' +
      'descubrimiento no aplica y los folios se siguen aprendiendo al nacer cada documento.');
  }
  return { documents: [], warnings: [], transactions, found: transactions.length };
}

/* Fábrica con el puerto que espera el servicio:
   satDeclFetch({ rfc }, { tipo, ejercicio, periodo }) ->
   { documents: [...], warnings: [...], found }.
   Una sesión a la vez, como en constancia/opinión. */
export function createSatDeclFetch({ resolveCredentials, launchDriver, now = () => Date.now(),
  selectors = DECL_DEFAULTS, folioSelectors = DECL_FOLIO_DEFAULTS, transaccionesSelectors = DECL_TRANSACCIONES_DEFAULTS, entryUrl = DECL_DEFAULTS.entryUrl, onStep = null } = {}) {
  void now;
  let chain = Promise.resolve();
  /* Diario por pasos (1.23.0): onStep puede venir de la fábrica o
     por corrida —la función devuelta acepta un tercer argumento
     { onStep } y ese manda—, para que el servidor guarde el diario
     de CADA corrida (decl_runs) y no solo el de la fábrica. */
  const run = async (profile, query, options = {}) => {
    const step = typeof options?.onStep === 'function' ? options.onStep :
      typeof onStep === 'function' ? onStep : null;
    /* Reimpresión por folio (1.25.0): query.tipo === 'folio' va a
       la aplicación 77792 con el folio guardado en el registro;
       no busca por ejercicio porque el servicio no lo ofrece. */
    const esFolio = query?.tipo === 'folio';
    /* Descubrimiento (1.27.0): query.tipo === 'transacciones' va a
       la Consulta de transacciones (22513) y vuelve con folios,
       sin documentos: su resultado no pasa por la lógica de PDFs. */
    const esTransacciones = query?.tipo === 'transacciones';
    const tipo = esFolio ? 'folio' : esTransacciones ? 'transacciones' : query?.tipo === 'anual' ? 'anual' : 'mensual';
    const ejercicio = Number(query?.ejercicio);
    if (!esFolio && !esTransacciones && (!Number.isInteger(ejercicio) || ejercicio < 2015 || ejercicio > 2100)) {
      throw failure('respuesta-inesperada', 'Ejercicio no válido para buscar declaraciones: ' + query?.ejercicio);
    }
    if (esTransacciones && ejercicio && (!Number.isInteger(ejercicio) || ejercicio < 2015 || ejercicio > 2100)) {
      throw failure('respuesta-inesperada', 'Ejercicio no válido para la consulta de transacciones: ' + query?.ejercicio);
    }
    if (esFolio && !String(query?.folio || '').trim()) {
      throw failure('respuesta-inesperada', 'Falta el número de folio para la reimpresión del acuse.');
    }
    const creds = await resolveCredentials(profile); // valida ANTES de abrir el navegador
    notifyStep(step, 'Credenciales validadas', String(profile?.rfc || ''));
    let driver = null;
    try {
      driver = await launchDriver();
    } catch (error) {
      if (error instanceof SatDocError) throw error;
      throw failure('navegador-no-disponible', 'El navegador interno de PacoSAT no pudo arrancar ' +
        'en el servidor (' + (error?.message || error) + ').');
    }
    notifyStep(step, 'Navegador listo', '');
    let page = null;
    try {
      page = await driver.newPage();
      const keyMaterial = prepareKeyForPortal(creds.key, creds.password);
      await satBrowserLogin(page, { cer: creds.cer, key: keyMaterial.buffer,
        password: creds.password, entryUrl });
      notifyStep(step, 'Acceso al portal OK', '');
      const result = esFolio
        ? await fetchAcusePorFolio({ page, folio: String(query.folio), tipoDeclaracion: String(query.tipoDeclaracion || ''),
            ejercicio, periodo: String(query.periodo || ''), selectors, folioSelectors, onStep: step })
        : esTransacciones
        ? await fetchTransacciones({ page, ejercicio: ejercicio || 0, selectors, transaccionesSelectors, onStep: step })
        : tipo === 'anual'
        ? await fetchAnual({ page, ejercicio, selectors, onStep: step })
        : await fetchMensuales({ page, ejercicio, periodo: String(query?.periodo || ''), selectors, onStep: step });
      if (esTransacciones) return result;
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
    } catch (error) {
      /* Diario con la página guardada (1.27.0, bloque C): como en
         constancia/opinión, el error viaja con la foto y el HTML
         de la página tal como quedó — un fallo sin página guardada
         es un fallo perdido, y la corrida viva del 11 nov murió
         sin ella. El servidor la archiva en el diario (decl_runs). */
      if (page && typeof page.diagnostics === 'function' && error && typeof error === 'object' && !error.diag) {
        try { error.diag = await page.diagnostics(); } catch { /* el diagnóstico nunca tapa el error */ }
      }
      throw error;
    } finally {
      await driver.close().catch(() => {});
    }
  };
  return (profile, query, options = {}) => {
    const result = chain.then(() => run(profile, query, options));
    chain = result.catch(() => {});
    return result;
  };
}
