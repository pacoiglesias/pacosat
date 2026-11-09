import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

/* Almacenamiento local y preparación (1.6.8): la apertura bloqueada no
   es un fallo, las acciones esperan a la preparación en vez de rendirse
   con «El almacenamiento todavía no está disponible.» y el modo
   servidor no depende de IndexedDB. Se ejerce el código real — data.part
   entero y la sección de preparación de workflows.part — en un contexto
   VM con un IndexedDB fingido cuyos eventos dispara la propia prueba,
   como verify.cjs hace con otras secciones del guion. */

const tick = (ms = 10) => new Promise(resolve => setTimeout(resolve, ms));
async function until(condition, ms = 2000) {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > ms) throw new Error('La condición no se cumplió a tiempo.');
    await tick(5);
  }
}
function fakeIndexedDB({ throwOnOpen = false } = {}) {
  const requests = [];
  return {
    requests,
    open() {
      if (throwOnOpen) throw new Error('IndexedDB no disponible en este navegador.');
      const request = { result: undefined, error: null, onsuccess: null, onerror: null, onblocked: null, onupgradeneeded: null };
      requests.push(request);
      return request;
    },
    succeed(index = requests.length - 1) {
      const request = requests[index];
      request.result = { onversionchange: null, close() {} };
      request.onsuccess();
    },
    block(index = requests.length - 1) { requests[index].onblocked(); },
    fail(error, index = requests.length - 1) {
      const request = requests[index];
      request.error = error;
      request.onerror();
    }
  };
}
function makeContext({ cloud = false, idb } = {}) {
  const context = vm.createContext({
    indexedDB: idb, Uint8Array, DataView, TextDecoder, TextEncoder, Blob, DecompressionStream,
    btoa, atob, crypto: webcrypto, setTimeout, clearTimeout
  });
  context.__announcements = [];
  vm.runInContext(fs.readFileSync('data.part', 'utf8'), context);
  vm.runInContext(`
    var ready = false;
    var cloudStorage = ${cloud};
    var refreshCalls = 0;
    async function refresh() { refreshCalls++; }
    function announce(message = '', error = false) { globalThis.__announcements.push([message, error]); }
  `, context);
  const workflows = fs.readFileSync('workflows.part', 'utf8');
  const start = workflows.indexOf('/* Preparación del almacenamiento');
  const end = workflows.indexOf('/* Fin de la preparación del almacenamiento');
  assert.ok(start >= 0 && end > start, 'Falta la sección de preparación en workflows.part.');
  vm.runInContext(workflows.slice(start, end), context);
  return context;
}

/* Pin de fuente: ninguna acción puede volver a rendirse en el acto con
   el guardián antiguo ni con el mensaje genérico de la 1.6.7. */
for (const part of ['workflows.part', 'pdf-cloud-ui.part']) {
  const source = fs.readFileSync(part, 'utf8');
  assert.ok(!source.includes('check(ready'), part + ' no debe guardar acciones con check(ready…).');
  assert.ok(!source.includes("'El almacenamiento todavía no está disponible.'"),
    part + ' no debe lanzar el mensaje genérico de la 1.6.7.');
}

/* openDatabase: onblocked NO liquida la promesa (la petición sigue viva)
   y la apertura se completa sola cuando la otra pestaña se cierra. */
{
  const idb = fakeIndexedDB();
  const context = makeContext({ idb });
  let settled = null;
  const opening = context.openDatabase().then(db => { settled = ['ok', db]; }, error => { settled = ['error', error]; });
  idb.block(0);
  assert.equal(context.isStorageBlocked(), true);
  await tick(30);
  assert.equal(settled, null, 'onblocked no debe resolver ni rechazar: la petición sigue viva.');
  idb.succeed(0);
  await opening;
  assert.equal(settled[0], 'ok');
  assert.equal(context.isStorageBlocked(), false, 'Al abrir, el estado de bloqueo se limpia.');
}
/* openDatabase: el error de verdad sí rechaza, con el error original. */
{
  const idb = fakeIndexedDB();
  const context = makeContext({ idb });
  const opening = context.openDatabase();
  const boom = new Error('fallo de apertura');
  idb.fail(boom, 0);
  await assert.rejects(opening, error => error === boom);
}

/* (a) Clic con el almacén aún preparándose: la acción espera a la
   preparación y continúa; no se rinde. */
{
  const idb = fakeIndexedDB();
  const context = makeContext({ idb });
  context.beginReadiness();
  let done = false;
  const click = context.requireStorage(2000).then(() => { done = true; });
  await tick(30);
  assert.equal(done, false, 'La acción debe esperar a la preparación, no rendirse.');
  assert.equal(context.ready, false);
  idb.succeed(0);
  await click;
  assert.equal(done, true);
  assert.equal(context.ready, true);
  assert.equal(context.refreshCalls, 1);
}

/* (b) Almacén bloqueado por otra pestaña: la acción agota la espera y
   recibe el mensaje claro de las pestañas; cuando la otra se cierra, la
   MISMA petición se completa y la siguiente acción ya funciona. */
{
  const idb = fakeIndexedDB();
  const context = makeContext({ idb });
  context.beginReadiness();
  idb.block(0);
  await assert.rejects(context.requireStorage(60), /demás pestañas de PacoSAT/);
  assert.equal(context.ready, false);
  idb.succeed(0);
  await until(() => context.ready);
  assert.equal(context.isStorageBlocked(), false);
  await context.requireStorage(60);
  assert.equal(context.refreshCalls, 1);
}

/* Fallo de apertura: la acción reintenta la apertura (el bloqueo pudo
   ceder) y se recupera si el segundo intento abre. */
{
  const idb = fakeIndexedDB();
  const context = makeContext({ idb });
  context.beginReadiness();
  idb.fail(new Error('apertura imposible'), 0);
  const click = context.requireStorage(2000);
  await until(() => idb.requests.length === 2);
  idb.succeed(1);
  await click;
  assert.equal(context.ready, true);
}
/* Fallo definitivo en ambos intentos: mensaje claro y accionable, no el
   genérico de la 1.6.7, y `ready` queda en falso a la vista. */
{
  const idb = fakeIndexedDB();
  const context = makeContext({ idb });
  context.beginReadiness();
  idb.fail(new Error('uno'), 0);
  const click = context.requireStorage(2000);
  await until(() => idb.requests.length === 2);
  idb.fail(new Error('dos'), 1);
  await assert.rejects(click, /no dejó abrir el almacenamiento local/);
  assert.equal(context.ready, false);
}

/* (c) Modo servidor sin IndexedDB utilizable: la preparación es la
   carga desde el servidor y las acciones funcionan sin tocar el
   almacén local (ni una sola llamada a indexedDB.open). */
{
  const idb = fakeIndexedDB({ throwOnOpen: true });
  const context = makeContext({ cloud: true, idb });
  context.beginReadiness();
  await context.requireStorage(500);
  assert.equal(context.ready, true);
  assert.equal(context.refreshCalls, 1);
  assert.equal(idb.requests.length, 0, 'El modo servidor no debe abrir IndexedDB.');
}

console.log('OK: apertura bloqueada sin rechazo y con recuperación, espera de las acciones, reintento tras fallo, mensajes accionables y modo servidor sin IndexedDB.');
