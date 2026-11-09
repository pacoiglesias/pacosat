/* Lectura de estados de cuenta (1.6.19): extracción del texto del PDF
   por líneas y lectura conservadora de saldos y movimientos.
   REGLA: nunca se inventa una cifra — lo que no se lee con seguridad
   queda en null y la pantalla pide confirmación manual. Los formatos
   conocidos (BBVA Maestra Pyme, Santander) comparten las etiquetas de
   saldo habituales; el genérico usa las mismas y marca «a revisar». */
const MONEY = /-?\$?\s*\d{1,3}(?:,\d{3})*\.\d{2}|-?\$?\s*\d+\.\d{2}/g;
const plain = text => String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
export const moneyToCents = value => {
  if (value === null || value === undefined || value === '') return null;
  const clean = String(value).replace(/[$,\s]/g, '');
  if (!/^-?\d+(\.\d{1,2})?$/.test(clean)) return null;
  const negative = clean.startsWith('-');
  const [units, frac = ''] = clean.replace('-', '').split('.');
  const cents = BigInt(units) * 100n + BigInt((frac + '00').slice(0, 2));
  return negative ? -cents : cents;
};
function amountsIn(line) {
  return [...String(line).matchAll(MONEY)].map(match => ({ raw: match[0], cents: moneyToCents(match[0]), index: match.index }));
}
function amountAfterLabel(lines, patterns) {
  for (let i = 0; i < lines.length; i++) {
    const text = plain(lines[i]);
    if (!patterns.some(pattern => pattern.test(text))) continue;
    const found = amountsIn(lines[i]);
    if (found.length) return found[found.length - 1].cents;
    if (lines[i + 1]) { const next = amountsIn(lines[i + 1]); if (next.length) return next[0].cents; }
  }
  return null;
}
const MONTHS = { ENE: '01', FEB: '02', MAR: '03', ABR: '04', MAY: '05', JUN: '06', JUL: '07', AGO: '08', SEP: '09', OCT: '10', NOV: '11', DIC: '12' };
function movementDate(line, yearHint) {
  const text = plain(line);
  let match = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (match) return match[1] + '-' + match[2] + '-' + match[3];
  match = text.match(/\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})\b/);
  if (match) return (match[3].length === 2 ? '20' + match[3] : match[3]) + '-' + match[2].padStart(2, '0') + '-' + match[1].padStart(2, '0');
  match = text.match(/\b(\d{1,2})[\s\-]+(ENE|FEB|MAR|ABR|MAY|JUN|JUL|AGO|SEP|OCT|NOV|DIC)\b/);
  if (match && yearHint) return yearHint + '-' + MONTHS[match[2]] + '-' + match[1].padStart(2, '0');
  return null;
}
export function parseStatementText(text, month = '') {
  const lines = String(text || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const whole = plain(text);
  const detected = /BBVA|BANCOMER/.test(whole) ? 'BBVA' : /SANTANDER/.test(whole) ? 'Santander' : '';
  const opening = amountAfterLabel(lines, [/SALDO\s+(INICIAL|ANTERIOR|DE APERTURA)/]);
  const closing = amountAfterLabel(lines, [/SALDO\s+(FINAL|ACTUAL|AL CIERRE|NUEVO)/, /SALDO\s+TOTAL\s+AL/]);
  const credits = amountAfterLabel(lines, [/TOTAL\s+(DE\s+)?(ABONOS|DEPOSITOS|CREDITOS)/, /SUMA\s+(DE\s+)?(ABONOS|DEPOSITOS)/]);
  const charges = amountAfterLabel(lines, [/TOTAL\s+(DE\s+)?(CARGOS|RETIROS)/, /SUMA\s+(DE\s+)?(CARGOS|RETIROS)/]);
  /* Movimientos: línea con fecha y al menos dos importes (el último
     es el saldo tras el movimiento; el movimiento es el anterior).
     Con un solo importe no se adivina: se omite la línea. */
  const yearHint = /^\d{4}/.test(month) ? month.slice(0, 4) : '';
  const movements = [];
  for (const line of lines) {
    const date = movementDate(line, yearHint);
    if (!date) continue;
    const amounts = amountsIn(line);
    if (amounts.length < 2) continue;
    const amount = amounts[amounts.length - 2], balance = amounts[amounts.length - 1];
    const negative = /CARGO|RETIRO|COMISION|PAGO\s/.test(plain(line)) || amount.raw.includes('-');
    const concept = line.slice(0, amount.index).replace(/\s+/g, ' ').trim().slice(0, 140);
    movements.push({ date, concept, amountCents: negative && amount.cents > 0n ? -amount.cents : amount.cents,
      balanceCents: balance.cents });
  }
  const complete = opening !== null && closing !== null;
  return { detected, opening, closing, credits, charges, movements,
    state: complete ? 'ok' : 'review' };
}
export async function extractPdfTextLines(raw) {
  if (raw.length < 8 || raw.length > 15 * 1024 * 1024 || raw.subarray(0, 5).toString() !== '%PDF-') {
    throw Object.assign(new Error('Selecciona un PDF válido de hasta 15 MB.'), { status: 400 });
  }
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs').catch(() => {
    throw Object.assign(new Error('Falta el lector PDF. Vuelve a iniciar PacoSAT con internet para instalarlo.'), { status: 503 });
  });
  const task = getDocument({ data: Uint8Array.from(raw), isEvalSupported: false,
    useSystemFonts: false, disableFontFace: true, enableXfa: false, stopAtErrors: true });
  try {
    const pdf = await task.promise;
    if (pdf.numPages > 60) throw new Error('El PDF supera las 60 páginas de análisis.');
    const pages = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const extracted = await page.getTextContent();
      let line = '';
      const lines = [];
      for (const item of extracted.items) {
        line += (line && !line.endsWith(' ') ? ' ' : '') + (item.str || '');
        if (item.hasEol) { lines.push(line); line = ''; }
      }
      if (line) lines.push(line);
      pages.push(lines.join('\n'));
      page.cleanup();
    }
    return pages.join('\n');
  } finally { await task.destroy().catch(() => {}); }
}
