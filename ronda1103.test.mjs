import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { readFileSync } from 'node:fs';
import { createPacoSATService } from './local-server.mjs';

/* Contrato UI↔servidor de «Declaraciones y acuses» (1.10.3).
   La pantalla nació en la 1.9.0 leyendo claves que el servidor
   nunca emitió (la rejilla como months, la fecha de presentación
   como presentada, el resumen anual con operacion) y publicando
   la recuperación con el campo kind, que el servidor rechaza:
   con la respuesta real, la lista no se pintaba. Esta suite fija
   el contrato en los dos sentidos contra la FORMA REAL del
   servidor: (1) las respuestas vivas de GET /api/declaraciones y
   POST /api/declaraciones/run traen exactamente las claves que la
   pantalla consume, y (2) del fragmento declaraciones-ui.part se
   extraen los accesos a propiedades y se comprueba que todos
   existen en esas respuestas vivas — y que el cuerpo que publica
   la recuperación usa las claves que el servidor acepta. */
const origin = 'https://pacosat.example.com';
const proxyKey = 'c'.repeat(64);
const OWN = 'XAXX010101000';
let time = Date.parse('2026-11-12T15:00:00Z');
const DECL_PDF = Buffer.concat([Buffer.from('%PDF-1.4 declaracion de juguete\n'), Buffer.alloc(700, 0x2e)]);
const queries = [];
let portalFails = false;
const service = createPacoSATService({ dbFile: ':memory:', html: '<!--PACOSAT_TOKEN-->', origin, proxyKey, now: () => time,
  makeConnector: async () => ({ parser: class {}, connector: {
    request: async () => 'req-1103', check: async () => ({ status: 'pending', packages: [] }),
    download: async () => { throw new Error('sin paquetes'); } } }),
  makeMailer: () => ({ verify: async () => true, sendMail: async () => {} }),
  satDeclFetch: async ({ rfc }, query) => {
    assert.equal(rfc, OWN);
    queries.push(query);
    if (portalFails) throw new Error('portal de juguete caído');
    if (query.tipo === 'anual') return { found: 1, warnings: [], documents: [
      { clase: 'declaracion', ejercicio: query.ejercicio, periodo: String(query.ejercicio),
        fechaPresentacion: '2026-03-28', operacion: 'OP-ANUAL', content: DECL_PDF }] };
    if (query.tipo === 'transacciones') return { found: 1, warnings: [], documents: [], transactions: [
      { operacion: '123456789012', tipo: 'mensual', ejercicio: query.ejercicio, periodo: '2026-09',
        fechaPresentacion: '17/10/2026' }] };
    return { found: 2, warnings: ['aviso de juguete'], documents: [
      { clase: 'declaracion', ejercicio: query.ejercicio, periodo: '2026-09',
        fechaPresentacion: '2026-10-17', operacion: 'OP-100', content: DECL_PDF },
      { clase: 'acuse', ejercicio: query.ejercicio, periodo: '2026-09',
        fechaPresentacion: '2026-10-17', operacion: 'OP-100', content: DECL_PDF }] };
  } });
let token;
async function call(path, data) {
  const headers = { host: 'pacosat.example.com', origin, 'x-pacosat-proxy': proxyKey, 'x-pacosat-token': token };
  const req = Object.assign(Readable.from(data === undefined ? [] : [Buffer.from(JSON.stringify(data))]), {
    url: path, method: data === undefined ? 'GET' : 'POST', headers });
  let out;
  const res = { headers: {},
    setHeader(key, value) { this.headers[String(key).toLowerCase()] = value; },
    writeHead(status, hdrs) { this.status = status;
      if (hdrs) for (const [key, value] of Object.entries(hdrs)) this.headers[key.toLowerCase()] = value;
      this.headersSent = true; },
    end(content) { out = { status: this.status ?? 200, headers: this.headers,
      buffer: content === undefined ? Buffer.alloc(0) :
        Buffer.isBuffer(content) ? content : Buffer.from(String(content)) }; } };
  await service.handle(req, res);
  return { ...out, json: () => JSON.parse(out.buffer.toString('utf8')), text: () => out.buffer.toString('utf8') };
}
try {
  token = (await call('/')).text().split('content="')[1].split('"')[0];
  assert.equal((await call('/api/unlock', { rfc: OWN, minutes: 1440, days: 7, direction: 'received',
    password: 'simulated', certificate: 'YQ==', key: 'Yg==' })).status, 200);

  /* --- La recuperación con el cuerpo que el servidor espera --- */
  const run = await call('/api/declaraciones/run', { rfc: OWN, tipo: 'mensual', ejercicio: 2026 });
  assert.equal(run.status, 200);
  const runBody = run.json();
  assert.deepEqual(Object.keys(runBody).sort(), ['result', 'view'], 'la corrida responde {result, view}');
  assert.equal(runBody.result.ok, true);
  assert.equal(runBody.result.saved, 2);
  assert.deepEqual(runBody.result.warnings, ['aviso de juguete']);
  assert.equal(queries.length, 1);
  assert.equal(queries[0].tipo, 'mensual', 'el conector recibe tipo, no kind');

  /* --- La forma REAL del overview (la que la pantalla pinta) --- */
  const view = runBody.view;
  assert.deepEqual(Object.keys(view).sort(),
    ['anios', 'anual', 'configured', 'documentos', 'ejercicio', 'folios', 'lastError', 'mapa', 'mensuales', 'progreso', 'rfc'],
    'claves del overview (la 1.17.0 suma «mapa»: el mapa anual de la propuesta P13; la 1.22.0 suma «progreso»: la corrida viva de declaraciones, con su Cancelar; la 1.25.0 suma «folios» y «anios»: el registro de folios de la ficha 77792 y el resumen por años de la recuperación histórica)');
  assert.equal(view.rfc, OWN);
  assert.equal(view.ejercicio, 2026);
  assert.equal(view.lastError, null);
  assert.equal(view.mensuales.length, 12, 'la rejilla trae los 12 periodos');
  for (const [index, mes] of view.mensuales.entries()) {
    assert.deepEqual(Object.keys(mes).sort(), ['acuse', 'declaracion', 'estado', 'futuro', 'periodo'],
      'claves de cada mes de la rejilla');
    assert.equal(mes.periodo, '2026-' + String(index + 1).padStart(2, '0'));
  }
  const septiembre = view.mensuales.find(mes => mes.periodo === '2026-09');
  assert.equal(septiembre.estado, 'recuperada');
  assert.equal(septiembre.declaracion, true);
  assert.equal(septiembre.acuse, true);
  assert.equal(view.mensuales.find(mes => mes.periodo === '2026-08').estado, 'sin-recuperar');
  assert.equal(view.mensuales.find(mes => mes.periodo === '2026-12').estado, 'aun-no-toca');
  assert.deepEqual(Object.keys(view.anual).sort(), ['acuse', 'declaracion', 'estado'],
    'la anual es {declaracion, acuse, estado}: sin operacion en el resumen');
  assert.equal(view.anual.estado, 'sin-recuperar');
  assert.equal(view.documentos.length, 2);
  for (const doc of view.documentos) {
    assert.deepEqual(Object.keys(doc).sort(),
      ['clase', 'created', 'ejercicio', 'fechaPresentacion', 'fileId', 'id', 'label', 'operacion', 'periodo', 'tipo'],
      'claves de cada documento');
    assert.equal(doc.fechaPresentacion, '2026-10-17', 'la fecha vive en fechaPresentacion');
    assert.equal(doc.operacion, 'OP-100');
    assert.ok(doc.fileId.startsWith('pdf:'), 'cada documento trae su fileId para el «Ver»');
  }
  assert.deepEqual(view.documentos.map(doc => doc.label).sort(),
    ['Acuse de declaración mensual', 'Declaración mensual'], 'la etiqueta sale de label');

  /* --- El «Ver» de la fila abre el PDF por la ruta inline --- */
  const docDecl = view.documentos.find(doc => doc.clase === 'declaracion');
  const seen = await call('/api/files/view?id=' + encodeURIComponent(docDecl.fileId));
  assert.equal(seen.status, 200);
  assert.match(seen.headers['content-disposition'] || '', /^inline;/);
  assert.ok(seen.buffer.equals(DECL_PDF), 'el PDF de la declaración, byte a byte');

  /* --- La anual con su operación en los documentos --- */
  const runAnual = await call('/api/declaraciones/run', { rfc: OWN, tipo: 'anual', ejercicio: 2025 });
  assert.equal(runAnual.status, 200);
  const viewAnual = runAnual.json().view;
  assert.equal(viewAnual.anual.estado, 'recuperada');
  const docAnual = viewAnual.documentos.find(doc => doc.tipo === 'anual');
  assert.equal(docAnual.label, 'Declaración anual');
  assert.equal(docAnual.ejercicio, 2025);
  assert.equal(docAnual.fechaPresentacion, '2026-03-28');
  assert.equal(docAnual.operacion, 'OP-ANUAL', 'la operación de la anual vive en su documento');

  /* --- El GET pinta con la misma forma que el POST --- */
  const get = await call('/api/declaraciones?rfc=' + OWN + '&ejercicio=2026');
  assert.equal(get.status, 200);
  assert.deepEqual(Object.keys(get.json()).sort(), Object.keys(view).sort(),
    'GET y POST devuelven el mismo overview');

  /* --- El cuerpo viejo (kind) lo rechaza el servidor --- */
  const antes = queries.length;
  const viejo = await call('/api/declaraciones/run', { rfc: OWN, ejercicio: 2026, kind: 'mensual' });
  assert.equal(viejo.status, 400, 'sin tipo no hay recuperación: ' + viejo.text());
  const plural = await call('/api/declaraciones/run', { rfc: OWN, ejercicio: 2026, tipo: 'mensuales' });
  assert.equal(plural.status, 400, '«mensuales» tampoco es un tipo del servidor');
  assert.equal(queries.length, antes, 'el conector no se invocó con cuerpos inválidos');

  /* --- El error del último intento viaja como objeto --- */
  portalFails = true;
  const failed = await call('/api/declaraciones/run', { rfc: OWN, tipo: 'mensual', ejercicio: 2026 });
  assert.equal(failed.status, 200);
  assert.equal(failed.json().result.ok, false);
  assert.match(failed.json().result.error, /portal de juguete caído/);
  const afterFail = (await call('/api/declaraciones?rfc=' + OWN + '&ejercicio=2026')).json();
  assert.equal(typeof afterFail.lastError, 'object');
  assert.match(afterFail.lastError.error, /portal de juguete caído/,
    'la pantalla lee lastError.error: es un objeto, no un texto');
  assert.equal(typeof afterFail.lastError.at, 'number');
  portalFails = false;

  /* --- El descubrimiento de folios (1.27.0): también contrato --- */
  const descubrimiento = await call('/api/declaraciones/descubrir-folios', { rfc: OWN, ejercicio: 2026 });
  assert.equal(descubrimiento.status, 200);
  assert.equal(descubrimiento.json().result.ok, true);
  assert.equal(descubrimiento.json().result.descubiertos, 1,
    'el descubrimiento aprende el folio que la tabla de transacciones enseñó');

  /* --- El fragmento consume SOLO claves que el servidor emite --- */
  const part = readFileSync(new URL('./declaraciones-ui.part', import.meta.url), 'utf8');
  const emitted = { view: new Set(Object.keys(view)),
    /* Desde la 1.17.0, «mes» en el fragmento es un mes del MAPA
       (view.mapa.meses): la rejilla vieja ya no se itera en la
       pantalla, y sus claves son las que el mapa emite. */
    mes: new Set(Object.keys(view.mapa.meses[0])),
    doc: new Set(Object.keys(view.documentos[0])),
    /* «data» es la respuesta del endpoint que el fragmento esté
       llamando: desde la 1.25.0 la pantalla habla con TRES —
       declaraciones/run ({result, view}), declaraciones/
       folio-run ({result, folio, view}) y declaraciones/
       recover-year ({mensual, anual, view}) — y el contrato es
       la unión de sus claves: cada data.X que la pantalla lee
       lo emite alguno de los tres. */
    data: new Set(['result', 'view', 'folio', 'mensual', 'anual']),
    /* El resultado también es unión (1.27.0): la pantalla lee
       result.descubiertos del descubrimiento (ficha 22513), que
       emite descubrir-folios, no la corrida de recuperación. */
    result: new Set([...Object.keys(runBody.result), ...Object.keys(failed.json().result),
      ...Object.keys(descubrimiento.json().result)]) };
  const accesses = new Map();
  for (const match of part.matchAll(/\b(view|mes|doc|data|result)\.([A-Za-z]+)/g)) {
    if (!accesses.has(match[1])) accesses.set(match[1], new Set());
    accesses.get(match[1]).add(match[2]);
  }
  for (const receiver of Object.keys(emitted))
    assert.ok(accesses.get(receiver)?.size, 'el fragmento usa el receptor ' + receiver);
  for (const [receiver, keys] of accesses)
    for (const key of keys)
      assert.ok(emitted[receiver].has(key),
        'la pantalla lee ' + receiver + '.' + key + ' y el servidor SÍ lo emite');
  /* Las claves muertas no vuelven: ni como acceso ni como cuerpo. */
  assert.ok(!/view\.months\b/.test(part), 'nada de view.months');
  assert.ok(!/\.presentada\b/.test(part), 'nada de doc.presentada');
  assert.ok(!/data\.overview\b/.test(part), 'nada de data.overview');
  const bodyLiteral = part.match(/satApi\('declaraciones\/run',\s*\{([^}]*)\}/);
  assert.ok(bodyLiteral, 'la llamada a declaraciones/run está en el fragmento');
  const bodyKeys = bodyLiteral[1].split(',').map(piece => piece.match(/^\s*([A-Za-z]+)\s*:/)?.[1]).filter(Boolean);
  assert.deepEqual(bodyKeys.sort(), ['ejercicio', 'periodo', 'rfc', 'tipo'],
    'el cuerpo publicado es {rfc, ejercicio, tipo, periodo} (la 1.17.0 suma el periodo: el gesto del detalle del mapa acota la recuperación a un mes; el servidor lo acepta desde el motor de la 1.9.0)');

  console.log('ronda1103: contrato de Declaraciones alineado — el overview real pinta la lista, el «Ver» abre el PDF inline y la recuperación publica {tipo}.');
} catch (error) {
  console.error(error);
  process.exit(1);
}
