/**
 * 「一键就绪」编排。
 *
 * 把「有二进制 → 有运行目录 → 有账号 → 网关在跑 → 模型已同步」这条链一次性走完，
 * 每走一步就往报告里追加一条 { key, label, ok, detail }，方便斜杠命令逐行回显。
 *
 * 设计取舍（为什么这么写）：
 * 1. 依赖全部由构造入参注入，本文件不 import 任何 IO 模块 —— 单测可以直接塞桩函数，
 *    不用真的去建目录 / 下载二进制 / 起进程。
 * 2. 「账号数为 0」是**可继续**的状态，不是失败：用户在第一次使用时必然是 0 个账号，
 *    如果这里中断，后面「启动网关」「同步模型」就永远不会执行，用户会卡在一个
 *    「既没启网关也没法登录」的死状态。所以只置 needLogin = true，链继续走完。
 * 3. 真正的失败（抛错）才中止：后续步骤不再执行，但**已完成**的步骤保留在 steps 里，
 *    否则用户看不到「到底第几步挂了」，只看到一个光秃秃的错误。
 */

/** 步骤顺序即执行顺序，标签直接用于回显。 */
const STEP_PLAN = [
  { key: 'runtime', label: '运行目录', dep: 'ensureRuntime' },
  { key: 'binary', label: '网关程序', dep: 'ensureBinary' },
  { key: 'accounts', label: '账号池', dep: 'countAccounts' },
  { key: 'gateway', label: '启动网关', dep: 'startGateway' },
  { key: 'catalog', label: '同步模型', dep: 'refreshCatalog' },
];

const MARK_OK = '✓';
const MARK_FAIL = '✗';

/** 计划步骤数，报告里即使中途失败也能显示成 [2/5] 而不是 [2/2]。 */
export const BOOTSTRAP_STEP_COUNT = STEP_PLAN.length;

function errorMessage(err) {
  if (!err) return '未知错误';
  if (err.message) return String(err.message);
  return String(err);
}

/**
 * ready 的判定：状态是 running/external 且 health.healthy > 0。
 * 为什么要求 healthy > 0 —— 进程活着不等于能服务：账号全在冷却或被禁用时，
 * 网关照样在监听端口，但每个请求都会 4xx。把这种状态报成「已就绪」会让用户
 * 以为装好了，实际一发请求就失败。health 缺失时同样不算就绪（无法确认，就别撒谎）。
 */
function isServing(status) {
  if (!status) return false;
  const state = status.state;
  if (state !== 'running' && state !== 'external') return false;
  const healthy = status.health && status.health.healthy;
  return typeof healthy === 'number' && healthy > 0;
}

/** 各步骤成功时的 detail 文案；入参是该步依赖函数的返回值。 */
const DETAIL = {
  runtime: (res) => {
    if (!res) return '已就绪';
    // configCreated 为真说明是首次初始化，值得单独提示一句，用户能看出「刚生成了配置」。
    return res.configCreated ? '已就绪（新建 config.json）' : '已就绪';
  },
  binary: (res) => {
    if (!res || !res.path) return '已就绪';
    return res.downloaded ? `已就绪（已下载 ${res.path}）` : `已就绪（${res.path}）`;
  },
  accounts: (count) => {
    const n = Number(count) || 0;
    // 0 个账号照样算 ok，文案里把「还能继续」说清楚，避免被当成错误。
    return n > 0 ? `${n} 个启用账号` : '暂无启用账号（不阻断，稍后需登录）';
  },
  gateway: (status) => {
    if (!status) return '已启动';
    const addr = status.listen || status.addr || (status.port ? `127.0.0.1:${status.port}` : '');
    return addr ? `${status.state} · ${addr}` : String(status.state || '已启动');
  },
  catalog: (res) => {
    const n = res && Number(res.models);
    return Number.isFinite(n) ? `${n} 个模型` : '已同步';
  },
};

export class BootstrapRunner {
  constructor(deps = {}) {
    this.ensureRuntime = deps.ensureRuntime;
    this.ensureBinary = deps.ensureBinary;
    this.countAccounts = deps.countAccounts;
    this.startGateway = deps.startGateway;
    this.refreshCatalog = deps.refreshCatalog;
    this.logger = deps.logger || {};
  }

  /** 调用注入的依赖；缺失时抛错，让兜底逻辑统一走「该步失败」。 */
  async #call(dep, ctx) {
    const fn = this[dep];
    if (typeof fn !== 'function') throw new Error(`缺少依赖 ${dep}`);
    // 每个依赖拿到的入参不同：只有 ensureBinary 需要 allowDownload，
    // realm 只透传给启动与同步（它们可能需要按区服拉取目录）。
    if (dep === 'ensureBinary') return fn({ allowDownload: ctx.allowDownload });
    if (dep === 'startGateway' || dep === 'refreshCatalog') return fn({ realm: ctx.realm });
    return fn();
  }

  #log(level, msg) {
    const fn = this.logger[level];
    if (typeof fn === 'function') fn(msg);
  }

  /** 跑单步并把异常收敛成 ok:false，绝不往外抛 —— 抛了就丢掉已完成的步骤。 */
  async #execute(def, ctx) {
    try {
      const value = await this.#call(def.dep, ctx);
      const detail = DETAIL[def.key](value);
      this.#log('info', `[${def.label}] ${detail}`);
      return { step: { key: def.key, label: def.label, ok: true, detail }, value };
    } catch (err) {
      const detail = errorMessage(err);
      this.#log('error', `[${def.label}] ${detail}`);
      return { step: { key: def.key, label: def.label, ok: false, detail }, value: null };
    }
  }

  async run({ realm, allowDownload } = {}) {
    const ctx = { realm, allowDownload };
    const steps = [];
    let needLogin = false;
    let status = null;
    let models = null;
    let message = '';

    for (let i = 0; i < STEP_PLAN.length; i += 1) {
      const def = STEP_PLAN[i];
      const { step, value } = await this.#execute(def, ctx);
      steps.push(step);

      if (!step.ok) {
        // 中止：后续步骤不再执行，但 steps 里已完成的记录原样保留。
        message = `第 ${i + 1}/${STEP_PLAN.length} 步「${def.label}」失败：${step.detail}`;
        break;
      }

      if (def.key === 'accounts') {
        const n = Number(value) || 0;
        if (n === 0) {
          needLogin = true;
          this.#log('warn', '账号池为空，标记 needLogin，继续后续步骤');
        }
      } else if (def.key === 'gateway') {
        status = value;
      } else if (def.key === 'catalog') {
        models = value && Number(value.models);
      }
    }

    const ready = isServing(status);
    if (!message) {
      if (needLogin) message = ready ? '网关已就绪，但账号池为空，请先登录账号' : '网关未进入可服务状态，且账号池为空，请先登录账号';
      else message = ready ? '一键就绪完成' : '流程已跑完，但网关仍未进入可服务状态';
    }

    return { steps, ready, needLogin, models, message };
  }
}

/** 纯文本宽度：CJK 当 2 列，否则 [1/5] 后面的中文标签会参差不齐。 */
function displayWidth(text) {
  let w = 0;
  for (const ch of String(text)) {
    const code = ch.codePointAt(0);
    const wide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6);
    w += wide ? 2 : 1;
  }
  return w;
}

function padTo(text, width) {
  const pad = Math.max(0, width - displayWidth(text));
  return String(text) + ' '.repeat(pad);
}

/**
 * 渲染成多行纯文本给斜杠命令用：
 *   [1/5] 运行目录  ✓ 已就绪（新建 config.json）
 *   [2/5] 网关程序  ✗ 未找到二进制且已禁止下载
 */
export function renderBootstrapReport(result) {
  const res = result || {};
  const steps = Array.isArray(res.steps) ? res.steps : [];
  // 用计划数兜底：中途失败时仍显示 [2/5]，让用户知道还剩几步没跑。
  const total = Math.max(steps.length, BOOTSTRAP_STEP_COUNT);
  const labelWidth = STEP_PLAN.reduce((w, s) => Math.max(w, displayWidth(s.label)), 0);

  const lines = steps.map((step, i) => {
    const mark = step.ok ? MARK_OK : MARK_FAIL;
    const label = padTo(step.label || STEP_PLAN[i]?.key || '', labelWidth);
    return `[${i + 1}/${total}] ${label}  ${mark} ${step.detail || ''}`;
  });

  if (res.needLogin) lines.push('! 账号池为空：请先添加 / 登录账号，再执行同步。');
  if (res.ready) lines.push(`${MARK_OK} 已就绪：网关可服务且有可用账号。`);
  else lines.push(`${MARK_FAIL} 未就绪：网关尚未进入可服务状态。`);
  if (res.message) lines.push(`→ ${res.message}`);

  return lines.join('\n');
}

export default BootstrapRunner;
