/* Correo de CFDI nuevos CON DATOS (1.22.0).
   El correo viejo de novedades no decía ni un dato del
   comprobante («PacoSAT detectó N comprobante(s) nuevo(s)…
   Abre PacoSAT para revisar el expediente»): Paco lo leyó y
   pidió «más explicación, más datos». Este módulo compone el
   correo ÚNICO de una operación (una recuperación, una descarga
   con varias pasadas, una importación de bandeja, una corrida
   CIEC) desde las filas de detalle que la operación acumuló:
   cada comprobante con su fecha, su contraparte (nombre y RFC),
   su serie/folio — o «sin folio» —, su importe con formato, su
   estado en el SAT si consta y su clase (recibido/emitido). El
   asunto lleva la cuenta y el periodo o la vía; el cuerpo abre
   con qué pasó y para qué RFC, suma los importes con su total y
   cierra con dónde se ve el detalle completo. Si son muchos, se
   listan hasta NEWS_MAIL_LIMIT y la línea final dice cuántos
   más hay y dónde están: nunca se corta en silencio.
   Funciones puras (sin base ni red): la suite las juzga
   directamente y el servidor las alimenta con sus filas. */
export const NEWS_MAIL_LIMIT = 50;

const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const monthName = key => /^\d{4}-\d{2}$/.test(key || '') ?
  MONTHS[Number(key.slice(5, 7)) - 1] + ' de ' + key.slice(0, 4) : '';
const fechaLarga = fecha => {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(fecha || ''));
  return match ? Number(match[3]) + ' de ' + MONTHS[Number(match[2]) - 1] + ' de ' + match[1] : '';
};
/* El mismo formato de importe que enseña el resto del sistema en
   los textos para Paco: miles con coma, decimales como vengan. */
const importeShow = text => { const [ent, dec] = String(text ?? '').split('.');
  return ent.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (dec !== undefined ? '.' + dec : ''); };
const centsOf = value => {
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(String(value ?? '').trim());
  if (!match) return 0n;
  const cents = BigInt(match[2]) * 100n + BigInt((match[3] || '').padEnd(2, '0'));
  return match[1] ? -cents : cents;
};
const moneyText = cents => { const sign = cents < 0n ? '-' : ''; const abs = cents < 0n ? -cents : cents;
  return sign + (abs / 100n).toString() + '.' + String(abs % 100n).padStart(2, '0'); };
/* La clase en palabras, como la nombra el resto de la app: la
   letra del XML (I/E/N/P/T) con su nombre cuando se conoce. */
const KIND_WORDS = { I: 'ingreso', E: 'egreso', N: 'nómina', P: 'pago', T: 'traslado' };
const claseWord = item => {
  const base = KIND_WORDS[item.kind] || '';
  const dir = item.direction === 'received' ? 'recibido' : item.direction === 'issued' ? 'emitido' : '';
  return [dir, base].filter(Boolean).join(' · ') || 'comprobante';
};
const subjectMonthOf = item => {
  const label = monthName(item.label);
  if (label) return label;
  const months = [...new Set((item.rows || []).map(row => String(row.fecha || '').slice(0, 7)).filter(Boolean))].sort();
  return months.length === 1 ? monthName(months[0]) : '';
};
/* Compone asunto y cuerpo del correo de UNA operación.
   notice: { kind, rfc, direction, label } · rows: las filas de
   detalle de news_items · total: la cuenta completa (puede ser
   mayor que rows.length cuando se compone solo una muestra). */
export function composeNewsMail(notice, rows, total = rows.length) {
  const list = [...rows].sort((a, b) => String(a.fecha || '').localeCompare(String(b.fecha || '')));
  const shown = list.slice(0, NEWS_MAIL_LIMIT);
  const sum = rows.reduce((acc, row) => acc + centsOf(row.total), 0n);
  const mes = subjectMonthOf({ ...notice, rows: list });
  const rfc = notice.rfc || (list.length === 1 ? '' : '');
  const recNombre = mes || notice.label;
  const lugar = notice.kind === 'bandeja' ? 'por la carpeta vigilada' :
    notice.kind === 'ciec' ? 'por la descarga CIEC del portal' :
    notice.kind === 'recuperacion' ? (recNombre ? 'con la recuperación de ' + recNombre :
      'con una recuperación de meses anteriores') :
    notice.kind === 'mensual' ? 'con la descarga automática mensual' : 'del SAT';
  const dirWord = notice.direction === 'received' ? 'recibidos' : notice.direction === 'issued' ? 'emitidos' : '';
  /* El asunto nombra la VÍA cuando la operación es la bandeja o
     la CIEC (el mes de los ficheros que cayeron no es el periodo
     de la operación); el mes solo nombra a las operaciones del
     SAT (recuperación, descarga, mensual). */
  /* Correos por RFC (1.24.0, M3): el asunto también nombra el
     RFC del que habla el correo, no solo el cuerpo. */
  const subject = ('PacoSAT · Nuevos CFDI' + (dirWord ? ' ' + dirWord : '') + ' · ' + total +
    (notice.kind === 'bandeja' ? ' · carpeta vigilada' :
      notice.kind === 'ciec' ? ' · descarga CIEC' : mes ? ' · ' + mes : '') +
    (rfc ? ' · ' + rfc : '')).slice(0, 150);
  const lines = [
    'Entraron ' + total + ' comprobante(s) nuevo(s) ' + lugar +
      (rfc ? ' para el RFC ' + rfc : '') + '. Ya están en tu expediente, con su XML guardado.',
    'Importe total de lo nuevo: $' + importeShow(moneyText(sum)) + '.', ''];
  for (const row of shown) {
    lines.push('· ' + (fechaLarga(row.fecha) || 'sin fecha') +
      ' · ' + (row.counterpartName || 'Sin nombre registrado') + ' (' + (row.counterpartRfc || '—') + ')' +
      ' · ' + (row.folio ? 'folio ' + (row.serie ? row.serie + '-' : '') + row.folio : 'sin folio') +
      ' · $' + importeShow(row.total) +
      (row.estado ? ' · ' + row.estado : '') +
      ' · ' + claseWord(row));
  }
  if (total > shown.length)
    lines.push('· …y ' + (total - shown.length) + ' más — el detalle completo está en PacoSAT, en Facturas.');
  lines.push('', 'Ábrelos en PacoSAT, en Facturas, para ver cada comprobante completo (conceptos, impuestos y su PDF).',
    '— PacoSAT (aviso automático de novedades).');
  return { subject, text: lines.join('\n') };
}
