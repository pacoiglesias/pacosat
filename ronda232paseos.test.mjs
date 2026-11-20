import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { DOMParser } from '@xmldom/xmldom';
import { satBrowserLogin } from './sat-doc-browser.mjs';
import { createSatTribFetch } from './sat-tributario.mjs';
import { fetchMensuales } from './sat-declaraciones.mjs';
import { SatDocError } from './sat-doc-fetch.mjs';
import { createPacoSATService } from './local-server.mjs';
import { resultadosDiagDe } from './ejecutor-local.mjs';

/* ================================================================
   Ronda 2.3.2 · constructor P — el capítulo de paseos, SOLO lo
   que la evidencia viva de HOY prueba.

   Evidencia (corrida real del 17 nov 2026, ~14:57 CST,
   buzon-listar, runId 1d36cce9-e5f8-4ff5-809a-3cf7cedd7aed,
   ejecutor ya íntegro en 2.3.1): el diario dice — acceso
   fresco OK («Acceso al portal OK») → «Credenciales
   validadas» → «Sesión reutilizada» → «la sesión reutilizada
   quedó en la página muerta del portal; se descarta»
   (https://wwwmat.sat.gob.mx/app/seg/null) → URL final
   /app/seg/null → fallo ruta-muerta, attempts=1,
   hasDecisionHtml=false; el HTML guardado del fallo son
   156 B («Página no encontrada», sin enlaces ni formularios).
   Es decir: satBrowserLogin devolvió éxito con la página ya
   en la ruta muerta, y el motor lo detectó al entrar. Causa
   en código: tras submitFiel() solo se comprobaban divError,
   Error.aspx y option=credential — /app/seg/null no casa con
   ninguno y el acceso se declaraba bueno sobre la 404.

   Esta suite fija, con dobles guionizadas (sin navegador
   real: el camino probado es el del motor, no el del DOM):
   (P1) FIX-A recuperación: el submit aterriza en
        /app/seg/null y el goto de recuperación aterriza en
        /buzon → login OK con recuperado y el paso en la
        traza; el destino se deriva de la entryUrl con
        «lanzador» y también se respeta la opción landingUrl.
   (P2) FIX-A sin salida: aterrizaje muerto dos veces →
        ruta-muerta honesta con el diag adjunto y UNA sola
        recuperación intentada.
   (P3) FIX-A camino de siempre: aterrizaje normal → ningún
        goto de recuperación y el return EXACTO de hoy.
   (P4) FIX-C Buzón: la sesión heredada muerta produce el
        mensaje nuevo de entrada (nombra /app/seg/null, dice
        que ya estaba muerta antes de navegar y que la sesión
        se descarta para entrar de nuevo con la e.firma) y NO
        afirma ninguna página «de decisión» guardada.
   (P5) FIX-C Declaraciones: su chequeo de entrada
        equivalente (entrarPortalNuevo al recibir la página)
        produce la misma variante honesta.
   (P6) Los sitios de MITAD de paseo conservan el texto de
        siempre (con su «la de decisión»): en Declaraciones
        se ejercita el sitio real tras el clic que mata la
        página; en Buzón se fija por sus sitios de llamada.
   ================================================================ */

const RFC = 'MFI6212158B4';
const URL_NULL = 'https://wwwmat.sat.gob.mx/app/seg/null';
const URL_BUZON = 'https://wwwmat.sat.gob.mx/buzon';
const ENTRY_LANZADOR = 'https://wwwmat.sat.gob.mx/app/seg/faces/pages/lanzador.jsf' +
  '?tipoLogeo=c&target=principal&hostServer=https://wwwmat.sat.gob.mx';
const HTML404 = '<html><head>\n    <title>Página no encontrada</title>\n  </head>\n  <body>\n  <center>      \n\t<h1>Página no encontrada.</h1>\n  </center>   \n  \n\n</body></html>';
assert.equal(Buffer.byteLength(HTML404, 'utf8'), 156, 'la fixture de la 404 es la real de producción: 156 bytes');

const loginArgs = (page, pasos, extra = {}) => ({ cer: Buffer.from('certificado-de-juguete'),
  key: Buffer.from('llave-de-juguete'), password: 'pw-de-juguete', rfc: RFC,
  entryUrl: ENTRY_LANZADOR, hooks: { step: (texto, url) => pasos.push({ texto, url }) }, ...extra });

/* Doble del acceso: el submit aterriza SIEMPRE en la ruta
   muerta (la evidencia de hoy); el goto de recuperación
   aterriza bien o vuelve a la muerta según el guion. */
class LoginMuertaDoble {
  constructor({ recuperacion = 'ok', destinoBueno = URL_BUZON } = {}) {
    this.recuperacion = recuperacion;
    this.destinoBueno = destinoBueno;
    this.currentUrl = 'about:blank';
    this.textoActual = '';
    this.gotos = [];
  }
  url() { return this.currentUrl; }
  async goto(url) {
    this.gotos.push(url);
    if (url === this.destinoBueno) {
      if (this.recuperacion === 'ok') {
        this.currentUrl = url;
        this.textoActual = 'BUZÓN TRIBUTARIO · Mis expedientes';
      } else {
        /* El portal redirige de vuelta a su página muerta. */
        this.currentUrl = URL_NULL;
        this.textoActual = 'Página no encontrada';
      }
      return;
    }
    this.currentUrl = url;
    this.textoActual = 'Acceso por contraseña · e.firma';
  }
  async clickButtonFiel() {}
  async fillFielForm() { return { faltan: [] }; }
  async submitFiel() { this.currentUrl = URL_NULL; this.textoActual = 'Página no encontrada'; }
  async divError() { return ''; }
  async text() { return this.textoActual; }
  async diagnostics() {
    return { url: this.currentUrl, screenshot: null,
      html: this.currentUrl === URL_NULL ? HTML404 : '<html><body>' + this.textoActual + '</body></html>' };
  }
}

/* ===== P1 · Recuperación del aterrizaje muerto ===== */
{
  const page = new LoginMuertaDoble({ recuperacion: 'ok' });
  const pasos = [];
  const result = await satBrowserLogin(page, loginArgs(page, pasos));
  assert.equal(result.recuperado, true, 'el login recuperado lo declara: ' + JSON.stringify(result));
  assert.equal(result.url, URL_BUZON, 'el login devuelve la URL del aterrizaje recuperado');
  assert.deepEqual(page.gotos, [ENTRY_LANZADOR, URL_BUZON],
    'tras el acceso muerto hubo UN goto de recuperación al aterrizaje derivado del lanzador (/buzon): ' +
    page.gotos.join(' | '));
  assert.ok(pasos.some(p => p.texto === 'El portal dejó la entrada en su página muerta; aterrizaje recuperado'),
    'el paso de la recuperación queda en la traza: ' + pasos.map(p => p.texto).join(' | '));
  assert.equal(pasos.find(p => p.texto.includes('aterrizaje recuperado')).url, URL_BUZON,
    'el paso viaja con la URL recuperada');
  console.log('OK 2.3.2-P · P1 — Login: submit a /app/seg/null y goto de recuperación a /buzon → OK con recuperado y paso en la traza.');
}
{
  /* La opción landingUrl manda sobre la derivación: con una
     entryUrl SIN «lanzador», la recuperación va al destino
     dado, no a la entryUrl. */
  const destino = 'https://portal.test/aterrizaje-bueno';
  const page = new LoginMuertaDoble({ recuperacion: 'ok', destinoBueno: destino });
  const pasos = [];
  const result = await satBrowserLogin(page, loginArgs(page, pasos,
    { entryUrl: 'https://loginda.test/acceso', landingUrl: destino }));
  assert.equal(result.recuperado, true);
  assert.equal(result.url, destino);
  assert.deepEqual(page.gotos, ['https://loginda.test/acceso', destino],
    'la recuperación fue a la landingUrl dada: ' + page.gotos.join(' | '));
  console.log('OK 2.3.2-P · P1b — Login: la opción landingUrl manda como destino de la recuperación.');
}

/* ===== P2 · Aterrizaje muerto dos veces → ruta-muerta ===== */
{
  const page = new LoginMuertaDoble({ recuperacion: 'falla' });
  const pasos = [];
  const error = await satBrowserLogin(page, loginArgs(page, pasos)).then(() => null, e => e);
  assert.ok(error instanceof SatDocError, 'el aterrizaje sin salida es un error del motor');
  assert.equal(error.code, 'ruta-muerta', 'se clasifica ruta-muerta, como el motor al entrar');
  assert.ok(error.message.includes('El acceso con e.firma sí entró'),
    'el texto es honesto: el acceso SÍ entró: ' + error.message);
  assert.ok(error.message.includes('/app/seg/null'), 'el texto nombra la página muerta: ' + error.message);
  assert.ok(error.message.includes('ni reintentando el aterrizaje'),
    'el texto cuenta el reintento de aterrizaje: ' + error.message);
  assert.ok(error.diag, 'el error viaja con el diagnóstico adjunto, como los demás fallos de acceso');
  assert.ok(String(error.diag.html).includes('Página no encontrada'),
    'el diag es la página muerta del fallo');
  assert.deepEqual(page.gotos, [ENTRY_LANZADOR, URL_BUZON],
    'la recuperación se intentó UNA sola vez: ' + page.gotos.join(' | '));
  assert.ok(!pasos.some(p => p.texto.includes('aterrizaje recuperado')),
    'sin recuperación no hay paso de recuperación');
  console.log('OK 2.3.2-P · P2 — Login: aterrizaje muerto dos veces → ruta-muerta honesta con diag y un solo reintento.');
}

/* ===== P3 · Aterrizaje normal: el camino de siempre ===== */
{
  class LoginNormalDoble extends LoginMuertaDoble {
    async submitFiel() { this.currentUrl = URL_BUZON; this.textoActual = 'BUZÓN TRIBUTARIO · Mis expedientes'; }
  }
  const page = new LoginNormalDoble();
  const pasos = [];
  const result = await satBrowserLogin(page, loginArgs(page, pasos));
  assert.deepEqual(result, { url: URL_BUZON },
    'el return es EXACTAMENTE el de hoy: { url }, sin recuperado ni claves nuevas');
  assert.deepEqual(page.gotos, [ENTRY_LANZADOR],
    'ningún goto de recuperación: solo la entrada de siempre');
  assert.ok(!pasos.some(p => p.texto.includes('página muerta')),
    'ningún paso nuevo en el camino normal: ' + pasos.map(p => p.texto).join(' | '));
  console.log('OK 2.3.2-P · P3 — Login: aterrizaje normal → sin goto extra, sin pasos nuevos, return como hoy.');
}

/* ===== P4 · FIX-C Buzón: sesión heredada muerta, texto de entrada ===== */
{
  class PaginaMuertaFalsa {
    constructor() { this.currentUrl = URL_NULL; this.gotos = 0; this.clics = 0; }
    url() { return this.currentUrl; }
    async goto() { this.gotos += 1; }
    async text() { return 'Página no encontrada'; }
    async evaluate() { return 'Página no encontrada'; }
    async diagnostics() { return { url: this.currentUrl, html: HTML404, screenshot: null }; }
    async clickText() { this.clics += 1; return false; }
    async clickTextExactoVisible() { this.clics += 1; return false; }
  }
  const page = new PaginaMuertaFalsa();
  const pasos = [];
  const resolverSimple = async (profile) => ({ rfc: profile.rfc, cer: Buffer.from('certificado-de-juguete'),
    key: Buffer.from('llave-de-juguete'), password: 'pw-de-juguete' });
  const trib = createSatTribFetch({ resolveCredentials: resolverSimple,
    launchDriver: async () => { throw new Error('con sesión viva no se lanza navegador'); } });
  const error = await trib({ rfc: RFC }, {}, { sesionViva: { page },
    onStep: (paso, detalle) => pasos.push({ paso, detalle }) }).then(() => null, e => e);
  assert.ok(error instanceof SatDocError);
  assert.equal(error.code, 'ruta-muerta');
  assert.ok(error.message.includes('/app/seg/null'), 'el mensaje nuevo nombra la URL muerta: ' + error.message);
  assert.ok(error.message.includes('ya estaba en la página muerta'),
    'el mensaje dice que la sesión YA estaba muerta: ' + error.message);
  assert.ok(error.message.includes('antes de navegar a ningún sitio'),
    'el mensaje dice que fue antes de navegar a ningún sitio: ' + error.message);
  assert.ok(error.message.includes('no se abrió ninguna notificación'),
    'el mensaje conserva que no se abrió ninguna notificación: ' + error.message);
  assert.ok(error.message.includes('se descarta para entrar de nuevo con la e.firma'),
    'el mensaje dice que la sesión se descarta para entrar de nuevo: ' + error.message);
  assert.ok(!error.message.includes('la de decisión'),
    'el mensaje nuevo NO afirma que una página de decisión quedó guardada (hasDecisionHtml=false en la evidencia): ' +
    error.message);
  assert.ok(pasos.some(p => p.paso === 'la sesión reutilizada quedó en la página muerta del portal; se descarta'),
    'el paso de descarte del diario se conserva');
  assert.equal(page.gotos, 0, 'no se navegó a ningún sitio sobre la página muerta');
  assert.equal(page.clics, 0, 'no se clicó nada sobre la página muerta');
  console.log('OK 2.3.2-P · P4 — Buzón: sesión heredada muerta → mensaje nuevo de entrada, sin «la de decisión».');
}

/* ===== P5 · FIX-C Declaraciones: chequeo de entrada equivalente ===== */
{
  class DeclMuertaEntradaDoble {
    constructor() { this.currentUrl = URL_NULL; this.clics = 0; this.gotos = 0; }
    url() { return this.currentUrl; }
    async goto() { this.gotos += 1; }
    async clickTextSeguro() { this.clics += 1; return false; }
    async clickText() { this.clics += 1; return false; }
    async text() { return 'Página no encontrada'; }
    async diagnostics() { return { url: this.currentUrl, html: HTML404, screenshot: null }; }
  }
  const page = new DeclMuertaEntradaDoble();
  const error = await fetchMensuales({ page, ejercicio: 2026 }).then(() => null, e => e);
  assert.ok(error instanceof SatDocError);
  assert.equal(error.code, 'ruta-muerta', 'la entrada muerta de Declaraciones clasifica ruta-muerta');
  assert.ok(error.message.includes('/app/seg/null'), 'el mensaje nombra la URL muerta: ' + error.message);
  assert.ok(error.message.includes('ya estaba en la página muerta'),
    'el mensaje dice que la página YA estaba muerta al recibirla: ' + error.message);
  assert.ok(error.message.includes('antes de navegar a ningún sitio'),
    'el mensaje dice que fue antes de navegar a ningún sitio: ' + error.message);
  assert.ok(error.message.includes('se descarta para entrar de nuevo con la e.firma'),
    'el mensaje dice que la sesión se descarta para entrar de nuevo: ' + error.message);
  assert.ok(!error.message.includes('la de decisión'),
    'el mensaje nuevo NO afirma ninguna página de decisión guardada: ' + error.message);
  assert.equal(page.clics, 0, 'con la página muerta al entrar no se clica nada');
  assert.equal(page.gotos, 0, 'con la página muerta al entrar no se navega a ningún sitio');
  console.log('OK 2.3.2-P · P5 — Declaraciones: página muerta al recibirla → variante honesta de entrada, cero clics.');
}

/* ===== P6 · Mitad de paseo: el texto de siempre se conserva ===== */
{
  /* Declaraciones, sitio REAL de mitad de paseo: la página
     llega viva a entrarPortalNuevo y el primer clic del salto
     al portal nuevo la mata → fallaRutaMuerta de siempre. */
  class DeclTrampaDoble {
    constructor() {
      this.muerta = false;
      this.currentUrl = 'https://ptscdecprov.clouda.sat.gob.mx/plataforma';
      this.clics = [];
    }
    url() { return this.currentUrl; }
    async goto(url) { this.currentUrl = url; }
    async text() { return this.muerta ? 'Página no encontrada' : 'Declaraciones y Pagos · Servicios Disponibles'; }
    registrar(t) { this.clics.push(t); this.muerta = true; this.currentUrl = URL_NULL; return true; }
    async clickText(t) { return this.registrar(t); }
    async clickTextSeguro(t) { return this.registrar(t); }
    async diagnostics() { return this.muerta
      ? { url: this.currentUrl, html: HTML404, screenshot: null }
      : { url: this.currentUrl, html: '<html><body>plataforma</body></html>', screenshot: null }; }
  }
  const page = new DeclTrampaDoble();
  const error = await fetchMensuales({ page, ejercicio: 2026 }).then(() => null, e => e);
  assert.ok(error instanceof SatDocError);
  assert.equal(error.code, 'ruta-muerta');
  assert.ok(error.message.includes('la de decisión'),
    'a mitad de paseo el texto de siempre SÍ nombra la página de decisión: ' + error.message);
  assert.equal(page.clics.length, 1, 'tras el clic que mató la página no hubo más clics');
  console.log('OK 2.3.2-P · P6a — Declaraciones: muerte a mitad de paseo → texto de siempre, con «la de decisión».');

  /* Buzón: sus dos sitios de mitad de paseo (la espera de la
     bandeja que sale «muerta:») siguen llamando a la falla de
     siempre, y solo el sitio de entrada usa la variante. */
  const trib = readFileSync(new URL('./sat-tributario.mjs', import.meta.url), 'utf8');
  assert.equal((trib.match(/throw buzonFallaRutaMuerta\(espera\.slice/g) || []).length, 2,
    'los dos sitios de mitad de paseo del Buzón conservan buzonFallaRutaMuerta');
  assert.equal((trib.match(/buzonFallaRutaMuertaEntrada\(muertaReutilizada\.url\)/g) || []).length, 1,
    'la variante de entrada se usa en un solo sitio: el chequeo de la sesión reutilizada');
  const decl = readFileSync(new URL('./sat-declaraciones.mjs', import.meta.url), 'utf8');
  assert.equal((decl.match(/fallaRutaMuertaEntrada\(muertaEntrada\.url\)/g) || []).length, 1,
    'en Declaraciones la variante de entrada se usa en un solo sitio: entrarPortalNuevo al recibir la página');
  assert.ok((decl.match(/throw fallaRutaMuerta\(/g) || []).length >= 5,
    'los sitios de mitad de paseo de Declaraciones conservan fallaRutaMuerta');
  console.log('OK 2.3.2-P · P6b — Los sitios de mitad de paseo conservan su falla; la variante de entrada tiene un solo sitio por motor.');
}

/* ================================================================
   P2 · Declaraciones, el último metro (constructor P2, misma
   ronda): evidencia viva del 17 nov 2026 — las corridas
   declaraciones-recuperar 47496edb-5e1f-4f62-b1dc-07c08001f6ed
   y e0af7105-4c4c-4aa8-a773-8dfce3cb0e4a caminaron TODO el
   portal nuevo y cerraron «Resultados leídos: 0 filas»,
   ok:true, 0 documentos y NINGUNA evidencia guardada, cuando
   el mapa real del 16 nov 2026 consta 13 declaraciones de
   Mano Fil en 2026 en ese mismo portal y ejercicio. El
   defecto en código: leerFilasConsulta devolvía [] tanto
   ante el vacío confirmado como al vencer su plazo de 15 s
   sin filas ni marcador, y el llamador lo convertía en ok.
   Esta sección fija los TRES desenlaces y la evidencia en
   toda corrida. Las dobles son del portal nuevo (DyP): el
   plazo real de 60 s se acorta por la costura
   plazoResultadosMs, como el esperaBandejaMs del Buzón.
   ================================================================ */
const PDF_P2 = Buffer.concat([Buffer.from('%PDF-1.4 acuse-p2\n'), Buffer.alloc(1024, 0x2e)]);
const PNG_P2 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0]);
const HTML_RESULTADOS_P2 = '<html><body>Consulta «De la declaración» · tabla de resultados del ejercicio</body></html>';
class DyPDobleP2 {
  constructor({ guionFilas = [[]], textoResultados = '' } = {}) {
    this.guionFilas = guionFilas;
    this.textoResultados = textoResultados;
    this.currentUrl = 'https://ptscdecprov.clouda.sat.gob.mx/plataforma';
    this.lecturas = 0; this.pdfClics = []; this.armed = null; this.selects = {};
  }
  url() { return this.currentUrl; }
  async goto(url) { this.currentUrl = url; }
  async clickTextSeguro(t) {
    return ['Nuevo portal de pagos provisionales', 'Consultas', 'De la declaración'].includes(t);
  }
  async clickText(t) { return this.clickTextSeguro(t); }
  async clickTextExactoVisible() { return false; }
  async text() { return this.textoResultados; }
  async diagnostics() {
    return { url: 'https://pstcdypisr.clouda.sat.gob.mx/Consulta/Consulta?tipoDocumento=1',
      screenshot: PNG_P2, html: HTML_RESULTADOS_P2 };
  }
  async selectSelector(sel, val) { this.selects[sel] = val; }
  async clickSelector() { return true; }
  async portalNuevoResults() {
    const i = Math.min(this.lecturas, this.guionFilas.length - 1);
    this.lecturas += 1;
    return this.guionFilas[i];
  }
  async clickPortalPdf(index) { this.pdfClics.push(index); this.armed = PDF_P2; }
  async waitForPdf() { return this.armed; }
}

/* ===== P7 · La tabla se puebla a la tercera lectura ===== */
{
  const filas = [
    { operacion: '262620100100', fecha: '17/10/2026', tipo: 'Normal', periodo: 'Octubre', pdfIndex: 0 },
    { operacion: '262620100101', fecha: '16/09/2026', tipo: 'Normal', periodo: 'Septiembre', pdfIndex: 1 }];
  const page = new DyPDobleP2({ guionFilas: [[], [], filas] });
  const pasos = [];
  const result = await fetchMensuales({ page, ejercicio: 2026,
    onStep: (paso, detalle) => pasos.push({ paso, detalle }),
    opciones: { plazoResultadosMs: 30_000 } });
  assert.ok(page.lecturas >= 3, 'la lectura esperó hasta la tercera pasada: ' + page.lecturas + ' lecturas');
  assert.equal(result.found, 2, 'la corrida lee las filas reales, no el 0 del plazo viejo');
  assert.equal(result.documents.length, 2, 'descarga el PDF de cada fila');
  assert.deepEqual(page.pdfClics, [0, 1],
    'cada acuse se pidió por el «Generar PDF» de SU fila (pdfIndex en orden): ' + page.pdfClics.join(','));
  assert.ok(result.documents.every(d => d.clase === 'acuse' && d.content.equals(PDF_P2)),
    'cada documento es el acuse (PDF) de su fila');
  assert.deepEqual(result.documents.map(d => d.operacion), ['262620100100', '262620100101']);
  assert.deepEqual(result.documents.map(d => d.periodo), ['2026-10', '2026-09'],
    'el periodo se normaliza desde el nombre del mes');
  const leidos = pasos.find(p => p.paso === 'Resultados leídos');
  assert.ok(leidos && leidos.detalle === '2 filas',
    'el paso «Resultados leídos» dice el número real: ' + (leidos?.detalle || 'sin paso'));
  assert.ok(result.resultadosDiag, 'la corrida buena lleva su evidencia de resultados');
  assert.equal(result.resultadosDiag.html, HTML_RESULTADOS_P2,
    'resultadosDiag es el diagnostics() de la página de resultados');
  assert.ok(Buffer.isBuffer(result.resultadosDiag.screenshot) && result.resultadosDiag.screenshot.equals(PNG_P2),
    'y su captura viaja entera');
  console.log('OK 2.3.2-P2 · P7 — DyP puebla a la tercera lectura → filas leídas, acuse por «Generar PDF» de cada una y evidencia.');
}

/* ===== P8 · «sin resultados»: vacío CONFIRMADO, con evidencia ===== */
{
  const page = new DyPDobleP2({ guionFilas: [[]],
    textoResultados: 'Consulta de la declaración · No se encontraron resultados para el ejercicio' });
  const pasos = [];
  const result = await fetchMensuales({ page, ejercicio: 2026,
    onStep: (paso, detalle) => pasos.push({ paso, detalle }),
    opciones: { plazoResultadosMs: 30_000 } });
  assert.equal(result.found, 0, 'el vacío confirmado es un desenlace bueno con 0');
  assert.equal(result.documents.length, 0);
  assert.ok(result.resultadosDiag && result.resultadosDiag.html === HTML_RESULTADOS_P2,
    'el resultado lleva resultadosDiag: evidencia también en la corrida buena sin filas');
  const leidos = pasos.find(p => p.paso === 'Resultados leídos');
  assert.ok(leidos && leidos.detalle === '0 filas', 'el diario dice 0 filas — las confirmadas');
  console.log('OK 2.3.2-P2 · P8 — Marcador «No se encontraron» → vacío confirmado: ok, 0 documentos y resultadosDiag.');
}

/* ===== P9 · Ni filas ni marcador: NO CONCLUYENTE, jamás ok con 0 ===== */
{
  const page = new DyPDobleP2({ guionFilas: [[]],
    textoResultados: 'Consulta de la declaración · resultados en curso' });
  const pasos = [];
  const error = await fetchMensuales({ page, ejercicio: 2026,
    onStep: (paso, detalle) => pasos.push({ paso, detalle }),
    opciones: { plazoResultadosMs: 3_500 } }).then(() => null, e => e);
  assert.ok(error instanceof SatDocError, 'el desenlace no concluyente es un error del motor, no un ok');
  assert.equal(error.code, 'no-concluyente', 'clase nueva: no-concluyente');
  assert.ok(error.message.includes('no confirmó si hay declaraciones'),
    'el texto dice que el portal no confirmó: ' + error.message);
  assert.ok(error.message.includes('NO cuenta como «0 declaraciones»'),
    'el texto niega el 0: ' + error.message);
  assert.ok(error.message.includes('queda guardada en el diario'),
    'el texto anuncia la página guardada: ' + error.message);
  assert.ok(error.diag, 'el error lleva error.diag con la página de resultados de ese momento');
  assert.equal(error.diag.html, HTML_RESULTADOS_P2, 'el diag es la página de resultados, no otra');
  assert.ok(pasos.some(p => p.paso === 'Esperando los resultados del portal…'),
    'mientras esperaba, el paso de progreso salió: ' + pasos.map(p => p.paso).join(' | '));
  assert.ok(!pasos.some(p => p.paso === 'Resultados leídos'),
    'jamás se escribió un «Resultados leídos» de un desenlace no concluyente');
  console.log('OK 2.3.2-P2 · P9 — Sin filas ni marcador al vencer el plazo → no-concluyente con diag; nunca un ok con 0.');
}

/* ===== P9b · El ejecutor propaga la evidencia con la forma de diagDe ===== */
{
  const wire = resultadosDiagDe({ resultadosDiag: { screenshot: PNG_P2, html: HTML_RESULTADOS_P2,
    url: 'https://pstcdypisr.clouda.sat.gob.mx/Consulta/Consulta?tipoDocumento=1' } });
  assert.deepEqual(wire, { screenshotBase64: PNG_P2.toString('base64'), html: HTML_RESULTADOS_P2,
    url: 'https://pstcdypisr.clouda.sat.gob.mx/Consulta/Consulta?tipoDocumento=1' },
    'la evidencia viaja en base64 con la misma forma que diagDe (foto + HTML + URL)');
  assert.equal(resultadosDiagDe({}), undefined, 'sin resultadosDiag en el motor, el resultado no gana ningún campo');
  assert.equal(resultadosDiagDe({ resultadosDiag: null }), undefined);
  console.log('OK 2.3.2-P2 · P9b — Ejecutor: resultadosDiagDe convierte la evidencia a la forma de diagDe; ausente → sin campo.');
}

/* ===== P10 · Servidor: una corrida BUENA deja hasShot/hasHtml ===== */
{
  const ORIGIN_P2 = 'https://pacosat.test';
  const KEY_P2 = 'p'.repeat(64);
  const OWN_P2 = 'AAA010101AAA';
  const service = createPacoSATService({
    dbFile: ':memory:', html: '<html><head><!--PACOSAT_TOKEN--></head><body>prueba</body></html>',
    origin: ORIGIN_P2, proxyKey: KEY_P2, satDocRetryWaitMs: 5, executorMode: 'remote',
    makeConnector: () => ({ parser: DOMParser, connector: {
      request: async () => 'req-p2', check: async () => ({ status: 'pending', packages: [] }),
      download: async () => { throw new Error('sin paquetes'); } } }),
    makeMailer: () => ({ verify: async () => true, sendMail: async () => ({ messageId: 'm-p2' }) }),
    now: () => Date.parse('2026-11-17T15:00:00Z') });
  let tokenP2 = '';
  const rawP2 = async (method, path, body, extraHeaders = {}) => {
    const chunks = []; if (body !== undefined) chunks.push(Buffer.from(JSON.stringify(body)));
    const req = Readable.from(chunks);
    req.method = method; req.url = path;
    req.headers = { host: 'pacosat.test', origin: ORIGIN_P2, 'x-pacosat-proxy': KEY_P2, ...extraHeaders };
    let status = 0; const headers = {}; let text = '';
    const res = { writeHead(code, hdrs) { status = code; if (hdrs) Object.assign(headers, hdrs); },
      setHeader(k, v) { headers[k] = v; }, getHeader(k) { return headers[k]; },
      end(chunk) { if (chunk) text += Buffer.isBuffer(chunk) ? chunk.toString('latin1') : chunk; } };
    await service.handle(req, res);
    return { status, text, headers };
  };
  const callP2 = async (method, path, body) => {
    if (!tokenP2) { const home = await rawP2('GET', '/'); tokenP2 = /[0-9a-f]{64}/.exec(home.text)?.[0] || ''; }
    const r = await rawP2(method, path, body, { 'x-pacosat-token': tokenP2 });
    let json = null; try { json = JSON.parse(r.text); } catch { /* binario */ }
    return { status: r.status, json, text: r.text };
  };
  const execP2 = async (method, path, body, execToken) => {
    const r = await rawP2(method, path, body, { 'x-pacosat-executor': execToken });
    let json = null; try { json = JSON.parse(r.text); } catch { /* binario */ }
    return { status: r.status, json, text: r.text };
  };
  try {
    const open = await callP2('POST', '/api/unlock', { rfc: OWN_P2, minutes: 1440, days: 7,
      direction: 'both', password: 'simulated', certificate: 'YQ==', key: 'Yg==' });
    assert.equal(open.status, 200, 'unlock de la corrida buena');
    const par = await callP2('POST', '/api/executor/pair', { nombre: 'Equipo P2' });
    assert.equal(par.status, 200);
    const execToken = par.json.token;
    const job = (await callP2('POST', '/api/executor/jobs',
      { rfc: OWN_P2, kind: 'declaraciones-recuperar', payload: { ejercicio: 2026, tipo: 'mensual' } })).json.job;
    assert.ok(job?.id, 'trabajo de declaraciones encolado');
    const claim = await execP2('POST', '/api/executor/claim', { limit: 5 }, execToken);
    assert.ok((claim.json.trabajos || []).some(t => t.id === job.id), 'el ejecutor reclama el trabajo');
    const resDecl = await execP2('POST', '/api/executor/result', { jobId: job.id, status: 'done',
      result: { steps: [{ at: Date.now(), paso: 'Resultados leídos', detalle: '1 fila' }],
        operations: ['entrar-con-efirma', 'consultar-transacciones', 'descargar-pdf'],
        accesoOk: true,
        documents: [{ tipo: 'mensual', clase: 'acuse', ejercicio: 2026, periodo: '2026-10',
          operacion: '123456789012', fechaPresentacion: '2026-11-05',
          contentBase64: PDF_P2.toString('base64') }],
        resultadosDiag: { screenshotBase64: PNG_P2.toString('base64'),
          html: HTML_RESULTADOS_P2, url: 'https://pstcdypisr.clouda.sat.gob.mx/Consulta/Consulta?tipoDocumento=1' } } }, execToken);
    assert.equal(resDecl.json.job.estado, 'hecho', 'la corrida buena se da por hecha: ' + resDecl.text);
    assert.equal(resDecl.json.job.resumen.guardados, 1, 'su acuse verificado se archivó');
    const runs = (await callP2('GET', '/api/declaraciones/runs?rfc=' + OWN_P2)).json;
    const corrida = (runs.runs || runs || [])[0];
    assert.ok(corrida, 'el diario de declaraciones tiene la corrida');
    assert.equal(corrida.ok, true, 'la corrida del diario es buena');
    assert.equal(corrida.hasShot, true, 'P10: la corrida BUENA deja hasShot en su diario');
    assert.equal(corrida.hasHtml, true, 'P10: la corrida BUENA deja hasHtml en su diario');
    const arte = await callP2('GET', '/api/declaraciones/artifact?run=' + corrida.id + '&part=html');
    assert.equal(arte.status, 200, 'el artefacto se sirve por /api/declaraciones/artifact');
    assert.ok(arte.text.includes('tabla de resultados'),
      'el HTML servido es la página de resultados guardada');
  } finally { try { service.close(); } catch { /* ya cerrado */ } }
  console.log('OK 2.3.2-P2 · P10 — Servidor: corrida buena de declaraciones → decl_runs con hasShot/hasHtml y artefacto servido.');
}

/* ===== Estáticas de la ronda ===== */
{
  const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.version, '3.1.0', 'la ronda se queda en 2.3.2 (ronda sin montar)');
  assert.ok(pkg.scripts.test.includes('ronda232paseos.test.mjs'), 'la suite de paseos está en la batería');
  const browser = readFileSync(new URL('./sat-doc-browser.mjs', import.meta.url), 'utf8');
  assert.ok(browser.includes('Verificación de ATERRIZAJE (2.3.2, constructor P'),
    'satBrowserLogin lleva la verificación de aterrizaje con su evidencia');
  assert.ok(browser.includes('https://wwwmat.sat.gob.mx/buzon'),
    'el aterrizaje por defecto tras el lanzador es /buzon, el del mapa vivo del 16 nov 2026');
  console.log('OK 2.3.2-P · estáticas — versión 2.3.2, suite en la batería y aterrizaje /buzon fijado.');
}

console.log('OK suite ronda232paseos completa');
