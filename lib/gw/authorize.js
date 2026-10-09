import * as fs from 'node:fs/promises';
import path from 'node:path';
/**
 * OAuth 请求的服务地址与浏览器来源。
 *
 * 国内版的 API 在 copilot.tencent.com，但服务端会校验来自 codebuddy.cn 的 Origin，
 * 因此 base 与 origin 必须分别保存，不能根据 base 临时推导成同一域名。
 */
const ENDPOINTS = Object.freeze({
  cn: Object.freeze({ base: 'https://copilot.tencent.com', origin: 'https://www.codebuddy.cn' }),
  global: Object.freeze({ base: 'https://www.workbuddy.ai', origin: 'https://www.workbuddy.ai' }),
});
const USER_AGENT = 'CLI/2.63.2 CodeBuddy/2.63.2';
export function parseRealmArg(text) {
  const normalized = String(text ?? '').trim().toLowerCase();
  if (normalized === '') return '';
  if (normalized === 'cn' || normalized === 'global') return normalized;
  throw new Error(`未知 realm: ${text}；只支持 cn 或 global`);
}
export function resolveRealmInput(arg, defaultRealm) {
  const explicit = parseRealmArg(arg);
  if (explicit !== '') return explicit;
  return parseRealmArg(defaultRealm);
}
export function realmEndpoints(realm) {
  const normalized = parseRealmArg(realm);
  if (normalized === '') {
    throw new Error('OAuth 请求前必须指定 realm');
  }
  return ENDPOINTS[normalized];
}
/**
 * 上游不仅检查 Bearer token，还会按 Origin 和固定 CLI UA 区分授权客户端。
 */
export function loginHeaders(realm, token) {
  const { origin } = realmEndpoints(realm);
  return {
    accept: 'application/json',
    'content-type': 'application/json',
    origin,
    'user-agent': USER_AGENT,
    ...(typeof token === 'string' && token !== ''
      ? { authorization: `Bearer ${token}` }
      : {}),
  };
}
/**
 * 授权尚未在上游完成。调用方可以等待后继续 poll，而不必重新申请 state。
 */
export class AuthorizePendingError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'AuthorizePendingError';
  }
}
function firstDefined(object, names) {
  for (const name of names) {
    if (object[name] !== undefined && object[name] !== null) return object[name];
  }
  return undefined;
}
function requiredString(data, names, label) {
  const value = firstDefined(data, names);
  if (typeof value !== 'string' || value === '') {
    throw new Error(`上游响应缺少 ${label}`);
  }
  return value;
}
function optionalString(data, names) {
  const value = firstDefined(data, names);
  return typeof value === 'string' ? value : '';
}
function finiteNumber(data, names, label) {
  const raw = firstDefined(data, names);
  const value = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`上游响应中的 ${label} 不是有效数字`);
  }
  return value;
}
function responseMessage(envelope, status) {
  const detail = typeof envelope.msg === 'string' && envelope.msg !== ''
    ? envelope.msg
    : '上游未提供错误信息';
  return `OAuth 上游返回 HTTP ${status} / code ${String(envelope.code)}: ${detail}`;
}
/**
 * 纯 fetch 的 OAuth 客户端，不启动回调端口，也不依赖 shell 或第三方包。
 */
export class LoginClient {
  constructor({ fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
    if (typeof fetchImpl !== 'function') {
      throw new TypeError('当前环境没有可用的 fetch 实现');
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new TypeError('timeoutMs 必须是正数');
    }
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }
  /**
   * 统一发送请求并拆解 { code, msg, data } 信封。
   */
  async call(realm, route, { method = 'GET', token = '', body } = {}) {
    const { base } = realmEndpoints(realm);
    const response = await this.fetchImpl(`${base}${route}`, {
      method,
      headers: loginHeaders(realm, token),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    let envelope;
    try {
      const text = await response.text();
      envelope = JSON.parse(text);
    } catch (error) {
      throw new Error(`OAuth 上游返回的不是 JSON（HTTP ${response.status}）`, {
        cause: error,
      });
    }
    if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)) {
      throw new Error(`OAuth 上游返回了无效信封（HTTP ${response.status}）`);
    }
    if (!Object.hasOwn(envelope, 'code')) {
      throw new Error(`OAuth 上游信封缺少 code（HTTP ${response.status}）`);
    }
    const code = Number(envelope.code);
    if (!Number.isFinite(code)) {
      throw new Error(`OAuth 上游信封包含无效 code（HTTP ${response.status}）`);
    }
    if (code !== 0) {
      const message = responseMessage(envelope, response.status);
      if (response.status >= 400 && response.status < 500) {
        throw new AuthorizePendingError(message);
      }
      throw new Error(message);
    }
    if (!response.ok) {
      throw new Error(`OAuth 上游返回 HTTP ${response.status}，但信封 code 为 0`);
    }
    if (!Object.hasOwn(envelope, 'data') || envelope.data === null) {
      throw new Error(`OAuth 上游信封缺少 data（HTTP ${response.status}）`);
    }
    return envelope.data;
  }
  async begin(realm) {
    const data = await this.call(
      realm,
      '/v2/plugin/auth/state?platform=CLI',
      { method: 'POST', body: {} },
    );
    return {
      state: requiredString(data, ['state'], 'state'),
      authUrl: requiredString(data, ['authUrl', 'auth_url', 'url'], 'authUrl'),
    };
  }
  async poll(realm, state) {
    if (typeof state !== 'string' || state === '') {
      throw new TypeError('state 必须是非空字符串');
    }
    const query = encodeURIComponent(state);
    const data = await this.call(realm, `/v2/plugin/auth/token?state=${query}`);
    return {
      accessToken: requiredString(data, ['accessToken', 'access_token'], 'accessToken'),
      refreshToken: optionalString(data, ['refreshToken', 'refresh_token']),
      expiresIn: finiteNumber(data, ['expiresIn', 'expires_in'], 'expiresIn'),
      domain: optionalString(data, ['domain']),
    };
  }
  async account(realm, state, accessToken) {
    if (typeof state !== 'string' || state === '') {
      throw new TypeError('state 必须是非空字符串');
    }
    if (typeof accessToken !== 'string' || accessToken === '') {
      throw new TypeError('accessToken 必须是非空字符串');
    }
    const query = encodeURIComponent(state);
    const data = await this.call(
      realm,
      `/v2/plugin/login/account?state=${query}`,
      { token: accessToken },
    );
    return {
      uid: requiredString(data, ['uid'], 'uid'),
      enterpriseId: optionalString(data, ['enterpriseId', 'enterprise_id']),
      nickname: optionalString(data, ['nickname', 'nickName']),
    };
  }
  async complete(realm, state) {
    const token = await this.poll(realm, state);
    const account = await this.account(realm, state, token.accessToken);
    return {
      ...account,
      ...token,
      realm: inferRealm(realm, token.domain),
    };
  }
}
/**
 * 构造网关凭证。
 *
 * expiresAt 必须使用 Unix 秒：网关按 int64 秒数比较过期时间；若写入 Date.now() 的
 * 毫秒值，会落到数万年以后，被误判成“永不过期”，从而永远不刷新 access token。
 */
export function buildAuthFile({
  uid,
  enterpriseId = '',
  nickname = '',
  accessToken,
  refreshToken = '',
  expiresIn,
  domain = '',
  realm = '',
}) {
  if (typeof uid !== 'string' || uid === '') throw new TypeError('uid 必须是非空字符串');
  if (typeof accessToken !== 'string' || accessToken === '') {
    throw new TypeError('accessToken 必须是非空字符串');
  }
  const lifetime = Number(expiresIn);
  if (!Number.isFinite(lifetime) || lifetime < 0) {
    throw new TypeError('expiresIn 必须是非负秒数');
  }
  return {
    account: { uid, enterpriseId, nickname },
    auth: {
      accessToken,
      refreshToken,
      expiresAt: Math.floor(Date.now() / 1000) + Math.floor(lifetime),
      domain,
      realm: inferRealm(realm, domain),
    },
  };
}
function safeUid(uid) {
  if (
    typeof uid !== 'string'
    || uid === ''
    || uid.includes('..')
    || uid.includes('/')
    || uid.includes('\\')
    || uid.includes('\0')
  ) {
    throw new Error('uid 不能用于安全的凭证文件名');
  }
  return uid;
}
/**
 * 原子写入凭证：完整内容先落到 .part，再 rename 成网关可见文件。
 * 网关不会读到半截 JSON；0600 则限制同机其他用户读取 refresh token。
 */
export async function writeAuthFile(authDir, doc) {
  if (typeof authDir !== 'string' || authDir.trim() === '') {
    throw new TypeError('authDir 必须是非空路径');
  }
  const uid = safeUid(doc?.account?.uid);
  const root = path.resolve(authDir);
  const target = path.join(root, `workbuddy-${uid}.json`);
  const partial = `${target}.part`;
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  try {
    await fs.writeFile(partial, JSON.stringify(doc, null, 1), {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'w',
    });
    await fs.chmod(partial, 0o600);
    await fs.rename(partial, target);
    await fs.chmod(target, 0o600);
    return target;
  } catch (error) {
    await fs.unlink(partial).catch(() => undefined);
    throw error;
  }
}
export function inferRealm(explicit, domain) {
  const selected = parseRealmArg(explicit);
  if (selected !== '') return selected;
  return String(domain ?? '').toLowerCase().includes('workbuddy.ai') ? 'global' : 'cn';
}
