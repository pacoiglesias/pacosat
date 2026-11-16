/* ================================================================
   Ronda 2.0 · Tanda 7B — buscador unificado, línea de vida, efecto
   de cancelación, validación al importar, pre-cruce, vigilancia
   (portal/vigencias/tono/esperados), totales y dinero, sistema
   (accesos, invitado, rango, RFC nuevo) y ganchos del Bloque 0.
   Cada cifra esperada sale de las semillas de esta misma prueba.
   ================================================================ */
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createPacoSATService } from './local-server.mjs';
import { buildPdf } from './salidas-doc.mjs';

const ORIGIN = 'https://pacosat.test';
const KEY = 'f'.repeat(64);
const OWN = 'MFI6212158B4';
const PROV1 = 'AAA010101AAA';
const PROV2 = 'BBB010101BB2';
const CLI1 = 'CCC010101CC3';
const R1 = '11111111-1111-4111-8111-111111111111';
const E1 = '22222222-2222-4222-8222-222222222222';
const C1 = '33333333-3333-4333-8333-333333333333';
const S1 = '44444444-4444-4444-8444-444444444444';
const VIEJA = '66666666-6666-4666-8666-666666666666';
const MALA = '77777777-7777-4777-8777-777777777777';
const GRANDE = '88888888-8888-4888-8888-888888888888';
const T0 = Date.parse('2026-11-05T15:00:00Z');

const pdfReal = buildPdf({ title: 'Acuse semilla', subtitle: 'PacoSAT · prueba 200h',
  sections: [{ heading: 'Contenido', lines: ['Acuse de la declaración de octubre.'] }] });
const pdf64 = pdfReal.toString('base64');
const xml64 = uuid => Buffer.from('<?xml version="1.0"?><Comprobante UUID="' + uuid + '"/>').toString('base64');

function makeHarness(extra = {}) {
  let time = T0;
  let token = '';
  const mails = [];
  const service = createPacoSATService({
    dbFile: ':memory:', html: '<html><head><!--PACOSAT_TOKEN--></head><body>prueba</body></html>',
    origin: ORIGIN, proxyKey: KEY, now: () => time,
    extractText: async () => 'Cantidad a pagar: $3,480.00',
    makeConnector: async () => ({ parser: class {}, connector: {
      request: async () => 'req-f', check: async () => ({ status: 'pending', packages: [] }),
      download: async () => { throw new Error('sin paquetes'); } } }),
    makeMailer: () => ({ verify: async () => true,
      sendMail: async mail => { mails.push(mail); return { messageId: 'm' + mails.length }; } }),
    ...extra });
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
  return { service, call, raw, mails, set time(v) { time = v; }, get time() { return time; },
    get token() { return token; } };
}
const base = async h => {
  const mail = await h.call('POST', '/api/mail', { host: 'smtp.test', port: 465, security: 'ssl',
    from: 'avisos@pacosat.test', recipient: 'paco@test.mx', user: 'u', password: 'p' });
  assert.equal(mail.status, 200);
  const seed = await h.call('POST', '/api/storage', { batch: {
    people: [{ id: OWN, name: 'Mano Fil, S.A.' }] } });
  assert.equal(seed.status, 200);
  const open = await h.call('POST', '/api/unlock', { rfc: OWN, minutes: 1440, days: 7,
    direction: 'both', password: 'simulated', certificate: 'YQ==', key: 'Yg==' });
  assert.equal(open.status, 200, 'unlock');
};
const invoice = (id, date, from, to, total, extra = {}) => ({ id, date, kind: 'I',
  from: { rfc: from, name: 'EMPRESA ' + from }, to: { rfc: to, name: 'EMPRESA ' + to },
  total, currency: 'MXN',
  fiscal: { paymentMethod: 'PPD', transferred: [{ tax: '002', rate: '0.160000', amount: '0.00' }], withheld: [] },
  ...extra });

/* ===== Escenario con DB en fichero (semillas directas) ===== */
const dir = mkdtempSync(join(tmpdir(), 'pacosat-200h-'));
const dbFile = join(dir, 'pacosat.sqlite');
{
  const boot = createPacoSATService({ dbFile, html: 'x', origin: ORIGIN, proxyKey: KEY });
  boot.close();
  const seed = new DatabaseSync(dbFile);
  seed.prepare("INSERT INTO profiles(rfc,minutes,days,direction,nextRun,error) VALUES (?,1440,7,'both',0,'')").run(OWN);
  const meta = seed.prepare('INSERT INTO metadata_records(uuid,rfc,direction,emitter,receiver,issuedAt,total,status,cancelDate,seenAt) VALUES (?,?,?,?,?,?,?,?,?,?)');
  meta.run(R1, OWN, 'received', PROV1, OWN, '2026-10-03', '1160.00', '1', '', T0);
  meta.run(C1, OWN, 'received', PROV2, OWN, '2026-10-05', '580.00', '0', '2026-10-06', T0);
  seed.prepare("INSERT INTO cfdi_watch(id,emitter,receiver,total,seal,next,checked,result,error) VALUES (?,?,?,?,?,0,?,?, '')")
    .run(C1, PROV2, OWN, '580.00', '', T0, JSON.stringify({ state: 'Cancelado' }));
  seed.prepare("INSERT INTO jobs(rfc,direction,periodStart,periodEnd,startAt,endAt,requestId,status,imported,due,created,error,checks) VALUES (?,?, '2026-10-01','2026-10-31','2026-10-01 00:00:00','2026-10-31 23:59:59','req-1','finished',?,0,?,'',0)")
    .run(OWN, 'received', JSON.stringify([R1]), T0);
  seed.prepare("INSERT INTO declaraciones(id,rfc,tipo,clase,ejercicio,periodo,fechaPresentacion,operacion,fileId,source,created) VALUES ('decl-1',?, 'mensual','acuse',2026,'2026-10','2026-10-17','123456','pdf:doc-semilla','auto',?)")
    .run(OWN, T0);
  /* (6) Dos fallos seguidos EN LA ENTRADA, hoy. */
  const run = seed.prepare("INSERT INTO sat_doc_runs(id,rfc,kind,started,finished,ok,error,errorKind,steps,shotId,htmlId) VALUES (?,?,?,?,?,0,'fallo',?,'[]','','')");
  run.run('run-p1', OWN, 'constancia', T0 - 3600000, T0 - 3500000, 'portal-rechaza');
  run.run('run-p2', OWN, 'opinion', T0 - 1800000, T0 - 1700000, 'ruta-muerta');
  /* (9) Un aviso viejo sin gesto. */
  seed.prepare("INSERT INTO avisos(ref,kind,clase,estado,severidad,titulo,detalle,contraparte,nombre,importe,enlace,datos,baseline,creado,actualizado,correo,rfc) VALUES ('viejo200h','general','falta','abierto','media','Aviso viejo de prueba','Detalle', '', '', '', '', '{}', 0, ?, ?, 0, ?)")
    .run(T0 - 4 * 86400000, T0 - 4 * 86400000, OWN);
  /* Bancos: cuenta, estado y movimientos (13/14). */
  seed.prepare("INSERT INTO bank_accounts(id,bank,name,last4,kind,created,rfc) VALUES ('cta-1','BBVA','Cuenta semilla','1234','debito',?,?)").run(T0, OWN);
  seed.prepare("INSERT INTO bank_statements(id,accountId,month,fileId,openingCents,closingCents,state,created) VALUES ('edo-1','cta-1','2026-09','',100000,250000,'applied',?)").run(T0);
  const mv = seed.prepare("INSERT INTO bank_movements(id,statementId,date,concept,amountCents,balanceCents) VALUES (?,?,?,?,?,?)");
  mv.run('mv-1', 'edo-1', '2026-10-10', 'Abono cliente', 200000, 300000);
  mv.run('mv-2', 'edo-1', '2026-10-20', 'Pago proveedor', -50000, 250000);
  /* (16) Catálogo y preparación: un beneficiario con la cuenta cambiada. */
  seed.prepare("INSERT INTO pay_beneficiaries(id,rfc,nombre,payload,created,updated) VALUES ('ben-1',?, 'Proveedor Uno', ?, ?, ?)")
    .run(OWN, JSON.stringify({ nombre: 'Proveedor Uno', cuenta: '9999' }), T0, T0);
  seed.prepare("INSERT INTO pay_preparations(id,rfc,month,total,operaciones,payload,created) VALUES ('prep-1',?,'2026-10','100.00',1,?,?)")
    .run(OWN, JSON.stringify({ bbva: { lines: [{ nombre: 'Proveedor Uno', cuenta: '1111', totalCents: 10000 }] },
      interbancario: { lines: [] }, speiIndividual: { lines: [] } }), T0);
  seed.close();
}
const h = makeHarness({ dbFile });
try {
  await base(h);
  const seedInv = await h.call('POST', '/api/storage', { batch: {
    invoices: [
      invoice(R1, '2026-10-03', PROV1, OWN, '1160.00'),
      invoice(E1, '2026-10-04', OWN, CLI1, '2320.00'),
      invoice(C1, '2026-10-05', PROV2, OWN, '580.00'),
      invoice(S1, '2026-09-02', PROV1, OWN, '100.00'),
      invoice(VIEJA, '2026-06-01', PROV1, OWN, '500.00'),
      invoice(MALA, '2026-10-07', 'AAA010101AA', OWN, '10.00'),
      { ...invoice('99999999-9999-4999-8999-999999999999', '2026-10-08', PROV1, OWN, '100.00'),
        from: { rfc: PROV1, name: 'NOMBRE DISTINTO SA' } },
      invoice('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2026-08-01', PROV1, OWN, '100.00'),
      invoice('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '2026-08-02', PROV1, OWN, '100.00'),
      invoice('cccccccc-cccc-4ccc-8ccc-cccccccccccc', '2026-08-03', PROV1, OWN, '100.00'),
      invoice(GRANDE, '2026-10-09', PROV1, OWN, '1000.00')],
    files: [
      { id: 'xml:' + R1, content: xml64(R1), mime: 'application/xml' },
      { id: 'pdf:doc-semilla', content: pdf64, mime: 'application/pdf' }],
    documents: [
      { id: 'pdf:doc-semilla', rfc: OWN, kind: 'Opinión de cumplimiento', date: '2026-10-05', period: '', name: 'opinion-octubre.pdf' }] } });
  assert.equal(seedInv.status, 200, 'semilla del escenario');

  /* ===== (0a, servidor) Hoy ya trae los estados pendientes ===== */
  const st = await h.call('GET', '/api/status');
  assert.ok(st.json.estadosPendientes, 'el estado servido trae estadosPendientes');
  assert.ok(st.json.estadosPendientes.faltantes.some(f => f.accountId === 'cta-1'),
    'la cuenta sin estado del mes anterior consta como faltante');
  console.log('OK 2.0·T7B · (0a) Hoy recibe estadosPendientes con la cuenta faltante (la fila con su botón va en el cliente).');

  /* ===== (1) Buscador unificado, grupos separados por RFC ===== */
  const busq = await h.call('GET', '/api/buscar200h?q=' + PROV1 + '&todos=1');
  assert.equal(busq.status, 200);
  const grupoOwn = busq.json.porRfc.find(g => g.rfc === OWN);
  assert.ok(grupoOwn, 'los resultados vienen agrupados por RFC, nunca mezclados');
  assert.ok(grupoOwn.grupos.cfdi.some(x => x.uuid === R1 && x.destino.vista === 'invoices'),
    'el CFDI sale en su grupo con su destino exacto');
  const busqAviso = await h.call('GET', '/api/buscar200h?q=' + encodeURIComponent('Aviso viejo'));
  assert.ok(busqAviso.json.porRfc.some(g => g.grupos.avisos.length), 'los avisos también se buscan');
  console.log('OK 2.0·T7B · (1) buscador unificado: CFDI/Documentos/Avisos/Registro por RFC.');

  /* ===== (2) Línea de vida del CFDI ===== */
  const vida = await h.call('GET', '/api/vida200h?uuid=' + R1);
  assert.equal(vida.status, 200);
  const tipos = vida.json.hitos.map(x => x.tipo);
  assert.ok(tipos.includes('descubierto') && tipos.includes('descargado') && tipos.includes('emision'),
    'la vida trae descubierto, emisión y descarga: ' + tipos.join(','));
  const sinVida = await h.call('GET', '/api/vida200h?uuid=00000000-0000-4000-8000-000000000000');
  assert.equal(sinVida.status, 404, 'un UUID que no consta no inventa vida');
  console.log('OK 2.0·T7B · (2) línea de vida compuesta solo de registros existentes.');

  /* ===== (3) Cancelación con su efecto en el mes ===== */
  const ef = await h.call('GET', '/api/cancelacion-efecto200h?uuid=' + C1);
  assert.equal(ef.status, 200);
  assert.equal(ef.json.despues.importe, '4590.00',
    'octubre DESPUÉS de la cancelación (sin los $580 de C1): 1160+2320+10+100+1000 — ' + JSON.stringify(ef.json.despues));
  assert.equal(ef.json.despues.comprobantes, 5);
  assert.match(ef.json.texto, /octubre de 2026 queda con 5 comprobante\(s\) por \$4,590\.00/);
  console.log('OK 2.0·T7B · (3) efecto de la cancelación desde el cálculo único.');

  /* ===== (5) Pre-cruce documento contra documento ===== */
  const cruce = await h.call('GET', '/api/precruce200h?rfc=' + OWN + '&month=2026-10');
  assert.equal(cruce.json.declarado, '3480.00', 'la cifra declarada sale del texto del acuse: ' + JSON.stringify(cruce.json));
  assert.equal(cruce.json.estado, 'diferencia');
  assert.equal(cruce.json.diferencia, '1110.00', '4590 de CFDI − 3480 declarado, ambos con su documento');
  const sinDecl = await h.call('GET', '/api/precruce200h?rfc=' + OWN + '&month=2026-09');
  assert.equal(sinDecl.json.estado, 'sin-datos');
  assert.match(sinDecl.json.texto, /Sin declaración en el expediente/);
  console.log('OK 2.0·T7B · (5) pre-cruce: totales contra el acuse; sin declaración, «sin datos» y nada estimado.');

  /* ===== (11) Totales: rejilla anual y comparador ===== */
  const anio = await h.call('GET', '/api/totales200h?rfc=' + OWN + '&year=2026');
  assert.equal(anio.json.meses.length, 12);
  const octT = anio.json.meses.find(m => m.mes === '2026-10');
  assert.equal(octT.recibidasImporte, '2270.00', 'recibidas de octubre: 1160+10+100+1000');
  assert.equal(octT.emitidasImporte, '2320.00');
  const comp = await h.call('GET', '/api/totales200h?rfc=' + OWN + '&a=2026-09&b=2026-10');
  assert.equal(comp.json.diferencia, '4490.00', 'de septiembre ($100) a octubre ($4,590)');
  assert.equal(comp.json.diferenciaPct, 4490);
  console.log('OK 2.0·T7B · (11) rejilla de 12 meses y comparador con diferencia y % de cifras reales.');

  /* ===== (12) Antigüedad de saldos ===== */
  const ant = await h.call('GET', '/api/antiguedad200h?rfc=' + OWN);
  const cubeta60 = ant.json.porPagar.find(c => c.id === '31-60');
  assert.ok(cubeta60.uuids.includes(R1), 'la factura del 3-oct (33 días) cae en 31–60 por pagar: ' + JSON.stringify(ant.json.porPagar));
  const cubeta90 = ant.json.porPagar.find(c => c.id === 'mas-90');
  assert.ok(cubeta90.uuids.includes(VIEJA), 'la del 1-jun cae en >90');
  console.log('OK 2.0·T7B · (12) antigüedad de saldos en cubetas desde los saldos vivos.');

  /* ===== (13) Saldo vivo y (14) gráfica de Dinero ===== */
  const sv = await h.call('GET', '/api/saldo-vivo200h?cuenta=cta-1');
  assert.ok(sv.json.puntos.length >= 2, 'la línea de saldo sale de los movimientos registrados');
  assert.equal(sv.json.puntos[sv.json.puntos.length - 1].saldo, '2500.00',
    'apertura $1,000 + $2,000 − $500 = $2,500: ' + JSON.stringify(sv.json.puntos));
  const sinSv = await h.call('GET', '/api/saldo-vivo200h?cuenta=no-existe');
  assert.equal(sinSv.status, 404);
  const graf = await h.call('GET', '/api/grafica200h?rfc=' + OWN + '&year=2026');
  const octG = graf.json.meses.find(m => m.mes === '2026-10');
  assert.equal(octG.entradas, '2000.00'); assert.equal(octG.salidas, '500.00');
  assert.match(graf.json.fuente, /Movimientos bancarios registrados/);
  console.log('OK 2.0·T7B · (13)+(14) saldo vivo de la cuenta y entradas/salidas por mes desde Bancos.');

  /* ===== (15) Vistas guardadas ===== */
  const vista = await h.call('POST', '/api/vistas200h', { rfc: OWN, pantalla: 'facturas',
    nombre: 'Recibidas de octubre', filtros: { month: '2026-10', direction: 'Recibidos' } });
  assert.equal(vista.status, 200);
  const vistas = await h.call('GET', '/api/vistas200h?rfc=' + OWN);
  assert.ok(vistas.json.vistas.some(v => v.nombre === 'Recibidas de octubre' && v.filtros.month === '2026-10'));
  const borraVista = await h.call('POST', '/api/vistas200h/borrar', { id: vista.json.id });
  assert.equal(borraVista.json.ok, true);
  console.log('OK 2.0·T7B · (15) vistas guardadas: guardar, aplicar (el cliente) y borrar.');

  /* ===== (16) Repetir un pago: cotejo contra el catálogo ===== */
  const rep = await h.call('POST', '/api/repetir-pago200h', { id: 'prep-1' });
  assert.equal(rep.status, 200);
  assert.equal(rep.json.bloqueado, true, 'la cuenta cambió en el catálogo: se avisa antes de seguir');
  assert.match(rep.json.avisos.join(' '), /cambió en el catálogo/);
  console.log('OK 2.0·T7B · (16) repetir un pago precarga solo si el beneficiario sigue igual en el catálogo.');

  /* ===== (17) La nota del CFDI sale en el Excel de Facturas ===== */
  const nota = await h.call('POST', '/api/cfdi/nota', { uuid: R1, nota: 'Nota de prueba 200h' });
  assert.equal(nota.status, 200);
  const xlsx = await h.call('POST', '/api/salidas/xlsx', { kind: 'facturas', rfc: OWN, month: '2026-10' });
  assert.equal(xlsx.status, 200, 'el Excel de Facturas sale: ' + xlsx.status);
  const xlsxTxt = Buffer.from(xlsx.json.content, 'base64').toString('latin1');
  assert.ok(xlsxTxt.includes('Nota de prueba 200h'), 'la nota viaja en el reporte donde el comprobante sale');
  console.log('OK 2.0·T7B · (17) la nota vive con el papel: consta en el Excel de Facturas.');

  /* ===== (18) Semana fiscal y (20) accesos y (22) ejemplo ===== */
  const semana = await h.call('GET', '/api/semana200h?rfc=' + OWN);
  assert.ok(semana.json.desde && semana.json.hoy, 'la semana trae su marco y su HOY');
  const accesos = await h.call('GET', '/api/accesos200h');
  assert.equal(accesos.status, 200);
  assert.ok(Array.isArray(accesos.json.accesos));
  const ejemplo = await h.call('GET', '/api/ayuda-ejemplo200h?rfc=' + OWN);
  assert.ok(ejemplo.json.ejemplo?.texto.includes('Tu último CFDI bajado'), 'el ejemplo sale del propio expediente');
  console.log('OK 2.0·T7B · (18)+(20)+(22) semana fiscal, bitácora de accesos y ejemplo real en la ayuda.');

  /* ===== (25) El último rango de descarga se recuerda ===== */
  const rangoPost = await h.call('POST', '/api/descarga-rango200h',
    { rfc: OWN, direction: 'received', desde: '2026-10-01', hasta: '2026-10-31' });
  assert.equal(rangoPost.json.ok, true);
  const rangoGet = await h.call('GET', '/api/descarga-rango200h?rfc=' + OWN + '&direction=received');
  assert.equal(rangoGet.json.rango.desde, '2026-10-01');
  const rangoOtro = await h.call('GET', '/api/descarga-rango200h?rfc=' + OWN + '&direction=issued');
  assert.equal(rangoOtro.json.rango, null, 'el rango se recuerda por RFC y sentido');
  console.log('OK 2.0·T7B · (25) la hoja de descarga recuerda el último rango por RFC y sentido.');

  /* ===== (23) Alta guiada de RFC: recorrido con comprobaciones reales ===== */
  const plan = await h.call('GET', '/api/rfc-nuevo200h?rfc=' + OWN);
  assert.equal(plan.json.pasos.length, 5);
  assert.equal(plan.json.pasos.find(p => p.id === 'datos').ok, true, 'el RFC sembrado consta en datos');
  assert.equal(plan.json.pasos.find(p => p.id === 'correo').ok, true, 'el correo consta configurado en esta semilla');
  console.log('OK 2.0·T7B · (23) alta guiada: pasos con su comprobación real, sin maquinaria nueva.');

  /* ===== (9) El parte aprende: aviso de 3+ días sin gesto ===== */
  const tono = await h.call('GET', '/api/avisos-tono200h');
  const viejo = tono.json.avisos.find(a => a.ref === 'viejo200h');
  assert.ok(viejo?.olvidado && /Llevas 4 días con esto pendiente/.test(viejo.frase),
    'el aviso viejo sube de tono y se nombra: ' + JSON.stringify(viejo));
  assert.equal(tono.json.avisos[0].ref, 'viejo200h', 'y va primero en su lista');
  console.log('OK 2.0·T7B · (9) el aviso sin gesto de 3+ días va primero y nombrado.');

  /* ===== (10) Esperados + (6) portal + (8) vigencias, vía tick ===== */
  const esp = await h.call('POST', '/api/esperados200h', { rfc: OWN,
    contraparteRfc: PROV2, contraparteNombre: 'EMPRESA ' + PROV2, dia: 3, importe: '9999.00', tolerancia: 10 });
  assert.equal(esp.status, 200);
  { const db2 = new DatabaseSync(dbFile);
    db2.prepare('UPDATE profiles SET certExpires=? WHERE rfc=?').run(T0 + 6 * 86400000, OWN);
    /* La semilla de unlock deja su propio certExpires: se fija a
       +6 días para que el hito de 7 sea el que nace en este tick. */
    db2.prepare("INSERT INTO sat_executor_jobs(id,rfc,kind,estado,creado,actualizado,steps) VALUES ('job-reanuda',?,'buzon-listar','en-cola',?,?,?)")
      .run(OWN, T0, T0, JSON.stringify([{ paso: 'Se reanudó donde iba', detalle: 'huérfano recuperado' }]));
    db2.prepare("INSERT INTO sat_executor_jobs(id,rfc,kind,estado,creado,actualizado,steps) VALUES ('job-muerto',?,'buzon-listar','reclamado',?,?, '[]')")
      .run(OWN, T0 - 20 * 60000, T0 - 20 * 60000);
    db2.close(); }
  await h.service.tick();
  const notices = await h.call('GET', '/api/notices');
  const titulos = (notices.json.avisos || []).map(a => a.titulo);
  assert.ok(titulos.some(t => /SAT parece haber cambiado su entrada/.test(t)),
    '(6) dos fallos de entrada el mismo día nacen en aviso: ' + titulos.join(' | '));
  assert.ok(titulos.some(t => /No ha llegado lo de/.test(t)),
    '(10) el esperado que no llegó nace en aviso: ' + titulos.join(' | '));
  assert.ok(titulos.some(t => /e\.firma de/.test(t) && /6 días|vence/.test(t)),
    '(8) la vigencia dentro del hito de 7 días nace en aviso (mecanismo de umbrales): ' + titulos.join(' | '));
  assert.ok(titulos.some(t => /se apagó a mitad/.test(t)),
    '(21b) el trabajo cuyo ejecutor murió a mitad se enseña en llano, no como fallo: ' + titulos.join(' | '));
  const busqReanuda = await h.call('GET', '/api/buscar200h?q=' + encodeURIComponent('reanudó'));
  assert.ok(busqReanuda.json.porRfc.some(g => g.grupos.registro.some(r => /se reanudó donde iba/i.test(r.texto))),
    '(21) la reanudación del trabajo huérfano queda nombrada en el Registro');
  console.log('OK 2.0·T7B · (6)+(8)+(10)+(21) vigilancia del tick: portal, vigencias, esperados y reanudación visible.');

  /* ===== (24) Invitado de solo lectura por UN RFC ===== */
  const inv = await h.call('POST', '/api/invitado200h', { rfc: OWN, dias: 7 });
  assert.equal(inv.status, 200);
  assert.ok(inv.json.clave, 'la clave del invitado se entrega una sola vez');
  const login = await h.raw('POST', '/api/guest/login', { password: inv.json.clave });
  const loginJson = JSON.parse(login.text);
  assert.ok(loginJson.token, 'el invitado entra con su clave');
  const guestHeaders = { 'x-pacosat-token': loginJson.token };
  const gBusq = await h.call('GET', '/api/buscar200h?rfc=' + OWN + '&q=' + PROV1, undefined, guestHeaders);
  assert.equal(gBusq.status, 200, 'el invitado lee su RFC');
  const gWrite = await h.call('POST', '/api/vistas200h', { rfc: OWN, pantalla: 'facturas', nombre: 'x', filtros: {} }, guestHeaders);
  assert.equal(gWrite.status, 403, 'toda escritura del invitado la rechaza el SERVIDOR');
  const gOtro = await h.call('GET', '/api/buscar200h?rfc=' + PROV2 + '&q=' + PROV2, undefined, guestHeaders);
  assert.equal(gOtro.status, 403,
    'fuera de su RFC, el invitado recibe 403 (como vida/totales/precruce; antes recibía una lista vacía y con todos=1 o sin rfc veía TODO — la fuga H-1)');
  const revoca = await h.call('POST', '/api/invitado200h/revocar', {});
  assert.equal(revoca.json.ok, true);
  const gTrasRevocar = await h.call('GET', '/api/buscar200h?rfc=' + OWN + '&q=' + PROV1, undefined, guestHeaders);
  assert.equal(gTrasRevocar.status, 403, 'revocado: su sesión muere en el servidor');
  console.log('OK 2.0·T7B · (24) invitado por RFC: lee solo su RFC, el servidor rechaza sus escrituras y la revocación lo apaga.');
} finally {
  h.service.close();
  rmSync(dir, { recursive: true, force: true });
}
/* ===== Segunda parte: mismas semillas, resto de piezas ===== */
const h2 = makeHarness({ dbFile: ':memory:' });
try {
  await base(h2);
  const seed2 = await h2.call('POST', '/api/storage', { batch: {
    invoices: [
      invoice(R1, '2026-10-03', PROV1, OWN, '1160.00'),
      invoice(E1, '2026-10-04', OWN, CLI1, '2320.00'),
      invoice(C1, '2026-10-05', PROV2, OWN, '580.00'),
      invoice(S1, '2026-09-02', PROV1, OWN, '100.00'),
      invoice(VIEJA, '2026-06-01', PROV1, OWN, '500.00'),
      invoice(MALA, '2026-10-07', 'AAA010101AA', OWN, '10.00'),
      { ...invoice('99999999-9999-4999-8999-999999999999', '2026-10-08', PROV1, OWN, '100.00'),
        from: { rfc: PROV1, name: 'NOMBRE DISTINTO SA' } },
      invoice('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2026-08-01', PROV1, OWN, '100.00'),
      invoice('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '2026-08-02', PROV1, OWN, '100.00'),
      invoice('cccccccc-cccc-4ccc-8ccc-cccccccccccc', '2026-08-03', PROV1, OWN, '100.00'),
      invoice(GRANDE, '2026-10-09', PROV1, OWN, '1000.00')],
    files: [{ id: 'pdf:doc-semilla', content: pdf64, mime: 'application/pdf' }] } });
  assert.equal(seed2.status, 200, 'semilla de la segunda parte');

  /* ===== (4) Validación al importar + (7) ¿esto es nuevo? ===== */
  const marcas = await h2.call('GET', '/api/marcas200h?rfc=' + OWN);
  const deMala = marcas.json.marcas.filter(m => m.uuid === MALA);
  assert.ok(deMala.some(m => m.marca === 'rfc-no-valida'),
    'el RFC que no valida queda marcado: ' + JSON.stringify(deMala));
  assert.ok(marcas.json.marcas.some(m => m.uuid === '99999999-9999-4999-8999-999999999999' && m.marca === 'nombre-distinto'),
    'el nombre que no casa con el conocido queda marcado');
  assert.ok(marcas.json.marcas.some(m => m.uuid === GRANDE && m.marca === 'importe-atipico'),
    'el importe >3× la mediana de la contraparte queda marcado (7)');
  const segundo = await h2.call('POST', '/api/storage', { batch: {
    invoices: [invoice('dddddddd-dddd-4ddd-8ddd-dddddddddddd', '2026-10-11', 'DDD010101DD4', OWN, '50.00')] } });
  assert.equal(segundo.status, 200, 'la importación nunca se bloquea por las marcas');
  const marcas2 = await h2.call('GET', '/api/marcas200h?rfc=' + OWN);
  assert.ok(marcas2.json.marcas.some(m => m.uuid === 'DDDDDDDD-DDDD-4DDD-8DDD-DDDDDDDDDDDD' && m.marca === 'emisor-nuevo'),
    'un emisor nunca visto para el RFC queda marcado «emisor-nuevo» (7)');
  console.log('OK 2.0·T7B · (4)+(7) marcas al importar: RFC que no valida, nombre distinto, emisor nuevo e importe atípico — sin bloquear nada.');

} finally { h2.service.close(); }

/* ===== H-1 + H-4 (corrección de seguridad 2.0): el invitado de
   UN RFC no ve NADA del otro en las cinco rutas corregidas, y
   rotar su acceso purga sus sesiones vivas ===== */
{
  const AJENO = 'AJE010101AJ1';
  const U_OWN = '12121212-1212-4121-8121-121212121212';
  const U_AJE = '34343434-3434-4343-8343-343434343434';
  const dir3 = mkdtempSync(join(tmpdir(), 'pacosat-200h-h1-'));
  const dbFile3 = join(dir3, 'pacosat.sqlite');
  {
    const boot = createPacoSATService({ dbFile: dbFile3, html: 'x', origin: ORIGIN, proxyKey: KEY });
    boot.close();
    const seed = new DatabaseSync(dbFile3);
    const prof = seed.prepare("INSERT INTO profiles(rfc,minutes,days,direction,nextRun,error) VALUES (?,1440,7,'both',0,'')");
    prof.run(OWN); prof.run(AJENO);
    seed.prepare("INSERT INTO bank_accounts(id,bank,name,last4,kind,created,rfc) VALUES ('cta-propia','BBVA','Cuenta propia','1111','debito',?,?)").run(T0, OWN);
    seed.prepare("INSERT INTO bank_accounts(id,bank,name,last4,kind,created,rfc) VALUES ('cta-ajena','BBVA','Cuenta ajena','2222','debito',?,?)").run(T0, AJENO);
    seed.prepare("INSERT INTO bank_statements(id,accountId,month,fileId,openingCents,closingCents,state,created) VALUES ('edo-propio','cta-propia','2026-11','',0,0,'applied',?)").run(T0);
    seed.prepare("INSERT INTO bank_statements(id,accountId,month,fileId,openingCents,closingCents,state,created) VALUES ('edo-ajeno','cta-ajena','2026-11','',0,0,'applied',?)").run(T0);
    const mv = seed.prepare("INSERT INTO bank_movements(id,statementId,date,concept,amountCents,balanceCents) VALUES (?,?,?,?,?,?)");
    mv.run('mv-propio', 'edo-propio', '2026-11-04', 'MOVIMIENTO PROPIO', 11100, 11100);
    mv.run('mv-ajeno', 'edo-ajeno', '2026-11-04', 'MOVIMIENTO AJENO SECRETO', 777700, 777700);
    const ev = seed.prepare("INSERT INTO audit_events(at,clase,rfc,texto,ok) VALUES (?,'accion',?,?,1)");
    ev.run(T0, OWN, 'Registro propio PALABRAPROPIA');
    ev.run(T0, AJENO, 'Registro secreto del RFC ajeno PALABRAAJENA');
    seed.close();
  }
  const h3 = makeHarness({ dbFile: dbFile3 });
  try {
    await base(h3);
    const seed3 = await h3.call('POST', '/api/storage', { batch: { invoices: [
      invoice(U_OWN, '2026-11-03', PROV1, OWN, '1111.00'),
      { ...invoice(U_AJE, '2026-11-04', PROV2, AJENO, '7777.00'),
        from: { rfc: PROV2, name: 'SECRETA AJENA SA' }, to: { rfc: AJENO, name: 'EMPRESA AJENA' } }] } });
    assert.equal(seed3.status, 200, 'semilla de dos RFC');
    const prohibido = (res, que) => {
      const txt = JSON.stringify(res.json ?? res.text ?? '');
      for (const marca of [AJENO, U_AJE, '7777', 'SECRETA AJENA', 'MOVIMIENTO AJENO', 'PALABRAAJENA'])
        assert.ok(!txt.includes(marca), que + ': la respuesta del invitado no contiene «' + marca + '» del RFC ajeno');
    };
    /* Semana del ADMIN con ámbito: los movimientos se filtran
       por las cuentas de ese RFC (antes no se filtraban nunca). */
    const semAdminAjeno = await h3.call('GET', '/api/semana200h?rfc=' + AJENO);
    assert.ok(JSON.stringify(semAdminAjeno.json).includes('MOVIMIENTO AJENO SECRETO'),
      'admin con rfc ajeno: ve el movimiento de la cuenta ajena');
    assert.ok(!JSON.stringify(semAdminAjeno.json).includes('MOVIMIENTO PROPIO'),
      'admin con rfc ajeno: NO ve el movimiento de la cuenta propia');
    const semAdminPropia = await h3.call('GET', '/api/semana200h?rfc=' + OWN);
    assert.ok(JSON.stringify(semAdminPropia.json).includes('MOVIMIENTO PROPIO') &&
      !JSON.stringify(semAdminPropia.json).includes('MOVIMIENTO AJENO'),
      'admin con su rfc: solo los movimientos de sus cuentas');
    /* Invitado de OWN. */
    const inv3 = await h3.call('POST', '/api/invitado200h', { rfc: OWN, dias: 7 });
    assert.equal(inv3.status, 200);
    const login3 = JSON.parse((await h3.raw('POST', '/api/guest/login', { password: inv3.json.clave })).text);
    assert.ok(login3.token, 'el invitado entra');
    const gh = { 'x-pacosat-token': login3.token };
    /* (1) buscar200h: (a) sin rfc, (b) rfc ajeno, (c) todos=1. */
    prohibido(await h3.call('GET', '/api/buscar200h?q=SECRETA', undefined, gh), 'buscar sin rfc');
    prohibido(await h3.call('GET', '/api/buscar200h?q=PALABRAAJENA', undefined, gh), 'buscar el Registro ajeno sin rfc');
    const bAjeno = await h3.call('GET', '/api/buscar200h?q=SECRETA&rfc=' + AJENO, undefined, gh);
    assert.equal(bAjeno.status, 403, 'buscar con el RFC ajeno explícito: 403, como las demás rutas');
    prohibido(await h3.call('GET', '/api/buscar200h?q=SECRETA&todos=1', undefined, gh), 'buscar con todos=1 (se ignora)');
    const bPropia = await h3.call('GET', '/api/buscar200h?q=1111&todos=1', undefined, gh);
    assert.ok(JSON.stringify(bPropia.json).includes(U_OWN),
      'con todos=1 el invitado sigue encontrando lo SUYO (su ámbito manda, no «todos»)');
    const bRegistro = await h3.call('GET', '/api/buscar200h?q=PALABRAPROPIA', undefined, gh);
    assert.ok(JSON.stringify(bRegistro.json).includes('PALABRAPROPIA'), 'y su propio Registro');
    /* (2) antiguedad200h: (a) sin rfc, (b) rfc ajeno. */
    const aSin = await h3.call('GET', '/api/antiguedad200h', undefined, gh);
    assert.equal(aSin.json.rfc, OWN, 'antigüedad sin rfc: se resuelve a SU RFC, nunca a todos');
    prohibido(aSin, 'antigüedad sin rfc');
    assert.ok(JSON.stringify(aSin.json).includes(U_OWN), 'su saldo sí consta');
    const aAjeno = await h3.call('GET', '/api/antiguedad200h?rfc=' + AJENO, undefined, gh);
    assert.equal(aAjeno.status, 403, 'antigüedad con el RFC ajeno: 403');
    /* (3) semana200h: (a) sin rfc, (b) rfc ajeno. */
    const sSin = await h3.call('GET', '/api/semana200h', undefined, gh);
    prohibido(sSin, 'semana sin rfc');
    assert.ok(JSON.stringify(sSin.json).includes('MOVIMIENTO PROPIO'), 'su movimiento de la semana sí consta');
    const sAjeno = await h3.call('GET', '/api/semana200h?rfc=' + AJENO, undefined, gh);
    assert.equal(sAjeno.status, 403, 'semana con el RFC ajeno: 403');
    /* (4) ayuda-ejemplo200h: el último CFDI global es el AJENO
       (2026-11-04) y aun así el ejemplo del invitado es el suyo. */
    const aySin = await h3.call('GET', '/api/ayuda-ejemplo200h', undefined, gh);
    assert.equal(aySin.json.ejemplo?.uuid, U_OWN, 'ayuda sin rfc: el ejemplo sale de SU ámbito');
    prohibido(aySin, 'ayuda sin rfc');
    const ayAjeno = await h3.call('GET', '/api/ayuda-ejemplo200h?rfc=' + AJENO, undefined, gh);
    assert.equal(ayAjeno.status, 403, 'ayuda con el RFC ajeno: 403');
    /* (5) cancelacion-efecto200h: chequeo como el de vida200h. */
    const cAjeno = await h3.call('GET', '/api/cancelacion-efecto200h?uuid=' + U_AJE, undefined, gh);
    assert.equal(cAjeno.status, 403, 'efecto de cancelación de un CFDI ajeno: 403');
    prohibido(cAjeno, 'cancelación ajena');
    const cPropio = await h3.call('GET', '/api/cancelacion-efecto200h?uuid=' + U_OWN, undefined, gh);
    assert.equal(cPropio.status, 200, 'el efecto de SU CFDI sí lo lee');
    assert.equal(cPropio.json.rfc, OWN);
    console.log('OK 2.0·SEG · H-1 las cinco rutas del invitado quedan dentro de su RFC (sin rfc / rfc ajeno / todos=1).');

    /* ===== H-4: rotar el invitado purga sus sesiones vivas ===== */
    const inv3b = await h3.call('POST', '/api/invitado200h', { rfc: OWN, dias: 7 });
    assert.equal(inv3b.status, 200);
    assert.notEqual(inv3b.json.clave, inv3.json.clave, 'la rotación emite clave nueva');
    const sesionVieja = await h3.call('GET', '/api/buscar200h?q=1111', undefined, gh);
    assert.equal(sesionVieja.status, 403, 'tras rotar en invitado200h, la sesión vieja muere (401/403)');
    const login3b = JSON.parse((await h3.raw('POST', '/api/guest/login', { password: inv3b.json.clave })).text);
    assert.ok(login3b.token, 'con la clave nueva sí entra');
    const gh2 = { 'x-pacosat-token': login3b.token };
    assert.equal((await h3.call('GET', '/api/buscar200h?q=1111', undefined, gh2)).status, 200,
      'la sesión de la clave nueva funciona');
    const rotConfig = await h3.call('POST', '/api/guest/config',
      { password: 'clave-rotada-200h', rfcs: [OWN] });
    assert.equal(rotConfig.status, 200);
    const sesionTrasConfig = await h3.call('GET', '/api/buscar200h?q=1111', undefined, gh2);
    assert.equal(sesionTrasConfig.status, 403, 'tras rotar en guest/config, la sesión anterior también muere');
    const login3c = JSON.parse((await h3.raw('POST', '/api/guest/login', { password: 'clave-rotada-200h' })).text);
    assert.ok(login3c.token, 'y entra con la clave rotada en guest/config');
    console.log('OK 2.0·SEG · H-4 rotar clave/alcance (invitado200h y guest/config) purga las sesiones del invitado.');
  } finally { h3.service.close(); rmSync(dir3, { recursive: true, force: true }); }
}
console.log('OK ronda200h — tanda 7B fijada');
