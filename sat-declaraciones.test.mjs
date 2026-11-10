import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { SatDocError } from './sat-doc-fetch.mjs';
import { createSatDeclFetch } from './sat-declaraciones.mjs';

/* Declaraciones y acuses (punto 7 de la 1.9.0): el portal es un
   driver falso que implementa el contrato documentado en
   sat-declaraciones.mjs (login NIDP, enlaces por texto, búsqueda
   por ejercicio/periodo, filas con operación y descargas por
   clase). Ninguna credencial sale a la red. */
const RFC = 'MFI6212158B4';
const PASSWORD = 'buena-efirma';
const pdfOf = (label) => Buffer.concat([Buffer.from('%PDF-1.4 ' + label + '\n'),
  Buffer.alloc(1024, 0x2e), Buffer.from('\n%%EOF')]);
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KEY_3DES = privateKey.export({ type: 'pkcs8', format: 'der', cipher: 'des-ede3-cbc', passphrase: PASSWORD });

class DeclFakePage {
  constructor(script = {}) {
    Object.assign(this, { rows: [], pdfsByKey: {}, links: ['Declaraciones mensuales', 'Declaración anual'],
      errorText: '', selects: {}, armedPdf: null }, script);
    this.currentUrl = 'about:blank';
  }
  async goto(url) { this.currentUrl = url; }
  url() { return this.currentUrl; }
  async clickButtonFiel() {}
  async fillFielForm(form) { this.filled = form; }
  async submitFiel() { this.currentUrl = 'https://wwwmat.sat.gob.mx/inicio'; }
  async divError() { return this.errorText; }
  async clickText(text) { return this.links.includes(text); }
  async selectSelector(selector, value) { this.selects[selector] = value; }
  async clickSelector() {}
  async declResults() { return this.rows; }
  async clickDeclDownload(kind, index) {
    const key = kind + ':' + index;
    this.armedPdf = this.pdfsByKey[key] || null;
    if (!this.armedPdf) throw new Error('sin descarga ' + key);
  }
  async waitForPdf() { return this.armedPdf; }
  async responses() { return []; }
  async close() {}
}
const driverOf = (page, state = { launches: 0 }) => async () => {
  state.launches++;
  return { newPage: async () => page, close: async () => {} };
};
const CREDS = { rfc: RFC, cer: Buffer.from('cer-juguete'), key: KEY_3DES, password: PASSWORD };
const resolver = async () => CREDS;

/* 1 · Mensuales: declaración y acuse llegan como documentos
     DISTINTOS, con su operación, periodo y fecha. */
{
  const page = new DeclFakePage({
    rows: [
      { operacion: 'OP-100', fecha: '2026-10-17', tipo: 'Provisional', periodo: '2026-09', acuse: true, declaracion: true },
      { operacion: 'OP-101', fecha: '2026-09-16', tipo: 'Provisional', periodo: '2026-08', acuse: true, declaracion: false }
    ],
    pdfsByKey: { 'declaracion:0': pdfOf('decl-sep'), 'acuse:0': pdfOf('acuse-sep'), 'acuse:1': pdfOf('acuse-ago') }
  });
  const fetchDecl = createSatDeclFetch({ resolveCredentials: resolver, launchDriver: driverOf(page) });
  const result = await fetchDecl({ rfc: RFC }, { tipo: 'mensual', ejercicio: 2026 });
  assert.equal(result.found, 2);
  assert.equal(result.documents.length, 3);
  const clases = result.documents.map(d => d.periodo + ':' + d.clase).sort();
  assert.deepEqual(clases, ['2026-08:acuse', '2026-09:acuse', '2026-09:declaracion']);
  const decl = result.documents.find(d => d.clase === 'declaracion');
  assert.equal(decl.operacion, 'OP-100');
  assert.equal(decl.fechaPresentacion, '2026-10-17');
  assert.deepEqual(decl.content, pdfOf('decl-sep'));
}

/* 2 · Anual: el PDF de la anual y su acuse, por su conector. */
{
  const page = new DeclFakePage({
    rows: [{ operacion: 'OP-900', fecha: '2026-03-28', tipo: 'Anual', periodo: '2025', acuse: true, declaracion: true }],
    pdfsByKey: { 'anual:0': pdfOf('anual-2025'), 'acuse:0': pdfOf('acuse-anual-2025') }
  });
  const fetchDecl = createSatDeclFetch({ resolveCredentials: resolver, launchDriver: driverOf(page) });
  const result = await fetchDecl({ rfc: RFC }, { tipo: 'anual', ejercicio: 2025 });
  assert.equal(result.documents.length, 2);
  assert.equal(result.documents.find(d => d.clase === 'declaracion').ejercicio, 2025);
}

/* 3 · Sin declaraciones presentadas: respuesta honesta con aviso,
     no un error disfrazado. */
{
  const page = new DeclFakePage({ rows: [] });
  const fetchDecl = createSatDeclFetch({ resolveCredentials: resolver, launchDriver: driverOf(page) });
  const result = await fetchDecl({ rfc: RFC }, { tipo: 'mensual', ejercicio: 2024 });
  assert.equal(result.found, 0);
  assert.equal(result.documents.length, 0);
  assert.match(result.warnings[0], /no mostró declaraciones/);
}

/* 4 · El portal no muestra el acceso: respuesta-inesperada. */
{
  const page = new DeclFakePage({ links: [] });
  const fetchDecl = createSatDeclFetch({ resolveCredentials: resolver, launchDriver: driverOf(page) });
  const error = await fetchDecl({ rfc: RFC }, { tipo: 'mensual', ejercicio: 2026 }).then(() => null, e => e);
  assert.ok(error instanceof SatDocError);
  assert.equal(error.code, 'respuesta-inesperada');
}

/* 5 · La e.firma caducada corta ANTES de abrir el navegador: el
     resolvedor es la misma validación local de constancia/opinión. */
{
  const state = { launches: 0 };
  const page = new DeclFakePage({});
  const fetchDecl = createSatDeclFetch({ launchDriver: driverOf(page, state),
    resolveCredentials: async () => { throw new SatDocError('caducada', 'caducó'); } });
  const error = await fetchDecl({ rfc: RFC }, { tipo: 'anual', ejercicio: 2025 }).then(() => null, e => e);
  assert.equal(error.code, 'caducada');
  assert.equal(state.launches, 0);
}

console.log('OK: declaraciones y acuses — mensuales y anuales por conectores separados, ' +
  'declaración y acuse como documentos distintos con operación y fecha, ejercicio sin ' +
  'presentadas con aviso honesto y caducada sin abrir el navegador.');
