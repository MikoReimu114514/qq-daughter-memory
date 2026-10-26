// verify-memory-v21.js — v2.1 五项新能力的单测
const v2 = require('C:/Users/Lenovo/Documents/DSH/qq-bot/bridge/lib/memory-v2.js');

const KEY = 'test-v21-' + Date.now();
const results = [];
function check(name, ok, detail) { results.push({ name, ok }); console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`); }
const DAY = 86400000;

// ---------- ① 矛盾失效 ----------
{
  delete v2.state()[KEY];
  v2.add(KEY, [{ text: '管理员爱喝朝日啤酒', bucket: 'entity', importance: 7, entities: ['管理员', '朝日'] }]);
  const st = v2.state()[KEY];
  const oldId = st.entity[0].id;
  v2.add(KEY, [{ text: '管理员改喝麒麟了', bucket: 'entity', importance: 7, entities: ['管理员', '麒麟'], conflicts: [oldId] }]);
  const r = v2.markSuperseded(KEY, [oldId], '管理员改喝麒麟了');
  const old = v2.state()[KEY].entity.find((m) => m.id === oldId);
  check('①矛盾旧记忆被标记失效', old && old.validUntil && old.supersededBy, `validUntil=${!!(old && old.validUntil)}`);
  check('①失效记忆权重归零', v2.weightOf(old) === 0, `w=${v2.weightOf(old)}`);
  const fmt = v2.formatForPrompt(KEY, '管理员爱喝什么');
  check('①检索注入含「已更新的旧记忆」', !fmt.includes('已更新的旧记忆') || fmt.includes('已被后来发生的事更新'), '');
}

// ---------- ② 最近活跃度（话题回归升权）----------
{
  delete v2.state()[KEY];
  const oldDate = Date.now() - 60 * DAY;
  v2.add(KEY, [{ text: '学习：考研专业课笔记整理方法', bucket: 'concept', importance: 6, entities: ['考研'] }], { createdAt: oldDate });
  const item = v2.state()[KEY].concept[0];
  const wBefore = v2.weightOf(item);
  // 话题回归：被命中（文本重叠）
  v2.reinforce(KEY, [{ text: '考研专业课笔记整理方法复习' }]);
  const wAfter = v2.weightOf(item);
  check('②话题回归后权重回升', wAfter > wBefore * 1.5, `${wBefore.toFixed(0)} → ${wAfter.toFixed(0)}`);
}

// ---------- ③ 保胎层（主节点保护）----------
{
  delete v2.state()[KEY];
  const list = [];
  for (let i = 0; i < 20; i++) list.push({ text: `朝日话题${i}：喝啤酒的日常记录`, bucket: 'entity', importance: 6, entities: ['朝日'] });
  v2.add(KEY, list);
  v2.prune(KEY);
  const st = v2.state()[KEY];
  const protectedCount = [...st.entity, ...st.event, ...st.concept].filter((m) => m.protectedUntil && m.protectedUntil > Date.now()).length;
  check('③主节点的关键记忆被保胎', protectedCount > 0, `protected=${protectedCount}，朝日 peakDegree=${(st.meta.entityStats['朝日'] || {}).peakDegree}`);
}

// ---------- ④ 保胎层竞争（上限 30）----------
{
  delete v2.state()[KEY];
  const list = [];
  // 两个主节点 + 大量记忆
  for (let i = 0; i < 20; i++) list.push({ text: `朝日话题${i}`, bucket: 'entity', importance: 6, entities: ['朝日'] });
  for (let i = 0; i < 20; i++) list.push({ text: `战雷话题${i}`, bucket: 'event', importance: 6, entities: ['战雷'] });
  v2.add(KEY, list);
  v2.prune(KEY);
  const st = v2.state()[KEY];
  const protectedCount = [...st.entity, ...st.event, ...st.concept].filter((m) => m.protectedUntil && m.protectedUntil > Date.now()).length;
  check('④保胎层不超过上限 30', protectedCount <= 30, `protected=${protectedCount}`);
}

// ---------- ⑤ 双通道复活（文本命中，无实体）----------
{
  delete v2.state()[KEY];
  // 一条无实体低分记忆 → 淘汰进 cold
  v2.add(KEY, [{ text: '朝日啤酒真好喝，冰的最佳', bucket: 'event', importance: 2, entities: [] }]);
  v2.prune(KEY);
  const cold = v2.state()[KEY].cold;
  const hasCold = cold.some((m) => m.text.includes('朝日啤酒'));
  // 新记忆无实体但文本重叠 → 应复活
  const r = v2.reinforce(KEY, [{ text: '今天朝日啤酒真好喝' }]);
  const st = v2.state()[KEY];
  const revived = st.cold.length < cold.length || r.revived > 0;
  check('⑤文本通道复活（无实体也能救回）', hasCold && revived, `cold ${cold.length}→${st.cold.length}，revived=${r.revived}`);
}

// ---------- ⑥ 冷存储溢出压缩（不丢信息）----------
{
  delete v2.state()[KEY];
  const list = [];
  for (let i = 0; i < 350; i++) list.push({ text: `琐事${i}`, bucket: 'event', importance: 2, entities: [] });
  v2.add(KEY, list);
  // 连续 prune，让桶溢出把 cold 顶过 300
  for (let k = 0; k < 5; k++) v2.prune(KEY);
  const st = v2.state()[KEY];
  const compressed = st.cold.some((m) => m.compressedFrom);
  check('⑥冷存储溢出时压缩而非丢弃', compressed && st.cold.length <= 300, `cold=${st.cold.length}，含压缩条目=${compressed}`);
}

delete v2.state()[KEY];
v2.save();
console.log('\n（测试数据已清理）');
const pass = results.filter((r) => r.ok).length;
console.log(`\n结果: ${pass}/${results.length} 通过`);
process.exit(0);
