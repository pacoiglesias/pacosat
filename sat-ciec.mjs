/* ===== Descarga de CFDI por CIEC (1.12.0) =====
   El servicio masivo de descarga del SAT solo admite e.firma; un
   RFC sin e.firma solo puede bajar sus CFDI por el portal web de
   consulta (portalcfdi), con RFC + contraseña CIEC y un captcha
   por acceso. Este módulo es el motor de esa vía:

   - Entra al portal con el Chromium interno (mismo driver que el
     descargador de documentos y el de declaraciones).
   - El CAPTCHA es el gesto de Paco: el motor se PAUSA y pide el
     texto por el gancho `askCaptcha` (la pantalla enseña la imagen
     y él escribe lo que ve); el motor solo teclea lo que él dio.
   - Consulta RECIBIDOS (día a día, como obliga el portal) y
     EMITIDOS (rango completo) y descarga los XML uno a uno.
   - Devuelve los XML en memoria; quien llama (el servidor) los
     ingresa por el MISMO camino que la carpeta vigilada, así que
     acaban en el mismo almacén, con la misma Vigilancia.

   Contrato del portal (documentado por la implementación de
   referencia de código abierto sat-dm como confirmado contra el
   portal real, y contrastado en lo público contra la página de
   acceso de cfdiau): el acceso cae en el NIDP del SAT con el
   formulario #rfc / #password / #userCaptcha, la imagen del
   captcha como <img src="data:image…"> y el envío en #submit.
   Las consultas viven en ConsultaReceptor.aspx (radio
   #ctl00_MainContent_RdoFechas, que hay que pulsar de forma
   nativa para que el postback habilite las fechas; desplegables
   de año/mes/día/hora) y ConsultaEmisor.aspx (fechas en cajas de
   texto de solo lectura que se fuerzan por script). Los
   resultados llegan TODOS en el DOM tras una búsqueda (máx. 500
   por consulta): cada fila trae su folio en input.ListaFolios y
   el token de descarga en el onclick de span[name=BtnDescarga]
   (RecuperaCfdi.aspx?Datos=…). El cupo diario (~2.000) lo
   anuncia el propio portal en su campo hfDescarga. Lo que no se
   ha podido contrastar sin la CIEC de Paco queda declarado en el
   informe: si el portal real difiere, cada paso falla con
   diagnóstico (captura + HTML) en el diario, nunca en silencio. */

export const CIEC_PORTAL = 'https://portalcfdi.facturaelectronica.sat.gob.mx/';
export const CIEC_MAX_CAPTCHA_ATTEMPTS = 3;
export const CIEC_DAILY_LIMIT = 2000;
export const CIEC_PAGE_LIMIT = 500;

function ciecFailure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/* Clasificación del error que pinta el portal tras enviar el
   acceso: primero se mira si habla del captcha (un mensaje que
   menciona la imagen es del captcha aunque también diga
   «incorrecto»); después, si habla de credenciales. Sin pista,
   se trata como desconocido y el bucle reintenta con captcha
   nuevo hasta el máximo. */
const CAPTCHA_WORDS = ['captcha', 'imagen', 'caracteres', 'código de la imagen', 'texto de la imagen'];
const CREDENTIAL_WORDS = ['contraseña', 'rfc', 'usuario', 'clave', 'incorrect', 'inválid', 'invalid'];
export function classifyCiecLoginError(text) {
  const value = String(text || '').toLowerCase();
  if (!value) return 'unknown';
  if (CAPTCHA_WORDS.some(word => value.includes(word))) return 'captcha';
  if (CREDENTIAL_WORDS.some(word => value.includes(word))) return 'credentials';
  return 'unknown';
}

const pad2 = value => String(value).padStart(2, '0');
export function ciecDayList(start, end) {
  const days = [];
  const from = Date.parse(start + 'T00:00:00Z'), to = Date.parse(end + 'T00:00:00Z');
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return days;
  for (let at = from; at <= to && days.length < 366; at += 86400000) {
    const date = new Date(at);
    days.push({ iso: date.toISOString().slice(0, 10),
      yyyy: String(date.getUTCFullYear()), mm: pad2(date.getUTCMonth() + 1), dd: pad2(date.getUTCDate()),
      label: pad2(date.getUTCDate()) + '/' + pad2(date.getUTCMonth() + 1) + '/' + date.getUTCFullYear() });
  }
  return days;
}
const mxLabel = iso => { const [y, m, d] = String(iso).split('-'); return d + '/' + m + '/' + y; };
const looksLikeXml = buffer => Buffer.isBuffer(buffer) && buffer.length > 40 &&
  buffer.subarray(0, Math.min(buffer.length, 4096)).toString('utf8').includes('Comprobante');

/* Acceso al portal con hasta 3 captchas. Devuelve cuando la URL
   ya vive en el portal y fuera del NIDP; lanza el fallo claro
   que toque (credenciales, captcha agotado o espera agotada). */
async function ciecLogin(page, { rfc, ciec }, hooks) {
  let lastErrorText = '';
  for (let attempt = 1; attempt <= CIEC_MAX_CAPTCHA_ATTEMPTS; attempt++) {
    hooks.step('Conectando con el portal del SAT…', page.url());
    await page.goto(CIEC_PORTAL);
    if (String(page.url()).includes('Error.aspx'))
      throw ciecFailure('sesion-invalida', 'El portal del SAT devolvió su página de error de sesión al entrar. Inténtalo de nuevo en unos minutos.');
    let form = false;
    for (let waited = 0; waited < 30 && !form; waited++) {
      form = await page.ciecHasLoginForm().catch(() => false);
      if (!form) await new Promise(resolve => setTimeout(resolve, 1000));
    }
    if (!form) throw ciecFailure('respuesta-inesperada',
      'La página de acceso del SAT no enseñó el formulario de contraseña y captcha que PacoSAT esperaba. El diario de la corrida guarda la foto de la página para revisarla.');
    hooks.step('Tecleando tu RFC y tu contraseña…', '');
    const filled = await page.ciecFillLogin({ rfc, password: ciec, captcha: '' });
    if (!filled.rfc || !filled.password || !filled.captcha) throw ciecFailure('respuesta-inesperada',
      'El formulario de acceso del portal no tiene los campos esperados (RFC, contraseña y captcha). El diario de la corrida guarda la foto de la página para revisarla.');
    let image = '';
    for (let waited = 0; waited < 10 && !image; waited++) {
      image = await page.ciecCaptchaImage().catch(() => '');
      if (!image) await new Promise(resolve => setTimeout(resolve, 700));
    }
    if (!image) throw ciecFailure('respuesta-inesperada',
      'El portal no enseñó la imagen del captcha. El diario de la corrida guarda la foto de la página para revisarla.');
    hooks.step('El portal pide el captcha: escríbelo en esta pantalla para seguir.', '');
    const text = await hooks.askCaptcha(image, attempt, CIEC_MAX_CAPTCHA_ATTEMPTS);
    if (!text) throw ciecFailure('captcha-sin-respuesta',
      'Se acabó el tiempo de espera sin que escribieras el captcha, así que la descarga se cerró. Vuelve a lanzarla cuando puedas atenderla.');
    await page.ciecFillLogin({ rfc, password: ciec, captcha: text });
    await page.ciecSubmitLogin();
    /* Aterrizaje: la URL sale del NIDP y vive en el portal, o el
       portal pinta su error y se clasifica. Presupuesto generoso
       (35 s): el acceso puede tardar decenas de segundos en un
       portal lento, pero un error pintado corta la espera. */
    let landed = false;
    for (let waited = 0; waited < 70 && !landed; waited++) {
      const url = String(page.url());
      landed = url.includes('portalcfdi') && !url.includes('cfdiau');
      if (landed) break;
      if (await page.ciecErrorText().catch(() => '')) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (landed) { hooks.step('Ya estás dentro del portal.', page.url()); return; }
    lastErrorText = await page.ciecErrorText().catch(() => '');
    if (classifyCiecLoginError(lastErrorText) === 'credentials')
      throw ciecFailure('credenciales', 'El SAT rechazó el acceso: revisa que el RFC y la contraseña CIEC guardados sean los de este contribuyente. El portal dijo: «' + lastErrorText + '»');
    if (attempt < CIEC_MAX_CAPTCHA_ATTEMPTS)
      hooks.step('El portal no aceptó ese captcha: te enseño el nuevo.', '');
  }
  throw ciecFailure('captcha-rechazado', 'El portal no aceptó el captcha en ' + CIEC_MAX_CAPTCHA_ATTEMPTS +
    ' intentos, así que la descarga terminó.' + (lastErrorText ? ' El portal dijo: «' + lastErrorText + '»' : ''));
}

/* Motor completo de una corrida CIEC. `page` es la página del
   driver interno (primitivas ciec* del envoltorio del navegador);
   `hooks.step(texto, url)` alimenta el progreso en vivo y el
   diario; `hooks.askCaptcha(imagen, intento, máximo)` pausa la
   corrida hasta que Paco escribe el captcha (o devuelve null si
   la espera se agota). Devuelve los XML en memoria y la cuenta
   honesta de la corrida: lo encontrado, lo descargado y si el
   portal entregó todo o solo una parte. */
export async function fetchCfdiViaCiec(page, { rfc, ciec, start, end, direction }, hooks) {
  const notes = [];
  let relogged = false;
  try {
    await ciecLogin(page, { rfc, ciec }, hooks);
    const found = new Map();
    let quota = '';
    const collect = (rows, truncatedLabel) => {
      if (rows.quota) quota = rows.quota;
      if (rows.rows.length >= CIEC_PAGE_LIMIT) {
        notes.push(truncatedLabel);
        hooks.step('⚠ ' + truncatedLabel, '');
      }
      for (const row of rows.rows) {
        if (row.uuid && row.url && !found.has(row.uuid)) found.set(row.uuid, row);
      }
    };
    const sessionGuard = async () => {
      if (!String(page.url()).includes('Error.aspx')) return;
      if (relogged) throw ciecFailure('sesion-invalida',
        'El portal cerró la sesión a mitad de la descarga (su página de error apareció dos veces). Lo que se haya podido bajar se guarda igual; vuelve a lanzar la descarga para el resto.');
      relogged = true;
      hooks.step('El portal cerró la sesión: entro de nuevo…', '');
      await ciecLogin(page, { rfc, ciec }, hooks);
    };
    if (direction !== 'issued') {
      for (const day of ciecDayList(start, end)) {
        if (!String(page.url()).includes('ConsultaReceptor'))
          await page.goto(CIEC_PORTAL + 'ConsultaReceptor.aspx');
        await sessionGuard();
        if (!String(page.url()).includes('ConsultaReceptor'))
          await page.goto(CIEC_PORTAL + 'ConsultaReceptor.aspx');
        if (!(await page.ciecClickFechasRadio().catch(() => false)) ||
            !(await page.ciecSetRecibidosDay(day).catch(() => false)))
          throw ciecFailure('respuesta-inesperada',
            'La consulta de recibidos del portal no enseñó los controles de fecha esperados. El diario de la corrida guarda la foto de la página para revisarla.');
        hooks.step('Buscando tus facturas recibidas del ' + day.label + '…', '');
        await page.ciecSearch();
        if (!(await page.ciecWaitResults(60000).catch(() => false)))
          throw ciecFailure('respuesta-inesperada',
            'La búsqueda de recibidos del ' + day.label + ' no terminó en el portal. El diario de la corrida guarda la foto de la página para revisarla.');
        collect(await page.ciecRows(), 'El portal enseñó ' + CIEC_PAGE_LIMIT + ' recibidos el ' + day.label +
          ': puede haber más ese día que el portal no lista de una vez. Descargo los que enseña; parte el rango en días sueltos si necesitas el resto.');
      }
    }
    if (direction !== 'received') {
      if (!String(page.url()).includes('ConsultaEmisor'))
        await page.goto(CIEC_PORTAL + 'ConsultaEmisor.aspx');
      await sessionGuard();
      if (!String(page.url()).includes('ConsultaEmisor'))
        await page.goto(CIEC_PORTAL + 'ConsultaEmisor.aspx');
      if (!(await page.ciecClickFechasRadio().catch(() => false)) ||
          !(await page.ciecSetEmitidosRange({ from: mxLabel(start), to: mxLabel(end) }).catch(() => false)))
        throw ciecFailure('respuesta-inesperada',
          'La consulta de emitidos del portal no enseñó los controles de fecha esperados. El diario de la corrida guarda la foto de la página para revisarla.');
      hooks.step('Buscando tus facturas emitidas del ' + mxLabel(start) + ' al ' + mxLabel(end) + '…', '');
      await page.ciecSearch();
      if (!(await page.ciecWaitResults(60000).catch(() => false)))
        throw ciecFailure('respuesta-inesperada',
          'La búsqueda de emitidos no terminó en el portal. El diario de la corrida guarda la foto de la página para revisarla.');
      collect(await page.ciecRows(), 'El portal enseñó ' + CIEC_PAGE_LIMIT + ' emitidos en el rango' +
        ': puede haber más que el portal no lista de una vez. Descargo los que enseña; parte el rango en periodos más cortos si necesitas el resto.');
    }
    hooks.step('El portal encontró ' + found.size + ' facturas en el rango.', '');
    const entries = [...found.values()];
    const files = [];
    let complete = notes.length === 0;
    if (quota === 'CuotaCompleta') {
      complete = false;
      const note = 'El portal dice que el cupo de descargas de hoy para este RFC ya está completo (~' +
        CIEC_DAILY_LIMIT + ' al día): no descargo nada ahora para no quemar intentos. Prueba mañana.';
      notes.push(note);
      hooks.step('⚠ ' + note, '');
    } else {
      let failures = 0;
      const cap = Math.min(entries.length, CIEC_DAILY_LIMIT);
      if (entries.length > cap) {
        complete = false;
        const note = 'El rango trae ' + entries.length + ' facturas y el portal deja bajar unas ' +
          CIEC_DAILY_LIMIT + ' al día por RFC: descargo las primeras ' + cap + ' y el resto queda para otra corrida.';
        notes.push(note);
        hooks.step('⚠ ' + note, '');
      }
      for (let index = 0; index < cap; index++) {
        const row = entries[index];
        const buffer = await page.ciecDownloadXml(row.url).catch(() => null);
        if (looksLikeXml(buffer)) {
          files.push({ name: row.uuid + '.xml', buffer });
          failures = 0;
        } else {
          failures++;
          if (failures >= 3) {
            complete = false;
            const note = 'Tres descargas seguidas fallaron en el portal (suele ser el cupo del día o un corte del portal): paro aquí con ' +
              files.length + ' facturas guardadas de ' + entries.length + ' encontradas.';
            notes.push(note);
            hooks.step('⚠ ' + note, '');
            break;
          }
        }
        if ((index + 1) % 25 === 0 && index + 1 < cap)
          hooks.step('Descargando tus facturas (' + (index + 1) + ' de ' + cap + ')…', '');
      }
      if (files.length < cap && failures < 3) complete = false;
    }
    return { files, found: entries.length, downloaded: files.length, complete, notes, quota };
  } catch (error) {
    if (error && !error.diag) {
      try { error.diag = await page.diagnostics(); } catch { /* sin foto: el error ya dice lo que hay */ }
    }
    throw error;
  }
}

/* Credenciales CIEC desde la MISMA custodia que la e.firma: el
   índice perfiles.json de la carpeta protegida. Un perfil solo
   ofrece CIEC si su método guardado es «ciec»; la contraseña no
   sale de aquí más que hacia el motor, y nunca se registra. */
export function createCiecCredentialResolver({ storage }) {
  return async function resolveCiecCredentials(profile) {
    const rfc = String(profile?.rfc || '').toUpperCase();
    const entry = storage.readIndex()[rfc];
    if (!entry || entry.access !== 'ciec')
      throw ciecFailure('sin-ciec', 'Este RFC no tiene guardado el acceso con contraseña (CIEC). Guárdalo primero en la pantalla del SAT, en «Acceso con contraseña (CIEC)».');
    if (!entry.ciec)
      throw ciecFailure('sin-ciec', 'A este RFC le falta la contraseña CIEC guardada. Vuelve a guardarla en la pantalla del SAT.');
    return { rfc, ciec: entry.ciec };
  };
}

/* Puerto de descarga CIEC para el servidor: una sesión del
   navegador cada vez (el portal no admite prisas en paralelo),
   con las credenciales resueltas en el momento de cada corrida. */
export function createSatCiecFetch({ resolveCredentials, launchDriver }) {
  let chain = Promise.resolve();
  return function satCiecFetch(profile, query, hooks) {
    const run = async () => {
      const credentials = await resolveCredentials(profile);
      let driver;
      try { driver = await launchDriver(); }
      catch (error) {
        throw ciecFailure('navegador-no-disponible',
          'El navegador interno no arrancó: ' + (error?.message || error));
      }
      try {
        const page = await driver.newPage();
        return await fetchCfdiViaCiec(page, { ...credentials, ...query }, hooks);
      } finally {
        await driver.close().catch(() => {});
      }
    };
    const result = chain.then(run, run);
    chain = result.catch(() => {});
    return result;
  };
}
