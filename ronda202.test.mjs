import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { createPacoSATService } from './local-server.mjs';

/* ================================================================
   Ronda 2.0.2 — dos frentes, una sola entrega:
   A) El Buzón Tributario y Declaraciones recuperan su entrada
      PROPIA en el menú (Paco los buscó en su iPhone con la 2.0.1
      y no estaban: vivían como tarjetas dentro de Hoy; su regla
      permanente: lo necesario no se esconde). Cada entrada
      enseña su estado en una línea, pintado al cargar/refrescar
      con el RFC en curso desde las fuentes que ya existen
      (tribOverview del servidor y el diario GET
      /api/declaraciones/runs) — sin endpoints ni conteos nuevos.
   B) El «Origen inválido» vivo: la guarda de los POST exigía
      Origin === origen configurado y, entrando por otra
      dirección legítima de la casa, la app cargaba pero ningún
      botón funcionaba. Ahora manda el mismo origen REAL del
      request (configurado o derivado de la propia petición);
      el Origin ajeno se sigue rechazando, con mensaje llano y
      constancia en el Registro.
   Todo lo de esta suite puede fallar de verdad: el menú se
   cuenta destino a destino, los textos de estado se juzgan
   ejecutando las funciones puras con vistas hechas con los
   campos reales, y el origen se juzga contra el servidor real
   en los dos sentidos.
   ================================================================ */

const ROOT = dirname(fileURLToPath(import.meta.url));
const read = name => readFileSync(join(ROOT, name), 'utf8');

/* ---------- A1 · El menú: sus destinos, en su orden ---------- */
{
  const layout = read('layout.part');
  const nav = layout.match(/<nav aria-label="Navegación principal">([\s\S]*?)<\/nav>/)?.[1] || '';
  const navDestinos = nav.replace(/<div id="nav-jobs"[\s\S]*?<\/div>/, '');
  const views = [...navDestinos.matchAll(/data-view="([a-z]+)"/g)].map(m => m[1]);
  /* RE-BASE integración 2.4.0 (W4d): la barra de navegación
     creció a 22 destinos con rótulos y descripciones (cada
     botón lleva title y su punto de puerta); el pin de 11
     destinos de la 2.0.2 quedó superado. Se re-pina la lista
     EXACTA de hoy y los literales EXACTOS de los dos botones —
     Buzón y Declaraciones siguen siendo entradas propias con
     su icono y su span de estado, que es lo que esta suite
     nació para fijar. */
  /* RE-BASE 2.8.0 (diseño 3): «Descargados del SAT» (coverage)
     se funde en «Descargar del SAT» — la casa única de
     descargas — y su destino sale del menú: 21 destinos. */
  /* RE-BASE 2.9.15 (Bloque B6): el menú se reagrupa por tarea
     (Expediente, SAT, Bancos, Documentos, Ajustes) y el orden
     cambia con los grupos; Buzón y Declaraciones siguen como
     entradas propias, que es lo que esta aserción nació para
     fijar. La lista exacta se re-pina con la misma fuerza. */
  assert.deepEqual(views, ['home', 'avisos', 'buzon', 'contribuyentes', 'invoices', 'archivo',
    'registro', 'descargar', 'tributario', 'monitor', 'lists', 'ejecutor', 'dinero',
    'pagos', 'reportes', 'salidas', 'docs', 'declaraciones', 'salud',
    'preguntas', 'settings'],
    'el menú trae Buzón y Declaraciones como entradas propias (2.0.2; barra de 21 destinos reagrupados por tarea en la 2.9.15)');
  /* RE-BASE 2.8.0 (diseño 19): «Buzón» pasa a llamarse «Buzón
     del SAT» — «Recibidos» (hoy «Novedades») y «Buzón» se
     pisaban — y su title dice la misma verdad con las palabras
     nuevas. Se re-pina el literal EXACTO nuevo. */
  /* RE-BASE 2.9.0: la auditoría viva ordenó retirar los puntos
     decorativos del menú (nav-dot240: grises idénticos sin
     leyenda, no afirmaban estado) y el Bloque C los retiró de
     todos los destinos. Se re-pinan los literales EXACTOS sin
     el span del punto, conservando icono + span de estado
     (buzon-menu-estado202 / decl-menu-estado202), que es lo
     que esta suite nació para fijar. */
  assert.ok(layout.includes('<button data-view="tributario" title="Buzón del SAT — Las notificaciones del SAT para este RFC, sin abrir ninguna: PacoSAT las lista por ti"><svg><use href="#i-buzontrib"/></svg> Buzón del SAT ' +
    '<span id="buzon-menu-estado202" class="nav-estado201"></span></button>'),
    'la entrada del Buzón del SAT lleva su icono y su span de estado');
  assert.ok(layout.includes('<button data-view="declaraciones" title="Declaraciones — El mapa de tus declaraciones por año y mes: qué consta, qué falta y cómo se descarga"><svg><use href="#i-decl"/></svg> Declaraciones ' +
    '<span id="decl-menu-estado202" class="nav-estado201"></span></button>'),
    'la entrada de Declaraciones lleva su icono y su span de estado');
  assert.ok(layout.includes('id="lists-menu-estado201"'), 'Listas conserva su estado en la entrada');
  /* La barra inferior móvil no cambia: «Más» abre ESTE menú. */
  const bottom = layout.slice(layout.indexOf('bottombar'));
  assert.ok(bottom.includes('id="more-button"'), 'la barra móvil conserva su «Más»');
  console.log('OK 2.0.2 · A1 — menú de 22 destinos (W4d) con Buzón y Declaraciones propios y sus spans de estado.');
}

/* ---------- A2 · El enrutado: data-view abre su pantalla ---------- */
{
  const html = read('Faro-Fiscal.html');
  const ui = read('ui.part');
  assert.ok(html.includes("tributario: ['Buzón del SAT'"), 'la ficha del Buzón del SAT consta en el mapa de pantallas (2.8.0 · diseño 19)');
  assert.ok(html.includes("declaraciones: ['Declaraciones'"), 'la ficha de Declaraciones consta en el mapa');
  assert.ok(html.includes('tributario: tributarioScreen'), 'tributario se resuelve a su pantalla en el render');
  assert.ok(html.includes('declaraciones: declaracionesScreen'), 'declaraciones se resuelve a su pantalla en el render');
  assert.ok(ui.includes('refrescarEstadosMenu202();'), 'render() refresca los estados del menú en cada pintado');
  assert.ok(ui.includes('pintarBuzonMenu202()') && ui.includes('pintarDeclMenu202()'),
    'el refresco pinta ambos estados sin abrir sus vistas');
  console.log('OK 2.0.2 · A2 — data-view enruta a tributario/declaraciones y el menú se pinta al refrescar.');
}

/* ---------- A3 · Los textos de estado salen de los campos reales ---------- */
{
  /* RE-BASE 2.9.0 (Bloque D, diferimiento del Buzón): el estado
     del Buzón (MESES_MENU202 → pintarBuzonMenu202) vive hoy en
     el PUENTE de ui.part — es ayuda del primer pintado del
     menú — y la pantalla viaja en la parte diferida 'buzon'.
     El segmento se extrae de su casa nueva; las aserciones
     sobre los textos no cambian ni en número ni en fuerza. */
  const trib = read('ui.part');
  const decl = read('declaraciones-ui.part');
  const ctx = vm.createContext({ Date, Number, String });
  vm.runInContext(trib.slice(trib.indexOf('const MESES_MENU202'),
    trib.indexOf('async function pintarBuzonMenu202')), ctx);
  vm.runInContext(decl.slice(decl.indexOf('function declMenuTexto202'),
    decl.indexOf('async function pintarDeclMenu202')), ctx);
  const ts = new Date(new Date().getFullYear(), 10, 16, 10, 30).getTime(); // 16 nov, año en curso
  /* Buzón (campos de tribOverview: sinAbrir, comunicadosNoLeidos,
     comunicadosFecha, ultimaConsulta, total). */
  assert.equal(ctx.buzonMenuTexto202({ sinAbrir: 3, comunicadosNoLeidos: 2, comunicadosFecha: ts, ultimaConsulta: ts, total: 5 }),
    '3 sin abrir', 'Buzón: lo sin abrir manda sobre lo demás');
  assert.equal(ctx.buzonMenuTexto202({ sinAbrir: 0, comunicadosNoLeidos: 2, comunicadosFecha: ts, ultimaConsulta: ts, total: 5 }),
    '2 comunicados sin leer · 16 nov', 'Buzón: comunicados sin leer con la fecha de la última consulta buena');
  assert.equal(ctx.buzonMenuTexto202({ sinAbrir: 0, comunicadosNoLeidos: 0, comunicadosFecha: ts, ultimaConsulta: ts, total: 5 }),
    'Sin pendientes · 16 nov', 'Buzón: sin pendientes, con la fecha de la última consulta');
  assert.equal(ctx.buzonMenuTexto202({ sinAbrir: 0, comunicadosNoLeidos: null, comunicadosFecha: 0, ultimaConsulta: null, total: 0 }),
    'Sin consultar todavía', 'Buzón: nunca consultado se dice, no se inventa');
  assert.equal(ctx.buzonMenuTexto202(null), 'Sin consultar todavía');
  /* Declaraciones (campos del diario: runs[].started, runs[].ok). */
  assert.equal(ctx.declMenuTexto202([]), 'Sin bajar todavía', 'Declaraciones: sin corridas se dice');
  assert.equal(ctx.declMenuTexto202([{ started: ts, ok: true }]), 'Última bajada: 16 nov',
    'Declaraciones: la última bajada buena, con su fecha');
  assert.equal(ctx.declMenuTexto202([{ started: ts, ok: false }]), 'Último intento: 16 nov · no se pudo',
    'Declaraciones: una corrida fallida no se disfraza de bajada');
  /* Las fuentes son las de siempre: sin endpoints nuevos. */
  assert.ok(trib.includes("satApi('tributario?rfc=' + encodeURIComponent(scope))"),
    'el estado del Buzón se lee de la misma vista que su pantalla');
  assert.ok(decl.includes("satApi('declaraciones/runs?rfc=' + encodeURIComponent(scope))"),
    'el estado de Declaraciones se lee del mismo diario que su pantalla');
  console.log('OK 2.0.2 · A3 — textos de estado del menú desde tribOverview y el diario de corridas, sin inventar.');
}

/* ---------- B · El origen: mismo origen real, en los dos sentidos ---------- */
const ORIGIN = 'https://pacosat.test';
const KEY = 'e'.repeat(64);
function harness(service) {
  let token = '';
  const raw = async (method, path, body, extraHeaders = {}) => {
    const chunks = []; if (body !== undefined) chunks.push(Buffer.from(JSON.stringify(body)));
    const req = Readable.from(chunks);
    req.method = method; req.url = path;
    req.headers = { host: 'pacosat.test', origin: ORIGIN, 'x-pacosat-proxy': KEY, ...extraHeaders };
    let status = 0; const headers = {}; let text = '';
    const res = { writeHead(code) { status = code; }, setHeader(k, v) { headers[k] = v; },
      getHeader(k) { return headers[k]; },
      end(chunk) { if (chunk) text += Buffer.isBuffer(chunk) ? chunk.toString('latin1') : chunk; } };
    await service.handle(req, res);
    return { status, text, headers };
  };
  const call = async (method, path, body, extraHeaders = {}) => {
    if (!token) { const home = await raw('GET', '/'); token = /[0-9a-f]{64}/.exec(home.text)?.[0] || ''; }
    const r = await raw(method, path, body, { 'x-pacosat-token': token, ...extraHeaders });
    let json = null; try { json = JSON.parse(r.text); } catch { /* binario */ }
    return { status: r.status, json, text: r.text };
  };
  return { raw, call };
}
const makeService = (options = {}) => {
  const service = createPacoSATService({
    dbFile: ':memory:', html: '<html><head><!--PACOSAT_TOKEN--></head><body>prueba</body></html>',
    origin: ORIGIN, proxyKey: KEY, satDocRetryWaitMs: 5,
    makeMailer: () => ({ verify: async () => true, sendMail: async () => ({ messageId: 'm1' }) }),
    ...options });
  return { service, ...harness(service) };
};
{
  const server = read('local-server.mjs');
  assert.ok(!server.includes("req.headers.origin === origin"), 'fuera la igualdad estricta con el origen configurado');
  assert.ok((server.match(/exigirOrigen202\(req\);/g) || []).length >= 10,
    'el helper único guarda todos los sitios de los POST (los 10 que exigían la igualdad)');
  assert.ok(server.includes('function origenAceptado202(req)'), 'el helper de mismo origen real existe');

  const h = makeService();
  /* (a) Origin derivado del propio request (http sin s, mismo
     host): distinto del configurado (https) y ACEPTADO — en la
     puerta genérica de los POST y en un sitio propio (logout). */
  const a1 = await h.call('POST', '/api/mail/alerts', { enabled: true }, { origin: 'http://pacosat.test' });
  assert.equal(a1.status, 200, 'POST con el origen derivado del request (http) no es 403: ' + a1.text.slice(0, 200));
  const a2 = await h.call('POST', '/api/admin/logout', undefined, { origin: 'http://pacosat.test' });
  assert.equal(a2.status, 200, 'el sitio propio de logout acepta el origen derivado: ' + a2.text.slice(0, 200));
  /* (b) Origin de otro sitio: 403 con el mensaje llano. */
  const b = await h.call('POST', '/api/mail/alerts', { enabled: true }, { origin: 'https://otro-sitio.example' });
  assert.equal(b.status, 403, 'un Origin ajeno se sigue rechazando');
  assert.equal(b.json?.error, 'Estás en una dirección distinta de la registrada de la app; ábrela desde pacosat.test.',
    'el rechazo se dice en llano, con la dirección registrada (la del origen configurado)');
  assert.ok(!String(b.json?.error || '').includes('Origen inválido'), 'nunca más «Origen inválido.» a secas');
  /* (c) El rechazo deja constancia en el Registro. */
  const reg = await h.call('GET', '/api/registro?limit=300');
  assert.equal(reg.status, 200);
  assert.ok(reg.text.includes('Origen rechazado') && reg.text.includes('https://otro-sitio.example') &&
    reg.text.includes('/api/mail/alerts'),
    'el Registro guarda el rechazo con el origen recibido y la ruta pedida');
  h.service.close();
  console.log('OK 2.0.2 · B1 — origen derivado aceptado; origen ajeno, 403 en llano y constancia en el Registro.');
}
{
  /* Tras el proxy: el esquema viene de X-Forwarded-Proto. El
     origen configurado es el interno (http) y el navegador llega
     por https: su Origin es el derivado (https + Host), no el
     configurado, y se acepta. */
  const h = makeService({ origin: 'http://pacosat.test' });
  const a = await h.call('POST', '/api/mail/alerts', { enabled: false },
    { origin: 'https://pacosat.test', 'x-forwarded-proto': 'https' });
  assert.equal(a.status, 200, 'tras el proxy, el Origin https derivado se acepta: ' + a.text.slice(0, 200));
  const b = await h.call('POST', '/api/mail/alerts', { enabled: false },
    { origin: 'https://pacosat.test' });
  assert.equal(b.status, 403, 'sin la cabecera del proxy, ese https no es el origen de este request y se rechaza');
  h.service.close();
  console.log('OK 2.0.2 · B2 — X-Forwarded-Proto manda en el esquema del origen derivado.');
}

/* ---------- Sellos de la versión ---------- */
{
  assert.equal(JSON.parse(read('package.json')).version, '2.9.15', 'la versión del paquete es 2.0.2');
  assert.ok(read('ejecutor-local.mjs').includes("EJECUTOR_VERSION = '2.9.15'"), 'el ejecutor declara 2.0.2 (solo el sello)');
  assert.ok(read('Faro-Fiscal.html').includes('"version":"2.9.15"'), 'el artefacto se sella 2.0.2');
  assert.ok(read('final-ui.part').includes("version: '2.9.15'"), 'la nota de novedades es la de esta versión');
  console.log('OK 2.0.2 · sellos — paquete, ejecutor, artefacto y novedades en 2.0.2.');
}
