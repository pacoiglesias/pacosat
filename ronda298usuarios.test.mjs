import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DOMParser } from '@xmldom/xmldom';
import { createPacoSATService } from './local-server.mjs';
import { parseXml } from './xml-core.mjs';

/* Ronda 2.9.8 · SERVIDOR — «Usuarios con nombre propio».
   Capa añadida sobre el invitado de siempre (que NO se toca):
   almacén de usuarios con contraseña scrypt, sesiones con
   nombre y huella, login/logout propios pre-puerta, alcance
   por RFC del usuario de lectura (M2: vacío = nada), poderes
   de administrador para el rol administrador salvo lo
   reservado al principal, y gestión de usuarios solo del
   principal.
   ROJO (comprobado contra el servidor SIN el cambio, antes de
   construir la pieza): la primera corrida murió en su primera
   aserción — «el principal crea a Nora»: POST /api/users
   respondió 404 en vez de 200 (ronda298usuarios.test.mjs:97,
   AssertionError 404 !== 200, 1 test fallido): las rutas
   /api/users no existían. */

const MFI = 'MFI6212158B4';
const EDE = 'EDE1902136T2';
const EMISOR = 'AAA010101AAA';
const ORIGIN = 'http://127.0.0.1:43735';

const xmlCfdi = ({ uuid, receptor }) => {
  const total = '116.00', sub = '100.00', tax = '16.00';
  return '<?xml version="1.0" encoding="UTF-8"?>' +
    '<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital" ' +
    'Version="4.0" Fecha="2026-11-10T10:00:00" SubTotal="' + sub + '" Moneda="MXN" Total="' + total + '" TipoDeComprobante="I" ' +
    'MetodoPago="PUE" FormaPago="03" LugarExpedicion="03104">' +
    '<cfdi:Emisor Rfc="' + EMISOR + '" Nombre="Emisor de Prueba" RegimenFiscal="601"/>' +
    '<cfdi:Receptor Rfc="' + receptor + '" Nombre="Receptor de Prueba" DomicilioFiscalReceptor="03104" RegimenFiscalReceptor="601" UsoCFDI="G03"/>' +
    '<cfdi:Conceptos><cfdi:Concepto ClaveProdServ="01010101" Cantidad="1" ClaveUnidad="H87" Descripcion="Concepto 1" ' +
    'ValorUnitario="100.00" Importe="100.00" ObjetoImp="02"><cfdi:Impuestos><cfdi:Traslados>' +
    '<cfdi:Traslado Base="100.00" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="16.00"/>' +
    '</cfdi:Traslados></cfdi:Impuestos></cfdi:Concepto></cfdi:Conceptos>' +
    '<cfdi:Impuestos TotalImpuestosTrasladados="' + tax + '"><cfdi:Traslados>' +
    '<cfdi:Traslado Base="' + sub + '" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="' + tax + '"/></cfdi:Traslados></cfdi:Impuestos>' +
    '<cfdi:Complemento><tfd:TimbreFiscalDigital Version="1.1" UUID="' + uuid + '" FechaTimbrado="2026-11-10T10:00:00" ' +
    'RfcProvCertif="SAT970701NN3" SelloCFD="AAAABBBB" NoCertificadoSAT="00001000000500000001" SelloSAT="CCCCDDDD"/></cfdi:Complemento>' +
    '</cfdi:Comprobante>';
};
const U = n => '29800000-0000-4000-8000-' + String(n).padStart(12, '0');

function makeService() {
  const dir = mkdtempSync(join(tmpdir(), 'pacosat-298-'));
  const dbFile = join(dir, 'pacosat.sqlite');
  const service = createPacoSATService({ dbFile, html: '<!--PACOSAT_TOKEN-->', origin: ORIGIN,
    proxyKey: 'd'.repeat(64),
    makeConnector: async () => ({ parser: class {}, connector: {
      request: async () => 'req-298', check: async () => ({ status: 'finished', packages: [] }),
      download: async () => { throw new Error('sin paquetes'); } } }),
    makeMailer: () => ({ verify: async () => true, sendMail: async () => {} }) });
  let token;
  const call = async (path, data, headers = {}) => {
    const hdrs = { host: new URL(ORIGIN).host, origin: ORIGIN, 'x-pacosat-token': token,
      'x-pacosat-proxy': 'd'.repeat(64), ...headers };
    const req = Object.assign(Readable.from(data === undefined ? [] : [Buffer.from(JSON.stringify(data))]), {
      url: path, method: data === undefined ? 'GET' : 'POST', headers: hdrs });
    let response;
    const res = { setHeader() {}, writeHead(status) { this.status = status; this.headersSent = true; },
      end(content) { response = new Response(content, { status: this.status }); } };
    await service.handle(req, res);
    return response;
  };
  return { service, call,
    async init() { token = (await (await call('/')).text()).split('content="')[1].split('"')[0]; } };
}

const h = makeService();
try {
  await h.init();
  /* Siembra: los dos RFC y un CFDI de cada uno (el patrón de la
     suite (g) de la 2.9.7: people por /api/storage y el CFDI
     con su XML por la misma vía). */
  await h.call('/api/storage', { batch: { people: [
    { id: MFI, name: 'Mano Fil de Prueba' }, { id: EDE, name: 'Elemental de Prueba' },
    { id: EMISOR, name: 'Emisor SA' }] } });
  const seedCfdi = async (uuid, receptor) => {
    const xml = xmlCfdi({ uuid, receptor });
    const row = parseXml(Buffer.from(xml), DOMParser);
    const res = await h.call('/api/storage', { batch: { invoices: [row],
      files: [{ id: 'xml:' + row.id, mime: 'application/xml', content: Buffer.from(xml).toString('base64') }] } });
    assert.equal(res.status, 200, 'semilla del CFDI de ' + receptor);
  };
  const uuidMfi = U(1), uuidEde = U(2);
  await seedCfdi(uuidMfi, MFI);
  await seedCfdi(uuidEde, EDE);
  const lectura = (uuid, tok) => h.call('/api/cfdi/lectura?uuid=' + uuid, undefined, { 'x-pacosat-token': tok });
  const accessLog = async () => (await (await h.call('/api/access-log')).json()).entries;

  /* ===== El principal crea a Nora y a Sin Alcance ===== */
  let res = await h.call('/api/users', { nombre: 'Nora', usuario: 'nora', password: 'clave-nora-298',
    rol: 'lectura', rfcs: [MFI], contadora: true });
  assert.equal(res.status, 200, 'el principal crea a Nora');
  res = await h.call('/api/users', { nombre: 'Sin Alcance', usuario: 'sara', password: 'clave-sara-298',
    rol: 'lectura', rfcs: [], contadora: false });
  assert.equal(res.status, 200, 'el principal crea a Sin Alcance');
  res = await h.call('/api/users');
  assert.equal(res.status, 200);
  const listaTexto = await res.text();
  assert.ok(!/hash|salt/.test(listaTexto), 'la vista de usuarios no contiene ni hash ni salt');
  const lista = JSON.parse(listaTexto).usuarios;
  const nora = lista.find(u => u.usuario === 'nora');
  const sara = lista.find(u => u.usuario === 'sara');
  assert.ok(nora && sara, 'los dos usuarios constan en la lista');
  assert.deepEqual(nora.rfcs, [MFI]);
  assert.equal(nora.contadora, true);
  assert.equal(nora.rol, 'lectura');
  assert.deepEqual(sara.rfcs, []);
  console.log('298usr creación por el principal y vista sin secretos: ok');

  /* ===== Login de Nora: su alcance manda ===== */
  res = await h.call('/api/users/login', { usuario: 'nora', password: 'clave-nora-298' });
  assert.equal(res.status, 200, 'Nora entra con su usuario y contraseña');
  const loginNora = await res.json();
  assert.equal(loginNora.nombre, 'Nora');
  assert.equal(loginNora.rol, 'lectura');
  assert.ok(loginNora.token && loginNora.expires > Date.now(), 'su sesión nace con token y caducidad');
  const asNora = { 'x-pacosat-token': loginNora.token };
  res = await h.call('/api/guest/config', undefined, asNora);
  assert.equal(res.status, 200);
  const cfgNora = await res.json();
  assert.equal(cfgNora.sesionUsuario?.nombre, 'Nora', 'la sesión trae su nombre propio');
  assert.equal(cfgNora.sesionUsuario?.rol, 'lectura');
  assert.equal(cfgNora.sesionContadora, true, 'Nora es la contadora de su sesión');
  assert.deepEqual(cfgNora.rfcs, [MFI], 'su alcance es el suyo, no el del invitado clásico');
  assert.equal((await h.call('/api/status', undefined, asNora)).status, 200, 'Nora lee el estado');
  assert.equal((await lectura(uuidMfi, loginNora.token)).status, 200, 'Nora lee el CFDI de su RFC');
  assert.equal((await lectura(uuidEde, loginNora.token)).status, 403, 'el CFDI del otro RFC le queda fuera');
  assert.equal((await h.call('/api/guest/config', { enabled: true }, asNora)).status, 403,
    'una escritura suya (configurar el invitado) se rechaza');
  console.log('298usr Nora: sesión con nombre, contadora y alcance propio: ok');

  /* ===== Sin Alcance: vacío = nada (M2) ===== */
  res = await h.call('/api/users/login', { usuario: 'sara', password: 'clave-sara-298' });
  assert.equal(res.status, 200);
  const loginSara = await res.json();
  assert.equal((await lectura(uuidMfi, loginSara.token)).status, 403,
    'sin alcance no lee ni el CFDI de MFI');
  res = await h.call('/api/guest/config', undefined, { 'x-pacosat-token': loginSara.token });
  const cfgSara = await res.json();
  assert.deepEqual(cfgSara.rfcs, [], 'su configuración enseña su alcance vacío');
  assert.equal(cfgSara.sesionUsuario?.nombre, 'Sin Alcance');
  console.log('298usr Sin Alcance: alcance vacío = nada: ok');

  /* ===== Login fallido: genérico al cliente, con nombre dentro ===== */
  res = await h.call('/api/users/login', { usuario: 'nora', password: 'clave-equivocada' });
  assert.notEqual(res.status, 200);
  assert.equal((await res.json()).error, 'Usuario o contraseña incorrectos.',
    'el fallo no dice si falló el usuario o la contraseña');
  res = await h.call('/api/users/login', { usuario: 'nadie', password: 'clave-equivocada' });
  assert.notEqual(res.status, 200);
  assert.equal((await res.json()).error, 'Usuario o contraseña incorrectos.',
    'el usuario que no consta recibe el mismo mensaje');
  let entries = await accessLog();
  assert.ok(entries.some(e => e.kind === 'user-login-failed' && String(e.detail).includes('Nora')),
    'el intento fallido de Nora queda nombrado en la bitácora');
  assert.ok(entries.some(e => e.kind === 'user-login-failed' && String(e.detail).includes('no consta')),
    'el intento de un usuario que no consta queda dicho como tal');
  assert.ok(entries.some(e => e.kind === 'user-login' && String(e.detail).includes('Nora')),
    'la entrada buena de Nora también la nombra');
  console.log('298usr login fallido genérico y nombrado en la bitácora: ok');

  /* ===== Rotación de contraseña: la sesión viva muere ===== */
  res = await h.call('/api/users/editar', { id: nora.id, password: 'clave-nora-nueva-298' });
  assert.equal(res.status, 200, 'el principal rota la contraseña de Nora');
  assert.equal((await h.call('/api/status', undefined, asNora)).status, 403,
    'la sesión viva de Nora deja de valer al rotar su contraseña');
  res = await h.call('/api/users/login', { usuario: 'nora', password: 'clave-nora-298' });
  assert.notEqual(res.status, 200, 'la clave vieja ya no entra');
  res = await h.call('/api/users/login', { usuario: 'nora', password: 'clave-nora-nueva-298' });
  assert.equal(res.status, 200, 'la clave nueva entra');
  const noraToken2 = (await res.json()).token;
  console.log('298usr rotación: sesión purgada, clave vieja fuera, nueva dentro: ok');

  /* ===== Desactivar y reactivar ===== */
  res = await h.call('/api/users/editar', { id: nora.id, activo: false });
  assert.equal(res.status, 200);
  assert.equal((await h.call('/api/status', undefined, { 'x-pacosat-token': noraToken2 })).status, 403,
    'al desactivarla, su sesión viva deja de valer');
  res = await h.call('/api/users/login', { usuario: 'nora', password: 'clave-nora-nueva-298' });
  assert.notEqual(res.status, 200, 'desactivada no puede entrar');
  assert.equal((await res.json()).error, 'Usuario o contraseña incorrectos.');
  res = await h.call('/api/users/editar', { id: nora.id, activo: true });
  assert.equal(res.status, 200);
  res = await h.call('/api/users/login', { usuario: 'nora', password: 'clave-nora-nueva-298' });
  assert.equal(res.status, 200, 'reactivada vuelve a entrar');
  const noraToken3 = (await res.json()).token;
  /* Salida con nombre: la sesión se retira y queda el asiento. */
  res = await h.call('/api/users/logout', {}, { 'x-pacosat-token': noraToken3 });
  assert.equal(res.status, 200, 'Nora sale con su sesión');
  assert.equal((await h.call('/api/status', undefined, { 'x-pacosat-token': noraToken3 })).status, 403,
    'tras salir, su token ya no vale');
  entries = await accessLog();
  assert.ok(entries.some(e => e.kind === 'user-logout' && String(e.detail).includes('Nora')),
    'la salida de Nora queda nombrada en la bitácora');
  console.log('298usr desactivar/reactivar y salida con nombre: ok');

  /* ===== Usuario administrador «Socio»: todo menos lo reservado ===== */
  res = await h.call('/api/users', { nombre: 'Socio', usuario: 'socio', password: 'clave-socio-298',
    rol: 'administrador', rfcs: [], contadora: false });
  assert.equal(res.status, 200, 'el principal crea al Socio administrador');
  res = await h.call('/api/users/login', { usuario: 'socio', password: 'clave-socio-298' });
  assert.equal(res.status, 200);
  const loginSocio = await res.json();
  assert.equal(loginSocio.rol, 'administrador');
  const asSocio = { 'x-pacosat-token': loginSocio.token };
  assert.equal((await h.call('/api/access-log', undefined, asSocio)).status, 200,
    'el Socio no es invitado: ve la bitácora');
  assert.notEqual((await lectura(uuidEde, loginSocio.token)).status, 403,
    'el Socio ve todos los RFC, también el de EDE');
  assert.equal((await h.call('/api/users', { nombre: 'Otro', usuario: 'otro', password: 'clave-otro-298',
    rol: 'lectura', rfcs: [] }, asSocio)).status, 403, 'crear usuarios es solo del principal');
  assert.equal((await h.call('/api/guest/config', { enabled: true }, asSocio)).status, 403,
    'configurar el invitado es solo del principal');
  assert.equal((await h.call('/api/apikeys', { nombre: 'Llave del socio', alcance: 'lectura' }, asSocio)).status, 403,
    'las llaves de la API son solo del principal');
  entries = await accessLog();
  assert.ok(entries.some(e => e.kind === 'user-write' && String(e.detail).includes('Socio')),
    'las escrituras del Socio quedan atribuidas a su nombre en la bitácora');
  /* El Registro: la entrada de un usuario es conexión, su
     fallo es fallo, sus escrituras son acción, y sus lecturas
     ('user') se saltan como las del invitado ('guest'). */
  const registro = await (await h.call('/api/registro?limit=2000')).json();
  assert.ok(registro.items.some(i => i.clase === 'conexion' && String(i.texto).includes('Entrada de Nora')),
    'el Registro enseña la entrada de Nora como conexión');
  assert.ok(registro.items.some(i => i.clase === 'fallo' && String(i.texto).includes('Intento de entrada fallido de Nora')),
    'el Registro enseña su intento fallido como fallo');
  assert.ok(registro.items.some(i => i.clase === 'accion' && String(i.texto).includes('Socio · POST')),
    'el Registro enseña las escrituras del Socio como acciones con su nombre');
  assert.ok(!registro.items.some(i => String(i.texto).includes('Nora · GET')),
    'las lecturas de Nora no hacen ruido en el Registro');
  console.log('298usr Socio administrador: poderes amplios, lo reservado cerrado: ok');

  /* ===== Regresión: el invitado de siempre, intacto ===== */
  res = await h.call('/api/guest/config', { password: 'clave-invitado-298', rfcs: [MFI], enabled: true });
  assert.equal(res.status, 200, 'el principal configura el invitado de siempre');
  res = await h.call('/api/guest/login', { password: 'clave-invitado-298' });
  assert.equal(res.status, 200);
  const guestToken = (await res.json()).token;
  assert.ok(guestToken, 'el invitado de siempre entra con su contraseña compartida');
  const asGuest = { 'x-pacosat-token': guestToken };
  assert.equal((await h.call('/api/status', undefined, asGuest)).status, 200);
  assert.notEqual((await lectura(uuidMfi, guestToken)).status, 403, 'el invitado lee dentro de su alcance');
  assert.equal((await lectura(uuidEde, guestToken)).status, 403, 'y fuera de su alcance, no');
  assert.equal((await h.call('/api/users', undefined, asGuest)).status, 403,
    'la gestión de usuarios no es del invitado');
  res = await h.call('/api/guest/config', undefined, asGuest);
  const cfgGuest = await res.json();
  assert.equal(cfgGuest.sesionUsuario, null, 'la sesión invitada clásica no trae usuario con nombre');
  assert.deepEqual(cfgGuest.rfcs, [MFI], 'y su alcance sigue siendo el configurado de siempre');
  console.log('298usr regresión del invitado de siempre: ok');

  /* ===== Validaciones de la gestión ===== */
  res = await h.call('/api/users', { nombre: 'Otra Nora', usuario: 'NORA', password: 'clave-otra-298',
    rol: 'lectura', rfcs: [] });
  assert.notEqual(res.status, 200, 'usuario duplicado (sin distinción de mayúsculas) → error');
  assert.match((await res.json()).error, /ya|existe|uso/i);
  res = await h.call('/api/users', { nombre: 'Corta', usuario: 'corta', password: 'corta',
    rol: 'lectura', rfcs: [] });
  assert.notEqual(res.status, 200, 'contraseña de menos de 8 → error');
  res = await h.call('/api/users', { nombre: 'Raro', usuario: 'raro', password: 'clave-raro-298',
    rol: 'jefe', rfcs: [] });
  assert.notEqual(res.status, 200, 'rol inválido → error');
  res = await h.call('/api/users');
  assert.ok(!/hash|salt/.test(await res.text()), 'la vista sigue sin hash ni salt tras todo lo anterior');
  console.log('298usr validaciones: duplicado, clave corta y rol inválido: ok');

  /* ===== Borrado con asiento ===== */
  res = await h.call('/api/users/borrar', { id: sara.id });
  assert.equal(res.status, 200, 'el principal borra a Sin Alcance');
  assert.equal((await h.call('/api/status', undefined, { 'x-pacosat-token': loginSara.token })).status, 403,
    'la sesión de la borrada deja de valer');
  res = await h.call('/api/users/login', { usuario: 'sara', password: 'clave-sara-298' });
  assert.notEqual(res.status, 200, 'la borrada ya no puede entrar');
  entries = await accessLog();
  assert.ok(entries.some(e => e.kind === 'user-config' && String(e.detail).includes('Sin Alcance') &&
    String(e.detail).includes('borrado')), 'el borrado deja su asiento nombrado en la bitácora');
  console.log('298usr borrado: sesión purgada, entrada cerrada y asiento en la bitácora: ok');
} finally { h.service.close(); }

console.log('ronda298usuarios.test: ok');
