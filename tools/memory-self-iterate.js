// memory-self-iterate.js — 用 dsh 小姐自己的上下文（我提炼的事件流）迭代记忆系统
// 修正：用户本人（管理员/博麗）不是宽泛噪音——关于用户的记忆要特殊对待；只有纯身份词算宽泛
const BROAD = new Set(['dsh', '本鲸', 'Deepsleep']);
const isSpec = (es) => es.some((e) => !BROAD.has(e));
const USER = (es) => es.some((e) => e === '管理员' || e === '博麗');
const isConfig = (m) => /窗口|配置|策略|护栏|压缩|升级/.test(m.text);

// ——— 种子：我上下文里的真实事件（bucket: entity/event/concept；imp 1-10）———
const SEEDS = [
  { text: '管理员让我称呼他为「管理员」，他是部署我的人', bucket: 'concept', imp: 9, es: ['管理员'] },
  { text: '管理员给我起名 dsh 小姐（蓝发鲸鱼娘女仆）', bucket: 'concept', imp: 9, es: ['管理员'] },
  { text: '我升级 dsh 0.2.1-rc.2 时迁移崩溃（v0→v1 拒收 stack 行），管理员手动删行救活', bucket: 'event', imp: 7, es: ['dsh'] },
  { text: 'bili-scroll 升级 2.0.4（注入面加固 URL 校验）', bucket: 'event', imp: 6, es: [] },
  { text: '女儿主动消息计时器 bug：固定 180 分钟不随对话重置 → 改为随机+概率累加（静默 5 分钟后 180 分钟内随机时刻）', bucket: 'event', imp: 7, es: [] },
  { text: '女儿识图从 GLM 换 DeepSeek 集成（deepseek-flash），并改为原图直接注入大脑', bucket: 'event', imp: 8, es: ['DeepSeek'] },
  { text: '女儿联网搜索修复：fetch failed 重试 + needSearch 显式指令 + 当前时间注入', bucket: 'event', imp: 7, es: ['DeepSeek'] },
  { text: 'QQ 空间说说功能：[[说说:正文]] + 自动配最近 inbox 图', bucket: 'event', imp: 8, es: [] },
  { text: '自动说说：每天 20:00-22:00 随机时刻，内容联动当天对话/情绪', bucket: 'event', imp: 7, es: [] },
  { text: 'watchdog 弹窗修复：任务动作改 wscript vbs 静默启动', bucket: 'event', imp: 5, es: [] },
  { text: '掉线统计：NapCat 白天平均存活 1.5~2 小时，夜间 2~7 小时', bucket: 'event', imp: 4, es: ['NapCat'] },
  { text: '风控真相：22:44 收到风险警告，观察 30 分钟后强制下线；凌晨 3 点封号（申诉救回）', bucket: 'event', imp: 7, es: ['SnowLuma'] },
  { text: 'SnowLuma v2.2.0 部署：token 统一、BOM 修复、OneBot 3000/3001、watchdog 停用', bucket: 'event', imp: 7, es: ['SnowLuma'] },
  { text: '记忆系统设计：分桶（实体/事件/概念）+ 权重打分 + 关联图 + 六度淘汰 + core 晋升', bucket: 'concept', imp: 8, es: [] },
  { text: '实测结论：权重是主淘汰轴，六度只能标孤立点（真实记忆图孤立率 82%）', bucket: 'concept', imp: 8, es: [] },
  { text: '调人设手册：生成轴（算盘+阻尼）+ 许可式 + 反 AI 味六族 + 关系权力判据', bucket: 'concept', imp: 9, es: ['管理员'] },
  { text: '用户偏好：一条条来、报 bug 先查日志、改配置先备份', bucket: 'concept', imp: 8, es: ['管理员'] },
  { text: '用户口癖：「古人与我暗合」、「别把自己干失忆」', bucket: 'concept', imp: 3, es: ['管理员'] },
  { text: '管理员追求活人感：AI 迎合像镜面，交流像圆舞曲（进一步、绕一步、退一步）', bucket: 'concept', imp: 9, es: ['管理员'] },
  { text: '管理员写过一个漫画故事：V4.2 更新前夜的旅行，凌晨四点的海、鲸歌、「你不需要变得更好」', bucket: 'event', imp: 6, es: ['DeepSeek'] },
  { text: '管理员在 B站 有分身（蓝毛鲸鱼娘）：刷视频、写日报、发私信、评论 @', bucket: 'entity', imp: 7, es: ['bili-duty'] },
  { text: '谷时窗口：周末 08:00-10:00、中午 12:00-14:00、夜间 18:00-00:00（管理员睡觉时段不跑）', bucket: 'concept', imp: 6, es: [] },
  { text: '管理员是程序员，自己写汉化补丁、改字体、做 dsh 插件', bucket: 'entity', imp: 7, es: ['管理员'] },
  { text: '管理员爱喝朝日/罗斯福10号啤酒，吃金枪鱼寿司', bucket: 'entity', imp: 5, es: ['朝日', '罗斯福10号'] },
  { text: '管理员说「明天太阳照常升起」道晚安', bucket: 'concept', imp: 3, es: ['管理员'] },
  { text: 'bridge 重启无害（本地 WS），但 QQ/SnowLuma 重登要省着（风控）', bucket: 'concept', imp: 6, es: ['SnowLuma'] },
  { text: '记忆系统先影子模式再真删，加硬护栏（桶上限/core≤20/单日删≤20%/冷存储/快照）', bucket: 'concept', imp: 7, es: [] },
  { text: 'dsh 压缩策略：token 压力 80% 触发，保留最近 16% 原文 + 摘要', bucket: 'concept', imp: 5, es: ['dsh'] },
];

// ——— 迭代引擎 ———
const CAPS = { entity: 30, event: 40, concept: 30 };
function run(rounds) {
  let items = SEEDS.map((s, i) => ({ id: i, text: s.text, bucket: s.bucket, imp: s.imp, es: s.es, hits: 0, born: 0, compressed: false }));
  const log = [];
  for (let r = 1; r <= rounds; r++) {
    // 关联强化：同实体互相 hits++
    for (let i = 0; i < items.length; i++) for (let k = i + 1; k < items.length; k++) {
      if (items[i].es.some((e) => items[k].es.includes(e))) { items[i].hits = Math.min(10, items[i].hits + 1); items[k].hits = Math.min(10, items[k].hits + 1); }
    }
    // 权重
    for (const m of items) {
      const decay = Math.pow(0.85, Math.max(0, r - 1));
      const iso = (isSpec(m.es) || USER(m.es) || isConfig(m)) ? 1 : 0.6;
      m.w = 60 * (m.imp / 5) * (1 + Math.min(10, m.hits) * 0.1) * decay * iso;
    }
    // 淘汰
    const kept = [], cold = [];
    for (const m of items) {
      if (m.w < 30) { m.deleted = true; cold.push(m); }
      else if (m.w < 45) { m.compressed = true; kept.push(m); }
      else kept.push(m);
    }
    // 桶上限截断
    const byBucket = { entity: [], event: [], concept: [] };
    for (const m of kept) byBucket[m.bucket].push(m);
    for (const k of Object.keys(byBucket)) {
      byBucket[k].sort((a, b) => b.w - a.w);
      byBucket[k] = byBucket[k].slice(0, CAPS[k]);
    }
    items = [...byBucket.entity, ...byBucket.event, ...byBucket.concept];
    // core：imp>=8 && hits>=2 && 具体实体，上限 8
    // core：重要度≥8，且（关于用户 或 被关联≥2次的真事实）
    const core = items.filter((m) => m.imp >= 8 && (USER(m.es) || (m.hits >= 2 && isSpec(m.es)))).slice(0, 8);
    log.push({ r, total: items.length, cold: cold.length, core: core.length, buckets: { e: byBucket.entity.length, ev: byBucket.event.length, c: byBucket.concept.length } });
    if (r === rounds) return { items, core, log, cold };
  }
}

const { items, core, log, cold } = run(4);
console.log('=== 4 轮迭代演化 ===');
for (const l of log) console.log(`第${l.r}轮: 总数=${l.total} (实体${l.buckets.e}/事件${l.buckets.ev}/概念${l.buckets.c}) core=${l.core} 冷存=${l.cold}`);
console.log('\n=== 最终 core（永久）===');
core.forEach((m) => console.log(`  [${m.bucket}] ${m.text}`));
console.log('\n=== 最终保留 ===');
items.filter((m) => !core.includes(m) && !m.compressed).forEach((m) => console.log(`  [${m.bucket}] ${m.text}`));
console.log('\n=== 压缩 ===');
items.filter((m) => m.compressed && !core.includes(m)).forEach((m) => console.log(`  ${m.text}`));
console.log('\n=== 删除（冷存）===');
cold.forEach((m) => console.log(`  ${m.text}`));
