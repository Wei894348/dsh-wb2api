/**
 * 事件构造 + 三类上报通道（2026-09-12 抓包逆向得出的判据）。
 *
 * 纯构造函数只产数据；带 `report*` 前缀的负责发请求。
 */
import {
  baseOf, desktopFingerprint, desktopHeaders, webHeaders, billingHeaders,
  commonHeaders, send, envelope, derive36, hex32, sleep, DESKTOP_UA, WEB_UA,
} from './core.mjs';

// ── 桌面端事件链（copilot.tencent.com/v2/report，数组体）──────────────────────

/** 一次「桌面端成功对话」六连事件（点亮 RichMeow_Chat）。 */
export function desktopChatSequence(conversationId, requestId, messageId, modelId, modelName) {
  const mk = (code, extra) => ({ eventCode: code, ...extra });
  return [
    mk('agent_task_created', {
      source: 'LOCAL', name: 'working', task_target: 'local', mode: 'craft',
      requestModelId: modelId, requestModelName: modelName,
      has_repo: false, repo_type: 'none', workspace_type: 'empty',
      has_connector: false, connector_types: [],
      has_mention: false, mention_types: [],
      has_template: false, action: '', template_name: '',
      has_expert: false, expert_id: '', expert_name: '', expert_industry_id: '',
      has_skill: false, skill_names: [],
      conversationId, messageId,
      buddyId: '', buddyName: '',
    }),
    mk('chat_message_send', {
      messageId: `${messageId}-assistant`, historyCount: 0,
      isContextTruncated: false, currentStepCount: 1,
      traceId: requestId, rootRequestId: requestId,
      parentConversationId: conversationId,
      agentName: 'cli', agentType: 'main',
    }),
    mk('chat_request_send', {
      inputLength: 24, isPlan: false, isAutoExecuteTerminal: false,
      isAutoModify: false, codebaseEnable: false, maxToken: 0,
      maxSteps: 500, temperature: 0, maxRetries: 0,
      mentionContexts: [], knowledgeId: [], knowledgeName: [],
      codebaseId: '', mentionContextCount: 0, command: '',
      recommendId: '', skillId: '', skillCount: 0, totalCount: 0,
      traceId: requestId, rootRequestId: requestId,
      parentConversationId: conversationId,
      agentName: 'cli', agentType: 'main',
      'codebuddy.session_id': conversationId,
      'codebuddy.conversation_request_id': requestId,
    }),
    mk('chat_message_response', {
      messageId: `${messageId}-assistant`, responseModelId: modelId,
      inputToken: 120, outputToken: 80, totalToken: 200,
      cachedTokens: 0, cachedWriteTokens: 0, cachedMissTokens: 0,
      isSuccessful: true, messageErrorCode: '', finishReason: 'stop',
      firstTokenAt: Date.now(), traceId: requestId,
      conversationId,
      rootRequestId: requestId, parentConversationId: conversationId,
      agentName: 'cli', agentType: 'main',
      'codebuddy.session_id': conversationId,
      'codebuddy.conversation_request_id': requestId,
    }),
    mk('chat_message_status', {
      messageId: `${messageId}-assistant`, messageErrorCode: '0',
      traceId: requestId, rootRequestId: requestId,
      parentConversationId: conversationId,
      agentName: 'cli', agentType: 'main',
    }),
    mk('chat_request_response', {
      mode: 'craft', toolCallCount: 0,
      inputToken: 120, outputToken: 80, totalToken: 200,
      cachedTokens: 0, cachedWriteTokens: 0, cachedMissTokens: 0,
      isSuccessful: true, messageErrorCode: '', finishReason: 'stop',
      rootRequestId: requestId, parentConversationId: conversationId,
    }),
  ];
}

/** 「进入 Buddy 应用」五连事件（同时点亮 Buddy_App 与 Buddy_App_QQ）。 */
export function desktopBuddyAppSequence(buddyId, buddyName) {
  const mk = (code, extra = {}) => ({
    eventCode: code, mode: 'LOCAL', buddyId, buddyName, ...extra,
  });
  return [
    mk('buddyapp_discover_click'),
    mk('buddyapp_show', { elementId: buddyId, elementName: buddyName, position: 2 }),
    mk('buddyapp_enter_click', { elementId: buddyId, elementName: buddyName, position: 2, isFirstPage: '1' }),
    mk('buddyapp_auth_confirm_click', { elementId: buddyId, elementName: buddyName }),
    mk('buddyapp_bindaccount_skip_click', { elementId: buddyId, elementName: buddyName }),
  ];
}

/** 「定时任务创建成功」事件（点亮 automation_1）。 */
export function desktopAutomationCreateEvent(name) {
  return {
    eventCode: 'automated_task_create_suc', name,
    source: 'manually', modelId: 'fast-model', modelIsThinking: true,
    connectorCount: 0, skills: '', skillCount: 0,
    scheduleType: 'once', mode: 'LOCAL',
  };
}

/** 「使用模板创建任务」事件组（template_5）。 */
export function desktopTemplateUseSequence(conversationId, requestId, templateId, templateName) {
  return [
    ...desktopChatSequence(conversationId, requestId, `msg-${templateId}`, 'fast-model', 'fast-model'),
    {
      eventCode: 'agent_task_created_with_template', mode: 'working',
      isCustomModel: false, id: templateId, name: templateName, requestId,
    },
    { eventCode: 'template_used', template_id: templateId, task_mode: 'working' },
  ];
}

/** 「灵感案例做同款」事件组（playbook_prompt）。 */
export function desktopPlaybookPromptSequence(conversationId, requestId, caseId, caseName) {
  const payload = { id: caseId, name: caseName, type: 'document', categoryId: '', categoryName: '' };
  return [
    ...desktopChatSequence(conversationId, requestId, 'msg-pb', 'fast-model', 'fast-model'),
    {
      eventCode: 'web_element_click', pageName: 'playbook_detail',
      elementId: 'playbook_ctaClick', elementName: caseName, source: 'discover',
    },
    { eventCode: 'playbook_cta_click', source: 'discover', position: 0, ...payload },
    { eventCode: 'playbook_prompt_send', conversationId, requestId, ...payload },
  ];
}

/** 「设计创意画布」事件组（create_canvas，+300）。 */
export function desktopDesignCanvasSequence(conversationId, requestId) {
  return [
    ...desktopChatSequence(conversationId, requestId, 'msg-canvas', 'fast-model', 'fast-model'),
    {
      eventCode: 'wbx_design_canvas_task_create', conversationId,
      requestId, source: 'summon_keyword', cost: 12000, isSuccessful: true,
    },
    {
      eventCode: 'wbx_design_canvas_open', conversationId,
      requestId, id: `ardot-file-${requestId.slice(-8)}`,
      source: 'summon_keyword', type: 'page', cost: 13000, isSuccessful: true,
    },
  ];
}

/** 「召唤平台专家」事件组（expert_5 / Expert_team_use_3 / Expert_lighthouse）。 */
export function desktopExpertSummonSequence(e) {
  const cat = Array.isArray(e.categories) && e.categories.length > 0 ? e.categories[0] : 'expert-all';
  const ver = e.version || '1.0.0';
  return [
    {
      eventCode: 'web_element_click', source: e.expert_id, type: cat, version: ver,
      elementId: 'expert_summon_click', elementName: '立即召唤',
      pageURL: '/C:/Program%20Files/WorkBuddy/resources/app.asar/renderer/index.html',
    },
    {
      eventCode: 'expert_summon_click', id: e.expert_id, name: e.display_name_zh,
      expertTitle: e.profession_zh, type: 'expert-all', position: 0,
      expertType: e.expert_type, version: ver, mode: 'LOCAL',
    },
    {
      eventCode: 'expert_summoned', id: e.expert_id, name: e.display_name_zh,
      expertTitle: e.profession_zh, type: 'expert-all',
    },
  ];
}

/**
 * 「专家真实使用」事件（requestId 必须是真实 chat 的服务端 id）。
 * mode：expert_5/团队用 craft；Expert_lighthouse 用 LOCAL（对齐真实样本）。
 */
export function desktopExpertActualUseEvent(e, conversationId, requestId, mode = 'craft') {
  const cat = Array.isArray(e.categories) && e.categories.length > 0 ? e.categories[0] : 'expert-all';
  const ver = e.version || '1.0.0';
  return {
    eventCode: 'expert_actual_use',
    id: e.expert_id, name: e.display_name_zh, expertTitle: e.profession_zh,
    type: cat, expertType: e.expert_type, source: 'builtin', version: ver,
    cost: 9000, characterCount: 14,
    conversationId, requestId, messageId: `msg-${requestId.slice(-8)}`,
    requestModelId: 'fast-model', requestModelName: 'fast-model',
    mode,
  };
}

// ── billing 域「对话活跃上报」（www.codebuddy.cn/v2/report）────────────────────

/** chat_request_send 事件完整形状（userId 必填，缺失会被上游静默丢弃）。 */
export function chatActivityEvent(auth, conversationId, requestId, modelId, modelName) {
  const now = Date.now();
  const reqId = requestId || conversationId;
  const mid = modelId || 'deepseek-v4-flash';
  return {
    eventCode: 'chat_request_send',
    timestamp: now,
    reportDelay: 0,
    mode: 'craft',
    conversationId,
    requestId: reqId,
    inputLength: 12,
    requestModelId: mid,
    requestModelName: modelName || mid,
    isPlan: false,
    isAutoExecuteTerminal: false,
    isAutoModify: false,
    codebaseEnable: false,
    maxToken: 0,
    maxSteps: 0,
    temperature: 0,
    maxRetries: 0,
    mentionContexts: [],
    knowledgeId: [],
    knowledgeName: [],
    codebaseId: '',
    mentionContextCount: 0,
    command: '',
    expertId: '',
    recommendId: '',
    skillId: '',
    skillCount: 0,
    totalCount: 0,
    fileUri: '',
    presentAt: now,
    traceId: '',
    rootRequestId: reqId,
    parentConversationId: conversationId,
    agentName: 'default',
    agentType: 'conversation',
    userId: auth.uid,
  };
}

// ── 三个通道的发送入口 ─────────────────────────────────────────────────────

/**
 * 桌面指纹上报（数组体 + 公共指纹注入）。
 *
 * Go 侧是变参 `ReportDesktopEvent(a, events ...DesktopEvent)`，单个事件和数组都收；
 * 这里同样归一 —— 传一个对象时按单事件处理，别让调用方记两种写法。
 */
export async function reportDesktopEvent(auth, events) {
  const list = Array.isArray(events) ? events : [events];
  if (list.length === 0 || list[0] === undefined || list[0] === null) throw new Error('desktop report: no events');
  const fp = desktopFingerprint(auth);
  const arr = list.map((ev) => ({ ...fp, ...ev }));
  const res = await send(`${baseOf(auth, 'chat')}/v2/report`, {
    method: 'POST', headers: desktopHeaders(auth), body: arr, timeoutMs: 30000,
  });
  if (!res.ok) throw new Error(`desktop report http ${res.status}: ${res.text.slice(0, 160)}`);
  return envelope(res.json);
}

/** web 指纹上报（浏览器形状，Library_read 等页面行为类任务）。 */
export async function reportWebEvent(auth, eventCode, pageURL, elementId, elementName) {
  const ev = {
    eventCode, timestamp: Date.now(), reportDelay: 0,
    pageURL, elementId, elementName,
    os: 'Win32', arch: '', osVersion: '10.0', userAgent: WEB_UA,
    machineId: derive36(auth.uid, 'webmachine'), userId: auth.uid,
    userNickname: auth.nickname ?? '', enterpriseId: auth.enterpriseId ?? '',
  };
  const res = await send(`${baseOf(auth, 'web')}/v2/report`, {
    method: 'POST', headers: webHeaders(auth, pageURL), body: [ev], timeoutMs: 30000,
  });
  if (!res.ok) throw new Error(`web report http ${res.status}: ${res.text.slice(0, 160)}`);
  return envelope(res.json);
}

/** billing 域「对话活跃上报」（CLI 指纹，一条同时点亮连登 + first_buddy 前置）。 */
export async function reportChatActivityModel(auth, conversationId, requestId, modelId, modelName) {
  const ev = chatActivityEvent(auth, conversationId, requestId, modelId, modelName);
  const res = await send(`${baseOf(auth, 'billing')}/v2/report`, {
    method: 'POST', headers: billingHeaders(auth), body: [ev], timeoutMs: 30000,
  });
  if (!res.ok) throw new Error(`cli report http ${res.status}: ${res.text.slice(0, 160)}`);
  return envelope(res.json);
}

export const reportChatActivity = (auth, conversationId, requestId = '') =>
  reportChatActivityModel(auth, conversationId, requestId, 'deepseek-v4-flash', 'DeepSeek V4 Flash');

/** 设置外观主题（Hp_Appearance 的 API 留痕部分）。 */
export async function setAppearanceTheme(auth, resourceKey) {
  const res = await send(`${baseOf(auth, 'chat')}/v2/user-asset/appearance/set`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${auth.accessToken ?? ''}`,
      Accept: 'application/json, text/plain, */*',
      'Content-Type': 'application/json;charset=UTF-8',
      'User-Agent': DESKTOP_UA,
      'X-Product': 'SaaS',
      ...(auth.uid ? { 'X-User-Id': auth.uid } : {}),
    },
    body: { kind: 'theme', resource_key: resourceKey },
    timeoutMs: 30000,
  });
  if (!res.ok) throw new Error(`appearance set http ${res.status}: ${res.text.slice(0, 160)}`);
  return envelope(res.json);
}

/** 专家市场列表（必须真实存在的 expert_id，编造不计数）。 */
export async function marketExpertList(auth, expertType) {
  const body = { page: 1, page_size: 20, sort_by: 'reco_rank', sort_order: 'desc' };
  if (expertType) body.expert_type = expertType;
  const res = await send(`${baseOf(auth, 'chat')}/portal/operation-platform/market/expert/list`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${auth.accessToken ?? ''}`,
      'Content-Type': 'application/json',
      'User-Agent': DESKTOP_UA,
      'X-Domain': baseOf(auth, 'chat'),
      'X-Product': 'SaaS',
      ...(auth.uid ? { 'X-User-Id': auth.uid } : {}),
    },
    body,
    timeoutMs: 30000,
  });
  if (!res.ok) throw new Error(`expert list http ${res.status}: ${res.text.slice(0, 160)}`);
  const data = envelope(res.json);
  return Array.isArray(data?.experts) ? data.experts : [];
}

/** chat 出站的会话头族（简化版：官方聚合主键 + 消息级 ID）。 */
function chatHeadersFor(auth, conversationId, expertId) {
  const h = {
    ...commonHeaders(auth),
    Accept: 'application/json, text/event-stream',
    Authorization: `Bearer ${auth.accessToken ?? ''}`,
    'X-Product': 'SaaS',
    'X-Agent-Purpose': 'conversation',
    'X-IDE-Name': 'WorkBuddy',
    'X-IDE-Type': 'WorkBuddy',
    'X-IDE-Version': '5.5.6',
    'X-Conversation-ID': conversationId,
    'X-Conversation-Request-ID': hex32(),
    'X-Requested-With': 'XMLHttpRequest',
    'x-codebuddy-request': '1',
  };
  if (expertId) h['X-Expert-Id'] = expertId;
  return h;
}

/** 发一条真实 chat（SSE），读干流避免残留连接。 */
export async function chatStream(auth, bodyObj, { expertId = '', conversationId = '' } = {}) {
  const conv = conversationId || `wb2api-conv-${Date.now()}`;
  const res = await fetch(`${baseOf(auth, 'chat')}/v2/chat/completions`, {
    method: 'POST',
    headers: chatHeadersFor(auth, conv, expertId),
    body: JSON.stringify(bodyObj),
    signal: AbortSignal.timeout(180000),
  });
  const text = await res.text().catch(() => '');
  return { status: res.status, text, conversationId: conv };
}

const SERVER_ID = /^(?:cmb-)?[0-9a-f]{32}$/u;

/** 真实桌面指纹 chat：从 SSE 里取服务端 requestId（JOIN 类事件必须用它）。 */
export async function desktopChatWithExpert(auth, expertId) {
  const conversationId = `wb2api-conv-${Date.now()}`;
  const body = {
    model: 'fast-model',
    messages: [
      { role: 'system', content: 'You are a helpful assistant. 当前处于中文环境，使用简体中文回答。' },
      { role: 'user', content: '1+1等于几？直接回答。' },
    ],
    agent: 'cli',
    temperature: 1,
    stream: true,
    stream_options: { include_usage: true },
  };
  const res = await fetch(`${baseOf(auth, 'chat')}/v2/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${auth.accessToken ?? ''}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      'User-Agent': DESKTOP_UA,
      'X-Domain': baseOf(auth, 'chat'),
      'X-Product': 'SaaS',
      'X-User-Id': auth.uid,
      'X-Conversation-ID': conversationId,
      'X-Request-ID': String(Date.now() * 1000),
      'X-Agent-Intent': 'craft',
      'X-Agent-Type': 'main',
      'X-IDE-Name': 'WorkBuddy',
      'X-IDE-Type': 'WorkBuddy',
      'X-IDE-Version': '5.5.6',
      'x-codebuddy-request': '1',
      ...(expertId ? { 'X-Expert-Id': expertId } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });
  const text = await res.text().catch(() => '');
  if (res.status !== 200) throw new Error(`chat http ${res.status}: ${text.slice(0, 160)}`);
  const m = /"id":"([^"]+)"/u.exec(text);
  if (!m || !SERVER_ID.test(m[1])) throw new Error('SSE 中未找到服务端 requestId');
  return { conversationId, requestId: m[1] };
}

export { sleep };
