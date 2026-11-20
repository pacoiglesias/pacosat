import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DOMParser } from '@xmldom/xmldom';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createPacoSATService, pacosatCriteriaKey } from './local-server.mjs';

/* ================================================================
   Ronda 2.9.13 · SERVIDOR — Bloque A (plan y Salud), Bloque B
   (Leer comunicados), Bloque D (duplicados con veredicto) y
   Bloque E (encabezado único de reportes).

   (a) El «ya se pidió» en sus dos sabores, contra /api/plan:
       la ventana W1 consta pedida y su trabajo TERMINÓ
       (cubierta); la ventana W2 consta pedida y su trabajo
       sigue VIVO y RETENIDO por Paco (held=1). En ambos el
       plan contesta yaPedida y recomienda la variante.
   (A4/D1) Con SOLO trabajos retenidos vivos, la tarjeta de
       Salud «Solicitudes en el SAT» NO sale «mal»: las
       retenidas viajan contadas y atribuidas («por ti»).
   (D4) Duplicados: el grupo mismo importe/fecha sale como
       sospechoso con su clave; el veredicto de Paco lo mueve
       a «resueltos» (sigue constando, deja de gritar); la
       nómina agrupada se cuenta como conocida, nunca como
       sospecha; «reabrir» devuelve el grupo a la lista.
   (B) POST /api/buzon/comunicado: con la orden expresa, el
       paseo trae el cuerpo de ESE comunicado; un folio que no
       está en la lista contesta en llano; en sede de ejecutor
       remoto la respuesta es honesta (no viaja en su paquete).
   (E) Los 7 reportes en PDF comparten el encabezado: sin la
       línea vieja «RFC: …» repetida, las partes una sola vez
       (la persona física en orden natural) y «PacoSAT 2.9.13»
       una sola vez en la primera página.

   (2.9.15 · RE-BASE NOMBRADA de la marca: la línea de
   «generado» del PDF lleva la versión CORRIENTE de la app;
   las tres aserciones de la marca de esta suite se re-basan
   de «PacoSAT 2.9.14» a «PacoSAT 2.9.15» porque la versión
   subió — el hecho que guardan — la marca sale UNA sola vez
   en la primera página — no cambia. Las demás aserciones de
   esta suite no se tocan.)

   Contra la 2.9.12 esta suite corre en ROJO: el plan no
   distinguía (la tarjeta ni siquiera llegaba al plan con el
   sentido válido), Salud pintaba «mal» por las retenidas, los
   duplicados no admitían veredicto, la ruta del comunicado no
   existía y los encabezados repetían el RFC.
   ================================================================ */

const ORIGIN = 'https://pacosat.test';
const KEY = 'c'.repeat(64);
const OWN = 'MFI6212158B4';
const PROV = 'AAA010101AAA';
const FISICA = 'MOTB710506V15';
const T0 = Date.parse('2026-11-18T15:00:00Z');
const D1 = '11111111-1111-4111-8111-111111111111';
const D2 = '22222222-2222-4222-8222-222222222222';
const N1 = '55555555-5555-4555-8555-555555555555';
const N2 = '66666666-6666-4666-8666-666666666666';
const F1 = '77777777-7777-4777-8777-777777777777';

function makeHarness(dbFile, options = {}) {
  const clock = { t: T0 };
  const service = createPacoSATService({
    dbFile, html: '<html><head><!--PACOSAT_TOKEN--></head><body>prueba</body></html>',
    origin: ORIGIN, proxyKey: KEY, now: () => clock.t,
    makeConnector: () => ({ parser: DOMParser, connector: {
      request: async () => 'req-2913', check: async () => ({ status: 'pending', packages: [] }),
      download: async () => { throw new Error('sin paquetes'); } } }),
    makeMailer: () => ({ verify: async () => true,
      sendMail: async () => ({ messageId: 'm1' }) }),
    ...options });
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
    return { status: r.status, json, text: r.text };
  };
  return { service, call, clock };
}
const unlock = async (h, rfc = OWN) => {
  const open = await h.call('POST', '/api/unlock', { rfc, minutes: 1440, days: 7,
    direction: 'both', password: 'simulated', certificate: 'YQ==', key: 'Yg==' });
  assert.equal(open.status, 200, 'unlock de ' + rfc);
};
const invoice = (id, date, from, to, total, folio, kind = 'I', serie = 'A') => ({ id, date, kind,
  from: { rfc: from, name: 'EMPRESA ' + from }, to: { rfc: to, name: 'EMPRESA ' + to },
  total, currency: 'MXN', fiscal: { series: serie, folio, paymentMethod: 'PPD',
    transferred: [{ tax: '002', rate: '0.160000', amount: '0.00' }], withheld: [] } });

const dir = mkdtempSync(join(tmpdir(), 'pacosat-2913-'));
const dbFile = join(dir, 'pacosat.sqlite');
try {
  /* ===== Semilla: esquema + filas directas ===== */
  {
    const boot = createPacoSATService({ dbFile, html: 'x', origin: ORIGIN, proxyKey: KEY });
    boot.close();
    const seed = new DatabaseSync(dbFile);
    seed.prepare("INSERT INTO profiles(rfc,minutes,days,direction,nextRun,error) VALUES (?,1440,7,'both',0,'')").run(OWN);
    const persona = seed.prepare("INSERT INTO records(store,id,value) VALUES ('people',?,?)");
    persona.run(OWN, JSON.stringify({ id: OWN, name: 'MANO FIL SA' }));
    persona.run(FISICA, JSON.stringify({ id: FISICA, name: 'MONES TORRE JOSE BENITO' }));
    const rec = seed.prepare("INSERT INTO records(store,id,value) VALUES ('invoices',?,?)");
    /* El par sospechoso: mismo importe y fecha, folios distintos. */
    rec.run(D1, JSON.stringify(invoice(D1, '2026-10-05', PROV, OWN, '1160.00', '100')));
    rec.run(D2, JSON.stringify(invoice(D2, '2026-10-05', PROV, OWN, '1160.00', '101')));
    /* La nómina agrupada conocida: clase N, mismo importe y fecha. */
    rec.run(N1, JSON.stringify(invoice(N1, '2026-11-13', OWN, FISICA, '8000.00', '500', 'N')));
    rec.run(N2, JSON.stringify(invoice(N2, '2026-11-13', OWN, FISICA, '8000.00', '501', 'N')));
    /* Una factura de la contraparte física (para el reporte E):
       su nombre fiscal, como consta en el CFDI, es el que el
       encabezado presenta en orden natural. */
    { const f1 = invoice(F1, '2026-11-03', FISICA, OWN, '2320.00', '700');
      f1.from.name = 'MONES TORRE JOSE BENITO';
      rec.run(F1, JSON.stringify(f1)); }
    /* Criterios ya pedidos: W1 (trabajo terminado) y W2 (vivo retenido). */
    const crit = seed.prepare("INSERT INTO criteria(key,rfc,direction,type,emitter,receiver,startAt,endAt,requestId,origin,sentAt) VALUES (?,?, 'received','cfdi','','',?,?,?,'manual',?)");
    const claveDe = (startAt, endAt) => pacosatCriteriaKey({ rfc: OWN, direction: 'received',
      type: 'cfdi', emitter: '', receiver: '', startAt, endAt });
    crit.run(claveDe('2026-11-01 00:00:00', '2026-11-10 23:59:59'), OWN,
      '2026-11-01 00:00:00', '2026-11-10 23:59:59', 'req-w1', T0 - 900000);
    crit.run(claveDe('2026-11-11 00:00:00', '2026-11-16 23:59:59'), OWN,
      '2026-11-11 00:00:00', '2026-11-16 23:59:59', 'req-w2', T0 - 800000);
    const job = seed.prepare("INSERT INTO jobs(rfc,direction,periodStart,periodEnd,startAt,endAt,requestId,status,imported,due,created,error,checks,held) VALUES (?,?,?,? ,?,?,?,?, '[]',0,?,'',0,?)");
    job.run(OWN, 'received', '2026-11-01', '2026-11-10', '2026-11-01 00:00:00', '2026-11-10 23:59:59', 'req-w1', 'finished', T0 - 900000, 0);
    job.run(OWN, 'received', '2026-11-11', '2026-11-16', '2026-11-11 00:00:00', '2026-11-16 23:59:59', 'req-w2', 'pending', T0 - 800000, 1);
    seed.close();
  }

  const h = makeHarness(dbFile, { executorMode: 'nas' });
  try {
    await unlock(h);

    /* ===== (a) El plan en sus dos sabores ===== */
    {
      const w1 = await h.call('POST', '/api/plan', { rfc: OWN, direction: 'received',
        type: 'cfdi', start: '2026-11-01', end: '2026-11-10' });
      assert.equal(w1.status, 200, 'plan W1 responde');
      assert.ok(w1.json.yaPedida, '(a) W1 consta pedida: su trabajo terminó (ventana cubierta)');
      assert.equal(w1.json.recommendation, 'variant', '(a) W1: la recomendación es la variante');
      const w2 = await h.call('POST', '/api/plan', { rfc: OWN, direction: 'received',
        type: 'cfdi', start: '2026-11-11', end: '2026-11-16' });
      assert.ok(w2.json.yaPedida, '(a) W2 consta pedida: su trabajo vivo está retenido por Paco');
      assert.equal(w2.json.recommendation, 'variant', '(a) W2: también variante, nunca el criterio exacto');
      console.log('OK 2.9.13-servidor · (a) — el plan dice «ya se pidió» en los dos sabores: cubierta y retenida.');
    }

    /* ===== (A4/D1) Salud no se pinta de mal por las retenidas ===== */
    {
      const st = await h.call('GET', '/api/salud');
      assert.equal(st.status, 200);
      /* Hay dos tarjetas con el id histórico: la del ritmo del
         SAT de hoy y la de las vivas; la de la ronda es la que
         trae las retenidas en sus datos. */
      const tarjeta = (st.json.tarjetas || []).find(t => t.id === 'solicitudes-vivas' && t.datos?.retenidas);
      assert.ok(tarjeta, 'la tarjeta de solicitudes vivas existe en el estado');
      assert.notEqual(tarjeta.estado, 'mal',
        '(A4/D1) con solo trabajos retenidos por su dueño, la tarjeta NO sale «mal»');
      assert.equal(tarjeta.datos?.retenidas?.length, 1,
        '(A4/D1) la retenida viaja contada en la tarjeta');
      assert.equal(tarjeta.datos?.deQuienRetenidas, 'tuyo',
        '(A4/D1) y atribuida a su dueño en los datos');
      assert.ok(String(tarjeta.porque || '').includes('retenida(s) por ti'),
        '(A4/D1) el porqué la atribuye a su dueño, no al SAT');
      console.log('OK 2.9.13-servidor · (A4/D1) — Salud: la retenida por Paco no pinta «mal»; consta contada y atribuida.');
    }

    /* ===== (D4) Duplicados con veredicto ===== */
    {
      const antes = await h.call('GET', '/api/duplicados201');
      assert.equal(antes.status, 200);
      assert.equal(antes.json.total, 1, '(D4) un grupo sospechoso pendiente');
      const grupo = antes.json.sospechosos[0];
      assert.equal(grupo.tipo, 'mismo-importe-fecha');
      assert.ok(grupo.clave, '(D4) el grupo lleva su clave estable');
      assert.equal((antes.json.nominasAgrupadas || []).length, 1,
        '(D4) la nómina agrupada se cuenta como conocida aparte');
      assert.ok(!antes.json.sospechosos.some(s => s.comprobantes?.some(c => c.uuid === N1)),
        '(D4) la nómina conocida NO aparece como sospecha');
      const v = await h.call('POST', '/api/duplicados201/veredicto',
        { clave: grupo.clave, veredicto: 'distintos' });
      assert.equal(v.status, 200, '(D4) el veredicto se guarda');
      const despues = await h.call('GET', '/api/duplicados201');
      assert.equal(despues.json.total, 0, '(D4) con veredicto, el grupo deja de gritar como nuevo');
      assert.equal((despues.json.resueltos || []).length, 1,
        '(D4) y consta en resueltos, no desaparece');
      assert.equal(despues.json.resueltos[0].veredicto, 'distintos');
      const re = await h.call('POST', '/api/duplicados201/veredicto',
        { clave: grupo.clave, veredicto: 'reabrir' });
      assert.equal(re.status, 200);
      const otra = await h.call('GET', '/api/duplicados201');
      assert.equal(otra.json.total, 1, '(D4) reabrir (su Deshacer) devuelve el grupo a la lista');
      console.log('OK 2.9.13-servidor · (D4) — duplicados: veredicto por grupo, conocidos aparte, reabrir con Deshacer.');
    }

    /* ===== (E) Encabezado único en los PDF ===== */
    {
      const pdfText = async buffer => {
        const doc = await getDocument({ data: new Uint8Array(buffer) }).promise;
        let text = '';
        for (let i = 1; i <= doc.numPages; i++)
          text += (await (await doc.getPage(i)).getTextContent()).items.map(item => item.str).join(' ') + '\n';
        return text;
      };
      const pedirPdf = async payload => {
        const res = await h.call('POST', '/api/salidas/pdf', payload);
        assert.equal(res.status, 200, 'salidas/pdf ' + payload.kind + ' responde 200: ' + res.text.slice(0, 120));
        return pdfText(Buffer.from(res.json.content, 'base64'));
      };
      const contar = (texto, sub) => texto.split(sub).length - 1;
      const casos = [
        ['periodo', { kind: 'periodo', rfc: OWN, month: '2026-11' }],
        ['totales', { kind: 'totales', rfc: OWN, year: 2026 }],
        ['saldos', { kind: 'saldos', rfc: OWN }],
        ['declaraciones', { kind: 'declaraciones', rfc: OWN, year: 2026 }],
        ['avisos', { kind: 'avisos', rfc: OWN }]
      ];
      for (const [nombre, payload] of casos) {
        const texto = await pedirPdf(payload);
        assert.ok(!texto.includes('RFC: ' + OWN),
          '(E) ' + nombre + ': la línea vieja «RFC: ' + OWN + '» no repite el RFC en ningún sitio');
        assert.ok(texto.includes('MANO FIL SA · ' + OWN),
          '(E) ' + nombre + ': el contribuyente sale una vez, con su nombre y su RFC juntos');
        assert.equal(contar(texto, 'PacoSAT 3.1.0'), 1,
          '(E) ' + nombre + ': la marca con la versión sale una sola vez (la línea de generado)');
      }
      /* La conciliación viaja por su propia ruta (descarga
         directa): el mismo encabezado de plantilla. */
      {
        const res = await h.call('GET', '/api/reportes/conciliacion?rfc=' + OWN + '&mes=2026-11&formato=pdf');
        assert.equal(res.status, 200, '(E) conciliación responde 200');
        const texto = await pdfText(Buffer.from(res.text, 'latin1'));
        assert.ok(!texto.includes('RFC: ' + OWN),
          '(E) conciliación: sin la línea vieja «RFC: …»');
        assert.ok(texto.includes('MANO FIL SA · ' + OWN),
          '(E) conciliación: el contribuyente una vez, nombre y RFC juntos');
        assert.equal(contar(texto, 'PacoSAT 3.1.0'), 1,
          '(E) conciliación: la marca con la versión, una sola vez');
      }
      const cp = await pedirPdf({ kind: 'contraparte', rfc: OWN, contraparte: FISICA });
      /* Sin acentos inventados: el nombre fiscal no los trae
         («MONES TORRE JOSE BENITO») y el encabezado no se los
         pone — el orden natural es el orden, no la ortografía. */
      assert.ok(cp.includes('MANO FIL SA · ' + OWN + ' — frente a — Jose Benito Mones Torre · ' + FISICA),
        '(E) contraparte: las dos partes, una vez cada una, la física en orden natural');
      assert.ok(!cp.includes('RFC: ' + OWN) && !cp.includes('RFC: ' + FISICA),
        '(E) contraparte: ningún «RFC: …» suelto repite lo que la línea de partes ya dice');
      assert.equal(contar(cp, 'PacoSAT 3.1.0'), 1, '(E) contraparte: la marca, una vez');
      console.log('OK 2.9.13-servidor · (E) — los 7 PDF comparten el encabezado: partes una vez, sin «RFC:» repetido.');
    }
  } finally { h.service.close(); }

  /* ===== (B) Leer un comunicado ===== */
  {
    const satTribFetch = async (_profile, _query, options = {}) => {
      const base = { notifications: [], comunicadosNoLeidos: 1,
        comunicados: { concluyente: true, soloConteos: false, noLeidos: 1, leidos: 0,
          items: [{ fecha: '2026-08-28 12:20', asunto: 'Registro o actualización de medios de contacto',
            folio: 'FOLIO-2913-1', leido: false }] },
        documentos: { concluyente: true, items: [] } };
      if (options.abrirComunicado) {
        if (options.abrirComunicado.folio === 'FOLIO-2913-1')
          return { ...base, comunicadoAbierto: { folio: 'FOLIO-2913-1',
            asunto: 'Registro o actualización de medios de contacto', fecha: '2026-08-28 12:20',
            cuerpo: 'Cuerpo del comunicado de prueba: el SAT confirma el registro de medios de contacto.',
            abierto: true } };
        return { ...base, comunicadoAbierto: null };
      }
      return base;
    };
    const h2 = makeHarness(dbFile, { executorMode: 'nas', satTribFetch });
    try {
      const ok = await h2.call('POST', '/api/buzon/comunicado', { rfc: OWN, folio: 'FOLIO-2913-1' });
      assert.equal(ok.status, 200);
      assert.equal(ok.json.ok, true, '(B) Leer trae el comunicado pedido');
      assert.ok(String(ok.json.cuerpo || '').includes('el SAT confirma el registro'),
        '(B) con su cuerpo, para enseñarlo como documento');
      const no = await h2.call('POST', '/api/buzon/comunicado', { rfc: OWN, folio: 'NO-ESTA-2913' });
      assert.equal(no.json.ok, false, '(B) un folio fuera de la lista no se abre');
      assert.ok(String(no.json.error || '').includes('no apareció en la lista'),
        '(B) y la respuesta lo dice en llano, sin inventar contenido');
      console.log('OK 2.9.13-servidor · (B) — Leer: el comunicado pedido llega con su cuerpo; el ajeno, en llano.');
    } finally { h2.service.close(); }

    const h3 = makeHarness(dbFile, { executorMode: 'remote' });
    try {
      const r = await h3.call('POST', '/api/buzon/comunicado', { rfc: OWN, folio: 'FOLIO-2913-1' });
      assert.equal(r.json.ok, false, '(B) en sede de ejecutor remoto no se finge la lectura');
      assert.ok(String(r.json.error || '').includes('esta casa (el NAS)'),
        '(B) la respuesta nombra la frontera con honestidad');
      console.log('OK 2.9.13-servidor · (B-remoto) — con el ejecutor como asiento, Leer contesta su frontera en llano.');
    } finally { h3.service.close(); }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
