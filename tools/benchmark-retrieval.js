// benchmark-retrieval.js — 检索基准：Recall@12 / MRR / Precision@12
// 读 dsh-memory/benchmark/queries.json（query + expect 片段），对女儿记忆跑 memoryV2.formatForPrompt，算指标。
// 对照：最近12条（时间序）、随机12条、全量（token 数对比）。
const fs = require('fs');
const v2 = require('C:/Users/Lenovo/Documents/DSH/qq-bot/bridge/lib/memory-v2.js');

const KEY = 'u1528848072';
const QUERIES = JSON.parse(fs.readFileSync('C:/Users/Lenovo/Documents/DSH/dsh-memory/benchmark/queries.json', 'utf8'));
const TOPN = 12;

const state = v2.state()[KEY];
const all = [...(state.core || []), ...(state.entity || []), ...(state.event || []), ...(state.concept || [])];

function matches(entries, expect) {
  // 返回命中的条目下标集合
  const hit = new Set();
  for (let i = 0; i < entries.length; i++) {
    const text = String(entries[i].text || '');
    if (expect.some((e) => text.includes(e))) hit.add(i);
  }
  return hit;
}

function evaluate(name, pickFn) {
  let recallSum = 0, mrrSum = 0, precSum = 0, n = 0;
  for (const q of QUERIES) {
    const picked = pickFn(q.query);
    const expectIdx = matches(all, q.expect);
    const pickedIdx = picked.map((m) => all.indexOf(m));
    let firstHit = 0;
    for (let r = 0; r < pickedIdx.length; r++) {
      if (expectIdx.has(pickedIdx[r])) { firstHit = r + 1; break; }
    }
    const hitsInTop = pickedIdx.filter((i) => expectIdx.has(i)).length;
    recallSum += expectIdx.size ? Math.min(1, hitsInTop / expectIdx.size) : 0;
    mrrSum += firstHit ? 1 / firstHit : 0;
    precSum += picked.length ? hitsInTop / picked.length : 0;
    n++;
  }
  console.log(`\n=== ${name} ===`);
  console.log(`Recall@12: ${(recallSum / n).toFixed(3)}  MRR: ${(mrrSum / n).toFixed(3)}  Precision@12: ${(precSum / n).toFixed(3)}`);
  return { recall: recallSum / n, mrr: mrrSum / n, precision: precSum / n };
}

function tokm(s) { return String(s || '').length; } // 粗估：字符数

const results = {};
// 1) 我们的引擎
results.engine = evaluate('我们的引擎 formatForPrompt', (query) => {
  const { picked } = v2.retrieve(KEY, query, TOPN);
  return picked;
});
// 2) 最近 12 条（时间序）
const sortedByTime = all.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
results.recent = evaluate('对照：最近 12 条（时间序）', () => sortedByTime.slice(0, TOPN));
// 3) 随机 12 条（固定种子）
let seed = 42;
function rnd() { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; }
results.random = evaluate('对照：随机 12 条', () => {
  const idx = new Set();
  while (idx.size < Math.min(TOPN, all.length)) idx.add(Math.floor(rnd() * all.length));
  return [...idx].map((i) => all[i]);
});

// 4) 全量注入（上限对比，token 成本）
const fullText = v2.formatForPrompt(KEY, '管理员爱喝什么啤酒', { recall: true });
const engineText = v2.formatForPrompt(KEY, '管理员爱喝什么啤酒');
console.log('\n=== token 成本（字符数粗估）===');
console.log('引擎注入（单次）:', tokm(engineText), '字符');
console.log('全量注入（recall）:', tokm(fullText), '字符');

// 写结果
const lines = ['记忆检索基准（女儿 178 条记忆，30 个标注查询）', ''];

const out = ['日期: ' + new Date().toISOString().slice(0, 10), ''];
for (const [k, v] of Object.entries(results)) {
  out.push(k + ': Recall@12=' + v.recall.toFixed(3) + ' MRR=' + v.mrr.toFixed(3) + ' Precision@12=' + v.precision.toFixed(3));
}
out.push('', 'token 成本: 引擎注入=' + tokm(engineText) + ' 字符, 全量=' + tokm(fullText) + ' 字符');
fs.writeFileSync('C:/Users/Lenovo/Desktop/记忆检索基准_2026-10-27.txt', '\ufeff' + out.join('\r\n'), 'utf8');
console.log('\n已写入桌面: 记忆检索基准_2026-10-27.txt');

// 详细（每查询是否命中 top1/前3）
console.log('\n=== 逐查询（引擎）===');
for (const q of QUERIES) {
  const { picked } = v2.retrieve(KEY, q.query, TOPN);
  const expectIdx = matches(all, q.expect);
  const pickedIdx = picked.map((m) => all.indexOf(m));
  const first = pickedIdx.findIndex((i) => expectIdx.has(i));
  console.log(`- ${q.query} → ${first >= 0 ? '命中(top' + (first + 1) + ')' : '未命中'}`);
}
process.exit(0);
