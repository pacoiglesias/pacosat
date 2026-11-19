/* ================================================================
   Ronda 2.4.0 · W5b3 — migración residual de glifos a la familia
   de iconos (continuación de la 9b de W5b2 en sus cinco ficheros).

   Territorio: avisos-ui, ciec-ui, compliance-ui, coverage-ui,
   declaraciones-ui, monitor-ui, operations, pagos-ui,
   problemas-ui, sat-ui, satdocs-ui, tributario-ui, banks-ui,
   salud-ui, settings-ui y data.part.

   (1) Grep fijado: ningún glifo-icono (✓ ✗ ⚠ ⏳ ● ○ ✕) queda en
       el código PINTADO de esos ficheros. Cada texto conserva su
       palabra visible; el icono lo pone data-estado (familia W5a)
       o el puente data-state de statusPill, o es una forma
       dibujada (el punto del calendario).
   (2) LISTA BLANCA explícita — los únicos «⚠» que quedan NO se
       pintan: son el MARCADOR INTERNO de los pasos del motor
       CIEC y su detector. Sitios y porqué:
       · data.part — `text.startsWith('⚠')` ×2: el detector de
         runPhaseStates. El productor es sat-ciec.mjs (motor,
         fuera de territorio) y las corridas ya guardadas traen
         la marca en su texto; cambiarla exigiría reescribir el
         historial. Sus dos comentarios «⚠» documentan la marca.
       · satdocs-ui.part — `textoCrudo240.startsWith('⚠')` ×1 y
         su comentario: el PINTADO de esos pasos — satDocStepList
         retira el prefijo del texto visible y pone en su lugar
         data-estado="atencion". El dato no se toca.
       Ningún otro glifo de la lista queda en ningún fichero del
       territorio, ni en código ni en comentarios.
   (3) La detección de avisos de data.part sigue funcionando con
       los casos que dependen del prefijo (los de ronda1130 y los
       del segundo brazo del detector), leída del xml-core.mjs
       que el build genera desde data.part.
   (4) Anclas de la migración: cada superficie tocada pinta su
       estado con data-estado o con el puente de statusPill.
   ================================================================ */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runPhaseStates } from './xml-core.mjs';

const ROOT = import.meta.dirname;
const read = name => readFileSync(join(ROOT, name), 'utf8');

const TERRITORIO = ['avisos-ui.part', 'ciec-ui.part', 'compliance-ui.part',
  'coverage-ui.part', 'declaraciones-ui.part', 'monitor-ui.part',
  'operations.part', 'pagos-ui.part', 'problemas-ui.part', 'sat-ui.part',
  'satdocs-ui.part', 'tributario-ui.part', 'banks-ui.part', 'salud-ui.part',
  'settings-ui.part', 'data.part'];
const GLIFOS = ['✓', '✗', '⚠', '⏳', '●', '○', '✕'];

/* ===== (1)+(2) Grep fijado con lista blanca del marcador ===== */
{
  /* Una línea está en lista blanca SOLO si lee el marcador o lo
     documenta: contiene startsWith('⚠') o la cita «⚠ en un
     comentario. Todo lo demás con glifo es un fallo. */
  const enListaBlanca = linea =>
    linea.includes("startsWith('⚠')") || linea.includes('«⚠');
  let detectores = 0;
  for (const fichero of TERRITORIO) {
    const lineas = read(fichero).split('\n');
    lineas.forEach((linea, indice) => {
      for (const glifo of GLIFOS) {
        if (!linea.includes(glifo)) continue;
        assert.ok(glifo === '⚠' && enListaBlanca(linea),
          '(1) glifo «' + glifo + '» fuera de lista blanca en ' +
          fichero + ':' + (indice + 1) + ' — ' + linea.trim().slice(0, 90));
        if (linea.includes("startsWith('⚠')")) detectores++;
      }
    });
  }
  /* La lista blanca es EXACTA: 2 detectores en data.part y 1
     lector para el pintado en satdocs-ui.part; ni uno más. */
  assert.equal(detectores, 3, '(2) la lista blanca del marcador es exacta: 3 lectores');
  const data = read('data.part');
  assert.equal((data.match(/⚠/g) || []).length, 4,
    '(2) data.part: solo el detector (×2) y su documentación (×2)');
  const satdocs = read('satdocs-ui.part');
  assert.equal((satdocs.match(/⚠/g) || []).length, 2,
    '(2) satdocs-ui.part: solo el lector del pintado (×1) y su comentario (×1)');
  console.log('OK 2.4.0·W5b3 (1/2) — cero glifos-icono pintados en 16 ficheros; lista blanca del marcador: 3 lectores exactos.');
}

/* ===== (3) La detección de avisos por el prefijo sigue viva ===== */
{
  const paso = text => ({ text });
  const CIEC = [
    { label: 'Entrar al portal', match: ['Conectando con el portal', 'Tecleando tu RFC', 'Ya estás dentro'] },
    { label: 'Escribir el captcha', match: ['pide el captcha', 'no aceptó ese captcha'] },
    { label: 'Consultar tus facturas', match: ['Buscando tus facturas', 'El portal encontró'] },
    { label: 'Descargar las facturas', match: ['Descargando tus facturas'] },
    { label: 'Guardar en tu expediente', match: ['Guardando en tu expediente'] }];
  /* El caso de ronda1130, tal cual: el aviso del captcha marca SU
     fase sin cambiarle el estado. */
  const captcha = runPhaseStates(CIEC, [paso('Conectando con el portal del SAT…'),
    paso('Tecleando tu RFC y tu contraseña…'),
    paso('⚠ El portal no aceptó ese captcha. Intento 1 de 3…')], 'failed');
  assert.deepEqual(captcha.map(f => f.state), ['done', 'failed', 'pending', 'pending', 'pending']);
  assert.equal(captcha[1].warn, true, '(3) el aviso «⚠» queda marcado en su fase');
  assert.equal(captcha[0].warn, false, '(3) la fase sin aviso no se marca');
  /* Segundo brazo del detector: un paso «⚠» que no casa con ningún
     fragmento marca la fase en curso (el suelo alcanzado). */
  const suelo = runPhaseStates(CIEC, [paso('Conectando con el portal del SAT…'),
    paso('⚠ El portal tardó demasiado en responder…')], 'running');
  assert.equal(suelo[0].warn, true, '(3) el aviso sin fragmento marca la fase alcanzada');
  assert.deepEqual(suelo.map(f => f.state), ['current', 'pending', 'pending', 'pending', 'pending']);
  /* Sin prefijo no hay aviso, aunque el texto hable de un problema. */
  const sinMarca = runPhaseStates(CIEC, [paso('Conectando con el portal del SAT…'),
    paso('El portal no aceptó ese captcha. Intento 1 de 3…')], 'failed');
  assert.equal(sinMarca[1].warn, false, '(3) sin el marcador no se inventa el aviso');
  /* Corrida buena con un aviso dentro: todo hecho y el aviso consta. */
  const buena = runPhaseStates(CIEC, [paso('Conectando con el portal del SAT…'),
    paso('⚠ El portal tardó: se reintentó solo…'), paso('Guardando en tu expediente…')], 'ok');
  assert.deepEqual(buena.map(f => f.state), ['done', 'done', 'done', 'done', 'done']);
  assert.equal(buena[0].warn, true, '(3) el aviso consta aunque la corrida acabe bien');
  console.log('OK 2.4.0·W5b3 (3) — runPhaseStates detecta el marcador «⚠» en sus dos brazos y no inventa avisos sin él.');
}

/* ===== (4) Anclas: el estado se pinta con la familia, no con glifo ===== */
{
  const anclas = [
    ['avisos-ui.part', "tituloResultado240.dataset.estado", 'el título del resultado limpia su estado'],
    ['avisos-ui.part', "$('activity-result-title').dataset.estado = 'atencion'", 'activityFail pinta atención con la familia'],
    ['avisos-ui.part', "statusPill('ok', avisoFecha(aviso.resuelto))", 'el historial usa el puente data-state de statusPill'],
    ['ciec-ui.part', "cabezaProgreso240.dataset.estado", 'la cabeza de progreso CIEC con data-estado'],
    ['ciec-ui.part', "lineaCorrida240.dataset.estado = run.ok ? 'aldia' : 'atencion'", 'el diario CIEC con data-estado'],
    ['compliance-ui.part', "punto240.style.cssText", 'el punto del calendario es una forma dibujada'],
    ['coverage-ui.part', "btn.dataset.estado = 'aldia'", 'el botón «Pedido» con data-estado'],
    ['declaraciones-ui.part', 'function declPill240(estado)', 'la pastilla del mapa sale de declPill240'],
    ['declaraciones-ui.part', "presentada: 'Presentada'", 'el estado de la declaración es solo palabra'],
    ['declaraciones-ui.part', "alertaDecl240.dataset.estado = 'atencion'", 'la alerta de meses sin recuperar con data-estado'],
    ['monitor-ui.part', "lineaFinal240.dataset.estado = 'aldia'", 'el final de la corrida con data-estado'],
    ['monitor-ui.part', "activityFail('La revisión se detuvo a mitad'", 'la revisión detenida va por activityFail'],
    /* RE-BASE 2.8.0 (diseño 4): el «Estado de operación» salió
       de Ajustes; el estado del sistema — respaldo y copia
       externa incluidos — se pinta en Salud con su pastilla. */
    ['salud-ui.part', 'head.append(statusPill(SALUD_PILL200D[tarjeta.estado]', 'la copia externa avisa con su palabra (en Salud)'],
    ['pagos-ui.part', "todoPagado240.dataset.estado = 'aldia'", '«Todo pagado» con data-estado'],
    ['pagos-ui.part', "aviso.dataset.estado = pagosClabeOk(value) ? 'aldia' : 'error'", 'el veredicto de la CLABE con data-estado'],
    ['problemas-ui.part', "marcaFase240.dataset.estado", 'la marca de fase es el icono de la familia'],
    ['problemas-ui.part', "okLine.dataset.estado = 'aldia'", 'la línea sana de Salud con data-estado'],
    ['sat-ui.part', 'statusPill(e.nivel, e.frase)', 'el semáforo del Centro SAT usa el puente data-state'],
    /* RE-BASE integración 2.4.0 (W6b): el rótulo de vigilancia
       (tituloVig240) lo pinta restSwitch, que vive en el puente
       de ui.part — el ancla se busca en su nuevo hogar, con el
       mismo literal. La lista blanca de glifos no cambia. */
    ['ui.part', "tituloVig240.dataset.estado", 'el rótulo de vigilancia con data-estado según su nivel'],
    ['sat-ui.part', "linea240.dataset.estado = 'aldia'", 'la solicitud enviada con data-estado'],
    ['satdocs-ui.part', "textoPaso240.dataset.estado = 'atencion'", 'el paso con marcador se pinta con la familia y el texto limpio'],
    ['satdocs-ui.part', "pasoArranque240.dataset.estado = step.done ? 'aldia' : 'sindatos'", 'la puesta en marcha con data-estado'],
    ['tributario-ui.part', "lineaRun240.dataset.estado = run.ok ? 'aldia' : 'error'", 'el diario del Buzón con data-estado'],
    ['banks-ui.part', "avisoMeses240.dataset.estado = 'atencion'", 'el aviso de meses distintos con data-estado'],
    ['banks-ui.part', "cadena240.dataset.estado = 'atencion'", 'el detalle de la cadena con data-estado'],
    ['salud-ui.part', "resultadoEnsayo230.dataset.estado", 'el resultado del ensayo con data-estado'],
    ['salud-ui.part', "lineaHecha240.dataset.estado = 'aldia'", 'lo reparado con data-estado'],
    ['salud-ui.part', "lineaRota240.dataset.estado = 'error'", 'lo roto con data-estado'],
    ['settings-ui.part', "nota.dataset.estado = 'aldia'", 'la nota de guardado con data-estado'],
    ['settings-ui.part', "pruebaTexto.dataset.estado = r?.ok ? 'aldia' : 'error'", 'la prueba de Paperless con data-estado'],
    ['data.part', "if (text.startsWith('⚠')) warned[i] = true;", 'el detector del marcador sigue en data.part'],
  ];
  for (const [fichero, ancla, nombre] of anclas)
    assert.ok(read(fichero).includes(ancla), '(4) falta la ancla de ' + nombre + ' en ' + fichero);
  console.log('OK 2.4.0·W5b3 (4) — ' + anclas.length + ' anclas de pintado con la familia en las superficies tocadas.');
}
console.log('OK 2.4.0·W5b3 glifos — migración residual completa en el territorio, con el marcador interno declarado.');
