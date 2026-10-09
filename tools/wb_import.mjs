/**
 * 把 WorkBuddy 桌面端当前登录态（workbuddy-desktop*.info）导入本插件的账号池
 * ~/.dsh/wb2api/auths/。
 *
 * 桌面端 5.6.0+ 把 accessToken / refreshToken / nickname 写成 $wbEncrypted 信封
 * (AES-256-GCM + 字段级 AAD)。字段密钥不是用户秘密：它是 Electron 原生模块
 * electron_browser_workbuddy_storage 的 loggerGet() 返回值，
 * key = sha256(atRestSecretKey 的 base64 字符串)，keyId = sha256(key).hex[:16]。
 *
 * 用法：
 *   node wb_import.mjs                 # 只看，不落盘
 *   node wb_import.mjs --write         # 写入账号池（已存在同 uid 则跳过）
 *   node wb_import.mjs --write --force # 覆盖同 uid 已有凭证
 */
import { createHash, createDecipheriv } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

const AAD_DOMAIN = Buffer.from('WB-AAD\0', 'ascii');
const FRAMING_FIELD = 2;
const FORMAT_FIELD = 'WBEV1';
const SCHEME = 'sym-v1';

const u32 = v => { const b = Buffer.allocUnsafe(4); b.writeUInt32BE(v); return b; };
const lp = v => { const b = Buffer.from(v, 'utf8'); return Buffer.concat([u32(b.length), b]); };
const fieldAad = (keyId, suite) => Buffer.concat([
  AAD_DOMAIN, Buffer.from([1]), lp(FORMAT_FIELD), lp(SCHEME),
  u32(suite), lp(keyId), Buffer.from([FRAMING_FIELD]), Buffer.from([0]), Buffer.from([0]),
]);
const keyIdOf = key => createHash('sha256').update(key).digest('hex').slice(0, 16);
const isWrapper = v => v !== null && typeof v === 'object' && !Array.isArray(v)
  && v['$wbEncrypted'] === 1 && typeof v['envelope'] === 'string';

function deriveKey(payloadJson) {
  const payload = JSON.parse(payloadJson);
  if (typeof payload.atRestSecretKey !== 'string') throw new Error('payload 里没有 atRestSecretKey');
  return createHash('sha256').update(payload.atRestSecretKey, 'utf8').digest();
}

function openField(field, key) {
  const env = JSON.parse(Buffer.from(field.envelope, 'base64').toString('utf8'));
  const expect = keyIdOf(key);
  if (env.keyId !== expect) throw new Error(`keyId 不匹配：信封 ${env.keyId} ≠ 本机密钥 ${expect}`);
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(env.nonce, 'base64'), { authTagLength: 16 });
  d.setAAD(fieldAad(env.keyId, env.suite));
  d.setAuthTag(Buffer.from(env.authTag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(env.ciphertext, 'base64')), d.final()]).toString('utf8');
}

/** 深度解密：把所有 $wbEncrypted 信封就地换成明文。 */
function deepDecrypt(value, key) {
  if (isWrapper(value)) return openField(value, key);
  if (Array.isArray(value)) return value.map(v => deepDecrypt(v, key));
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = deepDecrypt(v, key);
    return out;
  }
  return value;
}

const EXE_CANDIDATES = [
  'F:\\Softstore\\WorkBuddy\\WorkBuddy.exe',
  'F:\\Softstore\\WorkBuddyAI\\WorkBuddyAI.exe',
];
const PAYLOAD_CACHE = join(process.cwd(), '.wb_key.json');

/** 问桌面端要字段密钥载荷；缓存到 .wb_key.json。 */
function keyPayload() {
  if (existsSync(PAYLOAD_CACHE)) {
    const cached = readFileSync(PAYLOAD_CACHE, 'utf8').trim();
    if (cached.includes('atRestSecretKey')) return cached;
  }
  const script = "process.stdout.write(process._linkedBinding('electron_browser_workbuddy_storage').loggerGet())";
  for (const exe of EXE_CANDIDATES) {
    if (!existsSync(exe)) continue;
    try {
      const out = execFileSync(exe, ['-e', script], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        timeout: 20000, windowsHide: true, encoding: 'utf8', maxBuffer: 1 << 20,
      }).trim();
      if (out.includes('atRestSecretKey')) {
        writeFileSync(PAYLOAD_CACHE, out, 'utf8');
        return out;
      }
    } catch { /* 换下一个候选 */ }
  }
  throw new Error('没能从桌面端取到 at-rest 密钥载荷（确认 WorkBuddy.exe 路径）');
}

const authDirs = [
  join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'CodeBuddyExtension', 'Data', 'Public', 'auth'),
  join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'CodeBuddyExtension', 'Data', 'Public', 'auth'),
];
const poolDir = join(homedir(), '.dsh', 'wb2api', 'auths');

const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const FORCE = args.includes('--force');
/** --only=<uid 前缀>：只导入指定账号（默认导入全部未入池账号）。 */
const ONLY = (args.find(a => a.startsWith('--only=')) ?? '').slice('--only='.length).trim();

const key = deriveKey(keyPayload());
console.log(`[key] keyId=${keyIdOf(key)}`);

const poolUids = new Set(
  existsSync(poolDir) ? readdirSync(poolDir)
    .filter(n => n.startsWith('workbuddy') && n.endsWith('.json'))
    .map(n => /workbuddy-(.+)\.json$/u.exec(n)?.[1])
    .filter(Boolean) : [],
);
console.log(`[pool] ${poolDir} 现有 ${poolUids.size} 个启用账号：${[...poolUids].join(', ') || '（空）'}`);

const seen = new Map();
for (const dir of authDirs) {
  if (!existsSync(dir)) continue;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.info')) continue;
    let doc;
    try {
      doc = deepDecrypt(JSON.parse(readFileSync(join(dir, name), 'utf8')), key);
    } catch (error) {
      console.log(`  [跳过] ${name}：${error.message}`);
      continue;
    }
    const auth = doc.auth ?? doc;
    const account = doc.account ?? doc;
    if (typeof auth.accessToken !== 'string' || auth.accessToken === '') continue;
    if (!account.uid) continue;
    const live = name === 'workbuddy-desktop.info' || name === 'workbuddy-desktop-ai.info';
    const cand = {
      file: join(dir, name), live,
      uid: account.uid,
      uin: account.uin ?? '',
      nickname: typeof account.nickname === 'string' ? account.nickname : '',
      enterpriseId: account.enterpriseId ?? '',
      domain: auth.domain ?? '',
      // 桌面端存的是毫秒，网关（与池里既有凭证）用秒 —— 必须归一化，否则会写成
      // 一个 5.6 万年后的过期时间。
      expiresAt: typeof auth.expiresAt === 'number'
        ? (auth.expiresAt > 1e12 ? Math.floor(auth.expiresAt / 1000) : auth.expiresAt)
        : 0,
      lastRefresh: typeof auth.lastRefreshTime === 'number' ? auth.lastRefreshTime : 0,
      accessToken: auth.accessToken,
      refreshToken: auth.refreshToken ?? '',
    };
    const prev = seen.get(cand.uid);
    if (!prev
      || (cand.live && !prev.live)
      || (cand.live === prev.live && cand.lastRefresh > prev.lastRefresh)
      || (cand.live === prev.live && cand.lastRefresh === prev.lastRefresh && cand.expiresAt > prev.expiresAt)) {
      seen.set(cand.uid, cand);
    }
  }
}

const now = Math.floor(Date.now() / 1000);
console.log(`[scan] 桌面端快照解出 ${seen.size} 个账号：`);
let writeCount = 0;
for (const cand of seen.values()) {
  const realm = /(^|\.)workbuddy\.ai$/u.test(cand.domain.toLowerCase()) ? 'global' : 'cn';
  const inPool = poolUids.has(cand.uid);
  const left = cand.expiresAt > now ? `${((cand.expiresAt - now) / 86400).toFixed(1)} 天` : '已过期';
  console.log(`  ${cand.live ? '★' : ' '} ${cand.uid}  ${cand.nickname || '(无昵称)'}  ${cand.domain || '(无域名)'}  realm=${realm}`
    + `  token剩余=${left}  refresh=${cand.refreshToken ? '有' : '无'}  ${inPool ? '已在池中' : '未入池'}`);
  console.log(`     来源: ${cand.file}`);

  if (!WRITE) continue;
  if (inPool && !FORCE) { console.log('     → 跳过（已在池中，--force 可覆盖）'); continue; }
  mkdirSync(poolDir, { recursive: true });
  const target = join(poolDir, `workbuddy-${cand.uid}.json`);
  const document = {
    account: { uid: cand.uid, enterpriseId: cand.enterpriseId, nickname: cand.nickname },
    auth: {
      accessToken: cand.accessToken,
      refreshToken: cand.refreshToken,
      expiresAt: cand.expiresAt,
      domain: cand.domain,
      realm,
    },
  };
  writeFileSync(target, `${JSON.stringify(document, null, 1)}\n`, { mode: 0o600 });
  writeCount += 1;
  console.log(`     → 已写入 ${basename(target)}`);
}
console.log(WRITE ? `[done] 新写入 ${writeCount} 份凭证` : '[dry-run] 加 --write 落盘');
