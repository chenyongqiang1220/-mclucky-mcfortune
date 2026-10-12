'use strict';

/**
 * 麦门今日运势 —— 签文引擎 + 心情选品策略
 *
 * 设计原则：
 *   1. 确定性：seed 只由「日期 + 心情」决定，同一天同一心情必得同一支签。
 *   2. 不装神弄鬼：签文走麦门黑话，短句，说人话，不写 AI 味的排比。
 *   3. 选品真算：把门店菜单全量枚举 (主食 × 小食/饮品) 组合，
 *      在预算内按心情亲和度 + 价格贴合度打分取最优，不是随机抓两个。
 */

/* ------------------------------------------------------------------ */
/* 1. 确定性随机                                                        */
/* ------------------------------------------------------------------ */

function hashSeed(str) {
  // FNV-1a 32bit
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mulberry32(a) {
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------------ */
/* 2. 心情定义与选品策略                                                */
/* ------------------------------------------------------------------ */

const MOODS = {
  energetic: {
    key: 'energetic',
    label: '元气满满',
    emoji: '⚡',
    hint: '状态在线，吃得丰盛点不过分',
    // 目标花费占预算的比例
    targetRatio: 0.85,
    // 主食品类权重
    mainWeight: 0.68,
    // 命中这些关键词加分
    prefer: ['套餐', '经典精选', '爆款', '人气', '三件套', '四件套', '随心配'],
    freshBoost: 3,
    comboNote: '吃饱了才有力气继续发光',
  },
  tired: {
    key: 'tired',
    label: '疲惫打工',
    emoji: '😮‍💨',
    hint: '电量告急，来点高热量安慰',
    targetRatio: 0.8,
    mainWeight: 0.62,
    prefer: ['堡', '薯条', '炸鸡', '咖啡', '鲜萃', '麦旋风', '鸡翅', '拉丝'],
    freshBoost: 2,
    comboNote: '打工人的骨头是薯条做的，脆但易折',
  },
  emo: {
    key: 'emo',
    label: '深夜emo',
    emoji: '🌙',
    hint: '想被甜食温柔地抱一下',
    targetRatio: 0.6,
    mainWeight: 0.5,
    prefer: ['麦旋风', '新地', '圆筒', '冰淇淋', '派', '热饮', '锡兰红茶', '牛奶', '巧克力', '黑巧'],
    freshBoost: 1,
    comboNote: '情绪有保质期，过期的就丢掉',
  },
  date: {
    key: 'date',
    label: '约会',
    emoji: '💞',
    hint: '两个人吃，快乐要翻倍',
    targetRatio: 0.92,
    mainWeight: 0.72,
    prefer: ['分享餐', '双人餐', '多人餐', '拼盘', '小食盘', '亲子餐', '四宫格'],
    freshBoost: 4,
    comboNote: '两个人吃同一份，热量减半，快乐翻倍',
  },
  celebrate: {
    key: 'celebrate',
    label: '庆祝',
    emoji: '🎉',
    hint: '今天值得犒劳自己',
    targetRatio: 0.97,
    mainWeight: 0.75,
    prefer: ['安格斯', '厚牛堡', '四件套', 'MAX', '双人餐', '拼盘', '八件套'],
    freshBoost: 5,
    comboNote: '好事发生，得用热量记录下来',
  },
  whatever: {
    key: 'whatever',
    label: '随便',
    emoji: '🎲',
    hint: '把选择权交给命运',
    targetRatio: 0.75,
    mainWeight: 0.65,
    prefer: ['上新', '新品', '限定', '回归'],
    freshBoost: 30,
    comboNote: '命运说：试试新的，踩雷也才十几块',
  },
};

const MOOD_KEYS = Object.keys(MOODS);

/* ------------------------------------------------------------------ */
/* 3. 签文语料                                                          */
/* ------------------------------------------------------------------ */

const LEVELS = [
  { key: 'great', label: '大吉', weight: 18, color: '#DA291C' },
  { key: 'mid', label: '中吉', weight: 30, color: '#E8703A' },
  { key: 'small', label: '小吉', weight: 32, color: '#F2A100' },
  { key: 'luck', label: '吉', weight: 20, color: '#1F9D55' },
];

const FORTUNE_LINES = {
  energetic: [
    '今天你就是行走的充电宝，麦门负责续航。',
    '气场两米八，连薯条都比别人的脆。',
    '好运正在派送中，请保持手机畅通、嘴巴张开。',
    '今天的你，配得上一个双层吉士。',
    '状态好到连番茄酱都愿意多给你两包。',
    '宜主动出击，忌假装谦虚，忌只点一份。',
    '阳光、咖啡、刚出锅的薯条——三件套齐了。',
    '你今天的价值，比招牌汉堡的层数还高。',
  ],
  tired: [
    '电量 12%，建议立即插入麦门充电器。',
    '打工人的骨头是薯条做的，脆，但易折。',
    '今天允许摆烂，但要摆得有滋有味。',
    '老板画的饼，不如板烧来得实在。',
    '你已经很努力了，配得上一份大薯。',
    '先吃饱，再谈理想，顺序不能反。',
    '累了就去摸鱼，摸鱼的时候顺便点个外卖。',
    '世界可以等，你的午饭不能等。',
  ],
  emo: [
    '情绪有保质期，过期的就丢掉。',
    '深夜不适合思考人生，适合思考吃几个麦旋风。',
    '难过的话先吃一口，剩下的明天再说。',
    '麦门不打烊，你的情绪也是。',
    '没什么是一根圆筒解决不了的，有的话就两根。',
    '把心事泡进热牛奶里，会比较容易咽下去。',
    '今天不适合做大决定，适合做小甜品。',
    '天亮之前，先对自己好一点。',
  ],
  date: [
    '今天适合分享，尤其是薯条的最后一根。',
    '两个人吃同一份，热量减半，快乐翻倍。',
    '把最好的那块鸡块留给对方，这招百试百灵。',
    '气氛组已就位，剩下的交给你。',
    '话题可以冷场，薯条不能凉。',
    '别点太复杂的，弄脏手就没法牵了。',
    '甜品要双份，尴尬才会减半。',
    '今天宜说真话，忌算热量。',
  ],
  celebrate: [
    '今天值得一个安格斯，别跟自己客气。',
    '恭喜解锁成就：理直气壮地犒劳自己。',
    '好事发生，得用热量记录下来。',
    '庆祝这种事，一顿不够就两顿，今天先一顿。',
    '把预算花光，是对今天最基本的尊重。',
    '别人举杯，你举汉堡，一样隆重。',
    '运气攒了这么久，该兑现了。',
    '今天没有忌口，只有加餐。',
  ],
  whatever: [
    '随便不是没主见，是把选择权交给命运。',
    '命运说：试试新的，反正踩雷也才十几块。',
    '今天适合抽卡，新品就是你的限定池。',
    '别问，问就是上新。',
    '你负责张嘴，麦门负责安排。',
    '选择困难症的解药，是闭眼点第一个。',
    '反正都好吃，纠结才是唯一的浪费。',
    '随缘下单，惊喜自会送货上门。',
  ],
};

const YI_LINES = [
  '宜加一份大薯',
  '宜把饮料换成大杯',
  '宜相信第一直觉',
  '宜对同事多笑一次',
  '宜主动请客',
  '宜给自己买个圆筒',
  '宜拒绝那个无效会议',
  '宜把手机调成勿扰',
  '宜承认自己今天很棒',
  '宜续杯',
  '宜坐靠窗的位置',
  '宜把签图发到朋友圈',
  '宜慢一点吃',
  '宜重启一下电脑',
  '宜提前十分钟收工',
  '宜把薯条蘸冰淇淋',
  '宜多要两包番茄酱',
  '宜说一句「我请」',
  '宜换一条回家的路',
  '宜把今天的好事记下来',
];

const JI_LINES = [
  '忌空腹开会',
  '忌跟自动贩卖机较劲',
  '忌说「随便」还嫌弃',
  '忌把最后一根薯条让出去',
  '忌深夜做重大决定',
  '忌重复昨天说错的话',
  '忌把咖啡当水喝',
  '忌和减肥 App 对视',
  '忌为省三块钱多走两公里',
  '忌在麦门前犹豫超过十秒',
  '忌把情绪写成长文发出去',
  '忌连续第三次说「下次一定」',
  '忌边走边吃还看手机',
  '忌把番茄酱挤得到处都是',
  '忌一个人吃双人餐还觉得亏',
  '忌自称打工人却点最便宜的',
  '忌翻前任的朋友圈',
  '忌把签文当真',
  '忌冷掉之后再吃',
  '忌在最后一分钟才下单',
];

/* ------------------------------------------------------------------ */
/* 4. 抽签                                                              */
/* ------------------------------------------------------------------ */

function pickLevel(rand) {
  const total = LEVELS.reduce((s, l) => s + l.weight, 0);
  let r = rand() * total;
  for (const lv of LEVELS) {
    if (r < lv.weight) return lv;
    r -= lv.weight;
  }
  return LEVELS[LEVELS.length - 1];
}

/**
 * 抽签：同一 (date, mood) 永远得到同一支签
 * @param {string} date  yyyy-MM-dd
 * @param {string} mood  MOODS 的 key
 */
function drawFortune(date, mood) {
  const key = MOODS[mood] ? mood : 'whatever';
  const rand = mulberry32(hashSeed(`${date}|${key}`));

  const level = pickLevel(rand);
  const lines = FORTUNE_LINES[key] || FORTUNE_LINES.whatever;
  const line = lines[Math.floor(rand() * lines.length) % lines.length];
  const yi = YI_LINES[Math.floor(rand() * YI_LINES.length) % YI_LINES.length];
  let ji = JI_LINES[Math.floor(rand() * JI_LINES.length) % JI_LINES.length];
  // 别让宜忌撞车
  if (ji === yi) ji = JI_LINES[(JI_LINES.indexOf(ji) + 7) % JI_LINES.length];

  return {
    level: level.label,
    levelKey: level.key,
    levelColor: level.color,
    line,
    yi,
    ji,
    mood: key,
    moodLabel: MOODS[key].label,
    moodEmoji: MOODS[key].emoji,
    comboNote: MOODS[key].comboNote,
    date,
  };
}

/* ------------------------------------------------------------------ */
/* 5. 菜单分类                                                          */
/* ------------------------------------------------------------------ */

const MAIN_CATS = ['鸡肉汉堡', '巨无霸', '安格斯', '精选单人餐', '大堡口福', '500', '随心配', '开心乐园'];
const SIDE_CATS = ['小食甜品', '蘸酱炸鸡', '小食拼盘', '炸鸡'];
const DRINK_CATS = ['饮品', '麦咖啡'];

const MAIN_HINT = /(汉堡|堡|牛堡|鱼堡|鸡腿堡|卷|三件套|四件套|套餐|分享餐|双人餐|多人餐|亲子餐|八件套|十翅)/;
const SIDE_HINT =
  /(薯条|薯饼|薯格|扭扭薯|鸡块|鸡翅|鸡排|麦乐鸡|玉米杯|苹果片|麦旋风|新地|圆筒|冰淇淋|派|芝士条|小食|脆汁鸡)/;
const NON_FOOD = /(帽子|棒球帽|周边|公仔|玩具|盲盒|帆布袋|徽章|贴纸|水杯|保温杯)/;

/**
 * 把麦当劳菜单条目归类为 main / side / drink，非食物返回 null
 */
function classifyMeal(name = '', category = '', tags = [], price = 0) {
  if (NON_FOOD.test(name)) return null;
  // 单卖的蘸酱不算一道菜
  if (/酱$/.test(name.trim()) && price <= 6) return null;
  if (price <= 0) return null;

  if (DRINK_CATS.some((c) => category.includes(c))) return 'drink';
  if (/(分享餐|双人餐|多人餐|亲子餐|八件套|十翅|拼盘|小食盘)/.test(name)) return 'main';
  if (MAIN_HINT.test(name) && price >= 15) return 'main';
  if (MAIN_CATS.some((c) => category.includes(c))) return 'main';
  if (SIDE_HINT.test(name)) return 'side';
  if (SIDE_CATS.some((c) => category.includes(c))) return 'side';
  return null;
}

/**
 * 把 query-meals 的原始返回摊平成带 kind 的候选池
 * @returns {{ items: Array, warnings: string[] }}
 */
function buildCandidates(mealsPayload) {
  const warnings = [];
  const categories = (mealsPayload && mealsPayload.categories) || [];
  const mealMap = (mealsPayload && mealsPayload.meals) || {};
  const items = [];
  const seen = new Set();

  for (const cat of categories) {
    const catName = String((cat && cat.name) || '').replace(/\s+/g, '');
    for (const ref of (cat && cat.meals) || []) {
      const code = String((ref && ref.code) || '');
      if (!code) continue;
      const detail = mealMap[code];
      if (!detail || !detail.name) continue;

      const currentPrice = Number(detail.currentPrice);
      const originalPrice = Number(detail.originalPrice) || currentPrice;
      if (!Number.isFinite(currentPrice) || currentPrice <= 0) continue;

      // 关键坑：菜单里的 currentPrice 有可能是「麦金卡 / 早餐卡专享价」。
      // 我们这次不会随单购卡，calculate-price 会按原价收钱，
      // 所以这类商品的有效价格要用划线价，否则选出来的组合会超预算。
      const discountType = String(detail.discountType || '');
      const cardRequired = /麦金卡|早餐卡/.test(discountType);
      const effPrice = cardRequired ? Math.max(currentPrice, originalPrice) : currentPrice;

      const tags = (ref && ref.tags) || [];
      const kind = classifyMeal(detail.name, catName, tags, effPrice);
      if (!kind) continue;

      if (seen.has(code)) continue;
      seen.add(code);

      items.push({
        code,
        name: detail.name,
        image: detail.image || '',
        price: effPrice,
        menuPrice: currentPrice,
        listPrice: Math.max(originalPrice, effPrice),
        cardRequired,
        discountType,
        tags,
        category: catName,
        kind,
      });
    }
  }

  if (!items.length) warnings.push('菜单解析为空，可能是该门店暂不提供线上菜单');
  return { items, warnings };
}

/* ------------------------------------------------------------------ */
/* 6. 组合打分                                                          */
/* ------------------------------------------------------------------ */

function keywordHits(item, prefer) {
  const haystack = `${item.name} ${item.category} ${(item.tags || []).join(' ')}`;
  let hit = 0;
  for (const kw of prefer) if (haystack.includes(kw)) hit++;
  return hit;
}

function scoreItem(item, strategy, target) {
  let score = 0;
  score += keywordHits(item, strategy.prefer) * 12;
  if ((item.tags || []).includes('上新')) score += strategy.freshBoost;
  if ((item.tags || []).includes('爆款')) score += 5;
  // 已经在打折的，等于白捡的便宜
  if (item.listPrice > item.price + 0.01) score += Math.min(10, (item.listPrice - item.price) * 0.8);
  // 需要随单购卡才能拿到的价，性价比打个折
  if (item.cardRequired) score -= 8;
  // 价格贴合目标价
  score -= Math.abs(item.price - target) * 2.2;
  return score;
}

/**
 * 在预算内枚举 (主食 × 小食/饮品)，按心情策略取最优组合
 */
function pickCombo(items, moodKey, budget) {
  const strategy = MOODS[moodKey] || MOODS.whatever;
  const mains = items.filter((i) => i.kind === 'main');
  const extras = items.filter((i) => i.kind === 'side' || i.kind === 'drink');

  if (!mains.length || !extras.length) {
    return { combo: null, reason: !mains.length ? '菜单里没有识别到主食' : '菜单里没有识别到小食或饮品' };
  }

  const target = budget * strategy.targetRatio;
  const mainTarget = target * strategy.mainWeight;
  const extraTarget = target * (1 - strategy.mainWeight);

  const mainScored = mains
    .filter((i) => i.price <= budget)
    .map((i) => ({ item: i, score: scoreItem(i, strategy, mainTarget) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 24);

  const extraScored = extras
    .map((i) => ({ item: i, score: scoreItem(i, strategy, extraTarget) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 24);

  const ranked = [];
  for (const m of mainScored) {
    for (const e of extraScored) {
      const total = m.item.price + e.item.price;
      if (total > budget + 0.001) continue;
      // 越贴近目标花费越好
      const fit = -Math.abs(total - target) * 1.4;
      ranked.push({ main: m.item, extra: e.item, total, totalScore: m.score + e.score + fit });
    }
  }

  if (!ranked.length) {
    // 预算实在太紧：退而求其次，只给一个主食
    const cheapest = mains.slice().sort((a, b) => a.price - b.price)[0];
    if (!cheapest) return { combo: null, alternates: [], reason: '预算内没有可搭配的组合' };
    return {
      combo: { main: cheapest, extra: null, total: cheapest.price },
      alternates: [],
      reason: `预算 ${budget} 元内配不出「主食 + 小食」，先保住主食`,
    };
  }

  ranked.sort((a, b) => b.totalScore - a.totalScore);
  // 留下备选：菜单价与计价接口偶有出入，超预算时可以顺位换一个
  const alternates = dedupeCombos(ranked.slice(1), 4);
  return { combo: ranked[0], alternates };
}

function dedupeCombos(list, limit) {
  const seen = new Set();
  const out = [];
  for (const c of list) {
    const key = `${c.main.code}|${c.extra ? c.extra.code : ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
    if (out.length >= limit) break;
  }
  return out;
}

module.exports = {
  MOODS,
  MOOD_KEYS,
  LEVELS,
  drawFortune,
  buildCandidates,
  pickCombo,
  classifyMeal,
  hashSeed,
};
