import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';

// Mismo formato que el respaldo manual del navegador (data.part): magia FARO2,
// PBKDF2-SHA256 con 600 000 iteraciones y AES-256-GCM con la etiqueta al final.
// Un respaldo programado del servidor se restaura desde la interfaz y viceversa.
const MAGIC = Buffer.from('FARO2\n');
const SALT_SIZE = 16;
const IV_SIZE = 12;
const TAG_SIZE = 16;

function deriveKey(password, salt) {
  return pbkdf2Sync(Buffer.from(String(password), 'utf8'), salt, 600000, 32, 'sha256');
}

export function encryptBackupBuffer(data, password) {
  const salt = randomBytes(SALT_SIZE);
  const iv = randomBytes(IV_SIZE);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(password, salt), iv);
  const plain = Buffer.from(JSON.stringify(data), 'utf8');
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([MAGIC, salt, iv, encrypted, cipher.getAuthTag()]);
}

export function decryptBackupBuffer(raw, password) {
  const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  if (buffer.length < MAGIC.length + SALT_SIZE + IV_SIZE + TAG_SIZE ||
      !buffer.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('El archivo no es un respaldo PacoSAT válido.');
  }
  const salt = buffer.subarray(MAGIC.length, MAGIC.length + SALT_SIZE);
  const iv = buffer.subarray(MAGIC.length + SALT_SIZE, MAGIC.length + SALT_SIZE + IV_SIZE);
  const payload = buffer.subarray(MAGIC.length + SALT_SIZE + IV_SIZE);
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(password, salt), iv);
  decipher.setAuthTag(payload.subarray(payload.length - TAG_SIZE));
  let plain;
  try {
    plain = Buffer.concat([decipher.update(payload.subarray(0, payload.length - TAG_SIZE)), decipher.final()]);
  } catch { throw new Error('Contraseña incorrecta o respaldo dañado.'); }
  return JSON.parse(plain.toString('utf8'));
}
