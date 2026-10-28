// qwen-extract.js — 用本地 Ollama qwen3.6 重新提炼女儿现有记忆，对比实体/黑名单质量
const fs = require('fs');
const v2 = require('C:/Users/Lenovo/Documents/DSH/qq-bot/bridge/lib/memory-v2.js');

const OLLAMA = 'http://127.0.0.1:11434';
const MODEL = 'qwen2.5:7b';

async function qwen(prompt, timeoutMs = 300000) {
  const res = await fetch(OLLAMA + '/api/generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, prompt, stream: false, format: 'json', options: { temperature: 0.1 } }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const data = await res.json();
  return data.response || '';
}

// 读女儿现有记忆（只读，不碰生产）
const prod = JSON.parse(fs.readFileSync('C:/Users/Lenovo/Documents/DSH/qq-bot/bridge/storage/memory-v2.json', 'utf8'));
const st = prod['u1528848072'] || {};
const all = [...(st.core || []), ...(st.entity || []), ...(st.event || []), ...(st.concept || [])]; // 全量
console.log('抽样记忆:', all.length, '条（共 ' + [...(st.core || []), ...(st.entity || []), ...(st.event || []), ...(st.concept || [])].length + ' 条）');

const KEY = 'qwen-' + Date.now();
const BATCH = 1; // 单条调用（批量输出 qwen3.6 撑不住）

async function main() {
  const entries = [];
  for (let i = 0; i < all.length; i += BATCH) {
    const batch = all.slice(i, i + BATCH);
    const m0 = batch[0];
    const prompt = '你是记忆提炼器。请为下面这条记忆提取：entities（涉及的人/物名，只提取具体实体，不要泛词）、keywords（8个检索关键词）、bucket（entity=稳定事实/event=发生过的事/concept=约定规则感悟）、importance（1-10）。\n输出 JSON 对象：{"entities":[],"keywords":[],"bucket":"entity|event|concept","importance":5}。只输出 JSON，不要其他文字。\n\n记忆：' + m0.text;
    try {
      const raw = await qwen(prompt);
      const objMatch = raw.match(/\{[\s\S]*\}/);
      const item = JSON.parse(objMatch ? objMatch[0] : '{}');
      if (item && (item.entities || item.keywords || item.bucket)) {
        entries.push({
          text: m0.text,
          bucket: ['entity', 'event', 'concept'].includes(item.bucket) ? item.bucket : 'event',
          importance: Math.max(1, Math.min(10, Number(item.importance) || 5)),
          entities: Array.isArray(item.entities) ? item.entities.slice(0, 6) : [],
          keywords: Array.isArray(item.keywords) ? item.keywords.slice(0, 8) : [],
        });
        process.stdout.write('.');
        if (i % 20 === 0) fs.writeFileSync('C:/Users/Lenovo/Documents/DSH/qwen-progress.json', JSON.stringify(entries));
      } else {
        console.log('\n条 ' + (i + 1) + ' 输出异常:', String(raw).slice(0, 100));
      }
    } catch (e) { console.log('\n批 ' + (i / BATCH + 1) + ' 失败:', e.message); }
  }
  console.log('\nqwen 提炼成功:', entries.length, '/', all.length);

  // 用同引擎跑（独立 key）
  v2.add(KEY, entries, { source: 'qwen' });
  v2.reinforce(KEY, entries);
  v2.prune(KEY);
  const qs = v2.stats(KEY);
  const qstate = v2.state()[KEY];
  const broad = qstate.meta.broadEntities || [];
  const entStats = qstate.meta.entityStats || {};
  console.log('\n=== qwen 提炼后引擎状态 ===', JSON.stringify(qs));
  console.log('宽泛实体（黑名单）:', JSON.stringify(broad));
  const topEnts = Object.entries(entStats).sort((a, b) => (b[1].degree || 0) - (a[1].degree || 0)).slice(0, 15);
  console.log('\n=== qwen 提炼的实体热度 top15 ===');
  for (const [e, s] of topEnts) console.log(`- ${e}: degree=${s.degree} avgW=${Math.round(s.avgWeight || 0)}`);

  // 对比：生产数据（DeepSeek 提炼）的实体
  const pstats = (st.meta && st.meta.entityStats) || {};
  const pBroad = (st.meta && st.meta.broadEntities) || [];
  console.log('\n=== 生产（DeepSeek）对比 ===');
  console.log('DeepSeek 黑名单:', JSON.stringify(pBroad), '| qwen 黑名单:', JSON.stringify(broad));
  const pTop = Object.entries(pstats).sort((a, b) => (b[1].degree || 0) - (a[1].degree || 0)).slice(0, 10);
  console.log('DeepSeek 实体热度 top10:', pTop.map(([e, s]) => `${e}(${s.degree})`).join('、'));
  console.log('qwen 实体热度 top10:', topEnts.slice(0, 10).map(([e, s]) => `${e}(${s.degree})`).join('、'));

  // 写结果（完整条目列表）
  const lines = ['qwen2.5:7b 提炼结果（同一引擎，完整长期记忆）', ''];
  lines.push('女儿现有记忆:', all.length, '条；qwen 提炼成功:', entries.length);
  lines.push('qwen 引擎状态:', JSON.stringify(qs));
  lines.push('qwen 黑名单:', JSON.stringify(broad));
  lines.push('DeepSeek 黑名单:', JSON.stringify(pBroad));
  lines.push('', '=== qwen 实体热度 ===');
  for (const [e, s] of topEnts) lines.push(`- ${e}: degree=${s.degree} avgW=${Math.round(s.avgWeight || 0)}`);
  lines.push('', '=== qwen 提炼条目示例 ===');
  for (const e of entries.slice(0, 10)) lines.push(`- [${e.bucket}] ${e.text.slice(0, 60)} | 实体: ${(e.entities || []).join('/')}`);
  // 完整桶条目（qwen 提炼后引擎的长期记忆）
  const qstate2 = v2.state()[KEY];
  const dumpBucket = (name, arr) => {
    lines.push('', '=== ' + name + '（' + arr.length + '）===');
    for (const m of arr) lines.push('- [' + Math.round(v2.weightOf(m)) + '] [' + m.bucket + '] ' + m.text + ' | 实体: ' + ((m.entities || []).join('/') || '无'));
  };
  dumpBucket('core', qstate2.core || []);
  dumpBucket('entity', qstate2.entity || []);
  dumpBucket('event', qstate2.event || []);
  dumpBucket('concept', qstate2.concept || []);
  lines.push('', '=== cold（' + (qstate2.cold || []).length + '）===');
  for (const m of (qstate2.cold || []).slice(0, 20)) lines.push('- ' + String(m.text).slice(0, 80));
  fs.writeFileSync('C:/Users/Lenovo/Desktop/qwen对比_2026-10-27.txt', '\ufeff' + lines.join('\r\n'), 'utf8');
  console.log('\n已写入桌面: qwen对比_2026-10-27.txt');

  delete v2.state()[KEY];
  v2.save();
  console.log('（测试数据已清理）');
  process.exit(0);
}
main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
