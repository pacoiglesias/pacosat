/* ================================================================
   Ronda 2.0 · Tanda 6 — BANCOS
   (a) Estado con cuenta y periodo impresos ⇒ detección correcta
       y, tras Aplicar, movimientos en su cuenta y estado
       archivado; reaplicar no duplica; Deshacer lo retira.
   (b) Cuenta enmascarada ⇒ detección por dígitos visibles;
       cuenta no dada de alta ⇒ 409 sin aplicar, precarga del
       alta, y tras el alta el mismo estado se aplica.
   (c) Día 5 sin estado del mes anterior ⇒ pendiente en el estado
       servido (Hoy) y en Salud; se apaga al aplicar. Día 12 ⇒
       UN solo correo de recordatorio, no dos.
   (d) Conciliación por cuenta: factura «sin pago visto en esta
       cuenta», pago sin factura con sugerencia única; enlazar
       saca a ambos de sus listas y el enlace se ve en el CFDI;
       desenlazar lo revierte.
   (e) F3: «Ya se pagó» con candidato único ⇒ lo sugiere y enlaza.
   (f) Contrapartes: totales por empresa = suma de sus CFDI y
       orden por total descendente. Fondo: su saldo es la
       valuación del estado, sin movimientos.
   ================================================================ */
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPacoSATService } from './local-server.mjs';

const ORIGIN = 'https://pacosat.test';
const KEY = 'f'.repeat(64);
const OWN = 'MFI6212158B4';
const PROV1 = 'AAA010101AAA';
const PROV2 = 'BBB010101BB2';
const CLI1 = 'CCC010101CC3';
const CLABE = '012180001234567590';
const pdf64 = Buffer.from('%PDF-1.7 estado de juguete ' + 'x'.repeat(120)).toString('base64');

function makeHarness(extra = {}) {
  let time = Date.parse('2026-11-05T15:00:00Z'); /* día 5 en MX */
  let token = '';
  let currentText = '';
  const mails = [];
  const service = createPacoSATService({
    dbFile: ':memory:', html: '<html><head><!--PACOSAT_TOKEN--></head><body>prueba</body></html>',
    origin: ORIGIN, proxyKey: KEY, now: () => time,
    extractText: async () => currentText,
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
  const call = async (method, path, body) => {
    if (!token) { const home = await raw('GET', '/'); token = /[0-9a-f]{64}/.exec(home.text)?.[0] || ''; }
    const r = await raw(method, path, body, { 'x-pacosat-token': token });
    let json = null; try { json = JSON.parse(r.text); } catch { /* binario */ }
    return { status: r.status, json, text: r.text };
  };
  return { service, call, mails,
    set time(v) { time = v; }, get time() { return time; },
    set text(v) { currentText = v; }, get text() { return currentText; } };
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
const invoice = (id, date, from, to, total) => ({ id, date, kind: 'I',
  from: { rfc: from, name: 'EMPRESA ' + from }, to: { rfc: to, name: 'EMPRESA ' + to },
  total, currency: 'MXN', fiscal: { paymentMethod: 'PPD', transferred: [], withheld: [] } });

const TXT_BBVA_OCT = ['BBVA MEXICO · ESTADO DE CUENTA', 'Cuenta ' + CLABE,
  'Periodo del 01/10/2026 al 31/10/2026', 'Saldo inicial $10,000.00', 'Saldo final $8,840.00',
  'Total de abonos $0.00', 'Total de cargos $1,160.00',
  '05/10/2026 PAGO PROVEEDOR UNO $1,160.00 $8,840.00'].join('\n');

/* ===== (a) Detección segura + aplicar + dedupe + Deshacer ===== */
{
  const h = makeHarness();
  try {
    await base(h);
    const alta = await h.call('POST', '/api/banks/accounts',
      { bank: 'BBVA', name: 'Chequera', kind: 'cuenta', numero: CLABE, rfc: OWN });
    assert.equal(alta.status, 200);
    const account = alta.json.accounts[0];
    assert.equal(account.last4, '7590', 'la terminación sale del número completo');
    h.text = TXT_BBVA_OCT;
    const det = await h.call('POST', '/api/banks/detect', { content: pdf64 });
    assert.equal(det.json.deteccion.banco, 'BBVA', 'banco detectado de lo impreso');
    assert.equal(det.json.deteccion.accountId, account.id, 'cuenta detectada por CLABE entera');
    assert.equal(det.json.deteccion.segura, true);
    assert.equal(det.json.deteccion.periodo, '2026-10', 'periodo detectado del propio estado');
    assert.equal(det.json.deteccion.movimientos, 1, 'nº de movimientos detectado');
    assert.equal(det.json.deteccion.saldoFinal, '8840.00', 'saldo final que el estado declara');
    const ap = await h.call('POST', '/api/banks/statements/auto', { content: pdf64 });
    assert.equal(ap.status, 200);
    assert.equal(ap.json.aplicada, true);
    assert.equal(ap.json.aplicados, 1);
    let movs = (await h.call('GET', '/api/banks/movements')).json.movements;
    assert.equal(movs.length, 1, 'el movimiento quedó aplicado en su cuenta');
    assert.equal(movs[0].accountId, account.id);
    assert.equal(movs[0].amount, '-1160.00');
    const banks = (await h.call('GET', '/api/banks')).json;
    const stmt = banks.accounts[0].statements.find(s => s.month === '2026-10');
    assert.ok(stmt, 'el estado quedó archivado en su cuenta');
    assert.equal(stmt.closing, '8840.00');
    /* Reaplicar el MISMO estado: ni un movimiento duplicado. */
    const ap2 = await h.call('POST', '/api/banks/statements/auto', { content: pdf64 });
    assert.equal(ap2.json.aplicada, true);
    movs = (await h.call('GET', '/api/banks/movements')).json.movements;
    assert.equal(movs.length, 1, 'reaplicar no duplica movimientos');
    /* Solape con el estado de noviembre (misma línea): dedupe
       entre estados de la misma cuenta. */
    h.text = ['BBVA MEXICO · ESTADO DE CUENTA', 'Cuenta ' + CLABE,
      'Saldo inicial $8,840.00', 'Saldo final $8,840.00',
      '05/10/2026 PAGO PROVEEDOR UNO $1,160.00 $8,840.00'].join('\n');
    const ap3 = await h.call('POST', '/api/banks/statements/auto',
      { content: pdf64, accountId: account.id, month: '2026-11' });
    assert.equal(ap3.json.duplicadosOmitidos, 1, 'el movimiento solapado se omite por duplicado');
    movs = (await h.call('GET', '/api/banks/movements')).json.movements;
    assert.equal(movs.length, 1, 'sigue habiendo un solo movimiento');
    /* Deshacer: retira el estado de octubre y sus movimientos. */
    const del = await h.call('POST', '/api/banks/statements/delete', { id: ap.json.statementId });
    assert.equal(del.status, 200);
    movs = (await h.call('GET', '/api/banks/movements')).json.movements;
    assert.equal(movs.length, 0, 'Deshacer retiró los movimientos aplicados');
    const registro = (await h.call('GET', '/api/registro')).json;
    assert.ok(JSON.stringify(registro).includes('Estado de cuenta aplicado'), 'la aplicación quedó en el Registro');
    assert.ok(JSON.stringify(registro).includes('Deshacer de la subida'), 'y su Deshacer también');
    console.log('OK 2.0·T6 · (a) detección segura, aplicación, dedupe y Deshacer.');
  } finally { h.service.close(); }
}

/* ===== (b) Enmascarada + cuenta no dada de alta ===== */
{
  const h = makeHarness();
  try {
    await base(h);
    const alta = await h.call('POST', '/api/banks/accounts',
      { bank: 'Santander', name: 'Cheques', kind: 'cuenta', last4: '4321', rfc: OWN });
    const santander = alta.json.accounts[0];
    h.text = ['SANTANDER MEXICO · ESTADO DE CUENTA', 'Cuenta ****4321',
      'Periodo del 01/10/2026 al 31/10/2026', 'Saldo inicial $1,000.00', 'Saldo final $1,500.00',
      'Total de abonos $500.00', 'Total de cargos $0.00',
      '10/10/2026 DEPOSITO SPEI RECIBIDO $500.00 $1,500.00'].join('\n');
    const det = await h.call('POST', '/api/banks/detect', { content: pdf64 });
    assert.equal(det.json.deteccion.accountId, santander.id,
      'cuenta enmascarada: la detección cruza por los dígitos visibles');
    assert.match(det.json.deteccion.via, /dígitos visibles|terminación/);
    /* Cuenta NO dada de alta: nada se aplica; la precarga trae
       lo detectado para el alta en el acto. */
    h.text = ['BBVA MEXICO · ESTADO DE CUENTA', 'Cuenta 032180009999888777',
      'Periodo del 01/10/2026 al 31/10/2026', 'Saldo inicial $100.00', 'Saldo final $100.00'].join('\n');
    const det2 = await h.call('POST', '/api/banks/detect', { content: pdf64 });
    assert.equal(det2.json.deteccion.segura, false);
    assert.equal(det2.json.deteccion.accountId, null);
    assert.equal(det2.json.deteccion.precarga.numero, '032180009999888777', 'precarga: el número detectado');
    assert.equal(det2.json.deteccion.precarga.bank, 'BBVA', 'precarga: el banco detectado');
    const intento = await h.call('POST', '/api/banks/statements/auto', { content: pdf64 });
    assert.equal(intento.status, 409, 'sin cuenta señalada no se aplica nada');
    assert.equal(intento.json.aplicada, false);
    let banks = (await h.call('GET', '/api/banks')).json;
    assert.equal(banks.accounts.reduce((n, a) => n + a.statements.length, 0), 0,
      'ningún estado se archivó en el intento');
    const alta2 = await h.call('POST', '/api/banks/accounts',
      { bank: det2.json.deteccion.precarga.bank, name: 'Nueva', numero: det2.json.deteccion.precarga.numero, rfc: OWN });
    const nueva = alta2.json.accounts.find(a => a.name === 'Nueva');
    const ap = await h.call('POST', '/api/banks/statements/auto',
      { content: pdf64, accountId: nueva.id });
    assert.equal(ap.json.aplicada, true, 'tras el alta, el mismo estado se aplica');
    assert.equal(ap.json.deteccion.periodo, '2026-10');
    console.log('OK 2.0·T6 · (b) enmascarada por dígitos visibles; no dada de alta ⇒ precarga sin aplicar.');
  } finally { h.service.close(); }
}

/* ===== (c) Pendientes días 1–10 + correo único a día 10+ ===== */
{
  const h = makeHarness();
  try {
    await base(h);
    const alta = await h.call('POST', '/api/banks/accounts',
      { bank: 'BBVA', name: 'Chequera', kind: 'cuenta', numero: CLABE, rfc: OWN });
    const account = alta.json.accounts[0];
    /* Día 5: el pendiente vive en el estado servido y en Salud. */
    let st = (await h.call('GET', '/api/status')).json;
    assert.equal(st.estadosPendientes.enVentana, true, 'día 5: dentro de la ventana 1–10');
    assert.equal(st.estadosPendientes.mesAnterior, '2026-10');
    assert.ok(st.estadosPendientes.faltantes.some(f => f.accountId === account.id),
      'el pendiente de la cuenta consta en el estado de Hoy');
    let salud = (await h.call('GET', '/api/salud')).json;
    const tarjeta = salud.tarjetas.find(t => t.id === 'pendientes-mes');
    assert.ok(tarjeta, 'Salud trae la tarjeta «Pendientes del mes»');
    assert.equal(tarjeta.datos.faltantes.length, 1);
    /* Entra el estado ⇒ el pendiente se apaga solo. */
    h.text = TXT_BBVA_OCT;
    const ap = await h.call('POST', '/api/banks/statements/auto', { content: pdf64 });
    assert.equal(ap.json.aplicada, true);
    st = (await h.call('GET', '/api/status')).json;
    assert.equal(st.estadosPendientes.faltantes.length, 0, 'con el estado dentro, el pendiente se apaga');
    salud = (await h.call('GET', '/api/salud')).json;
    assert.equal(salud.tarjetas.find(t => t.id === 'pendientes-mes').estado, 'bien');
    console.log('OK 2.0·T6 · (c1) pendiente día 5 en Hoy y Salud; se apaga al aplicar.');
  } finally { h.service.close(); }
}
{
  const h = makeHarness();
  try {
    await base(h);
    await h.call('POST', '/api/banks/accounts',
      { bank: 'BBVA', name: 'Chequera', kind: 'cuenta', numero: CLABE, rfc: OWN });
    h.time = Date.parse('2026-11-12T15:00:00Z'); /* día 12: ya pasó el 10 */
    await h.service.tick();
    const recordatorios = () => h.mails.filter(m => String(m.subject || '').includes('Faltan estados de cuenta'));
    assert.equal(recordatorios().length, 1, 'a día 12 sin estado: UN correo de recordatorio');
    assert.ok(recordatorios()[0].text.includes('Chequera'), 'el correo nombra la cuenta que falta');
    await h.service.tick();
    await h.service.tick();
    assert.equal(recordatorios().length, 1, 'ni dos: el recordatorio es único por mes');
    console.log('OK 2.0·T6 · (c2) día 12 — un solo correo de recordatorio por mes.');
  } finally { h.service.close(); }
}

/* ===== (d)+(e)+(f) Conciliación, F3 y contrapartes ===== */
const F1 = '11111111-1111-4111-8111-111111111111';
const F2 = '22222222-2222-4222-8222-222222222222';
const E1 = '33333333-3333-4333-8333-333333333333';
{
  const h = makeHarness();
  try {
    await base(h);
    const seed = await h.call('POST', '/api/storage', { batch: { invoices: [
      invoice(F1, '2026-10-03', PROV1, OWN, '1160.00'),
      invoice(F2, '2026-10-04', PROV2, OWN, '2320.00'),
      invoice(E1, '2026-09-01', OWN, CLI1, '5000.00')] } });
    assert.equal(seed.status, 200);
    const alta = await h.call('POST', '/api/banks/accounts',
      { bank: 'BBVA', name: 'Chequera', kind: 'cuenta', numero: CLABE, rfc: OWN });
    const account = alta.json.accounts[0];
    h.text = ['BBVA MEXICO · ESTADO DE CUENTA', 'Cuenta ' + CLABE,
      'Periodo del 01/10/2026 al 31/10/2026', 'Saldo inicial $10,000.00', 'Saldo final $6,320.00',
      'Total de abonos $0.00', 'Total de cargos $3,680.00',
      '05/10/2026 PAGO PROVEEDOR UNO $1,160.00 $8,840.00',
      '07/10/2026 PAGO COMISION BANCARIA $500.00 $8,340.00',
      '20/10/2026 PAGO PROVEEDOR DOS $2,320.00 $6,020.00'].join('\n');
    /* Ojo: el tercer movimiento casa con F2 en importe pero su
       fecha (20 oct) está a +16 días de la factura: entra en la
       ventana de sugerencia de F3 (±45 días) y NO debe quitar a
       F2 de «sin pago visto» hasta enlazarse — primero se prueba
       (d) con los dos primeros movimientos vía un estado parcial:
       para aislar (d), el estado de (d) trae solo M1 y M2. */
    h.text = ['BBVA MEXICO · ESTADO DE CUENTA', 'Cuenta ' + CLABE,
      'Periodo del 01/10/2026 al 31/10/2026', 'Saldo inicial $10,000.00', 'Saldo final $8,340.00',
      'Total de abonos $0.00', 'Total de cargos $1,660.00',
      '05/10/2026 PAGO PROVEEDOR UNO $1,160.00 $8,840.00',
      '07/10/2026 PAGO COMISION BANCARIA $500.00 $8,340.00'].join('\n');
    const ap = await h.call('POST', '/api/banks/statements/auto', { content: pdf64 });
    assert.equal(ap.json.aplicados, 2);
    let vista = (await h.call('GET', '/api/banks/conciliacion?month=2026-10')).json;
    let mia = vista.porCuenta.find(v => v.account.id === account.id);
    assert.equal(mia.frase, 'sin pago visto en esta cuenta', 'la frase exacta, por cuenta');
    assert.ok(mia.facturasSinPagoVisto.some(i => i.uuid === F2),
      '(d) la factura sin movimiento consta «sin pago visto en esta cuenta»');
    const pagoSin = mia.pagosSinFactura.find(p => p.movement.amount === '-500.00');
    assert.ok(pagoSin, '(d) el movimiento sin CFDI consta como pago sin factura');
    assert.equal(pagoSin.sugerencia, null, 'sin candidata por importe: ninguna sugerencia inventada');
    const pagoUno = mia.pagosSinFactura.find(p => p.movement.amount === '-1160.00');
    assert.ok(pagoUno && pagoUno.sugerencia && pagoUno.sugerencia.uuid === F1,
      '(d) el pago de 1,160 trae su pareja sugerida única (la factura F1)');
    /* Enlazar en un toque ⇒ ambos salen de sus listas y el
       enlace se ve desde el CFDI (en «enlazados»). */
    const link = await h.call('POST', '/api/banks/conciliar/link',
      { movementId: pagoUno.movement.id, uuid: F1, month: '2026-10' });
    assert.equal(link.status, 200);
    mia = link.json.conciliacion.porCuenta.find(v => v.account.id === account.id);
    assert.ok(!mia.facturasSinPagoVisto.some(i => i.uuid === F1), 'enlazada: la factura sale de su lista');
    assert.ok(!mia.pagosSinFactura.some(p => p.movement.id === pagoUno.movement.id),
      'enlazado: el movimiento sale de su lista');
    assert.ok(mia.enlazados.some(l => l.uuid === F1 && l.movement && l.movement.amount === '-1160.00'),
      'el enlace se ve en el CFDI, con su movimiento');
    /* Desenlazar lo revierte. */
    const matchId = mia.enlazados.find(l => l.uuid === F1).matchId;
    const un = await h.call('POST', '/api/banks/conciliar/unlink', { matchId, month: '2026-10' });
    mia = un.json.conciliacion.porCuenta.find(v => v.account.id === account.id);
    assert.ok(mia.facturasSinPagoVisto.some(i => i.uuid === F1), 'desenlazar devuelve la factura a su lista');
    assert.ok(mia.pagosSinFactura.some(p => p.movement.id === pagoUno.movement.id),
      'desenlazar devuelve el movimiento a su lista');
    console.log('OK 2.0·T6 · (d) conciliación por cuenta — sin pago visto / pago sin factura, enlace y Deshacer.');

    /* (e) F3: sin movimiento de 2,320 no hay candidato; con uno
       único cercano, «Ya se pagó» lo sugiere y lo enlaza. */
    let sug = (await h.call('GET', '/api/banks/sugerencia-pago?uuid=' + F2)).json;
    assert.equal(sug.candidato, null, '(e) sin movimiento que case: ningún candidato inventado');
    h.text = ['BBVA MEXICO · ESTADO DE CUENTA', 'Cuenta ' + CLABE,
      'Periodo del 01/11/2026 al 30/11/2026', 'Saldo inicial $8,340.00', 'Saldo final $6,020.00',
      'Total de abonos $0.00', 'Total de cargos $2,320.00',
      '02/11/2026 PAGO PROVEEDOR DOS $2,320.00 $6,020.00'].join('\n');
    const apNov = await h.call('POST', '/api/banks/statements/auto',
      { content: pdf64, accountId: account.id, month: '2026-11' });
    assert.equal(apNov.json.aplicados, 1);
    sug = (await h.call('GET', '/api/banks/sugerencia-pago?uuid=' + F2)).json;
    assert.ok(sug.candidato, '(e) con un movimiento único que casa: se sugiere');
    assert.equal(sug.candidato.amount, '-2320.00');
    assert.equal(sug.candidato.banco, 'BBVA');
    const marcado = await h.call('POST', '/api/banks/marcar-pagado',
      { uuid: F2, movementId: sug.candidato.movementId });
    assert.equal(marcado.json.enlazado, true, '(e) un toque enlaza ambos');
    vista = (await h.call('GET', '/api/banks/conciliacion?month=2026-10')).json;
    mia = vista.porCuenta.find(v => v.account.id === account.id);
    assert.ok(!mia.facturasSinPagoVisto.some(i => i.uuid === F2),
      '(e) tras enlazar, F2 ya no consta sin pago visto');
    assert.ok(mia.enlazados.some(l => l.uuid === F2), '(e) el enlace se ve en el CFDI');
    console.log('OK 2.0·T6 · (e) F3 — «Ya se pagó» sugiere el movimiento único y lo enlaza.');

    /* (f) Contrapartes: totales = suma de sus CFDI, orden por total. */
    const cps = (await h.call('GET', '/api/banks/contrapartes?rfc=' + OWN + '&periodo=todo')).json;
    assert.equal(cps.contrapartes.length, 3);
    assert.equal(cps.contrapartes[0].rfc, CLI1, 'orden por total: el cliente de 5,000 va primero');
    assert.equal(cps.contrapartes[0].totalEmitido, '5000.00');
    assert.equal(cps.contrapartes[0].totalRecibido, '0.00');
    const p2 = cps.contrapartes.find(c => c.rfc === PROV2);
    assert.equal(p2.totalRecibido, '2320.00', 'el total de PROV2 es la suma de sus CFDI');
    assert.equal(p2.comprobantes, 1);
    assert.equal(p2.ultima, '2026-10-04');
    const p1 = cps.contrapartes.find(c => c.rfc === PROV1);
    assert.equal(p1.totalRecibido, '1160.00');
    assert.ok(p2.uuids.includes(F2) && p1.uuids.includes(F1),
      'cada total lleva sus CFDI detrás');
    console.log('OK 2.0·T6 · (f) contrapartes — totales cuadrados con sus CFDI y orden por total.');
  } finally { h.service.close(); }
}

/* ===== Fondo de inversión: el saldo es la valuación ===== */
{
  const h = makeHarness();
  try {
    await base(h);
    const alta = await h.call('POST', '/api/banks/accounts',
      { bank: 'BBVA', name: 'Fondo de inversión', kind: 'fondo', rfc: OWN });
    const fondo = alta.json.accounts[0];
    h.text = ['BBVA MEXICO · FONDO DE INVERSION', 'Saldo inicial $50,000.00', 'Saldo final $51,250.00',
      'Total de abonos $1,250.00', 'Total de cargos $0.00'].join('\n');
    const ap = await h.call('POST', '/api/banks/statements/auto',
      { content: pdf64, accountId: fondo.id, month: '2026-10' });
    assert.equal(ap.json.aplicada, true, 'el fondo se aplica sin movimientos');
    assert.equal(ap.json.aplicados, 0);
    const banks = (await h.call('GET', '/api/banks')).json;
    const mia = banks.accounts.find(a => a.id === fondo.id);
    assert.equal(mia.kind, 'fondo');
    assert.equal(mia.position.closing, '51250.00', 'su posición es la valuación que el estado declara');
    assert.equal(mia.statements[0].state, 'ok');
    console.log('OK 2.0·T6 · fondo — saldo por valuación del estado, sin movimientos.');
  } finally { h.service.close(); }
}

/* ===== Cliente diferido: las piezas viven en banks-ui.part ===== */
{
  const part = readFileSync(join(process.cwd(), 'banks-ui.part'), 'utf8');
  for (const texto of ['Subir estado de cuenta', 'bancosAutoPanel200f', 'bancosConciliacionPanel200f',
    'bancosContrapartesPanel200f', 'sin pago visto en esta cuenta', 'capture'])
    assert.ok(part.includes(texto), 'la parte diferida de Bancos trae «' + texto + '»');
  const html = readFileSync(join(process.cwd(), 'Faro-Fiscal.html'), 'utf8');
  assert.ok(html.includes('"version":"2.0.1"'), 'la versión es la vigente 2.0.1 (las tandas no la tocaron; la subió la ronda 2.0.1 de motores)');
  console.log('OK 2.0·T6 · cliente — botón único y vistas en la parte diferida; versión intacta.');
}
/* ===== H-2 (corrección de seguridad 2.0): el candado de
   ejercicio cerrado cubre Bancos y Reconcile ===== */
{
  const I26 = '11111111-1111-4111-8111-111111111111';
  const I26B = '22222222-2222-4222-8222-222222222222';
  const I26C = '33333333-3333-4333-8333-333333333333';
  const I26D = '44444444-4444-4444-8444-444444444444';
  const I27 = '55555555-5555-4555-8555-555555555555';
  const I27B = '66666666-6666-4666-8666-666666666666';
  const I27C = '77777777-7777-4777-8777-777777777777';
  const h = makeHarness();
  try {
    await base(h);
    const seed = await h.call('POST', '/api/storage', { batch: { invoices: [
      invoice(I26, '2026-10-03', PROV1, OWN, '1160.00'),
      invoice(I26B, '2026-10-04', PROV1, OWN, '500.00'),
      invoice(I26C, '2026-10-08', PROV1, OWN, '300.00'),
      invoice(I26D, '2026-10-10', PROV1, OWN, '200.00'),
      invoice(I27, '2027-01-15', PROV1, OWN, '1160.00'),
      invoice(I27B, '2027-01-20', PROV1, OWN, '400.00'),
      invoice(I27C, '2027-02-01', PROV1, OWN, '250.00')] } });
    assert.equal(seed.status, 200);
    const alta = await h.call('POST', '/api/banks/accounts',
      { bank: 'BBVA', name: 'Chequera', kind: 'cuenta', numero: CLABE, rfc: OWN });
    const account = alta.json.accounts[0];
    h.text = ['BBVA MEXICO · ESTADO DE CUENTA', 'Cuenta ' + CLABE,
      'Periodo del 01/10/2026 al 31/10/2026', 'Saldo inicial $10,000.00', 'Saldo final $7,840.00',
      'Total de abonos $0.00', 'Total de cargos $2,160.00',
      '05/10/2026 PAGO PROVEEDOR UNO $1,160.00 $8,840.00',
      '07/10/2026 PAGO EXTRA B $500.00 $8,340.00',
      '09/10/2026 PAGO EXTRA C $300.00 $8,040.00',
      '10/10/2026 PAGO EXTRA D $200.00 $7,840.00'].join('\n');
    const apOct = await h.call('POST', '/api/banks/statements/auto', { content: pdf64 });
    assert.equal(apOct.json.aplicados, 4, 'estado de octubre 2026 aplicado');
    h.text = ['BBVA MEXICO · ESTADO DE CUENTA', 'Cuenta ' + CLABE,
      'Periodo del 01/01/2027 al 31/01/2027', 'Saldo inicial $7,840.00', 'Saldo final $6,280.00',
      'Total de abonos $0.00', 'Total de cargos $1,560.00',
      '15/01/2027 PAGO PROVEEDOR UNO $1,160.00 $6,680.00',
      '20/01/2027 PAGO EXTRA E $400.00 $6,280.00'].join('\n');
    const apEne = await h.call('POST', '/api/banks/statements/auto',
      { content: pdf64, accountId: account.id, month: '2027-01' });
    assert.equal(apEne.json.aplicados, 2, 'estado de enero 2027 aplicado');
    const movs = (await h.call('GET', '/api/banks/movements')).json.movements;
    const mov = (fecha, importe) => movs.find(m => m.date === fecha && m.amount === importe);
    const M26 = mov('2026-10-05', '-1160.00'), M26B = mov('2026-10-07', '-500.00'),
      M26C = mov('2026-10-09', '-300.00'), M26D = mov('2026-10-10', '-200.00'),
      M27 = mov('2027-01-15', '-1160.00'), M27B = mov('2027-01-20', '-400.00');
    assert.ok(M26 && M26B && M26C && M26D && M27 && M27B, 'los seis movimientos constan');
    /* Vínculos ACTIVOS de 2026 creados ANTES de cerrar: son los
       que unlink/undo intentarán deshacer ya con el candado. */
    const linkB = await h.call('POST', '/api/banks/conciliar/link',
      { movementId: M26B.id, uuid: I26B, month: '2026-10' });
    assert.equal(linkB.status, 200); const matchLinkB = linkB.json.matchId;
    const recC = await h.call('POST', '/api/reconcile/confirm',
      { movementId: M26C.id, invoices: [{ uuid: I26C, amountCents: 30000 }], mode: 'manual' });
    assert.equal(recC.status, 200);
    const concOct = (await h.call('GET', '/api/banks/conciliacion?month=2026-10')).json;
    const matchRecC = concOct.porCuenta.flatMap(v => v.enlazados).find(l => l.uuid === I26C)?.matchId;
    assert.ok(matchRecC, 'el vínculo de reconcile/confirm consta enlazado');
    /* Se cierra el ejercicio 2026. */
    const cierre = await h.call('POST', '/api/ejercicios200g/cerrar', { rfc: OWN, year: '2026' });
    assert.equal(cierre.status, 200, 'ejercicio 2026 cerrado');
    const bloqueado = (res, que) => {
      assert.equal(res.status, 409, que + ': 409 con el ejercicio cerrado — ' + res.status + ' ' + JSON.stringify(res.json));
      assert.match(res.json.error || '', /Ejercicio 2026 cerrado/);
    };
    bloqueado(await h.call('POST', '/api/banks/statements/confirm',
      { id: apOct.json.statementId, opening: '10000.00', closing: '7840.00' }), 'statements/confirm');
    bloqueado(await h.call('POST', '/api/banks/conciliar/link',
      { movementId: M26.id, uuid: I26, month: '2026-10' }), 'conciliar/link');
    bloqueado(await h.call('POST', '/api/banks/conciliar/unlink',
      { matchId: matchLinkB, month: '2026-10' }), 'conciliar/unlink');
    bloqueado(await h.call('POST', '/api/banks/marcar-pagado',
      { uuid: I26D, movementId: M26D.id }), 'marcar-pagado con movimiento');
    bloqueado(await h.call('POST', '/api/banks/marcar-pagado',
      { uuid: I26 }), 'marcar-pagado sin movimiento');
    bloqueado(await h.call('POST', '/api/reconcile/confirm',
      { movementId: M26.id, invoices: [{ uuid: I26, amountCents: 116000 }], mode: 'manual' }), 'reconcile/confirm');
    bloqueado(await h.call('POST', '/api/reconcile/undo', { matchId: matchRecC }), 'reconcile/undo');
    bloqueado(await h.call('POST', '/api/reconcile/ignore',
      { movementId: M26.id, nota: 'sin factura' }), 'reconcile/ignore');
    bloqueado(await h.call('POST', '/api/banks/accounts', { delete: account.id }),
      'borrar cuenta con estados aplicados de 2026');
    const sigue = (await h.call('GET', '/api/banks')).json;
    assert.ok(sigue.accounts.some(a => a.id === account.id), 'la cuenta NO se borró');
    console.log('OK 2.0·SEG · H-2 Bancos/Reconcile — 409 en año cerrado en confirm/link/unlink/marcar-pagado/confirm/undo/ignore y en el borrado de cuenta.');
    /* Año abierto (2027): las mismas rutas pasan. */
    const confOk = await h.call('POST', '/api/banks/statements/confirm',
      { id: apEne.json.statementId, opening: '7840.00', closing: '6280.00' });
    assert.equal(confOk.status, 200, 'statements/confirm en año abierto');
    const linkOk = await h.call('POST', '/api/banks/conciliar/link',
      { movementId: M27.id, uuid: I27, month: '2027-01' });
    assert.equal(linkOk.status, 200, 'conciliar/link en año abierto');
    const unlinkOk = await h.call('POST', '/api/banks/conciliar/unlink',
      { matchId: linkOk.json.matchId, month: '2027-01' });
    assert.equal(unlinkOk.status, 200, 'conciliar/unlink en año abierto');
    const recOk = await h.call('POST', '/api/reconcile/confirm',
      { movementId: M27B.id, invoices: [{ uuid: I27B, amountCents: 40000 }], mode: 'manual' });
    assert.equal(recOk.status, 200, 'reconcile/confirm en año abierto');
    const concEne = (await h.call('GET', '/api/banks/conciliacion?month=2027-01')).json;
    const matchRec27 = concEne.porCuenta.flatMap(v => v.enlazados).find(l => l.uuid === I27B)?.matchId;
    assert.ok(matchRec27);
    const undoOk = await h.call('POST', '/api/reconcile/undo', { matchId: matchRec27 });
    assert.equal(undoOk.status, 200, 'reconcile/undo en año abierto');
    const ignOk = await h.call('POST', '/api/reconcile/ignore',
      { movementId: M27B.id, nota: 'sin factura' });
    assert.equal(ignOk.status, 200, 'reconcile/ignore en año abierto');
    const marcaMov = await h.call('POST', '/api/banks/marcar-pagado',
      { uuid: I27, movementId: M27.id });
    assert.equal(marcaMov.status, 200, 'marcar-pagado con movimiento en año abierto');
    assert.equal(marcaMov.json.enlazado, true);
    const marcaSin = await h.call('POST', '/api/banks/marcar-pagado', { uuid: I27C });
    assert.equal(marcaSin.status, 200, 'marcar-pagado sin movimiento en año abierto');
    const libre = await h.call('POST', '/api/banks/accounts',
      { bank: 'BBVA', name: 'Cuenta libre', kind: 'cuenta', rfc: OWN });
    const cuentaLibre = libre.json.accounts.find(a => a.name === 'Cuenta libre');
    const borraLibre = await h.call('POST', '/api/banks/accounts', { delete: cuentaLibre.id });
    assert.equal(borraLibre.status, 200, 'cuenta sin estados de ejercicio cerrado: se borra como siempre');
    assert.ok(!borraLibre.json.accounts.some(a => a.id === cuentaLibre.id));
    console.log('OK 2.0·SEG · H-2 Bancos/Reconcile — las mismas rutas pasan en año abierto.');
  } finally { h.service.close(); }
}
console.log('OK ronda200f — tanda 6 de la 2.0, fijada');
