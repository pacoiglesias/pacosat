import { X509Certificate } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { join } from 'node:path';
import { decryptIndexSecrets } from './secret-box.mjs';

/* Descargador de la constancia de situación fiscal y de la opinión de
   cumplimiento (1.7.4): la pieza que faltaba detrás del puerto
   satDocFetch. Entra al portal del SAT con la e.firma GUARDADA del
   perfil (la misma carpeta protegida de la descarga masiva, fuera de
   la BD y de los respaldos) y devuelve el PDF para que el servicio lo
   archive en Expedientes, lo envíe por correo y lo vigile por
   antigüedad.

   Flujos (documentados con evidencia en
   pacosat-visual-172/informe-satdoc-2026-11-09.md):
   - Constancia: lanzador de wwwmat → login SSO NIDP del SAT → pantalla
     «Reimprime tus acuses del RFC» (operación 43824) → el PDF sale de
     /PTSC/IdcSiat/IdcGeneraConstancia.jsf con la sesión autenticada.
   - Opinión 32-D: SPA de ptsc32d.clouda.sat.gob.mx (OAuth2/PKCE hacia
     el mismo login NIDP); el PDF lo pide el propio código de la página
     ya autenticada.
   El login con e.firma NO lleva captcha (el captcha es solo de la vía
   con contraseña): la página firma un reto con la llave dentro del
   navegador (componente JavaScript del propio SAT). Aquí la firma se
   calcula EN EL SERVIDOR con la misma librería de credenciales de la
   descarga masiva y la llave jamás sale de la instalación.

   Reglas de la casa:
   - La caducidad se detecta EN LOCAL, antes de cualquier conexión:
     jamás se gasta un intento contra el portal con una e.firma vencida.
   - Ningún error es críptico: cada fallo lleva su código y su texto
     claro, y distingue e.firma caducada, perfil sin e.firma o sin
     contraseña guardada, portal caído, portal que rechaza y portal que
     pide un paso en pantalla que esta instalación no puede dar.
   - Si el formulario de acceso no expone el contrato computable
     (reto + huecos de certificado y firma), NO se envía material
     alguno de la e.firma: se devuelve el error de paso en pantalla.
   - La contraseña de la .key y el material de claves no se registran,
     no se imprimen y no salen de los mecanismos ya existentes. */

export const CSF_ENTRY_URL = 'https://wwwmat.sat.gob.mx/app/seg/faces/pages/lanzador.jsf' +
  '?url=/operacion/43824/reimprime-tus-acuses-del-rfc&tipoLogeo=c&target=principal' +
  '&hostServer=https://wwwmat.sat.gob.mx';
export const CSF_PDF_URL = 'https://wwwmat.sat.gob.mx/PTSC/IdcSiat/IdcGeneraConstancia.jsf';
export const OPINION_ENTRY_URL = 'https://ptsc32d.clouda.sat.gob.mx/?/reporteOpinion32DContribuyente';

const MAX_BODY = 32 * 1024 * 1024;
const MAX_REDIRECTS = 14;
const REQUEST_TIMEOUT_MS = 45000;

export class SatDocError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SatDocError';
    this.code = code;
  }
}
const fail = (code, message) => new SatDocError(code, message);

const fechaLarga = ms => new Intl.DateTimeFormat('es-MX',
  { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(ms));

/* Almacenamiento de la e.firma respaldado por la carpeta protegida:
   el mismo índice perfiles.json y los mismos <RFC>.cer/.key que usa
   el resto de la app. readFile devuelve null si el archivo no está. */
export function createFileEfirmaStorage(dir) {
  return {
    readIndex() {
      /* S1 (1.22.0): el índice puede traer los secretos cifrados
         en reposo; la lectura los entrega en claro a los flujos,
         igual que siempre. */
      try { return decryptIndexSecrets(dir, JSON.parse(readFileSync(join(dir, 'perfiles.json'), 'utf8'))); }
      catch { return {}; }
    },
    readFile(rfc, ext) {
      const path = join(dir, rfc + ext);
      return existsSync(path) ? readFileSync(path) : null;
    }
  };
}

/* RFC dentro del sujeto del certificado (serialNumber o
   x500UniqueIdentifier), igual que lo lee el resto de la app. */
function certificateRfc(cerBuffer) {
  try {
    const subject = new X509Certificate(cerBuffer).subject || '';
    for (const line of subject.split(/\r?\n/)) {
      const value = line.match(/^(?:x500UniqueIdentifier|uniqueIdentifier|serialNumber|2\.5\.4\.45)\s*=\s*(.+)$/i)?.[1]
        ?.trim().toUpperCase();
      if (/^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/u.test(value || '')) return value;
    }
  } catch { /* certificado ilegible: lo dirá la validación de la pareja */ }
  return '';
}

function certificateExpiryMs(cerBuffer) {
  try { return Date.parse(new X509Certificate(cerBuffer).validTo); }
  catch { return NaN; }
}

/* Transporte HTTP por defecto: https de Node con el nivel de
   seguridad TLS rebajado a 1 — el portal del SAT negocia parámetros
   DH que OpenSSL rechaza al nivel por defecto (visto en la práctica
   por implementaciones abiertas al re-pedir el PDF fuera del
   navegador). Sin redirecciones automáticas: las sigue el cliente
   con su tarro de cookies para poder clasificar cada paso. */
function defaultTransport({ method, url, headers, body }) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const lib = target.protocol === 'http:' ? httpRequest : httpsRequest;
    const req = lib(target, { method, headers, timeout: REQUEST_TIMEOUT_MS,
      ciphers: 'DEFAULT@SECLEVEL=1' }, res => {
      const chunks = [];
      let size = 0;
      res.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_BODY) { req.destroy(new Error('Respuesta del portal demasiado grande.')); return; }
        chunks.push(chunk);
      });
      res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/* Cliente con tarro de cookies y redirecciones seguidas a mano. */
class PortalClient {
  constructor(transport) {
    this.transport = transport;
    this.cookies = new Map(); /* dominio -> Map(nombre -> valor) */
    this.log = []; /* bitácora de pasos (método, URL, estado) — sin datos sensibles */
  }
  cookieHeader(host) {
    const pairs = [];
    for (const [domain, jar] of this.cookies) {
      if (host === domain || host.endsWith('.' + domain)) {
        for (const [name, value] of jar) pairs.push(name + '=' + value);
      }
    }
    return pairs.join('; ');
  }
  storeCookies(host, setCookie) {
    for (const raw of [].concat(setCookie || [])) {
      const [pair, ...attrs] = String(raw).split(';');
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      let domain = host;
      for (const attr of attrs) {
        const match = attr.match(/^\s*domain\s*=\s*(.+)$/i);
        if (match) domain = match[1].trim().replace(/^\./, '').toLowerCase();
      }
      if (!this.cookies.has(domain)) this.cookies.set(domain, new Map());
      if (value) this.cookies.get(domain).set(name, value); else this.cookies.get(domain).delete(name);
    }
  }
  async request(method, url, { body = null, headers = {} } = {}) {
    const host = new URL(url).hostname;
    const cookie = this.cookieHeader(host);
    let response;
    try {
      response = await this.transport({ method, url, body,
        headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          accept: 'text/html,application/pdf,application/xhtml+xml,*/*;q=0.8',
          ...(cookie ? { cookie } : {}), ...headers } });
    } catch (error) {
      this.log.push({ method, url, error: String(error?.code || error?.message || error) });
      throw fail('portal-caido',
        'El portal del SAT no respondió (la conexión se cortó o tardó demasiado). Es un fallo del ' +
        'portal o de la red, no de tu e.firma: inténtalo de nuevo más tarde.');
    }
    this.storeCookies(host, response.headers?.['set-cookie']);
    this.log.push({ method, url, status: response.status });
    return response;
  }
  /* Sigue la cadena de redirecciones conservando la sesión. Devuelve
     la respuesta final y la URL de aterrizaje. */
  async follow(url, first = null) {
    let current = url;
    let response = first;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (!response) response = await this.request('GET', current);
      const location = response.headers?.location;
      if (![301, 302, 303, 307, 308].includes(response.status) || !location) {
        return { response, url: current };
      }
      /* 307/308 tras un POST conservarían el envío: repetir el envío
         de acceso podría duplicarlo. Se devuelve la respuesta tal
         cual (las cookies ya quedaron guardadas) y el paso siguiente
         trabaja con la sesión resultante. */
      if ((response.status === 307 || response.status === 308) && first) {
        return { response, url: current };
      }
      current = new URL(location, current).href;
      response = null;
    }
    throw fail('respuesta-inesperada',
      'El portal del SAT encadenó demasiadas redirecciones y la descarga se detuvo. Puedes bajar ' +
      'el documento directamente en el portal del SAT y subir el PDF a mano: quedará archivado igual.');
  }
}

/* ---------- Lectura mínima del HTML del portal (sin dependencias) --- */
function attrsOf(tag) {
  const attrs = {};
  const re = /([a-zA-Z][a-zA-Z0-9-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match;
  while ((match = re.exec(tag))) attrs[match[1].toLowerCase()] = match[2] ?? match[3] ?? '';
  return attrs;
}
function decodeEntities(text) {
  return String(text).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;/g, ' ');
}
function parseForms(html) {
  const forms = [];
  const re = /<form\b[^>]*>([\s\S]*?)<\/form>/gi;
  let match;
  while ((match = re.exec(html))) {
    const openTag = match[0].slice(0, match[0].indexOf('>') + 1);
    const formAttrs = attrsOf(openTag);
    const inputs = [];
    const ire = /<input\b[^>]*>/gi;
    let input;
    while ((input = ire.exec(match[1]))) inputs.push(attrsOf(input[0]));
    forms.push({ action: formAttrs.action || '', method: (formAttrs.method || 'get').toLowerCase(),
      id: formAttrs.id || '', inputs });
  }
  return forms;
}
/* El formulario de e.firma del acceso NIDP: el que contiene el campo
   de la contraseña de la llave privada (#privateKeyPassword) o el de
   subir el certificado (#fileCertificate). */
function findFielForm(html) {
  return parseForms(html).find(form => form.inputs.some(input =>
    /privatekeypassword/i.test(input.id || '') || /privatekeypassword/i.test(input.name || '') ||
    /filecertificate/i.test(input.id || '') || /filecertificate/i.test(input.name || ''))) || null;
}
function divErrorText(html) {
  const match = html.match(/<[^>]*\bid="divError"[^>]*>([\s\S]*?)<\/div>/i);
  if (!match) return '';
  return decodeEntities(match[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim().slice(0, 200);
}
const isPdf = body => Buffer.isBuffer(body) && body.length > 512 && body.subarray(0, 5).toString('latin1') === '%PDF-';
export { fail as failure, isPdf as isPdfBuffer };

/* Resolvedor de credenciales compartido con la ruta de navegador
   (sat-doc-browser.mjs): misma validación local y, además del Fiel,
   el material que el formulario del portal necesita (llave y
   contraseña solo dentro de este proceso, nunca fuera de él). */
export function createSatDocCredentialResolver({ storage,
  loadSdk = () => import('@nodecfdi/sat-ws-descarga-masiva'), now = Date.now } = {}) {
  if (!storage) throw new Error('createSatDocCredentialResolver necesita el almacenamiento de e.firma.');
  return async function resolveSatDocCredentials(profile) {
    const rfc = String(profile?.rfc || '');
    const resolved = await resolveCredentials({ storage, loadSdk, now }, rfc);
    const index = storage.readIndex() || {};
    return { ...resolved, rfc, key: storage.readFile(rfc, '.key'),
      password: index[rfc]?.password || '' };
  };
}
const isLoginPage = html => /privatekeypassword|acceso por contraseña/i.test(html);

/* ------------------------- Credenciales --------------------------- */
/* Resuelve la e.firma del perfil desde el almacenamiento de la app y
   la valida EN LOCAL, en este orden: existe → archivos completos →
   contraseña guardada → caducidad (antes de cualquier conexión) →
   RFC del certificado → pareja llave/certificado y contraseña. */
async function resolveCredentials({ storage, loadSdk, now }, rfc) {
  const index = storage.readIndex() || {};
  const meta = index[rfc];
  if (!meta) throw fail('sin-efirma',
    'Este perfil no tiene una e.firma guardada en PacoSAT, así que la descarga automática no ' +
    'puede firmar. Carga la e.firma del perfil desde la app o sube el PDF a mano.');
  const cer = storage.readFile(rfc, '.cer');
  const key = storage.readFile(rfc, '.key');
  if (!cer || !key) throw fail('sin-efirma',
    'La e.firma guardada de este perfil está incompleta (falta el archivo .cer o el .key en la ' +
    'carpeta protegida). Vuelve a cargarla desde la app o sube el PDF a mano.');
  if (!meta.password) throw fail('bloqueada',
    'La e.firma de este perfil quedó guardada sin su contraseña en esta instalación, así que la ' +
    'descarga automática no puede firmar con ella. Vuelve a guardar la e.firma del perfil desde ' +
    'la app (probándola ahí mismo) y la descarga quedará habilitada.');
  const expiry = certificateExpiryMs(cer);
  if (!Number.isNaN(expiry) && expiry <= now()) throw fail('caducada',
    'La e.firma de ' + rfc + ' caducó el ' + fechaLarga(expiry) + ' (detectado en esta ' +
    'instalación, sin gastar un intento contra el portal). Renuévala y vuelve a cargarla; ' +
    'mientras tanto puedes subir el PDF a mano.');
  const certRfc = certificateRfc(cer);
  if (certRfc && certRfc !== rfc) throw fail('no-coincide',
    'El certificado guardado para este perfil es del RFC ' + certRfc + ', no de ' + rfc + '. ' +
    'Vuelve a cargar la e.firma correcta del perfil.');
  const sdk = await loadSdk();
  let fiel;
  try {
    const encoding = buffer => Buffer.from(buffer).toString('latin1');
    fiel = sdk.Fiel.create(encoding(cer), encoding(key), meta.password);
  } catch {
    throw fail('credencial-invalida',
      'La contraseña guardada no abre la llave .key de este perfil, o la llave no corresponde ' +
      'al certificado. Vuelve a cargar la e.firma desde la app probándola ahí mismo.');
  }
  if (!fiel.isValid()) throw fail('credencial-invalida',
    'La e.firma guardada de este perfil no pasa la validación (llave y certificado no forman ' +
    'una e.firma vigente y en pareja). Vuelve a cargarla desde la app probándola ahí mismo.');
  return { fiel, cer, validUntil: Number.isNaN(expiry) ? null : expiry };
}

/* --------------------------- Portal ------------------------------- */
/* Firma el reto del formulario de acceso con la llave del perfil.
   Solo se envía algo si el formulario expone el contrato completo
   (reto + huecos de certificado y de firma): si la página espera
   resolver la firma con su propio código en pantalla, no se manda
   material alguno y se devuelve el error de paso en pantalla. */
function buildFielPost(form, creds, rfc) {
  const fields = new Map();
  for (const input of form.inputs) {
    if (input.name && (input.type || 'text').toLowerCase() === 'hidden') fields.set(input.name, input.value || '');
  }
  const byName = pattern => form.inputs.find(input => input.name && pattern.test(input.name));
  const tokenInput = form.inputs.find(input => input.name && /token|reto|challenge/i.test(input.name) &&
    (input.type || '').toLowerCase() === 'hidden');
  const certInput = byName(/certificado|certificate/i);
  const signInput = byName(/firma|sello|signature/i);
  if (!tokenInput || !certInput || !signInput) return null;
  const signature = creds.fiel.sign(tokenInput.value || '', 'sha1');
  fields.set(certInput.name, Buffer.from(creds.cer).toString('base64'));
  fields.set(signInput.name, Buffer.from(signature, 'binary').toString('base64'));
  const rfcInput = form.inputs.find(input => input.name && /rfc/i.test(input.name) &&
    !fields.get(input.name));
  if (rfcInput) fields.set(rfcInput.name, rfc);
  return new URLSearchParams([...fields].map(([k, v]) => [k, String(v)]));
}

async function loginAndFetch(client, creds, rfc, kind) {
  const entry = kind === 'constancia' ? CSF_ENTRY_URL : OPINION_ENTRY_URL;
  const first = await client.follow(entry);
  if (isPdf(first.response.body)) return first.response.body;
  if (first.response.status >= 500) throw fail('portal-caido',
    'El portal del SAT devolvió un error al abrir el trámite (estado ' + first.response.status +
    '). Es un fallo del portal: inténtalo de nuevo más tarde.');
  let html = first.response.body.toString('utf8');
  const fielForm = findFielForm(html);
  if (!fielForm) {
    if (/mantenimiento|fuera de servicio|no disponible/i.test(html)) throw fail('portal-caido',
      'El portal del SAT muestra un aviso de mantenimiento o de servicio no disponible. ' +
      'Inténtalo de nuevo más tarde.');
    throw fail('respuesta-inesperada',
      'El portal del SAT no mostró la pantalla de acceso esperada (es posible que haya ' +
      'cambiado). La descarga se detuvo sin enviar nada de tu e.firma; puedes bajar el ' +
      'documento en el portal y subir el PDF a mano.');
  }
  const post = buildFielPost(fielForm, creds, rfc);
  if (!post) throw fail('paso-interactivo',
    'El acceso con e.firma del portal del SAT firma el reto dentro de la propia página, con ' +
    'un componente que se ejecuta en pantalla, y en esta visita la página no expuso los datos ' +
    'para firmar desde el servidor: la descarga desatendida no puede completar ese paso y no ' +
    'se envió nada de tu e.firma. Alternativa: entra tú al portal del SAT, baja el documento ' +
    'y súbelo con «Subir PDF» en esta pantalla — quedará archivado y vigilado igual.');
  const action = new URL(fielForm.action || first.url, first.url).href;
  const posted = await client.request('POST', action, { body: post,
    headers: { 'content-type': 'application/x-www-form-urlencoded', referer: first.url } });
  const landed = await client.follow(action, posted);
  if (isPdf(landed.response.body)) return landed.response.body;
  html = landed.response.body.toString('utf8');
  const portalError = divErrorText(html);
  if (portalError) throw fail('portal-rechaza',
    'El portal del SAT rechazó el inicio de sesión con la e.firma: «' + portalError + '». ' +
    'Revisa que la e.firma esté vigente y sea la de este RFC; si el mensaje persiste, baja el ' +
    'documento en el portal y súbelo a mano.');
  if (isLoginPage(html)) throw fail('portal-rechaza',
    'El portal del SAT no aceptó el inicio de sesión con la e.firma (volvió a la pantalla de ' +
    'acceso sin dar motivo). Revisa que la e.firma esté vigente y sea la de este RFC.');
  return { client, landedUrl: landed.url, html };
}

async function fetchDocument(client, session, kind) {
  if (kind === 'constancia') {
    const got = await client.follow(CSF_PDF_URL);
    if (isPdf(got.response.body)) return got.response.body;
    const html = got.response.body.toString('utf8');
    if (isLoginPage(html)) throw fail('portal-rechaza',
      'El portal del SAT no dejó la sesión iniciada al pedir la constancia. Inténtalo de ' +
      'nuevo; si persiste, baja el documento en el portal y súbelo a mano.');
    const link = html.match(/href\s*=\s*"([^"]*IdcGeneraConstancia[^"]*)"/i)?.[1];
    if (link) {
      const retry = await client.follow(new URL(link, got.url).href);
      if (isPdf(retry.response.body)) return retry.response.body;
    }
    throw fail('paso-interactivo',
      'La sesión con el SAT quedó iniciada, pero la constancia se genera pulsando «Generar ' +
      'Constancia» dentro de la página (un paso con código en pantalla que esta instalación ' +
      'aún no puede reproducir). Baja la constancia en el portal del SAT y súbela con «Subir ' +
      'PDF»: quedará archivada y vigilada igual.');
  }
  /* Opinión: el SPA ya autenticado pide y muestra el PDF desde su
     propio código (flujo OAuth2/PKCE de navegador). Si en la cadena
     de acceso el portal entregó el PDF directamente ya volvió arriba;
     si no, el documento no se puede pedir por fuera de la página. */
  throw fail('paso-interactivo',
    'La sesión con el SAT quedó iniciada, pero la opinión de cumplimiento la genera la ' +
    'aplicación web del SAT desde su propio código en pantalla (flujo de navegador), y esta ' +
    'instalación aún no puede reproducir ese último paso. Baja la opinión en el portal del ' +
    'SAT y súbela con «Subir PDF»: quedará archivada y vigilada igual.');
}

/* Crea el descargador con el puerto exacto que espera el servicio:
   satDocFetch({ rfc }, kind) -> { content, issuedAt, fileName }.
   storage y transport son inyectables para las pruebas. */
export function createSatDocFetch({ storage, transport = defaultTransport, now = Date.now,
  loadSdk = () => import('@nodecfdi/sat-ws-descarga-masiva') } = {}) {
  if (!storage) throw new Error('createSatDocFetch necesita el almacenamiento de e.firma.');
  return async function satDocFetch({ rfc }, kind) {
    if (kind !== 'constancia' && kind !== 'opinion') {
      throw fail('respuesta-inesperada', 'Tipo de documento no reconocido: ' + kind);
    }
    const creds = await resolveCredentials({ storage, loadSdk, now }, rfc);
    const client = new PortalClient(transport);
    const outcome = await loginAndFetch(client, creds, rfc, kind);
    const content = Buffer.isBuffer(outcome) ? outcome : await fetchDocument(client, outcome, kind);
    if (!isPdf(content)) throw fail('documento-invalido',
      'El portal del SAT no entregó un PDF válido del documento. Inténtalo de nuevo; si ' +
      'persiste, baja el PDF en el portal y súbelo a mano.');
    return { content, issuedAt: new Date(now()).toISOString(),
      fileName: (kind === 'constancia' ? 'Constancia ' : 'Opinion ') + rfc + ' ' +
        new Date(now()).toISOString().slice(0, 10) + '.pdf' };
  };
}
