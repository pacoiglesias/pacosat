'use strict';
const $ = id => document.getElementById(id);
const KB = 1024;
const MB = KB * KB;
const RFC = /^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/u;
const UUID = /^[A-F0-9]{8}(?:-[A-F0-9]{4}){3}-[A-F0-9]{12}$/;
// Validador completo de RFC (1.6.1). Comprueba estructura, fecha embebida y el
// dígito verificador oficial del SAT (Anexo III y procedimiento publicados por
// el SAT: el valor de cada carácter es su posición en RFC_CHAR_VALUES —
// 0-9 valen 0-9, A-N valen 10-23, & vale 24, O-Z valen 25-36, el espacio vale
// 37 y Ñ vale 38 —; se pondera de 13 a 2 sobre la base de 12 posiciones, ante-
// poniendo un espacio cuando la base es de 11, y la suma módulo 11 da el
// dígito: residuo 0 → «0», residuo 1 → «A», otro residuo → 11 menos residuo).
// Es una validación DE FORMA: no confirma que el RFC exista en el SAT.
const RFC_GENERICS = new Set(['XAXX010101000', 'XEXX010101000']);
const RFC_CHAR_VALUES = '0123456789ABCDEFGHIJKLMN&OPQRSTUVWXYZ Ñ';
function rfcCheckDigit(base) {
  let body = String(base ?? '');
  if (body.length === 11) body = ' ' + body;
  if (body.length !== 12) return '';
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    const value = RFC_CHAR_VALUES.indexOf(body[i]);
    sum += (value < 0 ? 0 : value) * (13 - i);
  }
  const rest = sum % 11;
  if (!rest) return '0';
  const digit = 11 - rest;
  return digit === 10 ? 'A' : String(digit);
}
// Devuelve { rfc, type, generic, level, valid, digitExpected, digitOk, error }.
// level: 'structure' (error de estructura o de fecha, en error va el detalle),
// 'digit' (la forma es buena pero el dígito verificador no cuadra) o 'valid'.
// generic marca los RFC genéricos del SAT, que se aceptan con nota aunque su
// dígito no cuadre (XAXX010101000 no lo cumple por diseño).
function validateRfc(value) {
  const rfc = String(value ?? '').trim().toUpperCase();
  const result = { rfc, type: null, generic: RFC_GENERICS.has(rfc), level: 'structure', valid: false, digitExpected: null, digitOk: false, error: '' };
  const fail = message => { result.error = message; return result; };
  if (rfc.length !== 12 && rfc.length !== 13)
    return fail('El RFC debe tener 12 caracteres (persona moral) o 13 (persona física); este tiene ' + rfc.length + '.');
  const letters = rfc.length - 9;
  const letterPart = rfc.slice(0, letters), datePart = rfc.slice(letters, letters + 6),
    homoclave = rfc.slice(letters + 6, letters + 8), digit = rfc.slice(-1);
  if (!/^[A-ZÑ&]+$/.test(letterPart))
    return fail('Las ' + (letters === 4 ? 'cuatro' : 'tres') + ' primeras posiciones del RFC deben ser letras (se admiten Ñ y &).');
  if (!/^\d{6}$/.test(datePart))
    return fail('Después de las letras, el RFC lleva 6 dígitos con la fecha (año, mes y día).');
  const month = Number(datePart.slice(2, 4)), day = Number(datePart.slice(4, 6));
  const monthDays = [31, Number(datePart.slice(0, 2)) % 4 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12)
    return fail('La fecha del RFC trae un mes imposible (' + datePart.slice(2, 4) + '): debe ir de 01 a 12.');
  if (day < 1 || day > monthDays[month - 1])
    return fail('La fecha del RFC trae un día imposible (' + datePart.slice(4, 6) + ' para el mes ' + datePart.slice(2, 4) + ').');
  if (!/^[A-Z0-9]{2}$/.test(homoclave))
    return fail('La homoclave (las dos posiciones antes del último carácter) debe ser alfanumérica.');
  if (!/^[0-9A]$/.test(digit))
    return fail('El último carácter del RFC es el dígito verificador: debe ser un número o la letra A.');
  result.type = letters === 4 ? 'fisica' : 'moral';
  result.level = 'digit';
  result.digitExpected = rfcCheckDigit(rfc.slice(0, -1));
  result.digitOk = result.digitExpected === digit;
  if (result.digitOk) { result.level = 'valid'; result.valid = true; }
  return result;
}
const KINDS = { I: 'Ingreso', E: 'Egreso', P: 'Pago', N: 'Nómina', T: 'Traslado' };
const DOCUMENTS = ['Factura PDF', 'Constancia / CIF', 'Opinión de cumplimiento', 'Declaración', 'Acuse', 'Otro documento'];
const STORES = ['people', 'invoices', 'documents', 'files', 'activity'];
let db;

function check(condition, message) { if (!condition) throw new Error(message); }
function bytes(value) { return new Uint8Array(value); }
/* Estado de bloqueo del almacén local (1.6.8): «bloqueado» no es un
   fallo. Otra pestaña tiene la base abierta y la petición de apertura
   sigue viva; cuando esa pestaña se cierra, el navegador dispara
   onsuccess sobre la MISMA petición y la apertura se completa sola.
   Hasta la 1.6.7, onblocked rechazaba la promesa: el arranque quedaba
   muerto, `ready` nunca pasaba a true y cada acción se rendía con «El
   almacenamiento todavía no está disponible.», sin recuperación posible
   en esa sesión. Ahora el bloqueo se registra (isStorageBlocked) y la
   promesa espera; el error de verdad (onerror) sí rechaza. */
let storageBlocked = false;
function isStorageBlocked() { return storageBlocked; }
function openDatabase(name = 'faro-fiscal-v2') {
  return new Promise((resolve, reject) => {
    let request;
    try { request = indexedDB.open(name, 1); }
    catch (error) { reject(error); return; }
    request.onupgradeneeded = () => {
      for (const store of STORES) request.result.createObjectStore(store, { keyPath: 'id' });
    };
    request.onsuccess = () => {
      storageBlocked = false;
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => reject(request.error || new Error('El navegador no dejó abrir el almacenamiento local.'));
    request.onblocked = () => { storageBlocked = true; };
  });
}
function readStore(store, key) {
  if (typeof cloudStorage !== 'undefined' && cloudStorage) return cloudRead(store, key);
  return new Promise((resolve, reject) => {
    const table = db.transaction(store).objectStore(store);
    const req = key === undefined ? table.getAll() : table.get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function writeBatch(batch, replace = false) {
  if (typeof cloudStorage !== 'undefined' && cloudStorage) return cloudWrite(batch, replace);
  return new Promise((resolve, reject) => {
    const names = Object.keys(batch);
    const tx = db.transaction(names, 'readwrite');
    tx.oncomplete = resolve;
    tx.onabort = () => reject(tx.error || new Error('La operación se canceló.'));
    try {
      for (const name of names) {
        const table = tx.objectStore(name);
        if (replace) table.clear();
        for (const item of batch[name]) table.add(item);
      }
    } catch (error) {
      tx.abort();
      reject(error);
    }
  });
}
/* Borrado puntual (UX-07, 1.6.11): mantenimiento de cartera. En modo
   servidor lo registra la auditoría del servicio; en modo local borra
   de IndexedDB. No hay papelera: la app confirma antes con el detalle
   de lo que se va a eliminar. */
function deleteStoreRecords(store, ids) {
  if (typeof cloudStorage !== 'undefined' && cloudStorage) {
    if (typeof cloudMarks !== 'undefined') cloudMarks.delete(store);
    return satApi('data/delete', { store, ids });
  }
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.oncomplete = resolve;
    tx.onabort = () => reject(tx.error || new Error('La operación se canceló.'));
    const table = tx.objectStore(store);
    for (const id of ids) table.delete(id);
  });
}
function decodeXml(raw) {
  const lead = new TextDecoder('windows-1252').decode(raw.subarray(0, 256));
  const declaration = lead.match(/^\s*<\?xml[^>]*encoding\s*=\s*["']([^"']+)/i);
  const encoding = raw[0] === 255 && raw[1] === 254 ? 'utf-16le' :
    raw[0] === 254 && raw[1] === 255 ? 'utf-16be' :
    raw[0] === 60 && raw[1] === 0 ? 'utf-16le' :
    raw[0] === 0 && raw[1] === 60 ? 'utf-16be' : declaration?.[1] || 'utf-8';
  return new TextDecoder(encoding, { fatal: true }).decode(raw);
}
function parseXml(raw, Parser = DOMParser) {
  check(raw.length && raw.length <= 8 * MB, 'XML vacío o mayor de 8 MB.');
  const xml = decodeXml(raw);
  check(!/<!DOCTYPE|<!ENTITY/i.test(xml), 'El XML contiene declaraciones no admitidas.');
  const doc = new Parser().parseFromString(xml, 'application/xml');
  const root = doc.documentElement;
  check(root.localName === 'Comprobante' && /^http:\/\/www\.sat\.gob\.mx\/cfd\/[34]$/.test(root.namespaceURI) &&
    !doc.getElementsByTagName('parsererror').length, 'No es un CFDI 3.x o 4.0 con estructura XML válida.');
  const elements = node => Array.from(node?.children || node?.childNodes || []).filter(item => item.nodeType === 1);
  const child = (node, name) => elements(node).find(item => item.localName === name && item.namespaceURI === root.namespaceURI);
  const attr = (node, key, fallback = key) => node?.getAttribute(key) || node?.getAttribute(fallback) || '';
  const party = item => ({ rfc: attr(item, 'Rfc', 'rfc').toUpperCase(), name: attr(item, 'Nombre', 'nombre').slice(0, 300) });
  const from = party(child(root, 'Emisor'));
  const to = party(child(root, 'Receptor'));
  const stamp = child(root, 'Complemento')?.getElementsByTagNameNS('http://www.sat.gob.mx/TimbreFiscalDigital', 'TimbreFiscalDigital')[0];
  const uuid = attr(stamp, 'UUID').toUpperCase();
  const date = attr(root, 'Fecha', 'fecha');
  const total = attr(root, 'Total', 'total');
  const currency = attr(root, 'Moneda', 'moneda').toUpperCase();
  const legacy = { INGRESO: 'I', EGRESO: 'E', TRASLADO: 'T', PAGO: 'P', NÓMINA: 'N', NOMINA: 'N' };
  const rawKind = attr(root, 'TipoDeComprobante', 'tipoDeComprobante').toUpperCase();
  const kind = legacy[rawKind] || rawKind;
  const fromShape = validateRfc(from.rfc), toShape = validateRfc(to.rfc);
  check(fromShape.level !== 'structure', 'El RFC del emisor no es válido. ' + fromShape.error);
  check(toShape.level !== 'structure', 'El RFC del receptor no es válido. ' + toShape.error);
  check(UUID.test(uuid), 'Falta un UUID válido en el Timbre Fiscal Digital.');
  check(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(date), 'La fecha de emisión no tiene el formato esperado.');
  check(Object.hasOwn(KINDS, kind), 'El tipo de comprobante no es compatible con este importador.');
  check(/^\d{1,18}(?:\.\d{1,6})?$/.test(total), 'El total del comprobante no tiene el formato esperado.');
  check(!currency || /^[A-Z]{3}$/.test(currency), 'La moneda no tiene el formato esperado.');
  const concepts = elements(child(root, 'Conceptos')).filter(item => item.localName === 'Concepto' && item.namespaceURI === root.namespaceURI).slice(0, 20)
    .map(item => attr(item, 'Descripcion', 'descripcion').slice(0, 220));
  const seal = (attr(root, 'Sello', 'sello') || attr(stamp, 'SelloCFD', 'selloCFD')).slice(-8);
  return { id: uuid, from, to, date, kind, total, currency, concepts, seal };
}
/* Representación COMPLETA del comprobante para el visor profesional
   (1.6.7): cabecera, partes, conceptos con sus impuestos, totales con
   desglose, Timbre Fiscal Digital, complemento de Pagos 2.0 y nombre de
   cualquier otro complemento. A diferencia del importador (parseXml),
   es tolerante: un CFDI sin timbre o con datos incompletos se muestra
   igualmente, con el timbre en null. Los importes viajan como cadenas
   exactas del XML; nada se recalcula ni se inventa. La cadena original
   del timbre se GENERA desde los campos del propio TFD con el formato
   de la especificación del SAT (||1.1|UUID|Fecha|RFC PAC|Sello CFD|
   Nº certificado SAT||), como hace cualquier verificador. */
function parseCfdiFull(raw, Parser = DOMParser) {
  check(raw.length && raw.length <= 8 * MB, 'XML vacío o mayor de 8 MB.');
  const xml = decodeXml(raw);
  check(!/<!DOCTYPE|<!ENTITY/i.test(xml), 'El XML contiene declaraciones no admitidas.');
  const doc = new Parser().parseFromString(xml, 'application/xml');
  const root = doc.documentElement;
  check(root.localName === 'Comprobante' && /^http:\/\/www\.sat\.gob\.mx\/cfd\/[34]$/.test(root.namespaceURI) &&
    !doc.getElementsByTagName('parsererror').length, 'No es un CFDI con estructura XML válida.');
  const elements = node => Array.from(node?.children || node?.childNodes || []).filter(item => item.nodeType === 1);
  const child = (node, name) => elements(node).find(item => item.localName === name && item.namespaceURI === root.namespaceURI);
  const childNs = (node, name, ns) => elements(node).find(item => item.localName === name && item.namespaceURI === ns);
  const kids = (node, name) => elements(node).filter(item => item.localName === name && item.namespaceURI === root.namespaceURI);
  const attr = (node, key, fallback = key) => node?.getAttribute(key) || node?.getAttribute(fallback) || '';
  const taxesOf = node => {
    const wrap = child(node, 'Impuestos');
    const list = (holder, itemName, fields) => kids(child(wrap, holder), itemName).map(item =>
      Object.fromEntries(fields.map(([out, key]) => [out, attr(item, key)])));
    return {
      traslados: list('Traslados', 'Traslado', [['base', 'Base'], ['impuesto', 'Impuesto'], ['tipoFactor', 'TipoFactor'], ['tasa', 'TasaOCuota'], ['importe', 'Importe']]),
      retenciones: list('Retenciones', 'Retencion', [['base', 'Base'], ['impuesto', 'Impuesto'], ['importe', 'Importe'], ['tipoFactor', 'TipoFactor'], ['tasa', 'TasaOCuota']])
    };
  };
  const globalTaxes = taxesOf(root);
  const impuestosNode = child(root, 'Impuestos');
  const legacy = { INGRESO: 'I', EGRESO: 'E', TRASLADO: 'T', PAGO: 'P', NÓMINA: 'N', NOMINA: 'N' };
  const rawKind = attr(root, 'TipoDeComprobante', 'tipoDeComprobante').toUpperCase();
  const emisorNode = child(root, 'Emisor'), receptorNode = child(root, 'Receptor');
  const complemento = child(root, 'Complemento');
  const stamp = complemento?.getElementsByTagNameNS('http://www.sat.gob.mx/TimbreFiscalDigital', 'TimbreFiscalDigital')[0] || null;
  let timbre = null;
  if (stamp) {
    const t = { uuid: attr(stamp, 'UUID').toUpperCase(), fechaTimbrado: attr(stamp, 'FechaTimbrado'),
      rfcProvCertif: attr(stamp, 'RfcProvCertif'), noCertificadoSAT: attr(stamp, 'NoCertificadoSAT'),
      selloCfd: attr(stamp, 'SelloCFD'), selloSat: attr(stamp, 'SelloSAT'), version: attr(stamp, 'Version') || '1.1' };
    t.cadenaOriginal = '||' + t.version + '|' + t.uuid + '|' + t.fechaTimbrado + '|' + t.rfcProvCertif + '|' + t.selloCfd + '|' + t.noCertificadoSAT + '||';
    timbre = t;
  }
  let pagos = null;
  const pagosNode = complemento ? childNs(complemento, 'Pagos', 'http://www.sat.gob.mx/Pagos20') : null;
  if (pagosNode) {
    const ns = 'http://www.sat.gob.mx/Pagos20';
    const inNs = (node, name) => elements(node).filter(item => item.localName === name && item.namespaceURI === ns);
    const totalesNode = inNs(pagosNode, 'Totales')[0] || null;
    pagos = {
      totales: totalesNode ? Object.fromEntries(['TotalRetencionesIVA', 'TotalRetencionesISR', 'TotalRetencionesIEPS',
        'TotalTrasladosBaseIVA16', 'TotalTrasladosImpuestoIVA16', 'TotalTrasladosBaseIVA8', 'TotalTrasladosImpuestoIVA8',
        'TotalTrasladosBaseIVA0', 'TotalTrasladosImpuestoIVA0', 'TotalTrasladosBaseIVAExento', 'MontoTotalPagos']
        .map(key => [key, attr(totalesNode, key)]).filter(([, value]) => value !== '')) : {},
      pagos: inNs(pagosNode, 'Pago').map(pago => ({
        fechaPago: attr(pago, 'FechaPago'), formaDePagoP: attr(pago, 'FormaDePagoP'), monedaP: attr(pago, 'MonedaP'),
        tipoCambioP: attr(pago, 'TipoCambioP'), monto: attr(pago, 'Monto'), numOperacion: attr(pago, 'NumOperacion'),
        documentos: inNs(pago, 'DoctoRelacionado').map(docto => ({
          idDocumento: attr(docto, 'IdDocumento').toUpperCase(), serie: attr(docto, 'Serie'), folio: attr(docto, 'Folio'),
          monedaDr: attr(docto, 'MonedaDR'), equivalenciaDr: attr(docto, 'EquivalenciaDR'),
          numParcialidad: attr(docto, 'NumParcialidad'), impSaldoAnt: attr(docto, 'ImpSaldoAnt'),
          impPagado: attr(docto, 'ImpPagado'), impSaldoInsoluto: attr(docto, 'ImpSaldoInsoluto'),
          objetoImpDr: attr(docto, 'ObjetoImpDR')
        }))
      }))
    };
  }
  const otrosComplementos = complemento ? elements(complemento)
    .filter(item => item !== stamp && item !== pagosNode)
    .map(item => item.localName + (attr(item, 'Version') ? ' ' + attr(item, 'Version') : '')) : [];
  return {
    version: attr(root, 'Version', 'version'), serie: attr(root, 'Serie', 'serie'), folio: attr(root, 'Folio', 'folio'),
    fecha: attr(root, 'Fecha', 'fecha'), lugarExpedicion: attr(root, 'LugarExpedicion'),
    tipoRaw: rawKind, kind: legacy[rawKind] || rawKind, formaPago: attr(root, 'FormaPago'), metodoPago: attr(root, 'MetodoPago'),
    condiciones: attr(root, 'CondicionesDePago'), moneda: attr(root, 'Moneda', 'moneda').toUpperCase(),
    tipoCambio: attr(root, 'TipoCambio'), subTotal: attr(root, 'SubTotal'), descuento: attr(root, 'Descuento'),
    total: attr(root, 'Total', 'total'), noCertificado: attr(root, 'NoCertificado'), exportacion: attr(root, 'Exportacion'),
    sello: attr(root, 'Sello', 'sello'), certificado: attr(root, 'Certificado'),
    emisor: { rfc: attr(emisorNode, 'Rfc', 'rfc').toUpperCase(), nombre: attr(emisorNode, 'Nombre', 'nombre'), regimen: attr(emisorNode, 'RegimenFiscal') },
    receptor: { rfc: attr(receptorNode, 'Rfc', 'rfc').toUpperCase(), nombre: attr(receptorNode, 'Nombre', 'nombre'),
      regimen: attr(receptorNode, 'RegimenFiscalReceptor'), domicilioFiscal: attr(receptorNode, 'DomicilioFiscalReceptor'),
      usoCfdi: attr(receptorNode, 'UsoCFDI') },
    conceptos: kids(child(root, 'Conceptos'), 'Concepto').map(item => {
      const taxes = taxesOf(item);
      return { claveProdServ: attr(item, 'ClaveProdServ'), noIdentificacion: attr(item, 'NoIdentificacion'),
        cantidad: attr(item, 'Cantidad'), claveUnidad: attr(item, 'ClaveUnidad'), unidad: attr(item, 'Unidad'),
        descripcion: attr(item, 'Descripcion', 'descripcion'), valorUnitario: attr(item, 'ValorUnitario'),
        descuento: attr(item, 'Descuento'), importe: attr(item, 'Importe'), objetoImp: attr(item, 'ObjetoImp'),
        traslados: taxes.traslados, retenciones: taxes.retenciones };
    }),
    impuestos: { traslados: globalTaxes.traslados, retenciones: globalTaxes.retenciones,
      totalTrasladados: attr(impuestosNode, 'TotalImpuestosTrasladados'), totalRetenidos: attr(impuestosNode, 'TotalImpuestosRetenidos') },
    timbre, pagos, otrosComplementos
  };
}
/* Desglose fiscal persistido (1.6.16, mejora nº 6 de la auditoría): lo
   que el informe mensual, la DIOT y el IVA del mes necesitan sin tener
   que reabrir cada XML. Se guarda junto al CFDI al importarlo y el
   histórico se completa con el re-parseo (sin contactar al SAT). */
function fiscalSummary(full) {
  const taxes = full.impuestos || {};
  return {
    subtotal: full.subTotal || '', discount: full.descuento || '',
    currency: full.moneda || '', exchangeRate: full.tipoCambio || '',
    paymentMethod: full.metodoPago || '', paymentForm: full.formaPago || '',
    cfdiUse: full.receptor?.usoCfdi || '', series: full.serie || '', folio: full.folio || '',
    transferred: (taxes.traslados || []).map(t => ({ tax: t.impuesto, rate: t.tasa, factor: t.tipoFactor, base: t.base, amount: t.importe })),
    withheld: (taxes.retenciones || []).map(t => ({ tax: t.impuesto, amount: t.importe })),
    totalTransferred: taxes.totalTrasladados || '', totalWithheld: taxes.totalRetenidos || '',
    /* Relación Pagos↔facturas (1.6.17, mejora nº 7): los documentos
       relacionados de cada complemento de pago, persistidos para
       calcular saldos sin reabrir los XML. */
    payments: full.pagos ? {
      totalPaid: full.pagos.totales?.MontoTotalPagos || '',
      pagos: (full.pagos.pagos || []).map(pago => ({ fechaPago: pago.fechaPago, monto: pago.monto,
        documentos: (pago.documentos || []).map(doc => ({ idDocumento: doc.idDocumento, impPagado: doc.impPagado,
          impSaldoInsoluto: doc.impSaldoInsoluto, numParcialidad: doc.numParcialidad })) }))
    } : null
  };
}
function withFiscal(row, raw) {
  try { row.fiscal = fiscalSummary(parseCfdiFull(raw)); } catch { /* el registro ligero ya quedó importado */ }
  return row;
}
function moneyCents(value) {
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(String(value ?? '').trim());
  if (!match) return 0n;
  const cents = BigInt(match[2]) * 100n + BigInt((match[3] || '').padEnd(2, '0'));
  return match[1] ? -cents : cents;
}
/* IVA (impuesto 002) de un CFDI con desglose: importe y base, en
   centavos. Sin desglose devuelve null: jamás se estima a ojo. */
function invoiceIvaCents(row) {
  if (!row.fiscal) return null;
  let cents = 0n;
  for (const t of row.fiscal.transferred) if (t.tax === '002') cents += moneyCents(t.amount);
  return cents;
}
function invoiceIvaBaseCents(row) {
  if (!row.fiscal) return null;
  let cents = 0n;
  for (const t of row.fiscal.transferred) if (t.tax === '002') cents += moneyCents(t.base);
  return cents;
}
const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value;
});
function crc32(raw) {
  let crc = 0xffffffff;
  for (const octet of raw) crc = (crc >>> 8) ^ crcTable[(crc ^ octet) & 255];
  return (crc ^ 0xffffffff) >>> 0;
}
async function inflate(raw, size) {
  const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const reader = stream.getReader();
  const out = new Uint8Array(size);
  let offset = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      check(offset + part.value.length <= size, 'Tamaño ZIP expandido inválido.');
      out.set(part.value, offset);
      offset += part.value.length;
    }
    check(offset === size, 'Archivo ZIP truncado.');
    return out;
  } finally { await reader.cancel().catch(() => {}); }
}
async function* zipEntries(raw, extension, meta) {
  check(raw.length >= 22 && raw.length <= 80 * MB, 'ZIP vacío o mayor de 80 MB.');
  const d = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const u16 = p => d.getUint16(p, true);
  const u32 = p => d.getUint32(p, true);
  let end = raw.length - 22;
  while (end >= Math.max(0, raw.length - 65557)) {
    if (u32(end) === 0x06054b50 && end + 22 + u16(end + 20) === raw.length) break;
    end--;
  }
  check(end >= Math.max(0, raw.length - 65557), 'El ZIP no contiene un directorio válido.');
  const count = u16(end + 10);
  let p = u32(end + 16);
  /* Total de entradas que casan con la extensión, contado en una
     primera pasada por el directorio (sin descomprimir nada): es el
     «N» del contador «procesando X de N» de la importación visible
     (1.7.4, pieza 1). El meta es opcional y no cambia la lectura. */
  if (meta) {
    let scan = p, matched = 0;
    const scanLimit = p + u32(end + 12);
    for (let i = 0; i < count && scan + 46 <= scanLimit && u32(scan) === 0x02014b50; i++) {
      const len = u16(scan + 28);
      const name = new TextDecoder().decode(raw.subarray(scan + 46, scan + 46 + len)).split(/[\\/]/).at(-1);
      if (extension.test(name)) matched++;
      scan += 46 + len + u16(scan + 30) + u16(scan + 32);
    }
    meta.total = matched;
  }
  const centralStart = p;
  const limit = p + u32(end + 12);
  check(u16(end + 4) === 0 && u16(end + 6) === 0 && u16(end + 8) === count && count <= 12000 &&
    p <= end && limit <= end, 'ZIP segmentado, ZIP64 o con demasiadas entradas.');
  let expanded = 0;
  for (let i = 0; i < count; i++) {
    check(p + 46 <= limit && u32(p) === 0x02014b50, 'Directorio ZIP dañado.');
    const flags = u16(p + 8);
    const method = u16(p + 10);
    const checksum = u32(p + 16);
    const compressed = u32(p + 20);
    const size = u32(p + 24);
    const len = u16(p + 28);
    const start = u32(p + 42);
    const next = p + 46 + len + u16(p + 30) + u16(p + 32);
    check(next <= limit, 'Directorio ZIP truncado.');
    const name = new TextDecoder().decode(raw.subarray(p + 46, p + 46 + len)).split(/[\\/]/).at(-1);
    p = next;
    if (!extension.test(name)) continue;
    expanded += size;
    check(!(flags & 1) && (method === 0 || method === 8) && size <= 8 * MB && expanded <= 180 * MB &&
      start + 30 <= centralStart && u32(start) === 0x04034b50 && u16(start + 8) === method,
      'Entrada ZIP cifrada, no compatible o fuera del límite de tamaño.');
    const offset = start + 30 + u16(start + 26) + u16(start + 28);
    check(offset + compressed <= centralStart, 'Archivo ZIP truncado.');
    const data = raw.subarray(offset, offset + compressed);
    const content = method === 8 ? await inflate(data, size) : data;
    check(content.length === size && crc32(content) === checksum, 'La verificación de integridad del ZIP falló.');
    yield { name, content };
  }
}
async function* zipXml(raw, meta) {
  for await (const entry of zipEntries(raw, /\.xml$/i, meta)) yield { name: entry.name, xml: entry.content };
}
/* Paquetes Metadata del SAT (1.6.10): el ZIP trae un .txt con los
   registros separados por tuberías, no XML. Mismo lector, otra extensión. */
async function* zipText(raw) {
  for await (const entry of zipEntries(raw, /\.txt$/i)) yield { name: entry.name, text: decodeXml(entry.content) };
}
async function pdfOk(blob) {
  return blob instanceof Blob && blob.size <= 15 * MB && await blob.slice(0, 5).text() === '%PDF-';
}
function encode64(raw) {
  let binary = '';
  for (let i = 0; i < raw.length; i += 8192) binary += String.fromCharCode(...raw.subarray(i, i + 8192));
  return btoa(binary);
}
function decode64(value) { return Uint8Array.from(atob(value), letter => letter.charCodeAt(0)); }
async function keyFor(password, salt) {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 600000, hash: 'SHA-256' },
    material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
const backupMagic = 'FARO2\n';
async function encryptBackup(data, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await keyFor(password, salt);
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(data)));
  return new Blob([backupMagic, salt, iv, cipher], { type: 'application/octet-stream' });
}
async function decryptBackup(file, password) {
  check(file.size >= 50 && file.size <= 180 * MB && await file.slice(0, 6).text() === backupMagic, 'El archivo no es un respaldo PacoSAT válido.');
  const raw = bytes(await file.arrayBuffer());
  const key = await keyFor(password, raw.subarray(6, 22));
  let plain;
  try { plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.subarray(22, 34) }, key, raw.subarray(34)); }
  catch { throw new Error('Contraseña incorrecta o respaldo dañado.'); }
  return JSON.parse(new TextDecoder().decode(plain));
}

export { crc32, parseXml, parseCfdiFull, fiscalSummary, withFiscal, moneyCents, zipXml, zipText, rfcCheckDigit, validateRfc };
