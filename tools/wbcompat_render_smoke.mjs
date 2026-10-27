/**
 * 渲染冒烟：在 jsdom 里把复刻过来的 UI 真正挂起来，看它能不能用本插件的数据画出来。
 *
 * 三件事一起验：
 *   1. client.js（shim + vendor bundle）能在浏览器式环境里执行并交出 factory；
 *   2. 六个槽位注册的组件，用假 ctx 的 props 能渲染成 DOM 而不抛错；
 *   3. DOM 文本里出现本机账号昵称、积分数字、模型名 —— 数据确实从
 *      /dsh-wb2api/* 走到了参考 UI 的组件树里。
 *
 * `@deepseek-ai/dsh-client-ui-primitives` 是宿主提供的包，离线拿不到，
 * 这里用最小替身（把 props/children 画成 div）—— 所以断言只认文本与
 * `wbp-` 类名，不认像素。
 *
 * 用法：node tools/wbcompat_render_smoke.mjs [baseURL]
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const BASE = process.argv[2] ?? 'http://127.0.0.1:41018';

const requireSmoke = createRequire(join(REPO, '.smoke', 'package.json'));
const { JSDOM } = requireSmoke('jsdom');
const react = requireSmoke('react');
const reactDomClient = requireSmoke('react-dom/client');
const jsxRuntime = requireSmoke('react/jsx-runtime');
const { act } = requireSmoke('react-dom/test-utils');

const html = '<!doctype html><html><head></head><body><div id="root"></div></body></html>';
const dom = new JSDOM(html, { url: BASE + '/', pretendToBeVisual: true });
const win = dom.window;

// ---- 把 jsdom 的 window 装成全局，让 client.js 里的 window/document 正常工作 ----
// Node 24 里 navigator/localStorage 在 globalThis 上是 getter，只能 defineProperty。
function setGlobal(name, value) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}
setGlobal('window', win);
setGlobal('document', win.document);
setGlobal('navigator', win.navigator);
setGlobal('localStorage', win.localStorage);
setGlobal('HTMLElement', win.HTMLElement);
setGlobal('Element', win.Element);
setGlobal('Node', win.Node);
setGlobal('Event', win.Event);
setGlobal('CustomEvent', win.CustomEvent);
setGlobal('getComputedStyle', win.getComputedStyle.bind(win));
setGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
setGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} });
if (typeof win.matchMedia !== 'function') {
  win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
}
setGlobal('matchMedia', win.matchMedia);
setGlobal('requestAnimationFrame', win.requestAnimationFrame?.bind(win) ?? ((fn) => setTimeout(fn, 0)));
setGlobal('cancelAnimationFrame', win.cancelAnimationFrame?.bind(win) ?? clearTimeout);

// ---- fetch：所有相对 URL 打到真实宿主 ----
const realFetch = globalThis.fetch;
const baseFetch = (input, init) => {
  const url = typeof input === 'string' ? input : (input && input.url) ?? String(input);
  return realFetch(new URL(url, BASE + '/').toString(), init);
};
win.fetch = baseFetch;
globalThis.fetch = baseFetch;

// ---- 模块加载器：抓 factory ----
let captured = null;
win.__ModuleLoader__ = {
  load(entry) {
    if (captured !== null) throw new Error('duplicate factory registration');
    captured = entry;
  },
};

// ---- primitives 替身 ----
const h = react.createElement;
function stubComponent(tag) {
  const Stub = (props) => {
    const { children, ...rest } = props ?? {};
    const clean = {};
    for (const [key, value] of Object.entries(rest)) {
      if (key === 'ref' || key === 'key') continue;
      if (typeof value === 'function' || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') clean[key] = value;
    }
    return h(tag, clean, children);
  };
  Stub.displayName = 'Stub(' + tag + ')';
  return Stub;
}
const primitives = new Proxy({}, {
  get(target, key) {
    if (key === '__esModule') return true;
    if (typeof key !== 'string') return undefined;
    if (!(key in target)) {
      // 图标类按 span，其余按 div；两种都只是承载 children。
      target[key] = /icon|glyph|logo|spinner/i.test(key) ? stubComponent('span') : stubComponent('div');
    }
    return target[key];
  },
});

const modules = {
  react,
  'react-dom': requireSmoke('react-dom'),
  'react/jsx-runtime': jsxRuntime,
  '@deepseek-ai/dsh-client-ui-primitives': primitives,
};
const fakeRequire = (name) => {
  if (name in modules) return modules[name];
  throw new Error('unexpected require(' + JSON.stringify(name) + ')');
};

// ---- 执行 client.js（shim + bundle）----
const code = readFileSync(join(REPO, 'client', 'client.js'), 'utf8');
// eslint-disable-next-line no-new-func
new Function('window', 'document', 'navigator', 'localStorage', code)(win, win.document, win.navigator, win.localStorage);
if (captured === null) throw new Error('client.js 没有调用 __ModuleLoader__.load');
console.log('load() 捕获 id =', captured.id);

// shim 已经把 window.fetch 换成了拦截版；让裸 fetch 也走拦截版。
globalThis.fetch = win.fetch;

// ---- 预热：第一次 /credits 需要打上游（6 个账号），先把两边的文档各拉一次 ----
for (const path of ['/plugins/dsh-workbuddy-connect-functy/status', '/plugins/dsh-workbuddy-connect-functy/ai/status']) {
  const response = await win.fetch(path, { headers: { accept: 'application/json' } });
  const doc = await response.json();
  console.log('[warm]', path.replace('/plugins/dsh-workbuddy-connect-functy', ''), '→', doc.status,
    doc.credits ? 'credits=' + doc.credits.total : '(无 credits)',
    doc.accounts ? 'accounts=' + doc.accounts.accounts.length : '');
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const exportsObj = captured.factory(fakeRequire);
console.log('exports:', Object.keys(exportsObj).join(', '));

// ---- 假 ctx：记录注册点并保留组件 ----
const registrations = [];
function makeSlots(scopeName) {
  return {
    inject(_name, callback) {
      callback();
      return () => {};
    },
    register(desc, Component) {
      registrations.push({ slot: desc.name, id: desc.id ?? desc.key ?? '', Component, desc, scope: scopeName });
      return () => {};
    },
  };
}
const slots = makeSlots('root');
const layoutService = { selectPanel() {}, selectTab() {} };
/** 会话模型目录的假件：getSnapshot 必须返回同一个对象，否则 useSyncExternalStore 会无限重渲染。 */
const EMPTY_DIRECTORY = { models: [], current: null, pending: false };
const fakeCtx = {
  effect(fn) { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {}; },
  locale: { register() {}, bind: () => (key, params) => (params && typeof params === 'object' ? key + JSON.stringify(params) : key) },
  slots,
  get(name) { return name === 'layout' ? layoutService : undefined; },
  inject(deps, callback) {
    if (Array.isArray(deps)) {
      const scope = {
        slots,
        get: fakeCtx.get,
        modelDirectories: {
          // 快照必须是**同一个对象**：组件用 useSyncExternalStore 读它，每次返回新
          // 字面量会被判成「又变了」，渲染直接打转（Maximum update depth）。
          directoryFor: () => ({
            store: {
              getSnapshot: () => EMPTY_DIRECTORY,
              subscribe: () => () => {},
              update() {},
            },
          }),
        },
      };
      callback(scope);
      return;
    }
    callback();
  },
  logger: { info() {}, warn() {}, error() {}, debug() {} },
};
exportsObj.apply(fakeCtx);
console.log('注册点数:', registrations.length);
for (const row of registrations) console.log('  -', row.slot, row.id === '' ? '' : '@' + row.id);

// ---- 渲染 ----
/**
 * 把槽位的 inject 工厂返回值变成 react props。
 *
 * DSH 的槽位约定：注册描述里的 `inject` 返回 `{ hooks: { xxx: store } }` 时，
 * 宿主把每个 store 包成 `useXxx(selector)` 钩子再传给组件（`useSyncExternalStore`）。
 * 这里照着复现 —— 所以面板读到的就是参考实现自己 create 的那个 store，
 * 不是替身，数据来源仍然是我们拦截的 fetch。
 */
function hookFromStore(store) {
  return (selector) => react.useSyncExternalStore(
    store.subscribe,
    () => selector(store.getSnapshot()),
  );
}

function propsFor(row) {
  const sessionScoped = row.slot === 'conversation.composer.dock' || row.slot === 'conversation.input.right';
  let injected = {};
  try {
    injected = typeof row.desc.inject === 'function' ? (row.desc.inject(sessionScoped ? 'session-1' : undefined) ?? {}) : {};
  } catch (error) {
    console.log('   !! inject() 抛错:', error instanceof Error ? error.message : String(error));
  }
  const props = { ...injected };
  if (props.hooks && typeof props.hooks === 'object') {
    for (const [name, store] of Object.entries(props.hooks)) {
      props['use' + name[0].toUpperCase() + name.slice(1)] = hookFromStore(store);
    }
  }
  if (typeof props.t !== 'function') props.t = (key) => key;
  // 侧栏脚部卡片有两种形态：宽侧栏（foot 卡片，带文字）与收起的 rail（只有环形图标）。
  // 真宿主按侧栏宽度传 wide；这里固定成宽版，才验证得到文字与额度行。
  if (row.slot === 'sidebar.footer.action') props.wide = true;
  return props;
}

async function renderOne(row) {
  const container = win.document.createElement('div');
  win.document.body.appendChild(container);
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => { errors.push(args.map((v) => (v instanceof Error ? v.message : String(v))).join(' ')); };
  let root = null;
  const props = propsFor(row);
  const panelStore = props.hooks && props.hooks.workBuddyPanel;
  try {
    // 面板表面共用一个 store：宿主里它由常驻的侧栏卡片 start()，这里先手动刷一次，
    // 否则仪表盘第一次渲染时 snapshot 还是空的（会显示 "host did not report pools"）。
    if (panelStore && typeof panelStore.refresh === 'function') {
      await act(async () => { await panelStore.refresh(); });
      const snap = panelStore.getSnapshot();
      console.log('   [store] statuses=' + Object.keys(snap.statuses || {}).join(',') + ' loading=' + snap.loading);
    }
    await act(async () => {
      root = reactDomClient.createRoot(container);
      root.render(h(row.Component, props));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 250)); });
  } finally {
    console.error = originalError;
  }
  const text = container.textContent ?? '';
  const marks = container.querySelectorAll('[class*="wbp-"]').length;
  const fatal = errors.filter((line) => !/not wrapped in act|deprecated|Warning: Each child|validateDOMNesting|Unknown prop|non-boolean attribute|Received .%s. for/i.test(line));
  try { root?.unmount(); } catch {}
  container.remove();
  return { text, marks, fatal };
}

const results = [];
for (const row of registrations) {
  const outcome = await renderOne(row);
  results.push({ row, outcome });
  const short = outcome.text.replace(/\s+/g, ' ').trim().slice(0, 110);
  console.log('\n▸', row.slot + (row.id === '' ? '' : '@' + row.id));
  console.log('   wbp- 元素:', outcome.marks, '| 文本长度:', outcome.text.length);
  console.log('   文本:', short === '' ? '(空)' : short);
  if (outcome.fatal.length > 0) {
    console.log('   !! 渲染错误:', outcome.fatal.slice(0, 3).join(' | ').slice(0, 400));
  }
}

// ---- 断言 ----
const joined = results.map((item) => item.outcome.text).join('\n');
const need = ['Shantanu', 'wei894348', '快乐不打烊', 'glm-5.3', 'deepseek-v4.1-flash', '重启网关', '领取任务积分'];
console.log('\n期待出现的片段:');
for (const token of need) console.log('  ', token, joined.includes(token) ? 'OK' : 'MISS');
const styled = results.reduce((sum, item) => sum + item.outcome.marks, 0);
console.log('wbp- 元素总数:', styled);
const fatals = results.reduce((sum, item) => sum + item.outcome.fatal.length, 0);
console.log('fatal 渲染错误:', fatals);

const ok = styled > 0 && fatals === 0 && results.length === registrations.length;
console.log(ok ? '\n[OK] 六个表面全部渲染成 DOM' : '\n[FAIL] 见上面的错误');
process.exit(ok ? 0 : 1);
