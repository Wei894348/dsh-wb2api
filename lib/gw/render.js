/**
 * 把各种状态对象渲染成给人看的纯文本（斜杠命令回显 / 日志复用）。
 *
 * 全文件无网络无 IO、不 import 任何模块：输入什么就输出什么，方便单测直接比对字符串。
 * 渲染约定见各函数上方注释，其中两条是踩过坑的硬规则：
 *   - 账号池为空必须写成「账号池为空」，不能写「可用 0/0」；
 *   - 网关侧取不到的字段不要回落成 0。
 */

const STATE_LABELS = {
  stopped: '已停止',
  external: '外部实例（非本插件启动）',
  starting: '启动中',
  running: '运行中',
  unhealthy: '异常（进程在但不可服务）',
  failed: '启动失败',
};

/** stderr 最多回显的尾部字符数：再多就刷屏了，且斜杠命令输出有长度上限。 */
const STDERR_TAIL = 2000;

/** uid 短码：只取前 8 位，够区分又不至于把整串 token 打进日志。 */
export function shortUid(uid) {
  if (uid == null) return '';
  return String(uid).trim().slice(0, 8);
}

/**
 * 紧凑 duration：1h20m / 3m20s / 45s。
 * <=0 或非法一律返回 '' —— 冷却已过就别再显示「冷却 0s」，
 * 那会被读成「还在冷却」，语义正好反了。
 */
export function formatRemaining(seconds) {
  const total = Math.floor(Number(seconds));
  if (!Number.isFinite(total) || total <= 0) return '';
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h${m}m`;
  if (m > 0) return `${m}m${s}s`;
  return `${s}s`;
}

/** 从 live（Map / 数组 / 以 uid 为键的对象）里挑出该账号的实时侧信息。 */
function pickLive(account, live) {
  if (!live || !account) return null;
  const uid = account.uid != null ? account.uid : account.id;
  if (uid == null) return null;
  const key = String(uid);
  if (typeof live.get === 'function') return live.get(key) || live.get(uid) || null;
  if (Array.isArray(live)) {
    return live.find((x) => x && String(x.uid != null ? x.uid : x.id) === key) || null;
  }
  if (typeof live === 'object') return live[key] || null;
  return null;
}

/** 冷却剩余秒数，兼容多种上游字段名。 */
function coolingSeconds(live) {
  if (!live) return null;
  const direct = live.cooling != null ? live.cooling : live.coolingSeconds;
  if (direct != null) return Number(direct);
  if (live.cooldownUntil != null) {
    const until = Number(live.cooldownUntil);
    // 上游可能给秒也可能给毫秒，量级判断一下，别把秒当毫秒算出一个天文数字。
    const ms = until > 1e12 ? until : until * 1000;
    return (ms - Date.now()) / 1000;
  }
  return null;
}

/**
 * 单行账号描述：文件侧的 enabled 与网关侧的 credits/disabled/cooling 合并展示。
 *
 * 关键：**网关侧取不到就不显示积分，绝不写 0**。
 * 「查不到」和「额度用完了」是两件完全不同的事，统一渲染成 0 会让用户误以为
 * 账号已耗尽、跑去删号重登，而真实原因可能只是 /status 没拉到。
 */
export function describeAccount(account, live) {
  const a = account || {};
  const uid = shortUid(a.uid != null ? a.uid : a.id) || '(无 uid)';
  const nickname = a.nickname || a.name || '(未命名)';

  const l = pickLive(a, live);
  // 网关侧的 disabled 优先（它是权威运行态），取不到才回落到文件侧的 enabled。
  const disabled = l && typeof l.disabled === 'boolean' ? l.disabled : a.enabled === false;

  const parts = [uid, nickname, disabled ? '禁用' : '启用'];

  if (l) {
    const credits = Number(l.credits != null ? l.credits : l.balance);
    if (Number.isFinite(credits)) parts.push(`积分 ${credits}`);

    const cooling = formatRemaining(coolingSeconds(l));
    if (cooling) parts.push(`冷却 ${cooling}`);

    if (l.error) parts.push(`错误 ${l.error}`);
  }

  return parts.join('  ');
}

/**
 * 多行账号清单。
 * total === 0 时明确写「账号池为空」：空数组和「有账号但都不可用」要分开表达，
 * 后者是配置问题，前者是还没登录。
 */
export function renderAccountSection(authDir, accounts, live) {
  const list = Array.isArray(accounts) ? accounts : [];
  const lines = [`账号目录: ${authDir || '(未配置)'}`];

  if (list.length === 0) {
    lines.push('  账号池为空：还没有任何账号，请先登录。');
    return lines.join('\n');
  }

  list.forEach((account, i) => {
    lines.push(`  ${String(i + 1)}. ${describeAccount(account, live)}`);
  });
  return lines.join('\n');
}

/**
 * 账号数摘要行。
 * healthy 是「可用账号数」（能真正接请求的那些），不是进程存活标记。
 * total === 0 → 「账号池为空」，避免渲染成「可用 0/0」——那串数字会被读成
 * 「网关没跑起来 / 一个都没探活」，而真相只是用户还没登录过。
 */
function renderAccountSummary(status, accounts) {
  const list = Array.isArray(accounts) ? accounts : [];
  const total = list.length;
  if (total === 0) return '账号: 账号池为空（尚未登录任何账号）';

  const healthy = status && status.health ? Number(status.health.healthy) : NaN;
  if (Number.isFinite(healthy)) return `账号: 可用 ${healthy}/${total}`;
  // 网关没上报健康数时只报总数，不硬凑 0。
  return `账号: 共 ${total} 个（可用数未知）`;
}

/** realm 可服务性：cn / global，两者独立，一个能用一个不能用是常态。 */
function renderRealmLines(status) {
  const realms = status && (status.realms || (status.health && status.health.realms));
  if (!realms || typeof realms !== 'object') return [];

  const keys = Object.keys(realms);
  if (keys.length === 0) return [];

  const parts = keys.map((key) => {
    const r = realms[key] || {};
    const servable = r.servable === true || r.ok === true || r.available === true;
    const reason = r.reason ? `（${r.reason}）` : '';
    return `${key} ${servable ? '✓' : '✗'}${reason}`;
  });
  return [`可服务: ${parts.join('  ')}`];
}

function listenAddress(status) {
  if (!status) return '';
  if (status.listen) return String(status.listen);
  if (status.addr) return String(status.addr);
  if (status.baseUrl) return String(status.baseUrl);
  if (status.host && status.port) return `${status.host}:${status.port}`;
  if (status.port) return `127.0.0.1:${status.port}`;
  return '';
}

/** 从 status 里找实时账号信息（Map / 数组 / 对象都行），找不到就 null。 */
function liveFromStatus(status) {
  if (!status) return null;
  const cand = status.liveAccounts || status.accounts || (status.health && status.health.accounts);
  // status.accounts 在别处可能是个数字（账号总数），数字不能当实时清单用。
  if (cand && (typeof cand === 'object' || Array.isArray(cand))) return cand;
  return null;
}

/**
 * 整体状态渲染。入参缺字段就少输出几行，不编造内容。
 */
export function renderStatus({ status, accounts, models, authDir, portWarning } = {}) {
  const s = status || {};
  const state = s.state || 'stopped';
  const lines = [`网关: ${STATE_LABELS[state] || state}`];

  const addr = listenAddress(s);
  if (addr) lines.push(`监听: ${addr}`);

  lines.push(renderAccountSummary(s, accounts));
  lines.push(...renderRealmLines(s));

  const n = Number(models);
  lines.push(Number.isFinite(n) ? `模型: ${n} 个` : '模型: 未同步');

  lines.push(renderAccountSection(authDir, accounts, liveFromStatus(s)));

  // 端口被别的进程占用是高频坑，单独给一行警告，别混在状态里被忽略。
  if (portWarning) lines.push(`⚠ ${portWarning}`);

  const stderr = s.recentStderr || s.stderr;
  if (typeof stderr === 'string' && stderr.trim()) {
    const tail = stderr.slice(-STDERR_TAIL);
    lines.push(`最近 stderr（尾部 ${tail.length} 字符）:`);
    lines.push(
      tail
        .split('\n')
        .map((line) => `  | ${line}`)
        .join('\n'),
    );
  }

  return lines.join('\n');
}

/** 启动成功后的一句话摘要（含可用账号数与监听地址），给成功回显用。 */
export function renderReadySummary(status) {
  const s = status || {};
  const healthy = s.health ? Number(s.health.healthy) : NaN;
  const count = Number.isFinite(healthy) ? `可用账号 ${healthy} 个` : '可用账号数未知';
  const addr = listenAddress(s);
  return addr ? `网关已就绪：${count}，监听 ${addr}` : `网关已就绪：${count}`;
}

export default {
  renderStatus,
  renderReadySummary,
  renderAccountSection,
  describeAccount,
  formatRemaining,
  shortUid,
};
