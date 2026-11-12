import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createPacoSATService } from './local-server.mjs';

/* Ronda 1.20.0 — CRITERIO ÚNICO DE CANCELADAS EN DINERO (decisión
   de Paco del 11 nov: manda el papel). Hasta la 1.19.0 Dinero y el
   PDF de saldos contaban distinto: una factura cancelada con saldo
   inflaba el «por pagar» de /api/money, generaba aviso de saldo
   («¿ya se pagó?») y la pantalla la enseñaba como alerta de
   «canceladas con pago». Desde esta ronda:
   (1) la cancelada NO suma en por pagar ni en por cobrar de
       /api/money — el mismo cálculo que consumen la pantalla
       Dinero, la tarjeta de Dinero en Hoy y el contador de
       vencidos —;
   (2) NO genera alerta de pago (sin aviso de saldo; y no admite
       marca de pago) — los avisos de DETECCIÓN de la cancelación
       (Vigilancia/Centro de Avisos) no se tocan —;
   (3) se enseña APARTE en «canceladas» (número e importe), fuera
       de los totales;
   y el total por pagar de Dinero coincide con el del PDF de
   saldos para la misma semilla. La ronda JUZGA el /api/money, los
   avisos, el PDF de saldos abierto y el HTML servido. */

const origin = 'https://pacosat.example.com';
const proxyKey = 'c'.repeat(64);
const OWN = 'XAXX010101000';
const time = Date.parse('2026-11-12T15:00:00Z');
const C1 = 'C1C1C1C1-1111-4111-8111-111111111111'; /* cancelada CON marca de pago */
const C2 = 'C2C2C2C2-2222-4222-8222-222222222222'; /* cancelada sin pago (recibida) */
const C3 = 'C3C3C3C3-3333-4333-8333-333333333333'; /* cancelada emitida (por cobrar) */
const V1 = 'V1V1V1V1-4444-4444-8444-444444444444'; /* vigente sin pagar */
const PROV1 = 'PPP010101PPP', PROV2 = 'QQQ020202QQQ', CLIENTE = 'RRR030303RRR';

function harness(service) {
  let token;
  const call = async (path, data) => {
    const headers = { host: 'pacosat.example.com', origin, 'x-pacosat-proxy': proxyKey, 'x-pacosat-token': token };
    const req = Object.assign(Readable.from(data === undefined ? [] : [Buffer.from(JSON.stringify(data))]), {
      url: path, method: data === undefined ? 'GET' : 'POST', headers });
    let response;
    const res = { setHeader() {}, writeHead(status) { this.status = status; this.headersSent = true; },
      end(content) { response = new Response(content, { status: this.status }); } };
    await service.handle(req, res);
    return response;
  };
  return { call, async login() {
    const page = await (await call('/')).text();
    token = page.split('content="')[1].split('"')[0];
    assert.ok(token, 'token del servicio de juguete');
    return page;
  } };
}
const makeService = dbFile => createPacoSATService({ dbFile, html: '<!--PACOSAT_TOKEN-->', origin, proxyKey,
  now: () => time,
  makeConnector: async () => ({ parser: class {}, connector: {
    request: async () => 'req-1200', check: async () => ({ status: 'pending', packages: [] }),
    download: async () => { throw new Error('sin paquetes'); } } }),
  makeMailer: () => ({ verify: async () => true, sendMail: async () => {} }) });
const invoice = (id, date, from, to, total, extra = {}) => ({ id, date, kind: 'I',
  from: { rfc: from, name: 'EMPRESA ' + from }, to: { rfc: to, name: 'EMPRESA ' + to },
  total, currency: 'MXN', fiscal: { paymentMethod: 'PPD', transferred: [], withheld: [] }, ...extra });
const pdfText = async buffer => {
  const doc = await getDocument({ data: new Uint8Array(buffer) }).promise;
  let text = '';
  for (let i = 1; i <= doc.numPages; i++)
    text += (await (await doc.getPage(i)).getTextContent()).items.map(item => item.str).join(' ') + '\n';
  return text;
};

const dir = mkdtempSync(join(tmpdir(), 'pacosat-1200-'));
const dbFile = join(dir, 'pacosat.sqlite');
try {
  /* ===== Fase 1: semilla por la API ===== */
  {
    const service = makeService(dbFile);
    const { call, login } = harness(service);
    await login();
    assert.equal((await call('/api/unlock', { rfc: OWN, minutes: 1440, days: 7, direction: 'both',
      password: 'simulated', certificate: 'YQ==', key: 'Yg==' })).status, 200);
    const seed = [
      invoice(C1, '2026-08-05', PROV1, OWN, '1160.00', { state: 'Cancelado' }),
      invoice(C2, '2026-09-10', PROV2, OWN, '2000.00', { state: 'Cancelado' }),
      invoice(C3, '2026-09-15', OWN, CLIENTE, '5000.00', { state: 'Cancelado' }),
      invoice(V1, '2026-08-20', PROV2, OWN, '3480.00')
    ];
    assert.equal((await call('/api/storage', { batch: {
      people: [{ id: OWN, name: 'Cliente Uno' }], invoices: seed } })).status, 200);
    await service.close();
  }
  /* ===== Fase 2: la marca de pago de C1 y la vigilancia, directas ===== */
  {
    const db = new DatabaseSync(dbFile);
    /* Marca de pago a mano sobre la cancelada C1: $500 pagados de
       $1,160 — su saldo «vivo» sería $660 si contara. */
    db.prepare('INSERT INTO manual_payments(uuid, at, nota, importe) VALUES (?,?,?,?)')
      .run(C1, time, 'Pago marcado a mano (semilla 1.20.0)', '500.00');
    const watch = db.prepare('INSERT INTO cfdi_watch(id, emitter, receiver, total, seal, next, checked, result) VALUES (?,?,?,?,?,?,?,?)');
    const estado = state => JSON.stringify({ state, code: 'S', cancellation: '', cancelable: '', error: '' });
    watch.run(C1, PROV1, OWN, '1160.00', '', time + 86400000, time, estado('Cancelado'));
    watch.run(C2, PROV2, OWN, '2000.00', '', time + 86400000, time, estado('Cancelado'));
    watch.run(C3, OWN, CLIENTE, '5000.00', '', time + 86400000, time, estado('Cancelado'));
    watch.run(V1, PROV2, OWN, '3480.00', '', time + 86400000, time, estado('Vigente'));
    db.close();
  }
  /* ===== Fase 3: el juicio ===== */
  const service = makeService(dbFile);
  const { call, login } = harness(service);
  const page = await login();

  /* (1)+(3) /api/money: la cancelada con marca de pago aporta 0 a
     por pagar; la vigente sigue contando; las canceladas viajan
     aparte con número e importe. */
  const money = await (await call('/api/money')).json();
  const ids = money.balances.map(item => item.id);
  assert.ok(!ids.includes(C1), 'la cancelada con marca de pago NO viaja en balances');
  assert.ok(!ids.includes(C2), 'la cancelada sin pago NO viaja en balances');
  assert.ok(!ids.includes(C3), 'la cancelada emitida NO viaja en balances');
  assert.ok(ids.includes(V1), 'la vigente sin pagar sigue en balances');
  const porPagar = money.balances.filter(item => item.payable)
    .reduce((sum, item) => sum + Number(item.balance), 0);
  const porCobrar = money.balances.filter(item => item.receivable)
    .reduce((sum, item) => sum + Number(item.balance), 0);
  assert.equal(porPagar, 3480, 'por pagar = solo la vigente (3480), sin el saldo de la cancelada (660)');
  assert.equal(porCobrar, 0, 'por cobrar = 0: la cancelada emitida no se cobra');
  assert.deepEqual(money.canceladas, { count: 3, total: '8160.00' },
    'línea de canceladas: 3 facturas por su importe total (1160 + 2000 + 5000), fuera de los totales');
  const balV1 = money.balances.find(item => item.id === V1);
  assert.equal(balV1.balance, '3480.00');
  assert.equal(balV1.cancelled, false, 'la vigente viaja marcada como no cancelada');

  /* (2a) La cancelada no admite marca de pago. */
  const marca = await call('/api/money/mark-paid', { uuid: C2 });
  assert.equal(marca.status, 400, 'marcar pagada una cancelada se rechaza');
  assert.match((await marca.json()).error, /cancelado/);

  /* (2b) Sin alerta de pago: ningún aviso de saldo nace para las
     canceladas (aunque su fecha ya venció el calendario); el de la
     vigente sí nace, preguntando, como siempre. */
  await service.tick();
  const notices = await (await call('/api/notices')).json();
  const saldos = notices.avisos.filter(aviso => aviso.kind === 'saldo');
  const uuidsSaldo = saldos.map(aviso => String(aviso.ref || '').replace('saldo:', ''));
  assert.ok(!uuidsSaldo.includes(C1) && !uuidsSaldo.includes(C2) && !uuidsSaldo.includes(C3),
    'ningún aviso de saldo (alerta de pago) para las canceladas: ' + JSON.stringify(uuidsSaldo));
  assert.ok(uuidsSaldo.includes(V1), 'el aviso de saldo de la vigente sí nace');
  const histSaldos = (notices.historial || []).filter(aviso => aviso.kind === 'saldo');
  assert.ok(!histSaldos.some(aviso => String(aviso.ref || '') === 'saldo:' + C1),
    'ni en el historial queda alerta de pago de la cancelada');

  /* Coincidencia con el papel: el PDF de saldos de la MISMA semilla
     da el mismo por pagar que Dinero, y no conoce los importes de
     las canceladas. */
  const res = await call('/api/salidas/pdf', { kind: 'saldos', rfc: OWN });
  assert.equal(res.status, 200, 'el PDF de saldos se genera');
  const data = await res.json();
  const text = await pdfText(Buffer.from(data.content, 'base64'));
  assert.ok(text.includes('Por pagar (1)'), 'el papel cuenta 1 por pagar: solo la vigente');
  assert.ok(text.includes('$3,480.00'), 'el papel suma $3,480.00 por pagar — coincide con Dinero');
  assert.ok(!text.includes('$660.00'), 'el papel no conoce el saldo de la cancelada con marca de pago');
  assert.ok(!text.includes('$8,160.00'), 'el papel no suma las canceladas en ningún total');
  assert.ok(!text.includes('Por cobrar (1)'), 'el papel no cuenta la cancelada emitida como por cobrar');

  /* La pantalla: la línea nueva existe y la alerta vieja murió
     (sobre el artefacto construido, que es lo que se sirve). */
  const htmlArtefacto = readFileSync(join(import.meta.dirname, 'Faro-Fiscal.html'), 'utf8');
  assert.ok(htmlArtefacto.includes('Canceladas en el periodo'), 'el HTML construido trae la línea «Canceladas en el periodo»');
  assert.ok(!htmlArtefacto.includes('canceladas con pago'), 'el HTML ya no trae la alerta de «canceladas con pago»');
  assert.ok(!htmlArtefacto.includes('ALERTA ROJA: hay CFDI cancelados'), 'la caja de alerta roja de Dinero desapareció');
  assert.ok(page.length >= 0);
  await service.close();
  console.log('ronda1200: ok — la cancelada con marca de pago aporta 0 a por pagar, no genera alerta de pago, ' +
    'vive en su línea (3 · $8,160.00) y Dinero coincide con el PDF de saldos ($3,480.00)');
} finally { rmSync(dir, { recursive: true, force: true }); }
