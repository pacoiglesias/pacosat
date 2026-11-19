/* ===== Ronda 2.9.0 · Bloque C: la verdad de la auditoría viva =====
   (a) Con paseo='nas' ningún texto de acusación al ejecutor se
   pinta en las vistas tocadas; con 'remoto' el camino de
   emparejamiento existe. (b) Dinero, Cierre y Preguntas usan LA
   MISMA función canónica de por cobrar — por construcción (las
   tres partes la llaman) y por igualdad de resultado sobre
   datos semilla, en su ruta local y en su ruta de servidor.
   (c) La tarjeta de actividad se instancia una sola vez y sin
   clase flotante. (d) El saneador de la traza del Registro no
   deja literales de concatenación. (e) La función de plural
   produce «1 día»/«2 días». */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const ROOT = import.meta.dirname;
const read = name => readFileSync(join(ROOT, name), 'utf8');
const html = read('Faro-Fiscal.html');
const server = read('local-server.mjs');
const ui = read('ui.part');
const moneyUi = read('money-ui.part');
const outputsUi = read('outputs-ui.part');
const finalUi = read('final-ui.part');
const tribUi = read('tributario-ui.part');
const monitorUi = read('monitor-ui.part');
const design = read('design.part');
const RFC = 'AAA010101AAA';

function extraer(htmlFuente, desde, hasta) {
  const ini = htmlFuente.indexOf(desde);
  const fin = htmlFuente.indexOf(hasta, ini);
  assert.ok(ini >= 0 && fin > ini, 'segmento presente: ' + desde);
  return htmlFuente.slice(ini, fin);
}

/* ---------- (a) Verdad de sede ---------- */
{
  /* La palabra corta junto al punto: con sede nas, «sin equipo»
     no puede salir aunque el porqué viejo lo trajera. */
  const seg = extraer(html, 'function saludPalabraCorta290', 'function pintarBotonScope200b');
  const ctxNas = vm.createContext({ console, satData: { paseo: 'nas' } });
  const palabraNas = vm.runInContext(seg + '\n;saludPalabraCorta290;', ctxNas);
  const conEquipo = palabraNas({ nivel: 'warn', porque: 'tu equipo no responde desde ayer' });
  assert.ok(!/equipo/.test(conEquipo), 'con sede nas la palabra no acusa al equipo: «' + conEquipo + '»');
  assert.equal(conEquipo, 'a vigilar');
  const ctxRem = vm.createContext({ console, satData: { paseo: 'remoto' } });
  const palabraRem = vm.runInContext(seg + '\n;saludPalabraCorta290;', ctxRem);
  assert.equal(palabraRem({ nivel: 'warn', porque: 'tu equipo no responde desde ayer' }), 'sin equipo',
    'con sede remoto el comportamiento 2.8.0 se conserva');

  /* El panel del ejecutor con sede nas es informativo y el
     emparejamiento sigue existiendo para sede remota. */
  assert.ok(tribUi.includes('El paseo se hace desde casa (tu NAS)'),
    'el destino «Tu ejecutor» con sede nas enseña la tarjeta informativa de casa');
  assert.ok(tribUi.includes('sedeNas290'), 'el panel gobierna sus textos por la sede en tiempo de ejecución');
  assert.ok(tribUi.includes('Emparejar un ejecutor en mi equipo') || tribUi.includes('emparejar'),
    'el camino de emparejamiento sigue en el código para instalaciones cliente');
  assert.ok(ui.includes("sd?.paseo !== 'nas'") && ui.includes("'Despertar el ejecutor'"),
    'el gesto «Despertar el ejecutor» del protagonista está cerrado con sede nas');
  assert.ok(!tribUi.includes("if (ejecutarAquiBtn) line.append(ejecutarAquiBtn)"),
    '«Abrir el Ejecutor local» ya no se pinta antes de saber la sede');

  /* El estado del Buzón es UNO: sin ultimaConsulta no hay
     «al día» posible, haya notificaciones guardadas o no. */
  const segB = extraer(html, 'function buzonEstado290', 'function buzonMenuTexto202');
  const ctxB = vm.createContext({ console, fechaCortaMenu202: () => '14 nov' });
  const buzonEstado290 = vm.runInContext(segB + '\n;buzonEstado290;', ctxB);
  const sinConsulta = buzonEstado290({ total: 5, sinAbrir: 0 });
  assert.equal(sinConsulta.consultado, false,
    'con notificaciones guardadas pero sin consulta registrada: no consta consultado');
  assert.equal(sinConsulta.texto, 'Sin consultar todavía');
  assert.equal(buzonEstado290({ ultimaConsulta: 1760000000000, sinAbrir: 0 }).consultado, true,
    'con última consulta registrada, el buzón consta consultado');
  console.log('OK 2.9.0 verdad · (a) sede nas sin acusaciones al ejecutor; buzón con una sola fuente.');
}

/* ---------- (b) Una sola cifra canónica ---------- */
{
  assert.ok(moneyUi.includes('porCobrarCanonico290('), 'Dinero usa la función canónica');
  assert.ok(outputsUi.includes('porCobrarCanonico290('), 'Cierre (Dinero y saldos) usa la función canónica');
  assert.ok(finalUi.includes('porCobrarCanonico290('), 'Preguntas usa la función canónica');

  const segTotal = extraer(html, 'function totalCents', 'const centsPlain');
  const segMoney = extraer(read('data.part'), 'function moneyCents', '/* IVA (impuesto 002)');
  const segCanon = extraer(html, 'function paidByMap', 'let saldosCarga290');
  const facturas = [
    { id: 'f1', kind: 'I', total: '1000.00', from: { rfc: RFC }, to: { rfc: 'CLI010101CLI' }, fiscal: { paymentMethod: 'PUE' } },
    { id: 'f2', kind: 'I', total: '500.00', from: { rfc: RFC }, to: { rfc: 'CLI010101CLI' }, fiscal: { paymentMethod: 'PPD' } },
    { id: 'f3', kind: 'I', total: '700.00', from: { rfc: RFC }, to: { rfc: 'CLI010101CLI' }, fiscal: { paymentMethod: 'PPD' } },
    { id: 'f4', kind: 'I', total: '900.00', from: { rfc: RFC }, to: { rfc: 'CLI010101CLI' }, fiscal: { paymentMethod: 'PPD' }, archived: true },
    { id: 'f5', kind: 'I', total: '300.00', from: { rfc: RFC }, to: { rfc: 'CLI010101CLI' }, fiscal: { paymentMethod: 'PPD' }, estadoSat: 'Cancelado' },
    { id: 'p1', kind: 'P', total: '0.00', from: { rfc: 'CLI010101CLI' }, to: { rfc: RFC },
      fiscal: { payments: { pagos: [{ documentos: [{ idDocumento: 'f2', impPagado: '200.00' }] }] } } },
  ];
  const base = {
    console, BigInt,
    people: [{ id: RFC }],
    invoices: facturas,
    dineroMarcados: new Set(),
    invoiceStateOf: row => row.estadoSat || 'none',
  };
  const codigo = segTotal + '\n' + segMoney + '\n' + segCanon +
    '\n;({ porCobrarCanonico290, porPagarCanonico290 });';
  /* Ruta local (sin foto del servidor): REP cuenta, PUE nace
     pagada, archivada y cancelada fuera → 300 + 700. */
  const ctxLocal = vm.createContext({ ...base, dineroServerInfo: new Map() });
  const local = vm.runInContext(codigo, ctxLocal);
  const rLocal = local.porCobrarCanonico290('');
  assert.equal(rLocal.cents, 100000n, 'ruta local: por cobrar = $1,000.00 (REP y exclusiones)');
  assert.equal(rLocal.fuente, 'local');
  /* Ruta servidor (la foto de /api/money, que ya trae las
     marcas a mano): la MISMA cifra sobre el mismo hecho. */
  const ctxSrv = vm.createContext({ ...base, dineroServerInfo: new Map([
    ['f2', { id: 'f2', receivable: true, from: { rfc: RFC }, balance: '300.00' }],
    ['f3', { id: 'f3', receivable: true, from: { rfc: RFC }, balance: '700.00' }],
    ['f1', { id: 'f1', receivable: true, from: { rfc: RFC }, balance: '0.00' }],
  ]) });
  const srv = vm.runInContext(codigo, ctxSrv);
  const rSrv = srv.porCobrarCanonico290('');
  assert.equal(rSrv.cents, rLocal.cents, 'servidor y local dan LA MISMA cifra canónica');
  assert.equal(rSrv.fuente, 'servidor');
  assert.equal(srv.porCobrarCanonico290(RFC).cents, 100000n, 'con ámbito RFC, la misma cifra');
  assert.equal(srv.porCobrarCanonico290('OTR010101OTR').cents, 0n, 'otro RFC no se mezcla');
  console.log('OK 2.9.0 verdad · (b) por cobrar canónico: una función, una cifra, dos rutas de acuerdo.');
}

/* ---------- (c) Actividad: una vez, en flujo ---------- */
{
  const creaciones = monitorUi.split("jobsBox.id = 'activity-jobs'").length - 1;
  assert.equal(creaciones, 1, 'la tarjeta de trabajos se instancia una sola vez');
  assert.ok(monitorUi.includes("'activity-jobs290'") && !monitorUi.includes("'activity-dock'); jobsBox.id"),
    'la tarjeta usa su clase en flujo, no la del dock');
  assert.ok(!/\.activity-dock\{[^}]*position:(sticky|fixed)/.test(design),
    'la clase activity-dock ya no flota (sticky/fixed fuera)');
  assert.ok(design.includes('.activity-jobs290'), 'la clase en flujo existe en la hoja');
  assert.ok(monitorUi.includes("'home','buzon'") || monitorUi.includes('"home","buzon"') ||
    (monitorUi.includes("'home'") && monitorUi.includes("'buzon'")),
    'la supresión cubre Hoy y Novedades: sin doble «Trabajo en curso»');
  console.log('OK 2.9.0 verdad · (c) actividad una sola vez por pantalla y en flujo.');
}

/* ---------- (d) La traza del Registro, sin literales ---------- */
{
  const seg = extraer(server, 'const trazaTextoLimpio290', 'const detalleRun');
  const ctx = vm.createContext({ console });
  const fns = vm.runInContext(seg + '\n;({ trazaTextoLimpio290, pasoNormalizado290 });', ctx);
  const sucio = 'La página del momento enseñaba: " + item.value + "';
  const limpio = fns.trazaTextoLimpio290(sucio);
  assert.ok(!limpio.includes('" +') && !limpio.includes('item.value'),
    'el literal de concatenación desaparece: «' + limpio + '»');
  assert.ok(limpio.startsWith('La página del momento enseñaba:'));
  const paso = fns.pasoNormalizado290({ at: 5, text: 'Leyendo: " + x.y + "' });
  assert.ok(!paso.paso.includes('" +'), 'los pasos {text} también se normalizan limpios');
  console.log('OK 2.9.0 verdad · (d) la traza no filtra código literal.');
}

/* ---------- (e) Plural compartido ---------- */
{
  const seg = extraer(html, 'function plural290', 'const plegables290');
  const ctx = vm.createContext({ console });
  const fns = vm.runInContext(seg + '\n;({ plural290, diasTexto290 });', ctx);
  assert.equal(fns.diasTexto290(1), '1 día');
  assert.equal(fns.diasTexto290(2), '2 días');
  assert.equal(fns.diasTexto290(0), '0 días');
  assert.equal(fns.plural290(1, 'mes', 'meses'), '1 mes');
  console.log('OK 2.9.0 verdad · (e) plural: «1 día» / «2 días».');
}

console.log('OK ronda290verdad: sede, cifra única, actividad, traza y plural.');
