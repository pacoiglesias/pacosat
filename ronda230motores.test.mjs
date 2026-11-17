import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { extractBase64Pdf, fetchDocumentInBrowser, createSatDocBrowserFetch } from './sat-doc-browser.mjs';
import { SatDocError } from './sat-doc-fetch.mjs';
import { buildExecutorJob, validateExecutorResult, SAT_EXECUTOR_OPERATIONS } from './sat-executor.mjs';
import { fetchMensuales, fetchTransacciones } from './sat-declaraciones.mjs';

/* ================================================================
   Ronda 2.3.0 · MOTORES SAT (suite del constructor de motores;
   la registra el orquestador, no esta suite).

   Pieza nº 2 — la Opinión tan fiable como la Constancia.
   Diagnóstico (respaldo en sat-doc-browser.mjs): la constancia
   NAVEGA y PULSA hasta su generador (menú del Buzón, marco del
   trámite, «Generar Constancia», clickFrameGenerate, «Generar»)
   y la opinión SOLO ESPERABA: tras el login no hacía ningún clic
   ni navegación. Si el SPA de la opinión (ptsc32d) solo pide su
   PDF tras un gesto en pantalla — el modo de fallo reproducido
   aquí —, la espera pasiva muere siempre, con la sesión abierta:
   es lo que pasó dos veces el 16 nov 2026. El portal simulado de
   esta suite reproduce ESE modo: sin clic en su control de
   generar no hay ni descarga ni fase de respuesta completa.
   Pieza nº 6 — protocolo: payload soloFaltantes y progreso
   operacionesCompletadas en declaraciones-recuperar, sin abrir
   ninguna operación nueva del protocolo.
   Pieza nº 15 — datos: lo que los motores devuelven trae los
   campos exactos que la línea de vida consume al archivar
   (operación, fechaPresentacion, clase acuse → tieneAcuse y
   documentoAcuseId en el servidor).
   ================================================================ */
const RFC = 'MFI6212158B4';
const PASSWORD = 'buena-efirma';
const PDF = Buffer.concat([Buffer.from('%PDF-1.4 documento de juguete\n'),
  Buffer.alloc(1024, 0x2e), Buffer.from('\n%%EOF')]);
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KEY_3DES = privateKey.export({ type: 'pkcs8', format: 'der', cipher: 'des-ede3-cbc', passphrase: PASSWORD });
const CREDS = { rfc: RFC, cer: Buffer.from('certificado-de-juguete'), key: KEY_3DES, password: PASSWORD };

/* Portal simulado de la OPINIÓN con el modo de fallo del 16 nov:
   la sesión abre, pero el SPA no pide el PDF hasta que se pulsa
   su control de generar (gestoTexto). Antes del gesto no hay
   descarga (waitForPdf → null) ni fase (responses → []). */
class OpinionFakePage {
  constructor(script = {}) {
    Object.assign(this, { pdf: null, jsonResponses: [], errorText: '',
      afterLogin: 'https://ptsc32d.clouda.sat.gob.mx/reporte',
      gestoTexto: null, gesto: false, pdfTrasGesto: null, responsesTrasGesto: [],
      clickedTexts: [] }, script);
    this.currentUrl = 'about:blank';
  }
  async goto(url) { this.currentUrl = url; }
  url() { return this.currentUrl; }
  async clickButtonFiel() {}
  async fillFielForm(form) { this.filled = form; }
  async submitFiel() { this.currentUrl = this.afterLogin; }
  async divError() { return this.errorText; }
  async clickText(text) {
    this.clickedTexts.push(text);
    if (this.gestoTexto && text === this.gestoTexto) { this.gesto = true; return true; }
    return false;
  }
  async waitForPdf() { return this.gesto && this.pdfTrasGesto ? this.pdfTrasGesto : this.pdf; }
  async responses() { return this.gesto ? this.responsesTrasGesto : this.jsonResponses; }
  async diagnostics() {
    return { url: this.url(), screenshot: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2]),
      html: '<html><body>opinión sin generar — pantalla simulada</body></html>' };
  }
  async close() {}
}
const fakeDriverOf = (page) => async () => ({ newPage: async () => page, close: async () => {} });

/* 2-A · LA OPINIÓN BAJA EN EL MODO QUE ANTES FALLABA: el SPA solo
     entrega su fase de respuesta completa TRAS el gesto. */
{
  const page = new OpinionFakePage({ gestoTexto: 'Generar PDF',
    responsesTrasGesto: [{ url: 'https://ptsc32d.clouda.sat.gob.mx/api/ObtenerRespuestaCompletaPdf',
      body: JSON.stringify({ documento: PDF.toString('base64') }) }] });
  const result = await fetchDocumentInBrowser({ page, kind: 'opinion', creds: CREDS, timeoutMs: 20_000 });
  assert.deepEqual(result.content, PDF, 'la opinión baja tras pulsar su control de generar');
  assert.ok(page.gesto, 'el driver hizo el gesto en pantalla que el SPA esperaba');
  assert.ok(page.clickedTexts.includes('Generar PDF'), 'el gesto fue sobre el control de generar del SPA');
  console.log('OK 2.3.0 nº2-A: opinión con gesto previo — la fase de respuesta completa llega tras pulsar generar.');
}

/* 2-B · El mismo gesto, con entrega como DESCARGA del navegador
     (la otra vía de la constancia): control «Generar» a secas. */
{
  const page = new OpinionFakePage({ gestoTexto: 'Generar', pdfTrasGesto: PDF });
  const fetchBrowser = createSatDocBrowserFetch({ launchDriver: fakeDriverOf(page),
    timeoutMs: 20_000, resolveCredentials: async () => CREDS });
  const result = await fetchBrowser({ rfc: RFC }, 'opinion');
  assert.deepEqual(result.content, PDF, 'la opinión baja como descarga tras el gesto');
  assert.equal(result.fileName, RFC + '-32d.pdf');
  console.log('OK 2.3.0 nº2-B: opinión con gesto previo — el PDF llega como descarga del navegador.');
}

/* 2-C · La constancia SIGUE bajando por su camino de siempre. */
{
  const page = new OpinionFakePage({ pdf: PDF, gestoTexto: 'Generar Constancia',
    afterLogin: 'https://wwwmat.sat.gob.mx/operacion/43824/reimprime-tus-acuses-del-rfc' });
  const result = await fetchDocumentInBrowser({ page, kind: 'constancia', creds: CREDS, timeoutMs: 20_000 });
  assert.deepEqual(result.content, PDF, 'la constancia sigue bajando');
  assert.ok(page.clickedTexts.includes('Generar Constancia'));
  console.log('OK 2.3.0 nº2-C: la constancia no se movió de su camino.');
}

/* 2-D · La fase en Base64 en sus formas que el extractor viejo
     perdía: partido en trozos dentro de un array, anidado más
     hondo que su profundidad, y con prefijo data-URI. */
{
  const b64 = PDF.toString('base64');
  const trozos = [b64.slice(0, 300), b64.slice(300, 700), b64.slice(700)];
  assert.deepEqual(extractBase64Pdf([{ url: 'https://ptsc32d.clouda.sat.gob.mx/api/x',
    body: JSON.stringify({ respuesta: { documento: trozos } }) }]), PDF,
    'base64 partido en trozos dentro de un array');
  assert.deepEqual(extractBase64Pdf([{ url: 'https://ptsc32d.clouda.sat.gob.mx/api/x',
    body: JSON.stringify({ a: { b: { c: { d: { e: { documento: b64 } } } } } }) }]), PDF,
    'base64 anidado a profundidad 6');
  assert.deepEqual(extractBase64Pdf([{ url: 'https://ptsc32d.clouda.sat.gob.mx/api/x',
    body: JSON.stringify({ pdf: 'data:application/pdf;base64,' + b64 }) }]), PDF,
    'base64 con prefijo data-URI');
  assert.equal(extractBase64Pdf([{ url: 'https://x.test/api', body: '{"aviso":"sin datos"}' }]), null,
    'sin PDF en la respuesta, el extractor sigue devolviendo null');
  console.log('OK 2.3.0 nº2-D: extractBase64Pdf reconoce trozos, anidado hondo y data-URI; sin PDF, null.');
}

/* 2-E · Si el portal de verdad NO entrega, el error sigue siendo
     paso-interactivo y SIGUE trayendo su evidencia (captura y
     HTML), como desde la 2.0.1. */
{
  const page = new OpinionFakePage({ gestoTexto: null });
  const fetchBrowser = createSatDocBrowserFetch({ launchDriver: fakeDriverOf(page),
    timeoutMs: 4_000, resolveCredentials: async () => CREDS });
  const error = await fetchBrowser({ rfc: RFC }, 'opinion').then(() => null, e => e);
  assert.ok(error instanceof SatDocError);
  assert.equal(error.code, 'paso-interactivo');
  assert.match(error.message, /opinión de cumplimiento no entregó su PDF|no apareció el control de generar/);
  assert.ok(error.diag, 'el fallo viaja con diagnóstico');
  assert.ok(error.diag.html.includes('opinión sin generar'), 'el HTML de la pantalla viaja en el error');
  assert.deepEqual([...error.diag.screenshot], [0x89, 0x50, 0x4e, 0x47, 1, 2], 'la captura viaja en el error');
  console.log('OK 2.3.0 nº2-E: sin entrega del portal, paso-interactivo con captura y HTML adjuntos.');
}

/* 6-A · El trabajo declaraciones-recuperar ADMITE el payload
     { soloFaltantes, ejercicio, periodo } tal cual. */
{
  const job = buildExecutorJob({ rfc: RFC, kind: 'declaraciones-recuperar',
    payload: { soloFaltantes: true, ejercicio: 2026, periodo: '2026-09' } });
  assert.equal(job.payload.soloFaltantes, true, 'soloFaltantes sobrevive a la construcción del trabajo');
  assert.equal(job.payload.ejercicio, 2026);
  assert.equal(job.payload.periodo, '2026-09');
  const completo = buildExecutorJob({ rfc: RFC, kind: 'declaraciones-recuperar',
    payload: { ejercicio: 2026, periodo: '2026-09' } });
  assert.notEqual(job.dedupeKey, completo.dedupeKey,
    'pedir solo los faltantes no colisiona con pedir el periodo entero');
  console.log('OK 2.3.0 nº6-A: payload soloFaltantes admitido en declaraciones-recuperar, con su propia dedupeKey.');
}

/* 6-B · El resultado ADMITE el progreso operacionesCompletadas
     y validateExecutorResult lo devuelve saneado (operaciones
     válidas, sin duplicados), sin rechazar el resultado. */
{
  const job = buildExecutorJob({ rfc: RFC, kind: 'declaraciones-recuperar',
    payload: { soloFaltantes: true, ejercicio: 2026, periodo: '2026-09' } });
  const out = validateExecutorResult(job, {
    operations: ['entrar-con-efirma', 'descargar-pdf'],
    operacionesCompletadas: ['262620100100', '2626 2010 1101', '262620100100', 'no-es-operación!!'],
    documents: [{ clase: 'acuse', ejercicio: 2026, periodo: '2026-09',
      fechaPresentacion: '17/10/2026', operacion: '262620100100',
      contentBase64: PDF.toString('base64') }]
  });
  assert.deepEqual(out.operacionesCompletadas, ['262620100100', '262620101101'],
    'el progreso vuelve saneado: válidas, sin espacios ni duplicados');
  assert.equal(out.documents.length, 1, 'el documento del resultado sigue verificándose igual');
  console.log('OK 2.3.0 nº6-B: operacionesCompletadas admitido y saneado por validateExecutorResult.');
}

/* 6-C · La lista cerrada de operaciones NO crece: sin abrir
     ninguna operación nueva en esta ronda. */
{
  assert.deepEqual([...SAT_EXECUTOR_OPERATIONS],
    ['entrar-con-efirma', 'navegar-a-lista', 'leer-lista', 'consultar-transacciones',
     'reimprimir-acuse-por-folio', 'descargar-pdf', 'leer-documento'],
    'SAT_EXECUTOR_OPERATIONS queda exactamente como estaba');
  console.log('OK 2.3.0 nº6-C: la lista de operaciones del protocolo no crece.');
}

/* 15-A · fetchMensuales devuelve, por documento, los campos
     exactos que el servidor archiva en «declaraciones» y de los
     que la línea de vida deriva tieneAcuse/documentoAcuseId:
     operacion, fechaPresentacion, clase 'acuse' y el PDF. */
class PortalNuevoFake {
  constructor(script = {}) {
    Object.assign(this, { rows: [], pdfs: {}, selects: {}, armed: null }, script);
  }
  async clickText(text) {
    return ['Nuevo portal de pagos provisionales', 'Consultas', 'De la declaración'].includes(text);
  }
  async selectSelector(selector, value) { this.selects[selector] = value; }
  async clickSelector() {}
  async portalNuevoResults() { return this.rows; }
  async clickPortalPdf(index) { this.armed = this.pdfs[index] || null; if (!this.armed) throw new Error('sin pdf'); }
  async waitForPdf() { return this.armed; }
  async text() { return ''; }
}
{
  const page = new PortalNuevoFake({
    rows: [{ operacion: '262620100100', fecha: '17/10/2026', tipo: 'Normal', periodo: '2026-09', pdfIndex: 0 }],
    pdfs: { 0: PDF } });
  const result = await fetchMensuales({ page, ejercicio: 2026, periodo: '2026-09' });
  assert.equal(result.documents.length, 1);
  const doc = result.documents[0];
  assert.equal(doc.operacion, '262620100100', 'operación: la trae el motor');
  assert.equal(doc.fechaPresentacion, '17/10/2026', 'fechaPresentacion: la trae el motor');
  assert.equal(doc.clase, 'acuse', 'clase acuse: de ella el servidor deriva tieneAcuse');
  assert.equal(doc.periodo, '2026-09');
  assert.equal(doc.ejercicio, 2026);
  assert.ok(doc.content.subarray(0, 4).toString('latin1') === '%PDF',
    'el PDF viaja: al archivarse nace la fila de declaraciones con su id (documentoAcuseId)');
  console.log('OK 2.3.0 nº15-A: fetchMensuales trae operación, fechaPresentacion, clase acuse y PDF por documento.');
}

/* 15-B · fetchTransacciones devuelve operación Y fecha de
     presentación (y periodo/ejercicio/tipo), y el protocolo del
     ejecutor las conserva hasta el resultado validado. */
class TxFake {
  constructor() { this.currentUrl = 'about:blank'; }
  async goto(url) { this.currentUrl = url; }
  url() { return this.currentUrl; }
  async diagnostics() { return { url: this.currentUrl, screenshot: null, html: '<html>Consulta de transacciones</html>' }; }
  async text() { return ''; }
  async selectSelector() {}
  async clickSelector() {}
  async transacciones() {
    return [
      { cells: ['262620100100', 'Mensual', '2026', 'Octubre', '17/10/2026'] },
      { cells: ['262620100100', 'Mensual', '2026', 'Octubre', '17/10/2026'] },
      { cells: ['sin folio en esta fila'] }
    ];
  }
}
{
  const result = await fetchTransacciones({ page: new TxFake(), ejercicio: 2026 });
  assert.equal(result.transactions.length, 1, 'duplicadas y filas sin folio quedan fuera');
  const t = result.transactions[0];
  assert.equal(t.operacion, '262620100100');
  assert.equal(t.fechaPresentacion, '17/10/2026', 'fechaPresentacion: la trae el motor de transacciones');
  assert.equal(t.periodo, '2026-10');
  assert.equal(t.ejercicio, 2026);
  assert.equal(t.tipo, 'mensual');
  const job = buildExecutorJob({ rfc: RFC, kind: 'declaraciones-transacciones', payload: { ejercicio: 2026 } });
  const out = validateExecutorResult(job, { operations: ['entrar-con-efirma', 'consultar-transacciones'],
    transactions: result.transactions });
  assert.equal(out.transactions[0].fechaPresentacion, '17/10/2026',
    'el protocolo conserva la fechaPresentacion de la transacción');
  console.log('OK 2.3.0 nº15-B: fetchTransacciones trae operación y fecha; el protocolo las conserva.');
}

console.log('OK ronda 2.3.0 · motores: opinión con gesto (nº2), protocolo soloFaltantes/' +
  'operacionesCompletadas (nº6) y campos de la línea de vida (nº15).');
