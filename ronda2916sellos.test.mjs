/* ================================================================
   Ronda 2.9.16 · GUARDIANA DE SELLOS — una sola versión, en
   todos los sitios donde la casa la sella.

   EL DESAJUSTE QUE GUARDA (verificado al nacer esta suite): el
   árbol 2.9.14 traía package.json en «2.9.14», el README en
   «1.6.8» y package-lock.json en «1.20.0» (raíz y packages[""])
   — tres sellos distintos para el mismo producto, y ninguna
   suite lo cazaba porque cada una miraba solo SU sello. La
   2.9.15 los unificó; esta guardiana — la misma de la 2.9.15,
   renovada con la ronda — afirma, en cada corrida:

     package.json.version
       == package-lock.json "version" (raíz)
       == package-lock.json packages[""].version
       == sello «Versión …» del README.md
       == PACOSAT_META.version dentro de Faro-Fiscal.html
       == EJECUTOR_VERSION de ejecutor-local.mjs

   Y DEBE PODER FALLAR: la comparación vive en una función que
   lee de UN directorio cualquiera (compararSellos), y la
   segunda prueba copia los archivos sellados a un temporal,
   desajusta el lockfile y afirma que la comparación lo detecta
   y NOMBRA el desajuste. El árbol real nunca se toca para esa
   prueba.
   ================================================================ */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = import.meta.dirname;

/* Los archivos que llevan sello de versión, y solo ellos. */
const ARCHIVOS_SELLADOS = ['package.json', 'package-lock.json', 'README.md',
  'Faro-Fiscal.html', 'ejecutor-local.mjs'];

/* Lee los seis sellos de un directorio y devuelve el mapa
   nombre-del-sello → versión encontrada ('' si no se lee). */
function leerSellos(dir) {
  const leer = name => readFileSync(join(dir, name), 'utf8');
  const pkg = JSON.parse(leer('package.json'));
  const lock = JSON.parse(leer('package-lock.json'));
  const readme = leer('README.md');
  const html = leer('Faro-Fiscal.html');
  const ejecutor = leer('ejecutor-local.mjs');
  return {
    'package.json': String(pkg.version || ''),
    'package-lock.json (raíz)': String(lock.version || ''),
    'package-lock.json (packages[""])': String(lock.packages?.['']?.version || ''),
    'README.md': (readme.match(/^Versión (\S+) para pruebas controladas/m) || [])[1] || '',
    'Faro-Fiscal.html (PACOSAT_META)':
      (html.match(/const PACOSAT_META = \{"version":"([^"]+)"/) || [])[1] || '',
    'ejecutor-local.mjs (EJECUTOR_VERSION)':
      (ejecutor.match(/EJECUTOR_VERSION = '([^']+)'/) || [])[1] || ''
  };
}

/* La comparación: la referencia es package.json y cada desajuste
   se devuelve NOMBRADO (qué sello, qué se esperaba, qué trae). */
function compararSellos(dir) {
  const sellos = leerSellos(dir);
  const referencia = sellos['package.json'];
  const desajustes = [];
  for (const [nombre, version] of Object.entries(sellos)) {
    if (nombre === 'package.json') continue;
    if (version !== referencia)
      desajustes.push(nombre + ' trae «' + (version || '(sin sello)') +
        '» y package.json manda «' + referencia + '»');
  }
  return { sellos, referencia, desajustes };
}

test('los seis sellos del árbol dicen la misma versión', () => {
  const { sellos, referencia, desajustes } = compararSellos(ROOT);
  assert.ok(referencia, 'package.json trae versión');
  assert.deepEqual(desajustes, [],
    'sellos desajustados: ' + desajustes.join(' · ') +
    ' (leídos: ' + JSON.stringify(sellos) + ')');
  console.log('OK 2.9.16-sellos · (1) — los seis sellos coinciden en «' + referencia + '».');
});

test('la comparación DETECTA un desajuste y lo nombra (temporal, sin tocar el árbol)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pacosat-2915-sellos-'));
  try {
    for (const name of ARCHIVOS_SELLADOS) copyFileSync(join(ROOT, name), join(dir, name));
    /* Copia sana: primero se afirma que la comparación pasa —
       si no pasara, la detección de abajo no probaría nada. */
    assert.deepEqual(compararSellos(dir).desajustes, [],
      'la copia fiel del árbol no debe dar desajustes');
    /* El desajuste sembrado: SOLO el packages[""] del lockfile
       copia, como el «1.20.0» stale que la 2.9.14 arrastró. */
    const lockPath = join(dir, 'package-lock.json');
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
    lock.packages[''].version = '0.0.0-desajustada';
    writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');
    const { desajustes } = compararSellos(dir);
    assert.equal(desajustes.length, 1,
      'un solo sello desajustado da un solo desajuste: ' + desajustes.join(' · '));
    assert.ok(desajustes[0].includes('package-lock.json (packages[""])'),
      'el desajuste NOMBRA el sello tocado: ' + desajustes[0]);
    assert.ok(desajustes[0].includes('0.0.0-desajustada'),
      'el desajuste NOMBRA la versión sembrada: ' + desajustes[0]);
    console.log('OK 2.9.16-sellos · (2) — la guardiana caza el desajuste sembrado y lo nombra: «' +
      desajustes[0] + '».');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
