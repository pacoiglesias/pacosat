/* Tanda 7A (2.0) · Piezas puras de servidor: pólizas, ICS, firma de
   webhooks y miniaturas de PDF. Nada aquí toca la base ni la red:
   recibe datos ya leídos y devuelve artefactos. Ninguna cuenta
   contable se inventa: la columna de cuenta viaja EN BLANCO. */
import { createHmac } from 'node:crypto';

export const WEBHOOK_EVENTS_200G = ['cfdi-nuevo', 'cancelacion-detectada', 'opinion-descargada', 'buzon-nuevo'];

export function signWebhook200g(secret, bodyText) {
  return 'sha256=' + createHmac('sha256', String(secret || '')).update(String(bodyText || ''), 'utf8').digest('hex');
}

const centsOf200g = value => {
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(String(value ?? '').trim());
  if (!m) return 0n;
  const c = BigInt(m[2]) * 100n + BigInt((m[3] || '').padEnd(2, '0'));
  return m[1] ? -c : c;
};
export const cents200g = centsOf200g;

/* Pólizas (20#14): una fila por CFDI con debe = haber = total, y el
   IVA desglosado SOLO si el desglose fiscal consta en el registro.
   Columnas: Fecha, Póliza, Cuenta (EN BLANCO a propósito), Concepto,
   Debe, Haber, IVA trasladado, IVA acreditable, UUID, Folio.
   La fila viaja como valores en centavos para buildXlsx (money). */
export function polizasRows200g(invoices, rfc) {
  const rows = [];
  const notas = [
    'Salida «Para el contador (pólizas)» de PacoSAT.',
    'La columna Cuenta va EN BLANCO a propósito: PacoSAT no tiene tabla de cuentas de la casa y no inventa ninguna; la pone el despacho.',
    'Debe y Haber van por el total de cada comprobante y cuadran fila a fila.',
    'El IVA solo se desglosa cuando el desglose fiscal del propio CFDI consta en el expediente; si no consta, las columnas de IVA van vacías.'];
  for (const inv of invoices || []) {
    const total = centsOf200g(inv.total);
    const emitido = String(inv.from?.rfc || '').toUpperCase() === String(rfc || '').toUpperCase();
    const ivaList = (inv.fiscal?.transferred || []).filter(t => String(t.tax) === '002');
    const tieneIva = Boolean(inv.fiscal) && ivaList.length > 0;
    const iva = tieneIva ? ivaList.reduce((s, t) => s + centsOf200g(t.amount), 0n) : null;
    const folio = inv.fiscal ? ((inv.fiscal.series ? inv.fiscal.series + '-' : '') + (inv.fiscal.folio || '')) : '';
    rows.push([
      String(inv.date || '').slice(0, 10),
      'Póliza ' + String(inv.date || '').slice(0, 7) + ' · ' + (inv.kind || ''),
      '',
      (emitido ? 'Emitido a ' : 'Recibido de ') + ((emitido ? inv.to?.name : inv.from?.name) || (emitido ? inv.to?.rfc : inv.from?.rfc) || ''),
      Number(total), Number(total),
      emitido && iva !== null ? Number(iva) : null,
      !emitido && iva !== null ? Number(iva) : null,
      inv.id || '', folio || 'Sin folio']);
  }
  return { rows, notas,
    totalDebe: rows.reduce((s, r) => s + BigInt(r[4] || 0), 0n),
    totalHaber: rows.reduce((s, r) => s + BigInt(r[5] || 0), 0n) };
}

export function buildIcs200g(events, stampIso) {
  const esc = value => String(value || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;')
    .replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
  const stamp = String(stampIso || new Date().toISOString()).replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//PacoSAT//Calendario fiscal vivo//ES',
    'CALSCALE:GREGORIAN', 'X-WR-CALNAME:PacoSAT · Calendario fiscal'];
  for (const event of events || []) {
    const fecha = String(event.date || '').replace(/-/g, '');
    if (!/^\d{8}$/.test(fecha)) continue;
    const uid = 'pacosat200g-' + String(event.uid || '').replace(/[^A-Za-z0-9-]/g, '').slice(0, 60) + '@pacosat';
    lines.push('BEGIN:VEVENT', 'UID:' + uid, 'DTSTAMP:' + stamp,
      'DTSTART;VALUE=DATE:' + fecha,
      'SUMMARY:' + esc('PacoSAT · ' + (event.title || 'Vencimiento') + (event.rfc ? ' (' + event.rfc + ')' : '')),
      'DESCRIPTION:' + esc(event.description || 'Vencimiento que PacoSAT ya conoce para este RFC.'),
      'BEGIN:VALARM', 'TRIGGER:-P1D', 'ACTION:DISPLAY', 'DESCRIPTION:Recordatorio PacoSAT', 'END:VALARM',
      'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}

/* Miniatura real (A6): página 1 a PNG de 240 px de ancho con
   pdfjs-dist + el canvas que pdfjs trae como dependencia opcional.
   Si algo falla (PDF ilegible, sin canvas), devuelve null: el
   cliente enseña entonces el icono de siempre, nunca un hueco. */
export async function renderThumbnail200g(pdfBuffer) {
  try {
    if (!pdfBuffer || pdfBuffer.length < 8 || pdfBuffer.subarray(0, 5).toString() !== '%PDF-') return null;
    const [{ getDocument }, canvasMod] = await Promise.all([
      import('pdfjs-dist/legacy/build/pdf.mjs'),
      import('@napi-rs/canvas').catch(() => null)]);
    if (!canvasMod?.createCanvas) return null;
    const fonts = new URL('./node_modules/pdfjs-dist/standard_fonts/', import.meta.url).href;
    const task = getDocument({ data: Uint8Array.from(pdfBuffer), isEvalSupported: false,
      useSystemFonts: false, disableFontFace: true, enableXfa: false, standardFontDataUrl: fonts });
    try {
      const pdf = await task.promise;
      if (!pdf.numPages) return null;
      const page = await pdf.getPage(1);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: 240 / base.width });
      const canvas = canvasMod.createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport }).promise;
      page.cleanup();
      const png = canvas.toBuffer('image/png');
      return png && png.length > 100 ? Buffer.from(png) : null;
    } finally { await task.destroy().catch(() => {}); }
  } catch { return null; }
}
