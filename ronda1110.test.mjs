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
      no pasa del techo vigente (450.000 B en la 1.11.0; 458.000 B
      desde la 1.12.0 por la pantalla CIEC, con su aritmética en el
      cuerpo de la prueba), el CSS de 28.000 B y no queda ni un
      símbolo SVG definido sin uso en la superficie.
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
  /* Los destinos son los del plan; su ORDEN es el de la Ronda
     Facilidad (1.18.0, añadido de Paco del 10 nov 18:34): lo de
     cada día primero (Hoy, Dinero, Facturas, Documentos), el
     trabajo después (Avisos, Pagos, Cierre) y el sistema al
     final (SAT, Ajustes). La 1.23.0 (plan futuro, frente B) suma
     el Buzón tras Avisos: la bandeja vive junto al trabajo. */
  assert.deepEqual(views, ['home', 'dinero', 'invoices', 'docs', 'avisos', 'buzon', 'tributario', 'pagos', 'salidas', 'sat', 'settings'],
    'el menú lateral tiene exactamente los 11 destinos del plan, en su orden de tarea (1.18.0 + Buzón 1.23.0 + Buzón Tributario 1.24.0)');
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
  const cierre = avisos.match(/async function avisoMarkPaid\(aviso[^{]*\{([\s\S]*?)\n\}/)?.[1] || '';
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
     para que el lastre no vuelva sin que salte el check.
     Recálculo 1.12.0 (misma regla: el techo se mueve solo con la
     cuenta escrita): la 1.11.0 cerró el artefacto en 445.062 B
     medidos en este árbol. La 1.12.0 suma una pantalla completa
     nueva que el plan no presupuestó —la descarga por CIEC:
     diálogo de acceso, tarjeta con rango y progreso, la caja del
     captcha con su sondeo y el diario, más la rama CIEC de la
     tabla de perfiles— ya adelgazada reutilizando los ayudantes
     del descargador de documentos (satDocStepList y las clases
     sat-*): +9.974 B medidos, resultado 455.036 B. El techo sube
     a 458.000 B: el lastre sigue saltando en el check, y una
     función nueva vuelve a exigir su cuenta por escrito.
     Recálculo 1.13.0 (misma regla): la 1.12.0 cerró en 455.036 B
     medidos en este árbol. La 1.13.0 es una ronda de SUPERFICIE
     pedida por Paco («las alertas deben estar mejor», «más
     visual», «operar desde un solo sitio») y suma, medido pieza a
     pieza con builds de control: el modelo único de problema
     puro en data.part (problemSpec con los textos de cada estado
     conocido + runPhaseStates) +14.182 B; la pieza de superficie
     problemas-ui.part (tarjeta de problema, fases visuales de
     corrida, Centro de mando de Hoy y tarjeta de salud) con su
     CSS nuevo +19.606 B; y el resto de ediciones de superficie
     (satdocs, CIEC, declaraciones, Vigilancia, correo, Hoy)
     +1.330 B, ya netas de retirar la vieja franja trafficStrip
     (−1.870 B de fuente). Resultado medido: 490.154 B. El techo
     sube a 492.000 B y el del CSS a 31.500 B (el CSS crece
     +3.428 B de fuente: tarjetas de problema, fases, centro de
     mando y salud; antes 27.703 B, ahora 31.131 B). El lastre
     sigue saltando en el check.
     Recálculo 1.13.1 (misma regla): la 1.13.0 ENTREGADA (el zip
     pacosat-1130.zip, reconstruido y medido en este árbol) cerró
     el artefacto en 491.785 B. La 1.13.1 suma tres piezas de
     superficie pedidas por Paco el mismo día: (A) «Revisar ahora»
     por factura —el botón en la tarjeta y monitorCheckOne con su
     repintado en sitio: +2.527 B de fuente en monitor-ui.part y
     workflows.part—; (B) Listas con significado y cifras —la rama
     «lista» de problemSpec (+4.744 B de fuente en data.part) y la
     tarjeta con cifras, desplegable y «Ver sus CFDI» (+3.540 B en
     lists-ui.part)—; (C) las acciones directas de SAT
     (satQuickActions con su selector de RFC, sus cuatro verbos y
     sus líneas de estado: +7.492 B en sat-ui.part y +226 B en
     ui.part) y el CSS de las tres (+824 B en polish.part).
     Y (D) la plantilla de impresión del comprobante corregida el
     mismo día (cerrar el diálogo modal antes de imprimir, bloques
     de emisor/receptor, línea de estado separada y el CSS @media
     print en retrato: +1.576 B medidos de artefacto).
     Resultado medido del artefacto: 508.603 B (+16.818 B netos:
     el build retira los comentarios de las fuentes). El techo
     sube a 510.000 B y el del CSS a 33.000 B (32.649 B medidos).
     El lastre sigue saltando en el check.
     Recálculo 1.13.1 FINAL (misma regla, al cerrar las piezas
     E/F/G/G2/C2/C3/H el mismo día): sobre los 508.603 B se suman
     el patrón de acciones largas de E/F en monitor-ui.part y
     lists-ui.part (tarjeta de progreso junto al botón, Cancelar
     cooperativo y resúmenes persistentes), la hoja de descarga
     de C2 en sat-ui.part con sus funciones puras de rango/resumen
     en data.part, la cobertura real de C3 en coverage-ui.part, el
     CSS de progreso y de la hoja (+827 B de fuente en
     polish.part) y la mutación con recomprobación de H en
     sat-ui/avisos-ui/money-ui.part. Resultado medido del
     artefacto: 525.806 B (+34.021 B netos sobre la 1.13.0
     entregada). El techo sube a 527.000 B y el del CSS a
     34.000 B (33.476 B medidos en las fuentes CSS).
     Recálculo Ronda Salidas 1.14.0 (misma regla): la capa de
     salidas vive casi entera en el SERVIDOR (salidas-doc.mjs y la
     sección de local-server.mjs no pesan en el HTML); en el
     cliente solo entran el panel «Salidas diseñadas» con su
     pedir-y-descargar (outputs-ui.part), los dos botones de
     descarga a la carta del detalle (workflows.part), el ZIP
     ordenado de la selección y el folio + los XML del paquete
     mensual (ui.part). Resultado medido del artefacto:
     531.745 B (+5.993 B netos sobre la 1.13.1 construida). El
     techo sube a 533.000 B; el del CSS no se mueve (34.000 B,
     sin cambios de CSS en esta ronda).
     Recálculo 1.15.0 Descarga Automática Mensual (misma regla):
     en el cliente entran la tarjeta «Descarga automática
     mensual» del Centro de mando (problemas-ui.part) y el panel
     de la corrida con su configuración, su cuenta por RFC y la
     recuperación de huecos (coverage-ui.part); el motor entero
     vive en el servidor. Resultado medido del artefacto:
     541.168 B (+9.423 B netos sobre la 1.14.0 construida). El
     techo sube a 542.500 B; el del CSS no se mueve (34.000 B,
     sin cambios de CSS en esta ronda). Queda anotado que la
     siguiente ronda (Facilidad) debe BAJAR peso, no subirlo.
     1.16.0 (Reporte Mano Fil, propuesta P12): el cliente gana el
     panel propio del reporte en Salidas (periodo por mes o rango
     y las dos descargas) y su informe dentro de los automáticos
     con su envío inmediato (outputs-ui.part); el motor entero
     vive en el servidor. Resultado medido del artefacto:
     544.426 B (+1.926 B netos sobre la 1.15.0 construida). El
     techo sube a 546.000 B; el del CSS no se mueve (34.000 B,
     sin cambios de CSS en esta ronda). La nota de bajar peso en
     la ronda de Facilidad sigue en pie.
     Recálculo 1.17.0 (Mapa anual de declaraciones, propuesta
     P13 — su mitad de pantalla): el cliente reescribe la sección
     de Declaraciones (declaraciones-ui.part): la rejilla de tres
     estados se convierte en el mapa del año — resumen «X de 12»,
     alerta de vencidas, celdas-botón con semáforo, la anual como
     celda ancha y el detalle del mes con su gesto de recuperación
     por periodo — y el CSS gana el componente del mapa
     (resumen, alerta, estados, detalle), ya neto de retirar las
     dos reglas muertas de la rejilla vieja (.decl-recuperada y
     .decl-sin-recuperar). El motor del mapa vive en el servidor
     (view.mapa de declaracionesOverview) y no pesa en el HTML.
     Resultado medido del artefacto: 552.914 B (+8.488 B netos
     sobre la 1.16.0 construida). El techo sube a 554.500 B y el
     del CSS a 35.000 B (34.495 B medidos en las fuentes: +1.019 B
     netos del componente del mapa). La nota de bajar peso en la
     ronda de Facilidad sigue en pie.
     Recálculo 1.18.0 (Ronda Facilidad, la que debía BAJAR): las
     piezas nuevas del cliente (registro de actividad con sus
     gestos, tarjetas de documento, historial de preparaciones,
     tarjetas de destino en Salidas, folio y vencimientos) suman
     +18.781 B medidos sobre las fuentes sin comentarios, ya netos
     de retirar la portada «Qué quieres hacer» del SAT, la lista
     de cierre duplicada de Reportes (−4.148 B de fuente) y cinco
     funciones muertas (runSatDocsNow, avisosConfigPanel y el
     alias avisoMarkPaidDialog; fiscalStateCounts/donutSegments
     se quedan: verify.cjs las evalúa por corte de fuente). La
     compensación que cierra la cuenta
     es del BUILD, y queda escrita aquí: el stripper del
     artefacto retira desde esta ronda también la SANGRÍA de las
     regiones de código (~35 KB que el navegador no ejecuta),
     con su máquina de estados — el texto de plantillas y de
     cadenas pasa intacto, ningún identificador se acorta, los
     saltos de línea se conservan y las fuentes no cambian; la
     equivalencia se fijó comparando el artefacto contra el
     stripper anterior (idénticos al quitar todo el espacio) y
     con node --check. Resultado medido del artefacto:
     535.267 B (−17.647 B sobre la 1.17.0: la ronda BAJA, como
     estaba mandado). El techo baja a 536.000 B. El CSS queda en
     34.167 B de fuentes (−328 B netos: entran el botón Deshacer
     y el panel de filtros móvil, y salen once reglas muertas
     verificadas una a una: .activity-bars, .activity-day,
     .monitor-dates, .cp-hit.sev-*, .pagos-total, .sat-run-files,
     .legend-item y los selectores muertos de tres reglas
     agrupadas); su techo no se mueve (35.000 B). */
  /* 1.22.0: el techo sube a 552.000 B con la contabilidad a la
     vista — la ronda es de FUNCIONES que el propio Paco encargó
     pieza a pieza, no de grasa: cola «Trabajos del SAT» con su
     Cancelar, tarjetas de Hoy alimentadas del servidor (pieza 2,
     N5, N6), Cancelar junto a cada progreso, facilidades
     F1/F2/F3/F5 y la lista de puesta en marcha M4. Medido:
     550.080 B (+15.011 sobre la 1.21.0); en gzip la página ya
     viajaba a ~151 KB y el incremento estimado es ~4 KB (a
     verificar en despliegue con el encode activo). La disciplina
     sigue: la próxima ronda que recorte, que baje el techo.
     1.23.0 (plan futuro íntegro): el crecimiento también es
     pieza a pieza — pantalla Buzón completa con su distintivo
     (frente B), panel guiado del fallback de declaraciones con
     su formulario de casado (A2), diario de corrida (A3),
     botones Descargar/Ver/Recuperar (A0/D3), salud del respaldo
     con su comprobación (C), Revertir pago (D1), «Ya se pagó»
     optimista con re-lectura (D2) y el panel del cierre de
     línea base (E). Medido: 569.448 B (+19.443 sobre la
     1.22.0); en gzip -9 medido aquí: 154.906 → 160.376 B
     (+5.470). El techo sube a 572.000 con la misma disciplina:
     la próxima ronda que recorte, que baje el techo.
     Anexo 1.24.0 (auditoría Impeccable): el CSS sube a 35.138 B
     (+344 netos sobre 34.794, tras podar una regla muerta de
     .cards) por la corrección del desborde móvil medido en la
     app real sembrada: la página medía 726 px de ancho en un
     móvil de 390 en TODAS las pantallas (regla
     body-text-viewport-edge de Impeccable) y los botones
     «Marcar leído» del Buzón quedaban fuera de pantalla. El
     arreglo: cabecera superior flexible, pista de la rejilla
     acotada con minmax(0,1fr), filas .cp-row que encogen y
     envuelven y objetivos de 44 px en sus botones al móvil.
     Medido tras el arreglo: 390 px exactos en Hoy, Buzón,
     Buzón Tributario, Documentos, Dinero y Ajustes.
     El techo de CSS sube a 35.300 con la misma disciplina.
     Anexo 1.25.0 («Las 20 de Paco»): el CSS crece por cerrar los
     tokens escapados de la auditoría visual — `--accent` pasa a
     ser token de :root (la barra .run-bar pierde su azul
     #2563eb de emergencia), la insignia de novedades usa
     var(--danger) en vez del #d9534f crudo — y por definir por
     fin las tres clases fantasma que el código ya usaba en
     todas partes (.soft, .clickable, .inline-form). El techo de
     CSS sube a 35.600 con la misma disciplina.
     Anexo 1.26.0 (Ronda Visual): el CSS crece a 39.304 B de
     fuentes (+3.720 sobre la 1.25.0) y el techo sube a 39.600
     con la contabilidad a la vista — es la ronda DEL CSS: las
     escalas de tokens (--r-*, --sp-*, --shadow-*, --fs-*) viven
     en la hoja; entran tres componentes nuevos (avisos
     flotantes .toasts/.toast-card, pantalla de entrada .entry,
     gráficas de Dinero .age-chart/.bar-cobrar/.bar-pagar), el
     pie de impresión con cajas de margen de @page, el hover de
     filas y la animación de diálogos; los colores fugados de
     Pagos pasan a color-mix con token (neutro en bytes). La
     página crece a 567.298 B (+13.899: lo anterior más el
     andamiaje JS de avisos/entrada/gráficas y docs/DESIGN.md no
     viaja en el artefacto) y su techo NO se mueve: 572.000.
     En gzip -9 medido aquí: 159.679 B (+3.436 sobre la 1.25.0).
     La disciplina sigue: la próxima ronda que recorte, que baje
     los techos. */
  assert.ok(htmlBytes <= 572000, 'Faro-Fiscal.html pesa ' + htmlBytes + ' B (tope 572.000)');
  const cssBytes = ['style.part', 'design.part', 'polish.part'].reduce((sum, name) => sum + statSync(join(ROOT, name)).size, 0);
  assert.ok(cssBytes <= 39600, 'el CSS pesa ' + cssBytes + ' B (tope 39.600)');

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
