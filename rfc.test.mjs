import assert from 'node:assert/strict';
import { rfcCheckDigit, validateRfc } from './xml-core.mjs';

// Vectores con dígito verificador confirmado fuera de esta implementación:
// RFC reales en uso y el ejemplo resuelto del SAT en su algoritmo publicado
// (GODE561231GR: la suma ponderada es 1026 y el dígito es 8).
const validos = [
  ['MFI6212158B4', 'moral'],   // empresa real, residuo 7
  ['PBS100323451', 'moral'],   // proveedor real, residuo 10
  ['TCH850701RM1', 'moral'],   // cadena comercial real, residuo 10
  ['EDE1902136T2', 'moral'],   // proveedor real, residuo 9
  ['GODE561231GR8', 'fisica'], // ejemplo oficial del SAT
  ['LOPA850312300', 'fisica'], // sintético con residuo 0 → dígito «0»
  ['LOPA85031270A', 'fisica'], // sintético con residuo 1 → dígito «A»
  ['ABC01010170A', 'moral'],   // sintético moral con residuo 1 → «A» (base de 11 con espacio antepuesto)
  ['ÑOPA010101A12', 'fisica'], // Ñ vale 38 en la tabla oficial
  ['A&C010101A1A', 'moral'],   // & vale 24 en la tabla oficial
  ['PEGA240229A12', 'fisica']  // 29 de febrero en año bisiesto (24 % 4 = 0)
];
for (const [rfc, type] of validos) {
  const result = validateRfc(rfc);
  assert.equal(result.level, 'valid', rfc + ' debería ser válido en forma: ' + result.error);
  assert.equal(result.valid, true);
  assert.equal(result.digitOk, true);
  assert.equal(result.type, type, rfc);
  assert.equal(result.generic, false);
}
assert.equal(validateRfc('mfi6212158b4').level, 'valid', 'acepta minúsculas normalizando');
assert.equal(validateRfc('  MFI6212158B4 ').rfc, 'MFI6212158B4', 'recorta espacios de los extremos');

// La función de dígito por separado, con los mismos vectores externos.
assert.equal(rfcCheckDigit('GODE561231GR'), '8');
assert.equal(rfcCheckDigit('MFI6212158B'), '4');
assert.equal(rfcCheckDigit('LOPA85031270'), 'A');
assert.equal(rfcCheckDigit(''), '');

// Ida y vuelta: para bases variadas, el dígito calculado valida y cualquier
// otro carácter en su lugar cae en el nivel de aviso, no en el de estructura.
for (const base of ['LOPA85031230', 'ABC01010170', 'XAXX01010100', 'ÑOPA010101A1', 'A&C010101A1', 'PEGA240229A1']) {
  const digit = rfcCheckDigit(base);
  assert.equal(validateRfc(base + digit).level, 'valid', 'ida y vuelta de ' + base);
  const other = digit === '0' ? '1' : '0';
  const wrong = validateRfc(base + other);
  assert.equal(wrong.level, 'digit', base + other + ' debería avisar del dígito');
  assert.equal(wrong.digitExpected, digit);
  assert.equal(wrong.valid, false);
}

// Dígito que no cuadra en un RFC real: aviso con el dígito esperado.
const errata = validateRfc('MFI6212158B5');
assert.equal(errata.level, 'digit');
assert.equal(errata.digitExpected, '4');
assert.equal(errata.digitOk, false);

// Genéricos del SAT: nota propia; XAXX no cumple el dígito por diseño y aun
// así no es un error de estructura. XEXX sí lo cumple.
const genericoSinDigito = validateRfc('XAXX010101000');
assert.equal(genericoSinDigito.generic, true);
assert.equal(genericoSinDigito.level, 'digit');
assert.equal(genericoSinDigito.digitExpected, '4');
const genericoConDigito = validateRfc('XEXX010101000');
assert.equal(genericoConDigito.generic, true);
assert.equal(genericoConDigito.level, 'valid');

// Errores de estructura y de fecha, cada uno con su mensaje concreto.
const estructura = [
  ['', /12 caracteres/],
  ['ABC', /13 \(persona física\); este tiene 3/],
  ['MFI6212158B', /este tiene 11/],        // la base sin dígito no es un RFC completo
  ['L0PA850312A12', /deben ser letras/],    // dígito dentro de las letras
  ['LOPA850312-12', /homoclave/],          // símbolo en la homoclave
  ['LOPA85031230B', /dígito verificador/], // último carácter fuera de 0-9A
  ['LOPA851301A12', /mes imposible \(13\)/],
  ['LOPA850230A12', /día imposible \(30 para el mes 02\)/],
  ['PEGA230229A1A', /día imposible \(29 para el mes 02\)/] // 29-feb en año no bisiesto
];
for (const [rfc, pattern] of estructura) {
  const result = validateRfc(rfc);
  assert.equal(result.level, 'structure', JSON.stringify(rfc) + ' debería fallar en estructura');
  assert.match(result.error, pattern, JSON.stringify(rfc) + ' → ' + result.error);
  assert.equal(result.valid, false);
}

console.log('OK: validador de RFC — vectores reales y del SAT, dígito «A», genéricos, estructura y fechas.');
