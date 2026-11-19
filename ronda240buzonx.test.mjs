import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateBuzonResult, validateExecutorResult, buildExecutorJob,
  sanitizeBuzonSecciones240 } from './sat-executor.mjs';
import { buzonSecciones240De } from './ejecutor-local.mjs';

/* ================================================================
   Ronda 2.4.0 · WC1b — cierre del hueco del Buzón completo por
   la vía del EJECUTOR (ítem 4 de castigo, hueco declarado por
   WC1 en su nota). El motor ya listaba «Mis comunicados» y
   «Mis documentos» y el servidor ya guardaba las secciones de
   la corrida LOCAL, pero por la vía del ejecutor no llegaban:
   validateBuzonResult las pelaba del resultado validado y
   ejecutor-local.mjs no las reenviaba en el trabajo
   buzon-listar. Esta suite fija, sin portal:
   1 · El validador acepta un resultado de Buzón con secciones
       bien formadas y las conserva ENTERAS (también a través
       de validateExecutorResult).
   2 · Lo que excede la forma se rechaza/recorta SIN tumbar el
       resto: fila con campos raros fuera, fila con un valor
       que no es texto fuera, listas y textos desbordados
       acotados, material con forma de secreto REDACTADO (no
       rechazado), sección que no es objeto fuera y el resto
       del resultado intacto.
   3 · El ejecutor reenvía las secciones BYTE A BYTE (misma
       referencia, mismo JSON) con su doble puro de siempre
       (buzonSecciones240De, gemelo de resultadosDiagDe), y el
       cableado de ejecutarIntento lo usa en buzon-listar.
   4 · Paridad: un resultado SIN secciones valida exactamente
       como antes — ni el validador ni el ejecutor ganan
       ningún campo nuevo.
   ================================================================ */

const AQUI = dirname(fileURLToPath(import.meta.url));
const RFC = 'MFI6212158B4';
const OPS = ['entrar-con-efirma', 'navegar-a-lista', 'leer-lista'];

const SECCIONES_BUENAS = {
  comunicados: { concluyente: true,
    items: [{ fecha: '2026-11-05', asunto: 'Comunicado de prueba', leido: false },
      { fecha: '2026-10-20', asunto: 'Aviso informativo', leido: true }],
    noLeidos: 1, leidos: 1, soloConteos: false },
  documentos: { concluyente: false, items: [],
    motivo: 'La bandeja de «Mis documentos» no cargó en el plazo de espera: no consta su contenido, no es un cero.' }
};
const resultadoBueno = () => ({ operations: OPS,
  notifications: [{ fecha: '2026-11-10', asunto: 'Requerimiento de información',
    remitente: 'Auditoría', estado: 'Pendiente', abierta: false }],
  comunicadosNoLeidos: 1,
  comunicados: structuredClone(SECCIONES_BUENAS.comunicados),
  documentos: structuredClone(SECCIONES_BUENAS.documentos) });

/* ===== 1 · Secciones bien formadas: se conservan enteras ===== */
{
  const validado = validateBuzonResult(resultadoBueno());
  assert.deepEqual(validado.comunicados, SECCIONES_BUENAS.comunicados,
    'comunicados pasa el validador entero, campo a campo');
  assert.deepEqual(validado.documentos, SECCIONES_BUENAS.documentos,
    'documentos pasa el validador entero, con su motivo de no concluyente');
  assert.equal(validado.comunicadosNoLeidos, 1, 'el conteo de siempre se conserva');
  assert.equal(validado.notifications.length, 1, 'las notificaciones de siempre se conservan');

  const job = buildExecutorJob({ rfc: RFC, kind: 'buzon-listar' });
  const completo = validateExecutorResult(job, resultadoBueno());
  assert.deepEqual(completo.comunicados, SECCIONES_BUENAS.comunicados,
    'validateExecutorResult también entrega comunicados');
  assert.deepEqual(completo.documentos, SECCIONES_BUENAS.documentos,
    'validateExecutorResult también entrega documentos');
  console.log('OK WC1b·1 — Validador: secciones bien formadas se conservan enteras (validateBuzonResult y validateExecutorResult).');
}

/* ===== 2 · Exceso de forma: se recorta sin tumbar el resto ===== */
{
  /* Fila con campos raros y fila con un valor que no es texto:
     esas filas caen; la buena y el resto del resultado quedan. */
  const conFilasRaras = resultadoBueno();
  conFilasRaras.comunicados.items = [
    { fecha: '2026-11-05', asunto: 'La buena', leido: false },
    { fecha: '2026-11-04', asunto: 'Con campo raro', leido: true, onclick: 'alert(1)' },
    { fecha: '2026-11-03', asunto: { no: 'es texto' }, leido: false },
    { fecha: '2026-11-02', asunto: 'Leído que no es booleano', leido: 'sí' }];
  conFilasRaras.documentos = { concluyente: true, items: [
    { fecha: '2026-11-02', nombre: 'Constancia de situación fiscal', estado: 'Vigente' },
    { fecha: '2026-11-01', nombre: 'Con token raro', estado: 'Vigente', token: 'x' }] };
  const validado = validateBuzonResult(conFilasRaras);
  assert.deepEqual(validado.comunicados.items,
    [{ fecha: '2026-11-05', asunto: 'La buena', leido: false }],
    'solo la fila bien formada sobrevive: ' + JSON.stringify(validado.comunicados.items));
  assert.deepEqual(validado.documentos.items,
    [{ fecha: '2026-11-02', nombre: 'Constancia de situación fiscal', estado: 'Vigente' }],
    'en documentos, la fila con campo raro también cae sola');
  assert.equal(validado.notifications.length, 1, 'el resto del resultado no se tumbó');
  assert.equal(validado.comunicados.concluyente, true, 'la sección sigue concluyente con su fila buena');
  console.log('OK WC1b·2a — Forma: fila con campos raros o valores no-texto cae sola, sin tumbar el resto.');
}
{
  /* Tamaño desbordado: lista y textos acotados a los topes
     de la narrativa (200 filas; asunto/nombre 300; motivo 600). */
  const desbordado = resultadoBueno();
  /* Textos largos pero en prosa (con espacios): un bloque sin
     espacios de ≥240 caracteres es, por la regla de la casa,
     material con forma de secreto y se redacta — eso se juzga
     en 2c, no aquí. */
  desbordado.comunicados.items = Array.from({ length: 250 }, (_, i) =>
    ({ fecha: '2026-11-05', asunto: 'Comunicado ' + i + ' ' + 'palabra '.repeat(60), leido: false }));
  desbordado.documentos = { concluyente: false, items: [], motivo: 'motivo '.repeat(150) };
  const validado = validateBuzonResult(desbordado);
  assert.equal(validado.comunicados.items.length, 200, 'la lista se acota a 200 filas');
  assert.ok(validado.comunicados.items.every(f => f.asunto.length <= 300),
    'cada asunto queda acotado a 300 caracteres');
  assert.equal(validado.documentos.motivo.length, 600, 'el motivo queda acotado a 600 caracteres');
  assert.equal(validado.notifications.length, 1, 'y el resto del resultado sigue intacto');
  console.log('OK WC1b·2b — Forma: lista de 250 ⇒ 200, asunto ⇒ 300 y motivo ⇒ 600, sin tumbar el resto.');
}
{
  /* Material con forma de secreto dentro de una sección:
     se REDACTA como el resto de la narrativa (el criterio de
     resultadosDiag en P2), no tumba el resultado; y una clave
     de sección con nombre de credencial se descarta sola. */
  const secreto = '-----BEGIN PRIVATE KEY-----\nMIIB' + 'A'.repeat(300) + '\n-----END PRIVATE KEY-----';
  const conSecreto = resultadoBueno();
  conSecreto.comunicados.items = [{ fecha: '2026-11-05', asunto: 'Antes ' + secreto + ' después', leido: false }];
  conSecreto.comunicados.password = 'no-debe-viajar';
  const validado = validateBuzonResult(conSecreto);
  assert.equal(validado.comunicados.items.length, 1, 'la fila con el bloque se conserva');
  assert.ok(!validado.comunicados.items[0].asunto.includes('PRIVATE KEY'),
    'el bloque con forma de secreto quedó redactado: ' + validado.comunicados.items[0].asunto);
  assert.ok(validado.comunicados.items[0].asunto.includes('[redactado]'), 'con su marca de redactado');
  assert.ok(!('password' in validado.comunicados), 'la clave rara de sección se descarta, la sección sigue');
  assert.equal(validado.notifications.length, 1, 'el resultado entero no se rechazó por la narrativa');
  console.log('OK WC1b·2c — Forma: secreto en la sección ⇒ redactado y conservado; clave de credencial descartada sola.');
}
{
  /* Sección que no es un objeto, o sin lista: cae entera y
     el campo queda ausente (el «no consta» de siempre). */
  const rota = resultadoBueno();
  rota.comunicados = 'una cadena no es una sección';
  rota.documentos = { concluyente: true, items: 'tampoco' };
  const validado = validateBuzonResult(rota);
  assert.ok(!('comunicados' in validado), 'comunicados no-objeto: campo ausente');
  assert.ok(!('documentos' in validado), 'documentos sin lista: campo ausente');
  assert.equal(validado.notifications.length, 1, 'el resto del resultado valida como siempre');
  assert.deepEqual(sanitizeBuzonSecciones240({}), {}, 'sin secciones, el saneador no inventa ninguna');
  console.log('OK WC1b·2d — Forma: sección rota cae entera (campo ausente = no consta) y el resto valida.');
}

/* ===== 3 · El ejecutor reenvía las secciones byte a byte ===== */
{
  const delMotor = resultadoBueno();
  const reenvio = buzonSecciones240De(delMotor);
  assert.ok(reenvio, 'con secciones en el motor, hay reenvío');
  assert.equal(reenvio.comunicados, delMotor.comunicados,
    'comunicados es LA MISMA referencia que devolvió el motor: sin copiar ni transformar');
  assert.equal(reenvio.documentos, delMotor.documentos,
    'documentos es LA MISMA referencia que devolvió el motor');
  assert.equal(JSON.stringify(reenvio), JSON.stringify({
    comunicados: SECCIONES_BUENAS.comunicados, documentos: SECCIONES_BUENAS.documentos }),
    'el JSON del reenvío es byte a byte el de las secciones del motor');
  /* Solo una sección en el motor: solo esa viaja. */
  const soloDocs = buzonSecciones240De({ documentos: delMotor.documentos });
  assert.deepEqual(Object.keys(soloDocs), ['documentos'], 'sin comunicados en el motor, ese campo no nace');
  assert.equal(soloDocs.documentos, delMotor.documentos);
  /* El cableado: ejecutarIntento compone el resultado de
     buzon-listar con el reenvío (ejecutarIntento no es
     importable; se juzga su texto, como en ronda232ejecutor). */
  const fuente = readFileSync(join(AQUI, 'ejecutor-local.mjs'), 'utf8');
  const idxBuzon = fuente.indexOf("job.kind === 'buzon-listar'");
  const idxReenvio = fuente.indexOf('buzonSecciones240De(result)', idxBuzon);
  assert.ok(idxBuzon >= 0 && idxReenvio > idxBuzon,
    'ejecutarIntento reenvía las secciones en la rama de buzon-listar');
  assert.ok(fuente.slice(idxBuzon, idxReenvio).includes('comunicadosNoLeidos'),
    'el reenvío acompaña al resultado de siempre, no lo sustituye');
  console.log('OK WC1b·3 — Ejecutor: buzonSecciones240De reenvía byte a byte y ejecutarIntento lo cablea en buzon-listar.');
}

/* ===== 4 · Paridad: sin secciones, todo como antes ===== */
{
  const sinSecciones = { operations: OPS,
    notifications: [{ fecha: '2026-11-10', asunto: 'Requerimiento de información',
      remitente: 'Auditoría', estado: 'Pendiente', abierta: false }],
    comunicadosNoLeidos: 2 };
  const validado = validateBuzonResult(sinSecciones);
  assert.deepEqual(Object.keys(validado).sort(), ['comunicadosNoLeidos', 'counts', 'notifications'],
    'validateBuzonResult sin secciones devuelve exactamente las claves de siempre');
  assert.equal(validado.comunicadosNoLeidos, 2);
  const job = buildExecutorJob({ rfc: RFC, kind: 'buzon-listar' });
  const completo = validateExecutorResult(job, structuredClone(sinSecciones));
  assert.ok(!('comunicados' in completo) && !('documentos' in completo),
    'validateExecutorResult sin secciones no gana ningún campo nuevo');
  assert.equal(buzonSecciones240De(sinSecciones), undefined,
    'el ejecutor sin secciones en el motor no gana ningún campo (réplicas viejas)');
  assert.equal(buzonSecciones240De({}), undefined);
  assert.equal(buzonSecciones240De(null), undefined);
  console.log('OK WC1b·4 — Paridad: resultado sin secciones valida y viaja exactamente como antes.');
}

console.log('OK suite ronda240buzonx completa');
