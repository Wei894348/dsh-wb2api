/**
 * wbcompat 冒烟：在 Node 里加载 client/wbcompat-shim.js，用真实宿主数据拼出
 * WorkBuddyWebStatus 文档，检查两个变体（cn / global）的结构是否齐全。
 *
 * 用法：node tools/wbcompat_smoke.mjs [http://127.0.0.1:PORT]
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const shimPath = join(here, '..', 'client', 'wbcompat-shim.js');
const base = (process.argv[2] ?? 'http://127.0.0.1:41018').replace(/\/+$/u, '');
const PREFIX = '/plugins/dsh-plugin-wb2api-ui';

const store = new Map();
const baseFetch = (input, init) => fetch(new URL(typeof input === 'string' ? input : input.url, base), init);

const sandbox = {
  console, JSON, Number, String, Math, Date, Map, Array, Object, Response, Promise, URL,
  setTimeout, atob, TextEncoder, TextDecoder, Error, RegExp,
  window: {
    fetch: baseFetch,
    localStorage: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => { store.set(key, String(value)); },
      removeItem: (key) => { store.delete(key); },
    },
    open: () => undefined,
    atob,
  },
  fetch: baseFetch,
};
vm.createContext(sandbox);
vm.runInContext(readFileSync(shimPath, 'utf8'), sandbox, { filename: 'wbcompat-shim.js' });
sandbox.fetch = sandbox.window.fetch;

async function getJson(url, init) {
  const response = await sandbox.window.fetch(url, init);
  return { status: response.status, body: await response.json() };
}

function summarise(label, doc) {
  const accounts = doc?.accounts?.accounts ?? [];
  console.log(`\n=== ${label} ===`);
  console.log('status      :', doc.status, doc.reason ? `(${doc.reason})` : '');
  console.log('nickname    :', doc.nickname ?? '—', '| domain:', doc.domain ?? '—');
  console.log('expiresAt   :', doc.expiresAt ? new Date(doc.expiresAt).toISOString() : '—');
  console.log('credits     :', doc.credits ? `${doc.credits.total} (${doc.credits.accounts.length} 包)` : '—',
    doc.credits?.unlimited ? '[unlimited]' : '');
  console.log('creditsError:', doc.creditsError ?? '—');
  console.log('models      :', Array.isArray(doc.models) ? doc.models.length : '—',
    Array.isArray(doc.models) && doc.models.length > 0 ? `e.g. ${doc.models.slice(0, 3).map((m) => m.id).join(', ')}` : '');
  console.log('accounts    :', accounts.length, '| primary:', doc.accounts?.primary ?? '—');
  for (const account of accounts) {
    const bits = [
      account.enabled ? 'on' : 'off',
      account.available ? 'available' : 'unavailable',
      account.credits === undefined ? 'credits=—' : `credits=${account.credits}`,
      account.creditsTotal === undefined ? '' : `/${account.creditsTotal}`,
      account.creditsError ? `err=${account.creditsError.slice(0, 60)}` : '',
      account.sessionDead ? 'DEAD' : '',
    ].filter(Boolean);
    console.log('   -', account.name, `[${account.id}]`, bits.join(' '));
  }
  console.log('probeKey    :', doc.probeKey ?? '—');
  const prefKeys = ['sidebarCreditStyle', 'sidebarCreditVisible', 'composerCreditVisible', 'probeControlVisible', 'useMaximumContextWindow'];
  const stated = prefKeys.filter((key) => doc[key] !== undefined);
  console.log('prefs stated:', stated.length > 0 ? stated.join(', ') : '—（走默认）');
}

const cn = await getJson(`${PREFIX}/status`);
summarise('CN  status', cn.body);
const ai = await getJson(`${PREFIX}/ai/status`);
summarise('AI  status', ai.body);

// 写动作：只测不产生费用的偏好写入 + 被拒绝的动作文案。
const prefWrite = await getJson(`${PREFIX}/ai/probe`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'X-WorkBuddy-Probe-Key': cn.body.probeKey ?? '' },
  body: JSON.stringify({ action: 'set-sidebar-credit-visible', enabled: true }),
});
console.log('\nprobe set-sidebar-credit-visible ->', prefWrite.status, JSON.stringify(prefWrite.body));

const afterPref = await getJson(`${PREFIX}/status`);
console.log('pref echoed back              ->', JSON.stringify(afterPref.body.sidebarCreditVisible));

const badLabel = await getJson(`${PREFIX}/accounts`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'X-WorkBuddy-Probe-Key': cn.body.probeKey ?? '' },
  body: JSON.stringify({ action: 'label', id: 'x', label: 'y' }),
});
console.log('accounts label (unsupported)  ->', JSON.stringify(badLabel.body));

// 未命中的 URL 必须原样透传。
const passthrough = await sandbox.window.fetch('/dsh-wb2api/models');
console.log('passthrough /dsh-wb2api/models ->', passthrough.status);
