import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createPacoSATService, pacosatCriteriaKey } from './local-server.mjs';
import { X509Certificate } from 'node:crypto';
import { invoiceCandidates } from './pdf-invoice.mjs';
import { crc32 } from './xml-core.mjs';
import { decryptBackupBuffer } from './backup-core.mjs';
const id = '12345678-1234-1234-1234-1234567890AB';
assert.deepEqual(invoiceCandidates('RFC: XAXX010101000 Folio: ' + id.toLowerCase() + ' ' + id), {
  uuids: [id], rfcs: ['XAXX010101000'], hasText: true
});
assert.equal(invoiceCandidates('   ').hasText, false);
const origin = 'https://pacosat.example.com';
const proxyKey = 'a'.repeat(64);
const service = createPacoSATService({ dbFile: ':memory:', origin, proxyKey, html: '<!--PACOSAT_TOKEN-->',
  analyzePdf: async data => { assert.equal(data.toString(), '%PDF-1.7'); return { uuids: [id], rfcs: [], hasText: true }; } });
let token;
async function request(url, data, overrides = {}) {
  const req = Object.assign(Readable.from(data === undefined ? [] : [Buffer.from(JSON.stringify(data))]), {
    url, method: data === undefined ? 'GET' : 'POST',
    headers: { origin, host: 'pacosat.example.com', 'x-pacosat-proxy': proxyKey, 'x-pacosat-token': token, ...overrides }
  });
  let response;
  await service.handle(req, { setHeader() {}, writeHead(status) { this.status = status; this.headersSent = true; },
    end(payload) { response = new Response(payload, { status: this.status }); } });
  return response;
}
try {
  assert.equal((await request('/', undefined, { 'x-pacosat-proxy': '' })).status, 403);
  const html = await (await request('/')).text();
  token = html.match(/name="pacosat-token" content="([^"]+)"/)[1];
  assert.ok(html.includes('name="pacosat-cloud"'));
  assert.deepEqual((await (await request('/api/pdf-analyze', { data: Buffer.from('%PDF-1.7').toString('base64') })).json()).uuids, [id]);
  const people = [{ id: 'XAXX010101000', name: 'Ejemplo' }];
  const files = [{ id: 'pdf:example', mime: 'application/pdf', content: Buffer.from('%PDF-1.7').toString('base64') }];
  assert.equal((await request('/api/storage', { batch: { people, files } })).status, 200);
  assert.deepEqual(await (await request('/api/storage?store=people')).json(), people);
  assert.deepEqual(await (await request('/api/storage?store=files&id=pdf%3Aexample')).json(), files[0]);
  assert.equal((await request('/api/storage', { batch: { people: [], fake: [] }, replace: true })).status, 400);
  assert.deepEqual(await (await request('/api/storage?store=people')).json(), people);
  const before = (await (await request('/api/status')).json()).cloudRevision;
  const renamed = [{ ...people[0], name: 'Nombre actualizado' }];
  assert.equal((await request('/api/storage', { batch: { people: renamed } })).status, 200);
  assert.deepEqual(await (await request('/api/storage?store=people')).json(), renamed);
  /* Borrado puntual (UX-07, 1.6.11): elimina solo los ids pedidos. */
  const deleted = await (await request('/api/data/delete', { store: 'people', ids: [renamed[0].id] })).json();
  assert.equal(deleted.removed, 1);
  assert.deepEqual(await (await request('/api/storage?store=people')).json(), []);
  assert.equal((await request('/api/data/delete', { store: 'fake', ids: ['x'] })).status, 400);
  assert.notEqual((await (await request('/api/status')).json()).cloudRevision, before);
  console.log('OK: control del proxy, almacenamiento central, actualización, revisión, transacción y candidatos PDF.');
} finally { service.close(); }

// --- Carpeta vigilada y respaldo programado (1.6.0) ---
const cfdiNs = 'http://www.sat.gob.mx/cfd/4';
const tfdNs = 'http://www.sat.gob.mx/TimbreFiscalDigital';
class FixtureParser {
  parseFromString(xml) {
    const node = (localName, data = {}, children = [], namespaceURI = cfdiNs) => ({
      localName, namespaceURI, nodeType: 1, childNodes: children,
      getAttribute: name => data[name] || '',
      getElementsByTagNameNS: (namespace, name) => children.filter(child => child.namespaceURI === namespace && child.localName === name)
    });
    const expected = xml.includes('mismatch') ? 'XEXX010101000' : 'XAXX010101000';
    const documentElement = node('Comprobante', {
      Fecha: '2026-11-08T07:00:00', Total: '80.00', Moneda: 'MXN', TipoDeComprobante: 'I'
    }, [
      node('Emisor', { Rfc: 'AAA010101AAA' }), node('Receptor', { Rfc: expected }),
      node('Complemento', {}, [node('TimbreFiscalDigital', { UUID: id }, [], tfdNs)])
    ]);
    return { documentElement, getElementsByTagName: () => [] };
  }
}
function zipOf(payload) {
  const raw = Buffer.from(payload), name = Buffer.from('test.xml');
  const local = Buffer.alloc(30), central = Buffer.alloc(46), end = Buffer.alloc(22);
  local.writeUInt32LE(0x04034b50); local.writeUInt16LE(name.length, 26);
  central.writeUInt32LE(0x02014b50); central.writeUInt32LE(crc32(raw), 16);
  central.writeUInt32LE(raw.length, 20); central.writeUInt32LE(raw.length, 24); central.writeUInt16LE(name.length, 28);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(local.length + name.length + raw.length, 16);
  return Buffer.concat([local, name, raw, central, name, end]);
}
let watchTime = Date.parse('2026-11-08T16:00:00Z');
const watchSent = [];
const base = mkdtempSync(join(tmpdir(), 'pacosat-160-'));
const inboxDir = join(base, 'vigilada'); mkdirSync(inboxDir);
const backupDir = join(base, 'respaldos');
const watchService = createPacoSATService({ dbFile: ':memory:', origin, proxyKey, html: '<!--PACOSAT_TOKEN-->',
  now: () => watchTime, watchDir: inboxDir, inboxParser: FixtureParser,
  analyzePdf: async data => data.includes('sin-vinculo')
    ? { uuids: ['12345678-1234-1234-1234-1234567890CD'], rfcs: [], hasText: true }
    : { uuids: [id], rfcs: [], hasText: true },
  makeMailer: () => ({ verify: async () => true, sendMail: async payload => { watchSent.push(payload); } }) });
let watchToken;
async function watchRequest(url, data) {
  const req = Object.assign(Readable.from(data === undefined ? [] : [Buffer.from(JSON.stringify(data))]), {
    url, method: data === undefined ? 'GET' : 'POST',
    headers: { origin, host: 'pacosat.example.com', 'x-pacosat-proxy': proxyKey, 'x-pacosat-token': watchToken }
  });
  let response;
  await watchService.handle(req, { setHeader() {}, writeHead(status) { this.status = status; this.headersSent = true; },
    end(payload) { response = new Response(payload, { status: this.status }); } });
  return response;
}
try {
  watchToken = (await (await watchRequest('/')).text()).match(/name="pacosat-token" content="([^"]+)"/)[1];
  assert.equal((await watchRequest('/api/storage', { batch: { people: [{ id: 'XAXX010101000', name: 'Ejemplo' }] } })).status, 200);
  await watchService.bootstrap({ backup: { password: 'respaldo-prueba-16', frequency: 'daily', dir: backupDir },
    mail: { host: 'smtp.example.com', port: 587, from: 'from@example.com', recipient: 'to@example.com', user: '', password: '' } });
  writeFileSync(join(inboxDir, 'lote.zip'), zipOf('<fixture/>'));
  writeFileSync(join(inboxDir, 'suelto.xml'), '<fixture/>');
  writeFileSync(join(inboxDir, 'malo.xml'), '<mismatch/>');
  await watchService.inboxTick(watchTime);
  const storedInvoices = await (await watchRequest('/api/storage?store=invoices')).json();
  assert.equal(storedInvoices.length, 1);
  assert.equal(storedInvoices[0].id, id);
  assert.ok(existsSync(join(inboxDir, 'procesados', '2026-11-08', 'lote.zip')));
  assert.ok(existsSync(join(inboxDir, 'procesados', '2026-11-08', 'suelto.xml')));
  assert.ok(existsSync(join(inboxDir, 'errores', 'malo.xml')));
  let status = (await (await watchRequest('/api/status')).json());
  assert.equal(status.watchFolder.enabled, true);
  assert.equal(status.watchFolder.failed, 1);
  const log = await (await watchRequest('/api/storage?store=activity')).json();
  assert.ok(log.some(row => row.name === 'Carpeta vigilada' && row.added === 1 && row.duplicates === 1 && row.review === 1));
  await watchService.tick();
  /* 1.7.4: el aviso de la carpeta vigilada vive en el Centro y se
     nombra en el cuerpo del único correo-resumen del día. */
  assert.equal(watchSent.filter(mail => /carpeta vigilada no se importó/.test(mail.text || '')).length, 1);
  writeFileSync(join(inboxDir, 'factura.pdf'), '%PDF-1.7 vinculado');
  writeFileSync(join(inboxDir, 'sin-vinculo.pdf'), '%PDF-1.7 sin-vinculo');
  await watchService.inboxTick(watchTime);
  const storedDocs = await (await watchRequest('/api/storage?store=documents')).json();
  assert.equal(storedDocs.length, 1);
  assert.equal(storedDocs[0].uuid, id);
  assert.ok(existsSync(join(inboxDir, 'errores', 'sin-vinculo.pdf')));
  await watchService.backupTick(watchTime);
  const made = readdirSync(backupDir).filter(name => name.endsWith('.faro'));
  assert.deepEqual(made, ['PacoSAT-2026-11-08.faro']);
  const { readFileSync } = await import('node:fs');
  const restored = decryptBackupBuffer(readFileSync(join(backupDir, made[0])), 'respaldo-prueba-16');
  assert.equal(restored.version, 2);
  assert.equal(restored.people[0].id, 'XAXX010101000');
  assert.equal(restored.invoices.length, 1);
  await watchService.backupTick(watchTime + 3600000);
  assert.equal(readdirSync(backupDir).filter(name => name.endsWith('.faro')).length, 1);
  status = (await (await watchRequest('/api/status')).json());
  assert.equal(status.scheduledBackup.enabled, true);
  assert.equal(status.scheduledBackup.error, '');
  console.log('OK: carpeta vigilada importa XML/ZIP, vincula PDF, aparta errores con aviso y respaldo programado cifrado compatible.');
} finally { watchService.close(); }

// --- Carpeta vigilada recursiva: subcarpetas (1.6.3) ---
const deepTime = Date.parse('2026-11-09T15:00:00Z');
const deepSent = [];
const deepDir = join(base, 'vigilada-profunda'); mkdirSync(deepDir);
const deepService = createPacoSATService({ dbFile: ':memory:', origin, proxyKey, html: '<!--PACOSAT_TOKEN-->',
  now: () => deepTime, watchDir: deepDir, inboxParser: FixtureParser,
  analyzePdf: async data => data.includes('sin-vinculo')
    ? { uuids: ['12345678-1234-1234-1234-1234567890CD'], rfcs: [], hasText: true }
    : { uuids: [id], rfcs: [], hasText: true },
  makeMailer: () => ({ verify: async () => true, sendMail: async payload => { deepSent.push(payload); } }) });
let deepToken;
async function deepRequest(url, data) {
  const req = Object.assign(Readable.from(data === undefined ? [] : [Buffer.from(JSON.stringify(data))]), {
    url, method: data === undefined ? 'GET' : 'POST',
    headers: { origin, host: 'pacosat.example.com', 'x-pacosat-proxy': proxyKey, 'x-pacosat-token': deepToken }
  });
  let response;
  await deepService.handle(req, { setHeader() {}, writeHead(status) { this.status = status; this.headersSent = true; },
    end(payload) { response = new Response(payload, { status: this.status }); } });
  return response;
}
const countTree = dir => !existsSync(dir) ? 0 : readdirSync(dir, { withFileTypes: true })
  .reduce((total, entry) => total + (entry.isDirectory() ? countTree(join(dir, entry.name)) : 1), 0);
try {
  deepToken = (await (await deepRequest('/')).text()).match(/name="pacosat-token" content="([^"]+)"/)[1];
  assert.equal((await deepRequest('/api/storage', { batch: { people: [{ id: 'XAXX010101000', name: 'Ejemplo' }] } })).status, 200);
  await deepService.bootstrap({ mail: { host: 'smtp.example.com', port: 587, from: 'from@example.com',
    recipient: 'to@example.com', user: '', password: '' } });
  // Árbol anidado de 3 niveles, exclusiones y trampas del escaneo.
  mkdirSync(join(deepDir, '2025', 'enero'), { recursive: true });
  mkdirSync(join(deepDir, 'a', 'b', 'c'), { recursive: true });
  mkdirSync(join(deepDir, 'x', 'y', 'z'), { recursive: true });
  mkdirSync(join(deepDir, 'real'), { recursive: true });
  mkdirSync(join(deepDir, 'procesados'), { recursive: true });
  mkdirSync(join(deepDir, 'errores'), { recursive: true });
  writeFileSync(join(deepDir, 'raiz.xml'), '<fixture/>');
  writeFileSync(join(deepDir, '2025', 'enero', 'otro.xml'), '<fixture/>');
  writeFileSync(join(deepDir, 'a', 'b', 'c', 'profundo.xml'), '<fixture/>');
  writeFileSync(join(deepDir, 'real', 'dentro.xml'), '<fixture/>');
  writeFileSync(join(deepDir, 'x', 'y', 'z', 'malo.xml'), '<mismatch/>');
  writeFileSync(join(deepDir, 'procesados', 'semilla.xml'), '<fixture/>');
  writeFileSync(join(deepDir, 'errores', 'previo.xml'), '<fixture/>');
  writeFileSync(join(deepDir, '.oculto.xml'), '<fixture/>');
  symlinkSync(join(deepDir, 'real'), join(deepDir, 'atajo'), 'dir');
  await deepService.inboxTick(deepTime);
  const deepInvoices = await (await deepRequest('/api/storage?store=invoices')).json();
  assert.equal(deepInvoices.length, 1);
  assert.equal(deepInvoices[0].id, id);
  const okDay = join(deepDir, 'procesados', '2026-11-09');
  assert.ok(existsSync(join(okDay, 'raiz.xml')));
  assert.ok(existsSync(join(okDay, '2025', 'enero', 'otro.xml')));
  assert.ok(existsSync(join(okDay, 'a', 'b', 'c', 'profundo.xml')));
  assert.ok(existsSync(join(okDay, 'real', 'dentro.xml')));
  assert.ok(!existsSync(join(okDay, 'atajo')));
  assert.ok(existsSync(join(deepDir, 'errores', 'x', 'y', 'z', 'malo.xml')));
  // Las carpetas de salida no se reescanean y lo oculto no se toca.
  assert.ok(existsSync(join(deepDir, 'procesados', 'semilla.xml')));
  assert.ok(existsSync(join(deepDir, 'errores', 'previo.xml')));
  assert.ok(existsSync(join(deepDir, '.oculto.xml')));
  let deepStatus = (await (await deepRequest('/api/status')).json());
  assert.equal(deepStatus.watchFolder.subfolders, true);
  assert.equal(deepStatus.watchFolder.failed, 1);
  const deepLog = await (await deepRequest('/api/storage?store=activity')).json();
  const firstScan = deepLog.find(row => row.name === 'Carpeta vigilada');
  assert.equal(firstScan.added, 1);
  assert.equal(firstScan.duplicates, 3);
  assert.equal(firstScan.review, 1);
  assert.ok(firstScan.issues.some(issue => issue.name === 'x/y/z/malo.xml'));
  await deepService.tick();
  /* 1.7.4: el aviso vive en el Centro y se nombra, con su detalle
     (el archivo que falló), en el cuerpo del único correo-resumen. */
  const watchMails = deepSent.filter(mail => /carpeta vigilada no se importó/.test(mail.text || ''));
  assert.equal(watchMails.length, 1);
  assert.ok(watchMails[0].text.includes('x/y/z/malo.xml'));
  // Segundo ciclo sin novedades: nada se reimporta (sin bucles entre ciclos).
  await deepService.inboxTick(deepTime);
  assert.equal((await (await deepRequest('/api/storage?store=invoices')).json()).length, 1);
  assert.equal(countTree(okDay), 4);
  assert.equal(countTree(join(deepDir, 'errores')), 2);
  // PDF en subcarpeta que se vincula y homónimos que no se pisan.
  mkdirSync(join(deepDir, 'docs'), { recursive: true });
  mkdirSync(join(deepDir, 'uno'), { recursive: true });
  mkdirSync(join(deepDir, 'dos'), { recursive: true });
  writeFileSync(join(deepDir, 'docs', 'factura.pdf'), '%PDF-1.7 vinculado');
  writeFileSync(join(deepDir, 'uno', 'dup.xml'), '<fixture/>');
  writeFileSync(join(deepDir, 'dos', 'dup.xml'), '<fixture/>');
  mkdirSync(join(okDay, 'uno'), { recursive: true });
  writeFileSync(join(okDay, 'uno', 'dup.xml'), 'sentinela');
  await deepService.inboxTick(deepTime);
  const deepDocs = await (await deepRequest('/api/storage?store=documents')).json();
  assert.equal(deepDocs.length, 1);
  assert.equal(deepDocs[0].uuid, id);
  assert.equal(deepDocs[0].name, 'docs/factura.pdf');
  assert.ok(existsSync(join(okDay, 'docs', 'factura.pdf')));
  const { readFileSync: readDeep } = await import('node:fs');
  assert.equal(readDeep(join(okDay, 'uno', 'dup.xml'), 'utf8'), 'sentinela');
  assert.ok(existsSync(join(okDay, 'uno', 'dup (2).xml')));
  assert.ok(existsSync(join(okDay, 'dos', 'dup.xml')));
  // Tope de 20 por ciclo con reanudación en el siguiente, sin duplicar.
  mkdirSync(join(deepDir, 'cap'), { recursive: true });
  for (let n = 1; n <= 25; n++) writeFileSync(join(deepDir, 'cap', 'f' + String(n).padStart(2, '0') + '.xml'), '<fixture/>');
  await deepService.inboxTick(deepTime);
  assert.equal(countTree(join(deepDir, 'cap')), 5);
  assert.equal(countTree(join(okDay, 'cap')), 20);
  await deepService.inboxTick(deepTime);
  assert.equal(countTree(join(deepDir, 'cap')), 0);
  assert.equal(countTree(join(okDay, 'cap')), 25);
  assert.equal((await (await deepRequest('/api/storage?store=invoices')).json()).length, 1);
  deepStatus = (await (await deepRequest('/api/status')).json());
  assert.equal(deepStatus.watchFolder.imported, 32);
  assert.equal(deepStatus.watchFolder.failed, 1);
  console.log('OK: carpeta vigilada recursiva importa el árbol, excluye salidas, conserva rutas, respeta el tope y no duplica.');
} finally { deepService.close(); }

const failService = createPacoSATService({ dbFile: ':memory:', origin, proxyKey, html: '<!--PACOSAT_TOKEN-->',
  now: () => watchTime,
  makeMailer: () => ({ verify: async () => true, sendMail: async payload => { watchSent.push(payload); } }) });
try {
  const blocker = join(base, 'no-es-carpeta');
  writeFileSync(blocker, 'x');
  await failService.bootstrap({ backup: { password: 'respaldo-prueba-16', frequency: 'daily', dir: join(blocker, 'sub') },
    mail: { host: 'smtp.example.com', port: 587, from: 'from@example.com', recipient: 'to@example.com', user: '', password: '' } });
  await failService.backupTick(watchTime);
  await failService.tick();
  /* 1.7.4: el aviso vive en el Centro y se nombra en el cuerpo del
     único correo-resumen (ya no sale un correo por cada fallo). */
  assert.ok(watchSent.some(mail => /respaldo programado falló/.test(mail.text || '')));
  console.log('OK: el fallo del respaldo programado deja error visible y aviso en el Centro y en el resumen.');
} finally { failService.close(); }

// --- 1.6.4: respaldo con estado operativo, destino secundario y prueba ---
function harnessFor(svc) {
  const state = { token: '' };
  const call = async (path, data) => {
    const headers = { host: 'pacosat.example.com', origin, 'x-pacosat-proxy': proxyKey, 'x-pacosat-token': state.token };
    const req = Object.assign(Readable.from(data === undefined ? [] : [Buffer.from(JSON.stringify(data))]), {
      url: path, method: data === undefined ? 'GET' : 'POST', headers });
    let response;
    const res = { setHeader() {}, writeHead(status) { this.status = status; this.headersSent = true; },
      end(content) { response = new Response(content, { status: this.status }); } };
    await svc.handle(req, res);
    return response;
  };
  return { call, init: async () => { state.token = (await (await call('/')).text()).match(/content="([^"]+)"/)[1]; } };
}
const bakBase = mkdtempSync(join(tmpdir(), 'pacosat-164-bak-'));
const bakPrimary = join(bakBase, 'principal'), bakSecondary = join(bakBase, 'secundario');
let bakTime = Date.parse('2026-11-09T15:00:00Z');
const bakService = createPacoSATService({ dbFile: ':memory:', origin, proxyKey, html: '<!--PACOSAT_TOKEN-->',
  now: () => bakTime,
  makeConnector: async () => ({ parser: FixtureParser, connector: {
    request: async options => 'bak-req-' + options.start,
    check: async id => id === 'bak-req-2026-10-01' ? { status: 'rejected', packages: [], code: 5002 } : { status: 'pending', packages: [] },
    download: async () => { throw new Error('sin paquetes'); } } }),
  makeMailer: () => ({ verify: async () => true, sendMail: async () => { throw new Error('SMTP caído (simulado)'); } }) });
const bakApi = harnessFor(bakService);
try {
  await bakApi.init();
  await bakService.bootstrap({ mail: { host: 'smtp.example.com', port: 587, from: 'from@example.com',
    recipient: 'to@example.com', user: '', password: '' } });
  assert.equal((await bakApi.call('/api/unlock', { rfc: 'XAXX010101000', minutes: 1440, days: 7, direction: 'received',
    password: 'simulated', certificate: 'YQ==', key: 'Yg==' })).status, 200);
  /* 1.15.0: la descarga automática mensual tiene su propia suite
     (ronda1150); aquí se apaga para que el respaldo viaje con los
     trabajos de este escenario y nada más. */
  assert.equal((await bakApi.call('/api/monthly/config', { enabled: false, day: 5, hour: 9 })).status, 200);
  assert.equal((await bakApi.call('/api/request', { rfc: 'XAXX010101000', direction: 'received', start: '2026-10-01', end: '2026-10-07' })).status, 200);
  assert.equal((await bakApi.call('/api/request', { rfc: 'XAXX010101000', direction: 'received', start: '2026-10-08', end: '2026-10-14' })).status, 200);
  bakTime += 5 * 60000;
  await bakService.tick();
  await bakService.bootstrap({ backup: { password: 'respaldo-prueba-164', frequency: 'daily', dir: bakPrimary, secondaryDir: bakSecondary } });
  await bakService.backupTick(bakTime);
  const primaryFiles = readdirSync(bakPrimary).filter(name => name.endsWith('.faro'));
  const secondaryFiles = readdirSync(bakSecondary).filter(name => name.endsWith('.faro'));
  assert.equal(primaryFiles.length, 1);
  assert.equal(secondaryFiles.length, 1);
  const bakData = decryptBackupBuffer(readFileSync(join(bakSecondary, secondaryFiles[0])), 'respaldo-prueba-164');
  assert.equal(bakData.version, 2);
  const ops = bakData.operations;
  assert.equal(ops.version, 1);
  assert.equal(ops.packagesArchiveOmitted, true);
  assert.equal(ops.profiles.length, 1);
  assert.equal(ops.jobs.length, 3); /* 1.6.10: viaja también el job diario de Metadata */
  assert.equal(ops.criteria.length, 3); /* y su criterio (tipo metadata) */
  assert.equal(ops.criteria_exhausted.length, 1);
  assert.ok(ops.alerts.length >= 1, 'las alertas pendientes viajan en el respaldo');
  assert.equal(ops.jobs.find(job => job.periodStart === '2026-10-01').status, 'rejected');
  assert.equal(ops.jobs.find(job => job.periodStart === '2026-10-08').checks, 1);
  assert.ok(ops.automation_state.some(row => row.key === 'ledger:seeded'));
  const verifyRes = await bakApi.call('/api/backup/verify', {});
  assert.equal(verifyRes.status, 200);
  assert.equal((await verifyRes.json()).ok, true);
  const bakStatus = await (await bakApi.call('/api/status')).json();
  assert.equal(bakStatus.scheduledBackup.verify.ok, true);
  assert.equal(bakStatus.scheduledBackup.secondary, true);
  const bakActivity = await (await bakApi.call('/api/storage?store=activity')).json();
  assert.ok(bakActivity.some(row => row.name === 'Prueba de restauración'));
  const bak2 = createPacoSATService({ dbFile: ':memory:', origin, proxyKey, html: '<!--PACOSAT_TOKEN-->',
    makeMailer: () => ({ verify: async () => true, sendMail: async () => {} }) });
  const bak2Api = harnessFor(bak2);
  try {
    await bak2Api.init();
    assert.equal((await bak2Api.call('/api/backup/operations', ops)).status, 200);
    const restored = await (await bak2Api.call('/api/status')).json();
    assert.equal(restored.profiles.length, 1);
    assert.equal(restored.jobs.length, 3); /* 1.6.10: también se restaura el job de Metadata */
    assert.equal(restored.jobs.find(job => job.periodStart === '2026-10-01').criteriaState, 'agotado');
    assert.equal(restored.jobs.find(job => job.periodStart === '2026-10-08').checks, 1);
    assert.equal((await bak2Api.call('/api/backup/verify', {})).status, 400);
  } finally { bak2.close(); }
  console.log('OK: respaldo 1.6.4 con estado operativo (cola, libro 5002, agotados, alertas pendientes), destino secundario cifrado, restauración del estado y prueba de restauración registrada.');
} finally { bakService.close(); }

// --- 1.6.4: cobertura por RFC, huecos y micro-huecos, conciliación ---
const covBase = mkdtempSync(join(tmpdir(), 'pacosat-164-cov-'));
const covFile = join(covBase, 'cobertura.sqlite');
{
  const boot = createPacoSATService({ dbFile: covFile, origin, proxyKey, html: '<!--PACOSAT_TOKEN-->',
    makeMailer: () => ({ verify: async () => true, sendMail: async () => {} }) });
  boot.close();
  const seed = new DatabaseSync(covFile);
  seed.prepare("INSERT INTO profiles(rfc,minutes,days,direction,nextRun,error) VALUES ('XAXX010101000',1440,7,'received',0,'')").run();
  const insertJob = seed.prepare("INSERT INTO jobs(rfc,direction,periodStart,periodEnd,startAt,endAt,requestId,status,imported,due,created,error,checks) VALUES ('XAXX010101000','received',?,?,?,?,?,?,'[]',0,?,'',0)");
  insertJob.run('2026-09-01', '2026-09-07', '2026-09-01 00:00:00', '2026-09-07 23:59:59', 'cov-1', 'finished', Date.parse('2026-09-08T15:00:00Z'));
  insertJob.run('2026-09-08', '2026-09-14', '2026-09-08 00:00:02', '2026-09-14 23:59:59', 'cov-2', 'finished', Date.parse('2026-09-15T15:00:00Z'));
  insertJob.run('2026-09-20', '2026-09-26', '2026-09-20 00:00:00', '2026-09-26 23:59:59', 'cov-3', 'finished', Date.parse('2026-09-27T15:00:00Z'));
  insertJob.run('2026-11-03', '2026-11-09', '2026-11-03 00:00:00', '2026-11-09 23:59:59', 'cov-4', 'pending', Date.parse('2026-11-09T15:00:00Z'));
  insertJob.run('2026-08-03', '2026-08-09', '2026-08-03 00:00:00', '2026-08-09 23:59:59', 'cov-5', 'rejected', Date.parse('2026-08-10T15:00:00Z'));
  const covCriteria = { rfc: 'XAXX010101000', direction: 'received', type: 'cfdi', emitter: '', receiver: '',
    startAt: '2026-08-01 00:00:00', endAt: '2026-08-07 23:59:59' };
  const covKey = pacosatCriteriaKey(covCriteria);
  seed.prepare("INSERT INTO criteria(key,rfc,direction,type,emitter,receiver,startAt,endAt,requestId,origin,sentAt) VALUES (?,?,?,?,?,?,?,?,?,'manual',?)")
    .run(covKey, covCriteria.rfc, covCriteria.direction, covCriteria.type, '', '', covCriteria.startAt, covCriteria.endAt, 'cov-0', Date.parse('2026-08-08T15:00:00Z'));
  seed.prepare("INSERT INTO criteria_exhausted(key,learnedAt,detail) VALUES (?,?,?)").run(covKey, Date.parse('2026-08-08T15:00:00Z'), 'cov-0');
  seed.close();
}
const covService = createPacoSATService({ dbFile: covFile, origin, proxyKey, html: '<!--PACOSAT_TOKEN-->',
  now: () => Date.parse('2026-11-09T15:00:00Z'),
  makeMailer: () => ({ verify: async () => true, sendMail: async () => {} }) });
const covApi = harnessFor(covService);
try {
  await covApi.init();
  const covStatus = await (await covApi.call('/api/status')).json();
  const group = covStatus.coverage.groups.find(row => row.rfc === 'XAXX010101000' && row.direction === 'received');
  assert.equal(group.verifiedUntil, '2026-09-07 23:59:59');
  assert.equal(group.covered.length, 3);
  assert.equal(group.pending, 1);
  assert.equal(group.failed, 1);
  assert.equal(group.exhausted, 1);
  assert.equal(covStatus.coverage.gaps.length, 2);
  const micro = covStatus.coverage.gaps.find(gap => gap.micro);
  assert.ok(micro, 'la costura de la ventana desplazada se marca como micro-hueco');
  assert.equal(micro.seconds, 2);
  assert.ok(covStatus.coverage.gaps.some(gap => !gap.micro));
  assert.ok(covStatus.coverage.days['XAXX010101000'].received.includes('2026-09-03'));
  assert.ok(!covStatus.coverage.days['XAXX010101000'].received.includes('2026-09-17'));
  await covService.tick();
  const covActivity = await (await covApi.call('/api/storage?store=activity')).json();
  const notes = covActivity.filter(row => row.name === 'Conciliación de cobertura');
  assert.equal(notes.length, 1);
  assert.match(notes[0].event, /micro-hueco/);
  await covService.tick();
  const covActivity2 = await (await covApi.call('/api/storage?store=activity')).json();
  assert.equal(covActivity2.filter(row => row.name === 'Conciliación de cobertura').length, 1);
  console.log('OK: cobertura por RFC con verificado-hasta, hueco real y micro-hueco de costura, mapa de días y conciliación en bitácora sin repetir.');
} finally { covService.close(); }

// --- 1.6.4: ingesta robusta en la carpeta vigilada ---
function zipOfMany(entries) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, payload] of entries) {
    const raw = Buffer.from(payload), nameBuffer = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc32(raw), 14); local.writeUInt32LE(raw.length, 18); local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    locals.push(local, nameBuffer, raw);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc32(raw), 16); central.writeUInt32LE(raw.length, 20); central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28); central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuffer);
    offset += local.length + nameBuffer.length + raw.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centrals.reduce((sum, part) => sum + part.length, 0), 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}
const robBase = mkdtempSync(join(tmpdir(), 'pacosat-164-rob-'));
const robDir = join(robBase, 'vigilada'); mkdirSync(join(robDir, 'lotes'), { recursive: true });
const robSent = [];
let robTime = Date.parse('2026-11-09T15:00:00Z');
const robService = createPacoSATService({ dbFile: ':memory:', origin, proxyKey, html: '<!--PACOSAT_TOKEN-->',
  now: () => robTime, watchDir: robDir, inboxParser: FixtureParser, watchSettleMs: 60,
  analyzePdf: async () => ({ uuids: [id], rfcs: [], hasText: true }),
  makeMailer: () => ({ verify: async () => true, sendMail: async payload => { robSent.push(payload); } }) });
const robApi = harnessFor(robService);
try {
  await robApi.init();
  await robService.bootstrap({ mail: { host: 'smtp.example.com', port: 587, from: 'from@example.com',
    recipient: 'to@example.com', user: '', password: '' } });
  assert.equal((await robApi.call('/api/storage', { batch: { people: [{ id: 'XAXX010101000', name: 'Ejemplo' }] } })).status, 200);
  writeFileSync(join(robDir, 'crece.xml'), '<fixture/>');
  const pendingTick = robService.inboxTick(robTime);
  setTimeout(() => appendFileSync(join(robDir, 'crece.xml'), ' '), 15);
  await pendingTick;
  assert.ok(existsSync(join(robDir, 'crece.xml')), 'el archivo que crece durante el ciclo no se procesa a medias');
  let robStatus = await (await robApi.call('/api/status')).json();
  assert.equal(robStatus.watchFolder.waiting, 1);
  assert.equal(robStatus.watchFolder.imported, 0);
  robTime += 60000;
  await robService.inboxTick(robTime);
  assert.ok(!existsSync(join(robDir, 'crece.xml')));
  const processedDays = readdirSync(join(robDir, 'procesados'));
  assert.ok(readdirSync(join(robDir, 'procesados', processedDays[0])).includes('crece.xml'));
  robStatus = await (await robApi.call('/api/status')).json();
  assert.equal(robStatus.watchFolder.waiting, 0);
  writeFileSync(join(robDir, 'grande.xml'), Buffer.alloc(8 * 1024 * 1024 + 1));
  robTime += 60000;
  await robService.inboxTick(robTime);
  assert.ok(existsSync(join(robDir, 'errores', 'grande.xml')));
  const robActivity = await (await robApi.call('/api/storage?store=activity')).json();
  assert.ok(robActivity.some(row => (row.issues || []).some(issue => issue.name === 'grande.xml' && /supera 8 MB/.test(issue.reason))));
  writeFileSync(join(robDir, 'lotes', 'mixto.zip'), zipOfMany([['bueno.xml', '<fixture/>'], ['malo.xml', '<mismatch/>']]));
  robTime += 60000;
  await robService.inboxTick(robTime);
  assert.ok(existsSync(join(robDir, 'incidencias', 'lotes', 'mixto.zip')));
  robStatus = await (await robApi.call('/api/status')).json();
  assert.equal(robStatus.watchFolder.incidents, 1);
  const robActivity2 = await (await robApi.call('/api/storage?store=activity')).json();
  assert.ok(robActivity2.some(row => (row.issues || []).some(issue => issue.name === 'lotes/mixto.zip · malo.xml')));
  await robService.tick();
  /* 1.7.4: el aviso de incidencias vive en el Centro y se nombra en
     el cuerpo del único correo-resumen del día. */
  assert.ok(robSent.some(mail => /con incidencias/.test(mail.text || '')));
  robTime += 60000;
  await robService.inboxTick(robTime);
  robStatus = await (await robApi.call('/api/status')).json();
  assert.equal(robStatus.watchFolder.incidents, 1);
  console.log('OK: ingesta robusta: archivo que crece espera a estabilizarse, tamaño rechazado antes de leer, ZIP mixto a incidencias con desglose por archivo y aviso.');
} finally { robService.close(); }

// --- 1.6.5: caducidad de la e.firma con avisos por umbral ---
/* Certificado autofirmado de PRUEBA generado para esta suite (su llave
   privada no está en el repo y el conector SAT está simulado): solo se
   usa para comprobar que el servidor lee y persiste su notAfter real. */
const CERT_B64 = 'MIIDEzCCAfugAwIBAgIUfFs/rHFz67k3fvC0q/J/MXrXGY0wDQYJKoZIhvcNAQELBQAwGTEXMBUGA1UEAwwOUGFjb1NBVCBQcnVlYmEwHhcNMjYxMTA5MDEwNDUxWhcNMzYxMTA2MDEwNDUxWjAZMRcwFQYDVQQDDA5QYWNvU0FUIFBydWViYTCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBALapu0VKqM0A+oN20MgwDgfjCV78C+snlMJTe2t4M+fYR1EU5fx4U0hmcA9vjErIlNfEpG3CVg+cf7M7w56IbCTcQ36g3/4rmGv1E9WBeb5iGxu0XrxGcj/rHFxW8p0UFjfqJf2qM+SfYSscg2jw/xsD730N9z5C1Q0FPF3n3ygekeL871HFINvo9uxlMLwK2crdU4NFJzARMlV6LZlvi+9l1jmGOzgP/Ldg1uhJThWoH2th36/NcAnIhaUXFQtoRb6MlMT9WWLDAJMpLcmrGLfFhbZkz+svrM6bz51P9xJECCxinHTiEF00hSaD2ceWfgNMFG4SNbjz1zJucaiC0tsCAwEAAaNTMFEwHQYDVR0OBBYEFNk7BZ5VXVB+IQ5edFRi/NkvKodZMB8GA1UdIwQYMBaAFNk7BZ5VXVB+IQ5edFRi/NkvKodZMA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZIhvcNAQELBQADggEBAGu4dnfasM2J9JClmUYc+dLrrRgJ5/jbEGNSng61Ydm9vqDuFnGZ4jBPtIIiAX9zdKfxM0pgkzJrdI6N1F5X3zxoIlRKYePlOqL2Wiz2XSvFT/6m8m1X8oN3tKYTp4jgcapmJvX+7rJjX73fRAYeklnLvhIsGcNPWhHilnhS6bccxDmYnR2JEcdwqomZem7QhKGNXMmljIVv3Q6GrERk0sFzvau3xDdLhmJyOKAM06x3xIv9MDOiPFSHdZbNqCXlQaBVmx3/UCEssgXiFi2D6HOg0T4dFNoswqi34gporXtb/MwaJjv5+Icb0StMVAjOypFMdHQtdNTE+U2WzxDHBvU=';
const certExpected = Date.parse(new X509Certificate(Buffer.from(CERT_B64, 'base64')).validTo);
let certTime = certExpected - 100 * 86400000;
const certSent = [];
const certService = createPacoSATService({ dbFile: ':memory:', origin, proxyKey, html: '<!--PACOSAT_TOKEN-->',
  now: () => certTime,
  makeConnector: async () => ({ parser: FixtureParser, connector: {
    request: async () => 'cert-req', check: async () => ({ status: 'pending', packages: [] }), download: async () => Buffer.alloc(0) } }),
  makeMailer: () => ({ verify: async () => true, sendMail: async payload => { certSent.push(payload); } }) });
const certApi = harnessFor(certService);
try {
  await certApi.init();
  await certService.bootstrap({ mail: { host: 'smtp.example.com', port: 587, from: 'from@example.com',
    recipient: 'to@example.com', user: '', password: '' } });
  assert.equal((await certApi.call('/api/unlock', { rfc: 'XAXX010101000', minutes: 1440, days: 7, direction: 'received',
    password: 'simulated', certificate: CERT_B64, key: 'YQ==' })).status, 200);
  /* 1.15.0: la descarga automática mensual tiene su propia suite
     (ronda1150); aquí se apaga para que el correo contado sea solo
     el de caducidad de la e.firma. */
  assert.equal((await certApi.call('/api/monthly/config', { enabled: false, day: 5, hour: 9 })).status, 200);
  const certStatus = await (await certApi.call('/api/status')).json();
  assert.equal(certStatus.profiles[0].certExpires, certExpected);
  /* 1.7.4: los avisos de caducidad viven en el Centro y viajan en el
     correo-resumen diario: los umbrales que caen el mismo día (60 y
     30) comparten UN solo correo, no uno por umbral. */
  const certMails = () => certSent.filter(mail => /e\.firma/.test(mail.text || ''));
  await certService.tick();
  assert.equal(certMails().length, 0);
  certTime = certExpected - 89 * 86400000;
  await certService.tick();
  assert.equal(certMails().length, 1);
  assert.match(certMails()[0].text, /vence en 89 días/);
  await certService.tick();
  assert.equal(certMails().length, 1);
  certTime = certExpected - 29 * 86400000;
  await certService.tick();
  assert.equal(certMails().length, 2);
  certTime = certExpected + 86400000;
  await certService.tick();
  assert.equal(certMails().length, 3);
  assert.match(certMails()[2].text, /vencida o vence hoy/);
  console.log('OK: caducidad de e.firma leída del certificado real, persistida y con avisos por umbral (90/60/30/0) sin duplicados, agrupados en el resumen diario.');
} finally { certService.close(); }

// --- 1.6.5: historia de un CFDI desde los datos guardados ---
const histBase = mkdtempSync(join(tmpdir(), 'pacosat-165-hist-'));
const histFile = join(histBase, 'historia.sqlite');
const HIST_ID = '12345678-1234-1234-1234-1234567890AB';
{
  const boot = createPacoSATService({ dbFile: histFile, origin, proxyKey, html: '<!--PACOSAT_TOKEN-->',
    makeMailer: () => ({ verify: async () => true, sendMail: async () => {} }) });
  boot.close();
  const seed = new DatabaseSync(histFile);
  seed.prepare("INSERT INTO profiles(rfc,minutes,days,direction,nextRun,error) VALUES ('XAXX010101000',1440,7,'received',0,'')").run();
  seed.prepare("INSERT INTO records(store,id,value) VALUES ('invoices',?,?)").run(HIST_ID, JSON.stringify({
    id: HIST_ID, from: { rfc: 'AAA010101AAA', name: 'Emisor' }, to: { rfc: 'XAXX010101000', name: 'Receptor' },
    date: '2026-10-05T10:00:00', kind: 'I', total: '100.00', currency: 'MXN', concepts: [], seal: '' }));
  seed.prepare("INSERT INTO records(store,id,value) VALUES ('documents',?,?)").run('pdf:hist', JSON.stringify({
    id: 'pdf:hist', rfc: 'XAXX010101000', kind: 'Factura PDF', date: '2026-10-05', period: '', name: 'factura-octubre.pdf', uuid: HIST_ID }));
  seed.prepare("INSERT INTO jobs(rfc,direction,periodStart,periodEnd,startAt,endAt,requestId,status,imported,due,created,error,checks) VALUES ('XAXX010101000','received','2026-10-01','2026-10-07','2026-10-01 00:00:00','2026-10-07 23:59:59','hist-1','finished',?,'0',?,'',0)")
    .run(JSON.stringify([HIST_ID]), Date.parse('2026-10-08T15:00:00Z'));
  seed.prepare("INSERT INTO cfdi_watch(id,emitter,receiver,total,seal,next,checked,result,error) VALUES (?,?,?,?,?,0,?,'Vigente','')")
    .run(HIST_ID, 'AAA010101AAA', 'XAXX010101000', '100.00', '', Date.parse('2026-10-09T15:00:00Z'));
  seed.prepare("INSERT INTO cancellation_alert(id,due,sent) VALUES (?,?,1)").run(HIST_ID, Date.parse('2026-10-10T15:00:00Z'));
  seed.close();
}
const histService = createPacoSATService({ dbFile: histFile, origin, proxyKey, html: '<!--PACOSAT_TOKEN-->',
  makeMailer: () => ({ verify: async () => true, sendMail: async () => {} }) });
const histApi = harnessFor(histService);
try {
  await histApi.init();
  const history = await (await histApi.call('/api/invoice-history?id=' + HIST_ID)).json();
  assert.deepEqual(history.events.map(event => event.kind), ['emission', 'download', 'status', 'alert', 'pdf']);
  assert.match(history.events[1].detail, /Periodo 2026-10-01 a 2026-10-07/);
  assert.equal(history.events[2].detail, 'Vigente');
  assert.equal(history.events[3].detail, 'Aviso enviado por correo');
  assert.equal(history.events[4].detail, 'factura-octubre.pdf');
  const empty = await (await histApi.call('/api/invoice-history?id=00000000-0000-0000-0000-000000000000')).json();
  assert.deepEqual(empty.events, []);
  console.log('OK: historia del CFDI armada solo con datos guardados (emisión, descarga, consulta, aviso, PDF) y vacía sin inventar eventos.');
} finally { histService.close(); }

// --- 1.6.6: ajustes de identidad persistentes en el servidor ---
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const idBase = mkdtempSync(join(tmpdir(), 'pacosat-166-'));
const idFile = join(idBase, 'identidad.sqlite');
const idOptions = () => ({ dbFile: idFile, origin, proxyKey, html: '<!--PACOSAT_TOKEN-->', buildModified: 1762732800000,
  makeMailer: () => ({ verify: async () => true, sendMail: async () => {} }) });
{
  const first = createPacoSATService(idOptions());
  const apiA = harnessFor(first);
  try {
    await apiA.init();
    const saved = await apiA.call('/api/settings', { installName: 'Mano Fil · PacoSAT', senderName: 'PacoSAT <b>Mano</b> Fil', accent: 'azul' });
    assert.equal(saved.status, 200);
    const badAccent = await apiA.call('/api/settings', { installName: '', senderName: '', accent: 'neon' });
    assert.equal(badAccent.status, 400);
    const logo = await apiA.call('/api/settings/logo', { mime: 'image/png', data: PNG_1PX });
    assert.equal(logo.status, 200);
    assert.equal((await logo.json()).settings.hasLogo, true);
    assert.equal((await apiA.call('/api/settings/logo', { mime: 'image/gif', data: PNG_1PX })).status, 400);
    assert.equal((await apiA.call('/api/settings/logo', { mime: 'image/png', data: Buffer.from('no-soy-png').toString('base64') })).status, 400);
    const big = Buffer.alloc(200 * 1024 + 1); big.set([0x89, 0x50, 0x4e, 0x47], 0);
    assert.equal((await apiA.call('/api/settings/logo', { mime: 'image/png', data: big.toString('base64') })).status, 400);
    const evilSvg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('base64');
    assert.equal((await apiA.call('/api/settings/logo', { mime: 'image/svg+xml', data: evilSvg })).status, 400);
    const goodSvg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>').toString('base64');
    assert.equal((await apiA.call('/api/settings/logo', { mime: 'image/svg+xml', data: goodSvg })).status, 200);
    /* Se restaura el PNG para la comprobación de ida y vuelta. */
    assert.equal((await apiA.call('/api/settings/logo', { mime: 'image/png', data: PNG_1PX })).status, 200);
  } finally { first.close(); }
  const second = createPacoSATService(idOptions());
  const apiB = harnessFor(second);
  try {
    await apiB.init();
    const status = await (await apiB.call('/api/status')).json();
    /* El nombre del remitente llega saneado (los caracteres de marcado
       se eliminan y queda texto inerte, seguro para la cabecera From) y
       el resto intacto tras un reinicio completo sobre el mismo volumen. */
    assert.deepEqual(status.settings, { installName: 'Mano Fil · PacoSAT', senderName: 'PacoSAT bMano/b Fil', accent: 'azul', hasLogo: true });
    assert.ok(status.serverStartedAt > 0);
    /* El sello de modificación de la copia lo aporta el servidor (la
       mtime del archivo servido que recibe al crearse el servicio). */
    assert.equal(status.buildModified, 1762732800000);
    const logo = await (await apiB.call('/api/settings/logo')).json();
    assert.equal(logo.mime, 'image/png');
    assert.equal(logo.data, PNG_1PX);
    /* El arnés común solo hace GET/POST: el DELETE se ejerce con una
       llamada cruda equivalente sobre el mismo servicio. */
    const rawToken = (await (await apiB.call('/')).text()).match(/content="([^"]+)"/)[1];
    const rawDelete = async path => {
      const headers = { host: 'pacosat.example.com', origin, 'x-pacosat-proxy': proxyKey, 'x-pacosat-token': rawToken };
      const req = Object.assign(Readable.from([]), { url: path, method: 'DELETE', headers });
      let response;
      const res = { setHeader() {}, writeHead(status) { this.status = status; },
        end(content) { response = new Response(content, { status: this.status }); } };
      await second.handle(req, res);
      return response;
    };
    assert.equal((await rawDelete('/api/settings/logo')).status, 200);
    const after = await (await apiB.call('/api/status')).json();
    assert.equal(after.settings.hasLogo, false);
    console.log('OK: ajustes de identidad persistentes tras reinicio, nombres saneados, logo validado por tipo real/tamaño y SVG seguro.');
  } finally { second.close(); }
}

// --- 1.6.6: el remitente con nombre llega al correo construido ---
{
  let fromTime = certExpected - 100 * 86400000;
  const fromSent = [];
  const fromService = createPacoSATService({ dbFile: ':memory:', origin, proxyKey, html: '<!--PACOSAT_TOKEN-->',
    now: () => fromTime,
    makeConnector: async () => ({ parser: FixtureParser, connector: {
      request: async () => 'from-req', check: async () => ({ status: 'pending', packages: [] }), download: async () => Buffer.alloc(0) } }),
    makeMailer: () => ({ verify: async () => true, sendMail: async payload => { fromSent.push(payload); } }) });
  const fromApi = harnessFor(fromService);
  try {
    await fromApi.init();
    await fromService.bootstrap({ mail: { host: 'smtp.example.com', port: 587, from: 'from@example.com',
      recipient: 'to@example.com', user: '', password: '' } });
    await fromApi.call('/api/unlock', { rfc: 'XAXX010101000', minutes: 1440, days: 7, direction: 'received',
      password: 'simulated', certificate: CERT_B64, key: 'YQ==' });
    /* 1.15.0: la descarga automática mensual tiene su propia
       suite (ronda1150); aquí se apaga para que el correo que
       nombra la e.firma sea solo el de caducidad. */
    assert.equal((await fromApi.call('/api/monthly/config', { enabled: false, day: 5, hour: 9 })).status, 200);
    fromTime = certExpected - 89 * 86400000;
    await fromService.tick();
    /* 1.7.4: el correo que nombra la e.firma es el resumen diario. */
    const plain = fromSent.filter(mail => /e\.firma/.test(mail.text || ''));
    assert.equal(plain.length, 1);
    assert.equal(plain[0].from, 'from@example.com');
    await fromApi.call('/api/settings', { installName: '', senderName: 'Avisos PacoSAT', accent: '' });
    fromTime = certExpected - 29 * 86400000;
    await fromService.tick();
    const named = fromSent.filter(mail => /e\.firma/.test(mail.text || '') && /Avisos PacoSAT/.test(mail.from));
    assert.equal(named.length, 1);
    assert.equal(named[0].from, 'Avisos PacoSAT <from@example.com>');
    console.log('OK: sin nombre del remitente el From no cambia; con nombre, los avisos salen como «Nombre <correo>».');
  } finally { fromService.close(); }
}

// --- Corrección 1.6.6: el bootstrap acepta el mismo intervalo que la API ---
{
  const bootBase = mkdtempSync(join(tmpdir(), 'pacosat-166-boot-'));
  const certPath = join(bootBase, 'fiel.cer'), keyPath = join(bootBase, 'fiel.key');
  writeFileSync(certPath, Buffer.from(CERT_B64, 'base64'));
  writeFileSync(keyPath, 'llave-de-prueba');
  const bootWith = async minutes => {
    const service = createPacoSATService({ dbFile: ':memory:', origin, proxyKey, html: '<!--PACOSAT_TOKEN-->',
      makeConnector: async () => ({}),
      makeMailer: () => ({ verify: async () => true, sendMail: async () => {} }) });
    const api = harnessFor(service);
    try {
      await api.init();
      await service.bootstrap({ profiles: [{ rfc: 'XAXX010101000', name: 'Prueba', minutes, days: 7,
        direction: 'received', certificatePath: certPath, keyPath, password: 'simulated' }] });
      const status = await (await api.call('/api/status')).json();
      return status.profiles[0]?.minutes;
    } finally { service.close(); }
  };
  /* La cadencia decidida por Paco (cada 6 horas) y los extremos del rango
     de la API activan el perfil; fuera de rango sigue rechazado. */
  assert.equal(await bootWith(360), 360);
  assert.equal(await bootWith(60), 60);
  assert.equal(await bootWith(1440), 1440);
  assert.equal(await bootWith(59), undefined);
  assert.equal(await bootWith(1441), undefined);
  console.log('OK: el bootstrap de perfiles acepta cualquier intervalo de 60 a 1440 minutos, como la API (360 incluido).');
}
