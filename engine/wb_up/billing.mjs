/**
 * billing 域只读查询：个人号积分（分包清单）。
 * 端点取自 dsh-plugin-wb2api-ui 的实测口径：POST {billingBase}/v2/billing/meter/get-user-resource。
 */
import { baseOf, billingHeaders, send, envelope } from './core.mjs';

/** 上游要的 `YYYY-MM-DD HH:mm:ss`（本地时区）。 */
function stamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
    + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function pickNumber(row, fields) {
  for (const f of fields) {
    const raw = row?.[f];
    if (raw === undefined || raw === null || raw === '') continue;
    const v = Number(raw);
    if (Number.isFinite(v)) return v;
  }
  return null;
}

const REMAIN_FIELDS = [
  'SlicePeriodCapacityRemainPrecise', 'SlicePeriodCapacityRemain',
  'CycleCapacityRemainPrecise', 'CycleCapacityRemain',
  'CapacityRemainPrecise', 'CapacityRemain', 'RemainPrecise', 'Remain', 'Remaining', 'Balance',
];

/** 账号剩余积分（Σ 各包余量）。 */
export async function balance(auth) {
  const now = new Date();
  const url = `${baseOf(auth, 'billing')}/v2/billing/meter/get-user-resource`;
  const body = {
    PageNumber: 1,
    PageSize: 100,
    ProductCode: 'p_tcaca',
    Status: [0, 3],
    PackageEndTimeRangeBegin: stamp(now),
    PackageEndTimeRangeBeginTime: stamp(now),
    PackageEndTimeRangeEnd: stamp(new Date(now.getTime() + 365 * 101 * 24 * 3600 * 1000)),
  };
  const res = await send(url, { headers: billingHeaders(auth), body, timeoutMs: 20000 });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = envelope(res.json) ?? {};
  const rows = data?.Response?.Data?.Accounts ?? [];
  let total = 0;
  for (const row of rows) {
    const remain = pickNumber(row, REMAIN_FIELDS);
    if (remain !== null && remain > 0) total += remain;
  }
  return Math.round(total * 100) / 100;
}
