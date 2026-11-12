import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPacoSATService } from './local-server.mjs';
import { problemSpec, runPhaseStates } from './xml-core.mjs';

/* Ronda 1.13.0 — «Problemas claros y sistema más visual»:
   (1) el modelo único de problema (problemSpec): cada estado
   conocido con su semáforo, su titular SIN código crudo, su
   «qué significa» y su «qué pasa ahora»; (2) las fases visuales
   de una corrida (runPhaseStates), incluida la forma exacta de
   la corrida real de la constancia que falló el 10 nov 2026;
   (3) el Centro de mando cableado en la superficie y la cuenta
   de toques antes/después de las operaciones frecuentes;
   (4) la salud del sistema por el endpoint (estados y resumen);
   (5) los avisos importantes por correo con el correo de
   juguete: evento → un correo con el titular correcto,
   interruptor apagado → cero, sin dirección → cero;
   (6) la clase de fallo (errorKind) expuesta por las corridas
   de documentos, CIEC y declaraciones. */
const CER = 'MIIDUzCCAjugAwIBAgIUH2WzMvVXT5BC2dNEzTaqRKJcZVUwDQYJKoZIhvcNAQELBQAwOTEgMB4GA1UEAwwXRU1QUkVTQSBQUlVFQkEgU0EgREUgQ1YxFTATBgNVBAUTDE1GSTYyMTIxNThCNDAeFw0yNjExMDkwNTA0MzVaFw0zNjExMDYwNTA0MzVaMDkxIDAeBgNVBAMMF0VNUFJFU0EgUFJVRUJBIFNBIERFIENWMRUwEwYDVQQFEwxNRkk2MjEyMTU4QjQwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQDJv/UPUgh/H1XwYFWUj2DV8HVVL95Z3LSi7P5yC1m2hcXlGVyvrc9EwIxTYuKVndt3mZyafViTg7Zng3wPs/bkZIhWcXTBkFPy8/4OZF4HKhgQTByszYEqBo4hr6o98FqS638cXcIkAzKFaIhpIJUpFMmUyKlSLgdWRcW7gm4SF2TaWYWi5CBok6gSoWsbmvEdFa0BbSCTxUUOxxWeoqhaMeYgN+PYpLWkl8Iq7VZJ+JeH0LMvbKg6Bhug0KOnC3/yNSBDIrg+A1rOysN8JJOU76zPuqj6aki7+oAEZIpGcu6h3cri7S8qq3zYupFdmZHwRySGDRci3ZpyCqjlFB97AgMBAAGjUzBRMB0GA1UdDgQWBBQYRYXN6Lv4Ke+TNpNWj7H1tqkEpTAfBgNVHSMEGDAWgBQYRYXN6Lv4Ke+TNpNWj7H1tqkEpTAPBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUAA4IBAQC8EwF8xC42pm/jFhTaO/gp2LDiSfz5cIJyZe9XsbczupYA9moD0Y9qMdEFAqgSVmFqJNgE675d5meRJdvRariROlpN3BZfcvPDEqHnwjqzjgHBt9e+GYb8UzdvkWiJuN7hoWgs2m+AJdPnsIWopKVI8enqng9Un7LbzCkACmJuG03Y+N7uuT/jIE+hNBHLJI6S9CGGs3hr8S4eZ2ijQeYyrWtLoeadLFsp4QqDb/JqXGtrIWFH9p3TNDEvyyVsYUBXSBIxX9zf/EYQ9NMLqIVSJ5hR/GjmDPf0plFteYQZEhRohrXnAox6clkDaIqTJkzWHhY4PHCPn+sJAh+Jzz8Y';
const KEY = 'MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDJv/UPUgh/H1XwYFWUj2DV8HVVL95Z3LSi7P5yC1m2hcXlGVyvrc9EwIxTYuKVndt3mZyafViTg7Zng3wPs/bkZIhWcXTBkFPy8/4OZF4HKhgQTByszYEqBo4hr6o98FqS638cXcIkAzKFaIhpIJUpFMmUyKlSLgdWRcW7gm4SF2TaWYWi5CBok6gSoWsbmvEdFa0BbSCTxUUOxxWeoqhaMeYgN+PYpLWkl8Iq7VZJ+JeH0LMvbKg6Bhug0KOnC3/yNSBDIrg+A1rOysN8JJOU76zPuqj6aki7+oAEZIpGcu6h3cri7S8qq3zYupFdmZHwRySGDRci3ZpyCqjlFB97AgMBAAECggEADYRMYA86yCrqdZU8C/ItO+LajES4QiSyKjD0Uoy7ISpGRMqrCzl7Elv6Kti3CJd6bZa/nMQldpX+VwzCokSy7RYP4lwYmqKs/9vkBhp9suou5uH1O931jOzCggmZv4DxIzh0RuDAkewa6urtf2mc72iCoZ1uEWD0bI3L09EccclmqMihSGfwiihOwAWo2/1qM3ZOKraGe/AT2eUrGwfKqJKWIAzp6ec6cWHt+YtmQY+JtcpQcNVjPewosVD3xRV60knDaFKwCZeRmYQ9jZhFAoOA57nkRshPhejKV8iNvA1tdWWrqpRL/UjtpIs3y2jBfFtGNFL0oZMpWKhQSRFCzQKBgQDqRQ8hFqINPgwKorrZ676TkPPhQ2Ag2anCq0YCK84qPfRArhnwEVYbrzw9TEyF0RRn6DE22S+QzbGgjTDTcSbuBEY2jKlwgXZjGRa/NEN+rl+JWBtw02vk1l5EDBPCjXdxP7r7opL57yUU7UamnW/MBMhxG9tdSI6u6yEpi0vTBwKBgQDcdq8Wn5oRQYKYuXcZIbxEnsTuP0TQFev8Kplb91wB8SPxQt6glKmQQRJdztXX1JrOJoQUUy2Rlt43LxXh1aOWOm6TdTAeI+gOKUn/c4KYVq3yKw1sD61SNV7Oh8lZrb1laVavou0KbuKi4C3ifkmI/IYVFiaD0sKoGZ98GjWu7QKBgQDG3A5GqR6wHP49vPrdZzbjroTGr9mWqQ1oWNjZmPOted+vU9pipWSxpWN+KRk/8kXfGgNEqsGsql5gidlrcr54BprPTUG7ZbnnzvE3JxcwHrasMGVCtcT9gFaObq4LVOiR8mY3mj4m+LBCflOdtUCkL18yXFIuchvkMWV6DWs02wKBgEyOkkKC7ddsLlOmo+sAQgZ6M9yf799qnWYVzOeYwESUXmzbUb/ln/ROBHi66JtoYtGPonIEaGCUSVpUaX7g10vFwrxGB42P3nd8cwvYKtOH1iOwO5r43rEbg26ozIztvkVHDSk0pKfo1Z7FxmlOfW6qck1EQd+pApupOi64U0gJAoGBAJrkBt1d6wppq6p+RvwvIEm63/DuF80Cx/kG7YMEfJ3GQUQYmOxgIRniLZEitYSV2w3prwb/oBBu8TBsmM0nzFj/0SylLBWylVOKTtg8fxl7nEaJLJhjCyJAHtSgwtFnwLLNb2kBj2tR0BR2cT9H4wzwI0yNk0I7iEc6qsZ6FzGy';

/* ===== 1 · El modelo único de problema ===== */
{
  const casos = [
    /* Vigilancia: el 69-B definitivo es lo único rojo del archivo;
       el falso «Formato rechazado» dice que PacoSAT preguntó mal,
       no que el comprobante esté mal. */
    ['vigilancia', { efos: ['Definitivo'] }, 'rojo', '69-B'],
    ['vigilancia', { efos: ['Presunto'] }, 'ambar', '69-B'],
    ['vigilancia', { state: 'Cancelado' }, 'ambar', 'canceló'],
    ['vigilancia', { state: 'No encontrado' }, 'gris', 'no localizó'],
    ['vigilancia', { state: 'Formato rechazado' }, 'ambar', 'PacoSAT preguntó mal al SAT'],
    ['vigilancia', { error: 'HTTP 500 del servicio' }, 'ambar', 'No se pudo preguntar'],
    ['vigilancia', {}, 'gris', 'aún no se revisa'],
    /* Motores de documentos: la clase manda, nunca el código. */
    ['satdoc', { kind: 'portal-caido', error: 'socket roto' }, 'ambar', 'no respondió'],
    ['satdoc', { kind: 'paso-interactivo', error: 'El portal pide...' }, 'ambar', 'cambió su página'],
    ['satdoc', { kind: 'navegador-no-disponible' }, 'ambar', 'Falta una pieza'],
    ['satdoc', { kind: 'documento-invalido' }, 'ambar', 'no era un PDF válido'],
    ['decl', { kind: 'respuesta-inesperada' }, 'ambar', 'no esperaba'],
    /* CIEC. */
    ['ciec', { kind: 'credenciales' }, 'ambar', 'no aceptó la contraseña CIEC'],
    ['ciec', { kind: 'captcha-sin-respuesta' }, 'gris', 'esperó el captcha'],
    ['ciec', { kind: 'sin-ciec' }, 'ambar', 'Falta guardar la contraseña CIEC'],
    ['ciec', { ok: true, found: 10, downloaded: 4 }, 'ambar', 'incompleta'],
    /* Bandeja, descargas masivas y revisión manual. */
    ['bandeja', { failed: 2 }, 'ambar', 'no se importaron'],
    ['bandeja', { error: 'ENOENT' }, 'ambar', 'no se pudo leer'],
    ['descarga', { status: 'expired' }, 'gris', 'venció'],
    ['descarga', { status: 'failed' }, 'ambar', 'falló'],
    ['revision', { error: 'El servicio local no respondió.' }, 'ambar', 'se detuvo'],
    /* Salud del sistema. */
    ['salud', { id: 'db', state: 'mal' }, 'rojo', 'no puede guardar'],
    ['salud', { id: 'disco', state: 'mal', dato: '1 GB libres' }, 'rojo', 'poco espacio'],
    ['salud', { id: 'respaldo', state: 'mal', dato: 'falló' }, 'ambar', 'respaldo falló'],
    ['salud', { id: 'documentos', state: 'vigilar' }, 'ambar', 'falló'],
    ['salud', { id: 'listados', state: 'vigilar' }, 'gris', 'sin actualizarse'],
    ['salud', { id: 'correo', state: 'vigilar', dato: 'Sin configurar' }, 'ambar', 'correo de avisos'],
    ['salud', { id: 'documentos', state: 'vigilar', dato: 'Aún no se ha descargado ninguno.' }, 'gris', 'Todavía no']
  ];
  for (const [source, info, level, fragmento] of casos) {
    const spec = problemSpec(source, info);
    assert.equal(spec.level, level, source + '/' + JSON.stringify(info) + ' → semáforo ' + level);
    assert.ok(spec.titulo.includes(fragmento), 'titular de ' + source + ': «' + spec.titulo + '» lleva «' + fragmento + '»');
    assert.ok(spec.significa.length > 20, 'qué significa (de ' + source + ')');
    assert.ok(spec.ahora.length > 10, 'qué pasa ahora (de ' + source + ')');
    /* El código crudo nunca es el protagonista del titular. */
    assert.ok(!/N-60\d|HTTP \d{3}|5002/.test(spec.titulo), 'sin código crudo en el titular: ' + spec.titulo);
  }
  /* Las acciones únicas que la superficie convierte en botón. */
  assert.equal(problemSpec('satdoc', { kind: 'paso-interactivo' }).accion, 'subir-doc');
  assert.equal(problemSpec('ciec', { kind: 'credenciales' }).accion, 'cambiar-ciec');
  assert.equal(problemSpec('ciec', { kind: 'sin-ciec' }).accion, 'guardar-ciec');
  assert.equal(problemSpec('revision', { error: 'x' }).accion, 'revisar');
  /* La incompleta de CIEC dice cuántas de cuántas bajaron. */
  const incompleta = problemSpec('ciec', { ok: true, found: 10, downloaded: 4 });
  assert.ok(incompleta.significa.includes('4 de 10'), 'la incompleta cuenta 4 de 10');
  /* El detalle técnico viaja aparte, nunca en el titular. */
  const conDetalle = problemSpec('satdoc', { kind: 'portal-caido', error: 'Error N-601 interno' });
  assert.equal(conDetalle.detalle, 'Error N-601 interno');
  assert.ok(!conDetalle.titulo.includes('N-601'));
  console.log('OK 1.13.0: modelo único — cada estado con su semáforo, su titular sin código crudo, su significado y su gesto.');
}

/* ===== 2 · Fases visuales de una corrida ===== */
{
  const SATDOC = [
    { label: 'Conectar con el SAT', match: ['Conectando'] },
    { label: 'Firmar con tu e.firma', match: ['Firmando'] },
    { label: 'Pedir el documento', match: ['Pidiendo'] },
    { label: 'Guardar en Expedientes', match: ['Guardando', 'Guardado en Expedientes'] }];
  const paso = text => ({ text });
  /* La forma EXACTA de la corrida real caída de la constancia
     (10 nov 2026): conectó, firmó y murió pidiendo el documento. */
  const caida = runPhaseStates(SATDOC, [paso('Conectando con el SAT…'), paso('Firmando con tu e.firma…'),
    paso('Pidiendo la constancia…')], 'failed');
  assert.deepEqual(caida.map(f => f.state), ['done', 'done', 'failed', 'pending']);
  /* En curso: la última fase alcanzada es la actual. */
  const enCurso = runPhaseStates(SATDOC, [paso('Conectando con el SAT…')], 'running');
  assert.deepEqual(enCurso.map(f => f.state), ['current', 'pending', 'pending', 'pending']);
  /* Terminada bien: todas hechas, aunque una fase no dejara paso. */
  const buena = runPhaseStates(SATDOC, [paso('Conectando con el SAT…'), paso('Firmando con tu e.firma…'),
    paso('Pidiendo la opinión de cumplimiento…'), paso('Guardando en Expedientes…')], 'ok');
  assert.deepEqual(buena.map(f => f.state), ['done', 'done', 'done', 'done']);
  /* CIEC: el aviso «⚠» marca su fase sin cambiarle el estado. */
  const CIEC = [
    { label: 'Entrar al portal', match: ['Conectando con el portal', 'Tecleando tu RFC', 'Ya estás dentro'] },
    { label: 'Escribir el captcha', match: ['pide el captcha', 'no aceptó ese captcha'] },
    { label: 'Consultar tus facturas', match: ['Buscando tus facturas'] },
    { label: 'Descargar las facturas', match: ['Descargando tus facturas'] },
    { label: 'Guardar en tu expediente', match: ['Guardando en tu expediente'] }];
  const captcha = runPhaseStates(CIEC, [paso('Conectando con el portal del SAT…'),
    paso('Tecleando tu RFC y tu contraseña…'), paso('⚠ El portal no aceptó ese captcha. Intento 1 de 3…')], 'failed');
  assert.deepEqual(captcha.map(f => f.state), ['done', 'failed', 'pending', 'pending', 'pending']);
  assert.equal(captcha[1].warn, true, 'el aviso queda marcado en su fase');
  console.log('OK 1.13.0: fases de corrida — hecho / en curso / falló aquí, con el aviso en su fase.');
}

/* ===== 3 · Superficie: centro de mando, salud, interruptor ===== */
{
  const problemas = readFileSync(new URL('./problemas-ui.part', import.meta.url), 'utf8');
  const html = readFileSync(new URL('./Faro-Fiscal.html', import.meta.url), 'utf8');
  for (const texto of ['Centro de mando', 'Salud del sistema', 'function problemCard', 'function commandCenter', 'function healthCard'])
    assert.ok(html.includes(texto), 'el artefacto lleva «' + texto + '»');
  /* La cuenta de toques de las operaciones frecuentes, fijada:
     ANTES se midió recorriendo la 1.12.0 desde Hoy (SAT + pestaña
     + botón; Dinero + pestaña + mes + armar; Expedientes + buscar
     + ver…); DESPUÉS es lo que el Centro de mando ejecuta o deja
     a un toque, con el contexto (RFC y mes) ya puesto. */
  const TOQUES = {
    /* 1.18.0: constancia y opinión son DOS tarjetas en Hoy, cada
       una con su Renovar de un toque (satQuickRunDoc, que llama a
       satdocs/run con su kind): el gesto sigue siendo 1. */
    'descargar constancia y opinión': { antes: 3, despues: 1, cable: 'satQuickRunDoc(kind' },
    'descargar por CIEC': { antes: 3, despues: 1, cable: "satApi('ciec/run'" },
    'lanzar declaraciones': { antes: 3, despues: 2, cable: "navigate('docs')" },
    'revisar CFDI': { antes: 3, despues: 1, cable: 'monitorCheckNow()' },
    'armar los pagos del mes': { antes: 3, despues: 2, cable: "navigate('pagos')" },
    'ver el último documento': { antes: 3, despues: 1, cable: 'viewDocOnline(ultimoDoc)' },
    'revisar la bandeja': { antes: 2, despues: 1, cable: "navigate('operations')" }
  };
  for (const [operacion, datos] of Object.entries(TOQUES)) {
    assert.ok(datos.despues <= 2, operacion + ': como mucho dos toques desde Hoy');
    assert.ok(datos.despues < datos.antes, operacion + ': menos toques que en la 1.12.0');
    assert.ok(problemas.includes(datos.cable), 'el Centro de mando ejecuta «' + operacion + '» (' + datos.cable + ')');
  }
  /* El mes de Pagos llega puesto desde el panel. */
  assert.ok(problemas.includes('pagosMes = mesClave'), 'el panel pone el mes antes de navegar a Pagos');
  /* El interruptor de Ajustes y su nota sin dirección. */
  const satUi = readFileSync(new URL('./sat-ui.part', import.meta.url), 'utf8');
  assert.ok(satUi.includes('Avisos importantes por correo'), 'la tarjeta del interruptor existe en Ajustes › Correo');
  assert.ok(satUi.includes("satApi('mail/alerts'"), 'el interruptor guarda por su ruta');
  assert.ok(satUi.includes('Sin dirección de avisos configurada estos avisos no salen'), 'la tarjeta avisa cuando no hay dirección');
  console.log('OK 1.13.0: Centro de mando cableado y cuenta de toques fijada (todas las operaciones en 1–2 toques).');
}

/* Arnés de servicio completo, como las suites hermanas. */
const ORIGIN = 'http://127.0.0.1:43741';
function harness(service) {
  let token;
  const call = async (path, data) => {
    const headers = { host: new URL(ORIGIN).host, origin: ORIGIN, 'x-pacosat-token': token };
    const req = Object.assign(Readable.from(data === undefined ? [] : [Buffer.from(JSON.stringify(data))]), {
      url: path, method: data === undefined ? 'GET' : 'POST', headers });
    let response;
    const res = { setHeader() {}, writeHead(status) { this.status = status; this.headersSent = true; },
      end(content) { response = new Response(content, { status: this.status }); } };
    await service.handle(req, res);
    return response;
  };
  return { call, boot: async () => { token = (await (await call('/')).text()).split('content="')[1].split('"')[0]; } };
}
const waitFor = async (probe, label) => {
  for (let i = 0; i < 250; i++) { const value = await probe(); if (value) return value; await new Promise(r => setTimeout(r, 20)); }
  throw new Error('No llegó: ' + label);
};

/* ===== 4 · Salud del sistema por el endpoint ===== */
{
  const service = createPacoSATService({ dbFile: ':memory:', html: '<!--PACOSAT_TOKEN-->', origin: ORIGIN });
  const { call, boot } = harness(service);
  try {
    await boot();
    const status = await (await call('/api/status')).json();
    assert.ok(status.health, 'el estado trae la salud del sistema');
    assert.equal(status.health.checks.length, 8, 'ocho comprobaciones');
    const porId = Object.fromEntries(status.health.checks.map(check => [check.id, check]));
    assert.equal(porId.db.state, 'bien', 'la base de datos lee y escribe');
    assert.ok(porId.disco.dato.includes('GB libres'), 'el disco dice cuánto queda');
    assert.equal(porId.bandeja.state, 'vigilar', 'sin bandeja configurada: a vigilar, no «mal»');
    assert.equal(status.health.level, 'vigilar', 'el resumen es el peor estado');
    /* Con la carpeta de la bandeja inexistente, la salud es «mal». */
    const service2 = createPacoSATService({ dbFile: ':memory:', html: '<!--PACOSAT_TOKEN-->', origin: ORIGIN,
      watchDir: '/no-existe-esta-carpeta-1130' });
    const h2 = harness(service2);
    await h2.boot();
    const status2 = await (await h2.call('/api/status')).json();
    const bandeja2 = status2.health.checks.find(check => check.id === 'bandeja');
    assert.equal(bandeja2.state, 'mal', 'bandeja configurada pero carpeta ausente: mal');
    assert.equal(status2.health.level, 'mal', 'un «mal» manda en el semáforo general');
    await service2.close();
  } finally { await service.close(); }
  console.log('OK 1.13.0: salud del sistema — ocho chequeos con estado y dato, y el semáforo general = el peor.');
}

/* ===== 5 y 6 · Correos de evento y errorKind de las corridas ===== */
{
  const RFC = 'MFI6212158B4';
  let time = Date.parse('2026-11-10T15:00:00Z');
  const sent = [];
  const UUID_CANCELADO = 'AAAAAAAA-0000-4000-8000-0000000000C1';
  const service = createPacoSATService({ dbFile: ':memory:', html: '<!--PACOSAT_TOKEN-->', origin: ORIGIN,
    now: () => time, efirmaDir: mkdtempSync(join(tmpdir(), 'pacosat-1130-')),
    makeConnector: async ({ password }) => {
      if (password !== 'buena-efirma') throw new Error('La contraseña no abre la llave.');
      return { parser: class {}, connector: {} };
    },
    makeMailer: () => ({ verify: async () => true, sendMail: async payload => { sent.push(payload); } }),
    monitorOptions: { checkSat: async () => ({ state: 'Cancelado', code: 'S', cancellation: '', cancelable: '', efos: '' }) },
    satDocFetch: async () => {
      throw Object.assign(new Error('El portal enseñó una pantalla que PacoSAT no conoce.'), { code: 'paso-interactivo' });
    },
    satDeclFetch: async () => {
      throw Object.assign(new Error('Respuesta rara del portal.'), { code: 'respuesta-inesperada' });
    },
    satCiecFetch: async () => {
      throw Object.assign(new Error('La contraseña proporcionada no es correcta.'), { code: 'credenciales' });
    } });
  const { call, boot } = harness(service);
  try {
    await boot();
    /* Sin correo configurado: el interruptor nace activado pero
       no sale nada (la tarjeta de Ajustes lo explica). */
    let status = await (await call('/api/status')).json();
    assert.equal(status.mail.enabled, false);
    assert.equal(status.mail.alerts, true, 'el interruptor nace activado por defecto');
    /* Perfil con e.firma y un CFDI vigilado. */
    let res = await call('/api/efirma', { rfc: RFC, certificate: CER, key: KEY, password: 'buena-efirma', minutes: 360, days: 30, direction: 'received' });
    assert.equal(res.status, 200);
    res = await call('/api/monitor', { records: [{ id: UUID_CANCELADO, emitter: 'AAA010101AAA', receiver: RFC, total: '116.00', seal: '+/abcd==' }], ids: [] });
    assert.equal(res.status, 200);
    await service.monitorTick(time);
    await service.tick();
    assert.equal(sent.length, 0, 'sin dirección configurada no sale ningún correo');

    /* Con correo (regla 1.13.1, pieza G): este CFDI se consultó por
       PRIMERA vez y ya venía Cancelado — es un DESCUBRIMIENTO, no
       una transición: NO sale correo individual; sale solo el
       resumen «al ponerte al día» con su fila, una vez al día. El
       individual con el modelo completo queda para la transición
       Vigente → Cancelado, cubierta en ronda1131. */
    res = await call('/api/mail', { host: 'smtp.example.com', port: 587, user: 'u', password: 'p', from: 'from@example.com', recipient: 'avisos@example.com' });
    assert.equal(res.status, 200);
    await service.tick();
    const individuales = sent.filter(mail => String(mail.subject).includes('CFDI cancelado') && !String(mail.subject).includes('ponerte'));
    assert.equal(individuales.length, 0, 'un primer descubrimiento NO genera correo individual (1.13.1)');
    const resumenes = sent.filter(mail => String(mail.subject).includes('Al ponerte al día'));
    assert.equal(resumenes.length, 1, 'el descubrimiento entra en UN resumen, no suelto');
    assert.equal(resumenes[0].to, 'avisos@example.com');
    assert.ok(resumenes[0].text.includes(UUID_CANCELADO), 'el resumen nombra el comprobante descubierto');
    assert.ok(!/CIEC|e\.firma.*contraseña de/i.test(resumenes[0].text), 'el correo no lleva credenciales');
    await service.tick();
    assert.equal(sent.filter(mail => String(mail.subject).includes('Al ponerte al día')).length, 1,
      'el resumen no se repite en el mismo día');

    /* La descarga de documentos que termina mal: errorKind en la
       corrida y en el último fallo, y su correo tras el ciclo. */
    res = await call('/api/satdocs/run', { rfc: RFC, kind: 'constancia' });
    assert.equal(res.status, 200);
    const runView = (await res.json()).profiles[0];
    const corrida = runView.runs.find(run => !run.ok);
    assert.ok(corrida, 'la corrida caída quedó en el diario');
    assert.equal(corrida.errorKind, 'paso-interactivo', 'la corrida expone su clase de fallo');
    assert.equal(runView.lastFailure.kind, 'paso-interactivo', 'la tarjeta conoce la clase del último fallo');
    await service.tick();
    const deDoc = sent.filter(mail => String(mail.subject).includes('No se pudo descargar'));
    assert.equal(deDoc.length, 1, 'un correo por la descarga de documentos fallida');
    assert.ok(deDoc[0].text.includes('Qué hacer:'), 'también con el modelo');

    /* Salud tras el fallo: el chequeo de documentos lo refleja. */
    status = await (await call('/api/status')).json();
    const docCheck = status.health.checks.find(check => check.id === 'documentos');
    assert.equal(docCheck.state, 'vigilar', 'la salud marca la última descarga fallida');

    /* Declaraciones: el último error lleva su clase. */
    res = await call('/api/declaraciones/run', { rfc: RFC, ejercicio: 2026, tipo: 'mensual' });
    assert.equal(res.status, 200);
    const declView = await (await call('/api/declaraciones?rfc=' + RFC + '&ejercicio=2026')).json();
    assert.equal(declView.lastError.kind, 'respuesta-inesperada', 'declaraciones expone la clase de su último error');

    /* Interruptor apagado: ni un correo más, ni del mismo evento
       repetido ni de eventos nuevos del mismo tipo. */
    res = await call('/api/mail/alerts', { enabled: false });
    assert.equal(res.status, 200);
    status = await (await call('/api/status')).json();
    assert.equal(status.mail.alerts, false, 'el interruptor quedó apagado');
    const UUID2 = 'AAAAAAAA-0000-4000-8000-0000000000C2';
    res = await call('/api/monitor', { records: [{ id: UUID2, emitter: 'AAA010101AAA', receiver: RFC, total: '232.00', seal: '+/abcd==' }], ids: [] });
    assert.equal(res.status, 200);
    await service.monitorTick(time);
    const antes = sent.length;
    await service.tick();
    assert.equal(sent.length, antes, 'con el interruptor apagado no sale ningún correo de evento');
  } finally { await service.close(); }
  console.log('OK 1.13.0: correos de evento — uno por suceso con el modelo, sin duplicar, y cero con el interruptor apagado o sin dirección.');
}

/* ===== 6b · CIEC: la corrida caída expone su clase ===== */
{
  const RFC2 = 'XAXX010101000';
  /* Modo nube, como la suite CIEC hermana: la semilla de
     contribuyentes entra por /api/storage, que solo existe así. */
  const service = createPacoSATService({ dbFile: ':memory:', html: '<!--PACOSAT_TOKEN-->', origin: ORIGIN,
    proxyKey: 'd'.repeat(64),
    efirmaDir: mkdtempSync(join(tmpdir(), 'pacosat-1130-ciec-')),
    makeConnector: async () => ({ parser: class {}, connector: {} }),
    satCiecFetch: async () => {
      throw Object.assign(new Error('La contraseña proporcionada no es correcta.'), { code: 'credenciales' });
    } });
  let tokenC;
  const call = async (path, data) => {
    const headers = { host: new URL(ORIGIN).host, origin: ORIGIN, 'x-pacosat-token': tokenC,
      'x-pacosat-proxy': 'd'.repeat(64) };
    const req = Object.assign(Readable.from(data === undefined ? [] : [Buffer.from(JSON.stringify(data))]), {
      url: path, method: data === undefined ? 'GET' : 'POST', headers });
    let response;
    const res = { setHeader() {}, writeHead(status) { this.status = status; this.headersSent = true; },
      end(content) { response = new Response(content, { status: this.status }); } };
    await service.handle(req, res);
    return response;
  };
  const boot = async () => { tokenC = (await (await call('/')).text()).split('content="')[1].split('"')[0]; };
  try {
    await boot();
    let res = await call('/api/storage', { batch: { people: [{ id: RFC2, name: 'Contribuyente CIEC' }] } });
    assert.equal(res.status, 200);
    res = await call('/api/ciec', { rfc: RFC2, ciec: 'la-que-sea', minutes: 360, days: 7, direction: 'both' });
    assert.equal(res.status, 200);
    res = await call('/api/ciec/run', { rfc: RFC2, start: '2026-11-04', end: '2026-11-10', direction: 'both' });
    assert.equal(res.status, 200);
    const vista = await waitFor(async () => {
      const data = await (await call('/api/ciec')).json();
      const profile = data.profiles.find(row => row.rfc === RFC2);
      return profile?.progress && !profile.progress.running && profile.runs?.length ? profile : null;
    }, 'la corrida CIEC caída');
    assert.equal(vista.progress.ok, false);
    assert.equal(vista.runs[0].errorKind, 'credenciales', 'la corrida CIEC expone su clase de fallo');
  } finally { await service.close(); }
  console.log('OK 1.13.0: errorKind expuesto también en las corridas CIEC.');
}
console.log('ronda1130.test: ok');
