/* ================================================================
   Ronda 2.0 · Tanda 4 — Centro de salud, reparación en un toque,
   coherencia interna (BER-GHON 1), ensayo de restauración
   automático (BER-GHON 5), prueba de humo tras el montaje
   (BER-GHON 6), configuración guiada y cajón de ayuda (20#20-1).

   (a) Salud compone las tarjetas con semilla: ejecutor apagado ⇒
       su tarjeta en mal con la causa; puerta vieja ⇒ foto vieja.
   (b) «Re-probar la puerta» con ejecutor apagado NO encola y lo
       dice; con ejecutor vivo encola puerta-probar una sola vez.
   (c) Coherencia: un news_item sin alta real detrás (el tipo del
       job 57) ⇒ el cruce lo detecta y lo enseña; sin desacuerdo
       ⇒ «Todo cuadra».
   (d) Ensayo de restauración sobre un respaldo semilla ⇒
       resultado registrado con conteos cruzados.
   (e) Arranque con versión nueva ⇒ UNA entrada de humo en el
       Registro; con la misma versión, ninguna más.
   (f) Un paso de configuración solo se marca hecho con su
       comprobación real (correo sin configurar ⇒ pendiente;
       configurado ⇒ hecho; ejecutor y e.firma, igual).
   ================================================================ */
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPacoSATService } from './local-server.mjs';

const ORIGIN = 'https://pacosat.test';
const KEY = 'f'.repeat(64);
const OWN = 'MFI6212158B4';
const EMISOR = 'AAA010101AAA';
const UUID1 = '11111111-1111-4111-8111-111111111111';

/* Parser de juguete (el de ronda200c) para la carpeta vigilada. */
class FixtureParser {
  parseFromString(xml) {
    const cfdi = 'http://www.sat.gob.mx/cfd/4';
    const node = (localName, attributes = {}, children = [], namespaceURI = cfdi) => ({
      nodeType: 1, localName, namespaceURI, childNodes: children,
      get children() { return children; },
      getAttribute: name => attributes[name] ?? null,
      getElementsByTagNameNS: (ns, name) => children.filter(item => item.namespaceURI === ns && item.localName === name)
    });
    const attr = (tag, name) => (xml.match(new RegExp('<' + tag + '\\b[^>]*\\b' + name + '="([^"]*)"')) || [])[1] || '';
    const stamp = node('TimbreFiscalDigital', { UUID: attr('tfd:TimbreFiscalDigital', 'UUID') }, [],
      'http://www.sat.gob.mx/TimbreFiscalDigital');
    const root = node('Comprobante',
      { Fecha: attr('cfdi:Comprobante', 'Fecha'), Total: attr('cfdi:Comprobante', 'Total'),
        Serie: attr('cfdi:Comprobante', 'Serie'), Folio: attr('cfdi:Comprobante', 'Folio'),
        Moneda: 'MXN', TipoDeComprobante: 'I' },
      [node('Emisor', { Rfc: attr('cfdi:Emisor', 'Rfc'), Nombre: 'EMISOR DE JUGUETE' }),
       node('Receptor', { Rfc: attr('cfdi:Receptor', 'Rfc'), Nombre: 'RECEPTOR DE JUGUETE' }),
       node('Complemento', {}, [stamp])]);
    return { documentElement: root, getElementsByTagName: () => [] };
  }
}
const xmlCfdi = ({ uuid, fecha, total = '116.00', folio = '' }) =>
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital" ' +
  'Version="4.0" Fecha="' + fecha + '" Moneda="MXN" Total="' + total + '" TipoDeComprobante="I"' +
  (folio ? ' Folio="' + folio + '"' : '') + '>' +
  '<cfdi:Emisor Rfc="' + EMISOR + '" Nombre="EMISOR DE JUGUETE"/>' +
  '<cfdi:Receptor Rfc="' + OWN + '" Nombre="RECEPTOR DE JUGUETE"/>' +
  '<cfdi:Complemento><tfd:TimbreFiscalDigital Version="1.1" UUID="' + uuid + '" FechaTimbrado="' + fecha + '"/></cfdi:Complemento>' +
  '</cfdi:Comprobante>';

function makeHarness(extra = {}) {
  let time = Date.parse('2026-11-15T15:00:00Z'); /* domingo 15 nov 2026, 09:00 MX */
  let token = '';
  const mails = [];
  const service = createPacoSATService({
    dbFile: ':memory:', html: '<html><head><!--PACOSAT_TOKEN--></head><body>prueba</body></html>',
    origin: ORIGIN, proxyKey: KEY, satDocRetryWaitMs: 5,
    efirmaDir: mkdtempSync(join(tmpdir(), 'pacosat-200d-efirma-')),
    makeConnector: () => ({ parser: FixtureParser, connector: {
      request: async () => 'req-d', check: async () => ({ status: 'pending', packages: [] }),
      download: async () => { throw new Error('sin paquetes'); } } }),
    makeMailer: () => ({ verify: async () => true,
      sendMail: async mail => { mails.push(mail); return { messageId: 'm' + mails.length }; } }),
    now: () => time, ...extra });
  const raw = async (method, path, body, extraHeaders = {}) => {
    const chunks = []; if (body !== undefined) chunks.push(Buffer.from(JSON.stringify(body)));
    const req = Readable.from(chunks);
    req.method = method; req.url = path;
    req.headers = { host: 'pacosat.test', origin: ORIGIN, 'x-pacosat-proxy': KEY, ...extraHeaders };
    let status = 0; let text = '';
    const res = { writeHead(c) { status = c; }, setHeader() {}, getHeader() { return undefined; },
      end(chunk) { if (chunk) text += Buffer.isBuffer(chunk) ? chunk.toString('latin1') : chunk; } };
    await service.handle(req, res);
    return { status, text };
  };
  const call = async (method, path, body) => {
    if (!token) { const home = await raw('GET', '/'); token = /[0-9a-f]{64}/.exec(home.text)?.[0] || ''; }
    const r = await raw(method, path, body, { 'x-pacosat-token': token });
    let json = null; try { json = JSON.parse(r.text); } catch { /* binario */ }
    return { status: r.status, json, text: r.text };
  };
  const exec = async (method, path, body, execToken) => {
    const r = await raw(method, path, body, execToken ? { 'x-pacosat-executor': execToken } : {});
    let json = null; try { json = JSON.parse(r.text); } catch { /* binario */ }
    return { status: r.status, json, text: r.text };
  };
  return { service, call, raw, exec, mails,
    set time(v) { time = v; }, get time() { return time; } };
}
const unlock = async (h, rfc = OWN) => {
  const open = await h.call('POST', '/api/unlock', { rfc, minutes: 1440, days: 7,
    direction: 'both', password: 'simulated', certificate: 'YQ==', key: 'Yg==' });
  assert.equal(open.status, 200, 'unlock ' + rfc);
};
const seedPeople = async h => {
  const seed = await h.call('POST', '/api/storage', { batch: {
    people: [{ id: OWN, name: 'Mano Fil, S.A.' }] } });
  assert.equal(seed.status, 200, 'semilla de contribuyentes');
};
const tarjeta = (salud, id) => (salud.tarjetas || []).find(t => t.id === id);
const emparejar = async h => {
  const par = await h.call('POST', '/api/executor/pair', { nombre: 'Equipo de Paco' });
  assert.equal(par.status, 200, 'emparejar ejecutor');
  return par.json.token;
};

/* ===== (a) Salud compone las tarjetas con semilla ===== */
{
  const h = makeHarness({ executorMode: 'remote' });
  await seedPeople(h); await unlock(h);
  let salud = (await h.call('GET', '/api/salud')).json;
  const puerta = tarjeta(salud, 'puerta:' + OWN);
  assert.ok(puerta, 'la tarjeta de la puerta de cada RFC existe');
  assert.equal(puerta.estado, 'sin-dato', 'puerta sin probar: sin dato, nunca un veredicto inventado');
  const ejecutor = tarjeta(salud, 'ejecutor');
  assert.equal(ejecutor.estado, 'vigilar', 'sin equipo emparejado: a vigilar');
  assert.match(ejecutor.porque, /emparejado/, 'su porqué nombra la causa');
  assert.ok(tarjeta(salud, 'coherencia'), 'la tarjeta de coherencia existe');
  assert.ok(tarjeta(salud, 'respaldo') && tarjeta(salud, 'disco') && tarjeta(salud, 'version'),
    'respaldo, disco y versión tienen su tarjeta');
  /* Ejecutor emparejado pero apagado: su tarjeta cae a mal con la
     causa, y la puerta —con foto vieja— lo cuenta como foto vieja
     y causa de equipo, no de e.firma. */
  const tokenEjecutor = await emparejar(h);
  const enc = await h.call('POST', '/api/executor/jobs', { rfc: OWN, kind: 'puerta-probar', payload: {} });
  assert.equal(enc.status, 200, 'se encola la prueba de la puerta');
  const claim = await h.exec('POST', '/api/executor/claim', { limit: 5 }, tokenEjecutor);
  const trabajo = claim.json.trabajos.find(t => t.id === enc.json.job.id);
  assert.ok(trabajo, 'el ejecutor reclama la prueba');
  const res = await h.exec('POST', '/api/executor/result', { jobId: trabajo.id, status: 'failed',
    result: { steps: [{ at: 1, paso: 'Acceso al portal', detalle: '' }], operations: ['entrar-con-efirma'],
      accesoFallo: true, error: 'Este perfil no tiene e.firma activa.', errorKind: 'sin-efirma' } }, tokenEjecutor);
  assert.equal(res.status, 200, 'el resultado de la prueba se acepta');
  h.time += 2 * 86400000; /* dos días: la foto envejece y el equipo calla */
  salud = (await h.call('GET', '/api/salud')).json;
  const ejecutor2 = tarjeta(salud, 'ejecutor');
  assert.equal(ejecutor2.estado, 'mal', 'ejecutor apagado más de un día: mal');
  assert.match(ejecutor2.porque, /no responde/, 'la causa del ejecutor va en su tarjeta');
  const puerta2 = tarjeta(salud, 'puerta:' + OWN);
  assert.equal(puerta2.datos.tipo, 'equipo', 'la causa viva de la puerta es el equipo, no la e.firma');
  assert.match(puerta2.porque, /foto vieja/, 'la puerta vieja se presenta como foto vieja');
  assert.ok(!/gesto es revisar su e\.firma/.test(puerta2.porque), 'con causa de equipo, nadie manda a la e.firma');
  h.service.close();
  console.log('OK 2.0·T4 · (a) Salud compone: ejecutor apagado en mal con su causa; puerta vieja como foto vieja.');
}

/* ===== (b) Re-probar la puerta: apagado no encola; vivo, una vez ===== */
{
  const h = makeHarness({ executorMode: 'remote' });
  await seedPeople(h); await unlock(h);
  const cola = async () => (await h.call('GET', '/api/executor/overview')).json.trabajos
    .filter(t => t.kind === 'puerta-probar');
  let r = await h.call('POST', '/api/salud/puerta', { rfc: OWN });
  assert.equal(r.json.encolado, false, 'sin equipo emparejado: no se encola');
  assert.match(r.json.motivo, /emparejado/, 'y lo dice');
  assert.equal((await cola()).length, 0, 'la cola sigue vacía');
  const tokenEjecutor = await emparejar(h);
  r = await h.call('POST', '/api/salud/puerta', { rfc: OWN });
  assert.equal(r.json.encolado, false, 'equipo emparejado pero apagado: tampoco se encola en falso');
  assert.match(r.json.motivo, /no responde/, 'y lo dice');
  assert.equal((await cola()).length, 0, 'la cola sigue vacía');
  const latido = await h.exec('POST', '/api/executor/heartbeat', {}, tokenEjecutor);
  assert.equal(latido.status, 200, 'el latido enciende al ejecutor');
  r = await h.call('POST', '/api/salud/puerta', { rfc: OWN });
  assert.equal(r.json.encolado, true, 'con el equipo vivo, la prueba se encola');
  assert.equal(r.json.repetido, false, 'la primera vez no es repetida');
  r = await h.call('POST', '/api/salud/puerta', { rfc: OWN });
  assert.equal(r.json.encolado, true, 'la segunda petición también responde encolado');
  assert.equal(r.json.repetido, true, 'pero consta repetida: no se duplica');
  assert.equal((await cola()).length, 1, 'en la cola hay UNA sola prueba de la puerta');
  h.service.close();
  console.log('OK 2.0·T4 · (b) Re-probar la puerta: apagado no encola y lo dice; vivo encola una sola vez.');
}

/* ===== (c) Coherencia: el desacuerdo tipo job 57 se detecta ===== */
{
  const dir = mkdtempSync(join(tmpdir(), 'pacosat-200d-watch-'));
  const h = makeHarness({ watchDir: dir, inboxParser: FixtureParser, watchSettleMs: 0 });
  try {
    await seedPeople(h); await unlock(h);
    writeFileSync(join(dir, 'uno.xml'), xmlCfdi({ uuid: UUID1, fecha: '2026-11-10T10:00:00', folio: '1' }));
    await h.service.inboxTick(h.time);
    let cruce = await h.call('POST', '/api/salud/coherencia', {});
    assert.equal(cruce.status, 200, 'el cruce a demanda responde');
    assert.equal(cruce.json.desacuerdos.length, 0, 'con el alta real detrás, el cruce no encuentra nada');
    let salud = (await h.call('GET', '/api/salud')).json;
    const tarjetaOk = tarjeta(salud, 'coherencia');
    assert.equal(tarjetaOk.estado, 'bien', 'sin desacuerdo: la tarjeta está en bien');
    assert.match(tarjetaOk.porque, /Todo cuadra/, 'y lo dice: «Todo cuadra»');
    /* B-1 (2.3.2): el borrado en duro de un CFDI YA NO EXISTE —
       data/delete lo rechaza y el alta sigue en el expediente,
       así que el desacuerdo del job 57 ya no se puede sembrar
       borrando: el cruce sigue en «Todo cuadra» porque el alta
       real sigue detrás de su aviso. (La detección de
       «novedad-sin-alta» con semilla directa en la base la fija
       ronda232servidor, bloque B-1/c.) */
    const borrado = await h.call('POST', '/api/data/delete', { store: 'invoices', ids: [UUID1] });
    assert.equal(borrado.status, 400, 'B-1: borrar un CFDI se rechaza');
    assert.match(borrado.json?.error || borrado.text || '', /no se borra|archívalo/i,
      'y el rechazo dice el camino bueno: archivar');
    const siguen = await h.call('GET', '/api/storage?store=invoices');
    assert.ok((siguen.json || []).some(row => row.id === UUID1),
      'el CFDI sigue en el expediente tras el intento de borrado');
    cruce = await h.call('POST', '/api/salud/coherencia', {});
    assert.equal(cruce.json.desacuerdos.length, 0,
      'sin borrado posible, no nace ningún desacuerdo: el alta sigue detrás de su aviso');
    salud = (await h.call('GET', '/api/salud')).json;
    const tarjetaSigue = tarjeta(salud, 'coherencia');
    assert.equal(tarjetaSigue.estado, 'bien', 'la tarjeta sigue en bien');
  } finally { rmSync(dir, { recursive: true, force: true }); h.service.close(); }
  console.log('OK 2.0·T4 · (c) Coherencia: sin desacuerdo, «Todo cuadra»; y B-1: el CFDI no se puede borrar para sembrarlo.');
}

/* ===== (d) Ensayo de restauración con conteos cruzados ===== */
{
  const backupDir = mkdtempSync(join(tmpdir(), 'pacosat-200d-backup-'));
  const h = makeHarness({});
  try {
    await seedPeople(h);
    const seed = await h.call('POST', '/api/storage', { batch: { invoices: [
      { id: UUID1, date: '2026-11-10', kind: 'I', currency: 'MXN', total: '116.00',
        from: { rfc: EMISOR, name: 'Emisor' }, to: { rfc: OWN, name: 'Mano Fil, S.A.' } }] } });
    assert.equal(seed.status, 200, 'semilla de un CFDI');
    await h.service.bootstrap({ backup: { password: 'respaldo-prueba-16', frequency: 'daily', dir: backupDir },
      profiles: [] });
    await h.service.backupTick(h.time);
    const salud = (await h.call('GET', '/api/salud')).json;
    const respaldo = tarjeta(salud, 'respaldo');
    assert.ok(respaldo.datos.ensayo, 'tras el respaldo programado consta su ensayo de restauración');
    assert.equal(respaldo.datos.ensayo.ok, true, 'el ensayo pasó: el respaldo restaura bien');
    assert.equal(respaldo.datos.ensayo.conteos.tiendas.invoices, 1, 'conteos cruzados: 1 CFDI resucitado');
    assert.equal(respaldo.datos.ensayo.conteos.tiendas.people, 1, 'conteos cruzados: 1 persona resucitada');
    assert.ok('perfiles' in respaldo.datos.ensayo.conteos && 'trabajos' in respaldo.datos.ensayo.conteos,
      'el ensayo cruza también perfiles y trabajos del estado operativo');
    assert.match(respaldo.porque, /restaura bien/, 'Salud lo cuenta: «restaura bien»');
  } finally { rmSync(backupDir, { recursive: true, force: true }); h.service.close(); }
  console.log('OK 2.0·T4 · (d) Ensayo de restauración registrado con sus conteos cruzados.');
}

/* ===== (e) Prueba de humo: una entrada por versión nueva ===== */
{
  const dirDb = mkdtempSync(join(tmpdir(), 'pacosat-200d-humo-'));
  const dbFile = join(dirDb, 'pacosat.sqlite');
  const efirmaDir = join(dirDb, 'efirma');
  const base = version => ({ dbFile, efirmaDir, appVersion: version,
    html: '<html><head><!--PACOSAT_TOKEN--></head><body>prueba</body></html>',
    origin: ORIGIN, proxyKey: KEY, satDocRetryWaitMs: 5,
    makeConnector: () => ({ parser: FixtureParser, connector: {
      request: async () => 'req-e', check: async () => ({ status: 'pending', packages: [] }),
      download: async () => { throw new Error('sin paquetes'); } } }),
    makeMailer: () => ({ verify: async () => true, sendMail: async () => ({ messageId: 'me' }) }),
    now: () => Date.parse('2026-11-15T15:00:00Z') });
  const callOn = async (service, method, path, body) => {
    let token = '';
    const raw = async (m, p, b, headers = {}) => {
      const chunks = []; if (b !== undefined) chunks.push(Buffer.from(JSON.stringify(b)));
      const req = Readable.from(chunks);
      req.method = m; req.url = p;
      req.headers = { host: 'pacosat.test', origin: ORIGIN, 'x-pacosat-proxy': KEY, ...headers };
      let status = 0; let text = '';
      const res = { writeHead(c) { status = c; }, setHeader() {}, getHeader() { return undefined; },
        end(chunk) { if (chunk) text += Buffer.isBuffer(chunk) ? chunk.toString('latin1') : chunk; } };
      await service.handle(req, res);
      return { status, text };
    };
    const home = await raw('GET', '/');
    token = /[0-9a-f]{64}/.exec(home.text)?.[0] || '';
    const r = await raw(method, path, body, { 'x-pacosat-token': token });
    let json = null; try { json = JSON.parse(r.text); } catch { /* */ }
    return { status: r.status, json };
  };
  const arranques = async service => {
    const registro = await callOn(service, 'GET', '/api/registro?limit=300');
    return (registro.json.items || []).filter(item => /arrancó:/.test(item.texto || ''));
  };
  try {
    let service = createPacoSATService(base('2.0.0-humoA'));
    await callOn(service, 'GET', '/api/status');
    let entradas = await arranques(service);
    assert.equal(entradas.length, 1, 'la versión nueva deja UNA entrada de humo');
    assert.match(entradas[0].texto, /PacoSAT 2\.0\.0-humoA arrancó: puerta /, 'la entrada nombra la versión y la puerta');
    assert.match(entradas[0].texto, /correo /, 'y el correo');
    assert.match(entradas[0].texto, /ejecutor /, 'y el ejecutor');
    service.close();
    service = createPacoSATService(base('2.0.0-humoA'));
    await callOn(service, 'GET', '/api/status');
    entradas = await arranques(service);
    assert.equal(entradas.length, 1, 'con la misma versión no nace otra entrada');
    service.close();
    service = createPacoSATService(base('2.0.0-humoB'));
    await callOn(service, 'GET', '/api/status');
    entradas = await arranques(service);
    assert.equal(entradas.length, 2, 'otra versión nueva, otra entrada');
    assert.ok(entradas.some(item => /2\.0\.0-humoB arrancó/.test(item.texto)), 'la segunda nombra su versión');
    service.close();
  } finally { rmSync(dirDb, { recursive: true, force: true }); }
  console.log('OK 2.0·T4 · (e) Humo tras el montaje: una entrada por versión nueva, ninguna de más.');
}

/* ===== (f) Configuración guiada: hecho solo con comprobación real ===== */
{
  /* La e.firma «guardada» se siembra como en la instalación real:
     su par y su índice en el almacén, que el bootstrap activa. */
  const efirmaDir = mkdtempSync(join(tmpdir(), 'pacosat-200d-config-'));
  writeFileSync(join(efirmaDir, OWN + '.cer'), Buffer.from('certificado-de-juguete'));
  writeFileSync(join(efirmaDir, OWN + '.key'), Buffer.from('llave-de-juguete'));
  writeFileSync(join(efirmaDir, 'perfiles.json'), JSON.stringify({
    [OWN]: { password: 'simulated', minutes: 1440, days: 7, direction: 'both' } }));
  const h = makeHarness({ executorMode: 'remote', efirmaDir });
  try {
    await seedPeople(h);
    const paso = (salud, id) => (salud.config || []).find(p => p.id === id);
    let salud = (await h.call('GET', '/api/salud')).json;
    assert.equal(paso(salud, 'correo').hecho, false, 'correo sin configurar: pendiente');
    assert.equal(paso(salud, 'ejecutor').hecho, false, 'sin equipo emparejado: pendiente');
    assert.equal(paso(salud, 'efirma').hecho, false, 'sin e.firma todavía: pendiente');
    const mail = await h.call('POST', '/api/mail', { host: 'smtp.test', port: 465, security: 'ssl',
      from: 'avisos@pacosat.test', recipient: 'paco@test.mx', user: 'u', password: 'p' });
    assert.equal(mail.status, 200, 'el correo se configura');
    await h.service.bootstrap({ profiles: [] });
    await emparejar(h);
    salud = (await h.call('GET', '/api/salud')).json;
    assert.equal(paso(salud, 'correo').hecho, true, 'correo configurado de verdad: hecho');
    assert.equal(paso(salud, 'efirma').hecho, true, 'e.firma guardada de verdad: hecho');
    assert.equal(paso(salud, 'ejecutor').hecho, true, 'equipo emparejado de verdad: hecho');
    assert.equal(paso(salud, 'respaldos').hecho, false,
      'respaldos sin configurar en el servidor: pendiente, sin casillas a mano');
  } finally { rmSync(efirmaDir, { recursive: true, force: true }); h.service.close(); }
  console.log('OK 2.0·T4 · (f) Configuración guiada: hecho solo cuando la comprobación real lo confirma.');
}
console.log('ronda200d.test: ok — Centro de salud, reparación, coherencia, ensayo, humo y configuración guiada.');
