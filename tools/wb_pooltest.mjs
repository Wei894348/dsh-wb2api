/**
 * 池子调度验证：向网关发若干条极小请求，看新入池账号是否被选中并能正常出话。
 * 用法：node wb_pooltest.mjs [轮数]
 */
const BASE = 'http://127.0.0.1:7863';
const KEY = process.env.WB2A_KEY ?? JSON.parse(await (await import('node:fs/promises')).readFile(
  `${process.env.USERPROFILE}\\.dsh\\wb2api\\config.json`, 'utf8')).api_key;
const rounds = Number(process.argv[2] ?? 4);
const H = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

const before = await (await fetch(`${BASE}/status`, { headers: H })).json();
const snap = s => Object.fromEntries(s.accounts.map(a => [a.uid.slice(0, 8), { ok: a.success_count ?? 0, cr: a.credits ?? 0, off: !!a.disabled }]));

const models = await (await fetch(`${BASE}/v1/models`, { headers: H })).json();
const ids = (models.data ?? models.models ?? []).map(m => m.id);
const pick = ids.find(id => id.includes('flash')) ?? ids[0];
console.log(`[models] ${ids.length} 个，选用 ${pick}`);

for (let i = 1; i <= rounds; i += 1) {
  const t0 = Date.now();
  try {
    const res = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST', headers: H,
      body: JSON.stringify({ model: pick, max_tokens: 16, messages: [{ role: 'user', content: `只回复数字：${i}+${i}` }] }),
    });
    const body = await res.json();
    const text = body?.choices?.[0]?.message?.content ?? JSON.stringify(body).slice(0, 120);
    console.log(`  #${i} HTTP ${res.status} ${Date.now() - t0}ms :: ${String(text).replace(/\s+/gu, ' ').slice(0, 80)}`);
  } catch (error) {
    console.log(`  #${i} 失败：${error.message}`);
  }
}

const after = await (await fetch(`${BASE}/status`, { headers: H })).json();
const A = snap(before), B = snap(after);
console.log('\nuid      成功数Δ  积分      状态');
for (const uid of Object.keys(B)) {
  const d = B[uid].ok - (A[uid]?.ok ?? 0);
  console.log(`  ${uid}  ${d > 0 ? '+' + d : d}        ${String(B[uid].cr).padEnd(6)}   ${B[uid].off ? '禁用' : '启用'}`);
}
