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
           diagnostics() -> { url, screenshot, html } (opcional)

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
  try {
    await page.clickButtonFiel();
  } catch {
    throw failure('respuesta-inesperada', 'El portal del SAT no mostró el acceso con e.firma que ' +
      'PacoSAT sabe usar. Nada de tu e.firma salió de este equipo; si el portal cambió su página, ' +
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
    if (!/\/operacion\/43824/.test(page.url()) && !/IdcSiat/i.test(page.url())) {
      throw failure('portal-rechaza', 'El portal del SAT no dejó entrar a «Reimprime tus acuses ' +
        'del RFC» tras el acceso con e.firma. Si el portal cambió la ruta, habrá que actualizar PacoSAT.');
    }
    const clicked = await page.clickText('Generar Constancia').catch(() => false);
    const pdf = await page.waitForPdf(Math.min(45_000, Math.max(5_000, deadline - Date.now())));
    if (pdf && isPdfBuffer(pdf)) return { content: pdf, keyMaterial };
    throw failure('paso-interactivo', clicked
      ? 'La sesión con el SAT se abrió, pero el PDF de la constancia no llegó en la respuesta ' +
        'del navegador. Puede ser lentitud del portal: inténtalo de nuevo.'
      : 'La sesión con el SAT se abrió, pero la constancia pide pulsar «Generar Constancia» en ' +
        'pantalla y ese botón no apareció. Si el portal cambió su página, habrá que actualizar PacoSAT.');
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
    /* El portal entrega el PDF como DESCARGA del navegador (la URL
       no cambia y el cuerpo no llega por el evento de respuesta):
       se captura el archivo descargado por el propio navegador. */
    page.on('download', (download) => {
      download.path()
        .then(path => readFile(path))
        .then(body => { if (body && body.length) pdfBodies.push(body); })
        .catch(() => {});
    });
    const textResponses = [];
    page.on('response', (response) => {
      const url = response.url();
      const type = (response.headers()['content-type'] || '').toLowerCase();
      if (type.includes('application/pdf')) {
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
    let lastPdfUrl = '';
    page.on('response', (response) => {
      const type = (response.headers()['content-type'] || '').toLowerCase();
      if (type.includes('application/pdf')) lastPdfUrl = response.url();
    });
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
         pantalla y volcado HTML de la página tal como quedó. */
      async diagnostics() {
        const screenshot = await page.screenshot({ type: 'png' }).catch(() => null);
        const html = await page.content().catch(() => '');
        return { url: page.url(), screenshot, html };
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
      async evaluate(fn, arg) { return page.evaluate(fn, arg); },
      async close() { await context.close().catch(() => {}); }
    };
    return {
      newPage: async () => wrapper,
      close: async () => { await browser.close().catch(() => {}); }
    };
  };
}
