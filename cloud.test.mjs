import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPacoSATService } from './local-server.mjs';
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
  assert.equal(watchSent.filter(mail => /carpeta vigilada no se importó/.test(mail.subject)).length, 1);
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
  const watchMails = deepSent.filter(mail => /carpeta vigilada no se importó/.test(mail.subject));
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
  assert.ok(watchSent.some(mail => /respaldo programado falló/.test(mail.subject)));
  console.log('OK: el fallo del respaldo programado deja error visible y aviso por correo.');
} finally { failService.close(); }
