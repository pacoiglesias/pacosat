import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOMParser } from '@xmldom/xmldom';
import { createPacoSATService } from './local-server.mjs';
import { chromium } from 'playwright-core';

/* ================================================================
   Ronda 2.9.10 · Respaldo partido del NAVEGADOR reconstruido.

   El defecto (probado en vivo por Paco, 18 nov): el
   splitBackupDialog de la 2.9.9 generaba UN .faro por cada
   combinación RFC·año contando cada factura DOS veces (bajo el
   emisor y bajo el receptor): 338 archivos en su iPhone.

   La pieza: espejo del backupSets del servidor —
   · reparto por dueño (ownerOf: el RFC de perfil presente como
     emisor o receptor; si ninguno, el del emisor): cada factura
     queda en UN SOLO grupo RFC·año;
   · empaquetado voraz bajo el techo del formato (100 MB): los
     grupos vecinos comparten parte mientras quepan; un grupo
     que solo ya supera el techo viaja solo;
   · cada parte es un respaldo v2 completo de su conjunto y se
     restaura por separado con el restaurador de siempre
     (decryptBackup + validateBackup, sin tocarlos);
   · nombres PacoSAT-<fecha>.faro (una parte) o
     PacoSAT-<fecha>-p<N>de<M>.faro (varias);
   · el diálogo dice la verdad y el Registro cuenta PARTES.

   Rojo→verde: contra la 2.9.9 esta suite falla en la primera
   aserción (splitBackupParts no existe y el diálogo promete un
   archivo por RFC y año); el conteo «viejo» se recalcula aquí
   con el algoritmo de la 2.9.9 para dejar constancia del
   estallido (352 archivos para esta semilla).
   ================================================================ */

const AQUI = dirname(fileURLToPath(import.meta.url));
const KEY = 'd'.repeat(64);
const OWN = 'AAA010101AAA';
const OWN2 = 'BBB020202BBA';
const TIME = Date.parse('2026-11-18T16:00:00Z');
const PW = 'respaldo-prueba-2910';
const TECHO = 200000; // techo de juguete, como el backupCeilingBytes: 300 de ronda1220b

let service = null;
const server = createServer((req, res) => { req.headers['x-pacosat-proxy'] = KEY; service.handle(req, res); });
await new Promise(r => server.listen(0, '127.0.0.1', r));
const ORIGIN = 'http://127.0.0.1:' + server.address().port;
const dir = mkdtempSync(join(tmpdir(), 'pacosat-2910-'));
const dbFile = join(dir, 'pacosat.sqlite');
const makeService = () => createPacoSATService({
  dbFile, html: readFileSync(join(AQUI, 'Faro-Fiscal.html'), 'utf8'),
  lazyParts: JSON.parse(readFileSync(join(AQUI, 'lazy.json'), 'utf8')),
  capacidades: JSON.parse(readFileSync(join(AQUI, 'capacidades.json'), 'utf8')),
  origin: ORIGIN, proxyKey: KEY, satDocRetryWaitMs: 5,
  makeConnector: () => ({ parser: DOMParser, connector: {
    request: async () => 'req-2910', check: async () => ({ status: 'pending', packages: [] }),
    download: async () => { throw new Error('sin paquetes'); } } }),
  makeMailer: () => ({ verify: async () => true, sendMail: async () => ({ messageId: 'm1' }) }),
  now: () => TIME });
service = makeService();
let token = '';
const raw = async (method, path, bodyText, extraHeaders = {}) => {
  const chunks = []; if (bodyText) chunks.push(Buffer.from(String(bodyText)));
  const req = Readable.from(chunks); req.method = method; req.url = path;
  req.headers = { host: new URL(ORIGIN).host, origin: ORIGIN, 'x-pacosat-proxy': KEY, ...extraHeaders };
  let status = 0; const headers = {}; let text = '';
  const res = { writeHead(c, h) { status = c; if (h) Object.assign(headers, h); },
    setHeader(k, v) { headers[k] = v; }, getHeader(k) { return headers[k]; },
    end(ch) { if (ch) text += Buffer.isBuffer(ch) ? ch.toString('latin1') : ch; } };
  await service.handle(req, res); return { status, text, headers };
};
const call = async (method, path, body) => {
  if (!token) { const home = await raw('GET', '/'); token = /[0-9a-f]{64}/.exec(home.text)?.[0] || ''; }
  const r = await raw(method, path, body === undefined ? undefined : JSON.stringify(body), { 'x-pacosat-token': token });
  let json = null; try { json = JSON.parse(r.text); } catch { /* binario */ }
  return { status: r.status, json, text: r.text };
};
await call('POST', '/api/storage', { batch: { people: [{ id: OWN, name: 'Empresa de Prueba, S.A.' },
  { id: OWN2, name: 'Segunda Empresa, S.A.' }] } });

/* ---------- Semilla: el expediente sintético (forma snapshot) ---------- */
const xmlCfdi = ({ uuid, fecha, emisor, receptor, descripcion = 'Servicio' }) => {
  const sub = '100.00', tax = '16.00';
  return `<?xml version="1.0" encoding="UTF-8"?>\n<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital" Version="4.0" Fecha="${fecha}" SubTotal="${sub}" Moneda="MXN" Total="116.00" TipoDeComprobante="I" MetodoPago="PPD" FormaPago="99" LugarExpedicion="72000">\n<cfdi:Emisor Rfc="${emisor}" Nombre="EMISOR SA" RegimenFiscal="601"/>\n<cfdi:Receptor Rfc="${receptor}" Nombre="RECEPTOR SA" DomicilioFiscalReceptor="72000" RegimenFiscalReceptor="601" UsoCFDI="G03"/>\n<cfdi:Conceptos><cfdi:Concepto ClaveProdServ="01010101" Cantidad="1" ClaveUnidad="H87" Descripcion="${descripcion}" ValorUnitario="${sub}" Importe="${sub}" ObjetoImp="02"><cfdi:Impuestos><cfdi:Traslados><cfdi:Traslado Base="${sub}" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="${tax}"/></cfdi:Traslados></cfdi:Impuestos></cfdi:Concepto></cfdi:Conceptos>\n<cfdi:Impuestos TotalImpuestosTrasladados="${tax}"><cfdi:Traslados><cfdi:Traslado Base="${sub}" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="${tax}"/></cfdi:Traslados></cfdi:Impuestos>\n<cfdi:Complemento><tfd:TimbreFiscalDigital Version="1.1" UUID="${uuid}" FechaTimbrado="${fecha}" RfcProvCertif="SAT970701NN3" SelloCFD="AAAA" NoCertificadoSAT="00001000000500000001" SelloSAT="BBBB"/></cfdi:Complemento>\n</cfdi:Comprobante>`;
};
const uuidDe = n => '29100000-0000-4000-8000-' + String(n).padStart(12, '0');
const contraparte = i => 'CP' + String.fromCharCode(65 + (i % 26)) + String.fromCharCode(65 + Math.floor(i / 26)) +
  '010101' + String(i).padStart(3, '0');
const b64 = texto => Buffer.from(texto, 'utf8').toString('base64');

const YEARS = [2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026];
const full = { version: 2,
  people: [{ id: OWN, name: 'Empresa de Prueba, S.A.' }, { id: OWN2, name: 'Segunda Empresa, S.A.' }],
  invoices: [], documents: [], files: [], activity: [
    { id: 'act-2910-1', name: 'Importación sembrada', date: '2026-11-01', added: 497, duplicates: 0, review: 0 }] };
let nUuid = 0;
const meteFactura = (emisor, receptor, year, descripcion) => {
  const uuid = uuidDe(++nUuid);
  const fecha = year + '-05-02T10:00:00';
  full.invoices.push({ id: uuid, date: fecha, from: { rfc: emisor }, to: { rfc: receptor } });
  full.files.push({ id: 'xml:' + uuid, content: b64(xmlCfdi({ uuid, fecha, emisor, receptor, descripcion })) });
};
/* Recibidos: 42 contrapartes × 8 años hacia OWN (336 facturas). */
for (let i = 0; i < 42; i++) for (const year of YEARS) meteFactura(contraparte(i), OWN, year);
/* Recibidos hacia el segundo perfil: 10 contrapartes × 8 años (80). */
for (let i = 0; i < 10; i++) for (const year of YEARS) meteFactura(contraparte(i), OWN2, year);
/* Emitidos: OWN hacia las 6 primeras contrapartes × 8 años (48) y
   OWN2 hacia las 4 primeras × 8 años (32). */
for (let i = 0; i < 6; i++) for (const year of YEARS) meteFactura(OWN, contraparte(i), year);
for (let i = 0; i < 4; i++) for (const year of YEARS) meteFactura(OWN2, contraparte(i), year);
/* Un grupo gigante: el grupo OWN2·2024 recibe además una factura
   cuyo XML por sí solo supera el techo: el grupo viaja solo. */
const GIG = 'GIG010101AAA';
meteFactura(OWN2, OWN, 2024, 'X'.repeat(200000));
/* Documentos: con grupo de facturas, sin grupo (año 2015) y del segundo perfil. */
const meteDoc = (rfc, fecha, kind, n) => {
  const id = 'pdf:29100000-0000-4000-8000-' + String(9000 + n).padStart(12, '0');
  full.documents.push({ id, rfc, kind, date: fecha, period: '', name: kind + ' ' + fecha });
  full.files.push({ id, content: b64('%PDF-1.4 documento de juguete ' + n) });
};
meteDoc(OWN, '2023-03-01', 'Constancia / CIF', 1);
meteDoc(OWN, '2024-06-15', 'Acuse', 2);
meteDoc(OWN, '2015-01-20', 'Constancia / CIF', 3);
meteDoc(OWN2, '2025-09-09', 'Opinión de cumplimiento', 4);

/* El conteo de la 2.9.9 (su algoritmo, tal cual): un archivo por
   combinación RFC·año contando cada factura bajo emisor Y receptor. */
const conteoViejo = (() => {
  const combos = new Set();
  for (const row of full.invoices)
    for (const rfc of new Set([row.from?.rfc, row.to?.rfc]))
      if (rfc) combos.add(rfc + '|' + String(row.date || '').slice(0, 4));
  return combos.size;
})();

/* El empaquetado esperado, calculado a mano desde la regla:
   grupos ordenados por clave (dueño|año; documentos por su RFC y
   el año de su fecha), rodajas con sus archivos, y voraz bajo el
   techo midiendo el JSON de la parte armada (personas de sus
   grupos; la actividad solo en la primera parte). */
const esperado = (() => {
  const size = value => Buffer.byteLength(JSON.stringify(value));
  const perfiles = new Set(full.people.map(p => p.id));
  const ownerOf = inv => perfiles.has(inv?.from?.rfc) ? inv.from.rfc
    : perfiles.has(inv?.to?.rfc) ? inv.to.rfc : (inv?.from?.rfc || inv?.to?.rfc || 'SIN-RFC');
  const grupos = new Map();
  const grupo = key => { if (!grupos.has(key)) grupos.set(key, { invoices: [], documents: [] }); return grupos.get(key); };
  for (const inv of full.invoices) grupo(ownerOf(inv) + '|' + String(inv?.date || '').slice(0, 4)).invoices.push(inv);
  for (const doc of full.documents) grupo(doc.rfc + '|' + String(doc.date || '').slice(0, 4)).documents.push(doc);
  const porId = new Map(full.files.map(f => [f.id, f]));
  const usados = new Set();
  const rodajas = [];
  for (const [key, g] of [...grupos.entries()].sort()) {
    const files = [];
    const toma = id => { const f = porId.get(id); if (f && !usados.has(f.id)) { usados.add(f.id); files.push(f); } };
    for (const inv of g.invoices) toma('xml:' + inv.id);
    for (const doc of g.documents) toma(doc.id);
    rodajas.push({ key, invoices: g.invoices, documents: g.documents, files });
  }
  const arma = (lista, actividad) => {
    const ids = new Set();
    for (const r of lista) {
      ids.add(r.key.split('|')[0]);
      for (const inv of r.invoices) { if (inv?.from?.rfc) ids.add(inv.from.rfc); if (inv?.to?.rfc) ids.add(inv.to.rfc); }
      for (const doc of r.documents) ids.add(doc.rfc);
    }
    return { version: 2, people: full.people.filter(p => ids.has(p.id)),
      invoices: lista.flatMap(r => r.invoices), documents: lista.flatMap(r => r.documents),
      files: lista.flatMap(r => r.files), activity: actividad };
  };
  const partes = [];
  let actual = [], datos = null;
  for (const rodaja of rodajas) {
    const actividad = partes.length === 0 ? full.activity : [];
    const candidato = arma([...actual, rodaja], actividad);
    if (actual.length && size(candidato) > TECHO) { partes.push(datos); actual = [rodaja]; datos = arma(actual, []); }
    else { actual = [...actual, rodaja]; datos = candidato; }
  }
  if (actual.length) partes.push(datos);
  return partes;
})();

const executablePath = [join(homedir(), '.cache/ms-playwright/chromium-1248/chrome-linux64/chrome'),
  join(homedir(), '.cache/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell')]
  .find(p => existsSync(p));
if (!executablePath && process.env.CI) {
  console.log('OMITIDA EN CI: sin Chromium de Playwright en este entorno; la prueba de navegador real corre en la máquina de Paco (diseño e872570).');
  process.exit(0);
}
assert.ok(executablePath, 'Chromium de Playwright disponible');
const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(ORIGIN + '/', { waitUntil: 'load' });
  await page.waitForFunction(() => typeof navigate === 'function' && typeof satToken !== 'undefined' && Boolean(satToken),
    null, { timeout: 15000 });

  /* ===== 1 · La función nueva existe y el conteo viejo estalla ===== */
  const hayFuncion = await page.evaluate(() => typeof splitBackupParts === 'function' && typeof splitBackupFileName === 'function');
  assert.ok(hayFuncion, 'splitBackupParts y splitBackupFileName existen en el cliente (en la 2.9.9: no)');
  assert.equal(conteoViejo, 352, 'la semilla reproduce el estallido: el algoritmo viejo haría 352 archivos');
  assert.ok(esperado.length >= 5 && esperado.length < conteoViejo / 10,
    'el empaquetado esperado (' + esperado.length + ' partes) es otra magnitud que el estallido (' + conteoViejo + ')');

  /* ===== 2 · El reparto y el empaquetado, parte a parte ===== */
  const partes = await page.evaluate(({ full, TECHO }) => splitBackupParts(full, TECHO), { full, TECHO });
  assert.equal(partes.length, esperado.length, 'nº de partes == el del empaquetado calculado a mano');
  const idsPorParte = partes.map(p => p.invoices.map(i => i.id).sort());
  const idsEsperados = esperado.map(p => p.invoices.map(i => i.id).sort());
  assert.deepEqual(idsPorParte, idsEsperados, 'cada parte lleva exactamente las facturas del empaquetado esperado');
  const todos = partes.flatMap(p => p.invoices.map(i => i.id));
  assert.equal(todos.length, full.invoices.length, 'ninguna factura se pierde');
  assert.equal(new Set(todos).size, todos.length, 'ninguna factura se duplica: cada una en UNA sola parte');
  const docsTodos = partes.flatMap(p => p.documents.map(d => d.id));
  assert.deepEqual(docsTodos.sort(), full.documents.map(d => d.id).sort(), 'cada documento en exactamente una parte');
  const filesTodos = partes.flatMap(p => p.files.map(f => f.id));
  assert.deepEqual(filesTodos.sort(), full.files.map(f => f.id).sort(), 'cada archivo en exactamente una parte');
  const size = v => Buffer.byteLength(JSON.stringify(v));
  /* El grupo gigante es OWN2·2024 (la factura enorme es de OWN2 a
     OWN y el dueño manda el emisor de perfil): sus facturas son
     las del grupo, calculadas aquí desde la regla de dueño. */
  const perfilesSet = new Set(full.people.map(p => p.id));
  const ownerDe = inv => perfilesSet.has(inv?.from?.rfc) ? inv.from.rfc
    : perfilesSet.has(inv?.to?.rfc) ? inv.to.rfc : inv?.from?.rfc;
  const idsGrupoGigante = new Set(full.invoices
    .filter(i => ownerDe(i) + '|' + String(i.date).slice(0, 4) === OWN2 + '|2024').map(i => i.id));
  const gigante = full.invoices[full.invoices.length - 1];
  assert.ok(idsGrupoGigante.has(gigante.id) && idsGrupoGigante.size > 1, 'el grupo gigante quedó sembrado');
  for (const parte of partes) {
    const llevaGigante = parte.invoices.some(i => i.id === gigante.id);
    if (llevaGigante) assert.deepEqual(parte.invoices.map(i => i.id).sort(), [...idsGrupoGigante].sort(),
      'el grupo que solo supera el techo viaja solo, entero');
    else assert.ok(size(parte) <= TECHO, 'ninguna parte supera el techo salvo el grupo gigante');
  }
  const conActividad = partes.filter(p => (p.activity || []).length > 0);
  assert.equal(conActividad.length, 1, 'la actividad viaja en una sola parte');
  assert.deepEqual(conActividad[0].activity, full.activity, 'la actividad viaja entera');

  /* ===== 3 · Cada parte se descifra y se restaura con el restaurador de siempre ===== */
  const restaurado = await page.evaluate(async ({ partes, PW }) => {
    const salida = { invoices: [], documents: [], activity: 0, personas: new Set() };
    for (const parte of partes) {
      const blob = await encryptBackup(parte, PW);
      const datos = await decryptBackup(blob, PW);
      const contents = await validateBackup(datos);
      salida.invoices.push(...contents.invoices.map(i => i.id));
      salida.documents.push(...contents.documents.map(d => d.id));
      salida.activity += contents.activity.length;
      for (const p of contents.people) salida.personas.add(p.id);
    }
    return { invoices: salida.invoices, documents: salida.documents, activity: salida.activity, personas: [...salida.personas] };
  }, { partes, PW });
  assert.deepEqual(restaurado.invoices.sort(), full.invoices.map(i => i.id).sort(),
    'al reunir las partes restauradas el expediente queda íntegro (facturas)');
  assert.deepEqual(restaurado.documents.sort(), full.documents.map(d => d.id).sort(),
    'al reunir las partes restauradas el expediente queda íntegro (documentos)');
  assert.equal(restaurado.activity, full.activity.length, 'la actividad se restaura una sola vez');
  assert.ok(restaurado.personas.includes(OWN) && restaurado.personas.includes(OWN2), 'los perfiles se restauran');

  /* ===== 4 · Expediente pequeño: UNA sola parte, sin sufijo ===== */
  const pequeno = { version: 2, people: full.people,
    invoices: full.invoices.slice(0, 3), documents: full.documents.slice(0, 1),
    files: full.files.filter(f => ['xml:' + full.invoices[0].id, 'xml:' + full.invoices[1].id,
      'xml:' + full.invoices[2].id, full.documents[0].id].includes(f.id)), activity: [] };
  const unaParte = await page.evaluate(full => splitBackupParts(full), pequeno);
  assert.equal(unaParte.length, 1, 'bajo el techo sale UNA sola parte');
  assert.equal(unaParte[0].invoices.length, 3, 'la parte única lleva todo el expediente pequeño');
  const nombres = await page.evaluate(() => [splitBackupFileName('2026-11-18', 0, 1),
    splitBackupFileName('2026-11-18', 0, 3), splitBackupFileName('2026-11-18', 2, 3)]);
  assert.deepEqual(nombres, ['PacoSAT-2026-11-18.faro', 'PacoSAT-2026-11-18-p1de3.faro', 'PacoSAT-2026-11-18-p3de3.faro'],
    'los nombres siguen el patrón del servidor: sin sufijo si es una, -p<N>de<M> si son varias');

  /* ===== 5 · El diálogo dice la verdad ===== */
  await page.evaluate(() => splitBackupDialog());
  await page.waitForFunction(() => document.getElementById('dialog')?.open &&
    document.getElementById('dialogTitle')?.textContent.length > 0, null, { timeout: 10000 });
  const dialogo = await page.evaluate(() => ({
    titulo: document.getElementById('dialogTitle').textContent,
    nota: document.querySelector('#fields .news-note')?.textContent || '',
    boton: document.getElementById('save').textContent }));
  assert.equal(dialogo.titulo, 'Respaldo partido', 'el diálogo se titula «Respaldo partido»');
  assert.ok(dialogo.nota.includes('UN solo archivo') && dialogo.nota.includes('100 MB'),
    'la nota dice la verdad: normalmente UN archivo; partes de hasta 100 MB solo si se pasa');
  assert.ok(!dialogo.nota.includes('por cada RFC y año con facturas'),
    'la nota ya NO promete un archivo por RFC y año');
  assert.equal(dialogo.boton, 'Crear respaldo partido', 'el botón del diálogo conserva su nombre');
  await page.evaluate(() => document.getElementById('dialog').close());

  console.log('OK 2.9.10 — Respaldo partido: ' + conteoViejo + ' archivos viejos → ' + partes.length +
    ' partes empaquetadas; cada factura en una sola parte; restauración íntegra por partes.');
} finally {
  await browser.close();
  server.close();
  await service.close();
}
