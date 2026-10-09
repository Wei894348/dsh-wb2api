/**
 * 账号凭证存取：直接读 dsh 反代插件那套 auths（本项目与外层网关共用同一个号池）。
 *
 * 文件格式（网关 internal/auth 与插件 login.js 同款）：
 *   { "account": {uid,nickname,enterpriseId}, "auth": {accessToken,refreshToken,expiresAt,domain,realm} }
 */
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

export const AUTH_DIR = process.env.WB_AUTH_DIR ?? join(homedir(), '.dsh', 'wb2api', 'auths');
export const DISABLED_SUFFIX = '.disabled';

/** 把一份凭证文件转成内部使用的扁平对象。 */
export function toAuth(doc, file = '') {
  const acc = doc?.account ?? {};
  const au = doc?.auth ?? {};
  const domain = typeof au.domain === 'string' ? au.domain : '';
  const realm = au.realm === 'global' || au.realm === 'cn'
    ? au.realm
    : (/workbuddy\.ai$/iu.test(domain.toLowerCase()) ? 'global' : 'cn');
  return {
    file,
    uid: acc.uid ?? '',
    nickname: acc.nickname ?? '',
    enterpriseId: acc.enterpriseId ?? '',
    accessToken: au.accessToken ?? '',
    refreshToken: au.refreshToken ?? '',
    expiresAt: typeof au.expiresAt === 'number' ? au.expiresAt : 0,
    domain,
    realm,
  };
}

/** 列出 auths 下全部账号（enabled 在前，其余按 uid）。 */
export function listAuths({ includeDisabled = false } = {}) {
  if (!existsSync(AUTH_DIR)) return [];
  const out = [];
  for (const name of readdirSync(AUTH_DIR)) {
    if (!name.startsWith('workbuddy')) continue;
    const enabled = name.endsWith('.json');
    const disabled = name.endsWith(`.json${DISABLED_SUFFIX}`);
    if (!enabled && !(includeDisabled && disabled)) continue;
    const file = join(AUTH_DIR, name);
    try {
      const auth = toAuth(JSON.parse(readFileSync(file, 'utf8')), file);
      auth.enabled = enabled;
      if (auth.uid !== '') out.push(auth);
    } catch { /* 坏文件跳过 */ }
  }
  out.sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.uid.localeCompare(b.uid));
  return out;
}

/** 按 uid 前缀取一个账号；不传则返回全部启用账号。 */
export function resolveAuths(prefix = '', { includeDisabled = false } = {}) {
  const all = listAuths({ includeDisabled });
  if (prefix === '') return all.filter((a) => a.enabled);
  const hits = all.filter((a) => a.uid.startsWith(prefix) || String(a.nickname).includes(prefix));
  if (hits.length === 0) throw new Error(`没有 uid/昵称匹配 «${prefix}» 的账号`);
  if (hits.length > 1) throw new Error(`«${prefix}» 命中 ${hits.length} 个账号：${hits.map((h) => h.uid).join(', ')}`);
  return hits;
}

export function label(auth) {
  return `${(auth.nickname || auth.uid).slice(0, 20)}(${auth.uid.slice(0, 8)})`;
}

/** 把（可能被上游刷新过的）凭证写回原文件；路径未变则原子替换。 */
export function saveAuth(doc, file) {
  if (!file) return;
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(doc, null, 1)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

export const fileNameOf = (auth) => basename(auth.file ?? '');
