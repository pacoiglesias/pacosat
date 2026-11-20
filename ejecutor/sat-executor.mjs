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
  'documento-sat',
  /* (1.30.0) La puerta que se prueba sola: el ejecutor SOLO
     entra con la e.firma y vuelve — no navega, no lista, no
     abre nada. Su resultado dice «abre» o el error exacto, y el
     servidor lo anota por RFC para avisar ANTES de que la
     puerta se rompa el día que se necesita un papel. */
  'puerta-probar'
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
   (se barre con assertNoCredentialMaterial). resultadosDiag
   (2.3.2, constructor P2) es evidencia de la misma clase: la
   foto/HTML de la página de resultados de una corrida de
   declaraciones — también de las BUENAS —; si quedara en lo
   estructural, su captura en base64 se rechazaría como
   material de credenciales y la evidencia se perdería.
   comunicados/documentos (2.4.0, WC1b): las secciones del
   Buzón completo que el motor lista en «Mis comunicados» y
   «Mis documentos» son de la MISMA clase — texto visible de
   unas bandejas, con su motivo en prosa cuando no concluyen —;
   si quedaran en lo estructural, un motivo largo o con forma
   de bloque codificado tumbaría entero un resultado bueno, y
   validateBuzonResult ni siquiera las devolvía (el hueco que
   esta tanda cierra). Viajan por lo narrativo y se validan
   APARTE, con su forma propia, en sanitizeBuzonSecciones240:
   listas acotadas de filas de texto, nada ejecutable y los
   fragmentos con forma de secreto redactados, no rechazados. */
function splitNarrative(result) {
  const { steps, diag, diagDecision, resultadosDiag, error, warnings,
    comunicados, documentos, ...estructural } = result || {};
  return { steps, diag, diagDecision, resultadosDiag, error, warnings,
    comunicados, documentos, estructural };
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
      /* Plan por TEXTOS desde la portada nueva (1.31.0,
         evidencia viva del 13 nov 2026): tras el acceso el
         portal aterriza en la propia portada del Buzón y la
         bandeja se alcanza siguiendo su enlace «Mis
         notificaciones» — la ruta directa a la bandeja
         terminaba en la 404 genérica. Por eso los pasos 2 y
         4 ya no ordenan ninguna URL: se navega por los textos
         visibles de la portada, como hace el motor. Las
         constantes de ruta quedan en el módulo como
         documentación del mapa, no como orden de navegación. */
      return [
        { paso: 'Entrar con la e.firma custodiada de este RFC', url: BUZON_LOGIN_URL },
        { paso: 'Seguir «Mis notificaciones» en la portada del Buzón hasta la bandeja (lista)', url: '' },
        { paso: 'Leer la lista visible SIN abrir ninguna notificación', url: '' },
        { paso: 'Si la bandeja de comunicados consta visible, leer también su lista', url: '' }
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
    case 'puerta-probar':
      return [
        { paso: 'Entrar con la e.firma custodiada de este RFC', url: BUZON_LOGIN_URL },
        { paso: 'Confirmar que el portal deja sesión abierta y volver SIN navegar a ningún trámite', url: '' }
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
  /* Solo faltantes (2.3.0, pieza nº 6): declaraciones-recuperar
     admite { soloFaltantes: true } — recuperar únicamente las
     operaciones que aún no tienen su acuse archivado — junto al
     ejercicio y el periodo de siempre. Es un booleano estricto
     (cualquier otra cosa es false) y solo vive en esta clase de
     trabajo: en las demás se sigue descartando como cualquier
     campo no reconocido del payload. */
  if (kind === 'declaraciones-recuperar' && payload.soloFaltantes !== undefined)
    cleanPayload.soloFaltantes = payload.soloFaltantes === true;
  /* Operaciones que ya tienen acuse (2.3.0, pieza nº 6 — admisión
     mínima del constructor de servidor): la lista que acompaña a
     soloFaltantes, para que el ejecutor descarte los documentos
     de esas operaciones sin volver a bajarlos. Viaja saneada como
     el progreso: números de operación válidos (sin espacios), sin
     duplicados y con el mismo tope (500); lo que no case se
     filtra, no tumba el trabajo. Solo vive en esta clase de
     trabajo: en las demás se descarta como cualquier campo no
     reconocido. Sin la lista, el campo no nace (las claves de los
     trabajos de siempre no cambian). */
  if (kind === 'declaraciones-recuperar' && Array.isArray(payload.operacionesConAcuse)) {
    const vistasConAcuse = new Set();
    const conAcuse = [];
    for (const cruda of payload.operacionesConAcuse) {
      const operacion = String(cruda || '').replace(/\s+/g, '');
      if (!OPERACION_RE.test(operacion) || vistasConAcuse.has(operacion)) continue;
      vistasConAcuse.add(operacion);
      conAcuse.push(operacion);
      if (conAcuse.length >= 500) break;
    }
    if (conAcuse.length) cleanPayload.operacionesConAcuse = conAcuse;
  }
  if (kind === 'declaracion-folio' && !cleanPayload.folio)
    throw new Error('La reimpresión por folio necesita el folio: sin folio no hay trabajo.');
  /* La clave incluye el TIPO (corrección H-1.4): sin él, una
     mensual sin periodo y una anual del mismo ejercicio
     colisionaban y la segunda se devolvía como «repetida» de la
     primera sin ejecutarse jamás. */
  const dedupeKey = [cleanRfc, kind, cleanPayload.tipo || '', cleanPayload.ejercicio || '', cleanPayload.periodo || '',
    cleanPayload.folio || '', cleanPayload.documento || ''].join('|') +
    /* Y el modo solo-faltantes (2.3.0): pedir solo lo que falta
       no es el mismo trabajo que pedir el periodo entero — con
       la misma clave, el segundo se devolvería como «repetido»
       del primero sin ejecutarse. Solo se añade el sufijo
       cuando el modo va activo: las claves de siempre no
       cambian. */
    (cleanPayload.soloFaltantes ? '|solo-faltantes' : '');
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

/* ---------- Buzón completo (2.4.0, WC1b): las secciones ----------
   Forma que el motor (sat-tributario.mjs, castigo 4 de WC1)
   devuelve y que aquí se conserva ENTERA cuando viene bien
   formada:
   - comunicados: { concluyente, items: [{ fecha, asunto,
     leido }], noLeidos, leidos, soloConteos, motivo? }
   - documentos:  { concluyente, items: [{ fecha, nombre,
     estado }], motivo? }
   Validación de forma, con el criterio de lo narrativo:
   - Solo viajan las claves conocidas; una clave rara en una
     fila (o un valor que no es el texto/booleano/número que
     toca) RECHAZA ESA FILA, no el resultado; una clave rara
     de sección se descarta y la sección sigue.
   - Tamaños acotados como el resto: máx. 200 filas (el motor
     emite máx. 100), fecha ≤ 40, asunto/nombre ≤ 300, estado
     ≤ 80 y motivo ≤ 600, todo pasado por redactExecutorText:
     un fragmento con forma de secreto se redacta y se
     conserva el resto, jamás se tumba la corrida por él.
   - concluyente/soloConteos solo valen como booleanos
     estrictos (cualquier otra cosa es false); los conteos
     viajan como enteros ≥ 0 o null si no son un número.
   - Una sección que no es un objeto (o cuyo items no es una
     lista) se descarta ENTERA: el campo queda ausente, que
     es como el servidor ya trata el «no consta» de las
     réplicas viejas. Sin sección en la entrada, sin sección
     en la salida: paridad con el resultado de siempre. */
const BUZON_SECCION_MAX_ITEMS240 = 200;
function buzonTexto240(valor, tope) {
  return typeof valor === 'string' ? redactExecutorText(valor.slice(0, tope)) : null;
}
function buzonConteo240(valor) {
  if (valor === null || valor === undefined || !Number.isFinite(Number(valor))) return null;
  return Math.max(0, Math.floor(Number(valor)));
}
function buzonFila240(fila, campos) {
  if (!fila || typeof fila !== 'object' || Array.isArray(fila)) return null;
  if (Object.keys(fila).some(clave => !campos.includes(clave))) return null;
  const limpia = {};
  for (const campo of campos) {
    if (!(campo in fila)) continue;
    if (campo === 'leido') {
      if (typeof fila.leido !== 'boolean') return null;
      limpia.leido = fila.leido;
    } else {
      const tope = campo === 'fecha' ? 40 : campo === 'estado' ? 80 : 300;
      const texto = buzonTexto240(fila[campo], tope);
      if (texto === null) return null;
      limpia[campo] = texto;
    }
  }
  return limpia;
}
function buzonSeccion240(seccion, campos, { conConteos = false } = {}) {
  if (!seccion || typeof seccion !== 'object' || Array.isArray(seccion)) return undefined;
  if (!Array.isArray(seccion.items)) return undefined;
  const limpia = { concluyente: seccion.concluyente === true,
    items: seccion.items.slice(0, BUZON_SECCION_MAX_ITEMS240)
      .map(fila => buzonFila240(fila, campos)).filter(Boolean) };
  if (conConteos) {
    if ('noLeidos' in seccion) limpia.noLeidos = buzonConteo240(seccion.noLeidos);
    if ('leidos' in seccion) limpia.leidos = buzonConteo240(seccion.leidos);
    if ('soloConteos' in seccion) limpia.soloConteos = seccion.soloConteos === true;
  }
  if ('motivo' in seccion) {
    const motivo = buzonTexto240(seccion.motivo, 600);
    if (motivo !== null) limpia.motivo = motivo;
  }
  return limpia;
}
export function sanitizeBuzonSecciones240(result = {}) {
  const comunicados = buzonSeccion240(result?.comunicados,
    ['fecha', 'asunto', 'leido'], { conConteos: true });
  const documentos = buzonSeccion240(result?.documentos,
    ['fecha', 'nombre', 'estado']);
  const secciones = {};
  if (comunicados !== undefined) secciones.comunicados = comunicados;
  if (documentos !== undefined) secciones.documentos = documentos;
  return secciones;
}

export function validateBuzonResult(result = {}) {
  /* Solo lo estructural se barre; lo narrativo y la evidencia
     del mismo resultado los trata validateExecutorResult con
     redacción (corrección H-1.1). Las secciones del Buzón
     completo van en lo narrativo (splitNarrative) y se
     validan con su forma propia, sin pasar por este barrido. */
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
  /* Conteo de comunicados sin leer (2.0.1): el motor lo lee de los
     encabezados de grupo de «Mis comunicados», sin abrir ninguno;
     viaja como número saneado o null si no consta. */
  const comunicadosNoLeidos = result.comunicadosNoLeidos === null || result.comunicadosNoLeidos === undefined ||
    !Number.isFinite(Number(result.comunicadosNoLeidos)) ? null :
    Math.max(0, Math.floor(Number(result.comunicadosNoLeidos)));
  return { notifications, comunicadosNoLeidos,
    /* Buzón completo (2.4.0, WC1b): las secciones saneadas se
       conservan enteras; sin sección en la entrada (réplicas
       viejas) el campo no nace y el retorno es el de siempre. */
    ...sanitizeBuzonSecciones240(result),
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
    /* accesoOk (1.31.0): true SOLO si el ejecutor declara que
       satBrowserLogin completó en ESTA corrida (booleano
       estricto: cualquier otra cosa es false). Con esta señal
       el servidor refresca el veredicto de la puerta aunque el
       trámite posterior a la entrada haya fallado — entrar y
       fallar después no es lo mismo que no poder entrar. */
    accesoOk: result.accesoOk === true,
    /* accesoFallo (1.32.1): la caída fue EN la entrada misma
       (booleano estricto + una clase de puerta): el ejecutor
       declara que su login no se completó, y el servidor
       escribe en la puerta el veredicto «no abre» con el
       motivo real — hasta ahora solo puerta-probar podía
       escribirlo y una entrada rechazada en un trámite dejaba
       la fila vieja intacta. */
    accesoFallo: result.accesoFallo === true &&
      ['portal-rechaza', 'credencial-invalida', 'sin-efirma'].includes(String(result.errorKind || ''))
      ? String(result.errorKind) : '',
    warnings: (narrativo.warnings || []).map(w => redactExecutorText(String(w).slice(0, 400))).slice(0, 20),
    error: redactExecutorText(String(narrativo.error || '').slice(0, 500)),
    errorKind: String(result.errorKind || '').slice(0, 60),
    diag: null, diagDecision: null, resultadosDiag: null };
  const sanearDiag = crudo => {
    let screenshot = null;
    if (crudo.screenshotBase64) {
      const bytes = Buffer.from(String(crudo.screenshotBase64), 'base64');
      /* Solo una imagen de verdad se archiva como captura
         (corrección H-1.5); lo demás se descarta, no se guarda. */
      screenshot = isImageBytes(bytes) ? bytes : null;
    }
    const limpio = { screenshot,
      html: crudo.html ? redactExecutorHtml(String(crudo.html).slice(0, 2 * 1024 * 1024)) : '',
      url: String(crudo.url || '').slice(0, 300) };
    if (limpio.screenshot && !limpio.screenshot.length) limpio.screenshot = null;
    return limpio;
  };
  if (narrativo.diag && typeof narrativo.diag === 'object') out.diag = sanearDiag(narrativo.diag);
  /* La página de DECISIÓN (1.32.1): la portada desde la que se
     navegó al destino que resultó muerto — viaja ADEMÁS de la
     página final y se sanea igual. Sin ella, un fallo en ruta
     muerta solo conservaba la 404 genérica, que no dice nada. */
  if (narrativo.diagDecision && typeof narrativo.diagDecision === 'object')
    out.diagDecision = sanearDiag(narrativo.diagDecision);
  /* La evidencia de RESULTADOS (2.3.2, P2): la página que la
     consulta enseñó al concluir la lectura de declaraciones,
     saneada como cualquier diag — viaja en corridas buenas y
     malas; el servidor la guarda como foto/HTML de la corrida
     (decl_runs) también en las buenas. */
  if (narrativo.resultadosDiag && typeof narrativo.resultadosDiag === 'object')
    out.resultadosDiag = sanearDiag(narrativo.resultadosDiag);
  if (job.kind === 'buzon-listar') {
    const buzon = validateBuzonResult(result);
    out.notifications = buzon.notifications;
    out.counts = buzon.counts;
    out.comunicadosNoLeidos = buzon.comunicadosNoLeidos;
    /* Buzón completo (2.4.0, WC1b): las secciones validadas
       pasan al resultado del protocolo; sin sección validada
       el campo no nace (paridad con las réplicas viejas). */
    if (buzon.comunicados !== undefined) out.comunicados = buzon.comunicados;
    if (buzon.documentos !== undefined) out.documentos = buzon.documentos;
  }
  if (job.kind === 'puerta-probar') {
    /* La puerta solo declara «abre» y la operación de entrar:
       nada de navegar ni listar (1.30.0). Un «hecho» sin el
       «abre» explícito no acredita la puerta. */
    out.puerta = result.puerta === 'abre' ? 'abre' : '';
    if (out.puerta && !operations.includes('entrar-con-efirma'))
      throw new Error('El resultado de la prueba de puerta no declara la operación de entrar con e.firma.');
  }
  if (job.kind === 'declaraciones-recuperar') {
    /* Progreso por operaciones (2.3.0, pieza nº 6): el ejecutor
       puede declarar qué operaciones ya completó en esta corrida
       ({ operacionesCompletadas: [nº operación, …] }) para que
       una recuperación de solo-faltantes reanude sin repetir las
       hechas. Viaja saneado como las transacciones: números de
       operación válidos (sin espacios), sin duplicados y con
       tope; lo que no case se filtra, no tumba el resultado —
       y no es una operación del protocolo: la lista cerrada
       SAT_EXECUTOR_OPERATIONS no crece. */
    const vistasOp = new Set();
    out.operacionesCompletadas = [];
    /* El ejecutor la declara dentro de su «progreso»
       ({ progreso: { operacionesCompletadas } }, la forma que
       ejecutor-local.mjs emite); la forma a nivel raíz también se
       admite. Sin este puente, el progreso llegaba al servidor y
       se perdía en la validación (admisión mínima 2.3.0, pieza
       nº 6, constructor de servidor). */
    const crudasProgreso = Array.isArray(result.operacionesCompletadas) ? result.operacionesCompletadas :
      Array.isArray(result.progreso?.operacionesCompletadas) ? result.progreso.operacionesCompletadas : [];
    for (const cruda of crudasProgreso) {
      const operacion = String(cruda || '').replace(/\s+/g, '');
      if (!OPERACION_RE.test(operacion) || vistasOp.has(operacion)) continue;
      vistasOp.add(operacion);
      out.operacionesCompletadas.push(operacion);
      if (out.operacionesCompletadas.length >= 500) break;
    }
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
