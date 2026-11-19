import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DOMParser } from '@xmldom/xmldom';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createPacoSATService } from './local-server.mjs';

/* ================================================================
   Ronda 2.9.14 · SERVIDOR — el «ya se pidió» por COBERTURA y el
   encabezado con la forma real del nombre.

   LA FORMA REAL MANDA (la lección de la verificación en vivo
   de la 2.9.13): la ventana de Paco 01/11/2026–16/11/2026 en
   «recibidos» NO la cubre ningún criterio solo del libro —
   la cubre un MOSAICO de trabajos, cada uno con su cierre
   real:
     · A: terminado, 01→05 nov, cierre a fin de día
       (endAt «2026-11-05 23:59:59»).
     · B: terminado, 06→10 nov, cierre A LA HORA VIVA del día
       en que se cerró (endAt «2026-11-10 17:26:41»): el
       periodo cubre el día 10 entero aunque su hora no sea
       la de fin de día.
     · C: VIVO y RETENIDO por Paco (pending, held=1),
       11→14 nov, con su endAt desbordado a la medianoche del
       día siguiente («2026-11-15 00:00:00»).
     · D: terminado, 15→16 nov, con su startAt corrido UN
       SEGUNDO («2026-11-15 00:00:01»): la costura cosida por
       la variante de la 2.9.9/2.9.13.
   Y NINGÚN criterio del libro iguala la ventana pedida (no se
   siembra ninguno de 01→16): el chequeo viejo — igualdad de
   criterio exacto o por días (F8 de la 2.9.3) — contestaba
   «criterio nuevo» y la tarjeta envió dos solicitudes que el
   SAT devolvió como duplicadas («Criterio ya usado», el cupo
   subió 60→62). Esta suite siembra ESA forma y exige:
     (1) plan(01→16).cobertura.completa === true, con UN solo
         tramo cubierto 01→16 y sin restos — y yaPedida null,
         que documenta la ceguera del chequeo viejo —;
     (2) «emitidos», sin trabajos: cobertura vacía y el resto
         es la ventana entera;
     (3) a medias por la izquierda: plan(28 oct→16 nov) cubre
         01→16 y el resto es SOLO 28→31 oct;
     (4) a medias por la derecha: plan(03→18 nov) cubre
         03→16 y el resto es SOLO 17→18 nov.
   (5) El encabezado de contraparte con la forma REAL del
       nombre guardado — «Mones Torre, Jose Benito», con coma
       y caja mixta, como salió en el PDF en vivo — enseña el
       orden natural «Jose Benito Mones Torre». (La suite de
       la 2.9.13 sembró la forma limpia en mayúsculas sin
       coma; la forma con coma pasaba intacta, en orden
       fiscal, y el informe afirmó lo contrario del hecho.)

   Contra la 2.9.13 esta suite corre en ROJO: el plan no traía
   cobertura alguna y el encabezado enseñaba «Mones Torre,
   Jose Benito» tal cual.
   ================================================================ */

const ORIGIN = 'https://pacosat.test';
const KEY = 'c'.repeat(64);
const OWN = 'MFI6212158B4';
const FISICA = 'MOTB710506V15';
const T0 = Date.parse('2026-11-18T15:00:00Z');
const F1 = '77777777-7777-4777-8777-777777777777';

function makeHarness(dbFile, options = {}) {
  const clock = { t: T0 };
  const service = createPacoSATService({
    dbFile, html: '<html><head><!--PACOSAT_TOKEN--></head><body>prueba</body></html>',
    origin: ORIGIN, proxyKey: KEY, now: () => clock.t,
    makeConnector: () => ({ parser: DOMParser, connector: {
      request: async () => 'req-2914', check: async () => ({ status: 'pending', packages: [] }),
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

const dir = mkdtempSync(join(tmpdir(), 'pacosat-2914-'));
const dbFile = join(dir, 'pacosat.sqlite');
try {
  /* ===== Semilla: el mosaico real de «recibidos» ===== */
  {
    const boot = createPacoSATService({ dbFile, html: 'x', origin: ORIGIN, proxyKey: KEY });
    boot.close();
    const seed = new DatabaseSync(dbFile);
    seed.prepare("INSERT INTO profiles(rfc,minutes,days,direction,nextRun,error) VALUES (?,1440,7,'both',0,'')").run(OWN);
    const persona = seed.prepare("INSERT INTO records(store,id,value) VALUES ('people',?,?)");
    persona.run(OWN, JSON.stringify({ id: OWN, name: 'MANO FIL SA' }));
    persona.run(FISICA, JSON.stringify({ id: FISICA, name: 'MONES TORRE JOSE BENITO' }));
    const rec = seed.prepare("INSERT INTO records(store,id,value) VALUES ('invoices',?,?)");
    /* La factura de la contraparte física con su nombre TAL
       CUAL quedó guardado en vivo: apellidos, coma, nombres,
       en caja mixta. */
    { const f1 = invoice(F1, '2026-11-03', FISICA, OWN, '2320.00', '700');
      f1.from.name = 'Mones Torre, Jose Benito';
      rec.run(F1, JSON.stringify(f1)); }
    const job = seed.prepare("INSERT INTO jobs(rfc,direction,periodStart,periodEnd,startAt,endAt,requestId,status,imported,due,created,error,checks,held) VALUES (?,?,?,? ,?,?,?,?, '[]',0,?,'',0,?)");
    /* A: terminado, cierre a fin de día. */
    job.run(OWN, 'received', '2026-11-01', '2026-11-05', '2026-11-01 00:00:00', '2026-11-05 23:59:59', 'req-a', 'finished', T0 - 900000, 0);
    /* B: terminado, cierre a la hora viva de su día de cierre. */
    job.run(OWN, 'received', '2026-11-06', '2026-11-10', '2026-11-06 00:00:00', '2026-11-10 17:26:41', 'req-b', 'finished', T0 - 800000, 0);
    /* C: vivo y RETENIDO por su dueño, endAt desbordado. */
    job.run(OWN, 'received', '2026-11-11', '2026-11-14', '2026-11-11 00:00:00', '2026-11-15 00:00:00', 'req-c', 'pending', T0 - 700000, 1);
    /* D: terminado, apertura corrida un segundo (la costura). */
    job.run(OWN, 'received', '2026-11-15', '2026-11-16', '2026-11-15 00:00:01', '2026-11-16 23:59:59', 'req-d', 'finished', T0 - 600000, 0);
    seed.close();
  }

  const h = makeHarness(dbFile, { executorMode: 'nas' });
  try {
    await unlock(h);
    const plan = (direction, start, end) => h.call('POST', '/api/plan',
      { rfc: OWN, direction, type: 'cfdi', start, end });

    /* ===== (1) La ventana de Paco, cubierta por el mosaico ===== */
    {
      const p = await plan('received', '2026-11-01', '2026-11-16');
      assert.equal(p.status, 200, 'plan de la ventana real responde');
      assert.ok(p.json.cobertura, '(1) el plan trae su veredicto por cobertura');
      assert.equal(p.json.cobertura.completa, true,
        '(1) la unión de terminados + la retenida cubre 01→16 entera');
      assert.deepEqual(p.json.cobertura.cubierto, [{ start: '2026-11-01', end: '2026-11-16' }],
        '(1) UN solo tramo cubierto: el mosaico se une sin costuras (la de 1 s incluida)');
      assert.deepEqual(p.json.cobertura.restos, [], '(1) no queda resto: no se envía nada');
      assert.equal(p.json.yaPedida, null,
        '(1) y el chequeo viejo NO la veía: ningún criterio solo iguala la ventana — esa es la causa raíz');
      console.log('OK 2.9.14-servidor · (1) — cobertura: el mosaico real (adyacentes, hora viva, retenida, costura de 1 s) cubre la ventana entera.');
    }

    /* ===== (2) Sin trabajos en el sentido: resto entero ===== */
    {
      const p = await plan('issued', '2026-11-01', '2026-11-16');
      assert.equal(p.status, 200, 'plan de emitidos responde');
      assert.equal(p.json.cobertura.completa, false, '(2) emitidos no está cubierta');
      assert.deepEqual(p.json.cobertura.cubierto, [], '(2) nada cubierto en emitidos');
      assert.deepEqual(p.json.cobertura.restos, [{ start: '2026-11-01', end: '2026-11-16' }],
        '(2) el resto es la ventana entera: se pide como siempre');
      console.log('OK 2.9.14-servidor · (2) — sin cobertura, el resto es la ventana entera (paridad).');
    }

    /* ===== (3) A medias por la izquierda ===== */
    {
      const p = await plan('received', '2026-10-28', '2026-11-16');
      assert.equal(p.json.cobertura.completa, false, '(3) la ventana ancha no está cubierta entera');
      assert.deepEqual(p.json.cobertura.cubierto, [{ start: '2026-11-01', end: '2026-11-16' }],
        '(3) cubierto: el tramo del mosaico, recortado a la ventana');
      assert.deepEqual(p.json.cobertura.restos, [{ start: '2026-10-28', end: '2026-10-31' }],
        '(3) el resto es SOLO lo que falta por la izquierda: 28→31 oct');
      console.log('OK 2.9.14-servidor · (3) — a medias por la izquierda: solo se pide el resto.');
    }

    /* ===== (4) A medias por la derecha ===== */
    {
      const p = await plan('received', '2026-11-03', '2026-11-18');
      assert.equal(p.json.cobertura.completa, false, '(4) la ventana que sobresale no está cubierta entera');
      assert.deepEqual(p.json.cobertura.cubierto, [{ start: '2026-11-03', end: '2026-11-16' }],
        '(4) cubierto: desde el día pedido hasta el fin del mosaico');
      assert.deepEqual(p.json.cobertura.restos, [{ start: '2026-11-17', end: '2026-11-18' }],
        '(4) el resto es SOLO 17→18 nov');
      console.log('OK 2.9.14-servidor · (4) — a medias por la derecha: solo se pide el resto.');
    }

    /* ===== (5) El encabezado con la forma real del nombre ===== */
    {
      const pdfText = async buffer => {
        const doc = await getDocument({ data: new Uint8Array(buffer) }).promise;
        let text = '';
        for (let i = 1; i <= doc.numPages; i++)
          text += (await (await doc.getPage(i)).getTextContent()).items.map(item => item.str).join(' ') + '\n';
        return text;
      };
      const res = await h.call('POST', '/api/salidas/pdf', { kind: 'contraparte', rfc: OWN, contraparte: FISICA });
      assert.equal(res.status, 200, '(5) contraparte responde 200');
      const cp = await pdfText(Buffer.from(res.json.content, 'base64'));
      assert.ok(cp.includes('MANO FIL SA · ' + OWN + ' — frente a — Jose Benito Mones Torre · ' + FISICA),
        '(5) la física sale en orden natural también con su forma guardada con coma');
      assert.ok(!cp.includes('Mones Torre, Jose Benito'),
        '(5) la forma fiscal con coma ya no sale tal cual en el encabezado');
      console.log('OK 2.9.14-servidor · (5) — encabezado: «Mones Torre, Jose Benito» se presenta «Jose Benito Mones Torre».');
    }
  } finally { h.service.close(); }
} finally { rmSync(dir, { recursive: true, force: true }); }
