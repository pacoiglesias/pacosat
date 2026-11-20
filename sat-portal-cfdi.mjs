/* ===== Descarga de CFDI por el PORTAL con e.firma (2.9.7 · Pieza A) =====
   Motor hermano del de CIEC (sat-ciec.mjs), sobre el MISMO portal
   «Consulta y recuperación» (portalcfdi.facturaelectronica.sat.gob.mx,
   consultas en ConsultaReceptor.aspx / ConsultaEmisor.aspx y
   descargas por los tokens RecuperaCfdi.aspx?Datos=…), pero con
   DOS diferencias que son su razón de ser:

   - El acceso es con E.FIRMA (satBrowserLogin, el acceso FIEL
     compartido con Buzón y Declaraciones), SIN captcha y sin
     gesto de Paco: sirve en la sede del NAS, desatendido.
   - La consulta NO es por rangos abiertos: es por la LISTA de
     folios pedidos (la de las ventanas atoradas del web service).
     Recibidos se agrupan por día (como obliga el portal) y
     emitidos en ventanas mensuales recortadas a los días con
     ítems; cada fila se casa por UUID contra la lista. Lo que el
     portal no liste para un UUID pedido va a `notListed` — jamás
     se finge una descarga que el portal no enseñó —.

   3.1.0 — LAS CANCELADAS TAMBIÉN BAJAN AL MOMENTO (orden de
   Paco, 20 nov 2026: «que el sistema descargue como OneFactura
   todo al momento, y no pidiendo lotes»). Producción probó con
   la 3.0.0 que el listado por fecha de arriba NO enseña las
   canceladas (las 5 recibidas canceladas de Mano Fil del
   06/11/2026 no salieron; las vigentes del mismo camino sí
   bajan): la consulta nunca fijaba el estado del comprobante.
   Dos pasadas nuevas tras las de siempre, con las primitivas
   OPCIONALES del envoltorio (si la página no las ofrece, la
   corrida acaba exactamente como la 3.0.0):
     1 · ESTADO: los ítems que el metadato marca cancelados
         (estatus «0», que el servidor pasa como `cancelled`) y
         la búsqueda normal no listó se buscan OTRA VEZ por
         fecha con el estado en «cancelados»
         (ciecSetEstadoComprobante).
     2 · FOLIO: cualquier ítem pedido que siga sin listarse se
         consulta por su folio fiscal, uno a uno
         (ciecClickFolioRadio + ciecSetFolio).
   Lo que ni así salga sigue yendo a `notListed`, sin fingir.

   Este caminante SOLO vive en portalcfdi (más el NIDP de cfdiau
   durante el acceso): nunca abre ninguna notificación del Buzón
   ni navega a otra sección del SAT. La suite de la ronda lo
   afirma sobre las URLs visitadas de la réplica.

   API fijada (la integración del servidor se construye contra
   esto):
     createSatPortalCfdiFetch({ resolveCredentials, launchDriver,
       now = () => Date.now() })
       -> satPortalFetch(profile, query, hooks)
     profile = { rfc }
     query   = { items: [{ uuid, direction: 'received'|'issued',
                 issuedAt: 'YYYY-MM-DD', cancelled?: true }],
                 maxDownloads }
                 (`cancelled` — o `status: '0'` — marca los que el
                 metadato del SAT trae cancelados: son los de la
                 pasada de estado de la 3.1.0.)
     hooks   = { step(text, url), isCancelled() }
     Resuelve { files: [{ uuid, name, buffer, pdf? }], found,
       downloaded, notListed: [uuid…], missing: [uuid…],
       complete, notes: [], quotaUsed }
     En fallo duro (acceso/portal) lanza Error con .code y .diag
     ({ url, screenshot, html } de page.diagnostics()), como
     sat-ciec.

   resolveCredentials: el MISMO resolvedor de documentos del
   servidor, createSatDocCredentialResolver (sat-doc-fetch.mjs).
   Su salida (verificada en su código): valida la e.firma EN
   LOCAL antes de abrir el navegador (existe → archivos
   completos → contraseña guardada → caducidad → RFC del
   certificado → pareja llave/certificado) y devuelve
     { fiel, cer, validUntil, rfc, key, password }
   donde cer/key son los Buffer de <RFC>.cer / <RFC>.key de la
   carpeta protegida y password la contraseña de la .key del
   índice perfiles.json. Nada de ese material sale de aquí más
   que hacia el formulario del portal, dentro del navegador.

   Serialización: una sesión cada vez, con la misma cadena de
   promesas de createSatCiecFetch — el portal no admite dos
   sesiones del mismo contribuyente en paralelo —.

   FRONTERA DE CALIBRACIÓN EN VIVO (declarada, no inventada):
   este motor se construyó contra la RÉPLICA DECLARADA de la
   suite (FakePortalFielPage, ronda297portal.test.mjs) porque
   ningún canal de recon alcanzó la sección en vivo desde este
   asiento (nota A0 de la ronda). Lo que la primera corrida real
   debe contrastar: (1) el selector de la puerta de e.firma de
   portalcfdi (primitiva portalOpenEfirmaDoor de
   sat-doc-browser.mjs); (2) si el acceso FIEL aterriza directo
   en portalcfdi o si satBrowserLogin necesita otro aterrizaje;
   (3) de dónde sale el token de PDF de una fila (pdfUrl): hoy
   ciecRows no lo expone, así que en vivo el motor bajará XML
   sin PDF hasta calibrar ese lector; (4) — 3.1.0 — los
   controles del estado del comprobante y del modo folio
   (ciecSetEstadoComprobante / ciecClickFolioRadio /
   ciecSetFolio): se buscan de forma tolerante y la primera
   corrida en vivo contra una cancelada real dice cuál de las
   dos vías la entrega. Cada paso que difiera fallará con
   diagnóstico (captura + HTML), nunca en silencio. */

import { CIEC_PORTAL, CIEC_PAGE_LIMIT, CIEC_DAILY_LIMIT, ciecDayList } from './sat-ciec.mjs';
import { satBrowserLogin, prepareKeyForPortal } from './sat-doc-browser.mjs';

export { CIEC_PORTAL };

function portalFailure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

const pad2 = value => String(value).padStart(2, '0');
const mxLabel = iso => { const [y, m, d] = String(iso).split('-'); return d + '/' + m + '/' + y; };
const looksLikeXml = buffer => Buffer.isBuffer(buffer) && buffer.length > 40 &&
  buffer.subarray(0, Math.min(buffer.length, 4096)).toString('utf8').includes('Comprobante');
const looksLikePdf = buffer => Buffer.isBuffer(buffer) && buffer.length > 5 &&
  buffer.subarray(0, 5).toString('latin1') === '%PDF-';

/* Normaliza la lista pedida: UUID en mayúsculas (así los enseña
   el portal en input.ListaFolios), sin duplicados, en el orden
   en que se pidieron. Un ítem sin fecha o sin dirección válida
   no se puede consultar: se conserva marcado como inválido
   para que acabe en missing con su nota, no en silencio. */
function normalizeItems(query) {
  const seen = new Set();
  const items = [];
  for (const raw of Array.isArray(query?.items) ? query.items : []) {
    const uuid = String(raw?.uuid || '').trim().toUpperCase();
    if (!uuid || seen.has(uuid)) continue;
    seen.add(uuid);
    const direction = raw?.direction === 'issued' ? 'issued' : raw?.direction === 'received' ? 'received' : '';
    const issuedAt = /^\d{4}-\d{2}-\d{2}$/.test(String(raw?.issuedAt || '')) ? String(raw.issuedAt) : '';
    /* La marca de cancelada (3.1.0): el servidor la pasa como
       `cancelled` desde el estatus del metadato; se acepta
       también el estatus crudo ('0') por si un llamador lo trae
       así. Sin marca, el ítem es de la búsqueda normal. */
    const cancelled = raw?.cancelled === true || String(raw?.status ?? '') === '0';
    items.push({ uuid, direction, issuedAt, valid: Boolean(direction && issuedAt), cancelled });
  }
  return items;
}

export function createSatPortalCfdiFetch({ resolveCredentials, launchDriver, now = () => Date.now() } = {}) {
  if (typeof resolveCredentials !== 'function') throw new Error('createSatPortalCfdiFetch necesita resolveCredentials.');
  if (typeof launchDriver !== 'function') throw new Error('createSatPortalCfdiFetch necesita launchDriver.');
  void now; /* la contabilidad diaria (y su reloj) la lleva el servidor; el motor solo respeta el techo de la corrida */

  let chain = Promise.resolve();

  const run = async (profile, query, hooks) => {
    const step = (text, url) => { try { hooks?.step?.(text, url || ''); } catch { /* el progreso nunca tumba la corrida */ } };
    const isCancelled = () => { try { return Boolean(hooks?.isCancelled?.()); } catch { return false; } };
    const items = normalizeItems(query);
    const maxDownloads = Number.isFinite(Number(query?.maxDownloads)) && query?.maxDownloads != null
      ? Math.max(0, Math.floor(Number(query.maxDownloads))) : items.length;

    const notes = [];
    const files = [];
    const foundRows = new Map(); /* uuid -> fila del portal */
    const queried = new Set(); /* uuid cuya consulta sí corrió */
    let quota = '';
    let quotaUsed = 0;
    let cancelled = false;
    let relogged = false;

    const creds = await resolveCredentials(profile); /* valida ANTES de abrir el navegador */
    if (!creds) throw portalFailure('sin-efirma', 'No hay e.firma guardada para ' +
      String(profile?.rfc || '') + ': sin ella el portal no deja entrar.');

    let driver;
    try { driver = await launchDriver(); }
    catch (error) {
      throw portalFailure('navegador-no-disponible',
        'El navegador interno no arrancó: ' + (error?.message || error));
    }
    let page = null;
    try {
      page = await driver.newPage();

      /* Acceso con e.firma, sin captcha. Si el portal enseña
         primero su puerta de contraseña, la primitiva opcional
         portalOpenEfirmaDoor() pulsa su control de e.firma si
         está presente (devuelve false si el formulario FIEL ya
         está a la vista o si no hay puerta: en ambos casos manda
         satBrowserLogin, que abre el formulario por #buttonFiel
         como en los demás paseos). Después, el aterrizaje válido
         es el mismo test de ciecLogin: URL en portalcfdi y fuera
         del NIDP de cfdiau. */
      const login = async () => {
        step('Conectando con el portal del SAT…', '');
        await page.goto(CIEC_PORTAL);
        if (String(page.url()).includes('Error.aspx'))
          throw portalFailure('sesion-invalida', 'El portal del SAT devolvió su página de error de sesión al entrar. Inténtalo de nuevo en unos minutos.');
        if (typeof page.portalOpenEfirmaDoor === 'function') {
          const opened = await page.portalOpenEfirmaDoor().catch(() => false);
          if (opened) step('Abriendo el acceso con e.firma del portal…', page.url());
        }
        const keyMaterial = Buffer.isBuffer(creds.key)
          ? prepareKeyForPortal(creds.key, creds.password) : null;
        await satBrowserLogin(page, {
          cer: creds.cer, key: keyMaterial ? keyMaterial.buffer : creds.key,
          password: creds.password, rfc: creds.rfc || profile?.rfc,
          entryUrl: CIEC_PORTAL, landingUrl: CIEC_PORTAL,
          hooks: { step: (text, url) => step(text, url) }
        });
        const landedUrl = String(page.url() || '');
        if (!(landedUrl.includes('portalcfdi') && !landedUrl.includes('cfdiau')))
          throw portalFailure('respuesta-inesperada',
            'El acceso con e.firma no aterrizó en el portal de consulta (última pantalla: ' +
            (landedUrl || 'sin URL') + '). El diario de la corrida guarda la foto de la página para revisarla.');
        step('Ya estás dentro del portal.', page.url());
      };
      const sessionGuard = async () => {
        if (!String(page.url()).includes('Error.aspx')) return;
        if (relogged) throw portalFailure('sesion-invalida',
          'El portal cerró la sesión a mitad de la corrida (su página de error apareció dos veces). Lo que se haya podido bajar se guarda igual; vuelve a lanzar la corrida para el resto.');
        relogged = true;
        step('El portal cerró la sesión: entro de nuevo…', '');
        await login();
      };

      await login();

      /* ---------- Consultas por la lista ---------- */
      const absorb = (rowsResult, wanted) => {
        if (rowsResult?.quota) quota = rowsResult.quota;
        for (const row of rowsResult?.rows || []) {
          const uuid = String(row?.uuid || '').trim().toUpperCase();
          if (uuid && wanted.has(uuid) && !foundRows.has(uuid)) foundRows.set(uuid, row);
        }
        return (rowsResult?.rows || []).length >= CIEC_PAGE_LIMIT;
      };
      const ensureOn = async (name) => {
        if (!String(page.url()).includes(name)) await page.goto(CIEC_PORTAL + name + '.aspx');
        await sessionGuard();
        if (!String(page.url()).includes(name)) await page.goto(CIEC_PORTAL + name + '.aspx');
      };
      /* El estado del comprobante (3.1.0): sin estado pedido,
         la consulta es la de siempre. Con estado, hace falta la
         primitiva opcional del envoltorio; si la página no la
         ofrece o no logra fijarlo, la consulta devuelve null —
         «esta vía no existe aquí» — y la pasada que la pidió se
         salta sin fingir una búsqueda que no se hizo. */
      const setEstado = async (estado) => {
        if (typeof page.ciecSetEstadoComprobante !== 'function') return false;
        return page.ciecSetEstadoComprobante(estado).catch(() => false);
      };
      const queryReceivedDay = async (dayIso, estado = '') => {
        const [day] = ciecDayList(dayIso, dayIso);
        await ensureOn('ConsultaReceptor');
        if (!(await page.ciecClickFechasRadio().catch(() => false)) ||
            !(await page.ciecSetRecibidosDay(day).catch(() => false)))
          throw portalFailure('respuesta-inesperada',
            'La consulta de recibidos del portal no enseñó los controles de fecha esperados. El diario de la corrida guarda la foto de la página para revisarla.');
        if (estado && !(await setEstado(estado))) return null;
        step('Buscando tus facturas ' + (estado === 'cancelado' ? 'canceladas ' : '') +
          'recibidas del ' + day.label + '…', '');
        await page.ciecSearch();
        if (!(await page.ciecWaitResults(60000).catch(() => false)))
          throw portalFailure('respuesta-inesperada',
            'La búsqueda de recibidos del ' + day.label + ' no terminó en el portal. El diario de la corrida guarda la foto de la página para revisarla.');
        return page.ciecRows();
      };
      const queryIssuedRange = async (fromIso, toIso, estado = '') => {
        await ensureOn('ConsultaEmisor');
        if (!(await page.ciecClickFechasRadio().catch(() => false)) ||
            !(await page.ciecSetEmitidosRange({ from: mxLabel(fromIso), to: mxLabel(toIso) }).catch(() => false)))
          throw portalFailure('respuesta-inesperada',
            'La consulta de emitidos del portal no enseñó los controles de fecha esperados. El diario de la corrida guarda la foto de la página para revisarla.');
        if (estado && !(await setEstado(estado))) return null;
        step('Buscando tus facturas ' + (estado === 'cancelado' ? 'canceladas ' : '') +
          'emitidas del ' + mxLabel(fromIso) + ' al ' + mxLabel(toIso) + '…', '');
        await page.ciecSearch();
        if (!(await page.ciecWaitResults(60000).catch(() => false)))
          throw portalFailure('respuesta-inesperada',
            'La búsqueda de emitidos del ' + mxLabel(fromIso) + ' al ' + mxLabel(toIso) + ' no terminó en el portal. El diario de la corrida guarda la foto de la página para revisarla.');
        return page.ciecRows();
      };
      /* La consulta por folio fiscal (3.1.0): el otro modo del
         portal — radio de folio + la caja con el UUID — y las
         filas que devuelva. null si la página no ofrece el modo
         o la búsqueda no termina: la pasada se corta ahí, sin
         insistir folio a folio contra un portal que no responde
         por esta vía. */
      const queryByFolio = async (item) => {
        await ensureOn(item.direction === 'issued' ? 'ConsultaEmisor' : 'ConsultaReceptor');
        if (!(await page.ciecClickFolioRadio().catch(() => false)) ||
            !(await page.ciecSetFolio(item.uuid).catch(() => false)))
          return null;
        step('Buscando el folio ' + item.uuid + ' directamente en el portal…', '');
        await page.ciecSearch();
        if (!(await page.ciecWaitResults(60000).catch(() => false))) return null;
        return page.ciecRows();
      };

      /* Las pasadas por fecha, parametrizadas por el estado
         (3.1.0): sin estado son las consultas de siempre; con
         'cancelado' son la pasada de canceladas. Devuelven
         false SOLO cuando la vía del estado no existe en esta
         página (la consulta devolvió null): la pasada se salta
         entera, sin repetir en vano la búsqueda normal. */
      const groupReceivedByDay = (list) => {
        const byDay = new Map();
        for (const item of list) {
          if (!byDay.has(item.issuedAt)) byDay.set(item.issuedAt, []);
          byDay.get(item.issuedAt).push(item);
        }
        return byDay;
      };
      const groupIssuedByMonth = (list) => {
        const byMonth = new Map();
        for (const item of list) {
          const month = item.issuedAt.slice(0, 7);
          if (!byMonth.has(month)) byMonth.set(month, []);
          byMonth.get(month).push(item);
        }
        return [...byMonth.values()].sort((a, b) => a[0].issuedAt.localeCompare(b[0].issuedAt));
      };
      const runReceivedDays = async (byDay, estado = '') => {
        for (const [dayIso, dayItems] of [...byDay.entries()].sort()) {
          if (isCancelled()) { cancelled = true; break; }
          const wanted = new Set(dayItems.map(i => i.uuid));
          const rowsResult = await queryReceivedDay(dayIso, estado);
          if (rowsResult === null) return false;
          const truncated = absorb(rowsResult, wanted);
          for (const item of dayItems) queried.add(item.uuid);
          if (truncated) {
            /* Recibidos ya va día a día: no se puede partir más.
               Lo que no salga en esas 500 filas queda en
               notListed, con esta nota como explicación. */
            const note = 'El portal enseñó ' + CIEC_PAGE_LIMIT + ' recibidos el ' +
              mxLabel(dayIso) + ': puede haber más ese día que el portal no lista de una vez; los pedidos que no salgan quedan en «no listados».';
            notes.push(note); step('⚠ ' + note, '');
          }
          await sessionGuard();
        }
        return true;
      };
      const runIssuedWindows = async (monthGroups, estado = '') => {
        for (const monthItems of monthGroups) {
          if (isCancelled()) { cancelled = true; break; }
          const days = monthItems.map(i => i.issuedAt).sort();
          const from = days[0], to = days[days.length - 1];
          const wanted = new Set(monthItems.map(i => i.uuid));
          const rowsResult = await queryIssuedRange(from, to, estado);
          if (rowsResult === null) return false;
          const truncated = absorb(rowsResult, wanted);
          for (const item of monthItems) queried.add(item.uuid);
          if (truncated) {
            /* Ventana partida por días y reintentada, como pide
               la regla: cada día de la ventana como rango de un
               solo día en ConsultaEmisor. */
            const note = 'El portal enseñó ' + CIEC_PAGE_LIMIT + ' emitidos en la ventana ' +
              mxLabel(from) + '–' + mxLabel(to) + ': parto la ventana por días y reintento.';
            notes.push(note); step('⚠ ' + note, '');
            for (const day of ciecDayList(from, to)) {
              if (isCancelled()) { cancelled = true; break; }
              const dayRows = await queryIssuedRange(day.iso, day.iso, estado);
              if (dayRows === null) return false;
              const stillTruncated = absorb(dayRows, wanted);
              if (stillTruncated) {
                const dayNote = 'El portal enseñó ' + CIEC_PAGE_LIMIT + ' emitidos también el ' +
                  day.label + ': los pedidos que no salgan quedan en «no listados».';
                notes.push(dayNote); step('⚠ ' + dayNote, '');
              }
            }
          }
          await sessionGuard();
          if (cancelled) break;
        }
        return true;
      };

      /* Recibidos: agrupados por día. */
      await runReceivedDays(groupReceivedByDay(
        items.filter(i => i.valid && i.direction === 'received')));

      /* Emitidos: ventanas mensuales recortadas a los días con
         ítems (de su primer día con ítems a su último). */
      if (!cancelled) {
        await runIssuedWindows(groupIssuedByMonth(
          items.filter(i => i.valid && i.direction === 'issued')));
      }

      /* ---------- Pasada de canceladas (3.1.0) ----------
         Los ítems que el metadato marca cancelados y la
         búsqueda normal no listó se buscan otra vez por fecha
         con el estado en «cancelados», en los dos sentidos y
         con las mismas agrupaciones. Si la página no ofrece el
         desplegable de estado, las pasadas devuelven false y
         esto no deja ni nota: queda la pasada por folio y, en
         su caso, el cierre honesto de siempre. */
      if (!cancelled) {
        const pendientesCancelados = items.filter(i =>
          i.valid && i.cancelled && !foundRows.has(i.uuid));
        if (pendientesCancelados.length) {
          const antes = foundRows.size;
          await runReceivedDays(groupReceivedByDay(
            pendientesCancelados.filter(i => i.direction === 'received')), 'cancelado');
          if (!cancelled) {
            await runIssuedWindows(groupIssuedByMonth(
              pendientesCancelados.filter(i => i.direction === 'issued')), 'cancelado');
          }
          const traidas = foundRows.size - antes;
          if (traidas > 0) {
            const note = traidas + (traidas === 1 ? ' folio no salía' : ' folios no salían') +
              ' en el listado normal por estar cancelados: ' +
              (traidas === 1 ? 'salió' : 'salieron') + ' al buscar entre las canceladas del portal.';
            notes.push(note); step('⚠ ' + note, '');
          }
        }
      }

      /* ---------- Pasada por folio (3.1.0) ----------
         Todo ítem pedido que siga sin listarse — cancelado o
         no — se consulta por su folio fiscal, uno a uno, en su
         página (Receptor o Emisor). Antes se intenta devolver
         el estado a «todos», para que un filtro quedado de la
         pasada anterior no esconda un folio vigente. Si la
         página no ofrece el modo folio, ni se intenta; si una
         consulta por folio no responde, la pasada se corta
         (los folios ya se pidieron por fecha: quedan en «no
         listados», sin fingir). */
      if (!cancelled) {
        const pendientes = items.filter(i => i.valid && !foundRows.has(i.uuid));
        if (pendientes.length &&
            typeof page.ciecClickFolioRadio === 'function' &&
            typeof page.ciecSetFolio === 'function') {
          await setEstado('todos');
          const antes = foundRows.size;
          for (const item of pendientes) {
            if (isCancelled()) { cancelled = true; break; }
            const rowsResult = await queryByFolio(item);
            if (rowsResult === null) break;
            absorb(rowsResult, new Set([item.uuid]));
            queried.add(item.uuid);
            await sessionGuard();
          }
          const traidas = foundRows.size - antes;
          if (traidas > 0) {
            const note = traidas + (traidas === 1 ? ' folio salió' : ' folios salieron') +
              ' al consultarlos por su folio fiscal en el portal.';
            notes.push(note); step('⚠ ' + note, '');
          }
        }
      }

      const invalidItems = items.filter(i => !i.valid);
      if (invalidItems.length) {
        const note = 'Hay ' + invalidItems.length + ' folio(s) pedidos sin fecha o sin dirección válida: no se pueden consultar en el portal y quedan en «pendientes».';
        notes.push(note); step('⚠ ' + note, '');
      }

      const notListed = [];
      const missing = [];
      for (const item of items) {
        if (!item.valid) { missing.push(item.uuid); continue; }
        if (foundRows.has(item.uuid)) continue;
        if (cancelled && !queried.has(item.uuid)) { missing.push(item.uuid); continue; }
        notListed.push(item.uuid);
      }
      if (notListed.length && !cancelled) {
        const note = 'El portal no listó ' + notListed.length + ' de los folios pedidos: quedan en «no listados», sin fingir su descarga.';
        notes.push(note); step('⚠ ' + note, '');
      }

      /* ---------- Descargas por ítem ---------- */
      if (cancelled) {
        notes.push('Corrida cancelada: se guarda lo bajado y el resto queda pendiente (cancelado).');
        for (const item of items) {
          if (foundRows.has(item.uuid) && !missing.includes(item.uuid)) missing.push(item.uuid);
        }
      } else if (quota === 'CuotaCompleta') {
        const note = 'El portal dice que el cupo de descargas de hoy para este RFC ya está completo (~' +
          CIEC_DAILY_LIMIT + ' al día): no descargo nada ahora para no quemar intentos. Prueba mañana.';
        notes.push(note); step('⚠ ' + note, '');
        for (const item of items) {
          if (foundRows.has(item.uuid)) missing.push(item.uuid);
        }
      } else {
        let failures = 0;
        let ceilingNoted = false;
        for (const item of items) {
          if (!foundRows.has(item.uuid)) continue;
          if (isCancelled()) {
            cancelled = true;
            notes.push('Corrida cancelada: se guarda lo bajado y el resto queda pendiente (cancelado).');
            for (const rest of items) {
              if (foundRows.has(rest.uuid) && !files.some(f => f.uuid === rest.uuid) &&
                  !missing.includes(rest.uuid)) missing.push(rest.uuid);
            }
            break;
          }
          if (quotaUsed >= maxDownloads) {
            if (!ceilingNoted) {
              ceilingNoted = true;
              const note = 'Techo de esta corrida alcanzado (' + maxDownloads +
                ' XML): el resto queda para la red del web service.';
              notes.push(note); step('⚠ ' + note, '');
            }
            missing.push(item.uuid);
            continue;
          }
          await sessionGuard();
          const row = foundRows.get(item.uuid);
          const buffer = row.url ? await page.ciecDownloadXml(row.url).catch(() => null) : null;
          if (!looksLikeXml(buffer)) {
            failures++;
            missing.push(item.uuid);
            const note = 'La descarga de ' + item.uuid + ' no entregó un XML válido: queda en «pendientes».';
            notes.push(note); step('⚠ ' + note, '');
            if (failures >= 3) {
              const stopNote = 'Tres descargas seguidas fallaron en el portal (suele ser el cupo del día o un corte del portal): paro aquí con ' +
                files.length + ' facturas guardadas.';
              notes.push(stopNote); step('⚠ ' + stopNote, '');
              for (const rest of items) {
                if (foundRows.has(rest.uuid) && !files.some(f => f.uuid === rest.uuid) &&
                    !missing.includes(rest.uuid)) missing.push(rest.uuid);
              }
              break;
            }
            continue;
          }
          failures = 0;
          const file = { uuid: item.uuid, name: item.uuid + '.xml', buffer };
          /* PDF solo si la fila lo trae Y la página lo ofrece:
             si no, se sigue sin PDF y sin nota (el portal no lo
             ofreció). Un PDF que no parece PDF no se adjunta. */
          if (row.pdfUrl && typeof page.ciecDownloadPdf === 'function') {
            const pdf = await page.ciecDownloadPdf(row.pdfUrl).catch(() => null);
            if (looksLikePdf(pdf)) file.pdf = pdf;
          }
          files.push(file);
          quotaUsed++;
          if (files.length % 25 === 0)
            step('Descargando tus facturas (' + files.length + ' de ' + foundRows.size + ')…', '');
        }
      }

      const complete = !cancelled && files.length === items.length &&
        notListed.length === 0 && missing.length === 0;
      step('El portal encontró ' + foundRows.size + ' de ' + items.length +
        ' facturas pedidas y bajó ' + files.length + '.', '');
      return { files, found: foundRows.size, downloaded: files.length,
        notListed, missing, complete, notes, quotaUsed };
    } catch (error) {
      if (error && typeof error === 'object' && !error.diag && page &&
          typeof page.diagnostics === 'function') {
        const diag = await page.diagnostics().catch(() => null);
        if (diag) error.diag = diag;
      }
      throw error;
    } finally {
      await driver.close().catch(() => {});
    }
  };

  return function satPortalFetch(profile, query, hooks) {
    const result = chain.then(() => run(profile, query, hooks), () => run(profile, query, hooks));
    chain = result.catch(() => {});
    return result;
  };
}
