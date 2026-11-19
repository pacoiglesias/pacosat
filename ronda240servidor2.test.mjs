import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { DOMParser } from '@xmldom/xmldom';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { createPacoSATService } from './local-server.mjs';

/* ================================================================
   Ronda 2.4.0 · WServ2 (servidor) — ítems 11, 13 y 29
   11 · Reglas de clasificación de gastos sin factura por
        concepto bancario: la regla que casa con acentos y
        mayúsculas distintos clasifica el movimiento y NOMBRA
        su regla; sin regla, sin categoría (no se inventa);
        las sugeridas no se imponen; clasificar no concilia:
        los conteos de sin-factura no se mueven.
   13 · Mapeo OPCIONAL de cuentas agrupadoras del SAT: rellena
        la columna «Cuenta» (la que ya existía, en blanco) SOLO
        de la contraparte mapeada; sin mapeo, el XLSX de
        pólizas es byte a byte el de hoy.
   29 · Prueba automática mensual de restauración: con un
        respaldo de juguete deja su constancia con fecha y
        resultado en Salud y en el Registro, no toca el volumen
        vivo (huellas del respaldo y conteos del expediente
        iguales antes/después) y un respaldo corrupto produce
        constancia de fallo + aviso por el canal de alertas.
   ================================================================ */

const ORIGIN = 'https://pacosat.test';
const KEY = 's'.repeat(64);
const OWN = 'AAA010101AAA';
const PROV1 = 'BBB010101BB1';
const PROV2 = 'CCC010101CC1';
const CLABE = '012180001234567590';
const pdf64 = Buffer.from('%PDF-1.7 estado de juguete ' + 'x'.repeat(120)).toString('base64');

function makeHarness(options = {}) {
  const clock = { t: Date.parse('2026-11-16T15:00:00Z') };
  const mails = [];
  const service = createPacoSATService({
    dbFile: ':memory:', html: '<html><head><!--PACOSAT_TOKEN--></head><body>prueba</body></html>',
    origin: ORIGIN, proxyKey: KEY, satDocRetryWaitMs: 5,
    extractText: async () => text,
    makeConnector: () => ({ parser: DOMParser, connector: {
      request: async () => 'req-240s2-1',
      check: async () => ({ status: 'finished', packages: [] }),
      download: async () => { throw new Error('sin paquetes'); } } }),
    makeMailer: () => ({ verify: async () => true,
      sendMail: async mail => { mails.push(mail); return { messageId: 'm' + mails.length }; } }),
    now: () => clock.t, ...options });
  let text = '';
  let token = '';
  const raw = async (method, path, body, extraHeaders = {}) => {
    const chunks = []; if (body !== undefined) chunks.push(Buffer.from(JSON.stringify(body)));
    const req = Readable.from(chunks);
    req.method = method; req.url = path;
    req.headers = { host: 'pacosat.test', origin: ORIGIN, 'x-pacosat-proxy': KEY, ...extraHeaders };
    let status = 0; const headers = {}; let out = '';
    const res = { writeHead(code, hdrs) { status = code; if (hdrs) Object.assign(headers, hdrs); },
      setHeader(k, v) { headers[k] = v; }, getHeader(k) { return headers[k]; },
      end(chunk) { if (chunk) out += Buffer.isBuffer(chunk) ? chunk.toString('latin1') : chunk; } };
    await service.handle(req, res);
    return { status, text: out, headers };
  };
  const call = async (method, path, body, extraHeaders = {}) => {
    if (!token) { const home = await raw('GET', '/'); token = /[0-9a-f]{64}/.exec(home.text)?.[0] || ''; }
    const r = await raw(method, path, body, { 'x-pacosat-token': token, ...extraHeaders });
    let json = null; try { json = JSON.parse(r.text); } catch { /* binario */ }
    return { status: r.status, json, text: r.text, headers: r.headers };
  };
  return { service, call, raw, mails, clock,
    set text(v) { text = v; }, get text() { return text; } };
}
const unlock = async (h, rfc = OWN) => {
  const open = await h.call('POST', '/api/unlock', { rfc, minutes: 1440, days: 7,
    direction: 'both', password: 'simulated', certificate: 'YQ==', key: 'Yg==' });
  assert.equal(open.status, 200, 'unlock de ' + rfc);
};
const invoice = (id, date, from, to, total) => ({ id, date, kind: 'I', currency: 'MXN', total,
  from: { rfc: from, name: 'EMPRESA ' + from }, to: { rfc: to, name: 'EMPRESA ' + to },
  fiscal: { paymentMethod: 'PPD', transferred: [], withheld: [] } });
const zipRaw = buffer => {
  const entries = new Map();
  let eocd = buffer.length - 22;
  while (eocd >= 0 && buffer.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  assert.ok(eocd >= 0, 'directorio central del ZIP');
  const count = buffer.readUInt16LE(eocd + 10);
  let p = buffer.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    assert.equal(buffer.readUInt32LE(p), 0x02014b50);
    const size = buffer.readUInt32LE(p + 20);
    const nameLen = buffer.readUInt16LE(p + 28);
    const extraLen = buffer.readUInt16LE(p + 30);
    const commentLen = buffer.readUInt16LE(p + 32);
    const localAt = buffer.readUInt32LE(p + 42);
    const name = buffer.toString('utf8', p + 46, p + 46 + nameLen);
    const localNameLen = buffer.readUInt16LE(localAt + 26);
    const localExtraLen = buffer.readUInt16LE(localAt + 28);
    const metodo = buffer.readUInt16LE(localAt + 8);
    const start = localAt + 30 + localNameLen + localExtraLen;
    const crudo = buffer.subarray(start, start + size);
    entries.set(name, metodo === 8 ? inflateRawSync(crudo) : Buffer.from(crudo));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
};
/* Filas de la hoja de pólizas como celdas de texto: resuelve las
   cadenas compartidas y las en línea; la celda vacía sale ''. */
const filasPolizas = buffer => {
  const entries = zipRaw(buffer);
  const compartidas = [];
  if (entries.has('xl/sharedStrings.xml')) {
    const xml = entries.get('xl/sharedStrings.xml').toString('utf8');
    for (const m of xml.matchAll(/<si>([\s\S]*?)<\/si>/g))
      compartidas.push([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(t => t[1]).join('')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
  }
  const hoja = entries.get('xl/worksheets/sheet1.xml').toString('utf8');
  const filas = [];
  for (const fila of hoja.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const celdas = {};
    /* Las celdas vacías viajan autocerradas (<c r="C2"/>): hay
       que casarlas como tales o se tragan la celda siguiente. */
    for (const c of fila[1].matchAll(/<c\s+([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = /r="([A-Z]+)\d+"/.exec(c[1]);
      if (!ref) continue;
      const contenido = c[2] || '';
      const v = /<v>([\s\S]*?)<\/v>/.exec(contenido);
      const enLinea = /<t[^>]*>([\s\S]*?)<\/t>/.exec(contenido);
      celdas[ref[1]] = c[1].includes('t="s"') && v ? (compartidas[Number(v[1])] ?? '')
        : enLinea ? enLinea[1] : v ? v[1] : '';
    }
    filas.push(celdas);
  }
  return filas;
};

/* ================= 11 · Reglas de clasificación ================= */
{
  const h = makeHarness();
  try {
    await h.call('POST', '/api/storage', { batch: { people: [{ id: OWN, name: 'Empresa Propia SA' }] } });
    await unlock(h);
    const alta = await h.call('POST', '/api/banks/accounts',
      { bank: 'BBVA', name: 'Chequera', kind: 'cuenta', numero: CLABE, rfc: OWN });
    assert.equal(alta.status, 200);
    h.text = ['BBVA MEXICO · ESTADO DE CUENTA', 'Cuenta ' + CLABE,
      'Periodo del 01/10/2026 al 31/10/2026', 'Saldo inicial $20,000.00', 'Saldo final $17,890.00',
      'Total de abonos $0.00', 'Total de cargos $2,110.00',
      '05/10/2026 COMISIÓN POR MANEJO $250.00 $19,750.00',
      '06/10/2026 PAGO A PROVEEDOR $1,160.00 $18,590.00',
      '07/10/2026 COMISION SPEI ENVIADO $700.00 $17,890.00'].join('\n');
    const ap = await h.call('POST', '/api/banks/statements/auto', { content: pdf64 });
    assert.equal(ap.json.aplicados, 3, 'los tres movimientos se aplican: ' + ap.text);

    /* Sin reglas: las sugeridas existen pero NO se imponen. */
    const servidas = await h.call('GET', '/api/banks/reglas240');
    assert.deepEqual(servidas.json.reglas, [], 'sin reglas guardadas, la lista nace vacía');
    assert.equal(servidas.json.sugeridas.length, 3, 'las tres de ejemplo viajan como sugeridas');
    assert.ok(servidas.json.sugeridas.every(s => s.sugerida === true), 'marcadas como sugeridas, no impuestas');
    let movs = (await h.call('GET', '/api/banks/movements')).json.movements;
    const comision = movs.find(m => /COMISI[OÓ]N POR MANEJO/.test(m.concept));
    assert.ok(comision, 'el movimiento de comisión consta');
    assert.equal(comision.categoria, null, 'aunque una sugerida casaría, sin regla guardada no hay categoría: no se inventa');

    /* Se marca sin factura: sigue sin categoría hasta que haya regla. */
    const marca = await h.call('POST', '/api/reconcile/ignore', { movementId: comision.id, nota: 'Comisión del banco' });
    assert.equal(marca.status, 200, 'marcar sin factura: ' + marca.text);
    movs = (await h.call('GET', '/api/banks/movements')).json.movements;
    const marcado = movs.find(m => m.id === comision.id);
    assert.equal(marcado.sinFactura, true);
    assert.equal(marcado.categoria, null, 'marcado sin factura pero sin regla: sin categoría');

    const concAntes = (await h.call('GET', '/api/banks/conciliacion?month=2026-10')).json;
    const cuentaAntes = concAntes.porCuenta[0];
    assert.equal(cuentaAntes.conteos.pagosSinFactura, 2, 'dos pagos sin factura en la conciliación antes de la regla');

    /* La regla: patrón sin acento y en minúsculas contra un
       concepto con acento y mayúsculas — la normalización de la casa. */
    const guardada = await h.call('POST', '/api/banks/reglas240',
      { reglas: [{ patron: 'comision', categoria: 'Comisiones' }] });
    assert.equal(guardada.status, 200, 'guardar la regla: ' + guardada.text);
    assert.equal(guardada.json.reglas.length, 1);
    assert.ok(guardada.json.reglas[0].id, 'la regla guardada trae su id');

    movs = (await h.call('GET', '/api/banks/movements')).json.movements;
    const clasificado = movs.find(m => m.id === comision.id);
    assert.equal(clasificado.categoria, 'Comisiones',
      'la regla «comision» clasifica el concepto «COMISIÓN…»: acentos y mayúsculas no estorban');
    assert.equal(clasificado.reglaCategoria.patron, 'comision', 'el movimiento NOMBRA la regla que lo clasificó');
    assert.equal(clasificado.reglaCategoria.categoria, 'Comisiones');
    assert.equal(clasificado.sinFactura, true, 'clasificado y SIGUE sin factura');
    const spei = movs.find(m => /SPEI/.test(m.concept));
    assert.equal(spei.categoria, null, 'el no marcado sin factura no se clasifica en esta lista (su sitio es la conciliación)');

    /* La conciliación enseña la misma clasificación en su pago
       sin factura, y clasificar NO concilia: el conteo no se mueve. */
    const concDespues = (await h.call('GET', '/api/banks/conciliacion?month=2026-10')).json;
    const cuentaDespues = concDespues.porCuenta[0];
    assert.equal(cuentaDespues.conteos.pagosSinFactura, cuentaAntes.conteos.pagosSinFactura,
      'la regla no concilia ni mueve dinero: el conteo de pagos sin factura es el mismo');
    const pagoSpei = cuentaDespues.pagosSinFactura.find(p => p.movement.amount === '-700.00');
    assert.ok(pagoSpei, 'el pago SPEI sigue en la lista de sin factura');
    assert.equal(pagoSpei.movement.categoria, 'Comisiones', 'la conciliación trae la categoría aplicada');
    assert.equal(pagoSpei.movement.reglaCategoria.patron, 'comision', 'y la regla que la puso');

    /* El patrón TAMBIÉN casa al revés: con acento y mayúsculas
       contra el mismo concepto. */
    await h.call('POST', '/api/banks/reglas240',
      { reglas: [{ patron: 'COMISIÓN', categoria: 'Comisiones bancarias' }] });
    movs = (await h.call('GET', '/api/banks/movements')).json.movements;
    assert.equal(movs.find(m => m.id === comision.id).categoria, 'Comisiones bancarias',
      'patrón «COMISIÓN» (acento, mayúsculas) casa igual');

    /* Sin regla, sin categoría: al quitarla todo vuelve. */
    await h.call('POST', '/api/banks/reglas240', { reglas: [] });
    movs = (await h.call('GET', '/api/banks/movements')).json.movements;
    const limpio = movs.find(m => m.id === comision.id);
    assert.equal(limpio.categoria, null, 'sin regla, sin categoría');
    assert.equal(limpio.reglaCategoria, null);
    assert.equal(limpio.sinFactura, true, 'y el movimiento sigue contando como sin factura');

    /* Validación: regla sin patrón o sin categoría no entra. */
    const mala = await h.call('POST', '/api/banks/reglas240', { reglas: [{ patron: '', categoria: 'X' }] });
    assert.equal(mala.status, 400, 'una regla sin patrón se rechaza');
    console.log('OK 2.4.0-WServ2 · 11 — reglas por concepto: casa sin acentos/mayúsculas, nombra su regla, sugeridas no impuestas, sin regla no hay categoría y clasificar no concilia.');
  } finally { h.service.close(); }
}

/* ================= 13 · Mapeo de agrupadoras ================= */
{
  const h = makeHarness();
  try {
    await h.call('POST', '/api/storage', { batch: { people: [{ id: OWN, name: 'Empresa Propia SA' }] } });
    await unlock(h);
    const F1 = '11111111-1111-4111-8111-111111111111';
    const F2 = '22222222-2222-4222-8222-222222222222';
    const seed = await h.call('POST', '/api/storage', { batch: { invoices: [
      invoice(F1, '2026-10-03', PROV1, OWN, '1160.00'),
      invoice(F2, '2026-10-04', PROV2, OWN, '580.00')] } });
    assert.equal(seed.status, 200);
    const pedirPolizas = async () => {
      const pol = await h.call('POST', '/api/salidas200g/polizas', { rfc: OWN, month: '2026-10' });
      assert.equal(pol.status, 200, 'pólizas: ' + pol.text);
      return Buffer.from(pol.json.content, 'base64');
    };
    const sinMapeo1 = await pedirPolizas();
    const filasSin = filasPolizas(sinMapeo1).filter(f => f.D && f.D !== 'Concepto');
    assert.equal(filasSin.length, 2, 'dos filas de póliza');
    assert.ok(filasSin.every(f => !f.C), 'sin mapeo, la columna Cuenta va en blanco en todas, como hoy');

    /* Código inválido: no entra (no se inventan códigos). */
    const malo = await h.call('POST', '/api/polizas/agrupadoras240',
      { mapeo: { [PROV1]: { codigo: '*** no es código ***', nombre: 'X' } } });
    assert.equal(malo.status, 400, 'un código que no es código se rechaza: ' + malo.text);

    const guardado = await h.call('POST', '/api/polizas/agrupadoras240',
      { mapeo: { [PROV1]: { codigo: '601.01', nombre: 'Costo de ventas' } } });
    assert.equal(guardado.status, 200, 'guardar el mapeo: ' + guardado.text);
    assert.equal(guardado.json.mapeo[PROV1].codigo, '601.01');
    assert.equal(guardado.json.mapeo[PROV1].nombre, 'Costo de ventas', 'el nombre llano viaja al lado del código');

    const conMapeo = await pedirPolizas();
    assert.ok(!conMapeo.equals(sinMapeo1), 'con mapeo, el Excel cambia (solo la columna mapeada)');
    const filasCon = filasPolizas(conMapeo).filter(f => f.D && f.D !== 'Concepto');
    const deProv1 = filasCon.find(f => String(f.D).includes(PROV1));
    const deProv2 = filasCon.find(f => String(f.D).includes(PROV2));
    assert.ok(deProv1 && deProv2, 'ambas filas constan por su concepto (la contraparte que el generador distingue)');
    assert.equal(deProv1.C, '601.01', 'la fila de la contraparte mapeada lleva su agrupadora en la columna Cuenta');
    assert.ok(!deProv2.C, 'la fila sin mapeo sigue en blanco');

    /* Paridad: al quitar el mapeo, el XLSX vuelve a ser byte a
       byte el de hoy. */
    await h.call('POST', '/api/polizas/agrupadoras240', { mapeo: {} });
    const sinMapeo2 = await pedirPolizas();
    assert.ok(sinMapeo2.equals(sinMapeo1), 'sin mapeo, el XLSX es byte a byte el de hoy');
    console.log('OK 2.4.0-WServ2 · 13 — agrupadoras: la mapeada rellena su Cuenta, las demás en blanco, código inválido fuera y sin mapeo paridad byte a byte.');
  } finally { h.service.close(); }
}

/* ================= 29 · Prueba automática mensual ================= */
{
  const dir = mkdtempSync(join(tmpdir(), 'pacosat-240s2-restore-'));
  const backupDir = join(dir, 'respaldos');
  const h = makeHarness({ dbFile: join(dir, 'pacosat.sqlite') });
  try {
    await h.call('POST', '/api/storage', { batch: { people: [{ id: OWN, name: 'Empresa Propia SA' }] } });
    await unlock(h);
    await h.call('POST', '/api/storage', { batch: { invoices: [
      invoice('99999999-9999-4999-8999-999999999999', '2026-10-05', PROV1, OWN, '116.00')] } });
    const mail = await h.call('POST', '/api/mail', { host: 'smtp.test', port: 465, security: 'ssl',
      from: 'avisos@pacosat.test', recipient: 'paco@test.mx', user: 'u', password: 'p' });
    assert.equal(mail.status, 200, 'correo configurado (canal de alertas)');
    await h.service.bootstrap({ backup: { password: 'respaldo-prueba-240s2', frequency: 'daily', dir: backupDir } });
    await h.service.backupTick(h.clock.t);
    const faros = () => readdirSync(backupDir).filter(n => n.endsWith('.faro')).sort();
    assert.ok(faros().length >= 1, 'el respaldo de juguete existe');
    const huellaRespaldo = () => faros().map(n => n + ':' +
      createHash('sha256').update(readFileSync(join(backupDir, n))).digest('hex')).join('|');
    const huellaExpediente = async () =>
      JSON.stringify((await h.call('GET', '/api/status')).json.expediente);

    const respaldoAntes = huellaRespaldo();
    const expedienteAntes = await huellaExpediente();
    const resultado = h.service.restoreAutoTest240(h.clock.t);
    assert.equal(resultado.ok, true, 'la prueba automática sale bien contra el respaldo bueno: ' + resultado.detail);
    assert.equal(resultado.nivel, 'completa', 'nivel declarado: completa (reutiliza el ensayo existente, sin gesto)');
    assert.equal(resultado.at, h.clock.t, 'la constancia lleva su fecha');
    assert.equal(huellaRespaldo(), respaldoAntes, 'el respaldo bueno no se tocó');
    assert.equal(await huellaExpediente(), expedienteAntes,
      'el volumen vivo no se tocó: los conteos del expediente son los mismos antes y después');
    assert.deepEqual(readdirSync(tmpdir()).filter(n => n.startsWith('pacosat-restore-test-')), [],
      'el rincón aislado se borra al terminar: no queda scratch en el temporal');

    /* La constancia se lee en Salud y la cadencia en el Registro. */
    const salud = await h.call('GET', '/api/salud');
    const tarjeta = salud.json.tarjetas.find(t => t.id === 'respaldo');
    assert.ok(tarjeta, 'la tarjeta de respaldos de Salud consta');
    assert.equal(tarjeta.datos.auto240.ok, true, 'Salud sirve la constancia: salió bien');
    assert.equal(tarjeta.datos.auto240.at, h.clock.t, 'con su fecha');
    const registro = await h.call('GET', '/api/registro?texto=' +
      encodeURIComponent('Prueba automática mensual'));
    assert.ok(registro.json.items.some(i => /salió bien/.test(i.texto)),
      'la cadencia queda anotada en el Registro');

    /* Dentro del mismo mes, el tick NO la repite. */
    h.clock.t = Date.parse('2026-11-20T15:00:00Z');
    await h.service.tick();
    const salud2 = await h.call('GET', '/api/salud');
    assert.equal(salud2.json.tarjetas.find(t => t.id === 'respaldo').datos.auto240.at,
      Date.parse('2026-11-16T15:00:00Z'), 'mismo mes: la prueba mensual no se repite en cada tick');

    /* Respaldo corrupto + mes nuevo: constancia de fallo y aviso. */
    for (const n of faros()) writeFileSync(join(backupDir, n), Buffer.from('respaldo corrupto de juguete'));
    h.clock.t = Date.parse('2026-12-18T15:00:00Z');
    await h.service.tick();
    const salud3 = await h.call('GET', '/api/salud');
    const auto240 = salud3.json.tarjetas.find(t => t.id === 'respaldo').datos.auto240;
    assert.equal(auto240.at, h.clock.t, 'en el mes nuevo la prueba corre sola (por el tick, sin gesto)');
    assert.equal(auto240.ok, false, 'con el respaldo corrupto, la constancia es de fallo');
    assert.ok(auto240.detail, 'el fallo lleva su porqué: ' + auto240.detail);
    assert.ok(h.mails.some(m => /prueba automática mensual de restauración falló/i.test(m.subject || '')),
      'el fallo sale por el canal de alertas (correo): ' + h.mails.map(m => m.subject).join(' | '));
    const registroFallo = await h.call('GET', '/api/registro?texto=' +
      encodeURIComponent('Prueba automática mensual'));
    assert.ok(registroFallo.json.items.some(i => /no salió bien/.test(i.texto)),
      'el fallo también queda en el Registro');
    console.log('OK 2.4.0-WServ2 · 29 — prueba mensual: constancia en Salud y Registro, volumen vivo intacto, cadencia mensual y respaldo corrupto = fallo + aviso.');
  } finally { h.service.close(); rmSync(dir, { recursive: true, force: true }); }
}

/* Sin contraseña de respaldo configurada: constancia honesta. */
{
  const h = makeHarness();
  try {
    const resultado = h.service.restoreAutoTest240(h.clock.t);
    assert.equal(resultado.ok, false);
    assert.equal(resultado.nivel, 'sin-probar-a-fondo');
    assert.match(resultado.detail, /No probada a fondo: el respaldo está cifrado y la prueba completa pide tu contraseña/,
      'sin contraseña no se finge: la constancia dice que no se probó a fondo y por qué');
    const salud = await h.call('GET', '/api/salud');
    assert.equal(salud.json.tarjetas.find(t => t.id === 'respaldo').datos.auto240.nivel,
      'sin-probar-a-fondo', 'la constancia honesta también se sirve en Salud');
    console.log('OK 2.4.0-WServ2 · 29b — sin contraseña de respaldo, la constancia es honesta: no probada a fondo.');
  } finally { h.service.close(); }
}

console.log('ronda240servidor2.test: ok');
