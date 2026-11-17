/* ================================================================
   Ronda 2.0.1 · Fase 1 (servidor) — las 20 mejoras: lo que esta
   fase construyó en el servidor, probado contra el servicio real:
   (nº 3) el cruce «Ponte al día» de declaraciones dentro de
   /api/declaraciones como campo aditivo «cruce201»;
   (nº 6) la línea de vida con el hito «cancelada» y el documento
   de cada paso (descargado → solicitud, pagada → movimiento);
   (nº 14) /api/duplicados201 de solo lectura;
   (nº 8) el registro común de Deshacer (/api/deshacer201)
   alimentado por archivar y por cerrar/desbloquear ejercicio;
   (nº 16) /api/a-medias201 con los estados que ya existían;
   (nº 7) la autorreparación semanal deja su foto en /api/salud
   como «auto201» tras el tick del lunes;
   (nº 20) el resumen del domingo sale UNA vez por tick dominical
   con sus cuatro secciones y no se repite en el segundo tick.
   Cada cifra esperada sale de las semillas de esta misma prueba.
   ================================================================ */
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createPacoSATService } from './local-server.mjs';

const ORIGIN = 'https://pacosat.test';
const KEY = 'f'.repeat(64);
const OWN = 'MFI6212158B4';
const OWN2 = 'EDE1902136T2';
const PROV1 = 'AAA010101AAA';
const PROV2 = 'BBB010101BB2';
const D1 = '11111111-1111-4111-8111-111111111111';
const D2 = '22222222-2222-4222-8222-222222222222';
const F2 = '33333333-3333-4333-8333-333333333333';
const CANC = '44444444-4444-4444-8444-444444444444';
const T0 = Date.parse('2026-11-05T15:00:00Z');
const DOMINGO = Date.parse('2026-11-16T03:30:00Z'); /* dom 15 nov 2026, 21:30 en México */
const LUNES = Date.parse('2026-11-16T14:00:00Z'); /* lun 16 nov 2026, 08:00 en México */

function makeHarness(dbFile, mails) {
  let time = T0;
  let token = '';
  const service = createPacoSATService({
    dbFile, html: '<html><head><!--PACOSAT_TOKEN--></head><body>prueba</body></html>',
    origin: ORIGIN, proxyKey: KEY, now: () => time,
    extractText: async () => '',
    makeConnector: async () => ({ parser: class {}, connector: {
      request: async () => 'req-f', check: async () => ({ status: 'pending', packages: [] }),
      download: async () => { throw new Error('sin paquetes'); } } }),
    makeMailer: () => ({ verify: async () => true,
      sendMail: async mail => { mails.push(mail); return { messageId: 'm' + mails.length }; } }) });
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
  const call = async (method, path, body, headers = {}) => {
    if (!token) { const home = await raw('GET', '/'); token = /[0-9a-f]{64}/.exec(home.text)?.[0] || ''; }
    const r = await raw(method, path, body, { 'x-pacosat-token': token, ...headers });
    let json = null; try { json = JSON.parse(r.text); } catch { /* binario */ }
    return { status: r.status, json, text: r.text };
  };
  return { service, call, set time(v) { time = v; }, get time() { return time; } };
}

const invoice = (id, date, from, to, total, folio, serie = 'A') => ({ id, date, kind: 'I',
  from: { rfc: from, name: 'EMPRESA ' + from }, to: { rfc: to, name: 'EMPRESA ' + to },
  total, currency: 'MXN', fiscal: { series: serie, folio, paymentMethod: 'PPD',
    transferred: [{ tax: '002', rate: '0.160000', amount: '0.00' }], withheld: [] } });

const dir = mkdtempSync(join(tmpdir(), 'pacosat-201m-'));
const dbFile = join(dir, 'pacosat.sqlite');
const mails = [];
try {
  {
    const boot = createPacoSATService({ dbFile, html: 'x', origin: ORIGIN, proxyKey: KEY });
    boot.close();
    const seed = new DatabaseSync(dbFile);
    const prof = seed.prepare("INSERT INTO profiles(rfc,minutes,days,direction,nextRun,error) VALUES (?,1440,7,'both',0,'')");
    prof.run(OWN); prof.run(OWN2);
    const rec = seed.prepare("INSERT INTO records(store,id,value) VALUES ('invoices',?,?)");
    rec.run(D1, JSON.stringify(invoice(D1, '2026-10-05', PROV1, OWN, '1160.00', '100')));
    rec.run(D2, JSON.stringify(invoice(D2, '2026-10-05', PROV1, OWN, '1160.00', '101')));
    rec.run(F2, JSON.stringify(invoice(F2, '2026-09-01', PROV1, OWN2, '500.00', '100')));
    rec.run(CANC, JSON.stringify(invoice(CANC, '2026-10-07', PROV2, OWN, '580.00', '200')));
    seed.prepare("INSERT INTO cfdi_watch(id,emitter,receiver,total,seal,next,checked,result,error) VALUES (?,?,?,?,?,0,?,?, '')")
      .run(CANC, PROV2, OWN, '580.00', '', T0 - 1000, JSON.stringify({ state: 'Cancelado' }));
    seed.prepare("INSERT INTO cancellation_seen(id,at) VALUES (?,?)").run(CANC, DOMINGO - 86400000);
    seed.prepare("INSERT INTO jobs(rfc,direction,periodStart,periodEnd,startAt,endAt,requestId,status,imported,due,created,error,checks) VALUES (?,?, '2026-10-01','2026-10-31','2026-10-01 00:00:00','2026-10-31 23:59:59','req-1','finished',?,0,?,'',0)")
      .run(OWN, 'received', JSON.stringify([CANC]), T0 - 3000);
    seed.prepare("INSERT INTO bank_accounts(id,bank,name,last4,kind,created,rfc) VALUES ('cta-1','BBVA','Cuenta semilla','1234','debito',?,?)").run(T0, OWN);
    seed.prepare("INSERT INTO bank_statements(id,accountId,month,fileId,openingCents,closingCents,state,created) VALUES ('edo-1','cta-1','2026-09','',100000,250000,'applied',?)").run(T0);
    seed.prepare("INSERT INTO bank_movements(id,statementId,date,concept,amountCents,balanceCents) VALUES ('mv-1','edo-1','2026-10-10','Pago factura',-116000,250000)").run();
    seed.prepare("INSERT INTO bank_movements(id,statementId,date,concept,amountCents,balanceCents) VALUES ('mv-2','edo-1','2026-10-20','Cargo sin factura',-50000,200000)").run();
    seed.prepare("INSERT INTO bank_matches(id,movementId,invoices,mode,amountCents,why,estado,created,undone) VALUES ('bm-1','mv-1',?,'total',-116000,'importe exacto','activo',?,0)")
      .run(JSON.stringify([{ uuid: D1 }]), T0 - 500);
    const decl = seed.prepare("INSERT INTO declaraciones(id,rfc,tipo,clase,ejercicio,periodo,fechaPresentacion,operacion,fileId,source,created) VALUES (?,?, 'mensual',?,2026,?,?,?,'pdf:x','auto',?)");
    decl.run('decl-a', OWN, 'acuse', '2026-09', '2026-10-17', '11111111', T0);
    decl.run('decl-b', OWN, 'declaracion', '2026-10', '2026-11-17', '22222222', T0);
    const folio = seed.prepare("INSERT INTO decl_folios(id,rfc,tipo,ejercicio,periodo,folio,estado,nota,creado,actualizado) VALUES (?,?, 'mensual',2026,?,?,?,'',?,?)");
    folio.run('fol-1', OWN, '2026-09', '11111111', 'visto', T0, T0);
    folio.run('fol-2', OWN, '2026-10', '22222222', 'visto', T0, T0);
    folio.run('fol-3', OWN, '2026-10', '33333333', 'visto', T0, T0);
    seed.prepare("INSERT INTO sat_executor_jobs(id,rfc,kind,estado,creado,actualizado,error) VALUES ('job-f1',?,'buzon-listar','fallido',?,?, 'portal caído')")
      .run(OWN, T0 - 9000, T0 - 8000);
    const notice = seed.prepare("INSERT INTO news_notices(kind,opkey,rfc,direction,label,recipient,due,sent) VALUES ('descarga',?,?,?,?,?,?,?)");
    const nId = Number(notice.run('op-dom', OWN, 'received', '', '', DOMINGO - 86400000, DOMINGO - 86400000).lastInsertRowid);
    seed.prepare("INSERT INTO news_items(notice,uuid,fecha,counterpartName,counterpartRfc,folio,serie,total,estado,kind,direction,efos) VALUES (?,?,?,?,?,?,?,?,?,?,?, '')")
      .run(nId, D1, '2026-11-10', 'EMPRESA ' + PROV1, PROV1, '100', 'A', '1160.00', 'Vigente', 'I', 'received');
    seed.close();
  }
  const h = makeHarness(dbFile, mails);
  const mailCfg = await h.call('POST', '/api/mail', { host: 'smtp.test', port: 465, security: 'ssl',
    from: 'avisos@pacosat.test', recipient: 'paco@test.mx', user: 'u', password: 'p' });
  assert.equal(mailCfg.status, 200, 'config de correo');

  /* ---- Nº 3 · cruce201 dentro de /api/declaraciones ---- */
  {
    const r = await h.call('GET', '/api/declaraciones?rfc=' + OWN + '&ejercicio=2026');
    assert.equal(r.status, 200);
    const c = r.json.cruce201;
    assert.ok(c, 'cruce201 viaja en la respuesta de siempre');
    assert.equal(c.resumen.conocidas, 3, 'tres operaciones conocidas (2 folios + 1 solo-folio, sin duplicar)');
    assert.equal(c.resumen.conAcuse, 1, 'solo la 11111111 tiene su acuse guardado');
    assert.equal(c.resumen.faltanAcuses, 2, 'faltan los acuses de 22222222 y 33333333');
    assert.deepEqual(c.faltanAcuses.map(o => o.operacion).sort(), ['22222222', '33333333']);
    const conDoc = c.operacionesConocidas.find(o => o.operacion === '11111111');
    assert.equal(conDoc.tieneAcuse, true);
    assert.equal(conDoc.documentoAcuseId, 'decl-a', 'el acuse enlaza a su documento guardado');
    assert.equal(conDoc.origen, 'documento-y-transacciones');
    assert.equal(c.guardados.acuses, 1); assert.equal(c.guardados.declaraciones, 1);
    console.log('OK 2.0.1·F1 nº3 — cruce201: conocidas/con-acuse/faltan desde folios y documentos, sin duplicar.');
  }

  /* ---- Nº 6 · línea de vida: cancelada con respaldo, pago con documento ---- */
  {
    const vida = await h.call('GET', '/api/vida200h?uuid=' + CANC);
    assert.equal(vida.status, 200);
    const canc = vida.json.hitos.find(x => x.tipo === 'cancelada');
    assert.ok(canc, 'la cancelada es un hito propio');
    assert.equal(canc.at, DOMINGO - 86400000, 'su fecha es la del registro que la vio (cancellation_seen)');
    assert.equal(canc.documento?.tipo, 'estado-sat');
    const desc = vida.json.hitos.find(x => x.tipo === 'descargado');
    assert.equal(desc.documento?.id, 'req-1', 'el paso descargado enlaza a su solicitud');
    const vidaD1 = await h.call('GET', '/api/vida200h?uuid=' + D1);
    const pago = vidaD1.json.hitos.find(x => x.tipo === 'pago');
    assert.ok(pago, 'D1 tiene su hito de pago');
    assert.equal(pago.documento?.statementId, 'edo-1', 'el paso pagada enlaza a su estado de cuenta');
    console.log('OK 2.0.1·F1 nº6 — vida: hito cancelada con fecha y respaldo; documentos en descargado y pagada.');
  }

  /* ---- Nº 14 · duplicados sospechosos ---- */
  {
    const r = await h.call('GET', '/api/duplicados201');
    assert.equal(r.status, 200);
    const imp = r.json.sospechosos.find(s => s.tipo === 'mismo-importe-fecha');
    assert.ok(imp, 'el par mismo importe+fecha con folios distintos se lista');
    assert.deepEqual(imp.comprobantes.map(c => c.uuid).sort(), [D1, D2].sort());
    assert.equal(imp.importe, '1160.00'); assert.equal(imp.fecha, '2026-10-05');
    const folio = r.json.sospechosos.find(s => s.tipo === 'mismo-folio-dos-rfc');
    assert.ok(folio, 'el mismo folio en dos RFC se lista');
    assert.equal(folio.emisor, PROV1);
    assert.ok(r.json.nota.includes('solo lectura'), 'se declara de solo lectura');
    const filtrado = await h.call('GET', '/api/duplicados201?rfc=' + OWN2);
    assert.equal(filtrado.json.sospechosos.filter(s => s.tipo === 'mismo-importe-fecha').length, 0,
      'el filtro por RFC no mezcla dueños');
    console.log('OK 2.0.1·F1 nº14 — duplicados: importe+fecha con folios distintos y folio en dos RFC.');
  }

  /* ---- Nº 16 · a medias ---- */
  {
    const r = await h.call('GET', '/api/a-medias201');
    assert.equal(r.status, 200);
    assert.ok(r.json.items.some(i => i.tipo === 'trabajo-interrumpido' && i.seguir.jobId === 'job-f1'),
      'el trabajo fallido del ejecutor entra con su Seguir');
    assert.ok(r.json.items.some(i => i.tipo === 'estado-sin-conciliar'),
      'la cuenta con movimientos sin conciliar entra');
    console.log('OK 2.0.1·F1 nº16 — a-medias reúne trabajo interrumpido y estado sin conciliar.');
  }

  /* ---- Nº 8 · registro común de Deshacer ---- */
  {
    const arc = await h.call('POST', '/api/cfdi/archivar', { uuid: D2 });
    assert.equal(arc.status, 200, JSON.stringify(arc.json));
    let lista = (await h.call('GET', '/api/deshacer201')).json;
    const filaArc = lista.acciones.find(a => a.tipo === 'archivar-cfdi' && a.payload.uuid === D2);
    assert.ok(filaArc, 'archivar se apunta en el registro común');
    assert.equal(filaArc.accion, '/api/cfdi/archivar');
    assert.equal(filaArc.deshecha, false);
    assert.ok(lista.nota.includes('2.0.1'), 'el límite del registro se declara: no reconstruye el pasado');
    const cerrar = await h.call('POST', '/api/ejercicios200g/cerrar', { rfc: OWN, year: '2025' });
    assert.equal(cerrar.status, 200, JSON.stringify(cerrar.json));
    lista = (await h.call('GET', '/api/deshacer201')).json;
    assert.ok(lista.acciones.some(a => a.tipo === 'cerrar-ejercicio' && a.payload.year === '2025'),
      'cerrar ejercicio se apunta');
    const des = await h.call('POST', '/api/cfdi/archivar', { uuid: D2, archivar: false });
    assert.equal(des.status, 200);
    lista = (await h.call('GET', '/api/deshacer201')).json;
    assert.equal(lista.acciones.find(a => a.id === filaArc.id).deshecha, true,
      'restaurar marca la fila deshecha');
    const desbloq = await h.call('POST', '/api/ejercicios200g/desbloquear', { rfc: OWN, year: '2025', confirmar: true });
    assert.equal(desbloq.status, 200, JSON.stringify(desbloq.json));
    lista = (await h.call('GET', '/api/deshacer201')).json;
    assert.equal(lista.acciones.find(a => a.tipo === 'cerrar-ejercicio').deshecha, true,
      'desbloquear marca el cierre deshecho');
    console.log('OK 2.0.1·F1 nº8 — Deshacer: archivar y cerrar se registran; sus deshaceres marcan la fila.');
  }

  /* ---- Nº 20 · resumen del domingo, una sola vez ---- */
  {
    h.time = DOMINGO;
    await h.service.tick();
    const dom = mails.filter(m => String(m.subject || '').includes('Resumen del domingo'));
    assert.equal(dom.length, 2, 'un correo por RFC con perfil (OWN y OWN2), no mezclados: ' +
      mails.map(m => m.subject).join(' | '));
    const propio = dom.find(m => m.subject.includes(OWN));
    assert.ok(propio.text.includes('LO NUEVO (1)'), 'lo nuevo con su cuenta');
    assert.ok(propio.text.includes('EMPRESA ' + PROV1), 'lo nuevo con su contraparte');
    assert.ok(propio.text.includes('LO CANCELADO (1)'), 'lo cancelado de la semana (vista el sábado)');
    assert.ok(propio.text.includes('LO QUE VENCE'), 'la sección de vencimientos existe');
    assert.ok(propio.text.includes('operación 33333333'), 'lo que falta sale del cruce nº 3');
    assert.ok(propio.html && propio.html.includes('LO NUEVO'), 'el HTML de la plantilla madre lleva las mismas secciones');
    await h.service.tick();
    assert.equal(mails.filter(m => String(m.subject || '').includes('Resumen del domingo')).length, 2,
      'el segundo tick del mismo domingo no repite el correo');
    console.log('OK 2.0.1·F1 nº20 — domingo: un correo por RFC, cuatro secciones con datos, sin repetición.');
  }

  /* ---- Nº 7 · autorreparación semanal: su foto en /api/salud ---- */
  {
    h.time = LUNES;
    await h.service.tick();
    const salud = await h.call('GET', '/api/salud');
    assert.equal(salud.status, 200);
    assert.ok(salud.json.auto201, 'auto201 viaja en /api/salud');
    assert.equal(salud.json.auto201.semana, '2026-11-16', 'la pasada del lunes quedó registrada');
    assert.ok(Array.isArray(salud.json.auto201.hechas) && Array.isArray(salud.json.auto201.rotas));
    console.log('OK 2.0.1·F1 nº7 — autorreparación semanal corrida en el tick y su estado en /api/salud (auto201).');
  }
  h.service.close();
  console.log('OK ronda201mejoras — fase 1 de servidor completa.');
} finally { rmSync(dir, { recursive: true, force: true }); }
