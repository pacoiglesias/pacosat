import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createPacoSATService } from './local-server.mjs';

/* Centro de Avisos (1.7.4, pieza 2 · punto 17): calendario por
   contraparte, preguntar antes de hablar de atraso, solventar con
   re-comprobación, línea base silenciosa, digest único y solicitudes
   internas de estados de cuenta. Todo con SAT y correo simulados. */
const origin = 'https://pacosat.example.com';
const proxyKey = 'c'.repeat(64);
const OWN = 'XAXX010101000';
function makeService(sent, now) {
  return createPacoSATService({ dbFile: ':memory:', html: '<!--PACOSAT_TOKEN-->', origin, proxyKey, now,
    extractText: async () => 'ESTADO DE CUENTA\nSaldo inicial $1,000.00\nSaldo final $1,000.00',
    makeConnector: async () => ({ parser: class {}, connector: {
      request: async () => 'req-avisos-1', check: async () => ({ status: 'pending', packages: [] }),
      download: async () => { throw new Error('sin paquetes'); } } }),
    makeMailer: () => ({ verify: async () => true, sendMail: async payload => { sent.push(payload); } }) });
}
function client(service) {
  let token = '';
  const call = async (path, data) => {
    const headers = { host: 'pacosat.example.com', origin, 'x-pacosat-proxy': proxyKey, 'x-pacosat-token': token };
    const req = Object.assign(Readable.from(data === undefined ? [] : [Buffer.from(JSON.stringify(data))]), {
      url: path, method: data === undefined ? 'GET' : 'POST', headers });
    let response;
    const res = { setHeader() {}, writeHead(status) { this.status = status; },
      end(content) { response = new Response(content, { status: this.status }); } };
    await service.handle(req, res);
    return response;
  };
  return { call, init: async () => { token = (await (await call('/')).text()).split('content="')[1].split('"')[0]; } };
}
async function setup(call) {
  await call('/api/mail', { host: 'smtp.example.com', port: 587, user: 'u', password: 'p',
    from: 'from@example.com', recipient: 'avisos@example.com' });
  await call('/api/unlock', { rfc: OWN, minutes: 1440, days: 7, direction: 'received',
    password: 'simulated', certificate: 'YQ==', key: 'Yg==' });
  await call('/api/storage', { batch: { people: [{ id: OWN, name: 'Cliente Uno' }] } });
}
const invoice = (id, date, from, to, total, method = 'PPD') => ({ id, date, kind: 'I',
  from: { rfc: from, name: 'EMPRESA ' + from }, to: { rfc: to, name: 'EMPRESA ' + to },
  total, currency: 'MXN', fiscal: { paymentMethod: method, transferred: [], withheld: [] } });

/* --- Escenario A: calendario (día 10), preguntar, solventar --- */
{
  let time = Date.parse('2026-11-09T15:00:00Z'); /* 9 nov, 09:00 MX */
  const sent = [];
  const service = makeService(sent, () => time);
  const { call, init } = client(service);
  try {
    await init();
    await setup(call);
    const CHED = 'TCH850701RM1';
    const lists = await (await call('/api/lists/counterparts',
      { rfc: CHED, name: 'TIENDAS CHEDRAUI', kind: 'Cliente', payDay: 10 })).json();
    assert.equal(lists.counterparts.find(cp => cp.rfc === CHED).payDay, 10);
    const R1 = 'CHEDRAUI-1111-1111-1111-111111111111';
    await call('/api/storage', { batch: { invoices: [invoice(R1, '2026-11-01', OWN, CHED, '343539.11')] } });
    await service.tick();
    let notices = await (await call('/api/notices')).json();
    assert.ok(!notices.avisos.some(aviso => aviso.kind === 'saldo'),
      'El día 9, con día de pago 10, la factura está en plazo: no nace ningún aviso.');
    time = Date.parse('2026-11-11T15:00:00Z'); /* 11 nov: venció el día 10 */
    await service.tick();
    notices = await (await call('/api/notices')).json();
    const aviso = notices.avisos.find(item => item.kind === 'saldo');
    assert.ok(aviso, 'El día 11 nace el aviso de la factura de Chedraui.');
    assert.equal(aviso.estado, 'por-confirmar');
    assert.equal(aviso.clase, 'necesita');
    assert.match(aviso.detalle, /¿Ya pagaron\?/);
    assert.match(aviso.detalle, /no consta el pago/);
    assert.equal(sent.filter(mail => /Resumen de avisos/.test(mail.subject)).length, 1,
      'Ese día sale como mucho el correo-resumen, nunca uno por factura.');
    assert.ok(!sent.some(mail => /cumple 30 días|cumple 60 días/.test(mail.subject)));
    /* «No, aún no» → atraso declarado con texto veraz. */
    await call('/api/notices/answer', { id: aviso.id, respuesta: 'no' });
    notices = await (await call('/api/notices')).json();
    const atrasado = notices.avisos.find(item => item.id === aviso.id);
    assert.equal(atrasado.estado, 'abierto');
    assert.equal(atrasado.clase, 'mal');
    assert.match(atrasado.titulo, /no consta el pago en PacoSAT/);
    /* «Ya lo corregí» sin pagar: la re-comprobación lo rechaza. */
    const intento = await (await call('/api/notices/resolve', { id: aviso.id })).json();
    assert.equal(intento.ok, false);
    assert.match(intento.falta, /sigue constando un saldo/);
    notices = await (await call('/api/notices')).json();
    assert.ok(notices.avisos.some(item => item.id === aviso.id), 'El aviso sigue abierto tras la falsa corrección.');
    /* Cierre rápido (ronda de correcciones, 9 nov 2026): SIN nota
       también pasa — si ya se pagó, un toque y cerrado; la bitácora
       registra sola el cierre (fecha, manual, origen). */
    const sinNota = await call('/api/notices/answer', { id: aviso.id, respuesta: 'si', nota: '' });
    assert.equal(sinNota.status, 200);
    notices = await (await call('/api/notices')).json();
    assert.ok(!notices.avisos.some(item => item.id === aviso.id), 'El aviso cerrado sin nota sale de los abiertos.');
    const cerrado = notices.historial.find(item => item.id === aviso.id);
    assert.ok(cerrado, 'El aviso queda en el historial.');
    assert.match(cerrado.resolucion, /Pagado a mano/);
    assert.match(cerrado.resolucion, /sin nota/);
    const money = await (await call('/api/money')).json();
    assert.equal(money.balances.find(item => item.id === R1).balance, '0.00');
    /* Segunda vía de solventar: enlazar el complemento de pago. */
    const R2 = 'PROVEE-2222-2222-2222-222222222222';
    await call('/api/storage', { batch: { invoices: [invoice(R2, '2026-08-01', 'PROV020202AAA', OWN, '1000.00')] } });
    notices = await (await call('/api/notices')).json();
    const aviso2 = notices.avisos.find(item => item.kind === 'saldo' && item.importe === '1000.00');
    assert.ok(aviso2, 'El saldo sin calendario nace por la regla general.');
    const pago = { id: 'PAGO0000-3333-3333-3333-333333333333', date: '2026-11-11', kind: 'P',
      from: { rfc: 'PROV020202AAA', name: 'EMPRESA PROV' }, to: { rfc: OWN, name: 'CLIENTE UNO' },
      total: '0.00', currency: 'MXN',
      fiscal: { paymentMethod: '', transferred: [], withheld: [], payments: { totalPaid: '1000.00',
        pagos: [{ fechaPago: '2026-11-11T10:00:00', monto: '1000.00',
          documentos: [{ idDocumento: R2, impPagado: '1000.00', impSaldoInsoluto: '0.00', numParcialidad: '1' }] }] } } };
    await call('/api/storage', { batch: { invoices: [pago] } });
    const resuelto = await (await call('/api/notices/resolve', { id: aviso2.id })).json();
    assert.equal(resuelto.ok, true);
    assert.ok(resuelto.historial.some(item => item.id === aviso2.id));
    console.log('avisos.test · calendario, preguntar y solventar: ok');
  } finally { await service.close(); }
}

/* --- Escenario B: línea base con 50 históricas + digest único --- */
{
  let time = Date.parse('2026-11-12T15:00:00Z');
  const sent = [];
  const service = makeService(sent, () => time);
  const { call, init } = client(service);
  try {
    await init();
    await setup(call);
    await service.tick(); /* primera evaluación de la vida de la base */
    const historicas = [];
    for (let i = 1; i <= 50; i++)
      historicas.push(invoice('HIST' + String(i).padStart(4, '0') + '-0000-0000-0000-000000000000',
        '2021-03-15', 'TEL210101AAA', OWN, '100.00'));
    await call('/api/storage', { batch: { invoices: historicas } });
    await service.tick();
    let notices = await (await call('/api/notices')).json();
    const saldos = notices.avisos.filter(aviso => aviso.kind === 'saldo');
    assert.equal(saldos.length, 50);
    assert.ok(saldos.every(aviso => aviso.baseline === true), 'Todo el histórico nace marcado línea base.');
    assert.ok(saldos.every(aviso => aviso.estado === 'por-confirmar'), 'Nada nace declarado en atraso.');
    assert.ok(!notices.avisos.some(aviso => aviso.clase === 'mal'));
    assert.equal(sent.length, 0, 'La línea base no genera ni un solo correo.');
    /* Una factura nueva vencida: un solo resumen al día siguiente. */
    await call('/api/storage', { batch: { invoices: [invoice('NUEVA-9999-9999-9999-999999999999',
      '2026-09-01', 'NUEV030303AAA', OWN, '500.00')] } });
    time = Date.parse('2026-11-13T15:00:00Z');
    await service.tick();
    assert.equal(sent.length, 1, 'Como mucho, UN correo-resumen.');
    assert.match(sent[0].subject, /Resumen de avisos: 1/);
    assert.match(sent[0].text, /Día de pago a/);
    assert.ok(!/cumple 30 días|cumple 60 días/.test(sent[0].subject + sent[0].text));
    notices = await (await call('/api/notices')).json();
    assert.equal(notices.avisos.find(aviso => aviso.importe === '500.00').baseline, false);
    console.log('avisos.test · línea base silenciosa y digest único: ok');
  } finally { await service.close(); }
}

/* --- Escenario C: solicitud interna de estado de cuenta --- */
{
  let time = Date.parse('2026-11-12T15:00:00Z');
  const sent = [];
  const service = makeService(sent, () => time);
  const { call, init } = client(service);
  try {
    await init();
    await setup(call);
    const banks = await (await call('/api/banks/accounts', { bank: 'Konfio', name: 'Cuenta', kind: 'cuenta' })).json();
    const account = banks.accounts[0];
    const pdf64 = Buffer.from('%PDF-1.7 estado de juguete ' + 'x'.repeat(120)).toString('base64');
    await call('/api/banks/statements', { accountId: account.id, month: '2026-09', content: pdf64 });
    let notices = await (await call('/api/notices')).json();
    const solicitud = notices.avisos.find(aviso => aviso.kind === 'solicitud-estado');
    assert.ok(solicitud, 'El sistema pide dentro del panel el estado que le falta.');
    assert.equal(solicitud.clase, 'necesita');
    assert.deepEqual(solicitud.solicitud, { banco: 'Konfio', mes: '2026-10' });
    assert.ok(notices.avisos.some(aviso => aviso.kind === 'estado' && aviso.clase === 'falta'));
    assert.ok(!notices.avisos.some(aviso => /2026-11/.test(aviso.titulo)),
      'El mes en curso aún no se pide: no ha cerrado.');
    /* Al aportarlo, la solicitud y la falta se solventan solas. */
    await call('/api/banks/statements', { accountId: account.id, month: '2026-10', content: pdf64 });
    notices = await (await call('/api/notices')).json();
    assert.ok(!notices.avisos.some(aviso => aviso.kind === 'solicitud-estado'));
    assert.ok(!notices.avisos.some(aviso => aviso.kind === 'estado'));
    assert.ok(notices.historial.some(aviso => aviso.kind === 'solicitud-estado' && /archivado en Bancos/.test(aviso.resolucion)));
    console.log('avisos.test · solicitud interna solventada al aportar el estado: ok');
  } finally { await service.close(); }
}
/* --- Escenario D: acciones por lote (ronda de correcciones) --- */
{
  let time = Date.parse('2026-11-12T15:00:00Z');
  const sent = [];
  const service = makeService(sent, () => time);
  const { call, init } = client(service);
  try {
    await init();
    await setup(call);
    /* Dos saldos por pagar vencidos por la regla general (30 días). */
    const P1 = 'LOTE0001-1111-1111-1111-111111111111';
    const P2 = 'LOTE0002-2222-2222-2222-222222222222';
    await call('/api/storage', { batch: { invoices: [
      invoice(P1, '2026-09-01', 'LOTE030303AAA', OWN, '700.00'),
      invoice(P2, '2026-09-01', 'LOTE030303AAA', OWN, '300.00')] } });
    /* Un aviso que NO es de saldo: la solicitud interna de un estado. */
    const banks = await (await call('/api/banks/accounts', { bank: 'Konfio', name: 'Cuenta', kind: 'cuenta' })).json();
    const account = banks.accounts[0];
    const pdf64 = Buffer.from('%PDF-1.7 estado de juguete ' + 'x'.repeat(120)).toString('base64');
    await call('/api/banks/statements', { accountId: account.id, month: '2026-09', content: pdf64 });
    let notices = await (await call('/api/notices')).json();
    const saldos = notices.avisos.filter(aviso => aviso.kind === 'saldo');
    assert.equal(saldos.length, 2);
    const solicitud = notices.avisos.find(aviso => aviso.kind === 'solicitud-estado');
    assert.ok(solicitud, 'Hay un aviso que no es de saldo para el lote mixto.');
    /* La nota sigue valiendo cuando SÍ se escribe. */
    const conNota = await call('/api/notices/answer',
      { id: saldos[0].id, respuesta: 'si', nota: 'Pagado con Konfío el 12 de noviembre', fecha: '2026-11-12' });
    assert.equal(conNota.status, 200);
    notices = await (await call('/api/notices')).json();
    assert.match(notices.historial.find(aviso => aviso.id === saldos[0].id).resolucion, /Konfío/);
    /* Lote vacío: no hace nada. */
    const vacio = await (await call('/api/notices/batch', { ids: [], accion: 'pagadas' })).json();
    assert.equal(vacio.aplicados, 0);
    assert.equal(vacio.saltados, 0);
    notices = await (await call('/api/notices')).json();
    assert.equal(notices.avisos.filter(aviso => aviso.kind === 'saldo').length, 1, 'El lote vacío no tocó nada.');
    /* Lote mixto «pagadas»: aplica al saldo y salta la solicitud. */
    const restante = notices.avisos.find(aviso => aviso.kind === 'saldo');
    const lote = await (await call('/api/notices/batch',
      { ids: [restante.id, solicitud.id], accion: 'pagadas' })).json();
    assert.equal(lote.aplicados, 1);
    assert.equal(lote.saltados, 1);
    assert.equal(lote.motivos[0].id, solicitud.id);
    notices = await (await call('/api/notices')).json();
    assert.ok(!notices.avisos.some(aviso => aviso.kind === 'saldo'), 'El saldo del lote quedó cerrado.');
    assert.match(notices.historial.find(aviso => aviso.id === restante.id).resolucion, /en lote/);
    assert.ok(notices.avisos.some(aviso => aviso.id === solicitud.id), 'La solicitud saltada sigue abierta.');
    const money = await (await call('/api/money')).json();
    assert.equal(money.balances.find(item => item.id === P1).balance, '0.00');
    assert.equal(money.balances.find(item => item.id === P2).balance, '0.00');
    /* «Cerrar» en lote: la solicitud va al historial como cerrada. */
    const cierre = await (await call('/api/notices/batch', { ids: [solicitud.id], accion: 'cerrar' })).json();
    assert.equal(cierre.aplicados, 1);
    assert.equal(cierre.saltados, 0);
    notices = await (await call('/api/notices')).json();
    assert.ok(notices.historial.some(aviso => aviso.id === solicitud.id && /en lote/.test(aviso.resolucion)));
    assert.ok(!notices.avisos.some(aviso => aviso.id === solicitud.id));
    /* «Borrar» (descartar): ni abiertos ni historial, y NO resucita. */
    const P3 = 'LOTE0003-3333-3333-3333-333333333333';
    await call('/api/storage', { batch: { invoices: [invoice(P3, '2026-09-01', 'LOTE030303AAA', OWN, '900.00')] } });
    notices = await (await call('/api/notices')).json();
    const tercero = notices.avisos.find(aviso => aviso.kind === 'saldo');
    assert.ok(tercero, 'Nace el tercer saldo para descartarlo.');
    const descarte = await (await call('/api/notices/batch', { ids: [tercero.id], accion: 'borrar' })).json();
    assert.equal(descarte.aplicados, 1);
    notices = await (await call('/api/notices')).json();
    assert.ok(!notices.avisos.some(aviso => aviso.id === tercero.id));
    assert.ok(!notices.historial.some(aviso => aviso.id === tercero.id), 'Lo descartado no va al historial.');
    await service.tick();
    notices = await (await call('/api/notices')).json();
    assert.ok(!notices.avisos.some(aviso => aviso.kind === 'saldo'),
      'El aviso descartado NO resucita en la siguiente sincronización.');
    console.log('avisos.test · lote mixto, cerrar y descartar sin resurrección: ok');
  } finally { await service.close(); }
}
console.log('avisos.test: ok');
