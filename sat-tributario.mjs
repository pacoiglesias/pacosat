/* Consulta del Buzón Tributario del SAT — LISTAR sin abrir
   (ronda 1.24.0, punto 1 de la orden de cierre total).

   QUÉ HACE: con la e.firma del perfil (que nunca sale del
   servidor), entra al portal del SAT por el MISMO cauce de
   constancia, opinión y declaraciones (satBrowserLogin: acceso
   con e.firma en el lanzador de wwwmat.sat.gob.mx), llega a la
   bandeja del Buzón Tributario y devuelve la LISTA de
   notificaciones visibles: fecha, asunto, remitente/dependencia
   y estado.

   REGLA LEGAL DURA: esta corrida NUNCA abre el contenido de una
   notificación. Abrirla puede darla por notificada e iniciar
   plazos legales. Por eso la extracción solo LEE el DOM de la
   bandeja (una evaluación de lectura pura, sin un solo clic
   sobre las notificaciones) y, si la plantilla no enseña la
   lista sin abrir, el motor se detiene y lo dice en el diario:
   mejor no listar que notificar sin querer. Abrir una
   notificación es gesto de Paco en el portal oficial, nunca de
   la máquina.

   PLANTILLA CONOCIDA: el Buzón Tributario presenta su bandeja
   («Mis notificaciones») como una tabla con columnas de fecha,
   asunto, remitente y estado (leída / no leída) tras el acceso
   con e.firma. El extractor reconoce la tabla por sus
   ENCABEZADOS (fecha + asunto + estado), no por selectores
   inventados: si ninguna tabla casa, no se extrae nada y la
   corrida fracasa con la causa — lo no verificable sin el
   portal real queda declarado en el informe de la ronda.

   PUERTA Y BANDEJAS (reconciliado el 11 nov 2026 contra el
   mapa REA del portal, ~/workspace/pacosat-mapa-portal-sat/
   mapa.md §5, levantado de superficies públicas): el minisitio
   de www.sat.gob.mx es solo informativo; la APLICACIÓN vive en
   el PTSC (wwwmat.sat.gob.mx) tras la federación NetIQ, y el
   propio minisitio documenta las rutas oficiales:
   /personas/login/mis-notificaciones («Mis notificaciones»,
   con bandejas Pendientes y Notificados) y
   /personas/login/mis-comunicados («Mis comunicados»). La
   corrida entra DIRECTA a mis-notificaciones tras el acceso y
   lee las dos bandejas: Pendientes ⇒ sin abrir; Notificados ⇒
   abiertas. Entre bandejas se navega por el enlace visible
   «Notificados» (navegación entre LISTAS, jamás un clic sobre
   una notificación). «Mis comunicados» consta en el mapa como
   sección hermana; esta ronda no la lista (queda para cuando
   el diario en vivo confirme su plantilla). La primera puerta
   que se construyó (aplicacion/operacion/53027, el patrón de
   la constancia) quedó sustituida por esta, que es la que el
   SAT documenta para el Buzón.

   Errores como el resto de motores: SatDocError con `kind`
   («respuesta-inesperada» cuando la plantilla no casó — la capa
   de corrida lo reintenta como a constancia y declaraciones — y
   los de credenciales del resolvedor: sin-efirma, caducada…)
   y texto en claro para el diario. */
import { SatDocError } from './sat-doc-fetch.mjs';
import { satBrowserLogin, prepareKeyForPortal } from './sat-doc-browser.mjs';

/* Ruta de la bandeja CONFIRMADA en la página real post-acceso
   (12 nov 2026, diagnóstico de las 21:05): la portada «Portal de
   trámites y servicios» enlaza TODOS los regímenes a
   /iniciar-expediente/mis-notificaciones/. El host se toma del
   lanzador (wwwmat, el de la app); la vía principal no depende
   de esta URL: el flujo sigue el enlace de la propia portada y
   esta queda de repliegue si la portada no trajera candidatos. */
export const BUZON_ENTRY_URL = 'https://wwwmat.sat.gob.mx/iniciar-expediente/mis-notificaciones/';
/* Puerta de ACCESO (1.27.0, bloque C): el acceso con e.firma se
   hace contra el LANZADOR de wwwmat — la puerta cuyo acceso el
   diario vivo de declaraciones probó el 11 nov 2026 («Acceso al
   portal OK») — y la bandeja se alcanza DESPUÉS, ya con la
   sesión abierta, navegando a BUZON_ENTRY_URL. La corrida viva
   del buzón del 11 nov entró directa a mis-notificaciones y
   murió en la clase de error de acceso con e.firma: la
   federación de esa ruta no es la puerta probada. */
export const BUZON_LOGIN_URL = 'https://wwwmat.sat.gob.mx/app/seg/faces/pages/lanzador.jsf?tipoLogeo=c&target=principal&hostServer=https://wwwmat.sat.gob.mx';
export const BUZON_MAX_NOTIFICATIONS = 100;

/* El plazo de una notificación SIN ABRIR (1.27.0, bloque D;
   arts. 134-I y 135 del CFF, según la investigación de la
   ronda): el aviso electrónico da 3 días para abrir la
   notificación; AL CUARTO DÍA se tiene por notificada aunque
   nadie la haya abierto, y sus efectos corren desde el día
   hábil siguiente. No abrir no congela nada: por eso Hoy enseña
   la fecha en que cada notificación se tendrá por notificada.
   Función pura: fecha 'AAAA-MM-DD' → { limite (último día para
   abrirla), tenida (el día en que se tiene por notificada),
   efectos (día hábil siguiente) } en el mismo formato. */
export function buzonPlazo(fecha) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(fecha || ''));
  if (!m) return null;
  const base = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (!Number.isFinite(base)) return null;
  const DAY = 86400000;
  const iso = t => new Date(t).toISOString().slice(0, 10);
  const limite = base + 3 * DAY;
  const tenida = base + 4 * DAY;
  let efectos = tenida + DAY;
  while ([0, 6].includes(new Date(efectos).getUTCDay())) efectos += DAY;
  return { limite: iso(limite), tenida: iso(tenida), efectos: iso(efectos) };
}

const notifyStep = (onStep, paso, detalle = '') => {
  if (typeof onStep !== 'function') return;
  try { onStep(String(paso || ''), String(detalle || '')); } catch { /* el diario nunca tumba la corrida */ }
};
const failure = (kind, message) => new SatDocError(kind, message);

/* Extracción PURA de la lista visible: recibe las tablas leídas
   del DOM (encabezados + filas de celdas). Solo se acepta una
   tabla cuyos encabezados casen con fecha + asunto + estado;
   cada fila se normaliza a { fecha, asunto, remitente, estado,
   abierta }. Nada se pulsa: esto es lectura, no navegación. */
const norm = value => String(value || '').toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
const isFechaHeader = h => /(^|\s)fecha(\s|$)|fecha de|recib|emision/.test(h);
const isAsuntoHeader = h => /asunto|concepto|mensaje|titulo|descripcion/.test(h);
const isRemitenteHeader = h => /remitente|dependencia|emisor|autoridad|area/.test(h);
const isEstadoHeader = h => /estado|estatus|situacion|leida|lectura/.test(h);
const fechaRe = /\b(\d{2})\/(\d{2})\/(\d{4})\b|\b(\d{4})-(\d{2})-(\d{2})\b/;
export function extractBuzonRows(tables, abiertaForzada) {
  for (const table of Array.isArray(tables) ? tables : []) {
    const headers = (table?.headers || []).map(norm);
    if (!headers.length) continue;
    const ci = {
      fecha: headers.findIndex(isFechaHeader),
      asunto: headers.findIndex(isAsuntoHeader),
      remitente: headers.findIndex(isRemitenteHeader),
      estado: headers.findIndex(isEstadoHeader)
    };
    if (ci.fecha < 0 || ci.asunto < 0 || ci.estado < 0) continue;
    const rows = [];
    for (const cells of table.rows || []) {
      const get = i => String(cells?.[i] || '').replace(/\s+/g, ' ').trim();
      const asunto = get(ci.asunto);
      if (!asunto) continue;
      const m = fechaRe.exec(get(ci.fecha));
      const fecha = m ? (m[1] ? `${m[3]}-${m[2]}-${m[1]}` : `${m[4]}-${m[5]}-${m[6]}`) : '';
      const estado = get(ci.estado);
      /* En una bandeja concreta manda la bandeja (Pendientes ⇒
         sin abrir, Notificados ⇒ abierta); sin bandeja, manda
         el texto del estado de cada fila. */
      const abierta = typeof abiertaForzada === 'boolean' ? abiertaForzada
        : !/no leida|sin leer|sin abrir|no abierta|pendiente de lectura|nueva/.test(norm(estado));
      rows.push({ fecha, asunto: asunto.slice(0, 300),
        remitente: ci.remitente >= 0 ? get(ci.remitente).slice(0, 160) : '',
        estado: estado.slice(0, 80), abierta });
      if (rows.length >= BUZON_MAX_NOTIFICATIONS) break;
    }
    return rows;
  }
  return null;
}

/* ¿La página está ya en la bandeja del buzón? Señales del texto
   visible; sin ellas, la navegación no declara éxito. */
export function buzonBandejaVisible(text) {
  const t = norm(text);
  return /buzon tributario/.test(t) &&
    /(mis notificaciones|notificaciones|bandeja)/.test(t) &&
    /(asunto|no leidas|sin leer)/.test(t);
}

/* Los documentos legibles de la página: el principal y los de
   sus marcos DEL MISMO ORIGEN (1.29.2 — la lección de la
   constancia: el trámite puede vivir dentro de un iframe; un
   marco de otro origen no se puede leer y se salta). OJO: cada
   lector de abajo corre SERIALIZADO dentro de la página
   (page.evaluate), así que cada uno lleva su propio colector
   de documentos en línea — no pueden compartir ayudante. */

/* El lector del DOM: devuelve las tablas visibles con sus
   encabezados y celdas — LECTURA PURA, ningún clic. Se evalúa
   una sola vez, ya dentro de la bandeja. */
function readTablesSource() {
  const docs = [document];
  for (const frame of document.querySelectorAll('iframe')) {
    try { if (frame.contentDocument) docs.push(frame.contentDocument); } catch { /* otro origen: no se lee */ }
  }
  const clean = el => String(el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
  const tables = [];
  for (const doc of docs) {
    for (const table of doc.querySelectorAll('table')) {
      const headers = [...table.querySelectorAll('thead th, tr:first-child th')].map(clean);
      const rows = [...table.querySelectorAll('tbody tr, tr')]
        .filter(tr => tr.querySelectorAll('td').length)
        .map(tr => [...tr.querySelectorAll('td')].map(clean));
      if (headers.length && rows.length) tables.push({ headers, rows });
    }
  }
  return tables;
}
/* Los enlaces de la página, leídos (no pulsados), con su
   posición: `inTable` marca los que viven DENTRO de una tabla —
   ahí están las notificaciones, no la navegación, y ningún
   rescate puede seguirlos (H-2.1). Incluye los enlaces de los
   marcos del mismo origen (el menú puede vivir en un marco). */
function readLinksSource() {
  const docs = [document];
  for (const frame of document.querySelectorAll('iframe')) {
    try { if (frame.contentDocument) docs.push(frame.contentDocument); } catch { /* otro origen: no se lee */ }
  }
  const links = [];
  for (const doc of docs) {
    for (const a of doc.querySelectorAll('a[href]')) {
      links.push({
        text: String(a.innerText || a.textContent || '').replace(/\s+/g, ' ').trim(),
        href: a.href || '',
        inTable: Boolean(a.closest && a.closest('table')) });
    }
  }
  return links;
}
/* El texto visible de la página ENTERA (principal + marcos del
   mismo origen): la señal de «bandeja a la vista» no puede
   depender solo del marco principal. */
function readAllTextSource() {
  const docs = [document];
  for (const frame of document.querySelectorAll('iframe')) {
    try { if (frame.contentDocument) docs.push(frame.contentDocument); } catch { /* otro origen: no se lee */ }
  }
  let texto = '';
  for (const doc of docs) {
    texto += '\n' + String(doc?.body?.innerText || doc?.body?.textContent || '');
  }
  return texto;
}

/* El rescate tras el acceso (H-2.1, pasada de seguridad de la
   1.24.0): elegir, entre los enlaces leídos de la página de
   aterrizaje, el ÚNICO destino al que el motor puede navegar
   sin riesgo de abrir una notificación. Reglas duras:
   - un enlace DENTRO de una tabla jamás se sigue;
   - un destino con pinta de detalle (folio, id, ver, detalle:
     en la ruta, en un segmento o en los parámetros) jamás se
     sigue — la pinta de detalle manda sobre cualquier otra
     señal, incluida una ruta de lista;
   - solo vale un destino que sea una RUTA DE LISTA conocida
     (mis-notificaciones / mis-comunicados / buzon-tributario)
     o cuya etiqueta sea, exacta, la de un menú o pestaña de
     bandeja.
   Sin candidato seguro devuelve null: la corrida muere con
   «respuesta-inesperada» en el diario, sin navegar.
   (1.29.2: sobre estas exclusiones — que no se tocan — la
   ELECCIÓN entre destinos seguros pasa a ser por puntuación
   de patrones, ver buzonRescueScore; y el error final lleva
   el inventario de textos de enlace de la página.) */
/* Las exclusiones duras de navegación del buzón, compartidas
   por el rescate (H-2.1) y por el salto a la segunda bandeja
   (H-4.1, pasada de la 1.27.0): devuelve la ruta troceada si
   el enlace PUEDE navegarse sin riesgo de abrir una
   notificación, o null si queda excluido — dentro de una
   tabla, sin destino http(s), o con pinta de detalle (folio,
   id, ver, detalle: en la ruta, en un segmento o en los
   parámetros; la pinta de detalle manda sobre cualquier otra
   señal, incluida una ruta de lista). */
function buzonLinkSafeParts(link) {
  if (!link || link.inTable) return null;
  const href = String(link.href || '');
  if (!/^https?:/i.test(href)) return null;
  let path = '', query = '';
  try {
    const url = new URL(href);
    path = norm(decodeURIComponent(url.pathname || ''));
    query = norm(decodeURIComponent(url.search || ''));
  } catch { return null; }
  if (/folio|detalle|detail|uuid/.test(path + ' ' + query)) return null;
  if (/[?&](id|clave|ver)=/.test(query)) return null;
  const segments = path.split('/').filter(Boolean);
  if (segments.some(seg => seg === 'ver' || seg.startsWith('ver-') || seg.startsWith('ver_') ||
      /^\d{5,}$/.test(seg) || /^[0-9a-f]{16,}$/.test(seg))) return null;
  return { path, query, segments };
}

/* La elección del rescate por PUNTUACIÓN de patrones (1.29.2,
   sobre las exclusiones duras de H-2.1, que mandan primero:
   sin partes seguras no hay puntos). La corrida viva del
   12 nov a las 20:00 entró al portal y la bandeja no apareció
   tras el salto directo: la página de aterrizaje es inestable
   y su menú no siempre pinta la etiqueta esperada, así que un
   único criterio (ruta conocida O etiqueta exacta, en orden
   de documento) se queda corto. Ahora los patrones se refuerzan
   entre sí y el rescate prueba los mejores candidatos en orden:
   - ruta de lista conocida en los segmentos: +100;
   - etiqueta exacta de sección («buzón tributario», «mis
     notificaciones», «mis comunicados»): +80;
   - etiqueta exacta de bandeja («bandeja», «bandeja de
     entrada», «notificaciones»): +70;
   - la ruta nombra la bandeja (notificacion/bandeja/buzon/
     mensajes/comunicados en un segmento): +35;
   - la etiqueta contiene «bandeja»: +25; contiene
     «notificaciones»: +15; contiene «mensajes» o
     «comunicados»: +15.
   Umbral: 40. La etiqueta parecida SOLA no basta jamás (pin
   de la 1.24.0: «Notificaciones recientes» hacia /inicio suma
   15 y no se sigue): hace falta la exactitud o que la ruta la
   corrobore — la regla legal no se relaja, se ordena mejor. */
export const BUZON_RESCATE_MINIMO = 40;
export function buzonRescueScore(link) {
  const parts = buzonLinkSafeParts(link);
  if (!parts) return 0;
  const label = norm(link.text || '');
  let puntos = 0;
  if (['mis-notificaciones', 'mis-comunicados', 'buzon-tributario']
    .some(route => parts.segments.includes(route))) puntos += 100;
  if (['buzon tributario', 'mis notificaciones', 'mis comunicados'].includes(label)) puntos += 80;
  /* Desempate de la portada real (12 nov): todos los regímenes
     llevan a la MISMA ruta mis-notificaciones; «General de ley»
     es el régimen de la persona moral probada en vivo (Mano
     Fil), así que su enlace va primero entre los empatados. */
  if (label === 'general de ley') puntos += 10;
  if (['bandeja', 'bandeja de entrada', 'notificaciones'].includes(label)) puntos += 70;
  if (parts.segments.some(seg => /notificacion|bandeja|buzon|mensajes|comunicados/.test(seg))) puntos += 35;
  if (/bandeja/.test(label)) puntos += 25;
  if (/notificaciones/.test(label)) puntos += 15;
  if (/mensajes|comunicados/.test(label)) puntos += 15;
  return puntos;
}
export function buzonRescueCandidates(links) {
  const porHref = new Map();
  for (const c of (Array.isArray(links) ? links : [])
    .map((link, orden) => ({ link, orden, puntos: buzonRescueScore(link) }))
    .filter(c => c.puntos >= BUZON_RESCATE_MINIMO)) {
    /* Dedupe por destino (12 nov): en la portada real, once
       regímenes comparten el MISMO href — probar el mismo
       destino tres veces no prueba nada. Por href manda el de
       más puntos (y a igualdad, el primero del DOM). */
    const clave = String(c.link?.href || '');
    if (!clave) continue;
    const previo = porHref.get(clave);
    if (!previo || c.puntos > previo.puntos) porHref.set(clave, c);
  }
  return [...porHref.values()]
    .sort((a, b) => b.puntos - a.puntos || a.orden - b.orden)
    .map(c => c.link);
}
export function pickBuzonRescueLink(links) {
  return buzonRescueCandidates(links)[0] || null;
}

/* El inventario que viaja en el error cuando ningún candidato
   lleva a la bandeja (1.29.2): SOLO textos de enlaces fuera de
   tablas — las notificaciones viven en tablas y sus textos no
   salen —, sin hrefs (una URL puede llevar tokens de sesión),
   deduplicados, acotados en número y en largo. Es la sonda que
   deja el diagnóstico en un solo paso si la plantilla real del
   portal difiere de la réplica de la ronda. */
export function buzonInventarioTextos(links, max = 25) {
  const vistos = new Set();
  const textos = [];
  for (const link of Array.isArray(links) ? links : []) {
    if (!link || link.inTable) continue;
    const texto = String(link.text || '').replace(/\s+/g, ' ').trim().slice(0, 48);
    if (!texto || vistos.has(texto)) continue;
    vistos.add(texto);
    textos.push(texto);
    if (textos.length >= max) break;
  }
  return textos;
}

/* El salto a la bandeja «Notificados» (H-4.1, pasada de la
   1.27.0): pasa por las MISMAS exclusiones que el rescate —
   antes valía el primer enlace cuyo texto contuviera
   «notificados», y un enlace de detalle con esa palabra en el
   asunto (p. ej. «…actos notificados…») delante de la pestaña
   se habría navegado: cargar el detalle de una notificación
   es, a los ojos del SAT, abrirla. Solo vale la pestaña por
   su etiqueta exacta «Notificados», o la ruta de lista de la
   bandeja con su tramo de «notificados» cuando la etiqueta
   también la nombra. Sin candidato seguro devuelve null y la
   corrida lista solo «Pendientes». */
export function pickBuzonNotificadosLink(links) {
  for (const link of Array.isArray(links) ? links : []) {
    const parts = buzonLinkSafeParts(link);
    if (!parts) continue;
    const label = norm(link.text || '');
    if (label === 'notificados') return link;
    if (parts.segments.includes('notificados') && /notificados/.test(label)) return link;
  }
  return null;
}

const sleepMs = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/* Espera de estabilidad de la página (1.29.2): tras el acceso
   y tras cada navegación, la página del portal puede seguir
   cargando o federando — la corrida viva del 12 nov a las
   20:00 entró («Acceso al portal OK») y la bandeja no estaba
   en la primera lectura. Se sondea el texto visible hasta que
   dos lecturas seguidas coinciden y no son la página vacía, o
   vence el plazo; sin lector de texto no hay espera. */
async function esperaPaginaEstable(leerTexto, { plazoMs = 8000, intervaloMs = 400 } = {}) {
  if (typeof leerTexto !== 'function') return;
  const limite = Date.now() + plazoMs;
  let anterior = null;
  while (Date.now() < limite) {
    const actual = await leerTexto().catch(() => '');
    if (anterior !== null && actual === anterior && actual.trim()) return;
    anterior = actual;
    await sleepMs(intervaloMs);
  }
}

/* Fábrica del motor, gemela de createSatDeclFetch: valida las
   credenciales ANTES de abrir el navegador, serializa las
   corridas (una sesión de portal cada vez) y acepta el diario
   por corrida en el tercer argumento { onStep }. */
export function createSatTribFetch({ resolveCredentials, launchDriver,
  entryUrl = BUZON_ENTRY_URL, loginUrl = BUZON_LOGIN_URL } = {}) {
  let chain = Promise.resolve();
  const run = async (profile, _query, options = {}) => {
    const step = typeof options?.onStep === 'function' ? options.onStep : null;
    const creds = await resolveCredentials(profile); // valida ANTES de abrir el navegador
    if (!creds) throw failure('sin-efirma', 'No hay e.firma guardada para ' + String(profile?.rfc || '') +
      ': sin ella no se puede consultar el Buzón Tributario.');
    notifyStep(step, 'Credenciales validadas', String(profile?.rfc || ''));
    /* Sesión viva (1.30.0): el ejecutor puede entregar la página
       YA abierta de este RFC (options.sesionViva.page) — la
       puerta se firmó una sola vez para la tanda y aquí no se
       lanza navegador ni se vuelve a entrar; el ciclo de vida
       de esa página es del ejecutor, que la cierra al caducar.
       Sin sesión viva, el camino es el de siempre, intacto. */
    const paginaViva = options?.sesionViva?.page || null;
    let driver = null;
    if (!paginaViva) {
      try {
        driver = await launchDriver();
      } catch (error) {
        if (error instanceof SatDocError) throw error;
        throw failure('navegador-no-disponible', 'El navegador interno de PacoSAT no pudo arrancar ' +
          'en el servidor (' + (error?.message || error) + ').');
      }
      notifyStep(step, 'Navegador listo', '');
    }
    let page = null;
    /* Diagnóstico DE DECISIÓN (1.31.0): la foto de la página
       en el momento en que la corrida DECIDIÓ a dónde navegar
       — la portada tras el acceso, refrescada antes de seguir
       cada candidato —. Si la corrida muere en la 404 genérica
       del SAT (154 B, «Página no encontrada»), su diagnóstico
       no dice nada del portal real; el que viaja es este, que
       lleva la URL de la página cuyos enlaces se inventariaron. */
    let diagDecision = null;
    try {
      if (paginaViva) {
        page = paginaViva;
        notifyStep(step, 'Sesión reutilizada', 'la puerta ya estaba abierta para este RFC: no se vuelve a firmar');
      } else {
      page = await driver.newPage();
      const keyMaterial = prepareKeyForPortal(creds.key, creds.password);
      /* El acceso va por el lanzador (la puerta probada en vivo)
         y la bandeja se alcanza después con la sesión abierta;
         entrar directo a la bandeja murió en el acceso en la
         corrida viva del 11 nov 2026. */
      await satBrowserLogin(page, { cer: creds.cer, key: keyMaterial.buffer,
        password: creds.password, rfc: creds.rfc, entryUrl: loginUrl,
        hooks: { step: text => notifyStep(step, 'Acceso: ' + text) } });
      notifyStep(step, 'Acceso al portal OK', '');
      }
      /* El texto de la página ENTERA (principal + marcos del
         mismo origen): las dobles de prueba sin evaluate caen
         al text() de siempre. */
      const leerTexto = async () => {
        if (typeof page.evaluate === 'function') {
          const completo = await page.evaluate(readAllTextSource).catch(() => '');
          if (typeof completo === 'string' && completo.trim()) return completo;
        }
        return page.text();
      };
      notifyStep(step, 'Voy a la bandeja del Buzón', 'con la sesión ya abierta, sin abrir ninguna notificación');
      /* Foto de decisión (1.31.0): captura el diagnóstico de la
         página TAL COMO ESTÁ cuando se va a decidir el siguiente
         salto. Sin diagnostics() no se rompe nada: queda null y
         el catch conserva el comportamiento de siempre. */
      const capturarDiagDecision = async () => {
        if (!page || typeof page.diagnostics !== 'function') return;
        try {
          const diag = await page.diagnostics();
          if (diag) diagDecision = diag;
        } catch { /* el diagnóstico nunca tumba la corrida */ }
      };
      /* Hasta la bandeja SIN tocar ninguna notificación
         (rehecho 1.29.2 con la página REAL post-acceso, guardada
         por el diario y confirmada por el diagnóstico del NAS
         del 12 nov a las 21:05): tras el «Acceso OK» el portal
         aterriza en su portada «Portal de trámites y servicios»
         — SIN lista alguna —, con los enlaces de régimen que
         llevan a /iniciar-expediente/mis-notificaciones/ y un
         iframe lanzador. La bandeja NO está en la portada: se
         llega siguiendo SU enlace. Orden: (1) esperar a que la
         portada se estabilice; (2) si ya es la bandeja, leer;
         (3) si no, probar los candidatos del inventario de la
         PROPIA portada por puntuación (buzonRescueCandidates,
         con las exclusiones duras de H-2.1 y dedupe por href),
         hasta tres destinos distintos; (4) de repliegue, la
         ruta directa mis-notificaciones y sus propios
         candidatos. «Ser la bandeja» se acepta por el texto O
         por una tabla de notificaciones reconocible — la ruta
         confirmada manda sobre la plantilla del titular —. Si
         nada lleva, el error lleva el INVENTARIO de textos de
         enlace de la última página inventariada.
         PASO PRIMARIO (1.31.0, evidencia viva del 13 nov 2026):
         la portada NUEVA ya no es la de trámites y servicios:
         tras el acceso el portal aterriza en la PROPIA portada
         del Buzón, cuyos enlaces son «Buzón Tributario de Mano
         Fil · Mis documentos · Mis notificaciones · Mis
         comunicados · Servicios Disponibles · Cerrar sesión ·
         Buzón Tributario de MFI6212158B4». La bandeja se alcanza
         por «Mis notificaciones»: si en la portada hay un enlace
         de etiqueta EXACTA con ese texto que pase las
         exclusiones duras (buzonLinkSafeParts, sin relajar
         ninguna), se navega a su href ANTES que al rescate por
         puntuación — la puntuación y la ruta directa quedan
         como rescate y último recurso, no como camino. */
      await esperaPaginaEstable(leerTexto);
      await capturarDiagDecision();
      const tablasReconocibles = async () => {
        if (typeof page.evaluate !== 'function') return false;
        const tablas = await page.evaluate(readTablesSource).catch(() => null);
        return tablas ? extractBuzonRows(tablas, false) !== null : false;
      };
      const esBandeja = async () => buzonBandejaVisible(await leerTexto()) || await tablasReconocibles();
      /* En la PORTADA solo manda el texto: la página real no
         trae ninguna lista, y no se lee ninguna tabla de la
         página de aterrizaje — las tablas solo acreditan la
         bandeja tras navegar a un candidato o a la ruta. */
      let enBandeja = buzonBandejaVisible(await leerTexto());
      let ultimosLinks = [];
      if (!enBandeja) {
        notifyStep(step, 'Busco la bandeja', 'sigo el enlace de notificaciones de la propia portada, sin abrir ninguna');
        const aterrizaje = typeof page.url === 'function' ? page.url() : '';
        const probarCandidatos = async (links, tope) => {
          for (const target of buzonRescueCandidates(links).slice(0, tope)) {
            if (!target?.href) continue;
            /* La página cuyos enlaces se acaban de inventariar
               es la que manda en la foto de decisión: se
               refresca ANTES de seguir cada candidato, no
               después de aterrizar en su destino. */
            await capturarDiagDecision();
            await page.goto(target.href).catch(() => {});
            await esperaPaginaEstable(leerTexto);
            if (await esBandeja()) return true;
            if (aterrizaje && typeof page.url === 'function' && page.url() !== aterrizaje) {
              await page.goto(aterrizaje).catch(() => {});
              await esperaPaginaEstable(leerTexto);
            }
          }
          return false;
        };
        ultimosLinks = await page.evaluate(readLinksSource).catch(() => []);
        /* Paso PRIMARIO (1.31.0): etiqueta exacta «Mis
           notificaciones» + exclusiones duras intactas. Ni un
           enlace dentro de tabla ni uno con pinta de detalle
           puede ser este: buzonLinkSafeParts devuelve null
           para ambos y aquí no se sigue. */
        const enlaceMisNotificaciones = (Array.isArray(ultimosLinks) ? ultimosLinks : [])
          .find(link => norm(link?.text || '') === 'mis notificaciones' && buzonLinkSafeParts(link));
        if (enlaceMisNotificaciones?.href) {
          notifyStep(step, 'Sigo «Mis notificaciones»', 'enlace exacto de la portada del Buzón: voy a su bandeja sin abrir ninguna notificación');
          await capturarDiagDecision();
          await page.goto(enlaceMisNotificaciones.href).catch(() => {});
          await esperaPaginaEstable(leerTexto);
          enBandeja = await esBandeja();
        }
        if (!enBandeja) enBandeja = await probarCandidatos(ultimosLinks, 3);
        if (!enBandeja && entryUrl && typeof page.goto === 'function' &&
          (typeof page.url !== 'function' || page.url() !== entryUrl)) {
          await page.goto(entryUrl).catch(() => {});
          await esperaPaginaEstable(leerTexto);
          enBandeja = await esBandeja();
          if (!enBandeja) {
            const linksRuta = await page.evaluate(readLinksSource).catch(() => []);
            if (linksRuta.length) ultimosLinks = linksRuta;
            enBandeja = await probarCandidatos(linksRuta, 2);
          }
        }
        if (!enBandeja) {
          const inventario = buzonInventarioTextos(ultimosLinks);
          throw failure('respuesta-inesperada', 'El portal no enseñó la bandeja del Buzón Tributario tras el acceso ' +
            'con e.firma. ' +
            (inventario.length
              ? 'La página enseñaba estos enlaces (solo textos): ' + inventario.join(' · ') + '. '
              : 'La página no enseñaba ningún enlace fuera de tablas. ') +
            'No se abrió ninguna notificación.');
        }
      }
      notifyStep(step, 'Bandeja a la vista', 'leo las listas sin abrir ninguna notificación');
      /* Bandeja de aterrizaje = «Pendientes» según el mapa:
         todo lo que enseña está sin abrir. */
      const claveDe = row => [row.fecha || '', norm(row.asunto), norm(row.remitente)].join('|');
      const vistas = new Map();
      const tablasEntrada = await page.evaluate(readTablesSource);
      const pendientes = extractBuzonRows(tablasEntrada, false);
      if (!pendientes)
        throw failure('respuesta-inesperada', 'La bandeja no enseñó una tabla de notificaciones reconocible ' +
          '(fecha, asunto y estado): no se lista nada antes que arriesgar una apertura.');
      for (const row of pendientes) vistas.set(claveDe(row), row);
      notifyStep(step, 'Bandeja «Pendientes» leída', pendientes.length + ' sin abrir');
      /* Segunda bandeja: «Notificados» (ya abiertas). Se llega
         por su enlace visible — navegación entre listas, nunca
         un clic sobre una notificación — elegido con las
         exclusiones del rescate (pickBuzonNotificadosLink,
         H-4.1): fuera enlaces dentro de tabla y destinos con
         pinta de detalle, aunque su texto nombre la bandeja.
         Y lo que no case con la plantilla no tumba la corrida:
         queda lo ya leído. */
      try {
        const links = await page.evaluate(readLinksSource);
        const notificados = pickBuzonNotificadosLink(links);
        if (notificados?.href) {
          await page.goto(notificados.href);
          const tablasNotif = await page.evaluate(readTablesSource);
          const abiertas = extractBuzonRows(tablasNotif, true);
          if (abiertas) {
            let nuevas = 0;
            for (const row of abiertas) {
              if (!vistas.has(claveDe(row))) { vistas.set(claveDe(row), row); nuevas += 1; }
            }
            notifyStep(step, 'Bandeja «Notificados» leída', abiertas.length + ' abiertas (' + nuevas + ' nuevas en la lista)');
          } else {
            notifyStep(step, 'Bandeja «Notificados» sin tabla reconocible', 'se conserva lo leído en «Pendientes»');
          }
        } else {
          notifyStep(step, 'Sin enlace visible a «Notificados»', 'se lista la bandeja de aterrizaje');
        }
      } catch (error) {
        notifyStep(step, 'La segunda bandeja no se pudo leer', String(error?.message || error).slice(0, 140) + ' — se conserva lo leído en «Pendientes»');
      }
      const rows = [...vistas.values()].slice(0, BUZON_MAX_NOTIFICATIONS);
      notifyStep(step, 'Lista leída', rows.length + ' notificación(es) entre las dos bandejas');
      return { notifications: rows };
    } catch (error) {
      /* Diario con la página guardada (1.27.0, bloque C): el
         error viaja con la foto y el HTML del momento — la
         corrida viva del 11 nov murió en el acceso sin dejar
         la página, y ese fallo quedó ciego.
         Artefacto de decisión (1.31.0): si la página FINAL es
         la 404 genérica del SAT («Página no encontrada», sus
         154 B no nombran ni la portada ni sus enlaces), viaja
         en su lugar el diagnóstico DE DECISIÓN — la portada o
         la página cuyos enlaces se inventariaron, con su URL
         —, que es el que permite saber desde dónde se saltó.
         Sin diagnóstico de decisión se conserva el actual. */
      /* Doble artefacto (1.32.1): como en Declaraciones, viajan
         las DOS páginas — la final en `diag` y la de decisión
         en `diagDecision` — sin sustituir una por otra. */
      if (page && typeof page.diagnostics === 'function' && error && typeof error === 'object' && !error.diag) {
        try {
          const actual = await page.diagnostics();
          if (actual) error.diag = actual;
        } catch { /* sin diagnóstico final no se rompe nada: el error manda */ }
      }
      if (error && typeof error === 'object' && diagDecision && !error.diagDecision)
        error.diagDecision = diagDecision;
      throw error;
    } finally {
      /* Con sesión viva la página NO se cierra: es del ejecutor
         y la siguiente corrida de la tanda la reutiliza. */
      if (!paginaViva && driver) await driver.close().catch(() => {});
    }
  };
  return (profile, query, options = {}) => {
    const result = chain.then(() => run(profile, query, options));
    chain = result.catch(() => {});
    return result;
  };
}
