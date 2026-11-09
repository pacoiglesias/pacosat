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
  /* Guarda de empaquetado Docker: todo módulo relativo alcanzado desde el
     punto de entrada del servidor (local-server.mjs) debe estar copiado
     en la imagen (COPY del Dockerfile) y permitido por el .dockerignore.
     La CI no construye la imagen; sin esta guarda, un módulo nuevo puede
     quedar fuera y el contenedor cae con ERR_MODULE_NOT_FOUND — pasó con
     backup-core.mjs en el despliegue real de la 1.6.0 (8-nov-2026). */
  const needed = new Set(['local-server.mjs', 'Faro-Fiscal.html']);
  const queue = ['local-server.mjs'];
  while (queue.length) {
    const file = queue.pop();
    for (const match of fs.readFileSync(file, 'utf8').matchAll(/(?:from\s+|import\s*\()\s*'(\.\/[^']+)'/g)) {
      const name = match[1].slice(2);
      if (!needed.has(name)) { needed.add(name); queue.push(name); }
    }
  }
  const copied = new Set();
  for (const line of fs.readFileSync('Dockerfile', 'utf8').split('\n')) {
    const copy = line.match(/^COPY\s+(.+)$/);
    if (copy) for (const token of copy[1].trim().split(/\s+/).slice(0, -1)) if (!token.startsWith('--')) copied.add(token);
  }
  const allowed = new Set([...fs.readFileSync('.dockerignore', 'utf8').matchAll(/^!(\S+)$/gm)].map(m => m[1]));
  for (const file of needed) {
    assert.ok(copied.has(file), 'El Dockerfile no copia ' + file + ' y el servidor lo importa.');
    assert.ok(allowed.has(file), 'El .dockerignore no permite ' + file + ' y el servidor lo importa.');
  }
  /* Anillo de estados (1.6.5): agregación contra fixtures con estados
     mezclados, usando el MISMO invoiceStateOf del filtro del archivo
     (la coincidencia 69-B manda sobre el estado SAT). */
  const uiSource = fs.readFileSync('ui.part', 'utf8');
  const monitorSource = fs.readFileSync('monitor-ui.part', 'utf8');
  vm.runInContext('var fiscalResults = new Map();\n' +
    "fiscalResults.set('a', { sat: { state: 'Vigente' }, efos: [] });\n" +
    "fiscalResults.set('b', { sat: { state: 'Cancelado' }, efos: [] });\n" +
    "fiscalResults.set('c', { sat: { state: 'Cancelado' }, efos: ['Definitivo'] });\n" +
    "fiscalResults.set('d', { sat: { state: 'Vigente' }, efos: [] });\n" +
    "fiscalResults.set('e', { sat: { state: 'No encontrado' }, efos: [] });\n" +
    uiSource.slice(uiSource.indexOf('const invoiceStateOf'), uiSource.indexOf('function invoiceRows')) +
    monitorSource.slice(monitorSource.indexOf('function fiscalStateCounts'), monitorSource.indexOf('function fiscalDonut')) +
    "var __rows = ['a', 'b', 'c', 'd', 'e', 'f'].map(id => ({ id }));\n" +
    'globalThis.__donut = { counts: fiscalStateCounts(__rows), segments: donutSegments(fiscalStateCounts(__rows)) };', context);
  /* Los objetos creados dentro del contexto VM tienen otro prototipo:
     se comparan campo a campo, no con deepStrictEqual contra literales. */
  assert.equal(context.__donut.counts.vigente, 2);
  assert.equal(context.__donut.counts.cancelado, 1);
  assert.equal(context.__donut.counts.efos, 1);
  assert.equal(context.__donut.counts.sin, 2);
  assert.equal(context.__donut.segments.reduce((sum, seg) => sum + seg.value, 0), 6);
  assert.ok(Math.abs(context.__donut.segments.reduce((sum, seg) => sum + seg.frac, 0) - 1) < 1e-9);
  assert.equal(context.__donut.segments[1].start, context.__donut.segments[0].frac);
  /* Paquete mensual (1.6.5): el ZIP se escribe con zipStore y se relee
     con el propio zipXml; el manifiesto nombra el contenido exacto. */
  const wfSource = fs.readFileSync('workflows.part', 'utf8');
  vm.runInContext(wfSource.slice(wfSource.indexOf('function zipStore'), wfSource.indexOf('function restoreDialog')), context);
  const manifest = context.monthlyPackageManifest('XAXX010101000', '2026-10',
    ['totales.csv', 'base-diot.csv', 'resumen.html', 'manifiesto.txt'], '8/11/2026, 10:00');
  assert.ok(manifest.includes('RFC: XAXX010101000') && manifest.includes('Mes: 2026-10') && manifest.includes('- base-diot.csv'));
  const zipBlob = context.zipStore([{ name: 'totales.csv', data: new TextEncoder().encode('a,b\n1,2') },
    { name: 'manifiesto.txt', data: manifest }]);
  /* Lector mínimo del propio verify: zipXml solo expone entradas .xml
     (es el lector de CFDI), así que el paquete se comprueba recorriendo
     las cabeceras locales: nombre, contenido y CRC de cada entrada, y el
     registro final con su conteo. */
  const zipBytes = new Uint8Array(await zipBlob.arrayBuffer());
  const zipView = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
  const parsed = [];
  for (let p = 0; p + 30 <= zipBytes.length && zipView.getUint32(p, true) === 0x04034b50;) {
    const size = zipView.getUint32(p + 18, true);
    const nameLen = zipView.getUint16(p + 26, true), extraLen = zipView.getUint16(p + 28, true);
    const data = zipBytes.subarray(p + 30 + nameLen + extraLen, p + 30 + nameLen + extraLen + size);
    assert.equal(context.crc32(data), zipView.getUint32(p + 14, true));
    parsed.push({ name: new TextDecoder().decode(zipBytes.subarray(p + 30, p + 30 + nameLen)),
      text: new TextDecoder().decode(data) });
    p += 30 + nameLen + extraLen + size;
  }
  assert.deepEqual(parsed.map(entry => entry.name), ['totales.csv', 'manifiesto.txt']);
  assert.equal(parsed[0].text, 'a,b\n1,2');
  assert.equal(parsed[1].text, manifest);
  assert.equal(zipView.getUint32(zipBytes.length - 22, true), 0x06054b50);
  assert.equal(zipView.getUint16(zipBytes.length - 22 + 10, true), 2);
  console.log('OK: ZIP almacenado y comprimido, CRC, ZIP inválido, XML UTF-8/16, cifrado, contraseña errónea, manipulación, compatibilidad de respaldo navegador/servidor, CSV, referencias de interfaz, completitud de la imagen Docker, anillo de estados y paquete mensual.');
})().catch(error => { console.error(error); process.exitCode = 1; });
