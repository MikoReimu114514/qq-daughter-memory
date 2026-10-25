// lib/memory-v2.js — 分桶 + 权重打分 + 关联 + core + 软淘汰 的长期记忆引擎
// 设计依据：2026-10 与管理员共同设计；实测结论（94 条真实记忆 + 90 天演化）：
//   权重（重要度×频率×时间）是主淘汰轴；关联度是加分项；"六度距离"只用于标孤立点；用户实体不视为宽泛噪音。
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const STORE_DIR = path.join(ROOT, 'storage');
const V2_FILE = path.join(STORE_DIR, 'memory-v2.json');

const CAPS = { entity: 50, event: 80, concept: 60 };
const CORE_CAP = 20;
const COLD_CAP = 300;
const BROAD = new Set(['dsh', '本鲸', 'Deepsleep']); // 纯身份词（不算"具体实体"）；用户本人不在此集合
const USER_ENTITIES = new Set(['管理员', '博麗', '博麗ユキ']);

function now() { return Date.now(); }
function readJson(f, fb) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } }
function writeJson(f, d) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(d, null, 2)); }

let cache = null;
function state() { if (!cache) cache = readJson(V2_FILE, {}); return cache; }
function save() { writeJson(V2_FILE, state()); }

function ensure(key) {
  const s = state();
  if (!s[key]) s[key] = { core: [], entity: [], event: [], concept: [], cold: [], stats: { createdAt: now(), lastPrune: 0, lastCondenseAt: 0, condensedLen: 0 } };
  if (!s[key].stats) s[key].stats = { createdAt: now(), lastPrune: 0, lastCondenseAt: 0, condensedLen: 0 };
  return s[key];
}

function isSpecific(m) { return (m.entities || []).some((e) => !BROAD.has(e)); }
function isUser(m) { return (m.entities || []).some((e) => USER_ENTITIES.has(e)); }
function isConfig(m) { return /窗口|配置|策略|护栏|压缩|升级|版本/.test(m.text || ''); }

function decay(m) { const w = Math.max(0, (now() - (m.createdAt || now())) / 86400000); return Math.pow(0.85, Math.floor(w / 7)); }
function weightOf(m) {
  const iso = (isSpecific(m) || isUser(m) || isConfig(m)) ? 1 : 0.6;
  const hits = Math.min(10, m.hits || 0);
  return 60 * ((m.importance || 5) / 5) * (1 + hits * 0.1) * (1 + (m.links || []).length * 0.15) * decay(m) * iso;
}
function ranked(arr) { return arr.slice().sort((a, b) => weightOf(b) - weightOf(a)); }

// 加记忆（entries: [{text,bucket,importance,entities,links}]）
function add(key, entries, opts = {}) {
  if (!entries || !entries.length) return { added: 0 };
  const s = ensure(key);
  let added = 0;
  for (const e of entries) {
    const text = String(e.text || '').trim().slice(0, 200);
    if (!text) continue;
    const bucket = ['entity', 'event', 'concept'].includes(e.bucket) ? e.bucket : 'event';
    // 去重：与现有（含冷存储）相似则不重复加
    const all = [...s.core, ...s.entity, ...s.event, ...s.concept];
    if (all.some((m) => m.text === text)) continue;
    const item = {
      id: 'm' + now().toString(36) + Math.random().toString(36).slice(2, 6),
      text, bucket,
      importance: Math.max(1, Math.min(10, Number(e.importance) || 5)),
      entities: Array.isArray(e.entities) ? e.entities.slice(0, 6) : [],
      links: Array.isArray(e.links) ? e.links.slice(0, 6) : [],
      hits: 0, createdAt: opts.createdAt || now(), source: opts.source || 'auto'
    };
    // [[记住:]] 显式记忆 → 高重要度
    if (opts.explicit) item.importance = Math.max(item.importance, 8);
    s[bucket].push(item);
    added++;
  }
  save();
  return { added };
}

// 关联强化：新记忆的实体/文本与旧记忆重叠 → 旧记忆 hits++
function reinforce(key, newEntries) {
  const s = ensure(key);
  const all = [...s.core, ...s.entity, ...s.event, ...s.concept];
  const ents = new Set();
  for (const e of newEntries || []) for (const ent of (e.entities || [])) ents.add(ent);
  for (const m of all) {
    if (!m.hits) m.hits = 0;
    if ((m.entities || []).some((ent) => ents.has(ent))) m.hits = Math.min(10, m.hits + 1);
  }
  save();
}

// 淘汰 + core 晋升（软删除：进 cold；单日删除限额）
function prune(key) {
  const s = ensure(key);
  const all = [...s.entity, ...s.event, ...s.concept];
  if (!all.length) return { deleted: 0, compressed: 0, core: s.core.length };
  const capDel = Math.max(1, Math.ceil(all.length * 0.2));
  let del = 0, comp = 0;
  const next = { entity: [], event: [], concept: [] };
  for (const k of ['entity', 'event', 'concept']) {
    for (const m of s[k]) {
      const w = weightOf(m);
      if (w < 30 && del < capDel) { s.cold.push({ ...m, weight: w, deletedAt: now() }); del++; continue; }
      if (w < 50) { m.compressed = true; comp++; }
      next[k].push(m);
    }
  }
  // 桶上限硬截断（按权重）
  for (const k of ['entity', 'event', 'concept']) {
    if (next[k].length > CAPS[k]) next[k] = ranked(next[k]).slice(0, CAPS[k]);
    s[k] = next[k];
  }
  // core 晋升：重要度≥8 且（关于用户 或 被关联≥2次 或 配置类），上限 CORE_CAP
  const all2 = [...s.entity, ...s.event, ...s.concept];
  const eligible = all2.filter((m) => m.importance >= 8 && (isUser(m) || (m.hits || 0) >= 2 || isConfig(m)));
  // 已入 core 的保留，新增按权重补
  const coreTexts = new Set(s.core.map((m) => m.text));
  for (const m of ranked(eligible)) {
    if (s.core.length >= CORE_CAP) break;
    if (coreTexts.has(m.text)) continue;
    s.core.push({ ...m, promotedAt: now() });
    coreTexts.add(m.text);
  }
  // core 里被桶淘汰的条目保留（core 独立于桶）
  if (s.core.length > CORE_CAP) s.core = ranked(s.core).slice(0, CORE_CAP);
  // 冷存储上限
  if (s.cold.length > COLD_CAP) s.cold = s.cold.slice(-COLD_CAP);
  s.stats.lastPrune = now();
  save();
  return { deleted: del, compressed: comp, core: s.core.length };
}

// 检索：core 全量 + 桶内按 关键词/实体 匹配 + 权重排序取 topN
function retrieve(key, query, topN = 12) {
  const s = ensure(key);
  const q = String(query || '');
  const all = [...s.entity, ...s.event, ...s.concept];
  // 关键词：中文按 2 字滑窗 + 实体名
  const grams = new Set();
  for (const e of [...USER_ENTITIES, ...BROAD]) if (q.includes(e)) grams.add(e);
  for (let i = 0; i + 2 <= q.length; i++) grams.add(q.slice(i, i + 2));
  const scored = all.map((m) => {
    let match = 0;
    for (const g of grams) if (g && m.text.includes(g)) match += 1;
    const entMatch = (m.entities || []).filter((e) => q.includes(e)).length;
    return { m, score: weightOf(m) + match * 8 + entMatch * 12 };
  }).sort((a, b) => b.score - a.score);
  const picked = scored.slice(0, topN).map((x) => x.m);
  return { core: s.core, picked };
}

function formatForPrompt(key, query) {
  const { core, picked } = retrieve(key, query);
  const parts = [];
  if (core.length) parts.push('[核心记忆（永久）]\n' + core.map((m) => '- ' + m.text).join('\n'));
  if (picked.length) parts.push('[相关记忆]\n' + picked.map((m) => '- ' + m.text).join('\n'));
  return parts.join('\n\n');
}

function stats(key) {
  const s = ensure(key);
  const all = [...s.entity, ...s.event, ...s.concept];
  const w = all.map(weightOf);
  return {
    core: s.core.length, entity: s.entity.length, event: s.event.length, concept: s.concept.length,
    cold: s.cold.length, total: all.length,
    avgWeight: w.length ? w.reduce((a, b) => a + b, 0) / w.length : 0,
    lastPrune: s.stats.lastPrune
  };
}

// 迁移：把旧 facts 导入新系统（[早期对话] → 冷存储；真事实 → 归桶）
function migrateLegacy(key, facts) {
  const s = ensure(key);
  const entries = [];
  const coldLegacy = [];
  for (const f of facts || []) {
    const text = String(f).trim().slice(0, 200);
    if (!text) continue;
    if (text.startsWith('[早期对话]')) { coldLegacy.push({ text, deletedAt: now(), legacy: true }); continue; }
    // 真事实：按内容归桶
    let bucket = 'concept', imp = 8;
    if (/(叫|称呼|起名|名字)/.test(text)) { bucket = 'concept'; imp = 9; }
    else if (/(喜欢|爱|喝|吃|啤酒|寿司)/.test(text)) { bucket = 'entity'; imp = 6; }
    else if (/(说|约定|提醒|打算|计划)/.test(text)) { bucket = 'event'; imp = 6; }
    const entities = [];
    for (const e of ['管理员', '博麗', '朝日', '罗斯福10号', 'DeepSeek', 'dsh', '本鲸', 'Deepsleep']) if (text.includes(e)) entities.push(e);
    entries.push({ text, bucket, importance: imp, entities, links: [] });
  }
  const r = add(key, entries, { source: 'legacy' });
  // 旧 [早期对话] 全部进冷存储（可查询恢复）
  s.cold.push(...coldLegacy);
  if (s.cold.length > COLD_CAP) s.cold = s.cold.slice(-COLD_CAP);
  save();
  return { imported: r.added, coldLegacy: coldLegacy.length };
}

module.exports = { add, reinforce, prune, retrieve, formatForPrompt, stats, migrateLegacy, weightOf, state, save };
