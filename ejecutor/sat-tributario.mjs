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
         completo (página + marcos), leer; (2) dirección DIRECTA
         de Mis notificaciones + espera larga del iframe
         (esperarBandeja, hasta esperaBandejaMs — 60 s por
         defecto — con el paso «Esperando la bandeja del
         portal…»); (3) el CLIC de la cabecera (desplegable
         «Mis expedientes» → «Mis notificaciones») si la directa
         no llevó; (4) el rescate por puntuación de la 1.29.2
         como último recurso, con sus exclusiones duras
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
        if (typeof page.evaluate !== 'function') return false;
        const tablas = await page.evaluate(readTablesSource).catch(() => null);
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
         TODOS los marcos (leerTexto ya compone página + marcos
         del mismo origen) hasta el plazo, con su paso de
         progreso. Sale antes si la página muere (la
         clasificación ruta-muerta la hace el llamador) o si la
         URL no es la de la bandeja pasados unos segundos (ahí
         no va a cargar ningún iframe de bandeja: manda la
         siguiente vía del pasillo). */
      const esperarBandeja = async (plazoMs) => {
        const limite = Date.now() + Math.max(0, plazoMs);
        const inicio = Date.now();
        let avisado = 0;
        for (;;) {
          const texto = await leerTexto();
          if (buzonBandejaVisible(texto) || buzonFirmaReal(texto) || await tablasReconocibles())
            return 'bandeja';
          let urlActual = '';
          try { urlActual = typeof page.url === 'function' ? String(page.url() || '') : ''; } catch { /* en transición */ }
          if (/\/app\/seg\/null/.test(urlActual) || /página no encontrada/i.test(texto))
            return 'muerta:' + urlActual;
          const ahora = Date.now();
          if (ahora >= limite) return 'plazo';
          if (!/mis-notificaciones/.test(urlActual) && ahora - inicio >= 3000) return 'fuera-de-ruta';
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
        notifyStep(step, 'Busco la bandeja', 'voy a la dirección directa de «Mis notificaciones», sin abrir ninguna');
        /* (2) Dirección directa + espera larga del iframe. Si
           la página ya está en esa dirección (la sesión viva
           aterrizó ahí), no se vuelve a navegar: se espera. */
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
        /* (3) El clic de la cabecera: desplegable «Mis
           expedientes» → «Mis notificaciones» (clic real sobre
           el elemento exacto y visible, fuera de tablas). */
        if (!enBandeja && typeof page.clickTextExactoVisible === 'function') {
          await capturarDiagDecision();
          await page.clickTextExactoVisible('Mis expedientes').catch(() => false);
          const clic = await page.clickTextExactoVisible('Mis notificaciones').catch(() => false);
          if (clic) {
            notifyStep(step, 'Sigo «Mis notificaciones»', 'clic real en la cabecera del Buzón (desplegable «Mis expedientes»): su propio JS enruta a la bandeja, sin abrir ninguna notificación');
            const espera = await esperarBandeja(Math.min(esperaMs, 20_000));
            if (espera === 'bandeja') enBandeja = true;
            else if (espera.startsWith('muerta:')) throw buzonFallaRutaMuerta(espera.slice('muerta:'.length));
          }
        }
        /* (4) Rescate por puntuación (legado, último recurso). */
        if (!enBandeja) {
          ultimosLinks = await page.evaluate(readLinksSource).catch(() => []);
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
      const tablasEntrada = await page.evaluate(readTablesSource);
      const textoEntrada = await leerTexto();
      const reales = extractBuzonRowsReales(tablasEntrada);
      let plantillaReal = false;
      if (reales || buzonBandejaVacia(textoEntrada)) {
        /* Plantilla REAL (mapa vivo): la lista es la de
           pendientes — cada fila sin abrir, con su folio — y
           la bandeja vacía probada es un éxito con 0 filas. */
        plantillaReal = true;
        const filas = reales || [];
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
      }
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
      let documentos240seccion = null;
      if (plantillaReal && comunicadosUrl && typeof page.goto === 'function') {
        try {
          await capturarDiagDecision();
          await page.goto(comunicadosUrl).catch(() => {});
          const limiteCom = Date.now() + Math.min(esperaMs, 15_000);
          let conteos = null;
          let filasCom = null;
          for (;;) {
            const textoCom = await leerTexto();
            conteos = buzonConteosComunicados(textoCom);
            if (typeof page.evaluate === 'function')
              filasCom = extractComunicadosRows(await page.evaluate(readTablesSource).catch(() => null));
            if (conteos || filasCom) break;
            let urlCom = '';
            try { urlCom = typeof page.url === 'function' ? String(page.url() || '') : ''; } catch { /* en transición */ }
            if (/\/app\/seg\/null/.test(urlCom) || Date.now() >= limiteCom) break;
            await sleepMs(400);
          }
          if (filasCom) {
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
              motivo: 'La bandeja de «Mis comunicados» no enseñó ni su tabla ni sus conteos en el plazo de espera: no consta su contenido, no es un cero.' };
            notifyStep(step, 'Comunicados sin conteo legible', 'la corrida sigue con las notificaciones ya leídas');
          }
        } catch {
          comunicados240seccion = { concluyente: false, items: [], noLeidos: null, leidos: null,
            motivo: 'La bandeja de «Mis comunicados» no se pudo leer en esta corrida: no consta su contenido, no es un cero.' };
          notifyStep(step, 'Comunicados sin conteo legible', 'la corrida sigue con las notificaciones ya leídas');
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
            await page.goto(documentosUrlEfectiva).catch(() => {});
            const limiteDoc = Date.now() + Math.min(esperaMs, 8_000);
            let filasDoc = null;
            let motivoDoc = '';
            let textoPrevioDoc = null;
            for (;;) {
              const textoDoc = await leerTexto();
              if (/se ha restablecido la conexion/.test(norm(textoDoc))) {
                motivoDoc = 'El portal enseñó su aviso de reconexión («Se ha restablecido la conexión») y la bandeja de «Mis documentos» no cargó: es la flaqueza conocida del SAT con esta bandeja, no un cero.';
                break;
              }
              if (typeof page.evaluate === 'function')
                filasDoc = extractDocumentosRows(await page.evaluate(readTablesSource).catch(() => null));
              if (filasDoc) break;
              if (buzonDocumentosFirma(textoDoc) && /no se encontraron resultados/.test(norm(textoDoc))) { filasDoc = []; break; }
              let urlDoc = '';
              try { urlDoc = typeof page.url === 'function' ? String(page.url() || '') : ''; } catch { /* en transición */ }
              if (/\/app\/seg\/null/.test(urlDoc)) {
                motivoDoc = 'La bandeja de «Mis documentos» cayó en la página muerta del portal durante la lectura: no consta su contenido, no es un cero.';
                break;
              }
              /* Salida temprana honesta: página estable que ni
                 nombra la bandeja — esperar más no la pinta. */
              if (textoPrevioDoc !== null && textoDoc === textoPrevioDoc &&
                  !/documento/.test(norm(textoDoc)) && Date.now() > limiteDoc - Math.min(esperaMs, 8_000) + 2_500) {
                motivoDoc = 'La bandeja de «Mis documentos» no cargó su contenido en esta corrida (la página no la enseñó): no consta, no es un cero.';
                break;
              }
              textoPrevioDoc = textoDoc;
              if (Date.now() >= limiteDoc) {
                motivoDoc = 'La bandeja de «Mis documentos» no cargó en el plazo de espera (su marco tarda o no llega, la flaqueza conocida del SAT con esta bandeja): no consta su contenido, no es un cero.';
                break;
              }
              await sleepMs(400);
            }
            if (filasDoc) {
              documentos240seccion = { concluyente: true, items: filasDoc };
              notifyStep(step, 'Documentos listados', filasDoc.length + ' en la bandeja (solo la lista: no se abrió ningún documento)');
            } else {
              documentos240seccion = { concluyente: false, items: [], motivo: motivoDoc ||
                'La bandeja de «Mis documentos» no enseñó su lista en esta corrida: no consta su contenido, no es un cero.' };
              notifyStep(step, 'Documentos sin listar', documentos240seccion.motivo);
            }
          } catch {
            documentos240seccion = { concluyente: false, items: [],
              motivo: 'La bandeja de «Mis documentos» no se pudo leer en esta corrida: no consta su contenido, no es un cero.' };
            notifyStep(step, 'Documentos sin listar', documentos240seccion.motivo);
          }
        }
      }
      const rows = [...vistas.values()].slice(0, BUZON_MAX_NOTIFICATIONS);
      notifyStep(step, 'Lista leída', rows.length + ' notificación(es) en la bandeja de pendientes');
      return { notifications: rows, comunicadosNoLeidos,
        ...(comunicados240seccion ? { comunicados: comunicados240seccion } : {}),
        ...(documentos240seccion ? { documentos: documentos240seccion } : {}) };
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
