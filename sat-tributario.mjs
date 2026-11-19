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
      if (buzonFilaEsMarcadorVacio(cells) || buzonAsuntoEsCabecera(asunto)) continue;
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
   de documentos en línea — no pueden compartir ayudante.
   (2.9.0, Bloque A: estos mismos lectores se evalúan además
   DENTRO de cada marco vía page.evaluateFrames — ver los
   lectores por marcos de createSatTribFetch — y ahí el
   «documento principal» de cada evaluación es el propio
   marco, incluido el de otro origen que desde la página
   madre era invisible.) */

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

/* ¿Una captura de diagnóstico ES la página muerta del portal?
   (2.0.1): su URL es la ruta degenerada /app/seg/null o su HTML
   es la 404 genérica estática del SAT («Página no encontrada»,
   156 B en producción, la misma en todas las corridas muertas
   del 16 nov 2026).
   Corrección 2.3.1 (17 nov 2026, misma evidencia que
   buzonPaginaMuerta): el HTML del diagnóstico es COMPUESTO
   (principal + marcos tras el marcador de marco) y esta
   función decide qué captura viaja como página DE DECISIÓN
   en la regla de las dos orillas — juzgarla por el compuesto
   entero trataba como «muerta» una portada sana con un marco
   en la 404 y podía condenar la captura buena. Se juzga la
   principal: su URL o su HTML recortado en el primer marco. */
export function buzonDiagEsMuerto(diag) {
  if (!diag) return false;
  if (/\/app\/seg\/null/.test(String(diag.url || ''))) return true;
  if (typeof diag.html !== 'string') return false;
  const corte = diag.html.indexOf('<!-- ===== MARCO (iframe):');
  const htmlPrincipal = corte >= 0 ? diag.html.slice(0, corte) : diag.html;
  return /Página no encontrada/i.test(htmlPrincipal);
}
/* ¿La página ACTUAL es la página muerta del portal? Por su URL
   (/app/seg/null), por su diagnóstico o por su texto visible,
   con guardas: una doble sin diagnostics()/text() no clasifica
   nada que su URL no diga.
   Corrección 2.3.1 (17 nov 2026, misma evidencia que en
   Declaraciones): el diagnóstico del driver es un HTML
   COMPUESTO (página principal + cada iframe tras el marcador
   «<!-- ===== MARCO (iframe): <url> ===== -->»), y buscar
   «Página no encontrada» en el compuesto entero declaraba
   muerta la página entera por la 404 de UN marco, con la
   principal sana. Desde esta ronda el HTML del diagnóstico
   se RECORTA en el primer marcador de marco y solo manda el
   de la página principal, igual que su URL (page.url() o la
   del diagnóstico en /app/seg/null); el text() del driver
   real solo lee el body de la principal, no es compuesto.
   Que un iframe esté en la 404 NUNCA clasifica la página
   entera como muerta. */
async function buzonPaginaMuerta(page) {
  try {
    let url = '';
    if (page && typeof page.url === 'function') {
      try { url = String(page.url() || ''); } catch { /* página en transición */ }
    }
    if (url && /\/app\/seg\/null/.test(url)) return { muerta: true, url };
    if (page && typeof page.diagnostics === 'function') {
      const d = await page.diagnostics().catch(() => null);
      if (d) {
        const du = String(d.url || '');
        if (/\/app\/seg\/null/.test(du)) return { muerta: true, url: du || url };
        const compuesto = typeof d.html === 'string' ? d.html : '';
        const corte = compuesto.indexOf('<!-- ===== MARCO (iframe):');
        const htmlPrincipal = corte >= 0 ? compuesto.slice(0, corte) : compuesto;
        if (htmlPrincipal && /Página no encontrada/i.test(htmlPrincipal))
          return { muerta: true, url: du || url };
        if (du) url = du;
      }
    }
    if (page && typeof page.text === 'function') {
      const t = await page.text().catch(() => '');
      if (typeof t === 'string' && /Página no encontrada/i.test(t)) return { muerta: true, url };
    }
  } catch { /* la detección nunca tumba la corrida */ }
  return { muerta: false, url: '' };
}
function buzonFallaRutaMuerta(url) {
  return failure('ruta-muerta',
    'El portal devolvió «Página no encontrada» en la dirección ' + (url || '(sin dirección legible)') +
    ': esa ruta del portal ya no responde. La página desde la que se navegó (la de decisión) y la ' +
    'final quedan guardadas en el diario de la corrida. No se abrió ninguna notificación.');
}
/* Variante de ENTRADA de la ruta muerta (2.3.2, constructor
   P — evidencia viva del 17 nov 2026, corrida buzon-listar
   runId 1d36cce9-e5f8-4ff5-809a-3cf7cedd7aed): SOLO para el
   chequeo de la sesión reutilizada al entrar (el sitio que
   llama a esta función nada más recibir la página viva). Ahí
   la sesión YA estaba en la página muerta ANTES de navegar a
   ningún sitio: no hubo página desde la que se navegara y,
   en esa corrida, hasDecisionHtml=false — afirmar que «la
   página desde la que se navegó (la de decisión) y la final
   quedan guardadas» era FALSO en este sitio. El texto de
   entrada dice solo lo probado: la sesión ya estaba muerta,
   no se abrió ninguna notificación y la sesión se descarta
   para entrar de nuevo con la e.firma. Los sitios de mitad
   de paseo conservan buzonFallaRutaMuerta tal cual. */
function buzonFallaRutaMuertaEntrada(url) {
  return failure('ruta-muerta',
    'La sesión reutilizada ya estaba en la página muerta del portal («Página no encontrada», ' +
    (url || '(sin dirección legible)') + ') antes de navegar a ningún sitio: no se abrió ninguna ' +
    'notificación y la sesión se descarta para entrar de nuevo con la e.firma.');
}

/* ================================================================
   MAPA REAL DEL PORTAL (levantado en sesión viva el 16 nov 2026,
   15:35–15:48, con la e.firma de Paco en su Chrome — sustituye
   al mapa inferido de artefactos):
   - Tras el acceso, el aterrizaje es https://wwwmat.sat.gob.mx/buzon
     («BUZÓN TRIBUTARIO») con el cuerpo principal EN BLANCO: la
     navegación vive en la CABECERA (botón «Mis expedientes» que
     despliega «Mis documentos», «Mis notificaciones», «Mis
     comunicados»; también «Servicios Disponibles» y «Cerrar
     sesión»). Por eso el buscador viejo no encontraba destino:
     buscaba en una portada vacía y el inventario de enlaces que
     leía venía de la cabecera/nav.
   - «Mis notificaciones» = /iniciar-expediente/mis-notificaciones/
     (BUZON_ENTRY_URL): su contenido vive en un IFRAME central
     que tarda ~30 s en cargar. Dentro: «Destinatario: <RFC>»,
     «Total de notificaciones pendientes: N» y la tabla de
     columnas EXACTAS de abajo. Vacía = «No se encontraron
     resultados» (Mano Fil: 0 pendientes ese día).
   - «Mis comunicados» = /iniciar-expediente/mis-comunicados/,
     también en iframe, con grupos «Mensajes no leídos (n)» y
     «Mensajes leídos (n)»: solo se leen los CONTEOS, jamás se
     abre un mensaje.
   - «Mis documentos»: su iframe a veces no carga (queda gris,
     «Se ha restablecido la conexión»): es flakiness del portal
     → portal-caido con reintento, NUNCA ruta-muerta. Esta
     corrida no visita «Mis documentos»; si el aviso de
     reconexión aparece en la bandeja, se clasifica igual.
   ================================================================ */
export const BUZON_COMUNICADOS_URL = 'https://wwwmat.sat.gob.mx/iniciar-expediente/mis-comunicados/';
/* «Mis documentos» (2.4.0, castigo 4): la tercera bandeja del
   desplegable «Mis expedientes» del mapa vivo, en la misma
   ruta de iniciar-expediente que sus hermanas. Su iframe a
   veces no carga (queda gris, «Se ha restablecido la
   conexión»): cuando eso pasa la sección sale NO CONCLUYENTE
   con su porqué — jamás un cero fingido. */
export const BUZON_DOCUMENTOS_URL = 'https://wwwmat.sat.gob.mx/iniciar-expediente/mis-documentos/';

/* La firma de la bandeja REAL en el texto completo (página +
   marcos del mismo origen): sin ella, la bandeja no se da por
   cargada — el iframe puede tardar ~30 s y su ausencia a los
   pocos segundos no es un fracaso. */
export function buzonFirmaReal(text) {
  const t = norm(text);
  return /destinatario\s*:/.test(t) ||
    /total de notificaciones pendientes/.test(t) ||
    /no se encontraron resultados/.test(t);
}
/* Bandeja VACÍA probada: la firma está presente Y la página
   dice que no hay nada (el texto de vacío o el total a cero).
   Es un éxito con 0 filas, distinguible de «no cargó». */
export function buzonBandejaVacia(text) {
  const t = norm(text);
  if (!buzonFirmaReal(text)) return false;
  return /no se encontraron resultados/.test(t) ||
    /total de notificaciones pendientes\s*:\s*0\b/.test(t);
}
/* Filas que NO son notificaciones (2.9.1, pieza 1 — la
   corrida real 962e463f, la primera que leyó la bandeja desde
   el NAS, guardó una «notificación» cuyo asunto era el texto
   entero de la tabla VACÍA: «Folio del acto administrativo
   Autoridad emisora Seleccione Acto administrativo Seleccione
   Fecha de aviso Aviso Documento No se encontraron resultados
   p p p p», y avisó de una notificación que no existe): la
   fila del marcador de vacío — cualquier celda suya dice «No
   se encontraron resultados», sola en su colspan o acompañada
   del resto de la tabla — y la fila cuyo asunto es texto de
   la propia cabecera («Folio del acto administrativo», la
   «Autoridad emisora» con su filtro «Seleccione», o el
   «Seleccione» pelado de la fila de filtros). Ningún acto
   administrativo real se llama como la cabecera de su tabla:
   esas filas son la tabla hablando de sí misma. Los dos
   extractores de notificaciones las saltan SIEMPRE. */
const buzonFilaEsMarcadorVacio = cells =>
  (Array.isArray(cells) ? cells : []).some(c => norm(c).includes('no se encontraron resultados'));
const buzonAsuntoEsCabecera = asunto => {
  const t = norm(asunto);
  return t.includes('folio del acto administrativo') ||
    (t.includes('autoridad emisora') && t.includes('seleccione')) ||
    t === 'seleccione';
};

/* Extractor de la tabla REAL de pendientes (mapa vivo): fecha
   ← «Fecha de aviso»; asunto ← «Acto administrativo»;
   remitente ← «Autoridad emisora»; y la fila lleva su «Folio
   del acto administrativo» (campo folio). Esta lista ES la de
   pendientes: estado «Pendiente» y abierta=false en cada fila.
   Lectura pura del DOM ya cargado: los enlaces de las columnas
   Aviso/Documento jamás se siguen ni se clican. Devuelve null
   si ninguna tabla trae las columnas reales (manda entonces
   el extractor clásico de respaldo). */
export function extractBuzonRowsReales(tables) {
  for (const table of Array.isArray(tables) ? tables : []) {
    const headers = (table?.headers || []).map(norm);
    if (!headers.length) continue;
    const ci = {
      folio: headers.findIndex(h => /folio del acto/.test(h) || h === 'folio'),
      autoridad: headers.findIndex(h => /autoridad emisora/.test(h)),
      /* «Folio del acto administrativo» también contiene «acto
         administrativo»: el asunto es la columna cuyo encabezado
         es EXACTAMENTE ese o no menciona el folio. */
      acto: headers.findIndex(h => h === 'acto administrativo' ||
        (/acto administrativo/.test(h) && !/folio/.test(h))),
      fecha: headers.findIndex(h => /fecha de aviso/.test(h))
    };
    if (ci.acto < 0 || ci.fecha < 0 || ci.autoridad < 0) continue;
    const rows = [];
    for (const cells of table.rows || []) {
      const get = i => i >= 0 ? String(cells?.[i] || '').replace(/\s+/g, ' ').trim() : '';
      const asunto = get(ci.acto);
      if (!asunto) continue;
      if (buzonFilaEsMarcadorVacio(cells) || buzonAsuntoEsCabecera(asunto)) continue;
      const m = fechaRe.exec(get(ci.fecha));
      const fecha = m ? (m[1] ? `${m[3]}-${m[2]}-${m[1]}` : `${m[4]}-${m[5]}-${m[6]}`) : '';
      rows.push({ fecha, asunto: asunto.slice(0, 300),
        remitente: get(ci.autoridad).slice(0, 160),
        estado: 'Pendiente', abierta: false, folio: get(ci.folio).slice(0, 80) });
      if (rows.length >= BUZON_MAX_NOTIFICATIONS) break;
    }
    return rows;
  }
  return null;
}
/* Los conteos de «Mis comunicados» desde sus encabezados de
   grupo («Mensajes no leídos (n)» / «Mensajes leídos (n)»):
   SOLO conteos — ningún mensaje se abre ni se lee. */
export function buzonConteosComunicados(text) {
  const t = norm(text);
  const no = /mensajes no leidos\s*\((\d+)\)/.exec(t);
  const si = /mensajes leidos\s*\((\d+)\)/.exec(t);
  if (!no && !si) return null;
  return { noLeidos: no ? Number(no[1]) : 0, leidos: si ? Number(si[1]) : 0 };
}

/* ===== Buzón completo (2.4.0, castigo 4) =====
   Las otras dos bandejas del desplegable «Mis expedientes»,
   listadas con la misma regla sagrada de las notificaciones:
   SOLO LISTAR — leer el DOM visible, jamás abrir un mensaje
   ni un documento (abrir una notificación inicia su plazo
   legal; de comunicados y documentos solo se trae la lista).
   Extractores puros, gemelos de extractBuzonRows: reconocen
   la tabla por sus ENCABEZADOS y devuelven null si ninguna
   tabla casa — sin tabla reconocible no hay lista, y el
   llamador declara la sección no concluyente en vez de
   fingir un cero. */
/* Filas de «Mis comunicados»: fecha, asunto y si consta
   leído. El leído sale del texto del estado de la fila
   («No leído»/«Sin leer» ⇒ false; cualquier otro estado
   legible ⇒ true). */
export function extractComunicadosRows(tables) {
  for (const table of Array.isArray(tables) ? tables : []) {
    const headers = (table?.headers || []).map(norm);
    if (!headers.length) continue;
    const ci = {
      fecha: headers.findIndex(isFechaHeader),
      asunto: headers.findIndex(isAsuntoHeader),
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
      rows.push({ fecha, asunto: asunto.slice(0, 300),
        leido: !/no leida|no leido|sin leer|sin abrir|pendiente de lectura|nueva|nuevo/.test(norm(estado)) });
      if (rows.length >= BUZON_MAX_NOTIFICATIONS) break;
    }
    return rows;
  }
  return null;
}
/* Filas de «Mis documentos»: lo que la bandeja enseñe —
   fecha, nombre del documento y su estado si la tabla lo
   trae. Sin columna de estado reconocible, estado ''. */
export function extractDocumentosRows(tables) {
  for (const table of Array.isArray(tables) ? tables : []) {
    const headers = (table?.headers || []).map(norm);
    if (!headers.length) continue;
    const ci = {
      fecha: headers.findIndex(isFechaHeader),
      nombre: headers.findIndex(h => /documento|nombre|archivo|tipo de documento|tramite/.test(h)),
      estado: headers.findIndex(isEstadoHeader)
    };
    if (ci.fecha < 0 || ci.nombre < 0) continue;
    const rows = [];
    for (const cells of table.rows || []) {
      const get = i => i >= 0 ? String(cells?.[i] || '').replace(/\s+/g, ' ').trim() : '';
      const nombre = get(ci.nombre);
      if (!nombre) continue;
      const m = fechaRe.exec(get(ci.fecha));
      const fecha = m ? (m[1] ? `${m[3]}-${m[2]}-${m[1]}` : `${m[4]}-${m[5]}-${m[6]}`) : '';
      rows.push({ fecha, nombre: nombre.slice(0, 300), estado: get(ci.estado).slice(0, 80) });
      if (rows.length >= BUZON_MAX_NOTIFICATIONS) break;
    }
    return rows;
  }
  return null;
}
/* ¿El texto enseña la bandeja de «Mis documentos» (su título
   o su vacío)? Sin esta firma, la bandeja no se da por
   cargada: su iframe es el flaky del mapa vivo. */
export function buzonDocumentosFirma(text) {
  const t = norm(text);
  return /mis documentos/.test(t) || /no se encontraron resultados/.test(t) && /documento/.test(t);
}

/* ================================================================
   LOS LECTORES DESDE LA PÁGINA REAL (2.9.4 — construidos
   desde la evidencia que la pieza por sección de la 2.9.3
   capturó en producción, corrida 34e7b45b; fixtures en
   fixtures/buzon-comunicados-real.html y
   fixtures/buzon-documentos-real.html):

   El diagnóstico, probado con esa evidencia: el contenido
   de AMBAS secciones SÍ llega en el paseo desde el NAS; el
   lector no lo reconocía porque esperaba los marcadores de
   la BANDEJA — los conteos «Mensajes no leídos (n)» de
   buzonConteosComunicados y una tabla de fecha/asunto/
   estado para extractComunicadosRows/extractDocumentosRows.
   Las páginas reales no traen ni lo uno ni lo otro:

   - «Mis comunicados» vive en un marco de OTRO host
     (aplicacionesc.mat.sat.gob.mx/WebComunicados/
     Comunicados.aspx): dos secciones con encabezado
     «Mensajes no leídos» y «Mensajes leídos» — SIN el
     «(n)» — y cada mensaje es una fila <tr id="msgN"> cuyo
     texto visible es «DD/mmm/AAAA HH:MM hrs <asunto>
     <folio>», con su fila de detalle oculta (detalleMsgN)
     al lado. El onclick de la fila invoca VerMsg y
     ComunicadoVisualizado: ABRIR un comunicado — jamás se
     pulsa la fila ni se invoca ninguna de las dos; este
     lector solo lee su texto, como manda la regla legal.
   - «Mis documentos» vive en tramitesdigitales.sat.gob.mx
     (…/FormularioGenerico/TablaDatosFormularioGenerico
     .aspx): una página DataTables con cinco tablas por id
     (#tablaRespons, #tablaRespons2015, #tablaResponsIMSS,
     #tablaResponsEF, #tablaResponsLC). En la captura real
     las tablas aún NO estaban renderizadas (la celda de
     contenido venía vacía): ese estado no es un cero — la
     sección sigue «sin listar» hasta que alguna tabla
     exista en el DOM; con las tablas presentes, sus filas
     son la lista y su marca de vacío es un cero concluyente.
   ================================================================ */

/* El lector de DOM de «Mis comunicados» REAL: por marco,
   las filas [id^="msg"] con su sección — la que manda es
   el encabezado («Mensajes no leídos» / «Mensajes leídos»)
   que las precede en el documento — y su texto visible.
   LECTURA PURA: ningún clic, ninguna invocación; el
   onclick de la fila (VerMsg/ComunicadoVisualizado) jamás
   se dispara leyendo textContent. Sin filas o sin
   encabezados devuelve null: este marco no es la sección. */
function readComunicadosRealesSource() {
  const clean = el => String(el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
  const filas = [...document.querySelectorAll('[id^="msg"]')]
    .filter(el => /^msg\d+$/.test(el.id || ''));
  if (!filas.length) return null;
  const titulos = [];
  for (const el of document.querySelectorAll('td, th, h1, h2, h3, h4, b, span, div')) {
    const t = clean(el);
    if (t === 'Mensajes no leídos') titulos.push({ el, seccion: 'no-leidos' });
    else if (t === 'Mensajes leídos') titulos.push({ el, seccion: 'leidos' });
  }
  if (!titulos.length) return null;
  return filas.map(tr => {
    let seccion = '';
    for (const tit of titulos) {
      /* 4 = DOCUMENT_POSITION_FOLLOWING: el encabezado
         precede a la fila — la última sección que la
         precede es la suya. */
      try { if (tit.el.compareDocumentPosition(tr) & 4) seccion = tit.seccion; } catch { /* nodos sueltos */ }
    }
    return { seccion, texto: clean(tr) };
  });
}
/* El parser PURO de las filas reales de comunicados:
   «28/ago/2026 12:20 hrs Registro o actualización de
   medios de contacto MFI6212158B40004» → { fecha:
   '2026-08-28 12:20', asunto, folio, leido }. El folio es
   el último token cuando tiene la forma del folio del
   Buzón (el RFC del destinatario + su consecutivo de 4
   dígitos); sin esa forma, el texto entero es el asunto y
   el folio viaja ''. Una fila sin sección legible no se
   clasifica: no se inventa si está leída o no. Sin ninguna
   fila clasificable devuelve null — la sección no se da
   por leída con esto. */
const MESES_COMUNICADOS294 = { ene: 1, feb: 2, mar: 3, abr: 4, may: 5, jun: 6,
  jul: 7, ago: 8, sep: 9, oct: 10, nov: 11, dic: 12 };
export function parseComunicadosReales(filasPorMarco) {
  const planas = [];
  for (const porMarco of Array.isArray(filasPorMarco) ? filasPorMarco : [])
    if (Array.isArray(porMarco)) planas.push(...porMarco);
  const items = [];
  for (const fila of planas) {
    if (!fila || (fila.seccion !== 'no-leidos' && fila.seccion !== 'leidos')) continue;
    const texto = String(fila.texto || '').replace(/\s+/g, ' ').trim();
    /* El caso va sobre el texto ORIGINAL (el asunto conserva
       sus acentos, como el portal lo enseña); solo el token
       del mes se desacentúa para el mapa — las abreviaturas
       españolas no lo llevan, pero el caso no cuesta nada. */
    const m = /^(\d{2})\/([a-záéíóúñ]{3})\/(\d{4})\s+(\d{2}):(\d{2})\s*hrs\.?\s+(.+)$/i.exec(texto);
    if (!m) continue;
    const mes = MESES_COMUNICADOS294[m[2].toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')];
    if (!mes) continue;
    let asunto = m[6].trim();
    let folio = '';
    const ultimo = /\s(\S+)$/.exec(asunto);
    if (ultimo && /^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}\d{4}$/.test(ultimo[1])) {
      folio = ultimo[1];
      asunto = asunto.slice(0, ultimo.index).trim();
    }
    if (!asunto) continue;
    items.push({ fecha: m[3] + '-' + String(mes).padStart(2, '0') + '-' + m[1] +
        ' ' + m[4] + ':' + m[5],
      asunto: asunto.slice(0, 300), folio, leido: fila.seccion === 'leidos' });
    if (items.length >= BUZON_MAX_NOTIFICATIONS) break;
  }
  if (!items.length) return null;
  const noLeidos = items.filter(i => !i.leido).length;
  return { items, noLeidos, leidos: items.length - noLeidos };
}

/* ================================================================
   «LEER» UN COMUNICADO (2.9.13 · Bloque B, petición directa
   de Paco): el listado NUNCA abre nada — esa regla sigue
   intacta para las NOTIFICACIONES (reloj legal) y para el
   listado de comunicados —. Pero un COMUNICADO es
   informativo: cuando Paco toca «Leer» en UNO concreto, el
   paseo abre ESE y trae su cuerpo. Estas dos funciones de
   página solo corren cuando la corrida trae la orden
   expresa (options.abrirComunicado con su folio); sin esa
   orden, ninguna corrida las invoca jamás.
   La fila msgN lleva al lado su fila de detalle
   (detalleMsgN): primero se LEE ese detalle tal cual (si el
   portal ya lo trae, ni se toca la fila); solo si viene
   vacío se pulsa la fila — el gesto que el portal espera
   para enseñar el cuerpo — y se espera a que el detalle se
   llene. ================================================================ */
export function detalleComunicadoSource(folioBuscado) {
  const clean = el => String(el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
  const filas = [...document.querySelectorAll('[id^="msg"]')]
    .filter(el => /^msg\d+$/.test(el.id || ''));
  for (const tr of filas) {
    const texto = clean(tr);
    if (!texto.endsWith(String(folioBuscado || ''))) continue;
    const sufijo = tr.id.slice(3);
    const detalle = document.getElementById('detalleMsg' + sufijo) ||
      document.getElementById('detalle' + tr.id);
    const cuerpo = detalle ? clean(detalle) : '';
    /* (2.9.14 · punto 7) Los enlaces DEL DETALLE viajan con la
       lectura: si el cuerpo es en sustancia un único enlace
       (un comunicado-puntero, como el real de medios de
       contacto: «Para consultar los detalles… da clic aquí»),
       la corrida sigue ESE enlace en la misma visita y trae
       también el texto destino (buzonEnlacePuntero2914 decide
       en tierra firme, con el cuerpo y estos enlaces). */
    const enlaces = detalle
      ? [...detalle.querySelectorAll('a[href]')].map(a => ({ href: a.href || '', texto: clean(a) }))
        .filter(e => e.href && e.texto)
      : [];
    return { encontrado: true, fila: texto, cuerpo: cuerpo && cuerpo !== texto ? cuerpo : '', enlaces };
  }
  return { encontrado: false, fila: '', cuerpo: '', enlaces: [] };
}
/* ¿El cuerpo abierto es EN SUSTANCIA un único enlace?
   (2.9.14 · punto 7) Solo entonces la corrida lo sigue: un
   enlace, su texto dentro del cuerpo, y fuera del enlace
   solo queda la invitación breve (≤160 caracteres — el caso
   real deja 73). Un comunicado normal con un enlace entre
   sus párrafos NO es un puntero: su resto es largo y no se
   sigue nada. Solo http(s): ningún otro esquema viaja. */
export function buzonEnlacePuntero2914(cuerpo, enlaces) {
  const lista = (Array.isArray(enlaces) ? enlaces : []).filter(e => e && e.href && e.texto);
  if (lista.length !== 1) return null;
  const texto = String(cuerpo || '').replace(/\s+/g, ' ').trim();
  if (!texto) return null;
  const [enlace] = lista;
  if (!texto.includes(enlace.texto)) return null;
  const resto = texto.replace(enlace.texto, '').replace(/\s+/g, ' ').trim();
  if (resto.length > 160) return null;
  if (!/^https?:\/\//i.test(enlace.href)) return null;
  return enlace.href;
}
/* La lectura de la página destino del puntero: su texto
   visible (acotado) y si su contenido es en sustancia un
   formulario (campos y poco texto que leer). Corre en la
   página — y en sus marcos, como los demás lectores — tras
   navegar el enlace DENTRO de la misma visita. */
export function leerDestinoEnlaceSource() {
  const clean = el => String(el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
  const texto = clean(document.body);
  let campos = 0;
  for (const f of document.querySelectorAll('form'))
    campos += f.querySelectorAll('input, select, textarea').length;
  return { texto: texto.slice(0, 6000), esFormulario: campos >= 2 && texto.length < 1200 };
}
/* El veredicto sobre la página destino, en palabras de la
   casa (2.9.14 · punto 7): texto que se enseña, formulario
   que se nombra (no se rellena ni se inventa), descarga que
   se nombra, o no cargó — nunca un contenido fingido. */
export function buzonDestinoEnlace2914(lectura) {
  if (!lectura) return { estado: 'sin-cargar', texto: '' };
  if (lectura.esDescarga) return { estado: 'descarga', texto: '' };
  if (lectura.esFormulario) return { estado: 'formulario', texto: '' };
  const texto = String(lectura.texto || '').replace(/\s+/g, ' ').trim();
  if (!texto) return { estado: 'sin-cargar', texto: '' };
  return { estado: 'texto', texto };
}
function pulsarComunicadoSource(folioBuscado) {
  const clean = el => String(el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
  const filas = [...document.querySelectorAll('[id^="msg"]')]
    .filter(el => /^msg\d+$/.test(el.id || ''));
  for (const tr of filas) {
    if (!clean(tr).endsWith(String(folioBuscado || ''))) continue;
    tr.click();
    return true;
  }
  return false;
}

/* Las cinco tablas de «Mis documentos» en la página real,
   por su id — el reconocimiento de carga de la sección es
   SUYO: la sección se da por cargada cuando su marco
   enseña estas tablas (con filas o con su vacío), no por
   los marcadores de la bandeja. */
export const BUZON_DOCUMENTOS_TABLAS294 = ['tablaRespons', 'tablaRespons2015',
  'tablaResponsIMSS', 'tablaResponsEF', 'tablaResponsLC'];
/* ¿La fila es la marca de vacío de una DataTables (su celda
   dataTables_empty o su texto de «sin registros»)? Esa
   fila no es un documento: es la tabla diciendo que no
   hay ninguno. */
const buzonDocFilaVacia294 = cells =>
  (Array.isArray(cells) ? cells : []).some(c =>
    /sin registros|no se encontraron registros|no se encontraron resultados|ningun registro|no data available/.test(norm(c)));
/* El lector de DOM de «Mis documentos» REAL: por marco,
   las cinco tablas por id con sus encabezados, sus filas
   de datos y si traen su marca de vacío. Sin ninguna de
   las cinco devuelve null: la página llegó pero las
   tablas no — la sección no consta todavía. */
function readDocumentosRealesSource() {
  const IDS = ['tablaRespons', 'tablaRespons2015', 'tablaResponsIMSS', 'tablaResponsEF', 'tablaResponsLC'];
  const clean = el => String(el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
  const tablas = [];
  for (const id of IDS) {
    const table = document.getElementById(id);
    if (!table) continue;
    const headers = [...table.querySelectorAll('thead th, tr:first-child th')].map(clean);
    let vacia = false;
    const rows = [];
    for (const tr of table.querySelectorAll('tbody tr, tr')) {
      const tds = [...tr.querySelectorAll('td')];
      if (!tds.length) continue;
      if (tds.some(td => (td.className || '').includes('dataTables_empty'))) { vacia = true; continue; }
      const cells = tds.map(clean);
      if (cells.some(c => /sin registros|no se encontraron registros|no se encontraron resultados|ningun registro|no data available/i.test(c))) { vacia = true; continue; }
      rows.push(cells);
    }
    tablas.push({ id, headers, rows, vacia });
  }
  return tablas.length ? { tablas } : null;
}
/* El extractor PURO de las tablas reales de documentos:
   mapea cada fila por los ENCABEZADOS de su tabla (fecha,
   nombre del documento y estado, con el mismo criterio
   que extractDocumentosRows) y devuelve la sección
   concluyente: las filas de todas las tablas presentes.
   Una tabla presente sin filas (con su marca de vacío o
   con el cuerpo vacío: la página es de servidor y sus
   filas llegan con el HTML, no después) cuenta CERO —
   concluyente, no «sin listar». Sin ninguna tabla
   presente devuelve null: la sección no consta. */
export function extractDocumentosReales(porMarco) {
  const tablas = [];
  for (const entrada of Array.isArray(porMarco) ? porMarco : [])
    if (entrada && Array.isArray(entrada.tablas)) tablas.push(...entrada.tablas);
  if (!tablas.length) return null;
  const items = [];
  for (const tabla of tablas) {
    const headers = (tabla?.headers || []).map(norm);
    const ci = {
      fecha: headers.findIndex(isFechaHeader),
      estado: headers.findIndex(isEstadoHeader),
      nombre: headers.findIndex(h => /documento|descripcion|concepto|tramite|nombre|archivo|linea de captura|referencia/.test(h))
    };
    if (ci.nombre < 0)
      ci.nombre = headers.findIndex((h, i) => i !== ci.fecha && i !== ci.estado);
    for (const cells of tabla?.rows || []) {
      if (buzonDocFilaVacia294(cells)) continue;
      const get = i => i >= 0 ? String(cells?.[i] || '').replace(/\s+/g, ' ').trim() : '';
      const nombre = ci.nombre >= 0 ? get(ci.nombre)
        : (Array.isArray(cells) ? cells.join(' ') : '').replace(/\s+/g, ' ').trim();
      if (!nombre) continue;
      const m = fechaRe.exec(get(ci.fecha));
      const fecha = m ? (m[1] ? `${m[3]}-${m[2]}-${m[1]}` : `${m[4]}-${m[5]}-${m[6]}`) : '';
      items.push({ fecha, nombre: nombre.slice(0, 300), estado: get(ci.estado).slice(0, 80) });
      if (items.length >= BUZON_MAX_NOTIFICATIONS) break;
    }
  }
  return { concluyente: true, items };
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

/* La página de la bandeja, capturada UNA vez para la
   evidencia de la corrida (2.9.2, pieza B — gemela de la de
   Declaraciones): el diagnostics() del driver (foto + HTML
   compuesto de la página tal como quedó, con sus marcos) en
   el momento en que la lista ya está leída. Las corridas del
   Buzón 962e463f y ae67cdfa cerraron BIEN y no guardaron
   ninguna evidencia (GET /api/tributario/artifact → 404 en
   las dos, hasShot/hasHtml en false): el motor solo producía
   diagnóstico colgando de los errores, así que una corrida
   buena quedaba ciega — y la sección de comunicados, que no
   concluye en vivo, no dejó ni su página para poder
   diagnosticarla. Sin diagnostics() en el driver no hay
   evidencia que capturar y la lectura sigue: la evidencia
   nunca tumba la corrida. */
async function capturarResultadosDiagTrib(page) {
  if (!page || typeof page.diagnostics !== 'function') return null;
  try { return await page.diagnostics(); } catch { return null; }
}

/* Una muestra del texto VISIBLE de un HTML (2.9.3): fuera
   scripts, estilos, comentarios y etiquetas; las entidades
   comunes vueltas carácter y el blanco colapsado, con tope.
   Es la muestra que el inventario de marcos guarda de cada
   marco: lo que un ojo vería al abrir esa página, en una
   línea — suficiente para saber si el marco cargó, qué
   enseña o si quedó en su texto de espera. */
function muestraTextoDeHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ').trim().slice(0, 400);
}

/* La evidencia de UNA SECCIÓN del Buzón (2.9.3): la página
   de «Mis comunicados» o «Mis documentos» TAL COMO QUEDÓ
   cuando la sección concluyó o agotó su plazo — el
   diagnostics() del driver (foto + HTML compuesto) MÁS el
   inventario de marcos: la URL de cada marco (la propia
   página primero) y una muestra de su texto visible. La
   corrida real 805fc97e (2.9.2, sede NAS) guardó la
   evidencia de la BANDEJA y aun así comunicados volvió a
   no concluir, y de ESA página no quedó nada: ni su HTML
   ni qué marcos tenía ni qué enseñaban. Con el inventario,
   el diagnóstico de la sección se hace desde su página
   real — qué marco llegó, con qué URL y enseñando qué —
   sin repetir la consulta. Sin diagnostics() en el driver
   no hay evidencia que capturar y la lectura sigue: la
   evidencia nunca tumba la corrida. */
async function capturarEvidenciaSeccionTrib(page) {
  if (!page || typeof page.diagnostics !== 'function') return null;
  try {
    const diag = await page.diagnostics();
    if (!diag) return null;
    const htmlCompuesto = String(diag.html || '');
    /* El HTML compuesto trae la página principal y, tras su
       marcador, el HTML de cada marco: la muestra de la
       principal sale de su tramo, antes del primer marco. */
    const marcos = [{ url: String(diag.url || ''),
      texto: muestraTextoDeHtml(htmlCompuesto.split('\n<!-- ===== MARCO')[0]) }];
    for (const frame of diag.frames || [])
      marcos.push({ url: String(frame?.url || ''), texto: muestraTextoDeHtml(frame?.html) });
    return { url: String(diag.url || ''), screenshot: diag.screenshot || null,
      html: htmlCompuesto, marcos };
  } catch { return null; }
}

/* Fábrica del motor, gemela de createSatDeclFetch: valida las
   credenciales ANTES de abrir el navegador, serializa las
   corridas (una sesión de portal cada vez) y acepta el diario
   por corrida en el tercer argumento { onStep }. */
export function createSatTribFetch({ resolveCredentials, launchDriver,
  entryUrl = BUZON_ENTRY_URL, loginUrl = BUZON_LOGIN_URL,
  esperaBandejaMs = 60_000, comunicadosUrl = BUZON_COMUNICADOS_URL,
  documentosUrl = '' } = {}) {
  /* «Mis documentos» (2.4.0, castigo 4): su ruta por defecto es
     la del mapa vivo. La bandeja SOLO se visita cuando la ruta
     es explícita o comparte origen con la ruta de entrada de
     la corrida: una corrida contra una réplica parcial del
     portal (las baterías locales) no navega fuera de su mapa
     — la sección sale no concluyente y lo dice. */
  const documentosUrlEfectiva = documentosUrl || BUZON_DOCUMENTOS_URL;
  let documentosEnMapa = Boolean(documentosUrl);
  if (!documentosEnMapa) {
    try { documentosEnMapa = new URL(documentosUrlEfectiva).origin === new URL(entryUrl).origin; }
    catch { documentosEnMapa = false; }
  }
  let chain = Promise.resolve();
  const run = async (profile, _query, options = {}) => {
    const step = typeof options?.onStep === 'function' ? options.onStep : null;
    /* Cancelación honesta (2.9.3 · O2): quien corre la
       consulta puede pasar su sonda (options.cancelada) y las
       esperas largas la miran en cada vuelta: pedir «Detener»
       para la consulta en segundos, no cuando el plazo del
       portal se agote — en vivo la cancelación tardó ~6 min
       en reflejarse porque ninguna espera miraba la señal. */
    const cancelada293 = typeof options?.cancelada === 'function' ? options.cancelada : null;
    const mirarCancelacion293 = () => {
      if (cancelada293 && cancelada293()) throw failure('cancelada', 'Consulta cancelada por ti.');
    };
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
      mirarCancelacion293();
      }
      /* Entrada con sesión MUERTA (2.0.1): si la página
         reutilizada de la tanda ya está en la URL muerta
         (/app/seg/null — la corrida anterior la dejó en la 404
         y la siguiente paseaba por ella inventariando una
         página de error), la corrida falla RÁPIDO con su paso
         claro para que el ejecutor descarte la sesión y
         reintente con un acceso fresco, sin clicar ni navegar
         nada sobre la página muerta. */
      if (paginaViva) {
        const muertaReutilizada = await buzonPaginaMuerta(page);
        if (muertaReutilizada.muerta) {
          notifyStep(step, 'la sesión reutilizada quedó en la página muerta del portal; se descarta',
            muertaReutilizada.url || '');
          /* Texto de ENTRADA (2.3.2): aquí la sesión ya venía
             muerta — la variante honesta no afirma ninguna
             página de decisión guardada. */
          throw buzonFallaRutaMuertaEntrada(muertaReutilizada.url);
        }
      }
      /* Lectores POR MARCOS (2.9.0, Bloque A — el fallo probado
         en vivo el 17 nov 2026, corrida d1ac98a4): la bandeja
         real vive en un iframe de OTRO ORIGEN
         (agr.siat.sat.gob.mx ≠ wwwmat.sat.gob.mx; evidencia en
         ~/workspace/pacosat-290-evidencia/run-d1ac98a4-html.html:
         la cáscara trae <iframe id="iframetoload" src="https://
         agr.siat.sat.gob.mx/app/seg/SessionBroker?…">) y los
         lectores de siempre — page.evaluate en el marco
         principal recorriendo iframe.contentDocument — son
         CIEGOS a ese marco: un documento de otro origen no se
         puede leer desde la página que lo incrusta, así que los
         marcadores de la bandeja («Destinatario:», «Total de
         notificaciones pendientes», «No se encontraron
         resultados») jamás aparecían en el texto compuesto, se
         esperara lo que se esperara. Playwright SÍ entra en
         cada marco con frame.evaluate (page.evaluateFrames del
         driver, sat-doc-browser.mjs): aquí el texto es la UNIÓN
         de readAllTextSource evaluado en cada marco, las tablas
         son readTablesSource por marco aplanadas y los enlaces
         readLinksSource por marco aplanados — la bandeja se
         detecta DENTRO de su iframe por sus marcadores propios,
         sin cambiar su significado.
         Puerta de capacidad: sin evaluateFrames (las dobles de
         prueba y el ejecutor viejo) manda el comportamiento de
         siempre, intacto — paridad total. */
      const conMarcos = typeof page.evaluateFrames === 'function';
      /* El texto de la página ENTERA (principal + marcos): las
         dobles de prueba sin evaluate caen al text() de
         siempre. */
      const leerTexto = async () => {
        if (conMarcos) {
          const partes = await page.evaluateFrames(readAllTextSource).catch(() => null);
          if (Array.isArray(partes)) {
            const completo = partes.filter(t => typeof t === 'string').join('\n');
            if (completo.trim()) return completo;
          }
        }
        if (typeof page.evaluate === 'function') {
          const completo = await page.evaluate(readAllTextSource).catch(() => '');
          if (typeof completo === 'string' && completo.trim()) return completo;
        }
        return page.text();
      };
      const leerTablas = async () => {
        if (conMarcos) {
          const porMarco = await page.evaluateFrames(readTablesSource).catch(() => null);
          if (Array.isArray(porMarco))
            return porMarco.flatMap(t => (Array.isArray(t) ? t : []));
        }
        if (typeof page.evaluate === 'function')
          return page.evaluate(readTablesSource).catch(() => null);
        return null;
      };
      const leerEnlaces = async () => {
        if (conMarcos) {
          const porMarco = await page.evaluateFrames(readLinksSource).catch(() => null);
          if (Array.isArray(porMarco))
            return porMarco.flatMap(l => (Array.isArray(l) ? l : []));
        }
        if (typeof page.evaluate === 'function')
          return page.evaluate(readLinksSource).catch(() => []);
        return [];
      };
      /* Los lectores desde la página real (2.9.4): los de
         las secciones de comunicados y documentos contra
         SUS marcadores — las filas msgN bajo sus
         encabezados y las cinco tablas DataTables —, por
         los mismos cauces que leerTablas (por marcos con
         evaluateFrames; en la página si no hay marcos).
         Devuelven la lectura parseada o null si la sección
         no enseña todavía lo suyo. */
      const leerComunicadosReales = async () => {
        if (conMarcos) {
          const porMarco = await page.evaluateFrames(readComunicadosRealesSource).catch(() => null);
          if (Array.isArray(porMarco)) {
            const lectura = parseComunicadosReales(porMarco);
            if (lectura) return lectura;
          }
        }
        if (typeof page.evaluate === 'function') {
          const filas = await page.evaluate(readComunicadosRealesSource).catch(() => null);
          if (filas) return parseComunicadosReales([filas]);
        }
        return null;
      };
      const leerDocumentosReales = async () => {
        if (conMarcos) {
          const porMarco = await page.evaluateFrames(readDocumentosRealesSource).catch(() => null);
          if (Array.isArray(porMarco)) {
            const lectura = extractDocumentosReales(porMarco);
            if (lectura) return lectura;
          }
        }
        if (typeof page.evaluate === 'function') {
          const tablas = await page.evaluate(readDocumentosRealesSource).catch(() => null);
          if (tablas) return extractDocumentosReales([tablas]);
        }
        return null;
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
          if (!diag) return;
          /* Sin envenenar (2.0.1): en producción la primera
             captura — sobre una página reutilizada ya muerta —
             envenenaba todas las demás y los artefactos «de
             decisión» salieron byte-idénticos a los finales
             (la misma 404). Regla de las dos orillas: si la
             guardada es la página muerta y la actual NO lo es,
             la actual la REEMPLAZA; y jamás se guarda como
             decisión una página muerta si ya hay una viva. */
          if (!diagDecision) { diagDecision = diag; return; }
          if (buzonDiagEsMuerto(diagDecision) && !buzonDiagEsMuerto(diag)) { diagDecision = diag; return; }
          if (!buzonDiagEsMuerto(diagDecision) && buzonDiagEsMuerto(diag)) return;
          if (!buzonDiagEsMuerto(diag)) diagDecision = diag;
        } catch { /* el diagnóstico nunca tumba la corrida */ }
      };
      /* Hasta la bandeja SIN tocar ninguna notificación
         (RECONSTRUCCIÓN contra el MAPA REAL, 2.0.1): tras el
         acceso el portal aterriza en /buzon con el cuerpo en
         blanco y la navegación en la cabecera; la bandeja vive
         en /iniciar-expediente/mis-notificaciones/ dentro de un
         iframe central que tarda ~30 s. Orden del pasillo:
         (1) si la firma de la bandeja ya está en el texto
         completo (página + marcos), leer; (2) el CAMINO
         HUMANO primero (2.9.0, Bloque A — reorden contra el
         fallo probado en vivo el 17 nov 2026, corrida
         d1ac98a4: la vía directa dejaba el navegador sobre la
         CÁSCARA con el menú y la bandeja, que vive en su
         iframe de otro origen, no se leía; el camino que el
         mapa humano verificado recorre es el del portal):
         el CLIC de la cabecera (desplegable «Mis expedientes»
         → «Mis notificaciones», clic real sobre el elemento
         exacto y visible) + espera larga del iframe
         (esperarBandeja con el plazo COMPLETO, esperaMs — 60 s
         por defecto — y SIN exigir la ruta en la URL: la SPA
         puede no cambiarla o tardar, { exigirRuta:false });
         (3) la dirección DIRECTA de Mis notificaciones como
         RESERVA, + esperarBandeja como hasta ahora, con su
         chequeo de ruta; (4) el rescate por puntuación de la
         1.29.2 como último recurso, con sus exclusiones duras
         intactas. Si la página queda muerta en cualquier salto,
         se clasifica ruta-muerta nombrando la URL, sin seguir
         probando a ciegas. Si nada lleva, el error lleva el
         INVENTARIO de textos de enlace de la última página
         inventariada. */
      await esperaPaginaEstable(leerTexto);
      await capturarDiagDecision();
      const esperaMs = Number.isFinite(Number(options?.esperaBandejaMs))
        ? Number(options.esperaBandejaMs) : esperaBandejaMs;
      const tablasReconocibles = async () => {
        if (typeof page.evaluate !== 'function' && !conMarcos) return false;
        const tablas = await leerTablas();
        return tablas ? (extractBuzonRowsReales(tablas) !== null ||
          extractBuzonRows(tablas, false) !== null) : false;
      };
      /* En la página de ATERRIZAJE solo manda el texto (la real
         no trae ninguna lista; una tabla leída ahí no acredita
         la bandeja): firma real o titular clásico. */
      const esBandejaTexto = async () => {
        const texto = await leerTexto();
        return buzonBandejaVisible(texto) || buzonFirmaReal(texto);
      };
      const esBandeja = async () => await esBandejaTexto() || await tablasReconocibles();
      /* La espera del iframe de la bandeja: sondea la firma en
         TODOS los marcos (leerTexto ya compone página + marcos,
         desde la 2.9.0 también los de otro origen vía
         evaluateFrames) hasta el plazo, con su paso de
         progreso. Sale antes si la página muere (la
         clasificación ruta-muerta la hace el llamador) o si la
         URL no es la de la bandeja pasados unos segundos (ahí
         no va a cargar ningún iframe de bandeja: manda la
         siguiente vía del pasillo).
         Opción { exigirRuta } (2.9.0, Bloque A): con
         exigirRuta:false NO se sale por 'fuera-de-ruta' — el
         camino humano llega por el JS del portal y la SPA
         puede no cambiar la URL o tardar en cambiarla, así que
         tras el clic manda esperar el plazo COMPLETO —; la
         detección de página muerta sigue activa igual. Sin la
         opción, el comportamiento es el de siempre. */
      const esperarBandeja = async (plazoMs, { exigirRuta = true } = {}) => {
        const limite = Date.now() + Math.max(0, plazoMs);
        const inicio = Date.now();
        let avisado = 0;
        for (;;) {
          mirarCancelacion293();
          const texto = await leerTexto();
          if (buzonBandejaVisible(texto) || buzonFirmaReal(texto) || await tablasReconocibles())
            return 'bandeja';
          let urlActual = '';
          try { urlActual = typeof page.url === 'function' ? String(page.url() || '') : ''; } catch { /* en transición */ }
          if (/\/app\/seg\/null/.test(urlActual) || /página no encontrada/i.test(texto))
            return 'muerta:' + urlActual;
          const ahora = Date.now();
          if (ahora >= limite) return 'plazo';
          if (exigirRuta && !/mis-notificaciones/.test(urlActual) && ahora - inicio >= 3000) return 'fuera-de-ruta';
          if (!avisado || ahora - avisado >= 10000) {
            notifyStep(step, 'Esperando la bandeja del portal…', 'su contenido vive en un marco central que puede tardar en cargar');
            avisado = ahora;
          }
          await sleepMs(400);
        }
      };
      const probarCandidatos = async (links, tope, aterrizaje) => {
        for (const target of buzonRescueCandidates(links).slice(0, tope)) {
          if (!target?.href) continue;
          /* La página cuyos enlaces se acaban de inventariar es
             la que manda en la foto de decisión: se refresca
             ANTES de seguir cada candidato. */
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
      let enBandeja = await esBandejaTexto();
      let ultimosLinks = [];
      if (!enBandeja) {
        /* (2) CAMINO HUMANO PRIMERO (2.9.0, Bloque A): el clic
           de la cabecera — desplegable «Mis expedientes» →
           «Mis notificaciones», clic real sobre el elemento
           exacto y visible, fuera de tablas — y la espera con
           el plazo COMPLETO sin exigir la ruta en la URL (la
           SPA puede no cambiarla o tardar: { exigirRuta:false };
           la detección de página muerta sigue activa). Es el
           camino que recorre una persona según el mapa vivo
           verificado el 16 nov 2026, y el que enruta el propio
           JS del portal hasta la cáscara cuyo iframe — de otro
           origen — trae la bandeja, que los lectores por marcos
           ya saben leer. La recuperación de página muerta y el
           descarte de sesión muerta de la entrada quedan como
           estaban: funcionan y no se tocan. */
        if (typeof page.clickTextExactoVisible === 'function') {
          await capturarDiagDecision();
          await page.clickTextExactoVisible('Mis expedientes').catch(() => false);
          const clic = await page.clickTextExactoVisible('Mis notificaciones').catch(() => false);
          if (clic) {
            notifyStep(step, 'Sigo el camino del portal: «Mis expedientes» → «Mis notificaciones»', 'clic real en la cabecera del Buzón: su propio JS enruta a la bandeja, sin abrir ninguna notificación');
            const espera = await esperarBandeja(esperaMs, { exigirRuta: false });
            if (espera === 'bandeja') enBandeja = true;
            else if (espera.startsWith('muerta:')) throw buzonFallaRutaMuerta(espera.slice('muerta:'.length));
          }
        }
        /* (3) Dirección directa como RESERVA + espera larga
           del iframe, como hasta ahora (con su chequeo de
           ruta). Si la página ya está en esa dirección (la
           sesión viva aterrizó ahí, o el camino humano ya la
           dejó ahí), no se vuelve a navegar: se espera. */
        if (!enBandeja) {
          notifyStep(step, 'Busco la bandeja', 'voy a la dirección directa de «Mis notificaciones», sin abrir ninguna');
          if (entryUrl && typeof page.goto === 'function') {
            const yaEnRuta = typeof page.url === 'function' && page.url() === entryUrl;
            if (!yaEnRuta) {
              await capturarDiagDecision();
              await page.goto(entryUrl).catch(() => {});
            }
            const espera = await esperarBandeja(esperaMs);
            if (espera === 'bandeja') enBandeja = true;
            else if (espera.startsWith('muerta:')) throw buzonFallaRutaMuerta(espera.slice('muerta:'.length));
          }
        }
        /* (4) Rescate por puntuación (legado, último recurso).
           El inventario de enlaces sale ahora de los lectores
           por marcos: incluye también los de los marcos
           legibles, no solo los de la página principal. */
        if (!enBandeja) {
          ultimosLinks = await leerEnlaces();
          const aterrizaje = typeof page.url === 'function' ? page.url() : '';
          enBandeja = await probarCandidatos(ultimosLinks, 3, aterrizaje);
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
      const claveDe = row => [row.fecha || '', norm(row.asunto), norm(row.remitente)].join('|');
      const vistas = new Map();
      const tablasEntrada = await leerTablas();
      const textoEntrada = await leerTexto();
      const reales = extractBuzonRowsReales(tablasEntrada);
      const vaciaConfirmada = buzonBandejaVacia(textoEntrada);
      let plantillaReal = false;
      if (reales || vaciaConfirmada) {
        /* Plantilla REAL (mapa vivo): la lista es la de
           pendientes — cada fila sin abrir, con su folio — y
           la bandeja vacía probada es un éxito con 0 filas. */
        plantillaReal = true;
        /* Vacío confirmado MANDA (2.9.1, pieza 1): si el texto
           de la bandeja trae su marcador de vacío («No se
           encontraron resultados» o «Total de notificaciones
           pendientes: 0»), la lista es CERO filas aunque un
           extractor haya construido alguna con el texto de la
           propia tabla vacía — la corrida real 962e463f guardó
           esa fila fantasma y avisó de una notificación que no
           existe. */
        const filas = vaciaConfirmada ? [] : (reales || []);
        for (const row of filas) vistas.set(claveDe(row), row);
        notifyStep(step, 'Bandeja «Pendientes» leída', filas.length + ' sin abrir');
      } else {
        const pendientes = extractBuzonRows(tablasEntrada, false);
        if (!pendientes) {
          /* El aviso de reconexión del portal (el iframe gris
             del mapa vivo): flakiness del SAT → portal-caido
             con reintento, jamás ruta-muerta. */
          if (/se ha restablecido la conexion/.test(norm(textoEntrada)))
            throw failure('portal-caido', 'El portal enseñó su aviso de reconexión («Se ha restablecido la conexión») ' +
              'y la bandeja no cargó: es inestabilidad del SAT, no una ruta muerta. Inténtalo de nuevo en unos ' +
              'minutos. No se abrió ninguna notificación.');
          throw failure('respuesta-inesperada', 'La bandeja no enseñó una tabla de notificaciones reconocible ' +
            '(fecha, asunto y estado): no se lista nada antes que arriesgar una apertura.');
        }
        for (const row of pendientes) vistas.set(claveDe(row), row);
        notifyStep(step, 'Bandeja «Pendientes» leída', pendientes.length + ' sin abrir');
        /* Segunda bandeja clásica: «Notificados» (ya abiertas)
           — solo la trae la plantilla clásica; la real no: su
           segundo tramo es «Mis comunicados». Se llega por su
           enlace visible con las exclusiones del rescate
           (pickBuzonNotificadosLink, H-4.1); lo que no case no
           tumba la corrida: queda lo ya leído. */
        try {
          const links = await leerEnlaces();
          const notificados = pickBuzonNotificadosLink(links);
          if (notificados?.href) {
            await page.goto(notificados.href);
            const tablasNotif = await leerTablas();
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
      }
      /* Evidencia de resultados (2.9.2, pieza B): la página
         de la bandeja TAL COMO QUEDÓ al leer la lista — antes
         de que las secciones naveguen a otro sitio — viaja
         con el resultado como resultadosDiag, igual que en
         Declaraciones: el servidor la archiva como foto/HTML
         de la corrida TAMBIÉN cuando la corrida va bien
         (closeRun en la sede local; en la del ejecutor, el
         espejo ya la esperaba desde la 2.4.0 — castigo 28 —
         y lo que faltaba era que el motor la produjera y el
         ejecutor la reenviara). Sin diagnostics() en la
         página, viaja null y la corrida sigue: la evidencia
         nunca tumba la lectura. */
      const resultadosDiag = await capturarResultadosDiagTrib(page);
      /* «Mis comunicados» (solo en la plantilla real): se leen
         los CONTEOS de sus grupos sin abrir ningún mensaje. Si
         este tramo falla, la corrida NO falla: queda su aviso
         en el diario y el conteo viaja como null. El campo
         comunicadosNoLeidos se emite siempre en esta plantilla
         (si el protocolo del ejecutor o del servidor lo pela
         al integrar, el motor ya lo entrega).
         Buzón completo (2.4.0, castigo 4): la sección viaja
         ENTERA en el resultado — comunicados240seccion con sus
         filas listadas (fecha/asunto/leído) cuando la bandeja
         enseña su tabla, o solo los conteos cuando solo los
         conteos son legibles — y «Mis documentos» se lista en
         documentos240seccion con la misma honestidad: bandeja
         caída o sin tabla ⇒ concluyente:false con su motivo,
         jamás un cero fingido. Las dos secciones viven SOLO
         en la plantilla real: la clásica de respaldo no tiene
         estas bandejas mapeadas y su corrida no navega a
         ningún sitio nuevo (paridad intacta). */
      let comunicadosNoLeidos = null;
      let comunicados240seccion = null;
      let comunicadoAbierto2913 = null;
      let documentos240seccion = null;
      /* Evidencia por sección (2.9.3): la página de cada
         sección tal como quedó al concluir o agotar su
         plazo, con su inventario de marcos — viaja con el
         resultado y el servidor la guarda en el diario de
         la corrida (saveRunSeccionDiag). */
      let comunicadosDiag = null;
      let documentosDiag = null;
      if (plantillaReal && comunicadosUrl && typeof page.goto === 'function') {
        try {
          await capturarDiagDecision();
          /* El mismo tratamiento que la bandeja (2.9.1, pieza
             3 — la corrida real 962e463f dejó esta sección no
             concluyente: «no enseñó ni su tabla ni sus conteos
             en el plazo de espera»): la sección vive en su
             PROPIO marco tras la cáscara de su ruta. Orden del
             pasillo, como en la bandeja: (1) si la sección ya
             se lee en la página actual, se lee; (2) el CAMINO
             HUMANO primero — el clic de la cabecera
             («Mis expedientes» → «Mis comunicados»), que es el
             que enruta el propio JS del portal hasta la
             cáscara cuyo marco trae la sección —; (3) la
             dirección directa como reserva. La lectura va por
             los lectores por marcos (leerTexto ya une todos
             los marcos y las filas salen de leerTablas), así
             que la firma y la tabla se detectan DENTRO de su
             iframe. La honestidad no cambia: sin conteos ni
             tabla al vencer los plazos, la sección sale no
             concluyente con su motivo, jamás un cero fingido.
             PLAZOS POR VÍA (2.9.2, pieza A — el defecto que la
             2.9.1 dejó, probado con los tiempos de la corrida
             real ae67cdfa): la 2.9.1 compartía UN límite
             (inicio del bloque + esperaMs) entre la lectura
             previa, el camino humano y la reserva directa.
             En ae67cdfa el camino humano sondeó los 59,4 s
             enteros sin concluir y la reserva directa arrancó
             con el plazo YA VENCIDO: su goto recargó la
             cáscara — reiniciando la carga de su marco — y su
             espera se redujo a una sola lectura con el marco
             frío; la reserva nunca tuvo su oportunidad. La
             bandeja nunca tuvo ese defecto: esperarBandeja
             calcula su límite AL EMPEZAR cada vía y cada vía
             recibe el plazo completo. Aquí, lo mismo:
             esperarSeccionCom(plazoMs) abre su propio límite
             en cada llamada, la vía directa recibe un plazo
             FRESCO y, si la página ya está en la dirección de
             la sección, no se vuelve a navegar (recargar la
             cáscara reiniciaría su marco: el mismo cuidado
             que la vía directa de la bandeja). La espera de
             estabilidad sale de las vías: el sondeo ya lee la
             sección en cada vuelta y aquella espera quemaba
             hasta 8 s por vía sin leerla. */
          let conteos = null;
          let filasCom = null;
          /* La lectura desde la página real (2.9.4): las
             filas msgN bajo sus encabezados — el marcador
             PROPIO de esta sección, el que la evidencia de
             producción enseñó. Manda sobre los conteos y
             sobre la tabla clásica: es la única lectura
             que trae la lista entera. */
          let realesCom = null;
          const leerSeccionCom = async () => {
            const textoCom = await leerTexto();
            conteos = buzonConteosComunicados(textoCom);
            realesCom = await leerComunicadosReales();
            if (typeof page.evaluate === 'function' || conMarcos)
              filasCom = extractComunicadosRows(await leerTablas());
            return Boolean(realesCom || conteos || filasCom);
          };
          /* La espera de la sección, con la forma de
             esperarBandeja: sondea la lectura por marcos hasta
             SU plazo, sale antes si la página muere (la
             sección lo anota en su motivo, sin tumbar la
             corrida: las secciones no son fatales) y avisa de
             su progreso cada ~10 s, como la bandeja. */
          let motivoMuertaCom = '';
          const esperarSeccionCom = async (plazoMs) => {
            const limite = Date.now() + Math.max(0, plazoMs);
            let avisado = 0;
            for (;;) {
              mirarCancelacion293();
              if (await leerSeccionCom()) return 'seccion';
              let urlCom = '';
              try { urlCom = typeof page.url === 'function' ? String(page.url() || '') : ''; } catch { /* en transición */ }
              if (/\/app\/seg\/null/.test(urlCom)) return 'muerta:' + urlCom;
              const ahora = Date.now();
              if (ahora >= limite) return 'plazo';
              if (!avisado || ahora - avisado >= 10000) {
                notifyStep(step, 'Esperando «Mis comunicados»…', 'su contenido vive en su marco central y puede tardar en cargar');
                avisado = ahora;
              }
              await sleepMs(400);
            }
          };
          let leidaCom = await leerSeccionCom();
          if (!leidaCom && typeof page.clickTextExactoVisible === 'function') {
            await page.clickTextExactoVisible('Mis expedientes').catch(() => false);
            const clicCom = await page.clickTextExactoVisible('Mis comunicados').catch(() => false);
            if (clicCom) {
              notifyStep(step, 'Sigo el camino del portal: «Mis expedientes» → «Mis comunicados»', 'clic real en la cabecera del Buzón: su propio JS enruta a la bandeja de comunicados, sin abrir ningún mensaje');
              const esperaCom = await esperarSeccionCom(esperaMs);
              if (esperaCom === 'seccion') leidaCom = true;
              else if (esperaCom.startsWith('muerta:')) motivoMuertaCom = esperaCom.slice('muerta:'.length);
            }
          }
          if (!leidaCom) {
            await capturarDiagDecision();
            /* Si la página YA está en la dirección de la
               sección (el camino humano la dejó ahí), no se
               vuelve a navegar: se espera sobre la cáscara
               que ya carga su marco, con el plazo fresco
               entero. */
            const yaEnRutaCom = typeof page.url === 'function' && page.url() === comunicadosUrl;
            if (!yaEnRutaCom) await page.goto(comunicadosUrl).catch(() => {});
            const esperaCom = await esperarSeccionCom(esperaMs);
            if (esperaCom === 'seccion') leidaCom = true;
            else if (esperaCom.startsWith('muerta:')) motivoMuertaCom = esperaCom.slice('muerta:'.length);
          }
          if (realesCom) {
            /* La lista real manda (2.9.4): los conteos
               salen de la propia lista — cada mensaje con
               su fecha, su asunto y su folio, leído o sin
               leer según la sección del portal en la que
               consta — y el conteo de encabezados, si la
               página lo trajera, queda como respaldo. */
            comunicadosNoLeidos = realesCom.noLeidos;
            comunicados240seccion = { concluyente: true, items: realesCom.items,
              noLeidos: realesCom.noLeidos, leidos: realesCom.leidos, soloConteos: false };
            notifyStep(step, 'Comunicados leídos', realesCom.noLeidos + ' sin leer · ' + realesCom.items.length +
              ' listados (solo la lista: no se abrió ningún mensaje)');
          } else if (filasCom) {
            const noLeidosFilas = filasCom.filter(f => !f.leido).length;
            comunicadosNoLeidos = conteos ? conteos.noLeidos : noLeidosFilas;
            comunicados240seccion = { concluyente: true, items: filasCom,
              noLeidos: comunicadosNoLeidos,
              leidos: conteos ? conteos.leidos : filasCom.length - noLeidosFilas, soloConteos: false };
            notifyStep(step, 'Comunicados leídos', comunicadosNoLeidos + ' sin leer · ' + filasCom.length +
              ' listados (solo la lista: no se abrió ningún mensaje)');
          } else if (conteos) {
            comunicadosNoLeidos = conteos.noLeidos;
            comunicados240seccion = { concluyente: true, items: [], noLeidos: conteos.noLeidos,
              leidos: conteos.leidos, soloConteos: true };
            notifyStep(step, 'Comunicados leídos', conteos.noLeidos + ' sin leer · ' + conteos.leidos + ' leídos (solo los conteos: no se abrió ningún mensaje)');
          } else {
            comunicados240seccion = { concluyente: false, items: [], noLeidos: null, leidos: null,
              motivo: motivoMuertaCom
                ? 'La bandeja de «Mis comunicados» cayó en la página muerta del portal durante la lectura: no consta su contenido, no es un cero.'
                : 'La bandeja de «Mis comunicados» no enseñó ni su tabla ni sus conteos en el plazo de espera: no consta su contenido, no es un cero.' };
            notifyStep(step, 'Comunicados sin conteo legible', 'la corrida sigue con las notificaciones ya leídas');
          }
          /* Evidencia de la sección (2.9.3): la página tal
             como quedó — concluyera o agotara su plazo —
             ANTES de que «Mis documentos» navegue a otro
             sitio: es el momento de esta sección. */
          comunicadosDiag = await capturarEvidenciaSeccionTrib(page);
        } catch (errorCom293) {
          /* La cancelación pedida por el usuario NO es una
             sección no concluyente: sube tal cual (2.9.3 · O2). */
          if (errorCom293?.code === 'cancelada') throw errorCom293;
          comunicadosDiag = await capturarEvidenciaSeccionTrib(page);
          comunicados240seccion = { concluyente: false, items: [], noLeidos: null, leidos: null,
            motivo: 'La bandeja de «Mis comunicados» no se pudo leer en esta corrida: no consta su contenido, no es un cero.' };
          notifyStep(step, 'Comunicados sin conteo legible', 'la corrida sigue con las notificaciones ya leídas');
        }
        /* (2.9.13 · Bloque B) La orden expresa de «Leer»:
           SOLO si esta corrida la trae (options.abrirComunicado
           con el folio que Paco tocó) y la lista real lo
           contiene, se abre ESE comunicado — primero leyendo
           su detalle tal cual; si viene vacío, pulsando su
           fila y esperando a que el detalle se llene (hasta
           ~8 s). Las notificaciones jamás pasan por aquí: esta
           página es la de comunicados y la orden nombra un
           folio de comunicado. Sin orden, este bloque no
           existe para la corrida. */
        const folioLeer2913 = String(options?.abrirComunicado?.folio || '').trim();
        if (folioLeer2913 && comunicados240seccion?.concluyente &&
            (comunicados240seccion.items || []).some(i => i.folio === folioLeer2913)) {
          const itemLeer2913 = comunicados240seccion.items.find(i => i.folio === folioLeer2913);
          const leerDetalle2913 = async () => {
            if (conMarcos) {
              const porMarco = await page.evaluateFrames(detalleComunicadoSource, folioLeer2913).catch(() => null);
              if (Array.isArray(porMarco)) {
                const hallado = porMarco.find(r => r && r.encontrado);
                if (hallado) return hallado;
              }
            }
            if (typeof page.evaluate === 'function') {
              const unico = await page.evaluate(detalleComunicadoSource, folioLeer2913).catch(() => null);
              if (unico && unico.encontrado) return unico;
            }
            return { encontrado: false, fila: '', cuerpo: '' };
          };
          let detalle2913 = await leerDetalle2913();
          if (detalle2913.encontrado && !detalle2913.cuerpo) {
            notifyStep(step, 'Abriendo el comunicado que pediste', 'solo ese: ' + (itemLeer2913.asunto || folioLeer2913));
            let pulsado2913 = false;
            if (conMarcos) {
              const porMarco = await page.evaluateFrames(pulsarComunicadoSource, folioLeer2913).catch(() => null);
              pulsado2913 = Array.isArray(porMarco) && porMarco.some(Boolean);
            }
            if (!pulsado2913 && typeof page.evaluate === 'function')
              pulsado2913 = Boolean(await page.evaluate(pulsarComunicadoSource, folioLeer2913).catch(() => false));
            if (pulsado2913) {
              const limite2913 = Date.now() + 8000;
              while (!detalle2913.cuerpo && Date.now() < limite2913) {
                mirarCancelacion293();
                await sleepMs(400);
                detalle2913 = await leerDetalle2913();
              }
            }
          }
          /* (2.9.14 · punto 7) Comunicado-puntero: si el
             cuerpo es en sustancia un único enlace — el caso
             real del 18 nov: el comunicado de medios de
             contacto son 86 caracteres y un «da clic aquí» —,
             la corrida lo sigue DENTRO de la misma visita y
             trae también el texto de la página destino. Si el
             destino es un formulario, una descarga o no carga,
             se dice lo que es, en llano: jamás se inventa su
             contenido. Y el cuerpo ya leído manda: un fallo
             del seguimiento no lo toca. */
          let enlaceDetalle2914 = null;
          const hrefPuntero2914 = detalle2913.cuerpo
            ? buzonEnlacePuntero2914(detalle2913.cuerpo, detalle2913.enlaces) : null;
          if (hrefPuntero2914) {
            notifyStep(step, 'Siguiendo el enlace del comunicado',
              'su cuerpo es un puntero: se lee también la página que enlaza, en esta misma visita');
            const leerDestino2914 = async () => {
              if (conMarcos) {
                const porMarco = await page.evaluateFrames(leerDestinoEnlaceSource).catch(() => null);
                if (Array.isArray(porMarco)) {
                  const conTexto = porMarco.find(r => r && (r.texto || r.esFormulario));
                  if (conTexto) return conTexto;
                  const alguno = porMarco.find(r => r);
                  if (alguno) return alguno;
                }
              }
              if (typeof page.evaluate === 'function')
                return page.evaluate(leerDestinoEnlaceSource).catch(() => null);
              return null;
            };
            try {
              if (typeof page.goto !== 'function') throw new Error('la visita no puede navegar al enlace');
              await page.goto(hrefPuntero2914);
              let lectura2914 = null;
              const limiteDestino2914 = Date.now() + 12000;
              while (Date.now() < limiteDestino2914) {
                mirarCancelacion293();
                lectura2914 = await leerDestino2914();
                if (lectura2914 && (lectura2914.texto || lectura2914.esFormulario)) break;
                await sleepMs(500);
              }
              if (lectura2914 && !lectura2914.texto && !lectura2914.esFormulario &&
                  /\.(pdf|zip|xml|docx?|xlsx?)([?#]|$)/i.test(hrefPuntero2914))
                lectura2914 = { ...lectura2914, esDescarga: true };
              enlaceDetalle2914 = buzonDestinoEnlace2914(lectura2914);
            } catch (errorDestino2914) {
              if (errorDestino2914?.code === 'cancelada') throw errorDestino2914;
              enlaceDetalle2914 = /download/i.test(String(errorDestino2914?.message || ''))
                ? { estado: 'descarga', texto: '' } : { estado: 'sin-cargar', texto: '' };
            }
            notifyStep(step, 'Enlace del comunicado: ' + enlaceDetalle2914.estado,
              enlaceDetalle2914.estado === 'texto'
                ? 'el texto de la página destino viaja con el comunicado'
                : 'el destino se nombra tal como es; no se inventa su contenido');
          }
          comunicadoAbierto2913 = { folio: folioLeer2913,
            asunto: itemLeer2913.asunto || '', fecha: itemLeer2913.fecha || '',
            cuerpo: detalle2913.cuerpo || '',
            abierto: Boolean(detalle2913.cuerpo),
            ...(enlaceDetalle2914 ? { enlaceDetalle: enlaceDetalle2914 } : {}) };
          notifyStep(step, detalle2913.cuerpo ? 'Comunicado abierto' : 'El comunicado no enseñó su cuerpo',
            detalle2913.cuerpo ? 'su texto viaja con esta corrida'
              : 'el portal no llenó su detalle en esta visita: no se inventa su contenido');
        }
      }
      /* «Mis documentos» (2.4.0, castigo 4): solo listar lo
         que la bandeja enseñe. Su iframe es el flaky del mapa
         vivo (a veces no carga y queda gris): si al vencer la
         espera no hay ni firma ni tabla, la sección sale NO
         CONCLUYENTE con su porqué. Si la ruta no está en el
         mapa de esta corrida (réplicas parciales de las
         baterías), ni se navega: no concluyente declarado. */
      if (plantillaReal && typeof page.goto === 'function') {
        if (!documentosEnMapa) {
          documentos240seccion = { concluyente: false, items: [],
            motivo: 'La ruta de «Mis documentos» no forma parte del mapa de esta corrida: no se navegó fuera de él y su contenido no consta.' };
          notifyStep(step, 'Documentos sin listar', 'su ruta no forma parte del mapa de esta corrida: no consta, no es un cero');
        } else {
          try {
            await capturarDiagDecision();
            /* Espera acotada a 30 s (2.9.0, Bloque A; antes
               8 s): como en «Mis comunicados», el contenido
               vive en su marco y el marco tarda ~30 s según el
               mapa vivo; la lectura va por los lectores por
               marcos (leerTexto/leerTablas), que detectan la
               firma y la tabla DENTRO del iframe. La salida
               temprana honesta y los motivos no cambian.
               REINTENTO PACIENTE (2.9.7, pieza D8): ese plazo
               — plazoDocTotal = min(esperaMs, 30 s) — es el
               presupuesto TOTAL de la sección y NO crece: si
               un intento concluye que el marco llegó SIN
               RENDERIZAR (ni las cinco tablas ni su marca de
               vacío: la misma señal que hasta la 2.9.6 daba el
               «sin listar» al primer intento), la sección se
               RECARGA — volver a navegar a su ruta, el camino
               ya construido para llegar ahí — hasta 2 veces
               más (3 intentos en total). Los intentos se
               reparten el presupuesto: cada uno espera como
               mucho el tiempo que queda dividido entre los
               intentos que quedan, así que la corrida no se
               alarga por reintentar. Cada reintento queda en
               los pasos de la corrida, y la evidencia que se
               guarda tras el bucle es la del ÚLTIMO intento
               (la página tal como quedó entonces), como
               siempre. Los motivos que NO son «sin renderizar»
               (aviso de reconexión, página muerta) no
               reintentan: salen con su motivo al primer
               intento, igual que antes. Si el tercer intento
               también llega sin renderizar, el motivo final lo
               dice: marco sin renderizar tras 3 intentos —
               «sin listar» honesto, nunca un cero fingido. */
            const plazoDocTotal = Math.min(esperaMs, 30_000);
            const limiteDocTotal = Date.now() + plazoDocTotal;
            const MAX_INTENTOS_DOC297 = 3;
            let filasDoc = null;
            let motivoDoc = '';
            let intentosDoc = 0;
            let sinRenderizarDoc = false;
            for (let intentoDoc = 1; intentoDoc <= MAX_INTENTOS_DOC297 && !filasDoc; intentoDoc++) {
              intentosDoc = intentoDoc;
              sinRenderizarDoc = false;
              if (intentoDoc > 1) {
                notifyStep(step, 'Mis documentos no cargó a la primera; lo intento otra vez (' +
                  intentoDoc + ' de ' + MAX_INTENTOS_DOC297 + ')…',
                  'el marco llegó sin renderizar en el intento anterior (ni sus tablas ni su marca de vacío): ' +
                  'recargo la sección dentro del mismo plazo total, sin alargar la corrida');
                motivoDoc = '';
              }
              /* El plazo de ESTE intento se fija ANTES de
                 navegar, para que la propia navegación cuente
                 contra él: el resto del presupuesto total
                 dividido entre los intentos que quedan (el
                 primero incluido). */
              const inicioIntentoDoc = Date.now();
              const limiteDoc = Math.min(limiteDocTotal,
                inicioIntentoDoc + Math.max(0, limiteDocTotal - inicioIntentoDoc) /
                  (MAX_INTENTOS_DOC297 - intentoDoc + 1));
              await page.goto(documentosUrlEfectiva).catch(() => {});
              let textoPrevioDoc = null;
              for (;;) {
                mirarCancelacion293();
                const textoDoc = await leerTexto();
                if (/se ha restablecido la conexion/.test(norm(textoDoc))) {
                  motivoDoc = 'El portal enseñó su aviso de reconexión («Se ha restablecido la conexión») y la bandeja de «Mis documentos» no cargó: es la flaqueza conocida del SAT con esta bandeja, no un cero.';
                  break;
                }
                /* El reconocimiento PROPIO de la sección
                   (2.9.4): sus cinco tablas DataTables por id
                   — presentes con filas o con su vacío, la
                   sección está cargada y su lista es la que
                   traen; ausentes, la página llegó pero la
                   sección no consta todavía y la espera sigue
                   (la captura real de producción llegó así:
                   página sí, tablas no — eso no es un cero). */
                const realesDoc = await leerDocumentosReales();
                if (realesDoc) { filasDoc = realesDoc.items; break; }
                if (typeof page.evaluate === 'function' || conMarcos)
                  filasDoc = extractDocumentosRows(await leerTablas());
                if (filasDoc) break;
                if (buzonDocumentosFirma(textoDoc) && /no se encontraron resultados/.test(norm(textoDoc))) { filasDoc = []; break; }
                let urlDoc = '';
                try { urlDoc = typeof page.url === 'function' ? String(page.url() || '') : ''; } catch { /* en transición */ }
                if (/\/app\/seg\/null/.test(urlDoc)) {
                  motivoDoc = 'La bandeja de «Mis documentos» cayó en la página muerta del portal durante la lectura: no consta su contenido, no es un cero.';
                  break;
                }
                /* Salida temprana honesta: página estable que ni
                   nombra la bandeja — esperar más no la pinta.
                   Es un intento concluido SIN RENDERIZAR: si
                   quedan intentos, el bucle exterior recarga. */
                if (textoPrevioDoc !== null && textoDoc === textoPrevioDoc &&
                    !/documento/.test(norm(textoDoc)) && Date.now() > inicioIntentoDoc + 2_500) {
                  sinRenderizarDoc = true;
                  break;
                }
                textoPrevioDoc = textoDoc;
                if (Date.now() >= limiteDoc) {
                  /* El intento agotó su parte del plazo sin
                     que el marco enseñara ni sus tablas ni su
                     marca de vacío: llegó sin renderizar. */
                  sinRenderizarDoc = true;
                  break;
                }
                await sleepMs(400);
              }
              /* Sin renderizar y sin intentos restantes: el
                 motivo final nombra los 3 intentos. Con
                 intentos por delante, el bucle recarga. Un
                 motivo ajeno al render (reconexión, página
                 muerta) o un éxito cierran el bucle ya: el
                 primero por su motivo, el segundo porque
                 filasDoc quedó fijado. */
              if (!filasDoc && !sinRenderizarDoc) break;
              if (!filasDoc && intentoDoc === MAX_INTENTOS_DOC297) {
                motivoDoc = 'La bandeja de «Mis documentos» llegó sin renderizar tras ' +
                  MAX_INTENTOS_DOC297 + ' intentos (su marco no enseñó ni sus tablas ni su marca de vacío ' +
                  'dentro del plazo total de la sección, la flaqueza conocida del SAT con esta bandeja): ' +
                  'no consta su contenido, no es un cero.';
              }
            }
            if (filasDoc) {
              documentos240seccion = { concluyente: true, items: filasDoc };
              notifyStep(step, 'Documentos listados', filasDoc.length + ' en la bandeja (solo la lista: no se abrió ningún documento)' +
                (intentosDoc > 1 ? ' — al intento ' + intentosDoc + ' de ' + MAX_INTENTOS_DOC297 : ''));
            } else {
              documentos240seccion = { concluyente: false, items: [], motivo: motivoDoc ||
                'La bandeja de «Mis documentos» no enseñó su lista en esta corrida: no consta su contenido, no es un cero.' };
              notifyStep(step, 'Documentos sin listar', documentos240seccion.motivo);
            }
            /* Evidencia de la sección (2.9.3): la página
               tal como quedó al concluir o agotar su plazo,
               con su inventario de marcos. */
            documentosDiag = await capturarEvidenciaSeccionTrib(page);
          } catch (errorDoc293) {
            if (errorDoc293?.code === 'cancelada') throw errorDoc293;
            documentosDiag = await capturarEvidenciaSeccionTrib(page);
            documentos240seccion = { concluyente: false, items: [],
              motivo: 'La bandeja de «Mis documentos» no se pudo leer en esta corrida: no consta su contenido, no es un cero.' };
            notifyStep(step, 'Documentos sin listar', documentos240seccion.motivo);
          }
        }
      }
      const rows = [...vistas.values()].slice(0, BUZON_MAX_NOTIFICATIONS);
      notifyStep(step, 'Lista leída', rows.length + ' notificación(es) en la bandeja de pendientes');
      return { notifications: rows, comunicadosNoLeidos, resultadosDiag,
        ...(comunicadoAbierto2913 ? { comunicadoAbierto: comunicadoAbierto2913 } : {}),
        ...(comunicados240seccion ? { comunicados: comunicados240seccion } : {}),
        ...(documentos240seccion ? { documentos: documentos240seccion } : {}),
        /* La evidencia por sección (2.9.3) solo viaja
           cuando se capturó: sin diagnostics() en el driver
           el resultado no gana ningún campo, como siempre. */
        ...(comunicadosDiag ? { comunicadosDiag } : {}),
        ...(documentosDiag ? { documentosDiag } : {}) };
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

/* Prueba de la puerta en la sede local (2.9.3 · F1): la
   misma prueba que el ejecutor corre en la PC con su trabajo
   «puerta-probar», pero con el navegador del propio servidor:
   resuelve las credenciales guardadas, abre una sesión fría
   con la e.firma y la cierra. Antes de esta pieza, en la sede
   NAS la ruta /api/salud/puerta NO probaba nada («no se
   encola nada») y la marca «probada el…» quedaba congelada
   en la última prueba del ejecutor: el botón parecía muerto.
   Devuelve { puerta:'abre', accesoOk:true } si la puerta
   abre; los fallos viajan como SatDocError con su tipo
   (sin-efirma, navegador-no-disponible, los del acceso), los
   mismos que la sede remota ya sabe pintar en sat_puerta. */
export function createSatPuertaFetch({ resolveCredentials, launchDriver } = {}) {
  return async (profile) => {
    const creds = await resolveCredentials(profile);
    if (!creds) throw failure('sin-efirma', 'No hay e.firma guardada para ' + String(profile?.rfc || '') +
      ': sin ella no se puede probar la puerta.');
    let driver = null;
    try {
      try {
        driver = await launchDriver();
      } catch (error) {
        if (error instanceof SatDocError) throw error;
        throw failure('navegador-no-disponible', 'El navegador interno de PacoSAT no pudo arrancar ' +
          'en este equipo (' + (error?.message || error) + ').');
      }
      const page = await driver.newPage();
      const keyMaterial = prepareKeyForPortal(creds.key, creds.password);
      /* La MISMA puerta del paseo del Buzón (2.9.12 · Pieza 1):
         hasta esta ronda la prueba llamaba al acceso SIN
         entryUrl y page.goto(undefined) moría al instante —
         y satBrowserLogin disfrazaba ese error local de
         «portal-caido», así que la puerta declaró la caída
         del SAT todo el 18 nov con el portal arriba y el
         paseo entrando. La constante es la del módulo, la
         misma que la fábrica del Buzón usa por defecto. */
      await satBrowserLogin(page, { cer: creds.cer, key: keyMaterial.buffer,
        password: creds.password, rfc: creds.rfc, entryUrl: BUZON_LOGIN_URL });
      return { puerta: 'abre', accesoOk: true };
    } finally {
      if (driver) await driver.close().catch(() => {});
    }
  };
}
