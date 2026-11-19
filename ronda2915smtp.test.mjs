import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { DOMParser } from '@xmldom/xmldom';
import { createPacoSATService } from './local-server.mjs';
import { encryptSecret } from './secret-box.mjs';

/* ================================================================
   Ronda 2.9.15 · A3 — la contraseña SMTP (y la del respaldo)
   salen del archivo de arranque CIFRADAS y se descifran solo
   en memoria.

   La auditoría encontró la cadena en claro: compose pasa
   PACOSAT_STARTUP_CONFIG → bootstrap hace JSON.parse →
   configureMail entrega x.password tal cual a nodemailer.
   Desde esta ronda, bootstrap descifra con la caja de
   secretos del equipo (decryptSecret, AES-256-GCM) antes de
   crear el transporte — y lo mismo con la contraseña del
   respaldo programado, cuya regla de 12 caracteres mide el
   valor real, no el cifrado —. Lo legado en claro sigue
   funcionando (decryptSecret lo devuelve tal cual).

   Pruebas, contra el servicio real:
   (1) mail.password en «enc:v1:…» → el transporte nace con la
       contraseña descifrada; el objeto de arranque NO se
       muta (en reposo queda el cifrado).
   (2) mail.password legado en claro → el transporte nace con
       ese mismo valor (compatibilidad total).
   (3) backup.password cifrado de una contraseña CORTA (5) →
       el respaldo NO queda configurado: la regla de 12 mide
       el valor descifrado (antes del arreglo, la longitud
       del cifrado la habría dejado pasar).
   (4) backup.password cifrado de una contraseña válida →
       el respaldo queda configurado.
   La llave de la caja sale de PACOSAT_SECRET_KEY (entorno de
   la prueba): cifrar y descifrar comparten llave sin tocar
   disco.
   ================================================================ */
process.env.PACOSAT_SECRET_KEY = 'llave-de-prueba-2915';
const AQUI = dirname(fileURLToPath(import.meta.url));
const KEY = 'd'.repeat(64);
const OWN = 'AAA010101AAA';
const TIME = Date.parse('2026-11-19T16:00:00Z');

const dir = mkdtempSync(join(tmpdir(), 'pacosat-2915-smtp-'));
const dbFile = join(dir, 'pacosat.sqlite');
const transportes = [];
let service = null;
const server = createServer((req, res) => { req.headers['x-pacosat-proxy'] = KEY; service.handle(req, res); });
await new Promise(r => server.listen(0, '127.0.0.1', r));
const ORIGIN = 'http://127.0.0.1:' + server.address().port;
const makeService = () => createPacoSATService({
  dbFile, html: readFileSync(join(AQUI, 'Faro-Fiscal.html'), 'utf8'),
  lazyParts: JSON.parse(readFileSync(join(AQUI, 'lazy.json'), 'utf8')),
  capacidades: JSON.parse(readFileSync(join(AQUI, 'capacidades.json'), 'utf8')),
  origin: ORIGIN, proxyKey: KEY, satDocRetryWaitMs: 5,
  makeConnector: () => ({ parser: DOMParser, connector: {
    request: async () => 'req-smtp', check: async () => ({ status: 'pending', packages: [] }),
    download: async () => { throw new Error('sin paquetes'); } } }),
  makeMailer: opts => { transportes.push(opts); return { verify: async () => true, sendMail: async () => ({ messageId: 'm1' }) }; },
  now: () => TIME });

{
  service = makeService(); service.close();
  const db = new DatabaseSync(dbFile);
  db.prepare('INSERT INTO profiles(rfc, minutes, days, direction, nextRun, error) VALUES (?,?,?,?,?,?)')
    .run(OWN, 1440, 30, 'both', 0, '');
  db.prepare("INSERT INTO records(store,id,value) VALUES ('people',?,?)")
    .run(OWN, JSON.stringify({ id: OWN, name: 'Empresa de Prueba, S.A.' }));
  db.close();
}
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
await call('POST', '/api/unlock', { rfc: OWN, minutes: 1440, days: 7, direction: 'both',
  password: 'simulated', certificate: 'YQ==', key: 'Yg==' });

const correoBase = { host: 'smtp.prueba.mx', port: 587, security: 'starttls',
  from: 'avisos@prueba.mx', recipient: 'paco@prueba.mx', user: 'avisos@prueba.mx' };

/* (1) Cifrada en el arranque → descifrada solo en memoria. */
const cifrada = encryptSecret(dir, 'clave-smtp-real');
assert.ok(cifrada.startsWith('enc:v1:'), 'la caja produce el formato enc:v1:');
const arranque1 = { mail: { ...correoBase, password: cifrada } };
await service.bootstrap(arranque1);
assert.equal(transportes.at(-1)?.auth?.pass, 'clave-smtp-real',
  'el transporte nace con la contraseña SMTP descifrada en memoria');
assert.equal(arranque1.mail.password, cifrada,
  'el objeto de arranque no se muta: en reposo queda el valor cifrado');

/* (2) Legado en claro → compatibilidad total. */
await service.bootstrap({ mail: { ...correoBase, password: 'legado-en-claro' } });
assert.equal(transportes.at(-1)?.auth?.pass, 'legado-en-claro',
  'una contraseña legada en claro sigue funcionando tal cual');

/* (3) y (4) El respaldo: la regla de 12 mide el valor real. */
const respaldoPuesta = async () => {
  const salud = await call('GET', '/api/salud');
  const tarjeta = (salud.json?.tarjetas || []).find(t => t.id === 'respaldo');
  return tarjeta?.datos?.contrasenaPuesta;
};
await service.bootstrap({ backup: { password: encryptSecret(dir, 'corta'), frequency: 'daily' } });
assert.equal(await respaldoPuesta(), false,
  'cifrado de contraseña corta: el respaldo NO se configura (la regla mide el valor descifrado)');
await service.bootstrap({ backup: { password: encryptSecret(dir, 'clave-respaldo-larga'), frequency: 'daily' } });
assert.equal(await respaldoPuesta(), true,
  'cifrado de contraseña válida: el respaldo queda configurado');

service.close(); server.close();
console.log('ronda2915smtp: la SMTP y la del respaldo se descifran solo en memoria desde el arranque cifrado; lo legado en claro sigue vivo.');
