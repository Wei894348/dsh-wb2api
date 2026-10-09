/**
 * WorkBuddy 成长任务自动化 —— 命令行入口（引擎在 wb_up/run.mjs，这里只做参数与打印）。
 *
 * 逻辑覆盖：动作表 / 回读验证 / 达标自动领奖，以及任务中心的「扫描 → 建队 → 执行」。
 * 上游计分是**异步**的，所以默认跑两轮：
 * 第一轮把行为链上报进去，第二轮才落账并领奖。
 *
 * 用法：
 *   node wb_tasks.mjs list [uid前缀]                任务清单
 *   node wb_tasks.mjs scan [uid前缀]                待办扫描（只读，不改上游）
 *   node wb_tasks.mjs auto <uid前缀|all> [选项]      执行并自动领奖
 *   node wb_tasks.mjs credits                       各账号积分
 * 选项：
 *   --only CODE[,CODE]   只跑指定任务
 *   --passes N           跑几轮（默认 2）
 *   --gap S              轮间隔秒（默认 8）
 *   --concurrency N      账号间并发（默认 2，上限 3）
 *   --include-attempt    含尝试型（black_cat，窗口外会自行跳过）
 *   --all                连已完成的也重新执行
 */
import { resolveAuths, label } from './wb_up/store.mjs';
import { ACTIONS, actionFor } from './wb_up/actions.mjs';
import { api } from './wb_up/backend.mjs';
import { runAutomation, scanPendingTasks, pickAuths, progressOf, doneAlready } from './wb_up/run.mjs';

const args = process.argv.slice(2);
const cmd = args[0] ?? 'help';
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt;
};
const has = (name) => args.includes(`--${name}`);
const selector = args.slice(1).find((a) => !a.startsWith('--') && !/^\d+$/u.test(a)) ?? '';

const only = String(flag('only', '')).split(',').map((s) => s.trim()).filter(Boolean);
const passes = Math.max(1, Number(flag('passes', 2)) || 2);
const gapSec = Math.max(0, Number(flag('gap', 8)) || 8);
const concurrency = Math.min(3, Math.max(1, Number(flag('concurrency', 2)) || 2));
const includeAttempt = has('include-attempt');
const forceAll = has('all');

const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const log = (...a) => console.log(`[${stamp()}]`, ...a);

async function cmdList(prefix) {
  for (const auth of pickAuths(prefix)) {
    console.log(`\n${auth.nickname} ${auth.uid} [${auth.realm}]`);
    let tasks = [];
    try { tasks = await api.listTasks(auth); } catch (error) { console.log(`  读取失败：${error.message}`); continue; }
    for (const t of tasks) {
      const mark = doneAlready(t) ? '✓' : (actionFor(t.task_code) ? '·' : ' ');
      console.log(`  ${mark} ${String(t.task_code).padEnd(26)} ${progressOf(t).padEnd(8)} ${t.title ?? ''}`);
    }
  }
}

async function cmdScan(prefix) {
  const { accounts: rows, total } = await scanPendingTasks({ selector: prefix, includeAttempt: true });
  for (const row of rows) {
    console.log(`\n${label(row)} 待办 ${row.pending.length} 项`);
    for (const p of row.pending) console.log(`  ${String(p.code).padEnd(26)} ${String(p.progress).padEnd(8)} ${p.desc}`);
  }
  console.log(`\n合计待办 ${total} 项`);
}

async function cmdCredits() {
  for (const auth of resolveAuths()) {
    let balance = '?';
    try { balance = await api.balance(auth); } catch (error) { balance = `读取失败(${error.message})`; }
    console.log(`${label(auth).padEnd(28)} ${auth.realm.padEnd(7)} ${balance}`);
  }
}

async function cmdAuto(prefix) {
  const summary = await runAutomation({
    selector: prefix,
    only,
    passes,
    gapSec,
    concurrency,
    includeAttempt,
    forceAll,
    onLog: log,
  });
  console.log('');
  for (const row of summary.accounts) {
    console.log(`${label(row).padEnd(28)} 领奖 ${String(row.claimed.length).padStart(2)} 项  +${row.credit} 分 +${row.energy} 能`
      + (row.errors.length > 0 ? `  错误 ${row.errors.length} 项` : ''));
  }
  log(`完成：+${summary.totals.credit} 分 +${summary.totals.energy} 能，用时 ${((summary.finishedAt - summary.startedAt) / 1000).toFixed(0)}s`);
  process.exit(summary.totals.errors > 0 ? 1 : 0);
}

switch (cmd) {
  case 'list': await cmdList(selector); break;
  case 'scan': await cmdScan(selector); break;
  case 'credits': await cmdCredits(); break;
  case 'auto': await cmdAuto(selector); break;
  default:
    console.log('用法：list [uid] | scan [uid] | auto <uid|all> [--only CODE] [--passes N] [--concurrency N] [--include-attempt] [--all] | credits');
}
