# workbuddy.md

# > 本文件为 WorkBuddy 专项奖励核验文件，以下为使用 WorkBuddy 开发本项目的完整对话上下文（导出时间：2026-10-12）。

---

## 对话记录
# 麦门今日运势 · 开发对话导出记录

> 导出时间：2026-10-12 16:18
> 项目目录：`E:/陈先生777_个人知识库/05_Projects/麦当劳比赛/麦门今日运势`
> 用户：陈永强（技术导向，CLI/API 熟练，偏好工具化+自动化方案）
> 助手：WorkBuddy

---

## 一、对话脉络总览

| # | 用户诉求 | 关键动作 | 结果 |
|---|---|---|---|
| 1 | 列出麦当劳 MCP 有哪些可用工具 | 调用 `tools/list` | 确认 **35** 个工具，分类整理 |
| 2 | 按需求文档从 0 开发「麦门今日运势」比赛项目 | 读 PDF → 搭 Express 后端 + MCP 客户端 + 前端单页 | 6 个核心工具打通，求签流程跑通 |
| 3 | ① 替换官方参赛声明原文 ② 求签 Failed to fetch | 写入 CONTEST_DECLARATION.md 原文；后端加 CORS、前端加 `resolveApi()` 多地址探测 | 跨域求签成功 |
| 4 | 6 处 UX 改进（券去重/定位区 debug 信息/按钮歧义/删除线/装饰圆/灰字/emoji） | 后端 `dedupeByTitle` 改为按 title；新增 `/api/geo`；前端逐项改 | 全部回归通过 |
| 5 | 心情按钮和定位都消失了 | 定位到 `makeShareCard` 孤立 `catch/finally` 导致整段脚本挂掉 | 删孤立块，`node --check` 通过 |
| 6 | 顶部横幅和下面内容不对齐（安卓/苹果/网页三端） | 把 `<header>` 移进 `.wrap` 容器共享列宽；补媒体查询与安全区 | 三端对齐 |

---

## 二、详细对话与决策记录

### 阶段 1：确认麦当劳 MCP 工具清单
- 用户问：麦当劳 MCP 有哪些可用工具。
- 结果：通过 `mcp__mcd-mcp__*` 命名空间确认 **35** 个工具，按功能分 9 类：
  - 门店/派对查询：`query-nearby-stores`、`delivery-query-stores`、`query-party-city`、`query-party-store`、`query-party-store-date`、`query-party-store-session`
  - 餐品/菜单：`query-meals`、`query-meal-detail`、`query-meal-assistance`、`list-nutrition-foods`
  - 优惠券/活动：`available-coupons`、`query-my-coupons`、`query-store-coupons`、`auto-bind-coupons`、`query-survey-coupon`、`query-promotions`、`campaign-calendar`
  - 下单/订单：`create-order`、`cancel-order`、`query-order`、`order-list`
  - 派对下单：`party-order-create`
  - 麦商城：`mall-product-detail`、`mall-points-products`、`mall-create-order`、`mall-order-list`、`mall-order-detail`
  - 抽奖/积分：`draw-lottery`、`query-lottery-info`、`query-my-prizes`、`query-my-account`
  - 价格：`calculate-price`
  - 外送地址：`delivery-create-address`、`delivery-query-addresses`
  - 工具：`now-time-info`

### 阶段 2：从 0 立项开发
- 用户给出 GitHub 仓库 `https://github.com/M-China/mcd-mcp-server` 与需求文档 PDF `WorkBuddy-需求文档-麦门今日运势.pdf`。
- 关键过程：
  1. 用 `pymupdf`（装在 `~/.workbuddy/binaries/python/envs/default`）提取 PDF 全文。
  2. 文档建议开发顺序第 1 步：确认真实工具列表 → 用 `ToolSearch` 加载 `mcp__mcd-mcp__*` schema，再 `DeferExecuteTool` 实调 `now-time-info / query-nearby-stores / query-meals / available-coupons / query-store-coupons / calculate-price`，全部跑通。
  3. 从本地 WorkBuddy 连接器配置取到 MCP Token（仅本地测试用，不入 git）。
  4. 搭建项目骨架 `server/` + `public/index.html` + `package.json`。
- 实际使用的 6 个工具：
  - `now-time-info`：拿**服务器日期**作抽签种子，保证同日同心情结果一致
  - `query-nearby-stores`：最近门店 → `storeCode`
  - `query-meals`：该店全量菜单（实测 15 分类 / 123 个 SKU）
  - `query-store-coupons`：门店可用券（按 `products[].productCode` 精确匹配）
  - `available-coupons`：麦麦省还能领的券（无 `couponId`，作省钱建议）
  - `calculate-price`：券后真实价格（**单位：分**）

### 阶段 3：开发中踩到并修掉的 4 个真坑
1. **麦金卡定价陷阱**：带「随单购麦金卡优惠」的餐品，菜单 `currentPrice` 是持卡价，`calculate-price` 却按划线价收钱 → 改为按 `max(currentPrice, originalPrice)` 计价，并保留 4 个备选 + 超预算自动换选重试。
2. **字段名不一致**：`available-coupons` 返回 `couponName/couponImage`，不是想当然的 `title/image`。
3. **门店接口只认城市+地标**，不接受经纬度 → 加免密钥逆地理编码（BigDataCloud 主、Nominatim 备）。
4. **商品图跨域污染 canvas**，`toDataURL` 抛 SecurityError → 加 `/api/img` 同源代理（域名白名单 `*.mcd.cn`）。

- 实测：6 种心情 × 预算 40 元全部命中预算内（`疲惫打工 ¥32.4` 省 ¥24.1、`约会 ¥39.9` 省 ¥25.1 等）。
- 延迟：冷缓存 3~10s → 加 TTL 缓存后**热缓存 1.8s**。
- 边界用例：无定位 / 预算 999（clamp 到 120）/ 不存在地标 / 只给经纬度 → 全部不报 500，退化信息进 `warnings`。
- 交付文件：`server/`（mcp-client / orchestrator / luck / geo / cache）、`public/index.html`、`package.json`、`.env.example`、`.gitignore`，以及 `README.md`、`CONTEST_DECLARATION.md`、`MCP_INTEGRATION.md`、`mcp-config.example.json`、`workbuddy.md`。

### 阶段 4：官方声明 + Failed to fetch
- 用户发来脚手架里的 `CONTEST_DECLARATION.md` 原文 → 逐字替换（原创性/合规/信息安全/使用提示/规则遵守五节）。
- ⚠️ 提醒：声明要求提交材料不含真实 Token；`.env` 虽被 `.gitignore` 排除，但**用"压缩整个目录"提交会绕过 gitignore**，需 `rm .env` 或直接 git 提交。
- 求签 Failed to fetch 的根因：预览面板把 `public/index.html` **复制成静态页**挂在 `127.0.0.1:51134`，该端口无后端，`/api/luck` 404。`:3000` 后端一直正常。
- 修法：后端加 CORS（`Access-Control-Allow-Origin: *` + `OPTIONS` 返回 204）；前端加 `resolveApi()` 依次探测 `location.origin → localhost:3000 → 127.0.0.1:3000`，命中后复用前缀；探测成功显示绿色「✓ 已连接后端」，失败提示执行 `npm start`。
- 验证：CORS 头正确 → OPTIONS 预检 204 → 跨域 POST 求签成功（`date` 心情/预算 50 → 小吉）。

### 阶段 5：6 处 UX 改进
| # | 反馈 | 改法 |
|---|---|---|
| 1 | 券重复 3 次 | `dedupeByTitle` 由 `title+image` 改为只按 `title`；新增 `/api/geo` 反查城市回填 |
| 2 | 定位区像调试面板（暴露经纬度/后端地址） | 删除所有裸 debug 字样，状态只显示「✓ 已定位·城市·区」，坐标与后端地址降级到 `console.log` |
| 3 | 两个"再求一次"打架 | 黄色按钮永远是「🎴 求今日麦门签」；签图按钮改为「🖼️ 生成签图分享」单独存在，文案稳定 |
| 4 | ¥73 / ¥103 分不清哪个是现价 | 现价金色粗体；划线价加删除线（`lineWidth 1.6`, `alpha .75`） |
| 5 | 右上大红圆压日期 | 装饰圆从 `(690,90,r150)` 挪到 `(760,50,r110)` 缩小 25%；日期加 `shadowBlur 6` |
| 6 | 灰字在红底看不清 | 「该门店暂无可抵扣券」alpha `.5→.78`、地址 `.55→.78`、页脚 `.4→.72` |
| 7 | 约会 emoji 像牛排 | `date: 💞 → 💕` |

### 阶段 6：心情按钮和定位消失
- 用户截图：心情可选按钮不见了，定位也失效。
- 定位根因：`makeShareCard` 在某次改文案时**漏掉了 `try {` 开头**，留下孤立 `} catch (e) {} finally {}`。整个 `<script>` 执行到此处抛 `SyntaxError`，后续代码全没跑：
  - `renderMoods()` 没执行 → 无心情按钮
  - `$('locBtn').onclick` 没绑定 → 定位无效
- 修法：删掉孤立块，恢复正常的 `try/catch/finally`；`node --check` 通过。
- 加三道保险：后端对 HTML/JS/CSS 加 `Cache-Control: no-store`；init 段包 `try/catch`，脚本再挂会在页面画红条提示；改完 JS 立刻跑 `node --check`（已写入项目笔记）。
- 提示用户：浏览器 Ctrl+Shift+R 强刷或用无痕窗口打开 `http://localhost:3000`。

### 阶段 7：顶部横幅对齐（三端适配）
- 用户截图：顶部红色横幅比下面卡片宽，左右不对齐。
- 根因：`header` 是通栏全宽，下面内容在 `max-width:480px` 居中列。
- 修法：
  - 结构：把 `<header>` 移进 `.wrap` 容器，与卡片**共用同一列宽**定位上下文，横幅宽度恒等于卡片列宽。
  - 样式：横幅从"贴顶直角+底部圆角"改为四周 22px 圆角卡片，与卡片视觉一致。
  - 适配：≤360px 小屏收紧内边距/字号；≥560px 桌面整列下移 22px；`@supports (padding: max(0px))` 用 `env(safe-area-inset-top)` 兼容 iPhone 刘海屏。

---

## 三、最终交付物清单

```
麦门今日运势/
├── server/
│   ├── mcp-client.js     # Streamable HTTP MCP 客户端（initialize/tools/list/tools/call，SSE+JSON 双解析）
│   ├── orchestrator.js   # /api/luck 编排与容错（6 工具串联，失败写 warnings）
│   ├── luck.js           # 签文引擎 + 6 种心情选品策略
│   ├── geo.js            # 逆地理编码（BigDataCloud + Nominatim 兜底）
│   ├── cache.js          # TTL 内存缓存（菜单/门店/券）
│   └── index.js          # Express 入口（CORS、/api/health、/api/luck、/api/geo、/api/img 代理）
├── public/
│   └── index.html        # 手机优先单页，麦当劳红黄配色，canvas 签图分享
├── package.json
├── .env.example          # MCP_TOKEN 占位
├── .gitignore            # 排除 .env / node_modules
├── .env                  # 本地真实 Token（已被 gitignore，勿随压缩包提交）
├── README.md
├── CONTEST_DECLARATION.md   # 官方声明原文（逐字）
├── MCP_INTEGRATION.md
├── mcp-config.example.json
├── workbuddy.md
└── 对话记录导出.md           # 本文件
```

## 四、本地运行方式
```bash
cd "E:/陈先生777_个人知识库/05_Projects/麦当劳比赛/麦门今日运势"
npm install          # 或：node.exe ".../npm/bin/npm-cli.js" install
# 编辑 .env 填入 MCP_TOKEN（已有）
npm start            # 启动后打开 http://localhost:3000
```

## 五、提交前自检（赛事合规）
- [ ] 确认 `.env` 未被打包（`rm .env` 或仅 git 提交）
- [ ] README「提交前自检」章节已读
- [ ] CONTEST_DECLARATION.md 为官方原文，未改字

##补充说明

## 项目与 WorkBuddy 的关联事实

| 项 | 内容 |
| --- | --- |
| 作品名称 | 麦门今日运势 — 每日一签点餐搭子 |
| 参赛赛事 | 1024 程序员节 · 麦当劳程序员创意开发大赛 |
| 开发工具 | **WorkBuddy**（全程使用 WorkBuddy 完成需求解析、架构设计、编码、联调与文档撰写） |
| MCP 连接器 | 麦当劳 MCP 连接器已在 WorkBuddy 中完成配置（`mcd-mcp`，端点 `https://mcp.mcd.cn`） |
| 开发方式 | 在 WorkBuddy 会话中直接调用麦当劳 MCP 工具完成 `tools/list` 探测、参数验证与真实数据联调 |
| 项目路径 | `05_Projects/麦当劳比赛/麦门今日运势/` |
| 需求来源 | `WorkBuddy-需求文档-麦门今日运势.pdf` |

## 开发过程中实际使用 WorkBuddy 完成的工作

1. 解析需求文档 PDF，拆解功能与技术要求；
2. 通过 WorkBuddy 的麦当劳 MCP 连接器调用 `tools/list`，确认 35 个真实工具名与入参；
3. 逐个实调 `now-time-info` / `query-nearby-stores` / `query-meals` / `query-store-coupons` / `available-coupons` / `calculate-price`，核对真实返回结构；
4. 基于真实返回编写后端 MCP 客户端与编排逻辑，修正了两处字段名/计价口径的实际问题；
5. 编写前端单页与 canvas 签图，完成本地 `npm install && npm start` 全流程自测；
6. 生成 README / MCP_INTEGRATION / 本文件等交付文档。

---

<!-- 待官方明确填写规范后，按规范补充核验所需字段（如 WorkBuddy 账号标识、会话凭证等）。 -->
