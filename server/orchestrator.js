'use strict';

/**
 * /api/luck 的 MCP 编排层
 *
 * 调用链（任一步失败都不阻塞，只往 warnings 里记一笔）：
 *   ├ now-time-info         拿服务器日期（保证「同一天」口径一致）
 *   ├ query-nearby-stores   最近的门店
 *   ├ ┬ query-meals         该门店完整菜单
 *   │ ├ query-store-coupons 该门店可用券
 *   │ ├ query-my-coupons    我账户里的券
 *   │ └ available-coupons   麦麦省还能领什么券
 *   └ calculate-price       券后真实价格
 *
 * 并行说明：拿到 storeCode 之后，菜单 / 门店券 / 我的券 / 可领券 互不依赖，
 * 一起发，能把整条链路压到 3 秒出头。
 */

const { McpClient, safeCall } = require('./mcp-client');
const { reverseGeocode } = require('./geo');
const { TtlCache } = require('./cache');
const { MOODS, drawFortune, buildCandidates, pickCombo } = require('./luck');

const BE_TYPE_PICKUP = 1; // 到店自提
const ORDER_TYPE_PICKUP = 1;

// 各数据的合理新鲜度：菜单/门店 10 分钟，券 3 分钟，服务器时间 30 秒
const TTL = {
  TIME: 30 * 1000,
  STORE: 10 * 60 * 1000,
  MENU: 10 * 60 * 1000,
  COUPON: 3 * 60 * 1000,
};

const cache = new TtlCache({ max: 300 });

/* ------------------------------------------------------------------ */
/* 券的归一化：三个来源字段命名各不相同                                  */
/* ------------------------------------------------------------------ */

function normalizeCoupon(c, source) {
  if (!c || typeof c !== 'object') return null;
  const title = c.title || c.couponName || c.name || '';
  if (!title) return null;
  const image = c.image || c.couponImage || c.img || '';
  const status = c.status || c.label || (c.couponStatus ? (c.couponStatus === 'CAN_GET' ? '可领取' : c.couponStatus) : '');
  return {
    couponId: c.couponId ? String(c.couponId) : '',
    couponCode: c.couponCode ? String(c.couponCode) : '',
    title: String(title),
    image: String(image),
    status: String(status || ''),
    tradeDateTime: c.tradeDateTime || c.expireTime || c.validity || '',
    products: Array.isArray(c.products) ? c.products : [],
    source,
  };
}

/** available-coupons 偶尔只回 markdown，兜底抠一下 */
function parseCouponMarkdown(text) {
  if (!text) return [];
  const out = [];
  const re = /优惠券标题[:：]\s*([^\n\\]+)[\s\S]*?(?:状态[:：]\s*([^\n\\]+))?(?:[\s\S]*?src="([^"]+)")?/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const title = (m[1] || '').trim();
    if (!title) continue;
    out.push({ title, image: m[3] || '', status: (m[2] || '').trim(), source: 'available-coupons(markdown)' });
  }
  return out;
}

function collectCoupons(res, source) {
  if (!res.ok) return { list: [], error: res.error };
  let raw = res.data;
  if (raw && !Array.isArray(raw) && Array.isArray(raw.coupons)) raw = raw.coupons;
  if (raw && !Array.isArray(raw) && Array.isArray(raw.list)) raw = raw.list;

  let list = [];
  if (Array.isArray(raw)) {
    list = raw.map((c) => normalizeCoupon(c, source)).filter(Boolean);
  }
  if (!list.length) list = parseCouponMarkdown(res.text || '').map((c) => ({ ...c, source }));
  return { list, error: null };
}

function couponCovers(coupon, productCode) {
  const list = coupon.products || [];
  if (!list.length) return true; // 没标适用范围 → 通吃
  return list.some((p) => String((p && (p.productCode || p.code)) || '') === String(productCode));
}

/** 给组合挂上用得上的券（每件商品最多一张，同一张券不重复用） */
function attachCoupons(combo, coupons) {
  const used = [];
  const taken = new Set();

  const bind = (item) => {
    if (!item) return;
    for (const c of coupons) {
      if (!c.couponId || taken.has(c.couponId)) continue;
      if (!couponCovers(c, item.code)) continue;
      item.couponId = c.couponId;
      item.couponCode = c.couponCode;
      used.push({
        couponId: c.couponId,
        couponCode: c.couponCode,
        title: c.title,
        status: c.status,
        tradeDateTime: c.tradeDateTime,
        appliedTo: item.name,
        source: c.source,
      });
      taken.add(c.couponId);
      return;
    }
  };

  bind(combo.main);
  bind(combo.extra);
  return used;
}

/* ------------------------------------------------------------------ */

async function buildLuck(input, clientOptions) {
  const warnings = [];
  const trace = [];
  const t0 = Date.now();

  const mood = MOODS[input.mood] ? input.mood : 'whatever';
  const budget = Number(input.budget) || 40;
  const client = new McpClient(clientOptions);
  const mark = (tool, ok, ms, note) => trace.push({ tool, ok, ms, note: note || '' });

  // ---- 0. 建链 ------------------------------------------------------
  try {
    await client.initialize();
  } catch (e) {
    warnings.push(`MCP 握手未成功，继续尝试调用：${e.message}`);
  }

  // ---- 1. 服务器时间 + 定位反查（并行） -------------------------------
  let date = new Date().toISOString().slice(0, 10);
  let serverTime = null;
  let city = String(input.city || '').trim();
  let keyword = String(input.keyword || '').trim();
  let locationNote = '';

  const jobs = [
    (async () => {
      const started = Date.now();
      const { value: r, hit } = await cache.wrap('now-time-info', TTL.TIME, () => safeCall(client, 'now-time-info', {}));
      mark('now-time-info', r.ok, Date.now() - started, r.ok ? (hit ? 'cache' : '') : r.error);
      if (r.ok && r.data && r.data.date) {
        date = r.data.date;
        serverTime = r.data.formatted || r.data.datetime;
      } else {
        warnings.push('拿不到服务器时间，改用本机日期：' + (r.error || '未知原因'));
      }
    })(),
  ];

  if ((!city || !keyword) && Number.isFinite(input.lat) && Number.isFinite(input.lng)) {
    jobs.push(
      (async () => {
        try {
          const g = await reverseGeocode(input.lat, input.lng);
          city = city || g.city;
          keyword = keyword || g.keyword;
          locationNote = `由经纬度反查得到（${g.source}）`;
        } catch (e) {
          warnings.push(`定位反查失败，请在页面上手动填写城市和地标：${e.message}`);
        }
      })()
    );
  }
  await Promise.all(jobs);

  // ---- 2. 抽签（纯本地，确定性强） ------------------------------------
  const fortune = drawFortune(date, mood);

  const result = {
    date,
    serverTime,
    mood,
    budget,
    fortune,
    location: { city, keyword, lat: input.lat ?? null, lng: input.lng ?? null, note: locationNote },
    store: null,
    combo: null,
    price: null,
    coupons: { applied: [], claimable: [], mine: [] },
    warnings,
    trace,
    elapsedMs: 0,
  };

  // ---- 3. 门店 ------------------------------------------------------
  let store = null;
  if (city && keyword) {
    const started = Date.now();
    const key = `stores:${city}|${keyword}`;
    const { value: r, hit } = await cache.wrap(key, TTL.STORE, () =>
      safeCall(client, 'query-nearby-stores', {
        beType: BE_TYPE_PICKUP,
        searchType: 2,
        city,
        keyword,
      })
    );
    mark('query-nearby-stores', r.ok, Date.now() - started, r.ok ? (hit ? 'cache' : '') : r.error);
    if (r.ok) {
      const stores = Array.isArray(r.data) ? r.data : [];
      store = stores[0] || null;
      if (!store) warnings.push(`「${city} ${keyword}」附近没查到麦当劳门店，换个地标试试`);
    } else {
      warnings.push(`门店查询失败：${r.error}`);
    }
  } else {
    warnings.push('缺少定位信息，已跳过门店与菜单查询');
  }

  if (!store) {
    result.elapsedMs = Date.now() - t0;
    return result;
  }

  result.store = {
    storeCode: String(store.storeCode),
    name: store.storeName,
    address: store.address,
    distance: store.distance,
    businessStatus: store.businessStatus,
    businessHours: `${store.businessStartTime || ''}-${store.businessEndTime || ''}`,
  };
  const storeCode = result.store.storeCode;

  // ---- 4. 菜单 + 三种券（并行） ---------------------------------------
  const [mealsRes, storeCouponRes, myCouponRes, claimRes] = await Promise.all([
    timedCached(`menu:${storeCode}`, TTL.MENU, client, 'query-meals', { storeCode, orderType: ORDER_TYPE_PICKUP, beType: BE_TYPE_PICKUP }, mark),
    timedCached(`store-coupons:${storeCode}`, TTL.COUPON, client, 'query-store-coupons', { storeCode, orderType: ORDER_TYPE_PICKUP, beType: BE_TYPE_PICKUP }, mark),
    timedCached('my-coupons', TTL.COUPON, client, 'query-my-coupons', {}, mark),
    timedCached('available-coupons', TTL.COUPON, client, 'available-coupons', {}, mark),
  ]);

  if (!mealsRes.ok || !mealsRes.data) {
    warnings.push(`菜单查询失败：${mealsRes.error || '返回为空'}`);
    finalizeCoupons(result, storeCouponRes, myCouponRes, claimRes, warnings);
    result.elapsedMs = Date.now() - t0;
    return result;
  }

  const { items, warnings: parseWarn } = buildCandidates(mealsRes.data);
  parseWarn.forEach((w) => warnings.push(w));

  finalizeCoupons(result, storeCouponRes, myCouponRes, claimRes, warnings);

  if (!items.length) {
    result.elapsedMs = Date.now() - t0;
    return result;
  }

  // ---- 5. 按心情 + 预算选组合 ----------------------------------------
  const { combo: firstCombo, alternates, reason } = pickCombo(items, mood, budget);
  if (!firstCombo) {
    warnings.push(`没能选出组合：${reason}`);
    result.elapsedMs = Date.now() - t0;
    return result;
  }
  if (reason) warnings.push(reason);

  // ---- 6~7. 挂券 + 计价（超预算就顺位换备选，最多试 3 次） -------------
  const usable = [
    ...(result.coupons.usableStoreCoupons || []),
    ...(result.coupons.mine || []),
    ...(result.coupons.claimable || []),
  ].filter((c) => c.couponId);

  // 最多试 3 组，避免为了凑预算把接口打爆
  const attempts = [firstCombo, ...alternates].slice(0, 3);
  let chosen = null;

  for (let i = 0; i < attempts.length; i++) {
    const combo = attempts[i];
    const applied = attachCoupons(combo, usable);
    const priceItems = [];
    if (combo.main) {
      priceItems.push({
        productCode: combo.main.code,
        quantity: 1,
        ...(combo.main.couponId ? { couponId: combo.main.couponId, couponCode: combo.main.couponCode } : {}),
      });
    }
    if (combo.extra) {
      priceItems.push({
        productCode: combo.extra.code,
        quantity: 1,
        ...(combo.extra.couponId ? { couponId: combo.extra.couponId, couponCode: combo.extra.couponCode } : {}),
      });
    }

    const priceRes = await timed(
      client,
      'calculate-price',
      { storeCode, orderType: ORDER_TYPE_PICKUP, beType: BE_TYPE_PICKUP, items: priceItems },
      mark
    );

    const listTotal = round2((combo.main?.listPrice || 0) + (combo.extra?.listPrice || 0));
    const menuTotal = round2(combo.total);
    const priced = settlePrice(priceRes, { listTotal, menuTotal, priceItems, combo });
    if (!priced.ok) warnings.push(`计价失败，改用菜单原价估算：${priced.error}`);

    chosen = { combo, applied, listTotal, menuTotal, price: priced.price };

    //  menu 价和接口价偶有出入，真超预算了就换下一个候选
    if (!priced.price.fallback && priced.price.final > budget + 0.01 && i < attempts.length - 1) {
      warnings.push(`「${combo.main.name}」实际计价 ¥${priced.price.final} 超出预算，已换成更省的组合`);
      continue;
    }
    break;
  }

  result.combo = {
    main: chosen.combo.main,
    extra: chosen.combo.extra || null,
    listTotal: chosen.listTotal,
    menuTotal: chosen.menuTotal,
    strategy: MOODS[mood].comboNote,
  };
  result.coupons.applied = chosen.applied;
  result.price = chosen.price;

  result.elapsedMs = Date.now() - t0;
  return result;
}

/**
 * 把 calculate-price 的结果整理成统一结构；
 * 失败时用菜单原价兜底并标注 fallback。
 */
function settlePrice(priceRes, { listTotal, menuTotal, priceItems, combo }) {
  // 参考原价取「菜单划线价合计」与「计价接口原价」里较大的，
  // 这样「省了多少」不会是负数，也贴合 App 里看到的划线价。
  const reference = Math.max(listTotal, menuTotal, 0);

  if (priceRes.ok && priceRes.data && Number.isFinite(priceRes.data.price)) {
    const d = priceRes.data;
    const final = round2(d.price / 100);
    const fromApi = Number.isFinite(d.originalPrice) ? round2(d.originalPrice / 100) : menuTotal;
    const original = Math.max(reference, fromApi, final);
    return {
      ok: true,
      price: {
        final,
        original,
        discount: round2((d.discount || 0) / 100),
        saved: round2(Math.max(0, original - final)),
        breakdown: (d.productList || []).map((p) => ({
          productCode: p.productCode,
          name: p.productName,
          quantity: p.quantity,
          subtotal: round2((p.subtotal || 0) / 100),
          originalSubtotal: round2((p.originalSubtotal || 0) / 100),
        })),
        source: 'calculate-price',
        fallback: false,
      },
    };
  }

  const original = reference || menuTotal;
  return {
    ok: false,
    error: priceRes.error || '返回异常',
    price: {
      final: menuTotal,
      original,
      discount: round2(Math.max(0, original - menuTotal)),
      saved: round2(Math.max(0, original - menuTotal)),
      breakdown: priceItems.map((it) => {
        const src = it.productCode === combo.main?.code ? combo.main : combo.extra;
        return {
          productCode: it.productCode,
          name: src?.name || '',
          quantity: 1,
          subtotal: src?.price || 0,
          originalSubtotal: src?.listPrice || 0,
        };
      }),
      source: 'menu-price-fallback',
      fallback: true,
    },
  };
}

/* ------------------------------------------------------------------ */

function finalizeCoupons(result, storeCouponRes, myCouponRes, claimRes, warnings) {
  const store = collectCoupons(storeCouponRes, 'query-store-coupons');
  if (store.error) warnings.push(`门店券查询失败：${store.error}`);
  // 门店券带 couponId 才能真的抵扣，先单独留一份
  result.coupons.applied = [];
  result.coupons.usableStoreCoupons = store.list;

  const mine = collectCoupons(myCouponRes, 'query-my-coupons');
  if (mine.error) warnings.push(`我的优惠券查询失败：${mine.error}`);
  result.coupons.mine = mine.list.slice(0, 8);

  const claim = collectCoupons(claimRes, 'available-coupons');
  if (claim.error) warnings.push(`可领券查询失败：${claim.error}`);
  result.coupons.claimable = dedupeByTitle(claim.list).slice(0, 6);
}

function dedupeByTitle(list) {
  // 同名券常带多张图（图不同但活动相同），按 title 唯一化，避免前端一连串同款
  const seen = new Set();
  return list.filter((c) => {
    if (!c.title || seen.has(c.title)) return false;
    seen.add(c.title);
    return true;
  });
}

async function timed(client, name, args, mark) {
  const started = Date.now();
  const r = await safeCall(client, name, args);
  mark(name, r.ok, Date.now() - started, r.ok ? '' : r.error);
  return r;
}

/** 带缓存的调用：命中缓存时 trace 里标 cache，方便调延迟 */
async function timedCached(cacheKey, ttlMs, client, name, args, mark) {
  const started = Date.now();
  const { value: r, hit } = await cache.wrap(cacheKey, ttlMs, () => safeCall(client, name, args));
  mark(name, r.ok, Date.now() - started, r.ok ? (hit ? 'cache' : '') : r.error);
  return r;
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

module.exports = { buildLuck };
