// verify-memory-v21-stress.js — 压测：每天输入 40 条（超删除上限）持续 30 天，验证收敛与不丢信息
const v2 = require('C:/Users/Lenovo/Documents/DSH/qq-bot/bridge/lib/memory-v2.js');

const KEY = 'test-stress-' + Date.now();
const DAY = 86400000;
const T0 = Date.now();
const rows = [];
let inputTotal = 0;
let lastCore = null;

for (let d = 1; d <= 30; d++) {
  const day = [];
  for (let i = 0; i < 40; i++) {
    day.push({
      text: `第${d}天第${i}条：${['日常','工作','游戏','学习','新闻','闲聊','吃饭','睡觉'][i % 8]}记录`,
      bucket: ['event', 'entity', 'concept'][i % 3],
      importance: 2 + (i % 6),
      entities: i % 4 === 0 ? ['今天'] : (i % 4 === 1 ? ['朝日'] : []),
      links: []
    });
  }
  v2.add(KEY, day, { source: 'stress', createdAt: T0 - (30 - d) * DAY });
  inputTotal += day.length;
  v2.reinforce(KEY, day.slice(0, 8));
  const pr = v2.prune(KEY);
  const s = v2.stats(KEY);
  rows.push({ d, total: s.total, core: s.core, cold: s.cold, prot: s.protected, overflow: pr.overflow, coldComp: pr.coldCompressed || 0 });
  lastCore = s.core;
}

console.log('天  总数  core  cold  保胎  溢出  压缩');
for (const x of rows) {
  if (x.d % 5 === 0 || x.d === 1) console.log(String(x.d).padEnd(3) + String(x.total).padEnd(6) + String(x.core).padEnd(6) + String(x.cold).padEnd(6) + String(x.prot).padEnd(6) + String(x.overflow).padEnd(6) + x.coldComp);
}
const last = rows[rows.length - 1];
console.log(`\n输入总数: ${inputTotal} 条；30 天后活跃 ${last.total} + cold ${last.cold}（含压缩汇总）`);
const issues = [];
if (last.total > 190) issues.push('桶失控');
if (last.cold > 300) issues.push('冷存储溢出');
if (last.core > 20) issues.push('core 溢出');
if (last.prot > 30) issues.push('保胎层溢出');
if (Number(last.total) < 50) issues.push('记忆流失');
console.log('失衡判断:', issues.length ? '⚠️ ' + issues.join('；') : '✅ 30 天压测未发现失衡');
delete v2.state()[KEY];
v2.save();
console.log('（测试数据已清理）');
process.exit(0);
