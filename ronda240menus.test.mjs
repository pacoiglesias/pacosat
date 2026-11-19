/* ================================================================
   Ronda 2.4.0 · W4d — Menús laterales sin esconder nada + buscador
   que encuentra FUNCIONES + arreglo del botón roto de bitácora.
   (a) La barra lateral del artefacto contiene TODOS los destinos
       del inventario de vistas (screens leído del propio
       artefacto; la única excepción declarada es «sat», vista
       virtual que navigate() traduce a sus cinco destinos, todos
       con entrada propia), cada botón con title (nombre
       accesible), punto de señal y línea de estado en el DOM.
   (b) Plegada: el punto de señal y el title quedan — la hoja de
       la barra plegada no oculta la señal (nav-dot240) y los
       estados siguen en el DOM.
   (c) El buscador de funciones (índice del cliente, función pura)
       resuelve las frases del catálogo obligatorio — con
       sinónimos y acentos — a su vista/destino exactos, y una
       consulta sin función devuelve null (el buscador de
       documentos sigue su curso).
   (d) El botón viejo «Exportar bitácora (CSV)» ya no llama al
       csvText de FACTURAS: usa bitacoraCsv240, cuyo CSV sale con
       las columnas de la bitácora y sus filas de juguete; el
       csvText de facturas sigue intacto con su cabecera CFDI.
   ================================================================ */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const ROOT = import.meta.dirname;
const html = readFileSync(join(ROOT, 'Faro-Fiscal.html'), 'utf8');

/* ---------- Inventario de vistas, leído del propio artefacto ---------- */
const screensBloque = html.match(/const screens = \{([\s\S]*?)\n\};/);
assert.ok(screensBloque, 'el artefacto trae el mapa screens');
const vistas = [...screensBloque[1].matchAll(/^([a-z]+): \[/gm)].map(m => m[1]);
assert.ok(vistas.length >= 20, 'inventario de vistas amplio: ' + vistas.length);

/* ---------- (a) Barra lateral completa ---------- */
const navIni = html.indexOf('<nav aria-label="Navegación principal">');
const navFin = html.indexOf('</nav>', navIni);
assert.ok(navIni >= 0 && navFin > navIni, 'la barra lateral existe en el artefacto');
const nav = html.slice(navIni, navFin);
const botones = [...nav.matchAll(/<button data-view="([a-z]+)"([^>]*)>([\s\S]*?)<\/button>/g)]
  .map(m => ({ vista: m[1], attrs: m[2], cuerpo: m[3] }))
  /* La fila «Trabajos en curso» (nav-jobs) también llevaba
     data-view="home": era una señal de trabajos, no una entrada
     de destino. La 2.8.0 (diseño 11) la retira del menú; el
     filtro queda como guarda inocua. */
  .filter(b => !b.attrs.includes('nav-jobs-main'));
const enBarra = botones.map(b => b.vista);
for (const vista of vistas) {
  if (vista === 'sat') continue; /* virtual: la traducen sus cinco destinos */
  assert.ok(enBarra.includes(vista), 'la barra enseña el destino «' + vista + '» a la vista');
}
for (const vista of enBarra) assert.ok(vistas.includes(vista), 'sin destinos inventados en la barra: ' + vista);
assert.equal(new Set(enBarra).size, enBarra.length, 'sin destinos duplicados en la barra');
for (const b of botones) {
  assert.ok(b.attrs.includes('title="'), '«' + b.vista + '» lleva title (su nombre accesible)');
  /* RE-BASE 2.9.0 (Bloque C, auditoría viva): el punto
     nav-dot240 era decorativo — ningún código pintaba estado
     en él (paintNavDots1312 busca [data-nav-dot], que no
     existe en la barra) — y la auditoría lo retiró por ruido
     («puntos grises idénticos sin leyenda en todos los
     destinos»). La regla nueva: SIN punto decorativo; el
     estado vive en la línea de estado y las insignias. */
  assert.ok(!b.cuerpo.includes('nav-dot240'), '«' + b.vista + '» sin punto decorativo (2.9.0: fuera el ruido sin estado)');
  /* RE-BASE 2.8.0 (diseño 6): la segunda línea SOLO existe
     cuando trae estado vivo — la descripción estática truncada
     que W4d ponía en los 22 destinos desaparece. Se pina la
     regla nueva EXACTA: nav-estado201 presente si y solo si el
     destino es uno de los cuatro con estado vivo. */
  const conEstadoVivo = ['declaraciones', 'tributario', 'lists', 'ejecutor'].includes(b.vista);
  assert.equal(b.cuerpo.includes('nav-estado201'), conEstadoVivo,
    '«' + b.vista + '» ' + (conEstadoVivo ? 'lleva' : 'NO lleva') + ' línea de estado (solo estado vivo, diseño 6)');
}
/* Los estados dinámicos de siempre siguen siendo los suyos. */
for (const id of ['lists-menu-estado201', 'buzon-menu-estado202', 'decl-menu-estado202', 'news-badge', 'avisos-badge'])
  assert.ok(nav.includes('id="' + id + '"'), 'el estado dinámico ' + id + ' sigue en su entrada');

/* ---------- (b) Plegada: la señal no se oculta ---------- */
const css = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] || '';
assert.ok(!/barra-plegada[^{}]*\{[^}]*nav-dot240[^}]*display:\s*none/.test(css),
  'ninguna regla de la barra plegada oculta el punto de señal');
assert.ok(!/barra-plegada[^{}]*\{[^}]*puerta-dot[^}]*display:\s*none/.test(css),
  'ninguna regla de la barra plegada oculta la clase del punto');

/* ---------- Móvil: la barra inferior + «Más» al menú completo ---------- */
const bottom = html.slice(html.indexOf('<nav class="bottombar"'), html.indexOf('</nav>', html.indexOf('<nav class="bottombar"')));
assert.ok(bottom.includes('id="more-button"') && bottom.includes('menú completo'),
  'en móvil, «Más» anuncia que abre el menú completo con todos los destinos');

/* ---------- (c) Buscador de funciones: resolver puro ---------- */
const iniCat = html.indexOf('const FUNCIONES240 =');
const finCat = html.indexOf('(function buscadorFunciones240()');
assert.ok(iniCat >= 0 && finCat > iniCat, 'el catálogo de funciones vive en el artefacto');
const ctx = vm.createContext({ setTimeout, clearTimeout });
const { FUNCIONES240, funcionBuscador240 } = vm.runInContext(
  html.slice(iniCat, finCat) + '\n;({ FUNCIONES240, funcionBuscador240 });', ctx);
assert.ok(Array.isArray(FUNCIONES240) && FUNCIONES240.length >= 30, 'catálogo amplio: ' + FUNCIONES240.length);
const casos = [
  ['exportar bitácora', 'salud', 'bitacora'],
  ['Exportar bitácora (CSV)', 'salud', 'bitacora'],
  ['bajar constancia', 'docs', 'hero:constancia'],
  ['descargar la constancia de situación fiscal', 'docs', 'hero:constancia'],
  ['bajar opinión', 'docs', 'hero:opinion'],
  ['conciliar', 'bancos', undefined],
  ['qué cambió', 'home', 'cambios'],
  ['que cambio desde ayer', 'home', 'cambios'],
  ['modo histórico', 'settings', undefined],
  ['paquete para el banco', 'docs', 'banco240'],
  ['buscar dentro de los documentos', 'docs', 'buscar-dentro'],
  ['listas negras', 'lists', undefined],
  ['restaurar', 'backup', undefined],
  ['respaldo', 'backup', undefined],
  ['enviar', 'reportes', undefined],
  ['enviar acuse', 'declaraciones', undefined],
  ['comparativo', 'home', undefined],
  ['ppd sin rep', 'invoices', undefined],
  ['cuota de descargas', 'descargar', undefined],
  ['buzon completo', 'tributario', undefined],
  ['ir a conciliar', 'bancos', undefined]
];
for (const [frase, vista, destino] of casos) {
  const hit = funcionBuscador240(frase);
  assert.ok(hit, '«' + frase + '» encuentra su función');
  assert.equal(hit.vista, vista, '«' + frase + '» lleva a ' + vista + ' (fue ' + hit.vista + ')');
  if (destino !== undefined) assert.equal(hit.destino, destino, '«' + frase + '» aterriza en ' + destino);
}
assert.equal(funcionBuscador240('modo histórico')?.seccion, 'general', 'el modo histórico abre Ajustes en General');
assert.equal(funcionBuscador240('zzz sin sentido ninguno'), null, 'sin función que case, null: manda el buscador de documentos');
assert.equal(funcionBuscador240(''), null, 'consulta vacía, null');
/* La franja que distingue la función de un documento existe. */
assert.ok(html.includes('id="funcion-sugerida240"') && html.includes('id="funcion-sugerida240-ir"'),
  'la franja «Función» de la cabecera existe en el artefacto');
assert.ok(html.includes('Buscar UUID, RFC o una función'), 'el buscador anuncia que también encuentra funciones');
/* El oyente de funciones se registra antes que el de documentos. */
assert.ok(html.indexOf('buscadorFunciones240') < html.indexOf('runGlobalSearch'),
  'el oyente de funciones va antes en el artefacto que el camino de documentos');

/* ---------- (d) CSV de bitácora del botón viejo ---------- */
assert.ok(!html.includes('encode(csvText(rows))'), 'ningún botón llama ya al csvText de facturas con filas de bitácora');
/* RE-BASE 2.8.0 (diseño 10): el botón viejo de Ajustes ya no
   existe — la exportación de la bitácora vive SOLO en
   Registro («Exportar CSV») — y ningún botón «Exportar
   bitácora (CSV)» queda en el artefacto. El helper
   bitacoraCsv240 se conserva y se sigue probando abajo. */
assert.ok(!html.includes('Exportar bitácora (CSV)'), 'ningún botón «Exportar bitácora (CSV)» queda fuera de Registro (diseño 10)');
const iniCsv = html.indexOf('function bitacoraCsv240');
assert.ok(iniCsv >= 0, 'el helper bitacoraCsv240 vive en el artefacto');
const csvCtx = vm.createContext({});
const bitacoraCsv240 = vm.runInContext(html.slice(iniCsv, html.indexOf('function activityPanel()', iniCsv)) + '\n;bitacoraCsv240;', csvCtx);
const juguete = [
  { date: '2026-11-17T10:05:00', name: 'SAT "prueba"', event: 'Descarga, con éxito' },
  { date: '2026-11-17T11:00:00', name: 'Sistema', event: '' }
];
assert.equal(bitacoraCsv240(juguete),
  '"fecha","nombre","evento"\r\n"2026-11-17T10:05:00","SAT ""prueba""","Descarga, con éxito"\r\n"2026-11-17T11:00:00","Sistema",""',
  'el CSV de bitácora sale con sus columnas y sus filas, escapado como el de Salud');
assert.equal(bitacoraCsv240([]), '"fecha","nombre","evento"', 'sin filas, solo la cabecera de la bitácora');
/* Y el csvText de FACTURAS sigue siendo el de facturas. */
const iniFact = html.indexOf('function csvText(rows)');
assert.ok(iniFact >= 0, 'el csvText de facturas sigue en el artefacto');
const factCtx = vm.createContext({ KINDS: { I: 'Ingreso' } });
const csvText = vm.runInContext(html.slice(iniFact, html.indexOf('function exportCsv()', iniFact)) + '\n;csvText;', factCtx);
const facturaJuguete = [{ id: 'UUID-1', from: { name: 'Emisor SA', rfc: 'AAA010101AAA' },
  to: { name: 'Receptor SA', rfc: 'BBB020202BBB' }, date: '2026-11-01', kind: 'I', total: 100, currency: 'MXN' }];
assert.ok(csvText(facturaJuguete).startsWith('"UUID","Emisor","RFC emisor"'),
  'el csvText de facturas conserva su cabecera CFDI: no se tocó');

console.log('OK 2.4.0 · W4d — barra con todos los destinos y sus estados, buscador de funciones con sinónimos y CSV de bitácora del botón viejo correcto.');
