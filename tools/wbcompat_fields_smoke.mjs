/**
 * 字段映射冒烟：把宿主的真实字段喂给 shim 的 buildDocument，验证
 * 「签到分组」与「模型倍率徽章」这两块是**数据驱动的原样界面**，不需要额外画控件。
 *
 * 只加载 client/wbcompat-shim.js（它是独立 IIFE，构建时被原样内联进 client.js），
 * 用假 window 跑，不碰网络、不碰宿主。
 *
 * 用法：node tools/wbcompat_fields_smoke.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const shim = readFileSync(join(REPO, 'client', 'wbcompat-shim.js'), 'utf8');

/** localStorage 假件（shim 读偏好 + 写回）。 */
const store = new Map();
const localStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => { store.set(key, String(value)); },
};

const sandbox = {
  console,
  JSON, Number, String, Math, Date, Map, Set, Array, Object, Promise, RegExp, Intl,
  Response,
  setTimeout, clearTimeout, setInterval, clearInterval,
  atob,
  fetch: async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
  window: {
    localStorage,
    fetch: async () => new Response('{}', { status: 200 }),
    open() {},
    atob,
  },
};
sandbox.window.window = sandbox.window;
vm.createContext(sandbox);
vm.runInContext(shim, sandbox, { filename: 'wbcompat-shim.js' });

const api = sandbox.window.__wb2apiShim;
if (api === undefined || typeof api.buildDocument !== 'function') {
  console.error('[FAIL] shim 没有暴露 buildDocument');
  process.exit(1);
}

/** 宿主 /dsh-wb2api/state 的形状（截取与本用例相关的字段）。 */
const state = {
  gateway: { running: true, baseURL: 'http://127.0.0.1:7863' },
  accounts: [
    { file: 'workbuddy-aaa.json', uid: 'uid-cn-1', nickname: 'Shantanu', realm: 'cn', domain: 'www.codebuddy.cn', expiresAt: 1795183200, expired: false, disabled: false, mtime: 1792764000000 },
    { file: 'workbuddy-bbb.json', uid: 'uid-cn-2', nickname: '快乐不打烊', realm: 'cn', domain: 'www.workbuddy.cn', expiresAt: 1795442403, expired: false, disabled: false, mtime: 1793023203000 },
    { file: 'workbuddy-ccc.json', uid: 'uid-global-1', nickname: 'wei', realm: 'global', domain: 'www.workbuddy.ai', expiresAt: 1820628084, expired: false, disabled: false, mtime: 1793023203000 },
  ],
};

/** 宿主 /dsh-wb2api/credits 的形状。 */
const credits = {
  total: 1300,
  todayUsed: 12,
  unlimited: 0,
  accounts: [
    { file: 'workbuddy-aaa.json', uid: 'uid-cn-1', state: 'ok', total: 300, segments: [{ remaining: 300, total: 500, source: 'CodeBuddy个人版', packageCode: 'P1' }] },
    { file: 'workbuddy-bbb.json', uid: 'uid-cn-2', state: 'ok', total: 1000, segments: [{ remaining: 1000, total: 1000, source: 'Bonus Pack', packageCode: 'P2' }] },
    { file: 'workbuddy-ccc.json', uid: 'uid-global-1', state: 'ok', total: 217.52, segments: [{ remaining: 217.52, total: 220, source: 'Free Plan Subscription', packageCode: 'P3' }] },
  ],
};

/** 宿主 /dsh-wb2api/models 的新形状（带 creditsMult / displayName / description）。 */
const models = [
  { id: 'cn:glm-5.3', name: 'GLM-5.3', displayName: 'GLM-5.3', description: '旗舰模型', contextLength: 1000000, maxOutputTokens: 64000, supportsImages: true, creditsMult: '0.79x' },
  { id: 'cn:hy3', name: 'Hy3', displayName: 'Hy3', description: '', contextLength: 192000, maxOutputTokens: 64000, supportsImages: true, creditsMult: '0.00x' },
  { id: 'cn:auto', name: 'Auto', displayName: 'Auto', description: '', contextLength: 256000, maxOutputTokens: 32000, supportsImages: true },
  { id: 'global:gpt-5.3-codex', name: 'GPT-5.3-Codex', displayName: 'GPT-5.3-Codex', description: '', contextLength: 272000, maxOutputTokens: 32000, supportsImages: true, creditsMult: '1.25x' },
];

/** 宿主 /dsh-wb2api/checkin-status 的形状（accountId + uid 同值）。 */
const checkin = {
  auto: true,
  day: '2026-10-26',
  rows: [
    { accountId: 'uid-cn-1', uid: 'uid-cn-1', day: '2026-10-26', atMs: 1793030255659, state: 'already', reason: '今天已签到，请明天再来' },
    { accountId: 'uid-cn-2', uid: 'uid-cn-2', day: '2026-10-25', atMs: 1792943855659, state: 'failed', reason: '计费接口 HTTP 401' },
    { accountId: 'uid-global-1', uid: 'uid-global-1', state: 'skipped', reason: '签到活动未开启或已过期' },
    { accountId: 'uid-not-in-pool', uid: 'uid-not-in-pool', day: '2026-10-26', state: 'checked-in' },
  ],
};

const data = { state, credits, models, checkin };
const cn = api.buildDocument(data, 'workbuddy');
const ai = api.buildDocument(data, 'workbuddy-ai');

const failures = [];
const check = (label, condition, detail) => {
  if (condition) return;
  failures.push(label + (detail === undefined ? '' : ' → ' + detail));
};

// --- 模型倍率 ---
const glm = cn.models.find((row) => row.id === 'cn:glm-5.3');
check('CN 模型带倍率', glm !== undefined && glm.credits === 'x0.79', glm && glm.credits);
check('CN 模型带显示名', glm !== undefined && glm.name === 'GLM-5.3', glm && glm.name);
const hy3 = cn.models.find((row) => row.id === 'cn:hy3');
check('0 倍率标为免费', hy3 !== undefined && hy3.free === true, hy3 && String(hy3.free));
const autoModel = cn.models.find((row) => row.id === 'cn:auto');
check('无倍率时不带 credits 键', autoModel !== undefined && autoModel.credits === undefined, autoModel && String(autoModel.credits));
check('CN 只出 cn: 前缀模型', cn.models.length === 3, String(cn.models.length));
check('AI 只出 global: 前缀模型', ai.models.length === 1 && ai.models[0].credits === 'x1.25', JSON.stringify(ai.models.map((m) => m.credits)));

// --- 签到 ---
check('CN 文档带签到分组', cn.checkin !== undefined);
check('签到 auto 透传', cn.checkin && cn.checkin.auto === true);
check('CN 只带自己池子的行', cn.checkin && cn.checkin.rows.length === 2, cn.checkin && String(cn.checkin.rows.length));
const row1 = cn.checkin && cn.checkin.rows.find((row) => row.accountId === 'workbuddy-aaa.json');
check('签到行按文件名 join', row1 !== undefined);
check('签到行 state 透传', row1 !== undefined && row1.state === 'already', row1 && row1.state);
check('签到行 day 透传', row1 !== undefined && row1.day === '2026-10-26', row1 && row1.day);
check('签到行 reason 透传', row1 !== undefined && typeof row1.reason === 'string' && row1.reason !== '');
const failedRow = cn.checkin && cn.checkin.rows.find((row) => row.accountId === 'workbuddy-bbb.json');
check('失败行 state=failed', failedRow !== undefined && failedRow.state === 'failed', failedRow && failedRow.state);
check('AI 文档只带自己的签到行', ai.checkin && ai.checkin.rows.length === 1 && ai.checkin.rows[0].accountId === 'workbuddy-ccc.json', ai.checkin && JSON.stringify(ai.checkin.rows));

// --- 凭证 / 账号 ---
check('账号 id 用文件名（供 enable/remove 回传）', cn.accounts.accounts[0].id === 'workbuddy-aaa.json', cn.accounts.accounts[0].id);
check('账号积分对得上', cn.accounts.accounts[0].credits === 300, String(cn.accounts.accounts[0].credits));

console.log('CN 模型:', cn.models.map((m) => m.id + (m.credits ? ' [' + m.credits + (m.free ? ',free' : '') + ']' : '')).join(' | '));
console.log('AI 模型:', ai.models.map((m) => m.id + (m.credits ? ' [' + m.credits + ']' : '')).join(' | '));
console.log('CN 签到:', JSON.stringify(cn.checkin));
console.log('AI 签到:', JSON.stringify(ai.checkin));

if (failures.length > 0) {
  console.error('\n[FAIL] ' + failures.length + ' 项不符：');
  for (const line of failures) console.error('  -', line);
  process.exitCode = 1;
} else {
  console.log('\n[OK] 倍率 / 签到 / 账号映射全部符合参考界面的数据契约');
}
