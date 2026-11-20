/* ================================================================
   INSTALADOR DEL EJECUTOR DE PACOSAT (2.0.1) — el camino de un
   solo doble clic. Lo que hace, en tu propio equipo:

   1. Te pide el código corto que PacoSAT enseña al emparejar
      (8 caracteres, caduca en 10 minutos, un solo uso) y lo
      canjea por la llave del ejecutor, que guarda él solo en
      token.txt. Tú nunca copias ni pegas la llave larga.
   2. Te deja ELEGIR tu e.firma (.cer y .key) con el selector de
      archivos de Windows; lee el RFC del propio certificado y
      copia los dos archivos a la carpeta local efirma-local con
      su nombre (RFC.cer / RFC.key).
   3. Te pide la contraseña de la e.firma UNA vez, sin enseñarla
      al teclear, y la guarda solo en perfiles.json de ESTE
      equipo. Nunca sale de aquí: PacoSAT la desconoce.
   4. Deja el programa RESIDENTE (mejora 31): registra el
      protocolo pacosat:// para que los botones de PacoSAT lo
      despierten, y el arranque automático con Windows — oculto
      y en segundo plano — como comportamiento por defecto, para
      que no haya que ejecutar nada a mano nunca más. Puedes
      rechazar el arranque automático: queda el marcador
      `sin-arranque-automatico` en esta carpeta y se respeta
      siempre. Decirle a Windows dónde está el programa se hace
      AQUÍ, una vez, en tu PC: ni el instalador ni el ejecutor le
      piden rutas al servidor, y la app no enseña ni pide rutas —
      ese límite es el que protege tu e.firma.

   Si este equipo YA tiene el ejecutor instalado (hay token.txt
   o efirma-local), el instalador es idempotente: NO repite el
   emparejamiento ni toca credenciales — solo deja aplicada la
   residencia del punto 4 y lo dice en llano.

   Nada de editar archivos a mano, nada de JSON artesanal.
   ================================================================ */
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { hostname } from 'node:os';
import { asegurarResidencia, hayRechazoArranque, MARCADOR_SIN_ARRANQUE } from './registro-windows.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const EFIRMA_DIR = join(HERE, 'efirma-local');
const RFC_RE = /^[A-ZÑ&]{3,4}[0-9]{6}[A-Z0-9]{3}$/;

const rl = createInterface({ input: process.stdin, output: process.stdout });
const preguntar = texto => new Promise(resolve => rl.question(texto, r => resolve(String(r || '').trim())));

function leerSecreto(pregunta) {
  return new Promise(resolve => {
    process.stdout.write(pregunta);
    const stdin = process.stdin;
    const eraRaw = Boolean(stdin.isRaw);
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
    let valor = '';
    const onData = ch => {
      if (ch === '\r' || ch === '\n' || ch === '\u0004') {
        stdin.setRawMode(eraRaw); stdin.pause(); stdin.removeListener('data', onData);
        process.stdout.write('\n'); resolve(valor);
      } else if (ch === '\u0003') { process.exit(1); }
      else if (ch === '\u007f' || ch === '\b') { valor = valor.slice(0, -1); }
      else if (ch >= ' ') { valor += ch; }
    };
    stdin.on('data', onData);
  });
}

function elegirArchivo(titulo, filtro) {
  if (process.platform !== 'win32') return null;
  const ps = 'Add-Type -AssemblyName System.Windows.Forms; ' +
    '$d = New-Object System.Windows.Forms.OpenFileDialog; ' +
    "$d.Title = '" + titulo + "'; $d.Filter = '" + filtro + "'; " +
    "if ($d.ShowDialog() -eq 'OK') { Write-Output $d.FileName }";
  try { return execFileSync('powershell', ['-NoProfile', '-STA', '-Command', ps], { encoding: 'utf8' }).trim() || null; }
  catch { return null; }
}

function rfcDelCertificado(rutaCer) {
  try {
    const cert = new X509Certificate(readFileSync(rutaCer));
    const texto = [cert.subject, cert.subjectAltName || '', cert.serialNumber || ''].join(' ');
    const hallado = texto.toUpperCase().match(/[A-ZÑ&]{3,4}[0-9]{6}[A-Z0-9]{3}/);
    return hallado ? hallado[0] : '';
  } catch { return ''; }
}

/* 5 · La residencia (mejora 31): protocolo pacosat:// y arranque
   automático con Windows POR DEFECTO, explicado en llano. El
   rechazo es posible y queda en el marcador, que se respeta en
   este camino y en el del propio ejecutor al arrancar. */
async function pasoResidencia() {
  console.log('');
  console.log('  El ejecutor queda RESIDENTE en este equipo:');
  console.log('  - Arranca solo con Windows, oculto y en segundo plano.');
  console.log('  - Los botones de PacoSAT («Ejecutar aquí») lo despiertan');
  console.log('    al momento si algún día está cerrado.');
  console.log('  Así, cuando pulses «Consultar el Buzón» o «Bajar');
  console.log('  declaraciones», el trabajo sale porque el ejecutor ya');
  console.log('  está despierto: no hay que ejecutar nada a mano.');
  if (hayRechazoArranque(HERE)) {
    const reactivar = await preguntar('En este equipo consta que NO quieres el arranque automático. ¿Lo activo ahora? [s/N]: ');
    if (/^s/i.test(reactivar)) {
      try { unlinkSync(join(HERE, MARCADOR_SIN_ARRANQUE)); } catch { /* si no se borra, el registro lo dirá */ }
      console.log('De acuerdo: retiro el rechazo y lo dejo residente.');
    } else {
      console.log('Se respeta tu decisión: sin arranque automático.');
    }
  } else {
    const respuesta = await preguntar('¿Lo dejo así, residente con arranque automático? [S/n]: ');
    if (/^n/i.test(respuesta)) {
      writeFileSync(join(HERE, MARCADOR_SIN_ARRANQUE),
        'Sin arranque automático: tú (o el botón de PacoSAT) despiertas al ejecutor.\n' +
        'Este marcador lo escribió el instalador a petición tuya y lo respetan\n' +
        'el instalador y el propio ejecutor. Para volver atrás, bórralo y pasa\n' +
        'el instalador otra vez.\n');
      console.log('De acuerdo: queda marcado que no arranque solo. Los botones');
      console.log('de PacoSAT seguirán pudiendo despertarlo cuando los pulses.');
    }
  }
  const r = await asegurarResidencia({ dir: HERE });
  if (r.ok && r.arranqueAutomatico) {
    console.log('Listo: residente y registrado. Windows lo arrancará solo');
    console.log('en cada inicio de sesión, sin ventana y sin que hagas nada.');
  } else if (r.ok) {
    console.log('Listo: registrado para que PacoSAT lo despierte con sus');
    console.log('botones, sin arranque automático (como pediste).');
  } else {
    console.log('OJO: no se pudo dejar el registro de Windows (' + r.motivo + ').');
    console.log('El ejecutor funciona igual si lo despiertas desde PacoSAT,');
    console.log('pero vuelve a pasar este instalador para dejarlo residente.');
  }
  return r;
}

async function main() {
  console.log('');
  console.log('  Instalador del ejecutor de PacoSAT');
  console.log('  =================================');
  console.log('  Este programa es el que, desde TU equipo, entra al SAT');
  console.log('  con tu e.firma cuando PacoSAT te lo encarga. Tu e.firma');
  console.log('  y su contraseña se quedan en este equipo, siempre.');
  console.log('');

  /* 0 · Instalación viva: idempotencia de verdad. Si ya hay
     llave o e.firma en este equipo, NO se repite el
     emparejamiento ni se toca una sola credencial: solo se
     aplica la residencia (protocolo + arranque) y se dice. */
  if (existsSync(join(HERE, 'token.txt')) || existsSync(EFIRMA_DIR)) {
    console.log('  Este equipo YA tiene el ejecutor instalado y emparejado:');
    console.log('  no se repite el emparejamiento ni se toca tu e.firma.');
    console.log('  Solo dejo aplicada la parte nueva: que quede residente.');
    await pasoResidencia();
    console.log('');
    console.log('  Ya está. No tienes que arrancar nada: el ejecutor vive');
    console.log('  en este equipo y PacoSAT lo despierta desde sus botones.');
    rl.close();
    return;
  }

  /* 1 · La dirección de tu PacoSAT */
  const urlGuardada = existsSync(join(HERE, 'url.txt')) ? readFileSync(join(HERE, 'url.txt'), 'utf8').trim() : '';
  const porDefecto = urlGuardada || 'https://pacosat.iglesiasmurrieta.com';
  const url = (await preguntar('Dirección de tu PacoSAT [' + porDefecto + ']: ')) || porDefecto;
  writeFileSync(join(HERE, 'url.txt'), url.replace(/\/$/, '') + '\n');

  /* 2 · El código corto */
  if (existsSync(join(HERE, 'token.txt'))) {
    console.log('Ya hay una llave guardada en este equipo: no hace falta código.');
  } else {
    console.log('');
    console.log('En PacoSAT, abre el Buzón Tributario › «Ejecutor local del SAT»');
    console.log('y pulsa «Código corto para el instalador». Teclea aquí ese código');
    console.log('(caduca en 10 minutos y sirve una sola vez):');
    const codigo = (await preguntar('Código: ')).toUpperCase();
    const res = await fetch(url.replace(/\/$/, '') + '/api/executor/exchange', { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ codigo, nombre: 'Equipo ' + hostname() }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.token) {
      console.error('No se pudo canjear el código: ' + (data.error || ('PacoSAT respondió ' + res.status)));
      console.error('Pide un código nuevo en PacoSAT y vuelve a intentarlo.');
      process.exitCode = 1; rl.close(); return;
    }
    writeFileSync(join(HERE, 'token.txt'), data.token, { mode: 0o600 });
    console.log('Emparejado: la llave quedó guardada en este equipo.');
  }

  /* 3 · La e.firma */
  console.log('');
  console.log('Ahora tu e.firma. Elige el archivo del certificado (.cer):');
  let rutaCer = elegirArchivo('Elige tu certificado (.cer)', 'Certificado (*.cer)|*.cer|Todos (*.*)|*.*');
  if (!rutaCer) rutaCer = await preguntar('Ruta del archivo .cer: ');
  if (!rutaCer || !existsSync(rutaCer)) { console.error('No encuentro ese .cer: instalación detenida, sin tocar nada.'); process.exitCode = 1; rl.close(); return; }
  console.log('Y la llave privada (.key):');
  let rutaKey = elegirArchivo('Elige tu llave privada (.key)', 'Llave privada (*.key)|*.key|Todos (*.*)|*.*');
  if (!rutaKey) rutaKey = await preguntar('Ruta del archivo .key: ');
  if (!rutaKey || !existsSync(rutaKey)) { console.error('No encuentro ese .key: instalación detenida, sin tocar nada.'); process.exitCode = 1; rl.close(); return; }

  let rfc = rfcDelCertificado(rutaCer);
  if (rfc) console.log('El certificado dice que es del RFC ' + rfc + '.');
  while (!RFC_RE.test(rfc)) {
    rfc = (await preguntar('No pude leer el RFC del certificado: escríbelo tú (13 caracteres): ')).toUpperCase();
  }
  mkdirSync(EFIRMA_DIR, { recursive: true, mode: 0o700 });
  copyFileSync(rutaCer, join(EFIRMA_DIR, rfc + '.cer'));
  copyFileSync(rutaKey, join(EFIRMA_DIR, rfc + '.key'));

  /* 4 · La contraseña: una vez, sin eco */
  const clave = await leerSecreto('Contraseña de la e.firma de ' + rfc + ' (no se ve al teclear): ');
  if (!clave) { console.error('Sin contraseña no hay instalación: la e.firma quedó copiada, pero sin perfiles.json el ejecutor no puede firmar.'); process.exitCode = 1; rl.close(); return; }
  let perfiles = {};
  try { perfiles = JSON.parse(readFileSync(join(EFIRMA_DIR, 'perfiles.json'), 'utf8')); } catch { /* nace ahora */ }
  perfiles[rfc] = { password: clave };
  writeFileSync(join(EFIRMA_DIR, 'perfiles.json'), JSON.stringify(perfiles, null, 2), { mode: 0o600 });

  console.log('');
  console.log('  Listo. La e.firma de ' + rfc + ' quedó en este equipo');
  console.log('  (efirma-local) y el ejecutor está emparejado.');

  /* 5 · La residencia: el programa queda viviendo en el equipo */
  await pasoResidencia();

  console.log('');
  console.log('  Desde ahora no tienes que arrancar nada: el ejecutor');
  console.log('  vive en este equipo, y si algún día está cerrado, los');
  console.log('  botones de PacoSAT («Ejecutar aquí») lo despiertan.');
  console.log('  (arrancar.bat queda como camino manual de reserva.)');
  rl.close();
}

main().catch(error => { console.error('La instalación no pudo terminar: ' + (error?.message || error)); process.exitCode = 1; });
