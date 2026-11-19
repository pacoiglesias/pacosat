import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MARCADOR_SIN_ARRANQUE, comandoLanzador, comandoApertura,
  residenciaDesdeEstado, estadoResidencia,
} from './registro-windows.mjs';
import {
  INSTANCIAS_ESTE_PROCESO230, medirInstancias232, residenciaLatido230,
  operacionesConAcuse230, aplicarSeguir230,
} from './ejecutor-local.mjs';

/* ================================================================
   Ronda 2.3.0 — EJECUTOR: residencia verificable y «Seguir» real.

   Pieza 5: el latido manda `residencia` { registrada, protocolo,
   rechazada } LEÍDA del estado real (registro de Windows +
   marcador de rechazo), no declarada a ciegas, y — desde la
   2.3.2 (M-4) — `instancias` SOLO cuando medirInstancias232 lo
   mide de verdad (WMI en Windows, /proc en Linux): si no se
   mide, el campo no se manda (la constante instancias = 1 de
   la 2.3.0 quedó condenada por E-04/M-4). La interpretación
   pura se juzga aquí entera en Linux con estados fingidos
   exactos; la lectura real del registro solo existe en
   Windows — en cualquier otro sistema los hechos van a false
   y eso también se afirma. La suite no lee la carpeta del
   bundle ni ninguna pieza que no viva en este árbol: corre
   entera donde corre.

   Pieza 6: declaraciones-recuperar honra { soloFaltantes,
   operacionesConAcuse } y su resultado lleva
   progreso.operacionesCompletadas con las que ESTA corrida
   dejó con acuse. Los demás tipos son atómicos: su rama no
   lleva progreso (se afirma sobre el código) y un trabajo
   cancelado a mitad no deja resultado parcial aplicado en el
   servidor — el descarte de completeExecutorJob va ANTES de
   validar/aplicar nada, y aquí se afirma ese orden en el
   código del servidor (solo lectura).
   ================================================================ */

const AQUI = dirname(fileURLToPath(import.meta.url));
const leer = nombre => readFileSync(join(AQUI, nombre), 'utf8');
const DIR = 'C:\\Users\\Paco\\PacoSAT-Ejecutor';
const LANZADOR = comandoLanzador(DIR);
const APERTURA = comandoApertura(DIR);

/* ---------- (5a) La interpretación pura de la residencia ---------- */
assert.deepEqual(
  residenciaDesdeEstado({ comandoApertura: APERTURA, comandoRun: LANZADOR }, { dir: DIR, rechazada: false }),
  { registrada: true, protocolo: true, rechazada: false },
  'Run y protocolo apuntando a ESTE lanzador: residencia completa');
assert.deepEqual(
  residenciaDesdeEstado({ comandoApertura: APERTURA, comandoRun: 'wscript.exe "C:\\Otro\\despertar.vbs"' }, { dir: DIR }),
  { registrada: false, protocolo: true, rechazada: false },
  'un Run de OTRA carpeta no cuenta como residencia de esta');
assert.deepEqual(
  residenciaDesdeEstado({ comandoApertura: null, comandoRun: LANZADOR }, { dir: DIR }),
  { registrada: true, protocolo: false, rechazada: false },
  'sin comando de apertura no hay protocolo, aunque el Run sí conste como residencia');
assert.deepEqual(
  residenciaDesdeEstado({ comandoApertura: APERTURA, comandoRun: LANZADOR }, { dir: DIR, rechazada: true }),
  { registrada: true, protocolo: true, rechazada: true },
  'el rechazo viaja como hecho propio, sin maquillar los demás');
assert.deepEqual(
  residenciaDesdeEstado({}, { dir: DIR }),
  { registrada: false, protocolo: false, rechazada: false },
  'estado vacío: todo a false, con la misma forma');

/* ---------- (5b) La lectura real: marcador y plataforma ---------- */
const tmpRes = mkdtempSync(join(tmpdir(), 'pacosat-residencia-'));
try {
  const sinMarcador = await estadoResidencia({ dir: tmpRes });
  assert.deepEqual(Object.keys(sinMarcador).sort(), ['protocolo', 'rechazada', 'registrada'],
    'estadoResidencia devuelve exactamente los tres hechos del contrato');
  assert.equal(sinMarcador.rechazada, false, 'sin marcador no hay rechazo');
  writeFileSync(join(tmpRes, MARCADOR_SIN_ARRANQUE), 'sin arranque\n');
  const conMarcador = await estadoResidencia({ dir: tmpRes });
  assert.equal(conMarcador.rechazada, true, 'el marcador de rechazo manda en la lectura real');
  if (process.platform !== 'win32') {
    assert.equal(sinMarcador.registrada, false, 'fuera de Windows no hay Run que leer: false declarado');
    assert.equal(sinMarcador.protocolo, false, 'fuera de Windows no hay protocolo que leer: false declarado');
    assert.equal(conMarcador.registrada, false);
    assert.equal(conMarcador.protocolo, false);
  } else {
    console.log('ronda230ejecutor: en Windows las lecturas de registro de estadoResidencia ' +
      'dependen del registro real de la máquina; se afirma su forma, no sus valores.');
  }
} finally { rmSync(tmpRes, { recursive: true, force: true }); }

/* ---------- (5c) El objeto del latido, entero ---------- */
const tmpLatido = mkdtempSync(join(tmpdir(), 'pacosat-latido-'));
try {
  const latidoSin = await residenciaLatido230({ dir: tmpLatido });
  /* Contrato M-4 (2.3.2, constructor B2a): los tres hechos
     viajan siempre; `instancias` SOLO viaja si se midió de
     verdad en este entorno. Si la medición no está disponible
     aquí, el campo no debe venir; si viene, debe ser el conteo
     que medirInstancias232 mide en este mismo entorno — un
     entero ≥ 1 —, nunca la constante 1 de la 2.3.0. */
  assert.deepEqual(Object.keys(latidoSin).filter(clave => clave !== 'instancias').sort(),
    ['protocolo', 'rechazada', 'registrada'],
    'el latido lleva siempre los tres hechos de la residencia');
  if ('instancias' in latidoSin) {
    assert.ok(Number.isInteger(latidoSin.instancias) && latidoSin.instancias >= 1,
      'si instancias viene, es un conteo medido (entero ≥ 1), no una constante');
    assert.equal(latidoSin.instancias, medirInstancias232(tmpLatido),
      'y es exactamente el conteo que la medición real da en este entorno');
  } else {
    assert.equal(medirInstancias232(tmpLatido), null,
      'si instancias no viene, es porque la medición no está disponible en este entorno (null)');
  }
  assert.equal(INSTANCIAS_ESTE_PROCESO230, 1,
    'la constante de la 2.3.0 queda solo como referencia histórica: ya no se reporta');
  /* El contrato, juzgado con medición inyectada (determinista
     en cualquier entorno): sin medición no hay campo; con
     medición viaja ESE conteo, no la constante; un conteo que
     no es un entero ≥ 1 tampoco se manda. */
  const latidoSinMedicion = await residenciaLatido230({ dir: tmpLatido, medirInstancias: () => null });
  assert.ok(!('instancias' in latidoSinMedicion),
    'M-4: sin medición disponible, el campo instancias NO se manda');
  assert.deepEqual(Object.keys(latidoSinMedicion).sort(), ['protocolo', 'rechazada', 'registrada'],
    'M-4: sin medición, la residencia lleva exactamente los tres hechos');
  const latidoMedido = await residenciaLatido230({ dir: tmpLatido, medirInstancias: () => 3 });
  assert.equal(latidoMedido.instancias, 3,
    'M-4: si se mide, viaja el conteo medido (3), no la constante 1 de la 2.3.0');
  const latidoMedicionInvalida = await residenciaLatido230({ dir: tmpLatido, medirInstancias: () => 0 });
  assert.ok(!('instancias' in latidoMedicionInvalida),
    'M-4: un conteo que no es un entero ≥ 1 no se manda como instancias');
  writeFileSync(join(tmpLatido, MARCADOR_SIN_ARRANQUE), 'sin arranque\n');
  const latidoCon = await residenciaLatido230({ dir: tmpLatido });
  assert.equal(latidoCon.rechazada, true, 'el latido refleja el rechazo leído, no una constante');
  if (process.platform !== 'win32') {
    assert.equal(latidoSin.registrada, false, 'en Linux el hecho registrada va a false');
    assert.equal(latidoSin.protocolo, false, 'en Linux el hecho protocolo va a false');
    assert.equal(latidoSin.rechazada, false, 'en Linux, sin marcador, el hecho rechazada va a false');
  }
} finally { rmSync(tmpLatido, { recursive: true, force: true }); }

/* El mecanismo de instancia única que el ejecutor ya usa: el
   lanzador despertar.vbs (en el árbol) consulta por WMI los
   node con ejecutor-local.mjs de ESTA carpeta y no arranca
   otro si ya corre. (Desde M-4 esa misma consulta WMI es la
   que mide `instancias` cuando el campo viaja: ver 5c.) */
const vbs = leer('despertar.vbs');
assert.ok(vbs.includes("Name = 'node.exe' AND CommandLine LIKE '%ejecutor-local.mjs%'"),
  'la instancia única vive en despertar.vbs: consulta WMI del ejecutor en curso');
assert.ok(vbs.includes('InStr(1, p.CommandLine, carpeta, vbTextCompare)'),
  'y se ciñe a ESTA carpeta: es el hueco que este proceso ocupa');

/* El latido del ciclo manda la residencia leída, no {} */
const fuenteEjecutor = leer('ejecutor-local.mjs');
/* Actualizado en la ronda 2.3.1 (constructor B): el latido
   manda { residencia, reporte } — la residencia de siempre MÁS
   el reporte de versión (versión + huella de motores). La
   afirmación sigue juzgando lo mismo: la residencia viaja en
   cada latido, leída en el ciclo. */
assert.ok(fuenteEjecutor.includes("await api('/api/executor/heartbeat', { residencia, reporte: reporteVersion231() })"),
  'ciclo() manda { residencia, reporte } en el heartbeat (la residencia, como siempre, y el reporte de versión de la 2.3.1)');
assert.ok(fuenteEjecutor.includes('const residencia = await residenciaLatido230();'),
  'y la residencia se lee en cada ciclo, no se calcula una vez al arrancar');
assert.ok(fuenteEjecutor.includes("from './registro-windows.mjs'") &&
  fuenteEjecutor.includes('estadoResidencia'),
  'la lectura se reutiliza de registro-windows.mjs, no se duplica en el ejecutor');

/* ---------- (6a) «Seguir»: las operaciones que ya tienen acuse ---------- */
assert.deepEqual(operacionesConAcuse230({ operacionesConAcuse: ['111', ' 222 ', '111', '', null] }),
  ['111', '222'], 'la lista se normaliza: sin espacios, sin duplicados, sin vacíos');
assert.deepEqual(operacionesConAcuse230({}), [], 'sin lista, ninguna operación consta con acuse');
assert.deepEqual(operacionesConAcuse230({ operacionesConAcuse: '111' }), [],
  'una lista que no es lista no se honra como tal');

const docs = [
  { operacion: '111', clase: 'acuse', periodo: '2026-01' },
  { operacion: '222', clase: 'acuse', periodo: '2026-02' },
  { operacion: '333', clase: 'acuse', periodo: '2026-03' },
  { operacion: '333', clase: 'declaracion', periodo: '2026-03' },
];

const seguir = aplicarSeguir230(docs, { soloFaltantes: true, operacionesConAcuse: ['111', '222'] });
assert.deepEqual(seguir.documents.map(d => d.operacion), ['333', '333'],
  'soloFaltantes: solo viajan los documentos de las operaciones que faltan');
assert.deepEqual(seguir.saltadas, ['111', '222'], 'las saltadas quedan nombradas');
assert.deepEqual(seguir.progreso, { operacionesCompletadas: ['333'] },
  'el progreso nombra solo las que ESTA corrida dejó con acuse: ni las saltadas ni duplicados');

const seguirEspacios = aplicarSeguir230(docs, { soloFaltantes: true, operacionesConAcuse: ['1 11'] });
assert.deepEqual(seguirEspacios.saltadas, ['111'],
  'la comparación es por la forma sin espacios, como en el protocolo del servidor');

const completo = aplicarSeguir230(docs, { operacionesConAcuse: ['111', '222'] });
assert.equal(completo.documents.length, 4, 'sin soloFaltantes la corrida es completa: nada se descarta');
assert.deepEqual(completo.saltadas, []);
assert.deepEqual(completo.progreso.operacionesCompletadas, ['111', '222', '333'],
  'y su progreso nombra todas las que esta corrida dejó con acuse');

const todoHecho = aplicarSeguir230(docs, { soloFaltantes: true, operacionesConAcuse: ['111', '222', '333'] });
assert.deepEqual(todoHecho.documents, [], 'si todo tenía ya acuse, no viaja ningún documento');
assert.deepEqual(todoHecho.progreso.operacionesCompletadas, [],
  'y el progreso va vacío: esta corrida no dejó ninguna con acuse');

/* ---------- (6b) La rama del ejecutor y la atomicidad de los demás ---------- */
const idxSeguir = fuenteEjecutor.indexOf("if (job.kind === 'declaraciones-recuperar') {");
assert.ok(idxSeguir >= 0, 'hay una rama propia de declaraciones-recuperar para el «Seguir»');
const bloqueSeguir = fuenteEjecutor.slice(idxSeguir, idxSeguir + 700);
assert.ok(bloqueSeguir.includes('aplicarSeguir230(salida.documents, job.payload || {})') &&
  bloqueSeguir.includes('salida.progreso = seguir.progreso;'),
  'esa rama honra el payload del trabajo y adjunta el progreso a su resultado');
assert.equal((fuenteEjecutor.match(/salida\.progreso/g) || []).length, 1,
  'una sola asignación de progreso en todo el ejecutor: declaracion-folio, ' +
  'declaraciones-transacciones y los demás tipos no llevan progreso — son atómicos y no cambian');

/* Cancelación a mitad: el ejecutor detiene el trabajo en su
   siguiente paso (estaCancelado en cada onStep y antes de cada
   intento) y, si aun así un resultado llegara, el servidor lo
   descarta ENTERO antes de validar o aplicar nada — se afirma
   el orden dentro de completeExecutorJob (solo lectura). */
assert.ok(fuenteEjecutor.includes('if (estaCancelado(job)) throw errorCancelado();'),
  'cada paso del ejecutor consulta la cancelación remota antes de anotarse');
const fuenteServidor = leer('local-server.mjs');
const iniComplete = fuenteServidor.indexOf('function completeExecutorJob');
const finComplete = fuenteServidor.indexOf('function ', iniComplete + 10);
const cuerpoComplete = fuenteServidor.slice(iniComplete, finComplete > iniComplete ? finComplete : iniComplete + 6000);
const idxDescarte = cuerpoComplete.indexOf("jobRow.estado === 'cancelado'");
const idxValidar = cuerpoComplete.indexOf('validateExecutorResult(job, body');
assert.ok(idxDescarte >= 0, 'completeExecutorJob reconoce el trabajo cancelado');
assert.ok(idxValidar > idxDescarte,
  'el descarte del cancelado va ANTES de validar/aplicar: ningún resultado parcial se aplica');
assert.ok(cuerpoComplete.slice(idxDescarte, idxValidar).includes('return { ok: false, cancelado: true }'),
  'y devuelve sin tocar documentos, buzón ni espejos');

console.log('ronda230ejecutor: OK — residencia verificable (interpretación pura, lectura real ' +
  'con marcador, objeto del latido y su envío en ciclo) y «Seguir» real en declaraciones-' +
  'recuperar (salto de las que ya tienen acuse, progreso de esta corrida, demás tipos ' +
  'atómicos y descarte del cancelado antes de aplicar nada).');
