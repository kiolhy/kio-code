// 账号池的「授权登录」添加：OAuth2 授权码 →（可选）STS 换临时 AK/SK → 自动入库
//
// 为什么不能像 GitHub 那样只给个 token：上游 snap-access 要的是 SDK-HMAC-SHA256 签名，
// 签名的 AK/SK 里 SK 是静态密钥、只在你创建时显示一次，浏览器登录链接给不出 SK。
// 真 CLI 的登录其实也是 OAuth → 委托(STS) → 临时 AK/SK/SecurityToken，本模块复刻这段，
// 端点/字段全部由 config.oauth 驱动，接入你自己的华为云 OAuth App + 委托关系就能用。
import crypto from 'node:crypto';
import { getTransport } from './transport.mjs';

export class OAuthError extends Error {
  constructor(message, { code = 'oauth_error', status = 400 } = {}) {
    super(message);
    this.name = 'OAuthError';
    this.code = code;
    this.status = status;
  }
}

const getPath = (obj, p) => String(p ?? '').split('.').filter(Boolean).reduce((o, k) => o?.[k], obj);

export function createOAuth({ cfg = {}, panel, log = () => {} } = {}) {
  const o = cfg.oauth ?? {};
  const transport = getTransport({});

  const pending = new Map(); // state -> { expiresAt, region }
  const results = new Map(); // state -> { done, accountId, name, error }

  const enabled = o.enabled === true;

  async function request(url, { method = 'POST', headers = {}, body, form = false, timeoutMs = 30000 } = {}) {
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
      throw new OAuthError(json?.error_description ?? json?.message ?? text.slice(0, 160) ?? `HTTP ${r.status}`, {
        code: json?.error ?? 'upstream_error',
        status: 502,
      });
    }
    return json;
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
      mode: o.mode ?? 'sts',
      clientId: !!o.clientId,
      region: o.region ?? 'cn',
      redirectUri: o.redirectUri ?? '',
      sts: !!(o.sts?.endpoint && o.sts?.domainId && o.sts?.agencyName),
    };
  }

  async function start({ scope, region } = {}) {
    if (!enabled) throw new OAuthError('OAuth 授权添加未开启', { code: 'oauth_disabled', status: 409 });
    if (!o.clientId) throw new OAuthError('缺少 oauth.clientId', { code: 'no_client_id', status: 400 });
    if (!o.authorizeUrl) throw new OAuthError('缺少 oauth.authorizeUrl', { code: 'no_authorize_url', status: 400 });

    const state = crypto.randomBytes(24).toString('hex');
    const ttl = Number(o.stateTtlMs ?? 600000);
    pending.set(state, { expiresAt: Date.now() + ttl, region: region ?? o.region ?? 'cn' });
    // 清理过期 state
    for (const [k, v] of pending) if (v.expiresAt < Date.now()) pending.delete(k);

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
    const token = await request(o.tokenUrl, {
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
    const cred = await request(url, {
      headers: { 'X-Auth-Token': bearer },
      body: { agency_name: sts.agencyName, domain_id: sts.domainId, duration_seconds: Number(sts.durationSeconds ?? 3600) },
    });

    const ak = getPath(cred, sts.akPath ?? 'credential.access');
    const sk = getPath(cred, sts.skPath ?? 'credential.secret');
    const st = getPath(cred, sts.tokenPath ?? 'credential.securitytoken');
    const exp = getPath(cred, sts.expiresAtPath ?? 'credential.expires_at');
    if (!ak || !sk) {
      throw new OAuthError('STS 响应里没解析到 AK/SK（检查 oauth.sts.*Path）', { code: 'sts_parse_failed', status: 502 });
    }
    return { accessKeyId: ak, secretAccessKey: sk, securityToken: st ?? '', expiresAt: exp ?? null };
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
    let authType;
    if ((o.mode ?? 'sts') === 'token') {
      cred = { accessKeyId: null, secretAccessKey: null, securityToken: token.access_token ?? token.id_token ?? '', expiresAt: null };
      authType = 'oauth';
    } else {
      cred = await assumeRole(token);
      authType = 'sts';
    }

    const acc = panel.addAccount({
      name: `${o.accountNamePrefix ?? '授权账号'}-${Date.now().toString(36).slice(-4)}`,
      region: st.region,
      authType,
      accessKeyId: cred.accessKeyId,
      secretAccessKey: cred.secretAccessKey,
      securityToken: cred.securityToken,
      expiresAt: cred.expiresAt ?? undefined,
      note: `OAuth 授权（${o.mode ?? 'sts'}）`,
    });

    pending.delete(state);
    results.set(state, {
      done: true,
      accountId: acc.id,
      name: acc.name,
      authType,
      accessKeyIdMasked: acc.accessKeyId ? `${String(acc.accessKeyId).slice(0, 4)}****` : '',
      expiresAt: acc.expiresAt ?? null,
      error: null,
    });
    log('info', `OAuth 授权完成，账号已入库 ${acc.id}（${acc.name}）`);
    return results.get(state);
  }

  return { enabled, status, start, exchange, exchangeToken, assumeRole, pending, results };
}
