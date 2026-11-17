import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { DOMParser } from '@xmldom/xmldom';
import { createPacoSATService } from './local-server.mjs';
import { parseXml } from './xml-core.mjs';
import { huellaMaquina, hashComponente, verificarLicencia, payloadCanonicoLicencia, componentesDeMaquina } from './licencia.mjs';

/* ================================================================
   Ronda 2.3.0 · SERVIDOR-1 — las piezas del servidor, juzgadas
   contra su contrato:
   3) resumen de declaraciones por ejercicio (cruce + mapa, sin
      aproximar); 4) el barrido deja diario y tiempos201 estima
      «barrido»; 7) el plan avisa yaPedida ANTES de quemar;
   8) el Registro busca en el servidor, antes del tope;
   13) la conciliación de Bancos sale en PDF y Excel del mismo
      cálculo; 17) Paperless se prueba en el acto; 19) el ensayo
      de restauración corre en el acto y responde {ok,detail,at};
   20) base comercial apagada por defecto (licencia Ed25519 con
      tolerancia por mayoría + rutas solo con PACOSAT_COMERCIAL=1).
   Cada bloque puede FALLAR donde el comportamiento no exista.
   ================================================================ */

const ORIGIN = 'https://pacosat.test';
const KEY = 'd'.repeat(64);
const OWN = 'AAA010101AAA';
const BBB = 'BBB010101BB1';
const PDF64 = Buffer.from('%PDF-1.4\n%respaldo de prueba\n').toString('base64');

function makeHarness(options = {}) {
  const clock = { t: Date.parse('2026-11-16T15:00:00Z') };
  const mails = [];
  const service = createPacoSATService({
    dbFile: ':memory:', html: '<html><head><!--PACOSAT_TOKEN--></head><body>prueba</body></html>',
    origin: ORIGIN, proxyKey: KEY, satDocRetryWaitMs: 5,
    makeConnector: () => ({ parser: DOMParser, connector: {
      request: async () => 'req-230-1', check: async () => ({ status: 'pending', packages: [] }),
      download: async () => { throw new Error('sin paquetes'); } } }),
    makeMailer: () => ({ verify: async () => true,
      sendMail: async mail => { mails.push(mail); return { messageId: 'm' + mails.length }; } }),
    now: () => clock.t, ...options });
  let token = '';
  const raw = async (method, path, body, extraHeaders = {}) => {
    const chunks = []; if (body !== undefined) chunks.push(Buffer.from(JSON.stringify(body)));
    const req = Readable.from(chunks);
    req.method = method; req.url = path;
    req.headers = { host: 'pacosat.test', origin: ORIGIN, 'x-pacosat-proxy': KEY, ...extraHeaders };
    let status = 0; const headers = {}; let text = '';
    const res = { writeHead(code, hdrs) { status = code; if (hdrs) Object.assign(headers, hdrs); },
      setHeader(k, v) { headers[k] = v; }, getHeader(k) { return headers[k]; },
      end(chunk) { if (chunk) text += Buffer.isBuffer(chunk) ? chunk.toString('latin1') : chunk; } };
    await service.handle(req, res);
    return { status, text, headers };
  };
  const call = async (method, path, body, extraHeaders = {}) => {
    if (!token) { const home = await raw('GET', '/'); token = /[0-9a-f]{64}/.exec(home.text)?.[0] || ''; }
    const r = await raw(method, path, body, { 'x-pacosat-token': token, ...extraHeaders });
    let json = null; try { json = JSON.parse(r.text); } catch { /* binario */ }
    return { status: r.status, json, text: r.text, headers: r.headers };
  };
  return { service, call, mails, clock };
}
const unlock = async (h, rfc) => {
  const open = await h.call('POST', '/api/unlock', { rfc, minutes: 1440, days: 7,
    direction: 'both', password: 'simulated', certificate: 'YQ==', key: 'Yg==' });
  assert.equal(open.status, 200, 'unlock de ' + rfc);
};
const xmlCfdi = ({ uuid, fecha, emisor, receptor, total }) => {
  const sub = (Number(total) / 1.16).toFixed(2);
  const tax = (Number(total) - Number(sub)).toFixed(2);
  return `<?xml version="1.0" encoding="UTF-8"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital" Version="4.0" Fecha="${fecha}" SubTotal="${sub}" Moneda="MXN" Total="${total}" TipoDeComprobante="I" MetodoPago="PPD" FormaPago="99" LugarExpedicion="72000">
<cfdi:Emisor Rfc="${emisor}" Nombre="EMISOR SA" RegimenFiscal="601"/>
<cfdi:Receptor Rfc="${receptor}" Nombre="RECEPTOR SA" DomicilioFiscalReceptor="72000" RegimenFiscalReceptor="601" UsoCFDI="G03"/>
<cfdi:Conceptos><cfdi:Concepto ClaveProdServ="01010101" Cantidad="1" ClaveUnidad="H87" Descripcion="Servicio" ValorUnitario="${sub}" Importe="${sub}" ObjetoImp="02"><cfdi:Impuestos><cfdi:Traslados><cfdi:Traslado Base="${sub}" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="${tax}"/></cfdi:Traslados></cfdi:Impuestos></cfdi:Concepto></cfdi:Conceptos>
<cfdi:Impuestos TotalImpuestosTrasladados="${tax}"><cfdi:Traslados><cfdi:Traslado Base="${sub}" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="${tax}"/></cfdi:Traslados></cfdi:Impuestos>
<cfdi:Complemento><tfd:TimbreFiscalDigital Version="1.1" UUID="${uuid}" FechaTimbrado="${fecha}" RfcProvCertif="SAT970701NN3" SelloCFD="AAAAAAAA" NoCertificadoSAT="00001000000500000001" SelloSAT="BBBB"/></cfdi:Complemento>
</cfdi:Comprobante>`;
};
const seedInvoice = async (h, spec) => {
  const xml = xmlCfdi(spec);
  const row = parseXml(Buffer.from(xml), DOMParser);
  const seed = await h.call('POST', '/api/storage', { batch: {
    people: [{ id: OWN, name: 'EMPRESA PROPIA SA' }, { id: BBB, name: 'PROVEEDOR SA' }],
    invoices: [row],
    files: [{ id: 'xml:' + row.id, mime: 'application/xml', content: Buffer.from(xml).toString('base64') }] } });
  assert.equal(seed.status, 200, 'semilla de factura');
  return row;
};
const espera = ms => new Promise(resolve => setTimeout(resolve, ms));
async function hastaQue(fn, ms = 6000) {
  const fin = Date.now() + ms;
  for (;;) { if (await fn()) return true; if (Date.now() > fin) return false; await espera(60); }
}

/* ---------- 20a · Licencia: huella y verificación Ed25519 ---------- */
{
  const comps = [
    { id: 'equipo', valor: 'PC-PRUEBA' }, { id: 'mac', valor: 'aa:bb:cc:dd:ee:ff' },
    { id: 'cpu', valor: 'CPU de prueba' }, { id: 'plataforma', valor: 'win32-x64' }];
  const hashes = huellaMaquina(comps);
  assert.equal(hashes.length, 4);
  assert.ok(hashes.every(h => /^[0-9a-f]{64}$/.test(h)), 'la huella son hashes SHA-256');
  assert.ok(!JSON.stringify(hashes).includes('PC-PRUEBA'), 'la huella no guarda valores en claro');
  assert.equal(hashComponente(comps[0]), hashComponente({ id: 'equipo', valor: 'PC-PRUEBA' }), 'huella estable');
  assert.notEqual(hashComponente(comps[0]), hashComponente({ id: 'equipo', valor: 'OTRO-PC' }), 'huella distinta por valor');
  assert.ok(componentesDeMaquina().length >= 2, 'los componentes por defecto se leen sin privilegios');

  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
  const docBase = { titular: 'Cliente de Prueba SA', rfcMax: 3, maquina: hashes,
    expedicion: '2026-01-01', caducidad: '2027-01-01' };
  const firma = cryptoSign(null, Buffer.from(payloadCanonicoLicencia(docBase), 'utf8'), privateKey).toString('base64');
  const doc = { ...docBase, firma };
  const ahora = Date.parse('2026-06-01T12:00:00Z');

  const buena = verificarLicencia(doc, comps, pubPem, ahora);
  assert.equal(buena.valida, true, 'licencia bien firmada y en su equipo: ' + buena.motivo);
  assert.equal(buena.coincidencias, 4);

  const tresDeCuatro = comps.map(c => c.id === 'cpu' ? { ...c, valor: 'CPU cambiada' } : c);
  assert.equal(verificarLicencia(doc, tresDeCuatro, pubPem, ahora).valida, true,
    'mayoría (3 de 4) basta: un componente cambiado no mata la licencia');
  const dosDeCuatro = comps.map(c => (c.id === 'cpu' || c.id === 'mac') ? { ...c, valor: 'cambiado-' + c.id } : c);
  const mitad = verificarLicencia(doc, dosDeCuatro, pubPem, ahora);
  assert.equal(mitad.valida, false, 'la mitad exacta NO basta: hace falta más de la mitad');
  assert.match(mitad.motivo, /otro equipo/);

  const caducada = verificarLicencia(doc, comps, pubPem, Date.parse('2028-01-01T12:00:00Z'));
  assert.equal(caducada.valida, false); assert.match(caducada.motivo, /caducó/);
  const manipulada = verificarLicencia({ ...doc, titular: 'Otro Titular' }, comps, pubPem, ahora);
  assert.equal(manipulada.valida, false); assert.match(manipulada.motivo, /firma/);
  const sinClave = verificarLicencia(doc, comps, '', ahora);
  assert.equal(sinClave.valida, false); assert.match(sinClave.motivo, /clave/);
  console.log('OK 2.3.0 · 20a — licencia: huella irreversible, Ed25519, mayoría y caducidad en llano.');
}

/* ---------- 20b · Cableado comercial: apagado por defecto ---------- */
{
  delete process.env.PACOSAT_COMERCIAL;
  const hOff = makeHarness();
  const stOff = await hOff.call('GET', '/api/status');
  assert.equal(stOff.json.comercial, false, 'sin la variable, /api/status dice comercial:false');
  const rutaOff = await hOff.call('GET', '/api/comercial/estado');
  assert.equal(rutaOff.status, 404, 'sin la variable, la ruta comercial no existe');
  await hOff.service.close();

  process.env.PACOSAT_COMERCIAL = '1';
  try {
    const hOn = makeHarness();
    const stOn = await hOn.call('GET', '/api/status');
    assert.equal(stOn.json.comercial, true, 'con la variable, /api/status dice comercial:true');
    const estado = await hOn.call('GET', '/api/comercial/estado');
    assert.equal(estado.status, 200);
    assert.ok(Array.isArray(estado.json.huella) && estado.json.huella.length >= 2, 'la huella de esta máquina viaja');
    assert.ok(estado.json.huella.every(x => /^[0-9a-f]{64}$/.test(x)), 'solo hashes, nada en claro');
    assert.equal(estado.json.licencia.presente, false, 'sin documento local, se dice');
    await hOn.service.close();
  } finally { delete process.env.PACOSAT_COMERCIAL; }
  console.log('OK 2.3.0 · 20b — comercial apagado por defecto; con la variable, estado y huella.');
}

/* ---------- 3 · Declaraciones: resumen por ejercicio ---------- */
{
  const h = makeHarness();
  h.clock.t = Date.parse('2026-11-20T15:00:00Z'); /* 20 nov en casa */
  await unlock(h, OWN);
  let r = await h.call('GET', '/api/declaraciones/resumen?rfc=' + OWN);
  assert.equal(r.status, 200);
  assert.equal(r.json.ejercicio, 2026, 'el ejercicio por defecto es el año en curso en hora de casa');
  assert.equal(r.json.conocidas, 0);
  assert.equal(r.json.faltaPeriodo, '2026-01', 'sin nada presentado, el primer mes que falta es enero');
  assert.equal(r.json.faltaMes, 1);
  assert.equal(r.json.hayDatos, false);

  const up = await h.call('POST', '/api/declaraciones/upload', { rfc: OWN, tipo: 'mensual', clase: 'acuse',
    ejercicio: 2026, periodo: '2026-01', content: PDF64 });
  assert.equal(up.status, 200); assert.equal(up.json.filed, true);
  r = await h.call('GET', '/api/declaraciones/resumen?rfc=' + OWN + '&ejercicio=2026');
  assert.equal(r.json.faltaPeriodo, '2026-02', 'con enero presentado, el primer mes que falta es febrero');
  assert.equal(r.json.faltaMes, 2);
  assert.equal(r.json.hayDatos, true, 'ya consta un documento del ejercicio');
  assert.equal(r.json.conocidas, 0, 'sin número de operación, el cruce no conoce operaciones: no se inventa');

  const folio = await h.call('POST', '/api/declaraciones/folios', { rfc: OWN, folio: '2300000001',
    tipo: 'mensual', ejercicio: 2026, periodo: '2026-02' });
  assert.equal(folio.status, 200);
  r = await h.call('GET', '/api/declaraciones/resumen?rfc=' + OWN + '&ejercicio=2026');
  assert.equal(r.json.conocidas, 1, 'las conocidas salen de declCruce201 (el folio anotado)');
  assert.equal(r.json.faltaPeriodo, '2026-02', 'el folio sin acuse no da el mes por presentado');

  r = await h.call('GET', '/api/declaraciones/resumen?rfc=' + OWN + '&ejercicio=2025');
  assert.deepEqual([r.json.conocidas, r.json.faltaPeriodo, r.json.faltaMes, r.json.hayDatos],
    [0, '2025-01', 1, false], 'otro ejercicio, su propia foto');
  const nf = await h.call('GET', '/api/declaraciones/resumen?rfc=' + BBB);
  assert.equal(nf.status, 404, 'un RFC sin perfil no tiene resumen');
  await h.service.close();
  console.log('OK 2.3.0 · 3 — resumen de declaraciones: conocidas del cruce y primer mes que falta del mapa.');
}

/* ---------- 4 · Barrido: diario propio y estimación en tiempos201 ---------- */
{
  let liberar = null;
  const h = makeHarness({ monitorOptions: {
    checkSat: async () => {
      if (liberar) { const f = liberar; liberar = null; await new Promise(res => { f(res); }); }
      return { state: 'Vigente', cancellation: '' };
    },
    refreshEfos: async () => new Map() } });
  await unlock(h, OWN);
  const sinBarrido = await h.call('GET', '/api/tiempos201');
  assert.equal(sinBarrido.json.porTipo.barrido, undefined, 'sin pasadas, no hay estimación de barrido');

  const pasadasEnActividad = async () => {
    const rows = await h.call('GET', '/api/storage?store=activity');
    return (Array.isArray(rows.json) ? rows.json : []).filter(x => String(x.id || '').startsWith('sweep:')).length;
  };
  const uuids = ['23000000-2026-4000-8000-000000000001', '23000000-2026-4000-8000-000000000002',
    '23000000-2026-4000-8000-000000000003'];
  for (let i = 0; i < 3; i++) {
    const row = await seedInvoice(h, { uuid: uuids[i], fecha: '2026-11-10T10:00:00', emisor: BBB, receptor: OWN, total: '1160.00' });
    const reg = await h.call('POST', '/api/monitor', { records: [{ id: row.id, emitter: row.from.rfc,
      receiver: row.to.rfc, total: row.total, seal: row.seal }], ids: [] });
    assert.equal(reg.status, 200, 'la factura entra en la vigilancia');
    let resuelve;
    liberar = res => { resuelve = res; };
    const arranque = await h.call('POST', '/api/monitor/check-now', { ids: [uuids[i]] });
    assert.equal(arranque.status, 200);
    if (i === 0) {
      const actividad = await h.call('GET', '/api/activity');
      assert.ok(actividad.json.running.some(t => t.kind === 'barrido'),
        'la lista de trabajos en curso enseña el barrido con kind «barrido»');
    }
    h.clock.t += 60000; /* la pasada dura un minuto de reloj de casa */
    resuelve({ state: 'Vigente', cancellation: '' });
    const hechas = await hastaQue(async () => (await pasadasEnActividad()) >= i + 1);
    assert.ok(hechas, 'la pasada ' + (i + 1) + ' del barrido terminó y dejó su actividad');
    if (i < 2) {
      const parcial = await h.call('GET', '/api/tiempos201');
      assert.equal(parcial.json.porTipo.barrido, undefined,
        'con menos de 3 muestras la estimación sigue sin enseñarse (honesto)');
    }
  }
  const tiempos = await h.call('GET', '/api/tiempos201');
  assert.ok(tiempos.json.porTipo.barrido, 'con 3 pasadas, el barrido ya tiene estimación');
  assert.equal(tiempos.json.porTipo.barrido.muestras, 3);
  assert.equal(tiempos.json.porTipo.barrido.medianaMs, 60000);
  assert.equal(tiempos.json.porTipo.barrido.medianaTexto, '~1 min');
  /* El alias del cliente: tiempoEstimado201 busca primero porTipo[kind]
     con el kind del trabajo de Actividad — «barrido» contra «barrido». */
  assert.equal(tiempos.json.porTipo['barrido'].medianaTexto, '~1 min', 'la clave directa del cliente encuentra «barrido»');
  await h.service.close();
  console.log('OK 2.3.0 · 4 — barrido con diario propio: tiempos201 estima «barrido» desde 3 pasadas reales.');
}

/* ---------- 7 · Plan: yaPedida antes de quemar el criterio ---------- */
{
  const h = makeHarness();
  await unlock(h, OWN);
  const plan = { rfc: OWN, direction: 'received', type: 'cfdi', start: '2026-10-01', end: '2026-10-31' };
  let p = await h.call('POST', '/api/plan', plan);
  assert.equal(p.status, 200);
  assert.equal(p.json.yaPedida, null, 'criterio nuevo: el plan dice que nunca se ha pedido');
  assert.equal(p.json.state, 'disponible');
  const envio = await h.call('POST', '/api/request', { rfc: OWN, direction: 'received', start: '2026-10-01', end: '2026-10-31' });
  assert.equal(envio.status, 200, 'la solicitud sale con el conector de juguete');
  p = await h.call('POST', '/api/plan', plan);
  assert.equal(p.json.state, 'ultima', 'la guardia no cambia: el criterio ya va usado una vez');
  assert.deepEqual(p.json.yaPedida, { at: h.clock.t, requestId: 'req-230-1' },
    'el plan avisa ANTES: esta combinación exacta ya consta enviada, con su hora y su folio');
  const otro = await h.call('POST', '/api/plan', { ...plan, start: '2026-09-01', end: '2026-09-30' });
  assert.equal(otro.json.yaPedida, null, 'otro periodo exacto: sin aviso, porque no consta');
  await h.service.close();
  console.log('OK 2.3.0 · 7 — el plan trae yaPedida {at, requestId} solo si la combinación exacta ya consta enviada.');
}

/* ---------- 8 · Registro: búsqueda en el servidor, antes del tope ---------- */
{
  const dir = mkdtempSync(join(tmpdir(), 'pacosat-230-registro-'));
  const dbFile = join(dir, 'pacosat.sqlite');
  const h = makeHarness({ dbFile });
  const base = h.clock.t - 200 * 60000;
  const filas = [];
  for (let i = 0; i < 120; i++)
    filas.push({ id: 'act-230-' + i, name: i === 0 ? 'Aguja dorada del registro buscable' : 'Suceso ordinario número ' + i,
      at: base + i * 60000, rfc: '', ok: true });
  const seed = await h.call('POST', '/api/storage', { batch: { activity: filas } });
  assert.equal(seed.status, 200);
  /* Una corrida con la aguja SOLO en su detalle (pasos), no en su texto. */
  const directa = new DatabaseSync(dbFile);
  directa.prepare('INSERT INTO decl_runs(id,rfc,tipo,ejercicio,periodo,started,finished,ok,error,errorKind,steps,attempts) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    .run('run-aguja-230', OWN, 'mensual', 2026, '', base + 300 * 60000, base + 300 * 60000 + 5000, 0,
      'fallo simple de portal', 'portal', JSON.stringify([{ paso: 'abrir el portal', detalle: 'la palabrasecreta vive en el detalle' }]), 1);
  directa.close();

  const tope = await h.call('GET', '/api/registro?limit=5');
  assert.equal(tope.json.items.length, 5);
  assert.ok(!tope.json.items.some(x => String(x.texto).includes('Aguja dorada')),
    'sin búsqueda, el tope deja la aguja fuera (es la entrada más vieja)');
  const hallada = await h.call('GET', '/api/registro?limit=5&texto=' + encodeURIComponent('aguja dorada'));
  assert.ok(hallada.json.total >= 1 && hallada.json.items.some(x => String(x.texto).includes('Aguja dorada')),
    'con texto, el servidor filtra ANTES del tope y la aguja aparece');
  const mayus = await h.call('GET', '/api/registro?limit=5&texto=AGUJA');
  assert.ok(mayus.json.items.some(x => String(x.texto).includes('Aguja dorada')), 'sin distinción de mayúsculas');
  const enDetalle = await h.call('GET', '/api/registro?limit=5&texto=palabrasecreta');
  assert.ok(enDetalle.json.total >= 1, 'la búsqueda también mira el detalle de la entrada');
  const nada = await h.call('GET', '/api/registro?texto=inexistente-xyz-230');
  assert.equal(nada.json.total, 0); assert.deepEqual(nada.json.items, []);
  await h.service.close();
  rmSync(dir, { recursive: true, force: true });
  console.log('OK 2.3.0 · 8 — el Registro busca en el servidor (texto y detalle) antes de aplicar el tope.');
}

/* ---------- 13 · Conciliación de Bancos en PDF y Excel ---------- */
{
  let textoEstado = '';
  const h = makeHarness({ extractText: async () => textoEstado });
  await unlock(h, OWN);
  const alta = await h.call('POST', '/api/banks/accounts',
    { bank: 'BBVA', name: 'Cuenta prueba', kind: 'cuenta', last4: '1234', rfc: OWN });
  const cuenta = alta.json.accounts[0];
  textoEstado = ['BBVA MEXICO · ESTADO DE CUENTA', 'Saldo inicial $9,000.00', 'Saldo final $8,500.00',
    'Total de abonos $0.00', 'Total de cargos $500.00',
    '03/11/2026 PAGO TARJETA CREDITO $500.00 $8,500.00'].join('\n');
  const pdf64 = Buffer.from('%PDF-1.7 estado de juguete ' + 'x'.repeat(120)).toString('base64');
  const aplicado = await h.call('POST', '/api/banks/statements', { accountId: cuenta.id, month: '2026-11', content: pdf64 });
  assert.equal(aplicado.status, 200);
  const vista = await h.call('GET', '/api/banks/conciliacion?month=2026-11');
  assert.equal(vista.json.porCuenta[0].conteos.pagosSinFactura, 1, 'el cálculo de Bancos ve el pago sin factura');

  const pdf = await h.call('GET', '/api/reportes/conciliacion?rfc=' + OWN + '&mes=2026-11&formato=pdf');
  assert.equal(pdf.status, 200);
  assert.ok(String(pdf.headers['Content-Disposition'] || pdf.headers['content-disposition'] || '')
    .includes('conciliacion-' + OWN + '-2026-11.pdf'), 'el PDF baja con su nombre de archivo');
  assert.ok(pdf.text.startsWith('%PDF'), 'el artefacto es un PDF de verdad');
  assert.ok(pdf.text.includes('Pagos sin factura: 1'), 'el PDF trae los conteos del mismo cálculo de Bancos');
  assert.ok(pdf.text.includes('PAGO TARJETA'), 'y el movimiento que el cálculo encontró');

  const xlsx = await h.call('GET', '/api/reportes/conciliacion?rfc=' + OWN + '&mes=2026-11&formato=xlsx');
  assert.equal(xlsx.status, 200);
  assert.ok(String(xlsx.headers['Content-Disposition'] || xlsx.headers['content-disposition'] || '')
    .includes('conciliacion-' + OWN + '-2026-11.xlsx'), 'el Excel baja con su nombre de archivo');
  assert.equal(xlsx.text.slice(0, 2), 'PK', 'el artefacto es un xlsx (zip) de verdad');
  assert.ok(xlsx.text.includes('Pagos sin factura'), 'el Excel trae la hoja de pagos sin factura');

  const vacio = await h.call('GET', '/api/reportes/conciliacion?rfc=' + BBB + '&mes=2026-11&formato=pdf');
  assert.equal(vacio.status, 200, 'un RFC sin cuentas recibe su documento vacío, no un error');
  assert.ok(vacio.text.startsWith('%PDF'));
  const malMes = await h.call('GET', '/api/reportes/conciliacion?rfc=' + OWN + '&mes=2026-13-01&formato=pdf');
  assert.equal(malMes.status, 400, 'el mes se valida en llano');
  const malFormato = await h.call('GET', '/api/reportes/conciliacion?rfc=' + OWN + '&mes=2026-11&formato=csv');
  assert.equal(malFormato.status, 400, 'el formato es pdf o xlsx');
  await h.service.close();
  console.log('OK 2.3.0 · 13 — conciliación en PDF y Excel desde conciliacion200f, con su Content-Disposition.');
}

/* ---------- 17 · Paperless: probar en el acto ---------- */
{
  const falso = createServer((req, res) => {
    if (req.url === '/api/status/') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"status":"ok"}'); }
    else { res.writeHead(404); res.end('no'); }
  });
  await new Promise(resolve => falso.listen(0, '127.0.0.1', resolve));
  const puerto = falso.address().port;
  try {
    const h = makeHarness();
    let p = await h.call('POST', '/api/paperless/probar', {});
    assert.equal(p.json.ok, false); assert.match(p.json.texto, /dirección/, 'sin configurar, se dice qué falta');
    const cfg = await h.call('POST', '/api/paperless/config',
      { enabled: true, baseUrl: 'http://127.0.0.1:' + puerto, token: 'token-secreto-230' });
    assert.equal(cfg.status, 200);
    p = await h.call('POST', '/api/paperless/probar', {});
    assert.equal(p.json.ok, true, 'Paperless responde y acepta el token: ' + p.json.texto);
    assert.match(p.json.texto, /Conectado/);
    assert.ok(!JSON.stringify(p.json).includes('token-secreto-230'), 'el token jamás sale en la respuesta');
    await h.call('POST', '/api/paperless/config', { enabled: true, baseUrl: 'http://127.0.0.1:1' });
    p = await h.call('POST', '/api/paperless/probar', {});
    assert.equal(p.json.ok, false); assert.match(p.json.texto, /No se pudo conectar/);
    await h.service.close();

    const h2 = makeHarness();
    await h2.call('POST', '/api/paperless/config', { enabled: true, baseUrl: 'http://127.0.0.1:' + puerto });
    const sinToken = await h2.call('POST', '/api/paperless/probar', {});
    assert.equal(sinToken.json.ok, false); assert.match(sinToken.json.texto, /token/);
    await h2.service.close();
  } finally { falso.close(); }
  console.log('OK 2.3.0 · 17 — Paperless se prueba en el acto y responde en llano, sin exponer el token.');
}

/* ---------- 19 · Ensayo de restauración: en el acto y {ok, detail, at} ---------- */
{
  const h = makeHarness();
  const sin = await h.call('POST', '/api/backup/restore-test', {});
  assert.equal(sin.status, 200, 'sin contraseña no es un error: es un gesto pendiente, con su forma completa');
  assert.equal(sin.json.ok, false);
  assert.equal(sin.json.pendienteDePaco, true);
  assert.match(sin.json.detail, /contraseña de respaldo/);
  assert.ok(Number(sin.json.at) > 0, 'la respuesta trae su hora (at)');
  await h.service.close();

  const dir = mkdtempSync(join(tmpdir(), 'pacosat-230-restore-'));
  const h2 = makeHarness({ dbFile: join(dir, 'pacosat.sqlite') });
  await unlock(h2, OWN);
  await seedInvoice(h2, { uuid: '23000000-2026-4000-8000-000000009999', fecha: '2026-10-05T10:00:00',
    emisor: BBB, receptor: OWN, total: '2320.00' });
  await h2.service.bootstrap({ backup: { password: 'respaldo-prueba-230', frequency: 'daily', dir: join(dir, 'respaldos') } });
  const sinConjunto = await h2.call('POST', '/api/backup/restore-test', {});
  assert.equal(sinConjunto.status, 200);
  assert.equal(sinConjunto.json.ok, false);
  assert.equal(sinConjunto.json.at, h2.clock.t, 'con contraseña pero sin copia aún, responde {ok, detail, at}');
  assert.match(sinConjunto.json.detail, /Todavía no hay ningún conjunto/);
  await h2.service.tick();
  const ensayo = await h2.call('POST', '/api/backup/restore-test', {});
  assert.equal(ensayo.status, 200);
  assert.equal(ensayo.json.ok, true, 'el ensayo corre EN EL ACTO contra la copia recién hecha');
  assert.equal(ensayo.json.at, h2.clock.t);
  assert.match(ensayo.json.detail, /La copia resucita/);
  await h2.service.close();
  rmSync(dir, { recursive: true, force: true });
  console.log('OK 2.3.0 · 19 — ensayo de restauración en el acto, siempre {ok, detail, at}; sin contraseña, gesto pendiente en llano.');
}

console.log('ronda230servidor.test: ok');
