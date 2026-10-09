/**
 * growth 域接口（chatBase，不带 /v2 前缀，用 BillingHeaders）。
 * 覆盖：猫猫档案 / 领养 / 协议 / 连登 / 旅行。
 */
import { baseOf, billingHeaders, send, envelope } from './core.mjs';

const PATHS = {
  travelStatus: '/activity/growth/buddy/travel/status',
  travelDepart: '/activity/growth/buddy/travel/depart',
  travelClaim: '/activity/growth/buddy/travel/claim',
  buddyInfo: '/activity/growth/buddy/info',
  buddyFirst: '/activity/growth/buddy/first',
  buddyAgreement: '/activity/growth/buddy/agreement',
  streak: '/activity/growth/streak',
};

/** 领养门槛未达标的业务错误关键词（HTTP 400 时出现），调用方应静默跳过。 */
const BUDDY_INCOMPLETE = 'first_buddy task not completed yet';
export const isBuddyTaskIncomplete = (err) => String(err?.message ?? '').includes(BUDDY_INCOMPLETE);

async function growthJSON(auth, method, path, body) {
  const res = await send(`${baseOf(auth, 'chat')}${path}`, {
    method,
    headers: billingHeaders(auth),
    body: body === undefined ? undefined : body,
    timeoutMs: 20000,
  });
  if (!res.ok) {
    const err = new Error(res.json?.msg ?? res.json?.message ?? `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return envelope(res.json);
}

/** 领养第一只 Buddy（+300 分，前置是当日活跃上报）。 */
export async function buddyFirst(auth) {
  return growthJSON(auth, 'POST', PATHS.buddyFirst, {});
}

/** 同意 Buddy 协议（幂等）。 */
export async function buddyAgreement(auth) {
  return growthJSON(auth, 'POST', PATHS.buddyAgreement, { agree: true });
}

/** 当前猫档案；null = 无猫。 */
export async function buddyInfo(auth) {
  const data = await growthJSON(auth, 'GET', PATHS.buddyInfo);
  const b = data?.buddy;
  return b === null || b === undefined ? null : b;
}

/** 连登天数（只读 oracle；0 = 活跃上报可能被静默丢弃）。 */
export async function growthStreak(auth) {
  const data = await growthJSON(auth, 'GET', PATHS.streak);
  return Number(data?.streak?.days ?? 0);
}

/** 猫猫旅行状态。 */
export async function travelStatus(auth) {
  return growthJSON(auth, 'GET', PATHS.travelStatus);
}

/** 派出猫猫旅行（今日已派出会被上游拒，属正常）。 */
export async function travelDepart(auth) {
  return growthJSON(auth, 'POST', PATHS.travelDepart, {});
}

/** 到站领奖（record_id 必带）。 */
export async function travelClaim(auth, recordId) {
  return growthJSON(auth, 'POST', PATHS.travelClaim, { record_id: recordId });
}
