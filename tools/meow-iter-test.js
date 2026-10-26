// meow-iter-test.js — 迭代测试：两阶段提炼 → 时间轴喂入 → 12 轮时间推进（每轮 30 天），观察保胎到期/重新保护/淘汰
const fs = require('fs');
const v2 = require('C:/Users/Lenovo/Documents/DSH/qq-bot/bridge/lib/memory-v2.js');

const FILE = 'C:/Users/Lenovo/Desktop/妹居物语_槽位1_备份_2026-10-26T09-31-08.txt';
const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const diary = j.data.diary;
const KEY = 'test-iter-' + Date.now();
const byDate = new Map();
for (const d of diary) byDate.set(String(d.date || '').slice(0, 10), d);

const brain = { apiKey: process.env.DEEPSEEK_API_KEY || '', baseUrl: 'https://api.deepseek.com/anthropic/v1', model: 'deepseek-chat' };
async function ask(prompt, maxTokens = 4096) {
  const res = await fetch(brain.baseUrl + '/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': brain.apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: brain.model, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const data = await res.json();
  return (data.content || []).map((c) => c.text || '').join('');
}
async function extract() {
  const entries = [];
  for (let i = 0; i < diary.length; i += 20) {
    const batch = diary.slice(i, i + 20);
    const text = batch.map((d) => `【${d.date}】${String(d.content || '').slice(0, 350)}`).join('\n\n');
    const prompt = '你是长期记忆提炼器。下面是某个人物的日记（按时间顺序）。请提炼成长期记忆条目（JSON数组），每条：{"text":"一句话事实","bucket":"entity|event|concept","importance":1-10,"entities":["涉及的人/物名"],"date":"事件发生的日期 YYYY-MM-DD（event 类必填）"}。entity=稳定事实；event=发生过的事（一句话）；concept=想法、约定、规则、感悟。只保留值得长期记住的，最多10条。只输出JSON数组。\n\n' + text;
    try {
      const raw = await ask(prompt);
      const m = raw.match(/\[[\s\S]*\]/);
      let arr = JSON.parse(m ? m[0] : '[]');
      arr = (Array.isArray(arr) ? arr : []).filter((e) => e && typeof e === 'object' && e.text);
      entries.push(...arr);
      process.stdout.write('.');
    } catch (e) { console.log('\n批失败:', e.message); }
  }
  return entries;
}

async function main() {
  console.log('=== 两阶段提炼（骨架）===');
  const entries = await extract();
  console.log('\n骨架:', entries.length);
  // 时间轴喂入（按 date 排序，每 8 条一批）
  const dated = entries.map((e) => ({ e, t: byDate.has(String(e.date || '').slice(0, 10)) ? Number(byDate.get(String(e.date).slice(0, 10)).timestamp) : Date.now() }));
  dated.sort((a, b) => a.t - b.t);
  for (let i = 0; i < dated.length; i += 8) {
    const chunk = dated.slice(i, i + 8);
    v2.add(KEY, chunk.map(({ e }) => e), { source: 'timeline', createdAt: chunk[0].t });
    v2.reinforce(KEY, chunk.map(({ e }) => e));
    v2.prune(KEY);
  }
  let st = v2.stats(KEY);
  console.log('\n初始（时间轴喂入后）:', JSON.stringify(st));

  // 迭代：12 轮，每轮时间推进 30 天
  const DAY = 86400000;
  const rows = [];
  for (let round = 1; round <= 12; round++) {
    const state = v2.state()[KEY];
    for (const k of ['core', 'entity', 'event', 'concept']) {
      for (const m of state[k] || []) {
        if (m && m.createdAt) m.createdAt -= 30 * DAY;
        if (m && m.lastHitAt) m.lastHitAt -= 30 * DAY;
        if (m && m.protectedUntil) m.protectedUntil -= 30 * DAY;
      }
    }
    const pr = v2.prune(KEY);
    const s2 = v2.stats(KEY);
    rows.push({ round, total: s2.total, core: s2.core, prot: s2.protected, cold: s2.cold, del: pr.deleted, overflow: pr.overflow, avgW: Math.round(s2.avgWeight) });
    console.log('轮 ' + String(round).padEnd(2) + ' 总数 ' + String(s2.total).padEnd(5) + ' core ' + String(s2.core).padEnd(4) + ' 保胎 ' + String(s2.protected).padEnd(4) + ' cold ' + String(s2.cold).padEnd(5) + ' 删 ' + String(pr.deleted).padEnd(3) + ' 溢出 ' + String(pr.overflow).padEnd(3) + ' 均重 ' + s2.avgWeight.toFixed(0));
  }
  st = v2.stats(KEY);
  const state = v2.state()[KEY];
  const protectedNow = [...state.entity, ...state.event, ...state.concept].filter((m) => m.protectedUntil && m.protectedUntil > Date.now());
  console.log('\n=== 12 轮终态 ===', JSON.stringify(st));
  console.log('=== 仍受保护（' + protectedNow.length + '）===');
  for (const m of protectedNow) console.log('- ' + String(m.text).slice(0, 60) + ' (自: ' + m.protectedFrom + ')');
  const issues = [];
  if (st.total > 190) issues.push('总量失控');
  if (st.core > 20) issues.push('core 溢出');
  if (st.protected > 30) issues.push('保胎溢出');
  if (st.total < 30) issues.push('记忆大量流失');
  console.log('失衡判断:', issues.length ? '⚠️ ' + issues.join('；') : '✅ 12 轮迭代未发现失衡');
  // 写文件
  const lines = ['妹居物语 · 迭代测试（两阶段数据 + 12 轮时间推进，每轮 30 天）', '来源：169 篇日记，两阶段提炼 ' + entries.length + ' 条', ''];
  lines.push('轮  总数  core 保胎  cold  删  溢出  均重');
  for (const r of rows) lines.push(r.round + '   ' + r.total + '   ' + r.core + '   ' + r.prot + '   ' + r.cold + '   ' + r.del + '   ' + r.overflow + '   ' + r.avgW);
  lines.push('', '=== 终态 ===', JSON.stringify(st), '', '=== 仍受保护（' + protectedNow.length + '）===');
  for (const m of protectedNow) lines.push('- ' + m.text + ' (自: ' + m.protectedFrom + ')');
  lines.push('', '失衡判断: ' + (issues.length ? '⚠️ ' + issues.join('；') : '✅ 12 轮未发现失衡'));
  fs.writeFileSync('C:/Users/Lenovo/Desktop/妹居物语_迭代测试_2026-10-27.txt', '\ufeff' + lines.join('\r\n'), 'utf8');
  console.log('\n已写入桌面: 妹居物语_迭代测试_2026-10-27.txt');
  delete v2.state()[KEY];
  v2.save();
  console.log('（测试数据已清理）');
  process.exit(0);
}
main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
