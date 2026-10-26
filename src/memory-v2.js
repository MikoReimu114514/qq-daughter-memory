// lib/memory-v2.js — 分桶 + 权重打分 + 关联 + core + 软淘汰 的长期记忆引擎（v2）
// 设计依据：2026-10 与管理员共同设计；实测结论：权重是主淘汰轴、关联是加分项、六度只标孤立点、用户实体不是宽泛噪音。
// v2 新增：①桶溢出进冷存储 ②冷存储激活（检索兜底/关联复活/显式回忆/二级淘汰）③超级节点自动检测与纠错
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const STORE_DIR = path.join(ROOT, 'storage');
const V2_FILE = path.join(STORE_DIR, 'memory-v2.json');

// ---- 可配置参数（换平台只改这里/传 opts）----
const CONFIG = {
  caps: { entity: 50, event: 80, concept: 60 },
  coreCap: 20,
  coldCap: 300,
  broad: { minDegree: 5, ratio: 0.15, minFreq: 0.2, weightThreshold: 55, recheckDays: 7 },
  userEntities: ['管理员', '博麗', '博麗ユキ'],
  cold: { maxAgeDays: 60, minWeight: 20 },
  condense: { baseCap: 8, maxCap: 20, chunkSize: 20, minQuietMs: 30 * 60000, maxDelayMs: 2 * 3600000 },
};

const BROAD = new Set(['dsh', '本鲸', 'Deepsleep']); // 纯身份词（不算具体实体）

function now() { return Date.now(); }
function readJson(f, fb) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } }
function writeJson(f, d) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(d, null, 2)); }

let cache = null;
function state() { if (!cache) cache = readJson(V2_FILE, {}); return cache; }
function save() { writeJson(V2_FILE, state()); }

function ensure(key) {
  const s = state();
  if (!s[key]) s[key] = { core: [], entity: [], event: [], concept: [], cold: [], meta: { broadEntities: [], entityStats: {}, lastRecheck: 0 }, stats: { createdAt: now(), lastPrune: 0, lastCondenseAt: 0, condensedLen: 0 } };
  const st = s[key];
  if (!st.meta) st.meta = { broadEntities: [], entityStats: {}, lastRecheck: 0 };
  if (!st.stats) st.stats = { createdAt: now(), lastPrune: 0, lastCondenseAt: 0, condensedLen: 0 };
  return st;
}

function isSpecific(m) { return (m.entities || []).some((e) => !BROAD.has(e) && !(state()[`${m._key || ''}`] || {}).meta); }
function isUser(m) { return (m.entities || []).some((e) => CONFIG.userEntities.includes(e)); }
function isConfig(m) { return /窗口|配置|策略|护栏|压缩|升级|版本/.test(m.text || ''); }
function isBroadEntity(ent) { return BROAD.has(ent); }

function decay(m) { const w = Math.max(0, (now() - (m.createdAt || now())) / 86400000); return Math.pow(0.85, Math.floor(w / 7)); }
function weightOf(m) {
  const iso = (isSpecific(m) || isUser(m) || isConfig(m)) ? 1 : 0.6;
  const hits = Math.min(10, m.hits || 0);
  const dec = m.inCore ? 1 : decay(m); // core 记忆不衰减（程序性记忆不会因久远遗忘）
  return 60 * ((m.importance || 5) / 5) * (1 + hits * 0.1) * (1 + (m.links || []).length * 0.15) * dec * iso;
}
function ranked(arr) { return arr.slice().sort((a, b) => weightOf(b) - weightOf(a)); }

// ---- ① 加记忆 ----
function add(key, entries, opts = {}) {
  if (!entries || !entries.length) return { added: 0 };
  const s = ensure(key);
  let added = 0;
  for (const e of entries) {
    const text = String(e.text || '').trim().slice(0, 200);
    if (!text) continue;
    const bucket = ['entity', 'event', 'concept'].includes(e.bucket) ? e.bucket : 'event';
    const all = [...s.core, ...s.entity, ...s.event, ...s.concept];
    if (all.some((m) => m.text === text)) continue;
    const item = {
      id: 'm' + now().toString(36) + Math.random().toString(36).slice(2, 6),
      text, bucket,
      importance: Math.max(1, Math.min(10, Number(e.importance) || 5)),
      entities: Array.isArray(e.entities) ? e.entities.slice(0, 6) : [],
      links: Array.isArray(e.links) ? e.links.slice(0, 6) : [],
      hits: 0, createdAt: opts.createdAt || now(), source: opts.source || 'auto', inCore: false
    };
    if (opts.explicit) item.importance = Math.max(item.importance, 8);
    s[bucket].push(item);
    added++;
  }
  save();
  return { added };
}

// ---- ② 关联强化：新记忆与旧记忆（桶 + 冷存储）共享实体 → 旧记忆 hits++ / 冷存储复活 ----
function reinforce(key, newEntries) {
  const s = ensure(key);
  const all = [...s.core, ...s.entity, ...s.event, ...s.concept];
  const ents = new Set();
  for (const e of newEntries || []) for (const ent of (e.entities || [])) ents.add(ent);
  for (const m of all) {
    if (!m.hits) m.hits = 0;
    if ((m.entities || []).some((ent) => ents.has(ent))) m.hits = Math.min(10, m.hits + 1);
  }
  // 冷存储复活：cold 里与新记忆共享实体的条目 → 移回桶
  const revived = [];
  s.cold = s.cold.filter((m) => {
    const hit = ents.size > 0 && (m.entities || []).some((ent) => ents.has(ent));
    if (hit) {
      const bucket = (m.bucket === 'entity' || m.bucket === 'event' || m.bucket === 'concept') ? m.bucket : 'event';
      m.revivedAt = now(); m.hits = Math.min(10, (m.hits || 0) + 1);
      s[bucket].push(m);
      revived.push(m.id);
      return false; // 移出 cold
    }
    return true;
  });
  save();
  return { revived: revived.length };
}

// ---- ③ 超级节点统计与自动分类（动态黑名单 + 纠错）----
function superNodeStats(key, total) {
  const s = ensure(key);
  // 统计含冷存储（历史）——只看当前桶会被截断稀释，泛词度数统计不出来
  const all = [...s.entity, ...s.event, ...s.concept, ...s.cold];
  const stats = {};
  for (const m of all) for (const e of (m.entities || [])) {
    if (!stats[e]) stats[e] = { degree: 0, weightSum: 0, n: 0 };
    stats[e].degree++;
    stats[e].weightSum += weightOf(m);
    stats[e].n++;
  }
  for (const e of Object.keys(stats)) {
    stats[e].avgWeight = stats[e].weightSum / stats[e].n;
    stats[e].freq = stats[e].degree / Math.max(1, all.length);
  }
  const prev = new Set(s.meta.broadEntities || []);
  const broadSet = new Set();
  for (const [e, st] of Object.entries(stats)) {
    const userExempt = CONFIG.userEntities.includes(e);
    const degreeHigh = st.degree >= Math.max(CONFIG.broad.minDegree, Math.floor(all.length * CONFIG.broad.ratio));
    const freqHigh = st.freq >= CONFIG.broad.minFreq;
    const weakLinks = st.avgWeight < CONFIG.broad.weightThreshold;
    if (!userExempt && degreeHigh && freqHigh && weakLinks) broadSet.add(e);
    // 复审纠错：之前被判宽泛但度数/权重回升 → 移出（保留用户实体豁免）
    if (prev.has(e) && (st.degree < CONFIG.broad.minDegree || st.weightSum / st.n >= CONFIG.broad.weightThreshold + 10)) {
      // 不加入 broadSet（自然移出）
    }
  }
  s.meta.entityStats = stats;
  s.meta.broadEntities = [...broadSet];
  s.meta.lastRecheck = now();
  return { broad: [...broadSet], stats };
}
function isBroad(key, ent) {
  const s = ensure(key);
  return BROAD.has(ent) || (s.meta.broadEntities || []).includes(ent);
}

// ---- ④ 淘汰 + core 晋升 + 桶溢出进冷存储 + cold 二级淘汰 ----
function prune(key) {
  const s = ensure(key);
  const all = [...s.entity, ...s.event, ...s.concept];
  if (!all.length) return { deleted: 0, compressed: 0, core: s.core.length, cold: s.cold.length };
  const capDel = Math.max(1, Math.ceil(all.length * 0.2));
  let del = 0, comp = 0;
  const next = { entity: [], event: [], concept: [] };
  for (const k of ['entity', 'event', 'concept']) {
    for (const m of s[k]) {
      const w = weightOf(m);
      if (w < 30 && del < capDel) { s.cold.push({ ...m, weight: w, deletedAt: now(), reason: 'lowWeight' }); del++; continue; }
      if (w < 50) { m.compressed = true; comp++; }
      next[k].push(m);
    }
  }
  // ① 桶上限硬截断 → 被截条目进冷存储（不丢失）
  let overflow = 0;
  for (const k of ['entity', 'event', 'concept']) {
    if (next[k].length > CONFIG.caps[k]) {
      const sorted = ranked(next[k]);
      const keep = sorted.slice(0, CONFIG.caps[k]);
      const drop = sorted.slice(CONFIG.caps[k]);
      for (const m of drop) { s.cold.push({ ...m, weight: weightOf(m), deletedAt: now(), reason: 'overflow' }); overflow++; }
      next[k] = keep;
    }
    s[k] = next[k];
  }
  // core 晋升：竞争上岗——core 满时，新记忆权重高于 core 最低分则替换（最低分降回桶，不丢）
  const all2 = [...s.entity, ...s.event, ...s.concept];
  const eligible = all2.filter((m) => m.importance >= 8 && (isUser(m) || (m.hits || 0) >= 2 || isConfig(m)));
  const coreTexts = new Set(s.core.map((m) => m.text));
  const bucketOf = (m) => (m.bucket === 'entity' || m.bucket === 'event' || m.bucket === 'concept') ? m.bucket : 'event';
  const removeFromBucket = (m) => { const b = bucketOf(m); s[b] = s[b].filter((x) => x !== m && x.id !== m.id); };
  const demote = (m) => { // 降回桶（不丢）
    m.demotedFromCore = now();
    m.inCore = false;
    s[bucketOf(m)].push(m);
  };
  for (const m of ranked(eligible)) {
    if (coreTexts.has(m.text)) continue;
    if (s.core.length < CONFIG.coreCap) {
      removeFromBucket(m); // 移动而非复制：从桶里移除
      s.core.push({ ...m, promotedAt: now(), inCore: true });
      coreTexts.add(m.text);
    } else {
      let worst = null, worstW = Infinity;
      for (const c of s.core) { const w = weightOf(c); if (w < worstW) { worstW = w; worst = c; } }
      if (worst && weightOf(m) > worstW) {
        s.core = s.core.filter((x) => x !== worst);
        demote(worst);
        coreTexts.delete(worst.text);
        removeFromBucket(m); // 晋升者从桶里移除
        s.core.push({ ...m, promotedAt: now(), inCore: true });
        coreTexts.add(m.text);
      }
    }
  }
  // 兜底：core 仍超限 → 按权重降回桶（绝不丢弃）
  if (s.core.length > CONFIG.coreCap) {
    const sorted = ranked(s.core);
    const keep = sorted.slice(0, CONFIG.coreCap);
    const drop = sorted.slice(CONFIG.coreCap);
    for (const m of drop) demote(m);
    s.core = keep;
  }
  // ③ 超级节点自动检测
  superNodeStats(key, all2.length);
  // ② 冷存储二级淘汰（超龄 + 低权重 → 真正删除）
  const coldBefore = s.cold.length;
  s.cold = s.cold.filter((m) => {
    const ageDays = (now() - (m.deletedAt || now())) / 86400000;
    const w = m.weight != null ? m.weight : weightOf(m);
    if (ageDays > CONFIG.cold.maxAgeDays && w < CONFIG.cold.minWeight) return false;
    return true;
  });
  if (s.cold.length > CONFIG.coldCap) s.cold = s.cold.slice(-CONFIG.coldCap);
  s.stats.lastPrune = now();
  save();
  return { deleted: del, compressed: comp, overflow, core: s.core.length, cold: s.cold.length, coldPurged: coldBefore - s.cold.length };
}

// ---- ② 检索：core + 桶 + 冷存储兜底（含"记忆深处"来源标记）----
function retrieve(key, query, topN = 12, opts = {}) {
  const s = ensure(key);
  const q = String(query || '');
  const grams = new Set();
  for (const e of [...CONFIG.userEntities, ...BROAD, ...(s.meta.broadEntities || [])]) if (q.includes(e)) grams.add(e);
  for (let i = 0; i + 2 <= q.length; i++) grams.add(q.slice(i, i + 2));
  const scoreOf = (m) => {
    let match = 0;
    for (const g of grams) if (g && m.text.includes(g)) match += 1;
    const entMatch = (m.entities || []).filter((e) => q.includes(e)).length;
    return weightOf(m) + match * 8 + entMatch * 12;
  };
  const all = [...s.entity, ...s.event, ...s.concept];
  const scored = all.map((m) => ({ m, score: scoreOf(m) })).sort((a, b) => b.score - a.score);
  const picked = scored.slice(0, topN).map((x) => x.m);
  // 冷存储兜底：桶结果不够或显式回忆 → 补 cold
  const needCold = opts.recall || picked.length < Math.min(topN, 6);
  let coldPicked = [];
  if (needCold && s.cold.length) {
    coldPicked = s.cold.map((m) => ({ m, score: scoreOf(m) })).sort((a, b) => b.score - a.score)
      .filter((x) => x.m.text && (opts.recall || x.score > 30))
      .slice(0, Math.max(3, Math.floor(topN / 3))).map((x) => x.m);
  }
  return { core: s.core, picked, cold: coldPicked };
}

function formatForPrompt(key, query, opts = {}) {
  const { core, picked, cold } = retrieve(key, query, 12, opts);
  const parts = [];
  if (core.length) parts.push('[核心记忆（永久）]\n' + core.map((m) => '- ' + m.text).join('\n'));
  if (picked.length) parts.push('[相关记忆]\n' + picked.map((m) => '- ' + m.text).join('\n'));
  if (cold.length) parts.push('[记忆深处（很久以前的事，可能不完整）]\n' + cold.map((m) => '- ' + m.text).join('\n'));
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
    broadEntities: (s.meta.broadEntities || []).length,
    lastPrune: s.stats.lastPrune
  };
}

// ---- 迁移：旧 facts 导入（真事实→桶；[早期对话]→冷存储）----
function migrateLegacy(key, facts) {
  const s = ensure(key);
  const entries = [];
  const coldLegacy = [];
  for (const f of facts || []) {
    const text = String(f).trim().slice(0, 200);
    if (!text) continue;
    if (text.startsWith('[早期对话]')) { coldLegacy.push({ text, deletedAt: now(), legacy: true, reason: 'legacy' }); continue; }
    let bucket = 'concept', imp = 8;
    if (/(叫|称呼|起名|名字)/.test(text)) { bucket = 'concept'; imp = 9; }
    else if (/(喜欢|爱|喝|吃|啤酒|寿司)/.test(text)) { bucket = 'entity'; imp = 6; }
    else if (/(说|约定|提醒|打算|计划)/.test(text)) { bucket = 'event'; imp = 6; }
    const entities = [];
    for (const e of ['管理员', '博麗', '朝日', '罗斯福10号', 'DeepSeek', 'dsh', '本鲸', 'Deepsleep']) if (text.includes(e)) entities.push(e);
    entries.push({ text, bucket, importance: imp, entities, links: [] });
  }
  const r = add(key, entries, { source: 'legacy' });
  s.cold.push(...coldLegacy);
  if (s.cold.length > CONFIG.coldCap) s.cold = s.cold.slice(-CONFIG.coldCap);
  save();
  return { imported: r.added, coldLegacy: coldLegacy.length };
}

module.exports = { CONFIG, add, reinforce, prune, retrieve, formatForPrompt, stats, migrateLegacy, state, save, weightOf, superNodeStats, isBroad };
