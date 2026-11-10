import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPacoSATService } from './local-server.mjs';

/* Constancias y opinión (1.6.14): puerto de descarga de juguete,
   archivo en Expedientes, envío por correo con adjunto, semáforo de
   antigüedad, subida manual y programador mensual. Nunca el SAT real. */
const origin = 'http://127.0.0.1:43733';
const RFC = 'MFI6212158B4';
const CER = 'MIIDUzCCAjugAwIBAgIUH2WzMvVXT5BC2dNEzTaqRKJcZVUwDQYJKoZIhvcNAQELBQAwOTEgMB4GA1UEAwwXRU1QUkVTQSBQUlVFQkEgU0EgREUgQ1YxFTATBgNVBAUTDE1GSTYyMTIxNThCNDAeFw0yNjExMDkwNTA0MzVaFw0zNjExMDYwNTA0MzVaMDkxIDAeBgNVBAMMF0VNUFJFU0EgUFJVRUJBIFNBIERFIENWMRUwEwYDVQQFEwxNRkk2MjEyMTU4QjQwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQDJv/UPUgh/H1XwYFWUj2DV8HVVL95Z3LSi7P5yC1m2hcXlGVyvrc9EwIxTYuKVndt3mZyafViTg7Zng3wPs/bkZIhWcXTBkFPy8/4OZF4HKhgQTByszYEqBo4hr6o98FqS638cXcIkAzKFaIhpIJUpFMmUyKlSLgdWRcW7gm4SF2TaWYWi5CBok6gSoWsbmvEdFa0BbSCTxUUOxxWeoqhaMeYgN+PYpLWkl8Iq7VZJ+JeH0LMvbKg6Bhug0KOnC3/yNSBDIrg+A1rOysN8JJOU76zPuqj6aki7+oAEZIpGcu6h3cri7S8qq3zYupFdmZHwRySGDRci3ZpyCqjlFB97AgMBAAGjUzBRMB0GA1UdDgQWBBQYRYXN6Lv4Ke+TNpNWj7H1tqkEpTAfBgNVHSMEGDAWgBQYRYXN6Lv4Ke+TNpNWj7H1tqkEpTAPBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUAA4IBAQC8EwF8xC42pm/jFhTaO/gp2LDiSfz5cIJyZe9XsbczupYA9moD0Y9qMdEFAqgSVmFqJNgE675d5meRJdvRariROlpN3BZfcvPDEqHnwjqzjgHBt9e+GYb8UzdvkWiJuN7hoWgs2m+AJdPnsIWopKVI8enqng9Un7LbzCkACmJuG03Y+N7uuT/jIE+hNBHLJI6S9CGGs3hr8S4eZ2ijQeYyrWtLoeadLFsp4QqDb/JqXGtrIWFH9p3TNDEvyyVsYUBXSBIxX9zf/EYQ9NMLqIVSJ5hR/GjmDPf0plFteYQZEhRohrXnAox6clkDaIqTJkzWHhY4PHCPn+sJAh+Jzz8Y';
const KEY = 'MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDJv/UPUgh/H1XwYFWUj2DV8HVVL95Z3LSi7P5yC1m2hcXlGVyvrc9EwIxTYuKVndt3mZyafViTg7Zng3wPs/bkZIhWcXTBkFPy8/4OZF4HKhgQTByszYEqBo4hr6o98FqS638cXcIkAzKFaIhpIJUpFMmUyKlSLgdWRcW7gm4SF2TaWYWi5CBok6gSoWsbmvEdFa0BbSCTxUUOxxWeoqhaMeYgN+PYpLWkl8Iq7VZJ+JeH0LMvbKg6Bhug0KOnC3/yNSBDIrg+A1rOysN8JJOU76zPuqj6aki7+oAEZIpGcu6h3cri7S8qq3zYupFdmZHwRySGDRci3ZpyCqjlFB97AgMBAAECggEADYRMYA86yCrqdZU8C/ItO+LajES4QiSyKjD0Uoy7ISpGRMqrCzl7Elv6Kti3CJd6bZa/nMQldpX+VwzCokSy7RYP4lwYmqKs/9vkBhp9suou5uH1O931jOzCggmZv4DxIzh0RuDAkewa6urtf2mc72iCoZ1uEWD0bI3L09EccclmqMihSGfwiihOwAWo2/1qM3ZOKraGe/AT2eUrGwfKqJKWIAzp6ec6cWHt+YtmQY+JtcpQcNVjPewosVD3xRV60knDaFKwCZeRmYQ9jZhFAoOA57nkRshPhejKV8iNvA1tdWWrqpRL/UjtpIs3y2jBfFtGNFL0oZMpWKhQSRFCzQKBgQDqRQ8hFqINPgwKorrZ676TkPPhQ2Ag2anCq0YCK84qPfRArhnwEVYbrzw9TEyF0RRn6DE22S+QzbGgjTDTcSbuBEY2jKlwgXZjGRa/NEN+rl+JWBtw02vk1l5EDBPCjXdxP7r7opL57yUU7UamnW/MBMhxG9tdSI6u6yEpi0vTBwKBgQDcdq8Wn5oRQYKYuXcZIbxEnsTuP0TQFev8Kplb91wB8SPxQt6glKmQQRJdztXX1JrOJoQUUy2Rlt43LxXh1aOWOm6TdTAeI+gOKUn/c4KYVq3yKw1sD61SNV7Oh8lZrb1laVavou0KbuKi4C3ifkmI/IYVFiaD0sKoGZ98GjWu7QKBgQDG3A5GqR6wHP49vPrdZzbjroTGr9mWqQ1oWNjZmPOted+vU9pipWSxpWN+KRk/8kXfGgNEqsGsql5gidlrcr54BprPTUG7ZbnnzvE3JxcwHrasMGVCtcT9gFaObq4LVOiR8mY3mj4m+LBCflOdtUCkL18yXFIuchvkMWV6DWs02wKBgEyOkkKC7ddsLlOmo+sAQgZ6M9yf799qnWYVzOeYwESUXmzbUb/ln/ROBHi66JtoYtGPonIEaGCUSVpUaX7g10vFwrxGB42P3nd8cwvYKtOH1iOwO5r43rEbg26ozIztvkVHDSk0pKfo1Z7FxmlOfW6qck1EQd+pApupOi64U0gJAoGBAJrkBt1d6wppq6p+RvwvIEm63/DuF80Cx/kG7YMEfJ3GQUQYmOxgIRniLZEitYSV2w3prwb/oBBu8TBsmM0nzFj/0SylLBWylVOKTtg8fxl7nEaJLJhjCyJAHtSgwtFnwLLNb2kBj2tR0BR2cT9H4wzwI0yNk0I7iEc6qsZ6FzGy';
let time = Date.parse('2026-11-10T15:00:00Z');
const sent = [];
let portalDown = false;
let portalShot = false;
const service = createPacoSATService({ dbFile: ':memory:', html: '<!--PACOSAT_TOKEN-->', origin, now: () => time,
  efirmaDir: mkdtempSync(join(tmpdir(), 'pacosat-docs-')),
  makeConnector: async ({ password }) => {
    if (password !== 'buena-efirma') throw new Error('La contraseña no abre la llave.');
    return { parser: class {}, connector: {} };
  },
  makeMailer: () => ({ verify: async () => true, sendMail: async payload => { sent.push(payload); } }),
  satDocFetch: async (profile, kind) => {
    assert.equal(profile.rfc, RFC);
    if (portalDown) {
      const error = new Error('portal de juguete caído');
      if (portalShot) error.diag = { url: 'https://login.example.test/fiel',
        screenshot: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]),
        html: '<html><body>Acceso con e.firma</body></html>' };
      throw error;
    }
    return { content: Buffer.from('%PDF-1.4 ' + kind), issuedAt: new Date(time).toISOString(), fileName: kind + '.pdf' };
  } });
let token;
async function call(path, data, options = {}) {
  const headers = { host: new URL(origin).host, origin, 'x-pacosat-token': token, ...options };
  const req = Object.assign(Readable.from(data === undefined ? [] : [Buffer.from(JSON.stringify(data))]), {
    url: path, method: data === undefined ? 'GET' : 'POST', headers });
  let response;
  const res = { setHeader() {}, writeHead(status) { this.status = status; this.headersSent = true; },
    end(content) { response = new Response(content, { status: this.status }); } };
  await service.handle(req, res);
  return response;
}
try {
  const page = await (await call('/')).text();
  token = page.split('content="')[1].split('"')[0];
  /* Semilla del perfil por la vía real de la app (1.6.12). */
  let res = await call('/api/efirma', { rfc: RFC, certificate: CER, key: KEY, password: 'buena-efirma', minutes: 360, days: 30, direction: 'received' });
  assert.equal(res.status, 200);
  res = await call('/api/mail', { host: 'smtp.example.com', port: 587, user: 'u', password: 'p', from: 'from@example.com', recipient: 'avisos@example.com' });
  assert.equal(res.status, 200);

  /* Sin documentos: semáforo en «sin archivar». */
  let view = await (await call('/api/satdocs')).json();
  assert.equal(view.profiles.length, 1);
  assert.equal(view.profiles[0].constancia, null);

  /* Configuración: automática el día 5 a las 9, dos destinatarios. */
  res = await call('/api/satdocs/config', { rfc: RFC, enabled: true, day: 5, hour: 9, recipients: 'nora@example.com, paco@example.com' });
  assert.equal(res.status, 200);

  /* Descarga inmediata de ambas clases: archiva y envía con adjunto. */
  res = await call('/api/satdocs/run', { rfc: RFC });
  assert.equal(res.status, 200);
  const run = await res.json();
  assert.equal(run.results.constancia.ok, true);
  assert.equal(run.results.opinion.ok, true);
  view = run.profiles[0];
  assert.equal(view.constancia.level, 'ok');
  assert.equal(view.constancia.ageDays, 0);
  assert.equal(sent.length, 2);
  assert.ok(sent[0].attachments[0].content.length > 0);
  assert.ok(sent[0].to.includes('nora@example.com'));

  /* Programador: el tick no repite dentro del mismo mes… */
  await service.tick();
  assert.equal(sent.length, 2);
  /* …pero al mes siguiente, pasado el día fijado, renueva solo. */
  time = Date.parse('2026-12-10T10:00:00Z');
  await service.tick();
  assert.equal(sent.length, 4);

  /* Portal caído: el intento queda registrado como error y no rompe. */
  portalDown = true;
  res = await call('/api/satdocs/run', { rfc: RFC, kind: 'opinion' });
  const failed = await res.json();
  assert.equal(failed.results.opinion.ok, false);
  assert.ok(failed.profiles[0].lastError.includes('juguete'));
  portalDown = false;

  /* Diario y progreso (1.10.1): cada corrida queda en el diario
     con sus pasos en lenguaje llano; el progreso persistido dice
     el resultado final; sin foto del fallo, sus artefactos dan 404. */
  view = (await (await call('/api/satdocs')).json()).profiles[0];
  assert.equal(view.progress.running, false);
  assert.ok(view.progress.step.includes('juguete'));
  assert.ok(Array.isArray(view.runs) && view.runs.length >= 3, 'el diario guarda las corridas');
  const okRun = view.runs.find(run => run.ok);
  assert.ok(okRun, 'hay corridas buenas en el diario');
  assert.equal(okRun.steps[0].text, 'Conectando con el SAT…');
  assert.ok(okRun.steps.some(step => step.text === 'Guardando en Expedientes…'));
  const failedRun = view.runs.find(run => !run.ok);
  assert.ok(failedRun.error.includes('juguete'));
  assert.equal(failedRun.hasShot, false);
  res = await call('/api/satdocs/artifact?run=' + failedRun.id + '&part=shot');
  assert.equal(res.status, 404);
  res = await call('/api/satdocs/artifact?run=no-existe&part=shot');
  assert.equal(res.status, 404);
  /* Con la foto del fallo (error.diag del navegador): el diario la
     archiva y se puede bajar tal cual desde la app. */
  portalDown = true; portalShot = true;
  res = await call('/api/satdocs/run', { rfc: RFC, kind: 'constancia' });
  assert.equal((await res.json()).results.constancia.ok, false);
  portalDown = false; portalShot = false;
  view = (await (await call('/api/satdocs')).json()).profiles[0];
  const shotRun = view.runs.find(run => run.hasShot);
  assert.ok(shotRun && shotRun.hasHtml, 'la corrida con diagnóstico guarda captura y HTML');
  res = await call('/api/satdocs/artifact?run=' + shotRun.id + '&part=shot');
  assert.equal(res.status, 200);
  assert.deepEqual([...Buffer.from(await res.arrayBuffer())], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
  res = await call('/api/satdocs/artifact?run=' + shotRun.id + '&part=html');
  assert.equal(res.status, 200);
  assert.ok((await res.text()).includes('Acceso con e.firma'));

  /* Antigüedad: 75 días tras la renovación, el semáforo pasa a ámbar
     (y un documento viejo subido a mano NO desplaza al vigente). */
  time += 75 * 86400000;
  view = (await (await call('/api/satdocs')).json()).profiles[0];
  assert.equal(view.opinion.level, 'warn');
  assert.equal(view.opinion.ageDays, 75);
  /* Subida manual reciente: queda como vigente, marcada «manual». */
  const recent = new Date(time - 86400000).toISOString().slice(0, 10);
  res = await call('/api/satdocs/upload', { rfc: RFC, kind: 'constancia', date: recent,
    content: Buffer.from('%PDF-1.4 manual').toString('base64'), name: 'constancia.pdf' });
  assert.equal(res.status, 200);
  view = (await res.json()).profiles[0];
  assert.equal(view.constancia.level, 'ok');
  assert.equal(view.constancia.source, 'manual');

  /* Un archivo que no es PDF se rechaza. */
  res = await call('/api/satdocs/upload', { rfc: RFC, kind: 'opinion', date: recent,
    content: Buffer.from('no es pdf').toString('base64') });
  assert.equal(res.status, 400);

  console.log('satdocs.test: ok');
} finally { await service.close(); }
