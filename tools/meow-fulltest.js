// meow-fulltest.js — v3 两阶段提炼：①v1 标定事件骨架（带日期）②反查日记原文 ③批量细化情景 ④替换输出
const fs = require('fs');
const v2 = require('C:/Users/Lenovo/Documents/DSH/qq-bot/bridge/lib/memory-v2.js');

const FILE = 'C:/Users/Lenovo/Desktop/妹居物语_槽位1_备份_2026-10-26T09-31-08.txt';
const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const diary = j.data.diary;
const KEY = 'test-meow-' + Date.now();
const byDate = new Map();
for (const d of diary) byDate.set(String(d.date || '').slice(0, 10), d);

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
  if (!res.ok) throw new Error('HTTP ' + res.status + ': ' + (await res.text()).slice(0, 200));
  const data = await res.json();
  return (data.content || []).map((c) => c.text || '').join('');
}

// ---- 第一轮：v1 标定（一句话 + date）----
async function stage1() {
  const batches = [];
  for (let i = 0; i < diary.length; i += 20) batches.push(diary.slice(i, i + 20));
  const entries = [];
  for (let bi = 0; bi < batches.length; bi++) {
    const batch = batches[bi];
    const text = batch.map((d) => `【${d.date}】${String(d.content || '').slice(0, 350)}`).join('\n\n');
    const prompt = '你是长期记忆提炼器。下面是某个人物的日记（按时间顺序）。请提炼成长期记忆条目（JSON数组），每条：{"text":"一句话事实","bucket":"entity|event|concept","importance":1-10,"entities":["涉及的人/物名"],"date":"事件发生的日期 YYYY-MM-DD（event 类必填）"}。entity=关于人物/物品的稳定事实（性格、喜好、关系）；event=发生过的事（一句话骨架）；concept=想法、约定、规则、重要感悟。只保留值得长期记住的，丢弃日常琐碎，最多10条。只输出JSON数组。\n\n' + text;
    try {
      const raw = await ask(prompt);
      const m = raw.match(/\[[\s\S]*\]/);
      let arr = JSON.parse(m ? m[0] : '[]');
      arr = (Array.isArray(arr) ? arr : []).filter((e) => e && typeof e === 'object' && e.text);
      entries.push(...arr);
      process.stdout.write('.');
    } catch (e) { console.log('\n第一轮批 ' + (bi + 1) + ' 失败:', e.message); }
  }
  return entries;
}

// ---- 第二轮：按 date 反查原文，批量细化 event ----
async function stage2(entries) {
  const events = entries.filter((e) => e.bucket === 'event' && e.date);
  const detailed = new Map();
  const GROUP = 5;
  for (let i = 0; i < events.length; i += GROUP) {
    const group = events.slice(i, i + GROUP);
    const blocks = group.map((e, idx) => {
      const day = byDate.get(String(e.date).slice(0, 10));
      const src = day ? String(day.content || '').slice(0, 700) : '（原文缺失）';
      return `### 事件${idx + 1}（${e.date}）：${e.text}\n【当天日记原文】${src}`;
    }).join('\n\n');
    const prompt = '下面是若干事件骨架和它们对应的日记原文。请为每个事件写一段详细的情景描述（80~200字）：保留时间、场景、对话原话、情绪感受，不要压成总结。输出 JSON 数组，每个元素：{"index":1,"text":"详细情景描述"}。只输出 JSON 数组。\n\n' + blocks;
    try {
      const raw = await ask(prompt, 4096);
      const m = raw.match(/\[[\s\S]*\]/);
      const arr = JSON.parse(m ? m[0] : '[]');
      for (const item of Array.isArray(arr) ? arr : []) {
        const idx = Number(item.index) - 1;
        if (idx >= 0 && idx < group.length && item.text) detailed.set(group[idx], String(item.text).slice(0, 300));
      }
      process.stdout.write('+');
    } catch (e) { console.log('\n第二轮批 ' + (i / GROUP + 1) + ' 失败:', e.message); }
  }
  let replaced = 0;
  for (const e of entries) {
    if (e.bucket === 'event' && detailed.has(e)) { e.text = detailed.get(e); replaced++; }
  }
  return { replaced, total: events.length };
}

async function main() {
  console.log('=== 第一轮：标定事件骨架 ===');
  const entries = await stage1();
  console.log('\n骨架条目:', entries.length, '（event:', entries.filter((e) => e.bucket === 'event').length, '）');
  console.log('=== 第二轮：反查原文细化 ===');
  const r2 = await stage2(entries);
  console.log('\n细化:', r2.replaced + '/' + r2.total, '个事件');
  v2.add(KEY, entries, { source: 'meow-test' });
  v2.reinforce(KEY, entries);
  const st0 = v2.state()[KEY];
  for (const k of ['core', 'entity', 'event', 'concept', 'cold']) st0[k] = (st0[k] || []).filter((x) => x && typeof x === 'object');
  const pr = v2.prune(KEY);
  const st = v2.stats(KEY);
  const state = v2.state()[KEY];
  console.log('\n=== 完成 ===');
  console.log('条目:', entries.length, '；prune:', JSON.stringify(pr));
  console.log('统计:', JSON.stringify(st));
  const dump = (name, arr) => {
    console.log(`\n=== ${name}（${arr.length}）===`);
    for (const m of arr.slice(0, 6)) console.log(`- [${v2.weightOf(m).toFixed(0)}] ${m.text.slice(0, 100)}`);
  };
  dump('core', state.core);
  dump('event', state.event);
  const lines = [];
  lines.push('妹居物语 · 长期记忆提取结果 v3（两阶段：骨架标定 + 原文细化）');
  lines.push('来源：169 篇日记（2026-02-28 ~ 2026-09-29）');
  lines.push('生成：2026-10-27  引擎：qq-daughter-memory v2.1');
  lines.push('统计：core ' + st.core + ' / entity ' + st.entity + ' / event ' + st.event + ' / concept ' + st.concept + ' / 冷存储 ' + st.cold + ' / 提炼 ' + entries.length + ' / 细化 ' + r2.replaced + ' 个事件');
  lines.push('');
  const dumpTxt = (name, arr) => {
    lines.push('【' + name + '】(' + arr.length + ' 条)');
    arr.forEach((m, i) => { lines.push(String(i + 1).padStart(2) + '. [' + String(Math.round(v2.weightOf(m))).padStart(4) + '] ' + m.text); lines.push('     实体: ' + ((m.entities || []).join('/') || '（无）')); });
    lines.push('');
  };
  dumpTxt('核心记忆 core', state.core);
  dumpTxt('实体 entity（语义）', state.entity);
  dumpTxt('事件 event（情景·两阶段细化）', state.event);
  dumpTxt('概念 concept（语义）', state.concept);
  fs.writeFileSync('C:/Users/Lenovo/Desktop/妹居物语_长期记忆结果_v3_2026-10-27.txt', '\ufeff' + lines.join('\r\n'), 'utf8');
  console.log('\n已写入桌面: 妹居物语_长期记忆结果_v3_2026-10-27.txt');
  delete v2.state()[KEY];
  v2.save();
  console.log('（测试数据已清理）');
  process.exit(0);
}
main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
