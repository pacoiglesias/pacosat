import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/* ================================================================
   Ronda 2.9.16 · P5 — Exploración de tablas en Facturas y en
   el Registro:

   · Facturas: la franja de exploración (pestañas, filtros,
     atajos y filtros activos) va junta y FIJA arriba al hacer
     scroll. La tabla enseña solo las columnas del día —
     fecha, contraparte, folio, total, estado y acción —: el
     «Tipo» sale de la tabla y vive en la ficha del
     comprobante. El detalle se abre en una FICHA LATERAL: el
     diálogo compartido anclado a la derecha a todo el alto,
     con la tabla visible al lado y todos sus flujos internos
     (Ver comprobante, Ver PDF, Enviar, Ya se pagó) intactos.
   · Registro: los filtros de contribuyente y de clase
     EXISTÍAN y funcionaban por dentro (su cambio viajaba al
     servidor) pero nunca se montaban en la pantalla — eran
     invisibles —. Ahora van en la franja, con el buscador,
     el orden (recientes/antiguos) y los filtros activos con
     su aspa, como en Facturas.
   ================================================================ */
const AQUI = dirname(fileURLToPath(import.meta.url));
const leer = f => readFileSync(join(AQUI, f), 'utf8');
const html = leer('Faro-Fiscal.html');
const ui = leer('ui.part');
const workflows = leer('workflows.part');
const registro = leer('registro-ui.part');

/* ── Facturas: columnas del día, sin «Tipo» ──────────────── */
const iGrid = ui.indexOf("grid(['', 'Fecha', 'Emisor → receptor', 'Folio', 'Total', 'Estado SAT', 'Acción']");
assert.ok(iGrid >= 0, 'la tabla de Facturas enseña las columnas del día, sin «Tipo»');
const bloqueGrid = ui.slice(iGrid, iGrid + 4200);
assert.ok(!bloqueGrid.includes("cell(KINDS[row.kind], rowRole(row))"),
  'la celda de tipo/rol ya no se pinta en la fila (vive en la ficha)');
assert.ok(bloqueGrid.includes('invoiceActions(row)'), 'la acción de la fila sigue en su columna');
/* El tipo sigue existiendo donde se trabaja: en la ficha. */
assert.ok(workflows.includes('KINDS[row.kind]') || workflows.includes('row.kind'),
  'el detalle del CFDI sigue enseñando su tipo en la ficha');

/* ── Facturas: la franja fija ────────────────────────────── */
assert.ok(ui.includes('franja2916.append(tabs, filtersToggle, controls, masFiltros, rapidosBar240, chips);'),
  'la franja junta pestañas, filtros, atajos y filtros activos');
assert.ok(ui.includes('list.append(franja2916, result);'),
  'la franja se monta sobre la tabla');
assert.ok(html.includes('.franja2916{position:sticky;top:0'),
  'la franja es fija arriba al hacer scroll (CSS en el artefacto)');
/* Segunda corrección tras la verificación en vivo (19 nov):
   el sticky computaba pero no agarraba — la franja vive
   dentro de un .panel con overflow:hidden, que se convierte
   en su contenedor de scroll y nunca se desplaza. El panel
   que hospeda una franja no recorta (el comportamiento en
   scroll lo afirma ronda2916navegador en Chromium real). */
assert.ok(html.includes('.panel:has(.franja2916){overflow:visible}'),
  'el panel que hospeda la franja no recorta: sin esto, su overflow:hidden deja el sticky inerte');
/* Corrección tras la verificación en vivo (19 nov): montada
   al final de la vista, la franja quedaba BAJO la gráfica y
   los totales y solo aparecía al bajar. Nace visible: se
   mueve directamente bajo la tarjeta protagonista. */
assert.ok(ui.includes('const tarjetaPpd2916 = facturasPpdTarjeta240(datos240);') &&
  ui.includes('tarjetaPpd2916.after(franja2916);'),
  'la franja se mueve directamente bajo la tarjeta «PPD sin REP», por encima de la gráfica y los totales');

/* ── La ficha lateral del CFDI ───────────────────────────── */
assert.ok(html.includes('dialog.invoice-dialog.cfdi-dialog{position:fixed;inset:0 0 0 auto'),
  'el detalle se ancla a la derecha como ficha lateral');
assert.ok(html.includes('height:100dvh'), 'la ficha va a todo el alto');
assert.ok(workflows.includes("dialog('Detalle del CFDI', contents);"),
  'el detalle se sigue componiendo igual (mismo contenido, otro ancla)');
assert.ok(workflows.includes("if (!$('dialog').open) $('dialog').classList.remove('invoice-dialog', 'cfdi-dialog');"),
  'al cerrar, el diálogo compartido no hereda el ancla a otros diálogos; si ya se reabrió (Revertir pago), las clases se quedan');

/* ── Registro: los filtros invisibles, por fin montados ──── */
assert.ok(registro.includes('filtros.append(selRfc, selClase, buscarTexto, selOrden);'),
  'contribuyente, clase, buscador y orden se montan en la franja del Registro');
assert.ok(registro.includes("let registroOrden2916 = 'recientes';"),
  'el orden del Registro existe y nace en el de siempre');
assert.ok(registro.includes("registroOrden2916 === 'antiguos' ? [...(data.items || [])].reverse()"),
  'el orden inverso se aplica a lo cargado, sin otra petición');
assert.ok(registro.includes("' · lo más antiguo primero.'") && registro.includes("' · lo más reciente primero.'"),
  'la línea resumen dice el orden en curso');
assert.ok(registro.includes("activosReg2916.push(['Contribuyente: ' + registroFiltro.rfc"),
  'el Registro enseña sus filtros activos con aspa, como Facturas');
assert.ok(registro.includes("franja2916.append(filtros);") && registro.includes('body.append(franja2916);'),
  'la franja del Registro se monta junta y fija sobre la lista');
/* Los selectores conservan su comportamiento de siempre:
   su cambio persiste y repinta (no se reinventó el filtro). */
assert.ok(registro.includes('registroGuardarFiltro1310(); pintar(); };'),
  'el filtro del Registro sigue persistiendo al cambiar');

console.log('ronda2916tablas: OK — franjas fijas, tabla de Facturas aligerada, ficha lateral y filtros del Registro por fin visibles.');
