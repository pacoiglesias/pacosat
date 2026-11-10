import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPacoSATService } from './local-server.mjs';

/* Visor en línea de documentos (1.10.2): la ruta GET /api/files/view
   sirve el PDF archivado INLINE —content-type del fichero,
   «content-disposition: inline» y los bytes exactos— solo para
   documentos de Expedientes (con fila en la tienda 'documents'), y
   el invitado queda dentro de su alcance por RFC: fuera de él, el
   documento no existe (404). La descarga del diario
   (/api/satdocs/artifact) sigue saliendo como attachment, como
   siempre. Nunca el SAT real: puertos de juguete. */
const origin = 'https://pacosat.example.com';
const proxyKey = 'b'.repeat(64);
const RFC = 'MFI6212158B4';
const OTRO = 'OTRO010101XX1';
const CER = 'MIIDUzCCAjugAwIBAgIUH2WzMvVXT5BC2dNEzTaqRKJcZVUwDQYJKoZIhvcNAQELBQAwOTEgMB4GA1UEAwwXRU1QUkVTQSBQUlVFQkEgU0EgREUgQ1YxFTATBgNVBAUTDE1GSTYyMTIxNThCNDAeFw0yNjExMDkwNTA0MzVaFw0zNjExMDYwNTA0MzVaMDkxIDAeBgNVBAMMF0VNUFJFU0EgUFJVRUJBIFNBIERFIENWMRUwEwYDVQQFEwxNRkk2MjEyMTU4QjQwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQDJv/UPUgh/H1XwYFWUj2DV8HVVL95Z3LSi7P5yC1m2hcXlGVyvrc9EwIxTYuKVndt3mZyafViTg7Zng3wPs/bkZIhWcXTBkFPy8/4OZF4HKhgQTByszYEqBo4hr6o98FqS638cXcIkAzKFaIhpIJUpFMmUyKlSLgdWRcW7gm4SF2TaWYWi5CBok6gSoWsbmvEdFa0BbSCTxUUOxxWeoqhaMeYgN+PYpLWkl8Iq7VZJ+JeH0LMvbKg6Bhug0KOnC3/yNSBDIrg+A1rOysN8JJOU76zPuqj6aki7+oAEZIpGcu6h3cri7S8qq3zYupFdmZHwRySGDRci3ZpyCqjlFB97AgMBAAGjUzBRMB0GA1UdDgQWBBQYRYXN6Lv4Ke+TNpNWj7H1tqkEpTAfBgNVHSMEGDAWgBQYRYXN6Lv4Ke+TNpNWj7H1tqkEpTAPBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUAA4IBAQC8EwF8xC42pm/jFhTaO/gp2LDiSfz5cIJyZe9XsbczupYA9moD0Y9qMdEFAqgSVmFqJNgE675d5meRJdvRariROlpN3BZfcvPDEqHnwjqzjgHBt9e+GYb8UzdvkWiJuN7hoWgs2m+AJdPnsIWopKVI8enqng9Un7LbzCkACmJuG03Y+N7uuT/jIE+hNBHLJI6S9CGGs3hr8S4eZ2ijQeYyrWtLoeadLFsp4QqDb/JqXGtrIWFH9p3TNDEvyyVsYUBXSBIxX9zf/EYQ9NMLqIVSJ5hR/GjmDPf0plFteYQZEhRohrXnAox6clkDaIqTJkzWHhY4PHCPn+sJAh+Jzz8Y';
const KEY = 'MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDJv/UPUgh/H1XwYFWUj2DV8HVVL95Z3LSi7P5yC1m2hcXlGVyvrc9EwIxTYuKVndt3mZyafViTg7Zng3wPs/bkZIhWcXTBkFPy8/4OZF4HKhgQTByszYEqBo4hr6o98FqS638cXcIkAzKFaIhpIJUpFMmUyKlSLgdWRcW7gm4SF2TaWYWi5CBok6gSoWsbmvEdFa0BbSCTxUUOxxWeoqhaMeYgN+PYpLWkl8Iq7VZJ+JeH0LMvbKg6Bhug0KOnC3/yNSBDIrg+A1rOysN8JJOU76zPuqj6aki7+oAEZIpGcu6h3cri7S8qq3zYupFdmZHwRySGDRci3ZpyCqjlFB97AgMBAAECggEADYRMYA86yCrqdZU8C/ItO+LajES4QiSyKjD0Uoy7ISpGRMqrCzl7Elv6Kti3CJd6bZa/nMQldpX+VwzCokSy7RYP4lwYmqKs/9vkBhp9suou5uH1O931jOzCggmZv4DxIzh0RuDAkewa6urtf2mc72iCoZ1uEWD0bI3L09EccclmqMihSGfwiihOwAWo2/1qM3ZOKraGe/AT2eUrGwfKqJKWIAzp6ec6cWHt+YtmQY+JtcpQcNVjPewosVD3xRV60knDaFKwCZeRmYQ9jZhFAoOA57nkRshPhejKV8iNvA1tdWWrqpRL/UjtpIs3y2jBfFtGNFL0oZMpWKhQSRFCzQKBgQDqRQ8hFqINPgwKorrZ676TkPPhQ2Ag2anCq0YCK84qPfRArhnwEVYbrzw9TEyF0RRn6DE22S+QzbGgjTDTcSbuBEY2jKlwgXZjGRa/NEN+rl+JWBtw02vk1l5EDBPCjXdxP7r7opL57yUU7UamnW/MBMhxG9tdSI6u6yEpi0vTBwKBgQDcdq8Wn5oRQYKYuXcZIbxEnsTuP0TQFev8Kplb91wB8SPxQt6glKmQQRJdztXX1JrOJoQUUy2Rlt43LxXh1aOWOm6TdTAeI+gOKUn/c4KYVq3yKw1sD61SNV7Oh8lZrb1laVavou0KbuKi4C3ifkmI/IYVFiaD0sKoGZ98GjWu7QKBgQDG3A5GqR6wHP49vPrdZzbjroTGr9mWqQ1oWNjZmPOted+vU9pipWSxpWN+KRk/8kXfGgNEqsGsql5gidlrcr54BprPTUG7ZbnnzvE3JxcwHrasMGVCtcT9gFaObq4LVOiR8mY3mj4m+LBCflOdtUCkL18yXFIuchvkMWV6DWs02wKBgEyOkkKC7ddsLlOmo+sAQgZ6M9yf799qnWYVzOeYwESUXmzbUb/ln/ROBHi66JtoYtGPonIEaGCUSVpUaX7g10vFwrxGB42P3nd8cwvYKtOH1iOwO5r43rEbg26ozIztvkVHDSk0pKfo1Z7FxmlOfW6qck1EQd+pApupOi64U0gJAoGBAJrkBt1d6wppq6p+RvwvIEm63/DuF80Cx/kG7YMEfJ3GQUQYmOxgIRniLZEitYSV2w3prwb/oBBu8TBsmM0nzFj/0SylLBWylVOKTtg8fxl7nEaJLJhjCyJAHtSgwtFnwLLNb2kBj2tR0BR2cT9H4wzwI0yNk0I7iEc6qsZ6FzGy';
let time = Date.parse('2026-11-10T15:00:00Z');
let portalDown = false;
const service = createPacoSATService({ dbFile: ':memory:', html: '<!--PACOSAT_TOKEN-->', origin, proxyKey, now: () => time,
  efirmaDir: mkdtempSync(join(tmpdir(), 'pacosat-visor-')),
  makeConnector: async ({ password }) => {
    if (password !== 'buena-efirma') throw new Error('La contraseña no abre la llave.');
    return { parser: class {}, connector: {} };
  },
  makeMailer: () => ({ verify: async () => true, sendMail: async () => {} }),
  satDocFetch: async (profile, kind) => {
    assert.equal(profile.rfc, RFC);
    if (portalDown) {
      const error = new Error('portal de juguete caído');
      error.diag = { url: 'https://login.example.test/fiel',
        screenshot: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]),
        html: '<html><body>Acceso con e.firma</body></html>' };
      throw error;
    }
    return { content: Buffer.from('%PDF-1.4 ' + kind), issuedAt: new Date(time).toISOString(), fileName: kind + '.pdf' };
  } });
let token;
async function call(path, data, overrides = {}) {
  const headers = { host: 'pacosat.example.com', origin, 'x-pacosat-proxy': proxyKey,
    'x-pacosat-token': token, ...overrides };
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
  token = (await call('/')).text().match(/content="([^"]+)"/)[1];
  const adminToken = token;

  /* Semilla del perfil por la vía real de la app (1.6.12). */
  let res = await call('/api/efirma', { rfc: RFC, certificate: CER, key: KEY, password: 'buena-efirma', minutes: 360, days: 30, direction: 'received' });
  assert.equal(res.status, 200);

  /* Constancia subida a mano: queda archivada en Expedientes. */
  const PDF_MANUAL = Buffer.from('%PDF-1.4 VISOR-1102-CONTENIDO-EXACTO');
  res = await call('/api/satdocs/upload', { rfc: RFC, kind: 'constancia', date: '2026-11-02',
    name: 'constancia-prueba.pdf', content: PDF_MANUAL.toString('base64') });
  assert.equal(res.status, 200);
  let view = (await call('/api/satdocs')).json().profiles[0];
  assert.ok(view.constancia.fileId?.startsWith('pdf:'), 'el resumen de la tarjeta trae el fileId para poder verla');

  /* LA RUTA INLINE: 200, content-type del fichero, disposición
     inline con el nombre del documento y los bytes exactos. */
  res = await call('/api/files/view?id=' + encodeURIComponent(view.constancia.fileId));
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'application/pdf');
  assert.ok(res.headers['content-disposition']?.startsWith('inline;'), 'se sirve inline, no como descarga: ' + res.headers['content-disposition']);
  assert.ok(res.headers['content-disposition'].includes('constancia-prueba.pdf'), 'la disposición lleva el nombre del documento');
  assert.ok(res.buffer.equals(PDF_MANUAL), 'los bytes servidos son los del PDF archivado');

  /* Id desconocido o ausente: 404. */
  assert.equal((await call('/api/files/view?id=pdf:no-existe')).status, 404);
  assert.equal((await call('/api/files/view')).status, 404);

  /* Un fichero guardado SIN fila de documento en Expedientes no se
     sirve por esta ruta: el visor es de documentos archivados. */
  res = await call('/api/storage', { batch: { files: [{ id: 'pdf:huerfano', mime: 'application/pdf',
    content: Buffer.from('%PDF-1.4 huerfano').toString('base64') }] } });
  assert.equal(res.status, 200);
  assert.equal((await call('/api/files/view?id=pdf:huerfano')).status, 404);

  /* La opinión descargada del «portal» también se ve en línea. */
  res = await call('/api/satdocs/run', { rfc: RFC, kind: 'opinion' });
  assert.equal(res.status, 200);
  view = (await call('/api/satdocs')).json().profiles[0];
  res = await call('/api/files/view?id=' + encodeURIComponent(view.opinion.fileId));
  assert.equal(res.status, 200);
  assert.ok(res.headers['content-disposition']?.startsWith('inline;'));
  assert.ok(res.buffer.equals(Buffer.from('%PDF-1.4 opinion')));

  /* La DESCARGA de siempre no cambia: el artefacto del diario
     sigue saliendo como attachment. */
  portalDown = true;
  res = await call('/api/satdocs/run', { rfc: RFC, kind: 'constancia' });
  assert.equal(res.json().results.constancia.ok, false);
  portalDown = false;
  view = (await call('/api/satdocs')).json().profiles[0];
  const shotRun = view.runs.find(run => run.hasShot);
  assert.ok(shotRun, 'la corrida fallida con diagnóstico quedó en el diario');
  res = await call('/api/satdocs/artifact?run=' + shotRun.id + '&part=shot');
  assert.equal(res.status, 200);
  assert.ok(res.headers['content-disposition']?.startsWith('attachment'), 'el artefacto del diario sigue siendo descarga');

  /* INVITADO fuera de alcance: el documento no existe para él. */
  res = await call('/api/guest/config', { password: 'invitado-1102', enabled: true, rfcs: [OTRO] });
  assert.equal(res.status, 200);
  const guestLogin = (await call('/api/guest/login', { password: 'invitado-1102' })).json();
  assert.ok(guestLogin.token, 'sesión de invitado emitida');
  const constanciaId = view.constancia.fileId;
  token = guestLogin.token;
  res = await call('/api/files/view?id=' + encodeURIComponent(constanciaId));
  assert.equal(res.status, 404, 'fuera de su alcance por RFC, el invitado no ve el documento');
  /* Y el resto de rutas de constancias sigue fuera de su alcance. */
  assert.equal((await call('/api/satdocs')).status, 403);

  /* INVITADO dentro de alcance: ve el mismo PDF, en línea. */
  token = adminToken;
  res = await call('/api/guest/config', { rfcs: [RFC] });
  assert.equal(res.status, 200);
  token = guestLogin.token;
  res = await call('/api/files/view?id=' + encodeURIComponent(constanciaId));
  assert.equal(res.status, 200, 'dentro de su alcance, el invitado sí ve el documento');
  assert.ok(res.headers['content-disposition']?.startsWith('inline;'));
  assert.ok(res.buffer.equals(PDF_MANUAL));

  /* Sin sesión válida no hay visor: 403. */
  token = 'token-basura';
  assert.equal((await call('/api/files/view?id=' + encodeURIComponent(constanciaId))).status, 403);
  token = adminToken;

  console.log('ronda1102.test: ok — visor en línea inline con bytes exactos, solo documentos de Expedientes, invitado dentro/fuera de alcance y descarga del diario intacta.');
} finally { await service.close(); }
