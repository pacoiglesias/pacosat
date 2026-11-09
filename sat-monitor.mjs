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
   9 nov 2026; documentación de CfdiUtils): el total debe ir SIN
   ceros no significativos — «0.99», «1.0», «0.0» — porque un total
   con otro formato (p. ej. seis decimales fijos) produce N-601
   aunque el comprobante sea válido y vigente. El UUID ya va en
   mayúsculas y los RFC tal como vienen en el XML (lookupFields). */
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
  return '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><Consulta xmlns="http://tempuri.org/"><expresionimpresa>' +
    expression + '</expresionimpresa></Consulta></s:Body></s:Envelope>';
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
     rechazó el FORMATO de la consulta — la única causa documentada
     es el formato del total en la expresión impresa, que desde la
     1.9.0 se normaliza antes de consultar (normalizeTotalForQuery).
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

export function createMonitor(db, { now = Date.now, checkSat = querySat, refreshEfos = loadEfos, notifyCancellation, notifyEfos } = {}) {
  db.exec("CREATE TABLE IF NOT EXISTS cfdi_watch (id TEXT PRIMARY KEY, emitter TEXT NOT NULL, receiver TEXT NOT NULL, total TEXT NOT NULL, seal TEXT NOT NULL, next INTEGER NOT NULL, checked INTEGER, result TEXT, error TEXT NOT NULL DEFAULT ''); CREATE TABLE IF NOT EXISTS efos_rfc (rfc TEXT PRIMARY KEY, statuses TEXT NOT NULL); CREATE TABLE IF NOT EXISTS efos_meta (id INTEGER PRIMARY KEY CHECK(id=1), fetched INTEGER, next INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT ''); INSERT OR IGNORE INTO efos_meta(id) VALUES(1);");
  db.exec('CREATE TABLE IF NOT EXISTS cancellation_alert (id TEXT PRIMARY KEY, due INTEGER NOT NULL, sent INTEGER);');
  db.exec('CREATE TABLE IF NOT EXISTS efos_alert (key TEXT PRIMARY KEY, rfc TEXT NOT NULL, due INTEGER NOT NULL, sent INTEGER);');
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
        /* «No encontrado» y «Formato rechazado» son respuestas
           firmes del SAT: se rechequean al mes, no a diario ni cada
           hora. El resto, a diario. */
        const next = (result.state === 'No encontrado' || result.state === 'Formato rechazado')
          ? time + 30 * DAY : time + DAY;
        db.prepare("UPDATE cfdi_watch SET checked=?,result=?,next=?,error='' WHERE id=?").run(time, JSON.stringify(result), next, item.id);
        if (result.state === 'Cancelado') db.prepare('INSERT OR IGNORE INTO cancellation_alert(id,due) VALUES (?,?)').run(item.id, time);
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
  function listsMeta() {
    const meta = db.prepare('SELECT fetched,error FROM efos_meta WHERE id=1').get();
    const count = db.prepare('SELECT COUNT(*) AS total FROM efos_rfc').get().total;
    return { fetched: meta.fetched, error: meta.error, count };
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
  /* Botón «Actualizar listados»: fuerza la descarga del 69-B ahora. */
  async function refreshLists() {
    if (busy) return { ...listsMeta(), busy: true };
    busy = true;
    try { await refreshEfosNow(now()); } finally { busy = false; }
    return { ...listsMeta(), busy: false };
  }
  async function tick() {
    if (busy) return;
    busy = true;
    try {
      const time = now();
      const snapshot = db.prepare('SELECT next FROM efos_meta WHERE id=1').get();
      if (time >= snapshot.next) await refreshEfosNow(time);
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
  return { register, status, tick, summary, checkNow, processNow, refreshLists };
}
