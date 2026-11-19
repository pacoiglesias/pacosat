/* ================================================================
   Ronda 2.3.2 · B5 — E-6 del libro: el gesto de arrastrar/pegar,
   EJERCIDO por fin (no solo nombrado en cadenas).

   La cobertura anterior de la nº 25 eran asertos de presencia
   de cadenas (ronda201cliente2:140-142). Esta suite despacha
   eventos sintéticos drop/paste CON FICHERO sobre el artefacto
   servido (servicio real + Chromium de Playwright, el patrón
   del arnés de capturas) y afirma lo que la nº 25 promete:
   que soltar o pegar abre LA MISMA confirmación que abre el
   botón de subir — mismo diálogo / misma tarjeta, mismo estado
   — en Documentos y en Bancos.

   Camino del botón, ejercido de verdad:
   · Documentos: clic en «Subir un papel» y el selector de
     ficheros real (filechooser de Playwright) con el PDF de
     juguete → diálogo «Archivar este papel».
   · Bancos: clic en «Subir estado de cuenta» y su selector
     real con un estado BBVA de juguete (PDF mínimo con el
     texto que el detector lee) → tarjeta de confirmación
     «¿Lo archivo y lo aplico?» con su botón «Aplicar».

   Orden de las mitades: Bancos corre en un contexto de
   navegador nuevo y Documentos en otro, para medir el gesto
   propio de cada pantalla en su sesión limpia. Y desde la
   integración 2.3.2, el bloque de Bancos afirma además la
   NO interferencia: el oyente global de drop de la parte
   diferida de Salidas tiene guarda de pantalla (solo actúa
   en Documentos, su pantalla) y soltar el estado sobre
   Bancos abre SOLO la tarjeta de Bancos, sin su diálogo
   «Archivar este papel»; el bloque de Documentos afirma lo
   contrario en su pantalla: el papel soltado sigue abriendo
   ese diálogo, como siempre.

   Lo que esta suite NO prueba: el gesto físico del SO
   (arrastrar desde el explorador de ficheros) — eso sigue
   sin existir como evidencia, como dice el libro.
   ================================================================ */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOMParser } from './node_modules/@xmldom/xmldom/lib/index.js';
import { createPacoSATService } from './local-server.mjs';
import { chromium } from './node_modules/playwright-core/index.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const ORIGIN = 'http://127.0.0.1:43941';
const KEY = 'e'.repeat(64);
const OWN = 'MFI6212158B4';
const CLABE = '012180001234567590';
const CHROMIUM = '/home/hatch/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome';
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* --- PDF mínimo válido con texto extraíble (el detector de
   Bancos lee el texto real del PDF con pdfjs, como en
   producción): las líneas del estado BBVA de juguete de
   ronda200f, en ASCII seguro. --- */
function pdfConTexto(lineas) {
  const esc = s => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const stream = 'BT /F1 12 Tf 56 780 Td 16 TL ' + lineas.map(l => '(' + esc(l) + ') Tj T*').join(' ') + ' ET';
  const objetos = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    '<< /Length ' + stream.length + ' >>\nstream\n' + stream + '\nendstream',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objetos.forEach((cuerpo, i) => { offsets.push(pdf.length); pdf += (i + 1) + ' 0 obj\n' + cuerpo + '\nendobj\n'; });
  const xref = pdf.length;
  pdf += 'xref\n0 ' + (objetos.length + 1) + '\n0000000000 65535 f \n' +
    offsets.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('') +
    'trailer\n<< /Size ' + (objetos.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF';
  return Buffer.from(pdf, 'latin1');
}
const ESTADO_LINEAS = [
  'BBVA MEXICO ESTADO DE CUENTA',
  'Cuenta ' + CLABE,
  'Periodo del 01/10/2026 al 31/10/2026',
  'Saldo inicial $10,000.00',
  'Saldo final $8,840.00',
  'Total de abonos $0.00',
  'Total de cargos $1,160.00',
  '05/10/2026 PAGO PROVEEDOR UNO $1,160.00 $8,840.00',
];
const tmp = mkdtempSync(join(tmpdir(), 'pacosat-gestos-'));
const papelPath = join(tmp, 'papel-de-juguete.pdf');
writeFileSync(papelPath, pdfConTexto(['Papel de juguete para el gesto de arrastrar y pegar.']));
const estadoPath = join(tmp, 'estado-de-juguete.pdf');
const estadoBuf = pdfConTexto(ESTADO_LINEAS);
writeFileSync(estadoPath, estadoBuf);
const papelBuf = readFileSync(papelPath);

/* --- Servicio real del árbol, en local --- */
const dir = mkdtempSync(join(tmpdir(), 'pacosat-gestos-datos-'));
const dbFile = join(dir, 'pacosat.sqlite');
const html = readFileSync(join(ROOT, 'Faro-Fiscal.html'), 'utf8');
const lazyParts = JSON.parse(readFileSync(join(ROOT, 'lazy.json'), 'utf8'));
const service = createPacoSATService({ dbFile, html, origin: ORIGIN, proxyKey: KEY, satDocRetryWaitMs: 5, lazyParts,
  makeConnector: () => ({ parser: DOMParser, connector: {
    request: async () => 'req-b', check: async () => ({ status: 'pending', packages: [] }),
    download: async () => { throw new Error('sin paquetes'); } } }),
  makeMailer: () => ({ verify: async () => true, sendMail: async () => ({ messageId: 'm1' }) }) });
let token = '';
const raw = async (method, path, body, headers = {}) => {
  const chunks = []; if (body !== undefined) chunks.push(Buffer.from(JSON.stringify(body)));
  const req = Readable.from(chunks);
  req.method = method; req.url = path;
  req.headers = { host: '127.0.0.1:43941', origin: ORIGIN, 'x-pacosat-proxy': KEY, ...headers };
  let status = 0; let text = '';
  const res = { writeHead(c) { status = c; }, setHeader() {}, getHeader() { return undefined; },
    end(chunk) { if (chunk) text += Buffer.isBuffer(chunk) ? chunk.toString('latin1') : chunk; } };
  await service.handle(req, res);
  return { status, text };
};
const call = async (method, path, body) => {
  if (!token) { const home = await raw('GET', '/'); token = /[0-9a-f]{64}/.exec(home.text)?.[0] || ''; }
  const r = await raw(method, path, body, { 'x-pacosat-token': token });
  let json = null; try { json = JSON.parse(r.text); } catch { /* binario */ }
  return { status: r.status, json, text: r.text };
};
{
  const open = await call('POST', '/api/unlock', { rfc: OWN, minutes: 1440, days: 7,
    direction: 'both', password: 'simulated', certificate: 'YQ==', key: 'Yg==' });
  assert.equal(open.status, 200, 'unlock');
  const seed = await call('POST', '/api/storage', { batch: { people: [{ id: OWN, name: 'Mano Fil, S.A.' }] } });
  assert.equal(seed.status, 200, 'seed de contribuyente');
  const alta = await call('POST', '/api/banks/accounts',
    { bank: 'BBVA', name: 'Chequera', kind: 'cuenta', numero: CLABE, rfc: OWN });
  assert.equal(alta.status, 200, 'alta de la cuenta BBVA de juguete');
}
const server = createServer(service.handle);
await new Promise(r => server.listen(43941, '127.0.0.1', r));
const browser = await chromium.launch({ executablePath: CHROMIUM, args: ['--no-sandbox', '--disable-dev-shm-usage'] });

async function paginaAmbito() {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 },
    extraHTTPHeaders: { 'x-pacosat-proxy': KEY } });
  const page = await context.newPage();
  await page.goto(ORIGIN + '/', { waitUntil: 'load', timeout: 30000 });
  await page.waitForSelector('#title', { timeout: 20000 });
  await sleep(1800);
  await page.evaluate(rfc => {
    const sel = document.querySelector('#scope');
    if (sel && sel.value !== rfc) { sel.value = rfc; sel.dispatchEvent(new Event('change', { bubbles: true })); }
  }, OWN);
  await sleep(1200);
  return { context, page };
}

/* Despacha drop/paste sintéticos CON FICHERO: el File y el
   DataTransfer se construyen dentro de la página, como los
   traería el SO, y el evento se entrega al destino pedido. */
async function despacharGesto(page, { tipo, destino, buf, nombre }) {
  await page.evaluate(({ tipo, destino, b64, nombre }) => {
    const bin = atob(b64); const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const file = new File([bytes], nombre, { type: 'application/pdf' });
    const dt = new DataTransfer(); dt.items.add(file);
    let ev;
    if (tipo === 'drop') {
      ev = new DragEvent('drop', { bubbles: true, cancelable: true });
      Object.defineProperty(ev, 'dataTransfer', { value: dt });
    } else {
      ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(ev, 'clipboardData', { value: dt });
    }
    let target = window;
    if (destino === 'documento') target = document;
    if (destino === 'panel-bancos') {
      target = [...document.querySelectorAll('#body section, #body .panel')]
        .find(el => [...el.querySelectorAll('button')].some(b => b.textContent.trim() === 'Subir estado de cuenta'));
      if (!target) throw new Error('panel de Bancos no encontrado para el drop');
    }
    target.dispatchEvent(ev);
  }, { tipo, destino, b64: buf.toString('base64'), nombre });
}

/* El titular de la tarjeta del botón, compartido con el caso
   de re-entrada de la integración 2.3.2 (bloque propio, más
   abajo): la tarjeta de la vuelta debe ser ESA misma. */
let titularBotonBancos232 = '';

/* ============ BANCOS (contexto nuevo) ============ */
{
  const { context, page } = await paginaAmbito();
  const irBancos = async () => {
    await page.evaluate(() => { if (typeof dineroTab !== 'undefined') dineroTab = 'bancos'; navigate('dinero'); });
    await sleep(1800);
    const ok = await page.evaluate(() =>
      [...document.querySelectorAll('#body button')].some(b => b.textContent.trim() === 'Subir estado de cuenta'));
    assert.ok(ok, 'el panel «Subir estado de cuenta» de Bancos está en pantalla');
  };
  const firmaTarjeta = () => page.evaluate(() => {
    const btn = [...document.querySelectorAll('#body button')].find(b => b.textContent.trim() === 'Subir estado de cuenta');
    const panelEl = btn?.closest('section, .panel');
    const texto = (panelEl?.innerText || '').replace(/\s+/g, ' ');
    const titular = [...(panelEl?.querySelectorAll('p') || [])]
      .map(p => (p.textContent || '').replace(/\s+/g, ' ').trim())
      .find(t => t.includes('movimientos') && t.includes('Saldo final')) || '';
    return { titular, pideAplicar: texto.includes('¿Lo archivo y lo aplico?'),
      hayAplicar: [...(panelEl?.querySelectorAll('button') || [])].some(b => b.textContent.trim() === 'Aplicar'),
      texto: texto.slice(0, 400) };
  });
  const esperarTarjeta = async () => {
    for (let i = 0; i < 30; i++) { const f = await firmaTarjeta(); if (f.pideAplicar && f.hayAplicar) return f; await sleep(500); }
    const f = await firmaTarjeta();
    assert.fail('la tarjeta de confirmación de Bancos no apareció; el panel dice: ' + f.texto);
  };

  /* (1) El botón: selector de ficheros real. */
  await irBancos();
  const chooserP = page.waitForEvent('filechooser', { timeout: 15000 });
  await page.evaluate(() => {
    [...document.querySelectorAll('#body button')].find(b => b.textContent.trim() === 'Subir estado de cuenta').click();
  });
  const chooser = await chooserP;
  await chooser.setFiles(estadoPath);
  const firmaBoton = await esperarTarjeta();
  titularBotonBancos232 = firmaBoton.titular;
  assert.ok(firmaBoton.titular.includes('BBVA'), 'el botón detecta el banco del estado: ' + firmaBoton.titular);
  console.log('OK 2.3.2-B5 · gestos Bancos (botón) — tarjeta de confirmación:', firmaBoton.titular);

  /* (2) Soltar sobre el panel: la MISMA tarjeta. Sin
     re-navegar: los tres gestos se ejercen sobre la misma
     instancia del panel, la sesión real de quien está en
     Bancos subiendo estados. (La vuelta a Bancos tras salir
     — el pegado sobre la instancia NUEVA del panel — es el
     bloque de re-entrada de la integración 2.3.2, más abajo,
     en su propio contexto: ver su nota.) */
  await despacharGesto(page, { tipo: 'drop', destino: 'panel-bancos', buf: estadoBuf, nombre: 'estado-de-juguete.pdf' });
  const firmaDrop = await esperarTarjeta();
  assert.equal(firmaDrop.titular, firmaBoton.titular, 'soltar abre la misma confirmación que el botón (mismo titular detectado)');
  console.log('OK 2.3.2-B5 · gestos Bancos (drop) — misma tarjeta que el botón.');

  /* Integración 2.3.2: SOLO la tarjeta de Bancos. El oyente
     global de drop de la parte de Salidas (su diálogo
     «Archivar este papel») tiene guarda de pantalla — solo
     actúa en Documentos, la suya — y soltar el estado aquí
     no abre ningún diálogo suyo. Se deja un margen antes de
     afirmar la ausencia: la clasificación del papel es
     asíncrona y, sin la guarda, su diálogo llegaba después
     de la tarjeta (y con un diálogo abierto, la guarda
     dialog[open] bloqueaba el pegado del caso (3)). */
  await sleep(1500);
  const dialogoSalidas = await page.evaluate(() => {
    const dlg = document.querySelector('dialog[open]');
    return dlg ? (dlg.innerText || '').replace(/\s+/g, ' ').slice(0, 120) : '';
  });
  assert.equal(dialogoSalidas, '',
    'soltar sobre Bancos no abre ningún diálogo de Salidas («Archivar este papel»): ' + dialogoSalidas);
  console.log('OK 2.3.2 · gestos Bancos (drop) — SOLO la tarjeta de Bancos: ningún diálogo «Archivar este papel» de Salidas.');

  /* (3) Pegar: la MISMA tarjeta. */
  await despacharGesto(page, { tipo: 'paste', destino: 'documento', buf: estadoBuf, nombre: 'estado-de-juguete.pdf' });
  const firmaPaste = await esperarTarjeta();
  assert.equal(firmaPaste.titular, firmaBoton.titular, 'pegar abre la misma confirmación que el botón (mismo titular detectado)');
  console.log('OK 2.3.2-B5 · gestos Bancos (paste) — misma tarjeta que el botón.');

  await context.close();
}

/* ============ BANCOS · RE-ENTRADA (contexto nuevo; integración 2.3.2) ============
   El caso que faltaba del hallazgo de camino de B5: entrar en
   Bancos, salir a otra pantalla, VOLVER a Bancos y pegar →
   se abre la misma tarjeta de confirmación. El oyente de
   `paste` quedaba ligado a la primera instancia del panel
   (window.__bancosPegar201 + su isConnected): tras
   re-renderizar la vista, la instancia vieja ya no estaba
   conectada y la nueva no tenía oyente — el pegado quedaba
   mudo, mientras el drop, ligado por instancia, sí
   funcionaba.
   Contexto propio, por el método de esta suite: este bloque
   mide solo la re-entrada (el pegado sobre la instancia
   nueva) y no despacha ningún drop. La interferencia que
   antes lo contaminaba — el oyente global de drop de la
   parte de Salidas disparando también en Bancos y dejando
   su diálogo «Archivar este papel» abierto, con lo que la
   guarda dialog[open] bloqueaba el pegado — quedó cerrada
   en la integración 2.3.2 con la guarda de pantalla de ese
   oyente, y se afirma en el bloque de Bancos de arriba. */
{
  const { context, page } = await paginaAmbito();
  const irBancos = async () => {
    await page.evaluate(() => { if (typeof dineroTab !== 'undefined') dineroTab = 'bancos'; navigate('dinero'); });
    await sleep(1800);
    const ok = await page.evaluate(() =>
      [...document.querySelectorAll('#body button')].some(b => b.textContent.trim() === 'Subir estado de cuenta'));
    assert.ok(ok, 're-entrada: el panel «Subir estado de cuenta» de Bancos está en pantalla');
  };
  const firmaTarjeta = () => page.evaluate(() => {
    const btn = [...document.querySelectorAll('#body button')].find(b => b.textContent.trim() === 'Subir estado de cuenta');
    const panelEl = btn?.closest('section, .panel');
    const texto = (panelEl?.innerText || '').replace(/\s+/g, ' ');
    const titular = [...(panelEl?.querySelectorAll('p') || [])]
      .map(p => (p.textContent || '').replace(/\s+/g, ' ').trim())
      .find(t => t.includes('movimientos') && t.includes('Saldo final')) || '';
    return { titular, pideAplicar: texto.includes('¿Lo archivo y lo aplico?'),
      hayAplicar: [...(panelEl?.querySelectorAll('button') || [])].some(b => b.textContent.trim() === 'Aplicar'),
      texto: texto.slice(0, 400) };
  });
  const esperarTarjeta = async () => {
    for (let i = 0; i < 30; i++) { const f = await firmaTarjeta(); if (f.pideAplicar && f.hayAplicar) return f; await sleep(500); }
    const f = await firmaTarjeta();
    assert.fail('re-entrada: la tarjeta de confirmación de Bancos no apareció tras volver y pegar; el panel dice: ' + f.texto);
  };

  await irBancos();
  await page.evaluate(() => navigate('docs'));
  await sleep(1800);
  const fueraDeBancos = await page.evaluate(() => typeof page !== 'undefined' && page !== 'dinero');
  assert.ok(fueraDeBancos, 're-entrada: la salida a otra pantalla (Documentos) es real: ya no estamos en Dinero/Bancos');
  await irBancos();
  await despacharGesto(page, { tipo: 'paste', destino: 'documento', buf: estadoBuf, nombre: 'estado-de-juguete.pdf' });
  const firmaPasteVuelta = await esperarTarjeta();
  assert.ok(titularBotonBancos232, 're-entrada: el titular del botón del contexto de Bancos consta');
  assert.equal(firmaPasteVuelta.titular, titularBotonBancos232,
    'tras salir y volver a Bancos, pegar abre la misma confirmación que el botón (mismo titular detectado)');
  console.log('OK 2.3.2 · gestos Bancos (paste tras salir y volver) — misma tarjeta que el botón en la instancia nueva.');
  await context.close();
}

/* ============ DOCUMENTOS (contexto nuevo) ============ */
{
  const { context, page } = await paginaAmbito();
  await page.evaluate(() => navigate('docs'));
  await sleep(1800);
  const firmaDialogo = () => page.evaluate(() => {
    const dlg = document.querySelector('dialog[open]');
    if (!dlg) return null;
    const texto = (dlg.innerText || '').replace(/\s+/g, ' ');
    return { titulo: dlg.querySelector('h2, h3, .dialog-title')?.textContent?.trim() || texto.slice(0, 40),
      texto,
      hayConfirmar: [...dlg.querySelectorAll('button')].some(b => b.textContent.trim() === 'Archivar el papel') };
  });
  const esperarDialogo = async () => {
    for (let i = 0; i < 30; i++) { const f = await firmaDialogo(); if (f && f.hayConfirmar) return f; await sleep(500); }
    assert.fail('el diálogo «Archivar este papel» no se abrió');
  };
  const cerrarDialogo = async () => {
    await page.evaluate(() => {
      const dlg = document.querySelector('dialog[open]');
      const cancel = dlg && [...dlg.querySelectorAll('button')].find(b => /cancelar/i.test(b.textContent));
      if (cancel) cancel.click(); else if (dlg) dlg.close();
    });
    await sleep(600);
  };

  /* (1) El botón «Subir un papel»: selector real. */
  const chooserP = page.waitForEvent('filechooser', { timeout: 15000 });
  await page.evaluate(() => {
    /* El protagonista de Documentos: el «Subir un papel» de la
       tarjeta del expediente (hay otro homónimo en la sección
       de Constancias y opinión, con otro diálogo). */
    const btn = [...document.querySelectorAll('#body button')]
      .find(b => b.textContent.trim() === 'Subir un papel' &&
        (b.closest('section')?.textContent || '').includes('Foto o PDF: sugiere RFC y tipo'));
    if (!btn) throw new Error('botón «Subir un papel» del expediente no encontrado');
    btn.click();
  });
  const chooser = await chooserP;
  await chooser.setFiles(papelPath);
  const firmaBoton = await esperarDialogo();
  assert.ok(firmaBoton.texto.includes('Archivar este papel'), 'el botón abre el diálogo de clasificación: ' + firmaBoton.texto.slice(0, 120));
  assert.ok(firmaBoton.texto.includes('papel-de-juguete.pdf'), 'el diálogo nombra el fichero elegido por el botón');
  await cerrarDialogo();
  console.log('OK 2.3.2-B5 · gestos Documentos (botón) — diálogo «Archivar este papel» con el fichero.');

  /* (2) Soltar sobre la app: el MISMO diálogo. Este es el
     oyente global de la parte de Salidas EN SU PANTALLA
     (Documentos): con la guarda de pantalla de la
     integración 2.3.2 sigue abriendo su «Archivar este
     papel» como hoy — la guarda solo lo apaga fuera de
     Documentos (en Bancos, caso de arriba). */
  await despacharGesto(page, { tipo: 'drop', destino: 'ventana', buf: papelBuf, nombre: 'papel-de-juguete.pdf' });
  const firmaDrop = await esperarDialogo();
  assert.ok(firmaDrop.texto.includes('papel-de-juguete.pdf'), 'soltar abre el mismo diálogo con el mismo fichero');
  assert.equal(firmaDrop.hayConfirmar, firmaBoton.hayConfirmar, 'soltar ofrece la misma confirmación («Archivar el papel») que el botón');
  await cerrarDialogo();
  console.log('OK 2.3.2-B5 · gestos Documentos (drop) — mismo diálogo que el botón.');

  /* (3) Pegar: el MISMO diálogo. */
  await despacharGesto(page, { tipo: 'paste', destino: 'documento', buf: papelBuf, nombre: 'papel-de-juguete.pdf' });
  const firmaPaste = await esperarDialogo();
  assert.ok(firmaPaste.texto.includes('papel-de-juguete.pdf'), 'pegar abre el mismo diálogo con el mismo fichero');
  assert.equal(firmaPaste.hayConfirmar, firmaBoton.hayConfirmar, 'pegar ofrece la misma confirmación («Archivar el papel») que el botón');
  await cerrarDialogo();
  console.log('OK 2.3.2-B5 · gestos Documentos (paste) — mismo diálogo que el botón.');
  await context.close();
}

await browser.close();
server.close();
await service.close();
console.log('OK suite ronda232gestos completa');
