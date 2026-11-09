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
  vm.runInContext(wfSource.slice(wfSource.indexOf('function zipStore'), wfSource.indexOf('async function restoreDialog')), context);
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
  /* Personalización (1.6.6): la paleta de acentos cumple contraste AA.
     Los valores se leen de la propia hoja (polish.part) y los ratios se
     recomputan aquí: texto del acento sobre la superficie, texto sobre
     el acento y su hover, tinta sobre tinte y sobre el activo de la
     barra lateral, en claro (#ffffff) y en oscuro (#14243a). */
  const polish = fs.readFileSync('polish.part', 'utf8');
  const luminance = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(v => v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4))
    .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
  const contrast = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const accentNames = [...polish.matchAll(/\[data-accent="([a-z]+)"\]\{--green:/g)].map(match => match[1]);
  assert.deepEqual([...new Set(accentNames)].sort(), ['ambar', 'azul', 'burdeos', 'grafito', 'rosa', 'teal', 'violeta']);
  for (const name of new Set(accentNames)) {
    const block = selector => {
      const found = polish.match(new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\{([^}]*)\\}'));
      assert.ok(found, 'Falta el bloque de acento ' + name + ' para ' + selector);
      return Object.fromEntries([...found[1].matchAll(/(--[\w-]+):\s*(#[0-9a-f]{6})/g)].map(m => [m[1], m[2]]));
    };
    const light = block(':root[data-accent="' + name + '"]');
    const dark = block(':root[data-theme="dark"][data-accent="' + name + '"]');
    for (const [label, a, b] of [
      ['claro texto', light['--green'], '#ffffff'], ['claro sobre acento', light['--on-accent'], light['--green']],
      ['claro hover', light['--on-accent'], light['--green-hover']], ['claro tinte', light['--ok-ink'], light['--tint']],
      ['claro nav', light['--nav-active-ink'], light['--nav-active-bg']],
      ['oscuro texto', dark['--green'], '#14243a'], ['oscuro sobre acento', dark['--on-accent'], dark['--green']],
      ['oscuro hover', dark['--on-accent'], dark['--green-hover']], ['oscuro tinte', dark['--ok-ink'], dark['--tint']],
      ['oscuro nav', dark['--nav-active-ink'], dark['--nav-active-bg']]])
      assert.ok(contrast(a, b) >= 4.5, 'Contraste AA insuficiente en ' + name + ' (' + label + '): ' + contrast(a, b).toFixed(2));
  }
  /* Sellos de la copia (1.6.6): el artefacto es una función pura del
     árbol (dos generaciones seguidas, byte a byte idénticas: es la
     propiedad que exige el diff de CI) y sus metadatos son la versión
     de package.json y la creación constante documentada. El sello de
     modificación NO vive en el artefacto (un derivado del historial no
     es reproducible entre checkouts): lo aporta el servidor con la
     mtime del archivo servido, probado en cloud.test. */
  const { execFileSync } = require('node:child_process');
  const os = require('node:os');
  const path = require('node:path');
  const stampDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pacosat-stamp-'));
  fs.cpSync('.', stampDir, { recursive: true, filter: source => !/(^|[\\/])(\.git|node_modules)([\\/]|$)/.test(source) });
  execFileSync('node', ['build.mjs'], { cwd: stampDir });
  const firstBuild = fs.readFileSync(path.join(stampDir, 'Faro-Fiscal.html'));
  execFileSync('node', ['build.mjs'], { cwd: stampDir });
  assert.ok(firstBuild.equals(fs.readFileSync(path.join(stampDir, 'Faro-Fiscal.html'))),
    'Dos generaciones del mismo árbol deben ser byte a byte idénticas.');
  const meta = JSON.parse(firstBuild.toString('utf8').match(/PACOSAT_META = (\{[^}]*\})/)[1]);
  assert.equal(meta.version, JSON.parse(fs.readFileSync('package.json', 'utf8')).version);
  assert.equal(meta.created, '2026-11-08T13:42:35-06:00');
  assert.ok(!('modified' in meta), 'El artefacto no debe llevar sello volátil.');
  fs.rmSync(stampDir, { recursive: true, force: true });
  /* La constante de creación coincide con el primer commit real cuando
     el historial está completo (en CI la copia es superficial y se omite). */
  try {
    const shallow = execFileSync('git', ['rev-parse', '--is-shallow-repository'], { encoding: 'utf8' }).trim();
    if (shallow === 'false') {
      const first = execFileSync('git', ['log', '--reverse', '--format=%cI'], { encoding: 'utf8' }).split('\n')[0].trim();
      const created = fs.readFileSync('build.mjs', 'utf8').match(/SOFTWARE_CREATED = '([^']+)'/)[1];
      assert.equal(first, created);
    }
  } catch { /* sin git en el entorno de verificación: nada que contrastar */ }
  /* Visor CFDI profesional (1.6.7): parseo completo contra CFDI fixture
     reales (DOM real de @xmldom/xmldom inyectado, como en el navegador)
     con los totales cuadrados al centavo contra el propio XML. */
  const { DOMParser } = require('@xmldom/xmldom');
  const centsOf = value => Math.round(Number(value) * 100);
  const CFDI_HEAD = '<?xml version="1.0" encoding="UTF-8"?><cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" ';
  const ingresoXml = CFDI_HEAD + 'Version="4.0" Serie="A" Folio="773" Fecha="2026-10-05T09:12:00" FormaPago="03" MetodoPago="PUE" Moneda="MXN" SubTotal="1000.00" Total="1160.00" TipoDeComprobante="I" LugarExpedicion="90800" NoCertificado="00001000000700000001" Exportacion="01" Sello="SELLOX" Certificado="CERTX">' +
    '<cfdi:Emisor Rfc="MFI6212158B4" Nombre="MANO FIL SA" RegimenFiscal="601"/>' +
    '<cfdi:Receptor Rfc="TCH850701RM1" Nombre="TIENDAS CHEDRAUI SA DE CV" DomicilioFiscalReceptor="90800" RegimenFiscalReceptor="601" UsoCFDI="G03"/>' +
    '<cfdi:Conceptos>' +
    '<cfdi:Concepto ClaveProdServ="53111600" Cantidad="10" ClaveUnidad="H87" Unidad="Pieza" Descripcion="Cobertor matrimonial" ValorUnitario="60.00" Importe="600.00" ObjetoImp="02"><cfdi:Impuestos><cfdi:Traslados><cfdi:Traslado Base="600.00" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="96.00"/></cfdi:Traslados></cfdi:Impuestos></cfdi:Concepto>' +
    '<cfdi:Concepto ClaveProdServ="53111600" Cantidad="8" ClaveUnidad="H87" Unidad="Pieza" Descripcion="Cobertor individual" ValorUnitario="50.00" Importe="400.00" ObjetoImp="02"><cfdi:Impuestos><cfdi:Traslados><cfdi:Traslado Base="400.00" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="64.00"/></cfdi:Traslados></cfdi:Impuestos></cfdi:Concepto>' +
    '</cfdi:Conceptos>' +
    '<cfdi:Impuestos TotalImpuestosTrasladados="160.00"><cfdi:Traslados><cfdi:Traslado Base="1000.00" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="160.00"/></cfdi:Traslados></cfdi:Impuestos>' +
    '<cfdi:Complemento><tfd:TimbreFiscalDigital xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital" Version="1.1" UUID="12345678-1234-1234-1234-1234567890AB" FechaTimbrado="2026-10-05T09:13:44" RfcProvCertif="SAT970701NN3" SelloCFD="SELLOCFD123" NoCertificadoSAT="00001000000700000002" SelloSAT="SELLOSAT456"/></cfdi:Complemento></cfdi:Comprobante>';
  const ingreso = context.parseCfdiFull(Buffer.from(ingresoXml), DOMParser);
  assert.equal(ingreso.kind, 'I');
  assert.equal(ingreso.serie + '-' + ingreso.folio, 'A-773');
  assert.equal(ingreso.emisor.regimen, '601');
  assert.equal(ingreso.receptor.domicilioFiscal, '90800');
  assert.equal(ingreso.receptor.usoCfdi, 'G03');
  assert.equal(ingreso.conceptos.length, 2);
  assert.equal(ingreso.conceptos.reduce((sum, c) => sum + centsOf(c.importe), 0), centsOf(ingreso.subTotal));
  assert.equal(ingreso.conceptos.reduce((sum, c) => sum + c.traslados.reduce((s, t) => s + centsOf(t.importe), 0), 0), centsOf(ingreso.impuestos.totalTrasladados));
  assert.equal(centsOf(ingreso.subTotal) + centsOf(ingreso.impuestos.totalTrasladados), centsOf(ingreso.total));
  assert.equal(ingreso.timbre.uuid, '12345678-1234-1234-1234-1234567890AB');
  assert.equal(ingreso.timbre.cadenaOriginal, '||1.1|12345678-1234-1234-1234-1234567890AB|2026-10-05T09:13:44|SAT970701NN3|SELLOCFD123|00001000000700000002||');
  assert.deepEqual([...ingreso.otrosComplementos], []);
  /* El UUID parseado es la misma llave que usa la vigilancia: si el SAT
     lo marca Cancelado, el estado que el visor pinta es «Cancelado». */
  context.fiscalResults?.clear?.();
  vm.runInContext("fiscalResults.set('12345678-1234-1234-1234-1234567890AB', { sat: { state: 'Cancelado' }, efos: [] });", context);
  assert.equal(context.fiscalStateCounts([{ id: ingreso.timbre.uuid }]).cancelado, 1);
  const retencionesXml = CFDI_HEAD + 'Version="4.0" Fecha="2026-10-06T10:00:00" Moneda="MXN" SubTotal="10000.00" Total="9533.33" TipoDeComprobante="I" LugarExpedicion="90800">' +
    '<cfdi:Emisor Rfc="AAA010101AAA" Nombre="PRESTADOR" RegimenFiscal="612"/><cfdi:Receptor Rfc="MFI6212158B4" Nombre="MANO FIL SA" DomicilioFiscalReceptor="90800" RegimenFiscalReceptor="601" UsoCFDI="G03"/>' +
    '<cfdi:Conceptos><cfdi:Concepto ClaveProdServ="54111500" Cantidad="1" ClaveUnidad="E48" Descripcion="Servicios" ValorUnitario="10000.00" Importe="10000.00" ObjetoImp="02"/></cfdi:Conceptos>' +
    '<cfdi:Impuestos TotalImpuestosTrasladados="1600.00" TotalImpuestosRetenidos="2066.67"><cfdi:Traslados><cfdi:Traslado Base="10000.00" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="1600.00"/></cfdi:Traslados>' +
    '<cfdi:Retenciones><cfdi:Retencion Impuesto="002" Importe="1066.67"/><cfdi:Retencion Impuesto="001" Importe="1000.00"/></cfdi:Retenciones></cfdi:Impuestos></cfdi:Comprobante>';
  const conRet = context.parseCfdiFull(Buffer.from(retencionesXml), DOMParser);
  assert.equal(conRet.impuestos.retenciones.length, 2);
  assert.equal(centsOf(conRet.subTotal) + centsOf(conRet.impuestos.totalTrasladados) - centsOf(conRet.impuestos.totalRetenidos), centsOf(conRet.total));
  const pagoXml = CFDI_HEAD + 'Version="4.0" Fecha="2026-10-20T12:00:00" Moneda="XXX" SubTotal="0" Total="0" TipoDeComprobante="P" LugarExpedicion="90800">' +
    '<cfdi:Emisor Rfc="MFI6212158B4" Nombre="MANO FIL SA" RegimenFiscal="601"/><cfdi:Receptor Rfc="TCH850701RM1" Nombre="TIENDAS CHEDRAUI SA DE CV" DomicilioFiscalReceptor="90800" RegimenFiscalReceptor="601" UsoCFDI="CP01"/>' +
    '<cfdi:Conceptos><cfdi:Concepto ClaveProdServ="84111506" Cantidad="1" ClaveUnidad="ACT" Descripcion="Pago" ValorUnitario="0" Importe="0" ObjetoImp="01"/></cfdi:Conceptos>' +
    '<cfdi:Complemento><pago20:Pagos xmlns:pago20="http://www.sat.gob.mx/Pagos20" Version="2.0">' +
    '<pago20:Totales TotalTrasladosBaseIVA16="1000.00" TotalTrasladosImpuestoIVA16="160.00" MontoTotalPagos="1360.00"/>' +
    '<pago20:Pago FechaPago="2026-10-20T00:00:00" FormaDePagoP="03" MonedaP="MXN" Monto="1360.00">' +
    '<pago20:DoctoRelacionado IdDocumento="12345678-1234-1234-1234-1234567890AB" MonedaDR="MXN" NumParcialidad="1" ImpSaldoAnt="1160.00" ImpPagado="1160.00" ImpSaldoInsoluto="0.00"/>' +
    '<pago20:DoctoRelacionado IdDocumento="22345678-1234-1234-1234-1234567890AB" Serie="B" Folio="88" MonedaDR="MXN" NumParcialidad="2" ImpSaldoAnt="500.00" ImpPagado="200.00" ImpSaldoInsoluto="300.00"/>' +
    '</pago20:Pago></pago20:Pagos></cfdi:Complemento></cfdi:Comprobante>';
  const pago = context.parseCfdiFull(Buffer.from(pagoXml), DOMParser);
  assert.equal(pago.kind, 'P');
  assert.equal(pago.timbre, null);
  assert.equal(pago.pagos.pagos.length, 1);
  assert.equal(pago.pagos.pagos[0].documentos.length, 2);
  for (const docRel of pago.pagos.pagos[0].documentos)
    assert.equal(centsOf(docRel.impSaldoAnt) - centsOf(docRel.impPagado), centsOf(docRel.impSaldoInsoluto));
  assert.equal(pago.pagos.totales.MontoTotalPagos, '1360.00');
  const sinTimbreXml = ingresoXml.replace(/<cfdi:Complemento>.*<\/cfdi:Complemento>/, '');
  const sinTimbre = context.parseCfdiFull(Buffer.from(sinTimbreXml), DOMParser);
  assert.equal(sinTimbre.timbre, null);
  assert.equal(sinTimbre.pagos, null);
  assert.equal(sinTimbre.conceptos.length, 2);
  assert.equal(sinTimbre.total, '1160.00');
  /* CSP estricta (1.6.9): ni la meta del artefacto ni el servidor
     contienen unsafe-inline; las huellas SHA-256 de la meta coinciden
     con los bloques reales de estilo y script, y la cabecera que el
     servidor calcula desde el mismo archivo lleva esas huellas. */
  const { createHash } = require('node:crypto');
  const hashOf = text => "'sha256-" + createHash('sha256').update(text, 'utf8').digest('base64') + "'";
  const styleBlockOf = source => source.match(/<style>([\s\S]*?)<\/style>/)[1];
  const scriptBlockOf = source => source.match(/<script>([\s\S]*?)<\/script>/)[1];
  const metaPolicy = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]*)">/)[1];
  assert.ok(!metaPolicy.includes('unsafe-inline'), 'La meta CSP no debe contener unsafe-inline.');
  assert.ok(metaPolicy.includes('style-src ' + hashOf(styleBlockOf(html))), 'La huella de estilo de la meta no coincide con el bloque servido.');
  assert.ok(metaPolicy.includes('script-src ' + hashOf(scriptBlockOf(html))), 'La huella de script de la meta no coincide con el bloque servido.');
  assert.ok(!fs.readFileSync('local-server.mjs', 'utf8').includes('unsafe-inline'),
    'El servidor no debe emitir unsafe-inline en ninguna política.');
  const { cspForHtml } = await import('./local-server.mjs');
  const headerPolicy = cspForHtml(html);
  assert.ok(!headerPolicy.includes('unsafe-inline') && headerPolicy.includes(hashOf(styleBlockOf(html))) &&
    headerPolicy.includes(hashOf(scriptBlockOf(html))), 'La cabecera CSP del servidor no coincide con las huellas del artefacto.');
  /* Pantalla «Qué incluye PacoSAT» (1.6.9): nace de docs/CAPACIDADES.md
     en build; el artefacto lleva las secciones del documento y la
     fecha de actualización declarada en su cabecera. */
  const capacidadesInHtml = JSON.parse(html.match(/PACOSAT_CAPACIDADES = (\{.*?\});\n/)[1]);
  const capacidadesSource = fs.readFileSync('docs/CAPACIDADES.md', 'utf8');
  assert.equal(capacidadesInHtml.updated,
    (capacidadesSource.match(/\*\*Última modificación:\s*([^*]+)\*\*/) || [])[1].trim());
  assert.ok(capacidadesInHtml.sections.length >= 8, 'Faltan secciones de capacidades en el artefacto.');
  assert.ok(capacidadesInHtml.sections.some(section => section.blocks.some(block => block.type === 'item')),
    'El documento de capacidades debe llevar capacidades con estado.');
  console.log('OK: ZIP almacenado y comprimido, CRC, ZIP inválido, XML UTF-8/16, cifrado, contraseña errónea, manipulación, compatibilidad de respaldo navegador/servidor, CSV, referencias de interfaz, completitud de la imagen Docker, anillo de estados, paquete mensual, paleta AA, sellos de la copia, visor CFDI completo, CSP estricta por huellas y documento de capacidades generado.');
})().catch(error => { console.error(error); process.exitCode = 1; });
