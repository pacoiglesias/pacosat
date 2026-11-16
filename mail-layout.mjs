/* Plantilla madre de correos (2.0 · A1 / hallazgo 6.1).
   Hasta la 1.32.3 TODOS los correos salían en texto plano de
   servidor: sin marca, sin tarjetas, sin botón. Este módulo es
   el sistema de plantillas ÚNICO: cada correo saliente lleva su
   versión HTML (tablas + estilos inline, sin flex/grid — lo que
   Gmail, Outlook y Apple Mail pintan igual) Y su texto plano
   fiel, con el mismo contenido y las mismas cifras. El faro va
   en SVG inline (los clientes no cargan imágenes externas de
   forma fiable) sobre el azul de la casa #175c9e.
   Funciones puras: las suites las juzgan sin red ni base. */
export const MAIL_BRAND = '#175c9e';
export const escHtml = value => String(value ?? '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#39;');

/* El faro de la casa, en geometría SVG inline: torre, haz y mar.
   Sin imágenes externas, sin scripts, sin clases: atributos. */
export const faroSvg = (size = 34) =>
  '<svg width="' + size + '" height="' + size + '" viewBox="0 0 48 48" role="img" aria-label="PacoSAT" ' +
  'xmlns="http://www.w3.org/2000/svg"><rect x="20" y="14" width="8" height="26" rx="1.5" fill="#ffffff"/>' +
  '<rect x="18" y="10" width="12" height="5" rx="1.5" fill="#ffd166"/>' +
  '<circle cx="24" cy="12.5" r="2.2" fill="#ffffff"/>' +
  '<path d="M12 12 L2 8 L3 17 Z" fill="#ffd166" opacity="0.85"/>' +
  '<path d="M36 12 L46 8 L45 17 Z" fill="#ffd166" opacity="0.85"/>' +
  '<rect x="20" y="22" width="8" height="3.4" fill="#175c9e"/>' +
  '<rect x="20" y="30" width="8" height="3.4" fill="#175c9e"/>' +
  '<path d="M6 43 Q12 40 18 43 T30 43 T42 43" stroke="#ffffff" stroke-width="2.4" fill="none" stroke-linecap="round"/></svg>';

/* Píldora de estado: fondo suave + texto oscuro (contraste en
   clientes claros y oscuros; el color viaja inline). */
const PILL_TONES = {
  ok: ['#e2f2e6', '#14632f'], warn: ['#fdf0d5', '#7a4d00'],
  bad: ['#fbe3e3', '#8f1d1d'], dim: ['#e8edf2', '#3f5468'],
  brand: ['#dbe9f7', '#175c9e'] };
export const mailPill = (text, tone = 'dim') => {
  const [bg, fg] = PILL_TONES[tone] || PILL_TONES.dim;
  return '<span style="display:inline-block;background:' + bg + ';color:' + fg +
    ';border-radius:999px;padding:2px 10px;font-size:12px;font-weight:700;line-height:18px">' +
    escHtml(text) + '</span>';
};

/* Tarjeta con aire para un comprobante / suceso / línea: título
   en negrita, píldora opcional y líneas de datos debajo. */
export const mailCard = ({ titulo = '', pill = '', lineas = [] } = {}) =>
  '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ' +
  'style="margin:0 0 10px 0;background:#ffffff;border:1px solid #d7e0ea;border-radius:10px">' +
  '<tr><td style="padding:12px 14px;font-family:Arial,Helvetica,sans-serif">' +
  (titulo || pill ? '<div style="font-size:14px;line-height:20px;color:#12283d">' +
    (titulo ? '<strong>' + escHtml(titulo) + '</strong>' : '') +
    (pill ? ' ' + pill : '') + '</div>' : '') +
  lineas.map(linea => '<div style="font-size:13px;line-height:19px;color:#33475c;margin-top:2px">' +
    escHtml(linea) + '</div>').join('') +
  '</td></tr></table>';

/* Botón principal con enlace profundo. Sin URL no hay botón:
   el llamador decide la prosa de reserva (nunca un enlace roto). */
export const mailButton = (href, label) => href ?
  '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:14px 0 4px 0"><tr>' +
  '<td style="background:' + MAIL_BRAND + ';border-radius:8px">' +
  '<a href="' + escHtml(href) + '" style="display:inline-block;padding:11px 20px;color:#ffffff;' +
  'font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:700;text-decoration:none">' +
  escHtml(label) + '</a></td></tr></table>' : '';

/* Enlace profundo a la app (2.0 · M3 / hallazgo 6.3): la URL
   base es el ORIGEN PÚBLICO de la instalación (el mismo que el
   correo de cancelación ya enseñaba como raíz) y el destino va
   en el hash — #/vista?parámetros — que el cliente entiende al
   abrir (enlaceProfundo200c, en ui.part, sobre el patrón de
   destino de la tanda 2). SOLO destino: jamás tokens, llaves ni
   credenciales. Sin base configurada devuelve '' y el correo
   conserva su prosa, sin botón. */
export function deepLink(baseUrl, vista, params = {}) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) return '';
  const query = Object.entries(params)
    .filter(([, value]) => value !== '' && value !== null && value !== undefined)
    .map(([key, value]) => encodeURIComponent(key) + '=' + encodeURIComponent(String(value))).join('&');
  return base + '/#/' + String(vista || 'hoy').replace(/^\/+/, '') + (query ? '?' + query : '');
}

/* La plantilla madre: cabecera con el faro, título, intro,
   tarjetas, botón y pie con el RFC y la instalación. */
export function mailLayout({ titulo = '', intro = [], cardsHtml = '', buttonHtml = '',
  rfc = '', installName = '', pieNota = '' } = {}) {
  const nombre = installName || 'PacoSAT';
  return '<!DOCTYPE html><html lang="es"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1"></head>' +
    '<body style="margin:0;padding:0;background:#eef3f8">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#eef3f8">' +
    '<tr><td align="center" style="padding:18px 10px 26px 10px">' +
    '<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" ' +
    'style="width:600px;max-width:100%;background:#f7fafc;border:1px solid #d7e0ea;border-radius:12px">' +
    '<tr><td style="background:' + MAIL_BRAND + ';border-radius:12px 12px 0 0;padding:14px 18px">' +
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>' +
    '<td style="vertical-align:middle">' + faroSvg(34) + '</td>' +
    '<td style="vertical-align:middle;padding-left:12px;font-family:Arial,Helvetica,sans-serif">' +
    '<div style="color:#ffffff;font-size:17px;font-weight:700;line-height:22px">' + escHtml(nombre) + '</div>' +
    '<div style="color:#cfe3f5;font-size:12px;line-height:16px">Aviso automático · Faro Fiscal</div>' +
    '</td></tr></table></td></tr>' +
    '<tr><td style="padding:18px 18px 8px 18px;font-family:Arial,Helvetica,sans-serif">' +
    (titulo ? '<div style="font-size:19px;line-height:25px;font-weight:700;color:#12283d;margin-bottom:8px">' +
      escHtml(titulo) + '</div>' : '') +
    intro.map(linea => '<div style="font-size:14px;line-height:21px;color:#24384d;margin-bottom:6px">' +
      escHtml(linea) + '</div>').join('') +
    cardsHtml + buttonHtml +
    '</td></tr>' +
    '<tr><td style="padding:12px 18px 16px 18px;border-top:1px solid #d7e0ea;' +
    'font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:17px;color:#5a6d80">' +
    escHtml(pieNota || '— PacoSAT (aviso automático).') +
    (rfc ? '<br>Contribuyente: ' + escHtml(rfc) + ' · Instalación: ' + escHtml(nombre) : '<br>Instalación: ' + escHtml(nombre)) +
    '</td></tr></table></td></tr></table></body></html>';
}

/* Compone el par {text, html} de un correo sencillo (una intro,
   tarjetas ya descritas como datos y un botón): el texto plano
   se deriva de LOS MISMOS datos, para que ninguna versión diga
   más que la otra. cards: [{titulo, pillText, pillTone, lineas}] */
export function composeMailPair({ titulo = '', intro = [], cards = [], button = null,
  rfc = '', installName = '', pieNota = '', baseUrl = '' } = {}) {
  const textLines = [];
  if (titulo) textLines.push(titulo, '');
  for (const linea of intro) textLines.push(linea);
  if (intro.length) textLines.push('');
  for (const card of cards) {
    textLines.push('· ' + (card.titulo || '') + (card.pillText ? ' · ' + card.pillText : ''));
    for (const linea of card.lineas || []) textLines.push('  ' + linea);
  }
  if (cards.length) textLines.push('');
  const href = button ? deepLink(baseUrl, button.vista, button.params) : '';
  if (button && href) textLines.push(button.label + ': ' + href);
  textLines.push(pieNota || '— PacoSAT (aviso automático).');
  const cardsHtml = cards.map(card => mailCard({
    titulo: card.titulo, lineas: card.lineas || [],
    pill: card.pillText ? mailPill(card.pillText, card.pillTone || 'dim') : '' })).join('');
  const html = mailLayout({ titulo, intro, cardsHtml, rfc, installName, pieNota,
    buttonHtml: button && href ? mailButton(href, button.label) : '' });
  return { text: textLines.join('\n'), html };
}
