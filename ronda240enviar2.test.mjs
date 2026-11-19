import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DOMParser } from '@xmldom/xmldom';
import { createPacoSATService } from './local-server.mjs';

/* ================================================================
   Ronda 2.4.0 · W2b — «Enviar» también para los reportes
   generados: la clase «reporte» de POST /api/enviar.
   (a) Por cada tipo del catálogo cerrado, la referencia válida
       regenera el reporte en el servidor y lo envía por el
       motor de correo de juguete, con el nombre canónico de
       adjunto — el mismo de su ruta de Descargar — y su
       asiento en el Registro.
   (b) El adjunto ES el artefacto de la ruta de descarga
       (bytes idénticos bajo el mismo reloj) en los tipos
       cotejados.
   (c) Tipo fuera del catálogo ⇒ 400 y no sale nada.
   (d) Parámetros que intentan colar una ruta ⇒ 400 (campo
       ruta, contraparte con «../», tipo con ruta, mes con
       ruta) y no sale nada.
   (e) Invitado ⇒ 403.
   (f) El artefacto construido (lazy «salidas») enseña los
       botones «Enviar» de esos reportes ya con su clase
       «reporte» y su tipo.
   ================================================================ */

const ORIGIN = 'https://pacosat.test';
const KEY = 'w'.repeat(64);
const OWN = 'AAA010101AAA';
const MANOFIL = 'MFI6212158B4';
const PROV1 = 'BBB010101BB1';
const UUID1 = '11111111-1111-4111-8111-111111111111';

/* DB en fichero: la preparación de pagos se siembra directa
   (patrón ronda200h: boot que crea el esquema, semilla, y el
   arnés de verdad sobre el mismo fichero). */
const dir = mkdtempSync(join(tmpdir(), 'pacosat-240enviar2-'));
const dbFile = join(dir, 'pacosat.sqlite');
{
  const boot = createPacoSATService({ dbFile, html: 'x', origin: ORIGIN, proxyKey: KEY });
  boot.close();
  const seed = new DatabaseSync(dbFile);
  seed.prepare("INSERT INTO pay_preparations(id,rfc,month,total,operaciones,payload,created) VALUES ('prep-240',?,'2026-10','100.00',1,?,?)")
    .run(OWN, JSON.stringify({ month: '2026-10', operaciones: 1, totalCents: 10000,
      bbva: { lines: [{ nombre: 'Proveedor Uno', rfc: PROV1, cuenta: '1111', totalCents: 10000 }] },
      interbancario: { lines: [] }, speiIndividual: { lines: [] } }), Date.parse('2026-11-01T15:00:00Z'));
  seed.close();
}

function makeHarness() {
  const clock = { t: Date.parse('2026-11-16T15:00:00Z') };
  const mails = [];
  const service = createPacoSATService({
    dbFile, html: '<html><head><!--PACOSAT_TOKEN--></head><body>prueba</body></html>',
    origin: ORIGIN, proxyKey: KEY, satDocRetryWaitMs: 5,
    extractText: async () => '',
    makeConnector: () => ({ parser: DOMParser, connector: {
      request: async () => 'req-240b', check: async () => ({ status: 'finished', packages: [] }),
      download: async () => { throw new Error('sin paquetes'); } } }),
    makeMailer: () => ({ verify: async () => true,
      sendMail: async mail => { mails.push(mail); return { messageId: 'm' + mails.length }; } }),
    now: () => clock.t });
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
  const callAs = async (otroToken, method, path, body) => {
    const r = await raw(method, path, body, { 'x-pacosat-token': otroToken });
    let json = null; try { json = JSON.parse(r.text); } catch { /* binario */ }
    return { status: r.status, json, text: r.text };
  };
  return { service, call, callAs, raw, mails, clock };
}
const unlock = async (h, rfc) => {
  const open = await h.call('POST', '/api/unlock', { rfc, minutes: 1440, days: 7,
    direction: 'both', password: 'simulated', certificate: 'YQ==', key: 'Yg==' });
  assert.equal(open.status, 200, 'unlock de ' + rfc);
};
const invoice = (id, date, from, to, total) => ({ id, date, kind: 'I', currency: 'MXN', total,
  from: { rfc: from, name: 'EMPRESA ' + from }, to: { rfc: to, name: 'EMPRESA ' + to },
  fiscal: { paymentMethod: 'PPD', transferred: [], withheld: [] } });

const h = makeHarness();
try {
  const mail = await h.call('POST', '/api/mail', { host: 'smtp.test', port: 465, security: 'ssl',
    from: 'avisos@pacosat.test', recipient: 'paco@test.mx', user: 'u', password: 'p' });
  assert.equal(mail.status, 200, 'correo configurado');
  const seed = await h.call('POST', '/api/storage', { batch: {
    people: [{ id: OWN, name: 'Empresa Propia SA' }, { id: MANOFIL, name: 'Mano Fil, S.A.' }],
    invoices: [
      invoice(UUID1, '2026-10-03', PROV1, OWN, '1160.00'),
      invoice('22222222-2222-4222-8222-222222222222', '2026-10-04', OWN, PROV1, '2320.00'),
      invoice('33333333-3333-4333-8333-333333333333', '2026-10-05', PROV1, MANOFIL, '580.00')] } });
  assert.equal(seed.status, 200, 'semilla: ' + seed.text);
  await unlock(h, OWN);
  await unlock(h, MANOFIL);
  /* El cierre guardado nace por su camino real: regenerar los
     informes del cierre guarda cierre.pdf en el expediente. */
  const regen = await h.call('POST', '/api/informes200g/regenerar', { rfc: OWN, month: '2026-10' });
  assert.equal(regen.status, 200, 'informes del cierre generados: ' + regen.text);

  /* ===== (a) el catálogo entero: referencia válida ⇒ envía
     con su nombre canónico de adjunto ===== */
  const CASOS = [
    [{ tipo: 'totales-pdf', rfc: OWN, year: 2026 }, 'totales-2026-' + OWN + '.pdf'],
    [{ tipo: 'totales-xlsx', rfc: OWN, year: '2026' }, 'totales-2026-' + OWN + '.xlsx'],
    [{ tipo: 'periodo-pdf', rfc: OWN, mes: '2026-10' }, 'periodo-2026-10-' + OWN + '.pdf'],
    [{ tipo: 'cierre-pdf', rfc: OWN, mes: '2026-10' }, 'cierre-2026-10-' + OWN + '.pdf'],
    [{ tipo: 'saldos-pdf', rfc: OWN }, 'saldos-' + OWN + '.pdf'],
    [{ tipo: 'contraparte-pdf', rfc: OWN, contraparte: PROV1 }, 'contraparte-' + PROV1 + '-' + OWN + '.pdf'],
    [{ tipo: 'declaraciones-pdf', rfc: OWN, year: 2026 }, 'declaraciones-2026-' + OWN + '.pdf'],
    [{ tipo: 'declaraciones-xlsx', rfc: OWN, year: 2026 }, 'declaraciones-2026-' + OWN + '.xlsx'],
    [{ tipo: 'avisos-pdf', rfc: OWN }, 'avisos-' + OWN + '.pdf'],
    [{ tipo: 'avisos-xlsx', rfc: OWN }, 'avisos-' + OWN + '.xlsx'],
    [{ tipo: 'dinero-xlsx', rfc: OWN, mes: '2026-10' }, 'dinero-2026-10-' + OWN + '.xlsx'],
    [{ tipo: 'dinero-xlsx', rfc: OWN }, 'dinero-' + OWN + '.xlsx'],
    [{ tipo: 'facturas-xlsx', rfc: OWN, mes: '2026-10' }, 'Facturas octubre de 2026 — ' + OWN + '.xlsx'],
    [{ tipo: 'facturas-xlsx', rfc: OWN }, 'Facturas completas — ' + OWN + '.xlsx'],
    [{ tipo: 'saldos-cobrar-xlsx', rfc: OWN }, 'saldos-por-cobrar-' + OWN + '.xlsx'],
    [{ tipo: 'saldos-pagar-xlsx', rfc: OWN }, 'saldos-por-pagar-' + OWN + '.xlsx'],
    [{ tipo: 'complementos-xlsx', rfc: OWN }, 'complementos-de-pago-' + OWN + '.xlsx'],
    [{ tipo: 'listados-xlsx' }, 'listados-contrapartes.xlsx'],
    [{ tipo: 'pagos-xlsx', rfc: OWN }, 'pagos-al-banco-' + OWN + '.xlsx'],
    [{ tipo: 'zip-periodo', rfc: OWN, mes: '2026-10' }, 'pacosat-2026-10-' + OWN + '.zip'],
    [{ tipo: 'zip-cierre', rfc: OWN, mes: '2026-10' }, 'pacosat-cierre-2026-10-' + OWN + '.zip'],
    [{ tipo: 'zip-rfc', rfc: OWN, year: '2026' }, 'pacosat-' + OWN + '-2026.zip'],
    [{ tipo: 'zip-rfc', rfc: OWN }, 'pacosat-' + OWN + '.zip'],
    [{ tipo: 'zip-seleccion', rfc: OWN, ids: [UUID1] }, 'pacosat-seleccion-' + OWN + '.zip'],
    [{ tipo: 'conciliacion-pdf', rfc: OWN, mes: '2026-10' }, 'conciliacion-' + OWN + '-2026-10.pdf'],
    [{ tipo: 'conciliacion-xlsx', rfc: OWN, mes: '2026-10' }, 'conciliacion-' + OWN + '-2026-10.xlsx'],
    [{ tipo: 'conciliacion-pdf', mes: '2026-10' }, 'conciliacion-todas-las-cuentas-2026-10.pdf'],
    [{ tipo: 'manofil-pdf', mes: '2026-10' }, 'reporte-manofil-2026-10.pdf'],
    [{ tipo: 'manofil-xlsx', mes: '2026-10' }, 'reporte-manofil-2026-10.xlsx'],
    [{ tipo: 'manofil-pdf', desde: '2026-10-01', hasta: '2026-10-31' }, 'reporte-manofil-2026-10-01_a_2026-10-31.pdf'],
    [{ tipo: 'manofil-pdf', rfc: MANOFIL, mes: '2026-10' }, 'reporte-manofil-2026-10.pdf'],
    [{ tipo: 'polizas-xlsx', rfc: OWN, mes: '2026-10' }, 'polizas-' + OWN + '-2026-10.xlsx'],
    [{ tipo: 'cierre-guardado-pdf', rfc: OWN, mes: '2026-10' }, 'cierre-2026-10-' + OWN + '.pdf']
  ];
  for (const [ref, filename] of CASOS) {
    const antes = h.mails.length;
    const r = await h.call('POST', '/api/enviar',
      { para: 'destino@ejemplo.mx', asunto: 'Tu reporte', clase: 'reporte', ...ref });
    assert.equal(r.status, 200, 'enviar ' + ref.tipo + ': ' + r.text);
    assert.equal(r.json.ok, true);
    assert.equal(h.mails.length, antes + 1, 'salió un correo para ' + ref.tipo);
    const adjunto = h.mails[h.mails.length - 1].attachments[0];
    assert.equal(adjunto.filename, filename,
      'el adjunto de ' + ref.tipo + ' lleva su nombre canónico (el de su Descargar)');
    assert.ok(Buffer.from(adjunto.content).length > 0, 'el adjunto de ' + ref.tipo + ' no va vacío');
  }
  const registro = (await h.call('GET', '/api/registro?limit=400')).json;
  assert.ok(JSON.stringify(registro).includes('enviado Reporte de Totales 2026 de ' + OWN + ' a destino@ejemplo.mx'),
    'asiento en el Registro del envío de un reporte, como en las demás clases');
  console.log('OK 2.4.0-W2b · (a) — el catálogo cerrado entero (33 referencias) regenera, envía y adjunta con su nombre canónico.');

  /* ===== (b) el adjunto ES el artefacto de su Descargar ===== */
  {
    const descarga = await h.call('POST', '/api/salidas/pdf', { kind: 'totales', rfc: OWN, year: 2026 });
    assert.equal(descarga.status, 200);
    const porCorreo = h.mails.find(m => m.attachments?.[0]?.filename === 'totales-2026-' + OWN + '.pdf');
    assert.ok(Buffer.from(porCorreo.attachments[0].content)
      .equals(Buffer.from(descarga.json.content, 'base64')),
      'totales-pdf: el adjunto del correo es byte a byte el PDF de salidas/pdf');
    const descargaPol = await h.call('POST', '/api/salidas200g/polizas', { rfc: OWN, month: '2026-10' });
    assert.equal(descargaPol.status, 200, 'la ruta de pólizas sigue sirviendo tras extraer su generador');
    assert.equal(descargaPol.json.name, 'polizas-' + OWN + '-2026-10.xlsx');
    const polCorreo = h.mails.find(m => m.attachments?.[0]?.filename === 'polizas-' + OWN + '-2026-10.xlsx');
    assert.ok(Buffer.from(polCorreo.attachments[0].content)
      .equals(Buffer.from(descargaPol.json.content, 'base64')),
      'polizas-xlsx: el adjunto del correo es byte a byte el Excel de salidas200g/polizas');
    console.log('OK 2.4.0-W2b · (b) — el adjunto regenerado es el mismo artefacto que sirve la descarga.');
  }

  /* ===== (c) tipo fuera del catálogo ⇒ 400, sin enviar ===== */
  {
    const antes = h.mails.length;
    for (const ref of [
      { tipo: 'inventado', rfc: OWN },
      { tipo: 'csv-del-mes', rfc: OWN, mes: '2026-10' },
      { tipo: '', rfc: OWN },
      { rfc: OWN }
    ]) {
      const r = await h.call('POST', '/api/enviar',
        { para: 'destino@ejemplo.mx', asunto: 'x', clase: 'reporte', ...ref });
      assert.equal(r.status, 400, 'tipo fuera del catálogo (' + (ref.tipo ?? 'sin tipo') + ') ⇒ 400');
    }
    const claseMala = await h.call('POST', '/api/enviar',
      { para: 'destino@ejemplo.mx', asunto: 'x', clase: 'reporte2', tipo: 'totales-pdf', rfc: OWN, year: 2026 });
    assert.equal(claseMala.status, 400, 'una clase que no es «reporte» no cuela por el tipo');
    assert.equal(h.mails.length, antes, 'ningún rechazo envió nada');
    console.log('OK 2.4.0-W2b · (c) — tipo fuera del catálogo ⇒ 400 y cero correos.');
  }

  /* ===== (d) parámetros que intentan colar una ruta ⇒ 400 ===== */
  {
    const antes = h.mails.length;
    const intentos = [
      { tipo: 'totales-pdf', rfc: OWN, year: 2026, ruta: '/etc/passwd' },
      { tipo: 'totales-pdf', rfc: OWN, year: 2026, path: '/etc/passwd' },
      { tipo: '../../etc/passwd', rfc: OWN },
      { tipo: 'contraparte-pdf', rfc: OWN, contraparte: '../../etc/passwd' },
      { tipo: 'periodo-pdf', rfc: OWN, mes: '../2026-10' },
      { tipo: 'periodo-pdf', rfc: OWN, mes: '2026-10', archivo: 'x.pdf' },
      { tipo: 'zip-seleccion', rfc: OWN, ids: ['../../etc/passwd'] },
      { tipo: 'manofil-pdf', rfc: OWN, mes: '2026-10' },
      { tipo: 'totales-pdf', rfc: 'XXX', year: 2026 }
    ];
    for (const ref of intentos) {
      const r = await h.call('POST', '/api/enviar',
        { para: 'destino@ejemplo.mx', asunto: 'x', clase: 'reporte', ...ref });
      assert.equal(r.status, 400, 'intento de ruta/parámetro inválido ⇒ 400: ' + JSON.stringify(ref));
    }
    /* Referencia bien formada pero sin artefacto: 404 honesto. */
    const sinCierre = await h.call('POST', '/api/enviar',
      { para: 'destino@ejemplo.mx', asunto: 'x', clase: 'reporte', tipo: 'cierre-guardado-pdf', rfc: OWN, mes: '2026-09' });
    assert.equal(sinCierre.status, 404, 'un cierre guardado que no existe ⇒ 404, no un adjunto inventado');
    const sinPerfil = await h.call('POST', '/api/enviar',
      { para: 'destino@ejemplo.mx', asunto: 'x', clase: 'reporte', tipo: 'totales-pdf', rfc: 'ZZZ010101ZZ1', year: 2026 });
    assert.equal(sinPerfil.status, 404, 'un RFC válido pero sin expediente ⇒ 404');
    assert.equal(h.mails.length, antes, 'ningún intento envió nada');
    console.log('OK 2.4.0-W2b · (d) — ninguna ruta se cuela por los parámetros; lo que no existe da 404 honesto.');
  }

  /* ===== (e) invitado ⇒ 403 ===== */
  {
    assert.equal((await h.call('POST', '/api/guest/config',
      { password: 'invitado-240b', enabled: true, rfcs: [OWN] })).status, 200);
    const login = await h.call('POST', '/api/guest/login', { password: 'invitado-240b' });
    assert.ok(login.json.token, 'sesión de invitado emitida');
    const antes = h.mails.length;
    const delInvitado = await h.callAs(login.json.token, 'POST', '/api/enviar',
      { para: 'destino@ejemplo.mx', asunto: 'x', clase: 'reporte', tipo: 'totales-pdf', rfc: OWN, year: 2026 });
    assert.equal(delInvitado.status, 403, 'el invitado no envía reportes: 403');
    assert.equal(h.mails.length, antes, 'el intento del invitado no envió nada');
    console.log('OK 2.4.0-W2b · (e) — invitado ⇒ 403.');
  }
} finally { h.service.close(); rmSync(dir, { recursive: true, force: true }); }

/* ===== (f) el artefacto construido enseña la clase «reporte» ===== */
{
  const lazy = JSON.parse(readFileSync(join(import.meta.dirname, 'lazy.json'), 'utf8'));
  const salidas = lazy.partes.salidas.source;
  for (const tipo of ['totales-pdf', 'periodo-pdf', 'declaraciones-pdf', 'saldos-pdf',
    'conciliacion-pdf', 'avisos-pdf', 'contraparte-pdf', 'cierre-pdf', 'pagos-xlsx',
    'polizas-xlsx', 'cierre-guardado-pdf', 'manofil-pdf'])
    assert.ok(salidas.includes("tipo: '" + tipo + "'"),
      'la parte de Salidas del artefacto cablea el tipo ' + tipo + ' en su botón «Enviar»');
  const conClase = (salidas.match(/clase: 'reporte'/g) || []).length;
  assert.ok(conClase >= 12, 'los botones «Enviar» de Salidas/Reportes llevan la clase «reporte» (' + conClase + ' referencias)');
  console.log('OK 2.4.0-W2b · (f) — el artefacto construido enseña los «Enviar» de los reportes con su clase «reporte».');
}

console.log('OK suite ronda240enviar2 completa');
