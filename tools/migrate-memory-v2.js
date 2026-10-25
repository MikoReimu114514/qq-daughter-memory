// migrate-memory-v2.js — 把旧 facts 迁入新记忆引擎（真事实→桶，[早期对话]→冷存储）
const fs = require('fs');
const path = require('path');
const v2 = require('C:/Users/Lenovo/Documents/DSH/qq-bot/bridge/lib/memory-v2.js');

const old = JSON.parse(fs.readFileSync('C:/Users/Lenovo/Documents/DSH/qq-bot/bridge/storage/memory.json', 'utf8'));
for (const [key, val] of Object.entries(old)) {
  const facts = (val && val.facts) || [];
  if (!facts.length) continue;
  const r = v2.migrateLegacy(key, facts);
  console.log(`[${key}] 导入 ${r.imported} 条事实，${r.coldLegacy} 条 [早期对话] 进冷存储`);
  console.log('  新系统状态:', JSON.stringify(v2.stats(key)));
}
console.log('\n完成。新文件: storage/memory-v2.json');
