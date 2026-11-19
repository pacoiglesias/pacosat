/* ================================================================
   GENERADOR DEL PAQUETE DEL EJECUTOR (2.3.2, constructor B2a;
   o-3 + m-20 + M-2) — vive EN EL ÁRBOL, junto al ejecutor.

   Qué hace, en el equipo que empaqueta (nunca en el del cliente):
   1. SELLA la carpeta suelta del ejecutor con la versión real
      del paquete: package.json interno y la cabecera de
      LEEME.txt dejan de decir 2.0.0 / 2.0.1 (m-20: un diagnóstico
      futuro ya no concluirá «motores 2.0.0»).
   2. COMPUTA el manifiesto ejecutor-bundle.json importando
      huellaMotores / FICHEROS_HUELLA231 / huellaPaquete DEL
      PROPIO ejecutor-local.mjs — UNA sola implementación del
      algoritmo: la huella del manifiesto es reproducible desde
      el repo y no puede derivar de la que el ejecutor recomputa.
   3. VERIFICA: recomputa las huellas desde la carpeta suelta y
      desde el zip ya producido y dice si coinciden entre sí y
      con el manifiesto, y si el package.json dentro del zip
      lleva la versión del manifiesto.

   El zip en sí lo produce el coordinador al empaquetar; este
   script lo sella antes (carpeta) y lo verifica después (zip).

   Uso:
     node empaquetar-ejecutor.mjs --dir <carpeta-ejecutor> --version <X.Y.Z> [--out <manifiesto.json>]
     node empaquetar-ejecutor.mjs --verificar --dir <carpeta-ejecutor> --zip <bundle.zip> --manifiesto <bundle.json>
   Sin --out, el manifiesto se escribe junto a la carpeta
   (en su carpeta padre), que es donde vive en el despliegue.
   ================================================================ */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import JSZip from 'jszip';
import { FICHEROS_HUELLA231, huellaMotores, huellaPaquete } from './ejecutor-local.mjs';

export { FICHEROS_HUELLA231, huellaMotores, huellaPaquete };

/* ---------- Sellos coherentes (m-20) ---------- */
export function sellarVersionPackage232(textoPackage, version) {
  const pkg = JSON.parse(String(textoPackage || ''));
  pkg.version = String(version);
  return JSON.stringify(pkg, null, 2) + '\n';
}
export function sellarLeeme232(textoLeeme, version) {
  const texto = String(textoLeeme || '');
  if (/EJECUTOR LOCAL DE PACOSAT · \S+/.test(texto)) {
    return texto.replace(/(EJECUTOR LOCAL DE PACOSAT · )\S+/, '$1' + String(version));
  }
  return texto;
}
/* Sella la carpeta y DESPUÉS computa el manifiesto: la
   huellaPaquete cubre package.json y LEEME.txt, así que las
   huellas solo cuadran si se computan sobre los ficheros ya
   sellados. Devuelve el manifiesto { version, huellaMotores,
   huellaPaquete } (el sha256 del zip lo añade quien produce el
   zip, que es el coordinador). */
export function sellarCarpeta232(dir, version) {
  const rutaPkg = join(dir, 'package.json');
  if (existsSync(rutaPkg)) writeFileSync(rutaPkg, sellarVersionPackage232(readFileSync(rutaPkg, 'utf8'), version));
  const rutaLeeme = join(dir, 'LEEME.txt');
  if (existsSync(rutaLeeme)) writeFileSync(rutaLeeme, sellarLeeme232(readFileSync(rutaLeeme, 'utf8'), version));
  return computarManifiesto232(dir, version);
}
export function computarManifiesto232(dir, version) {
  return { version: String(version), huellaMotores: huellaMotores(dir), huellaPaquete: huellaPaquete(dir) };
}

/* ---------- Verificación carpeta ⇄ zip ⇄ manifiesto ---------- */
export function verificarCarpeta232(dir, manifiesto) {
  const motivos = [];
  const hm = huellaMotores(dir);
  const hp = huellaPaquete(dir);
  if (manifiesto?.huellaMotores && hm !== manifiesto.huellaMotores) motivos.push('huellaMotores de la carpeta no coincide con el manifiesto');
  if (manifiesto?.huellaPaquete && hp !== manifiesto.huellaPaquete) motivos.push('huellaPaquete de la carpeta no coincide con el manifiesto');
  let versionInterna = '';
  try { versionInterna = String(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))?.version || ''); } catch { /* sin package.json legible */ }
  if (manifiesto?.version && versionInterna && versionInterna !== String(manifiesto.version)) {
    motivos.push('package.json dice ' + versionInterna + ' y el manifiesto ' + manifiesto.version);
  }
  return { ok: motivos.length === 0, motivos, huellaMotores: hm, huellaPaquete: hp, versionInterna };
}
export async function extraerZip232(zipPath, destino) {
  const zip = await JSZip.loadAsync(readFileSync(zipPath));
  for (const [rel, entrada] of Object.entries(zip.files)) {
    if (entrada.dir) continue;
    const ruta = join(destino, rel);
    mkdirSync(dirname(ruta), { recursive: true });
    writeFileSync(ruta, await entrada.async('nodebuffer'));
  }
  return destino;
}
export async function verificarZip232(zipPath, manifiesto) {
  const tmp = mkdtempSync(join(tmpdir(), 'pacosat-zip232-'));
  try {
    await extraerZip232(zipPath, tmp);
    const resultado = verificarCarpeta232(tmp, manifiesto);
    return { ...resultado, desdeZip: true };
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}
/* La comprobación completa de la pieza o-3: la huella recomputada
   desde la carpeta suelta y desde el zip deben coincidir entre
   sí y con el manifiesto. */
export async function verificarPaquete232({ dir, zipPath, manifiesto }) {
  const carpeta = verificarCarpeta232(dir, manifiesto);
  const zip = await verificarZip232(zipPath, manifiesto);
  const motivos = [...carpeta.motivos.map(m => 'carpeta: ' + m), ...zip.motivos.map(m => 'zip: ' + m)];
  if (carpeta.huellaMotores !== zip.huellaMotores) motivos.push('la huellaMotores de la carpeta y la del zip difieren');
  if (carpeta.huellaPaquete !== zip.huellaPaquete) motivos.push('la huellaPaquete de la carpeta y la del zip difieren');
  return { ok: motivos.length === 0, motivos, carpeta, zip };
}

/* ---------- CLI ---------- */
async function main232(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { const clave = argv[i].slice(2); args[clave] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; }
  }
  if (args.verificar) {
    const manifiesto = JSON.parse(readFileSync(String(args.manifiesto), 'utf8'));
    const resultado = await verificarPaquete232({ dir: String(args.dir), zipPath: String(args.zip), manifiesto });
    console.log(JSON.stringify(resultado, null, 2));
    if (!resultado.ok) process.exitCode = 1;
    return;
  }
  const dir = String(args.dir || '');
  const version = String(args.version || '');
  if (!dir || !version) {
    console.error('Uso: node empaquetar-ejecutor.mjs --dir <carpeta-ejecutor> --version <X.Y.Z> [--out <manifiesto.json>]');
    console.error(' o:  node empaquetar-ejecutor.mjs --verificar --dir <carpeta> --zip <bundle.zip> --manifiesto <bundle.json>');
    process.exitCode = 2;
    return;
  }
  const manifiesto = sellarCarpeta232(dir, version);
  const out = String(args.out || join(dirname(dir), 'ejecutor-bundle.json'));
  writeFileSync(out, JSON.stringify(manifiesto, null, 2) + '\n');
  console.log('Manifiesto escrito en ' + out + ': ' + JSON.stringify(manifiesto));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main232(process.argv).catch(error => { console.error('[empaquetar] ' + (error?.message || error)); process.exitCode = 1; });
}
