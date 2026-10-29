// 账号池的「授权登录」添加：
//   1) sts / token 模式：OAuth2 授权码 →（可选）委托 STS → 临时 AK/SK → 入库
//   2) codearts-cli 模式：模拟原版码道 CLI 登录（DPoP + 设备码），链接授权 → STS 三元组 → 入库
//   3) importAuthJson：直接吃原版 CLI 落盘的 auth.json，提取 STS 三元组入库
//
// 为什么不能像 GitHub 那样只给个 token：上游 snap-access 要的是 SDK-HMAC-SHA256 签名，
// 签名的 SK 是静态密钥、只在你创建时显示一次，浏览器登录链接给不出 SK。
// 真 CLI 的登录是 OAuth(DPoP) → 拿到 STS 临时 AK/SK/SecurityToken，本模块复刻这段。
import crypto from 'node:crypto';
import { getTransport } from './transport.mjs';
import { generateDpopKeyPair, createDpopProof, accessTokenHash } from './dpop.mjs';

export class OAuthError extends Error {
  constructor(message, { code = 'oauth_error', status = 400 } = {}) {
    super(message);
    this.name = 'OAuthError';
    this.code = code;
    this.status = status;
  }
}

const getPath = (obj, p) => String(p ?? '').split('.').filter(Boolean).reduce((o, k) => o?.[k], obj);

/**
 * 从任意 token/STS 响应里抽出 STS 三元组，兼容多种常见形状：
 *   顶层 access_key_id / secret_access_key / security_token（原版 CLI 形状）
 *   access.{access_key_id,secret_access_key,security_token}（auth.json 形状）
 *   credential.{access,secret,securitytoken}（华为 IAM STS 形状）
 * 也支持 config.oauth.sts.*Path 覆盖。
 */
function parseCredential(json, sts = {}) {
  const ak = getPath(json, sts.akPath)
    ?? getPath(json, 'access_key_id')
    ?? getPath(json, 'access.access_key_id')
    ?? getPath(json, 'credential.access');
  const sk = getPath(json, sts.skPath)
    ?? getPath(json, 'secret_access_key')
    ?? getPath(json, 'access.secret_access_key')
    ?? getPath(json, 'credential.secret');
  const st = getPath(json, sts.tokenPath)
    ?? getPath(json, 'security_token')
    ?? getPath(json, 'access.security_token')
    ?? getPath(json, 'credential.securitytoken');
  const exp = getPath(json, sts.expiresAtPath)
    ?? getPath(json, 'expires_at')
    ?? getPath(json, 'access.expires_at')
    ?? getPath(json, 'credential.expires_at');
  const refresh = getPath(json, sts.refreshPath)
    ?? getPath(json, 'refresh_token')
    ?? getPath(json, 'refresh');
  const accountId = getPath(json, 'account_id') ?? getPath(json, 'accountId') ?? null;
  return { ak, sk, st, exp, refresh, accountId };
}

export function createOAuth({ cfg = {}, panel, log = () => {} } = {}) {
  const o = cfg.oauth ?? {};
  const transport = getTransport({});

  const pending = new Map(); // key(state|deviceCode) -> { expiresAt, region, dpop?, deviceCode?, nonce? }
  const results = new Map(); // key -> { done, accountId, name, error }

  const enabled = o.enabled === true;
  const mode = o.mode ?? 'sts';

  async function request(url, { method = 'POST', headers = {}, body, form = false, timeoutMs = 30000, allowError = false } = {}) {
    let payload = body;
    if (form && body && typeof body === 'object') {
      payload = new URLSearchParams(body).toString();
    }
    const r = await transport.request({
      url,
      method,
      headers: { accept: 'application/json', ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : { 'content-type': 'application/json' }), ...headers },
      body: payload,
      proxy: o.proxy || '',
      timeoutMs,
    });
    const buf = await r.buffer();
    const text = buf.toString('utf8');
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* 非 JSON 下面报错 */
    }
    if (r.status < 200 || r.status >= 300) {
      if (allowError) return { json, status: r.status, headers: r.headers };
      throw new OAuthError(json?.error_description ?? json?.message ?? text.slice(0, 160) ?? `HTTP ${r.status}`, {
        code: json?.error ?? 'upstream_error',
        status: 502,
      });
    }
    return { json, status: r.status, headers: r.headers };
  }

  function status({ state } = {}) {
    if (state) {
      const r = results.get(state);
      if (r) return { state, ...r };
      const p = pending.get(state);
      return { state, done: false, pending: !!p };
    }
    return {
      enabled,
      mode,
      clientId: !!o.clientId,
      region: o.region ?? 'cn',
      redirectUri: o.redirectUri ?? '',
      cliAuthPageUrl: o.cliAuthPageUrl ?? '',
      sts: !!(o.sts?.endpoint && o.sts?.domainId && o.sts?.agencyName),
    };
  }

  function cleanup() {
    for (const [k, v] of pending) if (v.expiresAt < Date.now()) pending.delete(k);
  }

  /* ---- 入库：统一入口 ---- */
  function storeAccount(cred, { region, source = mode, refresh, accountId } = {}) {
    const acc = panel.addAccount({
      name: `${o.accountNamePrefix ?? '授权账号'}-${Date.now().toString(36).slice(-4)}`,
      region: region ?? o.region ?? 'cn',
      authType: cred.authType ?? 'sts',
      accessKeyId: cred.accessKeyId ?? '',
      secretAccessKey: cred.secretAccessKey ?? '',
      securityToken: cred.securityToken ?? '',
      expiresAt: cred.expiresAt ?? undefined,
      domainId: accountId?.domain_id ?? accountId?.domainId ?? '',
      userId: accountId?.user_id ?? accountId?.userId ?? '',
      userName: accountId?.domain_name ?? accountId?.domainName ?? '',
      note: JSON.stringify({ source, ...(refresh ? { refresh } : {}) }),
    });
    const out = {
      done: true,
      accountId: acc.id,
      name: acc.name,
      authType: acc.authType,
      accessKeyIdMasked: acc.accessKeyId ? `${String(acc.accessKeyId).slice(0, 4)}****` : '',
      expiresAt: acc.expiresAt ?? null,
      error: null,
    };
    return { acc, out };
  }

  /* ---- 模式 1/2：授权码 ---- */
  async function start({ scope, region } = {}) {
    if (!enabled) throw new OAuthError('OAuth 授权添加未开启', { code: 'oauth_disabled', status: 409 });
    cleanup();

    if (mode === 'codearts-cli') {
      return startDevice({ scope, region });
    }

    if (!o.clientId) throw new OAuthError('缺少 oauth.clientId', { code: 'no_client_id', status: 400 });
    if (!o.authorizeUrl) throw new OAuthError('缺少 oauth.authorizeUrl', { code: 'no_authorize_url', status: 400 });

    const state = crypto.randomBytes(24).toString('hex');
    const ttl = Number(o.stateTtlMs ?? 600000);
    pending.set(state, { expiresAt: Date.now() + ttl, region: region ?? o.region ?? 'cn' });

    const url = new URL(o.authorizeUrl);
    url.searchParams.set('client_id', o.clientId);
    url.searchParams.set('redirect_uri', o.redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', scope ?? o.scope ?? 'openid');
    url.searchParams.set('state', state);

    log('info', `OAuth 授权流程开始（state=${state.slice(0, 8)}…）`);
    return { authorizeUrl: url.toString(), state, redirectUri: o.redirectUri, expiresIn: ttl };
  }

  async function exchangeToken(code) {
    if (!o.tokenUrl) throw new OAuthError('缺少 oauth.tokenUrl', { code: 'no_token_url', status: 400 });
    const { json: token } = await request(o.tokenUrl, {
      form: true,
      body: {
        grant_type: 'authorization_code',
        code,
        redirect_uri: o.redirectUri,
        client_id: o.clientId,
        ...(o.clientSecret ? { client_secret: o.clientSecret } : {}),
      },
    });
    if (!token.access_token && !token.id_token) {
      throw new OAuthError('授权码换 token 失败：响应里没有 access_token/id_token', { code: 'token_exchange_failed', status: 502 });
    }
    return token;
  }

  async function assumeRole(token) {
    const sts = o.sts ?? {};
    if (!sts.endpoint || !sts.domainId || !sts.agencyName) {
      throw new OAuthError('STS 未配置（oauth.sts.endpoint/domainId/agencyName）', { code: 'sts_not_configured', status: 400 });
    }
    const bearer = token[sts.tokenField ?? 'access_token'] ?? token.access_token ?? token.id_token;
    if (!bearer) throw new OAuthError('没有可用 token 换 STS', { code: 'no_bearer', status: 502 });

    const url = sts.endpoint.replace('{domainId}', sts.domainId);
    const { json: cred } = await request(url, {
      headers: { 'X-Auth-Token': bearer },
      body: { agency_name: sts.agencyName, domain_id: sts.domainId, duration_seconds: Number(sts.durationSeconds ?? 3600) },
    });

    const { ak, sk, st, exp } = parseCredential(cred, sts);
    if (!ak || !sk) {
      throw new OAuthError('STS 响应里没解析到 AK/SK（检查 oauth.sts.*Path）', { code: 'sts_parse_failed', status: 502 });
    }
    return { accessKeyId: ak, secretAccessKey: sk, securityToken: st ?? '', expiresAt: exp ?? null, authType: 'sts' };
  }

  async function exchange({ code, state }) {
    if (!code || !state) throw new OAuthError('缺少 code 或 state', { code: 'missing_params', status: 400 });
    const st = pending.get(state);
    if (!st) throw new OAuthError('state 无效或已过期', { code: 'bad_state', status: 400 });
    if (st.expiresAt < Date.now()) {
      pending.delete(state);
      throw new OAuthError('state 已过期', { code: 'state_expired', status: 400 });
    }

    const token = await exchangeToken(code);
    let cred;
    if (mode === 'token') {
      cred = { accessKeyId: null, secretAccessKey: null, securityToken: token.access_token ?? token.id_token ?? '', expiresAt: null, authType: 'oauth' };
    } else {
      cred = await assumeRole(token);
    }

    const { out } = storeAccount(cred, { region: st.region, refresh: token.refresh_token });
    pending.delete(state);
    results.set(state, out);
    log('info', `OAuth 授权完成，账号已入库 ${out.accountId}（${out.name}）`);
    return out;
  }

  /* ---- 模式 3：模拟原版 CLI（DPoP + 设备码） ---- */
  async function startDevice({ scope } = {}) {
    if (!o.clientId) throw new OAuthError('缺少 oauth.clientId', { code: 'no_client_id', status: 400 });
    if (!o.deviceAuthorizationUrl) throw new OAuthError('缺少 oauth.deviceAuthorizationUrl', { code: 'no_device_authorization_url', status: 400 });
    if (!o.tokenUrl) throw new OAuthError('缺少 oauth.tokenUrl', { code: 'no_token_url', status: 400 });

    const dpop = generateDpopKeyPair();
    const dev = await request(o.deviceAuthorizationUrl, {
      form: true,
      headers: { DPoP: createDpopProof({ privateKey: dpop.privateKey, publicJwk: dpop.publicJwk, htu: o.deviceAuthorizationUrl, htm: 'POST' }) },
      body: { client_id: o.clientId, scope: scope ?? o.scope ?? 'openid' },
    }).then((r) => r.json);

    if (!dev.device_code) throw new OAuthError('设备授权端点没返回 device_code', { code: 'device_auth_failed', status: 502 });
    const ttl = (Number(dev.expires_in) || 600) * 1000;
    const deviceCode = dev.device_code;
    pending.set(deviceCode, {
      expiresAt: Date.now() + ttl,
      region: o.region ?? 'cn',
      dpop,
      deviceCode,
      interval: Number(dev.interval) || 5,
    });

    const link = dev.verification_uri_complete
      ?? (dev.verification_uri
        ? `${dev.verification_uri}?user_code=${encodeURIComponent(dev.user_code ?? '')}`
        : (o.cliAuthPageUrl ?? dev.verification_uri ?? ''));

    log('info', `CLI 同款设备授权开始（device_code=${deviceCode.slice(0, 8)}…）`);
    return {
      authorizeUrl: link || o.cliAuthPageUrl,
      userCode: dev.user_code ?? '',
      verificationUri: dev.verification_uri ?? o.cliAuthPageUrl ?? '',
      deviceCode,
      interval: Number(dev.interval) || 5,
      expiresIn: Number(dev.expires_in) || 600,
    };
  }

  async function pollDevice({ deviceCode } = {}) {
    if (!deviceCode) throw new OAuthError('缺少 deviceCode', { code: 'missing_device_code', status: 400 });
    const st = pending.get(deviceCode);
    if (!st) throw new OAuthError('deviceCode 无效或已过期', { code: 'bad_device_code', status: 400 });
    if (st.expiresAt < Date.now()) {
      pending.delete(deviceCode);
      throw new OAuthError('deviceCode 已过期', { code: 'device_expired', status: 400 });
    }

    const { json: token, headers } = await request(o.tokenUrl, {
      form: true,
      allowError: true,
      headers: {
        DPoP: createDpopProof({
          privateKey: st.dpop.privateKey,
          publicJwk: st.dpop.publicJwk,
          htu: o.tokenUrl,
          htm: 'POST',
          nonce: st.nonce,
        }),
      },
      body: {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: deviceCode,
        client_id: o.clientId,
        ...(o.clientSecret ? { client_secret: o.clientSecret } : {}),
      },
    });

    // 服务端可能要求换 nonce（RFC 9449 use_dpop_nonce）
    const nonce = headers?.['dpop-nonce'];
    if (nonce) st.nonce = nonce;

    if (token.error === 'authorization_pending') return { status: 'pending' };
    if (token.error === 'slow_down') { st.interval = Math.max(5, (st.interval || 5) + 5); return { status: 'pending', interval: st.interval }; }
    if (token.error === 'access_denied') throw new OAuthError('用户在授权页拒绝了访问', { code: 'access_denied', status: 403 });
    if (token.error === 'expired_token') { pending.delete(deviceCode); throw new OAuthError('授权已过期', { code: 'expired_token', status: 400 }); }
    if (token.error) throw new OAuthError(token.error_description ?? token.error, { code: token.error, status: 502 });

    const { ak, sk, st: secTok, exp, refresh, accountId } = parseCredential(token, o.sts ?? {});
    if (!ak || !sk) {
      throw new OAuthError('token 响应里没解析到 AK/SK（检查 oauth.sts.*Path）', { code: 'sts_parse_failed', status: 502 });
    }
    const ath = token.access_token ? accessTokenHash(token.access_token) : null;
    const cred = {
      accessKeyId: ak,
      secretAccessKey: sk,
      securityToken: secTok ?? '',
      expiresAt: exp ?? (token.expires_at ?? null),
      authType: 'sts',
    };
    const { out } = storeAccount(cred, { region: st.region, refresh, accountId, source: 'codearts-cli' });
    pending.delete(deviceCode);
    results.set(deviceCode, out);
    log('info', `CLI 同款授权完成，账号已入库 ${out.accountId}（${out.name}）${ath ? '' : ''}`);
    return { status: 'success', ...out };
  }

  /* ---- 导入原版 CLI 的 auth.json ---- */
  function importAuthJson(text) {
    let data;
    try {
      data = JSON.parse(String(text));
    } catch {
      throw new OAuthError('auth.json 不是合法 JSON', { code: 'bad_json', status: 400 });
    }
    const prov = data?.['inferhub-provider'] ?? data?.provider ?? data;
    let access = prov?.access;
    if (typeof access === 'string') {
      try { access = JSON.parse(access); } catch { access = null; }
    }
    if (!access) throw new OAuthError('auth.json 里没有 inferhub-provider.access', { code: 'no_access', status: 400 });

    const ak = access.access_key_id;
    const sk = access.secret_access_key;
    const st = access.security_token ?? '';
    const accountId = prov?.accountId ?? null;
    const expires = prov?.expires ? new Date(Number(prov.expires)).toISOString() : null;

    if (!ak || !sk) throw new OAuthError('access 里没有 access_key_id/secret_access_key', { code: 'no_ak_sk', status: 400 });

    const cred = { accessKeyId: ak, secretAccessKey: sk, securityToken: st, expiresAt: expires, authType: 'sts' };
    const { out } = storeAccount(cred, {
      region: o.region ?? 'cn',
      refresh: typeof prov?.refresh === 'string' ? prov.refresh : null,
      accountId,
      source: 'auth-json-import',
    });
    return out;
  }

  return {
    enabled, status, start, exchange, pollDevice, importAuthJson,
    exchangeToken, assumeRole, pending, results,
  };
}
