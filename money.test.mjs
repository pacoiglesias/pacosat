import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createPacoSATService } from './local-server.mjs';

/* Dinero (1.6.17): saldos desde la relación Pagos↔facturas, avisos de
   PPD envejecidos y detector de facturas esperadas. Datos sembrados
   como registros (el desglose ya persistido), sin SAT real. */
const origin = 'https://pacosat.example.com';
const proxyKey = 'c'.repeat(64);
const OWN = 'XAXX010101000';
let time = Date.parse('2026-11-12T15:00:00Z');
const sent = [];
const service = createPacoSATService({ dbFile: ':memory:', html: '<!--PACOSAT_TOKEN-->', origin, proxyKey, now: () => time,
  makeConnector: async () => ({ parser: class {}, connector: {
    request: async () => 'req-dinero-1', check: async () => ({ status: 'pending', packages: [] }),
    download: async () => { throw new Error('sin paquetes'); } } }),
  makeMailer: () => ({ verify: async () => true, sendMail: async payload => { sent.push(payload); } }) });
let token;
async function call(path, data, options = {}) {
  const headers = { host: 'pacosat.example.com', origin, 'x-pacosat-proxy': proxyKey, 'x-pacosat-token': token, ...options };
  const req = Object.assign(Readable.from(data === undefined ? [] : [Buffer.from(JSON.stringify(data))]), {
    url: path, method: data === undefined ? 'GET' : 'POST', headers });
  let response;
  const res = { setHeader() {}, writeHead(status) { this.status = status; this.headersSent = true; },
    end(content) { response = new Response(content, { status: this.status }); } };
  await service.handle(req, res);
  return response;
}
const invoice = (id, date, from, total, method, extra = {}) => ({ id, date, kind: 'I',
  from: { rfc: from, name: 'EMPRESA ' + from }, to: { rfc: OWN, name: 'CLIENTE UNO' },
  total, currency: 'MXN', fiscal: { paymentMethod: method, transferred: [], withheld: [] }, ...extra });
try {
  const page = await (await call('/')).text();
  token = page.split('content="')[1].split('"')[0];
  assert.equal((await call('/api/mail', { host: 'smtp.example.com', port: 587, user: 'u', password: 'p',
    from: 'from@example.com', recipient: 'avisos@example.com' })).status, 200);
  assert.equal((await call('/api/unlock', { rfc: OWN, minutes: 1440, days: 7, direction: 'received',
    password: 'simulated', certificate: 'YQ==', key: 'Yg==' })).status, 200);
  const A = 'AAAAAAAA-1111-1111-1111-111111111111';
  const B = 'BBBBBBBB-2222-2222-2222-222222222222';
  const payment = { id: 'CCCCCCCC-3333-3333-3333-333333333333', date: '2026-10-01', kind: 'P',
    from: { rfc: 'AAA010101AAA', name: 'EMPRESA AAA010101AAA' }, to: { rfc: OWN, name: 'CLIENTE UNO' },
    total: '0.00', currency: 'MXN',
    fiscal: { paymentMethod: '', transferred: [], withheld: [], payments: { totalPaid: '500.00',
      pagos: [{ fechaPago: '2026-10-01T12:00:00', monto: '500.00',
        documentos: [{ idDocumento: A, impPagado: '500.00', impSaldoInsoluto: '660.00', numParcialidad: '1' }] }] } } };
  const seed = [
    invoice(A, '2026-09-15', 'AAA010101AAA', '1160.00', 'PPD'),
    invoice(B, '2026-08-05', 'BBB020202BBB', '2320.00', 'PPD'),
    payment,
    /* Proveedor recurrente CCC: facturó jun, jul y ago; en noviembre
       aún no ha llegado la suya. */
    invoice('DDDDDDDD-4444-4444-4444-444444444444', '2026-06-10', 'CCC030303CCC', '100.00', 'PUE'),
    invoice('DDDDDDDD-5555-5555-5555-555555555555', '2026-07-10', 'CCC030303CCC', '100.00', 'PUE'),
    invoice('DDDDDDDD-6666-6666-6666-666666666666', '2026-08-10', 'CCC030303CCC', '100.00', 'PUE')
  ];
  assert.equal((await call('/api/storage', { batch: { people: [{ id: OWN, name: 'Cliente Uno' }], invoices: seed } })).status, 200);
  /* Saldos: A queda en 660 tras el pago parcial; B, entero. */
  const money = await (await call('/api/money')).json();
  const balA = money.balances.find(item => item.id === A);
  assert.equal(balA.paid, '500.00');
  assert.equal(balA.balance, '660.00');
  assert.equal(balA.payable, true);
  const balB = money.balances.find(item => item.id === B);
  assert.equal(balB.balance, '2320.00');
  /* Esperadas: CCC aparece; AAA y BBB no (no son mensuales). */
  assert.deepEqual(money.expected.map(item => item.rfc), ['CCC030303CCC']);
  /* El tick ya NO manda correos por factura (1.7.4): los saldos y la
     esperada nacen en el Centro de Avisos. Como es la primera
     evaluación sobre datos ya existentes, todo nace como LÍNEA BASE:
     en el panel, sin un solo correo. */
  await service.tick();
  assert.equal(sent.length, 0, sent.map(mail => mail.subject).join(' | '));
  const notices = await (await call('/api/notices')).json();
  const saldoA = notices.avisos.find(aviso => aviso.kind === 'saldo' && aviso.importe === '660.00');
  assert.ok(saldoA, JSON.stringify(notices.avisos));
  assert.equal(saldoA.estado, 'por-confirmar');
  assert.equal(saldoA.clase, 'necesita');
  assert.equal(saldoA.baseline, true);
  assert.match(saldoA.detalle, /no consta el pago en PacoSAT|no consta el pago de/);
  assert.ok(notices.avisos.some(aviso => aviso.kind === 'saldo' && aviso.importe === '2320.00' && aviso.estado === 'por-confirmar'));
  assert.ok(notices.avisos.some(aviso => aviso.kind === 'esperada' && aviso.clase === 'falta' && aviso.baseline === true));
  console.log('money.test: ok');
} finally { await service.close(); }
