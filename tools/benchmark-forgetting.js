// benchmark-forgetting.js — 遗忘/保胎留存基准
// 度量：核心记忆留存率、重要记忆误删率、保胎覆盖率、话题回归后的复活命中率
// 对照组：关闭保胎（peakDegree 巨大）看差异
const fs = require('fs');
const v2 = require('C:/Users/Lenovo/Documents/DSH/qq-bot/bridge/lib/memory-v2.js');

const SRC = 'C:/Users/Lenovo/Documents/DSH/qq-bot/bridge/storage/memory-v2.json';
const DAY = 86400000;
const prod = JSON.parse(fs.readFileSync(SRC, 'utf8'))['u1528848072'];

function run(name, disableProtect) {
  const KEY = 'ft-' + name + '-' + Date.now();
  // 复制生产记忆（只读源，写入测试 key）
  const copy = JSON.parse(JSON.stringify(prod));
  v2.state()[KEY] = copy;
  const initialCore = (copy.core || []).map((m) => m.text);
  const initialBucket = [...(copy.entity || []), ...(copy.event || []), ...(copy.concept || [])];
  const important = initialBucket.filter((m) => m.importance >= 8).map((m) => m.text);
  const totalInitial = initialBucket.length;

  if (disableProtect) v2.CONFIG.protect.enabled = false; // 对照组：关闭保胎
  else v2.CONFIG.protect.enabled = true;
  v2.CONFIG.protect.peakDegree = 15;

  // 阶段 A：30 轮话题漂移（每轮 +5 条新话题 + 时间推进 30 天）
  const T0 = Date.now();
  for (let r = 1; r <= 30; r++) {
    const shift = (30 - r) * 7 * DAY; // 每轮 7 天（30 轮 ≈ 7 个月，保胎 180 天内）
    const newItems = [];
    for (let i = 0; i < 5; i++) newItems.push({ text: `新话题${r}-${i}：无关内容`, bucket: 'event', importance: 3, entities: [`新话题${r}`] });
    v2.add(KEY, newItems, { source: 'drift', createdAt: T0 - shift });
    v2.reinforce(KEY, newItems);
    v2.prune(KEY);
    // 时间推进：桶内条目年龄增加 30 天（模拟运行 30 天）
    const st = v2.state()[KEY];
    for (const k of ['core', 'entity', 'event', 'concept']) for (const m of st[k] || []) { if (m.createdAt) m.createdAt -= 7 * DAY; if (m.lastHitAt) m.lastHitAt -= 7 * DAY; if (m.protectedUntil) m.protectedUntil -= 7 * DAY; }
  }
  const stA = v2.stats(KEY);
  const stateA = v2.state()[KEY];

  // 阶段 B：话题回归（输入与管理员/博麗ユキ相关的记忆）
  const returnItems = [
    { text: '管理员博麗ユキ回来了，聊起记忆系统', bucket: 'event', importance: 6, entities: ['博麗ユキ', '管理员'] },
    { text: '博麗ユキ又提起仿生人梦见电子羊的梦', bucket: 'concept', importance: 6, entities: ['博麗ユキ'] },
  ];
  const rv = v2.reinforce(KEY, returnItems);
  v2.add(KEY, returnItems, { source: 'return', createdAt: T0 });
  v2.prune(KEY);
  const stB = v2.stats(KEY);
  const stateB = v2.state()[KEY];

  // ---- 度量 ----
  const coreAfter = stateB.core.map((m) => m.text);
  const coreRetention = initialCore.filter((t) => coreAfter.includes(t)).length / Math.max(1, initialCore.length);
  // 误删率：初始 imp≥8 但现既不在桶也不在 core（被淘汰/删除）
  const liveTexts = new Set([...coreAfter, ...stateB.core.map((m) => m.text), ...(stateB.entity || []).map((m) => m.text), ...(stateB.event || []).map((m) => m.text), ...(stateB.concept || []).map((m) => m.text)]);
  const importantDeleted = important.filter((t) => !liveTexts.has(t));
  const importantDeleteRate = importantDeleted.length / Math.max(1, important.length);
  // 保胎覆盖率：保胎条目 / 主节点关键记忆
  const protNow = [...(stateB.entity || []), ...(stateB.event || []), ...(stateB.concept || [])].filter((m) => m.protectedUntil && m.protectedUntil > Date.now());
  const mainTopicMem = [...(stateB.event || []), ...(stateB.concept || [])].filter((m) => (m.entities || []).some((e) => ['博麗ユキ', '管理员', '本鲸', '溯'].includes(e)));
  const protectCoverage = mainTopicMem.length ? protNow.length / mainTopicMem.length : 0;
  // 复活命中率：回归后 cold 里相关记忆被复活的比例（rv.revived / 预估相关数）
  const coldRelated = (stateB.cold || []).filter((m) => String(m.text).includes('博麗ユキ') || String(m.text).includes('管理员')).length;
  const reviveRate = (rv.revived) / Math.max(1, rv.revived + coldRelated);

  const result = {
    initial: { core: initialCore.length, bucket: totalInitial, important: important.length },
    afterDrift: { total: stA.total, core: stA.core, cold: stA.cold, protected: stA.protected },
    afterReturn: { total: stB.total, core: stB.core, cold: stB.cold, protected: stB.protected, revived: rv.revived },
    coreRetention: coreRetention.toFixed(3),
    importantDeleteRate: importantDeleteRate.toFixed(3),
    protectCoverage: protectCoverage.toFixed(3),
    revivedCount: rv.revived,
    deletedImportantSamples: importantDeleted.slice(0, 3),
  };
  delete v2.state()[KEY];
  v2.save();
  return result;
}

console.log('=== 遗忘/保胎留存基准 ===');
const withProtect = run('protect', false);
console.log('\n【有保胎】');
console.log(JSON.stringify(withProtect, null, 2));
const noProtect = run('noprotect', true);
console.log('\n【无保胎（对照）】');
console.log(JSON.stringify(noProtect, null, 2));

// 写桌面
const lines = ['遗忘/保胎留存基准（2026-10-28）', '', '【有保胎】'];
lines.push('初始: ' + JSON.stringify(withProtect.initial));
lines.push('30轮漂移后: ' + JSON.stringify(withProtect.afterDrift));
lines.push('回归后: ' + JSON.stringify(withProtect.afterReturn));
lines.push('核心留存率: ' + withProtect.coreRetention);
lines.push('重要记忆误删率: ' + withProtect.importantDeleteRate);
lines.push('保胎覆盖率: ' + withProtect.protectCoverage);
lines.push('复活条数: ' + withProtect.revivedCount);
lines.push('误删样例: ' + JSON.stringify(withProtect.deletedImportantSamples));
lines.push('', '【无保胎（对照）】');
lines.push('30轮漂移后: ' + JSON.stringify(noProtect.afterDrift));
lines.push('核心留存率: ' + noProtect.coreRetention);
lines.push('重要记忆误删率: ' + noProtect.importantDeleteRate);
lines.push('复活条数: ' + noProtect.revivedCount);
fs.writeFileSync('C:/Users/Lenovo/Desktop/遗忘保胎基准_2026-10-28.txt', '\ufeff' + lines.join('\r\n'), 'utf8');
console.log('\n已写入桌面: 遗忘保胎基准_2026-10-28.txt');
process.exit(0);
