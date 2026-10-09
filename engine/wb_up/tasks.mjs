/**
 * WorkBuddy 上游「成长任务 / 开学季 / 夜猫子」接口，含支撑这些环节的编排逻辑。
 *
 * 移植口径：
 *   - 路径、请求头、body 字段名、响应字段名、错误语义照抄 Go；Go 的 struct tag 即 JSON 字段名。
 *   - Go 的 doJSON 在「HTTP 非 2xx」与「信封 code != 0」两种情况下抛 *Error：
 *     JS 侧由 doJSON() 复刻，抛出的 Error 带 .status（HTTP 码）/ .code（业务码，envelope 设置）。
 *   - int64/int → number，map[string]any → 普通对象，HTTP 非 2xx 不静默。
 *   - 仅一处已知偏差：Go 的 Task 视图带 omitempty（只影响 JSON 序列化省略），
 *     本模块恒输出全部键（零值即 Go 的零值），便于调用方按固定 shape 取值。
 */
import { randomUUID } from 'node:crypto';
import {
  BASES, isGlobal, baseOf, commonHeaders, billingHeaders, send, envelope, sleep,
} from './core.mjs';
import {
  chatStream, reportChatActivityModel, reportDesktopEvent,
  desktopChatSequence, desktopChatWithExpert,
} from './events.mjs';

// ── tasks.go 路径常量与口径常量（与 scripts/task_common.py 对齐）───────────────
export const TASKS_LIST_PATH = '/v2/activity/growth/tasks';
export const TASKS_ACCEPT_PATH = '/v2/activity/growth/tasks/accept';
/** 领奖路径（任务码在**路径**里、无 body）：mp 走 chat 域，web 走 web 域。 */
export const TASKS_CLAIM_PATH = '/activity/growth/tasks/{task_code}/claim';
/** 已废弃路径（CLI 域 copilot.tencent.com，task_code 放 body）：上游不存在，勿用。 */
export const TASKS_CLAIM_LEGACY_PATH = '/v2/activity/growth/tasks/reward/claim';
/** 小程序口径头值：mp 限定任务的列表/accept/claim 全链路要求该头。 */
export const MP_PLATFORM = 'miniprogram';

// ── school.go 常量 ───────────────────────────────────────────────────────────
export const SCHOOL_BASE = '/portal/activity/school';
export const MP_REPORT_PATH = '/v2/report';
export const SCHOOL_OPEN_DAY_ACTIVITY_ID = 'school_open_day_2026';
/** 小程序埋点公共指纹里的固定 machineId（照抄 Go 的 mpEventBase）。 */
export const MP_EVENT_MACHINE_ID = '0655736a-607f-4d9d-b430-58176ee9a090';
/** ReportMPEvent 恒走 CN billing 域（Go 直接使用 c.BillingBaseCN，不按 realm 分流）。 */
export const MP_REPORT_BASE = BASES.cn.billing;

// ── 节流 / 轮询参数 ──────────────────────────────────────────────────────────
export const CLAIM_POLL_ATTEMPTS = 4;
export const CLAIM_POLL_GAP_MS = 3000;
export const MP_ACTION_GAP_MS = 2000;
export const SCHOOL_POLL_LOOPS = 3;
export const SCHOOL_POLL_GAP_MS = 2500;
export const ACTIVITY_ACCOUNT_DELAY_MS = 800;
export const REQUEST_TIMEOUT_MS = 30000;

/** 小程序口径专属下发的成长任务（默认列表不出现，accept/claim 也要求 mp 头）。 */
export const MP_TASK_CODES = new Set(['school_season', 'Sequential_Tasks_1']);

/** isMPTaskCode 报告任务是否小程序口径专属（决定回读/接受/领奖走 mp 变体）。 */
export function isMPTaskCode(code) {
  return MP_TASK_CODES.has(String(code ?? ''));
}

// ── doJSON 的 JS 复刻 ────────────────────────────────────────────────────────

function truncate(s, n) {
  const t = String(s ?? '');
  return t.length > n ? t.slice(0, n) : t;
}

/**
 * goDoJSON 复刻：发请求 → 非 2xx 抛 Error（带 .status）→ 解 {code,msg,data} 信封
 * （envelope：code!=0 抛 Error(msg)）→ 返回 data。json 解析失败也抛错。
 */
async function doJSON(url, { method = 'GET', headers = {}, body, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const res = await send(url, { method, headers, body, timeoutMs });
  if (res.status >= 400) {
    const err = new Error(`upstream http ${res.status}: ${truncate(res.text, 200)}`);
    err.status = res.status;
    err.body = res.text;
    throw err;
  }
  if (res.json === undefined) {
    throw new Error(`parse failed: invalid JSON (body: ${truncate(res.text, 120)})`);
  }
  return envelope(res.json);
}

/** 取错误上的 HTTP 状态（复刻 Go `ue.Status`）。 */
function httpStatusOf(err) {
  return err && typeof err.status === 'number' ? err.status : 0;
}

// ── tasks.go：growth 域请求封装 ──────────────────────────────────────────────

/** 对应 Go `(*Client).growthJSON`：chat 域 + BillingHeaders 发请求并解信封。 */
async function growthJSON(a, method, path, body, { mp = false } = {}) {
  const headers = billingHeaders(a);
  if (mp) headers['X-Client-Platform'] = MP_PLATFORM; // growthJSONMP 叠加该头
  return doJSON(`${baseOf(a, 'chat')}${path}`, { method, headers, body });
}

// 对应 Go `parseGrowthTasks`：宽松解析 data.tasks[]（progress 两种形状都吃）。
function parseGrowthTasks(data) {
  const resp = data && typeof data === 'object' ? data : {};
  const tasks = Array.isArray(resp.tasks) ? resp.tasks : [];
  return tasks.map((t) => {
    const src = t && typeof t === 'object' ? t : {};
    let cur = Number(src.current ?? 0);
    let tgt = Number(src.target ?? 0);
    // progress 可能是 {current,target} 对象（实测口径），覆盖平铺字段。
    const pr = src.progress;
    if (pr && typeof pr === 'object') {
      const pc = Number(pr.current ?? 0);
      const pt = Number(pr.target ?? 0);
      if (pt > 0 || pc > 0) { cur = pc; tgt = pt; }
    }
    const claimed = src.accept_status === 'claimed';
    return {
      task_code: String(src.task_code ?? ''),
      title: String(src.title ?? ''),
      description: String(src.description ?? ''),
      task_desc: String(src.task_desc ?? ''),
      credit: Number(src.reward_credit ?? 0),   // 上游实际字段名带 reward_ 前缀
      energy: Number(src.reward_energy ?? 0),
      has_reward: src.has_reward === true,
      reward_buddy: src.reward_buddy === true,
      task_type: String(src.task_type ?? ''),
      tag: String(src.tag ?? ''),
      jump_url: String(src.jump_url ?? ''),
      locked: src.locked === true,
      target: tgt,
      current: cur,
      accept_status: String(src.accept_status ?? ''),
      status: String(src.status ?? ''),
      claimable: !claimed && tgt > 0 && cur >= tgt,
      claimed,
    };
  });
}

// 对应 Go `parseClaimReward`：解析领奖响应 data（already_claimed 由调用方决定是否用）。
function parseClaimReward(data) {
  const d = data && typeof data === 'object' ? data : {};
  return {
    alreadyClaimed: d.already_claimed === true,
    credit: Number(d.credit ?? 0),
    energy: Number(d.energy ?? 0),
  };
}

/** 对应 Go `(*Client).ListTasks`：拉取全量任务列表（默认口径，无端标记头）。 */
export async function listTasks(a) {
  const data = await growthJSON(a, 'GET', TASKS_LIST_PATH, undefined);
  return parseGrowthTasks(data);
}

/**
 * 对应 Go `(*Client).ListTasksMP`：小程序口径任务列表（X-Client-Platform: miniprogram）。
 * 实测 mp 列表是默认口径的**超集**，合并时调用方须按 task_code 去重。
 */
export async function listTasksMP(a) {
  const data = await growthJSON(a, 'GET', TASKS_LIST_PATH, undefined, { mp: true });
  return parseGrowthTasks(data);
}

/** 对应 Go `(*Client).AcceptTasks`：接受任务（POST {"task_codes":[...]}，幂等）。 */
export async function acceptTasks(a, taskCodes) {
  return growthJSON(a, 'POST', TASKS_ACCEPT_PATH, { task_codes: taskCodes });
}

/** 对应 Go `(*Client).AcceptTasksMP`：接受小程序限定任务（mp 头；缺头实测 task not found）。 */
export async function acceptTasksMP(a, taskCodes) {
  return growthJSON(a, 'POST', TASKS_ACCEPT_PATH, { task_codes: taskCodes }, { mp: true });
}

/**
 * 对应 Go `(*Client).ClaimReward`：Web 域领奖
 * POST {webBase}/activity/growth/tasks/<task_code>/claim（无 body，x-client-platform: web）。
 * 返回 {credit, energy}；already_claimed=true 时返回 0/0（幂等，不算错误）。
 */
export async function claimReward(a, taskCode) {
  const headers = {
    Authorization: `Bearer ${a?.accessToken ?? ''}`,
    Accept: 'application/json, text/plain, */*',
    'Content-Type': 'application/json',
    Origin: 'https://www.workbuddy.cn',
    Referer: 'https://www.workbuddy.cn/profile/growth-center',
    'x-client-platform': 'web',
  };
  const ua = commonHeaders(a)['User-Agent']; // Go: c.userAgent(a)，空则不发
  if (ua) headers['User-Agent'] = ua;
  if (a?.uid) headers['X-User-Id'] = a.uid;
  if (a?.enterpriseId) {
    headers['X-Enterprise-Id'] = a.enterpriseId;
    headers['X-Tenant-Id'] = a.enterpriseId;
  }
  if (a?.domain) headers['X-Domain'] = a.domain;

  const url = `${baseOf(a, 'web')}/activity/growth/tasks/${encodeURIComponent(taskCode)}/claim`;
  const data = await doJSON(url, { method: 'POST', headers });
  const r = parseClaimReward(data);
  if (r.alreadyClaimed) return { credit: 0, energy: 0 };
  return { credit: r.credit, energy: r.energy };
}

/**
 * 对应 Go `(*Client).ClaimRewardMP`：chat 域 /activity/growth/tasks/{code}/claim + mp 头；
 * HTTP 400 时降级 Web 域领奖端点（ClaimReward）。返回 {credit, energy}。
 */
export async function claimRewardMP(a, taskCode) {
  const headers = billingHeaders(a);
  headers['X-Client-Platform'] = MP_PLATFORM;
  const url = `${baseOf(a, 'chat')}/activity/growth/tasks/${encodeURIComponent(taskCode)}/claim`;
  let data;
  try {
    data = await doJSON(url, { method: 'POST', headers });
  } catch (err) {
    // chat 域对该路径 400（部分任务/租户形态）→ Web 域降级（已实测可领）。
    if (httpStatusOf(err) === 400) return claimReward(a, taskCode);
    throw err;
  }
  const r = parseClaimReward(data); // Go: parseClaimReward 忽略 already_claimed，原样返回
  return { credit: r.credit, energy: r.energy };
}

// ── panel/autotask.go + taskcenter.go：任务回读与 mp 闭环 ────────────────────

/** 对应 Go `taskProgressText`：任务进度文本（claimable/claimed 标注）。 */
export function taskProgressText(t) {
  if (!t) return '?';
  const prog = `${t.current}/${t.target}`;
  if (t.claimed) return `${prog}（已领取）`;
  if (t.claimable) return `${prog}（可领取）`;
  return prog;
}

/** 对应 Go `(*Panel).taskByCodeMP`：以小程序口径拉取任务列表并定位单个任务；未找到返回 null。 */
export async function taskByCodeMP(a, code) {
  const tasks = await listTasksMP(a);
  return tasks.find((t) => t.task_code === code) ?? null;
}

/**
 * 对应 Go `(*Panel).taskByCode`：默认口径定位任务；未找到且是已登记的 mp 码时回落 mp 列表。
 */
export async function taskByCode(a, code) {
  const tasks = await listTasks(a);
  const hit = tasks.find((t) => t.task_code === code);
  if (hit) return hit;
  if (isMPTaskCode(code)) return taskByCodeMP(a, code);
  return null;
}

/**
 * 对应 Go `(*Panel).taskByCodeWaiting`：回读任务，未达标则在有界预算内轮询等待
 * （上游异步计分，约 5-8s 才刷新进度）。
 */
export async function taskByCodeWaiting(a, code, {
  attempts = CLAIM_POLL_ATTEMPTS,
  gapMs = CLAIM_POLL_GAP_MS,
} = {}) {
  let t = await taskByCode(a, code);
  if (!t) return t;
  if (t.claimable || t.claimed) return t;
  for (let i = 1; i < attempts; i++) {
    await sleep(gapMs);
    let t2;
    try {
      t2 = await taskByCode(a, code);
    } catch {
      return t; // 轮询期间的查询失败不覆盖已拿到的结果
    }
    if (t2) {
      t = t2;
      if (t.claimable || t.claimed) return t;
    }
  }
  return t;
}

/**
 * 对应 Go `(*Panel).acceptWithVerifyMP`：accept 并回读验证登记生效（上游存在
 * 200+OK 但未真正登记的形态），未生效重试；返回是否确认生效。
 */
export async function acceptWithVerifyMP(a, code, {
  attempts = 2,
  gapMs = MP_ACTION_GAP_MS,
} = {}) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await acceptTasksMP(a, [code]);
    } catch {
      continue; // 尝试失败，进入下一轮
    }
    await sleep(gapMs);
    try {
      const t = await taskByCodeMP(a, code);
      if (t && t.accept_status && t.accept_status !== 'not_accepted') return true;
    } catch {
      // 回读失败按「未登记生效」处理
    }
  }
  return false;
}

/**
 * 对应 Go `(*Panel).runMPMiniChatTask`：mp 限定任务通用闭环
 * （mp 查询 → accept（带回读验证）→ mini chat 事件上报 → 回读 → 达标即领奖）。
 * withActivityId：school_season 必带开学季 activityId，Sequential_Tasks_1 不带。
 * 返回结果文本（与 Go 的 (string, error) 对应：致命错误抛 Error，其余以文本返回）。
 */
export async function runMPMiniChatTask(a, code, withActivityId, {
  mpGapMs = MP_ACTION_GAP_MS,
  pollGapMs = CLAIM_POLL_GAP_MS,
} = {}) {
  let t = await taskByCodeMP(a, code);
  if (!t) return 'mp 口径未下发该任务（活动可能已结束）';
  if (t.claimed) return '已领取';
  if (t.accept_status === 'not_accepted' || t.accept_status === '') {
    if (!await acceptWithVerifyMP(a, code)) {
      return 'accept 未登记生效（上游 200+OK 但未落账形态），待下次重试';
    }
  }
  // 已达标（含 completed 未领）：直接领奖。
  let target = t.target;
  if (target <= 0) target = 1;
  if (t.current >= target || t.accept_status === 'completed') {
    const { credit, energy } = await claimRewardMP(a, code);
    return `已领取奖励（+${credit}c +${energy}e）`;
  }
  // 判据上报：按差额补 mini chat 事件。
  const need = target - t.current;
  for (let i = 0; i < need; i++) {
    const conv = `wb2api-mp-${Date.now()}-${i}`;
    const ev = withActivityId ? schoolSeasonChatEvent(conv) : schoolChatTimesEvents(conv);
    try {
      await reportMPEvent(a, ev);
    } catch (err) {
      return `完成 ${i}/${need} 次上报后中断: ${err.message}`;
    }
    await sleep(mpGapMs);
  }
  // 回读（异步计分，紧凑版：两轮各隔 pollGap）。
  for (let i = 0; i < 2; i++) {
    await sleep(pollGapMs);
    let t2;
    try {
      t2 = await taskByCodeMP(a, code);
    } catch {
      continue;
    }
    if (!t2) continue;
    t = t2;
    if (t.claimable || t.claimed || t.current >= target) break;
  }
  if (t.claimed) return '本轮已入账（claimed）';
  if (t.current < target) {
    return `已上报 ${need} 次但进度未达 ${t.current}/${target}（异步计分未归账，下次重试）`;
  }
  const { credit, energy } = await claimRewardMP(a, code);
  return `任务点亮并领取奖励（+${credit}c +${energy}e）`;
}

/** 对应 Go `runSchoolSeason`：完成 school_season「校园日」（mp 口径，带 activityId）。 */
export function runSchoolSeason(a) {
  return runMPMiniChatTask(a, 'school_season', true);
}

/** 对应 Go `runSequentialChat`：完成 Sequential_Tasks_1「小程序内完成 1 次有效对话」。 */
export function runSequentialChat(a) {
  return runMPMiniChatTask(a, 'Sequential_Tasks_1', false);
}

// ── school.go：开学季 API ────────────────────────────────────────────────────

/** 对应 Go `(*Client).schoolJSON`：billing 域 + /portal/activity/school 发请求并解信封。 */
async function schoolJSON(a, method, path, body) {
  const headers = {
    Authorization: `Bearer ${a?.accessToken ?? ''}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (a?.uid) headers['X-User-Id'] = a.uid;
  return doJSON(`${baseOf(a, 'billing')}${SCHOOL_BASE}${path}`, { method, headers, body });
}

/** 对应 Go `(*Client).SchoolTasks`：任务列表 + 活动是否在期。 */
export async function schoolTasks(a) {
  const data = await schoolJSON(a, 'GET', '/tasks', undefined);
  const d = data && typeof data === 'object' ? data : {};
  return {
    tasks: Array.isArray(d.tasks) ? d.tasks.map((t) => ({
      task_code: String(t?.task_code ?? ''),
      status: String(t?.status ?? ''),
      progress: Number(t?.progress ?? 0),
      target_count: Number(t?.target_count ?? 0),
    })) : [],
    inPeriod: d.in_period === true,
  };
}

/** 对应 Go `(*Client).SchoolShareComplete`：上报「分享完成」（share_invite 判据，实测即点亮）。 */
export async function schoolShareComplete(a) {
  return schoolJSON(a, 'POST', '/tasks/share-complete', { channel: 'wechat' });
}

/** 对应 Go `(*Client).SchoolTaskViewed`：标记任务已查看（pending → in_progress）。 */
export async function schoolTaskViewed(a, taskCode) {
  return schoolJSON(a, 'POST', `/tasks/${taskCode}/viewed`, {});
}

/** 对应 Go `(*Client).SchoolClaimTask`：领取任务奖励，返回获得的抽奖次数。 */
export async function schoolClaimTask(a, taskCode) {
  const data = await schoolJSON(a, 'POST', `/tasks/${taskCode}/claim`, {});
  return Number(data?.chance_granted ?? 0);
}

/** 对应 Go `(*Client).SchoolChances`：当前抽奖次数余额（data.chance.balance）。 */
export async function schoolChances(a) {
  const data = await schoolJSON(a, 'GET', '/config', undefined);
  return Number(data?.chance?.balance ?? 0);
}

/** 对应 Go `(*Client).SchoolDraw`：抽奖一次，返回奖品描述（prize_code + 积分）。 */
export async function schoolDraw(a) {
  const data = await schoolJSON(a, 'POST', '/wheel/draw', { draw_uuid: clientToken() });
  const prizeCode = String(data?.prize_code ?? '');
  const creditAmount = Number(data?.credit_amount ?? 0);
  if (creditAmount > 0) return `${prizeCode} +${creditAmount}c`;
  return prizeCode;
}

/** 对应 Go `(*Client).SchoolVouchers`：查询账号的开学季券码列表（只读，data.items[]）。 */
export async function schoolVouchers(a) {
  const data = await schoolJSON(a, 'GET', '/vouchers', undefined);
  const d = data && typeof data === 'object' ? data : {};
  const items = Array.isArray(d.items) ? d.items : [];
  return items.map((v) => ({
    grant_id: Number(v?.grant_id ?? 0),
    draw_uuid: String(v?.draw_uuid ?? ''),
    sku_code: String(v?.sku_code ?? ''),
    prize_name: String(v?.prize_name ?? ''),
    code: String(v?.code ?? ''),
    valid_from: String(v?.valid_from ?? ''),
    valid_to: String(v?.valid_to ?? ''),
    granted_at: String(v?.granted_at ?? ''),
  }));
}

// ── school.go：小程序埋点（mp 指纹）──────────────────────────────────────────

/** clientToken 幂等令牌（对应 Go `clientToken`，前端 randomUUID 同款 8-4-4-4-12 hex）。 */
function clientToken() {
  return randomUUID();
}

/** 对应 Go `mpEventBase`：小程序埋点公共指纹（appservice wQ()+Ao() 对齐）。 */
export function mpEventBase(a) {
  return {
    timestamp: Date.now(),
    ideType: 'WorkBuddy_MP',
    ideVersion: '2.4.0',
    extName: 'workbuddy-mp',
    extVersion: '2.4.0',
    product: 'SaaS',
    ideName: 'wx_app_cloud',
    platform: 'mini_program',
    os: 'windows',
    osVersion: '11',
    arch: 'x64',
    machineId: MP_EVENT_MACHINE_ID,
    timezone: 'Asia/Shanghai',
    userId: a?.uid ?? '',
    userNickname: a?.nickname ?? '',
  };
}

/**
 * 对应 Go `(*Client).ReportMPEvent`：以小程序指纹向 www.codebuddy.cn/v2/report 批量上报事件。
 * events 可传单个事件对象或事件数组（Go 为变参）。无人上报时抛 Error。
 */
export async function reportMPEvent(a, events) {
  const list = Array.isArray(events) ? events : (events == null ? [] : [events]);
  if (list.length === 0) throw new Error('mp report: no events');
  const base = mpEventBase(a);
  const arr = list.map((ev) => ({ ...base, ...(ev ?? {}) }));
  const headers = {
    Authorization: `Bearer ${a?.accessToken ?? ''}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (a?.uid) headers['X-User-Id'] = a.uid;
  headers['X-Client-Product'] = 'workbuddy-mp';
  headers['X-Client-Version'] = '2.4.0';
  headers['X-Client-Platform'] = 'mp-weixin';
  headers['X-Platform'] = 'wechatmp';
  return doJSON(`${MP_REPORT_BASE}${MP_REPORT_PATH}`, { method: 'POST', headers, body: arr });
}

/** 对应 Go `SchoolChatTimesEvents`：构造一条 chat_request_send 事件（chat_3_times 计数）。 */
export function schoolChatTimesEvents(conversationID) {
  const rid = `wb2api-${clientToken()}`;
  return {
    eventCode: 'chat_request_send',
    inputLength: 14, isPlan: false, isAutoExecuteTerminal: false,
    isAutoModify: false, codebaseEnable: false, maxToken: 0,
    maxSteps: 500, temperature: 0, maxRetries: 0,
    mentionContexts: [], knowledgeId: [], knowledgeName: [],
    codebaseId: '', mentionContextCount: 0, command: '',
    recommendId: '', skillId: '', skillCount: 0, totalCount: 0,
    traceId: rid, rootRequestId: rid,
    parentConversationId: conversationID, conversationId: conversationID,
    messageId: `msg-${rid.slice(-8)}`,
    agentName: 'mp', agentType: 'main',
    'codebuddy.session_id': conversationID,
    'codebuddy.conversation_request_id': rid,
  };
}

/** 对应 Go `SchoolSeasonChatEvent`：growth 域「校园日」判据事件（同构 + activityId）。 */
export function schoolSeasonChatEvent(conversationID) {
  const ev = schoolChatTimesEvents(conversationID);
  ev.activityId = SCHOOL_OPEN_DAY_ACTIVITY_ID;
  return ev;
}

/** 对应 Go `SchoolExpertUseEvents`：专家召唤+对话事件链（expert_use 判据，4 条）。 */
export function schoolExpertUseEvents(expertID, expertName, conversationID) {
  const rid = `wb2api-${clientToken()}`;
  return [
    {
      eventCode: 'expert_summon_click', id: expertID, name: expertID,
      expertTitle: expertName, type: '16-BackToSchool', position: 0,
    },
    {
      eventCode: 'expert_summoned', id: expertID, name: expertID,
      expertTitle: expertName,
    },
    {
      eventCode: 'expert_actual_use', id: expertID, name: expertID,
      expertTitle: expertName, type: '16-BackToSchool',
      characterCount: 14, expertType: 'builtin',
    },
    {
      eventCode: 'chat_request_send',
      inputLength: 14, isPlan: false, isAutoExecuteTerminal: false,
      isAutoModify: false, codebaseEnable: false, maxToken: 0,
      maxSteps: 500, temperature: 0, maxRetries: 0,
      mentionContexts: [], knowledgeId: [], knowledgeName: [],
      codebaseId: '', mentionContextCount: 0, command: '',
      recommendId: '', skillId: '', skillCount: 0, totalCount: 0,
      traceId: rid, rootRequestId: rid,
      parentConversationId: conversationID, conversationId: conversationID,
      messageId: `msg-${rid.slice(-8)}`,
      agentName: 'mp', agentType: 'main',
      expertId: expertID, expertName,
      'codebuddy.session_id': conversationID,
      'codebuddy.conversation_request_id': rid,
    },
  ];
}

// ── scheduler/school.go + panel/taskcenter.go：开学季闭环编排 ────────────────

/** 对应 Go `findSchoolTask`：按任务码查开学季条目。 */
function findSchoolTask(tasks, code) {
  return tasks.find((t) => t.task_code === code) ?? null;
}

/** 对应 Go `(*Scheduler).schoolPollDone`：轮询任务是否达标（异步计分，最多 3 次）。 */
export async function schoolPollDone(a, code, {
  loops = SCHOOL_POLL_LOOPS,
  gapMs = SCHOOL_POLL_GAP_MS,
} = {}) {
  for (let i = 0; i < loops; i++) {
    await sleep(gapMs);
    let tasks;
    try {
      ({ tasks } = await schoolTasks(a));
    } catch {
      continue;
    }
    const t = findSchoolTask(tasks, code);
    if (t && t.target_count > 0 && t.progress >= t.target_count) return true;
  }
  return false;
}

/** 对应 Go `(*Scheduler).schoolShareTask`：share-complete 上报 → 轮询 → 领奖。 */
export async function schoolShareTask(a) {
  const { tasks } = await schoolTasks(a);
  const share = findSchoolTask(tasks, 'share_invite');
  if (!share || share.status === 'claimed') return '分享任务已领取（跳过）';
  try {
    await schoolShareComplete(a);
  } catch (err) {
    return `share-complete 上报失败: ${err.message}`;
  }
  if (!await schoolPollDone(a, 'share_invite')) {
    return 'share-complete 上报后未点亮（明日重试）';
  }
  const granted = await schoolClaimTask(a, 'share_invite');
  return `★ 分享任务完成，+100c +${granted} 抽奖次数`;
}

/** 对应 Go `(*Scheduler).schoolChatTimesTask`：viewed → 3 条埋点 → 轮询 → 领奖。 */
export async function schoolChatTimesTask(a) {
  const { tasks } = await schoolTasks(a);
  const t = findSchoolTask(tasks, 'chat_3_times');
  if (!t || t.status === 'claimed'
    || (t.target_count > 0 && t.progress >= t.target_count && t.status === 'completed')) {
    return '对话任务已完成（跳过）';
  }
  if (t.status === 'pending') {
    try {
      await schoolTaskViewed(a, 'chat_3_times');
    } catch (err) {
      return `chat viewed 失败: ${err.message}`;
    }
  }
  const rounds = Math.min(t.target_count, 5);
  for (let i = 0; i < rounds; i++) {
    const conv = `wb2api-chat-${Math.floor(Date.now() / 1000)}-${i}`;
    try {
      await reportMPEvent(a, schoolChatTimesEvents(conv));
    } catch (err) {
      return `chat events 上报失败: ${err.message}`;
    }
    await sleep(MP_ACTION_GAP_MS);
  }
  if (!await schoolPollDone(a, 'chat_3_times')) {
    return 'chat_3_times 未点亮（明日重试）';
  }
  const granted = await schoolClaimTask(a, 'chat_3_times');
  return `★ 对话任务完成，+50c +${granted} 抽奖次数`;
}

/**
 * 对应 Go `(*Scheduler).schoolExpertTask`：viewed → 专家事件链 → 轮询 → 领奖。
 * 开学季专家（16-BackToSchool 分类）：论文写作导师。
 */
export async function schoolExpertTask(a) {
  const { tasks } = await schoolTasks(a);
  const t = findSchoolTask(tasks, 'expert_use');
  if (!t || t.status === 'claimed' || (t.target_count > 0 && t.progress >= t.target_count)) {
    return '专家任务已完成（跳过）';
  }
  if (t.status === 'pending') {
    try {
      await schoolTaskViewed(a, 'expert_use');
    } catch (err) {
      return `expert viewed 失败: ${err.message}`;
    }
  }
  const events = schoolExpertUseEvents('ex_jB0dyFIQJEWa', '论文写作导师',
    `wb2api-exp-${Math.floor(Date.now() / 1000)}`);
  try {
    await reportMPEvent(a, events);
  } catch (err) {
    return `expert events 上报失败: ${err.message}`;
  }
  if (!await schoolPollDone(a, 'expert_use')) {
    return 'expert_use 未点亮（明日重试）';
  }
  const granted = await schoolClaimTask(a, 'expert_use');
  return `★ 专家任务完成，+50c +${granted} 抽奖次数`;
}

/** 对应 Go `(*Scheduler).schoolDesktopTask`：viewed 激活 → 真实 chat → 六事件链 → 领奖。 */
export async function schoolDesktopTask(a) {
  const { tasks } = await schoolTasks(a);
  const t = findSchoolTask(tasks, 'desktop_chat_1_time');
  if (!t || t.status === 'claimed' || t.progress >= t.target_count) {
    return '桌面端体验任务已完成（跳过）';
  }
  if (t.status === 'pending') {
    try {
      await schoolTaskViewed(a, 'desktop_chat_1_time');
    } catch (err) {
      return `desktop viewed 失败: ${err.message}`;
    }
  }
  let conv, req;
  try {
    ({ conversationId: conv, requestId: req } = await desktopChatWithExpert(a, ''));
  } catch (err) {
    return `desktop chat 失败: ${err.message}`;
  }
  const events = desktopChatSequence(conv, req, `msg-${req.slice(-8)}`, 'fast-model', 'fast-model');
  try {
    await reportDesktopEvent(a, events);
  } catch (err) {
    return `desktop events 上报失败: ${err.message}`;
  }
  // 异步计分轮询后领奖（失败不阻塞主流程）。
  for (let i = 0; i < SCHOOL_POLL_LOOPS; i++) {
    await sleep(SCHOOL_POLL_GAP_MS);
    let tasks2;
    try {
      ({ tasks: tasks2 } = await schoolTasks(a));
    } catch {
      continue;
    }
    const t2 = findSchoolTask(tasks2, 'desktop_chat_1_time');
    if (t2 && t2.progress >= t2.target_count) {
      try {
        const granted = await schoolClaimTask(a, 'desktop_chat_1_time');
        return `★ 桌面端体验任务完成 +100c +${granted} 抽奖`;
      } catch {
        return '桌面端体验任务达标（领奖失败，明日重试）';
      }
    }
  }
  return 'desktop_chat_1_time 未点亮（明日重试）';
}

/**
 * 对应 Go `(*Scheduler).schoolAccount`：单账号开学季闭环
 * （四任务独立处理，最后把抽奖次数抽完）。返回逐项结果与抽奖记录。
 */
export async function schoolAccount(a, {
  pollGapMs = SCHOOL_POLL_GAP_MS,
  drawGapMs = 2000,
} = {}) {
  const out = { uid: a?.uid ?? '', nickname: a?.nickname ?? '', in_period: false, results: {}, draws: [] };
  const { tasks, inPeriod } = await schoolTasks(a);
  out.in_period = inPeriod;
  if (!inPeriod) return out; // 活动已结束，静默
  out.results.share_invite = await schoolShareTask(a);
  out.results.desktop_chat_1_time = await schoolDesktopTask(a);
  out.results.chat_3_times = await schoolChatTimesTask(a);
  out.results.expert_use = await schoolExpertTask(a);
  // 抽奖：把余额全抽完（含本次活动新领的次数）。
  const chances = await schoolChances(a);
  out.chances = chances;
  for (let i = 0; i < chances; i++) {
    const prize = await schoolDraw(a);
    out.draws.push(prize);
    await sleep(drawGapMs);
  }
  // 闭环后回读开学季状态做汇总（对应 Go panel.runSchoolQueued 的统计口径）。
  let done = 0;
  try {
    const { tasks: after } = await schoolTasks(a);
    for (const t of after) {
      if (t.status === 'claimed'
        || (t.task_code !== 'task_student_verify' && t.target_count > 0 && t.progress >= t.target_count)) {
        done++;
      }
    }
    out.tasks_done = done;
    out.tasks_total = after.length;
  } catch {
    out.tasks_done = 0;
    out.tasks_total = 0;
  }
  out.message = `开学季闭环完成（${out.tasks_done}/${out.tasks_total} 项已完成，抽奖已抽完）`;
  return out;
}

/**
 * 对应 Go `panel.schoolRunAll` / `scheduler.RunSchoolNow`：一键执行开学季闭环。
 * 入参可为单个账号或账号数组（数组形态按 activityAccountDelay 账号间限速，
 * global 账号按 D4 门控跳过且不发起任何上游调用）。
 */
export async function schoolRunAll(target, {
  accountGapMs = ACTIVITY_ACCOUNT_DELAY_MS,
  pollGapMs = SCHOOL_POLL_GAP_MS,
  drawGapMs = 2000,
} = {}) {
  const list = Array.isArray(target) ? target : [target];
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (isGlobal(a)) {
      out.push({ uid: a?.uid ?? '', nickname: a?.nickname ?? '', skipped: 'global realm（无开学季活动）' });
    } else {
      try {
        out.push(await schoolAccount(a, { pollGapMs, drawGapMs }));
      } catch (err) {
        out.push({ uid: a?.uid ?? '', nickname: a?.nickname ?? '', error: err.message });
      }
    }
    if (i < list.length - 1) await sleep(accountGapMs);
  }
  return Array.isArray(target) ? out : out[0];
}

/**
 * 对应 Go `panel.schoolStatus`：开学季任务状态（含抽奖余额）。
 * global 账号不发起任何上游调用，只回 error 字段。
 */
export async function schoolStatus(a) {
  const v = {
    uid: a?.uid ?? '', nickname: a?.nickname ?? '', in_period: false, tasks: [], chances: 0,
  };
  if (isGlobal(a)) {
    v.error = 'global realm（无开学季活动）';
    return v;
  }
  try {
    const { tasks, inPeriod } = await schoolTasks(a);
    v.in_period = inPeriod;
    v.tasks = tasks.map((t) => ({
      task_code: t.task_code, status: t.status, progress: t.progress, target_count: t.target_count,
    }));
  } catch (err) {
    v.error = err.message;
  }
  try {
    v.chances = await schoolChances(a);
  } catch {
    v.chances = 0;
  }
  return v;
}

// ── blackcat.go ─────────────────────────────────────────────────────────────

/** 对应 Go `InNightWindow`：是否处于夜猫子计数窗口（23:00–08:00 本地时区）。 */
export function inNightWindow(date = new Date()) {
  const h = (date instanceof Date ? date : new Date(date)).getHours();
  return h >= 23 || h < 8;
}

/** 对应 Go `(*Client).BlackcatNeed`：查 black_cat 任务剩余差额（任务不存在返回 0）。 */
export async function blackcatNeed(a) {
  const tasks = await listTasks(a);
  for (const t of tasks) {
    if (t.task_code === 'black_cat') {
      if (t.claimed || t.current >= t.target) return 0;
      return t.target - t.current;
    }
  }
  return 0;
}

/**
 * 对应 Go `(*Client).RunNightChats`：夜猫子发 need 次 glm-5.2 真实对话并上报事件链。
 * 返回成功次数；中途失败时抛出的 Error 带 .ok = 已成功次数（对应 Go 的 (ok, err)）。
 */
export async function runNightChats(a, need) {
  let ok = 0;
  for (let i = 0; i < need; i++) {
    const body = {
      model: 'glm-5.2',
      messages: [{ role: 'user', content: '1+1等于几？直接回答。' }],
      stream: true,
    };
    let status = 0;
    let text = '';
    try {
      const r = await chatStream(a, body, { conversationId: `wb2api-night-conv-${Date.now()}-${i}` });
      status = r.status;
      text = r.text;
    } catch (err) {
      const e = new Error(`第 ${i + 1} 次对话失败: http=0 err=${err.message}`);
      e.ok = ok;
      throw e;
    }
    if (status >= 400) {
      const e = new Error(`第 ${i + 1} 次对话失败: http=${status} err=none body=${truncate(text, 120)}`);
      e.ok = ok;
      throw e;
    }
    try {
      await reportChatActivityModel(a, `wb2api-night-${Date.now()}-${i}`, '', 'glm-5.2', 'GLM-5.2');
    } catch (err) {
      const e = new Error(`第 ${i + 1} 次上报失败: ${err.message}`);
      e.ok = ok;
      throw e;
    }
    ok++;
    await sleep(4000);
  }
  return ok;
}

/** 对应 Go `(*Client).ClaimGift`：领取新手礼包（每号一次，已领返回业务错误）。 */
export async function claimGift(a) {
  const headers = billingHeaders(a);
  const data = await doJSON(`${baseOf(a, 'billing')}/billing/meter/claim-gift`, {
    method: 'POST', headers, body: {},
  });
  return Number(data?.credit ?? 0);
}

/** 对应 Go `(*Client).ClaimCompensation`：领取活动补偿（有则领，无则业务错误）。 */
export async function claimCompensation(a) {
  const headers = billingHeaders(a);
  const data = await doJSON(`${baseOf(a, 'billing')}/billing/meter/claim-compensation`, {
    method: 'POST', headers, body: {},
  });
  return Number(data?.credit ?? 0);
}

/** 对应 Go `(*Client).HeatmapYesterdayMissed`：检查昨日是否漏签（heatmap cell score==0）。 */
export async function heatmapYesterdayMissed(a) {
  const y = new Date();
  y.setDate(y.getDate() - 1);
  const yesterday = `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, '0')}-${String(y.getDate()).padStart(2, '0')}`;
  const data = await growthJSON(a, 'GET', '/activity/growth/heatmap', undefined);
  const cells = Array.isArray(data?.cells) ? data.cells : [];
  for (const cell of cells) {
    const d = String(cell?.date ?? '');
    if (d.length >= 10 && d.slice(0, 10) === yesterday) {
      return Number(cell?.score ?? 0) === 0;
    }
  }
  return false;
}

/** 对应 Go `(*Client).UseMakeupCard`：对指定日期使用补签卡（无卡返回业务错误）。 */
export async function useMakeupCard(a, date) {
  return growthJSON(a, 'POST', '/activity/growth/makeup-cards/use', { target_date: date });
}
