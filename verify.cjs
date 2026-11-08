const assert = require('node:assert/strict');
const fs = require('node:fs');
const { deflateRawSync } = require('node:zlib');
const vm = require('node:vm');
const context = vm.createContext({
  Uint8Array, DataView, TextDecoder, TextEncoder, Blob, DecompressionStream,
  btoa, atob, crypto: require('node:crypto').webcrypto
});
vm.runInContext(fs.readFileSync('data.part', 'utf8'), context);
const { zipXml, crc32, encryptBackup, decryptBackup, decodeXml } = context;
function archive(payload, method) {
  const packed = method === 8 ? deflateRawSync(payload) : payload;
  const name = Buffer.from('SAT/lote/factura.xml');
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50);
  header.writeUInt16LE(method, 8);
  header.writeUInt16LE(name.length, 26);
  const dir = Buffer.alloc(46);
  dir.writeUInt32LE(0x02014b50);
  dir.writeUInt16LE(method, 10);
  dir.writeUInt32LE(crc32(payload), 16);
  dir.writeUInt32LE(packed.length, 20);
  dir.writeUInt32LE(payload.length, 24);
  dir.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(dir.length + name.length, 12);
  end.writeUInt32LE(header.length + name.length + packed.length, 16);
  return Buffer.concat([header, name, packed, dir, name, end]);
}
async function collect(stream) {
  const result = [];
  for await (const entry of stream) result.push(entry);
  return result;
}
(async () => {
  const original = Buffer.from('<?xml version="1.0" encoding="UTF-8"?><Comprobante nombre="México"/>');
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  for (const method of [0, 8]) {
    const zip = archive(original, method);
    const files = await collect(zipXml(zip));
    assert.equal(files.length, 1);
    assert.equal(files[0].name, 'factura.xml');
    assert.deepEqual(Buffer.from(files[0].xml), original);
    assert.equal(decodeXml(files[0].xml), original.toString());
  }
  const damaged = archive(original, 0);
  damaged[50] ^= 1;
  await assert.rejects(collect(zipXml(damaged)), /integridad/);
  await assert.rejects(collect(zipXml(Buffer.alloc(25))), /directorio/);
  const utf16 = Buffer.concat([Buffer.from([255, 254]), Buffer.from('<prueba>ñ</prueba>', 'utf16le')]);
  assert.equal(decodeXml(utf16), '<prueba>ñ</prueba>');
  const pass = 'Prueba de respaldo 123';
  const file = await encryptBackup({ version: 2, name: 'Contribuyente ficticio' }, pass);
  assert.equal((await decryptBackup(file, pass)).name, 'Contribuyente ficticio');
  await assert.rejects(decryptBackup(file, 'incorrecta'), /incorrecta/);
  const altered = Buffer.from(await file.arrayBuffer());
  altered[altered.length - 1] ^= 1;
  await assert.rejects(decryptBackup(new Blob([altered]), pass), /dañado/);
  const { encryptBackupBuffer, decryptBackupBuffer } = await import('./backup-core.mjs');
  const serverMade = encryptBackupBuffer({ version: 2, name: 'Servidor ficticio' }, pass);
  assert.equal((await decryptBackup(new Blob([serverMade]), pass)).name, 'Servidor ficticio');
  assert.equal(decryptBackupBuffer(Buffer.from(await file.arrayBuffer()), pass).name, 'Contribuyente ficticio');
  await assert.rejects(Promise.resolve().then(() => decryptBackupBuffer(serverMade, 'incorrecta')), /incorrecta/);
  const source = fs.readFileSync('workflows.part', 'utf8');
  vm.runInContext(source.slice(source.indexOf('function csvText'), source.indexOf('function exportCsv')), context);
  const csv = context.csvText([{ id: 'id', from: { name: '=2+2', rfc: 'A' }, to: { name: 'B', rfc: 'C' },
    date: '2026-11-07', kind: 'I', total: '123.45', currency: 'MXN' }]);
  assert.ok(csv.includes('"\'=2+2"') && csv.includes('"Ingreso"'));
  const html = fs.readFileSync('Faro-Fiscal.html', 'utf8');
  new vm.Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]));
  for (const match of html.matchAll(/\.id\s*=\s*'([^']+)'/g)) ids.add(match[1]);
  for (const match of html.matchAll(/\$\('([^']+)'\)/g)) assert.ok(ids.has(match[1]), 'Falta ' + match[1]);
  console.log('OK: ZIP almacenado y comprimido, CRC, ZIP inválido, XML UTF-8/16, cifrado, contraseña errónea, manipulación, compatibilidad de respaldo navegador/servidor, CSV y referencias de interfaz.');
})().catch(error => { console.error(error); process.exitCode = 1; });
