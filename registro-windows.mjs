/* ================================================================
   REGISTRO EN WINDOWS DEL EJECUTOR DE PACOSAT (2.0.1, mejora 31)
   ----------------------------------------------------------------
   El ejecutor deja de ser «una carpeta con un .bat que se lanza a
   mano» y pasa a ser un programa residente de verdad:

   1. PROTOCOLO pacosat:// — la clave HKCU\Software\Classes\pacosat
      (con su marca «URL Protocol») hace que los botones de PacoSAT
      («Ejecutar aquí» / «Abrir ejecutor», que enlazan a
      pacosat://ejecutar) despierten al ejecutor de ESTE equipo.
   2. RESIDENCIA — el valor «PacoSAT Ejecutor» en
      HKCU\Software\Microsoft\Windows\CurrentVersion\Run hace que
      Windows lo arranque solo, oculto y en segundo plano, en cada
      inicio de sesión. Es el comportamiento POR DEFECTO: Paco
      pulsa «Consultar el Buzón» y el trabajo sale porque el
      ejecutor ya está despierto. Solo deja de crearse si existe
      el marcador de rechazo `sin-arranque-automatico` en la
      carpeta de instalación (el rechazo que el instalador ofrece
      explicar y registrar; se respeta en todos los caminos).

   La pieza central es asegurarResidencia(): idempotente y
   silenciosa. Comprueba el estado ANTES de escribir y solo aplica
   lo que falta. La usan igual el instalador y el arranque del
   propio ejecutor, de modo que una instalación viva que se
   auto-actualice a la 2.0.1 queda residente sin reinstalar nada
   y sin que nadie toque carpetas.

   Todo se hace con reg.exe, que viene con Windows: sin
   dependencias nuevas. Las funciones puras GENERAN las
   operaciones exactas (y las pruebas las afirman); la parte que
   ejecuta solo actúa en win32 y en cualquier otro sistema es un
   no-op declarado. Nada de esto imprime secretos: aquí no hay
   ninguno — ni token, ni e.firma, ni rutas que vengan del
   servidor. La carpeta de instalación se sabe AQUÍ, en este PC,
   porque este fichero vive en ella; nadie se la pide a PacoSAT.
   ================================================================ */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROTOCOLO_URL = 'pacosat://ejecutar';
export const MARCADOR_SIN_ARRANQUE = 'sin-arranque-automatico';
export const CLAVE_PROTOCOLO = 'HKCU\\Software\\Classes\\pacosat';
export const CLAVE_RUN = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
export const NOMBRE_RUN = 'PacoSAT Ejecutor';
export const NOMBRE_LANZADOR = 'despertar.vbs';

const carpetaPropia = () => dirname(fileURLToPath(import.meta.url));

/* ---------- Piezas puras: los comandos exactos ---------- */

/* El lanzador en segundo plano: wscript.exe corre despertar.vbs
   sin consola y sin ventana; el .vbs decide si el ejecutor ya
   corre (instancia única) y, si no, lo arranca oculto. La ruta se
   compone con la barra de Windows siempre: es un comando PARA
   Windows, y así su texto exacto es el mismo se genere donde se
   genere (las pruebas lo afirman letra a letra). */
export function comandoLanzador(dir = carpetaPropia()) {
  return 'wscript.exe "' + String(dir).replace(/[\\/]+$/, '') + '\\' + NOMBRE_LANZADOR + '"';
}

/* El comando de apertura del protocolo lleva "%1": Windows
   sustituye ahí la URL completa (pacosat://ejecutar). */
export function comandoApertura(dir = carpetaPropia()) {
  return comandoLanzador(dir) + ' "%1"';
}

const opRegAdd = (clave, nombre, datos) => ({
  tipo: 'reg-add', clave, nombre, datos,
  args: nombre == null
    ? ['add', clave, '/ve', '/d', datos, '/f']
    : ['add', clave, '/v', nombre, '/d', datos, '/f'],
});
const opRegDelete = (clave, nombre) => ({
  tipo: 'reg-delete', clave, nombre, datos: null,
  args: ['delete', clave, '/v', nombre, '/f'],
});

/* Las operaciones COMPLETAS del registro, en orden. El arranque
   automático solo entra si arranqueAutomatico es true (sin
   marcador de rechazo); con rechazo, en su lugar va el borrado
   del valor Run, para que una residencia anterior no sobreviva
   a la decisión de Paco. */
export function operacionesRegistro({ dir = carpetaPropia(), arranqueAutomatico = true } = {}) {
  const ops = [
    opRegAdd(CLAVE_PROTOCOLO, null, 'URL:PacoSAT Ejecutor'),
    opRegAdd(CLAVE_PROTOCOLO, 'URL Protocol', ''),
    opRegAdd(CLAVE_PROTOCOLO + '\\shell\\open\\command', null, comandoApertura(dir)),
  ];
  if (arranqueAutomatico) ops.push(opRegAdd(CLAVE_RUN, NOMBRE_RUN, comandoLanzador(dir)));
  else ops.push(opRegDelete(CLAVE_RUN, NOMBRE_RUN));
  return ops;
}

/* Las consultas de estado: qué hay hoy en el registro. */
export function consultasEstado() {
  return [
    { campo: 'comandoApertura', args: ['query', CLAVE_PROTOCOLO + '\\shell\\open\\command', '/ve'] },
    { campo: 'comandoRun', args: ['query', CLAVE_RUN, '/v', NOMBRE_RUN] },
  ];
}

/* De la salida de `reg query` se extrae el dato REG_SZ de la
   línea del valor pedido; null si la clave/valor no existe. */
export function extraerValorReg(salida) {
  for (const linea of String(salida || '').split(/\r?\n/)) {
    const i = linea.indexOf('REG_SZ');
    if (i >= 0) return linea.slice(i + 'REG_SZ'.length).trim();
  }
  return null;
}

/* ¿Hay marcador de rechazo en esta carpeta de instalación? */
export function hayRechazoArranque(dir = carpetaPropia()) {
  return existsSync(join(dir, MARCADOR_SIN_ARRANQUE));
}

/* Lo que FALTA por aplicar dado un estado leído: función pura,
   es el corazón de la idempotencia. Estado esperado = el
   protocolo apunta a este lanzador y, según el rechazo, el Run
   apunta a este lanzador o no existe. */
export function operacionesPendientes(estado = {}, { dir = carpetaPropia(), arranqueAutomatico = true } = {}) {
  const ops = [];
  if (estado.comandoApertura !== comandoApertura(dir)) {
    ops.push(
      opRegAdd(CLAVE_PROTOCOLO, null, 'URL:PacoSAT Ejecutor'),
      opRegAdd(CLAVE_PROTOCOLO, 'URL Protocol', ''),
      opRegAdd(CLAVE_PROTOCOLO + '\\shell\\open\\command', null, comandoApertura(dir)));
  }
  if (arranqueAutomatico) {
    if (estado.comandoRun !== comandoLanzador(dir)) ops.push(opRegAdd(CLAVE_RUN, NOMBRE_RUN, comandoLanzador(dir)));
  } else if (estado.comandoRun != null) {
    ops.push(opRegDelete(CLAVE_RUN, NOMBRE_RUN));
  }
  return ops;
}

/* ¿Ya está todo registrado tal cual toca? */
export function estadoCompleto(estado = {}, opciones = {}) {
  return operacionesPendientes(estado, opciones).length === 0;
}

/* ---------- Parte ejecutora: solo Windows, vía reg.exe ---------- */

function reg(args) {
  return new Promise(resolve => {
    execFile('reg.exe', args, { windowsHide: true }, (error, stdout) => {
      resolve({ ok: !error, codigo: error ? (error.code ?? 1) : 0, salida: String(stdout || '') });
    });
  });
}

/* Lee el estado real del registro. Fuera de Windows: no-op
   declarado, estado vacío y motivo dicho. */
export async function estadoRegistro({ dir = carpetaPropia() } = {}) {
  if (process.platform !== 'win32') {
    return { plataforma: process.platform, comandoApertura: null, comandoRun: null, motivo: 'no-windows' };
  }
  const estado = { plataforma: process.platform, comandoApertura: null, comandoRun: null };
  for (const consulta of consultasEstado()) {
    const r = await reg(consulta.args);
    estado[consulta.campo] = r.ok ? extraerValorReg(r.salida) : null;
  }
  return estado;
}

/* Aplica una lista de operaciones ya generada. Fuera de Windows
   no toca nada y lo declara. Nunca lanza: devuelve el detalle. */
export async function aplicarOperaciones(ops = []) {
  if (process.platform !== 'win32') {
    return { aplicado: false, motivo: 'no-windows', hechas: 0, fallos: ops.map(op => op.clave + ' (no-windows)') };
  }
  let hechas = 0; const fallos = [];
  for (const op of ops) {
    const r = await reg(op.args);
    if (r.ok) hechas++; else fallos.push(op.clave + (op.nombre ? ' / ' + op.nombre : ''));
  }
  return { aplicado: fallos.length === 0, hechas, fallos };
}

/* ================================================================
   asegurarResidencia() — LA entrada. Idempotente y silenciosa:
   - respeta el marcador de rechazo (sin Run; y si un Run viejo
     sobreviviera al rechazo, lo retira);
   - comprueba el estado antes de escribir: si todo está ya como
     toca, no escribe nada;
   - fuera de Windows, o si reg.exe falla, devuelve el motivo y
     NO lanza: quien la llama al arrancar sigue su camino.
   La usan igual instalar.mjs y el arranque del ejecutor.
   ================================================================ */
export async function asegurarResidencia({ dir = carpetaPropia() } = {}) {
  try {
    if (process.platform !== 'win32') {
      return { ok: false, aplicado: false, motivo: 'no-windows', arranqueAutomatico: false, pendientes: 0 };
    }
    const arranqueAutomatico = !hayRechazoArranque(dir);
    const estado = await estadoRegistro({ dir });
    const pendientes = operacionesPendientes(estado, { dir, arranqueAutomatico });
    if (!pendientes.length) {
      return { ok: true, aplicado: false, motivo: 'ya-residente', arranqueAutomatico, pendientes: 0 };
    }
    const r = await aplicarOperaciones(pendientes);
    return { ok: r.aplicado, aplicado: r.hechas > 0, motivo: r.aplicado ? 'registrado' : 'reg-fallo',
      arranqueAutomatico, pendientes: pendientes.length, fallos: r.fallos };
  } catch (error) {
    return { ok: false, aplicado: false, motivo: 'error: ' + (error?.message || error), arranqueAutomatico: false, pendientes: 0 };
  }
}
