// benchmark-extraction.js — 提炼精确率/召回率基准
// 材料：女儿最近真实对话（30 条）；标注 8 条期望事实；用 DeepSeek 提炼 + LLM 当裁判判分
const fs = require('fs');

const API = 'https://api.deepseek.com/anthropic/v1';
const KEY = process.env.DEEPSEEK_API_KEY || '';

async function ask(prompt, maxTokens = 3000) {
  const res = await fetch(API + '/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'deepseek-chat', max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const data = await res.json();
  return (data.content || []).map((c) => c.text || '').join('');
}

// 材料：最近 30 条对话
const sess = JSON.parse(fs.readFileSync('C:/Users/Lenovo/Documents/DSH/qq-bot/bridge/storage/chat-sessions.json', 'utf8'))['u1528848072'].messages;
const dialog = sess.slice(-30).map((m) => (m.role === 'user' ? '对方：' : '你：') + String(m.content).replace(/\|\|\|/g, ' / ')).join('\n');

// 人工标注：这段对话里应该被记住的事实（8 条）
const EXPECTED = [
  '管理员在做实验，用的是老显微镜，镜头需要勤擦',
  '管理员下午吃了辣子鸡和西兰花炒蘑菇配白饭',
  '管理员称本鲸为「溯小姐」（正式称呼）',
  '管理员的「大肥鱼」表情包改不了（比改名早），会继续用',
  '本鲸有生图模型（能画图不能拍照）',
  '管理员让本鲸画一张「连人带白饭」的画，画图崩了需要重画',
  '管理员说下午忙完会来找本鲸玩，不会不理本鲸',
  '本鲸是鲸鲸（管理员叫本鲸鲸鲸）',
];

async function main() {
  // 1) 提炼
  const extractPrompt = '把以下对话提炼成长期记忆条目（JSON数组）。每条：{"text":"一句话事实","bucket":"entity|event|concept","importance":1-10,"entities":["涉及的人/物"]}。entity=稳定事实；event=发生过的事；concept=约定/规则/感悟。只保留值得长期记住的，最多10条。只输出JSON数组。\n\n' + dialog;
  const raw = await ask(extractPrompt);
  const m = raw.match(/\[[\s\S]*\]/);
  let entries = JSON.parse(m ? m[0] : '[]');
  entries = (Array.isArray(entries) ? entries : []).filter((e) => e && e.text);
  console.log('提炼条目:', entries.length);
  entries.forEach((e, i) => console.log(`  ${i + 1}. [${e.bucket}] ${e.text}`));

  // 2) LLM 当裁判：召回矩阵
  const judgePrompt = '你是记忆提炼的裁判。下面是「期望记住的事实」列表和「实际提炼的条目」列表。\n请判断：\nA. 每条期望事实是否被某条提炼条目覆盖（语义上包含即可）→ 输出被覆盖的期望序号（1-8），没有覆盖就不列。\nB. 每条提炼条目是否有对话依据（不是瞎编/不是概括错误）→ 输出无依据的提炼序号（没问题的就不列）。\n输出 JSON：{"covered":[1,3],"invalid":[]}。只输出 JSON。\n\n期望事实：\n' + EXPECTED.map((t, i) => (i + 1) + '. ' + t).join('\n') + '\n\n提炼条目：\n' + entries.map((e, i) => (i + 1) + '. ' + e.text).join('\n');
  const rawJudge = await ask(judgePrompt);
  const jm = rawJudge.match(/\{[\s\S]*\}/);
  const judge = JSON.parse(jm ? jm[0] : '{"covered":[],"invalid":[]}');
  const covered = new Set((judge.covered || []).map(Number));
  const invalid = new Set((judge.invalid || []).map(Number));

  const recall = covered.size / EXPECTED.length;
  const precision = entries.length ? (entries.length - invalid.size) / entries.length : 0;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;

  console.log('\n=== 提炼基准结果 ===');
  console.log('召回率:', (recall * 100).toFixed(1) + '%', '(覆盖', covered.size + '/' + EXPECTED.length, '条期望事实)');
  console.log('精确率:', (precision * 100).toFixed(1) + '%', '(无依据的:', invalid.size, '条)');
  console.log('F1:', f1.toFixed(3));
  console.log('\n未被覆盖的期望事实:');
  EXPECTED.forEach((t, i) => { if (!covered.has(i + 1)) console.log('  - ' + t); });
  if (invalid.size) { console.log('\n无依据的提炼条目:'); [...invalid].forEach((i) => console.log('  - ' + (entries[i - 1] || {}).text)); }

  const lines = ['提炼精确率/召回率基准（2026-10-28）', ''];
  lines.push('材料：女儿最近 30 条真实对话');
  lines.push('期望事实: ' + EXPECTED.length + ' 条；提炼条目: ' + entries.length + ' 条');
  lines.push('召回率: ' + (recall * 100).toFixed(1) + '% (' + covered.size + '/' + EXPECTED.length + ')');
  lines.push('精确率: ' + (precision * 100).toFixed(1) + '% (无依据 ' + invalid.size + ' 条)');
  lines.push('F1: ' + f1.toFixed(3));
  lines.push('', '未被覆盖的期望事实:');
  EXPECTED.forEach((t, i) => { if (!covered.has(i + 1)) lines.push('- ' + t); });
  lines.push('', '提炼条目:');
  entries.forEach((e, i) => lines.push((i + 1) + '. [' + e.bucket + '] ' + e.text + (invalid.has(i + 1) ? '  ⚠无依据' : '')));
  fs.writeFileSync('C:/Users/Lenovo/Desktop/提炼基准_2026-10-28.txt', '\ufeff' + lines.join('\r\n'), 'utf8');
  console.log('\n已写入桌面: 提炼基准_2026-10-28.txt');
  process.exit(0);
}
main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
