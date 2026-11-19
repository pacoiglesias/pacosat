import assert from 'node:assert/strict';
import { createSatTribFetch, buzonDiagEsMuerto } from './sat-tributario.mjs';
import { fetchMensuales, esDiagMuerto } from './sat-declaraciones.mjs';
import { SatDocError } from './sat-doc-fetch.mjs';

/* ================================================================
   Ronda 2.3.1 · constructor C — la clasificación de «página
   muerta» se juzga SOLO por la página principal.

   Evidencia (17 nov 2026, verificada contra el sistema real y
   el código): el diagnostics() del driver (sat-doc-browser.mjs)
   devuelve un HTML COMPUESTO — el de la página principal MÁS
   el de cada iframe, concatenados tras el marcador
   «<!-- ===== MARCO (iframe): <url> ===== -->» — y
   paginaMuerta() (sat-declaraciones.mjs) y buzonPaginaMuerta()
   (sat-tributario.mjs) declaraban muerta la página si ese
   compuesto contenía «Página no encontrada», aunque el texto
   viniera de un IFRAME cuyo marco apuntaba él solo a
   /app/seg/null con la principal sana en su aterrizaje. En la
   corrida real de declaraciones de hoy, entre el paso
   «Aterrizaje del portal» y la clasificación «Ruta muerta»
   distaron 140 ms: sin tiempo material para que la principal
   navegara a la ruta muerta. Las dos corridas que SÍ murieron
   de verdad tenían por URL final, la de la principal,
   https://wwwmat.sat.gob.mx/app/seg/null — esa es la señal
   fiable.

   Las dobles copian el patrón de ronda201/ronda230motores:
   páginas guionizadas cuyo diagnostics() compone el HTML como
   el driver real (principal + marco tras su marcador) y cuyo
   text() devuelve solo el de la principal, como el text()
   real (sat-doc-browser.mjs: document.body de la página).
   Ninguna doble abre nada: en el Buzón no hay un solo clic ni
   navegación sobre notificaciones — la regla de no-apertura
   se mantiene también en las pruebas.
   ================================================================ */

const RFC = 'MFI6212158B4';
const URL_NULL = 'https://wwwmat.sat.gob.mx/app/seg/null';
const HTML404 = '<html><head>\n    <title>Página no encontrada</title>\n  </head>\n  <body>\n  <center>      \n\t<h1>Página no encontrada.</h1>\n  </center>   \n  \n\n</body></html>';
assert.equal(Buffer.byteLength(HTML404, 'utf8'), 156, 'la fixture de la 404 es la real de producción: 156 bytes');
/* El HTML compuesto, tal como lo arma diagnostics() del
   driver real: principal, marcador con la URL del marco y el
   HTML del marco. */
const compuesto = (htmlPrincipal, urlMarco, htmlMarco) =>
  htmlPrincipal + '\n<!-- ===== MARCO (iframe): ' + urlMarco + ' ===== -->\n' + htmlMarco;

const resolverSimple = async (profile) => ({ rfc: profile.rfc, cer: Buffer.from('certificado-de-juguete'),
  key: Buffer.from('llave-de-juguete'), password: 'pw-de-juguete' });

/* ===== 1 · Declaraciones: principal sana en su aterrizaje,
   un iframe en la 404 (su URL en /app/seg/null) y el enlace
   del trámite en ningún sitio → el fallo NO es ruta-muerta:
   es el error honesto de enlace no encontrado ===== */
{
  class DeclMarco404Page {
    constructor() {
      this.currentUrl = 'https://ptscdecprov.clouda.sat.gob.mx/plataforma';
      this.clics = []; this.gotos = [];
    }
    url() { return this.currentUrl; }
    async goto(url) { this.gotos.push(url); throw new Error('la doble no navega a la dirección directa'); }
    async clickTextSeguro(t) { this.clics.push(t); return false; }
    async clickText(t) { this.clics.push(t); return false; }
    async text() { return 'Declaraciones y Pagos · plataforma de aterrizaje'; }
    async diagnostics() {
      return { url: this.currentUrl, screenshot: null,
        html: compuesto('<html><body>Declaraciones y Pagos — aterrizaje sano de la principal</body></html>',
          URL_NULL, HTML404),
        frames: [{ url: URL_NULL, html: HTML404 }] };
    }
  }
  const page = new DeclMarco404Page();
  const pasos = [];
  const error = await fetchMensuales({ page, ejercicio: 2026,
    onStep: (paso, detalle) => pasos.push({ paso, detalle }) }).then(() => null, e => e);
  assert.ok(error instanceof SatDocError, 'la corrida cierra en error del motor');
  assert.notEqual(error.code, 'ruta-muerta',
    'un iframe en la 404 NUNCA clasifica la página entera como muerta');
  assert.equal(error.code, 'respuesta-inesperada',
    'sin el enlace del trámite en ningún sitio, el fallo es el honesto de enlace no encontrado');
  assert.ok(error.message.includes('Nuevo portal de pagos provisionales'),
    'el mensaje nombra el salto que no apareció: ' + error.message);
  assert.ok(pasos.some(p => p.paso === 'Portal nuevo de pagos provisionales' && p.detalle === 'no encontrado'),
    'el diario lleva el paso honesto de no encontrado: ' + pasos.map(p => p.paso).join(' | '));
  assert.ok(!pasos.some(p => p.paso === 'Ruta muerta'),
    'ningún paso del diario clasifica la página como muerta');
  assert.ok(page.clics.includes('Nuevo portal de pagos provisionales'),
    'el enlace del trámite se buscó en la principal sana (y no estaba en ningún sitio)');
  console.log('OK 2.3.1-C · 1 — Declaraciones: marco 404 con principal sana → respuesta-inesperada (enlace no encontrado), jamás ruta-muerta.');
}

/* ===== 2 · Declaraciones: la principal SÍ está en
   /app/seg/null → ruta-muerta, como hasta ahora ===== */
{
  class DeclPrincipalMuertaPage {
    constructor() { this.currentUrl = URL_NULL; this.clics = 0; this.gotos = 0; }
    url() { return this.currentUrl; }
    async goto() { this.gotos += 1; }
    async clickTextSeguro() { this.clics += 1; return false; }
    async clickText() { this.clics += 1; return false; }
    async text() { return 'Página no encontrada'; }
    async diagnostics() { return { url: this.currentUrl, screenshot: null, html: HTML404, frames: [] }; }
  }
  const page = new DeclPrincipalMuertaPage();
  const error = await fetchMensuales({ page, ejercicio: 2026 }).then(() => null, e => e);
  assert.ok(error instanceof SatDocError);
  assert.equal(error.code, 'ruta-muerta', 'la principal en /app/seg/null sigue clasificando ruta-muerta');
  assert.ok(error.message.includes('/app/seg/null'), 'el mensaje nombra la URL muerta: ' + error.message);
  assert.equal(page.clics, 0, 'con la principal muerta al entrar no se clica nada');
  assert.equal(page.gotos, 0, 'con la principal muerta al entrar no se navega a ningún sitio');
  console.log('OK 2.3.1-C · 2 — Declaraciones: principal en /app/seg/null → ruta-muerta rápida, sin clics ni navegación.');
}

/* ===== 3 · Buzón: sesión viva con la principal sana pero un
   marco 404 en el diagnóstico compuesto → la corrida NO muere
   en el chequeo de entrada; sigue a la entrada directa de la
   bandeja y lista (bandeja vacía probada + conteos de
   comunicados, sin abrir nada) ===== */
{
  const ENTRY = 'https://wwwmat.sat.gob.mx/iniciar-expediente/mis-notificaciones/';
  const COMUNICADOS = 'https://wwwmat.sat.gob.mx/iniciar-expediente/mis-comunicados/';
  class BuzonVivaMarco404Page {
    constructor() {
      this.etapa = 'aterrizaje';
      this.currentUrl = 'https://wwwmat.sat.gob.mx/buzon';
      this.gotos = []; this.clics = 0;
    }
    url() { return this.currentUrl; }
    async goto(url) {
      this.gotos.push(url); this.currentUrl = url;
      if (String(url).includes('mis-notificaciones')) this.etapa = 'bandeja';
      else if (String(url).includes('mis-comunicados')) this.etapa = 'comunicados';
    }
    textoCompleto() {
      if (this.etapa === 'bandeja')
        return 'Buzón Tributario · Destinatario: ' + RFC +
          ' · Total de notificaciones pendientes: 0 · No se encontraron resultados';
      if (this.etapa === 'comunicados')
        return 'Mis comunicados · Mensajes no leídos (2) · Mensajes leídos (7)';
      return 'BUZÓN TRIBUTARIO · Mis expedientes · Servicios Disponibles';
    }
    async text() { return this.textoCompleto(); }
    async evaluate(fn) {
      if (fn?.name === 'readAllTextSource') return this.textoCompleto();
      if (fn?.name === 'readLinksSource') return [];
      if (fn?.name === 'readTablesSource') return [{ headers: ['Columna', 'Otra'], rows: [['x', 'y']] }];
      return '';
    }
    async diagnostics() {
      const principal = this.etapa === 'bandeja'
        ? '<html><body>Buzón Tributario — bandeja de la principal</body></html>'
        : '<html><body>Buzón Tributario — portada viva de la principal</body></html>';
      return { url: this.currentUrl, screenshot: null,
        html: compuesto(principal, URL_NULL, HTML404),
        frames: [{ url: URL_NULL, html: HTML404 }] };
    }
    async clickTextExactoVisible() { this.clics += 1; return false; }
    async clickText() { this.clics += 1; return false; }
  }
  const page = new BuzonVivaMarco404Page();
  const pasos = [];
  let lanzamientos = 0;
  const trib = createSatTribFetch({ resolveCredentials: resolverSimple,
    launchDriver: async () => { lanzamientos += 1; throw new Error('con sesión viva no se lanza navegador'); },
    entryUrl: ENTRY, comunicadosUrl: COMUNICADOS, esperaBandejaMs: 4_000 });
  const resultado = await trib({ rfc: RFC }, {}, { sesionViva: { page },
    onStep: (paso, detalle) => pasos.push({ paso, detalle }) });
  assert.deepEqual(resultado.notifications, [],
    'la corrida lista: la bandeja vacía probada es un éxito con 0 filas');
  assert.equal(resultado.comunicadosNoLeidos, 2, 'y lee los conteos de comunicados sin abrir ningún mensaje');
  assert.equal(page.gotos[0], ENTRY,
    'superado el chequeo de entrada, la corrida siguió a la entrada directa de la bandeja: ' + page.gotos.join(' | '));
  assert.ok(pasos.some(p => p.paso === 'Sesión reutilizada'), 'la sesión viva se reutilizó');
  assert.ok(pasos.some(p => p.paso === 'Bandeja a la vista'), 'la bandeja llegó a la vista');
  assert.ok(!pasos.some(p => p.paso === 'Ruta muerta' || /página muerta del portal; se descarta/.test(p.paso)),
    'ningún paso clasifica la página como muerta por el marco 404: ' + pasos.map(p => p.paso).join(' | '));
  /* Ajuste 2.9.0 (Bloque A): el pasillo va ahora PRIMERO por el
     camino humano de la cabecera — la doble cuenta 2 intentos
     de clic («Mis expedientes» y «Mis notificaciones»), ambos
     sin respuesta (devuelven false: ningún clic se produjo) — y
     la navegación efectiva sigue siendo la vía directa
     (gotos[0] === ENTRY, arriba). La aserción vieja («ni un
     clic») codificaba el orden anterior del pasillo; la regla
     que se conserva intacta es la de fondo: jamás un clic sobre
     una notificación. */
  /* Ajuste 2.9.1 (Pieza 3): Comunicados sigue el MISMO orden —
     camino humano primero — y suma sus 2 intentos de clic
     («Mis expedientes» y «Mis comunicados»), también sin
     respuesta en esta doble. La cuenta pasa de 2 a 4; la regla
     de fondo no cambia: ningún clic se produjo ni fue jamás
     sobre una notificación ni un comunicado. */
  assert.equal(page.clics, 4, 'el camino humano de la cabecera se intentó primero (2.9.0 bandeja + 2.9.1 comunicados) sin que ningún clic se produjera ni fuera sobre una notificación; la navegación efectiva fue la vía directa');
  assert.equal(lanzamientos, 0, 'no se lanzó navegador: la sesión era la reutilizada');
  console.log('OK 2.3.1-C · 3 — Buzón: sesión viva, principal sana y marco 404 → no muere en la entrada; entra directa a la bandeja y lista.');
}

/* ===== 4 · Buzón: sesión viva con la principal en
   /app/seg/null → ruta-muerta rápida, como hasta ahora ===== */
{
  class BuzonVivaMuertaPage {
    constructor() { this.currentUrl = URL_NULL; this.gotos = 0; this.clics = 0; }
    url() { return this.currentUrl; }
    async goto() { this.gotos += 1; }
    async text() { return 'Página no encontrada'; }
    async evaluate() { return 'Página no encontrada'; }
    async diagnostics() { return { url: this.currentUrl, screenshot: null, html: HTML404, frames: [] }; }
    async clickText() { this.clics += 1; return false; }
    async clickTextExactoVisible() { this.clics += 1; return false; }
  }
  const page = new BuzonVivaMuertaPage();
  const pasos = [];
  const trib = createSatTribFetch({ resolveCredentials: resolverSimple,
    launchDriver: async () => { throw new Error('con sesión viva no se lanza navegador'); } });
  const error = await trib({ rfc: RFC }, {}, { sesionViva: { page },
    onStep: (paso, detalle) => pasos.push({ paso, detalle }) }).then(() => null, e => e);
  assert.ok(error instanceof SatDocError, 'la sesión muerta es un error del motor');
  assert.equal(error.code, 'ruta-muerta', 'la principal en /app/seg/null sigue clasificando ruta-muerta');
  assert.ok(error.message.includes('/app/seg/null'), 'el mensaje nombra la URL muerta: ' + error.message);
  assert.ok(pasos.some(p => p.paso === 'la sesión reutilizada quedó en la página muerta del portal; se descarta'),
    'el diario lleva el paso claro de descarte: ' + pasos.map(p => p.paso).join(' | '));
  assert.equal(page.gotos, 0, 'no se navegó a ningún sitio sobre la página muerta');
  assert.equal(page.clics, 0, 'no se clicó nada sobre la página muerta');
  console.log('OK 2.3.1-C · 4 — Buzón: sesión viva con la principal en /app/seg/null → ruta-muerta rápida y descarte, sin clicar ni navegar.');
}

/* ---------- 5 · La captura DE DECISIÓN se juzga por la principal
   (integración 2.3.1, mejora de camino sobre el hallazgo del
   constructor C): buzonDiagEsMuerto decide qué captura viaja
   como página de decisión en la regla de las dos orillas; con
   el compuesto entero, una portada sana con un marco en la 404
   contaba como «muerta» y la captura buena podía condenarse. */
{
  const compuestoMarco404 = '<html><body>Buzón Tributario de Mano Fil — Mis expedientes</body></html>' +
    '\n<!-- ===== MARCO (iframe): ' + URL_NULL + ' ===== -->\n' + HTML404;
  assert.equal(buzonDiagEsMuerto({ url: 'https://wwwmat.sat.gob.mx/buzon', html: compuestoMarco404 }), false,
    'una principal sana con un marco en la 404 NO es una captura muerta');
  assert.equal(buzonDiagEsMuerto({ url: URL_NULL, html: '<html><body>lo que sea</body></html>' }), true,
    'la URL de la principal en /app/seg/null sigue mandando');
  assert.equal(buzonDiagEsMuerto({ url: 'https://wwwmat.sat.gob.mx/buzon', html: HTML404 }), true,
    'la principal que ES la 404 sigue contando como muerta');
  assert.equal(buzonDiagEsMuerto(null), false, 'sin captura no hay muerte');
  console.log('OK 2.3.1-C · 5 — buzonDiagEsMuerto juzga la captura de decisión por la página principal, no por sus marcos.');
}

/* ---------- 6 · El diente de esDiagMuerto (2.3.2, m-21/D-3):
   gemelo del bloque 5 para Declaraciones. La función vivía
   como clausura interna de createSatDeclFetch y ningún caso
   discriminaba su recorte a la página principal: revertirla
   al HTML compuesto entero dejaba la batería verde. Ahora
   está exportada a nivel de módulo, en paridad con
   buzonDiagEsMuerto, con la lógica sin un token cambiado.
   El caso (a) es el que caza la reversión: sin el recorte en
   el marcador de marco, la 404 del marco haría true y este
   bloque fallaría. */
{
  const compuestoDeclMarco404 = compuesto(
    '<html><body>Declaraciones y Pagos — aterrizaje sano de la principal</body></html>',
    URL_NULL, HTML404);
  assert.equal(esDiagMuerto({ url: 'https://pstcdypisr.clouda.sat.gob.mx/', html: compuestoDeclMarco404 }), false,
    '(a) una principal sana con un marco en la 404 NO es una captura muerta: manda el recorte a la principal');
  assert.equal(esDiagMuerto({ url: 'https://pstcdypisr.clouda.sat.gob.mx/', html: HTML404 }), true,
    '(b) la principal que ES la 404 sí cuenta como muerta');
  assert.equal(esDiagMuerto({ url: URL_NULL, html: '<html><body>lo que sea</body></html>' }), true,
    '(c) la URL en /app/seg/null manda con cualquier html');
  assert.equal(esDiagMuerto(null), false, '(d) sin captura no hay muerte');
  assert.equal(esDiagMuerto({ url: 'https://pstcdypisr.clouda.sat.gob.mx/' }), false,
    '(d) sin html no hay muerte');
  assert.equal(esDiagMuerto({}), false, '(d) un diagnóstico vacío no es una captura muerta');
  console.log('OK 2.3.2-B5 · 6 — esDiagMuerto exportada: su recorte a la principal tiene diente (principal sana + marco 404 → false).');
}

console.log('OK suite ronda231c completa');
