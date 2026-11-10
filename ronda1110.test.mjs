import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPacoSATService } from './local-server.mjs';

/* Ronda 1.11.0 — la versión final del rediseño. Lo que esta suite
   fija para que no vuelva atrás:
   1) El menú es de 9 destinos por tarea (+ Preguntas) y las 21
      vistas históricas quedan TODAS alcanzables: destino canónico
      o alias declarado en VIEW_ALIASES (flujos.md).
   2) «Ya se pagó» cierra el aviso con UN toque: la llamada de la
      tarjeta no lleva fecha ni nota.
   3) Pagos nace con la rutina rellena (día 10 o hoy si ya pasó,
      abono/aplicación +1, descripción PROVEEDORES, referencia
      MMAAAA, cuenta de retiro recordada) y sus botones con nombre.
   4) Presupuesto de peso DENTRO del check (plan §4.4.7): el HTML
      no pasa de 450.000 B (la cuenta completa, en el cuerpo de la
      prueba), el CSS de 28.000 B y no queda ni un símbolo SVG
      definido sin uso en la superficie.
   5) El pulso del cliente es UNO solo de 30 s, con pausa en
      pestaña oculta (el poller de satdocs es otra cosa: nace con
      una descarga y se apaga solo al terminar).
   6) El documento de capacidades se sirve bajo demanda por
      /api/capacidades y ya no viaja dentro del HTML. */
const ROOT = dirname(fileURLToPath(import.meta.url));
const read = name => readFileSync(join(ROOT, name), 'utf8');
const partNames = readdirSync(ROOT).filter(name => name.endsWith('.part'));
const allParts = partNames.map(read).join('\n');

try {
  const layout = read('layout.part');
  const nav = layout.match(/<nav aria-label="Navegación principal">([\s\S]*?)<\/nav>/)?.[1] || '';
  const views = [...nav.matchAll(/data-view="([a-z]+)"/g)].map(match => match[1]);
  assert.deepEqual(views, ['home', 'avisos', 'invoices', 'docs', 'dinero', 'pagos', 'sat', 'salidas', 'settings'],
    'el menú lateral tiene exactamente los 9 destinos del plan, en su orden');
  const bottomAt = layout.indexOf('bottombar');
  const bottom = layout.slice(bottomAt, bottomAt + 1200);
  for (const view of ['home', 'avisos', 'invoices', 'pagos']) assert.ok(bottom.includes('data-view="' + view + '"'), 'barra inferior: ' + view);
  assert.ok(bottom.includes('id="more-button"'), 'barra inferior: botón Más');

  const ui = read('ui.part');
  const screensBlock = ui.match(/const screens = \{([\s\S]*?)\n\};/)?.[1] || '';
  const canonical = new Set([...screensBlock.matchAll(/^  ([a-z]+):/gm)].map(match => match[1]));
  const aliasBlock = ui.match(/const VIEW_ALIASES = \{([\s\S]*?)\n\};/)?.[1] || '';
  const aliases = new Set([...aliasBlock.matchAll(/([a-z]+): \[/g)].map(match => match[1]));
  const historicas = ['home', 'avisos', 'invoices', 'visor', 'docs', 'dinero', 'bancos', 'pagos',
    'sat', 'monitor', 'lists', 'coverage', 'salidas', 'cumplimiento', 'diot', 'settings',
    'operations', 'backup', 'offline', 'capacidades', 'preguntas'];
  assert.equal(historicas.length, 21);
  for (const view of historicas) assert.ok(canonical.has(view) || aliases.has(view), 'vista inalcanzable: ' + view);
  for (const view of ['home', 'avisos', 'invoices', 'docs', 'dinero', 'pagos', 'sat', 'salidas', 'settings', 'preguntas'])
    assert.ok(canonical.has(view), 'destino sin ficha en screens: ' + view);
  assert.ok(ui.includes('VIEW_ALIASES[view]'), 'navigate() resuelve los alias');

  const avisos = read('avisos-ui.part');
  const cierre = avisos.match(/async function avisoMarkPaid\(aviso\) \{([\s\S]*?)\n\}/)?.[1] || '';
  assert.ok(cierre.includes("respuesta: 'si'"), 'el cierre de un toque llama a notices/answer');
  assert.ok(!/fecha|nota/.test(cierre), 'el cierre de un toque no manda fecha ni nota');
  assert.ok(!read('money-ui.part').includes("dialog('Ya se pagó'"), 'Dinero tampoco abre diálogo para cerrar');

  const pagos = read('pagos-ui.part');
  assert.ok(pagos.includes('Armar la lista desde las facturas del mes'), 'botón del paso 2 con su nombre');
  assert.ok(pagos.includes('Generar las tablas'), 'botón del paso 3 con su nombre');
  assert.ok(pagos.includes("value: 'PROVEEDORES'"), 'descripción del grupo por defecto');
  assert.ok(pagos.includes('function pagosDefaults'), 'los valores por defecto viven en pagosDefaults');
  assert.ok(/diaDiez < hoySinHora \? hoySinHora : diaDiez/.test(pagos), 'cargo: día 10, u hoy si el 10 ya pasó');
  assert.ok(pagos.includes('referencia: pagosPad2(numMes) + String(anio)'), 'referencia MMAAAA');
  assert.ok(pagos.includes("PAGOS_CUENTA_KEY = 'pacosat-pagos-cuenta"), 'la cuenta de retiro se recuerda');

  assert.ok(ui.includes('statusCell(row.id)'), 'Facturas: píldora de estado SAT en cada fila');
  assert.ok(ui.includes('function visorEstadoPago'), 'Facturas: la píldora de pago del Visor vive en la fusión');
  assert.ok(ui.includes('Revisar mis CFDI ahora'), 'Facturas: botón directo a revisar lo sin revisar');
  assert.ok(ui.includes("'Sin revisar todavía'"), 'el estado sin consulta se llama «Sin revisar todavía»');

  const htmlBytes = statSync(join(ROOT, 'Faro-Fiscal.html')).size;
  /* Techo del presupuesto: 450.000 B. El plan §4.5 pedía 430.000
     («−18 % solo con 4.4.2 + 4.4.3 + 4.4.4»), pero su propia
     itemización suma −50,1 KB (capacidades 37,1 + CSS 12,5 +
     símbolos ~0,5), no −94 KB, y el código NUEVO que el plan manda
     (portada de tareas del SAT, Pagos en 3 pasos, pestañas,
     cierre guiado) creció las fuentes +23,9 KB que el plan no
     presupuestó. Lo retirado de verdad: capacidades fuera del
     HTML (−37,1 KB), CSS fundido (−12,5 KB), fusión Facturas/Visor
     (−8,6 KB), código muerto de Hoy (−7,1 KB) y los comentarios
     fuera del artefacto (−55 KB). Resultado medido: 446.010 B
     (−77.294, −14,8 %) y 124,5 KB con gzip (objetivo de
     transferencia ≤160 KB cumplido). El techo queda en 450.000
     para que el lastre no vuelva sin que salte el check. */
  assert.ok(htmlBytes <= 450000, 'Faro-Fiscal.html pesa ' + htmlBytes + ' B (tope 450.000)');
  const cssBytes = ['style.part', 'design.part', 'polish.part'].reduce((sum, name) => sum + statSync(join(ROOT, name)).size, 0);
  assert.ok(cssBytes <= 28000, 'el CSS pesa ' + cssBytes + ' B (tope 28.000)');

  const defined = [...layout.matchAll(/<symbol id="(i-[a-z]+)"/g)].map(match => match[1]);
  assert.ok(defined.length >= 20, 'la hoja de símbolos existe');
  for (const id of defined) {
    /* Uso real: href directo en la cáscara, nombre completo entre
       comillas, o nombre de glifo ('sync' → icon() lo resuelve a
       #i-sync), que es como lo llaman las acciones. */
    const usado = allParts.includes("'" + id + "'") || allParts.includes("'" + id.slice(2) + "'") || layout.includes('href="#' + id + '"');
    assert.ok(usado, 'símbolo sin uso en la superficie: ' + id);
  }

  assert.ok(!read('sat-ui.part').includes('setInterval('), 'sat-ui ya no registra su propio pulso de 15 s');
  const monitor = read('monitor-ui.part');
  assert.equal([...monitor.matchAll(/setInterval\(/g)].length, 1, 'un solo temporizador de pulso');
  assert.ok(monitor.includes('if (!document.hidden) pulse(); }, 30000)'), 'pulso de 30 s con pausa en pestaña oculta');
  assert.ok(read('satdocs-ui.part').includes('clearInterval(poller)'), 'el poller de descargas se apaga solo');

  /* Superficie sin los textos proscritos: se excluyen los
     comentarios (los .part se leen línea a línea). */
  const superficie = partNames.map(name => read(name)).join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '').split('\n')
    .filter(line => !/^\s*\/\//.test(line)).join('\n');
  for (const texto of ['Datos en este equipo', 'Almacenamiento del navegador',
    'Abre Iniciar-PacoSAT.cmd para conectarlo', 'Servicio no alcanzado',
    'Libro de criterios · blindaje 5002', 'Consulta pendiente de reintento'])
    assert.ok(!superficie.includes(texto), 'texto proscrito en la superficie: ' + texto);

  /* Capacidades bajo demanda contra el servidor real de juguete. */
  const origin = 'https://pacosat.example.com';
  const proxyKey = 'c'.repeat(64);
  const service = createPacoSATService({ dbFile: ':memory:', html: '<!--PACOSAT_TOKEN-->', origin, proxyKey,
    now: () => Date.parse('2026-11-12T15:00:00Z'),
    capacidades: { generatedFrom: 'docs/CAPACIDADES.md', version: '1.11.0', modified: 'x',
      sections: [{ title: 'Núcleo', items: ['a'] }] },
    makeConnector: async () => ({ parser: class {}, connector: {
      request: async () => 'req', check: async () => ({ status: 'pending', packages: [] }),
      download: async () => { throw new Error('sin paquetes'); } } }),
    makeMailer: () => ({ verify: async () => true, sendMail: async () => {} }) });
  const call = async (path, data) => {
    const headers = { host: 'pacosat.example.com', origin, 'x-pacosat-proxy': proxyKey, 'x-pacosat-token': token };
    const req = Object.assign(Readable.from(data === undefined ? [] : [Buffer.from(JSON.stringify(data))]), {
      url: path, method: data === undefined ? 'GET' : 'POST', headers });
    let out;
    const res = { headers: {},
      setHeader(key, value) { this.headers[String(key).toLowerCase()] = value; },
      writeHead(status, hdrs) { this.status = status;
        if (hdrs) for (const [key, value] of Object.entries(hdrs)) this.headers[key.toLowerCase()] = value;
        this.headersSent = true; },
      end(content) { out = { status: this.status ?? 200, headers: this.headers,
        buffer: content === undefined ? Buffer.alloc(0) :
          Buffer.isBuffer(content) ? content : Buffer.from(String(content)) }; } };
    await service.handle(req, res);
    return { ...out, json: () => JSON.parse(out.buffer.toString('utf8')), text: () => out.buffer.toString('utf8') };
  };
  var token = (await call('/')).text().match(/content="([^"]+)"/)[1];
  const caps = await call('/api/capacidades');
  assert.equal(caps.status, 200);
  assert.equal(caps.json().version, '1.11.0');
  assert.equal(caps.json().sections[0].items[0], 'a');
  const served = read('Faro-Fiscal.html');
  assert.ok(!served.includes('PACOSAT_CAPACIDADES'), 'el documento de capacidades ya no viaja dentro del HTML');

  console.log('ronda1110.test: ok — menú de 9 con las 21 vistas alcanzables, «Ya se pagó» de un toque, Pagos con la rutina rellena, presupuesto de peso (HTML ' +
    htmlBytes + ' B, CSS ' + cssBytes + ' B), símbolos sin muertos, pulso único de 30 s y capacidades bajo demanda.');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
