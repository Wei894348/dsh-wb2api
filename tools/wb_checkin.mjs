/**
 * 用池里的某个账号打一次上游每日签到 —— 既验证 token 有效，又顺手把当天积分领了。
 * 用法：node wb_checkin.mjs <uid 前缀>
 */
import { readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const prefix = (process.argv[2] ?? '').trim();
const dir = join(homedir(), '.dsh', 'wb2api', 'auths');
const files = readdirSync(dir).filter(n => n.startsWith('workbuddy') && n.endsWith('.json'));
const hit = files.filter(n => n.includes(prefix));
if (hit.length !== 1) {
  console.error(`uid 前缀 «${prefix}» 命中 ${hit.length} 个凭证文件：${hit.join(', ')}`);
  process.exit(1);
}
const doc = JSON.parse(readFileSync(join(dir, hit[0]), 'utf8'));
const { account, auth } = doc;
const realm = auth.realm ?? (/workbuddy\.ai$/u.test(auth.domain ?? '') ? 'global' : 'cn');
if (realm === 'global') {
  console.log(`[${realm}] 上游未实测该端点的 global 版本，跳过签到。`);
  process.exit(0);
}

const headers = {
  Authorization: `Bearer ${auth.accessToken}`,
  Accept: 'application/json',
  'Content-Type': 'application/json',
  'X-User-Id': account.uid,
  ...(account.enterpriseId ? { 'X-Enterprise-Id': account.enterpriseId, 'X-Tenant-Id': account.enterpriseId } : {}),
  ...(auth.domain ? { 'X-Domain': auth.domain } : {}),
};
const response = await fetch('https://www.codebuddy.cn/v2/billing/meter/daily-checkin', {
  method: 'POST', headers, body: '{}', signal: AbortSignal.timeout(20000),
});
const body = await response.json().catch(() => undefined);
console.log(`[${realm}] ${account.nickname} (${account.uid})`);
console.log(`HTTP ${response.status}  ${JSON.stringify(body)}`);
