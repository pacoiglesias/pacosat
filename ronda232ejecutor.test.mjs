import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import {
  FICHEROS_HUELLA231, FICHEROS_PAQUETE232, huellaMotores, huellaPaquete, paquetesNodeModules232,
  verificacionPaquete232, verificarStaging232, copiarActualizacion232, ordenarCopia232,
  respaldarActual232, restaurarRespaldo232, decisionActualizacion232,
  sanearDetalle232, anotarActualizacion231, reporteVersion231,
  adquirirCerrojo232, latidoCerrojo232, liberarCerrojo232, medirInstancias232, residenciaLatido230,
  proximaComprobacion232, CERROJO_FICHERO232,
  debeReintentarConSesionFresca232, SUFIJO_COPIA_TEMPORAL232, reverificacionTrasRestaurar232,
} from './ejecutor-local.mjs';
import {
  sellarVersionPackage232, sellarLeeme232, sellarCarpeta232, computarManifiesto232,
  verificarCarpeta232, verificarZip232, verificarPaquete232,
} from './empaquetar-ejecutor.mjs';

/* ================================================================
   Ronda 2.3.2 · constructor B2a — camino de actualización y
   arranque blindados del ejecutor.

   El escándalo que se blinda (17 nov): una copia fichero a
   fichero dejó cáscara 2.3.0 con motores 2.0.0 latiendo en
   silencio. La 2.3.1 puso huella de 8 ficheros + verificación
   post-copia; esta ronda cierra las vías que la auditoría
   (E-01…E-12) dejó abiertas:
   - B-2: staging verificado antes de tocar la viva, respaldo
     actualizacion-anterior/, copia en orden de dependencias
     con la cáscara la última, restauración ante crashes.
   - M-2: huellaPaquete sobre TODO el paquete (programa de
     nivel superior + un hash por paquete de node_modules).
   - o-3/m-20: el generador vive en el árbol, importa la huella
     del propio ejecutor y sella package.json + LEEME.
   - M-4: cerrojo de instancia real; instancias solo si se mide.
   - M-5: re-comprobación cada 6 h con reintentos 1 h/6 h/24 h.
   - o-4: manifiesto sin huella = pendiente, no éxito silencioso.
   - o-6: despertar lanzado desacoplado antes del exit 42.
   - m-19: saneo del detalle por tokens.
   ================================================================ */

const AQUI = dirname(fileURLToPath(import.meta.url));
const leer = nombre => readFileSync(join(AQUI, nombre), 'utf8');

/* Carpeta de ejecutor fingida pero completa: los 8 motores
   reales del árbol + los ficheros de programa de nivel superior
   (contenido de prueba) + un node_modules mínimo con un paquete
   plano y uno con ámbito. */
function carpetaEjecutorFingida() {
  const dir = mkdtempSync(join(tmpdir(), 'pacosat-232-'));
  for (const nombre of FICHEROS_HUELLA231) copyFileSync(join(AQUI, nombre), join(dir, nombre));
  for (const nombre of FICHEROS_PAQUETE232) {
    if (!existsSync(join(dir, nombre))) writeFileSync(join(dir, nombre),
      nombre.endsWith('.mjs') ? 'export {};\n' : 'contenido de prueba de ' + nombre + '\n');
  }
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'pacosat-ejecutor-local', version: '2.0.0' }, null, 2) + '\n');
  writeFileSync(join(dir, 'LEEME.txt'), 'EJECUTOR LOCAL DE PACOSAT · 2.0.1\n==================================\n');
  mkdirSync(join(dir, 'node_modules', 'playwright-core'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', 'playwright-core', 'index.js'), 'module.exports = {};\n');
  writeFileSync(join(dir, 'node_modules', 'playwright-core', 'package.json'), '{"name":"playwright-core"}\n');
  mkdirSync(join(dir, 'node_modules', '@nodecfdi', 'credentials', 'dist'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', '@nodecfdi', 'credentials', 'dist', 'index.js'), 'export {};\n');
  writeFileSync(join(dir, 'node_modules', '@nodecfdi', 'credentials', 'package.json'), '{"name":"@nodecfdi/credentials"}\n');
  return dir;
}

/* ---------- 1 · B-2: un staging que no verifica NO toca la viva ---------- */
{
  const viva = carpetaEjecutorFingida();
  const staging = carpetaEjecutorFingida();
  try {
    const huellaViva = huellaMotores(viva);
    const paqueteVivo = huellaPaquete(viva);
    const contenidoVivo = readFileSync(join(viva, 'sat-tributario.mjs'), 'utf8');
    /* El staging llega con un motor viejo (la mezcla del escándalo). */
    writeFileSync(join(staging, 'sat-tributario.mjs'), readFileSync(join(staging, 'sat-tributario.mjs'), 'utf8') + '\n/* motor viejo */\n');
    const veredicto = verificarStaging232(staging, { huellaMotores: huellaViva, huellaPaquete: paqueteVivo });
    assert.equal(veredicto.ok, false, 'un staging con un motor distinto no verifica');
    assert.equal(veredicto.motivo, 'huella-motores', 'y el motivo nombra la huella de motores');
    /* La viva queda intacta: verificar el staging no la toca. */
    assert.equal(huellaMotores(viva), huellaViva, 'la huella de la viva no se movió');
    assert.equal(readFileSync(join(viva, 'sat-tributario.mjs'), 'utf8'), contenidoVivo, 'ni su contenido');
    /* Un staging fiel SÍ verifica (huellas + humo de carga). */
    const stagingBueno = carpetaEjecutorFingida();
    try {
      const bueno = verificarStaging232(stagingBueno, { huellaMotores: huellaMotores(stagingBueno), huellaPaquete: huellaPaquete(stagingBueno) });
      assert.equal(bueno.ok, true, 'un staging fiel verifica entero: ' + JSON.stringify(bueno));
    } finally { rmSync(stagingBueno, { recursive: true, force: true }); }
    /* El cableado: el flujo verifica el staging ANTES de copiar. */
    const fuente = leer('ejecutor-local.mjs');
    const idxStaging = fuente.indexOf('verificarStaging232(tmpDir, info)');
    const idxCopia = fuente.indexOf('copiar(tmpDir, HERE);');
    assert.ok(idxStaging >= 0 && idxCopia > idxStaging, 'comprobarActualizacion verifica el staging antes de copiar a la viva');
    assert.ok(fuente.includes("join(HERE, 'actualizacion-nueva')"), 'la descarga se descomprime en actualizacion-nueva/ (staging)');
    assert.ok(fuente.indexOf('respaldarActual232(HERE);') > idxStaging && fuente.indexOf('respaldarActual232(HERE);') < idxCopia,
      'el respaldo de lo vigente se guarda tras verificar el staging y antes de copiar');
  } finally { rmSync(viva, { recursive: true, force: true }); rmSync(staging, { recursive: true, force: true }); }
  console.log('OK 2.3.2 B2a · 1 — staging que no verifica no toca la viva; el fiel verifica; respaldo antes de copiar.');
}

/* ---------- 2 · B-2: orden de copia con la cáscara la última + protecciones ---------- */
{
  const orden = ordenarCopia232(['ejecutor-local.mjs', 'arrancar.bat', 'sat-tributario.mjs',
    'package.json', 'sat-executor.mjs', 'registro-windows.mjs', 'LEEME.txt']);
  assert.equal(orden[orden.length - 1], 'ejecutor-local.mjs', 'la cáscara es la ÚLTIMA de los de programa');
  assert.deepEqual(ordenarCopia232(orden), orden, 'el orden es determinista');
  assert.ok(orden.indexOf('sat-tributario.mjs') < orden.indexOf('ejecutor-local.mjs'), 'los motores van antes que la cáscara');

  const origen = carpetaEjecutorFingida();
  const destino = carpetaEjecutorFingida();
  try {
    mkdirSync(join(destino, 'efirma-local'), { recursive: true });
    writeFileSync(join(destino, 'efirma-local', 'perfiles.json'), '{"mio":true}\n');
    writeFileSync(join(destino, 'token.txt'), 'token-vivo\n');
    writeFileSync(join(origen, 'token.txt'), 'token-del-paquete\n');
    writeFileSync(join(origen, 'sat-tributario.mjs'), readFileSync(join(origen, 'sat-tributario.mjs'), 'utf8') + '\n/* nuevo */\n');
    copiarActualizacion232(origen, destino);
    assert.equal(readFileSync(join(destino, 'token.txt'), 'utf8'), 'token-vivo\n', 'los preservados jamás se sobrescriben');
    assert.equal(readFileSync(join(destino, 'efirma-local', 'perfiles.json'), 'utf8'), '{"mio":true}\n', 'efirma-local jamás se sobrescribe');
    assert.ok(readFileSync(join(destino, 'sat-tributario.mjs'), 'utf8').includes('/* nuevo */'), 'el motor nuevo sí aterriza');
    assert.ok(existsSync(join(destino, 'node_modules', 'playwright-core', 'index.js')), 'node_modules aterriza entero');
    /* Respaldo y restauración: lo vigente se guarda y vuelve. */
    const antes = huellaMotores(destino);
    respaldarActual232(destino);
    assert.ok(existsSync(join(destino, 'actualizacion-anterior', 'ejecutor-local.mjs')), 'el respaldo guarda la cáscara vigente');
    writeFileSync(join(destino, 'sat-tributario.mjs'), 'roto\n');
    assert.notEqual(huellaMotores(destino), antes, 'la instalación quedó tocada');
    assert.equal(restaurarRespaldo232(destino), true, 'la restauración corre');
    assert.equal(huellaMotores(destino), antes, 'y la huella vuelve a la del respaldo');
  } finally { rmSync(origen, { recursive: true, force: true }); rmSync(destino, { recursive: true, force: true }); }
  console.log('OK 2.3.2 B2a · 2 — orden de copia con la cáscara última, protecciones intactas, respaldo y restauración reales.');
}

/* ---------- 3 · M-2: huellaPaquete caza un node_modules truncado ---------- */
{
  const dir = carpetaEjecutorFingida();
  try {
    const hp1 = huellaPaquete(dir);
    assert.match(hp1, /^[0-9a-f]{64}$/, 'la huellaPaquete es un sha256 en hex');
    assert.equal(huellaPaquete(dir), hp1, 'y es estable sobre la misma carpeta');
    const hm1 = huellaMotores(dir);
    unlinkSync(join(dir, 'node_modules', '@nodecfdi', 'credentials', 'dist', 'index.js'));
    const hp2 = huellaPaquete(dir);
    assert.notEqual(hp2, hp1, 'un fichero de node_modules truncado cambia la huellaPaquete');
    assert.equal(huellaMotores(dir), hm1, 'pero NO la huella de motores: por eso hacían falta las dos');
    assert.equal(verificacionPaquete232(dir, hp1).ok, false, 'la verificación de paquete caza el truncado');
    assert.equal(verificacionPaquete232(dir, hp2).ok, true, 'y acepta la huella real del disco');
    writeFileSync(join(dir, 'LEEME.txt'), 'EJECUTOR LOCAL DE PACOSAT · 9.9.9\n');
    assert.notEqual(huellaPaquete(dir), hp2, 'un lanzador/texto de nivel superior también entra en la huellaPaquete');
    assert.equal(verificacionPaquete232(dir, '').ok, false, 'sin huella anunciada no hay verificación que valga');
  } finally { rmSync(dir, { recursive: true, force: true }); }
  console.log('OK 2.3.2 B2a · 3 — huellaPaquete caza node_modules truncado y cambios de nivel superior.');
}

/* ---------- 4 · M-4: cerrojo de instancia real ---------- */
{
  const dir = mkdtempSync(join(tmpdir(), 'pacosat-cerrojo232-'));
  const dormilon = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
  try {
    writeFileSync(join(dir, CERROJO_FICHERO232), JSON.stringify({ pid: dormilon.pid, latido: Date.now() }));
    const segundo = adquirirCerrojo232(dir);
    assert.equal(segundo.ok, false, 'con un cerrojo vivo y fresco, el segundo proceso NO entra');
    assert.equal(segundo.pid, dormilon.pid, 'y el mensaje nombra al proceso que manda');
    /* Latido caducado: el cerrojo se puede tomar (un crash no cierra la puerta). */
    writeFileSync(join(dir, CERROJO_FICHERO232), JSON.stringify({ pid: dormilon.pid, latido: Date.now() - 10 * 60 * 1000 }));
    const tomado = adquirirCerrojo232(dir);
    assert.equal(tomado.ok, true, 'un cerrojo con latido caducado se toma');
    assert.equal(latidoCerrojo232(dir), true, 'el dueño late su cerrojo');
    liberarCerrojo232(dir);
    assert.equal(existsSync(join(dir, CERROJO_FICHERO232)), false, 'al liberar, el cerrojo desaparece');
    /* El cableado del bucle: el cerrojo se toma antes de latir. */
    const fuente = leer('ejecutor-local.mjs');
    const idxCerrojo = fuente.indexOf('adquirirCerrojo232(HERE)');
    const idxBucle = fuente.indexOf('await comprobarActualizacion()');
    assert.ok(idxCerrojo >= 0 && idxBucle > idxCerrojo, 'runExecutorLoop toma el cerrojo antes de la primera comprobación');
    assert.ok(fuente.includes('sin latir ni reclamar trabajos'), 'y el segundo sale con mensaje claro, sin latir ni reclamar');
    /* arrancar.bat ya no lanza node a pelo: pasa por despertar.vbs. */
    const bat = leer('arrancar.bat');
    assert.ok(bat.includes('despertar.vbs'), 'arrancar.bat lanza despertar.vbs');
    assert.ok(!/^\s*node\s+ejecutor-local/m.test(bat), 'arrancar.bat no contiene ningún lanzamiento directo de node');
    /* instancias: se mide o no se manda. */
    const medida = medirInstancias232(dir);
    assert.ok(medida === null || (Number.isInteger(medida) && medida >= 1), 'medirInstancias232 devuelve un conteo o null, nunca una constante');
    const latidoRes = await residenciaLatido230({ dir });
    if (medida === null) assert.ok(!('instancias' in latidoRes), 'sin medición fiable, el campo instancias no viaja');
    else assert.equal(latidoRes.instancias, medida, 'con medición, viaja el conteo medido');
  } finally {
    dormilon.kill();
    rmSync(dir, { recursive: true, force: true });
  }
  console.log('OK 2.3.2 B2a · 4 — cerrojo real: el segundo no entra; caducado se toma; arrancar.bat pasa por despertar.vbs; instancias medida o ausente.');
}

/* ---------- 5 · o-4 + M-5: sin huella = pendiente; cadencia y reintentos ---------- */
{
  const propia = { version: '2.3.1', huella: 'a'.repeat(64) };
  assert.deepEqual(decisionActualizacion232({ version: '2.3.2' }, propia),
    { accion: 'pendiente-sin-huella', motivo: 'huellaMotores' },
    'versión mayor sin huellaMotores anunciada: pendiente reportable, no se copia');
  assert.deepEqual(decisionActualizacion232({ version: '2.3.2', huellaMotores: 'b'.repeat(64) }, propia),
    { accion: 'pendiente-sin-huella', motivo: 'huellaPaquete' },
    'sin huellaPaquete anunciada: también pendiente');
  assert.equal(decisionActualizacion232({ version: '2.3.2', huellaMotores: 'b'.repeat(64), huellaPaquete: 'c'.repeat(64) }, propia).accion,
    'actualizar', 'con las dos huellas anunciadas y versión mayor: se actualiza');
  assert.equal(decisionActualizacion232({ version: '2.3.1', huellaMotores: 'b'.repeat(64), huellaPaquete: 'c'.repeat(64) }, propia).accion,
    'actualizar', 'misma versión y huella distinta: la mezcla se reinstala');
  assert.equal(decisionActualizacion232({ version: '2.3.1', huellaMotores: 'a'.repeat(64), huellaPaquete: 'c'.repeat(64) }, propia).accion,
    'ninguna', 'misma versión y misma huella: al día');
  assert.equal(decisionActualizacion232({ version: '2.2.0', huellaMotores: 'b'.repeat(64), huellaPaquete: 'c'.repeat(64) }, propia).accion,
    'ninguna', 'nunca se baja de versión');
  const fuente = leer('ejecutor-local.mjs');
  assert.ok(fuente.includes("anotarActualizacion231('pendiente'"), 'el pendiente sin huella se anota para el latido');
  assert.ok(fuente.includes('el paquete no anuncia'), 'y el detalle dice que el paquete no anuncia huella');
  /* Cadencia: 6 h en sano; 1 h, 6 h, 24 h tras fallos seguidos. */
  const base = 1000000;
  assert.equal(proximaComprobacion232({ ultima: base, fallosSeguidos: 0 }) - base, 6 * 60 * 60 * 1000, 'cadencia sana: 6 h');
  assert.equal(proximaComprobacion232({ ultima: base, fallosSeguidos: 1 }) - base, 60 * 60 * 1000, 'tras un fallo: 1 h');
  assert.equal(proximaComprobacion232({ ultima: base, fallosSeguidos: 2 }) - base, 6 * 60 * 60 * 1000, 'tras dos fallos: 6 h');
  assert.equal(proximaComprobacion232({ ultima: base, fallosSeguidos: 5 }) - base, 24 * 60 * 60 * 1000, 'tras muchos fallos: 24 h (tope)');
  assert.ok(fuente.includes('proximaComprobacion232({ ultima: ultimaComprobacion, fallosSeguidos })'),
    'el bucle re-comprueba con la cadencia, entre ciclos');
  console.log('OK 2.3.2 B2a · 5 — sin huella = pendiente reportable; cadencia 6 h y reintentos 1 h/6 h/24 h cableados en el bucle.');
}

/* ---------- 6 · m-19: saneo del detalle por tokens ---------- */
{
  const sucio = 'falló al copiar C:\\Users\\Paco\\ejecutor\\sat-tributario.mjs (EBUSY) y también /home/paco/ejecutor/registro-windows.mjs falló';
  const limpio = sanearDetalle232(sucio);
  assert.equal(limpio, 'falló al copiar sat-tributario.mjs (EBUSY) y también registro-windows.mjs falló',
    'cada palabra con barras se sustituye por su último segmento');
  assert.ok(!limpio.includes('Users') && !limpio.includes('/home'), 'ninguna ruta absoluta sobrevive al saneo');
  assert.equal(sanearDetalle232('x'.repeat(300)).length, 200, 'el corte a 200 se mantiene tras el saneo');
  anotarActualizacion231('fallo', sucio);
  const reporte = reporteVersion231(AQUI);
  assert.equal(reporte.actualizacion.detalle, limpio, 'lo anotado viaja ya saneado en el reporte del latido');
  assert.ok('huellaPaquete' in reporte && /^[0-9a-f]{64}$/.test(reporte.huellaPaquete), 'el reporte lleva también la huellaPaquete');
  /* readdirSync/mkdirSync de la copia van envueltos con nombre+código (m-19). */
  const fuente = leer('ejecutor-local.mjs');
  assert.ok(fuente.includes("errorLectura?.code || 'error de lectura'"), 'readdirSync envuelto con nombre y código');
  assert.ok(fuente.includes("errorDir?.code || 'error al crear carpeta'"), 'mkdirSync envuelto con nombre y código');
  console.log('OK 2.3.2 B2a · 6 — detalle saneado por tokens antes del colapso y el corte; errores de copia nombrados sin rutas.');
}

/* ---------- 7 · o-3 + m-20: el generador vive en el árbol y sella de verdad ---------- */
{
  assert.equal(JSON.parse(sellarVersionPackage232('{"name":"x","version":"2.0.0"}', '2.3.2')).version, '2.3.2',
    'sellarVersionPackage232 escribe la versión real en el package.json interno');
  assert.ok(sellarLeeme232('EJECUTOR LOCAL DE PACOSAT · 2.0.1\nresto\n', '2.3.2').startsWith('EJECUTOR LOCAL DE PACOSAT · 2.3.2'),
    'sellarLeeme232 escribe la versión real en la cabecera de LEEME.txt');
  const carpeta = carpetaEjecutorFingida();
  const tmpZip = mkdtempSync(join(tmpdir(), 'pacosat-zip232-'));
  try {
    const manifiesto = sellarCarpeta232(carpeta, '2.3.2');
    assert.equal(manifiesto.version, '2.3.2');
    assert.equal(JSON.parse(readFileSync(join(carpeta, 'package.json'), 'utf8')).version, '2.3.2', 'la carpeta quedó sellada');
    assert.ok(readFileSync(join(carpeta, 'LEEME.txt'), 'utf8').startsWith('EJECUTOR LOCAL DE PACOSAT · 2.3.2'), 'y su LEEME también');
    assert.equal(manifiesto.huellaMotores, huellaMotores(carpeta),
      'el manifiesto se computa con la huella del PROPIO ejecutor (una sola implementación)');
    assert.equal(manifiesto.huellaPaquete, huellaPaquete(carpeta), 'y con su huellaPaquete');
    assert.equal(verificarCarpeta232(carpeta, manifiesto).ok, true, 'la carpeta sellada verifica contra su manifiesto');
    /* El zip del mismo contenido verifica igual (carpeta ⇄ zip). */
    const zip = new JSZip();
    const agregar = (base, dirRel) => {
      for (const nombre of ['ejecutor-local.mjs', 'sat-tributario.mjs', 'sat-declaraciones.mjs', 'sat-doc-browser.mjs',
        'sat-doc-fetch.mjs', 'sat-executor.mjs', 'secret-box.mjs', 'registro-windows.mjs', ...FICHEROS_PAQUETE232]) {
        const ruta = join(base, nombre);
        if (existsSync(ruta)) zip.file(nombre, readFileSync(ruta));
      }
    };
    agregar(carpeta);
    zip.file('node_modules/playwright-core/index.js', readFileSync(join(carpeta, 'node_modules', 'playwright-core', 'index.js')));
    zip.file('node_modules/playwright-core/package.json', readFileSync(join(carpeta, 'node_modules', 'playwright-core', 'package.json')));
    zip.file('node_modules/@nodecfdi/credentials/dist/index.js', readFileSync(join(carpeta, 'node_modules', '@nodecfdi', 'credentials', 'dist', 'index.js')));
    zip.file('node_modules/@nodecfdi/credentials/package.json', readFileSync(join(carpeta, 'node_modules', '@nodecfdi', 'credentials', 'package.json')));
    const rutaZip = join(tmpZip, 'bundle.zip');
    writeFileSync(rutaZip, await zip.generateAsync({ type: 'nodebuffer' }));
    const cruzada = await verificarPaquete232({ dir: carpeta, zipPath: rutaZip, manifiesto });
    assert.equal(cruzada.ok, true, 'carpeta y zip recomputan la misma huella y coinciden con el manifiesto: ' + cruzada.motivos.join(' · '));
    /* Un zip con el package.json sin sellar se caza (m-20). */
    const zipMalo = new JSZip();
    zipMalo.file('package.json', '{"name":"pacosat-ejecutor-local","version":"2.0.0"}\n');
    const rutaZipMalo = join(tmpZip, 'malo.zip');
    writeFileSync(rutaZipMalo, await zipMalo.generateAsync({ type: 'nodebuffer' }));
    const veredictoMalo = await verificarZip232(rutaZipMalo, manifiesto);
    assert.equal(veredictoMalo.ok, false, 'un zip con package.json en 2.0.0 no verifica contra el manifiesto 2.3.2');
    assert.ok(veredictoMalo.motivos.some(m => m.includes('package.json')), 'y el motivo nombra el package.json: ' + veredictoMalo.motivos.join(' · '));
    assert.equal(computarManifiesto232(carpeta, '2.3.2').huellaMotores, manifiesto.huellaMotores,
      'la huella es reproducible desde el árbol las veces que haga falta');
  } finally { rmSync(carpeta, { recursive: true, force: true }); rmSync(tmpZip, { recursive: true, force: true }); }
  console.log('OK 2.3.2 B2a · 7 — generador en el árbol: sella package.json/LEEME, computa con la huella del ejecutor y verifica carpeta ⇄ zip.');
}

/* ---------- 8 · o-6 + B-2 (vbs): relanzamiento desacoplado y restauración en el despertador ---------- */
{
  const fuente = leer('ejecutor-local.mjs');
  const idxLanzar = fuente.indexOf('lanzarDespertador232(HERE);');
  const idxExit = fuente.indexOf('process.exit(42);');
  assert.ok(idxLanzar >= 0 && idxExit > idxLanzar, 'antes del exit(42) el ejecutor lanza despertar.vbs desacoplado');
  assert.ok(fuente.includes("spawn('wscript.exe'"), 'el lanzamiento es desacoplado (spawn detached) del despertador');
  const vbs = leer('despertar.vbs');
  assert.ok(vbs.includes('actualizacion-anterior'), 'despertar.vbs conoce la copia anterior');
  assert.ok(vbs.includes('RestaurarAnterior'), 'y sabe restaurarla');
  assert.ok(vbs.includes('despertar-crashes.txt'), 'el contador de crashes inmediatos persiste en fichero');
  assert.ok(vbs.includes('duracion < 15'), 'un crash es morir a los pocos segundos de arrancar');
  assert.ok(vbs.includes('crashes >= 2'), 'la restauración llega con los crashes inmediatos repetidos');
  assert.ok(vbs.includes("Name = 'node.exe' AND CommandLine LIKE '%ejecutor-local.mjs%'"), 'YaCorre sigue intacto');
  console.log('OK 2.3.2 B2a · 8 — exit 42 con despertador desacoplado; despertar.vbs restaura la copia anterior ante crashes repetidos.');
}

/* ---------- 9 · Integración-3: huellaPaquete idéntica con y sin enlaces simbólicos ----------
   El defecto (medido por el coordinador): node_modules/.bin
   guarda symlinks en Linux (playwright-core → ../playwright-
   core/cli.js) y el zip del paquete guarda el destino como
   fichero normal. Con Dirent.isFile()/isDirectory() a secas el
   fichero enlazado se saltaba sobre la carpeta (c8bb62bd…)
   pero contaba sobre la instalación extraída (da79b716…):
   contenido idéntico, huellas distintas para siempre. La
   enumeración ahora sigue los enlaces como readFileSync. */
{
  /* Intenta crear un enlace; en un entorno sin permiso para
     symlinks (Windows sin privilegio) devuelve false y el
     caso correspondiente se salta, no se finge. */
  const intentarEnlace = (destino, ruta, tipo) => {
    try { symlinkSync(destino, ruta, tipo); return true; } catch { return false; }
  };
  const dirsTemporales = [];
  try {
    /* --- 9a · fichero enlazado dentro de un paquete --- */
    const conEnlace = carpetaEjecutorFingida(); dirsTemporales.push(conEnlace);
    const materializada = carpetaEjecutorFingida(); dirsTemporales.push(materializada);
    for (const dir of [conEnlace, materializada]) {
      mkdirSync(join(dir, 'node_modules', 'juguete'), { recursive: true });
      writeFileSync(join(dir, 'node_modules', 'juguete', 'real.js'), 'contenido-real-123\n');
      writeFileSync(join(dir, 'node_modules', 'juguete', 'package.json'), '{"name":"juguete"}\n');
    }
    writeFileSync(join(materializada, 'node_modules', 'juguete', 'enlace.js'), 'contenido-real-123\n');
    if (intentarEnlace('real.js', join(conEnlace, 'node_modules', 'juguete', 'enlace.js'))) {
      assert.equal(huellaPaquete(conEnlace), huellaPaquete(materializada),
        'un fichero enlazado cuenta con el contenido de su destino: huella idéntica a la del fichero materializado');
      assert.deepEqual(paquetesNodeModules232(conEnlace), paquetesNodeModules232(materializada),
        'y la lista de paquetes es la misma');
    } else console.log('·· 9a saltado: el entorno no permite crear symlinks de fichero.');

    /* --- 9b · paquete entero enlazado (si el entorno lo permite) --- */
    const pkgEnlazado = carpetaEjecutorFingida(); dirsTemporales.push(pkgEnlazado);
    const pkgMaterializado = carpetaEjecutorFingida(); dirsTemporales.push(pkgMaterializado);
    for (const dir of [pkgEnlazado, pkgMaterializado]) {
      mkdirSync(join(dir, 'real-enlazado'), { recursive: true });
      writeFileSync(join(dir, 'real-enlazado', 'index.js'), 'paquete-enlazado\n');
      writeFileSync(join(dir, 'real-enlazado', 'package.json'), '{"name":"enlazado"}\n');
    }
    mkdirSync(join(pkgMaterializado, 'node_modules', 'enlazado'), { recursive: true });
    writeFileSync(join(pkgMaterializado, 'node_modules', 'enlazado', 'index.js'), 'paquete-enlazado\n');
    writeFileSync(join(pkgMaterializado, 'node_modules', 'enlazado', 'package.json'), '{"name":"enlazado"}\n');
    if (intentarEnlace(join(pkgEnlazado, 'real-enlazado'), join(pkgEnlazado, 'node_modules', 'enlazado'), 'dir')) {
      assert.ok(paquetesNodeModules232(pkgEnlazado).includes('enlazado'),
        'un paquete enlazado cuenta como paquete en paquetesNodeModules232');
      assert.deepEqual(paquetesNodeModules232(pkgEnlazado), paquetesNodeModules232(pkgMaterializado),
        'la lista de paquetes coincide con la del árbol materializado');
      assert.equal(huellaPaquete(pkgEnlazado), huellaPaquete(pkgMaterializado),
        'la huella del paquete enlazado es idéntica a la del materializado');
    } else console.log('·· 9b saltado: el entorno no permite crear symlinks de directorio.');

    /* --- 9c · bucle de enlaces: no cuelga y no aporta ficheros --- */
    const conBucle = carpetaEjecutorFingida(); dirsTemporales.push(conBucle);
    const sinBucle = carpetaEjecutorFingida(); dirsTemporales.push(sinBucle);
    for (const dir of [conBucle, sinBucle]) {
      mkdirSync(join(dir, 'node_modules', 'conbucle', 'sub'), { recursive: true });
      writeFileSync(join(dir, 'node_modules', 'conbucle', 'index.js'), 'x\n');
      writeFileSync(join(dir, 'node_modules', 'conbucle', 'sub', 'y.js'), 'y\n');
    }
    const buclePadre = intentarEnlace('..', join(conBucle, 'node_modules', 'conbucle', 'sub', 'bucle'), 'dir');
    const bucleYo = intentarEnlace('.', join(conBucle, 'node_modules', 'conbucle', 'yo'), 'dir');
    if (buclePadre || bucleYo) {
      const huellaBucle = huellaPaquete(conBucle);
      assert.match(huellaBucle, /^[0-9a-f]{64}$/, 'con un bucle de enlaces la función termina y devuelve huella');
      assert.equal(huellaBucle, huellaPaquete(sinBucle), 'el bucle no aporta ficheros: misma huella que el árbol sin bucle');
    } else console.log('·· 9c saltado: el entorno no permite crear symlinks de directorio.');
  } finally { for (const dir of dirsTemporales) rmSync(dir, { recursive: true, force: true }); }
  console.log('OK 2.3.2 B2a · 9 — Integración-3: huellaPaquete idéntica con enlaces y materializada (fichero y paquete); el bucle de enlaces no cuelga ni aporta ficheros.');
}

/* ---------- 10 · FIX-B: ruta-muerta reintenta también con sesión FRESCA ----------
   Evidencia viva del 17 nov ~14:57 CST (run buzon-listar
   1d36cce9): el motor detectó la sesión en /app/seg/null y
   lanzó ruta-muerta «para que el ejecutor descarte la sesión
   y reintente con un acceso fresco» (contrato en
   sat-tributario.mjs), pero ejecutarIntento solo reintentaba
   si sesion.reutilizada — la sesión era fresca, attempts
   quedó en 1 y el trabajo murió con la puerta abierta.
   ejecutarIntento no es importable, así que se juzga el
   predicado puro exportado y su cableado en el catch. */
{
  const rutaMuerta = Object.assign(new Error('ruta muerta'), { code: 'ruta-muerta' });
  const otroFallo = Object.assign(new Error('otro'), { code: 'respuesta-inesperada' });
  const fresca = { reutilizada: false };
  const reutilizada = { reutilizada: true };
  assert.equal(debeReintentarConSesionFresca232(rutaMuerta, fresca, 1), true,
    'FIX-B: sesión fresca + ruta-muerta en la corrida 1 → hay corrida 2 con sesión nueva');
  assert.equal(debeReintentarConSesionFresca232(otroFallo, fresca, 1), false,
    'sesión fresca + otro fallo en la corrida 1 → no se reintenta por esta vía');
  assert.equal(debeReintentarConSesionFresca232(otroFallo, reutilizada, 1), true,
    'el caso de siempre se conserva: reutilizada que no responde en la corrida 1 → reintento');
  assert.equal(debeReintentarConSesionFresca232(rutaMuerta, reutilizada, 1), true,
    'reutilizada + ruta-muerta en la corrida 1 → reintento');
  assert.equal(debeReintentarConSesionFresca232(rutaMuerta, fresca, 2), false,
    'en la corrida 2 ya no hay otro reintento: una sola repetición');
  assert.equal(debeReintentarConSesionFresca232(otroFallo, reutilizada, 2), false,
    'ni siquiera la reutilizada reintenta en la corrida 2');
  assert.equal(debeReintentarConSesionFresca232(rutaMuerta, null, 1), true,
    'sin objeto de sesión, la ruta-muerta en la corrida 1 sigue disparando el reintento');
  assert.equal(debeReintentarConSesionFresca232(otroFallo, null, 1), false,
    'sin sesión reutilizada y sin ruta-muerta, no hay reintento');
  /* El cableado en ejecutarIntento: el catch decide con el
     predicado, descarta con cerrarSesionViva, abre otra con
     sesionVivaPara y nombra cada caso en su paso de traza. */
  const fuente = leer('ejecutor-local.mjs');
  assert.ok(fuente.includes('if (debeReintentarConSesionFresca232(error, sesion, corrida))'),
    'FIX-B: el catch de ejecutarIntento decide con el predicado puro');
  const idxCatch = fuente.indexOf('if (debeReintentarConSesionFresca232(error, sesion, corrida))');
  const bloqueReintento = fuente.slice(idxCatch, idxCatch + 2600);
  assert.ok(bloqueReintento.includes('cerrarSesionViva(rfc)'),
    'FIX-B: el reintento descarta la sesión con cerrarSesionViva');
  assert.ok(bloqueReintento.includes('sesion = await sesionVivaPara(rfc, m, onStep)'),
    'FIX-B: y abre otra con sesionVivaPara antes de repetir el motor');
  assert.ok(bloqueReintento.includes('errorSesion.enAcceso = true'),
    'FIX-B intacto lo demás: si la nueva entrada cae, ese error nace enAcceso');
  assert.ok(fuente.includes("onStep('La sesión quedó en la página muerta del portal', 'se descarta y se entra de nuevo con la e.firma')"),
    'FIX-B: el paso de traza de ruta-muerta nombra la página muerta y el descarte con entrada nueva');
  assert.ok(fuente.includes("onStep('La sesión reutilizada no respondió', 'se descarta y se entra de nuevo con la e.firma')"),
    'FIX-B: el caso de siempre conserva su texto de traza');
  assert.ok(bloqueReintento.indexOf('continue;') >= 0,
    'FIX-B: tras la sesión nueva el bucle continúa a la corrida 2');
  console.log('OK 2.3.2 E · 10 — FIX-B: ruta-muerta con sesión fresca reintenta (predicado + cableado: descarte, sesión nueva y traza nombrada).');
}

/* ---------- 11 · D-2: copia atómica por fichero + re-verificación tras restaurar ---------- */
{
  const listarTodo232 = (dir, acc = []) => {
    for (const entrada of readdirSync(dir, { withFileTypes: true })) {
      const ruta = join(dir, entrada.name);
      if (entrada.isDirectory()) listarTodo232(ruta, acc); else acc.push(ruta);
    }
    return acc;
  };
  const sinTemporales232 = dir => listarTodo232(dir).filter(ruta => ruta.includes(SUFIJO_COPIA_TEMPORAL232));
  /* Camino feliz: la copia aterriza y no queda ningún temporal. */
  const origen = carpetaEjecutorFingida();
  const destino = carpetaEjecutorFingida();
  try {
    writeFileSync(join(origen, 'despertar.vbs'), 'despertador-nuevo-232\n');
    copiarActualizacion232(origen, destino);
    assert.equal(readFileSync(join(destino, 'despertar.vbs'), 'utf8'), 'despertador-nuevo-232\n',
      'D-2: en el camino feliz el contenido nuevo aterriza (también despertar.vbs)');
    assert.deepEqual(sinTemporales232(destino), [], 'D-2: en el camino feliz no queda ningún temporal residual');
  } finally { rmSync(origen, { recursive: true, force: true }); rmSync(destino, { recursive: true, force: true }); }
  /* Renombrado que falla a mitad: el destino ORIGINAL queda
     intacto y tampoco queda temporal. La fs es inyectable
     como costura de prueba del propio fichero. */
  const origenFallo = carpetaEjecutorFingida();
  const destinoFallo = carpetaEjecutorFingida();
  try {
    const huellaAntes = huellaPaquete(destinoFallo);
    const despertadorAntes = readFileSync(join(destinoFallo, 'despertar.vbs'), 'utf8');
    writeFileSync(join(origenFallo, 'despertar.vbs'), 'despertador-que-no-debe-aterrizar\n');
    const renombradoRoto = () => {
      const error = new Error('renombrado simulado que falla');
      error.code = 'EPERM';
      throw error;
    };
    assert.throws(() => copiarActualizacion232(origenFallo, destinoFallo, { renameSync: renombradoRoto }),
      /\(EPERM\)/, 'D-2: un renombrado que falla se propaga nombrando fichero y código');
    assert.equal(huellaPaquete(destinoFallo), huellaAntes,
      'D-2: con el renombrado roto, el destino ORIGINAL queda intacto (misma huellaPaquete)');
    assert.equal(readFileSync(join(destinoFallo, 'despertar.vbs'), 'utf8'), despertadorAntes,
      'D-2: despertar.vbs, el único rescatador, conserva su contenido original');
    assert.deepEqual(sinTemporales232(destinoFallo), [], 'D-2: ni siquiera en el fallo queda temporal residual');
  } finally { rmSync(origenFallo, { recursive: true, force: true }); rmSync(destinoFallo, { recursive: true, force: true }); }
  /* El cableado: ninguna copia de la actualización es ya un
     copyFileSync directo sobre el destino. */
  const fuente = leer('ejecutor-local.mjs');
  assert.ok(!fuente.includes('copyFileSync(join(origen'), 'D-2: copiarActualizacion232 ya no copia directo sobre el destino');
  assert.ok(!fuente.includes('copyFileSync(ruta, join(respaldo'), 'D-2: el respaldo tampoco copia directo: usa la copia atómica');
  assert.ok(fuente.includes('renameSync') && fuente.includes('SUFIJO_COPIA_TEMPORAL232'),
    'D-2: la copia va a hermano temporal y se renombra sobre el destino');
  /* Re-verificación tras restaurar: lo restaurado se comprueba
     con las mismas verificaciones de motores y paquete, y su
     resultado queda en el reporte anotado del latido. */
  const viva = carpetaEjecutorFingida();
  try {
    respaldarActual232(viva);
    const huellaBuena = huellaMotores(viva);
    writeFileSync(join(viva, 'sat-tributario.mjs'), 'roto tras copiar\n');
    assert.equal(reverificacionTrasRestaurar232(viva).ok, false,
      'D-2: una instalación que no coincide con su respaldo no verifica (la re-verificación caza la mezcla)');
    assert.equal(restaurarRespaldo232(viva), true, 'D-2: la restauración corre');
    const reverificado = reverificacionTrasRestaurar232(viva);
    assert.equal(reverificado.ok, true, 'D-2: tras restaurar, motores y paquete coinciden con el respaldo');
    assert.equal(reverificado.motores.ok, true, 'D-2: la re-verificación incluye la huella de motores');
    assert.equal(reverificado.paquete.ok, true, 'D-2: y la huella de paquete');
    assert.equal(huellaMotores(viva), huellaBuena, 'D-2: la huella restaurada es la de antes de romper');
    assert.deepEqual(sinTemporales232(viva), [], 'D-2: restaurar tampoco deja temporales');
  } finally { rmSync(viva, { recursive: true, force: true }); }
  assert.ok((fuente.match(/reverificacionTrasRestaurar232\(HERE\)/g) || []).length >= 2,
    'D-2: los dos caminos de fallo post-copia (motores y paquete) re-verifican tras restaurar');
  assert.ok(fuente.includes('Restauración verificada: motores y paquete coinciden con el respaldo restaurado.'),
    'D-2: el reporte anota la restauración solo cuando la re-verificación la confirma');
  assert.ok(fuente.includes('Restauración NO verificada:'),
    'D-2: y anota la re-verificación fallida sin afirmar «restaurado»');
  console.log('OK 2.3.2 E · 11 — D-2: copia atómica (renombrado roto → destino intacto, sin temporales) y re-verificación tras restaurar en el reporte.');
}

console.log('Ronda 2.3.2 · constructor B2a: batería completa en verde.');
