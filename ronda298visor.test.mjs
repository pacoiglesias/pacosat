import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { DOMParser } from '@xmldom/xmldom';
import { createPacoSATService } from './local-server.mjs';
import { chromium } from 'playwright-core';

/* ================================================================
   Ronda 2.9.8 · Pieza V — EL VISOR ABRE AL INSTANTE

   EL PROBLEMA (2.9.7 · D2 dejó el clic así): viewDocOnline hacía
   `await fetch('/api/miniatura200g…')` ANTES de abrir cualquier
   diálogo: el clic «Ver» esperaba una ida y vuelta de red entera
   aunque la primera página ya estuviera pre-generada al archivar.

   EL ARREGLO: al pulsar, el diálogo abre EN EL MISMO GESTO, sin
   ningún await previo, con su estado «cargando» honesto (título
   del documento y «Cargando la primera página…», la estructura
   del diálogo de previa sin imagen); la miniatura, al llegar, se
   pinta DENTRO de ese diálogo abierto; el PDF completo lo
   sustituye después como siempre (misma guarda). Con 404 de
   miniatura, el diálogo ya abierto lo dice en su nota y sigue
   al documento completo.

   MEDICIÓN (Chromium real + servidor real, miniatura retenida
   2.000 ms por interceptación de ruta en el navegador):
   (1) el diálogo es visible en el tiempo del gesto (< 300 ms)
       con la miniatura aún retenida;
   (2) la previa aparece al llegar, dentro del MISMO diálogo
       (el diálogo no se cierra ni se reabre: su elemento es el
       mismo y sigue abierto);
   (3) al llegar el PDF completo, la sustitución conserva el
       diálogo abierto con su iframe y sus botones de siempre;
   (4) sin miniatura (404, PDF ilegible): el diálogo abre igual
       al instante, su nota lo dice y termina en el visor
       completo.
   ================================================================ */

const AQUI = dirname(fileURLToPath(import.meta.url));
const KEY = 'c'.repeat(64);
const OWN = 'AAA010101AAA';

function pdfPaginas298(paginas) {
  const objs = []; let next = 3;
  const pageNums = [], contentNums = [];
  for (let i = 0; i < paginas.length; i++) { pageNums.push(next++); contentNums.push(next++); }
  const fontNum = next;
  objs.push({ n: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' });
  objs.push({ n: 2, body: '<< /Type /Pages /Kids [' + pageNums.map(n => n + ' 0 R').join(' ') + '] /Count ' + paginas.length + ' >>' });
  const esc = s => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  paginas.forEach((lineas, i) => {
    const plano = ['BT /F1 10 Tf 40 780 Td',
      ...lineas.map((l, j) => (j ? '0 -13 Td ' : '') + '(' + esc(l) + ') Tj'), 'ET'].join('\n');
    const stream = deflateSync(Buffer.from(plano, 'latin1'));
    objs.push({ n: pageNums[i], body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ' + contentNums[i] + ' 0 R /Resources << /Font << /F1 ' + fontNum + ' 0 R >> >> >>' });
    objs.push({ n: contentNums[i], body: Buffer.concat([Buffer.from('<< /Length ' + stream.length + ' /Filter /FlateDecode >>\nstream\n', 'latin1'),
      stream, Buffer.from('\nendstream', 'latin1')]) });
  });
  objs.push({ n: fontNum, body: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>' });
  objs.sort((a, b) => a.n - b.n);
  const partes = [Buffer.from('%PDF-1.4\n', 'latin1')];
  const offsets = [];
  for (const o of objs) {
    offsets[o.n] = partes.reduce((s, p) => s + p.length, 0);
    partes.push(Buffer.from(o.n + ' 0 obj\n', 'latin1'),
      Buffer.isBuffer(o.body) ? o.body : Buffer.from(o.body, 'latin1'), Buffer.from('\nendobj\n', 'latin1'));
  }
  const xref = partes.reduce((s, p) => s + p.length, 0);
  let xr = 'xref\n0 ' + (fontNum + 1) + '\n0000000000 65535 f \n';
  for (let n = 1; n <= fontNum; n++) xr += String(offsets[n] || 0).padStart(10, '0') + ' 00000 n \n';
  partes.push(Buffer.from(xr + 'trailer\n<< /Size ' + (fontNum + 1) + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF', 'latin1'));
  return Buffer.concat(partes);
}
const PDF_OK = pdfPaginas298([['Opinion del cumplimiento 2.9.8', 'Sentido POSITIVO RFC ' + OWN]]);
const PDF_ROTO = Buffer.from('%PDF-1.4\n% ilegible: catalogo sin paginas\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF');
const espera = ms => new Promise(r => setTimeout(r, ms));

/* Servidor HTTP real (patrón D7) + servicio con paseo sembrado. */
let service = null;
const server = createServer((req, res) => { req.headers['x-pacosat-proxy'] = KEY; service.handle(req, res); });
await new Promise(r => server.listen(0, '127.0.0.1', r));
const ORIGIN = 'http://127.0.0.1:' + server.address().port;
const dir = mkdtempSync(join(tmpdir(), 'pacosat-298v-'));
let pdfActual = PDF_OK;
service = createPacoSATService({
  dbFile: join(dir, 'pacosat.sqlite'),
  html: readFileSync(join(AQUI, 'Faro-Fiscal.html'), 'utf8'),
  lazyParts: JSON.parse(readFileSync(join(AQUI, 'lazy.json'), 'utf8')),
  capacidades: JSON.parse(readFileSync(join(AQUI, 'capacidades.json'), 'utf8')),
  origin: ORIGIN, proxyKey: KEY, satDocRetryWaitMs: 5,
  makeConnector: () => ({ parser: DOMParser, connector: {
    request: async () => 'req-298v', check: async () => ({ status: 'pending', packages: [] }),
    download: async () => { throw new Error('sin paquetes'); } } }),
  makeMailer: () => ({ verify: async () => true, sendMail: async () => ({ messageId: 'm1' }) }),
  now: () => Date.parse('2026-11-18T15:00:00Z'),
  satDocFetch: async profile => ({ content: pdfActual, issuedAt: '2026-11-16',
    fileName: 'Opinion ' + profile.rfc + '.pdf' })
});
let token = '';
const raw = async (method, path, bodyText, extraHeaders = {}) => {
  const chunks = []; if (bodyText) chunks.push(Buffer.from(String(bodyText)));
  const req = Readable.from(chunks);
  req.method = method; req.url = path;
  req.headers = { host: new URL(ORIGIN).host, origin: ORIGIN, 'x-pacosat-proxy': KEY, ...extraHeaders };
  let status = 0; const headers = {}; let text = '';
  const res = { writeHead(c, h) { status = c; if (h) Object.assign(headers, h); },
    setHeader(k, v) { headers[k] = v; }, getHeader(k) { return headers[k]; },
    end(ch) { if (ch) text += Buffer.isBuffer(ch) ? ch.toString('latin1') : ch; } };
  await service.handle(req, res);
  return { status, text, headers };
};
const call = async (method, path, body) => {
  if (!token) { const home = await raw('GET', '/'); token = /[0-9a-f]{64}/.exec(home.text)?.[0] || ''; }
  const r = await raw(method, path, body === undefined ? undefined : JSON.stringify(body),
    { 'x-pacosat-token': token });
  let json = null; try { json = JSON.parse(r.text); } catch { /* binario */ }
  return { status: r.status, json, text: r.text };
};
await call('POST', '/api/unlock', { rfc: OWN, minutes: 1440, days: 7,
  direction: 'both', password: 'simulated', certificate: 'YQ==', key: 'Yg==' });
const archivarOpinion = async (kind = 'opinion') => {
  const run = await call('POST', '/api/satdocs/run', { rfc: OWN, kind });
  assert.equal(run.json?.results?.[kind]?.ok, true, 'el documento se archiva (' + kind + ')');
  const vista = (await call('GET', '/api/satdocs')).json;
  return vista.profiles[0][kind].fileId;
};
const idOk = await archivarOpinion();
/* La miniatura nace al archivar (D2): se espera a que conste. */
for (let i = 0; i < 100; i++) {
  const lista = await call('GET', '/api/miniaturas200g?rfc=' + OWN);
  if ((lista.json.documentos || []).some(d => d.id === idOk && d.estado === 'ok')) break;
  await espera(150);
}
pdfActual = PDF_ROTO;
const idRoto = await archivarOpinion('constancia');
assert.notEqual(idRoto, idOk, 'el PDF ilegible es otro documento');
for (let i = 0; i < 100; i++) {
  const lista = await call('GET', '/api/miniaturas200g?rfc=' + OWN);
  if ((lista.json.documentos || []).some(d => d.id === idRoto && d.estado === 'fallo')) break;
  await espera(150);
}

const executablePath = [join(homedir(), '.cache/ms-playwright/chromium-1248/chrome-linux64/chrome'),
  join(homedir(), '.cache/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell')]
  .find(p => existsSync(p));
assert.ok(executablePath, 'Chromium de Playwright disponible');
const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });

/* Medición en página: llama a viewDocOnline SIN esperarla y
   muestrea el diálogo cada 10 ms hasta el iframe o 15 s.
   ENDURECIMIENTO DEL COORDINADOR (18 nov, tras la batería oficial):
   bajo la carga de la batería completa, el muestreo por intervalo
   llegó a saltarse la ventana de la previa (51 ms entre la
   miniatura y la sustitución) y la suite marcó previa=-1 con el
   producto comportándose bien (en solitario: diálogo 79 ms,
   previa 2.081 ms, completo 2.132 ms). Se añade un
   MutationObserver que sella tPrevia al AÑADIRSE el nodo de la
   previa (los registros de mutación no se pierden aunque el nodo
   desaparezca antes del siguiente muestreo). Las aserciones no
   cambian: mismos tiempos, mismo significado. */
const MEDIR = doc => new Promise(resolve => {
  const t0 = performance.now();
  const r = { tDialogo: -1, tPrevia: -1, tIframe: -1, notaCargando: '', notaTras404: '',
    mismoDialogo: false, abiertoAlFinal: false, botones: '' };
  const dialogo = document.querySelector('dialog');
  window.__visor298 = dialogo;
  const conPrevia = n => n?.nodeType === 1 &&
    (n.matches?.('[data-visor-previa]') || n.querySelector?.('[data-visor-previa]'));
  const obs = new MutationObserver(recs => {
    if (r.tPrevia >= 0) return;
    for (const rec of recs) for (const n of rec.addedNodes)
      if (conPrevia(n)) { r.tPrevia = performance.now() - t0; return; }
  });
  obs.observe(document.body, { childList: true, subtree: true });
  const p = viewDocOnline(doc);
  p.catch(() => {});
  const iv = setInterval(() => {
    const d = document.querySelector('dialog');
    const nota = d?.querySelector('[data-visor-cargando]');
    if (r.tDialogo < 0 && d && d.open && nota) {
      r.tDialogo = performance.now() - t0; r.notaCargando = nota.textContent;
    }
    if (nota && /no tiene vista previa/i.test(nota.textContent) && !r.notaTras404)
      r.notaTras404 = nota.textContent;
    if (r.tPrevia < 0 && d?.querySelector('[data-visor-previa]')) r.tPrevia = performance.now() - t0;
    if (d?.querySelector('iframe.pdf-preview')) {
      r.tIframe = performance.now() - t0;
      r.mismoDialogo = d === window.__visor298;
      r.abiertoAlFinal = d.open;
      r.botones = d.textContent;
      clearInterval(iv); obs.disconnect(); resolve(r);
    }
    if (performance.now() - t0 > 15000) { clearInterval(iv); obs.disconnect(); resolve(r); }
  }, 10);
});

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  /* La miniatura tarda 2 s en red: el gesto no puede esperarla. */
  await page.route('**/api/miniatura200g*', async route => {
    await espera(2000);
    await route.continue();
  });
  await page.goto(ORIGIN + '/', { waitUntil: 'load' });
  await page.waitForFunction(() => typeof viewDocOnline === 'function' && typeof satToken !== 'undefined' && Boolean(satToken),
    null, { timeout: 15000 });
  const enNube = await page.evaluate(() => cloudStorage);
  assert.equal(enNube, true, 'el cliente arranca en modo servidor (cloudStorage)');

  /* (1)+(2)+(3) Con previa, retenida 2 s. */
  const m = await page.evaluate(MEDIR, { id: idOk, rfc: OWN, kind: 'Opinión de cumplimiento',
    name: 'Opinion ' + OWN + '.pdf' });
  console.log('  tiempos (miniatura retenida 2.000 ms): diálogo=' + Math.round(m.tDialogo) +
    ' ms · previa=' + Math.round(m.tPrevia) + ' ms · visor completo=' + Math.round(m.tIframe) + ' ms');
  assert.ok(m.tDialogo >= 0 && m.tDialogo < 300,
    '(1) el diálogo es visible en el tiempo del gesto (<300 ms) sin esperar a la miniatura — fue ' + Math.round(m.tDialogo) + ' ms');
  assert.ok(m.notaCargando.includes('Cargando la primera página'),
    '(1) el diálogo abre con su nota honesta «Cargando la primera página…» — fue «' + m.notaCargando + '»');
  assert.ok(m.tPrevia >= 1800, '(2) la previa llega con la miniatura (≈2 s), no antes — fue ' + Math.round(m.tPrevia) + ' ms');
  assert.ok(m.tIframe > m.tPrevia, '(3) el visor completo sustituye a la previa después — previa ' +
    Math.round(m.tPrevia) + ' ms, completo ' + Math.round(m.tIframe) + ' ms');
  assert.ok(m.mismoDialogo && m.abiertoAlFinal,
    '(2)(3) es el MISMO elemento <dialog>, abierto de principio a fin: ni se cierra ni se reabre');
  assert.ok(m.botones.includes('Abrir PDF en otra pestaña') && m.botones.includes('Descargar original'),
    '(3) paridad final: «Abrir PDF en otra pestaña» y «Descargar original»');
  await page.evaluate(() => document.querySelector('dialog').close());
  console.log('OK 2.9.8 · V-(1..3) — Diálogo al instante (<300 ms) con la miniatura retenida 2 s; previa dentro del mismo diálogo; sustitución por el visor completo sin reabrir.');

  /* (4) Sin miniatura (404): el ilegible. */
  await page.unroute('**/api/miniatura200g*');
  const m404 = await page.evaluate(MEDIR, { id: idRoto, rfc: OWN, kind: 'Opinión de cumplimiento',
    name: 'Opinion rota ' + OWN + '.pdf' });
  console.log('  tiempos (404): diálogo=' + Math.round(m404.tDialogo) + ' ms · completo=' + Math.round(m404.tIframe) + ' ms');
  assert.ok(m404.tDialogo >= 0 && m404.tDialogo < 300,
    '(4) sin miniatura el diálogo abre igual al instante — fue ' + Math.round(m404.tDialogo) + ' ms');
  assert.ok(m404.notaTras404.length > 0,
    '(4) el diálogo ya abierto dice en su nota que no hay vista previa — notas: «' + m404.notaCargando + '» / «' + m404.notaTras404 + '»');
  assert.ok(m404.tIframe > 0 && m404.abiertoAlFinal,
    '(4) y termina en el visor completo de siempre, abierto');
  console.log('OK 2.9.8 · V-(4) — Sin miniatura (404): diálogo al instante con su nota y fin en el visor completo.');
  await page.close();
} finally {
  await browser.close();
  service.close();
  server.close();
}
console.log('OK suite ronda298visor completa');
