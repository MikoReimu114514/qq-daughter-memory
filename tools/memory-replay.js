// memory-replay.js v2 — 90 天演化模拟（调参版）
// 改动：① core 晋升收紧（重要度≥8 + 被关联 hits≥2，上限 12）② 孤立记忆软淘汰（额外衰减，进冷存储候选）
const fs = require('fs');

const hist = JSON.parse(fs.readFileSync('C:/Users/Lenovo/Documents/DSH/qq-bot/bridge/storage/history.json', 'utf8'));
const raw = (hist['u1528848072'] || []).concat(hist['g1103329170'] || []);
const seeds = [];
for (let i = 0; i < raw.length; i += 2) {
  const u = raw[i] || {}, a = raw[i + 1] || {};
  seeds.push((String(u.content || '') + ' / ' + String(a.content || '')).slice(0, 160));
}
console.log(`原料：${seeds.length} 个对话单元`);

const KEY_ENTITY = ['管理员', '博麗', '朝日', '罗斯福', '寿司', 'DeepSeek', 'Kimi', '电动车', '超市', '世界杯', 'dsh', '本鲸', 'Deepsleep'];
const KEY_CONCEPT = ['约定', '规则', '构想', '记忆', '像真人', '策略', '计划'];
const KEY_GREET = ['活着', '在吗', '早安', '晚安', '睡', '醒了'];
function distill(text) {
  let bucket = 'event', imp = 4;
  if (KEY_ENTITY.some((k) => text.includes(k))) { bucket = 'entity'; imp += 3; }
  if (KEY_CONCEPT.some((k) => text.includes(k))) { bucket = 'concept'; imp += 3; }
  if (KEY_GREET.some((k) => text.includes(k))) imp -= 2;
  if (text.length < 15) imp -= 1;
  imp = Math.max(1, Math.min(10, imp));
  return { bucket, importance: imp, entities: KEY_ENTITY.filter((k) => text.includes(k)), links: [], hits: 0 };
}

const CAPS = { entity: 50, event: 80, concept: 60 };
const MAX_CORE = 12;
const state = { entity: [], event: [], concept: [], core: [], cold: [] };
let day = 0;
const stats = [];

const BROAD = new Set(['管理员', '博麗', '本鲸', 'DeepSeek', 'dsh']); // 宽泛实体（几乎每条都有），不算'具体关联'
function isSpecific(m) { return (m.entities || []).some((e) => !BROAD.has(e)); }
function decayAge(m) { return Math.pow(0.85, Math.floor((day - m.bornDay) / 7)); }
function weightOf(m) {
  const iso = !isSpecific(m);
  const isoPenalty = iso ? 0.6 : 1; // 孤立记忆额外衰减（软淘汰）
  const hits = Math.min(10, m.hits || 0); // hits 封顶 10：防止权重无限膨胀
  return 60 * (m.importance / 5) * (1 + hits * 0.1) * (1 + (m.links || []).length * 0.15) * decayAge(m) * isoPenalty;
}

function stepDay() {
  day++;
  for (let i = 0; i < 15; i++) {
    const seed = seeds[(day * 15 + i) % seeds.length];
    const meta = distill(seed);
    meta.text = seed; meta.bornDay = day;
    // 关联强化：与已有记忆共享实体 ⇒ 旧记忆 hits++（模拟"被提及/被引用"）
    const all = [...state.entity, ...state.event, ...state.concept];
    for (const old of all) {
      if (meta.entities.some((e) => (old.entities || []).includes(e))) old.hits = Math.min(10, (old.hits || 0) + 1);
    }
    state[meta.bucket].push(meta);
  }
  // 淘汰：单日删除限额 20%
  const all = [...state.entity, ...state.event, ...state.concept];
  const capDel = Math.ceil(all.length * 0.2);
  let del = 0, comp = 0;
  const next = { entity: [], event: [], concept: [] };
  for (const k of Object.keys(next)) {
    for (const m of state[k]) {
      const w = weightOf(m);
      const iso = !isSpecific(m);
      if (iso && w < 45) { state.cold.push(m); del++; continue; }      // 孤立 → 冷存储
      if (w < 30 && del < capDel) { del++; state.cold.push(m); continue; }
      if (w < 50) { comp++; }
      next[k].push(m);
    }
  }
  for (const k of Object.keys(next)) {
    if (next[k].length > CAPS[k]) {
      next[k].sort((x, y) => weightOf(y) - weightOf(x));
      next[k] = next[k].slice(0, CAPS[k]);
    }
  }
  state.entity = next.entity; state.event = next.event; state.concept = next.concept;
  // core 收紧：重要度≥8 且 hits≥2，上限 12
  const all2 = [...state.entity, ...state.event, ...state.concept];
  state.core = all2.filter((m) => m.importance >= 8 && (m.hits || 0) >= 2 && isSpecific(m)).slice(0, MAX_CORE);
  const w = all2.map(weightOf);
  stats.push({
    day, total: all2.length, e: state.entity.length, ev: state.event.length, c: state.concept.length,
    core: state.core.length, del, comp, cold: state.cold.length,
    avgW: w.reduce((a, b) => a + b, 0) / (w.length || 1),
    iso: all2.filter((m) => !isSpecific(m)).length
  });
}

for (let i = 0; i < 90; i++) stepDay();

console.log('\n=== 90 天演化（每 7 天采样）===');
console.log('天   总数  实体  事件  概念  core  删除  压缩  冷存  均重  孤立');
for (const s of stats) {
  if (s.day % 7 === 0 || s.day === 1) {
    console.log(String(s.day).padEnd(4) + String(s.total).padEnd(5) + String(s.e).padEnd(5) + String(s.ev).padEnd(5) + String(s.c).padEnd(5) + String(s.core).padEnd(5) + String(s.del).padEnd(5) + String(s.comp).padEnd(5) + String(s.cold).padEnd(5) + s.avgW.toFixed(0).padEnd(5) + s.iso);
  }
}
const last = stats[stats.length - 1];
console.log('\n=== 90 天终态 ===');
console.log(`总数=${last.total} 实体=${last.e} 事件=${last.ev} 概念=${last.c} core=${last.core} 冷存=${last.cold} 均重=${last.avgW.toFixed(1)} 孤立=${last.iso}`);
const issues = [];
if (last.total > 200) issues.push('总量失控');
if (last.e > CAPS.entity || last.ev > CAPS.event || last.c > CAPS.concept) issues.push('桶溢出');
if (last.core > MAX_CORE) issues.push('core 溢出');
if (last.avgW < 40) issues.push('权重塌缩');
if (last.cold > 300) issues.push('冷存储过载');
console.log('失衡判断:', issues.length ? '⚠️ ' + issues.join('；') : '✅ 90 天未发现失衡');
