/* ===== Ronda 2.9.0 · Bloque B: el foco del sistema =====
   (a) El foco existe en la cabecera con su palabra y es mayor
   que un punto; (b) focoSistema290 con estados sembrados;
   (c) el botón de contribuyente con salud warn enseña la palabra
   corta VISIBLE en el DOM (no solo en title); (d) la tarjeta del
   paseo pinta el paso vivo y el elemento del transcurrido, con
   su reloj repintando cada segundo y limpiándose al salir. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const ROOT = import.meta.dirname;
const read = name => readFileSync(join(ROOT, name), 'utf8');
const html = read('Faro-Fiscal.html');
const layout = read('layout.part');
const ui = read('ui.part');
const AHORA = Date.parse('2026-11-17T12:00:00Z');
const RFC = 'AAA010101AAA';

function focoCtx(extra = {}) {
  const ctx = vm.createContext({ console, Date, ...extra });
  const ini = html.indexOf('function focoFecha290');
  const fin = html.indexOf('function focoRefrescar290', ini);
  assert.ok(ini >= 0 && fin > ini, 'focoFecha290/focoSistema290 viven en el artefacto');
  return vm.runInContext(html.slice(ini, fin) + '\n;focoSistema290;', ctx);
}
function base() {
  return {
    satData: { paseo: 'nas', profiles: [{ rfc: RFC }],
      puerta: { [RFC]: { probada: AHORA - 3600000, ok: true } },
      ejecutor: { emparejado: true, enLinea: true },
      scheduledBackup: { enabled: true, secondary: true },
      mail: { enabled: true, recipient: 'paco@example.com' },
      coverage: { gaps: [], groups: [{ rfc: RFC, direction: 'received', failed: 0 }] } },
    salud: { paseo: 'nas', tarjetas: [
      { id: 'puerta:' + RFC, estado: 'bien', porque: 'La puerta abre: probada el 17 nov 2026 y la e.firma entra sola.', datos: { rfc: RFC, tipo: 'abre' } },
      { id: 'correo', estado: 'bien', porque: 'Configurado y su última prueba salió bien.', datos: { configurado: true, destinatario: 'paco@example.com' } },
      { id: 'respaldo', estado: 'bien', porque: 'Último respaldo bueno: el 17 nov 2026, con su copia fuera del NAS.', datos: { contrasenaPuesta: true, copiaFuera: true } }] },
    listas: { sources: [{ id: '69b', label: '69-B', fetched: AHORA - 3600000, count: 10 }] },
  };
}

/* ---------- (a) El foco en la cabecera: grande, con palabra ---------- */
{
  assert.ok(layout.includes('id="foco-btn290"'), 'el botón del foco vive en la cabecera (layout)');
  assert.ok(layout.includes('foco-luz290') && layout.includes('foco-palabra290'),
    'el foco lleva su luz Y su palabra al lado, no un punto discreto');
  assert.ok(layout.indexOf('id="foco-btn290"') > layout.indexOf('id="scope-menu200b"'),
    'el foco va junto al selector de contribuyente');
  assert.ok(html.includes('.foco-luz290{width:18px;height:18px'), 'la luz del foco mide 18 px: mayor que el punto de salud (11 px)');
  assert.ok(html.includes('function pintarFoco290') && html.includes('function pintarFocoMenu290'),
    'el foco se pinta y su panel se compone en el artefacto');
  console.log('OK 2.9.0 foco · (a) foco grande y con palabra en la cabecera.');
}

/* ---------- (b) focoSistema290 con estados sembrados ---------- */
{
  const focoSistema290 = focoCtx({ scope: RFC });
  const { satData, salud, listas } = base();
  const todo = focoSistema290(satData, salud, listas, satData.coverage, AHORA);
  assert.equal(todo.nivel, 'ok');
  assert.equal(todo.palabra, 'Todo bien', 'todo bien ⇒ «Todo bien»');
  assert.equal(todo.piezas.length, 6, 'seis piezas vigiladas: ' + todo.piezas.map(p => p.nombre).join(' | '));
  assert.ok(todo.piezas.every(p => p.nivel === 'ok'), 'todas las piezas en ok');

  /* Puerta vieja ⇒ ámbar, de quién el sistema, motivo con la fecha. */
  const b1 = base();
  b1.salud.tarjetas[0] = { id: 'puerta:' + RFC, estado: 'vigilar', datos: { rfc: RFC, tipo: 'vieja' },
    porque: 'Esto se probó el 3 de noviembre de 2026; puede estar desactualizado: entonces abría.' };
  const vieja = focoSistema290(b1.satData, b1.salud, b1.listas, b1.satData.coverage, AHORA);
  assert.equal(vieja.nivel, 'warn');
  assert.equal(vieja.palabra, 'Falta 1 cosa');
  const piezaPuerta = vieja.piezas.find(p => p.nombre.startsWith('Puerta'));
  assert.equal(piezaPuerta.deQuien, 'el sistema', 'la foto vieja es del sistema (se re-prueba sola)');
  assert.ok(piezaPuerta.motivo.includes('3 de noviembre de 2026'), 'el motivo trae la fecha: ' + piezaPuerta.motivo);
  assert.equal(piezaPuerta.gesto.accion, 'probar-puerta', 'su arreglo dispara la prueba de la puerta');

  /* Respaldo sin contraseña ⇒ pieza de Paco con gesto a Respaldos. */
  const b2 = base();
  b2.salud.tarjetas[2] = { id: 'respaldo', estado: 'vigilar', porque: 'El respaldo programado no está configurado en el servidor.',
    datos: { contrasenaPuesta: false, copiaFuera: false } };
  const sinClave = focoSistema290(b2.satData, b2.salud, b2.listas, b2.satData.coverage, AHORA);
  const piezaRespaldo = sinClave.piezas.find(p => p.nombre === 'Respaldo');
  assert.equal(piezaRespaldo.nivel, 'warn');
  assert.equal(piezaRespaldo.deQuien, 'Paco');
  assert.ok(/contraseña/.test(piezaRespaldo.motivo), 'el motivo nombra la contraseña: ' + piezaRespaldo.motivo);
  assert.equal(piezaRespaldo.gesto.vista, 'settings');
  assert.equal(piezaRespaldo.gesto.seccion, 'respaldos', 'el gesto aterriza en Ajustes › Respaldos');

  /* Correo sin configurar ⇒ pieza presente, de Paco. */
  const b3 = base();
  b3.salud.tarjetas[1] = { id: 'correo', estado: 'vigilar', porque: 'Sin configurar: los avisos importantes no salen de la app.',
    datos: { configurado: false, destinatario: '' } };
  const sinCorreo = focoSistema290(b3.satData, b3.salud, b3.listas, b3.satData.coverage, AHORA);
  const piezaCorreo = sinCorreo.piezas.find(p => p.nombre === 'Correo de avisos');
  assert.ok(piezaCorreo, 'la pieza del correo existe');
  assert.equal(piezaCorreo.nivel, 'warn');
  assert.equal(piezaCorreo.deQuien, 'Paco');
  assert.equal(piezaCorreo.gesto.seccion, 'correo');

  /* Sede remota para esta instalación ⇒ «Falta» ámbar de Paco. */
  const b4 = base();
  b4.satData.paseo = 'remoto'; b4.salud.paseo = 'remoto';
  const remoto = focoSistema290(b4.satData, b4.salud, b4.listas, b4.satData.coverage, AHORA);
  const piezaSede = remoto.piezas.find(p => p.nombre === 'Sede del paseo');
  assert.equal(piezaSede.nivel, 'warn');
  assert.equal(piezaSede.deQuien, 'Paco');
  assert.ok(/depende de tu PC/.test(piezaSede.motivo));

  /* Listas viejas (>48 h, el umbral de su pantalla) ⇒ ámbar. */
  const b5 = base();
  b5.listas.sources[0].fetched = AHORA - 49 * 3600000;
  const viejas = focoSistema290(b5.satData, b5.salud, b5.listas, b5.satData.coverage, AHORA);
  const piezaListas = viejas.piezas.find(p => p.nombre === 'Listas negras');
  assert.equal(piezaListas.nivel, 'warn');
  assert.ok(piezaListas.motivo.includes('última comprobación es del'), 'el motivo trae su fecha: ' + piezaListas.motivo);

  /* Sin datos ⇒ gris honesto, nunca verde fingido. */
  const nada = focoSistema290(null, null, null, null, AHORA);
  assert.equal(nada.nivel, 'dim');
  assert.equal(nada.palabra, 'Sin comprobar todavía');
  console.log('OK 2.9.0 foco · (b) focoSistema290: bien / puerta vieja / respaldo / correo / sede / listas / sin datos.');
}

/* ---------- (c) La palabra corta VISIBLE junto al punto ---------- */
{
  const mk = (tag, text, cls) => ({ tag, cls: cls || '', dataset: {}, children: [], textContent: text || '',
    append(...k) { this.children.push(...k); }, replaceChildren(...k) { this.children = k; } });
  const btn = mk('button');
  const ctx = vm.createContext({ console,
    $: id => (id === 'scope-menu-btn200b' ? btn : null),
    people: [{ id: RFC, name: 'Empresa Uno' }], scope: RFC,
    saludRfc200b: () => ({ nivel: 'warn', porque: 'la foto de su puerta es vieja (17 nov 2026, 08:00)' }),
    medallon200b: () => mk('span', 'E', 'rfc-medallon200b'),
    n: mk });
  const ini = html.indexOf('function saludPalabraCorta290');
  const fin = html.indexOf('function pintarScopeMenu200b', ini);
  assert.ok(ini >= 0 && fin > ini, 'saludPalabraCorta290/pintarBotonScope200b viven en el artefacto');
  vm.runInContext(html.slice(ini, fin) + '\n;pintarBotonScope200b();', ctx);
  const palabra = btn.children.find(c => c.cls === 'salud-palabra290');
  assert.ok(palabra, 'junto al punto hay un tramo de palabra visible');
  assert.equal(palabra.textContent, 'puerta vieja', 'la palabra corta de la foto vieja se ve en el DOM: ' + palabra.textContent);
  const punto = btn.children.find(c => c.cls === 'salud-punto200b');
  assert.ok(punto && punto.title.includes('vieja'), 'el motivo completo sigue en el title, pero ya no SOLO ahí');
  assert.ok(ui.includes("n('small', salud.porque, 'scope-menu-porque290')"),
    'en el menú de contribuyentes el motivo completo va como texto visible bajo el nombre');
  console.log('OK 2.9.0 foco · (c) palabra corta visible en la cabecera y motivo visible en el menú.');
}

/* ---------- (d) El paseo: paso vivo y reloj transcurrido ---------- */
{
  const trib = read('tributario-ui.part');
  assert.ok(trib.includes("pasoVivo290('tributario', rfc)"), 'el Buzón lee el paso vivo de su entrada de actividad');
  assert.ok(trib.includes('vivo290?.detail'), 'el paso pintado es el detail vivo (el último que el servidor narra)');
  assert.ok(trib.includes("reloj290.dataset.reloj290 = 'tributario'"), 'la tarjeta del Buzón lleva el elemento del transcurrido');
  const decl = read('declaraciones-ui.part');
  assert.ok(decl.includes("relojDecl290.dataset.reloj290 = 'declaraciones'"), 'la tarjeta gemela de Declaraciones lleva su reloj');

  let intervalo = null, limpiado = false;
  const ctx = vm.createContext({ console,
    setInterval: fn => { intervalo = fn; return 7; },
    clearInterval: () => { limpiado = true; } });
  const seg = (desde, hasta) => html.slice(html.indexOf(desde), html.indexOf(hasta, html.indexOf(desde)));
  const codigo = seg('function fmtElapsed1312', 'function jobProgress1312') +
    seg('function relojTranscurrido290', 'async function asignarColor200b');
  const reloj = vm.runInContext(codigo + '\n;relojTranscurrido290;', ctx);
  const el = { textContent: '', isConnected: true };
  const parar = reloj(el, Date.now() - 65000);
  assert.ok(/lleva 1 min/.test(el.textContent), 'el reloj pinta el transcurrido real: ' + el.textContent);
  assert.equal(typeof intervalo, 'function', 'el reloj repinta cada segundo (intervalo vivo)');
  el.isConnected = false;
  intervalo();
  assert.ok(limpiado, 'al salir de la vista (elemento desconectado) el intervalo se limpia solo');
  assert.equal(typeof parar, 'function', 'el reloj devuelve su parada para el repintado de la pantalla');
  console.log('OK 2.9.0 foco · (d) paso vivo y reloj transcurrido del paseo, con limpieza.');
}

console.log('OK ronda 2.9.0 · bloque B: foco del sistema, palabras junto a las luces y pasos visibles.');
