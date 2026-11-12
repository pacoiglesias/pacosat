import { createPrivateKey } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { SatDocError, CSF_ENTRY_URL, OPINION_ENTRY_URL, isPdfBuffer, failure } from './sat-doc-fetch.mjs';

/* ================================================================
   Descargador 1.9.0 — ruta principal con NAVEGADOR REAL (sidecar).
   ---------------------------------------------------------------
   Por qué existe (revisión GitHub/foros del 9 nov 2026): ningún
   caso documentado 2024-2026 obtiene constancia u opinión con
   e.firma por HTTP plano; todos usan navegador real porque
   (1) la firma del reto la hace el JavaScript del portal y solo
   descifra llaves PKCS#8 con 3DES, y (2) Node rechaza re-pedir el
   PDF por la DH pequeña del SAT. Este módulo sigue el patrón
   probado de sat-dm: entra por el lanzador estable de wwwmat
   (operación 43824, tipoLogeo=c, #buttonFiel), deja que el portal
   firme el reto DENTRO del navegador y captura el PDF de la
   respuesta del propio navegador (nunca se re-pide por HTTP).

   La llave: si la .key viene cifrada con AES (el portal contesta
   «clave privada inválida»), se crea una COPIA TEMPORAL re-cifrada
   a 3DES (PBES2/des-ede3-cbc, verificada legible por forge — la
   misma familia de librería JS que usa el portal) solo en memoria;
   la original nunca se toca ni sale de este proceso.
   Las credenciales se resuelven con la MISMA validación local del
   descargador HTTP (sin e.firma / bloqueada / caducada / no
   coincide / contraseña que no abre) ANTES de abrir el navegador:
   con una e.firma caducada no se lanza ni una sesión.

   La fase final de la OPINIÓN (pista aportada por Paco el 9 nov
   2026, tratada como hipótesis y verificada contra el portal
   simulado): tras el login, el SPA puede completar la descarga con
   una llamada de «respuesta completa» cuyo cuerpo trae el PDF
   codificado en Base64. El driver captura las respuestas de red y
   este módulo busca en ellas (URL o cuerpo) esa fase y decodifica
   el PDF; si el PDF llega como respuesta binaria normal, también
   se captura. Si ninguna de las dos vías entrega el documento, el
   error es paso-interactivo con el detalle honesto, sin inventar.

   Interfaz de driver (inyectable para pruebas con portal falso):
     launchDriver() -> { newPage(), close() }
     page: goto(url), url(), clickButtonFiel(),
           fillFielForm({ cer, key, password }),
           submitFiel(), divError(), clickText(texto),
           waitForPdf(ms), responses(), close(),
           diagnostics() -> { url, screenshot, html, frames } (opcional)
           tramiteFrameUrl() -> url del marco del trámite (opcional, 1.13.0)
           clickFrameGenerate() -> bool (opcional, 1.13.0)

   Arreglo 1.10.1 (primera corrida real, 9 nov 2026): la corrida
   murió con «setInputFiles: Timeout 30000ms — waiting for
   locator('#fileCertificate')». El mapa del DOM real (capturado el
   9 nov con Chromium contra la página pública, sin credenciales)
   demuestra que los selectores eran los correctos — #fileCertificate
   y #filePrivateKey existen, ocultos con display:none tras pulsar
   #buttonFiel, que NAVEGA a la variante «fiel_Aviso» del NIDP — y
   que faltaba la espera que sat-dm sí hace: tras el clic, esperar a
   que el input oculto EXISTA en el documento nuevo (state attached)
   antes de rellenar. Sin esa espera, el relleno corría contra la
   página de contraseña (donde ese campo no existe jamás) o contra
   una navegación aún en vuelo, y moría a los 30 s. El driver ahora
   espera attached, rellena por localizadores, envía con el #submit
   VISIBLE y sin esperar tras el clic (la firma client-side + el POST
   pueden tardar más que el propio clic) y aguarda el aterrizaje
   vigilando la URL y el #divError, como sat-dm.

   Progreso y diario (requisitos de Paco, 9 nov 2026): el flujo
   emite pasos en lenguaje llano por el gancho opcional
   hooks.step(texto, url) — «Conectando con el SAT…», «Firmando
   con tu e.firma…», «Pidiendo la constancia…» — que el servidor
   persiste y enseña en vivo; y si la corrida falla dentro del
   navegador, el error viaja con error.diag = { url, screenshot,
   html } para que el servidor guarde el diario de la corrida con
   la captura y el volcado de la página en el punto del fallo.
   ================================================================ */

const OID = {
  pbes2: '1.2.840.113549.1.5.13',
  pbkdf2: '1.2.840.113549.1.5.12',
  desEde3Cbc: '1.2.840.113549.3.7',
  pbeSha3Des: '1.2.840.113549.1.5.6', // pbeWithSHAAnd3-KeyTripleDES-CBC
  aes128Cbc: '2.16.840.1.101.3.4.1.2',
  aes192Cbc: '2.16.840.1.101.3.4.1.22',
  aes256Cbc: '2.16.840.1.101.3.4.1.42',
  desCbc: '1.3.14.3.2.7'
};
const CIPHER_NAMES = new Map([
  [OID.desEde3Cbc, '3des'], [OID.pbeSha3Des, '3des'],
  [OID.aes128Cbc, 'aes-128'], [OID.aes192Cbc, 'aes-192'], [OID.aes256Cbc, 'aes-256'],
  [OID.desCbc, 'des']
]);

/* Lector ASN.1 mínimo: basta para bajar por la envoltura de una
   llave PKCS#8 cifrada (EncryptedPrivateKeyInfo) y leer los OID
   del esquema y del cifrado, sin depender de otra librería. */
function readTlv(buf, offset) {
  if (offset >= buf.length) return null;
  const tag = buf[offset];
  let p = offset + 1;
  let len = buf[p++];
  if (len & 0x80) {
    const n = len & 0x7f;
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[p++];
  }
  return { tag, start: p, len, end: p + len };
}
function oidAt(buf, tlv) {
  const bytes = buf.subarray(tlv.start, tlv.end);
  if (!bytes.length) return '';
  const parts = [Math.floor(bytes[0] / 40), bytes[0] % 40];
  let value = 0;
  for (let i = 1; i < bytes.length; i++) {
    value = value * 128 + (bytes[i] & 0x7f);
    if (!(bytes[i] & 0x80)) { parts.push(value); value = 0; }
  }
  return parts.join('.');
}
function childrenOf(buf, tlv) {
  const out = [];
  let p = tlv.start;
  while (p < tlv.end) {
    const child = readTlv(buf, p);
    if (!child || child.end > tlv.end) break;
    out.push(child);
    p = child.end;
  }
  return out;
}

/* Qué cifrado trae la .key y si el JavaScript del portal (que solo
   descifra 3DES) puede abrirla tal cual. */
export function keyCipherInfo(der) {
  try {
    const root = readTlv(der, 0);
    if (!root || root.tag !== 0x30) return { scheme: 'desconocido', cipher: 'desconocido', portalCompatible: false };
    const [algSeq] = childrenOf(der, root);
    if (!algSeq || algSeq.tag !== 0x30) return { scheme: 'desconocido', cipher: 'desconocido', portalCompatible: false };
    const algParts = childrenOf(der, algSeq);
    const algOid = algParts.length && algParts[0].tag === 0x06 ? oidAt(der, algParts[0]) : '';
    if (algOid === OID.pbes2) {
      const params = algParts[1];
      const [kdfSeq, encSeq] = params && params.tag === 0x30 ? childrenOf(der, params) : [];
      const encOid = encSeq && encSeq.tag === 0x30 && childrenOf(der, encSeq)[0]
        ? oidAt(der, childrenOf(der, encSeq)[0]) : '';
      const cipher = CIPHER_NAMES.get(encOid) || 'desconocido';
      void kdfSeq;
      return { scheme: 'pbes2', cipher, portalCompatible: cipher === '3des' };
    }
    const cipher = CIPHER_NAMES.get(algOid) || 'desconocido';
    return { scheme: 'pkcs5', cipher, portalCompatible: cipher === '3des' || cipher === 'des' };
  } catch {
    return { scheme: 'desconocido', cipher: 'desconocido', portalCompatible: false };
  }
}

/* Re-cifra la llave a 3DES (PBES2/des-ede3-cbc). Solo en memoria. */
export function convertKeyTo3Des(der, password) {
  const keyObject = createPrivateKey({ key: der, format: 'der', type: 'pkcs8', passphrase: password });
  return keyObject.export({ type: 'pkcs8', format: 'der', cipher: 'des-ede3-cbc', passphrase: password });
}

/* Prepara el material que se entrega al formulario del portal:
   la llave tal cual si ya es 3DES; copia 3DES si venía en AES;
   si la conversión no es posible en este motor, se entrega la
   original y queda constancia (converted=false) para el informe. */
export function prepareKeyForPortal(der, password) {
  const info = keyCipherInfo(der);
  if (info.portalCompatible) return { buffer: der, converted: false, cipher: info.cipher };
  try {
    const buffer = convertKeyTo3Des(der, password);
    return { buffer, converted: true, cipher: '3des', from: info.cipher };
  } catch {
    return { buffer: der, converted: false, cipher: info.cipher, conversionFailed: true };
  }
}

/* Busca la fase final de la opinión: una respuesta de red cuya URL
   o cuyo cuerpo anuncie la «respuesta completa» con el PDF en
   Base64, o cualquier JSON con un campo de PDF en Base64. Devuelve
   el PDF validado o null. Es la implementación propia de la pista
   de Paco; el portal simulado de las pruebas la ejercita. */
export function extractBase64Pdf(responses) {
  for (const item of responses || []) {
    const body = typeof item.body === 'string' ? item.body : '';
    if (!body) continue;
    const urlHints = /respuesta.?completa|obtener.*pdf|genera.*pdf/i.test(item.url || '');
    let json = null;
    try { json = JSON.parse(body); } catch { /* puede ser el base64 pelado */ }
    const candidates = [];
    const visit = (value, depth) => {
      if (!value || depth > 4) return;
      if (typeof value === 'string') {
        if (value.length > 400 && /^[A-Za-z0-9+/=\s]+$/.test(value)) candidates.push(value);
        return;
      }
      if (typeof value === 'object') {
        for (const [k, v] of Object.entries(value)) {
          if (typeof v === 'string' && /pdf|documento|base64|archivo|respuesta/i.test(k)) candidates.push(v);
          else visit(v, depth + 1);
        }
      }
    };
    if (json) visit(json, 0);
    else if (urlHints && body.length > 400) candidates.push(body.trim());
    for (const candidate of candidates) {
      try {
        const buffer = Buffer.from(String(candidate).replace(/\s+/g, ''), 'base64');
        if (isPdfBuffer(buffer)) return buffer;
      } catch { /* siguiente candidato */ }
    }
  }
  return null;
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const NETWORK_CODES = ['ERR_NAME_NOT_RESOLVED', 'ERR_CONNECTION', 'ERR_TIMED_OUT',
  'ERR_NETWORK', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'Timeout'];
function isNetworkError(error) {
  const text = `${error?.code || ''} ${error?.message || ''}`;
  return NETWORK_CODES.some(code => text.includes(code));
}

/* Login con e.firma dentro del navegador: el portal firma el reto.
   Compartido con los conectores de declaraciones (punto 7).
   hooks.step(texto, url) es opcional: progreso en lenguaje llano
   que el servidor persiste y enseña en vivo (1.10.1). */
export async function satBrowserLogin(page, { cer, key, password, entryUrl, hooks } = {}) {
  const step = (text) => {
    let url = '';
    try { url = page.url(); } catch { /* página en transición */ }
    try { hooks?.step?.(text, url); } catch { /* el progreso nunca tumba el flujo */ }
  };
  step('Conectando con el SAT…');
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await page.goto(entryUrl);
      break;
    } catch (error) {
      lastError = error;
      if (!isNetworkError(error) || attempt === 1) {
        throw failure('portal-caido', 'El portal del SAT no respondió al abrir la página de acceso. ' +
          'Puede ser una caída temporal del portal: inténtalo de nuevo en unos minutos.');
      }
      await sleep(1500);
    }
  }
  void lastError;
  step('Firmando con tu e.firma…');
  /* Endurecimiento 1.22.0 (piezas 5 y 11, sobre la rutina ÚNICA de
     entrada que comparten constancia, opinión y declaraciones):
     la corrida real de la Opinión del 11 nov murió JUSTO aquí —
     conectó a las 08:15:00 y murió a las 08:15:01 en «Firmar» —
     mientras la Constancia del mismo RFC bajaba entera 90
     segundos antes con la misma firma. La pantalla de acceso del
     NIDP es inestable (a veces sirve primero la variante de
     contraseña o llega a medias), así que un solo intento no
     basta: (1) si el acceso no aparece, se RECARGA la entrada y
     se reintenta; (2) si sigue sin aparecer, se busca el acceso
     por su TEXTO visible («e.firma») y se vuelve a sondear el
     formulario — la sonda (el propio clickButtonFiel, que espera
     a que #fileCertificate exista) es la que manda: sin
     formulario confirmado NO se teclea nada de la e.firma —;
     (3) si ni así, el error nombra la última pantalla vista, que
     es la evidencia que el diario guarda con su captura y su
     HTML para contar la causa probada. */
  let fielOpened = false;
  try { await page.clickButtonFiel(); fielOpened = true; } catch { /* primer intento */ }
  if (!fielOpened) {
    step('El acceso con e.firma no apareció; recargando la entrada del portal…');
    await page.goto(entryUrl).catch(() => {});
    try { await page.clickButtonFiel(); fielOpened = true; } catch { /* segundo intento */ }
  }
  if (!fielOpened && typeof page.clickText === 'function') {
    const clicked = await page.clickText('e.firma').catch(() => false);
    if (clicked) {
      try { await page.clickButtonFiel(); fielOpened = true; } catch { /* manda la sonda */ }
    }
  }
  if (!fielOpened) {
    let lastUrl = '';
    try { lastUrl = page.url(); } catch { /* página en transición */ }
    throw failure('respuesta-inesperada', 'El portal del SAT no mostró el acceso con e.firma que ' +
      'PacoSAT sabe usar ni recargando su entrada ni buscándolo por su texto' +
      (lastUrl ? ' (última pantalla: ' + lastUrl + ')' : '') +
      '. Nada de tu e.firma salió de este equipo; si el portal cambió su página, ' +
      'habrá que actualizar PacoSAT.');
  }
  await page.fillFielForm({ cer, key, password });
  try {
    await page.submitFiel();
  } catch (error) {
    if (isNetworkError(error)) {
      throw failure('portal-caido', 'El portal del SAT se cortó al enviar el acceso con e.firma. ' +
        'Inténtalo de nuevo en unos minutos.');
    }
    throw error;
  }
  const divError = String((await page.divError().catch(() => '')) || '').trim();
  if (divError) throw failure('portal-rechaza', `El portal del SAT rechazó el acceso: ${divError}`);
  const url = page.url();
  if (/Error\.aspx/i.test(url)) {
    throw failure('portal-rechaza', 'El portal del SAT rebotó el acceso a su página de error. ' +
      'Suele pasar cuando el portal está inestable: inténtalo de nuevo en unos minutos.');
  }
  /* Si tras enviar seguimos en la página de credenciales del NIDP
     (option=credential) sin mensaje del portal, el acceso NO se
     completó: decirlo tal cual en vez de dejar que el flujo siga
     como si hubiera sesión (la constancia lo detectaba después con
     un mensaje peor y la opinión agotaba su espera). */
  if (/[?&]option=credential/.test(url)) {
    throw failure('portal-caido', 'El portal del SAT no completó el acceso con e.firma: se quedó ' +
      'en su pantalla de acceso sin dar respuesta. Suele ser inestabilidad del portal: ' +
      'inténtalo de nuevo en unos minutos.');
  }
  return { url };
}

/* Flujo completo de un documento (constancia u opinión) en el
   navegador. `creds` ya viene validado localmente por el resolvedor
   compartido: { key, cer, password, rfc }. */
export async function fetchDocumentInBrowser({ page, creds, kind, urls = {}, timeoutMs = 120_000, hooks } = {}) {
  const entryUrl = kind === 'constancia' ? (urls.constancia || CSF_ENTRY_URL) : (urls.opinion || OPINION_ENTRY_URL);
  const keyMaterial = prepareKeyForPortal(creds.key, creds.password);
  const deadline = Date.now() + timeoutMs;
  await satBrowserLogin(page, { cer: creds.cer, key: keyMaterial.buffer,
    password: creds.password, entryUrl, hooks });

  if (kind === 'constancia') {
    try { hooks?.step?.('Pidiendo la constancia…', page.url()); } catch { /* progreso opcional */ }
    /* Evidencia real (corrida 3aed8862 del NAS, 10 nov 2026): tras
       firmar, wwwmat presenta el BUZÓN TRIBUTARIO y el trámite de
       la constancia vive dentro de UN iframe —SessionBroker hacia
       rfcampc…/IdcSiat/autc/ReimpresionTramite/ConsultaTramite.jsf—;
       en la página principal del Buzón NO existe ningún botón
       «Generar Constancia» («Generar» aparece 0 veces en su HTML:
       la espera antigua sobre la página principal moría siempre).
       Flujo corregido: se vigila la aparición del marco del
       trámite, se entra en él (paso «Entrando al trámite…» con su
       URL) y el control de generar se busca en TODOS los marcos
       con espera —el iframe tarda en cargar y su botón puede
       tardar más—, primero por su texto y después por la
       heurística de botón/enlace dentro del marco. La ruta clásica
       (/operacion/43824, botón en la página) sigue funcionando por
       el mismo camino. El PDF se captura de la respuesta del
       navegador, salga en la página, en un popup o en el marco:
       nunca se re-pide por HTTP. */
    const esperaTotal = Math.min(45_000, Math.max(3_000, deadline - Date.now()));
    const inicio = Date.now();
    let frameUrl = '';
    let clicked = false;
    let menuTried = false;
    while (Date.now() - inicio < esperaTotal && !clicked) {
      if (!frameUrl && typeof page.tramiteFrameUrl === 'function') {
        frameUrl = await page.tramiteFrameUrl().catch(() => '');
        if (frameUrl) {
          try { hooks?.step?.('Entrando al trámite…', frameUrl); } catch { /* progreso opcional */ }
        }
      }
      /* Endurecimiento 1.27.0 (bloque C): el marco del trámite
         puede no cargar SOLO — en el Buzón hay que PEDIRLO desde
         su menú (el iframe#iframetoload recibe su src al elegir
         el trámite). Si a los 10 s no hay marco ni botón, se
         pulsa UNA vez la entrada del menú que lo carga y se
         sigue vigilando: es navegación entre secciones del
         portal, jamás sobre una notificación. */
      if (!menuTried && !frameUrl && Date.now() - inicio > 10_000) {
        menuTried = true;
        for (const textoMenu of ['Constancia de situación fiscal', 'Reimprime tus acuses', 'Reimpresión de acuses']) {
          if (await page.clickText(textoMenu).catch(() => false)) {
            try { hooks?.step?.('Abriendo el trámite desde el menú del Buzón…', textoMenu); } catch { /* progreso opcional */ }
            break;
          }
        }
      }
      clicked = await page.clickText('Generar Constancia').catch(() => false);
      if (!clicked && frameUrl && typeof page.clickFrameGenerate === 'function') {
        clicked = await page.clickFrameGenerate().catch(() => false);
      }
      if (!clicked) await sleep(1500);
    }
    if (!clicked) {
      /* Último recurso: cualquier control «Generar» a secas, en la
         página o en sus marcos (cubre variantes del trámite cuyo
         botón no lleva el texto completo). */
      clicked = await page.clickText('Generar').catch(() => false);
    }
    const pdf = await page.waitForPdf(Math.min(45_000, Math.max(5_000, deadline - Date.now())));
    if (pdf && isPdfBuffer(pdf)) return { content: pdf, keyMaterial };
    throw failure('paso-interactivo', !frameUrl && !clicked
      ? 'La sesión con el SAT se abrió, pero el Buzón no enseñó el marco (iframe) del trámite ' +
        'de la constancia ni apareció el botón «Generar Constancia». Si el portal cambió su ' +
        'página, habrá que actualizar PacoSAT: el diario de la corrida guarda la página y sus marcos.'
      : clicked
        ? 'La sesión con el SAT se abrió y se pulsó generar, pero el PDF de la constancia no ' +
          'llegó en la respuesta del navegador. Puede ser lentitud del portal: inténtalo de nuevo.'
        : 'La sesión con el SAT se abrió y el trámite cargó dentro de su marco, pero el botón ' +
          'de generar la constancia no apareció dentro. Si el portal cambió esa pantalla, habrá ' +
          'que actualizar PacoSAT: el diario de la corrida guarda la página y el marco del trámite.');
  }

  /* Opinión: el SPA puede entregar el PDF como respuesta binaria o
     cerrar con la fase de respuesta completa en Base64. Se vigilan
     ambas vías y también el rebote conocido a la autorización. */
  try { hooks?.step?.('Pidiendo la opinión de cumplimiento…', page.url()); } catch { /* progreso opcional */ }
  let authzBounces = 0;
  let lastUrl = page.url();
  while (Date.now() < deadline) {
    const pdf = await page.waitForPdf(3_000);
    if (pdf && isPdfBuffer(pdf)) return { content: pdf, keyMaterial };
    const fromBase64 = extractBase64Pdf(await page.responses().catch(() => []));
    if (fromBase64) return { content: fromBase64, keyMaterial };
    const url = page.url();
    if (url !== lastUrl) {
      if (/\/oauth2\/|\/authz|Error\.aspx/i.test(url)) authzBounces++;
      lastUrl = url;
    }
    if (authzBounces >= 4) {
      throw failure('portal-caido', 'El portal de la opinión de cumplimiento está rebotando el ' +
        'acceso entre sus páginas de autorización (pasa cuando el servicio está inestable). ' +
        'Inténtalo de nuevo en unos minutos.');
    }
    await sleep(750);
  }
  throw failure('paso-interactivo', 'La sesión con el SAT se abrió, pero la opinión de ' +
    'cumplimiento no entregó su PDF ni en la respuesta del navegador ni en su fase de respuesta ' +
    'completa. Si el portal cambió esa fase, habrá que actualizar PacoSAT con lo que responda ahora.');
}

/* Fábrica del descargador por navegador, con la validación local
   compartida y UNA sesión a la vez (el portal no tolera sesiones
   simultáneas del mismo contribuyente y el equipo tampoco gana
   nada lanzando dos navegadores). */
export function createSatDocBrowserFetch({ resolveCredentials, launchDriver, now = () => Date.now(),
  timeoutMs } = {}) {
  let chain = Promise.resolve();
  const run = async (profile, kind, hooks) => {
    const creds = await resolveCredentials(profile); // valida ANTES de abrir el navegador
    let driver = null;
    try {
      driver = await launchDriver();
    } catch (error) {
      if (error instanceof SatDocError) throw error;
      throw failure('navegador-no-disponible', 'El navegador interno de PacoSAT no pudo arrancar ' +
        'en el servidor (' + (error?.message || error) + '). La descarga automática queda en pausa ' +
        'hasta revisar la instalación; mientras tanto puedes subir el PDF a mano como hasta ahora.');
    }
    let page = null;
    try {
      page = await driver.newPage();
      const { content } = await fetchDocumentInBrowser({ page, creds, kind,
        timeoutMs: timeoutMs || 120_000, hooks });
      if (!isPdfBuffer(content)) {
        throw failure('documento-invalido', 'Lo que llegó del portal no es un PDF válido; no se guardó nada.');
      }
      const issuedAt = new Date(now()).toISOString();
      return { content, issuedAt,
        fileName: kind === 'constancia' ? `${creds.rfc}-csf.pdf` : `${creds.rfc}-32d.pdf` };
    } catch (error) {
      /* Diario de la corrida (1.10.1): si el fallo ocurrió dentro
         del navegador, el error viaja con la foto del momento —
         captura de pantalla y volcado de la página — para que el
         servidor lo guarde y el fallo se pueda revisar sin
         repetir la corrida a ciegas. */
      if (error && typeof error === 'object' && page && typeof page.diagnostics === 'function') {
        const diag = await page.diagnostics().catch(() => null);
        if (diag) error.diag = diag;
      }
      throw error;
    } finally {
      await driver.close().catch(() => {});
    }
  };
  return (profile, kind, hooks) => {
    const result = chain.then(() => run(profile, kind, hooks));
    chain = result.catch(() => {});
    return result;
  };
}

/* Pipeline: primero el intento HTTP actual (barato, sin navegador);
   si se detiene donde siempre se detenía (paso en pantalla,
   respuesta sin contrato o documento que no es PDF), entra el
   navegador, que es la ruta principal. Si el navegador no está
   disponible en el servidor, manda el error original del intento
   HTTP para no ocultar la causa primera. */
export function createSatDocPipelineFetch({ httpFetch, browserFetch }) {
  const BROWSER_FALLBACK = ['paso-interactivo', 'respuesta-inesperada', 'documento-invalido'];
  return async (profile, kind, hooks) => {
    try {
      return await httpFetch(profile, kind, hooks);
    } catch (error) {
      if (!(error instanceof SatDocError) || !BROWSER_FALLBACK.includes(error.code) || !browserFetch) {
        throw error;
      }
      try {
        return await browserFetch(profile, kind, hooks);
      } catch (browserError) {
        if (browserError instanceof SatDocError && browserError.code === 'navegador-no-disponible') {
          throw error;
        }
        throw browserError;
      }
    }
  };
}

/* Driver real con playwright-core y el Chromium del sistema (en la
   imagen Docker lo instala el Dockerfile: paquete chromium). Sin
   descarga de navegadores en tiempo de ejecución. */
export function createPlaywrightDriverFactory({ executablePath = '/usr/bin/chromium',
  headless = true, launchTimeoutMs = 30_000 } = {}) {
  return async function launchDriver() {
    let chromium;
    try {
      ({ chromium } = await import('playwright-core'));
    } catch {
      throw failure('navegador-no-disponible', 'Falta el componente del navegador interno ' +
        '(playwright-core) en la instalación de PacoSAT.');
    }
    let browser;
    try {
      browser = await chromium.launch({ executablePath, headless,
        timeout: launchTimeoutMs, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    } catch (error) {
      throw failure('navegador-no-disponible', 'El navegador interno no arrancó: ' +
        (error?.message || error));
    }
    const context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();
    const pdfBodies = [];
    const textResponses = [];
    let lastPdfUrl = '';
    /* Las escuchas viven por página y se aplican también a los
       POPUPS que el portal abra (context.on('page')): el PDF de la
       constancia puede llegar como respuesta de la ventana
       emergente que abre «Generar Constancia», no de la principal.
       Las respuestas de los MARCOS (iframes) ya llegan por la
       escucha de su página. Todo cuerpo capturado va a las mismas
       pilas: waitForPdf no distingue —ni debe— de dónde salió. */
    const wirePage = (wired) => {
      /* El portal entrega el PDF como DESCARGA del navegador (la URL
         no cambia y el cuerpo no llega por el evento de respuesta):
         se captura el archivo descargado por el propio navegador. */
      wired.on('download', (download) => {
        download.path()
          .then(path => readFile(path))
          .then(body => { if (body && body.length) pdfBodies.push(body); })
          .catch(() => {});
      });
      wired.on('response', (response) => {
        const url = response.url();
        const type = (response.headers()['content-type'] || '').toLowerCase();
        if (type.includes('application/pdf')) {
          lastPdfUrl = url;
          response.body().then(body => { if (body && body.length) pdfBodies.push(body); }).catch(() => {});
        } else if (type.includes('json') || type.includes('text')) {
          response.body().then(body => {
            if (body && body.length && body.length < 1_500_000) {
              textResponses.push({ url, body: body.toString('utf8') });
              if (textResponses.length > 60) textResponses.shift();
            }
          }).catch(() => {});
        }
      });
    };
    wirePage(page);
    context.on('page', wirePage);
    const wrapper = {
      async goto(url) { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 }); },
      url: () => page.url(),
      async clickButtonFiel() {
        /* Mapa real del NIDP (9 nov 2026): la entrada cae en
           «Acceso por contraseña» con #buttonFiel visible; pulsarlo
           NAVEGA a la variante de e.firma (id=fiel_Aviso), cuyo
           formulario trae #fileCertificate/#filePrivateKey ocultos
           (display:none). La espera que faltaba en la 1.9.0 — y la
           causa del timeout de la primera corrida real — es esta:
           tras el clic hay que esperar a que el input oculto EXISTA
           en el documento nuevo (state 'attached', el patrón de
           sat-dm) antes de rellenar; sin ella el relleno corría
           contra la página de contraseña o contra una navegación
           aún en vuelo y moría a los 30 s. Si el formulario ya está
           en el DOM (hay páginas que lo traen de origen), el clic
           solo se hace para desplegar su vista. */
        const fielAttached = () => page.locator('#fileCertificate').count()
          .then(count => count > 0).catch(() => false);
        if (await fielAttached()) {
          if (await page.locator('#buttonFiel').count().catch(() => 0)) {
            await page.click('#buttonFiel').catch(() => {});
          }
        } else {
          await page.waitForSelector('#buttonFiel', { timeout: 15_000 });
          await page.click('#buttonFiel');
        }
        await page.waitForSelector('#fileCertificate', { state: 'attached', timeout: 30_000 });
      },
      async fillFielForm({ cer, key, password }) {
        /* Por localizadores y con el input ya confirmado en el DOM:
           los campos de archivo son display:none permanentes, así
           que nada puede esperarlos «visibles». */
        await page.locator('#fileCertificate').setInputFiles(
          { name: 'certificado.cer', mimeType: 'application/octet-stream', buffer: cer },
          { timeout: 30_000 });
        await page.locator('#filePrivateKey').setInputFiles(
          { name: 'llave.key', mimeType: 'application/octet-stream', buffer: key },
          { timeout: 30_000 });
        await page.locator('#privateKeyPassword').fill(password, { timeout: 15_000 });
      },
      async submitFiel() {
        /* Patrón sat-dm: se pulsa el #submit VISIBLE (el formulario
           de contraseña puede compartir el id con el suyo oculto) y
           SIN esperar tras el clic — la firma la hace el JavaScript
           del portal (onclick="firmar(event)") y su POST puede
           tardar más que el timeout del propio clic aunque el envío
           ya se haya disparado —. El aterrizaje se aguarda después
           vigilando las dos señales que decide satBrowserLogin:
           que la URL salga de la página de acceso o que el portal
           pinte su error en #divError. */
        const before = page.url();
        try {
          await page.click('#submit:visible', { timeout: 10_000, noWaitAfter: true });
        } catch {
          await page.click('#submit', { timeout: 10_000, noWaitAfter: true });
        }
        const end = Date.now() + 60_000;
        while (Date.now() < end) {
          if (page.url() !== before) break;
          const divError = await page.evaluate(() => {
            const el = document.querySelector('#divError');
            if (!el) return '';
            const style = getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden') return '';
            return (el.textContent || '').trim();
          }).catch(() => '');
          if (divError) break;
          await page.waitForTimeout(500);
        }
        await page.waitForTimeout(400);
      },
      /* Foto del momento para el diario de la corrida: captura de
         pantalla y volcado HTML de la página tal como quedó, INCLUIDO
         el HTML de cada marco (iframe): el trámite de la constancia
         vive dentro del marco del Buzón y guardar solo la página
         principal costó una hora de extracción forense el 10 nov
         2026. El HTML compuesto lleva cada marco tras un marcador
         con su URL, para que el artefacto «html» del diario lo
         contenga todo sin cambiar el contrato del servidor. */
      async diagnostics() {
        const screenshot = await page.screenshot({ type: 'png' }).catch(() => null);
        let html = await page.content().catch(() => '');
        const frames = [];
        for (const frame of page.frames()) {
          if (frame === page.mainFrame()) continue;
          const frameHtml = await frame.content().catch(() => '');
          frames.push({ url: frame.url(), html: frameHtml });
          if (frameHtml) html += '\n<!-- ===== MARCO (iframe): ' + frame.url() + ' ===== -->\n' + frameHtml;
        }
        return { url: page.url(), screenshot, html, frames };
      },
      /* El marco del trámite de la constancia (1.13.0): el Buzón
         Tributario carga «Reimprime tus acuses» dentro de
         iframe#iframetoload (SessionBroker → rfcampc/ConsultaTramite).
         Devuelve la URL del marco si ya navega ahí; si el iframe
         aún no navega pero su src ya está en el DOM, ese src. */
      async tramiteFrameUrl() {
        for (const frame of page.frames()) {
          const url = frame.url() || '';
          if (/rfcampc|ConsultaTramite|IdcSiat|SessionBroker/i.test(url)) return url;
        }
        return page.evaluate(() => {
          const el = document.querySelector('iframe#iframetoload');
          return el ? String(el.getAttribute('src') || '') : '';
        }).catch(() => '');
      },
      /* El control de generar DENTRO de un marco: además del texto
         (clickText ya busca en todos los marcos), los botones JSF
         suelen ser <input type="submit" value="Generar…">, cuyo
         texto no es contenido sino atributo: heurística por valor
         y por :has-text en botón/enlace del marco. */
      async clickFrameGenerate() {
        for (const frame of page.frames()) {
          if (frame === page.mainFrame()) continue;
          const control = frame.locator(
            'input[type="submit"][value*="Generar" i], input[type="button"][value*="Generar" i], ' +
            'button:has-text("Generar"), a:has-text("Generar")').first();
          if (await control.count().catch(() => 0)) {
            await control.click({ timeout: 8_000 }).catch(() => {});
            await page.waitForTimeout(600);
            return true;
          }
        }
        return false;
      },
      async divError() {
        return page.evaluate(() => {
          const el = document.querySelector('#divError');
          return el ? (el.textContent || '').trim() : '';
        }).catch(() => '');
      },
      async clickText(text) {
        for (const frame of page.frames()) {
          const locator = frame.getByText(text, { exact: false }).first();
          if (await locator.count().catch(() => 0)) {
            await locator.click({ timeout: 8_000 }).catch(() => {});
            await page.waitForTimeout(800);
            return true;
          }
        }
        return false;
      },
      async waitForPdf(ms) {
        const end = Date.now() + Math.max(0, ms);
        while (Date.now() < end) {
          if (pdfBodies.length) return pdfBodies[pdfBodies.length - 1];
          /* Cuando la navegación principal ES el PDF, Chromium lo
             entrega a su visor y el cuerpo no llega por el evento
             de respuesta: lo lee el propio navegador desde su
             sesión (cookies incluidas), nunca Node por HTTP. */
          const isPdfPage = await page.evaluate(() => document.contentType)
            .catch(() => '');
          if (isPdfPage === 'application/pdf' || (lastPdfUrl && page.url() === lastPdfUrl)) {
            const base64 = await page.evaluate(async () => {
              const res = await fetch(location.href);
              const bytes = new Uint8Array(await res.arrayBuffer());
              let binary = '';
              for (let i = 0; i < bytes.length; i += 0x8000) {
                binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
              }
              return btoa(binary);
            }).catch(() => '');
            if (base64) return Buffer.from(base64, 'base64');
          }
          await page.waitForTimeout(400);
        }
        return pdfBodies.length ? pdfBodies[pdfBodies.length - 1] : null;
      },
      async responses() { return textResponses.slice(); },
      /* Genéricos para los conectores de declaraciones (punto 7). */
      async fillSelector(selector, value) { await page.fill(selector, String(value)); },
      async selectSelector(selector, value) {
        await page.selectOption(selector, String(value)).catch(async () => {
          await page.evaluate(([sel, val]) => {
            const el = document.querySelector(sel);
            if (el) { el.value = val; el.dispatchEvent(new Event('change', { bubbles: true })); }
          }, [selector, String(value)]);
        });
      },
      async clickSelector(selector) {
        await page.waitForSelector(selector, { timeout: 15_000 });
        const navigation = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20_000 })
          .catch(() => null);
        await page.click(selector);
        await navigation;
        await page.waitForTimeout(600);
      },
      async text() {
        return page.evaluate(() => document.body ? document.body.innerText : '').catch(() => '');
      },
      /* Filas de resultados de declaraciones (contrato del punto 7):
         tr[data-operacion] con sus enlaces de descarga por clase. */
      async declResults() {
        return page.evaluate(() => [...document.querySelectorAll('tr[data-operacion]')].map(tr => {
          const cells = [...tr.querySelectorAll('td')].map(td => (td.textContent || '').trim());
          const has = (kind) => !!tr.querySelector('a[data-descargar="' + kind + '"]');
          return { operacion: tr.getAttribute('data-operacion') || '',
            fecha: cells[0] || '', tipo: cells[1] || '', periodo: cells[2] || '',
            acuse: has('acuse'), declaracion: has('declaracion') || has('anual') };
        })).catch(() => []);
      },
      /* Filas crudas de la Consulta de transacciones (1.27.0,
         ficha 22513): la ficha pública describe QUÉ enseña el
         servicio (nº de operación, tipo, ejercicio, periodo,
         fechas) pero no su mecánica interna, así que la lectura
         es genérica y honesta: recorre los marcos y devuelve las
         filas de cualquier tabla cuya cabecera hable de operación
         o folio, con sus celdas en crudo; la interpretación
         (qué celda es el folio, cuál el periodo) la hace el motor
         de declaraciones, que es quien puede equivocarse en voz
         alta en el diario. Si el portal no enseña esa tabla, la
         lista vuelve vacía y el motor lo declara. */
      async transacciones() {
        const rows = [];
        for (const frame of page.frames()) {
          const found = await frame.evaluate(() => {
            const out = [];
            for (const table of document.querySelectorAll('table')) {
              const head = (table.querySelector('tr')?.textContent || '').toLowerCase();
              if (!/operaci|folio/.test(head)) continue;
              for (const tr of table.querySelectorAll('tr')) {
                const cells = [...tr.querySelectorAll('td')].map(td => (td.textContent || '').trim());
                if (cells.length >= 2) out.push({ cells });
              }
            }
            return out;
          }).catch(() => []);
          rows.push(...found);
        }
        return rows;
      },
      async clickDeclDownload(kind, index) {
        const clicked = await page.evaluate(([k, i]) => {
          const links = [...document.querySelectorAll('a[data-descargar="' + k + '"]')];
          const link = links[i] || document.querySelector('a[data-descargar="' + k + '"]');
          if (!link) return false;
          link.click();
          return true;
        }, [kind, index]).catch(() => false);
        if (!clicked) throw new Error('La fila no ofreció la descarga pedida (' + kind + ').');
        await page.waitForTimeout(500);
      },
      /* ===== Primitivas del portal de consulta por CIEC (1.12.0) =====
         El contrato de campos es el documentado para portalcfdi:
         acceso NIDP con #rfc/#password/#userCaptcha y captcha como
         imagen data:; consultas con el radio de fechas de postback
         y resultados completos en el DOM. Cada primitiva devuelve
         lo que encontró sin inventar: si el portal real difiere,
         el motor falla con diagnóstico en el diario. */
      async ciecHasLoginForm() {
        return page.evaluate(() => !!document.querySelector('#userCaptcha')).catch(() => false);
      },
      async ciecCaptchaImage() {
        return page.evaluate(() => {
          const img = document.querySelector('img[src^="data:image"]');
          return img ? String(img.getAttribute('src') || '') : '';
        }).catch(() => '');
      },
      async ciecFillLogin({ rfc, password, captcha }) {
        const fillFirst = async (selectors, value) => {
          for (const sel of selectors) {
            try { await page.fill(sel, String(value), { timeout: 4_000 }); return true; } catch { /* siguiente candidato */ }
          }
          return false;
        };
        const rfcOk = await fillFirst(['#rfc', 'input[name="rfc"]', 'input[id*="rfc" i]'], rfc);
        const passOk = await fillFirst(['#password', 'input[type="password"]'], password);
        const captchaOk = await fillFirst(['#userCaptcha'], captcha);
        return { rfc: rfcOk, password: passOk, captcha: captchaOk };
      },
      async ciecSubmitLogin() {
        /* Como el envío con e.firma: se pulsa el #submit VISIBLE
           sin esperar tras el clic; el aterrizaje lo vigila el
           motor mirando la URL. */
        try { await page.click('#submit:visible', { timeout: 10_000, noWaitAfter: true }); }
        catch { await page.click('#submit', { timeout: 10_000, noWaitAfter: true }); }
        await page.waitForTimeout(400);
      },
      async ciecErrorText() {
        return page.evaluate(() => {
          for (const sel of ['#msgError', '.msg-error', '#errormsg', '#divError']) {
            const el = document.querySelector(sel);
            if (!el) continue;
            const style = getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden') continue;
            const text = (el.textContent || '').trim();
            if (text) return text;
          }
          return '';
        }).catch(() => '');
      },
      async ciecClickFechasRadio() {
        /* Clic NATIVO por localizador: el onclick del radio hace
           el postback que habilita los controles de fecha; marcar
           el radio por script no lo dispara. */
        try {
          await page.locator('#ctl00_MainContent_RdoFechas').click({ timeout: 10_000 });
          await page.waitForTimeout(800);
          return true;
        } catch {
          return page.evaluate(() => {
            const el = document.querySelector('#ctl00_MainContent_RdoFechas');
            if (!el) return false;
            el.click();
            return true;
          }).catch(() => false);
        }
      },
      async ciecSetRecibidosDay({ yyyy, mm, dd }) {
        /* Recibidos se consulta día a día: año/mes/día en
           desplegables (valor si existe; si no, índice) y la
           jornada completa 00:00:00–23:59:59. */
        return page.evaluate(({ yyyy, mm, dd }) => {
          const set = (selectors, value, index) => {
            for (const sel of selectors) {
              const el = document.querySelector(sel);
              if (!el) continue;
              el.disabled = false;
              if ([...el.options].some(option => option.value === String(value))) el.value = String(value);
              else if (index != null && el.options[index]) el.selectedIndex = index;
              else el.value = String(value);
              el.dispatchEvent(new Event('change', { bubbles: true }));
              return true;
            }
            return false;
          };
          const year = set(['select#DdlAnio', '#ctl00_MainContent_CldFecha_DdlAnio'], yyyy, null);
          const month = set(['#ctl00_MainContent_CldFecha_DdlMes'], mm, Number(mm) - 1);
          const dayOk = set(['#ctl00_MainContent_CldFecha_DdlDia'], dd, Number(dd) - 1);
          set(['#ctl00_MainContent_CldFecha_DdlHora'], '0', 0);
          set(['#ctl00_MainContent_CldFecha_DdlMinuto'], '0', 0);
          set(['#ctl00_MainContent_CldFecha_DdlSegundo'], '0', 0);
          set(['#ctl00_MainContent_CldFecha_DdlHoraFin'], '23', 23);
          set(['#ctl00_MainContent_CldFecha_DdlMinutoFin'], '59', 59);
          set(['#ctl00_MainContent_CldFecha_DdlSegundoFin'], '59', 59);
          return year && month && dayOk;
        }, { yyyy, mm, dd }).catch(() => false);
      },
      async ciecSetEmitidosRange({ from, to }) {
        /* Emitidos acepta el rango entero: las cajas de fecha son
           de solo lectura a propósito (muestran el calendario) y
           se fuerzan por script con su evento change. */
        await page.waitForFunction(() => {
          const el = document.querySelector('#ctl00_MainContent_CldFechaInicial2_DdlHora');
          return Boolean(el) && !el.disabled;
        }, null, { timeout: 15_000 }).catch(() => {});
        return page.evaluate(({ from, to }) => {
          const force = (id, value) => {
            const el = document.getElementById(id);
            if (!el) return false;
            el.removeAttribute('disabled');
            el.readOnly = false;
            el.value = value;
            el.dispatchEvent(new Event('change', { bubbles: true }));
            el.dispatchEvent(new Event('input', { bubbles: true }));
            return true;
          };
          const set = (id, value, index) => {
            const el = document.getElementById(id);
            if (!el) return;
            el.disabled = false;
            if ([...el.options].some(option => option.value === String(value))) el.value = String(value);
            else if (index != null && el.options[index]) el.selectedIndex = index;
            el.dispatchEvent(new Event('change', { bubbles: true }));
          };
          const a = force('ctl00_MainContent_CldFechaInicial2_Calendario_text', from);
          const b = force('ctl00_MainContent_CldFechaFinal2_Calendario_text', to);
          set('ctl00_MainContent_CldFechaInicial2_DdlHora', '0', 0);
          set('ctl00_MainContent_CldFechaInicial2_DdlMinuto', '0', 0);
          set('ctl00_MainContent_CldFechaInicial2_DdlSegundo', '0', 0);
          set('ctl00_MainContent_CldFechaFinal2_DdlHora', '23', 23);
          set('ctl00_MainContent_CldFechaFinal2_DdlMinuto', '59', 59);
          set('ctl00_MainContent_CldFechaFinal2_DdlSegundo', '59', 59);
          return a && b;
        }, { from, to }).catch(() => false);
      },
      async ciecSearch() {
        await page.waitForSelector('#ctl00_MainContent_BtnBusqueda', { timeout: 15_000 });
        await page.click('#ctl00_MainContent_BtnBusqueda');
        await page.waitForTimeout(600);
      },
      async ciecWaitResults(ms) {
        /* La búsqueda es un postback parcial: networkidle no
           basta. Se espera a que el indicador de progreso se
           oculte Y haya filas o el panel de «sin resultados». */
        const end = Date.now() + Math.max(0, ms);
        while (Date.now() < end) {
          const done = await page.evaluate(() => {
            const visible = el => Boolean(el) && getComputedStyle(el).display !== 'none' &&
              getComputedStyle(el).visibility !== 'hidden';
            const progress = document.querySelector('#ctl00_MainContent_UpdateProgress1');
            const rows = document.querySelectorAll('input.ListaFolios').length;
            return !visible(progress) && (rows > 0 || visible(document.querySelector('#ctl00_MainContent_PnlNoResultados')));
          }).catch(() => false);
          if (done) return true;
          await page.waitForTimeout(700);
        }
        return false;
      },
      async ciecRows() {
        return page.evaluate(() => {
          const rows = [];
          for (const input of document.querySelectorAll('input.ListaFolios')) {
            const uuid = (input.value || '').trim().toUpperCase();
            if (!uuid) continue;
            const tr = input.closest('tr');
            let url = '';
            const span = tr ? tr.querySelector('span[name="BtnDescarga"]') : null;
            const match = (span?.getAttribute('onclick') || '').match(/RecuperaCfdi\.aspx\?Datos=[^'")\s]+/);
            if (match) url = new URL(match[0], location.href).href;
            if (!url && tr) {
              const link = tr.querySelector('a[href*="RecuperaCfdi"]');
              if (link) url = link.href;
            }
            rows.push({ uuid, url });
          }
          const quotaEl = document.querySelector('[id$="hfDescarga"]');
          const noRes = document.querySelector('#ctl00_MainContent_PnlNoResultados');
          const noResVisible = Boolean(noRes) && getComputedStyle(noRes).display !== 'none' &&
            getComputedStyle(noRes).visibility !== 'hidden';
          return { rows, quota: quotaEl ? String(quotaEl.value || '') : '', noResults: noResVisible };
        }).catch(() => ({ rows: [], quota: '', noResults: false }));
      },
      async ciecDownloadXml(url) {
        /* La descarga llega por el evento download del navegador
           (el mismo canal que ya recoge los PDF): se espera el
           cuerpo nuevo y se retira del canal para no mezclarlo
           con documentos. */
        const before = pdfBodies.length;
        const pending = page.waitForEvent('download', { timeout: 30_000 }).catch(() => null);
        await page.goto(url, { waitUntil: 'commit', timeout: 30_000 }).catch(() => {});
        const download = await pending;
        if (!download) return null;
        const end = Date.now() + 15_000;
        while (Date.now() < end) {
          if (pdfBodies.length > before) { const [body] = pdfBodies.splice(before, 1); return body; }
          await page.waitForTimeout(300);
        }
        return null;
      },
      async evaluate(fn, arg) { return page.evaluate(fn, arg); },
      async close() { await context.close().catch(() => {}); }
    };
    return {
      newPage: async () => wrapper,
      close: async () => { await browser.close().catch(() => {}); }
    };
  };
}
