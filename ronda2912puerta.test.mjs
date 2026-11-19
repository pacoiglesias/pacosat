import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { readFileSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOMParser } from '@xmldom/xmldom';
import { createPacoSATService } from './local-server.mjs';
import { satBrowserLogin } from './sat-doc-browser.mjs';
import { createSatPuertaFetch, BUZON_LOGIN_URL } from './sat-tributario.mjs';

/* ================================================================
   Ronda 2.9.12 · Pieza 1 — LA PUERTA VERAZ (+ Precisión 2)

   EL HECHO (18 nov 2026, probado en producción): todo el día la
   prueba de la puerta declaró «portal-caido» en falso mientras
   el portal del SAT estaba ARRIBA (curl 200 desde dos sedes) y
   el paseo real del Buzón entraba (corrida 582316bf, 18:27).
   La causa raíz, localizada en el código:

   (a) createSatPuertaFetch (sat-tributario.mjs) llamaba a
       satBrowserLogin SIN entryUrl — el paseo del Buzón llama
       al mismo login CON entryUrl: BUZON_LOGIN_URL —. Sin
       entryUrl, page.goto(undefined) falla al instante en el
       driver real («page.goto: url: expected string, got
       undefined», verificado con playwright-core 1.64.1).
   (b) satBrowserLogin clasificaba CUALQUIER fallo de ese goto
       como «portal-caido»: un error local de programación se
       disfrazaba de caída del SAT y alimentaba sat_puerta, la
       luz de la puerta, el foco y el flag puertaCaida del
       veredicto de descargas.

   LA PIEZA:
   P1 · createSatPuertaFetch pasa la MISMA entryUrl del paseo
        del Buzón (BUZON_LOGIN_URL, la constante del módulo,
        sin duplicar el literal).
   P2 · satBrowserLogin: sin entryUrl (o vacía) el error es
        LOCAL y nombrado — kind «error-interno», con texto que
        dice que falta la dirección de acceso y que es un fallo
        de PacoSAT, jamás del SAT —; y en el goto solo los
        errores de red reales (isNetworkError) pueden salir
        como portal-caido: cualquier otro error del goto sale
        con su kind honesto y su mensaje subyacente. Los fallos
        de red siguen siendo portal-caido (los reintentos de
        documentos de local-server dependen de ello).
   P3 · Auditoría de llamadores: las dos llamadas de
        ejecutor-local.mjs (abrirSesionViva y puerta-probar) SÍ
        pasan entryUrl — verificado por grep el 18 nov: es la
        razón de que en la sede del ejecutor hubiera accesos OK
        históricos con la misma forma de llamada —. La suite
        lo fija con aserciones de fuente para que la omisión
        no pueda volver en silencio a ningún llamador.
   P4 · PRECISIÓN 2 — un paseo que entra es una puerta que
        abre: todo acceso real al portal que termina bien en
        la sede de casa (Buzón, Declaraciones, documentos y
        caminante CFDI) registra también el éxito de la puerta
        (guardarVeredictoPuerta293), para que «último éxito»
        sea la verdad de TODOS los accesos y no solo de la
        sonda. Antes de la pieza, las corridas de casa no
        escribían sat_puerta: el Buzón entró el 18 nov a las
        06:54 y a las 18:27 y la puerta seguía enseñando
        «Último éxito real: el 17 nov, 20:21».

   Contra la 2.9.11 esta suite corre en ROJO en P1 (el goto
   recibe undefined y el acceso muere como portal-caido), en
   P2 (sin entryUrl sale portal-caido; un error no-red sale
   portal-caido sin su mensaje) y en P4 (la corrida buena del
   Buzón no deja veredicto de puerta). P2-red y P3 quedan como
   están: son el comportamiento verdadero que se conserva.
   ================================================================ */

const AQUI = dirname(fileURLToPath(import.meta.url));
const RFC = 'MFI6212158B4';
const ORIGIN = 'https://pacosat.test';
const KEY = 'b'.repeat(64);
const OWN = 'AAA010101AAA';
const PASSWORD = 'clave-de-prueba-2912';

/* Llave de juguete en la forma que el portal acepta (PKCS#8
   3DES): prepareKeyForPortal la deja pasar tal cual. */
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KEY_3DES = privateKey.export({ type: 'pkcs8', format: 'der',
  cipher: 'des-ede3-cbc', passphrase: PASSWORD });
const CREDS = { rfc: RFC, cer: Buffer.from('certificado-de-juguete'),
  key: KEY_3DES, password: PASSWORD };

/* Página falsa que graba: reproduce el contrato que
   satBrowserLogin usa (goto/url/clickButtonFiel/fillFielForm/
   submitFiel/divError/text) y el comportamiento del driver
   real ante goto(undefined): lanza al instante con el mensaje
   de Playwright verificado en vivo. gotoError(n, url) puede
   inyectar el fallo de cada intento. */
class FakePage2912 {
  constructor(opts = {}) {
    this.gotos = [];
    this.currentUrl = 'about:blank';
    this.gotoError = opts.gotoError || null;
    this.landedUrl = opts.landedUrl || 'https://wwwmat.sat.gob.mx/buzon';
    this.filled = null;
  }
  async goto(url) {
    this.gotos.push(url);
    if (this.gotoError) {
      const e = this.gotoError(this.gotos.length, url);
      if (e) throw e;
    }
    if (typeof url !== 'string' || !url)
      throw new Error('page.goto: url: expected string, got ' + typeof url);
    this.currentUrl = url;
  }
  url() { return this.currentUrl; }
  async clickButtonFiel() { /* el acceso aparece */ }
  async fillFielForm(form) { this.filled = form; return { faltan: [] }; }
  async submitFiel() { this.currentUrl = this.landedUrl; }
  async divError() { return ''; }
  async text() { return 'Buzón Tributario'; }
}
const driverDe = (page) => async () => ({ newPage: async () => page, close: async () => {} });

/* ================================================================
   P1 · createSatPuertaFetch entra por la MISMA puerta que el
   paseo del Buzón y el acceso se completa contra la doble
   ================================================================ */
{
  const page = new FakePage2912();
  const fetchPuerta = createSatPuertaFetch({
    resolveCredentials: async () => ({ ...CREDS }),
    launchDriver: driverDe(page) });
  const res = await fetchPuerta({ rfc: RFC });
  assert.deepEqual(res, { puerta: 'abre', accesoOk: true },
    'P1: la prueba de la puerta completa el acceso contra la doble');
  assert.equal(page.gotos[0], BUZON_LOGIN_URL,
    'P1: el primer goto recibe BUZON_LOGIN_URL, la puerta del paseo del Buzón ' +
    '(en la 2.9.11 recibía undefined y el acceso moría al instante)');
  assert.ok(page.filled && page.filled.rfc === RFC,
    'P1: el formulario de la e.firma se rellenó tras abrir la entrada');
}

/* ================================================================
   P2a · satBrowserLogin SIN entryUrl: error local nombrado,
   jamás portal-caido
   ================================================================ */
{
  const page = new FakePage2912();
  await assert.rejects(
    satBrowserLogin(page, { cer: CREDS.cer, key: CREDS.key, password: PASSWORD, rfc: RFC }),
    (error) => {
      assert.notEqual(error.code, 'portal-caido',
        'P2a: sin entryUrl el kind NO es portal-caido (en la 2.9.11 lo era)');
      assert.equal(error.code, 'error-interno',
        'P2a: el kind honesto es error-interno');
      assert.match(error.message, /dirección de acceso/i,
        'P2a: el texto nombra lo que falta: la dirección de acceso');
      assert.match(error.message, /PacoSAT/,
        'P2a: el texto dice que el fallo es de PacoSAT, no del SAT');
      return true;
    });
  assert.equal(page.gotos.length, 0,
    'P2a: sin dirección no se navega a ningún sitio: el fallo es previo al portal');
}

/* ================================================================
   P2b · goto con un error que NO es de red: kind honesto y el
   mensaje subyacente viaja
   ================================================================ */
{
  const subyacente = 'page.goto: Protocol error (Page.navigate): Cannot navigate to invalid URL';
  const page = new FakePage2912({ gotoError: () => new Error(subyacente) });
  await assert.rejects(
    satBrowserLogin(page, { cer: CREDS.cer, key: CREDS.key, password: PASSWORD, rfc: RFC,
      entryUrl: BUZON_LOGIN_URL }),
    (error) => {
      assert.notEqual(error.code, 'portal-caido',
        'P2b: un error del goto que no es de red NO sale como portal-caido');
      assert.equal(error.code, 'error-interno', 'P2b: el kind honesto es error-interno');
      assert.ok(error.message.includes('Cannot navigate to invalid URL'),
        'P2b: el mensaje subyacente del driver viaja en el error (en la 2.9.11 se perdía)');
      return true;
    });
}

/* ================================================================
   P2c · goto con error de RED dos veces: portal-caido se
   conserva, con su reintento (el comportamiento verdadero)
   ================================================================ */
{
  const page = new FakePage2912({ gotoError: () => {
    const e = new Error('page.goto: net::ERR_CONNECTION_REFUSED at ' + BUZON_LOGIN_URL);
    e.code = 'ERR_CONNECTION_REFUSED';
    return e;
  } });
  await assert.rejects(
    satBrowserLogin(page, { cer: CREDS.cer, key: CREDS.key, password: PASSWORD, rfc: RFC,
      entryUrl: BUZON_LOGIN_URL }),
    (error) => {
      assert.equal(error.code, 'portal-caido',
        'P2c: el fallo de red real sigue saliendo como portal-caido');
      return true;
    });
  assert.equal(page.gotos.length, 2,
    'P2c: el fallo de red conserva su reintento (dos intentos de goto)');
}

/* ================================================================
   P3 · Auditoría fijada: TODOS los llamadores de
   satBrowserLogin del árbol pasan entryUrl
   ================================================================ */
{
  const fuentes = {
    'sat-tributario.mjs': readFileSync(join(AQUI, 'sat-tributario.mjs'), 'utf8'),
    'sat-declaraciones.mjs': readFileSync(join(AQUI, 'sat-declaraciones.mjs'), 'utf8'),
    'sat-portal-cfdi.mjs': readFileSync(join(AQUI, 'sat-portal-cfdi.mjs'), 'utf8'),
    'sat-doc-browser.mjs': readFileSync(join(AQUI, 'sat-doc-browser.mjs'), 'utf8'),
    'ejecutor-local.mjs': readFileSync(join(AQUI, 'ejecutor-local.mjs'), 'utf8'),
  };
  let llamadas = 0;
  for (const [nombre, fuente] of Object.entries(fuentes)) {
    for (const m of fuente.matchAll(/await satBrowserLogin\(page, \{([\s\S]*?)\}\)/g)) {
      llamadas++;
      assert.ok(m[1].includes('entryUrl'),
        'P3: la llamada a satBrowserLogin en ' + nombre + ' pasa entryUrl ' +
        '(la omisión de createSatPuertaFetch no puede volver en silencio)');
    }
  }
  assert.ok(llamadas >= 5,
    'P3: la auditoría encuentra las llamadas conocidas (paseo, documentos, ' +
    'declaraciones, portal CFDI, puerta y las dos del ejecutor); encontró ' + llamadas);
  /* La constante no se duplica: el literal de la puerta solo
     vive en su definición de sat-tributario.mjs. */
  const literal = 'wwwmat.sat.gob.mx/app/seg/faces/pages/lanzador.jsf';
  for (const nombre of ['sat-declaraciones.mjs', 'sat-portal-cfdi.mjs', 'ejecutor-local.mjs']) {
    assert.ok(!fuentes[nombre].includes(literal),
      'P3: ' + nombre + ' reutiliza la constante, no duplica el literal de la puerta');
  }
}

/* ================================================================
   P4 · Precisión 2 (sede): un paseo real del Buzón que entra
   registra el éxito de la puerta con su hora
   ================================================================ */
function makeHarness(options = {}) {
  const clock = { t: options.start ?? Date.parse('2026-11-18T09:00:00Z') };
  const mails = [];
  const service = createPacoSATService({
    dbFile: ':memory:',
    html: '<html><head><!--PACOSAT_TOKEN--></head><body>prueba</body></html>',
    origin: ORIGIN, proxyKey: KEY, satDocRetryWaitMs: 5,
    makeConnector: () => ({ parser: DOMParser, connector: {
      request: async () => 'req-2912', check: async () => ({ status: 'pending', packages: [] }),
      download: async () => { throw new Error('sin paquetes'); } } }),
    makeMailer: () => ({ verify: async () => true,
      sendMail: async payload => { mails.push(payload); return { messageId: 'm' + mails.length }; } }),
    now: () => clock.t, ...options });
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
  return { service, call, clock, mails };
}
{
  const T0 = Date.parse('2026-11-18T09:00:00Z');
  const satTribFetch = async () => ({ notifications: [], comunicadosNoLeidos: 0,
    comunicados: { concluyente: true, items: [], noLeidos: 0, leidos: 0 }, documentos: null });
  const h = makeHarness({ executorMode: 'nas', satTribFetch, start: T0 });
  try {
    const open = await h.call('POST', '/api/unlock', { rfc: OWN, minutes: 1440, days: 7,
      direction: 'both', password: 'simulated', certificate: 'YQ==', key: 'Yg==' });
    assert.equal(open.status, 200, 'P4: unlock de ' + OWN);
    const antes = (await h.call('GET', '/api/status')).json;
    assert.ok(!antes.puerta[OWN]?.ok,
      'P4: antes del paseo no consta que la puerta abra');
    const run = await h.call('POST', '/api/tributario/run', { rfc: OWN });
    assert.equal(run.json.result.ok, true, 'P4: el paseo del Buzón concluye bien');
    const despues = (await h.call('GET', '/api/status')).json;
    const puerta = despues.puerta[OWN];
    assert.ok(puerta, 'P4: tras el paseo la puerta tiene veredicto (en la 2.9.11 sat_puerta quedaba intacta)');
    assert.equal(puerta.ok, true,
      'P4: un paseo que entra es una puerta que abre: ok = true');
    assert.equal(puerta.ultimoExito, T0,
      'P4: «último éxito» es la hora del acceso real, no solo la de la sonda');
    assert.equal(puerta.probada, T0,
      'P4: la marca de probada también es la del acceso real');
  } finally {
    h.service.close();
  }
}

console.log('OK ronda2912puerta: la puerta veraz (entryUrl, kinds honestos, red = portal-caido) ' +
  'y un paseo que entra registra la puerta.');
