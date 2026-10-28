/**
 * 离线冒烟：把 client/client.js 当成 DSH 浏览器半边加载一遍。
 *
 * 目的不是渲染（没有 DOM），而是回答三个问题：
 *   1) 顶层代码能不能执行完（移植过来的 bundle 在模块作用域里读没读宿主 API）；
 *   2) factory 拿到的 require 能不能解析（react / react-dom / jsx-runtime / primitives）；
 *   3) apply(ctx) 会不会抛，六个注册点是否都落地。
 *
 * 用了 Proxy 桩：任何名字的组件/样式工具都返回占位函数，所以不必逐项抄宿主的导出表。
 */
import { readFileSync } from 'node:fs';

const CLIENT = process.argv[2] ?? 'client/client.js';
const code = readFileSync(CLIENT, 'utf8');

/** 任意名字的占位：既可当函数调用，也可当属性继续取。 */
function anyStub(label) {
  const fn = function stub() { return null; };
  return new Proxy(fn, {
    get(target, key) {
      if (key === Symbol.toPrimitive) return () => label;
      if (key === 'displayName' || key === 'name') return label;
      if (key === 'length') return 0;
      if (!(key in target)) target[key] = anyStub(label + '.' + String(key));
      return target[key];
    },
    apply() { return null; },
  });
}

const reactStub = new Proxy({}, {
  get(target, key) {
    if (key === '__esModule') return true;
    if (key in target) return target[key];
    if (key === 'createElement') target[key] = (type, props, ...kids) => ({ type, props, kids });
    else if (key === 'createContext') target[key] = () => ({ Provider: anyStub('Provider'), Consumer: anyStub('Consumer') });
    else if (key === 'Fragment') target[key] = Symbol('Fragment');
    else if (key === 'forwardRef') target[key] = (render) => render;
    else if (key === 'memo') target[key] = (component) => component;
    else if (String(key).startsWith('use')) {
      target[key] = (initial) => (String(key) === 'useState'
        ? [typeof initial === 'function' ? initial() : initial, () => {}]
        : (String(key) === 'useRef' ? { current: initial } : undefined));
    } else target[key] = anyStub('react.' + String(key));
    return target[key];
  },
});

const jsxRuntime = {
  jsx: (type, props) => ({ type, props }),
  jsxs: (type, props) => ({ type, props }),
  jsxDEV: (type, props) => ({ type, props }),
  Fragment: Symbol('Fragment'),
};

const moduleStubs = {
  react: reactStub,
  'react-dom': { createPortal: anyStub('createPortal'), render: anyStub('render'), flushSync: (fn) => fn?.() },
  'react/jsx-runtime': jsxRuntime,
  '@deepseek-ai/dsh-client-ui-primitives': new Proxy({}, {
    get(target, key) {
      if (key === '__esModule') return true;
      if (!(key in target)) target[key] = anyStub('primitive.' + String(key));
      return target[key];
    },
  }),
};

const styleTags = new Map();
const documentStub = {
  querySelector: (selector) => {
    const match = /data-plugin-css="([^"]+)"/u.exec(selector);
    return match !== null && styleTags.has(match[1]) ? styleTags.get(match[1]) : null;
  },
  createElement: (tag) => {
    const el = { tagName: tag, dataset: {}, style: {}, textContent: '', children: [], appendChild(child) { this.children.push(child); }, remove() {}, setAttribute() {}, addEventListener() {} };
    return el;
  },
  head: { appendChild(el) { if (el && el.dataset && el.dataset.pluginCss) styleTags.set(el.dataset.pluginCss, el); } },
  documentElement: { style: { setProperty() {} } },
  addEventListener() {},
  body: { appendChild() {}, style: {} },
};

const storage = new Map();
const registrations = [];
let factory = null;
let loadCalls = 0;

const sandbox = {
  console,
  setTimeout,
  clearTimeout,
  setInterval: () => 0,
  clearInterval() {},
  queueMicrotask,
  URL,
  URLSearchParams,
  AbortController,
  TextEncoder,
  TextDecoder,
  Response: globalThis.Response,
  Request: globalThis.Request,
  Headers: globalThis.Headers,
  atob: globalThis.atob,
  btoa: globalThis.btoa,
  crypto: globalThis.crypto,
  performance: globalThis.performance,
  JSON,
  Math,
  Promise,
  Map,
  Set,
  Date,
  Number,
  String,
  Array,
  Object,
  Error,
  RegExp,
  Symbol,
  Intl,
  document: documentStub,
  navigator: { userAgent: 'smoke', clipboard: { writeText: async () => {} } },
  localStorage: {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k),
  },
  location: { href: 'http://127.0.0.1/', origin: 'http://127.0.0.1', pathname: '/', search: '' },
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
  addEventListener() {},
  removeEventListener() {},
  requestAnimationFrame: (fn) => setTimeout(fn, 0),
  cancelAnimationFrame() {},
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  MutationObserver: class { observe() {} disconnect() {} },
  fetch: async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
  open() {},
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.self = sandbox;
sandbox.window.__ModuleLoader__ = {
  load(entry) {
    loadCalls += 1;
    factory = entry.factory;
  },
};

const vm = await import('node:vm');
vm.createContext(sandbox);
try {
  vm.runInContext(code, sandbox, { filename: CLIENT, timeout: 20000 });
} catch (error) {
  console.error('[FAIL] 顶层执行抛错：', error);
  process.exit(1);
}
console.log(`顶层执行 OK · load() 调用 ${loadCalls} 次 · factory ${factory === null ? '缺失' : '已捕获'}`);
if (factory === null) process.exit(1);

let exportsValue;
try {
  exportsValue = factory((name) => {
    if (!(name in moduleStubs)) throw new Error(`未桩接的 require：${name}`);
    return moduleStubs[name];
  });
} catch (error) {
  console.error('[FAIL] factory 执行抛错：', error);
  process.exit(1);
}

console.log('exports:', Object.keys(exportsValue).sort().join(', '));
console.log('name:', exportsValue.name, '| inject:', JSON.stringify(exportsValue.inject));

const slotApi = {
  inject(slotName, callback) { callback(); },
  register(descriptor) {
    registrations.push(descriptor.name + (descriptor.id ? '#' + descriptor.id : '') + (descriptor.key ? '@' + descriptor.key : ''));
    return () => {};
  },
};

const layoutStub = { selectPanel() {} };
const fakeScope = {
  slots: slotApi,
  locale: { register() { return () => {}; }, bind: () => (key) => key, t: (key) => key },
  modelDirectories: { directoryFor: () => ({ store: {} }) },
  get: (key) => (key === 'layout' ? layoutStub : undefined),
  effect(fn) { const dispose = fn(); void dispose; return () => {}; },
  inject(deps, callback) { callback(fakeScope); },
  logger: { info() {}, warn() {}, error() {} },
  get: (key) => (key === 'layout' ? layoutStub : undefined),
};

try {
  exportsValue.apply(fakeScope);
} catch (error) {
  console.error('[FAIL] apply() 抛错：', error);
  process.exit(1);
}

console.log('注册点：');
for (const row of registrations) console.log('  -', row);
// 侧栏额度卡片已按需求下线；中栏仪表盘保留 —— 它是网关状态与额度总览的落点。
const expected = ['main', 'settings.section', 'settings.models.provider-card', 'conversation.composer.dock', 'conversation.input.right'];
const missing = expected.filter((want) => !registrations.some((row) => row.startsWith(want)));
const sidebarStillThere = registrations.some((row) => row.startsWith('sidebar.footer.action'));
console.log(missing.length === 0 && !sidebarStillThere
  ? '[OK] 五个注册点全部落地，侧栏卡片已移除'
  : `[WARN] 缺注册点：${missing.join(', ') || '（无）'}${sidebarStillThere ? ' · 侧栏卡片仍在' : ''}`);
console.log(`样式表注入：${[...styleTags.keys()].join(', ') || '（无）'}`);
