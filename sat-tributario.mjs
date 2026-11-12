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

export const BUZON_ENTRY_URL = 'https://wwwmat.sat.gob.mx/personas/login/mis-notificaciones';
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

/* El lector del DOM: devuelve las tablas visibles con sus
   encabezados y celdas — LECTURA PURA, ningún clic. Se evalúa
   una sola vez, ya dentro de la bandeja. */
function readTablesSource() {
  const clean = el => String(el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
  const tables = [];
  for (const table of document.querySelectorAll('table')) {
    const headers = [...table.querySelectorAll('thead th, tr:first-child th')].map(clean);
    const rows = [...table.querySelectorAll('tbody tr, tr')]
      .filter(tr => tr.querySelectorAll('td').length)
      .map(tr => [...tr.querySelectorAll('td')].map(clean));
    if (headers.length && rows.length) tables.push({ headers, rows });
  }
  return tables;
}
/* Los enlaces de la página, leídos (no pulsados), con su
   posición: `inTable` marca los que viven DENTRO de una tabla —
   ahí están las notificaciones, no la navegación, y ningún
   rescate puede seguirlos (H-2.1). */
function readLinksSource() {
  return [...document.querySelectorAll('a[href]')].map(a => ({
    text: String(a.innerText || a.textContent || '').replace(/\s+/g, ' ').trim(),
    href: a.href || '',
    inTable: Boolean(a.closest && a.closest('table')) }));
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
   «respuesta-inesperada» en el diario, sin navegar. */
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

export function pickBuzonRescueLink(links) {
  for (const link of Array.isArray(links) ? links : []) {
    const parts = buzonLinkSafeParts(link);
    if (!parts) continue;
    /* Ruta de lista conocida: el destino manda. */
    if (['mis-notificaciones', 'mis-comunicados', 'buzon-tributario']
      .some(route => parts.segments.includes(route))) return link;
    /* Etiqueta de menú o pestaña de bandeja, exacta. */
    if (['buzon tributario', 'mis notificaciones', 'mis comunicados',
      'bandeja', 'bandeja de entrada', 'notificaciones'].includes(norm(link.text || ''))) return link;
  }
  return null;
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
      /* El acceso va por el lanzador (la puerta probada en vivo)
         y la bandeja se alcanza después con la sesión abierta;
         entrar directo a la bandeja murió en el acceso en la
         corrida viva del 11 nov 2026. */
      await satBrowserLogin(page, { cer: creds.cer, key: keyMaterial.buffer,
        password: creds.password, entryUrl: loginUrl,
        hooks: { step: text => notifyStep(step, 'Acceso: ' + text) } });
      notifyStep(step, 'Acceso al portal OK', '');
      if (typeof page.goto === 'function') {
        await page.goto(entryUrl).catch(() => {});
        notifyStep(step, 'Voy a la bandeja del Buzón', 'con la sesión ya abierta, sin abrir ninguna notificación');
      }
      /* Hasta la bandeja SIN tocar ninguna notificación: si la
         página de aterrizaje no es ya la bandeja, el rescate
         sigue SOLO un enlace de LISTA del menú del portal
         (pickBuzonRescueLink): ni un enlace dentro de una
         tabla ni uno con pinta de detalle pasan jamás — mejor
         morir con «respuesta-inesperada» que abrir una
         notificación por accidente (H-2.1). */
      let text = await page.text();
      if (!buzonBandejaVisible(text)) {
        notifyStep(step, 'Busco la bandeja', 'sigo solo un enlace de lista del menú, sin abrir ninguna notificación');
        const links = await page.evaluate(readLinksSource);
        const target = pickBuzonRescueLink(links);
        if (target?.href) { await page.goto(target.href); text = await page.text(); }
      }
      if (!buzonBandejaVisible(text))
        throw failure('respuesta-inesperada', 'El portal no enseñó la bandeja del Buzón Tributario tras el acceso ' +
          'con e.firma: su plantilla puede haber cambiado. No se abrió ninguna notificación.');
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
         la página, y ese fallo quedó ciego. */
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
