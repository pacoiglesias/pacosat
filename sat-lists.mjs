/* Listas negras vivas (1.6.13): catálogo de listados oficiales del SAT
   y su lectura tolerante. Fuentes verificadas el 8–9 nov 2026:
   - 69-B y 69-B Bis: blob oficial del minisitio de Datos Abiertos del
     SAT (wu1agsprosta001.blob.core.windows.net), con la situación de
     cada contribuyente dentro del propio archivo completo.
   - Art. 69 (supuestos): paquete oficial «Contribuyentes incumplidos»
     del SAT en datos.gob.mx, servido desde el repositorio oficial de
     la ATDT (repodatos.atdt.gob.mx/api_update/sat/…): son los CSV que
     el propio portal de datos abiertos enlaza por supuesto. Los
     endpoints «download» de datos.gob.mx responden HTTP 403 a las
     peticiones de un servidor (verificado el 9 nov 2026 desde la VM y
     desde el NAS); el repositorio ATDT sí los sirve, con cabeceras de
     navegador (la descarga las manda: ver refreshList).
   - CSD sin efectos y Reducción art. 74: sin CSV oficial verificado a
     esta fecha — entran por importación manual del archivo (la semilla
     que Paco ya guarda), y el motor los trata igual que a los demás.
   Nada de esto usa el Web Service del SAT: son datos públicos. */
import { csvRows, cleanName } from './sat-monitor.mjs';

const BLOB = 'https://wu1agsprosta001.blob.core.windows.net/agsc-publicaciones/';
const REPO = 'https://repodatos.atdt.gob.mx/api_update/sat/contribuyentes_incumplidos/';
export const LIST_CATALOG = [
  { id: '69b', label: 'Art. 69-B · Operaciones inexistentes', kind: 'situaciones',
    url: BLOB + 'Datos_abiertos/Documents_AGAFF/Listado_completo_69-B.csv' },
  { id: '69b-bis', label: 'Art. 69-B Bis · Pérdidas fiscales transmitidas', kind: 'situaciones',
    url: BLOB + 'Datos_abiertos/Documents_AGGC/Listado_69_B_Bis_Completo.csv' },
  { id: '69-firmes', label: 'Art. 69 · Créditos firmes', kind: 'supuesto', supuesto: 'Firmes',
    url: REPO + 'SAT_5_Firmes.csv' },
  { id: '69-exigibles', label: 'Art. 69 · Créditos exigibles', kind: 'supuesto', supuesto: 'Exigibles',
    url: REPO + 'SAT_6_Exigibles.csv' },
  { id: '69-no-localizados', label: 'Art. 69 · No localizados', kind: 'supuesto', supuesto: 'No localizados',
    url: REPO + 'SAT_4_Nolocalizados.csv' },
  { id: '69-cancelados', label: 'Art. 69 · Créditos cancelados (146-A)', kind: 'supuesto', supuesto: 'Cancelados',
    url: REPO + 'SAT_7_Cancelados.csv' },
  { id: '69-sentencias', label: 'Art. 69 · Sentencias condenatorias', kind: 'supuesto', supuesto: 'Sentencias',
    url: REPO + 'SAT_3_Sentencias.csv' },
  { id: '69-entes-omisos', label: 'Art. 69 · Entes públicos omisos', kind: 'supuesto', supuesto: 'Entes públicos omisos',
    url: 'https://repodatos.atdt.gob.mx/api_update/sat/contribuyentes_incumplidos/SAT_2_EntespublicosydeGobiernoomisos.csv' },
  { id: '69-csd', label: 'Art. 69 · CSD sin efectos', kind: 'supuesto', supuesto: 'CSD sin efectos', url: null },
  { id: '69-reduccion', label: 'Art. 69 · Reducción art. 74', kind: 'supuesto', supuesto: 'Reducción art. 74', url: null }
];
const RFC = /^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/u;
const text = value => typeof value === 'string' ? value : '';

/* Gravedad para el semáforo por contraparte: lo peor manda. */
export function listSeverity(source, detail) {
  const value = cleanName(detail || '');
  if (source.id === '69b' || source.id === '69b-bis') {
    if (/definitiv/.test(value)) return 'bad';
    if (/presunt/.test(value)) return 'warn';
    return 'ok'; /* Desvirtuado o sentencia favorable: regularizado. */
  }
  if (['69-firmes', '69-sentencias', '69-csd'].includes(source.id)) return 'bad';
  if (source.id === '69-reduccion') return 'dim';
  return 'warn';
}
export const SEVERITY_ORDER = { bad: 3, warn: 2, dim: 1, ok: 0, none: -1 };

/* Fecha declarada por el propio archivo («Información actualizada al
   30 de septiembre de 2026» en la primera línea de los 69-B). */
export function declaredDate(content) {
  const head = content.slice(0, 600);
  const match = head.match(/actualizada al ([0-9]{1,2} de [a-záéíóú]+ de [0-9]{4})/i);
  return match ? match[1] : '';
}

function situationLabel(value) {
  const clean = cleanName(value);
  if (/^presunt/.test(clean)) return 'Presunto';
  if (/^definitiv/.test(clean)) return 'Definitivo';
  if (/^desvirtuad/.test(clean)) return 'Desvirtuado';
  if (/sentencia|medio de defensa favorable/.test(clean)) return 'Sentencia favorable';
  return '';
}

/* Lectura tolerante de cualquier listado del catálogo. Devuelve un
   Map RFC → { name, detail } y el número de filas útiles. Lanza si no
   reconoce la estructura: jamás se sustituye un listado bueno por uno
   ilegible. */
export function parseList(content, source) {
  const rows = csvRows(content);
  const header = rows.findIndex(row => row.some(cell => cleanName(cell) === 'rfc'));
  if (header < 0) throw new Error('No se reconoce la columna RFC del listado.');
  /* Los CSV del repositorio ATDT usan guion bajo (razon_social,
     fechas_primera_publicacion): se normaliza a espacios para que las
     mismas reglas lean todos los formatos oficiales. */
  const columns = rows[header].map(cell => cleanName(cell).replace(/_/g, ' '));
  const rfcColumn = columns.indexOf('rfc');
  const nameColumn = columns.findIndex(value => /nombre|razon social|denominacion/.test(value));
  const situationColumn = columns.findIndex(value => value.startsWith('situacion'));
  const dateColumn = columns.findIndex(value => /publicacion/.test(value));
  const entries = new Map();
  for (const row of rows.slice(header + 1)) {
    const rfc = text(row[rfcColumn]).trim().toUpperCase();
    if (!RFC.test(rfc)) continue;
    const name = nameColumn >= 0 ? text(row[nameColumn]).trim().slice(0, 200) : '';
    let detail;
    if (source.kind === 'situaciones') {
      detail = situationColumn >= 0 ? situationLabel(row[situationColumn]) : '';
      if (!detail) continue;
      const previous = entries.get(rfc);
      if (previous) { /* Un RFC puede traer varias situaciones: se conservan todas. */
        if (!previous.detail.split(' / ').includes(detail)) previous.detail += ' / ' + detail;
        continue;
      }
    } else {
      detail = source.supuesto + (dateColumn >= 0 && text(row[dateColumn]).trim() ?
        ' · publicado el ' + text(row[dateColumn]).trim() : '');
    }
    entries.set(rfc, { name, detail });
  }
  if (!entries.size) throw new Error('El listado no contiene registros reconocibles.');
  return entries;
}
