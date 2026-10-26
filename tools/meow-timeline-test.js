// meow-timeline-test.js — 时间轴测试：日记日期作为记忆创建时间，按周分批喂入 v2.1 引擎，观察保胎/淘汰/话题漂移
const fs = require('fs');
const v2 = require('C:/Users/Lenovo/Documents/DSH/qq-bot/bridge/lib/memory-v2.js');

const FILE = 'C:/Users/Lenovo/Desktop/妹居物语_槽位1_备份_2026-10-26T09-31-08.txt';
const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const diary = j.data.diary;
const KEY = 'test-tl-' + Date.now();
const byDate = new Map();
for (const d of diary) byDate.set(String(d.date || '').slice(0, 10), d);
const tsOf = (dateStr) => { const d = byDate.get(String(dateStr || '').slice(0, 10)); return d ? Number(d.timestamp) || new Date(dateStr).getTime() : Date.now(); };

const brain = {
  apiKey: process.env.DEEPSEEK_API_KEY || '',
  baseUrl: 'https://api.deepseek.com/anthropic/v1',
  model: 'deepseek-chat',
};
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
    const prompt = '你是长期记忆提炼器。下面是某个人物的日记（按时间顺序）。请提炼成长期记忆条目（JSON数组），每条：{"text":"一句话事实","bucket":"entity|event|concept","importance":1-10,"entities":["涉及的人/物名"],"date":"事件发生的日期 YYYY-MM-DD（event 类必填）"}。entity=稳定事实；event=发生过的事（一句话骨架）；concept=想法、约定、规则、感悟。只保留值得长期记住的，最多10条。只输出JSON数组。\n\n' + text;
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
  // 按 date 排序（有 date 用 date，否则用相邻）
  const dated = entries.map((e) => ({ e, t: tsOf(e.date) }));
  dated.sort((a, b) => a.t - b.t);
  // 按周分组（7 天=1 周）
  const groups = [];
  let cur = [];
  let curWeek = null;
  for (const { e, t } of dated) {
    const week = Math.floor((t - dated[0].t) / (7 * 86400000));
    if (curWeek === null || week === curWeek) { cur.push({ e, t }); curWeek = week !== undefined ? curWeek : week; }
    if (cur.length && week !== curWeek && curWeek !== null) { groups.push(cur); cur = [{ e, t }]; curWeek = week; }
    else if (curWeek === null) { curWeek = week; }
  }
  if (cur.length) groups.push(cur);
  // 简化：按每 8 条一批（近似周）
  const chunks = [];
  for (let i = 0; i < dated.length; i += 8) chunks.push(dated.slice(i, i + 8));

  console.log('时间轴批次:', chunks.length, '（每批约8条）');
  const rows = [];
  for (const chunk of chunks) {
    const addEntries = chunk.map(({ e }) => e);
    v2.add(KEY, addEntries, { source: 'timeline', createdAt: chunk[0].t });
    v2.reinforce(KEY, addEntries);
    const st0 = v2.state()[KEY];
    for (const k of ['core', 'entity', 'event', 'concept', 'cold']) st0[k] = (st0[k] || []).filter((x) => x && typeof x === 'object');
    const pr = v2.prune(KEY);
    const st = v2.stats(KEY);
    const dateStr = new Date(chunk[0].t).toISOString().slice(0, 10);
    rows.push({ dateStr, total: st.total, core: st.core, prot: st.protected, cold: st.cold, overflow: pr.overflow, avgW: Math.round(st.avgWeight) });
  }
  console.log('日期        总数  core 保胎  cold  溢出  均重');
  for (const r of rows) {
    console.log(r.dateStr.padEnd(12) + String(r.total).padEnd(6) + String(r.core).padEnd(6) + String(r.prot).padEnd(6) + String(r.cold).padEnd(6) + String(r.overflow).padEnd(6) + r.avgW);
  }
  const st = v2.stats(KEY);
  const state = v2.state()[KEY];
  const protectedItems = [...state.entity, ...state.event, ...state.concept].filter((m) => m.protectedUntil && m.protectedUntil > Date.now());
  console.log('\n=== 终态 ===', JSON.stringify(st));
  console.log('=== 保胎条目（' + protectedItems.length + '）===');
  for (const m of protectedItems) {
    console.log('- [' + Math.round(v2.weightOf(m)) + '] ' + String(m.text).slice(0, 70) + '  (保护自: ' + m.protectedFrom + '，到期: ' + new Date(m.protectedUntil).toISOString().slice(0, 10) + ')');
  }
  const mainStats = state.meta.entityStats || {};
  const mains = Object.entries(mainStats).filter(([, s]) => (s.peakDegree || 0) >= 15 || (s.peakWeight || 0) >= 80);
  console.log('\n=== 主节点（保胎判定）===');
  for (const [ent, s] of mains) console.log(`- ${ent}: peakDegree=${s.peakDegree} peakWeight=${Math.round(s.peakWeight || 0)}`);
  // 写结果
  const lines = ['妹居物语 · 时间轴 + 保胎测试（v2.1 引擎，日记日期作为记忆时间）', '来源：169 篇日记（2026-02-28 ~ 2026-09-29）', ''];
  lines.push('日期        总数  core 保胎  cold  溢出  均重');
  for (const r of rows) lines.push(r.dateStr.padEnd(12) + String(r.total).padEnd(6) + String(r.core).padEnd(6) + String(r.prot).padEnd(6) + String(r.cold).padEnd(6) + String(r.overflow).padEnd(6) + r.avgW);
  lines.push('', '=== 保胎条目（' + protectedItems.length + '）===');
  for (const m of protectedItems) lines.push('- [' + Math.round(v2.weightOf(m)) + '] ' + m.text + '  (保护自: ' + m.protectedFrom + ')');
  lines.push('', '=== 主节点 ===');
  for (const [ent, s] of mains) lines.push('- ' + ent + ': peakDegree=' + s.peakDegree + ' peakWeight=' + Math.round(s.peakWeight || 0));
  fs.writeFileSync('C:/Users/Lenovo/Desktop/妹居物语_时间轴保胎测试_2026-10-27.txt', '\ufeff' + lines.join('\r\n'), 'utf8');
  console.log('\n已写入桌面: 妹居物语_时间轴保胎测试_2026-10-27.txt');
  delete v2.state()[KEY];
  v2.save();
  console.log('（测试数据已清理）');
  process.exit(0);
}
main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
