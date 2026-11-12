/* Código QR VERDADERO de verificación del CFDI (1.21.0).
   Hasta la 1.20.0 el PDF del comprobante salía sin QR (pendiente
   declarado desde Salidas: no había librería y no se añadió ninguna
   en silencio). Desde esta versión el comprobante timbrado lleva su
   código de barras bidimensional conforme al Anexo 20, rubro I.E:
   codifica la URL oficial de consulta del SAT construida desde los
   datos REALES del propio comprobante:

     https://verificacfdi.facturaelectronica.sat.gob.mx/default.aspx
       ?id=<UUID>&re=<RFC emisor>&rr=<RFC receptor>
       &tt=<total>&fe=<últimos 8 caracteres del sello del CFDI>

   Formatos (Anexo 20 I.E): el UUID y los RFC en mayúsculas; el
   total «tt» con DIEZ enteros y SEIS decimales, rellenando con
   ceros a la izquierda (12760.00 → 0000012760.000000); «fe» son los
   últimos 8 caracteres del sello digital del emisor (el SelloCFD
   del Timbre Fiscal Digital). La expresión impresa de la consulta
   de estado (sat-monitor.mjs) usa otra normalización del total —
   documentada y probada en vivo para ESE servicio SOAP —; la del
   QR es la de la representación impresa y no se mezclan.

   Sin datos suficientes NO hay QR: verificationUrl devuelve null
   y el PDF lo dice en palabras («comprobante sin timbrar», «faltan
   datos del timbre») en vez de imprimir un código inventado.

   La generación vive EN EL SERVIDOR, al construir el PDF: la
   página no gana ni un byte. La librería es `qrcode` (1.5.4,
   mantenida, la de referencia en Node) y solo se usa su núcleo
   (QRCode.create → matriz de módulos); el PDF pinta los módulos
   como rectángulos vectoriales (ver buildPdf en salidas-doc.mjs),
   sin imágenes rasterizadas ni dependencias de PNG. */
import QRCode from 'qrcode';

const BASE = 'https://verificacfdi.facturaelectronica.sat.gob.mx/default.aspx';
const UUID_RE = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/;
const RFC_RE = /^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/;

/* Total en el formato de «tt»: aritmética de CADENA, sin flotantes
   (un total de CFDI trae hasta 6 decimales exactos en el XML; si
   trajera más, se redondea el sexto decimal mirando el séptimo). */
export function formatTotalQr(total) {
  const raw = String(total ?? '').trim();
  if (!/^\d{1,18}(?:\.\d+)?$/.test(raw)) return null;
  let [entero, decimales = ''] = raw.split('.');
  entero = entero.replace(/^0+(?=\d)/, '');
  if (entero.length > 10) return null;
  if (decimales.length > 6) {
    const corte = decimales.slice(0, 6);
    if (Number(decimales[6]) >= 5) {
      const subido = (BigInt(corte) + 1n).toString().padStart(6, '0');
      if (subido.length > 6) { entero = (BigInt(entero) + 1n).toString(); decimales = '000000'; }
      else decimales = subido;
    } else decimales = corte;
  }
  return `${entero.padStart(10, '0')}.${decimales.padEnd(6, '0')}`;
}

/* La URL oficial de verificación, o null si falta CUALQUIER dato
   de los que la especificación exige (UUID con forma, ambos RFC,
   total con forma y sello de al menos 8 caracteres). Nada de QR
   a medias: o la URL completa y exacta, o ninguna. */
export function verificationUrl({ uuid, emisor, receptor, total, sello } = {}) {
  const id = String(uuid ?? '').trim().toUpperCase();
  const re = String(emisor ?? '').trim().toUpperCase();
  const rr = String(receptor ?? '').trim().toUpperCase();
  const tt = formatTotalQr(total);
  const seal = String(sello ?? '').trim();
  const fe = seal.length >= 8 ? seal.slice(-8) : '';
  if (!UUID_RE.test(id) || !RFC_RE.test(re) || !RFC_RE.test(rr) || !tt || !/^[A-Za-z0-9+/=]{8}$/.test(fe)) return null;
  const param = new URLSearchParams({ id, re, rr, tt, fe });
  return `${BASE}?${param.toString()}`;
}

/* Matriz de módulos del QR (nivel de corrección M, el habitual en
   las representaciones impresas: ~15 % de recuperación). Devuelve
   { size, data } con data plana por filas de 0/1, lista para que
   buildPdf la pinte y para que las pruebas la decodifiquen. */
export function qrMatrix(text) {
  const created = QRCode.create(String(text), { errorCorrectionLevel: 'M' });
  const size = created.modules.size;
  const raw = created.modules.data;
  const data = new Uint8Array(size * size);
  for (let i = 0; i < data.length; i++) data[i] = raw[i] ? 1 : 0;
  return { size, data };
}
