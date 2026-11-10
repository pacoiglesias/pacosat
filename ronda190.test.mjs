import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPacoSATService } from './local-server.mjs';
import { decryptBackupBuffer } from './backup-core.mjs';

/* Ronda 1.9.0 en el servidor: conciliación asistida persistida y
   deshacible, Centro de Avisos por RFC con responsable/fecha/acción,
   declaraciones y acuses archivados como documentos distintos,
   paquete mensual ampliado con las revisiones del barrido y lista
   de cierre calculada en el servidor. Todo con datos de juguete. */
const origin = 'https://pacosat.example.com';
const proxyKey = 'f'.repeat(64);
const OWN = 'XAXX010101000';
let time = Date.parse('2026-11-12T15:00:00Z');
const sent = [];
const DECL_PDF = Buffer.concat([Buffer.from('%PDF-1.4 declaracion de juguete\n'), Buffer.alloc(700, 0x2e)]);
let statementText = '';
const service = createPacoSATService({ dbFile: ':memory:', html: '<!--PACOSAT_TOKEN-->', origin, proxyKey, now: () => time,
  extractText: async () => statementText,
  makeConnector: async () => ({ parser: class {}, connector: {
    request: async () => 'req-190', check: async () => ({ status: 'pending', packages: [] }),
    download: async () => { throw new Error('sin paquetes'); } } }),
  makeMailer: () => ({ verify: async () => true, sendMail: async payload => { sent.push(payload); } }),
  satDeclFetch: async ({ rfc }, query) => {
    assert.equal(rfc, OWN);
    if (query.tipo === 'anual') return { found: 1, warnings: [], documents: [
      { clase: 'declaracion', ejercicio: query.ejercicio, periodo: String(query.ejercicio), fechaPresentacion: '2026-03-28', operacion: 'OP-ANUAL', content: DECL_PDF }] };
    return { found: 1, warnings: [], documents: [
      { clase: 'declaracion', ejercicio: query.ejercicio, periodo: '2026-09', fechaPresentacion: '2026-10-17', operacion: 'OP-100', content: DECL_PDF },
      { clase: 'acuse', ejercicio: query.ejercicio, periodo: '2026-09', fechaPresentacion: '2026-10-17', operacion: 'OP-100', content: DECL_PDF }] };
  } });
let token;
async function call(path, data, target = service) {
  const headers = { host: 'pacosat.example.com', origin, 'x-pacosat-proxy': proxyKey, 'x-pacosat-token': token };
  const req = Object.assign(Readable.from(data === undefined ? [] : [Buffer.from(JSON.stringify(data))]), {
    url: path, method: data === undefined ? 'GET' : 'POST', headers });
  let response;
  const res = { setHeader() {}, writeHead(status) { this.status = status; this.headersSent = true; },
    end(content) { response = new Response(content, { status: this.status }); } };
  await target.handle(req, res);
  return response;
}
const inv = (id, date, from, to, total, method, extra = {}) => ({ id, date, kind: 'I',
  from: { rfc: from, name: 'EMPRESA ' + from }, to: { rfc: to, name: 'EMPRESA ' + to },
  total, currency: 'MXN', fiscal: { paymentMethod: method, paymentForm: extra.form || '', transferred: [], withheld: [] }, ...extra.rest });
const INV1 = '11111111-1111-1111-1111-111111111111'; // PPD recibida 1160, complemento de 500 → saldo 660
const INV2 = '22222222-2222-2222-2222-222222222222'; // PUE emitida 500 con complemento (¡caso Buzón!)
const INV3 = '33333333-3333-3333-3333-333333333333'; // PPD emitida 300 sin pago
const INV4 = '44444444-4444-4444-4444-444444444444'; // PPD recibida con forma 03 (inconsistencia)
const INV5 = '55555555-5555-5555-5555-555555555555'; // PUE recibida con forma 99 (inconsistencia)
const INV6 = '66666666-6666-6666-6666-666666666666'; // Cancelada
const INV7 = '77777777-7777-7777-7777-777777777777'; // PPD recibida 100 (multi)
const INV8 = '88888888-8888-8888-8888-888888888888'; // PPD recibida 50 (multi)
const PAY1 = '99999999-9999-9999-9999-999999999999';
const PAY2 = 'AAAAAAAA-0000-0000-0000-000000000000';
try {
  token = (await (await call('/')).text()).split('content="')[1].split('"')[0];
  assert.equal((await call('/api/mail', { host: 'smtp.example.com', port: 587, user: 'u', password: 'p',
    from: 'from@example.com', recipient: 'avisos@example.com' })).status, 200);
  assert.equal((await call('/api/unlock', { rfc: OWN, minutes: 1440, days: 7, direction: 'received',
    password: 'simulated', certificate: 'YQ==', key: 'Yg==' })).status, 200);
  const pay = (id, date, from, to, total, docs, forma) => ({ id, date, kind: 'P',
    from: { rfc: from, name: 'EMPRESA ' + from }, to: { rfc: to, name: 'EMPRESA ' + to }, total, currency: 'MXN',
    fiscal: { paymentMethod: '', transferred: [], withheld: [], payments: { totalPaid: total,
      pagos: [{ fechaPago: date + 'T12:00:00', monto: total, formaPago: forma, documentos: docs }] } } });
  const seed = [
    inv(INV1, '2026-10-05', 'PROV010101AAA', OWN, '1160.00', 'PPD', { form: '99' }),
    inv(INV2, '2026-10-07', OWN, 'CLIENTE010101AA', '500.00', 'PUE', { form: '01' }),
    inv(INV3, '2026-10-09', OWN, 'CLIENTE010101AA', '300.00', 'PPD', { form: '99' }),
    inv(INV4, '2026-10-10', 'PROV010101AAA', OWN, '200.00', 'PPD', { form: '03' }),
    inv(INV5, '2026-10-10', 'PROV010101AAA', OWN, '80.00', 'PUE', { form: '99' }),
    inv(INV6, '2026-10-11', 'PROV010101AAA', OWN, '100.00', 'PPD', { form: '99', rest: { state: 'Cancelado' } }),
    inv(INV7, '2026-10-11', 'PROV010101AAA', OWN, '100.00', 'PPD', { form: '99' }),
    inv(INV8, '2026-10-12', 'PROV010101AAA', OWN, '50.00', 'PPD', { form: '99' }),
    pay(PAY1, '2026-10-15', 'PROV010101AAA', OWN, '500.00', [{ idDocumento: INV1, impPagado: '500.00' }], '03'),
    pay(PAY2, '2026-10-16', OWN, 'CLIENTE010101AA', '500.00', [{ idDocumento: INV2, impPagado: '500.00' }], '03')
  ];
  assert.equal((await call('/api/storage', { batch: { people: [{ id: OWN, name: 'Cliente Uno' }], invoices: seed } })).status, 200);

  /* --- Bancos: estado de octubre con 4 movimientos --- */
  statementText = ['BBVA MEXICO · ESTADO DE CUENTA', 'Saldo inicial $10,000.00', 'Saldo final $9,445.00',
    'Total de abonos $300.00', 'Total de cargos $855.00',
    '20/10/2026 PAGO SPEI PROVEEDOR $660.00 $9,340.00',
    '21/10/2026 DEPOSITO CLIENTE $300.00 $9,640.00',
    '22/10/2026 COMISION BANCARIA $45.00 $9,595.00',
    '24/10/2026 PAGO SPEI VARIOS $150.00 $9,445.00'].join('\n');
  let data = await (await call('/api/banks/accounts', { bank: 'BBVA', name: 'Maestra', kind: 'cuenta' })).json();
  const account = data.accounts[0];
  const pdf64 = Buffer.from('%PDF-1.7 estado de juguete ' + 'x'.repeat(120)).toString('base64');
  data = await (await call('/api/banks/statements', { accountId: account.id, month: '2026-10', content: pdf64 })).json();
  assert.equal(data.accounts[0].statements[0].movements, 4);

  /* --- Conciliación: propuestas con su porqué --- */
  let rec = await (await call('/api/reconcile')).json();
  assert.equal(rec.counts.movements, 4);
  assert.equal(rec.counts.unmatched, 4);
  const byAmount = amount => rec.suggestions.find(item => item.movement.amount === amount);
  const parcial = byAmount('-660.00');
  assert.ok(parcial, 'propuesta para el pago de 660');
  assert.equal(parcial.candidates[0].mode, 'parcial');
  assert.equal(parcial.candidates[0].invoices[0].uuid, INV1);
  assert.ok(parcial.candidates[0].why.some(reason => /saldo pendiente/.test(reason)), parcial.candidates[0].why.join(' · '));
  const total300 = byAmount('300.00');
  assert.equal(total300.candidates[0].mode, 'total');
  assert.equal(total300.candidates[0].invoices[0].uuid, INV3);
  const multi = byAmount('-150.00');
  assert.equal(multi.candidates[0].mode, 'multiple');
  assert.deepEqual(multi.candidates[0].invoices.map(item => item.uuid).sort(), [INV7, INV8].sort());
  /* Confirmar persiste; deshacer devuelve la propuesta. */
  const movementId = parcial.movement.id;
  rec = await (await call('/api/reconcile/confirm', { movementId, mode: 'parcial',
    why: parcial.candidates[0].why.join(' · '),
    invoices: [{ uuid: INV1, amountCents: 66000 }] })).json();
  assert.equal(rec.counts.matched, 1);
  assert.equal(rec.confirmed[0].estado, 'activo');
  const matchId = rec.confirmed[0].id;
  const movementsView = await (await call('/api/banks/movements')).json();
  assert.equal(movementsView.movements.find(mv => mv.id === movementId).conciliado, true);
  rec = await (await call('/api/reconcile/undo', { matchId })).json();
  assert.equal(rec.counts.matched, 0);
  assert.equal(rec.confirmed[0].estado, 'deshecho', 'deshacer marca, no borra');
  assert.ok(byAmount('-660.00') || rec.suggestions.some(item => item.movement.id === movementId));
  /* Sin factura legítimo: la comisión sale de los sin identificar. */
  const comision = rec.suggestions.length ? null : null;
  const allMovements = movementsView.movements;
  const comisionMv = allMovements.find(mv => mv.amount === '-45.00');
  rec = await (await call('/api/reconcile/ignore', { movementId: comisionMv.id, nota: 'Comisión bancaria' })).json();
  assert.equal(rec.counts.ignored, 1);
  /* Se confirma el parcial otra vez para el paquete mensual. */
  rec = await (await call('/api/reconcile/confirm', { movementId, mode: 'parcial',
    why: 'el importe iguala el saldo pendiente de la factura',
    invoices: [{ uuid: INV1, amountCents: 66000 }] })).json();
  assert.equal(rec.counts.matched, 1);
  void comision;

  /* --- Avisos por RFC con responsable, vence y acción --- */
  await service.tick();
  const notices = await (await call('/api/notices')).json();
  const saldo = notices.avisos.find(aviso => aviso.kind === 'saldo' && aviso.importe === '660.00');
  assert.ok(saldo, 'aviso de saldo de INV1');
  assert.equal(saldo.rfc, OWN, 'el aviso sabe de qué RFC propio es');
  assert.equal(saldo.responsable, 'Paco');
  assert.ok(saldo.vence > 0, 'fecha límite como dato: ' + saldo.vence);
  assert.match(saldo.accion, /Confirmar si ya se pagó/);
  const reassigned = await (await call('/api/notices/responsable', { id: saldo.id, responsable: 'Contadora' })).json();
  assert.equal(reassigned.avisos.find(aviso => aviso.id === saldo.id).responsable, 'Contadora');

  /* --- Declaraciones y acuses: documentos distintos por periodo --- */
  const run = await (await call('/api/declaraciones/run', { rfc: OWN, tipo: 'mensual', ejercicio: 2026 })).json();
  assert.equal(run.result.ok, true);
  assert.equal(run.result.saved, 2);
  let view = run.view;
  const septiembre = view.mensuales.find(item => item.periodo === '2026-09');
  assert.equal(septiembre.estado, 'recuperada');
  assert.equal(septiembre.declaracion, true);
  assert.equal(septiembre.acuse, true);
  assert.equal(view.mensuales.find(item => item.periodo === '2026-08').estado, 'sin-recuperar');
  assert.equal(view.mensuales.find(item => item.periodo === '2026-12').estado, 'aun-no-toca');
  assert.deepEqual(view.documentos.map(doc => doc.clase).sort(), ['acuse', 'declaracion']);
  assert.equal(view.documentos[0].operacion, 'OP-100');
  const runAnual = await (await call('/api/declaraciones/run', { rfc: OWN, tipo: 'anual', ejercicio: 2025 })).json();
  assert.equal(runAnual.result.saved, 1);
  assert.equal(runAnual.view.anual.estado, 'recuperada');

  /* --- Paquete mensual ampliado (se captura el adjunto del correo) --- */
  const before = sent.length;
  const sendNow = await call('/api/reports/send-now', { month: '2026-10' });
  assert.equal(sendNow.status, 200);
  const mail = sent.slice(before).find(item => (item.attachments || []).length);
  assert.ok(mail, 'el paquete salió como adjunto');
  const zipPath = join(mkdtempSync(join(tmpdir(), 'pacosat-190-')), 'paquete.zip');
  writeFileSync(zipPath, mail.attachments[0].content);
  const listing = execFileSync('python3', ['-c',
    'import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); print(chr(10).join(z.namelist()))', zipPath]).toString();
  for (const name of ['complementos-pendientes.csv', 'complementos-del-mes.csv', 'pue-con-complemento.csv',
    'pue-revision.csv', 'inconsistencias-forma.csv', 'cancelaciones.csv', 'conciliaciones.csv',
    'movimientos-sin-identificar.csv', 'faltantes.csv', 'avisos-del-mes.csv', 'correos-del-mes.csv',
    'revision-contadora.txt', 'ppd-del-mes.csv'])
    assert.ok(listing.includes(name), 'el paquete trae ' + name + ' — lista: ' + listing);
  const readEntry = name => execFileSync('python3', ['-c',
    'import zipfile,sys; sys.stdout.write(zipfile.ZipFile(sys.argv[1]).read(sys.argv[2]).decode())', zipPath, name]).toString();
  const pendientes = readEntry('complementos-pendientes.csv');
  assert.ok(pendientes.includes(INV3), 'INV3 pendiente por saldo real');
  assert.ok(pendientes.includes('660.00'), 'INV1 pendiente parcial con su saldo');
  assert.ok(readEntry('pue-con-complemento.csv').includes(INV2), 'el PUE con complemento queda señalado');
  const inconsistencias = readEntry('inconsistencias-forma.csv');
  assert.ok(inconsistencias.includes(INV4) && inconsistencias.includes(INV5), 'PPD sin 99 y PUE con 99');
  assert.ok(readEntry('cancelaciones.csv').includes(INV6));
  assert.ok(readEntry('conciliaciones.csv').includes(INV1), 'la conciliación confirmada viaja en el paquete');
  const sinIdentificar = readEntry('movimientos-sin-identificar.csv');
  assert.ok(!sinIdentificar.includes('COMISION'), 'la comisión marcada no sale como sin identificar');
  assert.ok(readEntry('revision-contadora.txt').includes('día 5 del mes siguiente'));

  /* --- Lista de cierre del servidor --- */
  const checklist = await (await call('/api/reports/checklist?month=2026-10')).json();
  const item = id => checklist.items.find(entry => entry.id === id);
  assert.equal(item('pue').level, 'bad');
  assert.equal(item('complementos').level, 'warn');
  assert.equal(item('conciliacion').level, 'warn');
  assert.equal(item('cancelaciones').level, 'warn');

  /* --- Invitado con alcance por RFC (auditoría de seguridad) --- */
  const guestConfig = await (await call('/api/guest/config', { password: 'invitado-190', enabled: true, rfcs: ['OTRO010101XX1'] })).json();
  assert.deepEqual(guestConfig.rfcs, ['OTRO010101XX1']);
  const adminToken = token;
  const guestLogin = await (await call('/api/guest/login', { password: 'invitado-190' })).json();
  assert.ok(guestLogin.token, 'sesión de invitado emitida');
  token = guestLogin.token;
  const guestInvoices = await (await call('/api/storage?store=invoices')).json();
  assert.equal(guestInvoices.length, 0, 'con alcance a otro RFC, el invitado no ve ni un CFDI de ' + OWN);
  const guestPeople = await (await call('/api/storage?store=people')).json();
  assert.equal(guestPeople.length, 0, 'ni la cartera de contribuyentes');
  const guestMoney = await (await call('/api/money')).json();
  assert.equal(guestMoney.balances.length, 0, 'ni los saldos');
  const guestNotices = await (await call('/api/notices')).json();
  assert.equal(guestNotices.counts.total, 0, 'ni los avisos de otro RFC');
  assert.equal((await call('/api/banks')).status, 403, 'con alcance, Bancos queda fuera');
  assert.equal((await call('/api/storage', { batch: {} })).status, 403, 'y sigue sin poder escribir');
  token = adminToken;
  await call('/api/guest/config', { rfcs: [OWN] });
  token = guestLogin.token;
  const ownInvoices = await (await call('/api/storage?store=invoices')).json();
  assert.ok(ownInvoices.length >= 8, 'con su RFC en el alcance, el invitado sí ve el expediente: ' + ownInvoices.length);
  const ownMoney = await (await call('/api/money')).json();
  assert.ok(ownMoney.balances.length > 0, 'y los saldos de su RFC');
  token = adminToken;
  await call('/api/guest/config', { rfcs: [] });
  for (let i = 0; i < 8; i++) await call('/api/guest/login', { password: 'incorrecta-' + i });
  assert.equal((await call('/api/guest/login', { password: 'invitado-190' })).status, 429,
    'tras 8 fallos, el login de invitado se frena');

  /* --- Marcar como pagado directo (visor de comprobantes) --- */
  const moneyBefore = await (await call('/api/money')).json();
  assert.ok(moneyBefore.balances.some(item => item.id === INV3 && item.balance === '300.00'),
    'INV3 con saldo vivo antes de marcar');
  const marked = await (await call('/api/money/mark-paid', { uuid: INV3, nota: 'Pagado por transferencia' })).json();
  assert.equal(marked.ok, true);
  assert.equal(marked.balance, '0.00');
  const moneyAfter = await (await call('/api/money')).json();
  assert.ok(!moneyAfter.balances.some(item => item.id === INV3 && item.balance !== '0.00'),
    'INV3 sin saldo tras marcar pagado');
  const markedAgain = await call('/api/money/mark-paid', { uuid: INV3 });
  assert.equal(markedAgain.status, 400, 'marcar dos veces el mismo saldo se rechaza');

  /* --- Respaldo con bancos y avisos + restauración REAL ---
     Se genera el .faro cifrado de verdad (backupTick), se descifra
     y su sección de estado operativo se restaura en un servicio
     vacío: bancos, movimientos, conciliación, avisos y
     declaraciones tienen que estar al otro lado. */
  const bakDir = mkdtempSync(join(tmpdir(), 'pacosat-190-bak-'));
  await service.bootstrap({ backup: { password: 'respaldo-prueba-190', frequency: 'daily',
    dir: join(bakDir, 'principal'), secondaryDir: join(bakDir, 'secundario') } });
  await service.backupTick(time);
  const faroFiles = readdirSync(join(bakDir, 'principal')).filter(name => name.endsWith('.faro'));
  assert.equal(faroFiles.length, 1);
  const bakData = decryptBackupBuffer(readFileSync(join(bakDir, 'principal', faroFiles[0])), 'respaldo-prueba-190');
  const operations = bakData.operations;
  assert.ok(operations.bank_accounts.length === 1, 'el respaldo ya incluye bancos');
  assert.ok(operations.bank_movements.length === 4);
  assert.ok(operations.bank_matches.length >= 1, 'y las conciliaciones');
  assert.ok(operations.avisos.length >= 1, 'y los avisos');
  assert.ok(operations.declaraciones.length >= 3, 'y las declaraciones');
  const service2 = createPacoSATService({ dbFile: ':memory:', html: '<!--PACOSAT_TOKEN-->', origin, proxyKey, now: () => time,
    makeMailer: () => ({ verify: async () => true, sendMail: async () => {} }) });
  try {
    token = (await (await call('/', undefined, service2)).text()).split('content="')[1].split('"')[0];
    const restored = await (await call('/api/backup/operations', operations, service2)).json();
    assert.equal(restored.ok, true);
    const banks2 = await (await call('/api/banks', undefined, service2)).json();
    assert.equal(banks2.accounts.length, 1);
    assert.equal(banks2.accounts[0].statements[0].movements, 4);
    const rec2 = await (await call('/api/reconcile', undefined, service2)).json();
    assert.equal(rec2.counts.matched, 1, 'la conciliación confirmada sobrevive a la restauración');
    const notices2 = await (await call('/api/notices', undefined, service2)).json();
    assert.ok(notices2.avisos.some(aviso => aviso.kind === 'saldo'), 'los avisos sobreviven a la restauración');
  } finally { await service2.close(); }

  console.log('ronda190.test: ok — conciliación asistida con porqué y deshacer, avisos por RFC ' +
    'con responsable, declaraciones/acuses por periodo, paquete mensual del barrido, checklist ' +
    'en servidor y respaldo con bancos+avisos restaurado de verdad.');
} finally { await service.close(); }
