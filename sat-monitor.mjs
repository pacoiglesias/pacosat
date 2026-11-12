const STATUS_URL = 'https://consultaqr.facturaelectronica.sat.gob.mx/ConsultaCFDIService.svc';
const EFOS_URL = 'https://wu1agsprosta001.blob.core.windows.net/agsc-publicaciones/Datos_abiertos/Documents_AGAFF/Listado_completo_69-B.csv';
const RFC = /^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/u;
const UUID = /^[A-F0-9]{8}(?:-[A-F0-9]{4}){3}-[A-F0-9]{12}$/;
const DAY = 86400000;
const HOUR = 3600000;
const text = value => typeof value === 'string' ? value : '';
export const cleanName = value => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();

function limited(response, max) {
  if (!response.ok || !response.body) throw new Error('El servicio oficial respondió HTTP ' + response.status + '.');
  return (async () => {
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > max) throw new Error('La respuesta oficial supera el tamaño permitido.');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  })();
}
export function lookupFields(value) {
  const id = text(value?.id).toUpperCase(), emitter = text(value?.emitter).toUpperCase(), receiver = text(value?.receiver).toUpperCase();
  const total = text(value?.total), seal = text(value?.seal);
  if (!UUID.test(id) || !RFC.test(emitter) || !RFC.test(receiver) ||
      !/^\d{1,18}(?:\.\d{1,6})?$/.test(total) || (seal && !/^[A-Za-z0-9+/=]{8}$/.test(seal))) {
    throw new Error('El CFDI no contiene los datos requeridos para consultar el SAT.');
  }
  return { id, emitter, receiver, total, seal };
}
/* Normalización de la expresión impresa (barrido de comunidades,
   9 nov 2026; documentación de CfdiUtils): el total va SIN ceros no
   significativos — «0.99», «1.0», «0.0» —. El UUID ya va en
   mayúsculas y los RFC tal como vienen en el XML (lookupFields).
   OJO (10 nov 2026, probado en vivo contra el SAT con 3 CFDI
   reales): el N-601 universal NO venía de este formato — venía del
   nombre del elemento SOAP en soapQuery (ver su comentario). Esta
   normalización se conserva porque es la forma documentada de la
   expresión, pero ya no se le atribuye el N-601. */
export function normalizeTotalForQuery(total) {
  const [integer, decimals = ''] = String(total).split('.');
  const trimmed = decimals.replace(/0+$/, '');
  return BigInt(integer).toString() + '.' + (trimmed || '0');
}
export function soapQuery(input) {
  const value = lookupFields(input);
  const total = normalizeTotalForQuery(value.total);
  const param = new URLSearchParams({ id: value.id, re: value.emitter, rr: value.receiver, tt: total });
  if (value.seal) param.set('fe', value.seal);
  const expression = ('?' + param.toString()).replaceAll('&', '&amp;');
  /* El elemento se llama «expresionImpresa» CON I mayúscula: el
     servicio del SAT enlaza el parámetro distinguiendo mayúsculas y
     con «expresionimpresa» en minúsculas recibía la expresión VACÍA
     y respondía N-601 a todo (causa probada en vivo el 10 nov 2026
     con 3 CFDI reales: mismo sobre y misma expresión, solo cambia
     la capitalización, y el SAT pasa de N-601 a «S - Comprobante
     obtenido satisfactoriamente · Vigente»). No tocar la caja. */
  return '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><Consulta xmlns="http://tempuri.org/"><expresionImpresa>' +
    expression + '</expresionImpresa></Consulta></s:Body></s:Envelope>';
}
export async function querySat(input, request = fetch) {
  /* El servicio del SAT es lento: con 15 s una parte de las consultas
     moría por timeout aunque el SAT fuera a responder (visto en vivo el
     9 nov 2026). 30 s da margen sin colgar la tanda. */
  const response = await request(STATUS_URL, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
    headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: '"http://tempuri.org/IConsultaCFDIService/Consulta"' }, body: soapQuery(input) });
  const xml = (await limited(response, 128 * 1024)).toString('utf8');
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('Respuesta XML inesperada.');
  const { DOMParser } = await import('@xmldom/xmldom');
  const result = new DOMParser().parseFromString(xml, 'application/xml');
  const acuse = result.getElementsByTagNameNS('http://tempuri.org/', 'ConsultaResult')[0];
  if (!acuse) throw new Error('El SAT no devolvió un acuse de consulta.');
  const val = name => acuse.getElementsByTagNameNS('http://schemas.datacontract.org/2004/07/Sat.Cfdi.Negocio.ConsultaCfdi.Servicio', name)[0]?.textContent.trim() || '';
  const code = val('CodigoEstatus');
  const state = val('Estado');
  /* N-601 y N-602 son RESPUESTA del SAT, no un fallo de transporte.
     Se guardan como respuesta (rechequeo a los 30 días, no cada
     hora: tratarlos como error transitorio dejaba la pantalla en
     «pendiente de reintento» para siempre), pero NO son lo mismo y
     la pantalla los distingue (barrido de comunidades, 9 nov 2026):
     N-602 = el SAT no localizó el comprobante; N-601 = el SAT
     rechazó el FORMATO de la consulta. El N-601 que PacoSAT sufrió
     en masa hasta la 1.11.0 tenía causa propia y ya probada: el
     nombre del elemento SOAP en minúsculas (ver soapQuery); con la
     corrección, el SAT responde «S» a los mismos CFDI. Si un N-601
     aparece en el futuro, es el SAT rechazando ESA consulta.
     Ninguna fuente revisada respalda bloqueo por volumen/IP. */
  if (/^N\s*-?\s*602\b/i.test(code)) return { state: 'No encontrado', code, cancellation: '', cancelable: '', efos: '' };
  if (/^N\s*-?\s*601\b/i.test(code)) return { state: 'Formato rechazado', code, cancellation: '', cancelable: '', efos: '' };
  if (!/^S\b/i.test(code) || !['Vigente','Cancelado'].includes(state)) throw new Error('El SAT no confirmó el estado: ' + (code || 'respuesta incompleta').slice(0, 150));
  return { state, code, cancellation: val('EstatusCancelacion'), cancelable: val('EsCancelable'), efos: val('ValidacionEFOS') };
}

export function csvRows(content) {
  const first = content.split(/\r?\n/).find(line => /rfc/i.test(line) && /situaci[oó]n/i.test(line)) || '';
  const delimiter = first.includes(';') && !first.includes(',') ? ';' : ',';
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (quoted) {
      if (ch === '"' && content[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && !field) quoted = true;
    else if (ch === delimiter) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && content[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (quoted) throw new Error('El listado oficial contiene una fila incompleta.');
  if (row.length || field) { row.push(field); rows.push(row); }
  return rows;
}
export function parseEfos(content) {
  const rows = csvRows(content);
  const header = rows.findIndex(row => row.some(cell => cleanName(cell) === 'rfc') &&
    row.some(cell => /^situacion(?: del contribuyente)?$/.test(cleanName(cell))));
  if (header < 0) throw new Error('No se reconocen las columnas del listado oficial 69-B.');
  const columns = rows[header].map(cleanName);
  const rfcColumn = columns.indexOf('rfc'), statusColumn = columns.findIndex(value => value.startsWith('situacion'));
  const index = new Map();
  for (const row of rows.slice(header + 1)) {
    const rfc = text(row[rfcColumn]).trim().toUpperCase();
    const value = cleanName(text(row[statusColumn]));
    const status = /^presunt/.test(value) ? 'Presunto' : /^definitiv/.test(value) ? 'Definitivo' :
      /^desvirtuad/.test(value) ? 'Desvirtuado' : /sentencia|medio de defensa favorable/.test(value) ? 'Sentencia favorable' : '';
    if (!RFC.test(rfc) || !status) continue;
    if (!index.has(rfc)) index.set(rfc, new Set());
    index.get(rfc).add(status);
  }
  if (!index.size) throw new Error('El listado oficial 69-B no contiene registros reconocibles.');
  return index;
}
async function loadEfos(request = fetch) {
  const raw = await limited(await request(EFOS_URL, { redirect: 'error', signal: AbortSignal.timeout(25000) }), 32 * 1024 * 1024);
  let content;
  try { content = new TextDecoder('utf-8', { fatal: true }).decode(raw); }
  catch { content = new TextDecoder('windows-1252').decode(raw); }
  return parseEfos(content);
}

export function createMonitor(db, { now = Date.now, checkSat = querySat, refreshEfos = loadEfos, notifyCancellation, notifyEfos, notifyDiscovery, notifyCancelPending } = {}) {
  db.exec("CREATE TABLE IF NOT EXISTS cfdi_watch (id TEXT PRIMARY KEY, emitter TEXT NOT NULL, receiver TEXT NOT NULL, total TEXT NOT NULL, seal TEXT NOT NULL, next INTEGER NOT NULL, checked INTEGER, result TEXT, error TEXT NOT NULL DEFAULT ''); CREATE TABLE IF NOT EXISTS efos_rfc (rfc TEXT PRIMARY KEY, statuses TEXT NOT NULL); CREATE TABLE IF NOT EXISTS efos_meta (id INTEGER PRIMARY KEY CHECK(id=1), fetched INTEGER, next INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT ''); INSERT OR IGNORE INTO efos_meta(id) VALUES(1);");
  db.exec('CREATE TABLE IF NOT EXISTS monitor_migrations (name TEXT PRIMARY KEY, at INTEGER NOT NULL);');
  /* Migración ÚNICA (10 nov 2026): los veredictos «Formato
     rechazado» (N-601) guardados hasta la 1.11.0 son falsos — el SAT
     recibía la expresión vacía por el nombre del elemento SOAP en
     minúsculas (ver soapQuery) — y quedaron aparcados con reintento
     a 30 días: ni el tick ni «Revisar ahora» (que filtra result IS
     NULL) los re-preguntaría jamás. Se limpian SOLO esas filas
     (result, checked y next) para que la vigilancia las consulte de
     nuevo con la pregunta corregida. La marca en monitor_migrations
     la hace de una sola vez: un «Formato rechazado» FUTURO y
     legítimo no se borra al rearrancar. */
  if (!db.prepare('SELECT name FROM monitor_migrations WHERE name=?').get('reset-n601-2026-11')) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const reset = db.prepare('UPDATE cfdi_watch SET result=NULL, checked=NULL, next=0 WHERE id=?');
      for (const row of db.prepare('SELECT id, result FROM cfdi_watch WHERE result IS NOT NULL').all()) {
        let state = '';
        try { state = JSON.parse(row.result)?.state || ''; } catch { state = ''; }
        if (state === 'Formato rechazado') reset.run(row.id);
      }
      db.prepare('INSERT INTO monitor_migrations(name, at) VALUES (?,?)').run('reset-n601-2026-11', now());
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  db.exec('CREATE TABLE IF NOT EXISTS cancellation_alert (id TEXT PRIMARY KEY, due INTEGER NOT NULL, sent INTEGER);');
  /* Primeros descubrimientos de cancelación (1.13.1, pieza G):
     un CFDI que se consulta por primera vez (o tras un reseteo de
     su fila) y ya viene Cancelado NO es una urgencia nueva: es
     historia descubierta al ponerse al día. Se anota aquí —con su
     marca de «anotado en Avisos» (noted) y de «incluido en el
     resumen por correo» (digested)— y jamás genera correo
     individual. La marca que distingue transición de descubrimiento
     es el resultado ANTERIOR guardado en la propia fila: solo si
     constaba «Vigente» y pasa a «Cancelado» hay transición. */
  db.exec('CREATE TABLE IF NOT EXISTS cancellation_seen (id TEXT PRIMARY KEY, at INTEGER NOT NULL, noted INTEGER, digested INTEGER);');
  /* Migración única anti-avalancha (1.13.1): lo que a la hora de
     actualizar aún esté SIN ENVIAR en cancellation_alert es, por
     definición, historia acumulada (la limpieza del N-601 la
     encoló en bloque), no transiciones frescas: pasa a primeros
     descubrimientos y saldrá —si acaso— en UN resumen, nunca en
     correos sueltos. Las ya enviadas quedan como historia. */
  if (!db.prepare('SELECT name FROM monitor_migrations WHERE name=?').get('cancel-digest-2026-11')) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('INSERT OR IGNORE INTO cancellation_seen(id,at) SELECT id,due FROM cancellation_alert WHERE sent IS NULL').run();
      db.prepare('DELETE FROM cancellation_alert WHERE sent IS NULL').run();
      db.prepare('INSERT INTO monitor_migrations(name, at) VALUES (?,?)').run('cancel-digest-2026-11', now());
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  db.exec('CREATE TABLE IF NOT EXISTS efos_alert (key TEXT PRIMARY KEY, rfc TEXT NOT NULL, due INTEGER NOT NULL, sent INTEGER);');
  /* Solicitudes de cancelación PENDIENTES de aceptación (1.27.0,
     bloque D): un CFDI Vigente cuyo EstatusCancelacion del SAT dice
     «En proceso de cancelación» tiene una solicitud abierta que el
     receptor debe aceptar o rechazar; si nadie responde, el SAT la
     da por aceptada al vencer el plazo (3 días desde la solicitud,
     regla operativa del servicio de consulta). Se registra la
     primera vez que se ve, con su fecha límite calculada, y se
     marca resuelta cuando una consulta posterior ya no la muestra
     en proceso. La fila sobrevive a la resolución (historia). */
  db.exec('CREATE TABLE IF NOT EXISTS cancellation_pending (id TEXT PRIMARY KEY, firstSeen INTEGER NOT NULL, due INTEGER NOT NULL, notified INTEGER, resolved INTEGER);');
  let busy = false;
  const add = db.prepare("INSERT INTO cfdi_watch(id,emitter,receiver,total,seal,next) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET seal=excluded.seal,next=0 WHERE cfdi_watch.seal='' AND excluded.seal<>''");
  const saved = db.prepare('SELECT * FROM cfdi_watch WHERE id=?');
  const efos = db.prepare('SELECT statuses FROM efos_rfc WHERE rfc=?');
  function register(data) {
    const row = lookupFields(data);
    add.run(row.id, row.emitter, row.receiver, row.total, row.seal, now());
  }
  function status(ids) {
    const snapshot = db.prepare('SELECT fetched,error FROM efos_meta WHERE id=1').get();
    return { fetched: snapshot.fetched, error: snapshot.error, results: ids.flatMap(id => {
      const item = saved.get(id);
      if (!item) return [];
      return [{ id, checked: item.checked, error: item.error, sat: item.result ? JSON.parse(item.result) : null,
        efos: JSON.parse(efos.get(item.emitter)?.statuses || '[]') }];
    }) };
  }
  /* Una consulta al SAT con su guardado: la usan la tanda automática
     (tick) y la revisión manual por lotes (processNow), sin duplicar. */
  async function checkOne(item, time) {
    try {
      const result = await checkSat(item);
      db.exec('BEGIN IMMEDIATE');
      try {
        /* Cadencias (1.27.0, bloque D — «control en tiempo real lo
           más posible»): «No encontrado», «Formato rechazado» y
           «Cancelado» son respuestas firmes del SAT: se rechequean
           al mes. Un «Vigente» se rechequea a las 6 HORAS (antes:
           a diario) — es la cadencia más estrecha que el servicio
           público de consulta tolera sin convertir la vigilancia
           en un martilleo, y es lo que hace que una cancelación se
           sepa el mismo día en las dos direcciones. */
        const next = result.state === 'Vigente' ? time + 6 * HOUR : time + 30 * DAY;
        /* Transición vs primer descubrimiento (1.13.1, pieza G):
           manda el estado que la fila YA guardaba antes de esta
           consulta. Vigente → Cancelado = transición (alerta
           individual). Sin resultado anterior —primera consulta o
           fila reseteada— u otro estado previo = descubrimiento:
           se anota en cancellation_seen para el resumen único. */
        let prevState = '';
        try { prevState = item.result ? JSON.parse(item.result).state || '' : ''; } catch { prevState = ''; }
        db.prepare("UPDATE cfdi_watch SET checked=?,result=?,next=?,error='' WHERE id=?").run(time, JSON.stringify(result), next, item.id);
        if (result.state === 'Cancelado' && prevState !== 'Cancelado') {
          if (prevState === 'Vigente') db.prepare('INSERT OR IGNORE INTO cancellation_alert(id,due) VALUES (?,?)').run(item.id, time);
          else db.prepare('INSERT OR IGNORE INTO cancellation_seen(id,at) VALUES (?,?)').run(item.id, time);
        }
        /* Solicitud de cancelación en proceso (1.27.0): se abre
           la ficha la primera vez que el SAT la enseña y se cierra
           cuando deja de enseñarla (aceptada, rechazada o vencida
           — el estado final del CFDI lo dice la propia consulta). */
        const enProceso = result.state === 'Vigente' && /proceso/i.test(result.cancellation || '');
        if (enProceso) {
          db.prepare('INSERT OR IGNORE INTO cancellation_pending(id,firstSeen,due) VALUES (?,?,?)')
            .run(item.id, time, time + 3 * DAY);
        } else {
          db.prepare('UPDATE cancellation_pending SET resolved=? WHERE id=? AND resolved IS NULL').run(time, item.id);
        }
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      return true;
    } catch (error) { db.prepare('UPDATE cfdi_watch SET error=?,next=? WHERE id=?').run(text(error.message).slice(0, 180), time + HOUR, item.id); return false; }
  }
  /* Descarga y guardado del listado 69-B con sus avisos de alta: lo
     llama el tick cuando toca y el botón «Actualizar listados». */
  async function refreshEfosNow(time) {
    db.prepare('UPDATE efos_meta SET next=? WHERE id=1').run(time + HOUR);
    try {
      const data = await refreshEfos();
      db.exec('BEGIN IMMEDIATE');
      try {
        const before = new Map(db.prepare('SELECT rfc,statuses FROM efos_rfc').all().map(row => [row.rfc, new Set(JSON.parse(row.statuses))]));
        const parties = new Set(db.prepare('SELECT emitter AS rfc FROM cfdi_watch UNION SELECT receiver FROM cfdi_watch').all().map(row => row.rfc));
        db.exec('DELETE FROM efos_rfc');
        const statement = db.prepare('INSERT INTO efos_rfc VALUES (?,?)');
        for (const [rfc, values] of data) statement.run(rfc, JSON.stringify([...values]));
        if (before.size) for (const [rfc, values] of data) {
          const fresh = [...values].filter(state => (state === 'Presunto' || state === 'Definitivo') && !before.get(rfc)?.has(state));
          if (fresh.length && parties.has(rfc)) db.prepare('INSERT OR IGNORE INTO efos_alert(key,rfc,due) VALUES (?,?,?)')
            .run(rfc + '|' + fresh.sort().join(','), rfc, time);
        }
        db.prepare("UPDATE efos_meta SET fetched=?,next=?,error='' WHERE id=1").run(time, time + DAY);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    } catch (error) { db.prepare('UPDATE efos_meta SET error=? WHERE id=1').run(text(error.message).slice(0, 180)); }
  }
  let listsBusy = false;
  function listsMeta() {
    const meta = db.prepare('SELECT fetched,error FROM efos_meta WHERE id=1').get();
    const count = db.prepare('SELECT COUNT(*) AS total FROM efos_rfc').get().total;
    return { fetched: meta.fetched, error: meta.error, count, refreshing: listsBusy };
  }
  /* Resumen de la vigilancia para una selección de CFDI: las cifras de
     las tarjetas de la pantalla, contadas en el servidor sobre TODA la
     selección (no solo sobre la página visible). La coincidencia 69-B
     manda sobre el estado, como en el anillo de estados. */
  function summary(ids) {
    const counts = { total: 0, vigentes: 0, cancelados: 0, noEncontrados: 0, formatoRechazado: 0, enListado69B: 0,
      sinRevisar: 0, conProblema: 0, revisados: 0, ultimaRevision: 0 };
    const affected = new Map();
    const get = db.prepare('SELECT * FROM cfdi_watch WHERE id=?');
    const efosGet = db.prepare('SELECT statuses FROM efos_rfc WHERE rfc=?');
    for (const id of ids) {
      counts.total++;
      const item = get.get(id);
      if (item?.checked) counts.ultimaRevision = Math.max(counts.ultimaRevision, item.checked);
      if (item?.result) counts.revisados++;
      const hits = item ? JSON.parse(efosGet.get(item.emitter)?.statuses || '[]')
        .filter(state => state === 'Presunto' || state === 'Definitivo') : [];
      if (hits.length) {
        counts.enListado69B++;
        affected.set(item.emitter, (affected.get(item.emitter) || 0) + 1);
        continue;
      }
      if (!item || (!item.result && !item.error)) { counts.sinRevisar++; continue; }
      if (!item.result) { counts.conProblema++; continue; }
      const state = JSON.parse(item.result).state;
      if (state === 'Vigente') counts.vigentes++;
      else if (state === 'Cancelado') counts.cancelados++;
      else if (state === 'No encontrado') counts.noEncontrados++;
      else if (state === 'Formato rechazado') counts.formatoRechazado++;
      else counts.conProblema++;
    }
    return { counts, masAfectados: [...affected.entries()].map(([rfc, count]) => ({ rfc, count }))
      .sort((a, b) => b.count - a.count).slice(0, 3), lists: listsMeta() };
  }
  /* «Revisar ahora»: pone al frente de la cola los CFDI pedidos que
     aún no tienen respuesta del SAT (con o sin error anterior). */
  function checkNow(ids) {
    const statement = db.prepare('UPDATE cfdi_watch SET next=0 WHERE id=? AND result IS NULL');
    let queued = 0;
    for (const id of ids) queued += statement.run(id).changes;
    return queued;
  }
  /* Revisión forzada de UN comprobante (1.13.1): la misma consulta
     de producción de la tanda (checkOne, con la «expresionImpresa»
     correcta) y las mismas reglas de guardado — éxito: resultado,
     checked=ahora y next según el veredicto; error de transporte:
     queda el error y el next a una hora SIN pisar el resultado
     anterior bueno. Sirve aunque la fila ya tenga resultado (es el
     «forzar» de la tarjeta) y devuelve el estado ya leído de la
     base, en la misma forma que status(). null si el UUID no está
     en la vigilancia. */
  async function checkOneNow(id) {
    const item = saved.get(id);
    if (!item) return null;
    if (busy) return { busy: true, ok: false, ...status([id]).results[0] };
    busy = true;
    try {
      const ok = await checkOne(item, now());
      return { busy: false, ok, ...status([id]).results[0] };
    } finally { busy = false; }
  }
  const pendingCount = () => db.prepare('SELECT COUNT(*) AS total FROM cfdi_watch WHERE result IS NULL').get().total;
  /* Una tanda manual de revisión inmediata (la pantalla la encadena
     con el indicador de actividad hasta agotar la cola). */
  async function processNow(limit = 10) {
    if (busy) return { processed: 0, remaining: pendingCount(), busy: true };
    busy = true;
    try {
      const time = now();
      const due = db.prepare('SELECT * FROM cfdi_watch WHERE next<=? AND result IS NULL ORDER BY next LIMIT ?').all(time, limit);
      let processed = 0;
      for (const item of due) { await checkOne(item, time); processed++; }
      return { processed, remaining: pendingCount(), busy: false };
    } finally { busy = false; }
  }
  /* Botón «Actualizar listados» (1.13.1, pieza H): la descarga del
     69-B NO espera dentro de la petición — arranca como trabajo con
     estado y la respuesta vuelve al instante con la foto actual;
     el avance se lee en listsMeta().refreshing (vía el resumen).
     Bandera PROPIA, separada de la tanda de revisión: un refresco
     en curso no bloquea revisiones ni al revés. */
  function refreshLists() {
    if (listsBusy) return { ...listsMeta(), started: false };
    listsBusy = true;
    (async () => {
      try { await refreshEfosNow(now()); }
      catch { /* refreshEfosNow ya deja el error guardado en la meta. */ }
      finally { listsBusy = false; }
    })();
    return { ...listsMeta(), started: true };
  }
  async function tick() {
    if (busy) return;
    busy = true;
    try {
      const time = now();
      const snapshot = db.prepare('SELECT next FROM efos_meta WHERE id=1').get();
      if (time >= snapshot.next && !listsBusy) {
        listsBusy = true;
        try { await refreshEfosNow(time); } finally { listsBusy = false; }
      }
      for (const item of db.prepare('SELECT * FROM cfdi_watch WHERE next<=? ORDER BY next LIMIT 5').all(time)) {
        await checkOne(item, time);
      }
      if (notifyCancellation) {
        const alerts = db.prepare('SELECT id FROM cancellation_alert WHERE sent IS NULL AND due<=? ORDER BY due LIMIT 10').all(time);
        for (const { id } of alerts) {
          db.prepare('UPDATE cancellation_alert SET due=? WHERE id=?').run(time + 15 * 60000, id);
          try {
            if (await notifyCancellation(saved.get(id))) db.prepare('UPDATE cancellation_alert SET sent=? WHERE id=?').run(now(), id);
          } catch { /* Se reintenta en el próximo intervalo. */ }
        }
      }
      if (notifyCancelPending) {
        /* Solicitudes de cancelación pendientes (1.27.0): aviso
           UNA vez por solicitud, con su fecha límite; la fila
           queda para que la pantalla enseñe las abiertas. */
        const pendings = db.prepare('SELECT * FROM cancellation_pending WHERE notified IS NULL AND resolved IS NULL ORDER BY firstSeen LIMIT 10').all();
        for (const row of pendings) {
          try {
            if (await notifyCancelPending(saved.get(row.id), row)) db.prepare('UPDATE cancellation_pending SET notified=? WHERE id=?').run(now(), row.id);
          } catch { /* Se reintenta en el próximo intervalo. */ }
        }
      }
      if (notifyDiscovery) {
        /* Los descubrimientos se anotan en Avisos (vía la alerta
           interna que crea el servidor), SIN correo individual:
           el correo, si toca, es el resumen único del día. */
        const seen = db.prepare('SELECT id FROM cancellation_seen WHERE noted IS NULL ORDER BY at LIMIT 10').all();
        for (const { id } of seen) {
          try {
            if (await notifyDiscovery(saved.get(id))) db.prepare('UPDATE cancellation_seen SET noted=? WHERE id=?').run(now(), id);
          } catch { /* Se reintenta en el próximo intervalo. */ }
        }
      }
      if (notifyEfos) {
        const alerts = db.prepare('SELECT key,rfc FROM efos_alert WHERE sent IS NULL AND due<=? ORDER BY due LIMIT 10').all(time);
        for (const { key, rfc } of alerts) {
          db.prepare('UPDATE efos_alert SET due=? WHERE key=?').run(time + 15 * 60000, key);
          try {
            if (await notifyEfos({ rfc, statuses: key.slice(rfc.length + 1).split(',') })) db.prepare('UPDATE efos_alert SET sent=? WHERE key=?').run(now(), key);
          } catch { /* Se reintenta en el próximo intervalo. */ }
        }
      }
    } finally { busy = false; }
  }
  /* Solicitudes de cancelación abiertas ahora mismo (1.27.0):
     la pantalla y las pruebas las leen de aquí, no de otra lista. */
  function pendingCancellations() {
    return db.prepare('SELECT * FROM cancellation_pending WHERE resolved IS NULL ORDER BY due').all()
      .map(row => ({ ...row, item: saved.get(row.id) || null }));
  }
  return { register, status, tick, summary, checkNow, checkOneNow, processNow, refreshLists, pendingCancellations };
}
