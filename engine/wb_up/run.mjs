/**
 * 任务自动化编排层（可被 CLI 与 dsh 插件宿主共用）。
 *
 * 逻辑与 wb_tasks.mjs 的 CLI 一一对应，只是搬成库：
 *   扫描（确认有无待办）→ 建队 → 账号内串行 / 账号间并发 → 多轮（异步计分要两轮）
 *   → 达标自动领奖 → 汇总。
 *
 * 为什么不阻塞：全程只有 fetch 与定时器，没有同步等待；dsh 插件宿主可以直接
 * `await runAutomation(...)`，事件循环照常转。
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { resolveAuths, label } from './store.mjs';
import { sleep } from './core.mjs';
import { ACTIONS, actionFor, isMPCode } from './actions.mjs';
import { api } from './backend.mjs';

/**
 * 单飞锁：同一时刻只允许一轮任务自动化。
 *
 * 为什么必须有：面板上点「一键做任务」和计划任务（23:30 / 07:40）可能撞在一起，
 * 而专家链里是**真实对话**，重跑就是白烧额度 —— 那是付费上游。
 * 锁带 TTL：进程被杀不会留下永久死锁（超过 TTL 视为上轮已死）。
 */
const LOCK_FILE = join(homedir(), '.dsh', 'wb2api', 'data', 'wb-tasks.lock');
const LOCK_TTL_MS = 20 * 60 * 1000;

/** 当前持锁者；没有、或已超过 TTL → null。 */
function lockHolder() {
  try {
    const raw = JSON.parse(readFileSync(LOCK_FILE, 'utf8'));
    const at = Number(raw?.at ?? 0);
    if (!Number.isFinite(at) || at <= 0 || Date.now() - at > LOCK_TTL_MS) return null;
    return { at, pid: raw?.pid, what: raw?.what };
  } catch {
    return null;
  }
}

function writeLock(what = '') {
  try {
    mkdirSync(dirname(LOCK_FILE), { recursive: true });
    writeFileSync(LOCK_FILE, JSON.stringify({ at: Date.now(), pid: process.pid, what }), 'utf8');
  } catch { /* 锁写不进去不该让整轮跑不起来 */ }
}

function clearLock() {
  try { rmSync(LOCK_FILE, { force: true }); } catch { /* 忽略 */ }
}

/** 回读预算（与 autotask.go 一致：4 次 × 3s，总约 12s）。 */
export const CLAIM_POLL_ATTEMPTS = 4;
export const CLAIM_POLL_GAP_MS = 3000;
/** 动作之间的节流（上游脚本实测 1.05s 口径）。 */
export const ITEM_GAP_MS = 1050;
/** 账号间并发上限。 */
export const MAX_CONCURRENCY = 3;

export const progressOf = (t) => {
  if (!t) return '?';
  if (t.target > 0) return `${t.current}/${t.target}`;
  return t.claimed ? 'claimed' : (t.accept_status || '?');
};
const claimable = (t) => Boolean(t) && !t.claimed && t.target > 0 && t.current >= t.target;
/** 已完成（达标或已领奖）—— 默认跳过，不重复消耗上游配额。 */
export const doneAlready = (t) => Boolean(t) && (t.claimed === true || (t.target > 0 && t.current >= t.target));

/** 选账号：'' / 'all' → 全部启用；否则按 uid 前缀或昵称。 */
export function pickAuths(selector = '') {
  if (selector === '' || selector === 'all') return resolveAuths();
  return resolveAuths(selector);
}

/** 账号列表的并发闸门（保持结果顺序 = 输入顺序）。 */
export async function mapLimit(items, limit, worker) {
  const out = [];
  let cursor = 0;
  const width = Math.max(1, Math.min(limit, items.length));
  const runners = Array.from({ length: width }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      out[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return out;
}

async function readTask(auth, code) {
  return isMPCode(code) ? api.taskByCodeMP(auth, code) : api.taskByCode(auth, code);
}

/** 阶段 0：把未接受的任务批量接受（与网关脚本同序；失败不阻塞）。 */
async function acceptPending(auth, onLog) {
  const out = [];
  for (const [listFn, acceptFn, tag] of [
    [api.listTasks, api.acceptTasks, '成长'],
    [api.listTasksMP, api.acceptTasksMP, '小程序'],
  ]) {
    let tasks = [];
    try { tasks = await listFn(auth); } catch { continue; }
    const codes = tasks
      .filter((t) => !t.claimed && !t.locked && t.accept_status !== 'accepted' && t.accept_status !== 'completed')
      .map((t) => t.task_code)
      .filter(Boolean);
    if (codes.length === 0) continue;
    try {
      await acceptFn(auth, codes);
      out.push(`已接受 ${codes.length} 个${tag}任务`);
      onLog?.(`  ${label(auth)} 已接受 ${codes.length} 个${tag}任务`);
      await sleep(ITEM_GAP_MS);
    } catch (error) {
      out.push(`接受${tag}任务失败（不阻塞）：${error.message}`);
    }
  }
  return out;
}

/** 单个任务动作：前置读取 → 跑动作 → 有界回读 → 达标即领奖。任何异常只变成一条错误记录。 */
async function runOne(auth, code, opts) {
  try {
    return await runOneInner(auth, code, opts);
  } catch (error) {
    return { code, status: 'error', message: error?.message ?? String(error) };
  }
}

async function runOneInner(auth, code, opts) {
  const act = actionFor(code);
  if (act === undefined) return { code, status: 'skipped', message: '没有对应的自动动作（需客户端交互）' };
  if (act.attempt === true && !opts.includeAttempt && !opts.only.includes(code)) {
    return { code, status: 'skipped', message: '尝试型任务，未开启 include-attempt' };
  }
  const before = await readTask(auth, code);
  if (before === null) return { code, status: 'skipped', message: '该账号无此任务' };
  if (doneAlready(before) && !opts.forceAll) {
    return { code, status: 'skipped', message: `已完成（${progressOf(before)}）` };
  }
  let message;
  try {
    message = await act.run(auth, api);
  } catch (error) {
    return { code, status: 'error', message: error.message, progress_before: progressOf(before) };
  }
  // 窗口外的 black_cat 什么都没做，不该算「执行过」（否则白等一次节流）。
  if (act.attempt === true && /不在.*窗口/u.test(String(message))) {
    return { code, status: 'skipped', message, progress_before: progressOf(before) };
  }
  const after = isMPCode(code)
    ? await readTask(auth, code)
    : await api.taskByCodeWaiting(auth, code, CLAIM_POLL_ATTEMPTS, CLAIM_POLL_GAP_MS);
  const out = { code, status: 'done', message, progress_before: progressOf(before), progress_after: progressOf(after) };
  if (claimable(after)) {
    try {
      const reward = isMPCode(code) ? await api.claimRewardMP(auth, code) : await api.claimReward(auth, code);
      out.claimed = true;
      out.credit = reward.credit;
      out.energy = reward.energy;
      out.message = `${message}；已自动领奖 +${reward.credit} 分 +${reward.energy} 能`;
    } catch (error) {
      out.claim_error = error.message;
      out.message = `${message}；达标但领奖失败：${error.message}`;
    }
  }
  return out;
}

/** 单账号一轮：接受 → 逐项执行。只对真跑过动作的项节流（跳过项不发上游）。 */
async function runAccountOnce(auth, actions, opts) {
  const accepted = await acceptPending(auth, opts.onLog);
  const results = [];
  for (const item of actions) {
    const r = await runOne(auth, item.code, opts);
    results.push(r);
    if (r.status === 'done') await sleep(ITEM_GAP_MS);
  }
  return { accepted, results, executed: results.filter((r) => r.status === 'done').length };
}

/** 单账号多轮（第一轮上报、第二轮落账领奖）；某一轮零执行即短路后续轮。 */
async function runAccount(auth, actions, opts) {
  const all = [];
  for (let round = 1; round <= opts.passes; round += 1) {
    if (round > 1) await sleep(opts.gapSec * 1000);
    const { accepted, results } = await runAccountOnce(auth, actions, opts);
    all.push({ round, accepted, results });
    const done = results.filter((r) => r.status === 'done').length;
    const claimed = results.filter((r) => r.claimed);
    opts.onLog?.(`  ${label(auth)} 第 ${round} 轮：执行 ${done} 项，领奖 ${claimed.length} 项`);
    for (const r of results) {
      if (r.status === 'error') opts.onLog?.(`    ✗ ${r.code}: ${r.message}`);
      else if (r.claimed) opts.onLog?.(`    ✓ ${r.code}: ${r.message}`);
    }
    opts.onProgress?.({ auth, round, done, claimed: claimed.length });
    if (done === 0) {
      opts.onLog?.(`  ${label(auth)} 无待办，跳过后续轮次`);
      break;
    }
  }
  return all;
}

/**
 * 扫描：每个账号「有自动动作且未完成」的待办项。
 * @returns {Promise<{accounts: Array, total: number}>}
 */
export async function scanPendingTasks({ selector = '', includeAttempt = false, onLog } = {}) {
  const auths = pickAuths(selector);
  const out = [];
  for (const auth of auths) {
    const pending = [];
    for (const act of ACTIONS) {
      if (act.attempt === true && !includeAttempt) continue;
      let t = null;
      try { t = await readTask(auth, act.code); } catch { continue; }
      if (t === null || doneAlready(t)) continue;
      pending.push({ code: act.code, desc: act.desc, progress: progressOf(t), attempt: act.attempt === true });
    }
    out.push({ uid: auth.uid, nickname: auth.nickname, realm: auth.realm, pending });
    onLog?.(`${label(auth)} 待办 ${pending.length} 项`);
  }
  return { accounts: out, total: out.reduce((n, a) => n + a.pending.length, 0) };
}

/**
 * 执行一轮自动化。
 * @returns {Promise<{startedAt:number, finishedAt:number, accounts:Array, totals:object}>}
 */
export async function runAutomation({
  selector = '',
  only = [],
  passes = 2,
  gapSec = 8,
  concurrency = 2,
  includeAttempt = false,
  forceAll = false,
  ignoreLock = false,
  onLog,
  onProgress,
} = {}) {
  // 单飞锁：面板按钮与计划任务可能同时触发（专家链里有真实对话，重跑就是白烧额度）。
  // 锁只防「同一时刻两轮」，过期自动失效，所以不留垃圾状态。
  if (!ignoreLock) {
    const held = lockHolder();
    if (held !== null) {
      throw new Error(`已有一轮任务在跑（${new Date(held.at).toLocaleTimeString()} 起，pid ${held.pid ?? '?'}），`
        + `等它跑完再试；锁 ${Math.round((LOCK_TTL_MS - (Date.now() - held.at)) / 60000)} 分钟后自动失效。`);
    }
  }
  writeLock();
  try {
    return await runAutomationLocked({ selector, only, passes, gapSec, concurrency, includeAttempt, forceAll, onLog, onProgress });
  } finally {
    clearLock();
  }
}

async function runAutomationLocked({
  selector = '',
  only = [],
  passes = 2,
  gapSec = 8,
  concurrency = 2,
  includeAttempt = false,
  forceAll = false,
  onLog,
  onProgress,
} = {}) {
  const auths = pickAuths(selector);
  const actions = only.length > 0 ? ACTIONS.filter((a) => only.includes(a.code)) : ACTIONS;
  if (actions.length === 0) throw new Error(`only 没有命中任何动作：${only.join(',')}`);
  const opts = { only, passes: Math.max(1, passes), gapSec: Math.max(0, gapSec), includeAttempt, forceAll, onLog, onProgress };
  const startedAt = Date.now();
  onLog?.(`执行 ${auths.length} 个账号、${actions.length} 个动作、${opts.passes} 轮（账号间并发 ${concurrency}）`);
  const accounts = await mapLimit(auths, Math.max(1, Math.min(MAX_CONCURRENCY, concurrency)), async (auth) => {
    const rounds = await runAccount(auth, actions, opts);
    const claimed = rounds.flatMap((r) => r.results).filter((r) => r.claimed);
    return {
      uid: auth.uid,
      nickname: auth.nickname,
      realm: auth.realm,
      rounds,
      claimed,
      credit: claimed.reduce((n, r) => n + (r.credit ?? 0), 0),
      energy: claimed.reduce((n, r) => n + (r.energy ?? 0), 0),
      errors: rounds.flatMap((r) => r.results).filter((r) => r.status === 'error'),
      executed: rounds.flatMap((r) => r.results).filter((r) => r.status === 'done').length,
    };
  });
  const totals = {
    accounts: accounts.length,
    claimItems: accounts.reduce((n, a) => n + a.claimed.length, 0),
    credit: accounts.reduce((n, a) => n + a.credit, 0),
    energy: accounts.reduce((n, a) => n + a.energy, 0),
    executed: accounts.reduce((n, a) => n + a.executed, 0),
    errors: accounts.reduce((n, a) => n + a.errors.length, 0),
  };
  const finishedAt = Date.now();
  onLog?.(`完成：+${totals.credit} 分 +${totals.energy} 能，执行 ${totals.executed} 项，错误 ${totals.errors} 项，用时 ${((finishedAt - startedAt) / 1000).toFixed(0)}s`);
  return { startedAt, finishedAt, accounts, totals };
}

/** 单账号任务清单（CLI / 面板共用）。 */
export async function tasksOf(auth) {
  const tasks = await api.listTasks(auth);
  return tasks.map((t) => ({
    ...t,
    done: doneAlready(t),
    automatable: actionFor(t.task_code) !== undefined,
  }));
}

/** 各账号剩余积分。 */
export async function creditsOf(selector = '') {
  const auths = pickAuths(selector);
  const rows = [];
  for (const auth of auths) {
    let balance = null;
    let error = '';
    try { balance = await api.balance(auth); } catch (e) { error = e.message; }
    rows.push({ uid: auth.uid, nickname: auth.nickname, realm: auth.realm, balance, error });
  }
  return rows;
}

export { ACTIONS, actionFor, api, label };
