// benchmark-compression.js — 压缩后基准
// 压缩前 vs 压缩后（dedupe + prune + cold 压缩），关键事实的检索召回是否保持
const fs = require('fs');
const v2 = require('C:/Users/Lenovo/Documents/DSH/qq-bot/bridge/lib/memory-v2.js');

const KEY = 'cmp-' + Date.now();
const SRC = 'C:/Users/Lenovo/Documents/DSH/qq-bot/bridge/storage/memory-v2.json';
const QUERIES = JSON.parse(fs.readFileSync('C:/Users/Lenovo/Documents/DSH/dsh-memory/benchmark/queries.json', 'utf8'));
const TOPN = 12;
const DAY = 86400000;

// 复制生产记忆（只读源）
const prod = JSON.parse(fs.readFileSync(SRC, 'utf8'))['u1528848072'];
v2.state()[KEY] = JSON.parse(JSON.stringify(prod));

function recall() {
  const state = v2.state()[KEY];
  const all = [...(state.entity || []), ...(state.event || []), ...(state.concept || [])];
  let sum = 0, n = 0;
  for (const q of QUERIES) {
    const expectIdx = new Set();
    for (let i = 0; i < all.length; i++) if (q.expect.some((e) => String(all[i].text).includes(e))) expectIdx.add(i);
    const { picked } = v2.retrieve(KEY, q.query, TOPN);
    const pickedIdx = picked.map((m) => all.indexOf(m));
    const hits = pickedIdx.filter((i) => expectIdx.has(i)).length;
    sum += expectIdx.size ? Math.min(1, hits / expectIdx.size) : 0;
    n++;
  }
  return { recall: sum / n, total: all.length, cold: (state.cold || []).length };
}

const before = recall();
console.log('压缩前:', JSON.stringify(before));

// 模拟压缩：①近重复合并 + 多轮 prune（剪枝）②加垃圾触发 cold 压缩
for (let k = 0; k < 5; k++) v2.prune(KEY);
for (let i = 0; i < 400; i++) v2.add(KEY, [{ text: `垃圾${i}：低分日常`, bucket: 'event', importance: 1, entities: [] }], { source: 'junk', createdAt: Date.now() - (i % 60) * DAY });
for (let k = 0; k < 10; k++) v2.prune(KEY);

const after = recall();
console.log('压缩后:', JSON.stringify(after));

const st = v2.stats(KEY);
const delta = after.recall - before.recall;
console.log('\n压缩前后对比:');
console.log('Recall@12:', before.recall.toFixed(3), '→', after.recall.toFixed(3), '(Δ' + delta.toFixed(3) + ')');
console.log('桶总量:', before.total, '→', after.total, '| cold:', before.cold, '→', after.cold);

const lines = ['压缩后基准（2026-10-28）', ''];
lines.push('压缩前: Recall@12=' + before.recall.toFixed(3) + ' 桶=' + before.total + ' cold=' + before.cold);
lines.push('压缩后: Recall@12=' + after.recall.toFixed(3) + ' 桶=' + after.total + ' cold=' + after.cold);
lines.push('Recall 变化: ' + (delta >= 0 ? '+' : '') + delta.toFixed(3));
lines.push('');
lines.push('压缩操作：近重复合并 + 5 轮 prune + 加 400 条低分垃圾 + 10 轮 prune（触发 cold 压缩）');
lines.push('判断：关键事实召回' + (delta >= -0.1 ? '保持（压缩未伤及关键记忆）✓' : '明显下降（压缩伤及关键记忆）✗'));
fs.writeFileSync('C:/Users/Lenovo/Desktop/压缩后基准_2026-10-28.txt', '\ufeff' + lines.join('\r\n'), 'utf8');
console.log('\n已写入桌面: 压缩后基准_2026-10-28.txt');
delete v2.state()[KEY];
v2.save();
console.log('（测试数据已清理）');
process.exit(0);
