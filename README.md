# 🍔 麦门今日运势 · 每日一签点餐搭子

> 选心情、定预算、定个位，一键抽一支**今日麦门签** —— 签等级 + 签文 + 宜忌 + 推荐套餐 + 最省券组合 + 附近门店，还能生成竖版签图分享给朋友。
>
> 所有餐品、价格、优惠券、门店数据都**实时来自麦当劳 MCP Server**，不是写死在代码里的假数据。

---

## 一、它解决什么

点麦当劳时真正的痛点不是"不知道吃什么"，而是三个决策叠在一起：**今天的心情、兜里的预算、附近哪家店**。

本项目把这三层压成一次点击：

| 你输入 | 系统做什么 | 你得到 |
| --- | --- | --- |
| 心情（6 选 1） | 决定选品策略：疲惫打工→高热量安慰型，约会→双人分享型，随便→新品探索型 | 一支签 + 一套真的能买的组合 |
| 预算（15~120 元） | 在**该门店真实菜单**里穷举「主食 × 小食/饮品」，筛掉超预算的，按心情打分取最优 | 总价必定 ≤ 预算 |
| 定位 | 查最近门店 → 拉该店菜单 → 查该店可用券 → 真实计价 | 券后价、省了多少、哪家店多远 |

**同一天 + 同一心情 = 同一支签**（种子只由日期和心情决定），不会出现"刷新一下运气就变了"的尴尬。

---

## 二、快速开始

### 1. 装依赖

```bash
npm install
```

要求 **Node.js 18+**（用了内置 `fetch`，零其它运行时依赖，只有 express + dotenv）。

### 2. 配 Token

```bash
cp .env.example .env
# 编辑 .env，把 MCP_TOKEN 换成你自己的
```

`.env` 长这样：

```ini
MCP_TOKEN=你的麦当劳MCP令牌
MCP_ENDPOINT=https://mcp.mcd.cn
PORT=3000
```

> ⚠️ `MCP_TOKEN` **只存在于后端**，前端拿不到也不会被提交到 git（`.gitignore` 已排除 `.env`）。

### 3. 跑起来

```bash
npm start
# 浏览器打开 http://localhost:3000
```

开发模式（改文件自动重启）：

```bash
npm run dev
```

### 4. 先看看 MCP 通不通

```bash
curl http://localhost:3000/api/tools   # 返回 MCP Server 真实暴露的工具清单
npm run tools                          # 同上，命令行版
```

---

## 三、申请 Token 步骤

本项目对接的 MCP Server 是 **`https://mcp.mcd.cn`**，Streamable HTTP 传输，`Authorization: Bearer <token>` 认证。

拿到 Token 的常见路径：

1. **通过 MCP 客户端/连接器获取（最快）**
   在支持 MCP 的客户端（如 WorkBuddy）里添加麦当劳 MCP 连接器并完成授权后，客户端会把令牌写进本地 MCP 配置文件。以 WorkBuddy 为例，配置位于 `~/.workbuddy/mcp.json`：

   ```json
   {
     "mcpServers": {
       "mcd-mcp": {
         "type": "streamablehttp",
         "url": "https://mcp.mcd.cn",
         "headers": { "Authorization": "Bearer <你的令牌>" }
       }
     }
   }
   ```

   把 `Bearer` 后面那串复制出来，填进 `.env` 的 `MCP_TOKEN`。

2. **通过麦当劳官方渠道申请**
   令牌属于个人账户凭据，通常需要在麦当劳官方 App / 开放平台完成登录与授权后发放。具体入口以官方公布为准。

3. **验证令牌可用**

   ```bash
   curl -X POST https://mcp.mcd.cn \
     -H "Authorization: Bearer $MCP_TOKEN" \
     -H "Content-Type: application/json" \
     -H "Accept: application/json, text/event-stream" \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
   ```

   能返回 35 个工具说明令牌有效。

> 令牌是个人凭据，**不要**提交到仓库、不要写进前端、不要在公开场合展示。

---

## 四、接口说明

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/health` | 健康检查，返回服务状态与 MCP 配置情况（不泄漏 Token） |
| `GET` | `/api/tools` | 调试用，返回 MCP Server 真实工具的 `name / description / required` |
| `GET` | `/api/moods` | 6 种心情的枚举 |
| `GET` | `/api/img?url=...` | 商品图同源代理（仅允许 `*.mcd.cn`），用于避免 canvas 跨域污染 |
| `POST` | `/api/luck` | **核心**：编排 MCP 调用，返回完整签结果 |

### POST /api/luck

请求体：

```json
{
  "mood": "tired",
  "budget": 40,
  "city": "上海",
  "keyword": "人民广场"
}
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `mood` | 是 | `energetic` / `tired` / `emo` / `date` / `celebrate` / `whatever` |
| `budget` | 是 | 15~120，服务端会 clamp |
| `city` + `keyword` | 二选一 | 直接查门店 |
| `lat` + `lng` | 二选一 | 服务端逆地理编码成城市+地标再查（免密钥，BigDataCloud / Nominatim 双备份） |

响应体（关键字段）：

```jsonc
{
  "ok": true,
  "date": "2026-10-10",
  "fortune": {
    "level": "大吉", "levelKey": "great", "levelColor": "#DA291C",
    "line": "打工人的骨头是薯条做的，脆，但易折。",
    "yi": "宜多要两包番茄酱", "ji": "忌冷掉之后再吃",
    "moodLabel": "疲惫打工", "moodEmoji": "😮‍💨"
  },
  "store": {
    "storeCode": "1450713",
    "name": "麦当劳上海黄浦华旭国际大厦餐厅",
    "address": "南京东路街道西藏中路336号",
    "distance": 144, "businessHours": "00:00-23:59"
  },
  "combo": {
    "main":  { "code": "...", "name": "大堡口福三件套", "price": 22.9, "listPrice": 47, "image": "..." },
    "extra": { "code": "...", "name": "鲜萃咖啡",       "price": 9.5,  "listPrice": 9.5 },
    "listTotal": 56.5, "menuTotal": 32.4,
    "strategy": "打工人的骨头是薯条做的，脆但易折"
  },
  "price": {
    "final": 32.4, "original": 56.5, "saved": 24.1,
    "breakdown": [ ... ],
    "source": "calculate-price", "fallback": false
  },
  "coupons": {
    "applied":   [ ... ],   // 本次真的挂上去抵扣的券
    "claimable": [ ... ],   // 麦麦省还能领的券
    "mine":      [ ... ]    // 我账户里的券
  },
  "warnings": [ ... ],     // 哪一步没跑通，不阻塞其它结果
  "trace":    [ ... ],     // 每个 MCP 工具耗时 / 是否命中缓存
  "requestMs": 1813
}
```

**容错约定**：`now-time-info` / `query-nearby-stores` / `query-meals` / `query-store-coupons` / `calculate-price` 任一步失败都**不抛 500**，而是把原因写进 `warnings` 数组，其余部分照常返回。计价失败时用菜单原价兜底，并在 `price.fallback = true` 标注，前端会显示"按菜单价估算"。

---

## 五、目录结构

```
麦门今日运势/
├── server/
│   ├── index.js          Express 服务：路由、静态托管、图片代理
│   ├── orchestrator.js   /api/luck 的 MCP 编排（并行 + 容错 + 兜底）
│   ├── mcp-client.js     Streamable HTTP MCP 客户端（零依赖，JSON/SSE 双解析）
│   ├── luck.js           签文引擎（确定性随机）+ 6 种心情选品策略
│   ├── geo.js            免密钥逆地理编码（BigDataCloud / Nominatim）
│   └── cache.js          TTL 内存缓存
├── public/
│   └── index.html        单页前端（内联 CSS/JS，手机优先，canvas 签图）
├── package.json
├── .env.example          Token 模板
├── .gitignore            已排除 .env
├── mcp-config.example.json
├── MCP_INTEGRATION.md
├── CONTEST_DECLARATION.md
└── workbuddy.md
```

---

## 六、部署建议

| 场景 | 做法 |
| --- | --- |
| 本地 / 演示 | `npm start`，默认 `3000` |
| 任意 Node 主机 | `PORT=8080 npm start`，前面挂 Nginx 做 TLS |
| Docker | `FROM node:20-alpine` → `npm ci --omit=dev` → `CMD ["npm","start"]`，Token 用运行时环境变量注入，**不要打进镜像** |
| Serverless（Vercel / 云函数） | 需要注意两点：① MCP 单次链路 3~10 秒，超时阈值要放宽；② 内存缓存是多实例不共享的，生产建议换成 Redis 复用 `cache.js` 的接口 |
| 公网部署 | 必须 HTTPS —— `navigator.geolocation` 在非安全上下文下不可用 |

上线前建议：

- 给 `/api/luck` 加一层简单的 IP 限流（它每次会打 6 次 MCP）。
- 把 `MCP_TOKEN` 放进密钥管理服务，启动时注入环境变量。
- 打开 `NODE_ENV=production`，并让反向代理记录 `trace` 里的耗时，方便排查慢调用。

---

## 七、已知限制

- 只做**到店自提**（`beType=1 / orderType=1`），不含麦乐送与得来速。
- 菜单里带「随单购麦金卡优惠 / 早餐卡优惠」的餐品，其 `currentPrice` 是持卡价；本项目不会随单购卡，已**按划线价计入**，避免算出来超预算。
- 优惠券能否抵扣取决于账号实际持有的券。若账号在该门店无可用券，`coupons.applied` 会为空，此时前端展示"还能领的券"作为替代建议。
- 逆地理编码依赖第三方免费服务，两个 provider 都失败时会提示手动填写城市与地标。

---

## 八、提交前自检

参赛声明要求「不包含真实 Token、密钥、密码、账号凭证，配置文件仅使用环境变量占位符」。提交前请确认：

```bash
# 1. .env 只存在于本地，且已被 git 忽略
git status --porcelain | grep -c '^\?\? .env$'   # 应为 0（即 .env 未被追踪）
git check-ignore -v .env                          # 应输出 .gitignore 规则命中

# 2. 仓库里不该出现任何真实令牌
grep -rIn "MCP_TOKEN=" --exclude-dir=node_modules .   # 只应命中 .env.example 的占位值

# 3. 打包提交前，直接删掉本地 .env（删了重新 cp .env.example .env 即可恢复运行）
rm .env
```

> ⚠️ **如果你是用「压缩整个目录」而不是 git 的方式提交**，`.gitignore` 不会生效，`.env` 会被一起打包 —— 提交前务必手动删除 `.env`。

## 九、常见问题

**Q：点「求今日麦门签」提示 "Failed to fetch" / 连不上后端？**

页面打开的地址没有后端。本项目的前端必须配合 `server/index.js` 使用：

1. 在项目目录执行 `npm start`；
2. 浏览器访问 **`http://localhost:3000`**（不是直接双击 `public/index.html`，也不是其它静态预览端口）。

前端启动时会自动探测后端（同源 → `localhost:3000` → `127.0.0.1:3000`），探测成功会在定位卡片下方显示「✓ 已连接后端」。如果实在要用静态方式打开，后端已开启 CORS，前端会回落到 `http://localhost:3000`，但**签图里的商品图**需要后端代理，仍建议直接用 `http://localhost:3000`。

**Q：`/api/tools` 报 503？**

`.env` 里没填 `MCP_TOKEN`，或者填完没重启服务。

**Q：为什么有时候要等好几秒？**

单次求签会串/并行调用 6 个 MCP 工具。首次（冷缓存）3~10 秒属于正常，同一门店 10 分钟内的重复求签会命中缓存，降到 2 秒左右。

## 十、免责声明

**本项目是非官方的个人技术作品，与麦当劳（McDonald's）及其关联公司无任何隶属、授权或合作关系。**

- 「麦当劳」「麦门」「麦麦省」「麦旋风」「板烧鸡腿堡」等商标、餐品名称及图片版权归各自权利人所有，本项目仅为技术演示目的引用。
- 所有餐品、价格、优惠券、门店信息均由麦当劳 MCP Server **实时返回**，可能随地区、时间、库存、账号权益变化而变动；**实际下单请以麦当劳官方 App 及门店现场公示为准**。
- 本项目**不提供任何下单、支付功能**，不代为创建订单，不存储任何用户个人信息；定位坐标仅在单次请求内使用，不做持久化。
- 签文、宜忌等内容为娱乐性质的程序生成文案，不构成任何建议。
- 因使用本项目产生的任何直接或间接损失，作者不承担责任。

---

## License

MIT
