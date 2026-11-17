import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PROTOCOLO_URL, MARCADOR_SIN_ARRANQUE, CLAVE_PROTOCOLO, CLAVE_RUN, NOMBRE_RUN,
  comandoLanzador, comandoApertura, operacionesRegistro, consultasEstado,
  extraerValorReg, hayRechazoArranque, operacionesPendientes, estadoCompleto,
  asegurarResidencia, estadoRegistro,
} from './registro-windows.mjs';

/* ================================================================
   Ronda 2.0.1 — MEJORA 31: EJECUTOR INTEGRADO.
   El ejecutor deja de ser una carpeta con un .bat lanzado a mano:
   queda RESIDENTE (arranque automático con Windows por defecto,
   oculto) y PacoSAT lo despierta por el protocolo pacosat://.

   Esta suite afirma A NIVEL DE CÓDIGO (esto corre en Linux; la
   prueba en vivo — clic real, reinicio, icono — queda nombrada
   como pendiente con Paco en la nota de la ronda):
   (1) las operaciones de registro GENERADAS son exactas: clave
       del protocolo con «URL Protocol» y su shell\open\command
       con "%1", y el valor Run SOLO sin marcador de rechazo
       (con rechazo, la operación es el borrado del Run);
   (2) la idempotencia de asegurarResidencia: con el estado ya
       correcto no se genera ninguna operación; fuera de Windows
       es un no-op declarado que no lanza;
   (3) el lanzador despertar.vbs: consulta WMI de instancia
       única ceñida a ESTA carpeta, arranque oculto (ventana 0),
       relanzado tras la auto-actualización (salida 42) y el
       mismo entorno que arrancar.bat (PACOSAT_URL de url.txt,
       token de token.txt, Chrome, PACOSAT_EFIRMA_DIR);
   (4) el instalador: su rama de instalación viva va ANTES que
       el canje del código (no repite emparejamiento ni toca
       credenciales) — probada además corriéndolo de verdad en
       una carpeta temporal con token.txt: no pide código, no
       imprime el token, y el rechazo deja el marcador;
   (5) la bandeja bandeja.ps1: NotifyIcon de Windows, sin
       dependencias, con «Abrir PacoSAT» y «Salir»;
   (6) arrancar.bat sigue existiendo como reserva interna, y los
       ficheros nuevos existen idénticos en el árbol y en la
       carpeta del bundle (viajan en el zip del ejecutor, que se
       compone de la carpeta entera: no hay manifiesto que
       ajustar).
   ================================================================ */

const AQUI = dirname(fileURLToPath(import.meta.url));
const CARPETA_BUNDLE = join(AQUI, '..', '..', 'ejecutor-pacosat');
const leerBundle = nombre => readFileSync(join(CARPETA_BUNDLE, nombre), 'utf8');
/* La carpeta del bundle vive FUERA del repo (es la carpeta de
   trabajo de Paco, hermana del espacio de trabajo): en un checkout
   limpio — la CI — no existe y los bloques (3)-(6), que leen las
   piezas del bundle y las comparan con las del árbol, se omiten
   con su constancia, como las pruebas «extra» de navegador real
   de sat-doc-browser. Donde la carpeta vive corren enteros: la
   prueba que puede fallar sigue pudiendo fallar ahí. */
const HAY_BUNDLE = existsSync(CARPETA_BUNDLE);
const DIR = 'C:\\Users\\Paco\\PacoSAT-Ejecutor';
const LANZADOR = 'wscript.exe "C:\\Users\\Paco\\PacoSAT-Ejecutor\\despertar.vbs"';

/* ---------- (1) Las operaciones exactas del registro ---------- */
assert.equal(PROTOCOLO_URL, 'pacosat://ejecutar', 'el contrato del cliente: pacosat://ejecutar');
assert.equal(comandoLanzador(DIR), LANZADOR);
assert.equal(comandoApertura(DIR), LANZADOR + ' "%1"', 'el comando de apertura lleva "%1"');

const ops = operacionesRegistro({ dir: DIR, arranqueAutomatico: true });
assert.deepEqual(ops[0].args, ['add', CLAVE_PROTOCOLO, '/ve', '/d', 'URL:PacoSAT Ejecutor', '/f']);
assert.deepEqual(ops[1].args, ['add', CLAVE_PROTOCOLO, '/v', 'URL Protocol', '/d', '', '/f'],
  'la marca «URL Protocol» es la que hace que Windows trate pacosat: como protocolo');
assert.deepEqual(ops[2].args, ['add', CLAVE_PROTOCOLO + '\\shell\\open\\command', '/ve', '/d', LANZADOR + ' "%1"', '/f']);
assert.deepEqual(ops[3].args, ['add', CLAVE_RUN, '/v', NOMBRE_RUN, '/d', LANZADOR, '/f'],
  'la residencia: Run apunta al lanzador oculto, sin "%1"');
assert.equal(ops.length, 4);

const opsRechazo = operacionesRegistro({ dir: DIR, arranqueAutomatico: false });
assert.equal(opsRechazo.length, 4);
assert.deepEqual(opsRechazo[3].args, ['delete', CLAVE_RUN, '/v', NOMBRE_RUN, '/f'],
  'con rechazo NO se crea el Run: se borra si un residuo quedara');
assert.ok(!opsRechazo.some(op => op.tipo === 'reg-add' && op.clave === CLAVE_RUN),
  'con marcador de rechazo ninguna operación crea el arranque automático');

assert.deepEqual(consultasEstado(), [
  { campo: 'comandoApertura', args: ['query', CLAVE_PROTOCOLO + '\\shell\\open\\command', '/ve'] },
  { campo: 'comandoRun', args: ['query', CLAVE_RUN, '/v', NOMBRE_RUN] },
]);

const salidaReg = 'HKEY_CURRENT_USER\\Software\\Classes\\pacosat\\shell\\open\\command\r\n' +
  '    (Predeterminado)    REG_SZ    ' + LANZADOR + ' "%1"\r\n';
assert.equal(extraerValorReg(salidaReg), LANZADOR + ' "%1"');
assert.equal(extraerValorReg('ERROR: no se encuentra la clave'), null);

/* ---------- (2) Idempotencia: estado antes de escribir ---------- */
const estadoBueno = { comandoApertura: LANZADOR + ' "%1"', comandoRun: LANZADOR };
assert.deepEqual(operacionesPendientes(estadoBueno, { dir: DIR, arranqueAutomatico: true }), [],
  'ya residente: asegurarResidencia no escribe nada');
assert.equal(estadoCompleto(estadoBueno, { dir: DIR, arranqueAutomatico: true }), true);
assert.equal(operacionesPendientes({}, { dir: DIR, arranqueAutomatico: true }).length, 4,
  'desde cero hacen falta las cuatro operaciones');
assert.equal(operacionesPendientes({ comandoApertura: LANZADOR + ' "%1"', comandoRun: null },
  { dir: DIR, arranqueAutomatico: true }).length, 1, 'solo falta el Run: solo se genera el Run');
assert.deepEqual(operacionesPendientes({ comandoApertura: LANZADOR + ' "%1"', comandoRun: LANZADOR },
  { dir: DIR, arranqueAutomatico: false }).map(op => op.tipo), ['reg-delete'],
  'rechazo con un Run superviviente: la única operación es retirarlo');
assert.deepEqual(operacionesPendientes({ comandoApertura: LANZADOR + ' "%1"', comandoRun: null },
  { dir: DIR, arranqueAutomatico: false }), [], 'rechazo sin Run: nada que hacer');

/* El marcador de rechazo se lee de la carpeta de instalación */
const tmpMarcador = mkdtempSync(join(tmpdir(), 'pacosat-marcador-'));
try {
  assert.equal(hayRechazoArranque(tmpMarcador), false);
  writeFileSync(join(tmpMarcador, MARCADOR_SIN_ARRANQUE), 'sin arranque\n');
  assert.equal(hayRechazoArranque(tmpMarcador), true);
  assert.equal(MARCADOR_SIN_ARRANQUE, 'sin-arranque-automatico');
} finally { rmSync(tmpMarcador, { recursive: true, force: true }); }

/* Fuera de Windows: no-op declarado, jamás un lanzamiento */
if (process.platform !== 'win32') {
  const r = await asegurarResidencia({ dir: DIR });
  assert.equal(r.ok, false);
  assert.equal(r.aplicado, false);
  assert.equal(r.motivo, 'no-windows');
  const e = await estadoRegistro({ dir: DIR });
  assert.equal(e.motivo, 'no-windows');
  assert.equal(e.comandoApertura, null);
}

if (!HAY_BUNDLE) {
  console.log('ronda201integrado: se omiten los bloques (3)-(6) — la carpeta del bundle ' +
    '(ejecutor-pacosat, fuera del repo) no existe en este entorno; la lógica del registro ' +
    'y de la residencia (bloques 1-2) sí ha corrido.');
}
if (HAY_BUNDLE) {
/* ---------- (3) El lanzador despertar.vbs ---------- */
const vbs = leerBundle('despertar.vbs');
assert.ok(vbs.includes('winmgmts:'), 'la instancia única se consulta por WMI');
assert.ok(vbs.includes("Name = 'node.exe' AND CommandLine LIKE '%ejecutor-local.mjs%'"),
  'la consulta WMI busca el node con ejecutor-local.mjs');
assert.ok(vbs.includes('InStr(1, p.CommandLine, carpeta, vbTextCompare)'),
  'y se ciñe a ESTA carpeta: otro ejecutor de otra carpeta no cuenta');
assert.ok(vbs.includes('If YaCorre() Then') && vbs.includes('WScript.Quit 0'),
  'si ya corre: éxito silencioso, no hace nada');
assert.ok(vbs.includes('shell.Run("node """ & carpeta & "\\ejecutor-local.mjs""", 0, True)'),
  'arranque OCULTO: ventana 0 y esperando la salida');
assert.ok(vbs.includes('Loop While codigoSalida = 42'),
  'la auto-actualización (salida 42) relanza, como hacía arrancar.bat');
for (const pieza of ['PACOSAT_URL', 'url.txt', 'https://pacosat.iglesiasmurrieta.com',
    'PACOSAT_EXECUTOR_TOKEN', 'token.txt', 'PACOSAT_CHROMIUM_PATH',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'PACOSAT_EFIRMA_DIR', '\\efirma-local']) {
  assert.ok(vbs.includes(pieza), 'despertar.vbs replica el entorno de arrancar.bat: ' + pieza);
}
assert.ok(!/echo|msgbox|print/i.test(vbs.replace(/'.*$/gm, '')), 'el lanzador no enseña nada por pantalla');

/* ---------- (4) El instalador: instalación viva sin emparejar ---------- */
const instalador = leerBundle('instalar.mjs');
const idxViva = instalador.indexOf("existsSync(join(HERE, 'token.txt')) || existsSync(EFIRMA_DIR)");
const idxCanje = instalador.indexOf('/api/executor/exchange');
assert.ok(idxViva > 0 && idxCanje > idxViva,
  'la rama de instalación viva va ANTES del canje: no se repite el emparejamiento');
assert.ok(instalador.includes('no se repite el emparejamiento ni se toca tu e.firma'));
assert.ok(instalador.includes("from './registro-windows.mjs'"), 'el instalador usa el mismo módulo de registro');
assert.ok(instalador.includes('asegurarResidencia({ dir: HERE })'),
  'instalador y arranque del ejecutor comparten asegurarResidencia');
assert.ok(instalador.includes('MARCADOR_SIN_ARRANQUE'), 'el rechazo del instalador escribe el marcador');
assert.ok(instalador.includes('¿Lo dejo así, residente con arranque automático? [S/n]'),
  'la residencia se ofrece explicada y por defecto, no como casilla escondida');

/* Y corriéndolo de verdad sobre una instalación viva simulada:
   no pide código, no imprime el token, el rechazo deja marcador
   y la llave queda intacta. */
const tmpViva = mkdtempSync(join(tmpdir(), 'pacosat-viva-'));
try {
  copyFileSync(join(CARPETA_BUNDLE, 'instalar.mjs'), join(tmpViva, 'instalar.mjs'));
  copyFileSync(join(CARPETA_BUNDLE, 'registro-windows.mjs'), join(tmpViva, 'registro-windows.mjs'));
  const tokenPrueba = 'token-de-prueba-que-jamas-se-imprime';
  writeFileSync(join(tmpViva, 'token.txt'), tokenPrueba);
  const salida = execFileSync(process.execPath, ['instalar.mjs'], {
    cwd: tmpViva, input: 'n\n', encoding: 'utf8', timeout: 30000 });
  assert.ok(salida.includes('YA tiene el ejecutor instalado'), 'reconoce la instalación viva');
  assert.ok(!salida.includes('Código: '), 'no pide el código corto: no hay re-emparejamiento');
  assert.ok(!salida.includes(tokenPrueba), 'el token jamás se imprime');
  assert.ok(existsSync(join(tmpViva, MARCADOR_SIN_ARRANQUE)), 'el rechazo deja su marcador');
  assert.equal(readFileSync(join(tmpViva, 'token.txt'), 'utf8'), tokenPrueba, 'la llave queda intacta');
  assert.ok(!existsSync(join(tmpViva, 'efirma-local')), 'no se crea ni se toca efirma-local');
} finally { rmSync(tmpViva, { recursive: true, force: true }); }

/* ---------- (5) La bandeja: built-in y sin dependencias ---------- */
const bandeja = leerBundle('bandeja.ps1');
assert.ok(bandeja.includes('System.Windows.Forms.NotifyIcon'), 'el icono es el NotifyIcon de Windows');
assert.ok(bandeja.includes('System.Windows.Forms') && bandeja.includes('System.Drawing'));
assert.ok(bandeja.includes("'Abrir PacoSAT'"), 'la bandeja ofrece «Abrir PacoSAT»');
assert.ok(bandeja.includes("'Salir'"), 'la bandeja ofrece «Salir»');
assert.ok(bandeja.includes('despertar.vbs'), 'la bandeja despierta por el mismo lanzador');
assert.ok(!/Install-Module|Import-Module|Invoke-WebRequest|DownloadString/.test(bandeja),
  'la bandeja no instala ni baja nada: solo lo que Windows ya trae');

/* ---------- (6) Reserva interna y viaje en el bundle ---------- */
const arrancar = leerBundle('arrancar.bat');
assert.ok(arrancar.includes('node ejecutor-local.mjs'), 'arrancar.bat sigue arrancando el ejecutor');
assert.ok(/reserva/i.test(arrancar), 'arrancar.bat se declara camino manual de reserva');
const leeme = leerBundle('LEEME.txt');
assert.ok(leeme.includes('pacosat://ejecutar'), 'el LEEME nombra el contrato del protocolo');
assert.ok(leeme.includes('sin-arranque-automatico'), 'el LEEME nombra el marcador de rechazo');
assert.ok(leeme.includes('no enseña ni') && leeme.includes('pide rutas'),
  'el LEEME dice el límite: la app no enseña ni pide rutas');

for (const nombre of ['registro-windows.mjs', 'despertar.vbs', 'bandeja.ps1']) {
  assert.ok(existsSync(join(CARPETA_BUNDLE, nombre)), nombre + ' está en la carpeta del bundle');
  assert.ok(existsSync(join(AQUI, nombre)), nombre + ' está también en el árbol');
  assert.equal(readFileSync(join(AQUI, nombre), 'utf8'), leerBundle(nombre),
    nombre + ' es idéntico en el árbol y en la carpeta del bundle (viaja en el zip)');
}

}
console.log(HAY_BUNDLE
  ? 'ronda201integrado: ejecutor integrado OK — registro exacto, residencia idempotente, ' +
    'lanzador de instancia única, instalador sin re-emparejamiento, bandeja built-in y reserva interna.'
  : 'ronda201integrado: OK parcial en este entorno — registro exacto y residencia ' +
    'idempotente probados; los bloques del bundle se prueban donde la carpeta vive.');
