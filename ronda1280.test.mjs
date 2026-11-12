/* Ronda 1.28.0 — «Paquete de mejoras» (auditoría viva del
   12 nov 2026, propuestas P1–P10 aprobadas por Paco) más el
   addendum del diagnóstico en vivo del mismo día. Se juzga:
   - ADD-1 · la página del fallo PERSISTE de verdad en los
     cuatro motores: corrida provocada a fallar en el portal
     semilla ⇒ el diario deja captura y HTML que su ruta sirve
     y se leen; si el guardado no puede, el diario lo DICE en
     un paso y no queda ninguna referencia colgada;
   - ADD-2 · diario auto-diagnóstico: el paso de fallo incluye
     el inventario de enlaces que la página enseñaba;
   - ADD-3 · todo fallo de motor levanta su aviso (trib-fail /
     decl-fail / satdoc-fail) con su RFC y su motivo, y su
     línea en el Registro;
   - P1 · Registro unificado: proyección con un fallo real y
     su evidencia abrible, filtros por RFC y clase, resumen
     de 24 h, CSV, acciones del administrador registradas y la
     puerta del invitado cerrada; la poda conserva los fallos
     de los últimos 90 días con su página;
   - P2 · Declaraciones es destino del menú y Documentos ya
     no repite la sección; el Registro viaja diferido;
   - P3 · la cadencia semanal del Buzón Tributario dispara
     SIN botón (origen «sistema»), respeta la cadencia, el
     descanso y la pausa del perfil, y el parte dice la fecha
     de la próxima consulta automática;
   - P4/P5 · Hoy veraz y sin duplicados (estático sobre el
     fragmento: el protagonista nace del conteo del servidor
     y la tabla de un solo contribuyente sale de Hoy);
   - P6 · folios en el detalle de cada mes (estático);
   - P7 · Documentos filtra por RFC (estático);
   - P8 · CAPACIDADES dice la verdad (e.firma viva, versión
     y 13 destinos) y las dos copias coinciden;
   - P9 · los distintivos cuentan el RFC elegido (estático);
   - P10 · Bancos: la posición trae el mes de cada saldo. */
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtempSync, rmSync, readFileSync, statSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DOMParser } from '@xmldom/xmldom';
import { createPacoSATService } from './local-server.mjs';
import { SatDocError } from './sat-doc-fetch.mjs';

const ORIGIN = 'https://pacosat.test';
const KEY = 'f'.repeat(64);
const OWN = 'AAA010101AAA';
const BBB = 'BBB010101BB1';
const DAY = 86400000;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const ROOT = import.meta.dirname;
const read = name => readFileSync(join(ROOT, name), 'utf8');

function makeHarness(options = {}) {
  const clock = { t: Date.parse('2026-11-12T14:00:00Z') };
  const mails = [];
  const service = createPacoSATService({
    dbFile: ':memory:', html: '<html><head><!--PACOSAT_TOKEN--></head><body>prueba</body></html>',
    origin: ORIGIN, proxyKey: KEY, satDocRetryWaitMs: 5,
    makeConnector: () => ({ parser: DOMParser, connector: {
      request: async () => 'req-b', check: async () => ({ status: 'pending', packages: [] }),
      download: async () => { throw new Error('sin paquetes'); } } }),
    makeMailer: () => ({ verify: async () => true,
      sendMail: async mail => { mails.push(mail); return { messageId: 'm' + mails.length }; } }),
    now: () => clock.t, ...options });
  let token = '';
  const raw = async (method, path, body, extraHeaders = {}) => {
    const chunks = []; if (body !== undefined) chunks.push(Buffer.from(JSON.stringify(body)));
    const req = Readable.from(chunks);
    req.method = method; req.url = path;
    req.headers = { host: 'pacosat.test', origin: ORIGIN, 'x-pacosat-proxy': KEY, ...extraHeaders };
    let status = 0; const headers = {}; let text = '';
    const res = { writeHead(code, hdrs) { status = code; if (hdrs) Object.assign(headers, hdrs); },
      setHeader(k, v) { headers[k] = v; }, getHeader(k) { return headers[k]; },
      end(chunk) { if (chunk) text += Buffer.isBuffer(chunk) ? chunk.toString('latin1') : chunk; } };
    await service.handle(req, res);
    return { status, text, headers };
  };
  const call = async (method, path, body, extraHeaders = {}) => {
    if (!token) { const home = await raw('GET', '/'); token = /[0-9a-f]{64}/.exec(home.text)?.[0] || ''; }
    const r = await raw(method, path, body, { 'x-pacosat-token': token, ...extraHeaders });
    let json = null; try { json = JSON.parse(r.text); } catch { /* binario */ }
    return { status: r.status, json, text: r.text, headers: r.headers };
  };
  return { service, call, raw, mails, clock };
}
const unlock = async (h, rfc) => {
  const open = await h.call('POST', '/api/unlock', { rfc, minutes: 1440, days: 7,
    direction: 'both', password: 'simulated', certificate: 'YQ==', key: 'Yg==' });
  assert.equal(open.status, 200);
};
/* El fallo de navegación de producción (12 nov): acceso OK y
   muerte buscando la bandeja/el trámite, con la página que el
   portal enseñaba — enlaces incluidos para el inventario. */
const diagHtml = marcador => '<html><body><nav>' +
  '<a href="/buzon">Bandeja de entrada</a><a href="/decl">Consulta de declaraciones</a>' +
  '<a href="/salir">Salir</a></nav><main>' + marcador + '</main></body></html>';
const falloNavegacion = marcador => async () => {
  const e = new SatDocError('respuesta-inesperada', 'Busco la bandeja — no encontrada (portal)');
  e.diag = { screenshot: PNG, html: diagHtml(marcador), url: 'https://wwwmat.sat.gob.mx/inicio' };
  throw e;
};

/* ===== ADD-1/ADD-2 · Buzón Tributario: página persistida,
   inventario en el diario y aviso con su RFC ===== */
{
  const dir = mkdtempSync(join(tmpdir(), 'pacosat-1280-trib-'));
  const dbFile = join(dir, 'pacosat.sqlite');
  const h = makeHarness({ dbFile, satTribFetch: falloNavegacion('portal-trib-1280') });
  await unlock(h, OWN);
  const run = await h.call('POST', '/api/tributario/run', { rfc: OWN });
  assert.equal(run.json.result.ok, false, 'la corrida muere como la viva del 12 nov');
  const view = await h.call('GET', '/api/tributario?rfc=' + OWN);
  const ultima = view.json.runs[0];
  assert.ok(ultima, 'la corrida consta en el diario');
  assert.equal(ultima.hasShot, true, 'el diario guarda la CAPTURA');
  assert.equal(ultima.hasHtml, true, 'y la PÁGINA');
  assert.equal(ultima.origen, 'paco', 'la corrida manual consta lanzada por Paco');
  const pagina = await h.call('GET', '/api/tributario/artifact?run=' + ultima.id + '&part=html');
  assert.equal(pagina.status, 200);
  assert.ok(pagina.text.includes('portal-trib-1280'), 'la evidencia servida ES la página del fallo: la referencia resuelve');
  const pasos = ultima.steps.map(s => s.paso + ' ' + (s.detalle || '')).join('\n');
  assert.ok(pasos.includes('La página del momento enseñaba:'), 'ADD-2: el diario trae el inventario de la página');
  assert.ok(pasos.includes('Bandeja de entrada'), 'el inventario nombra los enlaces que el portal sí enseñaba');
  assert.ok(pasos.includes('Página del fallo guardada'), 'el diario confirma el guardado verificado');
  /* ADD-3: el fallo levanta su aviso — alerta con RFC y, tras el
     tick, aviso espejo en el Centro. */
  await h.service.tick();
  const db = new DatabaseSync(dbFile);
  const alerta = db.prepare("SELECT rfc, subject FROM alerts WHERE kind='trib-fail'").get();
  assert.ok(alerta, 'ADD-3: la alerta trib-fail existe (la corrida viva del 12 nov quedó muda)');
  assert.equal(alerta.rfc, OWN, 'la alerta lleva su RFC como dato');
  assert.ok(alerta.subject.includes(OWN), 'y el asunto lo nombra');
  const aviso = db.prepare("SELECT rfc FROM avisos WHERE datos LIKE '%\"alertaKind\":\"trib-fail\"%'").get();
  assert.ok(aviso && aviso.rfc === OWN, 'el aviso espejo trib-fail consta con su RFC');
  db.close();
  await h.service.close();
  rmSync(dir, { recursive: true, force: true });
  console.log('OK 1.28.0 · ADD-1/2/3 — buzón: página del fallo persistida y servida, inventario en el diario, aviso trib-fail con su RFC.');
}

/* ===== ADD-1 · Declaraciones y documentos: la misma prueba ===== */
{
  const h = makeHarness({ satDeclFetch: falloNavegacion('portal-decl-1280'),
    satDocFetch: falloNavegacion('portal-doc-1280') });
  await unlock(h, OWN);
  const run = await h.call('POST', '/api/declaraciones/run', { rfc: OWN, tipo: 'mensual', ejercicio: 2026 });
  assert.equal(run.json.result.ok, false);
  const runs = await h.call('GET', '/api/declaraciones/runs?rfc=' + OWN);
  const ultima = runs.json.runs[0];
  assert.equal(ultima.hasShot, true); assert.equal(ultima.hasHtml, true);
  assert.equal(ultima.origen, 'paco');
  const pagina = await h.call('GET', '/api/declaraciones/artifact?run=' + ultima.id + '&part=html');
  assert.equal(pagina.status, 200);
  assert.ok(pagina.text.includes('portal-decl-1280'), 'declaraciones: la página del fallo se abre y se lee');
  assert.ok(ultima.steps.some(s => (s.paso || '').includes('La página del momento enseñaba:')),
    'declaraciones: el inventario también viaja en su diario');
  const doc = await h.call('POST', '/api/satdocs/run', { rfc: OWN, kind: 'constancia' });
  assert.equal(doc.json.results.constancia.ok, false);
  const docs = await h.call('GET', '/api/satdocs');
  const perfil = docs.json.profiles.find(p => p.rfc === OWN);
  const docRun = perfil.runs[0];
  assert.ok(docRun, 'la corrida de documentos consta en su diario');
  assert.equal(docRun.hasShot, true); assert.equal(docRun.hasHtml, true);
  const docPagina = await h.call('GET', '/api/satdocs/artifact?run=' + docRun.id + '&part=html');
  assert.equal(docPagina.status, 200);
  assert.ok(docPagina.text.includes('portal-doc-1280'), 'documentos: la página del fallo se abre y se lee');
  await h.service.close();
  console.log('OK 1.28.0 · ADD-1 — declaraciones y documentos: la página del fallo persiste y se sirve por su ruta.');
}

/* ===== ADD-1 · CIEC: la página del fallo también persiste ===== */
{
  /* Base en fichero temporal: guardar la CIEC escribe el índice
     de credenciales junto a la base, y esta suite no toca el
     directorio de credenciales compartido del árbol. */
  const dir = mkdtempSync(join(tmpdir(), 'pacosat-1280-ciec-'));
  const h = makeHarness({ dbFile: join(dir, 'pacosat.sqlite'), satCiecFetch: falloNavegacion('portal-ciec-1280') });
  /* Alta CIEC por la vía de la app: contribuyente + contraseña
     CIEC (el método del RFC queda en «ciec»). */
  await h.call('POST', '/api/storage', { batch: { people: [{ id: OWN, name: 'Contribuyente CIEC' }] } });
  const alta = await h.call('POST', '/api/ciec', { rfc: OWN, ciec: 'clave-ciec', minutes: 360, days: 7, direction: 'both' });
  assert.equal(alta.status, 200, JSON.stringify(alta.json));
  const ciec = await h.call('POST', '/api/ciec/run', { rfc: OWN, start: '2026-10-01', end: '2026-10-31', direction: 'recibidos' });
  assert.equal(ciec.status, 200, JSON.stringify(ciec.json));
  /* La corrida CIEC va por su cuenta en el servidor: se espera
     a que su diario aparezca, sin inventar tiempos. */
  let perfil = null;
  for (let i = 0; i < 40 && !perfil?.runs?.length; i++) {
    const view = await h.call('GET', '/api/ciec');
    perfil = view.json.profiles.find(p => p.rfc === OWN);
    if (!perfil?.runs?.length) await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(perfil?.runs?.length, 'la corrida CIEC consta en su diario');
  assert.equal(perfil.runs[0].hasHtml, true, 'CIEC guarda la página del fallo');
  assert.equal(perfil.runs[0].origen, 'paco', 'la corrida CIEC manual consta lanzada por Paco');
  const pagina = await h.call('GET', '/api/ciec/artifact?run=' + perfil.runs[0].id + '&part=html');
  assert.equal(pagina.status, 200);
  assert.ok(pagina.text.includes('portal-ciec-1280'), 'CIEC: la página del fallo se abre y se lee');
  await h.service.close();
  rmSync(dir, { recursive: true, force: true });
  console.log('OK 1.28.0 · ADD-1 — CIEC: la página del fallo persiste y se sirve por su ruta.');
}

/* ===== ADD-1b · Si el guardado no puede, el diario lo dice ===== */
{
  const roto = async () => {
    const e = new SatDocError('respuesta-inesperada', 'Busco la bandeja — no encontrada (portal)');
    /* Una página que ni siquiera se deja leer como texto: el
       guardado de esa parte DEBE fallar y quedar dicho; la
       captura buena, en cambio, se guarda. */
    e.diag = { screenshot: PNG, url: 'https://wwwmat.sat.gob.mx/inicio',
      html: { toString() { throw new Error('html ilegible de juguete'); } } };
    throw e;
  };
  const h = makeHarness({ satDocFetch: roto });
  await unlock(h, OWN);
  const doc = await h.call('POST', '/api/satdocs/run', { rfc: OWN, kind: 'opinion' });
  assert.equal(doc.json.results.opinion.ok, false);
  const docs = await h.call('GET', '/api/satdocs');
  const run = docs.json.profiles.find(p => p.rfc === OWN).runs[0];
  assert.equal(run.hasHtml, false, 'sin página guardada, el diario NO inventa su identificador');
  assert.equal(run.hasShot, true, 'la parte que sí se pudo guardar, queda');
  assert.ok(run.steps.some(s => (s.text || s.paso || '').includes('no se pudo guardar')),
    'el diario DICE que la página no se pudo guardar: ninguna referencia colgada en silencio');
  await h.service.close();
  console.log('OK 1.28.0 · ADD-1b — guardado imposible: el diario lo dice en un paso y no cuelga referencias.');
}

/* ===== ADD-3 · Declaraciones y documentos también avisan ===== */
{
  const dir = mkdtempSync(join(tmpdir(), 'pacosat-1280-avisos-'));
  const dbFile = join(dir, 'pacosat.sqlite');
  const h = makeHarness({ dbFile, satDeclFetch: falloNavegacion('portal-decl-aviso'),
    satDocFetch: falloNavegacion('portal-doc-aviso'),
    satTribFetch: async () => ({ notifications: [] }) });
  await unlock(h, OWN);
  await h.call('POST', '/api/declaraciones/run', { rfc: OWN, tipo: 'mensual', ejercicio: 2026 });
  await h.call('POST', '/api/satdocs/run', { rfc: OWN, kind: 'constancia' });
  await h.service.tick();
  const db = new DatabaseSync(dbFile);
  for (const kind of ['decl-fail', 'satdoc-fail']) {
    const alerta = db.prepare('SELECT rfc FROM alerts WHERE kind=?').get(kind);
    assert.ok(alerta, 'la alerta ' + kind + ' existe');
    assert.equal(alerta.rfc, OWN, 'la alerta ' + kind + ' lleva su RFC');
    const aviso = db.prepare("SELECT rfc FROM avisos WHERE datos LIKE ?").get('%"alertaKind":"' + kind + '"%');
    assert.ok(aviso && aviso.rfc === OWN, 'el aviso espejo ' + kind + ' consta con su RFC');
  }
  db.close();
  await h.service.close();
  rmSync(dir, { recursive: true, force: true });
  console.log('OK 1.28.0 · ADD-3 — decl-fail y satdoc-fail: alerta y aviso con su RFC y su motivo.');
}

/* ===== P1 · Registro unificado: proyección, filtros, CSV ===== */
{
  const h = makeHarness({ satTribFetch: falloNavegacion('portal-reg-1280'),
    satDocFetch: async () => ({ content: Buffer.from('%PDF-1.4 constancia'), issuedAt: '2026-11-12T14:00:00Z', fileName: 'constancia.pdf' }) });
  await unlock(h, OWN);
  /* Una conexión buena (documentos) y un fallo real (buzón). */
  const doc = await h.call('POST', '/api/satdocs/run', { rfc: OWN, kind: 'constancia' });
  assert.equal(doc.json.results.constancia.ok, true);
  await h.call('POST', '/api/tributario/run', { rfc: OWN });
  /* Una acción del administrador: anotar un folio a mano. */
  const folio = await h.call('POST', '/api/declaraciones/folios',
    { rfc: OWN, folio: '123456789012', tipo: 'mensual', ejercicio: 2026, periodo: '2026-09' });
  assert.equal(folio.status, 200, JSON.stringify(folio.json));
  const registro = await h.call('GET', '/api/registro');
  assert.equal(registro.status, 200);
  const fallo = registro.json.items.find(item => item.clase === 'fallo' && item.rfc === OWN);
  assert.ok(fallo, 'P1: el Registro proyecta el fallo real del buzón');
  assert.ok(fallo.texto.includes('Buzón Tributario'), 'el fallo se cuenta en lenguaje llano');
  assert.equal(fallo.origen, 'paco', 'y con su origen: lo lanzó Paco');
  assert.ok(fallo.evidencia && fallo.evidencia.motor === 'tributario' && fallo.evidencia.hasHtml,
    'el fallo trae su evidencia: la página guardada');
  const pagina = await h.call('GET', '/api/tributario/artifact?run=' + fallo.evidencia.runId + '&part=html');
  assert.equal(pagina.status, 200);
  assert.ok(pagina.text.includes('portal-reg-1280'), 'desde el Registro, la página del fallo se abre y se lee');
  const conexion = registro.json.items.find(item => item.clase === 'conexion' && item.rfc === OWN);
  assert.ok(conexion && conexion.texto.includes('Constancia'), 'P1: la conexión buena también consta');
  const accion = registro.json.items.find(item => item.clase === 'accion' && item.texto.includes('folio'));
  assert.ok(accion, 'P1: la acción del administrador (anotar un folio) quedó registrada');
  /* Filtros: por clase y por RFC. */
  const soloFallos = await h.call('GET', '/api/registro?clase=fallo');
  assert.ok(soloFallos.json.items.length >= 1 && soloFallos.json.items.every(item => item.clase === 'fallo'),
    'el filtro por clase deja solo fallos');
  const deOtro = await h.call('GET', '/api/registro?rfc=' + BBB);
  assert.ok(deOtro.json.items.every(item => item.rfc !== OWN), 'el filtro por RFC no mezcla contribuyentes');
  /* Resumen de 24 h (la línea de Hoy). */
  const resumen = await h.call('GET', '/api/registro/resumen');
  assert.ok(resumen.json.fallos >= 1 && resumen.json.conexiones >= 1,
    'el resumen cuenta fallos y conexiones de las últimas 24 h');
  assert.ok(resumen.json.ultimoFallo && resumen.json.ultimoFallo.rfc === OWN, 'y nombra el último fallo');
  /* CSV con su cabecera en lenguaje llano. */
  const csv = await h.call('GET', '/api/registro/csv');
  assert.equal(csv.status, 200);
  assert.ok(csv.text.includes('Fecha;Clase;RFC;Origen;Texto'), 'el CSV trae su cabecera');
  assert.ok(csv.text.includes('fallo'), 'y la fila del fallo');
  /* La puerta del invitado: el Registro no es lectura suya. */
  await h.call('POST', '/api/guest/config', { password: 'clave-invitado-1', enabled: true, rfcs: [OWN] });
  const login = await h.call('POST', '/api/guest/login', { password: 'clave-invitado-1' });
  const ajeno = await h.call('GET', '/api/registro', undefined, { 'x-pacosat-token': login.json.token });
  assert.ok(ajeno.status >= 400, 'el invitado no entra en el Registro: es la bitácora del administrador');
  await h.service.close();
  console.log('OK 1.28.0 · P1 — Registro: proyecta el fallo con su página, filtra por RFC y clase, resume 24 h, exporta CSV y cierra la puerta al invitado.');
}

/* ===== P1 · La poda conserva los fallos de 90 días ===== */
{
  const dir = mkdtempSync(join(tmpdir(), 'pacosat-1280-poda-'));
  const dbFile = join(dir, 'pacosat.sqlite');
  const T0 = Date.parse('2026-11-12T14:00:00Z');
  const h = makeHarness({ dbFile, satTribFetch: falloNavegacion('portal-poda-1280') });
  await unlock(h, OWN);
  const run = await h.call('POST', '/api/tributario/run', { rfc: OWN });
  assert.equal(run.json.result.ok, false);
  const falloId = run.json.view.runs[0].id;
  await h.service.close();
  /* Se siembran 25 corridas buenas MÁS NUEVAS que el fallo y un
     fallo viejo (100 días) con su página: al cerrar la siguiente
     corrida, la poda debe quedarse con el fallo reciente y su
     página, y llevarse el viejo entero. */
  const db = new DatabaseSync(dbFile);
  const ins = db.prepare("INSERT INTO trib_runs(id,rfc,started,finished,ok,error,errorKind,steps,attempts,encontradas,sinAbrir,shotId,htmlId,origen) VALUES (?,?,?,? ,?,'','','[]',1,0,0,'','', 'paco')");
  for (let i = 1; i <= 25; i++)
    ins.run('ok-' + i, OWN, T0 + i * 60000, T0 + i * 60000 + 1000, 1);
  db.prepare("INSERT INTO records(store,id,value,data,mime) VALUES ('files','diag:viejo:html',NULL,?,'text/html')")
    .run(Buffer.from('<html>fallo-viejo</html>'));
  db.prepare("INSERT INTO trib_runs(id,rfc,started,finished,ok,error,errorKind,steps,attempts,encontradas,sinAbrir,shotId,htmlId,origen) VALUES ('viejo',?,?,?,?,?,'','[]',1,0,0,'','diag:viejo:html','paco')")
    .run(OWN, T0 - 100 * DAY, T0 - 100 * DAY + 1000, 0, 'fallo antiguo');
  db.close();
  const h2 = makeHarness({ dbFile, satTribFetch: async () => ({ notifications: [] }) });
  h2.clock.t = T0 + 26 * 60000;
  await unlock(h2, OWN);
  const run2 = await h2.call('POST', '/api/tributario/run', { rfc: OWN });
  assert.equal(run2.json.result.ok, true);
  const pagina = await h2.call('GET', '/api/tributario/artifact?run=' + falloId + '&part=html');
  assert.equal(pagina.status, 200);
  assert.ok(pagina.text.includes('portal-poda-1280'), 'la página del fallo retenido sigue abriéndose tras la poda');
  await h2.service.close();
  const db2 = new DatabaseSync(dbFile);
  assert.equal(db2.prepare('SELECT COUNT(*) AS n FROM trib_runs WHERE id=?').get(falloId).n, 1,
    'la poda NO se llevó el fallo reciente aunque hay más de 20 corridas');
  assert.equal(db2.prepare("SELECT COUNT(*) AS n FROM trib_runs WHERE id='viejo'").get().n, 0,
    'el fallo de hace 100 días sí sale en la poda');
  assert.equal(db2.prepare("SELECT COUNT(*) AS n FROM records WHERE store='files' AND id='diag:viejo:html'").get().n, 0,
    'la página del fallo viejo podado también se borra');
  db2.close();
  rmSync(dir, { recursive: true, force: true });
  console.log('OK 1.28.0 · P1/poda — las últimas 20 conviven con todos los fallos de 90 días y su página; el de 100 días sale entero.');
}

/* ===== P3 · Cadencia semanal del Buzón Tributario ===== */
{
  let llamadas = 0;
  const motor = async () => { llamadas++; return { notifications: [] }; };
  /* Base en fichero temporal: la carpeta de e.firma (y su índice
     de métodos de acceso) vive junto a la base; en memoria se
     compartiría con otras suites. */
  const dir = mkdtempSync(join(tmpdir(), 'pacosat-1280-cadencia-'));
  /* La e.firma GUARDADA (como la deja la subida desde la app):
     es la condición de la cadencia automática. */
  mkdirSync(join(dir, 'efirma'), { recursive: true });
  writeFileSync(join(dir, 'efirma', OWN + '.cer'), Buffer.from('cer'));
  writeFileSync(join(dir, 'efirma', OWN + '.key'), Buffer.from('key'));
  const h = makeHarness({ dbFile: join(dir, 'pacosat.sqlite'), satTribFetch: motor });
  await unlock(h, OWN);
  await h.service.tick();
  assert.equal(llamadas, 1, 'P3: el tick consulta el buzón SIN que nadie pulse el botón');
  let view = await h.call('GET', '/api/tributario?rfc=' + OWN);
  assert.equal(view.json.runs[0].origen, 'sistema', 'la corrida automática consta lanzada por el sistema');
  assert.equal(view.json.proximaAuto, view.json.runs[0].started + 7 * DAY,
    'el parte dice la fecha de la próxima consulta automática (última + 7 días)');
  h.clock.t += 3 * DAY;
  await h.service.tick();
  assert.equal(llamadas, 1, 'a los 3 días la cadencia aún no toca: no se repite');
  h.clock.t += 5 * DAY;
  await h.service.tick();
  assert.equal(llamadas, 2, 'a los 8 días la cadencia dispara la segunda consulta sola');
  /* La pausa del perfil también detiene la cadencia. */
  await h.call('POST', '/api/pause', { rfc: OWN, paused: true });
  h.clock.t += 8 * DAY;
  await h.service.tick();
  assert.equal(llamadas, 2, 'con el perfil en pausa, la cadencia espera');
  await h.service.close();
  rmSync(dir, { recursive: true, force: true });
  console.log('OK 1.28.0 · P3 — cadencia semanal: dispara sin botón, no se repite antes de tiempo y espera con el perfil en pausa.');
}
{
  /* Descansar detiene la cadencia entera. */
  let llamadas = 0;
  const dir = mkdtempSync(join(tmpdir(), 'pacosat-1280-descanso-'));
  mkdirSync(join(dir, 'efirma'), { recursive: true });
  writeFileSync(join(dir, 'efirma', OWN + '.cer'), Buffer.from('cer'));
  writeFileSync(join(dir, 'efirma', OWN + '.key'), Buffer.from('key'));
  const h = makeHarness({ dbFile: join(dir, 'pacosat.sqlite'),
    satTribFetch: async () => { llamadas++; return { notifications: [] }; } });
  await unlock(h, OWN);
  await h.call('POST', '/api/rest', { until: h.clock.t + 10 * DAY });
  await h.service.tick();
  assert.equal(llamadas, 0, 'en Descansar, la cadencia no consulta nada');
  await h.call('POST', '/api/rest', { until: 0 });
  await h.service.tick();
  assert.equal(llamadas, 1, 'al levantar el descanso, la cadencia retoma');
  await h.service.close();
  rmSync(dir, { recursive: true, force: true });
  console.log('OK 1.28.0 · P3 — Descansar detiene la cadencia y levantar el descanso la retoma.');
}

/* ===== P2/P4/P5/P6/P7/P9 · Lo estático de las pantallas ===== */
{
  const html = read('Faro-Fiscal.html');
  const lazy = JSON.parse(read('lazy.json'));
  const ui = read('ui.part'), declaracionesUi = read('declaraciones-ui.part'),
    satdocsUi = read('satdocs-ui.part'), buzonUi = read('buzon-ui.part'),
    tribUi = read('tributario-ui.part'), avisosUi = read('avisos-ui.part');
  /* P2: Declaraciones y Registro son destinos del menú. */
  assert.ok(html.includes('data-view="declaraciones"'), 'P2: el menú tiene Declaraciones');
  assert.ok(html.includes("declaraciones: ['Declaraciones'"), 'P2: la pantalla consta en el mapa');
  assert.ok(html.includes('declaraciones: declaracionesScreen'), 'P2: y se resuelve en el render');
  assert.ok(!ui.includes('parts.push(declaracionesSection())'), 'P2: Documentos ya no repite la sección');
  assert.ok(satdocsUi.includes("navigate('declaraciones')"), 'P2: la tarjeta de Documentos lleva al destino');
  assert.ok(html.includes('data-view="registro"'), 'P1: el menú tiene Registro');
  assert.ok(lazy.partes.registro, 'P1: el Registro consta como parte diferida');
  assert.ok(lazy.partes.registro.source.includes('function registroScreen'), 'P1: su parte trae la pantalla');
  assert.ok(!html.includes('function registroScreen'), 'P1: la pantalla del Registro NO pesa en la primera pintura');
  assert.ok(html.includes(lazy.partes.registro.hash), 'P1: la CSP autoriza la huella de la parte del Registro');
  /* P4: el protagonista de Hoy nace del conteo del servidor. */
  assert.ok(ui.includes('avisos.counts?.total > 0'), 'P4: con avisos abiertos hay protagonista de avisos');
  assert.ok(ui.includes('Revisar tus avisos abiertos'), 'P4: y Hoy no se queda en «Todo en orden»');
  assert.ok(ui.includes("satApiLectura('registro/resumen')"), 'P1: Hoy trae la línea del Registro');
  /* P5: sin duplicados. */
  assert.ok(ui.includes('visiblePeople.length !== 1'), 'P5: con un contribuyente visible, la tabla repetida sale de Hoy');
  assert.ok(ui.includes('reconcile?.confirmed.length'), 'P5: la línea de conciliaciones solo con algo que contar');
  /* P6: folios en el detalle del mes. */
  assert.ok(declaracionesUi.includes('Reimprimir el acuse de este mes'), 'P6: reimprimir vive en el detalle del mes');
  assert.ok(declaracionesUi.includes('f.periodo === seleccion.periodo'), 'P6: el folio se busca por el periodo del mes tocado');
  /* P7: Documentos filtrado por RFC. */
  assert.ok(satdocsUi.includes('filter(profile => profile.rfc === scope)'), 'P7: la sección filtra tarjetas y formularios por el RFC elegido');
  /* P9: distintivos por RFC elegido. */
  assert.ok(buzonUi.includes('buzonUnreadFor(scope)'), 'P9: el distintivo del Buzón cuenta el RFC elegido');
  assert.ok(tribUi.includes('tribSinAbrirFor(scope)'), 'P9: el del Buzón Tributario, también');
  assert.ok(avisosUi.includes('avisosBadgeCount'), 'P9: el de Avisos sale del conteo por RFC del payload');
  /* P3 en pantalla: la fecha de la próxima consulta automática. */
  assert.ok(tribUi.includes('proximaAuto'), 'P3: la pantalla del buzón enseña su próxima consulta automática');
  console.log('OK 1.28.0 · P2/P4/P5/P6/P7/P9 — destinos nuevos, Hoy veraz y sin duplicados, folios en el detalle, filtro por RFC y distintivos por RFC.');
}

/* ===== P10 · Bancos: el mes de cada saldo en la posición ===== */
{
  let textoActual = '';
  const pdf64 = Buffer.from('%PDF-1.7 estado de juguete ' + 'x'.repeat(120)).toString('base64');
  const h = makeHarness({ extractText: async () => textoActual });
  const alta = await h.call('POST', '/api/banks/accounts', { bank: 'BBVA', name: 'Principal', kind: 'cuenta' });
  const bbva = alta.json.accounts[0];
  const alta2 = await h.call('POST', '/api/banks/accounts', { bank: 'Santander', name: 'Secundaria', kind: 'cuenta' });
  const santander = alta2.json.accounts.find(a => a.bank === 'Santander');
  textoActual = ['BBVA MEXICO', 'Saldo inicial $9,000.00', 'Saldo final $10,000.00', 'Total de abonos $1,000.00', 'Total de cargos $0.00'].join('\n');
  await h.call('POST', '/api/banks/statements', { accountId: bbva.id, month: '2026-10', content: pdf64 });
  textoActual = ['BBVA MEXICO', 'Saldo inicial $10,000.00', 'Saldo final $12,500.00', 'Total de abonos $2,500.00', 'Total de cargos $0.00'].join('\n');
  await h.call('POST', '/api/banks/statements', { accountId: bbva.id, month: '2026-11', content: pdf64 });
  textoActual = ['SANTANDER MEXICO', 'Saldo inicial $1.00', 'Saldo final $2.00', 'Total de abonos $1.00', 'Total de cargos $0.00'].join('\n');
  const bancos = await h.call('POST', '/api/banks/statements', { accountId: santander.id, month: '2026-10', content: pdf64 });
  assert.equal(bancos.json.position.total, '12502.00', 'el total suma los últimos saldos');
  const cuentas = bancos.json.position.cuentas || [];
  const deBBVA = cuentas.find(c => c.banco === 'BBVA');
  const deSantander = cuentas.find(c => c.banco === 'Santander');
  assert.ok(deBBVA && deBBVA.mes === '2026-11' && deBBVA.saldo === '12500.00',
    'P10: la posición dice que el saldo de BBVA sale de 2026-11');
  assert.ok(deSantander && deSantander.mes === '2026-10' && deSantander.saldo === '2.00',
    'P10: y que el de Santander sale de 2026-10 — la mezcla de meses ya no es silenciosa');
  await h.service.close();
  console.log('OK 1.28.0 · P10 — Bancos: la posición trae, por cuenta, el mes del que sale cada saldo.');
}

/* ===== P1 · La parte del Registro llega por su ruta real ===== */
{
  /* Composición como la de producción: el arranque pasa el
     lazy.json que genera la construcción; sin él, la pantalla
     del Registro no podría cargar su parte. */
  const lazyParts = JSON.parse(read('lazy.json'));
  const h = makeHarness({ lazyParts });
  const parte = await h.call('GET', '/parte/registro');
  assert.equal(parte.status, 200, 'GET /parte/registro responde 200 con la composición de producción');
  assert.ok(parte.text.includes('registroScreen'), 'la parte servida es la pantalla del Registro');
  await h.service.close();
  console.log('OK 1.28.0 · P1 — la parte perezosa del Registro se sirve por /parte/registro con la composición real.');
}

/* ===== P8 · CAPACIDADES veraz y copias gemelas ===== */
{
  const caps = read('docs/CAPACIDADES.md');
  /* Corrección de test (cadena GitHub 1.28+1.29): el espejo vive
     FUERA del repo (raíz del workspace local); en CI no existe y
     la lectura reventaba la suite entera con ENOENT. La
     comparación de copias corre solo donde el espejo existe; el
     resto de P8 juzga el documento del repo, que es la fuente. */
  const espejoPath = join(ROOT, '..', '..', 'pacosat-capacidades.md');
  if (existsSync(espejoPath)) {
    assert.equal(caps, readFileSync(espejoPath, 'utf8'),
      'P8: las dos copias de CAPACIDADES son idénticas');
  }
  assert.ok(caps.includes('1.28.0'), 'P8: el documento describe la 1.28.0');
  assert.ok(!caps.includes('Su e.firma caducó el 30-oct-2024: el perfil existe'),
    'P8/D1: fuera el texto que daba por muerta la e.firma de la app');
  assert.ok(caps.includes('está VIVA y firmó las bajadas'), 'P8/D1: la e.firma de la app consta viva');
  assert.ok(!caps.includes('VERSIÓN ACTUAL: 1.10.3'), 'P8/D2: el pie ya no dice 1.10.3');
  // 1.29.0: el pineo de «versión actual» se re-apunta en cada ronda.
  assert.ok(caps.includes('VERSIÓN ACTUAL: 1.29.0'), 'P8/D2: el pie dice la versión actual');
  assert.ok(!caps.includes('MENÚ DE 9 DESTINOS'), 'P8/D3: fuera el menú de 9');
  assert.ok(caps.includes('MENÚ DE 13 DESTINOS'), 'P8/D3: el menú dice sus 13 destinos reales');
  assert.ok(caps.includes('SEMANAL'), 'P8/D4: el buzón automático consta con su cadencia semanal real');
  const html = read('Faro-Fiscal.html');
  assert.ok(html.includes('"version":"1.29.0"'), 'el artefacto se sella con la versión vigente (1.29.0)');
  console.log('OK 1.28.0 · P8 — CAPACIDADES veraz: e.firma viva, versión al pie, 13 destinos y cadencia semanal; copias idénticas.');
}

/* ===== Corrección H-1.1 · El CSV del Registro neutraliza
   las celdas que empiezan por =, +, - o @ ===== */
{
  const dir = mkdtempSync(join(tmpdir(), 'pacosat-1280-csv-'));
  const dbFile = join(dir, 'pacosat.sqlite');
  const T0 = Date.parse('2026-11-12T14:00:00Z');
  const h = makeHarness({ dbFile });
  await h.call('GET', '/api/registro');
  await h.service.close();
  /* Líneas de actividad cuyo texto empieza por un signo de
     fórmula: en la exportación deben salir como texto (un
     apóstrofo delante), no como fórmula ejecutable. */
  const db = new DatabaseSync(dbFile);
  const ins = db.prepare("INSERT INTO records(store,id,value) VALUES ('activity',?,?)");
  const peligrosas = ['=2+5+cmd', '+SUMA(A1:A9)', '-2+3', '@2+3'];
  peligrosas.forEach((texto, i) =>
    ins.run('seg-csv-' + i, JSON.stringify({ name: texto, at: T0 - (i + 1) * 1000, ok: true })));
  ins.run('seg-csv-ok', JSON.stringify({ name: 'Importación normal de prueba', at: T0 - 9000, ok: true }));
  db.close();
  const h2 = makeHarness({ dbFile });
  const csv = await h2.call('GET', '/api/registro/csv');
  assert.equal(csv.status, 200);
  for (const texto of peligrosas) {
    assert.ok(csv.text.includes('"' + "'" + texto + '"'),
      'H-1.1: la celda «' + texto + '» sale neutralizada con apóstrofo');
    assert.ok(!csv.text.includes('"' + texto + '"'),
      'H-1.1: la celda «' + texto + '» NO sale como fórmula desnuda');
  }
  assert.ok(csv.text.includes('"Importación normal de prueba"'),
    'H-1.1: una celda normal pasa sin tocar');
  await h2.service.close();
  rmSync(dir, { recursive: true, force: true });
  console.log('OK 1.28.0 · H-1.1 — CSV del Registro: las celdas =, +, - y @ salen neutralizadas con apóstrofo.');
}

/* ===== Corrección H-5.1 · La retención de fallos tiene
   techo: 101 fallos recientes ⇒ quedan los 100 últimos ===== */
{
  const dir = mkdtempSync(join(tmpdir(), 'pacosat-1280-techo-'));
  const dbFile = join(dir, 'pacosat.sqlite');
  const T0 = Date.parse('2026-11-12T14:00:00Z');
  const h = makeHarness({ dbFile });
  await unlock(h, OWN);
  await h.service.close();
  /* 101 fallos dentro de la ventana de 90 días, cada uno con
     su página: la poda debe quedarse con los 100 más recientes
     y llevarse el que excede, con su evidencia. */
  const db = new DatabaseSync(dbFile);
  const insRun = db.prepare("INSERT INTO trib_runs(id,rfc,started,finished,ok,error,errorKind,steps,attempts,encontradas,sinAbrir,shotId,htmlId,origen) VALUES (?,?,?,?,0,'fallo sembrado','','[]',1,0,0,'',?,'sistema')");
  const insFile = db.prepare("INSERT INTO records(store,id,value,data,mime) VALUES ('files',?,NULL,?,'text/html')");
  for (let i = 1; i <= 101; i++) {
    insFile.run('diag:techo-' + i + ':html', Buffer.from('<html>fallo-techo-' + i + '</html>'));
    insRun.run('techo-' + i, OWN, T0 - i * 60000, T0 - i * 60000 + 1000, 'diag:techo-' + i + ':html');
  }
  db.close();
  const h2 = makeHarness({ dbFile, satTribFetch: async () => ({ notifications: [] }) });
  await unlock(h2, OWN);
  const run2 = await h2.call('POST', '/api/tributario/run', { rfc: OWN });
  assert.equal(run2.json.result.ok, true);
  await h2.service.close();
  const db2 = new DatabaseSync(dbFile);
  assert.equal(db2.prepare('SELECT COUNT(*) AS n FROM trib_runs WHERE ok=0').get().n, 100,
    'H-5.1: de 101 fallos dentro de la ventana quedan exactamente 100');
  assert.equal(db2.prepare("SELECT COUNT(*) AS n FROM trib_runs WHERE id='techo-101'").get().n, 0,
    'H-5.1: el fallo que excede el techo sale en la poda');
  assert.equal(db2.prepare("SELECT COUNT(*) AS n FROM records WHERE store='files' AND id='diag:techo-101:html'").get().n, 0,
    'H-5.1: y su página se borra con él');
  assert.equal(db2.prepare("SELECT COUNT(*) AS n FROM records WHERE store='files' AND id LIKE 'diag:techo-%'").get().n, 100,
    'H-5.1: las páginas de los 100 fallos retenidos quedan íntegras');
  db2.close();
  rmSync(dir, { recursive: true, force: true });
  console.log('OK 1.28.0 · H-5.1 — poda con techo: 101 fallos de la ventana quedan en 100, con su evidencia íntegra.');
}

/* ===== Corrección H-5.1 · Una página gigante se guarda
   recortada a 2 MB y el diario lo dice ===== */
{
  const enorme = '<html><body>' + 'x'.repeat(3 * 1024 * 1024) + '<p>FIN-LEJANO</p></body></html>';
  const falloEnorme = async () => {
    const e = new SatDocError('respuesta-inesperada', 'Busco la bandeja — no encontrada (portal)');
    e.diag = { screenshot: PNG, html: enorme, url: 'https://wwwmat.sat.gob.mx/inicio' };
    throw e;
  };
  const h = makeHarness({ satTribFetch: falloEnorme });
  await unlock(h, OWN);
  const run = await h.call('POST', '/api/tributario/run', { rfc: OWN });
  assert.equal(run.json.result.ok, false);
  const view = await h.call('GET', '/api/tributario?rfc=' + OWN);
  const ultima = view.json.runs[0];
  assert.equal(ultima.hasHtml, true, 'H-5.1: la página gigante SÍ queda guardada (recortada, no perdida)');
  const pagina = await h.call('GET', '/api/tributario/artifact?run=' + ultima.id + '&part=html');
  assert.equal(pagina.status, 200);
  assert.ok(pagina.text.length <= 2 * 1024 * 1024 + 128,
    'H-5.1: el artefacto guardado no pasa del tope de 2 MB (queda en ' + pagina.text.length + ')');
  assert.ok(!pagina.text.includes('FIN-LEJANO'), 'H-5.1: el final lejano no está: la página quedó recortada');
  assert.ok(pagina.text.includes('recortada a 2 MB'), 'H-5.1: el propio artefacto lleva la marca del recorte');
  const pasos = ultima.steps.map(s => s.paso + ' ' + (s.detalle || '')).join('\n');
  assert.ok(pasos.includes('recortada a 2 MB'), 'H-5.1: y el diario lo dice en un paso');
  await h.service.close();
  console.log('OK 1.28.0 · H-5.1 — página gigante: guardada recortada a 2 MB, con su marca y su paso en el diario.');
}

/* ===== Corrección H-5.1 · audit_events también se poda:
   180 días y 5.000 filas como techos ===== */
{
  const dir = mkdtempSync(join(tmpdir(), 'pacosat-1280-audit-'));
  const dbFile = join(dir, 'pacosat.sqlite');
  const T0 = Date.parse('2026-11-12T14:00:00Z');
  const h = makeHarness({ dbFile });
  await unlock(h, OWN);
  await h.service.close();
  const db = new DatabaseSync(dbFile);
  const ins = db.prepare('INSERT INTO audit_events(at,clase,rfc,texto,ok) VALUES (?,?,?,?,1)');
  db.exec('BEGIN');
  for (let i = 0; i < 5001; i++) ins.run(T0 - 1000, 'accion', OWN, 'Acción sembrada ' + i);
  ins.run(T0 - 200 * DAY, 'accion', OWN, 'Acción antigua 1');
  ins.run(T0 - 200 * DAY, 'accion', OWN, 'Acción antigua 2');
  db.exec('COMMIT');
  db.close();
  const h2 = makeHarness({ dbFile, satTribFetch: async () => ({ notifications: [] }) });
  await unlock(h2, OWN);
  const run = await h2.call('POST', '/api/tributario/run', { rfc: OWN });
  assert.equal(run.json.result.ok, true, 'la corrida que dispara la poda cierra bien');
  await h2.service.close();
  const db2 = new DatabaseSync(dbFile);
  assert.equal(db2.prepare('SELECT COUNT(*) AS n FROM audit_events').get().n, 5000,
    'H-5.1: audit_events queda en su techo de 5.000 filas');
  assert.equal(db2.prepare('SELECT COUNT(*) AS n FROM audit_events WHERE at < ?').get(T0 - 180 * DAY).n, 0,
    'H-5.1: y ninguna fila pasa de 180 días');
  db2.close();
  rmSync(dir, { recursive: true, force: true });
  console.log('OK 1.28.0 · H-5.1 — audit_events se poda con la poda de diarios: 180 días y 5.000 filas.');
}

/* ===== Corrección H-1.2 · Una línea que nombra a dos
   contribuyentes no se atribuye a ninguno ===== */
{
  const dir = mkdtempSync(join(tmpdir(), 'pacosat-1280-atrib-'));
  const dbFile = join(dir, 'pacosat.sqlite');
  const T0 = Date.parse('2026-11-12T14:00:00Z');
  const h = makeHarness({ dbFile });
  await unlock(h, OWN);
  await unlock(h, BBB);
  await h.service.close();
  /* Una línea de activity y una de access_log que nombran a
     los DOS perfiles, y una de activity que nombra a uno solo. */
  const db = new DatabaseSync(dbFile);
  const insAct = db.prepare("INSERT INTO records(store,id,value) VALUES ('activity',?,?)");
  insAct.run('seg-dos', JSON.stringify({ name: 'Reenvío de ' + OWN + ' para la contadora de ' + BBB, at: T0 - 1000, ok: true }));
  insAct.run('seg-uno', JSON.stringify({ name: 'Descarga manual de ' + OWN + ' hecha', at: T0 - 2000, ok: true }));
  db.prepare('INSERT INTO access_log(at,kind,detail) VALUES (?,?,?)')
    .run(T0 - 3000, 'pause', 'Pausa de ' + OWN + ' y de ' + BBB);
  db.close();
  const h2 = makeHarness({ dbFile });
  const global = await h2.call('GET', '/api/registro?limit=2000');
  const lineaDos = global.json.items.find(item => item.texto.includes('Reenvío de'));
  assert.ok(lineaDos, 'H-1.2: la línea de dos RFC consta en la vista global');
  assert.equal(lineaDos.rfc, '', 'H-1.2: y consta SIN atribuir: su texto nombra a dos contribuyentes');
  const pausaDos = global.json.items.find(item => item.texto.includes('Pausa de'));
  assert.ok(pausaDos && pausaDos.rfc === '', 'H-1.2: la línea de access_log con dos RFC tampoco se atribuye');
  for (const rfc of [OWN, BBB]) {
    const vista = await h2.call('GET', '/api/registro?rfc=' + rfc + '&limit=2000');
    assert.ok(!vista.json.items.some(item => item.texto.includes('Reenvío de')),
      'H-1.2: la línea de dos RFC no aparece en la vista de ' + rfc);
    assert.ok(!vista.json.items.some(item => item.texto.includes('Pausa de')),
      'H-1.2: la de access_log tampoco aparece en la vista de ' + rfc);
  }
  const deOwn = await h2.call('GET', '/api/registro?rfc=' + OWN + '&limit=2000');
  assert.ok(deOwn.json.items.some(item => item.texto.includes('Descarga manual de')),
    'H-1.2: la línea que nombra a un solo contribuyente SÍ se le atribuye');
  await h2.service.close();
  rmSync(dir, { recursive: true, force: true });
  console.log('OK 1.28.0 · H-1.2 — atribución por texto: dos RFC conocidos en una línea ⇒ ninguno; uno solo ⇒ el suyo.');
}

console.log('OK 1.28.0 · suite completa.');
