// verify-memory-v2-iter.js — v2 引擎 30 轮迭代验证（真实引擎，不碰真实 key）
const v2 = require('C:/Users/Lenovo/Documents/DSH/qq-bot/bridge/lib/memory-v2.js');

const KEY = 'test-iter-' + Date.now();
// 真实上下文种子（dsh 小姐自己提炼的事件）
const SEEDS = [
  { text: '管理员让我称呼他为「管理员」，他是部署我的人', bucket: 'concept', importance: 9, entities: ['管理员'] },
  { text: '管理员给我起名 dsh 小姐（蓝发鲸鱼娘女仆）', bucket: 'concept', importance: 9, entities: ['管理员'] },
  { text: '我升级 dsh 0.2.1-rc.2 时迁移崩溃，管理员手动删行救活', bucket: 'event', importance: 7, entities: ['dsh'] },
  { text: '女儿识图从 GLM 换 DeepSeek 集成，并改为原图直接注入大脑', bucket: 'event', importance: 8, entities: ['DeepSeek'] },
  { text: 'QQ 空间说说功能：[[说说:正文]] + 自动配图', bucket: 'event', importance: 8, entities: [] },
  { text: '记忆系统设计：分桶+权重+关联+六度+core', bucket: 'concept', importance: 8, entities: [] },
  { text: '实测结论：权重是主淘汰轴，六度只标孤立点', bucket: 'concept', importance: 8, entities: [] },
  { text: '调人设手册：生成轴+许可式+反 AI 味六族', bucket: 'concept', importance: 9, entities: ['管理员'] },
  { text: '管理员追求活人感：交流像圆舞曲', bucket: 'concept', importance: 9, entities: ['管理员'] },
  { text: '治理风控：警告 30 分钟后强制下线', bucket: 'event', importance: 7, entities: ['SnowLuma'] },
  { text: 'SnowLuma v2.2.0 部署完成', bucket: 'event', importance: 7, entities: ['SnowLuma'] },
  { text: '管理员爱喝朝日啤酒', bucket: 'entity', importance: 5, entities: ['朝日'] },
  { text: '管理员吃金枪鱼寿司', bucket: 'entity', importance: 5, entities: ['寿司'] },
  { text: 'bridge 重启无害，重登要省着', bucket: 'concept', importance: 6, entities: [] },
];

function synthDay(d) {
  const topics = ['天气', '视频', '工作', '娱乐', '闲聊', '吃饭', '睡觉', '游戏', '学习', '新闻'];
  const daily = Array.from({ length: 10 }, (_, i) => ({
    text: `第${d}天${topics[i % 10]}日常记录`,
    bucket: ['event', 'entity', 'concept'][i % 3],
    importance: 2 + (i % 5),
    entities: i % 3 === 0 ? ['今天'] : [],
    links: []
  }));
  // 每天 1 条重要的（模拟新增约定）→ 触发 core 竞争
  daily.push({ text: `第${d}天新约定：管理员交代的重要事项`, bucket: 'concept', importance: 9, entities: ['管理员'], links: [] });
  return daily;
}

const rows = [];
const DAY_MS = 86400000;
const T0 = Date.now();
for (let r = 1; r <= 60; r++) {
  const day = synthDay(r).map((e) => ({ ...e }));
  const createdAt = T0 - (60 - r) * DAY_MS; // 时间加速：每条记忆按天前移
  v2.add(KEY, day, { source: 'iter', createdAt });
  if (r === 1) v2.add(KEY, SEEDS, { source: 'seed', createdAt: T0 - 60 * DAY_MS });
  v2.reinforce(KEY, day.slice(0, 4));
  const pr = v2.prune(KEY);
  const s = v2.stats(KEY);
  rows.push({ r, total: s.total, core: s.core, cold: s.cold, broad: s.broadEntities, avgW: s.avgWeight.toFixed(0), overflow: pr.overflow, revived: (v2.reinforce(KEY, []) || {}).revived || 0 });
}

console.log('轮  总数  core  cold  broad  均重  溢出');
for (const x of rows) {
  if (x.r % 5 === 0 || x.r === 1) console.log(String(x.r).padEnd(3) + String(x.total).padEnd(6) + String(x.core).padEnd(6) + String(x.cold).padEnd(6) + String(x.broad).padEnd(6) + String(x.avgW).padEnd(6) + x.overflow);
}
const last = rows[rows.length - 1];
const first = rows[0];
console.log('\n=== 30 轮终态 ===');
console.log(`总数 ${first.total} → ${last.total}；core ${last.core}；cold ${last.cold}；broad ${last.broad}；均重 ${last.avgW}`);
const issues = [];
if (last.total > 200) issues.push('总量失控');
if (last.cold > 300) issues.push('冷存储溢出');
if (last.core > 20) issues.push('core 溢出');
if (last.total < 10) issues.push('记忆流失');
if (Number(last.avgW) < 30) issues.push('权重塌缩');
if (last.broad > 10) issues.push('黑名单爆炸（泛词过多）');
console.log('失衡判断:', issues.length ? '⚠️ ' + issues.join('；') : '✅ 30 轮未发现失衡');

// 冷存储激活抽查
const fmt = v2.formatForPrompt(KEY, '管理员爱喝什么', { recall: true });
console.log('\n=== 检索抽查（含冷存储兜底）===');
console.log(fmt.split('\n').filter((l) => l.startsWith('-') || l.startsWith('[')).slice(0, 10).join('\n'));

delete v2.state()[KEY];
v2.save();
console.log('\n（测试数据已清理）');
process.exit(0);
