import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createPacoSATService } from './local-server.mjs';

/* Mapa anual de declaraciones (1.17.0) — propuesta P13 de la
   auditoría del 10 nov 2026, su mitad de PANTALLA (la de papel
   salió en la capa de salidas de la 1.14.0):
   (1) El servidor calcula el mapa desde los registros reales de
       declaraciones (view.mapa): cada mes con su estado en
       palabras — «presentada» con fecha y nº de operación,
       «pendiente» (cerró el mes y el plazo sigue abierto),
       «vencida» (pasó el día 17 del mes siguiente sin constancia)
       y «no-toca» — y la anual con su 31 de marzo.
   (2) El resumen cuenta bien: «X de 12» sale de las mismas
       celdas que se pintan, y las cuatro cuentas suman 12.
   (3) El contrato viejo no se mueve: view.mensuales sigue
       diciendo recuperada / sin-recuperar / aun-no-toca (lo leen
       la tarjeta de Hoy y el PDF en papel) y el mapa en papel se
       sigue generando igual.
   (4) La pantalla pinta el mapa: resumen, alerta de vencidas,
       rejilla con semáforo y detalle del mes con su gesto de
       recuperación acotado al periodo.
   Las pruebas JUZGAN EL MAPA RESULTANTE contra datos de juguete
   con el reloj fijado, incluidos los bordes del día límite. */

const origin = 'http://127.0.0.1:43741';
let time = Date.parse('2026-06-10T12:00:00Z');
const MFI = 'MFI6212158B4';

function harness(service) {
  let token;
  const call = async (path, data) => {
    const headers = { host: new URL(origin).host, origin, 'x-pacosat-token': token, 'x-pacosat-proxy': 'proxy-salidas' };
    const req = Object.assign(Readable.from(data === undefined ? [] : [Buffer.from(JSON.stringify(data))]), {
      url: path, method: data === undefined ? 'GET' : 'POST', headers });
    let response;
    const res = { setHeader() {}, writeHead(status) { this.status = status; this.headersSent = true; },
      end(content) { response = new Response(content, { status: this.status }); } };
    await service.handle(req, res);
    return response;
  };
  return { call, async login() {
    const page = await (await call('/')).text();
    token = page.match(/meta name="pacosat-token" content="([^"]+)"/)?.[1];
    assert.ok(token, 'token del servicio de juguete');
  } };
}
const makeService = dbFile => createPacoSATService({ dbFile, html: '<!--PACOSAT_TOKEN-->', origin,
  proxyKey: 'proxy-salidas', now: () => time,
  makeConnector: async () => ({ connector: {
    request: async () => 'req-juguete',
    check: async () => ({ status: 'pending', packages: [] }),
    download: async () => { throw new Error('sin paquetes de juguete'); } } }),
  makeMailer: () => ({ verify: async () => true, sendMail: async () => ({ messageId: 'm-juguete' }) }) });

/* ===== Semilla: esquema, perfil y declaraciones de juguete ===== */
const dir = mkdtempSync(join(tmpdir(), 'pacosat-mapa-'));
const dbFile = join(dir, 'pacosat.sqlite');
{
  const service = makeService(dbFile);
  service.close();
}
{
  const db = new DatabaseSync(dbFile);
  db.prepare('INSERT INTO profiles(rfc, minutes, days, direction, nextRun, error) VALUES (?,?,?,?,?,?)')
    .run(MFI, 1440, 30, 'both', 0, '');
  const decl = db.prepare("INSERT INTO declaraciones(id, rfc, tipo, clase, ejercicio, periodo, fechaPresentacion, operacion, fileId, source, created) VALUES (?,?,?,?,?,?,?,?,?,?,?)");
  /* 2026: enero completo, febrero solo declaración, marzo solo
     acuse; el resto, sin recuperar (el mapa dirá lo que toca). */
  decl.run('d1', MFI, 'mensual', 'declaracion', 2026, '2026-01', '2026-02-16', '202602160000000001', 'decl-file-1', 'prueba', time);
  decl.run('d2', MFI, 'mensual', 'acuse', 2026, '2026-01', '2026-02-16', '202602160000000001', 'decl-file-2', 'prueba', time);
  decl.run('d3', MFI, 'mensual', 'declaracion', 2026, '2026-02', '2026-03-17', '202603170000000002', 'decl-file-3', 'prueba', time);
  decl.run('d4', MFI, 'mensual', 'acuse', 2026, '2026-03', '2026-04-16', '202604160000000003', 'decl-file-4', 'prueba', time);
  /* La anual de 2024, presentada el 28 de marzo de 2025. */
  decl.run('d5', MFI, 'anual', 'declaracion', 2024, '2024', '2025-03-28', '202503280000000009', 'decl-file-5', 'prueba', time);
  decl.run('d6', MFI, 'anual', 'acuse', 2024, '2024', '2025-03-28', '202503280000000009', 'decl-file-6', 'prueba', time);
  db.close();
}

const service = makeService(dbFile);
const { call, login } = harness(service);
await login();
const vista = async ejercicio => {
  const res = await call('/api/declaraciones?rfc=' + MFI + '&ejercicio=' + ejercicio);
  assert.equal(res.status, 200, 'el overview responde 200');
  return res.json();
};

/* ===== (1)+(2) El mapa del ejercicio en curso (hoy: 10 jun 2026) ===== */
{
  const view = await vista(2026);
  assert.ok(view.mapa, 'el overview trae el mapa');
  assert.equal(view.mapa.meses.length, 12, 'el mapa trae los 12 meses');
  assert.deepEqual(view.mapa.meses.map(mes => mes.estado),
    ['presentada', 'presentada', 'presentada', 'sin-recuperar', 'pendiente',
     'no-toca', 'no-toca', 'no-toca', 'no-toca', 'no-toca', 'no-toca', 'no-toca'],
    'estados por mes con el reloj a 10 de junio de 2026');
  const [ene, , mar, abr, may, , , , , , , dic] = view.mapa.meses;
  assert.equal(ene.fechaPresentacion, '2026-02-16', 'enero: su fecha de presentación');
  assert.equal(ene.operacion, '202602160000000001', 'enero: su nº de operación');
  assert.equal(ene.limite, '2026-02-17', 'enero vencía el 17 de febrero');
  assert.equal(ene.declaracion, true); assert.equal(ene.acuse, true);
  assert.equal(mar.declaracion, false, 'marzo: la declaración no consta…');
  assert.equal(mar.acuse, true, '…pero su acuse sí: presentada igualmente');
  assert.equal(mar.estado, 'presentada', 'con solo el acuse, el mes consta presentado');
  assert.equal(mar.operacion, '202604160000000003', 'el nº de operación sale del acuse');
  assert.equal(abr.limite, '2026-05-17', 'abril vencía el 17 de mayo');
  assert.equal(may.limite, '2026-06-17', 'mayo vence el 17 de junio: aún pendiente');
  assert.equal(dic.limite, '2027-01-17', 'diciembre vence el 17 de enero del año siguiente');
  /* 1.22.0 (auditoría N11): el estado tras el límite se llama
     «sin-recuperar» — no consta recuperada ≠ no presentada — y
     el resumen gana la cuenta de «pagadas sin acuse» (pieza 11). */
  assert.deepEqual(view.mapa.resumen, { presentadas: 3, pendientes: 1, sinRecuperar: 1, pagadasSinAcuse: 0, noToca: 7 },
    'el resumen: 3 de 12 presentados, 1 pendiente, 1 sin recuperar');
  const r = view.mapa.resumen;
  assert.equal(r.presentadas + r.pendientes + r.sinRecuperar + r.pagadasSinAcuse + r.noToca, 12, 'las cuentas suman 12');
  assert.equal(view.mapa.anual.estado, 'no-toca', 'la anual de 2026 aún no toca');
  assert.equal(view.mapa.anual.limite, '2027-03-31', 'la anual vence el 31 de marzo de 2027');
  console.log('OK 1.17.0: mapa 2026 — estados por mes, fechas, operaciones y el «3 de 12» del resumen.');
}

/* ===== El borde del día límite: el 17 aún es pendiente ===== */
{
  time = Date.parse('2026-05-17T12:00:00Z');
  let view = await vista(2026);
  assert.equal(view.mapa.meses[3].estado, 'pendiente', 'el día 17 de mayo, abril aún está en plazo');
  assert.equal(view.mapa.resumen.sinRecuperar, 0, 'sin «sin recuperar» el día del límite');
  time = Date.parse('2026-05-18T12:00:00Z');
  view = await vista(2026);
  assert.equal(view.mapa.meses[3].estado, 'sin-recuperar', 'el 18 de mayo, abril consta sin recuperar (no «vencida»: pudo presentarse por otra vía)');
  time = Date.parse('2026-06-10T12:00:00Z');
  console.log('OK 1.17.0: el borde del plazo — pendiente el día 17, sin-recuperar el 18.');
}

/* ===== Ejercicios cerrados: 2025 sin nada y la anual de 2024 ===== */
{
  const view2025 = await vista(2025);
  assert.deepEqual(view2025.mapa.resumen, { presentadas: 0, pendientes: 0, sinRecuperar: 12, pagadasSinAcuse: 0, noToca: 0 },
    '2025 sin recuperar nada: los 12 meses sin recuperar');
  assert.equal(view2025.mapa.anual.estado, 'sin-recuperar', 'la anual de 2025 consta sin recuperar');
  assert.equal(view2025.mapa.anual.limite, '2026-03-31');
  const view2024 = await vista(2024);
  assert.equal(view2024.mapa.anual.estado, 'presentada', 'la anual de 2024 consta presentada');
  assert.equal(view2024.mapa.anual.fechaPresentacion, '2025-03-28');
  assert.equal(view2024.mapa.anual.operacion, '202503280000000009');
  console.log('OK 1.17.0: ejercicios cerrados — 2025 todo vencido y la anual de 2024 presentada con su operación.');
}

/* ===== (3) El contrato viejo y el papel no se mueven ===== */
{
  const view = await vista(2026);
  assert.equal(view.mensuales[0].estado, 'recuperada', 'la rejilla vieja sigue diciendo «recuperada»');
  assert.equal(view.mensuales[3].estado, 'sin-recuperar', '…y «sin-recuperar» donde no hay documentos');
  assert.equal(view.mensuales[5].estado, 'aun-no-toca', '…y «aun-no-toca» en el mes en curso');
  assert.equal(view.anual.estado, 'sin-recuperar');
  assert.equal(view.documentos.length, 4, 'los documentos del ejercicio siguen llegando');
  const res = await call('/api/salidas/pdf', { kind: 'declaraciones', rfc: MFI, year: '2026' });
  assert.equal(res.status, 200, 'el mapa en papel responde 200');
  const data = await res.json();
  const buffer = Buffer.from(data.content, 'base64');
  assert.equal(buffer.subarray(0, 4).toString(), '%PDF', 'el mapa en papel es un PDF');
  const doc = await getDocument({ data: new Uint8Array(buffer) }).promise;
  let texto = '';
  for (let i = 1; i <= doc.numPages; i++)
    texto += (await (await doc.getPage(i)).getTextContent()).items.map(item => item.str).join(' ') + '\n';
  assert.ok(texto.includes('Mapa anual de declaraciones'), 'el papel conserva su título');
  /* 1.18.0: el papel se alineó con la pantalla (la revisión de
     facilidad juzgó sus defectos: cabecera truncada, sin «X de
     12», sin color): ahora dice «Presentada» y cuenta «3 de 12».
     El contrato viejo que NO se mueve es view.mensuales (arriba). */
  assert.ok(texto.includes('Presentada'), 'el papel habla como la pantalla desde la 1.18.0');
  assert.ok(texto.includes('3 de 12 meses presentados'), 'el papel cuenta «X de 12»');
  console.log('OK 1.17.0: contrato viejo de view.mensuales intacto; el papel se alineó en la 1.18.0.');
}

/* ===== (4) La pantalla pinta el mapa ===== */
{
  const parte = readFileSync(join(import.meta.dirname, 'declaraciones-ui.part'), 'utf8');
  assert.ok(parte.includes('view.mapa'), 'la sección consume view.mapa');
  assert.ok(parte.includes("' de 12 meses presentados'"), 'el resumen «X de 12 meses presentados»');
  assert.ok(parte.includes('decl-alerta'), 'la alerta roja de vencidas');
  assert.ok(parte.includes("'decl-cell decl-mapa-' + mes.estado"), 'la celda del mes lleva la clase de su estado');
  const css = readFileSync(join(import.meta.dirname, 'polish.part'), 'utf8');
  assert.ok(css.includes('.decl-mapa-sin-recuperar{background:var(--danger-bg)'), 'el semáforo rojo de la celda sin recuperar vive en el CSS (1.22.0: antes «vencida»)');
  assert.ok(css.includes('.decl-mapa-presentada{background:var(--tint)'), '…y el verde de la presentada');
  assert.ok(parte.includes('Recuperar este mes del SAT'), 'el gesto del detalle recupera el mes');
  assert.ok(parte.includes('periodo'), 'la recuperación del detalle va acotada por periodo');
  assert.ok(parte.includes('pintarDetalle'), 'tocar un mes pinta su detalle');
  const html = readFileSync(join(import.meta.dirname, 'Faro-Fiscal.html'), 'utf8');
  /* Anexo 1.26.0: el sello sube con la Ronda Visual. */
  // 1.29.0: pineo de versión re-apuntado a la vigente, como en cada ronda.
  assert.ok(html.includes('"version":"1.29.0"'), 'el artefacto se sella con la versión vigente (1.29.0)');
  assert.ok(html.includes('Mapa de tu año fiscal') || html.includes('de 12 meses presentados'),
    'el mapa viaja dentro del artefacto construido');
  console.log('OK 1.17.0: la pantalla — resumen, alerta, semáforo, detalle y su gesto por periodo.');
}

service.close();
rmSync(dir, { recursive: true, force: true });
console.log('ronda1170.test: ok — el mapa anual juzgado contra datos de juguete (estados, bordes del plazo, «X de 12», contrato viejo y papel intactos).');
