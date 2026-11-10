import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPacoSATService } from './local-server.mjs';
import { decryptBackupBuffer } from './backup-core.mjs';
import { validarClabe, validarCuentaBbva, digitoControlClabe, normalizarBeneficiario,
  construirPreparacion, preparacionTxt, MANOFIL_SEED } from './pagos.mjs';

/* Ronda 1.10.0: catálogo de beneficiarios con validación de CLABE,
   generador de pagos que cruza los CFDI recibidos del mes con el
   catálogo por RFC del emisor, tablas espejo de las rejillas de
   BBVA y la regla del tope interbancario de $49,999.99 (observado
   en el banco el 9 nov 2026). Datos de juguete salvo la precarga de
   Mano Fil, que son los datos reales verificados ese día. */
const origin = 'https://pacosat.example.com';
const proxyKey = 'f'.repeat(64);
const MF = 'MFI6212158B4';
let time = Date.parse('2026-11-12T15:00:00Z');
const service = createPacoSATService({ dbFile: ':memory:', html: '<!--PACOSAT_TOKEN-->', origin, proxyKey, now: () => time,
  extractText: async () => '',
  makeConnector: async () => ({ parser: class {}, connector: {
    request: async () => 'req-1100', check: async () => ({ status: 'pending', packages: [] }),
    download: async () => { throw new Error('sin paquetes'); } } }),
  makeMailer: () => ({ verify: async () => true, sendMail: async () => {} }) });
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
const j = async (path, data, target) => (await call(path, data, target)).json();

try {
  /* ===== Unidad: validación de CLABE y cuenta ===== */
  for (const ben of MANOFIL_SEED) {
    if (ben.clabe) assert.equal(validarClabe(ben.clabe).ok, true, 'la CLABE precargada de ' + ben.nombre + ' debe ser válida');
    if (ben.cuenta) assert.equal(validarCuentaBbva(ben.cuenta).ok, true, 'la cuenta precargada de ' + ben.nombre + ' debe ser válida');
  }
  assert.equal(validarClabe('014650655112091508').ok, false, 'un dígito cambiado rompe el control');
  assert.equal(validarClabe('01465065511209150').ok, false, '17 dígitos no es CLABE');
  assert.equal(validarClabe('01465065511209150A').ok, false, 'letras no son CLABE');
  assert.match(validarClabe('014650655112091508').error, /dígito de control/);
  assert.equal(validarCuentaBbva('012529865').ok, false, '9 dígitos no es cuenta BBVA');
  assert.throws(() => normalizarBeneficiario({ nombre: 'PRUEBA SA', contraparte: 'GRC131111298', clabe: '014650655112091508' }),
    /dígito de control/, 'el alta con CLABE mala se rechaza con su motivo');
  assert.throws(() => normalizarBeneficiario({ nombre: 'PRUEBA SA', contraparte: 'GRC131111298', cuenta: '0125298652', grupo: 'Interbancario' }),
    /CLABE/, 'al grupo interbancario sin CLABE no se entra');

  /* ===== Unidad: la preparación y el tope ===== */
  const linea = (nombre, grupo, destino, total, extra = {}) => ({ nombre, grupo,
    ...(grupo === 'BBVA' ? { cuenta: destino } : { clabe: destino }),
    total, base: extra.base || '', iva: extra.iva || '', rfc: extra.rfc || '', motivo: extra.motivo || '', folio: extra.folio || '' });
  const prep = construirPreparacion({ rfc: MF, month: '2026-11',
    group: { descripcion: 'PROVEEDORES MANOFIL', cuentaRetiro: '0444392590', referencia: '112026',
      fechaCargo: '2026-11-10', fechaAbono: '2026-11-11', fechaAplicacion: '2026-11-11' },
    lines: [
      linea('GARCIA RIVERA CONTADORES Y CIA', 'Interbancario', '014650655112091507', 80040, { base: 69000, iva: 11040, rfc: 'GRC131111298', motivo: 'IGUALA MENSUAL', folio: '5166' }),
      linea('ACEROS INGENIERIA Y CONSTRUCCION RT', 'Interbancario', '030650900032464956', 33640, { base: 29000, iva: 4640, rfc: 'AIC150804PQ2', motivo: 'SERVICIO DE COBRANZA', folio: '13564' }),
      linea('BG ASOCIADOS CONTABLES', 'Interbancario', '002650702367144601', 10474.80, { base: 9030, iva: 1444.80, rfc: 'BAC260401MH8', motivo: 'CONTABILIDAD MENSUAL' }),
      linea('INMOBILIARIA, PROYECTOS Y CONSTRUCCIONES BRISBANE', 'BBVA', '0125298652', 74240, { folio: '962' }),
      linea('INMOBILIARIA, PROYECTOS Y CONSTRUCCIONES BRISBANE', 'BBVA', '0125298652', 12760, { folio: '963' })
    ] });
  assert.deepEqual([prep.bbva.operaciones, prep.bbva.totalCents], [2, 8700000], 'grupo BBVA: 2 operaciones, $87,000.00');
  assert.deepEqual([prep.interbancario.operaciones, prep.interbancario.totalCents], [2, 4411480],
    'interbancario SIN García (sobre el tope): Aceros + BG = $44,114.80');
  assert.deepEqual([prep.speiIndividual.operaciones, prep.speiIndividual.totalCents], [1, 8004000],
    'García ($80,040 > $49,999.99) se aparta a SPEI individual');
  assert.equal(prep.speiIndividual.lines[0].sobreTope, true);
  assert.equal(prep.totalCents, 21115480, 'total general $211,154.80');
  assert.equal(prep.operaciones, 5);
  const txt = preparacionTxt(prep);
  assert.ok(txt.includes('GRUPO BBVA') && txt.includes('GRUPO INTERBANCARIO') && txt.includes('POR SPEI INDIVIDUAL'));
  assert.ok(txt.includes('Importe de cargo: $87,000.00'), 'el txt lleva el control del grupo BBVA');
  assert.ok(txt.includes('Importe de cargo: $44,114.80'), 'el txt lleva el control interbancario sin la línea del tope');
  assert.ok(txt.includes('TOTAL A PAGAR: $211,154.80 en 5 operaciones'));
  assert.ok(txt.includes('Operación 1 — Cuenta CLABE:\n030650900032464956'), 'un valor por línea y etiquetado');
  assert.ok(txt.includes('CLABE:\n014650655112091507'), 'la línea de SPEI (García, sobre el tope) también va etiquetada, un valor por línea');

  /* ===== API: catálogo, precarga y cruce por RFC ===== */
  token = (await (await call('/')).text()).match(/content="([^"]+)"/)[1];
  assert.equal((await call('/api/unlock', { rfc: MF, minutes: 1440, days: 7, direction: 'received',
    password: 'simulated', certificate: 'YQ==', key: 'Yg==' })).status, 200);
  assert.deepEqual((await j('/api/pagos/catalog?rfc=' + MF)).beneficiaries, [], 'el catálogo nace vacío');
  const seeded = await j('/api/pagos/catalog', { rfc: MF, action: 'seed' });
  assert.equal(seeded.inserted, 4, 'la precarga mete los 4 beneficiarios verificados de Mano Fil');
  assert.equal(seeded.beneficiaries.length, 4);
  const bg = seeded.beneficiaries.find(b => b.contraparte === 'BAC260401MH8');
  assert.equal(bg.montoTipo, 'fijo');
  assert.equal(bg.base, '9030.00');
  assert.equal(bg.iva, '1444.80');
  const again = await j('/api/pagos/catalog', { rfc: MF, action: 'seed' });
  assert.equal(again.inserted, 0, 'la precarga no duplica si se pulsa dos veces');
  const badSave = await call('/api/pagos/catalog', { rfc: MF, action: 'save',
    beneficiary: { nombre: 'PROVEEDOR MALO SA', contraparte: 'GRC131111298', clabe: '014650655112091508' } });
  assert.equal(badSave.status, 422, 'guardar una CLABE con el control roto se rechaza');
  assert.match((await badSave.json()).error || '', /dígito de control/);
  const base17 = '07201000000000000';
  const otro = await j('/api/pagos/catalog', { rfc: MF, action: 'save',
    beneficiary: { nombre: 'OTRO PROVEEDOR SA', contraparte: 'AAA010101AAA', clabe: base17 + digitoControlClabe(base17),
      concepto: 'SERVICIOS', montoTipo: 'variable' } });
  assert.equal(otro.beneficiaries.length, 5, 'el alta manual entra al catálogo');
  assert.equal(otro.beneficiaries.find(b => b.contraparte === 'AAA010101AAA').banco, 'Banorte',
    'el banco se deduce de la CLABE cuando no se teclea');

  /* Facturas recibidas de noviembre (las del cierre real, de juguete
     en UUID): PUE — el saldo de Dinero las da por pagadas por
     definición, así que la propuesta NO filtra por saldo: excluye
     solo lo marcado pagado a mano o conciliado en bancos. */
  const inv = (id, date, fromRfc, fromName, total, base, iva, folio, method = 'PUE') => ({ id, date, kind: 'I',
    from: { rfc: fromRfc, name: fromName }, to: { rfc: MF, name: 'MANO FIL SA' },
    total, currency: 'MXN', fiscal: { paymentMethod: method, paymentForm: '03',
      transferred: [{ tax: '002', base, amount: iva }], withheld: [], serie: '', folio } });
  const G5166 = '11111111-2222-3333-4444-555555555501';
  const A13564 = '11111111-2222-3333-4444-555555555502';
  const B962 = '11111111-2222-3333-4444-555555555503';
  const B963 = '11111111-2222-3333-4444-555555555504';
  const X999 = '11111111-2222-3333-4444-555555555505';
  assert.equal((await call('/api/storage', { batch: { people: [{ id: MF, name: 'MANO FIL SA' }], invoices: [
    inv(G5166, '2026-11-09', 'GRC131111298', 'GARCIA RIVERA CONTADORES Y CIA', '80040.00', '69000.00', '11040.00', '5166'),
    inv(A13564, '2026-11-09', 'AIC150804PQ2', 'ACEROS INGENIERIA Y CONSTRUCCION RT', '33640.00', '29000.00', '4640.00', '13564'),
    inv(B962, '2026-11-09', 'IPC2502209B0', 'INMOBILIARIA, PROYECTOS Y CONSTRUCCIONES BRISBANE', '74240.00', '64000.00', '10240.00', '962'),
    inv(B963, '2026-11-09', 'IPC2502209B0', 'INMOBILIARIA, PROYECTOS Y CONSTRUCCIONES BRISBANE', '12760.00', '11000.00', '1760.00', '963', 'PPD'),
    inv(X999, '2026-11-05', 'ZZZ010101ZZZ', 'DESCONOCIDO SA', '5000.00', '4310.34', '689.66', '999')
  ] } })).status, 200);
  const proposal = await j('/api/pagos/proposal?rfc=' + MF + '&month=2026-11');
  assert.equal(proposal.lines.length, 5, 'la propuesta trae las 4 facturas cruzadas + el fijo de BG');
  assert.equal(proposal.sinCatalogo.length, 1, 'la factura sin beneficiario se avisa, no se cuela');
  assert.equal(proposal.sinCatalogo[0].emisorRfc, 'ZZZ010101ZZZ');
  const garcia = proposal.lines.find(l => l.folio === '5166');
  assert.equal(garcia.total, '80040.00');
  assert.equal(garcia.base, '69000.00');
  assert.equal(garcia.iva, '11040.00');
  assert.equal(garcia.grupo, 'Interbancario');
  const fijoBg = proposal.lines.find(l => l.fijo);
  assert.equal(fijoBg.total, '10474.80', 'el fijo de BG entra con base + IVA del catálogo');

  /* Marcar pagada a mano la 963: sale de la siguiente propuesta. */
  assert.equal((await call('/api/money/mark-paid', { uuid: B963 })).status, 200);
  const proposal2 = await j('/api/pagos/proposal?rfc=' + MF + '&month=2026-11');
  assert.equal(proposal2.lines.filter(l => l.uuid === B963).length, 0,
    'lo marcado pagado a mano ya no se propone (no se paga dos veces)');

  /* Preparación completa por API: mismos controles que la unidad. */
  const grupoDatos = { descripcion: 'PROVEEDORES MANOFIL', cuentaRetiro: '0444392590', referencia: '112026',
    fechaCargo: '2026-11-10', fechaAbono: '2026-11-11', fechaAplicacion: '2026-11-11' };
  const made = await j('/api/pagos/prepare', { rfc: MF, month: '2026-11', group: grupoDatos, lines: proposal2.lines });
  assert.deepEqual([made.preparation.bbva.operaciones, made.preparation.bbva.totalCents], [1, 7424000],
    'sin la 963, el grupo BBVA queda con la 962: $74,240.00');
  assert.deepEqual([made.preparation.interbancario.operaciones, made.preparation.interbancario.totalCents], [2, 4411480]);
  assert.deepEqual([made.preparation.speiIndividual.operaciones, made.preparation.speiIndividual.totalCents], [1, 8004000]);
  assert.equal(made.preparation.totalCents, 19839480, 'total $198,394.80 tras excluir la 963 pagada');
  assert.ok(made.txt.includes('TOTAL A PAGAR: $198,394.80 en 4 operaciones'));
  const history = await j('/api/pagos/preparations?rfc=' + MF);
  assert.equal(history.preparations.length, 1, 'la preparación queda guardada en el historial');
  assert.equal(history.preparations[0].totalCents, 19839480);

  /* ===== Respaldo: el catálogo y las preparaciones viajan ===== */
  const bakDir = mkdtempSync(join(tmpdir(), 'pacosat-1100-bak-'));
  await service.bootstrap({ backup: { password: 'respaldo-prueba-1100', frequency: 'daily',
    dir: join(bakDir, 'principal'), secondaryDir: join(bakDir, 'secundario') } });
  await service.backupTick(time);
  const faroFiles = readdirSync(join(bakDir, 'principal')).filter(name => name.endsWith('.faro'));
  assert.equal(faroFiles.length, 1);
  const bakData = decryptBackupBuffer(readFileSync(join(bakDir, 'principal', faroFiles[0])), 'respaldo-prueba-1100');
  const operations = bakData.operations;
  assert.equal(operations.pay_beneficiaries.length, 5, 'el respaldo incluye el catálogo (5 beneficiarios)');
  assert.equal(operations.pay_preparations.length, 1, 'el respaldo incluye las preparaciones');
  const service2 = createPacoSATService({ dbFile: ':memory:', html: '<!--PACOSAT_TOKEN-->', origin, proxyKey, now: () => time,
    extractText: async () => '',
    makeConnector: async () => ({ parser: class {}, connector: {
      request: async () => 'req-1100', check: async () => ({ status: 'pending', packages: [] }),
      download: async () => { throw new Error('sin paquetes'); } } }),
    makeMailer: () => ({ verify: async () => true, sendMail: async () => {} }) });
  try {
    token = (await (await call('/', undefined, service2)).text()).split('content="')[1].split('"')[0];
    const restored = await j('/api/backup/operations', operations, service2);
    assert.equal(restored.ok, true);
    assert.equal(restored.counts.pay_beneficiaries, 5, 'la restauración devuelve el catálogo');
    assert.equal(restored.counts.pay_preparations, 1);
    const restoredCatalog = await j('/api/pagos/catalog?rfc=' + MF, undefined, service2);
    assert.equal(restoredCatalog.beneficiaries.length, 5, 'el catálogo restaurado se lee en el servicio vacío');
  } finally { await service2.close(); }

  console.log('OK ronda 1.10.0: validación CLABE/cuenta, precarga de Mano Fil sin duplicar, ' +
    'cruce por RFC con aviso de sin-catálogo, exclusión de lo ya pagado a mano, controles por grupo, ' +
    'tope interbancario a SPEI individual, historial y respaldo con catálogo y preparaciones restaurados.');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally { await service.close(); }
