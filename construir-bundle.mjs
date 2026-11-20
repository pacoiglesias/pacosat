/* ================================================================
   CONSTRUCTOR DEL PAQUETE DEL EJECUTOR PARA EL REPO (GHCR)

   Por qué existe: el Dockerfile copia ejecutor-bundle.zip y
   ejecutor-bundle.json, pero el .zip NO vive en el repo (está en
   .gitignore: lo produce quien empaqueta). Sin este paso, la
   imagen de GHCR no se puede construir desde una copia limpia
   del repo. Este script hace en el runner lo que antes hacía el
   coordinador a mano en su máquina:

     1. Lee la versión del paquete de ejecutor/package.json.
     2. SELLA la carpeta ejecutor/ con empaquetar-ejecutor.mjs
        (estampa la versión en su package.json y su LEEME.txt).
     3. Regenera ejecutor/node_modules con npm ci desde su
        package-lock.json (la fuente versionada no lo trae).
     4. Vuelve a sellar: la huellaPaquete del manifiesto cubre
        node_modules, así que el manifiesto bueno solo se puede
        computar sobre la carpeta ya completa.
     5. Comprime el CONTENIDO de ejecutor/ en ejecutor-bundle.zip
        (las entradas empiezan en INSTALAR.bat, sin carpeta
        padre; node_modules incluido; orden alfabético estable).
        Los enlaces simbólicos se guardan como el fichero destino,
        igual que la huella los juzga (Integración-3 del sellador).
     6. Escribe ejecutor-bundle.json = manifiesto del sellador +
        el sha256 del zip producido.
     7. AUTOCOMPROBACIÓN: verifica el paquete con el propio
        sellador (--verificar) y muere con error si no pasa.

   Requisito: la raíz debe tener node_modules (el sellador y este
   script importan jszip, que llega con el npm ci de la raíz).

   Uso:  node construir-bundle.mjs
   ================================================================ */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';

const RAIZ = dirname(fileURLToPath(import.meta.url));
const DIR_EJECUTOR = join(RAIZ, 'ejecutor');
const SELLADOR = join(RAIZ, 'empaquetar-ejecutor.mjs');
const ZIP_SALIDA = join(RAIZ, 'ejecutor-bundle.zip');
const JSON_SALIDA = join(RAIZ, 'ejecutor-bundle.json');
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function ejecutar(comando, args) {
  console.log('[construir-bundle] + ' + [comando, ...args].join(' '));
  execFileSync(comando, args, { stdio: 'inherit' });
}

/* Enumeración de ficheros con la misma regla de enlaces que
   listarFicheros232 del ejecutor: un symlink a fichero cuenta
   con la ruta del enlace y el contenido del destino; un symlink
   a directorio se recorre por la ruta del enlace; guarda contra
   bucles por ruta real de los ancestros y tope de profundidad. */
function listarFicheros(base, dir = base, acc = [], ancestros = null, profundidad = 0) {
  if (profundidad > 32) return acc;
  let real;
  try { real = realpathSync(dir); } catch { real = dir; }
  if (ancestros && ancestros.has(real)) return acc;
  const cadena = new Set(ancestros || []);
  cadena.add(real);
  let entradas;
  try { entradas = readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  entradas.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entrada of entradas) {
    const ruta = join(dir, entrada.name);
    if (entrada.isDirectory()) { listarFicheros(base, ruta, acc, cadena, profundidad + 1); continue; }
    if (entrada.isFile()) { acc.push(relative(base, ruta).split(sep).join('/')); continue; }
    if (!entrada.isSymbolicLink()) continue;
    let destino;
    try { destino = statSync(ruta); } catch { continue; }
    if (destino.isDirectory()) listarFicheros(base, ruta, acc, cadena, profundidad + 1);
    else if (destino.isFile()) acc.push(relative(base, ruta).split(sep).join('/'));
  }
  return acc;
}

async function main() {
  if (!existsSync(join(DIR_EJECUTOR, 'package.json'))) {
    throw new Error('no existe ejecutor/package.json: la fuente del ejecutor debe vivir en ejecutor/');
  }
  const version = String(JSON.parse(readFileSync(join(DIR_EJECUTOR, 'package.json'), 'utf8'))?.version || '');
  if (!version) throw new Error('ejecutor/package.json no trae versión');
  console.log('[construir-bundle] versión del ejecutor: ' + version);

  const tmp = mkdtempSync(join(tmpdir(), 'pacosat-bundle-'));
  const manifiestoTmp = join(tmp, 'manifiesto.json');
  try {
    /* Sello 1: estampa la versión en la carpeta (package.json y
       LEEME.txt). El manifiesto de esta pasada es provisional:
       su huellaPaquete aún no cubre node_modules. */
    ejecutar(process.execPath, [SELLADOR, '--dir', DIR_EJECUTOR, '--version', version, '--out', manifiestoTmp]);

    /* Dependencias del ejecutor, regeneradas desde su lock. */
    ejecutar(NPM, ['ci', '--prefix', DIR_EJECUTOR, '--no-audit', '--no-fund']);

    /* Sello 2: con la carpeta completa, el sellador computa el
       manifiesto definitivo (huellaMotores y huellaPaquete). */
    ejecutar(process.execPath, [SELLADOR, '--dir', DIR_EJECUTOR, '--version', version, '--out', manifiestoTmp]);
    const manifiesto = JSON.parse(readFileSync(manifiestoTmp, 'utf8'));

    /* El zip: contenido de ejecutor/, entradas en orden
       alfabético estable, symlinks materializados. */
    const ficheros = listarFicheros(DIR_EJECUTOR).sort();
    if (!ficheros.length) throw new Error('la carpeta ejecutor/ quedó vacía: nada que comprimir');
    const zip = new JSZip();
    for (const rel of ficheros) zip.file(rel, readFileSync(join(DIR_EJECUTOR, rel)));
    const contenido = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } });
    writeFileSync(ZIP_SALIDA, contenido);
    const sha256 = createHash('sha256').update(contenido).digest('hex');
    console.log('[construir-bundle] ejecutor-bundle.zip: ' + ficheros.length + ' entradas, ' + contenido.length + ' B, sha256 ' + sha256);

    /* El manifiesto final: el del sellador + el sha256 del zip. */
    const final = { version: manifiesto.version, sha256, huellaMotores: manifiesto.huellaMotores, huellaPaquete: manifiesto.huellaPaquete };
    writeFileSync(JSON_SALIDA, JSON.stringify(final, null, 2) + '\n');
    console.log('[construir-bundle] ejecutor-bundle.json: ' + JSON.stringify(final));

    /* Autocomprobación con el propio sellador: carpeta ⇄ zip ⇄
       manifiesto. Si no pasa, execFileSync lanza y el script
       muere con error — el paquete no se da por bueno. */
    ejecutar(process.execPath, [SELLADOR, '--verificar', '--dir', DIR_EJECUTOR, '--zip', ZIP_SALIDA, '--manifiesto', JSON_SALIDA]);
    console.log('[construir-bundle] OK: paquete construido y verificado.');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error('[construir-bundle] ERROR: ' + (error?.message || error));
  process.exitCode = 1;
});
