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
  caps: { entity: 75, event: 120, concept: 90 },
  coreCap: 20,
  coldCap: 450,
  broad: { minDegree: 5, ratio: 0.15, minFreq: 0.2, weightThreshold: 70 }, // 70 补偿 recency ×1.3
  userEntities: ['管理员', '博麗', '博麗ユキ'],
  cold: { maxAgeDays: 60, minWeight: 20 },
  condense: { minCap: 3, maxCap: 40, chunkSize: 20, minQuietMs: 30 * 60000, maxDelayMs: 2 * 3600000 },
  recency: { freshDays: 7, staleDays: 30, freshBoost: 1.3, stalePenalty: 0.8 },
  protect: { enabled: true, peakDegree: 15, peakWeight: 80, days: 180, maxItems: 30, perTopic: 4 },
  prune: { softCapDelete: 0.2, hardCapDelete: 0.5, hardCapRatio: 0.9, lowWeight: 40, compressBelow: 65 },
  coldCompress: { enabled: true, pageSize: 30 },
  revive: { textOverlap: true, aliasTable: true, maxPerRound: 12 },
  dedupe: { enabled: true, similarity: 0.6 }, // 近重复合并阈值（字面；语义重复交给 LLM）
  markers: { enabled: true, boost: 1, words: ['必须', '永远', '绝不要', '绝不', '禁止', '安全', '总是', '一定', '千万不要', '务必', '切记', 'never', 'always', 'must', 'mandatory', 'critical'] }, // 内容标记加成：命中关键词 → importance +boost（补 LLM 漏判）
  floor: { enabled: true, minImportance: 8, floorRatio: 0.7 }, // 衰减下限：重要记忆(imp≥8)衰减不跌破 70%（防误删）
  contradict: { enabled: true, minOverlap: 0.5, pairs: [['喜欢','讨厌'],['是','不是'],['有','没有'],['开','关'],['要','不要'],['能','不能'],['会','不会'],['同意','反对'],['增加','减少'],['涨','跌'],['开始','结束'],['开','关'],['好','坏'],['爱','恨'],['去','留']] }, // 规则矛盾检测（反义词对，补 LLM 漏）
  embed: { enabled: false, url: 'http://127.0.0.1:11434', model: 'bge-m3', weight: 40 }, // 语义检索开关（实测短事实记忆下向量拖后腿，默认关；开启改 true）
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
  if (!s[key]) s[key] = { core: [], taboo: [], entity: [], event: [], concept: [], cold: [], meta: { broadEntities: [], entityStats: {}, lastRecheck: 0, entityAliases: {} }, stats: { createdAt: now(), lastPrune: 0, lastCondenseAt: 0, condensedLen: 0 } };
  const st = s[key];
  if (!st.taboo) st.taboo = [];
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
  const dec0 = m.inCore ? 1 : (isProtected(m) ? protectDecay(m) : decay(m));
  const dec = (CONFIG.floor && CONFIG.floor.enabled && (m.importance || 5) >= CONFIG.floor.minImportance) ? Math.max(dec0, CONFIG.floor.floorRatio) : dec0;
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
    const bucket = ['entity', 'event', 'concept', 'taboo'].includes(e.bucket) ? e.bucket : 'event';
    const all = [...s.core, ...(s.taboo || []), ...s.entity, ...s.event, ...s.concept];
    if (all.some((m) => m.text === text)) continue;
    // 近重复检测：与已有记忆相似度≥阈值 → 强化已有（不新增）
    if (CONFIG.dedupe.enabled) {
      const dup = all.find((m) => similarity(m.text, text) >= CONFIG.dedupe.similarity);
      if (dup) {
        const numsOf = (s) => (String(s).match(/\d[\d,.]*|\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+[a-z]{3,}s\b/gi) || []).map((x) => x.replace(/[.,]/g, '').toLowerCase()).sort().join('|');
        const numsOld = numsOf(dup.text), numsNew = numsOf(text);
        if (numsOld !== numsNew && numsNew) {
          dup.text = text;
          dup.eventDate = Date.parse(String(e.event_date || '').replace(/\//g, '-')) || now();
          dup.lastHitAt = now();
          dup.updated = true;
        } else {
          dup.hits = Math.min(10, (dup.hits || 0) + 1);
          dup.lastHitAt = now();
        }
        continue;
      }
    }
    // 规则矛盾兜底：新记忆与已有矛盾（反义词对+同主题）→ 旧记忆标记失效
    if (CONFIG.contradict && CONFIG.contradict.enabled) {
      const conflictOld = all.filter((m) => m.text !== text && detectRuleConflict(text, m.text));
      if (conflictOld.length) markSuperseded(key, conflictOld.map((m) => m.id), text);
    }
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
      ...(e.event_date ? { eventDate: Date.parse(String(e.event_date).replace(/\//g, '-')) || undefined } : {}),
      source: opts.source || 'auto',
      inCore: false,
      protectedUntil: null,
      validUntil: null,
      supersededBy: null,
    };
    if (opts.explicit) item.importance = Math.max(item.importance, 8);
    // 标记加成：文本含关键标记词 → importance 提升（规则兜底，补 LLM 漏判）
    if (CONFIG.markers && CONFIG.markers.enabled && CONFIG.markers.words.some((w) => text.includes(w))) {
      item.importance = Math.min(10, item.importance + CONFIG.markers.boost);
    }
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
// 近重复相似度：2-gram 集合 Jaccard
function bigramSet(text) { const out = new Set(); const t = String(text || ''); for (let i = 0; i + 2 <= t.length; i++) out.add(t.slice(i, i + 2)); return out; }
function similarity(a, b) { const sa = bigramSet(a), sb = bigramSet(b); if (!sa.size || !sb.size) return 0; let inter = 0; for (const x of sa) if (sb.has(x)) inter++; return inter / (sa.size + sb.size - inter); }

// 规则矛盾检测：共同主题词（2-gram 重叠>=阈值）且含反义词对 → 判为矛盾
function detectRuleConflict(newText, oldText) {
  const a = String(newText || ''), b = String(oldText || '');
  if (!a || !b) return false;
  // 共同主题：2-gram 重叠比例
  const sa = bigramSet(a), sb = bigramSet(b);
  let inter = 0; for (const x of sa) if (sb.has(x)) inter++;
  const overlap = inter / Math.max(1, Math.min(sa.size, sb.size));
  if (overlap < CONFIG.contradict.minOverlap) return false;
  // 反义词对：新含 A、旧含 B（或反之）
  for (const [x, y] of CONFIG.contradict.pairs) {
    const newX = a.includes(x) && !a.includes(y);
    const oldY = b.includes(y) && !b.includes(x);
    const newY = a.includes(y) && !a.includes(x);
    const oldX = b.includes(x) && !b.includes(y);
    if ((newX && oldY) || (newY && oldX)) return true;
  }
  return false;
}

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
  if (!CONFIG.protect.enabled) return { protected: 0, totalProtected: 0 };
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

// 近重复合并（桶内）：相似度≥阈值 → 合并为一条（保留主条目，吸收 hits/entities/keywords）
function dedupe(key) {
  const s = ensure(key);
  if (!CONFIG.dedupe.enabled) return { merged: 0 };
  let merged = 0;
  for (const b of ['entity', 'event', 'concept']) {
    const arr = s[b] || [];
    const used = new Set();
    const keep = [];
    for (let i = 0; i < arr.length; i++) {
      if (used.has(i)) continue;
      const m = arr[i];
      for (let j = i + 1; j < arr.length; j++) {
        if (used.has(j)) continue;
        if (similarity(m.text, arr[j].text) >= CONFIG.dedupe.similarity) {
          used.add(j);
          const o = arr[j];
          m.hits = Math.min(10, (m.hits || 0) + (o.hits || 0));
          m.importance = Math.max(m.importance || 5, o.importance || 5);
          m.entities = [...new Set([...(m.entities || []), ...(o.entities || [])])].slice(0, 6);
          m.keywords = [...new Set([...(m.keywords || []), ...(o.keywords || [])])].slice(0, 8);
          if ((o.lastHitAt || 0) > (m.lastHitAt || 0)) m.lastHitAt = o.lastHitAt;
          merged++;
        }
      }
      keep.push(m);
    }
    s[b] = keep;
  }
  save();
  return { merged };
}

// 冷存储评分：近期活跃/权重高/刚进 cold 的优先保留（替代 FIFO）
function coldScore(m) {
  const hitBonus = (m.lastHitAt && m.createdAt && m.lastHitAt > m.createdAt) ? 30 : 0;
  const w = m.weight != null ? m.weight : weightOf(m);
  const recency = Math.max(0, 1 - (now() - (m.deletedAt || m.createdAt || now())) / (90 * 86400000));
  return hitBonus + w + recency * 20;
}

// ---- 冷存储溢出压缩（循环压缩直到回到上限内，绝不直接丢弃）----
function compressCold(key) {
  const s = ensure(key);
  if (!CONFIG.coldCompress.enabled) return { compressed: 0 };
  let total = 0;
  while (s.cold.length > CONFIG.coldCap) {
    const page = CONFIG.coldCompress.pageSize;
    // 压缩"最低分"的条目（保留近期活跃/高权重），而不是最旧的
    const victims = s.cold.slice().sort((a, b) => coldScore(a) - coldScore(b)).slice(0, page);
    const text = '[冷存储压缩] ' + victims.map((m) => String(m.text || '').slice(0, 50)).join('；').slice(0, 200);
    const victimIds = new Set(victims.map((m) => m.id));
    s.cold = s.cold.filter((m) => !victimIds.has(m.id));
    s.cold.push({ id: 'c' + now().toString(36) + Math.random().toString(36).slice(2, 5), text, deletedAt: now(), compressedFrom: victims.length, weight: 25, reason: 'coldCompress' });
    total += victims.length;
    if (victims.length === 0) break;
  }
  return { compressed: total };
}

// ---- 淘汰 + core 晋升 + 保胎 ----
function prune(key) {
  const s = ensure(key);
  const dd = dedupe(key); // 先合并近重复（减少冗余，提升检索质量）
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
      // 截断排序：保胎(2分) > 重要(importance>=8, 1分) > 权重——防「该进 core 的新条目」被旧热门挤出
      const prioOf = (m) => (isProtected(m) ? 2 : 0) + ((m.importance || 0) >= 8 ? 1 : 0);
      const sorted = next[k].slice().sort((a, b) => prioOf(b) - prioOf(a) || weightOf(b) - weightOf(a));
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
    // 近期被命中过（lastHitAt 晚于创建且在 30 天内）→ 豁免 60 天淘汰
    const recentlyHit = m.lastHitAt && m.createdAt && m.lastHitAt > m.createdAt && (now() - m.lastHitAt) < 30 * 86400000;
    if (ageDays > CONFIG.cold.maxAgeDays && w < CONFIG.cold.minWeight && !recentlyHit) return false;
    return true;
  });
  const coldComp = compressCold(key);
  if (s.cold.length > CONFIG.coldCap) {
    const sorted = s.cold.slice().sort((a, b) => coldScore(b) - coldScore(a));
    s.cold = sorted.slice(0, CONFIG.coldCap);
  }
  s.stats.lastPrune = now();
  save();
  return { deleted: del, compressed: comp, overflow, merged: dd.merged, core: s.core.length, cold: s.cold.length, coldPurged: coldBefore - s.cold.length, coldCompressed: coldComp.compressed, protected: all.filter((m) => isProtected(m)).length };
}

// ---- 检索：core + 桶 + 冷存储兜底（有效记忆优先，失效标记）----
function retrieve(key, query, topN = 12, opts = {}) {
  const s = ensure(key);
  const q = String(query || '');
  const grams = new Set();
  for (const e of [...CONFIG.userEntities, ...BROAD, ...(s.meta.broadEntities || [])]) if (q.includes(e)) grams.add(e);
  for (let i = 0; i + 2 <= q.length; i++) grams.add(q.slice(i, i + 2));
  const STOP = new Set('的了是我你他她它在有和就都而及与着或一个这那什么怎么为很还也吧呢啊嘛'.split(''));
  const qChars = [...q].filter((ch) => !STOP.has(ch));
  // 查询扩展：问爱好/约定/形象/习惯时扩展同义词（提升多会话综合召回）
  const SYNONYMS = { '爱好': ['喜欢', '爱', '玩', '兴趣'], '约定': ['答应', '说好', '拉钩', '约定'], '形象': ['鲸鱼', '围裙', '表情', '呆毛'], '习惯': ['经常', '总是', '常', '爱'], '叫法': ['叫', '称呼', '名'] };
  const synTerms = new Set();
  for (const [k, list] of Object.entries(SYNONYMS)) if (q.includes(k)) for (const t of list) synTerms.add(t);
  // 向量：语义召回（queryVec 由调用方异步 embed 后传入；无则纯 IDF）
  const vecs = loadVectors();
  const qvec = opts.queryVec || null;

  const scoreOf = (m) => {
    let match = 0;
    const mg = bigramSet(m.text);
    for (const g of grams) if (g && (mg.has(g) || m.text.includes(g))) match += idf(g);
    let charMatch = 0;
    for (const ch of qChars) if (ch && m.text.includes(ch)) charMatch += 1;
    const kwMatch = (m.keywords || []).filter((k) => q.includes(k)).length;
    const entMatch = (m.entities || []).filter((e) => q.includes(e)).length;
    return weightOf(m) + match * 8 + charMatch * 2 + kwMatch * 10 + entMatch * 12;
  };
  const all = [...s.entity, ...s.event, ...s.concept];
  // IDF：统计全库 2-gram 文档频率（高频词降权，避免管理员这类词稀释 top12）
  const df = new Map();
  for (const m of all) { const mg0 = bigramSet(m.text); for (const g of mg0) df.set(g, (df.get(g) || 0) + 1); }
  const idf = (g) => Math.log(1 + all.length / (1 + (df.get(g) || 0)));
  const scored = all.map((m) => ({ m, score: scoreOf(m) })).sort((a, b) => b.score - a.score);
  // 检索多样化：topN 内每个实体最多 3 条（避免"管理员"类高频实体占满，提升多会话综合召回）
  const picked = [];
  const entCount = new Map();
  for (const { m } of scored) {
    if (picked.length >= topN) break;
    const ents = (m.entities || []).filter(Boolean);
    let ok = true;
    for (const e of ents) if ((entCount.get(e) || 0) >= 4) { ok = false; break; } // 每实体最多 4 条（平衡多样化与特定实体查询）
    if (!ok) continue;
    picked.push(m);
    for (const e of ents) entCount.set(e, (entCount.get(e) || 0) + 1);
  }
  // 补足（多样性导致不足 topN 时）
  if (picked.length < Math.min(topN, scored.length)) {
    const have = new Set(picked);
    for (const { m } of scored) { if (picked.length >= topN) break; if (!have.has(m)) { picked.push(m); have.add(m); } }
  }
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

// ---- 向量检索（语义召回，Ollama 本地 embedding，可选降级）----
const VEC_FILE = require('path').join(__dirname, '..', 'storage', 'memory-v2.vec.json');
function loadVectors() { try { return JSON.parse(fs.readFileSync(VEC_FILE, 'utf8')); } catch { return {}; } }
function saveVectors(v) { try { fs.writeFileSync(VEC_FILE, JSON.stringify(v)); } catch {} }
function cosSim(a, b) { if (!a || !b || a.length !== b.length) return 0; let d = 0, ma = 0, mb = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; ma += a[i] * a[i]; mb += b[i] * b[i]; } return ma && mb ? d / Math.sqrt(ma * mb) : 0; }
async function embedTexts(texts) {
  if (!texts || !texts.length) return [];
  try {
    const res = await fetch(((CONFIG.embed && CONFIG.embed.url) || 'http://127.0.0.1:11434') + '/api/embed', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: (CONFIG.embed && CONFIG.embed.model) || 'bge-m3', input: texts }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data.embeddings || [];
  } catch { return []; }
}
async function ensureVectors(key) {
  const s = ensure(key);
  const all = [...s.core, ...(s.taboo || []), ...s.entity, ...s.event, ...s.concept];
  const vecs = loadVectors();
  const missing = all.filter((m) => m.id && !vecs[m.id]);
  if (!missing.length) return { added: 0 };
  const embs = await embedTexts(missing.map((m) => m.text));
  if (!embs.length) return { added: 0, error: true };
  missing.forEach((m, i) => { if (embs[i]) vecs[m.id] = embs[i]; });
  saveVectors(vecs);
  return { added: missing.length };
}

// 记忆日期（事件时间），用于时间推理
function fmtDate(m) { const t = m.eventDate || m.createdAt || m.deletedAt; return t ? new Date(t + 8 * 3600000).toISOString().slice(0, 16).replace('T', ' ') : ''; }

// 异步版：先 embed query 再注入（语义检索），Ollama 不可用时自动降级为纯 IDF
async function formatForPromptAsync(key, query, opts = {}) {
  try { const e = await embedTexts([String(query || '')]); if (e && e[0]) opts.queryVec = e[0]; } catch { }
  return formatForPrompt(key, query, opts);
}

function formatForPrompt(key, query, opts = {}) {
  const { core, picked, cold, superseded } = retrieve(key, query, 12, opts);
  const s = ensure(key);
  const taboo = s.taboo || [];
  const parts = [];
  if (core.length) parts.push('[核心记忆（永久）]\n' + core.map((m) => '- [' + fmtDate(m) + '] ' + m.text).join('\n'));
  if (taboo.length) parts.push('[回避清单（不要主动提起）]\n' + taboo.map((m) => '- ' + m.text).join('\n'));
  if (picked.length) parts.push('[相关记忆]\n' + picked.map((m) => '- [' + fmtDate(m) + '] ' + m.text).join('\n'));
  if (superseded && superseded.length) parts.push('[已更新的旧记忆]\n' + superseded.slice(0, 3).map((m) => '- ' + m.text + '（已被后来发生的事更新）').join('\n'));
  if (cold.length) parts.push('[记忆深处（很久以前的事，可能不完整）]\n' + cold.map((m) => '- [' + fmtDate(m) + '] ' + m.text).join('\n'));
  return parts.join('\n\n');
}

function stats(key) {
  const s = ensure(key);
  const all = [...s.entity, ...s.event, ...s.concept];
  const w = all.map(weightOf);
  return {
    core: s.core.length, taboo: (s.taboo || []).length, entity: s.entity.length, event: s.event.length, concept: s.concept.length,
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

module.exports = { CONFIG, add, reinforce, prune, retrieve, formatForPrompt, formatForPromptAsync, stats, migrateLegacy, state, save, weightOf, superNodeStats, isBroad, markSuperseded, applyProtection, ensureVectors, embedTexts, loadVectors };
