// memory-export.js — 用最终「权重为主、关联为辅」策略跑 94 条记忆，导出完整分类结果到桌面 txt
const fs = require('fs');
const cfg = JSON.parse(fs.readFileSync('C:/Users/Lenovo/Documents/DSH/qq-bot/bridge/config.json', 'utf8'));
const b = cfg.brain;
const base = (b.baseUrl || 'https://api.deepseek.com/anthropic/v1').replace(/\/+$/, '');
const mem = JSON.parse(fs.readFileSync('C:/Users/Lenovo/Documents/DSH/qq-bot/bridge/storage/memory.json', 'utf8'));
const facts = mem['u1528848072'].facts;
const OUT = 'C:/Users/Lenovo/Desktop/记忆策略实测结果_2026-10-25.txt';

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
    body: JSON.stringify({ model: b.model || 'deepseek-chat', max_tokens: 8000, temperature: 0.2, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }] }), signal: AbortSignal.timeout(180000)
  });
  const j = await res.json();
  const text = (j.content || []).filter((x) => x.type === 'text').map((x) => x.text).join('');
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) throw new Error('没有 JSON: ' + text.slice(0, 300));
  return JSON.parse(m[0]);
}

function run(metaList) {
  const byId = new Map(metaList.map((m) => [m.id, m]));
  let idc = 1000;
  const entityNode = {};
  const nodeOf = (n) => { if (!entityNode[n]) entityNode[n] = 'E' + idc++; return entityNode[n]; };
  const adj = {};
  const addEdge = (a, c) => { if (a === c) return; (adj[a] = adj[a] || new Set()).add(c); (adj[c] = adj[c] || new Set()).add(a); };
  for (const m of metaList) {
    m.node = 'M' + m.id;
    for (const e of (m.entities || [])) addEdge(m.node, nodeOf(e));
    for (const l of (m.links || [])) { const t = byId.get(Number(l)); if (t) addEdge(m.node, 'M' + t.id); }
  }
  for (let i = 0; i < metaList.length; i++) for (let k = i + 1; k < metaList.length; k++) {
    const a = metaList[i], c = metaList[k];
    if (a.entities && c.entities && a.entities.some((e) => c.entities.includes(e))) addEdge(a.node, c.node);
  }
  const broad = new Set();
  for (const [name, node] of Object.entries(entityNode)) if ((adj[node] || new Set()).size > 8) broad.add(node);
  for (const node of broad) { for (const nb of [...(adj[node] || [])]) { if (adj[nb]) adj[nb].delete(node); } delete adj[node]; }
  const roots = new Set();
  for (const [name, node] of Object.entries(entityNode)) { const deg = (adj[node] || new Set()).size; if (deg >= 3 && deg <= 8) roots.add(node); }
  for (const m of metaList.slice(0, 10)) roots.add(m.node);
  const dist = new Map(); const queue = [];
  for (const r of roots) { dist.set(r, 0); queue.push(r); }
  while (queue.length) { const cur = queue.shift(); const d = dist.get(cur); if (d >= 6) continue; for (const nxt of (adj[cur] || [])) if (!dist.has(nxt)) { dist.set(nxt, d + 1); queue.push(nxt); } }
  const out = { core: [], kept: [], compressed: [], deleted: [] };
  for (const m of metaList) {
    const d = dist.get(m.node); m.dist = d == null ? '∞' : d;
    const imp = Number(m.importance) || 5;
    const w = 60 * (imp / 5) * (1 + (m.links || []).length * 0.15);
    m.w = w;
    if (imp >= 8 && (d == null ? 99 : d) <= 1) out.core.push(m);
    else if (d == null && w >= 40) out.kept.push(m);
    else if (w < 30) out.deleted.push(m);
    else if (w < 50) out.compressed.push(m);
    else out.kept.push(m);
  }
  return out;
}

function fmtLine(m) {
  return `#${m.id}  [权重 ${m.w.toFixed(0)} | 重要度 ${m.importance} | 距离 ${m.dist}]\n    ${facts[m.id]}`;
}

(async () => {
  const meta = await distill();
  const r = run(meta);
  const lines = [];
  lines.push('记忆策略实测结果（2026-10-25）');
  lines.push('输入：女儿当前长期记忆 ' + facts.length + ' 条');
  lines.push('策略：分桶打分（权重为主） + 关联图（六度仅标孤儿） + 软删除；宽泛实体（管理员/博麗ユキ）降级为标签');
  lines.push('权重 = 60 × (重要度/5) × (1 + 关联数×0.15)');
  lines.push('判定：重要度≥8且距离≤1 → core；权重<30 → 删除；权重30~50 → 压缩；≥50 → 保留');
  lines.push('');
  lines.push('============================================================');
  lines.push('【core 永久记忆】 ' + r.core.length + ' 条（每轮固定注入、永不淘汰）');
  lines.push('============================================================');
  r.core.forEach((m) => lines.push(fmtLine(m)));
  lines.push('');
  lines.push('============================================================');
  lines.push('【保留】 ' + r.kept.length + ' 条（原样保留，参与检索）');
  lines.push('============================================================');
  r.kept.forEach((m) => lines.push(fmtLine(m)));
  lines.push('');
  lines.push('============================================================');
  lines.push('【压缩】 ' + r.compressed.length + ' 条（压成一句话摘要，保留关联）');
  lines.push('============================================================');
  r.compressed.forEach((m) => lines.push(fmtLine(m)));
  lines.push('');
  lines.push('============================================================');
  lines.push('【删除】 ' + r.deleted.length + ' 条（低分且孤立，进入冷存储 7 天后物理删除）');
  lines.push('============================================================');
  r.deleted.forEach((m) => lines.push(fmtLine(m)));
  lines.push('');
  lines.push('—— 完 ——');
  fs.writeFileSync(OUT, '\uFEFF' + lines.join('\r\n'), 'utf8');
  console.log('已写入:', OUT);
  console.log(`core=${r.core.length} kept=${r.kept.length} compressed=${r.compressed.length} deleted=${r.deleted.length}`);
})();
