import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPacoSATService } from './local-server.mjs';

/* Ronda 1.11.0 — la versión final del rediseño. Lo que esta suite
   fija para que no vuelva atrás:
   1) El menú es de 11 destinos por tarea (9 de la limpieza
      2.0.1 + Buzón y Declaraciones propios de la 2.0.2)
      (+ Preguntas) y las 21
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
  /* La fila «Trabajos en curso» (1.31.0) vive dentro del nav con
     su propio botón a Hoy: no es un destino del plan y se retira
     antes de contar destinos. */
  const navDestinos = nav.replace(/<div id="nav-jobs"[\s\S]*?<\/div>/, '');
  const views = [...navDestinos.matchAll(/data-view="([a-z]+)"/g)].map(match => match[1]);
  /* Los destinos son los del plan; su ORDEN es el de la Ronda
     Facilidad (1.18.0, añadido de Paco del 10 nov 18:34): lo de
     cada día primero (Hoy, Dinero, Facturas, Documentos), el
     trabajo después (Avisos, Pagos, Cierre) y el sistema al
     final (SAT, Ajustes). La 1.23.0 (plan futuro, frente B) suma
     el Buzón tras Avisos: la bandeja vive junto al trabajo. */
  /* La 1.28.0 («Paquete de mejoras») suma dos destinos propios:
     Declaraciones tras Documentos (P2) y Registro en Sistema
     (P1) — el menú pasa a 13 destinos con el mismo orden de
     tarea. */
  /* 1.29.0 (propuesta visual, peldaño 2): el menú se reagrupa
     como piensa el dueño — La mañana / El dinero / El SAT y los
     papeles / La casa — con los mismos 13 destinos; la barra
     inferior pasa a Hoy · Avisos · Buzón · Dinero · Más. Esta
     aserción sustituye a la del orden 1.18.0/1.28.0, superado
     por orden expresa de esa propuesta. */
  /* 1.31.0 (ordenamiento aprobado por Paco): el Buzón Tributario
     deja de ser renglón — vive dentro del Centro SAT — y el menú
     pasa a 12 destinos; el otro «Buzón» se llama «Recibidos»
     (data-view buzon, como siempre). Esta aserción sustituye a
     la de los 13 destinos de la 1.29.0 por orden expresa del
     ordenamiento. */
  /* 1.31.1 (archivar fácil): «Archivo» entra en La casa tras
     Registro — el menú pasa a 13 destinos; esta aserción
     sustituye a la de los 12 de la 1.31.0 por orden expresa de
     la pasada de diseño y operación. */
  /* 2.0.1 (LIMPIEZA VISIBLE, orden directa de Paco del 16 nov:
     «sigo viendo algo enredado el sistema, podría ser más
     limpio y práctico»): el menú pasa a 9 destinos — Hoy,
     Facturas, Dinero, Documentos, Avisos, Reportes, Listas del
     SAT, Salud, Ajustes —, el Centro SAT desaparece como
     destino (sus pestañas son vistas enrutadas propias:
     descargar/monitor/lists/coverage/ejecutor) y el resto
     cuelga de Salud o de su pantalla natural. RE-BASE por orden
     directa, como los sellos de versión: esta aserción
     sustituye a la de los 13 destinos de la 1.31.1. Las 21
     vistas históricas siguen alcanzables (canónicas o alias),
     como comprueba la aserción siguiente. */
  /* 2.0.2 (orden directa de Paco, la misma noche: «¿Dónde está
     el Buzón?» en su iPhone): Buzón y Declaraciones recuperan
     su entrada PROPIA — lo necesario no se esconde — y el menú
     pasa a 11 destinos, con Buzón y Declaraciones tras
     Documentos, cada uno con su estado en la propia entrada.
     RE-BASE por orden directa: esta aserción sustituye a la de
     los 9 destinos de la limpieza 2.0.1. */
  /* RE-BASE integración 2.4.0 (W4d): la barra de navegación
     creció a 22 destinos con rótulos y descripciones; el pin
     de 11 de la 2.0.2 quedó superado. Se re-pina la lista
     EXACTA de hoy, con la misma fuerza (deepEqual completo). */
  /* RE-BASE 2.8.0 (diseño 3): «Descargados del SAT» (coverage)
     se funde en «Descargar del SAT» y sale del menú: 21
     destinos, la lista EXACTA de hoy con la misma fuerza. */
  /* RE-BASE 2.9.15 (Bloque B6): el menú se reagrupa por tarea
     — Expediente, SAT, Bancos, Documentos, Ajustes — y el
     ORDEN de los 21 destinos cambia con los grupos: Registro
     cierra Expediente, el Buzón del SAT entra en SAT tras
     Descargar, y Documentos y Declaraciones forman su propio
     grupo tras Bancos. Los 21 destinos son los mismos de la
     2.8.0 (paridad); la lista EXACTA se re-pina con la misma
     fuerza, y ronda2915diseno vigila cada grupo por separado. */
  /* RE-BASE 2.9.16 (Punto 1 de Paco): el menú se reagrupa
     en los cuatro bloques que él nombró — Trabajo diario,
     SAT, Expediente y Administración — y los cinco destinos
     menos frecuentes (ejecutor, archivo, reportes, salidas,
     preguntas) viven dentro de «Más», plegado. Los 21
     destinos son los mismos de la 2.8.0 (paridad); la lista
     EXACTA se re-pina con la misma fuerza, y ronda2916nav
     vigila cada bloque y el pliegue por separado. */
  /* RE-BASE 3.1.0 (orden expresa de Paco): «Administración»
     entra como destino PROPIO y visible tras Contribuyentes —
     la consola de triage de todos los RFC no se esconde en
     «Más» — y el menú pasa a 22 destinos. La lista EXACTA se
     re-pina con la misma fuerza; la paridad se mantiene: ningún
     destino anterior desaparece. */
  assert.deepEqual(views, ['home', 'avisos', 'invoices', 'descargar', 'tributario', 'monitor', 'lists', 'declaraciones', 'buzon', 'contribuyentes', 'admin', 'docs', 'registro', 'dinero', 'pagos', 'salud', 'settings', 'ejecutor', 'archivo', 'reportes', 'salidas', 'preguntas'],
    'el menú lateral tiene exactamente los 22 destinos (3.1.0: + Administración, visible tras Contribuyentes), reagrupados en la 2.9.16 en Trabajo diario, SAT, Expediente y Administración, con los menos frecuentes dentro de «Más»');
  const bottomAt = layout.indexOf('bottombar');
  const bottom = layout.slice(bottomAt, bottomAt + 1400);
  /* RE-BASE 2.8.0 (diseño 28): la barra inferior es Hoy ·
     Avisos · Descargar · Buzón del SAT · Más — Dinero vive
     dentro de «Más» y el cuarto hueco es el Buzón del SAT.
     RE-BASE 3.0 (mejora 21 del encargo): la barra pasa a
     Al día · Hoy · Descargar · Avisos · Más — el primer
     hueco es el botón «Ponerme al día» (sin data-view: es
     una acción, no una vista) y el Buzón del SAT conserva
     su sitio en el menú lateral y en «Más» (paridad: el
     destino no desaparece, se mueve de barra). */
  assert.ok(bottom.includes('id="aldia30-bar"'), 'barra inferior: botón «Al día» (3.0)');
  for (const view of ['home', 'avisos', 'descargar']) assert.ok(bottom.includes('data-view="' + view + '"'), 'barra inferior: ' + view);
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
     Anexo 1.28.0 («Paquete de mejoras»): la página crece a
     576.047 B (+5.326 sobre los 570.721 de la 1.27.0) por el
     cableado de los dos destinos nuevos en el artefacto
     principal (botones de menú y mapa de pantallas de
     Declaraciones y Registro, protagonista veraz de Hoy y su
     línea del Registro, folios en el detalle de cada mes,
     distintivos por RFC, Documentos filtrado) — la pantalla
     del Registro en sí viaja DIFERIDA en su parte (4.852 B
     fuera de la primera pintura). El techo sube a 580.000
     con la misma disciplina: la próxima ronda que recorte,
     que baje el techo.
     Anexo 1.29.0 (ejecutor local + papelera + peldaños 1 y 2):
     la página crece a 594.876 B (+18.829 sobre la 1.28.0) por
     lo que vive en el artefacto principal: el panel del
     ejecutor y la papelera con su límite honesto en el Buzón
     Tributario, la línea de la máquina y el formato humano de
     fechas en Hoy, las celdas de dos líneas de Declaraciones,
     el Totales por años navegable hasta el CFDI, el menú
     reagrupado y la entrada con ver/ocultar. La tarjeta
     de vencimientos de Pagos y el detalle del Registro viajan
     DIFERIDOS en sus partes, fuera de esta cuenta. El CSS
     crece a 42.100 B (+2.500) por la gramática de la ronda
     (pastillas de mes, barra de plazo del Buzón, línea de
     tiempo del Registro, orden móvil de Hoy, años de Totales).
     Los techos suben a 598.000 y 42.500 con la misma disciplina.
     Anexo 1.29.1 (corrección de Declaraciones + ampliación
     D6–D8, a código pelado — la construcción retira los
     comentarios del artefacto, así que esto es código): la
     página crece a 602.467 B (+7.591 sobre la 1.29.0) por la
     normalización del histórico por años con su rótulo
     garantizado, el «Cómo funciona» plegado, la guía de espera
     del ejecutor con su estado real (compartida entre
     Declaraciones y el Buzón), el botón de emparejar en un
     solo sitio, la pestaña «Ejecutor local» de Centro SAT, el
     recálculo veraz de Avisos con sus contadores de lo visible
     y el protagonista de Hoy con la cola del ejecutor. El CSS
     crece a 42.769 B de fuentes (+669) por las protecciones de
     la rejilla de meses y la recogida de la cabecera en la
     banda 861–1100 px; su techo sube a 43.000. El techo de la
     página sube a 604.000 con la misma disciplina.
     Anexo 1.29.2 (parrilla de trámites del Centro SAT + capa
     de atención de Avisos, a código pelado): la página crece
     a 618.915 B (+16.448 sobre la 1.29.1) por la parrilla de
     seis tarjetas-trámite con su máquina de estados veraz
     (sustituye al panel de acciones rápidas), el gesto y los
     botones de atención en cada tarjeta de aviso, el diálogo
     de reprogramación, las vistas Activas/Pospuestas/
     Archivadas con sus tarjetas y la franja de «sin vías». El
     CSS crece a 43.694 B de fuentes (+925) por la gramática
     de la parrilla y la pastilla del gesto. Los techos suben
     a 619.000 y 44.500 con la misma disciplina.
     Anexo 1.30.0 (puerta auto-probada + código corto + demás
     RFC en la parrilla): la página crece a 623.232 B (+4.317)
     por el veredicto de la puerta en la tarjeta del Buzón, el
     botón del código corto en el panel del ejecutor, el estado
     «falta su e.firma» de las seis tarjetas para un alta
     preparada, el selector que suma los RFC con perfil y la
     tarjeta genérica de alta. El CSS no crece. El techo de la
     página sube a 623.500 con la misma disciplina.
     Anexo 1.31.0 (corrección del 13 nov + menú ordenado + las
     45 mejoras + reportes, a código pelado): la página crece a
     659.787 B (+36.555 sobre la 1.30.0) por lo que vive en el
     artefacto principal: el menú ordenado con la fila «Trabajos
     en curso» y los cuatro iconos nuevos de trámite, el Cancelar
     y el último resultado real de las tarjetas con su foco
     visual, el semáforo del día y la franja de la semana fiscal
     de Hoy con el mapa de calor de Totales y su conciliación, el
     dueño visible y los filtros con memoria de Avisos, la
     gráfica mensual y la antigüedad de Dinero con la línea de
     saldo de Bancos, la búsqueda global que también encuentra
     documentos y avisos, el deshacer universal y el arrastrar y
     soltar, la nota pegada al CFDI y los botones de los
     reportes nuevos. Lo diferido (Salidas, Pagos, Bancos y
     Registro en sus partes perezosas) no entra en esta cuenta.
     El CSS de fuentes crece a 47.565 B (+3.871) por la
     gramática de la ronda: fila de trabajos, foco de tarjetas,
     urgencia de plazos, diana de pulgar de 48 px en móvil y la
     jerarquía tipográfica de las tarjetas. Los techos suben a
     663.000 y 48.000 con la misma disciplina: la próxima ronda
     que recorte, que baje el techo. Ajuste final de la misma
     ronda, ya con capturas: el CSS cierra en 48.138 B (+573)
     porque la fila «Trabajos en curso» aprende a repartir su
     ancho y a enseñar su Cancelar entero dentro del menú (en la
     primera captura se le cortaba la última letra); el techo
     CSS se re-basifica a 48.500 y el HTML queda en 663.000. */
  assert.ok(htmlBytes <= 893650, 'Faro-Fiscal.html pesa ' + htmlBytes + ' B (tope 893.650, RE-BASE 3.1.0 de contabilidad: el artefacto mide 892.846 B (+11.854 B sobre los 880.992 B sellados de la 3.0: las fuentes de la carga inicial crecen +19.443 B — ui.part +11.803 con la tarjeta «Ponerme al día» rehecha sobre la vista plana real (su RFC nombrado, la etapa con su tiempo y el resumen accionable), el color automático estable por RFC y la franja de cabecera, el «Cargando…» honesto del arranque, los filtros de Hoy y las etiquetas de trabajos por RFC, la tira de alcance y el puente del alta; avisos-ui.part +2.466 con el ámbito que manda, el «Error/Aviso» y la resolución con su dueño; final-ui.part +1.733 con la nota de novedades 3.1.0; polish.part +1.720 con la piel de la ronda; coverage-ui.part +980 con los metadatos y huecos por RFC y su tira; lists-ui.part +392 con el resumen por RFC; layout.part +349 con la entrada de Administración y la franja — que el ensamblador deja en +11.854 B al retirar los comentarios; la consola de Administración viaja DIFERIDA como parte «admin» (10.537 B ya ensamblados en lazy.json) y NO pesa en la carga inicial: las partes diferidas crecen +14.121 B en total (la parte admin nueva, sat-ui.part +3.820 en fuentes con el alta en un paso y el botón CIEC que abre su diálogo, monitor-ui.part +985, salud-ui.part +269 y tributario-ui.part +212); el tope pasa a 893.650 B (892.846 + 804 de margen); antes, tope 881.800, RE-BASE 3.0 de contabilidad: el artefacto mide 880.992 B (+16.778 B sobre los 864.214 B del árbol base 2.9.17 tal como quedó: las fuentes de la carga inicial crecen +22.428 B — ui.part +11.962 con la tarjeta «Ponerme al día» y su caminante, el sello de frescura, la caché del último estado para el Hoy al instante, el lenguaje llano de fallos del portal y las acciones rápidas de Facturas; coverage-ui.part +3.498 con la rejilla «Lo que falta por traer» tocable por mes; workflows.part +3.141 con la prueba de origen en el detalle y las acciones a un toque; polish.part +2.132 con la piel de la tarjeta, las acciones rápidas y la pasada de dedo; final-ui.part +1.109 con el cable del botón «Al día» de la barra y la nota de novedades 3.0; layout.part +586 con la barra inferior nueva y el sello de frescura — que el ensamblador deja en +16.778 B al retirar los comentarios; las partes diferidas crecen aparte, +240 B en lazy.json ya ensamblado: el recordatorio de estados de cuenta por cuenta en problemas-ui.part y la llamada del sello de frescura en sat-ui.part); el tope pasa a 881.800 B (880.992 + 808 de margen); antes, tope 866.250, RE-BASE 2.9.16 de contabilidad: el artefacto mide 865.466 B (+6.317 B sobre los 859.149 B sellados de la 2.9.15: las fuentes de la carga inicial crecen +12.232 B — ui.part +6.671 con «Tus tareas» y sus pisos, la caché de a medias, la franja de Facturas sin la columna Tipo y el alcance de sesión; polish.part +3.372 con la piel de la ronda; final-ui.part +765; workflows.part +714; layout.part +426; monitor-ui.part +284 — que el ensamblador deja en +6.317 B al retirar los comentarios; las partes diferidas crecen aparte, +3.355 B en lazy.json: salud-ui.part +2.074, registro-ui.part +2.418, lists-ui.part +452, declaraciones-ui.part +412 y banks-ui.part +408 en fuentes); el tope pasa a 866.250 B (865.466 + 784 de margen); antes, tope 859.900, RE-BASE 2.9.15 de contabilidad: el artefacto mide 859.149 B (+6.643 B sobre los 852.506 B sellados de la 2.9.14: +753 B del Bloque C — las capturas de Ayuda desde el directorio de datos —, +5.032 B del Bloque B — el lote gráfico de los 7 puntos de Paco: franja de atención y estados en ui.part, piel y toque en polish.part, copias del visor en workflows.part, menú por tarea en layout.part — y +858 B netos de la nota de novedades 2.9.15 en final-ui.part); el tope pasa a 859.900 B (859.149 + 751 de margen); antes, tope 853.600, RE-BASE 2.9.13 de contabilidad: el artefacto mide 852.811 B (+25.893 B sobre los 826.918 B sellados de la 2.9.12: los bloques A–E de la ronda — el arreglo de Descargar y sus pasos/mapa/historial, el Buzón con Leer y su rediseño, Salud D, los encabezados de reportes y las 30 mejoras gráficas, con su piel en polish.part —; medido reconstruyendo con el propio ensamblador); el tope pasa a 853.600 B (852.811 + 789 de margen); antes, tope 827.200, RE-BASE 2.9.10 de contabilidad: el artefacto mide 826.449 B (+1.502 B sobre los 824.947 B sellados de la 2.9.9, medidos tanda a tanda revirtiendo cada fichero cambiado a su 2.9.9 y reconstruyendo con el propio ensamblador: +1.472 B de final-ui.part —el respaldo partido reconstruido: splitBackupParts con la regla de dueño y el empaquetado voraz del servidor, splitBackupFileName y el diálogo veraz, netos de la función por combinación RFC·año que sustituyen, y la nota de novedades 2.9.10 que sustituye a la de la 2.9.9—, +44 B de workflows.part —el parámetro opcional de snapshot() para pedir la foto sin el techo de archivo único, que el respaldo partido necesita para expedientes que no caben en un archivo— y −15 B de ui.part —la entrada del menú, ahora «Respaldo partido» a secas—; las tandas suman +1.501 y el byte restante es de los empalmes del ensamblado entre partes); el tope pasa a 827.200 B (826.449 + 751 de margen); antes, tope 825.700, RE-BASE 2.9.9 de contabilidad: el artefacto mide 824.947 B (+1.169 B sobre los 823.778 B sellados de la 2.9.8, medidos tanda a tanda: +567 B del diseño estructural —D1 la línea fina de trabajos en la barra superior, D4 las fusiones de Declaraciones, cobertura y Hoy, D6 la puerta de una sola fuente—, −100 B netos de D2/D3/D5 —los menús «⋯» y el «ver más» reemplazan más botones y párrafos de los que añaden—, +439 B del veredicto de descargas B3 en ui.part —su pintura en el foco y las etiquetas de los estados nuevos— y +263 B de la nota de novedades 2.9.9 en final-ui.part, que sustituye a la de la 2.9.8; el bloque «Bajar todo» de servidor —B1 la auditoría de cobertura automática y B2 la cura de rechazos— vive en local-server.mjs y no pesa en el artefacto); el tope pasa a 825.700 B (824.947 + 753 de margen); antes, tope 824.500, RE-BASE 2.9.8 de contabilidad: el artefacto mide 823.778 B (+1.619 B sobre los 822.159 B sellados de la 2.9.7, medidos fichero a fichero sobre la base del paquete 2.9.7: +1.072 B netos de los usuarios con nombre propio en la carga inicial —puente de sesión en ui.part +176, línea de montaje en Ajustes +127, talón del panel, diálogo de entrada con usuario y nota de novedades 2.9.8 en final-ui.part +686 neto, manifiesto de la parte diferida en build.mjs +83; el panel entero viaja DIFERIDO en la parte «usuarios», fuera de la carga inicial—, +523 B de la Pieza V —el visor abre en el gesto— en pdf-cloud-ui.part y +24 B de la Pieza R —las reglas .chart sin el trazo heredado— en design.part; el tope pasa a 824.500 B (823.778 + 722 de margen); antes, tope 822.500 SIN SUBIR, RE-BASE 2.9.0 de contabilidad: la ronda llevó el artefacto a 840.480 B en su integración (+32.199 B sobre los 808.281 B sellados de la 2.8.0: foco del sistema, ficha de contribuyente, cuenta canónica compartida, plegable propio, papelera de documentos, etiquetas y textos de sede) y el Bloque D lo devolvió por debajo diferiendo la pantalla del Buzón como parte «buzon» (39.506 B en lazy.json, patrón W6): el artefacto final mide 799.556 B, MENOS que la 2.8.0 y con 22.944 B de margen bajo este mismo tope — el techo no se mueve; antes, RE-BASE de la 2.3.0: el artefacto mide 820.999 B (+20.350 B sobre los 800.649 B de la 2.0.2: +15.278 B de las piezas funcionales de cliente de las 20 mejoras, +2.739 B de la ronda visual, +1.607 B de los gemelos de oscuro por sistema y +726 B de la nota de novedades 2.3.0); en la 2.0.2 medía 800.649 B — +1.739 B sobre los 798.910 B asentados de la 2.0.1: las entradas propias de Buzón y Declaraciones con sus spans, sus textos de estado y su pintado —; contabilidad anterior: fase 2 de cliente de la 2.0.1: el artefacto medía 798.249 B — las piezas de cliente de las 30 mejoras (y la nº 31, el botón «Ejecutar aquí») que viven en la parte principal (confirmación y pre-vuelo de despachos nº 5/21, modo urgente y tira fiscal de Hoy nº 4/15, a medias nº 16, espera y foto tocada nº 27/23, búsqueda por importe y concepto nº 24, selector de contraparte y orden por importe nº 13/26, comparativo de Totales nº 11, Avisos en dos grupos con su Imprimir y contrapartes nuevas nº 9/2/10, cruce201 en Documentos nº 3, confirmación en la hoja de descarga y plantilla de año nº 5/28, línea de vida con documento nº 6, tiempo estimado nº 22, Mes de Dinero y ficha PDF nº 12/29, imprimir en Listas y Contribuyentes nº 2) suman +23.742 B medidos sobre los 774.507 B de la limpieza; venía de 780.000)');
  const cssBytes = ['style.part', 'design.part', 'polish.part'].reduce((sum, name) => sum + statSync(join(ROOT, name)).size, 0);
  /* RE-BASE 2.8.0 (tope CSS): las fuentes style/design/polish
     suman 86.217 B medidos hoy — +1.259 B sobre los 84.958 B
     asentados en la integración 2.4.0. Ese crecimiento YA
     estaba en el árbol sellado de la 2.4.0 (sus tres fuentes
     suman 86.217 B en el propio paquete pacosat-240.zip,
     contra el tope de 85.719 fijado antes de su último
     retoque): la batería completa de la 2.8.0 lo cazó en su
     primera pasada. La 2.8.0 no toca ninguna fuente CSS —
     las tres quedan byte a byte como en el paquete 2.4.0 —
     y el tope se re-basifica a 86.978 conservando el mismo
     margen de 761 B que la suite venía usando. */
  assert.ok(cssBytes <= 106074, 'el CSS pesa ' + cssBytes + ' B (tope 106.074, RE-BASE 3.1.0 de contabilidad: el CSS mide 105.313 B en las fuentes (+1.720 B sobre los 103.593 B de la 3.0, todo en polish.part: la franja de cabecera en el color del RFC, la etiqueta de RFC de los trabajos, la tira de alcance, la línea del RFC de la tarjeta «Ponerme al día», la clase del aviso y la piel de la consola de Administración); el tope pasa a 106.074 B conservando el margen de 761 B de siempre (105.313 + 761); antes, tope 104.354, RE-BASE 3.0 de contabilidad: el CSS mide 103.593 B en las fuentes (+2.124 B sobre los 101.469 B medidos hoy en el árbol base 2.9.17, todo en polish.part: la piel de la tarjeta «Ponerme al día» y su caminante, las acciones rápidas de Facturas a un toque, la rejilla de meses tocable y la pasada de tamaño de dedo); el tope pasa a 104.354 B conservando el margen de 761 B de siempre (103.593 + 761); antes, tope 101.606, RE-BASE 2.9.16 de contabilidad: el CSS mide 100.845 B en las fuentes (+3.372 B sobre los 97.473 B de la 2.9.15, todo en polish.part: los bordes que distinguen los cuatro estados sin color y el giro pausado de «en proceso», los pisos de Salud, la franja pegajosa de Facturas y Registro, la ficha lateral del detalle, el pliegue de «Más» del menú y la línea de sesión); el tope pasa a 101.606 B conservando el margen de 761 B de siempre (100.845 + 761); antes, tope 98.234, RE-BASE 2.9.15 de contabilidad: el CSS mide 97.473 B en las fuentes (+1.864 B sobre los 95.609 B de la 2.9.13: el bloque de piel del lote gráfico en polish.part — el sistema único de estados .estado2915 con sus cuatro parejas de la paleta, la franja de atención de Hoy, la señal del grupo activo del menú, el aire tabular de los identificadores y las reglas de toque de 44px —); el tope pasa a 98.234 B conservando el margen de 761 B de siempre (97.473 + 761); antes, tope 95.700, RE-BASE 2.9.13 de contabilidad: el CSS mide 95.609 B en las fuentes (+6.948 B sobre los 88.661 B de la 2.9.12: el bloque «piel y gráficos» de la ronda en polish.part — pasos y mapa de Descargar, tarjetas del Buzón, semáforos de Salud, anillos de Hoy y Cierre, barras de Facturas y Reportes, conciliación dibujada, línea de vencimientos y guía de Ayuda —); el tope pasa a 95.700 B (95.609 + 91 de margen); antes, tope 88.668, RE-BASE 2.9.0: el CSS mide 87.907 B en las fuentes (+628 B netos sobre los 87.279 B de la 2.8.0: la piel del foco y de su panel, la etiqueta290, la actividad en flujo, el plegable290 y la ficha sumaron +3.497 B, y el Bloque D retiró 2.869 B netos de reglas muertas verificadas clase a clase en todo el árbol en vez de subir el tope de ronda1260); el tope conserva el margen de 761 B de siempre (87.907 + 761); antes, RE-BASE 2.8.0: el CSS mide 87.279 B en las fuentes (+1.062 B de la piel de protagonista y móvil de los ítems 7 y 8 de diseño, medidos); el tope conserva el mismo margen de 761 B de siempre (87.279 + 761); antes, RE-BASE integración 2.4.0 (mal asentada: decía 84.958 B cuando las fuentes selladas sumaban 86.217 B): el CSS mide 84.958 B medidos hoy en las fuentes (+10.219 B sobre los 74.739 B de la 2.3.2: +5.293 B de W5a —estados, iconos y esqueletos— que lo llevaron a 80.211 B, y +4.747 B de W5b/WC —gráficos, tarjetas protagonistas y piezas visuales de la ronda—); el tope conserva el mismo margen de 761 B que la suite venía usando (75.500 − 74.739); el techo del HTML NO se toca: el artefacto mide 797.312 B y cumple el vigente de 822.500 B; antes, RE-BASE de la 2.3.2: el CSS mide 74.739 B (+2.471 B sobre los 72.268 B asentados en la 2.3.0, medidos contra el sellado 2.3.1: +1.887 B del bloque de cabecera sin desborde (M-10), espejos y tacto de B4 en polish.part, +339 B del endurecimiento H6-2 de la línea de Actividad en design.part y +245 B de la miga H6-3 en style.part); antes, RE-BASE de la 2.3.0: el CSS mide 72.268 B (+5.352 B sobre los 66.916 B asentados: +3.392 B de la ronda visual y +1.960 B de los gemelos de oscuro por sistema con su comentario); antes, RE-BASE de la limpieza 2.0.1 por orden directa de Paco: el CSS medía ya 66.546 B tras la parte de cliente anterior de esta ronda —46 B sobre el tope anterior— y las reglas propias de la limpieza (marco del mando de Hoy, estado de Listas en el menú, grupo de Declaraciones, efecto de canceladas) añaden +370 B medidos: 66.916 B en total; venía de 66.500 de la 2.0 tanda 7B)');

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
