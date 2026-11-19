/* ================================================================
   Ronda 2.4.0 · WC3a — Documentos, castigos 16, 17 y 19.
   (16) MINIATURAS: con un PDF de juguete de 2 páginas, la
        miniatura servida es un PNG válido de la PÁGINA 1 (vale
        lo mismo cambie lo que cambie la página 2, y cambia si
        cambia la página 1), se cachea (la segunda petición no
        regenera: el sello de thumbs200g no se mueve) y se
        REGENERA si el documento cambia bajo el mismo id
        (huella). El invitado solo la recibe de sus RFC.
   (17) BUSCAR DENTRO: un PDF cuyo texto contiene una frase que
        su nombre NO contiene se encuentra por la frase, el
        resultado dice que pegó en el TEXTO y enseña el
        fragmento; por el nombre pega como «nombre» (también sin
        acentos); el invitado no encuentra documentos ajenos.
   (19) PAQUETE PARA EL BANCO: con las tres piezas archivadas
        el ZIP trae los tres nombres canónicos y su NOTA; con
        una ausente trae las dos y la nota la nombra; sin
        ninguna, 422 y ningún ZIP. La clase «paquete-banco» de
        /api/enviar adjunta el mismo ZIP y el paquete queda en
        el Registro.
   ================================================================ */
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createPacoSATService } from './local-server.mjs';
import { buildPdf } from './salidas-doc.mjs';

const ORIGIN = 'https://pacosat.test';
const KEY = 'c'.repeat(64);
const OWN = 'MFI6212158B4';
const OTRO = 'AAA010101AAA';
const TERC = 'CCC010101CC3';
const T0 = Date.parse('2026-11-05T15:00:00Z');

/* PDF mínimo de 2 páginas hecho a mano (xref calculado): la
   página 1 y la página 2 llevan textos DISTINTOS y conocidos,
   para poder probar de qué página sale la miniatura y que la
   búsqueda lee también la segunda página. */
function pdfDosPaginas(texto1, texto2) {
  const esc = t => t.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const stream = t => 'BT /F1 14 Tf 72 720 Td (' + esc(t) + ') Tj ET';
  const s1 = stream(texto1), s2 = stream(texto2);
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Length ' + s1.length + ' >>\nstream\n' + s1 + '\nendstream',
    '<< /Length ' + s2.length + ' >>\nstream\n' + s2 + '\nendstream'];
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((body, i) => { offsets.push(pdf.length); pdf += (i + 1) + ' 0 obj\n' + body + '\nendobj\n'; });
  const xrefAt = pdf.length;
  pdf += 'xref\n0 ' + (objs.length + 1) + '\n0000000000 65535 f \n' +
    offsets.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('') +
    'trailer\n<< /Size ' + (objs.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + xrefAt + '\n%%EOF';
  return Buffer.from(pdf, 'latin1');
}
const FRASE = 'LA FRASE DEL ZORRO PARDO SALTA EN LA SEGUNDA PAGINA';
const pdfZorro = pdfDosPaginas('Primera pagina comun del juguete', FRASE);
const pdfZorroOtraSegunda = pdfDosPaginas('Primera pagina comun del juguete', 'Segunda pagina totalmente distinta');
const pdfZorroOtraPrimera = pdfDosPaginas('Una primera pagina que no se parece', FRASE);
const pdfPapel = buildPdf({ title: 'Papel suelto', subtitle: 'PacoSAT · prueba WC3a',
  sections: [{ heading: 'Contenido', lines: ['Papel sin la frase buscada.'] }] });
const b64 = buf => buf.toString('base64');

function makeHarness(extra = {}) {
  const clock = { t: T0 };
  const mails = [];
  const service = createPacoSATService({
    html: '<html><head><!--PACOSAT_TOKEN--></head><body>prueba</body></html>',
    origin: ORIGIN, proxyKey: KEY, now: () => clock.t,
    makeConnector: async () => ({ parser: class {}, connector: {
      request: async () => 'req-f', check: async () => ({ status: 'pending', packages: [] }),
      download: async () => { throw new Error('sin paquetes'); } } }),
    makeMailer: () => ({ verify: async () => true,
      sendMail: async mail => { mails.push(mail); return { messageId: 'm' + mails.length }; } }),
    ...extra });
  let token = '';
  const raw = async (method, path, body, extraHeaders = {}) => {
    const chunks = []; if (body !== undefined) chunks.push(Buffer.from(JSON.stringify(body)));
    const req = Readable.from(chunks);
    req.method = method; req.url = path;
    req.headers = { host: 'pacosat.test', origin: ORIGIN, 'x-pacosat-proxy': KEY, ...extraHeaders };
    let status = 0; const headers = {}; let text = '';
    const res = { writeHead(c, hdrs) { status = c; if (hdrs) Object.assign(headers, hdrs); },
      setHeader(k, v) { headers[k] = v; }, getHeader(k) { return headers[k]; },
      end(chunk) { if (chunk) text += Buffer.isBuffer(chunk) ? chunk.toString('latin1') : chunk; } };
    await service.handle(req, res);
    return { status, text, headers };
  };
  const call = async (method, path, body) => {
    if (!token) { const home = await raw('GET', '/'); token = /[0-9a-f]{64}/.exec(home.text)?.[0] || ''; }
    const r = await raw(method, path, body, { 'x-pacosat-token': token });
    let json = null; try { json = JSON.parse(r.text); } catch { /* binario */ }
    return { status: r.status, json, text: r.text, headers: r.headers };
  };
  const callAs = async (otroToken, method, path, body) => {
    const r = await raw(method, path, body, { 'x-pacosat-token': otroToken });
    let json = null; try { json = JSON.parse(r.text); } catch { /* binario */ }
    return { status: r.status, json, text: r.text };
  };
  return { service, call, callAs, raw, mails, clock };
}

/* ===== Semilla en fichero: perfiles, documentos del SAT y
   declaraciones, como los guarda el sistema de verdad ===== */
const dir = mkdtempSync(join(tmpdir(), 'pacosat-wc3a-'));
const dbFile = join(dir, 'pacosat.sqlite');
{
  const boot = createPacoSATService({ dbFile, html: 'x', origin: ORIGIN, proxyKey: KEY });
  boot.close();
  const seed = new DatabaseSync(dbFile);
  const perfil = seed.prepare("INSERT INTO profiles(rfc,minutes,days,direction,nextRun,error) VALUES (?,1440,7,'both',0,'')");
  perfil.run(OWN); perfil.run(OTRO); perfil.run(TERC);
  const satdoc = seed.prepare("INSERT INTO sat_documents(id,rfc,kind,issuedAt,fileId,source,created,error) VALUES (?,?,?, ?,?,'auto',?,'')");
  satdoc.run('sd-cons-own', OWN, 'constancia', Date.parse('2026-11-10T12:00:00Z'), 'pdf:cons-own', T0);
  satdoc.run('sd-op-own', OWN, 'opinion', Date.parse('2026-11-11T12:00:00Z'), 'pdf:op-own', T0);
  satdoc.run('sd-cons-otro', OTRO, 'constancia', Date.parse('2026-11-09T12:00:00Z'), 'pdf:cons-otro', T0);
  const decl = seed.prepare("INSERT INTO declaraciones(id,rfc,tipo,clase,ejercicio,periodo,fechaPresentacion,operacion,fileId,source,created) VALUES (?,?, 'anual','declaracion',?,'', '2026-04-15','123456',?,'auto',?)");
  decl.run('decl-own', OWN, 2025, 'pdf:anual-own', T0);
  decl.run('decl-otro', OTRO, 2024, 'pdf:anual-otro', T0);
  seed.close();
}
const h = makeHarness({ dbFile });
const leerDb = sql => { const db = new DatabaseSync(dbFile, { readOnly: true }); try { return db.prepare(sql).all(); } finally { db.close(); } };
try {
  const mail = await h.call('POST', '/api/mail', { host: 'smtp.test', port: 465, security: 'ssl',
    from: 'avisos@pacosat.test', recipient: 'paco@test.mx', user: 'u', password: 'p' });
  assert.equal(mail.status, 200);
  const seed = await h.call('POST', '/api/storage', { batch: {
    people: [{ id: OWN, name: 'Mano Fil, S.A.' }, { id: OTRO, name: 'Otra Empresa SA' }, { id: TERC, name: 'Tercera SA' }],
    files: [
      { id: 'pdf:zorro', content: b64(pdfZorro), mime: 'application/pdf' },
      { id: 'pdf:zorro2', content: b64(pdfZorroOtraSegunda), mime: 'application/pdf' },
      { id: 'pdf:cons-own', content: b64(pdfPapel), mime: 'application/pdf' },
      { id: 'pdf:op-own', content: b64(pdfPapel), mime: 'application/pdf' },
      { id: 'pdf:anual-own', content: b64(pdfPapel), mime: 'application/pdf' },
      { id: 'pdf:cons-otro', content: b64(pdfPapel), mime: 'application/pdf' },
      { id: 'pdf:anual-otro', content: b64(pdfPapel), mime: 'application/pdf' },
      { id: 'pdf:zorro-otro', content: b64(pdfZorro), mime: 'application/pdf' }],
    documents: [
      { id: 'pdf:zorro', rfc: OWN, kind: 'Documento', date: '2026-11-02', period: '', name: 'papel-suelto.pdf' },
      { id: 'pdf:zorro2', rfc: OWN, kind: 'Documento', date: '2026-11-03', period: '', name: 'otro-papel.pdf' },
      { id: 'pdf:cons-own', rfc: OWN, kind: 'Constancia / CIF', date: '2026-11-10', period: '', name: 'Constancia de situacion fiscal.pdf' },
      { id: 'pdf:op-own', rfc: OWN, kind: 'Opinión de cumplimiento', date: '2026-11-11', period: '', name: 'Opinión de cumplimiento · ' + OWN + '.pdf' },
      { id: 'pdf:zorro-otro', rfc: OTRO, kind: 'Documento', date: '2026-11-02', period: '', name: 'papel-ajeno.pdf' }] } });
  assert.equal(seed.status, 200, 'semilla del escenario');

  /* ===== (16) Miniatura: PNG de la página 1, cacheada ===== */
  const tokenAdmin = /[0-9a-f]{64}/.exec((await h.raw('GET', '/')).text)?.[0] || '';
  const mini = id => h.raw('GET', '/api/miniatura200g?id=' + encodeURIComponent(id), undefined,
    { 'x-pacosat-token': tokenAdmin });
  const m1 = await mini('pdf:zorro');
  assert.equal(m1.status, 200, 'la miniatura se sirve');
  assert.ok(m1.text.startsWith('\x89PNG'), 'es un PNG válido (su firma)');
  const ancho = Buffer.from(m1.text, 'latin1').readUInt32BE(16);
  assert.equal(ancho, 240, 'el PNG es la miniatura de 240 px de ancho de la casa');
  const sello1 = leerDb("SELECT at FROM thumbs200g WHERE fileId='pdf:zorro'")[0]?.at;
  assert.ok(sello1, 'la generación quedó registrada en thumbs200g');
  const m2doc = await mini('pdf:zorro2');
  assert.equal(m2doc.status, 200);
  assert.equal(m2doc.text, m1.text,
    'misma página 1 con OTRA página 2 ⇒ la misma miniatura: sale de la página 1');
  h.clock.t += 5 * 60 * 1000;
  const m1b = await mini('pdf:zorro');
  assert.equal(m1b.text, m1.text, 'la segunda petición sirve la misma miniatura');
  const sello2 = leerDb("SELECT at FROM thumbs200g WHERE fileId='pdf:zorro'")[0]?.at;
  assert.equal(sello2, sello1, 'y NO se regeneró: el sello de la caché no se movió (generada una vez)');
  /* Si el documento cambia bajo el mismo id, se regenera. (El
     cambio se siembra directo en la base: la tienda de
     sincronización no sobrescribe ficheros por su ruta, pero el
     almacén sí admite el reemplazo — p. ej. al rearchivar — y
     la huella es quien debe delatarlo.) */
  { const db = new DatabaseSync(dbFile);
    db.prepare("UPDATE records SET data=?, value=NULL WHERE store='files' AND id='pdf:zorro'").run(pdfZorroOtraPrimera);
    db.close(); }
  const m1c = await mini('pdf:zorro');
  assert.equal(m1c.status, 200);
  assert.notEqual(m1c.text, m1.text, 'documento cambiado ⇒ miniatura nueva (la huella manda)');
  console.log('OK 2.4.0·WC3a (16) — miniatura PNG de la página 1, cacheada por huella y regenerada al cambiar el documento.');

  /* ===== (17) Buscar dentro: la frase que el nombre no trae ===== */
  const porTexto = await h.call('GET', '/api/buscar-contenido240?q=' + encodeURIComponent('frase del zorro pardo'));
  assert.equal(porTexto.status, 200);
  const hitTexto = porTexto.json.resultados.find(r => r.id === 'pdf:zorro');
  assert.ok(hitTexto, 'el PDF se encuentra por una frase de su SEGUNDA página que su nombre no contiene');
  assert.equal(hitTexto.donde, 'texto', 'el resultado dice que pegó en el texto');
  assert.ok(hitTexto.fragmento.includes('ZORRO PARDO'),
    'y enseña el fragmento que contiene la frase: «' + hitTexto.fragmento + '»');
  assert.ok(porTexto.json.indexadosAhora >= 1, 'la primera búsqueda indexó en el acto (relleno perezoso declarado)');
  const porNombre = await h.call('GET', '/api/buscar-contenido240?q=constancia');
  const hitNombre = porNombre.json.resultados.find(r => r.id === 'pdf:cons-own');
  assert.ok(hitNombre && hitNombre.donde === 'nombre', 'por el nombre pega como «nombre»');
  const sinAcento = await h.call('GET', '/api/buscar-contenido240?q=opinion');
  const hitAcento = sinAcento.json.resultados.find(r => r.id === 'pdf:op-own');
  assert.ok(hitAcento && hitAcento.donde === 'nombre', '«opinion» sin acento encuentra «Opinión…»');
  const corta = await h.call('GET', '/api/buscar-contenido240?q=ab');
  assert.equal(corta.status, 400, 'una búsqueda de menos de 3 letras se rechaza en llano');
  console.log('OK 2.4.0·WC3a (17) — búsqueda en el contenido con dónde pegó y su fragmento; nombre y sin acentos también.');

  /* ===== (19) Paquete para el banco: completo ===== */
  const estado = await h.call('GET', '/api/paquete-banco240?rfc=' + OWN);
  assert.equal(estado.status, 200);
  assert.equal(estado.json.alguna, true);
  assert.ok(estado.json.piezas.constancia.hay && estado.json.piezas.opinion.hay && estado.json.piezas.anual.hay,
    'el estado previo dice que constan las tres piezas');
  assert.equal(estado.json.piezas.anual.ejercicio, '2025', 'la anual es la de 2025');
  const paquete = await h.call('POST', '/api/paquete-banco240', { rfc: OWN });
  assert.equal(paquete.status, 200);
  assert.equal(paquete.json.name, OWN + '-paquete-banco.zip', 'el ZIP va bien nombrado');
  const zipTxt = Buffer.from(paquete.json.content, 'base64').toString('latin1');
  for (const nombre of [OWN + '-constancia.pdf', OWN + '-opinion.pdf', OWN + '-anual-2025.pdf', 'NOTA.txt'])
    assert.ok(zipTxt.includes(nombre), 'el ZIP trae ' + nombre);
  assert.deepEqual(paquete.json.faltan, [], 'no falta ninguna pieza');
  assert.equal(paquete.json.incluidas.length, 3, 'las tres piezas viajan');
  const registro = await h.call('GET', '/api/registro');
  assert.ok(JSON.stringify(registro.json).includes('Paquete para el banco de ' + OWN),
    'el paquete quedó asentado en el Registro');
  /* Su «Enviar»: la clase nueva del conjunto cerrado. */
  const mailsAntes = h.mails.length;
  const enviado = await h.call('POST', '/api/enviar', { para: 'banco@test.mx',
    asunto: 'PacoSAT · Paquete para el banco · ' + OWN, clase: 'paquete-banco', rfc: OWN });
  assert.equal(enviado.status, 200, 'la clase «paquete-banco» se admite en /api/enviar: ' + JSON.stringify(enviado.json));
  assert.equal(h.mails.length, mailsAntes + 1, 'salió un correo');
  const adjunto = (h.mails[h.mails.length - 1].attachments || [])[0];
  assert.equal(adjunto?.filename, OWN + '-paquete-banco.zip', 'con el ZIP del paquete adjunto');
  console.log('OK 2.4.0·WC3a (19a) — paquete completo: tres nombres canónicos, Registro y Enviar por su clase.');

  /* ===== (19) Con una pieza ausente: las dos y su nota ===== */
  const paqueteOtro = await h.call('POST', '/api/paquete-banco240', { rfc: OTRO });
  assert.equal(paqueteOtro.status, 200);
  assert.deepEqual(paqueteOtro.json.faltan, ['Opinión de cumplimiento'], 'la Opinión es la que falta y se dice');
  assert.equal(paqueteOtro.json.incluidas.length, 2, 'viajan las dos que hay');
  const zipOtro = Buffer.from(paqueteOtro.json.content, 'base64').toString('latin1');
  assert.ok(zipOtro.includes(OTRO + '-constancia.pdf') && zipOtro.includes(OTRO + '-anual-2024.pdf'),
    'el ZIP trae la constancia y la anual de 2024');
  assert.ok(!zipOtro.includes(OTRO + '-opinion.pdf'), 'y NO trae una opinión que no consta');
  assert.ok(zipOtro.includes('No consta archivado'), 'la NOTA dentro del ZIP nombra lo que falta');
  console.log('OK 2.4.0·WC3a (19b) — con una ausente: las dos que hay y su nota dentro del ZIP.');

  /* ===== (19) Sin ninguna pieza: no se genera ===== */
  const estadoTerc = await h.call('GET', '/api/paquete-banco240?rfc=' + TERC);
  assert.equal(estadoTerc.json.alguna, false, 'el estado previo ya dice que no hay ninguna');
  const paqueteTerc = await h.call('POST', '/api/paquete-banco240', { rfc: TERC });
  assert.equal(paqueteTerc.status, 422, 'sin ninguna pieza no se genera un ZIP vacío');
  assert.match(paqueteTerc.json.error, /No hay ninguna pieza/);
  console.log('OK 2.4.0·WC3a (19c) — sin ninguna pieza: 422 en llano y ningún paquete vacío.');

  /* ===== Alcance del invitado: solo sus RFC ===== */
  assert.equal((await h.call('POST', '/api/guest/config',
    { password: 'invitado-wc3a', enabled: true, rfcs: [OWN] })).status, 200);
  const login = await h.call('POST', '/api/guest/login', { password: 'invitado-wc3a' });
  assert.ok(login.json.token, 'sesión de invitado emitida');
  const g = (method, path, body) => h.callAs(login.json.token, method, path, body);
  const gMiniPropia = await g('GET', '/api/miniatura200g?id=' + encodeURIComponent('pdf:zorro'));
  assert.equal(gMiniPropia.status, 200, 'el invitado sí recibe la miniatura de SU RFC');
  const gMiniAjena = await g('GET', '/api/miniatura200g?id=' + encodeURIComponent('pdf:zorro-otro'));
  assert.equal(gMiniAjena.status, 403, 'la miniatura de un RFC ajeno es 403');
  const gBusca = await g('GET', '/api/buscar-contenido240?q=' + encodeURIComponent('frase del zorro pardo'));
  assert.equal(gBusca.status, 200);
  assert.ok(gBusca.json.resultados.some(r => r.id === 'pdf:zorro'), 'su búsqueda encuentra lo suyo');
  assert.ok(!gBusca.json.resultados.some(r => r.id === 'pdf:zorro-otro'),
    'y NO encuentra el documento ajeno con la misma frase');
  const gBuscaAjena = await g('GET', '/api/buscar-contenido240?q=zorro&rfc=' + OTRO);
  assert.equal(gBuscaAjena.status, 403, 'pedir otro RFC a mano es 403');
  const gEstadoAjeno = await g('GET', '/api/paquete-banco240?rfc=' + OTRO);
  assert.equal(gEstadoAjeno.status, 403, 'el estado del paquete ajeno es 403');
  const gEstadoPropio = await g('GET', '/api/paquete-banco240?rfc=' + OWN);
  assert.equal(gEstadoPropio.status, 200, 'el de su RFC, 200');
  const gGenera = await g('POST', '/api/paquete-banco240', { rfc: OWN });
  assert.equal(gGenera.status, 403, 'generar el paquete es acción del titular: el invitado no puede');
  console.log('OK 2.4.0·WC3a (alcance) — el invitado: miniaturas, búsqueda y paquete solo de sus RFC.');
} finally { h.service.close(); rmSync(dir, { recursive: true, force: true }); }
console.log('OK ronda240documentos2 — WC3a (16, 17 y 19) fijada');
