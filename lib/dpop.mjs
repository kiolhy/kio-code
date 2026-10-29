// DPoP（RFC 9449）：码道 CLI 登录时会在 auth.json 里留下 dpop_key_pair，
// 说明它用 DPoP 把 access token 绑定到客户端密钥。这里复刻同样机制：
// ES256（P-256）密钥对 + 每次请求的 DPoP 证明（一个 ES256 签名的 JWT）。
import crypto from 'node:crypto';

const b64u = (buf) => Buffer.from(buf).toString('base64url');

/** 生成 P-256 密钥对，返回 JWK(公开) + PKCS8 PEM(私钥) + KeyObject */
export function generateDpopKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const publicJwk = publicKey.export({ format: 'jwk' });
  return {
    publicJwk,
    privatePem: privateKey.export({ format: 'pem', type: 'pkcs8' }),
    privateKey,
  };
}

/**
 * 生成一次请求的 DPoP 证明。
 * @param {object} p
 * @param {crypto.KeyObject|string} p.privateKey  私钥 KeyObject 或 PKCS8 PEM
 * @param {object} p.publicJwk                     公钥 JWK（放进 JWT header）
 * @param {string} p.htu                           目标 URL（不带 query/fragment）
 * @param {string} p.htm                           HTTP 方法，大写
 * @param {string} [p.nonce]                       服务端下发的 nonce
 * @param {string} [p.ath]                         access_token 的 SHA-256 base64url
 */
export function createDpopProof({ privateKey, publicJwk, htu, htm, nonce, ath } = {}) {
  const key = typeof privateKey === 'string'
    ? crypto.createPrivateKey(privateKey)
    : privateKey;
  const header = { typ: 'dpop+jwt', alg: 'ES256', jwk: publicJwk };
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    htm: String(htm ?? 'POST').toUpperCase(),
    htu: String(htu ?? ''),
    iat: now,
    jti: crypto.randomBytes(16).toString('hex'),
  };
  if (nonce) claims.nonce = nonce;
  if (ath) claims.ath = ath;
  const signingInput = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(claims))}`;
  // JWS/JOSE 要求 ECDSA 签名是 P1363（r||s，64 字节），Node 默认给 DER，必须显式指定
  const sig = crypto.sign('sha256', Buffer.from(signingInput), { key, dsaEncoding: 'ieee-p1363' });
  return `${signingInput}.${b64u(sig)}`;
}

/** 解析 DPoP 证明（不验签），返回 {header, claims}，供测试/调试 */
export function decodeDpopProof(proof) {
  const [h, c] = String(proof).split('.');
  return {
    header: JSON.parse(Buffer.from(h, 'base64url').toString('utf8')),
    claims: JSON.parse(Buffer.from(c, 'base64url').toString('utf8')),
  };
}

/** 验证 DPoP 证明签名，返回布尔 */
export function verifyDpopProof(proof, publicKey) {
  const parts = String(proof).split('.');
  if (parts.length !== 3) return false;
  const key = typeof publicKey === 'string' ? crypto.createPublicKey(publicKey) : publicKey;
  try {
    return crypto.verify(
      'sha256',
      Buffer.from(`${parts[0]}.${parts[1]}`),
      { key, dsaEncoding: 'ieee-p1363' },
      Buffer.from(parts[2], 'base64url')
    );
  } catch {
    return false;
  }
}

/** access_token 的 DPoP ath 值：SHA-256(access_token) 的 base64url */
export function accessTokenHash(token) {
  return crypto.createHash('sha256').update(String(token)).digest('base64url');
}
