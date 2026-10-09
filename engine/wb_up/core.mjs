/**
 * WorkBuddy 上游访问核心 —— 本项目内的 Node 实现（无需第二个网关）。
 *
 * 规则口径：三类客户端指纹（billing / chat / desktop / web）、信封解析、SSE 读干。
 * 端点：cn 的 chat 走 copilot.tencent.com，billing 走 www.codebuddy.cn，web 走 www.workbuddy.cn
 * （三者不同域是实测行为，不要"顺手统一"）。
 */
import { createHash, randomUUID } from 'node:crypto';

export const BASES = {
  cn: { chat: 'https://copilot.tencent.com', billing: 'https://www.codebuddy.cn', web: 'https://www.workbuddy.cn' },
  global: { chat: 'https://www.workbuddy.ai', billing: 'https://www.workbuddy.ai', web: 'https://www.workbuddy.ai' },
};

/** 客户端出站 UA 的版本段（对齐官方桌面端分发包 / 内置 CLI）。 */
export const CLIENT_VERSION = '5.5.4';
export const CLI_VERSION = '2.137.1';
/** 桌面端实测 UA（5.5.6 内嵌 CLI 2.137.1）。 */
export const DESKTOP_UA = 'WorkBuddy/5.5.6 WorkBuddy/5.5.6 CLI/2.137.1';
export const WEB_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';

/** 归一化 realm：显式 realm 优先，其次按 domain 后缀（与网关 Auth.Realm() 同口径）。 */
export function realmOf(auth) {
  const explicit = auth?.realm;
  if (explicit === 'global' || explicit === 'cn') return explicit;
  const d = String(auth?.domain ?? '').toLowerCase();
  return d === 'workbuddy.ai' || d.endsWith('.workbuddy.ai') ? 'global' : 'cn';
}
export const isGlobal = (auth) => realmOf(auth) === 'global';
/** 取某类通道的基址（chat / billing / web），带末尾斜杠归一。 */
export function baseOf(auth, kind) {
  const b = BASES[realmOf(auth)][kind] ?? BASES.cn[kind];
  return b.replace(/\/+$/u, '');
}
export function originFor(auth) {
  return isGlobal(auth) ? 'https://www.workbuddy.ai' : 'https://www.codebuddy.cn';
}
export function acceptLanguageFor(auth) {
  return isGlobal(auth) ? 'en-US' : 'zh-CN';
}
/** 按 uid + 盐稳定派生 36 hex 设备标识（幂等：同账号每次同值，模拟固定设备）。 */
export function derive36(uid, salt) {
  return createHash('sha256').update(`${salt}:${uid}`).digest('hex').slice(0, 36);
}
/** 32 hex 的消息/请求 ID（对齐官方客户端 UUID 去横线形状）。 */
export function hex32() {
  return randomUUID().replace(/-/gu, '');
}
export const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

/** 账号身份头（Authorization / X-User-Id / 企业 / 域）。 */
function identityHeaders(auth) {
  const h = { Authorization: `Bearer ${auth.accessToken ?? ''}` };
  if (auth.uid) h['X-User-Id'] = auth.uid;
  if (auth.enterpriseId) {
    h['X-Enterprise-Id'] = auth.enterpriseId;
    h['X-Tenant-Id'] = auth.enterpriseId;
  }
  if (auth.domain) h['X-Domain'] = auth.domain;
  return h;
}

/** 通用头（CommonHeaders）：chat / refresh 路径用。 */
export function commonHeaders(auth) {
  const origin = originFor(auth);
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
    Origin: origin,
    Referer: `${origin}/`,
    'User-Agent': `WorkBuddy/${CLIENT_VERSION} ${isGlobal(auth) ? 'WorkBuddy AI' : 'WorkBuddy'}/${CLIENT_VERSION} CLI/${CLI_VERSION}`,
    'X-CodeBuddy-Request': '1',
    'Accept-Language': acceptLanguageFor(auth),
    'X-Machine-ID': auth.uid ? derive36(auth.uid, 'wb2a:machine') : '',
    'X-Session-ID': auth.uid ? derive36(auth.uid, 'wb2a:session') : '',
  };
}

/** billing/checkin/report 通道头：UA 单段 `WorkBuddy/5.5.4`。 */
export function billingHeaders(auth) {
  const h = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'X-CodeBuddy-Request': '1',
    'Accept-Language': acceptLanguageFor(auth),
    'User-Agent': `WorkBuddy/${CLIENT_VERSION}`,
    ...identityHeaders(auth),
  };
  return h;
}

/** 桌面指纹通道头（copilot 域 /v2/report 与 user-asset）。 */
export function desktopHeaders(auth) {
  return {
    Accept: 'application/json, text/plain, */*',
    'Content-Type': 'application/json;charset=UTF-8',
    'User-Agent': DESKTOP_UA,
    'X-Domain': baseOf(auth, 'chat'),
    'X-Product': 'SaaS',
    'X-Request-ID': derive36(auth.uid, 'req') + String(Date.now() % 1e6),
    Authorization: `Bearer ${auth.accessToken ?? ''}`,
    ...(auth.uid ? { 'X-User-Id': auth.uid } : {}),
  };
}

/** Web 指纹通道头（www.workbuddy.cn/v2/report，浏览器形状）。 */
export function webHeaders(auth, pageURL) {
  return {
    Authorization: `Bearer ${auth.accessToken ?? ''}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'x-client-platform': 'web',
    Origin: baseOf(auth, 'web'),
    Referer: pageURL,
    'User-Agent': WEB_UA,
    ...(auth.uid ? { 'X-User-Id': auth.uid } : {}),
  };
}

/** 桌面指纹的公共事件字段（注入每个事件，业务字段优先覆盖）。 */
export function desktopFingerprint(auth) {
  const now = Date.now();
  return {
    timezone: 'Asia/Shanghai',
    reportDelay: 2000,
    userId: auth.uid,
    username: auth.nickname ?? '',
    userNickname: auth.nickname ?? '',
    product: 'SaaS',
    releaseDate: 1789036585355,
    commit: '5f9692923c93033111c51ad7b003eb80204a9b75',
    ideName: 'WorkBuddy',
    ideType: 'WorkBuddy',
    ideVersion: '5.5.6',
    machineId: derive36(auth.uid, 'machine'),
    sessionId: derive36(auth.uid, 'session'),
    extName: 'workbuddy-desktop',
    extVersion: '5.5.6',
    os: 'win32',
    arch: 'x64',
    osVersion: '10.0.26220',
    cpuCores: 20,
    memorySize: 24,
    timestamp: now,
    presentAt: now,
  };
}

/**
 * 发一次请求。
 * @returns {{status:number, ok:boolean, text:string, json:any}}
 */
export async function send(url, opts = {}) {
  // 无人值守场景必须扛住偶发的连接中断（实测上游会在大请求后直接关 socket：
  // UND_ERR_SOCKET / other side closed）。一次重试就够，不做指数退避。
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await sendOnce(url, opts);
    } catch (error) {
      lastError = error;
      if (attempt < 3) await sleep(1200 * attempt);
    }
  }
  throw lastError;
}

async function sendOnce(url, { method = 'POST', headers = {}, body, timeoutMs = 30000 } = {}) {
  const res = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text().catch(() => '');
  let json;
  try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: res.status, ok: res.ok, text, json };
}

/** 解 `{code,msg,data}` 信封：code!==0 抛错；无信封则原样返回。 */
export function envelope(json) {
  if (json === null || typeof json !== 'object') return json;
  if (typeof json.code === 'number' && json.code !== 0) {
    const err = new Error(String(json.msg ?? json.message ?? `code=${json.code}`));
    err.code = json.code;
    throw err;
  }
  return json.data ?? json;
}
