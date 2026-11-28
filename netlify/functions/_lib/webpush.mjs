// Web Push uden eksterne pakker: VAPID (RFC 8292) + aes128gcm-kryptering (RFC 8291). Kun Node-crypto.
import crypto from 'node:crypto';

const b64u = b => Buffer.from(b).toString('base64url');
const fromB64u = s => Buffer.from(String(s), 'base64url');

export function vapidKey(pubB64u, privB64u) {
  const pub = fromB64u(pubB64u);
  if (pub.length !== 65 || pub[0] !== 4) throw new Error('bad vapid public key');
  return crypto.createPrivateKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)), d: privB64u }, format: 'jwk' });
}
export function vapidHeader(endpoint, env) {
  const aud = new URL(endpoint).origin;
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const body = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: env.VAPID_SUBJECT || 'mailto:morten@unisjak.dk' }));
  const sig = crypto.sign('sha256', Buffer.from(head + '.' + body), { key: vapidKey(env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY), dsaEncoding: 'ieee-p1363' });
  return 'vapid t=' + head + '.' + body + '.' + b64u(sig) + ', k=' + env.VAPID_PUBLIC_KEY;
}
/** Krypterer payload til modtagerens p256dh/auth. Returnerer krop (Buffer) til POST. */
export function encryptPayload(payload, p256dhB64u, authB64u, opts = {}) {
  const ua = fromB64u(p256dhB64u), auth = fromB64u(authB64u);
  if (ua.length !== 65 || auth.length < 8) throw new Error('bad subscription keys');
  const ecdh = opts.ecdh || crypto.createECDH('prime256v1'); if (!opts.ecdh) ecdh.generateKeys();
  const asPub = ecdh.getPublicKey(), secret = ecdh.computeSecret(ua);
  const salt = opts.salt || crypto.randomBytes(16);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), ua, asPub]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', secret, auth, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const data = Buffer.concat([Buffer.from(payload), Buffer.from([2])]);
  if (data.length > 3800) throw new Error('payload too large');
  const c = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ct = Buffer.concat([c.update(data), c.final(), c.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPub.length]), asPub, ct]);
}
/** Sender én push. Returnerer { ok, status, gone } – gone=true når abonnementet er dødt (404/410). */
export async function sendPush(sub, payloadObj, env, fetchFn = fetch) {
  try {
    const body = encryptPayload(JSON.stringify(payloadObj), sub.p256dh, sub.auth);
    const r = await fetchFn(sub.endpoint, { method: 'POST', headers: { Authorization: vapidHeader(sub.endpoint, env), 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '86400', Urgency: 'high' }, body });
    return { ok: r.status >= 200 && r.status < 300, status: r.status, gone: r.status === 404 || r.status === 410 };
  } catch (e) { return { ok: false, status: 0, gone: false, error: String(e && e.message || e) }; }
}
