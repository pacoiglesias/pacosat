/* Suite de la ronda 2.3.0 · frente CLIENTE (piezas 3–8, 10–20).
   Sin servidor: ejecuta las funciones puras nuevas de los .part
   en contextos vm con vistas hechas de los campos REALES de los
   contratos (resumen de declaraciones, foto por RFC, plan con
   yaPedida, residencia del ejecutor, cruce de declaraciones) y
   fija el cableado de cada pieza sobre las fuentes y sobre el
   artefacto construido. La registra el padre en package.json. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const leer = nombre => readFileSync(new URL('./' + nombre, import.meta.url), 'utf8');
const ui = leer('ui.part');
const satUi = leer('sat-ui.part');
const declUi = leer('declaraciones-ui.part');
const finalUi = leer('final-ui.part');
const saludUi = leer('salud-ui.part');
const settingsUi = leer('settings-ui.part');
const registroUi = leer('registro-ui.part');
const outputsUi = leer('outputs-ui.part');
const monitorUi = leer('monitor-ui.part');
const satdocsUi = leer('satdocs-ui.part');
const artefacto = leer('Faro-Fiscal.html');

function contexto(part, desde, hasta, stubs = {}) {
  const src = part.slice(part.indexOf(desde), part.indexOf(hasta));
  assert.ok(src.length > 50, 'slice vacío para ' + desde);
  const ctx = vm.createContext({ console, Date, Math, JSON, Number, String, Boolean, Array, Object, Set, Map, ...stubs });
  vm.runInContext(src, ctx);
  return ctx;
}

/* ---- Pieza 3 · menú de Declaraciones desde el resumen ---- */
{
  const ctx = contexto(declUi, 'function declMenuTexto202', 'async function pintarDeclMenu202', {
    fechaCortaMenu202: () => '5 nov',
    DECL_MESES: ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre']
  });
  /* RE-BASE integración 2.4.0 (W6): declMenuTexto230 llama a
     declFaltaMes230, que vive hoy en el PUENTE de ui.part (la
     parte diferida lo usa desde fuera); el corte de
     declaraciones-ui ya no lo contiene. El corte se amplía al
     puente con la función REAL — misma fuerza, nada stubeado. */
  vm.runInContext(ui.slice(ui.indexOf('function declFaltaMes230'),
    ui.indexOf('let declEjercicio')), ctx);
  assert.equal(ctx.declMenuTexto230({ hayDatos: true, conocidas: 9, ejercicio: 2026, faltaMes: '2026-10' }, null),
    '9 de 2026 · falta octubre', 'con datos y mes que falta (periodo → su nombre)');
  assert.equal(ctx.declMenuTexto230({ hayDatos: true, conocidas: 11, ejercicio: 2026, faltaMes: null }, null),
    '11 de 2026 · al día', 'con datos y sin falta: al día');
  assert.equal(ctx.declMenuTexto230({ hayDatos: true, conocidas: 3, ejercicio: 2025, faltaMes: 'marzo' }, null),
    '3 de 2025 · falta marzo', 'faltaMes como nombre pasa tal cual');
  assert.equal(ctx.declMenuTexto230({ hayDatos: false }, [{ ok: true, started: 1 }]),
    'Última bajada: 5 nov', 'sin datos manda el diario de corridas de siempre');
  assert.equal(ctx.declMenuTexto230(null, []), 'Sin bajar todavía');
  assert.ok(declUi.includes("satApi('declaraciones/resumen?rfc='"), 'el resumen se pide al endpoint del contrato');
  assert.ok(declUi.includes('declResumen230Cache'), 'caché de 60 s del resumen');
  console.log('OK 2.3.0·C pieza 3 — menú de Declaraciones: resumen con datos, diario sin datos, caché compartida.');
}

/* ---- Pieza 4 · el barrido encuentra su estimación ---- */
{
  let porTipo = { 'revision-comprobantes': { medianaTexto: '~4 min' } };
  const ctx = contexto(ui, 'let tiempos201Cache', 'function imprimirVista201', {
    satToken: 'x',
    satApi: async () => ({ porTipo })
  });
  assert.equal(ctx.tiempoClaves230('barrido')[0], 'barrido', 'primero su clave propia');
  assert.ok(ctx.tiempoClaves230('barrido').includes('revision-comprobantes'), 'el alias de la revisión entra en el mapa');
  assert.equal(await ctx.tiempoEstimado201('barrido'), '~4 min', 'sin clave propia, el alias encuentra la estimación');
  const reset = () => vm.runInContext('tiempos201Cache = null; tiempos201At = 0;', ctx);
  reset();
  porTipo = { barrido: { medianaTexto: '~7 min' }, 'revision-comprobantes': { medianaTexto: '~4 min' } };
  assert.equal(await ctx.tiempoEstimado201('barrido'), '~7 min', 'la clave propia manda sobre el alias');
  reset();
  porTipo = { 'buzon-listar': { medianaTexto: '~2 min' } };
  assert.equal(await ctx.tiempoEstimado201('tributario'), '~2 min', 'los alias de la 2.0.1 no se rompen');
  reset();
  porTipo = {};
  assert.equal(await ctx.tiempoEstimado201('barrido'), '', 'sin historial, sin estimación: no se inventa');
  console.log('OK 2.3.0·C pieza 4 — barrido: clave propia, alias de revisión y vacío honesto.');
}

/* ---- Pieza 5 · residencia del ejecutor, sin fingir ---- */
{
  const ctx = contexto(ui, 'function residenciaTexto230', 'function hoyMando201');
  assert.equal(ctx.residenciaTexto230(null), 'Residente: sin reportar todavía');
  assert.equal(ctx.residenciaTexto230({}), 'Residente: sin reportar todavía', 'servidor viejo: no se finge un sí');
  assert.equal(ctx.residenciaTexto230({ residencia: { registrada: true, protocolo: 'x', rechazada: false, instancias: 2 } }),
    'Residente: sí · Instancias: 2');
  assert.equal(ctx.residenciaTexto230({ residencia: { registrada: false, instancias: 0 } }),
    'Residente: no · Instancias: 0');
  assert.ok(ui.includes('residenciaTexto230(ej)'), 'la línea de Hoy la pinta');
  assert.ok(saludUi.includes('residenciaTexto230'), 'la tarjeta del ejecutor de Salud la pinta');
  console.log('OK 2.3.0·C pieza 5 — residencia: sí/no e instancias del status; sin reporte, «sin reportar todavía».');
}

/* ---- Pieza 7 · aviso antes de quemar una petición ---- */
{
  const ctx = contexto(satUi, 'function planYaPedidas230', 'function requestDialog', {
    fmtFechaHora: () => '12 nov, 09:30'
  });
  assert.equal(ctx.planAvisoYaPedida230({ criterios: [{ yaPedida: null }, { yaPedida: { at: 1, requestId: 'r1' } }] }),
    'Ojo: esta ventana ya se pidió el 12 nov, 09:30; repetirla gasta otra petición al SAT.');
  assert.equal(ctx.planAvisoYaPedida230({ yaPedida: { at: 1, requestId: 'r0' } }),
    'Ojo: esta ventana ya se pidió el 12 nov, 09:30; repetirla gasta otra petición al SAT.', 'también a nivel de plan');
  assert.equal(ctx.planAvisoYaPedida230({ criterios: [{ yaPedida: null }] }), '', 'sin yaPedida, sin aviso');
  assert.equal(ctx.planAvisoYaPedida230(null), '');
  assert.ok(ctx.planAvisoYaPedida230({ criterios: [{ yaPedida: { at: 1 } }, { yaPedida: { at: 2 } }] })
    .startsWith('Ojo: 2 de estas ventanas ya se pidieron'), 'varias pedidas se cuentan');
  assert.ok(satUi.includes('plan-yapedida230') && satUi.includes('planYaPedida.hidden = !avisoYaPedida'),
    'el aviso vive visible en el diálogo, sin desplegar nada');
  console.log('OK 2.3.0·C pieza 7 — yaPedida: aviso en llano con su fecha antes de enviar.');
}

/* ---- Pieza 10 · qué cambió desde ayer: máximo 5 y solo si hay ---- */
{
  const ctx = contexto(ui, 'function cambiosLineas230', 'function cambiosPanel230');
  const siete = { desde: 1, lineas: Array.from({ length: 7 }, (_, i) => ({ at: i, texto: 'Cambio ' + i, clase: 'bien' })) };
  const r = ctx.cambiosLineas230(siete);
  assert.equal(r.total, 7); assert.equal(r.visibles.length, 5, 'máximo 5 líneas');
  assert.equal(ctx.cambiosLineas230({ lineas: [{ texto: '  ' }, { texto: 'Real', at: 1 }] }).total, 1,
    'las líneas sin texto no cuentan');
  assert.equal(ctx.cambiosLineas230(null).total, 0, 'sin cambios: la tarjeta no aparece (total 0)');
  assert.ok(ui.includes("satApi(ruta)") && ui.includes("'cambios'"), 'la tarjeta se alimenta de /api/cambios');
  console.log('OK 2.3.0·C pieza 10 — cambios: 5 visibles, resto contado, vacío = sin tarjeta.');
}

/* ---- Pieza 11 · foto por RFC: cuatro semáforos con su dato ---- */
{
  /* RE-BASE integración 2.4.0 (W6): declFaltaMes230 ya no vive
     en declaraciones-ui.part sino en el puente de ui.part; el
     corte se hace en su nuevo hogar, con los mismos extremos
     de la función (hasta «let declEjercicio», que la sigue). */
  const ctxDecl = contexto(ui, 'function declFaltaMes230', 'let declEjercicio', {
    DECL_MESES: ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre']
  });
  const ctx = contexto(ui, 'function fotoSemaforos230', 'function fotoRfcPanel230', {
    declFaltaMes230: ctxDecl.declFaltaMes230
  });
  const foto = {
    rfc: 'AAA010101AAA', nombre: 'Ejemplo', color: 'azul',
    puerta: { ok: true, fecha: 1 }, buzon: { pendientes: 2, comunicados: 1, fecha: 1 },
    declaraciones: { conocidas: 10, ejercicio: 2026, faltaMes: null }, listas: { senaladas: 0, fecha: 1 }
  };
  const s = Object.fromEntries(ctx.fotoSemaforos230(foto).map(x => [x.nombre, x]));
  assert.deepEqual([s.Puerta.estado, s.Puerta.texto], ['ok', 'abre']);
  assert.equal(s.Buzón.estado, 'warn'); assert.ok(s.Buzón.texto.includes('2 por leer'));
  assert.deepEqual([s.Declaraciones.estado, s.Declaraciones.texto], ['ok', '10 de 2026 · al día']);
  assert.deepEqual([s.Listas.estado, s.Listas.texto], ['ok', 'sin señaladas']);
  const mala = Object.fromEntries(ctx.fotoSemaforos230({
    puerta: { ok: false }, buzon: { pendientes: 0, comunicados: 0 },
    declaraciones: { conocidas: 4, ejercicio: 2026, faltaMes: '2026-09' }, listas: { senaladas: 3 }
  }).map(x => [x.nombre, x]));
  assert.equal(mala.Puerta.estado, 'bad');
  assert.equal(mala.Declaraciones.texto, 'falta septiembre');
  assert.equal(mala.Listas.estado, 'bad');
  assert.ok(ctx.fotoSemaforos230({}).every(x => x.estado === 'dim'), 'sin foto, todo gris honesto');
  assert.ok(ui.includes("satApi('foto-rfc')"), 'la sección se alimenta de /api/foto-rfc');
  console.log('OK 2.3.0·C pieza 11 — foto por RFC: semáforos y datos cortos salen de la foto, no se inventan.');
}

/* ---- Pieza 12 · puerta del menú: estado + frescura ---- */
{
  const ctx = contexto(finalUi, 'function puertaLinea230', 'function senalesBarra1311', {
    fechaCortaMenu202: () => '3 oct'
  });
  const hoy = new Date(2026, 10, 16, 12, 0).getTime();
  const hoyTemprano = new Date(2026, 10, 16, 8, 0).getTime();
  const otroDia = new Date(2026, 9, 3, 8, 0).getTime();
  const par = r => [r.estado, r.texto];
  assert.deepEqual(par(ctx.puertaLinea230({ ok: true, probada: hoyTemprano }, hoy)), ['ok', 'abre · foto de hoy']);
  assert.deepEqual(par(ctx.puertaLinea230({ ok: false, probada: otroDia }, hoy)), ['mal', 'no abre · foto del 3 oct']);
  assert.deepEqual(par(ctx.puertaLinea230(null, hoy)), ['sin-dato', 'sin probar todavía']);
  assert.deepEqual(par(ctx.puertaLinea230({ ok: true }, hoy)), ['sin-dato', 'sin probar todavía'],
    'sin fecha de prueba no hay foto que enseñar');
  assert.ok(finalUi.includes('puertaLinea230(puerta)'), 'la línea del menú se pinta con la función');
  console.log('OK 2.3.0·C pieza 12 — puerta del menú: abre/no abre con foto de hoy o de su fecha.');
}

/* ---- Pieza 15 · línea de vida de cada declaración ---- */
{
  const ctx = contexto(declUi, 'function declVida230', 'function declLineasVida230', {
    declFechaLarga: () => '5 de noviembre de 2026'
  });
  const vida = ctx.declVida230({ operacion: '88001234', periodo: '2026-10', fechaPresentacion: '2026-11-05',
    tieneAcuse: true, documentoAcuseId: 7, tieneDeclaracion: false, documentoDeclaracionId: 0 });
  assert.equal(vida.presentada, 'Presentada el 5 de noviembre de 2026 · nº de operación 88001234');
  assert.equal(vida.tieneAcuse, true); assert.equal(vida.tieneDeclaracion, false);
  assert.equal(ctx.declVida230({ fechaPresentacion: '2026-11-05' }), null, 'sin nº de operación no hay línea de vida');
  assert.ok(declUi.includes("'Ver acuse'") && declUi.includes("'Sin acuse todavía'") && declUi.includes("'Bajar el acuse'"),
    'acuse: ver si consta, bajar si no');
  console.log('OK 2.3.0·C pieza 15 — línea de vida: presentada con fecha y operación; acuse y declaración según consten.');
}

/* ---- Pieza 18 · color libre de la paleta cerrada ---- */
{
  const ctx = contexto(ui, 'function colorLibre230', 'function elementalColorAsignado230', {
    RFC_PALETA200B: [['azul'], ['verde'], ['teal'], ['violeta'], ['burdeos'], ['ambar'], ['grafito'], ['oliva'], ['ciruela'], ['marron']]
  });
  assert.equal(ctx.colorLibre230([]), 'azul');
  assert.equal(ctx.colorLibre230(['azul', 'verde']), 'teal', 'la primera clave libre de la paleta');
  assert.ok(ui.includes('elementalAsegurarColor230'), 'el alta asegura su color al prepararse');
  assert.ok(ui.includes('subir su e.firma'), 'el gesto nombrado en su tarjeta: subir su e.firma');
  console.log('OK 2.3.0·C pieza 18 — Elemental: color de la paleta al nacer y gesto de la e.firma nombrado.');
}

/* ---- Cableado del resto de piezas (fuentes) ---- */
{
  // Pieza 6: Seguir de verdad, con el texto devuelto a la vista.
  assert.ok(monitorUi.includes("satApi('trabajos/seguir', { jobId })"), 'seguir llama al endpoint del contrato');
  assert.ok(monitorUi.includes('seguirBoton230'), 'el botón Seguir existe');
  assert.ok(satdocsUi.includes("row.estado === 'cancelada'"), 'Seguir en los trabajos cancelados de Trabajos del SAT');
  assert.ok(ui.includes('seguirBoton230(jobId230)'), 'Seguir en «A medias» cuando el ítem trae su trabajo');
  // Pieza 8: la búsqueda del Registro va al servidor, con debounce.
  assert.ok(registroUi.includes("'&texto=' + encodeURIComponent(registroTexto201)"), 'texto= viaja en GET /api/registro');
  assert.ok(registroUi.includes('registroTextoTimer230') && registroUi.includes('}, 300);'), 'debounce de 300 ms');
  // Pieza 13: conciliación con PDF/Excel reales y su mes.
  assert.ok(outputsUi.includes('reportes/conciliacion?rfc='), 'la fila baja del endpoint de conciliación');
  assert.ok(!outputsUi.includes('Sin PDF ni Excel propios'), 'el texto viejo se retira');
  assert.ok(outputsUi.includes("'Ver e imprimir en Bancos'"), 'el botón de Bancos se queda: nada desaparece');
  // Pieza 14: la programación, en llano y sin controles.
  assert.ok(declUi.includes('Cada día 18, PacoSAT baja solo el acuse del mes anterior y te avisa.'),
    'la frase de la programación fija está en la vista');
  // Pieza 16: la tarjeta push solo se pinta si llega del servidor.
  assert.ok(saludUi.includes("tarjeta.id === 'push'"), 'Salud trata la tarjeta push del servidor');
  assert.ok(!saludUi.includes("id: 'push'"), 'el cliente no fabrica la tarjeta push');
  // Pieza 17: probar Paperless en el panel y al guardar activo.
  assert.ok(settingsUi.includes("satApi('paperless/probar', {})"), 'Probar conexión llama al endpoint');
  assert.ok(settingsUi.includes('pruebaGuardada230'), 'el resultado de la prueba queda a la vista tras repintar');
  // Pieza 19: ensayo a un toque en la propia tarjeta.
  assert.ok(saludUi.includes('Probar la restauración ahora'), 'el botón del ensayo está en la tarjeta de respaldo');
  assert.ok(saludUi.includes("satApi('backup/restore-test', {})"), 'el ensayo llama al endpoint del contrato');
  assert.ok(saludUi.includes('Falta un gesto tuyo'), 'sin contraseña se dice en llano, no como error técnico');
  // Pieza 20: comercial solo con status.comercial === true.
  assert.ok(/satData\?\.comercial === true\) panels\.push\(comercialPanel230\(\)\)/.test(settingsUi),
    'el panel comercial nace solo con comercial:true');
  assert.equal((settingsUi.match(/comercialPanel230\(\)/g) || []).length, 2,
    'una sola llamada (la condicionada) y la definición: sin comercial no hay ni rastro');
  console.log('OK 2.3.0·C cableado — piezas 6, 8, 13, 14, 16, 17, 19 y 20 fijadas en sus fuentes.');
}

/* ---- El artefacto construido lleva las piezas de las partes principales ---- */
{
  /* RE-BASE integración 2.4.0 (W6/W6b): varias marcas de esta
     lista viven hoy en partes diferidas — 'trabajos/seguir' en
     Vigilancia, «Cada día 18…» y declMenuTexto230 en
     Declaraciones, «Ojo: esta ventana…» en Descargas — y en el
     artefacto solo quedan, cuando quedan, menciones en
     comentarios que el build retira. Cada marca se busca en
     artefacto + TODAS las partes de lazy.json (lo que el
     navegador recibe en total), con la misma fuerza. */
  const lazy230 = JSON.parse(leer('lazy.json'));
  const todo230 = artefacto + Object.values(lazy230.partes).map(p => p.source).join('\n');
  const donde230 = () => todo230;
  for (const marca of ['Qué cambió desde ayer', 'Tus empresas', 'foto-rfc', 'trabajos/seguir',
    'Residente: sin reportar todavía', 'Cada día 18, PacoSAT baja solo el acuse del mes anterior',
    'Ojo: esta ventana ya se pidió el', 'puertaLinea230', 'declMenuTexto230'])
    assert.ok(donde230(marca).includes(marca), 'el artefacto incluye: ' + marca);
  console.log('OK 2.3.0·C artefacto — Faro-Fiscal.html construido con las piezas del cliente.');
}

console.log('SUITE 2.3.0 CLIENTE: TODO OK');
