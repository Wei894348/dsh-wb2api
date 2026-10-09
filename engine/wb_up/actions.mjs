/**
 * 成长任务动作表：每个动作的判据、消耗与节流参数。
 *
 * 每个动作幂等：已 claimed / 已达标的任务由调用方（wb_tasks.mjs）先跳过，不重复消耗配额。
 * 任务读写通过注入的 `api`（wb_up/tasks.mjs 的封装）完成，本模块只管「怎么把任务做出来」。
 */
import * as ev from './events.mjs';
import * as growth from './growth.mjs';
import { hex32, sleep } from './core.mjs';

/** 连续上报之间的间隔（对齐上游脚本实测 1.05s 口径，避免风控）。 */
export const reportGap = 1050;
/** 专家召唤链间隔（真实使用节奏）。 */
export const expertSummonGap = 6000;
/** mp 任务写动作间隔。 */
export const mpActionGap = 2000;

/** 小程序口径专属任务码（默认列表不出现，需走 mp 变体）。 */
export const MP_TASK_CODES = new Set(['school_season', 'Sequential_Tasks_1']);
export const isMPCode = (code) => MP_TASK_CODES.has(String(code));

/** 桌面指纹里固定用的企鹅教师助手（Buddy_App_QQ 判据应用，也满足 Buddy_App）。 */
const BUDDY_APP_ID = 'cb_y5Dy46tPQGGWtueMxXbe';
const BUDDY_APP_NAME = '企鹅教师助手';

/** Hp_Appearance 判据主题：和平精英激战金秋。 */
const HP_THEME_KEY = 'theme-tkmw7j';

/** Library_read 判据：资料库介绍页元素点击。 */
const LIBRARY_DOC_URL = 'https://www.workbuddy.cn/space/d/o0KWYeynteVv06UnAZqIFm';

/** 轻量云专家 id（Expert_lighthouse 判据）。 */
const LIGHTHOUSE_EXPERT = {
  expert_id: 'ex_2cvvUZQhDyeJ',
  expert_type: 'agent',
  display_name_zh: '腾讯轻量云专家',
  profession_zh: '腾讯轻量云专家',
  version: '1.0.2',
  categories: [],
};

const ms = () => Date.now();

// ---------------------------------------------------------------------------
// 单个任务动作
// ---------------------------------------------------------------------------

/** chat_5：按差额补报对话活跃事件。 */
export async function runChat5(auth, api) {
  const t = await api.taskByCode(auth, 'chat_5');
  if (t === null) throw new Error('任务不存在');
  const target = t.target > 0 ? t.target : 5;
  const need = target - t.current;
  if (need <= 0) return '进度已达标，无需上报';
  for (let i = 0; i < need; i += 1) {
    await ev.reportChatActivity(auth, `wb2api-chat5-${ms()}-${i}`);
    if (i < need - 1) await sleep(reportGap);
  }
  return `已补报 ${need} 条对话事件`;
}

/** first_buddy：前置活跃上报 → 同意协议 → 领养第一只 Buddy（+300 分 +8 能）。 */
export async function runFirstBuddy(auth) {
  await ev.reportChatActivity(auth, `wb2api-adopt-${ms()}`);
  await sleep(reportGap);
  await growth.buddyAgreement(auth);
  try {
    await growth.buddyFirst(auth);
  } catch (error) {
    if (String(error?.message ?? '').includes('first_buddy task not completed yet')) {
      return '前置已上报，但领养门槛未过（上游要求当日活跃），请稍后重试';
    }
    throw error;
  }
  return '已领取 Buddy（+300 分 +8 能量）';
}

/** Model_chat_GLM5.2：accept → 真实 glm-5.2 对话 → 对齐模型上报。 */
export async function runModelChat(auth, api) {
  const code = 'Model_chat_GLM5.2';
  try {
    await api.acceptTasks(auth, [code]);
  } catch { /* 行为事件才是判据，accept 失败不阻塞 */ }
  await sleep(reportGap);
  await ev.chatStream(auth, {
    model: 'glm-5.2',
    messages: [{ role: 'user', content: 'hi，请回复一句话' }],
    stream: true,
  });
  await sleep(reportGap);
  await ev.reportChatActivityModel(auth, `wb2api-glm52-${ms()}`, '', 'glm-5.2', 'GLM-5.2');
  return '已完成 glm-5.2 对话并上报';
}

/** RichMeow_Chat：桌面指纹完整对话事件链。 */
export async function runRichMeow(auth) {
  const stamp = ms();
  await ev.reportDesktopEvent(auth,
    ev.desktopChatSequence(`wb2api-rm-${stamp}`, `wb2api-rm-req-${stamp}`, `req-${stamp}-user`, 'fast-model', 'fast-model'));
  return '已按桌面端指纹上报完整对话事件链（agent_task_created→chat_response）';
}

/** Buddy_App / Buddy_App_QQ：buddyapp 五连事件。 */
export async function runBuddyApp(auth) {
  await ev.reportDesktopEvent(auth, ev.desktopBuddyAppSequence(BUDDY_APP_ID, BUDDY_APP_NAME));
  return '已上报 buddyapp 进入五连事件（同时覆盖 Buddy_App 与 Buddy_App_QQ）';
}

/** automation_1：定时任务创建成功事件。 */
export async function runAutomationCreate(auth) {
  await ev.reportDesktopEvent(auth, ev.desktopAutomationCreateEvent('wb2api 自动化'));
  return '已上报定时任务创建事件';
}

/** Library_read：web 域元素点击。 */
export async function runLibraryRead(auth) {
  await ev.reportWebEvent(auth, 'web_element_click', LIBRARY_DOC_URL, 'library_doc_intro_click', 'WorkBuddy资料库介绍');
  return '已上报资料库介绍阅读事件';
}

/** template_5：5 组模板使用事件。 */
export async function runTemplateUse(auth) {
  const templates = [['1', '深度研究'], ['2', '周报生成'], ['3', '竞品分析'], ['4', '活动策划'], ['5', '代码评审']];
  for (const [i, [id, name]] of templates.entries()) {
    const stamp = ms();
    await ev.reportDesktopEvent(auth,
      ev.desktopTemplateUseSequence(`wb2api-tpl-${stamp}-${i}`, `wb2api-tpl-req-${stamp}-${i}`, id, name));
    await sleep(300);
  }
  return '已上报 template_used ×5';
}

/** playbook_prompt：灵感案例「做同款」发送。 */
export async function runPlaybookPrompt(auth) {
  const stamp = ms();
  await ev.reportDesktopEvent(auth,
    ev.desktopPlaybookPromptSequence(`wb2api-pb-${stamp}`, `wb2api-pb-req-${stamp}`, 'pm-gtm-launch-plan', '新产品上市 GTM 发布计划一页纸'));
  return '已上报 playbook_cta_click + playbook_prompt_send';
}

/** create_canvas：设计创意画布创建事件组（+300 分）。 */
export async function runCreateCanvas(auth) {
  const stamp = ms();
  await ev.reportDesktopEvent(auth,
    ev.desktopDesignCanvasSequence(`wb2api-canvas-${stamp}`, `wb2api-canvas-req-${stamp}`));
  return '已上报 wbx_design_canvas_task_create/open';
}

/** 专家召唤 + 真实使用链的公共实现（count 位真实专家）。 */
async function runExpertBatch(auth, expertType, count) {
  const experts = await ev.marketExpertList(auth, expertType);
  if (experts.length === 0) throw new Error('专家市场列表为空');
  let ok = 0;
  for (const [i, e] of experts.entries()) {
    if (ok >= count) break;
    try {
      await ev.reportDesktopEvent(auth, ev.desktopExpertSummonSequence(e));
      const { conversationId, requestId } = await ev.desktopChatWithExpert(auth, e.expert_id);
      const events = [
        ...ev.desktopChatSequence(conversationId, requestId, `msg-${requestId.slice(-8)}`, 'fast-model', 'fast-model'),
        ev.desktopExpertActualUseEvent(e, conversationId, requestId, 'craft'),
      ];
      await ev.reportDesktopEvent(auth, events);
      ok += 1;
    } catch { /* 单个专家失败继续下一个 */ }
    if (i < experts.length - 1) await sleep(expertSummonGap);
  }
  return `已对 ${ok} 位真实专家完成召唤+使用链（类型 ${expertType}）`;
}

/** expert_5：真实专家 ×5。 */
export const runExpertUse = (auth) => runExpertBatch(auth, 'agent', 5);
/** Expert_team_use_3：专家团 ×3。 */
export const runExpertTeamUse = (auth) => runExpertBatch(auth, 'team', 3);

/** Hp_Appearance：设置主题 + 皮肤生效事件。 */
export async function runAppearance(auth) {
  await ev.setAppearanceTheme(auth, HP_THEME_KEY);
  await sleep(2000);
  await ev.reportDesktopEvent(auth, {
    eventCode: 'appearance_skin_apply', action: 'apply', source: 'settings_close',
    id: HP_THEME_KEY, vipLevel: 0, series: '', type: 'unknown',
  });
  return '已设置主题并上报皮肤生效事件';
}

/** skill_1：真实对话 + skill_info 技能加载事件。 */
export async function runSkillFresh(auth) {
  const { conversationId, requestId } = await ev.desktopChatWithExpert(auth, '');
  const messageId = `msg-${requestId.slice(-8)}`;
  const events = ev.desktopChatSequence(conversationId, requestId, messageId, 'fast-model', 'fast-model');
  for (const e of events) {
    if (e.eventCode === 'chat_message_response') e.finishReason = 'tool_calls';
  }
  events.push({
    eventCode: 'skill_info',
    id: '润泽小馆·日报撰写',
    skillId: 'skill_2097350077599879168',
    skillVersion: '1.0.0',
    toolStatus: 'success',
    fileCount: 56,
    source: 'workbuddy-desktop',
    conversationId, requestId, messageId,
    requestModelId: 'fast-model', requestModelName: 'fast-model',
    traceId: requestId,
  });
  await ev.reportDesktopEvent(auth, events);
  return '已上报真实对话 + skill_info 技能加载事件';
}

/** Expert_lighthouse：轻量云专家召唤 + 真实对话（mode=LOCAL 变体）。 */
export async function runExpertLighthouse(auth) {
  let lh = LIGHTHOUSE_EXPERT;
  try {
    const list = await ev.marketExpertList(auth, 'agent');
    const hit = list.find((e) => e.expert_id === LIGHTHOUSE_EXPERT.expert_id);
    if (hit) lh = hit;
  } catch { /* 市场列表拉不到就用内置条目 */ }
  await ev.reportDesktopEvent(auth, ev.desktopExpertSummonSequence(lh));
  const { conversationId, requestId } = await ev.desktopChatWithExpert(auth, lh.expert_id);
  const events = ev.desktopChatSequence(conversationId, requestId, `msg-${requestId.slice(-8)}`, 'fast-model', 'fast-model');
  for (const e of events) {
    if (e.eventCode === 'agent_task_created') {
      e.has_expert = true;
      e.expert_id = lh.expert_id;
      e.expert_name = lh.display_name_zh;
      e.expert_industry_id = '';
    }
  }
  const use = ev.desktopExpertActualUseEvent(lh, conversationId, requestId, 'LOCAL');
  use.type = '';
  use.cost = 0;
  events.push(use);
  await ev.reportDesktopEvent(auth, events);
  return '已上报轻量云专家召唤+使用链（真实对话 requestId）';
}

/** black_cat：23:00–08:00 窗口内 glm-5.2 对话补足。 */
export async function runBlackCat(auth, api) {
  if (!inNightWindow()) {
    return '当前不在 23:00–08:00 计数窗口，行为不计分；夜间排程会自动补足';
  }
  const need = await api.blackcatNeed(auth);
  if (need <= 0) return '进度已达标，无需补足';
  const done = await api.runNightChats(auth, need);
  return `已完成 ${done} 次夜间对话并上报`;
}

/** 本地时区是否在夜间计数窗口（23:00–08:00）。 */
export function inNightWindow(date = new Date()) {
  const h = date.getHours();
  return h >= 23 || h < 8;
}

/**
 * 小程序口径限定的 mini chat 任务闭环：
 * mp 查询 → accept（带登记回读验证）→ mini chat 事件上报 → 回读 → 达标领奖。
 */
async function runMPMiniChatTask(auth, api, code, withActivityId) {
  let t = await api.taskByCodeMP(auth, code);
  if (t === null) return 'mp 口径未下发该任务（活动可能已结束）';
  if (t.claimed) return '已领取';
  if (t.accept_status === 'not_accepted' || t.accept_status === '') {
    const ok = await acceptWithVerifyMP(auth, api, code);
    if (!ok) return 'accept 未登记生效（上游 200+OK 但未落账形态），待下次重试';
  }
  const target = t.target > 0 ? t.target : 1;
  if (t.current >= target || t.accept_status === 'completed') {
    const { credit, energy } = await api.claimRewardMP(auth, code);
    return `已领取奖励（+${credit}c +${energy}e）`;
  }
  const need = target - t.current;
  for (let i = 0; i < need; i += 1) {
    const conv = `wb2api-mp-${ms()}-${i}`;
    const event = withActivityId ? api.schoolSeasonChatEvent(conv) : api.schoolChatTimesEvents(conv);
    await api.reportMPEvent(auth, event);
    await sleep(mpActionGap);
  }
  for (let i = 0; i < 2; i += 1) {
    await sleep(3000);
    const t2 = await api.taskByCodeMP(auth, code);
    if (t2 === null) continue;
    t = t2;
    if (t.claimed || t.current >= target) break;
  }
  if (t.claimed) return '本轮已入账（claimed）';
  if (t.current < target) return `已上报 ${need} 次但进度未达 ${t.current}/${target}（异步计分未归账，下次重试）`;
  const { credit, energy } = await api.claimRewardMP(auth, code);
  return `任务点亮并领取奖励（+${credit}c +${energy}e）`;
}

/** accept 并回读验证登记生效（上游存在 200+OK 但未落账形态），未生效重试一次。 */
async function acceptWithVerifyMP(auth, api, code) {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await api.acceptTasksMP(auth, [code]);
    } catch {
      continue;
    }
    await sleep(mpActionGap);
    const t = await api.taskByCodeMP(auth, code);
    if (t !== null && t.accept_status !== '' && t.accept_status !== 'not_accepted') return true;
  }
  return false;
}

/** school_season：校园日（小程序口径，带开学季 activityId）。 */
export const runSchoolSeason = (auth, api) => runMPMiniChatTask(auth, api, 'school_season', true);
/** Sequential_Tasks_1：小程序内完成 1 次有效对话。 */
export const runSequentialChat = (auth, api) => runMPMiniChatTask(auth, api, 'Sequential_Tasks_1', false);

/**
 * 动作表（顺序即执行顺序：先解锁依赖项）。
 * `attempt: true` 表示上游未证实可脚本化，跑了可能不点亮。
 */
export const ACTIONS = [
  { code: 'chat_5', desc: '上报 5 条对话活跃事件（自动补足差额）', run: runChat5 },
  { code: 'first_buddy', desc: '上报解锁 → 同意协议 → 领取第一只 Buddy（+300 分）', run: (a) => runFirstBuddy(a) },
  { code: 'Model_chat_GLM5.2', desc: '接受任务 → glm-5.2 真实对话一次 → 对齐模型上报', run: runModelChat },
  { code: 'RichMeow_Chat', desc: '桌面指纹事件链上报', run: (a) => runRichMeow(a) },
  { code: 'Buddy_App', desc: '上报「进入 Buddy 应用」事件链', run: (a) => runBuddyApp(a) },
  { code: 'Buddy_App_QQ', desc: '上报「进入企鹅教师助手」事件链', run: (a) => runBuddyApp(a) },
  { code: 'automation_1', desc: '上报「定时任务创建」事件', run: (a) => runAutomationCreate(a) },
  { code: 'Library_read', desc: '上报「读资料库介绍」事件', run: (a) => runLibraryRead(a) },
  { code: 'template_5', desc: '上报「使用模板创建任务」事件组 ×5', run: (a) => runTemplateUse(a) },
  { code: 'playbook_prompt', desc: '上报「灵感案例做同款」事件组', run: (a) => runPlaybookPrompt(a) },
  { code: 'create_canvas', desc: '上报「设计创意画布创建」事件组（+300 分）', run: (a) => runCreateCanvas(a) },
  { code: 'expert_5', desc: '真实专家召唤+使用链 ×5', run: (a) => runExpertUse(a) },
  { code: 'Expert_team_use_3', desc: '真实专家团召唤+使用链 ×3', run: (a) => runExpertTeamUse(a) },
  { code: 'Hp_Appearance', desc: '设置主题 API + 皮肤生效事件', run: (a) => runAppearance(a) },
  { code: 'skill_1', desc: '真实对话 + skill_info 技能加载事件', run: (a) => runSkillFresh(a) },
  { code: 'Expert_lighthouse', desc: '真实轻量云专家召唤+使用链', run: (a) => runExpertLighthouse(a) },
  { code: 'black_cat', desc: '夜猫子：23:00–08:00 窗口内 glm-5.2 对话补足', attempt: true, run: (a, api) => runBlackCat(a, api) },
  { code: 'school_season', desc: '校园日（小程序口径）', run: runSchoolSeason },
  { code: 'Sequential_Tasks_1', desc: '小程序首对话（小程序口径）', run: runSequentialChat },
];

export function actionFor(code) {
  return ACTIONS.find((a) => a.code === String(code).trim()) ?? null;
}
