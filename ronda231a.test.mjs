import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createPacoSATService } from './local-server.mjs';

/* ================================================================
   Ronda 2.3.1 · frente A — la página rebota a quien llega desde
   un enlace. Defecto verificado en vivo el 17 nov 2026 a las
   11:01, en el Chrome de Paco y en la URL exacta registrada
   https://pacosat.iglesiasmurrieta.com/: el servidor devolvió el
   JSON «Estás en una dirección distinta de la registrada de la
   app; ábrela desde pacosat.iglesiasmurrieta.com.» y la app no
   cargó. El Registro lo confirmó dos veces: «Origen rechazado
   en GET /: sec-fetch-site «cross-site» con Origin «(sin
   cabecera Origin)»». Causa: el chequeo genérico de
   sec-fetch-site rechazaba TODO request que no fuera
   same-origin/none, incluida la NAVEGACIÓN del documento cuando
   se llega desde un enlace externo (chat/correo), que viaja sin
   Origin y con sec-fetch-site: cross-site y
   sec-fetch-mode: navigate.
   Corrección: las navegaciones de documento
   (sec-fetch-mode: navigate) nunca se bloquean por
   sec-fetch/origen. El invariante CSRF queda intacto: fuera de
   las navegaciones el chequeo genérico sigue vivo y los POST
   siguen pasando por exigirOrigen202 (eso ya lo juzga
   ronda202; aquí se re-juzga el sentido que importa a este
   frente: el POST con Origin extranjero sigue en 403 llano y
   con su anotación en el Registro).
   El arranque del servidor de pruebas y el arnés siguen el
   patrón de ronda202.test.mjs, extendido solo para poder
   OMITIR la cabecera Origin (el caso 1 la manda ausente, no
   vacía) y para fijar las cabeceras sec-fetch-* por petición.
   ================================================================ */

const ORIGIN = 'https://pacosat.test';
const KEY = 'e'.repeat(64);
const MENSAJE = 'Estás en una dirección distinta de la registrada de la app; ábrela desde pacosat.test.';
function harness(service) {
  const raw = async (method, path, body, extraHeaders = {}) => {
    const chunks = []; if (body !== undefined) chunks.push(Buffer.from(JSON.stringify(body)));
    const req = Readable.from(chunks);
    req.method = method; req.url = path;
    req.headers = { host: 'pacosat.test', origin: ORIGIN, 'x-pacosat-proxy': KEY, ...extraHeaders };
    /* null en extraHeaders = la cabecera NO viaja (así llega la
       navegación externa: sin Origin, no con Origin vacío). */
    for (const [k, v] of Object.entries(extraHeaders)) if (v === null) delete req.headers[k];
    let status = 0; const headers = {}; let text = '';
    const res = { writeHead(code) { status = code; }, setHeader(k, v) { headers[k] = v; },
      getHeader(k) { return headers[k]; },
      end(chunk) { if (chunk) text += Buffer.isBuffer(chunk) ? chunk.toString('latin1') : chunk; } };
    await service.handle(req, res);
    return { status, text, headers };
  };
  const call = async (method, path, body, extraHeaders = {}) => {
    const r = await raw(method, path, body, extraHeaders);
    let json = null; try { json = JSON.parse(r.text); } catch { /* binario o HTML */ }
    return { status: r.status, json, text: r.text };
  };
  return { raw, call };
}
const makeService = (options = {}) => {
  const service = createPacoSATService({
    dbFile: ':memory:', html: '<html><head><!--PACOSAT_TOKEN--></head><body>prueba</body></html>',
    origin: ORIGIN, proxyKey: KEY, satDocRetryWaitMs: 5,
    makeMailer: () => ({ verify: async () => true, sendMail: async () => ({ messageId: 'm1' }) }),
    ...options });
  return { service, ...harness(service) };
};

/* ---------- Casos 1 y 5 (primera mitad): la navegación externa entra y no deja rechazo ---------- */
const h = makeService();
let token = '';
{
  /* Caso 1: la réplica exacta del defecto — GET / con
     sec-fetch-site: cross-site, sec-fetch-mode: navigate y SIN
     cabecera Origin. Antes de la corrección: 403 con el JSON de
     dirección distinta. */
  const nav = await h.raw('GET', '/', undefined,
    { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', origin: null });
  assert.equal(nav.status, 200, 'la navegación externa a / entra (200), no rebota: ' + nav.text.slice(0, 200));
  assert.ok(nav.text.includes('name="pacosat-token"'), 'la respuesta es el HTML de la app, con su meta de token');
  token = /[0-9a-f]{64}/.exec(nav.text)?.[0] || '';
  assert.ok(token, 'la meta de token trae el token de la app');
  assert.ok(nav.text.includes('prueba'), 'el cuerpo servido es el HTML dado al servicio');

  /* Caso 5 (primera mitad): ese GET no deja «Origen rechazado»
     en el Registro. */
  const reg = await h.call('GET', '/api/registro?limit=300', undefined, { 'x-pacosat-token': token });
  assert.equal(reg.status, 200, 'el Registro responde con el token de la propia navegación');
  assert.ok(!reg.text.includes('Origen rechazado'),
    'la navegación externa aceptada no deja entrada «Origen rechazado» en el Registro');
  console.log('OK 2.3.1 · A1 — GET / cross-site + navigate sin Origin: 200 con el HTML y su token; sin «Origen rechazado» en el Registro.');
}

/* ---------- Caso 2: la llegada tecleada (sec-fetch-site: none) sigue entrando ---------- */
{
  const tecleada = await h.raw('GET', '/', undefined, { 'sec-fetch-site': 'none' });
  assert.equal(tecleada.status, 200, 'la llegada tecleada (sec-fetch-site: none) sigue en 200');
  assert.ok(tecleada.text.includes('name="pacosat-token"'), 'también sirve el HTML de la app con su token');
  console.log('OK 2.3.1 · A2 — GET / con sec-fetch-site: none: 200.');
}

/* ---------- Caso 3: fuera de las navegaciones, el guardián sigue vivo ---------- */
{
  const cors = await h.raw('GET', '/', undefined,
    { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors' });
  assert.equal(cors.status, 403, 'cross-site sin ser navegación (mode: cors) sigue rechazado');
  let json = null; try { json = JSON.parse(cors.text); } catch { /* no es JSON */ }
  assert.equal(json?.error, MENSAJE, 'el rechazo no-navegación dice el mensaje llano de siempre');
  console.log('OK 2.3.1 · A3 — GET / cross-site con sec-fetch-mode: cors: 403 (el guardián sigue vivo fuera de las navegaciones).');
}

/* ---------- Casos 4 y 5 (segunda mitad): el POST extranjero sigue en 403 llano y anotado ---------- */
{
  const post = await h.call('POST', '/api/mail/alerts', { enabled: true },
    { 'x-pacosat-token': token, origin: 'https://otro-sitio.example' });
  assert.equal(post.status, 403, 'un POST de mutación con Origin extranjero sigue rechazado');
  assert.equal(post.json?.error, MENSAJE, 'el POST rechazado dice el mensaje llano actual');

  const reg = await h.call('GET', '/api/registro?limit=300', undefined, { 'x-pacosat-token': token });
  assert.equal(reg.status, 200);
  assert.ok(reg.text.includes('Origen rechazado') && reg.text.includes('https://otro-sitio.example') &&
    reg.text.includes('/api/mail/alerts'),
    'el Registro sí guarda el rechazo del POST, con el origen recibido y la ruta pedida');
  console.log('OK 2.3.1 · A4 — POST con Origin extranjero: 403 en llano y constancia en el Registro.');
}
h.service.close();
