/* ===== Caja de secretos del equipo (1.22.0, S1) =====
   La CIEC y la contraseña de la e.firma vivían en TEXTO CLARO
   dentro de perfiles.json (carpeta 0700, fichero 0600, pero
   claro al fin). Desde la 1.22.0 viajan cifradas en reposo con
   AES-256-GCM y una llave DEL PROPIO EQUIPO: la variable
   PACOSAT_SECRET_KEY si existe; si no, un fichero llave
   (.llave, 0600) creado una sola vez en la misma carpeta
   protegida. El formato «enc:v1:» permite convivir con valores
   legados en claro durante la migración: leer acepta ambos,
   escribir siempre cifra. Si el descifrado falla, se devuelve
   el valor tal cual y la migración lo cuenta como error — el
   original NUNCA se pierde por cifrar. */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PREFIX = 'enc:v1:';
let cachedKey = null;

export function machineKey(dir) {
  if (cachedKey) return cachedKey;
  const fromEnv = process.env.PACOSAT_SECRET_KEY || '';
  if (fromEnv) {
    cachedKey = createHash('sha256').update('pacosat:' + fromEnv).digest();
    return cachedKey;
  }
  const keyPath = join(dir, '.llave');
  try {
    if (existsSync(keyPath)) {
      const raw = Buffer.from(readFileSync(keyPath, 'utf8').trim(), 'base64');
      if (raw.length === 32) { cachedKey = raw; return cachedKey; }
    }
  } catch { /* se crea abajo */ }
  const key = randomBytes(32);
  writeFileSync(keyPath, key.toString('base64'), { mode: 0o600 });
  cachedKey = key;
  return cachedKey;
}

export function encryptSecret(dir, value) {
  const text = String(value ?? '');
  if (!text || text.startsWith(PREFIX)) return text;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', machineKey(dir), iv);
  const ct = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
}

export function decryptSecret(dir, value) {
  const text = String(value ?? '');
  if (!text.startsWith(PREFIX)) return text;
  try {
    const raw = Buffer.from(text.slice(PREFIX.length), 'base64');
    const decipher = createDecipheriv('aes-256-gcm', machineKey(dir), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  } catch { return text; }
}

export const isEncryptedSecret = value => String(value ?? '').startsWith(PREFIX);

/* Los campos secretos del índice de perfiles, por RFC. */
const SECRET_FIELDS = ['password', 'ciec'];
export function mapIndexSecrets(index, fn) {
  const out = {};
  for (const [rfc, meta] of Object.entries(index || {})) {
    const copy = { ...(meta || {}) };
    for (const field of SECRET_FIELDS)
      if (copy[field]) copy[field] = fn(copy[field]);
    out[rfc] = copy;
  }
  return out;
}
export const encryptIndexSecrets = (dir, index) => mapIndexSecrets(index, value => encryptSecret(dir, value));
export const decryptIndexSecrets = (dir, index) => mapIndexSecrets(index, value => decryptSecret(dir, value));
