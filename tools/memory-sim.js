// memory-sim.js — 用三种策略处理女儿现有 92 条长期记忆，输出最终运行结果
const fs = require('fs');
const cfg = JSON.parse(fs.readFileSync('C:/Users/Lenovo/Documents/DSH/qq-bot/bridge/config.json', 'utf8'));
const b = cfg.brain;
const base = (b.baseUrl || 'https://api.deepseek.com/anthropic/v1').replace(/\/+$/, '');
const mem = JSON.parse(fs.readFileSync('C:/Users/Lenovo/Documents/DSH/qq-bot/bridge/storage/memory.json', 'utf8'));
const facts = mem['u1528848072'].facts;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function distill() {
  const list = facts.map((f, i) => `${i}. ${f}`).join('\n');
  const prompt = `下面是一个AI助手的长期记忆列表（编号）。为每条提炼元数据：
- bucket: entity=关于人或物的稳定事实；event=发生过的事；concept=想法/理念/约定/规则
- importance: 重要度 1-10（1=聊天残渣，10=核心事实）
- entities: 涉及的实体（人名/物名，如"管理员""朝日""dsh小姐""DeepSeek"，没有就空数组）
- links: 关联的其他记忆编号（最多3个，优先同实体）
只输出一个JSON数组，每项 {"id":编号,"bucket":"...","importance":数字,"entities":[...],"links":[...]}，不要任何其他文字。

${list}`;
  const res = await fetch(base + '/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': b.apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: b.model || 'deepseek-chat',
      max_tokens: 8000,
      temperature: 0.2,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }]
    }),
    signal: AbortSignal.timeout(180000)
  });
  const j = await res.json();
  const text = (j.content || []).filter((x) => x.type === 'text').map((x) => x.text).join('');
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) throw new Error('没有 JSON: ' + text.slice(0, 200));
  return JSON.parse(m[0]);
}

function bucketOf(meta) { return meta.bucket || 'event'; }
function importanceOf(meta) { return Number(meta.importance) || 5; }

// 策略 A：分桶 + 打分（重要性×频率×衰减；无历史数据：频率=1，衰减=1）+ 桶上限截断
function strategyA(metaList) {
  const caps = { entity: 50, event: 80, concept: 60 };
  const buckets = { entity: [], event: [], concept: [] };
  for (const m of metaList) buckets[bucketOf(m)].push(m);
  const out = { kept: [], compressed: [], deleted: [], core: [] };
  for (const k of Object.keys(buckets)) {
    const list = buckets[k].slice().sort((x, y) => importanceOf(y) - importanceOf(x));
    // 92 条按默认桶上限不会满 ⇒ 演示：把上限减到 15/20/15 让淘汰可见（并标注）
    const demoCaps = { entity: 15, event: 20, concept: 15 };
    const cap = demoCaps[k];
    for (const m of list) {
      const w = 60 * (importanceOf(m) / 5) * 1 * 1;
      if (w < 30) out.deleted.push({ ...m, w });
      else if (list.indexOf(m) >= cap) out.compressed.push({ ...m, w });
      else out.kept.push({ ...m, w });
    }
  }
  return out;
}

// 策略 B：A + 关联图 + 六度淘汰 + core 晋升
function strategyB(metaList) {
  const byId = new Map(metaList.map((m) => [m.id, m]));
  let idCounter = 1000;
  // 实体为锚：把实体名作为节点
  const entityNode = {};
  const nodeOf = (name) => { if (!entityNode[name]) entityNode[name] = 'E' + idCounter++; return entityNode[name]; };
  const adj = {}; // node -> Set(node)
  const addEdge = (a, b2) => { if (a === b2) return; (adj[a] = adj[a] || new Set()).add(b2); (adj[b2] = adj[b2] || new Set()).add(a); };
  for (const m of metaList) {
    m.node = 'M' + m.id;
    for (const e of (m.entities || [])) addEdge(m.node, nodeOf(e));
    for (const l of (m.links || [])) { const t = byId.get(Number(l)); if (t) addEdge(m.node, 'M' + t.id); }
  }
  // 自动匹配：同实体名（entities 完全相同）互相连边
  for (let i = 0; i < metaList.length; i++) {
    for (let k = i + 1; k < metaList.length; k++) {
      const a = metaList[i], c = metaList[k];
      if (a.entities && c.entities && a.entities.some((e) => c.entities.includes(e))) addEdge(a.node, c.node);
    }
  }
  // ★ 关键修正：宽泛实体（度数 > 8，如'管理员''博麗ユキ'）是超级节点，会把全图连成一体、毁掉距离结构——
  //   剪掉它们的边（降级为'分类标签'，不参与图距离），这是'关联策略不完备'的典型坑。
  const broad = new Set();
  for (const [name, node] of Object.entries(entityNode)) if ((adj[node] || new Set()).size > 8) broad.add(node);
  for (const node of broad) {
    for (const nb of [...(adj[node] || [])]) { if (adj[nb]) adj[nb].delete(node); }
    delete adj[node];
  }
  // hub 定义：度数 3~8 的实体（宽泛实体如'管理员'度数太高，会当超级节点把全图连成一体，不算根）
  const roots = new Set();
  for (const [name, node] of Object.entries(entityNode)) {
    const deg = (adj[node] || new Set()).size;
    if (deg >= 3 && deg <= 8) roots.add(node);
  }
  for (const m of metaList.slice(0, 10)) roots.add(m.node); // 前 10 条当作 core 种子

  // BFS 最短距离（从 roots 出发，深度 6）
  const dist = new Map();
  const queue = [];
  for (const r of roots) { dist.set(r, 0); queue.push(r); }
  while (queue.length) {
    const cur = queue.shift();
    const d = dist.get(cur);
    if (d >= 6) continue;
    for (const nxt of (adj[cur] || [])) { if (!dist.has(nxt)) { dist.set(nxt, d + 1); queue.push(nxt); } }
  }
  const out = { kept: [], compressed: [], deleted: [], core: [], dist: {} };
  for (const m of metaList) {
    const d = dist.get(m.node);
    m.dist = d == null ? '∞' : d;
    const w = 60 * (importanceOf(m) / 5) * (1 + (m.links || []).length * 0.15) * 1;
    // 权重为主轴、距离为辅（实测：图很密，距离区分度低，只能用来标孤立点）
    if (importanceOf(m) >= 8 && (d == null ? 99 : d) <= 1) out.core.push({ ...m, w });
    else if (d == null && w >= 40) out.kept.push({ ...m, w });      // 孤岛但重 → 保留
    else if (w < 30) out.deleted.push({ ...m, w });                  // 低分 → 删
    else if (w < 50) out.compressed.push({ ...m, w });               // 中低 → 压缩
    else out.kept.push({ ...m, w });                                 // 高分 → 保留
  }
  out.dist = Object.fromEntries([...dist].map(([k, v]) => [k, v]));
  return out;
}

// 策略 C：B + 社区聚类（按实体 hub 分组）+ 分级压缩
function strategyC(metaList) {
  const B = strategyB(metaList);
  // 社区：按主实体分组
  const communities = new Map();
  for (const m of metaList) {
    const key = (m.entities && m.entities[0]) || '无实体';
    if (!communities.has(key)) communities.set(key, []);
    communities.get(key).push(m);
  }
  const out = { ...B, communities: {} };
  for (const [k, list] of communities) {
    const avg = list.reduce((s, m) => s + importanceOf(m), 0) / list.length;
    out.communities[k] = { size: list.length, avgImportance: avg, ids: list.map((m) => m.id) };
  }
  return out;
}

function show(title, out, extra) {
  console.log('\n================ ' + title + ' ================');
  if (extra) console.log(extra);
  const line = (arr, name) => {
    console.log(`\n[${name}] ${arr.length} 条`);
    arr.slice(0, 12).forEach((m) => console.log(`  · #${m.id} (w=${m.w ? m.w.toFixed(0) : '-'}, imp=${importanceOf(m)}, d=${m.dist != null ? m.dist : '-'}) ${String(facts[m.id]).slice(0, 70)}`));
    if (arr.length > 12) console.log(`  ... 还有 ${arr.length - 12} 条`);
  };
  line(out.core || [], 'core（永久）');
  line(out.kept, '保留');
  line(out.compressed, '压缩');
  line(out.deleted, '删除');
}

(async () => {
  console.log(`总计 ${facts.length} 条记忆`);
  const meta = await distill();
  console.log(`提炼完成：${meta.length} 条元数据`);
  const A = strategyA(meta);
  const B = strategyB(meta);
  const C = strategyC(meta);
  show('策略 A：分桶+打分（桶上限演示值 15/20/15，否则 92 条不会满）', A);
  show('策略 B：A+关联图+六度淘汰+core 晋升', B, '根：前 10 条 core 种子 + 度数≥3 的实体 hub；BFS 深度 6');
  show('策略 C：B+社区聚类+分级压缩', C, '社区：按主实体分组，每社区给摘要（这里只列统计）');
  console.log('\n=== C 的社区分布 ===');
  const entries = Object.entries(C.communities).sort((x, y) => y[1].size - x[1].size);
  for (const [k, v] of entries.slice(0, 15)) console.log(`  [${k}] ${v.size} 条，平均重要度 ${v.avgImportance.toFixed(1)}，ids=${v.ids.slice(0, 8).join(',')}${v.ids.length > 8 ? '...' : ''}`);
})();
