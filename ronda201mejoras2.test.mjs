/* ================================================================
   Ronda 2.0.1 · Fase 1 (servidor) — ampliación nº 21–30:
   (nº 21) la puerta expone ultimoExito (el último éxito REAL,
   derivado del último trabajo del portal terminado bien cuando
   la columna aún no lo trae) junto a la foto de la última prueba;
   (nº 22) /api/tiempos201: mediana real por tipo con mínimo de
   3 muestras — el tipo con 2 no sale —;
   (nº 23) cerrar el ejercicio sella su foto (foto201 en
   /api/ejercicios200g); una alta posterior de ese ejercicio la
   marca tocada y Salud la enseña; desbloquear retira el sello;
   (nº 27) /api/status trae ejecutorEspera201: cola, días sin
   señal, dormido y el paso exacto;
   (nº 29) el PDF de contraparte trae la sección de estado en
   los listados y acepta el periodo (month);
   (nº 30) /api/banks/conciliacion expone facturasSinPagoVisto
   (la factura sin movimiento que la respalde), de solo lectura.
   Cada cifra esperada sale de las semillas de esta misma prueba.
   ================================================================ */
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createPacoSATService } from './local-server.mjs';
import { buildPdf } from './salidas-doc.mjs';

const ORIGIN = 'https://pacosat.test';
const KEY = 'f'.repeat(64);
const OWN = 'MFI6212158B4';
const PROV1 = 'AAA010101AAA';
const D1 = '11111111-1111-4111-8111-111111111111';
const D2 = '22222222-2222-4222-8222-222222222222';
const NUEVA = '55555555-5555-4555-8555-555555555555';
const T0 = Date.parse('2026-11-05T15:00:00Z');
const DAY = 86400000;

function makeHarness(dbFile, mails) {
  let time = T0;
  let token = '';
  const service = createPacoSATService({
    dbFile, html: '<html><head><!--PACOSAT_TOKEN--></head><body>prueba</body></html>',
    origin: ORIGIN, proxyKey: KEY, now: () => time,
    extractText: async () => '',
    makeConnector: async () => ({ parser: class {}, connector: {
      request: async () => 'req-f', check: async () => ({ status: 'pending', packages: [] }),
      download: async () => { throw new Error('sin paquetes'); } } }),
    makeMailer: () => ({ verify: async () => true,
      sendMail: async mail => { mails.push(mail); return { messageId: 'm' + mails.length }; } }) });
  const raw = async (method, path, body, extraHeaders = {}) => {
    const chunks = []; if (body !== undefined) chunks.push(Buffer.from(JSON.stringify(body)));
    const req = Readable.from(chunks);
    req.method = method; req.url = path;
    req.headers = { host: 'pacosat.test', origin: ORIGIN, 'x-pacosat-proxy': KEY, ...extraHeaders };
    let status = 0; let text = '';
    const res = { writeHead(c) { status = c; }, setHeader() {}, getHeader() { return undefined; },
      end(chunk) { if (chunk) text += Buffer.isBuffer(chunk) ? chunk.toString('latin1') : chunk; } };
    await service.handle(req, res);
    return { status, text };
  };
  const call = async (method, path, body, headers = {}) => {
    if (!token) { const home = await raw('GET', '/'); token = /[0-9a-f]{64}/.exec(home.text)?.[0] || ''; }
    const r = await raw(method, path, body, { 'x-pacosat-token': token, ...headers });
    let json = null; try { json = JSON.parse(r.text); } catch { /* binario */ }
    return { status: r.status, json, text: r.text };
  };
  return { service, call, set time(v) { time = v; }, get time() { return time; } };
}
const invoice = (id, date, from, to, total, folio) => ({ id, date, kind: 'I',
  from: { rfc: from, name: 'EMPRESA ' + from }, to: { rfc: to, name: 'EMPRESA ' + to },
  total, currency: 'MXN', fiscal: { series: 'A', folio, paymentMethod: 'PPD',
    transferred: [{ tax: '002', rate: '0.160000', amount: '0.00' }], withheld: [] } });
const pdfText = async buffer => {
  const doc = await getDocument({ data: new Uint8Array(buffer) }).promise;
  let text = '';
  for (let i = 1; i <= doc.numPages; i++)
    text += (await (await doc.getPage(i)).getTextContent()).items.map(item => item.str).join(' ') + '\n';
  return text;
};

const dir = mkdtempSync(join(tmpdir(), 'pacosat-201m2-'));
const dbFile = join(dir, 'pacosat.sqlite');
const mails = [];
try {
  {
    const boot = createPacoSATService({ dbFile, html: 'x', origin: ORIGIN, proxyKey: KEY });
    boot.close();
    const seed = new DatabaseSync(dbFile);
    seed.prepare("INSERT INTO profiles(rfc,minutes,days,direction,nextRun,error) VALUES (?,1440,7,'both',0,'')").run(OWN);
    const rec = seed.prepare("INSERT INTO records(store,id,value) VALUES ('invoices',?,?)");
    rec.run(D1, JSON.stringify(invoice(D1, '2026-10-05', PROV1, OWN, '1160.00', '100')));
    rec.run(D2, JSON.stringify(invoice(D2, '2026-10-06', PROV1, OWN, '500.00', '101')));
    /* Puerta: última prueba «no abre» de hace una hora; el último
       éxito REAL es la corrida del Buzón terminada bien. */
    seed.prepare("INSERT INTO sat_puerta(rfc,ok,probada,error,errorKind) VALUES (?,0,?,'sin firma','sin-efirma')").run(OWN, T0 - 3600000);
    seed.prepare("INSERT INTO trib_runs(id,rfc,started,finished,ok) VALUES ('trib-1',?,?,?,1)").run(OWN, T0 - 121000, T0 - 1000);
    /* Ejecutor dormido: emparejado, sin señal desde hace 2 días,
       con 2 trabajos en cola. */
    seed.prepare("INSERT INTO sat_executors(id,nombre,tokenHash,creado,ultimoVisto,revocado) VALUES ('ex-1','PC de Paco','h',?, ?,0)").run(T0 - 10 * DAY, T0 - 2 * DAY);
    const job = seed.prepare("INSERT INTO sat_executor_jobs(id,rfc,kind,estado,creado,actualizado) VALUES (?,?,?, 'en-cola',?,?)");
    job.run('job-q1', OWN, 'buzon-listar', T0 - 5000, T0 - 5000);
    job.run('job-q2', OWN, 'declaraciones-recuperar', T0 - 4000, T0 - 4000);
    /* Tiempos: 3 intentos de buzon-listar (60/120/180 s) y solo
       2 corridas de declaraciones (no alcanza el mínimo). */
    const att = seed.prepare("INSERT INTO sat_executor_attempts(id,jobId,executorId,started,finished,ok) VALUES (?,?,?,?,?,1)");
    att.run('at-1', 'job-q1', 'ex-1', T0 - 200000, T0 - 140000);
    att.run('at-2', 'job-q1', 'ex-1', T0 - 400000, T0 - 280000);
    att.run('at-3', 'job-q1', 'ex-1', T0 - 700000, T0 - 520000);
    const drun = seed.prepare("INSERT INTO decl_runs(id,rfc,tipo,ejercicio,started,finished,ok) VALUES (?,?, 'mensual',2026,?,?,1)");
    drun.run('dr-1', OWN, T0 - 100000, T0 - 40000);
    drun.run('dr-2', OWN, T0 - 300000, T0 - 200000);
    /* Bancos: cuenta y estado sin ningún movimiento: las dos
       facturas quedan «sin pago visto» en la conciliación. */
    seed.prepare("INSERT INTO bank_accounts(id,bank,name,last4,kind,created,rfc) VALUES ('cta-1','BBVA','Cuenta semilla','1234','debito',?,?)").run(T0, OWN);
    seed.prepare("INSERT INTO bank_statements(id,accountId,month,fileId,openingCents,closingCents,state,created) VALUES ('edo-1','cta-1','2026-10','',0,0,'applied',?)").run(T0);
    seed.close();
  }
  const h = makeHarness(dbFile, mails);

  /* ---- Nº 21 · ultimoExito real junto a la foto de la puerta ---- */
  {
    const status = await h.call('GET', '/api/status');
    assert.equal(status.status, 200);
    const puerta = status.json.puerta[OWN];
    assert.equal(puerta.ok, false, 'la foto sigue diciendo que la última prueba no abrió');
    assert.equal(puerta.probada, T0 - 3600000);
    assert.equal(puerta.ultimoExito, T0 - 1000,
      'el último éxito real es la corrida del Buzón terminada bien, no la foto de la prueba');
    console.log('OK 2.0.1·F1 nº21 — puerta: probada (foto) y ultimoExito (éxito real) viajan separados en /api/status.');
  }

  /* ---- Nº 27 · ejecutorEspera201 en /api/status ---- */
  {
    const status = await h.call('GET', '/api/status');
    const espera = status.json.ejecutorEspera201;
    assert.equal(espera.enCola, 2); assert.equal(espera.esperando, 2);
    assert.equal(espera.dormido, true, 'dos días sin señal = dormido');
    assert.equal(espera.diasSinSenal, 2);
    assert.ok(espera.paso.includes('arrancar.bat'), 'el paso exacto, en llano: ' + espera.paso);
    console.log('OK 2.0.1·F1 nº27 — ejecutorEspera201: cola, dormido, días y paso con arrancar.bat.');
  }

  /* ---- Nº 22 · tiempos por tipo de trabajo ---- */
  {
    const r = await h.call('GET', '/api/tiempos201');
    assert.equal(r.status, 200);
    const buzon = r.json.porTipo['buzon-listar'];
    assert.ok(buzon, 'buzon-listar tiene historial suficiente');
    assert.equal(buzon.muestras, 4, '3 intentos del ejecutor + 1 corrida del diario del Buzón');
    assert.equal(buzon.medianaMs, 120000, 'la mediana de 60/120/120/180 s es 120 s');
    assert.equal(buzon.medianaTexto, '~2 min');
    assert.equal(r.json.porTipo['declaraciones'], undefined,
      'declaraciones, con solo 2 muestras, no sale: sin historial no hay estimación');
    console.log('OK 2.0.1·F1 nº22 — tiempos201: mediana real con mínimo de 3 muestras; sin historial, nada.');
  }

  /* ---- Nº 30 · sin rastro: factura sin pago visto, expuesta ---- */
  {
    const r = await h.call('GET', '/api/banks/conciliacion?month=2026-10');
    assert.equal(r.status, 200);
    const cuenta = r.json.porCuenta.find(c => c.account.id === 'cta-1');
    assert.ok(cuenta, 'la cuenta viaja en la conciliación');
    assert.deepEqual(cuenta.facturasSinPagoVisto.map(f => f.uuid).sort(), [D1, D2].sort(),
      'las dos facturas del periodo, sin movimiento que las respalde, están listadas');
    assert.equal(cuenta.conteos.facturasSinPagoVisto, 2);
    console.log('OK 2.0.1·F1 nº30 — conciliación expone facturasSinPagoVisto por cuenta y periodo (solo lectura).');
  }

  /* ---- Nº 29 · PDF de contraparte con listados y periodo ---- */
  {
    const r = await h.call('POST', '/api/salidas/pdf', { kind: 'contraparte', rfc: OWN, contraparte: PROV1 });
    assert.equal(r.status, 200, JSON.stringify(r.json).slice(0, 200));
    const texto = await pdfText(Buffer.from(r.json.content, 'base64'));
    assert.ok(texto.includes('Estado en los listados oficiales'), 'la ficha trae su estado en los listados');
    assert.ok(texto.includes('Sin coincidencia en los listados'), 'sin coincidencia cargada, se dice tal cual');
    const rMes = await h.call('POST', '/api/salidas/pdf', { kind: 'contraparte', rfc: OWN, contraparte: PROV1, month: '2026-09' });
    const textoMes = await pdfText(Buffer.from(rMes.json.content, 'base64'));
    assert.ok(!textoMes.includes('1160'), 'con month=2026-09 la factura de octubre no entra en la ficha del periodo');
    console.log('OK 2.0.1·F1 nº29 — PDF de contraparte: sección de listados y filtro por periodo.');
  }

  /* ---- Nº 23 · foto del ejercicio: sellar, tocar, desbloquear ---- */
  {
    const cerrar = await h.call('POST', '/api/ejercicios200g/cerrar', { rfc: OWN, year: '2026' });
    assert.equal(cerrar.status, 200, JSON.stringify(cerrar.json));
    let lista = (await h.call('GET', '/api/ejercicios200g')).json;
    let fila = lista.ejercicios.find(e => e.rfc === OWN && e.year === '2026');
    assert.ok(fila.foto201, 'el cierre selló la foto');
    assert.equal(fila.foto201.foto.cfdi, 2, 'la foto cuenta los 2 CFDI de 2026 en ese momento');
    assert.equal(fila.fotoTocada201, false, 'recién sellada, no está tocada');
    /* Algo toca el ejercicio después: la subida manual de un
       acuse (una vía sin candado: archiveDeclaracion no lo
       comprueba) archiva un documento de 2026 tras el cierre. */
    const pdf64 = buildPdf({ title: 'Acuse semilla', subtitle: 'prueba',
      sections: [{ heading: 'Contenido', lines: ['Acuse.'] }] }).toString('base64');
    const alta = await h.call('POST', '/api/declaraciones/upload', { rfc: OWN, tipo: 'mensual',
      clase: 'acuse', ejercicio: 2026, periodo: '2026-10', content: pdf64 });
    assert.equal(alta.status, 200, JSON.stringify(alta.json).slice(0, 200));
    assert.equal(alta.json.filed, true, 'el acuse se archivó tras el cierre');
    lista = (await h.call('GET', '/api/ejercicios200g')).json;
    fila = lista.ejercicios.find(e => e.rfc === OWN && e.year === '2026');
    assert.equal(fila.fotoTocada201, true, 'la foto ya no coincide: el ejercicio fue tocado');
    assert.ok(fila.fotoDiferencias201.includes('declaraciones'), 'la diferencia nombra los documentos de declaraciones');
    const salud = await h.call('GET', '/api/salud');
    assert.ok((salud.json.tarjetas || []).some(t => t.id === 'foto-ejercicio'),
      'Salud enseña la tarjeta del ejercicio cerrado que cambió');
    const desbloq = await h.call('POST', '/api/ejercicios200g/desbloquear', { rfc: OWN, year: '2026', confirmar: true });
    assert.equal(desbloq.status, 200);
    lista = (await h.call('GET', '/api/ejercicios200g')).json;
    fila = lista.ejercicios.find(e => e.rfc === OWN && e.year === '2026');
    assert.equal(fila.foto201, null, 'al desbloquear, el sello se retira con el candado');
    console.log('OK 2.0.1·F1 nº23 — foto del ejercicio: sella al cerrar, detecta el toque, se retira al desbloquear.');
  }
  h.service.close();
  console.log('OK ronda201mejoras2 — ampliación 21–30 (servidor) completa.');
} finally { rmSync(dir, { recursive: true, force: true }); }
