import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { generateKeyPairSync, webcrypto } from 'node:crypto';
import * as vm from 'node:vm';
import { DOMParser } from '@xmldom/xmldom';
import { createPacoSATService } from './local-server.mjs';

/* ================================================================
   Ronda 2.9.7 — Paquete de perfección parcial (D1, D3, D4, D5)

   D1 · MOTIVOS DE LA OPINIÓN CON EL VOCABULARIO COMPARTIDO:
   opinionMotivos200e buscaba /NEGATIVA/i sobre el contenido
   decodificado EN CRUDO; sobre el PDF real del SAT (texto en
   FlateDecode) la palabra no consta en crudo y los motivos
   nunca se encontraban (rezago nombrado en el informe de la
   2.9.6, §Frontera). Arreglo: los motivos se leen del TEXTO
   EXTRAÍDO (extractText, el lector de la casa) aceptando las
   cuatro formas (NEGATIVO/NEGATIVA), con el crudo de reserva
   para contenidos sin capa de texto — la misma receta que la
   2.9.6 aplicó al sentido. Los dos llamadores viven en
   archiveSatDoc (async): solo cambió el await.
   DECLARACIÓN DE FIXTURE: la casa no guarda ninguna Opinión
   NEGATIVA real — la fixture viva es la POSITIVA de la 2.9.6 —
   así que la variante NEGADA se construye sobre ese texto
   real-enmascarado («Sentido … NEGATIVO») y la enumeración de
   motivos se añade con la forma que el propio código busca
   desde la 2.0 (ítems «1. … 2. …» tras el ancla del sentido,
   con su contexto «Motivos:»), declarada aquí, no fingida
   como forma real del SAT. Los motivos sembrados llevan
   acentos; el PDF de juguete (Helvetica Type1 en latin1) los
   degrada al extraer — como ya sabía la 2.9.6 — así que las
   aserciones van sobre los tramos sin acento de cada motivo.

   D3 · «VER LOS RESPaldos» LENTO: la cadena real del cliente
   es Ajustes › Respaldos (ui.part: backupScreen con satData,
   que sale de /api/status) + la parte diferida «salidas»
   (/parte/salidas) + el botón «Ver los respaldos» de
   restaurar200gPanel (outputs-ui.part), que llama SOLO a
   GET /api/respaldos200g. Medido en este arnés antes del
   arreglo (semilla de 1.600 CFDI y 300 movimientos sin
   conciliar): respaldos200g 0,1 ms (readdir+stat, sin
   descifrar nada), /parte/salidas ~0 ms (se sirve de memoria),
   /api/salud 1,3 ms — y /api/status 551 ms, de los que 541 ms
   eran la conciliación COMPLETA (conciliacion200f) que el
   estado corría en cada pulso SOLO para sumar dos conteos por
   cuenta en bancosSinConciliar240 (propuestas N-a-1 con
   búsqueda de subconjuntos por movimiento, descartadas al
   sumar). En el servidor de un solo hilo, ese pulso bloquea
   también la respuesta de respaldos cuando coinciden.
   Arreglo acotado a esa ruta: bancosSinConciliarConteos297
   calcula los mismos conteos con las mismas definiciones sin
   correr la conciliación; Bancos sigue saliendo de
   conciliacion200f intacta. La suite coteja el mapa del
   estado contra el de la conciliación completa sobre la
   misma semilla y mide ambos tiempos tras el arreglo.
   (Descartados con medición: backup/verify descifra — 154 ms
   con 2.000 CFDI — y backup/restore-test — 270 ms —, pero
   son botones propios y «Ver los respaldos» no los llama.)

   D4 · BARRIDO DE confirm() NATIVOS (receta R1 de la 2.9.5):
   los 10 sitios con la confirmación nativa del navegador
   (registro 1, salud 2, listas 1, salidas 5, tributario 1)
   pasan al diálogo propio de la casa — dialog(título,
   [n('p', texto)], trabajo, etiqueta) — conservando texto y
   consecuencia: confirmar ejecuta lo mismo; no confirmar,
   nada. Aserción estática: ningún confirm( nativo queda en
   los .part (fuera de comentarios) ni en el artefacto
   construido (Faro-Fiscal.html y partes diferidas), y dos
   comportamientos contra el servidor real con la
   confirmación nativa tragada (devuelve false, la forma de
   en vivo): Restaurar un respaldo y Revocar el acceso de un
   ejecutor — abrir el diálogo no ejecuta; confirmar, sí.

   D5 · LA CADENA DE LA BATERÍA: el tramo final de
   package.json pasa de «node ronda1320… ronda1321…
   ronda1322…» (node solo ejecuta el primer fichero; los
   demás son argumentos) a «node --test …» con los tres.
   Comprobado fuera de la suite corriendo la cadena: con la
   forma vieja solo salen las 10 líneas OK de la 1320; con
   --test corren los tres ficheros (tests 3, pass 3) y salen
   10 + 5 + 7 líneas OK. Aquí queda la aserción estática.
   ================================================================ */

const AQUI = dirname(fileURLToPath(import.meta.url));
const ORIGIN = 'https://pacosat.test';
const KEY = 'b'.repeat(64);
const OWN = 'AAA010101AAA';
const OTRO = 'BBB010101BB2';
const TEXTO_REAL = readFileSync(join(AQUI, 'fixtures', 'opinion-texto-real-enmascarado.txt'), 'utf8')
  .replace(/\s+/g, ' ').trim();
const MOTIVO_1 = 'No presentó la declaración anual del ejercicio 2025 dentro del plazo legal establecido';
const MOTIVO_2 = 'Tiene un crédito fiscal firme pendiente de pago por concepto de multas federales';
const TEXTO_NEG = TEXTO_REAL.replace('POSITIVO', 'NEGATIVO') +
  ' Motivos de la opinión: 1. ' + MOTIVO_1 + ' 2. ' + MOTIVO_2;
const TEXTO_NEG_SIN = TEXTO_REAL.replace('POSITIVO', 'NEGATIVO');

/* ================================================================
   Arnés de servicio (el de la casa, con reloj mutable y correo)
   ================================================================ */
function makeHarness(options = {}) {
  const clock = { t: options.start ?? Date.parse('2026-11-18T15:00:00Z') };
  const mails = [];
  const service = createPacoSATService({
    dbFile: options.dbFile || ':memory:',
    html: options.html || '<html><head><!--PACOSAT_TOKEN--></head><body>prueba</body></html>',
    origin: ORIGIN, proxyKey: KEY, satDocRetryWaitMs: 5,
    makeConnector: () => ({ parser: DOMParser, connector: {
      request: async () => 'req-297', check: async () => ({ status: 'pending', packages: [] }),
      download: async () => { throw new Error('sin paquetes'); } } }),
    makeMailer: () => ({ verify: async () => true,
      sendMail: async payload => { mails.push(payload); return { messageId: 'm' + mails.length }; } }),
    now: () => clock.t, ...options.serviceOptions });
  let token = '';
  const raw = async (method, path, bodyText, extraHeaders = {}) => {
    const chunks = []; if (bodyText !== undefined && bodyText !== null && bodyText !== '')
      chunks.push(Buffer.from(String(bodyText)));
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
    const r = await raw(method, path, body === undefined ? undefined : JSON.stringify(body),
      { 'x-pacosat-token': token, ...extraHeaders });
    let json = null; try { json = JSON.parse(r.text); } catch { /* binario */ }
    return { status: r.status, json, text: r.text };
  };
  return { service, call, raw, clock, mails };
}
const unlock = async (h, rfc = OWN) => {
  const open = await h.call('POST', '/api/unlock', { rfc, minutes: 1440, days: 7,
    direction: 'both', password: 'simulated', certificate: 'YQ==', key: 'Yg==' });
  assert.equal(open.status, 200, 'unlock de ' + rfc);
};
const seedPeople = async h => {
  const seed = await h.call('POST', '/api/storage', { batch: {
    people: [{ id: OWN, name: 'Empresa de Prueba, S.A.' }, { id: OTRO, name: 'Otra de Prueba, S.A.' }] } });
  assert.equal(seed.status, 200, 'semilla de personas');
};
const setupMail = async h => {
  const mail = await h.call('POST', '/api/mail', { host: 'smtp.test', port: 465, security: 'ssl',
    from: 'avisos@pacosat.test', recipient: 'paco@test.mx', user: 'u', password: 'p' });
  assert.equal(mail.status, 200, 'correo de juguete configurado');
};

/* Un PDF de verdad con el texto COMPRIMIDO (FlateDecode),
   como el del SAT — el constructor de la 2.9.6. */
function pdfConTexto297(texto) {
  const palabras = String(texto).replace(/\s+/g, ' ').trim().split(' ');
  const lineas = [];
  let linea = '';
  for (const p of palabras) {
    if ((linea + ' ' + p).trim().length > 78) { lineas.push(linea.trim()); linea = p; }
    else linea = (linea + ' ' + p).trim();
  }
  if (linea.trim()) lineas.push(linea.trim());
  const esc = s => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const plano = ['BT /F1 10 Tf 40 780 Td',
    ...lineas.map((l, i) => (i ? '0 -13 Td ' : '') + '(' + esc(l) + ') Tj'), 'ET'].join('\n');
  const stream = deflateSync(Buffer.from(plano, 'latin1'));
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    Buffer.concat([Buffer.from('<< /Length ' + stream.length + ' /Filter /FlateDecode >>\nstream\n', 'latin1'),
      stream, Buffer.from('\nendstream', 'latin1')]),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const partes = [Buffer.from('%PDF-1.4\n', 'latin1')];
  const offsets = [];
  objs.forEach((cuerpo, i) => {
    offsets.push(partes.reduce((s, p) => s + p.length, 0));
    partes.push(Buffer.from((i + 1) + ' 0 obj\n', 'latin1'),
      Buffer.isBuffer(cuerpo) ? cuerpo : Buffer.from(cuerpo, 'latin1'),
      Buffer.from('\nendobj\n', 'latin1'));
  });
  const xref = partes.reduce((s, p) => s + p.length, 0);
  partes.push(Buffer.from('xref\n0 ' + (objs.length + 1) + '\n0000000000 65535 f \n' +
    offsets.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('') +
    'trailer\n<< /Size ' + (objs.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF', 'latin1'));
  return Buffer.concat(partes);
}

/* ================================================================
   D5 · Estática: la cadena de la batería corre los tres ficheros
   ================================================================ */
{
  const pkg = JSON.parse(readFileSync(join(AQUI, 'package.json'), 'utf8'));
  assert.ok(pkg.scripts.test.includes('node --test ronda1320.test.mjs ronda1321.test.mjs ronda1322.test.mjs'),
    'D5: el tramo final de npm test usa node --test con los tres ficheros');
  assert.ok(!/(?<!-)node ronda1320\.test\.mjs ronda1321/.test(pkg.scripts.test),
    'D5: ya no queda la forma «node <f1> <f2> <f3>», que solo ejecutaba el primero');
  console.log('OK 2.9.7 · D5 — package.json: el tramo 1320–1322 corre con node --test (los tres ficheros).');
}

/* ================================================================
   D4 · Estática: ningún confirm( nativo en los .part (fuera de
   comentarios) ni en el artefacto construido; cada sitio
   conserva su texto y usa el diálogo propio.
   ================================================================ */
{
  const sinComentarios = src => src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  const partes = readdirSync(AQUI).filter(n => n.endsWith('.part'));
  assert.ok(partes.length > 10, 'D4: el barrido cubre los .part de la casa (' + partes.length + ')');
  for (const nombre of partes) {
    const limpio = sinComentarios(readFileSync(join(AQUI, nombre), 'utf8'));
    assert.ok(!/(?<![\w$.])confirm\s*\(/.test(limpio),
      'D4: sin confirmación nativa en ' + nombre);
  }
  const html = readFileSync(join(AQUI, 'Faro-Fiscal.html'), 'utf8');
  assert.ok(!/(?<![\w$.])confirm\s*\(/.test(html),
    'D4: sin confirmación nativa en el Faro-Fiscal.html construido');
  const lazy = JSON.parse(readFileSync(join(AQUI, 'lazy.json'), 'utf8'));
  for (const [nombre, parte] of Object.entries(lazy.partes))
    assert.ok(!/(?<![\w$.])confirm\s*\(/.test(parte.source),
      'D4: sin confirmación nativa en la parte diferida construida «' + nombre + '»');
  const sitios = [
    ['registro-ui.part', "dialog('Ocultar entradas del Registro'", '¿Ocultar las '],
    ['salud-ui.part', "dialog('Regenerar el código de emparejado'", 'Se creará un código de emparejado nuevo'],
    ['salud-ui.part', "dialog('Descartar el trabajo'", 'saldrá de la cola y no se hará'],
    ['lists-ui.part', "dialog('Quitar del padrón manual'", '¿Quitar a '],
    ['outputs-ui.part', "dialog('Desbloquear el ejercicio '", 'Sus datos se podrán tocar otra vez'],
    ['outputs-ui.part', "dialog('Cerrar el ejercicio '", 'El servidor bloqueará notas'],
    ['outputs-ui.part', "dialog('Regenerar la dirección del calendario'", '¿Regenerar la dirección del calendario de '],
    ['outputs-ui.part', "dialog('Restaurar este respaldo'", 'Se va a reemplazar el expediente actual por el respaldo del '],
    ['outputs-ui.part', "dialog('Volver al respaldo de seguridad'", '¿Volver al estado que había justo antes de la última restauración guiada?'],
    ['tributario-ui.part', "dialog('Revocar el acceso'", '¿Revocar el acceso de «'],
  ];
  for (const [fichero, dialogo, texto] of sitios) {
    const src = readFileSync(join(AQUI, fichero), 'utf8');
    assert.ok(src.includes(dialogo), 'D4: ' + fichero + ' confirma con el diálogo propio (' + dialogo + '…)');
    assert.ok(src.includes(texto), 'D4: ' + fichero + ' conserva su texto («' + texto + '…»)');
  }
  console.log('OK 2.9.7 · D4-estática — Cero confirmaciones nativas en .part y artefacto; los 10 sitios usan dialog() con su texto.');
}

/* ================================================================
   D1-A · LA OPINIÓN NEGADA REAL-ENMASCARADA: el portal entrega
   el PDF con «Sentido … NEGATIVO» y su enumeración de motivos,
   comprimido en FlateDecode (en crudo no consta NEGATIVO: la
   vía vieja no podía encontrar nada — rojo contra la 2.9.6).
   El aviso del mismo día enumera LOS MOTIVOS del documento,
   leídos de su texto extraído.
   ================================================================ */
{
  const pdf = pdfConTexto297(TEXTO_NEG);
  assert.ok(!pdf.toString('latin1').includes('NEGATIVO'),
    'D1: en crudo el PDF no enseña su sentido (comprimido, como el del SAT)');
  const h = makeHarness({ serviceOptions: {
    satDocFetch: async (profile, kind) => kind === 'opinion'
      ? { content: pdf, issuedAt: '2026-11-16', fileName: 'Opinion ' + profile.rfc + '.pdf' }
      : { content: pdf, issuedAt: '2026-11-16', fileName: 'Constancia ' + profile.rfc + '.pdf' } } });
  try {
    await setupMail(h); await seedPeople(h); await unlock(h);
    const run = await h.call('POST', '/api/satdocs/run', { rfc: OWN, kind: 'opinion' });
    assert.equal(run.json.results?.opinion?.ok, true, 'D1-A: la bajada archiva la Opinión');
    h.clock.t += 60000; await h.service.tick();
    const alerta = h.mails.find(m => String(m.subject || '').includes('salió NEGATIVA'));
    assert.ok(alerta, 'D1-A: el aviso de NEGATIVA salió el mismo día');
    assert.ok(alerta.text.includes('anual del ejercicio 2025 dentro del plazo legal establecido'),
      'D1-A: el motivo 1 del documento viaja en el aviso (leído del texto extraído, no del crudo)');
    assert.ok(alerta.text.includes('fiscal firme pendiente de pago por concepto de multas federales'),
      'D1-A: y el motivo 2 también');
    const docs = (await h.call('GET', '/api/satdocs')).json;
    assert.equal(docs.profiles[0].opinion.sentido, 'negativa',
      'D1-A: la tarjeta enseña el sentido «negativa» (la forma masculina, leída con el vocabulario compartido)');
    console.log('OK 2.9.7 · D1-A — Opinión NEGADA (PDF real-enmascarado, FlateDecode): el aviso enumera los motivos del texto extraído.');
  } finally { h.service.close(); }
}

/* ================================================================
   D1-B · NEGADA SIN ENUMERACIÓN LEGIBLE EN EL TEXTO EXTRAÍDO:
   el aviso usa la frase de reserva y no inventa motivos — el
   texto extraído manda aunque el crudo pudiera sugerir otra
   cosa: aquí ni crudo ni extraído traen enumeración.
   ================================================================ */
{
  const pdf = pdfConTexto297(TEXTO_NEG_SIN);
  const h = makeHarness({ serviceOptions: {
    satDocFetch: async (profile, kind) => kind === 'opinion'
      ? { content: pdf, issuedAt: '2026-11-16', fileName: 'Opinion ' + profile.rfc + '.pdf' }
      : { content: pdf, issuedAt: '2026-11-16', fileName: 'Constancia ' + profile.rfc + '.pdf' } } });
  try {
    await setupMail(h); await seedPeople(h); await unlock(h);
    const run = await h.call('POST', '/api/satdocs/run', { rfc: OWN, kind: 'opinion' });
    assert.equal(run.json.results?.opinion?.ok, true, 'D1-B: la bajada archiva la Opinión');
    h.clock.t += 60000; await h.service.tick();
    const alerta = h.mails.find(m => String(m.subject || '').includes('salió NEGATIVA'));
    assert.ok(alerta, 'D1-B: el aviso salió también sin enumeración');
    assert.ok(alerta.text.includes('salió negativa; el documento enumera sus motivos'),
      'D1-B: sin enumeración legible, la frase de reserva de siempre');
    assert.ok(!alerta.text.includes('ejercicio 2025'),
      'D1-B: jamás un motivo inventado');
    console.log('OK 2.9.7 · D1-B — Negada sin enumeración en el texto: reserva honesta, cero invención.');
  } finally { h.service.close(); }
}

/* ================================================================
   D1-C · COMPAÑÍA — LA RESERVA DEL CRUDO SIGUE VIVA: un
   contenido en texto plano (sin capa extraíble: el extractor
   real no lo puede leer como PDF) con «NEGATIVA» y su
   enumeración sigue dando sus motivos, como en la 2.0
   (la semilla de ronda200e e1, por la vía de reserva).
   ================================================================ */
{
  const plano = Buffer.from('%PDF-1.4 Opinión de cumplimiento NEGATIVA. Motivos: ' +
    '1. ' + MOTIVO_1 + ' 2. ' + MOTIVO_2);
  const h = makeHarness({ serviceOptions: {
    satDocFetch: async (profile, kind) => kind === 'opinion'
      ? { content: plano, issuedAt: '2026-11-16', fileName: 'Opinion ' + profile.rfc + '.pdf' }
      : { content: plano, issuedAt: '2026-11-16', fileName: 'Constancia ' + profile.rfc + '.pdf' } } });
  try {
    await setupMail(h); await seedPeople(h); await unlock(h);
    const run = await h.call('POST', '/api/satdocs/run', { rfc: OWN, kind: 'opinion' });
    assert.equal(run.json.results?.opinion?.ok, true, 'D1-C: la bajada archiva la Opinión');
    h.clock.t += 60000; await h.service.tick();
    const alerta = h.mails.find(m => String(m.subject || '').includes('salió NEGATIVA'));
    assert.ok(alerta, 'D1-C: el aviso salió');
    assert.ok(alerta.text.includes(MOTIVO_1), 'D1-C: el motivo 1 sale por la vía de reserva del crudo, literal');
    assert.ok(alerta.text.includes(MOTIVO_2), 'D1-C: y el motivo 2 también');
    console.log('OK 2.9.7 · D1-C — Contenido en plano sin capa extraíble: la reserva del crudo sigue encontrando los motivos.');
  } finally { h.service.close(); }
}

/* ================================================================
   D3-A · EQUIVALENCIA DE CONTEOS: el mapa bancosSinConciliar240
   de /api/status es EXACTAMENTE el que sale de sumar los
   conteos de la conciliación completa sobre la misma semilla
   (con vínculo activo, marca, pago a mano, cancelada, cuenta
   sin dueño y dos RFC) — y coincide con la cuenta a mano.
   ================================================================ */
async function sembrarBancos297(h, dbFile) {
  const inv = (n, to, extra = {}) => ({ id: 'a0000000-0000-4000-8000-' + String(n).padStart(12, '0'),
    date: '2026-10-0' + ((n % 8) + 1), kind: 'I', total: '100.00',
    from: { rfc: 'PROV010101AA1', name: 'Proveedor' }, to: { rfc: to, name: 'Receptor' }, ...extra });
  const batch = { invoices: [
    inv(1, OWN), inv(2, OWN), inv(3, OWN, { state: 'Cancelado' }), inv(4, OWN), inv(5, OWN),
    inv(6, OTRO) ] };
  const r = await h.call('POST', '/api/storage', { batch });
  assert.equal(r.status, 200, 'D3: semilla de CFDI guardada');
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbFile);
  const cta = db.prepare("INSERT INTO bank_accounts(id,bank,name,last4,kind,created,rfc,numero) VALUES (?,?,?,?,?,0,?,'')");
  cta.run('ctaA', 'BBVA', 'Cuenta A', '1111', 'debito', OWN);
  cta.run('ctaB', 'BBVA', 'Cuenta B', '2222', 'debito', OTRO);
  cta.run('ctaSin', 'BBVA', 'Sin dueño', '3333', 'debito', '');
  const st = db.prepare("INSERT INTO bank_statements(id,accountId,month,fileId,openingCents,closingCents,creditsCents,chargesCents,movements,state,detected,created) VALUES (?,?, '2026-10','',0,0,0,0,0,'ok','',0)");
  st.run('stA', 'ctaA'); st.run('stB', 'ctaB'); st.run('stSin', 'ctaSin');
  const mv = db.prepare('INSERT INTO bank_movements(id,statementId,date,concept,amountCents,balanceCents) VALUES (?,?,?,?,?,0)');
  mv.run('mvA1', 'stA', '2026-10-03', 'PAGO VINCULADO', -10000);
  mv.run('mvA2', 'stA', '2026-10-04', 'PAGO MARCADO', -10000);
  mv.run('mvA3', 'stA', '2026-10-05', 'PAGO LIBRE', -7777);
  mv.run('mvA4', 'stA', '2026-10-06', 'ABONO', 5000);
  mv.run('mvSin', 'stSin', '2026-10-05', 'PAGO SIN DUEÑO', -10000);
  db.prepare("INSERT INTO bank_matches(id,movementId,invoices,mode,amountCents,why,estado,created,undone) VALUES ('mt1','mvA1',?,'total',0,'','activo',0,0)")
    .run(JSON.stringify([{ uuid: 'a0000000-0000-4000-8000-000000000001' }]));
  db.prepare("INSERT INTO bank_movement_marks(movementId,estado,nota,at) VALUES ('mvA2','revisado','',0)").run();
  db.prepare("INSERT INTO manual_payments(uuid,at,nota,importe) VALUES ('a0000000-0000-4000-8000-000000000002',0,'','')").run();
  db.close();
}
{
  const dir = mkdtempSync(join(tmpdir(), 'pacosat-297d3-'));
  const dbFile = join(dir, 'pacosat.sqlite');
  const h = makeHarness({ dbFile });
  try {
    await seedPeople(h); await unlock(h); await unlock(h, OTRO);
    await sembrarBancos297(h, dbFile);
    const conc = (await h.call('GET', '/api/banks/conciliacion')).json;
    const desdeConciliacion = {};
    for (const cuenta of conc.porCuenta || []) {
      const rfc = String(cuenta.account?.rfc || '').toUpperCase();
      if (!rfc) continue;
      desdeConciliacion[rfc] = (desdeConciliacion[rfc] || 0) +
        (cuenta.conteos?.facturasSinPagoVisto || 0) + (cuenta.conteos?.pagosSinFactura || 0);
    }
    assert.deepEqual(desdeConciliacion, { [OWN]: 3, [OTRO]: 1 },
      'D3-A: la semilla da la cuenta a mano en la conciliación completa (OWN: 2 facturas + 1 pago; OTRO: 1 factura)');
    const status = (await h.call('GET', '/api/status')).json;
    assert.deepEqual(status.bancosSinConciliar240, desdeConciliacion,
      'D3-A: el mapa del estado ES el de la conciliación completa, conteo a conteo');
    console.log('OK 2.9.7 · D3-A — bancosSinConciliar240 del estado == conteos de la conciliación completa (y == cuenta a mano).');
  } finally { h.service.close(); rmSync(dir, { recursive: true, force: true }); }
}

/* ================================================================
   D3-B · TIEMPOS TRAS EL ARREGLO + LA LISTA EN SÍ: con la
   semilla pesada (1.600 CFDI, 300 movimientos sin conciliar),
   /api/status ya no paga la conciliación completa (mediana
   claramente por debajo de la de /api/banks/conciliacion) y
   GET /api/respaldos200g lista solo metadatos.
   ================================================================ */
{
  const dir = mkdtempSync(join(tmpdir(), 'pacosat-297d3b-'));
  const dbFile = join(dir, 'pacosat.sqlite');
  const bak = join(dir, 'respaldos');
  const h = makeHarness({ dbFile });
  try {
    await seedPeople(h); await unlock(h);
    await h.service.bootstrap({ backup: { password: 'respaldo-prueba-16', frequency: 'daily', dir: bak }, profiles: [] });
    const inv = i => ({ id: 'b0000000-0000-4000-8000-' + String(i).padStart(12, '0'),
      date: '2026-10-' + String(1 + (i % 28)).padStart(2, '0'), kind: 'I', total: (100 + (i % 97)) + '.00',
      from: { rfc: 'PROV010101AA' + (i % 5), name: 'Proveedor' }, to: { rfc: OWN, name: 'Propio' } });
    for (let base = 0; base < 1600; base += 200) {
      const batch = { invoices: [] };
      for (let i = base; i < base + 200; i++) batch.invoices.push(inv(i));
      assert.equal((await h.call('POST', '/api/storage', { batch })).status, 200, 'D3-B: lote de CFDI');
    }
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(dbFile);
    db.prepare("INSERT INTO bank_accounts(id,bank,name,last4,kind,created,rfc,numero) VALUES ('cta1','BBVA','Cuenta','1234','debito',0,?,'')").run(OWN);
    db.prepare("INSERT INTO bank_statements(id,accountId,month,fileId,openingCents,closingCents,creditsCents,chargesCents,movements,state,detected,created) VALUES ('st1','cta1','2026-10','',0,0,0,0,300,'ok','',0)").run();
    const ins = db.prepare('INSERT INTO bank_movements(id,statementId,date,concept,amountCents,balanceCents) VALUES (?,?,?,?,?,0)');
    for (let i = 0; i < 300; i++)
      ins.run('mv' + i, 'st1', '2026-10-' + String(1 + (i % 28)).padStart(2, '0'), 'PAGO PROVEEDOR', -(10000 + (i * 137) % 5000 + 13));
    db.close();
    await h.service.backupTick(h.clock.t);
    const lista = await h.call('GET', '/api/respaldos200g');
    assert.equal(lista.json.configurado, true, 'D3-B: la lista dice que hay carpeta de respaldos');
    assert.equal(lista.json.respaldos.length, 1, 'D3-B: y lista el respaldo creado, con su fecha');
    assert.ok(lista.json.respaldos[0].bytes > 0 && Array.isArray(lista.json.respaldos[0].archivos),
      'D3-B: la lista enseña metadatos (fecha, archivos, tamaño) — sin contenido descifrado');
    assert.ok(!('content' in lista.json.respaldos[0]) && !('data' in lista.json.respaldos[0]),
      'D3-B: ningún contenido de respaldo viaja en la lista');
    const mediana = async (fn, n = 3) => {
      const ts = [];
      for (let i = 0; i < n; i++) { const t0 = performance.now(); await fn(); ts.push(performance.now() - t0); }
      return ts.sort((a, b) => a - b)[Math.floor(ts.length / 2)];
    };
    const tConc = await mediana(() => h.call('GET', '/api/banks/conciliacion'));
    const tStatus = await mediana(() => h.call('GET', '/api/status'));
    const tLista = await mediana(() => h.call('GET', '/api/respaldos200g'));
    console.log('  D3-B tiempos (ms, mediana de 3): conciliación completa=' + tConc.toFixed(1) +
      ' · /api/status=' + tStatus.toFixed(1) + ' · /api/respaldos200g=' + tLista.toFixed(1));
    assert.ok(tStatus < tConc * 0.6,
      'D3-B: /api/status ya no paga la conciliación completa en cada pulso (' +
      tStatus.toFixed(1) + ' ms frente a ' + tConc.toFixed(1) + ' ms de la conciliación)');
    console.log('OK 2.9.7 · D3-B — El estado sirve sus conteos sin la conciliación completa; la lista de respaldos es solo metadatos.');
  } finally { h.service.close(); rmSync(dir, { recursive: true, force: true }); }
}

/* ================================================================
   CLIENTE — arnés DOM de juguete (el de ronda295) con el fetch
   PUENTEADO al servidor real. opciones.confirmValue: lo que la
   confirmación NATIVA devuelve (en vivo se traga: false).
   ================================================================ */
const htmlCliente = readFileSync(join(AQUI, 'Faro-Fiscal.html'), 'utf8');
const lazyCliente = JSON.parse(readFileSync(join(AQUI, 'lazy.json'), 'utf8'));
class BootURL extends URL { static createObjectURL() { return 'blob:prueba'; } static revokeObjectURL() {} }
class FakeElement {
  constructor(tag = 'div') {
    this.tagName = String(tag).toUpperCase();
    this.children = []; this.dataset = {}; this.style = {}; this.attributes = {};
    this.textContent = ''; this.innerHTML = ''; this.value = '';
    this.hidden = false; this.disabled = false; this.open = false; this.files = [];
    this.checked = false; this.isConnected = true;
    const classes = new Set();
    this.classList = { add: (...n) => n.forEach(x => classes.add(x)),
      remove: (...n) => n.forEach(x => classes.delete(x)),
      toggle: (name, force) => { const on = force === undefined ? !classes.has(name) : Boolean(force);
        if (on) classes.add(name); else classes.delete(name); return on; },
      contains: name => classes.has(name) };
  }
  get childNodes() { return this.children; }
  get lastChild() { return this.children[this.children.length - 1]; }
  get firstChild() { return this.children[0]; }
  append(...kids) { for (const k of kids) if (k instanceof FakeElement) this.children.push(k); }
  prepend(...kids) { for (const k of [...kids].reverse()) if (k instanceof FakeElement) this.children.unshift(k); }
  appendChild(k) { if (k instanceof FakeElement) this.children.push(k); return k; }
  insertBefore(k) { if (k instanceof FakeElement) this.children.push(k); return k; }
  removeChild(k) { this.children = this.children.filter(c => c !== k); return k; }
  replaceWith(...kids) { this.children = kids.filter(k => k instanceof FakeElement); }
  before() {} after() {} insertAdjacentElement(_w, k) { return k; }
  insertAdjacentHTML() {} insertAdjacentText() {}
  cloneNode() { return new FakeElement(this.tagName); }
  replaceChildren(...kids) { this.children = kids.filter(k => k instanceof FakeElement); }
  remove() {} click() {} close() {} showModal() {}
  setAttribute(n, v) { this.attributes[n] = String(v); }
  getAttribute(n) { return n in this.attributes ? this.attributes[n] : null; }
  removeAttribute(n) { delete this.attributes[n]; }
  hasAttribute(n) { return n in this.attributes; }
  addEventListener() {} removeEventListener() {}
  querySelector() { return null; } querySelectorAll() { return []; }
  closest() { return null; } focus() {} blur() {} scrollIntoView() {}
  getBoundingClientRect() { return { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 }; }
}
const textoDe = el => { let t = el.textContent || ''; for (const h of el.children || []) t += ' ' + textoDe(h); return t; };
const andar = (el, salida = []) => { salida.push(el); for (const h of el.children || []) andar(h, salida); return salida; };
const buscarBoton = (raiz, texto) => andar(raiz).find(el =>
  el.tagName === 'BUTTON' && (el.textContent || '').trim().startsWith(texto));
const asentar = async (n = 30) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)); };

async function bootCliente297(opciones = {}) {
  const byId = new Map();
  const slotActividad = new FakeElement('div');
  const fetchLog = [];
  let tokenReal = opciones.token || 'token-de-prueba';
  if (opciones.harness) {
    const home = await opciones.harness.raw('GET', '/');
    tokenReal = /name="pacosat-token" content="([0-9a-f]+)"/.exec(home.text)?.[1] || tokenReal;
  }
  const metas = { 'meta[name="pacosat-token"]': { content: tokenReal },
    'meta[name="pacosat-cloud"]': { content: '1' } };
  const headEl = new FakeElement('head');
  const documentStub = {
    getElementById: id => { if (!byId.has(id)) byId.set(id, new FakeElement('div')); return byId.get(id); },
    createElement: tag => new FakeElement(tag),
    createElementNS: (_ns, tag) => new FakeElement(tag),
    createTextNode: text => ({ textContent: String(text) }),
    querySelector: sel => sel === '[data-sys-activity]' ? slotActividad : (metas[sel] ?? null),
    querySelectorAll: () => [], addEventListener: () => {}, removeEventListener: () => {},
    documentElement: new FakeElement('html'), body: new FakeElement('body'), head: headEl,
    activeElement: null, title: '' };
  const storageStub = (semilla = {}) => { const map = new Map(Object.entries(semilla));
    return { getItem: k => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)),
      removeItem: k => map.delete(k), clear: () => map.clear() }; };
  const fetchStub = async (url, init = {}) => {
    const target = String(url);
    const parteM = /\/parte\/(\w+)/.exec(target);
    if (parteM) { const src = lazyCliente.partes[parteM[1]]?.source || '';
      return { ok: true, status: 200, headers: { get: () => 'text/javascript' },
        json: async () => ({}), text: async () => src, blob: async () => new Blob([]) }; }
    if (opciones.harness) {
      const method = init.method || 'GET';
      const hdrsMin = {}; for (const [k, v] of Object.entries(init.headers || {})) hdrsMin[k.toLowerCase()] = v;
      const r = await opciones.harness.raw(method, target, init.body, hdrsMin);
      fetchLog.push({ method, target, status: r.status, body: init.body || '' });
      let json = null; try { json = JSON.parse(r.text); } catch { /* binario */ }
      return { ok: r.status >= 200 && r.status < 300, status: r.status,
        headers: { get: name => { const k = Object.keys(r.headers).find(h => h.toLowerCase() === String(name).toLowerCase()); return k ? r.headers[k] : null; } },
        json: async () => { if (json === null) throw new Error('no json'); return json; },
        text: async () => r.text, blob: async () => new Blob([r.text]) };
    }
    return { ok: true, status: 200, headers: { get: () => 'application/json' },
      json: async () => ({}), text: async () => '{}', blob: async () => new Blob([]) };
  };
  const timer = (fn, ms, ...a) => { const t = setTimeout(fn, ms, ...a); t.unref?.(); return t; };
  const every = (fn, ms, ...a) => { const t = setInterval(fn, ms, ...a); t.unref?.(); return t; };
  const context = vm.createContext({ console, document: documentStub,
    navigator: { onLine: true, userAgent: 'ronda297-test' },
    location: { href: 'http://127.0.0.1:43729/', search: '', reload: () => {} },
    localStorage: storageStub(opciones.localStorage || {}), sessionStorage: storageStub(),
    fetch: fetchStub, setTimeout: timer, setInterval: every, clearTimeout, clearInterval, queueMicrotask,
    URL: BootURL, URLSearchParams, Blob, TextEncoder, TextDecoder, btoa, atob,
    crypto: webcrypto, DecompressionStream, Node: class FakeNode {}, IntersectionObserver: undefined,
    matchMedia: () => ({ matches: false, addEventListener: () => {}, addListener: () => {} }),
    Option: class extends FakeElement {}, alert: () => {},
    confirm: () => opciones.confirmValue !== undefined ? opciones.confirmValue : true,
    addEventListener: () => {}, removeEventListener: () => {},
    requestAnimationFrame: fn => timer(fn, 0) });
  context.window = context; context.self = context;
  headEl.appendChild = kid => {
    if (kid && typeof kid.textContent === 'string' && kid.textContent)
      vm.runInContext(kid.textContent, context, { filename: 'parte-diferida' });
    return kid;
  };
  const script = htmlCliente.match(/<script>([\s\S]*?)<\/script>/)[1];
  vm.runInContext(script, context, { filename: 'Faro-Fiscal.html#script' });
  await asentar(40);
  return { context, fetchLog, slotActividad,
    texto: () => textoDe(context.document.getElementById('body')) };
}

/* ================================================================
   D4-1 · RESTAURAR UN RESPALDO (salidas): con la confirmación
   nativa TRAGADA (false, la forma de en vivo), el clic en
   «Restaurar este» abre el diálogo PROPIO con su texto y NO
   llama al servidor; confirmar en el diálogo SÍ restaura.
   ================================================================ */
{
  const dir = mkdtempSync(join(tmpdir(), 'pacosat-297d4-'));
  const dbFile = join(dir, 'pacosat.sqlite');
  const bak = join(dir, 'respaldos');
  const h = makeHarness({ dbFile, html: htmlCliente });
  try {
    await seedPeople(h); await unlock(h);
    await h.call('POST', '/api/storage', { batch: { invoices: [
      { id: 'c0000000-0000-4000-8000-000000000001', date: '2026-10-03', kind: 'I', total: '100.00',
        from: { rfc: 'PROV010101AA1', name: 'Proveedor' }, to: { rfc: OWN, name: 'Propio' } }] } });
    await h.service.bootstrap({ backup: { password: 'respaldo-prueba-16', frequency: 'daily', dir: bak }, profiles: [] });
    await h.service.backupTick(h.clock.t);
    const b = await bootCliente297({ harness: h, confirmValue: false });
    await vm.runInContext("ensureLazyPart('salidas')", b.context);
    await asentar(40);
    const panelEl = vm.runInContext('restaurar200gPanel()', b.context);
    const ver = buscarBoton(panelEl, 'Ver los respaldos');
    assert.ok(ver, 'D4-1: el panel enseña su «Ver los respaldos»');
    await ver.onclick(); await asentar(50);
    const btn = buscarBoton(panelEl, 'Restaurar este');
    assert.ok(btn, 'D4-1: el respaldo sembrado se lista con su «Restaurar este»');
    b.fetchLog.length = 0;
    await btn.onclick(); await asentar(30);
    const campos = textoDe(b.context.document.getElementById('fields'));
    assert.ok(campos.includes('Se va a reemplazar el expediente actual por el respaldo del'),
      'D4-1: la confirmación se abre en el diálogo propio, con su texto de siempre');
    assert.equal(b.context.document.getElementById('dialogTitle').textContent, 'Restaurar este respaldo',
      'D4-1: el diálogo se titula por su acción');
    assert.ok(!b.fetchLog.some(l => l.method === 'POST' && l.target.includes('respaldos200g/restaurar')),
      'D4-1: sin confirmar en el diálogo NO se restaura nada (cancelar no ejecuta)');
    await vm.runInContext('submit()', b.context);
    await asentar(60);
    assert.ok(b.fetchLog.some(l => l.method === 'POST' && l.target.includes('respaldos200g/restaurar')),
      'D4-1: al confirmar en el diálogo, la restauración corre de verdad');
    console.log('OK 2.9.7 · D4-1 — «Restaurar este» confirma con el diálogo propio: sin confirmar no pasa nada; confirmando, restaura.');
  } finally { h.service.close(); rmSync(dir, { recursive: true, force: true }); }
}

/* ================================================================
   D4-2 · REVOCAR EL ACCESO DE UN EJECUTOR (tributario): el
   mismo comportamiento en el segundo sitio representativo —
   diálogo propio, cancelar no ejecuta, confirmar revoca y el
   servidor lo enseña revocado.
   ================================================================ */
{
  const h = makeHarness({ html: htmlCliente });
  try {
    await seedPeople(h); await unlock(h);
    const par = await h.call('POST', '/api/executor/pair', { nombre: 'Equipo repro D4' });
    assert.equal(par.status, 200, 'D4-2: el ejecutor de juguete se empareja');
    const b = await bootCliente297({ harness: h, confirmValue: false });
    await vm.runInContext("ensureLazyPart('buzon')", b.context);
    await asentar(40);
    const panelEl = vm.runInContext('executorPanel()', b.context);
    await asentar(60);
    const rev = buscarBoton(panelEl, 'Revocar acceso');
    assert.ok(rev, 'D4-2: el panel del ejecutor enseña su «Revocar acceso»');
    b.fetchLog.length = 0;
    await rev.onclick(); await asentar(30);
    const campos = textoDe(b.context.document.getElementById('fields'));
    assert.ok(campos.includes('¿Revocar el acceso de «Equipo repro D4»?'),
      'D4-2: la confirmación se abre en el diálogo propio, con su texto de siempre');
    assert.ok(!b.fetchLog.some(l => l.method === 'POST' && l.target.includes('executor/revoke')),
      'D4-2: sin confirmar en el diálogo NO se revoca nada (cancelar no ejecuta)');
    await vm.runInContext('submit()', b.context);
    await asentar(60);
    assert.ok(b.fetchLog.some(l => l.method === 'POST' && l.target.includes('executor/revoke')),
      'D4-2: al confirmar en el diálogo, la revocación llega al servidor');
    const ov = (await h.call('GET', '/api/executor/overview')).json;
    assert.ok(ov.ejecutores.find(e => e.nombre === 'Equipo repro D4')?.revocado,
      'D4-2: en el servidor el acceso queda revocado');
    console.log('OK 2.9.7 · D4-2 — «Revocar acceso» del ejecutor confirma con el diálogo propio y revoca al confirmar.');
  } finally { h.service.close(); }
}
