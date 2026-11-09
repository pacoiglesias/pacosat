import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createPacoSATService } from './local-server.mjs';

/* e.firma desde la app (1.6.12): «Probar y guardar» con validación
   completa ANTES de escribir — RFC del certificado, caducidad y pareja
   llave/contraseña — y persistencia en la carpeta protegida, fuera de
   la BD y de los respaldos. El certificado de juguete trae el RFC
   MFI6212158B4 en su serialNumber y caduca en 2036; el conector de
   juguete solo acepta la contraseña convenida. Nada toca el SAT real. */
const CER = 'MIIDUzCCAjugAwIBAgIUH2WzMvVXT5BC2dNEzTaqRKJcZVUwDQYJKoZIhvcNAQELBQAwOTEgMB4GA1UEAwwXRU1QUkVTQSBQUlVFQkEgU0EgREUgQ1YxFTATBgNVBAUTDE1GSTYyMTIxNThCNDAeFw0yNjExMDkwNTA0MzVaFw0zNjExMDYwNTA0MzVaMDkxIDAeBgNVBAMMF0VNUFJFU0EgUFJVRUJBIFNBIERFIENWMRUwEwYDVQQFEwxNRkk2MjEyMTU4QjQwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQDJv/UPUgh/H1XwYFWUj2DV8HVVL95Z3LSi7P5yC1m2hcXlGVyvrc9EwIxTYuKVndt3mZyafViTg7Zng3wPs/bkZIhWcXTBkFPy8/4OZF4HKhgQTByszYEqBo4hr6o98FqS638cXcIkAzKFaIhpIJUpFMmUyKlSLgdWRcW7gm4SF2TaWYWi5CBok6gSoWsbmvEdFa0BbSCTxUUOxxWeoqhaMeYgN+PYpLWkl8Iq7VZJ+JeH0LMvbKg6Bhug0KOnC3/yNSBDIrg+A1rOysN8JJOU76zPuqj6aki7+oAEZIpGcu6h3cri7S8qq3zYupFdmZHwRySGDRci3ZpyCqjlFB97AgMBAAGjUzBRMB0GA1UdDgQWBBQYRYXN6Lv4Ke+TNpNWj7H1tqkEpTAfBgNVHSMEGDAWgBQYRYXN6Lv4Ke+TNpNWj7H1tqkEpTAPBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUAA4IBAQC8EwF8xC42pm/jFhTaO/gp2LDiSfz5cIJyZe9XsbczupYA9moD0Y9qMdEFAqgSVmFqJNgE675d5meRJdvRariROlpN3BZfcvPDEqHnwjqzjgHBt9e+GYb8UzdvkWiJuN7hoWgs2m+AJdPnsIWopKVI8enqng9Un7LbzCkACmJuG03Y+N7uuT/jIE+hNBHLJI6S9CGGs3hr8S4eZ2ijQeYyrWtLoeadLFsp4QqDb/JqXGtrIWFH9p3TNDEvyyVsYUBXSBIxX9zf/EYQ9NMLqIVSJ5hR/GjmDPf0plFteYQZEhRohrXnAox6clkDaIqTJkzWHhY4PHCPn+sJAh+Jzz8Y';
const KEY = 'MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDJv/UPUgh/H1XwYFWUj2DV8HVVL95Z3LSi7P5yC1m2hcXlGVyvrc9EwIxTYuKVndt3mZyafViTg7Zng3wPs/bkZIhWcXTBkFPy8/4OZF4HKhgQTByszYEqBo4hr6o98FqS638cXcIkAzKFaIhpIJUpFMmUyKlSLgdWRcW7gm4SF2TaWYWi5CBok6gSoWsbmvEdFa0BbSCTxUUOxxWeoqhaMeYgN+PYpLWkl8Iq7VZJ+JeH0LMvbKg6Bhug0KOnC3/yNSBDIrg+A1rOysN8JJOU76zPuqj6aki7+oAEZIpGcu6h3cri7S8qq3zYupFdmZHwRySGDRci3ZpyCqjlFB97AgMBAAECggEADYRMYA86yCrqdZU8C/ItO+LajES4QiSyKjD0Uoy7ISpGRMqrCzl7Elv6Kti3CJd6bZa/nMQldpX+VwzCokSy7RYP4lwYmqKs/9vkBhp9suou5uH1O931jOzCggmZv4DxIzh0RuDAkewa6urtf2mc72iCoZ1uEWD0bI3L09EccclmqMihSGfwiihOwAWo2/1qM3ZOKraGe/AT2eUrGwfKqJKWIAzp6ec6cWHt+YtmQY+JtcpQcNVjPewosVD3xRV60knDaFKwCZeRmYQ9jZhFAoOA57nkRshPhejKV8iNvA1tdWWrqpRL/UjtpIs3y2jBfFtGNFL0oZMpWKhQSRFCzQKBgQDqRQ8hFqINPgwKorrZ676TkPPhQ2Ag2anCq0YCK84qPfRArhnwEVYbrzw9TEyF0RRn6DE22S+QzbGgjTDTcSbuBEY2jKlwgXZjGRa/NEN+rl+JWBtw02vk1l5EDBPCjXdxP7r7opL57yUU7UamnW/MBMhxG9tdSI6u6yEpi0vTBwKBgQDcdq8Wn5oRQYKYuXcZIbxEnsTuP0TQFev8Kplb91wB8SPxQt6glKmQQRJdztXX1JrOJoQUUy2Rlt43LxXh1aOWOm6TdTAeI+gOKUn/c4KYVq3yKw1sD61SNV7Oh8lZrb1laVavou0KbuKi4C3ifkmI/IYVFiaD0sKoGZ98GjWu7QKBgQDG3A5GqR6wHP49vPrdZzbjroTGr9mWqQ1oWNjZmPOted+vU9pipWSxpWN+KRk/8kXfGgNEqsGsql5gidlrcr54BprPTUG7ZbnnzvE3JxcwHrasMGVCtcT9gFaObq4LVOiR8mY3mj4m+LBCflOdtUCkL18yXFIuchvkMWV6DWs02wKBgEyOkkKC7ddsLlOmo+sAQgZ6M9yf799qnWYVzOeYwESUXmzbUb/ln/ROBHi66JtoYtGPonIEaGCUSVpUaX7g10vFwrxGB42P3nd8cwvYKtOH1iOwO5r43rEbg26ozIztvkVHDSk0pKfo1Z7FxmlOfW6qck1EQd+pApupOi64U0gJAoGBAJrkBt1d6wppq6p+RvwvIEm63/DuF80Cx/kG7YMEfJ3GQUQYmOxgIRniLZEitYSV2w3prwb/oBBu8TBsmM0nzFj/0SylLBWylVOKTtg8fxl7nEaJLJhjCyJAHtSgwtFnwLLNb2kBj2tR0BR2cT9H4wzwI0yNk0I7iEc6qsZ6FzGy';
const RFC = 'MFI6212158B4';
const origin = 'http://127.0.0.1:17380';
const NOW = Date.parse('2026-11-08T12:00:00Z');
const dir = mkdtempSync(join(tmpdir(), 'pacosat-efirma-'));
let connectorCalls = 0;
function makeService(nowValue = NOW) {
  return createPacoSATService({ dbFile: ':memory:', html: '<!--PACOSAT_TOKEN-->', origin, now: () => nowValue,
    efirmaDir: dir,
    makeConnector: async ({ password }) => {
      connectorCalls++;
      if (password !== 'buena-efirma') throw new Error('La contraseña no abre la llave.');
      return { fake: true };
    },
    makeMailer: () => ({ verify: async () => true, sendMail: async () => {} }) });
}
async function harness(service) {
  let token;
  const call = async (path, data) => {
    const headers = { host: new URL(origin).host, origin, 'x-pacosat-token': token };
    const req = Object.assign(Readable.from(data === undefined ? [] : [Buffer.from(JSON.stringify(data))]), {
      url: path, method: data === undefined ? 'GET' : 'POST', headers });
    let response;
    const res = { setHeader() {}, writeHead(status) { this.status = status; },
      end(content) { response = new Response(content, { status: this.status }); } };
    await service.handle(req, res);
    return response;
  };
  token = (await (await call('/')).text()).split('content="')[1].split('"')[0];
  return call;
}
const payload = (over = {}) => ({ rfc: RFC, minutes: 360, days: 7, direction: 'received',
  certificate: CER, key: KEY, password: 'buena-efirma', ...over });

const service = makeService();
const call = await harness(service);
/* RFC que no coincide con el certificado: rechazo claro, sin escribir. */
let response = await call('/api/efirma', payload({ rfc: 'AAA010101AAA' }));
assert.equal(response.status, 400);
assert.match((await response.json()).error, /certificado es del RFC MFI6212158B4/);
assert.equal(existsSync(join(dir, 'AAA010101AAA.cer')), false);
/* Contraseña que no abre la llave: 422 y tampoco se escribe nada. */
response = await call('/api/efirma', payload({ password: 'mala' }));
assert.equal(response.status, 422);
assert.equal(existsSync(join(dir, RFC + '.cer')), false);
assert.equal(existsSync(join(dir, 'perfiles.json')), false);
/* Todo correcto: se guarda en la carpeta protegida y queda activo. */
response = await call('/api/efirma', payload());
assert.equal(response.status, 200);
const state = await response.json();
assert.equal(state.profiles.length, 1);
assert.equal(state.profiles[0].unlocked, true);
assert.equal(state.profiles[0].efirmaStored, true);
assert.ok(state.profiles[0].certExpires > NOW);
assert.equal(readFileSync(join(dir, RFC + '.cer')).length > 0, true);
assert.equal(statSync(join(dir, RFC + '.key')).mode & 0o077, 0);
const index = JSON.parse(readFileSync(join(dir, 'perfiles.json'), 'utf8'));
assert.equal(index[RFC].minutes, 360);
/* Caducada a ojos del reloj del servicio: rechazo sin sobrescribir. */
const future = makeService(Date.parse('2040-01-01T00:00:00Z'));
const futureCall = await harness(future);
response = await futureCall('/api/efirma', payload());
assert.equal(response.status, 400);
assert.match((await response.json()).error, /caducó el/);
/* Un servicio nuevo con la misma carpeta reactiva el perfil solo con
   bootstrap (sin pasar por unlock): la persistencia prometida. */
const revived = makeService();
const revivedCall = await harness(revived);
await revived.bootstrap({});
const revivedState = await (await revivedCall('/api/status')).json();
assert.equal(revivedState.profiles.length, 1);
assert.equal(revivedState.profiles[0].unlocked, true);
assert.equal(revivedState.profiles[0].minutes, 360);
assert.ok(connectorCalls >= 3);
console.log('OK: e.firma desde la app — validación previa (RFC, caducidad, pareja), guardado protegido y reactivación al arrancar.');
