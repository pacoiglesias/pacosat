import assert from 'node:assert/strict';
import { X509Certificate, verify as cryptoVerify } from 'node:crypto';
import { Readable } from 'node:stream';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSatDocFetch, createFileEfirmaStorage, SatDocError,
  CSF_ENTRY_URL, CSF_PDF_URL, OPINION_ENTRY_URL } from './sat-doc-fetch.mjs';
import { createPacoSATService } from './local-server.mjs';

/* Descargador de constancia y opinión (1.7.4): la e.firma de juguete
   es una pareja real generada para la prueba (certificado con el RFC
   MFI6212158B4 en serialNumber y x500UniqueIdentifier, llave PKCS#8
   cifrada con la contraseña «buena-efirma») y el portal es un
   transporte falso que VERIFICA la firma del reto con la llave
   pública del certificado recibido, como haría el SAT. Ninguna
   credencial —ni siquiera esta de juguete— sale a la red real. */
const RFC = 'MFI6212158B4';
const VALID_CER = 'MIIDhzCCAm+gAwIBAgIRMDAwMDEwMDAwMDAzMDAwMjMwDQYJKoZIhvcNAQELBQAwfzEgMB4GA1UEAxMXRU1QUkVTQSBQUlVFQkEgU0EgREUgQ1YxFTATBgNVBAUTDE1GSTYyMTIxNThCNDEVMBMGA1UELRMMTUZJNjIxMjE1OEI0MSAwHgYDVQQKExdFTVBSRVNBIFBSVUVCQSBTQSBERSBDVjELMAkGA1UEBhMCTVgwHhcNMjUwMTAxMDAwMDAwWhcNMzAwMTAxMDAwMDAwWjB/MSAwHgYDVQQDExdFTVBSRVNBIFBSVUVCQSBTQSBERSBDVjEVMBMGA1UEBRMMTUZJNjIxMjE1OEI0MRUwEwYDVQQtEwxNRkk2MjEyMTU4QjQxIDAeBgNVBAoTF0VNUFJFU0EgUFJVRUJBIFNBIERFIENWMQswCQYDVQQGEwJNWDCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBALDFNrZ4h27CzTTRZYfurb1NVotNRVDIGd8NBgxWEElaplF9BnO3zZQoOhG7xEmodDl4G+PF5uftR63E+O+PoV72ZN7iOl62GW1QOwW6DfdJsKFjPIrLuKZb1jpfQMzjjUbehlVLe84rU2cqDYuNyZcv8XGl/YITO+VUWx9RxM1UfltXZyzXNReKND6AWi/5DB67N1Xit+sxub5m1NWRsQXfuWsNP89k4s5V+pAPIm4r6hNz1jX6J0qISZcnuTUoa8G53yNnobwUJo/PHsekCg1hfUeI/bPMDvK5KrxJ69ARQ+ZcfhKCH6ALSXGUjCe6XNHouMT+fwY03hI9F/BGR6sCAwEAATANBgkqhkiG9w0BAQsFAAOCAQEAkDF6IRWiqXxH5BVQoZMHp8dZCXE57dBCfR5EgvXsOgw6wAVIfsAfHqAMugXGLUM/tXfQDyS+vzoxKyqHBCzH47pak625p99EKLojclIj8u5EyfIgg4RU16RJIHd598eVGtsfFiHGlgtac3LS6KUSA9zy+FWtKoHLzxclbJfxgkIK9PkNN4JJWKQ0TolqKC1J4HAb5TgN2u9qsx/FobB/bKT1nSUn1JHrWwzk6HXV6voF/NPjvDb6t6Al20MGlE6UBHkskH/3DQ8cx7rxCeEz00hSEDJd96vNqXqZqdq3JSEfOnFWJhaEQyfSppey5GDR2qCr8yY/Q8SKaPk0N525Yg==';
const VALID_KEY = 'MIIE6jAcBgoqhkiG9w0BDAEDMA4ECJssW8p354irAgIIAASCBMjGTbFmBfsWQwAgM+1Ne9Ie4MPOqG26b1Hel7rSqxgyf3pxEa2oDW0VtQEARbG5/HMYjzEnKMc0xfyU/wI2Tli8GZqeg0deFC2vVrgeLM6+zqWuJOm7foE+MsfQi3q3aL4vIfoxCrvCM4AOT4BcVDYbn6uCer0aNCP1Y/rzapiu4ac2gESkO/YNsG2cwOJG0MxPXfjzytc+hj/Yx+20lr6Yg5gUR0gbzkYXiVkSlaNJ3kEeNfdSSnKEy+9Lu5j0NHaiyRB30G1ObCu+DjfqskGbpc2w/MDkXVbud24xYVQ4OIVgFJ2YtSISdJH0QYJS4olyTXx6xbqT3r098oYdtxxMnNjL1Ea1Q5kpOQs6cAee68pZ9VFsQuLUGRf5HS1Z/qVvTZY0/IhuU2fRqv0OaCfvfOKuhuZu3LHzqRcumtsJs2D4JggTO7heSCrhY0pbDYnOR3uFoGedy1eHRXTHPPo5uK5pCkM4velAYjZezHUST+ms77Zo2B/m0CA9eA92z+iTKF3kGoUnJVcO4MPcPLRyUM7M1e9ANaVToL4MWQf8lX55NXuA0oLn1E+LdtVqCjwaKVYFG+BZAbZSrzMCV1NzyJHjuicg4+/QLMar2i/nY3ZsjSbKJBwR9QgBU1sBPVZRVWwzazC4R/xV1tapJHuQsnUfGHRfEUCrlNwCoJmEOuvIjlgIOzEmfSn/gDaM/tPzVN7vzX1RYWoNNPP7a0RfI93IV2MX6WlbfmWCuNGlcDJUFiv/VU2GXMtWaY8F73aXpwISYM2VCqo9CBjBCSSgqS1vQWxz+PvdmoZdfYZtPHkE051kOCKauTmjjRcY6r3JSheGOHcIZyG/FcpBmzcg9wZq6xVBILqi70zqD2UHUTILDJ02mP3qRd7E2m1YEwGpMy182kwxRHkBHhjFDthRZX1yz+yEByo2L11Jc59E6gDFKeL4TD5+QsM9vlh2bNXNkKMZs50fI+DAgkBkwtizhPOE+KIzrSpBcQHNGWC1UsEv8kmuUUCDaaF9y4RF+ijZ+8OdeJHrzzfialfSvrsLx1ESHdWXRMASgrZANSsAA5rC8fFKTthILMM2P8AxvZlnP+0k3XL6AcyG2D1lB0UK3AX269E9adjaCgwBrH+3VDzqVb3Gbyy93TAFOMcp6psBmD7EYaorQ3tfWA3pRRrPms5T0imyIfhHcjPUd9PBU1bFxscK7YvzXPUMyAyRvAzqr7o8KUDK3Fk3h6jzbJSZwqYNuWRWyz/9bNGxorub1S4j9OGJOFlKY8oxv5Wnh9yiFlDYoEGzlsgBi0p1rF8SRB2kbJ6UnisearZm0Wlrp0FN9/SE4yfCUySeeaSvPBhpDPUbQPAXbLG9shZ2V9SjeuOC2YYH6RD+M9B5XZbeaZS6siL0me9hGLvoNSksuzs3ZN82A8eiNsMTh4nxPkMpe493TiJx2hxUvOCOLlqXuOLOaK7MH4Jpb4cA9ETfcRaPTgKSQ2BuH8+rW6UNOboz5fVufQc/X0ZSaqaP3BgrG+fWeHwuZgV6r5chSh8Z7vxrZAP7g1cEQsqATWVufPV/OoCF/c5W2eNKFfWK/yWjfVgn4wB8R88M2w4jkEI8rmBaEU/OWplnFMJxGeDYXpJFLdWcx7JjiOk=';
const EXPIRED_CER = 'MIIDhzCCAm+gAwIBAgIRMDAwMDEwMDAwMDAzMDAwMjMwDQYJKoZIhvcNAQELBQAwfzEgMB4GA1UEAxMXRU1QUkVTQSBQUlVFQkEgU0EgREUgQ1YxFTATBgNVBAUTDE1GSTYyMTIxNThCNDEVMBMGA1UELRMMTUZJNjIxMjE1OEI0MSAwHgYDVQQKExdFTVBSRVNBIFBSVUVCQSBTQSBERSBDVjELMAkGA1UEBhMCTVgwHhcNMjAwMTAxMDAwMDAwWhcNMjEwMTAxMDAwMDAwWjB/MSAwHgYDVQQDExdFTVBSRVNBIFBSVUVCQSBTQSBERSBDVjEVMBMGA1UEBRMMTUZJNjIxMjE1OEI0MRUwEwYDVQQtEwxNRkk2MjEyMTU4QjQxIDAeBgNVBAoTF0VNUFJFU0EgUFJVRUJBIFNBIERFIENWMQswCQYDVQQGEwJNWDCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBALln8ptvQ5P33eJHC6SH6I69JjE2fsa3Dqn3rospaaYdgMrteBthDAMXf0nK1QB4euSsA7t4uUszelOeLyQfZ1FvG9G+80vVtOm00HSdTs74abpgWZiYN9towzPwNJEC5jJovswb3UYFnCi/TUE3jNs1Hu0p/IBVzrJlQ5qacsUuXQ7vGmGNrS5nBTtX6nDEU8asZobpwO2rDwFUFoVDYm5zJ/LrYYkYvGF8ZoNNA76xbf2OFmWoxKq11AzPyLmh7ofpfH03BjqiJFwZOenBNkjLgFL7wEsxlcaDdIAgPz7Z15HlWdl39u5R5mUJV2F1S2P/HeNdI5Fu/CiOd3zvYxMCAwEAATANBgkqhkiG9w0BAQsFAAOCAQEAQqH284x7dydrTO3pvdMOXvM8RrSP7MdmsIkShXZIKQv5ZFxbO6viJca2Zbb6WjKwhG78DeSwIe7zRE3lJm0YDD+ZPq/KPysuLxiUiOoOtE9a3ed524LNQnQVDh9CNvafIZ9Bkxc1ayRlTyIu3ZjtPv0GyBOnMb9INjzWVyT3nOe1HXBSzLEtbOAHbvGmmT0Cy2Ttaa0LSBeV4z1jcZZPDqY0G1/s7j0hQjYz8962t3hw3BPNjHKAi72ZD5jEOyZEeoUK0jwNInmMKeE00vsx+QdUesnEvzGYwLW6R5RRNte6O+2N5GXCY7DWVnhPv+BzhdDoPeJ5DDLdxaLisZD9qg==';
const EXPIRED_KEY = 'MIIE6jAcBgoqhkiG9w0BDAEDMA4ECBMFTaNqAxYvAgIIAASCBMiPnX+ttVWnvlm+K81oyDjVmDRUwjp9asCiRSKuUuQa9szFhZFeaOUrUfYr6bY+YhY3bbID69hNzpPEPrbAhrxHvVmTI9yYomycC4ogak0rFT1774ZymnrB6NKcVBsocQanYOLXNnEGLNfO4lhON9u1aJMokiUhu/+uQMt9aTOICoZXKA8Uqg8fNWDwIOjmRvOxgGNevPqxcBy2Gi78lE7AbX7ce4bMUfDULYQPXko2YNlt1fSg8ASr+2y3luL9q2BaaWqYSAfga4PHbXMoYynllSfOfWumtyzJCkXcqrHbjoQ1DqyLfQhFlu600bVzl39LmnfZyT53nxcf7kH7fM7MbXxgLf47LfW4k5xUvKSGxi5jLPhVEUdEBA/XWKXQ7wovX66+QMIIo/LEJM3YV6pOj6MDiBHcvxuvczw0nIuagJPlkKodn+HTqKH7AQfHDz72YYYsu+8QK9zKtLo4G1T82J4wZ6YTLF1KoKlpwr/Ft/WosZT4SoMMr3N5fPNgJiNZKDPvqfOLX3KbEFYoi8QC91cdUJjETj56vPDKU44jyrofihYkVhBGuDO22Lm844y+omTGHi278YBwUwKs1SD8k2uSM7jNKMWZM2iUHeX9Em4h3wyM4SGJr6TiDuDi3MTLF0if4z1BfEwToOr4DmIDfmTNw9RkL15GRCfWB6Czk+CAhDcDxswJGF9b9BCgrgaIoyy5XMAwDf5Mz/sCjS9gp0My6qHHvIvKUhYIGGoDVjkf5NFbC8dE7i2LyC4SQYlCWjJktESNGdz8U9qQovxMT8Giq5b6t5YbdYqPbDGS5bAM1UaP5vtv9Ej/jnC3qVwdVoaLx80004oa+Tt+ZW8VQXzglmd8ml9zEinc4J4HHdlDzWIGED7P4ScGbznGzskeVF8lSKe5kr2TiCYwaFQ+9AF7YULkG/vVmvVZegbuFiMFlQCMoZPQEB6lGwO5oZkEthWLPy23NU2TNHDqLZq7Oi2vZVnfcJ3eRZ1pF7nccZmgvsgfGezzaj9NK+TQTMcnO1incB4m419yegLCQ4HKlSU3fZd5uEz+QZDKKdTtbeU+vg7vz2TGKMkpRDst1cLDM66FkMhpkBuCQyXifQTY/3V7r0sglpkJIBM3jwz+w5umn+IvSP5PHcAd6C37aAnz8h0KC+48zleAgOED7X+Cx2oq9Z3CbhVcgVxgOj8DTJygXyzNd4U5QZCOKow288SkheYcdFtxmkp7CUb7vrA9yY8maS+ipiTR51PjCi2HME8jOMOkl3J84siSzsJu3FIrm01Y9E2OHcXha6jttKDhLQt+xUWWQHHm9nKqR4UJc9Xwnr9ohWyCTSHk1HbQlw0xrVJbT/9ahyW/49VZSomOWvzS/bYCLWtPAidg7XHbDqiehVKbNzgXziEBpQDXPTzgiDxgkoz95qfthyFccn1QcduKuMvmOoPaJczPTZfw+xZ0XXnzKTHKcvtUIfJ9BAI2hFCo7r+29hUc5n7bmt0wbmET7yO0whUk2c1F6z6JCiViX1vLbNMkrhKAW6f6vENl771JQh2/XCcJ0zNp3X9c678e2A6U5C84x8r0cELbv1oHNT2ENqgrZ8gjWI//JhPyrKEhy1Ooj+yIkLDZ7+rI/B0U6+B+x5o=';
const NOW = Date.parse('2026-11-09T15:00:00Z');
const TOKEN = 'TOKEN-DE-PRUEBA-12345';
const PDF = Buffer.concat([Buffer.from('%PDF-1.4 documento de juguete\n'),
  Buffer.alloc(1024, 0x2e), Buffer.from('\n%%EOF')]);

const LOGIN_PAGE = `<!doctype html><html><body>
  <h1>SAT Autenticación</h1>
  <form id="formPassword" action="/nidp/password" method="post">
    <input id="rfc" name="rfc" type="text">
    <input id="password" name="password" type="password">
    <img src="data:image/png;base64,iVBORw0KGgo=">
    <input id="userCaptcha" name="userCaptcha" type="text">
    <input id="submit" type="submit" value="Enviar">
  </form>
  <form id="formFiel" action="/nidp/fiel" method="post">
    <input type="hidden" name="token" value="${TOKEN}">
    <input type="hidden" name="certificado">
    <input type="hidden" name="firma">
    <input type="file" id="fileCertificate" name="fileCertificate">
    <input type="file" id="filePrivateKey" name="filePrivateKey">
    <input type="password" id="privateKeyPassword" name="privateKeyPassword">
    <div id="divError"></div>
    <input id="submit" type="submit" value="Enviar">
  </form>
</body></html>`;
/* Variante «solo en pantalla»: el formulario de e.firma sin reto ni
   huecos computables — la firma la haría el código de la página. */
const LOGIN_PAGE_SIN_CONTRATO = LOGIN_PAGE
  .replace(`<input type="hidden" name="token" value="${TOKEN}">`, '')
  .replace('<input type="hidden" name="certificado">', '')
  .replace('<input type="hidden" name="firma">', '');

function storageWith({ meta, cer = VALID_CER, key = VALID_KEY }) {
  return {
    readIndex: () => (meta === null ? {} : { [RFC]: meta }),
    readFile: (rfc, ext) => {
      const b64 = ext === '.cer' ? cer : key;
      return b64 === null ? null : Buffer.from(b64, 'base64');
    }
  };
}
const goodStorage = () => storageWith({ meta: { password: 'buena-efirma' } });

/* Portal falso: registra cada llamada y reproduce la cadena
   entrada → login NIDP → (firma verificada) → aterrizaje → PDF. */
function fakePortal({ loginPage = LOGIN_PAGE, rejectLogin = '', pdfAtCallback = false,
  constanciaPdf = true } = {}) {
  const calls = [];
  const transport = async ({ method, url, body }) => {
    calls.push({ method, url, body: body ? String(body) : '' });
    const u = new URL(url);
    const reply = (status, headers, content) => ({ status,
      headers: { 'content-type': 'text/html; charset=utf-8', ...headers },
      body: Buffer.isBuffer(content) ? content : Buffer.from(content) });
    if (url === CSF_ENTRY_URL || url === OPINION_ENTRY_URL) {
      return reply(302, { location: 'https://nidp.example.test/login' }, '');
    }
    if (u.hostname === 'nidp.example.test' && u.pathname === '/login') {
      return reply(200, {}, loginPage);
    }
    if (u.hostname === 'nidp.example.test' && u.pathname === '/nidp/fiel') {
      if (rejectLogin) {
        return reply(200, {}, loginPage.replace('<div id="divError"></div>',
          `<div id="divError">${rejectLogin}</div>`));
      }
      const params = new URLSearchParams(body.toString());
      const cerBytes = Buffer.from(params.get('certificado') || '', 'base64');
      assert.equal(cerBytes.toString('base64'), VALID_CER,
        'el portal recibe el certificado del perfil en base64');
      const cert = new X509Certificate(cerBytes);
      const signature = Buffer.from(params.get('firma') || '', 'base64');
      assert.ok(cryptoVerify('sha1', Buffer.from(TOKEN), cert.publicKey, signature),
        'la firma del reto verifica con la llave pública del certificado');
      const target = pdfAtCallback
        ? 'https://ptsc32d.clouda.sat.gob.mx/oauth2/callback?code=xyz'
        : 'https://wwwmat.sat.gob.mx/operacion/43824/reimprime-tus-acuses-del-rfc';
      return reply(302, { location: target, 'set-cookie': 'sso=ok; Path=/; Domain=sat.gob.mx' }, '');
    }
    if (url === 'https://ptsc32d.clouda.sat.gob.mx/oauth2/callback?code=xyz') {
      return reply(200, { 'content-type': 'application/pdf' }, PDF);
    }
    if (url === 'https://wwwmat.sat.gob.mx/operacion/43824/reimprime-tus-acuses-del-rfc') {
      return reply(200, {}, '<html><body>Reimprime tus acuses del RFC</body></html>');
    }
    if (url === CSF_PDF_URL) {
      return constanciaPdf
        ? reply(200, { 'content-type': 'application/pdf' }, PDF)
        : reply(200, {}, '<html><body>Reimprime tus acuses del RFC</body></html>');
    }
    throw Object.assign(new Error('URL no esperada: ' + url), { code: 'ENOTFOUND' });
  };
  return { transport, calls };
}

async function expectCode(promise, code) {
  const error = await promise.then(() => null, e => e);
  assert.ok(error instanceof SatDocError, 'error tipado SatDocError: ' + error);
  assert.equal(error.code, code);
  return error;
}

/* 1 · Éxito simulado (constancia): cadena completa con firma real. */
{
  const { transport, calls } = fakePortal();
  const fetchDoc = createSatDocFetch({ storage: goodStorage(), transport, now: () => NOW });
  const result = await fetchDoc({ rfc: RFC }, 'constancia');
  assert.deepEqual(result.content, PDF);
  assert.match(result.fileName, /Constancia MFI6212158B4/);
  assert.equal(Date.parse(result.issuedAt), NOW);
  assert.ok(calls.some(c => c.method === 'POST' && c.url.includes('/nidp/fiel')),
    'se envió el formulario de e.firma una sola vez');
}

/* 2 · Éxito simulado (opinión): el PDF llega en la cadena de acceso. */
{
  const { transport } = fakePortal({ pdfAtCallback: true });
  const fetchDoc = createSatDocFetch({ storage: goodStorage(), transport, now: () => NOW });
  const result = await fetchDoc({ rfc: RFC }, 'opinion');
  assert.deepEqual(result.content, PDF);
  assert.match(result.fileName, /Opinion MFI6212158B4/);
}

/* 3 · E.firma caducada: detectada ANTES de salir a la red. */
{
  const { transport, calls } = fakePortal();
  const fetchDoc = createSatDocFetch({ transport, now: () => NOW,
    storage: storageWith({ meta: { password: 'buena-efirma' }, cer: EXPIRED_CER, key: EXPIRED_KEY }) });
  const error = await expectCode(fetchDoc({ rfc: RFC }, 'constancia'), 'caducada');
  assert.match(error.message, /caducó el 1 de enero de 2021/);
  assert.equal(calls.length, 0, 'ni una sola llamada al portal con la e.firma caducada');
}

/* 4 · Perfil sin e.firma guardada: error claro, sin red. */
{
  const { transport, calls } = fakePortal();
  const fetchDoc = createSatDocFetch({ storage: storageWith({ meta: null }), transport, now: () => NOW });
  const error = await expectCode(fetchDoc({ rfc: RFC }, 'opinion'), 'sin-efirma');
  assert.match(error.message, /no tiene una e\.firma guardada/);
  assert.equal(calls.length, 0);
}

/* 5 · Perfil sin contraseña guardada (bloqueado): sin red. */
{
  const { transport, calls } = fakePortal();
  const fetchDoc = createSatDocFetch({ transport, now: () => NOW,
    storage: storageWith({ meta: { minutes: 360, days: 7, direction: 'received' } }) });
  const error = await expectCode(fetchDoc({ rfc: RFC }, 'constancia'), 'bloqueada');
  assert.match(error.message, /sin su contraseña/);
  assert.equal(calls.length, 0);
}

/* 6 · Contraseña que no abre la llave: error claro, sin red. */
{
  const { transport, calls } = fakePortal();
  const fetchDoc = createSatDocFetch({ transport, now: () => NOW,
    storage: storageWith({ meta: { password: 'no-es-esta' } }) });
  const error = await expectCode(fetchDoc({ rfc: RFC }, 'constancia'), 'credencial-invalida');
  assert.match(error.message, /no abre la llave/);
  assert.equal(calls.length, 0);
}

/* 7 · Portal caído: la conexión se corta y también si devuelve 503. */
{
  const down = async () => { throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }); };
  const fetchDoc = createSatDocFetch({ storage: goodStorage(), transport: down, now: () => NOW });
  const error = await expectCode(fetchDoc({ rfc: RFC }, 'constancia'), 'portal-caido');
  assert.match(error.message, /no respondió/);
  const five = async () => ({ status: 503, headers: {}, body: Buffer.from('error') });
  const fetchDoc2 = createSatDocFetch({ storage: goodStorage(), transport: five, now: () => NOW });
  await expectCode(fetchDoc2({ rfc: RFC }, 'opinion'), 'portal-caido');
}

/* 8 · El portal rechaza y lo dice: su texto llega tal cual al error. */
{
  const { transport } = fakePortal({ rejectLogin: 'Certificado revocado o vencido' });
  const fetchDoc = createSatDocFetch({ storage: goodStorage(), transport, now: () => NOW });
  const error = await expectCode(fetchDoc({ rfc: RFC }, 'constancia'), 'portal-rechaza');
  assert.match(error.message, /Certificado revocado o vencido/);
}

/* 9 · Formulario sin contrato computable: paso en pantalla y, sobre
     todo, NO se envía ningún POST con material de la e.firma. */
{
  const { transport, calls } = fakePortal({ loginPage: LOGIN_PAGE_SIN_CONTRATO });
  const fetchDoc = createSatDocFetch({ storage: goodStorage(), transport, now: () => NOW });
  const error = await expectCode(fetchDoc({ rfc: RFC }, 'constancia'), 'paso-interactivo');
  assert.match(error.message, /no se envió nada de tu e\.firma/);
  assert.ok(calls.every(c => c.method === 'GET'), 'solo hubo lecturas, ningún envío');
}

/* 10 · Sesión iniciada pero la constancia exige el botón en pantalla. */
{
  const { transport } = fakePortal({ constanciaPdf: false });
  const fetchDoc = createSatDocFetch({ storage: goodStorage(), transport, now: () => NOW });
  const error = await expectCode(fetchDoc({ rfc: RFC }, 'constancia'), 'paso-interactivo');
  assert.match(error.message, /Generar Constancia/);
}

/* 11 · Cableado completo con el servicio: el descargador real (con el
      portal falso) detrás de /api/satdocs/run archiva el PDF. */
{
  const dir = mkdtempSync(join(tmpdir(), 'pacosat-satdoc-'));
  const { transport } = fakePortal();
  const origin = 'http://127.0.0.1:17381';
  const service = createPacoSATService({ dbFile: ':memory:', html: '<!--PACOSAT_TOKEN-->', origin,
    now: () => NOW, efirmaDir: dir,
    makeConnector: async ({ password }) => {
      if (password !== 'buena-efirma') throw new Error('La contraseña no abre la llave.');
      return { parser: class {}, connector: {} };
    },
    makeMailer: () => ({ verify: async () => true, sendMail: async () => {} }),
    satDocFetch: createSatDocFetch({ storage: createFileEfirmaStorage(dir), transport, now: () => NOW }) });
  let token;
  const call = async (path, data) => {
    const headers = { host: new URL(origin).host, origin, 'x-pacosat-token': token };
    const req = Object.assign(Readable.from(data === undefined ? [] : [Buffer.from(JSON.stringify(data))]), {
      url: path, method: data === undefined ? 'GET' : 'POST', headers });
    let response;
    const res = { setHeader() {}, writeHead(status) { this.status = status; this.headersSent = true; },
      end(content) { response = new Response(content, { status: this.status }); } };
    await service.handle(req, res);
    return response;
  };
  token = (await (await call('/')).text()).split('content="')[1].split('"')[0];
  /* Semilla del perfil por la vía real de la app: guarda la e.firma
     en la carpeta protegida que el descargador lee. */
  const seed = await call('/api/efirma', { rfc: RFC, certificate: VALID_CER, key: VALID_KEY,
    password: 'buena-efirma', minutes: 360, days: 30, direction: 'received' });
  assert.equal(seed.status, 200);
  const run = await (await call('/api/satdocs/run', { rfc: RFC, kind: 'constancia' })).json();
  assert.equal(run.results.constancia.ok, true);
  const view = await (await call('/api/satdocs')).json();
  assert.equal(view.profiles[0].constancia.level, 'ok');
  service.close();
}

console.log('OK: descargador SAT — firma del reto verificada contra portal falso, caducidad ' +
  'detectada sin tocar la red, errores diferenciados y archivo vía /api/satdocs/run.');
