// lib/memory-v2.js — 分桶 + 权重打分 + 关联 + core + 软淘汰 的长期记忆引擎（v2.1）
// v2.1 新增：①矛盾失效（supersededBy/validUntil）②最近活跃度（lastHitAt/recencyFactor）
//            ③保胎层（曾主节点的关键记忆保护 + 竞争上岗）④双通道复活（实体+文本）+别名表
//            ⑤冷存储溢出压缩 + 自适应删除上限
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const STORE_DIR = path.join(ROOT, 'storage');
const V2_FILE = path.join(STORE_DIR, 'memory-v2.json');

// ---- 可配置参数 ----
const CONFIG = {
  caps: { entity: 50, event: 80, concept: 60 },
  coreCap: 20,
  coldCap: 300,
  broad: { minDegree: 5, ratio: 0.15, minFreq: 0.2, weightThreshold: 70 }, // 70 补偿 recency ×1.3
  userEntities: ['管理员', '博麗', '博麗ユキ'],
  cold: { maxAgeDays: 60, minWeight: 20 },
  condense: { baseCap: 8, maxCap: 20, chunkSize: 20, minQuietMs: 30 * 60000, maxDelayMs: 2 * 3600000 },
  recency: { freshDays: 7, staleDays: 30, freshBoost: 1.3, stalePenalty: 0.8 },
  protect: { peakDegree: 15, peakWeight: 80, days: 180, maxItems: 30, perTopic: 4 },
  prune: { softCapDelete: 0.2, hardCapDelete: 0.5, hardCapRatio: 0.9, lowWeight: 40, compressBelow: 65 },
  coldCompress: { enabled: true, pageSize: 30 },
  revive: { textOverlap: true, aliasTable: true, maxPerRound: 12 },
};

const BROAD = new Set(['dsh', '本鲸', 'Deepsleep']);

function now() { return Date.now(); }
function readJson(f, fb) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } }
function writeJson(f, d) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(d, null, 2)); }

let cache = null;
function state() { if (!cache) cache = readJson(V2_FILE, {}); return cache; }
function save() { writeJson(V2_FILE, state()); }

function ensure(key) {
  const s = state();
  if (!s[key]) s[key] = { core: [], entity: [], event: [], concept: [], cold: [], meta: { broadEntities: [], entityStats: {}, lastRecheck: 0, entityAliases: {} }, stats: { createdAt: now(), lastPrune: 0, lastCondenseAt: 0, condensedLen: 0 } };
  const st = s[key];
  if (!st.meta) st.meta = { broadEntities: [], entityStats: {}, lastRecheck: 0, entityAliases: {} };
  if (!st.meta.entityAliases) st.meta.entityAliases = {};
  if (!st.stats) st.stats = { createdAt: now(), lastPrune: 0, lastCondenseAt: 0, condensedLen: 0 };
  return st;
}

function isSpecific(m) { return (m.entities || []).some((e) => !BROAD.has(e)); }
function isUser(m) { return (m.entities || []).some((e) => CONFIG.userEntities.includes(e)); }
function isConfig(m) { return /窗口|配置|策略|护栏|压缩|升级|版本/.test(m.text || ''); }
function isProtected(m) { return !!(m.protectedUntil && m.protectedUntil > now()); }

// 衰减按「最近活跃」而非创建时间：话题回归（被命中）时记忆重新变新（人类记忆强化效应）
function decay(m) { const base = m.lastHitAt || m.createdAt || now(); const w = Math.max(0, (now() - base) / 86400000); return Math.pow(0.85, Math.floor(w / 7)); }
function protectDecay(m) { const base = m.lastHitAt || m.createdAt || now(); const w = Math.max(0, (now() - base) / 86400000); return Math.pow(0.98, Math.floor(w / 30)); }
function recencyFactor(m) {
  const last = m.lastHitAt || m.createdAt || now();
  const days = (now() - last) / 86400000;
  if (days <= CONFIG.recency.freshDays) return CONFIG.recency.freshBoost;
  if (days <= CONFIG.recency.staleDays) return 1;
  return CONFIG.recency.stalePenalty;
}
function weightOf(m) {
  if (m.validUntil && m.validUntil <= now()) return 0; // 已被新记忆取代（失效）
  const iso = (isSpecific(m) || isUser(m) || isConfig(m)) ? 1 : 0.6;
  const hits = Math.min(10, m.hits || 0);
  const rec = recencyFactor(m);
  const dec = m.inCore ? 1 : (isProtected(m) ? protectDecay(m) : decay(m));
  return 60 * ((m.importance || 5) / 5) * (1 + hits * 0.1) * (1 + (m.links || []).length * 0.15) * rec * dec * iso;
}
function ranked(arr) { return arr.slice().sort((a, b) => weightOf(b) - weightOf(a)); }
function toBucket(m) { return (m.bucket === 'entity' || m.bucket === 'event' || m.bucket === 'concept') ? m.bucket : 'event'; }

// ---- 别名归一（双通道复活辅助）----
function normalizeEntities(key, ents) {
  const s = ensure(key);
  const aliases = s.meta.entityAliases || {};
  const out = [];
  for (const e of ents || []) {
    let name = e;
    for (const [canon, list] of Object.entries(aliases)) { if ((list || []).includes(e)) { name = canon; break; } }
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

// ---- 加记忆 ----
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
      entities: normalizeEntities(key, Array.isArray(e.entities) ? e.entities.slice(0, 6) : []),
      links: Array.isArray(e.links) ? e.links.slice(0, 6) : [],
      keywords: Array.isArray(e.keywords) ? e.keywords.slice(0, 8) : [],
      hits: 0,
      lastHitAt: opts.createdAt || now(),
      createdAt: opts.createdAt || now(),
      source: opts.source || 'auto',
      inCore: false,
      protectedUntil: null,
      validUntil: null,
      supersededBy: null,
    };
    if (opts.explicit) item.importance = Math.max(item.importance, 8);
    s[bucket].push(item);
    added++;
  }
  save();
  return { added };
}

// ---- 矛盾失效：把旧记忆标记为被新记忆取代 ----
function markSuperseded(key, oldIds, newText) {
  const s = ensure(key);
  const all = [...s.core, ...s.entity, ...s.event, ...s.concept];
  let n = 0;
  for (const id of oldIds || []) {
    const m = all.find((x) => x.id === id);
    if (!m) continue;
    m.validUntil = now();
    m.supersededBy = newText || '（新记忆）';
    n++;
  }
  save();
  return { superseded: n };
}

// ---- 关联强化 + 双通道复活 ----
function bigrams(text) {
  const out = new Set();
  const t = String(text || '');
  for (let i = 0; i + 2 <= t.length; i++) out.add(t.slice(i, i + 2));
  return out;
}
function reinforce(key, newEntries) {
  const s = ensure(key);
  const all = [...s.core, ...s.entity, ...s.event, ...s.concept];
  const ents = new Set();
  for (const e of newEntries || []) for (const ent of normalizeEntities(key, e.entities || [])) ents.add(ent);
  const textGrams = new Set();
  if (CONFIG.revive.textOverlap) for (const e of newEntries || []) for (const g of bigrams(e.text)) textGrams.add(g);
  // 活跃桶：实体命中 → hits++/lastHitAt 刷新
  for (const m of all) {
    const hit = (m.entities || []).some((ent) => ents.has(ent));
    const mg = bigrams(m.text);
    let textHit = false;
    if (CONFIG.revive.textOverlap && textGrams.size) { let ov = 0; for (const g of mg) if (textGrams.has(g)) ov++; textHit = ov >= 3; }
    if (hit || textHit) {
      m.hits = Math.min(10, (m.hits || 0) + 1);
      m.lastHitAt = now();
    }
  }
  // 冷存储复活：双通道（实体 or 文本重叠）→ 排序后限量复活（排序回归方案：实体命中 + 重叠度 + 权重，每轮最多 maxPerRound 条）
  const candidates = [];
  for (const m of s.cold) {
    const entHit = ents.size > 0 && (m.entities || []).some((ent) => ents.has(ent));
    let overlap = 0;
    if (CONFIG.revive.textOverlap && textGrams.size) {
      const mg = bigrams(m.text);
      for (const g of mg) if (textGrams.has(g)) overlap++;
    }
    const textHit = overlap >= 3;
    if (entHit || textHit) candidates.push({ m, score: (entHit ? 10 : 0) + Math.min(overlap, 20) * 2 + weightOf(m) / 100 });
  }
  candidates.sort((a, b) => b.score - a.score);
  const limited = candidates.slice(0, CONFIG.revive.maxPerRound);
  const revivedIds = new Set(limited.map((x) => x.m.id));
  const revived = [];
  s.cold = s.cold.filter((m) => {
    if (!revivedIds.has(m.id)) return true; // 超额的留在冷存储等下次
    m.revivedAt = now();
    m.hits = Math.min(10, (m.hits || 0) + 1);
    m.lastHitAt = now();
    s[toBucket(m)].push(m);
    revived.push(m.id);
    return false;
  });
  save();
  return { revived: revived.length, revivedLeft: candidates.length - revived.length };
}

// ---- 超级节点统计与自动分类（含历史峰值，用于保胎判定）----
function superNodeStats(key, total) {
  const s = ensure(key);
  const activeCount = [...s.entity, ...s.event, ...s.concept].length; // 阈值/频率用活跃桶条数
  const all = [...s.entity, ...s.event, ...s.concept, ...s.cold];
  const stats = s.meta.entityStats || {};
  const seen = {};
  for (const m of all) for (const e of (m.entities || [])) {
    if (!seen[e]) seen[e] = { degree: 0, weightSum: 0, n: 0 };
    seen[e].degree++;
    seen[e].weightSum += weightOf(m);
    seen[e].n++;
  }
  for (const e of Object.keys(seen)) {
    const st = seen[e];
    st.avgWeight = st.weightSum / st.n;
    st.freq = st.degree / Math.max(1, activeCount);
    const prev = stats[e] || {};
    st.peakDegree = Math.max(prev.peakDegree || 0, st.degree);
    st.peakWeight = Math.max(prev.peakWeight || 0, st.avgWeight);
    stats[e] = st;
  }
  const broadSet = new Set();
  for (const [e, st] of Object.entries(stats)) {
    const userExempt = CONFIG.userEntities.includes(e);
    const degreeHigh = st.degree >= Math.max(CONFIG.broad.minDegree, Math.floor(all.length * CONFIG.broad.ratio));
    const freqHigh = st.freq >= CONFIG.broad.minFreq;
    const weakLinks = st.avgWeight < CONFIG.broad.weightThreshold;
    if (!userExempt && degreeHigh && freqHigh && weakLinks) broadSet.add(e);
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
// 主节点候选（保胎用）：历史峰值度数/权重达标
function isMainTopic(st) {
  if (!st) return false;
  const deg = st.peakDegree || 0;
  const w = st.peakWeight || 0;
  // 主节点：度数达标（真话题），或度数至少 5 且权重高（重要小话题）——只出现 1-2 次的不算
  if (deg >= CONFIG.protect.peakDegree) return true;
  if (deg >= 5 && w >= CONFIG.protect.peakWeight) return true;
  return false;
}

// ---- 保胎层：给主节点的关键记忆打保护 + 竞争 ----
function applyProtection(key) {
  const s = ensure(key);
  const all = [...s.entity, ...s.event, ...s.concept];
  const stats = s.meta.entityStats || {};
  const mainEnts = Object.entries(stats).filter(([, st]) => isMainTopic(st)).map(([e]) => e);
  if (!mainEnts.length) return { protected: 0 };
  const currentlyProtected = all.filter((m) => isProtected(m));
  let n = 0;
  for (const ent of mainEnts) {
    const related = all.filter((m) => (m.entities || []).includes(ent) && !m.inCore);
    const top = ranked(related).slice(0, CONFIG.protect.perTopic);
    for (const m of top) {
      if (isProtected(m)) continue;
      if (currentlyProtected.length >= CONFIG.protect.maxItems) {
        const weakest = currentlyProtected.length ? currentlyProtected.reduce((a, b) => (weightOf(a) < weightOf(b) ? a : b)) : null;
        if (!weakest || weightOf(m) <= weightOf(weakest)) continue; // 权重不够，不保护
        weakest.protectedUntil = null; // 解除最弱保护（降级回正常演化）
        currentlyProtected.splice(currentlyProtected.indexOf(weakest), 1);
      }
      m.protectedUntil = now() + CONFIG.protect.days * 86400000;
      m.protectedFrom = ent;
      currentlyProtected.push(m);
      n++;
    }
  }
  save();
  return { protected: n, totalProtected: all.filter((m) => isProtected(m)).length };
}

// ---- 冷存储溢出压缩（循环压缩直到回到上限内，绝不直接丢弃）----
function compressCold(key) {
  const s = ensure(key);
  if (!CONFIG.coldCompress.enabled) return { compressed: 0 };
  let total = 0;
  while (s.cold.length > CONFIG.coldCap) {
    const page = CONFIG.coldCompress.pageSize;
    const oldest = s.cold.slice(0, page);
    const text = '[冷存储压缩] ' + oldest.map((m) => String(m.text || '').slice(0, 50)).join('；').slice(0, 200);
    s.cold = s.cold.slice(page);
    s.cold.push({ id: 'c' + now().toString(36) + Math.random().toString(36).slice(2, 5), text, deletedAt: now(), compressedFrom: oldest.length, weight: 25, reason: 'coldCompress' });
    total += oldest.length;
    if (oldest.length === 0) break;
  }
  return { compressed: total };
}

// ---- 淘汰 + core 晋升 + 保胎 ----
function prune(key) {
  const s = ensure(key);
  const all = [...s.entity, ...s.event, ...s.concept];
  if (!all.length) return { deleted: 0, compressed: 0, core: s.core.length, cold: s.cold.length };
  const ratio = all.length / (CONFIG.caps.entity + CONFIG.caps.event + CONFIG.caps.concept);
  const delRatio = ratio >= CONFIG.prune.hardCapRatio ? CONFIG.prune.hardCapDelete : CONFIG.prune.softCapDelete;
  const capDel = Math.max(1, Math.ceil(all.length * delRatio));
  let del = 0, comp = 0;
  const next = { entity: [], event: [], concept: [] };
  for (const k of ['entity', 'event', 'concept']) {
    for (const m of s[k]) {
      if (m.validUntil && m.validUntil <= now()) continue; // 已失效 → 出桶（信息保留在 supersededBy 记录）
      if (isProtected(m)) { next[k].push(m); continue; } // 保胎：跳过常规淘汰
      const w = weightOf(m);
      if (w < CONFIG.prune.lowWeight && del < capDel) { s.cold.push({ ...m, weight: w, deletedAt: now(), reason: 'lowWeight' }); del++; continue; }
      if (w < CONFIG.prune.compressBelow) { m.compressed = true; comp++; }
      next[k].push(m);
    }
  }
  // 桶上限硬截断 → 被截条目进冷存储（保护层优先保留）
  let overflow = 0;
  for (const k of ['entity', 'event', 'concept']) {
    if (next[k].length > CONFIG.caps[k]) {
      const sorted = next[k].slice().sort((a, b) => (isProtected(b) ? 1 : 0) - (isProtected(a) ? 1 : 0) || weightOf(b) - weightOf(a));
      const keep = sorted.slice(0, CONFIG.caps[k]);
      const drop = sorted.slice(CONFIG.caps[k]);
      for (const m of drop) { s.cold.push({ ...m, weight: weightOf(m), deletedAt: now(), reason: 'overflow' }); overflow++; }
      next[k] = keep;
    }
    s[k] = next[k];
  }
  // 超级节点检测（含历史峰值）
  superNodeStats(key, [...s.entity, ...s.event, ...s.concept].length);
  // 保胎层
  applyProtection(key);
  // core 晋升：竞争上岗（移动而非复制），core 不衰减
  const all2 = [...s.entity, ...s.event, ...s.concept];
  const eligible = all2.filter((m) => m.importance >= 8 && (isUser(m) || m.importance >= 9 || (m.hits || 0) >= 2 || isConfig(m)));
  const coreTexts = new Set(s.core.map((m) => m.text));
  const removeFromBucket = (m) => { const b = toBucket(m); s[b] = s[b].filter((x) => x !== m && x.id !== m.id); };
  const demote = (m) => { m.demotedFromCore = now(); m.inCore = false; s[toBucket(m)].push(m); };
  for (const m of ranked(eligible)) {
    if (coreTexts.has(m.text)) continue;
    if (s.core.length < CONFIG.coreCap) {
      removeFromBucket(m);
      s.core.push({ ...m, promotedAt: now(), inCore: true, permanent: isUser(m) || isConfig(m) });
      coreTexts.add(m.text);
    } else {
      let worst = null, worstW = Infinity;
      for (const c of s.core) { if (c.permanent) continue; const w = weightOf(c); if (w < worstW) { worstW = w; worst = c; } }
      if (worst && weightOf(m) > worstW) {
        s.core = s.core.filter((x) => x !== worst);
        demote(worst);
        coreTexts.delete(worst.text);
        removeFromBucket(m);
        s.core.push({ ...m, promotedAt: now(), inCore: true, permanent: isUser(m) || isConfig(m) });
        coreTexts.add(m.text);
      }
    }
  }
  if (s.core.length > CONFIG.coreCap) {
    const sorted = ranked(s.core).sort((a, b) => (b.permanent ? 1 : 0) - (a.permanent ? 1 : 0));
    const keep = sorted.slice(0, CONFIG.coreCap);
    const drop = sorted.slice(CONFIG.coreCap);
    for (const m of drop) { if (!m.permanent) demote(m); }
    s.core = keep;
  }
  // 冷存储二级淘汰 + 溢出压缩
  const coldBefore = s.cold.length;
  s.cold = s.cold.filter((m) => {
    const ageDays = (now() - (m.deletedAt || now())) / 86400000;
    const w = m.weight != null ? m.weight : weightOf(m);
    if (ageDays > CONFIG.cold.maxAgeDays && w < CONFIG.cold.minWeight) return false;
    return true;
  });
  const coldComp = compressCold(key);
  if (s.cold.length > CONFIG.coldCap) s.cold = s.cold.slice(-CONFIG.coldCap);
  s.stats.lastPrune = now();
  save();
  return { deleted: del, compressed: comp, overflow, core: s.core.length, cold: s.cold.length, coldPurged: coldBefore - s.cold.length, coldCompressed: coldComp.compressed, protected: all.filter((m) => isProtected(m)).length };
}

// ---- 检索：core + 桶 + 冷存储兜底（有效记忆优先，失效标记）----
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
  const superseded = all.filter((m) => m.validUntil && m.validUntil <= now());
  const needCold = opts.recall || picked.length < Math.min(topN, 6);
  let coldPicked = [];
  if (needCold && s.cold.length) {
    coldPicked = s.cold.map((m) => ({ m, score: scoreOf(m) })).sort((a, b) => b.score - a.score)
      .filter((x) => x.m.text && (opts.recall || x.score > 30))
      .slice(0, Math.max(3, Math.floor(topN / 3))).map((x) => x.m);
  }
  return { core: s.core, picked, cold: coldPicked, superseded };
}

function formatForPrompt(key, query, opts = {}) {
  const { core, picked, cold, superseded } = retrieve(key, query, 12, opts);
  const parts = [];
  if (core.length) parts.push('[核心记忆（永久）]\n' + core.map((m) => '- ' + m.text).join('\n'));
  if (picked.length) parts.push('[相关记忆]\n' + picked.map((m) => '- ' + m.text).join('\n'));
  if (superseded && superseded.length) parts.push('[已更新的旧记忆]\n' + superseded.slice(0, 3).map((m) => '- ' + m.text + '（已被后来发生的事更新）').join('\n'));
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
    protected: all.filter((m) => isProtected(m)).length,
    avgWeight: w.length ? w.reduce((a, b) => a + b, 0) / w.length : 0,
    broadEntities: (s.meta.broadEntities || []).length,
    lastPrune: s.stats.lastPrune
  };
}

// ---- 迁移：旧 facts 导入 ----
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

module.exports = { CONFIG, add, reinforce, prune, retrieve, formatForPrompt, stats, migrateLegacy, state, save, weightOf, superNodeStats, isBroad, markSuperseded, applyProtection };
