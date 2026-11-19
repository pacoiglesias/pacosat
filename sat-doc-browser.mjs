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
           fillFielForm({ cer, key, password, rfc, step })
             -> { faltan: [campo, ...] } (1.29.2: espera de los
             campos que la página deriva del certificado y
             verificación previa al envío),
           submitFiel(), divError(), clickText(texto),
           clickTextSeguro(texto) y clickTextExactoVisible(texto)
             (2.0.1: clics reales sobre elementos visibles; el
             exacto es el primario del Buzón y nunca entra en
             tablas),
           fielEmptyFields() -> [campo, ...] (opcional, 1.29.2:
             ids de los campos del formulario que quedaron vacíos,
             para nombrarlos en el portal-rechaza),
           waitForPdf(ms), responses(), close(),
           diagnostics() -> { url, screenshot, html, frames } (opcional)
           tramiteFrameUrl() -> url del marco del trámite (opcional, 1.13.0)
           clickFrameGenerate() -> bool (opcional, 1.13.0)
           evaluateFrames(fn, arg) -> [resultado por marco] (2.9.0:
             ejecuta fn en el marco principal y en cada marco de
             page.frames(); es la vía para leer un iframe de OTRO
             origen, invisible desde la página que lo incrusta)

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
   de Paco; el portal simulado de las pruebas la ejercita.
   Endurecimiento 2.3.0: la búsqueda vieja perdía la fase cuando el
   JSON la anidaba a más de 4 niveles, cuando el Base64 venía
   PARTIDO en trozos dentro de un array y cuando el valor traía el
   prefijo data-URI («data:application/pdf;base64,…») — tres formas
   que una respuesta real puede tomar y que el decodificador pelado
   no reconoce como PDF —. Ahora la visita baja hasta 10 niveles,
   junta los trozos de un array de cadenas en orden, quita el
   prefijo data-URI y normaliza el alfabeto base64url antes de
   decodificar; el candidato solo vale si decodifica a un PDF de
   verdad (isPdfBuffer), como siempre. */
export function extractBase64Pdf(responses) {
  const tryDecode = (raw) => {
    try {
      let text = String(raw || '').trim();
      const dataUri = text.match(/^data:[^,]*;base64,/i);
      if (dataUri) text = text.slice(dataUri[0].length);
      text = text.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
      if (text.length < 100) return null;
      const buffer = Buffer.from(text, 'base64');
      return isPdfBuffer(buffer) ? buffer : null;
    } catch { return null; }
  };
  for (const item of responses || []) {
    const body = typeof item.body === 'string' ? item.body : '';
    if (!body) continue;
    const urlHints = /respuesta.?completa|obtener.*pdf|genera.*pdf/i.test(item.url || '');
    let json = null;
    try { json = JSON.parse(body); } catch { /* puede ser el base64 pelado */ }
    const candidates = [];
    const visit = (value, depth) => {
      if (value === null || value === undefined || depth > 10) return;
      if (typeof value === 'string') {
        if ((value.length > 400 && /^[A-Za-z0-9+/=\s_-]+$/.test(value)) ||
          /^data:[^,]*;base64,/i.test(value)) candidates.push(value);
        return;
      }
      if (Array.isArray(value)) {
        /* Base64 partido: los trozos sueltos no decodifican a
           nada; juntos, en su orden, son el documento. */
        if (value.length > 1 && value.every(v => typeof v === 'string')) candidates.push(value.join(''));
        for (const v of value) visit(v, depth + 1);
        return;
      }
      if (typeof value === 'object') {
        for (const [k, v] of Object.entries(value)) {
          if (typeof v === 'string' && /pdf|documento|base64|archivo|respuesta|contenido|reporte|acuse/i.test(k)) candidates.push(v);
          else visit(v, depth + 1);
        }
      }
    };
    if (json) visit(json, 0);
    else if (urlHints && body.length > 400) candidates.push(body.trim());
    for (const candidate of candidates) {
      const buffer = tryDecode(candidate);
      if (buffer) return buffer;
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
export async function satBrowserLogin(page, { cer, key, password, rfc, entryUrl, landingUrl, hooks } = {}) {
  const step = (text) => {
    let url = '';
    try { url = page.url(); } catch { /* página en transición */ }
    try { hooks?.step?.(text, url); } catch { /* el progreso nunca tumba el flujo */ }
  };
  step('Conectando con el SAT…');
  /* Puerta veraz (2.9.12 · Pieza 1): sin dirección de acceso el
     fallo es LOCAL y se nombra como tal — jamás se navega a
     undefined ni se disfraza de caída del SAT —; y del goto
     solo los errores de red reales (isNetworkError) salen
     como portal-caido: cualquier otro error del driver sale
     con su kind honesto («error-interno») y su mensaje
     subyacente, para que el veredicto de la puerta y sus
     consumidores (sat_puerta, la luz, el foco, el flag
     puertaCaida de descargas) dejen de mentir. Los fallos de
     red conservan su reintento y su portal-caido: los
     reintentos de documentos de local-server dependen de ese
     kind (SATDOC_PORTAL_KINDS) y no cambian. */
  if (!entryUrl || typeof entryUrl !== 'string') {
    throw failure('error-interno', 'A esta llamada le falta la dirección de acceso al portal del SAT: ' +
      'es un fallo de PacoSAT, no del SAT. Nada se pidió al portal en esta corrida.');
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await page.goto(entryUrl);
      break;
    } catch (error) {
      if (!isNetworkError(error)) {
        throw failure('error-interno', 'El navegador interno no pudo abrir la página de acceso ' +
          'por un fallo de PacoSAT (' + (error?.message || error) + '): no es una caída del SAT.');
      }
      if (attempt === 1) {
        throw failure('portal-caido', 'El portal del SAT no respondió al abrir la página de acceso. ' +
          'Puede ser una caída temporal del portal: inténtalo de nuevo en unos minutos.');
      }
      await sleep(1500);
    }
  }
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
    const sinAcceso = failure('respuesta-inesperada', 'El portal del SAT no mostró el acceso con e.firma que ' +
      'PacoSAT sabe usar ni recargando su entrada ni buscándolo por su texto' +
      (lastUrl ? ' (última pantalla: ' + lastUrl + ')' : '') +
      '. Nada de tu e.firma salió de este equipo; si el portal cambió su página, ' +
      'habrá que actualizar PacoSAT.');
    /* Diagnóstico adjunto (2.0.1): el error de acceso viaja con
       la foto y el HTML de la pantalla para que el diario la
       guarde de verdad — las cadenas del ejecutor (diagDe) y
       del servidor ya propagan error.diag si existe. Sin
       diagnostics() en la doble de turno, el error sale solo. */
    if (page && typeof page.diagnostics === 'function') {
      const diag = await page.diagnostics().catch(() => null);
      if (diag) sinAcceso.diag = diag;
    }
    throw sinAcceso;
  }
  /* Relleno 1.29.2: el driver carga el certificado, ESPERA a que
     la página derive sus campos (el RFC lo rellena ella desde el
     certificado; su validación firmar(event) exige el formulario
     completo) y verifica ANTES de enviar. La corrida viva del
     12 nov 2026 (buzon-listar, equipo de Paco) murió justo así:
     credenciales validadas, formulario enviado al instante y el
     portal contestó «no ha llenado varios campos requeridos» sin
     evaluar la firma. Si tras la espera un campo sigue vacío, NO
     se envía: el error nombra el campo y el diagnóstico del
     llamador guarda la captura y el HTML de esa pantalla. Los
     drivers de prueba antiguos (sin retorno) cuentan como
     «sin datos de sonda» y siguen el camino de siempre. */
  const relleno = await page.fillFielForm({ cer, key, password, rfc, step });
  const faltan = Array.isArray(relleno?.faltan) ? relleno.faltan : [];
  if (faltan.length) {
    const sinEnviar = failure('respuesta-inesperada', 'El acceso no se envió: ' +
      (faltan.length === 1
        ? 'el portal no rellenó el campo ' + faltan[0] + ' de su propio formulario'
        : 'el portal no rellenó los campos ' + faltan.join(', ') + ' de su propio formulario') +
      ' y quedó vacío al ir a firmar ni reintentando el relleno. Nada se envió al SAT en esta ' +
      'corrida; la captura y el HTML de la pantalla quedan en el diario para ajustar PacoSAT.');
    /* Diagnóstico adjunto (2.0.1, evidencia e9c2a9de del
       16 nov 2026): en esta ruta el texto de arriba PROMETÍA la
       captura y el HTML en el diario y era falso — la corrida
       quedó con hasShot=false/hasHtml=false porque nadie
       adjuntaba la página al error. Ahora viaja error.diag y
       la promesa es verdad: los motores conservan el diag que
       ya trae el error (su catch solo rellena si falta) y el
       ejecutor y el servidor lo propagan con diagDe y los
       cierres de diario que ya existen. */
    if (page && typeof page.diagnostics === 'function') {
      const diag = await page.diagnostics().catch(() => null);
      if (diag) sinEnviar.diag = diag;
    }
    throw sinEnviar;
  }
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
  if (divError) {
    /* Si el portal vuelve a quejarse de campos sin llenar, el
       error nombra los que el DOM enseña vacíos EN ESE MOMENTO
       (solo ids: la sonda jamás saca valores de la página), para
       que el siguiente diagnóstico sea de un solo paso. */
    let detalleVacios = '';
    if (/no ha llenado/i.test(divError) && typeof page.fielEmptyFields === 'function') {
      const vacios = await page.fielEmptyFields().catch(() => []);
      if (Array.isArray(vacios) && vacios.length) {
        detalleVacios = ' Campos que la página tenía vacíos al rechazar: ' +
          vacios.join(', ') + '.';
      }
    }
    throw failure('portal-rechaza', `El portal del SAT rechazó el acceso: ${divError}` + detalleVacios);
  }
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
  /* Verificación de ATERRIZAJE (2.3.2, constructor P — evidencia
     viva del 17 nov 2026, corrida buzon-listar runId
     1d36cce9-e5f8-4ff5-809a-3cf7cedd7aed, ~14:57 CST, ejecutor
     íntegro en 2.3.1): el diario dice «Acceso al portal OK» →
     «Credenciales validadas» → «Sesión reutilizada» → «la sesión
     reutilizada quedó en la página muerta del portal; se
     descarta» con URL final /app/seg/null y fallo ruta-muerta
     (attempts=1, hasDecisionHtml=false); el HTML guardado del
     fallo son 156 B («Página no encontrada», sin enlaces ni
     formularios). Es decir: ESTE acceso devolvió éxito con la
     página ya en la ruta muerta y el motor lo detectó al
     entrar — tras submitFiel() solo se comprobaban divError,
     Error.aspx y option=credential, y /app/seg/null no casa
     con ninguno, así que el acceso se declaraba bueno sobre
     la 404. Desde esta ronda el aterrizaje se VERIFICA aquí:
     (1) espera de asentamiento — se sondea la URL cada
     ~400 ms hasta ~8 s, hasta que sea estable en dos lecturas
     o venza el plazo —; (2) aterrizaje muerto = la URL casa
     /\/app\/seg\/null/ o el texto de la página principal dice
     «Página no encontrada» (criterio gemelo al de
     buzonPaginaMuerta/paginaMuerta de los motores, definido
     AQUÍ porque sat-tributario importa de este módulo, no al
     revés; el texto sale de page.text(), que en el driver
     real lee solo el body de la principal — jamás el HTML
     compuesto de diagnostics(), que incluye los marcos —);
     (3) si está muerto, UNA recuperación con goto al
     aterrizaje (landingUrl; por defecto, si la entrada es el
     lanzador, https://wwwmat.sat.gob.mx/buzon — el aterrizaje
     real tras el acceso según el mapa levantado en vivo el
     16 nov 2026, citado en sat-tributario.mjs —; si no, la
     propia entryUrl), otra espera y otra comprobación;
     (4) si sigue muerto, ruta-muerta honesta con el diag
     adjunto, como los demás fallos de acceso de esta función;
     (5) si se recupera, paso en la traza y return con
     recuperado:true. Si nunca estuvo muerto, el return es
     EXACTAMENTE el de siempre: { url }, sin goto extra ni
     pasos nuevos. */
  const esperaAsentamientoLogin = async () => {
    const limite = Date.now() + 8_000;
    let anterior = null;
    for (;;) {
      let actual = '';
      try { actual = String(page.url() || ''); } catch { /* página en transición */ }
      if (anterior !== null && actual === anterior) return actual;
      anterior = actual;
      if (Date.now() >= limite) return actual;
      await sleep(400);
    }
  };
  const aterrizajeLoginMuerto = async (urlActual) => {
    if (/\/app\/seg\/null/.test(String(urlActual || ''))) return true;
    if (page && typeof page.text === 'function') {
      const t = await page.text().catch(() => '');
      if (typeof t === 'string' && /Página no encontrada/i.test(t)) return true;
    }
    return false;
  };
  let urlAterrizaje = await esperaAsentamientoLogin();
  if (await aterrizajeLoginMuerto(urlAterrizaje)) {
    const destinoAterrizaje = landingUrl ||
      (String(entryUrl || '').includes('lanzador') ? 'https://wwwmat.sat.gob.mx/buzon' : entryUrl);
    if (destinoAterrizaje && typeof page.goto === 'function') {
      await page.goto(destinoAterrizaje).catch(() => {});
    }
    urlAterrizaje = await esperaAsentamientoLogin();
    if (await aterrizajeLoginMuerto(urlAterrizaje)) {
      const sigueMuerto = failure('ruta-muerta',
        'El acceso con e.firma sí entró, pero el portal dejó el navegador en su página muerta (' +
        (urlAterrizaje || '…/app/seg/null') + ') y ni reintentando el aterrizaje respondió: ' +
        'inténtalo de nuevo en unos minutos.');
      if (page && typeof page.diagnostics === 'function') {
        const diag = await page.diagnostics().catch(() => null);
        if (diag) sigueMuerto.diag = diag;
      }
      throw sigueMuerto;
    }
    step('El portal dejó la entrada en su página muerta; aterrizaje recuperado');
    let urlRecuperada = urlAterrizaje;
    try { urlRecuperada = String(page.url() || '') || urlAterrizaje; } catch { /* manda la asentada */ }
    return { url: urlRecuperada, recuperado: true };
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
    password: creds.password, rfc: creds.rfc, entryUrl, hooks });

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

  /* Opinión (diagnóstico y arreglo 2.3.0): el flujo viejo SOLO
     ESPERABA — tras el login no hacía ningún clic ni navegación —
     mientras la constancia, que sí baja de forma fiable, NAVEGA
     y PULSA hasta el paso que genera su PDF (menú, marco,
     «Generar Constancia», heurística del marco, «Generar»). Si
     el SPA de la opinión (ptsc32d) solo pide su PDF tras un gesto
     en pantalla, la espera pasiva muere siempre con la sesión ya
     abierta: es el modo de fallo reproducido en el portal
     simulado de ronda230motores.test.mjs y el que encaja con las
     dos corridas reales del 16 nov 2026, que fallaron con la
     sesión YA abierta y el mismo texto de «no entregó su PDF».
     La evidencia disponible no cierra las otras dos vías
     posibles (ventana de captura corta y forma de la respuesta
     no reconocida), así que el driver las cubre también:
     extractBase64Pdf endurecido (arriba) y captura de respuestas
     octet-stream en el driver real. El arreglo principal: la
     opinión se comporta como la constancia — primero se vigila
     la entrega automática (descarga del navegador y fase
     Base64, como siempre) y, si no llega, se busca y se PULSA
     su control de generar por sus textos visibles, con clic
     seguro cuando el driver lo ofrece y con la heurística del
     marco como respaldo, reintentando el gesto cada pocos
     segundos por si el SPA pinta tarde (la misma paciencia con
     la que la constancia vigila su marco). Los textos son
     CANDIDATOS buscados en pantalla, del más específico al
     genérico «Generar» — el mismo último recurso de la
     constancia —: si ninguno aparece, el error lo dice así. */
  try { hooks?.step?.('Pidiendo la opinión de cumplimiento…', page.url()); } catch { /* progreso opcional */ }
  const TEXTOS_GENERAR_OPINION = ['Generar opinión de cumplimiento', 'Generar opinión',
    'Generar PDF', 'Generar', 'Descargar PDF', 'Descargar'];
  let authzBounces = 0;
  let lastUrl = page.url();
  let gestoHecho = false;
  let proximoGesto = 0;
  while (Date.now() < deadline) {
    const pdf = await page.waitForPdf(3_000);
    if (pdf && isPdfBuffer(pdf)) return { content: pdf, keyMaterial };
    const fromBase64 = extractBase64Pdf(await page.responses().catch(() => []));
    if (fromBase64) return { content: fromBase64, keyMaterial };
    if (!gestoHecho && Date.now() >= proximoGesto) {
      proximoGesto = Date.now() + 5_000;
      for (const texto of TEXTOS_GENERAR_OPINION) {
        const clic = typeof page.clickTextSeguro === 'function'
          ? await page.clickTextSeguro(texto).catch(() => false)
          : typeof page.clickText === 'function'
            ? await page.clickText(texto).catch(() => false) : false;
        if (clic) { gestoHecho = true; break; }
      }
      if (!gestoHecho && typeof page.clickFrameGenerate === 'function') {
        gestoHecho = await page.clickFrameGenerate().catch(() => false);
      }
      if (gestoHecho) {
        try { hooks?.step?.('Generando la opinión de cumplimiento…', page.url()); } catch { /* progreso opcional */ }
      }
    }
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
  const sinEntrega = failure('paso-interactivo', gestoHecho
    ? 'La sesión con el SAT se abrió y se pulsó el control de generar de la opinión, pero su PDF ' +
      'no llegó ni en la respuesta del navegador ni en su fase de respuesta completa. Puede ser ' +
      'lentitud del portal: inténtalo de nuevo; si el portal cambió esa pantalla, habrá que ' +
      'actualizar PacoSAT con lo que responda ahora.'
    : 'La sesión con el SAT se abrió, pero la opinión de cumplimiento no entregó su PDF ni en la ' +
      'respuesta del navegador ni en su fase de respuesta completa, y en su página no apareció ' +
      'el control de generar que PacoSAT sabe pulsar. Si el portal cambió esa fase, habrá que ' +
      'actualizar PacoSAT con lo que responda ahora.');
  /* Evidencia como desde la 2.0.1: el error viaja con la foto y
     el HTML de la pantalla (la fábrica también los adjunta en su
     catch; aquí quedan aunque el flujo se use directo). */
  if (page && typeof page.diagnostics === 'function' && !sinEntrega.diag) {
    const diag = await page.diagnostics().catch(() => null);
    if (diag) sinEntrega.diag = diag;
  }
  throw sinEntrega;
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

/* ================================================================
   SONDA DEL FORMULARIO DE E.FIRMA — ÚNICO SITIO (1.29.2)

   Por qué existe: la página de acceso (NIDP) no es un formulario
   tonto — al cargar el certificado, la PROPIA página lo procesa y
   rellena el campo del RFC, y su validación (firmar(event)) exige
   el formulario completo. El relleno de la 1.29.1 cargaba
   certificado, llave y contraseña y enviaba al instante: la
   corrida viva del 12 nov 2026 (buzon-listar, ejecutor en el
   equipo de Paco) llegó al portal, envió y recibió «¡Error! no
   ha llenado varios campos requeridos» sin que la firma se
   evaluara. Aquí viven, JUNTOS, todos los selectores y sondeos
   del formulario: si el portal cambia su plantilla, el ajuste
   se hace SOLO en este bloque:

   CONFIRMADO con el HTML real del intento de las 19:47
   (diagnóstico del NAS cerrado el 12 nov a las 21:05): host
   login.siat.sat.gob.mx, ruta /nidp/app/login, título «SAT
   Autenticación», form «certform» con inputs txtCertificate,
   fileCertificate, txtPrivateKey, filePrivateKey,
   privateKeyPassword y rfc (texto) — el rfc estaba VACÍO en el
   HTML guardado tras el rechazo — y #divError con el mensaje
   literal de campos. Los dos «txt*» son los espejos que la
   página rellena al elegir los archivos: derivados también.
   (El HTML guardado es la página re-servida tras el error:
   corroboración fuerte, no foto del instante del envío.)

   - FIEL_FORM: selectores (lado Node) y tiempos de la espera.
   - sondaFielFormEnPagina(): la función que corre DENTRO de la
     página y devuelve su estado. OJO: Playwright la serializa,
     así que no puede usar nada de este módulo — sus literales
     duplican los de FIEL_FORM a propósito y se cambian a la par.
     Devuelve SOLO ids y booleanos de vacío: jamás lee un valor
     fuera de la página (del certificado y la llave solo mira
     files.length; de la contraseña, si su value tiene longitud).
   ================================================================ */
const FIEL_FORM = {
  cert: '#fileCertificate',
  key: '#filePrivateKey',
  password: '#privateKeyPassword',
  /* Espejos de texto que la página rellena sola al elegir el
     archivo (ids reales confirmados): se ESPERAN como derivados,
     pero la verificación previa no los exige — lo probado en el
     rechazo es el rfc; si un espejo quedara vacío y el portal
     rechazara, el error enriquecido lo nombrará (fielEmptyFields
     sí los incluye) y el ajuste será subirlos a exigidos aquí. */
  textoCert: '#txtCertificate',
  textoKey: '#txtPrivateKey',
  esperaDerivadosMs: 12_000,
  sondeoMs: 250
};

function sondaFielFormEnPagina(rfcEsperado) {
  const inputs = Array.from(document.querySelectorAll('input, select, textarea'));
  const idDe = (el) => el.id ? '#' + el.id
    : (el.name ? '[name="' + el.name + '"]'
      : el.tagName.toLowerCase() + (el.type ? ':' + el.type : ''));
  const esArchivo = (el) => String(el.type || '').toLowerCase() === 'file';
  const vacio = (el) => esArchivo(el)
    ? !(el.files && el.files.length > 0)
    : String(el.value == null ? '' : el.value).length === 0;
  const cert = document.getElementById('fileCertificate');
  const key = document.getElementById('filePrivateKey');
  const pass = document.getElementById('privateKeyPassword');
  const textoCert = document.getElementById('txtCertificate');
  const textoKey = document.getElementById('txtPrivateKey');
  const rfcRe = /rfc/i;
  const rfcEl = inputs.find(el => rfcRe.test(el.id || '') || rfcRe.test(el.name || '') ||
    rfcRe.test(el.getAttribute('placeholder') || '')) || null;
  const requeridosVacios = inputs
    .filter(el => (el.required || el.getAttribute('aria-required') === 'true') &&
      el !== cert && el !== key && el !== pass && el !== rfcEl && vacio(el))
    .map(idDe);
  return {
    certVacio: cert ? vacio(cert) : null,
    keyVacio: key ? vacio(key) : null,
    passVacio: pass ? vacio(pass) : null,
    espejoCertVacio: textoCert ? vacio(textoCert) : null,
    espejoKeyVacio: textoKey ? vacio(textoKey) : null,
    rfc: rfcEl ? { id: idDe(rfcEl), vacio: vacio(rfcEl),
      editable: !rfcEl.readOnly && !rfcEl.disabled && !esArchivo(rfcEl) &&
        String(rfcEl.type || 'text').toLowerCase() !== 'hidden',
      /* Higiene DyP (2.0.1): el valor jamás sale de la página —
         solo sale el BOLEANO de si coincide con el RFC del
         perfil. En la puerta viva de Declaraciones el
         navegador autocompletó el campo RFC con un nombre de
         archivo .key: un campo «no vacío» pero equivocado no
         es un campo válido, y la verificación campo a campo
         de satBrowserLogin lo trata como faltante. Sin RFC
         esperado (sondas sueltas), coincide queda null y no
         se juzga nada. */
      coincide: rfcEsperado
        ? String(rfcEl.value).trim().toUpperCase() ===
          String(rfcEsperado).trim().toUpperCase()
        : null } : null,
    requeridosVacios
  };
}

/* Del estado de la sonda a la lista de campos que faltan (ids).
   La verificación PREVIA exige el conjunto probado (certificado,
   llave, contraseña, rfc y requeridos); el nombrado POST-rechazo
   (conEspejos) añade los espejos txt* si quedaron vacíos, para
   que el diagnóstico del rechazo sea completo. */
function fielFaltanDesde(estado, { conEspejos = false } = {}) {
  if (!estado) return [];
  const faltan = [];
  if (estado.certVacio) faltan.push(FIEL_FORM.cert);
  if (estado.keyVacio) faltan.push(FIEL_FORM.key);
  if (estado.passVacio) faltan.push(FIEL_FORM.password);
  if (estado.rfc && (estado.rfc.vacio || estado.rfc.coincide === false)) faltan.push(estado.rfc.id);
  for (const id of estado.requeridosVacios || []) faltan.push(id);
  if (conEspejos) {
    if (estado.espejoCertVacio) faltan.push(FIEL_FORM.textoCert);
    if (estado.espejoKeyVacio) faltan.push(FIEL_FORM.textoKey);
  }
  return [...new Set(faltan)];
}

/* Driver real con playwright-core y el Chromium del sistema (en la
   imagen Docker lo instala el Dockerfile: paquete chromium). Sin
   descarga de navegadores en tiempo de ejecución. */
export function createPlaywrightDriverFactory({ executablePath = '/usr/bin/chromium',
  headless = true, launchTimeoutMs = 30_000, proveedorChromium = null,
  esperasReintentoMs = [750, 1500] } = {}) {
  return async function launchDriver() {
    let chromium;
    try {
      ({ chromium } = proveedorChromium ? await proveedorChromium()
        : await import('playwright-core'));
    } catch {
      throw failure('navegador-no-disponible', 'Falta el componente del navegador interno ' +
        '(playwright-core) en la instalación de PacoSAT.');
    }
    /* Arranque robusto (2.9.3 · F5): el arranque del Chromium
       puede morir de forma transitoria («Target page, context
       or browser has been closed» al abrir el contexto o la
       página — visto en vivo el 18 nov: un intento murió así y
       el reintento manual funcionó). La secuencia entera
       (launch + contexto + página) se reintenta hasta 3 veces
       con una espera corta, cerrando el navegador a medias
       entre intentos; solo si los tres fallan viaja el error
       de siempre, con el mensaje del último intento. La falta
       del componente (arriba) no se reintenta: es determinista. */
    let browser = null;
    let context = null;
    let page = null;
    let ultimoErrorArranque = null;
    const intentos = 1 + esperasReintentoMs.length;
    for (let intento = 0; intento < intentos && !page; intento++) {
      if (intento > 0) await new Promise(resolve => setTimeout(resolve, esperasReintentoMs[intento - 1]));
      try {
        browser = await chromium.launch({ executablePath, headless,
          timeout: launchTimeoutMs, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
        context = await browser.newContext({ acceptDownloads: true });
        page = await context.newPage();
      } catch (error) {
        ultimoErrorArranque = error;
        if (browser) await browser.close().catch(() => {});
        browser = null; context = null; page = null;
      }
    }
    if (!page) throw failure('navegador-no-disponible', 'El navegador interno no arrancó: ' +
      (ultimoErrorArranque?.message || ultimoErrorArranque));
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
        } else if (type.includes('json') || type.includes('text') ||
          type.includes('octet-stream') || type === '') {
          /* Octet-stream y sin tipo (2.3.0): un portal puede
             entregar el PDF — o su fase Base64 — con un tipo
             genérico; antes esa respuesta no se capturaba por
             NINGUNA vía y la opinión moría «sin entregar» aunque
             el navegador la hubiera recibido. Si el cuerpo ES
             un PDF, va a la pila de PDF; si no, a la de textos
             que extractBase64Pdf vigila. */
          response.body().then(body => {
            if (!body || !body.length) return;
            if (isPdfBuffer(body)) { pdfBodies.push(body); return; }
            if (body.length < 1_500_000) {
              textResponses.push({ url, body: body.toString('utf8') });
              if (textResponses.length > 60) textResponses.shift();
            }
          }).catch(() => {});
        }
      });
    };
    wirePage(page);
    context.on('page', wirePage);
    /* Sonda del formulario de e.firma (bloque FIEL_FORM, arriba):
       null si la página está en transición y no se puede leer. */
    const sondaFiel = async (rfcEsperado) =>
      page.evaluate(sondaFielFormEnPagina, rfcEsperado ?? null).catch(() => null);
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
      async fillFielForm({ cer, key, password, rfc, step, esperaDerivadosMs, legado1291 }) {
        /* Por localizadores y con el input ya confirmado en el DOM:
           los campos de archivo son display:none permanentes, así
           que nada puede esperarlos «visibles».
           Orden 1.29.2 (bloque FIEL_FORM, arriba): certificado →
           espera de los campos que la página deriva de él (el RFC
           y cualquier requerido que ella rellene) → llave →
           contraseña → verificación previa (devuelve { faltan }
           y satBrowserLogin decide NO enviar si falta algo).
           `legado1291` reproduce la secuencia vieja SIN espera ni
           verificación SOLO para la prueba réplica de la ronda;
           ningún camino de producción lo pasa. */
        const avisa = (texto) => { try { step?.(texto); } catch { /* la traza nunca tumba el relleno */ } };
        await page.locator(FIEL_FORM.cert).setInputFiles(
          { name: 'certificado.cer', mimeType: 'application/octet-stream', buffer: cer },
          { timeout: 30_000 });
        if (!legado1291) {
          const limite = Date.now() + Math.max(0,
            Number.isFinite(esperaDerivadosMs) ? esperaDerivadosMs : FIEL_FORM.esperaDerivadosMs);
          let estado = await sondaFiel(rfc);
          const rfcEstabaVacio = !!(estado && estado.rfc && estado.rfc.vacio);
          /* El RFC está LISTO solo si tiene el valor del perfil:
             vacío o con un valor equivocado (el autocompletado
             con un nombre de archivo .key de la puerta viva de
             DyP) son la misma falta a efectos de firmar. */
          const rfcListo = (e) => !!e && !!e.rfc && !e.rfc.vacio && e.rfc.coincide !== false;
          const derivadosListos = (e) => !!e && (!e.rfc || rfcListo(e)) &&
            !e.espejoCertVacio && !e.espejoKeyVacio &&
            !(e.requeridosVacios || []).length;
          while (!derivadosListos(estado) && Date.now() < limite) {
            await page.waitForTimeout(FIEL_FORM.sondeoMs);
            estado = await sondaFiel(rfc);
          }
          if (estado && estado.rfc) {
            if (rfcListo(estado)) {
              if (rfcEstabaVacio) avisa('el portal rellenó el RFC desde tu certificado');
            } else if (rfc && (estado.rfc.id.startsWith('#') || estado.rfc.id.startsWith('[name='))) {
              /* Refuerzo del RFC (2.0.1, evidencia e9c2a9de del
                 16 nov 2026): el relleno de la 1.29.2 era
                 silencioso y sin verificar — si el .fill no
                 prendía, el campo quedaba vacío y nadie lo
                 sabía hasta el aborto —; y si el campo NO era
                 editable (la página lo deriva con su JS al
                 elegir el .cer y su JS no corrió), nadie podía
                 rellenarlo y la derivación jamás se re-disparaba.
                 Ahora: (a) editable → rellenar y VERIFICAR con
                 una sonda nueva; si sigue vacío, fijarlo por
                 evaluate (value + eventos input/change) y
                 verificar otra vez; (b) NO editable → volver a
                 adjuntar el certificado para RE-DISPARAR la
                 derivación del portal y esperar una segunda
                 ventana de derivados (8 s), verificando al
                 salir. Solo si tras los reintentos sigue vacío
                 manda la verificación final de abajo. */
              const fijarRfcPorEvaluate = async () => {
                await page.evaluate(([sel, valor]) => {
                  const el = document.querySelector(sel);
                  if (!el) return;
                  el.value = valor;
                  el.dispatchEvent(new Event('input', { bubbles: true }));
                  el.dispatchEvent(new Event('change', { bubbles: true }));
                }, [estado.rfc.id, String(rfc)]).catch(() => {});
                avisa('fijando el RFC en el formulario del portal');
                estado = await sondaFiel(rfc);
              };
              const rellenarRfcEditable = async () => {
                await page.locator(estado.rfc.id).first()
                  .fill(String(rfc), { timeout: 10_000 }).catch(() => {});
                avisa('rellenando el RFC que el portal dejó vacío');
                estado = await sondaFiel(rfc);
                if (estado && estado.rfc && !rfcListo(estado)) await fijarRfcPorEvaluate();
              };
              if (estado.rfc.editable) {
                await rellenarRfcEditable();
              } else {
                avisa('el portal no derivó el RFC y su campo no se puede escribir: vuelvo a adjuntar el certificado');
                await page.locator(FIEL_FORM.cert).setInputFiles(
                  { name: 'certificado.cer', mimeType: 'application/octet-stream', buffer: cer },
                  { timeout: 30_000 }).catch(() => {});
                const limite2 = Date.now() + 8_000;
                while (Date.now() < limite2) {
                  await page.waitForTimeout(FIEL_FORM.sondeoMs);
                  estado = await sondaFiel(rfc);
                  if (!estado || !estado.rfc || rfcListo(estado)) break;
                }
                if (rfcListo(estado)) {
                  avisa('el portal rellenó el RFC desde tu certificado al volver a adjuntarlo');
                } else if (estado && estado.rfc && estado.rfc.editable &&
                  (estado.rfc.id.startsWith('#') || estado.rfc.id.startsWith('[name='))) {
                  await rellenarRfcEditable();
                }
              }
            }
          }
        }
        await page.locator(FIEL_FORM.key).setInputFiles(
          { name: 'llave.key', mimeType: 'application/octet-stream', buffer: key },
          { timeout: 30_000 });
        await page.locator(FIEL_FORM.password).fill(password, { timeout: 15_000 });
        if (legado1291) return { faltan: [] };
        const final = await sondaFiel(rfc);
        /* Sin sonda legible no se bloquea el envío (manda el
           comportamiento de siempre); con sonda, lo que falte se
           devuelve y el envío NO se produce. */
        return { faltan: final ? fielFaltanDesde(final) : [] };
      },
      /* Los campos del formulario que el DOM enseña vacíos AHORA
         (solo ids; la sonda jamás saca valores de la página).
         satBrowserLogin lo usa para nombrarlos cuando el portal
         rechaza con «no ha llenado…» tras el envío. */
      async fielEmptyFields() {
        return fielFaltanDesde(await sondaFiel(), { conEspejos: true });
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
      /* Clic SEGURO (2.0.1): como clickText pero sin ceguera —
         el clickText de siempre devuelve true si el elemento
         EXISTE (count>0) aunque el clic falle o el elemento sea
         invisible, y esa ceguera mató páginas enteras de la
         tanda del 16 nov 2026 (un clic sobre el elemento
         equivocado navegó la página principal a /app/seg/null).
         Aquí solo cuenta un clic REAL sobre un elemento
         VISIBLE: si el clic no se produce, se prueba el
         siguiente candidato y al final se devuelve false. Los
         pasillos endurecidos (Declaraciones) comprueban además
         la página tras cada clic. */
      async clickTextSeguro(text) {
        for (const frame of page.frames()) {
          const porEtiqueta = frame.locator(
            'a, button, [role="link"], [role="button"]').filter({ hasText: text });
          const candidatos = [];
          const nEtiqueta = await porEtiqueta.count().catch(() => 0);
          for (let i = 0; i < nEtiqueta; i++) candidatos.push(porEtiqueta.nth(i));
          if (!candidatos.length) {
            const porTexto = frame.getByText(text, { exact: false });
            const nTexto = await porTexto.count().catch(() => 0);
            for (let i = 0; i < nTexto; i++) candidatos.push(porTexto.nth(i));
          }
          for (const el of candidatos) {
            if (!(await el.isVisible().catch(() => false))) continue;
            try {
              await el.click({ timeout: 8_000 });
              await page.waitForTimeout(800);
              return true;
            } catch { /* candidato inservible: se prueba el siguiente */ }
          }
        }
        return false;
      },
      /* Clic EXACTO y VISIBLE (2.0.1, primario del Buzón): el
         elemento clicable (a, button, [role="link"],
         [role="button"], li, span o div — en ese orden de
         preferencia) cuyo texto normalizado sea EXACTAMENTE el
         pedido, visible y FUERA de cualquier tabla (dentro de
         la bandeja viven las notificaciones: jamás se clica
         nada ahí). Es un CLIC de verdad, no un goto al href:
         en la portada real del Buzón el elemento «Mis
         notificaciones» es un ancla gobernada por el JS de la
         app del portal (su href no es una URL seguible) y solo
         el clic deja que ese JS enrute a la bandeja. Devuelve
         true solo si el clic se produjo. */
      async clickTextExactoVisible(text) {
        const objetivo = String(text || '').toLowerCase()
          .normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
        if (!objetivo) return false;
        const normaliza = (valor) => String(valor || '').toLowerCase()
          .normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
        for (const frame of page.frames()) {
          for (const sel of ['a, button, [role="link"], [role="button"]', 'li', 'span', 'div']) {
            const loc = frame.locator(sel);
            const n = await loc.count().catch(() => 0);
            for (let i = 0; i < n; i++) {
              const el = loc.nth(i);
              if (!(await el.isVisible().catch(() => false))) continue;
              const dentroTabla = await el.evaluate(
                e => Boolean(e.closest && e.closest('table'))).catch(() => false);
              if (dentroTabla) continue;
              const txt = await el.evaluate(
                e => String(e.innerText || e.textContent || '')).catch(() => '');
              if (normaliza(txt) !== objetivo) continue;
              try {
                await el.click({ timeout: 8_000 });
                await page.waitForTimeout(800);
                return true;
              } catch { /* candidato inservible: se prueba el siguiente */ }
            }
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
      /* Filas de la consulta «De la declaración» del portal
         NUEVO de pagos provisionales (pstcdypisr, mapa vivo del
         16 nov 2026): la tabla se reconoce por sus cabeceras
         (fecha / tipo / periodo / operación / ejercicio) y cada
         fila trae su enlace «Generar PDF», que ES el acuse de
         esa fila. Se recorren los marcos como en transacciones()
         y cada fila lleva pdfIndex: la posición de su enlace
         entre los «Generar PDF» DE LAS TABLAS de la página, en
         el mismo orden en que clickPortalPdf los cuenta. La
         lectura es genérica y honesta: sin tabla reconocible,
         la lista vuelve vacía y el motor lo declara.
         LA ESTRUCTURA REAL (2.9.1, Pieza 5 — evidencia de la
         corrida real 1d8f086b, 18 nov 2026, artefacto guardado
         en ~/workspace/pacosat-291-evidencia/): el «Generar
         PDF» del portal NO es un texto — es un enlace con una
         IMAGEN cuyo alt lo dice: <a id="linkDescargaPDF"
         href="/Consulta/RecuperarArchivo?…&numeroOperacion=…
         &ejercicio=…"><img alt="Generar PDF"></a>, con el
         mismo id repetido en cada fila de #tableResult
         (cabeceras: No. de Operación · Tipo de Declaración ·
         Tipo de Complementaria · Línea de Captura · Fecha de
         Presentación · Periodicidad · Período · FechaCausación
         · Estado oculto). El lector viejo pedía textContent
         === 'generar pdf': la imagen no tiene texto, ninguna
         fila casaba y la rejilla real — las 13 declaraciones
         de 2026 — se leyó como cero filas (no-concluyente).
         Además la página trae la MISMA lista en un acordeón
         (display:none) con otros 13 enlaces idénticos: el
         conteo de pdfIndex se limita a los enlaces dentro de
         una tabla — los de la rejilla visible — para que el
         gemelo oculto no desplace los índices, con la misma
         regla en portalNuevoResults y en clickPortalPdf. La
         señal del acuse acepta cualquiera de las marcas
         reales: el texto, el alt de su imagen, su title o
         aria-label, su id linkDescargaPDF o su href a
         RecuperarArchivo con numeroOperacion. */
      async portalNuevoResults() {
        const rows = [];
        let desplazamiento = 0;
        for (const frame of page.frames()) {
          const found = await frame.evaluate(() => {
            const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
              .toLowerCase().replace(/\s+/g, ' ').trim();
            const esPdf = el => {
              if (norm(el.textContent) === 'generar pdf') return true;
              if (el.id === 'linkDescargaPDF') return true;
              if (norm(el.getAttribute('title') || '') === 'generar pdf') return true;
              if (norm(el.getAttribute('aria-label') || '') === 'generar pdf') return true;
              const img = el.querySelector ? el.querySelector('img') : null;
              if (img && norm(img.getAttribute('alt') || '') === 'generar pdf') return true;
              const href = el.getAttribute('href') || '';
              return /recuperararchivo/i.test(href) && /numeroperacion=/i.test(href);
            };
            const anchors = [...document.querySelectorAll('a, button')]
              .filter(el => esPdf(el) && el.closest('table'));
            const filas = [];
            for (const table of document.querySelectorAll('table')) {
              const trs = [...table.querySelectorAll('tr')];
              if (!trs.length) continue;
              const head = [...trs[0].querySelectorAll('th, td')].map(td => norm(td.textContent));
              /* Cabeceras exactas del portal primero; la
                 genérica de respaldo conserva el comportamiento
                 anterior si el portal reordena o abrevia. */
              const busca = (exacto, generico) => {
                const e = head.findIndex(h => exacto.test(h));
                return e >= 0 ? e : head.findIndex(h => generico.test(h));
              };
              const idx = { fecha: busca(/fecha de presentacion/, /fecha/),
                tipo: busca(/tipo de declaracion/, /tipo(?! de complementaria)/),
                periodo: busca(/^periodo$/, /periodo/),
                operacion: busca(/no\.? de operacion|numero de operacion/, /operacion/),
                ejercicio: head.findIndex(h => /ejercicio/.test(h)),
                linea: busca(/linea de captura/, /linea/),
                complementaria: head.findIndex(h => /tipo de complementaria/.test(h)) };
              if (idx.operacion < 0 && idx.fecha < 0 && idx.periodo < 0) continue;
              for (const tr of trs.slice(1)) {
                const tds = [...tr.querySelectorAll('td')];
                if (!tds.length) continue;
                const pdf = [...tr.querySelectorAll('a, button')].find(esPdf);
                if (!pdf) continue;
                const get = i => (i >= 0 && tds[i])
                  ? (tds[i].textContent || '').replace(/\s+/g, ' ').trim() : '';
                /* La operación y el ejercicio también viajan
                   en el href del acuse de la propia fila: si
                   una celda viniera vacía, manda el enlace. */
                const hrefPdf = pdf.getAttribute('href') || '';
                const opHref = /numeroperacion=(\d+)/i.exec(hrefPdf)?.[1] || '';
                const ejHref = /ejercicio=(\d{4})/i.exec(hrefPdf)?.[1] || '';
                filas.push({ operacion: get(idx.operacion) || opHref, fecha: get(idx.fecha),
                  tipo: get(idx.tipo), periodo: get(idx.periodo),
                  ejercicio: get(idx.ejercicio) || ejHref,
                  lineaCaptura: get(idx.linea), tipoComplementaria: get(idx.complementaria),
                  pdfIndex: anchors.indexOf(pdf) });
              }
            }
            return { filas, totalPdf: anchors.length };
          }).catch(() => null);
          if (!found) continue;
          for (const fila of found.filas) rows.push({ ...fila, pdfIndex: fila.pdfIndex + desplazamiento });
          desplazamiento += found.totalPdf || 0;
        }
        return rows;
      },
      /* Clic sobre el «Generar PDF» número index de la página
         (el mismo conteo que portalNuevoResults: solo los
         enlaces dentro de una tabla, con las mismas marcas —
         en el portal real el enlace es una imagen con
         alt «Generar PDF», sin texto): el acuse de la fila
         llega como descarga o como respuesta del navegador y
         lo recoge waitForPdf, como en las demás descargas
         del portal. */
      async clickPortalPdf(index) {
        let restante = Math.max(0, Number(index) || 0);
        for (const frame of page.frames()) {
          const hecho = await frame.evaluate((i) => {
            const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
              .toLowerCase().replace(/\s+/g, ' ').trim();
            const esPdf = el => {
              if (norm(el.textContent) === 'generar pdf') return true;
              if (el.id === 'linkDescargaPDF') return true;
              if (norm(el.getAttribute('title') || '') === 'generar pdf') return true;
              if (norm(el.getAttribute('aria-label') || '') === 'generar pdf') return true;
              const img = el.querySelector ? el.querySelector('img') : null;
              if (img && norm(img.getAttribute('alt') || '') === 'generar pdf') return true;
              const href = el.getAttribute('href') || '';
              return /recuperararchivo/i.test(href) && /numeroperacion=/i.test(href);
            };
            const anchors = [...document.querySelectorAll('a, button')]
              .filter(el => esPdf(el) && el.closest('table'));
            if (i >= anchors.length) return anchors.length;
            anchors[i].click();
            return -1;
          }, restante).catch(() => 0);
          if (hecho === -1) { await page.waitForTimeout(500); return true; }
          restante -= (typeof hecho === 'number' && hecho > 0) ? hecho : 0;
        }
        throw new Error('La fila no ofreció su «Generar PDF».');
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
      /* Puerta de e.firma del portal de consulta (2.9.7, Pieza A):
         portalcfdi puede enseñar primero su puerta de contraseña
         y el acceso con e.firma tras un control propio de esa
         pantalla, ANTES de que exista el formulario FIEL del
         NIDP. Esta primitiva OPCIONAL pulsa ese control si está
         presente y devuelve true solo si lo pulsó; si el
         formulario de e.firma ya está en el DOM (#fileCertificate)
         o no hay control reconocible, devuelve false sin tocar
         nada — satBrowserLogin sigue siendo quien abre el
         formulario por #buttonFiel cuando haga falta —.
         CALIBRACIÓN PENDIENTE (frontera nº 1 de la ronda): el
         selector real de esa puerta NO está contrastado en vivo;
         los candidatos son #buttonFiel, un id que hable de fiel
         y cualquier control clicable cuyo texto visible hable de
         «e.firma»/«fiel». Evaluate acotado, como las ciec*: solo
         busca y pulsa dentro de la página, no lee valores. */
      async portalOpenEfirmaDoor() {
        const clicked = await page.evaluate(() => {
          if (document.querySelector('#fileCertificate')) return false;
          const norm = s => String(s || '').toLowerCase()
            .normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
          const candidates = [...document.querySelectorAll(
            'a, button, input[type="button"], input[type="submit"], [role="button"], [role="link"]')];
          const el = candidates.find(candidate => {
            if (candidate.id === 'buttonFiel') return true;
            if (/fiel/i.test(candidate.id || '')) return true;
            const label = norm(candidate.textContent || candidate.value ||
              candidate.getAttribute('aria-label') || candidate.getAttribute('title') || '');
            return label.includes('e.firma') || label.includes('e firma') || label === 'fiel';
          });
          if (!el) return false;
          el.click();
          return true;
        }).catch(() => false);
        if (clicked) await page.waitForTimeout(800);
        return Boolean(clicked);
      },
      /* PDF de una fila del portal de consulta (2.9.7, Pieza A,
         primitiva OPCIONAL): el mismo canal de descargas del
         navegador que ciecDownloadXml, pero el cuerpo solo vale
         si ES un PDF (%PDF- al frente); si el portal entrega otra
         cosa, devuelve null y el motor sigue solo con el XML.
         La fila solo la ofrece cuando trae su token de PDF
         (pdfUrl en ciecRows aún NO lo expone el lector actual:
         si el portal real lo trae en otro control de la fila,
         ese lector es la calibración pendiente y esta primitiva
         queda sin uso hasta entonces, sin romper nada). */
      async ciecDownloadPdf(url) {
        const before = pdfBodies.length;
        const pending = page.waitForEvent('download', { timeout: 30_000 }).catch(() => null);
        await page.goto(url, { waitUntil: 'commit', timeout: 30_000 }).catch(() => {});
        const download = await pending;
        if (!download) return null;
        const end = Date.now() + 15_000;
        while (Date.now() < end) {
          if (pdfBodies.length > before) {
            const [body] = pdfBodies.splice(before, 1);
            return isPdfBuffer(body) ? body : null;
          }
          await page.waitForTimeout(300);
        }
        return null;
      },
      async evaluate(fn, arg) { return page.evaluate(fn, arg); },
      /* Evaluación POR MARCOS (2.9.0, Bloque A): ejecuta fn en
         el marco principal y en CADA marco de page.frames()
         (frame.evaluate) y devuelve un array con un resultado
         por marco (null si ese marco falla). Por qué existe: la
         bandeja del Buzón vive en un iframe de OTRO ORIGEN
         (agr.siat.sat.gob.mx ≠ wwwmat.sat.gob.mx — evidencia
         real de la corrida d1ac98a4 del 17 nov 2026) y un
         documento de otro origen es invisible desde la página
         que lo incrusta (iframe.contentDocument no se puede
         leer entre orígenes), así que los lectores de siempre
         jamás veían su contenido; Playwright SÍ entra en cada
         marco con su propio evaluate. Tolerante: sin
         page.frames utilizable, degrada a [evaluate principal].
         La importa la misma fábrica que usa ejecutor-local.mjs,
         así que la capacidad llega a las dos sedes (servidor y
         ejecutor) sin tocar el ejecutor. */
      async evaluateFrames(fn, arg) {
        let frames = null;
        try { frames = typeof page.frames === 'function' ? page.frames() : null; } catch { frames = null; }
        if (!Array.isArray(frames) || !frames.length) {
          try { return [await page.evaluate(fn, arg)]; } catch { return [null]; }
        }
        const resultados = [];
        for (const frame of frames) {
          try { resultados.push(await frame.evaluate(fn, arg)); }
          catch { resultados.push(null); }
        }
        return resultados;
      },
      async close() { await context.close().catch(() => {}); }
    };
    return {
      newPage: async () => wrapper,
      close: async () => { await browser.close().catch(() => {}); }
    };
  };
}
