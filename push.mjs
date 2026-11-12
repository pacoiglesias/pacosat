import { createECDH, createSign, createPrivateKey, createHmac, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/* ================================================================
   Avisos push PWA (1.25.0, AGREGAR 9): Web Push de verdad, sin
   dependencias — VAPID (RFC 8292, JWT ES256 firmado con la clave
   de la aplicación) y cifrado del cuerpo aes128gcm (RFC 8291:
   ECDH P-256 + HKDF + AES-128-GCM). La clave privada VAPID vive
   SOLO en la configuración del servidor; la pública es pública
   por diseño (la usa el navegador para suscribirse). El cuerpo
   que viaja a los servicios de push de los navegadores es
   GENÉRICO («hay un aviso crítico»): ningún dato fiscal sale de
   PacoSAT por esta vía — el detalle se lee dentro de la app,
   tras su puerta.
   ================================================================ */

const b64u = value => Buffer.from(value).toString('base64url');
const fromB64u = value => Buffer.from(String(value || ''), 'base64url');

/* Par VAPID nuevo: la pública es el punto P-256 sin comprimir
   (65 bytes, prefijo 0x04) en base64url; la privada, el escalar. */
export function generateVapidKeys() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { publicKey: b64u(ecdh.getPublicKey(null, 'uncompressed')),
    privateKey: b64u(ecdh.getPrivateKey()) };
}

function vapidPrivateKeyObject(keys) {
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(fromB64u(keys.privateKey));
  const pub = ecdh.getPublicKey(null, 'uncompressed');
  return { jwk: { kty: 'EC', crv: 'P-256',
      x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)),
      d: String(keys.privateKey) },
    pub };
}

/* JWT VAPID (ES256): aud = origen del servicio de push, exp ≤ 24 h,
   sub = contacto del operador (mailto: de la instalación). */
export function vapidAuthorization(endpoint, keys, subject, now = Date.now()) {
  const audience = new URL(endpoint).origin;
  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const payload = b64u(JSON.stringify({ aud: audience,
    exp: Math.floor(now / 1000) + 12 * 3600, sub: subject }));
  const { jwk } = vapidPrivateKeyObject(keys);
  const signer = createSign('SHA256');
  signer.update(header + '.' + payload);
  const signature = signer.sign({ key: createPrivateKey({ key: jwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' });
  return 'vapid t=' + header + '.' + payload + '.' + b64u(signature) + ', k=' + keys.publicKey;
}

const hmac = (key, data) => createHmac('sha256', key).update(data).digest();

/* Cifrado RFC 8291 (aes128gcm) del cuerpo para UNA suscripción.
   Devuelve el cuerpo binario completo (sal + tamaño de registro +
   clave pública efímera + texto cifrado con su etiqueta GCM). */
export function encryptPushPayload(subscription, payload, salt = randomBytes(16)) {
  const uaPublic = fromB64u(subscription?.keys?.p256dh);
  const auth = fromB64u(subscription?.keys?.auth);
  if (uaPublic.length !== 65 || auth.length !== 16)
    throw new Error('La suscripción push no trae sus claves (p256dh/auth) en la forma esperada.');
  const ephemeral = createECDH('prime256v1');
  ephemeral.generateKeys();
  const asPublic = ephemeral.getPublicKey(null, 'uncompressed');
  const shared = ephemeral.computeSecret(uaPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'utf8'), uaPublic, asPublic]);
  const ikm = hmac(hmac(auth, shared), Buffer.concat([keyInfo, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), Buffer.from([1])])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: nonce\0', 'utf8'), Buffer.from([1])])).subarray(0, 12);
  const record = Buffer.concat([Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8'), Buffer.from([2])]);
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const encrypted = Buffer.concat([cipher.update(record), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(16 + 4 + 1);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, encrypted]);
}

/* Envío de un push: POST al endpoint de la suscripción con el
   cuerpo cifrado y la cabecera VAPID. fetchImpl inyectable para
   las pruebas (el servicio de push real es el del navegador). */
export async function sendWebPush({ subscription, payload, vapid, subject, fetchImpl = fetch, now = Date.now() }) {
  const body = encryptPushPayload(subscription, Buffer.from(JSON.stringify(payload), 'utf8'));
  const response = await fetchImpl(subscription.endpoint, { method: 'POST',
    headers: { 'Authorization': vapidAuthorization(subscription.endpoint, vapid, subject, now),
      'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream',
      'TTL': '86400', 'Urgency': 'high' },
    body });
  return { status: response?.status || 0 };
}

/* Descifrado simétrico SOLO para verificar el cifrado en las
   pruebas de la casa (el navegador descifra con su clave privada;
   aquí la «privada» es la de la suscripción de prueba). */
export function decryptPushPayloadForTest(body, uaPrivateB64u, authB64u) {
  const salt = body.subarray(0, 16);
  const idLen = body[20];
  const asPublic = body.subarray(21, 21 + idLen);
  const encrypted = body.subarray(21 + idLen);
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(fromB64u(uaPrivateB64u));
  const uaPublic = ecdh.getPublicKey(null, 'uncompressed');
  const shared = ecdh.computeSecret(asPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'utf8'), uaPublic, asPublic]);
  const ikm = hmac(hmac(fromB64u(authB64u), shared), Buffer.concat([keyInfo, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), Buffer.from([1])])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: nonce\0', 'utf8'), Buffer.from([1])])).subarray(0, 12);
  const tag = encrypted.subarray(encrypted.length - 16);
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(encrypted.subarray(0, encrypted.length - 16)), decipher.final()]);
  return plain.subarray(0, plain.length - 1); /* fuera el delimitador 0x02 */
}
