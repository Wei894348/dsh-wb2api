/**
 * 插件客户端半侧的离线冒烟测试 —— 不开浏览器也能把 Panel 渲染一遍。
 *
 * 为什么需要：dsh 的 client 半侧是手写的 __ModuleLoader__ factory（无构建），
 * 改完只有「刷新页面」才知道有没有炸。这里用最小 React 替身 + 哑 DOM 把它
 * 跑三遍（初始 / 任务执行中 / 执行完成），足以抓出未定义变量、属性名写错、
 * 分支里访问空对象这类浏览器里才会现形的问题。
 *
 * 用法：node wb_client_smoke.mjs [client.js 路径]
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// 默认取「本插件的现场安装目录」里的 client.js；换机器/换路径用第一个参数或 WB_CLIENT 覆盖。
const CLIENT = process.argv[2]
  ?? process.env.WB_CLIENT
  ?? join(homedir(), '.dsh', 'plugins', 'dsh-plugin-wb2api-ui', 'client', 'client.js');
const src = readFileSync(CLIENT, 'utf8');

const noop = () => {};
const h = (type, props, ...children) => ({ type, props: props ?? {}, children });

/** 放一份假的 taskRun 状态，让「执行中 / 执行完成」两个分支真的被渲染到。 */
const FAKE = {
  running: {
    running: true, startedAt: Date.now(), finishedAt: 0, error: '', logs: ['确认结果：待办 5 项，开始执行', '  示例账号(0123abcd) 第 1 轮：执行 1 项，领奖 0 项'],
    pending: { total: 5, accounts: [{ uid: '0123abcd', nickname: '示例账号', pending: [{ code: 'black_cat', progress: '1/3', desc: '夜猫子' }] }] },
    summary: null,
  },
  summary: {
    running: false, startedAt: 1, finishedAt: 2, error: '', logs: ['完成：+400 分 +10 能'],
    pending: { total: 5, accounts: [{ uid: '0123abcd', nickname: '示例账号', pending: [{ code: 'black_cat' }] }] },
    summary: {
      totals: { accounts: 6, claimItems: 2, credit: 400, energy: 10, executed: 3, errors: 1 },
      accounts: [{
        uid: '0123abcd', nickname: '示例账号', credit: 400, energy: 10, executed: 3,
        claimed: [{ code: 'create_canvas', credit: 300, energy: 5 }],
        errors: [{ code: 'expert_5', message: 'boom' }],
      }],
    },
  },
};

/**
 * 面板的数据态是 `{phase, data}`。替身里 useEffect 不跑，数据永远到不了，
 * 渲染的就只是加载骨架 —— 所以这里直接把 ready 态塞进去，让真正的界面分支跑起来。
 */
const READY = {
  phase: 'ready', error: '', missing: false,
  data: {
    runtimeDir: 'C:/Users/x/.dsh/wb2api',
    authDir: 'C:/Users/x/.dsh/wb2api/auths',
    configured: true,
    binary: { path: 'wb2a-server.exe', exists: true },
    gateway: { running: true, health: { healthy: 6, total: 6 } },
    accounts: [],
    models: [],
    pool: {
      accounts: [],
      cooling: 0, disabled: 0, healthy: 6, total: 6, in_flight_full: 0, sticky_sessions: 0,
      cn: { cooling: 0, disabled: 0, healthy: 6, total: 6, in_flight_full: 0 },
      global: { cooling: 0, disabled: 0, healthy: 0, total: 0, in_flight_full: 0 },
      realm_totals: {
        cn: { cooling: 0, disabled: 0, healthy: 6, total: 6, in_flight_full: 0 },
        global: { cooling: 0, disabled: 0, healthy: 0, total: 0, in_flight_full: 0 },
      },
    },
    admin: { enabled: true },
    activity: {},
    total: 1234, unlimited: 0, counts: {}, oldestFetch: Date.now(), accountsCredits: [],
  },
};

let mode = 'idle';
const react = {
  createElement: h,
  useState: (init) => {
    const value = typeof init === 'function' ? init() : init;
    const isTaskRun = value !== null && typeof value === 'object' && 'running' in value && 'logs' in value;
    if (isTaskRun && mode !== 'idle') return [FAKE[mode], noop];
    if (value !== null && typeof value === 'object' && 'phase' in value) return [READY, noop];
    return [value, noop];
  },
  useEffect: () => {},
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useRef: (init) => ({ current: init ?? null }),
  Fragment: 'Fragment',
};

const makeEl = (tag = 'div') => ({
  tagName: tag, id: '', style: {}, textContent: '', innerHTML: '',
  appendChild: noop, setAttribute: noop, addEventListener: noop,
});
const documentStub = {
  getElementById: () => null,
  createElement: (tag) => makeEl(tag),
  head: { appendChild: noop },
  body: { appendChild: noop },
};

let def = null;
globalThis.window = { __ModuleLoader__: { load: (value) => { def = value; } }, open: noop };
globalThis.document = documentStub;
globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({ ok: false, error: '离线冒烟：不发真请求' }) });

new Function('window', 'document', src)(globalThis.window, documentStub);
if (def === null) throw new Error('client.js 没有注册 __ModuleLoader__ factory');

const mod = def.factory((name) => {
  if (name === 'react') return react;
  throw new Error(`冒烟测试没有准备 require("${name}")`);
});
console.log(`模块加载: OK  exports = ${Object.keys(mod).join(', ')}`);

let renderer = null;
mod.apply({ slots: { inject: (slotName, fn) => { if (typeof fn === 'function') fn(); }, register: (spec, render) => { renderer = render; } } });
if (typeof renderer !== 'function') throw new Error('apply 没有注册 settings.section 渲染器');
const element = renderer();
const Panel = element.type;

/**
 * 在假 React 树里找一段文本。
 *
 * 必须**递归每个属性的值**而不是只看 children —— 这个面板的按钮挂在
 * `Section({ extra: h("div", …) })` 的 props 里，只看 children 会漏掉整排按钮。
 * 带 visited 防环（树里可能有函数、自引用）。
 */
function contains(node, needle, seen = new Set(), depth = 0) {
  if (node === null || node === undefined || depth > 80) return false;
  if (typeof node === 'string') return node.includes(needle);
  if (typeof node !== 'object') return false;
  if (seen.has(node)) return false;
  seen.add(node);
  if (Array.isArray(node)) return node.some((item) => contains(item, needle, seen, depth + 1));
  for (const value of Object.values(node)) {
    if (contains(value, needle, seen, depth + 1)) return true;
  }
  return false;
}

let failed = 0;
for (const [label, needle] of [
  ['初始（按钮未点）', '一键做任务'],
  ['任务执行中', '任务执行中…（确认待办 → 执行动作 → 自动领奖）'],
  ['任务执行完成', '任务执行完成：领奖 2 项，+400 分 +10 能，1 项出错'],
]) {
  mode = label === '初始（按钮未点）' ? 'idle' : (label === '任务执行中' ? 'running' : 'summary');
  const tree = Panel(element.props);
  const hit = contains(tree, needle);
  console.log(`渲染[${label}]: ${hit ? 'OK' : '缺失'}（找「${needle}」）`);
  if (!hit) failed += 1;
}
console.log(failed === 0 ? '冒烟通过' : `冒烟失败 ${failed} 项`);
process.exit(failed === 0 ? 0 : 1);
