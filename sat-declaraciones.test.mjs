import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { SatDocError } from './sat-doc-fetch.mjs';
import { createSatDeclFetch } from './sat-declaraciones.mjs';

/* Declaraciones y acuses (punto 7 de la 1.9.0): el portal es un
   driver falso que implementa el contrato documentado en
   sat-declaraciones.mjs. RE-BASIFICADO en la 2.0.1 contra el
   mapa vivo completo del 16 nov 2026: la consulta CLÁSICA del
   PTSC resultó un callejón sin salida («sin resultados» en
   todo lo probado) y el pasillo va ahora por el PORTAL NUEVO
   (menú «Nuevo portal de pagos provisionales» → «Consultas» →
   «De la declaración» → consulta por ejercicio → cada fila con
   su «Generar PDF», que es su ACUSE). La doble implementa ESE
   contrato (portalNuevoResults/clickPortalPdf): por fila solo
   baja el acuse — la declaración misma no la ofrece esta
   consulta —. Ninguna credencial sale a la red. */
const RFC = 'MFI6212158B4';
const PASSWORD = 'buena-efirma';
const pdfOf = (label) => Buffer.concat([Buffer.from('%PDF-1.4 ' + label + '\n'),
  Buffer.alloc(1024, 0x2e), Buffer.from('\n%%EOF')]);
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KEY_3DES = privateKey.export({ type: 'pkcs8', format: 'der', cipher: 'des-ede3-cbc', passphrase: PASSWORD });

class DeclFakePage {
  constructor(script = {}) {
    Object.assign(this, { rows: [], pdfsByKey: {},
      links: ['Nuevo portal de pagos provisionales', 'Consultas', 'De la declaración'],
      errorText: '', selects: {}, armedPdf: null }, script);
    this.currentUrl = 'about:blank';
  }
  async goto(url) { this.currentUrl = url; }
  url() { return this.currentUrl; }
  async clickButtonFiel() {}
  async fillFielForm(form) { this.filled = form; }
  async submitFiel() { this.currentUrl = 'https://ptscdecprov.clouda.sat.gob.mx/plataforma'; }
  async divError() { return this.errorText; }
  async clickText(text) { return this.links.includes(text); }
  async selectSelector(selector, value) { this.selects[selector] = value; }
  async clickSelector() {}
  /* El contrato del portal nuevo (2.0.1): las filas de «De la
     declaración» y el clic sobre su «Generar PDF» (el acuse). */
  async portalNuevoResults() { return this.rows; }
  /* El texto visible de la página (2.3.2): la lectura de la
     consulta lo sondea buscando la confirmación de vacío del
     propio portal; la doble lo sirve desde textoPagina. */
  async text() { return this.textoPagina || ''; }
  async clickPortalPdf(index) {
    const key = 'acuse:' + index;
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

/* 1 · Mensuales: por cada fila baja su ACUSE («Generar PDF»)
     con la identidad de la fila: operación, periodo y fecha.
     La declaración misma no la ofrece esta consulta (2.0.1). */
{
  const page = new DeclFakePage({
    rows: [
      { operacion: '262620100100', fecha: '17/10/2026', tipo: 'Normal', periodo: '2026-09', pdfIndex: 0 },
      { operacion: '262620101101', fecha: '16/09/2026', tipo: 'Normal', periodo: '2026-08', pdfIndex: 1 }
    ],
    pdfsByKey: { 'acuse:0': pdfOf('acuse-sep'), 'acuse:1': pdfOf('acuse-ago') }
  });
  const fetchDecl = createSatDeclFetch({ resolveCredentials: resolver, launchDriver: driverOf(page) });
  const result = await fetchDecl({ rfc: RFC }, { tipo: 'mensual', ejercicio: 2026 });
  assert.equal(result.found, 2);
  assert.equal(result.documents.length, 2);
  const clases = result.documents.map(d => d.periodo + ':' + d.clase).sort();
  assert.deepEqual(clases, ['2026-08:acuse', '2026-09:acuse']);
  const acuse = result.documents.find(d => d.periodo === '2026-09');
  assert.equal(acuse.operacion, '262620100100');
  assert.equal(acuse.fechaPresentacion, '17/10/2026');
  assert.equal(acuse.tipoPresentacion, 'Normal');
  assert.deepEqual(acuse.content, pdfOf('acuse-sep'));
}

/* 2 · Anual: su acuse, por su conector (la fila anual de la
     misma consulta del portal nuevo). */
{
  const page = new DeclFakePage({
    rows: [{ operacion: '262620900900', fecha: '28/03/2026', tipo: 'Anual', periodo: '2025', pdfIndex: 0 }],
    pdfsByKey: { 'acuse:0': pdfOf('acuse-anual-2025') }
  });
  const fetchDecl = createSatDeclFetch({ resolveCredentials: resolver, launchDriver: driverOf(page) });
  const result = await fetchDecl({ rfc: RFC }, { tipo: 'anual', ejercicio: 2025 });
  assert.equal(result.documents.length, 1);
  assert.equal(result.documents[0].clase, 'acuse');
  assert.equal(result.documents[0].ejercicio, 2025);
  assert.deepEqual(result.documents[0].content, pdfOf('acuse-anual-2025'));
}

/* 3 · Sin declaraciones presentadas: respuesta honesta con aviso,
     no un error disfrazado.
     Re-basado en la 2.3.2 (evidencia viva del 17 nov 2026:
     corridas 47496edb/e0af7105 cerraron ok con «0 filas» sin
     constancia, habiendo 13 declaraciones en 2026): la lectura
     nueva distingue vacío CONFIRMADO por el portal (su texto
     «sin resultados») de plazo vencido sin constancia, que es
     «no-concluyente» y jamás un ok con 0. La doble de este caso
     modela el portal que SÍ confirma el año vacío; el desenlace
     no concluyente lo cubre ronda232paseos P9. */
{
  const page = new DeclFakePage({ rows: [],
    textoPagina: 'Consulta De la declaración — sin resultados para este ejercicio.' });
  const fetchDecl = createSatDeclFetch({ resolveCredentials: resolver, launchDriver: driverOf(page) });
  const result = await fetchDecl({ rfc: RFC }, { tipo: 'mensual', ejercicio: 2024 });
  assert.equal(result.found, 0);
  assert.equal(result.documents.length, 0);
  assert.match(result.warnings[0], /no mostró declaraciones/);
}

/* 4 · La consulta no se puede leer (sin lector de filas):
     respuesta-inesperada, no una lista vacía fingida. */
{
  const page = new DeclFakePage({ links: [] });
  page.portalNuevoResults = null;
  const fetchDecl = createSatDeclFetch({ resolveCredentials: resolver, launchDriver: driverOf(page) });
  const error = await fetchDecl({ rfc: RFC }, { tipo: 'mensual', ejercicio: 2026 }).then(() => null, e => e);
  assert.ok(error instanceof SatDocError);
  assert.equal(error.code, 'respuesta-inesperada');
}

/* 4b · Ejercicio anterior a 2022: el portal nuevo no llega y
     el motor lo dice en llano, sin pasear por la consulta
     clásica muerta. */
{
  const page = new DeclFakePage({});
  const fetchDecl = createSatDeclFetch({ resolveCredentials: resolver, launchDriver: driverOf(page) });
  const error = await fetchDecl({ rfc: RFC }, { tipo: 'mensual', ejercicio: 2021 }).then(() => null, e => e);
  assert.ok(error instanceof SatDocError);
  assert.equal(error.code, 'respuesta-inesperada');
  assert.match(error.message, /solo cubre ejercicios desde 2022/);
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

console.log('OK: declaraciones y acuses — portal nuevo (2.0.1): mensuales y anuales por ' +
  'conectores separados, el acuse de cada fila con su operación, periodo y fecha, ejercicio ' +
  'sin presentadas con aviso honesto, pre-2022 dicho en llano y caducada sin abrir el navegador.');
