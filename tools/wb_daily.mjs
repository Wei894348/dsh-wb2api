/**
 * WorkBuddy 账号池「每日积分任务」无人值守执行器。
 *
 * 为什么需要它：dsh 插件（dsh-plugin-wb2api-ui）的自动签到挂在天第一次打开面板
 * 那次 /state 上 —— 不开面板、dsh 没起、机器关着，当天就不跑。这里把同一套上游
 * 调用（签到 / 成长任务领取 / 保活）抽成独立脚本，交给 Windows 计划任务，与 dsh
 * 是否运行无关。
 *
 * 幂等：本地按天记账（~/.dsh/wb2api/data/wb-daily.json），同一天同账号同任务成功过
 * 就跳过；上游接口本身也幂等（重复签到返回「今天已签到」）。
 *
 * 用法：
 *   node wb_daily.mjs                 # 跑今天还没跑的部分
 *   node wb_daily.mjs --force         # 无视本地记账，全部重跑
 *   node wb_daily.mjs --uid=<uid 前缀>  # 只跑某个账号（uid 前缀）
 *   node wb_daily.mjs --keepalive     # 额外做「保持活跃」（建云端会话，默认关）
 *   node wb_daily.mjs --dry           # 只看会做什么，不发请求
 *   node wb_daily.mjs --tasks         # 额外跑成长任务自动化（默认**不跑**，日常点面板按钮即可）
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 本脚本所在目录（第二阶段要按绝对路径拉起 wb_tasks.mjs）。 */
const HERE = dirname(fileURLToPath(import.meta.url));

const RUNTIME = join(homedir(), '.dsh', 'wb2api');
const AUTH_DIR = join(RUNTIME, 'auths');
const DATA_DIR = join(RUNTIME, 'data');
const STATE_FILE = join(DATA_DIR, 'wb-daily.json');
const LOG_FILE = join(DATA_DIR, 'wb-daily.log');

const UA = 'CLI/2.63.2 CodeBuddy/2.63.2';
const BILLING = { cn: 'https://www.codebuddy.cn', global: 'https://www.workbuddy.ai' };
const CHECKIN_PATHS = ['/billing/meter/daily-checkin', '/v2/billing/meter/daily-checkin'];
const GROWTH_TASK_PATHS = ['/v2/activity/growth/tasks', '/activity/growth/tasks'];
const GROWTH_ACCEPT_PATH = '/activity/growth/tasks/accept';
const TASK_CODE = /^[A-Za-z0-9_.-]{1,96}$/u;
const CHECKIN_INACTIVE = /未开启|未开始|未开放|已过期|无.*活动|活动.*(?:结束|关闭|暂停)/iu;
const CHECKIN_ALREADY = /已签到|已领取|已经.*(?:签到|领取)|重复签到|already/iu;

const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const DRY = args.includes('--dry');
const KEEPALIVE = args.includes('--keepalive');
/**
 * 是否连带跑「成长任务自动化引擎」（wb_tasks.mjs）。
 *
 * **默认关**：做任务是要花额度、要真发对话的写操作，什么时候跑由人决定 ——
 * 面板上的「一键做任务」按钮是正门。这里留开关只给「明确要求顺手跑一轮」的场景。
 */
const WITH_TASKS = args.includes('--tasks');
const ONLY = (args.find((a) => a.startsWith('--uid=')) ?? '').slice(6).trim();

const pad = (n) => String(n).padStart(2, '0');
const localDay = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const stamp = (d = new Date()) => `${localDay(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

function log(line) {
  const text = `[${stamp()}] ${line}`;
  console.log(text);
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    appendFileSync(LOG_FILE, `${text}\n`, 'utf8');
  } catch { /* 日志写不进去不该影响任务本身 */ }
}

function readState() {
  try {
    const parsed = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    return parsed !== null && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeState(state) {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    const days = Object.keys(state).filter((k) => k !== '__runs').sort().slice(-14);
    const pruned = {};
    for (const day of days) pruned[day] = state[day];
    pruned.__runs = Number(state.__runs ?? 0) + 1;
    const tmp = `${STATE_FILE}.part`;
    writeFileSync(tmp, `${JSON.stringify(pruned, null, 1)}\n`, { mode: 0o600 });
    renameSync(tmp, STATE_FILE);
  } catch { /* 记账写不进去只影响幂等，不影响本次执行 */ }
}

/** 读启用中的账号（跳过 *.json.disabled）。 */
function accounts() {
  if (!existsSync(AUTH_DIR)) return [];
  const out = [];
  for (const name of readdirSync(AUTH_DIR)) {
    if (!name.startsWith('workbuddy') || !name.endsWith('.json')) continue;
    try {
      const doc = JSON.parse(readFileSync(join(AUTH_DIR, name), 'utf8'));
      const uid = doc?.account?.uid;
      const accessToken = doc?.auth?.accessToken;
      if (typeof uid !== 'string' || uid === '' || typeof accessToken !== 'string' || accessToken === '') continue;
      const domain = typeof doc.auth.domain === 'string' ? doc.auth.domain : '';
      const realm = doc.auth.realm === 'global' || /(^|\.)workbuddy\.ai$/u.test(domain.toLowerCase()) ? 'global' : 'cn';
      out.push({
        file: name,
        uid,
        realm,
        domain,
        enterpriseId: typeof doc.account.enterpriseId === 'string' ? doc.account.enterpriseId : '',
        nickname: typeof doc.account.nickname === 'string' ? doc.account.nickname : '',
        accessToken,
      });
    } catch { /* 坏文件跳过 */ }
  }
  out.sort((a, b) => a.uid.localeCompare(b.uid));
  return ONLY === '' ? out : out.filter((a) => a.uid.startsWith(ONLY));
}

function headers(account, extra = {}) {
  const h = {
    Authorization: `Bearer ${account.accessToken}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'X-User-Id': account.uid,
    ...extra,
  };
  if (account.enterpriseId !== '') {
    h['X-Enterprise-Id'] = account.enterpriseId;
    h['X-Tenant-Id'] = account.enterpriseId;
  }
  if (account.domain !== '') h['X-Domain'] = account.domain;
  return h;
}

function tokenIssuerOrigin(accessToken) {
  try {
    const part = String(accessToken ?? '').split('.')[1];
    if (!part) return null;
    const padded = part.replace(/-/gu, '+').replace(/_/gu, '/') + '='.repeat((4 - (part.length % 4)) % 4);
    const origin = new URL(String(JSON.parse(Buffer.from(padded, 'base64').toString('utf8')).iss ?? '')).origin;
    return origin === 'null' ? null : origin.toLowerCase();
  } catch {
    return null;
  }
}

/** 多域名 × 多路径签到；返回 {ok, already, message}。 */
async function checkin(account) {
  const hosts = [];
  const issuer = tokenIssuerOrigin(account.accessToken);
  if (issuer !== null && /workbuddy|codebuddy/u.test(issuer)) hosts.push(issuer);
  for (const host of [BILLING[account.realm], 'https://www.workbuddy.cn', 'https://www.workbuddy.ai']) {
    if (!hosts.includes(host)) hosts.push(host);
  }
  let last = '未知错误';
  let unauthorized = null;
  for (const host of hosts) {
    for (const path of CHECKIN_PATHS) {
      let response;
      try {
        response = await fetch(`${host}${path}`, {
          method: 'POST',
          headers: headers(account, {
            'x-client-platform': 'web',
            origin: host,
            referer: `${host}/profile/plans-usage`,
            'user-agent': UA,
          }),
          body: '{}',
          signal: AbortSignal.timeout(15_000),
        });
      } catch (error) {
        last = error instanceof Error ? error.message : String(error);
        continue;
      }
      const text = await response.text().catch(() => '');
      let envelope = {};
      try { envelope = JSON.parse(text); } catch { /* 空体交给 classify */ }
      const message = envelope.msg || envelope.message || (response.ok ? 'ok' : `HTTP ${response.status}`);
      const inactive = CHECKIN_INACTIVE.test(message);
      const already = Number(envelope.code) === 10001 && !inactive && CHECKIN_ALREADY.test(message);
      const ok = !inactive && ((response.ok && Number(envelope.code) === 0) || already);
      if (ok) return { ok: true, already, message };
      if (response.status === 401) {
        unauthorized ??= { ok: false, already: false, message: '登录身份过期（重新登录桌面端后重跑 wb_import.mjs）' };
        last = message;
        continue;
      }
      if ((response.status >= 400 && response.status < 500 && response.status !== 404) || (response.ok && response.status !== 404)) {
        return { ok: false, already: false, message };
      }
      last = message;
    }
  }
  return unauthorized ?? { ok: false, already: false, message: last };
}

/** 试候选路径取第一个成功的 data。 */
async function growthJson(account, paths) {
  const host = BILLING[account.realm];
  let last = '所有候选路径都失败';
  for (const path of paths) {
    let response;
    try {
      response = await fetch(`${host}${path}`, {
        headers: headers(account, {
          accept: 'application/json, text/plain, */*',
          'x-client-platform': 'web',
          origin: host,
          referer: `${host}/profile/growth-center`,
          'user-agent': UA,
        }),
        signal: AbortSignal.timeout(12_000),
      });
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
      continue;
    }
    const text = await response.text().catch(() => '');
    let envelope;
    try { envelope = JSON.parse(text); } catch { last = `HTTP ${response.status} 非 JSON`; continue; }
    if (!response.ok) { last = envelope.msg || `HTTP ${response.status}`; continue; }
    if (typeof envelope.code === 'number' && envelope.code !== 0) { last = envelope.msg || `code=${envelope.code}`; continue; }
    return envelope.data !== null && typeof envelope.data === 'object' ? envelope.data : envelope;
  }
  throw new Error(last);
}

/** 拉任务清单，返回可领的 task_code 列表。 */
async function claimableTasks(account) {
  const data = await growthJson(account, GROWTH_TASK_PATHS);
  const list = Array.isArray(data?.tasks) ? data.tasks : [];
  const codes = [];
  for (const task of list) {
    if (task === null || typeof task !== 'object') continue;
    const status = String(task.accept_status ?? 'not_accepted');
    const progress = task.progress !== null && typeof task.progress === 'object' ? task.progress : {};
    const current = Math.max(0, Number(progress.current) || 0);
    const target = Math.max(1, Number(progress.target) || 1);
    const complete = status === 'completed' || current >= target;
    const code = TASK_CODE.test(String(task.task_code ?? '')) ? String(task.task_code) : '';
    if (status !== 'claimed' && complete && code !== '') codes.push(code);
  }
  return [...new Set(codes)].slice(0, 20);
}

async function claimTasks(account) {
  const codes = await claimableTasks(account);
  if (codes.length === 0) return { ok: true, message: '没有可领的任务', claimed: 0 };
  const host = BILLING[account.realm];
  let response;
  try {
    response = await fetch(`${host}${GROWTH_ACCEPT_PATH}`, {
      method: 'POST',
      headers: headers(account, {
        accept: 'application/json, text/plain, */*',
        'x-client-platform': 'web',
        origin: host,
        referer: `${host}/profile/growth-center`,
        'user-agent': UA,
      }),
      body: JSON.stringify({ task_codes: codes }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    return { ok: false, claimed: 0, message: `领取请求失败：${error instanceof Error ? error.message : String(error)}` };
  }
  const text = await response.text().catch(() => '');
  let envelope;
  try { envelope = JSON.parse(text); } catch { return { ok: false, claimed: 0, message: `领取接口返回非 JSON（HTTP ${response.status}）` }; }
  if (!response.ok || (typeof envelope.code === 'number' && envelope.code !== 0)) {
    return { ok: false, claimed: 0, message: String(envelope.msg || envelope.message || `HTTP ${response.status}`) };
  }
  const granted = Number(envelope.data?.total_credit ?? envelope.data?.credit ?? envelope.data?.reward_credit);
  return {
    ok: true,
    claimed: codes.length,
    message: `已领取 ${codes.length} 个任务${Number.isFinite(granted) && granted > 0 ? `，+${granted} 积分` : ''}`,
  };
}

/** 保活：建一次云端会话（插件里标注「未实测」，默认不跑）。 */
async function keepAlive(account) {
  const host = BILLING[account.realm];
  let response;
  try {
    response = await fetch(`${host}/console/as/conversations/`, {
      method: 'POST',
      headers: headers(account, {
        'x-codebuddy-request': '1',
        'x-client-platform': 'web',
        origin: host,
        referer: `${host}/`,
        'user-agent': UA,
      }),
      body: JSON.stringify({ prompt: '你好', model: 'deepseek-r1', plugins: [] }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  const text = await response.text().catch(() => '');
  let envelope = {};
  try { envelope = JSON.parse(text); } catch { /* 非 JSON 视为失败 */ }
  if (!response.ok || (typeof envelope.code === 'number' && envelope.code !== 0)) {
    return { ok: false, message: String(envelope.msg || envelope.message || `HTTP ${response.status}`) };
  }
  const body = envelope?.data !== null && typeof envelope?.data === 'object' ? envelope.data : envelope;
  const id = String(body?.id ?? body?.conversationId ?? body?.info?.id ?? '');
  return id === '' ? { ok: false, message: '会话已建立但响应里没有 id' } : { ok: true, message: `会话 ${id.slice(0, 12)}` };
}

const day = localDay();
const state = readState();
const today = state[day] !== null && typeof state[day] === 'object' ? state[day] : {};
const list = accounts();

log(`启动：${list.length} 个启用账号${ONLY ? `（过滤 uid 前缀 ${ONLY}）` : ''}${FORCE ? ' --force' : ''}${DRY ? ' --dry' : ''}`);
if (list.length === 0) {
  log('没有可用账号，退出。');
  process.exit(0);
}

const rows = [];
for (const account of list) {
  const label = account.nickname || account.uid.slice(0, 8);
  const tasks = ['checkin', 'growth', ...(KEEPALIVE ? ['keepalive'] : [])];
  const row = { uid: account.uid, nickname: label, realm: account.realm, checkin: '-', growth: '-', keepalive: '-' };
  for (const kind of tasks) {
    if (account.realm === 'global' && kind === 'checkin') { row[kind] = '跳过(国际版)'; continue; }
    const key = `${kind}:${account.uid}`;
    if (!FORCE && today[key]?.ok === true) { row[kind] = '今日已完成'; continue; }
    if (DRY) { row[kind] = '将执行'; continue; }
    let outcome;
    try {
      if (kind === 'checkin') outcome = await checkin(account);
      else if (kind === 'growth') outcome = await claimTasks(account);
      else outcome = await keepAlive(account);
    } catch (error) {
      outcome = { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
    today[key] = { ok: outcome.ok === true, message: String(outcome.message ?? ''), at: Date.now() };
    row[kind] = `${outcome.ok ? 'OK' : 'FAIL'} ${String(outcome.message ?? '').slice(0, 40)}`;
    log(`  ${label} [${kind}] ${row[kind]}`);
  }
  rows.push(row);
}

if (!DRY) {
  state[day] = today;
  writeState(state);
}

console.log('');
console.log('uid'.padEnd(10), 'realm'.padEnd(7), '账号'.padEnd(20), '签到'.padEnd(24), '任务'.padEnd(24), '保活');
for (const row of rows) {
  console.log(
    row.uid.slice(0, 8).padEnd(10),
    row.realm.padEnd(7),
    row.nickname.slice(0, 18).padEnd(20),
    String(row.checkin).slice(0, 22).padEnd(24),
    String(row.growth).slice(0, 22).padEnd(24),
    String(row.keepalive).slice(0, 20),
  );
}
const failed = rows.flatMap((row) => ['checkin', 'growth', 'keepalive'].map((k) => row[k])).filter((v) => String(v).startsWith('FAIL'));

// 第二阶段：成长任务自动化（wb_tasks.mjs —— 本项目内的动作引擎）。
// **默认不跑**：任务自动化只在手动触发时执行（面板的「一键做任务」按钮，或显式加 --tasks）。
// 为什么要两轮：上游计分是异步的，第一轮只把行为链上报进去，第二轮才落账并领奖。
// --include-attempt 带上 black_cat（23:00–08:00 窗口内才会计分；窗口外动作自身会跳过）。
let taskExit = 0;
if (!DRY && WITH_TASKS) {
  log('第二阶段：执行成长任务自动化（两轮）');
  const r = spawnSync(process.execPath, [
    join(HERE, 'wb_tasks.mjs'), 'auto', 'all', '--passes', '2', '--include-attempt',
  ], { stdio: 'inherit' });
  taskExit = r.status ?? 0;
  log(`任务阶段结束：exit=${taskExit}`);
}

log(`结束：${rows.length} 个账号，失败 ${failed.length} 项`);
process.exit(failed.length > 0 || taskExit !== 0 ? 1 : 0);
