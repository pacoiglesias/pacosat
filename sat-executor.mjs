/* ================================================================
   Ejecutor local del SAT (1.29.0) — protocolo app ⇄ entorno de Paco.

   La corrección de arquitectura del 12 nov 2026 separa dos papeles:

   - PacoSAT (en el NAS) ORDENA, REGISTRA Y ARCHIVA: crea trabajos,
     conserva su traza, verifica lo que vuelve y guarda los PDF.
   - El EJECUTOR corre en el equipo/Chrome de Paco, con su sesión y
     su IP: recibe un trabajo, entra al portal con la sesión de
     e.firma persistente de ESE RFC y devuelve pasos, resultados,
     PDF y evidencia de fallo.

   Este módulo es el CONTRATO entre ambos y la lógica pura que se
   puede probar sin portal: construir el trabajo, rechazar material
   de credenciales en cualquier traza, clasificar el Buzón sin
   abrirlo y verificar un acuse antes de dar un mes por bueno.

   Reglas duras del protocolo:
   1. Ninguna contraseña, clave privada, certificado ni token viaja
      en un trabajo, una traza o un resultado. La e.firma y su
      contraseña viven solo en el entorno del ejecutor; Paco las
      teclea allí cuando el flujo las pide. Aquí solo viaja el RFC
      y la indicación de que use su sesión custodiada local.
   2. El Buzón solo se LISTA. La lista cerrada de operaciones del
      protocolo no contiene ninguna operación de apertura: si un
      resultado declara haber abierto una notificación, se rechaza.
   3. Un mes de declaraciones solo se verifica con DOS pruebas a la
      vez: bytes de PDF reales (cabecera %PDF) y número de operación
      válido que corresponde al RFC y al periodo/ejercicio pedidos.
      Una página de error jamás cuenta como PDF descargado.
   4. La navegación que se ordena usa solo rutas y servicios que
      constan en el mapa del portal o en fichas públicas: el lanzador
      de acceso con e.firma, la bandeja de notificaciones, la
      reimpresión por folio 77792 y la consulta de transacciones
      22513. Lo que ocurra tras el acceso y no conste se resuelve en
      el ejecutor por textos visibles, con la página del fallo de
      vuelta; si no aparece, el resultado es un fallo con evidencia,
      nunca una pantalla inventada por el servidor.
   ================================================================ */

export const SAT_EXECUTOR_PROTOCOL_VERSION = 1;

export const SAT_EXECUTOR_JOB_KINDS = Object.freeze([
  'buzon-listar',
  'declaraciones-recuperar',
  'declaracion-folio',
  'declaraciones-transacciones',
  'documento-sat'
]);

/* Operaciones que un ejecutor puede declarar en su resultado. La
   ausencia deliberada: no existe «abrir-notificacion» ni nada que
   se le parezca; el validador rechaza cualquier operación fuera de
   esta lista y, con especial dureza, las que huelan a apertura. */
export const SAT_EXECUTOR_OPERATIONS = Object.freeze([
  'entrar-con-efirma',
  'navegar-a-lista',
  'leer-lista',
  'consultar-transacciones',
  'reimprimir-acuse-por-folio',
  'descargar-pdf',
  'leer-documento'
]);

const BUZON_LOGIN_URL = 'https://wwwmat.sat.gob.mx/app/seg/faces/pages/lanzador.jsf?tipoLogeo=c&target=principal&hostServer=https://wwwmat.sat.gob.mx';
const BUZON_LIST_URL = 'https://wwwmat.sat.gob.mx/personas/login/mis-notificaciones';
const BUZON_COMUNICADOS_URL = 'https://wwwmat.sat.gob.mx/personas/login/mis-comunicados';
const ACUSES_FOLIO_URL = 'https://wwwmat.sat.gob.mx/aplicacion/77792/reimprime-tus-acuses-de-declaraciones-presentadas';
const DECL_ENTRY_URL = BUZON_LOGIN_URL;

const RFC_RE = /^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/;
const OPERACION_RE = /^[0-9A-Za-z-]{6,40}$/;
const PERIODO_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/* ---------- Higiene de credenciales ----------

   Dos clases de contenido, dos tratamientos (corrección H-1.1 de
   la pasada de seguridad de la 1.29.0):

   - Lo ESTRUCTURAL (trabajos, operaciones, notificaciones,
     documentos, transacciones) se RECHAZA si trae material de
     credenciales de verdad: un campo con nombre de credencial o
     un valor con forma de secreto (bloque PEM de llave o
     certificado, un token con forma de JWT, un bloque largo de
     bytes codificados donde no tocan bytes).
   - Lo NARRATIVO y la EVIDENCIA (pasos, error literal, avisos,
     página de fallo y captura) se REDACTA y se conserva: una
     PALABRA («la contraseña guardada no abre la llave») no es un
     secreto — es el vocabulario de los propios motores y de las
     páginas del portal — y rechazar por ella destruía la
     evidencia del fallo de acceso, que es justo la que el
     Registro promete guardar. El fragmento con forma de secreto
     se sustituye por la marca de redactado; el resto del texto,
     intacto. */

const CREDENTIAL_KEY_RE = /(pass(word)?|contrase|clave|secret|token|private|privada|certificad|efirma|e\.firma|ciec|\.key|\.cer)/i;
/* Material con forma de secreto, no vocabulario: cabecera de un
   bloque PEM, un JWT, o un bloque codificado largo (>= 240
   caracteres) en un sitio donde no viajan bytes. */
const SECRET_TEXT_RE = /(-----BEGIN [A-Z ]*(?:PRIVATE KEY|CERTIFICATE)-----)|(\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b)|([A-Za-z0-9+/]{240,}={0,2})/;
const REDACTADO = '[redactado]';

/* Sustituye en un texto los fragmentos con forma de secreto
   (bloques PEM enteros, JWT) por la marca de redactado. La prosa
   — incluidas las palabras «contraseña» o «password» — se
   conserva literal: es evidencia, no material. */
export function redactExecutorText(texto) {
  let out = String(texto ?? '');
  out = out.replace(/-----BEGIN [A-Z ]*(?:PRIVATE KEY|CERTIFICATE)-----[\s\S]*?(?:-----END [A-Z ]*-----|$)/g, REDACTADO);
  out = out.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, REDACTADO);
  out = out.replace(/[A-Za-z0-9+/]{240,}={0,2}/g, REDACTADO);
  return out;
}

/* La página de fallo es evidencia HTML: además de los bloques con
   forma de secreto, se redacta el VALOR tecleado en cualquier
   campo de contraseña (el portal lo devuelve en el atributo
   value del input). El resto de la página — su texto, sus
   etiquetas, su campo «Contraseña» vacío — se conserva entera. */
export function redactExecutorHtml(html) {
  let out = String(html ?? '');
  out = out.replace(/-----BEGIN [A-Z ]*(?:PRIVATE KEY|CERTIFICATE)-----[\s\S]*?(?:-----END [A-Z ]*-----|$)/g, REDACTADO);
  out = out.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, REDACTADO);
  out = out.replace(/(<input\b[^>]*\btype\s*=\s*["']?password\b["']?[^>]*\bvalue\s*=\s*)(["'])[^"']*\2/gi,
    (m, pre, q) => pre + q + REDACTADO + q);
  out = out.replace(/(<input\b[^>]*\bvalue\s*=\s*)(["'])[^"']*\2([^>]*\btype\s*=\s*["']?password\b)/gi,
    (m, pre, q, valor, post) => pre + q + REDACTADO + q + post);
  return out;
}

/* Una captura solo es captura si decodifica a una imagen de
   verdad (cabecera PNG o JPEG): lo demás no se archiva como
   captura (corrección H-1.5). */
export function isImageBytes(bytes) {
  if (!bytes) return false;
  const b = Buffer.from(bytes);
  if (b.length < 8) return false;
  return (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) ||
    (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff);
}

/* Recorre lo estructural de un trabajo o resultado buscando
   material de credenciales DE VERDAD. La exención de bytes
   queda acotada por RUTA (corrección H-1.5): solo
   `documents[<n>].contentBase64` — el PDF devuelto, que además
   se revalida como PDF — viaja sin barrer; un `contentBase64`
   anidado en cualquier otro sitio se barre como cualquier otro
   valor. Todo lo demás que parezca una credencial detiene el
   resultado: mejor rechazar un resultado contaminado que
   archivarlo en un log. Lo narrativo no pasa por aquí: pasa por
   redactExecutorText / redactExecutorHtml y se conserva. */
export function assertNoCredentialMaterial(value, path = 'resultado', trail = '') {
  if (value === null || value === undefined) return;
  if (typeof value === 'string') {
    if (SECRET_TEXT_RE.test(value))
      throw new Error('El ' + path + ' contiene material de credenciales y se rechaza: las credenciales no viajan en el protocolo.');
    return;
  }
  if (typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoCredentialMaterial(item, path + '[' + index + ']', trail + '[' + index + ']'));
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    const sitio = trail ? trail + '.' + key : key;
    if (key === 'contentBase64' && /^documents\[\d+\]\.contentBase64$/.test(sitio)) continue;
    if (CREDENTIAL_KEY_RE.test(key))
      throw new Error('El ' + path + ' trae un campo de credenciales («' + key + '») y se rechaza: las credenciales no viajan en el protocolo.');
    assertNoCredentialMaterial(item, path + '.' + key, sitio);
  }
}

/* Separa lo narrativo/evidencia de un resultado (pasos, error,
   avisos y diag: se redacta y se conserva) de lo estructural
   (se barre con assertNoCredentialMaterial). */
function splitNarrative(result) {
  const { steps, diag, error, warnings, ...estructural } = result || {};
  return { steps, diag, error, warnings, estructural };
}

/* Los pasos de una traza quedan en texto corto y con los
   fragmentos con forma de secreto redactados — nunca se tumba
   la traza por su vocabulario: se aceptan {at, paso, detalle}
   (también la forma del ejecutor {at, text}). */
export function sanitizeExecutorSteps(steps) {
  if (!Array.isArray(steps)) return [];
  return steps.slice(0, 300).map((step, index) => {
    const paso = redactExecutorText(String(step?.paso || step?.text || '').slice(0, 300));
    const detalle = redactExecutorText(String(step?.detalle || '').slice(0, 600));
    return { at: Number(step?.at) || 0, intento: Number(step?.intento) || 1,
      paso: paso || ('Paso ' + (index + 1)), detalle };
  });
}

/* ---------- Construcción de trabajos ---------- */

function routePlan(kind, payload) {
  switch (kind) {
    case 'buzon-listar':
      return [
        { paso: 'Entrar con la e.firma custodiada de este RFC', url: BUZON_LOGIN_URL },
        { paso: 'Ir a la bandeja de notificaciones (lista)', url: BUZON_LIST_URL },
        { paso: 'Leer la lista visible SIN abrir ninguna notificación', url: '' },
        { paso: 'Si la bandeja de comunicados consta visible, leer también su lista', url: BUZON_COMUNICADOS_URL }
      ];
    case 'declaracion-folio':
      return [
        { paso: 'Entrar con la e.firma custodiada de este RFC', url: DECL_ENTRY_URL },
        { paso: 'Abrir la reimpresión de acuses por folio (servicio 77792)', url: ACUSES_FOLIO_URL },
        { paso: 'Reimprimir el acuse del folio indicado y descargar su PDF', url: '' }
      ];
    case 'declaraciones-transacciones':
      return [
        { paso: 'Entrar con la e.firma custodiada de este RFC', url: DECL_ENTRY_URL },
        { paso: 'Abrir la Consulta de transacciones (ficha 22513) por sus textos visibles', url: '' },
        { paso: 'Leer los números de operación visibles; si su mecánica interna no permite listar, devolver la página como evidencia', url: '' }
      ];
    case 'declaraciones-recuperar':
      return [
        { paso: 'Entrar con la e.firma custodiada de este RFC', url: DECL_ENTRY_URL },
        { paso: 'Localizar los folios del ejercicio (consulta de transacciones o folios ya conocidos)', url: '' },
        { paso: 'Reimprimir cada acuse por su folio (servicio 77792) y descargar los PDF', url: ACUSES_FOLIO_URL }
      ];
    case 'documento-sat':
      return [
        { paso: 'Entrar con la e.firma custodiada de este RFC', url: DECL_ENTRY_URL },
        { paso: 'Descargar el documento pedido (' + String(payload.documento || 'documento') + ') y devolver su PDF', url: '' }
      ];
    default:
      return [];
  }
}

/* El descriptor de trabajo que el servidor entrega al ejecutor.
   No lleva credenciales: solo el RFC, qué se pide y el plan de
   rutas que constan. `dedupeKey` hace idempotente la creación:
   pedir dos veces el mismo trabajo abierto devuelve el mismo. */
export function buildExecutorJob({ rfc = '', kind = '', payload = {}, created = 0 } = {}) {
  const cleanRfc = String(rfc || '').trim().toUpperCase();
  if (!RFC_RE.test(cleanRfc)) throw new Error('El trabajo del ejecutor necesita un RFC válido.');
  if (!SAT_EXECUTOR_JOB_KINDS.includes(kind))
    throw new Error('Clase de trabajo del ejecutor no reconocida: ' + String(kind || ''));
  assertNoCredentialMaterial(payload, 'trabajo');
  const cleanPayload = {};
  if (payload.ejercicio !== undefined) {
    const ejercicio = Number(payload.ejercicio) || 0;
    if (ejercicio && (ejercicio < 2015 || ejercicio > 2100)) throw new Error('Ejercicio inválido en el trabajo.');
    cleanPayload.ejercicio = ejercicio;
  }
  if (payload.periodo !== undefined) {
    const periodo = String(payload.periodo || '');
    if (periodo && !PERIODO_RE.test(periodo)) throw new Error('Periodo inválido en el trabajo (AAAA-MM).');
    cleanPayload.periodo = periodo;
  }
  if (payload.folio !== undefined) {
    const folio = String(payload.folio || '').replace(/\s+/g, '');
    if (folio && !OPERACION_RE.test(folio)) throw new Error('Folio inválido en el trabajo.');
    cleanPayload.folio = folio;
  }
  if (payload.tipo !== undefined) cleanPayload.tipo = payload.tipo === 'anual' ? 'anual' : 'mensual';
  if (payload.documento !== undefined) cleanPayload.documento = String(payload.documento).slice(0, 40);
  if (kind === 'declaracion-folio' && !cleanPayload.folio)
    throw new Error('La reimpresión por folio necesita el folio: sin folio no hay trabajo.');
  /* La clave incluye el TIPO (corrección H-1.4): sin él, una
     mensual sin periodo y una anual del mismo ejercicio
     colisionaban y la segunda se devolvía como «repetida» de la
     primera sin ejecutarse jamás. */
  const dedupeKey = [cleanRfc, kind, cleanPayload.tipo || '', cleanPayload.ejercicio || '', cleanPayload.periodo || '',
    cleanPayload.folio || '', cleanPayload.documento || ''].join('|');
  return { protocol: SAT_EXECUTOR_PROTOCOL_VERSION, rfc: cleanRfc, kind,
    payload: cleanPayload, plan: routePlan(kind, cleanPayload),
    sesion: { metodo: 'efirma', persistentePorRfc: true,
      nota: 'Usa la sesión de e.firma custodiada en este equipo para este RFC. La contraseña se teclea aquí, en tu entorno, si el portal la pide; nunca viaja en el trabajo ni en la traza.' },
    dedupeKey, created: Number(created) || 0 };
}

/* ---------- Buzón: clasificación local sin apertura ---------- */

const normText = value => String(value || '').toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();

/* Clasificación LOCAL de un renglón listado del Buzón, solo desde
   su propio texto (asunto/remitente visibles en la lista):
   - «opinion»: el asunto nombra una opinión de cumplimiento.
   - «informativo»: el asunto nombra un comunicado o un documento
     informativo/de información.
   - «atencion»: todo lo demás (incluidas las notificaciones).
   La clase decide solo el archivo LOCAL: opinión e informativo se
   archivan solos al llegar; atención queda en la vista principal.
   No se afirma ninguna categoría del SAT: es una lectura del texto
   que la propia lista enseña. */
export function classifyBuzonRow(row = {}) {
  const texto = normText([row.asunto, row.remitente].filter(Boolean).join(' '));
  if (/opinion/.test(texto) && /cumplimiento/.test(texto)) return 'opinion';
  if (/comunicado/.test(texto) || /informativ/.test(texto) || /documento informativo/.test(texto)) return 'informativo';
  return 'atencion';
}

export function validateBuzonResult(result = {}) {
  /* Solo lo estructural se barre; lo narrativo y la evidencia
     del mismo resultado los trata validateExecutorResult con
     redacción (corrección H-1.1). */
  assertNoCredentialMaterial(splitNarrative(result).estructural, 'resultado del buzón');
  for (const op of result.operations || []) {
    const nombre = String(op?.tipo || op?.name || op || '');
    if (/abrir|open|detalle|notificaci[oó]n.*click|click.*notificaci/i.test(nombre))
      throw new Error('El resultado del buzón declara una operación de APERTURA de notificación y se rechaza entero: el buzón solo se lista.');
    if (!SAT_EXECUTOR_OPERATIONS.includes(nombre))
      throw new Error('El resultado del buzón declara una operación fuera del protocolo («' + nombre + '») y se rechaza.');
  }
  const notifications = (Array.isArray(result.notifications) ? result.notifications : []).slice(0, 200)
    .map(row => ({ fecha: String(row?.fecha || '').slice(0, 40), asunto: redactExecutorText(String(row?.asunto || '').slice(0, 300)),
      remitente: redactExecutorText(String(row?.remitente || '').slice(0, 200)), estado: String(row?.estado || '').slice(0, 80),
      abierta: Boolean(row?.abierta) }));
  return { notifications,
    counts: { total: notifications.length, sinAbrir: notifications.filter(row => !row.abierta).length } };
}

/* ---------- Declaraciones: verificación PDF + operación ---------- */

export function isPdfBytes(bytes) {
  return Boolean(bytes) && bytes.length >= 5 && Buffer.from(bytes).subarray(0, 4).toString('latin1') === '%PDF';
}

/* La verificación que manda sobre cualquier «descargado»: bytes
   PDF reales + operación válida + correspondencia con lo pedido.
   Devuelve las razones cuando no pasa, para que el diario diga
   exactamente qué faltó en vez de un «falló» genérico. */
export function verifyDeclarationDocument(doc = {}, expected = {}) {
  const reasons = [];
  let bytes = null;
  if (doc.contentBase64) {
    try { bytes = Buffer.from(String(doc.contentBase64), 'base64'); } catch { bytes = null; }
  } else if (doc.content) bytes = Buffer.from(doc.content);
  if (!isPdfBytes(bytes)) reasons.push('el documento devuelto no es un PDF (no trae la cabecera %PDF: puede ser la página de error del portal)');
  else if (bytes.length < 200) reasons.push('el PDF devuelto es demasiado pequeño para ser un acuse (' + bytes.length + ' bytes)');
  const operacion = String(doc.operacion || '').replace(/\s+/g, '');
  if (!OPERACION_RE.test(operacion)) reasons.push('el documento no trae un número de operación válido');
  if (expected.folio && operacion !== String(expected.folio).replace(/\s+/g, ''))
    reasons.push('el número de operación (' + (operacion || 'sin número') + ') no es el folio pedido (' + expected.folio + ')');
  const tipo = doc.tipo === 'anual' || expected.tipo === 'anual' ? 'anual' : 'mensual';
  if (tipo === 'mensual') {
    const periodo = String(doc.periodo || '');
    if (!PERIODO_RE.test(periodo)) reasons.push('el documento no declara su periodo (AAAA-MM)');
    else if (expected.periodo && periodo !== expected.periodo)
      reasons.push('el documento es del periodo ' + periodo + ' y se pidió ' + expected.periodo);
    else if (expected.ejercicio && Number(periodo.slice(0, 4)) !== Number(expected.ejercicio))
      reasons.push('el periodo ' + periodo + ' no pertenece al ejercicio ' + expected.ejercicio);
  } else {
    const ejercicio = Number(doc.ejercicio) || Number(expected.ejercicio) || 0;
    if (expected.ejercicio && ejercicio !== Number(expected.ejercicio))
      reasons.push('el documento es del ejercicio ' + (ejercicio || 'sin declarar') + ' y se pidió ' + expected.ejercicio);
  }
  if (!['acuse', 'declaracion'].includes(doc.clase)) reasons.push('el documento no declara si es acuse o declaración');
  return { ok: reasons.length === 0, reasons, bytes,
    operacion, periodo: String(doc.periodo || ''), ejercicio: Number(doc.ejercicio) || 0 };
}

/* Resultado completo de un trabajo: traza saneada, operaciones
   dentro del protocolo y, según la clase, buzón validado o
   documentos verificados uno a uno. Los documentos que no pasan
   la verificación NO se pierden en silencio: vuelven listados en
   `rejected` con su motivo, y el trabajo no se da por bueno si
   algún documento pedido quedó rechazado sin explicación. */
export function validateExecutorResult(job = {}, result = {}) {
  if (!result || typeof result !== 'object') throw new Error('El ejecutor no devolvió un resultado legible.');
  /* Barrido en dos clases (corrección H-1.1): lo estructural se
     rechaza si trae material de credenciales; lo narrativo y la
     evidencia (pasos, error literal, avisos, página y captura
     del fallo) se REDACTAN y se conservan — un fallo real de
     acceso jamás se pierde como «violación de protocolo». */
  const narrativo = splitNarrative(result);
  assertNoCredentialMaterial(narrativo.estructural, 'resultado');
  const steps = sanitizeExecutorSteps(narrativo.steps || []);
  const operations = (result.operations || []).map(op => String(op?.tipo || op?.name || op || ''));
  for (const nombre of operations)
    if (!SAT_EXECUTOR_OPERATIONS.includes(nombre))
      throw new Error('El resultado declara una operación fuera del protocolo («' + nombre + '») y se rechaza.');
  const out = { steps, operations,
    warnings: (narrativo.warnings || []).map(w => redactExecutorText(String(w).slice(0, 400))).slice(0, 20),
    error: redactExecutorText(String(narrativo.error || '').slice(0, 500)),
    errorKind: String(result.errorKind || '').slice(0, 60),
    diag: null };
  if (narrativo.diag && typeof narrativo.diag === 'object') {
    let screenshot = null;
    if (narrativo.diag.screenshotBase64) {
      const bytes = Buffer.from(String(narrativo.diag.screenshotBase64), 'base64');
      /* Solo una imagen de verdad se archiva como captura
         (corrección H-1.5); lo demás se descarta, no se guarda. */
      screenshot = isImageBytes(bytes) ? bytes : null;
    }
    out.diag = { screenshot,
      html: narrativo.diag.html ? redactExecutorHtml(String(narrativo.diag.html).slice(0, 2 * 1024 * 1024)) : '',
      url: String(narrativo.diag.url || '').slice(0, 300) };
    if (out.diag.screenshot && !out.diag.screenshot.length) out.diag.screenshot = null;
  }
  if (job.kind === 'buzon-listar') {
    const buzon = validateBuzonResult(result);
    out.notifications = buzon.notifications;
    out.counts = buzon.counts;
  }
  if (job.kind === 'declaraciones-recuperar' || job.kind === 'declaracion-folio' || job.kind === 'documento-sat') {
    const expected = { ejercicio: job.payload?.ejercicio || 0, periodo: job.payload?.periodo || '',
      folio: job.payload?.folio || '', tipo: job.payload?.tipo || '' };
    out.documents = [];
    out.rejected = [];
    for (const doc of result.documents || []) {
      const check = verifyDeclarationDocument(doc, expected);
      if (check.ok) out.documents.push({ tipo: doc.tipo === 'anual' || expected.tipo === 'anual' ? 'anual' : 'mensual',
        clase: doc.clase, ejercicio: check.ejercicio || Number(doc.ejercicio) || Number(expected.ejercicio) || 0,
        periodo: check.periodo || String(doc.periodo || ''), fechaPresentacion: String(doc.fechaPresentacion || '').slice(0, 40),
        operacion: check.operacion, content: check.bytes });
      else out.rejected.push({ operacion: String(doc.operacion || ''), periodo: String(doc.periodo || ''),
        reasons: check.reasons });
    }
    out.transactions = (result.transactions || []).slice(0, 200).map(t => ({
      operacion: String(t?.operacion || '').replace(/\s+/g, ''), tipo: t?.tipo === 'anual' ? 'anual' : 'mensual',
      ejercicio: Number(t?.ejercicio) || 0, periodo: String(t?.periodo || ''), fechaPresentacion: String(t?.fechaPresentacion || '').slice(0, 40) }))
      .filter(t => OPERACION_RE.test(t.operacion));
  }
  if (job.kind === 'declaraciones-transacciones') {
    out.transactions = (result.transactions || []).slice(0, 200).map(t => ({
      operacion: String(t?.operacion || '').replace(/\s+/g, ''), tipo: t?.tipo === 'anual' ? 'anual' : 'mensual',
      ejercicio: Number(t?.ejercicio) || 0, periodo: String(t?.periodo || ''), fechaPresentacion: String(t?.fechaPresentacion || '').slice(0, 40) }))
      .filter(t => OPERACION_RE.test(t.operacion));
  }
  return out;
}
