import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createPacoSATService } from './local-server.mjs';

/* Cumplimiento (1.6.18): calendario fiscal, detector de errores y
   paquete de defensa. Todo local, sin SAT real. */
const origin = 'https://pacosat.example.com';
const proxyKey = 'd'.repeat(64);
const OWN = 'XAXX010101000';
let time = Date.parse('2026-11-12T15:00:00Z');
const sent = [];
const service = createPacoSATService({ dbFile: ':memory:', html: '<!--PACOSAT_TOKEN-->', origin, proxyKey, now: () => time,
  makeConnector: async () => ({ parser: class {}, connector: {
    request: async () => 'req-fiscal-1', check: async () => ({ status: 'pending', packages: [] }),
    download: async () => { throw new Error('sin paquetes'); } } }),
  makeMailer: () => ({ verify: async () => true, sendMail: async payload => { sent.push(payload); } }) });
let token;
async function call(path, data, options = {}) {
  const headers = { host: 'pacosat.example.com', origin, 'x-pacosat-proxy': proxyKey, 'x-pacosat-token': token, ...options };
  const req = Object.assign(Readable.from(data === undefined ? [] : [Buffer.from(JSON.stringify(data))]), {
    url: path, method: data === undefined || options.method === 'GET' ? 'GET' : 'POST', headers });
  if (options.method) req.method = options.method;
  let response;
  const res = { setHeader() {}, writeHead(status) { this.status = status; this.headersSent = true; },
    end(content) { response = new Response(content, { status: this.status }); } };
  await service.handle(req, res);
  return response;
}
const seedInvoice = (id, extra) => ({ id, date: '2026-11-05', kind: 'I',
  from: { rfc: 'AAA010101AAA', name: 'PROVEEDOR' }, to: { rfc: OWN, name: 'CLIENTE' },
  total: '116.00', currency: 'MXN', ...extra });
try {
  const page = await (await call('/')).text();
  token = page.split('content="')[1].split('"')[0];
  assert.equal((await call('/api/mail', { host: 'smtp.example.com', port: 587, user: 'u', password: 'p',
    from: 'from@example.com', recipient: 'avisos@example.com' })).status, 200);
  assert.equal((await call('/api/unlock', { rfc: OWN, minutes: 60, days: 7, direction: 'received',
    password: 'simulated', certificate: 'YQ==', key: 'Yg==' })).status, 200);
  /* Calendario: vencimiento manual + aviso del tick. */
  const created = await (await call('/api/fiscal/events', { rfc: OWN, title: 'Renovación de sello CSD', date: '2026-11-13' })).json();
  assert.equal(created.ok, true);
  const calendar = await (await call('/api/fiscal/calendar')).json();
  assert.ok(calendar.events.some(event => event.title === 'Renovación de sello CSD' && event.daysLeft === 1));
  assert.ok(calendar.events.some(event => event.kind === 'mensual'));
  assert.ok(calendar.events.some(event => event.kind === 'anual'));
  await service.tick();
  /* 1.7.4: el vencimiento fiscal ya no manda un correo suelto: vive
     en el Centro de Avisos y se nombra en el cuerpo del ÚNICO
     correo-resumen del día. */
  assert.ok(sent.some(mail => /Vencimiento fiscal cercano/.test(mail.text || '')), sent.map(m => m.subject).join(' | '));
  assert.equal(sent.filter(mail => /Resumen de avisos/.test(mail.subject)).length, 1, sent.map(m => m.subject).join(' | '));
  /* Detector: folio duplicado y totales que no cuadran. */
  const dup1 = seedInvoice('EEEEEEEE-1111-1111-1111-111111111111', { fiscal: { serie: 'A', folio: '55', subtotal: '100.00', discount: '', totalTransferred: '16.00', totalWithheld: '' } });
  const dup2 = seedInvoice('EEEEEEEE-2222-2222-2222-222222222222', { fiscal: { serie: 'A', folio: '55', subtotal: '100.00', discount: '', totalTransferred: '16.00', totalWithheld: '' } });
  const bad = seedInvoice('EEEEEEEE-3333-3333-3333-333333333333', { total: '999.00', fiscal: { serie: 'B', folio: '9', subtotal: '100.00', discount: '', totalTransferred: '16.00', totalWithheld: '' } });
  assert.equal((await call('/api/storage', { batch: { people: [{ id: OWN, name: 'Cliente' }], invoices: [dup1, dup2, bad] } })).status, 200);
  /* El XML de dup1 queda como archivo para el paquete de defensa. */
  await call('/api/storage', { batch: { files: [{ id: 'xml:' + dup1.id, name: dup1.id + '.xml', mime: 'application/xml', content: '<xml>uno</xml>' }] } });
  const issues = await (await call('/api/fiscal/issues')).json();
  assert.ok(issues.issues.some(issue => issue.kind === 'folio-duplicado'), JSON.stringify(issues));
  assert.ok(issues.issues.some(issue => issue.kind === 'totales-no-cuadran' && issue.id === bad.id), JSON.stringify(issues));
  /* Ronda de correcciones (9 nov 2026): el patrón de los bancos NO es
     duplicado — BBVA usa como folio el nº de cuenta, idéntico los 12
     meses, con fechas e importes distintos → cero avisos nuevos. El
     par genuino de arriba (misma fecha E importe) sigue siendo el
     ÚNICO folio-duplicado. */
  const bankInvoices = [];
  for (let m = 1; m <= 12; m++)
    bankInvoices.push(seedInvoice('BBBBBBBB-' + String(m).padStart(4, '0') + '-1111-1111-111111111111',
      { date: '2025-' + String(m).padStart(2, '0') + '-15',
        from: { rfc: 'BBA830831LJ2', name: 'BBVA MEXICO' },
        total: (100 + m * 7) + '.50',
        fiscal: { serie: '', folio: '012650004443925908' } }));
  assert.equal((await call('/api/storage', { batch: { invoices: bankInvoices } })).status, 200);
  const issues2 = await (await call('/api/fiscal/issues')).json();
  const folioIssues = issues2.issues.filter(issue => issue.kind === 'folio-duplicado');
  assert.equal(folioIssues.length, 1, JSON.stringify(folioIssues));
  assert.equal(folioIssues[0].id, dup2.id);
  assert.match(folioIssues[0].detail, /coincide la fecha de emisión/);
  /* Paquete de defensa del mes. */
  const defense = await call('/api/fiscal/defense', { month: '2026-11' });
  assert.equal(defense.status, 200);
  /* Los nombres viajan en claro en las cabeceras del ZIP. */
  const raw = Buffer.from(await defense.arrayBuffer()).toString('latin1');
  for (const name of ['indice.csv', 'validaciones.csv', 'resumen.txt', 'xml/' + dup1.id + '.xml'])
    assert.ok(raw.includes(name), 'falta ' + name);
  console.log('fiscal.test: ok');
} finally { await service.close(); }
