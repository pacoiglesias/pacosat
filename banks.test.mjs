import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createPacoSATService } from './local-server.mjs';

/* Bancos (1.6.19): archivo de estados, lectura automática con el
   extractor inyectado (texto de juguete, sin PDF real), cadena de
   saldos, confirmación manual y posición. Sin red ni SAT. */
const origin = 'https://pacosat.example.com';
const proxyKey = 'e'.repeat(64);
let time = Date.parse('2026-11-12T15:00:00Z');
const texts = {
  oct: ['BBVA MEXICO · ESTADO DE CUENTA', 'Saldo inicial $9,000.00', 'Saldo final $10,000.00',
    'Total de abonos $1,000.00', 'Total de cargos $0.00'].join('\n'),
  nov: ['BBVA MEXICO · ESTADO DE CUENTA', 'Saldo inicial $10,000.00', 'Saldo final $12,500.00',
    'Total de abonos $5,000.00', 'Total de cargos $2,500.00',
    '02/11/2026 DEPOSITO SPEI RECIBIDO $3,000.00 $13,000.00',
    '03/11/2026 PAGO TARJETA CREDITO $500.00 $12,500.00'].join('\n'),
  dec: 'ESTADO GENERICO SIN ETIQUETAS DE SALDO\nMovimientos varios sin importes resumen.',
  santander: ['SANTANDER MEXICO', 'Saldo inicial $1.00', 'Saldo final $2.00'].join('\n')
};
let currentText = '';
const service = createPacoSATService({ dbFile: ':memory:', html: '<!--PACOSAT_TOKEN-->', origin, proxyKey, now: () => time,
  extractText: async () => currentText,
  makeMailer: () => ({ verify: async () => true, sendMail: async () => {} }) });
let token;
async function call(path, data) {
  const headers = { host: 'pacosat.example.com', origin, 'x-pacosat-proxy': proxyKey, 'x-pacosat-token': token };
  const req = Object.assign(Readable.from(data === undefined ? [] : [Buffer.from(JSON.stringify(data))]), {
    url: path, method: data === undefined ? 'GET' : 'POST', headers });
  let response;
  const res = { setHeader() {}, writeHead(status) { this.status = status; this.headersSent = true; },
    end(content) { response = new Response(content, { status: this.status }); } };
  await service.handle(req, res);
  return response;
}
const pdf64 = Buffer.from('%PDF-1.7 estado de juguete ' + 'x'.repeat(120)).toString('base64');
try {
  const page = await (await call('/')).text();
  token = page.split('content="')[1].split('"')[0];
  let data = await (await call('/api/banks/accounts', { bank: 'BBVA', name: 'Cuenta Maestra Pyme', kind: 'cuenta', last4: '1234' })).json();
  const account = data.accounts[0];
  assert.equal(account.bank, 'BBVA');
  /* Octubre y noviembre: lectura completa y cadena continua. */
  currentText = texts.oct;
  data = await (await call('/api/banks/statements', { accountId: account.id, month: '2026-10', content: pdf64 })).json();
  let mine = data.accounts[0];
  assert.equal(mine.statements[0].state, 'ok');
  assert.equal(mine.statements[0].opening, '9000.00');
  assert.equal(mine.statements[0].closing, '10000.00');
  currentText = texts.nov;
  data = await (await call('/api/banks/statements', { accountId: account.id, month: '2026-11', content: pdf64 })).json();
  mine = data.accounts[0];
  const november = mine.statements.find(statement => statement.month === '2026-11');
  assert.equal(november.chain, 'ok');
  assert.equal(november.movements, 2);
  assert.deepEqual(mine.missing, []);
  assert.equal(data.position.total, '12500.00');
  assert.equal(data.position.byBank.BBVA, '12500.00');
  /* Movimientos para la conciliación: abono positivo, pago negativo. */
  const movements = await (await call('/api/banks/movements')).json();
  assert.equal(movements.movements.length, 2);
  assert.equal(movements.movements[0].amount, '3000.00');
  assert.equal(movements.movements[1].amount, '-500.00');
  /* Diciembre sin etiquetas: queda «a revisar» y se confirma a mano. */
  currentText = texts.dec;
  data = await (await call('/api/banks/statements', { accountId: account.id, month: '2026-12', content: pdf64 })).json();
  mine = data.accounts[0];
  const december = mine.statements.find(statement => statement.month === '2026-12');
  assert.equal(december.state, 'review');
  assert.equal(december.opening, null);
  data = await (await call('/api/banks/statements/confirm', { id: december.id, opening: '12500.00', closing: '13000.00', credits: '', charges: '' })).json();
  mine = data.accounts[0];
  const confirmed = mine.statements.find(statement => statement.month === '2026-12');
  assert.equal(confirmed.state, 'manual');
  assert.equal(confirmed.chain, 'ok');
  assert.equal(data.position.total, '13000.00');
  /* Segunda cuenta: la posición suma por banco y en global. */
  data = await (await call('/api/banks/accounts', { bank: 'Santander', name: 'Cheques', kind: 'cuenta' })).json();
  const santander = data.accounts.find(item => item.bank === 'Santander');
  currentText = texts.santander;
  data = await (await call('/api/banks/statements', { accountId: santander.id, month: '2026-11', content: pdf64 })).json();
  assert.equal(data.position.byBank.Santander, '2.00');
  assert.equal(data.position.total, '13002.00');
  /* Cadena rota: un enero que no abre donde diciembre cerró. */
  currentText = ['BBVA MEXICO', 'Saldo inicial $9,999.00', 'Saldo final $9,999.00'].join('\n');
  data = await (await call('/api/banks/statements', { accountId: account.id, month: '2027-01', content: pdf64 })).json();
  mine = data.accounts.find(item => item.id === account.id);
  const january = mine.statements.find(statement => statement.month === '2027-01');
  assert.equal(january.chain, 'broken');
  assert.ok(january.chainDetail.includes('13000.00'));
  console.log('banks.test: ok');
} finally { await service.close(); }
