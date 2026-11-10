/* Generador de pagos (1.10.0): catálogo de beneficiarios por RFC,
   validación de cuentas y CLABE, y construcción de la preparación
   de pagos para los grupos de BBVA (en pantalla, como los captura
   Paco) y para el futuro navegador del NAS (JSON).

   Hechos que manda el banco (ayuda oficial de Grupos BBVA e
   Interbancarios pegada por Paco el 9 nov 2026 y rejillas reales
   vistas ese día):
   - Grupo BBVA: por operación solo Cuenta (10 posiciones) e Importe;
     el nombre lo pone la validación del banco. Cifras de control:
     número de operaciones e importe total del grupo.
   - Grupo Interbancario: por operación Nombre, Cuenta CLABE,
     Importe, Motivo de Pago, RFC e IVA; el grupo lleva fecha de
     cargo y fecha de abono separadas y una Referencia Numérica.
   - TOPE observado el 9 nov 2026 en la rejilla interbancaria: al
     teclear un importe de $80,040 el banco respondió «El valor
     capturado debe ser máximo 49999.99». Mientras ese tope exista,
     las líneas interbancarias que lo superan se apartan y se
     proponen por SPEI individual (sin tope de grupo). */

export const TOPE_INTERBANCARIO_CENTS = 4999999; /* $49,999.99 */

const BANCOS_POR_CLABE = {
  '002': 'Banamex', '012': 'BBVA', '014': 'Santander', '021': 'HSBC',
  '030': 'Banco del Bajío', '072': 'Banorte', '127': 'Banco Azteca',
  '646': 'STP'
};

export const bancoDeClabe = clabe => BANCOS_POR_CLABE[String(clabe || '').slice(0, 3)] || '';

/* Dígito de control CLABE: sobre los primeros 17 dígitos, pesos
   3-7-1 repetidos, cada producto reducido módulo 10; el dígito es
   (10 − (suma mod 10)) mod 10. */
export function digitoControlClabe(clabe17) {
  const pesos = [3, 7, 1];
  let suma = 0;
  for (let i = 0; i < 17; i++) suma += (Number(clabe17[i]) * pesos[i % 3]) % 10;
  return String((10 - (suma % 10)) % 10);
}

export function validarClabe(clabe) {
  const limpia = String(clabe || '').replace(/[\s-]/g, '');
  if (!/^\d{18}$/.test(limpia))
    return { ok: false, clabe: limpia, error: 'La CLABE debe tener exactamente 18 dígitos.' };
  if (digitoControlClabe(limpia) !== limpia[17])
    return { ok: false, clabe: limpia, error: 'El dígito de control de esa CLABE no cuadra: revisa el número dígito a dígito, puede mandar el dinero a otra cuenta.' };
  return { ok: true, clabe: limpia, error: '' };
}

export function validarCuentaBbva(cuenta) {
  const limpia = String(cuenta || '').replace(/[\s-]/g, '');
  if (!/^\d{10}$/.test(limpia))
    return { ok: false, cuenta: limpia, error: 'La cuenta BBVA debe tener exactamente 10 dígitos.' };
  return { ok: true, cuenta: limpia, error: '' };
}

const RFC_RE = /^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/;
export const rfcValido = rfc => RFC_RE.test(String(rfc || '').trim().toUpperCase());

const cents = value => {
  const n = Math.round(Number(value) * 100);
  return Number.isFinite(n) ? n : NaN;
};
export const pesosTexto = centsValue => {
  const abs = Math.abs(Math.round(centsValue));
  return (centsValue < 0 ? '-' : '') + Math.floor(abs / 100) + '.' + String(abs % 100).padStart(2, '0');
};
export const pesosBonito = centsValue => {
  const [ent, dec] = pesosTexto(centsValue).split('.');
  return ent.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + dec;
};

/* Normaliza y valida un beneficiario del catálogo. Lanza Error con
   el mensaje en español llano que la pantalla enseña tal cual. */
export function normalizarBeneficiario(x = {}) {
  const fail = message => { throw new Error(message); };
  const nombre = String(x.nombre || '').trim().replace(/\s+/g, ' ');
  if (nombre.length < 3) fail('Falta la razón social del beneficiario.');
  const tipo = x.tipo === 'cliente' ? 'cliente' : 'proveedor';
  const contraparte = String(x.contraparte || '').trim().toUpperCase();
  if (!rfcValido(contraparte)) fail('El RFC de «' + nombre + '» no tiene la forma de un RFC válido.');
  let cuenta = '', clabe = '';
  if (String(x.clabe || '').trim()) {
    const v = validarClabe(x.clabe);
    if (!v.ok) fail(v.error);
    clabe = v.clabe;
  }
  if (String(x.cuenta || '').trim()) {
    const v = validarCuentaBbva(x.cuenta);
    if (!v.ok) fail(v.error);
    cuenta = v.cuenta;
  }
  if (!cuenta && !clabe) fail('Falta la cuenta (10 dígitos BBVA) o la CLABE (18 dígitos) de «' + nombre + '».');
  let grupo = ['BBVA', 'Interbancario'].includes(x.grupo) ? x.grupo : '';
  if (!grupo) grupo = cuenta ? 'BBVA' : 'Interbancario';
  if (grupo === 'BBVA' && !cuenta) fail('Para el grupo BBVA hace falta la cuenta de 10 dígitos de «' + nombre + '» (la rejilla de ese grupo no acepta CLABE).');
  if (grupo === 'Interbancario' && !clabe) fail('Para el grupo Interbancario hace falta la CLABE de 18 dígitos de «' + nombre + '».');
  const banco = String(x.banco || '').trim() || (clabe ? bancoDeClabe(clabe) : 'BBVA');
  const montoTipo = x.montoTipo === 'fijo' ? 'fijo' : 'variable';
  let baseCents = 0, ivaCents = 0;
  if (montoTipo === 'fijo') {
    baseCents = cents(x.base);
    if (!Number.isFinite(baseCents) || baseCents <= 0) fail('Un pago fijo necesita su importe base (sin IVA) mayor que cero.');
    ivaCents = x.iva === undefined || x.iva === null || x.iva === '' ? Math.round(baseCents * 0.16) : cents(x.iva);
    if (!Number.isFinite(ivaCents) || ivaCents < 0) fail('El IVA del pago fijo no es un importe válido.');
  }
  const periodicidad = ['mensual', 'quincenal', 'unico'].includes(x.periodicidad) ? x.periodicidad : 'mensual';
  return {
    id: String(x.id || ''), tipo, nombre, contraparte, banco, cuenta, clabe, grupo,
    concepto: String(x.concepto || '').trim().slice(0, 120),
    montoTipo, base: pesosTexto(baseCents), iva: pesosTexto(ivaCents), periodicidad,
    activo: x.activo === false || x.activo === 0 ? 0 : 1
  };
}

/* Valida una línea ya armada (venga de un CFDI, de un fijo o tecleada)
   y la deja en la forma canónica de la preparación. */
export function normalizarLinea(x = {}) {
  const fail = message => { throw new Error(message); };
  const nombre = String(x.nombre || '').trim().replace(/\s+/g, ' ');
  if (nombre.length < 3) fail('Una línea de pago no trae beneficiario.');
  const grupo = x.grupo === 'BBVA' ? 'BBVA' : 'Interbancario';
  let cuenta = '', clabe = '';
  if (grupo === 'BBVA') {
    const v = validarCuentaBbva(x.cuenta);
    if (!v.ok) fail('«' + nombre + '»: ' + v.error);
    cuenta = v.cuenta;
  } else {
    const v = validarClabe(x.clabe);
    if (!v.ok) fail('«' + nombre + '»: ' + v.error);
    clabe = v.clabe;
  }
  const totalCents = cents(x.total);
  if (!Number.isFinite(totalCents) || totalCents <= 0) fail('«' + nombre + '»: el importe a pagar debe ser mayor que cero.');
  const baseCents = x.base === undefined || x.base === null || x.base === '' ? 0 : cents(x.base);
  const ivaCents = x.iva === undefined || x.iva === null || x.iva === '' ? 0 : cents(x.iva);
  if (!Number.isFinite(baseCents) || !Number.isFinite(ivaCents)) fail('«' + nombre + '»: base o IVA con importe inválido.');
  return {
    beneficiaryId: String(x.beneficiaryId || ''), nombre,
    rfc: String(x.rfc || '').trim().toUpperCase(),
    banco: String(x.banco || '').trim(), grupo, cuenta, clabe,
    motivo: String(x.motivo || '').trim().slice(0, 120),
    folio: String(x.folio || '').trim().slice(0, 40),
    uuid: String(x.uuid || '').trim(),
    fijo: Boolean(x.fijo), baseCents, ivaCents, totalCents
  };
}

/* Arma la preparación: separa por grupo, aparta las interbancarias
   sobre el tope para SPEI individual y calcula las cifras de
   control de cada grupo (operaciones y total). */
export function construirPreparacion({ rfc = '', month = '', group = {}, lines = [] } = {}) {
  const limpias = lines.map(normalizarLinea);
  const bbva = [], inter = [], spei = [];
  for (const linea of limpias) {
    if (linea.grupo === 'BBVA') bbva.push(linea);
    else if (linea.totalCents > TOPE_INTERBANCARIO_CENTS) spei.push({ ...linea, sobreTope: true });
    else inter.push(linea);
  }
  const control = lista => ({ operaciones: lista.length,
    totalCents: lista.reduce((sum, linea) => sum + linea.totalCents, 0) });
  const datosGrupo = {
    descripcion: String(group.descripcion || 'PROVEEDORES').trim().slice(0, 60) || 'PROVEEDORES',
    cuentaRetiro: String(group.cuentaRetiro || '').replace(/[\s-]/g, ''),
    referencia: String(group.referencia || '').trim().slice(0, 20),
    fechaCargo: String(group.fechaCargo || '').trim(),
    fechaAbono: String(group.fechaAbono || '').trim(),
    fechaAplicacion: String(group.fechaAplicacion || '').trim()
  };
  return {
    version: 1, rfc: String(rfc || ''), month: String(month || ''), group: datosGrupo,
    bbva: { lines: bbva, ...control(bbva) },
    interbancario: { lines: inter, ...control(inter) },
    speiIndividual: { lines: spei, ...control(spei) },
    totalCents: limpias.reduce((sum, linea) => sum + linea.totalCents, 0),
    operaciones: limpias.length
  };
}

const fechaBonita = iso => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  return match ? match[3] + '/' + match[2] + '/' + match[1] : String(iso || '');
};

/* La salida en texto: un valor por línea y etiquetado, como las
   plantillas que Paco capturó a mano el 9 nov — porque los campos
   del banco son de una línea y al pegar bloques solo entra la
   primera parte. */
export function preparacionTxt(prep) {
  const out = [];
  const titulo = (texto, sub) => { out.push(texto); out.push('='.repeat(70)); if (sub) out.push(sub); };
  if (prep.bbva.lines.length) {
    titulo('GRUPO BBVA — Transferencias masivas > Tradicional (Grupos BBVA) > Alta');
    out.push('Descripción:', prep.group.descripcion, '');
    out.push('Cuenta de retiro:', prep.group.cuentaRetiro || '(elige la cuenta de cheques en el banco)', '');
    out.push('Fecha de aplicación:', fechaBonita(prep.group.fechaAplicacion) || '(la del día de pago)', '');
    out.push('DETALLE DE OPERACIONES (cuenta e importe, campo a campo)');
    prep.bbva.lines.forEach((linea, i) => {
      out.push('Operación ' + (i + 1) + ' — Cuenta:', linea.cuenta);
      out.push('Operación ' + (i + 1) + ' — Importe:', pesosTexto(linea.totalCents), '');
    });
    out.push('VERIFICAR ANTES DE GUARDAR');
    out.push('Número de operaciones: ' + prep.bbva.operaciones);
    out.push('Importe de cargo: $' + pesosBonito(prep.bbva.totalCents), '', '');
  }
  if (prep.interbancario.lines.length) {
    titulo('GRUPO INTERBANCARIO — Transferencias masivas > Tradicional (Grupos Interbancarios) > Alta');
    out.push('Descripción:', prep.group.descripcion, '');
    out.push('Cuenta de retiro:', prep.group.cuentaRetiro || '(elige la cuenta de cheques en el banco)', '');
    out.push('Referencia Numérica:', prep.group.referencia || '(la que uses para identificar los depósitos)', '');
    out.push('Fecha de cargo:', fechaBonita(prep.group.fechaCargo) || '(el día en que entra el dinero)', '');
    out.push('Fecha de abono:', fechaBonita(prep.group.fechaAbono) || '(el día siguiente al cargo)', '');
    out.push('DETALLE DE OPERACIONES (nombre, CLABE, importe, motivo, RFC e IVA, campo a campo)');
    prep.interbancario.lines.forEach((linea, i) => {
      const n = 'Operación ' + (i + 1) + ' — ';
      out.push(n + 'Nombre:', linea.nombre);
      out.push(n + 'Cuenta CLABE:', linea.clabe);
      out.push(n + 'Importe:', pesosTexto(linea.totalCents));
      out.push(n + 'Motivo de Pago:', linea.motivo || linea.folio || '');
      out.push(n + 'RFC:', linea.rfc);
      out.push(n + 'IVA:', pesosTexto(linea.ivaCents), '');
    });
    out.push('VERIFICAR ANTES DE GUARDAR');
    out.push('Número de operaciones: ' + prep.interbancario.operaciones);
    out.push('Importe de cargo: $' + pesosBonito(prep.interbancario.totalCents), '', '');
  }
  if (prep.speiIndividual.lines.length) {
    titulo('POR SPEI INDIVIDUAL — fuera de los grupos',
      'Estas líneas superan el tope de $49,999.99 por operación que la rejilla de grupos ' +
      'interbancarios marcó el 9 nov 2026. Se pagan una a una desde Operaciones frecuentes.');
    for (const linea of prep.speiIndividual.lines) {
      out.push('Beneficiario:', linea.nombre);
      out.push('CLABE:', linea.clabe);
      out.push('Importe:', pesosTexto(linea.totalCents));
      out.push('Motivo:', linea.motivo || linea.folio || '');
      out.push('RFC:', linea.rfc, '');
    }
    out.push('Total por SPEI individual: $' + pesosBonito(prep.speiIndividual.totalCents) +
      ' (' + prep.speiIndividual.operaciones + ' operaciones)', '');
  }
  out.push('TOTAL A PAGAR: $' + pesosBonito(prep.totalCents) + ' en ' + prep.operaciones + ' operaciones');
  return out.join('\n');
}

/* Precarga verificada de Mano Fil (9 nov 2026): las cuentas y CLABE
   son las de las «operaciones frecuentes» de su sesión BBVA y las
   tres CLABE pasan su dígito de control; los importes variables
   salen de las facturas de cada cierre. BG es la cuota fija de
   contabilidad: $9,030.00 + IVA al mes. */
export const MANOFIL_SEED_RFC = 'MFI6212158B4';
export const MANOFIL_SEED = [
  { tipo: 'proveedor', nombre: 'GARCIA RIVERA CONTADORES Y CIA', contraparte: 'GRC131111298',
    banco: 'Santander', clabe: '014650655112091507', grupo: 'Interbancario',
    concepto: 'IGUALA MENSUAL', montoTipo: 'variable', periodicidad: 'mensual' },
  { tipo: 'proveedor', nombre: 'INMOBILIARIA, PROYECTOS Y CONSTRUCCIONES BRISBANE', contraparte: 'IPC2502209B0',
    banco: 'BBVA', cuenta: '0125298652', grupo: 'BBVA',
    concepto: 'SERVICIO DE COBRANZA', montoTipo: 'variable', periodicidad: 'mensual' },
  { tipo: 'proveedor', nombre: 'ACEROS INGENIERIA Y CONSTRUCCION RT', contraparte: 'AIC150804PQ2',
    banco: 'Banco del Bajío', clabe: '030650900032464956', grupo: 'Interbancario',
    concepto: 'SERVICIO DE COBRANZA', montoTipo: 'variable', periodicidad: 'mensual' },
  { tipo: 'proveedor', nombre: 'BG ASOCIADOS CONTABLES', contraparte: 'BAC260401MH8',
    banco: 'Banamex', clabe: '002650702367144601', grupo: 'Interbancario',
    concepto: 'CONTABILIDAD MENSUAL', montoTipo: 'fijo', base: 9030, iva: 1444.80, periodicidad: 'mensual' }
];
