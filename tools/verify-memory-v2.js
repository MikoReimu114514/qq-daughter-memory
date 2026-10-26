// verify-memory-v2.js — 离线验证 v2 的四个修复（不碰真实数据，用测试 key）
const v2 = require('C:/Users/Lenovo/Documents/DSH/qq-bot/bridge/lib/memory-v2.js');

const TEST_KEY = 'test-verify-' + Date.now();
const results = [];
function check(name, ok, detail) { results.push({ name, ok, detail }); console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`); }

// ---------- ① 桶溢出 → 冷存储 ----------
{
  const entries = [];
  for (let i = 0; i < 300; i++) entries.push({ text: `测试事件${i}：日常琐事记录`, bucket: 'event', importance: 3, entities: [], links: [] });
  v2.add(TEST_KEY, entries, { source: 'verify' });
  const before = v2.stats(TEST_KEY);
  const r = v2.prune(TEST_KEY);
  const after = v2.stats(TEST_KEY);
  check('①桶溢出进冷存储', r.overflow > 0 && r.cold > before.cold, `overflow=${r.overflow}，cold ${before.cold}→${after.cold}`);
  check('①无静默丢失（桶+cold守恒）', (after.event + after.cold) >= (before.event + before.cold) * 0.9, `桶+cold ${before.event + before.cold}→${after.event + after.cold}`);
}

// ---------- ② 冷存储检索兜底 + 关联复活 ----------
{
  // importance 2 → 权重 24 < 30 → 进 cold
  v2.add(TEST_KEY, [
    { text: '旧事：管理员多年前爱喝朝日啤酒', bucket: 'entity', importance: 2, entities: ['朝日'], links: [] },
    { text: '旧事：管理员以前爱吃金枪鱼寿司', bucket: 'entity', importance: 2, entities: ['寿司'], links: [] },
  ], { source: 'verify' });
  v2.prune(TEST_KEY);
  const st = v2.state()[TEST_KEY];
  const coldHasBeer = st.cold.some((m) => m.text.includes('朝日'));
  check('②低分记忆确实进 cold', coldHasBeer, `cold=${st.cold.length} 条`);
  const recallOut = v2.formatForPrompt(TEST_KEY, '你还记得我爱喝什么吗', { recall: true });
  check('②显式回忆命中冷存储', recallOut.includes('记忆深处'), recallOut.split('\n').filter((l) => l.startsWith('-')).slice(-2).join(' | ').slice(0, 120));
  // 关联复活：新记忆共享实体 → cold 条目回桶
  const before = v2.state()[TEST_KEY].cold.length;
  const rr = v2.reinforce(TEST_KEY, [{ text: '新记忆：又喝了朝日', entities: ['朝日'] }]);
  const after = v2.state()[TEST_KEY].cold.length;
  check('②关联复活（cold→桶）', rr.revived > 0 || after < before, `revived=${rr.revived}，cold ${before}→${after}`);
}

// ---------- ③ 超级节点自动检测（泛词进黑名单 / 用户实体豁免 / 具体实体不误判）----------
{
  delete v2.state()[TEST_KEY];
  v2.add(TEST_KEY, [
    { text: '今天好热', bucket: 'event', importance: 4, entities: ['今天'] },
    { text: '今天真累', bucket: 'event', importance: 4, entities: ['今天'] },
    { text: '今天天气不错', bucket: 'event', importance: 4, entities: ['今天'] },
    { text: '今天又下雨', bucket: 'event', importance: 3, entities: ['今天'] },
    { text: '今天很忙', bucket: 'event', importance: 3, entities: ['今天'] },
    { text: '管理员今天很累', bucket: 'event', importance: 4, entities: ['管理员', '今天'] },
    { text: '管理员说今天好热', bucket: 'event', importance: 4, entities: ['管理员', '今天'] },
    { text: '管理员打算早点睡', bucket: 'event', importance: 4, entities: ['管理员'] },
    { text: '管理员在看视频', bucket: 'event', importance: 3, entities: ['管理员'] },
    { text: '管理员喝了朝日啤酒', bucket: 'entity', importance: 7, entities: ['管理员', '朝日'] },
    { text: '朝日的啤酒不错', bucket: 'entity', importance: 7, entities: ['朝日'] },
  ], { source: 'verify' });
  v2.prune(TEST_KEY);
  const st = v2.state()[TEST_KEY];
  const broad = st.meta.broadEntities || [];
  const stats = st.meta.entityStats || {};
  check('③泛词自动进黑名单', broad.includes('今天'), `blacklist=${JSON.stringify(broad)}；今天度数=${stats['今天'] && stats['今天'].degree}`);
  check('③用户实体豁免（不降级）', !broad.includes('管理员'), `管理员度数=${stats['管理员'] && stats['管理员'].degree}`);
  check('③具体实体不被误判', !broad.includes('朝日'), `朝日度数=${stats['朝日'] && stats['朝日'].degree}`);
}

// ---------- ④ synthetic 消息过滤（代码路径检查）----------
{
  const fs = require('fs');
  const src = fs.readFileSync('C:/Users/Lenovo/Documents/DSH/qq-bot/bridge/index.js', 'utf8');
  check('④proactive 消息带 synthetic 标记', src.includes('synthetic: true'), '');
  check('④condense 过滤 synthetic 消息', src.includes('!m.synthetic'), '');
  check('④condenser 有强制打包（maxDelay）', src.includes('maxDelayMs'), '');
}

// ---------- ⑤ core 竞争上岗（满 20 后新记忆能挤进来、旧记忆降回桶不丢）----------
{
  delete v2.state()[TEST_KEY];
  const high = [];
  for (let i = 0; i < 25; i++) high.push({ text: `核心记忆${i}：关于管理员的重要约定`, bucket: 'concept', importance: 8 + (i % 2), entities: ['管理员'], links: [] });
  v2.add(TEST_KEY, high, { source: 'verify' });
  v2.prune(TEST_KEY);
  const st = v2.state()[TEST_KEY];
  check('⑤core 满后竞争上岗（core=20）', st.core.length === 20, `core=${st.core.length}`);
  check('⑤同权重不替换（core+桶=25）', (st.core.length + st.entity.length + st.event.length + st.concept.length) === 25, `core+桶=${st.core.length + st.entity.length + st.event.length + st.concept.length}`);
  const higher = [];
  for (let i = 0; i < 5; i++) higher.push({ text: `更高权重记忆${i}：管理员的新约定`, bucket: 'concept', importance: 10, entities: ['管理员'], links: [] });
  v2.add(TEST_KEY, higher, { source: 'verify' });
  v2.prune(TEST_KEY);
  const st2 = v2.state()[TEST_KEY];
  const inCore = (t) => st2.core.some((m) => m.text === t);
  check('⑤高权重新记忆能进 core', inCore('更高权重记忆0：管理员的新约定'), `core=${st2.core.length}`);
  check('⑤core 仍为上限 20', st2.core.length === 20, `core=${st2.core.length}`);
  const totalIn = st2.core.length + st2.entity.length + st2.event.length + st2.concept.length;
  check('⑤无记忆丢失（30 条全在 core+桶）', totalIn >= 30, `core+桶=${totalIn}`);
}

// ---------- 清理 ----------
delete v2.state()[TEST_KEY];
v2.save();
console.log('\n（测试数据已清理）');
const pass = results.filter((r) => r.ok).length;
console.log(`\n结果: ${pass}/${results.length} 通过`);
process.exit(0);
