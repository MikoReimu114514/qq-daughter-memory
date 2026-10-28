// benchmark-cost.js — 成本基准：注入 token、检索/剪枝延迟、condenser 调用估算、与全量注入对比
const fs = require('fs');
const v2 = require('C:/Users/Lenovo/Documents/DSH/qq-bot/bridge/lib/memory-v2.js');

const KEY = 'cost-' + Date.now();
const SRC = 'C:/Users/Lenovo/Documents/DSH/qq-bot/bridge/storage/memory-v2.json';
const prod = JSON.parse(fs.readFileSync(SRC, 'utf8'))['u1528848072'];
v2.state()[KEY] = JSON.parse(JSON.stringify(prod));

function toTokens(chars) { return Math.round(chars / 1.6); } // 中文粗估 1 token ≈ 1.6 字符

// 1) 注入成本
const sampleQueries = ['管理员爱喝什么啤酒', '我的中文名是什么', '大肥鱼是什么梗', '记忆系统版本'];
let engineChars = 0;
for (const q of sampleQueries) engineChars += v2.formatForPrompt(KEY, q).length;
engineChars = Math.round(engineChars / sampleQueries.length);
const fullChars = v2.formatForPrompt(KEY, '管理员爱喝什么啤酒', { recall: true }).length;
const allMemText = [...(v2.state()[KEY].core || []), ...(v2.state()[KEY].entity || []), ...(v2.state()[KEY].event || []), ...(v2.state()[KEY].concept || [])].map((m) => m.text).join('\n');

// 2) 检索延迟
const N = 200;
const t0 = process.hrtime.bigint();
for (let i = 0; i < N; i++) v2.retrieve(KEY, sampleQueries[i % sampleQueries.length], 12);
const retrieveMs = Number(process.hrtime.bigint() - t0) / 1e6 / N;

// 3) prune 延迟
const P = 10;
const t1 = process.hrtime.bigint();
for (let i = 0; i < P; i++) v2.prune(KEY);
const pruneMs = Number(process.hrtime.bigint() - t1) / 1e6 / P;

// 4) condenser 成本估算（两阶段：骨架 1 次 + 细化按 event 数）
// 假设一次 condenser 处理 80 条消息（~8000 token 输入），输出 20 条（~1500 token）；细化每 5 个 event 一批
const condenseCalls = 2; // 骨架 1 + 细化 1（批内）
const condenseInTokens = 8000;
const condenseOutTokens = 1500;
// 每天 8 次 condenser（安静 30 分钟触发）
const DAILY_CONDENSE = 8;
const dailyCondenseIn = condenseInTokens * condenseCalls * DAILY_CONDENSE;
const dailyCondenseOut = condenseOutTokens * condenseCalls * DAILY_CONDENSE;

// 5) 对话注入成本对比
// 假设每天 50 轮对话，每轮注入一次
const DAILY_TURNS = 50;
const engineDailyTokens = toTokens(engineChars) * DAILY_TURNS;
const fullDailyTokens = toTokens(allMemText.length) * DAILY_TURNS;

// DeepSeek 价格（2026 参考）：输入 ~1 元/百万 token，输出 ~2 元/百万 token
const inPrice = 1, outPrice = 2;
const dailyCost = ((dailyCondenseIn + engineDailyTokens) * inPrice + dailyCondenseOut * outPrice) / 1e6;

console.log('=== 成本基准 ===');
console.log('1) 注入: 引擎 ' + engineChars + ' 字符 (~' + toTokens(engineChars) + ' tokens) vs 全量 ' + allMemText.length + ' 字符 (~' + toTokens(allMemText.length) + ' tokens)');
console.log('   节省: ' + (100 - Math.round(toTokens(engineChars) / toTokens(allMemText.length) * 100)) + '%');
console.log('2) 检索延迟: ' + retrieveMs.toFixed(2) + ' ms/次（' + N + '次平均）');
console.log('3) prune 延迟: ' + pruneMs.toFixed(2) + ' ms/次（' + P + '次平均）');
console.log('4) condenser: 每天 ' + DAILY_CONDENSE + ' 次 × ' + condenseCalls + ' 调用 ≈ 输入 ' + dailyCondenseIn + ' + 输出 ' + dailyCondenseOut + ' tokens/天');
console.log('5) 对话注入: 每天 ' + DAILY_TURNS + ' 轮 × ' + toTokens(engineChars) + ' tokens = ' + engineDailyTokens + ' tokens/天（全量注入会是 ' + fullDailyTokens + '）');
console.log('6) 估算日成本: 约 ' + dailyCost.toFixed(3) + ' 元/天（DeepSeek 输入1元/M、输出2元/M）');

const lines = ['成本基准（2026-10-28）', ''];
lines.push('1) 注入: 引擎 ~' + toTokens(engineChars) + ' tokens/次 vs 全量 ~' + toTokens(allMemText.length) + ' tokens/次（节省 ' + (100 - Math.round(toTokens(engineChars) / toTokens(allMemText.length) * 100)) + '%）');
lines.push('2) 检索延迟: ' + retrieveMs.toFixed(2) + ' ms/次');
lines.push('3) prune 延迟: ' + pruneMs.toFixed(2) + ' ms/次');
lines.push('4) condenser: 每天 ' + DAILY_CONDENSE + ' 次 × ' + condenseCalls + ' 调用 ≈ ' + dailyCondenseIn + ' 输入 + ' + dailyCondenseOut + ' 输出 tokens/天');
lines.push('5) 对话注入: ' + engineDailyTokens + ' tokens/天（全量 ' + fullDailyTokens + '）');
lines.push('6) 估算日成本: 约 ' + dailyCost.toFixed(3) + ' 元/天');
lines.push('');
lines.push('说明：token 按中文 1 token≈1.6 字符粗估；价格按 DeepSeek 参考价；实际成本以 API 账单为准。');
fs.writeFileSync('C:/Users/Lenovo/Desktop/成本基准_2026-10-28.txt', '\ufeff' + lines.join('\r\n'), 'utf8');
console.log('\n已写入桌面: 成本基准_2026-10-28.txt');
delete v2.state()[KEY];
v2.save();
process.exit(0);
