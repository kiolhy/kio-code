// 码道 CLI 真实登录协议（从 agentkernel.exe 反编译还原，非模拟）
//
// 还原自 chunk-4z1vmdrn.js 的 auth 模块：
//   client_id            = "CodeArts_Tui"
//   authorize            = `${o}/authorize`   o = https://codearts.huaweicloud.com/portal
//   token                = `${I}/v1/oauth2/tokens`  I = https://sts.cn-north-4.myhuaweicloud.com
//   ticket               = `${GW}/v1/login/ticket`  GW = https://snap-access.cn-north-4.myhuaweicloud.com/snap-manager
//   流程                 授权码 + PKCE(code_challenge_method="SHA-256") + DPoP(ES256, typ=dpop+jwt)
//   回调                  http://127.0.0.1:<port>/oauth/callback  (?code=… 或 ?secret=…&redirect=…)
//   token 响应            { credentials: { access_key_id, secret_access_key, security_token, expiration }, refresh_token }
//   ticket 响应           { credential: { access, secret, securitytoken, expires_at } }
//   刷新                  POST token，grant_type=refresh_token，带 DPoP + x-agent-user-account
import crypto from 'node:crypto';
import { getTransport } from './transport.mjs';
import { generateDpopKeyPair, createDpopProof } from './dpop.mjs';

export const CODEARTS_DEFAULTS = {
  authorizeBase: 'https://codearts.huaweicloud.com/portal',
  tokenUrl: 'https://sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens',
  ticketBase: 'https://snap-access.cn-north-4.myhuaweicloud.com/snap-manager',
  loginPage: 'https://codearts.huaweicloud.com/portal/settings/cli-auth',
  clientId: 'CodeArts_Tui',
  enterprise: 'prod',
  locale: 'zh-cn',
};

export class CodeartsAuthError extends Error {
  constructor(message, { code = 'codearts_auth_error', status = 400 } = {}) {
    super(message);
    this.name = 'CodeartsAuthError';
    this.code = code;
    this.status = status;
  }
}

const b64u = (buf) => Buffer.from(buf).toString('base64url');

export function createCodeartsAuth({ cfg = {}, panel, log = () => {} } = {}) {
  const o = { ...CODEARTS_DEFAULTS, ...(cfg.oauth?.codearts ?? {}) };
  const transport = getTransport({});
  const proxy = cfg.oauth?.proxy || '';

  // 与 CLI 一致：同一时间只挂一个待授权请求
  let pending = null;
  const results = new Map(); // ticketId -> { done, accountId, ... }

  async function req(url, { method = 'POST', headers = {}, body, form = false, allowError = false } = {}) {
    let payload = body;
    if (form && body && typeof body === 'object') payload = new URLSearchParams(body).toString();
    const r = await transport.request({
      url,
      method,
      headers: {
        accept: 'application/json',
        ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : { 'content-type': 'application/json' }),
        ...headers,
      },
      body: payload,
      proxy,
      timeoutMs: 30000,
    });
    const text = (await r.buffer()).toString('utf8');
    let json = null;
    try { json = JSON.parse(text); } catch { /* 下面报错 */ }
    if ((r.status < 200 || r.status >= 300) && !allowError) {
      throw new CodeartsAuthError(json?.error_description ?? json?.message ?? text.slice(0, 200) ?? `HTTP ${r.status}`, {
        code: json?.error ?? 'upstream_error',
        status: 502,
      });
    }
    return { json, status: r.status };
  }

  function status({ ticketId } = {}) {
    if (ticketId) {
      const r = results.get(ticketId);
      if (r) return { ticketId, enabled: true, ...r };
      return { ticketId, enabled: true, done: false, pending: !!pending && pending.ticketId === ticketId };
    }
    return { enabled: true, mode: 'codearts', loginPage: o.loginPage, clientId: o.clientId, pending: !!pending };
  }

  /** 第一步：生成 PKCE + ticket_id，拼出真实授权链接 */
  function start({ callbackPort, locale } = {}) {
    const verifier = crypto.randomBytes(64).toString('hex'); // 128 chars
    const challenge = b64u(crypto.createHash('sha256').update(verifier).digest());
    const ticketId = crypto.randomBytes(16).toString('hex');

    const params = new URLSearchParams({
      locale: locale ?? o.locale,
      client_id: o.clientId,
      port: String(callbackPort ?? cfg.port ?? 8787),
      code_challenge: challenge,
      code_challenge_method: 'SHA-256',
      ticket_id: ticketId,
    });

    pending = { verifier, ticketId, createdAt: Date.now() };
    const url = `${o.authorizeBase}/authorize?${params.toString()}`;
    log('info', `码道真实授权开始（ticket=${ticketId.slice(0, 8)}…）`);
    return {
      authorizeUrl: url,
      ticketId,
      loginPage: o.loginPage,
      expiresIn: 300000,
    };
  }

  function takePending(ticketId) {
    if (!pending) throw new CodeartsAuthError('没有待授权的请求，请先点「授权添加」', { code: 'no_pending', status: 400 });
    if (ticketId && ticketId !== pending.ticketId) {
      throw new CodeartsAuthError('ticket_id 不匹配', { code: 'ticket_mismatch', status: 400 });
    }
    if (Date.now() - pending.createdAt > 300000) {
      pending = null;
      throw new CodeartsAuthError('授权已超时（5 分钟）', { code: 'expired', status: 400 });
    }
    return pending;
  }

  function normalize(cred) {
    const ak = cred.access_key_id ?? cred.access;
    const sk = cred.secret_access_key ?? cred.secret;
    const st = cred.security_token ?? cred.securitytoken ?? '';
    const exp = cred.expiration ?? cred.expires_at ?? null;
    if (!ak || !sk) throw new CodeartsAuthError('凭据里没有 AK/SK', { code: 'no_ak_sk', status: 502 });
    return { accessKeyId: ak, secretAccessKey: sk, securityToken: st, expiresAt: exp };
  }

  function store({ cred, refreshToken, dpopKeyPair }) {
    const acc = panel.addAccount({
      name: `码道-${Date.now().toString(36).slice(-4)}`,
      region: 'cn',
      authType: 'sts',
      accessKeyId: cred.accessKeyId,
      secretAccessKey: cred.secretAccessKey,
      securityToken: cred.securityToken,
      expiresAt: cred.expiresAt ?? undefined,
      note: JSON.stringify({
        source: 'codearts-oauth',
        enterprise: o.enterprise,
        ...(refreshToken ? { refresh: refreshToken } : {}),
        ...(dpopKeyPair ? { dpop: dpopKeyPair } : {}),
      }),
    });
    return {
      done: true,
      accountId: acc.id,
      name: acc.name,
      accessKeyIdMasked: `${String(acc.accessKeyId).slice(0, 4)}****`,
      expiresAt: acc.expiresAt ?? null,
      error: null,
    };
  }

  /** 授权码 → token（真实端点 + DPoP） */
  async function exchangeCode({ code, verifier, ticketId, callbackPort }) {
    if (!code) throw new CodeartsAuthError('缺少 code', { code: 'missing_code', status: 400 });
    const dpop = generateDpopKeyPair();
    const proof = createDpopProof({
      privateKey: dpop.privateKey,
      publicJwk: dpop.publicJwk,
      htu: o.tokenUrl,
      htm: 'POST',
    });

    const { json } = await req(o.tokenUrl, {
      form: true,
      headers: { DPoP: proof },
      body: {
        client_id: o.clientId,
        code,
        code_verifier: verifier,
        grant_type: 'authorization_code',
        redirect_uri: `http://127.0.0.1:${callbackPort ?? cfg.port ?? 8787}/oauth/callback`,
      },
    });

    const credentials = json?.credentials;
    if (!credentials) throw new CodeartsAuthError('token 响应里没有 credentials', { code: 'bad_token_response', status: 502 });
    const cred = normalize(credentials);
    const out = store({ cred, refreshToken: json?.refresh_token, dpopKeyPair: { publicJwk: dpop.publicJwk, privatePem: dpop.privatePem } });
    if (ticketId) results.set(ticketId, out);
    pending = null;
    log('info', `码道授权成功，账号入库 ${out.accountId}`);
    return out;
  }

  /** secret + ticket_id → 凭据（异步路径） */
  async function exchangeTicket({ secret, ticketId }) {
    if (!secret) throw new CodeartsAuthError('缺少 secret', { code: 'missing_secret', status: 400 });
    const tid = ticketId ?? pending?.ticketId;
    if (!tid) throw new CodeartsAuthError('缺少 ticket_id', { code: 'missing_ticket', status: 400 });

    const url = `${o.ticketBase}/v1/login/ticket?${new URLSearchParams({ ticket_id: tid, secret }).toString()}`;
    let lastErr = null;
    for (let i = 1; i <= 10; i++) {
      const { json, status: st } = await req(url, { method: 'GET', allowError: true });
      if (st >= 200 && st < 300 && json?.credential) {
        const cred = normalize(json.credential);
        const out = store({ cred });
        results.set(tid, out);
        pending = null;
        log('info', `码道 ticket 换凭据成功，账号入库 ${out.accountId}`);
        return out;
      }
      lastErr = `HTTP ${st}`;
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new CodeartsAuthError(`ticket 换凭据失败（重试 10 次）：${lastErr}`, { code: 'ticket_exchange_failed', status: 502 });
  }

  /** 用 refresh_token + dpop 续期 */
  async function refresh({ refreshToken, dpopKeyPair, accountId }) {
    if (!refreshToken || !dpopKeyPair) throw new CodeartsAuthError('缺少 refresh_token 或 dpop 密钥', { code: 'no_refresh', status: 400 });
    const privateKey = crypto.createPrivateKey(dpopKeyPair.privatePem);
    const proof = createDpopProof({ privateKey, publicJwk: dpopKeyPair.publicJwk, htu: o.tokenUrl, htm: 'POST' });
    const { json } = await req(o.tokenUrl, {
      form: true,
      headers: { DPoP: proof, ...(accountId ? { 'x-agent-user-account': String(accountId) } : {}) },
      body: { client_id: o.clientId, refresh_token: refreshToken, grant_type: 'refresh_token' },
    });
    const credentials = json?.credentials;
    if (!credentials) throw new CodeartsAuthError('刷新响应里没有 credentials', { code: 'bad_refresh_response', status: 502 });
    return { cred: normalize(credentials), refreshToken: json?.refresh_token ?? refreshToken };
  }

  /** 就地续期一个账号池里的账号（不新建） */
  async function refreshAccount(account) {
    if (!account) throw new CodeartsAuthError('账号不存在', { code: 'not_found', status: 404 });
    let meta = null;
    try {
      meta = account.note ? JSON.parse(account.note) : null;
    } catch {
      meta = null;
    }
    if (!meta?.refresh || !meta?.dpop) {
      throw new CodeartsAuthError('该账号没有 refresh_token / dpop 密钥，无法续期（需通过「授权添加」创建）', {
        code: 'no_refresh_material',
        status: 400,
      });
    }
    const r = await refresh({ refreshToken: meta.refresh, dpopKeyPair: meta.dpop, accountId: account.domainId });
    const updated = panel.updateAccount(account.id, {
      accessKeyId: r.cred.accessKeyId,
      secretAccessKey: r.cred.secretAccessKey,
      securityToken: r.cred.securityToken,
      expiresAt: r.cred.expiresAt,
      note: JSON.stringify({ ...meta, refresh: r.refreshToken }),
    });
    log('info', `账号续期成功 ${account.id}（新过期时间 ${r.cred.expiresAt}）`);
    return { account: updated, expiresAt: r.cred.expiresAt ?? null };
  }

  /**
   * 批量续期：把 leadMs 内即将过期的账号全部续掉。
   * @returns {{checked:number, refreshed:number, failed:Array<{id:string,error:string}>}}
   */
  async function refreshExpiring({ leadMs = 900000 } = {}) {
    const now = Date.now();
    const list = (panel.accounts?.() ?? []).filter((a) => {
      if (a.enabled === false || !a.expiresAt) return false;
      const exp = new Date(a.expiresAt).getTime();
      if (!Number.isFinite(exp)) return false;
      return exp - now <= leadMs;
    });
    let refreshed = 0;
    const failed = [];
    for (const a of list) {
      try {
        await refreshAccount(a);
        refreshed++;
      } catch (e) {
        failed.push({ id: a.id, error: String(e?.message ?? e) });
      }
    }
    return { checked: list.length, refreshed, failed };
  }

  /** 从回调地址里解析 code / secret 并完成 */
  async function completeFromUrl({ url, ticketId, callbackPort }) {
    let u;
    try {
      u = new URL(String(url));
    } catch {
      throw new CodeartsAuthError('回调地址不是合法 URL', { code: 'bad_callback_url', status: 400 });
    }
    const code = u.searchParams.get('code');
    const secret = u.searchParams.get('secret');
    const tid = u.searchParams.get('ticket_id') ?? u.searchParams.get('state') ?? ticketId;

    if (code) {
      const p = takePending(tid);
      return exchangeCode({ code, verifier: p.verifier, ticketId: p.ticketId, callbackPort });
    }
    if (secret) return exchangeTicket({ secret, ticketId: tid ?? pending?.ticketId });
    throw new CodeartsAuthError('回调地址里没有 code 或 secret', { code: 'no_code_no_secret', status: 400 });
  }

  return { status, start, exchangeCode, exchangeTicket, refresh, refreshAccount, refreshExpiring, completeFromUrl, pending: () => pending };
}
