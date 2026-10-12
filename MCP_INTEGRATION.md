# MCP 集成说明

> 本文说明本项目用了哪个 MCP Server、调用了哪些 Tool、完整调用流程是什么，以及这些调用带来了什么业务价值。

---

## 一、MCP Server

| 项 | 值 |
| --- | --- |
| 名称 | 麦当劳 MCP（`mcd-mcp`） |
| 端点 | `https://mcp.mcd.cn` |
| 传输 | Streamable HTTP（JSON-RPC 2.0，POST 单端点） |
| 认证 | `Authorization: Bearer ${MCP_TOKEN}` |
| 可用工具总数 | **35** |
| 本项目实际调用 | **6** |

连接握手：`initialize` → 回带 `Mcp-Session-Id` → `notifications/initialized` → `tools/list` → `tools/call`。

`server/mcp-client.js` 是自己实现的零依赖客户端（只用 Node 18+ 内置 `fetch`），没有引入官方 SDK，原因是：

1. 服务端对同一个请求可能回 `application/json`，也可能回 `text/event-stream`（SSE），客户端必须**两种都能解析**；
2. 麦当劳 MCP 习惯把结构化数据塞进 `content[].text` 里，外面还包着一层展示用的 markdown 说明，需要先把 JSON 从混杂文本里抠出来，再剥掉 `{success, code, message, data}` 信封。

---

## 二、先 tools/list，再写代码

开发第一步就是调 `tools/list` 拿真实工具名和入参，**没有凭记忆写调用代码**。这一步避免了一个实际踩到的坑：`available-coupons` 返回的字段名是 `couponName / couponImage / couponStatus`，不是想当然的 `title / image`。

`tools/list` 返回的 35 个工具：

```
query-my-coupons      query-meals           query-meal-detail   calculate-price
order-list            mall-create-order     query-party-store-session
query-store-coupons   create-order          party-order-create
campaign-calendar     now-time-info         delivery-create-address
query-party-store-date  query-lottery-info  mall-points-products
draw-lottery          mall-order-detail     available-coupons
list-nutrition-foods  delivery-query-addresses  delivery-query-stores
cancel-order          query-my-account      query-party-city
query-order           query-nearby-stores   query-meal-assistance
query-survey-coupon   mall-product-detail   mall-order-list
auto-bind-coupons     query-promotions      query-my-prizes
query-party-store
```

也可以直接 `GET /api/tools` 拿到同样的清单（含入参的必填字段）。

---

## 三、用到的 6 个 Tool

### 1. `now-time-info`

- **入参**：无
- **返回**：`{ date, formatted, dayOfWeek, timestamp, timezone }`
- **用途**：拿**服务器日期**作为抽签种子。
- **为什么**：签文要求"同一天同一心情结果一致"。用客户端日期会有时区和用户改系统时间的风险，用服务器日期口径才统一。
- **失败降级**：退回本机日期，并在 `warnings` 里说明。

### 2. `query-nearby-stores`

- **入参**：`{ beType: 1, searchType: 2, city, keyword }`（`beType=1` 到店自提，`searchType=2` 按位置搜索）
- **返回**：`[{ storeCode, storeName, address, distance, businessStatus, businessStartTime, businessEndTime }]`
- **用途**：找离用户最近的门店，取 `storeCode` 给后续所有调用。
- **注意**：该接口只认「城市 + 地标关键词」，**不接受经纬度**。所以服务端做了一层免密钥逆地理编码（BigDataCloud → Nominatim 双备份）把浏览器给的经纬度翻译成 `city + keyword`；两个 provider 都失败时提示用户手填。

### 3. `query-meals`

- **入参**：`{ storeCode, orderType: 1, beType: 1 }`
- **返回**：`{ categories: [{ name, meals: [{ code, tags }] }], meals: { [code]: { name, image, currentPrice, originalPrice, discountType } } }`
- **用途**：拿该门店的**全量实时菜单**（实测 15 个分类、123 个 SKU），这是选品算法唯一的数据源。
- **关键处理（踩坑）**：
  - `categories[].meals[]` 只有 `code` 和 `tags`，真实名称/价格/图片在顶层的 `meals` 映射表里，**必须做一次 join**；
  - 带 `discountType = "随单购麦金卡优惠"` / `"早餐卡优惠"` 的餐品，其 `currentPrice` 是**持卡价**。本项目不会随单购卡，`calculate-price` 会按划线价收钱 → 已统一按 `max(currentPrice, originalPrice)` 计入有效价格，否则选出来的组合会超预算（实测从 ¥80 的离谱组合修正到 ¥40 以内）。

### 4. `query-store-coupons`

- **入参**：`{ storeCode, orderType: 1, beType: 1 }`
- **返回**：`[{ couponId, couponCode, title, tradeDateTime, products: [{ productName, productCode }] }]`
- **用途**：拿该门店可用的券。通过 `products[].productCode` 判断某张券能不能用在选中的商品上，能用的话把 `couponId / couponCode` 挂进 `calculate-price` 的对应 item。

### 5. `available-coupons`

- **入参**：无
- **返回**：`[{ couponName, couponImage, couponStatus, label }]`（字段名与 `query-store-coupons` 不一致，已做归一化）
- **用途**：麦麦省"还能领什么券"。这类券只有名称和图、没有 `couponId`，无法直接抵扣，所以在"账号无可用券"时作为**省钱建议**展示给用户。
- **补充**：同时调用 `query-my-coupons` 拿账户已持有的券，两个来源一起参与匹配。

### 6. `calculate-price`

- **入参**：`{ storeCode, orderType: 1, beType: 1, items: [{ productCode, quantity, couponId?, couponCode? }] }`
- **返回**：`{ price, originalPrice, discount, productList: [{ productName, quantity, subtotal, originalSubtotal }], takeWayList }`，**金额单位是分**
- **用途**：算券后真实价格。这是"省了多少钱"的唯一可信来源 —— 菜单价只是预估，这里才是接口口径。
- **注意**：返回值单位是**分**，展示时要 `/100`。
- **兜底**：失败时用菜单价（`currentPrice` 合计）作为券后价，并置 `price.fallback = true`，前端标注"按菜单价估算"。

---

## 四、调用流程

```
POST /api/luck
  │
  ├─ initialize（握手机，拿 Mcp-Session-Id）
  │
  ├─ 并行 ─┬─ now-time-info                 → 服务器日期（抽签种子）
  │        └─ 逆地理编码（仅当只给了经纬度）   → city + keyword
  │
  ├─ 本地抽签（种子 = hash(日期 | 心情)，纯计算，不联网）
  │
  ├─ query-nearby-stores(city, keyword)      → 最近门店 → storeCode
  │
  ├─ 并行 ─┬─ query-meals(storeCode)         → 全量菜单
  │        ├─ query-store-coupons(storeCode) → 门店可用券
  │        ├─ query-my-coupons()             → 我账户的券
  │        └─ available-coupons()            → 还能领的券
  │
  ├─ 选品：穷举 (主食 × 小食/饮品)，筛掉 > 预算，
  │        按「心情关键词亲和度 + 价格贴合度 + 上新加成 + 已有折扣」打分取 Top1，
  │        同时保留 4 个备选
  │
  └─ calculate-price(items + 挂上的券)
        └─ 若券后价 > 预算（菜单价与接口价偶有出入）→ 顺位换备选重试，最多 3 次
```

**并行化**：拿到 `storeCode` 之后，菜单 / 门店券 / 我的券 / 可领券四者互不依赖，一起发。

**缓存**：菜单与门店 10 分钟、券 3 分钟、服务器时间 30 秒（`server/cache.js`）。冷启动整条链路约 3~10 秒，热缓存后降到 **1.8 秒左右**。

**容错**：每个 MCP 调用都走 `safeCall`，失败只往 `warnings` 数组记一条，不中断流程。前端把 `warnings` 展示成"这些步骤没完全跑通（不影响其它结果）"。

---

## 五、业务价值

### 1. 让 MCP 从"能查"变成"能决策"

单独看，`query-meals` 只是返回一份菜单，`calculate-price` 只是算个钱。把它们按「心情 → 预算 → 门店」串起来之后，MCP 的输出就变成了**一个可以直接执行的消费决策**：买什么、花多少、省多少、去哪家店。

### 2. 预算约束是硬的，不是好看的

选品不是随机抓两个商品，而是在真实菜单上**穷举所有 (主食 × 小食/饮品) 组合**，把超过预算的全部剔除再打分。加上券后价超预算时的自动换选重试，保证最终呈现给用户的价格**一定 ≤ 预算**。

### 3. 心情策略让推荐有"人味"

6 种心情对应 6 套打分权重：疲惫打工偏向咖啡+油炸的高热量安慰组合，约会偏向双人分享餐，随便偏向「上新」标签的新品探索，庆祝则把预算花到接近上限。同样的预算，不同心情出来的东西完全不一样。

### 4. 券的价值被真正兑现

`query-store-coupons` 返回的券很多都标了适用商品范围。项目会按 `products[].productCode` 精确匹配到具体商品并把 `couponId` 挂进 `calculate-price`，而不是笼统地说"你可能有券"。省下的钱是**接口算出来的**，不是估的。

### 5. 把不确定的部分诚实暴露

哪一步没跑通、哪次用了兜底价格，都原样送到前端 `warnings` 里。对一个接了 6 个外部调用的链路来说，这比静默吞掉错误更可靠。

---

## 六、安全与合规

- `MCP_TOKEN` 只存在于后端 `.env`，前端永远拿不到；`.gitignore` 已排除 `.env`，仓库里只有 `.env.example` 和 `${MCP_TOKEN}` 占位符。
- 图片代理 `/api/img` 做了域名白名单，只放行 `*.mcd.cn`，避免变成开放代理。
- 本项目**不调用任何下单 / 支付类工具**（`create-order`、`mall-create-order`、`party-order-create` 等均未使用），只读 + 试算。
- 定位坐标只在单次请求内使用，不做持久化存储。
