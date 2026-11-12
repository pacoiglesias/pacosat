/* Capa de salidas · constructores puros de artefactos (1.14.0).
   Nada aquí toca la base de datos ni la red: reciben filas ya
   calculadas por local-server.mjs y devuelven Buffers. Tres piezas:
   - zipBuffers: ZIP «store» con fechas DOS REALES (el ZIP del
     cliente ponía 1980 en todo; ver zipStoreBuffers del servidor).
   - buildXlsx: .xlsx REAL (hojas con tipos: texto, número con
     formato de moneda, fecha como serial de Excel; totales con
     fórmula SUM y su valor calculado; filtros y fila fijada).
   - buildPdf: PDF A4 diseñado para papel, multi-página, con
     cabecera, tablas, pie «página X de Y» y folio cuando aplica.
   - folioLabel / amountInWords: el folio del CFDI y el total en
     letra que pide el diseño de la pieza 1 (auditoría 2026-11-10). */
import { crc32 } from './xml-core.mjs';

const enc = text => Buffer.from(String(text ?? ''), 'utf8');

/* ================= ZIP con fechas reales ================= */
function dosDateTime(date) {
  const d = date instanceof Date ? date : new Date(date || Date.now());
  const dosTime = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() >> 1) & 31);
  const dosDate = (((Math.max(0, d.getFullYear() - 1980)) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);
  return { dosTime, dosDate };
}
export function zipBuffers(entries, now = new Date()) {
  const local = [], central = [];
  let offset = 0;
  for (const { name, data, date } of entries) {
    const nameBuffer = enc(name);
    const body = Buffer.isBuffer(data) ? data : enc(data);
    const crc = crc32(body);
    const { dosTime, dosDate } = dosDateTime(date || now);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0); localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6); // UTF-8 en los nombres
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(dosTime, 10); localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(body.length, 18); localHeader.writeUInt32LE(body.length, 22);
    localHeader.writeUInt16LE(nameBuffer.length, 26);
    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0); centralHeader.writeUInt16LE(20, 4); centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8); centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(dosTime, 12); centralHeader.writeUInt16LE(dosDate, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(body.length, 20); centralHeader.writeUInt32LE(body.length, 24);
    centralHeader.writeUInt16LE(nameBuffer.length, 28);
    centralHeader.writeUInt32LE(offset, 42);
    local.push(localHeader, nameBuffer, body);
    central.push(centralHeader, nameBuffer);
    offset += localHeader.length + nameBuffer.length + body.length;
  }
  const centralStart = offset;
  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(centralStart, 16);
  return Buffer.concat([...local, ...central, end]);
}

/* ================= Folio y total en letra ================= */
/* El folio vive en el resumen fiscal persistido (serie + folio del
   XML); sin folio el comprobante se presenta «sin folio». */
export function folioLabel(invoice) {
  const serie = String(invoice?.fiscal?.series || '').trim();
  const folio = String(invoice?.fiscal?.folio || '').trim();
  if (!folio) return 'Sin folio';
  return serie ? `${serie}-${folio}` : folio;
}

const UNIDADES = ['cero', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve', 'diez',
  'once', 'doce', 'trece', 'catorce', 'quince', 'dieciséis', 'diecisiete', 'dieciocho', 'diecinueve', 'veinte',
  'veintiuno', 'veintidós', 'veintitrés', 'veinticuatro', 'veinticinco', 'veintiséis', 'veintisiete', 'veintiocho', 'veintinueve'];
const DECENAS = ['', '', '', 'treinta', 'cuarenta', 'cincuenta', 'sesenta', 'setenta', 'ochenta', 'noventa'];
const CENTENAS = ['', 'ciento', 'doscientos', 'trescientos', 'cuatrocientos', 'quinientos', 'seiscientos', 'setecientos', 'ochocientos', 'novecientos'];
function numeroLetras(n) {
  if (n < 30) return UNIDADES[n];
  if (n < 100) { const d = Math.floor(n / 10), r = n % 10; return r ? `${DECENAS[d]} y ${UNIDADES[r]}` : DECENAS[d]; }
  if (n === 100) return 'cien';
  if (n < 1000) { const c = Math.floor(n / 100), r = n % 100; return r ? `${CENTENAS[c]} ${numeroLetras(r)}` : CENTENAS[c]; }
  if (n < 1000000) {
    const m = Math.floor(n / 1000), r = n % 1000;
    const miles = m === 1 ? 'mil' : `${numeroLetras(m)} mil`;
    return r ? `${miles} ${numeroLetras(r)}` : miles;
  }
  const mm = Math.floor(n / 1000000), r = n % 1000000;
  const millones = mm === 1 ? 'un millón' : `${numeroLetras(mm)} millones`;
  return r ? `${millones} ${numeroLetras(r)}` : millones;
}
/* «Ciento veintisiete mil seiscientos pesos 00/100 M.N.» — la forma
   que llevan los comprobantes impresos en México. */
export function amountInWords(cents, moneda = 'MXN') {
  const total = Math.abs(Math.round(Number(cents) || 0));
  const pesos = Math.floor(total / 100), resto = total % 100;
  const divisa = moneda === 'USD' ? 'dólares' : 'pesos';
  const sufijo = moneda === 'USD' ? 'USD' : 'M.N.';
  let letras = numeroLetras(pesos);
  if (pesos >= 1000000 && pesos % 1000000 === 0) letras += ' de'; // «un millón de pesos»
  return `${letras.charAt(0).toUpperCase()}${letras.slice(1)} ${divisa} ${String(resto).padStart(2, '0')}/100 ${sufijo}`;
}

/* ================= XLSX real ================= */
const xmlEscape = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const colName = index => { let s = ''; let i = index; do { s = String.fromCharCode(65 + (i % 26)) + s; i = Math.floor(i / 26) - 1; } while (i >= 0); return s; };
/* Serial de Excel: días desde 1899-12-30 (con el bisiesto ficticio
   de 1900 que Excel arrastra; para fechas de 2024+ basta el desfase). */
const excelSerial = iso => {
  const time = Date.parse(String(iso).slice(0, 10) + 'T00:00:00Z');
  if (!Number.isFinite(time)) return null;
  return Math.round((time - Date.UTC(1899, 11, 30)) / 86400000);
};
/* Columnas: { title, width, type: 'text'|'money'|'date'|'int'|'pct',
   total: true } — la fila de totales lleva SUM con valor calculado. */
export function buildXlsx({ sheets }) {
  const styleIds = { header: 1, money: 2, date: 3, int: 4, totalLabel: 5, totalMoney: 6, totalInt: 7 };
  const sheetXml = sheet => {
    const cols = sheet.columns;
    const rowsXml = [];
    const headerCells = cols.map((c, i) => `<c r="${colName(i)}1" t="inlineStr" s="${styleIds.header}"><is><t>${xmlEscape(c.title)}</t></is></c>`).join('');
    rowsXml.push(`<row r="1">${headerCells}</row>`);
    sheet.rows.forEach((row, r) => {
      const rn = r + 2;
      const cells = cols.map((c, i) => {
        const value = row[i];
        const ref = `${colName(i)}${rn}`;
        if (value === null || value === undefined || value === '') return `<c r="${ref}"/>`;
        if (c.type === 'money') return `<c r="${ref}" s="${styleIds.money}"><v>${(Number(value) / 100).toFixed(2)}</v></c>`;
        if (c.type === 'int') return `<c r="${ref}" s="${styleIds.int}"><v>${Math.round(Number(value))}</v></c>`;
        if (c.type === 'date') { const s = excelSerial(value); return s === null ? `<c r="${ref}"/>` : `<c r="${ref}" s="${styleIds.date}"><v>${s}</v></c>`; }
        return `<c r="${ref}" t="inlineStr"><is><t>${xmlEscape(value)}</t></is></c>`;
      }).join('');
      rowsXml.push(`<row r="${rn}">${cells}</row>`);
    });
    let totalsRow = '';
    if (sheet.totals) {
      const rn = sheet.rows.length + 2;
      const cells = cols.map((c, i) => {
        const ref = `${colName(i)}${rn}`;
        if (i === 0) return `<c r="${ref}" t="inlineStr" s="${styleIds.totalLabel}"><is><t>${xmlEscape(sheet.totals.label || 'Total')}</t></is></c>`;
        if (c.total && sheet.rows.length) {
          /* totals.skip: filas que CONSTAN pero no suman (las
             canceladas del Excel de facturas, 1.22.0/N1): el valor
             en caché excluye esas filas y no se escribe la fórmula
             SUM, que las volvería a sumar al abrir el archivo. */
          const skip = sheet.totals.skip || null;
          const hasSkip = Boolean(skip && skip.some(Boolean));
          const sum = sheet.rows.reduce((acc, row, ri) => acc + (skip && skip[ri] ? 0 : Number(row[i]) || 0), 0);
          const style = c.type === 'int' ? styleIds.totalInt : styleIds.totalMoney;
          const shown = c.type === 'int' ? Math.round(sum) : (sum / 100).toFixed(2);
          return hasSkip ? `<c r="${ref}" s="${style}"><v>${shown}</v></c>` :
            `<c r="${ref}" s="${style}"><f>SUM(${colName(i)}2:${colName(i)}${rn - 1})</f><v>${shown}</v></c>`;
        }
        return `<c r="${ref}"/>`;
      }).join('');
      totalsRow = `<row r="${rn}">${cells}</row>`;
    }
    const lastRow = sheet.rows.length + (sheet.totals ? 2 : 1);
    const lastCol = colName(cols.length - 1);
    const colsXml = cols.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width || 16}" customWidth="1"/>`).join('');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:${lastCol}${lastRow}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews><cols>${colsXml}</cols><sheetData>${rowsXml.join('')}${totalsRow}</sheetData><autoFilter ref="A1:${lastCol}${Math.max(1, sheet.rows.length + 1)}"/></worksheet>`;
  };
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="2"><numFmt numFmtId="164" formatCode="#,##0.00"/><numFmt numFmtId="165" formatCode="yyyy-mm-dd"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFDCE6F1"/></patternFill></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="8"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="#,##0" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="164" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/><xf numFmtId="#,##0" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/></cellXfs></styleSheet>`;
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${xmlEscape(String(s.name).slice(0, 31))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`;
  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`;
  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  return zipBuffers([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rootRels },
    { name: 'xl/workbook.xml', data: workbook },
    { name: 'xl/_rels/workbook.xml.rels', data: workbookRels },
    { name: 'xl/styles.xml', data: styles },
    ...sheets.map((sheet, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(sheet) }))
  ]);
}

/* ================= PDF diseñado para papel ================= */
const PAGE = { w: 595.28, h: 841.89, ml: 42, mr: 42, mt: 46, mb: 52 };
/* WinAnsi trae los guiones y las comillas tipográficas en los
   códigos 0x85–0x97: se mapean ahí en vez de perderlos como «?». */
const pdfText = value => String(value ?? '')
  .replace(/…/g, '\u0085').replace(/[‘]/g, '\u0091').replace(/[’]/g, '\u0092')
  .replace(/[“]/g, '\u0093').replace(/[”]/g, '\u0094').replace(/•/g, '\u0095')
  .replace(/–/g, '\u0096').replace(/—/g, '\u0097')
  .replace(/[^\x20-\x7E\u0085\u0091-\u0097¡-ÿ]/g, '?');
const pdfEscape = value => pdfText(value).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
const toLatin1 = value => Buffer.from(pdfEscape(value), 'latin1');
/* Ancho aproximado de Helvetica: suficiente para recortar con «…»
   y alinear importes a la derecha sin librerías. */
function textWidth(text, size, bold = false) {
  let width = 0;
  for (const ch of pdfText(text)) {
    const code = ch.charCodeAt(0);
    let factor = 0.52;
    if (ch === ' ') factor = 0.28;
    else if ('iljtfI.,:;|'.includes(ch)) factor = 0.3;
    else if ('mwMW'.includes(ch)) factor = 0.85;
    else if (code >= 48 && code <= 57) factor = 0.56;
    else if (code >= 65 && code <= 90) factor = 0.66;
    width += factor * size * (bold ? 1.04 : 1);
  }
  return width;
}
function fitText(text, maxWidth, size, bold = false) {
  let value = pdfText(text);
  if (textWidth(value, size, bold) <= maxWidth) return value;
  while (value.length && textWidth(value + '…', size, bold) > maxWidth) value = value.slice(0, -1);
  return value + '…';
}
/* Partir un párrafo en líneas que caben en el ancho útil: en papel
   nada se corta por el borde (las líneas sueltas de los PDF se
   envuelven por palabras, con sangría en la continuación). */
function wrapText(text, maxWidth, size, bold = false) {
  const words = pdfText(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? current + ' ' + word : word;
    if (textWidth(candidate, size, bold) <= maxWidth || !current) current = candidate;
    else { lines.push(current); current = word; }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [''];
}
/* Documento: { title, subtitle, generated (texto libre, p. ej.
   «Generado el 10 de noviembre de 2026, 18:30 h»), sections:
   [{ heading, note, lines: [texto], table: { columns:
   [{title, width (fracción), align}], rows: [[celdas]],
   totals: [fila] } }] */
export function buildPdf(doc) {
  const pages = [];
  let ops = [];
  let y = 0;
  const usable = PAGE.w - PAGE.ml - PAGE.mr;
  const newPage = () => { if (ops.length) pages.push(ops); ops = []; y = PAGE.h - PAGE.mt; };
  /* El texto viaja como pieza separada para codificarlo en latin1
     (WinAnsi) sin romper los operadores del flujo. */
  const text = (value, x, yy, size = 9, bold = false, color = '0 0 0') => {
    ops.push({ raw: `BT /${bold ? 'F2' : 'F1'} ${size} Tf ${color} rg 1 0 0 1 ${x.toFixed(1)} ${yy.toFixed(1)} Tm (`, text: value, tail: ') Tj ET' });
  };
  const line = (x1, yy, x2, grey = '0.75 0.75 0.75') => ops.push(`${grey} RG 0.6 w ${x1.toFixed(1)} ${yy.toFixed(1)} m ${x2.toFixed(1)} ${yy.toFixed(1)} l S`);
  const ensure = height => { if (y - height < PAGE.mb) newPage(); };

  y = PAGE.h - PAGE.mt;
  text(doc.title, PAGE.ml, y, 17, true); y -= 20;
  if (doc.subtitle) { text(doc.subtitle, PAGE.ml, y, 10.5, false, '0.25 0.25 0.25'); y -= 14; }
  if (doc.generated) { text(doc.generated, PAGE.ml, y, 8.5, false, '0.45 0.45 0.45'); y -= 8; }
  line(PAGE.ml, y, PAGE.w - PAGE.mr, '0.2 0.35 0.55'); y -= 16;

  for (const section of doc.sections || []) {
    ensure(30);
    if (section.heading) { text(section.heading, PAGE.ml, y, 12, true); y -= 15; }
    if (section.note) for (const wrapped of wrapText(section.note, usable, 8.5)) { ensure(11); text(wrapped, PAGE.ml, y, 8.5, false, '0.4 0.4 0.4'); y -= 11; }
    for (const paragraph of section.lines || [])
      for (const [index, wrapped] of wrapText(paragraph, usable - 10, 9.5).entries()) {
        ensure(12); text(wrapped, PAGE.ml + (index ? 10 : 0), y, 9.5); y -= 13;
      }
    const table = section.table;
    if (table) {
      const widths = table.columns.map(c => c.width * usable);
      const starts = []; let acc = PAGE.ml;
      for (const w of widths) { starts.push(acc); acc += w; }
      const header = () => {
        ensure(16);
        table.columns.forEach((c, i) => {
          const label = fitText(c.title, widths[i] - 4, 8, true);
          const x = c.align === 'right' ? starts[i] + widths[i] - 2 - textWidth(label, 8, true) : starts[i] + 2;
          text(label, x, y, 8, true, '0.15 0.25 0.4');
        });
        y -= 3; line(PAGE.ml, y, PAGE.w - PAGE.mr, '0.2 0.35 0.55'); y -= 11;
      };
      header();
      for (const row of table.rows) {
        if (y - 12 < PAGE.mb) { newPage(); header(); }
        /* Una fila puede viajar como { cells, color } (1.18.0): el
           color pinta la fila entera — así el mapa de declaraciones
           en papel lleva el color de su estado, como en pantalla. */
        const cells = Array.isArray(row) ? row : row.cells || [];
        const color = Array.isArray(row) ? undefined : row.color;
        cells.forEach((value, i) => {
          const c = table.columns[i];
          const label = fitText(value, widths[i] - 4, 8.5);
          const x = c.align === 'right' ? starts[i] + widths[i] - 2 - textWidth(label, 8.5) : starts[i] + 2;
          text(label, x, y, 8.5, false, color || '0 0 0');
        });
        y -= 12;
      }
      for (const total of table.totals || []) {
        if (y - 14 < PAGE.mb) { newPage(); }
        y -= 2; line(PAGE.ml, y + 9, PAGE.w - PAGE.mr, '0.2 0.35 0.55');
        total.forEach((value, i) => {
          const c = table.columns[i];
          /* La etiqueta del total («Total (sin canceladas)») no cabe
             en su columna estrecha: en la fila de totales puede usar
             el ancho de las celdas VACÍAS que la siguen, sin pisar
             ninguna cifra (1.18.0: nada de textos truncados). */
          let avail = widths[i] - 4;
          if (value) for (let j = i + 1; j < total.length && !total[j]; j++) avail += widths[j];
          const label = fitText(value, avail, 9);
          const x = c.align === 'right' ? starts[i] + widths[i] - 2 - textWidth(label, 9, true) : starts[i] + 2;
          text(label, x, y, 9, true);
        });
        y -= 14;
      }
    }
    /* Bloque QR (1.21.0): section.qr = { size, data } es la matriz
       de módulos del código de verificación (qr-cfdi.mjs) y
       section.qrCaption los párrafos que lo acompañan. Se pinta a
       la izquierda como rectángulos vectoriales unidos por filas,
       con su zona de silencio de 4 módulos por lado (la que el
       estándar exige para que el móvil lo lea), y el texto va a la
       derecha. Los comentarios «% PACOSAT-QR …» viajan en el flujo
       de contenido para que la prueba de la ronda recupere la
       matriz DESDE el propio PDF y la decodifique: el código se
       juzga sobre el artefacto, no sobre la memoria del generador. */
    const qr = section.qr;
    if (qr && qr.size && qr.data) {
      const SIDE = 126; // ≈ 44 mm en papel: legible para cualquier móvil
      const mod = SIDE / (qr.size + 8);
      ensure(SIDE + 8);
      const x0 = PAGE.ml, yTop = y;
      ops.push(`% PACOSAT-QR size=${qr.size} mod=${mod.toFixed(4)} x=${x0.toFixed(2)} ytop=${yTop.toFixed(2)}`);
      ops.push('0 0 0 rg');
      for (let row = 0; row < qr.size; row++) {
        let col = 0;
        while (col < qr.size) {
          if (!qr.data[row * qr.size + col]) { col++; continue; }
          let end = col;
          while (end + 1 < qr.size && qr.data[row * qr.size + end + 1]) end++;
          ops.push(`${(x0 + (col + 4) * mod).toFixed(2)} ${(yTop - (row + 5) * mod).toFixed(2)} ${((end - col + 1) * mod).toFixed(2)} ${mod.toFixed(2)} re f`);
          col = end + 1;
        }
      }
      ops.push('% PACOSAT-QR-FIN');
      const capX = x0 + SIDE + 14;
      let capY = yTop - 9;
      for (const paragraph of section.qrCaption || [])
        for (const wrapped of wrapText(paragraph, PAGE.w - PAGE.mr - capX, 9)) {
          text(wrapped, capX, capY, 9, false, '0.25 0.25 0.25'); capY -= 12.5;
        }
      y -= SIDE + 6;
    }
    y -= 10;
  }
  pages.push(ops);

  /* Pie de página: «PacoSAT · página X de Y» en cada hoja. */
  const totalPages = pages.length;
  const streams = pages.map((pageOps, index) => {
    const parts = [];
    const pushText = (value, x, yy, size, bold, color) => {
      parts.push(enc(`BT /${bold ? 'F2' : 'F1'} ${size} Tf ${color} rg 1 0 0 1 ${x.toFixed(1)} ${yy.toFixed(1)} Tm (`));
      parts.push(toLatin1(value));
      parts.push(enc(') Tj ET\n'));
    };
    for (const op of pageOps) {
      if (typeof op === 'string') parts.push(enc(op + '\n'));
      else { parts.push(enc(op.raw)); parts.push(toLatin1(op.text)); parts.push(enc(op.tail + '\n')); }
    }
    const footer = `PacoSAT · ${doc.title} · página ${index + 1} de ${totalPages}`;
    pushText(footer, PAGE.ml, 30, 8, false, '0.5 0.5 0.5');
    return Buffer.concat(parts);
  });

  const objects = [];
  objects[1] = enc('<< /Type /Catalog /Pages 2 0 R >>');
  objects[2] = enc(`<< /Type /Pages /Kids [${streams.map((_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${streams.length} >>`);
  objects[3] = enc('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  objects[4 + streams.length * 2] = enc('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const boldId = 4 + streams.length * 2;
  streams.forEach((stream, i) => {
    const pageId = 4 + i * 2, contentId = pageId + 1;
    objects[pageId] = enc(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE.w} ${PAGE.h}] /Resources << /Font << /F1 3 0 R /F2 ${boldId} 0 R >> >> /Contents ${contentId} 0 R >>`);
    objects[contentId] = Buffer.concat([enc(`<< /Length ${stream.length} >>\nstream\n`), stream, enc('\nendstream')]);
  });
  const out = [enc('%PDF-1.4\n')];
  let length = out[0].length;
  const offsets = [0];
  const maxId = boldId;
  for (let id = 1; id <= maxId; id++) {
    offsets[id] = length;
    const header = enc(`${id} 0 obj\n`);
    out.push(header, objects[id], enc('\nendobj\n'));
    length += header.length + objects[id].length + 8;
  }
  const xrefAt = length;
  let xref = `xref\n0 ${maxId + 1}\n0000000000 65535 f \n`;
  for (let id = 1; id <= maxId; id++) xref += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  out.push(enc(xref + `trailer\n<< /Size ${maxId + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF`));
  return Buffer.concat(out);
}
